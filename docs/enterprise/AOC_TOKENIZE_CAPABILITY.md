# The `TOKENIZE` Governed Action

- Contracts: `@aoc-enterprise/tokenization-mandate`
- Runtime: `src/enterprise/tokenization-governance/`
- Decision records: `docs/architecture/ADR-TOKENIZE-CAPABILITY.md`,
  `docs/architecture/ADR-TOKENIZATION-MANDATE-PERSISTENCE.md`
- Sibling action: `docs/enterprise/AOC_COLLATERALIZE_ACTION.md` — Soberanía
  Enterprise's second governed action. Its documentation carries the
  `TOKENIZE` vs `COLLATERALIZE` comparison matrix and the resulting
  generalization findings.

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

Applied here:

```
TOKENIZE                 = a Governed Action.

Tokenization Enforcement = Frontera Systems evaluates whether TOKENIZE may be
                           exercised, by whom, over which rights, in what
                           scope, and under which conditions.

TokenizationMandate      = the durable authorization artifact produced by a
                           successful enforcement.
```

`TOKENIZE` is no longer the only one. Frontera Systems now governs two actions,
and the same asset may be the subject of both, independently:

```
COLLATERALIZE            = a Governed Action.
CollateralizationMandate = the durable authorization artifact produced by a
                           successful COLLATERALIZE enforcement.
```

A Protocol Sovereignty Capability is not an Enterprise Governed Action. The
Protocol establishes what authority exists and anchors its evidence;
Enterprise governs the *exercise* of that authority.

**A note on the field name.** The technical field carrying the action's
identifier is still called `capability` — `ActionDescriptor.capability`,
`AuthorityGrant.capability`, `RecognitionCapabilityToken.capability`, and
`EnterpriseTokenizationRequest.capability`. That is the repository's existing
contract surface and is deliberately left alone: this terminology is a
documentation model, not a rename. Read `capability: 'tokenize'` in code as
"the identifier of the Governed Action `TOKENIZE`".

## Definition

`TOKENIZE` is a governed action of Frontera Systems.

> **TOKENIZE** — exercising authorized control over specified rights
> associated with an already-governed asset, in order to create an external
> tokenized representation of those rights.

It is evaluated by the same primitives every other governed action is
evaluated by. It introduces no second policy engine, no second evidence
system, no second authorization system, and no action-specific API.

## Boundary

```
Soberanía Protocol
    │  establishes / anchors: asset identity, authority, attestations,
    │  evidence, sovereignty boundary
    ▼
Frontera Systems
    │  governs exercise of authority: request, policy, decision,
    │  obligations, approvals, grant, use, revocation, evidence
    ▼
External Tokenization System
       performs issuance
```

**Frontera Systems authorizes tokenization. Frontera Systems is not the
tokenization provider.**

It does not mint, issue, transfer, burn, price, custody, or list tokens. It
holds no keys, speaks to no chain, and assumes no token standard. What an
external system does with a mandate is that system's act; Soberanía records the
authorization and the evidence of the exercise.

## `PROTOCOLIZATION != TOKENIZATION`

```
Protocolization  — establishes a governed/canonical asset representation
                   and its authority/evidence context.

Tokenization     — an optional governed action performed on rights of an
                   already-governed asset.
```

Protocolization can exist without tokenization. Tokenization always
presupposes an already-identified governed asset or right. The two are never
synonyms, and `TOKENIZE` is likewise distinct from `REGISTER`, `TRANSFER`,
`LICENSE`, `DELEGATE`, `COLLATERALIZE` and `COMMERCIALIZE` — recorded as data
in `ENTERPRISE_CAPABILITIES_DISTINCT_FROM_TOKENIZE` and enforced by
`validateEnterpriseTokenizationRequest`, which rejects any request whose
`capability` is not exactly `'tokenize'`.

## Lifecycle

```
Governed asset
      ↓
TOKENIZE request                     EnterpriseTokenizationRequest (validated)
      ↓
authority evaluation                 Authority Graph, via Recognition Runtime
      ↓
policy evaluation                    Action Enforcement chain + Domain Policy Pack
      ↓
required approvals                   Approval Runtime (quorum, SoD, delegation)
      ↓
obligations                          EnterpriseAccessObligation references
      ↓
decision                             AocKernel.evaluate() → KernelEvaluationResult
      ↓
durable proof                        Governance Store aggregate (atomic, integrity-chained)
      ↓
grant / deny                         mandate issued only for `allowed`
      ↓
Tokenization Mandate                 EnterpriseTokenizationMandate
      ↓
durable persistence                  TokenizationMandateStore (SQLite)
      ↓
process restart                      mandate, revocation, and issuance totals recovered
      ↓
external execution                   an external system, outside Soberanía
      ↓
execution evidence                   EnterpriseTokenizationExecutionEvidence
      ↓
audit trail                          Governance Store references + append-only executions
```

Every box above is an existing Soberanía primitive except the three contract
artifacts, which are this action's own.

## Durability

A mandate does not disappear because the Enterprise process restarts.

`TokenizationMandateStore` has two implementations behind one unchanged port,
mirroring every other Enterprise entity store:

| Provider | Factory | Use |
|---|---|---|
| `memory` | `createInMemoryTokenizationMandateStore()` | tests, development, `AOC_ENTERPRISE_PERSISTENCE_PROVIDER=memory` |
| `sqlite` | `createSqliteTokenizationMandateStore(dbPath)` | durable deployments |

The SQLite store follows the same house style as the Governance, Passport,
Assurance and Access Grant stores: its own database file, `WAL` +
`synchronous=FULL` + `foreign_keys=ON`, a schema-version guard that **refuses
to open** a database written under a different version (before any DDL runs,
so a refused store is never mutated), synchronous transactions for
multi-statement writes, and typed domain errors instead of raw driver errors.

### Schema `aoc.tokenization-mandate-store.schema.v1`

| Table | Purpose |
|---|---|
| `tokenization_mandate_store_versions` | schema-version guard row |
| `tokenization_mandates` | current-state mandate row |
| `tokenization_executions` | **append-only** external execution evidence |
| `tokenization_mandate_revocations` | at-most-one revocation per mandate |

The invariants that matter are database constraints, not application
bookkeeping, so they hold against a writer this process never sees:
`request_ref UNIQUE` (one request authorizes at most one mandate),
`execution_id PRIMARY KEY` (one execution recorded at most once),
`mandate_id UNIQUE` on revocations, and `(mandate_id, sequence) UNIQUE` for a
restart-stable evidence order.

### Stored vs derived, after persistence

Persistence did not become an excuse to store a second source of truth.
Stored: `status` (`'active' | 'revoked'`), `issuedUnits`, `executionCount`,
timestamps. Still derived on every read: **expired**, **exhausted**,
**superseded** — computed by `enterpriseTokenizationMandateAuthorizes` from
the fields that already record the underlying facts. A recovered mandate past
its `expiresAt` still carries `status: 'active'` and is still refused.

### Integrity and corruption

`terms` — the rights, scope, executor and constraints — is stored as its
canonical serialization alongside `terms_digest`, the repository's own
canonical SHA-256-over-`aoc.canonical-json.v1` digest. Every read recomputes
and compares, because that column is exactly what a scope escalation would
have to alter.

A corrupted or malformed record fails closed with
`TOKENIZATION_RECORD_CORRUPTED` and **never** becomes a valid authorization —
whether the digest mismatches, the JSON is unreadable, the status is
unrecognized, or the row does not reconstruct into a valid
`EnterpriseTokenizationMandate` under the frozen contract's own validator.
This is integrity detection, not a signature: the limits documented for the
Governance Store's digests apply here too.

## Domain semantics

### Request

A `TOKENIZE` request can never say merely "tokenize asset X". It must express:

| Concept | Field |
|---|---|
| Governed subject | `asset: ResourceRef` (identity only) |
| Requested rights | `terms.rights` — closed vocabulary |
| Scope | `terms.scope` — proportional (basis points) or unitized |
| Authorized executor | `terms.executorRef` |
| Issuance constraints | `terms.constraints` |
| Requester | `requestedBy` (+ `principalActorId` when acting on behalf) |

### Scope

```ts
{ kind: 'proportional', basisPoints: 2000 }                            // 20%
{ kind: 'unitized', units: 500, unitDenomination: 'entitlement-unit' } // 500 units
```

Integer basis points, never floating point — `0.1 + 0.2 !== 0.3`, and an
economically significant share must compare and sum exactly. Proportional and
unitized scopes are never comparable to one another, and unitized scopes must
agree on denomination.

**Partial tokenization is the normal case.** `TOKENIZE(asset)` is not
tokenization of the entire asset: authorizing 20% of defined economic
participation rights leaves the remaining 80% unrepresented by that
authorization, and the mandate says so explicitly.

### Authority

Soberanía never infers ownership or authority from the fact that somebody asked. A
`TOKENIZE` request is evaluated against the existing authority model, so
policy can require that the requester holds `TOKENIZE` authority, or was
delegated it, and/or that sovereign/owner approvals are satisfied — expressed
through `AuthorityGrant` / `DelegationGrant` / `RecognitionCapabilityToken`,
not through anything this capability invented.

Where authority is absent or insufficient, the request is **denied** by the
canonical decision path, and no mandate exists.

### Approvals

Approval semantics come from the Approval Runtime's existing quorum,
segregation-of-duties, approver-authority and delegation policies. Nothing
here hard-codes "all owners must approve": single-owner, multi-owner,
corporate-authority, delegated-executor and partial-rights topologies are all
expressible, and which one applies is the policy layer's determination.

A `approval_required` outcome produces **no mandate**. An outstanding
approval is not authorization.

### Obligations

Obligations attach to the decision through the existing generalized
obligation system (`EnterpriseAccessObligation`), referenced from the mandate
by `obligationRefs`. Examples a deployment may express — none of them
hard-coded here as universal rules, and none of them a legal conclusion:

```
only X% may be represented                      (terms.scope)
maximum token supply = N                        (constraints.maximumIssuedUnits)
only provider Y may execute                     (terms.executorRef)
only network Z may be used                      (constraints.permittedNetworks)
no additional issuance                          (constraints.additionalIssuanceAllowed: false)
transfer restrictions must be enforced          (constraints.transferRestricted)
tokens represent economic rights only           (terms.rights)
KYC/AML must be performed externally            (obligation record)
issuance evidence must be returned to Soberanía (obligation record)
authorization expires at T                      (mandate.expiresAt)
```

Constraint labels (`permittedNetworks`, `permittedTokenStandards`,
`permittedJurisdictions`) are opaque strings Soberanía stores and compares. Soberanía
does not resolve them, validate them against any real system, or enforce
them anywhere outside itself.

### Mandate

`EnterpriseTokenizationMandate` is the durable, machine-readable artifact.
From one mandate a reviewer can determine: which asset and rights are
covered, the permitted scope, who requested it, who authorized it (via
`decisionRef`), who may execute it, the applicable constraints, the required
obligations (`obligationRefs`), effective time, expiry, revocation status,
approval references, evidence references, and the Governance Store aggregate
that proves the decision (`evaluationRef`).

Everything except the terms is a reference to a canonical Soberanía record. The
terms are carried directly because a mandate must be auditable without
dereferencing the request.

### Revocation and expiration

Stored status is `'active' | 'revoked'` only. Expiry and exhaustion are
derived, purely, from `effectiveFrom`/`expiresAt` and from recorded execution
evidence measured against the constraints — never stored as a second source
of truth that could disagree.

The distinction that matters:

```
revocation of authority to perform additional issuance   ← what Soberanía can do
external treatment of already-issued tokens              ← not Soberanía's to claim
```

Revoking a mandate blocks new external issuance from that moment. It does not
destroy, freeze, or invalidate tokens an external system already issued, and
Soberanía does not pretend otherwise. Execution evidence recorded before revocation
is preserved immutably, and the revocation record itself preserves the
execution count at the moment authority was withdrawn.

### Evidence

The complete chain is auditable through existing mechanisms only:

```
asset → authority → request → policy evaluation → approvals → decision
      → obligations → mandate → external execution evidence
```

`getEvidenceLineage()` assembles it from references already stored. The
mandate and each execution record are linked back to their governance
aggregate through the Governance Store's own `appendReference` surface —
there is no tokenization-specific audit log.

#### Evidence classification

The two sides of that chain are classified differently, and keeping them
apart is the point:

```
TOKENIZE decision
      ↓
TokenizationMandate          → authorization_artifact   (produced by Frontera Systems)
      ↓
external token execution     → execution_record         (reported by an external system)
```

The `TokenizationMandate` is recorded as a `GovernanceReferenceRecord` with
`referenceType: 'authorization_artifact'` — the Governance Store type for a
durable artifact Frontera Systems itself produced to record an authorization
resulting from enforcement. External token issuance is a report about
someone else's action and stays an `execution_record`; it is never
reclassified as authorization.

This preserves the conceptual hierarchy — Frontera Systems → Governed Actions →
Enforcements → Grants / Mandates — in the evidence record itself. The
classification is evidence vocabulary only: it confers no authority, and a
reference appended by hand grants nothing. See "Reference vocabulary" in
`AOC_ENTERPRISE_GOVERNANCE_STORE.md` for the trust boundary and for how
mandates recorded before this type existed (as `external_artifact`) are
treated.

A reviewer can answer, from the canonical records alone: *why was this
permitted, what exactly was permitted, who had the authority to permit it,
and was the external execution consistent with the authorization?*

## API

`TOKENIZE` uses the generalized capability-request interface. No
`/api/tokenize` endpoint exists or is needed:

```jsonc
POST /api/governance/evaluate
{
  "actor":  { "id": "actor-asset-steward", "trustDomainId": "trust-domain-aurelia" },
  "action": {
    "type": "tokenize",
    "capability": "tokenize",
    "resourceScope": "asset:building-a",
    "sideEffectType": "external_api_call",
    "riskLevel": "critical",
    "parameters": { /* serialized EnterpriseTokenizationRequest */ }
  },
  "organization": { "id": "org-aurelia-holdings" }
}
```

The response is the ordinary governance response — `allowed`,
`approval_required`, `denied`, or `indeterminate`, with the Kernel's own
reason codes and the committed `governanceRecord`.

`createTokenizationGovernanceService()` is the in-process orchestration that
performs this evaluation *and* issues the mandate on an allowed decision. It
is the path an embedding host uses; it does not replace or bypass the HTTP
surface.

## Security invariants

Each is covered by a test in `src/enterprise/__tests__/tokenization-governance.test.ts`,
and each is re-proved against the durable backend across a real store
close/reopen in `tokenization-durability.test.ts`:

| Invariant | Mechanism |
|---|---|
| One tenant cannot tokenize another tenant's asset | `TOKENIZATION_ASSET_TENANT_MISMATCH`, checked before the Kernel is consulted |
| One tenant cannot read/revoke another tenant's mandate | `TOKENIZATION_ACCESS_SCOPE_VIOLATION` on every store read and write |
| A non-system caller must name its organization | `TOKENIZATION_TENANT_SCOPE_REQUIRED` |
| An unauthorized actor cannot grant itself `TOKENIZE` | the Kernel denies; no mandate is created, however many times it asks |
| Request creation ≠ approval | `approval_required` yields no mandate |
| Mandate creation cannot bypass the decision path | `decisionRef` is required by the canonical contract; the service issues only after `appendEvaluation` commits |
| Expired/revoked authority cannot authorize new issuance | derived by `enterpriseTokenizationMandateAuthorizes` |
| Partial scope cannot silently become full scope | terms copied verbatim; `assertNoScopeEscalation` re-asserted at the store boundary |
| Executor restrictions are enforced | `EXECUTOR_NOT_AUTHORIZED` |
| Replaying a request cannot accumulate authorization | an idempotent replay returns the original mandate; the store refuses a second mandate for a `requestRef` it already issued against |
| Reusing one request id for a different request is refused | `TOKENIZATION_REQUEST_CONFLICT` (the Governance Store's own idempotency conflict, surfaced distinctly from an infrastructure failure) |
| Replaying an execution cannot create additional issuance authorization | `TOKENIZATION_EXECUTION_ALREADY_RECORDED`; counters never double-advance |
| An unreadable exercise instant cannot authorize | `INVALID_EXERCISE_INSTANT` — refused rather than compared against `NaN` |
| Evidence is append-only | no update/delete path for execution records; Governance Store is append-only by construction |
| A corrupted durable record cannot become an authorization | `TOKENIZATION_RECORD_CORRUPTED` — fail closed on digest mismatch, unreadable JSON, unrecognized status, or a row that does not reconstruct into a valid canonical mandate |
| A database from another schema version cannot be silently reused | the store refuses to open it, before any DDL runs |

## Reference scenario

A governed asset represents a building. Its authority is held by a steward
recognized in the asset's trust domain. The steward authorizes tokenization
of **20% of specified economic participation rights** — not the asset, and
not all of its rights.

Soberanía evaluates authority and policy; the decision is `allowed`; the evaluation
is committed to the Governance Store; a mandate is issued permitting exactly
one named executor to issue at most N external units representing only those
rights, on a named network, under a named standard, with transfer
restrictions declared, prohibiting additional issuance, expiring at a defined
time.

The executor later performs issuance externally. The returned execution
evidence is recorded and correlated back to the mandate, and therefore to the
decision, approvals, obligations, authority and asset.

A delegated tokenization desk making the same request instead receives
`approval_required` — its capability token requires the steward's approval —
and no mandate is created until that approval is satisfied.

The Enterprise then restarts. The mandate is recovered from disk, still
authorizing exactly 20% of exactly those rights through exactly that
executor; the external execution evidence recorded afterwards is correlated
back through the recovered mandate to the original decision; and a second
issuance is still refused because the mandate prohibited it. This runs as an
executable test — `TOKENIZE reference scenario` in
`src/enterprise/__tests__/tokenization-durability.test.ts` — across three
separate store instances over the same database files, with no blockchain
anywhere in it.

The model is deliberately asset-agnostic: real estate, art, financial and
contractual rights, physical goods, intellectual property, and digital-native
assets are all expressible, wherever the governing model permits.

## Deferred work

Explicitly outside this capability, and deliberately not implied by it:

- blockchain execution adapters and any provider-specific integration
- actual minting, issuance, transfer, or burn
- token standards (no ERC-20/721/1400/3643 assumption anywhere)
- custody, wallets, key management, marketplaces, exchanges, valuation
- KYC/AML, investor onboarding, transfer-agent or securities logic
- a barrel export from `src/enterprise/index.ts` (blocked by the same
  publishability constraint documented there for Access Governance)
- a `tokenization.sqlitePath` entry in `EnterpriseConfiguration` — the
  factory takes an explicit `dbPath`, exactly as `createSqliteAccessGrantStore`
  does, because neither module is wired into the composition root. When
  Access Governance earns a config entry, this module should follow in the
  same change.
- Protocol changes: none were required

## Update — the fourth enforcement

With `LICENSE` and `TRANSFER` (`docs/enterprise/AOC_TRANSFER_ACTION.md`) now
implemented, the four-enforcement audit settled two questions this action was
the first to raise:

- **Required executor is not universal.** `TOKENIZE` binds one because minting
  is an act someone must perform externally. `LICENSE` and `TRANSFER` make it
  optional, so the binding is a property of *acts that require a performer*
  rather than of governed actions generally.
- **`TOKENIZE` is the only one of four with no lifecycle evidence**, and the
  reason is now explicable rather than merely observed: minting produces a
  token whose own subsequent life — burned, moved, split — would be a governed
  act *over the token*, not a report about the minting. The other three each
  leave a standing external arrangement that the same arrangement can later be
  reported to have exited.

`TOKENIZE` now consumes the shared, action-neutral vocabulary in
`@aoc-enterprise/governed-authorization` (the governed-right categories, the
rights-scope value type, the authorization-artifact skeleton and the execution
evidence envelope) via aliases and interface extension. No serialized byte,
stored record, consumer, validator or error code changed. See
`docs/architecture/ADR-ENTERPRISE-ENFORCEMENT-VOCABULARY.md`.

## Update — constraint applicability

`TOKENIZE` has **no generic relationship to persistent authority constraints**,
and that is a measured finding rather than an oversight.

```
reservation behaviour            none — it never calls the authority store
produces persistent constraint   none
consumes constraint class        none
structural effect                none
policy visibility                full
release relationship             none
```

With a holder at 5 000 bp and a 4 000 bp collateral constraint standing, a
`TOKENIZE` of the whole 5 000 proceeds as far as this layer is concerned. Soberanía has
been given no evidence that tokenizing collateralized authority is a conflict and
declines to invent one — an invented default would be one deployment's commercial
assumption imposed on every deployment.

A deployment that believes the combination is unacceptable expresses it as
policy. The constraint is reported to policy with an empty `applicability`,
meaning "this stands over the authority you are being asked about, and Soberanía has no
rule about it" — which is exactly what such a rule needs. See
`AOC_GOVERNED_CONSTRAINT_APPLICABILITY.md`.

Whether independent issuances should compete for one pool remains a
tokenization-domain question, still unanswered, and answering it would mean
introducing a constraint class for issuance capacity rather than reusing
collateral's.
