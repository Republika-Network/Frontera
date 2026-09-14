# Soberanía Enterprise — Threat Model (v1.0.0)

Status: release deliverable for Soberanía Enterprise v1.0.0 (PR-008).
Scope: the Enterprise Host runtime (`src/enterprise`) — HTTP adapter, Governance Store, Evidence Runtime, Agent Passport Runtime, Assurance Runtime, configuration, lifecycle — and its three SQLite stores. The Kernel and the seeded provider runtimes are in scope as trust boundaries; the `apps/` products and `packages/` libraries have their own surfaces and are out of scope here except where they share code.

Companion documents: `SECURITY_INVARIANTS.md` (canonical: every security invariant with its scope, enforcement and boundary), `SECURITY_HARDENING_V1.md` (what was audited and changed for v1), `docs/enterprise/API_STABILITY_V1.md` (frozen API surface), `docs/enterprise/MIGRATION_REVIEW_V1.md` (schema/migration behavior), `docs/operations/*` (operational response).

---

## 1. Assets

| Asset | Why it matters |
|---|---|
| **Governance records** (requests, evaluations, traces, reason codes, events) | The durable, append-only account of every governance decision. Tampering destroys the product's core claim: independently verifiable governance. |
| **Governance hash chain** (`governance_integrity`, `chain_position`, `previous_aggregate_digest`) | Total order and linkage of all records. Integrity of the chain is what makes silent record substitution detectable. |
| **Evidence bundles** | Disclosure-scoped projections of governance records handed to auditors/partners/customers. Their digests are relied upon by third parties. |
| **Agent passports & their event chains** | Event-sourced identity/lifecycle of agents. Forged lifecycle events would fabricate agent standing. |
| **Assurance assessments, findings, manual reviews, signals** | Scored assurance state per subject; drives eligibility. Poisoning them fabricates assurance posture. |
| **Assurance frameworks** (incl. `aoc.saf@1.0.0`) | The measurement standard itself. A poisoned framework silently changes what "compliant" means. |
| **API keys** (`AOC_ENTERPRISE_API_KEYS`) | The only authentication credential of the Host. |
| **The three SQLite database files** (+ WAL/SHM sidecars) | The physical embodiment of everything above. |
| **Configuration** (env vars) | Controls auth posture, store paths, payload limits. |
| **Availability of the Host** | Governance evaluation sits on critical paths of consuming systems; the Host is fail-closed, so unavailability halts governed actions (deliberately). |

## 2. Trust boundaries

1. **Network → HTTP adapter** (`node-http-adapter.ts`). Everything arriving over HTTP is untrusted, including headers, paths, and bodies.
2. **HTTP adapter → services** (governance read service, evidence service, passport service, assurance service). The adapter authenticates (when enabled) and shape-validates; services re-validate domain rules.
3. **Services → stores.** Stores enforce tenant scoping (`organization_id`) and append-only/uniqueness invariants; access contexts (`{ system, organizationId }`) cross this boundary.
4. **Host process → filesystem.** SQLite files are trusted *content* with *detectable* tampering: digests and chains make silent modification evident on `verify`, but a filesystem writer is outside the software trust boundary (see accepted risks).
5. **Enterprise ↔ Kernel.** The Kernel is same-process, deterministic, and versioned; the Enterprise Host treats its results as authoritative but records them immutably with provenance (kernel version stamped per record).
6. **Operator boundary.** Whoever controls env vars, the process user, and the data directory is fully trusted (root-of-trust).

## 3. Threat actors

| Actor | Capability |
|---|---|
| **Unauthenticated network client** | Sends arbitrary HTTP to the listener. |
| **Authenticated tenant** (org-scoped API key) | Full API access scoped to one `organizationId`; motivated to read or influence other tenants, or to inflate its own assurance posture. |
| **Authenticated system caller** (unscoped key) | Cross-tenant read/write by design; a compromised system key is a full-API compromise (not a store-integrity compromise — see §7). |
| **Malicious/compromised reviewer or signal source** | Abuses manual reviews or signals to shift assurance outcomes. |
| **Filesystem-level attacker / rogue operator** | Can edit SQLite files directly. Cannot forge digests without also recomputing every dependent digest and the chain — but *can* do that with full file control (accepted risk; mitigated by external backups & independent verification). |
| **Supply-chain** | Compromise of `better-sqlite3` (the single runtime dependency) or the build toolchain. |

## 4. Entry points & attack surfaces

1. **HTTP listener** — 34 wired routes (3 health, 5 governance, 3 evidence, 13 passport, 10 assurance; see `API_STABILITY_V1.md`). The only network surface. No TLS in-process (reverse proxy responsibility, documented).
2. **Environment variables** — parsed once at startup with fail-safe parsers (invalid numerics → defaults; booleans only `1`/`true`).
3. **SQLite files on disk** — opened at composition; schema version verified fail-closed.
4. **Composition options** — `assuranceFrameworks`, kernel providers: code-level injection points available only to whoever builds the host binary (operator trust).

## 5. Data flows (summary)

- **Evaluate:** HTTP → auth (401/403) → shape validation (400) → idempotency check (replay/409) → Kernel evaluation → *single transaction* append of the full aggregate (request, evaluation, trace, reason codes, metadata, integrity link) → post-commit event publication → response. No success response without a durable commit.
- **Evidence:** governance record → redaction pass (secret-pattern + disclosure policy) → bundle with `bundleDigest`/`recordDigest`/`verificationDigest` → immutable store. Verification recomputes all digests.
- **Passport:** append event (transactional, chained digests, contiguous sequence) → projection row updated → reconstruction on read; `verify` recomputes the whole chain.
- **Assurance:** create assessment (scope frozen) → evidence resolution (references only, cutoff-bound) → deterministic control evaluation → findings/scores/eligibility, all digest-sealed → completion freezes content; signals/reassessments never rewrite completed assessments.

## 6. Privilege boundaries

- `system: true` context ↔ tenant context: derived exclusively from the API key's `organizationId` (or auth disabled). Enforced *in the stores* (`canSeeRecord`, `requireAccessToOrganization`, `requireAssuranceTenantScope`), not just at the adapter — a bypassed adapter still cannot cross tenants.
- Framework registration: composition-time only; the registry freezes before serving traffic. No HTTP path writes frameworks. `saveFramework` requires a system context and is immutable per version.
- Manual reviews: require attributable `reviewerId` + `rationale`; controls with `requiredReviewerRole` reject reviews lacking that role; reviews only ever move a control out of `manual_review_required` via the recorded, digested review — the review itself is appended immutably.

## 7. Threat analysis

For each threat: **mitigations in place**, and residual assessment.

### 7.1 Integrity risks / tampering
- Every persisted artifact carries SHA-256 digests over canonical JSON (`aoc.canonical-json.v1`): per-section digests + aggregate digest (governance), bundle/verification digests (evidence), per-event chained digests (passport), seven section digests + assessment digest (assurance).
- Governance records are additionally chained (`chain_position UNIQUE`, `previous_aggregate_digest`), so deletion or reordering breaks linkage.
- Verification endpoints recompute everything from stored content — stored scores and digests are never trusted during verify (assurance verification re-derives domains, overall score, and eligibility).
- **Residual:** ordinary reads do *not* re-verify digests (performance choice); tampering is detected on explicit `verify`, not on `get`. Documented operational guidance: run verification on samples after restores and on schedule.

### 7.2 Replay risks
- Evaluate: `Idempotency-Key` is tenant-scoped (`org:{id}` / `global`); same key + same payload digest → recorded replay; same key + different payload → `409 GOVERNANCE_IDEMPOTENCY_CONFLICT`.
- Passport issuance: body `idempotencyKey` with subject-digest comparison; replay returns the existing passport.
- Passport events: contiguous `sequence` + `UNIQUE(passport_id, sequence)` + chain digests make replayed/duplicated events unappendable.
- **Residual:** non-idempotent writes (signals, manual reviews, finding events) can be submitted twice with distinct ids by an authorized caller — that is attributable data, append-only, and visible in history; not silently deduplicated by design.

### 7.3 Digest substitution & collision assumptions
- All digests are SHA-256 (`sha256:` + 64 hex, shape-validated via `DIGEST_PATTERN`). Preimage/collision resistance of SHA-256 is assumed (industry standard).
- Digest inputs bind context (canonicalization version, algorithm, section identity), so a digest cannot be transplanted between sections or artifact types.
- The digest module explicitly documents: integrity, **not** signatures/non-repudiation. There is no cryptographic signing in v1 (constitutional constraint: no external signature dependencies). A privileged writer who can rewrite *all* dependent digests and the chain can re-seal a store — detection then relies on out-of-band copies (backups, previously exported bundles/records whose digests no longer match).

### 7.4 Canonicalization attacks
- Single canonicalizer (`canonical-json.ts`) shared by all domains; version-pinned (`aoc.canonical-json.v1`) and refused for any other version string.
- Rejects: non-finite numbers, `bigint`, functions/symbols, circular references, non-plain-object prototypes, invalid dates. Normalizes `-0` → `0`; omits `undefined`-valued keys; sorts keys by UTF-16 code units; arrays keep order.
- Because serialization is total and deterministic over accepted inputs, "same value, different digest" requires a different value.
- **Residual:** no Unicode normalization (NFC/NFD) — two visually identical strings with different code points digest differently. This is deterministic and consistent (not an integrity break) but can surprise cross-system comparisons. Documented.

### 7.5 Race conditions & concurrency
- `better-sqlite3` is synchronous: in-process operations cannot interleave mid-transaction. Cross-process writers are serialized by SQLite locking (WAL) + uniqueness constraints (`chain_position`, `(passport_id, sequence)`, `(scope, idempotency_key)` PKs) — a lost race surfaces as a constraint violation mapped to a governed 409/validation error, never as silent double-append.
- All multi-row writes are single transactions; governance init+migration is one transaction.
- **Residual:** the passport post-append `reconstruct` runs outside the append transaction (read-after-commit; benign — reads committed state).

### 7.6 DoS / oversized & malformed payloads
- 1 MiB streaming transport cap (connection destroyed on overflow, 400); store-level caps (256 KiB request / 512 KiB result / 64 KiB event payloads → 413) bound row sizes; malformed JSON → 400; malformed percent-encoding in paths → 400 (hardened in v1: previously an uncaught exception); invalid URL → 400.
- Health endpoints are unauthenticated by design but do no expensive work.
- **Residual (accepted for v1, documented):** no in-process rate limiting, no per-string length caps below the body cap, no Content-Type enforcement, unbounded collection reads (`/events`, `/findings`). Deploy behind a reverse proxy with rate limits; see deployment guide. Node's header-size and connection limits apply upstream.

### 7.7 Path traversal / directory traversal
- No request-derived filesystem paths exist. Path parameters are `[^/]+`-matched, percent-decoded, and used solely as store lookup keys via prepared statements. SQLite file paths come only from configuration at boot.

### 7.8 SQL injection / SQLite misuse
- All values flow through prepared statements (named/positional binds), including every dynamically composed `WHERE` clause (constant fragments + bound params). Audited: zero string interpolation of data into SQL.
- The single non-literal pragma (`busy_timeout = <n>`) is validated in v1 to be a positive safe integer before interpolation.
- Pragmas: `foreign_keys=ON`, `journal_mode=WAL`, `synchronous=FULL`, bounded busy timeout — chosen for durability and constraint enforcement.
- Constraint-violation detection uses SQLite error *codes* (`SQLITE_CONSTRAINT*`) in all three stores (v1 hardening: passport/assurance previously sniffed error message strings).

### 7.9 API misuse & authorization bypass
- With `AOC_ENTERPRISE_REQUIRE_AUTH=true`: missing/unknown bearer → 401 (uniform envelope, also for synchronous auth failures — hardened in v1); org-scoped key on evaluate for a different org → 403.
- API-key matching is constant-time in v1 (SHA-256 both sides + fixed-length comparison; all keys always compared) — no timing oracle on key value or match position.
- Tenant scoping enforced at the store layer; tenant queries with a foreign org filter are rejected; a non-system context without an org gets the defensive `1 = 0` clause.
- **Residual (accepted, documented):** authentication is **disabled by default** (local-dev posture). Production deployments MUST set `AOC_ENTERPRISE_REQUIRE_AUTH=true`; the deployment guide states this prominently. Internal system surfaces (`getRequestById`, `listEnterpriseEvents`, version bookkeeping) are system-scoped by design and not tenant-filtered; they are not reachable with tenant credentials via HTTP.

### 7.10 Cross-tenant contamination
- Store-level `organization_id` scoping on every tenant-visible read/query (governance `canSeeRecord`/`resolveQueryOrganization`, passport `requireAccessToOrganization` + org-required `findByAgentId`, assurance org filters).
- Idempotency scopes are tenant-qualified for evaluate. Passport idempotency claims compare subject digests under a caller-supplied scope; issuance itself is org-validated before the claim is written.
- Assurance frameworks are deliberately global (shared standards), read-only to tenants.

### 7.11 Framework poisoning
- Frameworks are code, registered at composition, validated structurally (weights sum to 1 ± 1e-9, criteria bounds, no orphan controls), register-once, immutable per version, registry frozen before traffic. Changing a framework requires a new version + redeploy — an auditable code path, not a runtime write.

### 7.12 Evidence poisoning
- The assurance evidence resolver only *references* evidence held by the governance/evidence/passport stores; every candidate is verified (digest recomputation / chain verify) before it can support a control; contradictions (same artifact key, >1 digest) trigger the contradiction policy (fail closed to `manual_review_required`/`unknown` per framework rule); all age checks use the frozen `evidenceCutoffAt`, never the wall clock.

### 7.13 Manual review abuse
- Reviews are attributable (reviewer id + rationale mandatory), role-gated where the control demands it, digest-sealed, append-only, and only affect the specific control's evaluation through re-evaluation; completion with pending reviews is refused unless the framework's policy is explicitly `provisional`. Abuse therefore requires a credentialed reviewer and leaves an immutable, attributable trail.

### 7.14 Signal abuse & reassessment abuse
- Signals are typed (closed enum), severity/outcome derivation is deterministic per type, and a signal can never rewrite a completed assessment — worst case it marks state stale / opens findings / recommends reassessment.
- Reassessment requires an existing completed/superseded assessment, a reason, and produces a *new* assessment linked by `previousAssessmentId`; the old one is superseded, never edited. Flooding signals/reassessments is an attributable, append-only noise attack bounded by rate limiting at the proxy (documented).

### 7.15 Projection tampering
- Passport projection rows and assurance projection tables are explicitly caches; source of truth is the event log / canonical JSON, and `verify` recomputes from source. Evidence bundles/reports are one-way projections whose digests bind them to their sources.

### 7.16 Store corruption, backup corruption & recovery risks
- Corrupt governance rows surface as `GOVERNANCE_RECORD_CORRUPTED` (failures accumulated during load, not swallowed); stores never auto-repair, wipe, or recreate a damaged database.
- All three stores refuse to open a database recorded under a foreign schema version (v1 hardening for passport/assurance; governance already did) — an old binary cannot silently misread a new store, and vice versa.
- A *missing* store file is auto-created empty (deliberate fresh-install behavior) — an operator restoring service must notice the empty store; runbook instructs verifying record counts + chain head after any restore.
- Backup integrity is verifiable offline: `PRAGMA integrity_check` + running verification endpoints against a throwaway host (see `BACKUP_RECOVERY_V1.md`).
- **Residual:** raw `JSON.parse` in a few passport/assurance row mappers throws an unwrapped exception on a corrupted column (fails closed at request level via the adapter's error envelope, but as 500 rather than a corruption-specific code). Tracked as post-v1 polish.

### 7.17 Automated backup/restore tooling (`backup:v1`/`restore:v1`)

Extends §7.16 to cover the automated tooling added for the v1.0.0
portability validation
(`docs/release/AOC_ENTERPRISE_V1_PORTABILITY_REPORT.md`,
`docs/operations/AOC_ENTERPRISE_BACKUP_V1.md`/`AOC_ENTERPRISE_RESTORE_V1.md`).

| Threat | Mitigation | Accepted residual risk |
|---|---|---|
| **Backup theft** (copied off the host) | Never mitigated by the tooling itself — a backup is a full copy of governed state. `backup:v1` never sets encryption or ACLs on its output. | Operator must store backups encrypted, access-controlled, off-host (documented in `AOC_ENTERPRISE_BACKUP_V1.md` §Security). Same trust model as the manual procedure already accepted in §8. |
| **Sensitive data exposure via backup** | `backup:v1` never reads/copies `.env`, `AOC_ENTERPRISE_API_KEYS`, or any secret env var — only the three configured SQLite paths. | Governed records themselves may contain sensitive business data; this was already true of the live store and is unchanged by backup. |
| **Malicious backup substitution** (attacker swaps a legitimate backup for a crafted one before restore) | `restore:v1` validates SHA-256 checksums and SQLite `integrity_check` against the manifest before touching the target; a substituted store file whose bytes don't match its declared checksum is rejected. | If an attacker controls *both* the backup files and the manifest (i.e. fully owns the backup storage), they can recompute matching checksums for arbitrary content — checksums prove internal consistency of the backup set, not that it was produced by a legitimate `backup:v1` run. There is no external signing in v1 (§8.2); access-control the backup storage itself. |
| **Rollback / downgrade to stale state** | Every restore records `preRestoreSafetyCopy` before a destructive `--force` replacement, and the restore report/manifest both carry `source.commit` and `enterprise.enterpriseVersion` for operator review. | `restore:v1` does not itself refuse a chronologically older backup over a newer store — that decision (accepting data loss back to a known point) is inherently an operator judgment call, same as the manual restore runbook. |
| **Manifest tampering** | Any field change (checksum, schema version, format) either fails an explicit check (format/schema) or is caught transitively by the checksum check. | None beyond checksum/schema validation — see "malicious backup substitution" above for the full-compromise case. |
| **Checksum-file (`checksums.sha256`) tampering** | `restore:v1` validates against the fields inside `backup-manifest.json`, not the flat `checksums.sha256` file (which exists for human/tooling convenience, e.g. `sha256sum -c`) — tampering with only `checksums.sha256` does not affect restore's own validation. | An operator who trusts only `checksums.sha256` without also comparing it to the manifest could be misled if both are tampered together — this is the same full-compromise case as above. |
| **Path traversal** (a manifest filename escaping `stores/`) | `restore:v1` resolves every declared filename and asserts it stays contained within `stores/` before it is ever opened (`assertContained`, unit-tested and exercised in the contract suite). | None identified. |
| **Symlink attack** (a store "file" is actually a symlink to an arbitrary host path) | `restore:v1` `lstat`s every store file and refuses any symlink outright. | None identified. |
| **Restore into the wrong tenant/environment** | Out of scope for the tooling itself — `restore:v1` restores a store set as a unit; it has no concept of "tenant" (that's enforced inside the stores' own access-context checks, unchanged by restore). | Purely an operator-process risk: restoring backup A's files into environment B's configured paths. Mitigate operationally (naming conventions, the `metadata/release-context.json` commit/branch fields, change-management). |
| **Schema-version poisoning** (a manifest claims a schema version the file doesn't actually have) | `restore:v1` trusts the manifest's declared `schemaVersion` for the compatibility check, but the store is still opened through the real runtime constructor afterward, which independently reads and validates the *file's own* version table and fails closed on a mismatch — a poisoned manifest field cannot force a store open under a version it wasn't actually written with. | None identified beyond the full-manifest-compromise case above. |
| **Partial restore** (process killed mid-restore) | All validation (checksum/integrity/schema/path/symlink) completes *before* any file is copied into `--target`; the only window where a partial state is possible is after copying begins, and any post-copy failure (checksum recheck, store open/health-check) triggers cleanup of exactly what this run copied, leaving any pre-restore safety copy intact. | An external `SIGKILL` mid-copy (not a soft failure this code catches) could leave a truncated store file in `--target` with no automatic cleanup; re-running `restore:v1 --force` recovers cleanly since target-overwrite is supported and validation re-runs from scratch. |
| **Backup truncation** (I/O error mid-write leaves a short file) | `PRAGMA integrity_check` at backup time, and checksum + integrity_check again at restore time, both independently detect a truncated file. | None identified. |
| **WAL inconsistency** (reading a live WAL database unsafely) | `backup:v1` uses SQLite's Online Backup API (`better-sqlite3`'s `Database#backup()`), never a byte-level `cp`; the result is switched out of `journal_mode=wal` immediately so the artifact is one self-contained file. | Per-store consistency only, not cross-store transactional consistency while the Host is live — unchanged from the existing accepted risk in `BACKUP_RECOVERY_V1.md` ("stop the Host for strict cross-store consistency"). |
| **Recovery-copy leakage** (the `.pre-restore-safety-<backupId>/` directory left behind after a `--force` restore) | Written inside `--target`, at normal filesystem permissions, and never deleted automatically. | Operator must include it in their own backup-storage access-control scope, same as any other file under the data directory; not automatically cleaned up because it is the rollback path. |
| **Operator misuse** (`--force` used carelessly, wrong `--backup`/`--target` pair) | Refuses silently-destructive defaults (no `--force` = refuse to touch existing stores); every restore is logged to `restore-report.json` with the exact backup id and source commit used. | Cannot prevent a deliberate, authorized operator from restoring the wrong (but valid) backup on purpose — this is a process/change-management control, not a software one. |

## 8. Accepted risks (v1)

1. **Auth off by default** — local-dev ergonomics; production posture documented and loudly flagged.
2. **No signatures / non-repudiation** — digests provide integrity, not authorship proof; constitutional constraint (no external signing infra) — revisit post-v1.
3. **Filesystem-level attacker with full re-seal capability** — out of software scope; mitigated by backups, exported artifacts, and independent verification.
4. **No in-process rate limiting / no per-field length caps / lenient Content-Type / unbounded collection reads** — bounded by the 1 MiB cap and reverse-proxy guidance; additive fixes possible in v1.x without breaking the API.
5. **Reads don't re-verify digests** — verification is explicit; scheduled verification is an operational control.
6. **No Unicode normalization in canonical JSON** — deterministic as-is; normalizing now would break every existing digest.
7. **`/health` unauthenticated** — returns operational status (no secrets); standard practice for probes; restrict at the proxy if needed.

## 9. Out of scope (v1)

- Distributed consensus, replication, HA (single-writer SQLite by design).
- TLS termination, network ACLs, WAF (reverse-proxy layer).
- Threat *analysis* of the `apps/agent-passport-web` SaaS app and `packages/*` libraries (separate surfaces). Their trust domains, privileged assets and route surface are no longer unmapped: see `TRUST_BOUNDARIES_AND_PRIVILEGED_ASSETS.md` §10, which inventories them and records findings TB-001, TB-002 and TB-008. A dedicated threat model for that application is the next security prompt.
- Insider threat beyond attributability (the system records *who*, it cannot stop a fully credentialed actor from acting within their authority).
- Supply-chain hardening beyond dependency minimization (one runtime dependency) and lockfile pinning.
