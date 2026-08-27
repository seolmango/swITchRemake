/**
 * 인게임 서버 진입점.
 *
 * 이 파일이 하는 일은 조립뿐이다. 게임 로직도 프로토콜 처리도 여기 넣지 않는다.
 * 각 조각은 서로를 모르고, 누가 누구에게 연결되는지는 여기서만 결정된다.
 *
 *   WsTransport ──> RoomManager ──> GameLifecycle ──> GameSession ──> Scheduler
 *        │               │                                  │
 *   TicketAuth      Redis 명령                         시뮬레이션 + 시야
 */

import { makeKeys, PROTOCOL_VERSION, RoomMode, type ViolationSignal } from 'shared';
import { readFile } from 'node:fs/promises';
import { RULES_VERSION } from './config/gameplay';
import { INFRA } from './config/infrastructure';
import { assertGameStartupConfig } from './config/startup-config';
import { NETWORK, SNAPSHOT_INTERVAL_TICKS } from './config/network';
import { GameLifecycle } from './game/game-lifecycle';
import { ConnectionManager } from './gateway/connection-manager';
import { TicketAuthenticator } from './gateway/ticket-auth';
import { InMemoryTicketStore } from './gateway/ticket-store';
import { isPlayableMap, loadMapBundle, playableMapIds } from './maps/map-loader';
import { CommandConsumer } from './redis/command-consumer';
import { RedisClient } from './redis/redis-client';
import { GameRegistry } from './redis/registry';
import { ResultOutbox } from './redis/result-outbox';
import { MemoryReplayRecorder, NullReplayRecorder, type ReplayRecorder } from './replay/recorder';
import { LocalReplayStore } from './replay/replay-store';
import { RoomManager } from './rooms/room-manager';
import { Scheduler } from './simulation/scheduler';
import { WsTransport } from './transport/ws-transport';

const log = (message: string): void => console.log(`[swITch] ${message}`);

/**
 * 위반 신호의 단일 소비자. 지금은 로그 하나뿐이다.
 *
 * 감지하는 쪽이 소비자를 모르는 게 핵심이다. 나중에 안티치트 저장소나 운영 화면을 붙일 때
 * 여기에 소비자를 더하면 되고, 흩어진 로그를 찾아다니지 않아도 된다.
 */
function violationSink(signal: ViolationSignal): void {
    const detail = signal.detail === undefined ? '' : ` detail=${JSON.stringify(signal.detail)}`;
    console.warn(`[violation] ${signal.kind} user=${signal.userId} room=${signal.roomId ?? '-'} sev=${signal.severity}${detail}`);
}

async function main(): Promise<void> {
    assertGameStartupConfig(INFRA);

    log('인게임 서버 시작');
    log(`  serverId       ${INFRA.SERVER_ID}`);
    log(`  env            ${INFRA.ENV}`);
    log(`  listen         ${INFRA.HOST}:${INFRA.PORT}${INFRA.PUBLIC_WS_PATH}`);
    log(`  rulesVersion   ${RULES_VERSION}  buildId ${INFRA.BUILD_ID}`);
    log(`  simulation     ${NETWORK.SIMULATION_HZ}Hz, 스냅샷 ${NETWORK.SNAPSHOT_HZ}Hz (${SNAPSHOT_INTERVAL_TICKS} tick마다)`);

    // ── 리플레이 ──
    // `s3`는 아직 구현이 없다. 그 상태로 켜져 있으면 조용히 기록을 잃는 것보다 꺼서 알리는 편이 낫다.
    const replayStore = INFRA.REPLAY_STORE === 'local' ? new LocalReplayStore(INFRA.REPLAY_LOCAL_DIR) : null;
    if (INFRA.REPLAY_ENABLED && replayStore === null) {
        console.warn(`[swITch] REPLAY_STORE=${INFRA.REPLAY_STORE}은 아직 구현되지 않았다. 리플레이 기록을 끈다.`);
    }
    const replayEnabled = INFRA.REPLAY_ENABLED && replayStore !== null;
    log(`  replay         ${replayEnabled ? `on (local -> ${INFRA.REPLAY_LOCAL_DIR})` : 'off'}`);
    const replayRecorderFactory = (): ReplayRecorder =>
        replayEnabled && replayStore ? new MemoryReplayRecorder({ store: replayStore }) : new NullReplayRecorder();

    if (INFRA.ALLOWED_ORIGINS.length === 0) {
        // 비어 있으면 upgrade를 전부 거절한다. 조용히 전체 허용으로 열리는 것보다 낫다.
        console.warn('  ⚠ GAME_ALLOWED_ORIGINS가 비어 있어 WebSocket upgrade를 모두 거절합니다.');
    }

    // ── 맵 ──
    // simulationHz가 다르면 같은 timeline이 다른 속도로 재생된다. 여기서 실패시키는 편이
    // 경기 중에 자기장과 벽 파괴가 어긋나는 것보다 낫다.
    const bundle = await loadMapBundle(INFRA.MAP_BUNDLE_PATH, NETWORK.SIMULATION_HZ);
    const mapBundleBody = await readFile(INFRA.MAP_BUNDLE_PATH, 'utf8');
    log(`  maps           ${Object.keys(bundle.maps).length}개, hash ${bundle.mapBundleHash.slice(0, 12)}`);

    // ── 시뮬레이션 ──
    const scheduler = new Scheduler();
    let serverTick = 0;

    // ── 방과 게임 ──
    // lookupRoom을 지연 참조로 넘긴다. RoomManager와 GameLifecycle이 서로를 필요로 해서
    // 어느 한쪽을 먼저 완성할 수 없다. 순환을 클래스 참조가 아니라 함수 하나로 좁힌다.
    let rooms: RoomManager | null = null;
    let registry: GameRegistry | null = null;
    const lifecycle = new GameLifecycle({
        bundle,
        serverId: INFRA.SERVER_ID,
        buildId: INFRA.BUILD_ID,
        scheduler,
        lookupRoom: (roomId) => rooms?.get(roomId) ?? null,
        violationSink,
        replayRecorderFactory,
        onMatchFinished: (session, result) => {
            const replayNote = result.replay ? `replay=${result.replay.storageKey}` : 'replay=none';
            log(`경기 종료 room=${session.id} match=${session.matchId} tick=${result.durationTicks} ${replayNote}`);
            // outbox가 Redis 장애를 흡수한다. 여기서 await 하지 않는 이유는
            // 결과 전송이 게임 루프를 막으면 안 되기 때문이다.
            try {
                outbox.enqueue(result);
            } catch (error) {
                // outbox가 가득 찼다. 던지게 두면 게임 루프 안에서 터진다.
                // 여기까지 왔다는 것은 이 경기의 전적이 이미 유실됐다는 뜻이다. 다음 경기부터는
                // RoomManager의 canStartGame이 시작을 막아 유실을 더 늘리지 않는다.
                console.error('[swITch] 경기 결과 적재 실패. 이 경기의 전적이 유실된다.', error);
            }
        },
    });

    rooms = new RoomManager({
        lifecycle,
        isKnownMap: (mapId, mode) => isPlayableMap(bundle, mapId, mode),
        canStartGame: () => outbox.canStartNewGame(),
        getServerTick: () => serverTick,
        violationSink,
        skillSink: (roomId, request) => lifecycle.queueSkill(roomId, request),
        emojiSink: (roomId, request) => lifecycle.setEmoji(roomId, request),
        respawnSink: (roomId, playerId) => {
            if (!lifecycle.respawn(roomId, playerId)) return false;
            // 살아났으니 화면을 처음부터 다시 구성해야 한다.
            lifecycle.requestFullSnapshot(roomId, playerId);
            return true;
        },
        onResume: (connection) => {
            // 재접속한 사람은 화면을 처음부터 다시 구성해야 하므로 다음 프레임을 full로 받는다.
            lifecycle.requestFullSnapshot(connection.roomId, connection.playerId);
        },
        onDirectoryChanged: () => registry?.requestPublish(),
    });

    // ── 게이트웨이와 전송 ──
    const tickets = new InMemoryTicketStore();
    const connections = new ConnectionManager({
        maxConnections: NETWORK.MAX_CONNECTIONS,
        maxUnauthenticatedPerIp: NETWORK.MAX_UNAUTHENTICATED_PER_IP,
    });
    const authenticator = new TicketAuthenticator({
        serverId: INFRA.SERVER_ID,
        ticketStore: tickets,
        rooms,
        connections,
    });

    const transport = new WsTransport({
        host: INFRA.HOST,
        port: INFRA.PORT,
        path: INFRA.PUBLIC_WS_PATH,
        allowedOrigins: INFRA.ALLOWED_ORIGINS,
        trustedProxies: INFRA.TRUSTED_PROXIES,
        limits: {
            authTimeoutMs: NETWORK.AUTH_TIMEOUT_MS,
            maxBinaryFrameBytes: NETWORK.MAX_BINARY_FRAME_BYTES,
            maxJsonFrameBytes: NETWORK.MAX_JSON_FRAME_BYTES,
            maxInputPacketsPerSec: NETWORK.MAX_INPUT_PACKETS_PER_SEC,
            maxJsonCommandsPerSec: NETWORK.MAX_JSON_COMMANDS_PER_SEC,
            emojiCooldownMs: NETWORK.EMOJI_COOLDOWN_MS,
            socketBufferSoftLimitBytes: NETWORK.SOCKET_BUFFER_SOFT_LIMIT_BYTES,
            socketBufferHardLimitBytes: NETWORK.SOCKET_BUFFER_HARD_LIMIT_BYTES,
            socketBufferHardLimitGraceMs: NETWORK.SOCKET_BUFFER_HARD_LIMIT_GRACE_MS,
        },
        connections,
        authenticator,
        metadata: {
            protocolVersion: PROTOCOL_VERSION,
            rulesVersion: RULES_VERSION,
            mapBundleHash: bundle.mapBundleHash,
        },
        mapBundleBody,
        getServerTick: () => serverTick,
        violationSink,
    });

    // ── Redis 제어 평면 ──
    const keys = makeKeys(INFRA.ENV);
    const redis = new RedisClient({
        host: INFRA.REDIS_HOST,
        port: INFRA.REDIS_PORT,
        password: INFRA.REDIS_PASSWORD,
        logger: (level, message, error) => (level === 'error' ? console.error(message, error) : log(message)),
    });

    registry = new GameRegistry({
        redis,
        keys,
        rooms,
        heartbeat: {
            serverId: INFRA.SERVER_ID,
            buildVersion: INFRA.BUILD_ID,
            protocolVersion: PROTOCOL_VERSION,
            rulesVersion: RULES_VERSION,
            mapBundleHash: bundle.mapBundleHash,
            connectionCount: () => transport.connectionCount(),
            loopLagMs: () => scheduler.getStats().loopLagMs,
            isDraining: () => draining,
        },
    });

    const outbox = new ResultOutbox({ redis, keys });
    const consumer = new CommandConsumer({
        redis,
        keys,
        serverId: INFRA.SERVER_ID,
        wsPath: INFRA.PUBLIC_WS_PATH,
        consumerId: `${INFRA.SERVER_ID}-${process.pid}`,
        rooms,
        tickets,
        registry,
        isDraining: () => draining,
        // 명령 처리를 막지 않도록 기다리지 않고 시작만 시킨다. 남은 사람의 재접속 예약이
        // 이 소비자를 지나가므로 여기서 멈추면 안 된다.
        beginDrain: () => { void shutdown('DRAIN_SERVER'); },
        resolveMapId: (mapId) => {
            if (mapId !== 'random' || bundle.maps[mapId] !== undefined) return mapId;
            // 훈련장 맵은 추첨에서 뺀다. 넣어 두면 공개 방을 만든 사람이 이따금 연습장에 떨어진다.
            // 훈련장 방은 'random'을 쓰지 않고 맵 id를 직접 지정하므로 여기로 오지 않는다.
            const mapIds = playableMapIds(bundle, RoomMode.Match);
            return mapIds[Math.floor(Math.random() * mapIds.length)] ?? mapId;
        },
    });

    let draining = false;
    /** draining 중 남은 방을 확인하는 주기. 경기가 분 단위라 촘촘할 이유가 없다. */
    const DRAIN_POLL_MS = 1_000;

    // A newly started server is not useful until Redis authentication, the
    // command group, and the first registry heartbeat have all succeeded.
    try {
        await redis.connect();
        const serverIdClaimed = await registry.claimServerId();
        if (!serverIdClaimed && !INFRA.ALLOW_DUPLICATE_SERVER_ID) {
            throw new Error(`GAME_SERVER_ID=${INFRA.SERVER_ID} already has a live Redis heartbeat; refusing to share its command consumer group`);
        }
        if (!serverIdClaimed) {
            console.warn(`[swITch] DANGER: GAME_ALLOW_DUPLICATE_SERVER_ID=true; starting alongside the live GAME_SERVER_ID=${INFRA.SERVER_ID}`);
        }
        await consumer.start();
        await registry.start();
        if (!registry.healthy) throw new Error('initial registry heartbeat was not written');
    } catch (error) {
        await consumer.stop().catch(() => undefined);
        await redis.close().catch(() => undefined);
        throw new Error(`Redis control plane is required at startup: ${error instanceof Error ? error.message : String(error)}`);
    }
    log('Redis control plane connected and initial heartbeat published');

    await transport.listen(rooms);
    log(`  WebSocket      listening (${transport.boundPort()})`);

    // ── 시계 ──
    // 방 상태 전이(카운트다운, POST_GAME, 재접속 유예)는 시뮬레이션 tick이 아니라 실제 시각으로 돈다.
    // 경기가 없는 방도 진행돼야 하므로 스케줄러와 분리한다.
    const roomTimer = setInterval(() => {
        serverTick += 1;
        for (const projection of rooms.projections()) {
            rooms.get(projection.roomId)?.advance();
        }
        rooms.sweep();
    }, 100);

    scheduler.start();
    // outbox는 Redis 상태와 무관하게 자기 타이머로 재시도한다. 연결 성공을 기다리지 않는다.
    outbox.start();

    /**
     * Redis 제어 평면은 **없어도 프로세스가 죽지 않는다.**
     *
     * Redis가 끊기면 신규 방 배정과 결과 전송이 멈추지만, 진행 중인 방의 게임 루프는 로컬 메모리에서
     * 계속 돈다. 경기 중에 Redis가 재시작됐다고 8명이 튕기면 안 된다.
     *
     * 재시도는 고정 간격이다. 실패 즉시 다시 걸면 Redis가 죽어 있는 동안 hot loop가 된다.
     */
    let redisReady = false;
    const connectRedis = async (): Promise<void> => {
        try {
            await consumer.start();
            // Do not advertise a healthy server until its command consumer group is ready.
            await registry.start();
            redisReady = true;
            log('Redis 제어 평면 연결됨.');
        } catch (error) {
            redisReady = false;
            console.warn('[swITch] Redis 연결 실패. 진행 중인 방은 계속 돌아갑니다.', error instanceof Error ? error.message : error);
        }
    };
    void connectRedis();
    const redisRetry = setInterval(() => {
        if (!redisReady) void connectRedis();
    }, NETWORK.STREAM_AUTOCLAIM_IDLE_MS);

    log('조립 완료. 방 배정 대기 중.');

    // ── 종료 ──
    //
    // draining으로 전환하고 **방이 다 빌 때까지 기다린다.** 예전에는 주석만 그렇게 적혀 있고
    // 실제로는 즉시 scheduler를 멈추고 소켓을 닫았다 — 경기 중인 사람이 전부 그 자리에서 튕겼다.
    //
    // 기다리는 동안에도 소켓은 계속 받는다. 신규 방과 신규 참가는 명령 소비자가 막지만
    // (`ServerDraining`), **재접속은 막으면 안 된다.** 마지막 경기에서 잠깐 끊긴 사람이 영영
    // 못 돌아오게 된다.
    const shutdown = async (signal: string): Promise<void> => {
        if (draining) {
            // 제어 평면 명령은 재전달될 수 있다(멱등). 그걸 "두 번 눌렀다"로 읽어 사람을
            // 끊어 버리면 안 된다. 손으로 보내는 신호만 강제 종료로 친다.
            if (signal === 'DRAIN_SERVER') return;
            log(`${signal} 재수신. 남은 방을 버리고 즉시 종료합니다.`);
            process.exit(0);
        }
        draining = true;
        log(`${signal} 수신. draining으로 전환합니다. 남은 방 ${rooms?.size ?? 0}개`);
        // heartbeat 주기를 기다리지 않고 지금 알린다. 그래야 매칭 서버가 곧바로 배정을 멈춘다.
        await registry.publish().catch(() => undefined);

        await waitForEmptyRooms();

        clearInterval(roomTimer);
        clearInterval(redisRetry);
        scheduler.stop();
        outbox.stop();
        // 마지막 결과까지 내보내고 나간다. 여기서 버리면 방금 끝난 경기의 전적이 사라진다.
        await outbox.flush().catch(() => undefined);
        registry.stop();
        transport.setAccepting(false);
        await consumer.stop().catch(() => undefined);
        await transport.close().catch(() => undefined);
        await redis.close().catch(() => undefined);
        log('종료합니다.');
        process.exit(0);
    };

    /** 방이 0이 될 때까지 기다린다. 상한을 두지 않는다 — 경기 중인 사람을 끊지 않는 것이 우선이다. */
    const waitForEmptyRooms = async (): Promise<void> => {
        let lastReported = -1;
        for (;;) {
            const remaining = rooms?.size ?? 0;
            if (remaining === 0) return;
            if (remaining !== lastReported) {
                log(`draining: 남은 방 ${remaining}개`);
                lastReported = remaining;
            }
            await new Promise((resolve) => setTimeout(resolve, DRAIN_POLL_MS));
        }
    };

    process.on('SIGINT', () => void shutdown('SIGINT'));
    process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((error: unknown) => {
    console.error('[swITch] 인게임 서버 기동 실패', error);
    process.exit(1);
});
