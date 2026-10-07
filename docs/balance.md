# 밸런스 시트

<!-- npm run balance:release가 생성한다. 손으로 고치지 않는다. -->

규칙 버전 **0.5.0** (2026-10-07). 바꾸는 법은 [CONTRIBUTING.md](../CONTRIBUTING.md#밸런스-바꾸기), 지난 변경은 [CHANGELOG.md](../CHANGELOG.md).

## 지켜야 하는 관계

| 관계 | 지금 값 |
| --- | --- |
| ✓ 유체화가 같은 시간에 점멸보다 멀리 간다 | 유체화 추가 이동 4.35타일 vs 점멸 3타일 |
| ✓ 쿨타임은 점멸 < 유체화 < 탈진 | 점멸 12000 / 유체화 16000 / 탈진 22000 ms |
| ✓ 탈진의 자기 감속은 남에게 거는 것보다 짧고 얕다 | 자기 0.1·3000ms vs 남 0.25·5000ms |
| ✓ 감속 바닥은 0과 1 사이(효과가 겹쳐도 속도가 0이 되지 않는다) | 바닥 0.3 |
| ✓ 최소 3명, 최대 8명이고 승리 인원은 시작 인원보다 적다 | 시작 3~8명, 승리 2명 이하 |
| ✓ 근접 쿨감은 0보다 크다(도망자가 술래 곁에 머물 이유) | 보너스 0.5, 반경 6타일 |
| ✓ 스위치는 붙어야 쓸 수 있다(사거리가 시야보다 훨씬 짧다) | 스위치 사거리 1.4타일, 시야 폭 16타일 |

## 이동

`shared/src/protocol/tuning.ts`의 `MOVEMENT`

| 값 | |
| --- | --- |
| `BASE_SPEED_TILES_PER_SEC` | 1.74 |
| `PLAYER_RADIUS_TILES` | 0.4 |

## 스킬과 효과

`shared/src/protocol/tuning.ts`의 `SKILL_TUNING`

| 값 | |
| --- | --- |
| `DASH_COOLDOWN_MS` | 16000 |
| `DASH_DURATION_MS` | 5000 |
| `DASH_SPEED_INCREASE` | 0.5 |
| `EXHAUST_COOLDOWN_MS` | 22000 |
| `EXHAUST_DURATION_MS` | 5000 |
| `EXHAUST_RANGE_TILES` | 1.4 |
| `EXHAUST_SELF_DECREASE` | 0.1 |
| `EXHAUST_SELF_DURATION_MS` | 3000 |
| `EXHAUST_SPEED_DECREASE` | 0.25 |
| `FLASH_COOLDOWN_MS` | 12000 |
| `FLASH_DISTANCE_TILES` | 3 |
| `FRENZY_DURATION_MS` | 5000 |
| `FRENZY_SPEED_INCREASE` | 0.1 |
| `FRENZY_TAG_BONUS_INCREASE` | 0.05 |
| `FRENZY_TAG_BONUS_MS` | 5000 |
| `NEAR_TAGGER_COOLDOWN_BONUS` | 0.5 |
| `NEAR_TAGGER_RADIUS_TILES` | 6 |
| `SWITCH_COOLDOWN_MS` | 5000 |
| `SWITCH_RANGE_TILES` | 1.4 |
| `SWITCH_VICTIM_DURATION_MS` | 5000 |
| `SWITCH_VICTIM_SPEED_DECREASE` | 0.1 |
| `TAGGER_CHANGE_COOLDOWN_MS` | 20000 |

## 감속 바닥

`shared/src/protocol/tuning.ts`의 `SPEED_DECREASE_FLOOR`

| 값 | |
| --- | --- |
| `SPEED_DECREASE_FLOOR` | 0.3 |

## 타일 크기

`shared/src/protocol/tuning.ts`의 `TILE_PX`

| 값 | |
| --- | --- |
| `TILE_PX` | 256 |

## 경험치와 레벨

`shared/src/protocol/progression.ts`의 `PROGRESSION`

| 값 | |
| --- | --- |
| `LEVEL_BASE_COST` | 100 |
| `LEVEL_COST_STEP` | 50 |
| `XP_PER_MATCH` | 40 |
| `XP_PER_SURVIVED_MINUTE` | 12 |
| `XP_PER_SWITCH_SUCCESS` | 15 |
| `XP_PER_TAG` | 20 |
| `XP_PER_WIN` | 60 |
| `XP_SURVIVAL_CAP_MS` | 600000 |

## 서버 전용 규칙

`server-game/src/config/gameplay.ts`의 `GAMEPLAY`

| 값 | |
| --- | --- |
| `BASE_MOVE_SPEED_PX_PER_SEC` | 445.44 |
| `MAX_MATCH_DURATION_TICKS` | 72000 |
| `MAX_PLAYERS` | 8 |
| `MAX_SUBSTEP_DISTANCE_PX` | 48 |
| `MIN_PLAYERS_TO_START` | 3 |
| `PLAYER_COLLISION_ITERATIONS` | 4 |
| `PLAYER_RADIUS_PX` | 102.4 |
| `PUSH_BASE_POWER` | 1 |
| `PUSH_SPEED_FACTOR` | 0.01 |
| `SIGHT_RANGE_PX` | 4096 |
| `SURVIVORS_TO_WIN` | 2 |
| `TAGGER_CHANGE_COOLDOWN_MS` | 20000 |

## 서버 전용 스킬 값(대부분 SKILL_TUNING에서 단위만 바꾼 것)

`server-game/src/config/gameplay.ts`의 `SKILLS`

| 값 | |
| --- | --- |
| `DASH.COOLDOWN_MS` | 16000 |
| `DASH.DURATION_MS` | 5000 |
| `DASH.SPEED_INCREASE` | 0.5 |
| `EXHAUST.COOLDOWN_MS` | 22000 |
| `EXHAUST.DURATION_MS` | 5000 |
| `EXHAUST.RANGE_PX` | 358.4 |
| `EXHAUST.SELF_DECREASE` | 0.1 |
| `EXHAUST.SELF_DURATION_MS` | 3000 |
| `EXHAUST.SPEED_DECREASE` | 0.25 |
| `FLASH.COOLDOWN_MS` | 12000 |
| `FLASH.DISTANCE_PX` | 768 |
| `FLASH.WALL_EXIT_MAX_PX` | 512 |
| `FRENZY.DURATION_MS` | 5000 |
| `FRENZY.SPEED_INCREASE` | 0.1 |
| `FRENZY.TAG_BONUS_INCREASE` | 0.05 |
| `FRENZY.TAG_BONUS_MS` | 5000 |
| `NEAR_TAGGER_COOLDOWN_BONUS` | 0.5 |
| `NEAR_TAGGER_RADIUS_PX` | 1536 |
| `SWITCH.COOLDOWN_MS` | 5000 |
| `SWITCH.RANGE_PX` | 358.4 |
| `SWITCH_VICTIM.DURATION_MS` | 5000 |
| `SWITCH_VICTIM.SPEED_DECREASE` | 0.1 |

## 속도 계산

`server-game/src/config/gameplay.ts`의 `SPEED`

| 값 | |
| --- | --- |
| `DECREASE_FLOOR` | 0.3 |

## 이모지

`server-game/src/config/gameplay.ts`의 `EMOJI_DISPLAY_MS`

| 값 | |
| --- | --- |
| `EMOJI_DISPLAY_MS` | 3000 |

## 시뮬레이션 주기

`server-game/src/config/network.ts`의 `NETWORK`

| 값 | |
| --- | --- |
| `SIMULATION_HZ` | 60 |
