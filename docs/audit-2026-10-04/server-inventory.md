# Server inventory derived from current implementation

Date: 2026-10-04. Initial derivation deliberately excluded historical reports, memory, and existing tests. No AGENTS.md found in workspace. No production connections performed.

## Features and states

- Match control plane issues CREATE_ROOM, RESERVE_JOIN / RESERVE_RESUME, RELEASE_SEAT, KICK_USER, GRANT_MATCH, ADOPT_ROOM, DRAIN_SERVER and DELETE_REPLAY through per-server Redis streams.
- RoomManager owns local room membership. Rooms move ALLOCATING -> WAITING -> COUNTDOWN -> PLAYING -> POST_GAME -> WAITING / CLOSED. Host commands change map, host, lock, kick and start; member commands change slot/loadout, leave, spectate. Training has one participant and immediate start, respawn, no closing storm/timeline.
- Admission uses expiring in-memory single-use opaque ticket + reservation binding; authenticated WebSockets bind actor, room and player identifiers server-side. One active connection per actor and per-IP/process connection limits apply.
- Binary inputs are fixed-length, versioned 6-byte states with wrap-aware sequence checks. JSON has exact envelope/payload validation. Simulation controls movement/collision/skills/tagging/storm/elimination and snapshots filter by viewer access. Disconnection immediately eliminates a match participant while preserving its reconnect slot.
- GameSession publishes match end, replay finalization and result callback. ResultOutbox retries Redis delivery in memory and blocks new starts when full. Match server grants subsequent match IDs after persistence.
- Registry advertises room directories, seat claims, health/load and internal addresses. Gateway routes exact server WebSockets and map/replay HTTP downloads; address allowlist is configured independently of heartbeat. Replay HTTP access consumes an opaque Redis ticket atomically.
- Supervisor reads heartbeat/load, spawns ephemeral-port local workers, scales with cooldown/min/max and asks workers to drain. Drain hands waiting rooms to other workers; active matches stay local until completion.

## Authority and trust boundaries

| Boundary | Authority / expected contract |
| --- | --- |
| Browser -> gateway/game transport | URL, headers, origin, frames and connection timing untrusted; ticket grants only reserved actor/room, payload cannot select actor. |
| Transport -> room -> world | Role/state/host checked in room; simulation validates actual skill effect; snapshots/events must not reveal hidden opponents. |
| Match -> Redis -> game commands | Redis is trusted private control plane; runtime codec validates payloads; requestId caches repeated operations. |
| Game -> Redis -> result persistence | Game emits authoritative gameplay outcome; match must validate issued match/roster and consume once before XP/stat changes. |
| Redis registry -> gateway/supervisor | JSON and destination must be validated; stale/malformed/failed reads must not cause unsafe routing or unbounded scaling. |
| Game -> replay filesystem | Storage keys stay below configured directory; finalization may overlap rematch and must not remove newer session. |

## Initial hypotheses to reproduce (not findings)

1. Gateway upstream response stream errors after headers may escape request error listener; aborted downstream downloads may leave upstream alive.
2. Supervisor treats Redis read failure as an empty healthy population and overlapping interval ticks may overspawn; heartbeat JSON currently cast without shape validation.
3. ResultOutbox admits starts by queue length rather than reserving capacity for active games; simultaneous finishes during outage could overflow and lose a completed result.
4. Waiting-room handoff may overlap host start/changes between exported copy and acknowledgement; subsequent-match grant is not exported.
5. Auth ticket admission happens before delayed socket binding; close/timeout during minimum response delay needs seat/connection cleanup verification.

This inventory was saved before reading existing test files. Subsequent sections will record concrete reproductions and validations.

## Concrete reproductions and repairs

| ID | Observed before repair | Repair | Local verification |
| --- | --- | --- | --- |
| S1 | A three-member Room finishes, receives successor, returns WAITING; exported migration lacks playedGames / grantedMatchId. Adoption treats completed match as first issuance. Locked room is also reopened. | Carry/restore played history, successor grant and locked state in ADOPT_ROOM. Directory exposes only unplayed pendingMatchId. | Original focused assertion failed with undefined != 1; Room export/adoption/start/no-grant regressions pass. |
| S2 | Loopback HTTP upstream sends Content-Length=100 and partial body then stalls. Proxy client never receives an aborted body, reproduction times out after 2 seconds. | Bound response-stream errors/abort; destroy truncated downstream; stop upstream work when downstream aborts. | Original network regression timed out; repaired gateway 19/19 pass, including a healthy next request. |
| S3 | Synthetic supervisor Redis failure resolves as [] and invokes minimum-capacity replacement logic despite unknown capacity. | Return unknown capacity on read failure, skip scaling, serialize asynchronous ticks, validate fresh bounded counters, contain spawn/error callbacks. | Original assertion [] != null fails; outage/schema tests and supervisor 13/13 pass. |
| S4 | During awaited handoff xAdd, host starts a game. Handoff then closes source with one running session. | Draining callback forbids new WAITING starts with SERVER_DRAINING. Existing COUNTDOWN and PLAYING continue. | docs/audit-2026-10-04/repro-handoff-race.cjs (1-second bound, no network): before start=true/sessions=1; after start=false/sessions=0, moved=1. game 267/267 pass. |
| S5 | Match issuance is bound to source worker; adopting worker's next result would be rejected. Delivery retry also discards an existing successor after its server binding changes. | Authenticated resume rebinds only directory-authorized pendingMatchId; completed match authority remains unchanged. Result worker routes successor to current private directory owner and rebinds only that pending grant. Existing successor retries remain idempotent. | Pre-repair changed-owner retry assertion returns null; repaired result service/worker focused 17/17 pass. Synthetic isolated PostgreSQL concurrency/transfer checker added, execution pending at this checkpoint. |
| S6 | Source forgetRoom retains tracked seats; its next publish deletes the adopter's same-room active claim. Successful adoption also omits renewal registration, so transferred claims expire after 30 seconds. | Forget transferred tracked/pending cleanup, delete only own server claims, and register all adopted seats after successful whole-roster CAS. | Two minimal registry regressions failed before repair (claim undefined; TTL 1 != 30000); game 269/269 pass after repair. |
| S7 | Redis succeeds but registered heartbeat capacity is empty while two local OS children remain alive. The minimum-capacity decision returns up even when maxServers is already two, bypassing cooldown repeatedly. | Apply a separate hard local child-process cap to up decisions; count starting and draining children until their exit event. Asynchronous ticks remain serialized. | Before guard minimal same decision path returns up != hold; after guard live children 2/3 hold and 1 still up; supervisor 15/15 pass. Actual normal scale/PID integration remains pending. |

The first full match suite comparison found 264 pre-existing passes plus the new failing S1 reproduction. After repairs and additions game is 267/267. A full match suite run reached 211 pass, one skipped integration and one new test assertion failure caused by incorrect expected stream suffix; corrected focused match suite is 17/17. Full latest suite and actual Docker-stack browser/DB verification are being run by the parent/CI coordinator.

## Security integration artifact

e2e/audit/security.spec.ts is bounded to AUDIT_STACK=true and http://web. It includes positive account and WebSocket authentication/map/ping baselines; disallowed Origin; foreign session deletion; foreign room resume; unauthenticated/admin denial; seven invalid JSON and five invalid binary frames; ticket reuse; logout revocation; two simultaneous requests with one refresh-cookie generation and family-reuse revocation. A second test intentionally injects labelled synthetic result transactions into isolated PostgreSQL, verifying concurrent single commit, unchanged duplicate stats, three participant rows and target-only unplayed issuance migration. These synthetic transaction tests are distinct from the parent's real three-browser complete-game proof. No tokens are included in assertions, traces or artifacts. Targeted TypeScript compile passed.

## Remaining boundary / explicit limitation

Waiting-room handoff still has no atomic durable two-party ownership commit. The existing source confirmation window is shorter than the command deadline; late adoption and directory/claim publication failures can leave ambiguous source/target ownership. The drain-start guard repairs the reproduced running-game destruction without pretending to solve that distributed failure mode. Full crash/late-adopt fault verification needs a separate migration protocol and bounded two-worker integration scenario. In-memory result outbox is also not crash-durable; process loss during Redis failure loses queued results. Initial concurrent-finish overflow hypothesis was not reproduced under normal maxRooms=100 versus outbox capacity=10000 and successor-grant backpressure.

Latest host verification: server-game 269/269; server-gateway 19/19; server-supervisor 15/15; server-match 212/212 runnable checks (one explicit database integration skip in the ordinary unit command). game/gateway/supervisor typechecks passed. Scaling policy overrides now reject invalid capacity bounds, non-finite numbers, overlapping thresholds and out-of-bound cooldowns. All DB/browser completion claims remain delegated to the disposable stack run.

Security integration selfreview corrected refresh concurrency expectations to the current implementation contract: a copied cookie's two requests during the ten-second grace both return 201 with the same successor; replay after eleven seconds returns 401 and revokes the family, including successor access. Positive session/Origin/map/ping baselines remain required. No authentication policy was weakened.

The reusable bounded guest bot tool and real scaling spec are documented in bots.md. The scaling workload uses six authenticated guests, real room admission and 10Hz binary input, policy min1/max2/up3/down1.3/cooldown5s, and asks for independent Linux child-PID proof alongside Redis heartbeats. It checks the existing three-person match, then starts and persists a three-person match in the migrated room, with adopted active claim renewal beyond its initial 30-second TTL. The code and strict TypeScript checks are ready; actual isolated integration execution is pending at this checkpoint.
