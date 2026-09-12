import {
  createGrantIssuanceService,
  withGrantValidityCeiling,
  type BoundedGrantStorePort,
  type GrantCorrelation,
  type GrantReasonCode,
  type GrantRevocation,
  type GrantRevocationReason,
  type GrantSourceAuthorization,
} from '../../features/grant-runtime/index.js';
import {
  createGrantExecutionService,
  type BoundedGrantExerciseAssessment,
  type ExecutionAdapter,
  type ExecutionOutcome,
  type GrantExerciseRequest,
} from '../../features/execution-runtime/index.js';
import type { KernelEvaluationRequest, KernelEvaluationResult } from '../../kernel/index.js';
import { KernelGrantCapability, deriveGrantSourceAuthorization } from '../../kernel/orchestration/grant-adapter.js';
import { grantValidityCeilingsFor, isWellFormedGrantAuthorityBinding, type GrantAuthorityBinding } from './authority-binding.js';
import { ExecutionGovernanceError } from './errors.js';
import {
  AUTHORITY_BINDING_REASON_CODES,
  type AuthorityControlledAuthorizationInput,
  type AuthorityControlledAuthorizationOutcome,
  type ExecutionKernelPort,
  type GrantAuthorityBindingResolver,
} from './contracts.js';

/**
 * The first production composition of the authority-control pipeline onto a
 * real, provider-neutral execution boundary.
 *
 * ```
 * request
 *   -> authority          }
 *   -> context            }  AocKernel.evaluate()   the only decision producer, unchanged
 *   -> policy             }
 *   -> obligations        }
 *   -> bounded grant         GrantIssuanceService   only after ALLOW and every blocking obligation
 *   ----------------------- later, and separately -----------------------
 *   -> exercise validation   GrantExecutionService  the trusted grant, re-read, against this action
 *   -> execution adapter     ExecutionAdapter       provider-neutral
 *   -> action result
 * ```
 *
 * ## Two moments, two methods
 *
 * `authorize()` answers "under what authority may this action be exercised?".
 * `exercise()` answers "is this specific grant still valid and sufficient for
 * this specific action right now?". They are separate calls because they are
 * separate moments: a grant issued at T+0 may be exercised at T+5m, expire at
 * T+10m, and be revoked at any point in between, and folding them together
 * would make every one of those unobservable.
 *
 * It also keeps `AocKernel.enforce()` untouched, which is the accepted reading
 * rather than a convenience. **No accepted ADR gives grants a role in the
 * executor gate**; the ADR's own gate on execution is the *obligation* gate
 * layer D already implements; and making a configured grant capability withhold
 * `enforce()`'s executor would invent a lifecycle semantic the architecture
 * does not state. The grant runtime's README records that reconciliation and
 * names wiring `assessExercise` into an execution path as this phase's work.
 * So `enforce()` behaves exactly as it did, and grant-aware execution is this
 * separate, explicitly-composed path.
 *
 * ## Nothing here decides
 *
 * There is no policy, no allow, no deny and no authority inference in this
 * file. It reads a decision the Kernel produced, projects the part layer E is
 * allowed to see, and never writes back: every outcome carries the
 * `KernelEvaluationResult` exactly as it was returned.
 *
 * ## Composing it does not enable it anywhere else
 *
 * This is opt-in at the host. A deployment that does not compose it sees no
 * change: `evaluate()` and `enforce()` behave identically, no grant is issued
 * on any existing path, the Governance Record is unchanged, and the frozen v1
 * HTTP surface gains nothing -- deliberately, because a caller must never be
 * able to issue, extend, revoke or exercise its own grant.
 */
export interface AuthorityControlledExecutionOptions {
  /** The real `AocKernel`, composed with `grants`. Every authority, context, policy and obligation determination comes from here. */
  readonly kernel: ExecutionKernelPort;
  /**
   * The same grant declaration the Kernel evaluates under.
   *
   * Supplied rather than inferred because the optional deployment ceiling it
   * may carry must be *one* value: two declarations would mean a grant is
   * contained by whichever one happened to be read.
   * `assertValidGrantDeclaration` runs inside `KernelGrantCapability`, so an
   * unusable declaration fails at composition rather than mid-payment.
   */
  readonly grantCapability: KernelGrantCapability;
  /** The authoritative home of issued grants. Written by issuance, re-read by every exercise. */
  readonly grantStore: BoundedGrantStorePort;
  /** The provider-neutral execution boundary. Invoked only after a usable exercise assessment. */
  readonly executionAdapter: ExecutionAdapter;
  readonly now: () => string;
  /**
   * **Required.** Which authority world each action is in.
   *
   * Not optional at this call site, and that is the hard gate this phase
   * carries forward. A mandate-backed flow whose ceiling is missing must fail
   * closed rather than issue under `validityCeilings: []`, and the only way to
   * guarantee that is to make the composition unable to exist without
   * answering the question. See `authority-binding.ts`.
   */
  readonly resolveAuthorityBinding: GrantAuthorityBindingResolver;
  /**
   * Re-reads the authoritative source authorization at the commit boundary.
   *
   * Synchronous, for the reason the issuance service states: the store calls it
   * inside its critical section with no `await` between the read that decides
   * and the write that records. Omitted, the source is re-checked against the
   * projection this call measured -- which still closes duplicate issuance and
   * preclusion, and still re-proves the **authority** ceiling, because the
   * binding is re-resolved on every commit regardless of this option. A
   * production deployment reading a real decision store supplies one; in this
   * repository that read is `GovernanceStore.getByDecisionId`.
   */
  readonly revalidateSource?: (correlation: GrantCorrelation) => GrantSourceAuthorization | undefined;
}

export interface AuthorityControlledExecutionService {
  /** Evaluate, then issue a bounded grant if -- and only if -- the decision permitted exercise, every blocking obligation is satisfied, and the authority binding is established. */
  authorize(input: AuthorityControlledAuthorizationInput): Promise<AuthorityControlledAuthorizationOutcome>;
  /** Whether an attempted action is covered by its grant right now. A pure read: no provider is contacted and nothing is written. */
  assessExercise(request: GrantExerciseRequest): Promise<BoundedGrantExerciseAssessment>;
  /** Assess and, only on a usable assessment, execute through the adapter. */
  exercise(request: GrantExerciseRequest): Promise<ExecutionOutcome>;
  /** Revoke an issued grant. Immediate: the next exercise reads the revocation and withholds. Never alters the historical authorization. */
  revokeGrant(input: RevokeBoundedGrantRequest): Promise<RevokeBoundedGrantResult>;
}

export interface RevokeBoundedGrantRequest {
  readonly grantId: string;
  readonly reason: GrantRevocationReason;
  readonly issuerRef: string;
  /** Defaults to the injected clock, so a host need not thread one instant through two layers. */
  readonly revokedAt?: string;
}

export type RevokeBoundedGrantResult =
  | { readonly outcome: 'revoked' | 'already-revoked'; readonly revocation: GrantRevocation }
  | { readonly outcome: 'refused'; readonly reasonCodes: readonly GrantReasonCode[] };

/** Adds every ceiling a binding contributes. The bounded arm contributes one `authority` ceiling; the other contributes none, which is ADR rule 4 stated as code rather than as an empty array nobody chose. */
function withAuthorityCeilings(source: GrantSourceAuthorization, binding: GrantAuthorityBinding): GrantSourceAuthorization {
  return grantValidityCeilingsFor(binding).reduce(withGrantValidityCeiling, source);
}

export function createAuthorityControlledExecution(options: AuthorityControlledExecutionOptions): AuthorityControlledExecutionService {
  const { kernel, grantCapability, grantStore, executionAdapter, now, resolveAuthorityBinding, revalidateSource } = options;

  const execution = createGrantExecutionService({ store: grantStore, adapter: executionAdapter, now });

  /**
   * One issuance service per authorization, so the commit guard closes directly
   * over the request and the projection this call measured.
   *
   * The alternative -- one long-lived service with a map keyed by correlation --
   * would have made the guard read shared mutable state that another in-flight
   * authorization could have written, which is precisely the interleaving the
   * commit boundary exists to prevent. The service is a plain object over the
   * same store; constructing one per call costs nothing and owns nothing.
   */
  function issuanceFor(request: KernelEvaluationRequest, measured: GrantSourceAuthorization) {
    return createGrantIssuanceService({
      store: grantStore,
      revalidateSource: (correlation: GrantCorrelation): GrantSourceAuthorization | undefined => {
        // Whatever the host revalidates about the decision, the authority
        // binding is re-resolved here as well. A mandate whose window was
        // shortened between the caller's measurement and the commit refuses the
        // issuance rather than committing a grant that would outlive it.
        const base = revalidateSource === undefined ? measured : revalidateSource(correlation);
        if (base === undefined) return undefined;
        const binding = resolveAuthorityBinding({ request, correlation, evaluatedAt: base.evaluatedAt, phase: 'commit' });
        // A binding that has become unresolvable or malformed at commit time is
        // an authority nobody can currently vouch for. `undefined` is what the
        // issuance service reads as "the authoritative source could no longer
        // be read", and it refuses -- the closed direction.
        if (binding === undefined || !isWellFormedGrantAuthorityBinding(binding)) return undefined;
        return withAuthorityCeilings(base, binding);
      },
    });
  }

  return {
    async authorize(input: AuthorityControlledAuthorizationInput): Promise<AuthorityControlledAuthorizationOutcome> {
      const decision: KernelEvaluationResult = await kernel.evaluate(input.request, input.options);

      if (decision.grants === undefined) {
        throw new ExecutionGovernanceError(
          'EXECUTION_KERNEL_NOT_GRANT_AWARE',
          'The Kernel handed to createAuthorityControlledExecution() was composed without KernelGrantOptions, so its result carries no grant projection to issue from.',
          { decisionId: decision.decisionId },
        );
      }

      // The projection layer E is allowed to see, built by the Kernel's own
      // adapter from an already-frozen result. Never assembled from request
      // data, and never mutated here.
      const measured = deriveGrantSourceAuthorization(grantCapability, input.request, decision);

      const binding = resolveAuthorityBinding({ request: input.request, correlation: measured.correlation, evaluatedAt: measured.evaluatedAt, phase: 'issuance' });
      if (binding === undefined) {
        return { outcome: 'authority-binding-unresolved', decision, reasonCodes: [AUTHORITY_BINDING_REASON_CODES.AUTHORITY_BINDING_UNRESOLVED] };
      }
      if (!isWellFormedGrantAuthorityBinding(binding)) {
        return { outcome: 'authority-binding-unresolved', decision, reasonCodes: [AUTHORITY_BINDING_REASON_CODES.AUTHORITY_BINDING_MALFORMED] };
      }

      const source = withAuthorityCeilings(measured, binding);
      const issued = await issuanceFor(input.request, measured).issueGrant({
        source,
        ...(input.requestedBounds !== undefined ? { requestedBounds: input.requestedBounds } : {}),
        // The holder is the subject the authorization was evaluated for. There
        // is no delegation at this layer and no field here that could express
        // one -- the host does not get to name a different holder.
        subject: source.subject,
        correlation: source.correlation,
        issuedAt: now(),
        expiresAt: input.grantExpiresAt,
      });

      if (issued.outcome === 'refused') {
        return {
          outcome: 'grant-withheld',
          decision,
          reasonCodes: issued.reasonCodes,
          authorityBinding: binding,
          ...(issued.effectiveValidityCeiling !== undefined ? { effectiveValidityCeiling: issued.effectiveValidityCeiling } : {}),
        };
      }

      return {
        outcome: 'grant-issued',
        decision,
        grant: issued.grant,
        issuance: issued.outcome,
        authorityBinding: binding,
        ...(issued.effectiveValidityCeiling !== undefined ? { effectiveValidityCeiling: issued.effectiveValidityCeiling } : {}),
      };
    },

    assessExercise(request: GrantExerciseRequest): Promise<BoundedGrantExerciseAssessment> {
      return execution.assess(request);
    },

    exercise(request: GrantExerciseRequest): Promise<ExecutionOutcome> {
      return execution.exercise(request);
    },

    revokeGrant(input: RevokeBoundedGrantRequest): Promise<RevokeBoundedGrantResult> {
      // Revocation touches no source authorization, so it needs no
      // revalidation: a grant is revoked on its own identity, and the store's
      // own idempotency is what makes a second revocation return the first.
      return createGrantIssuanceService({ store: grantStore }).revokeGrant({
        grantId: input.grantId,
        reason: input.reason,
        issuerRef: input.issuerRef,
        revokedAt: input.revokedAt ?? now(),
      });
    },
  };
}
