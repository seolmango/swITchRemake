import {
    CONTROL_VERSION,
    CommandType,
    MAX_PLAYERS_PER_ROOM,
    type ActorId,
    type ControlCommand,
    type ControlReply,
    type CreateRoomPayload,
    type DeleteReplayPayload,
    type KickUserPayload,
    type ReleaseSeatPayload,
    type ReserveJoinPayload,
    type ReserveResumePayload,
    RoomMode,
} from 'shared';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const GUEST_ACTOR = /^g:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isControlRequestId(value: unknown): value is string {
    return typeof value === 'string' && UUID_V4.test(value);
}

/** A1과 고정한 wire field. 각 field 값은 분할되지 않은 JSON 문서 하나다. */
export const CONTROL_STREAM_FIELDS = Object.freeze({
    command: 'command',
    reply: 'reply',
});

function object(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function actor(value: unknown): value is ActorId {
    return (typeof value === 'number' && Number.isSafeInteger(value) && value > 0)
        || (typeof value === 'string' && GUEST_ACTOR.test(value));
}

function text(value: unknown): value is string { return typeof value === 'string' && value.length > 0; }

function boundedText(value: unknown, maxLength: number): value is string {
    return typeof value === 'string' && value.length > 0 && value.length <= maxLength;
}

function nullableBoundedText(value: unknown, maxLength: number): value is string | null {
    return value === null || (typeof value === 'string' && value.length <= maxLength);
}

function createRoomPayload(value: unknown): value is CreateRoomPayload {
    if (!object(value)) return false;
    return boundedText(value['matchId'], 128)
        && typeof value['roomCode'] === 'string'
        && /^[A-HJ-NP-Z2-9]{6}$/.test(value['roomCode'])
        && boundedText(value['roomName'], 20)
        && nullableBoundedText(value['password'], 32)
        && actor(value['ownerUserId'])
        && boundedText(value['ownerNickname'], 20)
        && Number.isSafeInteger(value['capacity'])
        && typeof value['capacity'] === 'number'
        // 훈련장은 혼자 들어가는 방이라 정원 1을 허용한다. 경기 방은 예전대로 2 이상이다.
        && value['capacity'] >= (value['mode'] === RoomMode.Training ? 1 : 2)
        && value['capacity'] <= MAX_PLAYERS_PER_ROOM
        && boundedText(value['mapId'], 64)
        && (value['mode'] === undefined || value['mode'] === RoomMode.Match || value['mode'] === RoomMode.Training);
}

function reserveJoinPayload(value: unknown): value is ReserveJoinPayload {
    if (!object(value)) return false;
    return boundedText(value['roomId'], 128)
        && actor(value['userId'])
        && boundedText(value['nickname'], 20)
        && nullableBoundedText(value['password'], 32);
}

function reserveResumePayload(value: unknown): value is ReserveResumePayload {
    return object(value) && boundedText(value['roomId'], 128) && actor(value['userId']);
}

function releaseSeatPayload(value: unknown): value is ReleaseSeatPayload {
    return object(value) && boundedText(value['roomId'], 128) && actor(value['userId']);
}

function kickUserPayload(value: unknown): value is KickUserPayload {
    return object(value)
        && boundedText(value['roomId'], 128)
        && actor(value['userId'])
        && boundedText(value['reason'], 256);
}

function deleteReplayPayload(value: unknown): value is DeleteReplayPayload {
    return object(value) && boundedText(value['replayId'], 128) && boundedText(value['storageKey'], 1024);
}

/**
 * 여기 없는 명령은 malformed로 거절된다.
 *
 * `DeleteReplay`가 빠져 있었다. 소비자에는 처리기가 멀쩡히 있었는데 이 목록을 지나지 못해서
 * 리플레이 삭제 명령이 **하나도** 도달하지 못했고, 보관 기간이 지난 파일이 디스크에 계속
 * 남았다. 명령을 더할 때 여기도 같이 늘리지 않으면 같은 일이 반복된다.
 */
function validPayload(type: string, payload: unknown): boolean {
    switch (type) {
        case CommandType.CreateRoom: return createRoomPayload(payload);
        case CommandType.ReserveJoin: return reserveJoinPayload(payload);
        case CommandType.ReserveResume: return reserveResumePayload(payload);
        case CommandType.ReleaseSeat: return releaseSeatPayload(payload);
        case CommandType.KickUser: return kickUserPayload(payload);
        case CommandType.DrainServer: return object(payload) && text(payload['serverId']);
        case CommandType.AdoptRoom: return adoptRoomPayload(payload);
        case CommandType.DeleteReplay: return deleteReplayPayload(payload);
        default: return false;
    }
}

export function decodeCommand(value: string): ControlCommand {
    const parsed: unknown = JSON.parse(value);
    if (!object(parsed)
        || parsed['v'] !== CONTROL_VERSION
        || !isControlRequestId(parsed['requestId'])
        || !text(parsed['type'])
        || typeof parsed['issuedAt'] !== 'number'
        || !Number.isFinite(parsed['issuedAt'])
        || typeof parsed['deadlineAt'] !== 'number'
        || !Number.isFinite(parsed['deadlineAt'])
        || parsed['deadlineAt'] < parsed['issuedAt']
        || !text(parsed['replyTo'])
        || !validPayload(parsed['type'], parsed['payload'])) {
        throw new Error('Malformed control command');
    }
    return parsed as unknown as ControlCommand;
}

function adoptRoomPayload(payload: unknown): boolean {
    if (!object(payload)) return false;
    for (const field of ['serverId', 'roomId', 'roomCode', 'matchId', 'name', 'mapId', 'mode'] as const) {
        if (!text(payload[field])) return false;
    }
    if (typeof payload['capacity'] !== 'number') return false;
    if (payload['password'] !== null && !text(payload['password'])) return false;
    const members = payload['members'];
    if (!Array.isArray(members) || members.length === 0 || members.length > MAX_PLAYERS_PER_ROOM) return false;
    return members.every((member: unknown) => object(member)
        && (typeof member['userId'] === 'number' || text(member['userId']))
        && typeof member['playerId'] === 'number'
        && typeof member['slot'] === 'number'
        && text(member['nickname'])
        && typeof member['guest'] === 'boolean'
        && typeof member['isHost'] === 'boolean');
}

export function encodeReply(reply: ControlReply): string { return JSON.stringify(reply); }

export function decodeStoredReply(value: string): ControlReply | null {
    let parsed: unknown;
    try {
        parsed = JSON.parse(value) as unknown;
    } catch {
        return null;
    }
    if (!object(parsed)
        || parsed['v'] !== CONTROL_VERSION
        || !text(parsed['requestId'])
        || typeof parsed['serverId'] !== 'string'
        || typeof parsed['ok'] !== 'boolean'
        || (parsed['code'] !== null && typeof parsed['code'] !== 'string')
        || !('payload' in parsed)) return null;
    return parsed as unknown as ControlReply;
}
