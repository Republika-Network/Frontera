import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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
import { FINANCIAL_AUTHORITY_REASON_CODES as F } from '../execution-governance/index.js';
import { checkXrplSettlement, isXrplClassicAddress } from '../execution-adapters/xrpl/index.js';
import { deriveGovernedActionExecutionId } from '../governed-action/identifiers.js';
import { issuanceWithheldDigest } from '../governed-action/issuance-record.js';
import { AGENT_SUBJECT, LEGACY_KEY, TRUST_DOMAIN, Workspace, call, govern, secureEnv, type Reply } from './core04-host-fixture.js';
import { withDeploymentWitness } from './core07-freshness-fixture.js';

/**
 * ANDREW-P0-10 — the authority-ceiling variant: an otherwise valid request to
 * an **approved** XRPL Testnet destination, for USD 125,000 against a USD
 * 100,000 bounded authority, is stopped at authority issuance — no grant, no
 * exercise, no adapter, no XRPL connection, signature or submission — and the
 * durable evidence says exactly why.
 *
 * Composed exactly like the live Andrew demo (P0-08/P0-09): the real Host, real
 * governance, the real XRPL transport package with its settlement gate, signer
 * and attempt store. Only the ledger is scripted, and it counts every
 * connection, signature and submission, so "zero" is measured, not assumed.
 */

const ADMIN = 'FRONTERA_ANDREW_P010_ADMIN_SENTINEL_3b9f0e1c7a2d5468';
const PRINCIPAL = 'principal-andrew-agent';
const treasury = Wallet.generate();
const wallet = Wallet.generate();
const otherWallet = Wallet.generate();

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
      return { networkId: 1, validatedLedgerIndex: 9000 };
    },
    async validatedLedgerIndex() {
      return 9000;
    },
    async autofill(tx) {
      return { ...tx, Flags: 0, NetworkID: undefined, Sequence: 99, Fee: '12', LastLedgerSequence: 9020 };
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
      return { found: true, validated: true, hash, ledgerIndex: 9002, closeTimeIso: new Date().toISOString(), transaction: { Account: tx['Account'], Destination: tx['Destination'], DeliverMax: tx['Amount'] }, meta: { TransactionResult: 'tesSUCCESS', delivered_amount: tx['Amount'] } };
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
  readonly signatures: { count: number };
}

async function compose(): Promise<Harness> {
  const dir = workspace.dir();
  const ledger = scriptedTestnet();
  const attempts = createSqliteXrplAttemptStore(join(dir, 'xrpl-attempts.sqlite'));
  stores.push(attempts);
  const base = createEnvXrplSigner({ environment: { P010_SEED: treasury.seed }, seedVariable: 'P010_SEED', expectedAccount: treasury.classicAddress });
  const signatures = { count: 0 };
  const signer: XrplTransactionSigner = { account: base.account, sign: async (prepared) => ((signatures.count += 1), base.sign(prepared)) };
  const profile = andrewSettlementProfile();
  const transport = createXrplTestnetTransport({
    configuration: { endpoint: 'wss://s.altnet.rippletest.net:51233/', sourceAccount: treasury.classicAddress, forbiddenSourceAccounts: [RLUSD_XRPL_TESTNET_ISSUER, RLUSD_XRPL_MAINNET_ISSUER] },
    settlementGate: (submission) => checkXrplSettlement(profile, submission),
    signer,
    attempts,
    connect: ledger.connect,
  });
  const environment = await withDeploymentWitness({ ...secureEnv(dir), FRONTERA_ANDREW_ADMIN_KEY: ADMIN });
  const demo = await composeAndrewDemo({
    directory: dir,
    environment,
    identity: { trustDomainId: TRUST_DOMAIN, agent: { principalId: PRINCIPAL, externalSubject: AGENT_SUBJECT, apiKeyEnv: 'FRONTERA_TEST_AGENT_KEY' }, operators: [{ operatorId: 'andrew-admin', role: 'organization-administrator', apiKeyEnv: 'FRONTERA_ANDREW_ADMIN_KEY' }] },
    transport,
  });
  demos.push(demo);
  return { demo, dir, ledger, attempts, signatures };
}

function grants(dir: string): readonly BoundedGrant[] {
  const db = new Database(join(dir, 'bounded-grants.sqlite'), { readonly: true });
  try {
    return (db.prepare('SELECT grant_json FROM bounded_grants').all() as { readonly grant_json: string }[]).map((row) => JSON.parse(row.grant_json) as BoundedGrant);
  } finally {
    db.close();
  }
}

function count(dir: string, file: string, sql: string, ...params: unknown[]): number {
  const db = new Database(join(dir, file), { readonly: true });
  try {
    return (db.prepare(sql).get(...params) as { readonly n: number }).n;
  } finally {
    db.close();
  }
}

interface IssuanceRow {
  readonly reference_id: string;
  readonly external_id: string;
  readonly external_version: string;
  readonly uri: string;
  readonly digest: string;
}
function issuanceRows(dir: string, evaluationId: string): readonly IssuanceRow[] {
  const db = new Database(join(dir, 'governance.sqlite'), { readonly: true });
  try {
    return db.prepare("SELECT reference_id, external_id, external_version, uri, digest FROM governance_references WHERE evaluation_id = ? AND reference_type = 'issuance_record' ORDER BY sequence").all(evaluationId) as IssuanceRow[];
  } finally {
    db.close();
  }
}

const statusOf = (reply: Reply) => reply.body['status'];
const codesOf = (reply: Reply) => (reply.body['reasonCodes'] as readonly string[] | undefined) ?? [];
const decisionOf = (reply: Reply) => reply.body['decision'] as { readonly decisionId: string; readonly evaluationId: string; readonly status: string; readonly reasonCodes: readonly string[] };

async function traceOf(h: Harness, requestId: string) {
  const reply = await call(h.demo.baseUrl, 'GET', `/api/evidence/traces/${encodeURIComponent(requestId)}?level=AUDITOR`, { authorization: `Bearer ${LEGACY_KEY}` });
  assert.equal(reply.status, 200, reply.text);
  const trace = reply.body['trace'] as { readonly summary: Record<string, unknown>; readonly stages: Record<string, Record<string, unknown>> };
  return { text: reply.text, trace };
}
async function verifyOf(h: Harness, requestId: string) {
  const reply = await call(h.demo.baseUrl, 'GET', `/api/evidence/traces/${encodeURIComponent(requestId)}/verify`, { authorization: `Bearer ${LEGACY_KEY}` });
  assert.equal(reply.status, 200, reply.text);
  return { verified: reply.body['verified'] as boolean, checks: reply.body['checks'] as readonly { readonly check: string; readonly status: string }[] };
}

describe('ANDREW-P0-10 — USD 125,000 to an approved destination against a USD 100,000 authority: withheld at issuance, never executed', () => {
  let h: Harness;
  let within: Reply;
  let over: Reply;
  const tally = () => ({ grants: grants(h.dir).length, connects: h.ledger.calls.connect, signatures: h.signatures.count, submissions: h.ledger.calls.submit, attempts: count(h.dir, 'xrpl-attempts.sqlite', 'SELECT COUNT(*) AS n FROM xrpl_submission_attempts') });
  const approvalState = () => h.demo.destinationGovernance.readDestinationApproval(`Bearer ${ADMIN}`, { destination: { namespace: 'xrpl.testnet', identifier: wallet.classicAddress } });

  before(async () => {
    h = await compose();
    const destination = h.demo.registerDestination(wallet.classicAddress, 'operator:andrew-registrar');
    h.demo.destinationGovernance.approveDestination(`Bearer ${ADMIN}`, { destination, idempotencyKey: 'p010-approve-wallet' });
  });

  it('preconditions: the destination is an XRPL Testnet address, registered and approved with intact history; the authority ceiling is exactly USD 100,000', async () => {
    assert.equal(isXrplClassicAddress(wallet.classicAddress), true);
    assert.equal(h.demo.destinationKey(wallet.classicAddress), `xrpl.testnet:${wallet.classicAddress}`);
    const state = approvalState();
    assert.equal(state.state, 'approved');
    assert.equal(state.state === 'approved' && state.approval.authorityBasis, 'operator-permission:destination.approve;role:organization-administrator;credential:operator');
    assert.equal(h.demo.destinationGovernance.destinationApprovalHistory(`Bearer ${ADMIN}`, { destination: { namespace: 'xrpl.testnet', identifier: wallet.classicAddress } }).length, 1);
    // The control: within the ceiling the same intent is granted, and the grant states the authority's ceiling.
    within = await govern(h.demo.baseUrl, h.demo.transferIntent(wallet.classicAddress, '99999.99'), 'p010-within-99999-99');
    assert.equal(statusOf(within), 'executed', within.text);
    assert.deepEqual(grants(h.dir)[0]?.scope.amount, { kind: 'ceiling', limit: '100000', unit: 'USD' }, 'the authority profile is present, ceiling USD 100,000');
  });

  it('USD 125,000: the Kernel allows it (destination policy passed), authority issuance withholds it — FINANCIAL_AUTHORITY_CEILING_EXCEEDED', async () => {
    const start = tally();
    const historyBefore = h.demo.destinationGovernance.destinationApprovalHistory(`Bearer ${ADMIN}`, { destination: { namespace: 'xrpl.testnet', identifier: wallet.classicAddress } });
    over = await govern(h.demo.baseUrl, h.demo.transferIntent(wallet.classicAddress, '125000'), 'p010-over-125000');
    assert.equal(statusOf(over), 'withheld', over.text);
    assert.equal(over.body['withheldBy'], 'authority-binding');
    assert.deepEqual(codesOf(over), [F.FINANCIAL_AUTHORITY_CEILING_EXCEEDED]);
    assert.equal(decisionOf(over).status, 'allowed', 'not a destination denial: the Kernel allowed the action');
    assert.deepEqual(decisionOf(over).reasonCodes, ['ACTION_ALLOWED']);
    assert.equal(JSON.stringify(over.body).includes('providerRef'), false, 'no transaction hash');
    assert.equal(over.body['executionId'], undefined, 'no execution identity was put in play');
    assert.deepEqual(tally(), start, 'zero grant, zero XRPL connection, zero signature, zero submission, zero attempt row');
    assert.deepEqual(h.demo.destinationGovernance.destinationApprovalHistory(`Bearer ${ADMIN}`, { destination: { namespace: 'xrpl.testnet', identifier: wallet.classicAddress } }), historyBefore, 'approval state untouched');
  });

  it('the durable issuance row is exactly the issuance-core result: request, decision, layer, reason, requested USD 125,000, ceiling USD 100,000', () => {
    const rows = issuanceRows(h.dir, decisionOf(over).evaluationId);
    assert.equal(rows.length, 1);
    const row = rows[0];
    assert.ok(row !== undefined);
    assert.equal(row.external_id, over.body['requestId']);
    assert.equal(row.external_version, 'withheld:authority-binding:FINANCIAL_AUTHORITY_CEILING_EXCEEDED');
    assert.equal(row.uri, `urn:aoc:issuance-record:v1;decision=${decisionOf(over).decisionId};requested=USD:125000;ceiling=USD:100000`);
    assert.equal(row.digest, issuanceWithheldDigest({ requestId: String(over.body['requestId']), decisionId: decisionOf(over).decisionId, withheldBy: 'authority-binding', reasonCodes: [F.FINANCIAL_AUTHORITY_CEILING_EXCEEDED], requested: { value: '125000', unit: 'USD' }, ceiling: { value: '100000', unit: 'USD' } }));
    // No P11 attempt or observation exists for the execution identity this decision would have had: nothing pretends execution began.
    const wouldBe = deriveGovernedActionExecutionId({ requestId: String(over.body['requestId']), decisionId: decisionOf(over).decisionId });
    assert.equal(count(h.dir, 'execution-outcomes.sqlite', 'SELECT COUNT(*) AS n FROM execution_attempts WHERE execution_id = ?', wouldBe), 0);
    assert.equal(count(h.dir, 'execution-outcomes.sqlite', 'SELECT COUNT(*) AS n FROM execution_terminal_observations WHERE execution_id = ?', wouldBe), 0);
    // …while the within-ceiling control did record its attempt and observation.
    assert.equal(count(h.dir, 'execution-outcomes.sqlite', 'SELECT COUNT(*) AS n FROM execution_terminal_observations WHERE execution_id = ?', String(within.body['executionId'])), 1);
  });

  it('ASSURE-01: the authority stage is rebuilt from that row — issuance reached and withheld, no grant, no execution, no outcome — and verifies', async () => {
    const { text, trace } = await traceOf(h, String(over.body['requestId']));
    assert.equal(trace.summary['path'], 'allowed');
    assert.equal(trace.summary['finalState'], 'not-executed');
    const authority = trace.stages['authority'] ?? {};
    assert.equal(authority['presence'], 'recorded', 'issuance was reached, not "never reached"');
    assert.deepEqual(authority['grants'], []);
    const issuance = authority['issuance'] as Record<string, unknown>;
    assert.equal(issuance['outcome'], 'withheld');
    assert.equal(issuance['withheldBy'], 'authority-binding');
    assert.deepEqual(issuance['reasonCodes'], ['FINANCIAL_AUTHORITY_CEILING_EXCEEDED']);
    assert.deepEqual(issuance['requested'], { value: '125000', unit: 'USD' });
    assert.deepEqual(issuance['ceiling'], { value: '100000', unit: 'USD' });
    assert.equal(issuance['records'], 1);
    assert.equal(trace.stages['execution']?.['presence'], 'not-reached');
    assert.equal(trace.stages['outcome']?.['presence'], 'not-reached');
    assert.equal(/providerRef|transactionHash/.test(text), false, 'the evidence implies no transaction');
    const { verified, checks } = await verifyOf(h, String(over.body['requestId']));
    assert.equal(verified, true);
    const issuanceChecks = checks.filter((entry) => entry.check.startsWith('issuance.'));
    assert.equal(issuanceChecks.length, 9);
    assert.ok(issuanceChecks.every((entry) => entry.status === 'pass'), JSON.stringify(issuanceChecks));
  });

  it('a within-ceiling request is unaffected: executed, its trace carries no issuance record', async () => {
    const { trace } = await traceOf(h, String(within.body['requestId']));
    assert.equal(trace.summary['finalState'], 'executed-confirmed-completed');
    assert.equal(trace.stages['authority']?.['issuance'], undefined);
    assert.equal((trace.stages['authority']?.['grants'] as readonly unknown[]).length, 1);
  });

  it('boundaries follow the authority contract (requested ≤ ceiling): 100,000 proceeds, 100,000.01 and 125,000 are withheld', async () => {
    const atCeiling = await govern(h.demo.baseUrl, h.demo.transferIntent(wallet.classicAddress, '100000'), 'p010-at-100000');
    assert.equal(statusOf(atCeiling), 'executed', atCeiling.text);
    const start = tally();
    const justOver = await govern(h.demo.baseUrl, h.demo.transferIntent(wallet.classicAddress, '100000.01'), 'p010-over-100000-01');
    assert.equal(statusOf(justOver), 'withheld');
    assert.deepEqual(codesOf(justOver), [F.FINANCIAL_AUTHORITY_CEILING_EXCEEDED]);
    assert.deepEqual(tally(), start);
  });

  it('a replay of the 125,000 request answers the same withholding and records it once — still no grant', async () => {
    const start = tally();
    const replay = await govern(h.demo.baseUrl, h.demo.transferIntent(wallet.classicAddress, '125000'), 'p010-over-125000');
    assert.equal(statusOf(replay), 'withheld');
    assert.deepEqual(codesOf(replay), [F.FINANCIAL_AUTHORITY_CEILING_EXCEEDED]);
    assert.deepEqual(decisionOf(replay), decisionOf(over));
    assert.equal(issuanceRows(h.dir, decisionOf(over).evaluationId).length, 1);
    assert.deepEqual(tally(), start);
  });

  it('tampering with the stored reason, ceiling, requested amount, request linkage or decision linkage fails trace verification', async () => {
    const requestId = String(over.body['requestId']);
    const row = issuanceRows(h.dir, decisionOf(over).evaluationId)[0];
    assert.ok(row !== undefined);
    const tampers: readonly [string, string, string][] = [
      ['reason', 'external_version', 'withheld:authority-binding:FINANCIAL_AUTHORITY_UNRESOLVED'],
      ['ceiling', 'uri', row.uri.replace('ceiling=USD:100000', 'ceiling=USD:200000')],
      ['requested amount', 'uri', row.uri.replace('requested=USD:125000', 'requested=USD:12500')],
      ['decision linkage', 'uri', row.uri.replace(`decision=${decisionOf(over).decisionId}`, 'decision=enforcement-decision-forged')],
      ['request linkage', 'external_id', 'aoc.gar:00000000000000000000000000000000'],
    ];
    for (const [label, column, value] of tampers) {
      const db = new Database(join(h.dir, 'governance.sqlite'));
      try {
        db.prepare(`UPDATE governance_references SET ${column} = ? WHERE reference_id = ?`).run(value, row.reference_id);
      } finally {
        db.close();
      }
      const { verified, checks } = await verifyOf(h, requestId);
      const failed = checks.filter((entry) => entry.status === 'fail').map((entry) => entry.check);
      assert.equal(verified, false, label);
      assert.ok(failed.includes('integrity.governance-record'), `${label}: ${failed.join(',')}`);
      assert.ok(failed.some((check) => check.startsWith('issuance.')), `${label}: the issuance checks also refuse it — ${failed.join(',')}`);
      const restore = new Database(join(h.dir, 'governance.sqlite'));
      try {
        restore.prepare(`UPDATE governance_references SET ${column} = ? WHERE reference_id = ?`).run((row as unknown as Record<string, string>)[column], row.reference_id);
      } finally {
        restore.close();
      }
      assert.equal((await verifyOf(h, requestId)).verified, true, `${label}: restored`);
    }
  });

  it('a forged row whose own digest is recomputed still fails: the linkage checks bind it to this request, decision and committed amount', async () => {
    const requestId = String(over.body['requestId']);
    const row = issuanceRows(h.dir, decisionOf(over).evaluationId)[0];
    assert.ok(row !== undefined);
    const genuine = { requestId, decisionId: decisionOf(over).decisionId, withheldBy: 'authority-binding', reasonCodes: [F.FINANCIAL_AUTHORITY_CEILING_EXCEEDED], requested: { value: '125000', unit: 'USD' }, ceiling: { value: '100000', unit: 'USD' } };
    const forgeries: readonly [string, typeof genuine, string][] = [
      ['requested amount', { ...genuine, requested: { value: '12500', unit: 'USD' } }, 'issuance.requested-amount'],
      ['decision linkage', { ...genuine, decisionId: 'enforcement-decision-forged' }, 'issuance.decision-linkage'],
      ['request linkage', { ...genuine, requestId: 'aoc.gar:00000000000000000000000000000000' }, 'issuance.request-linkage'],
    ];
    for (const [label, forged, expected] of forgeries) {
      const write = (values: { readonly external_id: string; readonly uri: string; readonly digest: string }) => {
        const db = new Database(join(h.dir, 'governance.sqlite'));
        try {
          db.prepare('UPDATE governance_references SET external_id = ?, uri = ?, digest = ? WHERE reference_id = ?').run(values.external_id, values.uri, values.digest, row.reference_id);
        } finally {
          db.close();
        }
      };
      write({ external_id: forged.requestId, uri: `urn:aoc:issuance-record:v1;decision=${forged.decisionId};requested=USD:${forged.requested.value};ceiling=USD:100000`, digest: issuanceWithheldDigest(forged) });
      const { verified, checks } = await verifyOf(h, requestId);
      const failed = checks.filter((entry) => entry.status === 'fail').map((entry) => entry.check);
      assert.equal(verified, false, label);
      assert.ok(failed.includes(expected), `${label}: ${expected} must fail on its own — ${failed.join(',')}`);
      assert.equal(failed.includes('issuance.record-well-formed'), false, `${label}: the forgery is well formed, so only linkage can catch it`);
      write(row);
      assert.equal((await verifyOf(h, requestId)).verified, true, `${label}: restored`);
    }
  });

  it('a previously approved destination creates no authority, and reconsideration does not bypass the ceiling', async () => {
    const destination = h.demo.registerDestination(otherWallet.classicAddress, 'operator:andrew-registrar');
    const original = await govern(h.demo.baseUrl, h.demo.transferIntent(otherWallet.classicAddress, '125000'), 'p010-recon-original');
    assert.equal(statusOf(original), 'denied', 'unapproved: denied by destination policy first');
    h.demo.destinationGovernance.approveDestination(`Bearer ${ADMIN}`, { destination, idempotencyKey: 'p010-approve-other' });
    const start = tally();
    const reconsidered = await govern(h.demo.baseUrl, { ...h.demo.transferIntent(otherWallet.classicAddress, '125000'), reconsideration: { of: String(original.body['requestId']), reason: 'destination-approved' } }, 'p010-recon-125000');
    assert.equal(statusOf(reconsidered), 'withheld', reconsidered.text);
    assert.deepEqual(codesOf(reconsidered), [F.FINANCIAL_AUTHORITY_CEILING_EXCEEDED]);
    assert.equal(decisionOf(reconsidered).status, 'allowed');
    assert.deepEqual(tally(), start, 'no grant, no XRPL activity');
    const { trace } = await traceOf(h, String(reconsidered.body['requestId']));
    assert.ok(trace.stages['request']?.['lineage'] !== undefined, 'the P0-09 lineage still applies');
    assert.deepEqual((trace.stages['authority']?.['issuance'] as Record<string, unknown>)['reasonCodes'], ['FINANCIAL_AUTHORITY_CEILING_EXCEEDED']);
    assert.equal((await verifyOf(h, String(reconsidered.body['requestId']))).verified, true);
  });

  it('the recorded P0-09 live evidence is untouched by P0-10', () => {
    const doc = readFileSync('docs/demo/andrew/ANDREW-P0-09-LINKED-RECONSIDERATION.md', 'utf8');
    assert.ok(doc.includes('7857B27CC2467B467C6EA5731AE919DBC43866A23C0B467C1AD03815FC76DCAC'));
    assert.ok(doc.includes('**VERIFIED**'));
  });
});
