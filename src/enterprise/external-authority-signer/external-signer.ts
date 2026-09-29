import { createPublicKey, type KeyObject } from 'node:crypto';

import type { BoundedGrant, GrantRevocation } from '../../features/grant-runtime/index.js';
import type { ApprovalStateCommitment } from '../approval-authority/state-commitment.js';
import {
  AUTHORITY_ARTIFACT_VERSION,
  SUPPORTED_AUTHORITY_SIGNATURE_ALGORITHMS,
  decodeAuthoritySignatureBytes,
  isSupportedAuthoritySignatureAlgorithm,
  isWellFormedAuthoritySignature,
  type AuthoritySignature,
  type AuthoritySignatureAlgorithm,
} from '../authority-authenticity/authority-signature.js';
import { registerAuthoritySignerCustody } from '../authority-authenticity/custody.js';
import {
  AuthorityAuthenticityConfigurationError,
  AuthoritySigningUnavailableError,
  isRetryableAuthoritySigningFailure,
  type AuthoritySigningFailureReason,
} from '../authority-authenticity/errors.js';
import type { AuthorityArtifactSigner } from '../authority-authenticity/signer.js';
import type { AuthorityArtifactVerifier, AuthoritySignatureVerification } from '../authority-authenticity/verifier.js';
import type { RevocationStateCommitment } from '../bounded-grant-store/bounded-grant-record.js';
import type { ObligationDischargeStateCommitment } from '../obligation-discharge/state-commitment.js';
import { EXTERNAL_AUTHORITY_SIGNER_OPERATIONS, EXTERNAL_AUTHORITY_SIGNER_PROTOCOL, hasExactKeys, type ExternalAuthoritySignerOperation, type ExternalAuthoritySigningRequest } from './protocol.js';
import { ExternalAuthoritySignerTransportError, type ExternalAuthoritySignerTransport } from './transport.js';

/**
 * The external `AuthorityArtifactSigner` (CORE-02): the same five structured,
 * domain-aware operations, answered by a custody boundary outside this process.
 *
 * ## What this process holds
 *
 * No authority private key — in any form, at any point. It holds the pinned
 * **public** identity of the key the custody service must answer as, the
 * trusted **verifier** it already had, and a transport (whose service
 * credential authorizes use of the key but is not the key).
 *
 * ## Why a remote answer is never trusted on its own
 *
 * Configured trust pins remote identity; remote identity never establishes
 * trust. So:
 *
 * 1. **At startup** (`establishExternalAuthorityArtifactSigner`) the service's
 *    identity answer must match the pinned key id, algorithm and public key
 *    **exactly** — the public key compared as SPKI bytes, not by key id alone —
 *    and offer exactly the protocol, artifact version and five operations this
 *    runtime needs. Any mismatch refuses the deployment. The advertised public
 *    key is only ever *compared*; it is never added to anything.
 * 2. **On every signature**, the answer must be a well-formed envelope naming
 *    the pinned key id and algorithm, and must **verify locally** — through the
 *    deployment's own verifier, over the exact artifact that was sent, under the
 *    pinned key — before it is returned to a store. A wrong key, a signature over
 *    a different artifact or domain, a malformed or truncated signature, or an
 *    unannounced key change mid-process is refused here, before any write
 *    transaction exists. The store's own read-back verification stays as a
 *    second, independent check.
 *
 * ## Time, retries, and what an outage means
 *
 * Every call is bounded (`timeoutMs` per attempt). The startup identity
 * handshake and every signature make at most `maxAttempts` attempts, through
 * one bounded-attempt loop (`withBoundedAttempts`), with no delay between them:
 * the worst case is `timeoutMs × maxAttempts`. Only the availability family
 * (timeout, unreachable, unavailable/throttled) is retried; nothing that the
 * service *answered* is — an authentication failure, a refusal, a malformed
 * answer or an identity mismatch is one call. A runtime health probe is one
 * attempt (it reports; the next probe is the retry). A signing failure is always
 * an `AuthoritySigningUnavailableError` carrying a closed reason — the stores
 * turn that into "nothing was written", exactly as for the in-process signer.
 * There is no fallback to any other signer, and none can be configured.
 *
 * ## Health: identity reachability is not signing readiness (CORE-02R)
 *
 * The monitor keeps two states, each changed only by the event that can prove
 * it:
 *
 * - `identity` — set by the startup handshake and by non-signing probes. A probe
 *   proves the service is reachable and still answers as the pin; nothing more.
 * - `lastSigning` — set only by signing operations. A failed signature makes it
 *   `unavailable`; only a later **successful, locally verified** signature
 *   makes it `ready` again.
 *
 * The effective `state` is `ready` only when both are. So an identity endpoint
 * that answers while signing is broken (unreachable, throttled, hanging, or
 * returning signatures that do not verify) keeps health `unavailable`, and a
 * health check never has to spend a signature to stay truthful.
 *
 * Probes are single-flight (concurrent callers share one identity call) and
 * rate-bounded by `probeIntervalMs`: within it, the last identity result
 * stands. That bounds how stale an identity `ready` can be; it never delays a
 * signing failure, which is recorded the moment it happens. The bound holds
 * against a wall clock that moves backwards: a negative age invalidates the
 * cached result and the next probe asks the service (CORE-02R round 2).
 *
 * A timed-out call may have been signed remotely. That signature was never
 * persisted, so it confers nothing: authority is committed, verified state —
 * not "a signature was generated somewhere". A retry asks again; the stores'
 * own idempotency (deterministic grant ids, planned revocation sequences,
 * verified-base chain appends) is what guarantees one state transition.
 */

export interface PinnedAuthoritySignerIdentity {
  readonly keyId: string;
  readonly algorithm: AuthoritySignatureAlgorithm;
  /** SPKI PEM of the key this deployment trusts under `keyId` — taken from its own verification registry, never from the service. */
  readonly publicKeyPem: string;
}

export interface ExternalAuthorityArtifactSignerOptions {
  readonly transport: ExternalAuthoritySignerTransport;
  readonly pinned: PinnedAuthoritySignerIdentity;
  /** The deployment's trusted verifier — the same one its stores read with. Every returned signature must verify through it, under the pinned key. */
  readonly verifier: AuthorityArtifactVerifier;
  /** Per-attempt budget. 1 … 60 000 ms. */
  readonly timeoutMs: number;
  /** 1 … 3, for the startup identity handshake and for every signature. Only availability failures are retried. */
  readonly maxAttempts: number;
  /**
   * 0 … 60 000 ms: the minimum age of an identity result before a health probe
   * asks the service again. 0 (the default) probes on every call; concurrent
   * probes share one call either way.
   */
  readonly probeIntervalMs?: number;
  /** Milliseconds. Defaults to `Date.now`, which may move backwards: an identity result that appears to be from the future is treated as stale and re-probed. For tests. */
  readonly now?: () => number;
}

export const MAXIMUM_EXTERNAL_SIGNER_TIMEOUT_MS = 60_000;
export const MAXIMUM_EXTERNAL_SIGNER_ATTEMPTS = 3;
export const MAXIMUM_EXTERNAL_SIGNER_PROBE_INTERVAL_MS = 60_000;

/** Low-cardinality counters: per operation, never per artifact, subject or key. Nothing here is secret. */
export interface ExternalAuthoritySignerOperationCounters {
  readonly calls: number;
  readonly attempts: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly retried: number;
  readonly lastLatencyMs: number | undefined;
}

/** One half of the signer's health: `ready`, or `unavailable` with the closed reason of the failure that has not yet been disproven. */
export interface ExternalAuthoritySignerComponentState {
  readonly state: 'ready' | 'unavailable';
  readonly reason?: AuthoritySigningFailureReason;
}

export interface ExternalAuthoritySignerStatus {
  readonly custody: 'external';
  readonly keyId: string;
  readonly algorithm: AuthoritySignatureAlgorithm;
  /**
   * `ready` only when `identity` is ready **and** no signing failure is
   * unresolved; `unavailable` otherwise. Signing availability only — never
   * verification: existing authority verifies locally either way.
   */
  readonly state: 'ready' | 'unavailable';
  /** When `unavailable`: the unresolved signing failure if there is one (it is what stops new authority), else the identity failure. */
  readonly reason?: AuthoritySigningFailureReason;
  /** The last identity result (startup handshake or probe). Proves reachability and the pinned identity — never that signing works. */
  readonly identity: ExternalAuthoritySignerComponentState;
  /** The last signing outcome. Cleared only by a successful, locally verified signature. */
  readonly lastSigning: ExternalAuthoritySignerComponentState;
  readonly operations: Readonly<Record<ExternalAuthoritySignerOperation, ExternalAuthoritySignerOperationCounters>>;
}

export interface ExternalAuthoritySignerMonitor {
  /** The last observed state and counters. No network call. */
  status(): ExternalAuthoritySignerStatus;
  /**
   * A **non-signing** probe (identity only — never spends a metered
   * signature): reachable, and still answering as the pinned identity? One
   * attempt; single-flight; skipped while the last identity result is younger
   * than `probeIntervalMs`. Updates `identity` only — it can never clear a
   * signing failure.
   */
  probe(): Promise<ExternalAuthoritySignerStatus>;
}

export interface ExternalAuthorityArtifactSigner {
  readonly signer: AuthorityArtifactSigner;
  readonly monitor: ExternalAuthoritySignerMonitor;
}

const EXTERNAL_SIGNERS = new WeakSet<object>();

/** Whether `signer` was built by this module (runtime brand, not shape). */
export function isExternalAuthorityArtifactSigner(signer: unknown): boolean {
  return typeof signer === 'object' && signer !== null && EXTERNAL_SIGNERS.has(signer);
}

class IdentityRefusal extends Error {
  constructor(
    readonly reason: AuthoritySigningFailureReason,
    message: string,
  ) {
    super(message);
  }
}

function spkiOf(pem: string): Buffer | undefined {
  if (/-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/.test(pem)) return undefined;
  let key: KeyObject;
  try {
    key = createPublicKey(pem);
  } catch {
    return undefined;
  }
  if (key.type !== 'public') return undefined;
  return key.export({ type: 'spki', format: 'der' });
}

/**
 * Checks one identity answer against the pin. Throws `IdentityRefusal` naming
 * the rule, never echoing the answer.
 */
function checkIdentity(answer: unknown, pinned: PinnedAuthoritySignerIdentity, pinnedSpki: Buffer): void {
  if (!hasExactKeys(answer, ['protocol', 'keyId', 'algorithm', 'publicKeyPem', 'artifactVersion', 'operations'])) {
    throw new IdentityRefusal('EXTERNAL_SIGNER_MALFORMED_RESPONSE', 'The external authority signer identity is not the protocol shape (exactly protocol, keyId, algorithm, publicKeyPem, artifactVersion, operations).');
  }
  if (answer.protocol !== EXTERNAL_AUTHORITY_SIGNER_PROTOCOL) {
    throw new IdentityRefusal('EXTERNAL_SIGNER_CAPABILITY_UNSUPPORTED', `The external authority signer does not speak ${EXTERNAL_AUTHORITY_SIGNER_PROTOCOL}.`);
  }
  if (typeof answer.keyId !== 'string' || answer.keyId.length === 0) {
    throw new IdentityRefusal('EXTERNAL_SIGNER_MALFORMED_RESPONSE', 'The external authority signer identity names no key id.');
  }
  if (typeof answer.algorithm !== 'string' || answer.algorithm.length === 0) {
    throw new IdentityRefusal('EXTERNAL_SIGNER_MALFORMED_RESPONSE', 'The external authority signer identity names no algorithm.');
  }
  if (!isSupportedAuthoritySignatureAlgorithm(answer.algorithm)) {
    throw new IdentityRefusal('EXTERNAL_SIGNER_CAPABILITY_UNSUPPORTED', 'The external authority signer offers an algorithm outside this runtime\'s closed registry. There is no negotiation and no fallback.');
  }
  if (typeof answer.artifactVersion !== 'string' || answer.artifactVersion !== AUTHORITY_ARTIFACT_VERSION) {
    throw new IdentityRefusal('EXTERNAL_SIGNER_CAPABILITY_UNSUPPORTED', `The external authority signer does not sign ${AUTHORITY_ARTIFACT_VERSION} artifacts.`);
  }
  const operations = answer.operations;
  if (!Array.isArray(operations) || operations.some((operation) => typeof operation !== 'string') || new Set(operations).size !== operations.length) {
    throw new IdentityRefusal('EXTERNAL_SIGNER_MALFORMED_RESPONSE', 'The external authority signer identity lists its operations malformed or duplicated.');
  }
  const known = new Set<string>(EXTERNAL_AUTHORITY_SIGNER_OPERATIONS);
  if (operations.some((operation) => !known.has(operation as string)) || EXTERNAL_AUTHORITY_SIGNER_OPERATIONS.some((operation) => !operations.includes(operation))) {
    throw new IdentityRefusal('EXTERNAL_SIGNER_CAPABILITY_UNSUPPORTED', `The external authority signer must offer exactly the five authority operations (${EXTERNAL_AUTHORITY_SIGNER_OPERATIONS.join(', ')}).`);
  }
  if (typeof answer.publicKeyPem !== 'string') {
    throw new IdentityRefusal('EXTERNAL_SIGNER_MALFORMED_RESPONSE', 'The external authority signer identity carries no public key.');
  }
  const advertised = spkiOf(answer.publicKeyPem);
  if (advertised === undefined) {
    throw new IdentityRefusal('EXTERNAL_SIGNER_MALFORMED_RESPONSE', 'The external authority signer identity carries no parseable public key.');
  }
  // Pinned identity, compared field by field. The key id alone is never enough:
  // the same id over different material is a different key.
  if (answer.keyId !== pinned.keyId) {
    throw new IdentityRefusal('EXTERNAL_SIGNER_IDENTITY_MISMATCH', `The external authority signer answers as a key other than the pinned '${pinned.keyId}'.`);
  }
  if (answer.algorithm !== pinned.algorithm) {
    throw new IdentityRefusal('EXTERNAL_SIGNER_IDENTITY_MISMATCH', `The external authority signer answers under an algorithm other than the pinned '${pinned.algorithm}'.`);
  }
  if (!advertised.equals(pinnedSpki)) {
    throw new IdentityRefusal('EXTERNAL_SIGNER_IDENTITY_MISMATCH', `The external authority signer's public key for '${pinned.keyId}' is not the key this deployment trusts under that id.`);
  }
}

/** The closed reason a transport failure carries; anything else a transport throws is treated as unreachable. */
function transportReason(error: unknown): AuthoritySigningFailureReason {
  return error instanceof ExternalAuthoritySignerTransportError ? error.reason : 'EXTERNAL_SIGNER_UNREACHABLE';
}

type Attempted<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: AuthoritySigningFailureReason };

/**
 * The one bounded-attempt loop, shared by the startup identity handshake and
 * every signature. It retries only a transport failure in the availability
 * family (`isRetryableAuthoritySigningFailure`), at most `maxAttempts` calls in
 * all, with no delay. It knows nothing about what an answer means: validating
 * an identity or a signature happens after it returns, and a refused answer is
 * never retried.
 */
async function withBoundedAttempts<T>(maxAttempts: number, call: (attempt: number) => Promise<T>): Promise<Attempted<T>> {
  let reason: AuthoritySigningFailureReason = 'EXTERNAL_SIGNER_UNREACHABLE';
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return { ok: true, value: await call(attempt) };
    } catch (error) {
      reason = transportReason(error);
      if (!isRetryableAuthoritySigningFailure(reason)) break;
    }
  }
  return { ok: false, reason };
}

function validatedOptions(options: ExternalAuthorityArtifactSignerOptions): { readonly pinnedSpki: Buffer } {
  const { pinned, timeoutMs, maxAttempts } = options;
  if (typeof pinned?.keyId !== 'string' || pinned.keyId.length === 0) throw new AuthorityAuthenticityConfigurationError('The external authority signer has no pinned key id.');
  if (!isSupportedAuthoritySignatureAlgorithm(pinned.algorithm)) throw new AuthorityAuthenticityConfigurationError(`The pinned external authority signer key '${pinned.keyId}' names an algorithm outside the supported registry.`);
  const pinnedSpki = spkiOf(pinned.publicKeyPem);
  if (pinnedSpki === undefined) throw new AuthorityAuthenticityConfigurationError(`The pinned external authority signer key '${pinned.keyId}' is not a parseable public key.`);
  if (createPublicKey(pinned.publicKeyPem).asymmetricKeyType !== SUPPORTED_AUTHORITY_SIGNATURE_ALGORITHMS[pinned.algorithm].keyType) {
    throw new AuthorityAuthenticityConfigurationError(`The pinned external authority signer key '${pinned.keyId}' does not match its algorithm.`);
  }
  if (!options.verifier.trustedKeyIds.includes(pinned.keyId)) {
    throw new AuthorityAuthenticityConfigurationError(`The pinned external authority signer key '${pinned.keyId}' is not in the trusted verification registry.`);
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAXIMUM_EXTERNAL_SIGNER_TIMEOUT_MS) {
    throw new AuthorityAuthenticityConfigurationError(`The external authority signer timeout must be an integer from 1 to ${MAXIMUM_EXTERNAL_SIGNER_TIMEOUT_MS} ms.`);
  }
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > MAXIMUM_EXTERNAL_SIGNER_ATTEMPTS) {
    throw new AuthorityAuthenticityConfigurationError(`The external authority signer attempts must be an integer from 1 to ${MAXIMUM_EXTERNAL_SIGNER_ATTEMPTS}.`);
  }
  const probeIntervalMs = options.probeIntervalMs ?? 0;
  if (!Number.isSafeInteger(probeIntervalMs) || probeIntervalMs < 0 || probeIntervalMs > MAXIMUM_EXTERNAL_SIGNER_PROBE_INTERVAL_MS) {
    throw new AuthorityAuthenticityConfigurationError(`The external authority signer probe interval must be an integer from 0 to ${MAXIMUM_EXTERNAL_SIGNER_PROBE_INTERVAL_MS} ms.`);
  }
  if (typeof options.transport?.identity !== 'function' || typeof options.transport.sign !== 'function') {
    throw new AuthorityAuthenticityConfigurationError('The external authority signer has no transport.');
  }
  return { pinnedSpki };
}

/**
 * Proves the custody service is the pinned identity, then returns the signer.
 *
 * Refuses (throws `AuthorityAuthenticityConfigurationError` with the closed
 * reason in `reason`) when the service cannot be reached within the budget —
 * `maxAttempts` identity calls of `timeoutMs` each, retried only for the
 * availability family — refuses the credential, or answers as anything but the
 * pinned identity with the full capability set (never retried). A deployment
 * that cannot prove who signs for it does not start: there is no
 * trust-on-first-use, and no "start and see".
 */
export async function establishExternalAuthorityArtifactSigner(options: ExternalAuthorityArtifactSignerOptions): Promise<ExternalAuthorityArtifactSigner> {
  const { pinnedSpki } = validatedOptions(options);
  const { transport, pinned, verifier, timeoutMs, maxAttempts } = options;
  const probeIntervalMs = options.probeIntervalMs ?? 0;
  const now = options.now ?? Date.now;

  const handshake = await withBoundedAttempts(maxAttempts, () => transport.identity({ timeoutMs }));
  if (!handshake.ok) {
    throw externalConfigurationError(
      handshake.reason,
      `The external authority signer identity could not be obtained (${handshake.reason}, ${maxAttempts} attempt${maxAttempts === 1 ? '' : 's'} at most). A deployment that cannot prove who signs for it does not start.`,
    );
  }
  try {
    checkIdentity(handshake.value, pinned, pinnedSpki);
  } catch (error) {
    if (error instanceof IdentityRefusal) throw externalConfigurationError(error.reason, `${error.message} (${error.reason})`);
    throw error;
  }

  const counters = new Map<ExternalAuthoritySignerOperation, { calls: number; attempts: number; succeeded: number; failed: number; retried: number; lastLatencyMs: number | undefined }>(
    EXTERNAL_AUTHORITY_SIGNER_OPERATIONS.map((operation) => [operation, { calls: 0, attempts: 0, succeeded: 0, failed: 0, retried: 0, lastLatencyMs: undefined }]),
  );
  // The two halves of health, each written only by the event that can prove it
  // (see the module comment). `undefined` = no unresolved failure.
  let identityFailure: AuthoritySigningFailureReason | undefined;
  let signingFailure: AuthoritySigningFailureReason | undefined;
  let identityCheckedAt = now();
  let probeInFlight: Promise<ExternalAuthoritySignerStatus> | undefined;

  const component = (failure: AuthoritySigningFailureReason | undefined): ExternalAuthoritySignerComponentState =>
    Object.freeze(failure === undefined ? { state: 'ready' as const } : { state: 'unavailable' as const, reason: failure });

  function status(): ExternalAuthoritySignerStatus {
    const operations = Object.fromEntries(EXTERNAL_AUTHORITY_SIGNER_OPERATIONS.map((operation) => [operation, Object.freeze({ ...counters.get(operation)! })])) as Record<
      ExternalAuthoritySignerOperation,
      ExternalAuthoritySignerOperationCounters
    >;
    const reason = signingFailure ?? identityFailure;
    return Object.freeze({
      custody: 'external',
      keyId: pinned.keyId,
      algorithm: pinned.algorithm,
      state: reason === undefined ? 'ready' : 'unavailable',
      ...(reason !== undefined ? { reason } : {}),
      identity: component(identityFailure),
      lastSigning: component(signingFailure),
      operations: Object.freeze(operations),
    });
  }

  /** Validates an answer to `request`. Returns a fresh envelope of exactly the four fields, or throws a refusal naming why. */
  function accept(request: ExternalAuthoritySigningRequest, answer: unknown): AuthoritySignature {
    if (!hasExactKeys(answer, ['signature'])) throw new IdentityRefusal('EXTERNAL_SIGNER_MALFORMED_RESPONSE', 'The external authority signer answer is not the protocol shape.');
    const envelope = answer.signature;
    if (!hasExactKeys(envelope, ['algorithm', 'keyId', 'signature', 'artifactVersion'])) {
      throw new IdentityRefusal('EXTERNAL_SIGNER_MALFORMED_RESPONSE', 'The external authority signer returned a signature envelope that is not exactly {algorithm, keyId, signature, artifactVersion}.');
    }
    if (typeof envelope.algorithm === 'string' && envelope.algorithm !== pinned.algorithm) {
      throw new IdentityRefusal('EXTERNAL_SIGNER_IDENTITY_MISMATCH', 'The external authority signer signed under an algorithm other than the pinned one.');
    }
    if (!isWellFormedAuthoritySignature(envelope)) throw new IdentityRefusal('EXTERNAL_SIGNER_MALFORMED_RESPONSE', 'The external authority signer returned a malformed signature envelope.');
    if (envelope.keyId !== pinned.keyId) {
      // An unannounced key change mid-process — or a still-trusted historical
      // key — is refused: rotation is configuration and restart, never an
      // answer from the other side.
      throw new IdentityRefusal('EXTERNAL_SIGNER_IDENTITY_MISMATCH', `The external authority signer signed as a key other than the pinned '${pinned.keyId}'.`);
    }
    if (envelope.artifactVersion !== AUTHORITY_ARTIFACT_VERSION) throw new IdentityRefusal('EXTERNAL_SIGNER_CAPABILITY_UNSUPPORTED', `The external authority signer signed an artifact version other than ${AUTHORITY_ARTIFACT_VERSION}.`);
    if (decodeAuthoritySignatureBytes(envelope.signature, pinned.algorithm) === undefined) {
      throw new IdentityRefusal('EXTERNAL_SIGNER_MALFORMED_RESPONSE', 'The external authority signer returned signature bytes that are not the exact encoding and width the algorithm defines.');
    }
    const signature: AuthoritySignature = Object.freeze({ algorithm: envelope.algorithm, keyId: envelope.keyId, signature: envelope.signature, artifactVersion: envelope.artifactVersion });
    // Local verification over the exact artifact that was sent, before the
    // signature can reach any store — and under the *pinned* key, not merely
    // some trusted key.
    const verification = verifyLocally(request, signature);
    if (!verification.verified || verification.keyId !== pinned.keyId) {
      throw new IdentityRefusal('EXTERNAL_SIGNER_SIGNATURE_INVALID', `The external authority signer returned a signature that does not verify over this artifact under the pinned key (${verification.verified ? 'wrong key' : verification.failure}).`);
    }
    return signature;
  }

  function verifyLocally(request: ExternalAuthoritySigningRequest, signature: AuthoritySignature): AuthoritySignatureVerification {
    switch (request.operation) {
      case 'signGrant':
        return verifier.verifyGrant(request.grant, request.storeId, signature);
      case 'signRevocation':
        return verifier.verifyRevocation(request.revocation, request.storeId, signature);
      case 'signRevocationState':
        return verifier.verifyRevocationState(request.state, signature);
      case 'signObligationDischargeState':
        return verifier.verifyObligationDischargeState(request.state, signature);
      case 'signApprovalState':
        return verifier.verifyApprovalState(request.state, signature);
    }
  }

  async function sign(request: ExternalAuthoritySigningRequest): Promise<AuthoritySignature> {
    const counter = counters.get(request.operation)!;
    counter.calls += 1;
    const answered = await withBoundedAttempts(maxAttempts, async (attempt) => {
      counter.attempts += 1;
      if (attempt > 1) counter.retried += 1;
      const started = Date.now();
      try {
        return await transport.sign(request, { timeoutMs });
      } finally {
        counter.lastLatencyMs = Date.now() - started;
      }
    });
    let reason: AuthoritySigningFailureReason;
    if (answered.ok) {
      try {
        const signature = accept(request, answered.value);
        counter.succeeded += 1;
        // Only here — a signature that verified locally under the pin — does a signing failure clear.
        signingFailure = undefined;
        return signature;
      } catch (error) {
        // The service answered; what it said is not acceptable. Never retried.
        reason = error instanceof IdentityRefusal ? error.reason : 'EXTERNAL_SIGNER_MALFORMED_RESPONSE';
      }
    } else {
      reason = answered.reason;
    }
    counter.failed += 1;
    signingFailure = reason;
    throw new AuthoritySigningUnavailableError(`The external authority signer did not produce an acceptable ${request.operation} signature (${reason}). Nothing was signed into authority state.`, reason);
  }

  const signer: AuthorityArtifactSigner = Object.freeze({
    activeKeyId: pinned.keyId,
    algorithm: pinned.algorithm,
    signGrant: (grant: BoundedGrant, storeId: string) => sign({ operation: 'signGrant', grant, storeId }),
    signRevocation: (revocation: GrantRevocation, storeId: string) => sign({ operation: 'signRevocation', revocation, storeId }),
    signRevocationState: (state: RevocationStateCommitment) => sign({ operation: 'signRevocationState', state }),
    signObligationDischargeState: (state: ObligationDischargeStateCommitment) => sign({ operation: 'signObligationDischargeState', state }),
    signApprovalState: (state: ApprovalStateCommitment) => sign({ operation: 'signApprovalState', state }),
  });
  EXTERNAL_SIGNERS.add(signer);
  registerAuthoritySignerCustody(signer, 'external');

  /** One identity attempt. Writes `identity` only: whatever it finds, it never touches a signing failure. */
  async function probeIdentity(): Promise<ExternalAuthoritySignerStatus> {
    try {
      checkIdentity(await transport.identity({ timeoutMs }), pinned, pinnedSpki);
      identityFailure = undefined;
    } catch (error) {
      identityFailure = error instanceof IdentityRefusal ? error.reason : transportReason(error);
    } finally {
      identityCheckedAt = now();
    }
    return status();
  }

  const monitor: ExternalAuthoritySignerMonitor = Object.freeze({
    status,
    probe(): Promise<ExternalAuthoritySignerStatus> {
      if (probeInFlight !== undefined) return probeInFlight;
      // A negative age means the clock moved backwards: the cached result's
      // freshness is unknown, so it is not used (CORE-02R round 2).
      const elapsed = now() - identityCheckedAt;
      if (elapsed >= 0 && elapsed < probeIntervalMs) return Promise.resolve(status());
      probeInFlight = probeIdentity().finally(() => {
        probeInFlight = undefined;
      });
      return probeInFlight;
    },
  });

  return Object.freeze({ signer, monitor });
}

function externalConfigurationError(reason: AuthoritySigningFailureReason, message: string): AuthorityAuthenticityConfigurationError {
  return new AuthorityAuthenticityConfigurationError(message, reason);
}
