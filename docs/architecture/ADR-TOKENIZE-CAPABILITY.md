# ADR: `TOKENIZE` as a governed capability

- Status: Accepted
- Deciders: Frontera Systems architecture
- Related: `ADR-ACCESS-GRANT.md` (`EnterpriseAccessGrant`),
  `ADR-ACCESS-DECISION.md`, `ADR-POLICY-OBLIGATION.md`,
  `ADR-DURABLE-GRANTS-REVOCATION.md`, `ADR-ENTERPRISE-GOVERNANCE-STORE.md`,
  `ADR-EVIDENCE-CORRELATION.md`, `docs/kernel/AOC_KERNEL_INVARIANTS_V1.md`,
  `docs/enterprise/AOC_TOKENIZE_CAPABILITY.md`

## Context

Frontera Systems must be able to govern whether an already-governed asset may
be tokenized: by whom, over which rights, in what portion, through which
executor, under which conditions, after which approvals, and with what
durable evidence. It must do so **without becoming a tokenization platform**.

### What the repository already had

A full-repository survey found the governance lifecycle already complete and
already generalized:

- **Capability is an open string, everywhere.** `ActionDescriptor.capability`
  (`src/kernel/contracts/kernel-request.ts`), `AuthorityGrant.capability`
  (`src/features/authority-graph/domain/authority-grant.ts`) and
  `RecognitionCapabilityToken.capability`
  (`src/features/recognition-runtime/domain/capability-token.ts`) all carry a
  free-form capability name. **No closed capability registry, enum, table, or
  schema exists** — and none of `PROTOCOLIZE`, `REGISTER`, `TRANSFER`,
  `LICENSE`, `DELEGATE`, `COLLATERALIZE` or `COMMERCIALIZE` appears anywhere
  in the codebase either. Capability names are data the authority and
  recognition runtimes match on, not a type the platform enumerates.
- **One decision path.** Every capability request flows
  `KernelEvaluationRequest -> AocKernel.evaluate() -> KernelEvaluationResult`,
  reaching Recognition Runtime, Authority Graph, Approval Runtime, External
  Agent Handshake and the Domain Policy Pack Runtime transitively through the
  injected `RecognitionProvider`.
- **One durable evidence system.** The Governance Store commits one atomic,
  integrity-chained aggregate per evaluation (request + evaluation + trace +
  reason codes + events + metadata + integrity), tenant-scoped, append-only,
  with `appendReference` already reserved for linking an evaluation to a
  downstream artifact.
- **One generalized public interface.** `POST /api/governance/evaluate` is
  the capability-request API, and it is part of the frozen v1 surface
  (`release/api-surface.v1.json`).
- **A settled grant-shaped precedent.** The R004 line —
  `EnterpriseResourceEnvelope -> EnterpriseAccessDecision ->
  EnterpriseAccessObligation -> EnterpriseAccessGrant ->
  EnterpriseGrantRevocation / EnterpriseUsageEvent ->
  EnterpriseEvidenceCorrelation` — plus its durable module
  (`src/enterprise/access-governance/`) is the closest architectural analog:
  decision -> obligations -> durable grant -> revocation -> usage evidence.

### What was genuinely missing

Only the vocabulary of the authorization itself. `action.parameters` is an
untyped `Record<string, unknown>`, so the generalized path could carry a
tokenization request but could not *express*, validate, or durably preserve:
which rights, what portion of them, which executor, under what issuance
limits — nor a durable artifact recording what was authorized, nor a place to
record what an external system actually issued under it.

## Decision

Implement `TOKENIZE` as a capability of the existing model, not as a
subsystem.

1. **`TOKENIZE` is the capability name `'tokenize'`**, carried on
   `ActionDescriptor.capability` and matched by Authority Graph and
   Recognition Runtime against their own grants and tokens. No capability
   registry is introduced; `ENTERPRISE_CAPABILITIES_DISTINCT_FROM_TOKENIZE`
   records the distinction from neighbouring actions as data, and request
   validation enforces it structurally.

2. **One new frozen contract package**,
   `@aoc-enterprise/tokenization-mandate`, following the R004 convention
   exactly (closed vocabularies, typed validation codes, identity/structural
   equality, deterministic serialization, references not embeddings):
   `EnterpriseTokenizationRequest`, `EnterpriseTokenizationMandate`,
   `EnterpriseTokenizationExecutionEvidence`, over a shared
   `EnterpriseTokenizationTerms`.

3. **One new Enterprise module**,
   `src/enterprise/tokenization-governance/`, mirroring
   `src/enterprise/access-governance/`: a durable tenant-scoped store, a
   two-state lifecycle, and a service that routes the request through
   `AocKernel.evaluate()` and commits the Governance Store aggregate
   **before** any mandate can exist.

4. **No new decision, policy, evidence, or authorization system**, no
   `/api/tokenize` endpoint, and no blockchain code anywhere in the
   governance core.

### Consequences

- A `TOKENIZE` denial is an ordinary governance denial with the Kernel's own
  reason codes. The module has no error code for "lacks authority", because
  that is a decision, not an exception.
- `approval_required` produces no mandate. An outstanding approval is not
  authorization.
- Because the mandate's terms are copied verbatim from the validated request
  and containment is re-asserted at the persistence boundary, `20%` cannot
  become `100%` between request and mandate — including through any future
  second write path.
- Because the mandate stores only `'active' | 'revoked'`, and expiry,
  exhaustion and executor limits are derived by a pure function from fields
  that already record them, no derived state can ever disagree with its
  source.

## Alternatives considered

**A tokenization subsystem with its own request/decision/evidence path.**
Rejected: it would duplicate the policy engine, the evidence system and the
authorization system the repository already has, and the task's own
constraints forbid exactly that. Roughly 80% of what `TOKENIZE` needs already
exists generically; this ADR implements the remaining 20%.

**Extending `EnterpriseAccessGrant` to cover tokenization.** Rejected: an
access grant answers "who may reach this resource", identified by
`principalId` and bounded by time. A tokenization mandate answers "which
rights, in what portion, may be represented externally, by which executor,
under what issuance limits". Overloading one contract with both would make
`resource`/`scope` mean two different things depending on the reader — the
same conflation `ADR-DURABLE-GRANTS-REVOCATION.md` (GAP-012) documents as a
defect when it happened to `resource.id`.

**A closed capability enum spanning `PROTOCOLIZE`/`TOKENIZE`/`TRANSFER`/…**
Rejected: no such registry exists, and none of those names appears in the
codebase. Inventing one would constrain every downstream authority grant and
capability token to a vocabulary this repository has deliberately left open.

**A blockchain execution adapter.** Rejected as out of scope, and as a
boundary violation if placed in the governance core.
`EnterpriseTokenizationExecutionEvidence` is the integration seam; a provider
adapter would sit outside it, exactly where the Pinata adapter sits relative
to Access Governance.

**Floating-point percentages for scope.** Rejected: `0.1 + 0.2 !== 0.3`.
Shares are integer basis points.

## Boundary

```
Soberanía Protocol    asset identity, authority, attestations, evidence,
                      sovereignty boundary
      |
Frontera Systems  request -> policy -> decision -> obligations ->
                      approvals -> grant (TokenizationMandate) -> use ->
                      revocation -> evidence
      |
External system       token issuance
```

Frontera Systems owns the decision to authorize tokenization. It never
performs issuance, and it never claims authority over tokens an external
system has already issued.
