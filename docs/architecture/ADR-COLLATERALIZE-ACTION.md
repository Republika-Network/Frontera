# ADR: `COLLATERALIZE` as a governed action, and what the second enforcement taught us

- Status: Accepted
- Deciders: Frontera Systems architecture
- Related: `ADR-TOKENIZE-CAPABILITY.md`,
  `ADR-TOKENIZATION-MANDATE-PERSISTENCE.md`, `ADR-ACCESS-GRANT.md`,
  `ADR-POLICY-OBLIGATION.md`, `ADR-ENTERPRISE-GOVERNANCE-STORE.md`,
  `docs/enterprise/AOC_COLLATERALIZE_ACTION.md`,
  `docs/enterprise/AOC_TOKENIZE_CAPABILITY.md`

## Context

Frontera Systems must be able to govern whether a defined scope of specified
rights of an already-governed asset may be committed as collateral securing a
referenced obligation: by whom, for whose benefit, through which executor,
under which conditions, after which approvals, and with what durable evidence.
It must do so **without becoming a lender, a collateral agent, a registry, or a
lending platform**.

This is deliberately the **second** real enforcement. `TOKENIZE` was the
first. The purpose of implementing a second one is not only to have it, but to
obtain a second concrete specimen so we can tell — from code, not from
intuition — which parts of the first implementation were genuinely generic
Frontera Systems Enforcement infrastructure and which were specific to
tokenization.

The method was therefore fixed in advance: **implement concretely first,
generalize only where the second implementation demonstrates it, and put the
burden of proof on generalization.**

## Decision

### 1. `COLLATERALIZE` is a governed action, evaluated by the existing machinery

`capability: 'collateralize'` travels on `ActionDescriptor.capability` through
`AocKernel.evaluate()` exactly as `'tokenize'` does. No second decision path,
policy engine, authorization system, evidence system, or endpoint was
introduced. The Kernel is never bypassed; a mandate exists only for an
`allowed` decision, and only after the Governance Store aggregate is committed.

This confirmed, on a second specimen, the finding the first ADR recorded: the
repository's governance lifecycle is genuinely generalized. What a new governed
action needs is *vocabulary*, not machinery.

### 2. Four contracts in a new frozen package

`@aoc-enterprise/collateralization-mandate`, following the R004 composition
style: `EnterpriseCollateralizationRequest`, `...Mandate`,
`...ExecutionEvidence` and `...ReleaseEvidence` over a shared `...Terms`.

Terms name four references that must never collapse into one another:
`securedObligationRef` (what is secured), `securedPartyRef` (who benefits),
`executorRef` (who may perform), and — on the request/mandate —
`requestedBy` (who asked). Substitution of any of the three references is
refused with its own code, checked **before** any quantity check so a
substitution is reported as a substitution.

### 3. Durable from the first commit

Unlike `TOKENIZE`, which was memory-only in its first slice and durable in a
second, `COLLATERALIZE` shipped with both providers and one shared
store-contract suite from the start. The persistence pattern
`TOKENIZE` established — memory store + SQLite store + one port + one contract
suite + restart tests — was reused as a **convention**, not as shared code.

### 4. Collateral scope accumulates; issuance units do not

The one quantity rule with no tokenization analogue. `TOKENIZE` counts issued
units against a ceiling; `COLLATERALIZE` must sum committed *scope* against the
authorized scope, because two commitments of 15% commit 30% of the named
rights. The mandate therefore carries a cumulative `committedScope` (a scope,
not a counter — a scalar could not express unitized denominations), and
incommensurable scopes are refused rather than coerced.

### 5. Release/discharge is evidence, not a governed action and not a status

An externally-created collateral interest may later be released, discharged,
satisfied or terminated. We considered three models and rejected two:

- **A `RELEASE_COLLATERAL` governed action** — rejected for this change. It
  would be a real governed action with its own request, decision and mandate,
  and nothing yet requires Soberanía to *authorize* a release rather than *observe*
  one.
- **A mandate status (`'released'`)** — rejected outright. An external release
  is a fact about an external arrangement. Presenting it as governance state
  would be Soberanía claiming to know, or to have caused, something it did not, and
  would give the mandate a second source of truth that no pure validation
  function could keep consistent.
- **An append-only evidence record referencing the specific execution it ends**
  — adopted. It fits the existing evidence model with no lifecycle redesign.

Critically, recording a release does **not** decrement committed scope: Soberanía
cannot verify the external encumbrance ended and must not manufacture fresh
collateralization headroom from an unverified report. Release evidence is
accepted after revocation and after expiry, because reports about an
arrangement's end arrive after authority has lapsed more often than before it.

**This is the clearest action-specific lifecycle requirement the second
enforcement discovered**, and it is the strongest single piece of evidence
against a premature generic mandate lifecycle.

### 6. Revocation is not release

Revoking withdraws authority for *further* collateralization. It does not
release, discharge, terminate or invalidate a security interest an external
system already created. The revocation record preserves both the execution
count and the committed scope at the moment authority was withdrawn — the
durable proof that the authorization *had* been exercised.

### 7. No universal legal assumptions

Nothing hard-codes that an asset may carry only one collateral interest, that
an existing interest blocks another, that collateral is transferable, or that
collateralization transfers ownership. Exclusivity, priority/ranking and
aggregate limits are **constraints** on an authorization, evaluated as policy.
`requiredPriorityRank` records a requirement placed on an external system and
is compared against what that system *reports* — never a priority Soberanía
determined or a claim of legal perfection. No jurisdiction, asset class, or
technology is assumed anywhere.

`maximumSecuredAmount` is an integer count of minor units plus an **opaque**
currency label, compared only within a label and never converted. It is
deliberately not a money type or an accounting subsystem — no such primitive
existed in the repository, and inventing one to serve a single optional
constraint would have been the wrong trade.

### 8. Nothing was extracted

No shared primitive was factored out of `@aoc-enterprise/tokenization-mandate`
in this change. This is the considered outcome, not an oversight — see below.

## What the comparison actually showed

The full matrix is in `docs/enterprise/AOC_COLLATERALIZE_ACTION.md`. The
architecturally important results:

**Already generic, and proven so by being reused unchanged.** Kernel
evaluation, Recognition Runtime, Authority Graph, Approval Runtime, the
Governance Store aggregate and its reference surface, `EnterpriseAccessObligation`,
Protocol's `ResourceRef`, the canonical digest primitive, and the SQLite house
style. Both enforcements consume all of it with no modification. **The shared
machinery already exists and already works.**

**Semantically identical, but not extracted.** The scope union and its
containment rule, the right-type vocabulary, the executor binding, the mandate
reference skeleton, the two-state-status-with-derived-expiry discipline, and
the durable store's replay invariants. Semantics match — which is the
strongest evidence a generalization has yet had — but extraction would mean a
new package plus rewiring a **frozen** contract line's four modules, build
graph and publishability surface. That fails the "small and localized" test,
and two matching cases justify *recording* the candidates rather than spending
a frozen surface on them. Each is classified `NEEDS THIRD ENFORCEMENT`.

**Genuinely action-specific.** The secured obligation and secured party (no
tokenization analogue at all); the constraint vocabularies (exactly one field
overlaps); the exhaustion computation (unit ceiling vs cumulative scope sum);
the execution-evidence payloads; and the release/discharge lifecycle.

**The framework question, answered.** We deliberately did not begin by
building an enforcement framework, and the evidence says not to build one now.
Every shared *behaviour* the two enforcements have is already generalized
infrastructure they both consume unchanged. What is duplicated between them is
**vocabulary, not machinery**. A framework would add a layer over
infrastructure that already works, in exchange for coupling two frozen contract
lines. Two examples reveal candidate primitives; they do not justify a
framework.

## Consequences

- Frontera Systems now demonstrably has a governance architecture that is **not
  tokenization-specific**: the same asset can be the subject of two
  independent governed actions, each with its own enforcement, mandate,
  durable store and evidence chain.
- There is measured, recorded duplication between the two contract packages.
  It is documented in both packages' READMEs and in the action documentation,
  with an explicit verdict per candidate, so a third enforcement inherits the
  analysis rather than repeating it.
- `authorization_artifact` as a `GovernanceReferenceRecord.referenceType` has
  now earned its place on the evidence — two grant-shaped mandate artifacts
  are both being recorded as `external_artifact`, which is a real mislabel for
  records Soberanía itself produces. It is **not** introduced here because emitting a
  new stored value is a Governance Store change with its own migration and
  version-guard story; bundling it with a new governed action would put a
  persistence-compatibility change where reviewers are not looking for one. It
  is recommended as a dedicated follow-up covering both actions together.
  **Since resolved:** that follow-up landed, and both mandates are now
  classified `authorization_artifact`. The compatibility question came back
  "no schema migration, no version bump" — `reference_type` is unconstrained
  `TEXT` and both schema-version guards are indifferent to the vocabulary — so
  the change was an added union member, a write-path validity guard, and the
  two emitted values. Historical `external_artifact` rows are left unrewritten.
  See "Reference vocabulary" in
  `docs/enterprise/AOC_ENTERPRISE_GOVERNANCE_STORE.md`.
- No Soberanía Protocol change was required or is recommended. Enterprise maintains
  the complete collateralization authority/evidence lineage on its own;
  Protocol supplied only `ResourceRef`. `COLLATERALIZE` suggests an
  *encumbrance / governed-interest lineage* concept much as `TOKENIZE`
  suggested *derived-representation lineage*, and the second case does
  strengthen the abstract argument for a Protocol relationship primitive — but
  neither produced a **cross-sovereignty** requirement, which is the threshold
  such a primitive must clear. Implementing one now would be speculative.

## Alternatives considered

- **Extract a shared rights/scope package now.** Rejected: fails the
  "small and localized" constraint against a frozen contract line, and would be
  a change to `TOKENIZE`'s public surface made for `COLLATERALIZE`'s benefit.
- **Model collateralization as a variant of `TOKENIZE`.** Rejected: they are
  different actions with different meanings. Reusing a TypeScript shape because
  it happens to match is exactly the mistake the method was designed to avoid.
- **Store a `releasedScope` and net it against `committedScope`.** Rejected:
  it would let an unverified external report create fresh collateralization
  capacity.
- **Give the mandate a `'released'` status.** Rejected: a second source of
  truth for a fact Soberanía did not determine.
- **Model the secured obligation as a full lending-domain object.** Rejected:
  an opaque canonical reference plus an optional never-interpreted kind label
  answers "what is this securing?" without Soberanía acquiring a lending domain it
  has no business owning.
