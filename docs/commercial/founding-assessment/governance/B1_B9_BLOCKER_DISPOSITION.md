# `rn.sv@0.1.0` Blockers B1–B9 — Updated Disposition (ASSURE-GOV-01)

> **FINAL COMMERCIAL DECISION: NO-GO.** **STATUS: DRAFT.** This document
> re-verifies the technical record of
> [`../FRAMEWORK_RESTRICTION_DISPOSITION.md`](../FRAMEWORK_RESTRICTION_DISPOSITION.md)
> (REL-01E, baseline `5012246c`) on baseline `2e32eb15`, after ASSURE-OPS-01
> and ASSURE-OPS-02. It adds the independent validation and the policy decision
> each blocker still needs. It **does not** lift, relax or reinterpret
> `commercialUse: restricted`. **Technical closure is not policy approval.**
> Labels: VERIFIED · PROPOSED · PENDING · BLOCKED (see
> [`GOVERNANCE_READINESS.md`](GOVERNANCE_READINESS.md)).

Implementation detail for each blocker stays in the REL-01E matrix and the
security records it cites. Only what changed, or what that matrix did not
cover, is stated here.

## 1. What "technical disposition" means here

| Disposition | Meaning |
| --- | --- |
| **CLOSED (VERIFIED)** | The defect as worded in the frozen blocker no longer reproduces: merged code, a named regression test passing **in this mission's run**, and a design record (or, for B9, the code and the framework header; see GF-05). |
| **CLOSED WITH MATERIAL RESIDUAL** | As above, but what remains is material for paid use and needs an explicit, attributable acceptance. |
| **OPEN** | The defect as worded still exists. |

Test counts below are from batches run on 2026-11-02 ([`INDEPENDENT_REVIEW_EVIDENCE_INDEX.md`](INDEPENDENT_REVIEW_EVIDENCE_INDEX.md) §4).

## 2. Per-blocker disposition

### B1 — Manually supplied evidence carries a self-declared `verified` flag

| Field | Disposition |
| --- | --- |
| Original defect | A supplier's `verified: true` satisfied `mustBeVerified` and raised confidence: the interested party certified its own evidence. |
| Implemented mitigation | ASSURE-SEC-01C (#232): manual references admitted with `verified: false`; the claim kept as `supplierClaims`; every reader uses `isHostVerified()`, false for every manual type. `rn.sv@0.1.0` never sets `mustBeVerified`. |
| Test evidence (this run) | `assurance-sec-01c-manual-evidence-trust` with SEC-01A: 45/45; REP-01 (supplier-claimed verification classified): 30/30. VERIFIED |
| Residual risk | **Material.** Evidence is identified by digest, never authenticated. Every conclusion is reviewer judgement over supplier-provided material. Forged or selectively chosen evidence is undetectable by the product. |
| Customer impact | The result is only as reliable as the evidence and the reviewer. A customer, or a third party shown the report, may overestimate it. |
| Technical disposition | **CLOSED WITH MATERIAL RESIDUAL** (VERIFIED) |
| Required independent validation | R1: methodology reviewer confirms that disclosure of B1 is adequate and that the sampling/corroboration procedure ([`INDEPENDENT_REVIEW_PROTOCOL.md`](INDEPENDENT_REVIEW_PROTOCOL.md) §7) is reasonable for each control. R2: re-performance of sampled control conclusions on the first real engagement. |
| Required policy decision | GOV + FDR: the offer is a *reviewed-evidence* assessment, not a *verified-evidence* one, stated in customer-facing language (SR-01). |
| Approval status | **PENDING** — none |

### B2 — Attestation metadata can set any metric name

| Field | Disposition |
| --- | --- |
| Original defect | An attestation could overwrite Host-derived metrics. |
| Implemented mitigation | SEC-01C C2: reserved namespaces, canonical names, `EVIDENCE_METRIC_NOT_PERMITTED`, re-applied in `metrics.ts`. |
| Test evidence (this run) | SEC-01C (45/45 batch); PILOT-01 check 9 "reserved metric injected — detected" (25/25). VERIFIED |
| Residual risk | Low for `rn.sv` (`automation: 'none'`; no metric-based controls). |
| Customer impact | None identified for `rn.sv@0.1.0`. |
| Technical disposition | **CLOSED** (VERIFIED) |
| Required independent validation | R1 security reviewer confirms by code reading; no sampling needed. |
| Required policy decision | SEC: confirm closure. |
| Approval status | **PENDING** — none |

### B3 — Reviewer identity and role taken from the request body

| Field | Disposition |
| --- | --- |
| Original defect | Any organization-key holder could record a review as any reviewer with any role. |
| Implemented mitigation | SEC-01B (#229) reviewer credentials; REL-01D (#248) the same credential on every operator route, declared fields must equal it, reviewer-only mode; OPS-01 (#251, R-04) safe reviewer-ID policy; OPS-02 (#253) preflight E11 (no dual-role credential), E12 (no reuse across engagements, when a ledger is given). |
| Test evidence (this run) | SEC-01B + OPS-01 terminal: 38/38; REL-01D operator interface (#8 forged principals, O13 reviewer-only) + OPS-01 reviewer privacy: 39/39; OPS-02: 23/23 batch. VERIFIED |
| Residual risk | **Material.** Static bearer secrets: no MFA or passkey, no rate limiting, rotation by restart. **Separation of duties distinguishes credentials, not people.** One person holding two credentials defeats it undetectably. Well-formed personal names in IDs are not detectable. |
| Customer impact | The reviewer and approver named on the report are the substance of the deliverable. A leaked secret or a dual-credential person would make the separation claim false. |
| Technical disposition | **CLOSED WITH MATERIAL RESIDUAL** (VERIFIED). Note GF-03: REL-01D §10 calls this "Accepted"; it is not. |
| Required independent validation | R1: security reviewer assesses the credential model and the private-network posture; reviews the credential register procedure. R2: reviewer confirms, per release, that the reviewer and approver credentials map to two different named people (register inspection). |
| Required policy decision | SEC + FDR (M2, D-03): accept static credentials for a private pilot **with** conditions, or require R-03 (passkey-bound approval, rate limiting) first. |
| Approval status | **PENDING** — none |

### B4 — Evidence without an organization attributed to the assessed organization

| Field | Disposition |
| --- | --- |
| Original defect | Bundles with hidden or absent owners were presented as the assessed organization's. |
| Implemented mitigation | SEC-01D (#233) D1: attribution only from the store-recorded organization; unattributed evidence rejected. |
| Test evidence (this run) | SEC-01D + SEC-01E: 67/67. VERIFIED |
| Residual risk | Attribution trusts the Evidence Store's record; a direct store writer could falsify it (Host-internal; same class as A10). |
| Customer impact | Low on a dedicated per-customer Host (D-08): no other organization's evidence is present. |
| Technical disposition | **CLOSED** (VERIFIED) |
| Required independent validation | R1 code reading. |
| Required policy decision | SEC: confirm; conditional on D-08 (one Host per customer). |
| Approval status | **PENDING** — none |

### B5 — Evidence Bundle v2 verification invoked without the current trace

| Field | Disposition |
| --- | --- |
| Original defect | Every v2 bundle rejected falsely; v1 bundles verified without their source. |
| Implemented mitigation | SEC-01D D2: bundles verified against canonical sources. |
| Test evidence (this run) | SEC-01D (67/67 batch). VERIFIED |
| Residual risk | Not used by `rn.sv@0.1.0` (accepts `external_artifact_reference` and `control_attestation` only). |
| Customer impact | None for `rn.sv`. |
| Technical disposition | **CLOSED** (VERIFIED) |
| Required independent validation | R1 confirms `rn.sv` does not accept `evidence_bundle` (framework reading). |
| Required policy decision | SEC: confirm. |
| Approval status | **PENDING** — none |

### B6 — Finding-event write failures at completion ignored

| Field | Disposition |
| --- | --- |
| Original defect | A completed assessment could silently lack finding history. |
| Implemented mitigation | SEC-01E (#235): completion, finding events and supersession in one SQLite transaction. |
| Test evidence (this run) | SEC-01E (67/67 batch); PILOT-01 check 10 "finding event deleted at storage level — detected" (25/25). VERIFIED |
| Residual risk | Signal-driven findings still take two writes; signals are out of the Founding Assessment scope. |
| Customer impact | None while continuous signals are excluded (`../SERVICE_SPECIFICATION.md` §3). |
| Technical disposition | **CLOSED** (VERIFIED) for the completion path |
| Required independent validation | R1 confirms signals stay out of scope in the SOW. |
| Required policy decision | SEC: confirm; GOV: keep signals excluded from the offer. |
| Approval status | **PENDING** — none |

### B7 — Integrity digests but no external authenticity (no signature)

| Field | Disposition |
| --- | --- |
| Original defect | Anyone who edits a package and recomputes every digest produces a package that verifies offline. |
| Implemented mitigation | REL-01A (#240) durable append-only custody and authoritative verification; REL-01D verification over HTTP (`externalSignature` always `EXTERNAL_SIGNATURE_NOT_AVAILABLE`); OPS-01 export from custody; OPS-02 sealed backups. **No signature, timestamp or anchor.** |
| Test evidence (this run) | PILOT-01 "F01 RESOLVED UNDER AUTHORITATIVE VERIFICATION … still passes offline" (25/25); REL-01A `A10 KNOWN LIMITATION` (30/30 batch); independent verifier verdict `… external authenticity NOT DEMONSTRATED`. The limitation is **reproduced**, not closed. VERIFIED |
| Residual risk | **Material.** Offline, a resealed forgery is indistinguishable from the original. Against custody, a store writer who recomputes every digest is not detected (A10). Restoring an older backup loses later releases. |
| Customer impact | A customer cannot prove the report's origin to anyone without Republika's cooperation. After deletion at end of retention, no one can. |
| Technical disposition | **OPEN** (VERIFIED) |
| Required independent validation | R1: security reviewer evaluates [`B7_AUTHENTICITY_OPTIONS.md`](B7_AUTHENTICITY_OPTIONS.md) and states whether Option A's conditions are adequate for a private pilot. |
| Required policy decision | SEC + FDR + LEG (M2, D-03): accept B7 as an explicit, disclosed limitation for a private, internal-use pilot, or require Option B (R-01) first. |
| Approval status | **PENDING** — none |

### B8 — Manual evidence offered to every requirement

| Field | Disposition |
| --- | --- |
| Original defect | Evidence for one control could satisfy another. |
| Implemented mitigation | SEC-01C C3: evidence offered only to its `requirementIds`; unbound evidence rejected. |
| Test evidence (this run) | SEC-01C (45/45 batch); PILOT-01 checks 5 and 19 (25/25). VERIFIED |
| Residual risk | Binding states the supplier's intent; relevance is reviewer judgement. |
| Customer impact | Medium: a weakly relevant artifact can be bound and accepted by a careless reviewer. |
| Technical disposition | **CLOSED** (VERIFIED) |
| Required independent validation | R2 sampling includes a relevance check of cited evidence. |
| Required policy decision | SEC: confirm. |
| Approval status | **PENDING** — none |

### B9 — Review evidence not checked against accepted evidence

| Field | Disposition |
| --- | --- |
| Original defect | A `pass` citing no evidence, or unaccepted evidence, was scored (F01: ten PASS → 100). |
| Implemented mitigation | SEC-01A (#228) `manual-review-evidence.ts`: definitive outcomes must cite accepted, own-tenant evidence bound to the control; OPS-01 (R-02): reviews refused on terminal assessments, atomically at the store. |
| Test evidence (this run) | SEC-01A (45/45 batch); OPS-01 terminal review (38/38 batch). VERIFIED |
| Residual risk | Structural binding only. It proves neither authenticity nor correctness. **No SEC-01A design record exists (GF-05).** |
| Customer impact | Medium; covered by B1's disclosure. |
| Technical disposition | **CLOSED** (VERIFIED) |
| Required independent validation | R1 code reading of `manual-review-evidence.ts` in the absence of a design record. |
| Required policy decision | SEC: confirm. |
| Approval status | **PENDING** — none |

## 3. Summary

| Blocker | Technical disposition | Residual material for paid use | Independent validation | Policy decision | Approval |
| --- | --- | --- | --- | --- | --- |
| B1 | CLOSED WITH MATERIAL RESIDUAL | Yes | R1 + R2 | GOV + FDR | PENDING |
| B2 | CLOSED | No | R1 | SEC | PENDING |
| B3 | CLOSED WITH MATERIAL RESIDUAL | Yes | R1 + R2 | SEC + FDR (M2) | PENDING |
| B4 | CLOSED | No (with D-08) | R1 | SEC | PENDING |
| B5 | CLOSED | No | R1 | SEC | PENDING |
| B6 | CLOSED | No (signals excluded) | R1 | SEC + GOV | PENDING |
| B7 | **OPEN** | **Yes** | R1 | SEC + FDR + LEG (M2) | PENDING |
| B8 | CLOSED | No | R2 | SEC | PENDING |
| B9 | CLOSED | No | R1 | SEC | PENDING |

**Change since REL-01E:** none in technical disposition. OPS-01 and OPS-02
strengthened B3 (reviewer-ID policy, preflight E11/E12) and B9 (terminal
reviews refused); neither removes a material residual. A related residual, A10
(issuer-controlled custody), is not one of the nine frozen blockers but is
inseparable from B7; it is registered separately as SR-04.

**Closure of B2, B4, B5, B6, B8 and B9 is still unconfirmed by SEC**, because no
SEC role holder exists. Engineering-verified closure is not a security sign-off.
