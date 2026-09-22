import { EXERCISE_RESERVATION_RELEASE_REASONS, EXERCISE_RESERVATION_SETTLE_REASONS } from '../../features/exercise-control-runtime/index.js';
import { EXECUTION_FAILURE_REASON_VALUES, isRecordableExecutionAdapterId } from '../../features/execution-runtime/index.js';
import { GRANT_REVOCATION_REASONS } from '../../features/grant-runtime/index.js';
import { isWellFormedDigest } from '../governance-store/digest.js';
import {
  AUTHORITY_EVENT_REFERENCE_KEYS,
  isAuthorityEventType,
  type AppendAuthorityEventInput,
  type AuthorityEventReferenceKey,
  type AuthorityEventType,
} from './contracts.js';

/**
 * The closed contract every appended event must satisfy, checked by the store
 * before anything is written — in memory and in SQLite alike.
 *
 * Closed in every direction: a known event type, exactly the reference keys that
 * type declares, exactly the payload keys that type declares, and every value
 * bounded and of the declared shape. An undeclared key is refused rather than
 * ignored, so nothing — a header, a credential, a raw request body, a provider
 * response, an `assertedContext` bag — can travel inside an event because a
 * projector happened to attach it.
 *
 * Values are checked too, not only key names: no string anywhere in an event may
 * look like a bearer credential, a JWT, a PEM key, a URL or a cookie pair, and no
 * string may carry control characters. The projector never builds such a value;
 * this is the store refusing one if it ever did.
 */

const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/;
const REASON_CODE = /^[A-Z][A-Z0-9_]{0,127}$/;
const CANONICAL_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const MAX_REASON_CODES = 64;
const MAX_PROVIDER_REF_LENGTH = 512;

/** Value shapes that are never evidence here, whatever key carries them. */
const UNSAFE_VALUE_PATTERNS: readonly RegExp[] = [
  /\bbearer\s/i,
  /\bbasic\s+[A-Za-z0-9+/=]{8,}/i,
  /^eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}/,
  /-----BEGIN [A-Z ]*(PRIVATE KEY|CERTIFICATE)-----/,
  /[a-z][a-z0-9+.-]*:\/\//i,
  /(?:^|[;\s])(?:set-)?cookie\s*[:=]/i,
  /\bauthorization\s*[:=]/i,
];

const CONTROL = /[\u0000-\u001f\u007f]/;

export function isCanonicalEventInstant(value: unknown): value is string {
  if (typeof value !== 'string' || !CANONICAL_INSTANT.test(value)) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

export function isOpaqueEventIdentifier(value: unknown): value is string {
  return typeof value === 'string' && OPAQUE_ID.test(value);
}

/** True when a string could safely sit in an event: bounded, printable, and shaped like none of the secret or destination forms. */
export function isSafeEvidenceString(value: unknown, maxLength: number = MAX_PROVIDER_REF_LENGTH): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maxLength &&
    value === value.trim() &&
    !CONTROL.test(value) &&
    UNSAFE_VALUE_PATTERNS.every((pattern) => !pattern.test(value))
  );
}

const KERNEL_STATUSES: ReadonlySet<string> = new Set(['allowed', 'denied', 'approval_required', 'indeterminate']);
const EXECUTION_STATUSES: ReadonlySet<string> = new Set(['executed', 'execution-failed', 'execution-unconfirmed', 'withheld']);
const WITHHOLDING_LAYERS: ReadonlySet<string> = new Set(['grant-exercise', 'emergency-control', 'exercise-control']);
const FAILURE_REASONS: ReadonlySet<string> = new Set(EXECUTION_FAILURE_REASON_VALUES);
const REVOCATION_REASONS: ReadonlySet<string> = new Set(GRANT_REVOCATION_REASONS);
const SETTLE_REASONS: ReadonlySet<string> = new Set(EXERCISE_RESERVATION_SETTLE_REASONS);
const RELEASE_REASONS: ReadonlySet<string> = new Set(EXERCISE_RESERVATION_RELEASE_REASONS);

type Check = (value: unknown) => boolean;

const digest: Check = (value) => typeof value === 'string' && isWellFormedDigest(value);
const instant: Check = isCanonicalEventInstant;
const reasonCodes: Check = (value) => Array.isArray(value) && value.length <= MAX_REASON_CODES && value.every((code) => typeof code === 'string' && REASON_CODE.test(code));
const oneOf =
  (set: ReadonlySet<string>): Check =>
  (value) =>
    typeof value === 'string' && set.has(value);
const adapterId: Check = (value) => typeof value === 'string' && isRecordableExecutionAdapterId(value);
const providerRef: Check = (value) => isSafeEvidenceString(value, MAX_PROVIDER_REF_LENGTH);
const boolean: Check = (value) => typeof value === 'boolean';

interface PayloadSchema {
  readonly required: Readonly<Record<string, Check>>;
  readonly optional: Readonly<Record<string, Check>>;
}

interface EventSchema {
  readonly references: readonly AuthorityEventReferenceKey[];
  readonly payload: PayloadSchema;
}

/** Per event type: exactly which references and which payload keys exist. */
const SCHEMAS: Readonly<Record<AuthorityEventType, EventSchema>> = Object.freeze({
  'governance.decision.committed': {
    references: ['requestId', 'evaluationId', 'decisionId'],
    payload: { required: { status: oneOf(KERNEL_STATUSES), reasonCodes, evaluatedAt: instant, aggregateDigest: digest }, optional: {} },
  },
  'grant.issued': {
    references: ['requestId', 'decisionId', 'boundedGrantId'],
    payload: { required: { grantDigest: digest, expiresAt: instant }, optional: { authorityBindingDigest: digest } },
  },
  'grant.revoked': {
    references: ['requestId', 'decisionId', 'boundedGrantId'],
    payload: { required: { reason: oneOf(REVOCATION_REASONS) }, optional: {} },
  },
  'grant.expiry.observed': {
    references: ['requestId', 'decisionId', 'boundedGrantId'],
    payload: { required: { expiresAt: instant }, optional: {} },
  },
  'execution.attempt.claimed': {
    references: ['requestId', 'evaluationId', 'decisionId', 'boundedGrantId', 'executionId'],
    payload: { required: {}, optional: {} },
  },
  'exercise.reservation.reserved': {
    references: ['requestId', 'decisionId', 'boundedGrantId', 'executionId', 'reservationId'],
    payload: { required: { policyDigest: digest, authorityBindingDigest: digest }, optional: {} },
  },
  'exercise.reservation.settled': {
    references: ['requestId', 'decisionId', 'boundedGrantId', 'executionId', 'reservationId'],
    payload: { required: { reason: oneOf(SETTLE_REASONS) }, optional: {} },
  },
  'exercise.reservation.released': {
    references: ['requestId', 'decisionId', 'boundedGrantId', 'executionId', 'reservationId'],
    payload: { required: { reason: oneOf(RELEASE_REASONS) }, optional: {} },
  },
  'execution.outcome.observed': {
    references: ['requestId', 'evaluationId', 'decisionId', 'boundedGrantId', 'executionId'],
    payload: {
      required: { status: oneOf(EXECUTION_STATUSES), reasonCodes, outcomeRecorded: boolean },
      optional: { withheldBy: oneOf(WITHHOLDING_LAYERS), failure: oneOf(FAILURE_REASONS), adapterId, routedBy: adapterId, providerRef },
    },
  },
});

function isPlainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Every string reachable from `value`, so the unsafe-value rule applies to nested values as well as to leaves the schema names. */
function everyString(value: unknown, test: (text: string) => boolean): boolean {
  if (typeof value === 'string') return test(value);
  if (Array.isArray(value)) return value.every((item) => everyString(item, test));
  if (isPlainRecord(value)) return Object.values(value).every((item) => everyString(item, test));
  return true;
}

/** The certainty rules `ExecutionOutcome` already has, restated so an event can never blur them. */
function outcomeShapeHolds(payload: Readonly<Record<string, unknown>>): boolean {
  const status = payload.status;
  const codes = payload.reasonCodes as readonly string[];
  if (status === 'withheld') {
    return payload.withheldBy !== undefined && payload.failure === undefined && payload.adapterId === undefined && payload.routedBy === undefined && payload.providerRef === undefined && codes.length > 0;
  }
  if (payload.withheldBy !== undefined) return false;
  if (status === 'execution-failed') return payload.failure !== undefined && codes.length === 1 && codes[0] === payload.failure && payload.providerRef === undefined;
  if (payload.failure !== undefined) return false;
  if (status === 'execution-unconfirmed') return codes.length === 0 && payload.providerRef === undefined;
  return status === 'executed' && codes.length === 0;
}

/**
 * Why `input` is outside the contract, or `undefined` when it is inside it.
 * The reasons name fields, never values.
 */
export function authorityEventInputViolation(input: unknown): string | undefined {
  if (!isPlainRecord(input)) return 'the event is not a plain object';
  const allowed = new Set(['eventId', 'streamId', 'organizationId', 'eventType', 'occurredAt', 'references', 'payload']);
  for (const key of Object.keys(input)) if (!allowed.has(key)) return `undeclared event field '${key}'`;
  if (!isAuthorityEventType(input.eventType)) return 'unknown event type';
  if (!isOpaqueEventIdentifier(input.eventId) || !input.eventId.startsWith('aoc.aev:')) return 'malformed eventId';
  if (!isOpaqueEventIdentifier(input.streamId) || !input.streamId.startsWith('aoc.aes:')) return 'malformed streamId';
  if (!isOpaqueEventIdentifier(input.organizationId)) return 'malformed organizationId';
  if (!isCanonicalEventInstant(input.occurredAt)) return 'occurredAt is not a canonical instant';

  const schema = SCHEMAS[input.eventType];
  const references = input.references;
  if (!isPlainRecord(references)) return 'references is not a plain object';
  const declared = new Set<string>(schema.references);
  for (const key of Object.keys(references)) {
    if (!(AUTHORITY_EVENT_REFERENCE_KEYS as readonly string[]).includes(key) || !declared.has(key)) return `undeclared reference '${key}'`;
  }
  for (const key of schema.references) if (!isOpaqueEventIdentifier(references[key])) return `missing or malformed reference '${key}'`;

  const payload = input.payload;
  if (!isPlainRecord(payload)) return 'payload is not a plain object';
  for (const key of Object.keys(payload)) {
    if (!(key in schema.payload.required) && !(key in schema.payload.optional)) return `undeclared payload field '${key}'`;
  }
  for (const [key, check] of Object.entries(schema.payload.required)) if (!check(payload[key])) return `missing or malformed payload field '${key}'`;
  for (const [key, check] of Object.entries(schema.payload.optional)) if (payload[key] !== undefined && !check(payload[key])) return `malformed payload field '${key}'`;
  if (input.eventType === 'execution.outcome.observed' && !outcomeShapeHolds(payload)) return 'the outcome payload blurs the execution certainty rules';

  if (!everyString(input, (text) => !CONTROL.test(text) && UNSAFE_VALUE_PATTERNS.every((pattern) => !pattern.test(text)))) return 'a value is shaped like a credential, a destination or a header';
  return undefined;
}

export function isValidAuthorityEventInput(input: unknown): input is AppendAuthorityEventInput {
  return authorityEventInputViolation(input) === undefined;
}
