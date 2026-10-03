import type { ReadBoundedGrantResult } from '../../features/grant-runtime/index.js';
import { exerciseReservationId, type ExerciseReservationView } from '../../features/exercise-control-runtime/index.js';
import type { StoredApprovalRecord } from '../approval-authority/contracts.js';
import type { AuthorityEvent, AuthorityEventStreamBoundedRead, AuthorityEventStreamVerification } from '../authority-event-stream/contracts.js';
import { deriveAuthorityEventStreamId } from '../authority-event-stream/identifiers.js';
import type { ExecutionOutcomeRecord } from '../execution-outcome-store/contracts.js';
import type { ExecutionResolutionState } from '../execution-resolution-store/contracts.js';
import type { GovernanceRecord, GovernanceRecordVerificationResult, GovernanceReferenceRecord, GovernanceStoreAccessContext } from '../governance-store/contracts.js';
import { computeDigest } from '../governance-store/digest.js';
import { authorizationReferenceId, deriveGovernedActionExecutionId, executionAttemptReferenceId, executionOutcomeReferenceId, executionResolutionReferenceId } from '../governed-action/identifiers.js';
import type { StoredObligationDischarge, ObligationDischargeCorrelation } from '../obligation-discharge/contracts.js';
import { EvidenceError } from './errors.js';
import {
  AUTHORITY_TRACE_LIMITS,
  AUTHORITY_TRACE_VERIFICATION_BOUNDARY,
  AUTHORITY_TRACE_VERIFICATION_VERSION,
  AUTHORITY_TRACE_VERSION,
  GOVERNED_REQUEST_ID_PATTERN,
  type AuthorityTrace,
  type AuthorityTraceApprovalStage,
  type AuthorityTraceAuthorityStage,
  type AuthorityTraceCheck,
  type AuthorityTraceCheckCategory,
  type AuthorityTraceDecisionPath,
  type AuthorityTraceEventStage,
  type AuthorityTraceExecutionStage,
  type AuthorityTraceFinalState,
  type AuthorityTraceGrant,
  type AuthorityTraceObligationStage,
  type AuthorityTraceOutcomeStage,
  type AuthorityTraceParameterStage,
  type AuthorityTracePresence,
  type AuthorityTraceReservationStage,
  type AuthorityTraceResolutionStage,
  type AuthorityTraceVerification,
} from './trace-contracts.js';

/**
 * ASSURE-01 — builds one request's trace from the canonical stores, and records
 * every check it made on the way.
 *
 * Every source is a **read-only port**: the narrowest read the owning store
 * already exposes, each verifying its own integrity (and, where the artifact is
 * signed, its signature) before it returns anything. Nothing here appends,
 * signs, approves, discharges, revokes, reserves, reconciles or executes —
 * `trace-structure.test.ts` proves no write capability is reachable from it.
 */
export interface AuthorityTraceSources {
  readonly governance: {
    getByRequestId(context: GovernanceStoreAccessContext, requestId: string): Promise<GovernanceRecord | null>;
    verify(context: GovernanceStoreAccessContext, evaluationId: string): Promise<GovernanceRecordVerificationResult>;
  };
  /** The authoritative grant read. `kind` is the composed store's posture (`authenticated-durable` verifies Ed25519 signatures on every read). */
  readonly grants?: { readonly kind: string; read(grantId: string): Promise<ReadBoundedGrantResult> };
  readonly approvals?: { readonly kind: string; read(organizationId: string, requestId: string): Promise<readonly StoredApprovalRecord[]> };
  readonly obligations?: { readonly kind: string; read(organizationId: string, correlation: ObligationDischargeCorrelation): Promise<readonly StoredObligationDischarge[]> };
  readonly reservations?: { read(reservationId: string): Promise<ExerciseReservationView | undefined> };
  readonly outcomes?: { read(context: { readonly organizationId: string }, executionId: string): Promise<ExecutionOutcomeRecord | undefined> };
  readonly resolutions?: { read(context: { readonly organizationId: string }, executionId: string): Promise<ExecutionResolutionState | undefined> };
  /** The event stream through its **bounded** read only: the store refuses a stream over the trace bound before loading any of it. */
  readonly events?: {
    readStreamBounded(context: { readonly organizationId: string }, streamId: string, options: { readonly maxEvents: number }): Promise<AuthorityEventStreamBoundedRead>;
  };
}

export interface AuthorityTraceBuild {
  readonly trace: AuthorityTrace;
  /** The Governance Record the trace was built over (internal: never serialized to a caller). */
  readonly record: GovernanceRecord;
  /** Digest of the canonical trace (`aoc.canonical-json.v1`, SHA-256). */
  readonly traceDigest: string;
  readonly checks: readonly AuthorityTraceCheck[];
}

/** Closed failure codes reported in place of an exception's text, so no store message (or path) reaches a third party. */
function failureCode(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error && typeof (error as { code: unknown }).code === 'string') return (error as { code: string }).code;
  return 'READ_FAILED';
}

/** Validates the lookup identity. A malformed id is refused before any store is read. */
export function validateTraceRequestId(requestId: unknown): string {
  if (typeof requestId !== 'string' || !GOVERNED_REQUEST_ID_PATTERN.test(requestId)) {
    throw new EvidenceError('EVIDENCE_VALIDATION_ERROR', 'requestId must be a governed request identity (aoc.gar:<32 lowercase hex>).');
  }
  return requestId;
}

function traceTooLarge(component: string): EvidenceError {
  return new EvidenceError('EVIDENCE_TRACE_TOO_LARGE', `The canonical ${component} for this request exceed the trace bound; the trace is refused rather than truncated.`);
}

/**
 * Builds the trace, or `null` when no governed request with this id exists in
 * the caller's scope (the Governance Store enforces the scope). Throws only for
 * a malformed id, an over-bound request, or a Governance Store failure.
 */
export async function buildAuthorityTrace(sources: AuthorityTraceSources, context: GovernanceStoreAccessContext, rawRequestId: string): Promise<AuthorityTraceBuild | null> {
  const requestId = validateTraceRequestId(rawRequestId);
  const located = await sources.governance.getByRequestId(context, requestId);
  if (located === null) return null;
  const organizationId = located.request.organizationId;
  // A trace is a governed request's: one bound to an organization. Anything
  // else is not a request this surface describes.
  if (organizationId === undefined || located.request.requestId !== requestId) return null;
  if (!context.system && context.organizationId !== organizationId) return null;
  const scope = { organizationId };

  const checks: AuthorityTraceCheck[] = [];
  const check = (name: string, category: AuthorityTraceCheckCategory, ok: boolean | 'n/a', detail?: string): void => {
    checks.push({ check: name, category, status: ok === 'n/a' ? 'not-applicable' : ok ? 'pass' : 'fail', ...(detail !== undefined ? { detail } : {}) });
  };

  // -- P8 first ----------------------------------------------------------------
  // Every event is written strictly after the canonical fact it reports. Reading
  // the stream before any canonical store therefore guarantees that each event
  // read describes a fact that is already committed when its store is read —
  // a fact committing mid-build can never seal a false contradiction.
  const streamId = deriveAuthorityEventStreamId({ organizationId, requestId });
  let streamVerification: AuthorityEventStreamVerification | undefined;
  let stream: readonly AuthorityEvent[] = [];
  let streamReadFailure: string | undefined;
  if (sources.events !== undefined) {
    try {
      // One bounded read: the store sizes the stream before loading it and
      // refuses one over the trace bound — the trace is complete or refused.
      const read = await sources.events.readStreamBounded(scope, streamId, { maxEvents: AUTHORITY_TRACE_LIMITS.maxEvents });
      if (read.outcome === 'exceeds-bound') throw traceTooLarge('authority events');
      streamVerification = read.verification;
      check('integrity.event-stream', 'integrity', streamVerification.valid, streamVerification.valid ? undefined : 'EVENT_STREAM_CHAIN_INVALID');
      if (streamVerification.valid) stream = read.events;
    } catch (error) {
      if (error instanceof EvidenceError) throw error;
      streamReadFailure = failureCode(error);
      check('integrity.event-stream', 'integrity', false, streamReadFailure);
    }
  }
  // Then the Governance Record again: every canonical read happens after the stream.
  const record = await sources.governance.getByRequestId(context, requestId);
  if (record === null || record.request.requestId !== requestId || record.request.organizationId !== organizationId || record.evaluation.evaluationId !== located.evaluation.evaluationId) {
    throw new EvidenceError('EVIDENCE_STORE_UNAVAILABLE', 'The Governance Record of this request changed identity while its trace was being built.');
  }

  const evaluationId = record.evaluation.evaluationId;
  const decisionId = record.evaluation.decisionId;
  const path = record.evaluation.status as AuthorityTraceDecisionPath;
  const executable = path === 'allowed' || path === 'approval_required';
  const executionId = executable ? deriveGovernedActionExecutionId({ requestId, decisionId }) : undefined;

  // -- contract and identity ------------------------------------------------
  check('trace.request-id-format', 'contract', true);
  check('trace.decision-status-known', 'contract', ['allowed', 'denied', 'approval_required', 'indeterminate'].includes(path), path);
  check('identity.governance-record-request', 'correlation', record.evaluation.requestId === requestId && record.request.requestId === requestId);

  // -- governance record -----------------------------------------------------
  let governanceVerification: GovernanceRecordVerificationResult | undefined;
  try {
    governanceVerification = await sources.governance.verify(context, evaluationId);
  } catch (error) {
    check('integrity.governance-record', 'integrity', false, failureCode(error));
  }
  if (governanceVerification !== undefined) {
    check('integrity.governance-record', 'integrity', governanceVerification.valid, governanceVerification.valid ? undefined : governanceVerification.failures.map((failure) => failure.check).join(','));
  }

  // -- the Governance execution ledger's references --------------------------
  const references = record.references;
  const authorizationRefs = references.filter((entry) => entry.referenceType === 'authorization_artifact');
  const executionRefs = references.filter((entry) => entry.referenceType === 'execution_record');
  if (authorizationRefs.length > AUTHORITY_TRACE_LIMITS.maxGrants) throw traceTooLarge('grants');
  const byId = (id: string | undefined): GovernanceReferenceRecord | undefined => (id === undefined ? undefined : references.find((entry) => entry.referenceId === id && entry.externalId === executionId));
  const claimRef = executionId === undefined ? undefined : byId(executionAttemptReferenceId(executionId));
  const outcomeRef = executionId === undefined ? undefined : byId(executionOutcomeReferenceId(executionId));
  const resolutionRef = executionId === undefined ? undefined : byId(executionResolutionReferenceId(executionId));

  check(
    'correlation.authorization-references',
    'correlation',
    authorizationRefs.every((entry) => entry.referenceId === authorizationReferenceId({ evaluationId, grantId: entry.externalId })),
  );
  check('correlation.execution-references', 'correlation', executionRefs.every((entry) => entry.externalId === executionId), executionRefs.length === 0 ? 'none' : undefined);
  if (!executable) {
    check('correlation.no-authority-on-non-executable-decision', 'correlation', authorizationRefs.length === 0 && executionRefs.length === 0, path);
  }

  // -- approval ---------------------------------------------------------------
  let approval: AuthorityTraceApprovalStage;
  if (sources.approvals === undefined) {
    approval = { presence: path === 'approval_required' ? 'not-composed' : 'not-applicable', records: [] };
    check('completeness.approval', 'completeness', path === 'approval_required' && authorizationRefs.length > 0 ? false : 'n/a', 'approval-store-not-composed');
  } else {
    try {
      const rows = await sources.approvals.read(organizationId, requestId);
      if (rows.length > AUTHORITY_TRACE_LIMITS.maxApprovalRecords) throw traceTooLarge('approval records');
      const records = rows.map((row) => ({
        sequence: row.sequence,
        kind: row.kind,
        decisionId: row.decisionId,
        subjectDigest: row.subjectDigest,
        ...(row.actorId !== undefined ? { actorId: row.actorId } : {}),
        recordedBy: row.recordedBy,
        recordedAt: row.recordedAt,
        digest: row.digest,
      }));
      check('correlation.approval-records', 'correlation', rows.every((row) => row.requestId === requestId && row.organizationId === organizationId && row.decisionId === decisionId));
      check('authenticity.approval-log', 'authenticity', sources.approvals.kind === 'durable-authenticated' ? true : 'n/a', sources.approvals.kind);
      if (path !== 'approval_required') check('correlation.approval-only-on-approval-path', 'correlation', rows.length === 0, path);
      approval = {
        presence: rows.length > 0 ? 'recorded' : path === 'approval_required' ? 'none-recorded' : 'not-applicable',
        storeKind: sources.approvals.kind,
        records,
      };
      if (path === 'approval_required') {
        check('completeness.approval-before-authority', 'completeness', authorizationRefs.length === 0 || rows.some((row) => row.kind === 'approved'), authorizationRefs.length === 0 ? 'no-grant' : undefined);
      }
    } catch (error) {
      if (error instanceof EvidenceError) throw error;
      approval = { presence: 'unreadable', storeKind: sources.approvals.kind, records: [] };
      check('integrity.approval-log', 'integrity', false, failureCode(error));
    }
  }

  // -- obligations -----------------------------------------------------------
  let obligations: AuthorityTraceObligationStage;
  if (sources.obligations === undefined) {
    obligations = { presence: executable ? 'not-composed' : 'not-applicable', discharges: [] };
  } else {
    const correlation: ObligationDischargeCorrelation = { requestId, action: record.request.actionType, resourceScope: record.request.resourceScope };
    try {
      const rows = await sources.obligations.read(organizationId, correlation);
      if (rows.length > AUTHORITY_TRACE_LIMITS.maxObligationDischarges) throw traceTooLarge('obligation discharges');
      check(
        'correlation.obligation-discharges',
        'correlation',
        rows.every((row) => row.organizationId === organizationId && row.correlation.requestId === requestId && row.correlation.action === correlation.action && row.correlation.resourceScope === correlation.resourceScope),
      );
      check('authenticity.obligation-log', 'authenticity', sources.obligations.kind === 'durable-authenticated' ? true : 'n/a', sources.obligations.kind);
      obligations = {
        presence: rows.length > 0 ? 'recorded' : executable ? 'none-recorded' : 'not-applicable',
        storeKind: sources.obligations.kind,
        discharges: rows.map((row) => ({
          sequence: row.sequence,
          obligationType: row.obligationType,
          sourceId: row.sourceId,
          outcome: row.outcome,
          observedAt: row.observedAt,
          recordedBy: row.recordedBy,
          recordedAt: row.recordedAt,
          digest: row.digest,
        })),
      };
    } catch (error) {
      if (error instanceof EvidenceError) throw error;
      obligations = { presence: 'unreadable', storeKind: sources.obligations.kind, discharges: [] };
      check('integrity.obligation-log', 'integrity', false, failureCode(error));
    }
  }

  // -- P11 attempt (read early: it names the exercised grant) ---------------
  let outcomeRecord: ExecutionOutcomeRecord | undefined;
  let outcomeReadFailure: string | undefined;
  if (executionId !== undefined && sources.outcomes !== undefined) {
    try {
      outcomeRecord = await sources.outcomes.read(scope, executionId);
    } catch (error) {
      outcomeReadFailure = failureCode(error);
      check('integrity.execution-outcome', 'integrity', false, outcomeReadFailure);
    }
  }
  const attempt = outcomeRecord?.attempt;
  const terminal = outcomeRecord?.terminal;
  // An execution claimed and answered before P11 existed: the Governance
  // outcome summary (no digest) is its only — and its replay — record. It is
  // shown as that summary, never as an execution with no answer.
  const legacySummary =
    executionId !== undefined && claimRef !== undefined && attempt === undefined && outcomeReadFailure === undefined && sources.outcomes !== undefined && outcomeRef?.externalVersion !== undefined && outcomeRef.digest === undefined
      ? outcomeRef.externalVersion
      : undefined;
  if (legacySummary !== undefined) check('contract.pre-p11-execution-summary', 'contract', true, 'legacy-governance-summary');

  // -- authority: grants and revocations ---------------------------------------
  const grantIds = [...new Set([...authorizationRefs.map((entry) => entry.externalId), ...(attempt !== undefined ? [attempt.boundedGrantId] : [])])].sort();
  const grants: AuthorityTraceGrant[] = [];
  for (const grantId of grantIds) {
    const reference = authorizationRefs.find((entry) => entry.externalId === grantId);
    const exercised = attempt?.boundedGrantId === grantId;
    const base = { grantId, exercised, ...(reference?.digest !== undefined ? { referenceDigest: reference.digest } : {}) };
    if (reference === undefined) check(`correlation.exercised-grant-authorized:${grantId}`, 'correlation', false, 'attempt-names-unreferenced-grant');
    if (sources.grants === undefined) {
      grants.push({ ...base, presence: 'not-composed' });
      continue;
    }
    try {
      const read = await sources.grants.read(grantId);
      if (read.grant === undefined) {
        grants.push({ ...base, presence: 'missing' });
        check(`completeness.grant:${grantId}`, 'completeness', false, 'grant-referenced-but-absent');
        continue;
      }
      const grant = read.grant;
      // The grant's subject is the requesting actor; it is checked, never disclosed
      // (it would re-expose "who asked" under a policy that hides the request).
      check(
        `correlation.grant:${grantId}`,
        'correlation',
        grant.id === grantId && grant.correlation.requestId === requestId && grant.correlation.decisionId === decisionId && grant.subject === record.request.actorId,
      );
      if (reference?.digest !== undefined) check(`integrity.grant-reference-digest:${grantId}`, 'integrity', reference.digest === grant.digest);
      check(`authenticity.grant-signature:${grantId}`, 'authenticity', sources.grants.kind === 'authenticated-durable' ? true : 'n/a', sources.grants.kind);
      grants.push({
        ...base,
        presence: 'recorded',
        grantDigest: grant.digest,
        issuedAt: grant.issuedAt,
        expiresAt: grant.expiresAt,
        sourceDigest: grant.sourceDigest,
        ...(grant.authorityBindingDigest !== undefined ? { authorityBindingDigest: grant.authorityBindingDigest } : {}),
        ...(grant.semanticsFormat !== undefined ? { semanticsFormat: grant.semanticsFormat } : {}),
        ...(read.revocation !== undefined ? { revocation: { revokedAt: read.revocation.revokedAt, reason: read.revocation.reason, issuerRef: read.revocation.issuerRef } } : {}),
      });
      if (read.revocation !== undefined) check(`correlation.revocation:${grantId}`, 'correlation', read.revocation.grantId === grantId);
    } catch (error) {
      grants.push({ ...base, presence: 'unreadable', failure: failureCode(error) });
      check(`authenticity.grant-signature:${grantId}`, 'authenticity', false, failureCode(error));
    }
  }
  // A write-ahead claim is only ever made under an issued grant: a claim with no grant is a missing grant.
  if (claimRef !== undefined && grants.length === 0) check('completeness.grant-for-claim', 'completeness', false, 'claim-without-authorization');
  const authority: AuthorityTraceAuthorityStage = {
    presence: !executable ? 'not-applicable' : grants.length === 0 ? (claimRef !== undefined ? 'missing' : 'not-reached') : grants.some((grant) => grant.presence === 'unreadable') ? 'unreadable' : grants.some((grant) => grant.presence === 'missing') ? 'missing' : grants.every((grant) => grant.presence === 'not-composed') ? 'not-composed' : 'recorded',
    ...(sources.grants !== undefined ? { storeKind: sources.grants.kind } : {}),
    grants,
  };

  // -- execution: write-ahead claim and the P11 attempt -----------------------
  let execution: AuthorityTraceExecutionStage;
  let parameters: AuthorityTraceParameterStage;
  if (executionId === undefined) {
    execution = { presence: 'not-applicable' };
    parameters = { presence: 'not-applicable' };
  } else {
    let attemptPresence: AuthorityTracePresence;
    if (sources.outcomes === undefined) attemptPresence = 'not-composed';
    else if (outcomeReadFailure !== undefined) attemptPresence = 'unreadable';
    else if (attempt !== undefined) attemptPresence = 'recorded';
    else if (legacySummary !== undefined) attemptPresence = 'none-recorded';
    else attemptPresence = claimRef !== undefined ? 'missing' : 'not-reached';
    if (attemptPresence === 'missing') check('completeness.execution-attempt', 'completeness', false, 'claimed-without-attempt');
    if (attempt !== undefined) {
      check(
        'correlation.execution-attempt',
        'correlation',
        attempt.executionId === executionId && attempt.requestId === requestId && attempt.decisionId === decisionId && attempt.evaluationId === evaluationId && attempt.organizationId === organizationId,
      );
    }
    execution = {
      presence: claimRef !== undefined && (attemptPresence === 'recorded' || legacySummary !== undefined) ? 'recorded' : attemptPresence === 'recorded' ? 'not-reached' : attemptPresence,
      executionId,
      claim: claimRef !== undefined ? { presence: 'recorded', claimedAt: claimRef.createdAt } : { presence: 'not-reached' },
      attempt: {
        presence: attemptPresence,
        ...(attempt !== undefined
          ? { schemaVersion: attempt.schemaVersion, boundedGrantId: attempt.boundedGrantId, action: attempt.action, preparedAt: attempt.preparedAt, recordedAt: attempt.recordedAt, attemptDigest: attempt.attemptDigest }
          : {}),
        ...(outcomeReadFailure !== undefined ? { failure: outcomeReadFailure } : {}),
      },
    };
    parameters =
      attempt !== undefined
        ? { presence: 'recorded', ...(attempt.amount !== undefined ? { amount: { value: attempt.amount.value, unit: attempt.amount.unit } } : {}), ...(attempt.parameters !== undefined ? { parameters: attempt.parameters } : {}) }
        : { presence: attemptPresence };
  }

  // -- P7 reservation ------------------------------------------------------------
  let reservation: AuthorityTraceReservationStage;
  let expectedReservationId: string | undefined;
  let reservationView: ExerciseReservationView | undefined;
  if (executionId === undefined) reservation = { presence: 'not-applicable' };
  else if (attempt === undefined) reservation = { presence: execution.attempt?.presence === 'not-composed' ? 'not-composed' : 'not-reached' };
  else if (sources.reservations === undefined) reservation = { presence: 'not-composed' };
  else {
    expectedReservationId = exerciseReservationId({ boundedGrantId: attempt.boundedGrantId, executionId });
    try {
      const view = await sources.reservations.read(expectedReservationId);
      reservationView = view;
      if (view === undefined) reservation = { presence: 'none-recorded', reservationId: expectedReservationId };
      else {
        check('correlation.reservation', 'correlation', view.reservation.executionId === executionId && view.reservation.boundedGrantId === attempt.boundedGrantId);
        reservation = {
          presence: 'recorded',
          reservationId: expectedReservationId,
          state: view.state,
          ...(view.terminal !== undefined ? { terminalReason: view.terminal.reason } : {}),
          ...(view.resolution !== undefined ? { resolution: view.resolution.resolution } : {}),
        };
      }
    } catch (error) {
      reservation = { presence: 'unreadable', reservationId: expectedReservationId, failure: failureCode(error) };
      check('integrity.reservation', 'integrity', false, failureCode(error));
    }
  }

  // -- P11 initial observation ---------------------------------------------------
  let outcome: AuthorityTraceOutcomeStage;
  if (executionId === undefined) outcome = { presence: 'not-applicable' };
  else if (claimRef === undefined) {
    outcome = { presence: terminal !== undefined ? 'recorded' : 'not-reached' };
    if (terminal !== undefined) check('correlation.outcome-requires-claim', 'correlation', false, 'observation-without-claim');
  } else if (outcomeReadFailure !== undefined) outcome = { presence: 'unreadable', readFailure: outcomeReadFailure };
  else if (sources.outcomes === undefined) outcome = { presence: 'not-composed', ...(outcomeRef?.externalVersion !== undefined ? { governanceSummary: outcomeRef.externalVersion } : {}) };
  else if (terminal === undefined && legacySummary !== undefined) outcome = { presence: 'recorded', governanceSummary: legacySummary, legacy: true };
  else if (terminal === undefined) {
    // The claim stands with no initial observation. The Governance summary is
    // written only after the canonical observation committed — so a summary
    // with a digest and no observation means the canonical record is gone.
    const lost = outcomeRef?.digest !== undefined;
    outcome = { presence: lost ? 'missing' : 'unresolved', ...(outcomeRef?.externalVersion !== undefined ? { governanceSummary: outcomeRef.externalVersion } : {}) };
    if (lost) check('completeness.execution-outcome', 'completeness', false, 'governance-summary-without-observation');
  } else {
    const observation = terminal.observation;
    check('correlation.observation-binds-attempt', 'correlation', terminal.executionId === executionId && terminal.organizationId === organizationId && terminal.attemptDigest === attempt?.attemptDigest);
    if (outcomeRef?.digest !== undefined) check('integrity.outcome-summary-digest', 'integrity', outcomeRef.digest === terminal.observationDigest);
    if (outcomeRef?.externalVersion !== undefined) check('correlation.outcome-summary-text', 'correlation', summaryStates(outcomeRef.externalVersion, observation));
    outcome = {
      presence: 'recorded',
      kind: observation.kind,
      ...(observation.kind === 'provider'
        ? {
            certainty: observation.certainty,
            adapterId: observation.adapterId,
            ...(observation.routedBy !== undefined ? { routedBy: observation.routedBy } : {}),
            ...(observation.providerRef !== undefined ? { providerRef: observation.providerRef } : {}),
            ...(observation.certainty === 'confirmed-not-completed' ? { failure: observation.failure } : {}),
          }
        : { withheldBy: observation.withheldBy, reasonCodes: [...observation.reasonCodes] }),
      observedAt: observation.observedAt,
      recordedAt: terminal.recordedAt,
      observationDigest: terminal.observationDigest,
      ...(outcomeRef?.externalVersion !== undefined ? { governanceSummary: outcomeRef.externalVersion } : {}),
    };
  }

  // -- P12 binding and resolution ----------------------------------------------
  const claimed = claimRef !== undefined;
  const resolutionEligible =
    claimed &&
    outcomeReadFailure === undefined &&
    (legacySummary !== undefined
      ? legacySummary.startsWith('execution-unconfirmed')
      : terminal === undefined || (terminal.observation.kind === 'provider' && terminal.observation.certainty === 'unconfirmed'));
  let resolution: AuthorityTraceResolutionStage;
  let resolutionState: ExecutionResolutionState | undefined;
  const resolutionSummary = resolutionRef?.externalVersion !== undefined ? { governanceSummary: resolutionRef.externalVersion } : {};
  if (executionId === undefined) resolution = { presence: 'not-applicable' };
  else if (!claimed) {
    resolution = { presence: resolutionRef !== undefined ? 'missing' : 'not-reached' };
    if (resolutionRef !== undefined) check('correlation.resolution-requires-claim', 'correlation', false, 'resolution-summary-without-claim');
  }
  else if (sources.resolutions === undefined) {
    resolution = { presence: resolutionEligible ? 'not-composed' : 'not-applicable', ...resolutionSummary };
    if (resolutionRef !== undefined) check('completeness.execution-resolution', 'completeness', false, 'resolution-store-not-composed');
  } else {
    let unreadable: AuthorityTraceResolutionStage | undefined;
    try {
      resolutionState = await sources.resolutions.read(scope, executionId);
    } catch (error) {
      check('integrity.execution-resolution', 'integrity', false, failureCode(error));
      unreadable = { presence: 'unreadable', readFailure: failureCode(error), ...resolutionSummary };
    }
    const binding = resolutionState?.binding;
    const resolved = resolutionState?.resolution;
    if (binding !== undefined) check('correlation.resolution-binding-attempt', 'correlation', binding.executionId === executionId && binding.organizationId === organizationId && binding.attemptDigest === attempt?.attemptDigest);
    if (resolved !== undefined) {
      check(
        'correlation.resolution-binds-execution',
        'correlation',
        resolved.executionId === executionId && resolved.organizationId === organizationId && resolved.attemptDigest === attempt?.attemptDigest && resolved.bindingDigest === binding?.bindingDigest,
      );
      check('correlation.resolution-basis-observation', 'correlation', resolved.basisObservationDigest === terminal?.observationDigest);
      check('correlation.resolution-only-when-uncertain', 'correlation', outcomeReadFailure !== undefined ? 'n/a' : resolutionEligible, resolutionEligible || outcomeReadFailure !== undefined ? undefined : 'resolution-of-a-confirmed-outcome');
      if (resolutionRef?.digest !== undefined) check('integrity.resolution-summary-digest', 'integrity', resolutionRef.digest === resolved.resolutionDigest);
      if (resolutionRef?.externalVersion !== undefined) {
        const stated = resolved.certainty === 'confirmed-completed' ? 'resolved:confirmed-completed' : `resolved:confirmed-not-completed:${resolved.failure ?? ''}`;
        check('correlation.resolution-summary-text', 'correlation', resolutionRef.externalVersion === stated);
      }
    }
    const presence: AuthorityTracePresence =
      resolved !== undefined ? 'recorded' : resolutionRef !== undefined ? 'missing' : !resolutionEligible ? 'not-applicable' : 'unresolved';
    if (unreadable === undefined && presence === 'missing') check('completeness.execution-resolution', 'completeness', false, 'governance-summary-without-resolution');
    resolution = unreadable ?? {
      presence,
      ...(binding !== undefined ? { binding: { authorityId: binding.authorityId, origin: binding.origin, boundAt: binding.boundAt, bindingDigest: binding.bindingDigest } } : {}),
      ...(resolved !== undefined
        ? {
            resolution: {
              authorityId: resolved.authorityId,
              certainty: resolved.certainty,
              ...(resolved.failure !== undefined ? { failure: resolved.failure } : {}),
              ...(resolved.providerRef !== undefined ? { providerRef: resolved.providerRef } : {}),
              resolvedAt: resolved.resolvedAt,
              resolutionDigest: resolved.resolutionDigest,
              ...(resolved.basisObservationDigest !== undefined ? { basisObservationDigest: resolved.basisObservationDigest } : {}),
            },
          }
        : {}),
      ...resolutionSummary,
    };
  }

  // -- P8 authority events -----------------------------------------------------
  const recordedGrants = grants.filter((grant) => grant.presence === 'recorded');
  let events: AuthorityTraceEventStage;
  if (sources.events === undefined) events = { presence: 'not-composed', events: [] };
  else {
    const verification = streamVerification;
    const readFailure = streamReadFailure;
    const ordered = [...stream].sort((a, b) => a.sequence - b.sequence);
    const grantSet = new Set(grantIds);
    for (const event of ordered) {
      const refs = event.references;
      check(
        `correlation.event:${event.sequence}`,
        'correlation',
        event.streamId === streamId &&
          event.organizationId === organizationId &&
          refs.requestId === requestId &&
          (refs.evaluationId === undefined || refs.evaluationId === evaluationId) &&
          (refs.decisionId === undefined || refs.decisionId === decisionId) &&
          (refs.executionId === undefined || refs.executionId === executionId) &&
          (refs.boundedGrantId === undefined || grantSet.has(refs.boundedGrantId)) &&
          (refs.reservationId === undefined || refs.reservationId === expectedReservationId),
      );
      if (event.eventType === 'governance.decision.committed') {
        check('correlation.event-decision-payload', 'correlation', event.payload.aggregateDigest === record.integrity.aggregateDigest && event.payload.status === path);
      } else if (event.eventType === 'grant.expiry.observed') {
        const grant = recordedGrants.find((entry) => entry.grantId === refs.boundedGrantId);
        check(`correlation.event-expiry-payload:${refs.boundedGrantId ?? ''}`, 'correlation', grant !== undefined && grant.expiresAt === event.payload.expiresAt);
      } else if (event.eventType === 'exercise.reservation.reserved') {
        check('correlation.event-reservation-reserved-payload', 'correlation', reservationView !== undefined && reservationView.reservation.policyDigest === event.payload.policyDigest && reservationView.reservation.authorityBindingDigest === event.payload.authorityBindingDigest);
      } else if (event.eventType === 'grant.issued') {
        const grant = recordedGrants.find((entry) => entry.grantId === refs.boundedGrantId);
        check(`correlation.event-grant-payload:${refs.boundedGrantId ?? ''}`, 'correlation', grant !== undefined && grant.grantDigest === event.payload.grantDigest);
      } else if (event.eventType === 'execution.outcome.observed') {
        const expected = terminal === undefined ? undefined : terminal.observation.kind === 'withheld' ? 'withheld' : { 'confirmed-completed': 'executed', 'confirmed-not-completed': 'execution-failed', unconfirmed: 'execution-unconfirmed' }[terminal.observation.certainty];
        const observation = terminal?.observation;
        const detailsAgree =
          observation === undefined ||
          (observation.kind === 'withheld'
            ? event.payload.withheldBy === observation.withheldBy && canonicalList(event.payload.reasonCodes) === canonicalList(observation.reasonCodes)
            : // The projector attributes an adapter and a provider handle only where it can (a handle only for
              // an executed outcome): what the event states must match; what it omits is not a contradiction.
              (event.payload.adapterId === undefined || event.payload.adapterId === observation.adapterId) &&
              (event.payload.routedBy === undefined || event.payload.routedBy === observation.routedBy) &&
              (event.payload.providerRef === undefined || event.payload.providerRef === observation.providerRef) &&
              event.payload.failure === (observation.certainty === 'confirmed-not-completed' ? observation.failure : undefined));
        const consistent = (event.payload.outcomeRecorded ? expected === event.payload.status : terminal === undefined || expected === event.payload.status) && detailsAgree;
        check('correlation.event-outcome-payload', 'correlation', consistent);
      } else if (event.eventType === 'execution.outcome.resolved') {
        const resolved = resolutionState?.resolution;
        check(
          'correlation.event-resolution-payload',
          'correlation',
          resolved?.resolutionDigest === event.payload.resolutionDigest &&
            resolved.certainty === event.payload.certainty &&
            resolved.authorityId === event.payload.authorityId &&
            resolved.failure === event.payload.failure &&
            (event.payload.providerRef === undefined || resolved.providerRef === event.payload.providerRef),
        );
      } else if (event.eventType === 'exercise.reservation.reconciled') {
        check('correlation.event-reconciliation-payload', 'correlation', resolutionState?.resolution?.resolutionDigest === event.payload.resolutionDigest && resolutionState.resolution.certainty === event.payload.resolution);
      } else if (event.eventType === 'grant.revoked') {
        const grant = recordedGrants.find((entry) => entry.grantId === refs.boundedGrantId);
        check(`correlation.event-revocation-payload:${refs.boundedGrantId ?? ''}`, 'correlation', grant?.revocation !== undefined && grant.revocation.reason === event.payload.reason);
      } else if (event.eventType === 'exercise.reservation.settled' || event.eventType === 'exercise.reservation.released') {
        const kind = event.eventType === 'exercise.reservation.settled' ? 'settled' : 'released';
        check('correlation.event-reservation-payload', 'correlation', reservation.presence === 'recorded' && reservation.state === kind && reservation.terminalReason === event.payload.reason);
      }
    }
    // Anchors: the canonical facts each require their event. The stream is a
    // best-effort projection, so an absent anchor is reported as incomplete
    // evidence — never as the fact not having occurred.
    const has = (type: string, predicate: (event: AuthorityEvent) => boolean = () => true): boolean => ordered.some((event) => event.eventType === type && predicate(event));
    if (readFailure === undefined && verification?.valid === true) {
      check('completeness.event:governance.decision.committed', 'completeness', has('governance.decision.committed'));
      for (const grant of recordedGrants) {
        check(`completeness.event:grant.issued:${grant.grantId}`, 'completeness', has('grant.issued', (event) => event.references.boundedGrantId === grant.grantId));
        if (grant.revocation !== undefined) check(`completeness.event:grant.revoked:${grant.grantId}`, 'completeness', has('grant.revoked', (event) => event.references.boundedGrantId === grant.grantId));
      }
      if (claimed) check('completeness.event:execution.attempt.claimed', 'completeness', has('execution.attempt.claimed'));
      if (terminal !== undefined) check('completeness.event:execution.outcome.observed', 'completeness', has('execution.outcome.observed'));
      if (resolutionState?.resolution !== undefined) check('completeness.event:execution.outcome.resolved', 'completeness', has('execution.outcome.resolved'));
      // The converse: an event claiming a fact no canonical record holds.
      if (!claimed) check('correlation.event-claim-without-ledger-claim', 'correlation', !has('execution.attempt.claimed'));
      const outcomeClaimed = ordered.find((event) => event.eventType === 'execution.outcome.observed');
      if (outcomeClaimed?.eventType === 'execution.outcome.observed' && outcomeClaimed.payload.outcomeRecorded) {
        check('completeness.observation-the-stream-reports', 'completeness', terminal !== undefined, terminal === undefined ? 'event-reports-recorded-observation-that-is-absent' : undefined);
      }
      if (has('execution.outcome.resolved')) check('completeness.resolution-the-stream-reports', 'completeness', resolutionState?.resolution !== undefined);
    }
    events = {
      presence: readFailure !== undefined || verification?.valid === false ? 'unreadable' : ordered.length === 0 ? 'missing' : 'recorded',
      streamId,
      ...(verification?.head !== undefined ? { head: { sequence: verification.head.sequence, eventDigest: verification.head.eventDigest } } : {}),
      events: ordered.map((event) => ({
        sequence: event.sequence,
        eventId: event.eventId,
        eventType: event.eventType,
        occurredAt: event.occurredAt,
        recordedAt: event.recordedAt,
        ...(event.previousEventDigest !== undefined ? { previousEventDigest: event.previousEventDigest } : {}),
        eventDigest: event.eventDigest,
      })),
      ...(readFailure !== undefined ? { readFailure } : {}),
    };
  }

  const correlationFailed = checks.some((entry) => entry.category === 'correlation' && entry.status === 'fail');
  // A store whose own integrity checks failed leaves the request's end unstatable
  // (and makes checks that depend on it fail as a consequence): unverifiable first.
  const finalState: AuthorityTraceFinalState =
    governanceVerification?.valid !== true || (claimed && outcomeReadFailure !== undefined) || (path === 'approval_required' && approval.presence === 'unreadable')
      ? 'unverifiable'
      : correlationFailed
        ? 'inconsistent'
        : finalStateOf(path, approval, claimed, terminal, resolutionState, legacySummary, authorizationRefs.length > 0);

  const trace: AuthorityTrace = {
    traceVersion: AUTHORITY_TRACE_VERSION,
    requestId,
    organizationId,
    evaluationId,
    decisionId,
    ...(executionId !== undefined ? { executionId } : {}),
    path,
    finalState,
    stages: {
      request: {
        presence: 'recorded',
        actorId: record.request.actorId,
        ...(record.request.actorType !== undefined ? { actorType: record.request.actorType } : {}),
        actionType: record.request.actionType,
        resourceScope: record.request.resourceScope,
        requestedAt: record.request.requestedAt,
        receivedAt: record.request.receivedAt,
        payloadDigest: record.request.payloadDigest,
      },
      decision: {
        presence: 'recorded',
        status: path,
        reasonCodes: [...record.evaluation.reasonCodes],
        evaluatedAt: record.evaluation.evaluatedAt,
        kernelVersion: record.evaluation.kernelVersion,
        aggregateDigest: record.integrity.aggregateDigest,
        chainPosition: record.integrity.chainPosition,
      },
      approval,
      obligations,
      authority,
      execution,
      parameters,
      reservation,
      outcome,
      resolution,
      events,
    },
  };
  return { trace, record, traceDigest: computeDigest(trace), checks };
}

function finalStateOf(
  path: AuthorityTraceDecisionPath,
  approval: AuthorityTraceApprovalStage,
  claimed: boolean,
  terminal: ExecutionOutcomeRecord['terminal'],
  resolutionState: ExecutionResolutionState | undefined,
  legacySummary: string | undefined,
  authorized: boolean,
): AuthorityTraceFinalState {
  if (path === 'denied') return 'denied';
  if (path === 'indeterminate') return 'indeterminate';
  if (!claimed) {
    // Pending only when the approval log is actually read and shows no verdict and no grant was issued.
    const logRead = approval.presence === 'recorded' || approval.presence === 'none-recorded';
    if (path === 'approval_required' && logRead && !authorized && !approval.records.some((row) => row.kind === 'approved' || row.kind === 'rejected' || row.kind === 'revoked')) return 'approval-pending';
    return 'not-executed';
  }
  const resolved = resolutionState?.resolution;
  if (resolved !== undefined) return resolved.certainty === 'confirmed-completed' ? 'resolved-confirmed-completed' : 'resolved-confirmed-not-completed';
  if (terminal === undefined && legacySummary !== undefined) {
    if (legacySummary === 'executed' || legacySummary.startsWith('executed@')) return 'executed-confirmed-completed';
    // Decoded as the execution ledger replays it: a malformed row states no outcome.
    if (/^withheld:((grant-exercise|emergency-control|exercise-control):)?[A-Z0-9_]+(,[A-Z0-9_]+)*$/.test(legacySummary)) return 'withheld-at-exercise';
    if (/^execution-failed:[A-Z0-9_]+(@.+)?$/.test(legacySummary)) return 'executed-confirmed-not-completed';
    if (legacySummary.startsWith('execution-unconfirmed')) return 'executed-unconfirmed';
    return 'claimed-outcome-unrecorded';
  }
  if (terminal === undefined) return 'claimed-outcome-unrecorded';
  const observation = terminal.observation;
  if (observation.kind === 'withheld') return 'withheld-at-exercise';
  if (observation.certainty === 'confirmed-completed') return 'executed-confirmed-completed';
  if (observation.certainty === 'confirmed-not-completed') return 'executed-confirmed-not-completed';
  return 'executed-unconfirmed';
}

/** Turns a build's recorded checks into the structured verification result. Pure. */
export function authorityTraceVerificationOf(build: AuthorityTraceBuild, verifiedAt: string): AuthorityTraceVerification {
  const categories = Object.fromEntries(
    AUTHORITY_TRACE_CHECK_CATEGORIES.map((category) => [category, build.checks.some((entry) => entry.category === category && entry.status === 'fail') ? 'fail' : 'pass']),
  ) as Record<AuthorityTraceCheckCategory, 'pass' | 'fail'>;
  return {
    verificationVersion: AUTHORITY_TRACE_VERIFICATION_VERSION,
    traceVersion: AUTHORITY_TRACE_VERSION,
    requestId: build.trace.requestId,
    verified: Object.values(categories).every((status) => status === 'pass'),
    categories,
    checks: build.checks,
    traceDigest: build.traceDigest,
    finalState: build.trace.finalState,
    verifiedAt,
    boundary: AUTHORITY_TRACE_VERIFICATION_BOUNDARY,
  };
}

const AUTHORITY_TRACE_CHECK_CATEGORIES: readonly AuthorityTraceCheckCategory[] = ['contract', 'integrity', 'authenticity', 'correlation', 'completeness'];

function canonicalList(list: readonly string[] | undefined): string {
  return JSON.stringify(list ?? []);
}

/** Whether the Governance outcome summary states exactly what the canonical observation records (the ledger's own encoding). */
function summaryStates(summary: string, observation: NonNullable<ExecutionOutcomeRecord['terminal']>['observation']): boolean {
  const body = summary.startsWith('withheld:') ? summary : summary.split('@')[0] ?? summary;
  if (observation.kind === 'withheld') return body === `withheld:${observation.withheldBy}:${observation.reasonCodes.join(',')}`;
  if (observation.certainty === 'confirmed-completed') return body === 'executed';
  if (observation.certainty === 'confirmed-not-completed') return body === `execution-failed:${observation.failure}`;
  return body === 'execution-unconfirmed';
}
