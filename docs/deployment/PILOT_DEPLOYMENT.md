# Frontera Pilot Deployment (PROD-03-03)

How a technically competent engineer who has never used this repository
installs, configures, starts, verifies, identifies, restarts and reproduces a
Frontera Enterprise Host for a pilot — using only this repository, Docker and
this guide.

This guide is an **executable contract**: every command in it is run, in this
order, from a clean export of the commit being released, by
`scripts/deploy/qualify-pilot-deployment.mjs` (CI job `pilot-deployment`).

It covers the technical deployment boundary only. Who operates the Host, who
takes backups and when, incident response and the shared-responsibility model
are not part of this document.

- Host internals and every refusal: `docs/enterprise/AOC_ENTERPRISE_HOST.md`
- Every environment variable: the repository root `.env.example`
- HTTP surface: `docs/enterprise/API_STABILITY_V1.md`
- Backup and restore tooling: `docs/operations/AOC_ENTERPRISE_BACKUP_V1.md`,
  `docs/operations/AOC_ENTERPRISE_RESTORE_V1.md`

## 1. Supported deployment model

One model is supported: **a Linux container runtime with Docker Compose**,
running the image built from this repository's `Dockerfile` with the kit in
`deploy/pilot/`.

| Question | Answer |
| --- | --- |
| What process runs | `node scripts/run-enterprise-host.mjs` — the launcher over `bootEnterpriseHost()`, after the deployment preflight |
| What artifact runs | The OCI image built from `Dockerfile` (default tag `frontera-host:pilot`), from a clean clone or `git archive` export |
| Profile | `AOC_ENTERPRISE_ENV=production` — the secure profile (durable, authenticated, governed, signed, witness-anchored), fixed by the kit |
| Port / bind | The Host listens on `0.0.0.0:8787` inside its network namespace; Compose publishes it on `127.0.0.1:8787` of the machine by default |
| What must persist | Volume `frontera-state` (`/var/lib/frontera`): every Host store. Volume `frontera-witness` (`/var/lib/frontera-witness`): the witness's state and receipt key — a **separate** backup domain |
| Required configuration | `deploy/pilot/.env` (organization id, provider credential, generated secrets) and `deploy/pilot/governed-actions.json` |
| Secrets | Environment variables from `deploy/pilot/.env`: authority signing key, witness credential, operator credentials, provider credentials |
| First boot | Preflight → configuration → every store created at the current schema → composition → health gate → listen → ready |
| Restart | The same stores reopen; schema versions are verified; nothing is re-initialized |
| Migrations | None between v1 schema versions: a store must be at the schema version this build opens, or the Host refuses (§12) |
| Readiness | `GET /ready` = 200 (§9) |
| Version identity | `GET /version` (§10) |
| Customer infrastructure owns | The machine, Docker, DNS, TLS termination / reverse proxy, firewalling, the secret source for `.env`, backups of both volumes, monitoring |

The three Compose services:

| Service | Runs | Why |
| --- | --- | --- |
| `network` | an idle process | Owns the network namespace and the published port, so the Host and the witness share loopback and restarting either never takes the other's network away |
| `authority-witness` | `scripts/run-reference-authority-state-witness.mjs` | The CORE-07 authority-state freshness witness the secure profile requires. The **reference** witness: not a ledger, an HSM or a timestamping authority. Loopback only |
| `frontera` | the Host | The governed-action boundary |
| `config-check`, `witness-init` | the preflight; the one-time secret generator | Tools (profile `tools`): never started by `up`, run explicitly with `docker compose run`; no network, nothing else started |

The Host reaches the witness at `http://127.0.0.1:8444`; the Host accepts plain
HTTP to a witness only on loopback (https anywhere else), which is why the two
share a namespace. The bundled witness runs under the Compose profile
`reference-witness`, enabled by `COMPOSE_PROFILES` in `.env`. To use your own
https witness instead, delete that line and set
`AOC_ENTERPRISE_AUTHORITY_FRESHNESS_ENDPOINT`, `…_WITNESS_ID`, `…_TOKEN` and
`…_WITNESS_PUBLIC_KEY` in `.env` (in place of the generator's witness lines);
the bundled witness is then neither started nor waited for. That variant is
not part of the qualification.

The authority signing key is held in **software custody** (in the Host process
— finding AA-001, `docs/enterprise/AOC_ENTERPRISE_HOST.md` §"Authority-key
custody"). External custody (`AOC_ENTERPRISE_AUTHORITY_SIGNER_MODE=external`)
works with this image but is not part of the qualified kit.

## 2. Prerequisites

- Linux x86_64 or arm64 with Docker Engine and the Compose plugin **2.20 or
  later** (`docker compose version`; the kit uses optional dependencies,
  `depends_on.required`, introduced in 2.20). Docker is what is qualified.
- `git`, to obtain the source. Nothing else on the machine: Node.js, npm and
  the build toolchain run inside the image build.
- Outbound access to the npm registry during `docker compose build` (and to
  GitHub, from which `better-sqlite3` downloads its prebuilt binary; the image
  falls back to compiling it).
- A local disk or block volume for Docker volumes — not NFS/SMB (SQLite
  locking).

## 3. The artifact

`Dockerfile` (repository root) builds one image in two stages:

1. **build** — `npm ci` from `package-lock.json`, `npm run build`, then
   `scripts/release/write-release-identity.mjs` records the release identity
   (§10), then the runtime dependency tree is reinstalled from the same
   lockfile with `--omit=dev` for the root package and `packages/*` only.
2. **runtime** — the pinned Node 22 base image (exact version and digest), the
   compiled `dist/` and `packages/*/dist` without tests, source maps or build
   caches, the runtime `node_modules`, `scripts/` and the legal notices, owned
   by root and read-only to the `node` user (uid 1000) the Host runs as.

The build context is an allow-list (`.dockerignore`): a developer's `.env`,
databases, keys, backups, `node_modules`, `dist` and `.git` cannot reach the
image. The qualification plants canary files of each kind in the build context
and proves the image contains none of them.

The only build input is `FRONTERA_BUILD_COMMIT`. The image holds no secret and
no state.

## 4. Configuration contract

### 4.1 Fixed by the kit (`deploy/pilot/compose.yaml`, `environment:`)

Compose gives `environment:` precedence over `env_file:`, so `.env` cannot
change these.

| Variable | Value | Why |
| --- | --- | --- |
| `AOC_ENTERPRISE_ENV` | `production` | The secure profile: refuses memory persistence, missing authentication, missing governed actions, missing signer or witness |
| `AOC_ENTERPRISE_PERSISTENCE_PROVIDER` | `sqlite` | Durable state |
| `AOC_ENTERPRISE_REQUIRE_AUTH` | `true` | Every `/api/*` call is authenticated |
| `AOC_ENTERPRISE_HTTP_HOST` / `_PORT` | `0.0.0.0` / `8787` | Inside the namespace; exposure is decided by the published port (§15) |
| `AOC_ENTERPRISE_KERNEL_AUTHORITY_ENABLED` / `_REQUIRED` | `true` / `true` | Governed actions decide against the durable Kernel Authority world |
| `AOC_ENTERPRISE_GOVERNED_ACTIONS_FILE` | `/etc/frontera/governed-actions.json` | Mounted read-only from `deploy/pilot/governed-actions.json` |
| `AOC_ENTERPRISE_AUTHORITY_FRESHNESS_MODE` | `external` | CORE-07, required by the secure profile |
| every `AOC_ENTERPRISE_*_SQLITE_PATH` | `/var/lib/frontera/<registry filename>` | §6 |

### 4.2 Site settings and secrets (`deploy/pilot/.env`)

| Variable | Class | Type / valid values | Default | Purpose | If invalid |
| --- | --- | --- | --- | --- | --- |
| `AOC_ENTERPRISE_KERNEL_AUTHORITY_ORGANIZATION_ID` | REQUIRED | identifier | — (placeholder) | The one organization this Host decides for | preflight `CONFIG_PLACEHOLDER_VALUE` |
| `FRONTERA_PROVIDER_TOKEN` (name set by `governed-actions.json`) | REQUIRED, SECRET | provider credential | — (placeholder) | Credential the Generic HTTP adapter presents | `CONFIG_PLACEHOLDER_VALUE` / `HOST_SECRET_REFERENCE_UNRESOLVED` |
| `AOC_ENTERPRISE_AUTHORITY_SIGNING_KEY_ID` | REQUIRED, generated | token | — | Active authority key id | `HOST_AUTHORITY_SIGNING_KEY_REQUIRED` |
| `AOC_ENTERPRISE_AUTHORITY_SIGNING_KEY_PEM` | REQUIRED, SECRET, generated | PKCS#8 Ed25519 PEM | — | Signs bounded grants, revocations, discharges, approvals | `HOST_AUTHORITY_SIGNING_KEY_REQUIRED` / `HOST_ENVIRONMENT_INVALID` |
| `AOC_ENTERPRISE_AUTHORITY_VERIFICATION_KEYS` | REQUIRED, generated (public) | JSON array of `{keyId, algorithm, publicKeyPem}` | — | Trusted verification set; retain retired keys | `HOST_ENVIRONMENT_INVALID` |
| `AOC_ENTERPRISE_AUTHORITY_FRESHNESS_WITNESS_ID` | REQUIRED, generated | token | — | Pinned witness id | `HOST_AUTHORITY_FRESHNESS_REQUIRED` |
| `AOC_ENTERPRISE_AUTHORITY_FRESHNESS_TOKEN` | REQUIRED, SECRET, generated | ≥ 32 chars, no whitespace | — | Credential to the witness | `HOST_ENVIRONMENT_INVALID` |
| `AOC_ENTERPRISE_AUTHORITY_FRESHNESS_WITNESS_PUBLIC_KEY` | REQUIRED, generated (public) | SPKI Ed25519 PEM | — | Pinned witness receipt key | `HOST_ENVIRONMENT_INVALID` |
| one variable per `operators[].apiKeyEnv` / `administrators[].apiKeyEnv` | REQUIRED, SECRET, generated | ≥ 32 chars | — | Operator credentials (operator plane, `/api/admin/...`) | `HOST_OPERATOR_INVALID` / `HOST_ADMINISTRATOR_INVALID` |
| `AOC_ENTERPRISE_AUTHORITY_FRESHNESS_ENDPOINT` | OPTIONAL | https URL, or http to loopback | `http://127.0.0.1:8444` (bundled witness) | Your own witness | `HOST_ENVIRONMENT_INVALID` |
| `FRONTERA_PUBLISH_ADDRESS` / `FRONTERA_PUBLISH_PORT` | OPTIONAL (Compose only) | address / port | `127.0.0.1` / `8787` | Where the Host is published on the machine | Compose error |
| `AOC_ENTERPRISE_LOG_LEVEL` | OPTIONAL | `debug`, `info`, `warn`, `error` | `info` | | `HOST_ENVIRONMENT_INVALID` |
| `AOC_ENTERPRISE_STARTUP_TIMEOUT_MS`, `_SHUTDOWN_TIMEOUT_MS`, `_HEALTH_CHECK_TIMEOUT_MS` | OPTIONAL | ms | `30000`, `30000`, `5000` | Lifecycle bounds; keep shutdown below the 45 s `stop_grace_period` | |
| `AOC_ENTERPRISE_PASSPORT_REQUIRED`, `_ASSURANCE_REQUIRED` | OPTIONAL | `true`/`false` | `false` | Make an optional module's outage fail readiness | `HOST_ENVIRONMENT_INVALID` |
| `AOC_ENTERPRISE_STORE_*`, `_TRACE_LEVEL`, `_EVENTS_ENABLED`, `_TELEMETRY_ENABLED`, `_AUTHORITY_FRESHNESS_TIMEOUT_MS` / `_MAX_ATTEMPTS` / `_PROBE_INTERVAL_MS` | OPTIONAL | see root `.env.example` | safe defaults | Tuning | `HOST_ENVIRONMENT_INVALID` |
| `AOC_ENTERPRISE_API_KEYS` | OPTIONAL, SECRET, legacy | `key[:organizationId],…` | none | Legacy v1 route keys; the pilot uses operator credentials instead | |
| `AOC_ENTERPRISE_AUTHORITY_SIGNER_*` | OPTIONAL (not qualified here) | see root `.env.example` | — | External authority-key custody (CORE-02) | |
| `AOC_ENTERPRISE_VERSION` | DEPRECATED for identity | string | Host version | Only the `enterpriseVersion` field of `/health`; **not** a release identity — use `GET /version` | |

Every value is read strictly: an unrecognized enum, boolean or port refuses
startup instead of falling back to a default. A change to any variable takes
effect on the next start (`docker compose up -d` recreates the container).

**Development only, never in the pilot:** `AOC_ENTERPRISE_ENV=development|test`,
`AOC_ENTERPRISE_PERSISTENCE_PROVIDER=memory`, `AOC_ENTERPRISE_REQUIRE_AUTH=false`
(forces a loopback bind). The kit cannot be configured into any of them.

### 4.3 The governed-action file

`deploy/pilot/governed-actions.example.json` is a minimal, valid file: one trust
domain, two operators (`organization-administrator`, `observer`), one Generic
HTTP adapter and one route. Replace the provider `origin`, mapping and routes
with your own; the schema is in `docs/enterprise/AOC_ENTERPRISE_HOST.md`
§"The governed-action file". It names secrets by variable and never holds one —
an inline secret is refused. The Generic HTTP adapter reaches only public
`https://` DNS origins.

## 5. Secret injection

Secrets reach the Host as environment variables, from `deploy/pilot/.env`
(`env_file`). Produce that file however your organization handles secrets —
by hand on the host, or rendered by your secret manager or deployment tooling.
Frontera reads environment variables and nothing else; it has no secret store
of its own, and mounted secret files (`*_FILE`) are not supported.

- `.env` is gitignored; keep it `chmod 600`, owned by the deploying user.
- Placeholders have the form `<required…>`. The preflight refuses any variable
  still holding one, by name, without printing a value.
- `scripts/deploy/generate-pilot-secrets.mjs` generates the authority key pair,
  the witness credential and one random value per operator credential you name,
  and creates the witness receipt key inside the witness volume. It runs once
  and refuses a second run: a new authority or witness key would break trust in
  everything the first one signed.
- Only the witness id and witness credential reach the witness container; it
  never sees the Host's `.env`.
- No secret is written to the image, the volumes' backups, logs, `/health`,
  `/ready`, `/live`, `/version`, the preflight output or an error response. The
  qualification checks each of these byte for byte for every secret.

## 6. Persistent storage

All Host state lives under one state root, `/var/lib/frontera`, on the volume
`frontera-state`. The kit points every store at the PROD-02 portability
registry's filename (`scripts/portability/store-registry.mjs`), so
`backup:v1` / `restore:v1` see the layout they expect.

| File | Store | Composed when |
| --- | --- | --- |
| `enterprise-host.sqlite` | Governance Store: requests, decisions, traces, idempotency | always |
| `agent-passport.sqlite` | Agent Passports | always |
| `assurance.sqlite` | Assurance | always |
| `kernel-authority.sqlite` | Durable Kernel Authority world | always (kit) |
| `bounded-grants.sqlite` | Signed bounded grants and revocations | governed actions |
| `emergency-controls.sqlite` | Emergency stops | governed actions |
| `exercise-ledger.sqlite` | P7/P10 exercise ledger | governed actions |
| `authority-event-stream.sqlite` | P8 authority events | governed actions |
| `execution-outcomes.sqlite` | Execution claims and outcomes (P11) | governed actions |
| `execution-resolutions.sqlite` | P12 operator resolutions | operators configured |
| `control-plane.sqlite` | Operator-issued agent credentials, profile lifecycle | operators configured |
| `obligation-discharges.sqlite` | CORE-04 discharges (signed) | obligations declared |
| `approvals.sqlite` | CORE-05 approvals (signed) | approvals declared |
| `evidence-bundles.sqlite` | ASSURE-01 evidence bundles and traces | always |

Each file may have `-wal` / `-shm` companions. Directory `0700`, owned by uid
1000; created by the image, initialized by Docker on first mount.

The witness's state (`witness.sqlite`, `receipt-key.pem`, `receipt-key.pem.pub`)
lives on the **other** volume, `frontera-witness`. Never put it on
`frontera-state`, never back it up in the same set, never restore it together
with the Host's stores (CORE-07: restoring both to the same moment would make a
stale authority state look current).

The preflight refuses to start a Host whose stores would live on the
container's writable layer (`STORAGE_NOT_PERSISTENT`) or in a directory it
cannot write (`STORAGE_NOT_WRITABLE`).

## 7. The configuration check

```bash
docker compose run --rm config-check
```

(`npm run check:host-configuration` outside a container.) It runs the same
preflight the launcher runs before every start, and starts nothing:

| Check | Fails with |
| --- | --- |
| release identity recorded in the image matches the code | `RELEASE_IDENTITY_INVALID` |
| no variable still holds an example placeholder | `CONFIG_PLACEHOLDER_VALUE` |
| the Host's own strict parser and secure-profile rules | the Host's code, e.g. `HOST_ENVIRONMENT_INVALID`, `HOST_AUTHORITY_SIGNING_KEY_REQUIRED`, `HOST_GOVERNED_ACTIONS_FILE_INVALID`, `HOST_SECRET_REFERENCE_UNRESOLVED`, `HOST_OPERATOR_INVALID` |
| every composed store: directory writable, on a mounted volume, existing file an intact SQLite database at a schema version this build opens, no two stores on one file | `STORAGE_NOT_WRITABLE`, `STORAGE_NOT_PERSISTENT`, `STORAGE_UNAVAILABLE`, `SCHEMA_INCOMPATIBLE`, `STORAGE_PATHS_COLLIDE` |

Exit 0 when nothing failed, 1 otherwise. Output names checks, variables and
codes, never a value or a path. It does not contact the witness or the
provider; the Host does that at startup.

## 8. Build and first start (quickstart)

From a clean clone of the release you are deploying:

```bash
git clone <repository-url> frontera
cd frontera
git checkout <release-tag-or-commit>
export FRONTERA_BUILD_COMMIT="$(git rev-parse HEAD)"
cd deploy/pilot
cp .env.example .env
chmod 600 .env
cp governed-actions.example.json governed-actions.json
```

Now edit `governed-actions.json` for your provider, actions and operators
(§4.3) **before** generating secrets: the generator runs once, and it needs one
`--secret` per `apiKeyEnv` your file declares for an operator or administrator
(the example declares the two below). Then:

```bash
docker compose build
docker compose run --rm -T witness-init --secret FRONTERA_OPERATOR_KEY_ADMIN --secret FRONTERA_OPERATOR_KEY_OBSERVER >> .env
```

Edit `.env` and replace every `<required…>` value: your organization id and
your provider credential. (An operator added later gets its credential with
`docker compose run --rm -T witness-init --secrets-only --secret NAME >> .env`, without
touching any key.) Then:

```bash
docker compose run --rm config-check
docker compose up -d
docker compose ps
curl -fsS http://127.0.0.1:8787/ready
curl -fsS http://127.0.0.1:8787/version
```

`docker compose ps` shows `frontera` as `healthy` once `/ready` answers 200
(the image's health check). The operator credentials are in `.env`; the
operator plane is `/api/admin/...` (`docs/enterprise/AOC_AUTHORITY_ADMINISTRATION_API.md`).

What the first start does, in order (each a structured log line,
`enterprise.host.*`): preflight → `starting` (with the release identity) →
`configuration_validated` → `composed` (every store opened or created at the
current schema, every module initialized — atomic: on failure nothing is left
open) → `health_gate_passed` → `listening` → `ready`. Any failure before
`ready` exits 1 with one line `refused to start [CODE] …` and nothing listening.

## 9. Liveness, readiness, health

| Endpoint | Means | Use for |
| --- | --- | --- |
| `GET /live` | the process and its lifecycle are up | liveness probes / restart decisions |
| `GET /ready` | ready **and** not `unhealthy`: every required module (the governed spine, Kernel Authority, the signed grant store, P12 execution resolution when operators are configured, …) is healthy | readiness / traffic decisions; the image `HEALTHCHECK` |
| `GET /health` | the full report: `status` (`healthy` / `degraded` / `unhealthy`), modules with `required`, `posture`, signer and witness state | diagnosis |

`degraded` is still ready: an optional module is impaired, or the witness went
away after startup (existing authority is still served; revocation, discharge
and approval are refused until it returns). A required module failing makes the
Host `unhealthy` and `/ready` 503. Do not restart on `/ready` failures; restart
only on `/live` failures. None of the three needs a credential or returns one.
The operator plane's `GET /api/admin/operations/health` (PROD-03-01) is the
authenticated, operator-scoped view.

## 10. Release identity

```bash
curl -fsS http://127.0.0.1:8787/version
```

returns the identity recorded when the image was built
(`dist/release-identity.json`):

```json
{ "schema": "frontera.release-identity.v1", "product": "frontera", "package": "@aoc-enterprise/runtime",
  "version": "1.6.0", "commit": "<40-hex>", "release": "1.6.0+<12-hex>", "build": "release",
  "api": { "surface": "aoc-enterprise-host-http.v1", "endpointCount": 65 },
  "runtimeVersions": { "enterpriseHost": "1.0.0", "kernel": "1.0.0" },
  "storeSchemaVersions": { "governance": ["aoc.governance-store.schema.v1"], "execution-outcomes": ["…v2", "…v1"], "…": ["…"] },
  "canonicalizationVersion": "aoc.canonical-json.v1",
  "node": { "supported": ">=22", "running": "v22.23.1" } }
```

No environment variable sets it. An image built without
`FRONTERA_BUILD_COMMIT` reports `"build": "development"`,
`"commit": "unknown"`, `"release": "<version>+development"` — never a guess. The
same commit is on the image label `org.opencontainers.image.revision`, and the
launcher prints `release: …` at startup. `version` and `api` agree with
`release/RELEASE_MANIFEST.json` (checked in CI).

## 11. Restart

```bash
docker compose restart frontera
docker compose down
docker compose up -d
```

`docker compose stop` / `restart` / `down` send SIGTERM: the Host stops
accepting, closes the listener, shuts modules down in reverse order, closes
every store (WAL checkpoint) and exits 0 within the shutdown timeout
(`enterprise.host.shutdown_complete`); Compose waits 45 s before SIGKILL.
`down` removes containers and keeps volumes. On start the same stores reopen
and nothing is re-initialized. **`docker compose down -v` deletes both volumes
— all Host state and the witness — and is never part of operating a pilot.**

## 12. Upgrade boundary

Each store records its own schema version, and a build opens only the
versions it was built for (`docs/enterprise/MIGRATION_REVIEW_V1.md`). Where a
store's schema has moved forward, the newer build migrates the older file in
place when it opens it, inside one SQLite transaction (the execution-outcome
store v1 → v2, recorded as `migrated`): a migration that fails rolls back, the
Host refuses to start, and no half-migrated store is ever left behind. Opening
is serialized by SQLite's write lock, so two processes starting at once cannot
both migrate a file. There is no separate migration command and no backward
migration.
The technical sequence:

1. Take a backup of `frontera-state` (§14) with the Host stopped.
2. `docker compose stop`.
3. Check out the new release; `export FRONTERA_BUILD_COMMIT="$(git rev-parse HEAD)"`;
   `docker compose build`.
4. `docker compose run --rm config-check`
   — refuses (`SCHEMA_INCOMPATIBLE`) if the new build does not open the existing
   stores.
5. `docker compose up -d`; wait for `/ready`.
6. `GET /version` shows the new `release` and `commit`.

## 13. Rollback boundary

- Rolling back to the previous image is supported when no store's schema
  version moved between the two releases (the preflight of the previous image
  says so before it starts): stop, build or tag the previous release, run the
  configuration check, start, verify `/version`.
- Downgrading a store schema is **not** supported. An older build that finds a
  store at a schema version it does not know refuses to start — in the
  preflight (`SCHEMA_INCOMPATIBLE`) and, independently, in the Host itself —
  rather than reading it. Rolling back across a schema change therefore means
  the previous image **plus** a backup of `frontera-state` taken with that
  previous release (`restore:v1`), accepting the loss of everything since.
- Never restore the witness volume as part of a rollback (CORE-07).

## 14. Backup boundary

What must be preserved, not who preserves it or when:

- **Set A — `frontera-state`:** every file in §6, preserved **together** (they
  reference one another; a partial set is not a consistent Host). Take it with
  the Host stopped, or use `npm run backup:v1` semantics
  (`docs/operations/AOC_ENTERPRISE_BACKUP_V1.md`), which verifies schema
  versions and signed heads and records which secrets must come from your
  secret manager.
- **Set B — `frontera-witness`:** a different backup set, schedule and storage.
- **Not data:** `.env` (secrets: your secret manager) and
  `governed-actions.json` (configuration: your configuration management). A
  restored Set A needs the same authority verification keys and governed-action
  file.

## 15. Network, TLS and proxy boundary

- The Host speaks plain HTTP. TLS termination, certificates, HTTP/2, rate
  limiting and request logging belong to your reverse proxy or ingress.
- The port is published on `127.0.0.1` by default: put the proxy on the same
  machine, or publish on a private interface with `FRONTERA_PUBLISH_ADDRESS`.
  Do not publish it on a public interface without a proxy.
- The Host trusts no `X-Forwarded-*` header, sets no cookie and does not read
  `Host` for any decision: authentication is a bearer credential per request,
  so proxy configuration cannot widen what a caller may do. Forward
  `Authorization` and `Idempotency-Key` unchanged; allow 1 MiB request bodies;
  do not retry POSTs.
- **CORS:** the Host sends no CORS headers, so browsers cannot call it
  cross-origin, with or without credentials. The API is for servers and
  agents. There is no origin allow-list to configure.
- The operator plane (`/api/admin/...`) is served on the same listener and
  requires an operator credential. Exposing it only to your operators' network
  is a proxy-level decision (path-based allow-listing).
- Outbound: the Host calls only the `https://` origins in
  `governed-actions.json` (public addresses only) and, over loopback, the
  witness.

## 16. Startup troubleshooting

`docker compose logs frontera` shows one `refused to start [CODE] …` line.

| Code | Meaning | Fix |
| --- | --- | --- |
| `CONFIG_PLACEHOLDER_VALUE` | a variable still holds `<required…>` | replace the named variables in `.env` |
| `HOST_ENVIRONMENT_INVALID` | a variable does not parse | the message names the variable and the accepted values |
| `HOST_SECRET_REFERENCE_UNRESOLVED` | the governed-action file names an unset variable | add it to `.env` |
| `HOST_GOVERNED_ACTIONS_FILE_UNREADABLE` / `_INVALID` | `governed-actions.json` missing or malformed | the message names the field |
| `HOST_AUTHORITY_SIGNING_KEY_REQUIRED` / `HOST_AUTHORITY_FRESHNESS_REQUIRED` | generated secrets missing | run the generator (§8) — once |
| `HOST_OPERATOR_INVALID` / `HOST_CREDENTIALS_AMBIGUOUS` | operator credential too short, or one secret used twice | generate distinct values |
| `STORAGE_NOT_PERSISTENT` | no volume at `/var/lib/frontera` | restore the `frontera-state` mount |
| `STORAGE_NOT_WRITABLE` | the volume is read-only or not owned by uid 1000 | fix the mount / ownership |
| `STORAGE_UNAVAILABLE` | a store file is not an intact SQLite database | restore Set A from backup |
| `SCHEMA_INCOMPATIBLE` | a store from another release | §12 / §13 |
| `RELEASE_IDENTITY_INVALID` / `HOST_RELEASE_IDENTITY_INVALID` | the image's recorded identity does not match its code | rebuild the image |
| `HOST_NOT_HEALTHY` / a witness error | a required module or the witness failed at startup | `docker compose ps`, `docker compose logs authority-witness` |
| `HOST_COMPOSITION_INCOMPLETE` | the composed Host does not meet the secure profile | see `docs/enterprise/AOC_ENTERPRISE_HOST.md` §"Refusal codes" |

A container that refuses restarts (`restart: unless-stopped`) and refuses again
until the cause is fixed; it never becomes ready.

## 17. Not supported

- Kubernetes, Helm, Nomad, serverless platforms, or any cloud-provider-specific
  service — not built or qualified. The image is a standard OCI image and the
  model is portable, but only the Compose kit is supported.
- More than one Host process on one state volume (no replicas, no rolling
  update; SQLite has one writer).
- Network filesystems for either volume.
- External authority-key custody and an external witness are Host features but
  not part of the qualified kit.
- The CTRL-03 web console (`npm run start:control-plane`) is not in the pilot
  image.
- Mounted secret files (`*_FILE` variables).
- Store schema downgrade.

## 18. Qualification

`node scripts/deploy/qualify-pilot-deployment.mjs --commit "$(git rev-parse HEAD)"`
(CI job `pilot-deployment`) exports the repository, follows this guide with a
fresh Compose project, and requires every case:

| Case | Proven |
| --- | --- |
| D1 | clean export builds the image (`--host-build` also runs `npm ci` and `npm run build` on the host) |
| D2 | missing configuration: config check exits 1, the Host refuses, never ready, no value printed |
| D3 | valid configuration: config check exits 0, the Host becomes ready |
| D4 | containers removed and recreated with the volumes kept: every record is still there |
| D5 | `/version` matches the image's recorded identity, its label and the release manifest |
| D6 | a required dependency (the witness) down at boot: refused, never ready; P12 is a required module |
| D7 | the witness lost after startup: degraded, still live and ready; recovers |
| D8 | no state volume: refused (`STORAGE_NOT_PERSISTENT`) |
| D9 | read-only state volume: refused (`STORAGE_NOT_WRITABLE`) |
| D10 | a store at an unknown schema version: refused by the preflight and by the Host itself |
| D11 | SIGTERM: exit 0 after `shutdown_complete`; the same stores reopen |
| D12 | no secret or canary in any output, log, probe or error response |
| D13 | the image contains no `.env`, `.git`, database, key, test, cache or planted canary, and runs non-root |
| D14 | no XRPL, RLUSD, Lightning, wallet or PAY configuration |
| D15 | governed executions, their trace, agents and an emergency stop survive a restart; an idempotent replay returns the original request |

The governed actions it drives are real: an authorized action reaches the
Generic HTTP adapter, whose origin (`*.invalid`) never resolves, so it is
recorded as not sent; an unauthorized action is denied; a stopped resource is
withheld. A claimed execution with no outcome (P12) cannot be produced inside a
container without a provider on a public address; that path, including restart,
is qualified in-process by `src/enterprise/__tests__/prod0302-operator-resolution-host.test.ts`.
