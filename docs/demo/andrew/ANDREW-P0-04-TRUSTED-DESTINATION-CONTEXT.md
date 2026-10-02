# ANDREW-P0-04 — Trusted Destination Context

| | |
| --- | --- |
| Task | ANDREW-P0-04 — Andrew Demo — Trusted Destination Context |
| Branch | `feat/andrew-p0-04-trusted-destination-context` |
| Baseline | `bfc05065a37b45478e5c740ad8173dab2dd2d940` (`feat/andrew-demo`, P0-00 … P0-03 merged) |
| Status | Implemented, uncommitted, not pushed |

> **A request may name a destination. Whether that destination is known, and
> whether this organization has approved it, is read from the registry and the
> approval store — and reaches policy only as admitted trusted context.**
> P0-04 adds no destination policy: an unapproved destination still produces
> no HOLD / DENY anywhere. That is ANDREW-P0-05.

## 1. Objective

Make trusted context able to carry, for a governed action that names a
destination:

| fact | meaning | source |
| --- | --- | --- |
| organization | the organization the request is made in | bound customer identity (`request.organization.id`), never the request body |
| `destination.key` | canonical `<namespace>:<identifier>` | P0-01 `executionDestinationKey` |
| `destination.known` | registry membership | P0-02 `DestinationRegistryReaderPort.lookup` |
| `destination.approvalState` | `never-approved` \| `approved` \| `expired` \| `revoked` | P0-03 `DestinationApprovalReaderPort.read` |
| `destination.approved` | active approval of a known destination | derived: `known && isDestinationApprovalActive(state)` |

…through the one Trusted Context Boundary policy already reads, failing closed
whenever registry or approval truth cannot be established.

## 2. Starting Baseline

| check | result |
| --- | --- |
| path | `/mnt/c/Users/Usuario/source/Republika-Network/Frontera-andrew-p0-04` |
| branch | `feat/andrew-p0-04-trusted-destination-context` |
| working tree | clean |
| `HEAD` | `bfc0506` = `feat/andrew-demo` (`merge: Andrew P0-03 destination approval`) |
| P0-01 | `src/features/destination-runtime/domain/` |
| P0-02 | `src/features/destination-runtime/registry/`, `src/enterprise/destination-registry/` |
| P0-03 | `src/features/destination-runtime/approval/`, `src/enterprise/destination-approval/`, `ANDREW-P0-03-DESTINATION-APPROVAL.md` |

As in P0-00..P0-03, the worktree's `.git` file points at a Windows path WSL
`git` cannot resolve, so git was run read-only with Windows Git (`git.exe`);
the pointer was not modified. Toolchain: WSL2 Linux, Node v22.23.1, `npm ci`.

**P0-00 limitation confirmed before changing anything:**
`ContextResolutionQuery` carried `keys, actorId, trustDomainId, action,
resourceScope, organizationId?, targetId?, at` — no counterparty, amount or
destination — and the governed path never sets `targetId`. A resolver could not
be asked about *this* request's destination.

## 3. Existing Trusted-Context Architecture

| question | answer (unchanged by P0-04 unless stated) |
| --- | --- |
| query type | `ContextResolutionQuery` (`context-resolution-runtime/domain/context-resolver-port.ts`) — typed request identity, no free-form bag. **P0-04 adds `counterpartyId?`.** |
| result type | `ContextResolverOutput { observations }` — readings only, no trust class, no verdict |
| resolver interface | `ContextResolverPort` = Kernel `ContextProvider`; **async** (`Promise`) |
| organization | `request.organization.id`; on the governed path built from `BoundCustomerIdentity` by `boundScopeOf` (must equal the served organization) |
| actor | `request.actor.id` from the bound identity |
| monetary / authority context | not context facts: request `amount`/`currency` and the Kernel Authority / financial authority resolver |
| how policy receives it | `resolveKernelContextFacts(...).admitted.contextFacts` → policy input `contextFacts` → `contextFact` predicates |
| unavailable / error | a throw or malformed provider result ⇒ `resolved: false`; a key with no admissible reading ⇒ `unresolved`; a required key not `satisfied` ⇒ `CONTEXT_REQUIRED_FACT_*` denial |
| fail-closed | material facts are `required: true`; missing, stale, conflicted, refused or under-trusted denies before policy outcome stands |
| facts typing | flat, namespaced fact classes (`invoice.exists`), values `string \| number \| boolean` |
| ordering | admitted facts sorted by class; resolution digested deterministically |
| composition | one `ContextProvider` per Kernel; many configured `ContextSource`s attribute readings |
| enterprise stores | providers are trusted in-process composition (`BootEnterpriseHostOptions.contextProvider`), free to read stores |

Admission (`ContextResolutionService.classify`) checks per reading: configured
source, source authorized for that fact class, organization equals the
request's, `reference-digest` provenance recomputes, not future-dated, value
admissible, fresh.

## 4. Destination Context Model

`src/enterprise/trusted-context/destination-context.ts`:

```ts
interface TrustedDestinationContext {
  organizationId: string;
  destination: ExecutionDestination;          // frozen, P0-01
  destinationKey: string;                     // executionDestinationKey(destination)
  destinationKnown: boolean;
  destinationApprovalState: 'never-approved' | 'approved' | 'expired' | 'revoked';
  destinationApproved: boolean;               // known && state === 'approved'
  approvalSequence?: number;                  // provenance of the state
}

type TrustedDestinationResolution =
  | { kind: 'resolved'; context: TrustedDestinationContext }
  | { kind: 'unavailable'; reason: TrustedDestinationUnavailableReason };
```

- `resolveTrustedDestinationContext(readers, { organizationId, destination })` —
  synchronous (both ports are), never throws.
- `createDestinationContextProvider({ organizationId, sourceIds, registry, approvals, onUnavailable? })`
  — the `ContextProvider`, answering only the destination fact classes asked for.
- `DESTINATION_CONTEXT_FACT_CLASSES` — `destination.key`, `destination.known`,
  `destination.approvalState`, `destination.approved`.

The rich state is preserved (`approvalState`) **and** the one safe boolean is
derived (`approved`), so policy can say "only `approved` passes" and audit can
still tell revoked from expired from never-approved.

## 5. Trusted Organization Scope

The organization is **never** read from the request body:

1. The intake is closed: `organizationId`/`organization` at top level are
   undeclared properties (400), and are reserved keys inside `assertedContext`.
2. `buildGovernedActionKernelRequest` sets `request.organization.id` from the
   `BoundCustomerIdentity` only, after `boundScopeOf` requires it to equal the
   Host's served organization.
3. The Kernel context adapter copies that into `query.organizationId`.
4. The provider is composed with the served organization and answers nothing
   (`ORGANIZATION_UNBOUND`) when the query's organization is absent or different.
5. Each reading states that organization; the boundary refuses a reading whose
   organization differs from the request's (`organization_mismatch`) and a
   source configured for another organization.

## 6. Registry Resolution

`destination.known` comes from `registry.lookup(destination)` and nothing else.
The answer is accepted only if it describes exactly the destination asked about
(`unknown` with the same key; `known` with the same key and the same
`namespace`/`identifier`); anything else is `REGISTRY_CORRUPT`. Resolution never
registers: asking about an unknown destination leaves it unknown (tested).

## 7. Approval Resolution

`destination.approvalState` comes from
`approvals.read({ organizationId: <bound org>, destination })` and nothing else.
The answer is accepted only if every record in it names the same organization
and destination key (and a revocation names the approval it ended); anything
else is `APPROVAL_CORRUPT`. Expiry is the store's own derivation at its clock
(`now >= expiresAt`); with the Host's clock both coincide. No history walk, no
approve, no revoke.

## 8. Fail-Closed Semantics

| condition | resolver result | provider | boundary / Kernel |
| --- | --- | --- | --- |
| registry closed / unreadable | `REGISTRY_UNAVAILABLE` | no destination reading | keys `unresolved` → `CONTEXT_REQUIRED_FACT_UNRESOLVED` |
| registry damaged / wrong record | `REGISTRY_CORRUPT` | none | same |
| approval store closed / unreadable | `APPROVAL_UNAVAILABLE` | none | same |
| approval history damaged / wrong record | `APPROVAL_CORRUPT` | none | same |
| registry `unknown` + any approval history | `GOVERNANCE_INCONSISTENT` | none | same |
| no / non-canonical counterparty | `DESTINATION_UNDETERMINED` | none | same |
| query organization absent or ≠ served | `ORGANIZATION_UNBOUND` | none | same |
| unexpected throw | `RESOLUTION_FAILED` | none | same |
| reading altered after its digest | — | — | refused `provenance_invalid` |

Facts are all-or-nothing: on any failure the provider withholds *every*
destination fact, so `known` is never reported alone beside a missing approval.
`onUnavailable` reports the reason to operators; it is never consulted for a
decision and its failure is ignored.

**Registry / approval consistency.** P0-03 refuses to approve a destination the
registry does not know, and the registry has no delete, so approval history for
an unknown destination cannot arise through valid APIs. It can arise from
tampering or from composing the approval store against a different registry
file (tested with an independent registry): it is withheld, never "approved".

## 9. Request vs Trusted Facts

```
REQUEST INTENT   counterparty = "network-a:abc123"         (allowed: names the destination)
      ↓
IDENTITY         parseExecutionDestination + exact key round-trip (P0-01)
      ↓
TRUSTED LOOKUPS  registry.lookup  ·  approvals.read(bound org)
      ↓
TRUSTED CONTEXT  readings → Trusted Context Boundary (source, org, digest, freshness)
      ↓
POLICY           contextFacts: destination.known / .approvalState / .approved / .key
```

What a request cannot do, each tested:

| attempt | result |
| --- | --- |
| top-level `destinationKnown`, `known`, `approved`, `destinationApproved`, `approvalStatus`, `approvalState`, `registered`, `trusted`, `destination`, `governance: { destination: { approved } }` | 400 — undeclared property, nothing evaluated |
| top-level or asserted-context `organizationId` / `organization` | refused |
| `assertedContext.destination.approved` (a declared fact class) | 400 — fact classes are reserved |
| `assertedContext.{destinationApproved, approved, approvalState, governance…}` | accepted as evidence, **never a fact**: policy still sees the independently resolved value |
| forging a reading's value after its provenance digest | refused at the boundary |

### Example A

```
Request:  counterparty = network-a:abc123        (org bound: org-A)
Trusted:  organization = org-A
          destination.known = true
          destination.approvalState = approved
          destination.approved = true
```

### Example B

```
Request:  counterparty = network-a:xyz789
Trusted:  organization = org-A
          destination.known = true
          destination.approvalState = never-approved
          destination.approved = false
```

### Example C

```
Request attempts:  destinationApproved = true
Result:            400 undeclared property (top level), or ignored as unverified
                   asserted context; destination.approved is still resolved from
                   the approval store.
```

### Example D

```
Approval store corrupt / unavailable
Result:  no destination reading; required keys unresolved;
         decision denied CONTEXT_REQUIRED_FACT_UNRESOLVED; zero adapter calls.
         NOT destination.approved = false.
```

## 10. Policy-Facing Facts

Policy reads admitted facts with the existing `contextFact` predicate, so P0-05
can write, without any store access in policy:

```ts
{ type: 'predicate', field: 'contextFact', factClass: 'destination.known',    operator: 'not_equals', value: true }
{ type: 'predicate', field: 'contextFact', factClass: 'destination.approved', operator: 'not_equals', value: true }
```

A deployment adopts the facts by configuration only:

```jsonc
// Governance Profile
"materialFacts": ["destination.approvalState", "destination.approved", "destination.key", "destination.known"]
// trustedContext.sources
{ "sourceId": "destination-registry", "kind": "internal_store",  "trustClass": "authoritative", "organizationId": "<served org>",
  "attests": [{ "factClass": "destination.key", "maxAgeSeconds": 900 }, { "factClass": "destination.known", "maxAgeSeconds": 900 }] },
{ "sourceId": "destination-approval", "kind": "approval_system", "trustClass": "authoritative", "organizationId": "<served org>",
  "attests": [{ "factClass": "destination.approvalState", "maxAgeSeconds": 900 }, { "factClass": "destination.approved", "maxAgeSeconds": 900 }] }
```

```ts
// trusted in-process composition (BootEnterpriseHostOptions.contextProvider)
contextProvider: createDestinationContextProvider({
  organizationId: servedOrganizationId,
  sourceIds: { registry: 'destination-registry', approval: 'destination-approval' },
  registry,      // DestinationRegistryReaderPort — only `lookup` is kept
  approvals,     // DestinationApprovalReaderPort — only `read` is kept
})
```

Material facts are `required`, so an unavailable store denies before any
destination-dependent rule could be skipped. The committed decision records
provenance (source, reference, digest), never values.

## 11. Counterparty Relationship

**Where destination identity enters.** The smallest safe extension was the
typed `counterpartyId` already on the Kernel request: P0-04 forwards it into
`ContextResolutionQuery.counterpartyId` (one optional field, one line in the
Kernel context adapter). The Kernel and the context runtime stay
destination-neutral; only the composed provider interprets it.

**Why counterparty, not a new typed intent field.** The counterparty is the
value the grant binds exactly (`{ kind: 'identity' }`) and the adapter
receives. Deriving the facts from it means the decision's destination facts are
about *exactly* what is later bound and executed — no grant change. A separate
`destination` intent field, unbound to the grant, would let a request state an
approved destination D and a counterparty E and be executed toward E; closing
that needs either an intake equality rule or a grant axis, which are
grant-binding decisions this task must not make. It would also widen the
HTTP intake, SDK types and API-freeze surface.

**Why parsing it is safe here.** The provider accepts a counterparty only when
it is *exactly* a canonical key: split at the first `:` (a namespace cannot
contain one), parsed by `parseExecutionDestination`, re-keyed, and compared for
identity. No trimming, folding or repair; two counterparties never designate
one destination. A counterparty that is not a key designates nothing and is
withheld (deny). A legacy free-form counterparty that happens to have key shape
is looked up as that exact key and is `unknown` unless an operator registered
*and* approved that exact string for this organization — misinterpretation can
only fail toward not-approved. Interpretation is opt-in: a deployment that does
not compose the provider is unaffected.

**Not final.** If ANDREW-P0-05+ chooses a dedicated destination grant axis,
`destinationFromCounterparty` is the one function to replace.

## 12. Security Invariants

| # | invariant | how |
| --- | --- | --- |
| 1 | request can name destination intent | `counterparty`, unchanged |
| 2 | request cannot assert governance truth | closed intake; reserved fact classes; facts only from configured sources |
| 3 | organization scope is trusted | bound identity → `request.organization.id`; provider bound to the served org; boundary org check |
| 4 | membership only from the registry reader | `lookup` only; structural test |
| 5 | approval only from the approval reader | `read` only; structural test |
| 6 | active approval is organization-scoped | `read({ organizationId: bound org })`; record org verified |
| 7 | A's approval never becomes B's | tested on resolver, provider and Host |
| 8 | corruption / unavailability is never false or true | all-or-nothing withholding → `unresolved` → deny |
| 9 | approval without known membership fails closed | `GOVERNANCE_INCONSISTENT` |
| 10 | identity canonical and immutable | P0-01 ingress + exact round-trip; frozen |
| 11 | policy never touches persistence | structural test over policy/enforcement code |
| 12 | grants unchanged | no grant file touched; adapter receives the same counterparty |
| 13 | execution unchanged | no execution file touched |

## 13. Structural Boundaries

`src/enterprise/__tests__/trusted-destination-context-structure.test.ts`:

- the provider imports exactly: context runtime, destination identity, registry
  reader, approval reader, the Kernel port **type**, `node:crypto`;
- no XRPL / rail / wallet / signer / execution / adapter / grant / HTTP /
  SQL / `better-sqlite3` / durable store module / administration service;
  no ambient clock or randomness;
- no `.register(`, `.approve(`, `.revoke(`, `.history(`, `.close(`;
- typed as `Pick<DestinationRegistryReaderPort, 'lookup'>` and
  `Pick<DestinationApprovalReaderPort, 'read'>`; no write port or authority type
  named; at runtime only bound `lookup`/`read` functions are retained;
- P0-01 keying only, no normalization, no hand-spelled key;
- no verdict vocabulary;
- policy / enforcement code imports no destination runtime, store or trusted-context;
- the Kernel and the context runtime never mention destinations;
- P0-02/P0-03 code never imports context resolution;
- the intake's closed key set is unchanged;
- the query's field list is exactly the previous one plus `counterpartyId`,
  still with no free-form bag;
- not on `src/enterprise/index.ts`, any HTTP route, adapter or Host file.

## 14. Tests

| file | tests | covers |
| --- | --- | --- |
| `src/enterprise/__tests__/trusted-destination-context.test.ts` | 29 | matrix A–E on real SQLite stores; expiry −1 ms / exact / later; org A vs B; key consistency; namespaces; case; strict counterparty parsing; registry/approval unavailable; corrupt registry row; deleted revocation; independent registry (UNKNOWN + ACTIVE, and + revoked); readers answering about another destination/org/invented state; typed vs unexpected errors; malformed destination/org read nothing; provider withholds for undetermined destination / unbound or other org; failing hook; intake refusals; smuggled request context; forged reading after digest; read-only spies + unchanged row counts and history; only read functions retained; fact attribution, org, digest, reference bound; only asked keys; Kernel forwards counterparty; composition refusals — all through the real Kernel context path |
| `src/enterprise/__tests__/trusted-destination-context-host.test.ts` | 10 | canonical shipped Host, HTTP → admission → Kernel → policy input: Examples A–D; org isolation over one store; unknown not registered by asking; 11 forged top-level fields → 400 with zero evaluations; asserted-context claims ignored; fact class refused; registry/approval closed → `CONTEXT_REQUIRED_FACT_UNRESOLVED`, zero adapter calls; non-key counterparty denied; adapter receives the same counterparty |
| `src/enterprise/__tests__/trusted-destination-context-structure.test.ts` | 12 | §13 |

The Host test's policy is a recorder around a rule that never matches: it
proves what policy *sees*, and adds no destination outcome.

Results: see §18a.

## 15. Files Changed

| file | change |
| --- | --- |
| `src/features/context-resolution-runtime/domain/context-resolver-port.ts` | `ContextResolutionQuery.counterpartyId?` (documented as request intent) |
| `src/kernel/orchestration/context-adapter.ts` | forwards `request.action.counterpartyId` into the query (one spread) |
| `src/enterprise/trusted-context/destination-context.ts` | new — resolver, provider, fact classes, reasons |
| `src/enterprise/trusted-context/index.ts` | exports the above (module barrel; not on `src/enterprise/index.ts`) |
| `src/enterprise/__tests__/trusted-destination-context.test.ts` | new |
| `src/enterprise/__tests__/trusted-destination-context-host.test.ts` | new |
| `src/enterprise/__tests__/trusted-destination-context-structure.test.ts` | new |
| `docs/demo/andrew/ANDREW-P0-04-TRUSTED-DESTINATION-CONTEXT.md` | new — this document |

Not changed: P0-01/02/03 code, intake (`intent.ts`, `contracts.ts`,
`kernel-request.ts`), grant runtime / adapter / issuance / verification, signed
artifacts, execution runtime and adapters, Host configuration and boot, HTTP
routes, `release/api-surface.v1.json`, SDK packages, policy runtime,
`package.json`.

## 16. Explicitly Out of Scope

The $75k / Andrew policy; HOLD vs DENY for unknown or unapproved destinations;
amount thresholds; reevaluation or resume of a held action; grant binding of a
destination axis; Host-level composition of the registry/approval database
paths (the provider is composed by the embedder through the existing
`contextProvider` option); a provider combinator for deployments needing
destination facts alongside other fact families from one provider; HTTP /
console routes; XRPL, Testnet, signing, transaction building, address
validation, ledger access, payment submission.

## 17. Impact on ANDREW-P0-05

P0-05 can proceed once the aggregate root run is confirmed (§18). It needs to:

1. Declare the four fact classes as material facts of the Andrew profile and
   configure the two `authoritative` sources (§10).
2. Compose `createDestinationContextProvider` with the durable registry and
   approval store (and pick their file paths in the demo harness).
3. Write the policy rules on `destination.known` / `destination.approved` and
   the amount, and decide HOLD (`require_approval`) vs DENY.
4. Keep the counterparty equal to the destination key in requests; revisit if a
   dedicated grant axis is chosen.

Carried forward: same-action reevaluation after approval (P0-00 §19); the
900 s context validity window during a live approval step; a provider
combinator if the demo needs further context facts; optional tenant scoping of
registry membership (P0-03 §19).

## 18. Final Verdict

**B. TRUSTED DESTINATION CONTEXT COMPLETE — FOLLOW-UP REQUIRED BEFORE P0-05**

Trusted context can now carry `destination.key`, `destination.known`,
`destination.approvalState` and `destination.approved`, resolved from the P0-02
and P0-03 read ports for the bound organization and the request's own
counterparty, admitted through the existing Trusted Context Boundary, visible
to policy as ordinary `contextFacts`, and withheld — never `false` — whenever
either store cannot be verified or the two disagree. Grants, execution,
intake, registry and approval semantics are unchanged; no destination policy
exists yet.

The one follow-up is verification, not code: a single aggregate
`npm run test:root` invocation stalled in this session (§18a), although every
file passes in isolation with the expected totals. Re-run it to completion
before P0-05; if it completes with only the two inherited failures, this
becomes verdict A.

### 18a. Test Results

WSL2 Linux, Node v22.23.1, after `npm ci`:

| step | result |
| --- | --- |
| `npm run typecheck` / `npm run build` (`tsc -b`) | exit 0 |
| `npm run lint` | node16 imports, architecture and public-surface lint passed |
| new P0-04 tests | 51 (29 + 10 host + 12 structure), 51 pass |
| root suite, every file run in isolation (681 files, 600 s per-file timeout, none timed out) | 9187 tests, 9172 pass, **2 fail (inherited)**, 9 skipped, 4 todo |
| `npm run test:workspaces` | 1089 tests, 1089 pass, 0 fail |
| **total** | **10276 tests, 10261 pass, 2 fail, 9 skipped, 4 todo** |

Against P0-03 (10225 / 10210 / 2 / 9 / 4): +51 tests, +51 passes, no new
failure. The two failures are the inherited CRLF/source-scanning artifacts:
`authority-administration-service.test.ts:334` and
`structural-boundaries.test.ts:282`.

Every P0-01, P0-02 and P0-03 suite, context runtime, Kernel, CORE-04 host,
grant / counterparty, governed-action intake and architecture-boundary suite
is inside those totals and passed.

**Caveat on the aggregate runner.** A single `npm run test:root` invocation in
this session stopped producing output after 324 top-level suites and was killed
at a 2-hour limit. Every one of the 681 files was then run individually and
each completed (slowest 128 s); no file hangs on its own. The aggregate stall
was not reproduced or diagnosed further. Re-run `npm run test:root` before
merging to confirm it completes in the reference environment.
