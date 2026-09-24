import type { EmergencyControlReasonCode, EmergencyControlScopeMatch } from '../../features/emergency-control-runtime/index.js';
import type { BoundedGrant, GrantCorrelation, GrantReasonCode, GrantValidityCeiling, RequestedGrantBounds } from '../../features/grant-runtime/index.js';
import type { KernelEvaluationOptions, KernelEvaluationRequest, KernelEvaluationResult } from '../../kernel/index.js';
import type { GrantAuthorityBinding } from './authority-binding.js';
import type { FinancialAuthority, FinancialAuthorityReasonCode } from './financial-authority.js';

/**
 * The Kernel surface this composition needs, named structurally so it depends
 * on the canonical evaluation contract rather than on a concrete class —
 * exactly as `TransferKernelPort` and `LicenseKernelPort` already do.
 * `AocKernel` satisfies it as-is, and nothing else in this repository does.
 *
 * Note what is **not** here: `enforce()`. This composition never calls it.
 * `ADR-OBLIGATION-DISCHARGE-AND-BOUNDED-GRANT.md` gives grants no role in the
 * executor gate, and the grant runtime's README records the reconciliation
 * deliberately — "making a configured grant capability withhold the executor
 * would be inventing a lifecycle semantic the architecture does not state".
 * Authorization and exercise are two moments, so they are two calls, and the
 * Kernel keeps the first one unchanged.
 */
export interface ExecutionKernelPort {
  evaluate(request: KernelEvaluationRequest, options?: KernelEvaluationOptions): Promise<KernelEvaluationResult>;
}

/**
 * What the composition root is asked, so it can say which authority world this
 * action is in.
 *
 * **Synchronous, on purpose.** It is called twice — once to build the issuance
 * ceilings, and once again *inside the store's commit boundary* — and a guard
 * that could `await` would reintroduce exactly the interleaving
 * `BoundedGrantStorePort.issue`'s synchronous `commitGuard` exists to prevent.
 * A deployment whose authority store cannot answer synchronously pre-loads the
 * answer before calling `authorize`, which is what `acquireReservation`'s
 * callers already do.
 */
export interface GrantAuthorityBindingQuery {
  readonly request: KernelEvaluationRequest;
  readonly correlation: GrantCorrelation;
  readonly evaluatedAt: string;
  /** `issuance` the first time; `commit` when re-resolved inside the store transaction, so a resolver can tell a measurement from a commit-boundary re-read. */
  readonly phase: 'issuance' | 'commit';
}

/**
 * Answers "is this action governed by an authority with a validity window, and
 * if so, until when?".
 *
 * Returning `undefined` means **the resolver could not tell**, and that fails
 * closed: no grant is issued. It is deliberately not the same value as "no
 * window applies", which is spelled `{ kind: 'no-temporal-authority-bound', … }`
 * and costs an explicit `sourceKind` and `justification`. That distinction is
 * the whole reason this port exists — see `authority-binding.ts`.
 */
export type GrantAuthorityBindingResolver = (query: GrantAuthorityBindingQuery) => GrantAuthorityBinding | undefined;

/** Why a bounded grant was withheld before issuance was even attempted, because the composition could not establish which authority world it was in. A separate vocabulary from `GRANT_REASON_CODES`: these describe a *host binding*, not a grant. */
export const AUTHORITY_BINDING_REASON_CODES = {
  /** The resolver returned nothing. The composition cannot tell whether an authority window applies, so it does not issue — the `validityCeilings: []` hazard, refused instead of guessed. */
  AUTHORITY_BINDING_UNRESOLVED: 'AUTHORITY_BINDING_UNRESOLVED',
  /** The resolver returned a binding that does not state what its own kind requires — a `bounded-authority` with an unparseable `expiresAt`, or a `no-temporal-authority-bound` with no justification. A cap that silently stopped capping is worse than none. */
  AUTHORITY_BINDING_MALFORMED: 'AUTHORITY_BINDING_MALFORMED',
} as const;

export type AuthorityBindingReasonCode = (typeof AUTHORITY_BINDING_REASON_CODES)[keyof typeof AUTHORITY_BINDING_REASON_CODES];

export const AUTHORITY_BINDING_REASON_CODE_VALUES: readonly AuthorityBindingReasonCode[] = Object.values(AUTHORITY_BINDING_REASON_CODES);

export interface AuthorityControlledAuthorizationInput {
  /** The evaluated request, already adapted from the wire by `toKernelEvaluationRequest` or assembled by a trusted host. */
  readonly request: KernelEvaluationRequest;
  readonly options?: KernelEvaluationOptions;
  /**
   * The expiry the **trusted issuer** proposes for the grant.
   *
   * Required, finite, strictly after issuance — ADR §4 rules 1 and 2 and hard
   * invariant 9. Host input: nothing on `KernelEvaluationRequest` reaches it,
   * and a requester able to set, extend or remove the expiry on its own grant
   * has been handed the grant.
   */
  readonly grantExpiresAt: string;
  /** The narrowing the host asks for, axis by axis. Host input, never caller input; an omitted axis inherits the source bound unchanged. */
  readonly requestedBounds?: RequestedGrantBounds;
}

/**
 * What one authorization attempt produced.
 *
 * **Every case carries `decision` exactly as the Kernel produced it.** Nothing
 * in this composition rewrites a status, a reason code or a summary, and there
 * is no branch that could: the result is obtained once, copied by reference
 * into the outcome, and never read for anything but the grant projection the
 * Kernel itself computed.
 */
export type AuthorityControlledAuthorizationOutcome =
  | {
      readonly outcome: 'grant-issued';
      readonly decision: KernelEvaluationResult;
      readonly grant: BoundedGrant;
      /** Which authority world the composition declared itself to be in. Recorded so an auditor can see that the question was asked and how it was answered. */
      readonly authorityBinding: GrantAuthorityBinding;
      /** The strictest ceiling that applied, when one did. Absent means none existed — never that none was looked for. */
      readonly effectiveValidityCeiling?: GrantValidityCeiling;
      /** `already-issued` when the deterministic identity already stood. The existing grant is returned unchanged, never re-dated. */
      readonly issuance: 'issued' | 'already-issued';
      /** P10: for a host-classified financial action, the durable monetary authority the grant's ceiling and aggregate limits were sourced from. Absent for a non-financial action. */
      readonly financialAuthority?: FinancialAuthority;
    }
  | {
      /** Layer E refused. The authorization is untouched — an `allowed` decision here is the normal, intended combination. */
      readonly outcome: 'grant-withheld';
      readonly decision: KernelEvaluationResult;
      readonly reasonCodes: readonly GrantReasonCode[];
      readonly authorityBinding: GrantAuthorityBinding;
      readonly effectiveValidityCeiling?: GrantValidityCeiling;
    }
  | {
      /** The composition could not establish the authority binding, so it issued nothing. Fail-closed, and reported in its own vocabulary so it is never mistaken for a grant refusal or a policy denial. */
      readonly outcome: 'authority-binding-unresolved';
      readonly decision: KernelEvaluationResult;
      readonly reasonCodes: readonly AuthorityBindingReasonCode[];
    }
  | {
      /**
       * P10: the action is host-classified as financial and its monetary
       * authority could not be established — no lineage, no ceiling, no
       * aggregate limit, a malformed or mismatched asset, a request above the
       * ceiling, or an authority that changed before the commit. No grant
       * exists. The decision is carried unchanged: an `allowed` decision here
       * is truthful, and nothing in this outcome is a policy denial.
       */
      readonly outcome: 'financial-authority-withheld';
      readonly decision: KernelEvaluationResult;
      readonly reasonCodes: readonly FinancialAuthorityReasonCode[];
    }
  | {
      /**
       * An operational emergency control was active — or unreadable — at the
       * **commit boundary**, so no bounded grant was committed.
       *
       * An additive case rather than a rewrite of `grant-withheld`, and the
       * distinction is the point. `grant-withheld` means layer E refused: the
       * authorization did not permit exercise, an obligation was unsatisfied,
       * the bounds broadened, the ceiling was exceeded. This means every one of
       * those checks would have passed and an operator has administratively
       * stopped execution. They send an operator to opposite places, and the
       * second is cleared by a person rather than fixed by a change.
       *
       * The reason codes are the emergency-control vocabulary's own. They are
       * deliberately not translated into `GRANT_CORRELATION_INVALID`, which is
       * the code the store's commit guard sees when the synchronous
       * re-validation returns `undefined`: that code describes a correlation
       * defect, and reporting one here would send an operator hunting a bug
       * that does not exist.
       */
      readonly outcome: 'emergency-control-withheld';
      readonly decision: KernelEvaluationResult;
      readonly reasonCodes: readonly EmergencyControlReasonCode[];
      /** Which applicable controls matched, when the state was readable. Operator diagnostics; never authority. */
      readonly matchedScopes: readonly EmergencyControlScopeMatch[];
    };
