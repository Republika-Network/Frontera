import { EXECUTION_FAILURE_REASONS, type ExecutionAdapter, type ExecutionAdapterResult, type ValidatedExecutionAction } from '../../../features/execution-runtime/index.js';
import { GENERIC_HTTP_LIMITS as LIMITS, type EnterpriseGenericHttpExecutionAdapterOptions } from './contracts.js';
import { snapshotGenericHttpOptions, type GenericHttpPlan } from './configuration.js';
import { NODE_GENERIC_HTTP_RUNTIME, type GenericHttpNetworkRuntime, type GenericHttpTransportObservation } from './node-https-transport.js';
import { selectApprovedAddress } from './public-address-policy.js';
import { mapGenericHttpRequest } from './request-mapper.js';

/**
 * The Generic HTTP Execution Adapter — a deterministic translator from one
 * `ValidatedExecutionAction` plus trusted configuration to **at most one**
 * pinned HTTPS request.
 *
 * ```
 * ExecutionAdapterRegistry (trusted routing, adapter-scoped emergency check)
 *   -> execute(action)
 *   -> map        plan + action -> complete request, or ADAPTER_ERROR (no I/O)
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
 * `PROVIDER_UNAVAILABLE` means *proven not to have reached the provider*. A
 * provider that answered 500 may have committed the effect first, so 500 is
 * `unconfirmed`, never "unavailable". Every `detail` is a fixed phrase: no DNS
 * or TLS error text, no socket error, no URL, no header, no body, no secret.
 */

const DETAIL = Object.freeze({
  unbuildable: 'Generic HTTP request could not be constructed from the validated action.',
  unresolvable: 'Generic HTTP destination could not be resolved.',
  notPublic: 'Generic HTTP destination is not publicly routable.',
  notSent: 'Generic HTTP request could not connect before transmission.',
  unconfirmed: 'Generic HTTP outcome could not be confirmed.',
  ambiguousStatus: 'Generic HTTP provider returned a response that does not confirm the effect.',
  rejected: 'Generic HTTP provider rejected the request.',
});

const PROVIDER_REF_VALUE = /^[\x21-\x7e](?:[\x20-\x7e]*[\x21-\x7e])?$/;

/**
 * Exactly one bounded, printable value — or nothing. Duplicates are omitted,
 * never joined.
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
  if (value === undefined || value.length === 0 || value.length > LIMITS.maxProviderRefLength || !PROVIDER_REF_VALUE.test(value)) return undefined;
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
      const classified = classifyGenericHttpStatus(observation.status);
      if (classified.outcome !== 'completed') return classified;
      const providerRef = providerRefFrom(observation.providerRefValues, credentialSecrets);
      return providerRef !== undefined ? { outcome: 'completed', providerRef } : { outcome: 'completed' };
    }
  }
}

/**
 * The adapter over a frozen plan and a network runtime. **Internal**: the only
 * production caller is `createGenericHttpExecutionAdapter` below, which always
 * binds the Node runtime. Tests reach this directly with a fake runtime; no
 * public option, barrel export or `CreateEnterpriseOptions` field reaches it.
 */
export function createGenericHttpExecutionAdapterCore(plan: GenericHttpPlan, runtime: GenericHttpNetworkRuntime): ExecutionAdapter {
  const adapterId = plan.adapterId;

  async function execute(action: ValidatedExecutionAction): Promise<ExecutionAdapterResult> {
    // 1. The complete request, before any I/O. Unbuildable means nothing is sent.
    const mapped = mapGenericHttpRequest(plan, action);
    if (!mapped.ok) return { outcome: 'failed', reason: EXECUTION_FAILURE_REASONS.ADAPTER_ERROR, detail: DETAIL.unbuildable };

    const started = performance.now();

    // 2. Fresh resolution of the pinned hostname — never cached across executions.
    let resolution;
    try {
      resolution = await runtime.resolve(plan.hostname, plan.timeoutMs);
    } catch {
      resolution = { kind: 'failed' } as const;
    }
    if (resolution.kind !== 'resolved') return { outcome: 'failed', reason: EXECUTION_FAILURE_REASONS.PROVIDER_UNAVAILABLE, detail: DETAIL.unresolvable };

    // 3. Every answer judged; one chosen. A mixed answer is refused whole.
    const selection = selectApprovedAddress(resolution.answers);
    if (selection.kind === 'no-answer') return { outcome: 'failed', reason: EXECUTION_FAILURE_REASONS.PROVIDER_UNAVAILABLE, detail: DETAIL.unresolvable };
    if (selection.kind === 'forbidden') return { outcome: 'failed', reason: EXECUTION_FAILURE_REASONS.ADAPTER_ERROR, detail: DETAIL.notPublic };

    const remaining = Math.floor(plan.timeoutMs - (performance.now() - started));
    if (remaining <= 0) return { outcome: 'failed', reason: EXECUTION_FAILURE_REASONS.PROVIDER_UNAVAILABLE, detail: DETAIL.notSent };

    // 4. The one send. There is no second call anywhere in this function, and
    //    no loop around this one. A runtime that throws may have sent — so a
    //    throw here is unconfirmed, never a failure.
    let observation: GenericHttpTransportObservation;
    try {
      observation = await runtime.send(mapped.request, selection.address, remaining, plan.providerRefHeader);
    } catch {
      return { outcome: 'unconfirmed', detail: DETAIL.unconfirmed };
    }
    return fromObservation(observation, plan.credentialSecrets);
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
