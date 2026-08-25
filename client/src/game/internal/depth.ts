/**
 * 렌더 레이어 순서. 순수 상수라 일부러 Phaser를 import하지 않는 파일에 둔다 — 여기 있던
 * `PlayerSprite.ts`는 Phaser를 값으로 끌어오기 때문에, 이 상수 하나 때문에 FX 레이어들이
 * 테스트 환경에서 Phaser 전체를 로드하다 죽었다.
 */
export const DEPTH = {
    mapStatic: 0,
    grass: 1,
    smoke: 2,
    stormFill: 3,
    stormBorder: 4,
    /** 서버 판정 반경을 보여 주는 바닥 표식. 자기장 위에 보이되 플레이어나 순간 효과를 가리지 않는다. */
    trainingPad: 4.2,
    trainingPadIcon: 4.3,
    /** 점멸 궤적보다 아래. 사거리 원이 궤적을 덮으면 어느 쪽이 무슨 스킬인지 안 읽힌다. */
    switchFx: 4.5,
    blinkFx: 5,
    playerBody: 6,
    playerLabel: 6.1,
    playerBars: 8,
    playerEmoji: 9,
} as const;
