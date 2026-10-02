import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import type { ContextResolutionQuery } from '../../features/context-resolution-runtime/index.js';
import { executionDestinationKey } from '../../features/destination-runtime/index.js';
import type { ContextProvider, PolicyPackProvider } from '../../kernel/index.js';
import { createSqliteDestinationApprovalStore, type DurableDestinationApprovalStore } from '../destination-approval/index.js';
import { createSqliteDestinationRegistry, type DurableDestinationRegistry } from '../destination-registry/index.js';
import type { GovernanceConfiguration } from '../governance-profile/index.js';
import { DESTINATION_CONTEXT_FACT_CLASSES as F, createDestinationContextProvider } from '../trusted-context/index.js';
import { ORG, PAYABLES, SETTLE, Workspace, boot, govern, governedFile, policyPackProvider, provision, rule, secureEnv, type ContextTable } from './core04-host-fixture.js';

/**
 * ANDREW-P0-04 — trusted destination facts on the **canonical shipped Host**
 * (`bootEnterpriseHost()`, production profile, SQLite, signed grants, a real
 * listener), through the real HTTP route, customer admission, the one Kernel's
 * Trusted Context Boundary and the policy input.
 *
 * The policy here decides nothing about destinations: it is a recorder around
 * a rule that never matches, so what is proven is **what policy can see**, not
 * a destination outcome (that is ANDREW-P0-05). Synthetic identifiers only.
 */

const KEYS = [F.approvalState, F.approved, F.key, F.known].sort();

const GOVERNANCE: GovernanceConfiguration = {
  parameterDimensions: [],
  actionClasses: [{ id: 'settle', actions: [SETTLE] }],
  resourceClasses: [{ id: 'payables_ledger', resources: [PAYABLES] }],
  profiles: [
    {
      profileId: 'destination-visibility',
      version: 1,
      owner: ORG,
      provenance: { authoredBy: 'operator:p004', approvedBy: 'operator:security' },
      actionClass: 'settle',
      resourceClass: 'payables_ledger',
      parameters: [],
      materialFacts: KEYS,
      relevantPolicies: ['core04-policy'],
    },
  ],
};

const TRUSTED_CONTEXT = {
  maxFutureSkewSeconds: 0,
  sources: [
    { sourceId: 'destination-registry', kind: 'internal_store', name: 'Destination registry', trustClass: 'authoritative', organizationId: ORG, attests: [{ factClass: F.key, maxAgeSeconds: 900 }, { factClass: F.known, maxAgeSeconds: 900 }] },
    { sourceId: 'destination-approval', kind: 'approval_system', name: 'Destination approval', trustClass: 'authoritative', organizationId: ORG, attests: [{ factClass: F.approvalState, maxAgeSeconds: 900 }, { factClass: F.approved, maxAgeSeconds: 900 }] },
  ],
};

const D = { namespace: 'network-a', identifier: 'abc123' } as const;
const DK = executionDestinationKey(D);
const OTHER_ORG = 'org-other';

const workspace = new Workspace();
const stores: { close(): Promise<void> }[] = [];
after(async () => {
  await workspace.cleanup();
  for (const store of stores) await store.close();
});

interface Harness {
  readonly baseUrl: string;
  readonly calls: readonly { readonly counterparty?: string }[];
  readonly registry: DurableDestinationRegistry;
  readonly approvals: DurableDestinationApprovalStore;
  readonly queries: readonly ContextResolutionQuery[];
  /** The context facts each policy evaluation received. */
  readonly policyInputs: readonly Readonly<Record<string, unknown>>[];
  approve(organizationId: string): void;
}

let sequence = 0;
const key = (prefix: string): string => `${prefix}-p004-${String((sequence += 1)).padStart(6, '0')}`;

async function harness(): Promise<Harness> {
  const dir = workspace.dir();
  const now = () => new Date().toISOString();
  const registry = await createSqliteDestinationRegistry(join(dir, 'destination-registry.sqlite'), { now });
  const approvals = await createSqliteDestinationApprovalStore(join(dir, 'destination-approval.sqlite'), { now, registry });
  registry.register({ destination: D, registeredBy: 'operator:registrar' });

  const queries: ContextResolutionQuery[] = [];
  const destinationProvider = createDestinationContextProvider({ organizationId: ORG, sourceIds: { registry: 'destination-registry', approval: 'destination-approval' }, registry, approvals });
  const recordingProvider: ContextProvider = { resolveContext: (query) => (queries.push(query), destinationProvider.resolveContext(query)) };
  const context = { provider: recordingProvider, set() {}, queries } as unknown as ContextTable;

  const policyInputs: Record<string, unknown>[] = [];
  const inner = policyPackProvider([rule('synthetic-never-matches', { type: 'predicate', field: 'actionClass', operator: 'equals', value: 'synthetic-unused-class' }, { type: 'deny', reasonCode: 'SYNTHETIC_UNUSED', reason: 'Never matches.' })]);
  const policy: PolicyPackProvider = {
    evaluatePolicyForEnforcement(input) {
      policyInputs.push(Object.fromEntries((input.contextFacts ?? []).map((fact) => [fact.factClass, fact.value])));
      return inner.evaluatePolicyForEnforcement(input);
    },
  };

  const booted = await boot(workspace, secureEnv(dir, governedFile({ governance: GOVERNANCE, trustedContext: TRUSTED_CONTEXT })), { context, policy });
  await provision(booted.host);
  stores.push(approvals, registry);
  return {
    baseUrl: booted.baseUrl,
    calls: booted.calls,
    registry,
    approvals,
    queries,
    policyInputs,
    approve: (organizationId) =>
      void approvals.approve({ authenticated: true, organizationId, actorRef: 'operator:ops-1', authorityBasis: 'permission:destination.approve' }, { destination: D, idempotencyKey: key('approve') }),
  };
}

const transfer = (extra: Record<string, unknown> = {}) => ({ action: SETTLE, resource: PAYABLES, counterparty: DK, ...extra });

describe('ANDREW-P0-04 Host — destination facts reach policy through the one governed path', () => {
  it('Example A — approved destination: policy sees known=true, approved=true; the query was scoped by the bound organization and named the request counterparty', async () => {
    const h = await harness();
    h.approve(ORG);
    const reply = await govern(h.baseUrl, transfer());
    assert.equal(reply.body['status'], 'executed', reply.text);
    assert.deepEqual(h.policyInputs.at(-1), { [F.approvalState]: 'approved', [F.approved]: true, [F.key]: DK, [F.known]: true });
    const query = h.queries.at(-1);
    assert.deepEqual(query?.keys, KEYS);
    assert.equal(query?.organizationId, ORG);
    assert.equal(query?.counterpartyId, DK);
    // Execution and grant semantics are unchanged: the adapter receives the same counterparty the facts were about.
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0]?.counterparty, DK);
  });

  it('Example B — known, never approved: policy sees approved=false; P0-04 itself decides nothing (no destination rule yet)', async () => {
    const h = await harness();
    const reply = await govern(h.baseUrl, transfer());
    assert.equal(reply.body['status'], 'executed', reply.text);
    assert.deepEqual(h.policyInputs.at(-1), { [F.approvalState]: 'never-approved', [F.approved]: false, [F.key]: DK, [F.known]: true });
  });

  it('tenant isolation — an approval recorded for another organization in the same store is not this organization’s', async () => {
    const h = await harness();
    h.approve(OTHER_ORG);
    const reply = await govern(h.baseUrl, transfer());
    assert.equal(reply.body['status'], 'executed', reply.text);
    assert.equal(h.policyInputs.at(-1)?.[F.approved], false);
    assert.equal(h.policyInputs.at(-1)?.[F.approvalState], 'never-approved');
  });

  it('an unknown destination resolves known=false, and nothing is registered by asking', async () => {
    const h = await harness();
    const reply = await govern(h.baseUrl, transfer({ counterparty: 'network-a:never-registered' }));
    assert.equal(reply.body['status'], 'executed', reply.text);
    assert.deepEqual(h.policyInputs.at(-1), { [F.approvalState]: 'never-approved', [F.approved]: false, [F.key]: 'network-a:never-registered', [F.known]: false });
    assert.equal(h.registry.lookup({ namespace: 'network-a', identifier: 'never-registered' }).membership, 'unknown');
  });
});

describe('ANDREW-P0-04 Host — request self-assertion', () => {
  it('Example C — governance claims and organization scope at the top level are refused at intake; nothing is evaluated or executed', async () => {
    const h = await harness();
    for (const field of ['destinationApproved', 'destinationKnown', 'approved', 'known', 'approvalStatus', 'approvalState', 'registered', 'trusted', 'organizationId', 'destination', 'governance']) {
      const reply = await govern(h.baseUrl, transfer({ [field]: field === 'governance' ? { destination: { approved: true } } : true }));
      assert.equal(reply.status, 400, `${field}: ${reply.text}`);
    }
    assert.equal(h.policyInputs.length, 0);
    assert.equal(h.calls.length, 0);
  });

  it('claims inside asserted context are not facts: the trusted value is still resolved independently', async () => {
    const h = await harness();
    const reply = await govern(h.baseUrl, transfer({ assertedContext: { destinationApproved: true, approved: true, approvalState: 'approved', governance: { destination: { approved: true } } } }));
    assert.equal(reply.body['status'], 'executed', reply.text);
    assert.equal(h.policyInputs.at(-1)?.[F.approved], false);
    assert.equal(h.policyInputs.at(-1)?.[F.approvalState], 'never-approved');
  });

  it('a fact class itself cannot be asserted', async () => {
    const h = await harness();
    const reply = await govern(h.baseUrl, transfer({ assertedContext: { [F.approved]: true } }));
    assert.equal(reply.status, 400, reply.text);
    assert.equal(h.calls.length, 0);
  });
});

describe('ANDREW-P0-04 Host — Example D: store failure withholds, never false', () => {
  it('approval store unavailable → denied CONTEXT_REQUIRED_FACT_UNRESOLVED before policy sees any destination fact; zero adapter calls', async () => {
    const h = await harness();
    h.approve(ORG);
    await h.approvals.close();
    const reply = await govern(h.baseUrl, transfer());
    assert.equal(reply.body['status'], 'denied', reply.text);
    assert.deepEqual(reply.body['reasonCodes'], ['CONTEXT_REQUIRED_FACT_UNRESOLVED']);
    for (const input of h.policyInputs) assert.equal(F.approved in input || F.known in input, false, 'no destination fact reached policy');
    assert.equal(h.calls.length, 0);
  });

  it('registry unavailable → denied the same way, never known=false', async () => {
    const h = await harness();
    await h.registry.close();
    const reply = await govern(h.baseUrl, transfer());
    assert.equal(reply.body['status'], 'denied', reply.text);
    assert.deepEqual(reply.body['reasonCodes'], ['CONTEXT_REQUIRED_FACT_UNRESOLVED']);
    assert.equal(h.calls.length, 0);
  });

  it('a counterparty that is not a canonical destination key withholds the facts and denies', async () => {
    const h = await harness();
    const reply = await govern(h.baseUrl, transfer({ counterparty: 'supplier-x' }));
    assert.equal(reply.body['status'], 'denied', reply.text);
    assert.deepEqual(reply.body['reasonCodes'], ['CONTEXT_REQUIRED_FACT_UNRESOLVED']);
    assert.equal(h.calls.length, 0);
  });
});
