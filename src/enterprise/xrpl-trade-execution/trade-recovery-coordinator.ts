import { createXrplValidatedLedgerReader, type XrplReadTimer, type XrplValidatedLedgerReader } from '../../features/xrpl-transport/index.js';
import { AuthorityStateFreshnessError } from '../authority-state-freshness/errors.js';
import { TradeInterlockStoreError, type TradeIntentRecord, type TradeSubmissionRecord } from './sqlite-trade-sequence-interlock.js';
import { readTradeLedgerEvidence, type TradeLedgerEvidence, type TradeLedgerReader } from './trade-ledger-evidence.js';
import { assessTradeOfferState, readOfferCreateEffect, readTradeOfferSnapshot, type TradeOfferStateAssessment } from './trade-offer-state.js';
import {
  assessTradeRecovery,
  type TradeInterlockObservation,
  type TradeRecoveryAssessment,
  type TradeRecoveryEvidenceNeeded,
  type TradeRecoveryP11View,
  type TradeRecoveryRefusal,
  type TradeRecoveryUncertainty,
  type TradeSignerObservation,
} from './trade-recovery-assessment.js';
import { tradeTransactionIdentityOf } from './trade-resolution-authority.js';
import { readTradeSequenceEvidence, type TradeSequenceEvidence } from './trade-sequence-evidence.js';

/**
 * TRADE-04D — the **recovery coordinator**: reads, never writes.
 *
 * ```
 * assess(executionId, { p11?, signer? })
 *   → interlock.read (+ readIntent, D-1)  corrupt / stale / unreadable → fail closed (indeterminate or inconsistent)
 *   → no reservation, an intent:          the owner's validated AccountRoot Sequence (D-1 non-inclusion proof)
 *   → validated evidence for the row's    network ×2, validated index ×2, bounded tx lookup, row binding
 *     one transaction
 *   → offer effect from its metadata      ledger hash from the answer, or the validated header
 *   → one validated offer snapshot        ledger_entry {offer: {account, seq}}
 *   → assessTradeRecovery                 pure
 *   → operator diagnostic                 identifiers, closed codes, ledger references — no amounts, keys or credentials
 * ```
 *
 * Its ledger capability has six reads and nothing else
 * (`readOnlyTradeRecoveryLedger`); it holds no signer, no submission client,
 * no settle and no reserve. Two coordinators assessing one execution at once
 * read the same records and write nothing, so they cannot create a second
 * effect or diverge any state. It never retries a read, and elapsed time is
 * never an input: the ledger index is.
 *
 * Closing a record durably stays where it was: the P12 trade authority, on an
 * explicit `reconcile`, from the same evidence contract.
 */
export const TRADE_RECOVERY_DIAGNOSTIC_SCHEMA = 'frontera.trade-recovery-diagnostic.v1';

/** The coordinator's ledger capability: the trade P12 reading's four reads plus validated headers and entries. */
export interface TradeRecoveryLedgerReader extends TradeLedgerReader {
  ledgerHeader(index: number): Promise<unknown>;
  ledgerEntry(request: Readonly<Record<string, unknown>>): Promise<unknown>;
}

/** A fresh, frozen object carrying exactly the six reads, so the coordinator cannot reach a write even by accident. */
export function readOnlyTradeRecoveryLedger(client: TradeRecoveryLedgerReader): TradeRecoveryLedgerReader {
  return Object.freeze({
    connect: () => client.connect(),
    serverInfo: () => client.serverInfo(),
    validatedLedgerIndex: (timeoutMs?: number) => client.validatedLedgerIndex(timeoutMs),
    lookupTransaction: (query: { readonly hash: string; readonly minLedger: number; readonly maxLedger: number }, timeoutMs?: number) => client.lookupTransaction(query, timeoutMs),
    ledgerHeader: (index: number) => client.ledgerHeader(index),
    ledgerEntry: (request: Readonly<Record<string, unknown>>) => client.ledgerEntry(request),
  });
}

export interface TradeRecoveryCoordinatorOptions {
  readonly networkId: number;
  readonly requestTimeoutMs: number;
  readonly maxValidatedLedgerAgeSeconds: number;
  readonly ledger: TradeRecoveryLedgerReader;
  /** The interlock's verified read, and (when composed) its health: a failed CORE-07 status refuses the read; an unreachable witness is reported. */
  readonly interlock: { read(executionId: string): Promise<TradeSubmissionRecord | undefined>; readIntent?(executionId: string): Promise<TradeIntentRecord | undefined>; health?(): Promise<{ readonly freshness?: string }> };
  readonly timer?: XrplReadTimer;
}

/** What the caller adds: the P11/P12 view it read from the authenticated stores, and the signer operator's report. Both optional. */
export interface TradeRecoveryContext {
  readonly p11?: TradeRecoveryP11View;
  readonly signer?: TradeSignerObservation;
  /** Default true: take one validated offer snapshot for an included transaction. */
  readonly offerSnapshot?: boolean;
}

/**
 * The bounded operator diagnostic: which execution, who and where, what the
 * last durable state is, what the signer reported, whether a claim exists,
 * what the ledger proves, what is uncertain and why nothing runs. Public
 * identifiers, closed codes and ledger references only — never a key, a
 * credential, a signed blob, an amount or a price.
 */
export interface TradeRecoveryDiagnostic {
  readonly schema: typeof TRADE_RECOVERY_DIAGNOSTIC_SCHEMA;
  readonly executionId: string;
  readonly organizationId?: string;
  readonly ownerAccount?: string;
  readonly delegateAccount?: string;
  readonly networkId: number;
  readonly classification: TradeRecoveryAssessment['class'];
  readonly certainty: TradeRecoveryAssessment['certainty'];
  readonly lastDurableState: TradeRecoveryAssessment['lifecycle'];
  /** D-1: the pre-signing intent's state, and the capability it handed to the signer (an id, never the capability). */
  readonly intentState: TradeRecoveryAssessment['intent'];
  readonly intentCapabilityId?: string;
  readonly settlement?: string;
  readonly signerCapability: TradeSignerObservation['state'] | 'not-supplied';
  readonly signature: TradeRecoveryAssessment['signature'];
  readonly submissionClaimRecorded: boolean | 'unknown';
  readonly ledgerResult: TradeRecoveryAssessment['ledger'];
  readonly offer?: { readonly interpretation: TradeOfferStateAssessment['interpretation']; readonly effect: string; readonly ledgerIndex: number; readonly ledgerHash?: string; readonly snapshotLedgerIndex?: number; readonly snapshotLedgerHash?: string; readonly reason?: string };
  readonly sequence: TradeRecoveryAssessment['sequence'];
  readonly evidence: {
    readonly transactionHash?: string;
    readonly boundedGrantId?: string;
    readonly requestId?: string;
    readonly decisionId?: string;
    readonly reservedAt?: string;
    readonly transitions?: readonly { readonly to: string; readonly at: string; readonly detail?: string }[];
    readonly intentTransitions?: readonly { readonly to: string; readonly at: string; readonly detail?: string }[];
    readonly intentRecordedAt?: string;
    readonly window?: { readonly sequence: number; readonly lastLedgerSequence: number; readonly minLedger: number };
    readonly referenceLedgerIndex?: number;
    readonly referenceLedgerHash?: string;
  };
  readonly inconsistencies: TradeRecoveryAssessment['inconsistencies'];
  readonly uncertainties: readonly TradeRecoveryUncertainty[];
  readonly automatedRecoveryRefused: readonly TradeRecoveryRefusal[];
  readonly existingPaths: TradeRecoveryAssessment['existingPaths'];
  readonly evidenceNeeded: readonly TradeRecoveryEvidenceNeeded[];
  /** Always: a diagnostic answers questions; it grants nothing. */
  readonly permission: 'none';
}

export interface TradeRecoveryReport {
  readonly assessment: TradeRecoveryAssessment;
  readonly diagnostic: TradeRecoveryDiagnostic;
}

export interface TradeRecoveryCoordinator {
  assess(executionId: string, context?: TradeRecoveryContext): Promise<TradeRecoveryReport>;
}

const FAILED_FRESHNESS: ReadonlySet<string> = new Set(['regressed', 'forked', 'pending-recovery', 'unbound', 'not-anchored']);

async function observeInterlock(interlock: TradeRecoveryCoordinatorOptions['interlock'], executionId: string): Promise<TradeInterlockObservation> {
  try {
    const freshness = interlock.health === undefined ? undefined : (await interlock.health()).freshness;
    if (freshness !== undefined && FAILED_FRESHNESS.has(freshness)) return Object.freeze({ status: 'unavailable', reason: 'freshness-unproven' });
    const record = await interlock.read(executionId);
    const intent = interlock.readIntent === undefined ? undefined : await interlock.readIntent(executionId);
    return Object.freeze({ status: 'read', record, ...(intent !== undefined ? { intent } : {}), ...(freshness === 'unavailable' ? { freshness: 'witness-unreachable' as const } : {}) });
  } catch (error) {
    if (error instanceof TradeInterlockStoreError && error.code === 'TRADE_INTERLOCK_CORRUPT') return Object.freeze({ status: 'unavailable', reason: 'corrupt' });
    if (error instanceof AuthorityStateFreshnessError) return Object.freeze({ status: 'unavailable', reason: 'freshness-unproven' });
    return Object.freeze({ status: 'unavailable', reason: 'unreadable' });
  }
}

export function createTradeRecoveryCoordinator(options: TradeRecoveryCoordinatorOptions): TradeRecoveryCoordinator {
  const { networkId, requestTimeoutMs, interlock } = options;
  const ledger = options.ledger;
  for (const method of ['connect', 'serverInfo', 'validatedLedgerIndex', 'lookupTransaction', 'ledgerHeader', 'ledgerEntry'] as const) {
    if (typeof ledger?.[method] !== 'function') throw new TypeError(`The trade recovery coordinator's ledger must implement ${method}.`);
  }
  if (typeof interlock?.read !== 'function') throw new TypeError('The trade recovery coordinator needs the trade interlock read.');
  // P1: every validated read asks server_info first, so connecting there (idempotent) gives the owner-Sequence
  // and offer reads this coordinator's own connection. An intent has no hash to look up, so nothing else would
  // connect it first. A failed connect is the read's failure, `ledger-unavailable` — never evidence.
  const reader: XrplValidatedLedgerReader = createXrplValidatedLedgerReader({
    port: Object.freeze({
      serverInfo: async () => {
        await ledger.connect();
        return ledger.serverInfo();
      },
      ledgerHeader: (index: number) => ledger.ledgerHeader(index),
      ledgerEntry: (request: Readonly<Record<string, unknown>>) => ledger.ledgerEntry(request),
    }),
    networkId,
    maxValidatedLedgerAgeSeconds: options.maxValidatedLedgerAgeSeconds,
    requestTimeoutMs,
    maxResponseBytes: 262_144,
    ...(options.timer !== undefined ? { timer: options.timer } : {}),
  });

  async function offerStateOf(evidence: Extract<TradeLedgerEvidence, { readonly status: 'included' }>, record: TradeSubmissionRecord, snapshot: boolean): Promise<TradeOfferStateAssessment> {
    let ledgerHash = evidence.ledgerHash;
    if (ledgerHash === undefined) {
      const header = await reader.ledgerHeader(evidence.ledgerIndex).catch(() => undefined);
      if (header?.outcome === 'read') ledgerHash = header.value.ledgerHash;
    }
    const initial = readOfferCreateEffect(evidence, record.account, record.sequence, ledgerHash);
    if (!snapshot || evidence.resultClass !== 'tesSUCCESS' || initial.effect === 'unknown') return assessTradeOfferState(initial);
    return assessTradeOfferState(initial, await readTradeOfferSnapshot(reader, record.account, record.sequence));
  }

  async function assess(executionId: string, context: TradeRecoveryContext = {}): Promise<TradeRecoveryReport> {
    const observed = await observeInterlock(interlock, executionId);
    const record = observed.status === 'read' ? observed.record : undefined;
    const intent = observed.status === 'read' ? observed.intent : undefined;
    let ledgerEvidence: TradeLedgerEvidence | undefined;
    let sequenceEvidence: TradeSequenceEvidence | undefined;
    let offer: TradeOfferStateAssessment | undefined;
    if (record !== undefined && record.executionId === executionId) {
      ledgerEvidence = await readTradeLedgerEvidence(ledger, tradeTransactionIdentityOf(record), { networkId, requestTimeoutMs });
      if (ledgerEvidence.status === 'included') offer = await offerStateOf(ledgerEvidence, record, context.offerSnapshot !== false);
    } else if (record === undefined && intent !== undefined && intent.executionId === executionId) {
      // D-1: no hash to look up — the owner's validated Sequence is the evidence.
      sequenceEvidence = await readTradeSequenceEvidence(reader, intent);
    }
    const assessment = assessTradeRecovery({
      executionId,
      interlock: observed,
      ...(context.p11 !== undefined ? { p11: context.p11 } : {}),
      ...(context.signer !== undefined ? { signer: context.signer } : {}),
      ...(ledgerEvidence !== undefined ? { ledger: ledgerEvidence } : {}),
      ...(sequenceEvidence !== undefined ? { sequenceEvidence } : {}),
      ...(offer !== undefined ? { offer } : {}),
    });
    return Object.freeze({ assessment, diagnostic: diagnosticOf(assessment, record, context, networkId, intent) });
  }

  return Object.freeze({ assess });
}

/** Projects an assessment for an operator: no amounts, no prices, no keys, no credentials, no blob. */
export function diagnosticOf(assessment: TradeRecoveryAssessment, record: TradeSubmissionRecord | undefined, context: TradeRecoveryContext, networkId: number, intent?: TradeIntentRecord): TradeRecoveryDiagnostic {
  const e = record?.evidence ?? intent?.evidence;
  const attempt = context.p11?.record?.attempt;
  const offer = assessment.offer;
  return Object.freeze({
    schema: TRADE_RECOVERY_DIAGNOSTIC_SCHEMA,
    executionId: assessment.executionId,
    ...((e?.organizationId ?? attempt?.organizationId) !== undefined ? { organizationId: (e?.organizationId ?? attempt?.organizationId)! } : {}),
    ...(record !== undefined ? { ownerAccount: record.account, delegateAccount: record.evidence.delegateAccount } : intent !== undefined ? { ownerAccount: intent.account, delegateAccount: intent.evidence.delegateAccount } : {}),
    networkId,
    classification: assessment.class,
    certainty: assessment.certainty,
    lastDurableState: assessment.lifecycle,
    intentState: assessment.intent,
    ...(intent?.capabilityId !== undefined ? { intentCapabilityId: intent.capabilityId } : {}),
    ...(assessment.settlement !== undefined ? { settlement: assessment.settlement } : {}),
    signerCapability: context.signer?.state ?? 'not-supplied',
    signature: assessment.signature,
    submissionClaimRecorded: assessment.fronteraSubmission === 'unknown' ? 'unknown' : assessment.fronteraSubmission === 'claimed',
    ledgerResult: assessment.ledger,
    ...(offer !== undefined
      ? {
          offer: Object.freeze({
            interpretation: offer.interpretation,
            effect: offer.initial.effect,
            ledgerIndex: offer.initial.ledgerIndex,
            ...(offer.initial.ledgerHash !== undefined ? { ledgerHash: offer.initial.ledgerHash } : {}),
            ...(offer.snapshot !== undefined && offer.snapshot.state !== 'unavailable' ? { snapshotLedgerIndex: offer.snapshot.ledgerIndex, snapshotLedgerHash: offer.snapshot.ledgerHash } : {}),
            ...(offer.reason !== undefined ? { reason: offer.reason } : {}),
          }),
        }
      : {}),
    sequence: assessment.sequence,
    evidence: Object.freeze({
      ...(record !== undefined ? { transactionHash: record.transactionHash, reservedAt: record.reservedAt } : {}),
      ...((e?.boundedGrantId ?? attempt?.boundedGrantId) !== undefined ? { boundedGrantId: (e?.boundedGrantId ?? attempt?.boundedGrantId)! } : {}),
      ...((e?.requestId ?? attempt?.requestId) !== undefined ? { requestId: (e?.requestId ?? attempt?.requestId)! } : {}),
      ...((e?.decisionId ?? attempt?.decisionId) !== undefined ? { decisionId: (e?.decisionId ?? attempt?.decisionId)! } : {}),
      ...(record !== undefined ? { transitions: Object.freeze(record.transitions.map((transition) => Object.freeze({ to: transition.to, at: transition.at, ...(transition.detail !== undefined ? { detail: transition.detail } : {}) }))) } : {}),
      ...(intent !== undefined ? { intentTransitions: Object.freeze(intent.transitions.map((transition) => Object.freeze({ to: transition.to, at: transition.at, ...(transition.detail !== undefined ? { detail: transition.detail } : {}) }))), intentRecordedAt: intent.recordedAt } : {}),
      ...(intent !== undefined ? { window: Object.freeze({ sequence: intent.sequence, lastLedgerSequence: intent.lastLedgerSequence, minLedger: intent.minLedger }) } : {}),
      ...(e !== undefined ? { referenceLedgerIndex: e.referenceLedgerIndex, referenceLedgerHash: e.referenceLedgerHash } : {}),
    }),
    inconsistencies: assessment.inconsistencies,
    uncertainties: assessment.uncertainties,
    automatedRecoveryRefused: assessment.automatedRecovery.refusals,
    existingPaths: assessment.existingPaths,
    evidenceNeeded: assessment.evidenceNeeded,
    permission: 'none',
  });
}
