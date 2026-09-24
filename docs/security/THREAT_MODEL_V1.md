# Soberanía Enterprise — Threat Model (v1.0.0)

Status: release deliverable for Soberanía Enterprise v1.0.0 (PR-008).
Scope: the Enterprise Host runtime (`src/enterprise`) — HTTP adapter, Governance Store, Evidence Runtime, Agent Passport Runtime, Assurance Runtime, configuration, lifecycle — and its three SQLite stores. The Kernel and the seeded provider runtimes are in scope as trust boundaries; the `apps/` products and `packages/` libraries have their own surfaces and are out of scope here except where they share code.

Companion documents: `SECURITY_INVARIANTS.md` (canonical: every security invariant with its scope, enforcement and boundary), `NO_BYPASS_AUTHORITY_CONTROLLED_EXECUTION.md` (canonical: the complete effect-path inventory and what authorizes each effect), `SECURITY_HARDENING_V1.md` (what was audited and changed for v1), `docs/enterprise/API_STABILITY_V1.md` (frozen API surface), `docs/enterprise/MIGRATION_REVIEW_V1.md` (schema/migration behavior), `docs/operations/*` (operational response).

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

### 7.16a Bounded-grant authority durability (added by Prompt 4)

Scoped to the authoritative bounded-grant store (`src/enterprise/bounded-grant-store/`). Canonical detail and the full 29-row threat table: `AUTHORITATIVE_GRANT_STORE.md` §5. Recorded here so the restart and revocation threats are visible from the threat model rather than only from the store's own document.

The asymmetry that governs the whole design: **losing a grant fails closed; losing its revocation fails open.** In-memory, both are lost together on restart, which is closed. A naively durable store that kept grants but lost revocations would be strictly worse than no persistence at all.

| Threat | Status | Mitigation |
|---|---|---|
| Crash or restart loses an **acknowledged revocation** while keeping its grant | **BLOCKED** | One database file, one `db.transaction` writing the revocation record and the grant's reference to it, `synchronous = FULL`. There is no window between them to crash in |
| Crash during issuance leaves a partially usable grant | **BLOCKED** | Transaction rollback; a refused or thrown commit guard writes nothing |
| Restart increases authority | **BLOCKED** | Every recovery path either preserves authority exactly or removes it |
| Corrupt grant or revocation record yields a usable grant | **BLOCKED** | Record digest, artifact digest, canonical round-trip, identity and schema version verified on every authoritative read; failure throws and the exercise path reads a throw as "no grant". Never repaired, skipped or normalized |
| **Partial** deletion — the revocation row removed, or the grant's reference to it cleared | **BLOCKED** | The two records cross-reference each other; any disagreement refuses the read, because the only direction a disagreement could be resolved in is "usable" |
| A writer rewrites a record **and** recomputes its unkeyed digest | **NOT ADDRESSED** | Same class as accepted risk §8.3 and §8.2. GS-001, **Prompt 5** |
| **Restoring an older snapshot restores revoked authority** | **NOT ADDRESSED** | No anti-rollback, and none claimed. Every integrity check passes on a legitimately-older store. GS-002; see §7.17's "Rollback / downgrade to stale state" row, which is the same risk one layer up |
| Store unavailable, locked, or closed | **BLOCKED (fails closed)** | Exercise withholds and the adapter is not called. No cache, no last-known-good, no caller copy to fall back on |
| Foreign schema version, at database or row level | **BLOCKED** | The store refuses to open a foreign database *before* creating its own tables; a row with an unrecognized version is refused on read. Unknown authority state is never reinterpreted |
| A grant minted under a tampered policy pack is persisted durably | **OUT OF SCOPE HERE** | Grant-store integrity does not imply authority-policy integrity. NB-008, **Prompt 14** |

**Conditional on configuration.** All of the above describes the durable store, selected when `persistence.provider === 'sqlite'`. The default provider is `memory`, where the in-memory store's fail-closed restart behaviour is unchanged.

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

### 7.18 Generic HTTP execution adapter (added by P6)

P6 adds the first provider network effect Frontera itself ships: an operator-pinned HTTPS request from a Generic HTTP adapter, reachable only as a registry child below the bounded-grant path (EP-050; SEC-INV-062 … SEC-INV-069; `docs/enterprise/AOC_GENERIC_HTTP_EXECUTION_ADAPTER.md`).

| Threat | Control | Residual |
| --- | --- | --- |
| **SSRF** — a caller steering the request to an internal service | No caller field names a URL, origin, host, method, path structure, header, credential or payload; the intent validator rejects them and the adapter maps only operator literals and approved `ValidatedExecutionAction` fields. Path values are single encoded segments; `.`/`..` are refused. | A caller still chooses *which* pinned integration runs through `action`/`resource`, as with any routing. |
| **Private-network and cloud-metadata reachability** | Every answer of every resolution must be publicly routable (special-purpose IPv4 incl. `169.254.169.254`; IPv6 allow-list `2000::/3` minus reserved blocks; mapped/compatible/NAT64/6to4/Teredo refused); one bad answer rejects the lookup. IP-literal, `localhost`-style, single-label and trailing-dot origins are refused at startup. | A public address the operator did not intend is not detectable. |
| **DNS rebinding** | Fresh resolution per execution; the approved IP is handed to the socket through a hostname-ignoring `lookup`; the TCP peer is checked before TLS; `agent: false` forbids reuse of a socket opened under an older answer. | Node's networking stack is trusted. |
| **Redirect escape** | No redirect is followed, including same-origin; every 3xx is `unconfirmed` (its effect is uncertain — never a definite failure); `Location` is never read; `providerRef` is never dereferenced. | — |
| **Credential leakage** | Bearer or one explicit credential header, operator configuration only, snapshotted; never in URL, body, detail, result, record, ledger, log, event, health or error text; fixed-phrase details only. | The secret is process-resident (no KMS/HSM); rotation needs a restart. |
| **Header injection / request-smuggling headers** | Header names must be tokens, values visible ASCII (no CR/LF/NUL); `Host`, `Content-Length`, `Transfer-Encoding`, `Connection`, `Proxy-*`, `TE`, `Trailer`, `Upgrade`, `Expect`, `Authorization`, `Cookie` are adapter-owned or refused; duplicates refused; the adapter computes `Content-Length`. | — |
| **Post-send network ambiguity** | After `secureConnect`, any loss of certainty before a final status is `unconfirmed` → `execution_unconfirmed`, recorded as `execution-unconfirmed@<adapterId>`, replayed without re-invocation. | Not reconciled in P6. |
| **Provider status ambiguity** | Completion is declared only for 200, 201 and 204. Every other 2xx (202 Accepted means processing has not finished), every 3xx, 408 and every 5xx are `unconfirmed`, never `completed` and never `PROVIDER_UNAVAILABLE`, which is reserved for failures proven to precede transmission. | — |
| **Ambient TLS relaxation** | The transport hardcodes `rejectUnauthorized: true`, so `NODE_TLS_REJECT_UNAUTHORIZED=0` in the process environment cannot make it accept an untrusted certificate (isolated child-process regression). | — |
| **Duplicate effects from retries** | No automatic retry of any kind; at most one request per `execute()`; the write-ahead claim forbids a second `execute()` per execution identity. An operator may map `correlation.executionId` to a provider idempotency header. | Provider-side exactly-once is not guaranteed. |
| **Proxy interception** | No proxy support; no agent, dispatcher or proxy option exists; environment proxy variables are not consulted (`agent: false`). | — |
| **Lack of network-level egress containment** | None in P6: the adapter pins **its own** destination only. | SEC-INV-U03 remains unimplemented; other process code, Pinata and Stripe can still reach the network (SEC-TRUST-004). |

### 7.19 Aggregate / velocity exercise controls (added by P7)

P7 bounds *repeated* use of a bounded grant on the bounded-grant path when a deployment composes `exerciseControls`: host-declared count, amount and rolling-velocity limits admitted through a durable, atomic reservation before the adapter, conservative settlement, and exact-equality revalidation of the grant's authority binding. With P7 composed the effect ordering is reserve → fresh authoritative grant re-read and assessment → final binding revalidation → final emergency re-check → provider; no local check is atomic with the external provider (EP-051 … EP-053; SEC-INV-070 … SEC-INV-079; `docs/enterprise/AOC_EXERCISE_CONTROLS.md`). Path-local and opt-in.

| Threat | Control | Residual |
| --- | --- | --- |
| **Concurrent oversubscription** — racing callers spending the last unit twice | Sample-instant → read-usage → test-every-limit → insert in one `BEGIN IMMEDIATE` transaction; the write lock is held from the first read to `COMMIT`; all limits admitted together or none. Raced by independent connections and worker threads in tests. | One SQLite file on one host only. |
| **Multi-process SQLite races** | Every process sharing the file serializes on SQLite's write lock; the unique `execution_id` index makes one identity one reservation as a database fact. | SQLite on a network filesystem that does not honour its locking is not a distributed lock. |
| **Reservation instant predating admission** — a caller instant sampled before a write-lock wait, starting a rolling window early | The request carries no instant; the ledger samples its injected clock inside the `BEGIN IMMEDIATE` callback, after the lock is held, and uses that one instant for the window threshold, every persisted copy and the returned record. | The host clock is trusted. |
| **Crash after reservation, before the provider** | The reservation consumes from commit; nothing expires or releases it, including at startup. | Conservative availability loss; no automatic recovery (reconciliation is future work). |
| **Crash after the provider effect, before the outcome** | The pending reservation still consumes, so the capacity cannot be spent twice. The governed-action write-ahead claim still forbids a second invocation. | The effect's outcome is unknown and not reconciled. |
| **Uncertain provider outcome** | `execution-unconfirmed` (other 2xx, 3xx, 408, 5xx, post-TLS ambiguity) **settles** — never releases. | Unconfirmed effects are never reconciled. |
| **Corrupt or tampered ledger** | Every reservation a bucket names is verified before it counts — schema, record / rule / terminal-event / bucket-head digests, rule count, ordinals, instant, id derivation, policy digest — and the rolling window is applied only afterwards, to the verified instant, so an unsealed edit (a rule row's timestamp moved backwards included) cannot hide a row from verification; any failure withholds (`EXERCISE_CONTROL_LEDGER_UNAVAILABLE`); append-only triggers; unknown schema refused at open; never repaired. | Unkeyed digests are integrity detection, not authenticity: a writer who re-seals every relevant digest consistently, or deletes whole reservations and their bucket head consistently, is not detected. |
| **Ledger unavailable** | A throwing, closed or out-of-contract ledger withholds; an unreadable ledger is never an empty one. | Availability depends on the ledger. |
| **Duplicate execution identity** | Derived reservation id; identical re-delivery → `EXECUTION_ALREADY_RESERVED`, any difference → `RESERVATION_CONFLICT`; the same execution id under another grant is a conflict; no second adapter call. | Not exactly-once. |
| **Rolling-window clock rollback** | Rolling windows count every reservation after `at − seconds`, including any apparently in the future; the injected clock only, never `Date.now()`. | A clock set *forward* ages real reservations out early — the host clock is trusted. |
| **Unit mismatch / conversion abuse** | Units compared exactly; an amount limit with no amount or another unit withholds; recorded usage in another unit refuses the bucket; no FX, no conversion. | — |
| **Decimal arithmetic drift** | Canonical decimal text, one conversion from the attempt's number, `BigInt` coefficient/scale sums; no float accumulation, no `SUM()` over a `REAL` column. | Input precision is bounded by the caller's JSON / JavaScript number. |
| **Malicious caller quota fields** | No P7 field exists on any caller type; `limit`, `quota`, `budget`, `velocity`, `window`, `reservationId`, `exerciseControls`, `authorityBindingDigest`, … are undeclared intent fields and reserved `assertedContext` keys, rejected before the Kernel with zero ledger, DNS and socket activity. | — |
| **Host policy misconfiguration** | The policy's answer is validated into a frozen snapshot every time: closed keys, canonical values, ≤ 32 limits, no duplicate bucket, bounded windows; anything else withholds (`EXERCISE_CONTROL_POLICY_INVALID`). A missing policy or resolver refuses startup. | A *valid* but too-generous policy is the host's choice — the policy is trusted. |
| **Authority binding changed after issuance** | The grant carries `authorityBindingDigest`; at exercise the current binding must be byte-for-byte the same (a changed `authorityRef`, horizon, kind, source kind or justification withholds); a grant without provenance is unverifiable. | The exercise-time resolver is trusted host code. |
| **Grant expired, revoked or unreadable during the reservation** | After the reservation the grant is read again from the authoritative store and re-assessed at a fresh injected-clock instant; an expired, revoked, missing, corrupt or no-longer-covering grant is withheld with its `GRANT_EXERCISE_*` codes and the reservation released (retained if the release cannot be recorded). The validated action is built from that second read. | Residual TOCTOU: the grant can still be revoked after the final read and during provider execution. |
| **Authority binding changed during the reservation** | Revalidated again after the reservation commits and after the second grant read, against that read; a change releases the reservation and reaches no provider. The emergency control is re-read next, and nothing awaited follows before the provider. | Residual TOCTOU: the binding can still change after the final check and during provider execution — no atomic external binding, no two-phase commit. |

### 7.20 Canonical authority event stream (added by P8)

P8 records the governed-action / bounded-grant lifecycle as a durable, append-only, hash-chained, tenant-confined event stream, strictly after each fact is established, read by nothing that decides and awaited by nothing that executes (SEC-INV-080 … SEC-INV-088; `docs/enterprise/AOC_CANONICAL_AUTHORITY_EVENT_STREAM.md`). Evidence only, path-local, composed with governed actions.

| Threat | Control | Residual |
| --- | --- | --- |
| **Evidence becoming authority** — a future change that reads events to allow, issue, admit, route, retry or replay | Authority-bearing modules may name only the write-only `AuthorityEventRecorder` type (two files); recorder methods return `void`; every call site discards the call inside a catch-all; a structural test fails the build on any store/reader/verifier/projector import or any use of a recorder result. The at-most-once claim, grants, consumption and the interlock keep their authoritative owners. | Structural scans cover named source trees plus an all-of-`src/` holder scan; code outside `src/` is not scanned. |
| **Evidence becoming a control-flow dependency** — an **asynchronous** projection that is slow, unreachable or **never settles** holding a decision, the claim-to-adapter crossing, a reservation or a revocation | Reporting enqueues and returns: `void` methods, no `await` of a recorder or observer anywhere in authority-bearing source (structural scan), and even an idle stream's first append starts a microtask later, so no store work runs on the reporting caller's stack. Ordering is the projector's own two-stage queue (grant intake → per-stream append), not the caller's control flow. Never-settling regressions cover the decision, the claim, the reservation, the revocation and the outcome. | **Latency is not isolated.** Projection shares the process and the event loop; the built-in `better-sqlite3` append (lock wait, `fsync`) is synchronous work on it, and a host-supplied store may be synchronous too, so a slow store can still add process latency — it just cannot make an authority path await completion. A hostile in-process recorder can block synchronously (an infinite loop); every composed port is trusted host code (SEC-TRUST-006). Worker/thread isolation is not in Stage A. |
| **Projection failure changing an outcome** (a throwing store, a closed file, a corrupt stream) | Failures are caught at the projector and again at every call site; the module is optional and cannot take the Host out of `ready`; tests compare a no-stream, failing-store and throwing-recorder run byte for byte. | The stream can be shorter than what happened: a failed projection is not retried, and one still queued when the process stops is lost. Verification proves integrity of what is present, never completeness. |
| **Forged or premature events** — an "executed" event before execution, a committed decision that was never committed | Events are emitted only after the authoritative store or runtime returned the fact; the decision event only after commit **and** re-read + verification; there is no append path from any caller surface, and no route or SDK method reaches the stream. | Trusted in-process host code holding a host-supplied store can append well-formed events to it; the stream is not a signature. |
| **Chain fork under concurrency** | One `BEGIN IMMEDIATE` transaction per append (verify stream + head → head + 1 → insert → advance head) and `UNIQUE (stream_id, sequence)`; worker-thread races verified after every round. | One SQLite file on one host; no cross-host order. |
| **Tampering with stored events** — payload, type, instant, tenant, sequence, previous digest, deletion, head edits | Every append and read verifies the whole chain and the sealed head against each other and re-derives each event's ids from its own content; failures are reported, never repaired, and block further appends to that stream; triggers refuse `UPDATE`/`DELETE` on events and `DELETE` on heads. | Unkeyed digests: a writer who rewrites and re-seals a whole stream and its head, or deletes a stream with its head, is not detected (accepted risk 3; signatures are P20). |
| **Duplicate or conflicting facts** — retries, replays, restarts | Deterministic event ids from the source artifact; identical fact → the recorded event; different fact → `AUTHORITY_EVENT_CONFLICT`, nothing written; replays add nothing. | — |
| **Cross-tenant read or append** | Organization scope on every call with no `system` escape; stream ids derive from the organization; the stream's organization is sealed in its head; a forged stream id is refused on identity. | Stage A has no cross-tenant reader by design. |
| **Secret leakage into evidence** — customer credential, provider credential, headers, destination, provider response, asserted context | Closed per-type contract; only server-derived ids, digests, closed vocabularies, instants, adapter ids and a bounded `providerRef` are copied; credential-, JWT-, PEM-, URL-, cookie- and authorization-shaped values are refused by the store and omitted by the projector; tested through the full Host with a Generic HTTP adapter. | Pattern-based refusal cannot recognize a secret embedded in an otherwise opaque identifier; the load-bearing control is that the projector copies no caller or provider free text. |
| **Blurred execution certainty** — "unconfirmed" recorded as failed or executed | The outcome payload restates `ExecutionOutcome.status` verbatim with its layer and codes; the store refuses shapes that mix statuses. | — |

### 7.21 Durable monetary outcomes and provider certainty (added by P11)

P11 records every governed execution's exact prepared context before its provider crossing and its initial provider observation once obtained, in an immutable, tenant-confined, integrity-verified store (`docs/architecture/ADR-DURABLE-MONETARY-OUTCOMES.md`). It adds no effect path.

| Threat | Control | Residual |
| --- | --- | --- |
| **Lost provider certainty** — a confirmed success unreconstructable after restart | The observation is written durably after the runtime returns (`synchronous = FULL`); replay reads it; the Governance summary is written only after it | The external effect and the local commit are never atomic: a crash between them leaves a claim with no observation (`…_ALREADY_ATTEMPTED`) — owned by P12 |
| **Uncertainty rewritten as failure** — invites a retry of an effect that may have happened | One certainty vocabulary derived from the status; an unconfirmed observation conflicts with any later one; a malformed reference on `unconfirmed` is dropped, never `ADAPTER_ERROR`; P7 settles unconfirmed | — |
| **Self-reported success** — a caller supplying `providerRef`, a status or a certainty | Closed intent; P11 self-report vocabulary reserved in `assertedContext`; only the runtime's normalized outcome is recorded | — |
| **Forged attribution / adapter-controlled objects in the record** | Attribution only from the authenticated registry or the composed adapter; results normalized by `readExecutionAdapterResult`, copied again into plain frozen data | — |
| **Secret or destination in a durable reference** | `isRecordableProviderRef` for every adapter and again in the store; Generic HTTP credential-echo filter; no `detail`, body, header or URL persisted | A provider that encodes a secret before echoing it |
| **Corrupted record replayed as success** | Every read re-validates the closed contract and recomputes both digests; failure → `…_ALREADY_ATTEMPTED`, no fallback, no adapter | Consistent re-seal of a row and its digest (P20) |
| **Outcome store becoming authority** | No authority-bearing module imports it; one read, inside replay of an already-claimed identity | — |
| **Stranding on preparation failure** | Preparation precedes the claim and is idempotent; its failure writes no claim | A changed host grant policy between a crash and its retry can conflict the attempt (fail-closed; a new idempotency key proceeds) |

### 7.22 Execution reconciliation and resolution authority (added by P12)

P12 lets a host-composed, trusted **resolution authority** later establish whether an execution P11 left uncertain completed, records that as a new immutable resolution, and returns P7 capacity for a proven non-completion (`docs/architecture/ADR-EXECUTION-RECONCILIATION-AND-RESOLUTION-AUTHORITY.md`). It adds one provider-facing **status query** path — performed by host code, never the original effect path (`NO_BYPASS_AUTHORITY_CONTROLLED_EXECUTION.md` EP-054). Optional composition.

| Threat | Control | Residual |
| --- | --- | --- |
| **False completion** — an authority says "completed" for an effect that did not happen | Capacity stays consumed (never widened); P11 history is kept beside it; the answer is closed and bound to the attempt | A compromised or wrong authority retains capacity that could have returned (availability loss) and replays `executed` |
| **False non-completion** — an authority says "not completed" for an effect that happened | Only a durable, digest-bound resolution from the **bound** authority can return capacity; the P7 row is refused when the ledger's own history contradicts it, and stops consuming only while it agrees | A compromised authority can return capacity for money that moved — the resolution authority is a trust boundary (SEC-TRUST-009), like any trusted host dependency |
| **Resolver compromise** | No spending authority: the answer has no amount, asset, grant, budget or decision field; normalized from data descriptors only; no credentials cross the port | Host code is trusted; process compromise defeats every control |
| **Authority substitution** — another authority answering for an execution | Durable per-execution binding before the claim; resolution requires the binding digest; bindings are immutable (conflict, never last-write-wins) | A filesystem writer who rewrites and re-seals a binding (P20) |
| **Current-config provider inference after restart** | Reconciliation reads the durable binding only; a bound authority that is no longer composed is `not-composed`, never substituted; legacy executions are bound only by explicit trusted adoption | — |
| **Resolution-store tampering** | Every read re-validates and recomputes both digests; corrupt → never replayed, never used for capacity, never overwritten; a tampered P7 row fails its bucket closed | Consistent re-seal (P20) |
| **P7 release without a durable resolution** | Resolution commits first; the P7 row names its digest and is writable only through the narrow port the reconciliation service holds; an unrecordable resolution moves nothing | — |
| **Customer self-resolution** | No route, SDK method or intent field; P12 vocabulary reserved in `assertedContext`; replay never queries an authority | — |
| **Conflicting concurrent reconciliation** | One in-flight reconciliation per execution per process; `BEGIN IMMEDIATE` admits one resolution; a different answer is `conflict`; only the winner reaches P7 | Two read-only provider lookups may both run across processes |
| **Timeout as evidence / forced answers** | No TTL, poll, sweeper or timer; `unresolved` writes nothing | An execution may stay unresolved — and its capacity consumed — forever |
| **Generic providerRef dereference (SSRF)** | P12 core never parses, fetches or templates a `providerRef`; no status-URL configuration exists | — |

## 8. Accepted risks (v1)

1. **Auth off by default** — local-dev ergonomics; production posture documented and loudly flagged.
2. **No signatures / non-repudiation** — digests provide integrity, not authorship proof; constitutional constraint (no external signing infra) — revisit post-v1.
3. **Filesystem-level attacker with full re-seal capability** — out of software scope; mitigated by backups, exported artifacts, and independent verification. *Extended by Prompt 4:* this now explicitly includes the bounded-grant authority store — a writer who can rewrite a grant or revocation record and recompute its unkeyed digest defeats every check there (GS-001), and restoring an older snapshot of it restores revoked authority (GS-002). Neither is claimed to be prevented.
4. **No in-process rate limiting / no per-field length caps / lenient Content-Type / unbounded collection reads** — bounded by the 1 MiB cap and reverse-proxy guidance; additive fixes possible in v1.x without breaking the API.
5. **Reads don't re-verify digests** — verification is explicit; scheduled verification is an operational control.
6. **No Unicode normalization in canonical JSON** — deterministic as-is; normalizing now would break every existing digest.
7. **`/health` unauthenticated** — returns operational status (no secrets); standard practice for probes; restrict at the proxy if needed.
8. **Generic HTTP adapter residual risks (P6)** — the host process and the adapter configuration remain trusted; configured credentials live in process memory; there is no network namespace or firewall egress enforcement; a malicious resolver answer to a forbidden address is rejected but a malicious *public* provider may itself forward the request; `execution_unconfirmed` is not reconciled; provider-level exactly-once is not guaranteed; static credential rotation requires recomposition; the mapping language is intentionally limited. See §7.18.
9. **Exercise-control residual risks (P7)** — the host policy and the exercise-time binding resolver are trusted dependencies; process compromise defeats every control; a filesystem writer able to rewrite the ledger and re-seal its digests is trusted (no KMS/HSM authenticity); there is no distributed consensus, and separate databases on different hosts do not share quota; SQLite on an unsupported network filesystem is not distributed locking; there is no reservation reconciliation and no automatic abandoned-reservation recovery; no exactly-once; no atomic transaction with the external provider; the grant, the binding or an emergency control may change after the final check; amount input precision is bounded by the caller's JSON / JavaScript number; no FX or unit conversion. See §7.19.
10. **Execution reconciliation residual risks (P12)** — a composed resolution authority is trusted to answer provider truth and can, if compromised or wrong, falsely return or falsely retain P7 capacity; there is no cross-store atomicity between the resolution and the P7 row (the gap fails toward availability loss and is repaired by the next explicit reconcile); an execution whose provider cannot answer stays unresolved indefinitely; reconciliation is explicit only — no scheduling or monitoring (P16); integrity is not authenticity (P20). See §7.22.

## 9. Out of scope (v1)

- Distributed consensus, replication, HA (single-writer SQLite by design).
- TLS termination, network ACLs, WAF (reverse-proxy layer).
- Threat *analysis* of the `apps/agent-passport-web` SaaS app and `packages/*` libraries (separate surfaces). Their trust domains, privileged assets and route surface are no longer unmapped: see `TRUST_BOUNDARIES_AND_PRIVILEGED_ASSETS.md` §10, which inventories them and records findings TB-001, TB-002 and TB-008. That dedicated threat model now exists: `AGENT_PASSPORT_WEB_THREAT_MODEL.md` covers all 35 endpoints of `apps/agent-passport-web` with findings APW-001..APW-012. `packages/*` libraries remain out of scope here.
- Insider threat beyond attributability (the system records *who*, it cannot stop a fully credentialed actor from acting within their authority).
- Supply-chain hardening beyond dependency minimization (one runtime dependency) and lockfile pinning.
