import * as React from 'react';

import type { HostFailure } from '../failures.js';
import { APPROVAL_VIEWS, type ApprovalDetail, type ApprovalInbox, type ApprovalInboxEntry, type ApprovalVerb, type OrganizationContext } from '../wire.js';
import { ActionLink, CsrfField, Empty, FailureNotice, Id, KeyValues, List, Notice, Section, Status, Text, Time } from './components.js';
import { may, Page } from './layout.js';

/**
 * CTRL-04 — the approval inbox, one approval request, and the verdict forms.
 *
 * Every value is restated from the Host, which restated it from the CORE-05
 * view: **durable facts** (the canonical subject the governed path recorded,
 * each verdict row: who, when, through which channel, with which note and
 * evidence) are shown as recorded; **derived state** (status, counted
 * approvers, quorum, expiry, the approval digest) is labelled derived and was
 * computed by CORE-05 when the Host was read. The console counts nothing,
 * completes nothing and never marks anything approved on its own.
 */

export const approvalPath = (approvalRequestId: string): string => `/approvals/${encodeURIComponent(approvalRequestId)}`;

const VIEW_LABELS: Readonly<Record<(typeof APPROVAL_VIEWS)[number], string>> = {
  pending: 'Pending',
  escalated: 'Escalated',
  approved: 'Approved',
  rejected: 'Rejected',
  revoked: 'Revoked',
  expired: 'Expired',
  superseded: 'Superseded',
  all: 'All',
};

export const APPROVAL_COVERAGE =
  'Approval requests opened by the governed path when a committed Kernel decision awaited a human approval. Status, counted approvers and quorum are derived by the Host’s approval engine (CORE-05) from the recorded verdicts and each approver’s live Kernel-Authority standing at the moment this page was read — never stored, never computed by this console.';

export const ESCALATION_COVERAGE =
  'Open requests someone escalated, with the reference they recorded. An escalation is recorded and visible here; it counts toward no quorum, grants no authority and sends no notification.';

/** Quorum as CORE-05 derived it: counted distinct approvers over the snapshotted minimum. */
export function Quorum({ quorum }: { readonly quorum: ApprovalInboxEntry['quorum'] }): React.ReactElement {
  return (
    <span className="quorum" data-testid="quorum">
      {quorum.countedApprovers.length} / {quorum.minimumApprovals}
      {quorum.satisfied ? ' — quorum satisfied' : ''}
    </span>
  );
}

export interface ApprovalsPageProps {
  readonly context: OrganizationContext;
  readonly csrfToken: string;
  readonly view: (typeof APPROVAL_VIEWS)[number];
  readonly inbox: ApprovalInbox | HostFailure;
  readonly flash?: string;
}

export function ApprovalsPage({ context, csrfToken, view, inbox, flash }: ApprovalsPageProps): React.ReactElement {
  return (
    <Page title="Approvals" context={context} csrfToken={csrfToken} active="/approvals" {...(flash !== undefined ? { flash } : {})}>
      <nav className="tabs" aria-label="Approval views">
        <ul className="inline-list">
          {APPROVAL_VIEWS.map((candidate) => (
            <li key={candidate}>
              <a href={`/approvals?view=${candidate}`} aria-current={candidate === view ? 'page' : undefined} className={candidate === view ? 'tab tab--active' : 'tab'}>
                {VIEW_LABELS[candidate]}
              </a>
            </li>
          ))}
        </ul>
      </nav>
      <p className="muted">{view === 'escalated' ? ESCALATION_COVERAGE : APPROVAL_COVERAGE}</p>
      {'kind' in inbox ? (
        <FailureNotice failure={inbox} />
      ) : inbox.approvals.length === 0 ? (
        <Empty message={`No approval request is ${view === 'all' ? 'recorded' : VIEW_LABELS[view].toLowerCase()}.`} />
      ) : (
        <table className="table" data-testid="approvals">
          <thead>
            <tr>
              <th scope="col">Requested at</th>
              <th scope="col">Status (derived)</th>
              <th scope="col">Requester</th>
              <th scope="col">Action</th>
              <th scope="col">Resource</th>
              <th scope="col">Quorum (derived)</th>
              <th scope="col">Request expires</th>
              <th scope="col">Escalations</th>
              <th scope="col">Request</th>
            </tr>
          </thead>
          <tbody>
            {inbox.approvals.map((entry) => (
              <tr key={entry.approvalRequestId} data-approval={entry.approvalRequestId}>
                <td>
                  <Time value={entry.requestedAt} />
                </td>
                <td>
                  <Status value={entry.status} />
                </td>
                <td>
                  <Id value={entry.actorId} />
                </td>
                <td>
                  <Id value={entry.action} />
                </td>
                <td>
                  <Id value={entry.resourceScope} />
                </td>
                <td>
                  <Quorum quorum={entry.quorum} />
                </td>
                <td>
                  <Time value={entry.requestExpiresAt} />
                </td>
                <td>
                  {entry.escalations.length === 0 ? (
                    <span className="muted">none</span>
                  ) : (
                    <ul className="plain-list" data-testid="escalations">
                      {entry.escalations.map((escalation) => (
                        <li key={`${escalation.actorId}-${escalation.recordedAt}`}>
                          <Id value={escalation.actorId} /> at <Time value={escalation.recordedAt} />: <Text value={escalation.reason} />
                        </li>
                      ))}
                    </ul>
                  )}
                </td>
                <td>
                  <a href={approvalPath(entry.approvalRequestId)}>Review</a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Page>
  );
}

const VERB_LABELS: Readonly<Record<ApprovalVerb, string>> = {
  approve: 'Approve',
  reject: 'Reject',
  'request-changes': 'Request changes',
  escalate: 'Escalate',
  revoke: 'Revoke approval',
};

/** Which verdict links the page offers for a derived status. Presentation only: the Host and CORE-05 decide again on every command. */
function offered(detail: ApprovalDetail): readonly ApprovalVerb[] {
  if (detail.status === 'pending') return ['approve', 'reject', 'request-changes', 'escalate', 'revoke'];
  if (detail.status === 'approved') return ['revoke'];
  return [];
}

const VERB_PERMISSION: Readonly<Record<ApprovalVerb, string>> = {
  approve: 'approval.approve',
  reject: 'approval.restrict',
  'request-changes': 'approval.restrict',
  escalate: 'approval.restrict',
  revoke: 'approval.restrict',
};

/** The canonical subject, field by field, exactly as recorded. */
export function SubjectRows({ detail }: { readonly detail: ApprovalDetail }): React.ReactElement {
  const { subject } = detail;
  return (
    <KeyValues
      rows={[
        ['Approval request', <Id key="ar" value={detail.approvalRequestId} />],
        ['Governed request', <Id key="r" value={detail.requestId} />],
        ['Committed decision', <Id key="d" value={detail.decisionId} />],
        ['Evaluation', <Id key="e" value={subject.evaluationId} />],
        ['Requester (actor)', <Id key="a" value={subject.actorId} />],
        ['On behalf of (principal)', subject.principalActorId === null ? <span key="p" className="muted">—</span> : <Id key="p" value={subject.principalActorId} />],
        ['Action', <Id key="ac" value={subject.action} />],
        ['Resource', <Id key="rs" value={subject.resourceScope} />],
        ['Counterparty', subject.counterpartyId === null ? <span key="c" className="muted">—</span> : <Id key="c" value={subject.counterpartyId} />],
        ['Amount', subject.amount === null ? <span key="am" className="muted">—</span> : <code key="am">{`${subject.amount.value} ${subject.amount.unit}`}</code>],
        [
          'Typed parameters',
          subject.parameters.length === 0 ? (
            <span key="pa" className="muted">none</span>
          ) : (
            <ul key="pa" className="plain-list" data-testid="subject-parameters">
              {subject.parameters.map((parameter) => (
                <li key={parameter.dimension}>
                  <Id value={parameter.dimension} /> ({parameter.type}) = <code>{String(parameter.value)}</code>
                </li>
              ))}
            </ul>
          ),
        ],
        ['Governance Profile', <Id key="g" value={subject.governanceProfile} />],
        ['Action class / resource class', <code key="cl">{`${subject.actionClass} / ${subject.resourceClass}`}</code>],
        ['Admitted context digest', subject.contextDigest === null ? <span key="cd" className="muted">—</span> : <Id key="cd" value={subject.contextDigest} />],
        ['Context valid until', <Time key="cv" value={subject.contextValidUntil} />],
        ['Kernel decision', <Status key="ks" value={subject.decision.status} />],
        ['Kernel reason codes', <List key="kr" values={subject.decision.reasonCodes} />],
        ['Decided at', <Time key="da" value={subject.decision.evaluatedAt} />],
        ['Recorded request digest', <Id key="rd" value={subject.decisionDigest.requestDigest} />],
        ['Recorded evaluation digest', <Id key="ed" value={subject.decisionDigest.evaluationDigest} />],
        ['Subject digest (what a verdict binds)', <Id key="sd" value={detail.subjectDigest} />],
      ]}
    />
  );
}

function RequirementRows({ detail }: { readonly detail: ApprovalDetail }): React.ReactElement {
  const { requirement } = detail;
  return (
    <KeyValues
      rows={[
        ['Approver action (separate from the governed action)', <Id key="aa" value={requirement.approverAction} />],
        ['Minimum distinct approvers', <code key="m">{requirement.minimumApprovals}</code>],
        ['Request accepts verdicts for', <code key="t">{`${requirement.requestTtlSeconds} s after the decision`}</code>],
        ['A completed approval is usable for', <code key="v">{`${requirement.approvalValiditySeconds} s`}</code>],
        ['Required evidence types', <List key="re" values={requirement.requiredEvidence} />],
        ['Requirement snapshot digest', <Id key="rqd" value={requirement.digest} />],
      ]}
    />
  );
}

function DerivedRows({ detail }: { readonly detail: ApprovalDetail }): React.ReactElement {
  return (
    <KeyValues
      rows={[
        ['Status', <Status key="s" value={detail.status} />],
        ['Quorum', <Quorum key="q" quorum={detail.quorum} />],
        ['Counted approvers', <List key="ca" values={detail.quorum.countedApprovers} />],
        ['Request expires (Host time)', <Time key="re" value={detail.requestExpiresAt} />],
        ['Quorum reached at', <Time key="qa" value={detail.approvedAt} />],
        ['Approval usable until (Host time)', <Time key="na" value={detail.notAfter} />],
        ['Approval digest', detail.approvalDigest === null ? <span key="ad" className="muted">— (no usable completed approval)</span> : <Id key="ad" value={detail.approvalDigest} />],
        ['Closed by', detail.closedBy === null ? <span key="cb" className="muted">—</span> : <Id key="cb" value={detail.closedBy} />],
        ['Superseded by a configuration change', <code key="su">{detail.superseded ? 'yes — accepts no further command' : 'no'}</code>],
      ]}
    />
  );
}

const KIND_LABELS: Readonly<Record<string, string>> = {
  approved: 'approved',
  rejected: 'rejected (final)',
  requested_changes: 'changes requested (does not count)',
  escalated: 'escalated (does not count)',
  revoked: 'revoked (final)',
};

function VerdictTable({ detail }: { readonly detail: ApprovalDetail }): React.ReactElement {
  if (detail.verdicts.length === 0) return <Empty message="No verdict is recorded on this request." />;
  return (
    <table className="table" data-testid="verdicts">
      <thead>
        <tr>
          <th scope="col">Recorded at</th>
          <th scope="col">Verdict (recorded)</th>
          <th scope="col">Actor</th>
          <th scope="col">Channel</th>
          <th scope="col">Note</th>
          <th scope="col">Evidence references</th>
          <th scope="col">Counts now (derived)</th>
          <th scope="col">Reason code (derived)</th>
        </tr>
      </thead>
      <tbody>
        {detail.verdicts.map((verdict) => (
          <tr key={verdict.rowDigest} data-verdict={verdict.kind}>
            <td>
              <Time value={verdict.recordedAt} />
            </td>
            <td>{KIND_LABELS[verdict.kind] ?? verdict.kind}</td>
            <td>
              <Id value={verdict.actorId} />
            </td>
            <td>
              <Id value={verdict.recordedBy} />
            </td>
            <td>
              <Text value={verdict.reason} />
            </td>
            <td>
              {verdict.evidence.length === 0 ? (
                <span className="muted">none</span>
              ) : (
                <ul className="plain-list">
                  {verdict.evidence.map((entry) => (
                    <li key={`${entry.type}-${entry.hash}`}>
                      <Id value={entry.type} /> <Id value={entry.hash} />
                      {entry.uri !== null ? (
                        <>
                          {' '}
                          <Id value={entry.uri} />
                        </>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
            </td>
            <td>{verdict.counted ? 'yes' : 'no'}</td>
            <td>
              <Id value={verdict.reasonCode} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export interface ApprovalPageProps {
  readonly context: OrganizationContext;
  readonly csrfToken: string;
  readonly detail: ApprovalDetail;
  readonly flash?: string;
}

export function ApprovalPage({ context, csrfToken, detail, flash }: ApprovalPageProps): React.ReactElement {
  const actions = offered(detail).filter((verb) => may(context, VERB_PERMISSION[verb]));
  return (
    <Page title="Approval request" context={context} csrfToken={csrfToken} active="/approvals" {...(flash !== undefined ? { flash } : {})}>
      {detail.status === 'approved' ? (
        <Notice tone="success" title="Approval quorum satisfied — the action has not been executed">
          <p>
            An approval is not an execution. The original requester must retry its own governed action (the same request) for the Host to resume the same committed decision; every other gate is checked again then. This
            console never performs the governed action.
          </p>
        </Notice>
      ) : null}
      {detail.status === 'rejected' ? (
        <Notice tone="danger" title="Rejected — final">
          <p>A rejection is final. No later approval counts and the governed action will not proceed under this request.</p>
        </Notice>
      ) : null}
      {detail.status === 'revoked' ? (
        <Notice tone="danger" title="Approval revoked — final">
          <p>A revoked approval cannot be restored. No new grant is issued under it, and a grant already issued but not yet exercised is withheld before execution.</p>
        </Notice>
      ) : null}
      {detail.changesRequested > 0 && detail.status === 'pending' ? (
        <Notice tone="info" title="Changes were requested">
          <p>Requesting changes does not alter this governed request and does not count toward quorum. A changed action needs a new governed request from its requester, which opens a new approval request.</p>
        </Notice>
      ) : null}
      {detail.escalations.length > 0 && detail.status === 'pending' ? (
        <Notice tone="warning" title="Escalated">
          <p>This request was escalated ({detail.escalations.length}). Escalation is recorded and visible in the Escalated view; it counts toward no quorum and grants no authority.</p>
        </Notice>
      ) : null}
      <Section title="Derived state (computed by the Host’s approval engine when this page was read)">
        <DerivedRows detail={detail} />
      </Section>
      <Section title="Canonical subject (recorded by the governed path)">
        <SubjectRows detail={detail} />
      </Section>
      <Section title="Requirement snapshot (from the trusted Governance Profile)">
        <RequirementRows detail={detail} />
      </Section>
      <Section title="Recorded verdicts">
        <VerdictTable detail={detail} />
      </Section>
      <Section title="Canonical subject bytes">
        <p className="muted">
          Exactly the bytes the subject digest <Id value={detail.subjectDigest} /> was taken over.
        </p>
        <pre className="canonical" data-testid="canonical-subject">
          {detail.canonicalSubject}
        </pre>
      </Section>
      <Section title="Decide">
        {actions.length === 0 ? (
          <p className="muted">{offered(detail).length === 0 ? 'This request accepts no further verdict.' : 'Your operator role does not hold an approval permission. (The Host decides again on every request.)'}</p>
        ) : (
          <>
            <p>Your operator role lets you submit these verdicts. Whether a verdict counts is decided by the Host from your own Kernel-Authority approval standing for the approver action over this resource.</p>
            <ul className="inline-list" data-testid="approval-actions">
              {actions.map((verb) => (
                <li key={verb}>
                  <ActionLink href={`${approvalPath(detail.approvalRequestId)}/${verb}`}>{VERB_LABELS[verb]}…</ActionLink>
                </li>
              ))}
            </ul>
          </>
        )}
      </Section>
    </Page>
  );
}

const VERB_WARNINGS: Readonly<Record<ApprovalVerb, { readonly warning: string; readonly consequences: readonly string[] }>> = {
  approve: {
    warning: 'Approving is a permitting decision about exactly the subject shown above.',
    consequences: [
      'Your verdict is bound to the subject digest shown; if the request changed since this page was rendered, it is refused and you must review it again.',
      'It counts only if you hold live Kernel-Authority standing for the approver action over this resource, you are not the requester, and you cite every required evidence type.',
      'An approval is not an execution: when quorum is satisfied, the original requester must retry its own governed action. This console does not perform it.',
    ],
  },
  reject: {
    warning: 'Rejection is final. There is no undo.',
    consequences: ['The request closes as rejected; no later approval counts.', 'The requester’s retries of this governed request will not proceed.'],
  },
  'request-changes': {
    warning: 'Requesting changes is recorded and changes nothing else.',
    consequences: ['It does not count toward quorum and does not alter the governed request.', 'A changed action needs a new governed request from its requester, which opens a new approval request.'],
  },
  escalate: {
    warning: 'Escalation is recorded and makes the request visible in the Escalated view.',
    consequences: ['It counts toward no quorum and grants nobody authority.', 'No email, chat or push notification is sent. Record a reference others can act on.'],
  },
  revoke: {
    warning: 'Revoking closes this request — pending or approved. There is no undo.',
    consequences: ['No new grant is issued under it.', 'A grant already issued but not yet exercised is withheld before execution.', 'Restoring approval means a new governed request.'],
  },
};

export interface ApprovalCommandPageProps {
  readonly context: OrganizationContext;
  readonly csrfToken: string;
  readonly detail: ApprovalDetail;
  readonly verb: ApprovalVerb;
  readonly failure?: HostFailure;
}

/** The deliberate confirmation step for one verdict. The hidden subject digest is the one this page displays. */
export function ApprovalCommandPage({ context, csrfToken, detail, verb, failure }: ApprovalCommandPageProps): React.ReactElement {
  const { warning, consequences } = VERB_WARNINGS[verb];
  const evidenceTypes = verb === 'approve' ? detail.requirement.requiredEvidence : [];
  return (
    <Page title={`${VERB_LABELS[verb]} — approval request`} context={context} csrfToken={csrfToken} active="/approvals">
      {failure !== undefined ? <FailureNotice failure={failure} /> : null}
      <Section title="Derived state (re-read from the Host for this page)">
        <DerivedRows detail={detail} />
      </Section>
      <Section title="Subject you are deciding on">
        <SubjectRows detail={detail} />
      </Section>
      <Section title="Requirement snapshot">
        <RequirementRows detail={detail} />
      </Section>
      <Notice tone="warning" title={warning}>
        <ul>
          {consequences.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </Notice>
      <form method="post" action={`${approvalPath(detail.approvalRequestId)}/${verb}`} className="form">
        <CsrfField token={csrfToken} />
        <input type="hidden" name="subjectDigest" value={detail.subjectDigest} />
        {evidenceTypes.length > 0 ? (
          <fieldset className="fieldset">
            <legend>Evidence you reviewed (required: one reference per type)</legend>
            <p className="muted">A content hash (sha256:…) of each artifact you reviewed. The Host records the reference; it does not fetch or verify the artifact.</p>
            {evidenceTypes.map((type, row) => (
              <div className="field-row" key={type}>
                <input type="hidden" name={`evidence.${row}.type`} value={type} />
                <span className="field-row__label">
                  <Id value={type} />
                </span>
                <label htmlFor={`evidence-${row}-hash`}>Content hash</label>
                <input id={`evidence-${row}-hash`} name={`evidence.${row}.hash`} className="input" autoComplete="off" placeholder="sha256:…" />
                <label htmlFor={`evidence-${row}-uri`}>Location (optional)</label>
                <input id={`evidence-${row}-uri`} name={`evidence.${row}.uri`} className="input" autoComplete="off" maxLength={256} />
              </div>
            ))}
          </fieldset>
        ) : null}
        <div className="field">
          <label htmlFor="reason">
            {verb === 'escalate' ? 'Escalation reference' : 'Note'}
            {verb === 'escalate' ? <span className="required"> (required)</span> : <span className="muted"> (optional; recorded, never interpreted)</span>}
          </label>
          <input id="reason" name="reason" className="input" required={verb === 'escalate'} maxLength={256} autoComplete="off" />
        </div>
        <div className="field field--check">
          <input id="confirm" name="confirm" type="checkbox" value="yes" required />
          <label htmlFor="confirm">I have reviewed the subject above and intend this verdict.</label>
        </div>
        <div className="form__actions">
          <button type="submit" className={verb === 'approve' ? 'button' : 'button button--danger'}>
            {VERB_LABELS[verb]}
          </button>
          <a className="button button--quiet" href={approvalPath(detail.approvalRequestId)}>
            Cancel
          </a>
        </div>
      </form>
    </Page>
  );
}
