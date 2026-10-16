import { createXrplValidatedLedgerReader } from '../../features/xrpl-transport/index.js';
import type { DurableTradeSequenceInterlock, TradeIntentInput, TradeIntentRecord, TradeReservationInput } from '../xrpl-trade-execution/sqlite-trade-sequence-interlock.js';

/**
 * TRADE-04D D-1 — the intent a reservation continues, derived from the
 * reservation exactly as the executor derives both from one prepared offer:
 * the shared evidence values, plus the trust domain, network and signing
 * preimage digest only the intent carries.
 */
export const TEST_TRUST_DOMAIN = 'frontera-test-trust-domain';
export const TEST_NETWORK = 'xrp-ledger-testnet';
export const TEST_PREIMAGE_DIGEST = `sha256:${'9'.repeat(64)}`;

export function intentFor(reservation: TradeReservationInput, overrides: Partial<TradeIntentInput> = {}): TradeIntentInput {
  const { signerId: _signerId, signerRequestId: _signerRequestId, ...shared } = reservation.evidence;
  return {
    executionId: reservation.executionId,
    account: reservation.account,
    sequence: reservation.sequence,
    lastLedgerSequence: reservation.lastLedgerSequence,
    minLedger: reservation.minLedger,
    signingPreimageDigest: TEST_PREIMAGE_DIGEST,
    evidence: { ...shared, trustDomain: TEST_TRUST_DOMAIN, network: TEST_NETWORK },
    ...overrides,
  };
}

let capabilities = 0;
/** A fresh 64-hex capability id. */
export const testCapabilityId = (): string => (capabilities += 1).toString(16).padStart(64, 'c');

/**
 * What the executor does before the signer is contacted: record the intent,
 * then mark it `signing`. Answers the intent outcome; marks `signing` only
 * when it was recorded.
 */
export async function intendAndSign(store: Pick<DurableTradeSequenceInterlock, 'recordIntent' | 'markSigning'>, reservation: TradeReservationInput, validatedLedgerIndex: number): Promise<Awaited<ReturnType<DurableTradeSequenceInterlock['recordIntent']>>> {
  const outcome = await store.recordIntent(intentFor(reservation), validatedLedgerIndex);
  if (outcome.outcome === 'recorded') await store.markSigning(reservation.executionId, testCapabilityId());
  return outcome;
}

/** The pre-D-1 call shape, now honest: intent, signing, then the reservation. A blocked or recorded intent answers as the reservation would. */
export async function reserveWithIntent(store: Pick<DurableTradeSequenceInterlock, 'recordIntent' | 'markSigning' | 'reserve'>, reservation: TradeReservationInput, validatedLedgerIndex: number): ReturnType<DurableTradeSequenceInterlock['reserve']> {
  const intent = await intendAndSign(store, reservation, validatedLedgerIndex);
  if (intent.outcome === 'blocked') return { outcome: 'blocked' };
  if (intent.outcome === 'execution-recorded' && intent.transactionHash !== undefined) return { outcome: 'execution-recorded', transactionHash: intent.transactionHash };
  return store.reserve(reservation, validatedLedgerIndex);
}

/** A verified-looking intent record for the pure assessment (the store's own decoding is qualified separately). */
export function intentRecordFor(reservation: TradeReservationInput, state: TradeIntentRecord['state'], overrides: Partial<TradeIntentRecord> = {}): TradeIntentRecord {
  const signed = state !== 'intended' && state !== 'abandoned';
  return {
    ...intentFor(reservation),
    state,
    ...(signed ? { capabilityId: 'c'.repeat(64) } : {}),
    transitions: [],
    recordedAt: '2026-10-15T00:00:00.000Z',
    updatedAt: '2026-10-15T00:00:00.000Z',
    ...overrides,
  };
}

/** As the Host composition builds it: the shared validated reader over a ledger client's three reads, for the P12 owner-Sequence proof. */
export function validatedEntryReader(client: { serverInfo(): Promise<unknown>; ledgerHeader(index: number): Promise<unknown>; ledgerEntry(request: Readonly<Record<string, unknown>>): Promise<unknown> }, networkId: number) {
  return createXrplValidatedLedgerReader({ port: { serverInfo: () => client.serverInfo(), ledgerHeader: (index) => client.ledgerHeader(index), ledgerEntry: (request) => client.ledgerEntry(request) }, networkId, maxValidatedLedgerAgeSeconds: 10, requestTimeoutMs: 1_000, maxResponseBytes: 65_536 });
}
