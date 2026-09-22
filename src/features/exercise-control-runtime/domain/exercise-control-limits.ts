import { createHash } from 'crypto';

import { EXERCISE_DECIMAL_MAXIMUM_DIGITS, isCanonicalExerciseDecimal } from './exercise-decimal.js';

/**
 * The closed aggregate-limit contract, and the trusted policy that produces it.
 *
 * ## The policy is trusted host composition, never caller input
 *
 * A limit, its bucket (`scopeKey`), its metric, its maximum and its window are
 * all chosen by the deployment's own code. Nothing a caller sends — the
 * governed-action intent, its `assertedContext`, the SDK, a header — can name
 * any of them, and the query the policy receives is built only from values the
 * authoritative grant holds or the grant-exercise assessment has already
 * proven inside the grant.
 *
 * ## It narrows, and nothing else
 *
 * A limit can only stop an execution that the grant already covered. It is
 * consulted after the grant, after containment and after the emergency
 * control; it cannot widen a Kernel decision, a grant or an attempt, because
 * there is no path from its result to anything but "reserve" or "withhold".
 *
 * ## Why the result is re-validated here rather than typed and trusted
 *
 * The policy is host code, but its *answer* is still an input to an authority
 * check. A policy that throws, returns a promise, returns a getter that throws,
 * returns a `Proxy`, returns 33 limits, repeats a bucket, or states a maximum
 * this runtime cannot enforce exactly is a policy whose answer cannot be
 * believed — and the closed direction for an unbelievable limit is to withhold,
 * not to run with no limit. `snapshotExerciseControlLimits` reads the answer
 * once, into a fresh frozen copy, and every later step reads only the copy.
 */

/** At most this many limits apply to one exercise. */
export const EXERCISE_CONTROL_MAXIMUM_LIMITS = 32;

/** The longest rolling window Stage A enforces: one 365-day year. */
export const EXERCISE_CONTROL_MAXIMUM_ROLLING_SECONDS = 31_536_000;

/** Operator-controlled, bounded, canonical and safe to record verbatim. */
export const EXERCISE_CONTROL_LIMIT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;

/** A bucket key is opaque host data, bounded by its UTF-8 size. */
export const EXERCISE_CONTROL_SCOPE_KEY_MAXIMUM_BYTES = 512;

/** An amount unit is compared exactly against the attempt's unit, bounded by its UTF-8 size. */
export const EXERCISE_CONTROL_UNIT_MAXIMUM_BYTES = 64;

export const EXERCISE_CONTROL_METRICS = ['count', 'amount'] as const;
export type ExerciseControlMetric = (typeof EXERCISE_CONTROL_METRICS)[number];

export type ExerciseControlWindow =
  /** Every active reservation in the bucket counts, forever. */
  | { readonly kind: 'lifetime' }
  /** Active reservations whose reservation instant lies within the last `seconds` seconds — or in the future — count. */
  | { readonly kind: 'rolling'; readonly seconds: number };

/**
 * One aggregate limit.
 *
 * `count` consumes exactly one unit per reserved execution identity; `amount`
 * consumes the attempt's amount, which must be stated and must be denominated
 * in exactly `unit`. There is no third metric, no conversion, and no field a
 * limit could use to point at a provider, an adapter or a grant.
 */
export type ExerciseControlLimit =
  | {
      readonly limitId: string;
      readonly scopeKey: string;
      readonly metric: 'count';
      /** A positive safe integer. */
      readonly maximum: number;
      readonly window: ExerciseControlWindow;
    }
  | {
      readonly limitId: string;
      readonly scopeKey: string;
      readonly metric: 'amount';
      /** A canonical non-negative decimal string — see `exercise-decimal.ts`. */
      readonly maximum: string;
      readonly unit: string;
      readonly window: ExerciseControlWindow;
    };

/**
 * What the trusted policy — and, separately, the exercise-time authority
 * binding resolver — is told about one exercise.
 *
 * Every field is trusted by construction. `subject`, `grantIssuedAt` and
 * `grantExpiresAt` are read from the authoritative grant, never from the
 * request. `action`, `resource`, `counterparty`, `organization` and `amount`
 * reach this query only **after** the grant-exercise assessment proved each of
 * them inside the grant. There is no raw intent, no `assertedContext`, no
 * provider URL, header, credential or adapter configuration, no store, no
 * Governance Store and no Kernel handle here, and there is no field through
 * which one could be added.
 *
 * The object handed to a policy is frozen, so a policy cannot alter what the
 * binding resolver or the reservation sees afterwards.
 */
export interface ExerciseControlQuery {
  readonly boundedGrantId: string;
  readonly subject: string;
  readonly action: string;
  readonly resource: string;
  readonly counterparty?: string;
  readonly organization?: string;
  readonly amount?: { readonly value: number; readonly unit: string };
  readonly correlation: {
    readonly requestId: string;
    readonly decisionId: string;
    readonly action: string;
    readonly resourceScope: string;
  };
  readonly grantIssuedAt: string;
  readonly grantExpiresAt: string;
  /** The exercise instant, from the injected clock. */
  readonly at: string;
}

export type ExerciseControlPolicyQuery = ExerciseControlQuery;

/**
 * The trusted host policy. **Synchronous, no I/O.**
 *
 * Returns the limits that apply to this exercise — possibly none. An empty
 * array is a valid answer ("no aggregate limit applies"), and the execution is
 * still reserved: with exercise controls composed, no adapter call happens
 * without a reservation, so an execution identity is one attempt even when no
 * limit applies.
 */
export type ExerciseControlPolicy = (query: ExerciseControlPolicyQuery) => readonly ExerciseControlLimit[];

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).length;
}

const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** Non-empty, bounded, free of control characters and lone surrogates, and carrying no surrounding whitespace that would make two spellings name one bucket. */
function isBoundedOpaqueText(value: unknown, maximumBytes: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value === value.trim() &&
    !CONTROL_CHARACTER.test(value) &&
    !LONE_SURROGATE.test(value) &&
    utf8Bytes(value) <= maximumBytes
  );
}

export function isCanonicalExerciseControlLimitId(value: unknown): value is string {
  return typeof value === 'string' && EXERCISE_CONTROL_LIMIT_ID_PATTERN.test(value);
}

export function isCanonicalExerciseControlScopeKey(value: unknown): value is string {
  return isBoundedOpaqueText(value, EXERCISE_CONTROL_SCOPE_KEY_MAXIMUM_BYTES);
}

export function isCanonicalExerciseControlUnit(value: unknown): value is string {
  return isBoundedOpaqueText(value, EXERCISE_CONTROL_UNIT_MAXIMUM_BYTES);
}

function isPlainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

/** Reads a data property exactly once. An accessor is refused: a getter is code, and code runs again every time it is read. */
function ownData(source: Readonly<Record<string, unknown>>, key: string): { readonly present: boolean; readonly value?: unknown } {
  const descriptor = Object.getOwnPropertyDescriptor(source, key);
  if (descriptor === undefined) return { present: false };
  if (!('value' in descriptor)) throw new TypeError(`'${key}' is an accessor, not a value.`);
  return { present: true, value: descriptor.value as unknown };
}

function hasExactlyKeys(source: Readonly<Record<string, unknown>>, permitted: readonly string[]): boolean {
  const keys = Reflect.ownKeys(source);
  return keys.length === permitted.length && keys.every((key) => typeof key === 'string' && permitted.includes(key));
}

function snapshotWindow(raw: unknown): ExerciseControlWindow | undefined {
  if (!isPlainRecord(raw)) return undefined;
  const kind = ownData(raw, 'kind').value;
  if (kind === 'lifetime') return hasExactlyKeys(raw, ['kind']) ? Object.freeze({ kind: 'lifetime' }) : undefined;
  if (kind === 'rolling') {
    if (!hasExactlyKeys(raw, ['kind', 'seconds'])) return undefined;
    const seconds = ownData(raw, 'seconds').value;
    if (typeof seconds !== 'number' || !Number.isSafeInteger(seconds) || seconds < 1 || seconds > EXERCISE_CONTROL_MAXIMUM_ROLLING_SECONDS) return undefined;
    return Object.freeze({ kind: 'rolling', seconds });
  }
  return undefined;
}

function snapshotLimit(raw: unknown): ExerciseControlLimit | undefined {
  if (!isPlainRecord(raw)) return undefined;
  const limitId = ownData(raw, 'limitId').value;
  const scopeKey = ownData(raw, 'scopeKey').value;
  const metric = ownData(raw, 'metric').value;
  const maximum = ownData(raw, 'maximum').value;
  if (!isCanonicalExerciseControlLimitId(limitId) || !isCanonicalExerciseControlScopeKey(scopeKey)) return undefined;
  const window = snapshotWindow(ownData(raw, 'window').value);
  if (window === undefined) return undefined;

  if (metric === 'count') {
    if (!hasExactlyKeys(raw, ['limitId', 'scopeKey', 'metric', 'maximum', 'window'])) return undefined;
    if (typeof maximum !== 'number' || !Number.isSafeInteger(maximum) || maximum < 1) return undefined;
    return Object.freeze({ limitId, scopeKey, metric: 'count', maximum, window });
  }
  if (metric === 'amount') {
    if (!hasExactlyKeys(raw, ['limitId', 'scopeKey', 'metric', 'maximum', 'unit', 'window'])) return undefined;
    const unit = ownData(raw, 'unit').value;
    if (!isCanonicalExerciseDecimal(maximum, EXERCISE_DECIMAL_MAXIMUM_DIGITS) || !isCanonicalExerciseControlUnit(unit)) return undefined;
    return Object.freeze({ limitId, scopeKey, metric: 'amount', maximum, unit, window });
  }
  return undefined;
}

/**
 * The policy's answer as a fresh, frozen, validated snapshot — or `undefined`
 * when the answer is not one this runtime can enforce exactly.
 *
 * Deliberately unforgiving: anything that is not an array of at most
 * `EXERCISE_CONTROL_MAXIMUM_LIMITS` plain limit objects with exactly the
 * contract's keys, every value canonical, and no `(limitId, scopeKey)` stated
 * twice, is refused as a whole. Duplicates are refused rather than merged —
 * "which of the two maxima did the host mean?" is not a question to answer by
 * picking one.
 *
 * May throw when the answer's own code throws while being read; callers read
 * it inside a `try` and treat a throw exactly like `undefined`.
 */
export function snapshotExerciseControlLimits(raw: unknown): readonly ExerciseControlLimit[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const length = (raw as readonly unknown[]).length;
  if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0 || length > EXERCISE_CONTROL_MAXIMUM_LIMITS) return undefined;
  const limits: ExerciseControlLimit[] = [];
  const buckets = new Set<string>();
  for (let index = 0; index < length; index += 1) {
    const limit = snapshotLimit((raw as readonly unknown[])[index]);
    if (limit === undefined) return undefined;
    const bucket = exerciseControlBucketKey(limit);
    if (buckets.has(bucket)) return undefined;
    buckets.add(bucket);
    limits.push(limit);
  }
  return Object.freeze(sortExerciseControlLimits(limits));
}

/** One bucket is one `(limitId, scopeKey)` pair. Serialized unambiguously, so no two pairs share a key. */
export function exerciseControlBucketKey(limit: { readonly limitId: string; readonly scopeKey: string }): string {
  return JSON.stringify([limit.limitId, limit.scopeKey]);
}

/** Deterministic order: `limitId`, then `scopeKey`, by UTF-16 code unit. A pair is unique within a snapshot, so this is a total order on it. */
export function sortExerciseControlLimits<T extends { readonly limitId: string; readonly scopeKey: string }>(limits: readonly T[]): T[] {
  return [...limits].sort((left, right) =>
    left.limitId < right.limitId ? -1 : left.limitId > right.limitId ? 1 : left.scopeKey < right.scopeKey ? -1 : left.scopeKey > right.scopeKey ? 1 : 0,
  );
}

function serializeWindow(window: ExerciseControlWindow): string {
  return window.kind === 'lifetime' ? '{"kind":"lifetime"}' : `{"kind":"rolling","seconds":${String(window.seconds)}}`;
}

/** The canonical serialization of one limit: lexicographic keys, no whitespace, `unit` present exactly on the amount arm. */
export function serializeExerciseControlLimit(limit: ExerciseControlLimit): string {
  const maximum = limit.metric === 'count' ? String(limit.maximum) : JSON.stringify(limit.maximum);
  return [
    '{',
    [
      `"limitId":${JSON.stringify(limit.limitId)}`,
      `"maximum":${maximum}`,
      `"metric":${JSON.stringify(limit.metric)}`,
      `"scopeKey":${JSON.stringify(limit.scopeKey)}`,
      ...(limit.metric === 'amount' ? [`"unit":${JSON.stringify(limit.unit)}`] : []),
      `"window":${serializeWindow(limit.window)}`,
    ].join(','),
    '}',
  ].join('');
}

/**
 * `sha256:<hex>` over the canonical, sorted limit set.
 *
 * The order a policy happens to return its limits in does not change it; a
 * changed maximum, metric, unit, window, bucket or limit id does. A reservation
 * records the digest it was admitted under, so a re-delivered execution
 * identity whose effective policy has since changed is a conflict rather than a
 * silent replay under different limits.
 */
export function exerciseControlPolicyDigest(limits: readonly ExerciseControlLimit[]): string {
  const canonical = `[${sortExerciseControlLimits(limits).map(serializeExerciseControlLimit).join(',')}]`;
  return `sha256:${createHash('sha256').update(canonical).digest('hex')}`;
}
