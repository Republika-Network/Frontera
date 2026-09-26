# The `LICENSE` Governed Action

- Contracts: `@aoc-enterprise/license-mandate`
- Runtime: `src/enterprise/license-governance/`
- Decision record: `docs/architecture/ADR-LICENSE-ACTION.md`
- Three-enforcement audit: `docs/architecture/ADR-ENTERPRISE-ENFORCEMENT-VOCABULARY.md`
- Sibling actions: `docs/enterprise/AOC_TOKENIZE_CAPABILITY.md`, `docs/enterprise/AOC_COLLATERALIZE_ACTION.md`

## Architectural terminology

Two layers, two vocabularies. They are not synonyms and must not be conflated:

```
Soberanía Protocol
  → Sovereignty Capabilities     what a sovereign holds

Frontera Systems
  → Governed Actions             what may be exercised
  → Enforcements                 the evaluation of whether it may be
  → Grants / Mandates            the durable authorization that results
  → Evidence                     what an external system reported afterwards
```

Frontera Systems now has **three** governed actions:

```
TOKENIZE                = a Governed Action.
COLLATERALIZE           = a Governed Action.
LICENSE                 = a Governed Action.

License Enforcement     = Frontera Systems evaluates whether, and on what
                          terms, LICENSE may be exercised.

LicenseMandate          = the durable, Soberanía-owned authorization artifact a
                          successful LICENSE enforcement produced.
```

**`LICENSE` is not a Protocol Sovereignty Capability.** It is not a ninth
capability, and nothing in this action belongs to the Protocol layer. The
Protocol establishes what authority exists and anchors its evidence;
Enterprise governs the *exercise* of that authority.

**A note on the field name.** The technical field carrying an action's
identifier is still called `capability` — `ActionDescriptor.capability`,
`AuthorityGrant.capability`, `RecognitionCapabilityToken.capability`,
`EnterpriseLicenseRequest.capability`. That is the repository's existing
contract surface and is deliberately left alone: this terminology is a
documentation model, not a rename. Read `capability: 'license'` in code as
"the identifier of the Governed Action `LICENSE`".

The contract type is named `EnterpriseLicenseMandate` rather than
`LicenseMandate` because every canonical contract in this line carries the
`Enterprise` prefix (`EnterpriseAccessGrant`, `EnterpriseTokenizationMandate`,
`EnterpriseCollateralizationMandate`). Conceptually it *is* the LicenseMandate.

## Definition

> `LICENSE` means: authorizing the grant of a defined permission to a defined
> licensee to exercise specified governed rights associated with an
> already-governed asset, for specified uses, within a specified operating
> context, under defined governance conditions.

Frontera Systems governs whether licensing is authorized, who may grant it, to
whom, over which governed rights, within which scope, for what permitted uses,
and under which conditions.

## Boundary — authorization is not legal validity

Frontera Systems is able to say exactly one kind of thing:

> This authority graph, policy state, approval state and obligation set
> permitted Actor A to grant License L to Licensee B under Terms T.

It does **not** say, and no field in these contracts should be read as saying:

- that the license is legally enforceable in any jurisdiction;
- that the agreement satisfies any local formality;
- that consideration was paid, or that any royalty, fee or tax was settled;
- that copyright subsists, that a patent is valid, or that a trademark is
  registered;
- that the underlying right is legally licensable or transferable;
- that any external contract was signed or accepted.

Those are facts about the world. Soberanía knows them only if some external system
independently evidences them — which is what
`EnterpriseLicenseExecutionEvidence` exists to record, and even then Soberanía has
preserved a report, not verified a fact.

**Governance authorization != universal legal validity.**

Nothing in this action drafts a contract, captures a signature, computes or
settles a royalty, charges money, prices or values anything, calculates tax,
meters usage, enforces DRM, operates a marketplace, or maintains a rights
registry. There is no provider adapter for licensing and none is implied.

## Three distinctions that carry weight

- **`LICENSE != TRANSFER`.** A license permits *use* of rights; it does not
  move, assign, or reassign ownership. Nothing in this action transfers a
  right, and licensing an `ownership-interest` records that the permission
  draws on that interest, never that it changed hands.
- **`LICENSE != TOKENIZE`.** Tokenization authorizes an external tokenized
  *representation* of rights; licensing authorizes *permission to exercise*
  them.
- **`LICENSE != COLLATERALIZE`.** Collateralization commits rights as
  *security* for an obligation; licensing commits nothing and secures nothing.
  A licensed right is not an encumbered right.

`LICENSE != PROTOCOLIZE` and `LICENSE != ACCESS` hold for the same reasons
they hold for the sibling actions: protocolization establishes the governed
identity/authority/evidence context that licensing presupposes, and access
concerns reaching a resource rather than being permitted to exercise rights in
it.

## Lifecycle

```
Governed Asset
      ↓
LICENSE request                       (EnterpriseLicenseRequest)
      ↓
canonical validation
      ↓
AocKernel.evaluate()                  authority · policy · approvals · obligations
      ↓
decision persisted                    Governance Store aggregate
      ↓            (allowed only)
LicenseMandate issued                 (EnterpriseLicenseMandate)
      ↓
mandate persisted                     LicenseMandate Store
      ↓
authorization_artifact appended       Governance Store reference
      ↓
reference integrity sealed            store-computed, not caller-supplied
      ↓
external licensing execution          someone else's system
      ↓
execution_record appended             (EnterpriseLicenseExecutionEvidence)
      ↓
reference integrity sealed
      ↓
external expiry / termination         (EnterpriseLicenseLifecycleEvidence)
      ↓
execution_record appended
```

**The mandate issuance invariant.** No mandate may exist before the canonical
governance decision that produced it has been durably committed. The service
appends the evaluation aggregate first, returns without a mandate for anything
that is not `allowed`, and only then issues. `approval_required` is explicitly
not authorization. A manually inserted `authorization_artifact` reference
grants nothing — see "Integrity is not authority" below.

## Domain semantics

### Governed rights

`EnterpriseLicensableRightType` — `economic-interest`, `revenue-right`,
`ownership-interest`, `usage-right`, `contractual-claim`. The value set
coincides exactly with the `TOKENIZE` and `COLLATERALIZE` vocabularies, and
that is a *finding* rather than a convenience: the vocabulary names which
governed right of the asset an action concerns, which is a property of the
asset's rights and not of the action applied to them.

### Rights scope is not permission scope

This is the most important structural point of the action, and the question
the third enforcement existed to answer.

A license has **two independent kinds of scope**:

```
rights scope        25% of a divisible revenue right
                    → EnterpriseLicenseTerms.rightsScope        (OPTIONAL)

permission scope    display only · web channel only · Territory A only
                    · 12 months · non-exclusive · 10 seats
                    → permittedUses · permittedContexts · exclusivity
                      · maximumLicenseTermEndsAt · maximumLicensedUnits
```

`TOKENIZE` and `COLLATERALIZE` both *require* a scope, because representing or
encumbering a right is inherently a question of how much of it. A permission is
not: *"Company B may display this work on its website for 12 months"* is a
completely specified license with no fraction anywhere in it.

`rightsScope` is therefore **optional**, and its absence means **"this
authorization is not expressed as a portion of the named rights"** —
emphatically *not* "100%". The two are incommensurable and every comparison
fails closed rather than coercing one into the other:

| mandate | execution | result |
| --- | --- | --- |
| absent | absent | contained |
| present | absent | refused — cannot show containment |
| absent | present | refused — Soberanía never authorized a portion |
| present | present | compared, same kind and denomination only |

When a license *is* fractionally expressed, the same integer basis-point
containment the sibling actions use applies unchanged: 2500 bp authorized
refuses 10000 bp, before and after a restart. No floating-point arithmetic is
used for economically significant fractional rights anywhere.

### Permitted and prohibited uses

`EnterpriseLicensedUseType` — `display`, `reproduce`, `distribute`,
`broadcast`, `modify`, `derivative-work`, `internal-use`, `commercial-use`,
`model-training`. A closed, provider-neutral, asset-neutral union. These are
**Soberanía's own governed-use categories**: they are not statutory definitions, they
do not track any jurisdiction's exclusive-rights enumeration, and Soberanía asserts
no legal meaning for them.

`constraints.prohibitedUses` is not redundant with the `permittedUses`
allow-list. An allow-list cannot express a carve-out *inside* a broad grant —
"commercial use, but never model training". A use may never appear in both
lists; an authorization that simultaneously permits and forbids the same use is
rejected at validation as unrepresentable (`CONTRADICTORY_USES`).

Behavioural requirements — attribution, reporting, returning evidence, payment
evidence — are **obligations**, produced by the Kernel through the existing
obligation machinery, not terms. Terms carry what the license *is*; obligations
carry what someone must *do*.

### Operating context

`constraints.permittedContexts` maps an opaque **dimension** label to an opaque
allow-list of values:

```ts
{ territory: ['territory-a'], channel: ['channel-web'] }
{ environment: ['production'] }
{ platform: ['platform-x'], market: ['market-eu'] }
```

Territory is deliberately **not** the root concept. For software the operating
context may be an environment; for content a channel or platform; for data a
market. Hard-coding geography would make every non-geographic license
misrepresent itself.

Containment is read dimension by dimension, as a set: a dimension the mandate
does not restrict places no limit; a dimension it does restrict must be present
in the execution and every value must be allowed. `Territory A` therefore
refuses `Territory A + Territory B`, and an omitted restricted dimension is
refused rather than assumed empty.

### Duration — four distinct instants

```
mandate.effectiveFrom            Soberanía's authority to grant begins
mandate.expiresAt                Soberanía's authority to grant ends
execution.licenseEffectiveAt     the external license itself begins
execution.licenseExpiresAt       the external license itself ends
constraints.maximumLicenseTermEndsAt
                                 the latest the external license may run to
```

These are **not** the same thing and are never conflated. A `LicenseMandate`
expiring does not terminate an external license already granted under it; it
ends Soberanía's authority to grant further ones.

### Exclusivity

A three-level rank — `non-exclusive` < `sole` < `exclusive` — rather than a
boolean, because `sole` (the licensor grants to no one else but reserves the
right for itself) is a real arrangement that neither `true` nor `false` can
express. A granted license may be at most as exclusive as was authorized.

**It never follows from this contract that an asset may carry only one
license, or that an exclusive license blocks any other license.** Many
non-exclusive licenses may coexist. Whether a prior exclusive grant should
block a new request is a *policy* question: the full serialized terms travel to
the Kernel as `action.parameters`, so a deployment's policy can inspect prior
mandates and evidence and deny an incompatible request. Soberanía hard-codes no such
rule and invents no universal law.

### Sublicensing and assignment

`constraints.sublicensing` and `constraints.assignment` are required
three-value dispositions — `prohibited` | `approval-required` | `permitted` —
because silence about whether a licensee may sublicense or assign is precisely
the ambiguity a governed authorization exists to remove.

Soberanía records the disposition; it does not run the further approval. No
`SUBLICENSE` or `ASSIGN_LICENSE` governed action is introduced.

`assignment` additionally carries the **only** condition under which a license
may be executed for a party other than the named licensee. The default is
identity binding: an execution naming a different licensee is refused
(`LICENSEE_NOT_AUTHORIZED`) unless `assignment` is exactly `permitted` — a
license the licensee may assign to anyone the moment it exists is one whose
licensee identity the authorization did not bind. `approval-required` keeps the
binding, because the further approval is exactly what has not happened.

### Quantity

`constraints.maximumLicensedUnits` — an integer count plus an opaque
denomination (`seat`, `deployment`, `installation`, `copy`). It is a
**per-license ceiling**, and it is deliberately *not* a rights scope and
deliberately *not* cumulative.

Collateral scope accumulates because encumbering a finite right twice exhausts
it. Licensed units do not: ten seats to Company B and ten to Company C exhaust
nothing about the asset. Whether more than one license may be granted at all is
answered by `additionalLicensesAllowed`, not by a unit pool. Soberanía counts
nothing, observes no usage, and enforces no limit at run time — this is a
ceiling compared against what an external system reports.

### The executor is optional

`TOKENIZE` and `COLLATERALIZE` both necessarily have an external performer —
someone must mint the token, someone must create the security interest.
Licensing does not. A licensor granting directly has no separate executor; a
licensor working through a licensing platform or rights administrator does.

`terms.executorRef` is therefore **optional**. When present, execution is bound
to exactly that party (`EXECUTOR_NOT_AUTHORIZED` on substitution). When absent,
the authorization simply does not bind who performs the external act, and
`execution.executedBy` is recorded as an observation that constrains nothing.

Requiring an executor would force every direct license to invent a party, and
an invented party binding protects nothing. See the enforcement-vocabulary ADR
for what this cost the "generic executor binding" hypothesis.

### Consideration, payment and royalties

Deliberately not modelled, not calculated, and not settled.
`constraints.externalAgreementReferenceRequired` is the hook: it declares that
an external agreement reference must be reported when the license is executed,
and it is *checked* at execution
(`EXTERNAL_AGREEMENT_REFERENCE_REQUIRED`). The evidence itself travels through
the existing `evidenceRefs` and obligation machinery. Soberanía records the
reference and never interprets, resolves, or verifies what it names.

## Authority, approvals and obligations

`LICENSE` uses the real existing paths and introduces no licensing-specific
authority engine:

```
LICENSE request → Recognition Runtime → Authority Graph → Kernel → decision
```

A requester never gains authority by submitting a request. Direct authority,
delegated authority, corporate authority and policy-defined authority all work
exactly as they do for every other action, and authority remains scoped to the
asset — a requester authorized over one asset is denied over another.

Approvals come from the existing Approval Runtime. Nothing here hard-codes
"all owners must always approve" or "creator approval is always required";
policy decides, and a delegated request subject to approval produces
`approval_required` and **no mandate**.

Obligations come from the existing Enterprise obligation infrastructure. There
is no separate license-policy system.

## Durability

- **In-memory store** — `createInMemoryLicenseMandateStore`. Synchronous commit
  sections; the right provider for tests, development and memory deployments.
- **SQLite store** — `createSqliteLicenseMandateStore`. Lazy `better-sqlite3`,
  `foreign_keys=ON`, `journal_mode=WAL`, `synchronous=FULL`, `busy_timeout`,
  schema-version guard that refuses to open a mismatched database, hand-written
  SQL, one synchronous transaction per multi-row mutation.

Both are held to *identical* domain semantics by the shared behavioural
contract suite (`src/enterprise/__tests__/license-mandate-store-contract.test.ts`),
which runs every assertion against both. Durability is not follow-up work: it
shipped in the same change as the action.

Durable invariants pushed down to the database:

| Constraint | Guarantees |
| --- | --- |
| `request_ref UNIQUE` | one request authorizes at most one mandate |
| `execution_id PRIMARY KEY` | one external license recorded at most once |
| `mandate_id UNIQUE` on revocations | at most one revocation per mandate |
| `(mandate_id, sequence) UNIQUE` | restart-stable append order |
| `execution_id` foreign key on lifecycle | a reported end names a license Soberanía has evidence of |

`terms_json` is the canonical serialization; `terms_digest` is the Governance
Store's own digest primitive over it. Every read recomputes the digest and
**fails closed** on mismatch rather than reconstructing an authorization from
bytes that changed after commit. A use expansion, licensee substitution,
exclusivity upgrade, context widening or rights-scope change would all have to
alter that column. Malformed JSON, unknown status, malformed scope, malformed
context, unknown exclusivity, unknown lifecycle type and malformed unit counts
are all corruption, never a usable record.

There is deliberately **no cumulative-scope column**, in contrast with
`collateralization_mandates.committed_scope_json`. Inventing one would create a
durable invariant the domain does not have.

### Revocation is not termination

Revoking a mandate withdraws the authority to grant *further* licenses. It does
**not** terminate, cancel, rescind, or invalidate a license an external system
has already granted — Soberanía governs authority and is not a party to the
agreement.

Execution evidence recorded before revocation is preserved immutably, and the
revocation record preserves `executionsAtRevocation`: the durable proof that
the authorization *had* been exercised.

Conversely, an external system reporting that a license expired or was
terminated is an *observation*
(`EnterpriseLicenseLifecycleEvidence`: `expired`, `terminated`, `cancelled`,
`surrendered`, `superseded`). It changes neither the mandate's status nor its
execution count. Decrementing the count on an unverified report would silently
manufacture fresh licensing capacity — exactly the escalation this module
exists to prevent. Reports arriving *after* authority has lapsed are accepted
deliberately: refusing them would discard exactly the evidence an auditor
needs.

## Reference integrity

`LICENSE` consumes the canonical Governance Reference Integrity mechanism
unchanged and adds no integrity code of its own. `sequence`,
`integrityVersion`, `previousReferenceDigest` and `referenceDigest` are
computed by the Store inside its own append transaction; a caller can neither
choose a chain position nor present a digest the Store did not compute.

```
LICENSE decision → LicenseMandate → authorization_artifact  (sequence 1)
                 → external license → execution_record       (sequence 2)
                 → reported end     → execution_record       (sequence 3)
```

A `LicenseMandate` is classified `authorization_artifact` — never
`external_artifact`, never `execution_record` — because it is Soberanía-owned
authorization evidence.

**Integrity is not authority.** A valid reference digest proves only that the
Governance Store row has not changed according to the configured mechanism. It
is not authority, not legal validity, and not proof that any external event was
truthful. Authority comes from Enterprise enforcement; external truth requires
external evidence. Appending a perfectly-sealed reference naming a mandate that
was never issued produces a row that verifies and authorizes nothing.

The documented **privileged-writer limitation** applies here unchanged: a
writer able to rewrite data, digests, chain links and heads together can defeat
local tamper detection. Signatures, HSM custody, external transparency logs,
remote attestation and Protocol anchoring remain deferred.

## Reference scenario

`src/enterprise/__tests__/license-durability.test.ts` runs one executable
end-to-end scenario against real SQLite stores across two restarts:

```
Asset          Digital Work A  (asset:digital-work-a, tenant org-aurelia-studios)
Right          usage-right
Action         LICENSE
Licensee       Company B
Permitted use  display · reproduce · commercial-use   (model-training excluded)
Context        territory-a · channel-web
Term ceiling   2027-01-01
Executor       Licensing Platform C
```

authority recognized → LICENSE request → policy evaluation → allowed decision →
LicenseMandate → durable persistence → `authorization_artifact` → reference
integrity → **restart** → mandate recovered with asset, rights, licensee,
permission, duration, constraints and tenant unchanged → simulated external
execution → `execution_record` → reference integrity → **restart** → full
lineage reconstructed and the whole chain verifies.

The same scenario then proves an invalid execution cannot replace the licensee,
add rights, expand a use, expand the operating context, extend the duration,
change exclusivity, replace the bound executor, or be replayed.

## Governance lineage

`getEvidenceLineage` answers, from stored references alone: why was licensing
permitted, who had authority, which governed rights were involved, what portion
of them (or explicitly none), who the licensee was, what uses were permitted,
what uses were excluded, what duration applied, what operating context applied,
whether it was exclusive, who was authorized to execute it (or that none was
bound), what obligations existed, whether external execution was consistent
with the mandate, whether future authorization has been revoked, and what
external lifecycle evidence exists.

## Tenant isolation

Tenant A cannot read, revoke, record execution against, or reconstruct the
lineage of a Tenant B `LicenseMandate`, and cannot license a Tenant B asset —
the asset-tenancy check runs *before* the Kernel is consulted, so a
cross-tenant attempt never even produces a governance evaluation to point at.
A system caller sees across tenants by design; a non-system caller without an
organization scope is refused.

## Deferred work

Deliberately **not** built, and none of it is implied by these contracts:

- licensing provider integrations and adapters
- contract drafting, signature capture, acceptance workflows
- royalty, payment, billing, settlement, pricing, valuation, tax
- usage metering, monitoring, DRM, content delivery
- marketplaces, license discovery, catalogues
- rights registries (copyright, patent, trademark)
- jurisdiction-specific legal policy or legal-opinion automation
- `SUBLICENSE`, `ASSIGN_LICENSE`, `TERMINATE_LICENSE` as governed actions
- external trust anchoring for the privileged-writer limitation

## Update — the fourth enforcement

`TRANSFER` (`docs/enterprise/AOC_TRANSFER_ACTION.md`) has since landed, and two
of this action's distinguishing decisions were re-tested against it:

- **Optional executor: confirmed, and sharpened.** `LICENSE` showed that some
  actions have no necessary external performer. `TRANSFER` showed that the
  *same* action may have one in some arrangements and not in others. Universal
  executor binding is now falsified twice, independently.
- **Optional rights scope: confirmed as licence-specific.** `TRANSFER` requires
  a scope — moving a right is inherently a question of how much of it moves —
  so `LICENSE` remains the only action of four for which a fraction is
  optional, and "absence means not fractionally expressed, never 100%" remains
  a statement about permissions rather than about quantities.

`LICENSE` now consumes the shared, action-neutral vocabulary in
`@aoc-enterprise/governed-authorization` (the governed-right categories, the
rights-scope value type, the authorization-artifact skeleton and the evidence
envelopes) via aliases and interface extension. No serialized byte, stored
record, consumer, validator or error code changed. See
`docs/architecture/ADR-ENTERPRISE-ENFORCEMENT-VOCABULARY.md`.

## Update — constraint applicability

`LICENSE`, like `TOKENIZE`, has **no generic relationship to persistent authority
constraints**.

```
reservation behaviour            none — it never calls the authority store
produces persistent constraint   none
consumes constraint class        none
structural effect                none
policy visibility                full
release relationship             none
```

Two properties matter here beyond the shared answer.

**No cross-right coupling.** An `economic-interest` constraint does not reach a
`usage-right` licence. There is deliberately no typed relation between the two:
Soberanía holds no evidence those quantities are commensurable, and inventing the
relation would be inventing the policy.

**An absent `rightsScope` is still not 100 %.** A licence that expresses no
fraction has no quantity for a constraint to reduce, and this layer does not
manufacture one.

Licence scarcity — exclusivity, seat ceilings, duration — remains action-local
policy, and an exclusive licence produces no persistent authority constraint
today. Should it later need to, that is a new constraint class rather than a
reuse of collateral's. A deployment wanting to bar licensing while collateral
stands expresses it as policy. See
`AOC_GOVERNED_CONSTRAINT_APPLICABILITY.md`.
