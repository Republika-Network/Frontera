import { deepFreeze } from '../governance-store/store-common.js';
import { isOpaqueExecutionIdentifier } from './validation.js';
import type {
  PaymentSettlementAccessContext,
  PaymentSettlementRecord,
  PaymentSettlementStoreHealth,
  RecordPaymentSettlementInput,
  RecordPaymentSettlementResult,
} from './contracts.js';
import { PaymentSettlementStoreError } from './errors.js';
import { paymentSettlementInputViolation, paymentSettlementRecordFailure, sameSettlementContent } from './integrity.js';

/**
 * The read half. Returns a settlement only after verifying it — never a
 * partial, repaired or best-effort copy. A read never contacts anything.
 */
export interface PaymentSettlementReader {
  read(context: PaymentSettlementAccessContext, executionId: string): Promise<PaymentSettlementRecord | undefined>;
}

/**
 * The write half — append only. No update, no delete, no overwrite, and no
 * "unsettled" write: a settlement either exists or does not.
 *
 * `record` with the same content as the one on record returns it (`existing`,
 * first `recordedAt` intact); with any other content for the same execution
 * it is `PAYMENT_SETTLEMENT_CONFLICT`. One settlement per execution, never
 * chosen by time, ledger position or order of arrival.
 */
export interface PaymentSettlementWriter {
  record(context: PaymentSettlementAccessContext, input: RecordPaymentSettlementInput): Promise<RecordPaymentSettlementResult>;
}

/**
 * The settlement store.
 *
 * 1. **Atomic write decisions** — read, decide and write in one critical
 *    section (SQLite: one `BEGIN IMMEDIATE`).
 * 2. **Immutability** — never updated or deleted (SQLite: triggers refuse both).
 * 3. **Deterministic identity** — `(organizationId, executionId)` derives the
 *    one settlement id; the caller never chooses it.
 * 4. **Tenant confinement** — a record belongs to one organization forever.
 * 5. **Verify before trusting** — every read, and every write that finds a
 *    record, re-validates the closed contract and recomputes every digest.
 * 6. **Fail closed, never repair.**
 */
export interface PaymentSettlementStore extends PaymentSettlementReader, PaymentSettlementWriter {
  readonly providerKind: 'memory' | 'sqlite';
  health(): Promise<PaymentSettlementStoreHealth>;
  close(): Promise<void>;
}

export function requireSettlementAccessContext(context: PaymentSettlementAccessContext): string {
  const organizationId = (context as { readonly organizationId?: unknown } | undefined)?.organizationId;
  const system = (context as { readonly system?: unknown } | undefined)?.system;
  if (!isOpaqueExecutionIdentifier(organizationId) || system !== undefined) {
    throw new PaymentSettlementStoreError('PAYMENT_SETTLEMENT_TENANT_VIOLATION', 'A settlement call requires exactly one organization scope.');
  }
  return organizationId;
}

export function requireSettlementExecutionId(executionId: string): void {
  if (!isOpaqueExecutionIdentifier(executionId)) throw new PaymentSettlementStoreError('PAYMENT_SETTLEMENT_INPUT_INVALID', 'The execution id is not an opaque identifier.');
}

/** Refuses a malformed settlement before any state is read. */
export function requireValidSettlement(context: PaymentSettlementAccessContext, input: RecordPaymentSettlementInput): void {
  const organizationId = requireSettlementAccessContext(context);
  const violation = paymentSettlementInputViolation(input);
  if (violation !== undefined) throw new PaymentSettlementStoreError('PAYMENT_SETTLEMENT_INPUT_INVALID', `The settlement is outside the closed contract: ${violation}.`);
  if (input.organizationId !== organizationId) throw new PaymentSettlementStoreError('PAYMENT_SETTLEMENT_TENANT_VIOLATION', 'A settlement for another organization cannot be recorded under this scope.');
}

/**
 * The one verification every implementation runs before believing a persisted
 * settlement. Integrity first — a record that does not verify is corrupt
 * whoever asks — then the organization: a verified record of another
 * organization is refused without revealing anything about it.
 */
export function verifyLoadedSettlement(executionId: string, organizationId: string, record: PaymentSettlementRecord | undefined): PaymentSettlementRecord | undefined {
  if (record === undefined) return undefined;
  if (record.executionId !== executionId) throw corrupt(executionId, 'the settlement is filed under another execution id');
  const failure = paymentSettlementRecordFailure(record);
  if (failure !== undefined) throw corrupt(executionId, failure);
  if (record.organizationId !== organizationId) {
    throw new PaymentSettlementStoreError('PAYMENT_SETTLEMENT_TENANT_VIOLATION', `The caller is not authorized to access the settlement of execution '${executionId}'.`);
  }
  return deepFreeze(record);
}

export function corrupt(executionId: string, what: string): PaymentSettlementStoreError {
  return new PaymentSettlementStoreError('PAYMENT_SETTLEMENT_CORRUPT', `The persisted settlement for execution '${executionId}' failed verification (${what}). Refused, never repaired.`);
}

export type SettlementPlan = { readonly kind: 'existing'; readonly settlement: PaymentSettlementRecord } | { readonly kind: 'record' };

/** The one write decision, taken inside the critical section over state read there. */
export function planPaymentSettlement(input: RecordPaymentSettlementInput, existing: PaymentSettlementRecord | undefined): SettlementPlan {
  if (existing === undefined) return { kind: 'record' };
  if (!sameSettlementContent(existing, input)) {
    throw new PaymentSettlementStoreError('PAYMENT_SETTLEMENT_CONFLICT', `Execution '${input.executionId}' already has a different settlement on record; the recorded settlement stands.`);
  }
  return { kind: 'existing', settlement: existing };
}
