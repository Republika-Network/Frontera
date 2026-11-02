# Framework Version Strategy for Commercial Use (ASSURE-GOV-01)

> **FINAL COMMERCIAL DECISION: NO-GO.** **STATUS: DRAFT — PROPOSED strategy.**
> `rn.sv@0.1.0` is unchanged and keeps `commercialUse: restricted`.
> **`rn.sv@0.2.0` is not created, registered, published or activated.** Its
> candidate content is in [`RN_SV_0_2_0_CANDIDATE_SPEC.md`](RN_SV_0_2_0_CANDIDATE_SPEC.md).
> Adoption is founder decision D-01 (GOV + FDR). Labels: VERIFIED · PROPOSED ·
> PENDING · BLOCKED.

## 1. Facts this strategy rests on (VERIFIED by code reading and tests)

1. `rn.sv@0.1.0` is frozen (`deepFreeze`). Any change to any field, metadata
   included, changes its digest and fails the golden test
   (`assurance-rn-sv-framework.test.ts`, "yields a different digest for any
   content change under the same version").
2. Every assessment and report binds the framework by id, version **and
   digest** (`commercial-report.ts` cover `frameworkDigest`; manifest
   `frameworkDigest`; verifier's pinned `RN_SV_GOLDEN_DIGEST`).
3. The registry refuses a second registration of the same id and version, and
   a different definition under an opted-in id/version fails composition
   (`framework-registry.ts`; `composition-root.ts`).
4. Only `rn.sv@0.1.0` can be opted in (`ASSURANCE_OPTIONAL_FRAMEWORKS`).
5. `metadata.commercialUse` is **informative only**. No engine component enforces
   it. Its only effect is the approver's mandatory acknowledgement at release
   (`service.ts`, `commercialUseRestrictionAcknowledged`).
6. The commercial report, its readiness checks, limitation texts and the
   offline verifier are hard-bound to `rn.sv@0.1.0` (GF-07).
7. Assessment reads and drafts resolve the framework through the registry
   (GF-08). Deregistering a version breaks access to its assessments.

## 2. Principles (PROPOSED)

| # | Principle |
| --- | --- |
| P1 | **History is immutable.** `rn.sv@0.1.0` bytes, golden digest and test, every assessment, report, custody record and backup bound to it stay byte-for-byte unchanged. |
| P2 | **A version records method; an authorization record records permission.** The framework defines what is measured and how. Whether Republika may sell results under it is a dated, attributable governance record that can be suspended. A frozen file cannot be suspended, so permission must not live only in frozen bytes. |
| P3 | **No version change conceals a policy decision.** A new version is justified by a substantive, stated delta (§3). It must never be presented as "the restriction was fixed" when what changed is a decision to accept residuals. The accepted residuals are named in the new version and in the authorization record. |
| P4 | **No self-expiring conditions.** Unlike 0.1.0's "until ASSURE-SEC-01 resolves the known blockers" (GF-02), a successor states conditions whose satisfaction is decided by a named role, never inferred from technical closure. |
| P5 | **Authorization binds an exact digest.** An authorization names `frameworkId`, `frameworkVersion` **and** `frameworkDigest`. Reviewers review those exact bytes. |
| P6 | **Scores are bound to their version.** Results are not restated across versions; a reassessment is a new assessment. |

## 3. Is a successor version needed? What delta?

`rn.sv@0.1.0` cannot become commercially authorized without contradicting
itself: its frozen text says "restricted" and lists nine blockers as current.
An off-framework authorization record alone (D-01 option b) would ship
reports that say "restricted" next to an authorized release (REL-01E §5).
**A successor is therefore recommended for paid use**; the content delta is
deliberately minimal (PROPOSED):

| Area | Change in 0.2.0? | Rationale |
| --- | --- | --- |
| Controls (ids, titles, objectives, questions, types, criticality) | **No**, unless the R1 methodology review recommends a change before freezing | No defect in control content has been found. Changing it would break comparability for no reason |
| Evidence requirements | **No** (same caveat) | Same |
| Domain weights, scoring model, `rn.sv.scoring@0.1.0` | **No** (same caveat) | Weights are unvalidated, but changing them without evidence is not better. Flag to the reviewer |
| `description` | **Yes**: adds "not an independent attestation" and "supplier evidence is not authenticated" | Disclosure accuracy (`CUSTOMER_CLAIMS_REVIEW.md`) |
| `metadata.commercialUse` | **Yes**: from "restricted + nine blockers" to "governed by an external authorization record", with the disposition of each predecessor blocker and the accepted residuals named | The substantive governance change; truthful, not concealing |
| `metadata.predecessor` | **New**: 0.1.0's id, version and golden digest | Traceability |
| `issuedAt` | New date at freeze | — |

If R1 recommends changing controls or weights, they are made **in 0.2.0 before
freezing**, and the changelog says that 0.1.0 and 0.2.0 scores are not
comparable. If not, the changelog says that control content and scoring are
identical, so control-level results describe the same test. Scores are still
reported with their version (P6).

**Semver.** 0.2.0 (minor, pre-1.0) is appropriate. `1.0.0` would signal a
maturity and external validation that does not exist; it is reserved for after
R1 and at least one completed founding engagement.

## 4. Registry and lifecycle rules (PROPOSED)

Two independent axes. Neither implies the other.

| Axis | States | Where recorded | Changed by |
| --- | --- | --- | --- |
| **Registry lifecycle** (existing) | `draft` → `active` → `deprecated` → `retired` | Framework definition / registry | Code missions (registration), Host configuration (opt-in) |
| **Commercial authorization** (new, governance) | `NOT_AUTHORIZED` → `AUTHORIZED_CONDITIONAL` → `SUSPENDED` ↔ `AUTHORIZED_CONDITIONAL`; → `REVOKED`; → `EXPIRED` | Authorization record ([`COMMERCIAL_AUTHORIZATION_PROCEDURE.md`](COMMERCIAL_AUTHORIZATION_PROCEDURE.md)); referenced by release | GOV + FDR only |

Rules:

1. A version is added to `ASSURANCE_OPTIONAL_FRAMEWORKS` only in a code
   mission, after D-01.
2. **Never deregister** a version that any Host holds assessments for (GF-08).
   To stop new assessments, use `deprecated`, through a supported path that R-06
   defines (GF-09: none exists today).
3. To stop **commercial releases** without touching assessments, use the
   commercial-authorization axis (`SUSPENDED` / `REVOKED`), enforced by the
   release gate R-06 adds (candidate spec §5).
4. `retired` versions remain verifiable forever (`get()` serves every
   registered version; `allowRetired: true` on reads).
5. `rn.sv@0.1.0` stays opt-in-able for Hosts that hold its assessments, and
   **stays `NOT_AUTHORIZED`** for commercial use permanently.

## 5. Order of operations (PROPOSED)

```text
D-01 (FDR+GOV)  ─►  R1 methodology review on the candidate spec
                ─►  R-06a: freeze rn.sv@0.2.0 file + golden test, NOT opted in
                ─►  R1 confirmation on the frozen digest (+ security residuals)
                ─►  M2 risk acceptance (SEC+FDR)
                ─►  Framework authorization record binding the 0.2.0 digest (GOV+FDR, M1)
                ─►  R-06b: opt-in + release gate + generator v3 + verifier
                ─►  M3–M6
                ─►  Final GO record (scoped to version + one customer)
```

Freezing before authorization is deliberate (P5). The reviewer and the
authorizer must see the same bytes. A frozen, un-opted-in file is inert: it
cannot be assessed against.

## 6. Suspension, revocation and prior-issued reports (PROPOSED)

| Event | Effect on new releases | Effect on prior reports | Customer action |
| --- | --- | --- | --- |
| `SUSPENDED` (for example: invalidating condition in the risk register, reviewer withdrawal, incident) | Release gate refuses commercial releases under that version until reinstated by GOV + FDR | None. Each report remains a true record of an authorized release at its `approvedAt`; verification continues to answer from custody | None required; Republika states the suspension on request |
| `REVOKED` for cause (methodology defect, false claim, compromised custody) | Refused permanently | Reports are **never edited**. Republika notifies affected customers in writing, states the cause and its effect on conclusions, and offers reassessment under a successor version per contract | Customer decides whether to rely further |
| `EXPIRED` (review date passed without R3) | Refused until R3 and renewal | None | None |
| Framework `deprecated` | No new assessments | None | None |

Verification of a prior report reports, separately, (a) release authenticity
against custody, as today, and (b) the authorization status **now**, in the same way
as `approverCurrentlyAuthorized` today (REL-01A §15). Neither rewrites the other.

## 7. Relationship between authorization and version

- An authorization covers **exactly one** `(frameworkId, frameworkVersion,
  frameworkDigest)`, for a stated use (for example "private founding pilot,
  internal-use reports, one engagement"), with conditions and an expiry.
- A new framework version needs a new authorization. Authorization never
  carries over by default.
- The GO line in `../ASSURE_COMMERCIAL_GO_NO_GO.md` §4 names the version and
  customer. A GO for `rn.sv@0.2.0` says nothing about `0.1.0` or `0.3.0`.

## 8. Reproducibility requirements

- The frozen file, golden digest and golden test are created together (R-06a).
- Any assessment under 0.2.0 must re-evaluate to the same results from its stored
  inputs, and any report must re-render to its exact Markdown (as REL-01C and
  REP-01 test for 0.1.0).
- The generator version used for each report is recorded and kept selectable,
  so v1/v2 reports under 0.1.0 still re-render byte-exactly after generator v3.
- The verifier keeps a closed map of known framework digests. It never fetches
  a framework definition at verification time.
