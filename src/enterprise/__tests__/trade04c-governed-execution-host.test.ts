import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import { createSqliteTradeSequenceInterlock, tradeExecutionEvidenceOf, type TradeSubmissionRecord } from '../xrpl-trade-execution/index.js';
import { ORG, call, type Reply } from './core04-host-fixture.js';
import { approvals, as, commandFor } from './core05-host-fixture.js';
import { closeDeploymentWitnesses } from './core07-freshness-fixture.js';
import { decodeBlob } from './trade04b-xrpl-fixture.js';
import { FakeXrplLedger, pairWorld } from './trade04c-execution-fixture.js';
import { ADMIN_BEARER, APPROVER, GOVERNANCE_PIN, Workspace, admit, bootTradeHost, governTrade, post, proposalFor, tradeExecutionSection, type TradeHost } from './trade04c-host-fixture.js';

/**
 * TRADE-04C — Scenarios A–F and Host composition, on the canonical shipped
 * Host (see `trade04c-host-fixture.ts` for exactly what is real and what is a
 * labelled fake). Every scenario counts the two effects that matter:
 * signatures the delegate signer produced, and sends past the submit site's
 * durable claim (`ledger.submitCalls`). OFFLINE: no XRPL network, no funded
 * account, no ledger write — these are TRADE-04C integration scenarios, not
 * TRADE-05 live qualification.
 */

const workspace = new Workspace();
let main: TradeHost;

before(async () => {
  main = await bootTradeHost(workspace);
});
after(async () => {
  await main?.signer.close().catch(() => {});
  workspace.cleanup();
  await closeDeploymentWitnesses();
});

const counts = (trade: TradeHost): { readonly signatures: number; readonly sends: number } => ({ signatures: trade.signer.signatures(), sends: trade.ledger.submitCalls.length });

async function tradeRecord(trade: TradeHost, executionId: string): Promise<TradeSubmissionRecord | undefined> {
  // Verification-mode read of the Host's own file (no scope, no witness, writes nothing).
  const reader = await createSqliteTradeSequenceInterlock(join(trade.dir, 'xrpl-trade-sequence-interlock.sqlite'), { now: () => new Date().toISOString() });
  try {
    return await reader.read(executionId);
  } finally {
    await reader.close();
  }
}

function assertNoEffect(trade: TradeHost, before: ReturnType<typeof counts>, reply: Reply): void {
  assert.deepEqual(counts(trade), before, `no signature, no send: ${reply.text}`);
}

describe('TRADE-04C Scenario A — allowed: authorized, signed, reserved, submitted exactly once, validated', () => {
  it('the full authority-to-submission chain, with evidence linking the governed decision to the ledger transaction', async () => {
    const before = counts(main);
    const raw = proposalFor(main, '100');
    const reply = await governTrade(main, raw);
    assert.equal(reply.body['status'], 'executed', reply.text);
    assert.deepEqual(counts(main), { signatures: before.signatures + 1, sends: before.sends + 1 });
    const executionId = reply.body['executionId'] as string;
    const tx = main.ledger.submitted.at(-1)!;
    assert.equal(tx.executionId, executionId, 'the submitted blob is the one this P11 execution reserved');
    const fields = decodeBlob(tx.blob);
    assert.equal(fields['Account'], main.pair.owner);
    assert.equal(fields['Delegate'], main.pair.delegate.address);
    assert.deepEqual(fields['TakerGets'], raw['takerGets']);
    assert.equal(fields['TakerPays'], (raw['takerPays'] as { drops: string }).drops);

    const record = await tradeRecord(main, executionId);
    assert.ok(record !== undefined);
    const evidence = tradeExecutionEvidenceOf(record, 1);
    assert.equal(evidence.status, 'validated-applied');
    assert.equal(evidence.ledgerProvenance, 'injected-ledger-client', 'the evidence says the ledger facts came from an injected (fake) ledger client');
    assert.equal(evidence.signature.transactionHash, tx.hash);
    assert.equal(evidence.reservation.submissionAttempts, 1);
    assert.equal(evidence.authority.organizationId, ORG);
    const lookup = await call(main.baseUrl, 'GET', `/api/admin/authority/executions/${encodeURIComponent(executionId)}`, { authorization: ADMIN_BEARER });
    assert.equal(lookup.status, 200, lookup.text);
    assert.equal(lookup.body['grantId'], evidence.authority.boundedGrantId, 'the P11 execution and the trade evidence name the same bounded grant');
    assert.equal(main.traces.at(-1)?.outcome, 'completed');
    assert.equal(main.assessments.at(-1)?.outcome, 'SATISFIED');
  });

  it('a replay of the same governed request never signs or sends again', async () => {
    const intent = await admit(main, proposalFor(main, '50'));
    const first = await post(main, intent);
    assert.equal(first.body['status'], 'executed', first.text);
    const before = counts(main);
    const replay = await post(main, intent);
    assert.equal(replay.body['executionId'], first.body['executionId']);
    assertNoEffect(main, before, replay);
  });
});

describe('TRADE-04C Scenario B — economic ceiling: rejected before signing and submission', () => {
  it('above the pair’s notional maximum the risk assessment is VIOLATED and the Kernel denies', async () => {
    const before = counts(main);
    const reply = await governTrade(main, proposalFor(main, '3000'));
    assert.equal(reply.body['status'], 'denied', reply.text);
    assert.equal(main.assessments.at(-1)?.outcome, 'VIOLATED');
    assertNoEffect(main, before, reply);
  });

  it('above the owner’s P10 ceiling the existing financial authority withholds', async () => {
    const before = counts(main);
    // Within the risk profile (≤ 5000 XRP notional with review above 1500 requiring approval) — but P10 is checked on its own merits.
    const reply = await governTrade(main, proposalFor(main, '5001', '1000000'));
    assert.notEqual(reply.body['status'], 'executed', reply.text);
    assertNoEffect(main, before, reply);
  });

  it('an intent the applicant compiled or altered itself is never executed (no binding, or a substituted field)', async () => {
    const before = counts(main);
    const intent = await admit(main, proposalFor(main, '10'));
    const altered = await post(main, { ...intent, parameters: { ...intent.parameters, tradeQuantity: '11' } });
    assert.notEqual(altered.body['status'], 'executed', altered.text);
    assertNoEffect(main, before, altered);
  });
});

describe('TRADE-04C Scenario C — approval: nothing before it; after it, execution only while every other constraint holds', () => {
  it('withheld for approval with zero signing; approved, the resumed request executes once', async () => {
    const before = counts(main);
    const intent = await admit(main, proposalFor(main, '800'));
    const withheld = await post(main, intent);
    assert.equal(withheld.body['status'], 'withheld', withheld.text);
    assert.equal(withheld.body['withheldBy'], 'approval', withheld.text);
    assert.equal(main.assessments.at(-1)?.disposition, 'APPROVAL_REQUIRED');
    assertNoEffect(main, before, withheld);

    const view = await approvals(main.host).describe(withheld.body['requestId'] as string);
    assert.ok(view !== undefined);
    await approvals(main.host).approve(as(APPROVER), commandFor(view));
    const resumed = await post(main, intent);
    assert.equal(resumed.body['status'], 'executed', resumed.text);
    assert.deepEqual(counts(main), { signatures: before.signatures + 1, sends: before.sends + 1 });
  });

  it('approved, but the delegation was revoked meanwhile: the executor’s fresh ledger re-read refuses — zero signing', async () => {
    const intent = await admit(main, proposalFor(main, '900'));
    const withheld = await post(main, intent);
    assert.equal(withheld.body['withheldBy'], 'approval', withheld.text);
    const view = await approvals(main.host).describe(withheld.body['requestId'] as string);
    await approvals(main.host).approve(as(APPROVER), commandFor(view!));
    main.ledger.revoke(main.pair.owner, main.pair.delegate.address);
    try {
      const before = counts(main);
      const resumed = await post(main, intent);
      assert.notEqual(resumed.body['status'], 'executed', resumed.text);
      assertNoEffect(main, before, resumed);
      assert.equal(main.traces.at(-1)?.detail, 'trade-delegation-not-authorized');
    } finally {
      main.ledger.delegate(main.pair.owner, main.pair.delegate.address);
    }
  });

  it('an emergency stop on the owner account withholds a satisfied order before any execution', async () => {
    const stop = await call(main.baseUrl, 'POST', '/api/admin/emergency-controls/activate', { authorization: ADMIN_BEARER, body: { scope: 'resource', value: main.resource } });
    assert.equal(stop.status, 200, stop.text);
    try {
      const before = counts(main);
      const reply = await governTrade(main, proposalFor(main, '10'));
      assert.equal(reply.body['withheldBy'], 'emergency-control', reply.text);
      assertNoEffect(main, before, reply);
    } finally {
      await call(main.baseUrl, 'POST', '/api/admin/emergency-controls/release', { authorization: ADMIN_BEARER, body: { scope: 'resource', value: main.resource } });
    }
  });
});

describe('TRADE-04C Scenario D — delegation revoked after the assessment, before signing', () => {
  it('TRADE-03 assessed AUTHORIZED; the executor’s validated re-read finds no delegation: zero signing, zero submission', async () => {
    const ledger = main.ledger;
    const original = ledger.ledgerEntry.bind(ledger);
    let delegateReads = 0;
    ledger.ledgerEntry = (request) => {
      const answer = original(request);
      if (request['delegate'] !== undefined) {
        delegateReads += 1;
        // The first read is the governed assessment's; revoke right after it, so only the executor's re-read sees it.
        if (delegateReads === 1) ledger.revoke(main.pair.owner, main.pair.delegate.address);
      }
      return answer;
    };
    try {
      const before = counts(main);
      const reply = await governTrade(main, proposalFor(main, '20'));
      assert.equal(delegateReads, 2, 'assessed once by TRADE-03, re-read once by the executor');
      assert.equal(main.assessments.at(-1)?.outcome, 'SATISFIED');
      assert.notEqual(reply.body['status'], 'executed', reply.text);
      assert.equal(main.traces.at(-1)?.detail, 'trade-delegation-not-authorized');
      assertNoEffect(main, before, reply);
    } finally {
      ledger.ledgerEntry = original;
      ledger.delegate(main.pair.owner, main.pair.delegate.address);
    }
  });
});

describe('TRADE-04C Scenario F — uncertain execution: one attempt, persistent uncertainty, no blind retry, ledger-based reconciliation', () => {
  it('the transport fails after the blob may have reached the ledger: unconfirmed, one send; P12 resolves it from validated ledger evidence', async () => {
    main.ledger.behavior = { kind: 'throw-after-send', includeWith: 'tesSUCCESS' };
    main.ledger.autoAdvance = false;
    try {
      const before = counts(main);
      const reply = await governTrade(main, proposalFor(main, '30'));
      assert.notEqual(reply.body['status'], 'executed', reply.text);
      assert.notEqual(reply.body['status'], 'failed', 'never reported as a definitive failure');
      assert.deepEqual(counts(main), { signatures: before.signatures + 1, sends: before.sends + 1 }, 'exactly one attempt, no retry');
      const executionId = reply.body['executionId'] as string;
      assert.equal((await tradeRecord(main, executionId))?.state, 'unconfirmed');
      // Still uncertain: the transaction is not yet in a validated ledger.
      assert.deepEqual(await main.host.enterprise.executionReconciliation?.reconcile({ organizationId: ORG, executionId }), { outcome: 'unresolved' });
      main.ledger.advance(1);
      const resolved = await main.host.enterprise.executionReconciliation?.reconcile({ organizationId: ORG, executionId });
      assert.equal((resolved as { outcome?: string }).outcome, 'resolved', JSON.stringify(resolved));
      assert.equal(counts(main).sends, before.sends + 1, 'reconciliation never resubmits');
      assert.equal((await tradeRecord(main, executionId))?.settlement, 'validated-success');
    } finally {
      main.ledger.behavior = { kind: 'accept' };
      main.ledger.autoAdvance = true;
    }
  });
});

describe('TRADE-04C Scenario E — tampering: a valid signature over a different trade is refused; zero submission', () => {
  it('TRADE-04C-S1: another TakerPays substituted in transit — the signer refuses it against the capability (zero signatures), nothing is reserved or sent', async () => {
    const trade = await bootTradeHost(workspace);
    try {
      trade.signer.tamper = (transaction) => ({ ...transaction, TakerPays: '1' });
      const before = counts(trade);
      const reply = await governTrade(trade, proposalFor(trade, '40'));
      assert.notEqual(reply.body['status'], 'executed', reply.text);
      assert.equal(trade.signer.signatures(), before.signatures, 'the signer signed nothing: the capability binds the exact signing preimage');
      assert.equal(trade.signer.lastRefusal(), 'capability-transaction-mismatch');
      assert.equal(trade.ledger.submitCalls.length, before.sends, 'and nothing was sent');
      assert.equal(trade.traces.at(-1)?.detail, 'trade-signer-refused');
      assert.equal(await tradeRecord(trade, reply.body['executionId'] as string), undefined, 'nothing reserved');
      trade.signer.tamper = undefined;
      // TRADE-04D D-1: the signer WAS contacted, so its refusal is not proof that no signature exists — the intent holds the owner Sequence until the ledger passes LastLedgerSequence.
      const held = await governTrade(trade, proposalFor(trade, '41'));
      assert.notEqual(held.body['status'], 'executed', held.text);
      assert.equal(trade.traces.at(-1)?.detail, 'trade-sequence-in-flight', 'the refused attempt’s window is held, never released on the signer’s word');
      assert.equal(trade.ledger.submitCalls.length, before.sends);
      trade.ledger.advance(21);
      const after = await governTrade(trade, proposalFor(trade, '42'));
      assert.equal(after.body['status'], 'executed', 'an honest refusal does not contradict the pin: once the ledger closes the window, the next authorized order executes');
      assert.equal(trade.ledger.submitCalls.length, before.sends + 1);
    } finally {
      await trade.signer.close();
    }
  });

  it('a compromised signer (it ignores the capability) answers a valid signature over another TakerPays: content binding refuses it, nothing is reserved or sent, and the signer is MISMATCH thereafter', async () => {
    const trade = await bootTradeHost(workspace);
    try {
      trade.signer.forge = (request) => {
        const capability = JSON.parse((request['authorization'] as { capability: string }).capability) as { capabilityId: string };
        const signed = trade.pair.delegate.sign({ ...(request['transaction'] as Record<string, unknown>), TakerPays: '1' });
        return { protocol: request['protocol'], signerId: request['signerId'], requestId: request['requestId'], capabilityId: capability.capabilityId, ownerAccount: request['ownerAccount'], delegateAccount: request['delegateAccount'], signedTransaction: signed.blob, hash: signed.hash };
      };
      const before = counts(trade);
      const reply = await governTrade(trade, proposalFor(trade, '40'));
      assert.notEqual(reply.body['status'], 'executed', reply.text);
      assert.equal(trade.ledger.submitCalls.length, before.sends, 'nothing was sent');
      assert.equal(trade.traces.at(-1)?.detail, 'trade-signature-rejected');
      assert.equal(await tradeRecord(trade, reply.body['executionId'] as string), undefined, 'nothing reserved');
      trade.signer.forge = undefined;
      const after = await governTrade(trade, proposalFor(trade, '41'));
      assert.notEqual(after.body['status'], 'executed', 'a signer that contradicted its pin stays refused for this Host’s life');
      assert.equal(trade.ledger.submitCalls.length, before.sends);
    } finally {
      await trade.signer.close();
    }
  });
});

describe('TRADE-04C G4 — Host composition refuses anything it cannot serve safely', () => {
  it('Payment and Trade sharing one owner account on one network: refused before either interlock is opened', async () => {
    const ledger = new FakeXrplLedger();
    const pair = pairWorld(ledger);
    const paymentRail = {
      paymentAction: 'payment.execute',
      network: 'testnet',
      endpoint: 'wss://fake-ledger.invalid',
      asset: { paymentAsset: 'stable:RLUSD/test-issuer', currency: '524C555344000000000000000000000000000000', issuer: 'rvYAfWj5gh67oV6fW32ZzP3Aw4Eubs59B' },
      sourceAccounts: [{ accountId: 'treasury', address: pair.owner, signingPublicKey: pair.delegate.publicKey }],
      signer: { endpoint: 'https://payment-signer.invalid', signerId: 'payment-signer', credential: { kind: 'bearer', tokenEnv: 'FRONTERA_TRADE04C_PAYMENT_SIGNER_TOKEN' } },
    };
    const dir = workspace.dir();
    await assert.rejects(
      bootTradeHost(workspace, {
        ledger,
        pair,
        dir,
        envOverrides: { FRONTERA_TRADE04C_PAYMENT_SIGNER_TOKEN: 'FRONTERA_TRADE04C_PAYMENT_TOKEN_SENTINEL_9a1c3e5f7b' },
        fileOverrides: {
          xrplPaymentRail: paymentRail,
          routes: [
            { action: 'trade.offer-create', adapterId: 'xrpl-trade-offer-executor' },
            { action: 'payment.execute', adapterId: 'xrpl-rlusd' },
          ],
          monetary: { assets: [{ assetId: 'xrp-ledger-testnet:XRP', scale: 6 }, { assetId: 'xrp-ledger-testnet:524C555344000000000000000000000000000000/rvYAfWj5gh67oV6fW32ZzP3Aw4Eubs59B', scale: 15 }, { assetId: 'stable:RLUSD/test-issuer', scale: 15 }], financialActions: ['trade.offer-create', 'payment.execute'] },
        },
      }),
      (error: { code?: string }) => error.code === 'HOST_XRPL_SEQUENCE_OWNERSHIP_INVALID',
    );
    const { existsSync } = await import('node:fs');
    assert.equal(existsSync(join(dir, 'xrpl-trade-sequence-interlock.sqlite')), false, 'the trade interlock was never opened');
  });

  it('no TRADE-03 attested-proposal source composed: the Host refuses to start', async () => {
    await assert.rejects(bootTradeHost(workspace, { omitAttestation: true }), (error: { code?: string }) => error.code === 'XRPL_TRADE_ATTESTATION_SOURCE_MISSING');
  });

  it('the reference offer signer’s own configuration or any XRPL / owner / delegate key variable in the Host environment: refused', async () => {
    for (const name of ['FRONTERA_REFERENCE_XRPL_OFFER_SIGNER_KEY_FILE', 'OWNER_XRPL_SEED', 'DELEGATE_PRIVATE_KEY']) {
      await assert.rejects(bootTradeHost(workspace, { envOverrides: { [name]: 'x' } }), (error: { code?: string }) => error.code === 'HOST_ENVIRONMENT_INVALID', name);
    }
  });

  it('a signer that answers another identity: refused at boot', async () => {
    const other = new FakeXrplLedger();
    const stranger = pairWorld(other);
    const { startSignerProxy } = await import('./trade04c-host-fixture.js');
    const wrongSigner = await startSignerProxy(stranger, workspace.dir());
    try {
      await assert.rejects(bootTradeHost(workspace, { signerEndpoint: wrongSigner.endpoint }), (error: { code?: string }) => error.code === 'XRPL_TRADE_SIGNER_IDENTITY_MISMATCH');
    } finally {
      await wrongSigner.close();
    }
  });

  it('configuration is closed and fail-closed: an unknown field, mainnet, a duplicate owner, a fee above its ceiling, an unrouted action, missing trade parameters', async () => {
    const ledger = new FakeXrplLedger();
    const pair = pairWorld(ledger);
    const base = tradeExecutionSection(pair, 'http://127.0.0.1:1');
    for (const sectionOverrides of [
      { seed: 'sEd…' },
      { network: 'xrp-ledger-mainnet' },
      { pairs: [...(base['pairs'] as unknown[]), ...(base['pairs'] as unknown[])] },
      { feeDrops: '101' },
      { lastLedgerOffset: 201 },
      { endpoint: 'ws://fake-ledger.invalid' },
      { tradeAction: 'trade.other' },
      { signer: { ...(base['signer'] as object), credential: { kind: 'bearer', token: 'inline' } } },
    ]) {
      await assert.rejects(bootTradeHost(workspace, { ledger, pair, sectionOverrides }), (error: { code?: string }) => error.code === 'HOST_GOVERNED_ACTIONS_FILE_INVALID', JSON.stringify(sectionOverrides));
    }
    await assert.rejects(bootTradeHost(workspace, { ledger, pair, envOverrides: { FRONTERA_TRADE04C_OFFER_SIGNER_TOKEN: undefined } }), (error: { code?: string }) => error.code === 'HOST_SECRET_REFERENCE_UNRESOLVED');
    void GOVERNANCE_PIN;
  });
});
