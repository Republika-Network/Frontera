import { createHash, createPublicKey } from 'node:crypto';

import { createAuthoritySignatureRegistry, type AuthoritySignatureRegistry, type TrustedVerificationKey } from '../authority-authenticity/signature-verification.js';
import { isExecutionCapabilityIdentifier } from '../execution-capability/capability.js';
import { executorReceiptSigningBytes, parseExecutorReceipt, type ExecutorReceipt, type ExecutorReceiptOutcome, type ExecutorReceiptParseFailure } from './receipt.js';

/**
 * G-02C1C — the **standalone executor-receipt verifier**: no executor key, no
 * Host key, no Kernel, grant store, orchestrator or signer. It needs only the
 * executor public keys its caller pinned, and what the caller expects.
 *
 * ## Separate answers, never one boolean
 *
 * | Answer | Question |
 * |---|---|
 * | `canonical` | is this the one canonical spelling of a well-formed, self-consistent receipt? |
 * | `executorTrust` | does the registry pin this executor and this key id for it? (a key in the receipt is never trusted) |
 * | `signature` | does the pinned key's signature cover the receipt domain and exactly this text? |
 * | `scope` | is this executor pinned for the receipt's audience, organization and trust domain? |
 * | `identityMatch` | does it name what the caller expected (executor, issuer, capability, execution, audience, organization, trust domain)? |
 * | `bindingMatch` | does it state the action binding the caller expected (`unknown` if the caller gave none)? |
 * | `receiptState` | within the history the caller supplied: current, superseded or conflicting (`unknown` without history) |
 * | `reportedOutcome` | what the executor *says* it observed |
 * | `externalConfirmation` | always `not-established`: no provider or settlement is proven |
 * | `issuedHere` | always `not-evaluated`: correlating with a Host's issuance ledger is G-02C1D |
 *
 * A receipt is "current" only relative to the history it was shown with: no
 * verifier can prove from a receipt alone that no newer one exists.
 */

export interface TrustedExecutor {
  readonly executorId: string;
  /** Every key pinned for this executor (rotation overlap). Each key id names one key of one executor. */
  readonly keys: readonly TrustedVerificationKey[];
  readonly audiences: readonly string[];
  readonly organizationIds: readonly string[];
  readonly trustDomains: readonly string[];
}

export class ExecutorReceiptVerifierConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExecutorReceiptVerifierConfigurationError';
  }
}

/** A receipt as presented: its canonical text and the CORE-02 signature envelope over the receipt domain. */
export interface PresentedExecutorReceipt {
  readonly receipt: string;
  readonly signature: unknown;
}

export interface ExpectedExecutorReceipt {
  readonly executorId?: string;
  readonly issuer?: string;
  readonly capabilityId?: string;
  readonly executionId?: string;
  readonly audience?: string;
  readonly organizationId?: string;
  readonly trustDomain?: string;
  readonly actionBinding?: { readonly format: string; readonly digest: string };
}

export type ExecutorReceiptVerificationFailure =
  | ExecutorReceiptParseFailure
  | 'PRESENTATION_MALFORMED'
  | 'EXECUTOR_UNTRUSTED'
  | 'EXECUTOR_KEY_UNTRUSTED'
  | 'SIGNATURE_INVALID'
  | 'SCOPE_NOT_PERMITTED'
  | 'IDENTITY_MISMATCH'
  | 'BINDING_MISMATCH'
  | 'VERIFIER_FAILURE';

export interface ExecutorReceiptVerification {
  readonly canonical: 'valid' | 'invalid';
  readonly executorTrust: 'trusted' | 'untrusted' | 'not-evaluated';
  readonly signature: 'valid' | 'invalid' | 'not-evaluated';
  readonly scope: 'permitted' | 'not-permitted' | 'not-evaluated';
  readonly identityMatch: 'yes' | 'no' | 'not-requested' | 'not-evaluated';
  readonly bindingMatch: 'yes' | 'no' | 'unknown';
  readonly receiptState: 'current' | 'superseded' | 'conflicting' | 'unknown';
  /** The executor's own statement, once the signature is valid; otherwise `null`. */
  readonly reportedOutcome: ExecutorReceiptOutcome | null;
  readonly externalConfirmation: 'not-established';
  readonly issuedHere: 'not-evaluated';
  /** The first check that refused, if one did. */
  readonly failure: ExecutorReceiptVerificationFailure | null;
  /** The receipt, once canonical and signed by a pinned key; otherwise `null`. */
  readonly receipt: ExecutorReceipt | null;
}

export interface ExecutorReceiptVerifier {
  verify(presented: unknown, options?: { readonly expected?: ExpectedExecutorReceipt; readonly history?: readonly unknown[] }): ExecutorReceiptVerification;
  /** The receipt chain for one capability, from the history the caller holds: each receipt `current`, `superseded` or `conflicting`. */
  assessHistory(history: readonly unknown[]): ExecutorReceiptHistory;
  readonly trustedExecutors: readonly string[];
}

export interface ExecutorReceiptHistory {
  readonly chain: 'valid' | 'conflicting' | 'empty';
  /** The receipt id of the newest valid receipt, when the chain is valid. */
  readonly current: string | null;
  /** Receipt ids that failed verification and were left out. */
  readonly rejected: number;
  readonly states: Readonly<Record<string, 'current' | 'superseded' | 'conflicting'>>;
}

function identity(value: unknown, what: string): string {
  if (!isExecutionCapabilityIdentifier(value) || value.includes('*')) throw new ExecutorReceiptVerifierConfigurationError(`${what} must be one exact identifier.`);
  return value;
}

function identities(value: unknown, what: string): readonly string[] {
  if (!Array.isArray(value) || value.length === 0) throw new ExecutorReceiptVerifierConfigurationError(`${what} must list at least one identifier.`);
  const out = value.map((entry: unknown) => identity(entry, what));
  if (new Set(out).size !== out.length) throw new ExecutorReceiptVerifierConfigurationError(`${what} lists an identifier twice.`);
  return Object.freeze(out);
}

interface Pinned {
  readonly registry: AuthoritySignatureRegistry;
  readonly audiences: readonly string[];
  readonly organizationIds: readonly string[];
  readonly trustDomains: readonly string[];
}

export function createExecutorReceiptVerifier(options: { readonly trustedExecutors: readonly TrustedExecutor[] }): ExecutorReceiptVerifier {
  const entries = Array.isArray(options?.trustedExecutors) ? options.trustedExecutors : [];
  if (entries.length === 0) throw new ExecutorReceiptVerifierConfigurationError('The receipt verifier needs at least one pinned executor.');
  const executors = new Map<string, Pinned>();
  const keyOwners = new Map<string, string>();
  const materials = new Set<string>();
  for (const entry of entries) {
    const executorId = identity(entry?.executorId, 'executorId');
    if (executors.has(executorId)) throw new ExecutorReceiptVerifierConfigurationError('An executor is pinned twice.');
    const keys = Array.isArray(entry.keys) ? entry.keys : [];
    // CORE-02's own registry rules: public SPKI only, no duplicate id, the key type matches the algorithm.
    const registry = createAuthoritySignatureRegistry(keys);
    for (const key of keys) {
      if (keyOwners.has(key.keyId)) throw new ExecutorReceiptVerifierConfigurationError('A key id is pinned for more than one executor.');
      keyOwners.set(key.keyId, executorId);
      const material = createHash('sha256').update(createPublicKey(key.publicKeyPem).export({ type: 'spki', format: 'der' })).digest('hex');
      if (materials.has(material)) throw new ExecutorReceiptVerifierConfigurationError('The same public key material is pinned twice.');
      materials.add(material);
    }
    executors.set(executorId, Object.freeze({ registry, audiences: identities(entry.audiences, 'audiences'), organizationIds: identities(entry.organizationIds, 'organizationIds'), trustDomains: identities(entry.trustDomains, 'trustDomains') }));
  }

  function base(): { -readonly [K in keyof ExecutorReceiptVerification]: ExecutorReceiptVerification[K] } {
    return {
      canonical: 'invalid',
      executorTrust: 'not-evaluated',
      signature: 'not-evaluated',
      scope: 'not-evaluated',
      identityMatch: 'not-evaluated',
      bindingMatch: 'unknown',
      receiptState: 'unknown',
      reportedOutcome: null,
      externalConfirmation: 'not-established',
      issuedHere: 'not-evaluated',
      failure: null,
      receipt: null,
    };
  }

  /** Canonical form, pinned executor and key, signature. Everything a single receipt can establish about who said it. */
  function authenticate(presented: unknown): { readonly result: ReturnType<typeof base>; readonly receipt?: ExecutorReceipt } {
    const result = base();
    const refuse = (failure: ExecutorReceiptVerificationFailure) => {
      result.failure = failure;
      return { result };
    };
    if (presented === null || typeof presented !== 'object' || Array.isArray(presented)) return refuse('PRESENTATION_MALFORMED');
    const text = (presented as Record<string, unknown>)['receipt'];
    const signature = (presented as Record<string, unknown>)['signature'];
    const keys = Reflect.ownKeys(presented);
    if (keys.length !== 2 || !keys.includes('receipt') || !keys.includes('signature')) return refuse('PRESENTATION_MALFORMED');
    const parsed = parseExecutorReceipt(text);
    if (!parsed.ok) return refuse(parsed.failure);
    result.canonical = 'valid';
    const receipt = parsed.receipt;

    const pinned = executors.get(receipt.executorId);
    if (pinned === undefined) {
      result.executorTrust = 'untrusted';
      return refuse('EXECUTOR_UNTRUSTED');
    }
    const envelopeKeyId = signature !== null && typeof signature === 'object' ? (signature as Record<string, unknown>)['keyId'] : undefined;
    const keyPinned = envelopeKeyId === receipt.executorKeyId && keyOwners.get(receipt.executorKeyId) === receipt.executorId;
    if (!keyPinned) {
      result.executorTrust = 'untrusted';
      return refuse('EXECUTOR_KEY_UNTRUSTED');
    }
    result.executorTrust = 'trusted';

    const verdict = pinned.registry.verify(executorReceiptSigningBytes(receipt), signature);
    if (!verdict.verified) {
      result.signature = 'invalid';
      return refuse('SIGNATURE_INVALID');
    }
    result.signature = 'valid';
    result.reportedOutcome = receipt.outcome;
    result.receipt = receipt;
    return { result, receipt };
  }

  function assessHistory(history: readonly unknown[]): ExecutorReceiptHistory {
    const valid: ExecutorReceipt[] = [];
    let rejected = 0;
    for (const entry of Array.isArray(history) ? history : []) {
      const { receipt } = authenticate(entry);
      if (receipt === undefined) rejected += 1;
      else valid.push(receipt);
    }
    if (valid.length === 0) return Object.freeze({ chain: 'empty' as const, current: null, rejected, states: Object.freeze({}) });
    const states: Record<string, 'current' | 'superseded' | 'conflicting'> = {};
    const conflict = (): ExecutorReceiptHistory => {
      for (const receipt of valid) states[receipt.receiptId] = 'conflicting';
      return Object.freeze({ chain: 'conflicting' as const, current: null, rejected, states: Object.freeze(states) });
    };
    const first = valid[0] as ExecutorReceipt;
    // One subject: every receipt about the same executor, capability, execution, issuer, scope and binding.
    const subject = (receipt: ExecutorReceipt): string =>
      JSON.stringify([receipt.executorId, receipt.capabilityId, receipt.executionId, receipt.issuer, receipt.audience, receipt.organizationId, receipt.trustDomain, receipt.actionBinding.format, receipt.actionBinding.digest, receipt.consumption.claimedAt]);
    if (!valid.every((receipt) => subject(receipt) === subject(first))) return conflict();
    // One receipt per position: an exact duplicate is one receipt; two different texts at one position are a conflict.
    const bySequence = new Map<number, ExecutorReceipt>();
    for (const receipt of valid) {
      const seen = bySequence.get(receipt.sequence);
      if (seen !== undefined && JSON.stringify(seen) !== JSON.stringify(receipt)) return conflict();
      bySequence.set(receipt.sequence, receipt);
    }
    const ordered = [...bySequence.values()].sort((left, right) => left.sequence - right.sequence);
    for (let index = 0; index < ordered.length; index += 1) {
      const receipt = ordered[index] as ExecutorReceipt;
      if (receipt.sequence !== index + 1) return conflict();
      if (index === 0) continue;
      const prior = ordered[index - 1] as ExecutorReceipt;
      // Forward only: a successor supersedes exactly its predecessor, which was unknown, with a definite outcome observed no earlier.
      const forward = receipt.supersedes === prior.receiptId && prior.outcome === 'attempted-outcome-unknown' && receipt.outcome !== 'attempted-outcome-unknown' && receipt.observedAt >= prior.observedAt;
      if (!forward) return conflict();
    }
    const newest = ordered[ordered.length - 1] as ExecutorReceipt;
    for (const receipt of ordered) states[receipt.receiptId] = receipt.receiptId === newest.receiptId ? 'current' : 'superseded';
    return Object.freeze({ chain: 'valid' as const, current: newest.receiptId, rejected, states: Object.freeze(states) });
  }

  function verify(presented: unknown, options: { readonly expected?: ExpectedExecutorReceipt; readonly history?: readonly unknown[] } = {}): ExecutorReceiptVerification {
    try {
      const { result, receipt } = authenticate(presented);
      if (receipt === undefined) return Object.freeze(result);
      const pinned = executors.get(receipt.executorId) as Pinned;
      const permitted = pinned.audiences.includes(receipt.audience) && pinned.organizationIds.includes(receipt.organizationId) && pinned.trustDomains.includes(receipt.trustDomain);
      result.scope = permitted ? 'permitted' : 'not-permitted';
      if (!permitted && result.failure === null) result.failure = 'SCOPE_NOT_PERMITTED';

      const expected = options.expected ?? {};
      const checks: readonly (readonly [string | undefined, string])[] = [
        [expected.executorId, receipt.executorId],
        [expected.issuer, receipt.issuer],
        [expected.capabilityId, receipt.capabilityId],
        [expected.executionId, receipt.executionId],
        [expected.audience, receipt.audience],
        [expected.organizationId, receipt.organizationId],
        [expected.trustDomain, receipt.trustDomain],
      ];
      const requested = checks.filter(([want]) => want !== undefined);
      const identityMatches = requested.every(([want, have]) => want === have);
      result.identityMatch = requested.length === 0 ? 'not-requested' : identityMatches ? 'yes' : 'no';
      if (!identityMatches && result.failure === null) result.failure = 'IDENTITY_MISMATCH';

      const binding = expected.actionBinding;
      if (binding !== undefined) {
        const bindingMatches = binding.format === receipt.actionBinding.format && binding.digest === receipt.actionBinding.digest;
        result.bindingMatch = bindingMatches ? 'yes' : 'no';
        if (!bindingMatches && result.failure === null) result.failure = 'BINDING_MISMATCH';
      }

      if (options.history !== undefined) {
        const assessed = assessHistory([...options.history, presented]);
        result.receiptState = assessed.chain === 'valid' ? (assessed.states[receipt.receiptId] ?? 'conflicting') : 'conflicting';
      }
      return Object.freeze(result);
    } catch {
      const result = base();
      result.failure = 'VERIFIER_FAILURE';
      return Object.freeze(result);
    }
  }

  return Object.freeze({ verify, assessHistory, trustedExecutors: Object.freeze([...executors.keys()]) });
}
