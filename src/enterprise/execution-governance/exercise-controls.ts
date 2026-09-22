import {
  createExerciseControlGate,
  type ExerciseAuthorityBindingDigestResolver,
  type ExerciseAuthorityBindingQuery,
  type ExerciseControlGate,
  type ExerciseControlLedgerPort,
  type ExerciseControlPolicy,
} from '../../features/exercise-control-runtime/index.js';
import {
  GRANT_BOUNDED_AUTHORITY_KINDS,
  GRANT_UNBOUNDED_AUTHORITY_SOURCE_KINDS,
  grantAuthorityBindingDigest,
  isWellFormedGrantAuthorityBinding,
  type GrantAuthorityBinding,
  type GrantBoundedAuthorityKind,
  type GrantUnboundedAuthoritySourceKind,
} from './authority-binding.js';
import { ExecutionGovernanceError } from './errors.js';

/**
 * Aggregate / velocity exercise controls and exercise-time authority-binding
 * revalidation — the Enterprise half of P7.
 *
 * See `docs/enterprise/AOC_EXERCISE_CONTROLS.md` and
 * `docs/architecture/ADR-EXERCISE-AGGREGATE-CONTROLS.md`.
 *
 * ## Everything here is trusted host composition
 *
 * The policy, the exercise-time binding resolver and the ledger are supplied by
 * the deployment's own code at composition. Nothing a caller sends —
 * `GovernedActionIntent`, its `assertedContext`, the SDK, a header — can name a
 * limit, a bucket, a maximum, a window, a reservation or a binding digest, and
 * nothing here reads anything a caller sent.
 */

/**
 * The exercise-time counterpart of `GrantAuthorityBindingResolver`, and
 * deliberately a **separate** port.
 *
 * The issuance resolver answers from a `KernelEvaluationRequest`. At exercise
 * time there is no such request, and synthesizing one — or faking the context
 * it would carry — would be inventing the very input the binding is meant to be
 * resolved from. This resolver is therefore given only what genuinely exists
 * at exercise time: the grant's own identity, holder, validity and correlation,
 * and the attempt fields the grant-exercise assessment already proved inside
 * the grant.
 *
 * **Synchronous and read-only.** It returns the binding that holds **now**, or
 * `undefined` when it cannot tell — which withholds. The binding is compared to
 * the grant's recorded provenance for exact equality.
 */
export type ExerciseAuthorityBindingResolver = (query: ExerciseAuthorityBindingQuery) => GrantAuthorityBinding | undefined;

/**
 * P7's opt-in block on Authority-Controlled Execution. All three members are
 * trusted host composition.
 *
 * The consumption store is named `reservationLedger` at this layer: this
 * directory stays provider-neutral by rule (no chain, wallet or signer
 * vocabulary), and the name says what it holds — reservations of aggregate
 * capacity — rather than borrowing a word this module otherwise refuses. The
 * Enterprise composition option keeps the shorter `ledger`.
 */
export interface AuthorityControlledExerciseControls {
  /** **Required.** Which aggregate limits apply to an exercise. Synchronous, no I/O. */
  readonly policy: ExerciseControlPolicy;
  /** **Required.** The binding that holds at exercise time. Synchronous, read-only. */
  readonly revalidateAuthorityBinding: ExerciseAuthorityBindingResolver;
  /** **Required here.** The authoritative consumption state. The Enterprise composition root builds the durable SQLite implementation when a host supplies none. */
  readonly reservationLedger: ExerciseControlLedgerPort;
}

function readOwn(source: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(source, key);
  if (descriptor === undefined || !('value' in descriptor)) return undefined;
  return descriptor.value as unknown;
}

/**
 * A fresh, validated copy of whatever the host resolver returned, or
 * `undefined`. Read field by field, data properties only, so a getter, a
 * `Proxy` or a promise cannot hand one value to validation and another to the
 * digest.
 */
function snapshotBinding(returned: unknown): GrantAuthorityBinding | undefined {
  if (returned === null || typeof returned !== 'object' || Array.isArray(returned)) return undefined;
  const kind = readOwn(returned, 'kind');
  let binding: GrantAuthorityBinding;
  if (kind === 'bounded-authority') {
    const authorityKind = readOwn(returned, 'authorityKind');
    const authorityRef = readOwn(returned, 'authorityRef');
    const expiresAt = readOwn(returned, 'expiresAt');
    if (typeof authorityKind !== 'string' || typeof authorityRef !== 'string' || typeof expiresAt !== 'string') return undefined;
    if (!(GRANT_BOUNDED_AUTHORITY_KINDS as readonly string[]).includes(authorityKind)) return undefined;
    binding = { kind, authorityKind: authorityKind as GrantBoundedAuthorityKind, authorityRef, expiresAt };
  } else if (kind === 'no-temporal-authority-bound') {
    const sourceKind = readOwn(returned, 'sourceKind');
    const justification = readOwn(returned, 'justification');
    if (typeof sourceKind !== 'string' || typeof justification !== 'string') return undefined;
    if (!(GRANT_UNBOUNDED_AUTHORITY_SOURCE_KINDS as readonly string[]).includes(sourceKind)) return undefined;
    binding = { kind, sourceKind: sourceKind as GrantUnboundedAuthoritySourceKind, justification };
  } else {
    return undefined;
  }
  return isWellFormedGrantAuthorityBinding(binding) ? binding : undefined;
}

/**
 * The bridge from the host's resolver — which speaks `GrantAuthorityBinding` —
 * to the exercise-control runtime — which speaks only opaque digests.
 *
 * `undefined`, a throw, a promise, a malformed binding: all `undefined`, which
 * the runtime reports as `EXERCISE_CONTROL_AUTHORITY_BINDING_UNVERIFIABLE`. A
 * well-formed binding becomes its canonical digest, which the runtime compares
 * to the grant's.
 */
export function exerciseAuthorityBindingDigestResolver(resolver: ExerciseAuthorityBindingResolver): ExerciseAuthorityBindingDigestResolver {
  return (query) => {
    let binding: GrantAuthorityBinding | undefined;
    try {
      binding = snapshotBinding(resolver(query));
    } catch {
      return undefined;
    }
    return binding === undefined ? undefined : grantAuthorityBindingDigest(binding);
  };
}

function refuse(message: string): never {
  throw new ExecutionGovernanceError('EXECUTION_EXERCISE_CONTROLS_INVALID', message);
}

/** Refuses a block whose trusted callbacks could never work, at composition — never in the middle of a payment. */
export function assertValidExerciseControlCallbacks(controls: unknown, label: string): void {
  if (controls === null || typeof controls !== 'object') refuse(`${label} must be an object stating policy and revalidateAuthorityBinding.`);
  const block = controls as Partial<Record<'policy' | 'revalidateAuthorityBinding', unknown>>;
  if (typeof block.policy !== 'function') refuse(`${label}.policy is required and must be a synchronous trusted function; there is no default aggregate policy.`);
  if (typeof block.revalidateAuthorityBinding !== 'function') {
    refuse(`${label}.revalidateAuthorityBinding is required and must be a synchronous trusted function; a grant whose authority cannot be revalidated at exercise time cannot execute.`);
  }
}

/** Refuses a consumption store that does not implement the port. */
export function assertValidExerciseControlStore(store: unknown, label: string): void {
  if (store === null || typeof store !== 'object') refuse(`${label} must implement ExerciseControlLedgerPort.`);
  const port = store as Partial<Record<'reserve' | 'settle' | 'release' | 'read', unknown>>;
  for (const method of ['reserve', 'settle', 'release', 'read'] as const) {
    if (typeof port[method] !== 'function') refuse(`${label} must implement ExerciseControlLedgerPort.${method}().`);
  }
}

/** The gate the exercise service consults, composed from the trusted block and this composition's clock. */
export function createAuthorityControlledExerciseControlGate(controls: AuthorityControlledExerciseControls, now: () => string): ExerciseControlGate {
  assertValidExerciseControlCallbacks(controls, 'exerciseControls');
  assertValidExerciseControlStore(controls.reservationLedger, 'exerciseControls.reservationLedger');
  return createExerciseControlGate({
    policy: controls.policy,
    authorityBinding: exerciseAuthorityBindingDigestResolver(controls.revalidateAuthorityBinding),
    reservationLedger: controls.reservationLedger,
    now,
  });
}
