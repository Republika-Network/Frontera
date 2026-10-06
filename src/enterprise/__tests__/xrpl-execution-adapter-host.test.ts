import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import Database from 'better-sqlite3';

import { createActionEnforcementPolicyPackIntegration } from '../../features/domain-policy-pack-runtime/integrations/action-enforcement-policy-pack-integration.js';
import { createPolicyPackRuntimeContext } from '../../features/domain-policy-pack-runtime/runtime/policy-pack-runtime-context.js';
import { createPolicyPackRuntime } from '../../features/domain-policy-pack-runtime/services/policy-pack-runtime.js';
import type { ExecutionDestination } from '../../features/destination-runtime/index.js';
import type { BoundedGrant } from '../../features/grant-runtime/index.js';
import type { PolicyPackProvider } from '../../kernel/index.js';
import { createSqliteDestinationApprovalStore } from '../destination-approval/index.js';
import { createSqliteDestinationRegistry } from '../destination-registry/index.js';
import { FINANCIAL_AUTHORITY_REASON_CODES } from '../execution-governance/index.js';
import { createXrplExecutionAdapter } from '../execution-adapters/xrpl/index.js';
import type { GovernanceConfiguration } from '../governance-profile/index.js';
import type { EnterpriseHost } from '../host/enterprise-host.js';
import { buildDurableAuthorityPayloads, DURABLE_FIXTURE_OPERATOR } from '../kernel-authority/fixtures/durable-authority.fixture.js';
import {
  DESTINATION_CONTEXT_FACT_CLASSES as F,
  DESTINATION_POLICY_MATERIAL_FACTS,
  assertDestinationPolicyGovernance,
  createDestinationContextProvider,
  destinationApprovalPolicyRules,
} from '../trusted-context/index.js';
import { ADAPTER_ID, AGENT, AGENT_SUBJECT, DEPLOY, ORG, OWNER, PRODUCTION, TRUST_DOMAIN, Workspace, boot, govern, governedFile, secureEnv, type ContextTable, type Reply } from './core04-host-fixture.js';
import { FIXTURE_TRANSACTION_HASH, USD_ISSUED_OPTIONS, XRPL_ADAPTER_ID, XRPL_DESTINATION, XRPL_ISSUER, createSpyXrplTransport, xrplKey, type SpyXrplTransport } from './xrpl-adapter.fixture.js';

/**
 * ANDREW-P0-06 on the canonical shipped Host — the P0-05 scenario, unchanged,
 * with the transfer routed to the XRPL adapter.
 *
 * `bootEnterpriseHost()` (production profile, SQLite, Ed25519-signed grants,
 * real listener), the real HTTP route, the P0-02 registry, the P0-03 approval
 * store, the P0-04 provider, the P0-05 destination policy, real issuance and
 * the real exercise gate. The XRPL adapter is composed exactly the way an
 * embedder composes one: `executionAdapters` plus a governed-action route.
 * Its transport is the in-memory spy — nothing leaves the process.
 *
 * P0-05 behaviour is reused, not reimplemented: the adapter is reached only
 * when destination governance and every other control have passed, and is the
 * observation point for the rest.
 */

const TRANSFER = 'transfer-funds';
const TREASURY = 'treasury-operating-account';
const TRANSFER_CLASS = 'transfer';

const D: ExecutionDestination = { namespace: 'xrpl', identifier: XRPL_DESTINATION };
const DK = xrplKey(XRPL_DESTINATION);
/** Registered and approved — governance has no opinion on rail validity — but not an XRPL classic address. */
const INVALID: ExecutionDestination = { namespace: 'xrpl', identifier: 'rNotAnXrplAddress' };

const GOVERNANCE: GovernanceConfiguration = {
  parameterDimensions: [],
  actionClasses: [
    { id: TRANSFER_CLASS, actions: [TRANSFER] },
    { id: 'deploy', actions: [DEPLOY] },
  ],
  resourceClasses: [
    { id: 'treasury_account', resources: [TREASURY] },
    { id: 'production_environment', resources: [PRODUCTION] },
  ],
  profiles: [
    {
      profileId: 'destination-governed-transfer',
      version: 1,
      owner: ORG,
      provenance: { authoredBy: 'operator:p006', approvedBy: 'operator:security' },
      actionClass: TRANSFER_CLASS,
      resourceClass: 'treasury_account',
      parameters: [],
      materialFacts: [...DESTINATION_POLICY_MATERIAL_FACTS],
      relevantPolicies: ['p006-policy'],
    },
    {
      profileId: 'production-deploy',
      version: 1,
      owner: ORG,
      provenance: { authoredBy: 'operator:p006', approvedBy: 'operator:security' },
      actionClass: 'deploy',
      resourceClass: 'production_environment',
      parameters: [],
      materialFacts: [],
      relevantPolicies: ['p006-policy'],
    },
  ],
};

const FILE = {
  governance: GOVERNANCE,
  trustedContext: {
    maxFutureSkewSeconds: 0,
    sources: [
      { sourceId: 'destination-registry', kind: 'internal_store', name: 'Destination registry', trustClass: 'authoritative', organizationId: ORG, attests: [{ factClass: F.key, maxAgeSeconds: 900 }, { factClass: F.known, maxAgeSeconds: 900 }] },
      { sourceId: 'destination-approval', kind: 'approval_system', name: 'Destination approval', trustClass: 'authoritative', organizationId: ORG, attests: [{ factClass: F.approvalState, maxAgeSeconds: 900 }, { factClass: F.approved, maxAgeSeconds: 900 }] },
    ],
  },
  monetary: { assets: [{ assetId: 'USD', scale: 2 }, { assetId: 'EUR', scale: 2 }], financialActions: [TRANSFER] },
  routes: [
    { action: TRANSFER, adapterId: XRPL_ADAPTER_ID },
    { action: DEPLOY, adapterId: ADAPTER_ID },
  ],
};

const VERSION = 'policy-pack-p006-v1';

function destinationPolicy(): PolicyPackProvider {
  const writer = { system: true, actorId: 'operator:policy-p006' } as const;
  const runtime = createPolicyPackRuntime(createPolicyPackRuntimeContext('2026-01-01T00:00:00.000Z'));
  runtime.registerPolicyPack(writer, { id: 'p006-policy', name: 'P0-06 destination policy', description: 'Synthetic', kind: 'data_boundary', domain: 'general_enterprise' });
  runtime.registerPolicyPackVersion(writer, {
    id: VERSION,
    policyPackId: 'p006-policy',
    version: '1.0.0',
    scope: { resourceScopes: [TREASURY, PRODUCTION] },
    rules: destinationApprovalPolicyRules({ actionClass: TRANSFER_CLASS, policyPackVersionId: VERSION, sourceIds: ['p006-source'] }),
    sources: [{ id: 'p006-source', type: 'internal_control', title: 'Synthetic', description: 'Synthetic', authority: 'demo_only' }],
    effectiveFrom: '2026-01-01T00:00:00.000Z',
    demoOnly: true,
    legalCompleteness: 'not_legal_advice',
  });
  runtime.activatePolicyPackVersion(writer, VERSION);
  return createActionEnforcementPolicyPackIntegration(runtime);
}

/** The P0-05 authority: a treasury lineage with the P10 USD 100,000 per-execution ceiling and lifetime limit; a deploy lineage with neither. */
async function provisionAuthority(host: EnterpriseHost): Promise<void> {
  const service = host.enterprise.kernelAuthorityProvisioning;
  assert.ok(service !== undefined);
  const payloads = buildDurableAuthorityPayloads(ORG, TRUST_DOMAIN);
  const operator = DURABLE_FIXTURE_OPERATOR;
  await service.provisionActor(operator, payloads.issuerActor);
  await service.provisionTrustDomain(operator, payloads.trustDomain);
  await service.provisionRootIssuer(operator, payloads.rootIssuer);
  await service.provisionActor(operator, { ...payloads.ownerActor, actorId: OWNER, displayName: 'Owner', externalSubject: { system: 'core04-app', subjectId: 'owner-1' } });
  await service.provisionActor(operator, { ...payloads.agentActor, actorId: AGENT, displayName: 'Agent', externalSubject: AGENT_SUBJECT });
  await service.provisionPassport(operator, { ...payloads.passport, passportId: `passport-${AGENT}`, subjectActorId: AGENT });
  await service.provisionCapabilityToken(operator, { ...payloads.capabilityToken, capabilityTokenId: `cap-${AGENT}`, subjectActorId: AGENT, principalActorId: OWNER, issuerActorId: OWNER, actions: [TRANSFER, DEPLOY], resourceScopes: [TREASURY, PRODUCTION] });
  const lineages = [
    { id: 'treasury', actions: [TRANSFER], resources: [TREASURY], constraints: [{ type: 'max_amount', currency: 'USD', value: '100000' }, { type: 'spending_limit', limitId: 'treasury-lifetime', currency: 'USD', maximum: '1000000', window: { kind: 'lifetime' } }] },
    { id: 'devops', actions: [DEPLOY], resources: [PRODUCTION] },
  ] as const;
  for (const lineage of lineages) {
    await service.provisionAuthorityGrant(operator, {
      ...payloads.authorityGrant,
      authorityGrantId: `authority-grant-${lineage.id}`,
      subjectActorId: OWNER,
      actions: [...lineage.actions],
      resourceScopes: [...lineage.resources],
      ...('constraints' in lineage ? { constraints: [...lineage.constraints] } : {}),
    });
    await service.provisionDelegationGrant(operator, {
      ...payloads.delegationGrant,
      delegationGrantId: `delegation-${lineage.id}`,
      delegatorActorId: OWNER,
      delegateActorId: AGENT,
      sourceAuthorityGrantId: `authority-grant-${lineage.id}`,
      actions: [...lineage.actions],
      resourceScopes: [...lineage.resources],
    });
  }
}

const workspace = new Workspace();
const stores: { close(): Promise<void> }[] = [];
after(async () => {
  await workspace.cleanup();
  for (const store of stores) await store.close();
});

interface Harness {
  readonly dir: string;
  readonly baseUrl: string;
  /** Calls to the recording adapter — the non-XRPL route. */
  readonly calls: readonly { readonly action: string }[];
  readonly transport: SpyXrplTransport;
  approve(destination: ExecutionDestination): void;
}

let sequence = 0;

async function harness(): Promise<Harness> {
  const dir = workspace.dir();
  const now = () => new Date().toISOString();
  const registry = await createSqliteDestinationRegistry(join(dir, 'destination-registry.sqlite'), { now });
  registry.register({ destination: D, registeredBy: 'operator:registrar' });
  registry.register({ destination: INVALID, registeredBy: 'operator:registrar' });
  const approvals = await createSqliteDestinationApprovalStore(join(dir, 'destination-approval.sqlite'), { now, registry });
  stores.push(approvals, registry);
  const provider = createDestinationContextProvider({ organizationId: ORG, sourceIds: { registry: 'destination-registry', approval: 'destination-approval' }, registry, approvals });
  assertDestinationPolicyGovernance(GOVERNANCE, TRANSFER_CLASS);

  const transport = createSpyXrplTransport();
  const xrpl = createXrplExecutionAdapter(USD_ISSUED_OPTIONS, transport);
  const context = { provider, set() {}, queries: [] } as unknown as ContextTable;
  const booted = await boot(workspace, secureEnv(dir, governedFile(FILE)), { context, policy: destinationPolicy(), executionAdapters: [xrpl] });
  await provisionAuthority(booted.host);
  const authority = { authenticated: true as const, organizationId: ORG, actorRef: 'operator:ops-1', authorityBasis: 'permission:destination.approve' };
  return {
    dir,
    baseUrl: booted.baseUrl,
    calls: booted.calls,
    transport,
    approve: (destination) => void approvals.approve(authority, { destination, idempotencyKey: `approve-p006-${(sequence += 1)}` }),
  };
}

const send = (value = '75000', counterparty: string = DK, currency = 'USD') => ({ action: TRANSFER, resource: TREASURY, counterparty, amount: { value, currency } });

function grants(dir: string): readonly BoundedGrant[] {
  const db = new Database(join(dir, 'bounded-grants.sqlite'), { readonly: true });
  try {
    return (db.prepare('SELECT grant_json FROM bounded_grants').all() as { readonly grant_json: string }[]).map((row) => JSON.parse(row.grant_json) as BoundedGrant);
  } finally {
    db.close();
  }
}

function assertNothingReachedXrpl(h: Harness, reply: Reply, grantsExpected = 0): void {
  assert.equal(h.transport.submissions.length, 0, `XRPL transport calls must be 0: ${reply.text}`);
  assert.equal(h.calls.length, 0, 'the non-XRPL adapter is not called either');
  assert.equal(grants(h.dir).length, grantsExpected);
}

describe('ANDREW-P0-06 Host — USD 75,000 to an XRPL destination', () => {
  it('unapproved: denied by the unchanged P0-05 policy before any grant; XRPL adapter reached 0 times', async () => {
    const h = await harness();
    const reply = await govern(h.baseUrl, send());
    assert.equal(reply.status, 422, reply.text);
    assert.equal(reply.body['status'], 'denied', reply.text);
    assert.deepEqual(reply.body['reasonCodes'], ['DOMAIN_POLICY_DENIED', 'POLICY_ACTION_PROHIBITED']);
    assertNothingReachedXrpl(h, reply);
  });

  it('approved: the same intent is executed through the XRPL adapter — one submission, the grant-bound destination, issued USD "75000"', async () => {
    const h = await harness();
    assert.equal((await govern(h.baseUrl, send())).body['status'], 'denied');
    h.approve(D);
    const reply = await govern(h.baseUrl, send());

    assert.equal(reply.body['status'], 'executed', reply.text);
    assert.equal(reply.body['providerRef'], FIXTURE_TRANSACTION_HASH, 'the fake transport’s fixture hash, relayed unchanged — not a ledger result');
    assert.equal(h.transport.submissions.length, 1);
    assert.deepEqual(h.transport.submissions[0]?.instruction, { TransactionType: 'Payment', Destination: XRPL_DESTINATION, Amount: { currency: 'USD', issuer: XRPL_ISSUER, value: '75000' } });
    assert.equal(h.calls.length, 0, 'the transfer route is the XRPL adapter, not the recording adapter');
    const minted = grants(h.dir);
    assert.equal(minted.length, 1);
    assert.deepEqual(minted[0]?.scope.counterparty, { kind: 'identity', value: DK }, 'the grant binds the XRPL destination key, in the unchanged grant format');
    assert.equal(h.transport.submissions[0]?.notAfter, minted[0]?.expiresAt);
  });

  it('approved but not a valid XRPL address: governance passes, the grant is issued, the adapter refuses — transport 0, execution_failed ADAPTER_ERROR', async () => {
    const h = await harness();
    h.approve(INVALID);
    const reply = await govern(h.baseUrl, send('75000', xrplKey(INVALID.identifier)));
    assert.equal(reply.body['status'], 'execution_failed', reply.text);
    assert.equal(reply.body['failure'], 'ADAPTER_ERROR', reply.text);
    assertNothingReachedXrpl(h, reply, 1);
  });

  it('approved, USD 125,000: withheld by the unchanged P10 ceiling; XRPL adapter 0', async () => {
    const h = await harness();
    h.approve(D);
    const reply = await govern(h.baseUrl, send('125000'));
    assert.equal(reply.body['status'], 'withheld', reply.text);
    assert.ok((reply.body['reasonCodes'] as readonly string[]).includes(FINANCIAL_AUTHORITY_REASON_CODES.FINANCIAL_AUTHORITY_CEILING_EXCEEDED), reply.text);
    assertNothingReachedXrpl(h, reply);
  });

  it('approved, EUR 75,000: withheld as an asset mismatch, never converted; XRPL adapter 0', async () => {
    const h = await harness();
    h.approve(D);
    const reply = await govern(h.baseUrl, send('75000', DK, 'EUR'));
    assert.equal(reply.body['status'], 'withheld', reply.text);
    assert.ok((reply.body['reasonCodes'] as readonly string[]).includes(FINANCIAL_AUTHORITY_REASON_CODES.FINANCIAL_AUTHORITY_ASSET_MISMATCH), reply.text);
    assertNothingReachedXrpl(h, reply);
  });

  it('existing routing is unchanged: a non-transfer action still reaches its own adapter, never the XRPL transport', async () => {
    const h = await harness();
    const reply = await govern(h.baseUrl, { action: DEPLOY, resource: PRODUCTION });
    assert.equal(reply.body['status'], 'executed', reply.text);
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0]?.action, DEPLOY);
    assert.equal(h.transport.submissions.length, 0);
  });
});
