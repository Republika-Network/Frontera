# ASSURE-01 — Unified Authority-to-Outcome Trace: Qualification

- **Roadmap item:** `docs/architecture/FRONTERA-MASTER-PLAN.md` §9 ASSURE-01 (depends on CORE-01, soft — VERIFIED).
- **Purpose (Master Plan):** expose and verify the per-request trace; include grant, outcome and resolution in evidence bundles; make the bundle store durable.
- **Exit criterion (Master Plan):** *a third party can fetch and verify one request's full trace via API.*
- **Branch:** `feat/assure-01-unified-authority-outcome-trace`, from `main @ 614a52c` (the PROD-02 merge).
- **Security records:** `THREAT_MODEL_V1.md` §7.29; `SECURITY_INVARIANTS.md` §4.24 (SEC-INV-226 … SEC-INV-237) and claim 16h; CORE-06 matrix rows `TM-7.29-1 … 28`.
- **Mutation evidence:** `docs/security/evidence/assure01-mutation-evidence.json`.

## 1. The principle: a projection, not a second truth

The canonical governed-action spine is unchanged:

```
GovernedAction → Kernel decision / Governance Record → BoundedGrant → controls / exercise / claim
              → Execution Adapter → P11 outcome → P12 resolution → P8 events / evidence
```

ASSURE-01 adds a **read-only correlation and verification layer** over it. The
trace is rebuilt on every read from each canonical store's own verifying read,
stored nowhere, read by nothing that decides, and it never becomes an
authorization engine, a grant / outcome / resolution store, an audit truth or a
behavioural engine. Every component it shows carries the identity and digest it
was read under, so a third party can re-check it against its source.

## 2. Discovery: the per-request artifact inventory (proven from code)

| Stage | Canonical id(s) | Store | Organization binding | Correlation to the request | Integrity / authenticity | Readable before ASSURE-01 | In the trace |
|---|---|---|---|---|---|---|---|
| Governed request | `requestId = aoc.gar:` + H(org, principal, idempotency key) | Governance Store (`governance_requests`) | `request.organizationId` | **the spine** | per-record SHA-256 digests, aggregate chain (unsigned) | `GET /api/governance/requests/{id}` (API keys) | by reference (actor, action, resource, times, payload digest — never the payload) |
| Decision | `evaluationId`, `decisionId` | Governance Store (`governance_evaluations`, trace, events) | via the request | `evaluation.requestId` | aggregate digest, store verification | `GET /api/governance/evaluations/{id}[/verify]` | status, reason codes, aggregate digest, chain position |
| Authorization reference | `aoc.gar.ref:` H(evaluation, grant) | Governance Store references | via the record | `authorization_artifact`, digest = grant digest | reference chain digests | inside the record | expected-set + digest cross-check |
| Bounded grant | `aoc.grant:` H(grant body) | bounded-grant store | `scope.organization` | `grant.correlation.{requestId, decisionId}`; holder = actor | **Ed25519**-signed, verified on every read (CORE-01) | admin route only (`/api/admin/authority/grants/{id}`) | id, digest, times, source digest, binding digest, exercised flag — subject checked, never disclosed |
| Revocation | grant id | bounded-grant store | as grant | grant id | **Ed25519**-signed revocation, signed revocation-state commitment | admin route | revokedAt, reason, issuerRef |
| Approval request / verdicts | `approval-request:` H(org, request, decision, subject) | approval store (`approval_records`) | store-bound organization | rows keyed by `requestId`, carrying `decisionId` | **Ed25519**-signed chain head (CORE-05) | operator plane only | kind, actor, subject digest, row digest — never the subject text, evidence or note |
| Obligation discharges | row sequence | obligation-discharge store | store-bound organization | `{requestId, action, resourceScope}` | **Ed25519**-signed chain head (CORE-04) | none | type, outcome, source, row digest — never the reference |
| Emergency stop | — | emergency-control store | — | **no per-request record** — only the P11 withheld observation and the Governance outcome summary record it | digest chain | admin route | through the outcome stage (`withheldBy`) |
| Write-ahead claim | `aoc.gar.ref:` H(execution) | Governance Store reference | via the record | `externalId = executionId` | reference chain | inside the record | presence + claim instant |
| Execution attempt | `executionId = aoc.exec:` H(requestId, decisionId) | P11 (`execution_attempts`) | `organizationId` | request, evaluation, decision, grant ids | attempt digest (unsigned) | admin execution → grant lookup only | schema, grant, action, times, attempt digest; amount and typed parameters under their own field |
| Reservation | `aoc.exercise-reservation:` H(grant, execution) | P7 ledger | none (derived from the grant) | grant + execution | per-record digests | none | state, terminal reason, resolution |
| Initial observation | `executionId` | P11 (`execution_terminal_observations`) | `organizationId` | attempt digest | observation digest; Governance summary digest | none | kind, certainty, failure, withheldBy + codes, adapter, providerRef, observation digest |
| P12 binding | `executionId` | P12 (`execution_resolution_bindings`) | `organizationId` | attempt digest | binding digest | none | authority, origin, binding digest |
| P12 resolution | `executionId` | P12 (`execution_resolutions`) | `organizationId` | attempt, binding, basis observation digests | resolution digest; Governance summary digest | none | certainty, failure, authority, providerRef, digests |
| P8 events | `aoc.aev:`…, stream `aoc.aes:` H(org, requestId) | P8 (`authority_events`) | `organizationId` | references per event type | hash chain + head (unsigned) | none | sequence, id, type, times, chain digests (payload cross-checked, not copied) |
| Evidence bundle | `bundleId` | **was in-memory only** | `source.organizationId` (only when disclosed) | `evaluationId` | three digests (unsigned) | `/api/evidence/*` | v2 carries the disclosed trace |

**One stable correlation spine: the governed request id.** Every other identity
is either derived from it exactly (execution, stream, reservation ids) or read
from the canonical record that names it (the grant from the P11 attempt and
the Governance `authorization_artifact` references; approvals keyed by request
id; obligations by `{requestId, actionType, resourceScope}` exactly as the
Kernel correlates them). No timestamp or similarity join exists anywhere.

**Current-state facts confirmed before design** (Master Plan §3.6 / §3.8): the
EvidenceBundle and its service/API existed; a bundle was an immutable
projection of one Governance Record, integrity-only; the Bundle Store was
memory-only (`providerKind: 'memory'`); P8 is the authority event stream
(integrity, best-effort projection, no read route); P11 is durable attempt and
observation state; P12 holds bindings and resolutions (no resolver ships on
the Host); CTRL-03's evidence read assembles the Governance Record, its
references and the store's verification — not one trace. One fact differed
in detail: `/api/evidence/*` authorizes **static API keys only** (operator,
administrator and agent credentials get `401`), and a v1 bundle whose policy
hides the organization was unreadable by that organization's own key — fixed
by ASSURE-01 (bundle ownership is now the store's column).

## 3. The trace contract (`aoc.authority-trace.v1`)

`src/enterprise/evidence/trace-contracts.ts`. One object per governed request:
identities (`requestId`, `organizationId`, `evaluationId`, `decisionId`,
`executionId` when the path can reach one), the decision `path`, the
`finalState`, and eleven stages — `request`, `decision`, `approval`,
`obligations`, `authority` (grants + revocations), `execution` (claim +
attempt), `parameters`, `reservation`, `outcome`, `resolution`, `events`.
It answers who requested, what action over what resource, under which
organization, which decision, which grant authorized or nothing did, which
approvals and obligations mattered, whether execution was claimed, by which
adapter, with what initial outcome, whether reconciliation was required and
what resolved it, which events prove the progression, and which source
records can be re-read.

**Presence vocabulary** (every stage): `recorded`, `not-applicable` (the
decision path never leads here), `not-reached` (could, did not), `unresolved`
(began, no definitive answer), `missing` (another canonical record requires it
and it is absent), `unreadable` (it failed its store's own integrity or
authenticity checks), `not-composed`, `none-recorded`. **Final state:**
`denied`, `indeterminate`, `approval-pending`, `not-executed`,
`withheld-at-exercise`, `executed-confirmed-completed`,
`executed-confirmed-not-completed`, `executed-unconfirmed`,
`claimed-outcome-unrecorded`, `resolved-confirmed-*`, `unverifiable` when a
store the request depends on failed its own checks, or `inconsistent` when
any correlation check fails. An execution answered before P11 existed (a
claim whose only answer is a digest-less Governance summary — its replay
source) is shown as that summary (`outcome.legacy`), with the final state it
states, never as unanswered. A later stage never makes an earlier one look
successful; a denial has no execution id; an unconfirmed outcome is
`executed-unconfirmed` until a P12 resolution exists.

**Read order.** The P8 stream is read (and verified) first, then the
Governance Record is re-read, then every other canonical store. Every event is
written strictly after its fact, so each event read reports a fact already
committed when its store is read: a fact committing mid-build shows as a
missing anchor (incomplete evidence, later `progressed`), never as a sealed
contradiction. Governance outcome and resolution **summaries** are checked
against the canonical records they summarize, text and digest.

**Completeness is relative to the observed path**: what must exist is derived
from the committed decision and the Governance execution ledger (authorization
references, claim, outcome and resolution summaries), and checked against the
P8 anchors — never from what happens to be present.

**Lookup identity:** the governed request id `POST /api/governed-actions`
returns. No separate trace id exists. A closed format (`aoc.gar:` + 32 lowercase
hex) is required before any store is read.

## 4. Verification (`aoc.authority-trace-verification.v1`)

Every check is returned with its category; none is collapsed:

| Category | What it establishes |
|---|---|
| contract | version and identity formats recognized; the decision status is known |
| integrity | each store's own verifying read succeeded (Governance verify, P8 chain, P11/P12/P7 digests, approval and obligation chains); cross-store digests agree (grant ↔ Governance reference, observation ↔ outcome summary, resolution ↔ resolution summary) |
| authenticity | **only** where the artifact is itself signed: grants and revocations (`authenticated-durable`), the approval and obligation chain heads (`durable-authenticated`); otherwise `not-applicable` with the store kind |
| correlation | every component belongs to this request, decision, execution, grant and reservation; event payloads match their records; no fabricated component on a path that cannot have it |
| completeness | every component the observed path requires is present, including the P8 anchors |

`verified` is true only when no check in any category failed. Each result
carries the canonical trace digest, the final state, and a boundary statement:
integrity, correlation and completeness — **not** authenticity of the trace
(ASSURE-02).

## 5. Bundle reconciliation — compatibility decision

Master Plan §7: *Bundle vs stream — reconcile in ASSURE-01.* Decision: **a new
bundle version referencing a versioned trace**, not additive fields on v1 and
not a reinterpretation.

- `evidence.bundle.v2` carries every v1 section plus `trace` (the trace
  disclosed under the bundle's policy) and `integrity.traceDigest`, bound into
  `verificationDigest` (`bundleDigestInputV2`, `verificationDigestInputV2`).
- Five **new** v2 policies (`evidence.disclosure.{full,auditor,partner,customer,public}.v2`)
  classify the ten v1 fields plus twelve trace fields (`trace.summary` and one
  per stage), validated as exact partitions at module load. The v1 policies are
  untouched: their field lists are embedded in every historical v1 bundle and
  re-checked on verification.
- v1 builds (`{ evaluationId, level }`), digests and verification are
  unchanged; a trace attached to a v1 bundle is refused. A v1 bundle built by
  the pre-ASSURE-01 code (fixture generated at `main@57f3369`, whose evidence
  code is identical to `614a52c`) verifies byte for byte.
- Verifying a v2 bundle rebuilds the canonical trace now, discloses it under
  the bundle's own policy and compares stage by stage: `matches` (freshness
  `current`), `progressed` (every disclosed fact still exactly true —
  recursively: an open sub-record may be answered, an append-only list may
  grow at its end, a recorded object may gain only later-by-nature keys such
  as a revocation or a resolution; freshness `superseded-by-later-facts`) or
  `contradicted` (invalid) — a replaced P12 binding or a changed attempt
  digest is a contradiction even while its stage was still open. Final
  states move only along a closed successor table, so even a PUBLIC bundle
  (summary only) detects a contradiction.
- Building again at the same level: an unchanged trace returns the bundle
  already stored (idempotent); a changed one is stored and the earlier bundle
  of the same organization, request and policy is marked `SUPERSEDED` in the
  same transaction — every still-active bundle of that request, version and
  policy, read under the write lock, so two concurrent builds never leave two
  active bundles — and its content never changes.

## 6. Disclosure model (Truth ≠ Disclosure)

No stage, at any level including FULL, carries a request or result payload, an
approval subject or evidence body, a revocation note, an obligation reference,
a credential, a signer identity or a provider response; the grant's subject is
checked but never disclosed (it would re-expose the requester). Per level:

| Level | Stages disclosed |
|---|---|
| FULL / AUDITOR | all eleven, plus the summary and the organization |
| PARTNER | summary, decision, authority, execution, outcome, resolution — not who asked, approvals, obligations, amounts or parameters, ledger state or events |
| CUSTOMER | summary, decision, outcome, resolution |
| PUBLIC | summary only |

Sub-fields follow the field that governs them: a revocation's issuer (a human
identity) is hidden wherever approvals are; the adapter, router, provider
handle and resolution authority — including the adapter named after `@` in a
Governance summary — wherever the authority is. **FULL is internal**: an
organization-scoped credential receives at most AUDITOR for a trace or a v2
bundle (`403 EVIDENCE_DISCLOSURE_NOT_PERMITTED`); only a system-scope
credential may request FULL. (v1 builds keep their original semantics.) A v2
bundle's verification is disclosed under its own policy: below AUDITOR it
carries the verdict, the categories, the final state and the id-free names of
failing checks — no details and no canonical digest.

Below AUDITOR the store-wide Governance chain position is not disclosed (it
would reveal other organizations' volume). The summary's presence map is
disclosed at every level by design: it states whether each stage happened,
never what it contained.

Identities (request, evaluation, decision, execution ids) are disclosed at
every level, as v1 already discloses request, evaluation and decision ids. The
same secret-redaction pass as v1 runs over every disclosed trace.

## 7. The durable Evidence Bundle Store

`src/enterprise/evidence/sqlite-evidence-store.ts`, schema
`aoc.evidence-bundle-store.schema.v1`, `AOC_ENTERPRISE_EVIDENCE_SQLITE_PATH`
(default `.data/evidence-bundles.sqlite`). Its own file — never the Governance
Store.

- **Composition:** whenever persistence is `sqlite`; posture `evidenceStore`
  (`durable` / `ephemeral`); the secure profile requires `durable`. A health
  module (`aoc.enterprise.evidence-bundles`, optional) reports it.
- **Rows:** the bundle's exact canonical bytes, its identity columns, the
  owning organization (independent of what the bundle discloses), a row digest
  over every immutable column; `UNIQUE` bundle id checked inside
  `BEGIN IMMEDIATE`; content-immutability and no-delete triggers.
- **Lifecycle:** `GENERATED → VERIFIED → EXPORTED`, any → `SUPERSEDED`
  (terminal); forward-only by trigger and by both providers' code; every
  transition appended to `evidence_bundle_transitions`; a backward move is a
  no-op, never a rewrite.
- **Every read** re-derives the row digest, the bundle's own digest under its
  version's rule, the identity columns, and the lifecycle as the replay of its
  log; anything that does not hold is `EVIDENCE_STORE_CORRUPT` (HTTP 500 with a
  fixed message), never repaired. Lists are bounded (`LIMIT 100`, newest).
- **Schema guard** before any `CREATE`: an unknown version, or bundle rows
  without a version record, are refused unopened. WAL, `synchronous = FULL`,
  bounded busy timeout, idempotent close, `verifyAll()` for restore checks.

## 8. PROD-02 interaction

The store is durable Host state, so it is **registry store fourteen**
(`evidence-bundles`, condition `always`, `versions-table` with migration
state, opened on restore's scratch copy through its own factory and
`verifyAll()`); the `EXCLUDED_DURABLE_STATE` entry "evidence-bundle-store:
in-memory only" is gone. The PROD-02 detector was not weakened: the
classification and converse tests stand, the structural count moved 13 → 14,
and the Host-level registry ↔ composition cross-check passes unchanged (the
store is opened on every durable variant it boots). The portability fixture
now seeds and compares the durable bundles. Current statements were updated to
fourteen; PROD-02's dated qualification evidence (thirteen stores, its drill
observations) is left as recorded.

## 9. HTTP API and the tenant/auth model

| Method + path | Behaviour |
|---|---|
| `GET /api/evidence/traces/{requestId}?level=…` | the trace disclosed at `level`; closed query (exactly one `level`); pure read |
| `GET /api/evidence/traces/{requestId}/verify` | the structured verification; no query; pure read |
| `POST /api/evidence/build` `{ requestId, level }` | a v2 bundle (additive: `{ evaluationId, level }` still builds v1, its unused fields still ignored as before — except `requestId`, now the v2 discriminator, which must not accompany `evaluationId`; exactly one of the two; a v2 body is closed — unknown fields refused) |
| `GET /api/evidence/{bundleId}`, `POST /api/evidence/verify` | unchanged routes; v2 verification adds the trace checks and freshness |

API surface 56 → **58**. Authorization is the existing evidence rule
(`resolveGovernanceAccessContext`): on the secure Host an organization-scoped
API key — an auditor's key — reads its organization's traces and bundles
only; another organization's key gets `404 EVIDENCE_TRACE_NOT_FOUND` (existence
not disclosed); unauthenticated callers, operator bearers and agent
credentials get `401`. No listing route exists. CTRL-03's console does not
consume the trace yet (a UI change is not needed for the exit criterion;
PROD-03 owns operational polish).

## 10. Integrity vs authenticity

ASSURE-01 provides canonical references, digests, chain verification,
structural and source-record verification. It claims authenticity only where
the artifact itself is signed (grants and revocations, approval and obligation
chain heads) and says so per check. The trace, its digest, v2 bundles and the
bundle store are **not** signed; a writer able to re-seal unsigned stores
consistently is not detected (ASSURE-02).

## 11. No authority effect

The builder is handed one read per canonical store (pinned in the composition
root) and imports nothing holding authority, execution, signing, witness or
resolution capability; it makes no write call (structural, with self-tested
detectors). Fetching and verifying a trace write nothing — not even the bundle
lifecycle. On the real Host, reading and verifying every trace (at AUDITOR in the authority test, and at every level in the disclosure test) made zero adapter calls and left the approval state byte-identical; with P12
composed, reading never queried the resolver. P8's boundary test lists the
trace builder as the fourth documented holder of a stream reader (it decides
nothing); P11 and P12 boundary tests list it as a read-only holder.

## 11a. Bounded reads — complete or refused

Every read a trace makes is bounded, and the bound is enforced where the data
lives. The P8 event stream was the one unbounded read (its store loaded a whole
request stream before anything could size it); ASSURE-01 adds a generic bounded
read to the P8 reader, `readStreamBounded(context, streamId, { maxEvents })`:

- inside one read transaction the store first refuses another organization's
  stream (its owner read from the sealed head, or the first event's
  organization), then **counts the events the stream actually holds** and
  refuses a stream over the bound (`exceeds-bound`, with that count) before any
  event is loaded; the load itself is capped one past the bound. Only the count
  decides: a head or a sequence forged to disagree with it is a chain fault,
  reported by verification (invalid, real count) — never disguised as size;
- within the bound it returns the **complete** verified stream, or an invalid
  verification with no events — never a prefix, a suffix or a sample;
- the bound must be an integer from 1 to 10 000;
- the trace reads the stream only through it, at its fixed bound (256); no HTTP
  query carries a bound (the trace query admits `level` only).

Proof (`assure01-bounded-stream.test.ts`, both stores): 256 events read
complete; 257 refused; a probe on the rows SQLite actually returns (shared with
the store) shows the unbounded read materializes every row of a 257-event
stream and the bounded read **none** — also with every row made unparseable
and with the head rewritten short; a foreign organization is refused with no
row loaded; rows deleted with the head rewritten short load only the rows that
exist and verify invalid; a head or sequence forged high (including a text
`'Infinity'` sequence) is reported invalid, not as size; malformed and
excessive bounds refused; the trace refuses the 257th event without loading the
stream. The probe counts rows returned through `Statement.all` (the store's
load path); the in-memory provider holds its events in memory and is checked by
outcome only. Grants (16),
approval and discharge rows (256) are bounded by the trace; bundle lists by
`LIMIT 100`. Not claimed: protection against database growth, many concurrent
requests or resource exhaustion elsewhere (PROD-04).

## 12. Qualification evidence

<!-- assure01:evidence -->
### 12.1 The official exit drill (real Host, real HTTP)

`assure01-trace-host.test.ts` boots the shipped secure Host (`bootEnterpriseHost()`,
production profile, every durable store, Ed25519-signed authority, the external
CORE-07 witness, operators, approvals, obligations, emergency controls). The
third party is the holder of an organization-scoped API key (an auditor): it
never touches a database, the source or an in-process service, and learns every
request id only from public `POST /api/governed-actions` responses. It fetches
and verifies:

| Case | Final state the trace states | Notes |
|---|---|---|
| ALLOW, monetary transfer, executed | `executed-confirmed-completed` | request, decision, grant (exercised, signature-verified store), claim, attempt (amount), reservation `settled`, observation, P8 events in order; resolution `not-applicable` |
| ALLOW, non-financial restart, executed | `executed-confirmed-completed` | same stages, no amount |
| DENY before any grant | `denied` | no execution id; every later stage `not-applicable`; zero adapter calls |
| Approval required → pending (bundle sealed) → approved → resumed | `executed-confirmed-completed` | `requested`, `approved` by `operator:approver-a`; the sealed bundle stays valid, `superseded-by-later-facts`; rebuilding supersedes it without changing a byte |
| Obligation required → discharged → resumed | `executed-confirmed-completed` | discharge row from the independent source, authenticated store |
| Executed, then its grant revoked by an operator | `executed-confirmed-completed` | signed revocation and its event; a bundle sealed before it `progressed`, never contradicted |
| Provider failed | `executed-confirmed-not-completed` | failure `PROVIDER_REJECTED` |
| Provider unconfirmed (no resolver on the shipped Host) | `executed-unconfirmed` | resolution `not-composed` |
| Emergency stop | `not-executed` | no claim, no outcome; zero adapter calls |
| Unconfirmed → P12 resolved (both certainties; embedder composition, `assure01-trace-resolution-host.test.ts`) | `resolved-confirmed-*` | the initial observation kept as recorded; binding and resolution bound to it; the resolver never queried by reads |

(The in-memory store on a secure Host is refused by composition: posture `evidenceStore` must be `durable` — pinned structurally and proven by mutation M26, whose secure Host refused to boot.)

Then: a restart on the same stores, and a cold `backup:v1 --cold` → destroyed
data directory → `restore:v1` → boot: for every request the same trace digest,
verified; every issued bundle byte-identical with its lifecycle, and valid; the
Evidence Bundle Store is in the manifest, required, and no secret is in the
backup; zero adapter calls throughout. Boundaries over HTTP: a foreign
organization's key gets `404` (trace, verify, bundle, bundle verify, build);
unauthenticated, operator and agent credentials `401`; malformed ids, unknown
levels and any other query `400`; an unknown id `404`; writes on the trace
paths unrouted and no trace listing (a bare `/api/evidence/traces` is an unknown bundle id, `404`); FULL refused (`403`) to an organization key.
Disclosure: every case at every level is free of every configured or issued
secret, payloads, approval subjects, evidence hashes, obligation references and
provider endpoints; PUBLIC / CUSTOMER / PARTNER / AUDITOR carry exactly their
stages, mechanism and human sub-fields stripped as the policy says, and a
PUBLIC bundle's verification carries no grant id, actor or canonical digest.

### 12.2 Focused suites

| Suite | Tests | What |
|---|---|---|
| `assure01-trace-host.test.ts` | 16 | §12.1 |
| `assure01-trace-resolution-host.test.ts` | 2 | P12, both certainties, restart |
| `assure01-trace-builder.test.ts` | 64 | one corruption at a time (wrong joins, deleted and fabricated components, unreadable stores, summaries, payloads, read order, degraded stores, legacy pre-P11), disclosure and comparison at every level, v2 verification, historical v1 bundles |
| `assure01-evidence-store.test.ts` | 14 | restart, no overwrite, races, immutable content, re-sealed row, lifecycle and its log, tenant ownership, bounded lists, schema guard, health/close, in-memory contract |
| `assure01-trace-structure.test.ts` | 12 | no write path (self-tested detectors), one read per store, no unbounded stream read, no domain vocabulary, bounds, durable composition, registry |
| `assure01-bounded-stream.test.ts` | 16 | §11a, both stores and the trace |
| **Total** | **124** | |

### 12.3 Independent adversarial reviews

- **Review 1, `8561c64`: 11 findings** (medium-high to low), all fixed in `151aaff`: a changed recorded fact could pass as progress; verification not disclosure-filtered; FULL requestable by any organization key; issuer and mechanism sub-fields at PARTNER/CUSTOMER; pre-P11 executions misread; the claim window and a lagging stream treated as contradictions; partial P8 payload checks; misleading final states under degraded stores; concurrent builds; a version-guard gap; free text in a closed-code field.
- **Review 2, `151aaff`: 9 findings**, the substantive ones fixed in `0c61249`: the SQLite active-bundle query scanned the oldest rows of all versions; a fact committing mid-build could seal a false contradiction (P8 now read first); `unverifiable` mis-scoped and reported as contradiction; summaries unchecked against their records; a malformed legacy withheld row; the store-wide chain position disclosed below AUDITOR; more P8 fields. Informational items are recorded as residuals (§13): the summary presence map is disclosed by design; FULL v2 differs from AUDITOR only by v1 metadata counts.
- **Final review, `dcbfcd8`:** no high finding; one medium code finding — the build route had begun refusing unknown fields on **v1** bodies, a v1 status change — fixed (v1 bodies ignore unused fields again, as before — except `requestId`, now the v2 discriminator, which must not accompany `evaluationId`; only v2 bodies are closed) with a regression test; the rest documentation accuracy, corrected. The production change after it touched only that validator; the mutation campaign and the full validation were re-run on the resulting commit (§12.4, §12.5).

### 12.4 Mutation campaign

45 mutations, **45 killed** on `952d4e7` — the final production code (after it, documentation only) (`docs/security/evidence/assure01-mutation-evidence.json`):
each an executable edit that compiled, killed by its intended test, restored
byte for byte (source tree identical after the campaign; baseline 115/115). They
cover every attack the milestone named — organization check removed, wrong
grant / outcome / resolution joined, event-integrity verification omitted,
unexpected absence as not-applicable, bundle mutated after store, digest check
bypassed, bundle lost on restart, memory store on the secure Host, evidence
store omitted from the backup registry, foreign-organization read, a write (and
a grant writer) reachable from the trace, duplicate overwrite,
schema mismatch ignored, supersession immutability broken, disclosure filter
removed, unresolved turned into completed, resolution from another execution,
unbounded listing; the "adapter call during verification" attack is represented by a write call (M28) and a grant writer handed to the trace (M29), since no adapter is reachable from it at all — plus the review fixes. The first run (on `0c61249`) left
one survivor, M28: the structural detector missed an optional call; the
detector was fixed (`f73e82f`) and the whole campaign re-run. The P8 bounded read added M39 … M45 (size check removed, head-only and count-only sizing, in-memory bound removed, any number accepted as a bound, the trace at a larger bound, tenant check after the size answer); the first complete run left M41 surviving (the deleted-rows case kept its head), the case was strengthened and the complete campaign re-run (45 of 45 on `b608c27`). A review of the bounded read then found that sizing from the head or the highest sequence disguised a forged head or sequence as size; the store now sizes by the events it holds and refuses a foreign stream before loading (`952d4e7`), M40 / M41 / M45 were re-defined for that code (head sizing, highest-sequence sizing, owner after load), and the complete campaign was re-run: **45 of 45**.

### 12.5 Validation

Clean `git archive` exports of `0c61249` and of `dcbfcd8` (0 CRLF files), each
independently: `npm ci`, typecheck, lint, build green; root 9 166 tests
(9 153 pass, 0 fail, 9 skipped, 4 todo); workspaces all green; API freeze 58
endpoints (2 added), release docs, SDK surface green; protocol tarball
validation against the vendored, lock-pinned tarball and the compatibility lock
green; portability smoke green; legal report pre-existing advisories only;
`git diff --check` clean, no conflict markers. After `dcbfcd8`, the final review's
validator fix (`a426d1a`), the P8 bounded read (`505f716` … `952d4e7`) and
documentation changed; the regression set (P8, ASSURE-01, PROD-02, CORE-06
matrix, invariants, no-bypass, structure, API freeze) passed on the bounded
read; a review of it (`f895e5a`) led to count-only sizing and tenant-before-load
(`952d4e7`), and the final commit's own clean-export run is reported, with its SHA, in
the milestone report.
<!-- /assure01:evidence -->

## 13. Residual risks

1. **Not authenticity** — the trace and bundles are unsigned; unsigned canonical stores can be re-sealed by a privileged writer (ASSURE-02).
2. **P8 is best-effort** — a projection failure leaves the trace incomplete (`completeness` fails); it never implies the fact did not occur.
3. **The shipped Host composes no P12 resolver** — there, an unconfirmed outcome stays `executed-unconfirmed` with resolution `not-composed`; P12 cases are qualified on the embedder composition.
4. **Bounds are per request** (§11a): not protection against database growth, many concurrent requests or resource exhaustion elsewhere (PROD-04).
4a. **A post-P11 execution disguised as a pre-P11 one** (P11 rows deleted and the outcome summary's digest stripped) needs a re-sealed Governance reference chain; it is caught whenever P8 holds the execution's observed event — not against a writer controlling both (ASSURE-02).
4b. **Not every P8 field is cross-checked** (event instants against canonical instants): the stream's own chain and the cross-checked fields bound what a tampered event can claim.
5. **Unscoped (system) API keys read every organization**, as for every pre-existing evidence and governance read.
6. **An older backup restores older bundles** (RPO), as for every unanchored store.
7. **CTRL-03's console** still shows separate canonical records, not the trace.
8. `release/RELEASE_MANIFEST.json` still states a stale endpoint count (pre-existing; regenerate before tagging).
9. **FULL is internal only for traces and v2 bundles**: an organization key can still build a v1 FULL bundle (unchanged v1 semantics), and FULL v2 differs from AUDITOR only by four v1 metadata counts.
10. **The summary presence map is disclosed at every level** by design (whether each stage happened, never its content).
11. **Embedding tests** that compose `sqlite` persistence without naming every store path leave default-path files under the gitignored `.data/` (pre-existing pattern; the evidence store joins it).
