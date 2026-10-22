# G-02A — Generic Signed Execution Capability: Security Statement

**Design:** `docs/architecture/ADR-GENERIC-SIGNED-EXECUTION-CAPABILITIES.md`
**Invariants:** SEC-INV-357 … SEC-INV-366 (`SECURITY_INVARIANTS.md` §4.38)
**Profile:** the qualified single-organization secure Host architecture. Multi-organization shared hosting stays outside it until G-01B2; embedders are trusted code (G-01C §5).

## 1. What G-02A ships, and what it does not

| Ships | Does not ship |
|---|---|
| `frontera.execution-capability.v1` contract and canonical codec | any operation that signs a capability (G-02B) |
| a standalone verifier (`execution-capability/verifier.ts`) | Host audience configuration or issuer registration (G-02B) |
| a reference durable single-use consumption ledger | executor integration or signed receipts (G-02C) |
| two CORE-02 leaf modules, split out unchanged | online status or revocation answers (G-02D) |
| | a published package or a public route |

No Kernel, CORE-07, v1 route, P11/P12, TRADE-04C-S1, adapter or schema change. No new dependency.

## 2. Four separate questions

| Question | Answered by | Never implied by |
|---|---|---|
| Is this the canonical capability a pinned issuer key signed, for this executor, organization and trust domain, in its window, for exactly this action and binding? | `verify()` → `verification` | — |
| Has it been revoked, or has execution been stopped, since issuance? | `freshness` — offline: `not-observed` | a valid signature |
| May it be used now, once? | `consumption.eligible`, then the ledger's `claim` | `verification: 'verified'` |
| What happened when the executor acted? | the executor (ledger outcome = its own statement; signed receipts in G-02C) | a claim |

## 3. Offline and online limits

- **Revocation latency.** An offline executor cannot see a grant revoked, or an emergency stop activated, after the capability was issued. The window (≤ 60 s; 30 s intended) bounds that exposure; it does not eliminate it. The verifier reports `revocation: 'not-observed'`, `emergencyStop: 'not-observed'` and `exposureBoundedUntil`.
- **Status-required capabilities fail closed.** Without an authoritative status mechanism (G-02D), an `online-status-required` capability verifies cryptographically but is never eligible for consumption, and the ledger refuses it.
- **Clocks.** Expiry has no skew allowance; `issuedAt` may lead the executor's clock by at most 5 s. A clock that does not answer refuses (`CLOCK_UNAVAILABLE`); a clock that throws fails closed (`VERIFIER_FAILURE`). The ledger re-checks expiry at claim time against its own clock.
- **Single use is per ledger.** Executor instances with separate ledger files are separate consumption domains and would each accept the same capability once (tested). Global single use requires one shared ledger.
- **Not exactly-once.** A claim commits before the side effect; a crash afterwards leaves `claimed` (authorized, possibly attempted, outcome not recorded) and the capability is never claimable again. Whether the effect happened is reconciliation's question.
- **The ledger is as trustworthy as its host.** Whoever can rewrite or restore the file can forget a consumption; it is not anchored against rollback.

## 4. Adversarial coverage

| Threat | Result | Test |
|---|---|---|
| Forged signature (untrusted key claiming a pinned id), flipped bit, truncated signature, unsupported algorithm, other artifact version | `SIGNATURE_INVALID` with the CORE-02 reason | `g02a-execution-capability.test.ts` |
| Wrong issuer; key pinned for another issuer; envelope key ≠ named key; unknown key | `ISSUER_UNTRUSTED` / `ISSUER_KEY_MISMATCH` | same |
| Cross-artifact substitution (no domain, S1 domain, grant domain, a genuine revocation-state signature); capability signature as another artifact | refused both ways | same |
| Wrong audience, audience pattern, cross-executor replay | `AUDIENCE_MISMATCH`; `*` unrepresentable | same |
| Cross-organization, cross-trust-domain replay | `ORGANIZATION_MISMATCH`, `TRUST_DOMAIN_MISMATCH` | same |
| Any signed field modified after signing | `SIGNATURE_INVALID` (every field) | same |
| Modified request, other binding format, non-JSON binding (accessor, `undefined`, class, sparse array, symbol, bigint, malformed Unicode) | `ACTION_BINDING_MISMATCH` / `_FORMAT_MISMATCH` / `_MALFORMED`; an accessor is never invoked | same |
| Expired, not yet valid, lifetime > 60 s or ≤ 0 | `CAPABILITY_EXPIRED` / `_NOT_YET_VALID` / `_LIFETIME_INVALID` (boundaries tested) | same |
| Non-canonical text: reordering (top level and nested binding), whitespace, escape, duplicate keys (agreeing or not), numbers, NFC/NFD, raw and escaped unpaired surrogates, extra/missing fields, other format version | refused, never normalized | same |
| Key rotation | overlap verifies; unpinning refuses only the old key's capabilities | same |
| Duplicate consumption, second capability for one execution, restart, re-initialization, missing file, foreign file, stripped triggers, other audience | refused | `g02a-execution-capability-ledger.test.ts` |
| Concurrent consumption (two connections; four threads released at one instant) | exactly one claim | same |
| Retry after timeout; crash after execution before acknowledgment | one side effect; outcome visibly unrecorded | same |
| Shape-alike or rejected verification presented to the ledger | `NOT_VERIFIED` | same |
| Verifier import closure; no signing material or operation; S1 untouched; no grant import | pinned | `g02a-execution-capability-structure.test.ts` |
| Removal of each load-bearing check | 24 mutants detected | `g02a-execution-capability-mutation.test.ts` |

Forged execution receipts and invalid or missing provenance belong to G-02C (receipts) and G-02B (issuance from a governed decision); G-02A has neither surface.

## 5. Residual risks

| ID | Risk | Owner |
|---|---|---|
| G02A-R1 | Offline revocation latency up to the capability window | G-02D (status); short windows |
| G02A-R2 | Executor ledger rollback or deletion forgets consumptions | executor deployment; not anchored |
| G02A-R3 | Separate ledgers are separate consumption domains | executor deployment (shared ledger) |
| G02A-R4 | The CORE-02 trust caveats apply unchanged: AA-001 (software custody), AA-002 (configuration controls trust — now also each executor's pinned issuer keys), AA-010 (a compromised Host may request signatures once G-02B exists) | CORE-02 / G-02B |
| G02A-R5 | `subjectActorId` lets an executor correlate one actor's actions over time | inherent; documented |
| G02A-R6 | Executor-recorded outcomes are unauthenticated statements | G-02C (signed receipts) |
| G02A-R7 | Exactly-once external execution is not provided | reconciliation (P11/P12) |
