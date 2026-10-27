# AUTH-04D2S — Verified Synthetic Execution

- **Status:** implementation and CI qualification. Nothing deployed or provisioned.
- **Baseline:** `main @ d482448` (AUTH-04D2A).
- **Predecessors:** CORE-05, AUTH-01, AUTH-03, AUTH-04A/B/C, G-02A–G-02C1D, ASSURE-01, AUTH-04D2A.
- **New production source:** `src/enterprise/synthetic-execution-verification/`. It is pure and keyless. No route, store, signer or Host composition uses it.
- **No change** to:
  - CORE-05, AUTH-03, the gateway, the G-02 chain, the Generic HTTP adapter, the reference executor or the Authority Web client;
  - PROD-03, the Dockerfile or any dependency.

## 1. What decides that an authorized action may proceed

The trace below follows the code as it stands.

1. **CORE-05** records verdicts. AUTH-03 lets a human's verdict reach CORE-05 only through a WebAuthn assertion bound to the approval's exact subject digest and verdict. The trusted channel is `frontera:human-passkey-decision`.
2. **The governed path decides whether to proceed** (the orchestrator, when the agent resumes with the same idempotency key). It resumes the committed decision and revalidates:
   - the approval, its status and `notAfter`;
   - the approver's live standing;
   - the emergency stop and obligations;
   - the grant.

   No UI, gateway or executor decision can substitute for it.
3. **G-02B** then issues one capability through the G-02C0 gate. The capability is short-lived, single-use and request-bound, signed by the Host authority key, and expires no later than the approval's `notAfter`. Its `executionId` is `H(requestId, decisionId)`.
4. **G-02C0** binds that capability to the exact wire request (`frontera.http-request-binding.v1`). The executor sees nothing else.
5. **The G-02C1A/B/C reference executor:**
   - verifies the capability under its pinned issuer key and rebuilds the binding from what it received;
   - claims the capability durably, once;
   - writes one local synthetic record, then signs a `frontera.executor-receipt.v1`.
6. **G-02C1D:** the Host verifies the receipt under the operator-pinned executor key, correlates it with its own issuance and records it as evidence. It never changes the P11 outcome.

The executor does not read CORE-05. Its proof of authorization is the capability, which only step 2 can cause to exist. The trust boundary is therefore unchanged: **an ALLOWED verdict cannot be forged into an execution without the Host authority key and the Host's own governed path.** No step trusts the browser.

## 2. Selected architecture: reuse, plus one verifier

Nothing new executes:
- The success path is the existing G-02 chain, with the existing reference executor in its existing `synthetic-execution` mode.
- The failure path is the existing `.invalid` route.

The one new component is a **verifier** (`createSyntheticExecutionVerifier`). It takes what the Host already records and re-checks every link under public keys the caller pins:

| Link | Re-checked |
|---|---|
| Approval | The subject is re-serialized and re-digested, and equals `subjectDigest`. The request, decision and organization match the trace. The status is `approved` (or `approval-expired` after a run inside its window). Every counted approving verdict was recorded on the human passkey channel. |
| Execution identity | `executionId = H(requestId, decisionId)` is recomputed and must equal the trace's. |
| Capability | Canonical form. Signed by a pinned authority key of the pinned issuer. Same organization, action and resource as the approved subject. The action is a `synthetic.*` action. `expiresAt ≤ notAfter`. |
| Receipt | Canonical form. Signed by the pinned executor key, within the executor's pinned scope. Same issuer, capability, execution, audience, organization, trust domain and action binding. The newest receipt of a valid chain. `completed-observed` over ledger state `completed`, with an observation. |
| Host observation | A `receipt-correlated`, `consistent`, HTTP-`completed` exchange, and no conflicting receipt. |

The outcome is one of five statuses. It **fails closed**: anything missing, unverifiable or contradictory is `EXECUTION_UNKNOWN`, never success.

| Status | Meaning |
|---|---|
| `NOT_AUTHORIZED` | Nothing was attempted, and no approved verdict for exactly this subject, by a human passkey decision, stands now. This is a statement about **current authority**, never a verdict on an execution already recorded. |
| `AUTHORIZED` | Approved, and nothing issued or presented. **Authorization is not execution.** |
| `DELIVERY_FAILED` | A definite non-completion recorded by the governed path, with nothing presented to any executor (the `.invalid` route). |
| `SIMULATED_SUCCESS` | Every link above verifies. |
| `EXECUTION_UNKNOWN` | Anything else: an unconfirmed outcome, a lost response, an outage, a missing, invalid or conflicting receipt, an unverified trace. This includes an execution on record whose approval no longer stands now (`APPROVAL_WITHDRAWN_ORDER_UNPROVEN`), and any other approval defect once an execution is on record. |

### Historical authorization (A) versus current authority (B)

CORE-05's view is **live lineage**: it re-resolves revocation and approver standing at every read. CORE-05 records no approval events in the authority event stream (P8), and no record orders a withdrawal against an execution's claim. Only Host and executor timestamps could, and those come from different clocks.

So the verifier never reads a withdrawal reported now as proof that a recorded execution was unauthorized, and never invents the ordering. Expiry differs: the Host-signed capability is capped at `notAfter`, and the executor-signed claim must lie inside the capability window. Two signatures establish that the run happened inside the approval's window.

| Scenario | Result |
|---|---|
| Approval valid at execution, still approved | `SIMULATED_SUCCESS` |
| Approval expires after execution | `SIMULATED_SUCCESS`: the capability ⊆ approval window and the claim ⊆ capability window, both signed |
| Approval window shorter than the capability | `EXECUTION_UNKNOWN` / `CAPABILITY_MISMATCH` |
| Approval revoked after execution | `EXECUTION_UNKNOWN` / `APPROVAL_WITHDRAWN_ORDER_UNPROVEN` |
| Approver standing revoked after execution | `EXECUTION_UNKNOWN` / `APPROVAL_WITHDRAWN_ORDER_UNPROVEN` |
| Passkey credential revoked after execution | `SIMULATED_SUCCESS`: CORE-05 still counts the verdict, made on the passkey channel while the credential was valid; the credential cannot sign in again |
| Approval or standing revoked before execution | The governed path withholds. Nothing is issued. `NOT_AUTHORIZED` |
| Capability issued before revocation, presented after | The executor acts, and the Host records the receipt as evidence. `EXECUTION_UNKNOWN` / `APPROVAL_WITHDRAWN_ORDER_UNPROVEN` |
| Claim outside the capability window | `EXECUTION_UNKNOWN` / `RECEIPT_OUTSIDE_CAPABILITY_WINDOW` |
| Forged or missing verdict timestamps | No effect: no timestamp is read to order a withdrawal. Missing approving rows → `EXECUTION_UNKNOWN` / `APPROVAL_NOT_APPROVED` |

Revocation still blocks every new execution immediately. The governed path re-reads the approval before the claim (unchanged), and CI shows that after each revocation a new request does not execute.

**What would establish the historical ordering:** an approval event (verdict, revocation, standing withdrawal) in the same hash-chained authority event stream as the execution claim. A recorded execution could then be shown to precede a later withdrawal by chain position. That requires changing CORE-05/P8 and is **not** done here.

## 3. The verified synthetic receipt

The durable receipt is the executor's signed `frontera.executor-receipt.v1`. It is kept in two places: the executor's receipt ledger, and verbatim in the Host's evidence store. The verifier states it as `frontera.synthetic-execution-verification.v1`.

| Required | Where |
|---|---|
| Synthetic executor identity | `receipt.executorId`, `receipt.executorKeyId` (signed) |
| Organization | `organizationId` (signed in both the capability and the receipt) |
| Governed-action request | `requestId`. It is bound into `executionId = H(requestId, decisionId)`, which both signatures cover. The executor also receives it in the bound request body. |
| Canonical subject digest | `approval.subjectDigest`, recomputed from the subject |
| Authorization / verdict reference | `approval.approvalRequestId`, `approval.approvalDigest`, `decisionId`, `approval.channel` |
| Stable idempotency key | `executionId`. It is the `Idempotency-Key` the executor receives, and the identity the executor consumes once. |
| Simulated operation | `operation.action` (`synthetic.deploy-release`) and `operation.resource` |
| Outcome | `status: SIMULATED_SUCCESS` (the receipt's own `completed-observed`) |
| Execution-attempt timestamp | `receipt.observedAt` |
| Receipt digest | `receipt.receiptDigest` (sha256 of the canonical receipt), and `verificationDigest` over the whole statement |

**Authenticity** rests on two existing signatures: the Host authority key over the capability, and the executor key over the receipt. **No new signing key exists.** The verification statement is a digest, not a signature, and anyone holding the two public keys can recompute it.

**What it never claims:** an external business effect, a payment, a deployment or a provider confirmation. `externalEffect` is always `none-synthetic-only`.

## 4. Idempotency, duplicates and restarts

- **The agent retries with the same key:** the Host answers from its record (`replayed`). Nothing is issued or presented again.
- **The exact presented bytes are delivered to the executor again:** the durable consumption ledger refuses a second claim. There is still one synthetic record and one receipt.
- **The Host restarts:** the issuance ledger, the evidence store and CORE-05 are durable. The verification is byte-identical after the restart (CI asserts the same `verificationDigest`).
- **The executor's response is lost:** the executor acted, and the Host stays `execution_unconfirmed` with `receipt-missing`. The verification is `EXECUTION_UNKNOWN`. A retry never re-presents.
- **The executor is down:** the outcome is not confirmed, and the verification is never success.
- **Crash points inside the executor** (claim, effect, receipt) are covered by the G-02C1B/C crash matrices. Crash points inside Host issuance are covered by G-02B. Neither is repeated here.

## 5. The Authority Web experience: unchanged, on purpose

The gateway reports the human decision and `execution: "not_observed"`. No existing Host or gateway contract exposes a trustworthy execution projection to a browser. Adding one would widen the privileged browser API, which this authorization does not cover. So:
- the browser never constructs execution evidence;
- the browser never calls the executor;
- nothing infers execution from an `approved` verdict.

CI asserts the decision status still says `not_observed` after a verified `SIMULATED_SUCCESS`. Execution is verified on the operator side.

## 6. The pilot (stage 3)

`compose.executor.yaml`, `synthetic-execution.additions.json`, `nginx/synthetic-executor.conf`, `scripts/deploy/synthetic-execution-pilot.mjs`. See `docs/deployment/AUTHORITY_PILOT_DEPLOYMENT.md` §14.

- **Synthetic only:**
  - one `synthetic.*` action on one synthetic environment;
  - one local record write;
  - no downstream, no business credential, no payment rail;
  - no client-supplied URL, since the origin is fixed in configuration;
  - no general proxy: one path, one method.
- **Not public:**
  - the executor listens on loopback;
  - the TLS front on 8443 is closed by the firewall and allow-listed to the Docker bridge;
  - the Authority ingress has no route there (all three are CI-checked).
- **Isolation:**
  - the executor's volume holds its receipt key and is mounted by no Host service;
  - the executor receives no Host secret;
  - the Host/witness separation is unchanged (the AUTH-04D2A checks still run on every Host-side service, the executor included).
- **Off by default:** without the overlay, no executor service and no success route exist (CI-checked). Stage 1 and the cutover are unchanged.
- **Why a TLS front, not a loopback adapter:** the Generic HTTP adapter refuses loopback and private targets by design (`allowPrivateNetwork` is refused). Allowing it would be a trust-boundary change. The front keeps the adapter's rule intact.

## 7. Qualification

| # | Requirement | Where it is proven |
|---|---|---|
| 1–3 | Passkey approval → CORE-05 approved → verified receipt | `auth04d2s-verified-synthetic-execution.test.ts` (1–5), on the shipped Host, through the gateway, with the software authenticator |
| 4 | Durable across restart | same test: the Host restarts, and the verification digest is identical |
| 5 | Exactly-once under duplicate delivery | same test: an agent replay, and the raw bytes re-sent to the executor |
| 6–8 | Wrong organization, request or subject | verifier mutations (same test); on the live path, a cross-subject challenge is refused (6–8) |
| 9 | Missing authorization | test 9 |
| 10 | Rejected | test 10 (passkey rejection) |
| 11 | Expired authorization | expiry suite (mocked Host clock) |
| 12 | Revoked human standing | test 12 |
| 13 | Revoked credential | test 13–14 |
| 14 | Replayed assertion | test 13–14 |
| 15 | Modified receipt | test 1–5 (tampered text, forged signature, unpinned authority key, a validly signed receipt claimed outside the capability window) |
| — | Temporal authorization (historical versus current) | test 1–5 (expiry after, short window, revoked now, standing now, forged and missing ordering); tests 20–23 live (credential, approval and standing revoked after execution; a capability presented after revocation), each followed by a check that the next request does not execute |
| 16 | Unauthenticated executor request | test 16 |
| 17 | `.invalid` delivery failure | test 17 (`execution_failed` / `PROVIDER_UNAVAILABLE`, `DELIVERY_FAILED`, zero downstream footprint) |
| 18 | Lost executor response | test 18 |
| 19 | Executor outage | test 19 |
| 20 | Host crash/restart reconciliation | Host restart in test 1–5. Crash points: G-02B issuer recovery, G-02C1B/C crash matrices, the AUTH-04B lost response across restart (existing suites, unchanged and still run) |
| 21 | No public executor exposure | `authority-pilot-config` (resolved Compose, nginx front, allow-list, Authority ingress has no route) |
| 22 | No real network or business effects | DNS is stubbed only for the test name. `.invalid` goes to the real resolver and fails. The only effect is a file in a temporary directory. |
| 23–25 | PROD-03, AUTH-01…AUTH-04D2A, CORE-07, ASSURE-01 | the whole `validate` job and every CI job, unchanged |

The software authenticator is a CI fixture. **No physical iPhone testing is claimed.**

### Not covered (stated precisely)

- **The test transport** (as in AUTH-01 and G-02C1D) replaces the gated adapter's HTTPS request with plain HTTP to a Unix-socket relay. In CI, the following are not exercised between the Host adapter and the executor:
  - TLS and certificate validation;
  - public DNS;
  - the connect-address decision over a real answer.
- **The nginx front** is qualified separately, against a stub executor. The first live check of the joined path is the pilot's stage-3 step 6.

## 8. Known limitations

- **Co-location:** the executor runs on the Host machine. A compromise of that machine could forge receipts. This is acceptable for a synthetic demonstration only; an independent executor host is a production requirement.
- **Software keys:** the receipt key and the authority key are both software keys (G-02C1C/D production blockers stand).
- **Operator-side verification in the live pilot:** the verifier is qualified in CI over the Host's real records. In the pilot, its inputs are the CORE-05 view, the ASSURE-01 trace (an organization-scoped auditor key), the issuance ledger and the evidence store. Packaging that as an operator tool is a follow-up. No new HTTP route was added for it.
- **Withdrawn approvals:** an execution whose approval is later revoked, or whose approver later loses standing, verifies as `EXECUTION_UNKNOWN` (`APPROVAL_WITHDRAWN_ORDER_UNPROVEN`). Existing records cannot order the withdrawal against the execution (§2). An approval in `approval-expired` still accounts for a run inside its window.
- **The CORE-05 view is an input:** the verifier recomputes the subject digest but does not itself verify the approval chain's signed head. It relies on the ASSURE-01 trace verification (`verified`, which includes the approval chain's authenticity) and on the view coming from the Host's command port.
- **Unchanged from AUTH-04D2A:** F2, F3, F5 and F6 remain unresolved and are not accepted. The environment stays synthetic-only.
