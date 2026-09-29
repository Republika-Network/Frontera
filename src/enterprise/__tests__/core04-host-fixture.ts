import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

import Database from 'better-sqlite3';
import { join } from 'node:path';

import { contextObservationProvenanceDigest, type ContextFactObservation } from '../../features/context-resolution-runtime/index.js';
import { createActionEnforcementPolicyPackIntegration } from '../../features/domain-policy-pack-runtime/integrations/action-enforcement-policy-pack-integration.js';
import type { PolicyCondition, PolicyPredicateCondition } from '../../features/domain-policy-pack-runtime/domain/policy-pack-condition.js';
import type { PolicyPackRule } from '../../features/domain-policy-pack-runtime/domain/policy-pack-rule.js';
import { createPolicyPackRuntimeContext } from '../../features/domain-policy-pack-runtime/runtime/policy-pack-runtime-context.js';
import { createPolicyPackRuntime } from '../../features/domain-policy-pack-runtime/services/policy-pack-runtime.js';
import type { ExecutionAdapter, ValidatedExecutionAction } from '../../features/execution-runtime/index.js';
import type { ContextResolutionQuery } from '../../features/context-resolution-runtime/index.js';
import type { BoundedGrant } from '../../features/grant-runtime/index.js';
import type { ContextProvider, PolicyPackProvider } from '../../kernel/index.js';
import type { GovernanceConfiguration } from '../governance-profile/index.js';
import { toKernelEvaluationResult } from '../governance-store/store-common.js';
import { bootEnterpriseHost, type EnterpriseHost } from '../host/enterprise-host.js';
import { buildDurableAuthorityPayloads, DURABLE_FIXTURE_OPERATOR } from '../kernel-authority/fixtures/durable-authority.fixture.js';
import { authorityAuthenticityEnv } from './authority-authenticity-fixture.js';

/**
 * CORE-04 — one synthetic organization on the **canonical shipped Host**
 * (`bootEnterpriseHost()`, `production` secure profile, SQLite everywhere,
 * Ed25519-signed grants, a real loopback listener).
 *
 * Everything CORE-04 adds reaches the Host through its canonical inputs only:
 *
 * - the governed-action file declares Governance Profiles (material facts,
 *   restrict-only facts, obligations), the **trusted source registry** and the
 *   **obligation discharge sources** — strictly parsed, refused at startup when
 *   malformed;
 * - the **context provider** (retrieval) and the **policy** are trusted
 *   in-process composition (`BootEnterpriseHostOptions`), exactly as execution
 *   adapters are. The provider here is a deterministic local table — no ERP, no
 *   network, no model — because what is proven is the trust boundary, not a
 *   connector.
 *
 * Three domains share the one Host, the one Kernel and the one policy:
 *
 * - **Payables:** `settle-invoice` × payables ledger — material facts
 *   `invoice.exists`, `invoice.amount`, `destination.registered` (two different
 *   systems of record), and one restrict-only fact `signal.thresholdCircumvention`
 *   from a configured deterministic risk source.
 * - **Data:** `read` vs `export` × customer data — the same resource needing
 *   different admitted facts per action.
 * - **Change:** `deploy-release` × production — a blocking obligation.
 *
 * Synthetic identifiers only.
 */

export const ORG = 'org-core04';
export const TRUST_DOMAIN = 'trust-domain-core04';
export const OWNER = 'actor-owner';
export const AGENT = 'actor-agent';
export const AGENT_SUBJECT = { system: 'core04-app', subjectId: 'agent-1' } as const;
export const ADAPTER_ID = 'test.recording';
export const AGENT_KEY = 'FRONTERA_CORE04_AGENT_KEY_SENTINEL_4c19e2';
export const LEGACY_KEY = 'FRONTERA_CORE04_LEGACY_KEY_SENTINEL_7a0d31';
export const ADMIN_KEY = 'FRONTERA_CORE04_ADMIN_KEY_SENTINEL_2b8e4f6a1c9d0e73';

export const SETTLE = 'settle-invoice';
export const PAYABLES = 'payables-ledger';
export const READ = 'read-customer-records';
export const EXPORT = 'export-customer-records';
export const CUSTOMER_DATA = 'customer-data-example';
export const DEPLOY = 'deploy-release';
export const PRODUCTION = 'production-environment-example';
export const ACTIONS = [SETTLE, READ, EXPORT, DEPLOY];
export const RESOURCES = [PAYABLES, CUSTOMER_DATA, PRODUCTION];

export const RISK_SIGNAL = 'signal.thresholdCircumvention';

export const GOVERNANCE: GovernanceConfiguration = {
  parameterDimensions: [
    { id: 'invoiceTotal', type: 'integer', bound: 'exact' },
    { id: 'destination', type: 'token', bound: 'exact' },
    { id: 'recordCount', type: 'integer', bound: 'maximum' },
    { id: 'releaseVersion', type: 'token', bound: 'exact' },
  ],
  actionClasses: [
    { id: 'settle', actions: [SETTLE] },
    { id: 'read', actions: [READ] },
    { id: 'export', actions: [EXPORT] },
    { id: 'deploy', actions: [DEPLOY] },
  ],
  resourceClasses: [
    { id: 'payables_ledger', resources: [PAYABLES] },
    { id: 'customer_dataset', resources: [CUSTOMER_DATA] },
    { id: 'production_environment', resources: [PRODUCTION] },
  ],
  profiles: [
    {
      profileId: 'invoice-settlement',
      version: 1,
      owner: ORG,
      provenance: { authoredBy: 'operator:finance-ops', approvedBy: 'operator:security' },
      actionClass: 'settle',
      resourceClass: 'payables_ledger',
      parameters: [
        { dimension: 'destination', required: true },
        { dimension: 'invoiceTotal', required: true },
      ],
      materialFacts: ['invoice.exists', 'invoice.amount', 'destination.registered'],
      restrictiveFacts: [RISK_SIGNAL],
      relevantPolicies: ['core04-policy'],
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
      relevantPolicies: ['core04-policy'],
    },
    {
      profileId: 'customer-data-export',
      version: 1,
      owner: ORG,
      provenance: { authoredBy: 'operator:data-governance', approvedBy: 'operator:security' },
      actionClass: 'export',
      resourceClass: 'customer_dataset',
      parameters: [{ dimension: 'recordCount', required: true }],
      materialFacts: ['exportDestination.approved', 'dataResidency.compliant'],
      relevantPolicies: ['core04-policy'],
    },
    {
      profileId: 'production-deploy',
      version: 1,
      owner: ORG,
      provenance: { authoredBy: 'operator:platform', approvedBy: 'operator:security' },
      actionClass: 'deploy',
      resourceClass: 'production_environment',
      parameters: [{ dimension: 'releaseVersion', required: true }],
      materialFacts: [],
      obligations: [{ obligationType: 'change.approval', blocking: true }],
      relevantPolicies: ['core04-policy'],
    },
  ],
};

export const TRUSTED_CONTEXT = {
  maxFutureSkewSeconds: 0,
  sources: [
    { sourceId: 'erp-primary', kind: 'erp', name: 'ERP (primary)', trustClass: 'authoritative', organizationId: ORG, attests: [{ factClass: 'invoice.exists', maxAgeSeconds: 900 }, { factClass: 'invoice.amount', maxAgeSeconds: 900 }] },
    { sourceId: 'erp-secondary', kind: 'erp', name: 'ERP (secondary)', trustClass: 'authoritative', organizationId: ORG, attests: [{ factClass: 'invoice.exists', maxAgeSeconds: 900 }] },
    { sourceId: 'wallet-registry', kind: 'external_api', name: 'Destination registry', trustClass: 'authoritative', organizationId: ORG, attests: [{ factClass: 'destination.registered', maxAgeSeconds: 900 }] },
    { sourceId: 'support-desk', kind: 'crm', name: 'Support desk', trustClass: 'authoritative', organizationId: ORG, attests: [{ factClass: 'supportCase.open', maxAgeSeconds: 900 }] },
    { sourceId: 'dlp-gateway', kind: 'internal_store', name: 'DLP gateway', trustClass: 'authoritative', organizationId: ORG, attests: [{ factClass: 'exportDestination.approved', maxAgeSeconds: 900 }, { factClass: 'dataResidency.compliant', maxAgeSeconds: 900 }] },
    { sourceId: 'configured-risk-source', kind: 'risk_engine', name: 'Deterministic signal source', trustClass: 'authoritative', organizationId: ORG, attests: [{ factClass: RISK_SIGNAL, maxAgeSeconds: 300 }] },
    { sourceId: 'configured-risk-source-2', kind: 'risk_engine', name: 'Second signal source', trustClass: 'authoritative', organizationId: ORG, attests: [{ factClass: RISK_SIGNAL, maxAgeSeconds: 300 }] },
  ],
} as const;

export const OBLIGATIONS = {
  sources: [
    { sourceId: 'change-approvals', kind: 'approval_runtime', name: 'Change approval board', verificationClass: 'independent' },
    { sourceId: 'ticket-notes', kind: 'internal_store', name: 'Ticket notes', verificationClass: 'self_reported' },
  ],
} as const;

// ---------------------------------------------------------------------------
// The organization's deterministic policy — data, not code. Every rule reads
// trusted context only through the typed predicates. A rule reacts to an
// admitted `false`; a *missing* required fact never reaches policy as
// anything, and is the Trusted Context Boundary's denial.

export const POLICY_WRITER = { system: true, actorId: 'operator:policy-core04' } as const;
const VERSION_ID = 'policy-pack-core04-v1';

const factIs = (factClass: string, operator: PolicyPredicateCondition['operator'], value: unknown): PolicyCondition => ({ type: 'predicate', field: 'contextFact', factClass, operator, value });
const actionClassIs = (value: string): PolicyCondition => ({ type: 'predicate', field: 'actionClass', operator: 'equals', value });
const all = (...conditions: PolicyCondition[]): PolicyCondition => ({ type: 'group', operator: 'all', conditions });

export function rule(id: string, condition: PolicyCondition, effect: PolicyPackRule['effect'], priority = 100): PolicyPackRule {
  return { id, policyPackVersionId: VERSION_ID, name: id, description: id, status: 'active', priority, condition, effect, obligations: [], evidenceRequirements: [], approvalRequirements: [], severity: 'error', sourceIds: ['core04-source'] };
}

export const RULES: readonly PolicyPackRule[] = [
  rule('invoice-must-exist', all(actionClassIs('settle'), factIs('invoice.exists', 'equals', false)), { type: 'deny', reasonCode: 'INVOICE_NOT_FOUND', reason: 'The ERP does not attest the invoice.' }),
  rule(
    'amount-must-match-invoice',
    all(actionClassIs('settle'), { type: 'predicate', field: 'parameter', parameterId: 'invoiceTotal', operator: 'not_equals', valueFrom: { field: 'contextFact', factClass: 'invoice.amount' } }),
    { type: 'deny', reasonCode: 'INVOICE_AMOUNT_MISMATCH', reason: 'The proposed total differs from the attested invoice amount.' },
  ),
  rule('destination-must-be-registered', all(actionClassIs('settle'), factIs('destination.registered', 'equals', false)), { type: 'deny', reasonCode: 'DESTINATION_NOT_REGISTERED', reason: 'The destination is not registered.' }),
  rule('signal-high-denies', { type: 'predicate', field: 'restrictiveFact', factClass: RISK_SIGNAL, operator: 'equals', value: 'high' }, { type: 'deny', reasonCode: 'RESTRICTIVE_SIGNAL_HIGH', reason: 'An admitted high-severity signal restricts this action.' }),
  rule('signal-elevated-requires-review', { type: 'predicate', field: 'restrictiveFact', factClass: RISK_SIGNAL, operator: 'equals', value: 'elevated' }, { type: 'require_approval', reasonCode: 'RESTRICTIVE_SIGNAL_REVIEW', reason: 'An admitted elevated signal requires review.' }),
  rule('read-needs-open-case', all(actionClassIs('read'), factIs('supportCase.open', 'equals', false)), { type: 'deny', reasonCode: 'READ_WITHOUT_SUPPORT_CASE', reason: 'A read needs an open support case.' }),
  rule('export-needs-approved-destination', all(actionClassIs('export'), factIs('exportDestination.approved', 'equals', false)), { type: 'deny', reasonCode: 'EXPORT_DESTINATION_UNAPPROVED', reason: 'An export needs an approved destination.' }),
  rule('export-needs-residency', all(actionClassIs('export'), factIs('dataResidency.compliant', 'equals', false)), { type: 'deny', reasonCode: 'EXPORT_RESIDENCY_UNCONFIRMED', reason: 'An export needs confirmed data residency.' }),
];

export function policyPackProvider(rules: readonly PolicyPackRule[] = RULES): PolicyPackProvider {
  const runtime = createPolicyPackRuntime(createPolicyPackRuntimeContext('2026-01-01T00:00:00.000Z'));
  runtime.registerPolicyPack(POLICY_WRITER, { id: 'core04-policy', name: 'CORE-04 proof policy', description: 'Synthetic', kind: 'data_boundary', domain: 'general_enterprise' });
  runtime.registerPolicyPackVersion(POLICY_WRITER, {
    id: VERSION_ID,
    policyPackId: 'core04-policy',
    version: '1.0.0',
    scope: { resourceScopes: RESOURCES },
    rules,
    sources: [{ id: 'core04-source', type: 'internal_control', title: 'Synthetic', description: 'Synthetic', authority: 'demo_only' }],
    effectiveFrom: '2026-01-01T00:00:00.000Z',
    demoOnly: true,
    legalCompleteness: 'not_legal_advice',
  });
  runtime.activatePolicyPackVersion(POLICY_WRITER, VERSION_ID);
  return createActionEnforcementPolicyPackIntegration(runtime);
}

// ---------------------------------------------------------------------------
// The candidate-context side: a deterministic table a test fills per request.
// The provider is retrieval only — every reading it returns crosses the
// Trusted Context Boundary like any other.

export interface Reading {
  readonly key: string;
  readonly value: string | number | boolean;
  readonly sourceId: string;
  /** Seconds before the resolution instant. Negative is the future. */
  readonly ageSeconds?: number;
  readonly reference?: string;
  readonly organizationId?: string;
  /** Tamper a field *after* the provenance digest was taken. */
  readonly tamper?: Partial<ContextFactObservation>;
}

export interface ContextTable {
  readonly provider: ContextProvider;
  /** What the provider will answer next, replacing any earlier table. */
  set(readings: readonly Reading[]): void;
  readonly queries: ContextResolutionQuery[];
}

export function createContextTable(): ContextTable {
  let table: readonly Reading[] = [];
  const queries: ContextResolutionQuery[] = [];
  return {
    queries,
    set(readings) {
      table = readings;
    },
    provider: {
      resolveContext(query) {
        queries.push(query);
        const observations = table
          .filter((entry) => query.keys.includes(entry.key))
          .map((entry): ContextFactObservation => {
            const observedAt = new Date(Date.parse(query.at) - (entry.ageSeconds ?? 5) * 1000).toISOString();
            const base = {
              key: entry.key,
              value: entry.value,
              sourceId: entry.sourceId,
              observedAt,
              reference: entry.reference ?? `${entry.sourceId}:${entry.key}:${String(entry.value)}`,
              ...(entry.organizationId !== undefined ? { organizationId: entry.organizationId } : {}),
            };
            return { ...base, provenanceDigest: contextObservationProvenanceDigest(base), ...(entry.tamper ?? {}) };
          });
        return Promise.resolve({ observations });
      },
    },
  };
}

/** The fully attested, fresh payables world: invoice 500 exists, destination registered. */
export const PAYABLES_WORLD: readonly Reading[] = [
  { key: 'invoice.exists', value: true, sourceId: 'erp-primary' },
  { key: 'invoice.amount', value: 500, sourceId: 'erp-primary' },
  { key: 'destination.registered', value: true, sourceId: 'wallet-registry' },
];

// ---------------------------------------------------------------------------
// The Host.

export function governedFile(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    trustDomainId: TRUST_DOMAIN,
    grantLifetimeSeconds: 3600,
    customerPrincipals: [{ principalId: 'principal-agent', externalSubject: AGENT_SUBJECT, apiKeyEnv: 'FRONTERA_TEST_AGENT_KEY' }],
    administrators: [{ operatorId: 'ops-primary', apiKeyEnv: 'FRONTERA_TEST_ADMIN_KEY' }],
    governance: GOVERNANCE,
    trustedContext: TRUSTED_CONTEXT,
    obligations: OBLIGATIONS,
    routes: ACTIONS.map((action) => ({ action, adapterId: ADAPTER_ID })),
    ...overrides,
  };
}

export class Workspace {
  private readonly directories: string[] = [];
  private readonly hosts: EnterpriseHost[] = [];

  dir(): string {
    const directory = mkdtempSync(join(tmpdir(), 'frontera-core04-'));
    this.directories.push(directory);
    return directory;
  }

  track(host: EnterpriseHost): EnterpriseHost {
    this.hosts.push(host);
    return host;
  }

  async cleanup(): Promise<void> {
    for (const host of this.hosts) await host.close().catch(() => {});
    for (const directory of this.directories) rmSync(directory, { recursive: true, force: true });
  }
}

export function secureEnv(dir: string, file: Record<string, unknown> = governedFile()): Record<string, string | undefined> {
  const filePath = join(dir, 'governed-actions.json');
  writeFileSync(filePath, JSON.stringify(file));
  return {
    AOC_ENTERPRISE_ENV: 'production',
    AOC_ENTERPRISE_PERSISTENCE_PROVIDER: 'sqlite',
    AOC_ENTERPRISE_REQUIRE_AUTH: 'true',
    AOC_ENTERPRISE_API_KEYS: `${LEGACY_KEY}:${ORG}`,
    AOC_ENTERPRISE_HTTP_HOST: '127.0.0.1',
    AOC_ENTERPRISE_HTTP_PORT: '0',
    AOC_ENTERPRISE_LOG_LEVEL: 'error',
    AOC_ENTERPRISE_KERNEL_AUTHORITY_ENABLED: 'true',
    AOC_ENTERPRISE_KERNEL_AUTHORITY_ORGANIZATION_ID: ORG,
    AOC_ENTERPRISE_SQLITE_PATH: join(dir, 'governance.sqlite'),
    AOC_ENTERPRISE_PASSPORT_SQLITE_PATH: join(dir, 'passport.sqlite'),
    AOC_ENTERPRISE_ASSURANCE_SQLITE_PATH: join(dir, 'assurance.sqlite'),
    AOC_ENTERPRISE_KERNEL_AUTHORITY_SQLITE_PATH: join(dir, 'kernel-authority.sqlite'),
    AOC_ENTERPRISE_BOUNDED_GRANT_SQLITE_PATH: join(dir, 'bounded-grants.sqlite'),
    AOC_ENTERPRISE_EMERGENCY_CONTROL_SQLITE_PATH: join(dir, 'emergency-controls.sqlite'),
    AOC_ENTERPRISE_EXERCISE_LEDGER_SQLITE_PATH: join(dir, 'exercise-ledger.sqlite'),
    AOC_ENTERPRISE_AUTHORITY_EVENT_STREAM_SQLITE_PATH: join(dir, 'authority-event-stream.sqlite'),
    AOC_ENTERPRISE_EXECUTION_OUTCOME_SQLITE_PATH: join(dir, 'execution-outcomes.sqlite'),
    AOC_ENTERPRISE_EXECUTION_RESOLUTION_SQLITE_PATH: join(dir, 'execution-resolutions.sqlite'),
    AOC_ENTERPRISE_OBLIGATION_DISCHARGE_SQLITE_PATH: join(dir, 'obligation-discharges.sqlite'),
    AOC_ENTERPRISE_APPROVAL_SQLITE_PATH: join(dir, 'approvals.sqlite'),
    ...authorityAuthenticityEnv(),
    AOC_ENTERPRISE_GOVERNED_ACTIONS_FILE: filePath,
    FRONTERA_TEST_AGENT_KEY: AGENT_KEY,
    FRONTERA_TEST_ADMIN_KEY: ADMIN_KEY,
  };
}

export interface Booted {
  readonly host: EnterpriseHost;
  readonly calls: ValidatedExecutionAction[];
  readonly baseUrl: string;
}

export async function boot(workspace: Workspace, env: Record<string, string | undefined>, options: { readonly context?: ContextTable; readonly policy?: PolicyPackProvider | null } = {}): Promise<Booted> {
  const calls: ValidatedExecutionAction[] = [];
  const adapter: ExecutionAdapter = {
    adapterId: ADAPTER_ID,
    async execute(action) {
      calls.push(action);
      return { outcome: 'completed', providerRef: `provider-ref-${calls.length}` };
    },
  };
  const host = workspace.track(
    await bootEnterpriseHost({
      env,
      executionAdapters: [adapter],
      ...(options.context !== undefined ? { contextProvider: options.context.provider } : {}),
      ...(options.policy === null ? {} : { policyPackProvider: options.policy ?? policyPackProvider() }),
    }),
  );
  const { port } = await host.listen();
  return { host, calls, baseUrl: `http://127.0.0.1:${port}` };
}

export async function provision(host: EnterpriseHost): Promise<void> {
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
  await service.provisionAuthorityGrant(operator, { ...payloads.authorityGrant, authorityGrantId: 'authority-grant-owner', subjectActorId: OWNER, actions: ACTIONS, resourceScopes: RESOURCES });
  await service.provisionDelegationGrant(operator, {
    ...payloads.delegationGrant,
    delegationGrantId: 'delegation-agent',
    delegatorActorId: OWNER,
    delegateActorId: AGENT,
    sourceAuthorityGrantId: 'authority-grant-owner',
    actions: ACTIONS,
    resourceScopes: RESOURCES,
  });
}

export interface Reply {
  readonly status: number;
  readonly text: string;
  readonly body: Record<string, unknown>;
}

export async function call(baseUrl: string, method: string, path: string, options: { readonly authorization?: string; readonly body?: unknown; readonly rawBody?: string } = {}): Promise<Reply> {
  const headers: Record<string, string> = { ...(options.authorization !== undefined ? { authorization: options.authorization } : {}), 'content-type': 'application/json' };
  const payload = options.rawBody ?? (options.body !== undefined ? JSON.stringify(options.body) : undefined);
  const response = await fetch(`${baseUrl}${path}`, { method, headers, ...(payload !== undefined ? { body: payload } : {}) });
  const text = await response.text();
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    body = {};
  }
  return { status: response.status, text, body };
}

let sequence = 0;
export function nextKey(prefix = 'core04'): string {
  sequence += 1;
  return `${prefix}-${sequence}`;
}

export const govern = (baseUrl: string, intent: Record<string, unknown>, idempotencyKey = nextKey()) =>
  call(baseUrl, 'POST', '/api/governed-actions', { authorization: `Bearer ${AGENT_KEY}`, body: { idempotencyKey, ...intent } });

export const ADMIN = `Bearer ${ADMIN_KEY}`;

export const settle = (invoiceTotal = 500, destination = 'supplier-x') => ({ action: SETTLE, resource: PAYABLES, parameters: { invoiceTotal, destination } });

/** The committed Governance Record of a reply, verified, through the enterprise's own read path. */
export async function committedRecord(host: EnterpriseHost, reply: Reply) {
  const decision = reply.body['decision'] as { readonly evaluationId: string } | undefined;
  assert.ok(decision !== undefined, reply.text);
  const record = await host.enterprise.persistence.getByEvaluationId({ system: false, organizationId: ORG }, decision.evaluationId);
  assert.ok(record !== null);
  const verification = await host.enterprise.persistence.verify({ system: false, organizationId: ORG }, decision.evaluationId);
  assert.equal(verification.valid, true);
  return record;
}

/** The authoritative stored grant, read straight from the Host's signed SQLite store (read-only). */
export function storedGrant(dir: string, grantId: string): BoundedGrant {
  const db = new Database(join(dir, 'bounded-grants.sqlite'), { readonly: true });
  try {
    const row = db.prepare('SELECT grant_json FROM bounded_grants WHERE grant_id = ?').get(grantId) as { readonly grant_json: string } | undefined;
    assert.ok(row !== undefined, `grant ${grantId} is stored`);
    return JSON.parse(row.grant_json) as BoundedGrant;
  } finally {
    db.close();
  }
}

/** Asserts a denial and its cause: a context code on the decision itself, or a policy rule's own code in the committed decision. */
export async function assertDenied(host: EnterpriseHost, reply: Reply, code: string, label = code): Promise<void> {
  assert.equal(reply.body['status'], 'denied', `${label}: ${reply.text}`);
  const codes = (reply.body['reasonCodes'] as readonly string[] | undefined) ?? [];
  if (code.startsWith('CONTEXT_')) {
    assert.deepEqual(codes, [code], label);
    return;
  }
  assert.ok(codes.includes('DOMAIN_POLICY_DENIED'), `${label}: ${codes.join(',')}`);
  const committed = JSON.stringify(toKernelEvaluationResult(await committedRecord(host, reply)));
  assert.ok(committed.includes(code), `${label}: the committed decision records rule ${code}`);
}
