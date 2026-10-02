import type { AgentView, EntityView, ProfileVersion } from './wire.js';

/**
 * CTRL-03 — recorded lifecycle transitions, as a pure projection.
 *
 * Every row is one fact a canonical Host record states: a Kernel-Authority
 * entity's provisioning or revocation, an agent credential's issue or
 * revocation, a Governance Profile version's activation or retirement — with
 * the identifier, time, operator and reason exactly as recorded. Nothing is
 * inferred from current state beyond what the record says (an entity whose
 * status is not `revoked` yields no revocation row), and a field the record
 * does not carry is reported as missing, never filled in.
 *
 * This is not a canonical event stream: it is assembled from the records'
 * current lifecycle fields, intermediate events are not listed, and operator
 * actions are not on one canonical, verifiable trace — that is ASSURE-01.
 */

export type TransitionSource = 'kernel-authority-record' | 'agent-credential-record' | 'profile-lifecycle-record';

export interface LifecycleTransition {
  readonly key: string;
  /** As recorded, or `null` when the record does not carry it. */
  readonly at: string | null;
  readonly transition: 'provisioned' | 'revoked' | 'credential-issued' | 'credential-revoked' | 'profile-activated' | 'profile-retired';
  readonly targetKind: string;
  readonly targetId: string;
  readonly by: string | null;
  readonly reason: string | null;
  readonly source: TransitionSource;
  /** Console path of the canonical record this row came from. */
  readonly link: string;
  /** Fields the record should carry for this transition and does not. */
  readonly missing: readonly string[];
}

const present = (value: string | null | undefined): value is string => typeof value === 'string' && value.length > 0;
const orNull = (value: string | null | undefined): string | null => (present(value) ? value : null);

function row(fields: Omit<LifecycleTransition, 'missing' | 'key'>): LifecycleTransition {
  const missing = [...(fields.at === null ? ['time'] : []), ...(fields.by === null ? ['operator'] : [])];
  return { ...fields, key: `${fields.source}:${fields.targetKind}:${fields.targetId}:${fields.transition}`, missing };
}

const entityLink = (kind: string, id: string): string => `/authority/entities/${encodeURIComponent(kind)}/${encodeURIComponent(id)}`;

export function lifecycleTransitions(input: {
  readonly entities: readonly EntityView[];
  readonly agents: readonly AgentView[];
  readonly profiles: readonly ProfileVersion[];
}): readonly LifecycleTransition[] {
  const rows: LifecycleTransition[] = [];
  for (const entity of input.entities) {
    rows.push(
      row({
        at: orNull(entity.provisionedAt),
        transition: 'provisioned',
        targetKind: entity.entityKind,
        targetId: entity.entityId,
        by: orNull(entity.provisionedBy),
        reason: null,
        source: 'kernel-authority-record',
        link: entityLink(entity.entityKind, entity.entityId),
      }),
    );
    if (entity.status === 'revoked') {
      rows.push(
        row({
          at: orNull(entity.revokedAt),
          transition: 'revoked',
          targetKind: entity.entityKind,
          targetId: entity.entityId,
          by: orNull(entity.revokedBy),
          reason: orNull(entity.revocationReason),
          source: 'kernel-authority-record',
          link: entityLink(entity.entityKind, entity.entityId),
        }),
      );
    }
  }
  for (const agent of input.agents) {
    for (const credential of agent.credentials) {
      const link = `/agents/${encodeURIComponent(agent.actorId)}`;
      rows.push(
        row({
          at: orNull(credential.createdAt),
          transition: 'credential-issued',
          targetKind: 'agent-credential',
          targetId: credential.credentialId,
          by: orNull(credential.createdBy),
          reason: null,
          source: 'agent-credential-record',
          link,
        }),
      );
      if (credential.status === 'revoked') {
        rows.push(
          row({
            at: orNull(credential.revokedAt),
            transition: 'credential-revoked',
            targetKind: 'agent-credential',
            targetId: credential.credentialId,
            by: orNull(credential.revokedBy),
            reason: orNull(credential.revocationReason),
            source: 'agent-credential-record',
            link,
          }),
        );
      }
    }
  }
  for (const profile of input.profiles) {
    const target = `${profile.profileId}@${profile.version}`;
    if (present(profile.activatedAt) || present(profile.activatedBy)) {
      rows.push(
        row({ at: orNull(profile.activatedAt), transition: 'profile-activated', targetKind: 'governance-profile', targetId: target, by: orNull(profile.activatedBy), reason: null, source: 'profile-lifecycle-record', link: '/profiles' }),
      );
    }
    if (present(profile.retiredAt) || present(profile.retiredBy)) {
      rows.push(
        row({
          at: orNull(profile.retiredAt),
          transition: 'profile-retired',
          targetKind: 'governance-profile',
          targetId: target,
          by: orNull(profile.retiredBy),
          reason: orNull(profile.retirementReason),
          source: 'profile-lifecycle-record',
          link: '/profiles',
        }),
      );
    }
  }
  // Newest first; a row whose time is not recorded is listed last, marked incomplete — never given a time.
  return rows.sort((left, right) => {
    if (left.at === null || right.at === null) return left.at === null ? (right.at === null ? 0 : 1) : -1;
    return left.at < right.at ? 1 : left.at > right.at ? -1 : 0;
  });
}

/** What the evidence view may say about the downstream of a decision, from the decision record's own references. */
export interface DecisionDownstream {
  readonly grants: readonly string[];
  readonly executions: readonly { readonly executionId: string; readonly recorded: readonly string[] }[];
}

export function decisionDownstream(references: readonly { readonly referenceType: string; readonly externalId: string; readonly externalVersion: string | null }[]): DecisionDownstream {
  const grants = references.filter((reference) => reference.referenceType === 'authorization_artifact').map((reference) => reference.externalId);
  const executions = new Map<string, string[]>();
  for (const reference of references) {
    if (reference.referenceType !== 'execution_record') continue;
    const recorded = executions.get(reference.externalId) ?? [];
    recorded.push(reference.externalVersion ?? '(no version recorded)');
    executions.set(reference.externalId, recorded);
  }
  return { grants, executions: [...executions].map(([executionId, recorded]) => ({ executionId, recorded })) };
}
