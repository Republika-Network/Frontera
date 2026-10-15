import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { closeDeploymentWitnesses } from './core07-freshness-fixture.js';
import { FakeXrplLedger, pairWorld } from './trade04c-execution-fixture.js';
import { ACTION, GOVERNANCE_PIN, Workspace, bootTradeHost, type TradeHostOptions } from './trade04c-host-fixture.js';

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
  it('A/G: the file approvalPolicy beside the trade policy is refused — on a trade Host by the trade rule (R8), which precedes PROD-03’s generic ambiguity rule; without trade, PROD-03’s selection is unchanged (prod03 suites)', async () => {
    const dir = workspace.dir();
    await assert.rejects(bootTradeHost(workspace, { dir, ...fileApprovalPolicy }), code('HOST_TRADE_POLICY_SOURCE_CONFLICT'));
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

  it('D/E: disjoint accounts but a second policy source — still refused (the trade policy-source rule), nothing opened', async () => {
    const ledger = new FakeXrplLedger();
    const pair = pairWorld(ledger);
    const stranger = pairWorld(new FakeXrplLedger());
    assert.notEqual(stranger.owner, pair.owner);
    const dir = workspace.dir();
    await assert.rejects(
      bootTradeHost(workspace, { ledger, pair, dir, ...merged(fileApprovalPolicy, withPaymentRail(stranger.owner, stranger.delegate.publicKey)) }),
      code('HOST_TRADE_POLICY_SOURCE_CONFLICT'),
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

// An approvalPolicy as a trade Host's only policy source was R8: an order TRADE-03 marked for review executed
// without approval when the file ruled another profile. That composition is now refused at boot — see
// trade04c-r8-trade-policy.test.ts (R8-B) and trade04c-r8-mutation.test.ts.
