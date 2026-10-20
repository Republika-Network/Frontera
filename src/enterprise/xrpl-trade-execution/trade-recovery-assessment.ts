import { xrplSequenceWindowBlocks } from '../../features/xrpl-transport/index.js';
import type { TradeIntentRecord, TradeSubmissionRecord } from './sqlite-trade-sequence-interlock.js';
import type { TradeLedgerEvidence, TradeLedgerEvidenceReason } from './trade-ledger-evidence.js';
import type { TradeOfferStateAssessment } from './trade-offer-state.js';
import { recordedTradeSequenceExpiry, type TradeSequenceEvidence } from './trade-sequence-evidence.js';

/**
 * TRADE-04D — the **recovery assessment** of one governed trade execution: a
 * pure, explicit classification of what the durable records and validated
 * evidence establish, kept apart from every lifecycle. It changes no state,
 * settles nothing, releases no `Sequence` and authorizes nothing: an
 * assessment is never a permission.
 *
 * Inputs, by authority:
 *
 * | input | custody | weight |
 * | --- | --- | --- |
 * | P11 attempt and initial observation (+ P12 resolution) | Host, authoritative for what the governed path recorded | identity and outcome cross-check |
 * | trade interlock row | Host, CORE-07-anchored reservations and claims | what Frontera reserved and whether its submit site claimed it |
 * | trade intent (D-1) | Host, CORE-07-anchored intent and signing marker | the window held before any capability existed, and whether the signer was ever contacted |
 * | signer capability-ledger observation | **customer-operated signer**, not anchored | a hint only: it can add uncertainty or a hash to look up, never remove uncertainty |
 * | validated-ledger evidence (`readTradeLedgerEvidence`) | XRPL | the only source of a transaction outcome |
 *
 * It never infers: a submission from a signature, non-submission from a
 * missing response, a signature from a consumed capability, delivery from a
 * claim, absence from an incomplete search, or a fill from `tesSUCCESS`.
 * Where inputs disagree it answers `inconsistent-evidence` and reconciles
 * nothing by guessing.
 */
export const TRADE_RECOVERY_ASSESSMENT_SCHEMA = 'frontera.trade-recovery-assessment.v1';

/**
 * The twelve classes (TRADE-04D §3), each the strongest fact the evidence
 * proves:
 *
 * 1. `no-trade-record` — no interlock row and no signer consumption is evidenced
 * 2. `capability-not-consumed` — no row; the signer reports no consumption for the execution
 * 3. `capability-consumed-unsigned` — no row; the signer reports `consumed` without a hash, or `signing-failed`
 * 4. `signed-not-reserved` — no row; the signer reports a signature (hash) — Frontera never reserved or sent it
 * 5. `reserved-not-claimed` — row `reserved`: signed and reserved, never claimed by the submit site
 * 6. `submission-claimed` — row `submitting`: claim durable; delivery and response unknown
 * 7. `submission-response-unknown` — row `unconfirmed`: the network was asked; its answer is unknown or provisional
 * 8. `validated-success` — validated `tesSUCCESS`: the OfferCreate applied (not a fill)
 * 9. `validated-failure` — validated `tec…`: failed in a ledger, fee consumed
 * 10. `proven-not-included` — complete validated non-inclusion after `LastLedgerSequence`, or a `tem` submit answer
 * 11. `indeterminate` — the evidence needed is unavailable (ledger, history, freshness, store)
 * 12. `inconsistent-evidence` — inputs contradict each other or fail their binding
 *
 * TRADE-04D D-1 adds one Host-proven state the signer's report used to be the
 * only witness of:
 *
 * 13. `signing-attempted` — the intent is `signing`: a capability was handed
 *     to the signer and no reservation followed; whether a signature exists
 *     is unknown. The window is held; only the owner-`Sequence` proof (or a
 *     signer-reported hash looked up on the ledger by an operator) ends it.
 *
 * With an intent, class 10 becomes provable without the signer or the hash:
 * a validated owner `Sequence` still unconsumed at or past
 * `LastLedgerSequence` proves the intent's transaction `proven-not-included`.
 * An `intended` intent shows the Host never handed a capability to the
 * delegated signer (`capability-not-consumed`, signature `not-sent-by-host`)
 * — never that no capability exists: CORE-02 signs capabilities in an
 * external authority signer, so issuance can complete unseen. It stays
 * pending until the ledger proves the window closed.
 */
export const TRADE_RECOVERY_CLASSES = [
  'no-trade-record',
  'capability-not-consumed',
  'capability-consumed-unsigned',
  'signed-not-reserved',
  'reserved-not-claimed',
  'submission-claimed',
  'submission-response-unknown',
  'validated-success',
  'validated-failure',
  'proven-not-included',
  'indeterminate',
  'inconsistent-evidence',
  'signing-attempted',
] as const;
export type TradeRecoveryClass = (typeof TRADE_RECOVERY_CLASSES)[number];

/** The P11 record as the authenticated P11 store answers it (a structural subset of `ExecutionOutcomeRecord`). */
export interface TradeRecoveryP11Record {
  readonly attempt: { readonly organizationId: string; readonly executionId: string; readonly requestId: string; readonly decisionId: string; readonly boundedGrantId: string; readonly action: string };
  readonly terminal?: {
    readonly observation: { readonly kind: 'provider'; readonly certainty: 'confirmed-completed' | 'confirmed-not-completed' | 'unconfirmed'; readonly providerRef?: string } | { readonly kind: 'withheld' };
  };
}

/** What the caller read from P11/P12: the record (or that none exists), and a P12 resolution when one is recorded. Absent: not consulted. */
export interface TradeRecoveryP11View {
  readonly record: TradeRecoveryP11Record | undefined;
  readonly resolution?: { readonly certainty: 'confirmed-completed' | 'confirmed-not-completed' };
}

/** The trade interlock read: the verified row (or none), or why it could not be read. */
export type TradeInterlockObservation =
  /** `witness-unreachable`: rows verified against the floor this process established, but the CORE-07 witness cannot currently confirm the history. */
  | { readonly status: 'read'; readonly record: TradeSubmissionRecord | undefined; readonly intent?: TradeIntentRecord; readonly freshness?: 'witness-unreachable' }
  | { readonly status: 'unavailable'; readonly reason: 'corrupt' | 'freshness-unproven' | 'unreadable' };

/**
 * What the customer's signer operator reports from its capability ledger
 * (`inspectReferenceCapabilityLedger`). Untrusted by construction: the ledger
 * is customer custody, unanchored, and may be a stale restore.
 */
export type TradeSignerObservation =
  | { readonly source: 'customer-signer-ledger'; readonly executionId: string; readonly state: 'absent' }
  | { readonly source: 'customer-signer-ledger'; readonly executionId: string; readonly state: 'consumed' | 'signing-failed'; readonly capabilityId: string }
  | { readonly source: 'customer-signer-ledger'; readonly executionId: string; readonly state: 'signed'; readonly capabilityId: string; readonly transactionHash: string }
  | { readonly source: 'customer-signer-ledger'; readonly executionId: string; readonly state: 'unavailable' };

export interface TradeRecoveryInput {
  readonly executionId: string;
  readonly p11?: TradeRecoveryP11View;
  readonly interlock: TradeInterlockObservation;
  readonly signer?: TradeSignerObservation;
  readonly ledger?: TradeLedgerEvidence;
  /** D-1: the owner-`Sequence` evidence for an intent with no reservation (no hash to look up). */
  readonly sequenceEvidence?: TradeSequenceEvidence;
  readonly offer?: TradeOfferStateAssessment;
}

export type TradeRecoveryCertainty = 'proven' | 'pending' | 'indeterminate' | 'refused';
/** `not-sent-by-host`: D-1 — the Host's anchored intent shows it never handed a capability to the delegated signer; a capability issued externally may still exist, so this is never proof of no signature. */
export type TradeRecoverySignature = 'verified-by-host' | 'reported-by-signer' | 'possible' | 'reported-failed-by-signer' | 'not-reported-by-signer' | 'not-sent-by-host' | 'unknown';
/** What Frontera's own submit site did. `claimed` proves a claim, never delivery. */
export type TradeRecoveryFronteraSubmission = 'never' | 'claimed' | 'unknown';
export type TradeRecoverySequenceStatus = 'not-reserved' | 'blocked' | 'window-closed-record-open' | 'released-by-ledger-fact' | 'unknown';

export const TRADE_RECOVERY_INCONSISTENCIES = [
  'interlock-corrupt',
  'execution-id-mismatch',
  'p11-identity-mismatch',
  'p11-reference-mismatch',
  'p11-reference-without-trade-record',
  'trade-record-without-p11-claim',
  'withheld-execution-has-trade-record',
  'p11-outcome-contradicts-ledger',
  'p12-resolution-contradicts-ledger',
  'signer-execution-mismatch',
  'signer-consumption-without-p11-claim',
  'signer-hash-mismatch',
  'signer-denies-host-verified-signature',
  'settlement-contradicts-ledger',
  'ledger-binding-mismatch',
  // D-1
  'intent-without-p11-claim',
  'signer-consumption-without-host-signing',
  'signer-capability-mismatch',
  'intent-settlement-contradicts-ledger',
] as const;
export type TradeRecoveryInconsistency = (typeof TRADE_RECOVERY_INCONSISTENCIES)[number];

export const TRADE_RECOVERY_UNCERTAINTIES = [
  'signature-existence-unknown',
  'signer-evidence-not-authoritative',
  'inclusion-unprovable-without-window',
  'delivery-unknown',
  'outcome-pending-window-open',
  'ledger-evidence-unavailable',
  'ledger-history-incomplete',
  'interlock-unavailable',
  'interlock-freshness-unproven',
  'included-without-frontera-claim',
  'offer-state-not-established',
  // D-1
  'sequence-consumed-by-unknown-transaction',
  'capability-issuance-unknown',
] as const;
export type TradeRecoveryUncertainty = (typeof TRADE_RECOVERY_UNCERTAINTIES)[number];

/** Why no automated recovery runs — TRADE-04D grants none. Closed. */
export const TRADE_RECOVERY_REFUSALS = ['assessment-only', 'execution-already-attempted', 'signed-bytes-not-retained', 'sequence-held-until-ledger-fact', 'evidence-inconsistent', 'freshness-unproven'] as const;
export type TradeRecoveryRefusal = (typeof TRADE_RECOVERY_REFUSALS)[number];

export const TRADE_RECOVERY_EVIDENCE_NEEDED = [
  'validated-ledger-past-last-ledger-sequence',
  'complete-ledger-history-for-window',
  'reachable-ledger-on-configured-network',
  'signer-capability-ledger-observation',
  'host-record-of-transaction-window',
  'trusted-operational-recovery',
  'p11-record',
  // D-1: the owner's validated AccountRoot at or past LastLedgerSequence
  'validated-owner-sequence-past-last-ledger-sequence',
] as const;
export type TradeRecoveryEvidenceNeeded = (typeof TRADE_RECOVERY_EVIDENCE_NEEDED)[number];

export interface TradeRecoveryAssessment {
  readonly schema: typeof TRADE_RECOVERY_ASSESSMENT_SCHEMA;
  readonly executionId: string;
  readonly class: TradeRecoveryClass;
  readonly certainty: TradeRecoveryCertainty;
  /** The interlock lifecycle state the assessment read (`absent` when no row; `unavailable` when unreadable). Never changed by an assessment. */
  readonly lifecycle: TradeSubmissionRecord['state'] | 'absent' | 'unavailable';
  /** D-1: the intent's state (`absent` when the execution has none — no attempt, or one from before D-1). */
  readonly intent: TradeIntentRecord['state'] | 'absent' | 'unavailable';
  readonly settlement?: string;
  readonly signature: TradeRecoverySignature;
  readonly fronteraSubmission: TradeRecoveryFronteraSubmission;
  readonly sequence: { readonly status: TradeRecoverySequenceStatus; readonly owner?: string; readonly sequence?: number; readonly lastLedgerSequence?: number };
  readonly ledger: {
    readonly consulted: boolean;
    readonly status?: TradeLedgerEvidence['status'] | TradeSequenceEvidence['status'];
    readonly reason?: TradeLedgerEvidenceReason | Extract<TradeSequenceEvidence, { readonly status: 'unresolved' }>['reason'];
    /** D-1: how the answer was established — the transaction lookup by hash, or the owner's validated `Sequence`. */
    readonly via?: 'transaction-lookup' | 'owner-sequence';
    readonly engineResult?: string;
    readonly ledgerIndex?: number;
    readonly ledgerHash?: string;
    readonly validatedIndex?: number;
    readonly accountSequence?: number;
  };
  readonly offer?: TradeOfferStateAssessment;
  readonly inconsistencies: readonly TradeRecoveryInconsistency[];
  readonly uncertainties: readonly TradeRecoveryUncertainty[];
  readonly automatedRecovery: { readonly permitted: false; readonly refusals: readonly TradeRecoveryRefusal[] };
  /** Existing, unchanged operator paths that may take this further — information, not permission. */
  readonly existingPaths: readonly ('p12-reconcile' | 'operator-attestation')[];
  readonly evidenceNeeded: readonly TradeRecoveryEvidenceNeeded[];
}

const BINDING_REASONS: ReadonlySet<TradeLedgerEvidenceReason> = new Set([
  'network-mismatch',
  'network-changed',
  'ledger-index-disagreement',
  'transaction-hash-mismatch',
  'transaction-body-missing',
  'wrong-account',
  'wrong-delegate',
  'wrong-transaction-type',
  'sequence-mismatch',
  'last-ledger-sequence-mismatch',
  'ledger-outside-window',
  'ledger-hash-malformed',
  'result-unrecognized',
  // Found, yet not validated, after the window closed: the server contradicts the protocol.
  'transaction-not-validated',
]);

function uniq<T>(values: readonly T[]): readonly T[] {
  return Object.freeze([...new Set(values)]);
}

/** Classifies one execution. Pure and total. */
export function assessTradeRecovery(input: TradeRecoveryInput): TradeRecoveryAssessment {
  const { executionId, p11, interlock, signer, ledger, offer, sequenceEvidence } = input;
  const inconsistencies: TradeRecoveryInconsistency[] = [];
  const uncertainties: TradeRecoveryUncertainty[] = [];
  const needed: TradeRecoveryEvidenceNeeded[] = [];
  const refusals: TradeRecoveryRefusal[] = ['assessment-only'];

  const record = interlock.status === 'read' ? interlock.record : undefined;
  if (interlock.status === 'unavailable') {
    if (interlock.reason === 'corrupt') inconsistencies.push('interlock-corrupt');
    else uncertainties.push(interlock.reason === 'freshness-unproven' ? 'interlock-freshness-unproven' : 'interlock-unavailable');
    if (interlock.reason !== 'unreadable') refusals.push('freshness-unproven');
    needed.push('trusted-operational-recovery');
  }
  if (interlock.status === 'read' && interlock.freshness === 'witness-unreachable') uncertainties.push('interlock-freshness-unproven');
  if (record !== undefined && record.executionId !== executionId) inconsistencies.push('execution-id-mismatch');
  // ── D-1: the intent ──
  const intent = interlock.status === 'read' ? interlock.intent : undefined;
  if (intent !== undefined && intent.executionId !== executionId) inconsistencies.push('execution-id-mismatch');
  /** The anchored intent shows the Host never handed a capability to the delegated signer (`signing` is written before any contact). Not proof that no capability or signature exists. */
  const notSentByHost = record === undefined && intent?.state === 'intended';
  const intentOnly = record === undefined && intent !== undefined;

  // ── P11 / P12 against the row ──
  const p11Record = p11?.record;
  const observation = p11Record?.terminal?.observation;
  const providerRef = observation?.kind === 'provider' ? observation.providerRef : undefined;
  if (p11 !== undefined) {
    if (p11Record !== undefined && p11Record.attempt.executionId !== executionId) inconsistencies.push('execution-id-mismatch');
    if (record !== undefined && p11Record === undefined) inconsistencies.push('trade-record-without-p11-claim');
    if (record !== undefined && p11Record !== undefined) {
      const e = record.evidence;
      if (e.requestId !== p11Record.attempt.requestId || e.decisionId !== p11Record.attempt.decisionId || e.boundedGrantId !== p11Record.attempt.boundedGrantId || e.organizationId !== p11Record.attempt.organizationId) inconsistencies.push('p11-identity-mismatch');
      if (observation?.kind === 'withheld') inconsistencies.push('withheld-execution-has-trade-record');
      if (providerRef !== undefined && providerRef !== record.transactionHash) inconsistencies.push('p11-reference-mismatch');
    }
    if (record === undefined && interlock.status === 'read' && providerRef !== undefined) inconsistencies.push('p11-reference-without-trade-record');
    if (intentOnly && p11Record === undefined) inconsistencies.push('intent-without-p11-claim');
    if (intentOnly && p11Record !== undefined) {
      const e = intent.evidence;
      if (e.requestId !== p11Record.attempt.requestId || e.decisionId !== p11Record.attempt.decisionId || e.boundedGrantId !== p11Record.attempt.boundedGrantId || e.organizationId !== p11Record.attempt.organizationId) inconsistencies.push('p11-identity-mismatch');
      if (observation?.kind === 'withheld') inconsistencies.push('withheld-execution-has-trade-record');
    }
  } else {
    needed.push('p11-record');
  }

  // ── The signer's report: a hint, never a release ──
  if (signer !== undefined) {
    uncertainties.push('signer-evidence-not-authoritative');
    if (signer.executionId !== executionId) inconsistencies.push('signer-execution-mismatch');
    // P11's claim precedes every capability this Host issues: a consumption for an execution P11 never claimed was not authorized here.
    else if (p11 !== undefined && p11Record === undefined && (signer.state === 'consumed' || signer.state === 'signed' || signer.state === 'signing-failed')) inconsistencies.push('signer-consumption-without-p11-claim');
    else if (record !== undefined) {
      if (signer.state === 'signed' && signer.transactionHash !== record.transactionHash) inconsistencies.push('signer-hash-mismatch');
      // The Host verified a signature before it reserved: a signer that reports none (absent / failed) contradicts it — a stale restore, or another signer.
      if (signer.state === 'absent' || signer.state === 'signing-failed') inconsistencies.push('signer-denies-host-verified-signature');
    } else if (notSentByHost && (signer.state === 'consumed' || signer.state === 'signed' || signer.state === 'signing-failed')) {
      // The Host never handed a capability to the signer for this execution: a consumption is not one this Host authorized.
      inconsistencies.push('signer-consumption-without-host-signing');
    }
    if (signer.executionId === executionId && intent?.capabilityId !== undefined && 'capabilityId' in signer && signer.capabilityId !== intent.capabilityId) inconsistencies.push('signer-capability-mismatch');
  }

  // ── The ledger against the row ──
  let ledgerOutcome: 'success' | 'failure' | 'not-included' | undefined;
  if (ledger !== undefined) {
    if (ledger.status === 'included') ledgerOutcome = ledger.resultClass === 'tesSUCCESS' ? 'success' : 'failure';
    else if (ledger.status === 'not-included') ledgerOutcome = 'not-included';
    else if (BINDING_REASONS.has(ledger.reason)) inconsistencies.push('ledger-binding-mismatch');
    else if (ledger.reason === 'window-open') uncertainties.push('outcome-pending-window-open');
    else if (ledger.reason === 'history-incomplete') uncertainties.push('ledger-history-incomplete');
    else uncertainties.push('ledger-evidence-unavailable');
  }
  if (record?.state === 'settled' && ledgerOutcome !== undefined) {
    const agrees =
      (record.settlement === 'validated-success' && ledgerOutcome === 'success') ||
      (record.settlement === 'validated-failure' && ledgerOutcome === 'failure') ||
      ((record.settlement === 'expired' || record.settlement === 'malformed') && ledgerOutcome === 'not-included');
    if (!agrees) inconsistencies.push('settlement-contradicts-ledger');
  }
  if (ledgerOutcome !== undefined && observation?.kind === 'provider' && observation.certainty !== 'unconfirmed') {
    if ((observation.certainty === 'confirmed-completed') !== (ledgerOutcome === 'success')) inconsistencies.push('p11-outcome-contradicts-ledger');
  }
  if (ledgerOutcome !== undefined && p11?.resolution !== undefined) {
    if ((p11.resolution.certainty === 'confirmed-completed') !== (ledgerOutcome === 'success')) inconsistencies.push('p12-resolution-contradicts-ledger');
  }
  if (record?.state === 'reserved' && (ledgerOutcome === 'success' || ledgerOutcome === 'failure')) uncertainties.push('included-without-frontera-claim');
  // ── D-1: the owner's validated Sequence, for an intent no reservation continued ──
  if (intentOnly && sequenceEvidence !== undefined) {
    if (sequenceEvidence.status === 'not-included') ledgerOutcome = 'not-included';
    else if (sequenceEvidence.status === 'sequence-consumed') {
      const expiry = recordedTradeSequenceExpiry(intent);
      if (intent.state !== 'expired') {
        // Consumed by some transaction — possibly this intent's, signed under a capability the Host never saw leave.
        uncertainties.push('sequence-consumed-by-unknown-transaction');
      } else if (expiry === undefined || sequenceEvidence.ledgerIndex <= expiry.ledgerIndex) {
        // Consumed at or before the ledger the recorded proof saw it unconsumed (a Sequence never moves back), or no proof on record.
        inconsistencies.push('intent-settlement-contradicts-ledger');
      }
      // P2: otherwise consumed after the recorded proof — the released Sequence reused by a later transaction, which the expiry permits.
    } else if (sequenceEvidence.reason === 'sequence-regressed') inconsistencies.push('ledger-binding-mismatch');
    else if (sequenceEvidence.reason === 'window-open') uncertainties.push('outcome-pending-window-open');
    else uncertainties.push('ledger-evidence-unavailable');
  }

  // ── Signature and Frontera's own submission ──
  let signature: TradeRecoverySignature = 'unknown';
  if (record !== undefined) signature = 'verified-by-host';
  else if (notSentByHost) signature = 'not-sent-by-host';
  else if (signer?.executionId === executionId) {
    signature = signer.state === 'signed' ? 'reported-by-signer' : signer.state === 'consumed' ? 'possible' : signer.state === 'signing-failed' ? 'reported-failed-by-signer' : signer.state === 'absent' ? 'not-reported-by-signer' : 'unknown';
  }
  // A capability was handed to the signer: a signature is possible whatever the signer does or does not report.
  if (intentOnly && !notSentByHost && signature === 'unknown') signature = 'possible';
  const fronteraSubmission: TradeRecoveryFronteraSubmission = interlock.status !== 'read' ? 'unknown' : record === undefined || record.submissionAttempts === 0 ? 'never' : 'claimed';
  if (fronteraSubmission === 'claimed' && ledgerOutcome === undefined) uncertainties.push('delivery-unknown');

  // ── The owner Sequence, by the shared blocking rule only ──
  const validatedIndex = ledger !== undefined ? (ledger.status === 'unresolved' ? ledger.validatedIndexBefore : ledger.validatedIndexAfter) : intentOnly ? sequenceEvidence?.ledgerIndex : undefined;
  let sequenceStatus: TradeRecoverySequenceStatus = interlock.status !== 'read' ? 'unknown' : 'not-reserved';
  if (record !== undefined) {
    if (record.state === 'settled') sequenceStatus = 'released-by-ledger-fact';
    else if (validatedIndex === undefined) sequenceStatus = 'unknown';
    else sequenceStatus = xrplSequenceWindowBlocks({ sequence: record.sequence, lastLedgerSequence: record.lastLedgerSequence, open: true }, record.sequence, validatedIndex) ? 'blocked' : 'window-closed-record-open';
  } else if (intent !== undefined) {
    // D-1: the intent holds the window exactly as a reservation would; only a ledger fact releases it.
    if (intent.state === 'expired') sequenceStatus = 'released-by-ledger-fact';
    else if (validatedIndex === undefined) sequenceStatus = 'unknown';
    else sequenceStatus = xrplSequenceWindowBlocks({ sequence: intent.sequence, lastLedgerSequence: intent.lastLedgerSequence, open: true }, intent.sequence, validatedIndex) ? 'blocked' : 'window-closed-record-open';
  }

  // ── The class: inconsistency first, then a ledger fact, then the strongest local fact ──
  let klass: TradeRecoveryClass;
  let certainty: TradeRecoveryCertainty;
  const unavailableLedger = ledger?.status === 'unresolved' && !BINDING_REASONS.has(ledger.reason) && ledger.reason !== 'window-open';
  if (inconsistencies.length > 0) {
    klass = 'inconsistent-evidence';
    certainty = 'refused';
    refusals.push('evidence-inconsistent');
    needed.push('trusted-operational-recovery');
  } else if (interlock.status === 'unavailable') {
    klass = 'indeterminate';
    certainty = 'indeterminate';
  } else if (intentOnly) {
    if (ledgerOutcome === 'not-included' || intent.state === 'expired') {
      klass = 'proven-not-included';
      certainty = 'proven';
    } else if (notSentByHost) {
      klass = 'capability-not-consumed';
      certainty = 'pending';
    } else if (signer?.executionId === executionId && signer.state === 'signed') {
      klass = 'signed-not-reserved';
      certainty = 'indeterminate';
    } else if (signer?.executionId === executionId && (signer.state === 'consumed' || signer.state === 'signing-failed')) {
      klass = 'capability-consumed-unsigned';
      certainty = 'indeterminate';
    } else if (signer?.executionId === executionId && signer.state === 'absent') {
      // The signer reports no consumption — a hint only: the capability did reach it (or may have), so the window stays held.
      klass = 'capability-not-consumed';
      certainty = 'indeterminate';
    } else {
      klass = 'signing-attempted';
      certainty = uncertainties.includes('ledger-evidence-unavailable') || sequenceEvidence === undefined ? 'indeterminate' : 'pending';
    }
  } else if (ledgerOutcome === 'success' || (ledgerOutcome === undefined && record?.settlement === 'validated-success' && ledger === undefined)) {
    klass = 'validated-success';
    certainty = 'proven';
  } else if (ledgerOutcome === 'failure' || (ledgerOutcome === undefined && record?.settlement === 'validated-failure' && ledger === undefined)) {
    klass = 'validated-failure';
    certainty = 'proven';
  } else if (ledgerOutcome === 'not-included' || (ledgerOutcome === undefined && (record?.settlement === 'expired' || record?.settlement === 'malformed') && ledger === undefined)) {
    klass = 'proven-not-included';
    certainty = 'proven';
  } else if (record !== undefined && record.state === 'settled') {
    // Settled, and the ledger was consulted but could not confirm it now: the durable ledger fact stands; the fresh read is the uncertainty.
    klass = record.settlement === 'validated-success' ? 'validated-success' : record.settlement === 'validated-failure' ? 'validated-failure' : 'proven-not-included';
    certainty = 'proven';
  } else if (record !== undefined && unavailableLedger) {
    klass = 'indeterminate';
    certainty = 'indeterminate';
  } else if (record !== undefined) {
    klass = record.state === 'reserved' ? 'reserved-not-claimed' : record.state === 'submitting' ? 'submission-claimed' : 'submission-response-unknown';
    certainty = 'pending';
  } else if (signer?.state === 'signed') {
    klass = 'signed-not-reserved';
    certainty = 'indeterminate';
  } else if (signer?.state === 'consumed' || signer?.state === 'signing-failed') {
    klass = 'capability-consumed-unsigned';
    certainty = 'indeterminate';
  } else if (signer?.state === 'absent' && !(p11 !== undefined && p11Record === undefined)) {
    klass = 'capability-not-consumed';
    certainty = 'indeterminate';
  } else {
    klass = 'no-trade-record';
    certainty = p11 !== undefined && p11Record === undefined && signer?.state !== 'unavailable' ? 'proven' : 'indeterminate';
  }

  // ── What remains uncertain, what would settle it, and why nothing runs automatically ──
  if (intentOnly && klass !== 'inconsistent-evidence' && klass !== 'proven-not-included') {
    // D-1: the window is known (the intent fixed it); what is unknown is whether a signature exists, and only the ledger can end that.
    if (notSentByHost) uncertainties.push('capability-issuance-unknown');
    else if (signature !== 'reported-by-signer') uncertainties.push('signature-existence-unknown');
    needed.push('validated-owner-sequence-past-last-ledger-sequence');
  }
  if (record === undefined && intent === undefined && interlock.status === 'read' && klass !== 'inconsistent-evidence') {
    if (p11Record !== undefined || signer !== undefined) {
      if (signature === 'possible' || signature === 'unknown' || signature === 'not-reported-by-signer' || signature === 'reported-failed-by-signer') uncertainties.push('signature-existence-unknown');
      if (signature !== 'not-reported-by-signer' || p11Record !== undefined) {
        uncertainties.push('inclusion-unprovable-without-window');
        needed.push('host-record-of-transaction-window');
      }
      if (signer === undefined) needed.push('signer-capability-ledger-observation');
    }
  }
  if (record !== undefined || intent !== undefined || p11Record !== undefined || signer?.state === 'consumed' || signer?.state === 'signed' || signer?.state === 'signing-failed') refusals.push('execution-already-attempted');
  if (signature === 'verified-by-host' || signature === 'reported-by-signer' || signature === 'possible') refusals.push('signed-bytes-not-retained');
  if (sequenceStatus === 'blocked' || sequenceStatus === 'unknown') refusals.push('sequence-held-until-ledger-fact');
  if (uncertainties.includes('outcome-pending-window-open')) needed.push('validated-ledger-past-last-ledger-sequence');
  if (uncertainties.includes('ledger-history-incomplete')) needed.push('complete-ledger-history-for-window');
  if (uncertainties.includes('ledger-evidence-unavailable')) needed.push('reachable-ledger-on-configured-network');
  if (record !== undefined && record.state !== 'settled' && ledger === undefined) needed.push('validated-ledger-past-last-ledger-sequence');
  if ((klass === 'validated-success' || klass === 'validated-failure') && (offer === undefined || offer.interpretation === 'state-unknown')) uncertainties.push('offer-state-not-established');

  const existingPaths: ('p12-reconcile' | 'operator-attestation')[] = [];
  if (record !== undefined && record.state !== 'settled' && klass !== 'inconsistent-evidence') existingPaths.push('p12-reconcile');
  // D-1: P12 expires an open intent on the owner-Sequence proof, and on nothing else.
  if (intentOnly && (intent.state === 'intended' || intent.state === 'signing') && klass !== 'inconsistent-evidence') existingPaths.push('p12-reconcile');
  if (klass === 'inconsistent-evidence' || klass === 'indeterminate' || (record === undefined && p11Record !== undefined && observation === undefined)) existingPaths.push('operator-attestation');

  return Object.freeze({
    schema: TRADE_RECOVERY_ASSESSMENT_SCHEMA,
    executionId,
    class: klass,
    certainty,
    lifecycle: interlock.status !== 'read' ? 'unavailable' : (record?.state ?? 'absent'),
    intent: interlock.status !== 'read' ? 'unavailable' : (intent?.state ?? 'absent'),
    ...(record?.settlement !== undefined ? { settlement: record.settlement } : {}),
    signature,
    fronteraSubmission,
    sequence: Object.freeze({
      status: sequenceStatus,
      ...(record !== undefined ? { owner: record.account, sequence: record.sequence, lastLedgerSequence: record.lastLedgerSequence } : {}),
    }),
    ledger: Object.freeze({
      consulted: ledger !== undefined || (intentOnly && sequenceEvidence !== undefined),
      ...(ledger !== undefined ? { status: ledger.status, via: 'transaction-lookup' as const } : {}),
      ...(ledger === undefined && intentOnly && sequenceEvidence !== undefined
        ? {
            status: sequenceEvidence.status,
            via: 'owner-sequence' as const,
            ...(sequenceEvidence.status === 'unresolved' ? { reason: sequenceEvidence.reason } : {}),
            ...(sequenceEvidence.ledgerIndex !== undefined ? { ledgerIndex: sequenceEvidence.ledgerIndex } : {}),
            ...(sequenceEvidence.ledgerHash !== undefined ? { ledgerHash: sequenceEvidence.ledgerHash } : {}),
            ...(sequenceEvidence.status !== 'unresolved' ? { accountSequence: sequenceEvidence.accountSequence } : {}),
          }
        : {}),
      ...(ledger?.status === 'unresolved' ? { reason: ledger.reason } : {}),
      ...(ledger?.status === 'included' ? { engineResult: ledger.engineResult, ledgerIndex: ledger.ledgerIndex, ...(ledger.ledgerHash !== undefined ? { ledgerHash: ledger.ledgerHash } : {}) } : {}),
      ...(validatedIndex !== undefined ? { validatedIndex } : {}),
    }),
    ...(offer !== undefined ? { offer } : {}),
    inconsistencies: uniq(inconsistencies),
    uncertainties: uniq(uncertainties),
    automatedRecovery: Object.freeze({ permitted: false as const, refusals: uniq(refusals) }),
    existingPaths: uniq(existingPaths),
    evidenceNeeded: uniq(needed),
  });
}
