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
| Reserved context-key names (`paymentCeiling`, `spendingLimit`, …) | `governed-action/intent.ts` | Denylist names, not logic — kept; CORE-03 adds its own names and **dynamically** reserves every declared dimension id |
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

### 2.3 The generic bound model

The grant scope gains two **additive** axes, both omitted when absent:

- `governanceProfile` — an `identity` bound on `<id>@<version>#<sha256 digest>`;
- `parameters` — a list (never a map) of typed bounds, strictly ascending by dimension:
  `{ dimension, kind: 'exact', type, value }` or `{ dimension, kind: 'maximum', type: 'integer', limit }`.

Comparison is total and exact; different kinds, types or malformed values are
`incomparable`, which fails closed exactly like `broader`. Attenuation applies
the four existing fail-closed rules per dimension (broader, incomparable,
unstated-in-parent, malformed list). `grantScopeIsWithin` is **strict** for
parameters: a child that drops a parent's parameter bound is broader. The
Kernel projects each evaluated parameter under its *declared* bound kind
(`exact` pins the value; `maximum` admits it and below); a parameter no declared
kind can bound projects an empty (malformed) list, so no grant derives. The
exercise gate requires every granted dimension to be stated and admitted, and
refuses any stated dimension the grant does not bound, and a profile mismatch.

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
  Lifecycle (draft → active → retired) is future work (§9).
- **Trusted source only:** `CreateEnterpriseOptions.governance` or the shipped
  Host's governed-action file (`governance` key). Built and validated once at
  composition; a malformed profile refuses Host startup
  (`HOST_GOVERNED_ACTIONS_FILE_INVALID`).
- **A profile is not policy.** It says what matters; policy decides what is allowed.

### 2.5 Selection boundary

`resolve(action, resource)`:

| Result | Meaning | Envelope behaviour |
|---|---|---|
| `unclassified` | neither side is classified | governed exactly as before CORE-03; **no parameters, no profile expectation** |
| `resolved` | both classified, exactly one profile | parameters validated against that profile |
| `refused` | half-classified, or classified with no profile | **rejected** — never downgraded to unclassified |

The caller may send `governanceProfile: { id, version }` as an **expectation**.
A mismatch (substitution, downgrade, upgrade) is refused. There is no field
through which a caller can supply, select or edit a profile.

### 2.6 Parameter vs bound vs context

| | Owner | Where |
|---|---|---|
| Parameter (what the action proposes) | caller, typed by the declared dimension | `intent.parameters` → Kernel `action.governedParameters` → policy `governedParameters` |
| Bound (what authority permits) | the committed decision's projection, narrowed only by the trusted host | grant `scope.parameters` |
| Trusted context (verified facts) | CORE-04 (not here) | policy `metadata['aoc.context']`, unchanged |

Proposed parameters never enter the resolved-facts `metadata` namespace. Every
declared dimension id (any case) is reserved in `assertedContext`, as are
`resourceClass`, `governanceProfile`, `governedParameters`.

### 2.7 Policy integration

Four closed predicate fields: `actionClass`, `resourceClass`,
`governanceProfile` (profile id) and `parameter` + `parameterId` (exact dimension
id, looked up in a list — no path, no prototype read). The validator refuses a
parameter predicate without a valid id, with a path, or with an ordered
threshold that is not a safe integer. Deterministic; no expression language.

## 3. Canonicalization, authenticity, identity

- `serializeGrantScope` emits `governanceProfile` and `parameters` at their
  canonical-JSON positions; bytes are pinned against
  `governance-store/canonical-json.ts` (`pre-core-03-compatibility.test.ts`).
- Both axes are inside `serializeBoundedGrant` → the grant `digest`, the grant
  `id`, the `sourceDigest`, and the Ed25519 signing bytes
  (`frontera:authority-artifact:bounded-grant:v1\n` + stored record). Tampering
  with a parameter bound, the profile, a type or a dimension name is refused on
  read.
- The Kernel request carries `semantics` and `governedParameters` (ids as values,
  never keys, so key-name redaction can never collapse two requests), digested
  into the Governance Store payload digest: different parameters never share an
  idempotency record.

## 4. Versioning and migration

- **No schema version change.** Bounded-grant store stays
  `aoc.bounded-grant-store.schema.v3`; signing domain stays `…:bounded-grant:v1`;
  Governance Store and P11 schemas unchanged.
- **Legacy grants** are read unchanged: identical bytes, id, digest and
  signature (proven against a real pre-CORE-03 signed SQLite store generated by
  the unmodified `2ee659b` build, `src/enterprise/__tests__/fixtures/pre-core-03/`).
  They bound no profile and no parameter, so an attempt stating either is
  refused. Nothing is translated, re-signed or widened.
- **Legacy requests** (no semantics) digest byte-identically, so idempotent
  replay across the upgrade holds.
- **Profile change and idempotent retry:** the request is rebuilt from the
  intent and the *current* registry on every call. If a profile's content (and
  therefore its digest) changed between a request and its retry under the same
  idempotency key, the rebuilt request digests differently and the retry is an
  idempotency **conflict** (`rejected`) — never a silent re-decision under the
  new profile. The committed decision stands as recorded.
- **Rollback constraint:** a grant carrying the new axes is unreadable by
  pre-CORE-03 code (its round-trip re-serialization drops the unknown key and the
  row is refused). Rolling back after issuing such grants fails **closed** for
  those grants only. Documented, not mitigated.

## 5. API

- `POST /api/governed-actions`: two optional request fields (`parameters`,
  `governanceProfile`). No new route; `release/api-surface.v1.json` unchanged.
  Existing clients are unaffected: an unprofiled deployment behaves exactly as
  before, and the fields are refused where no profile governs.
- CTRL-01 grant view: `bounds` now derives from `GRANT_BOUND_KEYS` (it
  previously hard-coded five keys and would have hidden a new axis) and adds
  `bounds.parameters`. No new admin route; no route mints or expands authority.
- SDK types: two optional fields on `GovernedActionIntent`.

## 6. Threat review

| Threat | Mitigation | Residual |
|---|---|---|
| Parameter smuggling (metadata, context, shadow keys) | Closed envelope; only declared dimensions; case-variant keys undeclared; declared ids reserved in context (any case); policy reads only the typed list | Context is still caller claims to recognition (unchanged; CORE-04) |
| Undeclared dimensions | Registry is closed; profile may reference only declared dimensions; envelope refuses others; exercise refuses unbounded stated dimensions | — |
| Type confusion | Typed values and typed bounds; no coercion; token `"5"` never integer `5` | — |
| Comparator confusion | Comparator fixed by the dimension declaration; kind/type mismatch = incomparable | A domain that wrongly declares `maximum` for a non-monotone dimension mis-bounds its own grants (configuration trust, AA-002) |
| Profile substitution / downgrade / version confusion | Trusted resolver chooses; caller may only pin; mismatch refused; profile reference (with digest) bound into the signed grant and checked at exercise | No profile lifecycle or signing of profile content (§9) |
| Canonicalization collision | Lists sorted and duplicate-free as a well-formedness rule; ids as values; pinned against the canonicalizer | — |
| Legacy/new mismatch, migration expansion | No translation; legacy grants carry no new axes; stating one against them is refused | Rollback constraint (§4) |
| Action / resource substitution | Grant `action` identity and `resources` set checked at exercise (pre-existing, re-proven through ACE) | — |
| Metadata as authority | `ActionDescriptor.parameters` documented and tested as never authority-material; policy `metadata` stays resolved-facts only | — |
| Financial regression | P9/P10 suites unchanged; money not routed through profiles | — |
| Profile configuration tampering | Profiles are host configuration; a malformed set refuses startup | Whoever controls configuration controls governance (AA-002) |

## 7. Consequences

- Materially different actions over the same resource can be governed
  differently by policy and profile data alone, with no Kernel change
  (`governed-action-thesis-read-export.test.ts`).
- The Kernel, orchestrator, grant and execution runtimes stay domain-free,
  enforced structurally (`governed-action-neutrality-structure.test.ts`).
- PAY/CREDIT/INTEL get a typed target: action class, resource class, profile
  id/version, declared parameters.

## 8. Not done here (owned elsewhere)

- **Adapter transmission of parameters.** `ValidatedExecutionAction` does not
  carry typed parameters yet: P11's prepared attempt records the exact adapter
  context under a closed v1 schema, and adding parameters needs an explicit P11
  schema version. Parameters are governed (policy, grant, exercise) but not
  handed to adapters. Owner: CORE-08 (first domain adapter that needs them).
- **Authority-sourced non-money limits** (a generic counterpart of P10's
  `spending_limit`): today a non-money bound comes from the decision's
  projection and trusted host narrowing. Owner: CTRL-02 (provisioning schema)
  with CORE-04.
- **NB-008** (policy-pack writes carry no caller identity): unchanged. It is a
  policy-administration identity problem that needs the operator identity model;
  re-homed to CTRL-02. Policy packs remain unwired on the shipped Host.
- **Profile lifecycle, promotion and signing** (OQ-2, who may promote): CTRL-02.
- **Material-fact admission:** CORE-04.
- **Profile resolution by interpretation:** INTEL-02.
