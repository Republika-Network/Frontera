# @aoc-enterprise/enterprise-host-sdk

Minimal typed HTTP client for the **Soberanía Enterprise Host v1 API**.

Transport only, by design:

- one method per public endpoint (see `docs/enterprise/API_STABILITY_V1.md`)
- zero runtime dependencies (uses the global `fetch` of Node.js >= 18)
- no governance logic, no digest computation, no local decisions, no retries —
  every decision and every verification happens server-side and the caller owns
  its retry policy

## Install / build

The package is part of the Soberanía Enterprise workspace:

```bash
npm run build --workspace @aoc-enterprise/enterprise-host-sdk
npm test --workspace @aoc-enterprise/enterprise-host-sdk
```

## Usage

```ts
import { createEnterpriseHostClient, isEnterpriseHostApiError } from '@aoc-enterprise/enterprise-host-sdk';

const client = createEnterpriseHostClient({
  baseUrl: 'http://127.0.0.1:8080',
  apiKey: process.env.AOC_API_KEY,   // legacy routes: only when AOC_ENTERPRISE_REQUIRE_AUTH=true; governAction(): always
  timeoutMs: 10_000,                 // default 30_000
});

// Health
const ready = await client.ready();

// Governance evaluation (idempotent when you pass an Idempotency-Key)
const decision = await client.evaluate(
  {
    actor: { id: 'agent-1', trustDomainId: 'td-acme' },
    action: { type: 'document.draft', resourceScope: 'project.alpha' },
    organization: { id: 'org-acme' },
  },
  { idempotencyKey: 'draft-document-42' },
);

if (decision.status === 'allowed') {
  // The durable record backing this decision:
  const record = await client.getEvaluation(decision.governanceRecord!.evaluationId);
  const verification = await client.verifyEvaluation(decision.governanceRecord!.evaluationId);
}

// Evidence
const bundle = await client.buildEvidence({ evaluationId: 'eval-1', level: 'AUDITOR', createdBy: 'auditor-7' });
const bundleCheck = await client.verifyEvidence('bundle-1');

// Assurance
const assessment = await client.createAssessment({
  subject: { subjectId: 'org-acme', subjectType: 'organization', organizationId: 'org-acme' },
  frameworkId: 'aoc.saf',
  frameworkVersion: '1.0.0',
  requestedBy: 'compliance-1',
});
await client.evaluateAssessment(assessment.assessmentId as string);
```

## Governed actions

`governAction()` asks the Host to **govern and, if authorized, execute** one
action — `POST /api/governed-actions`. The Host admits the caller from the
client's `apiKey` (which must be a customer credential; this route requires it
even when the Host runs with `AOC_ENTERPRISE_REQUIRE_AUTH=false`), derives the
actor and organization from that credential's binding, has the Kernel decide,
commits the decision, and only then issues and exercises bounded authority on
the server. The SDK does none of that: it sends the intent and decodes the
answer.

```ts
const client = createEnterpriseHostClient({
  baseUrl,
  apiKey,
});

const result = await client.governAction({
  action: 'payment.create',
  resource: 'invoice:INV-100',
  counterparty: 'vendor:V123',
  amount: {
    value: 7500,
    currency: 'USD',
  },
  idempotencyKey: 'payment-INV-100-v1',
});

switch (result.status) {
  case 'executed':
    // The provider effect happened. `result.replayed` is true when this was a
    // retry answered from the record, with no second effect.
    break;

  case 'denied':                // the Kernel said no
  case 'withheld':              // allowed or pending, but a gate held it — see result.withheldBy
  case 'execution_failed':      // the provider failed — see result.failure
  case 'execution_unconfirmed': // attempted before, outcome unknown — reconcile; never re-sent
  case 'indeterminate':         // the Kernel could not decide
  case 'rejected':              // malformed intent, or an idempotency-key conflict
  case 'system_error':
    console.log(result.status, result.reasonCodes);
    break;
}
```

The intent names **what** you want done, never **who** is doing it or **how**
it is carried out. `GovernedActionIntent` is a closed type: there is no field
for an actor, organization, grant, adapter, provider, URL or credential, and
the Host rejects a body that carries one. `assertedContext` (optional) is
evidence you assert — the Host verifies it; sending it does not make it
trusted.

**Results are returned, not thrown.** `GovernedActionResult` domain responses
are returned, even though the Host uses non-2xx statuses for most of them
(`withheld` 409, `denied` 422, `execution_failed` 502, `indeterminate` 503, …).
Enterprise error envelopes and invalid/unrecognized protocol responses throw
`EnterpriseHostApiError`:

- an error envelope — a missing or non-customer credential (`401`/`403`),
  malformed JSON, or `404 NOT_FOUND` when the Host has not enabled governed
  actions — throws with the envelope's `code`;
- a body that is not a well-formed `GovernedActionResult` (unknown `status`,
  non-string `reasonCodes`, a missing or unknown `withheldBy`/`failure`,
  mistyped `replayed`/`outcomeRecorded`, an unknown `decision.status`, …), or a
  well-formed result under an HTTP status the Host never pairs with it (e.g. a
  `denied` result on `500`), throws with code `UNKNOWN` and the raw body on
  `error.body`. This is transport decoding of the Host's contract, not a
  governance decision.

A returned result never contains a grant, grant digest, adapter identity or
credential.

## Errors

Every non-2xx response throws (except `governAction()`'s governed results — see below):

| Error | Meaning |
|---|---|
| `EnterpriseHostApiError` | The Host answered with an error. `status` (HTTP), `code` (stable machine code, e.g. `INVALID_REQUEST`, `AUTHENTICATION_FAILED`, `GOVERNANCE_RECORD_NOT_FOUND`), `details` (validation messages), `body` (verbatim response). |
| `EnterpriseHostTimeoutError` | `timeoutMs` elapsed before a response. |
| `EnterpriseHostNetworkError` | No HTTP response at all (connection refused, reset, DNS). `cause` carries the underlying error. |

```ts
try {
  await client.getEvaluation('missing');
} catch (error) {
  if (isEnterpriseHostApiError(error) && error.status === 404) {
    // handle not-found
  }
}
```

Two Host endpoints intentionally use non-2xx statuses for *governed* outcomes,
not failures: `verifyPassport` and `verifyAssessment` respond `409` with the
raw verification result when the artifact fails verification, and `evaluate`
responds `422` for a governance **denial**. The SDK surfaces these as
`EnterpriseHostApiError` with the full body in `error.body` — inspect
`error.status` before treating them as infrastructure failures.

`governAction()` is the one exception: it **returns** its non-2xx governed
outcomes as a `GovernedActionResult` (see *Governed actions*). Enterprise error
envelopes and invalid/unrecognized protocol responses — on any HTTP status,
including 2xx — throw.

## Timeouts

Each request is aborted after `timeoutMs` (default 30 s) via `AbortSignal.timeout`.
Choose budgets per operation class: health checks 1–2 s, reads 5–10 s,
`evaluate`/`evaluateAssessment` 30 s+ (they perform full Kernel evaluation and
durable commits).

## Retries

The SDK never retries. Guidance for callers:

- **Safe to retry always:** all `GET` methods (`getEvaluation`, `getPassport`,
  `getAssessment`, `getContinuousState`, …) and the verify endpoints — they are
  read-only recomputations.
- **`governAction`:** retry with the **same** intent and the same
  `idempotencyKey` (it is required, and it lives in the body). The Host replays
  the recorded result and never runs the effect twice; the same key with a
  *different* intent comes back as a `rejected` result with
  `GOVERNED_ACTION_IDEMPOTENCY_CONFLICT`. An `execution_unconfirmed` result is
  final for that key: reconcile with the provider rather than retrying.
- **`evaluate`:** retry **only** with the same `idempotencyKey`. The Host
  replays the committed decision instead of re-evaluating; a key reused with a
  *different* payload is rejected with `409 GOVERNANCE_IDEMPOTENCY_CONFLICT`.
- **`issuePassport`:** retry only with the same body `idempotencyKey` field.
- **Other writes** (`processSignal`, `recordManualReview`, `appendFindingEvent`,
  `createAssessment`, passport lifecycle actions): not idempotent — do not
  retry blindly after a timeout; read the current state first.
- Retry on `EnterpriseHostNetworkError` and HTTP `503` with exponential backoff
  (e.g. 250 ms, 1 s, 4 s; 3 attempts). Do **not** retry `4xx` other than the
  idempotent replays above.

## Stability

The client tracks the frozen v1 HTTP surface. Additive Host changes (new
response fields) are non-breaking. Most SDK wire types keep open index
signatures so new fields flow through without an SDK upgrade.

The governed-action types are deliberately different:

- `GovernedActionIntent` (a **request**) is **closed**, so identity-,
  authority- and routing-shaped fields fail to compile.
- `GovernedActionResult` and `GovernedActionDecisionRef` (**responses**) are
  exact mirrors with closed vocabularies and **no** index signature. At runtime,
  `governAction()` tolerates unknown additive response fields — they are
  validated around, not rejected, and remain present on the returned object —
  but they are not typed until an SDK release declares them.

`1.1.0` added `governAction()` and its type-only mirrors; the five runtime
exports are unchanged.
