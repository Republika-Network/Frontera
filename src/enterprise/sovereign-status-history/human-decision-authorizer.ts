import { bootstrapBindingDigest, isDigest } from './bootstrap-contract.js';
import type { StatusHistoryBootstrapAuthorizer, StatusHistoryBootstrapBinding } from './bootstrap-contract.js';

/**
 * FV-P4C-2B2 — a `StatusHistoryBootstrapAuthorizer` over the Host's AUTH-03
 * passkey decisions, with requester/approver separation.
 *
 * **Not composed and not operational.** Wiring it into the Host needs
 * decisions this module cannot take: an outcome for non-CORE-05 decisions,
 * the permission vocabulary, a requester verdict, and the AUTH-03 composition
 * pins (`docs/integration/FV_HOST_AUTHORITY_INTEGRATION.md`). Until then it is
 * the tested core of that authorizer. It works against a structural port with
 * the exact shape of AUTH-03's `HumanIdentityService` decision methods, so this
 * module never imports the identity service, and the AUTH-03 composition pin
 * stays intact.
 *
 * One authorizer authorizes one bootstrap, from two passkey decisions the Host
 * collected for it:
 * - **Two decisions, one subject.** Both decisions must be AUTH-03 decision
 *   challenges for exactly this bootstrap. Their subject is `sha256:<binding
 *   digest>`, and their request id is derived from that digest alone, so a
 *   decision can never serve another request, asset, issuer, status or
 *   namespace. Both verdicts must be `approve`.
 * - **The requester.** The requester's decision must belong to the operator
 *   the request names (`operatorRef` = `operator:<operatorId>`).
 * - **The approver.** The approver must be a different principal, and each
 *   must hold the Host permission the injected policy names.
 * - **Peek before consume.** Both decisions are only *peeked* until every
 *   check passes, so a foreign decision (a CORE-05 approval, say) is never
 *   consumed by mistake.
 * - **AUTH-03 checks.** Each is then consumed through AUTH-03 itself, which
 *   checks the passkey assertion, user verification, the credential and
 *   principal being active, expiry (≤ 120 s), and single use.
 *
 * Any failure denies, with one closed reason (`lastDenial()`). The authorizer
 * is single-use.
 *
 * **Consumption is not atomic across the two decisions.** The requester's
 * decision is consumed first, then the approver's. If the second fails
 * (expired, revoked, already used, a bad assertion), the first stays
 * consumed in AUTH-03's chain, and the bootstrap is denied. Nothing is
 * anchored. `consumedDecisions()` names every commitment this authorizer
 * consumed, so the partial consumption is auditable. The requester must
 * decide again for a new attempt; a consumed decision never authorizes twice.
 */

/** AUTH-03's decision challenge format (`HUMAN_DECISION_CHALLENGE_FORMAT`); a test pins it to the real constant. */
export const BOOTSTRAP_HUMAN_DECISION_FORMAT = 'frontera.human-decision-challenge.v1';

/** The AUTH-03 `approvalRequestId` namespace for bootstrap decisions; never a CORE-05 request id. */
export const BOOTSTRAP_HUMAN_DECISION_REQUEST_PREFIX = 'frontera.sovereign-status-bootstrap:';

export const BOOTSTRAP_HUMAN_DECISION_DENIALS = Object.freeze([
  'BINDING_INVALID',
  'DECISION_UNREADABLE',
  'DECISION_FORMAT_UNSUPPORTED',
  'ORGANIZATION_MISMATCH',
  'DECISION_NOT_FOR_THIS_BOOTSTRAP',
  'VERDICT_NOT_APPROVE',
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

/** The fields of an AUTH-03 decision challenge contract this authorizer reads. */
export interface BootstrapHumanDecisionContract {
  readonly format: string;
  readonly organizationId: string;
  readonly approvalRequestId: string;
  readonly subjectDigest: string;
  readonly verdict: string;
  readonly operatorId: string;
  readonly expiresAt: string;
}

/** Structurally, AUTH-03's `HumanIdentityService.peekDecision` and `authorizeDecision`. */
export interface BootstrapHumanDecisionPort {
  peekDecision(response: unknown): { readonly contract: BootstrapHumanDecisionContract; readonly commitment: string };
  authorizeDecision(response: unknown): Promise<{ readonly contract: BootstrapHumanDecisionContract; readonly commitment: string; readonly evidenceDigest: string }>;
}

/**
 * Who may request and who may approve a bootstrap, by the Host's own standing.
 * Which permission backs each is an open decision: `authority.bootstrap` means
 * something else today.
 */
export interface BootstrapHumanPermissions {
  mayRequest(operatorId: string): boolean;
  mayApprove(operatorId: string): boolean;
}

export interface HumanDecisionBootstrapAuthorizerOptions {
  readonly decisions: BootstrapHumanDecisionPort;
  readonly organizationId: string;
  readonly permissions: BootstrapHumanPermissions;
  /** The requester's passkey assertion over a decision challenge for this bootstrap. */
  readonly requesterResponse: unknown;
  /** A different principal's passkey assertion over a decision challenge for this bootstrap. */
  readonly approverResponse: unknown;
}

export interface HumanDecisionBootstrapAuthorizer extends StatusHistoryBootstrapAuthorizer {
  /** Why the last call denied, or `null`. Diagnostics only: the coordinator never reads it. */
  lastDenial(): BootstrapHumanDecisionDenial | null;
  /** The AUTH-03 decision commitments this authorizer consumed, in order, including on a denial after a partial consumption. */
  consumedDecisions(): readonly string[];
}

/** The AUTH-03 decision inputs a Host issues for this binding: one per principal, the same subject. */
export function bootstrapHumanDecisionInputs(bindingDigest: string): { readonly approvalRequestId: string; readonly subjectDigest: string; readonly verdict: 'approve' } {
  if (!isDigest(bindingDigest)) throw new TypeError('A bootstrap binding digest is lowercase hex SHA-256.');
  return { approvalRequestId: `${BOOTSTRAP_HUMAN_DECISION_REQUEST_PREFIX}${bindingDigest}`, subjectDigest: `sha256:${bindingDigest}`, verdict: 'approve' };
}

export function createHumanDecisionBootstrapAuthorizer(options: HumanDecisionBootstrapAuthorizerOptions): HumanDecisionBootstrapAuthorizer {
  const { decisions, organizationId, permissions, requesterResponse, approverResponse } = options;
  const peek = decisions.peekDecision.bind(decisions);
  const authorize = decisions.authorizeDecision.bind(decisions);
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

        let requester: ReturnType<typeof peek>;
        let approver: ReturnType<typeof peek>;
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
          if (contract.verdict !== expected.verdict) return deny('VERDICT_NOT_APPROVE');
        }
        if (binding.operatorRef !== `operator:${requester.contract.operatorId}`) return deny('OPERATOR_REF_MISMATCH');
        if (requester.contract.operatorId === approver.contract.operatorId || requester.commitment === approver.commitment) return deny('SAME_PRINCIPAL');
        let requesterMay: boolean;
        let approverMay: boolean;
        try {
          requesterMay = mayRequest(requester.contract.operatorId) === true;
          approverMay = mayApprove(approver.contract.operatorId) === true;
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
          let confirmed: ReturnType<typeof readPeeked>;
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
          // Both decisions, by commitment: each names a decision_authorized row in the AUTH-03 chain.
          authorityRef: `frontera.human-decision:${consumed[0]!}:${consumed[1]!}`,
        });
      } catch {
        return deny('DECISION_UNREADABLE');
      }
    },
  });
}

/** A peeked decision, read as plain data: the fields this authorizer relies on, nothing more. */
function readPeeked(value: unknown): { readonly contract: BootstrapHumanDecisionContract; readonly commitment: string } {
  if (typeof value !== 'object' || value === null) throw new TypeError('not a decision');
  const record = value as { contract?: unknown; commitment?: unknown };
  const contract = record.contract;
  const commitment = record.commitment;
  if (typeof commitment !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(commitment)) throw new TypeError('not a commitment');
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
