import { bootstrapBindingDigest, bootstrapBindingOf, isDigest, isIdentifier, parseStatusHistoryBootstrapRequest } from './bootstrap-contract.js';
import type { StatusHistoryBootstrapRequest } from './bootstrap-contract.js';
import { parseBootstrapHumanDecisionRequestId } from './human-decision-authorizer.js';

/**
 * FV-P4C-2B3A (F3) — the in-process registry of bootstrap operations in flight (not composed).
 *
 * F3 was a grace race. A coordinator call that is still running (a slow source check, a slow SQLite
 * commit) after its decisions were consumed could be settled `NO_BOOTSTRAP_EVIDENCE` by the reconciler
 * after the grace bound, and then commit. The reconciler asks `inFlight(commitment)`. This registry is
 * what answers.
 *
 * **Lifecycle.**
 * 1. `run(request, operation)` parses the request once and derives the exact binding, with the
 *    coordinator's own functions. It registers `(namespace, binding digest)` and the request id
 *    **before** `operation` starts, so before the authorizer can consume any decision. `operation`
 *    receives that same parsed request, frozen, so the registered binding is the one the coordinator
 *    is given (review M5).
 * 2. The registration lasts until `operation`'s promise settles: resolved, rejected or thrown. The
 *    source check and the SQLite commit happen inside it. There is no timer. A caller that stops
 *    waiting (timeout, cancellation) does not end the registration, because the work may still commit.
 *    An operation that never settles stays in flight; `inFlightOperations()` reports its age.
 * 3. A second concurrent `run` for the same binding or request id is refused before it starts (`DUPLICATE`).
 *    So is a request that does not parse (`REQUEST_INVALID`): such a request can consume no decision.
 *
 * **Why it is in memory, and the condition that makes that sound.** A bootstrap's only durable effect
 * is the history's atomic commit (mark plus evidence, one SQLite transaction). An operation cannot
 * outlive the process that runs it, so after a crash nothing it started can still commit: "in flight"
 * never needs to survive a restart. What a crash leaves behind is answered durably elsewhere, by the
 * Host inventory's write-ahead intents (`host-inventory.ts`, review H1). A pending intent keeps its
 * namespace quarantined until evidence resolves it, so a history that was rolled back or replaced
 * after the crash is never read as `bootstrap-not-committed`.
 *
 * This holds **only if one process at a time executes bootstraps for a set of histories**. A second
 * process (a parallel Host, or an old process still running after a "restart") would be invisible to
 * this registry. That exclusive-executor lease is a B3B precondition. It does not exist today (no Host
 * process lock was found), and nothing here claims it.
 *
 * Access: the registry is created and held by the Host's FV authority boundary
 * (`authority-boundary.ts`). Its `inFlight` adapter is the only part a reconciler receives.
 */

export type BootstrapOperationRefusal = 'REQUEST_INVALID' | 'DUPLICATE' | 'CLOSED';

export interface BootstrapOperationRecord {
  readonly namespace: string;
  readonly bindingDigest: string;
  readonly requestId: string;
  readonly startedAt: string;
}

export interface BootstrapOperationRegistry {
  /** Runs one bootstrap attempt while it is registered in flight; refuses before starting it when it cannot be registered. */
  run<T>(request: unknown, operation: (parsed: StatusHistoryBootstrapRequest) => Promise<T>): Promise<{ readonly outcome: 'ran'; readonly value: T } | { readonly outcome: 'refused'; readonly reason: BootstrapOperationRefusal }>;
  /** Whether an attempt for this namespace and binding is running now. */
  isInFlight(namespace: string, bindingDigest: string): boolean;
  /** The reconciler's `inFlight`: resolves a decision's commitment to its signed namespace and binding. Unknown or unreadable means in flight. */
  inFlightByCommitment(lookup: (commitment: string) => unknown): (commitment: string) => boolean;
  /** What is in flight now, for operators. */
  inFlightOperations(): readonly BootstrapOperationRecord[];
  /** Refuses new runs; running ones keep their registration until they settle. */
  close(): void;
}

export function createBootstrapOperationRegistry(options: { readonly now: () => string }): BootstrapOperationRegistry {
  const now = options?.now;
  if (typeof now !== 'function') throw new TypeError('now is the Host’s trusted clock.');
  const byBinding = new Map<string, BootstrapOperationRecord>();
  const byRequest = new Set<string>();
  let closed = false;
  const keyOf = (namespace: string, bindingDigest: string) => JSON.stringify([namespace, bindingDigest]);

  return Object.freeze({
    async run<T>(request: unknown, operation: (parsed: StatusHistoryBootstrapRequest) => Promise<T>) {
      if (closed) return Object.freeze({ outcome: 'refused' as const, reason: 'CLOSED' as const });
      if (typeof operation !== 'function') throw new TypeError('operation is the coordinator call.');
      let namespace: string;
      let bindingDigest: string;
      let requestId: string;
      let parsed: StatusHistoryBootstrapRequest;
      try {
        const read = parseStatusHistoryBootstrapRequest(request);
        if (read === undefined) return Object.freeze({ outcome: 'refused' as const, reason: 'REQUEST_INVALID' as const });
        // A plain, frozen copy: what is registered is exactly what the operation is handed.
        parsed = deepFreeze(JSON.parse(JSON.stringify(read)) as StatusHistoryBootstrapRequest);
        const binding = bootstrapBindingOf(parsed);
        namespace = binding.namespace;
        bindingDigest = bootstrapBindingDigest(binding);
        requestId = parsed.requestId;
      } catch {
        return Object.freeze({ outcome: 'refused' as const, reason: 'REQUEST_INVALID' as const });
      }
      const key = keyOf(namespace, bindingDigest);
      if (byBinding.has(key) || byRequest.has(requestId)) return Object.freeze({ outcome: 'refused' as const, reason: 'DUPLICATE' as const });
      // Registered before the operation starts: before any decision can be consumed.
      byBinding.set(key, Object.freeze({ namespace, bindingDigest, requestId, startedAt: now() }));
      byRequest.add(requestId);
      try {
        const value = await operation(parsed);
        return Object.freeze({ outcome: 'ran' as const, value });
      } finally {
        // Only now, when the operation itself has settled, is its outcome durably what the history holds.
        byBinding.delete(key);
        byRequest.delete(requestId);
      }
    },
    isInFlight(namespace: string, bindingDigest: string): boolean {
      return byBinding.has(keyOf(namespace, bindingDigest));
    },
    inFlightByCommitment(lookup: (commitment: string) => unknown) {
      if (typeof lookup !== 'function') throw new TypeError('lookup reads a bootstrap decision by commitment.');
      return (commitment: string): boolean => {
        try {
          const record = lookup(commitment) as { contract?: { approvalRequestId?: unknown } } | undefined;
          const target = parseBootstrapHumanDecisionRequestId(record?.contract?.approvalRequestId);
          // A decision that cannot be resolved to its signed target is treated as in flight: never a negative.
          if (target === undefined || !isIdentifier(target.namespace, 256) || !isDigest(target.bindingDigest)) return true;
          return byBinding.has(keyOf(target.namespace, target.bindingDigest));
        } catch {
          return true;
        }
      };
    },
    inFlightOperations: () => Object.freeze([...byBinding.values()]),
    close(): void {
      closed = true;
    },
  });
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const inner of Object.values(value as Record<string, unknown>)) deepFreeze(inner);
  }
  return value;
}
