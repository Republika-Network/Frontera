import type { PolicyPackEventType } from '../../domain-policy-pack-runtime/domain/policy-pack-event.js';
import type { AocTimelineItem } from '../domain/control-plane-timeline.js';
import type { AocTimelineStatus } from '../domain/control-plane-status.js';
import type { EnforcementDecisionRow } from '../domain/control-plane-view-model.js';
import type { PolicyEnforcementLinkRow, PolicyEventRow } from '../domain/policy-pack-view-model.js';

export interface PolicyPackTimelineInput {
  readonly events: readonly PolicyEventRow[];
  readonly enforcementLinks: readonly PolicyEnforcementLinkRow[];
  readonly enforcementDecisions: readonly EnforcementDecisionRow[];
}

function titleCase(value: string): string {
  return value
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

const POLICY_EVENT_STATUS: Readonly<Record<PolicyPackEventType, AocTimelineStatus>> = {
  policy_pack_registered: 'info',
  policy_pack_version_activated: 'success',
  policy_pack_version_deprecated: 'warning',
  policy_pack_version_revoked: 'danger',
  policy_pack_version_superseded: 'warning',
  policy_pack_registry_frozen: 'warning',
  policy_evaluation_started: 'info',
  policy_pack_applicability_resolved: 'info',
  policy_rule_matched: 'info',
  policy_rule_not_matched: 'info',
  policy_decision_created: 'info',
  policy_proof_created: 'info',
  policy_simulation_started: 'info',
  policy_simulation_completed: 'info',
};

function statusForPolicyEventType(type: string): AocTimelineStatus {
  return (POLICY_EVENT_STATUS as Readonly<Record<string, AocTimelineStatus>>)[type] ?? 'info';
}

function normalizePolicyEvent(event: PolicyEventRow): AocTimelineItem {
  return {
    id: event.id,
    source: 'policy',
    type: event.type,
    title: titleCase(event.type),
    description: event.summary,
    status: statusForPolicyEventType(event.type),
    timestamp: event.timestamp,
    ...(event.actorId !== undefined ? { actorId: event.actorId } : {}),
    ...(event.decisionId !== undefined ? { relatedDecisionId: event.decisionId } : {}),
    ...(event.proofId !== undefined ? { relatedProofId: event.proofId } : {}),
  };
}

/**
 * Converts policy-blocked enforcement decisions (PolicyEnforcementLinkRow
 * where `blockedByPolicy` is true) into timeline items. Never fabricates a
 * timestamp: falls back to skipping the item entirely if the referenced
 * EnforcementDecision -- and therefore its `decidedAt` -- cannot be found,
 * rather than inventing one.
 */
function normalizeBlockedEnforcementLinks(links: readonly PolicyEnforcementLinkRow[], decisionsById: ReadonlyMap<string, EnforcementDecisionRow>): AocTimelineItem[] {
  const items: AocTimelineItem[] = [];
  for (const link of links) {
    if (!link.blockedByPolicy || link.enforcementDecisionId === undefined) continue;
    const decision = decisionsById.get(link.enforcementDecisionId);
    if (decision === undefined) continue;

    items.push({
      id: `policy-blocked-${link.id}`,
      source: 'policy',
      type: 'policy_pack_blocked_execution',
      title: 'Policy Pack Blocked Execution',
      description: link.reason ?? `Action ${link.action} for ${link.actorId} was blocked by policy pack evaluation.`,
      actorId: link.actorId,
      action: link.action,
      resourceScope: link.resourceScope,
      status: 'danger',
      timestamp: decision.decidedAt,
      relatedDecisionId: link.enforcementDecisionId,
      ...(link.enforcementProofId !== undefined ? { relatedProofId: link.enforcementProofId } : link.policyProofId !== undefined ? { relatedProofId: link.policyProofId } : {}),
    });
  }
  return items;
}

function compareTimelineItems(a: AocTimelineItem, b: AocTimelineItem): number {
  if (a.timestamp !== b.timestamp) {
    return a.timestamp < b.timestamp ? 1 : -1;
  }
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

/**
 * Builds the policy-pack slice of the Control Plane timeline: real
 * PolicyPackEvents plus policy-blocked enforcement decisions, sorted
 * newest-first exactly like the main AocTimeline. Nothing here is invented
 * -- every item traces back to a PolicyPackEvent or an EnforcementDecision
 * that already carries policy metadata.
 */
export function buildPolicyPackTimeline(input: PolicyPackTimelineInput): AocTimelineItem[] {
  const decisionsById = new Map(input.enforcementDecisions.map((decision) => [decision.id, decision]));
  const items: AocTimelineItem[] = [...input.events.map(normalizePolicyEvent), ...normalizeBlockedEnforcementLinks(input.enforcementLinks, decisionsById)];
  return items.sort(compareTimelineItems);
}
