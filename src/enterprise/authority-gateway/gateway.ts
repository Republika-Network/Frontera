import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { canonicalApprovalSubject } from '../approval-authority/subject.js';
import { HumanDecisionError } from '../approval-authority/human-decision.js';
import { AuthorityStateFreshnessError } from '../authority-state-freshness/errors.js';
import type { HumanAuthorityInboxEntry, HumanAuthorityPort } from '../composition/human-authority-composition.js';
import { HumanIdentityError } from '../human-identity/contracts.js';
import type { EnterpriseLogger } from '../telemetry/enterprise-logger.js';
import { createAuthoritySessionStore, rememberIssued, tokensEqual, type AuthoritySession, type AuthoritySessionStore } from './session.js';

/**
 * AUTH-04B — the Authority gateway: the smallest HTTP boundary through which a
 * human approver (Safari on an iPhone, through a future phone-first UI) signs
 * in with a passkey, reads only the approval requests they may act on, and
 * submits fresh, request-bound WebAuthn decisions.
 *
 * It is **its own listener** in the Host process — never a route of the Host
 * API — and exists only when `AOC_ENTERPRISE_AUTHORITY_GATEWAY_MODE=enabled`.
 * It owns no approval logic: it reaches the in-process human-decision port
 * (`enterprise.humanAuthority`, AUTH-04A) and nothing else.
 *
 * ```
 * A  human authentication     POST /authority/v1/session/login/options → /session/login   (AUTH-02 passkey recognition)
 * B  session establishment    new opaque id on every login (rotation) · __Host- cookie · HttpOnly · Secure · SameSite=Strict
 * C  read authorization       GET  /authority/v1/approvals[/:id]  — scoped server-side to the session's human (inbox)
 * D  per-decision WebAuthn    POST /authority/v1/approvals/:id/decision-challenges → POST /authority/v1/decisions
 * E  CORE-05 command          only through the AUTH-03 channel, after its own verification — never from a session
 * F  evidence / status        GET  /authority/v1/decisions/:commitment — read-only, the caller's own decisions only
 * ```
 *
 * Every request: the `Host` header must be the public origin's host; any
 * `Authorization` header is refused (no bearer — operator or otherwise — means
 * anything here). Every state-changing request: `Origin` must equal the public
 * origin, the body must be `application/json` with a closed set of fields, and
 * (once signed in) the per-session CSRF token must be presented. Responses
 * carry no secret, no store path and no administrative metadata.
 */

export interface AuthorityGatewayOptions {
  readonly authority: HumanAuthorityPort;
  /** The exact public https origin browsers use (`https://authority.frontera-systems.com`). */
  readonly publicOrigin: string;
  readonly sessionTtlSeconds: number;
  readonly sessionIdleSeconds: number;
  /** The login ceremony lifetime — the AUTH-02 authentication challenge's own lifetime. */
  readonly loginTtlSeconds: number;
  readonly logger: EnterpriseLogger;
  /** Monotonic milliseconds, for session lifetimes. Default `performance.now()`. */
  readonly now?: () => number;
}

export interface AuthorityGateway {
  handle(req: IncomingMessage, res: ServerResponse): Promise<void>;
  listen(host: string, port: number): Promise<{ readonly host: string; readonly port: number }>;
  address(): { readonly host: string; readonly port: number } | undefined;
  close(): Promise<void>;
  /** Live sessions (for health and tests). Never their contents. */
  sessionCount(): number;
}

export const AUTHORITY_SESSION_COOKIE = '__Host-frontera_authority_session';
export const AUTHORITY_LOGIN_COOKIE = '__Host-frontera_authority_login';
export const AUTHORITY_CSRF_HEADER = 'x-frontera-csrf-token';
const PREFIX = '/authority/v1';
const MAX_BODY_BYTES = 64 * 1024;
const APPROVAL_REQUEST_ID = /^approval-request:[0-9a-f]{64}$/;
const SHA256 = /^sha256:[0-9a-f]{64}$/;

export const AUTHORITY_SECURITY_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'content-type': 'application/json; charset=utf-8',
  'content-security-policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  'x-frame-options': 'DENY',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'strict-transport-security': 'max-age=31536000',
  'cache-control': 'no-store',
  pragma: 'no-cache',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
});

class GatewayError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly extra: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = 'GatewayError';
  }
}

function cookie(name: string, value: string, maxAgeSeconds: number): string {
  // __Host-: Secure, Path=/, no Domain — no sibling host can plant or overwrite it.
  return `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${String(maxAgeSeconds)}`;
}

function readCookie(req: IncomingMessage, name: string): string | undefined {
  const header = req.headers.cookie;
  if (typeof header !== 'string') return undefined;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index > 0 && part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A closed JSON body: exactly the named fields may appear. A caller-chosen operator or organization is refused, never ignored. */
async function readJson(req: IncomingMessage, fields: readonly string[]): Promise<Record<string, unknown>> {
  const contentType = req.headers['content-type'];
  if (typeof contentType !== 'string' || !/^application\/json\s*(?:;.*)?$/i.test(contentType)) throw new GatewayError(415, 'AUTHORITY_REQUEST_INVALID', 'Requests are application/json.');
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    total += buffer.length;
    if (total > MAX_BODY_BYTES) throw new GatewayError(413, 'AUTHORITY_REQUEST_INVALID', 'The request body is too large.');
    chunks.push(buffer);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new GatewayError(400, 'AUTHORITY_REQUEST_INVALID', 'The request body is not JSON.');
  }
  if (!isRecord(parsed)) throw new GatewayError(400, 'AUTHORITY_REQUEST_INVALID', 'The request body must be a JSON object.');
  for (const key of Object.keys(parsed)) {
    if (!fields.includes(key)) throw new GatewayError(400, 'AUTHORITY_REQUEST_INVALID', `The field '${key}' is not accepted here; who acts and for which organization come only from the session and the Host.`);
  }
  return parsed;
}

const sha256 = (text: string): string => `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;

/** The challenge an assertion's client data names, read only to bind a login to the ceremony this browser started. Verification is AUTH-02's. */
function clientDataChallengeOf(assertion: unknown): string | undefined {
  if (!isRecord(assertion) || !isRecord(assertion['response'])) return undefined;
  const clientDataJSON = assertion['response']['clientDataJSON'];
  if (typeof clientDataJSON !== 'string') return undefined;
  try {
    const clientData = JSON.parse(Buffer.from(clientDataJSON, 'base64url').toString('utf8')) as unknown;
    return isRecord(clientData) && typeof clientData['challenge'] === 'string' ? clientData['challenge'] : undefined;
  } catch {
    return undefined;
  }
}

function summary(entry: HumanAuthorityInboxEntry): Record<string, unknown> {
  const { view } = entry;
  return {
    approvalRequestId: view.approvalRequestId,
    status: view.state.status,
    action: view.subject.action,
    resourceScope: view.subject.resourceScope,
    governanceProfile: view.subject.governanceProfile,
    requestedAt: view.requestedAt,
    requestExpiresAt: view.state.requestExpiresAt,
    subjectDigest: view.subjectDigest,
    quorum: { minimumApprovals: view.state.minimumApprovals, counted: view.state.approvers.length },
    verdicts: [...entry.verdicts],
  };
}

function detail(entry: HumanAuthorityInboxEntry): Record<string, unknown> {
  const { view } = entry;
  const canonicalSubject = canonicalApprovalSubject(view.subject);
  // The exact bytes the subject digest covers; a mismatch is never shown as if it were the subject.
  if (sha256(canonicalSubject) !== view.subjectDigest) throw new GatewayError(500, 'AUTHORITY_STATE_INTEGRITY_FAILED', 'The approval subject could not be verified.');
  const subject = view.subject;
  return {
    ...summary(entry),
    canonicalSubject,
    subject: {
      actorId: subject.actorId,
      principalActorId: subject.principalActorId ?? null,
      action: subject.action,
      resourceScope: subject.resourceScope,
      counterpartyId: subject.counterpartyId ?? null,
      amount: subject.amount ?? null,
      parameters: subject.parameters ?? [],
      governanceProfile: subject.governanceProfile,
      decision: { status: subject.decision.status, reasonCodes: [...subject.decision.reasonCodes], evaluatedAt: subject.decision.evaluatedAt },
      contextValidUntil: subject.contextValidUntil ?? null,
    },
    requirement: { minimumApprovals: subject.requirement.minimumApprovals, requestTtlSeconds: subject.requirement.requestTtlSeconds, approvalValiditySeconds: subject.requirement.approvalValiditySeconds, requiredEvidence: [...(subject.requirement.requiredEvidence ?? [])] },
  };
}

/** Closed mapping of identity / decision / freshness refusals to HTTP. Messages are the modules' own (they name rules, never values). */
function refusalOf(error: unknown): GatewayError | undefined {
  if (error instanceof GatewayError) return error;
  if (error instanceof HumanIdentityError) {
    const status: Readonly<Record<string, number>> = {
      HUMAN_IDENTITY_CHALLENGE_INVALID: 400,
      HUMAN_IDENTITY_AUTHENTICATION_INVALID: 401,
      HUMAN_IDENTITY_CREDENTIAL_UNUSABLE: 403,
      HUMAN_IDENTITY_CREDENTIAL_OWNERSHIP_MISMATCH: 403,
      HUMAN_IDENTITY_COUNTER_REGRESSION: 403,
      HUMAN_IDENTITY_PRINCIPAL_REVOKED: 403,
      HUMAN_IDENTITY_UNKNOWN_PRINCIPAL: 403,
      HUMAN_IDENTITY_DECISION_CHALLENGE_CONSUMED: 409,
      HUMAN_IDENTITY_STORE_UNAVAILABLE: 503,
    };
    return new GatewayError(status[error.code] ?? 503, error.code, error.message);
  }
  if (error instanceof HumanDecisionError) return new GatewayError(error.code === 'HUMAN_DECISION_NOT_PERMITTED' ? 403 : 409, error.code, error.message);
  if (error instanceof AuthorityStateFreshnessError) return new GatewayError(503, 'AUTHORITY_FRESHNESS_UNAVAILABLE', 'Authority state freshness could not be established; nothing is decided while it cannot.');
  return undefined;
}

export function createAuthorityGateway(options: AuthorityGatewayOptions): AuthorityGateway {
  const { authority, logger } = options;
  const publicOrigin = new URL(options.publicOrigin);
  if (publicOrigin.protocol !== 'https:' || publicOrigin.origin !== options.publicOrigin) throw new Error('createAuthorityGateway: the public origin must be an exact https origin.');
  if (!authority.relyingParty.allowedOrigins.includes(options.publicOrigin)) throw new Error('createAuthorityGateway: the public origin must be one of the relying party\'s allowed origins.');
  const sessionTtlSeconds = options.sessionTtlSeconds;
  const sessions: AuthoritySessionStore = createAuthoritySessionStore({
    absoluteTtlMs: sessionTtlSeconds * 1000,
    idleTtlMs: options.sessionIdleSeconds * 1000,
    loginTtlMs: options.loginTtlSeconds * 1000,
    ...(options.now !== undefined ? { now: options.now } : {}),
  });

  const send = (res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string | string[]>> = {}): void => {
    res.writeHead(status, { ...AUTHORITY_SECURITY_HEADERS, ...headers });
    res.end(status === 204 ? undefined : JSON.stringify(body));
  };

  /** The live session of this request, re-validated against the identity store: a revoked human or credential ends it. */
  function sessionOf(req: IncomingMessage): AuthoritySession {
    const session = sessions.get(readCookie(req, AUTHORITY_SESSION_COOKIE));
    if (session === undefined) throw new GatewayError(401, 'AUTHORITY_SESSION_REQUIRED', 'Sign in with your passkey.');
    const human = authority.identity.principal(session.operatorId);
    const credential = authority.identity.credentialsOf(session.operatorId).find((candidate) => candidate.credentialId === session.credentialId);
    if (human?.state !== 'active' || credential?.state !== 'active') {
      sessions.destroyHuman(session.operatorId);
      throw new GatewayError(401, 'AUTHORITY_SESSION_REVOKED', 'This session ended: the human or the passkey it was opened with is no longer active.');
    }
    return session;
  }

  function requireCsrf(req: IncomingMessage, session: AuthoritySession): void {
    const presented = req.headers[AUTHORITY_CSRF_HEADER];
    if (typeof presented !== 'string' || !tokensEqual(presented, session.csrfToken)) throw new GatewayError(403, 'AUTHORITY_CSRF_INVALID', 'The request is not from this session.');
  }

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Every request: addressed to the Authority host, and carrying no bearer of any kind.
    if (req.headers.host !== publicOrigin.host) throw new GatewayError(421, 'AUTHORITY_HOST_INVALID', 'This boundary answers only on the Authority origin.');
    if (req.headers.authorization !== undefined) throw new GatewayError(400, 'AUTHORITY_BEARER_REFUSED', 'This boundary takes no Authorization header: sign in with your passkey.');
    const method = req.method ?? 'GET';
    const path = new URL(req.url ?? '/', publicOrigin).pathname;
    if (!path.startsWith(`${PREFIX}/`)) throw new GatewayError(404, 'AUTHORITY_NOT_FOUND', 'No such Authority resource.');
    if (method !== 'GET' && method !== 'POST') throw new GatewayError(405, 'AUTHORITY_METHOD_NOT_ALLOWED', 'Only GET and POST are served.');
    if (method === 'POST' && req.headers.origin !== publicOrigin.origin) throw new GatewayError(403, 'AUTHORITY_ORIGIN_INVALID', 'State-changing requests must come from the Authority origin.');
    const segments = path.slice(PREFIX.length + 1).split('/').map((segment) => decodeURIComponent(segment));

    // ── A/B: sign-in, session, sign-out ──────────────────────────────────────────
    if (segments.join('/') === 'session/login/options' && method === 'POST') {
      await readJson(req, []);
      const publicKey = authority.identity.beginAuthentication();
      const ceremony = sessions.beginLogin(publicKey.challenge);
      return send(res, 200, { publicKey }, { 'set-cookie': cookie(AUTHORITY_LOGIN_COOKIE, ceremony.nonce, options.loginTtlSeconds) });
    }
    if (segments.join('/') === 'session/login' && method === 'POST') {
      const body = await readJson(req, ['assertion']);
      // The ceremony this browser started, one-shot: a login answers only the challenge issued to this browser.
      const ceremony = sessions.takeLogin(readCookie(req, AUTHORITY_LOGIN_COOKIE));
      const clearLogin = cookie(AUTHORITY_LOGIN_COOKIE, '', 0);
      if (ceremony === undefined || clientDataChallengeOf(body['assertion']) !== ceremony.challenge) {
        throw new GatewayError(401, 'AUTHORITY_LOGIN_INVALID', 'This sign-in does not answer the ceremony this browser started.', { setCookie: clearLogin });
      }
      const human = await authority.identity.finishAuthentication(body['assertion']);
      // Rotation: a pre-existing session (or a planted id) is never carried across a sign-in.
      sessions.destroy(readCookie(req, AUTHORITY_SESSION_COOKIE));
      const session = sessions.create(human.operatorId, human.credentialId);
      logger.info('authority.session.created', { organizationId: authority.organizationId, status: 'signed-in' });
      return send(res, 200, { operatorId: human.operatorId, displayName: authority.identity.principal(human.operatorId)?.displayName ?? human.operatorId, organizationId: authority.organizationId, csrfToken: session.csrfToken, expiresInSeconds: sessionTtlSeconds }, { 'set-cookie': [cookie(AUTHORITY_SESSION_COOKIE, session.id, sessionTtlSeconds), clearLogin] });
    }
    if (segments.join('/') === 'session' && method === 'GET') {
      const session = sessionOf(req);
      return send(res, 200, { operatorId: session.operatorId, displayName: authority.identity.principal(session.operatorId)?.displayName ?? session.operatorId, organizationId: authority.organizationId, csrfToken: session.csrfToken });
    }
    if (segments.join('/') === 'session/logout' && method === 'POST') {
      const session = sessionOf(req);
      requireCsrf(req, session);
      await readJson(req, []);
      sessions.destroy(session.id);
      return send(res, 200, { signedOut: true }, { 'set-cookie': cookie(AUTHORITY_SESSION_COOKIE, '', 0) });
    }

    // ── C: the human's own inbox ─────────────────────────────────────────────────
    if (segments[0] === 'approvals' && segments.length === 1 && method === 'GET') {
      const session = sessionOf(req);
      return send(res, 200, { approvals: (await authority.inbox.eligible(session.operatorId)).map(summary) });
    }
    if (segments[0] === 'approvals' && segments.length === 2 && method === 'GET') {
      const session = sessionOf(req);
      const id = segments[1] ?? '';
      const entry = APPROVAL_REQUEST_ID.test(id) ? await authority.inbox.entry(session.operatorId, id) : undefined;
      // Absent, closed, superseded or not this human's to decide: one answer, so nothing is enumerable.
      if (entry === undefined) throw new GatewayError(404, 'AUTHORITY_NOT_FOUND', 'No such approval request awaits you.');
      return send(res, 200, detail(entry));
    }

    // ── D: per-decision WebAuthn ─────────────────────────────────────────────────
    if (segments[0] === 'approvals' && segments.length === 3 && segments[2] === 'decision-challenges' && method === 'POST') {
      const session = sessionOf(req);
      requireCsrf(req, session);
      const body = await readJson(req, ['subjectDigest', 'verdict']);
      const id = segments[1] ?? '';
      const subjectDigest = body['subjectDigest'];
      const verdict = body['verdict'];
      if (typeof subjectDigest !== 'string' || !SHA256.test(subjectDigest) || (verdict !== 'approve' && verdict !== 'reject')) throw new GatewayError(400, 'AUTHORITY_REQUEST_INVALID', 'A decision names the exact subject digest and approve or reject.');
      const entry = APPROVAL_REQUEST_ID.test(id) ? await authority.inbox.entry(session.operatorId, id) : undefined;
      if (entry === undefined) throw new GatewayError(404, 'AUTHORITY_NOT_FOUND', 'No such approval request awaits you.');
      if (!entry.verdicts.includes(verdict)) throw new GatewayError(403, 'HUMAN_DECISION_NOT_PERMITTED', `Your role or standing does not reach the ${verdict} verdict on this request.`);
      if (entry.view.subjectDigest !== subjectDigest) throw new GatewayError(409, 'HUMAN_DECISION_NOT_APPLICABLE', 'The request no longer has that subject; re-read it.');
      // The human is the session's; the organization is the Host's. AUTH-03 binds both into the challenge.
      const issued = await authority.decisions.begin({ operatorId: session.operatorId, approvalRequestId: id, subjectDigest, verdict });
      rememberIssued(session, issued.commitment);
      return send(res, 200, { publicKey: issued.options, commitment: issued.commitment, approvalRequestId: id, subjectDigest, verdict, expiresAt: issued.contract.expiresAt });
    }
    if (segments.join('/') === 'decisions' && method === 'POST') {
      const session = sessionOf(req);
      requireCsrf(req, session);
      const body = await readJson(req, ['assertion']);
      const { contract, commitment } = authority.identity.peekDecision(body['assertion']);
      // Only a decision issued to this very session, for this very human. A session never decides by itself.
      if (contract.operatorId !== session.operatorId || !session.issued.has(commitment)) throw new GatewayError(403, 'AUTHORITY_DECISION_NOT_YOURS', 'This decision was not issued to this session.');
      // A retry after a lost response: the decision was already used. Its outcome is read, never re-decided.
      if (authority.identity.decision(commitment)?.state === 'consumed') {
        throw new GatewayError(409, 'HUMAN_IDENTITY_DECISION_CHALLENGE_CONSUMED', 'This decision was already used; read its status.', { commitment, status: `${PREFIX}/decisions/${encodeURIComponent(commitment)}` });
      }
      let result: Awaited<ReturnType<HumanAuthorityPort['decisions']['decide']>>;
      try {
        result = await authority.decisions.decide(body['assertion']);
      } catch (error) {
        const refusal = refusalOf(error);
        // Anything else: whether CORE-05 recorded it is unknown here; the status is read, never guessed.
        throw refusal ?? new GatewayError(503, 'AUTHORITY_DECISION_OUTCOME_UNKNOWN', 'Whether this decision was recorded is unknown; read its status.', { commitment });
      }
      if (result.outcome === 'recorded') {
        return send(res, 200, { outcome: 'recorded', commitment, verdict: contract.verdict, approvalRequestId: contract.approvalRequestId, approval: { status: result.approval.state.status }, execution: 'not_observed' });
      }
      return send(res, 409, { outcome: 'refused', commitment, code: result.code, reasonCode: result.reasonCode });
    }

    // ── F: status of the caller's own decision ───────────────────────────────────
    if (segments[0] === 'decisions' && segments.length === 2 && method === 'GET') {
      const session = sessionOf(req);
      const commitment = segments[1] ?? '';
      const decision = SHA256.test(commitment) ? authority.identity.decision(commitment) : undefined;
      if (decision === undefined || decision.contract.operatorId !== session.operatorId) throw new GatewayError(404, 'AUTHORITY_NOT_FOUND', 'No such decision of yours.');
      const status = await authority.decisions.outcome(commitment);
      const request = await authority.inbox.requestState(decision.contract.approvalRequestId);
      const state =
        status === undefined
          ? 'unknown'
          : status.state === 'issued'
            ? 'challenge_open'
            : status.state === 'expired'
              ? 'challenge_expired'
              : status.state === 'recorded'
                ? decision.contract.verdict === 'approve'
                  ? 'approved'
                  : 'rejected'
                : status.state === 'refused'
                  ? 'refused'
                  : status.decision.outcome?.outcome === 'abandoned'
                    ? 'abandoned'
                    : 'unsettled';
      return send(res, 200, {
        commitment,
        approvalRequestId: decision.contract.approvalRequestId,
        verdict: decision.contract.verdict,
        decision: state,
        ...(status?.state === 'refused' ? { code: status.code } : {}),
        request: request ?? null,
        // Authority never observes execution; it never reports one as confirmed.
        execution: 'not_observed',
      });
    }
    throw new GatewayError(404, 'AUTHORITY_NOT_FOUND', 'No such Authority resource.');
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      await route(req, res);
    } catch (error) {
      const refusal = refusalOf(error) ?? new GatewayError(503, 'AUTHORITY_UNAVAILABLE', 'Authority is unavailable; nothing was decided.');
      if (refusal.status >= 500) logger.error('authority.request.failed', { errorCode: refusal.code, httpStatus: refusal.status });
      const setCookie = refusal.extra['setCookie'];
      const { setCookie: _hidden, ...extra } = refusal.extra;
      if (!res.headersSent) send(res, refusal.status, { error: { code: refusal.code, message: refusal.message, ...extra } }, typeof setCookie === 'string' ? { 'set-cookie': setCookie } : {});
      else res.end();
    }
  }

  let server: Server | undefined;
  let bound: { readonly host: string; readonly port: number } | undefined;
  return {
    handle,
    async listen(host, port) {
      if (server !== undefined) throw new Error('The Authority gateway is already listening.');
      const created = createServer((req, res) => void handle(req, res));
      created.requestTimeout = 30_000;
      created.headersTimeout = 15_000;
      await new Promise<void>((resolvePromise, rejectPromise) => {
        created.once('error', rejectPromise);
        created.listen(port, host, () => resolvePromise());
      });
      server = created;
      const address = created.address() as AddressInfo;
      bound = { host: address.address, port: address.port };
      logger.info('authority.gateway.listening', { status: 'listening' });
      return bound;
    },
    address: () => bound,
    async close() {
      const current = server;
      server = undefined;
      bound = undefined;
      if (current === undefined) return;
      current.closeAllConnections();
      await new Promise<void>((resolvePromise) => current.close(() => resolvePromise()));
    },
    sessionCount: () => sessions.size(),
  };
}
