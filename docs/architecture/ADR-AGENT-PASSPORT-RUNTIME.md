# ADR: Frontera Systems Agent Passport Runtime v1

- Status: Accepted (PR-006)
- Deciders: Frontera Systems architecture
- Related: `ADR-ENTERPRISE-GOVERNANCE-STORE.md`, `ADR-EVIDENCE-BUNDLE.md`,
  `docs/enterprise/AOC_AGENT_PASSPORT_CURRENT_MODEL.md`,
  `docs/enterprise/AOC_AGENT_PASSPORT_RUNTIME.md`,
  `docs/enterprise/AOC_AGENT_PASSPORT_MODEL.md`,
  `docs/enterprise/AOC_AGENT_PASSPORT_LIFECYCLE.md`,
  `docs/enterprise/AOC_AGENT_PASSPORT_DISCLOSURE.md`,
  `docs/enterprise/AGENT_PASSPORT_MIGRATION_V1.md`

## Context

- A commercial Agent Passport product (`packages/agent-governance`,
  `apps/agent-passport-web`) already exists, but predates the Governance
  Store (PR-004) and Evidence Bundle (PR-005) and has no relationship to
  either.
- Passport concepts are fragmented across the repository: a commercial,
  signed credential (`agent-governance`); a lightweight recognition
  credential the Kernel's Recognition Runtime consults
  (`recognition-runtime.Passport`); and a demo-scoped wrapper
  (`pmfreak-agent-passport-foundation`). None of the four is event-sourced,
  organization-bound in the Enterprise sense, or capable of referencing a
  Governance Record or Evidence Bundle.
- The Governance Store and Evidence Bundle now exist and already reserve
  forward references to a future Passport (`GovernanceReferenceRecord.
  referenceType: 'passport_event'`, `EvidenceReferenceType: 'passport'`) —
  Enterprise needs the identity/history aggregate those references point
  at.
- Trust scoring would be premature and dangerous: no governed,
  documented, explainable methodology exists yet for collapsing an
  agent's history into a single number, and doing so would misrepresent
  what the Passport can actually attest to.

## Decision

Create the Frontera Systems Agent Passport Runtime v1
(`src/enterprise/passport/`):

- **Append-only Passport events, reconstructed state.** A Passport is
  never stored as one mutable row. `AgentPassportEvent`s
  (`AgentPassportCreated`, `...Activated`, `...Suspended`, `...Revoked`,
  etc.) are the canonical record; `reconstructAgentPassportFromEvents`
  folds them into the current `AgentPassport` read model — the same
  discipline the Governance Store uses for one evaluation aggregate,
  applied to one Passport aggregate.
- **Per-Passport hash chain, reusing the Governance Store's own digest
  primitive.** Each event carries `previousEventDigest`/`eventDigest`
  (SHA-256 over `aoc.canonical-json.v1`, imported verbatim from
  `../governance-store/canonical-json.js` / `digest.js` — never a second,
  incompatible canonicalizer). The chain is scoped to one Passport, not
  one store-wide chain, so verifying one Passport never requires touching
  another's history.
- **Reference, never copy, Governance Records and Evidence Bundles.**
  `PassportGovernanceReference` carries `evaluationId`/`decisionId`/
  `requestId`/`status`/`governanceRecordDigest` only;
  `PassportEvidenceReference` carries `bundleId`/`bundleDigest`/
  `disclosurePolicy` only. Linking validates existence, tenant match, and
  digest match against the real Governance Store / Evidence Bundle Store
  — it never embeds their content.
- **A stable six-status lifecycle**, enforced by one state machine
  (`lifecycle.ts`) that both the reconstruction fold and the append path
  consult, so they can never disagree: `draft → active ⇄ suspended →
  {revoked, expired, retired}` (terminal). A revoked/expired/retired
  Passport is never reactivated in v1 — a new Passport is issued instead.
- **Explicit organization binding**, enforced by a
  `PassportAccessContext` structurally identical to the Governance
  Store's own `GovernanceStoreAccessContext` (`system` / `organizationId`
  / `actorId`). Trust is domain-bound: a Passport issued by one
  organization is never globally trusted.
- **No arbitrary trust score.** `AgentPassportHistorySummary` exposes
  bounded, reference-derived counts (evaluations referenced, allowed/
  denied/approval-required counts, suspensions, revocations) and nothing
  is ever collapsed into one number. `AgentPassportClaim`s stay observable
  facts ("passport.active", "governance.history-present"), never
  subjective judgements ("agent.trustworthy").
- **Minimal-disclosure views**, mirroring the Evidence Bundle's
  `Truth ≠ Disclosure` principle on Passport's own field set (not an
  assumed-identical copy of Evidence's disclosure policies): INTERNAL,
  AUDITOR, PARTNER, CUSTOMER, PUBLIC. Each view carries its own digest,
  distinct from the event-chain digest and the reconstructed-state digest.
- **Two Store implementations behind one contract**
  (`AgentPassportStore`), in-memory and SQLite, sharing the same
  reconstruction fold so they cannot drift. The SQLite schema uses a
  partial `UNIQUE` index (`WHERE current_status IN ('draft','active',
  'suspended')`) to enforce "only one non-terminal Passport per
  (organization, agentId)" at the database layer, backed by an
  application-level check for a clear error message.
- **Existing SaaS untouched.** `packages/agent-governance`,
  `apps/agent-passport-web`, and `packages/pmfreak-agent-passport-
  foundation` are not modified, not imported by, and do not import the new
  Runtime — see `AGENT_PASSPORT_MIGRATION_V1.md` for the coexistence
  strategy.
- **Optional-by-default module criticality.** `aoc.enterprise.agent-
  passport` registers as an `EnterpriseModule` whose criticality
  (`required`/`optional`) is configuration-driven
  (`AOC_ENTERPRISE_PASSPORT_REQUIRED`), not hardcoded — a deployment that
  makes Passport-backed recognition mandatory sets it explicitly; the
  default lets a Passport Store outage degrade without blocking
  governance evaluation.

## Rejected Alternatives

- **Use the existing `agent-governance` schema as the protocol model.**
  Rejected: it is a signed commercial credential (constitution hash,
  policy-manifest hash, QR payload, verification URL) with no Governance
  Store/Evidence Bundle integration and no event sourcing — adopting it
  verbatim would import product concerns into the Enterprise protocol
  layer.
- **Store the Passport as one mutable JSON blob.** Rejected: no
  auditable history, no chain-of-custody for status changes, no way to
  reconstruct "what did we know about this agent at time T."
- **Make Passport recognition global/organization-independent.**
  Rejected: violates the stated principle that trust is domain-bound; one
  organization's recognition must never be silently treated as another's.
- **Calculate one trust score.** Rejected: no defensible methodology
  exists yet; a number invites over-trust and cannot be explained or
  disputed the way a list of references can.
- **Copy full Governance Records/Evidence Bundles into the Passport.**
  Rejected: duplicates the source of truth, doubles the disclosure
  surface, and makes the Passport a second place tampering could hide.
- **Implement W3C Verifiable Credentials / DIDs / blockchain anchoring
  now.** Rejected: no key custody, no external identity federation, and
  no non-repudiation requirement has been established yet — premature
  infrastructure the mission explicitly excludes from v1.
- **Rewrite `apps/agent-passport-web` onto the new model in this PR.**
  Rejected: out of scope, high blast radius, no functional need — the SaaS
  app keeps working against `agent-governance` unmodified; a future,
  separately-scoped migration can build an adapter if/when the two
  products need to converge.

## Consequences

- Positive: Enterprise now has a governed, durable, minimally-disclosed
  identity and history object for agents, closing the loop
  `Evaluate → Record → Reconstruct → Verify → Project → Share Evidence →
  Identify` that PR-001 through PR-005 built toward.
- Positive: the Kernel, Governance Store, and Evidence Bundle are
  completely unaffected — the full existing test suite (3120 tests across
  `dist/**/*.test.js`) passes unmodified except for one hardcoded
  built-in-module-list assertion updated to include the new module id.
- Positive: the existing commercial Passport product and PMFreak demo
  keep working exactly as before; nothing in this PR touches their code
  paths.
- Trade-off: v1 has no background scheduler — expiration
  (`AgentPassportExpired`) is an explicitly appended event, not a
  time-derived status; a caller (future scheduled job, or a read-path
  check) must detect and append it. This is the one deterministic choice
  mission section 27 asks for, and it is documented rather than silently
  assumed.
- Trade-off: verification's `REFERENTIAL`/`FULL_INTERNAL` modes confirm a
  referenced Governance Record/Evidence Bundle *exists and matches its
  digest*; they do not re-run governance evaluation or re-verify the
  Bundle's own internal disclosure-policy correctness — that remains
  `governanceReads.verify()`/`evidence.verify()`'s job.
- Deferred risk: the Passport Runtime's integrity model is the same class
  as the Governance Store's own — SHA-256 over canonical JSON detects
  post-append tampering of the bytes a reader holds; it is not a digital
  signature and not non-repudiation. See Known Limitations in
  `AOC_AGENT_PASSPORT_RUNTIME.md`.
