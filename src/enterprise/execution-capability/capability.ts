import { canonicalSerialize } from '../governance-store/canonical-json.js';
import { computeDigest } from '../governance-store/digest.js';

/**
 * G-02A — the **generic signed execution capability**: a closed, signed
 * statement that one deployment authorized exactly one execution of one
 * action, by one executor, inside a short validity window.
 *
 * ## What it is, and what it is not
 *
 * It is a **derived** artifact. The authority behind it is a bounded grant,
 * which stays an internal typed record held by a trusted store and is never
 * serialized for, handed to or presented by anyone (SEC-INV-012, SEC-INV-026).
 * A capability names that grant only through an opaque digest
 * (`grantReference`), so an executor learns neither its id, its scope nor the
 * decision behind it.
 *
 * It is not a governance decision, not current-validity state and not
 * execution evidence. A signature over these bytes proves that a trusted key
 * vouched for them when they were signed. It does not prove the capability is
 * unexpired, unrevoked or unconsumed: the verifier reports those as separate
 * checks, and consumption is a separate, durable step
 * (`reference/consumption-ledger.ts`).
 *
 * ## Industry-neutral by construction
 *
 * Nothing here knows a domain. What is executed is bound through
 * `actionBinding`: a binding **format** id the executor's adapter defines, and
 * the digest of the exact binding record. The executor recomputes that digest
 * from the request it is about to perform; it never trusts one it was handed.
 *
 * ## Canonical form
 *
 * The signed text is `aoc.canonical-json.v1` (`canonicalSerialize`) of the
 * closed record: lexicographic keys, no whitespace, strings only — there is no
 * numeric field, so there is no numeric spelling to disagree about. A
 * presented text is parsed and must re-serialize to **exactly** itself; a
 * reordered, re-spaced, re-escaped or duplicated-key text is refused, never
 * normalized. Unicode is compared code unit for code unit: there is no
 * normalization, and an unpaired surrogate is refused anywhere.
 *
 * The signing bytes carry the CORE-02 domain prefix
 * `EXECUTION_CAPABILITY_SIGNING_DOMAIN` (registered as
 * `AUTHORITY_SIGNING_DOMAINS.executionCapability`), so no other authority
 * artifact's signature verifies as a capability's, and a capability's verifies
 * as nothing else.
 */

export const EXECUTION_CAPABILITY_FORMAT = 'frontera.execution-capability.v1';

/**
 * The CORE-02 signing domain of an execution capability. Declared here so this
 * module imports no other authority artifact; `AUTHORITY_SIGNING_DOMAINS`
 * registers it beside every other domain, where uniqueness is tested.
 */
export const EXECUTION_CAPABILITY_SIGNING_DOMAIN = 'frontera:authority-artifact:execution-capability:v1\n';

/** v1 has one consumption mode. A capability is consumed once, by its audience, before any side effect. */
export const EXECUTION_CAPABILITY_CONSUMPTION_MODES = Object.freeze(['single-use'] as const);
export type ExecutionCapabilityConsumptionMode = (typeof EXECUTION_CAPABILITY_CONSUMPTION_MODES)[number];

/**
 * What freshness evidence the issuer requires before the capability may be
 * consumed. `offline-permitted`: the signature, the window and the executor's
 * own ledger suffice, and revocation after issuance is bounded only by the
 * window. `online-status-required`: an authoritative status answer is required;
 * no status mechanism exists before G-02D, so such a capability is never
 * consumable until one does.
 */
export const EXECUTION_CAPABILITY_STATUS_REQUIREMENTS = Object.freeze(['offline-permitted', 'online-status-required'] as const);
export type ExecutionCapabilityStatusRequirement = (typeof EXECUTION_CAPABILITY_STATUS_REQUIREMENTS)[number];

export const EXECUTION_CAPABILITY_LIMITS = Object.freeze({
  /** The intended issuance lifetime (G-02B issues with this unless configured shorter). */
  defaultLifetimeMs: 30_000,
  /** No capability is valid for longer than this from its issuance instant. A verifier may be configured shorter, never longer. */
  maximumLifetimeMs: 60_000,
  /** How far `issuedAt` may sit ahead of the verifier's clock. Expiry is never extended by skew. */
  maximumClockSkewMs: 5_000,
  identifierMaximumLength: 512,
  canonicalMaximumLength: 16_384,
  /** How deep an action-binding record may nest. */
  bindingMaximumDepth: 32,
});

/** The digest domain of an action-binding record. Inside the digested value, so a binding digest cannot be confused with any other `aoc.canonical-json.v1` digest. */
export const EXECUTION_CAPABILITY_ACTION_BINDING_DOMAIN = 'frontera.execution-capability.action-binding.v1';
/** The digest domain of the opaque internal-grant reference. */
export const EXECUTION_CAPABILITY_GRANT_REFERENCE_DOMAIN = 'frontera.execution-capability.grant-reference.v1';

export interface ExecutionCapabilityActionBinding {
  /** The adapter-defined binding format, e.g. `frontera.http-request-binding.v1`. */
  readonly format: string;
  /** `sha256:` over the binding record (`executionCapabilityActionBindingDigest`). */
  readonly digest: string;
}

export interface ExecutionCapability {
  readonly format: typeof EXECUTION_CAPABILITY_FORMAT;
  /** 32 random bytes, lowercase hex: the single-use identity an executor consumes. */
  readonly capabilityId: string;
  /** The issuing deployment's identity. A key id is not an issuer identity: both are bound. */
  readonly issuer: string;
  /** The key id the issuer signs as. Must equal the signature envelope's `keyId`, and be pinned for `issuer`. */
  readonly issuerKeyId: string;
  readonly organizationId: string;
  readonly trustDomain: string;
  /** Exactly one intended executor. Compared by exact equality; never a pattern. */
  readonly audience: string;
  /** The actor the action is performed as. */
  readonly subjectActorId: string;
  /** When the subject acts for another actor (a delegated actor), that actor; otherwise `null`. Never the subject itself. */
  readonly onBehalfOfActorId: string | null;
  readonly action: string;
  readonly resource: string;
  readonly actionBinding: ExecutionCapabilityActionBinding;
  /** The issuer's opaque execution identity: one capability per execution. */
  readonly executionId: string;
  /** `sha256:` committing to the internal grant (`executionCapabilityGrantReference`). Opaque to the executor; recomputable only by the issuer. */
  readonly grantReference: string;
  readonly consumption: ExecutionCapabilityConsumptionMode;
  readonly statusRequirement: ExecutionCapabilityStatusRequirement;
  /** ISO-8601 UTC with milliseconds. */
  readonly issuedAt: string;
  readonly expiresAt: string;
}

/** Every field, in canonical (lexicographic) order. Closed: no field is optional and no other field is accepted. */
export const EXECUTION_CAPABILITY_FIELDS = Object.freeze([
  'action',
  'actionBinding',
  'audience',
  'capabilityId',
  'consumption',
  'executionId',
  'expiresAt',
  'format',
  'grantReference',
  'issuedAt',
  'issuer',
  'issuerKeyId',
  'onBehalfOfActorId',
  'organizationId',
  'resource',
  'statusRequirement',
  'subjectActorId',
  'trustDomain',
] as const satisfies readonly (keyof ExecutionCapability)[]);

const BINDING_FIELDS = Object.freeze(['digest', 'format'] as const satisfies readonly (keyof ExecutionCapabilityActionBinding)[]);

const CAPABILITY_ID = /^[0-9a-f]{64}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
/** The SEC-INV-356 rule (`governed-action/identifiers.ts`), restated so this module imports nothing from the orchestration layer; a test pins the two equal. */
const UNPAIRED_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

export function hasUnpairedSurrogateCodeUnit(value: string): boolean {
  return UNPAIRED_SURROGATE.test(value);
}

/** A non-empty, bounded, untrimmed-free identifier with no control character and no unpaired surrogate. Compared exactly, never normalized. */
export function isExecutionCapabilityIdentifier(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= EXECUTION_CAPABILITY_LIMITS.identifierMaximumLength &&
    value.trim() === value &&
    !CONTROL.test(value) &&
    !UNPAIRED_SURROGATE.test(value)
  );
}

/** An audience names exactly one executor: an identifier that cannot be read as a pattern. */
function isAudience(value: unknown): value is string {
  return isExecutionCapabilityIdentifier(value) && !value.includes('*');
}

function isInstant(value: unknown): value is string {
  return typeof value === 'string' && INSTANT.test(value) && new Date(Date.parse(value)).toISOString() === value;
}

/** Exactly these own, enumerable data properties on a plain object — no accessor, no symbol, no inherited or extra key. */
function hasExactDataFields(value: unknown, fields: readonly string[]): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) return false;
  const keys = Reflect.ownKeys(value);
  if (keys.length !== fields.length || !keys.every((key) => typeof key === 'string' && fields.includes(key))) return false;
  return fields.every((field) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    return descriptor !== undefined && 'value' in descriptor && descriptor.enumerable === true;
  });
}

function isWellFormedActionBinding(value: unknown): value is ExecutionCapabilityActionBinding {
  return hasExactDataFields(value, BINDING_FIELDS) && isExecutionCapabilityIdentifier(value['format']) && typeof value['digest'] === 'string' && DIGEST.test(value['digest']);
}

/** Whether every field has its closed shape. Structural only: it says nothing about who signed it, when it is valid or for whom. */
export function isWellFormedExecutionCapability(value: unknown): value is ExecutionCapability {
  if (!hasExactDataFields(value, EXECUTION_CAPABILITY_FIELDS)) return false;
  const c = value;
  const onBehalfOf = c['onBehalfOfActorId'];
  return (
    c['format'] === EXECUTION_CAPABILITY_FORMAT &&
    typeof c['capabilityId'] === 'string' &&
    CAPABILITY_ID.test(c['capabilityId']) &&
    isExecutionCapabilityIdentifier(c['issuer']) &&
    isExecutionCapabilityIdentifier(c['issuerKeyId']) &&
    isExecutionCapabilityIdentifier(c['organizationId']) &&
    isExecutionCapabilityIdentifier(c['trustDomain']) &&
    isAudience(c['audience']) &&
    isExecutionCapabilityIdentifier(c['subjectActorId']) &&
    (onBehalfOf === null || (isExecutionCapabilityIdentifier(onBehalfOf) && onBehalfOf !== c['subjectActorId'])) &&
    isExecutionCapabilityIdentifier(c['action']) &&
    isExecutionCapabilityIdentifier(c['resource']) &&
    isWellFormedActionBinding(c['actionBinding']) &&
    isExecutionCapabilityIdentifier(c['executionId']) &&
    typeof c['grantReference'] === 'string' &&
    DIGEST.test(c['grantReference']) &&
    (EXECUTION_CAPABILITY_CONSUMPTION_MODES as readonly unknown[]).includes(c['consumption']) &&
    (EXECUTION_CAPABILITY_STATUS_REQUIREMENTS as readonly unknown[]).includes(c['statusRequirement']) &&
    isInstant(c['issuedAt']) &&
    isInstant(c['expiresAt'])
  );
}

/** A frozen copy holding exactly the closed fields, read once each. */
function snapshot(capability: ExecutionCapability): ExecutionCapability {
  const binding = capability.actionBinding;
  return Object.freeze({
    ...Object.fromEntries(EXECUTION_CAPABILITY_FIELDS.map((field) => [field, capability[field]])),
    actionBinding: Object.freeze({ digest: binding.digest, format: binding.format }),
  }) as unknown as ExecutionCapability;
}

/** The exact text a capability is signed over (after the domain prefix): `aoc.canonical-json.v1` of the closed record. Refuses a capability that is not well formed. */
export function serializeExecutionCapability(capability: ExecutionCapability): string {
  if (!isWellFormedExecutionCapability(capability)) throw new TypeError('An execution capability that is not well formed has no canonical form.');
  return canonicalSerialize(snapshot(capability));
}

/** The exact bytes a capability's signature is computed and verified over: the CORE-02 domain prefix, then the canonical text. One function for both sides. */
export function executionCapabilitySigningBytes(capability: ExecutionCapability): Buffer {
  return Buffer.from(`${EXECUTION_CAPABILITY_SIGNING_DOMAIN}${serializeExecutionCapability(capability)}`, 'utf8');
}

export type ExecutionCapabilityParseFailure = 'CAPABILITY_MALFORMED' | 'CAPABILITY_FORMAT_UNSUPPORTED' | 'CAPABILITY_NONCANONICAL';

/**
 * Parses a capability from its **canonical** text. The text must be exactly
 * what `serializeExecutionCapability` produces for the record it parses to:
 * anything else — another key order, whitespace, an escape where a character
 * would do, a duplicated key, an unknown or missing field — is refused, never
 * normalized, so the bytes a verifier checks are the bytes that were signed.
 */
export function parseExecutionCapability(canonical: unknown): { readonly ok: true; readonly capability: ExecutionCapability } | { readonly ok: false; readonly failure: ExecutionCapabilityParseFailure } {
  const refuse = (failure: ExecutionCapabilityParseFailure) => ({ ok: false as const, failure });
  if (typeof canonical !== 'string' || canonical.length === 0 || canonical.length > EXECUTION_CAPABILITY_LIMITS.canonicalMaximumLength) return refuse('CAPABILITY_MALFORMED');
  // A raw unpaired surrogate is malformed Unicode; JSON.parse would accept it inside a string.
  if (UNPAIRED_SURROGATE.test(canonical)) return refuse('CAPABILITY_MALFORMED');
  let parsed: unknown;
  try {
    parsed = JSON.parse(canonical);
  } catch {
    return refuse('CAPABILITY_MALFORMED');
  }
  if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const format = (parsed as Record<string, unknown>)['format'];
    if (typeof format === 'string' && format !== EXECUTION_CAPABILITY_FORMAT) return refuse('CAPABILITY_FORMAT_UNSUPPORTED');
  }
  if (!isWellFormedExecutionCapability(parsed)) return refuse('CAPABILITY_MALFORMED');
  const capability = snapshot(parsed);
  return canonicalSerialize(capability) === canonical ? { ok: true, capability } : refuse('CAPABILITY_NONCANONICAL');
}

// ── The action binding ──────────────────────────────────────────────────────

export class ExecutionCapabilityBindingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExecutionCapabilityBindingError';
  }
}

/**
 * A frozen deep copy of `value` if it is plain JSON data, or a refusal: plain
 * objects with own enumerable data properties only, dense arrays, finite
 * numbers, booleans, `null`, and strings without an unpaired surrogate (keys
 * included). `undefined` is refused rather than dropped, so `{ a: undefined }`
 * and `{}` cannot share a digest; an accessor is refused rather than read, so
 * what is digested is what was inspected.
 */
function plainJsonData(value: unknown, depth: number): unknown {
  if (depth > EXECUTION_CAPABILITY_LIMITS.bindingMaximumDepth) throw new ExecutionCapabilityBindingError('The action binding nests too deeply.');
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (UNPAIRED_SURROGATE.test(value)) throw new ExecutionCapabilityBindingError('The action binding holds malformed Unicode.');
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new ExecutionCapabilityBindingError('The action binding holds a non-finite number.');
    return value;
  }
  if (typeof value !== 'object') throw new ExecutionCapabilityBindingError('The action binding holds a value that is not JSON data.');
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) throw new ExecutionCapabilityBindingError('The action binding holds a non-plain array.');
    const items: unknown[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, index);
      if (descriptor === undefined || !('value' in descriptor)) throw new ExecutionCapabilityBindingError('The action binding holds a sparse array or an accessor.');
      items.push(plainJsonData(descriptor.value, depth + 1));
    }
    return Object.freeze(items);
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) throw new ExecutionCapabilityBindingError('The action binding holds a non-plain object.');
  const out: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') throw new ExecutionCapabilityBindingError('The action binding holds a symbol key.');
    if (UNPAIRED_SURROGATE.test(key)) throw new ExecutionCapabilityBindingError('The action binding holds malformed Unicode.');
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !('value' in descriptor) || descriptor.enumerable !== true) throw new ExecutionCapabilityBindingError('The action binding holds an accessor or a hidden property.');
    if (descriptor.value === undefined) throw new ExecutionCapabilityBindingError('The action binding holds an undefined value.');
    out[key] = plainJsonData(descriptor.value, depth + 1);
  }
  return Object.freeze(out);
}

/**
 * `sha256:` over `aoc.canonical-json.v1` of `{ domain, format, value }` for an
 * action-binding record. Numbers digest by value (`1` and `1.0` are one
 * number; `-0` is `0`); strings and keys digest code unit for code unit, with
 * no Unicode normalization. Throws `ExecutionCapabilityBindingError` for
 * anything that is not plain JSON data.
 */
export function executionCapabilityActionBindingDigest(binding: { readonly format: string; readonly value: unknown }): string {
  const format = binding.format;
  const value = binding.value;
  if (!isExecutionCapabilityIdentifier(format)) throw new ExecutionCapabilityBindingError('The action binding format is not a well-formed identifier.');
  return computeDigest({ domain: EXECUTION_CAPABILITY_ACTION_BINDING_DOMAIN, format, value: plainJsonData(value, 0) });
}

/**
 * The opaque reference a capability carries for its internal grant: `sha256:`
 * over the grant's store, id and digest under its own domain. The issuer can
 * recompute it from the grant it holds, for evidence linking; an executor
 * learns nothing about the grant from it.
 */
export function executionCapabilityGrantReference(grant: { readonly grantStoreId: string; readonly boundedGrantId: string; readonly grantDigest: string }): string {
  const { grantStoreId, boundedGrantId, grantDigest } = grant;
  if (!isExecutionCapabilityIdentifier(grantStoreId) || !isExecutionCapabilityIdentifier(boundedGrantId) || typeof grantDigest !== 'string' || !DIGEST.test(grantDigest)) {
    throw new TypeError('A grant reference needs a grant store id, a grant id and a sha256 grant digest.');
  }
  return computeDigest({ domain: EXECUTION_CAPABILITY_GRANT_REFERENCE_DOMAIN, grantStoreId, boundedGrantId, grantDigest });
}
