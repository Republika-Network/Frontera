import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { GRANT_BOUND_KEYS, boundedGrantDigest, createInMemoryBoundedGrantStore, type BoundedGrant, type GrantCorrelation, type GrantScope } from '../../features/grant-runtime/index.js';
import { createExecutionAdapterRegistry, createGrantExecutionService, type ExecutionAdapter, type ExecutionOutcome, type GrantExerciseRequest } from '../../features/execution-runtime/index.js';
import { buildExerciseRequest, buildTestGrant, createRecordingExecutionAdapter, type ExerciseRequestOverrides } from '../../features/execution-runtime/tests/execution-fixture.js';
import { createXrplExecutionAdapter, type XrplExecutionAdapterOptions, type XrplIssuedCurrencyAmount, type XrplSubmissionObservation } from '../execution-adapters/xrpl/index.js';
import {
  FIXTURE_TRANSACTION_HASH,
  USD_ISSUED_OPTIONS,
  XRPL_ADAPTER_ID,
  XRPL_DESTINATION,
  XRPL_ISSUER,
  XRPL_OTHER_DESTINATION,
  createSpyXrplTransport,
  xrplKey,
  type SpyXrplTransport,
} from './xrpl-adapter.fixture.js';

/**
 * ANDREW-P0-06 — grant binding, measured through the **real** exercise gate.
 *
 * `GrantExecutionService` reads the grant from the authoritative store, proves
 * the attempt inside its bounds, and only then reaches the registry, which
 * routes to the XRPL adapter. The XRPL adapter adds no binding of its own and
 * needs none: it receives the counterparty and amount the gate proved, and
 * translates exactly those. So destination, namespace, amount and asset drift
 * are all refused *before* the adapter, and the transport sees nothing.
 *
 * The grant is built the way issuance builds one (deterministic id, canonical
 * digest), in today's unchanged format: the counterparty is bound by identity
 * to the P0-01 destination key, the amount by a USD ceiling.
 */

const TRANSFER = 'transfer-funds';
const TREASURY = 'treasury-operating-account';
const ORG = 'org-acme';
const DESTINATION_KEY = xrplKey(XRPL_DESTINATION);
const NOW = '2026-01-01T12:05:00.000Z';

const CORRELATION: GrantCorrelation = { requestId: 'req-p006', decisionId: 'decision-p006', action: TRANSFER, resourceScope: TREASURY };

const SCOPE: GrantScope = {
  action: { kind: 'identity', value: TRANSFER },
  amount: { kind: 'ceiling', limit: '100000', unit: 'USD' },
  counterparty: { kind: 'identity', value: DESTINATION_KEY },
  organization: { kind: 'identity', value: ORG },
  resources: { kind: 'set', values: [TREASURY] },
};

interface World {
  readonly grant: BoundedGrant;
  readonly transport: SpyXrplTransport;
  readonly other: ReturnType<typeof createRecordingExecutionAdapter>;
  exercise(overrides?: ExerciseRequestOverrides): Promise<ExecutionOutcome>;
  exerciseRequest(request: GrantExerciseRequest): Promise<ExecutionOutcome>;
}

async function world(options: { readonly scope?: GrantScope; readonly xrpl?: XrplExecutionAdapterOptions; readonly respond?: (submission: unknown) => XrplSubmissionObservation } = {}): Promise<World> {
  const grant = buildTestGrant({ correlation: CORRELATION, subject: 'agent-andrew', scope: options.scope ?? SCOPE });
  const store = createInMemoryBoundedGrantStore();
  assert.equal((await store.issue({ grant, commitGuard: () => ({ permitted: true, reasonCodes: [] }) })).outcome, 'issued');
  const transport = createSpyXrplTransport(options.respond);
  const xrpl = createXrplExecutionAdapter(options.xrpl ?? USD_ISSUED_OPTIONS, transport);
  const other = createRecordingExecutionAdapter();
  const registry: ExecutionAdapter = createExecutionAdapterRegistry({ adapters: [other, xrpl], selectAdapter: (action) => (action.action === TRANSFER ? XRPL_ADAPTER_ID : other.adapterId) });
  const service = createGrantExecutionService({ store, adapter: registry, now: () => NOW });
  const base = (overrides: ExerciseRequestOverrides = {}): GrantExerciseRequest =>
    buildExerciseRequest(grant, { subject: 'agent-andrew', action: TRANSFER, resource: TREASURY, counterparty: DESTINATION_KEY, organization: ORG, amount: { value: '75000', unit: 'USD' }, correlation: CORRELATION, executionId: 'exec-p006', ...overrides });
  return { grant, transport, other, exercise: (overrides) => service.exercise(base(overrides)), exerciseRequest: (request) => service.exercise(request) };
}

function assertWithheld(outcome: ExecutionOutcome, transport: SpyXrplTransport): void {
  assert.equal(outcome.status, 'withheld', JSON.stringify(outcome));
  assert.equal(outcome.assessment.usable, false);
  assert.equal(transport.submissions.length, 0, 'the XRPL transport is never reached');
}

describe('ANDREW-P0-06 exercise — the authorized destination is the executed destination', () => {
  it('the canonical USD 75,000 exercise reaches the XRPL adapter once, with the grant-bound destination', async () => {
    const w = await world();
    const outcome = await w.exercise();
    assert.equal(outcome.status, 'executed', JSON.stringify(outcome));
    assert.equal(outcome.status === 'executed' ? outcome.adapterId : undefined, XRPL_ADAPTER_ID, 'the registry attributes the effect to the XRPL child');
    assert.equal(outcome.status === 'executed' ? outcome.providerRef : undefined, FIXTURE_TRANSACTION_HASH, 'the fake transport’s fixture hash, relayed — not a ledger proof');
    assert.equal(w.transport.submissions.length, 1);
    assert.deepEqual(w.transport.submissions[0]?.instruction, { TransactionType: 'Payment', Destination: XRPL_DESTINATION, Amount: { currency: 'USD', issuer: XRPL_ISSUER, value: '75000' } });
    assert.equal(w.transport.submissions[0]?.executionId, 'exec-p006');
    assert.equal(w.transport.submissions[0]?.notAfter, w.grant.expiresAt, 'the transport is told the grant’s horizon');
    assert.equal(w.other.callCount, 0);
  });

  it('destination drift — another valid XRPL address — is withheld before the adapter', async () => {
    const w = await world();
    assertWithheld(await w.exercise({ counterparty: xrplKey(XRPL_OTHER_DESTINATION) }), w.transport);
  });

  it('a re-spelled destination — case-changed, padded — is another destination and is withheld', async () => {
    const w = await world();
    for (const counterparty of [xrplKey(XRPL_DESTINATION.toLowerCase()), xrplKey(XRPL_DESTINATION.toUpperCase()), `${DESTINATION_KEY} `]) {
      assertWithheld(await w.exercise({ counterparty }), w.transport);
    }
  });

  it('namespace drift — same identifier, other namespace, or no namespace — is withheld before the adapter', async () => {
    const w = await world();
    for (const counterparty of [xrplKey(XRPL_DESTINATION, 'lightning'), xrplKey(XRPL_DESTINATION, 'xrpl.testnet'), xrplKey(XRPL_DESTINATION, 'network-a'), XRPL_DESTINATION]) {
      assertWithheld(await w.exercise({ counterparty }), w.transport);
    }
  });

  it('an attempt that states no counterparty against a destination-bound grant is withheld', async () => {
    const w = await world();
    assertWithheld(await w.exercise({ omitCounterparty: true }), w.transport);
  });
});

describe('ANDREW-P0-06 exercise — amount and asset cannot drift', () => {
  it('the amount the gate proved is the amount the instruction states, byte for byte', async () => {
    for (const value of ['75000', '74999.99', '75000.01', '0.01', '100000']) {
      const w = await world();
      assert.equal((await w.exercise({ amount: { value, unit: 'USD' } })).status, 'executed', value);
      assert.equal((w.transport.submissions[0]?.instruction.Amount as XrplIssuedCurrencyAmount).value, value);
    }
  });

  it('above the grant ceiling is withheld before the adapter — the adapter never re-checks or caps anything', async () => {
    const w = await world();
    for (const value of ['100000.01', '125000']) assertWithheld(await w.exercise({ amount: { value, unit: 'USD' } }), w.transport);
  });

  it('asset drift is withheld even when the XRPL adapter could have represented the other asset', async () => {
    const everything: XrplExecutionAdapterOptions = {
      adapterId: XRPL_ADAPTER_ID,
      assets: [
        { assetId: 'USD', representation: { kind: 'issued', currency: 'USD', issuer: XRPL_ISSUER } },
        { assetId: 'EUR', representation: { kind: 'issued', currency: 'EUR', issuer: XRPL_ISSUER } },
        { assetId: 'xrpl:XRP', representation: { kind: 'native' } },
      ],
    };
    const w = await world({ xrpl: everything });
    for (const unit of ['EUR', 'xrpl:XRP', `xrpl:USD/${XRPL_ISSUER}`]) assertWithheld(await w.exercise({ amount: { value: '75000', unit } }), w.transport);
  });

  it('mutating the caller’s request after the exercise begins changes nothing the transport sees', async () => {
    const w = await world();
    const amount = { value: '75000', unit: 'USD' };
    const request = { ...buildExerciseRequest(w.grant, { subject: 'agent-andrew', action: TRANSFER, resource: TREASURY, counterparty: DESTINATION_KEY, organization: ORG, correlation: CORRELATION, executionId: 'exec-p006' }), amount };
    const pending = w.exerciseRequest(request);
    amount.value = '99999';
    (request as { counterparty: string }).counterparty = xrplKey(XRPL_OTHER_DESTINATION);
    assert.equal((await pending).status, 'executed');
    assert.equal(w.transport.submissions[0]?.instruction.Destination, XRPL_DESTINATION);
    assert.equal((w.transport.submissions[0]?.instruction.Amount as XrplIssuedCurrencyAmount).value, '75000');
  });
});

describe('ANDREW-P0-06 exercise — adapter and transport outcomes map onto existing execution outcomes', () => {
  it('a grant bound to a known, approved, but technically invalid XRPL destination: the gate passes, the adapter refuses, transport 0', async () => {
    const invalid = xrplKey('rNotAnXrplAddress');
    const w = await world({ scope: { ...SCOPE, counterparty: { kind: 'identity', value: invalid } } });
    const outcome = await w.exercise({ counterparty: invalid });
    assert.equal(outcome.status, 'execution-failed', JSON.stringify(outcome));
    assert.equal(outcome.status === 'execution-failed' ? outcome.reason : undefined, 'ADAPTER_ERROR');
    assert.equal(outcome.status === 'execution-failed' ? outcome.adapterId : undefined, XRPL_ADAPTER_ID);
    assert.equal(w.transport.submissions.length, 0);
  });

  it('a transport rejection is execution-failed PROVIDER_REJECTED; an unconfirmed submission is execution-unconfirmed — neither is a denial', async () => {
    const rejected = await world({ respond: () => ({ kind: 'rejected' }) });
    const failed = await rejected.exercise();
    assert.equal(failed.status, 'execution-failed');
    assert.equal(failed.status === 'execution-failed' ? failed.reason : undefined, 'PROVIDER_REJECTED');
    assert.equal(rejected.transport.submissions.length, 1);

    const lost = await world({ respond: () => ({ kind: 'unconfirmed', transactionHash: FIXTURE_TRANSACTION_HASH }) });
    const unconfirmed = await lost.exercise();
    assert.equal(unconfirmed.status, 'execution-unconfirmed');
    assert.equal(unconfirmed.status === 'execution-unconfirmed' ? unconfirmed.providerRef : undefined, FIXTURE_TRANSACTION_HASH);
    assert.equal(lost.transport.submissions.length, 1, 'never resubmitted');
  });
});

describe('ANDREW-P0-06 exercise — the grant is unchanged and rail-neutral', () => {
  it('the bound axes are exactly the pre-P0-06 set; there is no rail, network, issuer or address axis', () => {
    assert.deepEqual([...GRANT_BOUND_KEYS], ['action', 'actionClass', 'amount', 'counterparty', 'governanceProfile', 'organization', 'resourceClass', 'resources']);
  });

  it('an XRPL destination is bound as an ordinary identity counterparty, and the digest is the canonical one', async () => {
    const w = await world();
    assert.deepEqual(w.grant.scope.counterparty, { kind: 'identity', value: DESTINATION_KEY });
    const { digest, ...withoutDigest } = w.grant;
    assert.equal(digest, boundedGrantDigest(withoutDigest));
    assert.equal(/issuer|xrplAsset|network|transactionType/i.test(JSON.stringify(w.grant)), false);
  });
});
