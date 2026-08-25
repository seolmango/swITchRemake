import { describe, expect, it } from 'vitest';
import { decodeSnapshot, TilePhysics, type Snapshot } from 'shared';
import { HELP_DEMO_IDS, HELP_DEMO_TIMELINES, type HelpDemoId } from './tutorialSnapshots.ts';

/**
 * 좌표를 그대로 박아 두면 데모를 조금만 손봐도 테스트가 깨지면서 정작 **무엇이 잘못됐는지는
 * 말해 주지 않는다.** 여기서는 사용자가 실제로 지적했던 것들만 규칙으로 확인한다:
 * 벽을 통과하지 않을 것, 점멸만 예외일 것, 스킬 전에 이미 움직이고 있을 것.
 */

const TILE = 256;

function frames(id: HelpDemoId): Snapshot[] {
    return HELP_DEMO_TIMELINES[id].frames.map((f) => decodeSnapshot(f.buffer));
}

function mapOf(id: HelpDemoId): NonNullable<Snapshot['map']> {
    const map = frames(id)[0]!.map;
    if (!map) throw new Error(`${id} 데모의 첫 프레임에 맵이 없다`);
    return map;
}

const isWall = (map: NonNullable<Snapshot['map']>, x: number, y: number): boolean => {
    const col = Math.floor(x / TILE);
    const row = Math.floor(y / TILE);
    return map.tiles[row]?.[col] === TilePhysics.Wall;
};

/** 두 프레임 사이를 잘게 나눠 벽을 스쳤는지 본다. 프레임만 보면 벽을 뛰어넘은 것을 놓친다. */
function crossesWall(
    map: NonNullable<Snapshot['map']>,
    from: { x: number; y: number },
    to: { x: number; y: number },
): boolean {
    const steps = Math.max(1, Math.ceil(Math.hypot(to.x - from.x, to.y - from.y) / 32));
    for (let i = 0; i <= steps; i += 1) {
        const t = i / steps;
        if (isWall(map, from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t)) return true;
    }
    return false;
}

describe('help demo snapshot timelines', () => {
    it('starts every demo with one complete snapshot that carries the map', () => {
        for (const id of HELP_DEMO_IDS) {
            const first = decodeSnapshot(HELP_DEMO_TIMELINES[id].frames[0]!.buffer);
            expect(first.full, id).toBe(true);
            expect(first.map, id).toBeDefined();
        }
    });

    it('never walks a player through a wall', () => {
        // 점멸만 예외다. 벽을 넘는 것이 그 스킬의 전부다.
        for (const id of HELP_DEMO_IDS.filter((demo) => demo !== 'flash')) {
            const map = mapOf(id);
            const timeline = frames(id);
            for (let i = 1; i < timeline.length; i += 1) {
                for (const player of timeline[i]!.players ?? []) {
                    const previous = timeline[i - 1]!.players?.find((p) => p.id === player.id);
                    if (!previous) continue;
                    expect(
                        crossesWall(map, previous, player),
                        `${id} 데모의 ${i}번 프레임에서 ${player.id}번이 벽을 지나갔다`,
                    ).toBe(false);
                }
            }
        }
    });

    it('sends flash through a wall, because that is the whole skill', () => {
        const map = mapOf('flash');
        const timeline = frames('flash');
        const jumped = timeline.some((snapshot, i) => {
            if (i === 0) return false;
            const now = snapshot.players?.[0];
            const before = timeline[i - 1]!.players?.[0];
            return Boolean(now && before && crossesWall(map, before, now));
        });
        expect(jumped, '점멸 데모가 벽을 넘지 않으면 아무것도 설명하지 못한다').toBe(true);
    });

    it('has every skill demo already moving before the skill lands', () => {
        // 속도가 붙거나 떨어지는 것은 비교 대상이 있어야 보인다.
        for (const id of HELP_DEMO_IDS.filter((demo) => demo !== 'tagger')) {
            const timeline = frames(id);
            const event = HELP_DEMO_TIMELINES[id].frames.findIndex((f) => f.event !== undefined);
            const skillFrame = event >= 0 ? event : 40;
            const start = timeline[0]!.players?.[0];
            const justBefore = timeline[skillFrame - 1]!.players?.[0];
            expect(start, id).toBeDefined();
            expect(
                Math.abs(justBefore!.x - start!.x) + Math.abs(justBefore!.y - start!.y),
                `${id} 데모가 스킬 전에 가만히 서 있다`,
            ).toBeGreaterThan(0);
        }
    });

    it('draws a range circle for the two skills that have one', () => {
        for (const id of ['exhaust', 'switch'] as const) {
            const area = HELP_DEMO_TIMELINES[id].frames.find((f) => f.event?.skillArea)?.event?.skillArea;
            expect(area, `${id}는 사거리 원이 있어야 한다`).toBeDefined();
            expect(area!.rangePx).toBeGreaterThan(0);
            // 색이 "누구에게 갔는가"를 말한다. 대상이 없으면 설명이 반쪽이다.
            expect(area!.affectedPlayerId).not.toBeNull();
        }
    });

    it('keeps the storm off the demo view', () => {
        // 붉은 테두리가 보이면 "여기가 끝"으로 읽히는데 이 화면이 설명하는 것은 자기장이 아니다.
        for (const id of HELP_DEMO_IDS) {
            const first = frames(id)[0]!;
            const map = mapOf(id);
            expect(first.storm, id).toBeDefined();
            expect(first.storm!.width, id).toBeGreaterThanOrEqual(map.cols * TILE);
            expect(first.storm!.height, id).toBeGreaterThanOrEqual(map.rows * TILE);
        }
    });
});
