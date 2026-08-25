/**
 * 맵 위의 **마커와 구역**. 타일 격자와는 별개의 레이어다.
 *
 * 왜 `TilePhysics`에 넣지 않는가: 타일 종류는 충돌·시야를 결정하는 값이고 스냅샷의 모든 타일에
 * 바이트로 실린다. 포탈이나 쿨타임 감소처럼 "밟으면 무슨 일이 일어나는" 것들을 거기 섞으면
 * 격자 한 칸이 물리와 규칙 둘을 동시에 뜻하게 되고, 리플레이 파일에 박히는 값까지 넓어진다.
 *
 * 마커는 **물리적 실체가 없다.** 그 자리를 지나가는 것을 막지도, 시야를 가리지도 않는다.
 * 밟았을 때 서버가 무엇을 할지만 정한다.
 *
 * 전달 경로: 마커는 맵 번들에 들어 있고, 클라이언트는 **서버와 같은 번들을 받아 해시를 검증한다**
 * (`client/src/game/mapBundle.ts`). 그래서 별도의 wire 메시지가 필요 없고, 양쪽이 다른 데이터를
 * 볼 수도 없다.
 */

/**
 * 마커 종류.
 *
 * `training.`으로 시작하는 것은 훈련장 전용이다. 나머지는 나중에 일반 경기 맵에도 쓸 수 있다.
 * 서버가 모르는 종류는 **거부한다** — 조용히 무시하면 맵 제작자가 오타를 못 찾는다.
 */
export const MapMarkerKind = {
    /** 밟으면 이동 스킬이 바뀐다. */
    SkillDash: 'skill.dash',
    SkillFlash: 'skill.flash',
    SkillExhaust: 'skill.exhaust',
    /** 밟으면 술래가 된다. 이미 술래면 벗는다. */
    Tagger: 'tagger',
    /** 쿨타임과 효과를 지운다. */
    Reset: 'reset',
    /** 훈련장 추격 구역의 역할을 바꾼다(내가 쫓는가, 쫓기는가). */
    TrainingChaseMode: 'training.chaseMode',

    /**
     * 훈련 표적이 태어나는 자리. 무엇을 하는 표적인지는 종류가 정한다.
     *
     * 구역 안에 있는지로 성격을 추론하지 않는다 — 맵을 조금 옮겼을 때 표적이 조용히 다른 것으로
     * 바뀌면 맵 제작자가 원인을 찾을 수 없다.
     */
    TrainingDummyStill: 'training.dummy.still',
    TrainingDummyPatrol: 'training.dummy.patrol',
    TrainingDummyChase: 'training.dummy.chase',
} as const;
export type MapMarkerKind = (typeof MapMarkerKind)[keyof typeof MapMarkerKind];

export const MAP_MARKER_KINDS: readonly MapMarkerKind[] = Object.values(MapMarkerKind);

export interface MapMarker {
    kind: MapMarkerKind;
    /** 타일 좌표. 세계 좌표로 바꾸는 것은 읽는 쪽이 한다 — 타일 크기는 번들이 들고 있다. */
    x: number;
    y: number;
}

/**
 * 구역 종류. 구역은 사각형이고 타일 좌표로 적는다.
 *
 * 훈련장의 표적은 **자기 구역 안에서만** 움직이고, 플레이어가 그 구역에 들어오기 전까지는
 * 가만히 있는다. 한 화면에 모든 것이 동시에 움직이면 무엇을 보고 있는지 알 수 없다.
 */
export const MapZoneKind = {
    /** 정해진 코스를 도는 표적들이 사는 구역. */
    TrainingCourse: 'training.course',
    /** 술래잡기를 실제로 해 보는 구역. 들어오면 표적이 깨어난다. */
    TrainingChase: 'training.chase',
} as const;
export type MapZoneKind = (typeof MapZoneKind)[keyof typeof MapZoneKind];

export const MAP_ZONE_KINDS: readonly MapZoneKind[] = Object.values(MapZoneKind);

export interface MapZone {
    kind: MapZoneKind;
    /** 왼쪽 위 타일 좌표. */
    x: number;
    y: number;
    /** 타일 단위 크기. */
    width: number;
    height: number;
}

/**
 * 마커 판정 반경(타일). 지나가다 실수로 밟히지 않을 만큼 작고, 노리고 가면 확실히 밟히는 크기다.
 *
 * 클라이언트가 그리는 크기도 이 값이다 — 다르면 "밟았는데 안 밟혔다"가 생긴다.
 */
export const MAP_MARKER_RADIUS_TILES = 0.75;
