import { AssuranceError } from './errors.js';
import { applyFindingTransition, buildFindingEvent } from './findings.js';
import type { AssuranceAssessment, AssuranceFinding, AssuranceFindingEvent } from './contracts.js';

/**
 * Finding history integrity (ASSURE-SEC-01E).
 *
 * A completed assessment's findings start their append-only lifecycle with
 * one `AssuranceFindingCreated` event each, persisted in the same unit as the
 * completion (`AssuranceStore.completeAssessment`). These helpers are pure:
 * the stores use the first to refuse an inconsistent completion before
 * writing anything, and the second is a read-only diagnostic over histories
 * already stored, which never repairs or rewrites.
 */

/** What a store persists to complete an assessment: the terminal assessment and the event that opens each finding's history. */
export interface AssuranceCompletionCommit {
  readonly assessment: AssuranceAssessment;
  readonly findingEvents: readonly AssuranceFindingEvent[];
}

/** Whether `event`'s digest recomputes from its own fields (the `buildFindingEvent` digest, not a second algorithm). */
export function findingEventDigestHolds(event: AssuranceFindingEvent): boolean {
  const { eventDigest, ...fields } = event;
  return buildFindingEvent(fields).eventDigest === eventDigest;
}

/**
 * Refuses a completion commit that would leave a finding without its opening
 * event, open one twice, or attach an event to the wrong finding, assessment
 * or organization. Store-independent: each store additionally checks what is
 * already persisted (no earlier events, unique event ids).
 */
export function assertCompletionCommit(commit: AssuranceCompletionCommit): void {
  const { assessment, findingEvents } = commit;
  const fail = (message: string): never => {
    throw new AssuranceError('ASSURANCE_INVALID_FINDING_TRANSITION', `Completion of assessment '${assessment.assessmentId}' refused: ${message}`);
  };
  if (assessment.status !== 'completed') {
    throw new AssuranceError('ASSURANCE_VALIDATION_ERROR', `A completion commit carries a 'completed' assessment, not '${assessment.status}'.`);
  }
  const findingIds = new Set(assessment.findings.map((finding) => finding.findingId));
  const eventIds = new Set<string>();
  const opened = new Set<string>();
  for (const event of findingEvents) {
    if (!findingIds.has(event.findingId)) fail(`an event names finding '${event.findingId}', which the assessment does not contain.`);
    if (eventIds.has(event.findingEventId)) fail(`finding event id '${event.findingEventId}' is repeated.`);
    eventIds.add(event.findingEventId);
    if (opened.has(event.findingId)) fail(`finding '${event.findingId}' is opened twice.`);
    opened.add(event.findingId);
    if (event.assessmentId !== assessment.assessmentId || event.organizationId !== assessment.subject.organizationId) {
      fail(`the event for finding '${event.findingId}' is attributed to another assessment or organization.`);
    }
    if (event.eventType !== 'AssuranceFindingCreated' || event.sequence !== 1) fail(`the event for finding '${event.findingId}' is not its opening event.`);
    if (!findingEventDigestHolds(event)) fail(`the event for finding '${event.findingId}' does not match its digest.`);
  }
  for (const findingId of findingIds) {
    if (!opened.has(findingId)) fail(`finding '${findingId}' has no opening event.`);
  }
}

/**
 * Read-only diagnostic of one finding's stored history: an empty list when
 * the history is complete and consistent. It reports a missing opening event,
 * gaps or repeats in the sequence, repeated event ids, events attributed to
 * another finding, assessment or organization, digests that do not
 * recompute, and impossible transitions. Histories written before
 * ASSURE-SEC-01E may lack their opening event; the diagnostic reports that and
 * changes nothing.
 */
export function findingHistoryViolations(finding: AssuranceFinding, organizationId: string, events: readonly AssuranceFindingEvent[]): readonly string[] {
  const violations: string[] = [];
  if (events.length === 0) return ['missing_opening_event'];
  const seenIds = new Set<string>();
  let status: ReturnType<typeof applyFindingTransition> | undefined;
  events.forEach((event, index) => {
    const at = `event ${index + 1}`;
    if (seenIds.has(event.findingEventId)) violations.push(`${at}: duplicate_event_id`);
    seenIds.add(event.findingEventId);
    if (event.sequence !== index + 1) violations.push(`${at}: sequence_${event.sequence}_expected_${index + 1}`);
    if (event.findingId !== finding.findingId || event.assessmentId !== finding.assessmentId || event.organizationId !== organizationId) violations.push(`${at}: wrong_attribution`);
    if (!findingEventDigestHolds(event)) violations.push(`${at}: digest_mismatch`);
    try {
      status = applyFindingTransition(status, event.eventType);
    } catch {
      violations.push(`${at}: impossible_transition_${event.eventType}`);
    }
  });
  if (events[0]?.eventType !== 'AssuranceFindingCreated') violations.unshift('missing_opening_event');
  return violations;
}
