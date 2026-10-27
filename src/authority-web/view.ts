import type { ApprovalDetail, ApprovalSummary, Verdict } from './contracts.js';
import type { Controller, State } from './controller.js';
import { DECISION_LABELS, REQUEST_STATUS_LABELS, VERDICT_LABELS, grouped, remaining, utc } from './format.js';
import { h, type Child, type VElement } from './vnode.js';

/**
 * AUTH-04C — the Authority web client's view: a pure function of state.
 *
 * Every value from the server is rendered as text. The plain-language summary
 * is visibly separate from the authoritative subject, and the exact canonical
 * bytes the subject digest covers are always one tap away, never truncated.
 * Decision buttons exist only for verdicts the Host listed, only after the
 * human opened the request, and only lead to a confirmation step.
 */

const BRAND = 'FRONTERA AUTHORITY';

const heading = (text: string): VElement => h('h1', { tabindex: '-1', 'data-focus': 'screen', id: 'screen-title' }, text);

function timeOf(iso: string, nowMs: number, withRemaining = false): VElement {
  const left = withRemaining ? remaining(iso, nowMs) : '';
  return h('span', {}, h('time', { datetime: iso }, utc(iso)), left !== '' ? h('small', { class: 'muted' }, ` · ${left === 'passed' ? 'passed' : left}`) : null);
}

function row(label: string, ...value: Child[]): VElement[] {
  return [h('dt', {}, label), h('dd', {}, ...value)];
}

function noticeRegion(state: State, controller: Controller): VElement {
  const notice = state.notice;
  return h(
    'div',
    { class: 'notice-region', 'aria-live': 'polite' },
    notice === null
      ? null
      : h(
          'div',
          { class: 'notice', 'data-tone': notice.tone, role: notice.tone === 'error' || notice.tone === 'warning' ? 'alert' : 'status' },
          h('p', {}, notice.message),
          notice.code !== undefined ? h('small', { class: 'muted code' }, `Reference: ${notice.code}`) : null,
          h('button', { type: 'button', class: 'link', onClick: () => controller.dismissNotice(), 'aria-label': 'Dismiss message' }, 'Dismiss'),
        ),
  );
}

function welcome(state: State, controller: Controller): VElement {
  return h(
    'section',
    { class: 'screen welcome', 'aria-labelledby': 'screen-title' },
    heading('Sign in'),
    h('p', { class: 'lede' }, 'Review and decide on actions your organization’s AI agents have asked to take. Every decision is confirmed with your passkey.'),
    !state.passkeysSupported ? h('p', { class: 'notice inline', 'data-tone': 'warning', role: 'alert' }, 'This browser does not support passkeys. Use Safari on a current iPhone, or another passkey-capable browser.') : null,
    h('button', { type: 'button', class: 'primary', disabled: state.busy || !state.passkeysSupported, 'aria-busy': state.busy ? 'true' : undefined, onClick: () => void controller.signIn() }, state.busy ? 'Waiting for your passkey…' : 'Sign in with passkey'),
    h('div', { class: 'secondary-actions' }, h('p', { class: 'muted' }, 'First time here?'), h('button', { type: 'button', class: 'secondary', disabled: state.busy, onClick: () => controller.showEnrolment() }, 'Register with an invitation')),
  );
}

function enrol(state: State, controller: Controller): VElement {
  return h(
    'section',
    { class: 'screen enrol', 'aria-labelledby': 'screen-title' },
    heading('Register your passkey'),
    h('p', { class: 'lede' }, 'Your administrator gave you a one-time invitation code in person. It is valid for a short time and can be used once.'),
    h(
      'ul',
      { class: 'facts' },
      h('li', {}, 'Your device creates a passkey for Frontera Authority. Your fingerprint or face never leaves your device.'),
      h('li', {}, 'Registering gives you no new permissions. What you may approve is set by your organization.'),
      h('li', {}, 'After registering, sign in with your new passkey.'),
    ),
    h(
      'form',
      { class: 'form', onSubmit: () => void controller.enrol() },
      h('label', { for: 'invitation' }, 'Invitation code'),
      h('input', {
        id: 'invitation',
        name: 'invitation',
        type: 'text',
        value: state.invitation,
        autocomplete: 'off',
        autocapitalize: 'none',
        spellcheck: 'false',
        inputmode: 'text',
        enterkeyhint: 'go',
        maxlength: '256',
        'aria-describedby': 'invitation-help',
        'aria-invalid': state.notice?.code === 'AUTHORITY_ENROLMENT_INVALID' ? 'true' : undefined,
        onInput: (value) => controller.setInvitation(value),
      }),
      h('small', { id: 'invitation-help', class: 'muted' }, 'Never share this code. If it was exposed, ask your administrator to revoke it and issue a new one.'),
      h('button', { type: 'submit', class: 'primary', disabled: state.busy || !state.passkeysSupported }, state.busy ? 'Creating your passkey…' : 'Create passkey'),
    ),
    h('button', { type: 'button', class: 'link', disabled: state.busy, onClick: () => controller.showWelcome() }, 'Back to sign in'),
  );
}

function enrolled(state: State, controller: Controller): VElement {
  return h(
    'section',
    { class: 'screen enrolled', 'aria-labelledby': 'screen-title' },
    heading('Passkey registered'),
    h('p', { class: 'lede' }, 'Your passkey is registered. Registration did not sign you in.'),
    h('button', { type: 'button', class: 'primary', disabled: state.busy, onClick: () => void controller.signIn() }, 'Sign in with passkey'),
  );
}

function inboxItem(item: ApprovalSummary, nowMs: number, controller: Controller): VElement {
  return h(
    'li',
    {},
    h(
      'button',
      { type: 'button', class: 'card', 'aria-label': `Review request: ${item.action} on ${item.resourceScope}`, onClick: () => void controller.openRequest(item.approvalRequestId) },
      h('span', { class: 'card-title' }, h('strong', {}, item.action), h('span', { class: 'muted' }, ' on '), h('span', { class: 'mono' }, item.resourceScope)),
      h('span', { class: 'card-meta' }, h('span', {}, 'Expires '), timeOf(item.requestExpiresAt, nowMs, true)),
      h('span', { class: 'card-meta muted' }, `${item.governanceProfile} · ${String(item.quorum.counted)} of ${String(item.quorum.minimumApprovals)} approvals`),
    ),
  );
}

function inbox(state: State, controller: Controller, nowMs: number): VElement {
  const items = state.inbox;
  return h(
    'section',
    { class: 'screen inbox', 'aria-labelledby': 'screen-title' },
    h('div', { class: 'title-row' }, heading('Approvals'), items !== null ? h('span', { class: 'badge', 'aria-label': `${String(items.length)} pending` }, `${String(items.length)} pending`) : null),
    h('button', { type: 'button', class: 'secondary small', disabled: state.busy, onClick: () => void controller.loadInbox() }, state.busy ? 'Refreshing…' : 'Refresh'),
    items === null
      ? h('p', { class: 'muted', role: 'status' }, 'Loading approvals…')
      : items.length === 0
        ? h('div', { class: 'empty' }, h('p', {}, 'Nothing awaits your decision.'), h('p', { class: 'muted' }, 'Requests appear here when an agent’s action needs your approval and your standing allows you to decide.'))
        : h('ul', { class: 'cards', 'aria-label': 'Pending approval requests' }, items.map((item) => inboxItem(item, nowMs, controller))),
  );
}

function parameters(detail: ApprovalDetail): VElement {
  if (detail.subject.parameters.length === 0) return h('span', { class: 'muted' }, 'None');
  return h(
    'ul',
    { class: 'params' },
    detail.subject.parameters.map((parameter) => h('li', {}, h('span', { class: 'mono' }, parameter.dimension), ' = ', h('span', { class: 'mono value' }, String(parameter.value)), h('small', { class: 'muted' }, ` (${parameter.type})`))),
  );
}

function digestBadge(state: State): VElement {
  switch (state.digestCheck) {
    case 'verified':
      return h('small', { class: 'pill', 'data-tone': 'success' }, 'Matches the canonical subject (checked on this device)');
    case 'mismatch':
      return h('small', { class: 'pill', 'data-tone': 'error', role: 'alert' }, 'Does not match the canonical subject — do not decide');
    case 'unavailable':
      return h('small', { class: 'pill', 'data-tone': 'warning' }, 'Not checked on this device');
    default:
      return h('small', { class: 'pill' }, 'Checking…');
  }
}

function request(state: State, controller: Controller, nowMs: number): VElement {
  const detail = state.detail;
  if (detail === null) return h('section', { class: 'screen', 'aria-labelledby': 'screen-title' }, heading('Review request'), h('p', { role: 'status' }, 'Loading request…'));
  const subject = detail.subject;
  const decisionAllowed = detail.verdicts.length > 0 && state.digestCheck !== 'mismatch';
  return h(
    'section',
    { class: 'screen request', 'aria-labelledby': 'screen-title' },
    h('button', { type: 'button', class: 'link back', disabled: state.busy, onClick: () => void controller.backToInbox() }, '‹ Approvals'),
    heading('Review request'),
    h(
      'div',
      { class: 'summary', 'aria-label': 'Summary' },
      h('p', { class: 'eyebrow' }, 'Summary'),
      h('p', { class: 'lede' }, 'Agent ', h('span', { class: 'mono' }, subject.actorId), ' requests ', h('strong', {}, subject.action), ' on ', h('span', { class: 'mono' }, subject.resourceScope), subject.amount !== null ? ` for ${subject.amount.value} ${subject.amount.unit}` : '', '.'),
      h('p', { class: 'muted' }, 'This summary is for reading. The authoritative record is the subject below.'),
    ),
    h(
      'section',
      { class: 'subject', 'aria-labelledby': 'subject-title' },
      h('h2', { id: 'subject-title' }, 'Authoritative subject'),
      h(
        'dl',
        { class: 'fields' },
        row('Request', h('span', { class: 'mono wrap' }, detail.approvalRequestId)),
        row('Requesting agent', h('span', { class: 'mono wrap' }, subject.actorId)),
        subject.principalActorId !== null ? row('On behalf of', h('span', { class: 'mono wrap' }, subject.principalActorId)) : [],
        row('Action', h('span', { class: 'mono wrap' }, subject.action)),
        row('Target resource', h('span', { class: 'mono wrap' }, subject.resourceScope)),
        subject.counterpartyId !== null ? row('Counterparty', h('span', { class: 'mono wrap' }, subject.counterpartyId)) : [],
        subject.amount !== null ? row('Amount', h('span', { class: 'mono' }, `${subject.amount.value} ${subject.amount.unit}`)) : [],
        row('Parameters', parameters(detail)),
        row('Governance profile', h('span', { class: 'mono wrap' }, subject.governanceProfile)),
        row('Kernel decision', `${subject.decision.status}${subject.decision.reasonCodes.length > 0 ? ` — ${subject.decision.reasonCodes.join(', ')}` : ''}`),
        row('Evaluated', timeOf(subject.decision.evaluatedAt, nowMs)),
        subject.contextValidUntil !== null ? row('Context valid until', timeOf(subject.contextValidUntil, nowMs)) : [],
        row('Requested', timeOf(detail.requestedAt, nowMs)),
        row('Request expires', timeOf(detail.requestExpiresAt, nowMs, true)),
        row('Approvals', `${String(detail.quorum.counted)} of ${String(detail.quorum.minimumApprovals)} required`),
        row('Approval validity', `${String(detail.requirement.approvalValiditySeconds)} s after quorum`),
        detail.requirement.requiredEvidence.length > 0 ? row('Required evidence', detail.requirement.requiredEvidence.join(', ')) : [],
        row('Subject digest', h('span', { class: 'mono wrap digest' }, grouped(detail.subjectDigest)), ' ', digestBadge(state)),
      ),
      h('details', { class: 'canonical' }, h('summary', {}, 'Canonical signed subject (exact bytes)'), h('pre', { class: 'mono' }, h('code', {}, detail.canonicalSubject))),
    ),
    h(
      'div',
      { class: 'decision-bar', role: 'group', 'aria-label': 'Decision' },
      detail.verdicts.length === 0
        ? h('p', { class: 'muted' }, 'You can review this request, but your role or standing does not allow a decision on it.')
        : [
            h('p', { class: 'muted small' }, 'Choosing a verdict opens a confirmation. Nothing is decided until you confirm with your passkey.'),
            h(
              'div',
              { class: 'buttons' },
              (['reject', 'approve'] as const)
                .filter((verdict) => detail.verdicts.includes(verdict))
                .map((verdict) => h('button', { type: 'button', class: verdict === 'approve' ? 'primary' : 'danger', disabled: state.busy || !decisionAllowed, onClick: () => controller.chooseVerdict(verdict) }, VERDICT_LABELS[verdict])),
            ),
          ],
    ),
  );
}

function confirm(state: State, controller: Controller, verdict: Verdict): VElement {
  const detail = state.detail;
  if (detail === null) return h('section', { class: 'screen' }, heading('Confirm'));
  const waiting = state.phase === 'awaiting-passkey' ? 'Waiting for your passkey…' : state.phase === 'challenging' ? 'Preparing the decision…' : state.phase === 'submitting' ? 'Recording…' : null;
  return h(
    'section',
    { class: 'screen confirm', 'data-tone': verdict === 'approve' ? 'success' : 'error', 'aria-labelledby': 'screen-title' },
    heading(verdict === 'approve' ? 'Confirm approval' : 'Confirm rejection'),
    h(
      'dl',
      { class: 'fields compact' },
      row('Verdict', h('strong', {}, VERDICT_LABELS[verdict])),
      row('Action', h('span', { class: 'mono wrap' }, detail.subject.action)),
      row('Target resource', h('span', { class: 'mono wrap' }, detail.subject.resourceScope)),
      row('Requesting agent', h('span', { class: 'mono wrap' }, detail.subject.actorId)),
      row('Request', h('span', { class: 'mono wrap' }, detail.approvalRequestId)),
      row('Subject digest', h('span', { class: 'mono wrap digest' }, grouped(detail.subjectDigest))),
    ),
    h(
      'ul',
      { class: 'facts' },
      h('li', {}, 'Your passkey will be asked to confirm this exact decision for this exact subject.'),
      h('li', {}, 'Frontera Authority still checks your role, approval standing and the request’s status before recording anything.'),
      verdict === 'approve' ? h('li', {}, 'An approval is not proof that the action ran. Execution is reported separately.') : h('li', {}, 'A rejection closes this request.'),
    ),
    waiting !== null ? h('p', { role: 'status', class: 'progress' }, waiting) : null,
    h(
      'div',
      { class: 'buttons' },
      h('button', { type: 'button', class: 'secondary', disabled: state.busy, onClick: () => controller.cancelVerdict() }, 'Cancel'),
      h('button', { type: 'button', class: verdict === 'approve' ? 'primary' : 'danger', disabled: state.busy, 'aria-busy': state.busy ? 'true' : undefined, onClick: () => void controller.confirmDecision() }, verdict === 'approve' ? 'Approve with passkey' : 'Reject with passkey'),
    ),
  );
}

function result(state: State, controller: Controller, verdict: Verdict, commitment: string): VElement {
  const status = state.status;
  const label = status !== null ? DECISION_LABELS[status.decision] : null;
  const pending = status === null || ['unsettled', 'unknown', 'challenge_open'].includes(status.decision) || state.outcomeUnknown;
  return h(
    'section',
    { class: 'screen result', 'aria-labelledby': 'screen-title' },
    heading('Decision status'),
    h(
      'div',
      { class: 'status-card', 'data-tone': label?.tone ?? 'info', role: 'status', 'aria-live': 'polite' },
      h('p', { class: 'status-label' }, label !== null ? label.label : 'Checking the outcome…'),
      label !== null ? h('p', {}, label.detail) : h('p', { class: 'muted' }, 'Reading the authoritative status from Frontera Authority.'),
      status?.code !== null && status?.code !== undefined ? h('small', { class: 'muted code' }, `Reason: ${status.code}`) : null,
    ),
    h(
      'dl',
      { class: 'fields compact' },
      row('Your verdict', VERDICT_LABELS[verdict]),
      row('Request status', status?.request !== null && status?.request !== undefined ? `${REQUEST_STATUS_LABELS[status.request.status] ?? status.request.status}${status.request.superseded ? ' (superseded)' : ''}` : 'Not available'),
      row('Execution', 'Not observed by Frontera Authority. An approval is not proof that the action ran.'),
      row('Decision reference', h('span', { class: 'mono wrap digest' }, grouped(commitment))),
    ),
    h(
      'div',
      { class: 'buttons' },
      pending ? h('button', { type: 'button', class: 'secondary', disabled: state.busy, onClick: () => void controller.checkStatus() }, state.busy ? 'Checking…' : 'Check status') : null,
      h('button', { type: 'button', class: 'primary', disabled: state.busy, onClick: () => void controller.backToInbox() }, 'Back to approvals'),
    ),
  );
}

function header(state: State, controller: Controller): VElement {
  return h(
    'header',
    { class: 'topbar' },
    h('p', { class: 'brand', 'aria-label': 'Frontera Authority' }, BRAND),
    state.session !== null
      ? h('div', { class: 'identity' }, h('span', { class: 'who', 'aria-label': `Signed in as ${state.session.displayName}` }, state.session.displayName), h('button', { type: 'button', class: 'link', disabled: state.busy, onClick: () => void controller.signOut() }, 'Sign out'))
      : null,
  );
}

/** The whole application for one state. `nowMs` is injected so expiry text is deterministic. */
export function render(state: State, controller: Controller, nowMs: number): VElement {
  const { screen } = state;
  const body =
    screen.name === 'starting'
      ? h('section', { class: 'screen', 'aria-labelledby': 'screen-title' }, heading('Frontera Authority'), h('p', { role: 'status', class: 'muted' }, 'Connecting securely…'))
      : screen.name === 'welcome'
        ? welcome(state, controller)
        : screen.name === 'enrol'
          ? enrol(state, controller)
          : screen.name === 'enrolled'
            ? enrolled(state, controller)
            : screen.name === 'inbox'
              ? inbox(state, controller, nowMs)
              : screen.name === 'request'
                ? request(state, controller, nowMs)
                : screen.name === 'confirm'
                  ? confirm(state, controller, screen.verdict)
                  : result(state, controller, screen.verdict, screen.commitment);
  return h(
    'div',
    { class: 'app', 'data-state': screen.name },
    header(state, controller),
    h('main', { id: 'main', 'aria-busy': state.busy ? 'true' : 'false' }, noticeRegion(state, controller), body),
    h('footer', { class: 'footer' }, h('small', { class: 'muted' }, 'Decisions are confirmed with your passkey and recorded by Frontera Authority.')),
  );
}
