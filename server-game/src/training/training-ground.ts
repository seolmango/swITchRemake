import {
    MAX_PLAYERS_PER_ROOM,
    MapMarkerKind,
    MapZoneKind,
    SkillId,
    SkillSlot,
    TilePhysics,
    TrainingPadKind,
    trainingPadsFromMarkers,
    type MapZone,
    type TrainingPad,
} from 'shared';
import { GAMEPLAY, SKILLS } from '../config/gameplay';
import { isReady, msToTicks } from '../simulation/effects';
import type { PlayerState, ResolvedInput, World, WorldMap } from '../simulation/world';
import { emptyStats } from '../simulation/world';
import { grantTaggerFrenzy, type SkillRequest } from '../simulation/skills';
import { isPositionFree } from '../simulation/static-collision';
import { stormRect } from '../simulation/storm';
import type { RosterEntry } from '../game/snapshot-view';

export const TRAINING_DUMMY_RESPAWN_MS = 3_000;

/** 표적이 유체화를 쓸 최소 거리(타일). 코앞에서 쓰면 쿨타임만 버린다. */
const BOT_DASH_MIN_TILES = 4;

/** 구역 안에서 표적이 돌 네 귀퉁이. 구역을 벗어나지 않는 것이 이 함수의 유일한 책임이다. */
function patrolCourse(map: WorldMap, home: TilePoint, zone: MapZone | null): TilePoint[] {
    if (zone === null) return [home];
    const inset = 1;
    const left = zone.x + inset;
    const top = zone.y + inset;
    const right = zone.x + zone.width - 1 - inset;
    const bottom = zone.y + zone.height - 1 - inset;
    if (right <= left || bottom <= top) return [home];
    const corners: TilePoint[] = [[left, top], [right, top], [right, bottom], [left, bottom]];
    return [home, ...corners.map((corner) => nearestWalkable(map, corner))];
}

function zoneContaining(map: WorldMap, x: number, y: number, role: DummyRole): MapZone | null {
    const wanted = role === 'chase' ? MapZoneKind.TrainingChase : MapZoneKind.TrainingCourse;
    return map.zones.find((zone) => zone.kind === wanted
        && x >= zone.x && x < zone.x + zone.width
        && y >= zone.y && y < zone.y + zone.height) ?? null;
}

function insideZone(zone: MapZone, tileSize: number, x: number, y: number): boolean {
    return x >= zone.x * tileSize && x < (zone.x + zone.width) * tileSize
        && y >= zone.y * tileSize && y < (zone.y + zone.height) * tileSize;
}

type Point = readonly [x: number, y: number];
type TilePoint = readonly [x: number, y: number];

type DummyRole = 'still' | 'patrol' | 'chase';

interface DummyState {
    readonly player: PlayerState;
    readonly course: readonly TilePoint[];
    readonly kind: DummyRole;
    /** 이 표적이 사는 구역. 없으면 맵 전체가 아니라 **제자리**다 — 표적은 구역 밖으로 안 나간다. */
    readonly zone: MapZone | null;
    /** 태어난 자리. 구역을 떠났거나 초기화될 때 여기로 돌아온다. */
    readonly home: TilePoint;
    targetIndex: number;
    respawnAtTick: number | null;
    /** 추격 경로 캐시의 목표 타일. 순찰(`cachedTargetIndex`)과 조건이 달라 따로 둔다. */
    cachedChaseTargetKey: string | null;
    /**
     * 점멸을 쓰기로 정하고 목표 쪽으로 몸을 돌린 tick. 아직 안 정했으면 null이다.
     *
     * 스킬은 이동보다 먼저 판정되므로(`step.ts`), 점멸이 보는 `facing`은 **지난 tick** 입력이
     * 만든 값이다. 길찾기로 벽을 돌아가던 중에 그대로 쏘면 경로 방향으로 튄다 — 실제로 벽을
     * 북쪽으로 돌아가던 표적이 북쪽으로 점멸해 구역 밖으로 나가 버렸다.
     *
     * 그래서 정한 tick에는 사람 쪽으로 몸만 돌리고(`#hunt`), **다음** tick에 쏜다. 덤으로
     * 사람에게 예고가 된다 — 벽 너머에서 표적이 이쪽을 홱 돌아보고 나서 넘어온다.
     */
    flashAimedAtTick: number | null;
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

/**
 * `from`에서 `to`까지 몸이 그대로 지나갈 수 있는가.
 *
 * 중심선만 보면 몸통보다 좁은 틈을 통과할 수 있다고 판단한다(플레이어 반지름 102px, 타일 256px).
 * 그래서 중심선과 함께 진행 방향의 **양옆 반지름만큼 밀린 두 선**도 같이 훑는다 — 원을 끌고 간
 * 자리를 세 줄로 근사하는 것이다.
 *
 * 표본 간격은 반지름의 절반이다. 이보다 성기면 타일 모서리를 건너뛴다.
 */
function hasClearPath(map: WorldMap, from: Point, to: Point, radius: number): boolean {
    const dx = to[0] - from[0];
    const dy = to[1] - from[1];
    const distance = Math.hypot(dx, dy);
    if (distance === 0) return true;

    const stepCount = Math.max(1, Math.ceil(distance / (radius / 2)));
    // 진행 방향에 수직인 단위 벡터.
    const sideX = -dy / distance;
    const sideY = dx / distance;

    for (const offset of [0, radius, -radius]) {
        for (let step = 0; step <= stepCount; step += 1) {
            const t = step / stepCount;
            const x = from[0] + dx * t + sideX * offset;
            const y = from[1] + dy * t + sideY * offset;
            const tile: TilePoint = [Math.floor(x / map.tileSize), Math.floor(y / map.tileSize)];
            if (!isWalkable(map, tile)) return false;
        }
    }
    return true;
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

/**
 * 추격 표적이 드는 이동기.
 *
 * 번갈아 준다. 셋 다 점멸이면 벽이 의미가 없어지고 셋 다 유체화면 벽이 안전지대가 된다.
 * 사람이 두 가지 압박을 다 겪어 봐야 연습이 된다.
 */
function chaseLoadout(index: number): SkillId {
    return index % 2 === 0 ? SkillId.Flash : SkillId.Dash;
}

function makeDummy(playerId: number, colorIndex: number, map: WorldMap, start: TilePoint, loadout: SkillId = SkillId.Dash): PlayerState {
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
        loadout,
        emoji: null,
        stats: emptyStats(),
    };
}

/** 훈련 입력과 부활만 맡는다. 로비 명단이나 연결 수명 주기에는 참여하지 않는다. */
/** 추격 구역의 역할. 마커를 밟으면 뒤집힌다. */
export const ChaseMode = {
    /** 내가 술래다. 표적을 쫓아 잡는 연습. */
    PlayerHunts: 'hunt',
    /** 표적이 술래다. 쫓기면서 도망치고 스위치로 떠넘기는 연습. */
    PlayerFlees: 'flee',
} as const;
export type ChaseMode = (typeof ChaseMode)[keyof typeof ChaseMode];

const DUMMY_ROLE_BY_MARKER: Readonly<Record<string, DummyRole>> = {
    [MapMarkerKind.TrainingDummyStill]: 'still',
    [MapMarkerKind.TrainingDummyPatrol]: 'patrol',
    [MapMarkerKind.TrainingDummyChase]: 'chase',
};

const ROLE_NICKNAME: Readonly<Record<DummyRole, string>> = {
    still: '[표적] 정지',
    patrol: '[표적] 순찰',
    chase: '[표적] 추격',
};

export class TrainingGround {
    readonly players: readonly PlayerState[];
    readonly roster: readonly RosterEntry[];
    readonly #states: readonly DummyState[];
    readonly #dummyIds: ReadonlySet<number>;
    readonly pads: readonly TrainingPad[];
    /** 지금 밟고 있는 패드. 서 있는 동안 매 tick 발동하면 스킬이 계속 바뀐다. */
    readonly #standingOn = new Map<number, TrainingPadKind>();
    #chaseMode: ChaseMode = ChaseMode.PlayerHunts;
    /** 추격 구역이 지금 깨어 있는가. 사람이 들어와야 표적이 움직인다. */
    #chaseActive = false;

    public constructor(map: WorldMap, occupiedPlayerIds: readonly number[]) {
        const availableIds = Array.from({ length: MAX_PLAYERS_PER_ROOM }, (_, index) => index + 1)
            .filter((playerId) => !occupiedPlayerIds.includes(playerId));

        // 표적 자리는 **맵이 정한다.** 구역 안에 있는지로 성격을 추론하지 않는다 —
        // 맵을 조금 옮겼을 때 표적이 조용히 다른 것으로 바뀌면 원인을 찾을 수 없다.
        // playerId는 1..8이고(시야 bitmask가 1바이트다) 사람이 쓰는 자리를 뺀 만큼만 남는다.
        // 맵이 더 요구하면 **앞에서부터 자른다.** 여기서 던지면 맵 하나 때문에 서버가 죽는다.
        const spawns = map.markers
            .filter((marker) => marker.kind in DUMMY_ROLE_BY_MARKER)
            .slice(0, availableIds.length);

        const states = spawns.map((marker, index): DummyState => {
            const role = DUMMY_ROLE_BY_MARKER[marker.kind]!;
            const home: TilePoint = [marker.x, marker.y];
            const zone = zoneContaining(map, marker.x, marker.y, role);
            const playerId = availableIds[index]!;
            return {
                player: makeDummy(playerId, playerId - 1, map, home, role === 'chase' ? chaseLoadout(index) : SkillId.Dash),
                course: role === 'still' ? [home] : patrolCourse(map, home, zone),
                kind: role,
                zone,
                home,
                // 구역이 좁으면 코스가 집 한 곳뿐이다. 그때 1을 넣으면 없는 목표를 가리킨다.
                targetIndex: role === 'still' ? 0 : (patrolCourse(map, home, zone).length > 1 ? 1 : 0),
                cachedChaseTargetKey: null,
                flashAimedAtTick: null,
                respawnAtTick: null,
                cachedRoute: null,
                cachedFromKey: '',
                cachedTargetIndex: -1,
            };
        });

        this.#states = states;
        this.players = states.map((state) => state.player);
        this.roster = states.map((state) => ({
            playerId: state.player.playerId,
            nickname: ROLE_NICKNAME[state.kind],
        }));
        this.#dummyIds = new Set(this.players.map((player) => player.playerId));

        this.pads = trainingPadsFromMarkers(map.markers, map.tileSize);
    }

    public get chaseMode(): ChaseMode {
        return this.#chaseMode;
    }

    public isDummy(playerId: number): boolean {
        return this.#dummyIds.has(playerId);
    }

    public resolveInputs(world: World): ResolvedInput[] {
        this.#respawnDue(world);
        this.#updateChaseZone(world);
        return this.#states.flatMap((state) => {
            if (!state.player.alive) return [];
            if (state.kind === 'still') return [this.#input(state.player.playerId, 0, 0)];
            // 추격 표적은 사람이 구역에 들어오기 전까지 가만히 있는다. 한 화면에서 모든 것이
            // 동시에 움직이면 무엇을 보고 있는지 알 수 없다.
            if (state.kind === 'chase' && !this.#chaseActive) return [this.#input(state.player.playerId, 0, 0)];
            if (state.kind === 'chase' && state.player.isTagger) return [this.#hunt(world, state)];
            return [this.#follow(world, state)];
        });
    }

    /**
     * 표적이 이번 tick에 쓸 스킬.
     *
     * 입력과 나눠 두는 이유는 시뮬레이션이 둘을 다른 단계에서 처리하기 때문이다 — 스킬이 먼저,
     * 이동이 나중이다(`step.ts`). 한 함수가 둘 다 만들면 그 순서를 여기서 흉내 내야 한다.
     *
     * 무작위는 쓰지 않는다. 표적의 판단이 world 상태만 보고 정해져야 리플레이가 같은 경기를
     * 재현한다.
     */
    public resolveSkills(world: World): SkillRequest[] {
        if (!this.#chaseActive) return [];
        const target = this.#prey(world);
        if (target === null) return [];

        return this.#states.flatMap((state) => {
            if (state.kind !== 'chase' || !state.player.alive || !state.player.isTagger) return [];
            if (!this.#chooseSkill(world, state, target)) return [];
            return [{ playerId: state.player.playerId, slot: SkillSlot.Movement }];
        });
    }

    /**
     * 표적이 지금 이동기를 쓸 만한가.
     *
     * 점멸은 **벽을 넘을 때만** 쓴다. 뚫린 길에서 점멸하면 3칸 앞으로 가는 것뿐이라 유체화보다
     * 못하고, 무엇보다 사람이 "왜 저기서 썼지"라고 느낀다. 벽 너머로 넘어올 때만 써야 무섭다.
     *
     * 유체화는 반대로 **뚫린 길에서 멀 때** 쓴다. 코앞에서 쓰면 이미 잡힐 사람이 잡히는 것뿐이고
     * 쿨타임만 버린다.
     */
    #chooseSkill(world: World, state: DummyState, target: PlayerState): boolean {
        const self = state.player;
        if (!isReady(self, self.loadout)) return false;

        if (self.loadout === SkillId.Flash) {
            // 조준한 **다음** tick에 쏜다. 그래야 facing이 사람 쪽을 가리킨다.
            if (state.flashAimedAtTick === null || world.tick <= state.flashAimedAtTick) return false;
            state.flashAimedAtTick = null;
            return true;
        }

        if (self.loadout === SkillId.Dash) {
            const distance = Math.hypot(target.x - self.x, target.y - self.y);
            return hasClearPath(world.map, [self.x, self.y], [target.x, target.y], self.radius)
                && distance > world.map.tileSize * BOT_DASH_MIN_TILES;
        }
        return false;
    }

    /**
     * 지금 점멸을 쓸 만한가. **벽을 넘을 때만** 쓴다.
     *
     * 뚫린 길에서 점멸하면 3칸 앞으로 가는 것뿐이라 유체화보다 못하고, 무엇보다 사람이
     * "왜 저기서 썼지"라고 느낀다. 벽 너머로 넘어올 때만 써야 무섭다.
     */
    #wantsFlash(world: World, state: DummyState, target: PlayerState): boolean {
        const self = state.player;
        return self.loadout === SkillId.Flash
            && isReady(self, SkillId.Flash)
            && this.#flashGainsGround(world, self, target);
    }

    /**
     * 사람 쪽으로 점멸했을 때 실제로 가까워지는가.
     *
     * 착지점이 벽 안이면 `useFlash`가 진행 방향으로 더 밀어 보지만, 여기서는 그 보정을 따라
     * 하지 않는다. 확실히 이득일 때만 쓰는 편이 낫다 — 애매할 때 써서 벽에 붙어 버리면 쿨타임만
     * 날리고 추격이 끊긴다.
     */
    #flashGainsGround(world: World, self: PlayerState, target: PlayerState): boolean {
        const dx = target.x - self.x;
        const dy = target.y - self.y;
        const distance = Math.hypot(dx, dy);
        if (distance === 0) return false;

        const landingX = self.x + (dx / distance) * SKILLS.FLASH.DISTANCE_PX;
        const landingY = self.y + (dy / distance) * SKILLS.FLASH.DISTANCE_PX;
        if (!isPositionFree(world.map, landingX, landingY, self.radius, stormRect(world))) return false;

        // 착지하고도 여전히 벽 너머라면 넘은 것이 아니다.
        if (!hasClearPath(world.map, [landingX, landingY], [target.x, target.y], self.radius)) return false;
        return Math.hypot(target.x - landingX, target.y - landingY) < distance;
    }

    /**
     * 추격 구역의 깨어남과 역할 배정.
     *
     * 사람이 구역 안에 있으면 깨어나고, 나가면 표적이 제자리로 돌아가 다시 잠든다. 연습을 중간에
     * 그만두고 나왔을 때 표적이 구역 밖까지 따라 나오면 다른 연습을 할 수가 없다.
     */
    #updateChaseZone(world: World): void {
        const zone = this.#states.find((state) => state.kind === 'chase')?.zone ?? null;
        if (zone === null) return;
        const humans = world.players.filter((player) => player.alive && !this.isDummy(player.playerId));
        const inside = humans.filter((player) => insideZone(zone, world.map.tileSize, player.x, player.y));

        if (inside.length === 0) {
            if (this.#chaseActive) this.#resetChase(world);
            return;
        }
        if (this.#chaseActive) {
            // 사람이 스위치로 술래를 넘겼거나 잡혔다. 두 경우 다 연습 한 판이 끝난 것이라 되돌린다.
            const expectedTagger = this.#chaseMode === ChaseMode.PlayerFlees;
            const dummyIsTagger = this.#states.some((state) => state.kind === 'chase' && state.player.isTagger);
            if (expectedTagger !== dummyIsTagger) this.#resetChase(world);
            return;
        }

        this.#chaseActive = true;
        if (this.#chaseMode === ChaseMode.PlayerHunts) {
            // 내가 술래다. 표적은 코스를 돌고 나는 쫓는다.
            for (const player of world.players) player.isTagger = false;
            const self = inside[0]!;
            self.isTagger = true;
            grantTaggerFrenzy(world, self);
        } else {
            // 표적이 술래다. 가장 가까운 것 하나만 술래로 만든다 — 셋이 동시에 달려들면 연습이 아니다.
            const chasers = this.#states.filter((state) => state.kind === 'chase' && state.player.alive);
            const self = inside[0]!;
            let nearest = chasers[0] ?? null;
            let best = Infinity;
            for (const candidate of chasers) {
                const distance = Math.hypot(candidate.player.x - self.x, candidate.player.y - self.y);
                if (distance < best) { best = distance; nearest = candidate; }
            }
            for (const player of world.players) player.isTagger = false;
            if (nearest !== null) {
                nearest.player.isTagger = true;
                grantTaggerFrenzy(world, nearest.player);
            }
        }
        world.taggerChangedAtTick = world.tick;
    }

    /** 표적을 집으로 돌려보내고 술래 역할을 지운다. */
    #resetChase(world: World): void {
        this.#chaseActive = false;
        for (const state of this.#states) {
            if (state.kind !== 'chase') continue;
            state.player.isTagger = false;
            this.#sendHome(world, state);
        }
        world.taggerChangedAtTick = world.tick;
    }

    #sendHome(world: World, state: DummyState): void {
        const [x, y] = tileCenter(world.map, state.home);
        state.player.x = x;
        state.player.y = y;
        state.player.vx = 0;
        state.player.vy = 0;
        state.player.alive = true;
        state.player.stats.eliminatedAtTick = null;
        state.targetIndex = state.course.length > 1 ? 1 : 0;
        state.cachedRoute = null;
        state.respawnAtTick = null;
        for (const key of Object.keys(state.player.effects)) {
            delete state.player.effects[key as keyof typeof state.player.effects];
        }
    }

    /**
/**
     * 술래가 된 표적의 추격.
     *
     * 몸이 지나갈 길이 뚫려 있으면 직진한다. 그게 사람이 하는 짓이고, 타일 격자를 따라가지
     * 않으므로 움직임이 각지지 않는다. 막혀 있을 때만 길찾기로 돌아간다.
     *
     * 예전에는 항상 직진이었다. 벽 하나에 걸려 제자리에서 비비는 봇은 무섭지도 않고 연습도
     * 안 된다 — 추격 구역이 사실상 놀고 있었다.
     */
    #hunt(world: World, state: DummyState): ResolvedInput {
        const target = this.#prey(world);
        if (target === null) {
            state.flashAimedAtTick = null;
            return this.#input(state.player.playerId, 0, 0);
        }

        const self = state.player;
        if (hasClearPath(world.map, [self.x, self.y], [target.x, target.y], self.radius)) {
            state.cachedRoute = null;
            state.flashAimedAtTick = null;
            return this.#steerTo(state, target.x, target.y);
        }

        // 점멸 판단을 여기서 한다. 몸을 돌리는 것이 곧 조준이고, 방향은 입력으로만 바뀐다.
        if (this.#wantsFlash(world, state, target)) {
            state.flashAimedAtTick ??= world.tick;
            return this.#steerTo(state, target.x, target.y);
        }
        state.flashAimedAtTick = null;

        const route = this.#routeTo(world, state, this.#tileOf(world.map, target));
        const nextTile = route.tiles[1];
        const [x, y] = nextTile !== undefined
            ? tileCenter(world.map, nextTile)
            : [target.x, target.y];
        return this.#steerTo(state, x, y);
    }

    /** 표적이 쫓는 대상. 표적끼리는 쫓지 않는다. */
    #prey(world: World): PlayerState | null {
        return world.players.find((player) => player.alive && !this.isDummy(player.playerId)) ?? null;
    }

    #steerTo(state: DummyState, x: number, y: number): ResolvedInput {
        const dx = x - state.player.x;
        const dy = y - state.player.y;
        const length = Math.hypot(dx, dy);
        if (length === 0) return this.#input(state.player.playerId, 0, 0);
        return this.#input(state.player.playerId, dx / length, dy / length);
    }

    /**
     * 움직이는 목표를 향한 경로. 순찰용 `#routeFor`와 캐시 조건이 다르다.
     *
     * 순찰은 목표가 코스 인덱스로 고정돼 있어 그것만 비교하면 되지만, 추격은 목표가 매 tick
     * 움직인다. 그래서 **목표 타일**을 캐시 키에 넣는다 — 사람이 같은 타일 안에서 움직이는
     * 동안은 다시 풀지 않는다.
     */
    #routeTo(world: World, state: DummyState, targetTile: TilePoint): RouteResult {
        const from = this.#tileOf(world.map, state.player);
        const fromKey = tileKey(from);
        const targetKey = tileKey(targetTile);
        const cached = state.cachedRoute;
        const stepBlocked = cached !== null
            && cached.tiles[1] !== undefined
            && !isWalkable(world.map, cached.tiles[1]);
        if (cached !== null && !stepBlocked
            && state.cachedFromKey === fromKey && state.cachedChaseTargetKey === targetKey) {
            return cached;
        }
        const route = routeToward(world.map, from, targetTile);
        state.cachedRoute = route;
        state.cachedFromKey = fromKey;
        state.cachedChaseTargetKey = targetKey;
        // 순찰 캐시와 섞이지 않게 코스 인덱스 조건은 무효로 둔다.
        state.cachedTargetIndex = -1;
        return route;
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
            case TrainingPadKind.ChaseMode:
                // 구역 밖에서만 밟히는 자리에 둔다. 연습 중에 역할이 뒤집히면 무엇을 하던 중인지 잃는다.
                this.#chaseMode = this.#chaseMode === ChaseMode.PlayerHunts
                    ? ChaseMode.PlayerFlees
                    : ChaseMode.PlayerHunts;
                this.#resetChase(world);
                break;
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
            state.targetIndex = state.kind === 'still' ? 0 : 1;
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
