# Disposable local and CI audit

This stack builds the real client and all backend workspaces, migrates actual PostgreSQL, runs passworded Redis, captures mail through local Mailpit SMTP, and writes signed replays to a run-scoped volume. It never loads the repository `.env`, reuses existing servers, authenticates to Azure, or mounts cloud credentials. The runtime Docker network is internal and Node socket destinations are allowlisted; browser tests block external HTTP destinations. Build-time npm/apt/Chromium downloads require internet before isolation.

One command, including cleanup on normal success/failure:

```sh
AUDIT_RUN_ID=local-unique node scripts/audit-stack.cjs run core
```

PowerShell:

```powershell
$env:AUDIT_RUN_ID = 'local-unique'
node scripts/audit-stack.cjs run core
```

For interactive inspection, keep the same `AUDIT_RUN_ID` for each command:

```sh
node scripts/audit-stack.cjs up core
node scripts/audit-stack.cjs test core
node scripts/audit-stack.cjs browser core ui.spec.ts
node scripts/audit-stack.cjs scaling extended
node scripts/audit-stack.cjs faults extended
node scripts/audit-stack.cjs down
```

`up` prints the internal web address, any available loopback mapping, and secret-file path. Do not print or publish `.audit/<run>/runtime.env`. `rebuild` rebuilds changed code in the same validated disposable project; `refresh` updates runner test sources for focused iteration. `refresh-backend` recompiles the backend sources using the already-installed dependencies for local iteration; clean CI always performs a fresh `npm ci`. `browser` reruns the named browser specs without repeating already-passed unit gates, optionally with a bounded `--grep` pattern. `run extended` also executes every audit browser spec, verifies Linux worker processes actually change 1 → 2 → 1, and runs bounded PostgreSQL/Redis interruption/recovery, matching-server restart with session/database persistence, and actual local replay write failure/recovery. Fault probes preserve their synthetic token only in TTL Redis storage, never artifacts.

Core covers typechecks, client lint, all workspace unit tests, runtime egress denial, three member Chromium contexts completing two matches and DB/replay checks, account signup/mail/training UI, and HTTP/WebSocket security probes. Backend workspaces have no configured lint script, so their static check is TypeScript. A failed stage explicitly marks dependent stages `not-run`. GitHub push/PR runs core on `ubuntu-24.04`; scheduled/manual runs add extended. Jobs have bounded time, CPU/memory/process limits, no application secrets, read-only repository permission, SHA-pinned actions and run-scoped names. PostgreSQL/Redis/nginx/Node/Mailpit images are pinned to locally verified registry digests. The audit backend uses npm 11.21.0 to resolve workspace security overrides consistently; the host npm installation is unchanged.

Evidence is copied into ignored `e2e/artifacts/audit/<run>` and text is scrubbed for generated environment secrets, bearer/JWT tokens and credential JSON fields. Trace/video/raw server logs are excluded. Only JSON/Markdown/text/XML/HTML and synthetic-screen PNGs are accepted. CI retains evidence for 14 days. Cleanup uses only the explicit generated project/file/env and deletes its volumes; it never calls Docker prune. Cancellation/timeout additionally invokes the CI `always()` cleanup step. Existing `switch-internal`, Azure resources, and ordinary local database containers are outside this scope.

Dependency audit rejects high/critical production dependencies after the backend image build and before runtime startup. Its advisory fetch uses a temporary container with internet routing and no application env or mounts; only normalized vulnerability metadata is preserved. The credential scanner checks tracked files for high-confidence credential patterns and tracked environment files; this is a bounded baseline scanner, not a comprehensive secret-detection product.

The internal `http://web` browser origin receives full Chromium secure-context APIs explicitly so real WebCrypto map/replay verification runs; Chromium headless shell was observed to ignore this origin flag, so the full channel is required. This does not test TLS, certificates or production proxy configuration. The socket guard resolves only named internal services and allows their exact IP addresses, including IPv6-mapped addresses; other private network addresses remain denied.

Remaining coverage limits: network partitions with an already-running active game, full-game replay write failure semantics, SMTP retry/duplicate delivery, resource exhaustion, prolonged retention, packet loss and mobile/touch browser input are not implied by the bounded restart/storage probes. The scaling spec covers actual two-worker drain, waiting-room handoff, migrated-room game completion and DB owner/result persistence; this claim requires both browser and OS process gates to pass. Unit tests or other audit specs may cover portions; they must not be presented as full real-stack fault coverage.
