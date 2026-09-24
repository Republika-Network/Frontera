import {
  MPP_BUSINESS_OPERATION_STORE_SCHEMA_VERSION,
  type MppBusinessOperationAccessContext,
  type MppBusinessOperationRecord,
  type MppBusinessOperationState,
  type MppBusinessOperationStoreHealth,
  type MppChallengeInstanceRecord,
  type MppGovernedRequestState,
  type RecordMppChallengeInput,
  type RecordMppChallengeResult,
} from './contracts.js';
import { MppBusinessOperationStoreError } from './errors.js';
import { buildMppBusinessOperationRecord, buildMppChallengeInstanceRecord } from './integrity.js';
import {
  latestMppChallenge,
  planMppRecord,
  requireMppAccessContext,
  requireMppIdentifier,
  requireValidRecordInput,
  verifyLoadedMppOperationState,
  type MppBusinessOperationStore,
} from './operation-store.js';
import { isCanonicalMppInstant } from './validation.js';

export interface InMemoryMppBusinessOperationStoreOptions {
  /** The injected clock, sampled inside each write's synchronous section as `recordedAt`. Required. */
  readonly now: () => string;
}

/**
 * The reference implementation of `MppBusinessOperationStore`, held to the
 * same shared plan and verification as the SQLite store. Every write is one
 * synchronous section. **Not durable** — and therefore not a business
 * idempotency guarantee across a restart: selected only when
 * `persistence.provider` is `memory`.
 */
export function createInMemoryMppBusinessOperationStore(options: InMemoryMppBusinessOperationStoreOptions): MppBusinessOperationStore {
  if (typeof options?.now !== 'function') throw new MppBusinessOperationStoreError('MPP_BUSINESS_OPERATION_STORE_UNAVAILABLE', 'The MPP business-operation store requires an injected clock.');
  const now = options.now;
  const operations = new Map<string, MppBusinessOperationRecord>();
  const challenges = new Map<string, MppChallengeInstanceRecord[]>();
  const byRequest = new Map<string, string>();
  let closed = false;

  const operationKey = (organizationId: string, principalId: string, businessOperationId: string): string => JSON.stringify([organizationId, principalId, businessOperationId]);
  const requestKey = (organizationId: string, requestId: string): string => JSON.stringify([organizationId, requestId]);

  function assertOpen(): void {
    if (closed) throw new MppBusinessOperationStoreError('MPP_BUSINESS_OPERATION_STORE_UNAVAILABLE', 'The MPP business-operation store has been closed.');
  }

  function recordedAt(): string {
    const instant = now();
    if (!isCanonicalMppInstant(instant)) throw new MppBusinessOperationStoreError('MPP_BUSINESS_OPERATION_STORE_UNAVAILABLE', 'The store clock did not answer a canonical instant; nothing was written.');
    return instant;
  }

  function load(organizationId: string, key: string, subject: string): MppBusinessOperationState | undefined {
    return verifyLoadedMppOperationState(subject, organizationId, operations.get(key), challenges.get(key) ?? []);
  }

  return {
    providerKind: 'memory',

    async record(context: MppBusinessOperationAccessContext, input: RecordMppChallengeInput): Promise<RecordMppChallengeResult> {
      assertOpen();
      requireValidRecordInput(context, input);
      const { operation: operationInput, challenge: challengeInput } = input;
      const key = operationKey(operationInput.organizationId, operationInput.principalId, operationInput.businessOperationId);
      const plan = planMppRecord(input, load(operationInput.organizationId, key, operationInput.businessOperationId));
      if (plan.operation.kind === 'existing' && plan.challenge.kind === 'existing') {
        return { operationOutcome: 'existing', challengeOutcome: 'existing', operation: plan.operation.record, challenge: plan.challenge.record };
      }
      const at = recordedAt();
      const operation = plan.operation.kind === 'existing' ? plan.operation.record : buildMppBusinessOperationRecord(operationInput, at);
      const sequence = plan.challenge.kind === 'append' ? plan.challenge.sequence : 0;
      const challenge = buildMppChallengeInstanceRecord(challengeInput, sequence, at);
      if (plan.operation.kind === 'create') {
        operations.set(key, operation);
        byRequest.set(requestKey(operation.organizationId, operation.governedRequestId), key);
      }
      challenges.set(key, [...(challenges.get(key) ?? []), challenge]);
      return { operationOutcome: plan.operation.kind === 'create' ? 'created' : 'existing', challengeOutcome: 'appended', operation, challenge };
    },

    async readOperation(context: MppBusinessOperationAccessContext, principalId: string, businessOperationId: string): Promise<MppBusinessOperationState | undefined> {
      assertOpen();
      const organizationId = requireMppAccessContext(context);
      requireMppIdentifier(principalId, 'The principal id');
      requireMppIdentifier(businessOperationId, 'The business operation id');
      return load(organizationId, operationKey(organizationId, principalId, businessOperationId), businessOperationId);
    },

    async readByGovernedRequestId(context: MppBusinessOperationAccessContext, requestId: string): Promise<MppGovernedRequestState | undefined> {
      assertOpen();
      const organizationId = requireMppAccessContext(context);
      requireMppIdentifier(requestId, 'The governed request id');
      const key = byRequest.get(requestKey(organizationId, requestId));
      if (key === undefined) return undefined;
      const state = load(organizationId, key, requestId);
      if (state === undefined || state.operation.governedRequestId !== requestId) {
        throw new MppBusinessOperationStoreError('MPP_BUSINESS_OPERATION_CORRUPT', `The request index for '${requestId}' does not name its operation. Refused, never repaired.`);
      }
      return Object.freeze({ operation: state.operation, latestChallenge: latestMppChallenge(state) });
    },

    async health(): Promise<MppBusinessOperationStoreHealth> {
      return { status: closed ? 'unhealthy' : 'healthy', readable: !closed, writable: !closed, schemaVersion: MPP_BUSINESS_OPERATION_STORE_SCHEMA_VERSION, checkedAt: now() };
    },

    async close(): Promise<void> {
      closed = true;
    },
  };
}
