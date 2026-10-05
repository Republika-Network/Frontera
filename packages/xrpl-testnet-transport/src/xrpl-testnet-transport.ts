import { decode, hashes, isValidClassicAddress } from 'xrpl';

import {
  TERMINAL_ATTEMPT_STATES,
  type XrplAttemptRecord,
  type XrplSubmissionAttempt,
  type XrplSubmissionAttemptStore,
} from './attempt-store.js';
import type {
  XrplIssuedAmount,
  XrplLedgerClient,
  XrplPaymentSubmission,
  XrplSettlementGate,
  XrplSubmissionObservation,
  XrplTransactionLookup,
  XrplTransactionSigner,
  XrplTransportEvent,
} from './contracts.js';
import { XrplTransportConfigurationError } from './contracts.js';
import { issuedValuesEqual } from './decimal.js';
import { connectXrplLedgerClient } from './xrpl-ledger-client.js';
import { resolveXrplTestnetConfiguration, type XrplTestnetTransportConfigurationInput } from './testnet-configuration.js';

/**
 * The real XRPL Testnet transport (ANDREW-P0-08) — the implementation of the
 * XRPL adapter's `XrplPaymentTransport` port.
 *
 * ```
 * submission ─► settlement gate (P0-07)  ─refused─► not-submitted   (no network, no signature)
 *            ─► local checks             ─refused─► not-submitted
 *            ─► existing attempt?        ─yes─────► reconcile by hash (never re-sign, never resubmit)
 *            ─► grant lifetime guard     ─short───► not-submitted
 *            ─► connect; network_id == 1 ─no──────► not-submitted
 *            ─► autofill + LastLedgerSequence = validated + horizon; validate every field
 *            ─► signer.sign; verify blob decodes to exactly that transaction and hashes to the returned hash
 *            ─► DURABLY PERSIST the attempt (hash, blob, sequence, LLS, validated ledger)
 *            ─► submit exactly once
 *            ─► wait for a validated ledger; judge the evidence
 * ```
 *
 * Uncertainty is never turned into a second payment: a throw during submit is
 * `submit-uncertain`, a wait that ends without a final answer is `unresolved`
 * (`unconfirmed`), and nothing in this module ever signs twice for one
 * `executionId` — the database refuses a second attempt row.
 */

export interface XrplTestnetTransportOptions {
  readonly configuration: XrplTestnetTransportConfigurationInput;
  /** The P0-07 settlement check bound to this deployment's profile. Required. */
  readonly settlementGate: XrplSettlementGate;
  readonly signer: XrplTransactionSigner;
  readonly attempts: XrplSubmissionAttemptStore;
  /** Opens a ledger connection. Defaults to the real `xrpl.Client` on the configured endpoint. */
  readonly connect?: (endpoint: string) => Promise<XrplLedgerClient>;
  readonly now?: () => number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  /** Structured, non-secret events. */
  readonly onEvent?: (event: XrplTransportEvent) => void;
}

export interface XrplTestnetTransport {
  submitPayment(submission: XrplPaymentSubmission): Promise<XrplSubmissionObservation>;
  /** Re-check a persisted attempt by its hash (manual recovery). Never signs or submits; settling the Frontera outcome stays with P12 resolution. */
  recheck(executionId: string): Promise<XrplSubmissionObservation>;
}

/** The only fields a prepared Payment may carry before signing. */
const PREPARED_FIELDS = new Set(['TransactionType', 'Account', 'Destination', 'Amount', 'Fee', 'Sequence', 'LastLedgerSequence', 'Flags', 'SigningPubKey']);

function isIssuedAmount(value: unknown): value is XrplIssuedAmount {
  if (typeof value !== 'object' || value === null) return false;
  const amount = value as Record<string, unknown>;
  return typeof amount['currency'] === 'string' && typeof amount['issuer'] === 'string' && typeof amount['value'] === 'string';
}

function sameIssuedAmount(observed: unknown, expected: XrplIssuedAmount): boolean {
  return isIssuedAmount(observed) && observed.currency === expected.currency && observed.issuer === expected.issuer && issuedValuesEqual(observed.value, expected.value);
}

function sleepFor(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function createXrplTestnetTransport(options: XrplTestnetTransportOptions): XrplTestnetTransport {
  const configuration = resolveXrplTestnetConfiguration(options.configuration);
  if (typeof options.settlementGate !== 'function') throw new XrplTransportConfigurationError('The XRPL transport needs the settlement gate.');
  if (options.signer?.account !== configuration.sourceAccount) throw new XrplTransportConfigurationError('The XRPL signer does not sign for the configured source account.');
  const { signer, attempts, settlementGate } = options;
  const connect = options.connect ?? connectXrplLedgerClient;
  const now = options.now ?? (() => Date.now());
  const sleep = options.sleep ?? sleepFor;
  const emit = (event: XrplTransportEvent) => {
    try {
      options.onEvent?.(event);
    } catch {
      // An observer can never change a payment.
    }
  };

  /** Every check that needs no network. Returns the issued amount, or a refusal reason. */
  function localChecks(submission: XrplPaymentSubmission): { readonly amount: XrplIssuedAmount } | { readonly refusal: string } {
    const { instruction } = submission;
    if (instruction?.TransactionType !== 'Payment') return { refusal: 'not-a-payment' };
    if (!isValidClassicAddress(instruction.Destination)) return { refusal: 'destination-invalid' };
    if (instruction.Destination === configuration.sourceAccount) return { refusal: 'destination-is-source' };
    if (!isIssuedAmount(instruction.Amount)) return { refusal: 'amount-not-issued' };
    if (instruction.Amount.issuer === configuration.sourceAccount) return { refusal: 'source-is-issuer' };
    if (submission.network !== configuration.networkLabel) return { refusal: 'network-mismatch' };
    for (const field of ['executionId', 'requestId', 'decisionId', 'notAfter'] as const) if (typeof submission[field] !== 'string' || submission[field].length === 0) return { refusal: 'correlation-missing' };
    if (Number.isNaN(Date.parse(submission.notAfter))) return { refusal: 'horizon-invalid' };
    return { amount: instruction.Amount };
  }

  /** The prepared transaction must be exactly the instruction plus the transport's own fields. */
  function preparedProblem(prepared: Record<string, unknown>, submission: XrplPaymentSubmission, amount: XrplIssuedAmount): string | undefined {
    for (const key of Object.keys(prepared)) if (!PREPARED_FIELDS.has(key)) return `unexpected-field:${key}`;
    if (prepared['TransactionType'] !== 'Payment') return 'type';
    if (prepared['Account'] !== configuration.sourceAccount) return 'account';
    if (prepared['Destination'] !== submission.instruction.Destination) return 'destination';
    const preparedAmount = prepared['Amount'];
    if (!isIssuedAmount(preparedAmount) || preparedAmount.currency !== amount.currency || preparedAmount.issuer !== amount.issuer || preparedAmount.value !== amount.value) return 'amount';
    if (prepared['Flags'] !== undefined && prepared['Flags'] !== 0) return 'flags';
    if (typeof prepared['Fee'] !== 'string' || !/^\d{1,12}$/.test(prepared['Fee']) || BigInt(prepared['Fee']) > configuration.maximumFeeDrops) return 'fee';
    if (!Number.isInteger(prepared['Sequence'])) return 'sequence';
    if (!Number.isInteger(prepared['LastLedgerSequence'])) return 'last-ledger-sequence';
    return undefined;
  }

  /** The signed blob must decode to exactly the prepared transaction and hash to the hash the signer returned. */
  function signedProblem(prepared: Record<string, unknown>, txBlob: string, hash: string): string | undefined {
    if (typeof txBlob !== 'string' || typeof hash !== 'string' || !/^[0-9A-F]{64}$/.test(hash)) return 'signer-output-malformed';
    let decoded: Record<string, unknown>;
    try {
      decoded = decode(txBlob) as Record<string, unknown>;
      if (hashes.hashSignedTx(txBlob) !== hash) return 'hash-mismatch';
    } catch {
      return 'blob-undecodable';
    }
    for (const key of ['TransactionType', 'Account', 'Destination', 'Fee', 'Sequence', 'LastLedgerSequence'] as const) if (decoded[key] !== prepared[key]) return `signed-${key}`;
    const signedAmount = decoded['Amount'];
    const preparedAmount = prepared['Amount'] as XrplIssuedAmount;
    if (!isIssuedAmount(signedAmount) || signedAmount.currency !== preparedAmount.currency || signedAmount.issuer !== preparedAmount.issuer || !issuedValuesEqual(signedAmount.value, preparedAmount.value)) return 'signed-Amount';
    if (decoded['NetworkID'] !== undefined) return 'signed-NetworkID';
    return undefined;
  }

  /** Judge a validated transaction against the persisted attempt. */
  function judge(record: XrplAttemptRecord, lookup: Extract<XrplTransactionLookup, { found: true }>): XrplSubmissionObservation {
    const { attempt } = record;
    const hash = attempt.transactionHash;
    const engineResult = typeof lookup.meta?.['TransactionResult'] === 'string' ? (lookup.meta['TransactionResult'] as string) : undefined;
    const ledgerIndex = lookup.ledgerIndex === undefined ? undefined : String(lookup.ledgerIndex);
    const evidence: Record<string, string> = { ...(ledgerIndex !== undefined ? { ledgerIndex } : {}), ...(engineResult !== undefined ? { engineResult } : {}), ...(lookup.closeTimeIso !== undefined ? { closeTimeIso: lookup.closeTimeIso } : {}) };
    const anomaly = (reason: string): XrplSubmissionObservation => {
      attempts.append(attempt.executionId, 'anomaly', { ...evidence, reason });
      emit({ event: 'xrpl.attempt.anomaly', executionId: attempt.executionId, transactionHash: hash, detail: reason });
      return { kind: 'unconfirmed', transactionHash: hash };
    };
    if (lookup.hash !== undefined && lookup.hash !== hash) return anomaly('hash-mismatch');
    if (engineResult === undefined) return anomaly('result-missing');
    if (engineResult.startsWith('tec')) {
      attempts.append(attempt.executionId, 'validated-tec', evidence);
      emit({ event: 'xrpl.attempt.validated-tec', executionId: attempt.executionId, transactionHash: hash, detail: engineResult });
      return { kind: 'rejected', transactionHash: hash, engineResult, ...(ledgerIndex !== undefined ? { ledgerIndex } : {}) };
    }
    if (engineResult !== 'tesSUCCESS') return anomaly('unexpected-result');
    const expected: XrplIssuedAmount = { currency: attempt.currency, issuer: attempt.issuer, value: attempt.value };
    const tx = lookup.transaction;
    if (tx['Account'] !== attempt.sourceAccount) return anomaly('account-mismatch');
    if (tx['Destination'] !== attempt.destination) return anomaly('destination-mismatch');
    if (!sameIssuedAmount(tx['DeliverMax'] ?? tx['Amount'], expected)) return anomaly('amount-mismatch');
    const delivered = lookup.meta?.['delivered_amount'];
    if (!sameIssuedAmount(delivered, expected)) return anomaly('delivered-amount-mismatch');
    if (lookup.closeTimeIso === undefined || Number.isNaN(Date.parse(lookup.closeTimeIso))) return anomaly('close-time-missing');
    if (Date.parse(lookup.closeTimeIso) > Date.parse(attempt.notAfter)) return anomaly('validated-after-grant-horizon');
    const deliveredAmount = delivered as XrplIssuedAmount;
    attempts.append(attempt.executionId, 'validated-success', { ...evidence, deliveredCurrency: deliveredAmount.currency, deliveredIssuer: deliveredAmount.issuer, deliveredValue: deliveredAmount.value });
    emit({ event: 'xrpl.attempt.validated', executionId: attempt.executionId, transactionHash: hash, detail: engineResult });
    return { kind: 'validated', transactionHash: hash, engineResult, ...(ledgerIndex !== undefined ? { ledgerIndex } : {}), deliveredAmount: { currency: deliveredAmount.currency, issuer: deliveredAmount.issuer, value: deliveredAmount.value } };
  }

  /** The persisted final answer, if the attempt already has one. */
  function finalFromRecord(record: XrplAttemptRecord): XrplSubmissionObservation | undefined {
    const last = record.events.at(-1);
    const hash = record.attempt.transactionHash;
    if (last === undefined || !TERMINAL_ATTEMPT_STATES.includes(last.state)) return undefined;
    const evidence = last.evidence ?? {};
    const ledger = { ...(evidence['ledgerIndex'] !== undefined ? { ledgerIndex: evidence['ledgerIndex'] } : {}), ...(evidence['engineResult'] !== undefined ? { engineResult: evidence['engineResult'] } : {}) };
    if (last.state === 'validated-success') {
      return { kind: 'validated', transactionHash: hash, ...ledger, deliveredAmount: { currency: evidence['deliveredCurrency'] ?? '', issuer: evidence['deliveredIssuer'] ?? '', value: evidence['deliveredValue'] ?? '' } };
    }
    if (last.state === 'validated-tec' || last.state === 'expired') return { kind: 'rejected', transactionHash: hash, ...ledger };
    return { kind: 'unconfirmed', transactionHash: hash };
  }

  /** Wait for a validated answer by hash. Never signs, never submits. */
  async function awaitFinal(client: XrplLedgerClient, record: XrplAttemptRecord): Promise<XrplSubmissionObservation> {
    const { attempt } = record;
    const deadline = now() + configuration.validationTimeoutMs;
    for (;;) {
      const lookup = await client.transaction(attempt.transactionHash, { minLedger: attempt.validatedLedgerAtPrepare, maxLedger: attempt.lastLedgerSequence });
      if (lookup.found && lookup.validated) return judge(record, lookup);
      if (!lookup.found) {
        const validated = await client.validatedLedgerIndex();
        if (validated > attempt.lastLedgerSequence && lookup.searchedAll) {
          attempts.append(attempt.executionId, 'expired', { validatedLedger: String(validated) });
          emit({ event: 'xrpl.attempt.expired', executionId: attempt.executionId, transactionHash: attempt.transactionHash });
          return { kind: 'rejected', transactionHash: attempt.transactionHash };
        }
      }
      if (now() >= deadline) {
        attempts.append(attempt.executionId, 'unresolved');
        emit({ event: 'xrpl.attempt.unresolved', executionId: attempt.executionId, transactionHash: attempt.transactionHash });
        return { kind: 'unconfirmed', transactionHash: attempt.transactionHash };
      }
      await sleep(configuration.pollIntervalMs);
    }
  }

  async function recheckRecord(record: XrplAttemptRecord): Promise<XrplSubmissionObservation> {
    const final = finalFromRecord(record);
    if (final !== undefined) return final;
    let client: XrplLedgerClient;
    try {
      client = await connect(configuration.endpoint);
    } catch {
      return { kind: 'unconfirmed', transactionHash: record.attempt.transactionHash };
    }
    try {
      const info = await client.serverInfo();
      if (info.networkId !== configuration.expectedNetworkId) return { kind: 'unconfirmed', transactionHash: record.attempt.transactionHash };
      return await awaitFinal(client, record);
    } catch {
      return { kind: 'unconfirmed', transactionHash: record.attempt.transactionHash };
    } finally {
      await client.disconnect().catch(() => {});
    }
  }

  async function submitPayment(submission: XrplPaymentSubmission): Promise<XrplSubmissionObservation> {
    const refuse = (reason: string): XrplSubmissionObservation => {
      emit({ event: 'xrpl.submission.refused', ...(typeof submission?.executionId === 'string' ? { executionId: submission.executionId } : {}), detail: reason });
      return { kind: 'not-submitted' };
    };
    // 1. Settlement (P0-07) and local checks: no network, no signature.
    let gate: ReturnType<XrplSettlementGate>;
    try {
      gate = settlementGate(submission);
    } catch {
      return refuse('settlement-gate-error');
    }
    if (!gate.ok) return refuse(`settlement:${gate.refusal}`);
    const local = localChecks(submission);
    if ('refusal' in local) return refuse(local.refusal);
    const { amount } = local;

    // 2. An existing attempt is reconciled, never re-signed.
    const existing = attempts.find(submission.executionId);
    if (existing !== undefined) {
      emit({ event: 'xrpl.attempt.existing', executionId: submission.executionId, transactionHash: existing.attempt.transactionHash });
      return recheckRecord(existing);
    }

    // 3. Enough grant lifetime left to finish inside it.
    if (Date.parse(submission.notAfter) - now() < configuration.minimumGrantRemainingMs) return refuse('grant-lifetime-insufficient');

    // 4. Connect and prove the network.
    let client: XrplLedgerClient;
    try {
      client = await connect(configuration.endpoint);
    } catch {
      return refuse('connect-failed');
    }
    let persisted: XrplAttemptRecord | undefined;
    try {
      let validatedLedger: number;
      let prepared: Record<string, unknown>;
      try {
        const info = await client.serverInfo();
        if (info.networkId !== configuration.expectedNetworkId) return refuse('network-id-mismatch');
        validatedLedger = await client.validatedLedgerIndex();
        if (!Number.isInteger(validatedLedger) || validatedLedger <= 0) return refuse('validated-ledger-unknown');
        // 5. Prepare: the transport supplies Account, Fee, Sequence and LastLedgerSequence; nothing from the request.
        prepared = await client.autofill({ TransactionType: 'Payment', Account: configuration.sourceAccount, Destination: submission.instruction.Destination, Amount: { ...amount } });
        prepared['LastLedgerSequence'] = validatedLedger + configuration.ledgerHorizon;
      } catch {
        return refuse('prepare-failed');
      }
      const problem = preparedProblem(prepared, submission, amount);
      if (problem !== undefined) return refuse(`prepared:${problem}`);

      // 6. Sign, and verify the signer signed exactly that.
      let signed: { readonly txBlob: string; readonly hash: string };
      try {
        signed = await signer.sign(prepared);
      } catch {
        return refuse('signer-failed');
      }
      const signedIssue = signedProblem(prepared, signed.txBlob, signed.hash);
      if (signedIssue !== undefined) return refuse(`signed:${signedIssue}`);

      // 7. DURABLY persist before the network sees anything.
      const attempt: XrplSubmissionAttempt = {
        executionId: submission.executionId,
        requestId: submission.requestId,
        decisionId: submission.decisionId,
        network: configuration.networkLabel,
        sourceAccount: configuration.sourceAccount,
        destination: submission.instruction.Destination,
        currency: amount.currency,
        issuer: amount.issuer,
        value: amount.value,
        fee: prepared['Fee'] as string,
        sequence: prepared['Sequence'] as number,
        lastLedgerSequence: prepared['LastLedgerSequence'] as number,
        transactionHash: signed.hash,
        validatedLedgerAtPrepare: validatedLedger,
        notAfter: submission.notAfter,
        createdAt: new Date(now()).toISOString(),
      };
      try {
        attempts.record(attempt, signed.txBlob);
        persisted = attempts.find(attempt.executionId);
      } catch {
        return refuse('persist-failed');
      }
      if (persisted === undefined) return refuse('persist-failed');
      emit({ event: 'xrpl.attempt.persisted', executionId: attempt.executionId, transactionHash: attempt.transactionHash });

      // 8. Submit exactly once. A throw here may have reached the network.
      try {
        const result = await client.submit(signed.txBlob);
        attempts.append(attempt.executionId, 'submitted', result.engineResult !== undefined ? { preliminaryResult: result.engineResult } : undefined);
        emit({ event: 'xrpl.attempt.submitted', executionId: attempt.executionId, transactionHash: attempt.transactionHash, ...(result.engineResult !== undefined ? { detail: result.engineResult } : {}) });
      } catch {
        attempts.append(attempt.executionId, 'submit-uncertain');
        emit({ event: 'xrpl.attempt.submit-uncertain', executionId: attempt.executionId, transactionHash: attempt.transactionHash });
      }

      // 9. Only a validated ledger answers.
      return await awaitFinal(client, attempts.find(attempt.executionId) ?? persisted);
    } catch {
      // After persistence, every failure is uncertainty, never a failure the caller could safely retry.
      if (persisted !== undefined) {
        try {
          attempts.append(persisted.attempt.executionId, 'unresolved');
        } catch {
          // The attempt row already exists; reconciliation will find it.
        }
        return { kind: 'unconfirmed', transactionHash: persisted.attempt.transactionHash };
      }
      return refuse('transport-error');
    } finally {
      await client.disconnect().catch(() => {});
    }
  }

  return Object.freeze({
    submitPayment,
    async recheck(executionId: string) {
      const record = attempts.find(executionId);
      return record === undefined ? { kind: 'not-submitted' as const } : recheckRecord(record);
    },
  });
}
