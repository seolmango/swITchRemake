/**
 * 시뮬레이션이 보는 세계. **소켓도 Redis도 모른다.**
 *
 * 이 경계가 이 프로젝트에서 제일 중요한 구조적 약속이다. 이유가 셋이다.
 *
 *  1. B(전송)와 C(시뮬레이션)를 동시에 만들 수 있다.
 *  2. 시뮬레이션 단독 결정론 테스트가 가능하다. 입력 배열을 먹이고 tick을 돌려 결과를 비교한다.
 *  3. 리플레이 기록이 붙을 자리가 생긴다. 권위 프레임은 연결과 무관한 단일 상태여야 한다.
 *
 * 여기에 `Connection`이나 `WebSocket`을 import 하고 싶어지는 순간이 오면, 그건 설계가 틀어진
 * 신호다. 필요한 값을 `stepWorld`의 입력으로 받아오는 쪽이 맞다.
 */

import type { EffectType, SkillRejection, TilePhysics, VisibilityActor, VisibilityWorld } from 'shared';
import type { SkillId } from './skills';
import { NETWORK } from '../config/network';

export interface PlayerState {
    /** 방 범위 slot. */
    playerId: number;
    x: number;
    y: number;
    vx: number;
    vy: number;
    facingX: number;
    facingY: number;
    radius: number;
    /** 시야 사각형의 가로 폭(px). 세로는 16:9로 파생된다. */
    sightRange: number;
    colorIndex: number;
    alive: boolean;
    isTagger: boolean;
    /** 연결이 끊긴 동안 입력을 중립으로 둔다. 마지막 방향으로 계속 가면 안 된다. */
    connected: boolean;
    /**
     * 걸려 있는 상태 효과. `magnitude`는 속도 계산식의 증가군/감소군에 더해지는 값이다.
     * 같은 타입은 중첩되지 않고 갱신된다 — 탈진 두 번에 속도가 0이 되면 안 된다.
     */
    effects: Partial<Record<EffectType, { endTick: number; magnitude: number }>>;
    /** 남은 쿨타임(tick). 키는 SkillId다. */
    cooldowns: Record<string, number>;
    /** 2번 슬롯에 넣은 스킬. 1번 슬롯은 스위치 고정이다. */
    loadout: SkillId;
    /** Presentational state carried by snapshots; expiry is deterministic in simulation ticks. */
    emoji: { emojiId: number; expiresAtTick: number } | null;
    /** 경기 결과에 실릴 누적 수치. 소급해서 만들 수 없으므로 경기 중에 세어 둔다. */
    stats: MatchStats;
}

/**
 * 경기 중 누적되는 개인 수치. 등수는 없으므로 순위 관련 필드도 없다.
 * 탈락 tick을 남기는 이유는 생존 시간을 경기 종료 후에 계산할 수 없기 때문이다.
 */
export interface MatchStats {
    tagCount: number;
    taggedCount: number;
    switchTry: number;
    switchSuccess: number;
    eliminatedAtTick: number | null;
}

export function emptyStats(): MatchStats {
    return { tagCount: 0, taggedCount: 0, switchTry: 0, switchSuccess: 0, eliminatedAtTick: null };
}

/** 이번 tick에 확정된 각 플레이어의 입력 의도. 좌표나 속도는 들어 있지 않다. */
export interface ResolvedInput {
    playerId: number;
    moveX: number;
    moveY: number;
    heldActions: number;
    /** 클라이언트 예측 보정용으로 스냅샷에 되돌려 보낼 값. */
    lastProcessedSequence: number;
}

/** MapBuilder가 만든 tick별 변경. `[x, y, physics]`. */
export type MapTimeline = Record<number, readonly (readonly [number, number, TilePhysics])[]>;

export interface WorldMap {
    mapId: string;
    cols: number;
    rows: number;
    tileSize: number;
    /** [row][col]. tick 0에 initial_map을 복사해 만든다. 런타임에서 제자리 수정된다. */
    tiles: TilePhysics[][];
    /** tick당 자기장 inset 증가량(px). inset = tick * barrierSpeed로 O(1) 계산한다. */
    barrierSpeed: number;
    timeline: MapTimeline;
}

export interface World {
    tick: number;
    /** map bundle과 런타임이 같아야 한다. 다르면 같은 timeline이 다른 속도로 재생된다. */
    simulationHz: number;
    map: WorldMap;
    players: PlayerState[];
    storm: { x: number; y: number; width: number; height: number } | null;
    /** 이번 tick에 바뀐 타일. 스냅샷과 리플레이가 소비한다. 매 tick 초기화된다. */
    tileChanges: { x: number; y: number; physics: TilePhysics }[];
    /** 술래가 마지막으로 바뀐 tick. 강제 교체 쿨다운의 기준이다. */
    taggerChangedAtTick: number;
    /**
     * 결정론적 난수. `Math.random()`을 쓰면 리플레이가 같은 경기를 재현하지 못한다.
     * 방 생성 시 seed를 받아 만들고, 상태가 world 안에 있으므로 world를 복제하면 난수열도 복제된다.
     */
    randomState: number;
    nextRandomInt(exclusiveMax: number): number;
}

/**
 * 이번 tick에 발생한, 연결과 무관한 사실들.
 * 전송 계층은 이걸 JSON 이벤트로 바꾸고, 리플레이 레코더는 그대로 기록한다.
 */
export interface WorldEvent {
    kind: 'tagged' | 'eliminated' | 'blinked' | 'skillUsed' | 'skillArea';
    playerId: number;
    by?: number;
    fromX?: number;
    fromY?: number;
    slot?: number;
    /** `skillArea`가 향한 상대. 연출의 색이 이 사람에게서 나온다. 아무에게도 안 닿았으면 없다. */
    targetPlayerId?: number;
    /** `skillArea`를 일으킨 스킬. 클라이언트가 이 값으로 사거리를 고른다. */
    skillId?: string;
}

/**
 * 게임 루프의 11단계에서 나오는 **권위 프레임**. 연결을 모르는 단일 상태다.
 * 12단계 이후가 여기서 연결별 뷰를 파생시킨다. 순서를 뒤집어 "연결을 돌면서 상태를 계산"하면 안 된다.
 */
export interface AuthoritativeFrame {
    tick: number;
    world: World;
    events: WorldEvent[];
    /** Private outcomes consumed by GameSession and never recorded or broadcast. */
    skillRejections: { playerId: number; slot: number; reason: SkillRejection }[];
}

/**
 * 한 tick 진행. 순수 함수는 아니지만(성능을 위해 world를 제자리에서 고친다) **결정론적**이어야 한다.
 * 같은 world와 같은 입력은 항상 같은 결과를 낸다.
 */
export type StepWorld = (world: World, inputs: readonly ResolvedInput[]) => AuthoritativeFrame;

/** mulberry32. 짧고 분포가 충분하며 상태가 32비트 하나라 world에 넣고 복제하기 쉽다. */
function mulberry32(world: World): number {
    world.randomState = (world.randomState + 0x6d2b79f5) | 0;
    let t = world.randomState;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

export interface CreateWorldOptions {
    map: WorldMap;
    players: PlayerState[];
    seed: number;
    simulationHz?: number;
}

export function createWorld(options: CreateWorldOptions): World {
    const world: World = {
        tick: 0,
        simulationHz: options.simulationHz ?? NETWORK.SIMULATION_HZ,
        map: options.map,
        players: options.players,
        storm: null,
        tileChanges: [],
        taggerChangedAtTick: 0,
        randomState: options.seed | 0,
        nextRandomInt(exclusiveMax: number): number {
            if (exclusiveMax <= 0) return 0;
            return Math.floor(mulberry32(this as World) * exclusiveMax);
        },
    };
    return world;
}

/** 시야 코어에 넘길 형태로 변환한다. 코어는 World를 모르고 이 최소 형태만 안다. */
export function toVisibilityWorld(world: World): VisibilityWorld {
    const players: VisibilityActor[] = world.players.map((p) => ({
        playerId: p.playerId,
        x: p.x,
        y: p.y,
        radius: p.radius,
        sightRange: p.sightRange,
        alive: p.alive,
    }));
    return {
        cols: world.map.cols,
        rows: world.map.rows,
        tileSize: world.map.tileSize,
        tiles: world.map.tiles,
        players,
    };
}
