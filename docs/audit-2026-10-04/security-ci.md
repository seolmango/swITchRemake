# Security and disposable CI evidence

The initial inventory in `security-inventory.md` was derived independently from runtime source and configuration before reading tests or earlier audits. This report records implementation and actual results separately. No Azure requests, deployment changes, commits or pushes were performed by this audit worker.

## Changes and reproduced defects

- Development email sink previously verified an external SMTP transport when credentials existed. It now skips transport verification; regression tests cover this. Configurable SMTP host/port/TLS and paired optional credentials enable actual local Mailpit delivery while retaining the original Gmail TLS defaults.
- PostgreSQL append-only audit triggers really rejected mutation with `P0001`; the integration assertion inspected Drizzle's wrapper instead of its cause. The bounded cause assertion now requires both the database error code and exact trigger message. The same actual-DB result fixture omitted survival XP and now uses the production XP inputs.
- npm workspace override resolution originally installed vulnerable Fastify despite the root override. The coordinating worker updated supported dependencies and pinned npm 11.21.0. A fresh Linux image's production dependency audit reports zero vulnerabilities. No host npm installation was changed by this worker.
- The audit socket guard initially rejected clients that resolve Docker DNS before connecting. It now resolves only the named internal services and accepts their exact IP addresses; arbitrary private addresses and metadata endpoints remain denied. Real Playwright API requests and SMTP signup succeeded after the correction.
- The internal HTTP browser origin lacks production HTTPS secure-context APIs by default. An actual comparison reproduced that Chromium headless shell ignores this secure-origin flag (both APIs false), while the full Chromium channel exposes both APIs. The audit uses the full channel and grants those APIs only to `http://web`, preserving actual WebCrypto verification. TLS/certificate and production proxy validation remain outside this local stack.
- Actual Redis interruption reproduced HTTP readiness hanging behind the global rate counter before the controller could report failure. HTTP counter operations now use a separate Redis connection with a 2-second command deadline, no offline queue and no resend of unacknowledged commands; blocking stream readers retain their separate policy. Guards reject unavailable/stalled counters with 503 within 2 seconds. Targeted fail-closed/recovery and stalled-counter regressions passed (19 related tests).

## Isolation and CI contract

Actual PostgreSQL 16, passworded Redis 7, Mailpit, matching API, gateway/supervisor/game workers, nginx, and Chromium run under a unique `switch-audit-<run>` Compose project. Names, volumes, synthetic secrets and database are generated per run. The launcher rejects cloud/database destination inheritance and remote Docker contexts; repository environment files are never loaded. The Docker network is internal, app socket destinations are restricted, and browser contexts reject external requests. Runtime caps bound CPU, memory, process count and test time.

Build-time dependency/browser downloads and a normalized npm advisory query use internet before application runtime starts; that temporary query has no application env or mounts. Images and GitHub actions are pinned by digest/SHA. Push/PR core and scheduled/manual extended use free Ubuntu runners, read-only repository permissions, no stored application secrets, bounded job time, concurrency cancellation and 14-day sanitized evidence. Cleanup removes only the explicitly validated project's containers and volumes. Existing local and Azure stacks are untouched.

## Actual local results so far

The real stack built all workspaces, applied migrations, and reached healthy readiness. Linux typechecks, client lint and all existing workspace unit tests passed in the initial core gate. The real database integration suite passed after the two fixture corrections. Runtime egress probes denied Gmail, a non-audit destination and cloud metadata.

The corrected focused Chromium UI run passed real SMTP signup, all required consent, normal login, profile, logout, portrait settings and administrator live overview/player lookup (3 tests). After the full Chromium channel correction, actual training movement/modifier settings and keyboard modal closure passed (49.3 seconds). The coordinating worker's focused security run passed both HTTP/WebSocket/session probes and synthetic real-PostgreSQL result authorization/transfer checks. These focused successes are not a full core pass. Focused browser runs now preserve separate timestamped summaries to prevent later runs from replacing earlier evidence.

The latest full core gate passed every typecheck, client lint and all workspace unit tests, then passed seven of eight browser tests in the same run. The multiplayer movement/result timing remains unresolved after an actual game.started barrier; supported low-power UI settings with three separate browser processes under the bounded two-CPU runner are being tested. This is still not a complete core pass.

Actual fault probes passed all 11 checks: PostgreSQL stop → readiness 503 → start/readiness 200 → same session/database record; Redis stop → readiness 503 → six-second observation with unchanged game child PID 71 and count 1 → recovery 200; matching-process restart with session/database persistence; and real replay storage write denial/recovery. `faults.json` records the checks and Linux process evidence. These are bounded interruption/restart probes, not active-game network partitions.

Actual scaling and final complete core/extended results must be appended only after execution. Implemented probes alone are not evidence of success.

## Explicit coverage limits

TLS/certificates; SMTP retry/duplicate delivery; packet loss; active-game network partition; resource exhaustion; prolonged retention; physical mobile/touch devices; and full recorder game-end handling under replay storage failure remain unverified by the local bounded probes. Local replay write-denial/recovery probes exercise the real storage adapter, not the full game-end recorder. A successful dynamic scaling claim requires both browser/result checks and actual Linux `/proc` child-process evidence for 1 → 2 → 1.
