import { isSemanticIdentifier, SEMANTIC_IDENTIFIER_MAX_LENGTH } from '../../governed-parameter-runtime/index.js';

/**
 * The identity of the thing a governed action intends to act upon or send
 * value to (ANDREW-P0-01).
 *
 * ## Identity is not approval, and neither is address validity
 *
 * A destination is two pieces of data and nothing else:
 *
 * ```ts
 * { namespace: 'network-a', identifier: 'abc123' }
 * ```
 *
 * `namespace` says *where* the identifier means something — which rail,
 * network or provider resolves it — and so also what kind of destination it
 * is. `identifier` is the destination's external identifier inside that
 * namespace, held exactly as stated.
 *
 * Whether a destination is known, pending, approved, revoked or expired is a
 * fact about a registry and a governance context, not about the destination.
 * There is no field for any of it here, and the single ingress
 * (`parseExecutionDestination`) refuses an input that states one — so a
 * request cannot carry `approved: true` into a destination, because a
 * destination has nowhere to keep it. Likewise there is no display label: a
 * label is something a person reads, never something an authority compares.
 *
 * Nor does a well-formed destination prove the identifier is valid on its
 * rail. This module checks structure only; address grammar, checksums and
 * normalization belong to the rail-specific code that owns the namespace.
 *
 * ## Namespace strategy
 *
 * Open, not a closed list: CORE ships no rail names, and a deployment's
 * adapters declare the namespaces they serve. A namespace is a CORE-03
 * semantic identifier (`isSemanticIdentifier`) — lowercase-led ASCII, no `:`,
 * at most 64 characters — and must be specific enough that one identifier in
 * it designates one thing: if a test network and a production network share an
 * address space, they are two namespaces.
 *
 * ## Identifier strategy
 *
 * Opaque, case-sensitive and compared exactly. Nothing is trimmed, folded or
 * re-spelled, because whether `0xAB` and `0xab` designate the same account is a
 * rule of one rail and wrong for another; a spelling that is not canonical for
 * its rail is that rail's code to refuse. Structurally an identifier is
 * printable ASCII with no whitespace, at most `DESTINATION_IDENTIFIER_MAX_LENGTH`
 * characters — wide enough for ledger addresses, account references and
 * resource URIs (`scheme://destination/123`), and narrow enough that no
 * invisible, control or look-alike character can make two spellings appear to
 * be one.
 */
export interface ExecutionDestination {
  readonly namespace: string;
  readonly identifier: string;
}

/**
 * The longest identifier a destination may state. Chosen so the canonical key
 * (`namespace` + `:` + `identifier`) never exceeds 256 characters, the bound
 * every opaque identifier the governed-action intent admits — `counterparty`
 * among them — already applies.
 */
export const DESTINATION_IDENTIFIER_MAX_LENGTH = 256 - SEMANTIC_IDENTIFIER_MAX_LENGTH - 1;

/** The longest canonical key `executionDestinationKey` can produce. */
export const DESTINATION_KEY_MAX_LENGTH = SEMANTIC_IDENTIFIER_MAX_LENGTH + 1 + DESTINATION_IDENTIFIER_MAX_LENGTH;

/** Printable ASCII, `!` through `~`: no space, no control character, nothing outside ASCII. */
const DESTINATION_IDENTIFIER = /^[\x21-\x7e]+$/;

/** The two fields a destination states, in canonical order. Any other field is refused. */
const DESTINATION_KEYS: readonly string[] = ['identifier', 'namespace'];

export const EXECUTION_DESTINATION_VIOLATIONS = {
  /** The input is not a plain object of data properties: an array, a class instance, a getter, `null`. */
  DESTINATION_NOT_A_RECORD: 'DESTINATION_NOT_A_RECORD',
  /** The input states a field other than `namespace` and `identifier` — an approval flag or a label in particular. */
  DESTINATION_FIELD_UNEXPECTED: 'DESTINATION_FIELD_UNEXPECTED',
  /** `namespace` is absent or not a semantic identifier. */
  DESTINATION_NAMESPACE_MALFORMED: 'DESTINATION_NAMESPACE_MALFORMED',
  /** `identifier` is absent, empty, too long, or contains whitespace, a control character or non-ASCII text. Refused, never trimmed. */
  DESTINATION_IDENTIFIER_MALFORMED: 'DESTINATION_IDENTIFIER_MALFORMED',
} as const;

export type ExecutionDestinationViolation = (typeof EXECUTION_DESTINATION_VIOLATIONS)[keyof typeof EXECUTION_DESTINATION_VIOLATIONS];

export type ExecutionDestinationParse =
  | { readonly valid: true; readonly destination: ExecutionDestination }
  | { readonly valid: false; readonly violation: ExecutionDestinationViolation };

export function isDestinationNamespace(value: unknown): value is string {
  return isSemanticIdentifier(value);
}

export function isDestinationIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= DESTINATION_IDENTIFIER_MAX_LENGTH && DESTINATION_IDENTIFIER.test(value);
}

function isPlainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

/**
 * The single ingress from untrusted input to an `ExecutionDestination`.
 *
 * The input must be a plain object stating exactly `namespace` and
 * `identifier` as data properties — an accessor is refused, because a getter
 * is code and could answer differently on a second read. Each field is read
 * once, checked, and copied into a new frozen object; nothing is repaired.
 */
export function parseExecutionDestination(input: unknown): ExecutionDestinationParse {
  if (!isPlainRecord(input)) return { valid: false, violation: EXECUTION_DESTINATION_VIOLATIONS.DESTINATION_NOT_A_RECORD };
  const keys = Reflect.ownKeys(input);
  if (!keys.every((key) => typeof key === 'string' && DESTINATION_KEYS.includes(key))) {
    return { valid: false, violation: EXECUTION_DESTINATION_VIOLATIONS.DESTINATION_FIELD_UNEXPECTED };
  }
  const values: Record<string, unknown> = {};
  for (const key of DESTINATION_KEYS) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (descriptor !== undefined && !('value' in descriptor)) return { valid: false, violation: EXECUTION_DESTINATION_VIOLATIONS.DESTINATION_NOT_A_RECORD };
    values[key] = descriptor?.value as unknown;
  }
  const { namespace, identifier } = values;
  if (!isDestinationNamespace(namespace)) return { valid: false, violation: EXECUTION_DESTINATION_VIOLATIONS.DESTINATION_NAMESPACE_MALFORMED };
  if (!isDestinationIdentifier(identifier)) return { valid: false, violation: EXECUTION_DESTINATION_VIOLATIONS.DESTINATION_IDENTIFIER_MALFORMED };
  return { valid: true, destination: Object.freeze({ namespace, identifier }) };
}

/**
 * Whether a value is structurally a destination: a well-formed namespace and
 * identifier. The fail-closed re-check for layers downstream of ingress that
 * receive a destination rather than parse one; it does not inspect other
 * fields, so it is never a substitute for `parseExecutionDestination` at a
 * trust boundary.
 */
export function isWellFormedExecutionDestination(value: unknown): value is ExecutionDestination {
  if (value === null || typeof value !== 'object') return false;
  const { namespace, identifier } = value as { readonly namespace?: unknown; readonly identifier?: unknown };
  return isDestinationNamespace(namespace) && isDestinationIdentifier(identifier);
}

/**
 * The one string form of a destination — `<namespace>:<identifier>` — used
 * wherever a destination has to be a single exact value: a registry key, an
 * identity bound, an equality check.
 *
 * Exactly two fields feed it, `namespace` and `identifier`, verbatim. It is
 * unambiguous by grammar: a namespace cannot contain `:`, so the first `:`
 * always ends the namespace, and two keys are equal exactly when both fields
 * are. The same identifier in two namespaces therefore yields two keys. At
 * most `DESTINATION_KEY_MAX_LENGTH` characters, printable ASCII, no
 * whitespace. Throws on a malformed destination rather than spell one.
 */
export function executionDestinationKey(destination: ExecutionDestination): string {
  if (!isWellFormedExecutionDestination(destination)) throw new TypeError('A malformed destination has no canonical key.');
  return `${destination.namespace}:${destination.identifier}`;
}

/**
 * Whether two destinations are the same destination: same namespace and same
 * identifier, compared exactly. A malformed destination is the same as
 * nothing, itself included.
 */
export function sameExecutionDestination(left: ExecutionDestination, right: ExecutionDestination): boolean {
  if (!isWellFormedExecutionDestination(left) || !isWellFormedExecutionDestination(right)) return false;
  return left.namespace === right.namespace && left.identifier === right.identifier;
}
