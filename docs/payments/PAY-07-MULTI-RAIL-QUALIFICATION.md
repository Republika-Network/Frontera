# PAY-07 — Multi-Rail Qualification

- **Milestone:** PAY-07 (Master Plan §PAY), exit criteria §11.2 **CORE PROVEN**.
- **Depends on:** PAY-03 (XRPL production composition), PAY-06 (Lightning), ASSURE-01 (trace).
- **Kind:** qualification. **No production code changed**, no generic contract changed, no effect path added (NO_BYPASS stays 10 of 71).
- **Decision record:** `docs/architecture/ADR-PAYMENT-RAIL-CONFORMANCE-SUITE.md`.

> **Claim, precisely:** Frontera's payment governance is **qualified as rail-neutral against XRPL / RLUSD and Lightning / BTC under PAY-07.** Not "Frontera works with any rail".

---

## 1. Purpose

PAY-06 showed that the same CORE *can* govern a second, structurally different rail. PAY-07 proves that it *does, identically*: one canonical conformance suite, run inside one shared governed world, against both rails, over a CORE whose source is measured and shown byte-identical between the two runs — and checks the explicit PAY-07 concern that the XRPL rail, delivered first, did not shape the generic payment port (§12).

## 2. The five §11.2 criteria and their evidence

| # | §11.2 criterion | Evidence | Verdict |
|---|---|---|---|
| 1 | One representative flow end to end on XRPL and Lightning: agent → MPP → `PaymentIntent` → envelope → authority / policy / ceiling → grant → rail → settlement → evidence | MRC-01, MRC-06, MRC-07, MRC-11, MRC-13 on both rails (`pay07-multi-rail-qualification.test.ts`); MPP entry pinned structurally (`pay07-multi-rail-structure.test.ts` › M1 / M2 / Q3 / Q4) | **MET** |
| 2 | CORE source byte-identical between the two runs; rail-specific logic only in PAY adapters, proven structurally | Each run measures the CORE manifest and embeds its digest; both equal a fresh recomputation (`sha256:aecf58de…c60b`, 564 files, §6); closure, drift, CRLF and neutrality tests (`pay07-multi-rail-structure.test.ts`) | **MET** (one classified residual, §13 R1) |
| 3 | Unconfirmed → resolved reconciliation on both rails through P12 ports | MRC-03 (unresolved while undetermined), MRC-04 (resolved completed **after a restart**, then settled), MRC-05 (resolved not completed) on both rails | **MET** — both directions |
| 4 | ASSURE-01 trace verifies for both | The existing builder and verifier over the composition root's six reads verify MRC-01/02/03/04/05/08/09/10/11 on both rails | **MET** |
| 5 | Denied, over-ceiling and revoked-mid-flight behave identically on both rails | MRC-08, MRC-09, MRC-10: identical disposition, identical trace final state, zero external effects; report comparison | **MET** |

**CORE PROVEN (§11.2): ACHIEVED** — all five are executable, repeatable (`npm test`) and documented here.

## 3. Architecture of the qualification

```
                ┌────────────────────────────────────────────────────────────┐
                │ runPaymentRailConformanceSuite(harness)   — ONE suite      │
                │   src/features/payment-runtime/tests/conformance/          │
                │   imports nothing; knows no rail; decides every verdict    │
                └─────────────────────────────┬──────────────────────────────┘
                                              │ PaymentRailConformanceHarness (one shape)
                ┌─────────────────────────────┴──────────────────────────────┐
                │ createGovernedPaymentHarness(edge, coreDigest) — ONE world │
                │   src/enterprise/__tests__/pay07-governed-payment-world.ts │
                │   Kernel · Governance Store · CORE-03 · P10 · grant · ACE  │
                │   P7 · P11 (SQLite) · P12 (SQLite) · PAY-04 MPP ingress    │
                │   (SQLite, CORE-07-anchored) · PAY-05 (SQLite) · P8 stream │
                │   ASSURE-01 builder + verifier · PAY-01 bridge             │
                │   imports no rail                                          │
                └──────────────┬─────────────────────────────┬───────────────┘
                               │ PaymentRailEdge             │ PaymentRailEdge
               ┌───────────────┴──────────────┐ ┌────────────┴────────────────┐
               │ pay07-xrpl-edge.ts           │ │ pay07-lightning-edge.ts     │
               │ PAY-02 rail · PAY-03 external│ │ PAY-06 rail · BOLT11 book   │
               │ signer (reference process)   │ │ durable interlock (CORE-07) │
               │ durable interlock (CORE-07)  │ │ read-only P12 + preimage    │
               │ read-only P12 + finality     │ │ finality · node simulator   │
               │ PAY-03 ledger simulator      │ │                             │
               └──────────────────────────────┘ └─────────────────────────────┘
```

| File | Role | Knows rails? |
|---|---|---|
| `src/features/payment-runtime/tests/conformance/payment-rail-conformance-suite.ts` | The canonical suite, harness contract, closed report, comparison | **No** (no imports at all) |
| `src/enterprise/__tests__/pay07-core-source-manifest.ts` | CORE source manifest: roots, classification, canonical digest | No (Node built-ins only) |
| `src/enterprise/__tests__/pay07-governed-payment-world.ts` | The one shared governed world, composed identically per rail | **No** (structurally pinned) |
| `src/enterprise/__tests__/pay07-xrpl-edge.ts` | XRPL edge: everything XRPL-specific | Yes — the edge |
| `src/enterprise/__tests__/pay07-lightning-edge.ts` | Lightning edge: everything Lightning-specific | Yes — the edge |
| `src/enterprise/__tests__/pay07-multi-rail-qualification.test.ts` | Runs the suite on both rails; criteria; parity | Imports both edges, asserts identically |
| `src/enterprise/__tests__/pay07-multi-rail-structure.test.ts` | Structural / adversarial qualification | Scans |
| `src/features/payment-runtime/tests/conformance/payment-rail-conformance-suite.test.ts` | The suite judged against a synthetic reference model; mutations | No |

**Location.** The suite is test-only qualification code, so it lives beside the payment vertical's existing test fixtures (`tests/`), outside the PAY-01 contract scan, not as a package: the harnesses must reuse in-repository fixtures (`governed-action-support.ts`, PAY-03 / PAY-06 simulators) that a workspace package cannot import, and a private package would add a root dependency for test code. Nothing is exported from any entry point; no production source imports it (structurally pinned).

## 4. The harness contract

`PaymentRailConformanceHarness` — one shape for every rail, no discriminant:

| Member | Meaning |
|---|---|
| `implementationId` | An opaque label copied into the report. Never compared or switched on. |
| `coreManifestDigest` | The CORE manifest digest the run measured. |
| `economics` | The same logical bound in the rail asset's own unit: `ceiling`, `withinCeiling`, `overCeiling`. |
| `open(scenario)` | A fresh, isolated world. `scenario` = `{ behaviour: complete \| fail \| uncertain, principal: authorized \| unrecognized, amount: within-ceiling \| over-ceiling, revokeAfterClaim }`. |

`ConformanceWorld` capabilities: `presentRequirement()` (MPP, through PAY-04), `replayRequirement()` (same business operation), `externalEffects()` (provider-boundary money-moving calls), `railInstructions()` (what the PAY-01 rail port received), `ingress()`, `observation()` (P11), `resolveExternally()` (the provider becomes definitive; moves nothing), `reconcile()` (P12), `readSettlement()` / `verifySettlement()` / `receipt()` (PAY-05), `trace()` (ASSURE-01), `restart()`, `rollbackRefused()`, `close()`.

The harness returns **observations**; no capability returns a verdict (pinned). The suite never sees a ledger hash, a preimage, an invoice, a payment hash or an XRPL / Lightning field: provider references are opaque strings it only compares; finality facts are checked only to share one namespace prefix with the method.

## 5. Cases, version and the closed report

Suite version **`frontera.payment-rail-conformance.v1`** — a change to the required cases changes it deliberately.

| Case | What is qualified | Effects |
|---|---|---|
| MRC-01 | Governed success end to end: MPP → PaymentIntent → governance → grant → one rail effect → P11 completed → PAY-05 settled → receipt → trace | 1 |
| MRC-02 | Definitive non-completion: P11 confirmed-not-completed, not settleable, no receipt, replay sends nothing | 1 |
| MRC-03 | Uncertain initial execution: unconfirmed, two replays send nothing, P12 unresolved while undetermined, settlement execution-uncertain | 1 |
| MRC-04 | Uncertain → **restart** → explicit P12 confirmed-completed (bound to attempt and observation) → settled from the resolution | 1 |
| MRC-05 | Uncertain → explicit P12 confirmed-not-completed → not settleable, no receipt | 1 |
| MRC-06 | Completed ≠ settled: awaiting-finality and no receipt until the finality authority verifies; settlement names the recorded adapter | 1 |
| MRC-07 | Deterministic receipt: `frontera.payment-receipt.v1`, verified by the one generic verifier, refers to the settlement, re-reads identical | 1 |
| MRC-08 | Denied before execution (unrecognized principal): no grant, no attempt | 0 |
| MRC-09 | Over the shared P10 ceiling: withheld at issuance, no grant | 0 |
| MRC-10 | Revoked mid-flight: grant revoked after the write-ahead claim, before the exercise checkpoint | 0 |
| MRC-11 | ASSURE-01 trace of the success: every stage on the path recorded; no resolution inferred | 1 |
| MRC-12 | Business-operation replay: same request, same execution, not re-decided | 1 |
| MRC-13 | Exact money and destination preserved across protocol → Kernel → rail port → P11 → trace → settlement | 1 |
| MRC-14 | Deterministic correlation: one execution id; one opaque provider reference across rail, P11, P12, PAY-05, trace | 1 |
| MRC-15 | Rollback safety: the rail's durable interlock refuses a stale restore | 1 |
| MRC-16 | CORE manifest digest well-formed; every observed token generic | 0 |

Report (`PaymentRailConformanceReport`): `suiteVersion`, `implementationId`, `coreManifestDigest`, `passed`, and per case `caseId`, `passed`, `phase` / `reason` (bounded generic tokens, only on failure), `externalEffects`, `lifecycle` (the generic signature, e.g. `{ status: executed, p11: confirmed-completed, settlement: settled, basis: provider-confirmed-completed, trace: executed-confirmed-completed }`). No provider reference, invoice, preimage, transaction, key, route, clock or path — asserted. Canonical text (`canonicalConformanceReportText`) is byte-identical across runs. Reports are generated by the test run, not committed (they would be environment-free, but the tree's digest is the evidence, §6).

`comparePaymentRailConformanceReports(a, b)`: equivalent only when both passed, under the same suite version and CORE digest, with the same case ids in order and identical verdicts, effect counts and lifecycle signatures per case. Implementation ids are the only permitted difference.

## 6. The CORE source manifest

**Definition** (`pay07-core-source-manifest.ts`): an explicit, reviewed list of 40 include roots (Kernel, P10 authority, policy, CORE-03, grant, governed path, P7, P9, P11, P12, CORE-04, CORE-07, P8 / ASSURE-01, the generic PAY-01 contract and bridge, PAY-04 ingress and MPP adapter, PAY-05, and the two governed-authority packages), each with its reason. Every `.ts` under a root is included automatically; `__tests__/`, `tests/`, `fixtures/` and `*.test.ts` are not CORE. Rails (`rails/xrpl`, `rails/lightning`), the rail edges (`xrpl-payment-rail`, `lightning-payment-rail`) and the Host composition edge (`host`, `composition`, `configuration`) are classified **outside** with reasons; every directory beside a CORE root must be classified, so a new one fails until reviewed.

**Construction.** `line = <relative posix path> SP <sha256 of LF-normalized bytes> LF`; `text = "frontera.core-source-manifest.v1" LF line*` in lexicographic path order; `digest = "sha256:" sha256(text)`. No timestamp, no absolute path, no environment.

**CRLF.** Only CRLF pairs are normalized — exactly the inverse of `core.autocrlf=true`'s checkout transformation — so a Windows working copy and a Linux CI checkout of the same commit measure the same digest; a lone CR or any other byte changes it (tested). Measured on this commit: the LF Linux clone and the CRLF Windows worktree both give **`sha256:aecf58dee10cdf71a8de9d26e14a6be7cd86698a1dd302cd7c239698aaa1c60b`** over **564** files, which is also the digest of the baseline `main @ b1825bd` — PAY-07 changed no CORE byte.

**Coverage proof.** The structural test computes the shared governed payment path's runtime import closure (orchestrator, ACE, issuance core, P10 resolver, Kernel, grant and P7 runtimes, P11 / P12 SQLite stores and reconciliation, CORE-03, CORE-07, P8, the trace builder, PAY-05, PAY-04 ingress, the PAY-01 entry and MPP) and requires every file in it to be in the manifest, no rail file to be reached, and every workspace dependency to be a manifest root. It caught one omission during PAY-07 (`src/enterprise/version.ts`, runtime-imported by the governed path), now a root. Dropping the orchestrator's root is detected (M7).

| Manifest test | Proves |
|---|---|
| CORE-1 / CORE-2 / CORE-3 | Each rail run's report embeds the digest it measured; both equal each other and a fresh recomputation |
| CORE-4 | One byte added to the orchestrator, P12 service, trace builder, PAY-01 port or Kernel changes the digest |
| CORE-5 | Rail sources are outside CORE; mutating every rail file leaves the digest unchanged |
| CORE-6 | CRLF working copy → same digest; lone CR → different |
| CORE-7 | Lexicographic, order-independent input |
| CORE-8 | Relative posix paths, no absolute path, no timestamp |

## 7. Representative flows and what differs

Both representative flows begin at the PAY-04 boundary with one MPP `Payment` challenge (`realm="api.merchant.example"`, `intent="charge"`, expiring 12:05, observed 12:00), for business operation `pay07-checkout-1`, protected request `GET merchant:report-42`, purpose `vendor-payment`, business reference `INV-PAY07-1`.

| Held constant (shared world) | Differs (an external fact; edge only) |
|---|---|
| Organization `org-datasys`, principal, actor, authority lineage | Rail id (`xrpl-rlusd` / `lightning-btc`) |
| Governance Profile `governed-payment`, CORE-03 dimensions, reserved keys | Asset and exact unit (`stable:RLUSD/test-issuer` scale 15 / `net:BTC` scale 11) |
| The real Kernel and its decision semantics | MPP method normalizer (`ledgerpay` / `lnpay`) — trusted host composition, rail preference on PAY-01's `rail` |
| P10: one `max_amount` ceiling and one lifetime `spending_limit`, same relationship | Destination (`xrpl-tagged-account` address:tag / Lightning payee + payment hash from a trusted invoice book) |
| Grant policy, P7 policy and ledger, write-ahead claim | Provider and its evidence (validated ledger / preimage), simulated deterministically |
| PAY-04 ingress with a CORE-07-anchored SQLite business-operation store | The durable interlock implementation (each anchored at the same CORE-07 witness kind) |
| P11, P12, PAY-05 SQLite stores; P8 stream; ASSURE-01 builder and verifier | |
| The revocation checkpoint (`beforeExercise`: after grant and claim, before the exercise gate) | |

**Economic equivalence** means the same governance scenario and policy relationship — **not** the same market value. No FX, no oracle, no conversion:

| | XRPL / RLUSD | Lightning / BTC |
|---|---|---|
| Ceiling (P10 `max_amount`) | 1000 | 0.001 |
| Within (2.5 % of ceiling) | 25 | 0.000025 (2 500 000 msat) |
| Over (1.00001 × ceiling) | 1000.01 | 0.00100001 |
| Lifetime limit (100 × ceiling) | 100000 | 0.1 |

The suite checks `within ≤ ceiling < over` with exact decimal arithmetic (BigInt, no float) and that all three share the rail's unit.

## 8. Comparative results (both runs, identical)

| Case | XRPL | Lightning | Generic expectation |
|---|---|---|---|
| Success | one submit → P11 completed → validated-ledger finality → settled | one send → P11 completed → preimage finality → settled | `executed` → `awaiting-finality` → `settled` (`provider-confirmed-completed`), receipt verifies, trace `executed-confirmed-completed` |
| Definitive failure | validated `tec` | terminal node failure | `execution_failed`, `confirmed-not-completed`, `not-settleable`, no receipt |
| Uncertain | submission lost after send | HTLC held | `execution_unconfirmed`, replays send nothing, P12 `unresolved`, `execution-uncertain` |
| Uncertain → completed (after restart) | ledger validates `tesSUCCESS`; XRPL P12 authority | payee settles; Lightning P12 authority | P12 `confirmed-completed` bound to attempt + observation; settled (`resolution-confirmed-completed`); trace `resolved-confirmed-completed`; 1 effect total |
| Uncertain → not completed | ledger validates `tec` | payee cancels | P12 `confirmed-not-completed`; `not-settleable`; trace `resolved-confirmed-not-completed`; 1 effect total |
| Denied | no submit | no send | `denied`; no grant; trace `denied` (authority `not-applicable`); 0 effects |
| Over ceiling | no submit | no send | `withheld` by `authority-binding`, `FINANCIAL_AUTHORITY_CEILING_EXCEEDED`; no grant; trace `not-executed`; 0 effects |
| Revoked mid-flight | no submit | no send | `withheld` by `exercise`, `GRANT_EXERCISE_REVOKED`; grant recorded with revocation, claim recorded, P11 `withheld`; trace `withheld-at-exercise`; 0 effects |
| Trace | verified | verified | ASSURE-01 verifies; stages approval `not-applicable`, obligations `not-composed`, all others `recorded`, resolution `not-applicable` |
| Rollback | stale interlock refused | stale interlock refused | `AUTHORITY_FRESHNESS_ROLLBACK_DETECTED` (CORE-07) on both |

The over-ceiling disposition was **audited, not chosen**: the first run expected `withheld` at `issuance` and both rails answered `authority-binding` (P10's financial-authority withholding, `orchestrator.ts`); the expectation was corrected to the shared answer — they match each other because they share governance.

## 9. P12, finality, receipts and the trace

- **P12 port unchanged.** The same `ExecutionResolutionAuthority` / `ExecutionResolutionQuery` accommodates ledger-style reconciliation (XRPL: validated result or proven expiry by hash) and logical-payment reconciliation (Lightning: payment status by hash, bound to the payer node). Both resolution directions are real rail states, so both are qualified — none faked.
- **No resend.** Effects are counted after every replay, P12 call (before and after a second call, and after a restart), finality verification, receipt read and trace build: one in total for every executing case.
- **PAY-05 finality port unchanged.** The suite sees only `settled` / `not-final` / contradicted outcomes and bounded evidence: a method and fact names under one rail namespace, an opaque provider reference equal to P11's, the exact amount. `finalizedAt` is optional — XRPL supplies the validated ledger's close time, Lightning none — and the port accommodates both without a rail field.
- **Completed ≠ settled.** P11 `confirmed-completed` reads `awaiting-finality` with no receipt until the finality authority verifies; P7's "settled" (capacity) is never consulted as funds settlement.
- **Receipts.** The one generic `verifyPaymentReceipt` accepts both rails' receipts; no rail-specific validator exists. Receipt digests differ between rails (different payments) and are never compared.
- **ASSURE-01.** The trace is built by the unchanged `buildAuthorityTrace` over exactly the composition root's narrow reads (governance, grants, reservations, outcomes, resolutions, events) and verified by `authorityTraceVerificationOf`: the canonical, pre-disclosure trace — the strongest level, of which every disclosure tier is a projection. No PAY-07 trace model, no new durable format, nothing signed. Approvals and obligations are not composed (no scenario reaches them) and are reported `not-applicable` / `not-composed`, never inferred.

## 10. External-effect counts

Measured at each rail's provider boundary (`submit` on the PAY-03 ledger simulator; `sendPayment` on the PAY-06 node simulator), never at the harness:

| Success | Denied | Over ceiling | Revoked | Unconfirmed | + P12 | + finality | + trace | + replay |
|---|---|---|---|---|---|---|---|---|
| 1 | 0 | 0 | 0 | 1 | +0 | +0 | +0 | +0 |

## 11. Contract field audit — did XRPL shape the port?

| Contract.field | Generic meaning | XRPL use | Lightning use | Conclusion |
|---|---|---|---|---|
| `PaymentIntent.source.accountId` | The governed resource funds leave | Mapped by trusted config to a classic address | Allow-listed source account (the payer node pays) | Generic resource id, not an address |
| `PaymentIntent.destination.{kind,reference}` | Opaque, host-vocabulary destination | `xrpl-tagged-account`, `address:tag` | `lightning-invoice`, `payee:paymentHash` | Opaque; no generic code enumerates or compares a kind with a literal (§34 test) |
| `PaymentIntent.amount` | Exact P9 amount | RLUSD decimal | BTC decimal → exact msat in the rail | Generic; no float anywhere |
| `purpose`, `reference`, `rail`, `idempotencyKey`, `correlationId` | Governed parameters / identity | Used as-is | Used as-is | Generic |
| `PaymentExecutionRequest.executionId` | Stable execution identity | Interlock key | Interlock key | Generic |
| `requestId`, `decisionId`, `grantId` | Correlation | Interlock record | Interlock record | Generic |
| `notAfter` | The covering grant's end | **Not consumed** (window from `lastLedgerOffset`) | **Not consumed** (`paymentTimeoutSeconds`) | Generic and meaningful for both; unconsumed by both (§13 R3) — not XRPL-shaped |
| `source`, `destination`, `amount`, `purpose`, `reference`, `rail` | The granted payment | Used | Used | Generic |
| `PaymentRail.railId` / `execute` | Identity, one effect | ✓ | ✓ | Generic |
| `PaymentRailResult.status` | completed / not-completed / unconfirmed | validated success / `tec`·`tem` / lost or pending | succeeded / terminal failure / in flight·timeout·disconnect | Generic three-valued certainty |
| `PaymentRailResult.externalReference` | Opaque provider handle | Transaction hash | Payment hash | Opaque; grammar knows no hash format; never parsed (§33 test) |
| `reason`, `detail` | Closed failure reason; bounded token | ✓ | ✓ | Generic |
| P11 observation `certainty` / `providerRef` / `adapterId` | Provider certainty and handle | ✓ | ✓ | Generic |
| P12 `ExecutionResolutionQuery` (ids, `amount`, `providerRef`, `basis`) | What an authority is asked | Lookup by hash, amount check | Status by payment hash, amount check | Generic; unchanged |
| P12 result `certainty` / `failure` / `providerRef` | Closed answer | ✓ | ✓ | Generic |
| `PaymentFinalityQuery` (ids, `basis`, `railId`, `providerRef`, `payment`) | What a finality authority is asked | ✓ | ✓ | Generic; unchanged |
| `PaymentFinalityEvidence.method` | `<rail>.<method>.v<n>` | `xrpl.validated-ledger.v1` | `lightning.preimage.v1` | Generic namespace rule |
| `…facts` | Namespaced bounded facts | `xrpl.*` | `lightning.*` | Generic container; names are the rail's |
| `…finalizedAt` | Rail-established instant, optional | Ledger close time | Absent | Optional precisely so neither rail shapes it |
| `PaymentSettlementRecord` (`basis`, `railId`, `finality`, `payment`, digests) | The recorded settlement | ✓ | ✓ | Generic |
| `PaymentReceipt` (`format`, ids, `railId`, `payment`, `finality{authorityId,method,providerRef,finalizedAt,proofDigest}`) | Derived receipt | ✓ | ✓ | Generic; one verifier |

**Conclusion.** Every field of PAY-01's rail port and request, P11's provider reference, P12's query and answer, PAY-05's finality port, settlement record and receipt maps cleanly to both rails; none is account- or ledger-shaped. **The XRPL rail did not shape the generic payment port.** It did leave one identifier in a CORE layer outside the payment port — CORE-07's slot name `'xrpl-submission-reservations'` (§13 R1) — vocabulary only, classified and pinned.

**Fee neutrality.** `PaymentIntent.amount` is the principal transfer amount on both rails; P7 / P10 govern it. XRPL's network fee and Lightning's routing fee never reach a generic port; Lightning's cap is trusted rail configuration (SEC-INV-266). No generic fee governance is invented here (§13 R4).

## 12. Structural and adversarial qualification

`pay07-multi-rail-structure.test.ts`: the suite imports nothing and names no rail, rail id or asset; `implementationId` is only declared and copied (every use pattern-matched); one harness shape, no union; the runner iterates the closed constant; no self-certification field crosses the contract; the shared world imports no rail and names none, enters only through one `prepareAndGovern`, reaches the rail only through one `createPaymentRailExecutionAdapter`, and asserts ASSURE's own verdict over the six reads; no production source imports qualification code; every PAY-07 file is under `tests/` or `__tests__/`; manifest CORE-4 … CORE-8, closure, drift; no CORE source names XRPL or Lightning vocabulary or imports rail code (one classified identifier); ASSURE-01 and PAY-04 name no rail; the generic ports' field lists are pinned; no generic layer parses a provider reference or compares a destination kind with a literal; the PAY-05 finality port is unchanged.

**Mutations** (all caught, all restored byte for byte):

| # | Mutation | Caught by |
|---|---|---|
| M1 / M2 | The world calls the orchestrator directly (bypassing MPP) | structure › M1 / M2 / Q3 / Q4; self-test (`protocol-not-mpp`) |
| M3 | A denied payment moves money | self-test (MRC-08 `external-effects-1-expected-0`); real world (principal ignored) fails both rails |
| M4 | An over-ceiling payment reaches the rail | self-test (MRC-09); real XRPL edge with a raised ceiling fails XRPL and parity |
| M5 | P12 adds one send | self-test (MRC-03); real Lightning authority adding a send fails Lightning and parity |
| M6 | One rail produces a different generic outcome / comparison ignores lifecycle or effects | self-test (`M6 / Q12`); real Lightning edge mapping `fail` → `hold` fails Lightning and parity |
| M7 | Manifest omits the orchestrator | structure (closure, CORE-4) |
| M8 | Comparison ignores the CORE digest; runs measure different CORE | self-test (`M8`); qualification criterion 2 and parity |
| M9 | ASSURE verification skipped (suite check removed; world hard-codes `verified`; events source dropped) | self-test (`M9`); structure (`M9 / Q10`); qualification (both rails fail) |
| M10 | P11 completion treated as settlement | self-test (`M10`); real world mapping fails both rails |
| M11 / M12 | An `xrpl` / Lightning branch added to the suite | structure (vocabulary, no-branch) |
| — | Revocation never armed | qualification (both rails fail MRC-10) |
| — | Suite drops the post-P12 effect check | self-test (`M5`) |

### 12.1 Coexistence extension (PAY-09 multi-rail hardening)

The canonical suite composes one rail per world, behind its own witness — so it
could not see that PAY-06's and PAY-09's interlocks shared one CORE-07 slot and
could not both exist in one organization. `pay07-multi-rail-coexistence.test.ts`
adds the missing claim **without changing the canonical suite**: the same
CORE, one organization, one CORE-07 witness, one state directory, and the
XRPL, Lightning and Stripe edges composed side by side — opened in either
order, executed with independent provider effects, each history advancing
only its own slot, a stale restore of one refused while the other keeps
executing, and both restarted in either order (COEX-1 … COEX-4, COEX-7,
COEX-8, COEX-15, COEX-16). It uses only generic edge capabilities. The
underlying CORE-07 change is generic namespacing
(`ADR-AUTHORITY-STATE-NAMESPACED-SLOTS.md`).

## 13. Residuals

| # | Residual | Classification |
|---|---|---|
| R1 | CORE-07's closed slot list names `'xrpl-submission-reservations'` (PAY-03). An opaque identifier — CORE-07 runs no XRPL logic — but rail vocabulary in a CORE layer, left by XRPL-first delivery; PAY-06 used the neutral `'payment-initiation-reservations'`. Renaming it migrates witness state persisted by PAY-03 deployments, so PAY-07 classifies and pins it (the only rail word in CORE) rather than changing CORE. A future CORE-07 migration may alias it. | Vocabulary residual, not a semantic dependency; does not affect the payment port |
| R2 | Qualification runs on PAY-03's ledger simulator and PAY-06's node simulator (deterministic, CI-safe). The rails, interlocks, authorities, signer protocol and CORE are the real code. Live evidence is reused, not re-run: PAY-03 / PAY-05 XRPL Testnet, PAY-06 real LND v0.20.5 regtest (8 / 8). No mainnet. | Accepted scope |
| R3 | `PaymentExecutionRequest.notAfter` is consumed by neither rail; each bounds its provider-side window by its own trusted configuration. Generic, not XRPL-shaped. | Pre-existing; unchanged |
| R4 | Fees: P7 / P10 govern the principal; rail fees are trusted rail configuration. No fee-inclusive generic governance. | Pre-existing (SEC-INV-266 residual) |
| R5 | The governance, grant, P7 ledger and event stores are in-memory in the qualification world and survive the recomposition as objects; P11, P12, PAY-05, the business-operation store and both interlocks are SQLite and are reopened from disk on restart (PAY-06's restart pattern). Host-level durability of the spine is qualified elsewhere (PROD-02). | Accepted scope |
| R6 | The over-ceiling case uses the P10 per-execution ceiling; aggregate (lifetime) limits are composed identically but not separately exercised here. | Accepted scope |
| R7 | The Lightning rail and PAY-05 remain embedder-composed; the shipped Host composes XRPL only. The qualification composes both the way an embedder does. | Pre-existing |

## 14. What CORE PROVEN means — and does not

**Means:** the same CORE — byte-identical, measured — governs XRPL / RLUSD and Lightning / BTC identically through the same protocol ingress, governance, P11, P12, PAY-05 and ASSURE-01, as demonstrated by one suite under the qualified flows.

**Does not mean:** every blockchain, fiat rails, Stripe (PAY-09), x402 (PAY-08), BOLT12, EVM, credit, merchant identity, fee governance, mainnet operation, or that "Frontera works with any rail". It is distinct from GOVERNED ACTION THESIS PROVEN (§11.6, action neutrality), with which it shares no criteria.

## 15. Validation and how to re-run

```
npm run build
node --test dist/src/enterprise/__tests__/pay07-multi-rail-qualification.test.js \
            dist/src/enterprise/__tests__/pay07-multi-rail-structure.test.js \
            dist/src/features/payment-runtime/tests/conformance/payment-rail-conformance-suite.test.js
```

All three run in `npm test`; no network, no credential, no external process beyond the in-process CORE-07 witness and PAY-03's loopback reference signer. Security records: SEC-INV-276 … SEC-INV-282 (`SECURITY_INVARIANTS.md` §4.28, claim 16l); threat model §7.33 (Q1 … Q14); CORE-06 matrix TM-7.33-1 … TM-7.33-12.
