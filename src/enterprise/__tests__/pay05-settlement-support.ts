import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createFinancialActionClassifier } from '../../features/monetary-runtime/index.js';
import {
  PAYMENT_PARAMETER_DIMENSIONS,
  PAYMENT_PROFILE_PARAMETERS,
  compilePaymentIntent,
  createPaymentGovernanceBinding,
  createPaymentRailExecutionAdapter,
  validatePaymentIntent,
  type PaymentFinalityAnswer,
  type PaymentFinalityAuthority,
  type PaymentFinalityQuery,
  type PaymentGovernedActionIntent,
  type PaymentIntent,
  type PaymentRailResult,
} from '../../features/payment-runtime/index.js';
import { createRecordingPaymentRail, type RecordingPaymentRail } from '../../features/payment-runtime/tests/payment-rail-fixture.js';
import type { ExecutionResolutionAuthority } from '../execution-reconciliation/authority.js';
import { snapshotResolutionAuthorities } from '../execution-reconciliation/authority.js';
import { createExecutionReconciliationService } from '../execution-reconciliation/service.js';
import type { ExecutionReconciliationService } from '../execution-reconciliation/contracts.js';
import type { ExecutionOutcomeStore } from '../execution-outcome-store/outcome-store.js';
import type { ExecutionResolutionStore } from '../execution-resolution-store/resolution-store.js';
import { createInMemoryExecutionResolutionStore } from '../execution-resolution-store/in-memory-execution-resolution-store.js';
import { createGovernanceProfileRegistry } from '../governance-profile/index.js';
import type { GovernanceStore } from '../governance-store/governance-store.js';
import {
  createInMemoryPaymentSettlementStore,
  createPaymentSettlementService,
  type PaymentSettlementService,
  type PaymentSettlementStore,
} from '../payment-settlement/index.js';
import { ALLOWED_INTENT, IDENTITY, NOW, ORG, TEST_ASSETS, buildGovernedWorld, monetaryAuthority, type GovernedWorld } from './governed-action-support.js';

/**
 * PAY-05 qualification support — test-only.
 *
 * The governed world is PAY-01's: the real Kernel, Governance Store, grant
 * store, ACE, P7, P10 and P11, with the recording rail (no external effect)
 * as the only stand-in below the bridge. The finality authority is a scripted
 * double that counts every query; it never has, and could not use, any way to
 * execute.
 */

export const PAYMENT_ACTION = ALLOWED_INTENT.action;
export const GOVERNED_ACCOUNT = ALLOWED_INTENT.resource;
export const BINDING = createPaymentGovernanceBinding({ action: PAYMENT_ACTION });
export const FINALITY_AUTHORITY_ID = 'test.finality';
export const FINALIZED_AT = '2026-01-01T00:00:05Z';
export { IDENTITY, NOW, ORG, TEST_ASSETS };

const MONETARY = Object.freeze({ assets: TEST_ASSETS, actionClassifier: createFinancialActionClassifier({ financialActions: [PAYMENT_ACTION] }) });
const GOVERNANCE = createGovernanceProfileRegistry({
  parameterDimensions: PAYMENT_PARAMETER_DIMENSIONS,
  actionClasses: [{ id: 'payment', actions: [PAYMENT_ACTION] }],
  resourceClasses: [{ id: 'governed-account', resources: [GOVERNED_ACCOUNT] }],
  profiles: [
    {
      profileId: 'governed-payment',
      version: 1,
      owner: ORG,
      provenance: { authoredBy: 'operator:treasury', approvedBy: 'operator:security' },
      actionClass: 'payment',
      resourceClass: 'governed-account',
      parameters: PAYMENT_PROFILE_PARAMETERS,
      materialFacts: [],
      relevantPolicies: [],
    },
  ],
});

export interface PaymentWorld {
  readonly world: GovernedWorld;
  readonly rail: RecordingPaymentRail;
}

export function paymentWorld(
  options: {
    readonly behaviour?: (request: { readonly executionId: string }) => PaymentRailResult | Promise<PaymentRailResult>;
    readonly store?: GovernanceStore;
    readonly executionOutcomes?: ExecutionOutcomeStore;
    readonly ceiling?: string;
  } = {},
): PaymentWorld {
  const rail = createRecordingPaymentRail(options.behaviour);
  const world = buildGovernedWorld({
    monetary: MONETARY,
    governance: GOVERNANCE,
    financialAuthority: monetaryAuthority(options.ceiling ?? '5000', '1000000'),
    executionAdapter: createPaymentRailExecutionAdapter({ rail, binding: BINDING }),
    ...(options.store !== undefined ? { store: options.store } : {}),
    ...(options.executionOutcomes !== undefined ? { executionOutcomes: options.executionOutcomes } : {}),
  });
  return { world, rail };
}

export function payment(overrides: Record<string, unknown> = {}): PaymentIntent {
  const validation = validatePaymentIntent(
    {
      source: { accountId: GOVERNED_ACCOUNT },
      destination: { kind: 'account', reference: 'vendor-4471' },
      amount: { value: '100', unit: 'USD' },
      purpose: 'vendor-payment',
      reference: 'INV-2026-0042',
      idempotencyKey: `pay-${Math.random().toString(36).slice(2, 10)}`,
      ...overrides,
    },
    { assets: TEST_ASSETS },
  );
  assert.equal(validation.valid, true, JSON.stringify(validation));
  return (validation as { readonly intent: PaymentIntent }).intent;
}

export function governed(intent: PaymentIntent): PaymentGovernedActionIntent {
  return compilePaymentIntent(intent, BINDING, { assertedContext: ALLOWED_INTENT.assertedContext });
}

/** The evidence a correct authority would return for exactly this query. */
export function exactEvidence(query: PaymentFinalityQuery, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    executionId: query.executionId,
    method: 'test.final-proof.v1',
    providerRef: query.providerRef ?? 'test-ref-unknown',
    amount: { value: query.payment.amount.value, unit: query.payment.amount.unit },
    source: { accountId: query.payment.source.accountId },
    destination: { kind: query.payment.destination.kind, reference: query.payment.destination.reference },
    finalizedAt: FINALIZED_AT,
    facts: [
      { name: 'test.block-height', value: '42' },
      { name: 'test.finality-depth', value: 'final' },
    ],
    ...overrides,
  };
}

export interface ScriptedFinalityAuthority extends PaymentFinalityAuthority {
  readonly queries: PaymentFinalityQuery[];
  answer: (query: PaymentFinalityQuery) => unknown;
}

export function finalityAuthority(answer: (query: PaymentFinalityQuery) => unknown = (query) => ({ outcome: 'final', evidence: exactEvidence(query) }), authorityId = FINALITY_AUTHORITY_ID): ScriptedFinalityAuthority {
  const queries: PaymentFinalityQuery[] = [];
  const authority: ScriptedFinalityAuthority = {
    authorityId,
    queries,
    answer,
    async verifyFinality(query: PaymentFinalityQuery): Promise<PaymentFinalityAnswer> {
      queries.push(query);
      return (await authority.answer(query)) as PaymentFinalityAnswer;
    },
  };
  return authority;
}

export interface SettlementHarness {
  readonly service: PaymentSettlementService;
  readonly store: PaymentSettlementStore;
  readonly authority: ScriptedFinalityAuthority;
  readonly resolutions: ExecutionResolutionStore;
}

export function settlementHarness(
  world: GovernedWorld,
  options: { readonly store?: PaymentSettlementStore; readonly authority?: ScriptedFinalityAuthority; readonly resolutions?: ExecutionResolutionStore; readonly now?: () => string } = {},
): SettlementHarness {
  const store = options.store ?? createInMemoryPaymentSettlementStore({ now: () => NOW });
  const authority = options.authority ?? finalityAuthority();
  const resolutions = options.resolutions ?? createInMemoryExecutionResolutionStore({ now: () => NOW });
  const service = createPaymentSettlementService({
    outcomes: world.outcomes,
    resolutions,
    governance: world.rawStore,
    payments: [BINDING],
    store,
    authorities: [authority],
    selectAuthority: () => FINALITY_AUTHORITY_ID,
    now: options.now ?? (() => NOW),
  });
  return { service, store, authority, resolutions };
}

/** P12, composed exactly as an embedder would: one trusted authority, adopted onto the uncertain execution, asked once. */
export async function resolveByP12(world: GovernedWorld, resolutions: ExecutionResolutionStore, executionId: string, answer: Awaited<ReturnType<ExecutionResolutionAuthority['resolve']>>): Promise<ExecutionReconciliationService> {
  const authority: ExecutionResolutionAuthority = { authorityId: 'test.p12', resolve: async () => answer };
  const service = createExecutionReconciliationService({
    outcomes: world.outcomes,
    resolutions,
    composition: snapshotResolutionAuthorities([authority], () => 'test.p12', 'test'),
    claimed: async () => true,
    now: () => NOW,
  });
  const adopted = await service.adoptResolutionAuthority({ organizationId: ORG, executionId, authorityId: 'test.p12' });
  assert.ok(adopted.outcome === 'bound' || adopted.outcome === 'existing', JSON.stringify(adopted));
  const reconciled = await service.reconcile({ organizationId: ORG, executionId });
  assert.ok(reconciled.outcome === 'resolved' || reconciled.outcome === 'unresolved', JSON.stringify(reconciled));
  return service;
}

export function scratchDirectory(prefix: string): { dir(): string; cleanup(): void } {
  const made: string[] = [];
  return {
    dir() {
      const directory = mkdtempSync(join(tmpdir(), prefix));
      made.push(directory);
      return directory;
    },
    cleanup() {
      for (const directory of made.splice(0)) rmSync(directory, { recursive: true, force: true });
    },
  };
}
