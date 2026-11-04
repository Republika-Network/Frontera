# Decision Register — Continuous Conformance (open)

All decisions are **OPEN**. Identifiers use the `CC-D-` prefix to avoid collision with the Founding
Assessment decisions (`D-01…`) in `docs/commercial/founding-assessment/governance/FOUNDER_DECISION_RECORD.md`.
"Blocks" names the earliest mission that cannot finish without the decision.

| Id | Decision | Options | Recommendation | Owner | Blocks |
|---|---|---|---|---|---|
| <a id="cc-d-01"></a>CC-D-01 | Canonicalization profile for signed conformance artifacts | (a) Protocol `aoc-canonical-json/1`; (b) Frontera `aoc.canonical-json.v1`; (c) RFC 8785 declared | (a) with plain-JSON input restriction, so both implementations agree byte-for-byte; record that the Protocol consent/capability specs' "RFC 8785" wording does not match the code | Architecture | RN-CONFORM-02 |
| <a id="cc-d-02"></a>CC-D-02 | Validator operator model | Republika-only; Republika + named federated partners; open | Republika + ≥ 1 contracted independent operator before any non-synthetic ACTIVE | Founder | RN-CONFORM-05 |
| <a id="cc-d-03"></a>CC-D-03 | Corroboration threshold k and windows | k = 2 / 3; window 15–60 min | k = 2 distinct operators, 30 min window, ≥ 3 for disputes | Architecture | RN-CONFORM-02 |
| <a id="cc-d-04"></a>CC-D-04 | Human approval scope | Issuance, reinstatement-after-violation, revocation, validator enrollment | All four require two distinct AUTH-03 humans | Founder | RN-CONFORM-02 (synthetic) |
| <a id="cc-d-05"></a>CC-D-05 | Credential term and SLO targets | Term 30/90/365 d; assertion validity 5/15/60 min | 90 d term; 15 min assertions; SLOs in CREDENTIAL_LIFECYCLE §7 | Founder + Ops | RN-CONFORM-03 |
| <a id="cc-d-06"></a>CC-D-06 | XRPL on-ledger carrier for digests | A memo-bearing anchor class (ADR amendment); B existence marker only; C separate service | A, with B optional for discoverability | xrpl-sovereign-access owners | RN-CONFORM-03X |
| <a id="cc-d-07"></a>CC-D-07 | Status / transition signing key custody | Software key in external signer process; HSM/KMS; MPC | External signer process for MVP; HSM before production | Security | RN-CONFORM-03 |
| <a id="cc-d-08"></a>CC-D-08 | Relationship to Assurance | None; optional reference to completed assessment; mandatory | Optional reference only; never depends on rn.sv commercial authorization (NO-GO unchanged) | Founder | None for MVP |
| <a id="cc-d-09"></a>CC-D-09 | Canonical home of profile and code | Profile in Protocol `docs/protocol/profiles/`; engine in Frontera `src/enterprise/conformance/`; separate repo | As stated; separate validator package in Frontera `packages/` | Architecture | RN-CONFORM-02 |
| <a id="cc-d-10"></a>CC-D-10 | What is the "Sovereign Access SDK"? | `@aoc/aoc-sdk`; `enterprise-host-sdk`; a new platform SDK; the XRPL vertical | Define explicitly before any profile pins "SDK version" | Product | RN-CONFORM-04 |
| <a id="cc-d-11"></a>CC-D-11 | Authoritative Protocol lock | `protocol-consumer.lock.json` (rc.3, off-main commit) vs `enterprise-integration.lock.json` (rc.1) | One lock is authoritative for conformance; reconcile rc.3 commit onto Protocol main | Release | RN-CONFORM-04 |
| <a id="cc-d-12"></a>CC-D-12 | Fileverse testing authorization and PEP ownership | Synthetic only; staging with written authorization; production | Synthetic until a written, scoped, time-boxed authorization exists; FV-P5 owner named | Founder + Fileverse | RN-CONFORM-04 beyond synthetic |
| <a id="cc-d-13"></a>CC-D-13 | Public status privacy | Full public; public with minimal fields; authenticated verifiers only | Public, minimal fields, no evidence | Legal | RN-CONFORM-03 |
| <a id="cc-d-14"></a>CC-D-14 | Registry defects found in audit | Fix in a separate Assurance PR; accept | Separate small PR: frozen check in `deprecate()`; deep-freeze `aoc.saf` (no digest change) | Assurance owners | None |
| <a id="cc-d-15"></a>CC-D-15 | Commercial terms | Pricing, onboarding / KYC, appeal SLA, liability, naming (must not say "certified") | Contract template before any non-synthetic credential | Founder + Legal | RN-CONFORM-06 |
| <a id="cc-d-16"></a>CC-D-16 | EVM adapter timing | Now; after XRPL; never | After RN-CONFORM-03X | Architecture | None |

## Decisions approved for RN-CONFORM-02 (synthetic scope only)

The founder approved, for the RN-CONFORM-02 synthetic circuit only:

* **CC-D-01:** `aoc-canonical-json/1` with the plain-JSON restriction.
* **CC-D-03:** k = 2 distinct operators, 30 min window, ≥ 3 operators to resolve disputes.
* **CC-D-04:** two distinct human approvals for issuance, reinstatement after a confirmed critical
  violation, explicit revocation and validator enrollment.

How each is implemented: [RN_CONFORM_02_IMPLEMENTATION.md](RN_CONFORM_02_IMPLEMENTATION.md). The table
above is the RN-CONFORM-01 record and is left as written; every other decision remains open.

## RN-CONFORM-04 dispositions (no decision approved)

RN-CONFORM-04 worked within, and closed none of, three open decisions
([RN_CONFORM_04_IMPLEMENTATION.md](RN_CONFORM_04_IMPLEMENTATION.md) §3):

* **CC-D-10** stays **OPEN**. The reference profile pins a named *synthetic reference adapter contract*
  (`@republika-synthetic/document-use-reference-adapter`); this is not an SDK identity.
* **CC-D-11** stays **OPEN**. Both locks are recorded unchanged, and only the currently approved rc.3
  vendored identity is used.
* **CC-D-12** is **synthetic only**, per the founder's direction for RN-CONFORM-04. Anything beyond
  synthetic still needs a written, scoped, time-boxed authorization.

## RN-CONFORM-05 disposition (synthetic implementation only; no decision approved)

* **CC-D-02** stays **OPEN** for production. RN-CONFORM-05 implements, for synthetic use only, the provisional
  architecture the founder specified: Republika and future legal operators may each run validators; all
  validators of one operator are one corroboration source; ≥ 2 distinct eligible operators confirm, ≥ 3 resolve a
  dispute (CC-D-03 unchanged); independence is established administratively by two-person operator approval,
  never inferred from keys; every operator record is `SYNTHETIC-FEDERATION-NON-PRODUCTION` with
  `independenceVerification: NOT_VERIFIED`. Still to be decided by the founder: operator agreement model,
  eligibility and identity verification, conflict-of-interest policy, legal responsibility, liability, operating
  geography, minimum operational security, financial and commercial terms
  ([RN_CONFORM_05_IMPLEMENTATION.md](RN_CONFORM_05_IMPLEMENTATION.md) §4).
* CC-D-12 remains synthetic only; no other decision changes.

## Provisional parameters for RN-CONFORM-03 (synthetic scope only)

The founder authorized, as **synthetic implementation parameters only** (not production approvals):

* **CC-D-05:** 90 d credential term; status assertions valid ≤ 15 min; online responses reflect the
  committed state when signed. The SLOs remain targets, not achieved guarantees.
* **CC-D-07:** an isolated status-signer boundary (CORE-02 structured pattern) with synthetic Ed25519 keys
  held outside the registry's database; HSM/KMS remains a separate production decision.
* **CC-D-13:** minimal public disclosure (identity, scope, state, freshness, expiry, transition digests;
  no evidence, validators, humans or keys). The public contract remains subject to legal approval.

How each is implemented: [RN_CONFORM_03_IMPLEMENTATION.md](RN_CONFORM_03_IMPLEMENTATION.md). All three
decisions remain **OPEN** for production.

## Constraints confirmed unchanged by RN-CONFORM-01

* `$SOBE`, tokens, staking, slashing, validator rewards: out of scope; absent from all dependencies.
* `rn.sv@0.1.0` and its golden digest: unchanged.
* Historical assessments, reports and fixtures: unchanged.
* Founding Assessment: FINAL COMMERCIAL DECISION **NO-GO**, unchanged.
* No external certification claimed.
