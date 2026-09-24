import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createFinancialActionClassifier, createMonetaryAssetRegistry } from '../../features/monetary-runtime/index.js';
import type { BoundCustomerIdentity } from '../customer-identity/index.js';
import type { GovernedActionMonetaryTrust, GovernedActionResult } from '../governed-action/contracts.js';
import { deriveGovernedActionRequestId } from '../governed-action/identifiers.js';
import { validateGovernedActionIntent } from '../governed-action/intent.js';
import { createInMemoryMppBusinessOperationStore, type MppBusinessOperationStore } from '../mpp-business-operation-store/index.js';
import { MPP_GOVERNED_IDEMPOTENCY_KEY_PREFIX, deriveMppGovernedIdempotencyKey, deriveMppGovernedRequestId } from '../mpp-challenge/business-identity.js';
import { MppChallengeConfigurationError, snapshotMppChallengeComposition } from '../mpp-challenge/composition.js';
import type { MppChallengeMethodNormalizer, MppChallengeSelector, MppCounterpartyResolver, ProtectedMppRequest } from '../mpp-challenge/contracts.js';
import { computeContentDigest } from '../mpp-challenge/protocol.js';
import { createMppChallengePaymentService } from '../mpp-challenge/service.js';
import {
  MPP_TEST_NOW,
  MPP_TEST_REALM,
  altpayNormalizer,
  chargeRequest,
  encodeJcs,
  fakepayNormalizer,
  paymentChallenge,
  testCounterpartyResolver,
  testSelector,
} from './mpp-challenge-support.js';

/**
 * P13 — the challenge-payment service in isolation, over a counting fake
 * orchestrator: every refusal happens **before** `govern()` — which is where
 * the Kernel, the grant, P7, the claim and the adapter live — so "govern calls
 * = 0" is "Kernel calls = 0, provider calls = 0".
 */

const ORG = 'org-a';
const MONETARY: GovernedActionMonetaryTrust = Object.freeze({
  assets: createMonetaryAssetRegistry([
    { assetId: 'USD', scale: 2 },
    { assetId: 'USDC', scale: 6 },
  ]),
  actionClassifier: createFinancialActionClassifier({ financialActions: ['payment.send'] }),
});

function identity(principalId = 'principal-a', organizationId = ORG): BoundCustomerIdentity {
  return {
    principal: { plane: 'customer', principalId, organizationId, externalSubject: { system: 'payments-app', subjectId: principalId } },
    actor: { actorId: `actor-${principalId}` },
  } as unknown as BoundCustomerIdentity;
}

interface Harness {
  readonly service: ReturnType<typeof createMppChallengePaymentService>;
  readonly store: MppBusinessOperationStore;
  readonly governed: { readonly identity: BoundCustomerIdentity; readonly intent: unknown }[];
}

function harness(options: {
  readonly methods?: readonly MppChallengeMethodNormalizer[];
  readonly select?: MppChallengeSelector;
  readonly resolve?: MppCounterpartyResolver;
  readonly store?: MppBusinessOperationStore;
  readonly now?: () => string;
  readonly answer?: (identity: BoundCustomerIdentity, intent: unknown) => GovernedActionResult;
} = {}): Harness {
  const store = options.store ?? createInMemoryMppBusinessOperationStore({ now: () => MPP_TEST_NOW });
  const governed: { identity: BoundCustomerIdentity; intent: unknown }[] = [];
  const service = createMppChallengePaymentService({
    orchestrator: {
      organizationId: ORG,
      async govern(bound, intent) {
        governed.push({ identity: bound, intent });
        if (options.answer !== undefined) return options.answer(bound, intent);
        const scope = bound as unknown as { principal: { principalId: string } };
        const key = (intent as { idempotencyKey: string }).idempotencyKey;
        return { status: 'executed', requestId: deriveGovernedActionRequestId({ organizationId: ORG, principalId: scope.principal.principalId, idempotencyKey: key }), reasonCodes: [], replayed: false, outcomeRecorded: true };
      },
    },
    store,
    composition: snapshotMppChallengeComposition(options.methods ?? [fakepayNormalizer(), altpayNormalizer()], options.select ?? testSelector, options.resolve ?? testCounterpartyResolver, 'test'),
    monetary: MONETARY,
    now: options.now ?? (() => MPP_TEST_NOW),
  });
  return { service, store, governed };
}

const GET: ProtectedMppRequest = { resource: 'resource-report-1', httpMethod: 'GET', expectedRealm: MPP_TEST_REALM };

function request(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { businessOperationId: 'op-1', action: 'payment.send', challenges: paymentChallenge(), protectedRequest: GET, ...overrides };
}

async function refusal(h: Harness, raw: unknown, who: BoundCustomerIdentity = identity()): Promise<string> {
  const result = await h.service.prepareAndGovern(who, raw);
  return result.outcome === 'refused' ? result.refusal : result.outcome;
}

describe('P13 — the adapted governed action is an ordinary GovernedActionIntent', () => {
  it('carries only the declared fields, a derived domain-separated key, the normalized amount and the trusted counterparty — no MPP vocabulary', async () => {
    const h = harness();
    const result = await h.service.prepareAndGovern(identity(), request());
    assert.equal(result.outcome, 'governed', JSON.stringify(result));
    assert.equal(h.governed.length, 1);
    const intent = h.governed[0]?.intent as Record<string, unknown>;
    assert.deepEqual(Object.keys(intent).sort(), ['action', 'amount', 'counterparty', 'idempotencyKey', 'resource']);
    assert.deepEqual(intent['amount'], { value: '10', currency: 'USD' });
    assert.equal(intent['counterparty'], 'merchant-a', 'the trusted mapping, not the raw recipient acct_merchant_a');
    assert.equal(intent['resource'], 'resource-report-1', 'the trusted resource, not the realm');
    assert.equal(intent['assertedContext'], undefined);
    assert.ok(String(intent['idempotencyKey']).startsWith(MPP_GOVERNED_IDEMPOTENCY_KEY_PREFIX));
    assert.equal(validateGovernedActionIntent(intent, MONETARY).valid, true);
    for (const word of ['challenge', 'realm', 'method', 'opaque', 'request', 'businessOperationId', 'externalId', 'expires']) assert.equal(JSON.stringify(intent).includes(`"${word}"`), false, word);
  });

  it('§26 / §86 / §87 the predicted request id is the orchestrator derivation, deterministic, and never a challenge value', async () => {
    const h = harness();
    const result = await h.service.prepareAndGovern(identity(), request());
    const scope = { organizationId: ORG, principalId: 'principal-a', businessOperationId: 'op-1' };
    assert.equal(result.outcome === 'governed' ? result.requestId : '', deriveMppGovernedRequestId(scope));
    assert.equal(deriveMppGovernedRequestId(scope), deriveGovernedActionRequestId({ ...scope, idempotencyKey: deriveMppGovernedIdempotencyKey(scope) }));
    assert.equal(deriveMppGovernedIdempotencyKey(scope), deriveMppGovernedIdempotencyKey({ ...scope }), 'no clock, no randomness');
    assert.notEqual(deriveMppGovernedIdempotencyKey(scope), 'op-1');
    assert.notEqual(deriveMppGovernedIdempotencyKey(scope), 'ch-1');
  });

  it('an orchestrator answering for another request id is reported as inconsistent, never as governed', async () => {
    const h = harness({ answer: () => ({ status: 'executed', requestId: 'aoc.gar:someone-else', reasonCodes: [], replayed: false, outcomeRecorded: true }) });
    const result = await h.service.prepareAndGovern(identity(), request());
    assert.equal(result.outcome, 'inconsistent');
  });
});

describe('P13 §113 / §101 / §102 / §103 / §104 / §100 — challenge identity is not business identity', () => {
  it('refreshing id, expires, opaque, header and description keeps one operation and one governed request id', async () => {
    const h = harness();
    const first = await h.service.prepareAndGovern(identity(), request({ challenges: paymentChallenge({ id: 'abc', expires: '2026-09-24T12:05:00Z' }) }));
    const refreshes = [
      paymentChallenge({ id: 'xyz', expires: '2026-09-24T12:05:00Z' }),
      paymentChallenge({ id: 'xyz', expires: '2026-09-24T12:09:00Z' }),
      paymentChallenge({ id: 'xyz', opaque: { pi: 'pi_123' } }),
      paymentChallenge({ id: 'xyz', header: 'Payment-Authorization' }),
      paymentChallenge({ id: 'abc', expires: '2026-09-24T12:05:00Z', description: 'Now with a description' }),
    ];
    const ids = new Set<string>();
    for (const challenges of refreshes) {
      const result = await h.service.prepareAndGovern(identity(), request({ challenges }));
      assert.equal(result.outcome, 'governed', JSON.stringify(result));
      if (result.outcome === 'governed') {
        assert.equal(result.operation, 'existing');
        ids.add(result.requestId);
      }
    }
    assert.equal(first.outcome === 'governed' ? first.requestId : '', [...ids][0]);
    assert.equal(ids.size, 1);
    const state = await h.store.readOperation({ organizationId: ORG }, 'principal-a', 'op-1');
    assert.equal(state?.challenges.length, 5, 'abc, then four distinct refreshes; the described repeat of abc is the same instance');
    assert.equal(new Set(h.governed.map((call) => JSON.stringify(call.intent))).size, 1, 'every refresh presents the byte-identical governed intent');
  });

  it('§18 / §146 a deliberately new purchase of the same resource is a new operation and a new request', async () => {
    const h = harness();
    const one = await h.service.prepareAndGovern(identity(), request({ businessOperationId: 'purchase-1' }));
    const two = await h.service.prepareAndGovern(identity(), request({ businessOperationId: 'purchase-2' }));
    assert.equal(one.outcome === 'governed' && two.outcome === 'governed' && one.requestId !== two.requestId, true);
  });
});

describe('P13 §105–§109 / §190 — same operation, changed business terms, conflicts BEFORE governance', () => {
  const cases: readonly (readonly [string, Record<string, unknown>])[] = [
    ['amount 10 → 10.01 USD', { challenges: paymentChallenge({ request: chargeRequest({ amount: '1001' }) }) }],
    ['amount 10 → 11 USD', { challenges: paymentChallenge({ request: chargeRequest({ amount: '1100' }) }) }],
    ['asset USD → USDC (same number, no FX)', { challenges: paymentChallenge({ request: chargeRequest({ amount: '10000000', currency: 'usdc' }) }) }],
    ['counterparty merchant-a → merchant-b', { challenges: paymentChallenge({ request: chargeRequest({ recipient: 'acct_merchant_b' }) }) }],
    ['resource', { protectedRequest: { ...GET, resource: 'resource-report-2' } }],
    ['protected request method', { protectedRequest: { ...GET, httpMethod: 'DELETE' } }],
    ['merchant external id', { challenges: paymentChallenge({ request: chargeRequest({ externalId: 'order-9' }) }) }],
  ];
  for (const [label, change] of cases) {
    it(`${label}: business-operation-conflict, govern not called`, async () => {
      const h = harness();
      assert.equal((await h.service.prepareAndGovern(identity(), request())).outcome, 'governed');
      assert.equal(await refusal(h, request({ ...change, challenges: (change['challenges'] as string | undefined) ?? paymentChallenge({ id: 'ch-2' }) })), 'business-operation-conflict');
      assert.equal(h.governed.length, 1, 'the Kernel was not reached for the conflicting call');
    });
  }

  it('protected request body A → body B conflicts, even at the same amount', async () => {
    const h = harness();
    const post = (body: string, id: string) => request({ protectedRequest: { ...GET, httpMethod: 'POST', contentDigest: computeContentDigest(body) }, challenges: paymentChallenge({ id, digest: computeContentDigest(body) }) });
    assert.equal((await h.service.prepareAndGovern(identity(), post('{"q":"a"}', 'ch-a'))).outcome, 'governed');
    assert.equal(await refusal(h, post('{"q":"b"}', 'ch-b')), 'business-operation-conflict');
    assert.equal(h.governed.length, 1);
  });
});

describe('P13 §110 / §111 — the method is transport, not business identity', () => {
  it('a different method with identical normalized terms is the same operation', async () => {
    const h = harness({ select: (candidates) => candidates[0]?.id });
    assert.equal((await h.service.prepareAndGovern(identity(), request())).outcome, 'governed');
    const alt = paymentChallenge({ id: 'alt-1', method: 'altpay', request: { payee: 'wallet_merchant_a', price: { asset: 'usd', minor: '1000' } } });
    const result = await h.service.prepareAndGovern(identity(), request({ challenges: alt }));
    assert.equal(result.outcome, 'governed', JSON.stringify(result));
    assert.equal(result.outcome === 'governed' ? result.operation : '', 'existing');
  });

  it('a different method with a different amount or asset conflicts', async () => {
    const h = harness({ select: (candidates) => candidates[0]?.id });
    await h.service.prepareAndGovern(identity(), request());
    for (const price of [{ asset: 'usd', minor: '1001' }, { asset: 'usdc', minor: '10000000' }]) {
      assert.equal(await refusal(h, request({ challenges: paymentChallenge({ id: `alt-${price.minor}`, method: 'altpay', request: { payee: 'wallet_merchant_a', price } }) })), 'business-operation-conflict');
    }
    assert.equal(h.governed.length, 1);
  });
});

describe('P13 §191 — principal scope', () => {
  it('the same businessOperationId for two principals is two operations and two request ids', async () => {
    const h = harness();
    const a = await h.service.prepareAndGovern(identity('principal-a'), request());
    const b = await h.service.prepareAndGovern(identity('principal-b'), request({ challenges: paymentChallenge({ request: chargeRequest({ amount: '1100' }) }) }));
    assert.equal(a.outcome === 'governed' && b.outcome === 'governed', true, JSON.stringify([a, b]));
    assert.notEqual(a.outcome === 'governed' ? a.requestId : 'a', b.outcome === 'governed' ? b.requestId : 'a');
  });
});

describe('P13 §66–§69 / §187 — multiple challenges and trusted selection', () => {
  const two = [paymentChallenge({ id: 'fp' }), paymentChallenge({ id: 'ap', method: 'altpay', request: { payee: 'wallet_merchant_a', price: { asset: 'usd', minor: '1000' } } })];

  it('one supported among unsupported: the supported one is offered to the selector', async () => {
    const offered: string[][] = [];
    const h = harness({ select: (candidates) => (offered.push(candidates.map((candidate) => candidate.id)), candidates[0]?.id) });
    const result = await h.service.prepareAndGovern(identity(), request({ challenges: [paymentChallenge({ id: 'unknown-method', method: 'somepay' }), paymentChallenge({ id: 'fp' })] }));
    assert.equal(result.outcome, 'governed');
    assert.deepEqual(offered, [['fp']], 'the selector is asked even for a single candidate');
  });

  it('zero supported: challenge-unsupported, govern not called', async () => {
    const h = harness();
    assert.equal(await refusal(h, request({ challenges: [paymentChallenge({ method: 'somepay' }), paymentChallenge({ intent: 'subscription' }), paymentChallenge({ intent: 'authorize' })] })), 'challenge-unsupported');
    assert.equal(h.governed.length, 0);
  });

  it('two supported: the trusted selector decides', async () => {
    const h = harness({ select: (candidates) => candidates.find((candidate) => candidate.method === 'altpay')?.id });
    const result = await h.service.prepareAndGovern(identity(), request({ challenges: two }));
    assert.equal(result.outcome, 'governed');
    const state = await h.store.readOperation({ organizationId: ORG }, 'principal-a', 'op-1');
    assert.equal(state?.challenges[0]?.method, 'altpay');
  });

  for (const [label, select] of [
    ['an unknown id', () => 'nope'],
    ['undefined', () => undefined],
    ['a throw', () => {
      throw new Error('selector down');
    }],
    ['a promise', () => Promise.resolve('fp') as unknown as string],
    ['a boxed String', () => new String('fp') as unknown as string],
  ] as const) {
    it(`a selector answering ${label} refuses — no first-wins fallback`, async () => {
      const h = harness({ select: select as MppChallengeSelector });
      assert.equal(await refusal(h, request({ challenges: two })), 'challenge-ambiguous');
      assert.equal(h.governed.length, 0);
      assert.equal(await h.store.readOperation({ organizationId: ORG }, 'principal-a', 'op-1'), undefined, 'nothing persisted');
    });
  }

  it('two candidates sharing the selected id are ambiguous', async () => {
    const h = harness({ select: () => 'same' });
    assert.equal(await refusal(h, request({ challenges: [paymentChallenge({ id: 'same' }), paymentChallenge({ id: 'same', expires: '2026-09-24T12:06:00Z' })] })), 'challenge-ambiguous');
  });

  it('a malformed Payment challenge beside a valid one is never usable; the valid one still proceeds', async () => {
    const h = harness();
    const result = await h.service.prepareAndGovern(identity(), request({ challenges: [`${paymentChallenge({ id: 'dup' })}, method="altpay"`, paymentChallenge({ id: 'ok' })] }));
    assert.equal(result.outcome, 'governed', JSON.stringify(result));
    assert.equal((await h.store.readOperation({ organizationId: ORG }, 'principal-a', 'op-1'))?.challenges[0]?.id, 'ok');
  });
});

describe('P13 §56 / §57–§59 / §61 — realm, body binding and expiry, all before governance', () => {
  it('a realm other than the expected one is refused', async () => {
    const h = harness();
    assert.equal(await refusal(h, request({ challenges: paymentChallenge({ realm: 'evil.example' }) })), 'request-binding-mismatch');
    assert.equal(h.governed.length, 0);
  });

  it('a body-bearing request without a challenge digest is refused', async () => {
    const h = harness();
    assert.equal(await refusal(h, request({ protectedRequest: { ...GET, httpMethod: 'POST', contentDigest: computeContentDigest('{"a":1}') } })), 'request-binding-mismatch');
  });

  it('a digest bound to body A against actual body B is refused', async () => {
    const h = harness();
    assert.equal(await refusal(h, request({ protectedRequest: { ...GET, httpMethod: 'POST', contentDigest: computeContentDigest('B') }, challenges: paymentChallenge({ digest: computeContentDigest('A') }) })), 'request-binding-mismatch');
    assert.equal(h.governed.length, 0);
  });

  it('a matching digest binds the body; the canonical body digest enters the business terms', async () => {
    const h = harness();
    const body = computeContentDigest('{"report":"q3"}');
    const result = await h.service.prepareAndGovern(identity(), request({ protectedRequest: { ...GET, httpMethod: 'POST', contentDigest: body }, challenges: paymentChallenge({ digest: body }) }));
    assert.equal(result.outcome, 'governed');
    assert.equal((await h.store.readOperation({ organizationId: ORG }, 'principal-a', 'op-1'))?.operation.contentDigest, body);
  });

  it('a POST whose body the trusted layer did not digest is refused outright', async () => {
    const h = harness();
    assert.equal(await refusal(h, request({ protectedRequest: { ...GET, httpMethod: 'POST' } })), 'request-invalid');
  });

  it('a digest on a request without a body is refused', async () => {
    const h = harness();
    assert.equal(await refusal(h, request({ challenges: paymentChallenge({ digest: computeContentDigest('x') }) })), 'request-binding-mismatch');
  });

  it('an expired challenge is refused by the injected clock; a later refresh of the same operation succeeds', async () => {
    const h = harness({ now: () => '2026-09-24T12:05:00.000Z' });
    assert.equal(await refusal(h, request({ challenges: paymentChallenge({ expires: '2026-09-24T12:05:00Z' }) })), 'challenge-expired');
    assert.equal(h.governed.length, 0);
    const refreshed = await h.service.prepareAndGovern(identity(), request({ challenges: paymentChallenge({ id: 'fresh', expires: '2026-09-24T12:10:00Z' }) }));
    assert.equal(refreshed.outcome, 'governed');
  });

  it('§62 / §63 expiry never erases the business operation: after it expires, a refresh maps to the same request', async () => {
    let now = MPP_TEST_NOW;
    const h = harness({ now: () => now });
    const first = await h.service.prepareAndGovern(identity(), request());
    now = '2026-09-24T13:00:00.000Z';
    assert.equal(await refusal(h, request()), 'challenge-expired');
    const refreshed = await h.service.prepareAndGovern(identity(), request({ challenges: paymentChallenge({ id: 'ch-late', expires: '2026-09-24T13:05:00Z' }) }));
    assert.equal(first.outcome === 'governed' && refreshed.outcome === 'governed' && first.requestId === refreshed.requestId, true);
  });
});

describe('P13 §129 / §155–§158 — normalizer output is untrusted executable output', () => {
  const answers: readonly (readonly [string, () => unknown])[] = [
    ['a number amount', () => ({ amount: { value: 10, unit: 'USD' } })],
    ['an unknown asset', () => ({ amount: { value: '10', unit: 'XYZ' } })],
    ['too many decimals for the asset', () => ({ amount: { value: '10.001', unit: 'USD' } })],
    ['a zero amount', () => ({ amount: { value: '0', unit: 'USD' } })],
    ['an authority field', () => ({ amount: { value: '10', unit: 'USD' }, authorized: true })],
    ['a ceiling', () => ({ amount: { value: '10', unit: 'USD' }, ceiling: '1000000' })],
    ['a budget', () => ({ amount: { value: '10', unit: 'USD' }, budget: 'b-1' })],
    ['a grant', () => ({ amount: { value: '10', unit: 'USD' }, grant: 'g-1' })],
    ['a business operation id', () => ({ amount: { value: '10', unit: 'USD' }, businessOperationId: 'op-other' })],
    ['an idempotency key', () => ({ amount: { value: '10', unit: 'USD' }, idempotencyKey: 'op-other' })],
    ['a provider outcome', () => ({ amount: { value: '10', unit: 'USD' }, paid: true, providerRef: 'pay_1' })],
    ['a counterparty', () => ({ amount: { value: '10', unit: 'USD' }, counterparty: 'merchant-b' })],
    ['a getter', () => ({ get amount() {
      return { value: '10', unit: 'USD' };
    } })],
    ['a throwing Proxy', () => new Proxy({}, { ownKeys: () => {
      throw new Error('trap');
    } })],
    ['a class instance', () => new (class Charge {
      amount = { value: '10', unit: 'USD' };
    })()],
    ['a promise', () => Promise.resolve({ amount: { value: '10', unit: 'USD' } })],
    ['a throw', () => {
      throw new Error('normalizer down');
    }],
    ['a symbol key', () => ({ amount: { value: '10', unit: 'USD' }, [Symbol('x')]: 1 })],
  ];
  for (const [label, answer] of answers) {
    it(`${label}: normalization-failed, nothing persisted, govern not called`, async () => {
      const h = harness({ methods: [{ methodId: 'fakepay', intent: 'charge', normalize: answer as MppChallengeMethodNormalizer['normalize'] }] });
      assert.equal(await refusal(h, request()), 'normalization-failed');
      assert.equal(h.governed.length, 0);
      assert.equal(await h.store.readOperation({ organizationId: ORG }, 'principal-a', 'op-1'), undefined);
    });
  }

  it('a mutable returned amount cannot change what was persisted or governed', async () => {
    const shared = { value: '10', unit: 'USD' };
    const h = harness({ methods: [{ methodId: 'fakepay', intent: 'charge', normalize: () => ({ amount: shared, merchantReference: 'acct_merchant_a' }) }] });
    assert.equal((await h.service.prepareAndGovern(identity(), request())).outcome, 'governed');
    shared.value = '99999';
    assert.equal((await h.store.readOperation({ organizationId: ORG }, 'principal-a', 'op-1'))?.operation.amount.value, '10');
  });

  it('the counterparty never comes from a raw recipient: an unmapped merchant is refused', async () => {
    const h = harness();
    assert.equal(await refusal(h, request({ challenges: paymentChallenge({ request: chargeRequest({ recipient: 'acct_unknown' }) }) })), 'counterparty-unresolved');
    for (const resolve of [() => 'merchant a ', () => 7, () => Promise.resolve('merchant-a'), () => {
      throw new Error('x');
    }]) {
      const fenced = harness({ resolve: resolve as unknown as MppCounterpartyResolver });
      assert.equal(await refusal(fenced, request()), 'counterparty-unresolved');
    }
  });

  it('§50 / §51 a currency without a trusted mapping is not an asset', async () => {
    const h = harness();
    assert.equal(await refusal(h, request({ challenges: paymentChallenge({ request: chargeRequest({ currency: 'USD' }) }) })), 'normalization-failed', 'the merchant spelling "USD" is not the trusted mapping "usd"');
    assert.equal(await refusal(h, request({ challenges: paymentChallenge({ request: chargeRequest({ amount: '10.5' }) }) })), 'normalization-failed', 'base units are integers');
  });

  it('§137 / §193 exact money: 9007199254740993.01 from base units, no numeric intermediate', async () => {
    const h = harness();
    const result = await h.service.prepareAndGovern(identity(), request({ challenges: paymentChallenge({ request: chargeRequest({ amount: '900719925474099301' }) }) }));
    assert.equal(result.outcome, 'governed');
    assert.deepEqual((h.governed[0]?.intent as { amount: unknown }).amount, { value: '9007199254740993.01', currency: 'USD' });
    assert.equal((await h.store.readOperation({ organizationId: ORG }, 'principal-a', 'op-1'))?.operation.amount.value, '9007199254740993.01');
  });

  it('§150 / §151 challenge fields shaped like outcomes or authority change nothing', async () => {
    const h = harness();
    const result = await h.service.prepareAndGovern(
      identity(),
      request({ challenges: paymentChallenge({ request: { ...chargeRequest(), paid: 'true', settled: 'true', receipt: 'r-1', providerRef: 'pay_1', approval: 'yes', ceiling: '999999', budget: 'b' }, extra: 'grant="g-1", authorized="true"' }) }),
    );
    assert.equal(result.outcome, 'governed');
    assert.deepEqual(Object.keys(h.governed[0]?.intent as object).sort(), ['action', 'amount', 'counterparty', 'idempotencyKey', 'resource']);
  });
});

describe('P13 §27 / §88 / §120 — nothing reaches governance unless the operation is durable', () => {
  it('a store that throws on record: store-unavailable, govern not called', async () => {
    const failing = createInMemoryMppBusinessOperationStore({ now: () => MPP_TEST_NOW });
    const store: MppBusinessOperationStore = { ...failing, record: async () => Promise.reject(new Error('disk full')) };
    const h = harness({ store });
    assert.equal(await refusal(h, request()), 'store-unavailable');
    assert.equal(h.governed.length, 0);
  });

  it('a store clock that is not canonical: store-unavailable, govern not called', async () => {
    const h = harness({ store: createInMemoryMppBusinessOperationStore({ now: () => 'yesterday' }) });
    assert.equal(await refusal(h, request()), 'store-unavailable');
    assert.equal(h.governed.length, 0);
  });
});

describe('P13 — request and identity validation', () => {
  it('refuses an identity that is not a bound customer identity of the served organization', async () => {
    const h = harness();
    assert.equal(await refusal(h, request(), identity('principal-a', 'org-b')), 'identity-invalid');
    assert.equal(await refusal(h, request(), { principal: { plane: 'system' } } as unknown as BoundCustomerIdentity), 'identity-invalid');
  });

  it('refuses undeclared keys, non-identifiers, and adversarial objects', async () => {
    const h = harness();
    for (const [index, raw] of [
      request({ counterparty: 'merchant-b' }),
      request({ amount: { value: '1', currency: 'USD' } }),
      request({ idempotencyKey: 'mine' }),
      request({ businessOperationId: ' op-1' }),
      request({ businessOperationId: '' }),
      request({ protectedRequest: { ...GET, url: 'https://merchant/?token=secret' } }),
      request({ protectedRequest: { ...GET, httpMethod: 'get' } }),
      request({ protectedRequest: { ...GET, contentDigest: 'sha-256=nope' } }),
      request({ challenges: 42 }),
      new Proxy(request(), { ownKeys: () => {
        throw new Error('trap');
      } }),
      Object.defineProperty(request(), 'action', { get: () => 'payment.send', enumerable: true }),
      null,
      'string',
    ].entries()) {
      assert.equal(await refusal(h, raw), 'request-invalid', `case ${String(index)}`);
    }
    assert.equal(h.governed.length, 0);
  });

  it('refuses a non-financial action before anything is stored', async () => {
    const h = harness();
    assert.equal(await refusal(h, request({ action: 'report.read' })), 'governed-intent-invalid');
    assert.equal(await h.store.readOperation({ organizationId: ORG }, 'principal-a', 'op-1'), undefined);
  });
});

describe('P13 §153 / §154 — composition', () => {
  it('refuses a duplicate method/intent, a non-charge intent, a bad method id, and missing selector or resolver', () => {
    const fp = fakepayNormalizer();
    assert.throws(() => snapshotMppChallengeComposition([fp, fakepayNormalizer()], testSelector, testCounterpartyResolver, 'x'), MppChallengeConfigurationError);
    assert.throws(() => snapshotMppChallengeComposition([{ ...fp, intent: 'subscription' }], testSelector, testCounterpartyResolver, 'x'), MppChallengeConfigurationError);
    assert.throws(() => snapshotMppChallengeComposition([{ ...fp, methodId: 'Fake-Pay' }], testSelector, testCounterpartyResolver, 'x'), MppChallengeConfigurationError);
    assert.throws(() => snapshotMppChallengeComposition([], testSelector, testCounterpartyResolver, 'x'), MppChallengeConfigurationError);
    assert.throws(() => snapshotMppChallengeComposition([fp], undefined, testCounterpartyResolver, 'x'), MppChallengeConfigurationError);
    assert.throws(() => snapshotMppChallengeComposition([fp], testSelector, undefined, 'x'), MppChallengeConfigurationError);
  });

  it('membership and identity are snapshotted: mutating the host objects later changes nothing', async () => {
    const methods: MppChallengeMethodNormalizer[] = [fakepayNormalizer()];
    const mutable = methods[0] as { methodId: string };
    const h = harness({ methods });
    mutable.methodId = 'altpay';
    methods.push(altpayNormalizer());
    assert.equal((await h.service.prepareAndGovern(identity(), request())).outcome, 'governed', 'still fakepay, still only one method');
    assert.equal(await refusal(h, request({ businessOperationId: 'op-alt', challenges: paymentChallenge({ method: 'altpay', request: { payee: 'wallet_merchant_a', price: { asset: 'usd', minor: '1000' } } }) })), 'challenge-unsupported');
  });

  it('the normalizer is never asked about an unsupported or malformed challenge', async () => {
    const calls = { count: 0 };
    const h = harness({ methods: [fakepayNormalizer({ calls })] });
    await refusal(h, request({ challenges: [paymentChallenge({ method: 'somepay' }), `${paymentChallenge()}, id="dup"`] }));
    assert.equal(calls.count, 0);
    void encodeJcs;
  });
});
