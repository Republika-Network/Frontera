import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { createHumanDecisionChannel, type HumanDecisionChannel, type HumanDecisionReconciliation } from '../approval-authority/human-decision.js';
import type { ApprovalAuthorityPort } from '../approval-authority/evaluation.js';
import type { ApprovalCommandPort, ApprovalRequestView } from '../approval-authority/service.js';
import type { AuthorityArtifactSigner } from '../authority-authenticity/signer.js';
import type { AuthorityArtifactVerifier } from '../authority-authenticity/verifier.js';
import type { AuthorityStateFreshnessBoundary } from '../authority-state-freshness/session.js';
import type { EnabledHumanAuthorityConfiguration } from '../configuration/enterprise-configuration.js';
import { HumanIdentityError, createHumanIdentityService, identityAdministratorFor, createRelyingPartyConfiguration, openSqliteHumanIdentityStore, type HumanIdentityService, type HumanIdentityStore, type RelyingPartyConfiguration } from '../human-identity/index.js';
import type { EnterpriseOperatorPrincipal } from '../operator-control/operator-authenticator.js';
import { PasskeyEnrolmentRefusal, type PasskeyEnrolmentAdministrationPort, type PasskeyEnrolmentHumanView } from '../operator-control/passkey-enrolment.js';
import { isOperatorRole, operatorMay, type OperatorRole } from '../operator-control/roles.js';

/**
 * AUTH-04A — the passkey human-decision authority, composed inside the shipped
 * Host.
 *
 * ```
 * configuration (humanAuthority: enabled)
 *   └─ assertHumanAuthorityComposable      before anything is opened or contacted
 *        SQLite · external CORE-07 witness · software custody · CTRL-02 operators · durable CORE-05 approvals
 *        relying party: explicit RP ID + exact https origins (AUTH-02 rules, production mode only)
 *   └─ composeHumanAuthority               after CORE-05 is composed
 *        identity store  ← the Host's one authority signer + verifier (CORE-02)
 *                        ← the Host's one freshness boundary (CORE-07): genesis enrolled, head established at open
 *        identity service (AUTH-02/03) · decision channel (AUTH-03) → CORE-05 command port
 *        reconcile()  once: settles consumed decisions a crash left unsettled — outcomes only, never a verdict
 *   └─ enterprise.humanAuthority            in-process port, refused while the Host is not ready
 * ```
 *
 * Nothing here is a route, and nothing here reads a bearer, a session or a
 * caller's organization. The CTRL-04 operator plane is untouched and separate.
 */

export type HumanAuthorityConfigurationErrorCode =
  /** The relying party (RP ID, origins) or another human-authority setting is invalid. */
  | 'HUMAN_AUTHORITY_CONFIGURATION_INVALID'
  /** The external CORE-07 witness is not configured: an unwitnessed identity store never authorizes a decision. */
  | 'HUMAN_AUTHORITY_FRESHNESS_REQUIRED'
  /** The configured authority signer cannot sign human identity state (external custody, until its protocol carries it). */
  | 'HUMAN_AUTHORITY_SIGNER_UNSUPPORTED'
  /** A prerequisite is not composed: SQLite persistence, CTRL-02 operators, or durable CORE-05 approvals. */
  | 'HUMAN_AUTHORITY_PREREQUISITE_MISSING'
  /** No identity store exists and initialization was not requested. It is never created implicitly. */
  | 'HUMAN_AUTHORITY_STORE_UNINITIALIZED';

export class HumanAuthorityConfigurationError extends Error {
  readonly code: HumanAuthorityConfigurationErrorCode;

  constructor(code: HumanAuthorityConfigurationErrorCode, message: string) {
    super(message);
    this.name = 'HumanAuthorityConfigurationError';
    this.code = code;
  }
}

/** A configured CTRL-02 operator as this module sees it: who, and with which role. Never the operator's bearer secret. */
export interface HumanAuthorityOperator {
  readonly operatorId: string;
  readonly role: string;
}

/** What the gate needs to know about the rest of the composition. Read from configuration and composed facts, never from a request. */
export interface HumanAuthorityPrerequisites {
  readonly persistence: 'sqlite' | 'memory';
  readonly freshness: 'external' | 'none';
  readonly signerCustody: 'software' | 'external';
  readonly operators: readonly HumanAuthorityOperator[];
  /** Governed actions are composed and some Governance Profile declares an approval requirement (so CORE-05 is durable under SQLite). */
  readonly approvalsDeclared: boolean;
}

/**
 * The pure gate, run before any store is opened, the signer proven or the
 * witness contacted. Returns the frozen relying party.
 */
export function assertHumanAuthorityComposable(configuration: EnabledHumanAuthorityConfiguration, prerequisites: HumanAuthorityPrerequisites): RelyingPartyConfiguration {
  const missing = (detail: string): never => {
    throw new HumanAuthorityConfigurationError('HUMAN_AUTHORITY_PREREQUISITE_MISSING', `The human-decision authority is enabled but ${detail}. Nothing was opened.`);
  };
  if (prerequisites.persistence !== 'sqlite') missing('persistence is not SQLite (AOC_ENTERPRISE_PERSISTENCE_PROVIDER=sqlite): human authority is never held in memory');
  if (prerequisites.freshness !== 'external') {
    throw new HumanAuthorityConfigurationError(
      'HUMAN_AUTHORITY_FRESHNESS_REQUIRED',
      'The human-decision authority is enabled but no external CORE-07 freshness witness is configured (AOC_ENTERPRISE_AUTHORITY_FRESHNESS_MODE=external). An unwitnessed identity store could be rolled back to reuse a consumed decision or a revoked passkey; it is never composed. Nothing was opened.',
    );
  }
  if (prerequisites.signerCustody !== 'software') {
    throw new HumanAuthorityConfigurationError(
      'HUMAN_AUTHORITY_SIGNER_UNSUPPORTED',
      'The human-decision authority is enabled under external authority-key custody, whose signer protocol does not sign human identity state. There is no unsigned identity store; use software custody for the pilot, or wait for the external protocol to carry the operation. Nothing was opened.',
    );
  }
  if (prerequisites.operators.length === 0) missing('no CTRL-02 operators are configured: a human principal is always one of them');
  if (!prerequisites.approvalsDeclared) missing('no durable CORE-05 approvals are composed (governed actions with a Governance Profile approval requirement)');
  try {
    // Production mode only: the loopback test mode is never available to a Host.
    return createRelyingPartyConfiguration({ rpId: configuration.rpId, rpName: configuration.rpName, allowedOrigins: [...configuration.allowedOrigins] });
  } catch (error) {
    const detail = error instanceof HumanIdentityError ? error.message : 'the relying party is invalid';
    throw new HumanAuthorityConfigurationError('HUMAN_AUTHORITY_CONFIGURATION_INVALID', `AOC_ENTERPRISE_HUMAN_AUTHORITY_RP_ID / AOC_ENTERPRISE_HUMAN_AUTHORITY_ALLOWED_ORIGINS: ${detail} Nothing was opened.`);
  }
}

/** AUTH-04B: one approval request a human may act on, and the verdicts their role reaches. A filter for display — CORE-05 still judges every verdict. */
export interface HumanAuthorityInboxEntry {
  readonly view: ApprovalRequestView;
  readonly verdicts: readonly ('approve' | 'reject')[];
}

/**
 * AUTH-04B: the server-side-scoped approval inbox of one human. A request is
 * listed only when it is pending and not superseded, the human's configured
 * role reaches a verdict, the human is an active principal, they are neither
 * the requester nor its principal, and they hold live approver standing — read
 * through the **same** Kernel-Authority port CORE-05 judges with. Nothing else
 * is enumerable: an entry outside this set does not exist for the caller.
 */
export interface HumanAuthorityInbox {
  eligible(operatorId: string): Promise<readonly HumanAuthorityInboxEntry[]>;
  entry(operatorId: string, approvalRequestId: string): Promise<HumanAuthorityInboxEntry | undefined>;
  /** The current derived state of one request — for the status of a decision the caller already holds (its request id comes from that decision's own contract). */
  requestState(approvalRequestId: string): Promise<{ readonly status: ApprovalRequestView['state']['status']; readonly superseded: boolean } | undefined>;
}

/**
 * The in-process human-decision port. Every call is refused while the Host is
 * not ready. `decisions` is the only path from a passkey to a CORE-05 verdict;
 * `identity` is the AUTH-02 service (administration requires a CTRL-02
 * organization administrator principal).
 */
export interface HumanAuthorityPort {
  readonly organizationId: string;
  readonly relyingParty: RelyingPartyConfiguration;
  readonly decisions: Pick<HumanDecisionChannel, 'begin' | 'decide' | 'outcome' | 'reconcile'>;
  readonly identity: HumanIdentityService;
  /** AUTH-04B: the eligibility-scoped inbox. */
  readonly inbox: HumanAuthorityInbox;
}

export interface ComposedHumanAuthority {
  readonly store: HumanIdentityStore;
  readonly port: HumanAuthorityPort;
  /** What startup reconciliation settled. */
  readonly reconciled: readonly HumanDecisionReconciliation[];
  /** AUTH-04B2: enrolment administration for the private operator plane — identity only, never authority. */
  readonly enrolmentAdministration: PasskeyEnrolmentAdministrationPort;
  /**
   * AUTH-04D1R — graceful shutdown, bounded by `timeoutMs`:
   * 1. the port refuses every new decision, inbox read and enrolment-administration call;
   * 2. every decision already running settles (identity consumption, the CORE-05 verdict, its outcome);
   * 3. the identity store refuses new writes, lets accepted ones finish, and closes.
   * Nothing is retried or replayed. A write still running at the deadline is
   * cut off and fails closed, exactly as a crash would; startup reconciliation
   * and CORE-07 handle it as they handle a crash.
   */
  drain(timeoutMs: number): Promise<HumanAuthorityDrainResult>;
}

export interface HumanAuthorityDrainResult {
  /** Whether every running decision reached its end before the deadline. */
  readonly decisions: 'settled' | 'interrupted';
  /** Whether every accepted identity write reached its end before the store closed. */
  readonly writes: 'settled' | 'interrupted';
}

/** AUTH-04B2: invitations live at most 15 minutes on a Host, whatever the AUTH-02 module allows. */
export const HOST_ENROLMENT_TTL_MAX_SECONDS = 900;

const REFUSAL_KIND: Readonly<Record<string, PasskeyEnrolmentRefusal['kind']>> = {
  HUMAN_IDENTITY_UNKNOWN_OPERATOR: 'not-found',
  HUMAN_IDENTITY_UNKNOWN_PRINCIPAL: 'not-found',
  HUMAN_IDENTITY_CONFIGURATION_INVALID: 'invalid',
  HUMAN_IDENTITY_ENROLMENT_INVALID: 'not-found',
  HUMAN_IDENTITY_STORE_UNAVAILABLE: 'unavailable',
};

/** Maps AUTH-02 refusals to closed operator-plane refusals; anything else (integrity, freshness) propagates unchanged. */
async function asRefusal<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof HumanIdentityError && error.code !== 'HUMAN_IDENTITY_STORE_CORRUPT' && error.code !== 'HUMAN_IDENTITY_STORE_UNSUPPORTED') {
      throw new PasskeyEnrolmentRefusal(error.code, REFUSAL_KIND[error.code] ?? 'refused', error.message);
    }
    throw error;
  }
}

export interface ComposeHumanAuthorityInput {
  readonly configuration: EnabledHumanAuthorityConfiguration;
  readonly relyingParty: RelyingPartyConfiguration;
  readonly organizationId: string;
  /** The Host's one authority signer and trusted verifier — the same boundary CORE-05's store uses. */
  readonly authenticity: { readonly signer: AuthorityArtifactSigner; readonly verifier: AuthorityArtifactVerifier };
  readonly freshness: AuthorityStateFreshnessBoundary | undefined;
  readonly approvals: Pick<ApprovalCommandPort, 'list' | 'approve' | 'reject'>;
  /** AUTH-04B: the approver-standing port CORE-05 itself judges with — read-only here, for the inbox filter. */
  readonly standing: ApprovalAuthorityPort;
  readonly now: () => string;
  readonly operators: readonly HumanAuthorityOperator[];
  readonly busyTimeoutMs: number;
  readonly isReady: () => boolean;
  readonly notReady: () => Error;
}

export async function composeHumanAuthority(input: ComposeHumanAuthorityInput): Promise<ComposedHumanAuthority> {
  const { configuration, freshness } = input;
  if (freshness === undefined) {
    throw new HumanAuthorityConfigurationError('HUMAN_AUTHORITY_FRESHNESS_REQUIRED', 'The human-decision authority requires the established CORE-07 freshness boundary; none was built. Nothing was opened.');
  }
  const path = resolve(configuration.sqlitePath);
  const absent = !existsSync(path);
  if (absent && !configuration.initialize) {
    throw new HumanAuthorityConfigurationError(
      'HUMAN_AUTHORITY_STORE_UNINITIALIZED',
      'No human identity store exists at the configured path and AOC_ENTERPRISE_HUMAN_AUTHORITY_INITIALIZE is not true. A missing identity store is never recreated implicitly (a lost store is restored, or recovered at the witness, never reconstructed).',
    );
  }
  const store = await openSqliteHumanIdentityStore(path, {
    organizationId: input.organizationId,
    now: () => new Date().toISOString(),
    busyTimeoutMs: input.busyTimeoutMs,
    // Only an absent file is ever created; its genesis is enrolled at the witness first. A witness slot that already advanced refuses it.
    ...(absent ? { create: true } : {}),
    authenticity: { signer: input.authenticity.signer, verifier: input.authenticity.verifier },
    freshness: { boundary: freshness },
  });
  try {
    const operators = new Map(input.operators.map((operator) => [operator.operatorId, operator.role]));
    const roleOf = (operatorId: string): OperatorRole | undefined => {
      const role = operators.get(operatorId);
      return isOperatorRole(role) ? role : undefined;
    };
    const identity = createHumanIdentityService({
      store,
      relyingParty: input.relyingParty,
      operatorIds: [...operators.keys()],
      decisionChallengeTtlSeconds: configuration.decisionChallengeTtlSeconds,
      challengeTtlSeconds: configuration.ceremonyChallengeTtlSeconds,
      enrolmentTtlSeconds: Math.min(configuration.enrolmentTtlSeconds, HOST_ENROLMENT_TTL_MAX_SECONDS),
    });
    const channel = createHumanDecisionChannel({ organizationId: input.organizationId, approvals: input.approvals, identity, roleOf });
    const verdictsFor = (role: OperatorRole | undefined): readonly ('approve' | 'reject')[] =>
      role === undefined ? [] : [...(operatorMay(role, 'approval.approve') ? (['approve'] as const) : []), ...(operatorMay(role, 'approval.restrict') ? (['reject'] as const) : [])];
    const holdsStanding = (actorId: string, view: ApprovalRequestView): boolean => {
      try {
        if (!input.standing.recognition(actorId).recognized) return false;
        return input.standing.authority({ actorId, capability: view.subject.requirement.approverAction, resourceScope: view.subject.resourceScope, at: input.now() }).valid;
      } catch {
        // Unreadable authority is no authority.
        return false;
      }
    };
    const entryOf = (operatorId: string, view: ApprovalRequestView): HumanAuthorityInboxEntry | undefined => {
      const actorId = `operator:${operatorId}`;
      if (view.superseded || view.state.status !== 'pending') return undefined;
      if (view.subject.actorId === actorId || view.subject.principalActorId === actorId) return undefined;
      const allowed = verdictsFor(roleOf(operatorId)).filter((verdict) => verdict !== 'approve' || !view.state.verdicts.some((recorded) => recorded.kind === 'approved' && recorded.actorId === actorId));
      if (allowed.length === 0 || !holdsStanding(actorId, view)) return undefined;
      return { view, verdicts: allowed };
    };
    const activeHuman = (operatorId: string): boolean => identity.principal(operatorId)?.state === 'active';
    const inbox: HumanAuthorityInbox = Object.freeze({
      eligible: async (operatorId: string) => (activeHuman(operatorId) ? (await input.approvals.list()).flatMap((view) => entryOf(operatorId, view) ?? []) : []),
      entry: async (operatorId: string, approvalRequestId: string) => {
        if (!activeHuman(operatorId)) return undefined;
        const view = (await input.approvals.list()).find((candidate) => candidate.approvalRequestId === approvalRequestId);
        return view === undefined ? undefined : entryOf(operatorId, view);
      },
      requestState: async (approvalRequestId: string) => {
        const view = (await input.approvals.list()).find((candidate) => candidate.approvalRequestId === approvalRequestId);
        return view === undefined ? undefined : { status: view.state.status, superseded: view.superseded };
      },
    });
    // Recovery after restart: nothing is in flight in a process that just started.
    const reconciled = await channel.reconcile();
    // AUTH-04D1R: a draining authority starts nothing new, whatever the lifecycle says.
    let draining = false;
    const ready = <T>(run: () => Promise<T>): Promise<T> => (!draining && input.isReady() ? run() : Promise.reject(input.notReady()));
    const port: HumanAuthorityPort = Object.freeze({
      organizationId: input.organizationId,
      relyingParty: input.relyingParty,
      decisions: Object.freeze({
        begin: (request: Parameters<HumanDecisionChannel['begin']>[0]) => ready(() => channel.begin(request)),
        decide: (assertion: unknown) => ready(() => channel.decide(assertion)),
        outcome: (commitment: string) => ready(() => channel.outcome(commitment)),
        reconcile: () => ready(() => channel.reconcile()),
      }),
      identity,
      inbox: Object.freeze({
        eligible: (operatorId: string) => ready(() => inbox.eligible(operatorId)),
        entry: (operatorId: string, approvalRequestId: string) => ready(() => inbox.entry(operatorId, approvalRequestId)),
        requestState: (approvalRequestId: string) => ready(() => inbox.requestState(approvalRequestId)),
      }),
    });
    const humanView = (operatorId: string): PasskeyEnrolmentHumanView | undefined => {
      const principal = identity.principal(operatorId);
      if (principal === undefined) return undefined;
      return {
        operatorId,
        displayName: principal.displayName,
        state: principal.state,
        credentials: identity.credentialsOf(operatorId).map((credential) => ({ credentialId: credential.credentialId, state: credential.state, registeredAt: credential.registeredAt })),
        invitations: identity.enrolmentsOf(operatorId).map((enrolment) => ({ enrolmentId: enrolment.enrolmentId, state: enrolment.state, expiresAt: enrolment.expiresAt })),
      };
    };
    // The administrator is the CTRL-02 principal the operator plane authenticated; AUTH-02 re-checks its role and organization.
    const adminOf = (principal: EnterpriseOperatorPrincipal) => identityAdministratorFor(principal);
    const enrolmentAdministration: PasskeyEnrolmentAdministrationPort = Object.freeze({
      registerHuman: (principal: EnterpriseOperatorPrincipal, request: { readonly operatorId: string; readonly displayName: string }) =>
        ready(() =>
          asRefusal(async () => {
            await identity.createPrincipal(adminOf(principal), request);
            return humanView(request.operatorId) as PasskeyEnrolmentHumanView;
          }),
        ),
      issueInvitation: (principal: EnterpriseOperatorPrincipal, operatorId: string) =>
        ready(() =>
          asRefusal(async () => {
            const issued = await identity.authorizeEnrolment(adminOf(principal), operatorId);
            return { enrolmentId: issued.enrolmentId, operatorId: issued.operatorId, expiresAt: issued.expiresAt, token: issued.enrolmentToken };
          }),
        ),
      revokeInvitation: (principal: EnterpriseOperatorPrincipal, enrolmentId: string, reason: string) =>
        ready(() =>
          asRefusal(async () => {
            const revoked = await identity.revokeEnrolment(adminOf(principal), enrolmentId, reason);
            return { enrolmentId: revoked.enrolmentId, operatorId: revoked.operatorId, state: revoked.state };
          }),
        ),
      describeHuman: (operatorId: string) => ready(async () => humanView(operatorId)),
    });
    const drain = async (timeoutMs: number): Promise<HumanAuthorityDrainResult> => {
      draining = true;
      const deadline = Date.now() + timeoutMs;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const decisions = await Promise.race([
        channel.settled().then(() => 'settled' as const),
        new Promise<'interrupted'>((resolveDeadline) => {
          timer = setTimeout(() => resolveDeadline('interrupted'), timeoutMs);
          timer.unref?.();
        }),
      ]);
      clearTimeout(timer);
      const writes = await store.closeWhenSettled(Math.max(1, deadline - Date.now()));
      return { decisions, writes };
    };
    return { store, port, reconciled, enrolmentAdministration, drain };
  } catch (error) {
    store.close();
    throw error;
  }
}
