import { MAX_PLAYERS_PER_ROOM, SkillId, TilePhysics, TrainingPadKind, type TrainingPad } from 'shared';
import { GAMEPLAY } from '../config/gameplay';
import { msToTicks } from '../simulation/effects';
import type { PlayerState, ResolvedInput, World, WorldMap } from '../simulation/world';
import { emptyStats } from '../simulation/world';
import { grantTaggerFrenzy } from '../simulation/skills';
import type { RosterEntry } from '../game/snapshot-view';

export const TRAINING_DUMMY_RESPAWN_MS = 3_000;

/**
 * 패드 반경. 지나가다 실수로 밟히지 않을 만큼 작고, 노리고 가면 확실히 밟히는 크기다.
 * 클라이언트가 그리는 크기도 이 값이라 "밟았는데 안 밟혔다"가 생기지 않는다.
 */
const PAD_RADIUS_TILES = 0.75;

/**
 * 패드 배치. 맵 비율 기준이라 맵이 달라도 같은 자리에 놓인다.
 *
 * 스킬 셋을 나란히 두는 이유는 갈아 끼우면서 바로 비교해 보라는 것이다. 술래 패드는 조금 떨어뜨려
 * 놓았다 — 스킬을 고르다 실수로 술래가 되면 흐름이 끊긴다.
 */
const PAD_ANCHORS: readonly { kind: TrainingPadKind; at: readonly [number, number] }[] = [
    { kind: TrainingPadKind.SkillDash, at: [0.34, 0.5] },
    { kind: TrainingPadKind.SkillFlash, at: [0.44, 0.5] },
    { kind: TrainingPadKind.SkillExhaust, at: [0.54, 0.5] },
    { kind: TrainingPadKind.Reset, at: [0.64, 0.5] },
    { kind: TrainingPadKind.Tagger, at: [0.5, 0.28] },
];

type Point = readonly [x: number, y: number];
type TilePoint = readonly [x: number, y: number];

interface CourseDefinition {
    readonly nickname: string;
    readonly kind: 'stationary' | 'shuttle' | 'circuit';
    readonly anchors: readonly Point[];
}

interface DummyState {
    readonly player: PlayerState;
    readonly course: readonly TilePoint[];
    readonly kind: CourseDefinition['kind'];
    targetIndex: number;
    respawnAtTick: number | null;
    /**
     * 마지막으로 계산한 경로와 그때의 조건.
     *
     * BFS는 맵 전체를 훑고 타일마다 문자열 키를 만든다. 50x50 맵에서 tick마다 더미 셋이 돌면
     * 초당 수십만 개의 문자열이 생겼다 사라진다 — 이 저장소가 예전에 겪은 GC/메모리 문제와
     * 같은 종류다. 경로는 **서 있는 타일이나 목표가 바뀔 때만** 달라지므로 그때만 다시 푼다.
     */
    cachedRoute: RouteResult | null;
    cachedFromKey: string;
    cachedTargetIndex: number;
}

interface RouteResult {
    readonly tiles: readonly TilePoint[];
    readonly reachedTarget: boolean;
}

const COURSE_DEFINITIONS: readonly CourseDefinition[] = [
    { nickname: '[더미] 고정', kind: 'stationary', anchors: [[0.50, 0.38]] },
    { nickname: '[더미] 왕복', kind: 'shuttle', anchors: [[0.25, 0.68], [0.75, 0.68]] },
    {
        nickname: '[더미] 순환',
        kind: 'circuit',
        anchors: [[0.22, 0.22], [0.78, 0.22], [0.78, 0.78], [0.22, 0.78]],
    },
];

const CARDINAL_DIRECTIONS: readonly TilePoint[] = [[1, 0], [0, 1], [-1, 0], [0, -1]];

function tileKey([x, y]: TilePoint): string {
    return `${x},${y}`;
}

function tileCenter(map: WorldMap, [x, y]: TilePoint): Point {
    return [(x + 0.5) * map.tileSize, (y + 0.5) * map.tileSize];
}

function isWalkable(map: WorldMap, [x, y]: TilePoint): boolean {
    return x >= 0 && y >= 0 && x < map.cols && y < map.rows && map.tiles[y]?.[x] !== TilePhysics.Wall;
}

function desiredTile(map: WorldMap, [x, y]: Point): TilePoint {
    return [
        Math.max(0, Math.min(map.cols - 1, Math.floor(x * map.cols))),
        Math.max(0, Math.min(map.rows - 1, Math.floor(y * map.rows))),
    ];
}

function nearestWalkable(map: WorldMap, desired: TilePoint): TilePoint {
    let best: TilePoint | null = null;
    let bestDistance = Infinity;

    for (let y = 0; y < map.rows; y += 1) {
        for (let x = 0; x < map.cols; x += 1) {
            const candidate: TilePoint = [x, y];
            if (!isWalkable(map, candidate)) continue;
            const distance = Math.abs(x - desired[0]) + Math.abs(y - desired[1]);
            if (distance < bestDistance) {
                best = candidate;
                bestDistance = distance;
            }
        }
    }

    if (best === null) throw new Error('training map has no walkable tile');
    return best;
}

/**
 * 목표 타일이 막혔거나 다른 구역에 있어도 현재 위치에서 갈 수 있는 가장 가까운 타일까지 간다.
 * 탐색 순서와 동률 해소가 고정되어 있어 같은 맵과 상태에서는 항상 같은 방향을 낸다.
 */
function routeToward(map: WorldMap, from: TilePoint, target: TilePoint): RouteResult {
    const start = isWalkable(map, from) ? from : nearestWalkable(map, from);
    const queue: TilePoint[] = [start];
    const previous = new Map<string, TilePoint | null>([[tileKey(start), null]]);
    let head = 0;
    let best = start;
    let bestDistance = Math.abs(start[0] - target[0]) + Math.abs(start[1] - target[1]);

    while (head < queue.length) {
        const current = queue[head++]!;
        const distance = Math.abs(current[0] - target[0]) + Math.abs(current[1] - target[1]);
        if (distance < bestDistance) {
            best = current;
            bestDistance = distance;
        }
        if (distance === 0) {
            best = current;
            break;
        }

        for (const [dx, dy] of CARDINAL_DIRECTIONS) {
            const next: TilePoint = [current[0] + dx, current[1] + dy];
            const key = tileKey(next);
            if (!isWalkable(map, next) || previous.has(key)) continue;
            previous.set(key, current);
            queue.push(next);
        }
    }

    const reversed: TilePoint[] = [];
    for (let cursor: TilePoint | null = best; cursor !== null; cursor = previous.get(tileKey(cursor)) ?? null) {
        reversed.push(cursor);
    }
    return { tiles: reversed.reverse(), reachedTarget: bestDistance === 0 };
}

function resolveCourse(map: WorldMap, definition: CourseDefinition): TilePoint[] {
    const anchors = definition.anchors.map((point) => nearestWalkable(map, desiredTile(map, point)));
    return definition.kind === 'stationary' ? [anchors[0]!] : anchors;
}

function makeDummy(playerId: number, colorIndex: number, map: WorldMap, start: TilePoint): PlayerState {
    const [x, y] = tileCenter(map, start);
    return {
        playerId,
        x,
        y,
        vx: 0,
        vy: 0,
        facingX: 0,
        facingY: 1,
        radius: GAMEPLAY.PLAYER_RADIUS_PX,
        sightRange: GAMEPLAY.SIGHT_RANGE_PX,
        colorIndex,
        alive: true,
        isTagger: false,
        connected: true,
        effects: {},
        cooldowns: {},
        loadout: SkillId.Dash,
        emoji: null,
        stats: emptyStats(),
    };
}

/** 훈련 입력과 부활만 맡는다. 로비 명단이나 연결 수명 주기에는 참여하지 않는다. */
export class TrainingGround {
    readonly players: readonly PlayerState[];
    readonly roster: readonly RosterEntry[];
    readonly #states: readonly DummyState[];
    readonly #dummyIds: ReadonlySet<number>;
    readonly pads: readonly TrainingPad[];
    /** 지금 밟고 있는 패드. 서 있는 동안 매 tick 발동하면 스킬이 계속 바뀐다. */
    readonly #standingOn = new Map<number, TrainingPadKind>();

    public constructor(map: WorldMap, occupiedPlayerIds: readonly number[]) {
        const availableIds = Array.from({ length: MAX_PLAYERS_PER_ROOM }, (_, index) => index + 1)
            .filter((playerId) => !occupiedPlayerIds.includes(playerId));

        // 세 개면 혼자 연습할 때 화면을 과하게 채우지 않으면서 고정 사거리, 1차원 추적, 2차원 회전을
        // 각각 한 표적으로 익힐 수 있다. 훈련장 정원이 1명이므로 프로토콜의 8개 id 안에도 여유가 있다.
        if (availableIds.length < COURSE_DEFINITIONS.length) throw new Error('not enough player ids for training dummies');

        const states = COURSE_DEFINITIONS.map((definition, index): DummyState => {
            const course = resolveCourse(map, definition);
            const playerId = availableIds[index]!;
            return {
                player: makeDummy(playerId, playerId - 1, map, course[0]!),
                course,
                kind: definition.kind,
                targetIndex: definition.kind === 'stationary' ? 0 : 1,
                respawnAtTick: null,
                cachedRoute: null,
                cachedFromKey: '',
                cachedTargetIndex: -1,
            };
        });

        this.#states = states;
        this.players = states.map((state) => state.player);
        this.roster = states.map((state, index) => ({
            playerId: state.player.playerId,
            nickname: COURSE_DEFINITIONS[index]!.nickname,
        }));
        this.#dummyIds = new Set(this.players.map((player) => player.playerId));
        const radius = PAD_RADIUS_TILES * map.tileSize;
        this.pads = PAD_ANCHORS.map(({ kind, at }) => {
            const [x, y] = tileCenter(map, nearestWalkable(map, desiredTile(map, at)));
            return { kind, x, y, radius };
        });
    }

    public isDummy(playerId: number): boolean {
        return this.#dummyIds.has(playerId);
    }

    public resolveInputs(world: World): ResolvedInput[] {
        this.#respawnDue(world);
        return this.#states.flatMap((state) => {
            if (!state.player.alive) return [];
            if (state.kind === 'stationary') return [this.#input(state.player.playerId, 0, 0)];
            return [this.#follow(world, state)];
        });
    }

    /**
     * 패드 판정. 사람에게만 적용한다 — 표적이 코스를 돌다 스킬 패드를 밟으면 표적의 성격이 바뀐다.
     *
     * **밟는 순간에만** 발동한다. 서 있는 동안 매 tick 발동하면 스킬이 계속 바뀌어서 고를 수가 없다.
     */
    #applyPads(world: World): void {
        for (const player of world.players) {
            if (!player.alive || this.isDummy(player.playerId)) continue;
            const pad = this.pads.find((candidate) => {
                const dx = candidate.x - player.x;
                const dy = candidate.y - player.y;
                return dx * dx + dy * dy <= candidate.radius * candidate.radius;
            });
            const previous = this.#standingOn.get(player.playerId);
            if (pad === undefined) {
                this.#standingOn.delete(player.playerId);
                continue;
            }
            this.#standingOn.set(player.playerId, pad.kind);
            if (previous === pad.kind) continue;
            this.#trigger(world, player, pad.kind);
        }
    }

    #trigger(world: World, player: PlayerState, kind: TrainingPadKind): void {
        switch (kind) {
            case TrainingPadKind.SkillDash: player.loadout = SkillId.Dash; break;
            case TrainingPadKind.SkillFlash: player.loadout = SkillId.Flash; break;
            case TrainingPadKind.SkillExhaust: player.loadout = SkillId.Exhaust; break;
            case TrainingPadKind.Tagger: {
                // 술래를 벗을 때 아무도 술래가 아닌 상태가 된다. 훈련장은 그래도 된다 —
                // 경기가 아니라 실험실이고, 술래 없는 상태의 움직임도 볼 수 있어야 한다.
                const becoming = !player.isTagger;
                for (const other of world.players) other.isTagger = false;
                player.isTagger = becoming;
                if (becoming) grantTaggerFrenzy(world, player);
                world.taggerChangedAtTick = world.tick;
                break;
            }
            case TrainingPadKind.Reset:
                // 쿨타임과 효과를 지운다. 같은 것을 반복해서 시험하려면 기다릴 필요가 없어야 한다.
                for (const key of Object.keys(player.cooldowns)) delete player.cooldowns[key];
                for (const key of Object.keys(player.effects)) {
                    delete player.effects[key as keyof typeof player.effects];
                }
                break;
        }
    }

    /** 죽은 사람을 코스가 아닌 자기 자리에서 되살린다. 훈련장에는 탈락이 없다. */
    public respawn(world: World, playerId: number): boolean {
        const player = world.players.find((p) => p.playerId === playerId);
        if (player === undefined || this.isDummy(playerId) || player.alive) return false;
        const [x, y] = tileCenter(world.map, nearestWalkable(world.map, desiredTile(world.map, [0.5, 0.62])));
        player.x = x;
        player.y = y;
        player.vx = 0;
        player.vy = 0;
        player.alive = true;
        player.isTagger = false;
        player.stats.eliminatedAtTick = null;
        for (const key of Object.keys(player.cooldowns)) delete player.cooldowns[key];
        for (const key of Object.keys(player.effects)) {
            delete player.effects[key as keyof typeof player.effects];
        }
        return true;
    }

    public afterStep(world: World): void {
        this.#applyPads(world);
        const delayTicks = msToTicks(TRAINING_DUMMY_RESPAWN_MS, world.simulationHz);
        for (const state of this.#states) {
            if (!state.player.alive && state.respawnAtTick === null) {
                // 처치 피드백을 볼 시간은 주되 표적 셋이 오래 비지 않도록 3초만 기다린다.
                state.respawnAtTick = world.tick + delayTicks;
            }
        }
    }

    /**
     * 서 있는 타일과 목표가 그대로면 지난 경로를 다시 쓴다. 다만 다음 걸음이 벽이 되었으면
     * (맵 timeline이 벽을 세울 수 있다) 캐시를 버리고 다시 푼다.
     */
    #routeFor(world: World, state: DummyState, targetTile: TilePoint): RouteResult {
        const from = this.#tileOf(world.map, state.player);
        const fromKey = tileKey(from);
        const cached = state.cachedRoute;
        const stepBlocked = cached !== null
            && cached.tiles[1] !== undefined
            && !isWalkable(world.map, cached.tiles[1]);
        if (cached !== null && !stepBlocked
            && state.cachedFromKey === fromKey && state.cachedTargetIndex === state.targetIndex) {
            return cached;
        }
        const route = routeToward(world.map, from, targetTile);
        state.cachedRoute = route;
        state.cachedFromKey = fromKey;
        state.cachedTargetIndex = state.targetIndex;
        return route;
    }

    #follow(world: World, state: DummyState): ResolvedInput {
        // 한 tick 이동량보다는 넓어 목표를 지나쳐 진동하지 않고, 타일 여유 폭보다는 좁아 모서리를 자르지 않는다.
        const arrivalRadius = Math.min(world.map.tileSize / 16, GAMEPLAY.PLAYER_RADIUS_PX / 6);
        let targetTile = state.course[state.targetIndex]!;
        let route = this.#routeFor(world, state, targetTile);
        let routeEndPoint = tileCenter(world.map, route.tiles.at(-1)!);

        if (Math.hypot(state.player.x - routeEndPoint[0], state.player.y - routeEndPoint[1]) <= arrivalRadius) {
            state.targetIndex = (state.targetIndex + 1) % state.course.length;
            targetTile = state.course[state.targetIndex]!;
            route = this.#routeFor(world, state, targetTile);
            routeEndPoint = tileCenter(world.map, route.tiles.at(-1)!);
        }

        // 밀리거나 timeline으로 길이 바뀌면 현재 타일에서 다시 탐색한다. 길이 없을 때도 가장 가까운
        // 도달 가능 타일을 향하므로 벽 앞에서 좌표를 덮어쓰거나 원래 속도로 미끄러지지 않는다.
        const nextTile = route.tiles[1];
        const target = nextTile !== undefined
            ? tileCenter(world.map, nextTile)
            : route.reachedTarget ? tileCenter(world.map, targetTile) : routeEndPoint;
        const dx = target[0] - state.player.x;
        const dy = target[1] - state.player.y;
        const length = Math.hypot(dx, dy);
        if (length === 0) return this.#input(state.player.playerId, 0, 0);
        return this.#input(state.player.playerId, dx / length, dy / length);
    }

    #respawnDue(world: World): void {
        for (const state of this.#states) {
            if (state.respawnAtTick === null || world.tick < state.respawnAtTick) continue;
            const [x, y] = tileCenter(world.map, state.course[0]!);
            state.player.x = x;
            state.player.y = y;
            state.cachedRoute = null;
            state.player.vx = 0;
            state.player.vy = 0;
            state.player.facingX = 0;
            state.player.facingY = 1;
            state.player.alive = true;
            state.player.isTagger = false;
            state.player.effects = {};
            state.player.cooldowns = {};
            state.player.emoji = null;
            state.player.stats.eliminatedAtTick = null;
            state.targetIndex = state.kind === 'stationary' ? 0 : 1;
            state.respawnAtTick = null;
        }
    }

    #tileOf(map: WorldMap, player: PlayerState): TilePoint {
        return [Math.floor(player.x / map.tileSize), Math.floor(player.y / map.tileSize)];
    }

    #input(playerId: number, moveX: number, moveY: number): ResolvedInput {
        return { playerId, moveX, moveY, heldActions: 0, lastProcessedSequence: 0 };
    }
}
