import {
  DRAFT_CLOSURE_EMAIL,
  EMAIL_THREAD_EVIDENCE,
  PMFREAK_ACTOR_ID,
  PMFREAK_COMMUNICATION_TOKEN_ID,
  PMFREAK_DRAFTING_TOKEN_ID,
  PROJECT_SCOPE,
  READ_PROJECT_SUMMARY,
  SEND_CLIENT_FOLLOW_UP,
  TRUST_DOMAIN_ID,
  UNKNOWN_AGENT_ACTOR_ID,
  bridgeRecognitionRuntime,
  buildDatasysEnforcementFixture,
} from '../../features/action-enforcement/fixtures/datasys-enforcement.fixture.js';
import { createManualEnforcementClock, createSequentialEnforcementIdGenerator } from '../../features/action-enforcement/runtime/enforcement-runtime-context.js';
import { createInMemoryObligationDischargeProvider } from '../../features/obligation-runtime/index.js';
import {
  createInMemoryBoundedGrantStore,
  type BoundedGrantStorePort,
  type GrantCorrelation,
  type GrantSourceAuthorization,
  type IssueBoundedGrantInput,
  type IssueBoundedGrantOutcome,
} from '../../features/grant-runtime/index.js';
import { createRecordingExecutionAdapter, type RecordingExecutionAdapter } from '../../features/execution-runtime/tests/execution-fixture.js';
import type { ExecutionAdapter, ExecutionAdapterResult, ValidatedExecutionAction } from '../../features/execution-runtime/index.js';
import type { EmergencyControlReaderPort } from '../../features/emergency-control-runtime/index.js';
import { createFinancialActionClassifier, createMonetaryAssetRegistry } from '../../features/monetary-runtime/index.js';
import { AocKernel, type KernelEvaluationOptions, type KernelEvaluationRequest, type KernelEvaluationResult } from '../../kernel/index.js';
import { KernelGrantCapability } from '../../kernel/orchestration/grant-adapter.js';
import type { AuthorityEventRecorder } from '../authority-event-stream/recorder.js';
import type { BoundCustomerIdentity } from '../customer-identity/index.js';
import { createInProcessEventPublisher, type EnterpriseEvent } from '../events/enterprise-events.js';
import {
  createAuthorityControlledExecution,
  type AuthorityControlledExecutionService,
  type ExecutionKernelPort,
  type GrantAuthorityBinding,
  type GrantAuthorityBindingQuery,
} from '../execution-governance/index.js';
import { createAuthorityControlledIssuanceCore } from '../execution-governance/issuance-core.js';
import type { AuthorityControlledExerciseControls } from '../execution-governance/exercise-controls.js';
import type { GovernanceStore } from '../governance-store/governance-store.js';
import { createInMemoryGovernanceStore } from '../governance-store/in-memory-governance-store.js';
import {
  createGovernedActionOrchestrator,
  type GovernedActionGrantPolicy,
  type GovernedActionOrchestrator,
  type GovernedActionOrchestratorOptions,
  type GovernedActionMonetaryTrust,
} from '../governed-action/index.js';

/**
 * A real governed-action world: the real `AocKernel` over the Datasys fixture
 * (no fake decision engine), the real in-memory Governance Store, the real
 * in-memory bounded-grant store, real ACE, and a recording adapter — each
 * wrapped only to *record* calls into one shared, ordered log, or to inject a
 * failure a test names explicitly.
 */

export const ORG = 'org-datasys';
export const NOW = '2026-01-01T00:00:00.000Z';
export const GRANT_LIFETIME_MS = 10 * 60 * 1000;

export const IDENTITY: BoundCustomerIdentity = Object.freeze({
  principal: Object.freeze({ plane: 'customer', principalId: 'principal-pmfreak', organizationId: ORG, externalSubject: Object.freeze({ system: 'datasys-app', subjectId: 'user-pmfreak' }) }),
  actor: Object.freeze({ actorId: PMFREAK_ACTOR_ID }),
});

export function identityFor(overrides: { readonly principalId?: string; readonly organizationId?: string; readonly actorId?: string } = {}): BoundCustomerIdentity {
  return {
    principal: {
      plane: 'customer',
      principalId: overrides.principalId ?? IDENTITY.principal.principalId,
      organizationId: overrides.organizationId ?? ORG,
      externalSubject: IDENTITY.principal.externalSubject,
    },
    actor: { actorId: overrides.actorId ?? PMFREAK_ACTOR_ID },
  };
}

export const ALLOWED_INTENT = Object.freeze({
  action: DRAFT_CLOSURE_EMAIL,
  resource: PROJECT_SCOPE,
  assertedContext: { passportId: 'passport-pmfreak', capabilityTokenId: PMFREAK_DRAFTING_TOKEN_ID, evidence: EMAIL_THREAD_EVIDENCE },
  idempotencyKey: 'key-allowed',
});

export const APPROVAL_INTENT = Object.freeze({
  action: SEND_CLIENT_FOLLOW_UP,
  resource: PROJECT_SCOPE,
  assertedContext: { passportId: 'passport-pmfreak', capabilityTokenId: PMFREAK_COMMUNICATION_TOKEN_ID },
  idempotencyKey: 'key-approval',
});

/** P9: the assets every test world recognizes. */
export const TEST_ASSETS = createMonetaryAssetRegistry([
  { assetId: 'USD', scale: 2 },
  { assetId: 'EUR', scale: 2 },
]);

/** P9 default: nothing is financial, so no intent in the default world may carry an amount. */
export const TEST_MONETARY: GovernedActionMonetaryTrust = Object.freeze({ assets: TEST_ASSETS, actionClassifier: createFinancialActionClassifier({ financialActions: [] }) });

/**
 * P9: a world whose host classifies the drafting action as financial — the one
 * action the Datasys fixture's Kernel allows — so the monetary path can be
 * driven end to end through a real allowed decision.
 */
export const DRAFTING_IS_FINANCIAL: GovernedActionMonetaryTrust = Object.freeze({
  assets: TEST_ASSETS,
  actionClassifier: createFinancialActionClassifier({ financialActions: [DRAFT_CLOSURE_EMAIL] }),
});

export const DENIED_ACTOR = UNKNOWN_AGENT_ACTOR_ID;
export const DENIED_INTENT = Object.freeze({ action: READ_PROJECT_SUMMARY, resource: PROJECT_SCOPE, idempotencyKey: 'key-denied' });

export const NO_TEMPORAL_BOUND: GrantAuthorityBinding = {
  kind: 'no-temporal-authority-bound',
  sourceKind: 'standing-capability',
  justification: 'Capability-token authority resolved per evaluation; no mandate window governs this action.',
};

/** The trusted policy the tests use: ten minutes from the *committed decision*, so a retry re-derives the same grant. */
export const EVALUATED_AT_POLICY: GovernedActionGrantPolicy = (query) => ({ grantExpiresAt: new Date(Date.parse(query.evaluatedAt) + GRANT_LIFETIME_MS).toISOString() });

export interface CallLog {
  readonly entries: string[];
  indexOf(entry: string): number;
}

function createCallLog(): CallLog {
  const entries: string[] = [];
  return { entries, indexOf: (entry) => entries.indexOf(entry) };
}

export type StoreFault = Partial<Record<'appendEvaluation' | 'getByEvaluationId' | 'verify' | 'resolveIdempotency' | 'getByRequestId', true>> & {
  /** Throw on appendReference when the reference type matches. */
  readonly appendReferenceFor?: readonly ('authorization_artifact' | 'execution_record')[];
  /** Throw only on the execution *outcome* append (the second `execution_record`). */
  readonly appendOutcomeReference?: true;
  /** Transform the record `getByEvaluationId` returns — the persisted-source mismatch double. */
  readonly tamperRead?: (record: NonNullable<Awaited<ReturnType<GovernanceStore['getByEvaluationId']>>>) => NonNullable<Awaited<ReturnType<GovernanceStore['getByEvaluationId']>>>;
  /** Report `verify()` as invalid. */
  readonly verifyInvalid?: true;
};

export interface GovernedWorld {
  readonly orchestrator: GovernedActionOrchestrator;
  readonly ace: AuthorityControlledExecutionService;
  readonly store: GovernanceStore;
  readonly rawStore: GovernanceStore;
  readonly grantStore: BoundedGrantStorePort;
  readonly adapter: RecordingExecutionAdapter;
  readonly log: CallLog;
  readonly kernelRequests: KernelEvaluationRequest[];
  readonly kernelResults: KernelEvaluationResult[];
  /** Every source the host revalidator answered, in order. */
  readonly revalidatedSources: (GrantSourceAuthorization | undefined)[];
  readonly accessContexts: unknown[];
  readonly issueOutcomes: IssueBoundedGrantOutcome[];
  readonly events: EnterpriseEvent[];
  readonly clock: ReturnType<typeof createManualEnforcementClock>;
  readonly grantCapability: KernelGrantCapability;
}

export interface WorldOptions {
  readonly organizationId?: string;
  readonly store?: GovernanceStore;
  readonly grantStore?: BoundedGrantStorePort;
  readonly storeFault?: StoreFault;
  readonly grantIssueThrows?: true;
  readonly obligationsPending?: true;
  readonly kernelOverride?: (result: KernelEvaluationResult) => KernelEvaluationResult;
  readonly kernelThrows?: Error;
  readonly resolveAuthorityBinding?: (query: GrantAuthorityBindingQuery) => GrantAuthorityBinding | undefined;
  readonly grantPolicy?: GovernedActionGrantPolicy;
  readonly adapterBehaviour?: (action: ValidatedExecutionAction) => ExecutionAdapterResult | Promise<ExecutionAdapterResult>;
  /** Wraps ACE's exercise port — used to revoke or expire a grant between issuance and exercise. */
  readonly beforeAssess?: (world: { readonly ace: AuthorityControlledExecutionService; readonly clock: ReturnType<typeof createManualEnforcementClock> }, grantId: string) => Promise<void>;
  /** Wraps ACE's exercise itself — after the pre-assessment and the write-ahead claim, so a refusal here is a *recorded* withheld outcome. */
  readonly beforeExercise?: (world: { readonly ace: AuthorityControlledExecutionService; readonly clock: ReturnType<typeof createManualEnforcementClock> }, grantId: string) => Promise<void>;
  readonly log?: CallLog;
  readonly clock?: ReturnType<typeof createManualEnforcementClock>;
  readonly adapter?: RecordingExecutionAdapter;
  readonly kernelIdStart?: number;
  /** The host-level ACE `revalidateSource`, handed to the orchestrator. Receives the world so it can derive the current source. */
  readonly revalidateSource?: (correlation: GrantCorrelation, world: GovernedWorld) => GrantSourceAuthorization | undefined;
  /**
   * The operational interlock, handed to **every** checkpoint: the
   * orchestrator's admission check, the grant store's synchronous commit guard,
   * the exercise gate, and the adapter registry when one is composed. One
   * instance, exactly as the composition root wires it.
   */
  readonly emergencyControl?: EmergencyControlReaderPort;
  /**
   * Runs immediately before the grant store's `issue` — which is to say
   * **after** the orchestrator's admission check and **before** the store's
   * synchronous commit guard runs inside it.
   *
   * That is precisely the TOCTOU window the commit-boundary recheck exists to
   * close, and this is the only way to stand in it.
   */
  readonly beforeGrantIssue?: () => void;
  /** An execution adapter to compose instead of the recording one — an adapter registry, for the adapter-scoped checkpoint. */
  readonly executionAdapter?: ExecutionAdapter;
  /** P7 exercise controls, composed onto ACE exactly as the composition root composes them — with the world's own classifier, as the root supplies its one instance. */
  readonly exerciseControls?: Omit<AuthorityControlledExerciseControls, 'actionClassifier'>;
  /** P9 trusted monetary configuration. Defaults to `TEST_MONETARY`: USD and EUR at scale 2, and no financial action. */
  readonly monetary?: GovernedActionMonetaryTrust;
  /** P8 write-only evidence recorder, handed to ACE and the orchestrator exactly as the composition root hands it. */
  readonly evidence?: AuthorityEventRecorder;
}

export function buildGovernedWorld(options: WorldOptions = {}): GovernedWorld {
  const monetary = options.monetary ?? TEST_MONETARY;
  const log = options.log ?? createCallLog();
  const clock = options.clock ?? createManualEnforcementClock(NOW);
  const fixture = buildDatasysEnforcementFixture();
  const grantCapability = new KernelGrantCapability({ declaration: {} });
  const realKernel = new AocKernel({
    recognitionProvider: bridgeRecognitionRuntime(fixture.recognitionRuntime),
    clock,
    idGenerator: createSequentialEnforcementIdGenerator(options.kernelIdStart ?? 1),
    grants: { declaration: {} },
    ...(options.obligationsPending === true
      ? {
          obligations: {
            provider: createInMemoryObligationDischargeProvider([]),
            sources: [{ id: 'obl.src.approval.finance', kind: 'approval_runtime', name: 'Finance approvals', verificationClass: 'independent' }],
            declaration: { requirements: [{ obligationType: 'finance.approval', blocking: true }] },
          },
        }
      : {}),
  });

  const kernelRequests: KernelEvaluationRequest[] = [];
  const kernelResults: KernelEvaluationResult[] = [];
  const kernel: ExecutionKernelPort = {
    async evaluate(request: KernelEvaluationRequest, evaluationOptions?: KernelEvaluationOptions): Promise<KernelEvaluationResult> {
      log.entries.push('kernel.evaluate');
      kernelRequests.push(request);
      if (options.kernelThrows !== undefined) throw options.kernelThrows;
      const raw = await realKernel.evaluate(request, evaluationOptions);
      const result = options.kernelOverride === undefined ? raw : options.kernelOverride(raw);
      kernelResults.push(result);
      return result;
    },
  };

  const rawStore = options.store ?? createInMemoryGovernanceStore();
  const accessContexts: unknown[] = [];
  const fault = options.storeFault ?? {};
  const store: GovernanceStore = new Proxy(rawStore, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver) as unknown;
      if (typeof value !== 'function') return value;
      const name = String(property);
      return async (...args: unknown[]) => {
        log.entries.push(`store.${name}`);
        if (args[0] !== undefined && typeof args[0] === 'object' && args[0] !== null && 'system' in args[0]) accessContexts.push(args[0]);
        if (name === 'appendEvaluation') accessContexts.push((args[0] as { accessContext: unknown }).accessContext);
        if ((fault as Record<string, unknown>)[name] === true) throw new Error(`injected ${name} failure`);
        if (name === 'appendReference') {
          const reference = args[1] as { referenceType: 'authorization_artifact' | 'execution_record'; externalVersion?: string };
          if (fault.appendReferenceFor?.includes(reference.referenceType) === true) throw new Error('injected appendReference failure');
          if (reference.referenceType === 'execution_record' && fault.appendOutcomeReference === true && reference.externalVersion !== 'attempt') {
            throw new Error('injected outcome reference failure');
          }
          log.entries.push(`store.appendReference:${reference.referenceType}:${reference.externalVersion ?? ''}`);
        }
        const out = await (value as (...inner: unknown[]) => Promise<unknown>).apply(target, args);
        if (name === 'getByEvaluationId' && out !== null && fault.tamperRead !== undefined) {
          return fault.tamperRead(out as NonNullable<Awaited<ReturnType<GovernanceStore['getByEvaluationId']>>>);
        }
        if (name === 'verify' && fault.verifyInvalid === true) return { ...(out as object), valid: false };
        return out;
      };
    },
  });

  const rawGrantStore = options.grantStore ?? createInMemoryBoundedGrantStore();
  const issueOutcomes: IssueBoundedGrantOutcome[] = [];
  const grantStore: BoundedGrantStorePort = {
    async issue(input: IssueBoundedGrantInput) {
      log.entries.push('grantStore.issue');
      if (options.grantIssueThrows === true) throw new Error('injected grant store failure');
      // The commit-boundary window: admission has already passed, and the
      // store's synchronous guard has not yet run.
      options.beforeGrantIssue?.();
      const outcome = await rawGrantStore.issue(input);
      issueOutcomes.push(outcome);
      return outcome;
    },
    read: (grantId) => rawGrantStore.read(grantId),
    revoke: (input) => rawGrantStore.revoke(input),
  };

  const adapter =
    options.adapter ??
    createRecordingExecutionAdapter(async (action) => {
      log.entries.push('adapter.execute');
      return options.adapterBehaviour === undefined ? { outcome: 'completed', providerRef: 'provider-ref-1' } : options.adapterBehaviour(action);
    });

  const aceOptions = {
    kernel,
    grantCapability,
    grantStore,
    executionAdapter: options.executionAdapter ?? adapter,
    now: () => clock.now(),
    resolveAuthorityBinding: options.resolveAuthorityBinding ?? (() => NO_TEMPORAL_BOUND),
    ...(options.emergencyControl !== undefined ? { emergencyControl: options.emergencyControl } : {}),
    ...(options.exerciseControls !== undefined ? { exerciseControls: { ...options.exerciseControls, actionClassifier: monetary.actionClassifier } } : {}),
    ...(options.evidence !== undefined ? { evidence: options.evidence } : {}),
  };
  const ace = createAuthorityControlledExecution(aceOptions);

  const execution: GovernedActionOrchestratorOptions['execution'] =
    options.beforeAssess === undefined && options.beforeExercise === undefined
      ? ace
      : {
          async assessExercise(request) {
            await options.beforeAssess?.({ ace, clock }, request.boundedGrantId);
            return ace.assessExercise(request);
          },
          async exercise(request) {
            await options.beforeExercise?.({ ace, clock }, request.boundedGrantId);
            return ace.exercise(request);
          },
        };

  const events: EnterpriseEvent[] = [];
  const publisher = createInProcessEventPublisher();
  publisher.subscribe((event) => events.push(event));
  let eventCounter = 0;
  const revalidatedSources: (GrantSourceAuthorization | undefined)[] = [];
  const hostRevalidate = options.revalidateSource;

  const orchestrator = createGovernedActionOrchestrator({
    organizationId: options.organizationId ?? ORG,
    trustDomainId: TRUST_DOMAIN_ID,
    issuance: createAuthorityControlledIssuanceCore(aceOptions),
    execution,
    governanceStore: store,
    grantPolicy: options.grantPolicy ?? EVALUATED_AT_POLICY,
    monetary,
    now: () => clock.now(),
    enterpriseContext: () => ({ enterpriseVersion: 'test', lifecycleState: 'ready', modules: [], environment: 'test' }),
    events: { enabled: true, publisher, nextId: (prefix) => `${prefix}-${(eventCounter += 1)}` },
    traceLevel: 'basic',
    ...(options.emergencyControl !== undefined ? { emergencyControl: options.emergencyControl } : {}),
    ...(options.evidence !== undefined ? { evidence: options.evidence } : {}),
    ...(hostRevalidate !== undefined
      ? {
          revalidateSource: (correlation: GrantCorrelation) => {
            const current = hostRevalidate(correlation, world);
            revalidatedSources.push(current);
            return current;
          },
        }
      : {}),
  });

  const world: GovernedWorld = { orchestrator, ace, store, rawStore, grantStore, adapter, log, kernelRequests, kernelResults, revalidatedSources, accessContexts, issueOutcomes, events, clock, grantCapability };
  return world;
}

export { TRUST_DOMAIN_ID, PMFREAK_ACTOR_ID };
