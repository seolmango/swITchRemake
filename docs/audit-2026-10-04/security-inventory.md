# Independent security and isolated CI inventory

Derived on 2026-10-04 from runtime source, manifests, Dockerfiles and nginx configuration before reading existing tests, audit reports or memories. No AGENTS.md was present in the repository file inventory.

| Boundary | Implemented responsibility | Independent checks required |
| --- | --- | --- |
| Browser → nginx → matching HTTP | `/auth`, `/users`, `/rooms`, `/matches`, `/reports`, `/admin`, health/config routes; Fastify validation/resource limits; Redis IP and identity rate limits | Anonymous/account/guest separation, cookie attributes, untrusted forwarded IP, administrator denial, challenge/code single use, logout and rotation |
| Bearer token → identity | JWT access verification and session existence, typed guest claims, database account session validity | Wrong-purpose token, revoked/deleted sessions, forged actor fields |
| Matching → PostgreSQL | Account/security/consent/history records; result transaction and next-match issuance | Real migration, committed result and participants, duplicate result idempotence |
| Matching → Redis → game server | Room allocation, one-use tickets, command/result streams, membership and replay tickets | Guest/account room journey, 3 live sockets, result authorization, next match delivery |
| SMTP delivery | Gmail TLS transport is hardcoded; development sink stores purpose-scoped codes in Redis | No production SMTP credentials or egress; actual local SMTP substitute needs explicit configuration |
| Game → replay storage | Implemented local directory storage; S3 is a future configuration option without an implementation; replay signature configuration and participant-only download ticket | Disposable local volume, no cloud credentials, replay availability and one-use authorization |
| Proxy and cluster | nginx routes `/game-ws`, `/map-bundles`, `/replays`; gateway discovers game hosts in Redis | Origin denial, private game-host allowlist, IP header trust and no arbitrary forwarding |
| Runtime configuration | DB options validate required credentials/port/TLS; JWT keys distinct; session AES/HMAC keys required | Audit environment built from allowlisted generated values; never load repository `.env` |

Existing deployment stack uses persistent named volumes and a fixed compose name; it is unsuitable for audit disposal without a dedicated file/project name. No `.github` directory existed at initial inventory. Docker is installed locally but the sandbox initially denied the engine pipe. Initial inventory found existing e2e support and Azure-named scripts; those were listed only and were not read before this record.

Required isolated topology: run-scoped compose project, PostgreSQL 16 + passworded Redis 7 + local SMTP + built matching/cluster/web + Chromium runner; runtime network `internal: true`; no production hostnames, credentials, cloud mounts, repository env files or Azure execution. Only generated audit credentials, local storage, synthetic `.test` accounts and sanitized evidence are retained. Build/package downloads precede runtime isolation. Cleanup targets only the validated `switch-audit-<run>` project and its labeled volumes, never a global prune.

Coverage comparison and actual execution evidence will be recorded after this inventory.
