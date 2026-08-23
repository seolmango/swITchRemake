# swITch 리플레이 설계

이 문서는 경기 기록과 재생의 구현 기준을 정의한다. `docs/FUTURE.md`의 리플레이 관련 구상을 확정 설계로 옮긴 것이다.

관련 문서:

- 서버 권위 게임 루프와 전송 계약: `docs/SERVER_ARCHITECTURE.md`
- 클라이언트 렌더링 엔진과 스냅샷 형식: `docs/ENGINE.md`
- 아직 구상 단계인 운영·공유 기능: `docs/FUTURE.md`

## 1. 왜 지금 설계하는가

리플레이는 "나중에 있으면 좋은 기능"이 아니라 세 가지 이유로 코어와 함께 설계해야 한다.

1. **게임 루프에 물려 있다.** 기록 대상은 연결에 보낸 패킷이 아니라 권위 프레임이다. 이 경계를 나중에 만들면 이미 짠 루프와 인코딩을 다시 뜯는다.
2. **시야 코어를 두 벌로 만들지 않으려면 지금 결정해야 한다.** 리플레이의 개인 시점은 서버와 같은 시야 함수를 써야 한다.
3. **개발 도구로서 먼저 쓸모가 있다.** 결정론적인 경기 기록은 그 자체로 시뮬레이션 회귀 테스트의 입력이다. "그때 그 상황"을 다시 재현할 수 없으면 물리 버그는 추적이 거의 불가능하다. 플레이어에게 공개하기 한참 전부터 개발에 쓴다.

반대로 **지금 설계하지 않는 것**과 그 이유는 마지막 절에 적었다.

## 2. 핵심 결정: 스냅샷 형식을 그대로 쓴다

리플레이 프레임을 위한 새 바이너리 형식을 만들지 않는다. 이미 있는 스냅샷 형식을 그대로 쓴다.

- 인코더와 디코더가 한 벌뿐이다. 형식이 갈라져 리플레이만 깨지는 일이 없다.
- 웹 리플레이 플레이어가 곧 기존 엔진이다. 디코더에 프레임을 먹이면 그대로 그려진다. `ENGINE.md`가 말하는 "튜토리얼 스크립트 = 미니 서버"와 같은 구조이며, 리플레이 플레이어도 미니 서버 하나다.
- 이미 full/delta 플래그가 있으므로 keyframe은 그냥 full 스냅샷이다. 별도 개념이 필요 없다.
- 관전자 스냅샷과 리플레이 프레임이 사실상 같은 것이라, 관전 기능을 만들면 리플레이 기록은 거의 공짜로 따라온다.

리플레이는 시뮬레이션 tick이 아니라 **스냅샷 주기로 기록한다.** 60Hz 전부를 남길 이유가 없다. 플레이어가 실제로 본 것은 30Hz다. `snapshotHz`를 manifest에 적어 재생 측이 시간을 복원한다.

## 3. 권위 프레임과 뷰 파생

`SERVER_ARCHITECTURE.md`의 게임 루프 11단계에서 나오는 권위 프레임이 기록 대상이다. 스냅샷 섹션 중 무엇이 권위 상태이고 무엇이 뷰마다 달라지는지 구분해야 한다.

| 섹션 | 성격 | 리플레이 기록 |
| --- | --- | --- |
| `0x01` MAP | 권위 | keyframe에 포함 |
| `0x02` TILE_CHANGES | 권위 | 기록 |
| `0x04` STORM | 권위 | 기록 |
| `0x06` REGIONS | 권위 | 기록 |
| `0x09` ROSTER | 권위 | keyframe에 포함 |
| `0x05` PLAYERS | 권위 + 뷰 파생 | **전원을 기록한다.** `obscured` 비트는 항상 0으로 둔다 |
| `0x03` TILE_ALPHAS | 뷰 파생 | 기록하지 않는다 |
| `0x07` SELF | 뷰 파생 | 기록하지 않는다 |

`PLAYERS`의 `obscured`와 `TILE_ALPHAS`, `SELF`는 "누가 보는가"에 따라 달라지는 값이라 권위 상태가 아니다. 리플레이는 원본만 담고, 재생할 때 시야 코어를 돌려 다시 만든다.

```text
authoritative frame + viewerId + visibilityCoreVersion
                 │
         shared/visibility/core
                 │
   visible player set + obscured flags + tile alpha overrides
```

전지적 모드는 이 단계를 건너뛰고 전원을 그대로 그린다.

### 3.1 시야 판정 기록

재생 시 시야를 다시 계산하는 방식에는 함정이 하나 있다. 시야 코어가 바뀌면 과거 경기의 개인 시점이 **그때 실제로 보였던 화면과 달라진다.** 신고 조사에서 이건 치명적이다.

그래서 서버가 실제로 내린 판정도 함께 기록한다.

- 스냅샷 tick마다 뷰어별 `visible player bitmask`를 남긴다. 플레이어가 최대 8명이므로 뷰어당 1바이트, 8뷰어면 tick당 8바이트다.
- 재생 시 시야 코어를 돌린 결과와 이 기록을 비교한다. 어긋나면 사용자에게 "이 리플레이는 당시 시야 코어와 다른 버전으로 재생되고 있다"고 알린다.
- 5분 경기 기준 원본 72KB 정도지만 반복이 심해 압축이 잘 먹는다. 그래도 설정으로 끌 수 있게 둔다.

수풀 alpha까지 완전히 같아야 한다면 그것도 기록해야 하지만, 초기에는 bitmask만으로 충분하다. alpha 차이는 연출 수준이고 판정 근거가 아니다.

## 4. ReplayRecorder 계약

레코더는 게임 루프의 소비자 하나일 뿐이다. 루프는 레코더의 존재를 몰라야 한다.

```ts
interface ReplayRecorder {
    /** 게임 시작 시 1회. manifest에 들어갈 값을 고정한다. */
    begin(meta: ReplayMeta): void;
    /** 스냅샷 tick마다. frame은 이미 인코딩된 권위 스냅샷 바이트다. */
    writeFrame(tick: number, frame: Uint8Array, full: boolean): void;
    /** 시야 판정 기록. 설정으로 끌 수 있다. */
    writeVisibility(tick: number, masks: Uint8Array): void;
    /** JSON 이벤트를 tick과 함께. */
    writeEvent(tick: number, event: ReplayEvent): void;
    /** 경기 종료. 남은 chunk를 닫고 manifest를 완성한다. */
    finish(result: MatchOutcome): Promise<ReplayHandle | null>;
    /** 기록을 버린다. 메모리를 즉시 해제한다. */
    abort(reason: string): void;
}
```

지켜야 할 규칙:

- **게임 루프를 절대 막지 않는다.** 인코딩은 인라인으로 해도 된다. 권위 프레임 인코딩 한 번은 관전자 한 명이 늘어난 것과 같은 비용이라 무시할 만하다. 하지만 압축과 파일 쓰기는 비동기로 넘긴다.
- **기록 실패는 경기를 중단시키지 않는다.** spool 한도를 넘거나 쓰기가 실패하면 `abort`하고 그 경기의 리플레이를 포기한다. 경기가 리플레이보다 우선한다. 포기한 경기는 결과 메시지의 `replay`를 `null`로 보낸다.
- **spool에 상한을 둔다.** 프로세스 단위와 경기 단위 양쪽에 건다. 상한 없는 버퍼는 곧 OOM이다.
- 레코더는 방 객체와 소켓을 모른다. 인코딩된 바이트와 tick만 받는다.

용량 감각: 8명 기준 프레임이 약 120바이트, 30Hz면 초당 3.6KB, 5분 경기 원본 약 1MB다. 압축하면 수백 KB 수준이라 저장 비용은 문제가 되지 않는다.

## 5. 파일 형식

```text
magic "SWRP" + containerVersion(u16)
manifest (JSON, 길이 접두)
chunk index (chunk마다 startTick, endTick, offset, compressedLen, rawLen, sha256)
compressed chunks
```

- chunk는 2초 단위다. 30Hz 기준 60프레임이며, 각 chunk의 첫 프레임은 full 스냅샷이다.
- chunk 안은 `[u32 tick][u8 flags][u32 len][frame bytes]` 반복이다.
- 이벤트와 시야 bitmask는 별도 트랙으로 같은 chunk 경계를 따른다.
- 압축은 chunk 단위 gzip 또는 zstd. chunk 단위여야 탐색할 때 필요한 부분만 푼다.

manifest에 들어가는 값:

```ts
interface ReplayManifest {
    replayFormatVersion: number;
    matchId: string;
    mapId: string;
    snapshotHz: number;
    startTick: number;
    endTick: number;
    durationTicks: number;

    buildId: string;
    protocolVersion: number;
    rulesVersion: string;
    mapBundleHash: string;
    visibilityCoreVersion: number;

    participants: Array<{ playerId: number; nickname: string; colorIndex: number; guest: boolean }>;
    chunkCount: number;
    rootHash: string;   // chunk 해시 목록에 대한 SHA-256
}
```

`participants`에 `userId`를 넣지 않는다. 리플레이 파일은 언젠가 공유될 수 있고, 계정 식별자가 파일에 박혀 나가면 되돌릴 수 없다. 계정 연결은 데이터베이스에서만 한다.

`rootHash`는 지금 서명을 하지 않더라도 넣는다. 나중에 서명을 추가할 때 형식을 바꾸지 않아도 되고, 그 전까지도 저장소 손상 검출에 쓴다.

파서는 신뢰할 수 없는 입력을 받는다고 가정한다. chunk 수, 압축 해제 후 크기, 문자열 길이에 상한을 두고 offset과 length를 매번 검증한다. 지원하지 않는 버전은 부분 재생을 시도하지 말고 오류로 끝낸다.

## 6. 저장소와 업로드 경로

리플레이 blob은 인게임 서버가 직접 저장소에 쓴다. Redis로 보내지 않는다. 수백 KB짜리 blob을 제어 평면에 흘리면 안 된다.

```text
인게임 서버 ──(blob)──> ReplayStore
     │
     └──(storageKey, hash, size)──> 경기 결과 메시지 ──> 매칭 서버 ──> PostgreSQL
```

```ts
interface ReplayStore {
    put(key: string, body: Uint8Array): Promise<void>;
    get(key: string, range?: { start: number; end: number }): Promise<Uint8Array>;
    delete(key: string): Promise<void>;
}
```

- 구현은 `local`과 `s3` 둘을 둔다. 초기에는 로컬 파일 시스템으로 충분하고, 오브젝트 스토리지 계정 없이도 개발과 테스트가 된다.
- `get`이 range를 받는 이유는 탐색 때문이다. chunk index만 읽고 필요한 chunk만 가져올 수 있어야 5분짜리 파일 전체를 내려받지 않는다.
- 저장소는 공개 읽기가 되면 안 된다. 접근은 항상 애플리케이션을 지난다.
- 업로드 성공과 DB 메타데이터 기록 사이는 결과 outbox로 잇는다. 이미 결과 전송에 outbox가 있으므로 같은 경로를 쓴다.
- 파일 상태는 `recording -> finalizing -> available -> deleting -> deleted`다. `available` 이전 파일은 어떤 경로로도 노출하지 않는다.

경기 결과 메시지에 다음 필드가 추가된다. 자세한 것은 `SERVER_ARCHITECTURE.md`의 경기 결과 메시지 절을 본다.

```ts
replay: {
    storageKey: string;
    formatVersion: number;
    chunkCount: number;
    sizeBytes: number;
    rootHash: string;
} | null;   // 기록에 실패했으면 null
```

## 7. 데이터 모델

```text
matches
  matchId(unique), roomId, serverId, mapId,
  startedAt, endedAt, durationTicks,
  buildId, protocolVersion, rulesVersion, mapBundleHash, visibilityCoreVersion

match_participants
  matchId, userId(nullable, 게스트는 null), playerId,
  nickname(당시), colorIndex, isGuest,
  isWinner, tagCount, taggedCount, switchTry, switchSuccess, survivedMs

replays
  matchId, storageKey, formatVersion, chunkCount, sizeBytes,
  rootHash, status, createdAt, deleteAfter(nullable)

replay_holds
  replayId, reason(REPORT/LEGAL/MANUAL), sourceId, createdBy, createdAt, releasedAt

reports
  matchId, reporterUserId, targetPlayerId, category, tick,
  description, status, createdAt

sanctions
  userId, type(WARN/GAME_RESTRICT/BAN), scope, startsAt, expiresAt,
  reason, evidenceMatchId, createdBy, createdAt

sanction_revocations
  sanctionId, revokedBy, reason, createdAt

admin_audit_log
  actor, action, targetType, targetId, reason, requestMeta, createdAt   -- append only
```

몇 가지 규칙:

- `match_participants.userId`는 게스트일 때 null이다. 그래도 행은 남긴다. 리플레이 재생과 신고 조사는 경기에 있던 전원의 `playerId`와 당시 닉네임을 필요로 한다. 게스트를 빼면 리플레이에 이름 없는 캐릭터가 돌아다닌다. 전적 집계에서만 제외한다.
- 이 게임에는 등수가 없다. 최후까지 남은 두 명이 공동 승리자이므로 참가자 행에는 `isWinner` 불리언만 둔다. 순위 컬럼을 만들면 없는 개념을 스키마가 발명하게 된다.
- `users.account_status`는 로그인 경로의 빠른 판정용 캐시다. **왜 그 상태인지의 기록은 `sanctions`다.** 상태 컬럼을 직접 UPDATE 하는 코드를 만들지 않는다. 제재 서비스를 지나야 감사 로그가 남는다.
- 제재를 취소할 때 `sanctions` 행을 지우거나 고치지 않는다. `sanction_revocations`에 행을 더한다. 과거에 무슨 판단을 했는지가 남아야 이의 제기를 처리할 수 있다.
- `admin_audit_log`는 append only다. 애플리케이션 DB 계정에 이 테이블의 UPDATE/DELETE 권한을 주지 않는다.

## 8. 접근 통제

리플레이는 시야 시스템을 우회할 수 있는 데이터다. 접근 규칙이 곧 보안 규칙이다.

- **진행 중인 경기의 리플레이는 어떤 경로로도 접근할 수 없다.** 파일 상태가 `available`이 되는 시점은 경기 종료 이후다. 이 규칙이 무너지면 리플레이 링크가 실시간 맵핵이 된다.
- 열람 권한은 그 경기의 참가자에게만 준다. 게스트는 계정이 없으므로 열람 권한도 없다.
- 저장소 키와 장기 credential을 브라우저에 노출하지 않는다. 애플리케이션이 chunk를 중계하거나 짧게 만료되는 서명 URL을 발급한다.
- 리플레이 파일에 참가하지 않은 사용자의 정보, IP, 내부 안티치트 신호를 담지 않는다.
- 운영 조사용 열람과 일반 사용자 열람은 권한을 분리한다. 조사 열람은 감사 로그에 남긴다.

## 9. 보존 정책

무료 열람 조건은 **합집합**으로 정한다.

```text
열람 가능 = (그 사용자의 최근 5경기 안에 듦) OR (종료 후 1시간 이내)
```

`AND`로 하면 "5개까지 보관하되 1시간 뒤 삭제"라는 전혀 다른 상품이 된다. 한 시간에 10경기를 하면 잠시 10개가 보이고, 며칠 접속하지 않아도 마지막 5경기는 남는 쪽이 사용자가 기대하는 동작이다.

파일 삭제 조건은 사용자별 열람 권한과 분리해서 계산한다.

```text
무료 보존 자격을 가진 참가자가 없음
AND 활성 hold 없음
AND 유료 보관 없음
-> 삭제
```

한 참가자가 자격을 잃어도 다른 참가자나 신고 사건이 파일을 붙들 수 있다. 그래서 "이 사람이 볼 수 있는가"와 "파일을 지워도 되는가"는 다른 질문이다.

삭제는 배치로 돌리고, 삭제 직전에 hold를 한 번 더 확인한다. 조회 시점과 삭제 시점 사이에 신고가 들어올 수 있다.

## 10. 신고와 보존 hold

초기에는 신고 큐 UI 없이 최소한만 만든다. 중요한 건 화면이 아니라 **증거가 지워지지 않는 것**이다.

- 신고는 파일 첨부가 아니라 `matchId` 대상으로 만든다. 서버가 아는 경기만 신고할 수 있다.
- 그 경기의 참가자만 신고할 수 있다. 대상 플레이어, 분류, 사용자가 가리킨 tick, 설명을 받는다.
- 신고가 들어오면 즉시 해당 리플레이에 `REPORT` hold를 건다. 이 hold가 보존 정책보다 우선한다.
- 경기 진행 중 신고가 접수되면 종료 시점에 바로 보존 대상이 된다.
- 같은 경기의 신고 여러 건은 같은 파일 하나를 참조한다.
- 신고 접수 자체는 제재 사유가 아니다. 반복·보복 신고 패턴도 함께 집계한다.
- hold 추가와 해제를 감사 로그에 남긴다.

## 11. 재생

리플레이 플레이어는 자체 `playbackClock`을 소유한다. 이게 없으면 일시정지와 배속이 제대로 동작하지 않는다.

- pause, 0.5x/1x/2x, frame step
- tick 또는 초 단위 seek
- seek는 목표 tick 이전의 가장 가까운 keyframe을 찾아 거기서부터 delta와 이벤트를 다시 적용한다. 파일을 처음부터 재생하지 않는다.
- seek 직후 임시 연출과 카메라 보간 상태를 초기화한다. 안 하면 과거 이모지가 화면에 남는다.

**엔진 쪽에 영향이 있다.** 현재 엔진의 이모지, 점멸, 카메라 효과는 로컬 경과 시간을 쓴다. 리플레이에서는 이 수명들을 wall clock이 아니라 replay tick 기준으로 계산해야 한다. 엔진에 "시간 소스"를 주입할 수 있게 만들어두면 라이브와 리플레이가 같은 코드로 돈다. 이건 `ENGINE.md` 쪽 변경이며 리플레이를 실제로 만들 때 함께 처리한다.

## 12. 구현 순서

1. 게임 루프의 권위 프레임 경계 (코어 작업에 포함, 이미 `SERVER_ARCHITECTURE.md`에 반영)
2. 시야 코어를 `shared`로 분리하고 버전 부여 (코어 작업에 포함)
3. `ReplayRecorder` 인터페이스와 메모리 기록, `abort` 경로
4. chunk/keyframe 직렬화와 `local` `ReplayStore`
5. 개발용 로컬 재생 도구. 여기까지가 **시뮬레이션 디버깅에 바로 쓰이는 지점**이다
6. 결과 메시지에 replay 필드 연결, `matches`/`match_participants`/`replays` 저장
7. 웹 리플레이 플레이어의 재생·일시정지·탐색·배속
8. 시야 코어를 이용한 개인 시점과 bitmask 검증
9. 보존 정책과 사용자 경기 기록 화면
10. 신고 접수와 hold
11. `sanctions`/`admin_audit_log`와 제재 API

3~5번까지만 해도 개발에 쓸모가 있다. 사용자에게 보여주는 것은 7번부터다.

## 13. 지금 설계하지 않는 것

아래는 `docs/FUTURE.md`에 구상으로 남겨둔다. 지금 설계하지 않는 이유를 함께 적는다.

- **`.switchreplay` 내보내기와 Ed25519 서명**: 서명 키 관리와 signer service 또는 KMS가 필요하다. 그 자체로 별도 프로젝트다. `rootHash`를 지금 형식에 넣어뒀으므로 나중에 서명 블록만 추가하면 되고, 형식을 다시 바꾸지 않는다.
- **링크 공유와 취소·만료**: 리플레이 웹 플레이어가 먼저 있어야 의미가 있다. 공유 범위, 만료, 취소는 그다음 문제다.
- **운영자 페이지 UI**: 역할 4종, MFA, 2인 승인, 대시보드는 실제 운영 인력이 있을 때 필요한 것이다. 지금 필요한 건 화면이 아니라 테이블과 감사 로그이고, 그건 위에 넣었다. 조사가 필요하면 초기에는 DB 조회로 한다.
- **안티치트 신호 저장과 통계 분석**: 신호를 내보내는 지점은 이미 만들었다. 저장과 통계 탐지는 실제 어뷰징이 관측된 뒤에 그 패턴을 보고 만드는 것이 맞다. 관측 전에 만든 탐지 규칙은 오탐만 만든다.
- **유료 보관과 분석 기능**: 사용자가 생긴 뒤의 문제다.

## 14. 미결 사항

1. 압축 알고리즘. gzip은 어디서나 되고 zstd는 더 빠르고 작다. 로컬 저장 단계에서 둘 다 재보고 정한다.
2. 리플레이 열람 기간과 신고 가능 기간의 관계. 열람할 수 없게 된 경기를 신고할 수 있어야 하는가.
3. 게스트가 참여한 경기의 리플레이를 누가 볼 수 있는가. 현재 설계는 계정 참가자만 볼 수 있고 게스트는 못 본다.
4. 시야 bitmask 기록의 기본값. 용량과 조사 정확도의 교환이다.
