import { createHash } from 'node:crypto';

import {
  EXERCISE_CONTROL_MAXIMUM_ROLLING_SECONDS,
  isCanonicalExerciseControlLimitId,
  isCanonicalExerciseControlScopeKey,
  type ExerciseControlLimit,
} from '../../features/exercise-control-runtime/index.js';
import { isPositiveMonetaryAmount, isWellFormedMonetaryAmount, isCanonicalDecimal, type MonetaryAmount } from '../../features/monetary-runtime/index.js';
import { grantAuthorityBindingDigest, serializeGrantAuthorityBinding, type GrantAuthorityBinding } from './authority-binding.js';

/**
 * P10 — authority-sourced payment ceilings and durable spending limits, as the
 * authority-controlled execution composition sees them.
 *
 * > **The amount an actor asks to spend is never the source of the amount the
 * > actor is authorized to spend.**
 *
 * Four monetary concepts stay distinct, and this module only ever carries the
 * two that are authority:
 *
 * | concept | example | source |
 * | --- | --- | --- |
 * | requested amount | 25 USD | the governed intent — the *proposed effect*, never authority |
 * | policy threshold | allow when amount ≤ 10,000 | a Kernel policy rule — used to decide, never a ceiling |
 * | per-execution ceiling | ≤ 100 USD per payment | durable authority (`max_amount`) — **here** |
 * | aggregate spending limit | ≤ 500 USD / 24h | durable authority (`spending_limit`) — **here**; consumption is P7's ledger |
 *
 * ## A port, not a second authority model
 *
 * This file defines the *question* ("what monetary authority stands behind
 * this financial action, on the lineage that authorized it?") and what a
 * trustworthy answer must look like. It does not answer it: the answer comes
 * from the durable Kernel Authority world, through a resolver the composition
 * root builds (`kernel-authority/financial-authority-resolver.ts`). There is no
 * payment kernel, payment grant or payment policy engine here, and no store.
 *
 * ## Synchronous, read-only
 *
 * The resolver is asked three times per financial action — at issuance, inside
 * the grant store's synchronous commit guard, and at exercise inside the P7
 * gate — so, like `GrantAuthorityBindingResolver`, it must answer from an
 * in-memory projection with no `await` and no I/O.
 */

/** Why a financial action was not given an executable grant because its monetary authority could not be established. A separate vocabulary: none of these is a policy denial, and the Kernel decision is never rewritten. */
export const FINANCIAL_AUTHORITY_REASON_CODES = {
  /** No trusted resolver, no authority lineage the recognition layer established for this decision, a lineage that no longer matches it, or a resolver that threw. Unknown authority is never unlimited authority. */
  FINANCIAL_AUTHORITY_UNRESOLVED: 'FINANCIAL_AUTHORITY_UNRESOLVED',
  /** An authority or delegation grant on the lineage is revoked, suspended or expired. */
  FINANCIAL_AUTHORITY_INACTIVE: 'FINANCIAL_AUTHORITY_INACTIVE',
  /** The lineage states no per-execution ceiling (`max_amount`) at all. */
  FINANCIAL_AUTHORITY_CEILING_MISSING: 'FINANCIAL_AUTHORITY_CEILING_MISSING',
  /** A monetary constraint on the lineage is malformed, names an unrecognized asset, or exceeds its asset's trusted scale. */
  FINANCIAL_AUTHORITY_MALFORMED: 'FINANCIAL_AUTHORITY_MALFORMED',
  /** The lineage bounds other assets but not the one requested. Different assets are incomparable; nothing is converted. */
  FINANCIAL_AUTHORITY_ASSET_MISMATCH: 'FINANCIAL_AUTHORITY_ASSET_MISMATCH',
  /** The requested amount exceeds the authority's per-execution ceiling. No grant is issued; the effect is never attempted. */
  FINANCIAL_AUTHORITY_CEILING_EXCEEDED: 'FINANCIAL_AUTHORITY_CEILING_EXCEEDED',
  /** The lineage states no durable aggregate spending limit in the requested asset. A missing aggregate limit is not an unlimited one. */
  FINANCIAL_AUTHORITY_SPENDING_LIMIT_MISSING: 'FINANCIAL_AUTHORITY_SPENDING_LIMIT_MISSING',
  /** A financial action with no exact amount stated reached issuance. */
  FINANCIAL_AUTHORITY_AMOUNT_REQUIRED: 'FINANCIAL_AUTHORITY_AMOUNT_REQUIRED',
  /** The monetary authority re-resolved inside the grant store's commit boundary is not exactly the authority measured at issuance. */
  FINANCIAL_AUTHORITY_CHANGED: 'FINANCIAL_AUTHORITY_CHANGED',
} as const;

export type FinancialAuthorityReasonCode = (typeof FINANCIAL_AUTHORITY_REASON_CODES)[keyof typeof FINANCIAL_AUTHORITY_REASON_CODES];

export const FINANCIAL_AUTHORITY_REASON_CODE_VALUES: readonly FinancialAuthorityReasonCode[] = Object.values(FINANCIAL_AUTHORITY_REASON_CODES);

/** One durable aggregate spending limit, already in P7's amount-limit shape. `limitId` and `scopeKey` are derived from trusted authority identity — never from a request, a grant id or an execution id. */
export interface FinancialSpendingLimit {
  readonly limitId: string;
  readonly scopeKey: string;
  readonly maximum: string;
  readonly unit: string;
  readonly window: { readonly kind: 'lifetime' } | { readonly kind: 'rolling'; readonly seconds: number };
}

/** The monetary authority behind one financial action, on one authority lineage, in one asset. */
export interface FinancialAuthority {
  readonly organizationId: string;
  readonly trustDomainId: string;
  /** The actor the lineage terminates at. */
  readonly subject: string;
  /** The authority lineage, terminal hop first, as `<entity-kind>:<entity-id>`. Identity, not just shape: a replacement authority with identical terms is a different lineage. */
  readonly lineage: readonly string[];
  /** The effective per-execution ceiling: the narrowest `max_amount` in `ceiling.unit` on the lineage. */
  readonly ceiling: MonetaryAmount;
  /** Every durable aggregate limit in `ceiling.unit` on the lineage. All of them apply. Never empty. */
  readonly spendingLimits: readonly FinancialSpendingLimit[];
}

export interface FinancialAuthorityQuery {
  /** `issuance` the first time; `commit` inside the grant store's critical section; `exercise` inside the P7 gate. */
  readonly phase: 'issuance' | 'commit' | 'exercise';
  readonly subject: string;
  readonly action: string;
  readonly resourceScope: string;
  readonly organizationId?: string;
  /** The requested asset. Monetary authority is resolved per asset and never across assets. */
  readonly asset: string;
  /** The instant expiry is judged at. */
  readonly at: string;
  /**
   * Issuance only: the Authority Graph decision the recognition layer reported
   * on the decision being issued from. The resolver must prove the lineage it
   * resolves is exactly the lineage that decision evaluated — never "any
   * authority for this actor that happens to mention this asset".
   */
  readonly authorityDecisionId?: string;
}

export type FinancialAuthorityResolution =
  | { readonly resolved: true; readonly authority: FinancialAuthority }
  | { readonly resolved: false; readonly reasonCode: FinancialAuthorityReasonCode };

/** The trusted resolver. **Synchronous, read-only, no I/O.** */
export type FinancialAuthorityResolver = (query: FinancialAuthorityQuery) => FinancialAuthorityResolution;

/** What a composition hands Authority-Controlled Execution to adopt P10. */
export interface AuthorityControlledFinancialAuthority {
  readonly resolve: FinancialAuthorityResolver;
}

const UNRESOLVED: FinancialAuthorityResolution = { resolved: false, reasonCode: FINANCIAL_AUTHORITY_REASON_CODES.FINANCIAL_AUTHORITY_UNRESOLVED };

function readOwn(source: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(source, key);
  if (descriptor === undefined || !('value' in descriptor)) return undefined;
  return descriptor.value as unknown;
}

function isText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function snapshotWindow(raw: unknown): FinancialSpendingLimit['window'] | undefined {
  if (raw === null || typeof raw !== 'object') return undefined;
  const kind = readOwn(raw, 'kind');
  if (kind === 'lifetime') return Object.freeze({ kind: 'lifetime' });
  const seconds = readOwn(raw, 'seconds');
  if (kind === 'rolling' && typeof seconds === 'number' && Number.isSafeInteger(seconds) && seconds >= 1 && seconds <= EXERCISE_CONTROL_MAXIMUM_ROLLING_SECONDS) {
    return Object.freeze({ kind: 'rolling', seconds });
  }
  return undefined;
}

/**
 * A fresh, validated, frozen copy of what the resolver returned — or an
 * unresolved answer. Read data properties only, once, so a getter or a Proxy
 * cannot hand one value to validation and another to the digest; and the
 * answer must be *about the question asked*: the requested subject, the
 * requested asset, a positive exact ceiling, and at least one aggregate limit
 * in that asset.
 */
function snapshotResolution(returned: unknown, query: FinancialAuthorityQuery): FinancialAuthorityResolution {
  if (returned === null || typeof returned !== 'object') return UNRESOLVED;
  const resolved = readOwn(returned, 'resolved');
  if (resolved === false) {
    const reasonCode = readOwn(returned, 'reasonCode');
    return typeof reasonCode === 'string' && (FINANCIAL_AUTHORITY_REASON_CODE_VALUES as readonly string[]).includes(reasonCode)
      ? { resolved: false, reasonCode: reasonCode as FinancialAuthorityReasonCode }
      : UNRESOLVED;
  }
  if (resolved !== true) return UNRESOLVED;
  const authority = readOwn(returned, 'authority');
  if (authority === null || typeof authority !== 'object') return UNRESOLVED;

  const organizationId = readOwn(authority, 'organizationId');
  const trustDomainId = readOwn(authority, 'trustDomainId');
  const subject = readOwn(authority, 'subject');
  const lineage = readOwn(authority, 'lineage');
  const ceiling = readOwn(authority, 'ceiling');
  const limits = readOwn(authority, 'spendingLimits');
  if (!isText(organizationId) || !isText(trustDomainId) || subject !== query.subject) return UNRESOLVED;
  if (query.organizationId !== undefined && organizationId !== query.organizationId) return UNRESOLVED;
  if (!Array.isArray(lineage) || lineage.length === 0 || !lineage.every(isText)) return UNRESOLVED;
  if (ceiling === null || typeof ceiling !== 'object') return UNRESOLVED;
  const ceilingCopy = { value: readOwn(ceiling, 'value'), unit: readOwn(ceiling, 'unit') };
  if (!isWellFormedMonetaryAmount(ceilingCopy) || !isPositiveMonetaryAmount(ceilingCopy) || ceilingCopy.unit !== query.asset) return UNRESOLVED;
  if (!Array.isArray(limits) || limits.length === 0) return UNRESOLVED;

  const spendingLimits: FinancialSpendingLimit[] = [];
  for (const raw of limits as readonly unknown[]) {
    if (raw === null || typeof raw !== 'object') return UNRESOLVED;
    const limitId = readOwn(raw, 'limitId');
    const scopeKey = readOwn(raw, 'scopeKey');
    const maximum = readOwn(raw, 'maximum');
    const unit = readOwn(raw, 'unit');
    const window = snapshotWindow(readOwn(raw, 'window'));
    if (!isCanonicalExerciseControlLimitId(limitId) || !isCanonicalExerciseControlScopeKey(scopeKey) || !isCanonicalDecimal(maximum) || maximum === '0' || unit !== query.asset || window === undefined) {
      return UNRESOLVED;
    }
    spendingLimits.push(Object.freeze({ limitId, scopeKey, maximum, unit, window }));
  }

  return {
    resolved: true,
    authority: Object.freeze({
      organizationId,
      trustDomainId,
      subject,
      lineage: Object.freeze([...(lineage as readonly string[])]),
      ceiling: Object.freeze({ value: ceilingCopy.value, unit: ceilingCopy.unit }),
      spendingLimits: Object.freeze(sortSpendingLimits(spendingLimits)),
    }),
  };
}

/** Asks the trusted resolver, and believes nothing it cannot validate. A throw, a promise, or an answer about a different subject or asset is `FINANCIAL_AUTHORITY_UNRESOLVED`. */
export function resolveFinancialAuthority(resolver: FinancialAuthorityResolver | undefined, query: FinancialAuthorityQuery): FinancialAuthorityResolution {
  if (resolver === undefined) return UNRESOLVED;
  try {
    return snapshotResolution(resolver(Object.freeze({ ...query })), query);
  } catch {
    return UNRESOLVED;
  }
}

function sortSpendingLimits(limits: readonly FinancialSpendingLimit[]): FinancialSpendingLimit[] {
  return [...limits].sort((left, right) =>
    left.limitId < right.limitId ? -1 : left.limitId > right.limitId ? 1 : left.scopeKey < right.scopeKey ? -1 : left.scopeKey > right.scopeKey ? 1 : 0,
  );
}

function serializeWindow(window: FinancialSpendingLimit['window']): string {
  return window.kind === 'lifetime' ? '{"kind":"lifetime"}' : `{"kind":"rolling","seconds":${String(window.seconds)}}`;
}

/** The canonical-serialization format of a financial authority. A digest taken under another value is not comparable. */
export const FINANCIAL_AUTHORITY_FORMAT = 'aoc.financial-authority.v1';

/**
 * The canonical serialization of a financial authority: fixed lexicographic
 * key order, no whitespace, lineage in chain order (order is identity there),
 * spending limits sorted by `(limitId, scopeKey)` so assembly order never reads
 * as a change, and the format tag in the bytes.
 */
export function serializeFinancialAuthority(authority: FinancialAuthority): string {
  const limits = sortSpendingLimits(authority.spendingLimits)
    .map(
      (limit) =>
        `{"limitId":${JSON.stringify(limit.limitId)},"maximum":${JSON.stringify(limit.maximum)},"scopeKey":${JSON.stringify(limit.scopeKey)},"unit":${JSON.stringify(limit.unit)},"window":${serializeWindow(limit.window)}}`,
    )
    .join(',');
  return [
    '{',
    [
      `"ceiling":{"unit":${JSON.stringify(authority.ceiling.unit)},"value":${JSON.stringify(authority.ceiling.value)}}`,
      `"format":${JSON.stringify(FINANCIAL_AUTHORITY_FORMAT)}`,
      `"lineage":[${authority.lineage.map((step) => JSON.stringify(step)).join(',')}]`,
      `"organizationId":${JSON.stringify(authority.organizationId)}`,
      `"spendingLimits":[${limits}]`,
      `"subject":${JSON.stringify(authority.subject)}`,
      `"trustDomainId":${JSON.stringify(authority.trustDomainId)}`,
    ].join(','),
    '}',
  ].join('');
}

/** `sha256:<hex>` over `serializeFinancialAuthority`. Equivalent authority state digests identically; any different monetary authority, lineage or scope digests differently. Integrity, not authenticity. */
export function financialAuthorityDigest(authority: FinancialAuthority): string {
  return `sha256:${createHash('sha256').update(serializeFinancialAuthority(authority)).digest('hex')}`;
}

/** The format of a grant's combined provenance when it carries financial authority. */
export const GRANT_AUTHORITY_PROVENANCE_FORMAT = 'aoc.grant-authority-provenance.v1';

/**
 * The provenance commitment a grant records as `authorityBindingDigest`.
 *
 * For a **non-financial** grant it is exactly `grantAuthorityBindingDigest(binding)`
 * — byte-identical to every grant issued before P10, so nothing about
 * non-financial exercise moves.
 *
 * For a **financial** grant it commits to the binding *and* to the financial
 * authority that supplied the grant's ceiling and aggregate limits. Exercise
 * revalidation recomputes it from the authority that holds *now*, so a revoked,
 * narrowed, replaced or re-lineaged authority withholds before any capacity is
 * consumed — and a financial grant issued before P10, whose digest commits to
 * the binding alone, can never match and is withheld until it expires. No
 * digest is ever fabricated for an old record.
 */
export function grantAuthorityProvenanceDigest(binding: GrantAuthorityBinding, financial: FinancialAuthority | undefined): string {
  if (financial === undefined) return grantAuthorityBindingDigest(binding);
  const canonical = `{"binding":${serializeGrantAuthorityBinding(binding)},"financialAuthority":${JSON.stringify(financialAuthorityDigest(financial))},"format":${JSON.stringify(GRANT_AUTHORITY_PROVENANCE_FORMAT)}}`;
  return `sha256:${createHash('sha256').update(canonical).digest('hex')}`;
}

/** The durable spending limits as P7 amount limits — the exact values, never converted. */
export function financialAuthorityExerciseLimits(authority: FinancialAuthority): readonly ExerciseControlLimit[] {
  return authority.spendingLimits.map((limit) => ({ limitId: limit.limitId, scopeKey: limit.scopeKey, metric: 'amount' as const, maximum: limit.maximum, unit: limit.unit, window: limit.window }));
}
