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
import {
  ANDREW_XRPL_ADAPTER_ID,
  RLUSD_CURRENCY_CODE,
  RLUSD_XRPL_MAINNET_ISSUER,
  RLUSD_XRPL_TESTNET_ISSUER,
  andrewSettlementProfile,
  composeAndrewDemo,
  type AndrewDemo,
} from '../andrew-demo/index.js';
import { FINANCIAL_AUTHORITY_REASON_CODES } from '../execution-governance/index.js';
import { checkXrplSettlement, type XrplPaymentTransport } from '../execution-adapters/xrpl/index.js';
import { AGENT_SUBJECT, LEGACY_KEY, TRUST_DOMAIN, Workspace, call, govern, nextKey, secureEnv } from './core04-host-fixture.js';
import { withDeploymentWitness } from './core07-freshness-fixture.js';

/**
 * ANDREW-P0-08 — the REAL XRPL Testnet transport composed into the Andrew demo
 * Host, offline.
 *
 * Everything is the shipped path — `composeAndrewDemo`, the Host, P0-02…P0-05
 * governance, real grants, the XRPL adapter pinned to Testnet RLUSD — and the
 * transport is `@aoc-enterprise/xrpl-testnet-transport` itself, with its real
 * settlement gate (`checkXrplSettlement` + the Andrew profile), real env signer
 * over a throwaway wallet, real durable attempt store and real xrpl.js
 * encoding. Only the ledger connection is scripted, so the suite runs offline;
 * the live run is `andrew-p008-live-testnet.test.ts`.
 */

const ADMIN_SECRET = 'FRONTERA_ANDREW_P008_ADMIN_SENTINEL_51c0e8f2a9b3d764';
const treasury = Wallet.generate();
const recipient = Wallet.generate();
const SEED_VARIABLE = 'TEST_ONLY_P008_TREASURY_SEED';

const workspace = new Workspace();
const demos: AndrewDemo[] = [];
const stores: XrplSubmissionAttemptStore[] = [];
after(async () => {
  for (const demo of demos) await demo.close().catch(() => {});
  for (const store of stores) store.close();
  await workspace.cleanup();
});

/** A scripted Testnet: network id 1, validated ledger 5000, validates whatever it is sent with exact delivery. */
function scriptedTestnet() {
  const calls = { connect: 0, submit: 0 };
  const blobs: string[] = [];
  const client: XrplLedgerClient = {
    async serverInfo() {
      return { networkId: 1, validatedLedgerIndex: 5000 };
    },
    async validatedLedgerIndex() {
      return 5000;
    },
    async autofill(tx) {
      return { ...tx, Fee: '12', Sequence: 42, LastLedgerSequence: 5020, Flags: 0 };
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
      return { found: true, validated: true, hash, ledgerIndex: 5002, closeTimeIso: new Date().toISOString(), transaction: { Account: tx['Account'], Destination: tx['Destination'], DeliverMax: tx['Amount'] }, meta: { TransactionResult: 'tesSUCCESS', delivered_amount: tx['Amount'] } };
    },
    async disconnect() {},
  };
  return { calls, blobs, connect: async () => ((calls.connect += 1), client) };
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
  // Compile-time proof: the package's transport satisfies the adapter's port exactly.
  const port: XrplPaymentTransport = transport;
  const environment = await withDeploymentWitness({ ...secureEnv(dir), FRONTERA_ANDREW_ADMIN_KEY: ADMIN_SECRET });
  const demo = await composeAndrewDemo({
    directory: dir,
    environment,
    identity: {
      trustDomainId: TRUST_DOMAIN,
      agent: { principalId: 'principal-andrew-agent', externalSubject: AGENT_SUBJECT, apiKeyEnv: 'FRONTERA_TEST_AGENT_KEY' },
      operators: [{ operatorId: 'andrew-admin', role: 'organization-administrator', apiKeyEnv: 'FRONTERA_ANDREW_ADMIN_KEY' }],
    },
    transport: port,
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

describe('ANDREW-P0-08 Host — the real transport behind the governed path (scripted ledger)', () => {
  let h: Harness;
  before(async () => {
    h = await compose();
  });

  it('unapproved: denied, and the real transport is never reached — no connection, no signature, no attempt', async () => {
    const destination = h.demo.registerDestination(recipient.classicAddress, 'operator:andrew-registrar');
    assert.equal(h.demo.destinationGovernance.readDestinationApproval(`Bearer ${ADMIN_SECRET}`, { destination }).state, 'never-approved');
    const reply = await govern(h.demo.baseUrl, h.demo.transferIntent(recipient.classicAddress, '75000'), nextKey('p008-unapproved'));
    assert.equal(reply.body['status'], 'denied', reply.text);
    assert.equal(grants(h.dir).length, 0);
    assert.equal(h.ledger.calls.connect, 0);
    assert.equal(h.signerCalls.count, 0);
    assert.equal(h.ledger.calls.submit, 0);
  });

  it('approved, fresh request: one grant, one signature, one durable attempt, one submit, validated — and the Frontera outcome carries the transaction hash', async () => {
    const destination = { namespace: 'xrpl.testnet', identifier: recipient.classicAddress };
    const approval = h.demo.destinationGovernance.approveDestination(`Bearer ${ADMIN_SECRET}`, { destination, idempotencyKey: 'p008-approve-1' });
    assert.equal(approval.outcome, 'approved');
    const reply = await govern(h.demo.baseUrl, h.demo.transferIntent(recipient.classicAddress, '75000'), nextKey('p008-approved'));
    assert.equal(reply.body['status'], 'executed', reply.text);
    assert.equal(grants(h.dir).length, 1);
    assert.equal(h.signerCalls.count, 1);
    assert.equal(h.ledger.calls.submit, 1);

    const executionId = String(reply.body['executionId']);
    const record = h.attempts.find(executionId);
    assert.ok(record !== undefined, 'the transport attempt is keyed by the Frontera executionId');
    assert.equal(record.state, 'validated-success');
    assert.equal(reply.body['providerRef'], record.attempt.transactionHash, 'the Frontera outcome records the XRPL transaction hash');
    assert.deepEqual({ currency: record.attempt.currency, issuer: record.attempt.issuer, value: record.attempt.value }, { currency: RLUSD_CURRENCY_CODE, issuer: RLUSD_XRPL_TESTNET_ISSUER, value: '75000' });
    assert.equal(record.attempt.sourceAccount, treasury.classicAddress);
    assert.equal(record.attempt.destination, recipient.classicAddress);
    assert.equal(record.attempt.lastLedgerSequence, 5004, 'validated ledger + 4');
    const evidence = record.events.at(-1)?.evidence ?? {};
    assert.equal(evidence['engineResult'], 'tesSUCCESS');
    assert.equal(evidence['ledgerIndex'], '5002');
    assert.equal(evidence['deliveredValue'], '75000');

    // The authority unit stays USD; the rail representation lives only in the transport record.
    const grant = grants(h.dir)[0];
    assert.ok(grant !== undefined);
    assert.deepEqual(grant.scope.amount, { kind: 'ceiling', limit: '100000', unit: 'USD' });
    assert.deepEqual(grant.scope.counterparty, { kind: 'identity', value: `xrpl.testnet:${recipient.classicAddress}` });

    // ASSURE-01: the authority-to-outcome trace reaches the same hash.
    const trace = await call(h.demo.baseUrl, 'GET', `/api/evidence/traces/${encodeURIComponent(String(reply.body['requestId']))}?level=AUDITOR`, { authorization: `Bearer ${LEGACY_KEY}` });
    assert.equal(trace.status, 200, trace.text);
    assert.ok(trace.text.includes(record.attempt.transactionHash), 'the trace carries the transaction hash as the outcome provider reference');
    assert.ok(trace.text.includes(ANDREW_XRPL_ADAPTER_ID), 'the trace names the rail adapter');
    assert.ok(trace.text.includes(executionId));
  });

  it('Scenario B with the real transport installed: USD 125,000 against USD 100,000 — no grant, no connection, no signature, no submit', async () => {
    const before = { grants: grants(h.dir).length, connect: h.ledger.calls.connect, signer: h.signerCalls.count, submit: h.ledger.calls.submit };
    const reply = await govern(h.demo.baseUrl, h.demo.transferIntent(recipient.classicAddress, '125000'), nextKey('p008-125k'));
    assert.equal(reply.body['status'], 'withheld', reply.text);
    assert.ok((reply.body['reasonCodes'] as readonly string[]).includes(FINANCIAL_AUTHORITY_REASON_CODES.FINANCIAL_AUTHORITY_CEILING_EXCEEDED), reply.text);
    assert.equal(grants(h.dir).length, before.grants);
    assert.equal(h.ledger.calls.connect, before.connect);
    assert.equal(h.signerCalls.count, before.signer);
    assert.equal(h.ledger.calls.submit, before.submit);
  });

  it('the namespace-only change fails closed before the real transport: xrpl:<same address> is denied, nothing signed', async () => {
    const before = { connect: h.ledger.calls.connect, signer: h.signerCalls.count };
    const reply = await govern(h.demo.baseUrl, { ...h.demo.transferIntent(recipient.classicAddress, '75000'), counterparty: `xrpl:${recipient.classicAddress}` }, nextKey('p008-ns'));
    assert.equal(reply.body['status'], 'denied', reply.text);
    assert.equal(h.ledger.calls.connect, before.connect);
    assert.equal(h.signerCalls.count, before.signer);
  });
});
