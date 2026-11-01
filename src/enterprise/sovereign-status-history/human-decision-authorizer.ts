import { bootstrapBindingDigest, isDigest } from './bootstrap-contract.js';
import type { StatusHistoryBootstrapAuthorizer, StatusHistoryBootstrapBinding } from './bootstrap-contract.js';
import type { BootstrapHumanPermissions, BootstrapPermissionScope } from './authority-permissions.js';

/**
 * FV-P4C-2B2 / 2B2B — a `StatusHistoryBootstrapAuthorizer` over two AUTH-03
 * passkey decisions in the dedicated **bootstrap-authority domain**, with
 * signed requester/approver roles.
 *
 * **Not composed and not operational** (B3, B6:
 * `docs/integration/FV_AUTHORITY_LIFECYCLE.md`). It works against a
 * structural port with the exact shape of AUTH-03's bootstrap-authority
 * methods, so this module never imports the identity service and the AUTH-03
 * composition pin stays intact.
 *
 * One authorizer authorizes one bootstrap, from two decisions:
 * - **One domain (B2).** Both decisions must be of AUTH-03's
 *   `frontera.sovereign-status-bootstrap-authority.v1` format, whose
 *   commitment domain is not CORE-05's. A CORE-05 decision, or an
 *   organization-bootstrap approval, cannot be presented: AUTH-03's
 *   bootstrap methods refuse every other format, and this authorizer checks
 *   the format again.
 * - **One subject.** Both are bound to `sha256:<binding digest>` under the
 *   request id `frontera.sovereign-status-bootstrap:<binding digest>`. The
 *   digest is FV-P4C-2B1's own, so it covers namespace, asset, issuer,
 *   manifest, status sequence and digest, terms, operation, purpose, request
 *   id, requesting operator and request expiry.
 * - **Two signed roles (B5).** The requester's decision must carry the signed
 *   role `attest` (its intent to perform exactly this bootstrap), and must be
 *   by the operator the request names (`operatorRef`). The approver's must
 *   carry `approve`, by a different human. The role is inside the passkey's
 *   commitment, so roles cannot be swapped or one decision reused as both.
 * - **Two permissions (B4).** The requester must hold
 *   `status-history.bootstrap.request`, the approver
 *   `status-history.bootstrap.approve`, each for this organization and
 *   namespace (grants are namespace-wide), by the injected Host permissions (Kernel-Authority grants:
 *   `authority-permissions.ts`). A signature alone grants nothing.
 * - **Peek before consume.** Both are only peeked until every check passes,
 *   so a foreign decision is never consumed. Each is then consumed by AUTH-03
 *   itself (passkey assertion, user verification, active credential and
 *   principal, expiry ≤ 120 s, single use).
 *
 * Any failure denies, with one closed reason (`lastDenial()`). Single-use.
 *
 * **Consumed is not committed.** The coordinator authorizes before the source
 * check and the history commit, so a consumed pair may still anchor nothing.
 * AUTH-03 records consumption only; whether the bootstrap committed is
 * settled afterwards from the receiver's own evidence
 * (`authority-settlement.ts`), never inferred from consumption.
 *
 * **Consumption is not atomic across the two decisions.** The requester's is
 * consumed first. If the approver's is then refused, the requester's stays
 * consumed and the bootstrap is denied; `consumedDecisions()` reports it, and
 * settlement later records it as not committed.
 */

/** AUTH-03's bootstrap-authority challenge format (`BOOTSTRAP_AUTHORITY_CHALLENGE_FORMAT`); a test pins it to the real constant. */
export const BOOTSTRAP_HUMAN_DECISION_FORMAT = 'frontera.sovereign-status-bootstrap-authority.v1';

/** The AUTH-03 `approvalRequestId` namespace for bootstrap decisions; never a CORE-05 request id. */
export const BOOTSTRAP_HUMAN_DECISION_REQUEST_PREFIX = 'frontera.sovereign-status-bootstrap:';

/** The `authorityRef` this authorizer records: `<prefix><requester commitment>:<approver commitment>`, in that order. */
export const BOOTSTRAP_AUTHORITY_REF_PREFIX = 'frontera.sovereign-status-bootstrap-authority.v1:';

/** The signed role each decision must carry. */
export const BOOTSTRAP_HUMAN_DECISION_ROLES = Object.freeze({ requester: 'attest', approver: 'approve' } as const);

export const BOOTSTRAP_HUMAN_DECISION_DENIALS = Object.freeze([
  'BINDING_INVALID',
  'DECISION_UNREADABLE',
  'DECISION_FORMAT_UNSUPPORTED',
  'ORGANIZATION_MISMATCH',
  'DECISION_NOT_FOR_THIS_BOOTSTRAP',
  'ROLE_MISMATCH',
  'OPERATOR_REF_MISMATCH',
  'SAME_PRINCIPAL',
  'REQUESTER_NOT_PERMITTED',
  'APPROVER_NOT_PERMITTED',
  'PERMISSION_SERVICE_FAILED',
  'DECISION_REFUSED',
  'DECISION_SUBSTITUTED',
  'ALREADY_USED',
] as const);
export type BootstrapHumanDecisionDenial = (typeof BOOTSTRAP_HUMAN_DECISION_DENIALS)[number];

/** The fields of an AUTH-03 bootstrap-authority contract this authorizer reads. `verdict` is the signed role. */
export interface BootstrapHumanDecisionContract {
  readonly format: string;
  readonly organizationId: string;
  readonly approvalRequestId: string;
  readonly subjectDigest: string;
  readonly verdict: string;
  readonly operatorId: string;
  readonly expiresAt: string;
}

/** Structurally, AUTH-03's `peekBootstrapAuthorityDecision` and `authorizeBootstrapAuthorityDecision`. */
export interface BootstrapHumanDecisionPort {
  peekBootstrapAuthorityDecision(response: unknown): { readonly contract: BootstrapHumanDecisionContract; readonly commitment: string };
  authorizeBootstrapAuthorityDecision(response: unknown): Promise<{ readonly contract: BootstrapHumanDecisionContract; readonly commitment: string; readonly evidenceDigest: string }>;
}

export interface HumanDecisionBootstrapAuthorizerOptions {
  readonly decisions: BootstrapHumanDecisionPort;
  readonly organizationId: string;
  readonly permissions: BootstrapHumanPermissions;
  /** The requester's passkey assertion over an `attest` challenge for this bootstrap. */
  readonly requesterResponse: unknown;
  /** A different principal's passkey assertion over an `approve` challenge for this bootstrap. */
  readonly approverResponse: unknown;
}

export interface HumanDecisionBootstrapAuthorizer extends StatusHistoryBootstrapAuthorizer {
  /** Why the last call denied, or `null`. Diagnostics only: the coordinator never reads it. */
  lastDenial(): BootstrapHumanDecisionDenial | null;
  /** The AUTH-03 decision commitments this authorizer consumed, in order, including on a denial after a partial consumption. */
  consumedDecisions(): readonly string[];
}

/** The AUTH-03 `beginBootstrapAuthorityDecision` input for one role of this binding. */
export function bootstrapAuthorityDecisionInput(bindingDigest: string, role: 'requester' | 'approver'): { readonly bindingDigest: string; readonly role: 'attest' | 'approve' } {
  if (!isDigest(bindingDigest)) throw new TypeError('A bootstrap binding digest is lowercase hex SHA-256.');
  if (role !== 'requester' && role !== 'approver') throw new TypeError('A bootstrap role is requester or approver.');
  return { bindingDigest, role: BOOTSTRAP_HUMAN_DECISION_ROLES[role] };
}

/** The contract fields every decision for this binding must carry. */
export function bootstrapHumanDecisionInputs(bindingDigest: string): { readonly approvalRequestId: string; readonly subjectDigest: string } {
  if (!isDigest(bindingDigest)) throw new TypeError('A bootstrap binding digest is lowercase hex SHA-256.');
  return { approvalRequestId: `${BOOTSTRAP_HUMAN_DECISION_REQUEST_PREFIX}${bindingDigest}`, subjectDigest: `sha256:${bindingDigest}` };
}

const COMMITMENT = /^sha256:[0-9a-f]{64}$/;

/** Reads an `authorityRef` this authorizer produced; `undefined` for anything else. */
export function parseBootstrapAuthorityRef(authorityRef: unknown): { readonly requesterCommitment: string; readonly approverCommitment: string } | undefined {
  if (typeof authorityRef !== 'string' || !authorityRef.startsWith(BOOTSTRAP_AUTHORITY_REF_PREFIX)) return undefined;
  const rest = authorityRef.slice(BOOTSTRAP_AUTHORITY_REF_PREFIX.length);
  const match = /^(sha256:[0-9a-f]{64}):(sha256:[0-9a-f]{64})$/.exec(rest);
  if (match === null || match[1] === match[2]) return undefined;
  return { requesterCommitment: match[1]!, approverCommitment: match[2]! };
}

export function createHumanDecisionBootstrapAuthorizer(options: HumanDecisionBootstrapAuthorizerOptions): HumanDecisionBootstrapAuthorizer {
  const { decisions, organizationId, permissions, requesterResponse, approverResponse } = options;
  const peek = decisions.peekBootstrapAuthorityDecision.bind(decisions);
  const authorize = decisions.authorizeBootstrapAuthorityDecision.bind(decisions);
  const mayRequest = permissions.mayRequest.bind(permissions);
  const mayApprove = permissions.mayApprove.bind(permissions);
  let used = false;
  let denial: BootstrapHumanDecisionDenial | null = null;
  const consumed: string[] = [];
  const deny = (reason: BootstrapHumanDecisionDenial) => {
    denial = reason;
    return Object.freeze({ outcome: 'denied' as const });
  };

  return Object.freeze({
    lastDenial: () => denial,
    consumedDecisions: () => Object.freeze([...consumed]),
    async authorizeStatusHistoryBootstrap(binding: StatusHistoryBootstrapBinding, bindingDigest: string): Promise<unknown> {
      if (used) return deny('ALREADY_USED');
      used = true;
      denial = null;
      try {
        // The digest must be the binding's own: a decision is bound to the digest, the digest to the binding.
        if (!isDigest(bindingDigest) || bootstrapBindingDigest(binding) !== bindingDigest) return deny('BINDING_INVALID');
        const expected = bootstrapHumanDecisionInputs(bindingDigest);

        let requester: Peeked;
        let approver: Peeked;
        try {
          requester = readPeeked(peek(requesterResponse));
          approver = readPeeked(peek(approverResponse));
        } catch {
          return deny('DECISION_UNREADABLE');
        }
        for (const { contract } of [requester, approver]) {
          if (contract.format !== BOOTSTRAP_HUMAN_DECISION_FORMAT) return deny('DECISION_FORMAT_UNSUPPORTED');
          if (contract.organizationId !== organizationId) return deny('ORGANIZATION_MISMATCH');
          if (contract.approvalRequestId !== expected.approvalRequestId || contract.subjectDigest !== expected.subjectDigest) return deny('DECISION_NOT_FOR_THIS_BOOTSTRAP');
        }
        // B5: each decision carries its own signed role; neither can stand for the other.
        if (requester.contract.verdict !== BOOTSTRAP_HUMAN_DECISION_ROLES.requester || approver.contract.verdict !== BOOTSTRAP_HUMAN_DECISION_ROLES.approver) return deny('ROLE_MISMATCH');
        if (binding.operatorRef !== `operator:${requester.contract.operatorId}`) return deny('OPERATOR_REF_MISMATCH');
        if (requester.contract.operatorId === approver.contract.operatorId || requester.commitment === approver.commitment) return deny('SAME_PRINCIPAL');
        const scope: BootstrapPermissionScope = Object.freeze({ organizationId, namespace: binding.namespace, bindingDigest });
        let requesterMay: boolean;
        let approverMay: boolean;
        try {
          requesterMay = mayRequest(requester.contract.operatorId, scope) === true;
          approverMay = mayApprove(approver.contract.operatorId, scope) === true;
        } catch {
          return deny('PERMISSION_SERVICE_FAILED');
        }
        if (!requesterMay) return deny('REQUESTER_NOT_PERMITTED');
        if (!approverMay) return deny('APPROVER_NOT_PERMITTED');

        // Only now are the decisions consumed, each through AUTH-03's own verification.
        for (const [response, peeked] of [[requesterResponse, requester], [approverResponse, approver]] as const) {
          let authorized: Awaited<ReturnType<typeof authorize>>;
          try {
            authorized = await authorize(response);
          } catch {
            // Expired, revoked, already consumed, a bad assertion: AUTH-03 refused it.
            return deny('DECISION_REFUSED');
          }
          let confirmed: Peeked;
          try {
            confirmed = readPeeked(authorized);
          } catch {
            return deny('DECISION_SUBSTITUTED');
          }
          // AUTH-03 consumed it, whatever follows: recorded before any further check.
          consumed.push(peeked.commitment);
          if (JSON.stringify(confirmed) !== JSON.stringify(peeked)) return deny('DECISION_SUBSTITUTED');
        }
        return Object.freeze({
          outcome: 'authorized',
          bindingDigest,
          // Both decisions, by commitment and in role order: each names a decision_authorized row in the AUTH-03 chain.
          authorityRef: `${BOOTSTRAP_AUTHORITY_REF_PREFIX}${consumed[0]!}:${consumed[1]!}`,
        });
      } catch {
        return deny('DECISION_UNREADABLE');
      }
    },
  });
}

interface Peeked {
  readonly contract: BootstrapHumanDecisionContract;
  readonly commitment: string;
}

/** A peeked decision, read as plain data: the fields this authorizer relies on, nothing more. */
function readPeeked(value: unknown): Peeked {
  if (typeof value !== 'object' || value === null) throw new TypeError('not a decision');
  const record = value as { contract?: unknown; commitment?: unknown };
  const contract = record.contract;
  const commitment = record.commitment;
  if (typeof commitment !== 'string' || !COMMITMENT.test(commitment)) throw new TypeError('not a commitment');
  const fields = typeof contract === 'object' && contract !== null ? (contract as Record<string, unknown>) : undefined;
  if (fields === undefined) throw new TypeError('not a contract');
  const read = (key: keyof BootstrapHumanDecisionContract): string => {
    const field = fields[key];
    if (typeof field !== 'string') throw new TypeError(`missing ${key}`);
    return field;
  };
  // A snapshot: later reads of the caller's objects cannot change what was checked.
  return {
    commitment,
    contract: {
      format: read('format'),
      organizationId: read('organizationId'),
      approvalRequestId: read('approvalRequestId'),
      subjectDigest: read('subjectDigest'),
      verdict: read('verdict'),
      operatorId: read('operatorId'),
      expiresAt: read('expiresAt'),
    },
  };
}
