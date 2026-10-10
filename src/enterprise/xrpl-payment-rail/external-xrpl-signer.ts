import { randomBytes } from 'node:crypto';

import { isXrplClassicAddress, isXrplSigningPublicKey, type XrplPreparedPayment, type XrplTransactionSigner } from '../../features/payment-runtime/rails/xrpl/index.js';
import { EXTERNAL_XRPL_SIGNER_PROTOCOL, isExternalXrplSignerId, parseExternalXrplSignerIdentity, parseExternalXrplSigningResponse } from './signer-protocol.js';
import { ExternalXrplSignerConfigurationError, ExternalXrplSignerError, type ExternalXrplSignerFailureReason, type ExternalXrplSignerTransport } from './signer-http-transport.js';

/**
 * PAY-03 — the external XRPL transaction signer, as the rail's
 * `XrplTransactionSigner` capability.
 *
 * ```
 * Frontera Host                                             customer-controlled custody
 * ─────────────                                             ───────────────────────────
 * rail.prepareAndSign
 *   └─ signer.sign(prepared)  ── /v1/sign/xrpl-payment ──▶  holds the XRPL key; signs exactly
 *        (this adapter)                                     the Payment it was handed
 *          ├─ identity proven against the trusted pin (no TOFU)
 *          ├─ fresh requestId; response bound to it, the signer id and the account
 *          └─ blob returned to the rail, which verifies it signs exactly the prepared
 *             payment, under the PINNED signing key, with its own hash — then submits once
 * ```
 *
 * The Host process never holds, reads or derives an XRPL private key: it holds
 * a signer **endpoint**, a transport **credential**, and **public** pins.
 *
 * ## Identity pinning
 *
 * Trusted configuration pins the signer id and, per source account, the
 * signing public key. The identity answer must name exactly the pinned signer
 * id and protocol, offer exactly the one operation, and advertise every pinned
 * account with exactly its pinned key. Nothing advertised is ever adopted;
 * rotation is configuration + restart. A mismatch — at startup, or on any
 * later handshake — refuses signing for the life of the process.
 *
 * ## Availability
 *
 * The identity is proven at startup when the signer answers. When it does
 * not, the Host may still start (degraded) and the identity is proven before
 * the first signature instead; nothing is ever signed under an unproven
 * identity. Every signing call is one attempt under one time budget: a
 * timeout, refusal or malformed answer is a refusal with nothing submitted.
 */
export interface ExternalXrplSignerPin {
  readonly signerId: string;
  readonly accounts: readonly { readonly address: string; readonly signingPublicKey: string }[];
}

export type ExternalXrplSignerState = 'verified' | 'unverified' | 'mismatch';

export interface ExternalXrplSignerStatus {
  readonly signerId: string;
  readonly state: ExternalXrplSignerState;
  /** The last failure, as a closed reason. Never a body, status text or address. */
  readonly reason?: ExternalXrplSignerFailureReason;
  readonly accounts: number;
}

export interface ExternalXrplSigner {
  /** One per pinned account, for `createXrplRlusdRail({ signers })`. Each declares its pinned signing key. */
  readonly signers: readonly XrplTransactionSigner[];
  /** One identity handshake (single-flight, rate-limited by `probeIntervalMs`). Never signs. */
  probe(): Promise<ExternalXrplSignerStatus>;
  status(): ExternalXrplSignerStatus;
}

export interface ExternalXrplSignerOptions {
  readonly transport: ExternalXrplSignerTransport;
  readonly pin: ExternalXrplSignerPin;
  readonly timeoutMs: number;
  readonly probeIntervalMs?: number;
  /** Injected for qualification; default `randomBytes(32)` as hex. */
  readonly requestId?: () => string;
  readonly now?: () => number;
}

export const EXTERNAL_XRPL_SIGNER_LIMITS = Object.freeze({
  timeoutMs: Object.freeze({ minimum: 1, maximum: 60_000, default: 10_000 }),
  probeIntervalMs: Object.freeze({ minimum: 0, maximum: 60_000, default: 5_000 }),
});

function validatePin(pin: unknown): ExternalXrplSignerPin {
  const value = pin as ExternalXrplSignerPin | undefined;
  if (!isExternalXrplSignerId(value?.signerId)) throw new ExternalXrplSignerConfigurationError('The external XRPL signer pin needs a signer id.');
  if (!Array.isArray(value.accounts) || value.accounts.length === 0) throw new ExternalXrplSignerConfigurationError('The external XRPL signer pin needs at least one account.');
  const seen = new Set<string>();
  const accounts = value.accounts.map((account, index) => {
    if (!isXrplClassicAddress(account?.address)) throw new ExternalXrplSignerConfigurationError(`The external XRPL signer pin's account ${index} is not a classic address.`);
    if (!isXrplSigningPublicKey(account.signingPublicKey)) throw new ExternalXrplSignerConfigurationError(`The external XRPL signer pin's account ${index} has no 33-byte uppercase-hex signing public key.`);
    if (seen.has(account.address)) throw new ExternalXrplSignerConfigurationError(`The external XRPL signer pin names account ${index} twice.`);
    seen.add(account.address);
    return Object.freeze({ address: account.address, signingPublicKey: account.signingPublicKey });
  });
  return Object.freeze({ signerId: value.signerId, accounts: Object.freeze(accounts) });
}

export function createExternalXrplSigner(options: ExternalXrplSignerOptions): ExternalXrplSigner {
  const transport = options?.transport;
  if (typeof transport?.identity !== 'function' || typeof transport.signPayment !== 'function') throw new ExternalXrplSignerConfigurationError('The external XRPL signer needs a transport.');
  const pin = validatePin(options.pin);
  const timeoutMs = options.timeoutMs;
  const limits = EXTERNAL_XRPL_SIGNER_LIMITS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < limits.timeoutMs.minimum || timeoutMs > limits.timeoutMs.maximum) throw new ExternalXrplSignerConfigurationError(`The external XRPL signer timeout must be an integer from ${limits.timeoutMs.minimum} to ${limits.timeoutMs.maximum} ms.`);
  const probeIntervalMs = options.probeIntervalMs ?? limits.probeIntervalMs.default;
  if (!Number.isSafeInteger(probeIntervalMs) || probeIntervalMs < limits.probeIntervalMs.minimum || probeIntervalMs > limits.probeIntervalMs.maximum) throw new ExternalXrplSignerConfigurationError('The external XRPL signer probe interval is out of bounds.');
  const nextRequestId = options.requestId ?? (() => randomBytes(32).toString('hex'));
  const now = options.now ?? (() => Date.now());

  let state: ExternalXrplSignerState = 'unverified';
  let reason: ExternalXrplSignerFailureReason | undefined;
  let inFlight: Promise<void> | undefined;
  let lastProbeAt: number | undefined;

  const status = (): ExternalXrplSignerStatus => Object.freeze({ signerId: pin.signerId, state, ...(reason !== undefined ? { reason } : {}), accounts: pin.accounts.length });

  /** One identity handshake. A mismatch is permanent for this process; unavailability is not. */
  async function handshake(): Promise<void> {
    if (state === 'mismatch') return;
    let raw: unknown;
    try {
      raw = await transport.identity({ timeoutMs });
    } catch (error) {
      reason = error instanceof ExternalXrplSignerError ? error.reason : 'XRPL_SIGNER_UNREACHABLE';
      // A once-proven identity stays proven while the signer is merely unreachable; each signature is still verified.
      return;
    }
    const identity = parseExternalXrplSignerIdentity(raw);
    if (identity === undefined) {
      reason = 'XRPL_SIGNER_MALFORMED_RESPONSE';
      return;
    }
    const advertised = new Map(identity.accounts.map((account) => [account.address, account.signingPublicKey]));
    if (identity.signerId !== pin.signerId || pin.accounts.some((account) => advertised.get(account.address) !== account.signingPublicKey)) {
      state = 'mismatch';
      reason = 'XRPL_SIGNER_IDENTITY_MISMATCH';
      return;
    }
    state = 'verified';
    reason = undefined;
  }

  function probe(force = false): Promise<void> {
    if (inFlight !== undefined) return inFlight;
    const at = now();
    if (!force && lastProbeAt !== undefined && at >= lastProbeAt && at - lastProbeAt < probeIntervalMs) return Promise.resolve();
    lastProbeAt = at;
    inFlight = handshake().finally(() => {
      inFlight = undefined;
    });
    return inFlight;
  }

  async function sign(address: string, transaction: XrplPreparedPayment): Promise<{ readonly signedTransaction: string; readonly hash: string }> {
    if (state === 'unverified') await probe(true);
    if (state !== 'verified') throw new ExternalXrplSignerError(reason ?? 'XRPL_SIGNER_UNAVAILABLE', 'The external XRPL signer identity is not proven; nothing is signed.');
    if (transaction?.Account !== address) throw new ExternalXrplSignerError('XRPL_SIGNER_REFUSED', 'The prepared payment is not for this signer account.');
    const requestId = nextRequestId();
    let raw: unknown;
    try {
      raw = await transport.signPayment({ protocol: EXTERNAL_XRPL_SIGNER_PROTOCOL, signerId: pin.signerId, requestId, account: address, transaction }, { timeoutMs });
    } catch (error) {
      reason = error instanceof ExternalXrplSignerError ? error.reason : 'XRPL_SIGNER_UNREACHABLE';
      throw new ExternalXrplSignerError(reason, 'The external XRPL signer did not sign; nothing is submitted.');
    }
    const response = parseExternalXrplSigningResponse(raw);
    if (response === undefined) {
      reason = 'XRPL_SIGNER_MALFORMED_RESPONSE';
      throw new ExternalXrplSignerError(reason, 'The external XRPL signer answered outside the protocol; nothing is submitted.');
    }
    // Bound to this request, this signer and this account. The blob itself is verified by the rail.
    if (response.requestId !== requestId || response.signerId !== pin.signerId || response.account !== address) {
      reason = 'XRPL_SIGNER_RESPONSE_MISMATCH';
      throw new ExternalXrplSignerError(reason, 'The external XRPL signer answered for another request, signer or account; nothing is submitted.');
    }
    reason = undefined;
    return { signedTransaction: response.signedTransaction, hash: response.hash };
  }

  const signers: XrplTransactionSigner[] = pin.accounts.map((account) =>
    Object.freeze({
      address: account.address,
      signingPublicKey: account.signingPublicKey,
      sign: (transaction: XrplPreparedPayment) => sign(account.address, transaction),
    }),
  );

  return Object.freeze({
    signers: Object.freeze(signers),
    async probe() {
      await probe();
      return status();
    },
    status,
  });
}
