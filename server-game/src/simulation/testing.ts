/**
 * 테스트와 개발 도구가 쓰는 world 조립 헬퍼.
 *
 * 시뮬레이션이 소켓과 Redis를 모른다는 약속 덕분에, 여기서 world 하나를 손으로 만들어 tick을
 * 돌리는 것만으로 게임 규칙 전체를 검증할 수 있다. 서버를 띄울 필요가 없다.
 */

import { TilePhysics, type MapMarker, type MapZone } from 'shared';
import { GAMEPLAY } from '../config/gameplay';
import { SkillId } from './skills';
import { createWorld, emptyStats, type MapTimeline, type PlayerState, type World, type WorldMap } from './world';

export const TEST_TILE_SIZE = 256;

/**
 * 문자열 그림으로 맵을 만든다. 테스트가 읽기 쉬워야 벽 통과 같은 버그를 눈으로 잡는다.
 *
 *   `.` 바닥 · `#` 벽 · `b` 수풀 · `g` 연막
 */
export function mapFromRows(
    rows: readonly string[],
    options: { barrierSpeed?: number; timeline?: MapTimeline; markers?: MapMarker[]; zones?: MapZone[] } = {},
): WorldMap {
    const tiles: TilePhysics[][] = rows.map((row) =>
        [...row].map((ch) => {
            switch (ch) {
                case '#': return TilePhysics.Wall;
                case 'b': return TilePhysics.Bush;
                case 'g': return TilePhysics.Gas;
                default: return TilePhysics.Floor;
            }
        }),
    );
    return {
        mapId: 'test',
        cols: tiles[0]?.length ?? 0,
        rows: tiles.length,
        tileSize: TEST_TILE_SIZE,
        tiles,
        barrierSpeed: options.barrierSpeed ?? 0,
        timeline: options.timeline ?? {},
        markers: options.markers ?? [],
        zones: options.zones ?? [],
    };
}

export function makePlayer(playerId: number, tileX: number, tileY: number, overrides: Partial<PlayerState> = {}): PlayerState {
    return {
        playerId,
        // 타일 중심에 놓는다. 레거시도 시작 위치를 `* 1000 + 500`으로 중심에 뒀다.
        x: (tileX + 0.5) * TEST_TILE_SIZE,
        y: (tileY + 0.5) * TEST_TILE_SIZE,
        vx: 0,
        vy: 0,
        facingX: 0,
        facingY: 1,
        radius: GAMEPLAY.PLAYER_RADIUS_PX,
        sightRange: GAMEPLAY.SIGHT_RANGE_PX,
        colorIndex: playerId,
        alive: true,
        isTagger: false,
        connected: true,
        effects: {},
        cooldowns: {},
        loadout: SkillId.Dash,
        emoji: null,
        stats: emptyStats(),
        ...overrides,
    };
}

export function makeWorld(map: WorldMap, players: PlayerState[], seed = 1): World {
    return createWorld({ map, players, seed });
}

/** 결정론 비교용. 함수(PRNG 메서드)를 빼고 상태만 남긴다. */
export function worldFingerprint(world: World): string {
    return JSON.stringify({
        tick: world.tick,
        randomState: world.randomState,
        taggerChangedAtTick: world.taggerChangedAtTick,
        storm: world.storm,
        tiles: world.map.tiles,
        players: world.players.map((p) => ({
            id: p.playerId,
            x: p.x,
            y: p.y,
            vx: p.vx,
            vy: p.vy,
            alive: p.alive,
            isTagger: p.isTagger,
        })),
    });
}
