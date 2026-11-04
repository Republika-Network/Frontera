# RN-CONFORM-06 — Founder Decisions Required

**Nothing in this document is decided.** It lists what must be decided, by whom, and which level each decision
gates. Statuses are copied from [DECISION_REGISTER.md](DECISION_REGISTER.md) and are **unchanged** by this mission.

## 1. Existing CC-D decisions

| Id | Topic | Current status | Gates | Recommendation for the pilot path |
|---|---|---|---|---|
| CC-D-01 | Canonicalization profile | Approved for synthetic circuit only | L2 | Confirm for PILOT designation as-is |
| CC-D-02 | Validator operator model | OPEN (provisional synthetic architecture) | L3 | Pilot: Republika single operator, labelled; no ACTIVE. Start drafting operator agreements in parallel |
| CC-D-03 | Corroboration k / window | Approved for synthetic circuit only | L3 | Unchanged; irrelevant to a single-operator pilot except for labelling |
| CC-D-04 | Two-person human approvals | Approved for synthetic circuit only | L2 | Confirm, with AUTH-03 passkeys (roadmap P1-04) |
| CC-D-05 | Credential term, SLOs | OPEN (synthetic parameters) | L3 | Not needed for a non-credentialing pilot |
| CC-D-06 | XRPL carrier | OPEN in this register (recommendation A). *Note:* ADR-009 in xrpl-sovereign-access records the founder's adoption of Option A as implementation architecture only; not yet recorded here | anchoring | Record the ADR-009 decision verbatim (roadmap P0-01); keep anchoring out of the pilot |
| CC-D-07 | Key custody | OPEN (synthetic parameter) | **L2** | Decide: external signer process with KMS-backed key for the pilot; HSM before production |
| CC-D-08 | Relationship to Assurance | OPEN | L4 | Confirm "optional reference only; never depends on `rn.sv` commercial authorization" |
| CC-D-09 | Home of profile and code | OPEN | L2 | Confirm Frontera `src/enterprise/conformance/`; validator package location |
| CC-D-10 | SDK identity | OPEN | **L2** | Decide with the design partner which SDK/adapter version the pilot pins |
| CC-D-11 | Authoritative Protocol lock | OPEN | **L2, if** the partner integration pins AOC Protocol packages | Reconcile rc.3 onto Protocol main; one authoritative lock |
| CC-D-12 | Fileverse testing authorization, PEP owner | Synthetic only | **L2** | A written, scoped, time-boxed authorization from the partner, naming the PEP owner, environment, data and stop conditions. The register scopes it to Fileverse; a different partner needs F-06-9 |
| CC-D-13 | Status privacy | OPEN (synthetic parameter) | L3 (public status) / L2 (report confidentiality) | Pilot: private report only; public status deferred |
| CC-D-14 | Registry defects | OPEN | — | Separate Assurance PR, not on the path |
| CC-D-15 | Commercial terms | **OPEN, never dispositioned; recorded as blocking RN-CONFORM-06** | **L2** (pilot terms) / L4 | Decide a pilot subset: **no fee** (any fee is a separate decision and makes the pilot commercial), no certification wording, no public use of the report, liability cap, confidentiality |
| CC-D-16 | EVM adapter timing | OPEN | — | Not on the path |

## 2. New decisions this assessment surfaces

| Id | Question | Options | Recommendation |
|---|---|---|---|
| F-06-1 | What does a pilot deliver? | (a) signed private evidence report, no credential; (b) CANDIDATE credential + report; (c) ACTIVE credential | **(a)** — single-operator results cannot activate a credential (VALIDATOR_PROTOCOL.md:15–17) |
| F-06-2 | Introduce a PILOT designation alongside SYNTHETIC? | yes / no (lift synthetic interlocks) | **Yes**; never lift interlocks without a designation |
| F-06-3 | Who is the first design partner and which integration? | Fileverse-like document platform; another platform with an existing PEP | A partner that already has an enforcement point in staging (FV-P5 is not started) |
| F-06-4 | Exclude XRPL anchoring from the pilot? | exclude / include | **Exclude**; RN-03X P2-3 is open and anchoring adds no pilot value |
| F-06-5 | External human security review before the pilot | scoped review / full audit / none | **Scoped review** of custody, transport and authorization boundary (roadmap P1-09) |
| F-06-6 | Naming rule for "certification" across products | adopt CC-D-15 "never certified" repo-wide / per product | Adopt repo-wide; rename or disclaim the Provider Conformance Suite wording (roadmap P0-02) |
| F-06-7 | Authorize the P0 documentation PR | yes / no | Yes (no runtime change) |
| F-06-8 | Authorize RN-CONFORM-07 = roadmap P1-01 (authoritative testing authorization, schema `/4`) | yes / no | Yes, as the first engineering step |
| F-06-9 | Generalize CC-D-12 (or open a new decision) for a non-Fileverse design partner | generalize / new decision | Generalize: "platform testing authorization", same requirements |
| F-06-10 | KMS vendor / subprocessor for the pilot signer service | vendor A / B / self-hosted HSM | Decide before P1-03 starts; a subprocessor needs legal review |

## 3. Unchanged by this mission

- Founding Assessment: **FINAL COMMERCIAL DECISION: NO-GO** — changeable only by its own documented procedure
  ([ASSURE_COMMERCIAL_GO_NO_GO.md](../../commercial/founding-assessment/ASSURE_COMMERCIAL_GO_NO_GO.md):138–149).
- `rn.sv@0.1.0` and its golden digest.
- No $SOBE, tokens, staking, slashing or rewards.
- No external certification claimed.
