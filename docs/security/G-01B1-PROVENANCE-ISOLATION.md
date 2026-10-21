# G-01B1 — Request namespace and provenance isolation

Status: Draft PR #196 (base `6c1f6b4`). Not merged.
Invariants: SEC-INV-347 … SEC-INV-351 (`docs/security/SECURITY_INVARIANTS.md` §4.36).
Founder decisions: 1 (oracle deferred), 2 (shared provenance resolver), 3 (reconsideration), 4 (refusal codes), 5 (Passport), 6 (traces), 7 (bounded hygiene, Assurance assessment).

**This milestone does not remove the cross-tenant request-id existence oracle or deterministic-id squatting (P2-1).** See §5 and `G-01B2-SCOPED-REQUEST-NAMESPACES.md`.

## 1. The problem

The Governance Store holds one request-id space written by two paths: the advisory evaluate route (caller-chosen ids) and the governed-action path (server-derived `aoc.gar:` ids, committed together with that path's own idempotency claim). G-01B0 stopped new evaluate records from occupying governed ids and stopped the governed path from adopting them. Other consumers still treated "a record at this id" as "a governed decision":

| Finding | Consumer | Before G-01B1 |
|---|---|---|
| P2-2 | Reconsideration (`POST /api/governed-actions` with `reconsideration.of`) | The original was checked for organization, actor, integrity, status and business intent — not provenance. An advisory record (its actor possibly only asserted by a legacy key), a pre-G-01A record or a pre-G-01B0 planted record with the same intent rooted a governed lineage, and ASSURE-01 lineage checks passed. |
| ASSURE-01 | `buildAuthorityTrace` (public and operator trace routes, evidence v2) | Any record at an `aoc.gar:` id was traced as a governed request; a lineage to a non-governed original passed `lineage.original-identity`. |
| PAY-05 | Refund `releaseBasis` | A non-governed record at the refund's request id was read as its decision: `denied` released the reservation as `decision-denied`; `allowed` left it pending forever. |
| P2-3 | Passport `linkGovernanceRecord` | Only `evaluationId` and the aggregate digest were checked; the reference's `requestId`, `decisionId` and `status` (counted by the Passport summary) were the caller's assertion. |

Reachability: the PAY-05 and pre-G-01B0 cases need records planted before G-01B0 (or written by an embedder); P2-2 with an advisory record and P2-3 were reachable on the shipped Host by organization-scoped credentials. None grants execution authority — the Kernel re-evaluates a reconsideration, and a Passport reference grants nothing — but each is an integrity failure of an artifact or a decision the platform presents as governed.

## 2. The model

**One provenance answer** (`governance-store/governed-provenance.ts`): a record is governed iff it holds the governed-action path's own idempotency claim — the PROD-03-01 `governed-action` predicate (`isGovernedActionIdempotencyClaim`), which both Store providers already evaluate (in SQL for SQLite, in `matchesGovernedPath` in memory). The resolver asks the Store's scoped query for that predicate at the record's request id and accepts only an answer naming exactly that record — same evaluation, request id and organization. No hit, another evaluation, another request id, another organization, more than one hit, or a malformed answer: not governed. A Store failure propagates and each consumer treats it as unavailable. Never fail open.

What is not evidence: the `aoc.gar:` shape, integrity (a planted record verifies), and G-01A attribution (an advisory actor may be asserted). No second provenance model, no schema change, no new index — the claim is written in the same transaction as the record, so the two reads cannot disagree about a committed record, and both providers persist it.

**The `governed-action` query filter is now a security boundary.** It was introduced (PROD-03-01) as an operator selection filter; G-01B1 makes it the evidence these consumers decide on. Its semantics must not drift between providers, and an embedder Store that implements `query` must implement it truthfully — a Store that cannot answer it leaves every record not governed.

## 3. Consumers and refusals (no new public codes)

| Consumer | Non-governed record | Governed record |
|---|---|---|
| Reconsideration | `rejected` / `GOVERNED_ACTION_RECONSIDERATION_TARGET_NOT_FOUND`, before integrity, actor, root, status or intent are judged; nothing evaluated or written | unchanged (same-actor rule retained; no same-principal rule) |
| ASSURE-01 trace | the existing not-found (HTTP 404 `EVIDENCE_TRACE_NOT_FOUND`) | unchanged, byte-identical |
| ASSURE-01 lineage | `lineage.original-identity` fails | unchanged |
| PAY-05 `reconcileRefund` | `basis-unavailable`; the reservation stays counted | unchanged |
| Passport link | `PASSPORT_REFERENCE_INVALID` when `evaluationId`, `requestId`, `decisionId` or `status` differs from the record | advisory records are linkable when the reference matches — fidelity, not governed provenance |

**PROD-03-01 behaviour change (decision 6).** A historical evaluate-route record at a governed-shaped id used to return a 200 operator trace classified `evaluation-only` (review fix #170). It now returns the existing 404 on `GET /api/admin/operations/traces/{id}` (and on the public trace route). The operator execution list still shows it, classified `evaluation-only`.

## 4. Hygiene (decision 7)

- **Conflict texts.** A request-id conflict has one `CONCURRENCY_CONFLICT` text and a key conflict one `GOVERNANCE_IDEMPOTENCY_CONFLICT` text, whatever the cause. Before, a same-payload replay refused for another requester said so, while a different payload or an invisible record did not.
- **Evaluate body snapshot.** The route reads one JSON round trip of the body; authentication's organization hint, validation and the Kernel request all read it. An in-process body (an accessor, a mutation between reads) could validate one request id and evaluate another — including a server-derived one, which G-01B0's L2 still kept from being adopted. Over HTTP the body is already JSON; a body with no JSON form becomes `null` and is refused by validation (400) after authentication.
- **In-memory claim index.** Claims were keyed by `scope + NUL + key`; a NUL inside an organization id or key moved the boundary (HTTP headers cannot carry NUL, so this was reachable only in-process, and the in-memory provider is refused in staging/production). Now `JSON.stringify([scope, key])`. SQLite already used a composite primary key.

## 5. Residual risks

- **P2-1 — request-id existence oracle and squatting (not removed).** `request_id` is unique store-wide. A request id committed in one organization answers another organization's reuse with 409 (which organization, and nothing of the record, is never disclosed), and a deterministic request id can be occupied first, refusing its owner. Reachable on the shipped Host where legacy keys are scoped to more than one organization; within one organization, across principals. Client-chosen request ids should be unguessable; generated ids are random UUIDs. Removal needs scoped request namespaces — a schema migration with historical-compatibility and system-lookup design: `G-01B2-SCOPED-REQUEST-NAMESPACES.md`.
- **Historical Passport references** linked before G-01B1 are not re-checked: no migration, and verification still checks only that the referenced evaluation exists in the Passport's organization. A Passport composed without a Governance Store checks nothing, as before. A system-scope caller can still link a record of another organization than the Passport's (verification then fails it).
- **Reconsideration binds the actor, not the principal** (decision 3): another principal bound to the same actor may reconsider.
- **Operator `inspectDecisionEvidence`** shows any record of the served organization as a "decision" without a provenance mark (operator credential, read only).
- **Embedder Stores** are trusted: one whose `query` lies about the predicate is believed.
- **Records occupying governed ids before G-01B0** stay in place (append-only); they are now consistently treated as not governed. Operator reporting of them is not added.

## 6. Assurance (decision 7 assessment — no code change)

Three distinct properties of a record:

| | Meaning | Who establishes it |
|---|---|---|
| (a) structurally valid | its digests recompute | `GovernanceStore.verify` |
| (b) authenticated attribution | the requester was a customer or service principal (G-01A) | the attribution event (`readRecordedAttribution`) |
| (c) governed-action provenance | it came through the governed-action path | the governed-action claim (SEC-INV-347) |

`governance_record` assurance evidence (`assurance/evidence-resolver.ts`) is documented as "tenant-scoped `query()` … then `verify()` per hit; `verified` means the stored aggregate's digests recompute" (`docs/enterprise/AOC_ASSURANCE_EVIDENCE_MODEL.md`), and SAF maps it to "PR-004 Governance Records" — the evaluate route. Its metrics (`governance.records.count`, `all_verified`, `denied_count`, `indeterminate_count`) count records and statuses. It therefore promises (a) only, scoped to the subject actor by the record's actor id. G-01B1 preserves that meaning and changes no Assurance code.

Trade-off, for a founder decision (not made here): for an agent or passport subject, the actor id of an advisory record committed by a legacy key is asserted, so such records can be counted as that agent's evidence. Requiring (b) or (c) would change which records count, the SAF requirement's meaning ("demonstrating governed decisions for the subject"), stored assessments' reproducibility and the interpretation of historical evidence — a scoring-contract change. A non-breaking alternative is additive provenance metadata on each `governance_record` reference (`attributionBasis`, `governedPath`) with new opt-in metrics, leaving existing metrics untouched.

## 7. Evidence

Suites (root suite, GitHub Actions): `src/enterprise/__tests__/g01b1-provenance-isolation.test.ts` (both providers; pre-G-01A unattributed, G-01A legacy-asserted and pre-G-01B0 records; residual P2-1 characterized) and `src/enterprise/__tests__/g01b1-mutation.test.ts` (17 mutants over the compiled modules). Commits are ordered tests-first; run IDs are recorded on the PR.
