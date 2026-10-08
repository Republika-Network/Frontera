import type { AuthorityTrace } from '../evidence/trace-contracts.js';
import { TRACE_DISCLOSURE_REDACTED_VALUE, type DisclosedAuthorityTrace } from '../evidence/trace-disclosure.js';
import { OPERATOR_ATTESTATION_AUTHORITY_ID } from '../execution-reconciliation/operator-attestation.js';
import type {
  AttentionReason,
  DisclosedOperationalView,
  OperationalExecutionView,
  OperationalOutcomeSource,
  OperationalOutcomeStatus,
  OperationalResolutionView,
  OperationalState,
  OperationalViewSection,
} from './contracts.js';

/**
 * PROD-03-01 — the one classification of a governed request, a pure function
 * of its canonical ASSURE-01 trace. Deterministic: the same trace always
 * classifies the same way; no clock, no store, no configuration.
 *
 * It restates `trace.finalState` in operational terms and reads three stages
 * to split what the final state deliberately leaves together
 * (`not-executed`: withheld at issuance, authorized and not claimed, or never
 * authorized). It never re-derives anything the trace builder decided.
 */
export function classifyAuthorityTrace(trace: AuthorityTrace): OperationalState {
  switch (trace.finalState) {
    case 'denied':
      return 'decision-denied';
    case 'indeterminate':
      return 'decision-indeterminate';
    case 'approval-pending':
      return 'approval-pending';
    case 'not-executed': {
      const authority = trace.stages.authority;
      // A grant on record is the latest fact: an earlier withholding (a retry
      // that later met its obligations) does not undo an issued grant.
      if (authority.grants.length > 0) return 'authorized-not-claimed';
      if (authority.issuance !== undefined) return 'issuance-withheld';
      return trace.path === 'approval_required' ? 'approval-not-resumed' : 'allowed-not-authorized';
    }
    case 'withheld-at-exercise':
      return 'withheld-at-exercise';
    case 'executed-confirmed-completed':
    case 'resolved-confirmed-completed':
      return 'executed-succeeded';
    case 'executed-confirmed-not-completed':
    case 'resolved-confirmed-not-completed':
      return 'executed-failed';
    case 'executed-unconfirmed':
      return 'claimed-outcome-unconfirmed';
    case 'claimed-outcome-unrecorded':
      return 'claimed-no-outcome';
    case 'unverifiable':
      return 'trace-unverifiable';
    case 'inconsistent':
      return 'trace-inconsistent';
    default: {
      const unreachable: never = trace.finalState;
      return unreachable;
    }
  }
}

const ATTENTION_OF: Readonly<Partial<Record<OperationalState, AttentionReason>>> = Object.freeze({
  'claimed-no-outcome': 'EXECUTION_CLAIMED_NO_OUTCOME',
  'claimed-outcome-unconfirmed': 'EXECUTION_OUTCOME_UNCONFIRMED',
  'trace-unverifiable': 'TRACE_UNVERIFIABLE',
  'trace-inconsistent': 'TRACE_INCONSISTENT',
  'trace-unavailable': 'TRACE_UNAVAILABLE',
});

/** The attention a classification carries. Total over the closed state set; every state not named in `ATTENTION_OF` carries none. */
export function attentionReasonsOf(state: OperationalState): readonly AttentionReason[] {
  const reason = ATTENTION_OF[state];
  return reason === undefined ? [] : [reason];
}

/** States whose execution has a definitive answer. */
const DEFINITIVE: ReadonlySet<OperationalState> = new Set<OperationalState>(['executed-succeeded', 'executed-failed', 'withheld-at-exercise']);

const OUTCOME_OF: Readonly<Partial<Record<OperationalState, OperationalOutcomeStatus>>> = Object.freeze({
  'executed-succeeded': 'confirmed-completed',
  'executed-failed': 'confirmed-not-completed',
  'withheld-at-exercise': 'withheld',
  'claimed-outcome-unconfirmed': 'unconfirmed',
});

/** What the Governance Store summary says, for a record whose trace could not be built. */
export interface OperationalRecordSummary {
  readonly requestId: string;
  readonly evaluationId: string;
  readonly decisionId: string;
  readonly actorId: string;
  readonly actionType: string;
  readonly status: string;
  readonly reasonCodes: readonly string[];
  readonly evaluatedAt: string;
  readonly persistedAt: string;
}

/** States an operator may resolve: a claim with no definitive outcome, and nothing else (PROD-03-02). */
const RESOLVABLE: ReadonlySet<OperationalState> = new Set<OperationalState>(['claimed-no-outcome', 'claimed-outcome-unconfirmed']);

/** PROD-03-02 — what the view states about operator resolution. `attestation`: this Host composes operator attestation. */
export interface OperationalViewOptions {
  readonly attestation?: boolean;
}

/**
 * The operator view of one governed request, from its canonical trace and the
 * record summary. Pure. `resolvable` is `false` unless `options.attestation`
 * says this Host can record an operator resolution at all.
 */
export function operationalViewOf(trace: AuthorityTrace, summary: OperationalRecordSummary, options: OperationalViewOptions = {}): OperationalExecutionView {
  const classification = classifyAuthorityTrace(trace);
  const attentionReasons = attentionReasonsOf(classification);
  const { approval, authority, execution, outcome, resolution, decision } = trace.stages;
  const claimRecorded = execution.claim?.presence === 'recorded';
  const resolved = resolution.resolution;

  const issuance: OperationalExecutionView['issuance'] =
    trace.path === 'denied' || trace.path === 'indeterminate'
      ? { status: 'not-applicable', withheldBy: null, reasonCodes: [], recordedAt: null }
      : authority.grants.length > 0
        ? { status: 'issued', withheldBy: null, reasonCodes: [], recordedAt: authority.grants[0]?.issuedAt ?? null }
        : authority.issuance !== undefined
          ? { status: 'withheld', withheldBy: authority.issuance.withheldBy, reasonCodes: [...authority.issuance.reasonCodes], recordedAt: authority.issuance.recordedAt }
          : { status: classification === 'trace-unverifiable' || classification === 'trace-inconsistent' ? 'unknown' : 'not-reached', withheldBy: null, reasonCodes: [], recordedAt: null };

  const source: OperationalOutcomeSource | null =
    resolved !== undefined ? 'resolution' : outcome.legacy === true ? 'legacy-summary' : outcome.presence === 'recorded' ? 'initial-observation' : null;

  // PROD-03-02: an operator attestation is named as one, never as the provider's confirmation.
  const resolutionView: OperationalResolutionView | null =
    resolved === undefined || (resolved.certainty !== 'confirmed-completed' && resolved.certainty !== 'confirmed-not-completed')
      ? null
      : {
          resolvedBy: resolved.authorityId === OPERATOR_ATTESTATION_AUTHORITY_ID ? 'operator-attestation' : 'resolution-authority',
          attestedBy: resolved.attestedBy ?? null,
          certainty: resolved.certainty,
          failure: resolved.failure ?? null,
          resolvedAt: resolved.resolvedAt,
        };
  // The binding decides who may resolve: unbound (adopted on resolution) or bound to attestation, never another authority's.
  const boundAuthority = resolution.binding?.authorityId;
  const resolvable =
    options.attestation === true &&
    RESOLVABLE.has(classification) &&
    trace.executionId !== undefined &&
    resolved === undefined &&
    resolution.presence === 'unresolved' &&
    (boundAuthority === undefined || boundAuthority === OPERATOR_ATTESTATION_AUTHORITY_ID);

  return {
    requestId: trace.requestId,
    evaluationId: trace.evaluationId,
    decisionId: trace.decisionId,
    executionId: trace.executionId ?? null,
    actorId: trace.stages.request.actorId,
    actionType: trace.stages.request.actionType,
    classification,
    attentionRequired: attentionReasons.length > 0,
    attentionReasons,
    unresolved: claimRecorded && !DEFINITIVE.has(classification),
    decision: { status: decision.status, reasonCodes: [...decision.reasonCodes], evaluatedAt: decision.evaluatedAt, persistedAt: summary.persistedAt },
    approval: trace.path === 'approval_required' ? { presence: approval.presence, verdicts: approval.records.map((record) => record.kind) } : null,
    issuance,
    execution: {
      claim: claimRecorded ? 'recorded' : classification === 'trace-unverifiable' || classification === 'trace-inconsistent' ? 'unknown' : 'absent',
      claimedAt: execution.claim?.claimedAt ?? null,
    },
    outcome: {
      status: OUTCOME_OF[classification] ?? 'none',
      source: OUTCOME_OF[classification] === undefined ? null : source,
      failure: resolved?.failure ?? outcome.failure ?? null,
      withheldBy: outcome.kind === 'withheld' ? (outcome.withheldBy ?? null) : null,
      reasonCodes: outcome.kind === 'withheld' ? [...(outcome.reasonCodes ?? [])] : [],
      recordedAt: resolved?.resolvedAt ?? outcome.recordedAt ?? null,
    },
    trace: { available: true, finalState: trace.finalState, failure: null },
    resolution: resolutionView,
    resolvable,
  };
}

/**
 * A record whose trace could not be built: the summary is all that is known,
 * and the request needs attention because nothing downstream of the decision
 * can be stated. `failure` is a closed code, never a message.
 */
export function operationalViewWithoutTrace(summary: OperationalRecordSummary, failure: string): OperationalExecutionView {
  return {
    requestId: summary.requestId,
    evaluationId: summary.evaluationId,
    decisionId: summary.decisionId,
    executionId: null,
    actorId: summary.actorId,
    actionType: summary.actionType,
    classification: 'trace-unavailable',
    attentionRequired: true,
    attentionReasons: attentionReasonsOf('trace-unavailable'),
    unresolved: false,
    decision: { status: summary.status, reasonCodes: [...summary.reasonCodes], evaluatedAt: summary.evaluatedAt, persistedAt: summary.persistedAt },
    approval: null,
    issuance: { status: 'unknown', withheldBy: null, reasonCodes: [], recordedAt: null },
    execution: { claim: 'unknown', claimedAt: null },
    outcome: { status: 'none', source: null, failure: null, withheldBy: null, reasonCodes: [], recordedAt: null },
    trace: { available: false, finalState: null, failure },
    resolution: null,
    resolvable: false,
  };
}

/** A Kernel decision recorded by the evaluate route: no governed path, nothing to classify beyond the decision, never attention. */
export function operationalViewOfEvaluation(summary: OperationalRecordSummary): OperationalExecutionView {
  return {
    ...operationalViewWithoutTrace(summary, 'NOT_A_GOVERNED_REQUEST'),
    classification: 'evaluation-only',
    attentionRequired: false,
    attentionReasons: [],
    issuance: { status: 'not-applicable', withheldBy: null, reasonCodes: [], recordedAt: null },
    execution: { claim: 'absent', claimedAt: null },
  };
}

/** States that split the trace's `not-executed` by reading the authority stage (`classifyAuthorityTrace`): only a level that discloses that stage may state them. */
const READ_FROM_AUTHORITY: ReadonlySet<OperationalState> = new Set<OperationalState>(['issuance-withheld', 'authorized-not-claimed', 'allowed-not-authorized', 'approval-not-resumed']);

/**
 * The operational view beside a disclosed trace, reduced to what that trace
 * discloses. Pure. Each section is kept only when the disclosed trace carries
 * the stage it was read from (present and not redacted); everything else the
 * view states — the final state, the attention it implies, the identities — is
 * already in the disclosed summary and identities. Throws when the disclosed
 * trace has no summary: every operator level discloses it.
 */
export function discloseOperationalView(view: OperationalExecutionView, disclosed: DisclosedAuthorityTrace): DisclosedOperationalView {
  if (typeof disclosed.summary !== 'object') throw new Error('discloseOperationalView: the disclosure level hides the trace summary.');
  const shows = (stage: string): boolean => disclosed.stages[stage as keyof typeof disclosed.stages] !== undefined && disclosed.stages[stage as keyof typeof disclosed.stages] !== TRACE_DISCLOSURE_REDACTED_VALUE;
  const visible: Readonly<Record<OperationalViewSection, boolean>> = {
    request: shows('request'),
    decision: shows('decision'),
    approval: shows('approval'),
    issuance: shows('authority'),
    execution: shows('execution'),
    outcome: shows('outcome') && shows('resolution'),
  };
  const hidden = (Object.keys(visible) as OperationalViewSection[]).filter((section) => !visible[section]);
  if (hidden.length === 0) return { ...view, hidden: [] };
  return {
    requestId: view.requestId,
    evaluationId: view.evaluationId,
    decisionId: view.decisionId,
    executionId: view.executionId,
    classification: !visible.issuance && READ_FROM_AUTHORITY.has(view.classification) ? null : view.classification,
    attentionRequired: view.attentionRequired,
    attentionReasons: view.attentionReasons,
    unresolved: visible.execution ? view.unresolved : null,
    trace: view.trace,
    ...(visible.request ? { actorId: view.actorId, actionType: view.actionType } : {}),
    ...(visible.decision ? { decision: { status: view.decision.status, reasonCodes: view.decision.reasonCodes, evaluatedAt: view.decision.evaluatedAt } } : {}),
    ...(visible.approval ? { approval: view.approval } : {}),
    ...(visible.issuance ? { issuance: view.issuance } : {}),
    ...(visible.execution ? { execution: view.execution } : {}),
    ...(visible.outcome ? { outcome: view.outcome } : {}),
    // PROD-03-02: who closed it is mechanism (the authority stage) and people (the approval stage, where human identities are governed).
    ...(visible.outcome
      ? {
          resolution:
            view.resolution === null
              ? null
              : { ...view.resolution, resolvedBy: shows('authority') ? view.resolution.resolvedBy : null, attestedBy: shows('approval') ? view.resolution.attestedBy : null },
        }
      : {}),
    ...(visible.execution && visible.issuance ? { resolvable: view.resolvable } : {}),
    hidden,
  };
}
