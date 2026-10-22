# G-01C — Cross-surface security qualification

Status: Draft PR #197 (base `865c93c`). Not merged.
Invariants: SEC-INV-352 … SEC-INV-355 (`docs/security/SECURITY_INVARIANTS.md` §4.37).
Founder decisions: G-01C approval, decisions 1–9.

G-01C asks whether G-01B0 (request-id isolation), G-01A (trusted identity and attribution) and G-01B1 (governed provenance) compose safely across the Enterprise Host, the Governance Store, the evidence consumers, service principals and embedders. It is a qualification milestone: a test matrix, four bounded fixes and an evidence-based deployment classification. It is **not** a claim of multi-organization isolation, and it does **not** extend the Host's security guarantee to untrusted code that composes Frontera programmatically.

## 1. What was found

No path leads from a spoofed, forged or absent identity to execution authority: the Kernel re-decides every governed action, and no G-01 surface issues a grant. Four integrity gaps between the milestones were confirmed in code and are fixed here:

| | Gap | Reachable by | Fix |
|---|---|---|---|
| A | An attribution event passed in the Store's ordinary `events[]` input was stored and read as the requester, bypassing `assertAttributionMatchesRequest`; the record then replayed to the forged principal | in-process callers of `AocEnterprise.persistence` (embedders); not HTTP | SEC-INV-352 |
| B | The advisory route read `governedActionOrchestrator.trustDomainId` from the caller's object on every request, so mutating it after composition re-pointed the trust domain principals are held to (contradicting SEC-INV-344) | embedders; the Host builds its own options | SEC-INV-353 |
| C | The SQLite Store loaded and judged an aggregate before deciding tenant visibility, so another organization's corrupted record answered `500 GOVERNANCE_RECORD_CORRUPTED` instead of the ordinary 404 (and `reconstruct` returned its load result) | any organization-scoped reader, given a corrupted record of another tenant | SEC-INV-354 |
| D | `linkGovernanceRecord` never compared the record's organization with the Passport's: a system-scope caller could link a record the Passport can never verify | authentication off, `compat` unscoped keys, embedders | SEC-INV-355 |

Everything else found is either an accepted limitation (§4), outside the qualified profile (§3), or a hypothesis (§7). Residual sibling of D: `linkEvidenceBundle` does not compare the bundle's organization with the Passport's either (such a link never verifies; system-scope callers only); not changed here.

## 2. Trust-boundary map (shipped Host)

| Principal | Evaluate | Governed execution / reconsideration | Record reads | Full attribution | Passport · evidence · Assurance | Operator / admin |
|---|---|---|---|---|---|---|
| Customer principal | own organization, bound actor, Host trust domain | bound actor; reconsider same actor and organization | own organization, projected | withheld | own organization | 403 |
| Service principal | own organization, allow-listed actors only | 401 | 401 | — | 401 | 401 |
| Organization-scoped legacy key | own organization; actor **asserted** | 403 | own organization, projected | withheld | own organization | 403 |
| Unscoped key, `compat` | **system, any organization** | 403 | system | canonical | **system, including writes** | 403 |
| Unscoped key, `restricted` | refused at startup and at composition | — | — | — | — | — |
| Auditor | 401 | 401 | own organization, canonical | yes | 401 | 401 |
| Operator / administrator | 401 | 401 | operator views only | no | traces at most AUDITOR | by role |
| Authentication off (Host: development, loopback only) | system | 401 | system | canonical | system | 401 |

Each route matches its own credential list; no route matches a combined list containing service or auditor secrets (`g01c-security-qualification.test.ts` §1 confines the service secret on every non-evaluate route).

## 3. Qualified deployment profile

**Qualified: the single-organization secure Host**, all of:

- `AOC_ENTERPRISE_ENV=staging|production`, which the Host loader holds to `AOC_ENTERPRISE_REQUIRE_AUTH=true` and SQLite persistence;
- scoped credentials only, `restricted` legacy mode (the secure-profile default) — **no `compat`**;
- customer principals for governed actions; service principals and auditors only with explicit, reviewed permissions;
- one Host process per SQLite database file (§6);
- configuration supplied by the operator (trusted), and changed only by restart;
- client-chosen request ids unguessable (generated ids are random UUIDs).

Within that profile the residual risks are the documented ones: the intra-organization request-id existence oracle and squatting (P2-1), reconsideration by any principal bound to the same actor, asserted actors on legacy-key records, and the Passport and Assurance limitations of §4.

| Profile | Classification | Why |
|---|---|---|
| Single-organization secure Host | **Qualified** under §3's conditions | G-01B0/A/B1 guarantees hold on the composed Host over both providers; fixes A–D close the gaps between them |
| Multi-principal, single organization | **Qualified with stated limits** | P2-1 within the organization; actor-bound reconsideration; legacy keys indistinguishable (avoid them); Passport subject binding pending (§4.1) |
| Multi-organization shared Host | **Not qualified — blocked by G-01B2** | store-wide `request_id` uniqueness is a cross-tenant existence oracle and squatting surface; the governed plane, service principals and auditors are single-organization by design; `compat` is cross-organization system access |
| Programmatic Enterprise embedder | **Trusted-code integration profile only** (§5) | lower-level APIs accept caller-supplied authority by design |

## 4. Accepted limitations

### 4.1 Passport (decision 4)

- **Authoritative binding.** A Passport's `subject.agentId` is asserted by its issuer at issuance; nothing verifies it against the Kernel Authority. The only place the platform equates it with a Governance Record's `actorId` is the Assurance resolver's convention for agent and passport subjects (`assurance/evidence-resolver.ts`). There is no authoritative subject ↔ actor binding to enforce against.
- **Compatibility.** `POST /api/passports/{id}/governance` is a frozen v1 route (`API_STABILITY_V1.md` §2.4) whose documented checks are existence, tenant and digest. Four existing suites link records whose actor differs from the Passport's subject (`passport-references`, `passport-enterprise-integration`, `passport-verification`, `g01b1-provenance-isolation`). Refusing such links changes accepted v1 behaviour.
- **Disposition.** Implemented only the safe link-time check that changes no accepted valid behaviour: the record must belong to the Passport's organization (fix D — such a link already failed REFERENTIAL verification). **Subject binding is stopped for a founder decision**; it is characterized as it is (`g01c-security-qualification.test.ts` §3: another actor's record is linked and counted in the history).
- **Historical references** are not re-checked (no migration, no verify-time change), as in G-01B1.
- **Advisory vs governed.** `PassportGovernanceReference` carries no provenance. Distinguishing them needs an additive field (`provenance: 'governed-action' | 'advisory'`, `attributionBasis`) on a versioned reference contract (`aoc.agent-passport.schema.v1` is frozen) — a protected contract change, proposed, not implemented.

### 4.2 Assurance (decision 5)

Existing published scoring semantics are unchanged. What each `governance_record` metric demonstrates:

| Metric / requirement | Demonstrates | Does **not** demonstrate |
|---|---|---|
| `governance.records.count` | records exist for the subject's actor id | that the subject requested them, or that they were governed |
| `governance.records.all_verified` | (a) structural integrity: each aggregate's digests recompute | authenticated attribution (b) or governed provenance (c) |
| `governance.records.denied_count`, `indeterminate_count` | Kernel decision statuses on those records | that the subject was the requester; a legacy key can assert any actor id |
| `saf.req.governance-records` ("Verified Governance Records demonstrating governed decisions for the subject") | (a) only | its wording overstates: a legacy-asserted advisory record satisfies it (`g01c-security-qualification.test.ts` §3) |

Proposed for future approval, additive and opt-in, leaving every existing metric untouched: per-reference metadata on `governance_record` evidence (`attributionBasis`: `customer-principal` | `service-principal` | `legacy-asserted` | `unattributed`; `governedPath`: `governed-action` | `advisory`), and two new metrics — `governance.records.authenticated_count` (records with attribution basis `customer-principal` or `service-principal` naming the subject as evaluated actor) and `governance.records.governed_count` (records resolved governed by `hasGovernedActionProvenance`). A new SAF requirement version would reference them; stored assessments keep their meaning.

### 4.3 Legacy `compat` (decision 6)

An unscoped key under `compat` holds system scope on reads **and writes**: evaluate for any organization, Passport issuance and lifecycle, every Assurance write, evidence build and access-grant revocation (`g01c-security-qualification.test.ts` §3). v1 compatibility is not redefined; `compat` is excluded from the qualified profile.

## 5. Programmatic composition is a trusted-code profile (decision 7)

`createEnterprise` runs the same identity validators as the Host (service principals, auditors, legacy keys, the identity snapshot), and `AocEnterprise.evaluate` / `governAction` apply the Host's admission. It does **not** apply the Host loader's environment gates, and several lower-level APIs accept authority from their caller by design:

| API | Caller-supplied authority |
|---|---|
| `persistence` (the Governance Store) | the access context (including `{ system: true }`), the request, the result; legacy getters that read as system |
| `governedActionOrchestrator.govern(identity, intent)` | the bound customer identity (only its organization is checked) |
| `passports.*`, `passportStore` | the access context and every lifecycle `actorId` |
| `assurance.*`, `assuranceStore`, `evidenceStore` | the access context |
| `approvals.*` | the authenticated actor |
| `kernelAuthorityProvisioning`, `emergencyControlAdministration`, `authorityControlledExecution`, `obligationDischarges` | the operator / system context |
| configuration | `environment`, `requireAuthentication`, persistence provider and bind address are not gated: a `production`, in-memory, authentication-off composition is accepted (`g01c-security-qualification.test.ts` §1) |

The Host's security guarantee covers HTTP callers of a Host started by `bootEnterpriseHost` / the launcher. Code that holds an `AocEnterprise` is inside the trust boundary. Fixes A and B remove the two places found where that code could change authentication outcomes *after* validation without calling a privileged API (fix A also reads the caller's events once, so accessors cannot split the check from the record); nothing else in the embedder API is redesigned, and trusted code remains able to write any record through the raw Store.

## 6. SQLite (decision 8)

**Multi-process sharing of one SQLite database file is not qualified.** The Governance Store's append is a deferred transaction that reads before it writes; under another connection's write lock it is refused (`GOVERNANCE_STORE_UNAVAILABLE`, nothing written, retry succeeds — §1 test), and `mapSqliteError` matches only the exact code `SQLITE_BUSY`, so an extended busy code (`SQLITE_BUSY_SNAPSHOT`) would surface as `GOVERNANCE_STORE_TRANSACTION_FAILED`. Neither changes CORE-07 or historical semantics; no transaction or pragma was changed in G-01C (no change was established to preserve every durability and concurrency invariant, and the profile is single-process).

**The post-merge CI lock failure** (run 39702150821, attempt 1: `ctrl03-web-roles-host` `before` hook, "The Evidence Bundle Store could not be opened: database is locked"; attempt 2 green, 12 577 tests, 0 failures):

- Many Host-booting test fixtures (including the CTRL-02/03 fixture) set every SQLite path except `AOC_ENTERPRISE_EVIDENCE_SQLITE_PATH`, so concurrently running test processes share the repository-relative default `.data/evidence-bundles.sqlite`.
- better-sqlite3 opens connections with a 5 s busy timeout. H-3 (§7) measured it: a contended open waited **5 013 ms and then failed** although `busyTimeoutMs: 2000` was configured — the WAL conversion runs before `busy_timeout` is applied, so it waits the library default, not the configured value. The conversion does wait; it does not fail at once. The Phase 0 hypothesis (fail at once because of the pragma order) is refuted.
- H-4 (§7): 18 concurrent processes opening one fresh file all opened. The collision did not reproduce.
- What remains consistent with the evidence: another process held the shared file's lock for more than 5 s while the CTRL-03 Host booted. Not reproduced; the holder is not identified.
- Classification: **intermittent, not root-cause-resolved**. No production change. Proposed remedy, not implemented: a per-workspace `AOC_ENTERPRISE_EVIDENCE_SQLITE_PATH` in every Host test fixture (test isolation), and — as a separate, reviewable change — applying the configured busy timeout before the WAL conversion (`new Database(path, { timeout })`).

## 7. Hypotheses (TODO cases, recorded by CI)

| | Hypothesis | Outcome |
|---|---|---|
| H-1 | A lone-surrogate `requestId` is stored and verified identically by both providers | **Confirmed divergence.** In memory: stored exactly, verifies. SQLite: the request row is stored under a lossy UTF-8 encoding, so the committed aggregate is thereafter `incomplete` (its request row can no longer be found) — a false integrity alarm any evaluate caller can plant in its own organization: system scope reads `GOVERNANCE_RECORD_CORRUPTED`; with fix C every organization, the owner included, reads it as absent, since the missing request row proves no owner. P3; proposed remedy: refuse ill-formed UTF-16 `requestId` at ingress. Not fixed (outside the approved fixes) |
| H-2 | A deferred Governance Store append under another writer is refused without waiting for its busy timeout (the PROD-01 F1 pattern) | **Confirmed.** Refused after 0 ms of a 2 000 ms timeout, classified `GOVERNANCE_STORE_UNAVAILABLE`, nothing written (§1). Safety holds; multi-process is unqualified (§6) |
| H-3 | The Evidence Store's WAL conversion fails at once while another connection holds a fresh file | **Refuted.** It waited 5 013 ms (the library default, not the configured 2 000 ms), then failed closed |
| H-4 | Concurrent processes opening one fresh Evidence Store file collide ("database is locked") | **Not reproduced** (18/18 opened) |

Not reproduced, deferred: historical records adopted by the governed path before G-01B0 that carry execution references (T11) — reproducing one needs pre-G-01B0 code paths; consumers keyed on execution references (reconciliation, x402, settlement basis) would act on them while the resolver calls the record not governed.

## 8. Evidence

Suites (root suite, GitHub Actions): `src/enterprise/__tests__/g01c-security-qualification.test.ts` and `src/enterprise/__tests__/g01c-mutation.test.ts` (eight mutants: M1 Passport organization, M2 injected attribution, M3 live trust domain, M4 SQL `governed-action` clause, M5 SQLite visibility order, M6a–c G-01B0 L1 and L2 in both providers). Commits are ordered tests first; run IDs are recorded on the PR.

## 9. Deferred

G-01B2 (scoped request namespaces), Passport subject binding and reference provenance (founder decision), Assurance authenticated-provenance metrics (founder decision), evidence-path isolation of the Host test fixtures, SQLite multi-process qualification, `createEnterprise` environment gates (embedder API redesign), T11, G-02, TRADE-05.
