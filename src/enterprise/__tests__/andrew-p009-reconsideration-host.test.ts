import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import {
  createEnvXrplSigner,
  createSqliteXrplAttemptStore,
  createXrplTestnetTransport,
  type XrplLedgerClient,
  type XrplSubmissionAttemptStore,
  type XrplTransactionLookup,
  type XrplTransactionSigner,
} from '@aoc-enterprise/xrpl-testnet-transport';
import { Wallet, decode } from 'xrpl';

import type { BoundedGrant } from '../../features/grant-runtime/index.js';
import { RLUSD_XRPL_MAINNET_ISSUER, RLUSD_XRPL_TESTNET_ISSUER, andrewSettlementProfile, composeAndrewDemo, type AndrewDemo } from '../andrew-demo/index.js';
import { FINANCIAL_AUTHORITY_REASON_CODES } from '../execution-governance/index.js';
import { checkXrplSettlement } from '../execution-adapters/xrpl/index.js';
import { GOVERNED_ACTION_REASON_CODES as R } from '../governed-action/contracts.js';
import { deriveBusinessIntentId, deriveGovernedActionRequestId, reconsiderationLinkReferenceId } from '../governed-action/identifiers.js';
import { createSqliteGovernanceStore } from '../governance-store/sqlite-governance-store.js';
import { AGENT_SUBJECT, LEGACY_KEY, TRUST_DOMAIN, Workspace, call, govern, secureEnv, type Reply } from './core04-host-fixture.js';
import { withDeploymentWitness } from './core07-freshness-fixture.js';

/**
 * ANDREW-P0-09 — linked reconsideration on the composed Andrew Host, with the
 * real P0-08 transport (env signer, durable attempt store, settlement gate)
 * over a scripted ledger. Offline; the live run is
 * `andrew-p009-live-testnet.test.ts`.
 *
 * One business intent — the agent pays the demo amount to a wallet Frontera has
 * not approved — told end to end:
 *
 *   original (denied) → exact replay (still denied) → reconsideration before
 *   approval (fresh evaluation, still denied, linked) → approval (no payment) →
 *   reconsideration (fresh evaluation, allowed, linked, one grant, one XRPL
 *   payment) → a second reconsideration (withheld: already realized)
 */

const ADMIN_SECRET = 'FRONTERA_ANDREW_P009_ADMIN_SENTINEL_7e1d4a9c03b2f586';
const PRINCIPAL = 'principal-andrew-agent';
const AMOUNT = '10';
const treasury = Wallet.generate();
const recipient = Wallet.generate();
const SEED_VARIABLE = 'TEST_ONLY_P009_TREASURY_SEED';

const workspace = new Workspace();
const demos: AndrewDemo[] = [];
const stores: XrplSubmissionAttemptStore[] = [];
after(async () => {
  for (const demo of demos) await demo.close().catch(() => {});
  for (const store of stores) store.close();
  await workspace.cleanup();
});

function scriptedTestnet() {
  const calls = { connect: 0, submit: 0 };
  const blobs: string[] = [];
  const client: XrplLedgerClient = {
    async serverInfo() {
      return { networkId: 1, validatedLedgerIndex: 7000 };
    },
    async validatedLedgerIndex() {
      return 7000;
    },
    async autofill(tx) {
      // xrpl.js 4.7.0's exact Testnet shape (P0-08), including the present-but-undefined NetworkID.
      return { ...tx, Flags: 0, NetworkID: undefined, Sequence: 77, Fee: '12', LastLedgerSequence: 7020 };
    },
    async submit(blob) {
      calls.submit += 1;
      blobs.push(blob);
      return { engineResult: 'tesSUCCESS' };
    },
    async transaction(hash): Promise<XrplTransactionLookup> {
      const blob = blobs.at(-1);
      if (blob === undefined) return { found: false, searchedAll: false };
      const tx = decode(blob) as Record<string, unknown>;
      return { found: true, validated: true, hash, ledgerIndex: 7002, closeTimeIso: new Date().toISOString(), transaction: { Account: tx['Account'], Destination: tx['Destination'], DeliverMax: tx['Amount'] }, meta: { TransactionResult: 'tesSUCCESS', delivered_amount: tx['Amount'] } };
    },
    async disconnect() {},
  };
  return { calls, connect: async () => ((calls.connect += 1), client) };
}

interface Harness {
  readonly demo: AndrewDemo;
  readonly dir: string;
  readonly ledger: ReturnType<typeof scriptedTestnet>;
  readonly attempts: XrplSubmissionAttemptStore;
  readonly signerCalls: { count: number };
}

async function compose(): Promise<Harness> {
  const dir = workspace.dir();
  const ledger = scriptedTestnet();
  const attempts = createSqliteXrplAttemptStore(join(dir, 'xrpl-attempts.sqlite'));
  stores.push(attempts);
  const base = createEnvXrplSigner({ environment: { [SEED_VARIABLE]: treasury.seed }, seedVariable: SEED_VARIABLE, expectedAccount: treasury.classicAddress });
  const signerCalls = { count: 0 };
  const signer: XrplTransactionSigner = { account: base.account, sign: async (prepared) => ((signerCalls.count += 1), base.sign(prepared)) };
  const profile = andrewSettlementProfile();
  const transport = createXrplTestnetTransport({
    configuration: { endpoint: 'wss://s.altnet.rippletest.net:51233/', sourceAccount: treasury.classicAddress, forbiddenSourceAccounts: [RLUSD_XRPL_TESTNET_ISSUER, RLUSD_XRPL_MAINNET_ISSUER] },
    settlementGate: (submission) => checkXrplSettlement(profile, submission),
    signer,
    attempts,
    connect: ledger.connect,
  });
  const environment = await withDeploymentWitness({ ...secureEnv(dir), FRONTERA_ANDREW_ADMIN_KEY: ADMIN_SECRET });
  const demo = await composeAndrewDemo({
    directory: dir,
    environment,
    identity: {
      trustDomainId: TRUST_DOMAIN,
      agent: { principalId: PRINCIPAL, externalSubject: AGENT_SUBJECT, apiKeyEnv: 'FRONTERA_TEST_AGENT_KEY' },
      operators: [{ operatorId: 'andrew-admin', role: 'organization-administrator', apiKeyEnv: 'FRONTERA_ANDREW_ADMIN_KEY' }],
    },
    transport,
  });
  demos.push(demo);
  return { demo, dir, ledger, attempts, signerCalls };
}

function grants(dir: string): readonly BoundedGrant[] {
  const db = new Database(join(dir, 'bounded-grants.sqlite'), { readonly: true });
  try {
    return (db.prepare('SELECT grant_json FROM bounded_grants').all() as { readonly grant_json: string }[]).map((row) => JSON.parse(row.grant_json) as BoundedGrant);
  } finally {
    db.close();
  }
}

function linkRows(dir: string, evaluationId: string): readonly { readonly reference_id: string; readonly reference_type: string; readonly external_id: string; readonly external_version: string | null; readonly uri: string | null }[] {
  const db = new Database(join(dir, 'governance.sqlite'), { readonly: true });
  try {
    return db.prepare("SELECT reference_id, reference_type, external_id, external_version, uri FROM governance_references WHERE evaluation_id = ? AND reference_type = 'reconsideration_link' ORDER BY sequence").all(evaluationId) as never;
  } finally {
    db.close();
  }
}

const requestIdOf = (demo: AndrewDemo, idempotencyKey: string) => deriveGovernedActionRequestId({ organizationId: demo.organizationId, principalId: PRINCIPAL, idempotencyKey });
const statusOf = (reply: Reply) => reply.body['status'];
const codesOf = (reply: Reply) => (reply.body['reasonCodes'] as readonly string[] | undefined) ?? [];
const decisionOf = (reply: Reply) => reply.body['decision'] as { readonly decisionId: string; readonly evaluationId: string; readonly status: string } | undefined;

describe('ANDREW-P0-09 Host — one business intent: denied, replayed, reconsidered, executed once', () => {
  let h: Harness;
  let original: Reply;
  const keys = { original: 'p009-intent-original', early: 'p009-reconsider-before-approval', allowed: 'p009-reconsider-after-approval', again: 'p009-reconsider-again' };
  const tally = () => ({ grants: grants(h.dir).length, signer: h.signerCalls.count, submits: h.ledger.calls.submit, connects: h.ledger.calls.connect });
  const reconsider = (key: string, of: string, overrides: Record<string, unknown> = {}) =>
    govern(h.demo.baseUrl, { ...h.demo.transferIntent(recipient.classicAddress, AMOUNT), reconsideration: { of, reason: 'destination-approved' }, ...overrides }, key);

  before(async () => {
    h = await compose();
    h.demo.registerDestination(recipient.classicAddress, 'operator:andrew-registrar');
  });

  it('1. the original intent is denied before execution: 0 grants, 0 signatures, 0 submissions', async () => {
    original = await govern(h.demo.baseUrl, h.demo.transferIntent(recipient.classicAddress, AMOUNT), keys.original);
    assert.equal(statusOf(original), 'denied', original.text);
    assert.equal(original.body['requestId'], requestIdOf(h.demo, keys.original));
    assert.deepEqual(tally(), { grants: 0, signer: 0, submits: 0, connects: 0 });
  });

  it('2. an exact replay of the original key returns the stored denial — the same decision, no new evaluation, no authority', async () => {
    const replay = await govern(h.demo.baseUrl, h.demo.transferIntent(recipient.classicAddress, AMOUNT), keys.original);
    assert.equal(statusOf(replay), 'denied');
    assert.deepEqual(decisionOf(replay), decisionOf(original), 'the original committed decision, not a new one');
    assert.deepEqual(tally(), { grants: 0, signer: 0, submits: 0, connects: 0 });
  });

  it('3. a reconsideration before approval is a fresh, linked evaluation — and is still denied', async () => {
    const early = await reconsider(keys.early, String(original.body['requestId']));
    assert.equal(statusOf(early), 'denied', early.text);
    assert.notEqual(early.body['requestId'], original.body['requestId'], 'its own technical identity');
    assert.notEqual(decisionOf(early)?.decisionId, decisionOf(original)?.decisionId, 'a fresh decision');
    assert.equal(early.body['correlationId'], deriveBusinessIntentId({ organizationId: h.demo.organizationId, originalRequestId: String(original.body['requestId']) }), 'the shared business intent');
    const rows = linkRows(h.dir, String(decisionOf(early)?.evaluationId));
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.external_id, original.body['requestId']);
    assert.equal(rows[0]?.external_version, decisionOf(original)?.decisionId);
    assert.equal(rows[0]?.uri, 'urn:aoc:reconsideration:reason:destination-approved');
    assert.deepEqual(tally(), { grants: 0, signer: 0, submits: 0, connects: 0 });
  });

  it('4. destination approval alone executes nothing', async () => {
    const approval = h.demo.destinationGovernance.approveDestination(`Bearer ${ADMIN_SECRET}`, { destination: { namespace: 'xrpl.testnet', identifier: recipient.classicAddress }, idempotencyKey: 'p009-approve-1' });
    assert.equal(approval.outcome, 'approved');
    assert.equal(approval.approval.authorityBasis, 'operator-permission:destination.approve;role:organization-administrator;credential:operator');
    assert.deepEqual(tally(), { grants: 0, signer: 0, submits: 0, connects: 0 });
    const replay = await govern(h.demo.baseUrl, h.demo.transferIntent(recipient.classicAddress, AMOUNT), keys.original);
    assert.equal(statusOf(replay), 'denied', 'replaying the original after approval still returns the original denial');
    assert.deepEqual(decisionOf(replay), decisionOf(original));
    assert.deepEqual(tally(), { grants: 0, signer: 0, submits: 0, connects: 0 });
  });

  it('5. reconsideration after approval: fresh evaluation allows it — exactly one grant, one signature, one submission, executed', async () => {
    const allowed = await reconsider(keys.allowed, String(original.body['requestId']));
    assert.equal(statusOf(allowed), 'executed', allowed.text);
    assert.equal(decisionOf(allowed)?.status, 'allowed');
    assert.deepEqual(tally(), { grants: 1, signer: 1, submits: 1, connects: 1 });
    const grant = grants(h.dir)[0];
    assert.ok(grant !== undefined);
    assert.equal(grant.correlation.requestId, allowed.body['requestId'], 'the grant belongs to the reconsideration, not the original');
    assert.deepEqual(grant.scope.amount, { kind: 'ceiling', limit: '100000', unit: 'USD' });
    const record = h.attempts.find(String(allowed.body['executionId']));
    assert.equal(record?.state, 'validated-success');
    assert.equal(allowed.body['providerRef'], record?.attempt.transactionHash);
    const rows = linkRows(h.dir, String(decisionOf(allowed)?.evaluationId));
    assert.deepEqual(rows.map((row) => row.external_version), [decisionOf(original)?.decisionId, 'realized'], 'link row, then the realization marker');
  });

  it('6. replaying the executed reconsideration answers from its record — no new signature or submission', async () => {
    const replay = await reconsider(keys.allowed, String(original.body['requestId']));
    assert.equal(statusOf(replay), 'executed');
    assert.equal(replay.body['replayed'], true);
    assert.deepEqual(tally(), { grants: 1, signer: 1, submits: 1, connects: 1 });
  });

  it('7. a second reconsideration of the same original is withheld before any grant: one intent, one realization', async () => {
    const again = await reconsider(keys.again, String(original.body['requestId']));
    assert.equal(statusOf(again), 'withheld', again.text);
    assert.equal(again.body['withheldBy'], 'reconsideration');
    assert.ok(codesOf(again).includes(R.GOVERNED_ACTION_RECONSIDERATION_ALREADY_REALIZED));
    assert.deepEqual(tally(), { grants: 1, signer: 1, submits: 1, connects: 1 });
  });

  it('8. the original denial stays historically true: still denied on replay, never authorized, no link rows of its own', async () => {
    const replay = await govern(h.demo.baseUrl, h.demo.transferIntent(recipient.classicAddress, AMOUNT), keys.original);
    assert.equal(statusOf(replay), 'denied');
    assert.deepEqual(decisionOf(replay), decisionOf(original));
    assert.ok(grants(h.dir).every((grant) => grant.correlation.requestId !== original.body['requestId']), 'no grant ever names the original');
    assert.deepEqual(linkRows(h.dir, String(decisionOf(original)?.evaluationId)), []);
  });

  it('9. the ASSURE-01 trace of the reconsideration carries the verified lineage; the original trace is unchanged', async () => {
    const allowedId = requestIdOf(h.demo, keys.allowed);
    const trace = await call(h.demo.baseUrl, 'GET', `/api/evidence/traces/${encodeURIComponent(allowedId)}?level=AUDITOR`, { authorization: `Bearer ${LEGACY_KEY}` });
    assert.equal(trace.status, 200, trace.text);
    const stages = (trace.body['trace'] as { readonly stages: Record<string, Record<string, unknown>> }).stages;
    const lineage = stages['request']?.['lineage'] as Record<string, unknown> | undefined;
    assert.ok(lineage !== undefined, 'lineage is disclosed with the request stage');
    assert.equal(lineage['role'], 'reconsideration');
    assert.equal(lineage['businessIntentId'], original.body['correlationId'] ?? deriveBusinessIntentId({ organizationId: h.demo.organizationId, originalRequestId: String(original.body['requestId']) }));
    assert.equal(lineage['reason'], 'destination-approved');
    assert.equal(lineage['realizedOriginal'], true);
    const reconsiders = lineage['reconsiders'] as Record<string, unknown>;
    assert.equal(reconsiders['requestId'], original.body['requestId']);
    assert.equal(reconsiders['decisionId'], decisionOf(original)?.decisionId);
    assert.equal(reconsiders['status'], 'denied');
    assert.ok(trace.text.includes(String(h.attempts.find(String((await reconsider(keys.allowed, String(original.body['requestId']))).body['executionId']))?.attempt.transactionHash)));
    const verify = await call(h.demo.baseUrl, 'GET', `/api/evidence/traces/${encodeURIComponent(allowedId)}/verify`, { authorization: `Bearer ${LEGACY_KEY}` });
    assert.equal(verify.status, 200, verify.text);
    assert.equal(verify.body['verified'], true, verify.text);
    const lineageChecks = (verify.body['checks'] as readonly { readonly check: string; readonly status: string }[]).filter((entry) => entry.check.startsWith('lineage.'));
    assert.ok(lineageChecks.length >= 8, JSON.stringify(lineageChecks));
    assert.ok(lineageChecks.every((entry) => entry.status === 'pass' || entry.status === 'not-applicable'), JSON.stringify(lineageChecks));
    const originalTrace = await call(h.demo.baseUrl, 'GET', `/api/evidence/traces/${encodeURIComponent(String(original.body['requestId']))}?level=AUDITOR`, { authorization: `Bearer ${LEGACY_KEY}` });
    assert.equal(originalTrace.status, 200);
    assert.equal(originalTrace.text.includes('lineage'), false, 'the original trace is exactly what it was');
  });
});

describe('ANDREW-P0-09 Host — malformed, foreign and drifted reconsiderations are refused before evaluation', () => {
  let h: Harness;
  let original: Reply;
  let otherOriginal: Reply;
  let early: Reply;
  let overOriginal: Reply;
  let plainAllowed: Reply | undefined;
  before(async () => {
    h = await compose();
    h.demo.registerDestination(recipient.classicAddress, 'operator:andrew-registrar');
    original = await govern(h.demo.baseUrl, h.demo.transferIntent(recipient.classicAddress, AMOUNT), 'p009r-original');
    otherOriginal = await govern(h.demo.baseUrl, h.demo.transferIntent(recipient.classicAddress, AMOUNT), 'p009r-other-original');
    early = await govern(h.demo.baseUrl, { ...h.demo.transferIntent(recipient.classicAddress, AMOUNT), reconsideration: { of: String(original.body['requestId']), reason: 'destination-approved' } }, 'p009r-early');
    overOriginal = await govern(h.demo.baseUrl, h.demo.transferIntent(recipient.classicAddress, '125000'), 'p009r-over-denied');
    assert.equal(statusOf(overOriginal), 'denied', overOriginal.text);
    assert.equal(statusOf(original), 'denied');
    assert.equal(statusOf(otherOriginal), 'denied');
    assert.equal(statusOf(early), 'denied');
    h.demo.destinationGovernance.approveDestination(`Bearer ${ADMIN_SECRET}`, { destination: { namespace: 'xrpl.testnet', identifier: recipient.classicAddress }, idempotencyKey: 'p009r-approve' });
  });

  const send = (key: string, body: Record<string, unknown>) => govern(h.demo.baseUrl, { ...h.demo.transferIntent(recipient.classicAddress, AMOUNT), ...body }, key);
  const snapshot = () => ({ grants: grants(h.dir).length, signer: h.signerCalls.count });

  it('malformed linkage is refused as an invalid intent', async () => {
    const start = snapshot();
    for (const [key, reconsideration] of [
      ['p009r-m1', { of: 'aoc.gar:not-hex' }],
      ['p009r-m2', { of: String(original.body['requestId']) }],
      ['p009r-m3', { of: String(original.body['requestId']), reason: 'because' }],
      ['p009r-m4', { of: String(original.body['requestId']), reason: 'destination-approved', approved: true }],
      ['p009r-m5', 'aoc.gar:00000000000000000000000000000000'],
      ['p009r-m6', null],
    ] as const) {
      const reply = await send(key, { reconsideration });
      assert.equal(statusOf(reply), 'rejected', `${key}: ${reply.text}`);
      assert.ok(codesOf(reply).includes(R.GOVERNED_ACTION_INTENT_INVALID), key);
    }
    assert.deepEqual(snapshot(), start);
  });

  it('reconsideration cannot occur without an original, cannot name itself, nor a reconsideration (no chains, no cycles)', async () => {
    const start = snapshot();
    const missing = await send('p009r-missing', { reconsideration: { of: 'aoc.gar:0123456789abcdef0123456789abcdef', reason: 'destination-approved' } });
    assert.ok(codesOf(missing).includes(R.GOVERNED_ACTION_RECONSIDERATION_TARGET_NOT_FOUND), missing.text);
    const self = await send('p009r-self', { reconsideration: { of: requestIdOf(h.demo, 'p009r-self'), reason: 'destination-approved' } });
    assert.ok(codesOf(self).includes(R.GOVERNED_ACTION_RECONSIDERATION_TARGET_SELF), self.text);
    const chain = await send('p009r-chain', { reconsideration: { of: String(early.body['requestId']), reason: 'destination-approved' } });
    assert.ok(codesOf(chain).includes(R.GOVERNED_ACTION_RECONSIDERATION_TARGET_NOT_ORIGINAL), chain.text);
    for (const reply of [missing, self, chain]) assert.equal(statusOf(reply), 'rejected');
    assert.deepEqual(snapshot(), start);
  });

  it('a different business intent cannot reconsider the original: amount, destination or caller-chosen correlation drift is refused', async () => {
    const start = snapshot();
    const of = String(original.body['requestId']);
    for (const [key, body] of [
      ['p009r-amount', { amount: { value: '10.01', currency: 'USD' }, reconsideration: { of, reason: 'destination-approved' } }],
      ['p009r-ns', { counterparty: `xrpl:${recipient.classicAddress}`, reconsideration: { of, reason: 'destination-approved' } }],
      ['p009r-corr', { correlationId: 'caller-chosen-intent', reconsideration: { of, reason: 'destination-approved' } }],
    ] as const) {
      const reply = await send(key, body);
      assert.equal(statusOf(reply), 'rejected', `${key}: ${reply.text}`);
      assert.ok(codesOf(reply).includes(R.GOVERNED_ACTION_RECONSIDERATION_INTENT_MISMATCH), key);
    }
    assert.deepEqual(snapshot(), start);
  });

  it('an allowed action is not reconsiderable; an original key reused for a reconsideration is an idempotency conflict, never a replay', async () => {
    const plain = await send('p009r-plain-allowed', {});
    assert.equal(statusOf(plain), 'executed', plain.text);
    plainAllowed = plain;
    const start = snapshot();
    const notWithheld = await send('p009r-not-withheld', { reconsideration: { of: String(plain.body['requestId']), reason: 'destination-approved' } });
    assert.ok(codesOf(notWithheld).includes(R.GOVERNED_ACTION_RECONSIDERATION_TARGET_NOT_WITHHELD), notWithheld.text);
    // Reuse the ORIGINAL's key, now as a reconsideration of another original with the same intent.
    const reused = await send('p009r-original', { reconsideration: { of: String(otherOriginal.body['requestId']), reason: 'destination-approved' } });
    assert.equal(statusOf(reused), 'rejected', reused.text);
    assert.ok(codesOf(reused).includes(R.GOVERNED_ACTION_IDEMPOTENCY_CONFLICT), reused.text);
    assert.deepEqual(linkRows(h.dir, String(decisionOf(original)?.evaluationId)), [], 'the original record gained no link');
    assert.deepEqual(snapshot(), start);
  });

  it('authority and ceiling are evaluated fresh: a denied USD 125,000 original, reconsidered after approval, is withheld by the USD 100,000 ceiling', async () => {
    const start = snapshot();
    const of = String(overOriginal.body['requestId']);
    const reconsidered = await send('p009r-over-reconsider', { amount: { value: '125000', currency: 'USD' }, reconsideration: { of, reason: 'destination-approved' } });
    assert.equal(statusOf(reconsidered), 'withheld', reconsidered.text);
    assert.ok(codesOf(reconsidered).includes(FINANCIAL_AUTHORITY_REASON_CODES.FINANCIAL_AUTHORITY_CEILING_EXCEEDED), reconsidered.text);
    assert.equal(decisionOf(reconsidered)?.status, 'allowed', 'the fresh decision allowed the destination; authority still capped it');
    assert.deepEqual(snapshot(), start, 'no grant, no signature');
    // The realization was claimed by that reconsideration before issuance: a different one is refused, a retry of it re-runs the gates.
    const second = await send('p009r-over-reconsider-2', { amount: { value: '125000', currency: 'USD' }, reconsideration: { of, reason: 'destination-approved' } });
    assert.ok(codesOf(second).includes(R.GOVERNED_ACTION_RECONSIDERATION_ALREADY_REALIZED), second.text);
    const retry = await send('p009r-over-reconsider', { amount: { value: '125000', currency: 'USD' }, reconsideration: { of, reason: 'destination-approved' } });
    assert.ok(codesOf(retry).includes(FINANCIAL_AUTHORITY_REASON_CODES.FINANCIAL_AUTHORITY_CEILING_EXCEEDED), retry.text);
    assert.deepEqual(snapshot(), start);
  });

  it('an allowed-but-withheld request is not reconsiderable either: only a denied or indeterminate original is', async () => {
    const over = await send('p009r-over-original', { amount: { value: '125000', currency: 'USD' } });
    // Destination is approved now, so a fresh request is judged by the ceiling directly.
    assert.equal(statusOf(over), 'withheld', over.text);
    assert.ok(codesOf(over).includes(FINANCIAL_AUTHORITY_REASON_CODES.FINANCIAL_AUTHORITY_CEILING_EXCEEDED));
    const start = snapshot();
    const overReconsidered = await send('p009r-over-reconsidered', { amount: { value: '125000', currency: 'USD' }, reconsideration: { of: String(over.body['requestId']), reason: 'destination-approved' } });
    // The over-ceiling original was not denied (it was withheld after an allowed decision), so it is not reconsiderable at all.
    assert.equal(statusOf(overReconsidered), 'rejected', overReconsidered.text);
    assert.ok(codesOf(overReconsidered).includes(R.GOVERNED_ACTION_RECONSIDERATION_TARGET_NOT_WITHHELD));
    assert.deepEqual(snapshot(), start);
  });

  it('the trace is not fooled by a forged link row: a row claiming lineage without the same intent fails verification', async () => {
    assert.ok(plainAllowed !== undefined, 'runs after the plain allowed request');
    const governance = await createSqliteGovernanceStore(join(h.dir, 'governance.sqlite'));
    const scope = { system: false as const, organizationId: h.demo.organizationId, actorId: String((await governance.getByRequestId({ system: true } as never, String(plainAllowed.body['requestId'])))?.request.actorId) };
    await governance.appendReference(scope, {
      referenceId: reconsiderationLinkReferenceId(String(plainAllowed.body['requestId'])),
      evaluationId: String(decisionOf(plainAllowed)?.evaluationId),
      referenceType: 'reconsideration_link',
      externalId: String(original.body['requestId']),
      externalVersion: String(decisionOf(original)?.decisionId),
      digest: 'sha256:' + '0'.repeat(64),
      uri: 'urn:aoc:reconsideration:reason:destination-approved',
      createdAt: new Date().toISOString(),
    });
    await governance.close?.();
    const verify = await call(h.demo.baseUrl, 'GET', `/api/evidence/traces/${encodeURIComponent(String(plainAllowed.body['requestId']))}/verify`, { authorization: `Bearer ${LEGACY_KEY}` });
    assert.equal(verify.status, 200, verify.text);
    assert.equal(verify.body['verified'], false, 'a forged lineage never verifies');
    const failed = (verify.body['checks'] as readonly { readonly check: string; readonly status: string }[]).filter((entry) => entry.status === 'fail').map((entry) => entry.check);
    assert.ok(failed.includes('lineage.same-business-intent'), failed.join(','));
    assert.ok(failed.includes('lineage.business-intent-id'), failed.join(','));
  });
});
