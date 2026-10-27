import {
  ContractError,
  parseChallenge,
  parseCreationOptions,
  parseDetail,
  parseError,
  parseInbox,
  parseLoginOptions,
  parseSession,
  parseStatus,
  parseSubmission,
  type ApprovalDetail,
  type ApprovalSummary,
  type AssertionOptionsJSON,
  type CreationOptionsJSON,
  type DecisionChallenge,
  type DecisionStatus,
  type DecisionSubmission,
  type SessionInfo,
  type Verdict,
} from './contracts.js';

/**
 * AUTH-04C — the Authority gateway client.
 *
 * Paths are relative to the page's own origin (`/authority/v1/…`): the client
 * only ever talks to the origin that served it, through the same trusted
 * Authority origin (see the AUTH-04C same-origin topology). The session lives
 * in the gateway's `__Host-` HttpOnly cookie, which this code cannot read; the
 * CSRF token is held in memory only and sent as `x-frontera-csrf-token`. No
 * bearer, no token in a URL, nothing in browser storage.
 */

export const API_PREFIX = '/authority/v1';
export const CSRF_HEADER = 'x-frontera-csrf-token';

export interface TransportResponse {
  readonly status: number;
  readonly body: unknown;
}

/** One HTTP exchange with the Authority origin. The browser transport is `fetch` with same-origin credentials. */
export type Transport = (method: 'GET' | 'POST', path: string, body: unknown, csrfToken: string | undefined) => Promise<TransportResponse>;

/** A refusal or failure the gateway reported, or a transport failure (`status` 0). */
export class AuthorityApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly commitment: string | null = null,
  ) {
    super(message);
    this.name = 'AuthorityApiError';
  }
}

export interface AuthorityApi {
  loginOptions(): Promise<AssertionOptionsJSON>;
  login(assertion: unknown): Promise<SessionInfo>;
  session(): Promise<SessionInfo>;
  logout(csrfToken: string): Promise<void>;
  inbox(): Promise<readonly ApprovalSummary[]>;
  approval(approvalRequestId: string): Promise<ApprovalDetail>;
  decisionChallenge(approvalRequestId: string, subjectDigest: string, verdict: Verdict, csrfToken: string): Promise<DecisionChallenge>;
  submitDecision(assertion: unknown, csrfToken: string): Promise<DecisionSubmission>;
  decisionStatus(commitment: string): Promise<DecisionStatus>;
  enrolmentOptions(invitation: string): Promise<CreationOptionsJSON>;
  enrol(invitation: string, credential: unknown): Promise<void>;
}

/** The browser transport: same-origin fetch, cookies included, JSON in and out. */
export function fetchTransport(fetchImpl: typeof fetch): Transport {
  return async (method, path, body, csrfToken) => {
    let response: Response;
    try {
      response = await fetchImpl(path, {
        method,
        credentials: 'same-origin',
        cache: 'no-store',
        redirect: 'error',
        headers: {
          accept: 'application/json',
          ...(method === 'POST' ? { 'content-type': 'application/json' } : {}),
          ...(csrfToken !== undefined ? { [CSRF_HEADER]: csrfToken } : {}),
        },
        ...(method === 'POST' ? { body: JSON.stringify(body ?? {}) } : {}),
      });
    } catch {
      throw new AuthorityApiError(0, 'NETWORK_UNAVAILABLE', 'The Authority service could not be reached.');
    }
    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch {
      parsed = undefined;
    }
    return { status: response.status, body: parsed };
  };
}

export function createAuthorityApi(transport: Transport): AuthorityApi {
  async function exchange<T>(method: 'GET' | 'POST', path: string, body: unknown, csrfToken: string | undefined, parse: (value: unknown) => T, accept: readonly number[] = [200]): Promise<T> {
    const response = await transport(method, `${API_PREFIX}${path}`, body, csrfToken);
    if (!accept.includes(response.status)) {
      const error = parseError(response.body);
      throw new AuthorityApiError(response.status, error?.code ?? 'UNEXPECTED_RESPONSE', error?.message ?? 'The Authority service answered unexpectedly.', error?.commitment ?? null);
    }
    try {
      return parse(response.body);
    } catch (error) {
      if (error instanceof ContractError) throw new AuthorityApiError(response.status, 'CONTRACT_VIOLATION', `The Authority service answered in an unexpected shape (${error.message}).`);
      throw error;
    }
  }
  const segment = (value: string): string => encodeURIComponent(value);
  const nothing = (): void => undefined;

  return Object.freeze<AuthorityApi>({
    loginOptions: () => exchange('POST', '/session/login/options', {}, undefined, parseLoginOptions),
    login: (assertion) => exchange('POST', '/session/login', { assertion }, undefined, parseSession),
    session: () => exchange('GET', '/session', undefined, undefined, parseSession),
    logout: (csrfToken) => exchange('POST', '/session/logout', {}, csrfToken, nothing),
    inbox: () => exchange('GET', '/approvals', undefined, undefined, parseInbox),
    approval: (approvalRequestId) => exchange('GET', `/approvals/${segment(approvalRequestId)}`, undefined, undefined, parseDetail),
    decisionChallenge: (approvalRequestId, subjectDigest, verdict, csrfToken) => exchange('POST', `/approvals/${segment(approvalRequestId)}/decision-challenges`, { subjectDigest, verdict }, csrfToken, parseChallenge),
    // 409 carries a structured refusal (`outcome: refused`) — parsed, not thrown. Any other 409 (e.g. consumed) is an error body and throws.
    submitDecision: async (assertion, csrfToken) => {
      const response = await transport('POST', `${API_PREFIX}/decisions`, { assertion }, csrfToken);
      if (response.status === 200 || (response.status === 409 && typeof response.body === 'object' && response.body !== null && (response.body as { outcome?: unknown }).outcome === 'refused')) {
        try {
          return parseSubmission(response.body);
        } catch (error) {
          if (error instanceof ContractError) throw new AuthorityApiError(response.status, 'CONTRACT_VIOLATION', `The Authority service answered in an unexpected shape (${error.message}).`);
          throw error;
        }
      }
      const error = parseError(response.body);
      throw new AuthorityApiError(response.status, error?.code ?? 'UNEXPECTED_RESPONSE', error?.message ?? 'The Authority service answered unexpectedly.', error?.commitment ?? null);
    },
    decisionStatus: (commitment) => exchange('GET', `/decisions/${segment(commitment)}`, undefined, undefined, parseStatus),
    enrolmentOptions: (invitation) => exchange('POST', '/enrolment/options', { invitation }, undefined, parseCreationOptions),
    enrol: (invitation, credential) => exchange('POST', '/enrolment', { invitation, credential }, undefined, nothing, [201]),
  });
}
