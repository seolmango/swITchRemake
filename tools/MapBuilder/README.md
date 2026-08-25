# Map Builder

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

허용하는 구역 종류:

- `training.course`
- `training.chase`

빌더는 알 수 없는 종류, 맵 밖 좌표, 벽 위 마커, 중복 마커 좌표, 맵 밖으로 나가는 구역을
오류로 처리한다. `server_maps.json`에는 모든 맵에 `markers`와 `zones`가 항상 기록된다.
