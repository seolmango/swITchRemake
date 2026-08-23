/**
 * 바이너리 프로토콜의 고정 상수.
 *
 * 여기 있는 숫자는 전부 wire format의 일부다. 값을 바꾸면 클라이언트와 서버가 동시에 바뀌어야 한다.
 * 추가는 안전하지만 재배치는 안전하지 않다.
 */

/** 레이아웃이 깨지는 변경에만 올린다. 섹션 추가는 length prefix 덕에 버전을 올릴 필요가 없다. */
export const PROTOCOL_VERSION = 2;

/** 스냅샷 헤더 크기: u8 version + u8 flags + u32 tick. */
export const SNAPSHOT_HEADER_BYTES = 6;

/** 섹션 헤더 크기: u8 type + u16 length. */
export const SECTION_HEADER_BYTES = 3;

export const SectionType = {
    Map: 0x01,
    TileChanges: 0x02,
    TileAlphas: 0x03,
    Storm: 0x04,
    Players: 0x05,
    Regions: 0x06,
    Self: 0x07,
    /**
     * 0x08은 폐기됐다. 저빈도 연출 이벤트(점멸 등)는 JSON 메시지로 옮겼다.
     * 재사용하지 않는다. 구버전 서버가 보낸 0x08을 신버전 클라이언트가 조용히 건너뛰어야 한다.
     */
    Roster: 0x09,
} as const;
export type SectionType = (typeof SectionType)[keyof typeof SectionType];

/** 재사용 금지 섹션 번호. 새 섹션을 추가할 때 이 목록을 피한다. */
export const RETIRED_SECTION_TYPES: readonly number[] = [0x08];

export const SnapshotFlags = {
    /** 월드 전체 스냅샷. MAP과 ROSTER를 함께 싣는다. 리플레이의 keyframe이 곧 이 프레임이다. */
    Full: 0x01,
} as const;

/**
 * `obscured`는 보는 사람에 따라 달라지는 값이라 권위 상태가 아니다.
 * 리플레이에 기록하는 권위 프레임에서는 항상 0이고, 재생 시 시야 코어가 다시 채운다.
 *
 * "자기장 밖" 플래그는 없다. 자기장은 서버가 충돌 판정하는 벽이라 바깥은 도달 불가능한 상태다.
 */
export const PlayerFlags = {
    Obscured: 0x01,
    Tagger: 0x02,
    HasEmoji: 0x04,
} as const;

/** 타일 물리 분류. tools/MapBuilder의 `physics` 값과 같다. */
export const TilePhysics = {
    Floor: 0,
    Wall: 1,
    Bush: 2,
    Gas: 3,
} as const;
export type TilePhysics = (typeof TilePhysics)[keyof typeof TilePhysics];

export const EffectType = {
    Dash: 'dash',
    Frenzy: 'frenzy',
    Exhaust: 'exhaust',
} as const;
export type EffectType = (typeof EffectType)[keyof typeof EffectType];

/**
 * 플레이어 레코드 `effectMask`의 비트 순서. wire format의 일부다.
 * 뒤에 추가하는 것은 괜찮고, 순서를 바꾸는 것은 안 된다.
 */
export const EFFECT_BITS: readonly EffectType[] = [EffectType.Dash, EffectType.Frenzy, EffectType.Exhaust];

/** 한 방의 최대 인원. 플레이어 id가 u8이고 시야 bitmask가 1바이트인 근거다. */
export const MAX_PLAYERS_PER_ROOM = 8;
