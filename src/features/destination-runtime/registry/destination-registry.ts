import { executionDestinationKey, parseExecutionDestination, type ExecutionDestination } from '../domain/index.js';

/**
 * Destination registry membership (ANDREW-P0-02).
 *
 * > **Registered means "Frontera has a durable record identifying this
 * > destination" — and nothing more.**
 *
 * ## Membership is not approval
 *
 * The registry answers one question — *is this exact destination known?* —
 * with one of two answers, `unknown` or `known`. It holds no approval, trust,
 * revocation, expiry or allow-list state, and its records have nowhere to keep
 * any: a known destination is exactly as unapproved as an unknown one until a
 * governance layer (P0-03+) says otherwise, scoped to whatever that layer
 * scopes it to. `registeredBy` is who or what *recorded* the destination, never
 * who approved sending value to it.
 *
 * ## Identity is P0-01's, verbatim
 *
 * Every destination enters through `parseExecutionDestination` and is keyed by
 * `executionDestinationKey`. Nothing here trims, folds, normalizes or
 * re-spells: `network-a:abc` and `network-a:ABC` are two registrations, and so
 * are `network-a:abc` and `network-b:abc`.
 *
 * ## Namespaces are not policed here
 *
 * Any namespace P0-01 accepts can be recorded. Which namespaces a deployment
 * serves is trusted configuration's fact (P0-04), not the registry's.
 *
 * ## The read is synchronous
 *
 * Like `EmergencyControlReaderPort`, so a later trusted-context resolver or a
 * commit-boundary recheck can consult membership without an `await` between
 * the read and the decision. The durable implementation (`better-sqlite3`)
 * answers synchronously.
 */

/** The longest `registeredBy` reference — the same 256-character bound as the canonical destination key. */
export const DESTINATION_REGISTRANT_REFERENCE_MAX_LENGTH = 256;

/** Printable ASCII, `!` through `~`: no whitespace, no control character, nothing outside ASCII. */
const PRINTABLE_ASCII = /^[\x21-\x7e]+$/;

/** `YYYY-MM-DDTHH:MM:SS.sssZ` — the form `Date.prototype.toISOString` produces. */
const CANONICAL_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** The two fields a registration request states. Any other field is refused, never stripped. */
const REGISTER_INPUT_KEYS: readonly string[] = ['destination', 'registeredBy'];

/**
 * One durable registry record.
 *
 * `destination` and `destinationKey` are the identity; `registeredBy` and
 * `registeredAt` are the provenance of the *registration operation*. There is
 * deliberately no other field.
 */
export interface DestinationRegistration {
  readonly destination: ExecutionDestination;
  /** `executionDestinationKey(destination)`, stored so a reader can see the key the record is held under. */
  readonly destinationKey: string;
  /**
   * Descriptive provenance: an opaque reference to the operator, service or
   * process that recorded the destination. Not a credential, not a signature,
   * and not proof of any authority — and never "approved by".
   */
  readonly registeredBy: string;
  /** When the registry committed the record, from the store's injected clock. */
  readonly registeredAt: string;
}

/** What a caller asks the registry to record. */
export interface RegisterDestinationInput {
  readonly destination: ExecutionDestination;
  readonly registeredBy: string;
}

/**
 * The outcome of `register`.
 *
 * `existing` means this exact destination was already recorded; the returned
 * record is the **original** one, with its original provenance. A retry never
 * rewrites who registered it or when.
 */
export type DestinationRegisterResult =
  | { readonly outcome: 'registered'; readonly registration: DestinationRegistration }
  | { readonly outcome: 'existing'; readonly registration: DestinationRegistration };

/**
 * The outcome of `lookup`: registry membership, stated explicitly.
 *
 * `unknown` is the absence of a record — not "denied", not "blocked". What an
 * unknown destination means for an action is a governance decision made
 * elsewhere.
 */
export type DestinationLookup =
  | { readonly membership: 'unknown'; readonly destinationKey: string }
  | { readonly membership: 'known'; readonly registration: DestinationRegistration };

/**
 * The **read capability, and nothing else**. Components that only need to
 * know whether a destination is known are typed against this, so they cannot
 * reach `register`.
 */
export interface DestinationRegistryReaderPort {
  /** Throws `DestinationRegistryError` on a malformed destination or an unreadable store; never answers `unknown` for either. */
  lookup(destination: ExecutionDestination): DestinationLookup;
}

/**
 * The registry: membership reads plus idempotent registration. No update,
 * rename, delete, approve, revoke or expire — a destination's identity is
 * immutable, and removing a record would not be a revocation of anything.
 */
export interface DestinationRegistryPort extends DestinationRegistryReaderPort {
  register(input: RegisterDestinationInput): DestinationRegisterResult;
}

export type DestinationRegistryErrorCode =
  /** The destination, the provenance reference or the request shape is outside the contract. Nothing was read or written. */
  | 'DESTINATION_REGISTRY_INPUT_INVALID'
  /** The store cannot be opened, has been closed, its clock answered a non-canonical instant, or its schema version is not implemented. */
  | 'DESTINATION_REGISTRY_UNAVAILABLE'
  /** A persisted record failed validation. Refused, never repaired, never read as `unknown`. */
  | 'DESTINATION_REGISTRY_CORRUPT';

/** Messages name the condition only: no SQL, no file path, no driver text. */
export class DestinationRegistryError extends Error {
  constructor(
    readonly code: DestinationRegistryErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'DestinationRegistryError';
  }
}

export function isDestinationRegistryError(error: unknown): error is DestinationRegistryError {
  return error instanceof DestinationRegistryError;
}

export function isDestinationRegistrantReference(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= DESTINATION_REGISTRANT_REFERENCE_MAX_LENGTH && PRINTABLE_ASCII.test(value);
}

/** Whether `value` is a canonical UTC instant that round-trips through `toISOString` exactly. */
export function isCanonicalRegistrationInstant(value: unknown): value is string {
  if (typeof value !== 'string' || !CANONICAL_INSTANT.test(value)) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function invalid(message: string): DestinationRegistryError {
  return new DestinationRegistryError('DESTINATION_REGISTRY_INPUT_INVALID', message);
}

function isPlainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

/**
 * A destination handed to the registry, through P0-01's single ingress. The
 * result is a new frozen copy: a caller mutating its own object afterwards
 * reaches nothing the registry holds.
 */
export function requireRegistryDestination(destination: unknown): ExecutionDestination {
  const parsed = parseExecutionDestination(destination);
  if (!parsed.valid) throw invalid(`The destination is not a well-formed execution destination (${parsed.violation}).`);
  return parsed.destination;
}

/**
 * A registration request, checked whole: exactly `destination` and
 * `registeredBy`, as data properties. A request stating `approved`,
 * `trusted`, `status` or anything else is refused, so no field a caller adds
 * can be mistaken for registry state.
 */
export function requireRegisterDestinationInput(input: unknown): RegisterDestinationInput {
  if (!isPlainRecord(input)) throw invalid('A registration request must be a plain object.');
  const keys = Reflect.ownKeys(input);
  if (!keys.every((key) => typeof key === 'string' && REGISTER_INPUT_KEYS.includes(key))) {
    throw invalid('A registration request states exactly `destination` and `registeredBy`.');
  }
  const values: Record<string, unknown> = {};
  for (const key of REGISTER_INPUT_KEYS) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (descriptor !== undefined && !('value' in descriptor)) throw invalid('A registration request may not state an accessor.');
    values[key] = descriptor?.value as unknown;
  }
  const destination = requireRegistryDestination(values['destination']);
  const registeredBy = values['registeredBy'];
  if (!isDestinationRegistrantReference(registeredBy)) {
    throw invalid(`registeredBy must be 1–${String(DESTINATION_REGISTRANT_REFERENCE_MAX_LENGTH)} printable ASCII characters with no whitespace.`);
  }
  return Object.freeze({ destination, registeredBy });
}

/** Samples the injected clock and refuses an answer that is not a canonical instant. */
export function sampleRegistrationInstant(now: () => string): string {
  const instant = now();
  if (!isCanonicalRegistrationInstant(instant)) {
    throw new DestinationRegistryError('DESTINATION_REGISTRY_UNAVAILABLE', 'The registry clock did not answer a canonical instant; nothing was written.');
  }
  return instant;
}

/** A frozen record, its destination a frozen copy and its key derived from P0-01 — never accepted from a caller. */
export function buildDestinationRegistration(destination: ExecutionDestination, registeredBy: string, registeredAt: string): DestinationRegistration {
  const identity = Object.freeze({ namespace: destination.namespace, identifier: destination.identifier });
  return Object.freeze({ destination: identity, destinationKey: executionDestinationKey(identity), registeredBy, registeredAt });
}

export function unknownDestination(destinationKey: string): DestinationLookup {
  return Object.freeze({ membership: 'unknown', destinationKey });
}

export function knownDestination(registration: DestinationRegistration): DestinationLookup {
  return Object.freeze({ membership: 'known', registration });
}
