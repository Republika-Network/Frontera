import assert from 'node:assert/strict';
import { join } from 'node:path';

import Database from 'better-sqlite3';

import type { PolicyCondition } from '../../features/domain-policy-pack-runtime/domain/policy-pack-condition.js';
import type { ApprovalCommand, ApprovalCommandContext, ApprovalRequestView } from '../approval-authority/index.js';
import type { GovernanceConfiguration, GovernanceProfileApproval } from '../governance-profile/index.js';
import type { EnterpriseHost } from '../host/enterprise-host.js';
import { buildDurableAuthorityPayloads, DURABLE_FIXTURE_OPERATOR } from '../kernel-authority/fixtures/durable-authority.fixture.js';
import { AUTHORITY_KEY_A, AUTHORITY_KEY_B, trustedKeyOf, type TestAuthorityKey } from './authority-authenticity-fixture.js';
import { AGENT, CUSTOMER_DATA, DEPLOY, GOVERNANCE, OWNER, PAYABLES, PRODUCTION, RULES, SETTLE, TRUST_DOMAIN, ORG, governedFile, policyPackProvider, rule, type Reading, type Reply } from './core04-host-fixture.js';

/**
 * CORE-05 — durable approvals on the **canonical shipped Host**, on top of the
 * CORE-04 organization (`core04-host-fixture.ts`): `bootEnterpriseHost()`,
 * production profile, SQLite everywhere, Ed25519-signed grants and signed
 * approval state, a real loopback listener.
 *
 * What CORE-05 adds reaches the Host through its canonical inputs only:
 *
 * - the governed-action file's `invoice-settlement` Governance Profile
 *   declares **how** a settlement that awaits approval is approved: two
 *   distinct approvers holding live Kernel-Authority for `approve-settlement`
 *   over the payables ledger, within an hour of the decision, usable for
 *   fifteen minutes;
 * - the organization's deterministic policy decides **whether**: a
 *   settlement above 10 000 requires approval (and an admitted elevated risk
 *   signal does, from CORE-04);
 * - approvers are ordinary Kernel-Authority actors, provisioned through the
 *   in-process provisioning service like every other authority. The owner
 *   holds authority to *settle* and none to *approve*; the agent requests.
 *
 * Synthetic identifiers only.
 */

export const APPROVE = 'approve-settlement';
export const APPROVE_DEPLOY = 'approve-deploy';
export const APPROVER_A = 'actor-approver-a';
export const APPROVER_B = 'actor-approver-b';
export const APPROVER_C = 'actor-approver-c';
export const DEPLOY_APPROVER = 'actor-deploy-approver';
/** Holds `approve-settlement` — over customer data, not over the payables ledger. */
export const APPROVER_ELSEWHERE = 'actor-approver-elsewhere';

export const APPROVAL: GovernanceProfileApproval = {
  approverAction: APPROVE,
  minimumApprovals: 2,
  requestTtlSeconds: 3600,
  approvalValiditySeconds: 900,
};

/** The production-deploy profile keeps its CORE-04 blocking obligation and gains an approval requirement: two independent gates. */
export const DEPLOY_APPROVAL: GovernanceProfileApproval = { approverAction: APPROVE_DEPLOY, minimumApprovals: 1, requestTtlSeconds: 3600, approvalValiditySeconds: 900 };

export function governanceWith(approval: GovernanceProfileApproval | undefined = APPROVAL, deployApproval: GovernanceProfileApproval | undefined = DEPLOY_APPROVAL): GovernanceConfiguration {
  return {
    ...GOVERNANCE,
    profiles: (GOVERNANCE.profiles ?? []).map((profile) => {
      if (profile.profileId === 'invoice-settlement' && approval !== undefined) return { ...profile, approval };
      if (profile.profileId === 'production-deploy' && deployApproval !== undefined) return { ...profile, approval: deployApproval };
      return profile;
    }),
  };
}

export function approvalsFile(approval: GovernanceProfileApproval | undefined = APPROVAL, deployApproval: GovernanceProfileApproval | undefined = DEPLOY_APPROVAL): Record<string, unknown> {
  return governedFile({ governance: governanceWith(approval, deployApproval) });
}

/** Signing with `active`, trusting every key in `trust` — the CORE-01 rotation configuration. */
export function rotationEnv(active: TestAuthorityKey, trust: readonly TestAuthorityKey[]): Readonly<Record<string, string>> {
  return {
    AOC_ENTERPRISE_AUTHORITY_SIGNING_KEY_ID: active.keyId,
    AOC_ENTERPRISE_AUTHORITY_SIGNING_KEY_PEM: active.privateKeyPem,
    AOC_ENTERPRISE_AUTHORITY_VERIFICATION_KEYS: JSON.stringify(trust.map(trustedKeyOf)),
  };
}

export { AUTHORITY_KEY_A, AUTHORITY_KEY_B };

const settleAbove = (limit: number): PolicyCondition => ({
  type: 'group',
  operator: 'all',
  conditions: [
    { type: 'predicate', field: 'actionClass', operator: 'equals', value: 'settle' },
    { type: 'predicate', field: 'parameter', parameterId: 'invoiceTotal', operator: 'greater_than', value: limit },
  ],
});

export const APPROVAL_RULES = [
  ...RULES,
  rule('large-settlement-requires-approval', settleAbove(10_000), { type: 'require_approval', reasonCode: 'LARGE_SETTLEMENT_REVIEW', reason: 'A settlement above 10 000 requires two approvers.' }),
  rule('deploy-requires-approval', { type: 'predicate', field: 'actionClass', operator: 'equals', value: 'deploy' }, { type: 'require_approval', reasonCode: 'DEPLOY_REVIEW', reason: 'A production deploy requires a release approver.' }),
];

export const deploy = (releaseVersion = 'release-2026-09-28') => ({ action: DEPLOY, resource: PRODUCTION, parameters: { releaseVersion } });

export const approvalPolicy = () => policyPackProvider(APPROVAL_RULES);

/** A fully attested payables world for an invoice of `amount`. */
export const payablesWorld = (amount: number): readonly Reading[] => [
  { key: 'invoice.exists', value: true, sourceId: 'erp-primary' },
  { key: 'invoice.amount', value: amount, sourceId: 'erp-primary' },
  { key: 'destination.registered', value: true, sourceId: 'wallet-registry' },
];

export const LARGE = 25_000;

/** Approvers are provisioned like any authority: an actor and an authority grant over exactly the approver action and resource. */
export async function provisionApprovers(host: EnterpriseHost): Promise<void> {
  const service = host.enterprise.kernelAuthorityProvisioning;
  assert.ok(service !== undefined);
  const payloads = buildDurableAuthorityPayloads(ORG, TRUST_DOMAIN);
  const approver = async (actorId: string, action: string, resource: string, grantId = `authority-grant-${actorId}`) => {
    await service.provisionActor(DURABLE_FIXTURE_OPERATOR, { ...payloads.ownerActor, actorId, displayName: actorId, externalSubject: { system: 'core05-approvals', subjectId: actorId } });
    await approverGrant(host, actorId, action, resource, grantId);
  };
  await approver(APPROVER_A, APPROVE, PAYABLES);
  await approver(APPROVER_B, APPROVE, PAYABLES);
  await approver(APPROVER_C, APPROVE, PAYABLES);
  await approver(DEPLOY_APPROVER, APPROVE_DEPLOY, PRODUCTION);
  await approver(APPROVER_ELSEWHERE, APPROVE, CUSTOMER_DATA);
}

/** One authority grant for `actorId` over exactly `action` × `resource`, issued by the organization's root issuer. */
export async function approverGrant(host: EnterpriseHost, actorId: string, action: string, resource: string, grantId: string): Promise<void> {
  const service = host.enterprise.kernelAuthorityProvisioning;
  assert.ok(service !== undefined);
  const payloads = buildDurableAuthorityPayloads(ORG, TRUST_DOMAIN);
  await service.provisionAuthorityGrant(DURABLE_FIXTURE_OPERATOR, {
    ...payloads.authorityGrant,
    authorityGrantId: grantId,
    subjectActorId: actorId,
    roleId: 'role-approver',
    capability: `${action}.grant`,
    actions: [action],
    resourceScopes: [resource],
    canDelegate: false,
    allowedDelegateActorTypes: [],
    maxDelegationDepth: 0,
  });
}

/** What CTRL-04 will construct after authenticating a human: the acting actor comes from here, never from a command. */
export const as = (actorId: string): ApprovalCommandContext => ({ authenticated: true, actorId, authenticatedBy: 'test:approval-desk-session' });

export function approvals(host: EnterpriseHost) {
  const surface = host.enterprise.approvals;
  assert.ok(surface !== undefined, 'durable approvals are composed');
  return surface;
}

/** The approval request of a withheld reply, as an approver is shown it. */
export async function describe(host: EnterpriseHost, reply: Reply): Promise<ApprovalRequestView> {
  const requestId = reply.body['requestId'];
  assert.equal(typeof requestId, 'string', reply.text);
  const view = await approvals(host).describe(requestId as string);
  assert.ok(view !== undefined, `request ${String(requestId)} awaits approval`);
  return view;
}

export function commandFor(view: ApprovalRequestView): ApprovalCommand {
  return { approvalRequestId: view.approvalRequestId, subjectDigest: view.subjectDigest };
}

export const OWNER_ID = OWNER;
export const AGENT_ID = AGENT;
export { SETTLE };

/** Revokes an approver's Kernel-Authority grant through the one provisioning service — the durable world reloads. */
export async function revokeApproverAuthority(host: EnterpriseHost, actorId: string): Promise<void> {
  const service = host.enterprise.kernelAuthorityProvisioning;
  assert.ok(service !== undefined);
  await service.revoke(DURABLE_FIXTURE_OPERATOR, { entityKind: 'authority-grant', entityId: `authority-grant-${actorId}`, reason: 'approver authority withdrawn' });
}

/** Raw approval rows, straight from the Host's signed SQLite store (read-only). */
export function storedApprovalRows(dir: string): readonly Record<string, unknown>[] {
  const db = new Database(join(dir, 'approvals.sqlite'), { readonly: true });
  try {
    return db.prepare('SELECT * FROM approval_records ORDER BY sequence ASC').all() as Record<string, unknown>[];
  } finally {
    db.close();
  }
}
