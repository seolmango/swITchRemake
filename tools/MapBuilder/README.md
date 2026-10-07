# Map Builder

맵 원본(`map/*.csv`, `map/*.json`)에서 자기장 수축을 미리 시뮬레이션해, 자기장에 닿아 부서지는 벽까지 틱
단위 타임라인으로 담은 맵 번들을 만든다(BASE.md §2.7, §13). 서버는 런타임에 이 계산을 하지 않는다.

## 에디터

```sh
npm run map:editor        # http://127.0.0.1:5180
```

브라우저에서 맵을 열고 고친다. 파일 형식은 아래와 같은 `map/*.json`, `map/*.csv` 그대로라 에디터 없이
손으로 고쳐도 된다.

- **브러시·사각형·스포이트**: 시작 타일을 칠한다(오른쪽 클릭은 그 칸의 타일 집기).
- **마커·구역**: 훈련장 표적·스킬 칸과 구역을 놓는다(오른쪽 클릭은 지우기).
- **칸**: 한 칸의 시간표(`틱:타일`, `*:타일`)를 고친다. 시간표가 있는 칸은 빨간 점으로 보인다.
- **자기장 미리보기**: 틱을 옮기면 그 시각의 자기장과 타일을 builder.py와 같은 계산으로 보여 준다.
- **시작 위치**: 인원별 시작 자리를 보여 준다.
- **검사**: builder.py가 거절할 것(벽 위 마커, 맵 밖 구역, 없는 타일 번호 등)을 바로 보여 준다.
- **빌드 → 서버 번들**: 저장하고 builder.py를 돌려 `server-game/maps/server_maps.json`을 갱신한다. 바뀌었으면
  그 파일과 맵 파일을 함께 커밋한다. 아래 Python 준비가 먼저 필요하다.

Ctrl+Z / Ctrl+Shift+Z로 되돌리고, Ctrl+S로 저장한다.

## 실행

Python 3과 `requirements.txt`가 필요하다. 해시 계산에 `node`도 쓴다(서버의 `JSON.stringify`와 바이트까지
같아야 하기 때문).

```sh
cd tools/MapBuilder
python -m venv .venv && .venv/Scripts/pip install -r requirements.txt   # macOS/Linux: .venv/bin/pip
.venv/Scripts/python builder.py -t build -s setting.json                 # build/ 에 결과
cp build/server_maps.json ../../server-game/maps/server_maps.json
```

- `build`: `build/server_maps.json`(서버가 읽는 번들), `client_maps.json`, `tileset.webp`를 만든다. 저장소에
  들어가는 것은 `server-game/maps/server_maps.json` 하나다. 클라이언트는 맵을 게이트웨이의
  `/map-bundles`에서 받는다.
- `preview`, `video`: 맵마다 타일·마커 미리보기 이미지와 자기장 진행 영상을 만든다.

번들의 `schemaVersion`과 `simulationHz`가 서버와 다르면 인게임 서버가 기동을 거부한다
(`server-game/src/maps/map-loader.ts`). 커밋된 번들은 `server-game`의 훈련장 테스트가 실제 로더로 읽어
확인한다.

## 타일 CSV

타일 번호와 물리 값의 매핑은 `setting.json`의 `tile_data`가 정의한다. 마커와 구역은 이 타일
번호에 추가하지 않는다.

## 마커와 구역 저작 형식

마커와 구역은 각 맵의 JSON 파일에 선택적 `markers`, `zones` 배열로 적는다. 생략하면 각각 빈
배열로 처리된다.

```json
{
  "name": "TrainingGround",
  "size": 30,
  "barrier": 1,
  "data": "training.csv",
  "markers": [
    { "kind": "skill.dash", "x": 4, "y": 7 },
    { "kind": "reset", "x": 9, "y": 7 }
  ],
  "zones": [
    { "kind": "training.course", "x": 2, "y": 3, "width": 8, "height": 5 }
  ]
}
```

좌표와 크기는 모두 타일 단위이며, 구역의 `x`, `y`는 왼쪽 위 타일이다.

이 데이터를 타일 CSV의 별도 문법으로 넣지 않고 JSON 목록으로 둔 이유는 다음과 같다.

- CSV 셀은 계속 타일과 타임라인만 표현하므로 기존 저작 흐름을 바꾸지 않는다.
- 물리 타일과 "밟으면 일어나는 규칙"이 한 셀에 섞이지 않는다.
- 개수가 적은 객체 목록이라 좌표와 종류를 손으로 추가하거나 코드 리뷰하기 쉽다.

허용하는 마커 종류:

- `skill.dash`
- `skill.flash`
- `skill.exhaust`
- `tagger`
- `reset`
- `training.chaseMode`
- `training.dummy.still`, `training.dummy.patrol`, `training.dummy.chase`

허용하는 구역 종류:

- `training.course`
- `training.chase`

빌더는 알 수 없는 종류, 맵 밖 좌표, 벽 위 마커, 중복 마커 좌표, 맵 밖으로 나가는 구역을
오류로 처리한다. `server_maps.json`에는 모든 맵에 `markers`와 `zones`가 항상 기록된다.
