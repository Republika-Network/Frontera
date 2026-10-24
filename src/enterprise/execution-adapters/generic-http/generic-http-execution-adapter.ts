import { EXECUTION_FAILURE_REASONS, isRecordableProviderRef, type ExecutionAdapter, type ExecutionAdapterResult, type ValidatedExecutionAction } from '../../../features/execution-runtime/index.js';
import { GENERIC_HTTP_LIMITS as LIMITS, type EnterpriseGenericHttpExecutionAdapterOptions } from './contracts.js';
import { snapshotGenericHttpOptions, type GenericHttpPlan } from './configuration.js';
import { GENERIC_HTTP_GOVERNED_HEADER_LIMITS, GENERIC_HTTP_PRESENTATION_HEADER, isGovernedHeaderValue } from './governed-headers.js';
import { NODE_GENERIC_HTTP_RUNTIME, type GenericHttpNetworkRuntime, type GenericHttpTransportObservation } from './node-https-transport.js';
import { selectApprovedAddress } from './public-address-policy.js';
import { genericHttpRequestBinding, type GenericHttpRequestBinding } from './request-binding.js';
import { mapGenericHttpRequest, type GenericHttpWireRequest } from './request-mapper.js';

/**
 * The Generic HTTP Execution Adapter — a deterministic translator from one
 * `ValidatedExecutionAction` plus trusted configuration to **at most one**
 * pinned HTTPS request.
 *
 * ```
 * ExecutionAdapterRegistry (trusted routing, adapter-scoped emergency check)
 *   -> execute(action)
 *   -> map        plan + action -> complete request, or ADAPTER_ERROR (no I/O)
 *   -> gate       (G-02C0, only when composed) proceed, or ADAPTER_ERROR (nothing sent);
 *                 G-02C1D: a proceed may carry one presentation, appended as one fixed header
 *                 after the binding was computed
 *   -> observe    (G-02C1D, only with a presentation) the receipt header values, handed on;
 *                 never a change to the result
 *   -> resolve    the pinned hostname, fresh, every execution
 *   -> policy     every answer public, or ADAPTER_ERROR; pick one
 *   -> send       one connection to that one address; no reuse, no redirect, no retry
 *   -> classify   final status -> completed / failed / unconfirmed
 * ```
 *
 * It is not a proxy, not a fetch endpoint, not a router and not a second
 * authorization layer. It holds no Kernel, policy, store, grant, customer
 * identity, obligation or emergency-control reader, and it decides nothing:
 * the registry above it already chose it and already checked the
 * adapter-scoped stop. What it adds is a guarantee about **where** and **how
 * often** the network is touched.
 *
 * ## Failure semantics never turn uncertainty into a definite answer
 *
 * | Observation | Result |
 * |---|---|
 * | request could not be built from the action | `failed` / `ADAPTER_ERROR` |
 * | a composed pre-send gate did not answer `proceed` | `failed` / `ADAPTER_ERROR` |
 * | DNS failed, no answers, or timed out | `failed` / `PROVIDER_UNAVAILABLE` |
 * | an answer is not publicly routable | `failed` / `ADAPTER_ERROR` |
 * | TCP refused, TLS/certificate failure, budget spent before `secureConnect` | `failed` / `PROVIDER_UNAVAILABLE` |
 * | anything lost after `secureConnect`, before a final status | `unconfirmed` |
 * | 200, 201, 204 — the Stage-A definitive success statuses | `completed` |
 * | every other 2xx (202 Accepted means *not yet done*) | `unconfirmed` |
 * | every 3xx — never followed; a 303 may answer an action that already ran | `unconfirmed` |
 * | 408, 5xx, or any other non-classifiable status | `unconfirmed` |
 * | other 4xx | `failed` / `PROVIDER_REJECTED` |
 *
 * A safe configured `providerRefHeader` value is kept on every row that has a
 * final status — completed, rejected and unconfirmed alike — and on no row
 * without one. It is a correlation handle and never changes the row.
 *
 * `PROVIDER_UNAVAILABLE` means *proven not to have reached the provider*. A
 * provider that answered 500 may have committed the effect first, so 500 is
 * `unconfirmed`, never "unavailable". Every `detail` is a fixed phrase: no DNS
 * or TLS error text, no socket error, no URL, no header, no body, no secret.
 */

const DETAIL = Object.freeze({
  unbuildable: 'Generic HTTP request could not be constructed from the validated action.',
  withheld: 'Generic HTTP request was withheld before transmission by the pre-send gate.',
  unresolvable: 'Generic HTTP destination could not be resolved.',
  notPublic: 'Generic HTTP destination is not publicly routable.',
  notSent: 'Generic HTTP request could not connect before transmission.',
  unconfirmed: 'Generic HTTP outcome could not be confirmed.',
  ambiguousStatus: 'Generic HTTP provider returned a response that does not confirm the effect.',
  rejected: 'Generic HTTP provider rejected the request.',
});

/**
 * Exactly one bounded, printable value — or nothing. Duplicates are omitted,
 * never joined.
 *
 * The provider-neutral rule is the execution runtime's `isRecordableProviderRef`
 * (bounded printable ASCII, and shaped like no bearer or basic credential, JWT,
 * PEM block, URL, cookie or authorization header — so a redirect `Location`
 * copied into the header is never a reference). This adapter adds what only it
 * can check: the configured credential.
 *
 * The value is **untrusted provider-controlled input**. A provider can echo
 * whatever it received — including the credential this adapter sent — into the
 * configured reference header, and a reference is copied outward into the
 * governed-action result. So a candidate that contains any configured
 * credential secret, literally and case-sensitively, anywhere in it, is
 * omitted outright: not redacted, not hashed, not logged, not reported. The
 * guarantee is literal non-disclosure of the configured secret; a provider that
 * transforms or encodes it first is not detectable here.
 */
function providerRefFrom(values: readonly string[], credentialSecrets: readonly string[]): string | undefined {
  if (values.length !== 1) return undefined;
  const value = values[0];
  if (value === undefined || value.length > LIMITS.maxProviderRefLength || !isRecordableProviderRef(value)) return undefined;
  if (credentialSecrets.some((secret) => secret.length > 0 && value.includes(secret))) return undefined;
  return value;
}

/**
 * The only statuses Stage A treats as proof the effect completed. Anything else
 * in 2xx is not: 202 Accepted says processing has *not* finished, and 203, 205,
 * 206, 207, 208 and 226 describe the response rather than the effect.
 */
const DEFINITIVE_SUCCESS: ReadonlySet<number> = new Set([200, 201, 204]);

/**
 * The final-status classification. A pure function of the status: no body, no
 * header, no provider text can move it.
 *
 * Only two answers are definitive: a Stage-A success status (`completed`) and
 * an ordinary 4xx other than 408 (`PROVIDER_REJECTED`). Everything else is
 * `unconfirmed` — including every 3xx, which is never followed and whose
 * effect is uncertain (a 303 See Other is a normal reply to a POST that
 * already ran), so a redirect is never reported as a definite failure either.
 */
export function classifyGenericHttpStatus(status: number): ExecutionAdapterResult {
  if (DEFINITIVE_SUCCESS.has(status)) return { outcome: 'completed' };
  if (Number.isInteger(status) && status >= 400 && status <= 499 && status !== 408) return { outcome: 'failed', reason: EXECUTION_FAILURE_REASONS.PROVIDER_REJECTED, detail: DETAIL.rejected };
  return { outcome: 'unconfirmed', detail: DETAIL.ambiguousStatus };
}

function fromObservation(observation: GenericHttpTransportObservation, credentialSecrets: readonly string[]): ExecutionAdapterResult {
  switch (observation.kind) {
    case 'not-sent':
      return { outcome: 'failed', reason: EXECUTION_FAILURE_REASONS.PROVIDER_UNAVAILABLE, detail: DETAIL.notSent };
    case 'destination-mismatch':
      return { outcome: 'failed', reason: EXECUTION_FAILURE_REASONS.ADAPTER_ERROR, detail: DETAIL.notPublic };
    case 'unconfirmed':
      return { outcome: 'unconfirmed', detail: DETAIL.unconfirmed };
    case 'response': {
      // A final status arrived, so the provider genuinely answered, and the
      // configured reference header — when it holds one safe value — is kept on
      // whatever the status means: a completion, a definitive rejection, or an
      // unconfirmed 202 / 3xx / 408 / 5xx, where it is the handle a later
      // reconciliation needs. The status alone decides the outcome; the
      // reference never moves it. Every arm above this one — nothing sent, or
      // nothing heard back — has no response and therefore no reference.
      const classified = classifyGenericHttpStatus(observation.status);
      const providerRef = providerRefFrom(observation.providerRefValues, credentialSecrets);
      return providerRef !== undefined ? { ...classified, providerRef } : classified;
    }
  }
}

/**
 * G-02C0 — what a pre-send gate is shown: the adapter's snapshotted identity,
 * the validated action, and the binding record of the exact request about to
 * be sent (`request-binding.ts`). Never the request object, and never the
 * credential value: the record excludes it.
 */
export interface GenericHttpPreSendSubject {
  readonly adapterId: string;
  readonly action: ValidatedExecutionAction;
  readonly binding: GenericHttpRequestBinding;
}

/**
 * A gate's whole vocabulary: proceed, or do not — and, since G-02C1D, a
 * proceed may carry **one** presentation: an opaque, bounded base64url value
 * the adapter appends as the one fixed `frontera-execution-capability`
 * header. There is no member that carries a request, a header name, a body or
 * a destination, so a gate can stop a request and can never change or replace
 * one, and can add to it only that one value under that one name. A refusal
 * carries nothing.
 */
export type GenericHttpPreSendVerdict = { readonly proceed: true; readonly presentation?: string } | { readonly proceed: false };

/**
 * G-02C0 — an internal hook run **after** the request is final and frozen and
 * **before** a DNS lookup or a socket. Composed by the composition root alone,
 * per adapter, and never reachable from configuration, a route or a caller.
 * Anything but a returned `{ proceed: true }` — `false`, a throw, a rejection,
 * every other value — withholds the request.
 */
export type GenericHttpPreSendGate = (subject: GenericHttpPreSendSubject) => Promise<GenericHttpPreSendVerdict>;

/**
 * G-02C1D — what the adapter shows a response observer after it sent a request
 * carrying a presentation: whether anything came back, the final status if it
 * did, and every raw value of the receipt header (untrusted, unread here). The
 * observer cannot change the result: it is told the result after it was fixed.
 */
export interface GenericHttpExchangeEvidence {
  readonly adapterId: string;
  readonly action: ValidatedExecutionAction;
  readonly result: ExecutionAdapterResult;
  readonly transmission: 'not-sent' | 'unconfirmed' | 'response';
  readonly status: number | null;
  readonly receiptValues: readonly string[];
}

/**
 * G-02C1D — an internal hook run once after a presented request's exchange
 * ended, whatever its outcome. Composed by the composition root alone, beside
 * the gate. A throw or rejection is ignored; the result is already fixed.
 */
export type GenericHttpResponseObserver = (evidence: GenericHttpExchangeEvidence) => Promise<void>;

/**
 * Exactly `{ proceed: true }`, or `{ proceed: true, presentation }`, as own
 * data properties and nothing else; everything else is a refusal — including
 * a presentation that is not one bounded base64url value.
 */
function verdictOf(verdict: unknown): { readonly proceed: false } | { readonly proceed: true; readonly presentation: string | undefined } {
  const refused = { proceed: false } as const;
  if (verdict === null || typeof verdict !== 'object') return refused;
  const descriptor = Object.getOwnPropertyDescriptor(verdict, 'proceed');
  if (descriptor === undefined || !('value' in descriptor) || descriptor.value !== true) return refused;
  const keys = Reflect.ownKeys(verdict);
  if (!keys.every((key) => key === 'proceed' || key === 'presentation')) return refused;
  const offered = Object.getOwnPropertyDescriptor(verdict, 'presentation');
  if (offered === undefined) return { proceed: true, presentation: undefined };
  if (!('value' in offered) || !isGovernedHeaderValue(offered.value, GENERIC_HTTP_GOVERNED_HEADER_LIMITS.maxPresentationLength)) return refused;
  return { proceed: true, presentation: offered.value };
}

/**
 * The request with the presentation appended as its last header: a new frozen
 * object, so the bound request itself is never changed. The mapper reserves
 * the name, so the header is present exactly once.
 */
function withPresentationHeader(request: GenericHttpWireRequest, presentation: string): GenericHttpWireRequest {
  return Object.freeze({ ...request, headers: Object.freeze([...request.headers, Object.freeze([GENERIC_HTTP_PRESENTATION_HEADER, presentation] as const)]) });
}

function transmissionOf(observation: GenericHttpTransportObservation): GenericHttpExchangeEvidence['transmission'] {
  if (observation.kind === 'response') return 'response';
  return observation.kind === 'unconfirmed' ? 'unconfirmed' : 'not-sent';
}

/** One exchange: its result, whether a presentation went out with it, and what the transport saw. */
interface GenericHttpExchange {
  readonly result: ExecutionAdapterResult;
  readonly presented: boolean;
  readonly transmission: GenericHttpExchangeEvidence['transmission'];
  readonly observation?: GenericHttpTransportObservation;
}

/**
 * The adapter over a frozen plan and a network runtime. **Internal**: the only
 * production callers are the two factories below, which always bind the Node
 * runtime. Tests reach this directly with a fake runtime; no public option,
 * barrel export or `CreateEnterpriseOptions` field reaches it.
 *
 * Without a `gate` it behaves exactly as before G-02C0: the gate step is
 * skipped and nothing else differs.
 */
export function createGenericHttpExecutionAdapterCore(plan: GenericHttpPlan, runtime: GenericHttpNetworkRuntime, gate?: GenericHttpPreSendGate, observer?: GenericHttpResponseObserver): ExecutionAdapter {
  const adapterId = plan.adapterId;

  async function execute(action: ValidatedExecutionAction): Promise<ExecutionAdapterResult> {
    const exchange = await attempt(action);
    // G-02C1D: a presented request's exchange is shown to the observer once, after its result is fixed.
    if (exchange.presented && observer !== undefined) {
      const observation = exchange.observation;
      const evidence = Object.freeze({
        adapterId,
        action,
        result: exchange.result,
        transmission: exchange.transmission,
        status: observation?.kind === 'response' ? observation.status : null,
        receiptValues: Object.freeze(observation?.kind === 'response' ? [...(observation.receiptValues ?? [])] : []),
      });
      try {
        await observer(evidence);
      } catch {
        // The result stands; the evidence path reports its own failures.
      }
    }
    return exchange.result;
  }

  /** The exchange, and — once a presentation went out — what the transport observed. */
  async function attempt(action: ValidatedExecutionAction): Promise<GenericHttpExchange> {
    // Every early answer below is before the send: nothing reached the provider.
    const done = (result: ExecutionAdapterResult, sentWithPresentation = false): GenericHttpExchange => ({ result, presented: sentWithPresentation, transmission: 'not-sent' });
    // 1. The complete request, before any I/O. Unbuildable means nothing is sent.
    const mapped = mapGenericHttpRequest(plan, action);
    if (!mapped.ok) return done({ outcome: 'failed', reason: EXECUTION_FAILURE_REASONS.ADAPTER_ERROR, detail: DETAIL.unbuildable });

    // 1a. G-02C0: the composed gate sees the binding of `mapped.request` — the
    //     frozen object sent in step 4, or (G-02C1D) its copy with the one
    //     presentation header appended — and may only stop it.
    //     Nothing has touched the network yet, so a refusal is a definite
    //     `failed`: the request was never sent.
    let outbound: GenericHttpWireRequest = mapped.request;
    if (gate !== undefined) {
      let verdict: unknown;
      try {
        verdict = await gate(Object.freeze({ adapterId, action, binding: genericHttpRequestBinding(plan, mapped.request) }));
      } catch {
        verdict = undefined;
      }
      const decided = verdictOf(verdict);
      if (!decided.proceed) return done({ outcome: 'failed', reason: EXECUTION_FAILURE_REASONS.ADAPTER_ERROR, detail: DETAIL.withheld });
      // 1b. G-02C1D: the one presentation, appended to a copy after the binding was computed over `mapped.request`.
      if (decided.presentation !== undefined) outbound = withPresentationHeader(mapped.request, decided.presentation);
    }
    const presenting = outbound !== mapped.request;

    const started = performance.now();

    // 2. Fresh resolution of the pinned hostname — never cached across executions.
    let resolution;
    try {
      resolution = await runtime.resolve(plan.hostname, plan.timeoutMs);
    } catch {
      resolution = { kind: 'failed' } as const;
    }
    if (resolution.kind !== 'resolved') return done({ outcome: 'failed', reason: EXECUTION_FAILURE_REASONS.PROVIDER_UNAVAILABLE, detail: DETAIL.unresolvable }, presenting);

    // 3. Every answer judged; one chosen. A mixed answer is refused whole.
    const selection = selectApprovedAddress(resolution.answers);
    if (selection.kind === 'no-answer') return done({ outcome: 'failed', reason: EXECUTION_FAILURE_REASONS.PROVIDER_UNAVAILABLE, detail: DETAIL.unresolvable }, presenting);
    if (selection.kind === 'forbidden') return done({ outcome: 'failed', reason: EXECUTION_FAILURE_REASONS.ADAPTER_ERROR, detail: DETAIL.notPublic }, presenting);

    const remaining = Math.floor(plan.timeoutMs - (performance.now() - started));
    if (remaining <= 0) return done({ outcome: 'failed', reason: EXECUTION_FAILURE_REASONS.PROVIDER_UNAVAILABLE, detail: DETAIL.notSent }, presenting);

    // 4. The one send. There is no second call anywhere in this function, and
    //    no loop around this one. A runtime that throws may have sent — so a
    //    throw here is unconfirmed, never a failure.
    let observation: GenericHttpTransportObservation;
    try {
      observation = await runtime.send(outbound, selection.address, remaining, plan.providerRefHeader);
    } catch {
      return { result: { outcome: 'unconfirmed', detail: DETAIL.unconfirmed }, presented: presenting, transmission: 'unconfirmed' };
    }
    return { result: fromObservation(observation, plan.credentialSecrets), presented: presenting, transmission: transmissionOf(observation), observation };
  }

  return Object.freeze({
    adapterId,
    async execute(action: ValidatedExecutionAction): Promise<ExecutionAdapterResult> {
      try {
        return await execute(action);
      } catch {
        // Unreachable by construction; if it is ever reached, the send may have
        // happened, so the only honest answer is that the outcome is unknown.
        return { outcome: 'unconfirmed', detail: DETAIL.unconfirmed };
      }
    },
  });
}

/**
 * The production factory: snapshot the trusted options, bind the secure Node
 * transport. Called by `createEnterprise` from
 * `executionAdapterRouting.genericHttpAdapters`; not re-exported from the
 * Enterprise barrel, and it accepts no transport.
 */
export function createGenericHttpExecutionAdapter(options: EnterpriseGenericHttpExecutionAdapterOptions): ExecutionAdapter {
  return createGenericHttpExecutionAdapterCore(snapshotGenericHttpOptions(options), NODE_GENERIC_HTTP_RUNTIME);
}

/**
 * G-02C0: the same production factory with a pre-send gate chosen by the
 * snapshotted adapter id. Called only by `createEnterprise`; not re-exported
 * from this module's index or the Enterprise barrel. An id with no gate in
 * `gates` is built exactly as `createGenericHttpExecutionAdapter` builds it.
 */
export function createGenericHttpExecutionAdapterWithPreSendGates(
  options: EnterpriseGenericHttpExecutionAdapterOptions,
  gates: ReadonlyMap<string, GenericHttpPreSendGate>,
  observers: ReadonlyMap<string, GenericHttpResponseObserver> = new Map(),
): ExecutionAdapter {
  const plan = snapshotGenericHttpOptions(options);
  const gate = gates.get(plan.adapterId);
  // G-02C1D: an observer only ever accompanies a gate — nothing ungated is presented, so nothing ungated is observed.
  return createGenericHttpExecutionAdapterCore(plan, NODE_GENERIC_HTTP_RUNTIME, gate, gate === undefined ? undefined : observers.get(plan.adapterId));
}
