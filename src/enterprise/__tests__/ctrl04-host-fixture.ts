import assert from 'node:assert/strict';

import { createActionEnforcementPolicyPackIntegration } from '../../features/domain-policy-pack-runtime/integrations/action-enforcement-policy-pack-integration.js';
import type { PolicyCondition } from '../../features/domain-policy-pack-runtime/domain/policy-pack-condition.js';
import type { PolicyPackRule } from '../../features/domain-policy-pack-runtime/domain/policy-pack-rule.js';
import { createPolicyPackRuntimeContext } from '../../features/domain-policy-pack-runtime/runtime/policy-pack-runtime-context.js';
import { createPolicyPackRuntime } from '../../features/domain-policy-pack-runtime/services/policy-pack-runtime.js';
import type { PolicyPackProvider } from '../../kernel/index.js';
import { bootEnterpriseHost } from '../host/enterprise-host.js';
import { withDeploymentWitness } from './core07-freshness-fixture.js';
import {
  bearer,
  call,
  capturingLogger,
  create,
  createWorkspace,
  ctrl02Env,
  ctrl02File,
  expectStatus,
  ISSUER,
  LEGACY_ADMINISTRATORS,
  ORG,
  recordingAdapter,
  SECRETS,
  TRUST_DOMAIN,
  type Booted,
  type Reply,
  type Workspace,
} from './ctrl02-host-fixture.js';

/**
 * CTRL-04 — the shared harness for qualifying the human approval workflow
 * through the real Enterprise Host.
 *
 * Everything reaches the Host through its canonical inputs:
 *
 * - the governed-action file declares CTRL-02 operators (including three
 *   operators with the CTRL-04 `approver` role), no static customer principal,
 *   and two Governance Profiles that declare **how** a decision awaiting
 *   approval is approved (CORE-05): `release-production` — one approver
 *   holding `approve-release` over the production cluster; `release-critical`
 *   — two distinct approvers over the critical cluster, each citing a
 *   `source_document` evidence reference;
 * - the organization's deterministic policy (trusted in-process composition,
 *   `BootEnterpriseHostOptions.policyPackProvider`, as in CORE-04/05) decides
 *   **whether**: every release to either cluster requires approval;
 * - every actor, authority and credential is provisioned **over HTTP** by an
 *   identified operator (CTRL-02). Approvers are Kernel-Authority human actors
 *   whose id is the operator's canonical identity `operator:<operatorId>` —
 *   the CTRL-04 identity bridge — with authority for `approve-release`, never
 *   for the governed action itself.
 *
 * The only in-process seams are the recording adapter (counts executions)
 * and the policy (decides approval_required). Synthetic identifiers only.
 */

export { ORG, ISSUER, TRUST_DOMAIN, call, bearer, expectStatus, type Reply, type Booted, type Workspace, createWorkspace };

export const DEPLOY = 'deploy-release';
export const PROD = 'production-cluster';
export const CRITICAL = 'critical-cluster';
export const APPROVE_RELEASE = 'approve-release';
export const APPROVE_OTHER = 'approve-other';
export const OWNER = 'actor-release-owner';
export const AGENT = 'actor-release-agent';
export const AGENT_SUBJECT = { system: 'pilot-ci', subjectId: 'release-agent-1' } as const;
/** An agent whose Kernel-Authority actor id is also an operator's canonical identity: the self-approval case. */
export const SELF_OPERATOR = 'approver-self';
export const SELF_AGENT = `operator:${SELF_OPERATOR}`;
export const SELF_SUBJECT = { system: 'pilot-ci', subjectId: 'release-agent-self' } as const;

export const QUORUM_1 = { approverAction: APPROVE_RELEASE, minimumApprovals: 1, requestTtlSeconds: 3600, approvalValiditySeconds: 900 } as const;
export const QUORUM_2 = { approverAction: APPROVE_RELEASE, minimumApprovals: 2, requestTtlSeconds: 3600, approvalValiditySeconds: 900, requiredEvidence: ['source_document'] } as const;

export const CTRL04_SECRETS = {
  ...SECRETS,
  approverA: 'FRONTERA_CTRL04_APPROVER_A_SECRET_4e1c9a7b2d6f3e8051',
  approverB: 'FRONTERA_CTRL04_APPROVER_B_SECRET_9b3d7e1a5c2f8e4061',
  approverC: 'FRONTERA_CTRL04_APPROVER_C_SECRET_2c8e4a1f7d3b9e5072',
  approverD: 'FRONTERA_CTRL04_APPROVER_D_SECRET_7f2a9c4e1b6d3e8083',
  approverE: 'FRONTERA_CTRL04_APPROVER_E_SECRET_5d1b8e3a9c4f2e7094',
  approverNoStanding: 'FRONTERA_CTRL04_APPROVER_NS_SECRET_3a9f2c7e4b1d8e6015',
  approverSelf: 'FRONTERA_CTRL04_APPROVER_SELF_SECRET_8e4c1a9f3b7d2e5026',
} as const;

/**
 * Operators. `approver-a` / `approver-b`: approval standing over both
 * clusters. `approver-c`: over the critical cluster only (wrong resource for
 * production). `approver-d`: standing for another approver action (wrong
 * action). `approver-e`: *execution* authority for `deploy-release`, no
 * approval standing. `approver-nostanding`: no Kernel-Authority actor at all.
 * `approver-self`: the self-approval case. `ops-responder` holds approval
 * standing over production too — to prove a restrict-only role cannot approve
 * even with standing.
 */
export const CTRL04_OPERATORS = [
  { operatorId: 'ops-admin', role: 'organization-administrator', apiKeyEnv: 'FRONTERA_CTRL02_ADMIN' },
  { operatorId: 'ops-provisioner', role: 'provisioner', apiKeyEnv: 'FRONTERA_CTRL02_PROVISIONER' },
  { operatorId: 'ops-observer', role: 'observer', apiKeyEnv: 'FRONTERA_CTRL02_OBSERVER' },
  { operatorId: 'ops-responder', role: 'responder', apiKeyEnv: 'FRONTERA_CTRL02_RESPONDER' },
  { operatorId: 'ops-steward', role: 'profile-steward', apiKeyEnv: 'FRONTERA_CTRL02_STEWARD' },
  { operatorId: 'approver-a', role: 'approver', apiKeyEnv: 'FRONTERA_CTRL04_APPROVER_A' },
  { operatorId: 'approver-b', role: 'approver', apiKeyEnv: 'FRONTERA_CTRL04_APPROVER_B' },
  { operatorId: 'approver-c', role: 'approver', apiKeyEnv: 'FRONTERA_CTRL04_APPROVER_C' },
  { operatorId: 'approver-d', role: 'approver', apiKeyEnv: 'FRONTERA_CTRL04_APPROVER_D' },
  { operatorId: 'approver-e', role: 'approver', apiKeyEnv: 'FRONTERA_CTRL04_APPROVER_E' },
  { operatorId: 'approver-nostanding', role: 'approver', apiKeyEnv: 'FRONTERA_CTRL04_APPROVER_NS' },
  { operatorId: SELF_OPERATOR, role: 'approver', apiKeyEnv: 'FRONTERA_CTRL04_APPROVER_SELF' },
] as const;

export const AUTH = {
  administrator: bearer(SECRETS.administrator),
  provisioner: bearer(SECRETS.provisioner),
  observer: bearer(SECRETS.observer),
  responder: bearer(SECRETS.responder),
  steward: bearer(SECRETS.steward),
  legacyAdministrator: bearer(SECRETS.legacyAdministrator),
  legacyKey: bearer(SECRETS.legacyKey),
  approverA: bearer(CTRL04_SECRETS.approverA),
  approverB: bearer(CTRL04_SECRETS.approverB),
  approverC: bearer(CTRL04_SECRETS.approverC),
  approverD: bearer(CTRL04_SECRETS.approverD),
  approverE: bearer(CTRL04_SECRETS.approverE),
  approverNoStanding: bearer(CTRL04_SECRETS.approverNoStanding),
  approverSelf: bearer(CTRL04_SECRETS.approverSelf),
} as const;

export const GOVERNANCE = {
  parameterDimensions: [{ id: 'releaseVersion', type: 'token', bound: 'exact' }],
  actionClasses: [{ id: 'deploy', actions: [DEPLOY] }],
  resourceClasses: [
    { id: 'production', resources: [PROD] },
    { id: 'critical', resources: [CRITICAL] },
  ],
  profiles: [
    {
      profileId: 'release-production',
      version: 1,
      owner: ORG,
      provenance: { authoredBy: 'platform-team', approvedBy: 'change-board' },
      actionClass: 'deploy',
      resourceClass: 'production',
      parameters: [{ dimension: 'releaseVersion', required: true }],
      materialFacts: [],
      relevantPolicies: ['ctrl04-policy'],
      approval: QUORUM_1,
    },
    {
      profileId: 'release-critical',
      version: 1,
      owner: ORG,
      provenance: { authoredBy: 'platform-team', approvedBy: 'change-board' },
      actionClass: 'deploy',
      resourceClass: 'critical',
      parameters: [{ dimension: 'releaseVersion', required: true }],
      materialFacts: [],
      relevantPolicies: ['ctrl04-policy'],
      approval: QUORUM_2,
    },
  ],
};

export function ctrl04File(governance: Record<string, unknown> = GOVERNANCE): Record<string, unknown> {
  return ctrl02File({ monetary: undefined, governance, operators: CTRL04_OPERATORS, administrators: LEGACY_ADMINISTRATORS, routes: [{ action: DEPLOY, adapterId: 'pilot.recording' }] });
}

export function ctrl04Env(dir: string, file: Record<string, unknown> = ctrl04File(), overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return ctrl02Env(dir, file, {
    FRONTERA_CTRL04_APPROVER_A: CTRL04_SECRETS.approverA,
    FRONTERA_CTRL04_APPROVER_B: CTRL04_SECRETS.approverB,
    FRONTERA_CTRL04_APPROVER_C: CTRL04_SECRETS.approverC,
    FRONTERA_CTRL04_APPROVER_D: CTRL04_SECRETS.approverD,
    FRONTERA_CTRL04_APPROVER_E: CTRL04_SECRETS.approverE,
    FRONTERA_CTRL04_APPROVER_NS: CTRL04_SECRETS.approverNoStanding,
    FRONTERA_CTRL04_APPROVER_SELF: CTRL04_SECRETS.approverSelf,
    ...overrides,
  });
}

// -- policy: every release to either cluster requires approval ------------------------

const POLICY_WRITER = { system: true, actorId: 'operator:policy-ctrl04' } as const;
const VERSION_ID = 'policy-pack-ctrl04-v1';

function rule(id: string, condition: PolicyCondition, effect: PolicyPackRule['effect']): PolicyPackRule {
  return { id, policyPackVersionId: VERSION_ID, name: id, description: id, status: 'active', priority: 100, condition, effect, obligations: [], evidenceRequirements: [], approvalRequirements: [], severity: 'error', sourceIds: ['ctrl04-source'] };
}

export function approvalPolicy(): PolicyPackProvider {
  const runtime = createPolicyPackRuntime(createPolicyPackRuntimeContext('2026-01-01T00:00:00.000Z'));
  runtime.registerPolicyPack(POLICY_WRITER, { id: 'ctrl04-policy', name: 'CTRL-04 qualification policy', description: 'Synthetic', kind: 'data_boundary', domain: 'general_enterprise' });
  runtime.registerPolicyPackVersion(POLICY_WRITER, {
    id: VERSION_ID,
    policyPackId: 'ctrl04-policy',
    version: '1.0.0',
    scope: { resourceScopes: [PROD, CRITICAL] },
    rules: [rule('release-requires-approval', { type: 'predicate', field: 'actionClass', operator: 'equals', value: 'deploy' }, { type: 'require_approval', reasonCode: 'RELEASE_REVIEW', reason: 'A release requires a human approver.' })],
    sources: [{ id: 'ctrl04-source', type: 'internal_control', title: 'Synthetic', description: 'Synthetic', authority: 'demo_only' }],
    effectiveFrom: '2026-01-01T00:00:00.000Z',
    demoOnly: true,
    legalCompleteness: 'not_legal_advice',
  });
  runtime.activatePolicyPackVersion(POLICY_WRITER, VERSION_ID);
  return createActionEnforcementPolicyPackIntegration(runtime);
}

export interface BootedCtrl04 extends Booted {
  /** The Host's data directory (its SQLite stores), for read-only verification after a flow. */
  readonly dir: string;
}

export async function bootCtrl04(workspace: Workspace, options: { readonly dir?: string; readonly file?: Record<string, unknown>; readonly env?: Record<string, string | undefined> } = {}): Promise<BootedCtrl04> {
  const dir = options.dir ?? workspace.dir();
  const env = ctrl04Env(dir, options.file ?? ctrl04File(), options.env ?? {});
  const adapter = recordingAdapter();
  const host = workspace.track(await bootEnterpriseHost({ env: await withDeploymentWitness(env), executionAdapters: [adapter], logger: capturingLogger, policyPackProvider: approvalPolicy() }));
  const { port } = await host.listen();
  return { host, adapter, baseUrl: `http://127.0.0.1:${port}`, dir };
}

// -- provisioning, over HTTP, by identified operators ------------------------------------

export async function bootstrap(baseUrl: string): Promise<void> {
  await create(baseUrl, AUTH.administrator, 'actor', { actorId: ISSUER, type: 'organization', displayName: 'Pilot Organization' });
  await create(baseUrl, AUTH.administrator, 'trust-domain', { trustDomainId: TRUST_DOMAIN, name: 'Pilot Trust Domain', issuerActorId: ISSUER, acceptedIssuerIds: [ISSUER], acceptedActorTypes: ['human', 'organization', 'agent'] });
  await create(baseUrl, AUTH.administrator, 'root-issuer', { trustDomainId: TRUST_DOMAIN, actorId: ISSUER });
}

/** A Kernel-Authority human actor for an operator: its id is the operator's canonical identity. */
export async function operatorActor(baseUrl: string, operatorId: string): Promise<string> {
  const actorId = `operator:${operatorId}`;
  await create(baseUrl, AUTH.provisioner, 'actor', { actorId, type: 'human', displayName: `Operator ${operatorId}`, issuerId: ISSUER, trustDomainId: TRUST_DOMAIN });
  return actorId;
}

/** Standing authority for exactly `action` over exactly `resources`, issued by the organization's root issuer. */
export async function standing(baseUrl: string, actorId: string, action: string, resources: readonly string[], grantId: string): Promise<void> {
  await create(baseUrl, AUTH.provisioner, 'authority-grant', {
    authorityGrantId: grantId,
    issuerActorId: ISSUER,
    subjectActorId: actorId,
    trustDomainId: TRUST_DOMAIN,
    capability: `${action}.standing`,
    actions: [action],
    resourceScopes: resources,
    canDelegate: false,
    allowedDelegateActorTypes: ['human'],
    maxDelegationDepth: 0,
  });
}

/** An agent able to request releases on both clusters, through an owner's delegated authority. Returns its one-time credential. */
export async function onboardReleaseAgent(baseUrl: string, agentId: string, subject: { readonly system: string; readonly subjectId: string }, suffix: string): Promise<string> {
  const owners = await call(baseUrl, 'GET', '/api/admin/authority/entities?kind=actor', { authorization: AUTH.observer });
  if (!(owners.body['entities'] as { entityId: string }[]).some((entity) => entity.entityId === OWNER)) {
    await create(baseUrl, AUTH.provisioner, 'actor', { actorId: OWNER, type: 'human', displayName: 'Release Owner', issuerId: ISSUER, trustDomainId: TRUST_DOMAIN });
    await create(baseUrl, AUTH.provisioner, 'authority-grant', {
      authorityGrantId: 'authority-release-owner',
      issuerActorId: ISSUER,
      subjectActorId: OWNER,
      trustDomainId: TRUST_DOMAIN,
      capability: 'release.manage',
      actions: [DEPLOY],
      resourceScopes: [PROD, CRITICAL],
      canDelegate: true,
      allowedDelegateActorTypes: ['agent'],
      maxDelegationDepth: 1,
    });
  }
  await create(baseUrl, AUTH.provisioner, 'actor', { actorId: agentId, type: 'agent', displayName: `Release agent ${suffix}`, issuerId: ISSUER, trustDomainId: TRUST_DOMAIN, externalSubject: subject });
  const issued = expectStatus(await call(baseUrl, 'POST', `/api/admin/agents/${encodeURIComponent(agentId)}/credentials`, { authorization: AUTH.provisioner, body: { idempotencyKey: `issue-${suffix}-credential` } }), 200, 'issue credential');
  const credential = issued.body['bearerCredential'];
  assert.equal(typeof credential, 'string', issued.text);
  await create(baseUrl, AUTH.provisioner, 'passport', { passportId: `passport-${suffix}`, type: 'agent_passport', subjectActorId: agentId, issuerActorId: ISSUER, trustDomainId: TRUST_DOMAIN });
  await create(baseUrl, AUTH.provisioner, 'capability-token', {
    capabilityTokenId: `capability-${suffix}`,
    subjectActorId: agentId,
    principalActorId: OWNER,
    issuerActorId: OWNER,
    trustDomainId: TRUST_DOMAIN,
    capability: 'release.execute',
    actions: [DEPLOY],
    resourceScopes: [PROD, CRITICAL],
    riskLevel: 'medium',
  });
  await create(baseUrl, AUTH.provisioner, 'delegation-grant', {
    delegationGrantId: `delegation-${suffix}`,
    delegatorActorId: OWNER,
    delegateActorId: agentId,
    delegateActorType: 'agent',
    trustDomainId: TRUST_DOMAIN,
    sourceAuthorityGrantId: 'authority-release-owner',
    capability: 'release.execute',
    actions: [DEPLOY],
    resourceScopes: [PROD, CRITICAL],
    canRedelegate: false,
  });
  return credential as string;
}

export interface Organization {
  readonly agentCredential: string;
  readonly selfCredential: string;
}

/**
 * The qualified organization, provisioned over HTTP: bootstrap, the release
 * agent, the self-approval agent, and every approver's Kernel-Authority actor
 * and standing (the approver action, never the governed action — except
 * `approver-e`, whose only authority is to *execute* releases).
 */
export async function provisionOrganization(baseUrl: string, options: { readonly primaryApproversElsewhere?: boolean } = {}): Promise<Organization> {
  await bootstrap(baseUrl);
  const agentCredential = await onboardReleaseAgent(baseUrl, AGENT, AGENT_SUBJECT, 'agent');
  const selfCredential = await onboardReleaseAgent(baseUrl, SELF_AGENT, SELF_SUBJECT, 'self');
  // `primaryApproversElsewhere`: approver-a and approver-b are provisioned by the caller (the web qualification does it through the console).
  if (options.primaryApproversElsewhere !== true) {
    for (const operatorId of ['approver-a', 'approver-b']) await standing(baseUrl, await operatorActor(baseUrl, operatorId), APPROVE_RELEASE, [PROD, CRITICAL], `approval-standing-${operatorId}`);
  }
  await standing(baseUrl, await operatorActor(baseUrl, 'approver-c'), APPROVE_RELEASE, [CRITICAL], 'approval-standing-approver-c');
  await standing(baseUrl, await operatorActor(baseUrl, 'approver-d'), APPROVE_OTHER, [PROD, CRITICAL], 'approval-standing-approver-d');
  await standing(baseUrl, await operatorActor(baseUrl, 'approver-e'), DEPLOY, [PROD, CRITICAL], 'execution-standing-approver-e');
  await standing(baseUrl, await operatorActor(baseUrl, 'ops-responder'), APPROVE_RELEASE, [PROD], 'approval-standing-ops-responder');
  // The self-approval agent also holds approval standing — so only segregation of duties stands between it and its own request.
  await standing(baseUrl, SELF_AGENT, APPROVE_RELEASE, [PROD, CRITICAL], 'approval-standing-approver-self');
  return { agentCredential, selfCredential };
}

// -- the governed path, as the agent drives it ------------------------------------------

let sequence = 0;
export function releaseKey(prefix = 'ctrl04'): string {
  sequence += 1;
  return `${prefix}-${process.pid}-${sequence}`;
}

export function release(resource: string, idempotencyKey: string, releaseVersion = 'release-2026-10-01'): Record<string, unknown> {
  return { action: DEPLOY, resource, parameters: { releaseVersion }, idempotencyKey };
}

export async function govern(baseUrl: string, credential: string, body: Record<string, unknown>): Promise<Reply> {
  return call(baseUrl, 'POST', '/api/governed-actions', { authorization: bearer(credential), body });
}

export function assertAwaitingApproval(reply: Reply, code = 'GOVERNED_ACTION_APPROVAL_PENDING'): void {
  assert.equal(reply.body['status'], 'withheld', reply.text);
  assert.equal(reply.body['withheldBy'], 'approval', reply.text);
  assert.ok(((reply.body['reasonCodes'] as string[] | undefined) ?? []).includes(code), `${code}: ${reply.text}`);
}

// -- the approval plane, over HTTP ---------------------------------------------------------

export const approvalsPath = (view?: string): string => `/api/admin/approvals${view === undefined ? '' : `?view=${view}`}`;
export const approvalPath = (approvalRequestId: string): string => `/api/admin/approvals/${encodeURIComponent(approvalRequestId)}`;

export async function inbox(baseUrl: string, authorization: string = AUTH.observer, view?: string): Promise<readonly Record<string, unknown>[]> {
  const reply = expectStatus(await call(baseUrl, 'GET', approvalsPath(view), { authorization }), 200, 'inbox');
  return reply.body['approvals'] as Record<string, unknown>[];
}

/** The approval request a withheld reply opened, found in the inbox by its governed request id (as a human would find it). */
export async function approvalFor(baseUrl: string, reply: Reply): Promise<Record<string, unknown>> {
  const requestId = reply.body['requestId'];
  assert.equal(typeof requestId, 'string', reply.text);
  const entry = (await inbox(baseUrl, AUTH.observer, 'all')).find((candidate) => candidate['requestId'] === requestId);
  assert.ok(entry !== undefined, `request ${String(requestId)} appears in the inbox`);
  return detail(baseUrl, entry['approvalRequestId'] as string);
}

export async function detail(baseUrl: string, approvalRequestId: string, authorization: string = AUTH.observer): Promise<Record<string, unknown>> {
  return expectStatus(await call(baseUrl, 'GET', approvalPath(approvalRequestId), { authorization }), 200, 'detail').body;
}

export async function command(baseUrl: string, authorization: string, approvalRequestId: string, verb: string, body: Record<string, unknown>): Promise<Reply> {
  return call(baseUrl, 'POST', `${approvalPath(approvalRequestId)}/${verb}`, { authorization, body });
}

export const failureOf = (reply: Reply): unknown => (reply.body['error'] as Record<string, unknown> | undefined)?.['failure'];
export const errorCodeOf = (reply: Reply): unknown => (reply.body['error'] as Record<string, unknown> | undefined)?.['code'];
export const quorumOf = (approval: Record<string, unknown>): { readonly minimumApprovals: number; readonly countedApprovers: readonly string[]; readonly satisfied: boolean } =>
  approval['quorum'] as { minimumApprovals: number; countedApprovers: string[]; satisfied: boolean };

export const EVIDENCE_HASH = `sha256:${'a1'.repeat(32)}`;
export const OTHER_EVIDENCE_HASH = `sha256:${'b2'.repeat(32)}`;
