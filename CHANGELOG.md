# 업데이트 기록

개발자용 기록이다. 무엇이 언제 바뀌었는지를 남긴다.

- **규칙(밸런스) 항목**은 `npm run balance:release`가 바뀐 값을 그대로 적는다. 메모(`-m`)에 이유를 쓴다.
  규칙 버전은 경기 결과·리플레이·서버 상태에 찍히므로, 이 기록으로 "그 경기가 어떤 규칙이었나"를 찾는다.
- **그 밖의 변경**(기능, 수정, 운영)은 PR을 합칠 때 아래 "다음 배포" 절에 한 줄씩 적고, 배포할 때 날짜를
  붙인 절로 옮긴다.
- 플레이어에게 보여 줄 패치 노트(한국어·영어)는 이 기록을 초안으로 삼아 따로 쓴다.

버전은 아직 0.x다. 밸런스 테스트를 마친 첫 규칙이 1.0.0이 된다(`npm run balance:release -- --major`).

## 다음 배포

- 수정: 프로필의 최근 경기 카드에서 맵 이름·날짜가 카드 밖으로 넘치고 리플레이 버튼이 가운데에 오지 않던 문제, 기기 관리 창의 닫기 버튼 높이, 기기가 많을 때 만료 줄이 넘치던 문제, 좁은 화면에서 "현재 기기" 표시가 찌그러지던 문제.
- 맵: 시험용 TestMap1을 빼고 Plaza(32, 약 68초)·Rings(40, 85초)·Grove(44, 94초)·Quarters(36, 77초)를 더했다. BattleField는 그대로.
- 개발 환경: `npm run setup`(설정 파일 생성), `npm run dev`(한 번에 실행), 배포 스택 `npm run stack:up`.
- 규칙 버전 자동화: 밸런스 값이나 시뮬레이션 코드가 바뀌면 릴리스 전까지 `-dev.<지문>`이 붙는다.
- 타이틀 화면의 서버 상태가 글자로 바뀌고 10초마다 저절로 갱신되며 서버의 패치(규칙) 버전을 보여 준다.
- 수정: 경기 중에 들어온 사람이 경기가 끝난 뒤에도 대기실에서 모두를 "다음 경기 대기 중"으로 보고 자리·스킬을
  바꾸지 못하던 문제. `lobby.state`가 방 상태를 함께 싣는다(선택 필드, 구버전과 호환).
- 수정: 인게임 서버가 줄어드는 순간 맵·리플레이 다운로드가 방금 꺼진 서버로 가 502가 나던 문제. 연결 자체가 실패하면
  게이트웨이가 다른 서버로 한 번 더 보낸다.

## 규칙 0.6.0 — 2026-10-07

속도감 있는 게임을 목표로 한 첫 제안(플레이 테스트 전). 기본 이동 +20%, 스킬 쿨타임·지속 단축, 광란 체감되게 0.2, 탈진을 팔 거리(1.8)로 넓혀 스위치와 자리를 나눔, 술래 강제 교체 15초. 맵 회전(Plaza·Rings·Grove·Quarters·BattleField)과 함께 본다.

- `GAMEPLAY.BASE_MOVE_SPEED_PX_PER_SEC`: 445.44 → 537.6
- `GAMEPLAY.TAGGER_CHANGE_COOLDOWN_MS`: 20000 → 15000
- `MOVEMENT.BASE_SPEED_TILES_PER_SEC`: 1.74 → 2.1
- `SKILLS.DASH.COOLDOWN_MS`: 16000 → 13000
- `SKILLS.DASH.DURATION_MS`: 5000 → 4000
- `SKILLS.EXHAUST.COOLDOWN_MS`: 22000 → 18000
- `SKILLS.EXHAUST.DURATION_MS`: 5000 → 4000
- `SKILLS.EXHAUST.RANGE_PX`: 358.4 → 460.8
- `SKILLS.EXHAUST.SELF_DURATION_MS`: 3000 → 2500
- `SKILLS.FLASH.COOLDOWN_MS`: 12000 → 10000
- `SKILLS.FLASH.DISTANCE_PX`: 768 → 896
- `SKILLS.FRENZY.SPEED_INCREASE`: 0.1 → 0.2
- `SKILLS.SWITCH.COOLDOWN_MS`: 5000 → 4000
- `SKILLS.SWITCH_VICTIM.DURATION_MS`: 5000 → 4000
- `SKILL_TUNING.DASH_COOLDOWN_MS`: 16000 → 13000
- `SKILL_TUNING.DASH_DURATION_MS`: 5000 → 4000
- `SKILL_TUNING.EXHAUST_COOLDOWN_MS`: 22000 → 18000
- `SKILL_TUNING.EXHAUST_DURATION_MS`: 5000 → 4000
- `SKILL_TUNING.EXHAUST_RANGE_TILES`: 1.4 → 1.8
- `SKILL_TUNING.EXHAUST_SELF_DURATION_MS`: 3000 → 2500
- `SKILL_TUNING.FLASH_COOLDOWN_MS`: 12000 → 10000
- `SKILL_TUNING.FLASH_DISTANCE_TILES`: 3 → 3.5
- `SKILL_TUNING.FRENZY_SPEED_INCREASE`: 0.1 → 0.2
- `SKILL_TUNING.SWITCH_COOLDOWN_MS`: 5000 → 4000
- `SKILL_TUNING.SWITCH_VICTIM_DURATION_MS`: 5000 → 4000
- `SKILL_TUNING.TAGGER_CHANGE_COOLDOWN_MS`: 20000 → 15000

## 규칙 0.5.0 — 2026-10-07

자동 버전 관리를 시작한 기준선. 이전 표기는 `0.5.0-match-time-limit`였다.
