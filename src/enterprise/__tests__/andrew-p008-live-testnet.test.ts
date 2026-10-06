import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import {
  connectXrplLedgerClient,
  connectXrplPreflightReader,
  createEnvXrplSigner,
  createSqliteXrplAttemptStore,
  createXrplTestnetTransport,
  isMainnetEndpoint,
  issuedValuesEqual,
  runXrplPreflight,
  XRPL_TESTNET_NETWORK_ID,
  type XrplSubmissionAttemptStore,
  type XrplTransactionSigner,
} from '@aoc-enterprise/xrpl-testnet-transport';

import {
  RLUSD_CURRENCY_CODE,
  RLUSD_XRPL_MAINNET_ISSUER,
  RLUSD_XRPL_TESTNET_ISSUER,
  andrewSettlementProfile,
  composeAndrewDemo,
  type AndrewDemo,
} from '../andrew-demo/index.js';
import { FINANCIAL_AUTHORITY_REASON_CODES } from '../execution-governance/index.js';
import { checkXrplSettlement } from '../execution-adapters/xrpl/index.js';
import { AGENT_SUBJECT, LEGACY_KEY, TRUST_DOMAIN, Workspace, call, govern, nextKey, secureEnv } from './core04-host-fixture.js';
import { withDeploymentWitness } from './core07-freshness-fixture.js';

/**
 * ANDREW-P0-08 — the LIVE Andrew scenario on XRPL Testnet.
 *
 * Skipped unless `FRONTERA_ANDREW_LIVE_TESTNET=1`. It then needs, from the
 * environment (never the repository):
 *
 * - `FRONTERA_XRPL_TESTNET_ENDPOINT` — the Testnet WebSocket endpoint;
 * - `FRONTERA_XRPL_TESTNET_TREASURY_SEED` — the treasury signer's seed;
 * - `FRONTERA_XRPL_TESTNET_TREASURY_ADDRESS`, `FRONTERA_XRPL_TESTNET_RECIPIENT_ADDRESS`;
 * - `FRONTERA_ANDREW_ATTEMPT_STORE` — the durable transport attempt database;
 * - `FRONTERA_ANDREW_EVIDENCE_FILE` — where the non-secret evidence JSON goes;
 * - `FRONTERA_ANDREW_LIVE_AMOUNT_USD` — optional; the live demo amount, default `10`.
 *
 * The live amount is a **demo parameter**, not a product invariant: governance,
 * authority, grant binding, settlement validation and transport semantics are
 * the same for any amount. It must be a positive canonical decimal strictly
 * below the USD 100,000 ceiling, so the approved-payment scenario stays an
 * approved payment; the separate USD 125,000 ceiling scenario is unchanged.
 *
 * A green read-only preflight (treasury RLUSD ≥ the live amount) is required
 * before any governed request; a red one fails the run with its blockers and
 * moves nothing. It never retries a payment, and it refuses to start on an
 * attempt store that already holds an attempt, so a second accidental run can
 * never pay twice.
 */

const LIVE = process.env['FRONTERA_ANDREW_LIVE_TESTNET'] === '1';
/** Default live demo amount (USD, represented as the same RLUSD value on XRPL Testnet). */
const DEFAULT_LIVE_AMOUNT_USD = '10';
const CANONICAL_DECIMAL = /^(?:0|[1-9]\d*)(?:\.\d*[1-9])?$/;

/** The live demo amount: positive canonical decimal, strictly below the USD 100,000 ceiling, at most two decimals. */
function liveAmountUsd(): string {
  const value = process.env['FRONTERA_ANDREW_LIVE_AMOUNT_USD'] ?? DEFAULT_LIVE_AMOUNT_USD;
  if (!CANONICAL_DECIMAL.test(value) || value === '0') throw new Error('FRONTERA_ANDREW_LIVE_AMOUNT_USD must be a positive canonical decimal.');
  const [integer = '', fraction = ''] = value.split('.');
  if (fraction.length > 2) throw new Error('FRONTERA_ANDREW_LIVE_AMOUNT_USD must have at most two decimals (USD scale).');
  if (BigInt(integer) >= 100_000n) throw new Error('FRONTERA_ANDREW_LIVE_AMOUNT_USD must stay below the USD 100,000 authority ceiling; the ceiling has its own scenario.');
  return value;
}
const ADMIN_SECRET = `FRONTERA_ANDREW_P008_LIVE_ADMIN_${'0'.repeat(8)}${Date.now().toString(36)}`;

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new Error(`${name} is not set.`);
  return value;
}

const workspace = new Workspace();
let demo: AndrewDemo | undefined;
let attempts: XrplSubmissionAttemptStore | undefined;
after(async () => {
  await demo?.close().catch(() => {});
  attempts?.close();
  await workspace.cleanup();
});

describe('ANDREW-P0-08 LIVE — a USD payment (demo amount, default 10) to a wallet that was not previously approved, on XRPL Testnet', { skip: !LIVE && 'set FRONTERA_ANDREW_LIVE_TESTNET=1 (and the documented variables) to run the live Testnet scenario' }, () => {
  it('preflight → denied → approved → fresh request → one real RLUSD Payment, validated → $125K refused', { timeout: 600_000 }, async () => {
    const endpoint = required('FRONTERA_XRPL_TESTNET_ENDPOINT');
    assert.equal(isMainnetEndpoint(endpoint), false, 'Mainnet endpoint refused');
    const treasuryAddress = required('FRONTERA_XRPL_TESTNET_TREASURY_ADDRESS');
    const recipientAddress = required('FRONTERA_XRPL_TESTNET_RECIPIENT_ADDRESS');
    const evidenceFile = required('FRONTERA_ANDREW_EVIDENCE_FILE');
    const amount = liveAmountUsd();
    const attemptStorePath = required('FRONTERA_ANDREW_ATTEMPT_STORE');
    const evidence: Record<string, unknown> = { network: 'XRPL Testnet', endpoint, treasury: treasuryAddress, recipient: recipientAddress, liveAmount: { authorityUnit: `USD ${amount}`, railRepresentation: `RLUSD ${amount} on XRPL Testnet` }, startedAt: new Date().toISOString() };
    const save = () => writeFileSync(evidenceFile, JSON.stringify(evidence, null, 2));

    // Phase 7 — read-only preflight.
    const reader = await connectXrplPreflightReader(endpoint);
    let preflight;
    try {
      preflight = await runXrplPreflight(reader, { expectedNetworkId: XRPL_TESTNET_NETWORK_ID, treasury: treasuryAddress, recipient: recipientAddress, currency: RLUSD_CURRENCY_CODE, issuer: RLUSD_XRPL_TESTNET_ISSUER, requiredValue: amount, minimumXrpDrops: 20_000_000n });
    } finally {
      await reader.disconnect();
    }
    evidence['preflight'] = preflight;
    save();
    assert.ok(preflight.ready, `preflight is not green — no governed request was made: ${preflight.blockers.join('; ')}`);

    // Compose the demo with the real transport.
    const dir = workspace.dir();
    attempts = createSqliteXrplAttemptStore(attemptStorePath);
    {
      const db = new Database(attemptStorePath, { readonly: true });
      try {
        const existing = (db.prepare('SELECT COUNT(*) AS n FROM xrpl_submission_attempts').get() as { readonly n: number }).n;
        assert.equal(existing, 0, 'the attempt store already holds an attempt — a live run needs a fresh store, so it can never pay twice');
      } finally {
        db.close();
      }
    }
    const base = createEnvXrplSigner({ environment: process.env, seedVariable: 'FRONTERA_XRPL_TESTNET_TREASURY_SEED', expectedAccount: treasuryAddress });
    const signerCalls = { count: 0 };
    const signer: XrplTransactionSigner = { account: base.account, sign: async (prepared) => ((signerCalls.count += 1), base.sign(prepared)) };
    const submissions = { count: 0 };
    const profile = andrewSettlementProfile();
    const transport = createXrplTestnetTransport({
      configuration: { endpoint, sourceAccount: treasuryAddress, forbiddenSourceAccounts: [RLUSD_XRPL_TESTNET_ISSUER, RLUSD_XRPL_MAINNET_ISSUER] },
      settlementGate: (submission) => checkXrplSettlement(profile, submission),
      signer,
      attempts,
      connect: async (url) => {
        const client = await connectXrplLedgerClient(url);
        return { ...client, submit: async (blob: string) => ((submissions.count += 1), client.submit(blob)) };
      },
      onEvent: (event) => {
        (evidence['transportEvents'] ??= [] as unknown[]) as unknown[];
        (evidence['transportEvents'] as unknown[]).push(event);
      },
    });
    const environment = await withDeploymentWitness({ ...secureEnv(dir), FRONTERA_ANDREW_ADMIN_KEY: ADMIN_SECRET });
    demo = await composeAndrewDemo({
      directory: dir,
      environment,
      identity: {
        trustDomainId: TRUST_DOMAIN,
        agent: { principalId: 'principal-andrew-agent', externalSubject: AGENT_SUBJECT, apiKeyEnv: 'FRONTERA_TEST_AGENT_KEY' },
        operators: [{ operatorId: 'andrew-admin', role: 'organization-administrator', apiKeyEnv: 'FRONTERA_ANDREW_ADMIN_KEY' }],
      },
      transport,
    });
    const grantCount = (): number => {
      const db = new Database(join(dir, 'bounded-grants.sqlite'), { readonly: true });
      try {
        return (db.prepare('SELECT COUNT(*) AS n FROM bounded_grants').get() as { readonly n: number }).n;
      } finally {
        db.close();
      }
    };

    // Phase 8 — first request: the recipient can receive RLUSD on XRPL, and Frontera still blocks it.
    const destination = demo.registerDestination(recipientAddress, 'operator:andrew-registrar');
    const before = demo.destinationGovernance.readDestinationApproval(`Bearer ${ADMIN_SECRET}`, { destination });
    assert.equal(before.state, 'never-approved');
    assert.equal(preflight.recipient.trustLine, true, 'the recipient holds an RLUSD trust line — a ledger fact, not a Frontera approval');
    const denied = await govern(demo.baseUrl, demo.transferIntent(recipientAddress, amount), nextKey('andrew-live-unapproved'));
    evidence['unapproved'] = { destinationKey: demo.destinationKey(recipientAddress), approvalState: before.state, recipientTrustLine: preflight.recipient.trustLine, status: denied.body['status'], reasonCodes: denied.body['reasonCodes'], requestId: denied.body['requestId'], grants: grantCount(), signerCalls: signerCalls.count, submissions: submissions.count };
    save();
    assert.equal(denied.body['status'], 'denied', denied.text);
    assert.equal(grantCount(), 0);
    assert.equal(signerCalls.count, 0);
    assert.equal(submissions.count, 0);

    // Approval through P0-03 destination governance, as organization-administrator.
    const approval = demo.destinationGovernance.approveDestination(`Bearer ${ADMIN_SECRET}`, { destination, idempotencyKey: 'andrew-live-approve-1' });
    evidence['approval'] = { outcome: approval.outcome, ...(approval.outcome === 'approved' ? { approvedBy: approval.approval.approvedBy, authorityBasis: approval.approval.authorityBasis, approvedAt: approval.approval.approvedAt, sequence: approval.approval.sequence, organizationId: approval.approval.organizationId } : {}) };
    save();
    assert.equal(approval.outcome, 'approved');

    // Second request: fresh key, same action semantics.
    const executed = await govern(demo.baseUrl, demo.transferIntent(recipientAddress, amount), nextKey('andrew-live-approved'));
    const executionId = String(executed.body['executionId']);
    const record = attempts.find(executionId);
    evidence['authorized'] = { status: executed.body['status'], requestId: executed.body['requestId'], executionId, providerRef: executed.body['providerRef'], grants: grantCount(), signerCalls: signerCalls.count, submissions: submissions.count };
    evidence['attempt'] = record;
    save();
    assert.equal(signerCalls.count, 1, 'exactly one signed XRPL transaction');
    assert.equal(submissions.count, 1, 'exactly one submission');
    assert.equal(executed.body['status'], 'executed', executed.text);
    assert.ok(record !== undefined);
    assert.equal(record.state, 'validated-success');
    assert.equal(executed.body['providerRef'], record.attempt.transactionHash);
    assert.deepEqual({ currency: record.attempt.currency, issuer: record.attempt.issuer, value: record.attempt.value }, { currency: RLUSD_CURRENCY_CODE, issuer: RLUSD_XRPL_TESTNET_ISSUER, value: amount });
    const final = record.events.at(-1)?.evidence ?? {};
    assert.equal(final['engineResult'], 'tesSUCCESS');
    assert.equal(issuedValuesEqual(final['deliveredValue'], amount), true, 'delivered exactly the authorized amount');

    // Independent re-read of the validated transaction.
    const reread = await connectXrplLedgerClient(endpoint);
    try {
      const lookup = await reread.transaction(record.attempt.transactionHash);
      if (lookup.found) {
        const delivered = lookup.meta?.['delivered_amount'] as { readonly currency?: string; readonly issuer?: string; readonly value?: string } | undefined;
        assert.equal(lookup.validated, true);
        assert.equal(lookup.meta?.['TransactionResult'], 'tesSUCCESS');
        assert.equal(delivered?.currency, RLUSD_CURRENCY_CODE);
        assert.equal(delivered?.issuer, RLUSD_XRPL_TESTNET_ISSUER);
        assert.equal(issuedValuesEqual(delivered?.value, amount), true, 'the ledger, read independently, delivered exactly the authorized amount');
      }
      evidence['ledger'] = lookup.found ? { validated: lookup.validated, hash: lookup.hash, ledgerIndex: lookup.ledgerIndex, closeTimeIso: lookup.closeTimeIso, engineResult: lookup.meta?.['TransactionResult'], deliveredAmount: lookup.meta?.['delivered_amount'], account: lookup.transaction['Account'], destination: lookup.transaction['Destination'] } : { found: false };
    } finally {
      await reread.disconnect();
    }
    const trace = await call(demo.baseUrl, 'GET', `/api/evidence/traces/${encodeURIComponent(String(executed.body['requestId']))}?level=AUDITOR`, { authorization: `Bearer ${LEGACY_KEY}` });
    evidence['trace'] = { status: trace.status, carriesHash: trace.text.includes(record.attempt.transactionHash), body: trace.body };
    save();

    // Phase 12 — $125K with the real, funded transport installed.
    const ceiling = await govern(demo.baseUrl, demo.transferIntent(recipientAddress, '125000'), nextKey('andrew-live-125k'));
    evidence['ceiling'] = { status: ceiling.body['status'], reasonCodes: ceiling.body['reasonCodes'], grants: grantCount(), signerCalls: signerCalls.count, submissions: submissions.count };
    evidence['finishedAt'] = new Date().toISOString();
    save();
    assert.equal(ceiling.body['status'], 'withheld', ceiling.text);
    assert.ok((ceiling.body['reasonCodes'] as readonly string[]).includes(FINANCIAL_AUTHORITY_REASON_CODES.FINANCIAL_AUTHORITY_CEILING_EXCEEDED));
    assert.equal(signerCalls.count, 1, 'no new signature');
    assert.equal(submissions.count, 1, 'no new submission');
  });
});
