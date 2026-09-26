# Frontera Systems Host — Deployment Guide (v1.0.0)

Deploying the Frontera Systems Host as a production HTTP service. Companion
documents: `docs/operations/RUNBOOKS_V1.md`,
`docs/operations/BACKUP_RECOVERY_V1.md`,
`docs/enterprise/AOC_ENTERPRISE_HOST.md`,
`docs/enterprise/AOC_GOVERNANCE_STORE_OPERATIONS.md`,
`docs/enterprise/AOC_ASSURANCE_OPERATIONS.md`.

## Prerequisites

- **Node.js >= 22** and a matching `npm`. The codebase compiles to
  ES2022 / Node16 modules and uses `node:` built-ins throughout.
- **better-sqlite3** (`^12.11.1`) ships prebuilt binaries for common
  platforms. If no prebuild matches your platform/Node version, `npm ci`
  falls back to compiling from source — a C/C++ toolchain (`python3`,
  `make`, `gcc`/`clang`; `build-essential` on Debian/Ubuntu) must then be
  present on the build machine. Build on the same OS/architecture you
  deploy to, or vendor `node_modules` per platform.
- A filesystem with `fsync` honesty for the data directory
  (`synchronous = FULL` is only as durable as the disk beneath it).
  Local disk or a block volume; not NFS/SMB — SQLite locking is
  unreliable on network filesystems.

## Install and build

```bash
git clone <repository> aoc-enterprise && cd aoc-enterprise
npm ci
npm run build            # tsc -b -- compiles to dist/
```

Optionally run the full release gate before packaging:

```bash
npm run validate:v1-release   # consolidated v1 gate (superset of validate:release)
```

## Start

```bash
AOC_ENTERPRISE_ENV=production \
AOC_ENTERPRISE_PERSISTENCE_PROVIDER=sqlite \
AOC_ENTERPRISE_REQUIRE_AUTH=true \
AOC_ENTERPRISE_API_KEYS='<key1>,<key2>:org-acme' \
npm run start:enterprise      # scripts/run-enterprise-host.mjs
```

The entry point (`scripts/run-enterprise-host.mjs`) calls
`createEnterpriseServer()` from the built `dist/` output, logs the listen
address, and installs `SIGINT`/`SIGTERM` handlers that run a clean
`server.close()` (reverse-order module shutdown, WAL checkpoint on store
close). Always stop the Host with `SIGTERM`, never `SIGKILL`, unless it is
unresponsive.

The Host boots with **zero registered actors/trust domains** (fail-closed
default) — seed real governance data via the recognition/authority
runtimes before routing production traffic.

## Configuration reference

All configuration is environment variables, read once at startup by
`src/enterprise/configuration/enterprise-configuration.ts`. Every variable
has a local-dev-friendly default; production overrides via the process
environment. Boolean variables accept `1`/`true` (case-insensitive) for
true. Millisecond/byte variables must be positive integers — anything
missing, non-numeric, zero, or negative silently falls back to the
default (an unreasonable value never disables a timeout or limit).

| Variable | Default | Meaning |
|---|---|---|
| `AOC_ENTERPRISE_ENV` | `development` | Deployment environment: `development`, `test`, `staging`, or `production`. Unrecognized values fall back to `development`. |
| `AOC_ENTERPRISE_VERSION` | built-in `AOC_ENTERPRISE_HOST_VERSION` | Reported Enterprise version (health endpoint, logs). |
| `AOC_ENTERPRISE_LOG_LEVEL` | `info` | Minimum log level: `debug`, `info`, `warn`, `error`. |
| `AOC_ENTERPRISE_PERSISTENCE_PROVIDER` | `memory` | `sqlite` or `memory`. Anything other than `sqlite` means `memory`. **Production must set `sqlite`** — the memory provider loses everything on restart. |
| `AOC_ENTERPRISE_SQLITE_PATH` | `.data/enterprise-host.sqlite` | Governance Store database file (`:memory:` supported). |
| `AOC_ENTERPRISE_PASSPORT_SQLITE_PATH` | `.data/agent-passport.sqlite` | Agent Passport Store database file. Independent of every other store's file. |
| `AOC_ENTERPRISE_ASSURANCE_SQLITE_PATH` | `.data/assurance.sqlite` | Assurance Store database file. Independent of every other store's file. |
| `AOC_ENTERPRISE_STORE_BUSY_TIMEOUT_MS` | `5000` | `PRAGMA busy_timeout` for the SQLite stores — bounded wait on a locked file before failing instead of an immediate `SQLITE_BUSY`. |
| `AOC_ENTERPRISE_STORE_MAX_REQUEST_PAYLOAD_BYTES` | `262144` | Enforced Governance Store append limit for request payloads. |
| `AOC_ENTERPRISE_STORE_MAX_RESULT_PAYLOAD_BYTES` | `524288` | Enforced Governance Store append limit for result payloads. |
| `AOC_ENTERPRISE_STORE_MAX_EVENT_PAYLOAD_BYTES` | `65536` | Enforced Governance Store append limit for event payloads. |
| `AOC_ENTERPRISE_STORE_MAX_TRACE_STEPS` | `500` | Enforced maximum trace steps per appended evaluation. |
| `AOC_ENTERPRISE_EVENTS_ENABLED` | `true` | In-process event publishing on/off. |
| `AOC_ENTERPRISE_TELEMETRY_ENABLED` | `true` | Operational counters on/off. |
| `AOC_ENTERPRISE_API_KEYS` | (empty) | Static bearer tokens: `"key1,key2:org-acme,key3:org-beta"`. A bare key grants access regardless of the request's organization; a `key:orgId` pair scopes the key to that organization — a request for a different organization is a 403, not a 401. |
| `AOC_ENTERPRISE_REQUIRE_AUTH` | `false` | When `true`, every API call must present a configured bearer token. |
| `AOC_ENTERPRISE_TRACE_LEVEL` | `basic` | `basic` or `full` trace detail. |
| `AOC_ENTERPRISE_HTTP_PORT` | `8787` | Listen port (`0` = OS-assigned, useful in tests). |
| `AOC_ENTERPRISE_HTTP_HOST` | `0.0.0.0` | Listen host. Bind to `127.0.0.1` when a local reverse proxy fronts the Host. |
| `AOC_ENTERPRISE_STARTUP_TIMEOUT_MS` | `30000` | Bound on module startup; exceeded = failed startup. |
| `AOC_ENTERPRISE_SHUTDOWN_TIMEOUT_MS` | `30000` | Bound on each module's `shutdown()` call. |
| `AOC_ENTERPRISE_HEALTH_CHECK_TIMEOUT_MS` | `5000` | Bound on each module's health check. |
| `AOC_ENTERPRISE_PASSPORT_REQUIRED` | `false` | `true` makes a Passport Store outage block Enterprise readiness. Default: Passport-backed recognition degrades gracefully. |
| `AOC_ENTERPRISE_ASSURANCE_REQUIRED` | `false` | `true` makes an Assurance Store outage block Enterprise readiness. Default: Assurance degrades without blocking `POST /api/governance/evaluate`. |

### Authentication is OFF by default

`AOC_ENTERPRISE_REQUIRE_AUTH` defaults to `false`: with default
configuration the Host answers every request unauthenticated, on
`0.0.0.0`. That default exists for zero-configuration local development
only. **Any deployment reachable beyond localhost MUST set
`AOC_ENTERPRISE_REQUIRE_AUTH=true` and configure
`AOC_ENTERPRISE_API_KEYS`** before it receives traffic. Failed
authentication is a 401 `AUTHENTICATION_FAILED`; a valid but
wrongly-scoped key is a 403 `AUTHORIZATION_FAILED` (or a
scope-violation code). API keys are never logged and never appear in
health output.

## Filesystem layout and permissions

With the SQLite provider the Host persists to **three independent
database files** (default directory `.data/`, relative to the working
directory):

```
.data/
  enterprise-host.sqlite        # Governance Store
  enterprise-host.sqlite-wal    # WAL sidecar (created by SQLite)
  enterprise-host.sqlite-shm    # shared-memory sidecar
  agent-passport.sqlite  (+ -wal, -shm)
  assurance.sqlite       (+ -wal, -shm)
```

- Each store creates its parent directory automatically
  (`mkdirSync(..., { recursive: true })`) with the process umask; tighten
  it yourself: the data directory should be owned by the service user
  with mode `0700`. The database files contain governance records,
  passports, and assessment evidence references — treat them as
  sensitive.
- The `-wal` and `-shm` sidecar files belong to their database. They must
  live in the same directory as the database file, and every copy,
  backup, or restore must move all files of one database **together** —
  a database restored without its `-wal` is a mixed-generation file set
  and will fail digest verification.
- Do not place the data directory on NFS/SMB.
- The three paths are independently configurable; keep all three on the
  same volume so a snapshot captures a consistent set.

## SQLite / WAL operational notes

Every store opens its database with `PRAGMA foreign_keys = ON`,
`journal_mode = WAL`, `synchronous = FULL`, and the configured
`busy_timeout`.

- **Single writer.** The Enterprise Host is a single-process,
  single-writer design. Never point two Host processes (or any other
  writer) at the same database file. `busy_timeout` exists to absorb
  transient lock contention (e.g. an online-backup reader), not to make
  multi-writer safe.
- **`synchronous = FULL`.** Every commit is fsynced. This is the
  correctness-over-throughput choice appropriate for a governance record
  store; if append latency ever becomes a problem, `NORMAL` (with WAL) is
  the documented relaxation, at the cost of possibly losing the most
  recent commits on power failure (never corruption).
- **WAL.** Readers do not block the writer. A clean shutdown checkpoints
  the WAL; after `SIGTERM` the sidecar files may legitimately remain at
  size 0 or be absent.
- **Schema version guard.** Each store records its schema version and
  refuses to open a database recorded under a different one (fail
  closed): Governance Store startup aborts with
  `GOVERNANCE_SCHEMA_VERSION_UNSUPPORTED`; the Passport and Assurance
  stores refuse to open with `PASSPORT_STORE_UNAVAILABLE` /
  `ASSURANCE_STORE_UNAVAILABLE` explaining the version mismatch. See the
  rollback runbook.

## Health checks

| Endpoint | Purpose | Semantics |
|---|---|---|
| `GET /live` | **Liveness** | 200 while the process is live, 503 otherwise. Body: `{ live, lifecycleState }`. Wire to the restart-deciding probe. |
| `GET /ready` | **Readiness** | 200 only when the module lifecycle has reached ready, 503 otherwise (body: `{ ready, lifecycleState }`). Wire to the traffic-gating probe. Readiness is false whenever a `required` store is unavailable, unwritable, or schema-incompatible. |
| `GET /health` | **Deep health** | Full report: `status`, `enterpriseVersion`, `kernelVersion`, per-module state/health (provider, writable, schemaVersion, migrationState), `configurationChecksum`. 503 only when `status` is `unhealthy`; degraded-but-serving states return 200. Use for dashboards and diagnosis, not as the load-balancer probe. No secrets, paths, or API keys are ever included. |

Until startup completes, API calls return 503 with error code
`ENTERPRISE_NOT_READY` (the error body includes the current
`lifecycleState`). Startup is bounded by
`AOC_ENTERPRISE_STARTUP_TIMEOUT_MS`.

## Recommended architecture

One Host process per store set, fronted by a TLS-terminating reverse
proxy, data on a dedicated volume.

### systemd

```ini
[Unit]
Description=Frontera Systems Host
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=aoc
Group=aoc
WorkingDirectory=/opt/aoc-enterprise
ExecStart=/usr/bin/node scripts/run-enterprise-host.mjs
Restart=on-failure
RestartSec=5
# Clean shutdown: SIGTERM -> reverse-order module shutdown -> WAL checkpoint.
KillSignal=SIGTERM
TimeoutStopSec=45

Environment=AOC_ENTERPRISE_ENV=production
Environment=AOC_ENTERPRISE_PERSISTENCE_PROVIDER=sqlite
Environment=AOC_ENTERPRISE_HTTP_HOST=127.0.0.1
Environment=AOC_ENTERPRISE_HTTP_PORT=8787
Environment=AOC_ENTERPRISE_SQLITE_PATH=/var/lib/aoc-enterprise/enterprise-host.sqlite
Environment=AOC_ENTERPRISE_PASSPORT_SQLITE_PATH=/var/lib/aoc-enterprise/agent-passport.sqlite
Environment=AOC_ENTERPRISE_ASSURANCE_SQLITE_PATH=/var/lib/aoc-enterprise/assurance.sqlite
Environment=AOC_ENTERPRISE_REQUIRE_AUTH=true
# Keep the key list out of the unit file:
EnvironmentFile=/etc/aoc-enterprise/secrets.env   # AOC_ENTERPRISE_API_KEYS=...

# Hardening
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=/var/lib/aoc-enterprise
StateDirectory=aoc-enterprise
UMask=0077

[Install]
WantedBy=multi-user.target
```

`TimeoutStopSec` should exceed `AOC_ENTERPRISE_SHUTDOWN_TIMEOUT_MS`
(default 30 s) so systemd never SIGKILLs a shutdown that is still inside
its own bound.

### Containers

- Run as a **non-root user**; the image needs only `node`, `dist/`,
  `node_modules/`, `scripts/`, and `package.json`.
- Mount a **named volume** (or host path) at the data directory and point
  all three `*_SQLITE_PATH` variables into it. Never keep the databases
  on the container's writable layer.
- Read-only root filesystem is supported: the Host writes only to the
  data directory (and stdout). Mount the volume read-write, everything
  else read-only.
- `STOPSIGNAL SIGTERM` (the default) and a stop grace period longer than
  the shutdown timeout.
- Probes: liveness `GET /live`, readiness `GET /ready`.
- **Replicas must be 1** per store set (see Scaling). Use
  `strategy: Recreate` (or equivalent) — a rolling update would briefly
  run two writers against the same volume.

## Reverse proxy

- Terminate TLS at the proxy; the Host itself is plain HTTP. Bind the
  Host to `127.0.0.1` (or a private interface) so nothing reaches it
  except through the proxy.
- The Host enforces a **1 MiB** request-body cap (oversized bodies are
  rejected 400 with the connection destroyed). Set the proxy's body
  limit to at least 1 MiB (`client_max_body_size 1m;` in nginx) so the
  Host's own limit — with its structured JSON error envelope — is the
  one clients see.
- Proxy read/send timeouts should exceed the Host's health-check timeout
  and expected evaluation latency; 60 s is a safe starting point.
- Forward the `Authorization` and `Idempotency-Key` headers unmodified.
- Do not cache or retry POSTs at the proxy; `POST
  /api/governance/evaluate` is idempotent only under a caller-supplied
  `Idempotency-Key`.

## Logging

The Host writes structured logs as one JSON object per line to
**stdout** (`level`, `message`, ISO `timestamp`, plus a closed set of
context fields — ids, statuses, durations, error codes). It never logs
secrets, bearer tokens, raw request context, evidence payloads, or full
database paths. There is no file logging and no rotation to manage: ship
stdout via your collector (journald, container log driver, Fluent Bit,
etc.) and filter/alert on `level` and `errorCode`. A distinct
`governance.audit.decision` line is emitted per decision — route it to
your audit sink.

## Scaling

- **Vertical only.** One process is the single writer for its three
  SQLite files. Do not run multiple Host processes against a shared
  database file — not on a shared volume, not behind a load balancer,
  not "read-only replicas" against the live file.
- **Per-tenant / per-domain horizontal scaling** is the supported
  pattern: each additional instance gets its **own** store set (its own
  three `*_SQLITE_PATH` files) and its own hostname/route.
- The runtime has no replication and no clustered mode in v1. Capacity
  planning is CPU (Kernel evaluation, digest computation) and fsync
  throughput on the data volume.
