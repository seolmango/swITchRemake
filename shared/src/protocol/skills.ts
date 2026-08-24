/**
 * 스킬 계약.
 *
 * 무엇이 스킬이고, 어느 슬롯에 무엇이 들어가고, 요청이 왜 거부됐는지는 세 쪽이 모두 같은 값을 봐야 한다 —
 * 클라이언트(선택 UI와 HUD), 인게임 서버(판정), 매칭 서버(로비 상태 중계). 이 정의가 시뮬레이션 안에만
 * 있으면 나머지 둘은 복사본을 갖게 되고, 복사본은 반드시 갈라진다.
 *
 * 실제로 갈라져 있었다. `lobby.setLoadout`이 무조건 거부된 이유가 "shared에 허용 skill 집합이 없다"였다.
 */

export const SkillId = {
    Dash: 'dash',
    Flash: 'flash',
    Exhaust: 'exhaust',
    Switch: 'switch',
} as const;
export type SkillId = (typeof SkillId)[keyof typeof SkillId];

/**
 * 슬롯 번호. `game.useSkill`의 `slot`이 이 값이다.
 *
 * 1번은 스위치로 고정이고 러너만 쓴다(술래는 넘길 술래가 자기 자신이다). 2번이 경기 전에 고르는 자리다.
 * 슬롯을 늘리려면 뒤에 붙인다 — 기존 번호의 의미를 바꾸면 구버전 클라이언트가 엉뚱한 스킬을 쏜다.
 */
export const SkillSlot = {
    Switch: 1,
    Movement: 2,
} as const;
export type SkillSlot = (typeof SkillSlot)[keyof typeof SkillSlot];

/** 2번 슬롯에 넣을 수 있는 것. 스위치는 고를 수 있는 대상이 아니다. */
export const LOADOUT_SKILLS: readonly SkillId[] = [SkillId.Dash, SkillId.Flash, SkillId.Exhaust];

export function isLoadoutSkill(value: string): value is SkillId {
    return (LOADOUT_SKILLS as readonly string[]).includes(value);
}

export function isSkillSlot(value: number): value is SkillSlot {
    return value === SkillSlot.Switch || value === SkillSlot.Movement;
}

/**
 * 스킬 요청이 거부된 이유.
 *
 * 실패해도 쿨타임은 소모된다 — 실패가 공짜면 계속 눌러보는 것이 최적 전략이 되기 때문이다. 그래서
 * **왜 실패했는지를 반드시 사용자에게 보여줘야 한다.** 이유 없이 쿨타임만 사라지면 그건 버그로 읽힌다.
 */
export const SkillRejection = {
    NotAlive: 'NOT_ALIVE',
    /** 그 슬롯이 비어 있다. 술래의 1번 슬롯이 여기 해당한다. */
    NoSkill: 'NO_SKILL',
    OnCooldown: 'ON_COOLDOWN',
    /** 신분이 맞지 않는다. 술래가 스위치를 쓰려는 경우. */
    Role: 'ROLE',
    /** 스위치 전용. 술래에게서 너무 멀다. */
    OutOfRange: 'OUT_OF_RANGE',
    /** 스위치 전용. 지목한 사람이 없거나, 죽었거나, 술래이거나, 자기 자신이다. */
    NoTarget: 'NO_TARGET',
} as const;
export type SkillRejection = (typeof SkillRejection)[keyof typeof SkillRejection];
