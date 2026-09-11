# Current State: Frontera as an Authority-Control Platform

- Status: measurement, not proposal
- Measured against: working tree at branch `claude/inspiring-archimedes-goazf9`,
  root package `@aoc-enterprise/runtime@1.2.1`, Node 22, `@aoc/protocol@0.2.0-rc.1`
- Baseline suite at time of measurement: `npm test` → **5666 tests, 1038 suites,
  0 failures** (exit 0)
- Companion documents: `TARGET_AUTHORITY_CONTROL_ARCHITECTURE.md` (proposal),
  `ADR-AUTHORITY-CONTROL-LAYERING.md`, `ADR-CONTEXT-PROVENANCE-AND-TRUST.md`,
  `ADR-OBLIGATION-DISCHARGE-AND-BOUNDED-GRANT.md`,
  `ADR-DETERMINISTIC-AUTHORIZATION-AI-BOUNDARY.md`

## 0. One correction to the framing, recorded before anything else

The evolution brief describes the current implementation as "XRPL Sovereign
Access". **There is no XRPL code, dependency, adapter, identifier or document
anywhere in this repository**, and there never has been on this history — a
case-insensitive search across every `.ts`, `.md`, `.json` and `.mjs` outside
`node_modules` returns zero hits for `xrpl`, `sovereign access` and
`sovereign-access`.

What exists instead, and what the rest of this document treats as the real
starting point:

- The **Sovereign Access lifecycle** is implemented as a chain of eight
  provider-neutral contract packages (`resource-envelope` → `scoped-access` →
  `access-decision` → `access-obligation` → `access-grant` →
  `grant-revocation` → `usage-event` → `evidence-correlation`), orchestrated by
  `src/enterprise/access-governance/`.
- The one **ledger-adjacent provider adapter** is Pinata/IPFS
  (`@aoc-enterprise/pinata-adapter`, `src/enterprise/content-protection/`),
  reached through the generic `@aoc-enterprise/provider-adapter` contract.
- The phrase "sovereign" appears as `docs/architecture/sovereign-runtime-vault-boundary.md`
  and `src/runtime/vault/` — a key/secret isolation boundary, unrelated to any
  ledger.

This matters for the migration plan: there is no chain-specific coupling to
generalize away from. The generalization work is about *layers that were never
named*, not about *a ledger that must be abstracted*.

The second correction is more consequential and more welcome: **Frontera is
already much closer to the target thesis than the brief assumes.** It already
refuses to be an IAM, already produces deterministic fail-closed decisions,
already keeps AI out of the decision path, and already carries most of layers
A, B, E, F in working, tested code. The gaps are real but they are four
named holes in a standing structure, not a rewrite.

---

## 1. Topology

```
@aoc/protocol (external, pinned tarball, separate legal regime)
        ↓ upward composition only
packages/*        36 workspace packages — contracts, SDKs, adapters
src/              the Enterprise runtime
  kernel/         AocKernel — the single component that produces a decision
  features/       the engines the Kernel reaches through ports
  enterprise/     composition root, stores, HTTP host, governed actions
  runtime/        legacy runtime façade (enforcement, audit, crypto, vault,
                  federation, persistence, state)
  adapters/
apps/*            agent-passport-web (Next.js); four empty placeholders
docs/architecture/  36 ADRs + 5 CURRENT_STATE_* documents + guidance
```

Enforcement of the topology is mechanical, not advisory:
`scripts/lint-architecture.mjs` (no explicit `any`, no wildcard exports in
runtime internals), `scripts/lint-public-surface.mjs`,
`scripts/check-aoc-boundaries.mjs`, `scripts/check-api-freeze.mjs`,
`scripts/check-protocol-consumption.mjs`, and a structural-boundaries test
suite. Any target architecture must survive these unchanged.

---

## 2. The decision path as it exists today

```
HTTP POST /api/governance/evaluate
  → validateGovernanceEvaluateRequestBody      (shape only)
  → toKernelEvaluationRequest                  (1:1 adaptation)
  → AocKernel.evaluate()
      ├─ resolveGovernedConstraintContext()    ← optional port, FACTS ONLY
      ├─ AocGuard.preflight()
      │    └─ ActionEnforcementRuntime — fixed 13-policy chain, fixed order:
      │         emergency_deny
      │         recognition_required        → RecognitionProvider
      │         allow_decision_required
      │         approval_pending
      │         evidence_required
      │         external_standing
      │         adapter_permission
      │         domain_policy_pack          → PolicyPackProvider
      │         idempotency
      │         execution_timeout
      │         side_effect_boundary
      │         dry_run
      │         post_execution_record
      ├─ applyGovernedAuthorityStep()          ← optional port, NARROWS ONLY
      └─ assertKernelInvariants()
  → GovernanceStore commit (canonical JSON, aggregate digest)
  → GovernanceEvaluateResponseBody
      { decisionId, status, reasonCodes, summary, trace, governanceRecord }
```

`status` is a closed set: `allowed` | `denied` | `approval_required` |
`indeterminate`, mapped to HTTP 200 / 422 / 200 / 503. A governance denial is
explicitly *not* an infrastructure error.

Behind `RecognitionProvider` sit, transitively, four deterministic engines:

| Engine | Question it answers | Shape |
| --- | --- | --- |
| Recognition Runtime | is this actor recognized, and does a capability token cover this action over this scope? | 10-policy fixed chain, hash-chained `AuditEvent` ledger |
| Authority Graph | where did that capability come from, and does the lineage still hold? | grants/delegations/role assignments, lineage re-derived per verification, attenuation-only |
| Approval Runtime | who may approve, did they, and does the proof still count? | requirement → request → decision → proof, quorum, approver authority checked via Authority Graph |
| External Agent Handshake | may an actor from another trust domain enter at all? | issuer/passport/scope/risk validation → bounded visa |

None of them call a model. Every one is a pure function of typed records, an
injected clock and an injected id generator, and each has determinism tests
that assert the absence of network/LLM/OCR/`Math.random()`/argless `new Date()`.

### 2.1 Properties already guaranteed, and worth not losing

1. **One decision producer.** `AocKernel` is the only class in the system that
   returns a decision. Every optional port either supplies facts or narrows an
   outcome; none can widen one. This is stated in `AocKernel`'s own doc
   comments and pinned by `assertKernelInvariants` and the characterization
   suite under `src/kernel/__tests__/characterization/`.
2. **Fail-closed everywhere it matters.** A throwing policy-pack integration, a
   malformed integration result, an unclassifiable constraint, an undeclared
   action profile, a failed recognition provider — each resolves to denial or
   `indeterminate`, never to "no constraint applies".
3. **Deterministic policy evaluation.** `PolicyConditionEvaluator` uses a closed
   operator set over a closed field set. No `eval`, no `new Function`, no regex,
   no model call.
4. **Inspectable decisions.** `KernelTrace` carries an ordered step list;
   `GovernanceStore` commits a canonical-JSON record with an aggregate digest;
   `EvidenceBundle` projects that record under a disclosure policy and binds
   `bundleDigest`, `recordDigest` and the policy identity into one
   `verificationDigest`.
5. **A working precedent for trusted context.** `GovernedConstraintProvider`
   resolves facts *server-side, before* the synchronous engine runs, and injects
   them into policy input under the namespaced key `aoc.governedConstraints`.
   It reports `resolved: false` on failure rather than an empty set, so a policy
   can distinguish "none stand" from "none were read". This is, in miniature,
   the entire Context layer the target architecture asks for.
6. **A working precedent for refusing self-assertion.**
   `src/kernel/orchestration/request-adapter.ts` reserves `organizationId` and
   `organizationName`: a caller-supplied value of either is *deleted* from the
   context bag and re-derived from the typed `organization` field, with a
   comment stating exactly why — "otherwise reading a claim the requester wrote
   about itself, which is exactly the self-assertion the governance boundary
   exists to prevent."

Point 6 is the single most important finding in this document. The repository
has already identified the self-assertion problem, already solved it correctly,
and solved it **for exactly two field names**. The target architecture is
largely the generalization of that one `delete`.

---

## 3. Domain inventory

### 3.1 The Sovereign Access lifecycle (packages, contracts-only)

| Package | Owns |
| --- | --- |
| `resource-envelope` | the governed resource: location, integrity, lifecycle state |
| `scoped-access` | `EnterpriseScopedAccessRequest` — principal, resource, requested scope, requested-at, optional action |
| `access-decision` | immutable record of a completed evaluation: request + resource + `allow`/`deny`/`conditional` + `policyEvaluationRef` + `evidenceRefs` |
| `access-obligation` | a condition attached to a decision, referenced by opaque `decisionRef`; closed type vocabulary (`require-approval`, `require-mfa`, `record-usage`, `watermark-content`, `read-only`, `time-limit`, `no-download`, `require-acceptance`) |
| `access-grant` | immutable record of an issued authorization; carries **no** credential, token, signed URL or session |
| `grant-revocation` | immutable record that a grant was revoked |
| `usage-event` | that a grant was exercised; closed event vocabulary |
| `evidence-correlation` | the graph linking all of the above by opaque id |

Every one of these is pure data with validation, identity equality, structural
equality and deterministic serialization. None performs evaluation, persistence,
execution or provider I/O. That discipline is the reason this layer generalizes
cheaply.

### 3.2 Runtime engines (`src/features/`)

`action-enforcement` (the wrapped engine and its 13 policies, proof/ledger/
idempotency/side-effect services, and the `AocGuard`/`tool-call`/`api-handler`/
`webhook`/`workflow-step` SDK guards), `recognition-runtime`, `authority-graph`,
`approval-runtime`, `external-agent-handshake`, `domain-policy-pack-runtime`,
`policy-pack-foundation`, `evidence-source-runtime`, `verifiable-export-package`,
`aoc-control-plane` (React), `aoc-enterprise-demo`, `aoc-enterprise-pilot-template`,
`aoc-integrations`.

### 3.3 Enterprise services (`src/enterprise/`)

Composition root with a module registry and dependency graph; configuration with
a redacted public view; `node:http` adapter and host; health/live/ready;
telemetry, logging and events; `governance-store` (canonical JSON, digests,
projection, redaction, reference integrity, in-memory + better-sqlite3);
`evidence` (bundle projector, verifier, disclosure policies, store);
`passport`; `assurance` (SAF framework registry, controls, signals, scoring,
findings, eligibility, report); `access-governance`; `authority-governance`
(positions, capacity, reservations, encumbrances, representations, constraint
applicability); five mandate domains (`license`, `transfer`, `tokenization`,
`collateralization`, `encumbrance-release`); `content-protection` (AEAD, AAD,
key-wrapping port, sovereign-binding port, Pinata storage adapter);
`kernel-authority` (durable authority store + trusted-operator provisioning).

### 3.4 Frozen HTTP surface

`GET /health`, `/live`, `/ready`; `POST /api/governance/evaluate`,
`/api/evidence/build`, `/api/evidence/verify`, `/api/assurance/*`,
`/api/passports*` — 27 endpoints frozen in `release/api-surface.v1.json` and
guarded by `scripts/check-api-freeze.mjs`.

### 3.5 Frontend

`src/features/aoc-control-plane` is a read-only React surface over view models
(overview, recognition, authority, approvals, enforcement, policy packs, proofs,
external agents). `apps/agent-passport-web` is a Next.js product surface
(passports, checkout, account, registries). `apps/agent-gateway`,
`apps/audit-console`, `apps/dashboard`, `apps/policy-engine` are empty
placeholders.

---

## 4. Mapping the current state onto the target lifecycle

Target: `request → authority → context resolution → policy evaluation →
obligations → bounded grant → action → revocation/expiry → evidence`.

| Stage | Status | Where it lives |
| --- | --- | --- |
| request | **present** | `KernelEvaluationRequest`, `EnterpriseScopedAccessRequest`, `POST /api/governance/evaluate` |
| authority | **present but fragmented** | Recognition Runtime, Authority Graph, Kernel Authority Store, Governed Authority — four engines, four shapes, no single resolved "authority" result |
| context resolution | **absent as a stage** | facts arrive as `ActionDescriptor` scalars from the caller; the one resolved channel is `GovernedConstraintProvider` |
| policy evaluation | **present, under-powered** | `domain-policy-pack-runtime`; deterministic but cannot express derived or aggregate values |
| obligations | **declared, never discharged** | `PolicyObligation`, `EnterpriseAccessObligation`; `PolicyObligationService.collect()` groups them and nothing else |
| bounded grant | **present, unlinked** | `AccessGrantService.issueGrant()` takes a caller-supplied `decisionRef` string; nothing verifies it |
| action | **present** | `AocKernel.enforce()`, `AocGuard`, adapter registry, side-effect ledger, post-execution record |
| revocation / expiry | **partial** | `revokeGrantRequest` + Pinata enforcement; no expiry sweep, no context-change invalidation |
| evidence | **present, incomplete coverage** | `GovernanceStore`, `EvidenceBundle`, `evidence-source-runtime`, `verifiable-export-package` — decisions are covered; context, obligation discharge and revocation are not first-class in the same graph |
| intelligence | **absent, and correctly so** | no AI anywhere in the decision path; also no declared place for it |

---

## 5. Gap analysis

### GAP-1 — There is no Context layer, and the facts policy decides on are the requester's own claims

`ActionDescriptor` carries `amount`, `currency`, `counterpartyId`, `customerId`,
`jurisdiction`, `country`, `industry`, `domain`, `dataDomains`, `evidenceIds`.
Every one of them is copied from the HTTP request body into
`PolicyEvaluationInput` without any check of where the value came from.

So today a rule reading `amount <= 10000` is evaluated against *the number the
caller put in the request*. For an internal, trusted, already-authenticated
caller that may be acceptable. For the target thesis — governing authority
**across a system boundary** — it is not: the boundary is exactly where the
claim stops being trustworthy.

Severity: **highest**. Every other gap is survivable; this one silently
undermines the product thesis.

Mitigating precedents already in the tree: the `organizationId` reservation
(§2.1 point 6) and `GovernedConstraintProvider` (§2.1 point 5).

### GAP-2 — Provenance and trust are not modelled at all

Nothing anywhere records, for a fact used in a decision: its source, the time it
was observed, its freshness bound, whether it was signed, or whether the
requesting actor could have influenced it. `EvidenceProvenance` exists but
describes the provenance of *the evidence projection*, not of the facts.

The consequence is that even where a fact *is* resolved correctly today, an
auditor cannot tell it apart from one that was asserted.

### GAP-3 — The policy language cannot express the target examples

Measured against the brief's own two examples:

| Clause | Expressible today? | Why |
| --- | --- | --- |
| `amount <= 10000` | yes, but against an asserted value | `PolicyPredicateField.amount` + `less_than_or_equal` |
| `vendor.status == approved` | only via `metadata.vendor.status` | `PolicyPredicateField` is a closed union with no `vendor`; metadata is an untyped bag with no provenance |
| `invoice.status == approved` | same | same |
| `monthlyVendorSpend + amount < 50000` | **no** | no arithmetic, no aggregation, no derived values, no cross-record reads |
| `REQUIRE finance approval IF amount > 25000` | yes | `require_approval` effect + `PolicyApprovalRequirement` |

Two distinct sub-gaps: (a) no *derived value* concept, (b) adding a business
fact requires editing a core closed union in the evaluator rather than
declaring a resolver.

### GAP-4 — Obligations are declarations with no lifecycle

`PolicyObligation` and `EnterpriseAccessObligation` describe what must happen.
`PolicyObligationService.collect()` deduplicates them in first-seen order. There
the story ends: there is no `issued → pending → discharged → verified → expired`
state, no record of who discharged one, no proof, and — critically — no grant
that is conditioned on discharge. The target lifecycle's `obligations if
required → bounded grant` edge does not exist in code.

### GAP-5 — Decision and grant are joined by an unverified string

`AccessGrantService.issueGrant()` accepts `decisionRef: string`. Nothing
verifies that the referenced decision exists, that it concluded `allowed`, that
the grant's resource matches the decision's resource, that the grant's scope is
within the decision's evaluated scope, or that the grant's `expiresAt` is within
anything the decision bounded. A caller holding grant-issuance rights can mint a
grant citing a decision that denied.

### GAP-6 — "Authority" is four things with no single answer

Recognition (passport + capability token), Authority Graph (lineage),
Kernel Authority Store (durable, organization-scoped), Governed Authority
(rights-scoped positions and capacity). All four are correct and all four are
needed. None of them produces a single, named, storable *authority resolution*
that a decision, a grant and an evidence bundle can all cite. `KernelEvaluationResult.authority`
is the closest thing and it carries only the governed-authority slice.

### GAP-7 — Evidence coverage stops at the decision

The decision, its trace and its digest are recorded and projectable. Context
facts (because they do not exist as records), obligation discharge (because it
does not exist), and revocation (recorded, but not correlated into the same
bundle graph) are not.

### GAP-8 — Revocation and expiry are issue-time only

`revokeGrantRequest` is authenticated and drives provider enforcement for
Pinata. There is no periodic expiry sweep, no propagation to non-Pinata
providers beyond the adapter contract, and no mechanism by which a change in
resolved context (a vendor moving to `suspended`) invalidates a live grant.

### GAP-9 — There is no declared AI boundary at platform level

Individual modules assert "no LLM" in prose and pin it with determinism tests.
There is no architectural statement of where AI may sit, what it may produce,
what it may never produce, and how its output is prevented from reaching the
decision path. Absent that statement, the first `intelligence` module added is
an unbounded risk.

### GAP-10 — No operator surface for the new layers

The control plane is read-only view models over recognition/authority/approval/
enforcement/policy/proofs. Context sources, provenance, obligation state and
advisory output have no surface, and `apps/agent-gateway`, `apps/audit-console`,
`apps/dashboard` and `apps/policy-engine` are empty.

---

## 6. Reuse versus generalization

**Reuse unchanged — no refactor justified.**

- `AocKernel`, its contracts, invariants, reason codes and characterization suite
- the 13-policy enforcement chain and its fixed precedence
- Recognition Runtime, Authority Graph, Approval Runtime, External Agent Handshake
- `PolicyConditionEvaluator`'s operator semantics and determinism guarantees
- the eight Sovereign Access contract packages
- `GovernanceStore`, canonical JSON, digests, reference integrity, redaction
- `EvidenceBundle`, disclosure policies, verification digests
- `evidence-source-runtime`, `verifiable-export-package`
- the provider adapter / translation / conformance-suite contracts
- all five governed-authority mandate domains and the constraint applicability model
- persistence: both store implementations and every store-contract suite

**Generalize — additively, behind optional ports.**

- `ActionDescriptor`'s business fields → resolved, provenanced context facts
- `PolicyPredicateField` → a field set open to declared resolvers
- `PolicyObligation` → an obligation with a lifecycle and a discharge record
- `issueGrant(decisionRef: string)` → a grant derived from a verified decision
- the four authority engines → one `AuthorityResolution` they each contribute to
- `EvidenceBundle` subjects → context, obligation and revocation as first-class

**Introduce — genuinely new.**

- the Context layer (sources, resolvers, provenance, trust classes, freshness)
- the Obligation lifecycle
- the Intelligence layer, and the hard boundary around it

**Do not touch.**

- `@aoc/protocol` — separate repository, separate legal regime, pinned artifact
- the frozen v1 HTTP surface, except additively under a new path
- any store schema identifier, except through the existing migration review
- the `runtime/` legacy façade's public behaviour

---

## 7. Measurement conditions

Every claim above was read from source at the commit under measurement. The
baseline suite was run before and after this document was written, with
identical results: 5666 tests, 1038 suites, 0 failures, exit 0. No source file
was modified to produce this document.
