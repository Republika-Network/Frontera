import { AuthorityApiError, type AuthorityApi } from './api.js';
import type { ApprovalDetail, ApprovalSummary, DecisionChallenge, DecisionStatus, SessionInfo, Verdict } from './contracts.js';
import { PasskeyError, type PasskeyPort } from './passkeys.js';

/**
 * AUTH-04C — the Authority web client's state machine.
 *
 * Pure orchestration over the gateway API and the passkey port; no DOM. It
 * never decides anything itself:
 * - a decision is only ever started from an explicit confirmation of a verdict
 *   the Host listed for this human, on the detail the Host returned;
 * - every decision uses a **fresh** challenge and a fresh passkey assertion;
 * - an assertion is submitted at most once — after an uncertain submission the
 *   client reads the read-only decision status, it never resubmits;
 * - success is shown only when the Host reports it, and execution is never
 *   reported as confirmed.
 */

export type Tone = 'info' | 'success' | 'warning' | 'error';

export interface Notice {
  readonly tone: Tone;
  readonly message: string;
  readonly code?: string;
}

export type Screen =
  | { readonly name: 'starting' }
  | { readonly name: 'welcome' }
  | { readonly name: 'enrol' }
  | { readonly name: 'enrolled' }
  | { readonly name: 'inbox' }
  | { readonly name: 'request'; readonly approvalRequestId: string }
  | { readonly name: 'confirm'; readonly approvalRequestId: string; readonly verdict: Verdict }
  | { readonly name: 'result'; readonly commitment: string; readonly approvalRequestId: string; readonly verdict: Verdict };

export type DigestCheck = 'verified' | 'mismatch' | 'unavailable' | 'pending';

/** Phases of one decision. `submitted` means an assertion left the browser: from then on only the status is read. */
export type DecisionPhase = 'idle' | 'challenging' | 'awaiting-passkey' | 'submitting' | 'submitted' | 'checking';

export interface State {
  readonly screen: Screen;
  readonly busy: boolean;
  readonly passkeysSupported: boolean;
  readonly session: SessionInfo | null;
  readonly inbox: readonly ApprovalSummary[] | null;
  readonly detail: ApprovalDetail | null;
  readonly digestCheck: DigestCheck;
  readonly phase: DecisionPhase;
  readonly status: DecisionStatus | null;
  /** The outcome could not be read yet (network or service failure after submission). */
  readonly outcomeUnknown: boolean;
  readonly invitation: string;
  readonly notice: Notice | null;
}

export interface ControllerDependencies {
  readonly api: AuthorityApi;
  readonly passkeys: PasskeyPort;
  /** `sha256:<hex>` of UTF-8 text — the browser's own check that the canonical subject matches its digest. Display integrity only, never authority. */
  readonly digest: (text: string) => Promise<string>;
}

export interface Controller {
  state(): State;
  subscribe(listener: (state: State) => void): () => void;
  start(): Promise<void>;
  signIn(): Promise<void>;
  showEnrolment(): void;
  showWelcome(): void;
  setInvitation(value: string): void;
  enrol(): Promise<void>;
  loadInbox(): Promise<void>;
  openRequest(approvalRequestId: string): Promise<void>;
  chooseVerdict(verdict: Verdict): void;
  cancelVerdict(): void;
  confirmDecision(): Promise<void>;
  checkStatus(): Promise<void>;
  backToInbox(): Promise<void>;
  signOut(): Promise<void>;
  dismissNotice(): void;
}

/** Calm, specific copy for every refusal the gateway can return. Never a raw server message for a known code. */
export const MESSAGES: Readonly<Record<string, string>> = {
  AUTHORITY_SESSION_REQUIRED: 'Your session has ended. Sign in with your passkey to continue.',
  AUTHORITY_SESSION_REVOKED: 'Your session ended because your access or passkey changed. Sign in again, or contact your administrator.',
  AUTHORITY_LOGIN_INVALID: 'That sign-in attempt expired or was interrupted. Try again.',
  HUMAN_IDENTITY_AUTHENTICATION_INVALID: 'That passkey response could not be verified. No action was taken.',
  HUMAN_IDENTITY_CREDENTIAL_UNUSABLE: 'This passkey is not active for Frontera Authority. Contact your administrator.',
  HUMAN_IDENTITY_COUNTER_REGRESSION: 'This passkey reported an unexpected state and was refused. Contact your administrator.',
  AUTHORITY_ENROLMENT_INVALID: 'This invitation is not valid. It may have expired, already been used, or been revoked. Ask your administrator for a new invitation.',
  AUTHORITY_ENROLMENT_CEREMONY_INVALID: 'Registration was interrupted. Start the registration again.',
  HUMAN_IDENTITY_REGISTRATION_INVALID: 'This device could not register a passkey that meets Frontera Authority requirements.',
  HUMAN_IDENTITY_CREDENTIAL_DUPLICATE: 'This passkey is already registered. Sign in with it instead.',
  HUMAN_DECISION_NOT_PERMITTED: 'Your role or approval standing does not allow this decision.',
  HUMAN_DECISION_NOT_APPLICABLE: 'This request changed or is no longer pending. Review it again before deciding.',
  AUTHORITY_NOT_FOUND: 'This request no longer awaits your decision.',
  HUMAN_IDENTITY_CHALLENGE_INVALID: 'The decision window closed before it was confirmed. No decision was recorded. Start again when ready.',
  AUTHORITY_DECISION_NOT_YOURS: 'This decision belongs to another session. Start a new decision.',
  AUTHORITY_FRESHNESS_UNAVAILABLE: 'Frontera Authority cannot confirm its state right now, so nothing can be decided. Try again shortly.',
  AUTHORITY_RATE_LIMITED: 'Too many attempts. Wait a moment, then try again.',
  NETWORK_UNAVAILABLE: 'Frontera Authority cannot be reached. Check your connection.',
  CONTRACT_VIOLATION: 'Frontera Authority answered in an unexpected way. Nothing was assumed.',
};

const SESSION_ENDED = new Set(['AUTHORITY_SESSION_REQUIRED', 'AUTHORITY_SESSION_REVOKED']);

function messageOf(error: unknown, fallback: string): Notice {
  if (error instanceof PasskeyError) {
    const copy: Record<string, string> = {
      cancelled: 'The passkey request was cancelled. Nothing was signed and nothing was decided.',
      unsupported: 'This browser or device does not support passkeys. Use Safari on a current iPhone, or another passkey-capable browser.',
      'invalid-state': 'This device already holds a Frontera Authority passkey for you. Sign in with it instead.',
      security: 'The browser refused the passkey request for this address. Open Frontera Authority at its official address.',
      invalid: 'The authenticator returned an incomplete response. Try again.',
      failed: 'The passkey request did not complete. Try again.',
    };
    return { tone: error.failure === 'cancelled' ? 'info' : 'warning', message: copy[error.failure] ?? fallback, code: `PASSKEY_${error.failure.toUpperCase().replace(/-/g, '_')}` };
  }
  if (error instanceof AuthorityApiError) {
    const known = MESSAGES[error.code];
    if (known !== undefined) return { tone: error.status >= 500 || error.status === 0 ? 'warning' : 'error', message: known, code: error.code };
    if (error.status >= 500) return { tone: 'warning', message: 'Frontera Authority is temporarily unavailable. Nothing was decided. Try again shortly.', code: error.code };
  }
  return { tone: 'error', message: fallback };
}

const INITIAL: State = {
  screen: { name: 'starting' },
  busy: false,
  passkeysSupported: true,
  session: null,
  inbox: null,
  detail: null,
  digestCheck: 'pending',
  phase: 'idle',
  status: null,
  outcomeUnknown: false,
  invitation: '',
  notice: null,
};

export function createController(dependencies: ControllerDependencies): Controller {
  const { api, passkeys, digest } = dependencies;
  let current: State = { ...INITIAL, passkeysSupported: passkeys.supported() };
  const listeners = new Set<(state: State) => void>();
  const set = (patch: Partial<State>): void => {
    current = { ...current, ...patch };
    for (const listener of listeners) listener(current);
  };

  /** A session that ended (expired, revoked) returns the human to sign-in; nothing sensitive is kept. */
  const endSession = (notice: Notice): void => set({ ...INITIAL, passkeysSupported: current.passkeysSupported, screen: { name: 'welcome' }, notice });

  /** Runs a step with the busy guard; a second activation while busy is ignored (no double submission). */
  async function guarded(step: () => Promise<void>, fallback: string): Promise<void> {
    if (current.busy) return;
    set({ busy: true, notice: null });
    try {
      await step();
    } catch (error) {
      if (error instanceof AuthorityApiError && SESSION_ENDED.has(error.code)) endSession(messageOf(error, fallback));
      else set({ notice: messageOf(error, fallback) });
    } finally {
      set({ busy: false });
    }
  }

  async function refreshInbox(): Promise<void> {
    set({ inbox: await api.inbox() });
  }

  async function readStatus(commitment: string): Promise<void> {
    set({ phase: 'checking' });
    try {
      set({ status: await api.decisionStatus(commitment), outcomeUnknown: false, phase: 'submitted' });
    } catch (error) {
      if (error instanceof AuthorityApiError && SESSION_ENDED.has(error.code)) throw error;
      // The outcome is unknown: say so, and offer a read — never a resubmission.
      set({ outcomeUnknown: true, phase: 'submitted', notice: { tone: 'warning', message: 'The outcome could not be confirmed yet. Check the status again — the decision will not be sent twice.', ...(error instanceof AuthorityApiError ? { code: error.code } : {}) } });
    }
  }

  return {
    state: () => current,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    async start() {
      try {
        const session = await api.session();
        set({ session, screen: { name: 'inbox' } });
        await guarded(refreshInbox, 'The approval inbox could not be loaded.');
      } catch (error) {
        set({ screen: { name: 'welcome' }, ...(error instanceof AuthorityApiError && error.status === 401 ? {} : { notice: messageOf(error, 'Frontera Authority could not be reached.') }) });
      }
    },

    signIn: () =>
      guarded(async () => {
        const options = await api.loginOptions();
        const assertion = await passkeys.get(options);
        const session = await api.login(assertion);
        set({ session, screen: { name: 'inbox' }, inbox: null });
        await refreshInbox();
      }, 'Sign-in did not complete.'),

    showEnrolment: () => set({ screen: { name: 'enrol' }, notice: null }),
    showWelcome: () => set({ screen: { name: 'welcome' }, notice: null, invitation: '' }),
    setInvitation: (value) => set({ invitation: value.trim() }),

    enrol: () =>
      guarded(async () => {
        const invitation = current.invitation;
        if (invitation.length === 0) {
          set({ notice: { tone: 'error', message: 'Enter the invitation code your administrator gave you.' } });
          return;
        }
        const options = await api.enrolmentOptions(invitation);
        const credential = await passkeys.create(options);
        await api.enrol(invitation, credential);
        // No session is created by registration: the human signs in explicitly next.
        set({ screen: { name: 'enrolled' }, invitation: '', notice: null });
      }, 'Registration did not complete.'),

    loadInbox: () => guarded(refreshInbox, 'The approval inbox could not be loaded.'),

    openRequest: (approvalRequestId) =>
      guarded(async () => {
        set({ detail: null, digestCheck: 'pending', status: null, phase: 'idle', outcomeUnknown: false });
        try {
          const detail = await api.approval(approvalRequestId);
          set({ detail, screen: { name: 'request', approvalRequestId } });
          let check: DigestCheck;
          try {
            check = (await digest(detail.canonicalSubject)) === detail.subjectDigest ? 'verified' : 'mismatch';
          } catch {
            check = 'unavailable';
          }
          set({ digestCheck: check });
        } catch (error) {
          if (error instanceof AuthorityApiError && error.code === 'AUTHORITY_NOT_FOUND') {
            set({ screen: { name: 'inbox' }, detail: null, notice: messageOf(error, '') });
            await refreshInbox();
            return;
          }
          throw error;
        }
      }, 'This request could not be loaded.'),

    chooseVerdict(verdict) {
      const { screen, detail, digestCheck, busy } = current;
      // Only from the inspected detail, only for a verdict the Host listed, and never over a subject whose digest did not match.
      if (busy || screen.name !== 'request' || detail === null || detail.approvalRequestId !== screen.approvalRequestId) return;
      if (!detail.verdicts.includes(verdict) || digestCheck === 'mismatch') return;
      set({ screen: { name: 'confirm', approvalRequestId: detail.approvalRequestId, verdict }, notice: null });
    },

    cancelVerdict() {
      const { screen } = current;
      if (screen.name === 'confirm' && !current.busy) set({ screen: { name: 'request', approvalRequestId: screen.approvalRequestId }, notice: null });
    },

    confirmDecision: () =>
      guarded(async () => {
        const { screen, detail, session } = current;
        if (screen.name !== 'confirm' || detail === null || session === null || detail.approvalRequestId !== screen.approvalRequestId) return;
        // A fresh challenge for exactly this request, subject and verdict. The subject digest is the Host's own, never computed here.
        set({ phase: 'challenging' });
        let challenge: DecisionChallenge;
        try {
          challenge = await api.decisionChallenge(detail.approvalRequestId, detail.subjectDigest, screen.verdict, session.csrfToken);
        } catch (error) {
          set({ phase: 'idle' });
          throw error;
        }
        set({ phase: 'awaiting-passkey' });
        let assertion: Readonly<Record<string, unknown>>;
        try {
          assertion = await passkeys.get(challenge.publicKey);
        } catch (error) {
          // Nothing was signed: the challenge is simply abandoned and lapses. A new attempt needs a new, explicit action.
          set({ phase: 'idle' });
          throw error;
        }
        set({ phase: 'submitting' });
        const result = { commitment: challenge.commitment, approvalRequestId: challenge.approvalRequestId, verdict: challenge.verdict } as const;
        try {
          await api.submitDecision(assertion, session.csrfToken);
        } catch (error) {
          if (error instanceof AuthorityApiError && SESSION_ENDED.has(error.code)) throw error;
          // Refusals decided before the assertion was used: nothing was recorded; the human may start again explicitly.
          const beforeUse = error instanceof AuthorityApiError && ['HUMAN_IDENTITY_CHALLENGE_INVALID', 'HUMAN_DECISION_NOT_APPLICABLE', 'HUMAN_DECISION_NOT_PERMITTED', 'HUMAN_IDENTITY_AUTHENTICATION_INVALID', 'HUMAN_IDENTITY_CREDENTIAL_UNUSABLE', 'AUTHORITY_DECISION_NOT_YOURS', 'AUTHORITY_REQUEST_INVALID'].includes(error.code);
          if (beforeUse) {
            set({ phase: 'idle', screen: { name: 'request', approvalRequestId: detail.approvalRequestId } });
            throw error;
          }
          // Anything else — a lost response, an outage, an already-used decision: read the authoritative status. Never resubmit.
          set({ phase: 'submitted', status: null, screen: { name: 'result', ...result } });
          await readStatus(challenge.commitment);
          return;
        }
        set({ phase: 'submitted', status: null, screen: { name: 'result', ...result } });
        // The submission answer is acknowledged; the status read is the authoritative, shareable record of the outcome.
        await readStatus(challenge.commitment);
      }, 'The decision did not complete.'),

    checkStatus: () =>
      guarded(async () => {
        const { screen } = current;
        if (screen.name === 'result') await readStatus(screen.commitment);
      }, 'The status could not be read.'),

    backToInbox: () =>
      guarded(async () => {
        set({ screen: { name: 'inbox' }, detail: null, status: null, phase: 'idle', outcomeUnknown: false, digestCheck: 'pending' });
        await refreshInbox();
      }, 'The approval inbox could not be loaded.'),

    signOut: () =>
      guarded(async () => {
        const session = current.session;
        try {
          if (session !== null) await api.logout(session.csrfToken);
        } finally {
          endSession({ tone: 'info', message: 'You have signed out.' });
        }
      }, 'Sign-out did not complete.'),

    dismissNotice: () => set({ notice: null }),
  };
}
