# The `COLLATERALIZE` Governed Action

- Contracts: `@aoc-enterprise/collateralization-mandate`
- Runtime: `src/enterprise/collateralization-governance/`
- Decision record: `docs/architecture/ADR-COLLATERALIZE-ACTION.md`
- Sibling action: `docs/enterprise/AOC_TOKENIZE_CAPABILITY.md`

## Architectural terminology

Two layers, two vocabularies. They are not synonyms and must not be conflated:

```
Soberanía Protocol
  → Sovereignty Capabilities     what a sovereign holds

Frontera Systems
  → Governed Actions             what may be exercised
  → Enforcements                 the evaluation of whether it may be
  → Grants / Mandates            the durable authorization that results
```

Frontera Systems now has **three** governed actions. This document covers the
second; see `docs/enterprise/AOC_LICENSE_ACTION.md` for the third, and
`docs/architecture/ADR-ENTERPRISE-ENFORCEMENT-VOCABULARY.md` for the
three-enforcement semantic audit that compares all of them.

```
TOKENIZE                    = a Governed Action.
COLLATERALIZE               = a Governed Action.
LICENSE                     = a Governed Action.

Tokenization Enforcement    = Frontera Systems evaluates whether TOKENIZE
                              may be exercised.
Collateralization           = Frontera Systems evaluates whether COLLATERALIZE
Enforcement                   may be exercised.

TokenizationMandate         = the durable authorization artifact a successful
                              TOKENIZE enforcement produced.
CollateralizationMandate    = the durable authorization artifact a successful
                              COLLATERALIZE enforcement produced.
```

A Protocol Sovereignty Capability is not an Enterprise Governed Action. The
Protocol establishes what authority exists and anchors its evidence;
Enterprise governs the *exercise* of that authority.

**A note on the field name.** The technical field carrying an action's
identifier is still called `capability` — `ActionDescriptor.capability`,
`AuthorityGrant.capability`, `RecognitionCapabilityToken.capability`,
`EnterpriseCollateralizationRequest.capability`. That is the repository's
existing contract surface and is deliberately left alone: this terminology is
a documentation model, not a rename. Read `capability: 'collateralize'` in
code as "the identifier of the Governed Action `COLLATERALIZE`".

## Definition

> **COLLATERALIZE** — authorizing a specified executor to subject a defined
> scope of specified rights associated with an already-governed asset to an
> external collateral or security arrangement securing a referenced
> obligation, under defined governance conditions.

It is evaluated by the same primitives every other governed action is
evaluated by. It introduces no second policy engine, no second evidence
system, no second authorization system, and no action-specific API.

## Boundary

```
Governed Asset
      ↓
Frontera Systems
COLLATERALIZE request
      ↓
authority · policy · approvals · obligations
      ↓
decision
      ↓
CollateralizationMandate
      ↓
EXTERNAL SYSTEM
      ↓
collateral arrangement
      ↓
execution evidence
```

**Frontera Systems authorizes collateralization. Frontera Systems is not the
lender, the collateral agent, the registry, or the platform.**

It does not originate or service loans, compute interest or loan-to-value,
price or value assets, create or perfect security interests, determine
priority against any registry, file anything anywhere, liquidate or seize
collateral, or contact any external system. It holds no keys and assumes no
jurisdiction, no asset class, and no technology.

> Soberanía authorizes external actions. Soberanía does not claim to have performed
> external legal or technical execution unless evidence proves that an
> external execution occurred.

## Three distinctions that carry weight

```
PROTOCOLIZE     establishes governed identity / authority / evidence context

TOKENIZE        authorizes creation of an external tokenized representation
                of rights

COLLATERALIZE   authorizes specified rights to be committed as collateral
                for a referenced obligation
```

And, separately from all three:

```
COLLATERALIZE != TRANSFER
```

Committing rights as collateral does **not** transfer ownership of them.
Nothing in this action moves, assigns, or reassigns a right.

The distinctions are recorded as data in
`ENTERPRISE_ACTIONS_DISTINCT_FROM_COLLATERALIZE` and enforced structurally by
`validateEnterpriseCollateralizationRequest`, which rejects any request whose
`capability` is not exactly `'collateralize'`.

## Lifecycle

```
Governed asset
      ↓
COLLATERALIZE request        EnterpriseCollateralizationRequest (validated)
      ↓
authority evaluation         Authority Graph, via Recognition Runtime
      ↓
policy evaluation            Action Enforcement chain + Domain Policy Pack
      ↓
required approvals           Approval Runtime (quorum, SoD, delegation)
      ↓
obligations                  EnterpriseAccessObligation references
      ↓
decision                     AocKernel.evaluate() → KernelEvaluationResult
      ↓
durable proof                Governance Store aggregate (atomic, integrity-chained)
      ↓
grant / deny                 mandate issued only for `allowed`
      ↓
CollateralizationMandate     EnterpriseCollateralizationMandate
      ↓
durable persistence          CollateralizationMandateStore (SQLite)
      ↓
process restart              mandate, revocation, committed scope recovered
      ↓
external execution           an external system, outside Soberanía
      ↓
execution evidence           EnterpriseCollateralizationExecutionEvidence
      ↓
release / discharge          EnterpriseCollateralizationReleaseEvidence
evidence (optional)          — observation only, see below
      ↓
audit trail                  Governance Store references + append-only evidence
```

Every box above is an existing Soberanía primitive except the four contract
artifacts, which are this action's own. The Kernel is never bypassed and no
shortcut issues mandates directly.

## Domain semantics

### Request

A `COLLATERALIZE` request can never say merely "collateralize asset X". It
must express:

| Concept | Field |
|---|---|
| Governed subject | `asset: ResourceRef` (identity only) |
| Rights committed | `terms.rights` — closed vocabulary |
| Scope | `terms.scope` — proportional (basis points) or unitized |
| Secured obligation | `terms.securedObligationRef` (+ optional opaque `securedObligationKind`) |
| Secured party | `terms.securedPartyRef` |
| Authorized executor | `terms.executorRef` |
| Constraints | `terms.constraints` |
| Requester | `requestedBy` (+ `principalActorId` when acting on behalf) |

### Four identities, never conflated

```
Requester:      Asset Owner A     requestedBy
Secured Party:  Lender B          terms.securedPartyRef
Executor:       Provider C        terms.executorRef
Obligation:     Obligation-001    terms.securedObligationRef   (not a party)
```

These may be four different identities, and the system prevents unauthorized
substitution between them: `enterpriseCollateralizationMandateAuthorizes`
refuses an executor, secured-obligation or secured-party substitution with its
own refusal code, **before** any quantity check runs, so a substitution is
reported as a substitution rather than as a downstream scope problem.

### Secured obligation

`securedObligationRef` is an opaque canonical pointer to an obligation
established elsewhere — an external loan, a credit facility, a contractual
obligation, or another governed obligation. Soberanía does not originate that
obligation, does not evaluate whether it is legally valid or enforceable, and
does not resolve the reference. It preserves it because it answers *what is
this collateral authorization securing?*, and because an execution naming a
different obligation must be refused.

### Scope

```ts
{ kind: 'proportional', basisPoints: 2000 }                            // 20%
{ kind: 'unitized', units: 500, unitDenomination: 'entitlement-unit' } // 500 units
```

Integer basis points, never floating point. Proportional and unitized scopes
are never comparable to one another, and unitized scopes must agree on
denomination.

**Partial collateralization is the normal case.** Authorizing 20% of defined
economic rights leaves the remaining 80% unencumbered by that authorization,
and the mandate says so explicitly. 20% never silently becomes 100% — not in
the request, not in the mandate, not after persistence, and not after a
restart.

**Collateral scope accumulates.** This is the one quantity rule with no
tokenization analogue. Two commitments of 15% each commit 30% of the named
rights, so an authorization for 20% refuses the second even though 15% is, on
its own, inside 20%. The mandate carries a cumulative `committedScope`, summed
from recorded execution evidence with exact integer arithmetic; incommensurable
scopes are refused, never coerced.

### Authority

Soberanía never infers ownership or authority from the fact that somebody asked. A
`COLLATERALIZE` request is evaluated against the existing authority model, so
policy can require that the requester holds `COLLATERALIZE` authority, or was
delegated it, and/or that sovereign/owner approvals are satisfied — expressed
through `AuthorityGrant` / `DelegationGrant` / `RecognitionCapabilityToken`,
not through anything this action invented. Direct, delegated, corporate,
multi-approval and partial-right authority topologies are all expressible.

Where authority is absent or insufficient, the request is **denied** by the
canonical decision path, and no mandate exists.

### Approvals

Approval semantics come from the Approval Runtime's existing quorum,
segregation-of-duties, approver-authority and delegation policies. Nothing
here hard-codes "all owners must approve".

An `approval_required` outcome produces **no mandate**. An outstanding
approval is not authorization.

### Obligations and constraints

Obligations attach to the decision through the existing generalized obligation
system (`EnterpriseAccessObligation`), referenced from the mandate by
`obligationRefs`. Declared limits the authorization itself carries:

```
only X% may be committed                   (terms.scope)
only this obligation may be secured        (terms.securedObligationRef)
only this party may benefit                (terms.securedPartyRef)
only provider C may execute                (terms.executorRef)
at most N minor units may be secured       (constraints.maximumSecuredAmount)
only these registries may be used          (constraints.permittedRegistries)
only these jurisdictions                   (constraints.permittedJurisdictions)
the arrangement must rank no less senior   (constraints.requiredPriorityRank)
  than R
the arrangement must be exclusive          (constraints.exclusive)
release evidence must be reported back     (constraints.releaseEvidenceRequired)
no additional collateralization            (constraints.additionalCollateralizationAllowed: false)
authorization expires at T                 (mandate.expiresAt)
external evidence must be returned         (obligation record)
```

Constraint labels (`permittedRegistries`, `permittedJurisdictions`) are opaque
strings Soberanía stores and compares. Soberanía does not resolve them, validate them
against any real system, or enforce them anywhere outside itself.

`maximumSecuredAmount` is an integer count of a currency's minor units
alongside an **opaque** currency label. Soberanía performs no arithmetic on it beyond
comparing two amounts of the same label, never converts between currencies,
never discovers a rate, and never prices an asset. Amounts whose labels differ
are simply not comparable and fail closed. This is deliberately not a money
type or an accounting subsystem.

### Multiple collateral interests are not prohibited

Nothing here hard-codes "an asset can only have one collateralization" or
"an existing collateralization always blocks another". Multiple security
interests, ranking, priority and subordinate interests may exist externally,
and collateral arrangements differ by jurisdiction and structure.

Where a deployment needs exclusivity, priority or aggregate limits, those are
expressed as policy and as the constraints above. Soberanía makes no universal legal
assumptions on anyone's behalf, and in particular does not assume that all
collateral is transferable or that collateralization transfers ownership.

`requiredPriorityRank` records a requirement placed on an external system and
is compared against what that system *reports*. Recording it is not a claim
that Soberanía determined, perfected, or can enforce priority anywhere.

### Mandate

`EnterpriseCollateralizationMandate` is the durable, machine-readable
artifact. From one mandate a reviewer can reconstruct: mandate identity,
tenant, asset, rights, scope, requester, decision reference, authority path
(via `evaluationRef`), secured obligation, secured party, executor,
constraints, obligation references, approval references, evidence references,
effective time, expiry, revocation state, execution references, and
release/discharge evidence references.

Everything except the terms is a reference to a canonical Soberanía record. The
terms are carried directly because a mandate must be auditable without
dereferencing the request.

### Revocation is not release

Stored status is `'active' | 'revoked'` only. Expiry, exhaustion and
cumulative-scope containment are derived — never stored as a second source of
truth that could disagree.

```
revocation of authority to perform further collateralization   ← what Soberanía can do
external treatment of a security interest already created      ← not Soberanía's to claim
```

Revoking a mandate blocks new external collateralization from that moment. It
does **not** release, discharge, terminate, or invalidate a security interest
an external system already created, and Soberanía does not pretend otherwise.
Execution evidence recorded before revocation is preserved immutably, and the
revocation record preserves both the execution count and the committed scope
at the moment authority was withdrawn.

### Release and discharge evidence

An externally-created collateral interest may later be released, discharged,
satisfied, or terminated. `EnterpriseCollateralizationReleaseEvidence` records
that an external system **reported** one of those. It is deliberately:

- **not a governed action.** No `RELEASE_COLLATERAL` exists in this change. No
  authority is evaluated, no decision is produced, nothing is authorized. If
  releasing collateral ever needs to be *authorized* by Soberanía rather than merely
  *observed*, that is a separate governed action with its own request,
  decision and mandate.
- **not a mandate status.** An external release is a fact about an external
  arrangement; presenting it as governance state would be Soberanía claiming to
  know, or to have caused, something it did not.
- **not a restoration of headroom.** Recording a release does not decrement
  committed scope. Soberanía cannot verify that the external encumbrance ended and
  must not manufacture fresh collateralization capacity from an unverified
  report.

It references both the mandate and the specific execution it ends, so one
arrangement can be followed from authorization through creation to reported
release without a second audit system. Release evidence is accepted after
revocation and after expiry, deliberately: reports about an arrangement's end
arrive after authority has lapsed far more often than before it, and refusing
them would discard exactly the evidence an auditor needs.

**This is the clearest action-specific lifecycle requirement the second
enforcement discovered.** `TOKENIZE` has no analogue: an issued token is not
"released".

### Evidence lineage

The complete chain is auditable through existing mechanisms only:

```
asset → authority → request → policy evaluation → approvals → decision
      → obligations → mandate → external execution evidence
      → optional release/discharge evidence
```

`getEvidenceLineage()` assembles it from references already stored — never a
second, collateralization-specific audit log. It answers: why was
collateralization permitted, who had authority, which rights were committed,
what portion of them, what obligation was secured, who the secured party was,
who was authorized to execute it, what restrictions applied, whether the
external execution was consistent with the mandate, and whether any
arrangement has been reported as released.

## Durability

`CollateralizationMandateStore` has two implementations behind one port,
mirroring every other Enterprise entity store:

| Provider | Factory | Use |
|---|---|---|
| `memory` | `createInMemoryCollateralizationMandateStore()` | tests, development, memory deployments |
| `sqlite` | `createSqliteCollateralizationMandateStore(dbPath)` | durable deployments |

Both are held to identical domain semantics by one shared store-contract suite
that runs every behavioural assertion against both providers. Unlike
`TOKENIZE`, which was memory-only in its first slice, `COLLATERALIZE` was
durable from its first commit.

The SQLite store follows the same house style as the Governance, Passport,
Assurance, Access Grant and Tokenization Mandate stores: its own database
file, lazy `better-sqlite3` import, `WAL` + `synchronous=FULL` +
`foreign_keys=ON` + `busy_timeout`, a schema-version guard that **refuses to
open** a database written under a different version (before any DDL runs, so a
refused store is never mutated), synchronous transactions for multi-statement
writes, and typed domain errors instead of raw driver errors.

### Schema `aoc.collateralization-mandate-store.schema.v1`

| Table | Purpose |
|---|---|
| `collateralization_mandate_store_versions` | schema-version guard row |
| `collateralization_mandates` | current-state mandate row |
| `collateralization_executions` | **append-only** external execution evidence |
| `collateralization_releases` | **append-only** reported release/discharge evidence |
| `collateralization_mandate_revocations` | at-most-one revocation per mandate |

The invariants that matter are database constraints, not application
bookkeeping, so they hold against a writer this process never sees:
`request_ref UNIQUE` (one request authorizes at most one mandate),
`execution_id PRIMARY KEY` (one arrangement recorded at most once),
`release_id PRIMARY KEY` with an `execution_id` foreign key (a reported
release always references an arrangement Soberanía has evidence of), `mandate_id
UNIQUE` on revocations, and `(mandate_id, sequence) UNIQUE` on both evidence
tables for a restart-stable append order.

`committed_scope_json` is deliberately a *scope*, not a counter: collateral
scope accumulates and must be compared against the mandate's own scope, which
a scalar could not express for unitized denominations. Its update is guarded on
the execution count the call read, so a concurrent writer cannot commit a total
computed from a stale read.

### Stored vs derived, after persistence

Stored: `status` (`'active' | 'revoked'`), `committedScope`, `executionCount`,
timestamps. Still derived on every read: **expired**, **exhausted**,
**cumulative containment** — computed by
`enterpriseCollateralizationMandateAuthorizes` from the fields that already
record the underlying facts. A recovered mandate past its `expiresAt` still
carries `status: 'active'` and is still refused.

### Integrity and corruption

`terms` — the rights, scope, secured obligation, secured party, executor and
constraints — is stored as its canonical serialization alongside
`terms_digest`, the repository's own canonical SHA-256-over-`aoc.canonical-json.v1`
digest. Every read recomputes and compares, because that column is exactly what
a scope escalation or an obligation/party/executor substitution would have to
alter.

A corrupted or malformed record fails closed with
`COLLATERALIZATION_RECORD_CORRUPTED` and **never** becomes a valid
authorization — whether the digest mismatches, the JSON is unreadable, the
status is unrecognized, the stored committed scope is malformed, a release
carries an unrecognized category, or the row does not reconstruct into a valid
`EnterpriseCollateralizationMandate` under the frozen contract's own validator.
This is integrity detection, not a signature: the limits documented for the
Governance Store's digests apply here too.

## Reference scenario

```
Asset:               Building A
Governed rights:     economic-interest, revenue-right
Available scope:     100%
Governed Action:     COLLATERALIZE
Requested scope:     2000 basis points = 20%
Secured obligation:  Obligation-001
Secured party:       Lender B
Executor:            Collateral Provider C
```

Executable as `COLLATERALIZE durability — H. reference scenario`
(`src/enterprise/__tests__/collateralization-durability.test.ts`), spanning
three store instances over the same database files. It proves that after two
restarts 20% is still 20%, and that the secured obligation, secured party,
executor, tenant and constraints are all unchanged — and that an unauthorized
attempt cannot expand scope to 100%, replace the secured obligation, replace
the secured party, replace the executor, or replay the execution.

## TOKENIZE vs COLLATERALIZE

The comparison is the point of having a second enforcement. Assessed against
the code, not against intuition.

> **Superseded by the three-way audit.** A third enforcement has since landed,
> and it changed several conclusions below — notably that executor binding is
> **not** generic and that scope is not always required. The table here is
> retained as the record of what two enforcements supported; see
> `docs/architecture/ADR-ENTERPRISE-ENFORCEMENT-VOCABULARY.md` for the
> current, three-way finding.

| Concern | TOKENIZE | COLLATERALIZE | Generic? |
|---|---|---|---|
| Governed asset (`ResourceRef`, identity only) | yes | yes | **yes** — already shared via Protocol/`resource-envelope` |
| Rights vocabulary | 5 categories | same 5 categories | **semantically yes**, duplicated in code |
| Scope (basis points / unitized, containment) | yes | yes | **semantically yes**, duplicated in code |
| Scope arithmetic | none — units counted separately | cumulative scope **sum** | no — action-specific |
| Executor binding | yes | yes | **semantically yes**, duplicated in code |
| Counterparty | absent | required (`securedPartyRef`) | no |
| Underlying obligation | absent | required (`securedObligationRef`) | no |
| Constraints | networks, token standards, max units, transfer-restricted | registries, jurisdictions, max secured amount, priority rank, exclusive, release evidence | no — one field overlaps (`permittedJurisdictions`) |
| Exhaustion basis | `issuedUnits` vs a unit ceiling | committed scope vs the authorized scope | no |
| Mandate reference skeleton | yes | yes | **semantically yes**, duplicated in code |
| Two-state status, derived expiry | yes | yes | **semantically yes** |
| Revocation semantics | withdraw further issuance | withdraw further collateralization | **semantically yes** |
| External execution evidence | token/network/contract/tx refs | agreement/filing/registry/priority refs | shape yes, payload no |
| Release lifecycle | absent | required, observation-only | **no — action-specific** |
| Durable store shape (`request_ref UNIQUE`, append-only evidence, digest over terms, tenancy) | yes | yes | **semantically yes**, duplicated in code |
| Governance reference type used | `external_artifact` | `external_artifact` | see below |

### Generalization findings

Assessed against the rule that extraction requires demonstrably identical
**semantics**, must be small and localized, and must not break the frozen
`@aoc-enterprise/tokenization-mandate` contract line.

| Candidate | Verdict | Why |
|---|---|---|
| Rights/scope primitive (`GovernedRightsScope`) | **NEEDS THIRD ENFORCEMENT** | Semantics genuinely match, which is the strongest evidence so far. But extraction means a new package plus rewiring a frozen contract line's four modules, build graph and publishability surface — not the small, localized change the rule requires. Two matching cases justify recording the candidate, not spending the frozen surface. |
| Executor binding (`AuthorizedExecutor`) | **NEEDS THIRD ENFORCEMENT** | Identical semantics, but it is one `CanonicalId` field and one equality check. Extraction would cost more than the duplication it removes. |
| Mandate reference skeleton (`AuthorizationMandate`) | **NEEDS THIRD ENFORCEMENT** | The reference set and the two-state/derived-expiry rationale are identical. But a shared base interface across two frozen contract lines is a large surface commitment, and the two mandates' *terms* — the part that matters — share nothing. |
| Durable store conventions (`DurableAuthorizationStore`) | **KEEP ACTION-SPECIFIC** | The *conventions* are already shared (house style, pragmas, version guard, digest primitive, tenancy helpers). The *schemas* are not: committed scope is a JSON scope here and an integer counter there, and this store has a fourth table with a foreign key the other has no analogue for. A generic store would have to model the union of both, which is worse than either. |
| Terms/constraints (`GovernedActionTerms`) | **KEEP ACTION-SPECIFIC** | Constraints overlap in exactly one field. Unifying them would produce a bag of mutually-irrelevant optionals — the shape both contracts deliberately avoided. |
| Exhaustion/lifecycle (`MandateLifecycle`) | **KEEP ACTION-SPECIFIC** | A unit ceiling and a cumulative scope sum are different computations over different data. Only the *two-state + derive-everything-else* discipline is shared, and that is a documented convention, not code. |
| Release/discharge evidence | **KEEP ACTION-SPECIFIC** | `TOKENIZE` has no analogue at all. This is the clearest thing the second enforcement proved is genuinely not generic. |
| An Enterprise Enforcement Framework | **DO NOT BUILD** | Two examples reveal candidate primitives; they do not justify a framework. Every shared *behaviour* the two enforcements have — Kernel evaluation, Governance Store commit, authority, approvals, obligations, tenancy, evidence — is **already** generalized infrastructure that both consume unchanged. What is duplicated is vocabulary, not machinery. A framework would add a layer over infrastructure that already works. |

**Nothing was extracted in this change.** That is the finding, not an omission:
the burden of proof is on generalization, and the strongest candidates fail the
"small and localized" test against a frozen contract line rather than failing on
semantics. Each is recorded above so a third enforcement can settle it.

### Governance reference type

**Resolved.** `authorization_artifact` was introduced as a canonical
Governance Store reference type in a dedicated follow-up, exactly as
recommended below, and both mandates now use it:

```
COLLATERALIZE decision
      ↓
CollateralizationMandate         → authorization_artifact   (produced by Frontera Systems)
      ↓
external collateral execution    → execution_record         (reported by an external system)
      ↓
external release / discharge     → execution_record         (reported by an external system)
```

`external_artifact` said "some artifact outside Soberanía" about a record Soberanía itself
produced and owns; `authorization_artifact` says what the record actually is —
a durable artifact recording authorization resulting from enforcement. The
external collateral arrangement and its release are observations about someone
else's actions and remain `execution_record`s; neither is ever reclassified as
authorization.

The compatibility concern that deferred it was resolved rather than accepted.
`referenceType` is persisted as free `TEXT` with no `CHECK`, and both
schema-version guards are indifferent to the vocabulary, so the stored contract
turned out to be forward-compatible for an added value: **no schema migration
and no version bump were required**, and an older runtime reading the new value
accepts it verbatim rather than failing. What the change did add is a
*write-path* guard, so an unknown string can no longer be stored and cast back
out as though it were a recognized classification. Mandates recorded before the
type existed keep their historical `external_artifact` classification and are
not rewritten. The full compatibility argument, with its evidence, lives in
"Reference vocabulary" in `AOC_ENTERPRISE_GOVERNANCE_STORE.md`.

The original recommendation, kept for the record:

> **Recommendation: introduce `authorization_artifact` as a dedicated follow-up
> to the Governance Store**, covering the union member, the schema-version
> handling for existing reference rows, and the migration of both actions'
> emitted values together. The evidence for it is now sufficient; the safe
> sequencing is not to bundle it here.

## Protocol boundary

No Soberanía Protocol changes were required, and none are recommended.

> **Does Protocol need to know that an asset has been collateralized, or is
> that entirely Enterprise governance state?**

On the evidence of this implementation: **entirely Enterprise governance
state.**

Enterprise maintains the complete collateralization authority and evidence
lineage — asset, authority, request, policy, approvals, decision, obligations,
mandate, external execution, release — without Protocol participating in any
of it. Protocol supplied exactly one thing: `ResourceRef`, the identity of the
governed asset. Nothing in the lifecycle needed a Protocol-level notion of
encumbrance.

`COLLATERALIZE` does suggest a candidate Protocol concept —
*encumbrance / governed-interest lineage* — in the same way `TOKENIZE`
suggested *derived-representation lineage*, and it is fair to say the second
enforcement strengthens the general case for a Protocol relationship primitive
that both could be expressed in. But it strengthens it only in the abstract:
neither action produced a **cross-sovereignty** requirement, which is the
threshold a Protocol primitive has to clear. Both lineages are answerable
inside one sovereign's Enterprise state.

A genuine cross-sovereignty requirement would look like: sovereign A must
verify, without trusting sovereign B's Enterprise deployment, that an asset
under B's governance carries an encumbrance. Nothing in either enforcement
needs that yet. Implementing a Protocol encumbrance primitive now would be
speculative.

## Deferred work

Explicitly out of scope, and not implied by anything above: actual collateral
execution integrations and provider adapters; lending systems, loan
origination or servicing; interest, LTV or margin computation; asset
valuation or pricing; liquidation, foreclosure or seizure; registry filing and
legal perfection; priority determination; jurisdiction-specific policy;
DeFi, smart contracts, wallets or blockchain execution; a `RELEASE_COLLATERAL`
governed action; an HTTP endpoint for this action; publication of the module on
`@aoc-enterprise/runtime`'s public surface; and the `authorization_artifact`
governance reference type discussed above.

## Update — the fourth enforcement

`TRANSFER` (`docs/enterprise/AOC_TRANSFER_ACTION.md`) has since landed, and it
is the second action whose quantity is *consumed* rather than merely bounded.
Cumulative scope containment — introduced here, and absent from `TOKENIZE` and
`LICENSE` — is therefore confirmed as a genuine domain property of actions that
exhaust a finite right, rather than a collateral-specific invention. The reasons
differ and both are recorded: collateral scope accumulates because encumbering a
finite right twice exhausts it; transferred scope accumulates because the right
*left*, and what has left cannot leave again.

`COLLATERALIZE` now consumes the shared, action-neutral vocabulary in
`@aoc-enterprise/governed-authorization` (the governed-right categories, the
rights-scope value type, the authorization-artifact skeleton and the evidence
envelopes) via aliases and interface extension. No serialized byte, stored
record, consumer, validator or error code changed. `releasedAt` / `releaseType`
were deliberately **not** renamed to match the `occurredAt` / `lifecycleType`
spelling `LICENSE` and `TRANSFER` share — the audit records that divergence as
naming rather than meaning, and does not rename a frozen field to tidy it. See
`docs/architecture/ADR-ENTERPRISE-ENFORCEMENT-VOCABULARY.md`.

## Update — governed release exists, and `recordRelease` is unchanged

The prediction in "Release and discharge evidence" above has come true exactly
as it was written:

> If releasing collateral ever needs to be *authorized* by Soberanía rather than
> merely *observed*, that is a separate governed action with its own request,
> decision and mandate.

That action now exists. It is **`RELEASE_ENCUMBRANCE`** (capability
`release-encumbrance`), and — note the name — it does not govern collateral. It
governs the `GovernedAuthorityEncumbrance` a completed collateralization leaves
behind: the persistent constraint on the holder's authority, not the external
arrangement itself. Soberanía still releases nothing in the world, and still asserts
nothing about whether an external encumbrance ended.

**Nothing in this document changes.** `recordRelease` remains exactly what it is
described as above — an unverified external observation, not a governed action,
not a mandate status, and not a restoration of headroom. It is classified
`OBSERVATION_ONLY`, it was deliberately **not** migrated into the governed
lifecycle, and it still cannot free authority capacity. Turning an observational
API into an authoritative one silently would have been strictly worse than
leaving the gap open.

What a deployment does when it wants a reported release to *matter* is submit a
`RELEASE_ENCUMBRANCE` request, citing the observation as evidence on it, where a
decision can weigh it. The persistent constraint then ends only if that request
is authorized, a release mandate is issued, and a trusted executor confirms the
release — never because the report exists.

Two things this deliberately does **not** change here:

- **`securedPartyRef` is still "who benefits".** Being the secured party confers
  no authority to release the constraint. Release authority is explicit,
  recognized Action Authority over the resource, and a deployment that wants the
  secured party to hold it grants it in the Authority Graph like any other.
- **The committed-scope rule is untouched.** `committedScope` is still
  mandate-local bookkeeping and still never decremented by a report. The
  canonical cross-mandate constraint is the `GovernedAuthorityEncumbrance`, and
  that is what a governed release terminalizes.

See `docs/enterprise/AOC_GOVERNED_ENCUMBRANCE_RELEASE.md` and
`docs/architecture/ADR-GOVERNED-ENCUMBRANCE-RELEASE.md`.

## Update — constraint applicability

`COLLATERALIZE` is the only current governed action that both **produces** and
**consumes** a persistent constraint class, which is exactly what makes that
capacity finite.

```
reservation behaviour            required
produces persistent constraint   collateral-commitment-capacity
consumes constraint class        collateral-commitment-capacity
structural effect                none (executing it debits no position)
policy visibility                full
release relationship             none — an arrangement's own mandate can never
                                 discharge the constraint it created
```

The class is **derived** from the constraint's `sourceAction` rather than stored,
so nothing about the records this action writes changed: no field, no digest, no
migration.

Standing constraints of the matching class reduce the capacity a further
`COLLATERALIZE` may commit, and the reduction is a hard conservation invariant
rather than a policy: with 5 000 bp held and 4 000 bp constrained, a further
4 000 is refused and 1 000 is not, and no deployment policy can buy the
difference. See `AOC_GOVERNED_CONSTRAINT_APPLICABILITY.md`.
