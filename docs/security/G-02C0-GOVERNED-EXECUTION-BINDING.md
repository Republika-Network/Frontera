# G-02C0 — Governed Execution Binding and Safety Gate: Security Statement

**Design:** `docs/architecture/ADR-GOVERNED-EXECUTION-BINDING.md`
**Invariants:** SEC-INV-375 … SEC-INV-380 (`SECURITY_INVARIANTS.md` §4.40)
**Profile:** the qualified single-organization secure Host. Opt-in per Generic HTTP adapter. No capability is presented to anyone.

## 1. What G-02C0 ships, and what it does not

| Ships | Does not ship |
|---|---|
| `frontera.http-request-binding.v1` over the exact frozen request (`execution-adapters/generic-http/request-binding.ts`) | presentation, transmission or any capability header (G-02C1) |
| an internal pre-send hook in the Generic HTTP core: after mapping, before DNS; it can only stop a request | executor receipts (G-02C1), online status (G-02D) |
| the gate (`execution-capability-gate/`): issue through the G-02B slot, verify as the executor would, re-read the emergency stop | a route, response field, boot option or public export |
| `executionCapabilities.adapters` (Host) and the composition that binds the gates | a schema change, a new effect path, or a change to Kernel, orchestrator, exercise gate, registry, `ValidatedExecutionAction`, P11/P12, G-02A or the G-02B custody contract |

## 2. The binding representation: excludes exactly one thing

The record is computed from the `GenericHttpWireRequest` object that the
adapter then passes to `runtime.send`. It is never a copy, a re-mapping or a
caller value.

| Request semantics | In the record |
|---|---|
| method | `method` |
| scheme, host, port | `origin` (`https` only; the transport derives `Host`, SNI and certificate checks from it) |
| path and query, encoded, byte for byte | `target` |
| every mapped header: governed values, operator literals, `content-type`, `content-length` | `headers`, sorted by name (names are lower-case and unique) |
| which header carried the credential | `credentialHeader` (the **name**) |
| the body, exact UTF-8 text (exact JSON number tokens included) | `body` (`null` when absent) |
| **the credential value** | **excluded**: a secret and operator configuration; never governed input |

The Node transport adds `host` and its connection and framing headers itself.
They are not in the wire request, and they are fixed functions of the bound
origin, method and body. Rotating the provider credential leaves the record
unchanged, which is deliberate and tested. Every governed value (amount, unit,
counterparty, resource, typed parameters, subject, execution id) changes the
digest, and each of these is tested. Removing any field from the record is
detected by a mutant.

## 3. The gate's guarantee, and its source

A gated adapter sends only when all of the following hold:

1. The G-02B issuer issued a capability **for the digest of that exact record**.
   The issuer re-reads the grant through the authenticated store and refuses a
   revoked one. It reserves durably, asks custody once, and verifies the
   signature under the active key.
2. The standalone G-02A verifier, acting as the adapter's audience and pinned
   to this deployment's issuer and active key only, verifies it against the
   record recomputed in the gate. That covers canonical form, signature,
   organization, trust domain, window, action, resource and binding.
3. The capability's `executionId` and `subjectActorId` equal the action's, and
   it expires no later than the action's `notAfter`.
4. The adapter-scoped emergency stop, read **after** issuance, is clear.

The request is a pure function of the frozen action and the trusted plan. The
action was contained in the grant by the exercise gate: action, resource,
organization, amount ceiling and typed parameters (CORE-08). So the capability
can authorize nothing broader or different from what governance admitted.
Substituting a value changes the request, and therefore the digest.

**What this does not change:** custody still does not compare amount,
counterparty or parameters (G02B-R5). A caller of custody other than this gate
(a holder of the custody credential, or in-process code, AA-010) is bounded as
before.

## 4. Failure ordering

| Point | Sent? | Adapter result | Issuance ledger |
|---|---|---|---|
| request unbuildable | no | `failed` / `ADAPTER_ERROR` (gate never called) | — |
| gate unbound, issuer slot unbound, adapter id mismatch | no | `failed` / `ADAPTER_ERROR` | — |
| ledger already holds the execution (a re-exercise) | no | same | unchanged; custody not asked |
| grant absent, unreadable or revoked; custody rule refuses | no | same | no row |
| custody fails or times out; returned signature invalid | no | same | `uncertain`; never reissued |
| verification, execution, subject or window mismatch | no | same | as the issuer left it |
| stop declared during issuance | no | same | `issued` — never presented |
| gate throws, or answers anything but own `proceed: true` | no | same | as the issuer left it |
| proceed | DNS, address policy, one send | the existing classification | `issued` |

A refusal is a definite `failed`, because the request was never sent. P11
records it, P12 is untouched, and the P7 reservation is released, as for every
`failed`.

## 5. Rollback, replay and durability

The safety guarantees that hold are limited to the following, and
exactly-once is **not** claimed:

| Scenario | Effect |
|---|---|
| Replay of the governed request | Answered from the append-once governance claim; the adapter is not reached again, so there is no second issuance or send (tested) |
| Re-exercise of one execution | The issuance ledger refuses a second identity; the gate withholds (tested) |
| Restored issuance ledger alone | Issuance runs only inside the exercise, after the claim, so a duplicate also needs the Governance Store rolled back. This is harder than G-02B's D7, but **not prevented** (G02B-R1 stays a deployment blocker) |
| Two Hosts with independent ledgers | Executes twice only if both exercise one execution; an executor refuses the duplicate within one consumption domain only |
| Crash after issuance, before send | The claim exists and the outcome is unknown; nothing re-runs, and the capability was never presented |
| Custody-credential holder signing directly | Unchanged (G02B-R3, AA-010) |
| Revocation | Read by the issuer before reservation. A revocation during the custody call is bounded by the window (≤ 60 s). Offline executors never observe it |
| Uncertain provider outcome | `unconfirmed` → P11 → P12, unchanged |

**Enforced in G-02C0:** the binding over the exact sent request; issuance
only inside a gated adapter's `execute()`; self-verification; the emergency
re-check; fail closed; no presentation.

**Simulated (tests only):** an executor recomputing the record over the
request a fake network received, then verifying and consuming once with
G-02A's reference ledger.

**Blocked for production:**

- rollback-resistant issuance (D7);
- one shared consumption domain per audience;
- custody-side containment;
- presentation and receipts (G-02C1);
- online status (G-02D).

## 6. Adversarial coverage

| Threat | Result | Test |
|---|---|---|
| Substituted amount, unit, counterparty, resource, typed parameter, subject or execution | digest changes | `g02c0-execution-binding-gate.test.ts` §1 |
| Credential in the record; another header moved into the excluded slot | refused, digest changes | same |
| Gate verdicts `false`, `undefined`, `null`, `true`, `'true'`, `1`, inherited, getter; throw; rejection | withheld: no DNS, no send | §2 |
| Gate shown the request object or credential; gate mutating the record | impossible (subject has three fields; frozen) | §2; structure |
| Revoked, absent or foreign-action grant; action disagreeing with its grant | withheld, no custody call where refused locally | §3 |
| Re-exercise; custody failure | one custody call ever; `uncertain` row | §3 |
| Emergency stop during custody; unreadable stop; stop on another adapter | withheld / withheld / proceeds | §3 |
| Compromised issuer: another request, format, execution, subject, audience, action, resource, organization or issuer; expired; past `notAfter`; unpinned key; signature over other bytes; no signature | withheld, nothing sent | §4 |
| Governed path end to end; replay; custody refusal | one send and one issuance; no second; `ADAPTER_ERROR` | §5 |
| Shipped Host (authenticated store, custody, ledger) | one issued row bound to the recomputed request; no socket | `g02c0-execution-binding-host.test.ts` |
| Bad `executionCapabilities.adapters` | startup refused | same |
| Removal of each load-bearing control | 19 mutants detected | `g02c0-execution-binding-mutation.test.ts` |
| Ordering, purity, surface and protected contracts | pinned | `g02c0-execution-binding-structure.test.ts` |

## 7. Residual risks

| ID | Risk | Owner |
|---|---|---|
| G02C0-R1 | Issuance is awaited between the registry's emergency read and the send. The gate re-reads the stop after issuance, but a stop declared during the following DNS await is not observed. That window existed before G-02C0 | documented |
| G02C0-R2 | A revocation committed during the custody call is not observed before sending; it is bounded by the capability window | G-02D |
| G02C0-R3 | Under external custody, a gated `execute()` makes one custody request (EP-056) before the provider request. Custody latency counts toward the request path, but not the adapter's provider timeout | documented |
| G02C0-R4 | A gated adapter reached by a path whose execution id is not the governed derivation (for example the legacy authority-controlled execution service) is always withheld: custody refuses the derivation | fail closed; documented |
| G02C0-R5 | The credential value is not bound. Swapping the provider credential (operator configuration) does not change the digest | by design |
| G02C0-R6 | The capability is discarded after verification. An executor cannot yet check it (no presentation), so G-02C0 protects against Host-internal substitution, not a compromised Host | G-02C1 |
| G02B-R1 … R12 | Unchanged; R5 is narrowed for this caller only | as in G-02B |
