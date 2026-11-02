# `rn.sv@0.1.0` Commercial-Use Restriction — Blocker Disposition Matrix

> **STATUS: DRAFT (ASSURE-REL-01E). Not a policy decision.** This matrix
> records technical evidence. It does **not** lift, relax or reinterpret
> `commercialUse: restricted`. Only the decision procedure in
> [`ASSURE_COMMERCIAL_GO_NO_GO.md`](ASSURE_COMMERCIAL_GO_NO_GO.md) §4 can.

**Baseline:** `origin/main` @ `5012246c9cf406bf4a0cfa3c288d2cf778211dbf`.
**Source of the restriction:** `src/enterprise/assurance/frameworks/rn-sv-framework.ts`,
`RN_SV_FRAMEWORK_V0_1.metadata.commercialUse` (frozen; golden digest
`sha256:e71fafe1a10af95514823e35d43138b1b93cdb72e37765200447a37748c13a58`,
pinned in `src/enterprise/__tests__/assurance-rn-sv-framework.test.ts`).

## 1. The restriction as frozen

```text
status:    restricted
statement: Results recorded under rn.sv 0.1.0 must not be issued as commercial
           conclusions without controlled external review until ASSURE-SEC-01
           resolves the known blockers.
```

Properties of the restriction, read from the code:

- It is **informative only**. No engine component reads or enforces it
  (framework header comment). Its only technical effect is indirect: a
  commercial release requires the approver to send
  `commercialUseRestrictionAcknowledged: true` (ASSURE-REP-01 / REL-01D §4).
- `status: 'active'` is the *registry lifecycle* state. It means the framework
  can be registered and assessed against. It is **not** commercial
  authorization.
- The framework is **immutable**. Any change to its definition, including its
  `metadata`, changes the golden digest. The test fails and the change
  requires a new version (`rn.sv` 0.2.0+).

## 2. Two kinds of closure

| Term | Meaning in this document |
| --- | --- |
| **Technical closure: VERIFIED** | The defect in the blocker's wording no longer reproduces on the baseline. Evidence: (a) merged code, (b) a named regression test that passes on the baseline in this mission's run, and (c) a security document that describes the closure and its residual. A merged PR alone is **not** enough. |
| **Technical closure: PARTIAL** | The defect is closed but a **material residual** remains for commercial use. |
| **Technical closure: OPEN** | The defect as worded still exists. |
| **Policy authorization** | A named human decision maker, in writing, accepts the residual for paid use. **Every row below is `NOT GRANTED`.** |

Test runs supporting the VERIFIED entries: 313 targeted tests, 0 failures,
run on the baseline in this mission (see
[`COMMERCIAL_READINESS_ASSESSMENT.md`](COMMERCIAL_READINESS_ASSESSMENT.md) §5).

## 3. Disposition matrix

Decision-maker abbreviations: **FDR** founder / accountable executive;
**SEC** security lead; **GOV** framework governance owner; **LEG** qualified
legal counsel. These are roles; no person is named and no role is filled yet.

### B1 — Manually supplied evidence carries a self-declared `verified` flag

| Field | Disposition |
| --- | --- |
| Original rationale | A supplier's `verified: true` passed `mustBeVerified`, raised control confidence and counted toward eligibility's verified rate. The interested party certified its own evidence. |
| Implementation evidence | ASSURE-SEC-01C (#232), `assurance/manual-evidence-trust.ts`: manual references are admitted with `verified: false`; the claim is kept in a recomputed `supplierClaims`; every reader uses `isHostVerified()`, false for every manual type, including stored references. |
| Test evidence | `assurance-sec-01c-manual-evidence-trust.test.ts` (pass, this run); REP-01 "(15, 16, 17) … supplier-claimed verification classified correctly" (pass). |
| Technical closure | **VERIFIED** for the defect as worded. |
| Residual exposure | Manual evidence is **never authenticated**. It is identified by digest, not proven genuine. Every `rn.sv` control rests on human judgement over supplier evidence. |
| Commercial relevance | High. The service's result is only as good as supplier evidence plus reviewer judgement. That must be the customer-facing claim (drafts G, A). |
| Proposed mitigation | Disclose it in the deliverable (already printed per control). Reviewer sampling and corroboration procedure (runbook §6). Future: retrieval or signature verification of artifacts where the format allows. |
| Decision maker / approval | GOV + FDR: written acceptance that the offer is a *reviewed-evidence* assessment, not a verified-evidence one. |
| Evidence artifact | `docs/security/ASSURE-SEC-01C-MANUAL-EVIDENCE-TRUST.md` |
| Policy authorization | NOT GRANTED |

### B2 — Attestation metadata can set any metric name, including automated ones

| Field | Disposition |
| --- | --- |
| Original rationale | `deriveAssuranceMetrics` let an attestation overwrite Host-derived metrics (`governance.*`, `passport.*`, `enterprise.*` …). |
| Implementation evidence | ASSURE-SEC-01C C2: reserved namespaces, canonical metric names, `EVIDENCE_METRIC_NOT_PERMITTED`, policy applied again in `metrics.ts`, order-independent disagreement → absent. |
| Test evidence | `assurance-sec-01c-manual-evidence-trust.test.ts` (pass). |
| Technical closure | **VERIFIED**. |
| Residual exposure | Low for `rn.sv`: it uses no automated metrics (`automation: 'none'`). Derived-metric double counting across requirements is noted in SEC-01C as a non-trust issue. |
| Commercial relevance | Low for `rn.sv@0.1.0`. |
| Proposed mitigation | None required for `rn.sv`. Keep the reserved-namespace test. |
| Decision maker / approval | SEC: confirm. |
| Evidence artifact | `docs/security/ASSURE-SEC-01C-MANUAL-EVIDENCE-TRUST.md` |
| Policy authorization | NOT GRANTED |

### B3 — Reviewer identity and role are taken from the request body, not bound to the caller

| Field | Disposition |
| --- | --- |
| Original rationale | Any organization-key holder could record a review as any reviewer with any role. |
| Implementation evidence | ASSURE-SEC-01B (#229): reviewer credential (`assuranceReviewers`, secret by `apiKeyEnv`), identity and roles from the authenticator only. ASSURE-REL-01D (#248): the same credential on every operator route, declared identity fields must equal the credential, reviewer-only mode. |
| Test evidence | `assurance-sec-01b-authenticated-reviewers.test.ts`, `assure-rel-01d-operator-interface.test.ts` (#8 forged principals refused) (pass). |
| Technical closure | **VERIFIED** for credential binding. |
| Residual exposure | **Material.** A credential is a static bearer secret, not a per-human factor: no MFA, no passkey, no rate limiting, rotation by configuration and restart. Separation of duties distinguishes credentials, not people. Reviewer IDs were not validated against being emails or names (PILOT-01 rec. 7); closed by ASSURE-OPS-01 (R-04) except well-formed names. |
| Commercial relevance | High. The signed-off reviewer and approver are the substance of the deliverable. |
| Proposed mitigation | One credential per person; private-network only; named custody of each secret; issuance register (see `OPERATOR_ROLES.md`). Technical: passkey-bound release approval (AUTH-03 decision challenge), rate limiting (backlog R-03). Reviewer-ID format validation done in ASSURE-OPS-01 (R-04). |
| Decision maker / approval | SEC + FDR: written acceptance of static bearer credentials for a private pilot, or a requirement for R-03 first. |
| Evidence artifact | `docs/security/ASSURE-SEC-01B-AUTHENTICATED-REVIEWERS.md`, `docs/security/ASSURE-REL-01D-OPERATOR-INTERFACE.md` §2, §5, §9, §10 |
| Policy authorization | NOT GRANTED |

### B4 — Evidence without an organization is attributed to the assessed organization

| Field | Disposition |
| --- | --- |
| Original rationale | Bundles whose owner was hidden or absent were presented as the assessed organization's. |
| Implementation evidence | ASSURE-SEC-01D (#233) D1: attribution only from the organization the canonical store recorded; unattributed evidence rejected (`EVIDENCE_WRONG_TENANT` with its own detail). |
| Test evidence | `assurance-sec-01d-tenant-bundle-verification.test.ts` (pass, this run), including historical bundles with no recorded owner. |
| Technical closure | **VERIFIED**. |
| Residual exposure | Attribution trusts the Evidence Store's recorded owner; a direct store writer could falsify it (Host-internal). No dedicated "unattributed" code. |
| Commercial relevance | Medium. `rn.sv` evidence is manual and organization-bound by requirement. |
| Proposed mitigation | Host file-system access restricted to the custody administrator (runbook §1). |
| Decision maker / approval | SEC: confirm. |
| Evidence artifact | `docs/security/ASSURE-SEC-01D-TENANT-BUNDLE-VERIFICATION.md` |
| Policy authorization | NOT GRANTED |

### B5 — Evidence Bundle v2 verification is invoked without the current trace

| Field | Disposition |
| --- | --- |
| Original rationale | Every v2 bundle was rejected as a false integrity failure; v1 bundles were verified without their source record. |
| Implementation evidence | ASSURE-SEC-01D D2: bundles verified against canonical sources. |
| Test evidence | `assurance-sec-01d-tenant-bundle-verification.test.ts` D2 (pass). |
| Technical closure | **VERIFIED**. |
| Residual exposure | Verification shows a bundle matches the Host's records, not that the records describe the world truthfully. |
| Commercial relevance | Low for `rn.sv@0.1.0`: its requirements accept `external_artifact_reference` and `control_attestation` only, not `evidence_bundle`. |
| Proposed mitigation | None for this framework version. |
| Decision maker / approval | SEC: confirm. |
| Evidence artifact | `docs/security/ASSURE-SEC-01D-TENANT-BUNDLE-VERIFICATION.md` |
| Policy authorization | NOT GRANTED |

### B6 — Finding-event write failures at completion are ignored

| Field | Disposition |
| --- | --- |
| Original rationale | A completed assessment could have findings with no history, silently. |
| Implementation evidence | ASSURE-SEC-01E (#235): `AssuranceStore.completeAssessment` persists completion, finding events and supersession atomically (SQLite `BEGIN IMMEDIATE`). |
| Test evidence | `assurance-sec-01e-finding-event-integrity.test.ts` (pass, this run). |
| Technical closure | **VERIFIED** for the completion path. |
| Residual exposure | Signal-driven findings still take two writes (not swallowed, but not atomic). The `failed`-status save in `evaluateAssessment` is best-effort. History verification is a diagnostic only, not part of `verifyAssuranceAssessment` or any route. |
| Commercial relevance | Low for a Founding Assessment (no signals in scope). |
| Proposed mitigation | Exclude continuous signals from the Founding Assessment scope (`SERVICE_SPECIFICATION.md` §3). |
| Decision maker / approval | SEC: confirm. |
| Evidence artifact | `docs/security/ASSURE-SEC-01E-FINDING-EVENT-INTEGRITY.md` |
| Policy authorization | NOT GRANTED |

### B7 — Assessments carry integrity digests but no external authenticity (no signature)

| Field | Disposition |
| --- | --- |
| Original rationale | Anyone who edits a package and recomputes every digest produces a package that verifies offline. |
| Implementation evidence | ASSURE-REL-01A (#240): durable, append-only, unique-per-`reportId` release custody; authoritative verification against the Host (`verifyCommercialRelease`). REL-01D: `POST /api/assurance/commercial-releases/verify` reports integrity and authority separately; `externalSignature` is always `EXTERNAL_SIGNATURE_NOT_AVAILABLE`. |
| Test evidence | PILOT-01 "F01 RESOLVED UNDER AUTHORITATIVE VERIFICATION" and "F01 KNOWN LIMITATION (remaining offline)"; REL-01A "A10 KNOWN LIMITATION" (all pass, i.e. the limitation is reproduced). Independent verifier run in this mission: verdict `PASS (…); external authenticity NOT DEMONSTRATED`. |
| Technical closure | **OPEN**. The blocker as worded is still true. Custody mitigates it only for someone who asks the issuer. |
| Residual exposure | **Material.** No signature, no timestamp, no anchor. Custody is the issuer's own record (A10): a store writer can rewrite a release undetected. Restoring an older backup loses later releases. |
| Commercial relevance | High. A customer who relies on the report with a third party cannot prove its origin without the issuer. |
| Proposed mitigation | Interim (procedural): customers confirm `releaseDigest` with the issuer over an independent channel (draft H). Technical: sign `releaseDigest` with an issuer key (PILOT-01 rec. 2; backlog R-01). |
| Decision maker / approval | SEC + FDR + LEG: written acceptance of issuer-attested (unsigned) delivery for a founding pilot, with the customer-facing disclosure in drafts G and H. |
| Evidence artifact | `docs/security/ASSURE-REL-01A-DURABLE-RELEASE-AUTHENTICITY.md` §11, §16; `docs/enterprise/ASSURE_PILOT_01_COMMERCIAL_DRY_RUN.md` §4 |
| Policy authorization | NOT GRANTED |

### B8 — Manually supplied evidence is offered to every requirement, not scoped to one control

| Field | Disposition |
| --- | --- |
| Original rationale | Evidence for one control could satisfy another. |
| Implementation evidence | ASSURE-SEC-01C C3: evidence offered only to the requirements named in `requirementIds`; unbound evidence rejected with `EVIDENCE_NOT_BOUND`; malformed sets refused before collection. |
| Test evidence | `assurance-sec-01c-manual-evidence-trust.test.ts`; REP-01 "C: evidence trust boundaries … unbound … references are each handled" (pass). |
| Technical closure | **VERIFIED**. |
| Residual exposure | Binding states the supplier's intent; it does not prove relevance. Reviewer judgement remains the control. |
| Commercial relevance | Medium. |
| Proposed mitigation | Evidence guidelines (draft C) ask the customer to state which control each artifact supports and why. |
| Decision maker / approval | SEC: confirm. |
| Evidence artifact | `docs/security/ASSURE-SEC-01C-MANUAL-EVIDENCE-TRUST.md` |
| Policy authorization | NOT GRANTED |

### B9 — Review evidence references are not checked against the assessment's accepted evidence

| Field | Disposition |
| --- | --- |
| Original rationale | A `pass` citing no evidence, or evidence never accepted, was scored (review finding F01: no evidence → ten PASS → 100). |
| Implementation evidence | ASSURE-SEC-01A (#228), `manual-review-evidence.ts`: a definitive outcome must cite evidence accepted in this assessment, bound to the assessed organization and to one of the control's own requirements; pass/partial refused over unresolved contradictions; the evaluator ignores a stored non-conforming review; verification flags it. |
| Test evidence | `assurance-sec-01a-evidence-bound-reviews.test.ts` (pass, this run); REP-01 "C: a conclusion must rest on accepted, own-tenant evidence bound to the control" (pass). |
| Technical closure | **VERIFIED**. |
| Residual exposure | Binding is structural; it does not prove the evidence authentic or the conclusion correct. A manual review was **accepted after completion** (PILOT-01 rec. 5); closed by ASSURE-OPS-01 (R-02): refused at the service and atomically at the store. |
| Commercial relevance | Medium. |
| Proposed mitigation | Implemented: refuse reviews on terminal assessments (ASSURE-OPS-01, R-02). |
| Decision maker / approval | SEC: confirm. |
| Evidence artifact | `rn-sv-framework.ts` header (F01 closure); commit `cfb0aa61` |
| Policy authorization | NOT GRANTED |

## 4. Summary

| Blocker | Technical closure | Residual material for paid use? | Policy authorization |
| --- | --- | --- | --- |
| B1 self-declared `verified` | VERIFIED | Yes — evidence never authenticated | NOT GRANTED |
| B2 attestation metric names | VERIFIED | No | NOT GRANTED |
| B3 reviewer identity from body | VERIFIED | Yes — static bearer secrets, credential ≠ person | NOT GRANTED |
| B4 unscoped evidence attribution | VERIFIED | No | NOT GRANTED |
| B5 v2 bundle verification | VERIFIED | No (not used by `rn.sv`) | NOT GRANTED |
| B6 ignored finding-event failures | VERIFIED | No (signals out of scope) | NOT GRANTED |
| B7 no external authenticity | **OPEN** | **Yes** | NOT GRANTED |
| B8 evidence offered to every requirement | VERIFIED | No | NOT GRANTED |
| B9 review evidence not checked | VERIFIED | No — post-completion review refused since ASSURE-OPS-01 | NOT GRANTED |

Eight of nine are technically closed with verified evidence. **B7 is open.**
B1 and B3 are closed as worded, but their residuals are material and must be
accepted explicitly or remediated. Policy authorization: **none.**

The restriction's statement makes "controlled external review" the condition
for issuing results while blockers remain. No external reviewer exists yet.
Who that is, and whether the release approver's acknowledgement counts as it,
is founder decision **D-02** (`COMMERCIAL_READINESS_ASSESSMENT.md` §9).

## 5. Versioning recommendation: a new governed version, not a mutation

`rn.sv@0.1.0` must **not** be edited to lift the restriction:

1. Editing `metadata.commercialUse` changes the framework digest. The golden
   digest test fails by design, and every assessment and released report that
   binds `rn.sv@0.1.0` by digest would no longer match the published
   framework. Historical reports would stop verifying.
2. The restriction is part of what was frozen and released. Rewriting it
   would make history say something it did not say.

**Recommendation.** If and when the founder authorizes commercial use, do it
through a **new, separately governed framework version**, for example
`rn.sv@0.2.0`. It would have:

- a new frozen definition with its own golden digest, in a new file. The
  0.1.0 file, its digest, its test and every historical report stay byte for
  byte unchanged;
- a `commercialUse` block that records the authorization: status, the
  decision reference (approval record ID), the date, the accepted residuals
  (at least B1, B3 and B7) and the conditions (private Host, reviewer-only mode,
  separation of duties by person);
- a substantive review of whether control content should change at all. If
  only metadata changes, say so in the version's changelog, so that scores
  under 0.1.0 and 0.2.0 can be compared;
- registration through the existing opt-in mechanism
  (`AOC_ENTERPRISE_ASSURANCE_FRAMEWORKS`). That requires a code change to add
  the new entry to `ASSURANCE_OPTIONAL_FRAMEWORKS`, in its own mission.

Alternative considered: keep 0.1.0 and record the authorization **outside**
the framework, in a signed governance record. That avoids a code change but
leaves the delivered report saying "restricted" next to an authorized
release. Customers would get contradictory signals, so it is **not
recommended** for paid use. It is acceptable for an *unpaid*, explicitly
pilot engagement under the existing acknowledgement.

**This mission does neither.** Creating `rn.sv@0.2.0` is a separate mission
(backlog R-06) and happens only after founder decision D-01.
