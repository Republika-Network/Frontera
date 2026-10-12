import {
  PAYMENT_PARAMETER_DIMENSION_IDS,
  isPaymentBusinessReference,
  isPaymentPurpose,
  isPaymentRailId,
  isPaymentReference,
  paymentDestinationOf,
  type PaymentGovernanceBinding,
  type PaymentSettlementBasisKind,
  type PaymentSettlementTerms,
} from '../../features/payment-runtime/index.js';
import type { ExecutionAttemptRecord, ExecutionOutcomeRecord } from '../execution-outcome-store/contracts.js';
import { isExecutionOutcomeStoreError } from '../execution-outcome-store/errors.js';
import type { ExecutionOutcomeReader } from '../execution-outcome-store/outcome-store.js';
import type { ExecutionResolutionState } from '../execution-resolution-store/contracts.js';
import { isExecutionResolutionStoreError } from '../execution-resolution-store/errors.js';
import type { ExecutionResolutionReader } from '../execution-resolution-store/resolution-store.js';
import type { GovernanceRecord, GovernanceStoreAccessContext } from '../governance-store/contracts.js';
import type { PaymentSettlementBasis } from './contracts.js';

/**
 * PAY-05 — the canonical settlement basis, read from verified durable state
 * only. **No duplicate truth:** P11 and P12 are read, never copied into a
 * second status; the committed decision is read, never re-made.
 *
 * ```
 * P11 attempt            absent → not-found · not a payment action → not-a-payment
 * P11 observation        confirmed-completed                → eligible (provider basis)
 *                        confirmed-not-completed / withheld → not-settleable
 *                        unconfirmed / none                 → P12
 * P12 resolution         confirmed-completed (bound to this attempt and observation) → eligible (resolution basis)
 *                        confirmed-not-completed            → not-settleable
 *                        none                               → execution-uncertain
 * committed decision     the payment's source (resource) and destination (counterparty), held equal to P11's amount, action and parameters
 * ```
 *
 * Never a basis: a provider handle alone, a protocol challenge, a caller's
 * assertion, a business operation, a P7 reservation, elapsed time.
 */

/** The Governance Store read the basis needs: one verified, organization-scoped record by evaluation. */
export interface PaymentSettlementGovernanceReader {
  getByEvaluationId(context: GovernanceStoreAccessContext, evaluationId: string): Promise<GovernanceRecord | null>;
}

export interface PaymentSettlementBasisSources {
  readonly outcomes: ExecutionOutcomeReader;
  readonly resolutions: ExecutionResolutionReader;
  readonly governance: PaymentSettlementGovernanceReader;
  /** The deployment's payment actions (PAY-01 bindings). An execution of any other action is never a payment and is never settled. */
  readonly payments: readonly PaymentGovernanceBinding[];
}

/** Everything a finality query and a settlement record are built from. */
export interface CanonicalSettlementBasis {
  readonly attempt: ExecutionAttemptRecord;
  readonly basis: PaymentSettlementBasis;
  readonly kind: PaymentSettlementBasisKind;
  readonly terms: PaymentSettlementTerms;
  readonly railId?: string;
  readonly providerRef?: string;
}

export type PaymentSettlementBasisUnavailable =
  | 'outcome-unreadable'
  | 'outcome-corrupt'
  | 'resolution-unreadable'
  | 'resolution-corrupt'
  | 'resolution-inconsistent'
  | 'terms-unreadable'
  | 'terms-inconsistent';

export type PaymentSettlementBasisReading =
  | { readonly kind: 'eligible'; readonly basis: CanonicalSettlementBasis }
  | { readonly kind: 'state'; readonly state: 'execution-uncertain' | 'not-settleable' }
  | { readonly kind: 'not-found' }
  | { readonly kind: 'not-a-payment' }
  | { readonly kind: 'unavailable'; readonly reason: PaymentSettlementBasisUnavailable };

function tokenOf(parameters: readonly { readonly dimension: string; readonly type: string; readonly value: unknown }[] | undefined, dimension: string): string | undefined | null {
  const entry = parameters?.find((parameter) => parameter.dimension === dimension);
  if (entry === undefined) return undefined;
  return entry.type === 'token' && typeof entry.value === 'string' ? entry.value : null;
}

function readOwnRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Readonly<Record<string, unknown>>) : undefined;
}

/**
 * The payment's terms from the committed decision, held equal to the P11
 * attempt on every axis both state. The committed request is what the grant
 * was issued for and what the execution exercised exactly (PAY-01 prepares the
 * rail request from the same axes), so it is the canonical source of the
 * payment's source account and destination — which P11 does not restate.
 */
function termsOf(record: GovernanceRecord, attempt: ExecutionAttemptRecord): PaymentSettlementTerms | undefined {
  if (record.request.requestId !== attempt.requestId || record.evaluation.decisionId !== attempt.decisionId || record.evaluation.evaluationId !== attempt.evaluationId) return undefined;
  if (record.request.organizationId !== attempt.organizationId) return undefined;
  const action = readOwnRecord(record.request.requestPayload['action']);
  if (action === undefined || action['type'] !== attempt.action || action['resourceScope'] !== record.request.resourceScope) return undefined;
  const amount = attempt.amount;
  if (amount === undefined || action['amount'] !== amount.value || action['currency'] !== amount.unit) return undefined;
  const source = record.request.resourceScope;
  const destination = paymentDestinationOf(action['counterpartyId']);
  if (!isPaymentReference(source) || destination === undefined) return undefined;
  const committed = Array.isArray(action['governedParameters']) ? (action['governedParameters'] as readonly { dimension: string; type: string; value: unknown }[]) : undefined;
  const purpose = tokenOf(committed, PAYMENT_PARAMETER_DIMENSION_IDS.purpose);
  const reference = tokenOf(committed, PAYMENT_PARAMETER_DIMENSION_IDS.reference);
  const rail = tokenOf(committed, PAYMENT_PARAMETER_DIMENSION_IDS.rail);
  if (!isPaymentPurpose(purpose)) return undefined;
  if (reference === null || (reference !== undefined && !isPaymentBusinessReference(reference))) return undefined;
  if (rail === null || (rail !== undefined && !isPaymentRailId(rail))) return undefined;
  // A v2 attempt binds the exact parameters the adapter received; they must be the committed ones.
  if (attempt.parameters !== undefined) {
    for (const [dimension, value] of [
      [PAYMENT_PARAMETER_DIMENSION_IDS.purpose, purpose],
      [PAYMENT_PARAMETER_DIMENSION_IDS.reference, reference],
      [PAYMENT_PARAMETER_DIMENSION_IDS.rail, rail],
    ] as const) {
      if (tokenOf(attempt.parameters, dimension) !== value) return undefined;
    }
  }
  return Object.freeze({
    source: Object.freeze({ accountId: source }),
    destination,
    amount: Object.freeze({ value: amount.value, unit: amount.unit }),
    purpose,
    ...(reference !== undefined ? { reference } : {}),
    ...(rail !== undefined ? { rail } : {}),
  });
}

/** The P12 state for this execution, verified by its store and held to this attempt and observation. */
function resolutionBasis(outcome: ExecutionOutcomeRecord, state: ExecutionResolutionState | undefined): { readonly kind: 'completed'; readonly digest: string; readonly providerRef?: string } | { readonly kind: 'not-completed' } | { readonly kind: 'none' } | { readonly kind: 'inconsistent' } {
  const resolution = state?.resolution;
  if (resolution === undefined) return { kind: 'none' };
  if (resolution.attemptDigest !== outcome.attempt.attemptDigest) return { kind: 'inconsistent' };
  const observationDigest = outcome.terminal?.observationDigest;
  if (resolution.basisObservationDigest !== observationDigest) return { kind: 'inconsistent' };
  if (state?.binding === undefined || state.binding.bindingDigest !== resolution.bindingDigest) return { kind: 'inconsistent' };
  if (resolution.certainty === 'confirmed-not-completed') return { kind: 'not-completed' };
  return { kind: 'completed', digest: resolution.resolutionDigest, ...(resolution.providerRef !== undefined ? { providerRef: resolution.providerRef } : {}) };
}

export async function readPaymentSettlementBasis(sources: PaymentSettlementBasisSources, organizationId: string, executionId: string): Promise<PaymentSettlementBasisReading> {
  let outcome: ExecutionOutcomeRecord | undefined;
  try {
    outcome = await sources.outcomes.read({ organizationId }, executionId);
  } catch (error) {
    // Another organization's execution is indistinguishable from none.
    if (isExecutionOutcomeStoreError(error) && error.code === 'EXECUTION_OUTCOME_TENANT_VIOLATION') return { kind: 'not-found' };
    return { kind: 'unavailable', reason: isExecutionOutcomeStoreError(error) && error.code === 'EXECUTION_OUTCOME_CORRUPT' ? 'outcome-corrupt' : 'outcome-unreadable' };
  }
  if (outcome === undefined) return { kind: 'not-found' };
  const attempt = outcome.attempt;
  if (!sources.payments.some((binding) => binding.action === attempt.action) || attempt.amount === undefined) return { kind: 'not-a-payment' };

  const observation = outcome.terminal?.observation;
  let kind: PaymentSettlementBasisKind;
  let basis: PaymentSettlementBasis;
  let providerRef: string | undefined;
  const railId = observation?.kind === 'provider' ? observation.adapterId : undefined;
  if (observation?.kind === 'withheld') return { kind: 'state', state: 'not-settleable' };
  if (observation?.kind === 'provider' && observation.certainty === 'confirmed-not-completed') return { kind: 'state', state: 'not-settleable' };
  if (observation?.kind === 'provider' && observation.certainty === 'confirmed-completed') {
    kind = 'provider-confirmed-completed';
    basis = { kind, attemptDigest: attempt.attemptDigest, observationDigest: outcome.terminal!.observationDigest };
    providerRef = observation.providerRef;
  } else {
    // P11 unconfirmed, or claimed with no observation: only P12 can say more.
    let state: ExecutionResolutionState | undefined;
    try {
      state = await sources.resolutions.read({ organizationId }, executionId);
    } catch (error) {
      return { kind: 'unavailable', reason: isExecutionResolutionStoreError(error) && error.code === 'EXECUTION_RESOLUTION_CORRUPT' ? 'resolution-corrupt' : 'resolution-unreadable' };
    }
    const resolved = resolutionBasis(outcome, state);
    if (resolved.kind === 'none') return { kind: 'state', state: 'execution-uncertain' };
    if (resolved.kind === 'inconsistent') return { kind: 'unavailable', reason: 'resolution-inconsistent' };
    if (resolved.kind === 'not-completed') return { kind: 'state', state: 'not-settleable' };
    kind = 'resolution-confirmed-completed';
    basis = {
      kind,
      attemptDigest: attempt.attemptDigest,
      ...(outcome.terminal !== undefined ? { observationDigest: outcome.terminal.observationDigest } : {}),
      resolutionDigest: resolved.digest,
    };
    // A handle P11 recorded with the uncertainty is the transfer's; a later one from P12 must agree with it.
    const initialRef = observation?.kind === 'provider' ? observation.providerRef : undefined;
    if (initialRef !== undefined && resolved.providerRef !== undefined && initialRef !== resolved.providerRef) return { kind: 'unavailable', reason: 'resolution-inconsistent' };
    providerRef = initialRef ?? resolved.providerRef;
  }

  let record: GovernanceRecord | null;
  try {
    record = await sources.governance.getByEvaluationId({ system: false, organizationId }, attempt.evaluationId);
  } catch {
    return { kind: 'unavailable', reason: 'terms-unreadable' };
  }
  if (record === null) return { kind: 'unavailable', reason: 'terms-unreadable' };
  const terms = termsOf(record, attempt);
  if (terms === undefined) return { kind: 'unavailable', reason: 'terms-inconsistent' };
  return {
    kind: 'eligible',
    basis: Object.freeze({ attempt, basis: Object.freeze(basis), kind, terms, ...(railId !== undefined ? { railId } : {}), ...(providerRef !== undefined ? { providerRef } : {}) }),
  };
}
