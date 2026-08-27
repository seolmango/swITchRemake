/**
 * swITch 감독자.
 *
 * 인게임 서버 프로세스를 부하에 맞춰 늘리고 줄인다. 사용자는 이 존재를 모른다 — 주소는
 * 게이트웨이 하나뿐이고, 몇 대가 돌고 있는지는 그 뒤에서만 바뀐다.
 *
 * 줄이는 쪽이 늘리는 쪽보다 훨씬 조심스럽다. 프로세스를 그냥 죽이면 경기 중인 사람이 전부
 * 튕기므로, `DRAIN_SERVER`를 보내 신규 방을 막고 남은 방이 다 빌 때까지 기다린다. 그래서
 * 축소는 즉시성이 없다 — 몇 분이 걸릴 수 있고, 그건 설계상 감수하는 대가다.
 */

import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';
import Redis from 'ioredis';
import {
    CONTROL_VERSION,
    CommandType,
    HEARTBEAT_INTERVAL_MS,
    makeKeys,
    type ControlCommand,
    type GameServerHeartbeat,
    type RedisKeys,
} from 'shared';
import { DEFAULT_POLICY, decideScaling, serverLoad, type ScalingPolicy } from './policy';

const log = (message: string): void => { console.log(`[supervisor] ${message}`); };

const env = (name: string, fallback: string): string => process.env[name]?.trim() || fallback;
const num = (name: string, fallback: number): number => {
    const raw = process.env[name]?.trim();
    const value = raw === undefined || raw === '' ? fallback : Number(raw);
    return Number.isFinite(value) ? value : fallback;
};

const APP_ENV = env('APP_ENV', 'dev');
const REPO_ROOT = resolve(__dirname, '..', '..');
const GAME_ENTRY = resolve(REPO_ROOT, 'server-game', 'dist', 'main.js');
/** 부하를 다시 재는 주기. heartbeat보다 촘촘할 이유가 없다. */
const TICK_MS = HEARTBEAT_INTERVAL_MS * 2;

const POLICY: ScalingPolicy = {
    minServers: num('SUPERVISOR_MIN_SERVERS', DEFAULT_POLICY.minServers),
    maxServers: num('SUPERVISOR_MAX_SERVERS', DEFAULT_POLICY.maxServers),
    scaleUpLoad: num('SUPERVISOR_SCALE_UP_LOAD', DEFAULT_POLICY.scaleUpLoad),
    scaleDownLoad: num('SUPERVISOR_SCALE_DOWN_LOAD', DEFAULT_POLICY.scaleDownLoad),
    cooldownMs: num('SUPERVISOR_COOLDOWN_MS', DEFAULT_POLICY.cooldownMs),
};

interface Child {
    readonly serverId: string;
    readonly process: ChildProcess;
    /** heartbeat가 한 번이라도 올라왔는가. 안 올라온 동안은 '기동 중'으로 센다. */
    seen: boolean;
    draining: boolean;
}

const children = new Map<string, Child>();
let lastActionAt: number | null = null;
let stopping = false;

async function main(): Promise<void> {
    const redis = new Redis({
        host: env('REDIS_HOST', 'localhost'),
        port: num('REDIS_PORT', 6379),
        ...(process.env.REDIS_PASSWORD ? { password: process.env.REDIS_PASSWORD } : {}),
        lazyConnect: true,
        maxRetriesPerRequest: 2,
    });
    await redis.connect();
    const keys = makeKeys(APP_ENV);

    log(`시작. 최소 ${POLICY.minServers}대 / 최대 ${POLICY.maxServers}대, `
        + `증설 문턱 ${POLICY.scaleUpLoad} / 축소 문턱 ${POLICY.scaleDownLoad}`);

    const timer = setInterval(() => { void tick(redis, keys); }, TICK_MS);
    timer.unref();
    await tick(redis, keys);

    const shutdown = (signal: string): void => {
        if (stopping) process.exit(0);
        stopping = true;
        clearInterval(timer);
        log(`${signal} 수신. 자식 프로세스 ${children.size}개를 정리합니다.`);
        // 여기서는 drain을 기다리지 않는다. 감독자를 끄는 것은 개발자가 판을 접는 행동이고,
        // 그 자리에서 몇 분을 기다리게 하면 아무도 안 쓴다. 운영에서 서버만 재우려면
        // 감독자를 끄는 대신 DRAIN_SERVER를 보낸다.
        for (const child of children.values()) child.process.kill();
        void redis.quit().catch(() => undefined);
        setTimeout(() => process.exit(0), 500).unref();
    };
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
}

async function tick(redis: Redis, keys: RedisKeys): Promise<void> {
    if (stopping) return;
    const servers = await readServers(redis, keys);
    const alive = new Set(servers.map((server) => server.serverId));

    // heartbeat가 보이면 기동이 끝난 것이다. 이 표시가 있어야 '기동 중'과 '한가한 서버'를
    // 구분할 수 있다.
    for (const child of children.values()) {
        if (alive.has(child.serverId)) child.seen = true;
        if (servers.find((server) => server.serverId === child.serverId)?.draining === true) child.draining = true;
    }

    const starting = [...children.values()].filter((child) => !child.seen).length;
    const action = decideScaling({ servers, starting, now: Date.now(), lastActionAt, policy: POLICY });

    if (action.kind === 'up') {
        lastActionAt = Date.now();
        spawnServer();
        log(`증설: ${action.reason}`);
        return;
    }
    if (action.kind === 'down') {
        lastActionAt = Date.now();
        log(`축소: ${action.serverId}를 재웁니다 — ${action.reason}`);
        await sendDrain(redis, keys, action.serverId);
        const child = children.get(action.serverId);
        if (child !== undefined) child.draining = true;
        return;
    }

    const summary = servers
        .map((server) => `${server.serverId}=${serverLoad(server).toFixed(1)}${server.draining ? '(재우는 중)' : ''}`)
        .join(' ');
    if (summary.length > 0) log(`유지: ${action.reason} | ${summary}`);
}

async function readServers(redis: Redis, keys: RedisKeys): Promise<GameServerHeartbeat[]> {
    try {
        const ids = await redis.zrange(keys.gameServersAlive(), 0, -1);
        const raw = await Promise.all(ids.map((id) => redis.get(keys.gameServer(id))));
        return raw.flatMap((value) => {
            if (value === null) return [];
            try {
                return [JSON.parse(value) as GameServerHeartbeat];
            } catch {
                return [];
            }
        });
    } catch (error: unknown) {
        log(`서버 목록을 읽지 못했습니다: ${String(error)}`);
        return [];
    }
}

/**
 * 새 인게임 서버를 띄운다.
 *
 * 포트를 0으로 준다. OS가 비어 있는 것을 골라 주고, 서버는 **실제로 바인딩된 포트**를
 * heartbeat에 실어 게이트웨이가 그걸 보고 찾아간다. 감독자가 포트를 손으로 배정하면
 * 이미 쓰이는 포트를 골라 기동이 실패하는 경우를 직접 피해야 한다.
 */
function spawnServer(): void {
    const serverId = `${env('SUPERVISOR_SERVER_PREFIX', 'game-auto')}-${randomUUID().slice(0, 8)}`;
    const child = spawn(process.execPath, [GAME_ENTRY], {
        cwd: REPO_ROOT,
        env: {
            ...process.env,
            GAME_SERVER_ID: serverId,
            GAME_PORT: '0',
            GAME_PUBLIC_WS_PATH: `/game-ws/${serverId}`,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    const entry: Child = { serverId, process: child, seen: false, draining: false };
    children.set(serverId, entry);

    const relay = (prefix: string) => (chunk: Buffer) => {
        for (const line of chunk.toString('utf8').split('\n')) {
            if (line.trim().length > 0) console.log(`${prefix}[${serverId}] ${line}`);
        }
    };
    child.stdout?.on('data', relay(''));
    child.stderr?.on('data', relay('!'));

    child.on('exit', (code) => {
        children.delete(serverId);
        // 0으로 나간 것은 스스로 정리하고 나간 것이다 — 감독자가 재운 경우도 있고, 밖에서
        // DRAIN_SERVER를 받은 경우도 있다. 후자는 감독자가 draining heartbeat를 보기 전에
        // 끝날 수 있어서, `entry.draining`만 보고 판단하면 멀쩡한 종료를 사고로 알린다.
        // 사고는 0이 아닌 코드다.
        if (code === 0) log(`${serverId} 종료 (재우기 완료)`);
        else log(`! ${serverId}가 예기치 않게 종료했습니다 (code=${String(code)})`);
    });

    log(`${serverId} 기동 중`);
}

/**
 * 신호가 아니라 제어 평면으로 재운다.
 *
 * Windows에는 SIGTERM이 없어 Node가 핸들러를 부르지 않고 프로세스를 즉시 죽인다 — 경기 중인
 * 사람이 전부 튕긴다. 그리고 감독자가 인게임 서버와 같은 기계에 있다는 보장도 없다.
 */
async function sendDrain(redis: Redis, keys: RedisKeys, serverId: string): Promise<void> {
    const command: ControlCommand = {
        v: CONTROL_VERSION,
        requestId: randomUUID(),
        type: CommandType.DrainServer,
        issuedAt: Date.now(),
        deadlineAt: Date.now() + 30_000,
        // 답을 읽지 않는다. 재우기의 성공은 응답이 아니라 그 서버가 heartbeat에서 사라지는
        // 것으로 확인한다 — 그게 실제로 방이 다 비었다는 뜻이다.
        replyTo: keys.replies(),
        payload: { serverId },
    };
    try {
        await redis.xadd(keys.commands(serverId), '*', 'command', JSON.stringify(command));
    } catch (error: unknown) {
        log(`${serverId}에 재우기 명령을 보내지 못했습니다: ${String(error)}`);
    }
}

main().catch((error: unknown) => {
    console.error('[supervisor] 기동 실패', error);
    process.exit(1);
});
