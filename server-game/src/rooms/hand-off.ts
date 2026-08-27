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

/**
 * 넘길 수 있는 방을 모두 넘긴다. 넘긴 개수를 돌려준다.
 *
 * 순서가 이 함수의 전부다. 상대가 방을 세운 것을 **확인한 뒤에** 이쪽 방을 접는다. 반대로 하면
 * 그 사이에 재접속한 사람이 아무 데도 없는 방을 찾는다.
 *
 * 확인은 응답이 아니라 **방 디렉터리**로 한다. 매칭 서버가 재접속을 어디로 보낼지 정할 때 보는
 * 값이 바로 그것이라, 그게 바뀌었다는 사실이 곧 "이제 저쪽이 주인이다"라는 뜻이다. 응답을 읽으려면
 * 인게임 서버가 응답 스트림 소비자를 하나 더 갖게 되는데, 그건 확인이 약해지면서 코드만 는다.
 */
export async function handOffWaitingRooms(options: HandOffOptions): Promise<number> {
    const movable = options.rooms.projections()
        .filter((projection) => options.rooms.get(projection.roomId)?.canHandOff() === true);
    if (movable.length === 0) return 0;

    const peer = await findPeer(options);
    if (peer === null) return 0;

    let moved = 0;
    for (const projection of movable) {
        const room = options.rooms.get(projection.roomId);
        // 이 사이에 경기가 시작됐을 수 있다. 그때는 넘기지 않는다.
        if (room === null || !room.canHandOff()) continue;

        const command: ControlCommand = {
            v: CONTROL_VERSION,
            requestId: randomUUID(),
            type: CommandType.AdoptRoom,
            issuedAt: Date.now(),
            deadlineAt: Date.now() + DEADLINE_MS,
            replyTo: options.keys.replies(),
            payload: room.exportForHandOff(peer),
        };
        try {
            await options.redis.xAdd(
                options.keys.commands(peer),
                CONTROL_STREAM_FIELDS.command,
                JSON.stringify(command),
                1_000,
            );
        } catch (error: unknown) {
            options.log(`방 ${projection.roomId}를 ${peer}로 넘기지 못했습니다: ${String(error)}`);
            continue;
        }

        if (await peerOwnsRoom(options, projection.roomId, peer)) {
            options.log(`방 ${projection.roomId}를 ${peer}로 넘겼습니다`);
            options.forgetRoom(projection.roomId);
            room.releaseAfterHandOff();
            options.rooms.sweep();
            moved += 1;
        } else {
            // 상대가 못 받았다. 이 방은 계속 여기 있고 다음 차례에 다시 시도한다. 아무것도
            // 잃지 않는 실패이므로 요란하게 다루지 않는다.
            options.log(`방 ${projection.roomId} 넘기기가 확인되지 않았습니다. 계속 들고 있습니다.`);
        }
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

/** 방 디렉터리가 상대를 주인으로 가리킬 때까지 짧게 기다린다. */
async function peerOwnsRoom(options: HandOffOptions, roomId: string, peer: string): Promise<boolean> {
    const tries = options.confirmTries ?? DEFAULT_CONFIRM_TRIES;
    const interval = options.confirmIntervalMs ?? DEFAULT_CONFIRM_INTERVAL_MS;
    for (let attempt = 0; attempt < tries; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, interval));
        try {
            const raw = await options.redis.get(options.keys.room(roomId));
            if (raw === null) continue;
            if ((JSON.parse(raw) as { serverId?: string }).serverId === peer) return true;
        } catch { /* 다음 차례에 다시 본다 */ }
    }
    return false;
}
