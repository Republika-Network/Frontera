import { EnterpriseHttpError, EnterpriseHttpErrors } from '../api/enterprise-http-errors.js';
import type { EnterpriseOperatorPrincipal, OperatorAuthenticator } from './operator-authenticator.js';

/**
 * AUTH-04B2 — passkey enrolment administration on the private operator plane.
 *
 * ```
 * Authorization header (CTRL-02 operator bearer)
 *   └─ OperatorAuthenticator.authorize(header, passkey-enrolment.administer)   401 / 403, before any body is read
 *       └─ organization-administrator only (a CTRL-01 legacy administrator never)
 *           └─ closed body                                                      400
 *               └─ the enrolment administration port (AUTH-02 service)
 *                    register a named human · issue / revoke a one-time invitation · read state
 * ```
 *
 * The bearer authenticates the **administrator** and nothing else: it is
 * never a human identity, never a passkey, never an enrolment credential, and
 * it never leaves this request — not into the invitation, the response, the
 * Authority gateway, a log or an audit payload. The invitation token is
 * returned **once**, to the administrator, for out-of-band delivery to the
 * named human; only its SHA-256 verifier is stored.
 *
 * Identity only: nothing here creates a role, an administrator, approval
 * standing, Kernel Authority, a policy or a capability.
 */

export const PASSKEY_ENROLMENT_PERMISSION = 'passkey-enrolment.administer' as const;

/** A refusal from the enrolment administration port, in closed codes. Never a secret. */
export class PasskeyEnrolmentRefusal extends Error {
  constructor(
    readonly code: string,
    readonly kind: 'invalid' | 'not-found' | 'refused' | 'unavailable',
    message: string,
  ) {
    super(message);
    this.name = 'PasskeyEnrolmentRefusal';
  }
}

export interface PasskeyEnrolmentHumanView {
  readonly operatorId: string;
  readonly displayName: string;
  readonly state: 'active' | 'revoked';
  readonly credentials: readonly { readonly credentialId: string; readonly state: 'active' | 'revoked'; readonly registeredAt: string }[];
  readonly invitations: readonly { readonly enrolmentId: string; readonly state: 'open' | 'consumed' | 'revoked' | 'expired'; readonly expiresAt: string }[];
}

export interface PasskeyEnrolmentInvitation {
  readonly enrolmentId: string;
  readonly operatorId: string;
  readonly expiresAt: string;
  /** Shown once. Deliver out of band, directly, to the named human. */
  readonly token: string;
}

/** What the composition provides: the AUTH-02 service, bound to the authenticated administrator principal. */
export interface PasskeyEnrolmentAdministrationPort {
  registerHuman(administrator: EnterpriseOperatorPrincipal, input: { readonly operatorId: string; readonly displayName: string }): Promise<PasskeyEnrolmentHumanView>;
  issueInvitation(administrator: EnterpriseOperatorPrincipal, operatorId: string): Promise<PasskeyEnrolmentInvitation>;
  revokeInvitation(administrator: EnterpriseOperatorPrincipal, enrolmentId: string, reason: string): Promise<{ readonly enrolmentId: string; readonly operatorId: string; readonly state: string }>;
  describeHuman(operatorId: string): Promise<PasskeyEnrolmentHumanView | undefined>;
}

export type OperatorBodyReader = () => Promise<unknown>;

export interface OperatorPasskeyEnrolmentService {
  registerHuman(authorizationHeader: string | undefined, readBody: OperatorBodyReader): Promise<{ readonly human: PasskeyEnrolmentHumanView }>;
  issueInvitation(authorizationHeader: string | undefined, readBody: OperatorBodyReader): Promise<{ readonly invitation: PasskeyEnrolmentInvitation; readonly delivery: string }>;
  revokeInvitation(authorizationHeader: string | undefined, enrolmentId: string, readBody: OperatorBodyReader): Promise<{ readonly invitation: { readonly enrolmentId: string; readonly operatorId: string; readonly state: string } }>;
  describeHuman(authorizationHeader: string | undefined, operatorId: string): Promise<{ readonly human: PasskeyEnrolmentHumanView }>;
}

const OPERATOR_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const ENROLMENT_ID = /^enr-[0-9a-f]{32}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A closed body: exactly the named fields. An organization, role, permission or authority field is refused, never ignored. */
async function closedBody(readBody: OperatorBodyReader, fields: readonly string[]): Promise<Record<string, unknown>> {
  const raw = await readBody();
  if (!isRecord(raw)) throw EnterpriseHttpErrors.invalidRequest('The request body must be a JSON object.');
  const unexpected = Object.keys(raw).filter((key) => !fields.includes(key));
  if (unexpected.length > 0) {
    throw EnterpriseHttpErrors.invalidRequest(`Unsupported field(s). Accepted: ${fields.join(', ')}. Enrolment grants no role, standing or authority, and the organization is the Host's.`, unexpected.slice(0, 8).map((key) => key.slice(0, 64)));
  }
  return raw;
}

function httpOf(error: unknown): unknown {
  if (!(error instanceof PasskeyEnrolmentRefusal)) return error;
  if (error.kind === 'invalid') return EnterpriseHttpErrors.invalidRequest(error.message);
  if (error.kind === 'not-found') return new EnterpriseHttpError(404, 'AUTHORITY_ADMIN_TARGET_NOT_FOUND', error.message);
  if (error.kind === 'unavailable') return new EnterpriseHttpError(503, 'AUTHORITY_STATE_UNAVAILABLE', 'The identity store is unavailable; whether the operation was recorded is unknown — read the human\'s state before retrying.');
  return new EnterpriseHttpError(409, 'OPERATOR_OPERATION_REFUSED', error.message, undefined, { failure: error.code, recorded: false });
}

export function createOperatorPasskeyEnrolmentService(dependencies: { readonly authenticator: OperatorAuthenticator; readonly port: PasskeyEnrolmentAdministrationPort }): OperatorPasskeyEnrolmentService {
  const { authenticator, port } = dependencies;
  const authorize = (header: string | undefined): EnterpriseOperatorPrincipal => authenticator.authorize(header, PASSKEY_ENROLMENT_PERMISSION);
  const operatorIdOf = (value: unknown): string => {
    if (typeof value !== 'string' || !OPERATOR_ID.test(value)) throw EnterpriseHttpErrors.invalidRequest('operatorId must name one configured operator.');
    return value;
  };
  const run = async <T>(work: () => Promise<T>): Promise<T> => {
    try {
      return await work();
    } catch (error) {
      throw httpOf(error);
    }
  };

  return Object.freeze<OperatorPasskeyEnrolmentService>({
    async registerHuman(header, readBody) {
      const administrator = authorize(header);
      const body = await closedBody(readBody, ['operatorId', 'displayName']);
      const operatorId = operatorIdOf(body['operatorId']);
      const displayName = body['displayName'];
      if (typeof displayName !== 'string') throw EnterpriseHttpErrors.invalidRequest('displayName must be a string.');
      return { human: await run(() => port.registerHuman(administrator, { operatorId, displayName })) };
    },
    async issueInvitation(header, readBody) {
      const administrator = authorize(header);
      const body = await closedBody(readBody, ['operatorId']);
      const operatorId = operatorIdOf(body['operatorId']);
      const invitation = await run(() => port.issueInvitation(administrator, operatorId));
      return {
        invitation,
        delivery: 'Shown once. Verify the human through an independently trusted channel, then hand the token to them directly. Never send it by link, email or chat; it expires at expiresAt and can be revoked.',
      };
    },
    async revokeInvitation(header, enrolmentId, readBody) {
      const administrator = authorize(header);
      if (!ENROLMENT_ID.test(enrolmentId)) throw EnterpriseHttpErrors.invalidRequest('That is not an enrolment invitation id.');
      const body = await closedBody(readBody, ['reason']);
      const reason = body['reason'];
      if (typeof reason !== 'string') throw EnterpriseHttpErrors.invalidRequest('reason must be a string.');
      return { invitation: await run(() => port.revokeInvitation(administrator, enrolmentId, reason)) };
    },
    async describeHuman(header, operatorId) {
      authorize(header);
      const human = await run(() => port.describeHuman(operatorIdOf(operatorId)));
      if (human === undefined) throw new EnterpriseHttpError(404, 'AUTHORITY_ADMIN_TARGET_NOT_FOUND', 'No human principal exists for that operator.');
      return { human };
    },
  });
}
