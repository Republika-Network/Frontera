# ADR — Governed Action Semantic & Parameter Model (CORE-03)

- **Status:** Accepted (CORE-03, 2026-09-27)
- **Roadmap item:** CORE-03 — Governed Action Semantic & Parameter Model (Actor · Action · Resource; envelope generalization), `docs/architecture/FRONTERA-MASTER-PLAN.md` §9
- **Answers:** Master Plan §16 OQ-1 (profile format) and the CORE-03 half of OQ-2 (how a decision records the profile version in force)
- **Supersedes:** nothing. Extends `ADR-OBLIGATION-DISCHARGE-AND-BOUNDED-GRANT.md` §4 (the bound algebra) and `ADR-CANONICAL-MONETARY-SEMANTICS.md` (P9), both unchanged in substance

## 1. Context

Before CORE-03 the governed-action control flow was action-neutral but its
**parameters were money-shaped** (Master Plan §4.1, L-2 … L-6):

| Coupling (pre-CORE-03) | Where | Class |
|---|---|---|
| `amount` and `counterparty` were the only parameter axes of the envelope | `governed-action/contracts.ts` `GovernedActionIntent` | **Generic leakage** — removed as the *only* axes (typed parameters added) |
| `GrantBoundKey` was a closed five-key list whose only quantity was a money ceiling | `grant-runtime/domain/grant-scope.ts` | **Generic leakage** — a typed parameter bound list now exists beside it |
| The only action classification was `financial` / `non-financial`; no resource class existed | `monetary-runtime/domain/financial-action.ts`, `intent.ts` | **Generic leakage** (as the only classification) — domain-declared action/resource classes added; the P9 binary stays as financial specialization |
| `ActionDescriptor.amount` / `currency` on every Kernel request | `kernel/contracts/kernel-request.ts` | **Legitimate specialization** — the monetary dimension, exact, P9/P10-owned; kept |
| `spending_limit` / `max_amount` authority constraints | `authority-graph`, `kernel-authority/monetary-constraints.ts` | **Legitimate specialization** (P10) — kept; a generic authority-sourced parameter limit is future work (§9) |
| P7 aggregate controls keyed on money | `exercise-control-runtime` | **Legitimate specialization** — kept |
| Reserved context-key names (`paymentCeiling`, `spendingLimit`, …) | `governed-action/intent.ts` | Denylist names, not logic — kept; CORE-03 adds a **registry** trusted configuration extends (§2.7) and reserves every declared dimension id |
| `ActionDescriptor.parameters` (untyped bag) | Kernel request | **Not authority** — legacy mandate metadata; CORE-03 builds nothing on it and documents it as never authority-material |

## 2. Decision

**One envelope, generalized.** `GovernedActionIntent` stays the runtime
envelope. No `GovernedActionV2`, no object above it, no second pipeline. The
spine is unchanged: intent → Kernel → BoundedGrant → controls → claim →
adapter → outcome → evidence.

### 2.1 Actor · Action · Resource

| Concept | Runtime representation |
|---|---|
| Actor | The bound customer identity (P2) — never on the envelope |
| Action | `action`: the concrete identifier (unchanged), bound as the grant's `action` identity axis |
| Action class | `semantics.actionClass`: an opaque, domain-declared identifier resolved from `action` by trusted configuration |
| Resource | `resource`: the concrete reference (unchanged), bound as the grant's `resources` set axis |
| Resource class | `semantics.resourceClass`: an opaque, domain-declared identifier resolved from `resource` by trusted configuration |
| Parameters | `parameters`: typed values for **declared** dimensions only |

Classes are **not enums**. CORE holds no taxonomy; a deployment declares
`actionClasses: [{ id, actions[] }]` and `resourceClasses: [{ id, resources[] }]`
over exact identifiers. Each identifier belongs to at most one class. The
P9 `financial`/`non-financial` classifier is orthogonal and unchanged.

### 2.2 Typed parameter dimensions (`src/features/governed-parameter-runtime`)

A pure primitive that imports nothing. A dimension is declared once, by trusted
configuration: `{ id, type, bound }`.

| Type | Value | Accepted from | Bound kinds |
|---|---|---|---|
| `integer` | safe integer, never `-0` | a JSON number that *is* a safe integer | `exact`, `maximum` |
| `token` | `[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}` | a string in that grammar | `exact` |
| `boolean` | `true`/`false` | a JSON boolean | `exact` |

No coercion anywhere (`"100"` ≠ 100, `1` ≠ `true`, `null` ≠ absent). No
floating point, no decimal-without-unit: **money keeps its own exact dimension**
(`amount`, `MonetaryAmount`, P9) and its authority-sourced ceiling (P10).
Identifiers (dimension, class, profile) share one grammar
(`^[a-z][A-Za-z0-9]*(?:[._-][A-Za-z0-9]+)*$`, ≤ 64), are case-sensitive, and a
registry refuses two that differ only by case.

### 2.3 The generic bound model and the grant format

A semantic grant carries four **additive** scope axes and one **explicit,
signed format marker**:

| Field | Shape | Meaning |
|---|---|---|
| `scope.actionClass` | `identity` | the effective action class |
| `scope.resourceClass` | `identity` | the effective resource class |
| `scope.governanceProfile` | `identity` on `<id>@<version>#<sha256 digest>` | the effective profile, pinned to its content |
| `scope.parameters` | list (never a map) of typed bounds, strictly ascending by dimension: `{ dimension, kind: 'exact', type, value }` or `{ dimension, kind: 'maximum', type: 'integer', limit }` | what the decision evaluated, under each dimension's declared bound kind |
| `semanticsFormat` (top-level) | `"frontera.grant-semantics.v1"` | the grant is in the CORE-03 semantic format |

**Marker/axes agreement is a well-formedness rule** (`isConsistentGrantSemantics`),
enforced at issuance, by both stores before signing or keeping a grant, on
every durable read (after signature verification) and at every exercise:

- no marker → none of the four semantic axes may be present (a pre-CORE-03 grant);
- the v1 marker → `actionClass`, `resourceClass` and `governanceProfile` all
  present; `parameters` only beside them (a profile may govern no parameter);
- any other marker, or any partial combination → refused
  (`GRANT_SEMANTICS_FORMAT_INVALID` / `GRANT_EXERCISE_INTEGRITY_INVALID` /
  `BOUNDED_GRANT_STORE_STATE_CORRUPT`).

Comparison is total and exact; different kinds, types or malformed values are
`incomparable`, which fails closed exactly like `broader`. Attenuation applies
the four existing fail-closed rules per dimension (broader, incomparable,
unstated-in-parent, malformed list). `grantScopeIsWithin` is **strict** for
parameters: a child that drops a parent's parameter bound is broader. The
Kernel projects each evaluated parameter under its *declared* bound kind
(`exact` pins the value; `maximum` admits it and below); a parameter no declared
kind can bound projects an empty (malformed) list, so no grant derives. The
exercise gate requires every granted dimension to be stated and admitted,
refuses any stated dimension the grant does not bound, and refuses an attempt
under another action class, resource class or profile
(`GRANT_EXERCISE_SEMANTIC_CLASS_MISMATCH`, `GRANT_EXERCISE_GOVERNANCE_PROFILE_MISMATCH`).

`maximum` is a statement a *domain* makes about a dimension ("less is always
within the authority for more") in trusted configuration — never a caller.

### 2.4 Governance Profiles (`src/enterprise/governance-profile`)

Closed schema, data only:

```
profileId, version (positive integer), owner,
provenance { authoredBy, approvedBy },
actionClass, resourceClass,
parameters [{ dimension, required }],
materialFacts [fact-class id],        — admitted from trusted sources by CORE-04, not here
relevantPolicies [policy reference]   — references, never inline rules
```

- **Identity is content:** `digest = sha256(canonical-json({ format: 'frontera.governance-profile.v1', profile }))`
  via the Governance Store's existing canonicalizer (no new canonicalizer). An
  edit under an unchanged version changes the reference.
- **One active version per profile id, one profile per action class × resource class.**
  Lifecycle (draft → active → retired) is future work (§8).
- **Trusted source only:** `CreateEnterpriseOptions.governance` or the shipped
  Host's governed-action file (`governance` key). Built and validated once at
  composition; a malformed profile refuses Host startup
  (`HOST_GOVERNED_ACTIONS_FILE_INVALID`).
- **A profile is not policy.** It says what matters; policy decides what is allowed.

### 2.5 Selection boundary: the effective profile is server-resolved

`resolve(action, resource)`:

| Result | Meaning | Envelope behaviour |
|---|---|---|
| `unclassified` | neither side is classified | governed exactly as before CORE-03; **no parameters, no profile expectation** |
| `resolved` | both classified, exactly one profile | parameters validated against that profile |
| `refused` | half-classified, or classified with no profile | **rejected** — never downgraded to unclassified |

The **effective** profile is always the resolver's: it is what
`action.semantics` carries, what the committed decision records and what the
grant binds (`<id>@<version>#<digest>`). The caller may send
`expectedGovernanceProfile: { id, version }` — a **hint that pins**. A mismatch
(substitution, downgrade, upgrade) is refused before the Kernel runs; a match
or an absent hint changes nothing. `governanceProfile` is not an envelope
field, and neither name may be asserted as context. There is no field through
which a caller can supply, select or edit a profile.

### 2.6 One parameter model; parameter vs bound vs context

| Datum | Class | Where |
|---|---|---|
| Typed declared parameters | **authority material** | `intent.parameters` (untrusted wire) → validated declared list → Kernel `action.governedParameters` → policy `governedParameters` → grant `scope.parameters` → exercise `parameters` |
| Effective profile id/version/digest, action class, resource class | **authority material** | Kernel `action.semantics` → policy fields → grant axes + `semanticsFormat` → exercise |
| Typed parameters for adapters | **execution material** — none in CORE-03; **delivered since CORE-08**: the exercise-contained list only | `ValidatedExecutionAction.parameters` → Generic HTTP `parameter` bindings; bound by the P11 v2 attempt digest (§9) |
| Profile `materialFacts` | declared references to **trusted context** — admitted by CORE-04's Trusted Context Boundary since 2026-09-28 | policy `contextFact` predicates (admitted facts only); raw `metadata['aoc.context']` paths are refused (ADR-TRUSTED-CONTEXT-AND-OBLIGATIONS-ON-THE-GOVERNED-PATH) |
| `assertedContext`, legacy `ActionDescriptor.parameters` | **metadata**, never authority | recognition metadata only |

There is one canonical authority-relevant parameter model
(`src/features/governed-parameter-runtime`). The profile's `parameters` declare
*which* dimensions it governs; they hold no values. The legacy untyped
`ActionDescriptor.parameters` bag is `@deprecated` and non-authoritative: its
only reader is the recognition metadata copy, the governed path never sets it,
and a test proves it changes no policy input, no grant source and no decision
(`kernel-legacy-parameters.test.ts`).

Proposed parameters never enter the resolved-facts `metadata` namespace.

### 2.7 The reserved-key registry

`GOVERNED_ACTION_RESERVED_CONTEXT_KEYS` stays the built-in list (now also
`resourceClass`, `governanceProfile`, `expectedGovernanceProfile`,
`governedParameters`). Trusted configuration extends it through
`governance.reservedContextKeys` (validated key grammar, case-insensitive,
no case-only duplicates) — the registry verticals such as a payment-protocol
pack use (L-7, PAY-02). Every declared dimension id is reserved too, in any
case. A request can neither add, name nor remove a reserved key.

### 2.8 Policy integration

Five closed, generic predicate fields: `actionClass`, `resourceClass`,
`governanceProfile` (effective profile id), `governanceProfileVersion`
(effective version, ordered numerically) and `parameter` + `parameterId` (exact
dimension id, looked up in a list — no path, no prototype read). The validator
refuses a parameter predicate without a valid id, with a path, or with an
ordered threshold that is not a safe integer. Deterministic; no expression
language. The engine knows no domain name: `recordCount`, `export` and
`customer_dataset` exist only in profile and policy data
(`governed-action-neutrality-structure.test.ts`).

### 2.9 `currency` and `unit`: one canonical mapping point

Not renamed. `currency` stays the frozen v1 wire name and the Kernel/policy
contract name; `unit` stays P9's canonical name. Every translation between
them happens in `governed-action/monetary-naming.ts` and nowhere else
(structurally tested).

### 2.10 NB-008 — policy-pack writes are attributed and freezable

Policy-pack writes (`registerPolicyPack`, `registerPolicyPackVersion`,
`activate`/`deprecate`/`revoke`/`supersede`, `freeze`) take a trusted
`PolicyPackWriterContext { system: true, actorId }` first — the shape
`KernelAuthorityProvisioningService` requires — and are refused without one
(`POLICY_PACK_WRITER_REQUIRED`), changing nothing. The writer is recorded on
the pack (`registeredBy`, `lastWrittenBy`), the version (`registeredBy`,
`statusChangedBy`) and every lifecycle event (`payload.actorId`).
`PolicyPackRuntime` keeps its store and registry `#private` and exposes a
frozen read-only store facade, so there is no write path around the gate.
`freeze(writer)` makes packs and versions read-only for the rest of the
process (`POLICY_PACK_REGISTRY_FROZEN`), at the registry and at the store.
Residual (SEC-TRUST-001): code in the same process can construct a writer
context, exactly as it can a Kernel-Authority system context — the guarantee
is attribution and an explicit, freezable boundary, not isolation from the host.

## 3. Canonicalization, authenticity, identity

- `serializeGrantScope` emits every semantic axis at its canonical-JSON
  position; `serializeBoundedGrant` emits `semanticsFormat` between `scope` and
  `sourceDigest`. Bytes are pinned against `governance-store/canonical-json.ts`.
- `semanticsFormat`, `actionClass`, `resourceClass`, the effective profile
  reference and every parameter bound are inside the grant `id`, `digest`,
  `sourceDigest` and the Ed25519 signing bytes. Tampering with, stripping or
  adding any of them is refused on read.
- **Signing domain: kept (`frontera:authority-artifact:bounded-grant:v1\n`),
  deliberately.** A domain tag separates *artifact kinds* (grant, revocation,
  revocation state); it is not needed to separate grant *formats* because:
  (1) `semanticsFormat` and every semantic axis are inside the signed payload,
  so no byte of a signed grant can be reinterpreted under the other format
  without breaking the signature; (2) the marker/axes agreement rule is checked
  after verification, so even an authentic but inconsistent grant is refused;
  (3) legacy signed bytes contain no marker and no axis, and are exactly the
  pre-CORE-03 bytes, so legacy signatures stay valid with no re-signing.
  Bumping the domain would instead have required dual-domain verification and
  still needed the marker to choose between them. Tested in
  `pre-core-03-compatibility.test.ts` ("signing domain (§7)").
- The Kernel request carries `semantics` and `governedParameters` (ids as values,
  never keys, so key-name redaction can never collapse two requests), digested
  into the Governance Store payload digest: different parameters never share an
  idempotency record.

## 4. Versioning and migration

| Artifact | Legacy (pre-CORE-03) | New (CORE-03 semantic) |
|---|---|---|
| Bounded-grant store schema | `aoc.bounded-grant-store.schema.v3` | unchanged |
| Record envelope format | `aoc.bounded-grant-store.record.v2` | unchanged |
| Signing domain | `…bounded-grant:v1` | unchanged (§3) |
| Grant semantic format | *absent* | `semanticsFormat: "frontera.grant-semantics.v1"` (signed) |
| Semantic axes | none | `actionClass`, `resourceClass`, `governanceProfile` required; `parameters` optional |

- **Legacy grants** are read unchanged: identical bytes, id, digest and
  signature (proven against a real pre-CORE-03 signed SQLite store generated by
  the unmodified `2ee659b` build, `src/enterprise/__tests__/fixtures/pre-core-03/`).
  They bound no class, profile or parameter, so an attempt stating any is
  refused. Nothing is translated, re-signed or widened.
- **Downgrade and mixing prevention:** stripping the marker, stripping any
  semantic axis, adding a marker to a legacy grant, or changing the marker is
  refused on read (signature and agreement rule); a store refuses to sign a
  grant whose marker and axes disagree. All tested.
- **Legacy requests** (no semantics) digest byte-identically, so idempotent
  replay across the upgrade holds.
- **Profile change and idempotent retry:** the request is rebuilt from the
  intent and the *current* registry on every call. If a profile's content (and
  therefore its digest) changed between a request and its retry under the same
  idempotency key, the rebuilt request digests differently and the retry is an
  idempotency **conflict** (`rejected`) — never a silent re-decision under the
  new profile. The committed decision stands as recorded.
- **Rollback constraint:** pre-CORE-03 code refuses a semantic grant — its
  canonical re-serialization drops the unknown fields, so the row fails the
  round-trip and reads as `BOUNDED_GRANT_STORE_STATE_CORRUPT`. Verified by
  running the actual `2ee659b` build against a store written by the CORE-03
  build: the legacy-shaped grant reads, the semantic grant is refused. Rolling
  back after issuing semantic grants fails **closed** for those grants only.

## 5. API

- `POST /api/governed-actions`: two optional request fields (`parameters`,
  `expectedGovernanceProfile`). No new route; `release/api-surface.v1.json`
  unchanged. An unprofiled deployment behaves exactly as before, and the fields
  are refused where no profile governs.
- CTRL-01 grant view: `bounds` derives from `GRANT_BOUND_KEYS` (it previously
  hard-coded five keys and would have hidden a new axis) and adds
  `bounds.parameters`; `semanticsFormat` is shown when present. No new admin
  route; no route mints or expands authority.
- SDK types: two optional fields on `GovernedActionIntent`.

## 6. Threat review

| Threat | Mitigation | Residual |
|---|---|---|
| Parameter smuggling (metadata, context, shadow keys) | Closed envelope; only declared dimensions; case-variant keys undeclared; declared ids and registered keys reserved in context (any case); policy reads only the typed list | Context is still caller claims to recognition (unchanged; CORE-04) |
| Undeclared dimensions | Registry is closed; profile may reference only declared dimensions; envelope refuses others; exercise refuses unbounded stated dimensions | — |
| Type confusion | Typed values and typed bounds; no coercion; token `"5"` never integer `5` | — |
| Comparator confusion | Comparator fixed by the dimension declaration; kind/type mismatch = incomparable | A domain that wrongly declares `maximum` for a non-monotone dimension mis-bounds its own grants (configuration trust, AA-002) |
| Profile substitution / downgrade / version confusion | Effective profile server-resolved; caller may only pin; mismatch refused; the valid follow-up commits and binds the real id/version/digest; exercise refuses another profile | No profile lifecycle or signing of profile content (§8) |
| Action-class / resource-class substitution | Classes are explicit signed grant axes checked at exercise | — |
| Format downgrade / mixing | Signed `semanticsFormat`; marker/axes agreement at issue, store, read and exercise | — |
| Canonicalization collision | Lists sorted and duplicate-free as a well-formedness rule; ids as values; pinned against the canonicalizer | — |
| Legacy/new mismatch, migration expansion | No translation; legacy grants carry no new axes; stating one against them is refused | Rollback constraint (§4) |
| Action / resource substitution | Grant `action` identity and `resources` set checked at exercise (re-proven through ACE) | — |
| Metadata as authority | Legacy `ActionDescriptor.parameters` deprecated and proven inert; policy `metadata` stays resolved-facts only | — |
| Policy self-modification (NB-008) | Attributed writes behind a trusted writer; no write path around the registry; freeze | In-process code can construct a writer (SEC-TRUST-001); packs stay in-process (no durable policy store) |
| Financial regression | P7/P9/P10/P11 behaviour unchanged; money not routed through profiles | One P9 test file gained the writer argument at its registration call sites (§2.10), assertions untouched |
| Profile configuration tampering | Profiles are host configuration; a malformed set refuses startup | Whoever controls configuration controls governance (AA-002) |

## 7. Consequences

- Materially different actions over the same resource can be governed
  differently by policy and profile data alone, with no Kernel change
  (`governed-action-thesis-read-export.test.ts`).
- The Kernel, orchestrator, grant and execution runtimes and the policy engine
  stay domain-free, enforced structurally (`governed-action-neutrality-structure.test.ts`).
- PAY/CREDIT/INTEL get a typed target: action class, resource class, profile
  id/version, declared parameters; PAY-02 gets the reserved-key registry.

## 8. Not done here (owned elsewhere)

- ~~**Adapter transmission of parameters (execution material).**
  `ValidatedExecutionAction` does not carry typed parameters: P11's prepared
  attempt records the exact adapter context under a closed v1 schema, and CORE-03
  deliberately does not expand P11. Parameters are fully governed (policy,
  grant, exercise) on the one canonical path; they are not handed to adapters.
  Owner: CORE-08 (first domain adapter that needs them).~~ **Delivered by
  CORE-08 — see §9.**
- ~~**Authority-sourced non-money limits** (a generic counterpart of P10's
  `spending_limit`): today a non-money bound comes from the decision's
  projection and trusted host narrowing. Owner: CTRL-02 (provisioning schema)
  with CORE-04.~~ **Delivered by CTRL-02** (pre-push hardening): standing
  `parameterBounds` on authority and delegation grants, in this ADR's canonical
  bound shape and algebra, enforced on the decision's lineage before any grant
  is issued (`ADR-CTRL-02-OPERATOR-AGENT-IDENTITY.md` D10; SEC-INV-198).
- **Durable policy store** and wiring policy packs into the shipped Host: not
  CORE-03 (NB-008's attribution and freeze are closed here).
- **Profile lifecycle, promotion identity and signing** (OQ-2, who may promote): CTRL-02 — lifecycle (catalog-backed draft → active → retired) and promotion identity **delivered**; cryptographic signing of profile content not done.
- **Material-fact admission:** CORE-04.
- **Profile resolution by interpretation:** INTEL-02.

## 9. CORE-08 addendum — parameters across the execution boundary

**Status:** Accepted (CORE-08, 2026-09-30). No second parameter model: the
canonical `GovernedParameter` (`{ dimension, type, value }`) of
`src/features/governed-parameter-runtime` is reused end to end.

```
intent.parameters (untrusted wire)
  → trusted profile declaration → type validation (envelope, no coercion)
  → Kernel action.governedParameters → deterministic policy
  → committed decision (re-read, verified) → signed grant scope.parameters
  → exercise request (built from the VERIFIED committed request, never the caller's object)
  → GrantExecutionService: snapshot (fresh frozen copy, read once) → containment assessment
  → ValidatedExecutionAction.parameters (the assessed snapshot) → adapter
```

- **Source.** The orchestrator builds the exercise request's parameters from
  the committed, re-read and verified Kernel request. `GrantExecutionService`
  copies them once, into fresh frozen `{ dimension, type, value }` entries,
  when the exercise begins; every assessment, the P7 input and the
  `ValidatedExecutionAction` read that copy. A caller mutating its own objects
  while the exercise awaits a store or a reservation changes nothing assessed
  and nothing delivered; a getter runs once; extra keys never travel.
- **Only contained parameters cross.** The exercise gate already requires the
  attempt's list to equal the grant's bounded dimensions exactly (both
  directions) and each value inside its bound, with its declared type; so a
  delivered list exists exactly when the grant bounds parameters, in canonical
  order, duplicate-free. A legacy (pre-CORE-03) grant bounds none, so it
  can never carry a parameter to an adapter.
- **Values, not authority.** The adapter port still carries no decision, policy
  result, approval, obligation state, context, grant scope or digest; an
  adapter translates the values and decides nothing with them.
- **Provider mapping is configuration.** Generic HTTP reads a parameter only
  through a closed `{ kind: 'parameter', dimension }` binding, by exact id,
  into a value position (`docs/enterprise/AOC_GENERIC_HTTP_EXECUTION_ADAPTER.md`
  §4a). A parameter can never select a destination, credential or adapter.
- **Durable execution context.** The P11 attempt now binds the exact delivered
  list under a versioned record format (v2); historical v1 records are read as
  written and never gain parameters (`ADR-DURABLE-MONETARY-OUTCOMES.md` §14).
- **Money stays money.** A monetary action keeps `amount` (P9) and its
  authority-sourced ceiling (P10); no `amount` dimension is introduced.

Evidence: `execution-parameter-delivery.test.ts`,
`generic-http-parameter-mapping.test.ts`, `execution-outcome-parameters.test.ts`,
`core08-action-neutrality-host.test.ts`; SEC-INV-181 … SEC-INV-188.
