import { EnterpriseHttpError, EnterpriseHttpErrors } from '../api/enterprise-http-errors.js';
import { ApprovalAuthorityError, canonicalApprovalSubject, type ApprovalCommand, type ApprovalCommandContext, type ApprovalCommandPort, type ApprovalRequestView } from '../approval-authority/index.js';
import type { EnterpriseLogger } from '../telemetry/enterprise-logger.js';
import type { EnterpriseOperatorPrincipal, OperatorAuthenticator } from './operator-authenticator.js';
import type { OperatorPermission } from './roles.js';

/**
 * CTRL-04 — the human side of the CORE-05 approval lifecycle, on the operator
 * plane.
 *
 * ```
 * Authorization header
 *   └─ OperatorAuthenticator.authorize(header, approval.*)   401 / 403 / 503, before any body is read
 *       └─ a CTRL-02 operator credential (never a CTRL-01 administrator)
 *           └─ closed path + query + body                    400
 *               └─ ApprovalCommandContext, derived HERE and only here:
 *                    { authenticated: true, actorId: operator:<operatorId>, authenticatedBy: frontera:operator-plane }
 *                   └─ enterprise.approvals (CORE-05): Kernel-Authority standing, SOD, evidence,
 *                      expiry, duplicates, quorum — judged there, never here
 *                       └─ the canonical state, re-read by CORE-05 after the append
 * ```
 *
 * This module is a translator, not an approval engine. It holds no store and no
 * policy; it computes no quorum, eligibility or state. Every request it serves
 * is one CORE-05 operation, and every field it returns is restated from the
 * view CORE-05 derived. The operator's role only lets them *reach* a command;
 * whether their verdict counts is the Kernel Authority's (CORE-05 re-resolves
 * the operator's standing for the requirement's approver action over the
 * request's resource at submission and at every read).
 *
 * It executes nothing: an approval is not an execution. The original requester
 * resumes its own governed action on the customer plane.
 */

/** The trusted channel every operator-plane verdict records as `recordedBy`. Never interpreted; a fact about how the actor was authenticated. */
export const OPERATOR_APPROVAL_CHANNEL = 'frontera:operator-plane';

/** The CORE-05 command each verb path names, and the one permission that reaches it. */
export const APPROVAL_COMMANDS = {
  approve: { port: 'approve', permission: 'approval.approve' },
  reject: { port: 'reject', permission: 'approval.restrict' },
  'request-changes': { port: 'requestChanges', permission: 'approval.restrict' },
  escalate: { port: 'escalate', permission: 'approval.restrict' },
  revoke: { port: 'revoke', permission: 'approval.restrict' },
} as const satisfies Readonly<Record<string, { readonly port: keyof ApprovalCommandPort; readonly permission: OperatorPermission }>>;

export type ApprovalCommandVerb = keyof typeof APPROVAL_COMMANDS;

export function isApprovalCommandVerb(value: string): value is ApprovalCommandVerb {
  return Object.prototype.hasOwnProperty.call(APPROVAL_COMMANDS, value);
}

/** The inbox's closed views. Each is a filter over derived state — none is stored. */
export const APPROVAL_VIEWS = ['pending', 'escalated', 'approved', 'rejected', 'revoked', 'expired', 'superseded', 'all'] as const;
export type ApprovalInboxView = (typeof APPROVAL_VIEWS)[number];

/** Derived status as an operator sees it: CORE-05's status, or `superseded` when trusted configuration no longer holds the request's profile or requirement. */
export type ApprovalDisplayStatus = ApprovalRequestView['state']['status'] | 'superseded';

export interface ApprovalEvidenceReferenceView {
  readonly type: string;
  readonly hash: string;
  readonly uri: string | null;
}

export interface ApprovalVerdictRecordView {
  readonly kind: 'approved' | 'rejected' | 'requested_changes' | 'escalated' | 'revoked';
  readonly actorId: string;
  readonly recordedAt: string;
  readonly recordedBy: string;
  /** Derived: whether CORE-05 counts it now. */
  readonly counted: boolean;
  /** Derived: approval-runtime's reason code for it, as judged now. */
  readonly reasonCode: string;
  readonly reason: string | null;
  readonly evidence: readonly ApprovalEvidenceReferenceView[];
  readonly rowDigest: string;
}

export interface ApprovalRequirementView {
  readonly approverAction: string;
  readonly minimumApprovals: number;
  readonly requestTtlSeconds: number;
  readonly approvalValiditySeconds: number;
  readonly requiredEvidence: readonly string[];
  readonly digest: string;
}

export interface ApprovalQuorumView {
  readonly minimumApprovals: number;
  /** Distinct eligible approvers CORE-05 counts now, in the order they approved. */
  readonly countedApprovers: readonly string[];
  readonly satisfied: boolean;
}

export interface ApprovalInboxItem {
  readonly approvalRequestId: string;
  readonly requestId: string;
  readonly decisionId: string;
  readonly requestedAt: string;
  readonly status: ApprovalDisplayStatus;
  readonly actorId: string;
  readonly action: string;
  readonly resourceScope: string;
  readonly governanceProfile: string;
  readonly quorum: ApprovalQuorumView;
  readonly requestExpiresAt: string;
  /** Recorded escalations (CTRL-04 escalation routing): who, when and the recorded reference. They change no quorum and no authority. */
  readonly escalations: readonly { readonly actorId: string; readonly recordedAt: string; readonly reason: string | null }[];
  readonly changesRequested: number;
}

export interface ApprovalDetailView extends ApprovalInboxItem {
  readonly subjectDigest: string;
  /** The exact canonical bytes `subjectDigest` was taken over. */
  readonly canonicalSubject: string;
  readonly subject: {
    readonly evaluationId: string;
    readonly actorId: string;
    readonly principalActorId: string | null;
    readonly action: string;
    readonly resourceScope: string;
    readonly counterpartyId: string | null;
    readonly amount: { readonly value: string; readonly unit: string } | null;
    readonly governanceProfile: string;
    readonly actionClass: string;
    readonly resourceClass: string;
    readonly parameters: readonly { readonly dimension: string; readonly type: string; readonly value: string | number }[];
    readonly contextDigest: string | null;
    readonly contextValidUntil: string | null;
    readonly decision: { readonly status: string; readonly reasonCodes: readonly string[]; readonly evaluatedAt: string };
    readonly decisionDigest: { readonly requestDigest: string; readonly evaluationDigest: string };
  };
  readonly requirement: ApprovalRequirementView;
  readonly superseded: boolean;
  readonly approvedAt: string | null;
  readonly notAfter: string | null;
  /** The derived identity of a completed, usable approval. Not a credential: it becomes authority only inside a grant's signed source. */
  readonly approvalDigest: string | null;
  readonly closedBy: string | null;
  readonly verdicts: readonly ApprovalVerdictRecordView[];
}

export interface ApprovalCommandResult {
  readonly outcome: 'recorded';
  readonly verdict: ApprovalCommandVerb;
  /** The canonical state CORE-05 re-read after the append. */
  readonly approval: ApprovalDetailView;
}

export type OperatorApprovalBodyReader = () => Promise<unknown>;

export interface OperatorApprovalService {
  listApprovals(authorizationHeader: string | undefined, query: Readonly<Record<string, string>>): Promise<{ readonly view: ApprovalInboxView; readonly approvals: readonly ApprovalInboxItem[] }>;
  inspectApproval(authorizationHeader: string | undefined, approvalRequestId: string, query: Readonly<Record<string, string>>): Promise<ApprovalDetailView>;
  command(authorizationHeader: string | undefined, verb: ApprovalCommandVerb, approvalRequestId: string, readBody: OperatorApprovalBodyReader): Promise<ApprovalCommandResult>;
}

export interface OperatorApprovalDependencies {
  readonly authenticator: OperatorAuthenticator;
  readonly organizationId: string;
  /** The CORE-05 command port — reads and commands. No store, no append, no state writer. */
  readonly approvals: Pick<ApprovalCommandPort, 'list' | 'approve' | 'reject' | 'requestChanges' | 'escalate' | 'revoke'>;
  readonly logger: EnterpriseLogger;
}

const MAX_TEXT = 256;
const MAX_EVIDENCE = 32;
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const APPROVAL_REQUEST_ID = /^approval-request:[0-9a-f]{64}$/;
const COMMAND_FIELDS = ['subjectDigest', 'evidence', 'reason'] as const;
const EVIDENCE_FIELDS = ['type', 'hash', 'uri'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function refused(message: string, failure: string, extra: Readonly<Record<string, unknown>> = {}): EnterpriseHttpError {
  return new EnterpriseHttpError(409, 'OPERATOR_OPERATION_REFUSED', message, undefined, { failure, recorded: false, ...extra });
}

function notFound(): EnterpriseHttpError {
  return new EnterpriseHttpError(404, 'AUTHORITY_ADMIN_TARGET_NOT_FOUND', 'No approval request with that id exists in this organization.');
}

function unavailable(): EnterpriseHttpError {
  return new EnterpriseHttpError(503, 'AUTHORITY_STATE_UNAVAILABLE', 'The approval store is unavailable. Whether a command was recorded is unknown: re-read the approval request before retrying.');
}

function integrityFailed(failure: string): EnterpriseHttpError {
  return new EnterpriseHttpError(
    500,
    'AUTHORITY_STATE_INTEGRITY_FAILED',
    'The approval state could not be verified, so it is not reported and nothing was changed. Treat this as a security incident; see the operator runbook.',
    undefined,
    { failure },
  );
}

function boundedText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > MAX_TEXT) throw EnterpriseHttpErrors.invalidRequest(`${field} must be a non-empty string of at most ${String(MAX_TEXT)} characters.`);
  return value;
}

/**
 * The closed command body: `{ subjectDigest, evidence?, reason? }`. Any other
 * field — an actor, an approver, an organization, a role, a state, a quorum, a
 * proof — is refused, never ignored: who acts is the authenticated operator,
 * and everything else is derived by CORE-05.
 */
export function validateApprovalCommandBody(raw: unknown): Omit<ApprovalCommand, 'approvalRequestId'> {
  if (!isRecord(raw)) throw EnterpriseHttpErrors.invalidRequest('The request body must be a JSON object.');
  const unexpected = Object.keys(raw).filter((key) => !(COMMAND_FIELDS as readonly string[]).includes(key));
  if (unexpected.length > 0) {
    throw EnterpriseHttpErrors.invalidRequest(
      `The approval command has unsupported field(s). Accepted: ${COMMAND_FIELDS.join(', ')}. The acting operator, organization and approval state are derived by the Host, never taken from the request.`,
      unexpected.slice(0, 8).map((key) => key.slice(0, 64)),
    );
  }
  const subjectDigest = raw['subjectDigest'];
  if (typeof subjectDigest !== 'string' || !SHA256.test(subjectDigest)) throw EnterpriseHttpErrors.invalidRequest("subjectDigest must be the digest ('sha256:' and 64 hex digits) of the approval subject the operator reviewed.");
  const reason = raw['reason'] === undefined ? undefined : boundedText(raw['reason'], 'reason');
  let evidence: { type: string; hash: string; uri?: string }[] | undefined;
  if (raw['evidence'] !== undefined) {
    const entries = raw['evidence'];
    if (!Array.isArray(entries) || entries.length > MAX_EVIDENCE) throw EnterpriseHttpErrors.invalidRequest(`evidence must be an array of at most ${String(MAX_EVIDENCE)} references.`);
    evidence = entries.map((entry: unknown) => {
      if (!isRecord(entry)) throw EnterpriseHttpErrors.invalidRequest('An evidence reference must be an object { type, hash, uri? }.');
      const extra = Object.keys(entry).filter((key) => !(EVIDENCE_FIELDS as readonly string[]).includes(key));
      if (extra.length > 0) throw EnterpriseHttpErrors.invalidRequest(`An evidence reference accepts only: ${EVIDENCE_FIELDS.join(', ')}.`, extra.slice(0, 8).map((key) => key.slice(0, 64)));
      const type = boundedText(entry['type'], 'evidence[].type');
      const hash = entry['hash'];
      if (typeof hash !== 'string' || !SHA256.test(hash)) throw EnterpriseHttpErrors.invalidRequest("evidence[].hash must be a content hash ('sha256:' and 64 lowercase hex digits).");
      const uri = entry['uri'] === undefined ? undefined : boundedText(entry['uri'], 'evidence[].uri');
      return { type, hash, ...(uri !== undefined ? { uri } : {}) };
    });
  }
  return { subjectDigest, ...(evidence !== undefined ? { evidence } : {}), ...(reason !== undefined ? { reason } : {}) };
}

/**
 * The identity bridge — the only construction of an `ApprovalCommandContext`
 * on the operator plane. Every field comes from the authenticated principal
 * the operator authenticator built from server configuration: the actor is the
 * operator's canonical `actorRef` (`operator:<operatorId>`), which is also the
 * Kernel-Authority actor id CORE-05 resolves approver standing for. Nothing in
 * a request reaches it.
 */
export function approvalCommandContextFor(principal: EnterpriseOperatorPrincipal): ApprovalCommandContext {
  return Object.freeze({ authenticated: true as const, actorId: principal.actorRef, authenticatedBy: OPERATOR_APPROVAL_CHANNEL });
}

function displayStatus(view: ApprovalRequestView): ApprovalDisplayStatus {
  return view.superseded ? 'superseded' : view.state.status;
}

function inboxItemOf(view: ApprovalRequestView): ApprovalInboxItem {
  const { subject, state } = view;
  return {
    approvalRequestId: view.approvalRequestId,
    requestId: view.requestId,
    decisionId: view.decisionId,
    requestedAt: view.requestedAt,
    status: displayStatus(view),
    actorId: subject.actorId,
    action: subject.action,
    resourceScope: subject.resourceScope,
    governanceProfile: subject.governanceProfile,
    quorum: { minimumApprovals: state.minimumApprovals, countedApprovers: [...state.approvers], satisfied: state.status === 'approved' },
    requestExpiresAt: state.requestExpiresAt,
    escalations: state.verdicts.filter((verdict) => verdict.kind === 'escalated').map((verdict) => ({ actorId: verdict.actorId, recordedAt: verdict.recordedAt, reason: verdict.reason ?? null })),
    changesRequested: state.verdicts.filter((verdict) => verdict.kind === 'requested_changes').length,
  };
}

/** Field by field from the view CORE-05 derived. Nothing is recomputed, and nothing beyond these fields leaves. */
export function approvalDetailOf(view: ApprovalRequestView): ApprovalDetailView {
  const { subject, state } = view;
  return {
    ...inboxItemOf(view),
    subjectDigest: view.subjectDigest,
    canonicalSubject: canonicalApprovalSubject(subject),
    subject: {
      evaluationId: subject.evaluationId,
      actorId: subject.actorId,
      principalActorId: subject.principalActorId ?? null,
      action: subject.action,
      resourceScope: subject.resourceScope,
      counterpartyId: subject.counterpartyId ?? null,
      amount: subject.amount === undefined ? null : { value: subject.amount.value, unit: subject.amount.unit },
      governanceProfile: subject.governanceProfile,
      actionClass: subject.actionClass,
      resourceClass: subject.resourceClass,
      parameters: (subject.parameters ?? []).map(({ dimension, type, value }) => ({ dimension, type, value })),
      contextDigest: subject.contextDigest ?? null,
      contextValidUntil: subject.contextValidUntil ?? null,
      decision: { status: subject.decision.status, reasonCodes: [...subject.decision.reasonCodes], evaluatedAt: subject.decision.evaluatedAt },
      decisionDigest: { requestDigest: subject.decisionDigest.requestDigest, evaluationDigest: subject.decisionDigest.evaluationDigest },
    },
    requirement: {
      approverAction: subject.requirement.approverAction,
      minimumApprovals: subject.requirement.minimumApprovals,
      requestTtlSeconds: subject.requirement.requestTtlSeconds,
      approvalValiditySeconds: subject.requirement.approvalValiditySeconds,
      requiredEvidence: [...(subject.requirement.requiredEvidence ?? [])],
      digest: subject.requirementDigest,
    },
    superseded: view.superseded,
    approvedAt: state.approvedAt ?? null,
    notAfter: state.notAfter ?? null,
    approvalDigest: state.approvalDigest ?? null,
    closedBy: state.closedBy ?? null,
    verdicts: state.verdicts.map((verdict) => ({
      kind: verdict.kind as ApprovalVerdictRecordView['kind'],
      actorId: verdict.actorId,
      recordedAt: verdict.recordedAt,
      recordedBy: verdict.recordedBy,
      counted: verdict.counted,
      reasonCode: verdict.reasonCode,
      reason: verdict.reason ?? null,
      evidence: verdict.evidence.map((entry) => ({ type: entry.type, hash: entry.hash, uri: entry.uri ?? null })),
      rowDigest: verdict.rowDigest,
    })),
  };
}

function inView(view: ApprovalInboxView, item: ApprovalInboxItem): boolean {
  switch (view) {
    case 'all':
      return true;
    case 'escalated':
      // Escalation routing: an open request someone escalated. Derived from the recorded `escalated` facts; it changes nothing else.
      return item.status === 'pending' && item.escalations.length > 0;
    case 'expired':
      return item.status === 'request-expired' || item.status === 'approval-expired';
    default:
      return item.status === view;
  }
}

/** A closed request's recorded reason, in the console's vocabulary — from a fresh read, so a stale page learns what happened. */
function closedFailure(status: ApprovalDisplayStatus | undefined): string {
  switch (status) {
    case 'rejected':
      return 'APPROVAL_REJECTED';
    case 'revoked':
      return 'APPROVAL_REVOKED';
    case 'request-expired':
      return 'APPROVAL_REQUEST_EXPIRED';
    case 'approval-expired':
      return 'APPROVAL_EXPIRED';
    case 'approved':
      return 'APPROVAL_ALREADY_APPROVED';
    case 'superseded':
      return 'APPROVAL_REQUEST_SUPERSEDED';
    default:
      return 'APPROVAL_REQUEST_CLOSED';
  }
}

export function createOperatorApprovalService(dependencies: OperatorApprovalDependencies): OperatorApprovalService {
  const { authenticator, organizationId, approvals, logger } = dependencies;
  if (authenticator.organizationId !== organizationId) throw new Error('createOperatorApprovalService: the authenticator serves another organization.');

  /** Authenticates and authorizes before anything else happens. A CTRL-01 administrator credential never reaches the approval plane, whatever a policy table says. */
  function authorize(authorizationHeader: string | undefined, permission: OperatorPermission): EnterpriseOperatorPrincipal {
    const principal = authenticator.authorize(authorizationHeader, permission);
    if (principal.credentialClass !== 'operator') throw new EnterpriseHttpError(403, 'OPERATOR_PERMISSION_DENIED', `A CTRL-01 administrator credential holds no approval permission. Nothing was read or changed.`);
    return principal;
  }

  function audit(principal: EnterpriseOperatorPrincipal, operation: string, target: string, outcome: string): void {
    // Route shape and identifiers only — never subject content (amounts, counterparties, parameters, evidence).
    logger.info('enterprise.operator.approval', { operatorId: principal.operatorId, organizationId, operation, target, status: outcome });
  }

  function mapRead(error: unknown): never {
    if (error instanceof EnterpriseHttpError) throw error;
    if (error instanceof ApprovalAuthorityError) {
      if (error.code === 'APPROVAL_STORE_CORRUPT' || error.code === 'APPROVAL_STORE_UNSUPPORTED') throw integrityFailed(error.code);
    }
    throw unavailable();
  }

  async function all(): Promise<readonly ApprovalRequestView[]> {
    try {
      const views = await approvals.list();
      // The served organization only, re-proven: a request of any other is corruption, never data.
      if (views.some((view) => view.subject.organizationId !== organizationId)) throw integrityFailed('APPROVAL_ORGANIZATION_MISMATCH');
      return views;
    } catch (error) {
      return mapRead(error);
    }
  }

  async function find(approvalRequestId: string): Promise<ApprovalRequestView> {
    if (!APPROVAL_REQUEST_ID.test(approvalRequestId)) throw notFound();
    const view = (await all()).find((candidate) => candidate.approvalRequestId === approvalRequestId);
    if (view === undefined) throw notFound();
    return view;
  }

  return Object.freeze({
    async listApprovals(authorizationHeader: string | undefined, query: Readonly<Record<string, string>>) {
      authorize(authorizationHeader, 'approval.read');
      const unexpected = Object.keys(query).filter((key) => key !== 'view');
      if (unexpected.length > 0) throw EnterpriseHttpErrors.invalidRequest('Unsupported query parameter(s). Accepted: view.', unexpected.slice(0, 8).map((key) => key.slice(0, 64)));
      const requested = query['view'] ?? 'pending';
      if (!(APPROVAL_VIEWS as readonly string[]).includes(requested)) throw EnterpriseHttpErrors.invalidRequest(`view must be one of: ${APPROVAL_VIEWS.join(', ')}.`);
      const view = requested as ApprovalInboxView;
      const items = (await all()).map(inboxItemOf).filter((item) => inView(view, item));
      return { view, approvals: items };
    },

    async inspectApproval(authorizationHeader: string | undefined, approvalRequestId: string, query: Readonly<Record<string, string>>) {
      authorize(authorizationHeader, 'approval.read');
      if (Object.keys(query).length > 0) throw EnterpriseHttpErrors.invalidRequest('Unsupported query parameter(s). Accepted: none.');
      return approvalDetailOf(await find(approvalRequestId));
    },

    async command(authorizationHeader: string | undefined, verb: ApprovalCommandVerb, approvalRequestId: string, readBody: OperatorApprovalBodyReader) {
      const spec = APPROVAL_COMMANDS[verb];
      // Authenticate and authorize before the body is read: a refused caller's body is never read, parsed or validated.
      const principal = authorize(authorizationHeader, spec.permission);
      const body = validateApprovalCommandBody(await readBody());
      const current = await find(approvalRequestId);
      // A stale or substituted review: the operator must review the subject the request actually carries. CORE-05 checks it again, authoritatively.
      if (body.subjectDigest !== current.subjectDigest) {
        audit(principal, verb, approvalRequestId, 'subject-mismatch');
        throw refused('The subject you reviewed is not the subject of this approval request. Nothing was recorded. Review the current request before deciding.', 'APPROVAL_SUBJECT_MISMATCH');
      }
      const context = approvalCommandContextFor(principal);
      // Field by field: the path names the request; the closed body names the reviewed subject, evidence and note.
      const command: ApprovalCommand = {
        approvalRequestId,
        subjectDigest: body.subjectDigest,
        ...(body.evidence !== undefined ? { evidence: body.evidence } : {}),
        ...(body.reason !== undefined ? { reason: body.reason } : {}),
      };
      let after: ApprovalRequestView;
      try {
        after = await approvals[spec.port](context, command);
      } catch (error) {
        if (!(error instanceof ApprovalAuthorityError)) {
          audit(principal, verb, approvalRequestId, 'unavailable');
          throw unavailable();
        }
        audit(principal, verb, approvalRequestId, error.code);
        const reasonCode = error.reasonCode === undefined ? {} : { reasonCode: error.reasonCode };
        switch (error.code) {
          case 'APPROVAL_INVALID':
            throw EnterpriseHttpErrors.invalidRequest(`CORE-05 refused the command as malformed: ${error.message}`);
          case 'APPROVAL_APPROVER_INELIGIBLE':
            if (error.reasonCode === 'SEGREGATION_OF_DUTIES_VIOLATION') {
              throw refused('Segregation of duties: the requesting actor cannot approve its own request. Nothing was recorded.', 'APPROVAL_SEGREGATION_OF_DUTIES', reasonCode);
            }
            throw refused(
              `You do not hold live Kernel-Authority approval standing for '${current.subject.requirement.approverAction}' over '${current.subject.resourceScope}' as ${principal.actorRef}. Your operator role lets you reach this command; it does not grant approval authority. Nothing was recorded.`,
              'APPROVAL_APPROVER_INELIGIBLE',
              reasonCode,
            );
          case 'APPROVAL_DUPLICATE':
            throw refused('You have already approved this request; one approver never counts twice. Nothing was recorded.', 'APPROVAL_DUPLICATE', reasonCode);
          case 'APPROVAL_EVIDENCE_INSUFFICIENT':
            throw refused(`An approval of this request must cite every required evidence type (${(current.subject.requirement.requiredEvidence ?? []).join(', ')}) by sha256 hash. Nothing was recorded.`, 'APPROVAL_EVIDENCE_INSUFFICIENT', reasonCode);
          case 'APPROVAL_REQUEST_SUPERSEDED':
            throw refused("The request's Governance Profile or approval requirement changed since it was opened; it accepts no further commands. A new governed request starts a new approval.", 'APPROVAL_REQUEST_SUPERSEDED', reasonCode);
          case 'APPROVAL_REQUEST_CLOSED': {
            let status: ApprovalDisplayStatus | undefined;
            try {
              const fresh = (await approvals.list()).find((candidate) => candidate.approvalRequestId === approvalRequestId);
              status = fresh === undefined ? undefined : displayStatus(fresh);
            } catch {
              status = undefined;
            }
            throw refused(`The approval request is no longer open${status !== undefined ? ` (${status})` : ''}; it accepts no further command of this kind. Nothing was recorded.`, closedFailure(status), {
              ...reasonCode,
              ...(status !== undefined ? { approvalStatus: status } : {}),
            });
          }
          case 'APPROVAL_STORE_CORRUPT':
          case 'APPROVAL_STORE_UNSUPPORTED':
            throw integrityFailed(error.code);
          case 'APPROVAL_CONTEXT_UNTRUSTED':
          case 'APPROVAL_STORE_CLOSED':
            throw unavailable();
        }
      }
      audit(principal, verb, approvalRequestId, 'recorded');
      return { outcome: 'recorded' as const, verdict: verb, approval: approvalDetailOf(after) };
    },
  });
}
