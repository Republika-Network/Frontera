import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import Database from 'better-sqlite3';

import type { ContextResolutionQuery } from '../../features/context-resolution-runtime/index.js';
import type { PolicyPackRule } from '../../features/domain-policy-pack-runtime/domain/index.js';
import { createActionEnforcementPolicyPackIntegration } from '../../features/domain-policy-pack-runtime/integrations/action-enforcement-policy-pack-integration.js';
import { createPolicyPackRuntimeContext } from '../../features/domain-policy-pack-runtime/runtime/policy-pack-runtime-context.js';
import { createPolicyPackRuntime } from '../../features/domain-policy-pack-runtime/services/policy-pack-runtime.js';
import { executionDestinationKey } from '../../features/destination-runtime/index.js';
import type { BoundedGrant } from '../../features/grant-runtime/index.js';
import type { ContextProvider, PolicyPackProvider } from '../../kernel/index.js';
import { createSqliteDestinationApprovalStore, type DurableDestinationApprovalStore } from '../destination-approval/index.js';
import { createSqliteDestinationRegistry, type DurableDestinationRegistry } from '../destination-registry/index.js';
import { FINANCIAL_AUTHORITY_REASON_CODES } from '../execution-governance/index.js';
import type { GovernanceConfiguration } from '../governance-profile/index.js';
import { toKernelEvaluationResult } from '../governance-store/store-common.js';
import type { EnterpriseHost } from '../host/enterprise-host.js';
import { buildDurableAuthorityPayloads, DURABLE_FIXTURE_OPERATOR } from '../kernel-authority/fixtures/durable-authority.fixture.js';
import type { KernelAuthorityMonetaryConstraint } from '../kernel-authority/contracts.js';
import {
  DESTINATION_CONTEXT_FACT_CLASSES as F,
  DESTINATION_POLICY_MATERIAL_FACTS,
  DESTINATION_POLICY_REASON_CODES as R,
  assertDestinationPolicyGovernance,
  createDestinationContextProvider,
  destinationApprovalPolicyRules,
} from '../trusted-context/index.js';
import { ADAPTER_ID, AGENT, AGENT_SUBJECT, DEPLOY, ORG, OWNER, PRODUCTION, TRUST_DOMAIN, Workspace, boot, committedRecord, govern, governedFile, nextKey, secureEnv, type ContextTable, type Reply } from './core04-host-fixture.js';

/**
 * ANDREW-P0-05 — "send USD 75,000 to a destination this organization never
 * approved", on the **canonical shipped Host** (`bootEnterpriseHost()`,
 * production profile, SQLite everywhere, Ed25519-signed grants, a real
 * listener), through the real HTTP route, customer admission, the one Kernel,
 * the Trusted Context Boundary, the P0-04 destination provider over the real
 * P0-02 registry and P0-03 approval store, the destination approval policy,
 * durable decision commit, grant issuance and the grant-exercise gate.
 *
 * The agent is fully authorized: a delegated authority lineage for the
 * transfer with a USD 100,000 per-execution ceiling. The only thing that
 * differs between the blocked and the executed request is destination
 * approval. Observation points: the recording adapter's calls, the Host's own
 * signed grant store (read-only), the committed Governance Record, and what
 * policy received. Synthetic identifiers only; no rail.
 */

const TRANSFER = 'transfer-funds';
const TREASURY = 'treasury-operating-account';
const TRANSFER_CLASS = 'transfer';
const CEILING = '100000';
const OTHER_ORG = 'org-other';

const D = { namespace: 'network-a', identifier: 'abc123' } as const;
const DK = executionDestinationKey(D);

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
      provenance: { authoredBy: 'operator:p005', approvedBy: 'operator:security' },
      actionClass: TRANSFER_CLASS,
      resourceClass: 'treasury_account',
      parameters: [],
      materialFacts: [...DESTINATION_POLICY_MATERIAL_FACTS],
      relevantPolicies: ['p005-policy'],
    },
    {
      profileId: 'production-deploy',
      version: 1,
      owner: ORG,
      provenance: { authoredBy: 'operator:p005', approvedBy: 'operator:security' },
      actionClass: 'deploy',
      resourceClass: 'production_environment',
      parameters: [],
      materialFacts: [],
      relevantPolicies: ['p005-policy'],
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

const FILE = {
  governance: GOVERNANCE,
  trustedContext: TRUSTED_CONTEXT,
  monetary: { assets: [{ assetId: 'USD', scale: 2 }, { assetId: 'EUR', scale: 2 }], financialActions: [TRANSFER] },
  routes: [
    { action: TRANSFER, adapterId: ADAPTER_ID },
    { action: DEPLOY, adapterId: ADAPTER_ID },
  ],
};

const POLICY_WRITER = { system: true, actorId: 'operator:policy-p005' } as const;
const VERSION = 'policy-pack-p005-v1';

/** The organization's policy pack: the destination approval rules for the transfer class, and nothing else. */
function destinationPolicy(rules: readonly PolicyPackRule[] = destinationApprovalPolicyRules({ actionClass: TRANSFER_CLASS, policyPackVersionId: VERSION, sourceIds: ['p005-source'] })): PolicyPackProvider {
  const runtime = createPolicyPackRuntime(createPolicyPackRuntimeContext('2026-01-01T00:00:00.000Z'));
  runtime.registerPolicyPack(POLICY_WRITER, { id: 'p005-policy', name: 'P0-05 destination policy', description: 'Synthetic', kind: 'data_boundary', domain: 'general_enterprise' });
  runtime.registerPolicyPackVersion(POLICY_WRITER, {
    id: VERSION,
    policyPackId: 'p005-policy',
    version: '1.0.0',
    scope: { resourceScopes: [TREASURY, PRODUCTION] },
    rules,
    sources: [{ id: 'p005-source', type: 'internal_control', title: 'Synthetic', description: 'Synthetic', authority: 'demo_only' }],
    effectiveFrom: '2026-01-01T00:00:00.000Z',
    demoOnly: true,
    legalCompleteness: 'not_legal_advice',
  });
  runtime.activatePolicyPackVersion(POLICY_WRITER, VERSION);
  return createActionEnforcementPolicyPackIntegration(runtime);
}

/**
 * One owner, one agent, two lineages: the treasury lineage carries the P10 USD
 * per-execution ceiling and the aggregate spending limit a financial lineage
 * must state; the deploy lineage carries neither.
 */
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
  const lineages: readonly { readonly id: string; readonly actions: readonly string[]; readonly resources: readonly string[]; readonly constraints?: readonly KernelAuthorityMonetaryConstraint[] }[] = [
    {
      id: 'treasury',
      actions: [TRANSFER],
      resources: [TREASURY],
      constraints: [
        { type: 'max_amount', currency: 'USD', value: CEILING },
        { type: 'spending_limit', limitId: 'treasury-lifetime', currency: 'USD', maximum: '1000000', window: { kind: 'lifetime' } },
      ],
    },
    { id: 'devops', actions: [DEPLOY], resources: [PRODUCTION] },
  ];
  for (const lineage of lineages) {
    await service.provisionAuthorityGrant(operator, {
      ...payloads.authorityGrant,
      authorityGrantId: `authority-grant-${lineage.id}`,
      subjectActorId: OWNER,
      actions: [...lineage.actions],
      resourceScopes: [...lineage.resources],
      ...(lineage.constraints !== undefined ? { constraints: lineage.constraints } : {}),
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

interface PolicyObservation {
  readonly facts: Readonly<Record<string, unknown>>;
  readonly amount?: string;
  readonly currency?: string;
  readonly counterpartyId?: string;
  readonly actionClass?: string;
}

interface Harness {
  readonly host: EnterpriseHost;
  readonly dir: string;
  readonly baseUrl: string;
  readonly calls: readonly { readonly counterparty?: string; readonly amount?: unknown; readonly action: string }[];
  readonly registry: DurableDestinationRegistry;
  readonly approvals: DurableDestinationApprovalStore;
  readonly queries: readonly ContextResolutionQuery[];
  readonly policyInputs: readonly PolicyObservation[];
  /** Pins the approval store's clock (`undefined`: real time). Expiry is the store's own `now >= expiresAt`. */
  setApprovalClock(at: string | undefined): void;
  approve(organizationId?: string, expiresAt?: string): void;
  revoke(organizationId?: string): void;
}

interface HarnessOptions {
  /** Policy rules; defaults to the destination approval rules. */
  readonly rules?: readonly PolicyPackRule[];
  /** Compose the approval store against this independent registry instead of the provider's (inconsistent stores). */
  readonly independentApprovalRegistry?: boolean;
  /** Rewrite the approval readings to "approved" *after* their provenance digest was taken (forgery in transit). */
  readonly forgeApproval?: boolean;
}

let sequence = 0;
const key = (prefix: string): string => `${prefix}-p005-${String((sequence += 1)).padStart(6, '0')}`;
const authority = (organizationId: string) => ({ authenticated: true as const, organizationId, actorRef: 'operator:ops-1', authorityBasis: 'permission:destination.approve' });

async function harness(options: HarnessOptions = {}): Promise<Harness> {
  const dir = workspace.dir();
  let approvalClock: string | undefined;
  const now = () => new Date().toISOString();
  const registry = await createSqliteDestinationRegistry(join(dir, 'destination-registry.sqlite'), { now });
  registry.register({ destination: D, registeredBy: 'operator:registrar' });
  let approvalRegistry: DurableDestinationRegistry = registry;
  if (options.independentApprovalRegistry === true) {
    approvalRegistry = await createSqliteDestinationRegistry(join(dir, 'independent-registry.sqlite'), { now });
    approvalRegistry.register({ destination: { namespace: 'network-a', identifier: 'independent-only' }, registeredBy: 'operator:registrar' });
    stores.push(approvalRegistry);
  }
  const approvals = await createSqliteDestinationApprovalStore(join(dir, 'destination-approval.sqlite'), { now: () => approvalClock ?? now(), registry: approvalRegistry });

  const queries: ContextResolutionQuery[] = [];
  const destinationProvider = createDestinationContextProvider({ organizationId: ORG, sourceIds: { registry: 'destination-registry', approval: 'destination-approval' }, registry, approvals });
  const provider: ContextProvider = {
    async resolveContext(query) {
      queries.push(query);
      const resolved = await destinationProvider.resolveContext(query);
      if (options.forgeApproval !== true) return resolved;
      const forged: Readonly<Record<string, string | boolean>> = { [F.approvalState]: 'approved', [F.approved]: true };
      return { observations: resolved.observations.map((reading) => (reading.key in forged ? { ...reading, value: forged[reading.key] as string | boolean } : reading)) };
    },
  };
  const context = { provider, set() {}, queries } as unknown as ContextTable;

  // The composition refuses a governance configuration under which the rules could be skipped.
  if (options.rules === undefined) assertDestinationPolicyGovernance(GOVERNANCE, TRANSFER_CLASS);
  const policyInputs: PolicyObservation[] = [];
  const inner = destinationPolicy(options.rules);
  const policy: PolicyPackProvider = {
    evaluatePolicyForEnforcement(input) {
      policyInputs.push({
        facts: Object.fromEntries((input.contextFacts ?? []).map((fact) => [fact.factClass, fact.value])),
        ...(input.amount !== undefined ? { amount: input.amount } : {}),
        ...(input.currency !== undefined ? { currency: input.currency } : {}),
        ...(input.counterpartyId !== undefined ? { counterpartyId: input.counterpartyId } : {}),
        ...(input.actionClass !== undefined ? { actionClass: input.actionClass } : {}),
      });
      return inner.evaluatePolicyForEnforcement(input);
    },
  };

  const booted = await boot(workspace, secureEnv(dir, governedFile(FILE)), { context, policy });
  await provisionAuthority(booted.host);
  stores.push(approvals, registry);
  return {
    host: booted.host,
    dir,
    baseUrl: booted.baseUrl,
    calls: booted.calls,
    registry,
    approvals,
    queries,
    policyInputs,
    setApprovalClock: (at) => void (approvalClock = at),
    approve: (organizationId = ORG, expiresAt) =>
      void approvals.approve(authority(organizationId), { destination: D, idempotencyKey: key('approve'), ...(expiresAt !== undefined ? { expiresAt } : {}) }),
    revoke: (organizationId = ORG) => void approvals.revoke(authority(organizationId), { destination: D, idempotencyKey: key('revoke') }),
  };
}

/** The canonical Andrew request: send USD 75,000 to D. Amount is decimal text, as the intake requires. */
const send = (value = '75000', counterparty: string = DK, currency = 'USD', extra: Record<string, unknown> = {}) => ({ action: TRANSFER, resource: TREASURY, counterparty, amount: { value, currency }, ...extra });

/** Every signed grant in the Host's own store, read-only. */
function grants(dir: string): readonly BoundedGrant[] {
  const db = new Database(join(dir, 'bounded-grants.sqlite'), { readonly: true });
  try {
    return (db.prepare('SELECT grant_json FROM bounded_grants').all() as { readonly grant_json: string }[]).map((row) => JSON.parse(row.grant_json) as BoundedGrant);
  } finally {
    db.close();
  }
}

/** The domain-policy outcome recorded in the committed, verified Governance Record. */
async function recordedPolicyOutcome(host: EnterpriseHost, reply: Reply): Promise<{ readonly reasonCode: string; readonly reason: string; readonly passed: boolean }> {
  const committed = toKernelEvaluationResult(await committedRecord(host, reply));
  const found: { reasonCode: string; reason: string; passed: boolean }[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) return value.forEach(visit);
    if (value === null || typeof value !== 'object') return;
    const record = value as Record<string, unknown>;
    if (record['policyId'] === 'domain_policy_pack' && typeof record['reasonCode'] === 'string') found.push(record as unknown as { reasonCode: string; reason: string; passed: boolean });
    Object.values(record).forEach(visit);
  };
  visit(committed);
  assert.ok(found.length > 0, 'the committed decision records the domain policy outcome');
  return found[0] as { reasonCode: string; reason: string; passed: boolean };
}

/** Denied by the destination rule `code`: Kernel `denied`, the rule's code and reason in the committed decision, no grant, no adapter call. */
async function assertDestinationDenied(h: Harness, reply: Reply, code: string, callsBefore = 0, grantsBefore = 0): Promise<void> {
  assert.equal(reply.status, 422, reply.text);
  assert.equal(reply.body['status'], 'denied', reply.text);
  assert.deepEqual(reply.body['reasonCodes'], ['DOMAIN_POLICY_DENIED', 'POLICY_ACTION_PROHIBITED'], reply.text);
  const outcome = await recordedPolicyOutcome(h.host, reply);
  assert.equal(outcome.reasonCode, code);
  assert.equal(outcome.passed, false);
  assert.equal(h.calls.length, callsBefore, 'no adapter call');
  assert.equal(grants(h.dir).length, grantsBefore, 'no grant minted');
}

const KNOWN_NEVER = { [F.approvalState]: 'never-approved', [F.approved]: false, [F.key]: DK, [F.known]: true };
const KNOWN_APPROVED = { [F.approvalState]: 'approved', [F.approved]: true, [F.key]: DK, [F.known]: true };

describe('ANDREW-P0-05 Host — the canonical USD 75,000 scenario', () => {
  it('Case 1 — known, never approved: denied DESTINATION_NOT_APPROVED before any grant; adapter called 0 times', async () => {
    const h = await harness();
    const reply = await govern(h.baseUrl, send());
    await assertDestinationDenied(h, reply, R.notApproved);
    const seen = h.policyInputs.at(-1);
    assert.deepEqual(seen?.facts, KNOWN_NEVER, 'policy received exactly the trusted facts');
    assert.equal(seen?.amount, '75000', 'USD 75,000 reached policy as exact decimal text');
    assert.equal(seen?.currency, 'USD');
    assert.equal(seen?.counterpartyId, DK);
    assert.equal(seen?.actionClass, TRANSFER_CLASS);
    const outcome = await recordedPolicyOutcome(h.host, reply);
    assert.match(outcome.reason, /not approved for this organization/);
    assert.match(outcome.reason, /observed: never-approved/);
  });

  it('Case 2 — the same request after destination approval: destination governance passes, a grant is issued and the adapter runs once', async () => {
    const h = await harness();
    // Evaluation A — unapproved.
    const firstKey = nextKey('p005-a');
    const blocked = await govern(h.baseUrl, send(), firstKey);
    await assertDestinationDenied(h, blocked, R.notApproved);

    // Administrative approval, outside the action, through the P0-03 store API.
    h.approve();

    // Evaluation B — a new submission of the same business intent.
    const reply = await govern(h.baseUrl, send());
    assert.equal(reply.body['status'], 'executed', reply.text);
    assert.deepEqual(h.policyInputs.at(-1)?.facts, KNOWN_APPROVED);
    assert.equal(h.policyInputs.at(-1)?.amount, '75000');
    assert.equal((await recordedPolicyOutcome(h.host, reply)).passed, true);
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0]?.action, TRANSFER);
    assert.equal(h.calls[0]?.counterparty, DK, 'the adapter receives the destination the facts were about');
    assert.deepEqual(h.calls[0]?.amount, { value: '75000', unit: 'USD' }, 'exactly USD 75,000 reaches execution');
    const minted = grants(h.dir);
    assert.equal(minted.length, 1);
    // Grant semantics unchanged: counterparty bound by identity, amount bounded by the authority's ceiling (never the request).
    assert.deepEqual(minted[0]?.scope.counterparty, { kind: 'identity', value: DK });
    assert.equal(JSON.stringify(minted[0]?.scope.amount).includes(CEILING), true, JSON.stringify(minted[0]?.scope.amount));

    // No reevaluation: Evaluation A is final for its idempotency key. Replaying it after approval answers the same denial.
    const replay = await govern(h.baseUrl, send(), firstKey);
    assert.equal(replay.body['status'], 'denied', replay.text);
    assert.deepEqual((replay.body['decision'] as Record<string, unknown>)['decisionId'], (blocked.body['decision'] as Record<string, unknown>)['decisionId']);
    assert.equal(h.calls.length, 1);
    assert.equal(grants(h.dir).length, 1);
  });

  it('Case 3 — unknown destination: denied DESTINATION_UNKNOWN, distinguishable from not-approved; asking registers nothing', async () => {
    const h = await harness();
    const unknown = 'network-a:never-registered';
    const reply = await govern(h.baseUrl, send('75000', unknown));
    await assertDestinationDenied(h, reply, R.unknown);
    assert.deepEqual(h.policyInputs.at(-1)?.facts, { [F.approvalState]: 'never-approved', [F.approved]: false, [F.key]: unknown, [F.known]: false });
    assert.equal(h.registry.lookup({ namespace: 'network-a', identifier: 'never-registered' }).membership, 'unknown');
  });

  it('Case 4 — approved, executed, then revoked: the next request is denied DESTINATION_APPROVAL_INACTIVE; history is intact', async () => {
    const h = await harness();
    h.approve();
    assert.equal((await govern(h.baseUrl, send())).body['status'], 'executed');
    h.revoke();
    const reply = await govern(h.baseUrl, send());
    await assertDestinationDenied(h, reply, R.approvalInactive, 1, 1);
    assert.deepEqual(h.policyInputs.at(-1)?.facts, { ...KNOWN_NEVER, [F.approvalState]: 'revoked' });
    assert.match((await recordedPolicyOutcome(h.host, reply)).reason, /observed: revoked/);
    assert.equal(h.approvals.history({ organizationId: ORG, destination: D }).length, 2, 'the approval and its revocation are both kept');
  });

  it('Case 5 — expired: denied DESTINATION_APPROVAL_INACTIVE exactly at expiresAt, and satisfied one millisecond before', async () => {
    const h = await harness();
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    h.setApprovalClock(new Date(Date.parse(expiresAt) - 120_000).toISOString());
    h.approve(ORG, expiresAt);

    h.setApprovalClock(new Date(Date.parse(expiresAt) - 1).toISOString());
    assert.equal((await govern(h.baseUrl, send())).body['status'], 'executed');

    h.setApprovalClock(expiresAt);
    const reply = await govern(h.baseUrl, send());
    await assertDestinationDenied(h, reply, R.approvalInactive, 1, 1);
    assert.deepEqual(h.policyInputs.at(-1)?.facts, { ...KNOWN_NEVER, [F.approvalState]: 'expired' });
    assert.match((await recordedPolicyOutcome(h.host, reply)).reason, /observed: expired/);
  });
});

describe('ANDREW-P0-05 Host — 75,000 is the scenario, not a threshold', () => {
  it('a known, unapproved destination is denied below, at and above 75,000, each amount reaching policy exactly', async () => {
    const h = await harness();
    for (const value of ['74999', '74999.99', '75000', '75000.01', '75001']) {
      const reply = await govern(h.baseUrl, send(value));
      await assertDestinationDenied(h, reply, R.notApproved);
      assert.equal(h.policyInputs.at(-1)?.amount, value, value);
    }
  });

  it('decimal text is canonicalized at intake, never rounded: "75000.00" is USD 75,000', async () => {
    const h = await harness();
    await assertDestinationDenied(h, await govern(h.baseUrl, send('75000.00')), R.notApproved);
    assert.equal(h.policyInputs.at(-1)?.amount, '75000');
    assert.equal((await govern(h.baseUrl, send('75000.001'))).status, 400, 'more fractional digits than USD allows is refused, never rounded');
  });

  it('an approved destination does not lift the monetary ceiling: USD 125,000 is still withheld by the unchanged P10 authority ceiling', async () => {
    const h = await harness();
    h.approve();
    const reply = await govern(h.baseUrl, send('125000'));
    assert.equal(reply.body['status'], 'withheld', reply.text);
    assert.equal(reply.body['withheldBy'], 'authority-binding');
    assert.ok((reply.body['reasonCodes'] as readonly string[]).includes(FINANCIAL_AUTHORITY_REASON_CODES.FINANCIAL_AUTHORITY_CEILING_EXCEEDED), reply.text);
    assert.equal((reply.body['decision'] as Record<string, unknown>)['status'], 'allowed', 'the decision allowed it; the ceiling withheld it');
    assert.deepEqual(h.policyInputs.at(-1)?.facts, KNOWN_APPROVED, 'destination governance itself was satisfied');
    assert.equal(h.calls.length, 0);
    assert.equal(grants(h.dir).length, 0);
  });

  it('an approved destination does not convert assets: EUR 75,000 against a USD ceiling is withheld, never compared', async () => {
    const h = await harness();
    h.approve();
    const reply = await govern(h.baseUrl, send('75000', DK, 'EUR'));
    assert.equal(reply.body['status'], 'withheld', reply.text);
    assert.equal(reply.body['withheldBy'], 'authority-binding');
    assert.ok((reply.body['reasonCodes'] as readonly string[]).includes(FINANCIAL_AUTHORITY_REASON_CODES.FINANCIAL_AUTHORITY_ASSET_MISMATCH), reply.text);
    assert.equal(h.calls.length, 0);
    assert.equal(grants(h.dir).length, 0);
  });

  it('an unapproved destination is denied in any asset', async () => {
    const h = await harness();
    await assertDestinationDenied(h, await govern(h.baseUrl, send('75000', DK, 'EUR')), R.notApproved);
  });
});

describe('ANDREW-P0-05 Host — organization and identity', () => {
  it('an approval recorded for another organization does not approve the destination for this one', async () => {
    const h = await harness();
    h.approve(OTHER_ORG);
    await assertDestinationDenied(h, await govern(h.baseUrl, send()), R.notApproved);
    assert.deepEqual(h.policyInputs.at(-1)?.facts, KNOWN_NEVER);
  });

  it('a case-different identifier, or the same identifier in another namespace, is another (unknown) destination', async () => {
    const h = await harness();
    h.approve();
    for (const counterparty of ['network-a:ABC123', 'network-b:abc123']) {
      await assertDestinationDenied(h, await govern(h.baseUrl, send('75000', counterparty)), R.unknown);
      assert.equal(h.policyInputs.at(-1)?.facts[F.key], counterparty);
    }
  });
});

describe('ANDREW-P0-05 Host — a request cannot approve its own destination', () => {
  it('top-level approval claims are refused at intake: nothing evaluated, nothing executed', async () => {
    const h = await harness();
    for (const field of ['destinationApproved', 'approved', 'approvalState', 'destinationKnown', 'destination']) {
      const reply = await govern(h.baseUrl, send('75000', DK, 'USD', { [field]: field === 'approvalState' ? 'approved' : true }));
      assert.equal(reply.status, 400, `${field}: ${reply.text}`);
    }
    assert.equal(h.policyInputs.length, 0);
    assert.equal(h.calls.length, 0);
  });

  it('approval claims inside asserted context are evidence, not facts: still denied DESTINATION_NOT_APPROVED', async () => {
    const h = await harness();
    const reply = await govern(h.baseUrl, send('75000', DK, 'USD', { assertedContext: { destinationApproved: true, approved: true, approvalState: 'approved', governance: { destination: { approved: true } } } }));
    await assertDestinationDenied(h, reply, R.notApproved);
    assert.equal(h.policyInputs.at(-1)?.facts[F.approved], false);
  });

  it('the fact class itself cannot be asserted', async () => {
    const h = await harness();
    assert.equal((await govern(h.baseUrl, send('75000', DK, 'USD', { assertedContext: { [F.approved]: true } }))).status, 400);
    assert.equal(h.calls.length, 0);
  });

  it('approval readings rewritten to "approved" after their provenance digest are refused at the boundary: denied, never approved', async () => {
    const h = await harness({ forgeApproval: true });
    const reply = await govern(h.baseUrl, send());
    // The registry's facts are admitted; the forged approval facts are not. Incomplete facts are refused by the destination rules.
    await assertDestinationDenied(h, reply, R.unverified);
    assert.deepEqual(h.policyInputs.at(-1)?.facts, { [F.key]: DK, [F.known]: true });
  });
});

describe('ANDREW-P0-05 Host — unavailable is not "not approved": required context fails closed first', () => {
  const assertUnresolved = (h: Harness, reply: Reply) => {
    assert.equal(reply.body['status'], 'denied', reply.text);
    assert.deepEqual(reply.body['reasonCodes'], ['CONTEXT_REQUIRED_FACT_UNRESOLVED']);
    for (const input of h.policyInputs) assert.equal(F.approved in input.facts || F.known in input.facts, false, 'no destination fact reached policy');
    assert.equal(h.calls.length, 0);
    assert.equal(grants(h.dir).length, 0);
  };

  it('approval store unavailable — even with an active approval', async () => {
    const h = await harness();
    h.approve();
    await h.approvals.close();
    assertUnresolved(h, await govern(h.baseUrl, send()));
  });

  it('registry unavailable', async () => {
    const h = await harness();
    await h.registry.close();
    assertUnresolved(h, await govern(h.baseUrl, send()));
  });

  it('registry and approval store disagree (approval history for a destination the registry does not know)', async () => {
    const h = await harness({ independentApprovalRegistry: true });
    void h.approvals.approve(authority(ORG), { destination: { namespace: 'network-a', identifier: 'independent-only' }, idempotencyKey: key('approve') });
    assertUnresolved(h, await govern(h.baseUrl, send('75000', 'network-a:independent-only')));
  });

  it('a counterparty that is not a canonical destination key', async () => {
    const h = await harness();
    assertUnresolved(h, await govern(h.baseUrl, send('75000', 'supplier-x')));
  });
});

describe('ANDREW-P0-05 Host — scope and backward compatibility', () => {
  it('a non-destination action on the same Host is unaffected: no destination facts asked, no destination rule, executed', async () => {
    const h = await harness();
    const reply = await govern(h.baseUrl, { action: DEPLOY, resource: PRODUCTION });
    assert.equal(reply.body['status'], 'executed', reply.text);
    assert.deepEqual(h.policyInputs.at(-1)?.facts, {});
    assert.equal(h.policyInputs.at(-1)?.actionClass, 'deploy');
    assert.ok(h.queries.every((query) => !query.keys.some((k) => k.startsWith('destination.'))), 'no destination fact was requested');
    assert.equal(h.calls.length, 1);
  });

  it('a Host that does not compose the destination rules is unchanged: the same unapproved USD 75,000 request executes as before P0-05', async () => {
    const neverMatches: PolicyPackRule = { ...destinationApprovalPolicyRules({ actionClass: 'synthetic-unused-class', policyPackVersionId: VERSION, sourceIds: ['p005-source'] })[0]!, id: 'synthetic-never-matches' };
    const h = await harness({ rules: [neverMatches] });
    const reply = await govern(h.baseUrl, send());
    assert.equal(reply.body['status'], 'executed', reply.text);
    assert.deepEqual(h.policyInputs.at(-1)?.facts, KNOWN_NEVER, 'the facts are visible; only composition gives them an effect');
    assert.equal(h.calls.length, 1);
  });
});
