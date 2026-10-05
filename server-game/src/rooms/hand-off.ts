/**
 * 재우는 중인 서버가 대기실 방을 다른 서버로 넘긴다.
 *
 * 재우기(`DRAIN_SERVER`)만으로는 마지막 사람이 나갈 때까지 기다려야 한다. 대기실에 앉아 있는
 * 방은 옮겨도 되는데 — 시뮬레이션이 안 돌고 있어서 옮길 것이 명단과 방 정보뿐이다 — 그걸
 * 옮기면 축소가 "마지막 사람이 나갈 때까지"에서 "마지막 경기가 끝날 때까지"로 짧아진다.
 *
 * 클라이언트는 이 일을 모른다. 소켓이 끊기면 자동 재접속이 돌고, 그 경로가 매칭 서버에 방의
 * **현재** 서버를 다시 물어보기 때문이다. 그래서 "방이 옮겨졌다"는 메시지도, 클라이언트 수정도
 * 필요 없다.
 */

import { randomUUID } from 'node:crypto';
import {
    CONTROL_VERSION,
    CommandType,
    PROTOCOL_VERSION,
    type ControlCommand,
    type GameServerHeartbeat,
    type RedisKeys,
} from 'shared';
import { CONTROL_STREAM_FIELDS } from '../redis/control-codec';
import type { RedisPort } from '../redis/redis-client';
import type { RoomManager } from './room-manager';

export interface HandOffOptions {
    readonly redis: RedisPort;
    readonly keys: RedisKeys;
    readonly rooms: RoomManager;
    /**
     * 넘긴 방을 **지우지 말고 잊게** 하려고 받는다. 이게 없으면 이쪽의 정리 루프가 상대가
     * 방금 쓴 디렉터리 키를 지워 버린다.
     */
    readonly forgetRoom: (roomId: string) => void;
    readonly serverId: string;
    readonly log: (message: string) => void;
    /** 상대가 방을 세웠는지 확인하는 데 쓸 시간. 테스트가 짧게 줄인다. */
    readonly confirmTries?: number;
    readonly confirmIntervalMs?: number;
}

const DEADLINE_MS = 10_000;
const DEFAULT_CONFIRM_TRIES = 20;
const DEFAULT_CONFIRM_INTERVAL_MS = 100;

// A timeout is not a failed transfer. Keep rooms frozen until Redis proves
// either commit or cancellation. This map survives subsequent drain attempts.
const pendingByManager = new WeakMap<RoomManager, Map<string, string>>();

export async function handOffWaitingRooms(options: HandOffOptions): Promise<number> {
    let pending = pendingByManager.get(options.rooms);
    if (!pending) { pending = new Map(); pendingByManager.set(options.rooms, pending); }
    let moved = 0;
    const settle = async (roomId: string, transferId: string): Promise<void> => {
        const room = options.rooms.get(roomId);
        const key = options.keys.operation('handoff:' + transferId);
        try {
            // Cancellation and adoption contend on the same key in the atomic commit.
            await options.redis.compareAndSetPx(key, 'pending', 'cancelled', 86_400_000);
            const state = await options.redis.get(key);
            if (state === 'committed') {
                options.forgetRoom(roomId);
                room?.releaseAfterHandOff();
                options.rooms.sweep();
                pending!.delete(roomId);
                moved += 1;
            } else if (state === 'cancelled') {
                room?.cancelHandOff();
                pending!.delete(roomId);
            }
        } catch (error) { options.log('Handoff unresolved; source remains frozen: ' + String(error)); }
    };
    const previouslyPending = new Set(pending.keys());
    for (const [roomId, transferId] of pending) await settle(roomId, transferId);
    const peer = await findPeer(options);
    if (peer === null) return moved;
    for (const projection of options.rooms.projections()) {
        if (previouslyPending.has(projection.roomId)) continue;
        const room = options.rooms.get(projection.roomId);
        if (room === null || !room.freezeForHandOff()) continue;
        const transferId = randomUUID();
        const key = options.keys.operation('handoff:' + transferId);
        try {
            if (!await options.redis.setPxIfAbsent(key, 'pending', 86_400_000)) {
                room.cancelHandOff(); continue;
            }
        } catch { room.cancelHandOff(); continue; } // No command has been sent yet.
        pending.set(room.id, transferId);
        const command: ControlCommand = {
            v: CONTROL_VERSION, requestId: transferId, type: CommandType.AdoptRoom,
            issuedAt: Date.now(), deadlineAt: Date.now() + DEADLINE_MS,
            replyTo: options.keys.replies(),
            payload: { ...room.exportForHandOff(peer), sourceServerId: options.serverId, transferId },
        };
        try {
            await options.redis.xAdd(options.keys.commands(peer), CONTROL_STREAM_FIELDS.command,
                JSON.stringify(command), 1_000);
            for (let attempt = 0; attempt < (options.confirmTries ?? DEFAULT_CONFIRM_TRIES); attempt++) {
                await new Promise((resolve) => setTimeout(resolve, options.confirmIntervalMs ?? DEFAULT_CONFIRM_INTERVAL_MS));
                if (await options.redis.get(key) !== 'pending') break;
            }
        } catch (error) { options.log('Handoff send/confirmation uncertain: ' + String(error)); }
        await settle(room.id, transferId);
    }
    return moved;
}

/** 방을 받아 줄 서버. 재우는 중이 아니고 프로토콜이 같은, 가장 한가한 한 대. */
async function findPeer(options: HandOffOptions): Promise<string | null> {
    try {
        const ids = await options.redis.zRange(options.keys.gameServersAlive(), 0, -1);
        const peers: GameServerHeartbeat[] = [];
        for (const id of ids) {
            if (id === options.serverId) continue;
            const raw = await options.redis.get(options.keys.gameServer(id));
            if (raw === null) continue;
            try {
                const value = JSON.parse(raw) as GameServerHeartbeat;
                // 재우는 중인 서버에 얹으면 그 방이 한 번 더 옮겨 다니고, 사람들은 재접속을
                // 두 번 겪는다.
                if (!value.draining && value.protocolVersion === PROTOCOL_VERSION) peers.push(value);
            } catch { /* 깨진 heartbeat는 없는 것으로 친다 */ }
        }
        peers.sort((a, b) =>
            (a.waitingRooms + a.playingRooms) - (b.waitingRooms + b.playingRooms)
            || a.serverId.localeCompare(b.serverId));
        return peers[0]?.serverId ?? null;
    } catch {
        return null;
    }
}
