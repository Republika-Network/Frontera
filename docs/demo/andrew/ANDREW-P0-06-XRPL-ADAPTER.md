# ANDREW-P0-06 — XRPL Execution Adapter

| | |
| --- | --- |
| Task | ANDREW-P0-06 — Andrew Demo — XRPL Execution Adapter |
| Branch | `feat/andrew-p0-06-xrpl-adapter` |
| Baseline | `fa4517722c77411431a4cb249d1fa391bb9432c3` (`feat/andrew-demo`, P0-00 … P0-05 merged) |
| Status | Implemented and qualified (§26a); committed on this branch, merged locally into `feat/andrew-demo`; not pushed |

> **NO transaction was submitted to XRPL in P0-06.** No network, no Testnet,
> no account, no seed, no signer. Every transaction hash in this task's tests
> is fixture output of an in-memory fake transport. P0-06 proves translation,
> binding and outcome mapping; ledger submission and validation are P0-08.

## 1. Objective

Implement an XRPL execution adapter on Frontera's existing `ExecutionAdapter`
port that turns an already-authorized, grant-exercised action into one
canonical XRPL Payment instruction, accepts only XRPL destinations, preserves
the grant-bound destination and the exact amount, maps assets to XRPL only
through explicit configuration, and hands the instruction to an injectable
transport — testable offline, with no secret.

## 2. Starting Baseline

| check | result |
| --- | --- |
| path | `/mnt/c/Users/Usuario/source/Republika-Network/Frontera-andrew-p0-06` |
| branch | `feat/andrew-p0-06-xrpl-adapter` |
| working tree | clean |
| `HEAD` | `fa45177` = `feat/andrew-demo` (`merge: Andrew P0-05 destination approval policy`) |
| P0-01 | `src/features/destination-runtime/domain/` |
| P0-02 | `src/features/destination-runtime/registry/`, `src/enterprise/destination-registry/` |
| P0-03 | `src/features/destination-runtime/approval/`, `src/enterprise/destination-approval/` |
| P0-04 | `src/enterprise/trusted-context/destination-context.ts` |
| P0-05 | `src/enterprise/trusted-context/destination-policy.ts`, `ANDREW-P0-05-75K-DESTINATION-POLICY.md` |

As before, the worktree's `.git` pointer is a Windows path; git was run with
`git.exe` and the pointer was not modified. Toolchain: WSL2, Node v22.23.1,
npm 10.9.8, `npm ci`.

## 3. Existing Execution Architecture

| question | answer (unchanged by P0-06) |
| --- | --- |
| port | `ExecutionAdapter { adapterId; execute(ValidatedExecutionAction): Promise<ExecutionAdapterResult> }` — `src/features/execution-runtime/domain/execution-adapter-port.ts` |
| input | `ValidatedExecutionAction { boundedGrantId, subject, action, resource, counterparty?, organization?, amount?: MonetaryAmount, parameters?, notAfter, correlation { requestId, decisionId, executionId } }` — fresh, frozen, every field proven inside the grant; **no free-form payload** |
| output | `completed` / `failed { reason }` / `unconfirmed`, each with optional `providerRef`, `detail`, `adapterId`; reasons `PROVIDER_REJECTED`, `PROVIDER_UNAVAILABLE`, `PROVIDER_RESPONSE_INVALID`, `ADAPTER_ERROR` |
| router | `createExecutionAdapterRegistry({ adapters, selectAdapter })` — composite adapter, synchronous trusted routing on the validated action, adapter-scoped emergency check, exactly one child call, registry-owned attribution |
| Host composition | `bootEnterpriseHost({ executionAdapters })` + governed-action file `routes: [{ action, adapterId }]`; `selectAdapter = routes.get(action.action)` |
| invocation path | HTTP → orchestrator → Kernel decision → grant issuance (signed) → `GrantExecutionService.exercise` (authoritative grant read, exercise assessment, P7 reservation, emergency control) → registry → child adapter |
| counterparty / amount | taken from the exercise snapshot after the gate proves `counterparty` equal to the grant's identity bound and `amount` within the grant's ceiling **in the grant's unit** (no conversion) |
| grant binding | P0-05: counterparty bound `{ kind: 'identity', value: <destination key> }`; amount `{ kind: 'ceiling', limit, unit }` from the authority's P10 ceiling |
| outcome durability (P10/P11) | the orchestrator prepares a durable attempt keyed by `executionId` *before* the adapter and records the terminal outcome after; adapters cannot reach the store (structural test) |
| receipt / reference (P11) | `providerRef` is an opaque handle, never proof; filtered by `isRecordableProviderRef` (a 64-hex hash passes) |
| reconciliation (P12) | `unconfirmed` is reconciled out of band; nothing retries |
| idempotency | one exercise = one `executionId`; a replayed request returns the recorded outcome; adapters must not retry |
| network I/O | adapters may perform it (Generic HTTP does, through one inventoried transport, EP-050) |
| existing adapters | Generic HTTP (`src/enterprise/execution-adapters/generic-http/`): internal core + injected network runtime, closed configuration snapshotted at composition, fixed `detail` phrases, a throw after send is `unconfirmed` |
| structural rules | provider vocabulary (`xrpl`, `ledger`, `wallet`, …) is banned from the generic CORE layers; every `ExecutionAdapter` holder and every outbound client site is pinned by `no-bypass-effect-paths.test.ts` |

## 4. Adapter Boundary

```
GrantExecutionService (gate)
  → ExecutionAdapterRegistry (route by action; emergency check)
  → XRPL adapter.execute(ValidatedExecutionAction)
       translate:  counterparty + amount + plan → XrplPaymentInstruction   (pure; refusal = ADAPTER_ERROR, no I/O)
       submit:     XrplPaymentTransport.submitPayment(submission)          (exactly once; never retried)
       classify:   observation → completed / failed / unconfirmed
  → [P0-08] real transport: Account, signer, Fee, Sequence, LastLedgerSequence, submit, validate
```

The existing port **does** perform the effect (Generic HTTP sends inside
`execute`), so the architecture is preserved: the adapter owns translation and
calls an injected transport; the transport owns the network. No parallel
framework, no new execution path, no composition-root change. The adapter is a
registry child an embedder composes through the existing `executionAdapters`
option — exactly how the P0-05 Host test composes its recording adapter.

Location: `src/enterprise/execution-adapters/xrpl/`, beside Generic HTTP — the
one place provider vocabulary is permitted (outside every CORE scan root).

## 5. XRPL Namespace

`xrpl` (`XRPL_DESTINATION_NAMESPACE`), compared exactly. `XRPL`, `xrp`,
`ripple`, `xrpl-mainnet`, `xrpl.testnet`, `lightning`, … are refused by the
default adapter — never stripped, folded or rerouted.

Destination identity stays rail identity; network belongs to the transport.
**One tension, recorded for P0-07:** P0-01 §namespace strategy says a test
network that shares a production address space is a *separate namespace*
(`network-a` vs `network-a.testnet`), and XRPL Testnet and Mainnet share the
classic-address space. So the adapter's namespace is an **exact, injected
configuration value** (`namespace`, default `xrpl`, constrained to `xrpl` or
`xrpl.<label>`): P0-07 decides whether a Testnet deployment registers and
approves `xrpl:` or `xrpl.testnet:` destinations without touching adapter code.
P0-06 creates no testnet namespace and the namespace never selects a network.

## 6. Destination Semantics

The adapter reads only `action.counterparty`, the value the exercise gate proved
equal to the grant's bound. It must be a canonical P0-01 key: split at the first
`:`, parsed through `parseExecutionDestination`, and accepted only when
`executionDestinationKey` re-spells it identically — the same rule P0-04 applies
before reporting approval facts for that key. (Re-derived from P0-01 rather than
imported from `trusted-context`, which the adapter must not reach.) Then
`namespace` must equal the configured namespace and `identifier` becomes
`Payment.Destination` verbatim.

| layer | question |
| --- | --- |
| P0-01 identity | `xrpl:<identifier>` |
| P0-02 registry | is it known? |
| P0-03/04/05 approval | is it approved for this org? |
| **P0-06 adapter** | **is the approved identifier usable as an XRPL Payment destination?** |

Known + approved + technically invalid ⇒ grant issued, adapter refuses
(`ADAPTER_ERROR`), transport 0 (Host test). A valid address is not thereby
known or approved: the adapter never consults registry or approval state.

## 7. Address Validation

Checksum-verified XRPL classic-address decoding (`isXrplClassicAddress`):
base58 over the XRPL alphabet, version byte `0x00`, 20-byte account id, 4-byte
double-SHA-256 checksum, exact and case-sensitive. Refused: checksum failures,
X-addresses, seeds, foreign alphabets, re-spellings, padding, non-strings.

**Dependency decision — no dependency added.** The authoritative codec is
`ripple-address-codec`; installed into a scratch directory (not the project),
v5.0.1 pulls `@scure/base`, `@xrplf/isomorphic` → `@noble/hashes`,
`eventemitter3` and **`ws`** — a WebSocket client — into a runtime whose only
third-party runtime dependency is `better-sqlite3`. The codec's own algorithm
was implemented with `node:crypto` SHA-256 instead (≈40 lines, no regex
validation), and verified:

- against the library: 40,000 differential cases (5,000 random accounts, with
  leading-zero ids, each plus 3 random single-character mutations, a dropped
  first character, an added leading `r`, an added trailing `r`, and its
  X-address) — **0 mismatches** (run in the scratch directory; not a test);
- in-repo, against public vectors (genesis `rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh`,
  ACCOUNT_ZERO, ACCOUNT_ONE) and library-generated fixtures.

P0-08 will add a real client and may adopt `xrpl.js`; at that point the codec
can be swapped for the library behind the same function with these tests as the
contract.

## 8. DestinationTag Decision

**Unsupported in P0-06.** `ExecutionDestination` is `{ namespace, identifier }`
and nothing else; P0-01 refuses extra fields. Appending a tag to the identifier
(`r…?dt=7`, `r…:7`) would change P0-01 identity semantics and make the tag
invisible to registry/approval as a separate fact; `ValidatedExecutionAction`
has no free-form channel and governed parameters are not destination identity.
The instruction has no `DestinationTag`; an identifier carrying a tag fails
address validation; X-addresses (which encode tags) are refused. Andrew needs no
tag. A future design should add it as a typed, grant-bound field — an
architectural decision, not an adapter patch.

## 9. Asset Mapping

Injected, immutable, explicit: `assets: [{ assetId, representation }]`, where
`assetId` is the exact P9 `MonetaryAmount.unit` and `representation` is
`{ kind: 'issued', currency, issuer }` or `{ kind: 'native' }`. Snapshotted and
frozen at construction; accessors and undeclared keys refused.

Construction refuses (fail-fast, messages never echo values):

- an issuer that is not a valid classic address (`XRPL_ISSUER_INVALID`);
- a currency that is not a standard 3-character XRPL code, or is `XRP`
  (`XRPL_CURRENCY_INVALID`);
- **conversion by configuration** (`XRPL_ASSET_MAPPING_INVALID`): the asset's
  own code must equal `currency` (so `EUR` → issued `USD` is impossible); only
  an asset coded `XRP` may map to native (so `USD` → XRP is impossible); an
  asset id that names an issuer (`xrpl:USD/r…`) must name the configured one;
  an asset of another rail (`stellar:USD`) is refused;
- aliases: two assets for one XRPL representation, one asset mapped twice, an
  empty mapping list.

At execution an unmapped unit is `ADAPTER_ERROR` ("no configured XRPL
representation"), transport 0 — no conversion, no XRP fallback. No database,
token registry, network lookup or secret. The issuer is configuration only;
no Andrew issuer is hardcoded in production code. Hex (160-bit) currency codes
(e.g. RLUSD) are deferred.

## 10. Canonical USD 75,000 Representation

```
Frontera action:     transfer USD 75,000
                     counterparty = xrpl:r92Zr53w6hG5eqX7Zs9Gz2Rq7g7W3FY8zZ   (grant-bound)
XRPL asset mapping:  USD → issued currency USD, issuer rhdd5zpcK7jT48xt4GW44cAYXXfPYr4azT
XRPL instruction:    { TransactionType: "Payment",
                       Destination: "r92Zr53w6hG5eqX7Zs9Gz2Rq7g7W3FY8zZ",
                       Amount: { currency: "USD", issuer: "rhdd5zpcK7jT48xt4GW44cAYXXfPYr4azT", value: "75000" } }
```

Fixture addresses: account id = first 20 bytes of SHA-256 over a public label
(`frontera:andrew-p0-06:destination`, `…:issuer`), encoded by
`ripple-address-codec`. Checksum-valid; nobody holds their keys; not funded.

## 11. XRPL Payment Instruction

`XrplPaymentInstruction { TransactionType: 'Payment', Destination, Amount }` —
XRPL's own field names, frozen, key order fixed, deterministic (same action ⇒
byte-identical JSON). Deliberately absent: `Account` (belongs to the signer;
P0-06 does not invent account ownership), `Fee`, `Sequence`,
`LastLedgerSequence` (live ledger state), `Flags`, `SendMax`, `Paths` (their
absence makes this an exact-amount, same-currency payment — no partial payment),
`DestinationTag` (§8), `Memos` (no grant signature, secret, personal data or
governance record goes on-ledger).

## 12. Transport Boundary

```ts
interface XrplPaymentTransport { submitPayment(s: XrplPaymentSubmission): Promise<XrplSubmissionObservation> }
XrplPaymentSubmission = { instruction, executionId, requestId, decisionId, notAfter }
XrplSubmissionObservation = not-submitted | rejected | unconfirmed | validated   (each with optional transactionHash)
```

`createXrplExecutionAdapter(options, transport)` requires a transport; P0-06
ships **no implementation**. `executionId` is the existing idempotency handle
(one exercise, one submission); `notAfter` is the grant horizon the transport
must not let a transaction outlive. The adapter calls `submitPayment` from one
place, once, with no loop; a throw is `unconfirmed`, never retried. Tests use an
in-memory spy that records every submission.

## 13. Signer Boundary

No signer port was added: the existing port does not require the adapter to
produce a signed transaction, and the transport boundary is where P0-08 attaches
signing together with `Account`, fee, sequence and `LastLedgerSequence`. The
adapter reads no seed, secret, mnemonic or private key; its configuration
refuses such keys (`XRPL_OPTIONS_INVALID`); the submission carries none; a
transport error containing a secret never reaches `detail` (fixed phrases).

## 14. Network Configuration Boundary

No endpoint, Testnet/Mainnet/Devnet URL, faucet or network discriminator in
adapter code (structural test: no URL, no `testnet`/`mainnet`/`devnet` literal,
no network client import, no `fetch`/WebSocket). Network selection is the
transport's configuration (P0-07/P0-08). §5 records the one identity question
P0-07 must settle.

## 15. Grant-Binding Invariants

Measured through the real `GrantExecutionService` gate + registry + XRPL child,
with a grant built the way issuance builds one (unchanged format):

| attempt | result | transport |
| --- | --- | --- |
| `xrpl:<bound address>`, USD 75,000 | executed | 1 |
| another valid XRPL address | withheld | 0 |
| case-changed / padded address | withheld | 0 |
| same address in `lightning`, `xrpl.testnet`, `network-a`, or bare | withheld | 0 |
| no counterparty against a destination-bound grant | withheld | 0 |
| USD 100,000.01 / 125,000 (ceiling 100,000) | withheld | 0 |
| EUR / `xrpl:XRP` / `xrpl:USD/<issuer>` (grant in USD), even when the adapter maps them | withheld | 0 |
| caller mutates its request object after exercise begins | executed with the original values | 1 |

There is no second destination field: the action *is* the payload (no
`payloadRef`, no metadata channel), and the adapter ignores undeclared fields
(tested). `GRANT_BOUND_KEYS` is pinned to the pre-P0-06 list; the XRPL
destination is bound as an ordinary identity counterparty and the digest is
the canonical `boundedGrantDigest`. Grant runtime, issuance, signer and
verifier are unchanged.

## 16. Exact Money Semantics

Text in, text out. Issued values are the P9 canonical decimal verbatim:
`"75000"`, `"74999.99"`, `"75000.01"`, `"0.000001"`, `"123456789.123456"`, …
reach the instruction byte-identical. Refused rather than approximated (the
ledger would round): zero, more than **15 significant digits** (XRPL's
documented issued-currency precision; e.g. `9007199254740993`,
`0.30000000000000004`), and values outside the normalized exponent range
−96 … 80; non-canonical text (numbers, exponents, signs, trailing zeros).
Native XRP: digit-string conversion to drops (`1` → `1000000`, `0.000001` →
`1`, `0.0000001` refused, `90071992547.40993` → `90071992547409930` exactly,
above the 100-billion-XRP supply refused). Structural test: no `Number(`,
`Number.`, `parseFloat`, `parseInt`, `toFixed`, `Math.` in the module.

## 17. Error Mapping

| condition | `ExecutionAdapterResult` | Host status |
| --- | --- | --- |
| no / malformed counterparty, wrong namespace, invalid address, no amount, unmapped asset, unrepresentable amount | `failed` / `ADAPTER_ERROR`, fixed detail, no `providerRef`, transport 0 | `execution_failed` |
| `not-submitted` | `failed` / `PROVIDER_UNAVAILABLE` (no `providerRef`) | `execution_failed` |
| `rejected` | `failed` / `PROVIDER_REJECTED` (+ hash if supplied) | `execution_failed` |
| `unconfirmed`, transport throw, unreadable observation | `unconfirmed` (+ hash if supplied) | `execution_unconfirmed` |
| `validated` | `completed` (+ hash if supplied) | `executed` |

None of these is a denial; authorization outcomes never come from the adapter.
Configuration defects are `XrplConfigurationError` at construction.

## 18. Result / Outcome Mapping

Existing schema, unchanged. Rail attribution is the registry-owned `adapterId`
(e.g. `xrpl.treasury`), recorded by the existing execution ledger; the
transaction hash, when and only when a transport supplied a 64-hex value, is the
`providerRef` — a handle for P12 reconciliation, never proof. The adapter
never computes or fabricates a hash; a malformed or credential/URL-shaped value
is dropped; `not-submitted` never carries one. Rail = `xrpl` and type =
`Payment` are properties of the adapter and instruction, not new result fields.

## 19. Security Invariants

| # | invariant | how |
| --- | --- | --- |
| 1 | reachable only after authorization + exercise | existing gate + registry; no-bypass inventory updated (§20) |
| 2 | no registry / approval / trusted-context / policy / Kernel / grant-store read | structural import allowlist + call scan |
| 3 | no grant minted, altered or widened; ceilings unchanged | no grant import; drift tests; Host 125K withheld |
| 4 | executed destination = grant-bound destination | §15 |
| 5 | no implicit FX, USD ≠ XRP | explicit mapping; construction guards; tests |
| 6 | no self-asserted facts, no secret from requests | the adapter reads only the validated action |
| 7 | no key, no endpoint, no network client | structural tests |
| 8 | no secret in results or logs | fixed detail phrases; secret-in-throw test |
| 9 | no substitution or reinterpretation | exact namespace, exact identifier |
| 10 | no retry | single call site, no loop; throw ⇒ unconfirmed |
| 11 | policy/trusted-context/Kernel/grant/execution-runtime/Host/composition do not import the adapter | structural test |

## 20. Backward Compatibility

- No change to P0-01 … P0-05, the Kernel, policy runtime, grant runtime/format,
  issuance, signers/verifiers, execution runtime, registry, Generic HTTP,
  composition root, Host boot, configuration, routes, Enterprise barrel,
  `release/api-surface.v1.json` or `package.json`/lockfile.
- `core04-host-fixture.ts` (test fixture): `boot` gained an optional
  `executionAdapters` list appended beside the recording adapter; every
  existing caller is unaffected.
- `no-bypass-effect-paths.test.ts` and `NO_BYPASS_AUTHORITY_CONTROLLED_EXECUTION.md`
  §7.1: the XRPL adapter is enumerated as a new port implementer (it adds no
  egress site).
- Existing routing unchanged: on the same Host a non-transfer action still
  reaches its own adapter (tested).

## 21. Tests

| file | tests | covers |
| --- | --- | --- |
| `src/enterprise/__tests__/xrpl-execution-adapter.test.ts` | 58 | port conformance; registry child + attribution; canonical USD 75,000 instruction; determinism; issuer from config only; USD never XRP; namespace accept/refuse (6 foreign spellings) and configured namespace; malformed counterparties; address vectors and refusals; invalid address ⇒ transport 0; unmapped assets (6); FX-by-config guards; aliases; invalid issuer/currency fail fast; secret/endpoint/network keys refused; accessors; snapshotting; exact values (8) and refusals; issued bounds; native drops; transport outcome mapping (5); hash surfacing rules; throwing transport (secret not leaked); unreadable observations; submission contents |
| `src/enterprise/__tests__/xrpl-execution-adapter-exercise.test.ts` | 13 | real gate: canonical exercise; destination, re-spelling, namespace, missing-counterparty drift; amount exactness and ceiling; asset drift; post-start mutation; invalid-but-bound address ⇒ ADAPTER_ERROR; rejection / unconfirmed mapping; `GRANT_BOUND_KEYS` pinned; grant format/digest |
| `src/enterprise/__tests__/xrpl-execution-adapter-host.test.ts` | 6 | shipped Host + P0-02…P0-05: unapproved ⇒ denied, XRPL 0; approved ⇒ executed via XRPL, 1 submission, exact instruction, grant bound to the XRPL key; approved-but-invalid ⇒ `execution_failed ADAPTER_ERROR`, transport 0; 125K ⇒ withheld; EUR ⇒ withheld; other route unchanged |
| `src/enterprise/__tests__/xrpl-execution-adapter-structure.test.ts` | 11 | module file set; import allowlist; no governance reads; no network client; no URL/network literal; no key or live-ledger field; no number conversion / clock / retry; single transport call site; nothing authority-bearing imports it; not on barrel/API surface; no XRPL dependency |

Results: §26a.

## 22. Files Changed

| file | change |
| --- | --- |
| `src/enterprise/execution-adapters/xrpl/contracts.ts` | new — options, mapping, instruction, submission, transport port, configuration error |
| `src/enterprise/execution-adapters/xrpl/xrpl-codec.ts` | new — classic address, currency code, issued value, drops |
| `src/enterprise/execution-adapters/xrpl/configuration.ts` | new — snapshot/validate options |
| `src/enterprise/execution-adapters/xrpl/payment-translation.ts` | new — pure action → instruction |
| `src/enterprise/execution-adapters/xrpl/xrpl-execution-adapter.ts` | new — the adapter |
| `src/enterprise/execution-adapters/xrpl/index.ts` | new — module barrel |
| `src/enterprise/__tests__/xrpl-adapter.fixture.ts` | new — fixtures, spy transport |
| `src/enterprise/__tests__/xrpl-execution-adapter*.test.ts` | new — 4 files |
| `src/enterprise/__tests__/core04-host-fixture.ts` | `boot` accepts optional extra adapters |
| `src/enterprise/__tests__/no-bypass-effect-paths.test.ts` | holder inventory + XRPL adapter |
| `docs/security/NO_BYPASS_AUTHORITY_CONTROLLED_EXECUTION.md` | §7.1 row for the XRPL adapter |
| `docs/demo/andrew/ANDREW-P0-06-XRPL-ADAPTER.md` | new — this document |

## 23. Explicitly Out of Scope

Real submission, transport/client implementation, signer, `Account`, fee,
sequence, `LastLedgerSequence`, autofill, ledger polling/validation,
`tesSUCCESS`/ledger index/explorer URL, `delivered_amount` checks (P0-08);
Testnet accounts, funding, faucet, TrustLines, token issuance, network
configuration (P0-07); DestinationTag; hex currency codes; memos; the full
Andrew E2E and demo harness (P0-09, P0-11); the ceiling variant (P0-10); grant
rail axis; Host-level composition of the XRPL adapter.

## 24. Impact on ANDREW-P0-07

P0-07 can configure Testnet without touching the adapter: a funded sending
account and an issuer account, a TrustLine from destination to issuer for
`USD`, the adapter's `assets` mapping with that issuer, and the transport's
network. **Decide the namespace** (§5): `xrpl` everywhere with network in the
transport, or `xrpl.testnet` for Testnet destinations per P0-01; the adapter
supports either through `namespace`. Keep the governed `resource` ↔ sending
account association explicit in transport configuration (the adapter does not
choose `Account`).

**RLUSD is not yet representable — decide before P0-08.** The Andrew story
settles USD 75,000 *in RLUSD*. RLUSD's XRPL currency code is the 160-bit hex
code `524C555344000000000000000000000000000000`, and this adapter accepts only
standard 3-character codes (§9), and requires the Frontera asset's own code to
equal the XRPL currency, so `USD` → RLUSD is refused today as conversion by
configuration. Two options: (a) keep the governed unit `USD` (so the P10 USD
ceiling and P0-05 USD threshold keep applying unchanged) and add an explicit,
declared *denomination* mapping `USD` → issued `RLUSD`/issuer — a 1:1
representation chosen by configuration, never a rate; or (b) make the governed
unit an RLUSD asset id, which would put the USD ceiling and threshold in a
different unit and withhold the grant. (a) is the coherent choice; it is a
small, tested amendment to `xrpl-codec.ts` (hex currency codes) and
`configuration.ts` (the declared-denomination rule) with no change to grants,
policy or the port.

## 25. Impact on ANDREW-P0-08

Implement `XrplPaymentTransport` (likely with `xrpl.js`): add `Account` from the
signer configuration, autofill `Fee`/`Sequence`, set `LastLedgerSequence`
within `notAfter`, sign without exposing the key, submit once per `executionId`,
wait for a validated ledger, map `tesSUCCESS` → `validated`, `tem*`/`tef*`
(cannot apply) and `tec*` in a validated ledger (fee charged, payment not made) → `rejected`, network errors before submission →
`not-submitted`, and everything ambiguous (`ter*`, timeouts, a result not yet
validated) → `unconfirmed`, carrying the real hash; verify
`delivered_amount` equals the instruction's `Amount`. Inventory the transport
as a new egress site (EP id) in `NO_BYPASS_AUTHORITY_CONTROLLED_EXECUTION.md`
§7.6 and `no-bypass-effect-paths.test.ts`. Use the P12 reconciliation seam for
`unconfirmed` hashes.

## 26. Final Verdict

See §26a for results and the final verdict line.

### 26a. Test Results

Qualification was interrupted once (during a regression batch) and re-run
from scratch on 2026-10-04 against the unchanged working tree. Every run below
was made after a forced full rebuild (`tsc -b --force`).

**Control.** To separate P0-06 effects from inherited ones, the exact baseline
tree `fa45177` was exported with `git.exe archive` into a scratch directory
(same CRLF conversion as the worktree), linked to the same `node_modules` and
built; suspect suites were run on both trees under identical conditions.

| check | P0-06 | baseline `fa45177` |
| --- | --- | --- |
| `npm run build` / `tsc -b --force` | pass | pass |
| `npm run typecheck` | pass | — |
| `npm run lint` (node16 imports, architecture, public surface) | pass | — |
| four P0-06 suites | **88 / 88** | n/a |
| focused regression: 246 files (every `dist/src` test matching destination, xrpl, no-bypass, structural, execution, grant, adapter, generic-http, core04, host, trusted, policy, exercise, registry), `destination-approval.test.js` held out | 3,420 / 3,422 | — |
| `structural-boundaries.test.js` alone | 63 / 64 | 63 / 64 (same test) |
| `governed-action-approvals-host.test.js` alone | 18 / 18 | 18 / 18 |
| `destination-approval.test.js` alone | 54 / 54 | 54 / 54 |
| `destination-approval.test.js`, 4 rounds × 8 concurrent copies | 27 / 32 runs green | 30 / 32 runs green |
| `git diff --check`, conflict markers | clean | — |

**The two focused-batch failures, both inherited:**

1. `structural-boundaries` — *Provider credential exposure (R004.B)*. The
   assertion at `structural-boundaries.test.ts:284` matches
   `….*\n\s*if (!value) return [];` against `enterprise-configuration.ts`,
   which is LF in the index and CRLF in this `core.autocrlf=true` Windows
   checkout; `.` does not match `\r`. Identical failure on the baseline. It is a
   checkout-environment artefact, not a product defect.
2. `governed-action-approvals-host` — *quorum 2 across a restart*: the
   authority-state witness did not answer within its 2,000 ms bound while the
   machine ran ~17 test processes (load average ≈ 21). Passes alone on both
   trees. Load-induced timing, not a P0-06 regression (the file does not reach
   the XRPL adapter).

**Inherited `SQLITE_BUSY` in `destination-approval.test.js` (ANDREW-P0-03),
characterised:**

- Every failing run, on both trees, is the single subtest *parallel first
  openings of a brand-new file initialize it once*. Test, worker and store are
  byte-identical between the trees; the P0-06 diff imports none of them.
- Root cause, isolated with a scratch probe of four threads opening one fresh
  file: **`PRAGMA journal_mode = WAL` itself throws `SQLITE_BUSY`** (≈ 1 in
  1,200 opens idle, more under load). SQLite can refuse the switch to WAL
  without consulting the busy handler, so moving `busy_timeout` before it
  (`sqlite-destination-approval-store.ts:471–473`) does **not** help — measured
  6 / 3,600 reordered vs 3 / 3,600 original. The same unguarded pragma opens
  27 SQLite stores repo-wide; only this test races first openings.
- The hang: in the test's `race()`, a worker that throws while opening never
  posts `ready`, so the shared gate is never released; `Promise.all` rejects but
  `worker.terminate()` runs only on success, and the surviving workers stay in
  `Atomics.wait`, keeping the process alive. Observed twice (150 s test timeout)
  in the stress run.
- Production exposure: two processes creating the same store file at the same
  instant. It fails closed (open throws, nothing is written) — an availability
  edge, not an integrity or authorization issue.

Proposed remedies (**not applied**, pending review): (1) test-only — make
`race()` release the gate and terminate every worker on any error, so a failure
reports instead of hanging; (2) product — one shared helper that switches to
WAL with a bounded retry on `SQLITE_BUSY` (within the store's
`busyTimeoutMs`), adopted by the destination-approval store first and by the
other 26 stores as a separate change.

**Verdict.** P0-06 is clean: every P0-06 test passes, every failure observed
reproduces identically on the pristine baseline, and no P0-06 blocker remains.
The XRPL adapter is ready for P0-07 composition, subject to the RLUSD
representation decision in §24.
