import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { inspect } from 'node:util';
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { X402_HTTP_HEADERS, canonicalX402Requirements, decodeX402PaymentSignatureHeader, parseX402Json, serializeX402Json } from '../../features/payment-runtime/protocols/x402/index.js';
import { lightningDestinationOf, preimageMatchesPaymentHash } from '../../features/payment-runtime/rails/lightning/index.js';
import { testPreimage } from '../../features/payment-runtime/rails/lightning/tests/lightning-test-fixtures.js';
import type { GovernedActionResult } from '../governed-action/index.js';
import type { PaymentProtocolIngressResult } from '../payment-protocol-ingress/index.js';
import { readX402PaymentResponseEvidence } from '../x402-payment-protocol/index.js';
import { closeAllWitnesses } from './core07-freshness-fixture.js';
import { DENIED_ACTOR, identityFor } from './governed-action-support.js';
import {
  BTC,
  CONFIGURATION,
  LNBTC_TESTNET,
  OVER_MSAT,
  PROTECTED_GET,
  RESOURCE_URL,
  TARGET,
  b64Json,
  carrierOf,
  cleanupPay08Directories,
  contentDigestOf,
  createReferenceX402Server,
  openX402World,
  type AgentRequest,
  type X402World,
} from './pay08-x402-world.js';

/**
 * PAY-08 — the governed exit proof and its adversarial cases, on the real
 * governed stack and PAY-06's Lightning rail (testnet, simulated node).
 *
 * ```
 * agent GET → merchant 402 + PAYMENT-REQUIRED → strict x402 v2 decode → trusted selection (lnbtc mapping)
 *   → business operation, durable + CORE-07-anchored → PaymentIntent → PAY-01 compiler → govern()
 *   → Kernel → P10 → GRANT → P7 → claim → PAY-01 bridge → Lightning rail (ONE send) → P11
 *   → PAY-05 verifySettlement (preimage finality) → receipt → PAYMENT-SIGNATURE (after settlement only)
 *   → merchant /settle-side check → 200 + PAYMENT-RESPONSE (evidence, never settlement) → ASSURE-01 trace
 * ```
 */

after(async () => {
  await closeAllWitnesses();
  cleanupPay08Directories();
});

const GET: AgentRequest = Object.freeze({ method: 'GET', url: RESOURCE_URL });

function governed(outcome: PaymentProtocolIngressResult): GovernedActionResult & { readonly requestId: string } {
  assert.equal(outcome.outcome, 'governed', JSON.stringify(outcome).slice(0, 400));
  if (outcome.outcome !== 'governed') throw new Error('not governed');
  return outcome.result as GovernedActionResult & { readonly requestId: string };
}

function refusal(outcome: PaymentProtocolIngressResult): string {
  assert.equal(outcome.outcome, 'refused', JSON.stringify(outcome).slice(0, 400));
  return outcome.outcome === 'refused' ? outcome.refusal : '';
}

async function withWorld<T>(run: (world: X402World) => Promise<T>, options?: Parameters<typeof openX402World>[0]): Promise<T> {
  const world = await openX402World(options);
  try {
    return await run(world);
  } finally {
    await world.close();
  }
}

/** Every byte under the world's directory: SQLite files and their WAL. */
function durableBytes(world: X402World): string {
  return readdirSync(world.directory)
    .map((name) => readFileSync(join(world.directory, name)).toString('latin1'))
    .join('\n');
}

describe('PAY-08 — the governed x402 exit proof (Lightning, testnet)', () => {
  it('402 → strict decode → trusted selection → governed GRANT → one Lightning send → P11 → PAY-05 settled → receipt → PAYMENT-SIGNATURE → 200 → ASSURE trace', async () => {
    await withWorld(async (world) => {
      const server = createReferenceX402Server({ node: world.node });
      // The discovery request: not a payment effect.
      const discovery = await server.respond(GET);
      assert.equal(discovery.status, 402);
      assert.equal(world.effects(), 0);

      const outcome = await world.present({ carrier: carrierOf(discovery) });
      const result = governed(outcome);
      assert.equal(result.status, 'executed', JSON.stringify(result));
      assert.equal(outcome.outcome === 'governed' && outcome.operation, 'created');
      assert.equal(world.effects(), 1, 'exactly one money-moving call, through the rail');
      assert.equal(world.governedIntents.length, 1);

      // The canonical PaymentIntent, as the rail was instructed by PAY-01's bridge — no x402 field anywhere.
      const [instruction] = world.railInstructions;
      const { paymentHash } = testPreimage('pay08-invoice-1-25000');
      assert.deepEqual({ ...instruction?.amount }, { value: '0.00000025', unit: BTC });
      assert.equal(instruction?.destination.kind, 'lightning-invoice');
      assert.equal(instruction?.destination.reference.endsWith(`:${paymentHash}`), true);
      assert.equal(/x402|lnbtc|PAYMENT-/i.test(JSON.stringify(world.governedIntents[0])), false, 'no protocol vocabulary reaches the governed intent');
      assert.equal(/x402|lnbtc/i.test(JSON.stringify(instruction)), false, 'nor the rail instruction');

      // Before PAY-05 verifies finality, there is no proof to release.
      const executionId = result.executionId as string;
      assert.deepEqual(await world.buildSignature({ requestId: result.requestId, executionId }), { outcome: 'refused', refusal: 'not-settled' });

      const settled = await world.verifySettlement(executionId);
      assert.equal(settled.outcome, 'settled', JSON.stringify(settled));
      const receipt = await world.receipt(executionId);
      assert.ok(receipt !== undefined);

      const built = await world.buildSignature({ requestId: result.requestId, executionId });
      assert.equal(built.outcome, 'built', JSON.stringify(built));
      if (built.outcome !== 'built') return;
      assert.equal(built.signature.header, X402_HTTP_HEADERS.paymentSignature);
      const payload = decodeX402PaymentSignatureHeader(built.signature.reveal());
      assert.ok(payload.valid);
      assert.ok(preimageMatchesPaymentHash(payload.value.payload['preimage'], paymentHash));
      assert.equal(payload.value.accepted.network, LNBTC_TESTNET);

      // The paid request: the merchant validates the proof itself (settle-only: upfront never calls /verify).
      const paid = await server.respond({ ...GET, headers: { 'payment-signature': built.signature.reveal() } });
      assert.equal(paid.status, 200, JSON.stringify(server.counters));
      assert.equal(server.counters.verifyCalls, 0);
      assert.equal(server.counters.settleCalls, 1);
      const context = await world.contexts().readByGovernedRequestId('org-datasys', result.requestId);
      assert.ok(context !== undefined);
      const evidence = readX402PaymentResponseEvidence(carrierOf(paid), context);
      assert.deepEqual(evidence, { outcome: 'evidence', status: 200, serverReportsSuccess: true, consistent: true });

      // One payment, one effect — the paid retry moved nothing.
      assert.equal(world.effects(), 1);
      const trace = await world.trace(result.requestId);
      assert.equal(trace.verified, true, trace.failed.join(', '));
      assert.equal(/preimage|x402/i.test(trace.json) && trace.json.includes(payload.value.payload['preimage'] ?? '§'), false, 'the trace carries no proof');
    });
  });

  it('a second presentation of the proof is the merchant’s duplicate, never a second Frontera payment', async () => {
    await withWorld(async (world) => {
      const server = createReferenceX402Server({ node: world.node });
      const result = governed(await world.present({ carrier: carrierOf(await server.respond(GET)) }));
      await world.verifySettlement(result.executionId as string);
      const built = await world.buildSignature({ requestId: result.requestId, executionId: result.executionId as string });
      assert.ok(built.outcome === 'built');
      assert.equal((await server.respond({ ...GET, headers: { 'payment-signature': built.signature.reveal() } })).status, 200);
      const again = await world.buildSignature({ requestId: result.requestId, executionId: result.executionId as string });
      assert.ok(again.outcome === 'built');
      assert.equal(again.signature.reveal(), built.signature.reveal(), 'a deterministic proof of one payment');
      const duplicate = await server.respond({ ...GET, headers: { 'payment-signature': again.signature.reveal() } });
      assert.equal(duplicate.status, 402);
      assert.deepEqual(server.counters.refused, ['duplicate_settlement']);
      assert.equal(world.effects(), 1);
    });
  });
});

describe('PAY-08 — governance decides; a 402 forces nothing', () => {
  it('denied: a valid PaymentRequired from a principal without authority → no rail call, no proof, the trace records the denial', async () => {
    await withWorld(async (world) => {
      const server = createReferenceX402Server({ node: world.node });
      const result = governed(await world.present({ carrier: carrierOf(await server.respond(GET)), identity: identityFor({ actorId: DENIED_ACTOR }) }));
      assert.equal(result.status, 'denied', JSON.stringify(result));
      assert.equal(world.effects(), 0);
      assert.equal(world.railInstructions.length, 0);
      assert.equal(server.counters.settleCalls, 0);
      assert.equal((await world.buildSignature({ requestId: result.requestId, executionId: 'none' })).outcome, 'refused');
      const trace = await world.trace(result.requestId);
      assert.equal(trace.verified, true, trace.failed.join(', '));
      assert.equal(trace.finalState, 'denied');
    });
  });

  it('over the ceiling: the shared governance withholds at issuance — zero external effect, nothing prepaid', async () => {
    await withWorld(async (world) => {
      const server = createReferenceX402Server({ node: world.node, amountMsat: OVER_MSAT });
      const result = governed(await world.present({ carrier: carrierOf(await server.respond(GET)) }));
      assert.equal(result.status, 'withheld', JSON.stringify(result));
      assert.ok(result.reasonCodes.includes('FINANCIAL_AUTHORITY_CEILING_EXCEEDED'), result.reasonCodes.join(','));
      assert.equal(world.effects(), 0);
      assert.equal(world.railInstructions.length, 0);
      assert.equal(world.node.calls.decodeInvoice, 0, 'the rail was never reached');
    });
  });
});

describe('PAY-08 — business operation and replay (BOP-X)', () => {
  it('BOP-X1 exact replay: same operation, same requirement, same resource → the same governed request, replayed, no second payment', async () => {
    await withWorld(async (world) => {
      const server = createReferenceX402Server({ node: world.node });
      const carrier = carrierOf(await server.respond(GET));
      const first = await world.present({ carrier });
      const second = await world.present({ carrier });
      assert.equal(governed(first).status, 'executed');
      const replay = governed(second);
      assert.equal(replay.status, 'executed');
      assert.equal(replay.requestId, governed(first).requestId);
      assert.equal('replayed' in replay && replay.replayed, true);
      assert.equal(second.outcome === 'governed' && second.operation, 'existing');
      assert.equal(second.outcome === 'governed' && second.challenge, 'existing');
      assert.equal(world.effects(), 1);
      // After a restart, the same operation still replays.
      await world.restart();
      const third = await world.present({ carrier });
      assert.equal(governed(third).requestId, governed(first).requestId);
      assert.equal(world.effects(), 1);
    });
  });

  it('BOP-X2 … X10 every material change under the same operation is refused before governance', async () => {
    await withWorld(async (world) => {
      const server = createReferenceX402Server({ node: world.node });
      const original = await server.requirementFor(GET, 'pay08-bop-original');
      const presentWith = (accepts: readonly unknown[], extra: Partial<Parameters<X402World['present']>[0]> = {}) => world.present({ carrier: { status: 402, headers: [['PAYMENT-REQUIRED', b64Json(server.paymentRequiredJson(GET, accepts))]] }, ...extra });
      assert.equal(governed(await presentWith([original])).status, 'executed');
      const governedBefore = world.governedIntents.length;
      const effectsBefore = world.effects();

      const extraOf = original['extra'] as Record<string, unknown>;
      const cases: readonly [string, () => Promise<PaymentProtocolIngressResult>, readonly string[]][] = [
        // A new invoice for another amount: a new payment hash and amount → different business terms.
        ['X2 amount (new invoice)', async () => presentWith([await server.requirementFor(GET, 'pay08-bop-amount', { invoiceAmountMsat: 26_000n })]), ['business-operation-conflict']],
        ['X2 amount (same invoice)', () => presentWith([{ ...original, amount: '26000' }]), ['normalization-failed']],
        ['X3 asset', () => presentWith([{ ...original, asset: 'SAT' }]), ['challenge-unsupported']],
        ['X4 payTo (same invoice)', () => presentWith([{ ...original, payTo: `02${'1'.repeat(64)}` }]), ['counterparty-unresolved']],
        ['X4 payTo (another merchant node)', async () => presentWith([await createReferenceX402Server({ node: world.node, payeeKeyLabel: 'other-payee' }).requirementFor(GET, 'pay08-bop-payee')]), ['business-operation-conflict']],
        ['X5 network', () => presentWith([{ ...original, network: 'lnbtc:000000000019d6689c085ae165831e93' }]), ['challenge-unsupported']],
        ['X6 scheme', () => presentWith([{ ...original, scheme: 'upto' }]), ['challenge-unsupported']],
        ['X10 timeout (same invoice)', () => presentWith([{ ...original, maxTimeoutSeconds: 300 }]), ['normalization-failed']],
        ['X10 timeout (refreshed invoice)', async () => presentWith([await createReferenceX402Server({ node: world.node, maxTimeoutSeconds: 300 }).requirementFor(GET, 'pay08-bop-timeout')]), ['business-operation-conflict']],
        ['same instrument, other exact terms', () => presentWith([{ ...original, extra: { ...extraOf, assetTransferMethod: undefined } }]), ['challenge-conflict']],
        ['refreshed invoice, same terms', async () => presentWith([await server.requirementFor(GET, 'pay08-bop-refresh')]), ['business-operation-conflict']],
      ];
      for (const [name, present, expected] of cases) {
        const got = refusal(await present());
        assert.ok(expected.includes(got), `${name}: ${got}`);
      }
      assert.equal(world.governedIntents.length, governedBefore, 'no govern() on any conflict');
      assert.equal(world.effects(), effectsBefore);
    });
  });

  it('BOP-X7 / X8 / X9 another resource, method or body is another protected request: a conflict under the same operation', async () => {
    await withWorld(async (world) => {
      const server = createReferenceX402Server({ node: world.node });
      assert.equal(governed(await world.present({ carrier: carrierOf(await server.respond(GET)) })).status, 'executed');
      const before = world.governedIntents.length;
      const body = Buffer.from('{"refresh":true}');
      const post: AgentRequest = { method: 'POST', url: RESOURCE_URL, body };
      // X8 / X9: the merchant correctly binds the POST and its body; under the same operation it is a different purchase.
      assert.equal(refusal(await world.present({ carrier: carrierOf(await server.respond(post)), protectedRequest: { target: TARGET, method: 'POST', contentDigest: contentDigestOf(body) } })), 'business-operation-conflict');
      // X7: another protected resource for the same operation does not even bind (the resolver maps targets to exact URLs).
      assert.equal(refusal(await world.present({ carrier: carrierOf(await server.respond(GET)), protectedRequest: { target: 'merchant:report-43', method: 'GET' } })), 'request-binding-mismatch');
      assert.equal(world.governedIntents.length, before);
      assert.equal(world.effects(), 1);
    });
  });

  it('X12 one invoice belongs to one business operation: the same requirement under a new operation id is refused (one invoice, one payment)', async () => {
    await withWorld(async (world) => {
      const server = createReferenceX402Server({ node: world.node });
      const carrier = carrierOf(await server.respond(GET));
      assert.equal(governed(await world.present({ carrier })).status, 'executed');
      assert.equal(refusal(await world.present({ carrier, businessOperationId: 'pay08-checkout-2' })), 'challenge-conflict');
      // A deliberately new purchase is a new challenge: a fresh invoice, a new operation, a second governed payment.
      assert.equal(governed(await world.present({ carrier: carrierOf(await server.respond(GET)), businessOperationId: 'pay08-checkout-2' })).status, 'executed');
      assert.equal(world.effects(), 2);
    });
  });

  it('BOP-X11 a stale restore of the business-operation store is refused at open (CORE-07): nothing can govern', async () => {
    await withWorld(async (world) => {
      const server = createReferenceX402Server({ node: world.node });
      const backup = await world.backupOperations();
      const carrier = carrierOf(await server.respond(GET));
      assert.equal(governed(await world.present({ carrier })).status, 'executed');
      const restored = await world.restoreOperations(backup);
      assert.deepEqual(restored, { refused: true, code: 'AUTHORITY_FRESHNESS_ROLLBACK_DETECTED' });
      assert.equal(world.effects(), 1);
    });
  });

  it('BOP-X12 the CORE-07 witness unavailable: refused before governance, never "proceed for now"', async () => {
    await withWorld(async (world) => {
      const server = createReferenceX402Server({ node: world.node });
      const carrier = carrierOf(await server.respond(GET));
      await world.witness.close();
      assert.equal(refusal(await world.present({ carrier })), 'store-freshness-unverified');
      assert.equal(world.governedIntents.length, 0);
      assert.equal(world.effects(), 0);
    });
  });
});

describe('PAY-08 — the presentation forwards the caller’s request untouched', () => {
  it('runs no accessor on the request: a getter-bearing request is refused by the ingress’s own closed reader, with nothing governed', async () => {
    await withWorld(async (world) => {
      const server = createReferenceX402Server({ node: world.node });
      const carrier = carrierOf(await server.respond(GET));
      let ran = false;
      const request = {
        businessOperationId: 'pay08-checkout-1',
        protocol: 'x402',
        get challenges() {
          ran = true;
          return carrier;
        },
        protectedRequest: PROTECTED_GET,
        payment: { source: { accountId: 'project:HMP-14665' }, purpose: 'vendor-payment' },
      };
      const outcome = await world.presentRaw(identityFor({}), request);
      assert.equal(outcome.outcome, 'refused');
      assert.equal(ran, false);
      assert.equal(world.governedIntents.length, 0);
      assert.equal(world.effects(), 0);
    });
  });
});

describe('PAY-08 — protected-request binding (X8 … X10)', () => {
  it('a requirement issued for resource B is not payable for resource A', async () => {
    await withWorld(async (world) => {
      const server = createReferenceX402Server({ node: world.node });
      const other = carrierOf(await server.respond({ method: 'GET', url: 'https://api.merchant.example/reports/43?format=json' }));
      assert.equal(refusal(await world.present({ carrier: other })), 'request-binding-mismatch');
      assert.equal(world.governedIntents.length, 0);
    });
  });

  it('a requirement issued for GET does not pay for a POST; one for body X not for body Y', async () => {
    await withWorld(async (world) => {
      const server = createReferenceX402Server({ node: world.node });
      const getCarrier = carrierOf(await server.respond(GET));
      assert.equal(refusal(await world.present({ carrier: getCarrier, protectedRequest: { target: TARGET, method: 'POST', contentDigest: contentDigestOf(Buffer.from('x')) } })), 'request-binding-mismatch');
      const bodyX = Buffer.from('{"q":"x"}');
      const postCarrier = carrierOf(await server.respond({ method: 'POST', url: RESOURCE_URL, body: bodyX }));
      assert.equal(refusal(await world.present({ carrier: postCarrier, protectedRequest: { target: TARGET, method: 'POST', contentDigest: contentDigestOf(Buffer.from('{"q":"y"}')) } })), 'request-binding-mismatch');
      assert.equal(governed(await world.present({ carrier: postCarrier, protectedRequest: { target: TARGET, method: 'POST', contentDigest: contentDigestOf(bodyX) } })).status, 'executed');
      assert.equal(world.effects(), 1);
    });
  });

  it('bound headers are committed from the trusted request; one the network layer cannot attest is not bindable', async () => {
    await withWorld(
      async (world) => {
        const server = createReferenceX402Server({ node: world.node, boundHeaders: ['accept'] });
        const response = await server.respond({ ...GET, headers: { accept: 'application/json' } });
        assert.equal(governed(await world.present({ carrier: carrierOf(response) })).status, 'executed');
      },
      { fields: { accept: 'application/json' } },
    );
    await withWorld(async (world) => {
      const server = createReferenceX402Server({ node: world.node, boundHeaders: ['accept'] });
      const response = await server.respond({ ...GET, headers: { accept: 'application/json' } });
      assert.equal(refusal(await world.present({ carrier: carrierOf(response) })), 'request-binding-mismatch');
      assert.equal(world.effects(), 0);
    });
  });
});

describe('PAY-08 — P11 / P12 / PAY-05 stay the rail’s; protocol evidence is never settlement', () => {
  it('unconfirmed → resolved by the Lightning P12 authority → PAY-05 settles → only then a proof', async () => {
    await withWorld(async (world) => {
      const server = createReferenceX402Server({ node: world.node });
      world.node.behaviour = 'hold';
      const carrier = carrierOf(await server.respond(GET));
      const result = governed(await world.present({ carrier }));
      assert.equal(result.status, 'execution_unconfirmed', JSON.stringify(result));
      const executionId = result.executionId as string;
      assert.equal((await world.buildSignature({ requestId: result.requestId, executionId })).outcome, 'refused');
      // Presenting the same requirement again never retries: the governed request replays as unconfirmed.
      assert.equal(governed(await world.present({ carrier })).status, 'execution_unconfirmed');
      // A refreshed invoice for the same operation is another payment hash: refused, not a retry.
      assert.equal(refusal(await world.present({ carrier: carrierOf(await server.respond(GET)) })), 'business-operation-conflict');
      assert.equal(world.effects(), 1);
      world.node.settleHeld(testPreimage('pay08-invoice-1-25000').paymentHash);
      const reconciled = (await world.reconcile(executionId)) as { readonly outcome: string };
      assert.equal(reconciled.outcome, 'resolved', JSON.stringify(reconciled));
      assert.equal((await world.verifySettlement(executionId)).outcome, 'settled');
      assert.equal((await world.buildSignature({ requestId: result.requestId, executionId })).outcome, 'built');
      assert.equal(world.effects(), 1);
    });
  });

  it('X21 / X22 HTTP 200 and PAYMENT-RESPONSE success do not settle anything; a response about another payment is inconsistent', async () => {
    await withWorld(async (world) => {
      const server = createReferenceX402Server({ node: world.node });
      const result = governed(await world.present({ carrier: carrierOf(await server.respond(GET)) }));
      const executionId = result.executionId as string;
      const context = await world.contexts().readByGovernedRequestId('org-datasys', result.requestId);
      assert.ok(context !== undefined);
      const paymentHash = testPreimage('pay08-invoice-1-25000').paymentHash;
      const claimed = { status: 200, headers: [['PAYMENT-RESPONSE', b64Json({ success: true, transaction: paymentHash, network: LNBTC_TESTNET })]] };
      assert.deepEqual(readX402PaymentResponseEvidence(claimed, context), { outcome: 'evidence', status: 200, serverReportsSuccess: true, consistent: true });
      const status = await world.readSettlement(executionId);
      assert.equal(status.outcome === 'status' && status.state, 'awaiting-finality', 'a merchant’s success is not PAY-05 settlement');
      assert.equal((await world.buildSignature({ requestId: result.requestId, executionId })).outcome, 'refused');
      for (const [response, mismatch] of [
        [{ success: true, transaction: 'f'.repeat(64), network: LNBTC_TESTNET }, 'transaction'],
        [{ success: true, transaction: paymentHash, network: 'lnbtc:000000000019d6689c085ae165831e93' }, 'network'],
        [{ success: true, transaction: paymentHash, network: LNBTC_TESTNET, payer: 'someone' }, 'payer'],
        [{ success: true, transaction: paymentHash, network: LNBTC_TESTNET, amount: '1' }, 'amount'],
      ] as const) {
        const evidence = readX402PaymentResponseEvidence({ status: 200, headers: [['PAYMENT-RESPONSE', b64Json(response)]] }, context);
        assert.equal(evidence.outcome === 'evidence' && evidence.mismatch, mismatch);
      }
      assert.deepEqual(readX402PaymentResponseEvidence({ status: 200, headers: [] }, context), { outcome: 'unreadable', violation: 'carrier-payment-response-missing' }, 'a bare 200 is no evidence at all');
      const still = await world.readSettlement(executionId);
      assert.equal(still.outcome === 'status' && still.state, 'awaiting-finality');
    });
  });

  it('the paid request is never sent by Frontera, and a failed merchant check does not touch Frontera state', async () => {
    await withWorld(async (world) => {
      const server = createReferenceX402Server({ node: world.node });
      const result = governed(await world.present({ carrier: carrierOf(await server.respond(GET)) }));
      await world.verifySettlement(result.executionId as string);
      const built = await world.buildSignature({ requestId: result.requestId, executionId: result.executionId as string });
      assert.ok(built.outcome === 'built');
      // Replayed onto another request, the merchant's own check refuses it; Frontera's state is unchanged.
      const replayed = await server.respond({ method: 'GET', url: 'https://api.merchant.example/reports/43?format=json', headers: { 'payment-signature': built.signature.reveal() } });
      assert.equal(replayed.status, 402);
      assert.deepEqual(server.counters.refused, ['invalid_exact_lnbtc_request_mismatch']);
      const status = await world.readSettlement(result.executionId as string);
      assert.equal(status.outcome === 'status' && status.state, 'settled');
      assert.equal(world.effects(), 1);
    });
  });
});

describe('PAY-08 — secret hygiene (canaries)', () => {
  it('the PAYMENT-SIGNATURE value and the preimage never reach a store, P11, P12, PAY-05, a receipt, the trace, an error or a rendering', async () => {
    await withWorld(async (world) => {
      const server = createReferenceX402Server({ node: world.node });
      const result = governed(await world.present({ carrier: carrierOf(await server.respond(GET)) }));
      const executionId = result.executionId as string;
      const settled = await world.verifySettlement(executionId);
      assert.equal(settled.outcome, 'settled');
      const built = await world.buildSignature({ requestId: result.requestId, executionId });
      assert.ok(built.outcome === 'built');
      const header = built.signature.reveal();
      const preimage = testPreimage('pay08-invoice-1-25000').preimage;
      assert.ok(header.length > 100);

      // Renderings are redacted.
      for (const rendering of [String(built.signature), JSON.stringify(built.signature), JSON.stringify({ built }), inspect(built.signature), inspect(built, { depth: 5 }), `${built.signature as unknown as string}`]) {
        assert.equal(rendering.includes(header), false, rendering.slice(0, 60));
        assert.equal(rendering.includes(preimage), false);
      }
      await world.restart();
      const everything = [
        durableBytes(world),
        JSON.stringify(await world.receipt(executionId)),
        JSON.stringify(await world.readSettlement(executionId)),
        (await world.trace(result.requestId)).json,
        JSON.stringify(await world.contexts().readByGovernedRequestId('org-datasys', result.requestId)),
        JSON.stringify(world.governedIntents),
        JSON.stringify(world.railInstructions),
      ].join('\n');
      assert.equal(everything.includes(header), false, 'PAYMENT-SIGNATURE in durable state or evidence');
      assert.equal(everything.includes(preimage), false, 'the preimage in durable state or evidence');
      assert.equal(everything.includes('PAYMENT-SIGNATURE header is required'), false, 'the merchant’s free-text error never persists');
      assert.equal(everything.includes('Quarterly report 42'), false, 'display metadata never persists');
      // Errors: a builder refusal carries a closed token only.
      const refused = await world.buildSignature({ requestId: 'aoc_unknown', executionId });
      assert.deepEqual(refused, { outcome: 'refused', refusal: 'context-not-found' });
    });
  });
});

describe('PAY-08 — the PaymentPayload is bound to the governed terms (PP)', () => {
  it('PP-1 exact governed terms; PP-2 … PP-6 the merchant’s check refuses any altered accepted term, and Frontera never builds one', async () => {
    await withWorld(async (world) => {
      const server = createReferenceX402Server({ node: world.node });
      const result = governed(await world.present({ carrier: carrierOf(await server.respond(GET)) }));
      await world.verifySettlement(result.executionId as string);
      const built = await world.buildSignature({ requestId: result.requestId, executionId: result.executionId as string });
      assert.ok(built.outcome === 'built');
      const payload = decodeX402PaymentSignatureHeader(built.signature.reveal());
      assert.ok(payload.valid);
      const context = await world.contexts().readByGovernedRequestId('org-datasys', result.requestId);
      assert.ok(context !== undefined);
      // PP-1: `accepted` is byte-for-byte the governed requirement, and its payee and hash are the governed destination.
      const stored = parseX402Json(context.challenge.fields['requirement'] ?? '');
      assert.ok(stored.valid);
      assert.equal(lightningDestinationOf(payload.value.accepted.payTo, testPreimage('pay08-invoice-1-25000').paymentHash).reference, context.terms.destination.reference);
      assert.equal(payload.value.accepted.amount, context.challenge.fields['amount']);
      // PP-2 … PP-6: altered copies fail the merchant's own check (the payload is bound to the requirement and the request).
      const tamper = (change: Record<string, unknown>): string => {
        const accepted = { ...JSON.parse(JSON.stringify(payload.value.accepted)), ...change };
        return Buffer.from(JSON.stringify({ x402Version: 2, accepted, payload: { ...payload.value.payload } })).toString('base64');
      };
      for (const [change, reason] of [
        [{ amount: '26000' }, 'invalid_exact_lnbtc_amount_mismatch'],
        [{ payTo: `02${'2'.repeat(64)}` }, 'invalid_exact_lnbtc_invoice_payee_mismatch'],
        [{ network: 'lnbtc:000000000019d6689c085ae165831e93' }, 'network_mismatch'],
        [{ scheme: 'upto' }, 'unsupported_scheme'],
      ] as const) {
        const response = await server.respond({ ...GET, headers: { 'payment-signature': tamper(change) } });
        assert.equal(response.status, 402);
        assert.equal(server.counters.refused.at(-1), reason);
      }
      const otherResource = await server.respond({ method: 'GET', url: `${RESOURCE_URL}&page=2`, headers: { 'payment-signature': built.signature.reveal() } });
      assert.equal(otherResource.status, 402, 'PP-6 resource');
      assert.equal(world.effects(), 1);
    });
  });

  it('PP-9 / PP-12 a proof is built only for an x402 operation that is this execution’s; a missing proof source answer is refused', async () => {
    await withWorld(async (world) => {
      const server = createReferenceX402Server({ node: world.node });
      const first = governed(await world.present({ carrier: carrierOf(await server.respond(GET)) }));
      const second = governed(await world.present({ carrier: carrierOf(await server.respond(GET)), businessOperationId: 'pay08-checkout-2' }));
      await world.verifySettlement(first.executionId as string);
      await world.verifySettlement(second.executionId as string);
      assert.deepEqual(await world.buildSignature({ requestId: first.requestId, executionId: second.executionId as string }), { outcome: 'refused', refusal: 'settlement-mismatch' }, 'one operation’s proof is never built from another’s payment');
      assert.equal((await world.buildSignature({ requestId: second.requestId, executionId: second.executionId as string })).outcome, 'built');
      assert.equal(PROTECTED_GET.target, TARGET);
      assert.equal(CONFIGURATION.network, 'testnet');
    });
  });
});

describe('PAY-08 lifecycle hardening — the rail pays the governed execution’s exact invoice, and history exhausts nothing (LIFE, governed stack)', () => {
  const invoiceOf = (requirement: Record<string, unknown>): string => (requirement['extra'] as Record<string, unknown>)['invoice'] as string;
  const paymentRequiredCarrier = (server: ReturnType<typeof createReferenceX402Server>, request: AgentRequest, requirement: Record<string, unknown>) => ({ status: 402, headers: [['PAYMENT-REQUIRED', b64Json(server.paymentRequiredJson(request, [requirement]))]] as [string, string][] });

  it('LIFE-2 A and B share (payee, payment hash): A cached for another resource, B governed — the rail is given exactly B, once; A under a new operation is refused before governance', async () => {
    await withWorld(async (world) => {
      const server = createReferenceX402Server({ node: world.node });
      const elsewhere: AgentRequest = { method: 'GET', url: `${RESOURCE_URL}&edition=a` };
      const requirementA = await server.requirementFor(elsewhere, 'pay08-collide');
      await world.adapter.prepare(paymentRequiredCarrier(server, elsewhere, requirementA));
      const requirementB = await server.requirementFor(GET, 'pay08-collide');
      assert.notEqual(invoiceOf(requirementA), invoiceOf(requirementB));
      const result = governed(await world.present({ carrier: paymentRequiredCarrier(server, GET, requirementB) }));
      assert.equal(result.status, 'executed');
      assert.deepEqual(world.invoiceLookups.map((lookup) => lookup.served), [invoiceOf(requirementB)], 'exactly B, the governed text');
      assert.equal(world.invoiceLookups[0]?.executionId, result.executionId);
      assert.equal(world.effects(), 1);
      // The governed instrument under another operation: one instrument, one operation — refused before govern().
      const intents = world.governedIntents.length;
      assert.equal(refusal(await world.present({ carrier: paymentRequiredCarrier(server, GET, requirementB), businessOperationId: 'pay08-checkout-other' })), 'challenge-conflict');
      assert.equal(world.governedIntents.length, intents);
      assert.equal(world.effects(), 1);
    });
  });

  it('LIFE-3 a cache miss is a re-decode, not a refusal and not a substitution: with a one-entry decoding window, A is prepared, evicted, re-prepared and paid exactly', async () => {
    await withWorld(
      async (world) => {
        const server = createReferenceX402Server({ node: world.node });
        const requirementA = await server.requirementFor(GET, 'pay08-life3-a');
        await world.adapter.prepare(paymentRequiredCarrier(server, GET, requirementA));
        for (const label of ['pay08-life3-x', 'pay08-life3-y']) await world.adapter.prepare(paymentRequiredCarrier(server, GET, await server.requirementFor(GET, label)));
        const result = governed(await world.present({ carrier: paymentRequiredCarrier(server, GET, requirementA) }));
        assert.equal(result.status, 'executed');
        assert.deepEqual(world.invoiceLookups.map((lookup) => lookup.served), [invoiceOf(requirementA)]);
        assert.equal(world.effects(), 1);
      },
      { verifierEntries: 1 },
    );
  });

  it('LIFE-4 / LIFE-9 restart after settlement: the exact replay is answered from the record — no rail instruction, no invoice lookup, no send', async () => {
    await withWorld(async (world) => {
      const server = createReferenceX402Server({ node: world.node });
      const carrier = carrierOf(await server.respond(GET));
      const first = governed(await world.present({ carrier }));
      assert.equal((await world.verifySettlement(first.executionId as string)).outcome, 'settled');
      const counts = { lookups: world.invoiceLookups.length, instructions: world.railInstructions.length, effects: world.effects() };
      await world.restart();
      const replay = governed(await world.present({ carrier }));
      assert.equal(replay.requestId, first.requestId);
      assert.equal('replayed' in replay && replay.replayed, true);
      assert.deepEqual({ lookups: world.invoiceLookups.length, instructions: world.railInstructions.length, effects: world.effects() }, counts);
    });
  });

  it('LIFE-5 / LIFE-6 / LIFE-10 120 sequential operations through an 8-entry decoding window: every one governs, is given its own exact invoice, sends once and settles — then a fresh one still does', async () => {
    await withWorld(
      async (world) => {
        const server = createReferenceX402Server({ node: world.node });
        const total = 120;
        for (let index = 1; index <= total; index += 1) {
          const response = await server.respond(GET);
          const requirement = JSON.parse(Buffer.from(response.headers[0]?.[1] ?? '', 'base64').toString('utf8')) as { accepts: Record<string, unknown>[] };
          const result = governed(await world.present({ carrier: carrierOf(response), businessOperationId: `pay08-life6-${String(index)}` }));
          assert.equal(result.status, 'executed', `operation ${String(index)}`);
          assert.equal(world.invoiceLookups.at(-1)?.served, invoiceOf(requirement.accepts[0] as Record<string, unknown>), `operation ${String(index)} is given its own invoice`);
          assert.equal((await world.verifySettlement(result.executionId as string)).outcome, 'settled');
        }
        assert.equal(world.effects(), total, 'one send per operation, never more');
        assert.equal(world.invoiceLookups.length, total);
        const fresh = governed(await world.present({ carrier: carrierOf(await server.respond(GET)), businessOperationId: 'pay08-life10-fresh' }));
        assert.equal(fresh.status, 'executed', 'history exhausted nothing');
        assert.equal(world.effects(), total + 1);
      },
      { verifierEntries: 8 },
    );
  });

  it('LIFE-7 unconfirmed: the binding is the durable record, so nothing is retired early; replays never look up or send; P12 resolves with no second send', async () => {
    await withWorld(async (world) => {
      const server = createReferenceX402Server({ node: world.node });
      world.node.behaviour = 'hold';
      const carrier = carrierOf(await server.respond(GET));
      const result = governed(await world.present({ carrier }));
      assert.equal(result.status, 'execution_unconfirmed');
      assert.equal(world.invoiceLookups.length, 1);
      assert.equal(governed(await world.present({ carrier })).status, 'execution_unconfirmed');
      await world.restart();
      assert.equal(governed(await world.present({ carrier })).status, 'execution_unconfirmed');
      assert.equal(world.invoiceLookups.length, 1, 'no second lookup');
      world.node.settleHeld(testPreimage('pay08-invoice-1-25000').paymentHash);
      assert.equal(((await world.reconcile(result.executionId as string)) as { readonly outcome: string }).outcome, 'resolved');
      assert.equal((await world.verifySettlement(result.executionId as string)).outcome, 'settled');
      assert.equal(world.effects(), 1);
    });
  });

  it('LIFE-8 definitive not-completed: the replay remains no-send, before and after a restart', async () => {
    await withWorld(async (world) => {
      const server = createReferenceX402Server({ node: world.node });
      world.node.behaviour = 'fail';
      const carrier = carrierOf(await server.respond(GET));
      const result = governed(await world.present({ carrier }));
      assert.notEqual(result.status, 'executed');
      assert.notEqual(result.status, 'execution_unconfirmed');
      world.node.behaviour = 'succeed';
      const replay = governed(await world.present({ carrier }));
      assert.equal(replay.requestId, result.requestId);
      assert.equal(replay.status, result.status);
      await world.restart();
      assert.equal(governed(await world.present({ carrier })).status, result.status);
      assert.equal(world.effects(), 1);
      assert.equal(world.invoiceLookups.length, 1);
    });
  });

  it('LIFE-11 the same payment hash reused by a new operation after the first completed: refused before governance — the new operation never inherits the old text', async () => {
    await withWorld(async (world) => {
      const server = createReferenceX402Server({ node: world.node });
      const requirementA = await server.requirementFor(GET, 'pay08-life11');
      const first = governed(await world.present({ carrier: paymentRequiredCarrier(server, GET, requirementA) }));
      assert.equal((await world.verifySettlement(first.executionId as string)).outcome, 'settled');
      // The merchant reissues for the same resource, payee and payment hash: a different, fully valid text.
      const reissuer = createReferenceX402Server({ node: world.node, maxTimeoutSeconds: 900 });
      const requirementB = await reissuer.requirementFor(GET, 'pay08-life11');
      assert.notEqual(invoiceOf(requirementB), invoiceOf(requirementA));
      const intents = world.governedIntents.length;
      assert.equal(refusal(await world.present({ carrier: paymentRequiredCarrier(reissuer, GET, requirementB), businessOperationId: 'pay08-life11-second' })), 'challenge-conflict');
      assert.equal(world.governedIntents.length, intents);
      assert.equal(world.effects(), 1);
      assert.equal(world.invoiceLookups.length, 1);
    });
  });

  it('LIFE-12 two concurrent operations with distinct invoices: each execution is given its own exact text, one send each', async () => {
    await withWorld(async (world) => {
      const server = createReferenceX402Server({ node: world.node });
      const one = await server.requirementFor(GET, 'pay08-life12-one');
      const two = await server.requirementFor(GET, 'pay08-life12-two');
      const [first, second] = await Promise.all([
        world.present({ carrier: paymentRequiredCarrier(server, GET, one), businessOperationId: 'pay08-life12-one' }),
        world.present({ carrier: paymentRequiredCarrier(server, GET, two), businessOperationId: 'pay08-life12-two' }),
      ]);
      const [r1, r2] = [governed(first), governed(second)];
      assert.equal(r1.status, 'executed');
      assert.equal(r2.status, 'executed');
      const servedTo = new Map(world.invoiceLookups.map((lookup) => [lookup.executionId, lookup.served]));
      assert.equal(servedTo.get(r1.executionId as string), invoiceOf(one));
      assert.equal(servedTo.get(r2.executionId as string), invoiceOf(two));
      assert.equal(world.effects(), 2);
    });
  });
});

describe('PAY-08 hardening — PAYMENT-RESPONSE is evidence only (RESP)', () => {
  it('RESP-8 / RESP-9 success, failure and pending responses — consistent or not — never settle, and write nothing to P11, P12 or PAY-05', async () => {
    await withWorld(async (world) => {
      const server = createReferenceX402Server({ node: world.node });
      const result = governed(await world.present({ carrier: carrierOf(await server.respond(GET)) }));
      const executionId = result.executionId as string;
      const context = await world.contexts().readByGovernedRequestId('org-datasys', result.requestId);
      assert.ok(context !== undefined);
      const paymentHash = testPreimage('pay08-invoice-1-25000').paymentHash;
      const before = durableBytes(world);
      const responses = [
        [200, { success: true, transaction: paymentHash, network: LNBTC_TESTNET }],
        [200, { success: true, transaction: 'e'.repeat(64), network: LNBTC_TESTNET }],
        [402, { success: false, errorReason: 'settlement_pending', transaction: paymentHash, network: LNBTC_TESTNET }],
        [402, { success: false, errorReason: 'settlement_pending', transaction: '', network: LNBTC_TESTNET }],
        [402, { success: false, errorReason: 'insufficient_funds', transaction: 'e'.repeat(64), network: LNBTC_TESTNET }],
      ] as const;
      for (const [status, response] of responses) readX402PaymentResponseEvidence({ status, headers: [['PAYMENT-RESPONSE', b64Json(response)]] }, context);
      assert.equal(durableBytes(world), before, 'RESP-9 no store byte changed');
      const read = await world.readSettlement(executionId);
      assert.equal(read.outcome === 'status' && read.state, 'awaiting-finality', 'RESP-8 HTTP 200 is not PAY-05 settlement');
    });
  });
});

describe('PAY-08 hardening — PaymentPayload extensions echo the server and add only client info (EXT-MERGE, governed stack)', () => {
  it('the built PAYMENT-SIGNATURE carries the exact accepted requirement, the validated preimage, every server extension unchanged and the client’s additive info', async () => {
    const serverExtensions = { bazaar: { info: { category: 'reports', limits: { rows: 100 } }, schema: { type: 'object', properties: { category: { type: 'string' } } } } };
    await withWorld(async (world) => {
      const server = createReferenceX402Server({ node: world.node, extensions: serverExtensions });
      const result = governed(await world.present({ carrier: carrierOf(await server.respond(GET)) }));
      await world.verifySettlement(result.executionId as string);
      const additions = parseX402Json('{"bazaar":{"info":{"client":"frontera","limits":{"page":2}}},"trace":{"info":{"id":"t-1"},"schema":{"type":"object"}}}');
      assert.ok(additions.valid);
      const built = await world.buildSignature({ requestId: result.requestId, executionId: result.executionId as string, clientExtensions: additions.value as never });
      assert.ok(built.outcome === 'built', JSON.stringify(built));
      const payload = decodeX402PaymentSignatureHeader(built.signature.reveal());
      assert.ok(payload.valid);
      assert.equal(serializeX402Json(payload.value.extensions?.['bazaar']), '{"info":{"category":"reports","client":"frontera","limits":{"page":2,"rows":100}},"schema":{"properties":{"category":{"type":"string"}},"type":"object"}}');
      assert.equal(serializeX402Json(payload.value.extensions?.['trace']), '{"info":{"id":"t-1"},"schema":{"type":"object"}}');
      assert.ok(preimageMatchesPaymentHash(payload.value.payload['preimage'] as string, testPreimage('pay08-invoice-1-25000').paymentHash));
      const context = await world.contexts().readByGovernedRequestId('org-datasys', result.requestId);
      assert.ok(context !== undefined);
      assert.equal(canonicalX402Requirements(payload.value.accepted), context.challenge.fields['requirement'], 'accepted is exactly the governed requirement');
      // The merchant serves the resource for it; the governed record's server extensions are unchanged by the client's additions.
      assert.equal((await server.respond({ ...GET, headers: { 'payment-signature': built.signature.reveal() } })).status, 200);
      const sent = parseX402Json(JSON.stringify(serverExtensions));
      assert.ok(sent.valid);
      assert.equal(context.challenge.fields['extensions'], serializeX402Json(sent.value));
      const overwrite = parseX402Json('{"bazaar":{"info":{"category":"free"}}}');
      assert.ok(overwrite.valid);
      assert.deepEqual(await world.buildSignature({ requestId: result.requestId, executionId: result.executionId as string, clientExtensions: overwrite.value as never }), { outcome: 'refused', refusal: 'extension-overwrite' });
      assert.equal(world.effects(), 1);
    });
  });
});
