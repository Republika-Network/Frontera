import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { AuthorityApiError, type AuthorityApi } from '../api.js';
import type { ApprovalDetail, ApprovalSummary, AssertionOptionsJSON, CreationOptionsJSON, DecisionChallenge, DecisionStatus, SessionInfo, Verdict } from '../contracts.js';
import { parseDetail, parseStatus } from '../contracts.js';
import { createController, type Controller } from '../controller.js';
import { DECISION_LABELS } from '../format.js';
import { PasskeyError, assertionJSON, base64urlToBytes, bytesToBase64url, classifyPasskeyError, registrationJSON, toCreationOptions, toRequestOptions, type PasskeyPort } from '../passkeys.js';
import { render } from '../view.js';
import { findAll, textOf, type VElement } from '../vnode.js';

/**
 * AUTH-04C — the Authority web client, unit level.
 *
 * The browser-only boundaries are replaced here, and only here: the gateway
 * API (scripted responses in the real contract shape) and the passkey dialog.
 * Everything above them — the state machine, the view, the codec — is the
 * shipped code. The real Host contracts are exercised end to end by
 * auth04c-authority-web-host.test.ts.
 */

const NOW = Date.parse('2026-10-27T10:00:00.000Z');
const sha = (text: string): string => `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;
const SESSION: SessionInfo = { operatorId: 'approver-a', displayName: 'Chief Technology Officer', organizationId: 'org-pilot', csrfToken: 'csrf-token-123' };
const CANONICAL = '{"action":"deploy-release","actorId":"actor-release-agent","resourceScope":"production-cluster"}';
const DIGEST = sha(CANONICAL);
const REQUEST_ID = `approval-request:${'a'.repeat(64)}`;
const COMMITMENT = `sha256:${'c'.repeat(64)}`;

function summary(overrides: Partial<ApprovalSummary> = {}): ApprovalSummary {
  return {
    approvalRequestId: REQUEST_ID,
    status: 'pending',
    action: 'deploy-release',
    resourceScope: 'production-cluster',
    governanceProfile: 'release-production@1#sha256:abc',
    requestedAt: '2026-10-27T09:50:00.000Z',
    requestExpiresAt: '2026-10-27T10:50:00.000Z',
    subjectDigest: DIGEST,
    quorum: { minimumApprovals: 1, counted: 0 },
    verdicts: ['approve', 'reject'],
    ...overrides,
  };
}

function detail(overrides: Partial<ApprovalDetail> = {}): ApprovalDetail {
  return {
    ...summary(),
    canonicalSubject: CANONICAL,
    subject: {
      actorId: 'actor-release-agent',
      principalActorId: 'actor-release-owner',
      action: 'deploy-release',
      resourceScope: 'production-cluster',
      counterpartyId: null,
      amount: null,
      parameters: [{ dimension: 'releaseVersion', type: 'token', value: 'release-2026-10-01' }],
      governanceProfile: 'release-production@1#sha256:abc',
      decision: { status: 'approval_required', reasonCodes: ['APPROVAL_REQUIRED'], evaluatedAt: '2026-10-27T09:50:00.000Z' },
      contextValidUntil: null,
    },
    requirement: { minimumApprovals: 1, requestTtlSeconds: 3600, approvalValiditySeconds: 900, requiredEvidence: [] },
    ...overrides,
  };
}

const OPTIONS: AssertionOptionsJSON = { rpId: 'authority.frontera-systems.com', challenge: 'Y2hhbGxlbmdl', timeout: 120000, userVerification: 'required', allowCredentials: [] };

function challenge(verdict: Verdict): DecisionChallenge {
  return { publicKey: OPTIONS, commitment: COMMITMENT, approvalRequestId: REQUEST_ID, subjectDigest: DIGEST, verdict, expiresAt: '2026-10-27T10:02:00.000Z' };
}

function status(decision: DecisionStatus['decision'], requestStatus = 'pending', code: string | null = null): DecisionStatus {
  return { commitment: COMMITMENT, approvalRequestId: REQUEST_ID, verdict: 'approve', decision, code, request: { status: requestStatus, superseded: false }, execution: 'not_observed' };
}

type Call = { readonly name: string; readonly args: readonly unknown[] };

type Script = Partial<Record<keyof AuthorityApi, (...args: never[]) => unknown>>;

/** A scripted gateway: each method answers from its script, records its calls, and fails loudly if unscripted. */
function scriptedApi(script: Script): { readonly api: AuthorityApi; readonly calls: Call[] } {
  const calls: Call[] = [];
  async function answer<T>(name: keyof AuthorityApi, args: readonly unknown[]): Promise<T> {
    calls.push({ name, args });
    const handler = script[name] as ((...values: unknown[]) => unknown) | undefined;
    if (handler === undefined) throw new Error(`unscripted ${name}`);
    return (await handler(...args)) as T;
  }
  const api: AuthorityApi = {
    loginOptions: () => answer('loginOptions', []),
    login: (assertion) => answer('login', [assertion]),
    session: () => answer('session', []),
    logout: (csrfToken) => answer('logout', [csrfToken]),
    inbox: () => answer('inbox', []),
    approval: (approvalRequestId) => answer('approval', [approvalRequestId]),
    decisionChallenge: (approvalRequestId, subjectDigest, verdict, csrfToken) => answer('decisionChallenge', [approvalRequestId, subjectDigest, verdict, csrfToken]),
    submitDecision: (assertion, csrfToken) => answer('submitDecision', [assertion, csrfToken]),
    decisionStatus: (commitment) => answer('decisionStatus', [commitment]),
    enrolmentOptions: (invitation) => answer('enrolmentOptions', [invitation]),
    enrol: (invitation, credential) => answer('enrol', [invitation, credential]),
  };
  return { api, calls };
}

function passkeys(overrides: Partial<PasskeyPort> = {}): PasskeyPort & { readonly gets: unknown[] } {
  const gets: unknown[] = [];
  return {
    gets,
    supported: () => true,
    create: async () => ({ id: 'cred', rawId: 'cred', type: 'public-key', response: { clientDataJSON: 'e30', attestationObject: 'oA' } }),
    get: async (options) => {
      gets.push(options);
      return { id: 'cred', rawId: 'cred', type: 'public-key', response: { clientDataJSON: 'e30', authenticatorData: 'AA', signature: 'AA' } };
    },
    ...overrides,
  };
}

const unauthenticated = (): never => {
  throw new AuthorityApiError(401, 'AUTHORITY_SESSION_REQUIRED', 'Sign in.');
};

function controllerWith(script: Script, keys: PasskeyPort = passkeys()) {
  const { api, calls } = scriptedApi(script);
  const controller = createController({ api, passkeys: keys, digest: async (text) => sha(text) });
  return { controller, calls };
}

const view = (controller: Controller): VElement => render(controller.state(), controller, NOW);
const buttons = (tree: VElement): VElement[] => findAll(tree, (element) => element.tag === 'button');
const button = (tree: VElement, label: string): VElement => buttons(tree).find((element) => textOf(element) === label) ?? assert.fail(`no button "${label}" in: ${buttons(tree).map(textOf).join(' | ')}`);

async function signedInAt(script: Script = {}, keys: PasskeyPort = passkeys()) {
  const harness = controllerWith({ session: async () => SESSION, inbox: async () => [summary()], approval: async () => detail(), ...script }, keys);
  await harness.controller.start();
  return harness;
}

// ── Sign-in, enrolment, session ───────────────────────────────────────────────────

describe('AUTH-04C client — sign-in, enrolment and the session', () => {
  it('sign-in success: login options → the passkey dialog → login → the inbox; no password, no bearer field', async () => {
    const keys = passkeys();
    const { controller, calls } = controllerWith({ session: unauthenticated, loginOptions: async () => OPTIONS, login: async () => SESSION, inbox: async () => [summary()] }, keys);
    await controller.start();
    assert.equal(controller.state().screen.name, 'welcome');
    const welcome = view(controller);
    assert.equal(findAll(welcome, (element) => element.tag === 'input').length, 0, 'no password or token field on sign-in');
    assert.equal(/password|bearer|api key/i.test(textOf(welcome)), false);
    await controller.signIn();
    assert.deepEqual(calls.map((call) => call.name), ['session', 'loginOptions', 'login', 'inbox']);
    assert.deepEqual(keys.gets, [OPTIONS], 'the options are passed to the passkey dialog unchanged');
    assert.equal(controller.state().screen.name, 'inbox');
    assert.equal(controller.state().session?.operatorId, 'approver-a');
  });

  it('sign-in rejection and cancellation leave the human signed out with a calm explanation', async () => {
    const rejected = controllerWith({ session: unauthenticated, loginOptions: async () => OPTIONS, login: async () => { throw new AuthorityApiError(401, 'HUMAN_IDENTITY_AUTHENTICATION_INVALID', 'x'); } });
    await rejected.controller.start();
    await rejected.controller.signIn();
    assert.equal(rejected.controller.state().session, null);
    assert.equal(rejected.controller.state().notice?.code, 'HUMAN_IDENTITY_AUTHENTICATION_INVALID');
    assert.ok(findAll(view(rejected.controller), (element) => element.attributes.role === 'alert').length > 0, 'announced as an alert');
    const cancelled = controllerWith({ session: unauthenticated, loginOptions: async () => OPTIONS }, passkeys({ get: async () => { throw new PasskeyError('cancelled', 'x'); } }));
    await cancelled.controller.start();
    await cancelled.controller.signIn();
    assert.equal(cancelled.controller.state().notice?.code, 'PASSKEY_CANCELLED');
    assert.ok(!cancelled.calls.some((call) => call.name === 'login'), 'nothing is sent after a cancelled dialog');
  });

  it('unsupported browsers are told so and cannot start a passkey ceremony', async () => {
    const { controller } = controllerWith({ session: unauthenticated }, passkeys({ supported: () => false }));
    await controller.start();
    const tree = view(controller);
    assert.ok(button(tree, 'Sign in with passkey').attributes.disabled !== undefined);
    assert.match(textOf(tree), /does not support passkeys/);
  });

  it('enrolment success shows a confirmation and opens no session; an invalid invitation is explained', async () => {
    const { controller, calls } = controllerWith({ session: unauthenticated, enrolmentOptions: async () => ({}) as CreationOptionsJSON, enrol: async () => undefined });
    await controller.start();
    controller.showEnrolment();
    const form = view(controller);
    const input = findAll(form, (element) => element.tag === 'input')[0] ?? assert.fail('no invitation input');
    assert.equal(findAll(form, (element) => element.tag === 'label' && element.attributes.for === input.attributes.id).length, 1, 'the input is labelled');
    assert.equal(input.attributes.autocomplete, 'off');
    controller.setInvitation('  fre1.enr-x.secret  ');
    await controller.enrol();
    assert.deepEqual(calls.filter((call) => call.name === 'enrolmentOptions').map((call) => call.args[0]), ['fre1.enr-x.secret']);
    assert.equal(controller.state().screen.name, 'enrolled');
    assert.equal(controller.state().session, null, 'registration never signs in');
    assert.equal(controller.state().invitation, '', 'the invitation is not kept');
    assert.ok(button(view(controller), 'Sign in with passkey'));

    const invalid = controllerWith({ session: unauthenticated, enrolmentOptions: async () => { throw new AuthorityApiError(403, 'AUTHORITY_ENROLMENT_INVALID', 'x'); } });
    await invalid.controller.start();
    invalid.controller.showEnrolment();
    invalid.controller.setInvitation('fre1.expired');
    await invalid.controller.enrol();
    assert.equal(invalid.controller.state().screen.name, 'enrol');
    assert.match(invalid.controller.state().notice?.message ?? '', /expired, already been used, or been revoked/);
  });

  it('an expired or revoked session returns the human to sign-in and drops everything sensitive', async () => {
    let expired = false;
    const { controller } = await signedInAt({ inbox: async () => (expired ? unauthenticated() : [summary()]) });
    await controller.openRequest(REQUEST_ID);
    expired = true;
    await controller.backToInbox();
    const state = controller.state();
    assert.equal(state.screen.name, 'welcome');
    assert.deepEqual([state.session, state.detail, state.inbox], [null, null, null]);
    assert.match(state.notice?.message ?? '', /session has ended/);
  });

  it('sign-out calls the gateway with the CSRF token and clears the client state', async () => {
    const { controller, calls } = await signedInAt({ logout: async () => undefined });
    await controller.signOut();
    assert.deepEqual(calls.find((call) => call.name === 'logout')?.args, ['csrf-token-123']);
    assert.equal(controller.state().session, null);
    assert.equal(controller.state().screen.name, 'welcome');
  });
});

// ── Inbox and request detail ──────────────────────────────────────────────────────

describe('AUTH-04C client — the inbox and the authoritative subject', () => {
  it('renders the Host’s requests with a count; an empty inbox says so; no sample data is invented', async () => {
    const { controller } = await signedInAt();
    const tree = view(controller);
    assert.match(textOf(tree), /1 pending/);
    assert.ok(findAll(tree, (element) => element.attributes['aria-label'] === 'Review request: deploy-release on production-cluster').length === 1);
    const empty = await signedInAt({ inbox: async () => [] });
    assert.match(textOf(view(empty.controller)), /Nothing awaits your decision/);
    assert.equal(findAll(view(empty.controller), (element) => element.attributes.class === 'card').length, 0);
  });

  it('shows every field of the subject the gateway supplies, the exact canonical bytes, and a digest checked on the device', async () => {
    const { controller } = await signedInAt();
    await controller.openRequest(REQUEST_ID);
    assert.equal(controller.state().digestCheck, 'verified');
    const text = textOf(view(controller));
    for (const expected of [REQUEST_ID, 'actor-release-agent', 'actor-release-owner', 'deploy-release', 'production-cluster', 'releaseVersion', 'release-2026-10-01', 'release-production@1#sha256:abc', 'approval_required — APPROVAL_REQUIRED', '0 of 1 required', 'Matches the canonical subject']) {
      assert.ok(text.includes(expected), expected);
    }
    const code = findAll(view(controller), (element) => element.tag === 'code')[0] ?? assert.fail('no canonical bytes');
    assert.equal(textOf(code), CANONICAL, 'the canonical subject is shown byte for byte, untruncated');
    assert.match(text, /This summary is for reading\. The authoritative record is the subject below\./);
    // Fields the API does not supply are not invented.
    assert.equal(/environment|effect/i.test(text), false);
  });

  it('a canonical subject that does not match its digest blocks the decision', async () => {
    const { controller } = await signedInAt({ approval: async () => detail({ canonicalSubject: `${CANONICAL} ` }) });
    await controller.openRequest(REQUEST_ID);
    assert.equal(controller.state().digestCheck, 'mismatch');
    const tree = view(controller);
    assert.ok(button(tree, 'Approve').attributes.disabled !== undefined);
    controller.chooseVerdict('approve');
    assert.equal(controller.state().screen.name, 'request', 'no confirmation over a mismatched subject');
  });

  it('a request that no longer awaits the human returns to the refreshed inbox', async () => {
    const { controller } = await signedInAt({ approval: async () => { throw new AuthorityApiError(404, 'AUTHORITY_NOT_FOUND', 'x'); } });
    await controller.openRequest(REQUEST_ID);
    assert.equal(controller.state().screen.name, 'inbox');
    assert.match(controller.state().notice?.message ?? '', /no longer awaits your decision/);
  });

  it('untrusted text is rendered as text: markup in an action or parameter never becomes an element', async () => {
    const hostile = '<img src=x onerror="alert(1)"><script>alert(2)</script>';
    const { controller } = await signedInAt({
      inbox: async () => [summary({ action: hostile, resourceScope: hostile })],
      approval: async () => detail({ action: hostile, subject: { ...detail().subject, action: hostile, parameters: [{ dimension: hostile, type: 'token', value: hostile }] } }),
    });
    const tree = view(controller);
    assert.equal(findAll(tree, (element) => ['img', 'script', 'iframe', 'a'].includes(element.tag)).length, 0);
    assert.ok(textOf(tree).includes(hostile), 'shown literally');
    await controller.openRequest(REQUEST_ID);
    const detailTree = view(controller);
    assert.equal(findAll(detailTree, (element) => ['img', 'script'].includes(element.tag)).length, 0);
    for (const element of findAll(detailTree, () => true)) assert.equal(Object.keys(element.attributes).some((name) => name.startsWith('on') || name === 'style' || name === 'href' || name === 'src'), false);
  });
});

// ── Decisions ─────────────────────────────────────────────────────────────────────

describe('AUTH-04C client — explicit, passkey-confirmed decisions', () => {
  it('approve: inspect → choose → confirm → fresh challenge for the Host’s own digest → passkey → submit → authoritative status', async () => {
    const keys = passkeys();
    const { controller, calls } = await signedInAt({ decisionChallenge: async () => challenge('approve'), submitDecision: async () => ({ outcome: 'recorded', commitment: COMMITMENT, verdict: 'approve', approvalRequestId: REQUEST_ID, requestStatus: 'approved', execution: 'not_observed' }), decisionStatus: async () => status('approved', 'approved') }, keys);
    // No decision without opening the request first.
    controller.chooseVerdict('approve');
    assert.equal(controller.state().screen.name, 'inbox');
    await controller.openRequest(REQUEST_ID);
    assert.equal(calls.some((call) => call.name === 'decisionChallenge'), false, 'opening a request decides nothing');
    controller.chooseVerdict('approve');
    assert.equal(controller.state().screen.name, 'confirm');
    const confirmText = textOf(view(controller));
    assert.match(confirmText, /An approval is not proof that the action ran/);
    assert.match(confirmText, /Your passkey will be asked to confirm this exact decision/);
    await controller.confirmDecision();
    assert.deepEqual(calls.find((call) => call.name === 'decisionChallenge')?.args, [REQUEST_ID, DIGEST, 'approve', 'csrf-token-123']);
    assert.deepEqual(keys.gets, [OPTIONS]);
    assert.equal(calls.filter((call) => call.name === 'submitDecision').length, 1);
    assert.equal(controller.state().screen.name, 'result');
    const result = textOf(view(controller));
    assert.match(result, /Approval recorded/);
    assert.match(result, /Not observed by Frontera Authority\. An approval is not proof that the action ran\./);
    assert.equal(/executed successfully|execution confirmed/i.test(result), false);
  });

  it('reject follows the same path with its own verdict', async () => {
    const { controller, calls } = await signedInAt({ decisionChallenge: async () => challenge('reject'), submitDecision: async () => ({ outcome: 'recorded', commitment: COMMITMENT, verdict: 'reject', approvalRequestId: REQUEST_ID, requestStatus: 'rejected', execution: 'not_observed' }), decisionStatus: async () => ({ ...status('rejected', 'rejected'), verdict: 'reject' }) });
    await controller.openRequest(REQUEST_ID);
    controller.chooseVerdict('reject');
    assert.match(textOf(view(controller)), /Confirm rejection/);
    await controller.confirmDecision();
    assert.equal((calls.find((call) => call.name === 'decisionChallenge')?.args ?? [])[2], 'reject');
    assert.match(textOf(view(controller)), /Rejection recorded/);
  });

  it('a verdict the Host did not list cannot be chosen (role or standing)', async () => {
    const { controller } = await signedInAt({ approval: async () => detail({ verdicts: ['reject'] }) });
    await controller.openRequest(REQUEST_ID);
    const tree = view(controller);
    assert.equal(buttons(tree).some((element) => textOf(element) === 'Approve'), false);
    controller.chooseVerdict('approve');
    assert.equal(controller.state().screen.name, 'request');
    const none = await signedInAt({ approval: async () => detail({ verdicts: [] }) });
    await none.controller.openRequest(REQUEST_ID);
    assert.match(textOf(view(none.controller)), /does not allow a decision/);
  });

  it('WebAuthn cancellation submits nothing and keeps the human on the confirmation', async () => {
    const { controller, calls } = await signedInAt({ decisionChallenge: async () => challenge('approve') }, passkeys({ get: async () => { throw classifyPasskeyError({ name: 'NotAllowedError' }); } }));
    await controller.openRequest(REQUEST_ID);
    controller.chooseVerdict('approve');
    await controller.confirmDecision();
    assert.equal(calls.some((call) => call.name === 'submitDecision'), false);
    assert.equal(controller.state().screen.name, 'confirm');
    assert.match(controller.state().notice?.message ?? '', /cancelled\. Nothing was signed and nothing was decided/);
  });

  it('an expired decision challenge is explained and nothing is retried automatically', async () => {
    const { controller, calls } = await signedInAt({ decisionChallenge: async () => challenge('approve'), submitDecision: async () => { throw new AuthorityApiError(400, 'HUMAN_IDENTITY_CHALLENGE_INVALID', 'x'); } });
    await controller.openRequest(REQUEST_ID);
    controller.chooseVerdict('approve');
    await controller.confirmDecision();
    assert.equal(controller.state().screen.name, 'request');
    assert.match(controller.state().notice?.message ?? '', /decision window closed/);
    assert.equal(calls.filter((call) => call.name === 'submitDecision').length, 1);
    assert.equal(calls.filter((call) => call.name === 'decisionChallenge').length, 1);
  });

  it('a refusal by policy (standing) is shown as not recorded, never as success', async () => {
    const { controller } = await signedInAt({ decisionChallenge: async () => challenge('approve'), submitDecision: async () => ({ outcome: 'refused', commitment: COMMITMENT, code: 'APPROVAL_APPROVER_INELIGIBLE', reasonCode: null }), decisionStatus: async () => status('refused', 'pending', 'APPROVAL_APPROVER_INELIGIBLE') });
    await controller.openRequest(REQUEST_ID);
    controller.chooseVerdict('approve');
    await controller.confirmDecision();
    const text = textOf(view(controller));
    assert.match(text, /Not recorded — refused by policy/);
    assert.match(text, /APPROVAL_APPROVER_INELIGIBLE/);
    assert.equal(/Approval recorded/.test(text), false);
  });

  it('a double activation sends one challenge and one submission', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolvePromise) => {
      release = resolvePromise;
    });
    const { controller, calls } = await signedInAt({ decisionChallenge: async () => (await gate, challenge('approve')), submitDecision: async () => ({ outcome: 'recorded', commitment: COMMITMENT, verdict: 'approve', approvalRequestId: REQUEST_ID, requestStatus: 'approved', execution: 'not_observed' }), decisionStatus: async () => status('approved', 'approved') });
    await controller.openRequest(REQUEST_ID);
    controller.chooseVerdict('approve');
    const first = controller.confirmDecision();
    const second = controller.confirmDecision();
    release();
    await Promise.all([first, second]);
    assert.equal(calls.filter((call) => call.name === 'decisionChallenge').length, 1);
    assert.equal(calls.filter((call) => call.name === 'submitDecision').length, 1);
  });

  it('a lost submission response reads the status — it never resubmits the assertion', async () => {
    const { controller, calls } = await signedInAt({ decisionChallenge: async () => challenge('approve'), submitDecision: async () => { throw new AuthorityApiError(0, 'NETWORK_UNAVAILABLE', 'x'); }, decisionStatus: async () => status('approved', 'approved') });
    await controller.openRequest(REQUEST_ID);
    controller.chooseVerdict('approve');
    await controller.confirmDecision();
    assert.equal(calls.filter((call) => call.name === 'submitDecision').length, 1);
    assert.deepEqual(calls.filter((call) => call.name === 'decisionStatus').map((call) => call.args[0]), [COMMITMENT]);
    assert.match(textOf(view(controller)), /Approval recorded/);
  });

  it('an already-used decision reads the status; an unreadable status says so and offers a read, not a resubmission', async () => {
    let reachable = false;
    const { controller, calls } = await signedInAt({
      decisionChallenge: async () => challenge('approve'),
      submitDecision: async () => { throw new AuthorityApiError(409, 'HUMAN_IDENTITY_DECISION_CHALLENGE_CONSUMED', 'x', COMMITMENT); },
      decisionStatus: async () => {
        if (!reachable) throw new AuthorityApiError(503, 'AUTHORITY_FRESHNESS_UNAVAILABLE', 'x');
        return status('unsettled');
      },
    });
    await controller.openRequest(REQUEST_ID);
    controller.chooseVerdict('approve');
    await controller.confirmDecision();
    assert.equal(controller.state().outcomeUnknown, true);
    assert.match(textOf(view(controller)), /Checking the outcome/);
    reachable = true;
    await controller.checkStatus();
    assert.match(textOf(view(controller)), /Being confirmed/);
    assert.equal(calls.filter((call) => call.name === 'submitDecision').length, 1);
    assert.ok(button(view(controller), 'Check status'));
  });

  it('every gateway decision state has its own label, and abandoned and unsettled are never success', () => {
    for (const state of ['challenge_open', 'challenge_expired', 'approved', 'rejected', 'refused', 'abandoned', 'unsettled', 'unknown'] as const) assert.ok(DECISION_LABELS[state].label.length > 0, state);
    assert.match(DECISION_LABELS.abandoned.label, /Not recorded/);
    assert.notEqual(DECISION_LABELS.abandoned.tone, 'success');
    assert.notEqual(DECISION_LABELS.unsettled.tone, 'success');
    assert.notEqual(DECISION_LABELS.challenge_open.tone, 'success');
    assert.throws(() => parseStatus({ commitment: COMMITMENT, approvalRequestId: REQUEST_ID, verdict: 'approve', decision: 'executed', request: null, execution: 'not_observed' }), /not a known state/);
  });

  it('contract parsing refuses a malformed detail rather than rendering a partial subject', () => {
    assert.throws(() => parseDetail({ ...detail(), canonicalSubject: 42 }), /canonicalSubject/);
    assert.throws(() => parseDetail({ ...detail(), subject: { ...detail().subject, parameters: [{ dimension: 'x', type: 't', value: {} }] } }), /parameters/);
  });
});

// ── Codec and accessibility ───────────────────────────────────────────────────────

describe('AUTH-04C client — WebAuthn codec and accessibility', () => {
  it('base64url round-trips; the user handle is decoded as bytes; responses carry only the fields AUTH-02 accepts', () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255]);
    assert.deepEqual([...base64urlToBytes(bytesToBase64url(bytes))], [...bytes]);
    const handle = bytesToBase64url(new Uint8Array(32).fill(7));
    const creation = toCreationOptions({ rp: { id: 'authority.frontera-systems.com', name: 'Frontera Authority' }, user: { id: handle, name: 'approver-a', displayName: 'CTO' }, challenge: 'AAEC', pubKeyCredParams: [{ type: 'public-key', alg: -7 }], timeout: 300000, attestation: 'none', excludeCredentials: [], authenticatorSelection: { residentKey: 'required', requireResidentKey: true, userVerification: 'required' } });
    assert.equal(bytesToBase64url(creation.user.id as ArrayBuffer), handle);
    assert.equal(creation.authenticatorSelection?.userVerification, 'required');
    assert.equal(toRequestOptions(OPTIONS).userVerification, 'required');
    const buffer = (values: number[]): ArrayBuffer => new Uint8Array(values).buffer;
    const assertion = assertionJSON({ id: 'AQI', rawId: buffer([1, 2]), type: 'public-key', response: { clientDataJSON: buffer([3]), authenticatorData: buffer([4]), signature: buffer([5]), userHandle: buffer([6]) } });
    assert.deepEqual(Object.keys(assertion).sort(), ['clientExtensionResults', 'id', 'rawId', 'response', 'type']);
    assert.deepEqual(Object.keys(assertion['response'] as object).sort(), ['authenticatorData', 'clientDataJSON', 'signature', 'userHandle']);
    const registration = registrationJSON({ id: 'AQI', rawId: buffer([1, 2]), type: 'public-key', response: { clientDataJSON: buffer([3]), attestationObject: buffer([7]), getTransports: () => ['internal', 'hybrid', 'bogus'] } });
    assert.deepEqual((registration['response'] as { transports: string[] }).transports, ['internal', 'hybrid']);
    assert.equal(classifyPasskeyError({ name: 'NotAllowedError' }).failure, 'cancelled');
    assert.equal(classifyPasskeyError({ name: 'NotSupportedError' }).failure, 'unsupported');
    assert.equal(classifyPasskeyError({ name: 'SecurityError' }).failure, 'security');
  });

  it('every screen has one focusable heading, named controls, a live region, and labelled landmarks', async () => {
    const screens: VElement[] = [];
    const harness = await signedInAt({ decisionChallenge: async () => challenge('approve'), submitDecision: async () => ({ outcome: 'recorded', commitment: COMMITMENT, verdict: 'approve', approvalRequestId: REQUEST_ID, requestStatus: 'approved', execution: 'not_observed' }), decisionStatus: async () => status('approved', 'approved') });
    screens.push(view(harness.controller));
    await harness.controller.openRequest(REQUEST_ID);
    screens.push(view(harness.controller));
    harness.controller.chooseVerdict('approve');
    screens.push(view(harness.controller));
    await harness.controller.confirmDecision();
    screens.push(view(harness.controller));
    const signedOut = controllerWith({ session: unauthenticated });
    await signedOut.controller.start();
    screens.push(view(signedOut.controller));
    signedOut.controller.showEnrolment();
    screens.push(view(signedOut.controller));
    for (const tree of screens) {
      const headings = findAll(tree, (element) => element.tag === 'h1');
      assert.equal(headings.length, 1, 'exactly one h1');
      assert.equal(headings[0]?.attributes['data-focus'], 'screen');
      assert.equal(headings[0]?.attributes.tabindex, '-1');
      for (const control of buttons(tree)) assert.ok(textOf(control).trim().length > 0 || (control.attributes['aria-label'] ?? '').length > 0, 'every button has a name');
      for (const control of buttons(tree)) assert.ok(control.attributes.type === 'button' || control.attributes.type === 'submit');
      assert.equal(findAll(tree, (element) => element.tag === 'main').length, 1);
      assert.equal(findAll(tree, (element) => element.attributes['aria-live'] === 'polite').length >= 1, true, 'a polite live region exists');
    }
  });

  it('the shell and stylesheet are mobile-first: safe areas, zoom allowed, 44px+ targets, wrapping, reduced motion, no inline code', () => {
    const html = readFileSync('apps/authority-web/index.html', 'utf8');
    const css = readFileSync('apps/authority-web/styles.css', 'utf8');
    assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" \/>/);
    assert.equal(/maximum-scale|user-scalable/.test(html), false, 'pinch zoom is never disabled');
    assert.match(html, /<html lang="en">/);
    assert.equal(/<script(?![^>]*\bsrc=)[^>]*>/.test(html), false, 'no inline script');
    assert.equal(/\son[a-z]+=|style=|<style/.test(html), false, 'no inline handlers or styles');
    assert.equal(/https?:\/\//.test(html), false, 'no external resource');
    for (const pattern of [/env\(safe-area-inset-top\)/, /env\(safe-area-inset-bottom\)/, /--touch: 48px/, /min-height: var\(--touch\)/, /overflow-wrap: anywhere/, /overflow-x: hidden/, /prefers-reduced-motion: reduce/, /font: -apple-system-body/, /:focus-visible/, /@media \(min-width: 40rem\)/, /orientation: landscape/]) assert.match(css, pattern);
    assert.equal(/@import|url\(/.test(css), false, 'no external stylesheet or asset');
  });
});
