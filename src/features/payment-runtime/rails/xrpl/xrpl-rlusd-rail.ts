import { EXECUTION_FAILURE_REASONS, type ExecutionFailureReason } from '../../../execution-runtime/index.js';
import type { PaymentExecutionRequest, PaymentRail, PaymentRailResult } from '../../domain/index.js';
import { isXrplClassicAddress } from './xrpl-address.js';
import { signedPaymentMatches } from './xrpl-codec.js';
import { XrplRailConfigurationError, isXrplRlusdRailConfiguration, type XrplRlusdRailConfiguration } from './xrpl-config.js';
import { XrplSubmissionNotAttemptedError, type XrplClientPort, type XrplPaymentTransaction, type XrplPreparedPayment, type XrplTransactionSigner } from './xrpl-client-port.js';
import { buildXrplPayment } from './xrpl-payment-builder.js';
import { XRPL_RAIL_DETAILS, type XrplRailDetail } from './xrpl-rail-details.js';
import { readAutofill, readLedgerIndex, readLookup, readNetworkId, readSubmission, type XrplExpectedPayment } from './xrpl-result-normalizer.js';

/**
 * A logger the host bridges to its own — structurally a subset of the
 * Enterprise `EnterpriseLogger`, so one can be passed as-is. The rail logs
 * only bounded, non-secret fields: the rail id, the execution id, the
 * transaction hash, an engine result code and a detail token. Never a signed
 * blob, an address, an amount, an endpoint or anything a signer holds.
 */
export interface XrplRailLogger {
  info(message: string, fields?: Readonly<Record<string, unknown>>): void;
  warn(message: string, fields?: Readonly<Record<string, unknown>>): void;
}

export interface XrplRlusdRailOptions {
  readonly configuration: XrplRlusdRailConfiguration;
  readonly client: XrplClientPort;
  /** Exactly one signer per mapped source account, and no other. */
  readonly signers: readonly XrplTransactionSigner[];
  readonly logger?: XrplRailLogger;
  /** Injected for deterministic qualification; default the process clock and timers. */
  readonly now?: () => number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

export type XrplRailReadiness = { readonly status: 'ready' } | { readonly status: 'unavailable'; readonly detail: XrplRailDetail };

/** A `PaymentRail`, plus the rail's own lifecycle: readiness (connect and verify the network) and close. */
export interface XrplRlusdRail extends PaymentRail {
  readiness(): Promise<XrplRailReadiness>;
  close(): Promise<void>;
}

const F = EXECUTION_FAILURE_REASONS;
const D = XRPL_RAIL_DETAILS;

/** Thrown inside `execute` to leave the pre-submission phase with a definitive refusal. Never escapes the rail. */
class Refusal {
  constructor(
    readonly reason: ExecutionFailureReason,
    readonly detail: XrplRailDetail,
  ) {}
}

/**
 * The XRPL / RLUSD payment rail (PAY-02).
 *
 * A `PaymentRail`, composed by the host through PAY-01's
 * `createPaymentRailExecutionAdapter` and reachable no other way: it receives
 * a `PaymentExecutionRequest` only after Frontera decided, granted, reserved
 * and claimed the execution. It decides nothing — no policy, approval, limit
 * or emergency check — and translates one granted payment into at most one
 * XRPL submission.
 *
 * ## Per execution
 *
 * ```
 * build      buildXrplPayment — asset, source mapping, destination, amount     refusal → not-completed (nothing contacted)
 * connect    client.connect + server network_id == configured network        failure → not-completed (nothing submitted)
 * prepare    LastLedgerSequence = validated index + trusted offset; autofill
 *            Sequence / Fee; fee ≤ trusted ceiling; Sequence not held by an
 *            earlier, still-unconfirmed payment from the same account        failure → not-completed (nothing submitted)
 * sign       signer.sign; the blob must sign exactly the prepared payment      failure → not-completed (nothing submitted)
 * submit     client.submit, ONCE                                              see below
 * finality   tx lookups until validated, expired, or the finality deadline     see below
 * ```
 *
 * Payments from one source account run one at a time, preparation through
 * finality (`serialized`).
 *
 * ## Outcome
 *
 * | what is known | `PaymentRailResult` |
 * | --- | --- |
 * | validated `tesSUCCESS`, delivered exactly the granted amount | `completed`, ref = tx hash |
 * | validated `tec…` | `not-completed` `PROVIDER_REJECTED`, detail = the engine code |
 * | submit answered `tem…` (malformed: never applied, never can be) | `not-completed` `PROVIDER_REJECTED`, detail = the engine code |
 * | not in any ledger ≤ `LastLedgerSequence`, which is validated, complete history | `not-completed` `PROVIDER_REJECTED`, `xrpl-transaction-expired` |
 * | submission provably not attempted (no open connection) | `not-completed` `PROVIDER_UNAVAILABLE` |
 * | submit threw (timeout, reset) after the blob may have been written | `unconfirmed`, ref = tx hash |
 * | submit answer unreadable | `unconfirmed`, ref = tx hash |
 * | no validated result by the finality deadline | `unconfirmed`, ref = tx hash |
 * | validated success but delivered ≠ granted, or an unrecognized validated result | `unconfirmed`, ref = tx hash |
 *
 * The hash is computed by signing, **before** submission, so every outcome
 * after submission carries it — which is what an operator resolving an
 * `unconfirmed` payment through P12 looks up.
 *
 * ## No retry
 *
 * `client.submit` is called from exactly one place, at most once per
 * `execute`. Lookups after it are reads. Nothing resubmits, re-signs or
 * prepares a second transaction for the same execution, whatever happens.
 */
export function createXrplRlusdRail(options: XrplRlusdRailOptions): XrplRlusdRail {
  const configuration = options?.configuration;
  if (!isXrplRlusdRailConfiguration(configuration)) {
    throw new XrplRailConfigurationError('configuration', 'must come from createXrplRlusdRailConfiguration');
  }
  const client = options.client;
  for (const method of ['connect', 'disconnect', 'serverInfo', 'validatedLedgerIndex', 'autofill', 'submit', 'lookupTransaction'] as const) {
    if (typeof client?.[method] !== 'function') throw new XrplRailConfigurationError('client', `must implement ${method}`);
  }
  const signers = new Map<string, XrplTransactionSigner['sign']>();
  const supplied: unknown = options.signers;
  if (!Array.isArray(supplied)) throw new XrplRailConfigurationError('signers', 'must be a list');
  for (const [index, signer] of (supplied as readonly XrplTransactionSigner[]).entries()) {
    const address: unknown = signer?.address;
    const sign: unknown = signer?.sign;
    if (!isXrplClassicAddress(address) || typeof sign !== 'function') throw new XrplRailConfigurationError(`signers[${index}]`, 'must have a classic address and a sign function');
    if (!configuration.sourceAccounts.some((mapping) => mapping.address === address)) throw new XrplRailConfigurationError(`signers[${index}]`, 'signs for an account no source mapping names');
    if (signers.has(address)) throw new XrplRailConfigurationError(`signers[${index}]`, 'duplicates another signer');
    signers.set(address, (transaction) => (sign as XrplTransactionSigner['sign']).call(signer, transaction));
  }
  for (const mapping of configuration.sourceAccounts) {
    if (!signers.has(mapping.address)) throw new XrplRailConfigurationError('signers', `no signer for source account '${mapping.accountId}'`);
  }
  const now = options.now ?? (() => Date.now());
  const sleep = options.sleep ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const logger = options.logger;
  const railId = configuration.railId;

  /**
   * One payment at a time per source account, held from preparation **through
   * finality**, so two payments never autofill the same `Sequence` in this
   * process: until the first is validated or expired, the next one's autofill
   * could still see the old account sequence (review P1).
   */
  const sourceQueues = new Map<string, Promise<unknown>>();
  function serialized<T>(account: string, work: () => Promise<T>): Promise<T> {
    const previous = sourceQueues.get(account) ?? Promise.resolve();
    const next = previous.then(work, work);
    const settled = next.then(
      () => undefined,
      () => undefined,
    );
    sourceQueues.set(account, settled);
    void settled.then(() => {
      if (sourceQueues.get(account) === settled) sourceQueues.delete(account);
    });
    return next;
  }

  /**
   * Per source account: the sequence and `LastLedgerSequence` of the last
   * submission whose outcome is still `unconfirmed`. Until the ledger has
   * validated that `LastLedgerSequence`, that transaction may still be
   * included, so a new payment autofilled with the same (or a lower)
   * `Sequence` would compete with it — exactly one of the two could validate.
   * Such a payment is refused **before** it is signed (review P1).
   */
  const unresolved = new Map<string, { readonly sequence: number; readonly lastLedgerSequence: number }>();

  const log = (level: 'info' | 'warn', event: string, fields: Readonly<Record<string, unknown>>): void => {
    try {
      logger?.[level](event, { railId, ...fields });
    } catch {
      // A logger defect never changes a payment outcome.
    }
  };

  async function ensureConnected(): Promise<XrplRailReadiness> {
    try {
      await client.connect();
    } catch {
      return { status: 'unavailable', detail: D.NETWORK_UNAVAILABLE };
    }
    let info: unknown;
    try {
      info = await client.serverInfo();
    } catch {
      return { status: 'unavailable', detail: D.NETWORK_UNAVAILABLE };
    }
    return readNetworkId(info) === configuration.networkId ? { status: 'ready' } : { status: 'unavailable', detail: D.NETWORK_MISMATCH };
  }

  /** Everything before the one submission. Throws `Refusal` only; nothing here has written to the ledger. */
  async function prepareAndSign(request: PaymentExecutionRequest, transaction: Omit<XrplPaymentTransaction, 'LastLedgerSequence'>): Promise<{ readonly prepared: XrplPreparedPayment; readonly signedTransaction: string; readonly hash: string; readonly minLedger: number }> {
    const readiness = await ensureConnected();
    if (readiness.status !== 'ready') throw new Refusal(readiness.detail === D.NETWORK_MISMATCH ? F.ADAPTER_ERROR : F.PROVIDER_UNAVAILABLE, readiness.detail);

    let validated: number | undefined;
    try {
      validated = readLedgerIndex(await client.validatedLedgerIndex());
    } catch {
      throw new Refusal(F.PROVIDER_UNAVAILABLE, D.PREPARATION_FAILED);
    }
    if (validated === undefined) throw new Refusal(F.PROVIDER_RESPONSE_INVALID, D.PREPARATION_INVALID);
    const built: XrplPaymentTransaction = Object.freeze({ ...transaction, LastLedgerSequence: validated + configuration.lastLedgerOffset });

    let filled: unknown;
    try {
      filled = await client.autofill(built);
    } catch {
      throw new Refusal(F.PROVIDER_UNAVAILABLE, D.PREPARATION_FAILED);
    }
    const autofilled = readAutofill(filled, built as unknown as Readonly<Record<string, unknown>>);
    if (autofilled === undefined) throw new Refusal(F.PROVIDER_RESPONSE_INVALID, D.PREPARATION_INVALID);
    if (BigInt(autofilled.Fee) > BigInt(configuration.maxFeeDrops)) throw new Refusal(F.PROVIDER_REJECTED, D.FEE_CEILING_EXCEEDED);
    const inFlight = unresolved.get(built.Account);
    if (inFlight !== undefined) {
      // Once its LastLedgerSequence is validated, the earlier transaction is final either way and its sequence is settled.
      if (validated >= inFlight.lastLedgerSequence) unresolved.delete(built.Account);
      else if (autofilled.Sequence <= inFlight.sequence) throw new Refusal(F.PROVIDER_UNAVAILABLE, D.SEQUENCE_IN_FLIGHT);
    }
    const prepared: XrplPreparedPayment = Object.freeze({ ...built, Sequence: autofilled.Sequence, Fee: autofilled.Fee });
    log('info', 'xrpl.payment.prepared', { executionId: request.executionId });

    const sign = signers.get(prepared.Account);
    if (sign === undefined) throw new Refusal(F.ADAPTER_ERROR, D.SIGNING_FAILED);
    let signed: { readonly signedTransaction: unknown; readonly hash: unknown };
    try {
      const answer: unknown = await sign(prepared);
      if (answer === null || typeof answer !== 'object') throw new Refusal(F.ADAPTER_ERROR, D.SIGNING_FAILED);
      const { signedTransaction, hash } = answer as { readonly signedTransaction?: unknown; readonly hash?: unknown };
      signed = { signedTransaction, hash };
    } catch (error) {
      throw error instanceof Refusal ? error : new Refusal(F.ADAPTER_ERROR, D.SIGNING_FAILED);
    }
    if (!signedPaymentMatches(prepared, signed)) throw new Refusal(F.ADAPTER_ERROR, D.SIGNATURE_MISMATCH);
    return { prepared, signedTransaction: signed.signedTransaction, hash: signed.hash, minLedger: validated + 1 };
  }

  /** After the one submission: wait for a validated answer or the deadline. Reads only. */
  async function awaitFinality(request: PaymentExecutionRequest, expected: XrplExpectedPayment, window: { readonly minLedger: number; readonly maxLedger: number }): Promise<PaymentRailResult> {
    const deadline = now() + configuration.finalityTimeoutMs;
    const reference = { externalReference: expected.hash };
    while (now() < deadline) {
      await sleep(configuration.pollIntervalMs);
      let validatedIndex: number | undefined;
      let reading: ReturnType<typeof readLookup>;
      try {
        // The validated index is read FIRST: if it is already past the window, every ledger the lookup searches was validated before it ran.
        validatedIndex = readLedgerIndex(await client.validatedLedgerIndex());
        reading = readLookup(await client.lookupTransaction({ hash: expected.hash, ...window }), expected);
      } catch {
        continue; // a failed read is not an outcome; read again until the deadline
      }
      switch (reading.kind) {
        case 'validated-success':
          log('info', 'xrpl.payment.completed', { executionId: request.executionId, transactionHash: expected.hash });
          return { status: 'completed', ...reference };
        case 'validated-failure':
          log('warn', 'xrpl.payment.failed', { executionId: request.executionId, transactionHash: expected.hash, engineResult: reading.engineResult });
          return { status: 'not-completed', reason: F.PROVIDER_REJECTED, ...reference, detail: reading.engineResult };
        case 'validated-delivered-mismatch':
          return unconfirmed(request, expected.hash, D.DELIVERED_AMOUNT_MISMATCH);
        case 'validated-unrecognized':
          return unconfirmed(request, expected.hash, D.RESULT_UNRECOGNIZED);
        case 'not-found-complete':
          // Validated through and including LastLedgerSequence, and absent from every ledger in the window: never included, never can be.
          if (validatedIndex !== undefined && validatedIndex >= window.maxLedger) {
            log('warn', 'xrpl.payment.failed', { executionId: request.executionId, transactionHash: expected.hash, detail: D.TRANSACTION_EXPIRED });
            return { status: 'not-completed', reason: F.PROVIDER_REJECTED, ...reference, detail: D.TRANSACTION_EXPIRED };
          }
          continue;
        case 'pending':
        case 'unreadable':
          continue;
      }
    }
    return unconfirmed(request, expected.hash, D.FINALITY_UNKNOWN);
  }

  function unconfirmed(request: PaymentExecutionRequest, hash: string, detail: XrplRailDetail): PaymentRailResult {
    log('warn', 'xrpl.payment.unconfirmed', { executionId: request.executionId, transactionHash: hash, detail });
    return { status: 'unconfirmed', externalReference: hash, detail };
  }

  /**
   * The one submission, then finality. Never throws, except to report that the
   * client proved nothing was sent; every other failure from here on is
   * `unconfirmed`, because the blob may have reached the network.
   */
  async function submitOnceAndAwait(request: PaymentExecutionRequest, signed: { readonly prepared: XrplPreparedPayment; readonly signedTransaction: string; readonly hash: string; readonly minLedger: number }): Promise<PaymentRailResult> {
    let answer: unknown;
    try {
      answer = await client.submit(signed.signedTransaction);
    } catch (error) {
      if (error instanceof XrplSubmissionNotAttemptedError) throw new Refusal(F.PROVIDER_UNAVAILABLE, D.SUBMISSION_NOT_ATTEMPTED);
      return unconfirmed(request, signed.hash, D.SUBMISSION_OUTCOME_UNKNOWN);
    }
    try {
      const submission = readSubmission(answer, signed.hash);
      if (submission.kind === 'unreadable') return unconfirmed(request, signed.hash, D.SUBMISSION_RESPONSE_UNREADABLE);
      log('info', 'xrpl.payment.submitted', { executionId: request.executionId, transactionHash: signed.hash, engineResult: submission.engineResult });
      if (submission.kind === 'malformed') {
        log('warn', 'xrpl.payment.failed', { executionId: request.executionId, transactionHash: signed.hash, engineResult: submission.engineResult });
        return { status: 'not-completed', reason: F.PROVIDER_REJECTED, externalReference: signed.hash, detail: submission.engineResult };
      }
      const amount = signed.prepared.Amount;
      return await awaitFinality(request, { hash: signed.hash, currency: amount.currency, issuer: amount.issuer, value: amount.value }, { minLedger: signed.minLedger, maxLedger: signed.prepared.LastLedgerSequence });
    } catch {
      return unconfirmed(request, signed.hash, D.RAIL_ERROR_AFTER_SUBMISSION);
    }
  }

  async function execute(request: PaymentExecutionRequest): Promise<PaymentRailResult> {
    const build = buildXrplPayment(request, configuration);
    if (!build.built) return { status: 'not-completed', reason: F.ADAPTER_ERROR, detail: build.detail };
    const transaction = build.transaction;
    const account = transaction.Account;
    try {
      return await serialized(account, async () => {
        const signed = await prepareAndSign(request, transaction);
        // ─── the one submission, and its finality, still inside the account's queue ───
        const outcome = await submitOnceAndAwait(request, signed);
        if (outcome.status === 'unconfirmed') unresolved.set(account, { sequence: signed.prepared.Sequence, lastLedgerSequence: signed.prepared.LastLedgerSequence });
        return outcome;
      });
    } catch (error) {
      // Reached only before anything was submitted: a refusal or fault in preparation, or a client that proved nothing was sent.
      const refusal = error instanceof Refusal ? error : new Refusal(F.ADAPTER_ERROR, D.RAIL_ERROR_BEFORE_SUBMISSION);
      log('warn', 'xrpl.payment.failed', { executionId: request.executionId, detail: refusal.detail });
      return { status: 'not-completed', reason: refusal.reason, detail: refusal.detail };
    }
  }

  return Object.freeze({
    railId,
    execute,
    async readiness(): Promise<XrplRailReadiness> {
      return ensureConnected();
    },
    async close(): Promise<void> {
      await client.disconnect();
    },
  });
}
