# swITch 엔진 제3자 검토

검토일: 2026-08-25  
검토 범위: `client/src/game/**`, `server-game/src/simulation/**`, `server-game/src/game/**`, `shared/src/protocol/**` 및 이 경계를 실제로 연결하는 최소한의 호출부

## 판정 기준

- **[확인]**: 해당 동작을 코드에서 직접 추적했다.
- **[추론]**: 코드와 제공된 계측이 잘 맞지만, 동일 환경의 메모리 trace로 원인 객체까지 입증하지는 못했다.
- 심각도는 발생 가능성뿐 아니라 발생했을 때 경기/상태가 망가지는 정도를 함께 반영했다.

## 요약

심각도 **높음 3건**, **중간 5건**, **낮음 2건**을 찾았다.

가장 먼저 볼 것은 세 가지다.

1. **[추론, 신뢰도 중상] OOM의 가장 그럴듯한 후보는 가시성 변화에 따른 `PlayerSprite`/Phaser Text 텍스처 churn이다.** 서버가 보이지 않는 플레이어를 `players`에서 빼고, 클라이언트는 매번 그 플레이어의 `PlayerSprite`를 파괴한다. 다시 보이면 두 개의 Phaser Text를 포함한 객체를 새로 만든다. `createTexture 608 / deleteTexture 762`, JS heap 안정, `texImage2D`와 `createTexture` 호출 수가 거의 같은 계측은 이 경로와 잘 맞는다. 이는 보유 텍스처 수가 계속 느는 전형적인 누수가 아니라 생성·업로드·삭제가 반복되는 churn이다.
2. **[확인] 재접속은 현재 `roomState`만 복원하고 놓친 `game.started`/`game.ended`의 payload를 복원하지 않는다.** 카운트다운 중 끊겼다가 경기 시작 뒤 돌아오면 `started`가 영원히 null일 수 있고, 종료 순간 끊겼다가 돌아오면 결과 화면으로 갈 `matchId`를 얻지 못한다.
3. **[확인] 이전 경기의 비동기 replay 저장 완료 콜백이 같은 방의 새 세션을 삭제할 수 있다.** replay 저장이 post-game과 다음 countdown보다 오래 걸리면 실제 진행 중인 재경기까지 scheduler에서 제거한다.

서버 권위 자체는 대체로 지켜진다. 실경기 경로에서 클라이언트는 좌표를 예측하거나 외삽하지 않고 서버 스냅샷 사이를 보간한 뒤 마지막 샘플을 유지한다. 스킬, 충돌, 시야, 쿨다운, 술래 교체는 서버에서만 결정한다. 클라이언트가 자체적으로 갖는 것은 카메라, blink/emoji 연출 수명 같은 표시 상태다. 공개 `PlayerHandle`로 로컬 그림을 움직일 수는 있지만 `GamePage` 실경기 경로는 이를 사용하지 않고, 서버 상태에도 영향을 줄 수 없다.

## 발견 사항

### 1. 가시성 경계가 플레이어 Text 텍스처의 생성·삭제 루프가 된다

`server-game/src/game/snapshot-view.ts:107` — **[확인]** filtered viewer의 `players`는 매 스냅샷마다 현재 보이는 생존자만 담는다 — 플레이어가 수풀/벽 시야 경계를 왕복하면 30 Hz 스냅샷에서 목록에 들어왔다 빠졌다 할 수 있다 — **심각도 높음** — wire 보안 모델은 유지하되 클라이언트 자원은 roster 단위로 풀링하고, 안 보이는 ID는 좌표를 갱신하지 않은 채 GameObject만 숨기거나 익명 `PlayerSprite` 풀로 돌려 Text 객체를 재사용한다.

`client/src/game/internal/WorldScene.ts:525` — **[확인]** 보이는 ID가 다시 등장할 때 `spawnPlayer`가 새 `PlayerSprite`를 만든다 — 가시성 경계의 작은 흔들림도 GPU/Canvas 자원 재생성으로 확대된다 — **심각도 높음** — visibility를 “엔티티 수명”과 분리하고, 등장/퇴장은 visibility flag와 풀 checkout/checkin으로 처리한다.

`client/src/game/internal/WorldScene.ts:560` — **[확인]** 현재 `players` 목록에 없는 모든 기존 sprite를 즉시 `destroy()`한다 — 한 프레임의 비가시성에도 히스테리시스나 풀 없이 자원이 폐기된다 — **심각도 높음** — 최소한 Text/Graphics를 풀링하고, 풀에 넣을 때 위치·닉네임·effect를 초기화해 오래된 표시 상태가 재사용 대상에 섞이지 않게 한다.

`client/src/game/internal/PlayerSprite.ts:76` — **[확인]** 한 `PlayerSprite`는 Phaser Text 두 개(`label`, `nameplate`)를 만든다 — Phaser 3.90의 Text는 내부 CanvasTexture/GL texture를 소유하므로 반복 spawn은 texture 생성 및 최초 text upload를 동반한다 — **심각도 높음** — 숫자는 bitmap font/공유 atlas로 바꾸고, 닉네임 Text는 ID별 또는 공용 풀로 재사용하는 방안을 우선 검토한다.

`client/src/game/internal/PlayerSprite.ts:194` — **[확인]** visibility 퇴장마다 두 Text를 포함한 모든 GameObject를 파괴한다 — `deleteTexture`가 `createTexture`보다 많다는 계측은 “누수 없음”을 뜻할 뿐, driver가 해제를 지연하는 동안의 순간 peak·staging buffer·Canvas backing churn은 배제하지 못한다 — **심각도 높음** — `PlayerSprite` constructor/destroy 횟수, Text `updateText` 횟수, 업로드 source canvas의 `width × height × 4`를 ID와 함께 계측해 608회의 귀속을 먼저 확정한다.

**OOM 종합 판정 — [추론, 신뢰도 중상].** `Graphics.clear()`/벡터 재그리기는 주로 command/vertex buffer 경로이며 `texImage2D` 호출 수와 직접 맞지 않는다. 반면 Phaser Text 생성과 최초 문자열 설정은 Canvas를 `texImage2D`로 올린다. 기본 UI 설정은 닉네임과 번호를 모두 표시하고, font 크기도 world scale 때문에 약 83 px/96 px이므로 20자 닉네임 canvas는 작지 않다. 611회의 `texImage2D`와 608회의 `createTexture`가 거의 1:1인 점, 삭제도 비슷한 규모인 점은 “업데이트 중인 몇 개 텍스처의 누수”보다 “새 Text 텍스처를 계속 만들고 버림”에 더 가깝다. 다만 **1.1 GB라는 byte 누계 전체를 이 코드만으로 확정할 수는 없다.** source canvas 실제 치수와 호출 stack이 없으므로 최종 원인 표시는 계측 후에 해야 한다.

### 2. `preserveDrawingBuffer`는 OOM의 직접 원인보다는 큰 고정 증폭 요인이다

`client/src/game/SwitchEngine.ts:108` — **[확인]** 제품 렌더러가 `preserveDrawingBuffer: true`로 생성된다 — 화면 캡처를 쓰지 않는 실경기에서도 브라우저가 프레임 뒤 color buffer를 버려 최적화할 수 없고, GPU 메모리와 복사 대역폭의 고정 비용이 커진다 — **심각도 중간** — 제품 기본값은 false로 두고 실제 캡처 직전에만 별도 render/readback 경로를 사용하거나 캡처 전용 옵션으로 분리한다.

`client/src/game/SwitchEngine.ts:190` — **[확인]** 코드가 직접 정하는 WebGL canvas backing 크기는 `CSS 크기 × resolutionScale`이며 `devicePixelRatio`를 곱하지 않는다 — 1280×800, 기본 100%라면 코드상 drawing buffer는 1280×800이고, DPR 2의 브라우저 compositor 표면은 2560×1600일 수 있다; 실제 계측에서 GL drawing buffer도 2560×1600이었다면 이 파일 밖의 스케일 또는 브라우저 경로가 더 개입한 것이다 — **심각도 중간** — 메모리 계측에 `canvas.width/height`, CSS rect, `devicePixelRatio`, `gl.drawingBufferWidth/Height`를 함께 기록해 “compositor 표면”과 “WebGL drawing buffer”를 구분한다.

백버퍼 산술은 다음과 같다.

- 1280×800 RGBA8 한 장: 4,096,000 B = 약 3.91 MiB.
- DPR 2 물리 표면 2560×1600 RGBA8 한 장: 16,384,000 B = 약 15.63 MiB.
- 보존용/표시용 color plane 두 장만 잡아도 약 31.25 MiB이고, 같은 크기의 depth/stencil과 compositor 사본이 붙으면 수십 MiB가 더 든다. 정확한 장수는 브라우저/드라이버 구현 의존이다.
- 이 고정 비용은 저사양 GPU의 여유를 줄여 texture churn의 crash를 앞당길 수 있지만, 기본 framebuffer 보존 자체는 611회의 `texImage2D`나 1.1 GB의 **누적 업로드**를 만들지 않는다. 1.1 GB 누계는 현재 보유량도 아니다.

따라서 권장 A/B 순서는 (1) visibility/Text churn stack 계측, (2) sprite 풀링 또는 bitmap font 적용, (3) `preserveDrawingBuffer=false` 제품 빌드 비교다. 세 항목을 한꺼번에 바꾸면 원인 귀속을 다시 잃는다.

### 3. MapLayer의 매 프레임 임시 객체는 OOM 원인이 아니라 제한된 GC/CPU 부담이다

`client/src/game/internal/MapLayer.ts:240` — **[확인]** high 설정에서도 grass/smoke는 매 렌더 프레임이 아니라 3프레임마다(60 fps 기준 약 20 Hz), conceal alpha가 실제 변경되면 즉시 다시 그린다 — 현재 맵과 제공된 JS heap 26~52 MB 안정 계측에서는 장기 보유 누수의 증거가 없다 — **심각도 낮음** — OOM 수정 대상으로 먼저 건드리지 말고 allocation flame chart/young GC pause가 프레임 budget을 넘는지 확인한 뒤 최적화한다.

`client/src/game/internal/MapLayer.ts:396` — **[확인]** grass redraw는 `filter`, alpha별 `Map`, outline용 Set/Map/문자열/배열을 매번 만들고 동일 visible set outline을 alpha group과 최종 silhouette에서 다시 계산한다 — 큰 viewport가 많은 bush를 포함하거나 저사양 CPU에서 카메라가 움직일 때 짧은 GC pause와 CPU spike는 날 수 있지만, 객체는 redraw 뒤 도달 불가능해지고 texture upload를 만들지 않는다 — **심각도 낮음** — 필요하면 `(visible tile set signature, alpha buckets)`별 outline을 캐시하고 카메라가 tile 경계를 넘거나 alpha bucket이 바뀔 때만 갱신한다.

`client/src/game/internal/MapLayer.ts:468` — **[확인]** smoke도 regions 배열과 alpha `Map`은 매 redraw 만들지만, uniform region의 outline은 `load()` 때 계산한 `outlineLoopsPx`를 재사용한다 — BattleField의 초기 gas는 없고 timeline 첫 gas도 52칸 규모라 현재 자산에서는 이 배열 자체가 OOM 규모가 아니다 — **심각도 낮음** — `regionsInView`는 재사용 scratch array로 줄일 수 있으나 profile 없이 복잡도를 올릴 우선순위는 낮다.

결론적으로 이 부분은 **무해하다고 단정할 수는 없는 GC 부담**이지만, 제공된 OOM 계측의 핵심인 `texImage2D/createTexture`와는 경로가 다르다. 프레임 끊김 조사 대상이지 첫 번째 OOM 후보는 아니다.

### 4. 낮은 tick 스냅샷을 새 경기로 간주해 오래된 상태를 그대로 적용한다

`client/src/game/internal/WorldScene.ts:481` — **[확인]** `snapshot.tick < latestSnapshotTick`이면 패킷을 버리지 않고 보간 버퍼만 비운 뒤 “새 authoritative timeline”으로 적용한다 — 동일 match에서 순서가 뒤집힌 스냅샷을 주입하면 플레이어·storm·tile delta가 과거로 되감기고, 다음 새 패킷에서 다시 앞으로 튄다 — **심각도 중간** — 스냅샷에 `matchId`/epoch를 넣고 epoch가 같으면 `tick <= latest`를 폐기하며, 새 epoch일 때만 명시적으로 renderer state를 reset한다.

`client/src/game/GameSession.ts:220` — **[확인]** binary frame에는 eventId나 connection generation 검사가 없고 도착 즉시 모든 subscriber에 전달된다 — WebSocket/TCP 한 연결 안에서는 순서 역전과 개별 packet loss가 애플리케이션에 보이지 않고, 교체된 socket의 callback은 `socket !== this.socket` 검사로 막히므로 정상 운영에서는 위 되감기가 쉽게 발생하지 않는다 — **심각도 중간** — transport 보장에만 의존하지 말고 renderer 계약에도 monotonic tick/epoch 방어를 둔다; replay/dev injection도 같은 경로를 안전하게 쓸 수 있다.

패킷 유실에 관해서는 서버의 알려진 backpressure skip은 복구된다. `server-game/src/game/game-session.ts:191`에서 publish 사이의 tile change를 누적하고, 느린 target을 건너뛰면 다음 프레임을 full로 표시하며, full에는 현재 map 전체가 들어간다. 기존의 “tick마다 `world.tileChanges`를 비워 publish 주기 사이 변경을 잃음” 문제는 현재 코드에서 고쳐져 있다. 다만 client-side decode/apply 예외처럼 서버가 모르는 drop에는 ack나 주기적 keyframe이 없어 tile delta 복구가 되지 않으므로, 운영상 decode 오류가 관측되면 연결을 재수립해 full snapshot을 받는 편이 안전하다.

### 5. 재접속이 놓친 경기 시작/종료 이벤트를 복원하지 못한다

`client/src/game/GameSession.ts:284` — **[확인]** 재인증 `auth.ok`는 `roomState`와 `role`만 덮고 `starting`, `started`, `ended`를 현재 서버 상태에 맞춰 재구성하지 않는다 — countdown 중 끊겨 `game.started`를 놓치면 reconnect 후 `roomState=PLAYING`이어도 `started=null`이라 loading gate가 끝나지 않는다 — **심각도 높음** — resume 응답을 현재 경기 phase의 완전한 상태로 만들고, PLAYING이면 `mapId/startTick/taggerId/gameplay`, POST_GAME이면 `matchId/winnerIds/returnsAt`을 포함해 원자적으로 client state를 교체한다.

`client/src/game/GameSession.ts:303` — **[확인]** `started`와 `ended`를 채우는 유일한 경로는 일회성 `game.started`/`game.ended` JSON event다 — 종료 순간 10초 reconnect grace 안에서 끊겼다 돌아오면 `auth.ok`는 POST_GAME만 알려 주고 결과 화면에 필요한 matchId는 주지 않는다 — **심각도 높음** — lifecycle event를 idempotent state projection으로 재전송하거나 auth/resume envelope에 포함한다.

`server-game/src/transport/ws-transport.ts:337` — **[확인]** 서버의 `auth.ok` payload도 roomState/role과 정적 metadata뿐이다 — reconnect 당시 진행 중인 match의 식별자와 시작/종료 payload가 계약상 존재하지 않는다 — **심각도 높음** — shared protocol에서 `currentGame: { phase, matchId, ... } | null` 같은 명시적 복구 계약을 정의한다.

`server-game/src/rooms/room.ts:304` — **[확인]** bind 뒤 서버가 자동으로 다시 보내는 것은 lobby state이고, PLAYING이면 다음 full binary snapshot을 요청할 뿐이다 — full snapshot에는 `started`나 종료 결과 payload가 없어 위 누락을 메우지 못한다 — **심각도 높음** — resume 직후 lobby projection, match projection, full snapshot을 같은 세대(generation/epoch)로 묶어 보낸다.

### 6. 관전 전환이 renderer mode, camera, conceal alpha를 원자적으로 바꾸지 않는다

`client/src/game/GameCanvas.tsx:30` — **[확인]** `modeRef.current`는 render마다 바뀌지만 `SwitchEngine` 생성 effect는 mount 1회뿐이라 이후 `mode` prop 변경은 기존 엔진에 반영되지 않는다 — 탈락 후 React HUD는 spectator가 되어도 Phaser scene은 Play mode이며 기존 self-follow 정책을 유지한다 — **심각도 중간** — `setMode()`를 만들어 camera/input 상태를 명시적으로 전환하거나 mode 변경 시 의도적으로 engine을 재생성한다.

`client/src/game/internal/WorldScene.ts:560` — **[확인]** 죽은 self는 서버 `players`에서 빠져 sprite가 destroy되지만 `followedId`, `selfId`, `cameraInitialized`는 지워지지 않는다 — 탈락과 spectator 전환이 겹치면 Phaser camera가 파괴된 follow target을 계속 참조하거나 화면이 마지막 위치에 머물 수 있다 — **심각도 중간** — self 제거 시 follow를 중단하고 spectator 기본 target 또는 free camera로 넘긴 뒤, role 전환 시 다시 초기화한다.

`server-game/src/game/snapshot-view.ts:96` — **[확인]** spectator의 unfiltered snapshot은 `players`를 채운 직후 return하여 `tileAlphas`와 `selfId`를 보내지 않는다 — filtered 상태에서 spectator로 바뀌면 client가 이전 tile alpha override와 selfId를 그대로 보존한다 — **심각도 중간** — unfiltered frame에도 빈 `tileAlphas`를 명시해 conceal override를 지우고, self 의미를 null 가능 필드 또는 별도 viewer-mode section으로 명시한다.

`client/src/game/internal/WorldScene.ts:495` — **[확인]** `tileAlphas` section이 없으면 기존 값을 유지한다 — 위 spectator snapshot에서 수풀/연막의 일부가 계속 반투명하게 남는다 — **심각도 중간** — full 또는 access-mode 변경 시 생략을 “unchanged”로 처리하지 말고 access에 맞는 기본값으로 reset한다.

관전 해제(`spectating=false`)로 role이 waiting이 되면 서버 `snapshotAccess`는 `none`이 되어 binary frame이 끊기지만 client canvas는 마지막 unfiltered world를 그대로 유지한다. 관전/대기 UX를 분리하고 canvas를 숨기거나 명시적으로 clear해야 한다.

### 7. 이전 경기의 비동기 완료 콜백이 같은 방의 새 경기를 제거할 수 있다

`server-game/src/game/game-session.ts:257` — **[확인]** 종료 시 room을 POST_GAME으로 바꾼 뒤 replay 저장을 `await`하고 나서야 lifecycle `onFinished`를 호출한다 — replay store가 30초 post-game과 다음 countdown보다 오래 걸리면 같은 roomId로 새 `GameSession`이 먼저 설치될 수 있다 — **심각도 높음** — simulation session의 제거는 종료 tick에서 identity-checked 방식으로 즉시 하고, replay 저장/result 전송은 matchId 기반 독립 job으로 분리한다.

`server-game/src/game/game-lifecycle.ts:80` — **[확인]** 늦게 끝난 이전 세션의 callback이 `#sessions.delete(finished.id)`와 `scheduler.remove(finished.id)`를 조건 없이 실행한다 — 같은 방의 두 번째 경기가 이미 시작된 상황에서 첫 경기 저장 Promise가 resolve하면 새 경기가 다음 tick부터 완전히 멈춘다 — **심각도 높음** — `if (this.#sessions.get(finished.id) === finished)`일 때만 삭제하고 scheduler도 session identity 또는 `roomId:matchId` key로 제거한다.

이 경합은 저장소가 평소 빠르다는 가정으로 사라지지 않는다. 외부/로컬 I/O hang이 정확한 트리거이며, 가장 나쁜 순간에 새 경기 전체를 중단한다.

### 8. 최신 입력에 유효기간이 없어 연결만 살아 있으면 영구 이동한다

`server-game/src/rooms/room.ts:561` — **[확인]** sequence가 최신이면 `latestInput`을 보관하지만 수신 tick/시각은 저장하지 않는다 — keyup packet 전송 전에 탭이 심하게 멈추거나 main thread가 정지했는데 WebSocket close 감지는 늦는 경우 마지막 방향 입력이 계속 유효하다 — **심각도 중간** — `lastInputAtTick`을 저장하고 2~3 input 주기 이상 새 packet이 없으면 서버가 neutral input으로 전환한다.

`server-game/src/rooms/room.ts:572` — **[확인]** `resolvedInputs()`는 연결·role만 맞으면 같은 input을 매 simulation tick 무기한 재사용한다 — 이는 클라이언트 좌표 예측은 아니고 서버가 결정한 권위 이동이지만, 오래된 입력을 권위 있는 현재 의도로 오인하는 지점이다 — **심각도 중간** — input timeout을 simulation tick 기준으로 처리해 결정론을 유지하고, reconnect/disconnect의 기존 즉시 neutral 처리도 그대로 둔다.

일반적인 input 순서 역전/중복은 u16 wrap-aware `isNewerSequence`로 버려지고, disconnect 시 input을 null로 만드는 경로도 확인했다. 즉 sequence 처리보다 **staleness 부재**가 남은 문제다.

### 9. binary snapshot protocol version을 실제로 검증하지 않는다

`shared/src/protocol/snapshot.ts:84` — **[확인]** decoder는 첫 byte를 `snapshot.version`에 넣지만 `PROTOCOL_VERSION`과 비교하지 않는다 — rolling deploy나 캐시 불일치로 서로 다른 layout이 만나도 알려진 section 번호를 현재 구조로 해석해 부분 상태를 적용할 수 있다 — **심각도 중간** — header version이 다르면 즉시 `SnapshotDecodeError`를 내고 reconnect/업데이트 안내로 전환한다.

`client/src/game/GameSession.ts:284` — **[확인]** `auth.ok.protocolVersion`도 client가 확인하지 않는다 — 서버가 이미 mismatch 정보를 주는데 session이 연결 성공으로 확정된다 — **심각도 중간** — `auth.ok` 단계에서 shared `PROTOCOL_VERSION`과 비교하고, 다르면 snapshot listener를 열기 전에 비재시도 오류로 종료한다.

### 10. `World.simulationHz`는 가변처럼 보이지만 이동 dt는 전역 60 Hz에 고정돼 있다

`server-game/src/simulation/world.ts:150` — **[확인]** `createWorld`는 임의 `simulationHz`를 받는 계약을 노출한다 — 테스트나 향후 맵별 Hz에서 world가 30 Hz여도 이동 계산은 그 값을 따르지 않는다 — **심각도 낮음** — simulationHz를 고정 상수로 선언해 가변 계약을 제거하거나 모든 tick-duration 계산에 world의 값을 전달한다.

`server-game/src/simulation/movement.ts:54` — **[확인]** `integrate()`가 `SIMULATION_STEP_MS`(전역 60 Hz)를 사용한다 — world의 effect/cooldown/storm 시간은 `world.simulationHz`를 기준으로 계산하면서 이동만 다른 시간축을 쓸 수 있다 — **심각도 낮음** — `integrate(player, input, 1 / world.simulationHz)`처럼 tick dt를 명시한다.

현재 production bundle은 60 Hz로 검증되고 scheduler도 60 Hz라 실제 배포 설정에서는 값이 일치한다. 따라서 현재 경기의 비결정성보다는 미래 설정/테스트 계약의 결함이다. 같은 초기 world(PRNG state 포함), 같은 정렬된 입력이면 simulation core의 처리 순서는 playerId로 고정돼 있고 `Math.random()`을 쓰지 않으므로 현재 60 Hz 경로의 결정론은 대체로 양호하다.

## 네트워크 및 권위 모델 결론

- **순서/유실:** WebSocket은 한 연결 안에서 message 순서와 신뢰성을 제공한다. input은 최신 u16 sequence만 채택한다. snapshot은 transport 순서에 기대며 자체 monotonic guard가 없다. 재접속에서는 옛 socket callback을 identity로 거르지만, 새 연결이 놓친 lifecycle event를 복구하지 못한다.
- **스냅샷 생략:** 서버가 backpressure 때문에 의도적으로 생략한 target은 다음 frame을 full로 받아 map까지 복구한다. tile timeline change는 publish 경계까지 `#pendingTileChanges`에 누적된다.
- **서버 권위:** 이동, 충돌, 술래, 스킬, 시야, 쿨다운은 서버 권위다. 클라이언트 보간은 두 authoritative sample 사이만 보며 마지막 sample 이후 외삽하지 않는다. 로컬 camera/VFX와 HUD 반올림은 게임 판정에 되돌아가지 않는다.
- **예측:** 실경기 좌표 prediction/reconciliation은 없다. 입력 sequence ack도 snapshot에 없으므로 숨은 예측 경로도 없다. 현재 체감 지연을 줄이는 수단은 1-frame interpolation buffer뿐이다.
- **남은 권위 경계 문제:** stale input이 서버에서 무기한 현재 의도로 취급되는 점은 서버 권위 위반은 아니지만, 서버가 오래된 클라이언트 의도를 권위 있게 계속 실행한다는 의미에서 수정할 필요가 있다.

## 권장 수정 순서

1. 재접속 resume projection을 완전 상태로 만들고 `game.started`/`game.ended` 누락 테스트를 추가한다.
2. lifecycle cleanup을 session identity/matchId 기준으로 바꿔 늦은 replay Promise가 새 경기를 제거하지 못하게 한다.
3. `PlayerSprite`/Text constructor·destroy·upload source size를 계측한 뒤 visibility와 렌더 자원 수명을 분리한다.
4. 제품에서 `preserveDrawingBuffer`를 끈 A/B를 수행한다.
5. spectator 전환을 renderer mode/camera/conceal reset까지 하나의 상태 전환으로 만든다.
6. snapshot epoch/monotonic guard, input staleness timeout, protocol version fail-fast를 추가한다.

## 최종 의견

현재 엔진은 simulation 권위와 tick 처리의 큰 방향은 건전하다. 특히 map timeline 누적, playerId 정렬, seeded PRNG, snapshot backpressure 뒤 full 복구는 의도가 코드에 반영돼 있다. 반복되는 실제 장애는 수학/충돌 core보다 **수명이 다른 상태를 같은 것으로 취급하는 경계**에서 나온다. 보임/안 보임을 GameObject 생존/파괴로 연결한 것, 연결 복구를 lifecycle 복구로 간주한 것, roomId cleanup을 특정 session cleanup으로 간주한 것이 같은 종류의 문제다. 이 세 경계를 분리하는 것이 단발성 증상 수정보다 효과가 크다.
