import type { AuthoritySignatureFailure } from '../authority-authenticity/errors.js';
import { createAuthoritySignatureRegistry, type AuthoritySignatureRegistry, type TrustedVerificationKey } from '../authority-authenticity/signature-verification.js';
import {
  EXECUTION_CAPABILITY_LIMITS,
  ExecutionCapabilityBindingError,
  executionCapabilityActionBindingDigest,
  executionCapabilitySigningBytes,
  isExecutionCapabilityIdentifier,
  parseExecutionCapability,
  type ExecutionCapability,
  type ExecutionCapabilityStatusRequirement,
} from './capability.js';

/**
 * G-02A — the **standalone verifier** an executor runs before it acts.
 *
 * It needs only what an independent executor holds: the presented capability,
 * the issuer keys it pinned out of band, its own context (audience,
 * organizations, trust domain), the action and binding it is about to perform,
 * and a clock. It imports no Host composition, Kernel, orchestration, store
 * implementation or I/O: the CORE-02 key registry and verification routine
 * (`signature-verification.ts`, one registry per pinned issuer, built from that
 * issuer's keys only), the capability codec and
 * `aoc.canonical-json.v1` — pinned by a structural test over its import
 * closure.
 *
 * ## Four questions, four answers — never one boolean
 *
 * 1. **Verification** (this function): is this the canonical capability a
 *    pinned issuer key signed, for *this* executor, organization and trust
 *    domain, inside its window, for exactly *this* action and binding?
 * 2. **Freshness** (`freshness`): what is known about revocation and emergency
 *    stops *since issuance*. Offline: nothing — reported as `not-observed`,
 *    with the window as the only bound. A capability that requires an online
 *    status answer reports `status: 'unavailable'` (no status mechanism exists
 *    before G-02D) and is not consumable.
 * 3. **Consumption** (`consumption`, then the ledger's `claim`): whether this
 *    result may be presented for durable single use. `eligible: true` is
 *    permission to *try* to claim, not permission to execute.
 * 4. **Outcome**: what the executor did. Not this module's concern.
 *
 * ## Fail closed
 *
 * Every check refuses outright with a closed failure code; none falls through
 * to a weaker one. Inputs are read once into snapshots, an accessor anywhere in
 * the presentation is refused rather than invoked, and any throw inside
 * verification is `VERIFIER_FAILURE`, never a pass.
 */

export const EXECUTION_CAPABILITY_VERIFICATION_FAILURES = Object.freeze([
  'PRESENTATION_MALFORMED',
  'CAPABILITY_MALFORMED',
  'CAPABILITY_FORMAT_UNSUPPORTED',
  'CAPABILITY_NONCANONICAL',
  'ISSUER_UNTRUSTED',
  'ISSUER_KEY_MISMATCH',
  'SIGNATURE_INVALID',
  'AUDIENCE_MISMATCH',
  'ORGANIZATION_MISMATCH',
  'TRUST_DOMAIN_MISMATCH',
  'CAPABILITY_LIFETIME_INVALID',
  'CAPABILITY_NOT_YET_VALID',
  'CAPABILITY_EXPIRED',
  'ACTION_MISMATCH',
  'RESOURCE_MISMATCH',
  'ACTION_BINDING_FORMAT_MISMATCH',
  'ACTION_BINDING_MALFORMED',
  'ACTION_BINDING_MISMATCH',
  'CLOCK_UNAVAILABLE',
  'VERIFIER_FAILURE',
] as const);
export type ExecutionCapabilityVerificationFailure = (typeof EXECUTION_CAPABILITY_VERIFICATION_FAILURES)[number];

/** The checks, in the order they run. */
export const EXECUTION_CAPABILITY_CHECKS = Object.freeze([
  'presentation',
  'canonicalForm',
  'issuer',
  'signature',
  'audience',
  'organization',
  'trustDomain',
  'validityWindow',
  'action',
  'resource',
  'actionBinding',
] as const);
export type ExecutionCapabilityCheck = (typeof EXECUTION_CAPABILITY_CHECKS)[number];
export type ExecutionCapabilityCheckResult = 'passed' | 'failed' | 'not-evaluated';
export type ExecutionCapabilityChecks = Readonly<Record<ExecutionCapabilityCheck, ExecutionCapabilityCheckResult>>;

/**
 * What is known about authorization freshness since issuance. Offline
 * verification observes neither revocation nor an emergency stop: it says so,
 * and names the window as the only bound on that exposure.
 */
export type ExecutionCapabilityFreshness =
  | {
      readonly requirement: Extract<ExecutionCapabilityStatusRequirement, 'offline-permitted'>;
      readonly status: 'not-checked';
      readonly revocation: 'not-observed';
      readonly emergencyStop: 'not-observed';
      /** Revocation or a stop committed after issuance can go unseen by this executor until this instant. */
      readonly exposureBoundedUntil: string;
    }
  | {
      readonly requirement: Extract<ExecutionCapabilityStatusRequirement, 'online-status-required'>;
      readonly status: 'unavailable';
      readonly revocation: 'not-observed';
      readonly emergencyStop: 'not-observed';
    };

export type ExecutionCapabilityConsumptionEligibility = { readonly eligible: true } | { readonly eligible: false; readonly reason: 'STATUS_REQUIRED_UNAVAILABLE' };

export type ExecutionCapabilityVerification =
  | {
      readonly verification: 'rejected';
      readonly failure: ExecutionCapabilityVerificationFailure;
      /** The CORE-02 reason, when the signature check refused. */
      readonly signatureFailure?: AuthoritySignatureFailure;
      readonly checks: ExecutionCapabilityChecks;
    }
  | {
      readonly verification: 'verified';
      readonly capability: ExecutionCapability;
      readonly checks: ExecutionCapabilityChecks;
      readonly verifiedAt: string;
      readonly freshness: ExecutionCapabilityFreshness;
      readonly consumption: ExecutionCapabilityConsumptionEligibility;
    };

/** One issuing deployment the executor trusts, and every key it pinned for it (rotation overlap: the active key and those whose capabilities may still be live). */
export interface ExecutionCapabilityTrustedIssuer {
  readonly issuer: string;
  readonly keys: readonly TrustedVerificationKey[];
}

export interface ExecutionCapabilityExecutorContext {
  /** This executor's one audience id. */
  readonly audience: string;
  /** The organizations this executor accepts capabilities for. At least one; compared exactly. */
  readonly organizationIds: readonly string[];
  readonly trustDomain: string;
}

export interface ExecutionCapabilityVerifierOptions {
  readonly trustedIssuers: readonly ExecutionCapabilityTrustedIssuer[];
  readonly executor: ExecutionCapabilityExecutorContext;
  /** Wall clock, ms since the epoch. Required: a window is never checked against no clock. */
  readonly clock: () => number;
  /** 1 … 60 000; default 60 000. A verifier may accept less than the profile maximum, never more. */
  readonly maximumLifetimeMs?: number;
  /** 0 … 5 000; default 5 000. */
  readonly maximumClockSkewMs?: number;
}

/** What the executor is about to perform — computed by the executor, never taken from the presentation. */
export interface ExecutionCapabilityVerificationRequest {
  /** `{ capability: <canonical text>, signature: <CORE-02 envelope> }`, exactly as received. */
  readonly presentation: unknown;
  readonly action: string;
  readonly resource: string;
  readonly actionBinding: { readonly format: string; readonly value: unknown };
}

export interface ExecutionCapabilityVerifier {
  verify(request: ExecutionCapabilityVerificationRequest): ExecutionCapabilityVerification;
  /** The pinned issuers, for diagnostics. Ids only. */
  readonly trustedIssuers: readonly string[];
}

export class ExecutionCapabilityVerifierConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExecutionCapabilityVerifierConfigurationError';
  }
}

/**
 * Results this runtime's verifier produced as `verified`. A shape-alike object is not one: the consumption ledger accepts
 * only these. The set is module-wide: a result from **any** verifier instance in the process qualifies, so an executor
 * composes the verifier it means to rely on — in-process code is trusted, as everywhere in an embedding.
 */
const VERIFIED = new WeakSet<object>();

/** The verified capability and its consumption eligibility, if `value` is a `verified` result this verifier produced; otherwise `undefined`. */
export function readVerifiedExecutionCapability(value: unknown): { readonly capability: ExecutionCapability; readonly consumptionEligible: boolean } | undefined {
  if (typeof value !== 'object' || value === null || !VERIFIED.has(value)) return undefined;
  const verified = value as Extract<ExecutionCapabilityVerification, { verification: 'verified' }>;
  return { capability: verified.capability, consumptionEligible: verified.consumption.eligible };
}

/** An own data property, or `undefined` for an accessor or a missing key — never invokes a getter. */
function dataProperty(record: object, key: string): { readonly value: unknown } | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  return descriptor !== undefined && 'value' in descriptor ? { value: descriptor.value } : undefined;
}

/** Exactly the named own data properties of a plain object, read once; otherwise `undefined`. */
function exactRecord(value: unknown, keys: readonly string[]): Readonly<Record<string, unknown>> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) return undefined;
  const own = Reflect.ownKeys(value);
  if (own.length !== keys.length || !own.every((key) => typeof key === 'string' && keys.includes(key))) return undefined;
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    const property = dataProperty(value, key);
    if (property === undefined) return undefined;
    out[key] = property.value;
  }
  return Object.freeze(out);
}

const SIGNATURE_FIELDS = ['algorithm', 'artifactVersion', 'keyId', 'signature'] as const;

function boundedInteger(value: number | undefined, fallback: number, minimum: number, maximum: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < minimum || resolved > maximum) throw new ExecutionCapabilityVerifierConfigurationError(`${name} must be an integer from ${minimum} to ${maximum}.`);
  return resolved;
}

export function createExecutionCapabilityVerifier(options: ExecutionCapabilityVerifierOptions): ExecutionCapabilityVerifier {
  const L = EXECUTION_CAPABILITY_LIMITS;
  const clock = options.clock;
  if (typeof clock !== 'function') throw new ExecutionCapabilityVerifierConfigurationError('The execution capability verifier needs a clock.');
  const maximumLifetimeMs = boundedInteger(options.maximumLifetimeMs, L.maximumLifetimeMs, 1, L.maximumLifetimeMs, 'maximumLifetimeMs');
  const maximumClockSkewMs = boundedInteger(options.maximumClockSkewMs, L.maximumClockSkewMs, 0, L.maximumClockSkewMs, 'maximumClockSkewMs');

  const executor = options.executor;
  const audience = executor?.audience;
  const trustDomain = executor?.trustDomain;
  if (!isExecutionCapabilityIdentifier(audience) || audience.includes('*')) throw new ExecutionCapabilityVerifierConfigurationError('The executor needs exactly one audience id; a pattern is not an audience.');
  if (!isExecutionCapabilityIdentifier(trustDomain)) throw new ExecutionCapabilityVerifierConfigurationError('The executor needs its trust domain.');
  const organizationIds = Array.isArray(executor.organizationIds) ? [...executor.organizationIds] : [];
  if (organizationIds.length === 0 || !organizationIds.every(isExecutionCapabilityIdentifier) || new Set(organizationIds).size !== organizationIds.length) {
    throw new ExecutionCapabilityVerifierConfigurationError('The executor needs at least one distinct organization id.');
  }
  const organizations = new Set(organizationIds);

  // One CORE-02 registry per pinned issuer. A key id names one key across the whole verifier, so a key id pinned for one
  // issuer can never be read as another's. (The same public material pinned under two ids for two issuers is two
  // deliberate pinnings, and each id still vouches only for its own issuer.)
  const issuers = new Map<string, AuthoritySignatureRegistry>();
  const keyOwners = new Map<string, string>();
  const trusted = Array.isArray(options.trustedIssuers) ? options.trustedIssuers : [];
  if (trusted.length === 0) throw new ExecutionCapabilityVerifierConfigurationError('The execution capability verifier needs at least one pinned issuer.');
  for (const entry of trusted) {
    const issuer = entry?.issuer;
    if (!isExecutionCapabilityIdentifier(issuer)) throw new ExecutionCapabilityVerifierConfigurationError('A pinned issuer needs an issuer id.');
    if (issuers.has(issuer)) throw new ExecutionCapabilityVerifierConfigurationError(`Issuer '${issuer}' is pinned twice; refusing to choose between its entries.`);
    // CORE-02's own registry rules apply unchanged: no empty set, no duplicate id, public SPKI only, key type matches algorithm.
    const registry = createAuthoritySignatureRegistry(Array.isArray(entry.keys) ? entry.keys : []);
    for (const keyId of registry.keyIds) {
      if (keyOwners.has(keyId)) throw new ExecutionCapabilityVerifierConfigurationError(`Key id '${keyId}' is pinned for more than one issuer.`);
      keyOwners.set(keyId, issuer);
    }
    issuers.set(issuer, registry);
  }
  const trustedIssuers = Object.freeze([...issuers.keys()]);

  function verify(request: ExecutionCapabilityVerificationRequest): ExecutionCapabilityVerification {
    const checks: Record<ExecutionCapabilityCheck, ExecutionCapabilityCheckResult> = Object.fromEntries(EXECUTION_CAPABILITY_CHECKS.map((check) => [check, 'not-evaluated'])) as Record<
      ExecutionCapabilityCheck,
      ExecutionCapabilityCheckResult
    >;
    const reject = (check: ExecutionCapabilityCheck | undefined, failure: ExecutionCapabilityVerificationFailure, signatureFailure?: AuthoritySignatureFailure): ExecutionCapabilityVerification => {
      if (check !== undefined) checks[check] = 'failed';
      return Object.freeze({ verification: 'rejected' as const, failure, ...(signatureFailure !== undefined ? { signatureFailure } : {}), checks: Object.freeze({ ...checks }) });
    };
    const pass = (check: ExecutionCapabilityCheck): void => {
      checks[check] = 'passed';
    };

    try {
      // ── Inputs, read once ──
      const input = exactRecord(request, ['actionBinding', 'action', 'presentation', 'resource']);
      if (input === undefined) return reject('presentation', 'PRESENTATION_MALFORMED');
      const presentation = exactRecord(input['presentation'], ['capability', 'signature']);
      const signature = presentation === undefined ? undefined : exactRecord(presentation['signature'], SIGNATURE_FIELDS);
      if (presentation === undefined || typeof presentation['capability'] !== 'string' || signature === undefined) return reject('presentation', 'PRESENTATION_MALFORMED');
      const binding = exactRecord(input['actionBinding'], ['format', 'value']);
      const action = input['action'];
      const resource = input['resource'];
      if (binding === undefined || !isExecutionCapabilityIdentifier(action) || !isExecutionCapabilityIdentifier(resource)) return reject('presentation', 'PRESENTATION_MALFORMED');
      pass('presentation');

      // ── Canonical form ──
      const parsed = parseExecutionCapability(presentation['capability']);
      if (!parsed.ok) return reject('canonicalForm', parsed.failure);
      const capability = parsed.capability;
      pass('canonicalForm');

      // ── Issuer and key: the key must be pinned for the issuer the capability names, and be the key it names ──
      const registry = issuers.get(capability.issuer);
      if (registry === undefined) return reject('issuer', 'ISSUER_UNTRUSTED');
      if (signature['keyId'] !== capability.issuerKeyId || keyOwners.get(capability.issuerKeyId) !== capability.issuer) return reject('issuer', 'ISSUER_KEY_MISMATCH');
      pass('issuer');

      // ── Signature (CORE-02, over the domain-separated canonical bytes) ──
      const verdict = registry.verify(executionCapabilitySigningBytes(capability), signature);
      if (!verdict.verified) return reject('signature', 'SIGNATURE_INVALID', verdict.failure);
      pass('signature');

      // ── Context: this executor, its organizations, its trust domain ──
      if (capability.audience !== audience) return reject('audience', 'AUDIENCE_MISMATCH');
      pass('audience');
      if (!organizations.has(capability.organizationId)) return reject('organization', 'ORGANIZATION_MISMATCH');
      pass('organization');
      if (capability.trustDomain !== trustDomain) return reject('trustDomain', 'TRUST_DOMAIN_MISMATCH');
      pass('trustDomain');

      // ── Window ──
      const now = clock();
      if (!Number.isSafeInteger(now)) return reject('validityWindow', 'CLOCK_UNAVAILABLE');
      const issuedAt = Date.parse(capability.issuedAt);
      const expiresAt = Date.parse(capability.expiresAt);
      if (!(expiresAt > issuedAt) || expiresAt - issuedAt > maximumLifetimeMs) return reject('validityWindow', 'CAPABILITY_LIFETIME_INVALID');
      if (issuedAt > now + maximumClockSkewMs) return reject('validityWindow', 'CAPABILITY_NOT_YET_VALID');
      if (!(now < expiresAt)) return reject('validityWindow', 'CAPABILITY_EXPIRED');
      pass('validityWindow');

      // ── What is about to be executed ──
      if (capability.action !== action) return reject('action', 'ACTION_MISMATCH');
      pass('action');
      if (capability.resource !== resource) return reject('resource', 'RESOURCE_MISMATCH');
      pass('resource');
      if (binding['format'] !== capability.actionBinding.format) return reject('actionBinding', 'ACTION_BINDING_FORMAT_MISMATCH');
      let digest: string;
      try {
        digest = executionCapabilityActionBindingDigest({ format: capability.actionBinding.format, value: binding['value'] });
      } catch (error) {
        if (error instanceof ExecutionCapabilityBindingError) return reject('actionBinding', 'ACTION_BINDING_MALFORMED');
        throw error;
      }
      if (digest !== capability.actionBinding.digest) return reject('actionBinding', 'ACTION_BINDING_MISMATCH');
      pass('actionBinding');

      const freshness: ExecutionCapabilityFreshness =
        capability.statusRequirement === 'offline-permitted'
          ? Object.freeze({ requirement: 'offline-permitted', status: 'not-checked', revocation: 'not-observed', emergencyStop: 'not-observed', exposureBoundedUntil: capability.expiresAt })
          : Object.freeze({ requirement: 'online-status-required', status: 'unavailable', revocation: 'not-observed', emergencyStop: 'not-observed' });
      const consumption: ExecutionCapabilityConsumptionEligibility =
        freshness.requirement === 'offline-permitted' ? Object.freeze({ eligible: true }) : Object.freeze({ eligible: false, reason: 'STATUS_REQUIRED_UNAVAILABLE' });
      const result = Object.freeze({ verification: 'verified' as const, capability, checks: Object.freeze({ ...checks }), verifiedAt: new Date(now).toISOString(), freshness, consumption });
      VERIFIED.add(result);
      return result;
    } catch {
      return reject(undefined, 'VERIFIER_FAILURE');
    }
  }

  return Object.freeze({ verify, trustedIssuers });
}
