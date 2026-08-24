import {
    MAX_PLAYERS_PER_ROOM,
    MATCH_RESULT_VERSION,
    RESULT_SANITY,
    type MatchParticipantResult,
    type MatchResultMessage,
} from 'shared';

export const RESULT_STREAM_FIELD = 'result';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;

/**
 * `survivedMs`는 시뮬레이션 tick 시계(`tick * msPerTick`)로, `durationMs`는 벽시계(`endedAt - startedAt`)로
 * 잰다. 스케줄러의 catch-up 처리 때문에 두 시계가 긴 경기에서는 수십 ms씩 어긋날 수 있다 — 데이터 조작이
 * 아니라 정상적인 tick/wall-clock 오차다. 이 여유가 없으면 실제 경기 결과가 간헐적으로 malformed 처리된다.
 */
const SURVIVED_MS_CLOCK_SKEW_TOLERANCE_MS = 2_000;

export function decodeMatchResult(raw: string): MatchResultMessage {
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        throw new Error('Result is not valid JSON');
    }
    if (!isMatchResult(parsed)) {
        throw new Error('Result does not satisfy MatchResultMessage');
    }
    return parsed;
}

export function isMatchResult(value: unknown): value is MatchResultMessage {
    if (!isRecord(value)) return false;
    if (value.v !== MATCH_RESULT_VERSION
        || !isUuid(value.matchId)
        || !shortString(value.roomId)
        || !shortString(value.serverId)
        || !shortString(value.mapId)
        || !nonNegativeInteger(value.startedAt)
        || !nonNegativeInteger(value.endedAt)
        || value.endedAt < value.startedAt
        || value.endedAt - value.startedAt > RESULT_SANITY.MAX_DURATION_MS
        || !nonNegativeInteger(value.durationTicks)
        || !shortString(value.buildId)
        || !nonNegativeInteger(value.protocolVersion)
        || !shortString(value.rulesVersion)
        || !shortString(value.mapBundleHash)
        || !nonNegativeInteger(value.visibilityCoreVersion)
        || !Array.isArray(value.players)
        || value.players.length === 0
        || value.players.length > RESULT_SANITY.MAX_PLAYERS
        || !Array.isArray(value.winnerPlayerIds)
        || value.winnerPlayerIds.length !== 2
        || !value.winnerPlayerIds.every(nonNegativeInteger)
        || !isReplay(value.replay)) {
        return false;
    }

    const players = value.players as unknown[];
    if (!players.every(isParticipant)) return false;
    const durationMs = value.endedAt - value.startedAt;
    if (players.some((player) => (player as MatchParticipantResult).survivedMs > durationMs + SURVIVED_MS_CLOCK_SKEW_TOLERANCE_MS)) return false;
    const playerIds = new Set(players.map((player) => (player as MatchParticipantResult).playerId));
    if (playerIds.size !== players.length
        || !value.winnerPlayerIds.every((id) => playerIds.has(id))) {
        return false;
    }
    const accountIds = players
        .map((player) => (player as MatchParticipantResult).userId)
        .filter((id): id is number => id !== null);
    return new Set(accountIds).size === accountIds.length;
}

function isParticipant(value: unknown): value is MatchParticipantResult {
    if (!isRecord(value)) return false;
    const guest = value.isGuest === true;
    const userIdValid = guest
        ? value.userId === null
        : Number.isInteger(value.userId) && (value.userId as number) > 0;
    return userIdValid
        && positiveInteger(value.playerId)
        && value.playerId <= MAX_PLAYERS_PER_ROOM
        && typeof value.nickname === 'string'
        && value.nickname.length > 0
        && value.nickname.length <= 20
        && nonNegativeInteger(value.colorIndex)
        && value.colorIndex < RESULT_SANITY.MAX_PLAYERS
        && nonNegativeInteger(value.tagCount)
        && value.tagCount <= RESULT_SANITY.MAX_TAGS_PER_PLAYER
        && nonNegativeInteger(value.taggedCount)
        && value.taggedCount <= RESULT_SANITY.MAX_TAGS_PER_PLAYER
        && nonNegativeInteger(value.switchTry)
        && nonNegativeInteger(value.switchSuccess)
        && value.switchSuccess <= value.switchTry
        && nonNegativeInteger(value.survivedMs)
        && value.survivedMs <= RESULT_SANITY.MAX_DURATION_MS;
}

function isReplay(value: unknown): boolean {
    if (value === null) return true;
    return isRecord(value)
        && typeof value.storageKey === 'string'
        && value.storageKey.length > 0
        && value.storageKey.length <= 1024
        && positiveInteger(value.formatVersion)
        && positiveInteger(value.chunkCount)
        && positiveInteger(value.sizeBytes)
        && typeof value.rootHash === 'string'
        && SHA256.test(value.rootHash);
}

function isRecord(value: unknown): value is Record<string, any> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function shortString(value: unknown): value is string {
    return typeof value === 'string' && value.length > 0 && value.length <= 255;
}

function nonNegativeInteger(value: unknown): value is number {
    return Number.isSafeInteger(value) && (value as number) >= 0;
}

function positiveInteger(value: unknown): value is number {
    return Number.isSafeInteger(value) && (value as number) > 0;
}

function isUuid(value: unknown): value is string {
    return typeof value === 'string' && UUID_V4.test(value);
}
