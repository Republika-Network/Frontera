# AUTH-01 — Connected Human Approval to Governed Execution

- Status: **Reference integration proof. Synthetic. Test-only.**
- Suite: `src/enterprise/__tests__/auth01-connected-approval-execution.test.ts`
- Runs in: `validate` (`npm test`) in `.github/workflows/ci.yml`. No new CI job.
- Production source changed: **none.**
- Predecessors: CORE-05 (durable approvals), CTRL-04 (operator approval plane), PROD-03 (`approvalPolicy`), G-02B, G-02C0, G-02C1A–D.

## 1. What this proves

That the existing human approval workflow and the existing signed execution
chain operate together on the canonical shipped Host, unchanged:

```
agent request → policy requires approval → CORE-05 pending request → agent withheld
→ operator approves the exact subject (CTRL-04) → agent resubmits with the same key
→ Host revalidates (approval, standing, emergency stop, obligations, lifetime)
→ G-02B capability (bounded, ≤60 s, single-use, request-bound, signed)
→ G-02C1A executor verifies independently → G-02C1B durable consumption, one synthetic effect
→ G-02C1C signed receipt → G-02C1D Host verifies, correlates with issuance, records evidence
```

Before this suite, each half was qualified separately: CTRL-04 and PROD-03
with a recording adapter, and G-02C1D and DEMO-01A without any approval.

## 2. The world

- **Host:** `bootEnterpriseHost()` with a production profile, SQLite stores, signed authority artifacts, the CORE-07 witness and software custody.
- **No in-process policy.** The only thing that sends a decision to a human is the governed-action file's PROD-03 `approvalPolicy`, one rule on the `synthetic-deploy-production` profile.
- **Approval requirement:** `approverAction: approve-deploy`, one approver, a 3600 s request TTL and 900 s approval validity.
- **Provisioning:** every actor, authority, credential and approver standing is provisioned over HTTP by identified CTRL-02 operators.
- **Agent:** `actor-deploy-agent`, delegated `synthetic.deploy-release` over two synthetic production environments only.
- **Approver:** `operator:cto`, holding the CTRL-04 `approver` role and Kernel-Authority standing for `approve-deploy`. It holds no authority for the governed action itself.
- **Executor:** the G-02C1D reference executor in its own process, synthetic-only, pinned to the Host authority key. Its receipt key is pinned in the Host's `receiptEvidence.trustedExecutors`.

## 3. Results asserted

### Positive flow (A–P)

| Step | Assertion |
|---|---|
| A–D | The first submission is `withheld` by `approval` with `GOVERNED_ACTION_APPROVAL_PENDING`. No issuance, presentation, effect or evidence. |
| E | The inbox entry names the governed `requestId` and the committed `decisionId`. The subject names the agent, action, resource, profile and `releaseVersion = release-42`. The requirement is `approve-deploy`, quorum 1. |
| F–G | `operator:cto` approves the shown `subjectDigest`. The status is `approved`, with an `approvalDigest`, a `notAfter`, and the counted approver `operator:cto`. Still no issuance or effect. |
| H–I | The same idempotency key resumes the **same request and decision**, which is not re-evaluated. The status is `executed`. |
| J | Exactly one issuance. The capability names this execution, the agent, the action, the resource and the audience. It is `single-use`, its lifetime is at most 60 s, and `expiresAt` is no later than the approval's `notAfter`. Its signature verifies independently under the Host authority key. |
| K | Exactly one request reached the executor. Its presentation header carries exactly the issued canonical text and signature. |
| K–M | The executor's ledger shows `completed`. Exactly one synthetic effect, bound to the capability's binding digest. One receipt about this capability, execution and binding, with outcome `completed-observed`. The receipt signature verifies independently under the pinned executor key. |
| N–O | The Host evidence shows `response / receipt-correlated / consistent / completed / completed-observed`. The accepted receipt is the executor's receipt verbatim. |
| P / 9 | Resubmitting is `replayed`, with the same `executionId`, no second presentation, effect, issuance or receipt. |

### Negative scenarios

| # | Scenario | Result asserted |
|---|---|---|
| 1 | Approval pending | Retry stays withheld. Nothing issued or performed. |
| 2 | Rejected | Final. Retry `GOVERNED_ACTION_APPROVAL_REJECTED`. A later approval is refused (`APPROVAL_REJECTED`). |
| 3 | Wrong approver | No credential → 401. Agent credential → 401. Observer role → 403. Each of these is refused with `APPROVAL_APPROVER_INELIGIBLE`: standing over another environment, another approver action, execution-only authority, no actor at all. Nothing recorded. |
| 4 | Self-approval | `APPROVAL_SEGREGATION_OF_DUTIES`, although the requester holds approval standing. |
| 5 | Approval expires before resume | `approval-expired`, retry `GOVERNED_ACTION_APPROVAL_EXPIRED`. No capability. |
| 6 | Request expires before a verdict | Verdict refused `APPROVAL_REQUEST_EXPIRED`. Retry `GOVERNED_ACTION_APPROVAL_REQUEST_EXPIRED`. No capability. |
| 7 | Changed parameters | Same key → `GOVERNED_ACTION_IDEMPOTENCY_CONFLICT`. A new key opens its own approval with a different subject digest. The old digest cannot approve it (400). |
| 8 | Changed resource | As 7, for another delegated environment. |
| 9 | Same request retried | No duplicate effect (positive flow). |
| 10 | Lost executor response | Host `execution_unconfirmed`, observation `receipt-missing`, no accepted receipt. The executor consumed, performed one effect and kept its signed receipt. The retry adds no request, effect or issuance and is never reported `executed`. |
| 11 | Concurrent conflicting verdicts | Approve and reject race on **one Host process**. Exactly one is recorded. The other is refused unrecorded, naming the winning state. Execution follows the winner. |
| 12 | Revoked authority | Revoking the approver's standing after the verdict withdraws the unused approval. The retry is withheld and nothing executes. |

Expiry (5, 6) uses a mocked `Date` in the Host process, as the CTRL-04
expiry suite does. These Hosts stop before issuance, so the executor's own
clock is never involved.

## 4. What is stubbed

The transport is test-only, identical to the G-02C1D shipped-Host suite and DEMO-01A:

- The gated adapter's hostname resolves, in the test process only, to a public documentation address (`93.184.216.34`). Nothing dials it.
- For that hostname only, `https.request` is replaced by `loopbackHostPrimitive`. That sends the transport's exact request options and bytes as **plain HTTP** to a Unix-socket byte relay in front of the loopback executor.
- One relay variant drops the executor's answer (scenario 10).

**Not exercised:** TLS, certificate validation, public DNS, the connect-address
policy over a real answer, or any proxy. The Host's transport code
(`rejectUnauthorized: true`, HTTPS-only, private-network refusal) and the
executor's loopback-only, `reference-synthetic` configuration are **unchanged**.

## 5. What this does not claim

- **Human authentication.** Operators authenticate with the existing reference mechanism: a **static bearer secret per operator**, configured in the environment. This is not individual human authentication, not phishing-resistant, not WebAuthn or passkeys, not MFA, and not a mobile approval experience. It is not suitable for customer-facing CTO approval. Those are AUTH-02 and AUTH-03.
- **Multi-process safety.** Scenario 11 runs on one Host process. CORE-05's pending check precedes the store's write lock. No claim is made for several Host processes sharing the approval store.
- **Production execution.** Synthetic effect only, on a loopback executor, in the reference synthetic environment. Nothing was deployed, paid or sent.
- **Anything beyond the G-02C1D security statement.** Its production blockers stand:
  - TLS executor qualification;
  - receipt retrieval;
  - KMS/HSM receipt keys;
  - online revocation;
  - rollback anchoring of the issuance, consumption, receipt and evidence stores;
  - cross-ledger reconciliation;
  - real effects.
- **Policy re-evaluation after approval.** By existing design the committed decision is resumed, not re-evaluated. Revalidation covers the approval, approver standing, emergency stop, obligations, the grant and the capability gate.

## 6. Follow-on

AUTH-02 (an individual human principal with passkey enrolment and revocation)
and AUTH-03 (a passkey assertion bound to the approval subject digest, verified
by the Host before CORE-05 records a verdict) can build on this chain without
changing it. This suite is their regression baseline.
