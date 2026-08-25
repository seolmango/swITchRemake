/**
 * 게임플레이 수치 중 **클라이언트도 알아야 하는 것들**.
 *
 * 밸런스 값의 대부분은 `server-game/src/config/gameplay.ts`에만 있어야 한다 — 서버가 유일한
 * 권위이고, 클라이언트가 같은 숫자를 들고 있으면 언젠가 갈라진다. 그래서 인게임 HUD는 값을
 * 복사하지 않고 `game.starting`의 `gameplay` payload로 받는다.
 *
 * 그런데 **인게임 밖 화면**은 그 payload를 받을 수 없다. 도움말의 스킬 데모가 그렇다. 데모는
 * "유체화를 쓰면 이만큼 빨라진다"를 눈으로 보여 주는 것이 전부라 실제 속도로 움직여야 하는데,
 * 손으로 찍은 키프레임으로 만들면 밸런스를 고칠 때마다 조용히 거짓말이 된다.
 *
 * 그래서 그런 값만 여기 두고 **서버가 이 파일에서 가져다 쓴다.** 정의는 한 곳뿐이다.
 * 여기에 값을 늘리기 전에 한 번 더 생각할 것 — 서버만 알아도 되는 값이면 서버에 둔다.
 */

/** 타일 한 칸의 세계 좌표 크기. 맵·시야·사거리가 전부 이 단위의 배수다. */
export const TILE_PX = 256;

export const MOVEMENT = Object.freeze({
    /** 레거시 `CharRad = 0.4` 타일. */
    PLAYER_RADIUS_TILES: 0.4,
    /** 레거시 `Speed = 58` milli-tile/tick @ 30Hz. */
    BASE_SPEED_TILES_PER_SEC: 1.74,
});

/**
 * 속도에 영향을 주는 효과와 사거리. 이름은 롤 소환사 주문에서 왔다(유체화/점멸/탈진).
 *
 * 증가군과 감소군이 어떻게 합쳐지는지는 서버의 `currentSpeed`가 정한다:
 * `기본속도 * (1 + 증가합) * max(바닥, 1 - 감소합)`.
 */
export const SKILL_TUNING = Object.freeze({
    /** 증가군에 더해지는 값. 2.0이면 3배. */
    DASH_SPEED_INCREASE: 2.0,
    DASH_DURATION_MS: 1_000,

    FLASH_DISTANCE_TILES: 3,

    /** 감소군에 더해지는 값. 0.4면 0.6배. */
    EXHAUST_SPEED_DECREASE: 0.4,
    EXHAUST_DURATION_MS: 3_000,
    EXHAUST_RANGE_TILES: 4,

    /** 술래와의 거리. 지목 대상까지의 거리는 상관없다. */
    SWITCH_RANGE_TILES: 1.4,

    /** 술래가 된 직후와 스위치를 성공시킨 시전자에게 붙는다. */
    FRENZY_SPEED_INCREASE: 0.1,
    FRENZY_DURATION_MS: 5_000,
});

/** 감소군 바닥. 이게 없으면 효과가 겹칠 때 속도가 0이나 음수가 된다. */
export const SPEED_DECREASE_FLOOR = 0.3;
