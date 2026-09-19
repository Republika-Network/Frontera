import {
  createGrantIssuanceService,
  withGrantValidityCeiling,
  type BoundedGrantStorePort,
  type GrantCorrelation,
  type GrantSourceAuthorization,
  type RequestedGrantBounds,
} from '../../features/grant-runtime/index.js';
import type { KernelEvaluationOptions, KernelEvaluationRequest, KernelEvaluationResult } from '../../kernel/index.js';
import { KernelGrantCapability, deriveGrantSourceAuthorization } from '../../kernel/orchestration/grant-adapter.js';
import { grantValidityCeilingsFor, isWellFormedGrantAuthorityBinding, type GrantAuthorityBinding } from './authority-binding.js';
import { ExecutionGovernanceError } from './errors.js';
import {
  AUTHORITY_BINDING_REASON_CODES,
  type AuthorityControlledAuthorizationOutcome,
  type ExecutionKernelPort,
  type GrantAuthorityBindingResolver,
} from './contracts.js';

/**
 * The two halves of `AuthorityControlledExecutionService.authorize()`, split so
 * a caller can put a durable step **between** them.
 *
 * ```
 * authorize()            = evaluate()  ->                       issueFromDecision()
 * governed-action path   = evaluate()  ->  persist + re-read  -> issueFromDecision()
 * ```
 *
 * Nothing moved here changed. The Kernel is still the only decision producer,
 * the grant projection is still the Kernel's own `deriveGrantSourceAuthorization`,
 * the declaration-mismatch and grant-awareness checks are the same checks, the
 * authority binding is still resolved at issuance and re-resolved inside the
 * store's commit boundary, and every outcome still carries the decision it was
 * handed by reference.
 *
 * ## Internal, on purpose
 *
 * `issueFromDecision()` accepts a `KernelEvaluationResult` it did not produce.
 * That is exactly what the Governed Action Orchestrator needs — it must issue
 * from the decision reconstructed out of the committed Governance Record, not
 * from the transient one — and exactly what no caller outside trusted
 * composition may ever be handed, because a caller able to supply a decision
 * could supply `status: 'allowed'`. So this module is **not** re-exported from
 * `execution-governance/index.ts` or from any public entrypoint; only the
 * composition root and the orchestrator import it, and
 * `governed-action-structure.test.ts` fails the build if that changes.
 */
export interface AuthorityControlledIssuanceCoreOptions {
  readonly kernel: ExecutionKernelPort;
  readonly grantCapability: KernelGrantCapability;
  readonly grantStore: BoundedGrantStorePort;
  readonly now: () => string;
  readonly resolveAuthorityBinding: GrantAuthorityBindingResolver;
}

export interface IssueFromDecisionInput {
  /** The evaluated request. The grant's scope is projected from it by the Kernel's own adapter. */
  readonly request: KernelEvaluationRequest;
  /** The decision to issue from. On the legacy path, the transient Kernel result; on the governed-action path, the one reconstructed from the committed Governance Record. */
  readonly decision: KernelEvaluationResult;
  /** Trusted issuer expiry. Host input only — see `AuthorityControlledAuthorizationInput.grantExpiresAt`. */
  readonly grantExpiresAt: string;
  readonly requestedBounds?: RequestedGrantBounds;
  /**
   * Re-reads the authoritative source authorization inside the store's commit
   * boundary. Synchronous for the reason `GrantIssuanceServiceOptions` states.
   * Omitted, the source is re-checked against the projection measured from
   * `decision`. The authority binding is re-resolved at commit regardless.
   */
  readonly revalidateSource?: (correlation: GrantCorrelation) => GrantSourceAuthorization | undefined;
}

export interface AuthorityControlledIssuanceCore {
  /** `kernel.evaluate()`, unchanged. Named here so the orchestrator reaches the Kernel through the same port the legacy path does. */
  evaluate(request: KernelEvaluationRequest, options?: KernelEvaluationOptions): Promise<KernelEvaluationResult>;
  /** The Kernel's own grant projection of a decision under this composition's declaration. A read. */
  deriveSource(request: KernelEvaluationRequest, decision: KernelEvaluationResult): GrantSourceAuthorization;
  /** Issue a bounded grant from an already-evaluated decision, if — and only if — it permits exercise, every blocking obligation is satisfied, and the authority binding is established. */
  issueFromDecision(input: IssueFromDecisionInput): Promise<AuthorityControlledAuthorizationOutcome>;
}

/** Adds every ceiling a binding contributes. The bounded arm contributes one `authority` ceiling; the other contributes none, which is ADR rule 4 stated as code rather than as an empty array nobody chose. */
function withAuthorityCeilings(source: GrantSourceAuthorization, binding: GrantAuthorityBinding): GrantSourceAuthorization {
  return grantValidityCeilingsFor(binding).reduce(withGrantValidityCeiling, source);
}

/**
 * Whether two bindings describe the same authority state, exactly.
 *
 * Every field, on both arms -- a different `authorityRef` with an identical
 * horizon is a *different authority*, and a shortened horizon under the same
 * ref is a *changed* one. Neither may be committed under provenance recorded
 * for the other, so the comparison is equality and not containment.
 */
function grantAuthorityBindingsMatch(left: GrantAuthorityBinding, right: GrantAuthorityBinding): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === 'bounded-authority' && right.kind === 'bounded-authority') {
    return left.authorityKind === right.authorityKind && left.authorityRef === right.authorityRef && left.expiresAt === right.expiresAt;
  }
  if (left.kind === 'no-temporal-authority-bound' && right.kind === 'no-temporal-authority-bound') {
    return left.sourceKind === right.sourceKind && left.justification === right.justification;
  }
  return false;
}

/** A deterministic form for comparing two ceiling lists. Sorted, so assembly order never reads as a mismatch. */
function serializeValidityCeilings(ceilings: readonly { readonly source: string; readonly notAfter: string }[]): string {
  return [...ceilings]
    .map((ceiling) => `${ceiling.source}@${ceiling.notAfter}`)
    .sort()
    .join('|');
}

export function createAuthorityControlledIssuanceCore(options: AuthorityControlledIssuanceCoreOptions): AuthorityControlledIssuanceCore {
  const { kernel, grantCapability, grantStore, now, resolveAuthorityBinding } = options;

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
  function issuanceFor(
    request: KernelEvaluationRequest,
    measured: GrantSourceAuthorization,
    measuredBinding: GrantAuthorityBinding,
    revalidateSource: IssueFromDecisionInput['revalidateSource'],
  ) {
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
        // **Any** change to the binding refuses, not only one that would break
        // containment.
        //
        // The grant about to be committed already carries `sourceDigest` over
        // the *measured* source, and the outcome about to be returned reports
        // the *measured* binding and ceiling. A commit-time binding that
        // differs but still permits -- a mandate shortened from T+30m to T+15m
        // while the grant ends at T+10m, or a different `authorityRef` with a
        // sufficient horizon -- would commit an artifact whose recorded
        // provenance names an authority state that no longer held at the moment
        // it was written. That is the same defect `BoundedGrantStorePort`'s
        // "correlation integrity" guarantee exists to prevent, one field over,
        // and Evidence would later read the stale value as fact.
        //
        // Rebuilding the artifact from the commit-time binding is not the
        // alternative: grant identity and digest are derived before the
        // critical section, so rebuilding inside it would mint a different
        // grant than the one the guard was asked about. Refusing is the
        // deterministic direction, and re-issuing against the current authority
        // is one more call.
        if (!grantAuthorityBindingsMatch(measuredBinding, binding)) {
          return undefined;
        }
        return withAuthorityCeilings(base, binding);
      },
    });
  }

  return {
    evaluate(request: KernelEvaluationRequest, evaluationOptions?: KernelEvaluationOptions): Promise<KernelEvaluationResult> {
      return kernel.evaluate(request, evaluationOptions);
    },

    deriveSource(request: KernelEvaluationRequest, decision: KernelEvaluationResult): GrantSourceAuthorization {
      return deriveGrantSourceAuthorization(grantCapability, request, decision);
    },

    async issueFromDecision(input: IssueFromDecisionInput): Promise<AuthorityControlledAuthorizationOutcome> {
      const { request, decision } = input;

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
      const measured = deriveGrantSourceAuthorization(grantCapability, request, decision);

      // The Kernel evaluated under *its* grant declaration and reported the
      // ceilings that declaration produced; the projection above recomputed
      // them from the declaration this composition was handed. A host using the
      // documented custom `kernel` option can supply two different ones, and
      // then a Kernel configured with a five-minute maximum lifetime would
      // report that ceiling on the decision while issuance -- reading a
      // capability with no limit -- omitted it and minted a longer-lived grant.
      //
      // So they are compared, and a difference is a wiring defect rather than a
      // governance outcome: it fails where the deployment is composed, loudly,
      // instead of silently widening one grant at a time. This is the error
      // `EXECUTION_GRANT_DECLARATION_MISMATCH` was declared for.
      const reported = serializeValidityCeilings(decision.grants.validityCeilings);
      const derived = serializeValidityCeilings(measured.validityCeilings);
      if (reported !== derived) {
        throw new ExecutionGovernanceError(
          'EXECUTION_GRANT_DECLARATION_MISMATCH',
          'The grant declaration this composition was given differs from the one its Kernel evaluates under, so the decision and the issuance would be contained by different deployment ceilings.',
          { decisionId: decision.decisionId, reportedByKernel: reported, derivedFromCapability: derived },
        );
      }

      const binding = resolveAuthorityBinding({ request, correlation: measured.correlation, evaluatedAt: measured.evaluatedAt, phase: 'issuance' });
      if (binding === undefined) {
        return { outcome: 'authority-binding-unresolved', decision, reasonCodes: [AUTHORITY_BINDING_REASON_CODES.AUTHORITY_BINDING_UNRESOLVED] };
      }
      if (!isWellFormedGrantAuthorityBinding(binding)) {
        return { outcome: 'authority-binding-unresolved', decision, reasonCodes: [AUTHORITY_BINDING_REASON_CODES.AUTHORITY_BINDING_MALFORMED] };
      }

      const source = withAuthorityCeilings(measured, binding);
      const issued = await issuanceFor(request, measured, binding, input.revalidateSource).issueGrant({
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
  };
}
