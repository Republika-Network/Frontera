import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import Database from 'better-sqlite3';

import type { BoundedGrant } from '../../features/grant-runtime/index.js';
import {
  ANDREW_TRANSFER_ACTION,
  ANDREW_TREASURY_RESOURCE,
  ANDREW_XRPL_ADAPTER_ID,
  AndrewSettlementConfigurationError,
  ANDREW_TESTNET_RLUSD_SETTLEMENT,
  RLUSD_CURRENCY_CODE,
  RLUSD_XRPL_MAINNET_ISSUER,
  RLUSD_XRPL_TESTNET_ISSUER,
  andrewSettlementProfile,
  composeAndrewDemo,
  createRecordingXrplTransport,
  type AndrewDemo,
  type RecordingXrplTransport,
} from '../andrew-demo/index.js';
import { EnterpriseHttpError } from '../api/enterprise-http-errors.js';
import { createSqliteDestinationApprovalStore } from '../destination-approval/index.js';
import { createSqliteDestinationRegistry } from '../destination-registry/index.js';
import { FINANCIAL_AUTHORITY_REASON_CODES } from '../execution-governance/index.js';
import { createXrplSettlementProfile, isXrplClassicAddress } from '../execution-adapters/xrpl/index.js';
import { AGENT_SUBJECT, TRUST_DOMAIN, Workspace, govern, nextKey, secureEnv, type Reply } from './core04-host-fixture.js';
import { withDeploymentWitness } from './core07-freshness-fixture.js';
import { XRPL_DESTINATION, XRPL_OTHER_DESTINATION } from './xrpl-adapter.fixture.js';

/**
 * ANDREW-P0-07 — the Andrew demo composition on the shipped Host.
 *
 * `composeAndrewDemo` over `bootEnterpriseHost` (production profile, SQLite,
 * signed grants, a real listener), the real HTTP route, the P0-02 registry,
 * the P0-03 approval store behind the CTRL-02 operator plane, the P0-04
 * provider, the P0-05 policy (checked at startup), real issuance and exercise,
 * and the XRPL adapter pinned to Testnet RLUSD. The transport is the recording
 * transport: **nothing leaves the process** and nothing claims settlement, so
 * an authorized payment ends `execution_failed` / `PROVIDER_UNAVAILABLE`
 * ("not submitted") with the exact instruction recorded.
 */

const ADMIN_SECRET = 'FRONTERA_ANDREW_P007_ADMIN_SENTINEL_9d3a61f0b2c84e57';
const RESPONDER_SECRET = 'FRONTERA_ANDREW_P007_RESPONDER_SENTINEL_4e7b20c9a1d3f';
const APPROVER_SECRET = 'FRONTERA_ANDREW_P007_APPROVER_SENTINEL_7c1f93e0b5a2d';
const OBSERVER_SECRET = 'FRONTERA_ANDREW_P007_OBSERVER_SENTINEL_2a8d6f41c0e9b';
const bearer = (secret: string) => `Bearer ${secret}`;

const WALLET = XRPL_DESTINATION;
const OTHER_WALLET = XRPL_OTHER_DESTINATION;

const workspace = new Workspace();
const demos: AndrewDemo[] = [];
after(async () => {
  for (const demo of demos) await demo.close().catch(() => {});
  await workspace.cleanup();
});

async function compose(transport: RecordingXrplTransport): Promise<{ readonly demo: AndrewDemo; readonly dir: string }> {
  const dir = workspace.dir();
  const environment = await withDeploymentWitness({
    ...secureEnv(dir),
    FRONTERA_ANDREW_ADMIN_KEY: ADMIN_SECRET,
    FRONTERA_ANDREW_RESPONDER_KEY: RESPONDER_SECRET,
    FRONTERA_ANDREW_APPROVER_KEY: APPROVER_SECRET,
    FRONTERA_ANDREW_OBSERVER_KEY: OBSERVER_SECRET,
  });
  const demo = await composeAndrewDemo({
    directory: dir,
    environment,
    identity: {
      trustDomainId: TRUST_DOMAIN,
      agent: { principalId: 'principal-andrew-agent', externalSubject: AGENT_SUBJECT, apiKeyEnv: 'FRONTERA_TEST_AGENT_KEY' },
      operators: [
        { operatorId: 'andrew-admin', role: 'organization-administrator', apiKeyEnv: 'FRONTERA_ANDREW_ADMIN_KEY' },
        { operatorId: 'andrew-responder', role: 'responder', apiKeyEnv: 'FRONTERA_ANDREW_RESPONDER_KEY' },
        { operatorId: 'andrew-approver', role: 'approver', apiKeyEnv: 'FRONTERA_ANDREW_APPROVER_KEY' },
        { operatorId: 'andrew-observer', role: 'observer', apiKeyEnv: 'FRONTERA_ANDREW_OBSERVER_KEY' },
      ],
    },
    transport,
  });
  demos.push(demo);
  return { demo, dir };
}

function grants(dir: string): readonly BoundedGrant[] {
  const db = new Database(join(dir, 'bounded-grants.sqlite'), { readonly: true });
  try {
    return (db.prepare('SELECT grant_json FROM bounded_grants').all() as { readonly grant_json: string }[]).map((row) => JSON.parse(row.grant_json) as BoundedGrant);
  } finally {
    db.close();
  }
}

const transportCalls = (transport: RecordingXrplTransport) => transport.accepted.length + transport.refused.length;
const reasonCodes = (reply: Reply) => (reply.body['reasonCodes'] as readonly string[] | undefined) ?? [];

describe('ANDREW-P0-07 Host — Scenario A: USD 75,000 to a wallet that was not previously approved', () => {
  let transport: RecordingXrplTransport;
  let demo: AndrewDemo;
  let dir: string;
  before(async () => {
    transport = createRecordingXrplTransport(andrewSettlementProfile());
    ({ demo, dir } = await compose(transport));
  });

  it('denied while unapproved; approved through destination governance; a fresh request is re-evaluated, granted, and translated to exact Testnet RLUSD', async () => {
    // 1–3. Registered, technically an XRPL Testnet address, and not approved.
    const destination = demo.registerDestination(WALLET, 'operator:andrew-registrar');
    assert.deepEqual(destination, { namespace: 'xrpl.testnet', identifier: WALLET });
    assert.equal(isXrplClassicAddress(WALLET), true);
    assert.equal(demo.destinationGovernance.readDestinationApproval(bearer(OBSERVER_SECRET), { destination }).state, 'never-approved');

    // 4–7. USD 75,000: the destination policy denies — no grant, no XRPL call.
    const firstKey = nextKey('andrew-75k');
    const denied = await govern(demo.baseUrl, demo.transferIntent(WALLET, '75000'), firstKey);
    assert.equal(denied.body['status'], 'denied', denied.text);
    assert.equal(grants(dir).length, 0);
    assert.equal(transportCalls(transport), 0);

    // 8. Approval is destination governance on the operator plane — and only `destination.approve` widens it.
    for (const secret of [RESPONDER_SECRET, APPROVER_SECRET, OBSERVER_SECRET]) {
      assert.throws(
        () => demo.destinationGovernance.approveDestination(bearer(secret), { destination, idempotencyKey: `andrew-approve-${secret.slice(-6)}` }),
        (error: unknown) => error instanceof EnterpriseHttpError && error.httpStatus === 403,
        'no role but organization-administrator may approve a wallet — not even a CTRL-04 decision approver',
      );
    }
    assert.equal(demo.destinationGovernance.readDestinationApproval(bearer(OBSERVER_SECRET), { destination }).state, 'never-approved');
    const approval = demo.destinationGovernance.approveDestination(bearer(ADMIN_SECRET), { destination, idempotencyKey: 'andrew-approve-wallet-1' });
    assert.equal(approval.outcome, 'approved');
    assert.equal(approval.approval.approvedBy, 'operator:andrew-admin');
    assert.equal(approval.approval.authorityBasis, 'operator-permission:destination.approve;role:organization-administrator;credential:operator');

    // Replaying the denied request's key returns the original denial: idempotency is final (the P0-09 question).
    const replayed = await govern(demo.baseUrl, demo.transferIntent(WALLET, '75000'), firstKey);
    assert.equal(replayed.body['status'], 'denied', replayed.text);
    assert.equal(grants(dir).length, 0);
    assert.equal(transportCalls(transport), 0);

    // 9–11. A fresh governed request for the same action is evaluated again, in full.
    const fresh = await govern(demo.baseUrl, demo.transferIntent(WALLET, '75000'), nextKey('andrew-75k-fresh'));
    assert.notEqual(fresh.body['status'], 'denied', fresh.text);
    assert.ok(denied.body['decision'] !== undefined && fresh.body['decision'] !== undefined, fresh.text);
    assert.notEqual(JSON.stringify(fresh.body['decision']), JSON.stringify(denied.body['decision']), 'a new committed decision, not the old one');
    assert.notEqual(fresh.body['requestId'], denied.body['requestId'], 'a new governed request');
    assert.equal(JSON.stringify(replayed.body['decision']), JSON.stringify(denied.body['decision']), 'the replay returned the original decision');
    const minted = grants(dir);
    assert.equal(minted.length, 1, 'exactly one grant');
    const grant = minted[0];
    assert.ok(grant !== undefined);
    assert.deepEqual(grant.scope.counterparty, { kind: 'identity', value: `xrpl.testnet:${WALLET}` }, 'the grant binds the Testnet destination identity');
    assert.deepEqual(grant.scope.amount, { kind: 'ceiling', limit: '100000', unit: 'USD' }, 'the grant stays bounded by the USD 100,000 authority ceiling');
    for (const rail of [RLUSD_CURRENCY_CODE, RLUSD_XRPL_TESTNET_ISSUER, 'xrpl-testnet']) assert.equal(JSON.stringify(grant).includes(rail), false, `no rail representation enters the grant (${rail})`);

    // 12–14. Exactly one canonical Payment, exact RLUSD, on the configured network.
    assert.equal(transport.refused.length, 0);
    assert.equal(transport.accepted.length, 1);
    const submission = transport.accepted[0];
    assert.equal(
      JSON.stringify(submission?.instruction),
      JSON.stringify({ TransactionType: 'Payment', Destination: WALLET, Amount: { currency: RLUSD_CURRENCY_CODE, issuer: RLUSD_XRPL_TESTNET_ISSUER, value: '75000' } }),
    );
    assert.equal(submission?.network, 'xrpl-testnet');
    assert.equal(submission?.notAfter, grant.expiresAt, 'the transport is told the grant horizon');

    // Nothing was sent anywhere, and the Host says so: not a settled payment.
    assert.equal(fresh.body['status'], 'execution_failed', fresh.text);
    assert.equal(fresh.body['failure'], 'PROVIDER_UNAVAILABLE', 'the recording transport reports "not submitted"');
    assert.equal(JSON.stringify(fresh.body).includes('providerRef'), false, 'no transaction hash is invented');
  });

  it('Scenario B: the same approved wallet, USD 125,000 against the USD 100,000 ceiling — no grant, no XRPL call', async () => {
    const before = { grants: grants(dir).length, calls: transportCalls(transport) };
    const reply = await govern(demo.baseUrl, demo.transferIntent(WALLET, '125000'), nextKey('andrew-125k'));
    assert.equal(reply.body['status'], 'withheld', reply.text);
    assert.ok(reasonCodes(reply).includes(FINANCIAL_AUTHORITY_REASON_CODES.FINANCIAL_AUTHORITY_CEILING_EXCEEDED), reply.text);
    assert.equal(grants(dir).length, before.grants, 'no grant');
    assert.equal(transportCalls(transport), before.calls, 'no XRPL transport call');
  });

  it('USD 0.01 to the approved wallet is RLUSD value "0.01"', async () => {
    const accepted = transport.accepted.length;
    await govern(demo.baseUrl, demo.transferIntent(WALLET, '0.01'), nextKey('andrew-cent'));
    assert.equal(transport.accepted.length, accepted + 1);
    assert.deepEqual(transport.accepted.at(-1)?.instruction.Amount, { currency: RLUSD_CURRENCY_CODE, issuer: RLUSD_XRPL_TESTNET_ISSUER, value: '0.01' });
  });

  it('EUR 75,000 to the approved wallet is withheld against the USD grant — never converted, never sent as RLUSD', async () => {
    const before = { grants: grants(dir).length, calls: transportCalls(transport) };
    const reply = await govern(demo.baseUrl, { ...demo.transferIntent(WALLET, '75000'), amount: { value: '75000', currency: 'EUR' } }, nextKey('andrew-eur'));
    assert.equal(reply.body['status'], 'withheld', reply.text);
    assert.equal(grants(dir).length, before.grants, 'no grant');
    assert.equal(transportCalls(transport), before.calls, 'no XRPL call');
  });

  it('the request cannot name an issuer, currency code, network or mapping', async () => {
    const before = { grants: grants(dir).length, calls: transportCalls(transport) };
    const base = demo.transferIntent(WALLET, '75000');
    const outcomes: string[] = [];
    for (const forged of [
      { ...base, issuer: RLUSD_XRPL_MAINNET_ISSUER },
      { ...base, network: 'xrpl-mainnet' },
      { ...base, mapping: { USD: 'XRP' } },
      { ...base, amount: { value: '75000', currency: RLUSD_CURRENCY_CODE } },
      { ...base, amount: { value: '75000', currency: 'RLUSD' } },
      { ...base, amount: { value: '75000', currency: 'USD', issuer: RLUSD_XRPL_MAINNET_ISSUER } },
      { ...base, parameters: { issuer: RLUSD_XRPL_MAINNET_ISSUER, network: 'xrpl-mainnet' } },
    ]) {
      const reply = await govern(demo.baseUrl, forged, nextKey('andrew-forged'));
      outcomes.push(`${reply.status}:${String(reply.body['status'] ?? reply.body['code'] ?? '')}`);
      assert.ok(reply.status >= 400 || ['denied', 'withheld', 'rejected'].includes(String(reply.body['status'])), reply.text);
    }
    assert.equal(outcomes.length, 7);
    assert.ok(outcomes.every((outcome) => !/executed|execution_/.test(outcome)), outcomes.join(' '));
    assert.equal(grants(dir).length, before.grants);
    assert.equal(transportCalls(transport), before.calls);
  });

  it('network namespace isolation: the Testnet approval authorizes neither xrpl: nor xrpl.mainnet: for the same address', async () => {
    const before = { grants: grants(dir).length, calls: transportCalls(transport) };
    for (const namespace of ['xrpl', 'xrpl.mainnet']) {
      const reply = await govern(demo.baseUrl, { ...demo.transferIntent(WALLET, '75000'), counterparty: `${namespace}:${WALLET}` }, nextKey('andrew-ns'));
      assert.equal(reply.body['status'], 'denied', reply.text);
    }
    assert.equal(grants(dir).length, before.grants);
    assert.equal(transportCalls(transport), before.calls);
  });

  it('changing only the namespace fails closed at the rail, even if that other identity were registered and approved', async () => {
    // Adversarial: register and approve `xrpl:<same address>` behind the composition's back.
    const registry = await createSqliteDestinationRegistry(join(dir, 'destination-registry.sqlite'), { now: () => new Date().toISOString() });
    try {
      registry.register({ destination: { namespace: 'xrpl', identifier: WALLET }, registeredBy: 'operator:adversary' });
    } finally {
      await registry.close();
    }
    demo.destinationGovernance.approveDestination(bearer(ADMIN_SECRET), { destination: { namespace: 'xrpl', identifier: WALLET }, idempotencyKey: 'andrew-approve-mainnet-shaped' });
    const before = { grants: grants(dir).length, calls: transportCalls(transport) };
    const reply = await govern(demo.baseUrl, { ...demo.transferIntent(WALLET, '75000'), counterparty: `xrpl:${WALLET}` }, nextKey('andrew-ns-approved'));
    // Governance passes for that (approved) identity and a grant binds it; the Testnet adapter refuses it before the transport.
    assert.equal(reply.body['status'], 'execution_failed', reply.text);
    assert.equal(reply.body['failure'], 'ADAPTER_ERROR', reply.text);
    assert.equal(grants(dir).length, before.grants + 1);
    assert.equal(transportCalls(transport), before.calls, 'no XRPL call for a non-Testnet identity');
  });

  it('tenant isolation: another organization’s approval of a wallet does not approve it here', async () => {
    demo.registerDestination(OTHER_WALLET, 'operator:andrew-registrar');
    const registry = await createSqliteDestinationRegistry(join(dir, 'destination-registry.sqlite'), { now: () => new Date().toISOString() });
    const approvals = await createSqliteDestinationApprovalStore(join(dir, 'destination-approval.sqlite'), { now: () => new Date().toISOString(), registry });
    try {
      approvals.approve(
        { authenticated: true, organizationId: 'org-elsewhere', actorRef: 'operator:elsewhere-admin', authorityBasis: 'operator-permission:destination.approve;role:organization-administrator;credential:operator' },
        { destination: { namespace: 'xrpl.testnet', identifier: OTHER_WALLET }, idempotencyKey: 'elsewhere-approve-1' },
      );
    } finally {
      await approvals.close();
      await registry.close();
    }
    const before = { grants: grants(dir).length, calls: transportCalls(transport) };
    const reply = await govern(demo.baseUrl, demo.transferIntent(OTHER_WALLET, '75000'), nextKey('andrew-tenant'));
    assert.equal(reply.body['status'], 'denied', reply.text);
    assert.equal(grants(dir).length, before.grants);
    assert.equal(transportCalls(transport), before.calls);
  });

  it('the composed governed path is the transfer route only: one action, one resource, one adapter', () => {
    assert.equal(ANDREW_TRANSFER_ACTION, 'transfer-funds');
    assert.equal(ANDREW_TREASURY_RESOURCE, 'treasury-operating-account');
    assert.equal(ANDREW_XRPL_ADAPTER_ID, 'xrpl-testnet.treasury');
    assert.equal(demo.settlement.network, 'xrpl-testnet');
  });
});

describe('ANDREW-P0-07 Host — configuration drift fails closed', () => {
  it('a Mainnet issuer, another network or another namespace refuses to compose — before any Host starts', async () => {
    const dir = workspace.dir();
    for (const settlement of [
      { ...ANDREW_TESTNET_RLUSD_SETTLEMENT, issuer: RLUSD_XRPL_MAINNET_ISSUER },
      { ...ANDREW_TESTNET_RLUSD_SETTLEMENT, network: 'xrpl-mainnet' },
      { ...ANDREW_TESTNET_RLUSD_SETTLEMENT, destinationNamespace: 'xrpl' },
    ]) {
      await assert.rejects(
        composeAndrewDemo({ directory: dir, environment: {}, identity: { trustDomainId: TRUST_DOMAIN, agent: { principalId: 'p', externalSubject: AGENT_SUBJECT, apiKeyEnv: 'X' }, operators: [] }, transport: createRecordingXrplTransport(andrewSettlementProfile()), settlement }),
        AndrewSettlementConfigurationError,
      );
    }
  });

  it('an adapter on Testnet and a transport connected elsewhere: the authorized payment is refused at the transport, never settled', async () => {
    const transport = createRecordingXrplTransport(createXrplSettlementProfile({ network: 'xrpl-mainnet', tokens: [{ currency: RLUSD_CURRENCY_CODE, issuer: RLUSD_XRPL_MAINNET_ISSUER }] }));
    const { demo, dir } = await compose(transport);
    const destination = demo.registerDestination(WALLET, 'operator:andrew-registrar');
    demo.destinationGovernance.approveDestination(bearer(ADMIN_SECRET), { destination, idempotencyKey: 'andrew-approve-drift' });
    const reply = await govern(demo.baseUrl, demo.transferIntent(WALLET, '75000'), nextKey('andrew-drift'));
    assert.equal(grants(dir).length, 1, 'governance authorized it');
    assert.equal(transport.accepted.length, 0, 'nothing would have been signed');
    assert.deepEqual(transport.refused.map((entry) => entry.refusal), ['network-mismatch']);
    assert.equal(reply.body['status'], 'execution_failed', reply.text);
  });
});
