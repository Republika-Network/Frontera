import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Client, type Wallet } from 'xrpl';

import { createFinancialActionClassifier, createMonetaryAssetRegistry } from '../../features/monetary-runtime/index.js';
import { PAYMENT_PARAMETER_DIMENSIONS, PAYMENT_PROFILE_PARAMETERS, compilePaymentIntent, createPaymentGovernanceBinding, createPaymentRailExecutionAdapter, validatePaymentIntent, type PaymentIntent } from '../../features/payment-runtime/index.js';
import { createXrplRlusdRail, createXrplRlusdRailConfiguration, createXrplSdkClient } from '../../features/payment-runtime/rails/xrpl/index.js';
import { RLUSD_CURRENCY_HEX, createTestSoftwareXrplSigner } from '../../features/payment-runtime/rails/xrpl/tests/xrpl-test-fixtures.js';
import { buildAuthorityTrace } from '../evidence/trace-builder.js';
import { createGovernanceProfileRegistry } from '../governance-profile/index.js';
import { ALLOWED_INTENT, IDENTITY, ORG, buildGovernedWorld, monetaryAuthority } from './governed-action-support.js';

/**
 * PAY-02 live smoke qualification — **XRPL Testnet only, opt-in.**
 *
 * Skipped unless `FRONTERA_XRPL_TESTNET_SMOKE=1`. Never part of the default
 * suite, never mainnet: it refuses to run unless the server reports
 * `network_id` 1, and the rail itself refuses any other network.
 *
 * Setup uses the SDK directly, as an operator would, and is **not** the rail:
 * three ephemeral faucet-funded accounts, a stand-in issuer issuing the RLUSD
 * currency code (Ripple's own Testnet RLUSD needs a separate faucet), trust
 * lines from both holders, and a small issuance to the treasury. Then one
 * payment is governed end to end through the real governed path, the real
 * PAY-01 bridge, the real rail and the real SDK client, with the test-only
 * software signer. No secret is printed.
 */
const ENABLED = process.env['FRONTERA_XRPL_TESTNET_SMOKE'] === '1';
const ENDPOINT = process.env['FRONTERA_XRPL_TESTNET_ENDPOINT'] ?? 'wss://s.altnet.rippletest.net:51233';
const ASSET = 'stable:RLUSD/testnet-stand-in';
const PAYMENT_ACTION = ALLOWED_INTENT.action;
const GOVERNED_ACCOUNT = ALLOWED_INTENT.resource;

async function settle(client: Client, wallet: Wallet, transaction: Record<string, unknown>): Promise<void> {
  const result = await client.submitAndWait(transaction as never, { wallet, autofill: true });
  const meta = result.result.meta as { readonly TransactionResult?: string } | undefined;
  assert.equal(meta?.TransactionResult, 'tesSUCCESS', `setup ${String(transaction['TransactionType'])}`);
}

describe('PAY-02 live Testnet smoke (opt-in)', { skip: ENABLED ? false : 'set FRONTERA_XRPL_TESTNET_SMOKE=1 to run against XRPL Testnet' }, () => {
  it('a governed RLUSD-coded payment completes on XRPL Testnet, validated, with the hash recorded in P11 and the trace', { timeout: 300_000 }, async () => {
    const setup = new Client(ENDPOINT, { timeout: 20_000 });
    await setup.connect();
    try {
      const info = await setup.request({ command: 'server_info' });
      assert.equal((info.result.info as { readonly network_id?: number }).network_id, 1, 'refusing to run anywhere but XRPL Testnet');

      const [issuer, treasury, vendor] = await Promise.all([setup.fundWallet(), setup.fundWallet(), setup.fundWallet()]).then((funded) => funded.map((entry) => entry.wallet));
      assert.ok(issuer && treasury && vendor);
      await settle(setup, issuer, { TransactionType: 'AccountSet', Account: issuer.classicAddress, SetFlag: 8 }); // asfDefaultRipple: holders can pay each other
      for (const holder of [treasury, vendor]) {
        await settle(setup, holder, { TransactionType: 'TrustSet', Account: holder.classicAddress, LimitAmount: { currency: RLUSD_CURRENCY_HEX, issuer: issuer.classicAddress, value: '1000' } });
      }
      await settle(setup, issuer, { TransactionType: 'Payment', Account: issuer.classicAddress, Destination: treasury.classicAddress, Amount: { currency: RLUSD_CURRENCY_HEX, issuer: issuer.classicAddress, value: '100' } });

      const configuration = createXrplRlusdRailConfiguration({
        network: 'testnet',
        endpoint: ENDPOINT,
        asset: { paymentAsset: ASSET, currency: RLUSD_CURRENCY_HEX, issuer: issuer.classicAddress },
        sourceAccounts: [{ accountId: GOVERNED_ACCOUNT, address: treasury.classicAddress }],
      });
      const sdkClient = createXrplSdkClient(configuration);
      const signer = createTestSoftwareXrplSigner(treasury);
      const rail = createXrplRlusdRail({ configuration, client: sdkClient, signers: [signer] });
      assert.deepEqual(await rail.readiness(), { status: 'ready' });

      const assets = createMonetaryAssetRegistry([{ assetId: ASSET, scale: 15 }]);
      const binding = createPaymentGovernanceBinding({ action: PAYMENT_ACTION });
      const world = buildGovernedWorld({
        monetary: { assets, actionClassifier: createFinancialActionClassifier({ financialActions: [PAYMENT_ACTION] }) },
        governance: createGovernanceProfileRegistry({
          parameterDimensions: PAYMENT_PARAMETER_DIMENSIONS,
          actionClasses: [{ id: 'payment', actions: [PAYMENT_ACTION] }],
          resourceClasses: [{ id: 'governed-account', resources: [GOVERNED_ACCOUNT] }],
          profiles: [{ profileId: 'governed-payment', version: 1, owner: ORG, provenance: { authoredBy: 'operator:treasury', approvedBy: 'operator:security' }, actionClass: 'payment', resourceClass: 'governed-account', parameters: PAYMENT_PROFILE_PARAMETERS, materialFacts: [], relevantPolicies: [] }],
        }),
        financialAuthority: monetaryAuthority('50', '100', ASSET),
        executionAdapter: createPaymentRailExecutionAdapter({ rail, binding }),
      });

      const validation = validatePaymentIntent(
        { source: { accountId: GOVERNED_ACCOUNT }, destination: { kind: 'xrpl-account', reference: vendor.classicAddress }, amount: { value: '12.5', unit: ASSET }, purpose: 'vendor-payment', rail: 'xrpl-rlusd', idempotencyKey: `pay02-smoke-${Date.now()}` },
        { assets },
      );
      assert.equal(validation.valid, true);
      const intent = (validation as { readonly intent: PaymentIntent }).intent;
      const result = await world.orchestrator.govern(IDENTITY, compilePaymentIntent(intent, binding, { assertedContext: ALLOWED_INTENT.assertedContext }));
      assert.equal(result.status, 'executed', JSON.stringify(result));
      const hash = result.status === 'executed' ? result.providerRef : undefined;
      assert.match(hash ?? '', /^[0-9A-F]{64}$/);

      const ledger = await setup.request({ command: 'tx', transaction: hash as string });
      assert.equal(ledger.result.validated, true);
      assert.equal((ledger.result.meta as { readonly TransactionResult?: string }).TransactionResult, 'tesSUCCESS');
      const lines = await setup.request({ command: 'account_lines', account: vendor.classicAddress, peer: issuer.classicAddress });
      assert.equal(lines.result.lines[0]?.balance, '12.5', 'the vendor received exactly the granted amount');

      const record = await world.outcomes.read({ organizationId: ORG }, result.executionId!);
      assert.equal(record?.terminal?.observation.kind === 'provider' && record.terminal.observation.certainty, 'confirmed-completed');
      const trace = await buildAuthorityTrace({ governance: world.rawStore, grants: { kind: 'in-memory', read: (grantId) => world.grantStore.read(grantId) }, outcomes: world.outcomes }, { system: true }, result.requestId!);
      assert.equal(trace?.trace.stages.outcome.providerRef, hash);
      assert.equal(JSON.stringify({ result, record, trace }).includes(signer.canarySecret), false);

      console.log(`PAY-02 TESTNET SMOKE executionId=${result.executionId} txHash=${hash} validated=true result=tesSUCCESS ledger=${String(ledger.result.ledger_index)} p11=confirmed-completed trace.outcome.providerRef=${String(trace?.trace.stages.outcome.providerRef)}`);
      await rail.close();
    } finally {
      await setup.disconnect();
    }
  });
});
