import type { PaymentSettlementAccessContext, PaymentSettlementRecord, PaymentSettlementStoreHealth, RecordPaymentSettlementInput, RecordPaymentSettlementResult } from './contracts.js';
import { PAYMENT_SETTLEMENT_STORE_SCHEMA_VERSION } from './contracts.js';
import { PaymentSettlementStoreError } from './errors.js';
import { buildPaymentSettlementRecord } from './integrity.js';
import { planPaymentSettlement, requireSettlementAccessContext, requireSettlementExecutionId, requireValidSettlement, verifyLoadedSettlement, type PaymentSettlementStore } from './settlement-store.js';

export interface InMemoryPaymentSettlementStoreOptions {
  readonly now: () => string;
}

/**
 * The volatile settlement store — tests and development only. Same contract,
 * same verification, lost on restart (and therefore never a production
 * composition: a lost settlement is re-verified from the rail, never assumed).
 */
export function createInMemoryPaymentSettlementStore(options: InMemoryPaymentSettlementStoreOptions): PaymentSettlementStore {
  if (typeof options?.now !== 'function') throw new PaymentSettlementStoreError('PAYMENT_SETTLEMENT_STORE_UNAVAILABLE', 'The settlement store requires an injected clock.');
  const now = options.now;
  const records = new Map<string, PaymentSettlementRecord>();
  let closed = false;

  function assertOpen(): void {
    if (closed) throw new PaymentSettlementStoreError('PAYMENT_SETTLEMENT_STORE_UNAVAILABLE', 'The settlement store has been closed.');
  }

  return {
    providerKind: 'memory',

    async record(context: PaymentSettlementAccessContext, input: RecordPaymentSettlementInput): Promise<RecordPaymentSettlementResult> {
      assertOpen();
      requireValidSettlement(context, input);
      // One synchronous section: read, decide, write.
      const plan = planPaymentSettlement(input, verifyLoadedSettlement(input.executionId, input.organizationId, records.get(input.executionId)));
      if (plan.kind === 'existing') return { outcome: 'existing', settlement: plan.settlement };
      const settlement = buildPaymentSettlementRecord(input, now());
      records.set(settlement.executionId, settlement);
      return { outcome: 'recorded', settlement };
    },

    async read(context: PaymentSettlementAccessContext, executionId: string): Promise<PaymentSettlementRecord | undefined> {
      assertOpen();
      const organizationId = requireSettlementAccessContext(context);
      requireSettlementExecutionId(executionId);
      return verifyLoadedSettlement(executionId, organizationId, records.get(executionId));
    },

    async health(): Promise<PaymentSettlementStoreHealth> {
      return { status: closed ? 'unhealthy' : 'healthy', readable: !closed, writable: !closed, schemaVersion: PAYMENT_SETTLEMENT_STORE_SCHEMA_VERSION, checkedAt: now() };
    },

    async close(): Promise<void> {
      closed = true;
    },
  };
}
