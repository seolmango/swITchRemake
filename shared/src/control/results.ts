/**
 * 인게임 서버 -> 결과 저장 worker.
 *
 * 여기 있는 버전 필드와 `nickname`은 **나중에 채울 수 없는 값**이다. 컬럼을 나중에 추가할 수는 있어도
 * 추가 이전 경기의 값은 영원히 비어 있다. 그래서 결과를 처음 저장하는 날부터 전부 들어가야 한다.
 */

import type { ActorId } from './commands';

export const MATCH_RESULT_VERSION = 1;

export interface MatchParticipantResult {
    /** 게스트는 null. 그래도 행은 남긴다. 리플레이가 전원의 playerId와 닉네임을 필요로 한다. */
    userId: number | null;
    /** 방 범위 slot. 리플레이와 신고가 가리키는 값이다. */
    playerId: number;
    /** 경기 당시 닉네임. users를 조인하면 개명 시 과거 기록이 소급해서 바뀐다. */
    nickname: string;
    colorIndex: number;
    isGuest: boolean;
    tagCount: number;
    taggedCount: number;
    switchTry: number;
    switchSuccess: number;
    survivedMs: number;
}

/** 기록에 성공했을 때만 붙는다. 실패해도 경기 결과 저장은 진행한다. */
export interface ReplayHandleInfo {
    storageKey: string;
    formatVersion: number;
    chunkCount: number;
    sizeBytes: number;
    /** chunk 해시 목록에 대한 SHA-256. 서명을 나중에 붙여도 형식이 바뀌지 않게 미리 둔다. */
    rootHash: string;
}

export interface MatchResultMessage {
    v: typeof MATCH_RESULT_VERSION;
    /** 매칭 서버가 배정 시 발급한 값. 발급하지 않은 matchId의 결과는 버려진다. */
    matchId: string;
    roomId: string;
    serverId: string;
    mapId: string;
    startedAt: number;
    endedAt: number;
    durationTicks: number;

    // 이 경기가 어떤 규칙과 어떤 코드로 진행됐는지.
    buildId: string;
    protocolVersion: number;
    rulesVersion: string;
    mapBundleHash: string;
    visibilityCoreVersion: number;

    /**
     * 경기가 끝난 순간 살아 있던 전원. 모두 공동 승리자이며 등수는 없다.
     * 계정이 아니라 방 범위 slot으로 지목한다. 게스트도 이길 수 있기 때문이다.
     *
     * **길이를 둘로 고정하지 않는다.** 생존자가 2명 이하가 되면 끝나므로 보통 두 명이지만,
     * 한 틱에 두 명이 동시에 잡히면 한 명이고, 경기 최대 시간에 닿으면 그 시점의 생존자
     * 전원이라 최대 8명이다(BASE.md §2.1). 두 명으로 고정하면 그 두 경우가 표현되지 않아
     * 같은 사람을 두 번 적거나 승리자를 잘라내게 된다.
     *
     * 비어 있지 않고, 중복이 없으며, `players`에 있는 slot만 담는다.
     */
    winnerPlayerIds: readonly number[];

    replay: ReplayHandleInfo | null;
    players: MatchParticipantResult[];
}

/** 매칭 서버가 결과를 받았을 때 저장 전에 통과시켜야 하는 상한. 넘으면 저장하지 않고 이상 징후로 남긴다. */
export const RESULT_SANITY = Object.freeze({
    MAX_PLAYERS: 8,
    MAX_DURATION_MS: 60 * 60 * 1000,
    MAX_TAGS_PER_PLAYER: 1000,
});

/** 게스트를 뺀 전적 집계 대상만 고른다. */
export function statsEligible(players: readonly MatchParticipantResult[]): MatchParticipantResult[] {
    return players.filter((p) => p.userId !== null && !p.isGuest);
}

/** 승자 slot을 계정으로 옮긴다. 게스트 승자는 결과가 비어 있을 수 있다. */
export function winnerUserIds(result: MatchResultMessage): number[] {
    const byPlayerId = new Map(result.players.map((p) => [p.playerId, p]));
    return result.winnerPlayerIds
        .map((id) => byPlayerId.get(id)?.userId ?? null)
        .filter((id): id is number => id !== null);
}

export type { ActorId };
