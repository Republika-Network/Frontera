# ANDREW-P0-05 — $75K Unapproved Destination Policy

| | |
| --- | --- |
| Task | ANDREW-P0-05 — Andrew Demo — $75K Unapproved Destination Policy |
| Branch | `feat/andrew-p0-05-75k-destination-policy` |
| Baseline | `27dee70bfb92fd646e15e2e8a81ec5dd2b078fa7` (`feat/andrew-demo`, P0-00 … P0-04 merged) |
| Status | Implemented, uncommitted, not pushed |

> **"I want this agent to send $75,000 to a wallet that wasn't previously
> approved."** — Frontera refuses it before any grant exists: the Kernel
> commits `denied` (`DOMAIN_POLICY_DENIED`), the committed decision records
> `DESTINATION_NOT_APPROVED`, no grant is minted, and the execution adapter is
> called zero times. Approve the destination for the organization, submit the
> same business intent again, and destination governance no longer blocks it.
> 75,000 is the scenario, not a threshold: 74,999 is refused the same way.

## 1. Objective

Make destination approval a governance requirement for a destination-sensitive
action class, consuming only the trusted facts P0-04 admits:

```
send USD 75,000 to D
  D known, never approved for org  → no executable authorization, adapter 0 calls
  D known, approved for org        → destination governance satisfied
```

…without an amount threshold, without a new decision status, without touching
identity, registry, approval lifecycle, trusted-context derivation, grants,
signers or adapters, and without reevaluation.

## 2. Starting Baseline

| check | result |
| --- | --- |
| path | `/mnt/c/Users/Usuario/source/Republika-Network/Frontera-andrew-p0-05` |
| branch | `feat/andrew-p0-05-75k-destination-policy` |
| working tree | clean |
| `HEAD` | `27dee70` = `feat/andrew-demo` (`merge: Andrew P0-04 trusted destination context`) |
| P0-01 | `src/features/destination-runtime/domain/` |
| P0-02 | `src/features/destination-runtime/registry/`, `src/enterprise/destination-registry/` |
| P0-03 | `src/features/destination-runtime/approval/`, `src/enterprise/destination-approval/` |
| P0-04 | `src/enterprise/trusted-context/destination-context.ts`, `ANDREW-P0-04-TRUSTED-DESTINATION-CONTEXT.md` |

As in P0-00 … P0-04, the worktree's `.git` file points at a Windows path WSL
`git` cannot resolve; git was run with Windows Git (`git.exe`) and the pointer
was not modified. Toolchain: WSL2 Linux, Node v22.23.1, npm 10.9.8, `npm ci`.

## 3. Existing Policy Architecture

| question | answer (unchanged by P0-05) |
| --- | --- |
| policy pack format | `PolicyPackVersion { scope, rules, sources, … }` registered, validated and activated in a `PolicyPackRuntime`; the Kernel consumes it through `createActionEnforcementPolicyPackIntegration` as the embedder's `policyPackProvider` |
| rule model | `PolicyPackRule { id, priority, condition, effect, … }` — data |
| predicates | `group` (`all` / `any` / `not` = NOR) and `predicate { field, operator, value }`; fields include `actionClass`, `amount`, `currency`, `counterpartyId`, `contextFact`, `restrictiveFact`, `parameter` |
| `contextFact` semantics | reads an **admitted** material fact by exact class; a missing / refused / stale fact reads as *absent* (`undefined`), never `false` — so `equals false` does not match absence, `not_equals true` / `exists` do |
| effect vocabulary | `allow`, `deny`, `require_evidence`, `require_approval`, `require_authority`, `require_external_standing`, `limit_scope`, `raise_risk`, `warn`, `no_op` |
| ordering / conflicts | rules sorted by ascending `priority`, then id; the winner is the matched rule with the most restrictive effect (`deny` first) |
| reason codes | each effect carries a free `reasonCode` + `reason`; the Kernel reports `DOMAIN_POLICY_DENIED` and records the policy outcome (`policyId: 'domain_policy_pack'`, the rule's `reasonCode`, `reason`, `passed`) in the committed decision |
| amount / currency | canonical decimal text + asset id from the P9 monetary boundary (`"75000"`, `"USD"`), compared exactly (BigInt) by ordered predicates |
| action type | `action` (opaque id) and the trusted CORE-03 `actionClass` from the Governance Profile registry |
| counterparty | `counterpartyId`, request intent; P0-04 interprets it as the destination key |
| required context | Governance Profile `materialFacts` → required; a required fact not admitted denies `CONTEXT_REQUIRED_FACT_UNRESOLVED` |
| policy → grant | `orchestrator.ts`: `denied` / `indeterminate` return before replay, approvals, grant terms, issuance, claim or adapter; a grant is minted only from a `VerifiedDecision` that is `allowed` (or an approved `approval_required`) |
| existing packs | `src/features/domain-policy-pack-runtime/packs/` (demo packs, not composed into the Host); Host proof policies live in test fixtures (`core04-host-fixture.ts`, `core08-reference-domains-fixture.ts`); **the Host composes no policy by default** |

**Policy precedence over context on the governed path.** The governed path
calls the Kernel's `evaluate()`: policy runs on the *admitted* facts first, and
the required-context step afterwards only denies a result the chain had not
already denied (a denial keeps its own reason). This shaped §6 and §8.

## 4. Policy Scope

The rules govern **one trusted action class**, chosen by the composition:

```ts
destinationApprovalPolicyRules({ actionClass: 'transfer', policyPackVersionId, sourceIds })
```

Every rule is `all(actionClass == <class>, …)`. The class comes from the
trusted Governance Profile registry (CORE-03), never from the request. The
Andrew fixture uses the repository's existing transfer naming from the CORE-08
reference treasury domain: action `transfer-funds` × resource
`treasury-operating-account`, class `transfer`, declared financial with USD at
scale 2. Non-financial actions, internal operations, reads, unclassified
actions and every other class match no destination rule and are not asked for
destination facts.

**Location.** `src/enterprise/trusted-context/destination-policy.ts`, beside
the fact classes it reads. It is **opt-in**: the Host composes no policy pack
by default, so nothing changes for any deployment, profile or action class
unless an embedder composes these rules into its own pack. Not on the public
barrel `src/enterprise/index.ts`, not on any HTTP route, not in the Host's
boot.

## 5. Trusted Destination Facts

Consumed exactly as P0-04 admits them, as `contextFacts`:

| fact | used for |
| --- | --- |
| `destination.known` | unknown vs known |
| `destination.approvalState` | `never-approved` / `revoked` / `expired` / `approved` — distinct causes |
| `destination.approved` | the one safe boolean; must agree with `approvalState` |
| `destination.key` | presence only (facts were produced); reported in evidence by P0-04 |

The policy imports no store, registry, approval reader, provider or resolver
(structural test): policy receives resolved facts only.

## 6. Native Frontera Block/Hold Semantics

| demo language | Frontera semantic |
| --- | --- |
| HOLD / BLOCK | policy effect **`deny`** → enforcement `execution_blocked` → Kernel status **`denied`**, reason codes `DOMAIN_POLICY_DENIED`, `POLICY_ACTION_PROHIBITED`; HTTP 422; governed-action `status: 'denied'` |

HOLD is not a Kernel status and none was added. Why `deny` and not the other
non-authorizing results:

- **`require_approval` (→ `approval_required`) — rejected.** On this Host,
  with durable approvals composed, `approval_required` is *resumable*: a
  reviewer approves **this committed decision** (CORE-05) and a same-key retry
  mints a grant. That would let an action approval stand in for a destination
  approval — "approve this one payment to an unapproved wallet" — and is the
  same-decision resume P0-05 must not add. `require_evidence` and
  `require_external_standing` map to `approval_required` too.
- **withheld (ceiling style) — not applicable.** `withheld` is the
  post-decision issuance gates' vocabulary (authority binding, grant terms,
  exercise, emergency control). Destination governance is a decision about the
  action, made by policy before issuance.
- **`denied` is terminal.** The orchestrator returns at `persisted.status ===
  'denied'` before replay, approvals, grant terms, issuance and exercise. The
  committed decision is final for its idempotency key; a destination approval
  afterwards is acted on by a **new** request, evaluated against the new state.

Invariant held and tested: **no authorization capable of execution** — no
grant row exists in the Host's signed grant store, the adapter is never
called.

## 7. Canonical $75,000 Scenario

Host test `destination-approval-policy-host.test.ts`, canonical shipped Host
(`bootEnterpriseHost()`, production profile, SQLite, Ed25519-signed grants,
real listener), real HTTP route, P0-02 SQLite registry, P0-03 SQLite approval
store, P0-04 provider, real policy runtime, real issuance and exercise gate.

The agent is fully authorized: capability token, delegated authority lineage
for `transfer-funds` × `treasury-operating-account` carrying the existing P10
controls — `max_amount` USD 100,000 per execution and a USD 1,000,000 lifetime
`spending_limit` (P10 requires both on a financial lineage). Only destination
approval differs between the cases.

### Example A — known, never approved

```
POST /api/governed-actions
  { action: "transfer-funds", resource: "treasury-operating-account",
    counterparty: "network-a:abc123", amount: { value: "75000", currency: "USD" } }

trusted:   destination.known = true
           destination.approvalState = never-approved
           destination.approved = false
policy in: amount "75000", currency "USD", actionClass "transfer"
reply:     422 { status: "denied", reasonCodes: ["DOMAIN_POLICY_DENIED", "POLICY_ACTION_PROHIBITED"] }
committed: domain_policy_pack → passed=false, reasonCode DESTINATION_NOT_APPROVED,
           "The destination is not approved for this organization.
            Required: destination.approvalState = approved; observed: never-approved."
grants:    0          adapter calls: 0
```

### Example B — same intent, after approval

```
admin (outside the action):  P0-03 store approve(org, network-a:abc123)
same request semantics, new idempotency key

trusted:   destination.known = true, approvalState = approved, approved = true
policy:    destination rules satisfied (domain_policy_pack passed=true)
reply:     executed
grants:    1 — counterparty bound { kind: identity, value: network-a:abc123 },
           amount bounded by the authority ceiling (USD 100,000), as before P0-05
adapter:   1 call — counterparty network-a:abc123, amount { value: "75000", unit: "USD" }
```

Replaying Example A's idempotency key after the approval returns Example A's
own `denied` decision (same decision id), with no new grant or call.

### Example C — USD 74,999, known, never approved

```
amount "74999" (and "74999.99", "75000.01", "75001")  →  denied DESTINATION_NOT_APPROVED, grants 0, adapter 0
```

This proves 75K is the demo amount, not an approval threshold.

## 8. Unknown Destination

`counterparty: "network-a:never-registered"` → facts `known = false`,
`approvalState = never-approved`, `approved = false` → **`DESTINATION_UNKNOWN`**
(distinct from not-approved). The destination is not registered by asking.
A case-different identifier (`network-a:ABC123`) and the same identifier in
another namespace (`network-b:abc123`) are other, unknown destinations even
while `network-a:abc123` is approved.

## 9. Known but Unapproved Destination

`DESTINATION_NOT_APPROVED` for `never-approved` — including when another
organization has approved the same destination in the same store (approval is
organization-scoped, P0-03/P0-04).

## 10. Approved Destination Control

`known = true ∧ approvalState = approved ∧ approved = true` is the only
combination no destination rule refuses. That satisfies **destination
governance only**; every other control still runs, and the tests show it:

| request (destination approved) | result | control |
| --- | --- | --- |
| USD 75,000 | executed, 1 grant, 1 call | — |
| USD 125,000 | `withheld` / `authority-binding` / `FINANCIAL_AUTHORITY_CEILING_EXCEEDED`, decision `allowed`, 0 grants, 0 calls | P10 ceiling, unchanged |
| EUR 75,000 | `withheld` / `authority-binding` / `FINANCIAL_AUTHORITY_ASSET_MISMATCH`, 0 grants, 0 calls | no FX, unchanged |

## 11. Revoked and Expired States

| state | rule | reason code | observed in evidence |
| --- | --- | --- | --- |
| approved, executed, then revoked | `destination-approval-revoked` | `DESTINATION_APPROVAL_INACTIVE` | `observed: revoked` |
| expired (store clock at exactly `expiresAt`) | `destination-approval-expired` | `DESTINATION_APPROVAL_INACTIVE` | `observed: expired` |
| 1 ms before `expiresAt` | — | executed | — |

Revocation keeps history: the approval and its revocation are both in the P0-03
history after the denial.

## 12. Monetary Semantics

No rule reads `amount`, `currency`, `counterpartyId`, metadata or parameters
(policy unit test walks the conditions; structural test greps the source). No
float, FX, conversion, currency parsing or ceiling change. Exactness is
proven on the path the decision takes:

- `"75000"` reaches policy as `"75000"`, USD as `"USD"`;
- `"75000.00"` is canonicalized at intake to `"75000"`; `"75000.001"` is
  refused (400), never rounded;
- the adapter receives `{ value: "75000", unit: "USD" }`.

## 13. Grant Behavior

Unchanged code and format. Denied → no grant (row count in the Host's signed
`bounded-grants.sqlite` stays 0). Satisfied → one grant with the pre-existing
semantics: counterparty bound by identity to the destination key the facts
were about, amount bounded by the authority's ceiling, Ed25519-signed and
verified by the exercise gate before the adapter ran. `GRANT_BOUND_KEYS` is
pinned by the structure test.

## 14. Execution Behavior

Adapters are an observation point only: blocked cases 0 calls; satisfied case
1 call with the same counterparty and exact amount. No execution, adapter,
grant, issuance or signer source mentions destination policy (structure test).

## 15. Evidence / Reason Codes

| code | rule id | condition (with `actionClass == <class>`) |
| --- | --- | --- |
| `DESTINATION_UNKNOWN` | `destination-approval-unknown` | `known == false` |
| `DESTINATION_NOT_APPROVED` | `destination-approval-never-approved` | `known == true ∧ approvalState == never-approved` |
| `DESTINATION_APPROVAL_INACTIVE` | `destination-approval-revoked` | `known == true ∧ approvalState == revoked` |
| `DESTINATION_APPROVAL_INACTIVE` | `destination-approval-expired` | `known == true ∧ approvalState == expired` |
| `DESTINATION_APPROVAL_UNVERIFIED` | `destination-approval-unverified` | some destination fact admitted ∧ none of: `known == false`; `known == true ∧ approvalState ∈ {never-approved, revoked, expired}`; `known == true ∧ approvalState == approved ∧ approved == true` |

All effects are `deny`; the rules are mutually exclusive (exhaustively tested
over 140 combinations of present, absent and malformed values), so one cause is
recorded. The reason names the fact, the required condition and the observed
state; it carries no approval sequence, approver or destination value. The
Kernel-level reply carries the native `DOMAIN_POLICY_DENIED` /
`POLICY_ACTION_PROHIBITED`; the destination code is in the committed, verified
Governance Record's policy outcome.

### Unavailable is not a destination verdict

When **no** destination fact is admitted, no rule matches — deliberately. P0-04
withholds every fact on registry/approval unavailability, corruption,
inconsistency or an undetermined destination; the facts are material; and the
Kernel's required-context step denies with its own code:

```
approval store closed (even with an active approval) → denied CONTEXT_REQUIRED_FACT_UNRESOLVED, 0 grants, 0 calls
registry closed                                       → same
registry/approval disagree (GOVERNANCE_INCONSISTENT)  → same
counterparty not a canonical key                      → same
```

An earlier draft let the backstop rule also fire on total absence. Because
policy runs before the required-context step on the governed path, that
relabelled store outages as `DOMAIN_POLICY_DENIED / DESTINATION_APPROVAL_UNVERIFIED`
— still fail-closed, but it misreported the cause and departed from P0-04's
contract; the Host tests caught it, and the backstop now requires at least one
admitted destination fact.

That makes the material-fact declaration load-bearing, so the composition
calls `assertDestinationPolicyGovernance(governance, actionClass)`, which
refuses (at startup) a configuration where no profile declares the class or
any profile of the class omits one of `DESTINATION_POLICY_MATERIAL_FACTS`.

## 16. Backward Compatibility

- The Host composes no policy by default; nothing is added to boot, routes,
  configuration parsing, the public barrel or `release/api-surface.v1.json`.
- A Host composing a policy *without* these rules runs the same unapproved
  USD 75,000 request to `executed`, as before (tested): the facts are visible,
  only composition gives them an effect.
- On a Host with the rules, a non-destination action (`deploy-release`) is
  executed, asks for no destination fact and matches no destination rule.
- Beside an organization's other rules, decisions for other classes are
  identical with and without the destination rules (tested).
- Policy runtime, enforcement, Kernel, context runtime, P0-01 … P0-04, grant
  runtime, issuance, signers and adapters: no source change.

## 17. Security Invariants

| # | invariant | how |
| --- | --- | --- |
| 1 | unapproved destination → no executable authorization | `deny` → `denied` → orchestrator returns before issuance; 0 grants, 0 calls |
| 2 | unknown destination → none | `DESTINATION_UNKNOWN` |
| 3 | revoked / expired → none | `DESTINATION_APPROVAL_INACTIVE` |
| 4 | unavailable / corrupt / inconsistent facts → none, reported as unavailability | no rule matches; required context denies; guard enforces materiality |
| 5 | incomplete / disagreeing admitted facts → none | `DESTINATION_APPROVAL_UNVERIFIED` |
| 6 | approval satisfies only the destination rule | ceiling, asset mismatch still withhold (tested) |
| 7 | no amount threshold | no monetary predicate; 74,999 … 75,001 identical |
| 8 | facts only from P0-04 | structure test: imports and calls |
| 9 | request cannot self-assert approval | intake 400 / asserted context ignored / forged readings refused (tested) |
| 10 | organization-scoped | another org's approval does not count (tested) |
| 11 | no resume path | `deny`, never `require_approval`; replay returns the original denial |
| 12 | no HOLD status, no grant/adapter/signer change | structure tests |

## 18. Tests

| file | tests | covers |
| --- | --- | --- |
| `src/enterprise/__tests__/destination-approval-policy.test.ts` | 28 | real validator/engine/integration: canonical states, one rule each; 140-combination exhaustive matrix; total absence matches nothing; incomplete/inconsistent facts; exact values; amounts 0.01 … 999999999999.99 incl. 74999, 74999.99, 75000, 75000.01, 75001; assets; conditions read only class + facts; other classes / unclassified untouched; forged request fields; composition beside other rules; builder purity, prefix/priority, option validation; composition guard |
| `src/enterprise/__tests__/destination-approval-policy-host.test.ts` | 22 | Host Cases 1–5; before/after approval as two evaluations + replay finality; 74,999 … 75,001; `75000.00` canonical, `75000.001` refused; approved + 125,000 ceiling; approved + EUR; unapproved EUR; other org; case / namespace; top-level claims 400; asserted-context claims; asserted fact class 400; forged approval readings; approval store / registry closed; inconsistent stores; non-key counterparty; non-destination action; Host without the rules unchanged |
| `src/enterprise/__tests__/destination-approval-policy-structure.test.ts` | 10 | imports; no store/registry/approval/admin/resolver; no rail/signer/grant/execution/network/clock; no amount/demo special case; `deny` only; engine/enforcement generic; adapters/grants/issuance/signers free of destination policy; no Kernel HOLD; grant bound keys pinned; not composed by Host/API/barrel |

Results: §18a.

## 19. Files Changed

| file | change |
| --- | --- |
| `src/enterprise/trusted-context/destination-policy.ts` | new — rule builder, reason codes, material facts, composition guard |
| `src/enterprise/trusted-context/index.ts` | exports the above (module barrel only) |
| `src/enterprise/__tests__/destination-approval-policy.test.ts` | new |
| `src/enterprise/__tests__/destination-approval-policy-host.test.ts` | new |
| `src/enterprise/__tests__/destination-approval-policy-structure.test.ts` | new |
| `docs/demo/andrew/ANDREW-P0-05-75K-DESTINATION-POLICY.md` | new — this document |

Not changed: P0-01 identity, P0-02 registry, P0-03 approval lifecycle, P0-04
resolver/provider, policy runtime, enforcement, Kernel, context runtime,
intake, grant runtime / format / issuance / verification, signers, execution
runtime and adapters, Host boot / configuration / routes, public surface,
`package.json`.

## 20. Explicitly Out of Scope

Same-action reevaluation or resume after approval (the demo shows two
independent evaluations); XRPL, Testnet, wallets, signing, transaction
building, address validation, ledger access; destination approval workflow,
routes or permissions; grant destination axis; monetary ceiling changes or the
P0-10 $125K / $100K scenario; Host-level composition of the destination stores
and policy (the embedder composes them, as in the tests).

## 21. Impact on ANDREW-P0-06

P0-06 can build rail execution on a decision path that already refuses an
unapproved, unknown, revoked or expired destination before any grant exists,
and, once approved, mints a grant whose counterparty is exactly the approved
destination key. Rail work stays below the grant: the adapter never needs, and
must not gain, destination policy. P0-09's demo harness composes:

1. the transfer Governance Profile with `DESTINATION_POLICY_MATERIAL_FACTS`
   as material facts and the two `authoritative` sources (P0-04 §10);
2. `createDestinationContextProvider` over the durable registry and approval
   store;
3. `assertDestinationPolicyGovernance(governance, 'transfer')` and
   `destinationApprovalPolicyRules({ actionClass: 'transfer', … })` in the
   organization's policy pack;
4. an authority lineage with a USD `max_amount` and a USD `spending_limit`.

Carried forward: same-action reevaluation (P0-00 §19); a provider combinator
if the demo needs non-destination context facts beside these; P0-10 ceiling
wording (WITHHELD vs DENY).

## 22. Final Verdict

**A. DESTINATION POLICY COMPLETE — READY FOR ANDREW-P0-06**

An action of the governed class that names a known destination this
organization never approved — USD 75,000 or any other amount — is committed as
`denied` before a grant can exist: no grant is minted, the adapter is not
called, and the committed decision records `DESTINATION_NOT_APPROVED` with the
fact, the required condition and the observed state. Unknown, revoked and
expired destinations are refused with their own causes; unavailable facts
remain the required-context denial. Once the destination is approved, a new
submission of the same intent passes destination governance, and every other
control (P10 ceiling, asset matching, authority) still applies. Grants,
signers, adapters, the Kernel, the policy engine and P0-01 … P0-04 are
unchanged. Same-action reevaluation remains out of scope.

### 18a. Test Results

WSL2 Linux, Node v22.23.1, npm 10.9.8, after `npm ci`:

| step | result |
| --- | --- |
| `npm run typecheck` / `npm run build` (`tsc -b`) | exit 0 |
| `npm run lint` | node16 imports, architecture and public-surface lint passed |
| new P0-05 tests | 60 (28 policy + 22 Host + 10 structure), 60 pass |
| focused regression (184 files: P0-01 … P0-05, policy runtime, enforcement, context runtime, Kernel, grant, execution, monetary, authority ceilings, CORE-04 / CORE-08 hosts, governed-action suites, structural boundaries) | 3116 tests, 3115 pass, 1 fail (inherited `structural-boundaries.test.ts:282`) |
| `npm run test:root`, one aggregate invocation (completed) | 9247 tests, 9232 pass, **2 fail (inherited)**, 9 skipped, 4 todo |
| `npm run test:workspaces` | 1089 tests, 1089 pass, 0 fail |
| **total** | **10336 tests, 10321 pass, 2 fail, 9 skipped, 4 todo** |

Against P0-04 (root 9187 / 9172 / 2 / 9 / 4; workspaces 1089 / 1089): +60
tests, +60 passes, no new failure. The two failures are the inherited
CRLF / source-scanning artifacts: `authority-administration-service.test.ts`
and `structural-boundaries.test.ts:282` (a scan of the untouched,
CRLF-terminated `enterprise-configuration.ts`). The aggregate run completed
this time without the P0-03 `SQLITE_BUSY` contention seen in P0-04's aggregate
run; no failure needed isolation.
