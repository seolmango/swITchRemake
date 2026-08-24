/**
 * 권위 프레임 -> 연결별 스냅샷. 게임 루프의 12~13단계다.
 *
 * `stepWorld`가 만든 프레임은 연결을 모르는 단일 상태다. 여기서 **뷰어를 정해** 시야 코어를 돌리고
 * 그 결과만 담은 스냅샷을 만든다. 순서를 뒤집어 "연결을 돌면서 상태를 계산"하면 안 된다.
 *
 * 보이지 않는 플레이어는 `players` 목록에서 통째로 빠진다. 좌표를 보내고 클라이언트가 안 그리는
 * 방식이 아니다. 안 보내는 것이 곧 안 보임이며, 이게 레거시의 구조적 취약점을 없애는 방법이다.
 */

import {
    EFFECT_BITS,
    PROTOCOL_VERSION,
    SkillSlot,
    computeVisibility,
    encodeSnapshot,
    type Snapshot,
    type SnapshotPlayer,
} from 'shared';
import type { SnapshotAccess } from '../rooms/room';
import { skillInSlot } from '../simulation/skills';
import { toVisibilityWorld, type AuthoritativeFrame, type PlayerState, type World } from '../simulation/world';

export interface RosterEntry {
    playerId: number;
    nickname: string;
}

export interface ViewerContext {
    /** 관전자는 null. `SELF` 섹션을 받지 않는다. */
    playerId: number | null;
    access: SnapshotAccess;
    /** MAP과 ROSTER를 함께 싣는다. 리플레이의 keyframe도 이 프레임이다. */
    full: boolean;
}

/** 전송 계층이 publish 사이에 모은 맵 변경. simulation의 이번-tick 배열과는 별개다. */
export type SnapshotTileChange = { x: number; y: number; physics: World['tileChanges'][number]['physics'] };

function effectRatios(player: PlayerState, tick: number, simulationHz: number): SnapshotPlayer['effects'] {
    const effects: SnapshotPlayer['effects'] = {};
    for (const key of EFFECT_BITS) {
        const effect = player.effects[key];
        if (effect === undefined) continue;
        // 남은 비율. 지속시간을 모르므로 남은 tick을 초 단위로 환산해 1초 기준으로 정규화한다.
        const remainingTicks = Math.max(0, effect.endTick - tick);
        effects[key] = Math.min(1, remainingTicks / simulationHz);
    }
    return effects;
}

function toSnapshotPlayer(player: PlayerState, obscured: boolean, tick: number, simulationHz: number): SnapshotPlayer {
    return {
        id: player.playerId,
        x: Math.round(player.x),
        y: Math.round(player.y),
        facingX: player.facingX,
        facingY: player.facingY,
        colorIndex: player.colorIndex,
        obscured,
        isTagger: player.isTagger,
        effects: effectRatios(player, tick, simulationHz),
        ...(player.emoji !== null && player.emoji.expiresAtTick > tick
            ? { emojiId: player.emoji.emojiId }
            : {}),
    };
}

/**
 * 한 뷰어가 받을 스냅샷을 만든다.
 *
 * `unfiltered`는 관전자와 리플레이 전지적 모드다. 시야 코어를 아예 호출하지 않고 전원을 담는다.
 * "검열하지 않는다"는 판단은 호출하는 쪽(방 상태)이 하고 시야 코어는 스스로 정하지 않는다.
 */
export function buildSnapshot(
    frame: AuthoritativeFrame,
    viewer: ViewerContext,
    roster: readonly RosterEntry[],
    tileChanges: readonly SnapshotTileChange[] = frame.world.tileChanges,
): Snapshot {
    const world = frame.world;
    const snapshot: Snapshot = {
        version: PROTOCOL_VERSION,
        full: viewer.full,
        tick: frame.tick,
        storm: world.storm,
    };

    if (viewer.full) {
        snapshot.map = { cols: world.map.cols, rows: world.map.rows, tiles: world.map.tiles.map((row) => [...row]) };
        snapshot.roster = roster.map((entry) => ({ id: entry.playerId, nickname: entry.nickname }));
    } else if (tileChanges.length > 0) {
        snapshot.tileChanges = tileChanges.map((change) => ({ ...change }));
    }

    if (viewer.access === 'unfiltered' || viewer.playerId === null) {
        snapshot.players = world.players
            .filter((player) => player.alive)
            .map((player) => toSnapshotPlayer(player, false, frame.tick, world.simulationHz));
        return snapshot;
    }

    const visibility = computeVisibility(toVisibilityWorld(world), viewer.playerId);
    const obscured = new Set(visibility.obscuredPlayerIds);
    const visible = new Set(visibility.visiblePlayerIds);

    snapshot.players = world.players
        .filter((player) => player.alive && visible.has(player.playerId))
        .map((player) => toSnapshotPlayer(player, obscured.has(player.playerId), frame.tick, world.simulationHz));

    // 빈 목록도 보낸다. "이제 비치는 타일이 없다"와 "변화 없음"은 다르다.
    snapshot.tileAlphas = visibility.tileAlphas.map((tile) => ({ ...tile }));
    snapshot.selfId = viewer.playerId;
    const self = world.players.find((player) => player.playerId === viewer.playerId);
    if (self !== undefined) {
        snapshot.cooldowns = [SkillSlot.Switch, SkillSlot.Movement].flatMap((slot) => {
            const skill = skillInSlot(self, slot);
            if (skill === null) return [];
            const remainingTicks = Math.max(0, self.cooldowns[skill] ?? 0);
            const remainingMs = Math.min(0xffff, Math.round((remainingTicks / world.simulationHz) * 1000));
            return [{ slot, remainingMs }];
        });
    }

    return snapshot;
}

export function encodeForViewer(
    frame: AuthoritativeFrame,
    viewer: ViewerContext,
    roster: readonly RosterEntry[],
    tileChanges?: readonly SnapshotTileChange[],
): ArrayBuffer {
    return encodeSnapshot(buildSnapshot(frame, viewer, roster, tileChanges));
}

/** 연막 잔여시간. 아직 연막 스킬이 없어 항상 비어 있지만 형태를 미리 맞춰 둔다. */
export function regionsOf(_world: World): { x: number; y: number; remaining: number }[] {
    return [];
}
