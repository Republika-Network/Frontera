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

import { RLUSD_CURRENCY_CODE, RLUSD_XRPL_MAINNET_ISSUER, RLUSD_XRPL_TESTNET_ISSUER, andrewSettlementProfile, composeAndrewDemo, type AndrewDemo } from '../andrew-demo/index.js';
import { checkXrplSettlement } from '../execution-adapters/xrpl/index.js';
import { GOVERNED_ACTION_REASON_CODES as R } from '../governed-action/contracts.js';
import { AGENT_SUBJECT, LEGACY_KEY, TRUST_DOMAIN, Workspace, call, govern, secureEnv, type Reply } from './core04-host-fixture.js';
import { withDeploymentWitness } from './core07-freshness-fixture.js';

/**
 * ANDREW-P0-09 — the LIVE linked-reconsideration scenario on XRPL Testnet.
 *
 * Skipped unless `FRONTERA_ANDREW_P009_LIVE=1` (its own flag, so enabling the
 * P0-08 live run can never also run this one and pay twice). It needs the same
 * environment as P0-08 — `FRONTERA_XRPL_TESTNET_ENDPOINT`,
 * `FRONTERA_XRPL_TESTNET_TREASURY_SEED`, the two addresses,
 * `FRONTERA_ANDREW_ATTEMPT_STORE` (must be fresh), `FRONTERA_ANDREW_EVIDENCE_FILE`
 * — and the optional `FRONTERA_ANDREW_LIVE_AMOUNT_USD` (default `10`).
 *
 * original (denied) → exact replay (same denial) → destination approval (no
 * payment) → linked reconsideration (fresh evaluation, one grant, one signature,
 * one submission, validated) → a second reconsideration (withheld: already
 * realized) — one correlated evidence chain.
 */

const LIVE = process.env['FRONTERA_ANDREW_P009_LIVE'] === '1';
const ADMIN_SECRET = `FRONTERA_ANDREW_P009_LIVE_ADMIN_${'0'.repeat(8)}${Date.now().toString(36)}`;
const PRINCIPAL = 'principal-andrew-agent';
const CANONICAL_DECIMAL = /^(?:0|[1-9]\d*)(?:\.\d*[1-9])?$/;

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new Error(`${name} is not set.`);
  return value;
}

/** The P0-08 live demo amount rules: positive canonical decimal, at most two decimals, below the USD 100,000 ceiling. */
function liveAmountUsd(): string {
  const value = process.env['FRONTERA_ANDREW_LIVE_AMOUNT_USD'] ?? '10';
  if (!CANONICAL_DECIMAL.test(value) || value === '0') throw new Error('FRONTERA_ANDREW_LIVE_AMOUNT_USD must be a positive canonical decimal.');
  const [integer = '', fraction = ''] = value.split('.');
  if (fraction.length > 2) throw new Error('FRONTERA_ANDREW_LIVE_AMOUNT_USD must have at most two decimals (USD scale).');
  if (BigInt(integer) >= 100_000n) throw new Error('FRONTERA_ANDREW_LIVE_AMOUNT_USD must stay below the USD 100,000 authority ceiling.');
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

describe('ANDREW-P0-09 LIVE — linked reconsideration of a denied payment intent, on XRPL Testnet', { skip: !LIVE && 'set FRONTERA_ANDREW_P009_LIVE=1 (and the P0-08 variables) to run the live reconsideration scenario' }, () => {
  it('original denied → replay stable → approval → linked reconsideration → one real RLUSD payment, validated → evidence chain', { timeout: 600_000 }, async () => {
    const endpoint = required('FRONTERA_XRPL_TESTNET_ENDPOINT');
    assert.equal(isMainnetEndpoint(endpoint), false, 'Mainnet endpoint refused');
    const treasuryAddress = required('FRONTERA_XRPL_TESTNET_TREASURY_ADDRESS');
    const recipientAddress = required('FRONTERA_XRPL_TESTNET_RECIPIENT_ADDRESS');
    const evidenceFile = required('FRONTERA_ANDREW_EVIDENCE_FILE');
    const attemptStorePath = required('FRONTERA_ANDREW_ATTEMPT_STORE');
    const amount = liveAmountUsd();
    const evidence: Record<string, unknown> = { task: 'ANDREW-P0-09', network: 'XRPL Testnet', endpoint, treasury: treasuryAddress, recipient: recipientAddress, liveAmount: { authorityUnit: `USD ${amount}`, railRepresentation: `RLUSD ${amount} on XRPL Testnet` }, startedAt: new Date().toISOString() };
    const save = () => writeFileSync(evidenceFile, JSON.stringify(evidence, null, 2));

    // Read-only preflight first.
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

    attempts = createSqliteXrplAttemptStore(attemptStorePath);
    {
      const db = new Database(attemptStorePath, { readonly: true });
      try {
        assert.equal((db.prepare('SELECT COUNT(*) AS n FROM xrpl_submission_attempts').get() as { readonly n: number }).n, 0, 'a live run needs a fresh attempt store, so it can never pay twice');
      } finally {
        db.close();
      }
    }
    const dir = workspace.dir();
    const base = createEnvXrplSigner({ environment: process.env, seedVariable: 'FRONTERA_XRPL_TESTNET_TREASURY_SEED', expectedAccount: treasuryAddress });
    const counts = { signatures: 0, submissions: 0 };
    const signer: XrplTransactionSigner = { account: base.account, sign: async (prepared) => ((counts.signatures += 1), base.sign(prepared)) };
    const profile = andrewSettlementProfile();
    const transport = createXrplTestnetTransport({
      configuration: { endpoint, sourceAccount: treasuryAddress, forbiddenSourceAccounts: [RLUSD_XRPL_TESTNET_ISSUER, RLUSD_XRPL_MAINNET_ISSUER] },
      settlementGate: (submission) => checkXrplSettlement(profile, submission),
      signer,
      attempts,
      connect: async (url) => {
        const client = await connectXrplLedgerClient(url);
        return { ...client, submit: async (blob: string) => ((counts.submissions += 1), client.submit(blob)) };
      },
    });
    const environment = await withDeploymentWitness({ ...secureEnv(dir), FRONTERA_ANDREW_ADMIN_KEY: ADMIN_SECRET });
    demo = await composeAndrewDemo({
      directory: dir,
      environment,
      identity: { trustDomainId: TRUST_DOMAIN, agent: { principalId: PRINCIPAL, externalSubject: AGENT_SUBJECT, apiKeyEnv: 'FRONTERA_TEST_AGENT_KEY' }, operators: [{ operatorId: 'andrew-admin', role: 'organization-administrator', apiKeyEnv: 'FRONTERA_ANDREW_ADMIN_KEY' }] },
      transport,
    });
    const live = demo;
    const grants = (): number => {
      const db = new Database(join(dir, 'bounded-grants.sqlite'), { readonly: true });
      try {
        return (db.prepare('SELECT COUNT(*) AS n FROM bounded_grants').get() as { readonly n: number }).n;
      } finally {
        db.close();
      }
    };
    const tally = () => ({ grants: grants(), signatures: counts.signatures, submissions: counts.submissions });
    const decision = (reply: Reply) => reply.body['decision'] as { readonly decisionId: string; readonly evaluationId: string; readonly status: string; readonly reasonCodes: readonly string[] };
    const intent = live.transferIntent(recipientAddress, amount);

    // 1–5. The original intent: denied while the destination is not approved.
    const destination = live.registerDestination(recipientAddress, 'operator:andrew-registrar');
    assert.equal(live.destinationGovernance.readDestinationApproval(`Bearer ${ADMIN_SECRET}`, { destination }).state, 'never-approved');
    const original = await govern(live.baseUrl, intent, 'andrew-p009-live-original');
    evidence['original'] = { idempotencyKey: 'andrew-p009-live-original', requestId: original.body['requestId'], status: original.body['status'], decision: decision(original), recipientTrustLine: preflight.recipient.trustLine, ...tally() };
    save();
    assert.equal(original.body['status'], 'denied', original.text);
    assert.deepEqual(tally(), { grants: 0, signatures: 0, submissions: 0 });

    // 6. Exact replay of the original technical request: the stored denial.
    const replay = await govern(live.baseUrl, intent, 'andrew-p009-live-original');
    evidence['replay'] = { requestId: replay.body['requestId'], status: replay.body['status'], decision: decision(replay), ...tally() };
    save();
    assert.equal(replay.body['status'], 'denied');
    assert.deepEqual(decision(replay), decision(original), 'the original committed decision, not a new evaluation');
    assert.deepEqual(tally(), { grants: 0, signatures: 0, submissions: 0 });

    // 7. Destination approval — explicit, attributed, and no payment by itself.
    const approval = live.destinationGovernance.approveDestination(`Bearer ${ADMIN_SECRET}`, { destination, idempotencyKey: 'andrew-p009-live-approve' });
    assert.equal(approval.outcome, 'approved');
    evidence['approval'] = approval.outcome === 'approved' ? { approvedBy: approval.approval.approvedBy, authorityBasis: approval.approval.authorityBasis, approvedAt: approval.approval.approvedAt, sequence: approval.approval.sequence, organizationId: approval.approval.organizationId, ...tally() } : approval;
    save();
    assert.deepEqual(tally(), { grants: 0, signatures: 0, submissions: 0 });

    // 8–13. Explicit linked reconsideration: fresh evaluation, one grant, one real payment.
    const reconsidered = await govern(live.baseUrl, { ...intent, reconsideration: { of: String(original.body['requestId']), reason: 'destination-approved' } }, 'andrew-p009-live-reconsideration');
    const executionId = String(reconsidered.body['executionId']);
    const record = attempts.find(executionId);
    evidence['reconsideration'] = { idempotencyKey: 'andrew-p009-live-reconsideration', requestId: reconsidered.body['requestId'], businessIntentId: reconsidered.body['correlationId'], status: reconsidered.body['status'], decision: decision(reconsidered), executionId, providerRef: reconsidered.body['providerRef'], ...tally() };
    evidence['attempt'] = record;
    save();
    assert.equal(reconsidered.body['status'], 'executed', reconsidered.text);
    assert.notEqual(reconsidered.body['requestId'], original.body['requestId']);
    assert.notEqual(decision(reconsidered).decisionId, decision(original).decisionId);
    assert.deepEqual(tally(), { grants: 1, signatures: 1, submissions: 1 });
    assert.ok(record !== undefined);
    assert.equal(record.state, 'validated-success');
    assert.equal(reconsidered.body['providerRef'], record.attempt.transactionHash);
    const final = record.events.at(-1)?.evidence ?? {};
    assert.equal(final['engineResult'], 'tesSUCCESS');
    assert.equal(issuedValuesEqual(final['deliveredValue'], amount), true);

    const reread = await connectXrplLedgerClient(endpoint);
    try {
      const lookup = await reread.transaction(record.attempt.transactionHash);
      assert.ok(lookup.found);
      const delivered = lookup.meta?.['delivered_amount'] as { readonly currency?: string; readonly issuer?: string; readonly value?: string } | undefined;
      assert.equal(lookup.validated, true);
      assert.equal(lookup.meta?.['TransactionResult'], 'tesSUCCESS');
      assert.equal(delivered?.currency, RLUSD_CURRENCY_CODE);
      assert.equal(delivered?.issuer, RLUSD_XRPL_TESTNET_ISSUER);
      assert.equal(issuedValuesEqual(delivered?.value, amount), true);
      evidence['ledger'] = { validated: lookup.validated, hash: lookup.hash, ledgerIndex: lookup.ledgerIndex, closeTimeIso: lookup.closeTimeIso, engineResult: lookup.meta?.['TransactionResult'], deliveredAmount: delivered, account: lookup.transaction['Account'], destination: lookup.transaction['Destination'] };
    } finally {
      await reread.disconnect();
    }

    // 14. The evidence graph: the reconsideration's trace verifies its lineage to the original.
    const trace = await call(live.baseUrl, 'GET', `/api/evidence/traces/${encodeURIComponent(String(reconsidered.body['requestId']))}?level=AUDITOR`, { authorization: `Bearer ${LEGACY_KEY}` });
    const verification = await call(live.baseUrl, 'GET', `/api/evidence/traces/${encodeURIComponent(String(reconsidered.body['requestId']))}/verify`, { authorization: `Bearer ${LEGACY_KEY}` });
    const originalTrace = await call(live.baseUrl, 'GET', `/api/evidence/traces/${encodeURIComponent(String(original.body['requestId']))}?level=AUDITOR`, { authorization: `Bearer ${LEGACY_KEY}` });
    const lineage = ((trace.body['trace'] as { readonly stages?: Record<string, Record<string, unknown>> } | undefined)?.stages?.['request']?.['lineage'] ?? null) as Record<string, unknown> | null;
    evidence['trace'] = { status: trace.status, carriesHash: trace.text.includes(record.attempt.transactionHash), lineage, verified: verification.body['verified'], lineageChecks: (verification.body['checks'] as readonly { readonly check: string; readonly status: string }[] | undefined)?.filter((entry) => entry.check.startsWith('lineage.')), body: trace.body };
    evidence['originalTrace'] = { status: originalTrace.status, finalState: (originalTrace.body['trace'] as { readonly summary?: unknown } | undefined)?.summary, hasLineage: originalTrace.text.includes('lineage') };
    save();
    assert.equal(trace.status, 200);
    assert.equal(verification.body['verified'], true, verification.text);
    assert.ok(lineage !== null);
    assert.equal((lineage['reconsiders'] as Record<string, unknown>)['requestId'], original.body['requestId']);
    assert.equal((lineage['reconsiders'] as Record<string, unknown>)['status'], 'denied');
    assert.equal(lineage['realizedOriginal'], true);
    assert.equal(originalTrace.text.includes('lineage'), false);

    // One intent, one realization: a second reconsideration is withheld before any grant.
    const again = await govern(live.baseUrl, { ...intent, reconsideration: { of: String(original.body['requestId']), reason: 'destination-approved' } }, 'andrew-p009-live-reconsideration-2');
    evidence['secondReconsideration'] = { requestId: again.body['requestId'], status: again.body['status'], withheldBy: again.body['withheldBy'], reasonCodes: again.body['reasonCodes'], ...tally() };
    // The original, replayed once more at the end: still the same denial.
    const finalReplay = await govern(live.baseUrl, intent, 'andrew-p009-live-original');
    evidence['finalReplay'] = { status: finalReplay.body['status'], decision: decision(finalReplay) };
    evidence['finishedAt'] = new Date().toISOString();
    save();
    assert.equal(again.body['status'], 'withheld', again.text);
    assert.ok((again.body['reasonCodes'] as readonly string[]).includes(R.GOVERNED_ACTION_RECONSIDERATION_ALREADY_REALIZED));
    assert.deepEqual(decision(finalReplay), decision(original));
    assert.deepEqual(tally(), { grants: 1, signatures: 1, submissions: 1 });
  });
});
