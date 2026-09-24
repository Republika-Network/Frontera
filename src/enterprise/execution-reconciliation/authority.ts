import { isRecordableProviderRef, type ExecutionFailureReason } from '../../features/execution-runtime/index.js';
import { isExecutionFailureReason, isOpaqueResolutionIdentifier, isPlainRecord } from '../execution-resolution-store/validation.js';
import { ExecutionReconciliationConfigurationError } from './errors.js';

/**
 * P12 — the trusted resolution authority: the one provider-neutral port through
 * which Frontera may later learn whether an uncertain execution completed.
 *
 * ## Trusted to answer provider truth — nothing else
 *
 * A resolution authority is **trusted host / operator integration**, composed
 * at `createEnterprise()` and never reachable from a customer. It is trusted to
 * say what the provider did. Compromise of it can falsely return capacity
 * (a lying "not completed") or falsely keep it consumed (a lying "completed"):
 * that is a real trust boundary, stated here rather than hidden behind the
 * word "adapter".
 *
 * It has no spending authority. Its answer cannot authorize, raise a ceiling,
 * change a budget, issue a grant, change a decision, select an amount or
 * change an asset: the query carries the exact attempt as **context**, and the
 * answer has no field through which any of that could come back.
 *
 * ## Read-only with respect to the original effect
 *
 * `resolve()` may query a provider's state. It must **not** execute, resubmit,
 * retry or otherwise mutate the original action to learn its state. The
 * implementation is trusted host code; the contract is stated here so that a
 * host writing one knows what it is promising. Frontera never calls an
 * `ExecutionAdapter` to reconcile: the write-ahead claim still owns at-most-once
 * execution.
 *
 * ## Definitive, or not a resolution
 *
 * The answer is closed: `resolved / confirmed-completed`,
 * `resolved / confirmed-not-completed` with one of the **existing**
 * provider-neutral failure reasons, or `unresolved`. No "probably", no score,
 * no confidence. An authority that cannot classify a non-completion truthfully
 * into the existing vocabulary answers `unresolved`, rather than lying to fit
 * the wire type. Time alone is never an answer.
 *
 * ## No credentials cross this port
 *
 * The query carries trusted execution context and, when one was recorded, the
 * opaque `providerRef`. Never a credential, a header, a URL or a request body.
 * An implementation that needs provider credentials owns them itself; P12 core
 * never receives or persists them.
 */
export interface ExecutionResolutionAuthority {
  /** Recordable identity, unique among the composed authorities. Snapshotted at composition. */
  readonly authorityId: string;
  resolve(query: ExecutionResolutionQuery): Promise<ExecutionResolutionAuthorityResult>;
}

/** P9 canonical money, as text, exactly as the P11 attempt recorded it. Context only — never an instruction. */
export interface ExecutionResolutionQueryAmount {
  readonly value: string;
  readonly unit: string;
}

/**
 * What an authority is asked. Everything here is the verified P11 attempt's —
 * the caller who started the governed action contributed none of it — plus the
 * opaque reference P11 recorded, when there is one. Frozen.
 */
export interface ExecutionResolutionQuery {
  readonly organizationId: string;
  readonly executionId: string;
  readonly evaluationId: string;
  readonly requestId: string;
  readonly decisionId: string;
  readonly boundedGrantId: string;
  readonly action: string;
  readonly amount?: ExecutionResolutionQueryAmount;
  /** The P11 initial observation's opaque handle. Never dereferenced by Frontera; never proof. */
  readonly providerRef?: string;
  /** Which uncertainty is being resolved: the provider's recorded "unknown", or no recorded observation at all. */
  readonly basis: 'initial-observation-unconfirmed' | 'no-initial-observation';
}

/** The closed answer. Anything else an authority returns is not an answer. */
export type ExecutionResolutionAuthorityResult =
  | { readonly outcome: 'resolved'; readonly certainty: 'confirmed-completed'; readonly providerRef?: string }
  | { readonly outcome: 'resolved'; readonly certainty: 'confirmed-not-completed'; readonly failure: ExecutionFailureReason; readonly providerRef?: string }
  | { readonly outcome: 'unresolved' };

/**
 * What the host's selector is told when a new governed execution is bound:
 * the prepared P11 attempt's trusted context, nothing more. No asserted
 * context, no request body, no header, no credential, no caller-selected
 * provider. Frozen.
 */
export interface ExecutionResolutionSelectionContext {
  readonly organizationId: string;
  readonly executionId: string;
  readonly evaluationId: string;
  readonly requestId: string;
  readonly decisionId: string;
  readonly boundedGrantId: string;
  readonly action: string;
  readonly amount?: ExecutionResolutionQueryAmount;
}

/**
 * Trusted, host-side, **synchronous** selection of the authority that may
 * later resolve one execution. It must return the `authorityId` of one of the
 * composed authorities. Anything else — a throw, a promise, an object, an
 * unknown or blank id — stops the execution before its claim and its provider.
 * There is no fallback authority and no "first one wins".
 */
export type ExecutionResolutionAuthoritySelector = (context: ExecutionResolutionSelectionContext) => string;

/** One composed authority, snapshotted: its identity and its `resolve` as they were at composition. */
export interface ComposedResolutionAuthority {
  readonly authorityId: string;
  readonly resolve: (query: ExecutionResolutionQuery) => Promise<unknown>;
}

/** The frozen composition-time snapshot of every trusted authority and the selector. */
export interface ResolutionAuthorityComposition {
  readonly authorities: ReadonlyMap<string, ComposedResolutionAuthority>;
  readonly select: ExecutionResolutionAuthoritySelector;
}

/**
 * Validates and snapshots the host's authorities and selector, once, at
 * `createEnterprise()`. Membership never changes afterwards: an authority is
 * never discovered per request, and mutating the host's array or objects
 * later changes nothing.
 */
export function snapshotResolutionAuthorities(authorities: unknown, selectAuthority: unknown, path: string): ResolutionAuthorityComposition {
  if (!Array.isArray(authorities) || authorities.length === 0) {
    throw new ExecutionReconciliationConfigurationError(`${path}.authorities must be a non-empty array of resolution authorities.`);
  }
  if (typeof selectAuthority !== 'function') {
    throw new ExecutionReconciliationConfigurationError(`${path}.selectAuthority must be a synchronous function returning a composed authorityId; there is no default selection.`);
  }
  const snapshot = new Map<string, ComposedResolutionAuthority>();
  for (const [index, candidate] of [...authorities].entries()) {
    if (candidate === null || typeof candidate !== 'object') throw new ExecutionReconciliationConfigurationError(`${path}.authorities[${String(index)}] is not an object.`);
    const authorityId = (candidate as { readonly authorityId?: unknown }).authorityId;
    const resolve = (candidate as { readonly resolve?: unknown }).resolve;
    if (!isOpaqueResolutionIdentifier(authorityId)) throw new ExecutionReconciliationConfigurationError(`${path}.authorities[${String(index)}].authorityId is not a recordable identifier.`);
    if (typeof resolve !== 'function') throw new ExecutionReconciliationConfigurationError(`${path}.authorities[${String(index)}].resolve is not a function.`);
    if (snapshot.has(authorityId)) throw new ExecutionReconciliationConfigurationError(`${path}.authorities declares '${authorityId}' more than once; every authorityId must be unique.`);
    snapshot.set(
      authorityId,
      Object.freeze({ authorityId, resolve: (query: ExecutionResolutionQuery) => Promise.resolve().then(() => (resolve as (query: ExecutionResolutionQuery) => unknown).call(candidate, query)) }),
    );
  }
  const select = selectAuthority as ExecutionResolutionAuthoritySelector;
  return Object.freeze({ authorities: snapshot, select });
}

/**
 * The selector, asked once, fenced. Returns the composed authority's id, or
 * `undefined` for every answer that is not exactly one composed id.
 */
export function selectResolutionAuthority(composition: ResolutionAuthorityComposition, context: ExecutionResolutionSelectionContext): string | undefined {
  let selected: unknown;
  try {
    selected = composition.select(context);
  } catch {
    return undefined;
  }
  // A primitive string only: a promise, a boxed String, a getter-backed object
  // or a Proxy is not an answer, and no property of it is ever read.
  if (typeof selected !== 'string' || !composition.authorities.has(selected)) return undefined;
  return selected;
}

/** A normalized, fresh, frozen answer — or `undefined` when the raw answer is not a closed answer. */
export type NormalizedResolutionAnswer =
  | { readonly outcome: 'unresolved' }
  | { readonly outcome: 'resolved'; readonly certainty: 'confirmed-completed'; readonly providerRef?: string }
  | { readonly outcome: 'resolved'; readonly certainty: 'confirmed-not-completed'; readonly failure: ExecutionFailureReason; readonly providerRef?: string };

const RESOLVED_KEYS = ['outcome', 'certainty', 'failure', 'providerRef'];

/**
 * Treats an authority's answer as external integration output: copied, once,
 * into a fresh plain object, from a plain object with exactly the declared keys.
 *
 * Refused — never partially believed — are a Proxy or getter that throws, a
 * class instance, an unknown outcome or certainty, a completion with a
 * failure, a non-completion without one or with a reason outside the existing
 * closed vocabulary, a `providerRef` that is not a string, and any extra key:
 * an amount, an asset, a grant, a budget, a decision, a correlation. A
 * `providerRef` that is a string but not a recordable reference is omitted,
 * exactly as P11 omits one — and its presence or absence never changes the
 * certainty.
 */
export function normalizeResolutionAnswer(raw: unknown): NormalizedResolutionAnswer | undefined {
  try {
    if (!isPlainRecord(raw)) return undefined;
    // Every own key is read once, from its descriptor, and must be a plain
    // data property: an accessor is refused unread, and no `get` trap of a
    // Proxy is ever consulted.
    const values = new Map<string, unknown>();
    for (const key of Reflect.ownKeys(raw)) {
      if (typeof key !== 'string') return undefined;
      const descriptor = Object.getOwnPropertyDescriptor(raw, key);
      if (descriptor === undefined || !('value' in descriptor)) return undefined;
      values.set(key, descriptor.value);
    }
    const outcome = values.get('outcome');
    if (outcome === 'unresolved') {
      return values.size === 1 ? Object.freeze({ outcome: 'unresolved' }) : undefined;
    }
    if (outcome !== 'resolved') return undefined;
    if ([...values.keys()].some((key) => !RESOLVED_KEYS.includes(key))) return undefined;
    const certainty = values.get('certainty');
    const failure = values.get('failure');
    const rawReference = values.get('providerRef');
    if (rawReference !== undefined && typeof rawReference !== 'string') return undefined;
    const reference = typeof rawReference === 'string' && isRecordableProviderRef(rawReference) ? { providerRef: rawReference } : {};
    if (certainty === 'confirmed-completed') {
      if (failure !== undefined) return undefined;
      return Object.freeze({ outcome: 'resolved', certainty: 'confirmed-completed', ...reference });
    }
    if (certainty === 'confirmed-not-completed') {
      if (!isExecutionFailureReason(failure)) return undefined;
      return Object.freeze({ outcome: 'resolved', certainty: 'confirmed-not-completed', failure: failure as ExecutionFailureReason, ...reference });
    }
    return undefined;
  } catch {
    return undefined;
  }
}
