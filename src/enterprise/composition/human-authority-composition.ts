import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { createHumanDecisionChannel, type HumanDecisionChannel, type HumanDecisionReconciliation } from '../approval-authority/human-decision.js';
import type { ApprovalCommandPort } from '../approval-authority/service.js';
import type { AuthorityArtifactSigner } from '../authority-authenticity/signer.js';
import type { AuthorityArtifactVerifier } from '../authority-authenticity/verifier.js';
import type { AuthorityStateFreshnessBoundary } from '../authority-state-freshness/session.js';
import type { EnabledHumanAuthorityConfiguration } from '../configuration/enterprise-configuration.js';
import { HumanIdentityError, createHumanIdentityService, createRelyingPartyConfiguration, openSqliteHumanIdentityStore, type HumanIdentityService, type HumanIdentityStore, type RelyingPartyConfiguration } from '../human-identity/index.js';
import { isOperatorRole, type OperatorRole } from '../operator-control/roles.js';

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
}

export interface ComposedHumanAuthority {
  readonly store: HumanIdentityStore;
  readonly port: HumanAuthorityPort;
  /** What startup reconciliation settled. */
  readonly reconciled: readonly HumanDecisionReconciliation[];
}

export interface ComposeHumanAuthorityInput {
  readonly configuration: EnabledHumanAuthorityConfiguration;
  readonly relyingParty: RelyingPartyConfiguration;
  readonly organizationId: string;
  /** The Host's one authority signer and trusted verifier — the same boundary CORE-05's store uses. */
  readonly authenticity: { readonly signer: AuthorityArtifactSigner; readonly verifier: AuthorityArtifactVerifier };
  readonly freshness: AuthorityStateFreshnessBoundary | undefined;
  readonly approvals: Pick<ApprovalCommandPort, 'list' | 'approve' | 'reject'>;
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
    const identity = createHumanIdentityService({ store, relyingParty: input.relyingParty, operatorIds: [...operators.keys()], decisionChallengeTtlSeconds: configuration.decisionChallengeTtlSeconds });
    const channel = createHumanDecisionChannel({ organizationId: input.organizationId, approvals: input.approvals, identity, roleOf });
    // Recovery after restart: nothing is in flight in a process that just started.
    const reconciled = await channel.reconcile();
    const ready = <T>(run: () => Promise<T>): Promise<T> => (input.isReady() ? run() : Promise.reject(input.notReady()));
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
    });
    return { store, port, reconciled };
  } catch (error) {
    store.close();
    throw error;
  }
}
