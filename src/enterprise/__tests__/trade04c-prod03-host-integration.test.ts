import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { approvals, as, commandFor } from './core05-host-fixture.js';
import { closeDeploymentWitnesses } from './core07-freshness-fixture.js';
import { FakeXrplLedger, pairWorld } from './trade04c-execution-fixture.js';
import { ACTION, APPROVER, GOVERNANCE_PIN, Workspace, admit, bootTradeHost, governTrade, post, proposalFor, type TradeHost, type TradeHostOptions } from './trade04c-host-fixture.js';

/**
 * TRADE-04C × PROD-03 — the two Host additions composed together on the
 * shipped Host (merged when PROD-03 #188 landed on main).
 *
 * PROD-03 adds one policy source rule (the file's `approvalPolicy` or an
 * embedder's `policyPackProvider`, never both: HOST_POLICY_SOURCE_AMBIGUOUS);
 * TRADE-04C adds Payment/Trade sequence-account isolation
 * (HOST_XRPL_SEQUENCE_OWNERSHIP_INVALID). Both are configuration-only checks
 * in the same pre-composition block of `bootEnterpriseHost`: neither opens a
 * store or contacts a signer, so every refusal here must leave no XRPL
 * interlock file behind and no signature. Their order is fixed (sequence
 * isolation first), so a configuration wrong both ways reports the sequence
 * refusal deterministically.
 *
 * OFFLINE: a fake ledger and the reference signer; no XRPL network.
 */

const workspace = new Workspace();
after(async () => {
  workspace.cleanup();
  await closeDeploymentWitnesses();
});

const APPROVAL_POLICY = { policyId: 'trade-desk-approvals', rules: [{ ruleId: 'every-trade-reviewed', governanceProfile: GOVERNANCE_PIN.id, reasonCode: 'TRADE_DESK_REVIEW_REQUIRED' }] };
const PAYMENT_ACTION = 'payment.execute';
const PAYMENT_TOKEN_ENV = 'FRONTERA_TRADE04C_PAYMENT_SIGNER_TOKEN';

/** A PAY-03 rail whose one source account is `address`, plus the routes and assets both domains need. */
function withPaymentRail(address: string, signingPublicKey: string): Pick<TradeHostOptions, 'envOverrides' | 'fileOverrides'> {
  return {
    envOverrides: { [PAYMENT_TOKEN_ENV]: 'FRONTERA_TRADE04C_PAYMENT_TOKEN_SENTINEL_9a1c3e5f7b' },
    fileOverrides: {
      xrplPaymentRail: {
        paymentAction: PAYMENT_ACTION,
        network: 'testnet',
        endpoint: 'wss://fake-ledger.invalid',
        asset: { paymentAsset: 'stable:RLUSD/test-issuer', currency: '524C555344000000000000000000000000000000', issuer: 'rvYAfWj5gh67oV6fW32ZzP3Aw4Eubs59B' },
        sourceAccounts: [{ accountId: 'treasury', address, signingPublicKey }],
        signer: { endpoint: 'https://payment-signer.invalid', signerId: 'payment-signer', credential: { kind: 'bearer', tokenEnv: PAYMENT_TOKEN_ENV } },
      },
      routes: [
        { action: ACTION, adapterId: 'xrpl-trade-offer-executor' },
        { action: PAYMENT_ACTION, adapterId: 'xrpl-rlusd' },
      ],
      monetary: {
        assets: [
          { assetId: 'xrp-ledger-testnet:XRP', scale: 6 },
          { assetId: 'xrp-ledger-testnet:524C555344000000000000000000000000000000/rvYAfWj5gh67oV6fW32ZzP3Aw4Eubs59B', scale: 15 },
          { assetId: 'stable:RLUSD/test-issuer', scale: 15 },
        ],
        financialActions: [ACTION, PAYMENT_ACTION],
      },
    },
  };
}

function merged(...parts: Pick<TradeHostOptions, 'envOverrides' | 'fileOverrides'>[]): Pick<TradeHostOptions, 'envOverrides' | 'fileOverrides'> {
  return {
    envOverrides: Object.assign({}, ...parts.map((part) => part.envOverrides ?? {})),
    fileOverrides: Object.assign({}, ...parts.map((part) => part.fileOverrides ?? {})),
  };
}

/**
 * The file's approvalPolicy, and the operator PROD-03 requires to decide it (an identified `approver` on the
 * operator plane; the fixture's legacy administrator cannot). Approvals in these tests are still decided through
 * CORE-05 by the provisioned trade approver.
 */
const fileApprovalPolicy: Pick<TradeHostOptions, 'envOverrides' | 'fileOverrides'> = {
  envOverrides: { FRONTERA_TRADE04C_APPROVER_OPERATOR: 'FRONTERA_TRADE04C_APPROVER_OPERATOR_SECRET_7d2a9c4e1b6f3a8e05' },
  fileOverrides: { approvalPolicy: APPROVAL_POLICY, operators: [{ operatorId: 'trade-approver', role: 'approver', apiKeyEnv: 'FRONTERA_TRADE04C_APPROVER_OPERATOR' }] },
};

/** No XRPL interlock (Payment or Trade) exists in `dir`: nothing protected was opened. */
function assertNoXrplStoreOpened(dir: string): void {
  for (const file of ['xrpl-trade-sequence-interlock.sqlite', 'xrpl-submission-interlock.sqlite']) assert.equal(existsSync(join(dir, file)), false, `${file} was opened`);
}

const code = (expected: string) => (error: { code?: string }) => {
  assert.equal(error.code, expected, String(error));
  return true;
};

describe('TRADE-04C × PROD-03 — boot refusals: each check holds alone and together, before any XRPL store opens', () => {
  it('A/G: the file approvalPolicy beside the trade embedder’s policy pack is ambiguous — refused; trade configuration does not change policy-source selection', async () => {
    const dir = workspace.dir();
    await assert.rejects(bootTradeHost(workspace, { dir, ...fileApprovalPolicy }), code('HOST_POLICY_SOURCE_AMBIGUOUS'));
    assertNoXrplStoreOpened(dir);
  });

  it('B/C/E: approvalPolicy as the one policy source, Payment and Trade sharing one owner account — the sequence-isolation refusal, nothing opened', async () => {
    const ledger = new FakeXrplLedger();
    const pair = pairWorld(ledger);
    const dir = workspace.dir();
    await assert.rejects(
      bootTradeHost(workspace, { ledger, pair, dir, embedderPolicy: false, ...merged(fileApprovalPolicy, withPaymentRail(pair.owner, pair.delegate.publicKey)) }),
      code('HOST_XRPL_SEQUENCE_OWNERSHIP_INVALID'),
    );
    assertNoXrplStoreOpened(dir);
  });

  it('D/E: wrong both ways (ambiguous policy source and shared sequence account) — refused, deterministically by sequence isolation first, nothing opened', async () => {
    const ledger = new FakeXrplLedger();
    const pair = pairWorld(ledger);
    const dir = workspace.dir();
    await assert.rejects(
      bootTradeHost(workspace, { ledger, pair, dir, ...merged(fileApprovalPolicy, withPaymentRail(pair.owner, pair.delegate.publicKey)) }),
      code('HOST_XRPL_SEQUENCE_OWNERSHIP_INVALID'),
    );
    assertNoXrplStoreOpened(dir);
  });

  it('D/E: disjoint accounts but an ambiguous policy source — still refused by the policy-source rule, nothing opened', async () => {
    const ledger = new FakeXrplLedger();
    const pair = pairWorld(ledger);
    const stranger = pairWorld(new FakeXrplLedger());
    assert.notEqual(stranger.owner, pair.owner);
    const dir = workspace.dir();
    await assert.rejects(
      bootTradeHost(workspace, { ledger, pair, dir, ...merged(fileApprovalPolicy, withPaymentRail(stranger.owner, stranger.delegate.publicKey)) }),
      code('HOST_POLICY_SOURCE_AMBIGUOUS'),
    );
    assertNoXrplStoreOpened(dir);
  });

  it('a malformed approvalPolicy on a trade Host is refused as a configuration error, before anything opens', async () => {
    const dir = workspace.dir();
    for (const approvalPolicy of [{ ...APPROVAL_POLICY, extra: true }, { policyId: 'x', rules: [{ ruleId: 'r', governanceProfile: 'no-such-profile', reasonCode: 'R' }] }]) {
      await assert.rejects(bootTradeHost(workspace, { dir, embedderPolicy: false, envOverrides: fileApprovalPolicy.envOverrides!, fileOverrides: { ...fileApprovalPolicy.fileOverrides, approvalPolicy } }), code('HOST_GOVERNED_ACTIONS_FILE_INVALID'), JSON.stringify(approvalPolicy));
    }
    assertNoXrplStoreOpened(dir);
  });
});

describe('TRADE-04C × PROD-03 — approvalPolicy as the one policy source of a trade Host: it can only add review', () => {
  let trade: TradeHost;
  const counts = (): { readonly signatures: number; readonly sends: number } => ({ signatures: trade.signer.signatures(), sends: trade.ledger.submitCalls.length });

  before(async () => {
    trade = await bootTradeHost(workspace, { embedderPolicy: false, ...fileApprovalPolicy });
  });
  after(async () => {
    await trade?.signer.close().catch(() => {});
  });

  /** Governs `raw`; if review is required, approves it through CORE-05 and resumes. Returns both replies. */
  async function governAndApprove(raw: Record<string, unknown>) {
    const intent = await admit(trade, raw);
    const first = await post(trade, intent);
    if (first.body['withheldBy'] !== 'approval') return { first, resumed: undefined };
    const view = await approvals(trade.host).describe(first.body['requestId'] as string);
    assert.ok(view !== undefined, first.text);
    await approvals(trade.host).approve(as(APPROVER), commandFor(view));
    return { first, resumed: await post(trade, intent) };
  }

  it('F: the file rule sends an in-limit order to review (zero effect); approved through CORE-05, it executes exactly once', async () => {
    const before = counts();
    const { first, resumed } = await governAndApprove(proposalFor(trade, '100'));
    assert.equal(first.body['status'], 'withheld', first.text);
    assert.equal(first.body['withheldBy'], 'approval', first.text);
    assert.equal(trade.assessments.at(-1)?.outcome, 'SATISFIED', 'TRADE-03 still assessed the order');
    assert.ok(resumed !== undefined);
    assert.equal(resumed.body['status'], 'executed', resumed.text);
    assert.deepEqual(counts(), { signatures: before.signatures + 1, sends: before.sends + 1 });
  });

  it('F: TRADE-03 governance is not bypassed — an order above the pair’s notional maximum is VIOLATED and never executes, even when a reviewer approves', async () => {
    const before = counts();
    const { first, resumed } = await governAndApprove(proposalFor(trade, '3000'));
    assert.equal(trade.assessments.at(-1)?.outcome, 'VIOLATED');
    assert.equal(first.body['status'], 'denied', `the Kernel denies before any review is opened: ${first.text}`);
    assert.equal(resumed, undefined, 'nothing was sent to review, so nothing could be approved');
    assert.deepEqual(counts(), before, `no signature, no send: ${first.text}`);
  });

  it('F: an approval never launders an altered intent — without the embedder’s TRADE-03 binding rules it reaches review, and the executor’s exact binding still refuses it: never signed or sent', async () => {
    // Composition fact (recorded, not hidden): TRADE-03's binding rules are policy-pack rules the embedder composes.
    // With the file approvalPolicy as the one policy source they are absent, so the policy layer does not deny an
    // altered intent; the reviewer sees it, and if approved, TRADE-04C's step 1 (exact binding to the attested
    // proposal the grant names) refuses before any signature.
    const before = counts();
    const intent = await admit(trade, proposalFor(trade, '10'));
    const altered = { ...intent, parameters: { ...intent.parameters, tradeQuantity: '11' } };
    const first = await post(trade, altered);
    assert.equal(first.body['withheldBy'], 'approval', first.text);
    const view = await approvals(trade.host).describe(first.body['requestId'] as string);
    assert.ok(view !== undefined);
    await approvals(trade.host).approve(as(APPROVER), commandFor(view));
    const resumed = await post(trade, altered);
    assert.notEqual(resumed.body['status'], 'executed', resumed.text);
    assert.equal(trade.traces.at(-1)?.outcome, 'failed', JSON.stringify(trade.traces.at(-1)));
    assert.equal(trade.traces.at(-1)?.detail, 'trade-execution-not-bound', 'refused at step 1, before preparation, signing or reservation');
    assert.equal(trade.traces.at(-1)?.signingRequests, 0);
    assert.deepEqual(counts(), before);
  });

  it('F: a replay of an approved, executed request never signs or sends again', async () => {
    const intent = await admit(trade, proposalFor(trade, '20'));
    const first = await post(trade, intent);
    assert.equal(first.body['withheldBy'], 'approval', first.text);
    const view = await approvals(trade.host).describe(first.body['requestId'] as string);
    await approvals(trade.host).approve(as(APPROVER), commandFor(view!));
    const executed = await post(trade, intent);
    assert.equal(executed.body['status'], 'executed', executed.text);
    const before = counts();
    const replay = await post(trade, intent);
    assert.equal(replay.body['executionId'], executed.body['executionId']);
    assert.deepEqual(counts(), before);
  });

  it('governTrade on the composed Host never reaches the ledger without review: every trade under the ruled profile is withheld first', async () => {
    const before = counts();
    const reply = await governTrade(trade, proposalFor(trade, '5'));
    assert.equal(reply.body['withheldBy'], 'approval', reply.text);
    assert.deepEqual(counts(), before);
  });
});
