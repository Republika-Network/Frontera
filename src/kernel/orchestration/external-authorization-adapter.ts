import type { ExternalAuthorizationInput, ExternalAuthorizationProvider } from '../contracts/ports.js';
import type { KernelEvaluationRequest } from '../contracts/kernel-request.js';
import type { ExternalAuthorizationEvaluation, KernelEvaluationResult } from '../contracts/kernel-result.js';
import { KernelConfigurationError } from '../errors/kernel-errors.js';
import { AOC_KERNEL_REASON_CODES, type AocKernelReasonCode } from '../reason-codes/reason-codes.js';

/**
 * The optional deny-only external authorization step, kept out of `AocKernel`
 * itself for the reason every other step is: the class stays a composition
 * boundary rather than growing a second evaluation body.
 *
 * ## Why this narrows and never widens
 *
 * The port's answer is reduced to one of five closed outcomes before anything
 * reads it, and only `allowed` leaves a result untouched. Every other outcome
 * — `denied`, `unavailable`, `timeout`, `invalid_response` — turns an
 * `allowed` result into `denied` and leaves any other result exactly as it
 * was. There is no outcome, and no response shape, that changes a denial, an
 * `approval_required` or an `indeterminate`, and none that adds a permission:
 * the response type has no field to carry one, and a response with any field
 * beyond `decision` is malformed.
 *
 * ## The bound, and the late answer
 *
 * The operator configures how long the Kernel waits. When the bound elapses
 * the outcome is fixed as `timeout`, the port's `signal` is aborted, and the
 * pending call is left to settle into a handler that discards it. An `allow`
 * arriving afterwards has nowhere to go: the outcome was already decided and
 * is never re-read, so a slow external authority can delay a decision by at
 * most the bound and can never turn a timeout into an execution.
 *
 * The bound is enforced on elapsed monotonic time, not on the timer alone. A
 * provider that blocks the event loop longer than the bound keeps the timer
 * from firing, and its answer would otherwise win the race; measured against
 * the instant taken just before the call, that answer is a `timeout` too.
 */

/** The longest bound an operator may configure. A veto that takes longer than this is an outage, and treating it as one is the fail-closed reading. */
export const EXTERNAL_AUTHORIZATION_MAX_TIMEOUT_MS = 30_000;

/** The external authorization capability's configuration: the port, and how long the Kernel waits for it. */
export interface KernelExternalAuthorizationOptions {
  readonly provider: ExternalAuthorizationProvider;
  /** Required: an integer number of milliseconds in [1, `EXTERNAL_AUTHORIZATION_MAX_TIMEOUT_MS`]. There is no default, because "wait forever" is not a bound. */
  readonly timeoutMs: number;
}

export class KernelExternalAuthorizationCapability {
  readonly provider: ExternalAuthorizationProvider;
  readonly timeoutMs: number;

  constructor(options: KernelExternalAuthorizationOptions) {
    if (options === null || typeof options !== 'object' || options.provider === null || typeof options.provider !== 'object' || typeof options.provider.authorize !== 'function') {
      throw new KernelConfigurationError('externalAuthorization requires a provider with an authorize() method.');
    }
    if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > EXTERNAL_AUTHORIZATION_MAX_TIMEOUT_MS) {
      throw new KernelConfigurationError(`externalAuthorization.timeoutMs must be an integer between 1 and ${EXTERNAL_AUTHORIZATION_MAX_TIMEOUT_MS}.`);
    }
    this.provider = options.provider;
    this.timeoutMs = options.timeoutMs;
  }
}

type ExternalOutcome = 'allowed' | 'denied' | 'unavailable' | 'timeout' | 'invalid_response';

const OUTCOME_REASON_CODE: Readonly<Record<Exclude<ExternalOutcome, 'allowed'>, AocKernelReasonCode>> = {
  denied: AOC_KERNEL_REASON_CODES.EXTERNAL_AUTHORIZATION_DENIED,
  unavailable: AOC_KERNEL_REASON_CODES.EXTERNAL_AUTHORIZATION_UNAVAILABLE,
  timeout: AOC_KERNEL_REASON_CODES.EXTERNAL_AUTHORIZATION_TIMEOUT,
  invalid_response: AOC_KERNEL_REASON_CODES.EXTERNAL_AUTHORIZATION_INVALID_RESPONSE,
};

/** Fixed per outcome, so a summary never carries anything the external authority said. */
const OUTCOME_SUMMARY: Readonly<Record<Exclude<ExternalOutcome, 'allowed'>, string>> = {
  denied: 'The configured external authorization port denied an action the Kernel had allowed.',
  unavailable: 'The configured external authorization port failed instead of answering; an unanswered external check denies.',
  timeout: 'The configured external authorization port did not answer within its configured bound; the action is denied.',
  invalid_response: 'The configured external authorization port returned a response that is not a valid decision; the action is denied.',
};

/** What the port's answer came to, before it has been folded into any decision. */
export interface ExternalAuthorizationFacts {
  readonly outcome: ExternalOutcome;
  /** `true` only for `allowed`: the port raised no objection. */
  readonly permits: boolean;
}

/**
 * Reads a response exactly once and accepts exactly two shapes. Anything else
 * — a primitive, an array, a class instance, an extra field, a getter that
 * throws — is `invalid_response`.
 */
function classify(response: unknown): ExternalOutcome {
  try {
    if (response === null || typeof response !== 'object' || Array.isArray(response)) return 'invalid_response';
    const prototype = Object.getPrototypeOf(response);
    if (prototype !== Object.prototype && prototype !== null) return 'invalid_response';
    const keys = Reflect.ownKeys(response);
    if (keys.length !== 1 || keys[0] !== 'decision') return 'invalid_response';
    const descriptor = Object.getOwnPropertyDescriptor(response, 'decision');
    if (descriptor === undefined || !('value' in descriptor)) return 'invalid_response';
    if (descriptor.value === 'allow') return 'allowed';
    if (descriptor.value === 'deny') return 'denied';
    return 'invalid_response';
  } catch {
    return 'invalid_response';
  }
}

function toInput(request: KernelEvaluationRequest, at: string, signal: AbortSignal): ExternalAuthorizationInput {
  return Object.freeze({
    requestId: request.requestId,
    actorId: request.actor.id,
    trustDomainId: request.actor.trustDomainId,
    ...(request.organization?.id !== undefined ? { organizationId: request.organization.id } : {}),
    action: request.action.type,
    ...(request.action.capability !== undefined ? { capability: request.action.capability } : {}),
    resourceScope: request.action.resourceScope,
    ...(request.target?.type !== undefined ? { targetType: request.target.type } : {}),
    ...(request.target?.id !== undefined ? { targetId: request.target.id } : {}),
    at,
    signal,
  });
}

/**
 * Asks the port, within the configured bound, and reduces whatever happens to
 * one closed outcome. Never throws and never rejects.
 *
 * Returns `undefined` when no capability is configured, which is what keeps
 * kernel behaviour byte-identical to this layer not existing.
 */
export async function resolveExternalAuthorization(
  capability: KernelExternalAuthorizationCapability | undefined,
  request: KernelEvaluationRequest,
  at: string,
): Promise<ExternalAuthorizationFacts | undefined> {
  if (capability === undefined) return undefined;

  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<ExternalOutcome>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), capability.timeoutMs);
  });

  // Monotonic, and taken immediately before the provider runs. The timer above
  // cannot fire while the provider blocks the event loop, so an answer can win
  // the race after the bound has already elapsed; the elapsed-time check below
  // is what enforces the bound, and the timer only stops the wait for a
  // provider that never answers.
  const startedAt = performance.now();
  let answer: Promise<ExternalOutcome>;
  try {
    // `Promise.resolve` adopts a thenable or wraps a plain value; both handlers
    // are attached here, before the race, so a rejection arriving after the
    // bound elapsed is consumed rather than surfacing as unhandled.
    answer = Promise.resolve(capability.provider.authorize(toInput(request, at, controller.signal))).then(classify, () => 'unavailable' as const);
  } catch {
    answer = Promise.resolve('unavailable');
  }

  let outcome: ExternalOutcome;
  try {
    outcome = await Promise.race([answer, timeout]);
  } finally {
    clearTimeout(timer);
  }
  // Checked before any answer is accepted: whatever settled first, an answer
  // that took the whole bound or longer is a timeout. Every outcome it
  // replaces denies too, so only the reason code changes for a late denial.
  if (performance.now() - startedAt >= capability.timeoutMs) outcome = 'timeout';
  if (outcome === 'timeout') controller.abort();
  return { outcome, permits: outcome === 'allowed' };
}

/**
 * Folds resolved facts into a result. Only `allowed` can be narrowed; every
 * other status is returned with the facts recorded and nothing else changed.
 *
 * On a narrowing, the original reason codes are kept after the new one, as the
 * governed-authority step keeps them: a reviewer must still see that the
 * Kernel's own chain passed, because "the Kernel allowed and the external
 * authority vetoed" and "the Kernel denied" are different facts.
 */
export function applyExternalAuthorizationStep<TResult extends KernelEvaluationResult>(facts: ExternalAuthorizationFacts | undefined, result: TResult): TResult {
  if (facts === undefined) return result;

  const narrows = result.status === 'allowed' && !facts.permits;
  const reasonCode = facts.outcome === 'allowed' ? undefined : OUTCOME_REASON_CODE[facts.outcome];
  const evaluation: ExternalAuthorizationEvaluation = {
    performed: true,
    outcome: facts.outcome,
    narrowed: narrows,
    ...(reasonCode !== undefined ? { reasonCode } : {}),
  };
  const annotated = withTraceStep({ ...result, externalAuthorization: evaluation }, facts.permits ? 'passed' : 'failed', reasonCode);
  if (!narrows || facts.outcome === 'allowed' || reasonCode === undefined) return annotated;

  return {
    ...annotated,
    status: 'denied',
    reasonCodes: [reasonCode, ...result.reasonCodes.filter((code) => code !== reasonCode)],
    summary: OUTCOME_SUMMARY[facts.outcome],
  };
}

/**
 * Records that the port was configured and deliberately not asked, because the
 * Kernel had not allowed the action. `evaluate()` uses it: a veto of an outcome
 * that is not an allow has nothing to veto.
 */
export function recordExternalAuthorizationNotConsulted<TResult extends KernelEvaluationResult>(capability: KernelExternalAuthorizationCapability | undefined, result: TResult): TResult {
  if (capability === undefined) return result;
  return withTraceStep({ ...result, externalAuthorization: { performed: false, outcome: 'not_consulted', narrowed: false } }, 'skipped', undefined);
}

function withTraceStep<TResult extends KernelEvaluationResult>(result: TResult, status: 'passed' | 'failed' | 'skipped', reasonCode: string | undefined): TResult {
  const last = result.trace.steps.at(-1);
  return {
    ...result,
    trace: {
      ...result.trace,
      steps: [
        ...result.trace.steps,
        { sequence: (last?.sequence ?? 0) + 1, operator: 'external_authorization', status, reasonCodes: reasonCode !== undefined ? [reasonCode] : [] },
      ],
    },
  };
}
