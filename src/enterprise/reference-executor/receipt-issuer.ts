import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { join } from 'node:path';

import type { ExecutionCapabilityConsumptionDetail, ExecutionCapabilityConsumptionLedger } from '../execution-capability/reference/consumption-ledger.js';
import { EXECUTOR_RECEIPT_FORMAT, EXECUTOR_RECEIPT_OBSERVATION_KIND, type ExecutorReceiptBasis, type ExecutorReceiptDraft, type ExecutorReceiptLedgerState, type ExecutorReceiptObservation, type ExecutorReceiptOutcome } from '../executor-receipt/index.js';
import type { ReferenceExecutorFaultPoint } from './configuration.js';
import { ExecutorReceiptConflictError, type ExecutorReceiptLedger, type IssuedExecutorReceipt } from './receipt-ledger.js';
import type { ExecutorReceiptSigner } from './receipt-signer.js';

/**
 * G-02C1C — issues the executor's signed receipt for one consumption, **from
 * durable state only**.
 *
 * ```
 * read      the G-02A consumption detail (absent: no consumption, no receipt)
 * map       ledger state (+ the execution path's own observation, if it has one) → outcome
 * evidence  completed only with the synthetic record that names this capability and binding
 * reserve   the receipt ledger fixes the whole canonical text and its position (IMMEDIATE)
 * sign      the receipt signer, over the reserved text only
 * issue     the signature recorded; the issued receipt returned
 * ```
 *
 * It never runs the effect, never claims, never records a consumption outcome,
 * and never answers a request: a receipt is a statement about what already
 * happened. Run again — after a crash, a lost receipt, a restart — it returns
 * the same receipt, signed again byte for byte if the signature was never
 * recorded.
 *
 * ## The outcome mapping
 *
 * | Ledger state | Execution-path observation | Receipt outcome | Kind |
 * |---|---|---|---|
 * | `completed` | (whatever it saw) | `completed-observed`, with the synthetic record's digest | exact |
 * | `failed` | `failed-observed` or `consumed-not-attempted` | that outcome (`basis: execution-path`) | exact |
 * | `failed` | none (recovery) | `attempted-outcome-unknown` (`basis: durable-state`) | conservative: the ledger does not say why |
 * | `outcome-unknown` | (whatever it saw) | `attempted-outcome-unknown` | exact |
 * | `claimed` | (whatever it saw) | `attempted-outcome-unknown` | conservative: an attempt may or may not have begun |
 * | absent | — | no receipt (`NOT_CONSUMED`) | unavailable |
 *
 * `completed` is never inferred from a claim, and never stated without the
 * record the effect wrote.
 */

export type ExecutorReceiptIssuance =
  | { readonly status: 'issued'; readonly receipt: IssuedExecutorReceipt; readonly sequence: number; readonly outcome: ExecutorReceiptOutcome }
  | { readonly status: 'refused'; readonly code: 'NOT_CONSUMED' | 'CONSUMPTION_UNAVAILABLE' | 'EVIDENCE_UNAVAILABLE' | 'RECEIPT_CONFLICT' | 'RECEIPT_LEDGER_UNAVAILABLE' | 'SIGNING_FAILED' };

/** What the execution path itself observed, when it is the one asking. */
export type ExecutionPathObservation = 'completed-observed' | 'failed-observed' | 'consumed-not-attempted' | 'attempted-outcome-unknown';

export interface ExecutorReceiptIssuer {
  issue(capabilityId: string, observed?: ExecutionPathObservation): ExecutorReceiptIssuance;
}

/** The receipt outcome a ledger state supports, refined only where the execution path saw more than the ledger keeps. */
export function receiptOutcomeFor(ledgerState: ExecutorReceiptLedgerState, observed?: ExecutionPathObservation): { readonly outcome: ExecutorReceiptOutcome; readonly basis: ExecutorReceiptBasis } {
  if (ledgerState === 'completed') return { outcome: 'completed-observed', basis: 'durable-state' };
  if (ledgerState === 'failed') {
    const precise = observed === 'failed-observed' || observed === 'consumed-not-attempted';
    return precise ? { outcome: observed, basis: 'execution-path' } : { outcome: 'attempted-outcome-unknown', basis: 'durable-state' };
  }
  return { outcome: 'attempted-outcome-unknown', basis: 'durable-state' };
}

const CAPABILITY_ID = /^[0-9a-f]{64}$/;
const RECORD_MAXIMUM_BYTES = 4_096;

/** The synthetic record for `detail`, as evidence: present, a regular file, naming this capability, execution and binding. */
function syntheticEvidence(outputDirectory: string, detail: Extract<ExecutionCapabilityConsumptionDetail, { readonly capabilityId: string }>): ExecutorReceiptObservation | undefined {
  if (!CAPABILITY_ID.test(detail.capabilityId)) return undefined;
  const reference = `${detail.capabilityId}.json`;
  let fd: number | undefined;
  try {
    fd = openSync(join(outputDirectory, reference), constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size === 0 || stat.size > RECORD_MAXIMUM_BYTES) return undefined;
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (read === 0) return undefined;
      offset += read;
    }
    const record = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>;
    const matches = record['format'] === EXECUTOR_RECEIPT_OBSERVATION_KIND && record['capabilityId'] === detail.capabilityId && record['executionId'] === detail.executionId && record['bindingDigest'] === detail.actionBindingDigest && record['observed'] === 'applied';
    if (!matches) return undefined;
    return Object.freeze({ kind: EXECUTOR_RECEIPT_OBSERVATION_KIND, reference, digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}` });
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Nothing to recover: the evidence was already read or refused.
      }
    }
  }
}

export function createExecutorReceiptIssuer(options: {
  readonly executorId: string;
  readonly audience: string;
  /** The one binding format this executor verifies before every claim: the ledger keeps the digest, not the format. */
  readonly bindingFormat: string;
  readonly consumption: ExecutionCapabilityConsumptionLedger;
  readonly receipts: ExecutorReceiptLedger;
  readonly signer: ExecutorReceiptSigner;
  readonly outputDirectory: string;
  readonly fault?: (point: ReferenceExecutorFaultPoint) => void;
}): ExecutorReceiptIssuer {
  const { executorId, audience, bindingFormat, consumption, receipts, signer, outputDirectory } = options;
  if (consumption.audience !== audience || receipts.audience !== audience || receipts.executorId !== executorId || signer.executorId !== executorId) {
    throw new Error('The receipt issuer needs one executor and one audience across its ledgers and its signer.');
  }
  const fault = options.fault ?? (() => undefined);

  function issue(capabilityId: string, observed?: ExecutionPathObservation): ExecutorReceiptIssuance {
    const refused = (code: Extract<ExecutorReceiptIssuance, { status: 'refused' }>['code']): ExecutorReceiptIssuance => Object.freeze({ status: 'refused' as const, code });
    fault('before-receipt');

    // ── durable state, read, never changed ──
    let detail: ExecutionCapabilityConsumptionDetail;
    try {
      detail = consumption.readDetail(capabilityId);
    } catch {
      return refused('CONSUMPTION_UNAVAILABLE');
    }
    if (detail.state === 'absent') return refused('NOT_CONSUMED');

    const { outcome, basis } = receiptOutcomeFor(detail.state, observed);
    let observation: ExecutorReceiptObservation | null = null;
    if (outcome === 'completed-observed') {
      const evidence = syntheticEvidence(outputDirectory, detail);
      if (evidence === undefined) return refused('EVIDENCE_UNAVAILABLE');
      observation = evidence;
    }
    const draft: ExecutorReceiptDraft = Object.freeze({
      format: EXECUTOR_RECEIPT_FORMAT,
      executorId,
      executorKeyId: signer.keyId,
      issuer: detail.issuer,
      capabilityId: detail.capabilityId,
      executionId: detail.executionId,
      audience,
      organizationId: detail.organizationId,
      trustDomain: detail.trustDomain,
      actionBinding: Object.freeze({ format: bindingFormat, digest: detail.actionBindingDigest }),
      consumption: Object.freeze({ claimedAt: detail.claimedAt, ledgerState: detail.state }),
      outcome,
      basis,
      // The instant of the durable fact: the outcome's record time, or the claim time while none was recorded.
      observedAt: detail.outcomeRecordedAt ?? detail.claimedAt,
      observation,
    });
    fault('after-receipt-construction');

    // ── the position and the text, fixed before anyone signs ──
    let reservation: ReturnType<ExecutorReceiptLedger['reserve']>;
    try {
      reservation = receipts.reserve(draft);
    } catch (error) {
      return refused(error instanceof ExecutorReceiptConflictError ? 'RECEIPT_CONFLICT' : 'RECEIPT_LEDGER_UNAVAILABLE');
    }
    fault('after-receipt-reservation');
    if (reservation.state === 'issued' && reservation.signature !== null) {
      return Object.freeze({ status: 'issued' as const, receipt: Object.freeze({ receipt: reservation.canonical, signature: reservation.signature }), sequence: reservation.sequence, outcome: reservation.receipt.outcome });
    }

    // ── sign the reserved text (deterministic: a retry reproduces the same signature) ──
    let signature: Readonly<Record<string, string>>;
    try {
      signature = signer.signExecutorReceipt(reservation);
    } catch {
      return refused('SIGNING_FAILED');
    }
    fault('after-receipt-signature');

    let issued: ReturnType<ExecutorReceiptLedger['issue']>;
    try {
      issued = receipts.issue(reservation, signature);
    } catch (error) {
      return refused(error instanceof ExecutorReceiptConflictError ? 'RECEIPT_CONFLICT' : 'RECEIPT_LEDGER_UNAVAILABLE');
    }
    fault('after-receipt');
    return Object.freeze({ status: 'issued' as const, receipt: Object.freeze({ receipt: issued.canonical, signature: issued.signature as Readonly<Record<string, string>> }), sequence: issued.sequence, outcome: issued.receipt.outcome });
  }

  return Object.freeze({ issue });
}
