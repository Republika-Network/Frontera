/**
 * ANDREW-DEMO-UI-01 — the browser side of the visual demo.
 *
 * Presentation only. This file renders the backend's state and posts operator
 * actions; it decides nothing. It never predicts a result, never advances a
 * step on a timer, and holds no state the backend does not hold: every render
 * is a pure function of the last `/api/status` answer, so a refresh shows
 * exactly what the backend knows. Buttons are enabled from the backend's own
 * `allowed` table — which the backend enforces again on every action.
 *
 * The one clock on the page is the EXECUTE countdown: a display of the time
 * left before the backend's own release deadline. It changes no state.
 *
 * The screen tells the Andrew/LUMX story in plain language (request, policy,
 * authority, approval, authorization, execution, outcome, receipt). Internal
 * identifiers, reason codes and verification details stay available behind
 * "Details" for technical credibility.
 */

type Json = Record<string, unknown>;

interface Counters {
  grants: number;
  connections: number;
  signatures: number;
  submissions: number;
  attempts: number;
}
interface Decision {
  decisionId: string;
  status: string;
  reasonCodes: string[];
}
interface Lifecycle {
  state: string;
  at: string;
  detail?: string;
}
interface State {
  mode: 'rehearsal' | 'live';
  modeLabel: string;
  network: { name: string; description: string };
  story: {
    businessAmountUsd: string;
    governedAmountUsd?: string;
    settlementAmount?: string;
    settlementAsset: string;
    settlementNetwork: string;
    scaled: boolean;
    ceilingUsd: string;
    secondTestUsd: string;
  };
  preflight: {
    status: 'not-run' | 'READY' | 'NOT READY';
    checkedAt?: string;
    reasons: string[];
    networkName: string;
    connectedNetworkId?: number;
    expectedNetworkId: number;
    validatedLedger?: number;
    treasury?: string;
    recipient?: string;
    issuer: string;
    treasuryTrustLine?: boolean;
    recipientTrustLine?: boolean;
    treasuryTestRlusd?: string;
    requiredAmount?: string;
    attemptState: string;
    secrets: string;
  };
  review: { required: boolean; reasons: string[] };
  session?: { runId: string; startedAt: string; status: string };
  runAccounts?: { treasury: string; recipient: string };
  busy?: { action: string; since: string };
  scenarioA: {
    phase: string;
    agent: { label: string; principal: string };
    amountUsd?: string;
    destinationKey?: string;
    recipient?: string;
    request?: { requestId: string; decision: Decision; initialApprovalState: string; identityActor: string; authorityPresence: string; traceVerified: boolean; counters: Counters };
    replay?: { requestId: string; decisionId: string; sameDecision: boolean; counters: Counters };
    approval?: { state: string; approvedBy: string; role: string; authorityBasis: string; approvedAt: string; counters: Counters };
    authorization?: {
      originalRequestId: string;
      reconsiderationRequestId: string;
      decisionId: string;
      decisionStatus?: string;
      reasonCodes?: string[];
      businessIntentId?: string;
      reason?: string;
      identityActor?: string;
      grantId: string;
      grantCeiling?: { limit: string; unit: string };
      executionId: string;
      grantNotAfter: string;
      releaseDeadline: string;
      heldAt: string;
      payment: { destination: string; value?: string; currencyLabel: string };
      counters: Counters;
    };
    lifecycle: Lifecycle[];
    execution?: { transactionHash: string; ledgerIndex?: number; engineResult?: string; deliveredValue?: string; deliveredAsset: string; sourceAccount?: string; destinationAccount?: string; attemptState: string; counters: Counters; scripted: boolean };
    evidence?: { finalState: string; verified: boolean; checks: number; results: { check: string; status: string }[] };
    second?: { requestId: string; status: string; reasonCodes: string[]; newGrants: number; newSignatures: number; newSubmissions: number };
    historical?: { status: string; decisionId: string; unchanged: boolean; traceVerified: boolean };
  };
  scenarioB: {
    status: string;
    requestedUsd: string;
    ceilingUsd: string;
    destinationApproved: boolean;
    result?: {
      requestId: string;
      decisionId: string;
      decisionStatus: string;
      reasonCode: string;
      withheldBy: string;
      issuanceOutcome: string;
      requested?: { value: string; unit: string };
      ceiling?: { value: string; unit: string };
      issuanceRecordId?: string;
      grants: number;
      connections: number;
      signatures: number;
      submissions: number;
      attemptRows: number;
      transaction: string | null;
      assureFinalState: string;
      assureVerified: boolean;
    };
  };
  verdict: { status: string; failure?: { category: string; message: string; step?: string }; summaryAvailable: boolean; reportAvailable: boolean; finishedAt?: string };
  checkpoints: { step: string; result: string; detail?: string }[];
  transcript: string[];
  allowed: Record<string, boolean>;
  notice?: string;
}

// ── Small, escaping-first rendering helpers ───────────────────────────────

const esc = (value: unknown): string =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const grouped = (value: string | undefined): string => {
  if (value === undefined) return '—';
  const [integer = '', fraction] = value.split('.');
  const withCommas = integer.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return fraction === undefined ? withCommas : `${withCommas}.${fraction}`;
};
/** `$75,000` — a governed USD value, display only. */
const usd = (value: string | undefined): string => (value === undefined ? '—' : `$${grouped(value)}`);

/** `rhScS…c424z`, full value on hover. Display only. */
const short = (value: string | undefined, head = 5, tail = 5): string => {
  if (value === undefined || value === '') return '<span class="muted">—</span>';
  if (value.length <= head + tail + 1) return `<span class="mono">${esc(value)}</span>`;
  return `<span class="mono" title="${esc(value)}">${esc(value.slice(0, head))}…${esc(value.slice(-tail))}</span>`;
};
const id = (value: string | undefined): string => (value === undefined || value === '' ? '<span class="muted">—</span>' : `<span class="mono id">${esc(value)}</span>`);
const time = (iso: string | undefined): string => {
  if (iso === undefined || iso === '') return '—';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? esc(iso) : esc(date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }));
};

type Tone = 'ok' | 'bad' | 'warn' | 'info' | 'idle' | 'live';
const pill = (label: string, tone: Tone): string => `<span class="pill pill-${tone}">${esc(label)}</span>`;
const row = (label: string, value: string): string => `<div class="row"><dt>${esc(label)}</dt><dd>${value}</dd></div>`;
const rowWide = (label: string, value: string): string => `<div class="row row-wide"><dt>${esc(label)}</dt><dd>${value}</dd></div>`;
const rows = (items: string[], extra = ''): string => `<dl class="rows ${extra}">${items.join('')}</dl>`;
const check = (mark: 'yes' | 'no' | 'skip', label: string, value: string): string =>
  `<li class="check check-${mark}"><span class="mark" aria-hidden="true">${mark === 'yes' ? '✓' : mark === 'no' ? '✕' : '–'}</span><span class="check-label">${esc(label)}</span><span class="check-value">${value}</span></li>`;
const checks = (items: string[]): string => `<ul class="checks">${items.join('')}</ul>`;

/** Plain-language names for the reason codes Frontera returns. The raw code always stays visible under Details. */
const REASONS: Record<string, string> = {
  DOMAIN_POLICY_DENIED: 'Payment policy denied the request',
  POLICY_ACTION_PROHIBITED: 'Paying a destination that is not approved is not permitted',
  GOVERNED_ACTION_RECONSIDERATION_ALREADY_REALIZED: 'This request has already been carried out once',
  FINANCIAL_AUTHORITY_CEILING_EXCEEDED: "The amount exceeds the agent's authority ceiling",
};
const reasonList = (codes: readonly string[] | undefined): string =>
  (codes ?? []).length === 0 ? '<span class="muted">—</span>' : `<ul class="plain">${(codes ?? []).map((code) => `<li>${esc(REASONS[code] ?? code)} <code>${esc(code)}</code></li>`).join('')}</ul>`;

/** `1 grant`, `0 signatures`. */
const count = (n: number, noun: string, bold = true): string => `${bold ? `<b>${esc(n)}</b>` : esc(n)} ${esc(noun)}${n === 1 ? '' : 's'}`;
const actor = (value: string | undefined): string => (value ?? '').replace(/^(operator|principal|agent):/, '');
const role = (value: string | undefined): string => {
  const text = (value ?? '').replace(/-/g, ' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
};

/** "No grant issued · No signature created · No transaction submitted", from measured counters. */
function proofLine(c: { grants: number; signatures: number; submissions: number } | undefined, labels: [string, string, string] = ['No grant issued', 'No signature created', 'No transaction submitted']): string {
  if (c === undefined) return '';
  const item = (count: number, text: string, noun: string) => (count === 0 ? `<li class="proof-zero"><span aria-hidden="true">⦸</span>${esc(text)}</li>` : `<li class="proof-bad">${esc(count)} ${esc(noun)}</li>`);
  return `<ul class="proof">${item(c.grants, labels[0], 'grants')}${item(c.signatures, labels[1], 'signatures')}${item(c.submissions, labels[2], 'submissions')}</ul>`;
}

// ── App state (presentation only) ─────────────────────────────────────────

let state: State | undefined;
let tab: 'demo' | 'evidence' = location.hash === '#evidence' ? 'evidence' : 'demo';
let pending: string | undefined;
let lastError: string | undefined;
const openDetails = new Set<string>();
let pollTimer: number | undefined;

const ACTION_PATHS: Record<string, string> = {
  preflight: '/api/preflight',
  session: '/api/session',
  request: '/api/scenario-a/request',
  replay: '/api/scenario-a/replay',
  approve: '/api/scenario-a/approve',
  reconsider: '/api/scenario-a/reconsider',
  execute: '/api/scenario-a/execute',
  abandon: '/api/scenario-a/abandon',
  verifyEvidence: '/api/scenario-a/verify-evidence',
  reconsiderAgain: '/api/scenario-a/reconsider-again',
  historical: '/api/scenario-a/historical',
  scenarioB: '/api/scenario-b/run',
};

async function load(): Promise<void> {
  try {
    const response = await fetch('/api/status', { cache: 'no-store' });
    state = (await response.json()) as State;
    lastError = undefined;
  } catch {
    lastError = 'The local demo backend is not reachable.';
  }
  render();
  schedulePoll();
}

/** One operator action. Returns whether the backend accepted it. */
async function act(action: string): Promise<boolean> {
  const path = ACTION_PATHS[action];
  if (path === undefined) return false;
  pending = action;
  lastError = undefined;
  render();
  let ok = false;
  try {
    const response = await fetch(path, { method: 'POST', headers: { 'x-frontera-demo': '1' }, cache: 'no-store' });
    const body = (await response.json()) as Json;
    if (response.ok) {
      state = body as unknown as State;
      ok = true;
    } else {
      if (body['state'] !== undefined) state = body['state'] as State;
      lastError = String(body['message'] ?? body['error'] ?? `HTTP ${response.status}`);
    }
  } catch {
    lastError = 'The local demo backend did not answer.';
  } finally {
    pending = undefined;
  }
  render();
  schedulePoll();
  return ok;
}

/**
 * A button may stand for a short sequence of backend steps (for example, the
 * replay proof that the backend requires before an approval). Each step is
 * still a separate, backend-checked action; a step the backend does not allow
 * right now is skipped, and the sequence stops at the first refusal.
 */
async function actSequence(actions: readonly string[]): Promise<void> {
  if (pending !== undefined) return;
  for (const action of actions) {
    if (state?.allowed[action] !== true) continue;
    if (!(await act(action))) return;
    if (state?.scenarioA.phase === 'failed') return;
  }
}

/** Poll only while the backend reports work in progress — the lifecycle advances only when the backend's state does. */
function schedulePoll(): void {
  if (pollTimer !== undefined) window.clearTimeout(pollTimer);
  pollTimer = undefined;
  if (state?.busy !== undefined || state?.scenarioA.phase === 'executing') pollTimer = window.setTimeout(() => void load(), 400);
}

// ── Pieces ────────────────────────────────────────────────────────────────

function button(actions: string | readonly string[], label: string, options: { kind?: 'primary' | 'secondary' | 'quiet' | 'execute'; hint?: string; working?: string } = {}): string {
  const list = typeof actions === 'string' ? [actions] : actions;
  const s = state;
  const allowed = list.some((action) => s?.allowed[action] === true) && pending === undefined;
  const working = list.some((action) => pending === action || s?.busy?.action === action);
  return `<button type="button" class="btn btn-${options.kind ?? 'primary'}" data-actions="${esc(list.join(' '))}" ${allowed ? '' : 'disabled'}>${working ? esc(options.working ?? 'Working…') : esc(label)}</button>${options.hint !== undefined ? `<span class="btn-hint">${esc(options.hint)}</span>` : ''}`;
}

function details(key: string, summary: string, body: string, extra = ''): string {
  return `<details class="details ${extra}" data-key="${esc(key)}" ${openDetails.has(key) ? 'open' : ''}><summary>${esc(summary)}</summary><div class="details-body">${body}</div></details>`;
}

/** The amount this run governs, worded truthfully: the business amount, or a scaled Testnet amount. */
function runAmount(s: State): string {
  const st = s.story;
  if (!st.scaled) return usd(st.governedAmountUsd ?? st.businessAmountUsd);
  return `${usd(st.governedAmountUsd)} <span class="muted">(scaled Testnet run of the ${esc(usd(st.businessAmountUsd))} scenario)</span>`;
}
function settlement(s: State, value?: string): string {
  const st = s.story;
  const amount = value ?? st.settlementAmount;
  return amount === undefined ? '<span class="muted">confirmed by the readiness check</span>' : `${esc(grouped(amount))} ${esc(st.settlementAsset)}`;
}

function header(s: State): string {
  const live = s.mode === 'live';
  return `
  <header class="top">
    <div class="brand">
      <div class="wordmark"><span class="mark-glyph" aria-hidden="true"></span>Frontera</div>
      <div class="tagline">Control what your systems are allowed to do</div>
    </div>
    <div class="top-right">
      <span class="for">Andrew Matthews · LUMX</span>
      <div class="mode ${live ? 'mode-live' : 'mode-rehearsal'}">${esc(live ? 'Live · XRPL Testnet' : 'Rehearsal · no XRPL transaction')}</div>
    </div>
  </header>
  <div class="mode-strip ${live ? 'strip-live' : 'strip-rehearsal'}">${
    live
      ? '<strong>Live on XRPL Testnet.</strong> A real Testnet transaction happens only when you press Execute. Test RLUSD has no real-world value. Mainnet is refused.'
      : '<strong>Rehearsal.</strong> Real Frontera governance on a scripted, in-process ledger. Nothing reaches XRPL, and the transaction shown exists on no network.'
  }</div>`;
}

function hero(s: State): string {
  const st = s.story;
  const a = s.scenarioA;
  const wallet = a.recipient;
  const approved = a.approval?.state === 'approved';
  const live = s.mode === 'live';
  const scaleNote = st.scaled
    ? `<div class="scale-note"><strong>Live Testnet run, scaled.</strong> Frontera governs and settles <strong>${esc(usd(st.governedAmountUsd))}</strong> as <strong>${esc(grouped(st.settlementAmount))} ${esc(st.settlementAsset)}</strong> in this run. ${esc(usd(st.businessAmountUsd))} of RLUSD is not sent.</div>`
    : '';
  return `
  <section class="hero" aria-label="The agent's request">
    <div class="hero-main">
      <div class="eyebrow">Agent request</div>
      <h1>Send <span class="amount">${esc(usd(st.businessAmountUsd))}</span></h1>
      <div class="hero-sub">To a new wallet ${wallet !== undefined ? `<span class="wallet">${short(wallet, 6, 6)}</span>` : ''}</div>
      <p class="hero-copy">The agent is asking Frontera to send ${esc(usd(st.businessAmountUsd))} to a destination that has never been approved.</p>
      ${scaleNote}
    </div>
    <dl class="hero-facts">
      ${row('Requested by', `<strong>${esc(a.agent.label)}</strong>`)}
      ${row('Destination', approved ? pill('Approved', 'ok') : pill('Never approved', 'bad'))}
      ${row("Agent's authority ceiling", `${esc(usd(st.ceilingUsd))} per payment`)}
      ${st.scaled ? row('Business amount', esc(usd(st.businessAmountUsd))) : ''}
      ${row(st.scaled ? 'Testnet settlement' : 'Settles as', `${settlement(s)}${live ? '' : ' <span class="muted">on a scripted ledger</span>'}`)}
    </dl>
  </section>`;
}

// ── The main story ────────────────────────────────────────────────────────

const STEPS = ['Request', 'Blocked', 'Approve destination', 'Reconsider', 'Authorized', 'Execute', 'Confirmed', 'Receipt'] as const;

/** Which story steps are complete, from the backend's records. */
function completed(s: State): boolean[] {
  const a = s.scenarioA;
  const released = a.lifecycle.some((entry) => entry.state === 'RELEASED');
  return [a.request !== undefined, a.request !== undefined, a.approval !== undefined, a.authorization !== undefined, a.authorization !== undefined, released, a.execution !== undefined, a.evidence !== undefined];
}

/** The step the presenter is on (0-based), derived from the backend's phase. */
function currentStep(s: State): number {
  const phase = s.scenarioA.phase;
  switch (phase) {
    case 'not-started':
      return 0;
    case 'denied':
    case 'replayed':
      return 2;
    case 'approved':
    case 'reconsidering':
      return 3;
    case 'authorized':
      return 5;
    case 'executing':
      return 6;
    case 'confirmed':
    case 'evidence-verified':
    case 'refused-second':
    case 'complete':
      return 7;
    default: {
      const done = completed(s);
      const next = done.findIndex((value) => !value);
      return next === -1 ? 7 : next;
    }
  }
}

function stepper(s: State): string {
  const done = completed(s);
  const current = s.session !== undefined ? currentStep(s) : -1;
  const failed = s.scenarioA.phase === 'failed';
  return `<ol class="stepper" aria-label="Story progress">${STEPS.map((name, index) => {
    const isDone = done[index] === true;
    const isCurrent = index === current && !isDone;
    const cls = [isDone ? 'st-done' : '', isCurrent && !isDone ? 'st-current' : '', !isDone && !isCurrent ? 'st-future' : '', index === 1 && isDone ? 'st-block' : '', failed && isCurrent && !isDone ? 'st-failed' : ''].join(' ');
    const mark = isDone ? (index === 1 ? '✕' : '✓') : String(index + 1);
    return `<li class="st ${cls}" ${isCurrent ? 'aria-current="step"' : ''}><span class="st-dot">${esc(mark)}</span><span class="st-name">${esc(name)}</span></li>`;
  }).join('')}</ol>`;
}

function meter(s: State): string {
  const a = s.scenarioA;
  const latest = a.execution?.counters ?? a.authorization?.counters ?? a.approval?.counters ?? a.replay?.counters ?? a.request?.counters;
  if (s.session === undefined) return '';
  return `<div class="meter" aria-label="Measured at the payment boundary">
    <span class="meter-label">Measured at the payment boundary</span>
    <span>${count(latest?.grants ?? 0, 'grant')}</span>
    <span>${count(latest?.signatures ?? 0, 'signature')}</span>
    <span>${count(latest?.submissions ?? 0, 'submission')}</span>
  </div>`;
}

interface StepView {
  title: string;
  summary: string;
  body: string;
  tone?: 'block' | 'ok' | 'execute' | 'neutral' | undefined;
}

function stepView(s: State, index: number): StepView {
  const a = s.scenarioA;
  const st = s.story;
  const live = s.mode === 'live';
  const phase = a.phase;
  const wallet = short(a.recipient, 6, 6);
  const r = a.request;
  const ap = a.approval;
  const au = a.authorization;
  const ex = a.execution;
  const ev = a.evidence;
  switch (index) {
    case 0:
      return {
        title: 'The agent sends its request',
        summary: `Agent requested ${esc(usd(st.governedAmountUsd ?? st.businessAmountUsd))} to ${wallet}`,
        body:
          r === undefined
            ? `<p class="lead">Before anything can move, Frontera checks who is asking, what they want to do, how much, and where the money would go.</p>
               ${rows([row('Agent', `<strong>${esc(a.agent.label)}</strong>`), row('Action', 'Send funds from the treasury'), row('Amount', runAmount(s)), row('Destination', `${wallet} ${pill('Never approved', 'bad')}`)])}
               <div class="actions">${button('request', 'Send the request to Frontera', { working: 'Frontera is evaluating…', hint: 'The result is decided by Frontera, not predicted here.' })}</div>`
            : `<p class="lead">The agent asked Frontera to send ${runAmount(s)} to ${wallet}.</p>`,
      };
    case 1:
      return {
        title: "Frontera's decision",
        tone: 'block',
        summary: 'Blocked — destination not approved. Nothing was granted, signed or sent.',
        body:
          r === undefined
            ? ''
            : `<div class="moment moment-block"><div class="moment-kicker">Execution blocked</div><div class="moment-title">Destination not approved</div></div>
               ${checks([
                 check('yes', 'Agent recognized', 'Identity verified'),
                 check('no', 'Destination', 'Never approved — payment policy does not allow it'),
                 check('skip', 'Amount', `${esc(usd(a.amountUsd ?? st.governedAmountUsd))} is under the ${esc(usd(st.ceilingUsd))} ceiling — not reached, the destination check stopped it first`),
               ])}
               ${proofLine(r.counters)}
               ${details('blocked', 'Details', rows([row('Reason codes', reasonList(r.decision.reasonCodes)), row('Decision', `${esc(r.decision.status)} · ${id(r.decision.decisionId)}`), row('Request', id(r.requestId)), row('Identity', id(r.identityActor)), row('Authority stage', esc(r.authorityPresence)), row('Initial destination state', esc(r.initialApprovalState)), row('Evidence trace (ASSURE-01)', r.traceVerified ? 'Verified' : 'Not verified')], 'rows-1'))}`,
      };
    case 2: {
      const basis = ap !== undefined && /destination\.approve/.test(ap.authorityBasis) ? 'Permission to approve payment destinations' : ap?.authorityBasis;
      return {
        title: 'Approve the destination',
        tone: ap !== undefined ? 'ok' : undefined,
        summary: ap !== undefined ? `Destination approved by ${esc(actor(ap.approvedBy))} at ${time(ap.approvedAt)} — no payment occurred` : 'Destination approval',
        body:
          ap === undefined
            ? `<p class="lead">An administrator reviews the wallet and approves it as a payment destination. Approving a wallet does not send any money.</p>
               ${rows([row('Wallet', wallet), row('Status', pill('Not approved', 'bad'))])}
               <div class="actions">${button(['replay', 'approve'], 'Approve destination', { working: 'Recording the approval…', hint: 'Frontera first confirms that resending the blocked request returns the same decision (an integrity proof), then records the approval.' })}</div>`
            : `<p class="lead">A governance action, recorded by Frontera.</p>
               ${rows([
                 row('Wallet', wallet),
                 row('Status', `${pill('Not approved', 'idle')} <span class="arrow">→</span> ${pill('Approved', 'ok')}`),
                 row('Approved by', `<strong>${esc(actor(ap.approvedBy))}</strong> <span class="muted">${esc(role(ap.role))}</span>`),
                 row('Authority basis', esc(basis)),
                 row('Recorded', time(ap.approvedAt)),
               ])}
               <div class="moment moment-neutral"><div class="moment-title">No payment occurred</div><div class="moment-copy">Approval alone executes nothing. The original request waits for an explicit reconsideration.</div></div>
               ${proofLine(ap.counters)}
               ${details('approval', 'Details', rows([row('Approver', id(ap.approvedBy)), row('Role', esc(ap.role)), row('Authority basis', `<code>${esc(ap.authorityBasis)}</code>`), row('Recorded at', esc(ap.approvedAt))], 'rows-1'))}`,
      };
    }
    case 3:
      return {
        title: 'Reconsider the original request',
        summary: 'The same request was evaluated again after approval',
        body: `<p class="lead">The same payment request is evaluated again after the destination becomes approved. Frontera evaluates it from scratch; the earlier block stays on the record.</p>
          ${
            au === undefined
              ? phase === 'reconsidering'
                ? '<div class="working-line"><span class="spinner" aria-hidden="true"></span>Frontera is evaluating the request again…</div>'
                : `<div class="actions">${button('reconsider', 'Reconsider the request', { working: 'Frontera is evaluating…' })}</div>`
              : `${checks([check('yes', 'Same business request', 'Linked to the original blocked request'), check('yes', 'Reason', 'Destination approved')])}
                 ${details('reconsider', 'Details', rows([row('Original request', id(au.originalRequestId)), row('Reconsideration request', id(au.reconsiderationRequestId)), row('Business intent', au.businessIntentId !== undefined ? id(au.businessIntentId) : '<span class="muted">shown after execution</span>'), row('Reason', `<code>${esc(au.reason ?? 'destination-approved')}</code>`)], 'rows-1'))}`
          }`,
      };
    case 4:
      return {
        title: 'Fresh evaluation',
        tone: 'ok',
        summary: `Authorized — grant issued within the ${esc(usd(au?.grantCeiling?.limit ?? st.ceilingUsd))} ceiling`,
        body:
          au === undefined
            ? ''
            : `<div class="moment moment-ok"><div class="moment-kicker">Authorization</div><div class="moment-title">Payment authorized</div><div class="moment-copy">Frontera issued a grant for this one payment.</div></div>
               ${checks([
                 check('yes', 'Governed amount', runAmount(s)),
                 check('yes', 'Destination', 'Approved'),
                 check('yes', 'Authority ceiling', `${esc(usd(au.grantCeiling?.limit ?? st.ceilingUsd))} per payment — within`),
                 check('yes', 'Grant', `Issued · bound to this request · valid until ${time(au.grantNotAfter)}`),
               ])}
               ${details('grant', 'Details', rows([row('Grant', id(au.grantId)), row('Decision', id(au.decisionId)), row('Decision reasons', reasonList(au.reasonCodes)), row('Execution', id(au.executionId)), row('Identity', id(au.identityActor)), row('Grant valid until', esc(au.grantNotAfter))], 'rows-1'))}`,
      };
    case 5: {
      const notSubmitted = a.lifecycle.find((entry) => entry.state === 'NOT SUBMITTED');
      const released = a.lifecycle.find((entry) => entry.state === 'RELEASED');
      const network = live ? 'XRPL Testnet' : 'Scripted rehearsal ledger (no network)';
      return {
        title: 'Execute',
        tone: 'execute',
        summary: released !== undefined ? `Released by the operator at ${time(released.at)}` : notSubmitted !== undefined ? 'Stopped by the operator — nothing was signed or sent' : 'Waiting for the operator',
        body:
          au === undefined
            ? ''
            : phase === 'authorized'
              ? `<div class="execute-panel">
                  <div class="execute-head"><div class="eyebrow">Explicit release</div><h3>Ready to execute</h3>
                  <p>Frontera has authorized the action. <strong>No payment has been signed or submitted yet.</strong></p></div>
                  <dl class="execute-facts">
                    ${row('Authorized amount', `<strong>${settlement(s, au.payment.value)}</strong>${st.scaled ? `<span class="sub">scaled from the ${esc(usd(st.businessAmountUsd))} scenario</span>` : ''}`)}
                    ${row('Destination', short(au.payment.destination, 6, 6))}
                    ${row('Network', esc(network))}
                    ${row('Time remaining', `<span class="countdown" data-deadline="${esc(au.releaseDeadline)}">—</span><span class="sub">authorization window closes at ${time(au.releaseDeadline)}</span>`)}
                  </dl>
                  <div class="execute-actions">${button('execute', live ? 'Execute on XRPL Testnet' : 'Execute payment', { kind: 'execute', working: 'Releasing…' })}${button('abandon', "Stop — don't execute", { kind: 'quiet' })}</div>
                  <p class="execute-foot">${live ? 'Execute signs and submits one real XRPL Testnet transaction.' : 'Execute signs with an in-memory rehearsal key and submits to the scripted ledger only.'} Right now: ${count(au.counters.grants, 'grant', false)} · ${count(au.counters.signatures, 'signature', false)} · ${count(au.counters.submissions, 'submission', false)}.</p>
                </div>`
              : notSubmitted !== undefined
                ? `<div class="moment moment-neutral"><div class="moment-title">Not executed</div><div class="moment-copy">${esc(notSubmitted.detail ?? '')}</div></div>`
                : `<p class="lead">The operator released the authorized payment at ${time(released?.at)}. Nothing was signed before that moment.</p>`,
      };
    }
    case 6: {
      const stages: [string, string[]][] = [
        ['Authorized', ['AUTHORIZED']],
        ['Released', ['RELEASED']],
        ['Signed', ['SIGNING']],
        ['Submitted', ['SUBMITTING', 'VALIDATING']],
        ['Validated', ['VALIDATED']],
        ['Confirmed', ['CONFIRMED']],
      ];
      const found = (names: string[]) => a.lifecycle.find((entry) => names.includes(entry.state));
      const reached = stages.map(([, names]) => found(names) !== undefined);
      const lastReached = reached.lastIndexOf(true);
      const executing = phase === 'executing';
      const problems = a.lifecycle.filter((entry) => ['REFUSED', 'REVIEW REQUIRED'].includes(entry.state));
      const lifecycle = `<ol class="lifecycle">${stages
        .map(([name, names], i) => {
          const entry = found(names);
          const active = executing && i === lastReached + 1;
          return `<li class="${entry !== undefined ? 'lc-done' : ''} ${active ? 'lc-active' : ''}"><span class="lc-dot" aria-hidden="true"></span><span class="lc-name">${esc(name)}</span><span class="lc-time">${entry !== undefined ? time(entry.at) : active ? 'in progress' : ''}</span></li>`;
        })
        .join('')}</ol>`;
      return {
        title: live ? 'Confirmed on XRPL Testnet' : 'Confirmed on the rehearsal ledger',
        tone: ex !== undefined ? 'ok' : undefined,
        summary: ex !== undefined ? `Confirmed — ${esc(grouped(ex.deliveredValue))} ${esc(ex.deliveredAsset)} delivered${ex.ledgerIndex !== undefined ? ` in ledger ${esc(ex.ledgerIndex)}` : ''}` : 'Execution',
        body: `${lifecycle}
          ${problems.map((entry) => `<div class="moment moment-block"><div class="moment-title">${esc(entry.state === 'REFUSED' ? 'Refused by the ledger transport' : 'Execution state requires review')}</div><div class="moment-copy">${esc(entry.detail ?? '')}</div></div>`).join('')}
          ${
            ex !== undefined
              ? `<div class="moment moment-ok"><div class="moment-kicker">Outcome</div><div class="moment-title">Payment confirmed</div><div class="moment-copy">${ex.scripted ? 'Rehearsal: validated by the scripted ledger. This transaction exists on no network.' : 'Validated on XRPL Testnet, and re-read independently from the ledger.'}</div></div>
                 ${rows([
                   rowWide('Transaction', `<span class="mono hash">${esc(ex.transactionHash)}</span><button type="button" class="copy" data-copy="${esc(ex.transactionHash)}">Copy</button>`),
                   row('Ledger', `${esc(ex.ledgerIndex ?? '—')}`),
                   row('Amount delivered', `<strong>${esc(grouped(ex.deliveredValue))} ${esc(ex.deliveredAsset)}</strong>${st.scaled ? ` <span class="muted">(scaled from ${esc(usd(st.businessAmountUsd))})</span>` : ''}`),
                   row('Network', esc(live ? 'XRPL Testnet' : 'Scripted rehearsal ledger')),
                   row('From', `Treasury ${short(ex.sourceAccount, 6, 6)}`),
                   row('To', `${short(ex.destinationAccount, 6, 6)}`),
                 ])}
                 ${details('execution', 'Details', rows([row('Engine result', `<code>${esc(ex.engineResult ?? '—')}</code>`), row('Attempt state', `<code>${esc(ex.attemptState)}</code>`), row('Signatures / submissions', `${esc(ex.counters.signatures)} / ${esc(ex.counters.submissions)}`), row('Execution', id(au?.executionId)), ...a.lifecycle.map((entry) => row(entry.state, `${time(entry.at)} <span class="muted">${esc(entry.detail ?? '')}</span>`))], 'rows-1'))}`
              : executing
                ? '<div class="working-line"><span class="spinner" aria-hidden="true"></span>Waiting for the ledger to validate…</div>'
                : ''
          }`,
      };
    }
    default:
      return {
        title: ev !== undefined ? 'Receipt' : 'Governance receipt',
        tone: ev !== undefined ? 'ok' : undefined,
        summary: ev !== undefined ? 'Receipt issued — evidence verified' : 'Receipt',
        body: ev === undefined ? `<p class="lead">Frontera verifies the evidence trail from the agent's request to the confirmed outcome, then issues the receipt.</p><div class="actions">${button('verifyEvidence', 'Verify evidence and issue the receipt', { working: 'Verifying…' })}</div>` : receipt(s),
      };
  }
}

function receipt(s: State): string {
  const a = s.scenarioA;
  const st = s.story;
  const r = a.request;
  const ap = a.approval;
  const au = a.authorization;
  const ex = a.execution;
  const ev = a.evidence;
  const passed = ev?.results.filter((c) => c.status === 'pass').length ?? 0;
  const failed = ev?.results.filter((c) => c.status === 'fail').length ?? 0;
  const other = (ev?.results.length ?? 0) - passed - failed;
  const line = (label: string, value: string, mark: 'ok' | 'block' | 'plain' = 'ok') => `<div class="rc-line rc-${mark}"><dt>${esc(label)}</dt><dd>${value}</dd></div>`;
  const reportLinks = s.verdict.reportAvailable
    ? `<a class="link" href="/api/report" target="_blank" rel="noopener">View report</a> · <a class="link" href="/api/report?download=1">Download</a>`
    : '<span class="muted">full report is written when the run completes</span>';
  return `<div class="receipt">
    <div class="rc-head"><div><div class="eyebrow">Frontera</div><h3>Governance receipt</h3></div>${pill(ev?.verified === true ? 'Verified' : 'Not verified', ev?.verified === true ? 'ok' : 'bad')}</div>
    <dl class="rc-lines">
      ${line('Request', `<strong>${st.scaled ? `${esc(usd(st.businessAmountUsd))} scenario · governed at ${esc(usd(st.governedAmountUsd))}` : esc(usd(a.amountUsd ?? st.governedAmountUsd))}</strong> to ${short(a.recipient, 6, 6)} <span class="muted">by ${esc(a.agent.label)}</span>`, 'plain')}
      ${line('Decision', 'Initially blocked — destination not approved', 'block')}
      ${line('Governance action', `Destination approved by <strong>${esc(actor(ap?.approvedBy))}</strong> at ${time(ap?.approvedAt)}`)}
      ${line('Reconsideration', 'Same business request re-evaluated')}
      ${line('Authorization', `Grant issued · within the ${esc(usd(au?.grantCeiling?.limit ?? st.ceilingUsd))} authority ceiling`)}
      ${line('Execution', `Released by the operator · signed · submitted · validated${ex?.ledgerIndex !== undefined ? ` in ledger ${esc(ex.ledgerIndex)}` : ''}`)}
      ${line('Outcome', `Confirmed — ${esc(grouped(ex?.deliveredValue))} ${esc(ex?.deliveredAsset ?? '')} delivered${ex?.scripted === true ? ' <span class="muted">(rehearsal ledger)</span>' : ''}`)}
      ${line('Evidence', `Trace verified — ${esc(passed)} checks passed${failed > 0 ? `, ${esc(failed)} failed` : ''}${other > 0 ? `, ${esc(other)} not applicable` : ''} · ${reportLinks}`)}
    </dl>
    ${details(
      'receipt-ids',
      'Details',
      `${rows(
        [
          row('Original request', id(r?.requestId)),
          row('Original decision', id(r?.decision.decisionId)),
          row('Reconsideration request', id(au?.reconsiderationRequestId)),
          row('Business intent', id(au?.businessIntentId)),
          row('Grant', id(au?.grantId)),
          row('Execution', id(au?.executionId)),
          row('Transaction hash', id(ex?.transactionHash)),
          row('Final state (ASSURE-01)', `<code>${esc(ev?.finalState)}</code>`),
        ],
        'rows-1',
      )}
      <ul class="check-list">${(ev?.results ?? []).map((c) => `<li class="${c.status === 'pass' ? 'ok-text' : c.status === 'fail' ? 'bad-text' : 'muted'}"><span>${c.status === 'pass' ? '✓' : c.status === 'fail' ? '✕' : '–'}</span><code>${esc(c.check)}</code>${c.status !== 'pass' ? ` <span class="small">${esc(c.status)}</span>` : ''}</li>`).join('')}</ul>`,
    )}
  </div>`;
}

function storyPanels(s: State): string {
  const done = completed(s);
  const current = currentStep(s);
  const finished = done[7] === true;
  const out: string[] = [];
  for (let i = 0; i <= current; i += 1) {
    const view = stepView(s, i);
    // Expanded: the current step, and the step just completed while the next one waits for the presenter.
    const expanded = i === current || (i === current - 1 && !finished);
    if (view.body === '' && !expanded) continue;
    if (expanded && view.body !== '') {
      out.push(`<article class="panel ${i === current && !(done[i] === true) ? 'panel-current' : ''} ${view.tone !== undefined ? `panel-${view.tone}` : ''}">
        <header class="panel-head"><span class="panel-no">${esc(i + 1)}</span><h2>${esc(view.title)}</h2></header>${view.body}</article>`);
    } else if (done[i] === true || (i === 5 && s.scenarioA.lifecycle.some((e) => e.state === 'NOT SUBMITTED'))) {
      out.push(`<details class="collapsed ${i === 1 ? 'collapsed-block' : ''}" data-key="step-${i}" ${openDetails.has(`step-${i}`) ? 'open' : ''}><summary><span class="panel-no">${i === 1 ? '✕' : '✓'}</span><span class="c-title">${esc(STEPS[i])}</span><span class="c-summary">${view.summary}</span></summary><div class="details-body">${view.body}</div></details>`);
    }
  }
  return out.join('');
}

function integrityProofs(s: State): string {
  const a = s.scenarioA;
  if (a.request === undefined) return '';
  const items = [
    { done: a.replay !== undefined, ok: a.replay?.sameDecision === true, title: 'Retrying the blocked request returns the same decision', detail: a.replay !== undefined ? rows([row('Request', id(a.replay.requestId)), row('Decision', `${id(a.replay.decisionId)} — same as the original`), row('New grants · signatures · submissions', `${a.replay.counters.grants} · ${a.replay.counters.signatures} · ${a.replay.counters.submissions}`)], 'rows-1') : '' },
    { done: a.second !== undefined, ok: a.second !== undefined && a.second.newGrants + a.second.newSignatures + a.second.newSubmissions === 0, title: 'A second attempt to carry out the same request is refused', detail: a.second !== undefined ? rows([row('Reason', reasonList(a.second.reasonCodes)), row('New grants · signatures · submissions', `${a.second.newGrants} · ${a.second.newSignatures} · ${a.second.newSubmissions}`), row('Request', id(a.second.requestId))], 'rows-1') : '' },
    { done: a.historical !== undefined, ok: a.historical?.unchanged === true, title: 'The original blocked decision is never rewritten', detail: a.historical !== undefined ? rows([row('Original request status', esc(a.historical.status)), row('Decision', `${id(a.historical.decisionId)} — ${a.historical.unchanged ? 'unchanged' : 'CHANGED'}`), row('Original trace', a.historical.traceVerified ? 'Verified' : '—')], 'rows-1') : '' },
  ];
  const count = items.filter((item) => item.done && item.ok).length;
  const body = `<p class="muted">Supporting checks that the outcome cannot be replayed, duplicated or rewritten.</p><ul class="proofs-list">${items
    .map((item, index) => `<li class="${item.done ? (item.ok ? 'ok' : 'bad') : 'todo'}"><span class="mark" aria-hidden="true">${item.done ? (item.ok ? '✓' : '✕') : '○'}</span><div><div>${esc(item.title)}</div>${item.detail !== '' ? details(`proof-${index}`, 'Details', item.detail) : '<div class="muted small">Not run yet</div>'}</div></li>`)
    .join('')}</ul>`;
  return details('proofs', `Integrity proofs · ${count} of 3 passed`, body, 'proofs');
}

function nextUp(s: State): string {
  const a = s.scenarioA;
  const active = s.session?.status === 'active';
  if (!active) return '';
  if (a.phase === 'evidence-verified' || a.phase === 'refused-second') {
    return `<article class="panel panel-current"><header class="panel-head"><span class="panel-no">→</span><h2>Finish the first scenario</h2></header>
      <p class="lead">Two integrity proofs remain: a second attempt to carry out the same request must be refused, and the original blocked decision must be unchanged.</p>
      <div class="actions">${button(['reconsiderAgain', 'historical'], 'Run the integrity proofs', { working: 'Running proofs…' })}</div></article>`;
  }
  return '';
}

function controlTest(s: State): string {
  const b = s.scenarioB;
  const res = b.result;
  const st = s.story;
  const show = res !== undefined || s.scenarioA.phase === 'complete' || b.status === 'running' || b.status === 'failed';
  if (!show) return '';
  const intro = `<p class="lead">Same agent, same approved destination — now it asks for ${esc(usd(b.requestedUsd))}. <strong>Policy permits this kind of payment, but this agent does not have authority for this amount.</strong></p>`;
  const facts = rows([row('Destination', b.destinationApproved ? pill('Approved', 'ok') : pill('Not approved', 'bad')), row('Requested', `<strong>${esc(usd(b.requestedUsd))}</strong>`), row("Agent's authority ceiling", `${esc(usd(b.ceilingUsd))} per payment`)]);
  const body =
    res === undefined
      ? `${intro}${facts}<div class="actions">${button('scenarioB', 'Run the second control test', { working: 'Frontera is evaluating…', hint: 'Governed request only — this must never reach the ledger.' })}</div>`
      : `${facts}
        <div class="moment moment-block"><div class="moment-kicker">Authority ceiling exceeded</div><div class="moment-title">Authorization withheld</div><div class="moment-copy">Policy permits this kind of payment, but this agent does not have authority for ${esc(usd(res.requested?.value ?? b.requestedUsd))}. Frontera needs both before it issues a grant.</div></div>
        ${checks([
          check('yes', 'Agent recognized', 'Identity verified'),
          check('yes', 'Destination', 'Approved'),
          check('yes', 'Payment policy', 'Permits this kind of payment'),
          check('no', 'Authority', `${esc(usd(res.requested?.value ?? b.requestedUsd))} exceeds the ${esc(usd(res.ceiling?.value ?? b.ceilingUsd))} ceiling — authorization withheld`),
        ])}
        ${proofLine({ grants: res.grants, signatures: res.signatures, submissions: res.submissions + res.connections + res.attemptRows + (res.transaction === null ? 0 : 1) }, ['No grant', 'No signature', 'No chain execution'])}
        ${details('control-test', 'Details', rows([row('Policy decision', `<code>${esc(res.decisionStatus)}</code> — the kind of payment is permitted`), row('Authority', `<code>${esc(res.issuanceOutcome)}</code> by <code>${esc(res.withheldBy)}</code>`), row('Reason', reasonList([res.reasonCode])), row('XRPL connections · signatures · submissions · attempt rows', `${res.connections} · ${res.signatures} · ${res.submissions} · ${res.attemptRows}`), row('Transaction', res.transaction === null ? 'None' : esc(res.transaction)), row('Issuance record', id(res.issuanceRecordId)), row('Request', id(res.requestId)), row('Decision', id(res.decisionId)), row('Evidence trace (ASSURE-01)', `${res.assureVerified ? 'Verified' : 'Not verified'} · <code>${esc(res.assureFinalState)}</code>`)], 'rows-1'))}`;
  const current = res === undefined && b.status !== 'failed';
  return `<article class="panel ${current ? 'panel-current' : ''} ${res !== undefined ? 'panel-block' : ''}" id="control-test">
    <header class="panel-head"><h2>${res === undefined ? 'Run the second control test' : 'Second control test: authority ceiling'}</h2>${res !== undefined ? pill('Withheld', 'bad') : ''}</header>${body}
    <p class="muted small">Business scenario ${esc(usd(st.businessAmountUsd))} · this test ${esc(usd(st.secondTestUsd))}</p></article>`;
}

function setup(s: State): string {
  const p = s.preflight;
  const live = s.mode === 'live';
  const active = s.session?.status === 'active';
  if (active) {
    return `<div class="session-bar"><span>${pill('Ready', 'ok')} Demo session started ${time(s.session?.startedAt)}</span>${button('session', 'Start a new session', { kind: 'quiet', working: 'Starting…' })}</div>`;
  }
  // A finished (or recovered) run stays on screen; the readiness checklist only returns if the next start is refused.
  if (s.session !== undefined && p.status !== 'NOT READY') {
    return `<div class="session-bar session-bar-end"><span>This run has finished and is shown read-only. Starting again runs a fresh readiness check first.</span><span class="bar-actions">${button('session', 'Start a new session', { kind: 'secondary', working: 'Starting…' })}</span></div>`;
  }
  const known = p.status !== 'not-run';
  const mark = (ok: boolean | undefined): 'yes' | 'no' | 'skip' => (!known || ok === undefined ? 'skip' : ok ? 'yes' : 'no');
  const balanceOk = p.treasuryTestRlusd !== undefined && p.requiredAmount !== undefined ? Number(p.treasuryTestRlusd) >= Number(p.requiredAmount) : undefined;
  const previous = s.session !== undefined ? `<p class="muted small">The run below is a previous session, shown read-only.</p>` : '';
  return `<article class="panel panel-current panel-setup">
    <header class="panel-head"><span class="panel-no">0</span><h2>Get ready</h2>${p.status === 'READY' ? pill('Ready', 'ok') : p.status === 'NOT READY' ? pill('Not ready', 'bad') : pill('Not checked', 'idle')}</header>
    <p class="lead">Frontera checks the network, the wallets and the treasury before the demo starts. ${live ? 'These checks only read from XRPL Testnet; nothing is signed or sent.' : 'Rehearsal checks a scripted ledger; nothing reaches XRPL.'}</p>
    ${checks([
      check(mark(p.connectedNetworkId === p.expectedNetworkId), live ? 'XRPL Testnet' : 'Rehearsal ledger', known ? (p.connectedNetworkId === p.expectedNetworkId ? 'Connected' : 'Not the expected network') : 'Not checked yet'),
      check(mark(p.treasuryTrustLine === true && p.recipientTrustLine === true), 'Wallets', known ? (p.treasuryTrustLine === true && p.recipientTrustLine === true ? 'Treasury and destination can hold Test RLUSD' : 'A wallet cannot hold Test RLUSD') : 'Not checked yet'),
      check(mark(balanceOk), 'Treasury balance', p.treasuryTestRlusd !== undefined ? `${esc(grouped(p.treasuryTestRlusd))} Test RLUSD available · ${esc(grouped(p.requiredAmount))} needed` : 'Not checked yet'),
      check(mark(p.attemptState === 'clean'), 'Earlier payments', p.attemptState === 'clean' ? 'All settled' : p.attemptState === 'blocked' ? 'An earlier payment is unsettled' : 'Not checked yet'),
      check(known ? 'yes' : 'skip', 'Signing keys', live ? 'Held by the local backend only' : 'Generated in memory for this rehearsal'),
    ])}
    ${p.status === 'NOT READY' ? `<div class="reasons"><strong>Not ready — the demo cannot start.</strong><ul>${p.reasons.map((reason) => `<li>${esc(reason)}</li>`).join('')}</ul><p class="muted small">The demo never funds, resets or lowers the amount. Fix the setup explicitly, then check again.</p></div>` : ''}
    ${previous}
    <div class="actions">${button('preflight', 'Check readiness', { kind: 'secondary', working: 'Checking…' })}${button('session', 'Start the demo', { working: 'Starting…', hint: 'A fresh session: new run, destination not approved.' })}</div>
    ${details('setup', 'Details', rows([row('Network', `${esc(p.networkName)} · network_id ${esc(p.connectedNetworkId ?? '—')} (expected ${esc(p.expectedNetworkId)})`), row('Validated ledger', esc(p.validatedLedger ?? '—')), row('Treasury', id(p.treasury)), row('Destination', id(p.recipient)), row('Test RLUSD issuer', id(p.issuer)), row('Keys', esc(p.secrets)), row('Checked at', time(p.checkedAt))], 'rows-1'))}
  </article>`;
}

function banners(s: State): string {
  const out: string[] = [];
  if (s.review.required) {
    out.push(`<section class="banner banner-bad" role="alert"><h2>Execution state requires review</h2><p>An earlier XRPL payment is not settled. Every payment control is disabled until it is reconciled on the ledger. No further payment will be made.</p><ul>${s.review.reasons.map((r) => `<li>${esc(r)}</li>`).join('')}</ul></section>`);
  }
  if (s.notice !== undefined) out.push(`<section class="banner banner-warn"><p>${esc(s.notice)}</p></section>`);
  if (lastError !== undefined) out.push(`<section class="banner banner-warn" role="status"><p>${esc(lastError)}</p></section>`);
  return out.join('');
}

function verdict(s: State): string {
  const links = `<div class="actions">
      <a class="btn btn-secondary ${s.verdict.reportAvailable ? '' : 'btn-disabled'}" ${s.verdict.reportAvailable ? 'href="/api/report" target="_blank" rel="noopener"' : 'aria-disabled="true"'}>View report</a>
      <a class="btn btn-quiet ${s.verdict.reportAvailable ? '' : 'btn-disabled'}" ${s.verdict.reportAvailable ? 'href="/api/report?download=1"' : 'aria-disabled="true"'}>Download report</a>
      <a class="btn btn-quiet ${s.verdict.summaryAvailable ? '' : 'btn-disabled'}" ${s.verdict.summaryAvailable ? 'href="/api/summary" target="_blank" rel="noopener"' : 'aria-disabled="true"'}>Summary (JSON)</a>
    </div>`;
  if (s.verdict.status === 'PASS') {
    return `<section class="final final-pass" aria-label="Demo result">
      <div class="final-head"><div><div class="eyebrow">Demo complete</div><h2>Both control tests passed</h2></div>${pill(s.mode === 'rehearsal' ? 'Rehearsal' : 'XRPL Testnet', s.mode === 'rehearsal' ? 'info' : 'live')}</div>
      <ul class="final-points">
        <li>Governance blocked what was forbidden.</li>
        <li>Governance allowed what became authorized.</li>
        <li>Only authorized execution reached ${s.mode === 'live' ? 'XRPL Testnet' : 'the scripted rehearsal ledger'}.</li>
        <li>Every material outcome is evidenced and verified.</li>
      </ul>${links}</section>`;
  }
  if (s.verdict.status === 'FAIL') {
    const f = s.verdict.failure;
    return `<section class="final final-fail" role="alert"><div class="final-head"><div><div class="eyebrow">Run stopped</div><h2>The run did not complete</h2></div>${pill('Not passed', 'bad')}</div>
      ${f !== undefined ? `<p>${esc(f.message)}</p><p class="muted small">${esc(f.category)}${f.step !== undefined ? ` · ${esc(f.step)}` : ''}</p>` : ''}
      <p class="muted small">A run that fails any check is never shown as passed. Start a new session to run again.</p>${s.verdict.reportAvailable ? links : ''}</section>`;
  }
  return '';
}

function demoTab(s: State): string {
  const showStory = s.session !== undefined;
  return `${verdict(s)}${setup(s)}${showStory ? `${storyPanels(s)}${nextUp(s)}${integrityProofs(s)}${controlTest(s)}` : ''}`;
}

// ── Technical evidence tab ────────────────────────────────────────────────

function evidenceTab(s: State): string {
  const a = s.scenarioA;
  const b = s.scenarioB.result;
  const tr = (label: string, value: string, ok?: boolean) => `<tr><th>${esc(label)}</th><td>${value}</td><td>${ok === undefined ? '' : ok ? '<span class="ok-text">✓</span>' : '<span class="muted">—</span>'}</td></tr>`;
  const finalState = s.verdict.status;
  return `<div class="flow">
    <article class="panel"><header class="panel-head"><h2>Run</h2>${pill(finalState === 'PASS' ? 'Passed' : finalState === 'FAIL' ? 'Not passed' : finalState === 'IN PROGRESS' ? 'In progress' : 'Not started', finalState === 'PASS' ? 'ok' : finalState === 'FAIL' ? 'bad' : 'idle')}</header>
      ${rows([row('Run ID', id(s.session?.runId)), row('Mode', esc(s.modeLabel)), row('Network', esc(s.network.name)), row('Started', esc(s.session?.startedAt ?? '—')), row('Finished', esc(s.verdict.finishedAt ?? '—')), row('Phase', `<code>${esc(a.phase)}</code>`), row('Business amount', esc(usd(s.story.businessAmountUsd))), row('Governed / settled in this run', `${esc(usd(s.story.governedAmountUsd))} / ${settlement(s)}${s.story.scaled ? ' (scaled)' : ''}`)])}
      <p class="muted small">${esc(s.network.description)}</p>
      <div class="actions">
        <a class="btn btn-secondary ${s.verdict.summaryAvailable ? '' : 'btn-disabled'}" ${s.verdict.summaryAvailable ? 'href="/api/summary" target="_blank" rel="noopener"' : 'aria-disabled="true"'}>View summary</a>
        <a class="btn btn-secondary ${s.verdict.reportAvailable ? '' : 'btn-disabled'}" ${s.verdict.reportAvailable ? 'href="/api/report" target="_blank" rel="noopener"' : 'aria-disabled="true"'}>View report</a>
        <a class="btn btn-secondary ${s.verdict.reportAvailable ? '' : 'btn-disabled'}" ${s.verdict.reportAvailable ? 'href="/api/report?download=1"' : 'aria-disabled="true"'}>Download report</a>
        <span class="btn-hint">Written by the backend after the run finishes.</span>
      </div>
    </article>
    <article class="panel"><header class="panel-head"><h2>Governed payment</h2></header>
      <table class="evidence"><tbody>
        ${tr('Request', id(a.request?.requestId), a.request !== undefined)}
        ${tr('Decision', a.request !== undefined ? `${id(a.request.decision.decisionId)} <span class="muted">${esc(a.request.decision.status)} · ${esc(a.request.decision.reasonCodes.join(', '))}</span>` : '—', a.request !== undefined)}
        ${tr('Approval', a.approval !== undefined ? `${esc(a.approval.approvedBy)} <span class="muted">${esc(a.approval.role)} · ${esc(a.approval.approvedAt)}</span>` : '—', a.approval !== undefined)}
        ${tr('Reconsideration', a.authorization !== undefined ? `${id(a.authorization.reconsiderationRequestId)} <span class="muted">intent ${esc(a.authorization.businessIntentId ?? '—')}</span>` : '—', a.authorization !== undefined)}
        ${tr('Grant', id(a.authorization?.grantId), a.authorization !== undefined)}
        ${tr('Execution', id(a.authorization?.executionId), a.execution !== undefined)}
        ${tr('XRPL transaction', a.execution !== undefined ? `${id(a.execution.transactionHash)}${a.execution.scripted ? ' <span class="pill pill-info">Rehearsal</span>' : ''}` : '—', a.execution !== undefined)}
        ${tr('Outcome', a.execution !== undefined ? `${esc(a.execution.engineResult ?? '')} · ledger ${esc(a.execution.ledgerIndex ?? '—')} · ${esc(a.execution.deliveredValue ?? '')} ${esc(a.execution.deliveredAsset)}` : '—', a.execution !== undefined)}
        ${tr('ASSURE-01 verification', a.evidence !== undefined ? `verified · ${esc(a.evidence.checks)} checks · <code>${esc(a.evidence.finalState)}</code>` : '—', a.evidence?.verified)}
        ${tr('Second reconsideration', a.second !== undefined ? `${esc(a.second.status)} · <code>${esc(a.second.reasonCodes.join(', '))}</code>` : '—', a.second !== undefined)}
        ${tr('Historical decision', a.historical !== undefined ? `${esc(a.historical.status)} · ${a.historical.unchanged ? 'unchanged' : 'CHANGED'}` : '—', a.historical?.unchanged)}
      </tbody></table>
    </article>
    <article class="panel"><header class="panel-head"><h2>Authority ceiling test</h2></header>
      <table class="evidence"><tbody>
        ${tr('Request', id(b?.requestId), b !== undefined)}
        ${tr('Decision', b !== undefined ? `${id(b.decisionId)} <span class="muted">policy ${esc(b.decisionStatus)}</span>` : '—', b !== undefined)}
        ${tr('Issuance record', b !== undefined ? `${id(b.issuanceRecordId)} <span class="muted">${esc(b.issuanceOutcome)} by ${esc(b.withheldBy)}</span>` : '—', b !== undefined)}
        ${tr('Reason', b !== undefined ? `<code>${esc(b.reasonCode)}</code> · ${esc(usd(b.requested?.value))} requested / ${esc(usd(b.ceiling?.value))} ceiling` : '—', b !== undefined)}
        ${tr('No-execution proof', b !== undefined ? `grants ${esc(b.grants)} · connections ${esc(b.connections)} · signatures ${esc(b.signatures)} · submissions ${esc(b.submissions)} · attempt rows ${esc(b.attemptRows)} · transaction ${esc(b.transaction ?? 'none')}` : '—', b !== undefined && b.grants + b.connections + b.signatures + b.submissions + b.attemptRows === 0)}
        ${tr('ASSURE-01 verification', b !== undefined ? `${b.assureVerified ? 'verified' : 'not verified'} · <code>${esc(b.assureFinalState)}</code>` : '—', b?.assureVerified)}
      </tbody></table>
    </article>
    <article class="panel"><header class="panel-head"><h2>Checkpoints</h2></header>
      ${s.checkpoints.length === 0 ? '<p class="muted">No checkpoint yet.</p>' : `<table class="evidence checkpoints"><tbody>${s.checkpoints.map((c) => `<tr><th>${esc(c.step)}</th><td>${pill(c.result.toLowerCase(), c.result === 'FAIL' ? 'bad' : c.result === 'PASS' ? 'ok' : 'info')}</td><td class="muted small">${esc(c.detail ?? '')}</td></tr>`).join('')}</tbody></table>`}
      ${details('transcript', 'Run log (the same story as the one-command demo)', `<pre class="transcript">${esc(s.transcript.join('\n'))}</pre>`)}
    </article>
  </div>`;
}

// ── Page ──────────────────────────────────────────────────────────────────

function tabs(): string {
  const item = (name: typeof tab, label: string) => `<button type="button" role="tab" class="tab ${tab === name ? 'tab-on' : ''}" aria-selected="${tab === name}" data-tab="${name}">${esc(label)}</button>`;
  return `<nav class="tabs" role="tablist">${item('demo', 'Demo')}${item('evidence', 'Technical evidence')}</nav>`;
}

function render(): void {
  const root = document.getElementById('app');
  if (root === null) return;
  const s = state;
  if (s === undefined) {
    root.innerHTML = `<div class="boot">${esc(lastError ?? 'Loading…')}</div>`;
    return;
  }
  const story = tab === 'demo' ? `${hero(s)}${s.session !== undefined ? `<div class="progress">${stepper(s)}${meter(s)}</div>` : ''}` : '';
  const main = tab === 'demo' ? demoTab(s) : evidenceTab(s);
  root.innerHTML = `${header(s)}<main class="shell">${banners(s)}${tabs()}${story}<div class="flow">${main}</div></main>
    <footer class="foot">Frontera governs; this page only displays. Every value shown is read from the local demo backend, which reads it from Frontera's records.</footer>`;
  tickCountdowns();
}

/** Display only: the time left before the backend's release deadline. It never changes state or triggers an action. */
function tickCountdowns(): void {
  for (const element of Array.from(document.querySelectorAll<HTMLElement>('[data-deadline]'))) {
    const deadline = Date.parse(element.dataset['deadline'] ?? '');
    if (Number.isNaN(deadline)) continue;
    const left = Math.floor((deadline - Date.now()) / 1000);
    if (left <= 0) {
      element.textContent = 'Expired — the payment will be refused; start a new session';
      element.classList.add('countdown-expired');
      continue;
    }
    element.textContent = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
    element.classList.toggle('countdown-low', left <= 90);
  }
}
window.setInterval(tickCountdowns, 1000);

document.addEventListener('click', (event) => {
  const target = event.target as HTMLElement | null;
  const actionButton = target?.closest<HTMLButtonElement>('button[data-actions]');
  if (actionButton !== null && actionButton !== undefined) {
    if (!actionButton.disabled) void actSequence((actionButton.dataset['actions'] ?? '').split(' ').filter((name) => name !== ''));
    return;
  }
  const tabButton = target?.closest<HTMLButtonElement>('button[data-tab]');
  if (tabButton !== null && tabButton !== undefined) {
    tab = tabButton.dataset['tab'] === 'evidence' ? 'evidence' : 'demo';
    history.replaceState(null, '', `#${tab}`);
    render();
    return;
  }
  const copy = target?.closest<HTMLButtonElement>('button[data-copy]');
  if (copy !== null && copy !== undefined) {
    void navigator.clipboard?.writeText(copy.dataset['copy'] ?? '').then(() => {
      copy.textContent = 'Copied';
    });
  }
});
document.addEventListener(
  'toggle',
  (event) => {
    const element = event.target as HTMLDetailsElement;
    const key = element.dataset?.['key'];
    if (key === undefined) return;
    if (element.open) openDetails.add(key);
    else openDetails.delete(key);
  },
  true,
);

void load();
