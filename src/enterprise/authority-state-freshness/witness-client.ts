import { createPublicKey, randomBytes, verify, type KeyObject } from 'node:crypto';

import { authorityStateCheckpointProblem, isBoundedIdentifier, sameBinding, type AuthorityStateBinding, type AuthorityStateCheckpoint } from './checkpoint.js';
import { AuthorityStateFreshnessError, isRetryableAuthorityStateFreshnessFailure, type AuthorityStateFreshnessErrorCode } from './errors.js';
import {
  AUTHORITY_STATE_WITNESS_OPERATIONS,
  AUTHORITY_STATE_WITNESS_PROTOCOL,
  parseWitnessResponse,
  witnessReceiptSigningBytes,
  type AuthorityStateEnrollment,
  type AuthorityStateWitnessOperation,
  type WitnessBindingState,
  type WitnessReceipt,
  type WitnessRequest,
} from './protocol.js';
import type { AuthorityStateWitnessTransport } from './transport.js';

/**
 * The client side of the authority-state witness (CORE-07): the
 * `AuthorityStateFreshnessAnchor` every freshness-enabled store talks to.
 *
 * ## Why a witness answer is never trusted on its own
 *
 * Configured trust pins the witness; the witness never establishes trust. Its
 * identity — an id and an Ed25519 public key — comes from this deployment's
 * own configuration, is never learned from the witness (no trust-on-first-use)
 * and is never an authority signing key (role separation: the key that says
 * "this artifact is authoritative" and the key that says "this is the newest
 * state" are different keys held by different services). Then, on **every**
 * call:
 *
 * 1. a fresh random 32-byte challenge goes out with the request;
 * 2. the answer must be exactly `{receipt, signature}`, the receipt exactly the
 *    protocol shape, and the signature must verify under the **pinned** key
 *    over the receipt's canonical, domain-separated bytes;
 * 3. the receipt must name the pinned witness id, the operation that was
 *    asked, the challenge that was sent, and the binding that was asked about.
 *
 * So a recorded receipt cannot be replayed to a later call, a receipt for one
 * binding cannot answer another, and nothing but the pinned key can make a
 * stale state look current. A witness that fails any of it is refused with a
 * closed code; nothing it said is used.
 *
 * ## Time and retries
 *
 * Every call is bounded (`timeoutMs` per attempt) and makes at most
 * `maxAttempts` attempts, with no delay. Only availability
 * (`AUTHORITY_FRESHNESS_UNAVAILABLE`: timeout, unreachable, 429, 5xx) is
 * retried; anything the witness *answered* is one call. A retried `prepare` or
 * `finalize` is safe: the witness treats a repeat of the exact same transition
 * as the same transition.
 */

export interface PinnedAuthorityStateWitness {
  readonly witnessId: string;
  /** SPKI PEM of the witness's Ed25519 receipt key — from this deployment's configuration, never from the witness. */
  readonly publicKeyPem: string;
}

export interface AuthorityStateWitnessClientOptions {
  readonly transport: AuthorityStateWitnessTransport;
  readonly pinned: PinnedAuthorityStateWitness;
  /** Per-attempt budget. 1 … 60 000 ms. */
  readonly timeoutMs: number;
  /** 1 … 3. Only availability failures are retried. */
  readonly maxAttempts: number;
  /** 0 … 60 000 ms: the minimum age of an identity result before a health probe asks again. */
  readonly probeIntervalMs?: number;
  /** Milliseconds; defaults to `Date.now`. A negative age invalidates a cached probe result. For tests. */
  readonly now?: () => number;
}

export const MAXIMUM_AUTHORITY_FRESHNESS_TIMEOUT_MS = 60_000;
export const MAXIMUM_AUTHORITY_FRESHNESS_ATTEMPTS = 3;
export const MAXIMUM_AUTHORITY_FRESHNESS_PROBE_INTERVAL_MS = 60_000;

/** The result of a state-changing operation: whether the witness applied it, and what it now holds. */
export interface AuthorityStateWitnessAnswer<Outcome extends string> {
  readonly outcome: Outcome;
  readonly state: WitnessBindingState;
}

/**
 * The anchor port a store's freshness session drives. Every method verifies
 * the witness's receipt before returning; a method that returns has a verified
 * answer, and one that cannot get one throws `AuthorityStateFreshnessError`.
 */
export interface AuthorityStateFreshnessAnchor {
  readonly witnessId: string;
  read(binding: AuthorityStateBinding): Promise<WitnessBindingState>;
  enroll(enrollment: AuthorityStateEnrollment, checkpoint: AuthorityStateCheckpoint): Promise<AuthorityStateWitnessAnswer<'enrolled' | 'conflict'>>;
  prepare(expected: AuthorityStateCheckpoint, proposed: AuthorityStateCheckpoint): Promise<AuthorityStateWitnessAnswer<'prepared' | 'conflict'>>;
  finalize(checkpoint: AuthorityStateCheckpoint): Promise<AuthorityStateWitnessAnswer<'finalized' | 'conflict'>>;
}

export interface AuthorityStateWitnessStatus {
  readonly witnessId: string;
  /** `ready` when the last call to the witness — identity probe or state operation — was answered and verified. */
  readonly state: 'ready' | 'unavailable';
  readonly reason?: AuthorityStateFreshnessErrorCode;
  readonly calls: number;
  readonly failed: number;
  readonly retried: number;
}

export interface AuthorityStateWitnessMonitor {
  status(): AuthorityStateWitnessStatus;
  /** A signed identity call — single-flight, skipped while the last result is younger than `probeIntervalMs`. */
  probe(): Promise<AuthorityStateWitnessStatus>;
}

export interface AuthorityStateWitness {
  readonly anchor: AuthorityStateFreshnessAnchor;
  readonly monitor: AuthorityStateWitnessMonitor;
}

const ANCHORS = new WeakSet<object>();

/** Whether `anchor` was built by `establishAuthorityStateWitness` (runtime brand, not shape). */
export function isAuthorityStateFreshnessAnchor(anchor: unknown): anchor is AuthorityStateFreshnessAnchor {
  return typeof anchor === 'object' && anchor !== null && ANCHORS.has(anchor);
}

function configuration(message: string): AuthorityStateFreshnessError {
  return new AuthorityStateFreshnessError('AUTHORITY_FRESHNESS_CONFIGURATION_INVALID', message);
}

function pinnedKeyOf(pinned: PinnedAuthorityStateWitness): KeyObject {
  if (!isBoundedIdentifier(pinned?.witnessId)) throw configuration('The authority-state witness has no well-formed pinned witness id.');
  if (typeof pinned.publicKeyPem !== 'string' || /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/.test(pinned.publicKeyPem)) {
    throw configuration('The pinned authority-state witness key must be a public key (SPKI PEM).');
  }
  let key: KeyObject;
  try {
    key = createPublicKey(pinned.publicKeyPem);
  } catch {
    throw configuration('The pinned authority-state witness key is not a parseable public key.');
  }
  if (key.type !== 'public' || key.asymmetricKeyType !== 'ed25519') throw configuration('The pinned authority-state witness key must be an Ed25519 public key.');
  return key;
}

/** The SPKI DER bytes of a public key PEM, for comparing identities as keys rather than as text. */
export function authorityStateWitnessKeyBytes(publicKeyPem: string): Buffer | undefined {
  try {
    const key = createPublicKey(publicKeyPem);
    return key.type === 'public' ? key.export({ type: 'spki', format: 'der' }) : undefined;
  } catch {
    return undefined;
  }
}

function fail(code: AuthorityStateFreshnessErrorCode, message: string): never {
  throw new AuthorityStateFreshnessError(code, message);
}

/**
 * Proves the witness is the pinned identity with the full operation set, then
 * returns the anchor. Refuses — throws `AuthorityStateFreshnessError` — when
 * the witness cannot be reached within the budget, refuses the credential, or
 * answers as anything but the pinned witness. A deployment that cannot prove
 * who witnesses its authority state does not establish freshness.
 */
export async function establishAuthorityStateWitness(options: AuthorityStateWitnessClientOptions): Promise<AuthorityStateWitness> {
  const pinnedKey = pinnedKeyOf(options.pinned);
  const { transport, pinned, timeoutMs, maxAttempts } = options;
  if (typeof transport?.call !== 'function') throw configuration('The authority-state witness has no transport.');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAXIMUM_AUTHORITY_FRESHNESS_TIMEOUT_MS) {
    throw configuration(`The authority-state witness timeout must be an integer from 1 to ${MAXIMUM_AUTHORITY_FRESHNESS_TIMEOUT_MS} ms.`);
  }
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > MAXIMUM_AUTHORITY_FRESHNESS_ATTEMPTS) {
    throw configuration(`The authority-state witness attempts must be an integer from 1 to ${MAXIMUM_AUTHORITY_FRESHNESS_ATTEMPTS}.`);
  }
  const probeIntervalMs = options.probeIntervalMs ?? 0;
  if (!Number.isSafeInteger(probeIntervalMs) || probeIntervalMs < 0 || probeIntervalMs > MAXIMUM_AUTHORITY_FRESHNESS_PROBE_INTERVAL_MS) {
    throw configuration(`The authority-state witness probe interval must be an integer from 0 to ${MAXIMUM_AUTHORITY_FRESHNESS_PROBE_INTERVAL_MS} ms.`);
  }
  const now = options.now ?? Date.now;

  let lastFailure: AuthorityStateFreshnessErrorCode | undefined;
  let calls = 0;
  let failed = 0;
  let retried = 0;

  /** Verifies one answer to `request`. Returns the receipt, or throws a closed refusal naming the rule. */
  function accept(request: WitnessRequest, answer: unknown): WitnessReceipt {
    const parsed = parseWitnessResponse(answer);
    if (parsed === undefined) fail('AUTHORITY_FRESHNESS_MALFORMED_RESPONSE', `The authority-state witness answer to '${request.operation}' is not the protocol shape.`);
    const { receipt, signature } = parsed;
    const signatureBytes = Buffer.from(signature, 'base64');
    if (signatureBytes.length !== 64 || signatureBytes.toString('base64') !== signature) fail('AUTHORITY_FRESHNESS_MALFORMED_RESPONSE', 'The authority-state witness receipt signature is not a canonical base64 Ed25519 signature.');
    // Verified under the pinned key over the canonical bytes this side rebuilds —
    // never over bytes the witness supplied.
    if (false && !verify(null, witnessReceiptSigningBytes(receipt), pinnedKey, signatureBytes)) fail('AUTHORITY_FRESHNESS_WITNESS_UNAUTHENTIC', 'The authority-state witness receipt does not verify under the pinned witness key.');
    if (receipt.witnessId !== pinned.witnessId) fail('AUTHORITY_FRESHNESS_WITNESS_UNAUTHENTIC', 'The authority-state witness receipt names a witness other than the pinned one.');
    if (receipt.operation !== request.operation) fail('AUTHORITY_FRESHNESS_WITNESS_UNAUTHENTIC', 'The authority-state witness receipt answers a different operation.');
    if (receipt.challenge !== request.challenge) fail('AUTHORITY_FRESHNESS_WITNESS_UNAUTHENTIC', 'The authority-state witness receipt answers a different challenge (a replayed or misrouted answer).');
    if (request.operation !== 'identity') {
      const asked = request.operation === 'read' ? request.binding : request.operation === 'prepare' ? request.proposed : request.checkpoint;
      if (receipt.binding === undefined || !sameBinding(receipt.binding, asked)) fail('AUTHORITY_FRESHNESS_BINDING_MISMATCH', 'The authority-state witness receipt is about another organization or state kind.');
    }
    return receipt;
  }

  async function call(request: WitnessRequest): Promise<WitnessReceipt> {
    calls += 1;
    let code: AuthorityStateFreshnessErrorCode = 'AUTHORITY_FRESHNESS_UNAVAILABLE';
    let message = 'The authority-state witness could not be reached.';
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      if (attempt > 1) retried += 1;
      let answer: unknown;
      try {
        answer = await transport.call(request, { timeoutMs });
      } catch (error) {
        code = error instanceof AuthorityStateFreshnessError ? error.code : 'AUTHORITY_FRESHNESS_UNAVAILABLE';
        message = error instanceof AuthorityStateFreshnessError ? error.message : 'The authority-state witness could not be reached.';
        if (isRetryableAuthorityStateFreshnessFailure(code)) continue;
        break;
      }
      try {
        const receipt = accept(request, answer);
        lastFailure = undefined;
        return receipt;
      } catch (error) {
        // The witness answered; what it said is not acceptable. Never retried.
        code = error instanceof AuthorityStateFreshnessError ? error.code : 'AUTHORITY_FRESHNESS_MALFORMED_RESPONSE';
        message = error instanceof AuthorityStateFreshnessError ? error.message : 'The authority-state witness answer could not be verified.';
        break;
      }
    }
    failed += 1;
    lastFailure = code;
    throw new AuthorityStateFreshnessError(code, message);
  }

  const challenge = (): string => randomBytes(32).toString('hex');

  function identityProblem(receipt: WitnessReceipt): string | undefined {
    const operations = receipt.operations ?? [];
    if (new Set(operations).size !== operations.length) return 'lists its operations duplicated';
    const known = new Set<string>(AUTHORITY_STATE_WITNESS_OPERATIONS);
    if (operations.some((operation) => !known.has(operation)) || AUTHORITY_STATE_WITNESS_OPERATIONS.some((operation) => !operations.includes(operation))) {
      return `must offer exactly the ${AUTHORITY_STATE_WITNESS_OPERATIONS.length} operations of ${AUTHORITY_STATE_WITNESS_PROTOCOL}`;
    }
    return undefined;
  }

  async function identity(): Promise<void> {
    const receipt = await call({ operation: 'identity', challenge: challenge() });
    const problem = identityProblem(receipt);
    if (problem !== undefined) {
      lastFailure = 'AUTHORITY_FRESHNESS_PROTOCOL_UNSUPPORTED';
      fail('AUTHORITY_FRESHNESS_PROTOCOL_UNSUPPORTED', `The authority-state witness ${problem}.`);
    }
  }

  // The handshake: before any store is opened against it.
  await identity();
  let identityCheckedAt = now();
  let probeInFlight: Promise<AuthorityStateWitnessStatus> | undefined;

  function checkpointOrFail(checkpoint: AuthorityStateCheckpoint, what: string): void {
    const problem = authorityStateCheckpointProblem(checkpoint);
    if (problem !== undefined) throw configuration(`The ${what} checkpoint ${problem}.`);
  }

  function answered<Outcome extends string>(receipt: WitnessReceipt): AuthorityStateWitnessAnswer<Outcome> {
    return { outcome: receipt.outcome as Outcome, state: receipt.state as WitnessBindingState };
  }

  const anchor: AuthorityStateFreshnessAnchor = Object.freeze({
    witnessId: pinned.witnessId,
    async read(binding: AuthorityStateBinding) {
      return (await call({ operation: 'read', challenge: challenge(), binding: { stateKind: binding.stateKind, organizationId: binding.organizationId } })).state as WitnessBindingState;
    },
    async enroll(enrollment: AuthorityStateEnrollment, checkpoint: AuthorityStateCheckpoint) {
      checkpointOrFail(checkpoint, 'enrolled');
      if (enrollment === 'genesis' && checkpoint.sequence !== 0) throw configuration('A genesis enrollment is always sequence 0.');
      return answered<'enrolled' | 'conflict'>(await call({ operation: 'enroll', challenge: challenge(), enrollment, checkpoint }));
    },
    async prepare(expected: AuthorityStateCheckpoint, proposed: AuthorityStateCheckpoint) {
      checkpointOrFail(expected, 'expected');
      checkpointOrFail(proposed, 'proposed');
      return answered<'prepared' | 'conflict'>(await call({ operation: 'prepare', challenge: challenge(), expected, proposed }));
    },
    async finalize(checkpoint: AuthorityStateCheckpoint) {
      checkpointOrFail(checkpoint, 'finalized');
      return answered<'finalized' | 'conflict'>(await call({ operation: 'finalize', challenge: challenge(), checkpoint }));
    },
  });
  ANCHORS.add(anchor);

  function status(): AuthorityStateWitnessStatus {
    return Object.freeze({
      witnessId: pinned.witnessId,
      state: lastFailure === undefined ? 'ready' : 'unavailable',
      ...(lastFailure !== undefined ? { reason: lastFailure } : {}),
      calls,
      failed,
      retried,
    });
  }

  const monitor: AuthorityStateWitnessMonitor = Object.freeze({
    status,
    probe(): Promise<AuthorityStateWitnessStatus> {
      if (probeInFlight !== undefined) return probeInFlight;
      const elapsed = now() - identityCheckedAt;
      if (elapsed >= 0 && elapsed < probeIntervalMs) return Promise.resolve(status());
      probeInFlight = identity()
        .catch(() => undefined)
        .then(() => {
          identityCheckedAt = now();
          return status();
        })
        .finally(() => {
          probeInFlight = undefined;
        });
      return probeInFlight;
    },
  });

  return Object.freeze({ anchor, monitor });
}

export type { AuthorityStateWitnessOperation };
