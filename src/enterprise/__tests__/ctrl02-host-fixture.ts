import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ExecutionAdapter, ExecutionAdapterResult, ValidatedExecutionAction } from '../../features/execution-runtime/index.js';
import { bootEnterpriseHost, type EnterpriseHost } from '../host/enterprise-host.js';
import type { EnterpriseLogger } from '../telemetry/enterprise-logger.js';
import { AUTHORITY_KEY_A, authorityAuthenticityEnv } from './authority-authenticity-fixture.js';
import { closeDeploymentWitnesses, withDeploymentWitness } from './core07-freshness-fixture.js';

/**
 * CTRL-02 — the shared harness for qualifying the operator plane through the
 * real Enterprise Host.
 *
 * Every Host boots through `bootEnterpriseHost()` — what `npm run
 * start:enterprise` calls — from a plain environment and a governed-action
 * file, over real SQLite files, real Ed25519 authority signing and a real
 * loopback listener. Everything an operator or an agent does goes over HTTP.
 * The only in-process seam is the recording provider adapter (the bootstrap's
 * documented embedder seam), so adapter calls can be counted. Nothing here
 * provisions authority in-process, opens a database, or edits configuration
 * after boot.
 */

export const ORG = 'org-pilot';
export const TRUST_DOMAIN = 'trust-domain-pilot';
export const ISSUER = 'actor-pilot-org';
export const OWNER = 'actor-treasurer';
export const AGENT = 'actor-payables-agent';
export const AGENT_SUBJECT = { system: 'pilot-erp', subjectId: 'payables-agent-7' } as const;
export const TRANSFER = 'transfer-funds';
export const ACCOUNT = 'operating-account';
export const OTHER_ACCOUNT = 'reserve-account';
export const CEILING = '500';
/** P10: a financial action needs an aggregate limit on its authority as well as a per-execution ceiling; without one it is withheld. */
export const LIFETIME_LIMIT = '10000';
export function pilotConstraints(ceiling: string = CEILING): readonly Record<string, unknown>[] {
  return [
    { type: 'max_amount', currency: 'USD', value: ceiling },
    { type: 'spending_limit', limitId: 'payables-lifetime', currency: 'USD', maximum: LIFETIME_LIMIT, window: { kind: 'lifetime' } },
  ];
}
export const ADAPTER_ID = 'pilot.recording';

export const SECRETS = {
  administrator: 'FRONTERA_CTRL02_ORG_ADMIN_SECRET_7c2e91d04b6a5f38e1',
  provisioner: 'FRONTERA_CTRL02_PROVISIONER_SECRET_a91f03c7e25d48b60',
  observer: 'FRONTERA_CTRL02_OBSERVER_SECRET_5e8d17a2c4b9f0e631',
  responder: 'FRONTERA_CTRL02_RESPONDER_SECRET_d40b8e2f7a1c96e35a',
  steward: 'FRONTERA_CTRL02_STEWARD_SECRET_3a6c0f9e1d8b27c4e5',
  legacyAdministrator: 'FRONTERA_CTRL02_LEGACY_ADMIN_SECRET_b2f7c19e04d3a8e65c',
  legacyKey: 'FRONTERA_CTRL02_LEGACY_KEY_SENTINEL_19ce0a',
  staticCustomer: 'FRONTERA_CTRL02_STATIC_CUSTOMER_KEY_7f3a2e',
} as const;

export const PRIVATE_KEY_LINE = AUTHORITY_KEY_A.privateKeyPem.split('\n')[1] ?? 'unreachable';

export const OPERATORS = [
  { operatorId: 'ops-admin', role: 'organization-administrator', apiKeyEnv: 'FRONTERA_CTRL02_ADMIN' },
  { operatorId: 'ops-provisioner', role: 'provisioner', apiKeyEnv: 'FRONTERA_CTRL02_PROVISIONER' },
  { operatorId: 'ops-observer', role: 'observer', apiKeyEnv: 'FRONTERA_CTRL02_OBSERVER' },
  { operatorId: 'ops-responder', role: 'responder', apiKeyEnv: 'FRONTERA_CTRL02_RESPONDER' },
  { operatorId: 'ops-steward', role: 'profile-steward', apiKeyEnv: 'FRONTERA_CTRL02_STEWARD' },
] as const;

export const LEGACY_ADMINISTRATORS = [{ operatorId: 'ops-legacy', apiKeyEnv: 'FRONTERA_CTRL02_LEGACY_ADMIN' }] as const;

export const bearer = (secret: string): string => `Bearer ${secret}`;
export const AUTH = {
  administrator: bearer(SECRETS.administrator),
  provisioner: bearer(SECRETS.provisioner),
  observer: bearer(SECRETS.observer),
  responder: bearer(SECRETS.responder),
  steward: bearer(SECRETS.steward),
  legacyAdministrator: bearer(SECRETS.legacyAdministrator),
  legacyKey: bearer(SECRETS.legacyKey),
  staticCustomer: bearer(SECRETS.staticCustomer),
} as const;

// -- workspace -------------------------------------------------------------------

export interface Workspace {
  dir(): string;
  track(host: EnterpriseHost): EnterpriseHost;
  close(): Promise<void>;
}

export function createWorkspace(prefix = 'frontera-ctrl02-'): Workspace {
  const directories: string[] = [];
  const hosts: EnterpriseHost[] = [];
  return {
    dir() {
      const directory = mkdtempSync(join(tmpdir(), prefix));
      directories.push(directory);
      return directory;
    },
    track(host) {
      hosts.push(host);
      return host;
    },
    async close() {
      for (const host of hosts) await host.close().catch(() => {});
      await closeDeploymentWitnesses();
      for (const directory of directories) rmSync(directory, { recursive: true, force: true });
    },
  };
}

// -- configuration --------------------------------------------------------------

/**
 * The pilot's governed-action file: operators, one CTRL-01 administrator kept
 * for compatibility, **no static customer principal**, one financial action
 * routed to the recording adapter.
 */
export function ctrl02File(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    trustDomainId: TRUST_DOMAIN,
    grantLifetimeSeconds: 300,
    customerPrincipals: [],
    administrators: LEGACY_ADMINISTRATORS,
    operators: OPERATORS,
    monetary: { assets: [{ assetId: 'USD', scale: 2 }], financialActions: [TRANSFER] },
    routes: [{ action: TRANSFER, adapterId: ADAPTER_ID }],
    ...overrides,
  };
}

export function ctrl02Env(dir: string, file: Record<string, unknown> = ctrl02File(), overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  const filePath = join(dir, 'governed-actions.json');
  writeFileSync(filePath, JSON.stringify(file));
  return {
    AOC_ENTERPRISE_ENV: 'production',
    AOC_ENTERPRISE_PERSISTENCE_PROVIDER: 'sqlite',
    AOC_ENTERPRISE_REQUIRE_AUTH: 'true',
    AOC_ENTERPRISE_API_KEYS: `${SECRETS.legacyKey}:${ORG}`,
    AOC_ENTERPRISE_HTTP_HOST: '127.0.0.1',
    AOC_ENTERPRISE_HTTP_PORT: '0',
    AOC_ENTERPRISE_LOG_LEVEL: 'info',
    AOC_ENTERPRISE_KERNEL_AUTHORITY_ENABLED: 'true',
    AOC_ENTERPRISE_KERNEL_AUTHORITY_REQUIRED: 'true',
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
    AOC_ENTERPRISE_APPROVAL_SQLITE_PATH: join(dir, 'approvals.sqlite'),
    AOC_ENTERPRISE_OBLIGATION_DISCHARGE_SQLITE_PATH: join(dir, 'obligation-discharges.sqlite'),
    AOC_ENTERPRISE_CONTROL_PLANE_SQLITE_PATH: join(dir, 'control-plane.sqlite'),
    ...authorityAuthenticityEnv(),
    AOC_ENTERPRISE_GOVERNED_ACTIONS_FILE: filePath,
    FRONTERA_CTRL02_ADMIN: SECRETS.administrator,
    FRONTERA_CTRL02_PROVISIONER: SECRETS.provisioner,
    FRONTERA_CTRL02_OBSERVER: SECRETS.observer,
    FRONTERA_CTRL02_RESPONDER: SECRETS.responder,
    FRONTERA_CTRL02_STEWARD: SECRETS.steward,
    FRONTERA_CTRL02_LEGACY_ADMIN: SECRETS.legacyAdministrator,
    FRONTERA_CTRL02_STATIC_CUSTOMER: SECRETS.staticCustomer,
    ...overrides,
  };
}

// -- the Host ----------------------------------------------------------------------

export interface RecordingAdapter extends ExecutionAdapter {
  readonly calls: ValidatedExecutionAction[];
}

export function recordingAdapter(result: ExecutionAdapterResult = { outcome: 'completed', providerRef: 'provider-ref-1' }): RecordingAdapter {
  const calls: ValidatedExecutionAction[] = [];
  return {
    adapterId: ADAPTER_ID,
    calls,
    async execute(action) {
      calls.push(action);
      return result;
    },
  };
}

export const logLines: string[] = [];
export const capturingLogger: EnterpriseLogger = {
  debug: (message, fields) => logLines.push(JSON.stringify({ message, fields })),
  info: (message, fields) => logLines.push(JSON.stringify({ message, fields })),
  warn: (message, fields) => logLines.push(JSON.stringify({ message, fields })),
  error: (message, fields) => logLines.push(JSON.stringify({ message, fields })),
};

export interface Booted {
  readonly host: EnterpriseHost;
  readonly adapter: RecordingAdapter;
  readonly baseUrl: string;
}

export async function bootCtrl02(workspace: Workspace, env: Record<string, string | undefined>, adapter: RecordingAdapter = recordingAdapter()): Promise<Booted> {
  const host = workspace.track(await bootEnterpriseHost({ env: await withDeploymentWitness(env), executionAdapters: [adapter], logger: capturingLogger }));
  const { port } = await host.listen();
  return { host, adapter, baseUrl: `http://127.0.0.1:${port}` };
}

// -- HTTP -------------------------------------------------------------------------

export interface Reply {
  readonly status: number;
  readonly text: string;
  readonly body: Record<string, unknown>;
}

export const responses: string[] = [];

export async function call(
  baseUrl: string,
  method: string,
  path: string,
  options: { readonly authorization?: string; readonly body?: unknown; readonly headers?: Record<string, string>; readonly rawBody?: string } = {},
): Promise<Reply> {
  const headers: Record<string, string> = { ...(options.authorization !== undefined ? { authorization: options.authorization } : {}), ...(options.headers ?? {}) };
  let payload: string | undefined = options.rawBody;
  if (options.body !== undefined) {
    payload = JSON.stringify(options.body);
    headers['content-type'] ??= 'application/json';
  } else if (payload !== undefined) {
    headers['content-type'] ??= 'application/json';
  }
  const response = await fetch(`${baseUrl}${path}`, { method, headers, ...(payload !== undefined ? { body: payload } : {}) });
  const text = await response.text();
  responses.push(text);
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    body = {};
  }
  return { status: response.status, text, body };
}

export const errorCode = (reply: Reply): unknown => (reply.body['error'] as Record<string, unknown> | undefined)?.['code'];

export function expectStatus(reply: Reply, status: number, where: string): Reply {
  assert.equal(reply.status, status, `${where}: ${reply.text.slice(0, 600)}`);
  return reply;
}

export const entityPath = (kind: string): string => `/api/admin/authority/entities/${kind}`;

/** Provisions one Kernel-Authority entity over HTTP and requires it to be created. */
export async function create(baseUrl: string, authorization: string, kind: string, body: Record<string, unknown>): Promise<Reply> {
  const reply = await call(baseUrl, 'POST', entityPath(kind), { authorization, body });
  expectStatus(reply, 200, `create ${kind}`);
  assert.equal(reply.body['outcome'], 'provisioned', reply.text);
  return reply;
}

/** Organization bootstrap, over HTTP, by an organization administrator: the issuer, its trust domain, its root-issuer standing. */
export async function bootstrapOrganization(baseUrl: string, authorization: string = AUTH.administrator): Promise<void> {
  await create(baseUrl, authorization, 'actor', { actorId: ISSUER, type: 'organization', displayName: 'Pilot Organization' });
  await create(baseUrl, authorization, 'trust-domain', {
    trustDomainId: TRUST_DOMAIN,
    name: 'Pilot Trust Domain',
    issuerActorId: ISSUER,
    acceptedIssuerIds: [ISSUER],
    acceptedActorTypes: ['human', 'organization', 'agent'],
  });
  await create(baseUrl, authorization, 'root-issuer', { trustDomainId: TRUST_DOMAIN, actorId: ISSUER });
}

export interface OnboardOptions {
  readonly agentId?: string;
  readonly ownerId?: string;
  readonly subject?: { readonly system: string; readonly subjectId: string };
  readonly ceiling?: string;
  readonly resources?: readonly string[];
  readonly suffix?: string;
}

export interface Onboarded {
  readonly agentId: string;
  readonly ownerId: string;
  readonly credential: string;
  readonly credentialId: string;
  readonly authorityGrantId: string;
  readonly delegationGrantId: string;
  readonly passportId: string;
  readonly capabilityTokenId: string;
}

/** The standing authority an owner holds and delegates to its agent: one action, the listed resources, a P10 per-execution ceiling. */
export async function assignAuthority(baseUrl: string, authorization: string, options: OnboardOptions & { readonly agentId: string; readonly ownerId: string }): Promise<Omit<Onboarded, 'credential' | 'credentialId'>> {
  const suffix = options.suffix ?? options.agentId;
  const resources = options.resources ?? [ACCOUNT];
  const authorityGrantId = `authority-${suffix}`;
  const delegationGrantId = `delegation-${suffix}`;
  const passportId = `passport-${suffix}`;
  const capabilityTokenId = `capability-${suffix}`;
  await create(baseUrl, authorization, 'authority-grant', {
    authorityGrantId,
    issuerActorId: ISSUER,
    subjectActorId: options.ownerId,
    trustDomainId: TRUST_DOMAIN,
    capability: 'payables.manage',
    actions: [TRANSFER],
    resourceScopes: resources,
    canDelegate: true,
    allowedDelegateActorTypes: ['agent'],
    maxDelegationDepth: 1,
    constraints: pilotConstraints(options.ceiling),
  });
  await create(baseUrl, authorization, 'passport', { passportId, type: 'agent_passport', subjectActorId: options.agentId, issuerActorId: ISSUER, trustDomainId: TRUST_DOMAIN });
  await create(baseUrl, authorization, 'capability-token', {
    capabilityTokenId,
    subjectActorId: options.agentId,
    principalActorId: options.ownerId,
    issuerActorId: options.ownerId,
    trustDomainId: TRUST_DOMAIN,
    capability: 'payables.execute',
    actions: [TRANSFER],
    resourceScopes: resources,
    riskLevel: 'medium',
  });
  await create(baseUrl, authorization, 'delegation-grant', {
    delegationGrantId,
    delegatorActorId: options.ownerId,
    delegateActorId: options.agentId,
    delegateActorType: 'agent',
    trustDomainId: TRUST_DOMAIN,
    sourceAuthorityGrantId: authorityGrantId,
    capability: 'payables.execute',
    actions: [TRANSFER],
    resourceScopes: resources,
    canRedelegate: false,
  });
  return { agentId: options.agentId, ownerId: options.ownerId, authorityGrantId, delegationGrantId, passportId, capabilityTokenId };
}

/** Onboards one agent end to end, over HTTP, as the given operator: owner and agent actors, the agent's credential, its standing authority. */
export async function onboardAgent(baseUrl: string, authorization: string = AUTH.provisioner, options: OnboardOptions = {}): Promise<Onboarded> {
  const agentId = options.agentId ?? AGENT;
  const ownerId = options.ownerId ?? OWNER;
  const subject = options.subject ?? AGENT_SUBJECT;
  const owners = await call(baseUrl, 'GET', `/api/admin/authority/entities?kind=actor`, { authorization: AUTH.observer });
  if (!(owners.body['entities'] as { entityId: string }[]).some((entity) => entity.entityId === ownerId)) {
    await create(baseUrl, authorization, 'actor', { actorId: ownerId, type: 'human', displayName: 'Pilot Treasurer', issuerId: ISSUER, trustDomainId: TRUST_DOMAIN });
  }
  await create(baseUrl, authorization, 'actor', { actorId: agentId, type: 'agent', displayName: 'Payables Agent', issuerId: ISSUER, trustDomainId: TRUST_DOMAIN, externalSubject: subject });
  const issued = expectStatus(await call(baseUrl, 'POST', `/api/admin/agents/${agentId}/credentials`, { authorization, body: { idempotencyKey: `issue-${agentId}` } }), 200, 'issue credential');
  const credential = issued.body['bearerCredential'];
  assert.equal(typeof credential, 'string', issued.text);
  const authority = await assignAuthority(baseUrl, authorization, { ...options, agentId, ownerId });
  return { ...authority, credential: credential as string, credentialId: (issued.body['credential'] as { credentialId: string }).credentialId };
}

let sequence = 0;
export function transfer(value: string, resource: string = ACCOUNT): Record<string, unknown> {
  sequence += 1;
  return { action: TRANSFER, resource, counterparty: 'vendor-acme', amount: { value, currency: 'USD' }, idempotencyKey: `ctrl02-${process.pid}-${sequence}` };
}

export async function govern(baseUrl: string, credential: string, body: Record<string, unknown>): Promise<Reply> {
  return call(baseUrl, 'POST', '/api/governed-actions', { authorization: bearer(credential), body });
}

/** Every configured secret, plus every bearer credential an operator was handed. None may ever appear in a response other than the one that revealed it, or in a log line. */
export function assertNoSecretIn(text: string, where: string, extra: readonly string[] = []): void {
  for (const secret of [...Object.values(SECRETS), PRIVATE_KEY_LINE, ...extra]) {
    assert.equal(text.includes(secret), false, `${where} must not contain a configured or issued secret`);
  }
}
