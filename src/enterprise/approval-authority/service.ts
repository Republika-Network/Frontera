import type { ApprovalDecision } from '../../features/approval-runtime/domain/approval-decision.js';
import type { ApprovalEvidenceArtifact, ApprovalEvidenceType } from '../../features/approval-runtime/domain/approval-evidence.js';
import { formatGovernanceProfileReference } from '../../features/governed-parameter-runtime/index.js';
import type { KernelEffectiveProfileResolver, KernelEvaluationRequest, KernelEvaluationResult } from '../../kernel/index.js';
import { selectEffectiveProfile } from '../../kernel/orchestration/effective-profile.js';
import { decisionAwaitsHumanApproval } from '../../kernel/orchestration/grant-adapter.js';
import type { GovernanceProfileApproval, GovernanceProfileRegistry, ResolvedGovernanceProfile } from '../governance-profile/index.js';
import type { ApprovalCommand, ApprovalCommandContext, ApprovalCommandKind, ApprovalEvidenceInput, ApprovalStore, StoredApprovalRecord } from './contracts.js';
import { ApprovalAuthorityError, type ApprovalAuthorityErrorCode } from './errors.js';
import {
  admit,
  approvalRequestIdFor,
  canonicalEvidence,
  evaluateApproval,
  policyContextFor,
  runtimeRequestOf,
  type ApprovalAuthorityPort,
  type ApprovalEvaluation,
  type ApprovalStatus,
} from './evaluation.js';
import type { ApprovalRecordKind, ApprovalRowContent } from './state-commitment.js';
import { approvalRequirementDigest, approvalSubjectDigest, approvalSubjectOf, canonicalApprovalSubject, type ApprovalSubject } from './subject.js';

/** Bounds on the opaque strings a command carries. */
const MAX_TEXT = 256;
const MAX_EVIDENCE = 32;
const SHA256 = /^sha256:[0-9a-f]{64}$/;

/** Who recorded a `requested` row: the governed path itself, never a caller. */
export const APPROVAL_REQUESTED_BY = 'frontera:governed-action';

/**
 * The governed path's view of one committed decision's approval.
 *
 * - `not-applicable` — no approval can resume this decision: it does not await
 *   a human approval (an allow, a denial, an evidence or handshake
 *   requirement), its trusted effective profile cannot be established, or
 *   that profile declares no approval requirement. There is no synthesized
 *   default requirement: the decision stays withheld exactly as before CORE-05.
 * - `withheld` — it awaits an approval that is not usable now.
 * - `approved` — a durable, attributable approval of exactly this decision,
 *   usable until `notAfter`, known by `approvalDigest`.
 */
export type ApprovalAssessment =
  | { readonly kind: 'not-applicable' }
  | { readonly kind: 'withheld'; readonly status: Exclude<ApprovalStatus, 'approved'> | 'superseded' | 'unavailable' }
  | { readonly kind: 'approved'; readonly approvalDigest: string; readonly notAfter: string };

/** What an approver is shown, and what a command binds to. */
export interface ApprovalRequestView {
  readonly approvalRequestId: string;
  readonly requestId: string;
  readonly decisionId: string;
  readonly subjectDigest: string;
  /** The canonical subject — exactly the bytes `subjectDigest` was taken over, parsed. It includes the requirement snapshot. */
  readonly subject: ApprovalSubject;
  readonly requestedAt: string;
  /** `superseded` when trusted configuration no longer holds the profile or requirement the request was opened under. */
  readonly superseded: boolean;
  readonly state: ApprovalEvaluation;
}

/**
 * The engine-side approval command port (CORE-05). **In-process only**:
 * exposed on the Enterprise handle beside `obligationDischarges` and
 * `kernelAuthorityProvisioning`, never over HTTP — not by the governed-action
 * API and not by the CTRL-01 administration API. The human surface (inbox,
 * notification, sign-in) is CTRL-04's; it will authenticate the human and call
 * these operations with an `ApprovalCommandContext`. There is no operation to
 * write a state, a quorum or a proof: those are only ever derived.
 */
export interface ApprovalCommandPort {
  /** Every request whose approval is still open, oldest first. */
  pending(): Promise<readonly ApprovalRequestView[]>;
  /** One governed request's approval, or `undefined` when it never awaited one. */
  describe(requestId: string): Promise<ApprovalRequestView | undefined>;
  approve(context: ApprovalCommandContext, command: ApprovalCommand): Promise<ApprovalRequestView>;
  reject(context: ApprovalCommandContext, command: ApprovalCommand): Promise<ApprovalRequestView>;
  requestChanges(context: ApprovalCommandContext, command: ApprovalCommand): Promise<ApprovalRequestView>;
  escalate(context: ApprovalCommandContext, command: ApprovalCommand): Promise<ApprovalRequestView>;
  revoke(context: ApprovalCommandContext, command: ApprovalCommand): Promise<ApprovalRequestView>;
}

export interface ApprovalAssessInput {
  readonly request: KernelEvaluationRequest;
  readonly decision: KernelEvaluationResult;
  readonly evaluationId: string;
  /** The Governance Store's canonical digests of the committed record. */
  readonly decisionDigest: { readonly requestDigest: string; readonly evaluationDigest: string };
}

export interface ApprovalAuthority extends ApprovalCommandPort {
  readonly storeKind: ApprovalStore['kind'];
  /** The orchestrator's port. Opens the request the first time a decision is withheld for approval, and derives its state. */
  assess(input: ApprovalAssessInput): Promise<ApprovalAssessment>;
}

export interface ApprovalAuthorityOptions {
  readonly store: ApprovalStore;
  /** The one frozen Governance Profile registry — where a requirement comes from, by the trusted effective profile only. */
  readonly governance: GovernanceProfileRegistry;
  /** CORE-04's trusted effective-profile resolver: action × resource → profile. A request's own `semantics` may only agree with it. */
  readonly resolveEffectiveProfile: KernelEffectiveProfileResolver;
  /** The one organization this Host serves. */
  readonly organizationId: string;
  /** Approver standing, from the durable Kernel-Authority world. */
  readonly authority: ApprovalAuthorityPort;
  readonly now: () => string;
}

function isText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= MAX_TEXT;
}

function readOwn(source: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(source, key);
  return descriptor !== undefined && 'value' in descriptor ? (descriptor.value as unknown) : undefined;
}

function fail(code: ApprovalAuthorityErrorCode, message: string, reasonCode?: string): never {
  throw new ApprovalAuthorityError(code, message, reasonCode);
}

const COMMAND_KEYS: ReadonlySet<string> = new Set(['approvalRequestId', 'subjectDigest', 'evidence', 'reason']);
const EVIDENCE_KEYS: ReadonlySet<string> = new Set(['type', 'hash', 'uri']);
const RECORD_KIND: Readonly<Record<ApprovalCommandKind, ApprovalRecordKind>> = {
  approve: 'approved',
  reject: 'rejected',
  requestChanges: 'requested_changes',
  escalate: 'escalated',
  revoke: 'revoked',
};

/** approval-runtime's refusal, in this port's vocabulary. */
function refusalCode(reasonCode: string): ApprovalAuthorityErrorCode {
  switch (reasonCode) {
    case 'DUPLICATE_APPROVAL':
      return 'APPROVAL_DUPLICATE';
    case 'APPROVAL_INSUFFICIENT_EVIDENCE':
      return 'APPROVAL_EVIDENCE_INSUFFICIENT';
    case 'APPROVAL_EXPIRED':
    case 'APPROVAL_REQUEST_INVALID':
      return 'APPROVAL_REQUEST_CLOSED';
    default:
      return 'APPROVAL_APPROVER_INELIGIBLE';
  }
}

function validContext(context: unknown): ApprovalCommandContext {
  // Own data properties only: an inherited or getter `authenticated: true` is not a trusted context.
  if (context === null || typeof context !== 'object' || readOwn(context, 'authenticated') !== true || !isText(readOwn(context, 'actorId')) || !isText(readOwn(context, 'authenticatedBy'))) {
    fail('APPROVAL_CONTEXT_UNTRUSTED', 'An approval command requires a trusted, authenticated actor context { authenticated: true, actorId, authenticatedBy }.');
  }
  return { authenticated: true, actorId: readOwn(context, 'actorId') as string, authenticatedBy: readOwn(context, 'authenticatedBy') as string };
}

function validCommand(command: unknown): { readonly approvalRequestId: string; readonly subjectDigest: string; readonly evidence: readonly ApprovalEvidenceInput[]; readonly reason?: string } {
  if (command === null || typeof command !== 'object' || Array.isArray(command)) fail('APPROVAL_INVALID', 'The command must be an object.');
  // Closed: a command names no actor — an `approverId` (or anything else) is refused, never ignored.
  for (const key of Reflect.ownKeys(command)) {
    if (typeof key !== 'string' || !COMMAND_KEYS.has(key)) fail('APPROVAL_INVALID', `The command does not accept '${String(key)}'; the acting actor comes only from the authenticated context.`);
  }
  const approvalRequestId = readOwn(command, 'approvalRequestId');
  const subjectDigest = readOwn(command, 'subjectDigest');
  const reason = readOwn(command, 'reason');
  const rawEvidence = readOwn(command, 'evidence');
  if (!isText(approvalRequestId) || typeof subjectDigest !== 'string' || !SHA256.test(subjectDigest)) fail('APPROVAL_INVALID', 'The command must name the approvalRequestId and the subjectDigest the actor was shown.');
  if (reason !== undefined && !isText(reason)) fail('APPROVAL_INVALID', `reason must be a non-empty string of at most ${String(MAX_TEXT)} characters when present.`);
  const evidence: ApprovalEvidenceInput[] = [];
  if (rawEvidence !== undefined) {
    if (!Array.isArray(rawEvidence) || rawEvidence.length > MAX_EVIDENCE) fail('APPROVAL_INVALID', `evidence must be an array of at most ${String(MAX_EVIDENCE)} references.`);
    for (const entry of rawEvidence as unknown[]) {
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) fail('APPROVAL_INVALID', 'An evidence reference must be an object.');
      for (const key of Reflect.ownKeys(entry)) {
        if (typeof key !== 'string' || !EVIDENCE_KEYS.has(key)) fail('APPROVAL_INVALID', `An evidence reference does not accept '${String(key)}'.`);
      }
      const type = readOwn(entry, 'type');
      const hash = readOwn(entry, 'hash');
      const uri = readOwn(entry, 'uri');
      if (!isText(type) || typeof hash !== 'string' || !SHA256.test(hash) || (uri !== undefined && !isText(uri))) {
        fail('APPROVAL_INVALID', 'An evidence reference is { type, hash: sha256:<hex>, uri? }.');
      }
      evidence.push({ type, hash, ...(uri !== undefined ? { uri: uri as string } : {}) });
    }
  }
  return { approvalRequestId, subjectDigest, evidence, ...(reason !== undefined ? { reason: reason as string } : {}) };
}

export function createApprovalAuthority(options: ApprovalAuthorityOptions): ApprovalAuthority {
  const { store, governance, organizationId, now, authority, resolveEffectiveProfile } = options;

  /** The profile trusted configuration holds under exactly this key, if any. */
  function profileByKey(key: string): ResolvedGovernanceProfile | undefined {
    return governance.profiles.find((profile) => formatGovernanceProfileReference(profile.reference) === key);
  }

  /**
   * Whether trusted configuration still holds the profile and the exact
   * requirement a request was opened under. A request whose profile changed
   * (another version or digest) or whose requirement changed is **superseded**:
   * invalidated, never reinterpreted under the new configuration — a quorum-2
   * request never becomes quorum-1 because the configuration was edited.
   */
  function stillConfigured(subject: ApprovalSubject): boolean {
    const requirement = profileByKey(subject.governanceProfile)?.definition.approval;
    return requirement !== undefined && approvalRequirementDigest(requirement) === subject.requirementDigest;
  }

  /** A `requested` row's subject, re-proven against its own digest before it is shown to anyone or relied on. */
  function subjectOf(row: StoredApprovalRecord): ApprovalSubject {
    if (row.subject === undefined || approvalSubjectDigest(row.subject) !== row.subjectDigest) {
      throw new ApprovalAuthorityError('APPROVAL_STORE_CORRUPT', 'An approval request does not carry the subject its digest names.');
    }
    const subject = JSON.parse(row.subject) as ApprovalSubject;
    if (subject.organizationId !== organizationId || subject.requestId !== row.requestId || subject.decisionId !== row.decisionId) {
      throw new ApprovalAuthorityError('APPROVAL_STORE_CORRUPT', 'An approval request names another request, decision or organization than its row.');
    }
    return subject;
  }

  function viewOf(rows: readonly StoredApprovalRecord[], requested: StoredApprovalRecord, at: string): ApprovalRequestView {
    const subject = subjectOf(requested);
    const approvalRequestId = approvalRequestIdFor(organizationId, requested.requestId, requested.decisionId, requested.subjectDigest);
    return {
      approvalRequestId,
      requestId: requested.requestId,
      decisionId: requested.decisionId,
      subjectDigest: requested.subjectDigest,
      subject,
      requestedAt: requested.recordedAt,
      superseded: !stillConfigured(subject),
      state: evaluateApproval({ subject, subjectDigest: requested.subjectDigest, approvalRequestId, rows, now: at, authority }),
    };
  }

  /** The first `requested` row of each (request, decision) — the canonical approval request of that committed decision. */
  function requestsIn(rows: readonly StoredApprovalRecord[]): readonly StoredApprovalRecord[] {
    const seen = new Set<string>();
    const out: StoredApprovalRecord[] = [];
    for (const row of rows) {
      if (row.kind !== 'requested') continue;
      const key = `${row.requestId}\u0000${row.decisionId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(row);
    }
    return out;
  }

  // One write at a time, so "is it still open?" and the append see the same history.
  let tail: Promise<unknown> = Promise.resolve();
  function serialized<T>(work: () => Promise<T>): Promise<T> {
    const result = tail.then(work);
    tail = result.catch(() => undefined);
    return result;
  }

  async function commandOnce(kind: ApprovalCommandKind, rawContext: unknown, rawCommand: unknown): Promise<ApprovalRequestView> {
    const context = validContext(rawContext);
    const command = validCommand(rawCommand);
    const rows = await store.read(organizationId);
    const requested = requestsIn(rows).find((row) => approvalRequestIdFor(organizationId, row.requestId, row.decisionId, row.subjectDigest) === command.approvalRequestId);
    // Only the subject the governed path itself recorded for a committed
    // decision can be acted on — and only the exact one the actor was shown.
    if (requested === undefined || requested.subjectDigest !== command.subjectDigest) fail('APPROVAL_INVALID', 'No approval request awaits a command on that subject.');
    const requestRows = rows.filter((row) => row.requestId === requested.requestId);
    const at = now();
    const view = viewOf(requestRows, requested, at);
    if (view.superseded) fail('APPROVAL_REQUEST_SUPERSEDED', "The request's Governance Profile or approval requirement has changed since it was opened; it accepts no further commands.");

    const recordKind = RECORD_KIND[kind];
    if (recordKind === 'revoked') {
      // Revocation only restricts. It needs an open or completed request and
      // the actor's live approval standing — never segregation of duties.
      if (view.state.status !== 'pending' && view.state.status !== 'approved') fail('APPROVAL_REQUEST_CLOSED', `The approval request is ${view.state.status}; there is nothing to revoke.`);
      const recognition = safe(() => authority.recognition(context.actorId));
      const standing = safe(() => authority.authority({ actorId: context.actorId, capability: view.subject.requirement.approverAction, resourceScope: view.subject.resourceScope, at }));
      if (recognition?.recognized !== true || standing?.valid !== true) fail('APPROVAL_APPROVER_INELIGIBLE', 'The actor does not hold live approval authority over this resource.', standing?.reasonCode ?? recognition?.reasonCode);
    } else {
      if (view.state.status !== 'pending') fail('APPROVAL_REQUEST_CLOSED', `The approval request is ${view.state.status}; it accepts no further verdicts.`);
      // approval-runtime's own admission chain, with the actor's standing read
      // from Kernel-Authority now: recognition, authority, scope, evidence,
      // segregation of duties, expiration, revocation, duplicate.
      const prior: ApprovalDecision[] = view.state.verdicts
        .filter((verdict) => verdict.kind === 'approved' && verdict.counted)
        .map((verdict) => ({
          id: verdict.rowDigest,
          approvalRequestId: view.approvalRequestId,
          trustDomainId: organizationId,
          approverActorId: verdict.actorId,
          type: 'approved',
          approved: true,
          reasonCode: verdict.reasonCode,
          evidenceReviewed: [],
          decidedAt: verdict.recordedAt,
        }));
      const evidenceReviewed: ApprovalEvidenceArtifact[] = command.evidence.map((entry) => ({
        id: entry.hash,
        type: entry.type as ApprovalEvidenceType,
        providedByActorId: context.actorId,
        hash: entry.hash,
        ...(entry.uri !== undefined ? { uri: entry.uri } : {}),
        createdAt: at,
      }));
      const admitted = admit(
        policyContextFor({
          request: runtimeRequestOf(view.subject, view.approvalRequestId, 'pending'),
          actorId: context.actorId,
          type: recordKind as 'approved' | 'rejected' | 'requested_changes' | 'escalated',
          evidenceReviewed,
          decidedAt: at,
          authorityAt: at,
          priorDecisions: prior,
          authority,
        }),
      );
      if (!admitted.passed) fail(refusalCode(admitted.reasonCode), `approval-runtime refused the ${kind} command (${admitted.reasonCode}).`, admitted.reasonCode);
    }

    const row: ApprovalRowContent = {
      organizationId,
      requestId: requested.requestId,
      decisionId: requested.decisionId,
      subjectDigest: requested.subjectDigest,
      kind: recordKind,
      actorId: context.actorId,
      ...(command.evidence.length > 0 ? { evidence: canonicalEvidence(command.evidence) } : {}),
      ...(command.reason !== undefined ? { reason: command.reason } : {}),
      recordedBy: context.authenticatedBy,
      recordedAt: at,
    };
    await store.append(row);
    const after = (await store.read(organizationId, requested.requestId)).filter((candidate) => candidate.requestId === requested.requestId);
    return viewOf(after, requested, now());
  }

  function command(kind: ApprovalCommandKind) {
    return (context: ApprovalCommandContext, input: ApprovalCommand): Promise<ApprovalRequestView> => serialized(() => commandOnce(kind, context, input));
  }

  return Object.freeze({
    storeKind: store.kind,

    async assess(input: ApprovalAssessInput): Promise<ApprovalAssessment> {
      // The Kernel's own reading of its own decision: only an
      // `approval_required` awaiting a human approval can be answered by one.
      if (!decisionAwaitsHumanApproval(input.decision)) return { kind: 'not-applicable' };
      // CORE-04's rule: the trusted registry resolves the effective profile
      // from action × resource; the request's own claim may only agree.
      const selection = selectEffectiveProfile(resolveEffectiveProfile, input.request);
      if (selection.kind !== 'profile') return { kind: 'not-applicable' };
      const profile = profileByKey(selection.key);
      const requirement: GovernanceProfileApproval | undefined = profile?.definition.approval;
      if (profile === undefined || requirement === undefined) return { kind: 'not-applicable' };

      const subject = approvalSubjectOf({
        organizationId,
        evaluationId: input.evaluationId,
        request: input.request,
        decision: input.decision,
        decisionDigest: input.decisionDigest,
        profile: { key: selection.key, actionClass: profile.definition.actionClass, resourceClass: profile.definition.resourceClass },
        requirement,
      });
      const canonical = canonicalApprovalSubject(subject);
      const subjectDigest = approvalSubjectDigest(canonical);
      let outcome: { readonly rows: readonly StoredApprovalRecord[]; readonly requested: StoredApprovalRecord } | 'superseded';
      try {
        outcome = await serialized(async () => {
          const current = await store.read(organizationId, subject.requestId);
          // A governed request has exactly one committed decision, and that
          // decision exactly one canonical approval request: a retry while
          // pending finds it and opens nothing new. Anything else already
          // opened under this request id — another decision, or the same one
          // under other bytes — is a substitution, never a second lifecycle.
          const existing = requestsIn(current).find((row) => row.requestId === subject.requestId);
          if (existing !== undefined) return existing.decisionId === subject.decisionId && existing.subjectDigest === subjectDigest ? { rows: current, requested: existing } : 'superseded';
          const appended = await store.append({
            organizationId,
            requestId: subject.requestId,
            decisionId: subject.decisionId,
            subjectDigest,
            kind: 'requested',
            subject: canonical,
            recordedBy: APPROVAL_REQUESTED_BY,
            recordedAt: now(),
          });
          return { rows: await store.read(organizationId, subject.requestId), requested: appended };
        });
      } catch {
        return { kind: 'withheld', status: 'unavailable' };
      }
      // The request was opened for this decision under other bytes — a
      // changed profile or requirement, or changed decision digests. Never
      // reinterpreted: invalidated.
      if (outcome === 'superseded') return { kind: 'withheld', status: 'superseded' };
      let state: ApprovalEvaluation;
      try {
        state = viewOf(outcome.rows, outcome.requested, now()).state;
      } catch {
        return { kind: 'withheld', status: 'unavailable' };
      }
      if (state.status === 'approved' && state.approvalDigest !== undefined && state.notAfter !== undefined) {
        return { kind: 'approved', approvalDigest: state.approvalDigest, notAfter: state.notAfter };
      }
      return { kind: 'withheld', status: state.status === 'approved' ? 'unavailable' : state.status };
    },

    async pending(): Promise<readonly ApprovalRequestView[]> {
      const rows = await store.read(organizationId);
      const at = now();
      const open: ApprovalRequestView[] = [];
      for (const requested of requestsIn(rows)) {
        const view = viewOf(
          rows.filter((row) => row.requestId === requested.requestId),
          requested,
          at,
        );
        if (!view.superseded && view.state.status === 'pending') open.push(view);
      }
      return open.sort((left, right) => left.requestedAt.localeCompare(right.requestedAt));
    },

    async describe(requestId: string): Promise<ApprovalRequestView | undefined> {
      if (!isText(requestId)) return undefined;
      const rows = await store.read(organizationId, requestId);
      const requested = requestsIn(rows).at(-1);
      return requested === undefined ? undefined : viewOf(rows, requested, now());
    },

    approve: command('approve'),
    reject: command('reject'),
    requestChanges: command('requestChanges'),
    escalate: command('escalate'),
    revoke: command('revoke'),
  });
}

function safe<T>(read: () => T): T | undefined {
  try {
    return read();
  } catch {
    return undefined;
  }
}
