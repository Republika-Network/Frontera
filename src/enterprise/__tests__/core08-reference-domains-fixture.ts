import assert from 'node:assert/strict';

import type { KernelAuthorityMonetaryConstraint as AuthorityConstraint } from '../kernel-authority/contracts.js';
import type { PolicyCondition, PolicyPredicateCondition } from '../../features/domain-policy-pack-runtime/domain/policy-pack-condition.js';
import type { PolicyPackRule } from '../../features/domain-policy-pack-runtime/domain/policy-pack-rule.js';
import type { EnforcementPolicyPackEvaluationInput } from '../../features/action-enforcement/domain/policy-pack-enforcement.js';
import type { ExecutionAdapter, ValidatedExecutionAction } from '../../features/execution-runtime/index.js';
import type { PolicyPackProvider } from '../../kernel/index.js';
import type { EnterpriseGenericHttpExecutionAdapterOptions } from '../execution-adapters/generic-http/contracts.js';
import { snapshotGenericHttpOptions } from '../execution-adapters/generic-http/configuration.js';
import { createGenericHttpExecutionAdapterCore } from '../execution-adapters/generic-http/generic-http-execution-adapter.js';
import type { GenericHttpNetworkRuntime } from '../execution-adapters/generic-http/node-https-transport.js';
import type { GenericHttpResolvedAddress } from '../execution-adapters/generic-http/public-address-policy.js';
import type { GenericHttpWireRequest } from '../execution-adapters/generic-http/request-mapper.js';
import type { GovernanceConfiguration } from '../governance-profile/index.js';
import { bootEnterpriseHost, type EnterpriseHost } from '../host/enterprise-host.js';
import { buildDurableAuthorityPayloads, DURABLE_FIXTURE_OPERATOR } from '../kernel-authority/fixtures/durable-authority.fixture.js';
import { POLICY_WRITER, Workspace, createContextTable, rule, secureEnv, type ContextTable, type Reading } from './core04-host-fixture.js';
import { withDeploymentWitness } from './core07-freshness-fixture.js';
import { createActionEnforcementPolicyPackIntegration } from '../../features/domain-policy-pack-runtime/integrations/action-enforcement-policy-pack-integration.js';
import { createPolicyPackRuntimeContext } from '../../features/domain-policy-pack-runtime/runtime/policy-pack-runtime-context.js';
import { createPolicyPackRuntime } from '../../features/domain-policy-pack-runtime/services/policy-pack-runtime.js';

/**
 * CORE-08 — three materially different reference domains in **one** trusted
 * Host configuration world.
 *
 * ```
 *                 one bootEnterpriseHost()  ·  one Kernel  ·  one policy runtime
 *                 one Governance Store · one signed grant store · one P7 · one P11
 *   TREASURY   transfer-funds          × treasury-operating-account   amount (P9) ≤ P10 ceiling
 *   DEVOPS     deploy-release          × production-cluster-eu        replicaCount ≤ · deploymentStrategy =
 *   DATA       read-customer-records   × customer-records-eu          recordCount ≤
 *              export-customer-records × customer-records-eu          recordCount ≤ · exportFormat =
 * ```
 *
 * Everything that makes a domain a domain is **data** handed to the Host
 * through its canonical inputs: the governed-action file (parameter
 * dimensions, action/resource classes, Governance Profiles, trusted sources,
 * monetary assets, routes), the organization's policy (a real
 * `PolicyPackRuntime` over the generic predicates), the durable authority
 * world (P10's ceiling on the treasury lineage), the context table (the
 * deterministic trusted-context retrieval) and three **Generic HTTP adapter
 * configurations**. No Kernel, orchestrator, grant, exercise or outcome code
 * is domain-specific, and nothing here adds any.
 *
 * ## The network boundary, stated honestly (§53)
 *
 * The three adapters are the production Generic HTTP adapter core — the real
 * configuration snapshot, request mapper, address policy and status
 * classification — composed as trusted in-process adapters through
 * `bootEnterpriseHost({ executionAdapters })`. Only the *network runtime* is
 * replaced, through the adapter's internal test seam
 * (`createGenericHttpExecutionAdapterCore`), by a deterministic fake provider
 * that records the exact wire request and answers `200` from a pinned public
 * address. The production Node HTTPS transport (fresh DNS, public-address
 * policy, TLS, no redirects, no retries, bounded timeout) is unchanged and is
 * **not** exercised here — this is not a real-provider end-to-end run.
 *
 * Synthetic identifiers only. No real customer data, funds or clusters.
 */

export const ORG = 'org-core04';
export const TRUST_DOMAIN = 'trust-domain-core04';
export const OWNER = 'actor-owner';
export const AGENT = 'actor-agent';
export const AGENT_SUBJECT = { system: 'core04-app', subjectId: 'agent-1' } as const;

// --- the three reference domains: identifiers are deployment data ---------

export const TRANSFER = 'transfer-funds';
export const TREASURY_ACCOUNT = 'treasury-operating-account';
export const PAYEE = 'supplier-001';

export const DEPLOY = 'deploy-release';
export const CLUSTER = 'production-cluster-eu';

export const READ = 'read-customer-records';
export const EXPORT = 'export-customer-records';
export const CUSTOMER_RECORDS = 'customer-records-eu';
/** A second data resource the organization also holds authority over — the target of a resource substitution. */
export const OTHER_RECORDS = 'customer-records-us';

export const ACTIONS = [TRANSFER, DEPLOY, READ, EXPORT];
export const RESOURCES = [TREASURY_ACCOUNT, CLUSTER, CUSTOMER_RECORDS, OTHER_RECORDS];

export const TREASURY_HTTP = 'treasury-http';
export const DEVOPS_HTTP = 'devops-http';
export const DATA_HTTP = 'data-http';
export const ADAPTER_IDS = [TREASURY_HTTP, DEVOPS_HTTP, DATA_HTTP] as const;

/** P10: the treasury lineage's durable per-execution ceiling. */
export const TREASURY_CEILING = '1000';

export const GOVERNANCE: GovernanceConfiguration = {
  parameterDimensions: [
    { id: 'replicaCount', type: 'integer', bound: 'maximum' },
    { id: 'deploymentStrategy', type: 'token', bound: 'exact' },
    { id: 'recordCount', type: 'integer', bound: 'maximum' },
    { id: 'exportFormat', type: 'token', bound: 'exact' },
  ],
  actionClasses: [
    { id: 'transfer', actions: [TRANSFER] },
    { id: 'deploy', actions: [DEPLOY] },
    { id: 'read', actions: [READ] },
    { id: 'export', actions: [EXPORT] },
  ],
  resourceClasses: [
    { id: 'treasury_account', resources: [TREASURY_ACCOUNT] },
    { id: 'production_environment', resources: [CLUSTER] },
    { id: 'customer_dataset', resources: [CUSTOMER_RECORDS, OTHER_RECORDS] },
  ],
  profiles: [
    {
      profileId: 'treasury-transfer',
      version: 1,
      owner: ORG,
      provenance: { authoredBy: 'operator:treasury-ops', approvedBy: 'operator:security' },
      actionClass: 'transfer',
      resourceClass: 'treasury_account',
      parameters: [],
      materialFacts: ['invoice.approved', 'payee.approved'],
      relevantPolicies: ['core08-policy'],
    },
    {
      profileId: 'deploy-production',
      version: 1,
      owner: ORG,
      provenance: { authoredBy: 'operator:platform', approvedBy: 'operator:security' },
      actionClass: 'deploy',
      resourceClass: 'production_environment',
      parameters: [
        { dimension: 'deploymentStrategy', required: true },
        { dimension: 'replicaCount', required: true },
      ],
      materialFacts: ['changeWindow.open', 'rollback.available'],
      relevantPolicies: ['core08-policy'],
    },
    {
      profileId: 'customer-data-read',
      version: 1,
      owner: ORG,
      provenance: { authoredBy: 'operator:data-governance', approvedBy: 'operator:security' },
      actionClass: 'read',
      resourceClass: 'customer_dataset',
      parameters: [{ dimension: 'recordCount', required: true }],
      materialFacts: ['supportCase.open'],
      relevantPolicies: ['core08-policy'],
    },
    {
      profileId: 'customer-data-export',
      version: 1,
      owner: ORG,
      provenance: { authoredBy: 'operator:data-governance', approvedBy: 'operator:security' },
      actionClass: 'export',
      resourceClass: 'customer_dataset',
      parameters: [
        { dimension: 'exportFormat', required: true },
        { dimension: 'recordCount', required: true },
      ],
      materialFacts: ['exportDestination.approved', 'dataResidency.compliant'],
      relevantPolicies: ['core08-policy'],
    },
  ],
};

export const TRUSTED_CONTEXT = {
  maxFutureSkewSeconds: 0,
  sources: [
    { sourceId: 'erp-payables', kind: 'erp', name: 'ERP payables', trustClass: 'authoritative', organizationId: ORG, attests: [{ factClass: 'invoice.approved', maxAgeSeconds: 900 }] },
    { sourceId: 'payee-registry', kind: 'external_api', name: 'Payee registry', trustClass: 'authoritative', organizationId: ORG, attests: [{ factClass: 'payee.approved', maxAgeSeconds: 900 }] },
    { sourceId: 'change-calendar', kind: 'internal_store', name: 'Change calendar', trustClass: 'authoritative', organizationId: ORG, attests: [{ factClass: 'changeWindow.open', maxAgeSeconds: 900 }] },
    { sourceId: 'release-controller', kind: 'internal_store', name: 'Release controller', trustClass: 'authoritative', organizationId: ORG, attests: [{ factClass: 'rollback.available', maxAgeSeconds: 900 }] },
    { sourceId: 'support-desk', kind: 'crm', name: 'Support desk', trustClass: 'authoritative', organizationId: ORG, attests: [{ factClass: 'supportCase.open', maxAgeSeconds: 900 }] },
    { sourceId: 'dlp-gateway', kind: 'internal_store', name: 'DLP gateway', trustClass: 'authoritative', organizationId: ORG, attests: [{ factClass: 'exportDestination.approved', maxAgeSeconds: 900 }, { factClass: 'dataResidency.compliant', maxAgeSeconds: 900 }] },
  ],
} as const;

// --- the organization's policy: data over generic predicates -------------

const factIs = (factClass: string, value: unknown): PolicyCondition => ({ type: 'predicate', field: 'contextFact', factClass, operator: 'equals', value });
const classIs = (value: string): PolicyCondition => ({ type: 'predicate', field: 'actionClass', operator: 'equals', value });
const parameter = (parameterId: string, operator: PolicyPredicateCondition['operator'], value: unknown): PolicyCondition => ({ type: 'predicate', field: 'parameter', parameterId, operator, value });
const all = (...conditions: PolicyCondition[]): PolicyCondition => ({ type: 'group', operator: 'all', conditions });
const deny = (reasonCode: string, reason: string): PolicyPackRule['effect'] => ({ type: 'deny', reasonCode, reason });

export const RULES: readonly PolicyPackRule[] = [
  // Treasury
  rule('transfer-invoice-approved', all(classIs('transfer'), factIs('invoice.approved', false)), deny('TREASURY_INVOICE_NOT_APPROVED', 'The ERP does not attest an approved invoice.')),
  rule('transfer-payee-approved', all(classIs('transfer'), factIs('payee.approved', false)), deny('TREASURY_PAYEE_NOT_APPROVED', 'The payee is not approved.')),
  // DevOps
  rule('deploy-change-window', all(classIs('deploy'), factIs('changeWindow.open', false)), deny('DEPLOY_OUTSIDE_CHANGE_WINDOW', 'No change window is open.')),
  rule('deploy-rollback', all(classIs('deploy'), factIs('rollback.available', false)), deny('DEPLOY_WITHOUT_ROLLBACK', 'Rollback is not available.')),
  rule('deploy-scale', all(classIs('deploy'), parameter('replicaCount', 'greater_than', 10)), deny('DEPLOY_SCALE_EXCEEDS_POLICY', 'At most 10 replicas.')),
  rule('deploy-strategy', all(classIs('deploy'), parameter('deploymentStrategy', 'not_in', ['rolling', 'blue-green'])), deny('DEPLOY_STRATEGY_NOT_PERMITTED', 'Only rolling or blue-green.')),
  // Data: the same resource, governed differently by action class.
  rule('read-support-case', all(classIs('read'), factIs('supportCase.open', false)), deny('READ_WITHOUT_SUPPORT_CASE', 'A read needs an open support case.')),
  rule('read-volume', all(classIs('read'), parameter('recordCount', 'greater_than', 1000)), deny('READ_VOLUME_EXCEEDS_POLICY', 'A read may disclose at most 1000 records.')),
  rule('export-destination', all(classIs('export'), factIs('exportDestination.approved', false)), deny('EXPORT_DESTINATION_UNAPPROVED', 'An export needs an approved destination.')),
  rule('export-residency', all(classIs('export'), factIs('dataResidency.compliant', false)), deny('EXPORT_RESIDENCY_UNCONFIRMED', 'An export needs confirmed residency.')),
  rule('export-volume', all(classIs('export'), parameter('recordCount', 'greater_than', 100)), deny('EXPORT_VOLUME_EXCEEDS_POLICY', 'An export may move at most 100 records.')),
  rule('export-format', all(classIs('export'), parameter('exportFormat', 'not_in', ['csv'])), deny('EXPORT_FORMAT_NOT_PERMITTED', 'Exports are CSV only.')),
];

/** One policy runtime for every domain; each evaluation it performs is observed, never altered. */
export interface ObservedPolicy {
  readonly provider: PolicyPackProvider;
  readonly evaluated: EnforcementPolicyPackEvaluationInput[];
}

export function observedPolicy(rules: readonly PolicyPackRule[] = RULES): ObservedPolicy {
  const runtime = createPolicyPackRuntime(createPolicyPackRuntimeContext('2026-01-01T00:00:00.000Z'));
  runtime.registerPolicyPack(POLICY_WRITER, { id: 'core08-policy', name: 'CORE-08 reference policy', description: 'Synthetic', kind: 'data_boundary', domain: 'general_enterprise' });
  runtime.registerPolicyPackVersion(POLICY_WRITER, {
    id: 'policy-pack-core08-v1',
    policyPackId: 'core08-policy',
    version: '1.0.0',
    scope: { resourceScopes: RESOURCES },
    rules: rules.map((entry) => ({ ...entry, policyPackVersionId: 'policy-pack-core08-v1', sourceIds: ['core08-source'] })),
    sources: [{ id: 'core08-source', type: 'internal_control', title: 'Synthetic', description: 'Synthetic', authority: 'demo_only' }],
    effectiveFrom: '2026-01-01T00:00:00.000Z',
    demoOnly: true,
    legalCompleteness: 'not_legal_advice',
  });
  runtime.activatePolicyPackVersion(POLICY_WRITER, 'policy-pack-core08-v1');
  const inner = createActionEnforcementPolicyPackIntegration(runtime);
  const evaluated: EnforcementPolicyPackEvaluationInput[] = [];
  return {
    evaluated,
    provider: {
      evaluatePolicyForEnforcement(input) {
        evaluated.push(input);
        return inner.evaluatePolicyForEnforcement(input);
      },
    },
  };
}

// --- trusted-context worlds ------------------------------------------------

export const TREASURY_WORLD: readonly Reading[] = [
  { key: 'invoice.approved', value: true, sourceId: 'erp-payables' },
  { key: 'payee.approved', value: true, sourceId: 'payee-registry' },
];
export const DEVOPS_WORLD: readonly Reading[] = [
  { key: 'changeWindow.open', value: true, sourceId: 'change-calendar' },
  { key: 'rollback.available', value: true, sourceId: 'release-controller' },
];
export const READ_WORLD: readonly Reading[] = [{ key: 'supportCase.open', value: true, sourceId: 'support-desk' }];
export const EXPORT_WORLD: readonly Reading[] = [
  { key: 'exportDestination.approved', value: true, sourceId: 'dlp-gateway' },
  { key: 'dataResidency.compliant', value: true, sourceId: 'dlp-gateway' },
];
/** Every domain's facts at once: the Host is one world, not three. */
export const EVERY_WORLD: readonly Reading[] = [...TREASURY_WORLD, ...DEVOPS_WORLD, ...READ_WORLD, ...EXPORT_WORLD];

export const without = (world: readonly Reading[], key: string): readonly Reading[] => world.filter((reading) => reading.key !== key);
export const withFact = (world: readonly Reading[], key: string, value: string | number | boolean): readonly Reading[] => world.map((reading) => (reading.key === key ? { ...reading, value } : reading));

// --- intents ---------------------------------------------------------------

export const transfer = (value = '250', currency = 'USD', counterparty = PAYEE) => ({ action: TRANSFER, resource: TREASURY_ACCOUNT, counterparty, amount: { value, currency } });
export const deploy = (replicaCount: unknown = 4, deploymentStrategy: unknown = 'rolling') => ({ action: DEPLOY, resource: CLUSTER, parameters: { replicaCount, deploymentStrategy } });
export const read = (recordCount: unknown = 25, resource = CUSTOMER_RECORDS) => ({ action: READ, resource, parameters: { recordCount } });
export const exportRecords = (recordCount: unknown = 40, exportFormat: unknown = 'csv', resource = CUSTOMER_RECORDS) => ({ action: EXPORT, resource, parameters: { exportFormat, recordCount } });

// --- three Generic HTTP adapter configurations ----------------------------

export const TREASURY_TOKEN = 'Core08TreasuryBearerSentinel0123456789';
export const DEVOPS_KEY = 'core08-devops-key-sentinel-3b7c';
export const DATA_TOKEN = 'Core08DataBearerSentinel9876543210';

export const ADAPTER_OPTIONS: Readonly<Record<(typeof ADAPTER_IDS)[number], EnterpriseGenericHttpExecutionAdapterOptions>> = {
  [TREASURY_HTTP]: {
    adapterId: TREASURY_HTTP,
    origin: 'https://payments.treasury-bank.example',
    method: 'POST',
    path: [
      { kind: 'literal', value: 'v1' },
      { kind: 'literal', value: 'transfers' },
    ],
    headers: { 'Idempotency-Key': { kind: 'source', source: 'correlation.executionId' } },
    body: {
      kind: 'json-object',
      fields: {
        account: { kind: 'source', source: 'resource' },
        payee: { kind: 'source', source: 'counterparty' },
        amount: { kind: 'source', source: 'amount.value' },
        currency: { kind: 'source', source: 'amount.unit' },
        requestId: { kind: 'source', source: 'correlation.requestId' },
      },
    },
    credential: { kind: 'bearer', token: TREASURY_TOKEN },
    providerRefHeader: 'x-transfer-id',
  },
  [DEVOPS_HTTP]: {
    adapterId: DEVOPS_HTTP,
    origin: 'https://deploy.platform.example',
    method: 'PATCH',
    path: [
      { kind: 'literal', value: 'deployments' },
      { kind: 'source', source: 'resource' },
    ],
    query: { strategy: { kind: 'parameter', dimension: 'deploymentStrategy' } },
    headers: { 'X-Replica-Count': { kind: 'parameter', dimension: 'replicaCount' } },
    body: {
      kind: 'json-object',
      fields: {
        strategy: { kind: 'parameter', dimension: 'deploymentStrategy' },
        replicas: { kind: 'parameter', dimension: 'replicaCount' },
        requestId: { kind: 'source', source: 'correlation.requestId' },
      },
    },
    credential: { kind: 'header', name: 'X-Deploy-Key', value: DEVOPS_KEY },
    providerRefHeader: 'x-rollout-id',
  },
  [DATA_HTTP]: {
    adapterId: DATA_HTTP,
    origin: 'https://records.data-platform.example',
    method: 'POST',
    path: [
      { kind: 'literal', value: 'v1' },
      { kind: 'literal', value: 'datasets' },
      { kind: 'source', source: 'resource' },
      { kind: 'literal', value: 'jobs' },
    ],
    query: { limit: { kind: 'parameter', dimension: 'recordCount' } },
    body: {
      kind: 'json-object',
      fields: {
        operation: { kind: 'source', source: 'action' },
        limit: { kind: 'parameter', dimension: 'recordCount' },
        // Optional at the adapter: a read carries no format. The export
        // profile still *requires* one — that is enforced before any decision.
        format: { kind: 'parameter', dimension: 'exportFormat', required: false },
        requestId: { kind: 'source', source: 'correlation.requestId' },
      },
    },
    credential: { kind: 'bearer', token: DATA_TOKEN },
    providerRefHeader: 'x-job-id',
  },
};

export const ROUTES = [
  { action: TRANSFER, adapterId: TREASURY_HTTP },
  { action: DEPLOY, adapterId: DEVOPS_HTTP },
  { action: READ, adapterId: DATA_HTTP },
  { action: EXPORT, adapterId: DATA_HTTP },
];

// --- the deterministic fake provider behind the real adapter core ---------

export const PUBLIC_ADDRESS: GenericHttpResolvedAddress = { address: '93.184.216.34', family: 4 };

export interface WireRecord {
  readonly adapterId: string;
  readonly hostname: string;
  readonly address: GenericHttpResolvedAddress;
  readonly request: GenericHttpWireRequest;
}

/** Records what each real Generic HTTP adapter core was handed and what it put on the (fake) wire. */
export interface ProviderRecorder {
  /** Every `ValidatedExecutionAction` an adapter received, in order, with the adapter that received it. */
  readonly actions: { readonly adapterId: string; readonly action: ValidatedExecutionAction }[];
  readonly wire: WireRecord[];
  readonly adapters: readonly ExecutionAdapter[];
  callsTo(adapterId: string): number;
}

function fakeRuntime(adapterId: string, wire: WireRecord[]): GenericHttpNetworkRuntime {
  return {
    async resolve() {
      return { kind: 'resolved', answers: [PUBLIC_ADDRESS] };
    },
    async send(request, address) {
      wire.push({ adapterId, hostname: request.hostname, address, request });
      return { kind: 'response', status: 200, providerRefValues: [`${adapterId}-ref-${wire.length}`] };
    },
  };
}

export function createProviderRecorder(): ProviderRecorder {
  const actions: ProviderRecorder['actions'] = [];
  const wire: WireRecord[] = [];
  const adapters = ADAPTER_IDS.map((adapterId): ExecutionAdapter => {
    const core = createGenericHttpExecutionAdapterCore(snapshotGenericHttpOptions(ADAPTER_OPTIONS[adapterId]), fakeRuntime(adapterId, wire));
    return {
      adapterId,
      async execute(action) {
        actions.push({ adapterId, action });
        return core.execute(action);
      },
    };
  });
  return {
    actions,
    wire,
    adapters,
    callsTo: (adapterId) => actions.filter((entry) => entry.adapterId === adapterId).length,
  };
}

// --- the Host --------------------------------------------------------------

export function referenceFile(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    trustDomainId: TRUST_DOMAIN,
    grantLifetimeSeconds: 3600,
    customerPrincipals: [{ principalId: 'principal-agent', externalSubject: AGENT_SUBJECT, apiKeyEnv: 'FRONTERA_TEST_AGENT_KEY' }],
    administrators: [{ operatorId: 'ops-primary', apiKeyEnv: 'FRONTERA_TEST_ADMIN_KEY' }],
    monetary: { assets: [{ assetId: 'USD', scale: 2 }, { assetId: 'EUR', scale: 2 }], financialActions: [TRANSFER] },
    governance: GOVERNANCE,
    trustedContext: TRUSTED_CONTEXT,
    routes: ROUTES,
    ...overrides,
  };
}

export interface ReferenceHost {
  readonly host: EnterpriseHost;
  readonly baseUrl: string;
  readonly provider: ProviderRecorder;
  readonly context: ContextTable;
  readonly policy: ObservedPolicy;
  readonly dir: string;
}

export async function bootReferenceHost(workspace: Workspace): Promise<ReferenceHost> {
  const dir = workspace.dir();
  const provider = createProviderRecorder();
  const context = createContextTable();
  const policy = observedPolicy();
  const host = workspace.track(
    await bootEnterpriseHost({
      env: await withDeploymentWitness(secureEnv(dir, referenceFile())),
      executionAdapters: provider.adapters,
      contextProvider: context.provider,
      policyPackProvider: policy.provider,
    }),
  );
  const { port } = await host.listen();
  await provisionReferenceAuthority(host);
  return { host, baseUrl: `http://127.0.0.1:${port}`, provider, context, policy, dir };
}

const TREASURY_CONSTRAINTS: readonly AuthorityConstraint[] = [
  { type: 'max_amount', currency: 'USD', value: TREASURY_CEILING },
  { type: 'spending_limit', limitId: 'treasury-lifetime', currency: 'USD', maximum: '100000', window: { kind: 'lifetime' } },
];

/**
 * One owner, one agent, and **one authority lineage per domain** — exactly the
 * action × resource pairs each domain needs, and nothing across them. The
 * treasury lineage alone carries the P10 per-execution ceiling and spending
 * limit. Cross-domain combinations (deploy over customer data, read over the
 * cluster) are therefore authorized by nothing.
 */
export const LINEAGES = [
  { id: 'treasury', actions: [TRANSFER], resources: [TREASURY_ACCOUNT], constraints: TREASURY_CONSTRAINTS },
  { id: 'devops', actions: [DEPLOY], resources: [CLUSTER] },
  { id: 'data', actions: [READ, EXPORT], resources: [CUSTOMER_RECORDS, OTHER_RECORDS] },
] as const;

export async function provisionReferenceAuthority(host: EnterpriseHost): Promise<void> {
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
  await service.provisionCapabilityToken(operator, { ...payloads.capabilityToken, capabilityTokenId: `cap-${AGENT}`, subjectActorId: AGENT, principalActorId: OWNER, issuerActorId: OWNER, actions: ACTIONS, resourceScopes: RESOURCES });
  for (const lineage of LINEAGES) {
    await service.provisionAuthorityGrant(operator, {
      ...payloads.authorityGrant,
      authorityGrantId: `authority-grant-${lineage.id}`,
      subjectActorId: OWNER,
      actions: [...lineage.actions],
      resourceScopes: [...lineage.resources],
      ...('constraints' in lineage ? { constraints: lineage.constraints } : {}),
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
