import { EMERGENCY_CONTROL_REASON_CODE_VALUES } from '../../features/emergency-control-runtime/index.js';
import { EXERCISE_CONTROL_REASON_CODE_VALUES } from '../../features/exercise-control-runtime/index.js';
import {
  EXECUTION_FAILURE_REASON_VALUES,
  GRANT_EXERCISE_REASON_CODE_VALUES,
  isProviderEffectCertainty,
  isRecordableExecutionAdapterId,
  isRecordableProviderRef,
} from '../../features/execution-runtime/index.js';
import { isWellFormedMonetaryAmount } from '../../features/monetary-runtime/index.js';
import type { ExecutionWithholdingLayer } from './contracts.js';

/**
 * The closed contract every attempt and every terminal observation must
 * satisfy — checked by the store before anything is written, and again on
 * every read of a persisted row, in memory and in SQLite alike.
 *
 * Closed in every direction: exactly the declared keys, each of the declared
 * shape, and only the combinations the discriminated union allows. A completed
 * observation with a failure reason, a withheld one naming an adapter, an
 * unconfirmed one naming a withholding layer, an amount spelled as a number or
 * outside canonical decimal text — each is refused rather than normalized.
 */

const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/;
const CANONICAL_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const ACTION = /^[\x21-\x7e](?:[\x20-\x7e]{0,254}[\x21-\x7e])?$/;

export function isOpaqueExecutionIdentifier(value: unknown): value is string {
  return typeof value === 'string' && OPAQUE_ID.test(value);
}

export function isCanonicalOutcomeInstant(value: unknown): value is string {
  if (typeof value !== 'string' || !CANONICAL_INSTANT.test(value)) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

const WITHHOLDING_VOCABULARIES: Readonly<Record<ExecutionWithholdingLayer, ReadonlySet<string>>> = Object.freeze({
  'grant-exercise': new Set<string>(GRANT_EXERCISE_REASON_CODE_VALUES),
  'emergency-control': new Set<string>(EMERGENCY_CONTROL_REASON_CODE_VALUES),
  'exercise-control': new Set<string>(EXERCISE_CONTROL_REASON_CODE_VALUES),
});

export function isExecutionWithholdingLayer(value: unknown): value is ExecutionWithholdingLayer {
  return value === 'grant-exercise' || value === 'emergency-control' || value === 'exercise-control';
}

/** At least one code, none repeated, every one from **that layer's own** closed vocabulary. */
export function isCanonicalWithholdingReasonCodes(layer: ExecutionWithholdingLayer, codes: unknown): codes is readonly string[] {
  const vocabulary = WITHHOLDING_VOCABULARIES[layer];
  return (
    Array.isArray(codes) &&
    codes.length > 0 &&
    codes.length <= vocabulary.size &&
    new Set(codes).size === codes.length &&
    codes.every((code) => typeof code === 'string' && vocabulary.has(code))
  );
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function undeclared(value: Record<string, unknown>, allowed: readonly string[]): string | undefined {
  return Object.keys(value).find((key) => !allowed.includes(key));
}

const ATTEMPT_KEYS = ['organizationId', 'executionId', 'evaluationId', 'requestId', 'decisionId', 'boundedGrantId', 'action', 'amount', 'preparedAt'] as const;

/** Why a preparation is outside the contract, or `undefined` when it is inside it. */
export function executionAttemptViolation(input: unknown): string | undefined {
  if (!isPlainRecord(input)) return 'the attempt is not a plain object';
  const extra = undeclared(input, ATTEMPT_KEYS);
  if (extra !== undefined) return `undeclared key '${extra}'`;
  for (const key of ['organizationId', 'executionId', 'evaluationId', 'requestId', 'decisionId', 'boundedGrantId'] as const) {
    if (!isOpaqueExecutionIdentifier(input[key])) return `${key} is not an opaque identifier`;
  }
  if (typeof input['action'] !== 'string' || !ACTION.test(input['action'])) return 'action is not a bounded printable identifier';
  const amount = input['amount'];
  if (amount !== undefined) {
    if (!isPlainRecord(amount) || undeclared(amount, ['value', 'unit']) !== undefined || !isWellFormedMonetaryAmount(amount)) return 'amount is not canonical money';
  }
  if (!isCanonicalOutcomeInstant(input['preparedAt'])) return 'preparedAt is not a canonical instant';
  return undefined;
}

const PROVIDER_KEYS = ['kind', 'certainty', 'adapterId', 'routedBy', 'providerRef', 'failure', 'observedAt'] as const;
const WITHHELD_KEYS = ['kind', 'withheldBy', 'reasonCodes', 'observedAt'] as const;

/** Why an observation is outside the contract, or `undefined` when it is inside it. */
export function executionTerminalObservationViolation(observation: unknown): string | undefined {
  if (!isPlainRecord(observation)) return 'the observation is not a plain object';
  if (!isCanonicalOutcomeInstant(observation['observedAt'])) return 'observedAt is not a canonical instant';

  if (observation['kind'] === 'withheld') {
    const extra = undeclared(observation, WITHHELD_KEYS);
    // A withholding carries no adapter, reference, certainty or failure: no provider was reached.
    if (extra !== undefined) return `a withheld observation may not carry '${extra}'`;
    const layer = observation['withheldBy'];
    if (!isExecutionWithholdingLayer(layer)) return 'withheldBy is not a withholding layer';
    if (!isCanonicalWithholdingReasonCodes(layer, observation['reasonCodes'])) return "reasonCodes are not canonical codes of the withholding layer's own vocabulary";
    return undefined;
  }

  if (observation['kind'] !== 'provider') return 'kind is neither provider nor withheld';
  const extra = undeclared(observation, PROVIDER_KEYS);
  if (extra !== undefined) return `a provider observation may not carry '${extra}'`;
  const certainty = observation['certainty'];
  if (!isProviderEffectCertainty(certainty)) return 'certainty is not a provider effect certainty';
  const adapterId = observation['adapterId'];
  if (typeof adapterId !== 'string' || !isRecordableExecutionAdapterId(adapterId)) return 'adapterId is not a recordable adapter identity';
  const routedBy = observation['routedBy'];
  if (routedBy !== undefined && (typeof routedBy !== 'string' || !isRecordableExecutionAdapterId(routedBy))) return 'routedBy is not a recordable adapter identity';
  if (observation['providerRef'] !== undefined && !isRecordableProviderRef(observation['providerRef'])) return 'providerRef is not a recordable provider reference';
  const failure = observation['failure'];
  // Only a definitive non-completion carries a reason. A completion never
  // does, and an unconfirmed effect never does: a reason would claim a
  // non-completion nobody proved.
  if (certainty === 'confirmed-not-completed') {
    if (typeof failure !== 'string' || !(EXECUTION_FAILURE_REASON_VALUES as readonly string[]).includes(failure)) return 'a confirmed non-completion requires a failure reason';
  } else if (failure !== undefined) {
    return `a ${certainty} observation may not carry a failure reason`;
  }
  return undefined;
}
