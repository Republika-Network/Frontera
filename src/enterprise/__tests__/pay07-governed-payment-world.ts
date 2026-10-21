import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createInMemoryExerciseControlLedger } from '../../features/exercise-control-runtime/index.js';
import { createInMemoryBoundedGrantStore } from '../../features/grant-runtime/index.js';
import { createFinancialActionClassifier, createMonetaryAssetRegistry, type MonetaryAssetDefinition } from '../../features/monetary-runtime/index.js';
import {
  PAYMENT_PARAMETER_DIMENSIONS,
  PAYMENT_PROFILE_PARAMETERS,
  PAYMENT_PROTOCOL_RESERVED_CONTEXT_KEYS,
  createPaymentGovernanceBinding,
  createPaymentRailExecutionAdapter,
  type PaymentDestination,
  type PaymentExecutionRequest,
  type PaymentFinalityAuthority,
  type PaymentRail,
} from '../../features/payment-runtime/index.js';
import { MPP_RESERVED_CONTEXT_KEYS, createMppPaymentProtocolAdapter, type MppMethodNormalizer } from '../../features/payment-runtime/protocols/mpp/index.js';
import { encodeJcs, onlyCandidate } from '../../features/payment-runtime/protocols/mpp/tests/mpp-test-support.js';
import type {
  ConformanceAmount,
  ConformanceGoverned,
  ConformanceIngress,
  ConformanceInstruction,
  ConformanceObservation,
  ConformanceReconciliation,
  ConformanceRollback,
  ConformanceScenario,
  ConformanceSettlement,
  ConformanceTrace,
  ConformanceWorld,
  PaymentRailConformanceHarness,
} from '../../features/payment-runtime/tests/conformance/payment-rail-conformance-suite.js';
import { createAuthorityEventProjector, createInMemoryAuthorityEventStreamStore, type AuthorityEventProjector } from '../authority-event-stream/index.js';
import { authorityTraceVerificationOf, buildAuthorityTrace, type AuthorityTraceSources } from '../evidence/trace-builder.js';
import { snapshotResolutionAuthorities, type ExecutionResolutionAuthority } from '../execution-reconciliation/authority.js';
import { createExecutionReconciliationService } from '../execution-reconciliation/service.js';
import type { ExecutionOutcomeStore } from '../execution-outcome-store/outcome-store.js';
import { createSqliteExecutionOutcomeStore } from '../execution-outcome-store/sqlite-execution-outcome-store.js';
import type { ExecutionResolutionStore } from '../execution-resolution-store/resolution-store.js';
import { createSqliteExecutionResolutionStore } from '../execution-resolution-store/sqlite-execution-resolution-store.js';
import { createGovernanceProfileRegistry } from '../governance-profile/index.js';
import { createInMemoryGovernanceStore } from '../governance-store/in-memory-governance-store.js';
import { createExecutionLedger, executionClaimRecorded } from '../governed-action/execution-ledger.js';
import type { GovernedActionResult } from '../governed-action/index.js';
import { createPaymentProtocolIngress, createSqlitePaymentBusinessOperationStore, type DurablePaymentBusinessOperationStore, type PaymentProtocolIngress, type PaymentProtocolIngressResult } from '../payment-protocol-ingress/index.js';
import { createPaymentSettlementService, createSqlitePaymentSettlementStore, verifyPaymentReceipt, type PaymentSettlementStore } from '../payment-settlement/index.js';
import { drained } from './authority-event-stream-support.js';
import { boundaryFor, startWitness, type StartedWitness } from './core07-freshness-fixture.js';
import { ALLOWED_INTENT, DENIED_ACTOR, IDENTITY, NO_TEMPORAL_BOUND, NOW, ORG, buildGovernedWorld, identityFor, monetaryAuthority, type GovernedWorld } from './governed-action-support.js';

/**
 * PAY-07 — the ONE governed payment world every rail is qualified inside.
 *
 * This file is rail-neutral by construction: it composes the shared stack —
 * the real Kernel, Governance Store, CORE-03 profile, P10 ceiling, grant store,
 * ACE, P7, P11 (SQLite), P12 (SQLite), PAY-04 MPP ingress (SQLite, anchored at
 * a real CORE-07 witness), PAY-05 settlement (SQLite), the P8 event stream and
 * the ASSURE-01 trace builder and verifier — **identically** for every rail,
 * and reaches the rail only through PAY-01's `createPaymentRailExecutionAdapter`.
 * It imports nothing from any rail (`pay07-multi-rail-structure.test.ts`).
 *
 * Everything rail-specific — the rail object, its provider simulator, its
 * durable interlock, its read-only P12 and finality authorities, its trusted
 * MPP method normalizer and counterparty directory — arrives through one
 * `PaymentRailEdge`, built in `pay07-xrpl-edge.ts` and `pay07-lightning-edge.ts`.
 *
 * Held constant across rails: organization, principal, actor, authority
 * lineage, Governance Profile, policy, binding, ceiling *relationship*,
 * lifetime limit relationship, grant policy, P7 policy, business operation,
 * protected request, purpose, business reference, MPP realm and expiry. What
 * differs is only what is an external fact: the rail, its asset and exact
 * unit, the destination, the provider and its evidence.
 */

/** The same payment action, account, binding and profile for every rail. */
export const PAYMENT_ACTION = ALLOWED_INTENT.action;
export const GOVERNED_ACCOUNT = ALLOWED_INTENT.resource;
export const BINDING = createPaymentGovernanceBinding({ action: PAYMENT_ACTION });
export const BUSINESS_OPERATION = 'pay07-checkout-1';
export const BUSINESS_REFERENCE = 'INV-PAY07-1';
export const PROTECTED_REQUEST = Object.freeze({ target: 'merchant:report-42', method: 'GET' });
export const MPP_REALM = 'api.merchant.example';

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
  reservedContextKeys: [...PAYMENT_PROTOCOL_RESERVED_CONTEXT_KEYS, ...MPP_RESERVED_CONTEXT_KEYS],
});

/** One rail's composition, opened inside one world. Generic types only; rail objects stay behind it. */
export interface OpenedPaymentRailEdge {
  readonly rail: PaymentRail;
  /** Trusted, rail-specific preparation of the payee for one payment (an invoice, a tagged account): the merchant reference the challenge names and the PAY-01 destination the trusted directory maps it to. */
  preparePayee(amount: ConformanceAmount, label: string): Promise<{ readonly merchantReference: string; readonly destination: PaymentDestination }>;
  /** Sets what the provider does with the next instruction. */
  behave(behaviour: ConformanceScenario['behaviour']): void;
  /** External money-moving calls at the provider boundary (a submission, a send). Reads never count. */
  effects(): number;
  /** The provider becomes definitive about the uncertain payment. Moves nothing. */
  resolveExternally(outcome: 'completed' | 'not-completed'): Promise<void>;
  /** The rail's read-only P12 authority over the current durable state. */
  resolutionAuthority(): ExecutionResolutionAuthority;
  /** The rail's read-only PAY-05 finality authority over the current durable state. */
  finalityAuthority(): PaymentFinalityAuthority;
  /** Recomposes the rail and its durable interlock over the same files. */
  restart(): Promise<void>;
  /** Restores the interlock file captured before any payment and reopens it. */
  rollback(): Promise<ConformanceRollback>;
  close(): Promise<void>;
}

export interface PaymentRailEdge {
  readonly implementationId: string;
  readonly railId: string;
  readonly asset: MonetaryAssetDefinition;
  readonly economics: PaymentRailConformanceHarness['economics'];
  /** The lifetime limit, in the asset's own unit. Same relationship to the ceiling on every rail. */
  readonly lifetime: string;
  /** Trusted host composition: how this deployment reads the merchant's MPP method. */
  readonly mppMethod: MppMethodNormalizer;
  /** The decoded MPP `request` object the merchant states for an amount and merchant reference. */
  mppRequest(amount: ConformanceAmount, merchantReference: string): Record<string, unknown>;
  open(context: { readonly directory: string; readonly witness: StartedWitness; readonly organizationId: string; readonly accountId: string }): Promise<OpenedPaymentRailEdge>;
}

const directories: string[] = [];
export function cleanupPay07Directories(): void {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
}

function governedView(outcome: PaymentProtocolIngressResult): ConformanceGoverned {
  if (outcome.outcome !== 'governed') return { ingress: outcome.outcome, reasonCodes: [], ...(outcome.outcome === 'refused' ? { failure: outcome.refusal } : {}) };
  const result: GovernedActionResult = outcome.result;
  return {
    ingress: 'governed',
    status: result.status,
    ...(result.requestId !== undefined ? { requestId: result.requestId } : {}),
    ...(result.executionId !== undefined ? { executionId: result.executionId } : {}),
    reasonCodes: [...result.reasonCodes],
    ...(result.status === 'withheld' ? { withheldBy: result.withheldBy } : {}),
    ...(result.status === 'execution_failed' ? { failure: result.failure } : {}),
    ...(result.status === 'executed' && result.providerRef !== undefined ? { providerRef: result.providerRef } : {}),
    ...(result.status === 'executed' || result.status === 'execution_failed' ? { replayed: result.replayed } : {}),
  };
}

const instructionView = (request: PaymentExecutionRequest): ConformanceInstruction =>
  Object.freeze({
    executionId: request.executionId,
    requestId: request.requestId,
    amount: Object.freeze({ value: request.amount.value, unit: request.amount.unit }),
    sourceAccountId: request.source.accountId,
    destination: Object.freeze({ kind: request.destination.kind, reference: request.destination.reference }),
    purpose: request.purpose,
  });

let ingressTick = 0;
/** The merchant's challenges expire at 12:05; the ingress observes at 12:00 (independent of the governance clock). */
const ingressClock = (): string => new Date(Date.parse('2026-09-24T12:00:00.000Z') + (ingressTick += 1)).toISOString();

/**
 * Builds the conformance harness for one rail edge: every `open()` composes a
 * fresh, isolated world around it, the same way for every rail.
 */
export function createGovernedPaymentHarness(edge: PaymentRailEdge, coreManifestDigest: string): PaymentRailConformanceHarness {
  return Object.freeze({
    implementationId: edge.implementationId,
    coreManifestDigest,
    economics: edge.economics,
    open: (scenario: ConformanceScenario) => openWorld(edge, scenario),
  });
}

async function openWorld(edge: PaymentRailEdge, scenario: ConformanceScenario): Promise<ConformanceWorld> {
  const directory = mkdtempSync(join(tmpdir(), 'frontera-pay07-'));
  directories.push(directory);
  const paths = {
    outcomes: join(directory, 'outcomes.sqlite'),
    resolutions: join(directory, 'resolutions.sqlite'),
    settlements: join(directory, 'settlements.sqlite'),
    operations: join(directory, 'business-operations.sqlite'),
  };
  const witness = await startWitness();
  // The world's own USD definition, plus the rail's asset — once, when the rail's asset IS the world's USD (a fiat rail).
  // Keyed on the asset definition, never on which rail is composed: a conflicting USD scale is refused, not merged.
  const WORLD_USD = { assetId: 'USD', scale: 2 } as const;
  if (edge.asset.assetId === WORLD_USD.assetId && edge.asset.scale !== WORLD_USD.scale) throw new Error('pay07: the rail redefines the world USD asset with another scale');
  const assets = createMonetaryAssetRegistry(edge.asset.assetId === WORLD_USD.assetId ? [WORLD_USD] : [WORLD_USD, edge.asset]);
  const monetary = Object.freeze({ assets, actionClassifier: createFinancialActionClassifier({ financialActions: [PAYMENT_ACTION] }) });
  const opened = await edge.open({ directory, witness, organizationId: ORG, accountId: GOVERNED_ACCOUNT });

  // The canonical stores that live in memory in this world, kept across a recomposition exactly as a durable store would be.
  const governanceStore = createInMemoryGovernanceStore();
  const grantStore = createInMemoryBoundedGrantStore();
  const reservationLedger = createInMemoryExerciseControlLedger({ now: () => NOW });
  const eventStream = createInMemoryAuthorityEventStreamStore({ now: () => NOW });

  const amount = scenario.amount === 'within-ceiling' ? edge.economics.withinCeiling : edge.economics.overCeiling;
  const payee = await opened.preparePayee(amount, `pay07-${scenario.amount}-${scenario.behaviour}`);
  opened.behave(scenario.behaviour);
  const identity = scenario.principal === 'authorized' ? IDENTITY : identityFor({ actorId: DENIED_ACTOR });
  const challenge = `Payment id="ch-1", realm="${MPP_REALM}", method="${edge.mppMethod.methodId}", intent="charge", request="${encodeJcs(edge.mppRequest(amount, payee.merchantReference))}", expires="2026-09-24T12:05:00Z"`;

  const instructions: ConformanceInstruction[] = [];
  const governedIntents: unknown[] = [];
  let revokeArmed = scenario.revokeAfterClaim;
  let generation = 0;

  interface Composed {
    world: GovernedWorld;
    projector: AuthorityEventProjector;
    outcomes: ExecutionOutcomeStore;
    resolutions: ExecutionResolutionStore;
    settlements: PaymentSettlementStore;
    operations: DurablePaymentBusinessOperationStore;
    ingress: PaymentProtocolIngress;
  }

  async function compose(): Promise<Composed> {
    generation += 1;
    const outcomes = await createSqliteExecutionOutcomeStore(paths.outcomes, { now: () => NOW });
    const resolutions = await createSqliteExecutionResolutionStore(paths.resolutions, { now: () => NOW });
    const settlements = await createSqlitePaymentSettlementStore(paths.settlements, { now: () => NOW });
    const operations = await createSqlitePaymentBusinessOperationStore(paths.operations, { now: ingressClock, freshness: { boundary: await boundaryFor(witness, ORG) } });
    const projector = createAuthorityEventProjector({ organizationId: ORG, store: eventStream, grants: grantStore });
    // The rail port, observed: what PAY-01's bridge instructed. Instrumentation only — the bridge still invokes the rail once.
    const rail = opened.rail;
    const observedRail: PaymentRail = {
      railId: rail.railId,
      execute: (request) => {
        instructions.push(instructionView(request));
        return rail.execute(request);
      },
    };
    const world = buildGovernedWorld({
      store: governanceStore,
      grantStore,
      monetary,
      governance: GOVERNANCE,
      financialAuthority: monetaryAuthority(edge.economics.ceiling.value, edge.lifetime, edge.asset.assetId),
      exerciseControls: { policy: () => [], revalidateAuthorityBinding: () => NO_TEMPORAL_BOUND, reservationLedger },
      executionAdapter: createPaymentRailExecutionAdapter({ rail: observedRail, binding: BINDING }),
      executionOutcomes: outcomes,
      evidence: projector,
      kernelIdStart: generation * 1000,
      // The shared checkpoint: after the grant and the write-ahead claim, before the exercise gate.
      beforeExercise: async ({ ace }, grantId) => {
        if (!revokeArmed) return;
        revokeArmed = false;
        await ace.revokeGrant({ grantId, reason: 'security-incident', issuerRef: 'operator:on-call' });
      },
    });
    const orchestrator = {
      organizationId: world.orchestrator.organizationId,
      govern: (who: Parameters<GovernedWorld['orchestrator']['govern']>[0], intent: unknown) => {
        governedIntents.push(intent);
        return world.orchestrator.govern(who, intent);
      },
    };
    const adapter = createMppPaymentProtocolAdapter({
      methods: [edge.mppMethod],
      resolveCounterparty: (context) => (context.merchantReference === payee.merchantReference ? payee.destination : undefined),
      selectChallenge: onlyCandidate,
      assets,
    });
    const ingress = createPaymentProtocolIngress({ orchestrator, store: operations, adapters: [adapter], binding: BINDING, monetary, governance: GOVERNANCE, now: ingressClock });
    return { world, projector, outcomes, resolutions, settlements, operations, ingress };
  }

  let current = await compose();
  /** Kernel evaluations and grant issuances across recompositions. */
  const history = { kernelEvaluations: 0, grantsIssued: 0, kernelAmount: undefined as ConformanceAmount | undefined };
  const tally = (): { kernelEvaluations: number; grantsIssued: number } => ({
    kernelEvaluations: history.kernelEvaluations + current.world.kernelRequests.length,
    grantsIssued: history.grantsIssued + current.world.issueOutcomes.filter((issued) => issued.outcome === 'issued').length,
  });

  const present = async (): Promise<ConformanceGoverned> =>
    governedView(
      await current.ingress.prepareAndGovern(identity, {
        businessOperationId: BUSINESS_OPERATION,
        protocol: 'mpp',
        challenges: challenge,
        protectedRequest: PROTECTED_REQUEST,
        payment: { source: { accountId: GOVERNED_ACCOUNT }, purpose: 'vendor-payment' },
        envelope: { assertedContext: ALLOWED_INTENT.assertedContext },
      }),
    );

  function reconciliation() {
    const authority = opened.resolutionAuthority();
    const { world, outcomes, resolutions, projector } = current;
    return {
      authorityId: authority.authorityId,
      service: createExecutionReconciliationService({
        outcomes: Object.freeze({ read: (context: { readonly organizationId: string }, executionId: string) => outcomes.read(context, executionId) }),
        resolutions,
        composition: snapshotResolutionAuthorities([authority], () => authority.authorityId, 'pay07'),
        claimed: async (scope, evaluationId, executionId) => {
          const record = await world.rawStore.getByEvaluationId({ system: false, organizationId: scope.organizationId }, evaluationId);
          return record !== null && record.request.organizationId === scope.organizationId && executionClaimRecorded(record, executionId);
        },
        capacity: Object.freeze({ reconcileResolution: (input: Parameters<typeof reservationLedger.reconcileResolution>[0]) => reservationLedger.reconcileResolution(input) }),
        governanceEvidence: (scope, evaluationId, executionId, resolution) =>
          createExecutionLedger(world.rawStore, { system: false, organizationId: scope.organizationId }, () => world.clock.now()).recordResolution(evaluationId, executionId, {
            certainty: resolution.certainty,
            ...(resolution.failure !== undefined ? { failure: resolution.failure } : {}),
            resolutionDigest: resolution.resolutionDigest,
          }),
        evidence: projector,
        now: () => NOW,
      }),
    };
  }

  function settlementService() {
    const authority = opened.finalityAuthority();
    return createPaymentSettlementService({
      outcomes: current.outcomes,
      resolutions: current.resolutions,
      governance: current.world.rawStore,
      payments: [BINDING],
      store: current.settlements,
      authorities: [authority],
      selectAuthority: (context) => (context.railId === edge.railId || context.rail === edge.railId ? authority.authorityId : 'none'),
      now: () => NOW,
    });
  }

  async function traceSources(): Promise<AuthorityTraceSources> {
    // The projection is never awaited by the path that produced the facts; wait for it here, the one place waiting is correct.
    await drained(() => current.projector.health());
    const { world, outcomes, resolutions } = current;
    // Exactly the composition root's narrow reads (`composition-root.ts`, ASSURE-01): one read method per source.
    return {
      governance: {
        getByRequestId: (context, requestId) => world.rawStore.getByRequestId(context, requestId),
        verify: (context, evaluationId) => world.rawStore.verify(context, evaluationId),
        query: (context, query) => world.rawStore.query(context, query),
      },
      grants: { kind: 'unauthenticated', read: (grantId: string) => grantStore.read(grantId) },
      reservations: { read: (reservationId: string) => reservationLedger.read(reservationId) },
      outcomes: { read: (context: { readonly organizationId: string }, executionId: string) => outcomes.read(context, executionId) },
      resolutions: { read: (context: { readonly organizationId: string }, executionId: string) => resolutions.read(context, executionId) },
      events: { readStreamBounded: (context: { readonly organizationId: string }, streamId: string, options: { readonly maxEvents: number }) => eventStream.readStreamBounded(context, streamId, options) },
    };
  }

  async function settlementView(executionId: string, verify: boolean): Promise<ConformanceSettlement> {
    const service = settlementService();
    if (!verify) {
      const status = await service.readSettlement({ organizationId: ORG, executionId });
      return status.outcome === 'status' ? { outcome: 'status', state: status.state } : { outcome: status.outcome };
    }
    const verification = await service.verifySettlement({ organizationId: ORG, executionId });
    if (verification.outcome !== 'settled') return { outcome: verification.outcome, ...('state' in verification ? { state: verification.state } : {}) };
    const { settlement, receipt } = verification;
    return {
      outcome: 'settled',
      state: 'settled',
      basis: settlement.basis.kind,
      ...(settlement.railId !== undefined ? { railId: settlement.railId } : {}),
      providerRef: settlement.finality.providerRef,
      amount: { value: settlement.payment.amount.value, unit: settlement.payment.amount.unit },
      method: settlement.finality.method,
      factNames: settlement.finality.facts.map((fact) => fact.name),
      receiptValid: verifyPaymentReceipt(receipt, settlement).valid,
      receiptFormat: receipt.format,
      receiptRefersToSettlement: receipt.settlementId === settlement.settlementId && receipt.settlementContentDigest === settlement.contentDigest && receipt.executionId === executionId,
    };
  }

  const world: ConformanceWorld = {
    presentRequirement: present,
    replayRequirement: present,
    externalEffects: () => opened.effects(),
    railInstructions: () => Object.freeze([...instructions]),

    async ingress(): Promise<ConformanceIngress> {
      const first = await current.operations.readOperation({ organizationId: ORG }, identity.principal.principalId, BUSINESS_OPERATION);
      const kernel = current.world.kernelRequests[0] as unknown as { readonly action?: { readonly amount?: unknown; readonly currency?: unknown } } | undefined;
      if (kernel?.action !== undefined && typeof kernel.action.amount === 'string' && typeof kernel.action.currency === 'string') history.kernelAmount ??= { value: kernel.action.amount, unit: kernel.action.currency };
      const counts = tally();
      return {
        protocolId: first?.challenges[0]?.protocolId ?? 'none',
        intentAmount: first !== undefined ? { value: first.operation.terms.amount.value, unit: first.operation.terms.amount.unit } : { value: '', unit: '' },
        ...(first !== undefined ? { intentDestination: { kind: first.operation.terms.destination.kind, reference: first.operation.terms.destination.reference } } : {}),
        governedIntents: governedIntents.length,
        kernelEvaluations: counts.kernelEvaluations,
        ...(history.kernelAmount !== undefined ? { kernelAmount: history.kernelAmount } : {}),
        grantsIssued: counts.grantsIssued,
      };
    },

    async observation(executionId: string): Promise<ConformanceObservation | undefined> {
      const record = await current.outcomes.read({ organizationId: ORG }, executionId);
      if (record === undefined) return undefined;
      const observation = record.terminal?.observation as { readonly kind?: string; readonly certainty?: string; readonly providerRef?: string; readonly adapterId?: string } | undefined;
      const attemptAmount = (record.attempt as { readonly amount?: { readonly value: string; readonly unit: string } }).amount;
      return {
        ...(observation?.kind !== undefined ? { kind: observation.kind } : {}),
        ...(observation?.certainty !== undefined ? { certainty: observation.certainty } : {}),
        ...(observation?.providerRef !== undefined ? { providerRef: observation.providerRef } : {}),
        ...(observation?.adapterId !== undefined ? { adapterId: observation.adapterId } : {}),
        ...(attemptAmount !== undefined ? { amount: { value: attemptAmount.value, unit: attemptAmount.unit } } : {}),
      };
    },

    resolveExternally: (outcome) => opened.resolveExternally(outcome),

    async reconcile(executionId: string): Promise<ConformanceReconciliation> {
      const { authorityId, service } = reconciliation();
      await service.adoptResolutionAuthority({ organizationId: ORG, executionId, authorityId });
      const result = await service.reconcile({ organizationId: ORG, executionId });
      const state = await current.resolutions.read({ organizationId: ORG }, executionId);
      const record = await current.outcomes.read({ organizationId: ORG }, executionId);
      if (result.outcome !== 'resolved') return { outcome: result.outcome, recorded: state?.resolution !== undefined };
      return {
        outcome: result.established === 'previously' ? 'existing' : 'resolved',
        certainty: result.resolution.certainty,
        ...(result.resolution.providerRef !== undefined ? { providerRef: result.resolution.providerRef } : {}),
        boundToAttempt: result.resolution.attemptDigest === record?.attempt.attemptDigest,
        boundToObservation: result.resolution.basisObservationDigest === record?.terminal?.observationDigest,
        recorded: state?.resolution !== undefined,
      };
    },

    readSettlement: (executionId) => settlementView(executionId, false),
    verifySettlement: (executionId) => settlementView(executionId, true),

    async receipt(executionId: string): Promise<ConformanceSettlement> {
      const service = settlementService();
      const first = await service.receipt({ organizationId: ORG, executionId });
      if (first === undefined) return { outcome: 'no-receipt', receiptPresent: false };
      const second = await service.receipt({ organizationId: ORG, executionId });
      const status = await service.readSettlement({ organizationId: ORG, executionId });
      const settlement = status.outcome === 'status' ? status.settlement : undefined;
      return {
        outcome: 'receipt',
        receiptPresent: true,
        receiptFormat: first.format,
        receiptValid: settlement !== undefined && verifyPaymentReceipt(first, settlement).valid,
        receiptRefersToSettlement: settlement !== undefined && first.settlementId === settlement.settlementId && first.settlementContentDigest === settlement.contentDigest,
        receiptStable: second !== undefined && second.receiptDigest === first.receiptDigest,
      };
    },

    async trace(requestId: string): Promise<ConformanceTrace> {
      const build = await buildAuthorityTrace(await traceSources(), { system: false, organizationId: ORG }, requestId);
      if (build === null) return { found: false, verified: false, failedChecks: [], presence: {}, grantRecorded: false, grantRevoked: false, claimRecorded: false };
      const verification = authorityTraceVerificationOf(build, NOW);
      const { trace } = build;
      const stages = trace.stages;
      const grants = stages.authority.grants.filter((grant) => grant.presence === 'recorded');
      return {
        found: true,
        verified: verification.verified,
        failedChecks: verification.checks.filter((check) => check.status === 'fail').map((check) => `${check.category}:${check.check}:${check.detail ?? ''}`),
        requestId: trace.requestId,
        ...(trace.executionId !== undefined ? { executionId: trace.executionId } : {}),
        path: trace.path,
        finalState: trace.finalState,
        presence: Object.fromEntries(Object.entries(stages).map(([name, stage]) => [name, (stage as { presence: string }).presence])),
        ...(stages.outcome.kind !== undefined ? { outcomeKind: stages.outcome.kind } : {}),
        ...(stages.outcome.certainty !== undefined ? { outcomeCertainty: stages.outcome.certainty } : {}),
        ...(stages.outcome.providerRef !== undefined ? { providerRef: stages.outcome.providerRef } : {}),
        ...(stages.resolution.resolution !== undefined ? { resolutionCertainty: stages.resolution.resolution.certainty } : {}),
        grantRecorded: grants.length > 0,
        grantRevoked: grants.some((grant) => grant.revocation !== undefined),
        claimRecorded: stages.execution.claim?.presence === 'recorded',
        ...(stages.parameters.amount !== undefined ? { parametersAmount: { value: stages.parameters.amount.value, unit: stages.parameters.amount.unit } } : {}),
      };
    },

    async restart(): Promise<void> {
      await drained(() => current.projector.health());
      history.kernelEvaluations += current.world.kernelRequests.length;
      history.grantsIssued += current.world.issueOutcomes.filter((issued) => issued.outcome === 'issued').length;
      await Promise.all([current.outcomes.close(), current.resolutions.close(), current.settlements.close(), current.operations.close()]);
      await opened.restart();
      current = await compose();
    },

    rollbackRefused: () => opened.rollback(),

    async close(): Promise<void> {
      await drained(() => current.projector.health()).catch(() => false);
      await Promise.allSettled([current.outcomes.close(), current.resolutions.close(), current.settlements.close(), current.operations.close()]);
      await opened.close().catch(() => undefined);
      await witness.close().catch(() => undefined);
    },
  };
  return world;
}
