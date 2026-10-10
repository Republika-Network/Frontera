import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { Client, type Wallet } from 'xrpl';

import { createMonetaryAssetRegistry } from '../../features/monetary-runtime/index.js';
import { PAYMENT_PARAMETER_DIMENSIONS, PAYMENT_PROFILE_PARAMETERS, compilePaymentIntent, createPaymentGovernanceBinding, validatePaymentIntent, type PaymentIntent } from '../../features/payment-runtime/index.js';
import { RLUSD_CURRENCY_HEX } from '../../features/payment-runtime/rails/xrpl/tests/xrpl-test-fixtures.js';
import { REFERENCE_XRPL_SIGNER_KEY_FILE_FORMAT } from '../xrpl-payment-rail/reference/reference-xrpl-signer-service.js';
import { authorityAuthenticityEnv } from './authority-authenticity-fixture.js';
import { ACCOUNT, AGENT, AUTH, ISSUER, ORG, OWNER, SECRETS, TRUST_DOMAIN, bootstrapOrganization, call, create, expectStatus } from './ctrl02-host-fixture.js';

/**
 * PAY-03 live, production-shaped qualification — **XRPL Testnet only, opt-in.**
 *
 * Skipped unless `FRONTERA_XRPL_TESTNET_PAY03=1`. Never mainnet: it refuses to
 * run unless the server reports `network_id` 1, and the Host's rail refuses any
 * other network.
 *
 * Unlike PAY-02's smoke run (test-only in-process signer), three processes:
 *
 * ```
 * this test (operator + ledger setup only)
 *   ├─ the reference XRPL signer   scripts/run-reference-xrpl-signer.mjs — holds the Testnet key, its own env
 *   └─ the Enterprise Host         scripts/run-enterprise-host.mjs — xrplPaymentRail configured, NO key
 *          └─ governed payment over HTTP → grant → claim → PAY-01 bridge → rail
 *               → HTTP to the signer → verify → durable reservation → XRPL Testnet, once
 * ```
 *
 * Setup is the SDK, as an operator would do it, and is not the rail: three
 * faucet-funded ephemeral accounts, a stand-in issuer of the RLUSD currency
 * code, trust lines, a small issuance. The Host's environment is read back from
 * `/proc` to prove it never held the key. No secret is printed.
 */
const ENABLED = process.env['FRONTERA_XRPL_TESTNET_PAY03'] === '1';
const ENDPOINT = process.env['FRONTERA_XRPL_TESTNET_ENDPOINT'] ?? 'wss://s.altnet.rippletest.net:51233';
const ASSET = 'stable:RLUSD/testnet-stand-in';
const PAYMENT = 'transfer-funds';
const SIGNER_TOKEN = `FRONTERA_PAY03_LIVE_SIGNER_${Date.now()}_7c41e0a9d2b8f6`;

async function settle(client: Client, wallet: Wallet, transaction: Record<string, unknown>): Promise<void> {
  const result = await client.submitAndWait(transaction as never, { wallet, autofill: true });
  assert.equal((result.result.meta as { readonly TransactionResult?: string } | undefined)?.TransactionResult, 'tesSUCCESS', `setup ${String(transaction['TransactionType'])}`);
}

function started(child: ChildProcess, marker: RegExp, what: string): Promise<RegExpExecArray> {
  return new Promise((resolveStart, reject) => {
    let out = '';
    const timer = setTimeout(() => reject(new Error(`${what} did not start: ${out.slice(-2000)}`)), 60_000);
    const onData = (chunk: Buffer): void => {
      out += chunk.toString('utf8');
      const match = marker.exec(out);
      if (match !== null) {
        clearTimeout(timer);
        resolveStart(match);
      }
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.on('exit', (code) => reject(new Error(`${what} exited ${String(code)}: ${out.slice(-2000)}`)));
  });
}

describe('PAY-03 live Testnet production-shaped qualification (opt-in)', { skip: ENABLED ? false : 'set FRONTERA_XRPL_TESTNET_PAY03=1 to run against XRPL Testnet' }, () => {
  it('Host process → external reference signer process → XRPL Testnet: a governed payment validates tesSUCCESS, P11 and the trace carry the hash, and the Host never held the key', { timeout: 600_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'frontera-pay03-live-'));
    const children: ChildProcess[] = [];
    const setup = new Client(ENDPOINT, { timeout: 20_000 });
    await setup.connect();
    try {
      const info = await setup.request({ command: 'server_info' });
      assert.equal((info.result.info as { readonly network_id?: number }).network_id, 1, 'PAY-03 BLOCKED — production XRPL configuration detected during qualification: refusing anything but XRPL Testnet');

      const [issuer, treasury, vendor] = await Promise.all([setup.fundWallet(), setup.fundWallet(), setup.fundWallet()]).then((funded) => funded.map((entry) => entry.wallet));
      assert.ok(issuer && treasury && vendor);
      await settle(setup, issuer, { TransactionType: 'AccountSet', Account: issuer.classicAddress, SetFlag: 8 });
      for (const holder of [treasury, vendor]) {
        await settle(setup, holder, { TransactionType: 'TrustSet', Account: holder.classicAddress, LimitAmount: { currency: RLUSD_CURRENCY_HEX, issuer: issuer.classicAddress, value: '1000' } });
      }
      await settle(setup, issuer, { TransactionType: 'Payment', Account: issuer.classicAddress, Destination: treasury.classicAddress, Amount: { currency: RLUSD_CURRENCY_HEX, issuer: issuer.classicAddress, value: '100' } });

      // ── the custody process: the Testnet key lives here, in its own file, and nowhere in the Host ──
      const keyFile = join(dir, 'signer', 'xrpl-key.json');
      (await import('node:fs')).mkdirSync(join(dir, 'signer'), { mode: 0o700 });
      writeFileSync(keyFile, JSON.stringify({ format: REFERENCE_XRPL_SIGNER_KEY_FILE_FORMAT, seed: treasury.seed }), { mode: 0o600, flag: 'wx' });
      const signer = spawn(process.execPath, [resolve('scripts/run-reference-xrpl-signer.mjs')], {
        env: { PATH: process.env['PATH'], FRONTERA_REFERENCE_XRPL_SIGNER_KEY_FILE: keyFile, FRONTERA_REFERENCE_XRPL_SIGNER_ID: 'pay03-live-signer', FRONTERA_REFERENCE_XRPL_SIGNER_TOKEN: SIGNER_TOKEN, FRONTERA_REFERENCE_XRPL_SIGNER_PORT: '0' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      children.push(signer);
      const signerPort = (await started(signer, /listening on http:\/\/127\.0\.0\.1:(\d+)/, 'the reference signer'))[1];

      // ── the Host process: xrplPaymentRail configured, a clean environment, no key ──
      const governed = join(dir, 'governed-actions.json');
      writeFileSync(
        governed,
        JSON.stringify({
          version: 1,
          trustDomainId: TRUST_DOMAIN,
          grantLifetimeSeconds: 300,
          customerPrincipals: [],
          operators: [
            { operatorId: 'ops-admin', role: 'organization-administrator', apiKeyEnv: 'FRONTERA_CTRL02_ADMIN' },
            { operatorId: 'ops-provisioner', role: 'provisioner', apiKeyEnv: 'FRONTERA_CTRL02_PROVISIONER' },
            { operatorId: 'ops-observer', role: 'observer', apiKeyEnv: 'FRONTERA_CTRL02_OBSERVER' },
          ],
          monetary: { assets: [{ assetId: ASSET, scale: 15 }], financialActions: [PAYMENT] },
          governance: {
            parameterDimensions: PAYMENT_PARAMETER_DIMENSIONS,
            actionClasses: [{ id: 'payment', actions: [PAYMENT] }],
            resourceClasses: [{ id: 'governed-account', resources: [ACCOUNT] }],
            profiles: [{ profileId: 'governed-payment', version: 1, owner: ORG, provenance: { authoredBy: 'operator:treasury', approvedBy: 'operator:security' }, actionClass: 'payment', resourceClass: 'governed-account', parameters: PAYMENT_PROFILE_PARAMETERS, materialFacts: [], relevantPolicies: [] }],
          },
          routes: [{ action: PAYMENT, adapterId: 'xrpl-rlusd' }],
          xrplPaymentRail: {
            paymentAction: PAYMENT,
            network: 'testnet',
            endpoint: ENDPOINT,
            asset: { paymentAsset: ASSET, currency: RLUSD_CURRENCY_HEX, issuer: issuer.classicAddress },
            sourceAccounts: [{ accountId: ACCOUNT, address: treasury.classicAddress, signingPublicKey: treasury.publicKey }],
            lastLedgerOffset: 4,
            requestTimeoutMs: 20_000,
            signer: { endpoint: `http://127.0.0.1:${signerPort}`, signerId: 'pay03-live-signer', credential: { kind: 'bearer', tokenEnv: 'FRONTERA_PAY03_XRPL_SIGNER_TOKEN' } },
          },
        }),
      );
      const stores = Object.fromEntries(
        [
          ['AOC_ENTERPRISE_SQLITE_PATH', 'enterprise-host'],
          ['AOC_ENTERPRISE_PASSPORT_SQLITE_PATH', 'agent-passport'],
          ['AOC_ENTERPRISE_ASSURANCE_SQLITE_PATH', 'assurance'],
          ['AOC_ENTERPRISE_KERNEL_AUTHORITY_SQLITE_PATH', 'kernel-authority'],
          ['AOC_ENTERPRISE_BOUNDED_GRANT_SQLITE_PATH', 'bounded-grants'],
          ['AOC_ENTERPRISE_EMERGENCY_CONTROL_SQLITE_PATH', 'emergency-controls'],
          ['AOC_ENTERPRISE_EXERCISE_LEDGER_SQLITE_PATH', 'exercise-ledger'],
          ['AOC_ENTERPRISE_AUTHORITY_EVENT_STREAM_SQLITE_PATH', 'authority-event-stream'],
          ['AOC_ENTERPRISE_EXECUTION_OUTCOME_SQLITE_PATH', 'execution-outcomes'],
          ['AOC_ENTERPRISE_EXECUTION_RESOLUTION_SQLITE_PATH', 'execution-resolutions'],
          ['AOC_ENTERPRISE_OBLIGATION_DISCHARGE_SQLITE_PATH', 'obligation-discharges'],
          ['AOC_ENTERPRISE_APPROVAL_SQLITE_PATH', 'approvals'],
          ['AOC_ENTERPRISE_CONTROL_PLANE_SQLITE_PATH', 'control-plane'],
          ['AOC_ENTERPRISE_EVIDENCE_SQLITE_PATH', 'evidence-bundles'],
          ['AOC_ENTERPRISE_XRPL_INTERLOCK_SQLITE_PATH', 'xrpl-submission-interlock'],
        ].map(([name, file]) => [name, join(dir, 'state', `${file}.sqlite`)]),
      );
      const hostEnv = {
        PATH: process.env['PATH'],
        AOC_ENTERPRISE_ENV: 'development',
        AOC_ENTERPRISE_PERSISTENCE_PROVIDER: 'sqlite',
        AOC_ENTERPRISE_REQUIRE_AUTH: 'true',
        AOC_ENTERPRISE_API_KEYS: `${SECRETS.legacyKey}:${ORG}`,
        AOC_ENTERPRISE_HTTP_HOST: '127.0.0.1',
        AOC_ENTERPRISE_HTTP_PORT: '0',
        AOC_ENTERPRISE_LOG_LEVEL: 'warn',
        AOC_ENTERPRISE_KERNEL_AUTHORITY_ENABLED: 'true',
        AOC_ENTERPRISE_KERNEL_AUTHORITY_ORGANIZATION_ID: ORG,
        AOC_ENTERPRISE_GOVERNED_ACTIONS_FILE: governed,
        ...stores,
        ...authorityAuthenticityEnv(),
        FRONTERA_CTRL02_ADMIN: SECRETS.administrator,
        FRONTERA_CTRL02_PROVISIONER: SECRETS.provisioner,
        FRONTERA_CTRL02_OBSERVER: SECRETS.observer,
        FRONTERA_PAY03_XRPL_SIGNER_TOKEN: SIGNER_TOKEN,
      };
      const host = spawn(process.execPath, [resolve('scripts/run-enterprise-host.mjs')], { env: hostEnv, stdio: ['ignore', 'pipe', 'pipe'] });
      children.push(host);
      const baseUrl = (await started(host, /listening on (http:\/\/127\.0\.0\.1:\d+)/, 'the Enterprise Host'))[1]!;

      // The Host process never held the key: read its real environment back.
      const environ = readFileSync(`/proc/${String(host.pid)}/environ`, 'utf8');
      for (const secret of [treasury.seed!, treasury.privateKey]) assert.equal(environ.includes(secret), false, 'the Host process environment holds no XRPL key');
      assert.equal(/FRONTERA_REFERENCE_XRPL_SIGNER_/.test(environ), false);

      await bootstrapOrganization(baseUrl);
      const agentId = `${AGENT}-live`;
      const ownerId = `${OWNER}-live`;
      await create(baseUrl, AUTH.provisioner, 'actor', { actorId: ownerId, type: 'human', displayName: 'Treasurer', issuerId: ISSUER, trustDomainId: TRUST_DOMAIN });
      await create(baseUrl, AUTH.provisioner, 'actor', { actorId: agentId, type: 'agent', displayName: 'Payables Agent', issuerId: ISSUER, trustDomainId: TRUST_DOMAIN, externalSubject: { system: 'pay03-live', subjectId: agentId } });
      const credential = expectStatus(await call(baseUrl, 'POST', `/api/admin/agents/${agentId}/credentials`, { authorization: AUTH.provisioner, body: { idempotencyKey: `issue-${agentId}` } }), 200, 'credential').body['bearerCredential'] as string;
      await create(baseUrl, AUTH.provisioner, 'authority-grant', { authorityGrantId: 'authority-live', issuerActorId: ISSUER, subjectActorId: ownerId, trustDomainId: TRUST_DOMAIN, capability: 'payables.manage', actions: [PAYMENT], resourceScopes: [ACCOUNT], canDelegate: true, allowedDelegateActorTypes: ['agent'], maxDelegationDepth: 1, constraints: [{ type: 'max_amount', currency: ASSET, value: '50' }, { type: 'spending_limit', limitId: 'live', currency: ASSET, maximum: '100', window: { kind: 'lifetime' } }] });
      await create(baseUrl, AUTH.provisioner, 'passport', { passportId: 'passport-live', type: 'agent_passport', subjectActorId: agentId, issuerActorId: ISSUER, trustDomainId: TRUST_DOMAIN });
      await create(baseUrl, AUTH.provisioner, 'capability-token', { capabilityTokenId: 'capability-live', subjectActorId: agentId, principalActorId: ownerId, issuerActorId: ownerId, trustDomainId: TRUST_DOMAIN, capability: 'payables.execute', actions: [PAYMENT], resourceScopes: [ACCOUNT], riskLevel: 'medium' });
      await create(baseUrl, AUTH.provisioner, 'delegation-grant', { delegationGrantId: 'delegation-live', delegatorActorId: ownerId, delegateActorId: agentId, delegateActorType: 'agent', trustDomainId: TRUST_DOMAIN, sourceAuthorityGrantId: 'authority-live', capability: 'payables.execute', actions: [PAYMENT], resourceScopes: [ACCOUNT], canRedelegate: false });

      // The restart quarantine: wait for the ledger to pass it (offset 4 + margin 4) before paying.
      const startIndex = (await setup.request({ command: 'ledger', ledger_index: 'validated' })).result.ledger_index;
      for (;;) {
        const now = (await setup.request({ command: 'ledger', ledger_index: 'validated' })).result.ledger_index;
        if (now >= startIndex + 10) break;
        await new Promise((resolveWait) => setTimeout(resolveWait, 2_000));
      }

      const assets = createMonetaryAssetRegistry([{ assetId: ASSET, scale: 15 }]);
      const validation = validatePaymentIntent({ source: { accountId: ACCOUNT }, destination: { kind: 'xrpl-account', reference: vendor.classicAddress }, amount: { value: '12.5', unit: ASSET }, purpose: 'vendor-payment', reference: 'INV-PAY03-LIVE', rail: 'xrpl-rlusd', idempotencyKey: `pay03-live-${Date.now()}` }, { assets });
      assert.equal(validation.valid, true);
      const body = compilePaymentIntent((validation as { readonly intent: PaymentIntent }).intent, createPaymentGovernanceBinding({ action: PAYMENT }));
      const executed = expectStatus(await call(baseUrl, 'POST', '/api/governed-actions', { authorization: `Bearer ${credential}`, body }), 200, 'governed payment');
      assert.equal(executed.body['status'], 'executed', executed.text);
      const requestId = executed.body['requestId'] as string;

      // The ledger: validated tesSUCCESS, exactly the granted amount delivered.
      const trace = expectStatus(await call(baseUrl, 'GET', `/api/evidence/traces/${encodeURIComponent(requestId)}?level=AUDITOR`, { authorization: AUTH.legacyKey }), 200, 'trace');
      const stages = (trace.body['trace'] as { stages: Record<string, Record<string, unknown>> }).stages;
      const hash = stages['outcome']?.['providerRef'] as string;
      assert.match(hash ?? '', /^[0-9A-F]{64}$/);
      const tx = await setup.request({ command: 'tx', transaction: hash });
      assert.equal(tx.result.validated, true);
      assert.equal((tx.result.meta as { readonly TransactionResult?: string }).TransactionResult, 'tesSUCCESS');
      const lines = await setup.request({ command: 'account_lines', account: vendor.classicAddress, peer: issuer.classicAddress });
      assert.equal(lines.result.lines[0]?.balance, '12.5');
      assert.equal(JSON.stringify(trace.body).includes(treasury.seed!), false);
      assert.equal(JSON.stringify(trace.body).includes(SIGNER_TOKEN), false);

      console.log(
        `PAY-03 TESTNET PRODUCTION-SHAPED executionId=${String(executed.body['executionId'])} txHash=${hash} validated=true result=tesSUCCESS ledger=${String(tx.result.ledger_index)} certainty=${String(stages['outcome']?.['certainty'] ?? stages['outcome']?.['status'])} hostHeldKey=false signer=separate-process`,
      );
    } finally {
      for (const child of children) child.kill('SIGTERM');
      await setup.disconnect();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
