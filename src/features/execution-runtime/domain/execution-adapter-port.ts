import type { GrantExerciseAmount } from './grant-exercise-request.js';

/**
 * The provider-neutral execution boundary.
 *
 * `TARGET_AUTHORITY_CONTROL_ARCHITECTURE.md` §2 puts `action — execution,
 * through an adapter` immediately after the bounded grant, and
 * `ADR-PROVIDER-ADAPTER-CONTRACT.md` draws the line this port sits on:
 * everything above it is Enterprise authority control; everything below it is
 * "Execution · Temporary URLs · Signed URLs · Credentials · Network · Storage ·
 * SDK". That ADR's own crossing is for the Sovereign Access resource-grant
 * path and reads `EnterpriseAccessGrant`; this is the equivalent crossing for
 * the authority-control pipeline, and it reads a **validated action** rather
 * than a grant.
 *
 * ## What an adapter may not do
 *
 * It may not authorize, evaluate policy, resolve context, discharge an
 * obligation, issue or widen a grant, interpret an AI recommendation, or infer
 * missing authority. It has nothing to do any of those *with*: the type it
 * receives carries no decision, no status, no policy result, no obligation
 * state, no context fact, no grant scope, no source authorization and no
 * digest. `tests/execution-layer-boundaries.test.ts` asserts the absence of
 * each field, and asserts that no adapter type in this module can reach the
 * Kernel, the policy runtime, layers C or D, or an intelligence dependency.
 *
 * An adapter that could re-decide would be a second decision producer, which
 * `ADR-AUTHORITY-CONTROL-LAYERING.md` §4 forbids outright. Handing it a
 * validated action and nothing else gives it nothing to do but translate and
 * execute.
 *
 * ## What it is not
 *
 * Not a ledger client, not a signer, not a wallet, not a transaction builder.
 * A chain adapter is a later implementation *of* this port, and nothing here
 * anticipates one: there is no sequence number, no nonce, no fee, no address,
 * no key handle and no chain identifier, and a structural test refuses the
 * vocabulary.
 *
 * ## Every field crossing this boundary was assessed
 *
 * There is deliberately **no free-form payload, blob or opaque reference** on
 * this type. An adapter that could dereference one would execute data no bound
 * covered and no assessment saw — a grant for 7500 to V123 submitting a payload
 * for 100000 to V999, with every check passing on the way. The action carried
 * here *is* the payload: subject, action, resource, counterparty, organization
 * and amount, each already proven inside a bound. See
 * `grant-exercise-request.ts` for the full reasoning and for what a later ADR
 * would have to decide before such a field could exist.
 */
export interface ValidatedExecutionAction {
  /** The grant that was proven to cover this action. An identity for correlation; the adapter has no way to read the grant it names, and no reason to. */
  readonly boundedGrantId: string;
  /** The party the grant is held by, as the trusted store recorded it — never as the caller described it. */
  readonly subject: string;
  /** The action, proven equal to the action the grant bounds. */
  readonly action: string;
  /** The resource, proven to be a member of the grant's bounded resource set. */
  readonly resource: string;
  /** The counterparty, proven equal to the grant's bound where the grant states one. */
  readonly counterparty?: string;
  /** The tenant, proven equal to the grant's bound where the grant states one. */
  readonly organization?: string;
  /** The quantity, proven at or below the grant's ceiling in the grant's own unit. */
  readonly amount?: GrantExerciseAmount;
  /**
   * The instant the covering grant stops, copied from the trusted grant.
   *
   * The one temporal value an adapter is given, and it is given because a
   * provider credential a translation mints must not outlive the authority it
   * was minted under — the property `ADR-PROVIDER-ADAPTER-CONTRACT.md` already
   * expects of `EnterpriseAccessGrant.expiresAt` at its own crossing. It is a
   * bound to respect, never a bound to extend.
   */
  readonly notAfter: string;
  /** Request, decision and this attempt, so a provider result can be tied back to the authorization without the adapter reconstructing anything. */
  readonly correlation: ValidatedExecutionCorrelation;
}

export interface ValidatedExecutionCorrelation {
  readonly requestId: string;
  readonly decisionId: string;
  readonly executionId: string;
}

/**
 * Why a provider could not complete an action it was asked to perform.
 *
 * Closed, provider-neutral, and deliberately small. It describes the
 * *provider's* failure and never the platform's judgement: none of these means
 * "not authorized", because an unauthorized action never reaches an adapter.
 */
export const EXECUTION_FAILURE_REASONS = {
  /** The provider refused the request — its own permissions, its own rules. Not a Frontera authorization outcome. */
  PROVIDER_REJECTED: 'PROVIDER_REJECTED',
  /** The provider could not be reached, or did not answer in time. */
  PROVIDER_UNAVAILABLE: 'PROVIDER_UNAVAILABLE',
  /** The provider answered with something this adapter could not interpret. */
  PROVIDER_RESPONSE_INVALID: 'PROVIDER_RESPONSE_INVALID',
  /** The adapter raised. Recorded as a failure rather than propagated, so one provider defect never becomes an authorization outcome. */
  ADAPTER_ERROR: 'ADAPTER_ERROR',
} as const;

export type ExecutionFailureReason = (typeof EXECUTION_FAILURE_REASONS)[keyof typeof EXECUTION_FAILURE_REASONS];

export const EXECUTION_FAILURE_REASON_VALUES: readonly ExecutionFailureReason[] = Object.values(EXECUTION_FAILURE_REASONS);

/**
 * What an adapter reports back.
 *
 * Provider-neutral: an opaque `providerRef` the provider chose, and nothing
 * with a decision shape. An adapter cannot report "denied", because reporting a
 * decision is not something it is allowed to do and there is no field for it.
 */
export type ExecutionAdapterResult =
  | { readonly outcome: 'completed'; readonly providerRef?: string; readonly adapterId?: string }
  | { readonly outcome: 'failed'; readonly reason: ExecutionFailureReason; readonly detail?: string; readonly adapterId?: string };

/**
 * An adapter's returned value, copied into a fresh, plain
 * `ExecutionAdapterResult` — or `undefined` when it is not one.
 *
 * ## Why this exists: the result is adapter-controlled code, not data
 *
 * What `execute` resolves to is an object the adapter built, and observing it
 * **runs the adapter's code**: an enumerable getter runs on `result.providerRef`
 * and on `{ ...result }`, and a `Proxy` runs a trap on every `get`, `ownKeys`
 * and `getOwnPropertyDescriptor`. An earlier revision caught a child's throw
 * around `await childAdapter.execute(action)` and then spread the result
 * *outside* that catch, so a child could resolve successfully with a getter
 * that threw a genuine `EmergencyControlWithheldError`. The throw left the
 * registry, the execution service saw it arrive from an authenticated
 * registry, and recorded `withheldBy: 'emergency-control'` for a stop no
 * `EmergencyControlReaderPort` had declared — the provenance claim registry
 * authentication exists to deny. A directly composed adapter's getter, read by
 * the service after its own catch, escaped the execution boundary entirely.
 *
 * So both call sites run this **inside** the try that already turns an adapter
 * throw into `ADAPTER_ERROR`, and treat `undefined` the same way. Everything
 * after it touches only the value this returns, which the adapter cannot run
 * code in.
 *
 * ## What it accepts
 *
 * Each field is read **exactly once**, and only primitives from the closed
 * vocabulary are copied: `outcome` of `'completed'` or `'failed'`; a string
 * `providerRef`, `detail` or `adapterId` where present; a `reason` from
 * `EXECUTION_FAILURE_REASON_VALUES`. Anything else — a non-object, an unknown
 * outcome, a non-string reference, a reason outside the vocabulary — is a
 * result that broke the port's contract, and the answer is `undefined`, never
 * a best guess. Nothing adapter-controlled survives to be read again later by
 * the ledger or a serializer.
 *
 * It may throw — that is the adapter's code running — and callers must catch
 * it. It never throws on its own account.
 */
export function readExecutionAdapterResult(value: unknown): ExecutionAdapterResult | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const source = value as Record<string, unknown>;
  const outcome = source['outcome'];
  const adapterId = source['adapterId'];
  if (adapterId !== undefined && typeof adapterId !== 'string') return undefined;
  const attribution = adapterId !== undefined ? { adapterId } : {};

  if (outcome === 'completed') {
    const providerRef = source['providerRef'];
    if (providerRef !== undefined && typeof providerRef !== 'string') return undefined;
    return Object.freeze({ outcome: 'completed', ...(providerRef !== undefined ? { providerRef } : {}), ...attribution });
  }
  if (outcome === 'failed') {
    const reason = source['reason'];
    const detail = source['detail'];
    if (!EXECUTION_FAILURE_REASON_VALUES.includes(reason as ExecutionFailureReason)) return undefined;
    if (detail !== undefined && typeof detail !== 'string') return undefined;
    return Object.freeze({ outcome: 'failed', reason: reason as ExecutionFailureReason, ...(detail !== undefined ? { detail } : {}), ...attribution });
  }
  return undefined;
}

/**
 * ## `adapterId` on a result: which adapter actually performed the effect
 *
 * A composite adapter — `createExecutionAdapterRegistry` — satisfies this port
 * and then routes to one registered child. Its own `adapterId` names the
 * *routing boundary*, not the provider integration that ran, so an outcome
 * carrying only that value tells an auditor which orchestrator was composed and
 * nothing about which of several providers received the effect.
 *
 * So a result may name the adapter that performed it. The field is on the
 * result type every adapter implements, so **any** adapter can set it — a
 * child, a directly composed adapter, one a host wrote. What makes it safe is
 * that it is **trusted only from an authenticated registry**:
 * `GrantExecutionService` reads it only when `isExecutionAdapterRegistry`
 * confirms the composed adapter came from `createExecutionAdapterRegistry`, and
 * the registry itself overwrites whatever its child set with the identity it
 * snapshotted at composition. A direct adapter's value is ignored and it is
 * recorded under its own id; the caller has no field anywhere on this path
 * that reaches it. A plain adapter omits it and the execution service falls
 * back to the adapter it holds, which is exactly the previous behaviour.
 *
 * It is **evidence, not authority**. Nothing reads it to decide anything: it is
 * reported on the outcome and recorded in the execution ledger so "which
 * provider did this" is answerable from the durable record.
 */

export interface ExecutionAdapter {
  /** Names the provider integration, for correlation and operator diagnostics. Mirrors `EnterpriseProviderCapabilityDeclaration.providerSystem`. */
  readonly adapterId: string;
  /** Translate and execute an already-authorized, grant-valid action. Called only after a usable exercise assessment, and never otherwise. */
  execute(action: ValidatedExecutionAction): Promise<ExecutionAdapterResult>;
}

/**
 * The `detail` an `ADAPTER_ERROR` may carry, taken from what an adapter threw
 * — **total**: it never throws, whatever it is handed.
 *
 * The thrown value is adapter-controlled too. `error.message` can be a getter,
 * and `instanceof` runs a Proxy's `getPrototypeOf` trap, so reading either in
 * a `catch` block is running adapter code where nothing is left to catch it: a
 * `message` getter that throws a genuine `EmergencyControlWithheldError` from
 * inside the registry's catch would escape the registry exactly as a result
 * getter did. Any throw while reading is swallowed and the detail omitted — the
 * outcome is `ADAPTER_ERROR` regardless, and only a plain non-empty string is
 * ever copied.
 */
export function adapterErrorDetail(error: unknown): { readonly detail?: string } {
  try {
    if (!(error instanceof Error)) return {};
    const message: unknown = error.message;
    return typeof message === 'string' && message.length > 0 ? { detail: message } : {};
  } catch {
    return {};
  }
}
