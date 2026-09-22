import type { EmergencyControlReaderPort } from '../../features/emergency-control-runtime/index.js';
import {
  createGrantIssuanceService,
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
import type { KernelEvaluationResult } from '../../kernel/index.js';
import type { KernelGrantCapability } from '../../kernel/orchestration/grant-adapter.js';
import type { AuthorityEventRecorder } from '../authority-event-stream/recorder.js';
import {
  type AuthorityControlledAuthorizationInput,
  type AuthorityControlledAuthorizationOutcome,
  type ExecutionKernelPort,
  type GrantAuthorityBindingResolver,
} from './contracts.js';
import { createAuthorityControlledIssuanceCore } from './issuance-core.js';
import { createAuthorityControlledExerciseControlGate, type AuthorityControlledExerciseControls } from './exercise-controls.js';

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
  /**
   * The durable operational safety interlock, when the deployment composed one.
   *
   * **Read-only by type.** This composition is handed
   * `EmergencyControlReaderPort` and never the store behind it: an execution
   * path able to reach `activate`/`release` could disable the interlock that
   * governs it, and `emergency-control-boundaries.test.ts` fails the build if
   * a mutation method becomes reachable from here.
   *
   * It is consulted at two of the four lifecycle checkpoints this composition
   * owns — inside the grant store's synchronous commit guard, and after the
   * authoritative grant re-read but before the provider. The other two belong
   * to the Governed Action Orchestrator (admission) and to the execution
   * adapter registry (the adapter-scoped stop, after routing).
   *
   * **Omitting it changes nothing.** No check runs, no permissive stand-in is
   * invented, and every existing behaviour is byte-identical.
   */
  readonly emergencyControl?: EmergencyControlReaderPort;
  /**
   * P7 — aggregate / velocity exercise controls and exercise-time
   * authority-binding revalidation, when the deployment composed them.
   *
   * **Trusted host composition, in its entirety.** The policy decides which
   * aggregate limits apply, the resolver answers which authority binding holds
   * at exercise time, and the ledger is the authoritative consumption state.
   * Nothing on any caller path can reach or name any of them.
   *
   * When composed, every exercise additionally requires, in order: the
   * binding to equal the grant's recorded provenance exactly; a valid policy
   * answer; an atomic reservation across every applicable limit; the binding
   * to still be equal; and the emergency control to still be clear — and only
   * then is the adapter invoked. The reservation is settled or released from
   * the outcome. It **narrows only**: nothing here can make an unusable
   * exercise usable.
   *
   * **Omitting it changes nothing.** No reservation, no revalidation, no
   * ledger, and every existing behaviour is byte-identical.
   */
  readonly exerciseControls?: AuthorityControlledExerciseControls;
  /**
   * P8 — the canonical authority event stream's **write-only** recorder, when
   * the composition root composed one. Never a host option.
   *
   * Told, after the authoritative store or ledger proved it, that a grant was
   * revoked or that a P7 reservation was admitted, settled or released. It
   * returns nothing and every call is wrapped, so omitting it — or composing
   * one that fails — changes no revocation, reservation, finalization or
   * outcome.
   */
  readonly evidence?: AuthorityEventRecorder;
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

export function createAuthorityControlledExecution(options: AuthorityControlledExecutionOptions): AuthorityControlledExecutionService {
  const { kernel, grantCapability, grantStore, executionAdapter, now, resolveAuthorityBinding, revalidateSource } = options;
  const emergencyControl = options.emergencyControl;
  // Composed once, and refused here — at composition — when the block cannot
  // work: no policy, no exercise-time resolver, or a ledger that is not a ledger.
  const evidence = options.evidence;
  const exerciseControl = options.exerciseControls === undefined ? undefined : createAuthorityControlledExerciseControlGate(options.exerciseControls, now, evidence);

  const execution = createGrantExecutionService({
    store: grantStore,
    adapter: executionAdapter,
    now,
    ...(emergencyControl !== undefined ? { emergencyControl } : {}),
    ...(exerciseControl !== undefined ? { exerciseControl } : {}),
  });

  // The authorization internals live in `issuance-core.ts` so the Governed
  // Action Orchestrator can commit the decision *between* evaluation and
  // issuance. `authorize()` composes the same two halves with nothing in
  // between, which is exactly what it always did.
  const core = createAuthorityControlledIssuanceCore({
    kernel,
    grantCapability,
    grantStore,
    now,
    resolveAuthorityBinding,
    ...(emergencyControl !== undefined ? { emergencyControl } : {}),
  });

  return {
    async authorize(input: AuthorityControlledAuthorizationInput): Promise<AuthorityControlledAuthorizationOutcome> {
      const decision: KernelEvaluationResult = await core.evaluate(input.request, input.options);
      return core.issueFromDecision({
        request: input.request,
        decision,
        grantExpiresAt: input.grantExpiresAt,
        ...(input.requestedBounds !== undefined ? { requestedBounds: input.requestedBounds } : {}),
        ...(revalidateSource !== undefined ? { revalidateSource } : {}),
      });
    },

    assessExercise(request: GrantExerciseRequest): Promise<BoundedGrantExerciseAssessment> {
      return execution.assess(request);
    },

    exercise(request: GrantExerciseRequest): Promise<ExecutionOutcome> {
      return execution.exercise(request);
    },

    async revokeGrant(input: RevokeBoundedGrantRequest): Promise<RevokeBoundedGrantResult> {
      // Revocation touches no source authorization, so it needs no
      // revalidation: a grant is revoked on its own identity, and the store's
      // own idempotency is what makes a second revocation return the first.
      const outcome = await createGrantIssuanceService({ store: grantStore }).revokeGrant({
        grantId: input.grantId,
        reason: input.reason,
        issuerRef: input.issuerRef,
        revokedAt: input.revokedAt ?? now(),
      });
      // Evidence of the revocation the store now holds — the first one, on a
      // repeat. Enqueued and returned from immediately: the authoritative result
      // never waits for durable projection, so a stream that is slow or stuck
      // cannot delay the confirmation, and the next exercise reads the
      // revocation from the grant store regardless.
      if (evidence !== undefined && (outcome.outcome === 'revoked' || outcome.outcome === 'already-revoked')) {
        try {
          evidence.grantRevoked(outcome.revocation);
        } catch {
          // Evidence never changes a revocation that was already recorded.
        }
      }
      return outcome;
    },
  };
}
