import {
  PAYMENT_BUSINESS_OPERATION_STORE_SCHEMA_VERSION,
  type PaymentBusinessOperationAccessContext,
  type PaymentBusinessOperationRecord,
  type PaymentBusinessOperationState,
  type PaymentBusinessOperationStore,
  type PaymentBusinessOperationStoreHealth,
  type PaymentChallengeRecord,
  type PaymentGovernedRequestState,
  type RecordPaymentChallengeInput,
  type RecordPaymentChallengeResult,
} from './store-contracts.js';
import { PaymentBusinessOperationStoreError } from './store-errors.js';
import {
  buildPaymentBusinessOperationRecord,
  buildPaymentChallengeRecord,
  corruptPaymentBusinessOperation,
  isCanonicalPaymentInstant,
  latestPaymentChallenge,
  planPaymentRecord,
  requirePaymentAccessContext,
  requirePaymentIdentifier,
  requireValidPaymentRecordInput,
  verifyLoadedPaymentOperationState,
  type PaymentChallengeOwner,
} from './store-integrity.js';

/**
 * The process-local payment business-operation store (PAY-04): tests and
 * development only — **no** business-operation history across a restart.
 * It is never the production composition: the durable store,
 * `createSqlitePaymentBusinessOperationStore` composed with its CORE-07
 * freshness witness, is. A restart loses everything here, including the
 * one-operation-per-challenge record: a challenge already paid for, presented
 * after a restart under a **new** `businessOperationId`, is not recognized.
 * (The same operation still replays — its governed key is derived, never read
 * from here.) The ingress accepts this store only because it is volatile by
 * construction and says so (`isVolatilePaymentBusinessOperationStore`).
 *
 * Every write decision is one synchronous critical section — no `await`
 * between reading and inserting — over records rebuilt and verified on every
 * read, exactly as the SQLite store does.
 */

const VOLATILE_STORES = new WeakSet<object>();

/** Whether `store` was built by `createInMemoryPaymentBusinessOperationStore` (runtime brand, not shape): volatile, test and development only. */
export function isVolatilePaymentBusinessOperationStore(store: unknown): boolean {
  return typeof store === 'object' && store !== null && VOLATILE_STORES.has(store);
}

export interface CreateInMemoryPaymentBusinessOperationStoreOptions {
  readonly now: () => string;
}

function operationKey(organizationId: string, principalId: string, businessOperationId: string): string {
  return JSON.stringify([organizationId, principalId, businessOperationId]);
}

export function createInMemoryPaymentBusinessOperationStore(options: CreateInMemoryPaymentBusinessOperationStoreOptions): PaymentBusinessOperationStore {
  if (typeof options?.now !== 'function') throw new PaymentBusinessOperationStoreError('PAYMENT_BUSINESS_OPERATION_STORE_UNAVAILABLE', 'The business-operation store requires an injected clock.');
  const now = options.now;
  const operations = new Map<string, PaymentBusinessOperationRecord>();
  const challenges = new Map<string, PaymentChallengeRecord[]>();
  /** (organization, challenge identity) → operation key. */
  const identities = new Map<string, string>();
  let closed = false;

  function assertOpen(): void {
    if (closed) throw new PaymentBusinessOperationStoreError('PAYMENT_BUSINESS_OPERATION_STORE_UNAVAILABLE', 'The business-operation store has been closed.');
  }

  function load(organizationId: string, key: string, subject: string): PaymentBusinessOperationState | undefined {
    return verifyLoadedPaymentOperationState(subject, organizationId, operations.get(key), challenges.get(key) ?? []);
  }

  function ownerOf(organizationId: string, challengeIdentity: string, key: string, subject: string): PaymentChallengeOwner {
    const owner = identities.get(JSON.stringify([organizationId, challengeIdentity]));
    if (owner === undefined) return { kind: 'none' };
    if (owner !== key) {
      // Verify the other operation before its row can decide anything.
      if (load(organizationId, owner, subject) === undefined) throw corruptPaymentBusinessOperation(subject, 'a challenge identity names no operation');
      return { kind: 'another-operation' };
    }
    const record = (challenges.get(key) ?? []).find((challenge) => challenge.challengeIdentity === challengeIdentity);
    if (record === undefined) throw corruptPaymentBusinessOperation(subject, 'a challenge identity names no challenge');
    return { kind: 'this-operation', record };
  }

  const store: PaymentBusinessOperationStore = {
    providerKind: 'memory',

    async record(context: PaymentBusinessOperationAccessContext, input: RecordPaymentChallengeInput): Promise<RecordPaymentChallengeResult> {
      assertOpen();
      requireValidPaymentRecordInput(context, input);
      // One synchronous critical section from here to the return.
      const { operation: operationInput, challenge: challengeInput } = input;
      const subject = operationInput.businessOperationId;
      const key = operationKey(operationInput.organizationId, operationInput.principalId, operationInput.businessOperationId);
      const existing = load(operationInput.organizationId, key, subject);
      const owner = ownerOf(operationInput.organizationId, challengeInput.challengeIdentity, key, subject);
      const plan = planPaymentRecord(input, existing, owner);
      if (plan.challenge.kind === 'existing') {
        if (plan.operation.kind !== 'existing') throw corruptPaymentBusinessOperation(subject, 'a challenge exists with no operation');
        return { operationOutcome: 'existing', challengeOutcome: 'existing', operation: plan.operation.record, challenge: plan.challenge.record };
      }
      const at = now();
      if (!isCanonicalPaymentInstant(at)) throw new PaymentBusinessOperationStoreError('PAYMENT_BUSINESS_OPERATION_STORE_UNAVAILABLE', 'The store clock did not answer a canonical instant; nothing was written.');
      const operation = plan.operation.kind === 'existing' ? plan.operation.record : buildPaymentBusinessOperationRecord(operationInput, at);
      const challenge = buildPaymentChallengeRecord(challengeInput, plan.challenge.sequence, at);
      if (plan.operation.kind === 'create') operations.set(key, operation);
      challenges.set(key, [...(challenges.get(key) ?? []), challenge]);
      identities.set(JSON.stringify([challenge.organizationId, challenge.challengeIdentity]), key);
      return { operationOutcome: plan.operation.kind === 'create' ? 'created' : 'existing', challengeOutcome: 'appended', operation, challenge };
    },

    async readOperation(context: PaymentBusinessOperationAccessContext, principalId: string, businessOperationId: string): Promise<PaymentBusinessOperationState | undefined> {
      assertOpen();
      const organizationId = requirePaymentAccessContext(context);
      requirePaymentIdentifier(principalId, 'The principal id');
      requirePaymentIdentifier(businessOperationId, 'The business operation id');
      return load(organizationId, operationKey(organizationId, principalId, businessOperationId), businessOperationId);
    },

    async readByGovernedRequestId(context: PaymentBusinessOperationAccessContext, requestId: string): Promise<PaymentGovernedRequestState | undefined> {
      assertOpen();
      const organizationId = requirePaymentAccessContext(context);
      requirePaymentIdentifier(requestId, 'The governed request id');
      // Every candidate is verified before its request id may select it.
      for (const [key, operation] of operations) {
        if (operation.organizationId !== organizationId) continue;
        const state = load(organizationId, key, requestId);
        if (state !== undefined && state.operation.governedRequestId === requestId) return Object.freeze({ operation: state.operation, latestChallenge: latestPaymentChallenge(state) });
      }
      return undefined;
    },

    async health(): Promise<PaymentBusinessOperationStoreHealth> {
      return { status: closed ? 'unhealthy' : 'healthy', readable: !closed, writable: !closed, schemaVersion: PAYMENT_BUSINESS_OPERATION_STORE_SCHEMA_VERSION, checkedAt: now(), freshness: 'not-anchored' };
    },

    async close(): Promise<void> {
      closed = true;
    },
  };
  VOLATILE_STORES.add(store);
  return store;
}
