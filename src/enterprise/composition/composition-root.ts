import { randomUUID } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';

import { AOC_KERNEL_VERSION, createAocKernel, type AocKernel, type KernelIdGenerator, type PolicyPackProvider } from '../../kernel/index.js';
import { computeEnterpriseHealth, type EnterpriseHealthPosture, type EnterpriseHealthReport } from '../health/health-check.js';
import { loadEnterpriseConfiguration, toPublicEnterpriseConfiguration, type EnterpriseConfiguration, type PublicEnterpriseConfiguration } from '../configuration/enterprise-configuration.js';
import { createInProcessEventPublisher, type EnterpriseEventPublisher } from '../events/enterprise-events.js';
import {
  evaluateGovernanceRequest,
  type EnterpriseEvaluationResponse,
  type EvaluateGovernanceRequestInput,
} from '../orchestration/evaluate-governance-request.js';
import { governGovernedActionRequest } from '../orchestration/govern-governed-action-request.js';
import type { EnterpriseGovernedActionResponse } from '../api/governed-action-contract.js';
import { createInMemoryGovernanceStore } from '../governance-store/in-memory-governance-store.js';
import { createSqliteGovernanceStore } from '../governance-store/sqlite-governance-store.js';
import type { GovernanceStore } from '../governance-store/governance-store.js';
import type { GovernanceEnterpriseContext } from '../governance-store/contracts.js';
import { createGovernanceReadService, type GovernanceReadService } from '../orchestration/governance-read-service.js';
import { createInMemoryEvidenceStore, type EvidenceStore } from '../evidence/evidence-store.js';
import { createEvidenceService, type EvidenceService } from '../evidence/evidence-service.js';
import { createInMemoryPassportStore } from '../passport/in-memory-passport-store.js';
import { createSqlitePassportStore } from '../passport/sqlite-passport-store.js';
import type { AgentPassportStore } from '../passport/passport-store.js';
import { createAgentPassportService, type AgentPassportService } from '../passport/service.js';
import { createDefaultKernelProviders, type KernelProviderSet } from '../providers/kernel-provider-composition.js';
import { createInMemoryKernelAuthorityStore } from '../kernel-authority/in-memory-kernel-authority-store.js';
import { createSqliteKernelAuthorityStore } from '../kernel-authority/sqlite-kernel-authority-store.js';
import type { KernelAuthorityStore } from '../kernel-authority/kernel-authority-store.js';
import { createDurableKernelWorld, type DurableKernelWorld } from '../kernel-authority/durable-kernel-providers.js';
import { createKernelFinancialAuthorityResolver } from '../kernel-authority/financial-authority-resolver.js';
import { createKernelAuthorityProvisioningService, type KernelAuthorityProvisioningService } from '../kernel-authority/provisioning-service.js';
import { createKernelAuthorityModule, createUnavailableKernelAuthorityModule } from '../modules/kernel-authority-module.js';
import { createEnterpriseLogger, type EnterpriseLogger } from '../telemetry/enterprise-logger.js';
import { createEnterpriseTelemetry, type EnterpriseTelemetry } from '../telemetry/enterprise-telemetry.js';
import { EnterpriseHttpErrors } from '../api/enterprise-http-errors.js';
import { createAuthorityAdministrationService, type AuthorityAdministrationService } from '../authority-administration/service.js';
import { AOC_ENTERPRISE_HOST_VERSION } from '../version.js';
import { createEnterpriseModuleRegistry } from '../registry/enterprise-module-registry.js';
import { createEnterpriseLifecycleController } from '../lifecycle/enterprise-lifecycle-controller.js';
import type { EnterpriseLifecycleState, EnterpriseModule, EnterpriseModuleSnapshot } from '../modules/enterprise-module.js';
import { createTelemetryModule } from '../modules/telemetry-module.js';
import { createEventsModule } from '../modules/events-module.js';
import { createGovernanceStoreModule } from '../modules/governance-store-module.js';
import { createProvidersModule } from '../modules/providers-module.js';
import { createKernelModule } from '../modules/kernel-module.js';
import { createAgentPassportModule } from '../modules/passport-module.js';
import { createAssuranceModule } from '../modules/assurance-module.js';
import { createAssuranceFrameworkRegistry, type AssuranceFrameworkRegistry } from '../assurance/framework-registry.js';
import { AOC_SAF_FRAMEWORK_V1 } from '../assurance/saf-framework.js';
import { createInMemoryAssuranceStore } from '../assurance/in-memory-assurance-store.js';
import { createSqliteAssuranceStore } from '../assurance/sqlite-assurance-store.js';
import type { AssuranceStore } from '../assurance/assurance-store.js';
import { createAssuranceService, type AssuranceService } from '../assurance/service.js';
import type { AssuranceFramework } from '../assurance/contracts.js';
import { createAuthorityControlledExecution, type AuthorityControlledExecutionOptions, type AuthorityControlledExecutionService } from '../execution-governance/index.js';
import { createAuthorityControlledExecutionModule } from '../modules/authority-controlled-execution-module.js';
import { createExerciseControlModule } from '../modules/exercise-control-module.js';
import { assertValidExerciseControlCallbacks, assertValidExerciseControlStore, type AuthorityControlledExerciseControls } from '../execution-governance/exercise-controls.js';
import type { ExerciseControlLedgerPort } from '../../features/exercise-control-runtime/index.js';
import { createFinancialActionClassifier, createMonetaryAssetRegistry, type MonetaryAssetDefinition } from '../../features/monetary-runtime/index.js';
import { createSqliteExerciseControlLedger } from '../exercise-control-ledger/sqlite-exercise-control-ledger.js';
import { createAuthorityControlledIssuanceCore } from '../execution-governance/issuance-core.js';
import { createGovernanceProfileRegistry, type GovernanceConfiguration, type GovernanceProfileRegistry } from '../governance-profile/index.js';
import { composeGovernedTrust, type GovernedTrustComposition, type ObligationConfiguration, type TrustedContextConfiguration } from '../trusted-context/index.js';
import {
  createInMemoryObligationDischargeStore,
  createObligationDischargeRecorder,
  createSqliteObligationDischargeStore,
  createStoredObligationDischargeProvider,
  type ObligationDischargeRecorder,
  type ObligationDischargeStore,
} from '../obligation-discharge/index.js';
import { createKernelAuthorityLineageRevalidator } from '../kernel-authority/authority-lineage-revalidator.js';
import {
  createApprovalAuthority,
  createInMemoryApprovalStore,
  createSqliteApprovalStore,
  type ApprovalAuthority,
  type ApprovalCommandPort,
  type ApprovalStore,
} from '../approval-authority/index.js';
import { createActorRegistryRecognitionIntegration } from '../../features/approval-runtime/services/approval-actor-recognition-integration.js';
import { createApprovalAuthorityGraphIntegration } from '../../features/approval-runtime/services/approval-authority-graph-integration.js';
import { KernelObligationCapability, resolveKernelObligationFacts, resolveKernelObligations } from '../../kernel/orchestration/obligation-adapter.js';
import type { ContextProvider, KernelEffectiveProfileResolver } from '../../kernel/index.js';
import { createGovernedActionOrchestratorModule } from '../modules/governed-action-orchestrator-module.js';
import { createAuthorityEventStreamModule } from '../modules/authority-event-stream-module.js';
import { createAuthorityEventProjector, type AuthorityEventProjector } from '../authority-event-stream/projector.js';
import type { AuthorityEventStreamReader, AuthorityEventStreamStore } from '../authority-event-stream/stream-store.js';
import { createInMemoryAuthorityEventStreamStore } from '../authority-event-stream/in-memory-authority-event-stream-store.js';
import { createSqliteAuthorityEventStreamStore } from '../authority-event-stream/sqlite-authority-event-stream-store.js';
import { createExecutionOutcomeModule } from '../modules/execution-outcome-module.js';
import type { ExecutionOutcomeReader, ExecutionOutcomeStore } from '../execution-outcome-store/outcome-store.js';
import { createInMemoryExecutionOutcomeStore } from '../execution-outcome-store/in-memory-execution-outcome-store.js';
import { createSqliteExecutionOutcomeStore } from '../execution-outcome-store/sqlite-execution-outcome-store.js';
import { createExecutionResolutionModule } from '../modules/execution-resolution-module.js';
import type { ExecutionResolutionReader, ExecutionResolutionStore } from '../execution-resolution-store/resolution-store.js';
import { createInMemoryExecutionResolutionStore } from '../execution-resolution-store/in-memory-execution-resolution-store.js';
import { createSqliteExecutionResolutionStore } from '../execution-resolution-store/sqlite-execution-resolution-store.js';
import {
  snapshotResolutionAuthorities,
  type ExecutionResolutionAuthority,
  type ExecutionResolutionAuthoritySelector,
  type ResolutionAuthorityComposition,
} from '../execution-reconciliation/authority.js';
import { createExecutionResolutionBinder } from '../execution-reconciliation/binder.js';
import type { ExecutionReconciliationService } from '../execution-reconciliation/contracts.js';
import { ExecutionReconciliationConfigurationError } from '../execution-reconciliation/errors.js';
import { createExecutionReconciliationService } from '../execution-reconciliation/service.js';
import { createExecutionLedger, executionClaimRecorded } from '../governed-action/execution-ledger.js';
import type { ExerciseControlReconciliationPort } from '../../features/exercise-control-runtime/index.js';
import {
  GovernedActionConfigurationError,
  createGovernedActionOrchestrator,
  type GovernedActionGrantPolicy,
  type GovernedActionMonetaryTrust,
  type GovernedActionOrchestrator,
} from '../governed-action/index.js';
import { createInMemoryBoundedGrantStore, type BoundedGrantStorePort } from '../../features/grant-runtime/index.js';
import { createExecutionAdapterRegistry, type ExecutionAdapter, type ExecutionAdapterSelector } from '../../features/execution-runtime/index.js';
import { GenericHttpConfigurationError, createGenericHttpExecutionAdapter, type EnterpriseGenericHttpExecutionAdapterOptions } from '../execution-adapters/generic-http/index.js';
import type { EmergencyControlReaderPort, EmergencyControlStorePort } from '../../features/emergency-control-runtime/index.js';
import { createEmergencyControlReader, createInMemoryEmergencyControlStore } from '../../features/emergency-control-runtime/index.js';
import { createSqliteEmergencyControlStore } from '../emergency-control/sqlite-emergency-control-store.js';
import { ExecutionGovernanceError } from '../execution-governance/errors.js';
import { createSqliteBoundedGrantStore, isAuthenticatedDurableBoundedGrantStore } from '../bounded-grant-store/sqlite-bounded-grant-store.js';
import { AuthorityStateFreshnessError } from '../authority-state-freshness/errors.js';
import { createHttpAuthorityStateWitnessTransport } from '../authority-state-freshness/http-transport.js';
import {
  createAuthorityStateFreshnessBoundary,
  isAuthorityStateEnrollmentContext,
  freshnessBoundaryOf,
  isFailedAuthorityStateFreshnessStatus,
  type AuthorityStateEnrollmentContext,
  type AuthorityStateFreshnessBoundary,
} from '../authority-state-freshness/session.js';
import type { AuthorityStateKind } from '../authority-state-freshness/checkpoint.js';
import { authorityStateWitnessKeyBytes, establishAuthorityStateWitness } from '../authority-state-freshness/witness-client.js';
import {
  CustomerIdentityConfigurationError,
  assertCustomerCredentialConfiguration,
  createCustomerIdentityAdmission,
  createKernelAuthoritySubjectBindingReader,
  isCanonicalCustomerIdentifier,
  type CustomerIdentityAdmissionService,
} from '../customer-identity/index.js';
import {
  AuthorityAuthenticityConfigurationError,
  authorityVerificationKeyFromPrivateKey,
  createAuthorityArtifactVerifier,
  createSoftwareAuthorityArtifactSigner,
  isSupportedAuthoritySignatureAlgorithm,
  storeSignerCustody,
  type AuthorityArtifactSigner,
  type AuthorityArtifactVerifier,
  type AuthoritySignerCustody,
  type TrustedVerificationKey,
} from '../authority-authenticity/index.js';
import { createHttpExternalAuthoritySignerTransport, establishExternalAuthorityArtifactSigner, type ExternalAuthoritySignerMonitor } from '../external-authority-signer/index.js';

/** Transport-level input to `AocEnterprise.evaluate()` -- the not-yet-validated wire payload. Validated internally against `GovernanceEvaluateRequestBody`; see `EnterpriseRequestContext` for the side-channel (auth header) that travels alongside it. */
export type EnterpriseEvaluationRequest = unknown;

/** Side-channel request context `AocEnterprise.evaluate()` accepts alongside the request body: the caller's `Authorization` header and (PR-004) the `Idempotency-Key` header value. */
export interface EnterpriseRequestContext {
  readonly authorizationHeader?: string;
  readonly idempotencyKey?: string;
}

/**
 * Side-channel context `AocEnterprise.governAction()` accepts: the caller's
 * `Authorization` header and nothing else. There is deliberately no
 * idempotency key here — a governed action's key is the intent's own required
 * `idempotencyKey` — and no identity, actor, organization, grant or adapter.
 */
export interface EnterpriseGovernedActionContext {
  readonly authorizationHeader?: string;
}

/**
 * Every field a caller may substitute for the composition root's own
 * default construction. Tests inject the same real, fully-composed
 * `KernelProviderSet` the Kernel's own characterization suite uses
 * (`bridgeRecognitionRuntime` over a seeded world) instead of the
 * Enterprise Host's fail-closed empty default, and can swap in an
 * in-memory store even when `AOC_ENTERPRISE_PERSISTENCE_PROVIDER=sqlite` is
 * set in the ambient environment. `kernel`, when supplied, is used verbatim
 * instead of constructing one from `kernelProviders` -- this is the
 * "already-built Kernel" shape the mission's example interface describes;
 * `kernelProviders` remains the way to supply the Kernel's *own*
 * dependencies (recognitionProvider/clock/idGenerator) when no
 * already-built `AocKernel` instance is available. `modules`, when
 * supplied, are registered in addition to (never instead of) the built-in
 * modules -- there is no way to opt out of the built-in modules, since they
 * formalize capabilities this Host already unconditionally provides.
 */
export interface CreateEnterpriseOptions {
  readonly configuration?: EnterpriseConfiguration;
  readonly kernel?: AocKernel;
  readonly kernelProviders?: KernelProviderSet;
  readonly policyPackProvider?: PolicyPackProvider;
  readonly persistence?: GovernanceStore;
  /** PR-005: the Evidence Bundle Store. Independent of `persistence` (the Governance Store) by design -- Bundles are never stored inside the Governance Store. */
  readonly evidenceStore?: EvidenceStore;
  /** PR-006: the Agent Passport Store. Independent of `persistence` and `evidenceStore` -- Passport events are never stored inside the Governance Store or the Evidence Bundle Store. */
  readonly passportStore?: AgentPassportStore;
  /** PR-007: the Assurance Store. Independent of every other store -- assessments are never persisted inside the Governance, Evidence, or Passport stores (mission section 48). */
  readonly assuranceStore?: AssuranceStore;
  /**
   * P0-PKG-07: the Kernel Authority Store -- the durable, operator-provisioned
   * authority source. Independent of every other store: authority
   * source-of-truth is never persisted inside a record of past evaluations.
   *
   * Supplying it turns on the durable authority path regardless of
   * `configuration.kernelAuthority.enabled`, which is what a test or an
   * embedder that composes its own store needs. Leaving it out and leaving
   * the configuration flag off keeps the historical behaviour exactly:
   * `createDefaultKernelProviders()`'s real-but-empty, fail-closed world.
   */
  readonly kernelAuthorityStore?: KernelAuthorityStore;
  /** PR-007: additional Assurance frameworks registered alongside the built-in `aoc.saf` 1.0.0. Each is validated at registration; an invalid framework fails composition. */
  readonly assuranceFrameworks?: readonly AssuranceFramework[];
  readonly eventPublisher?: EnterpriseEventPublisher;
  readonly telemetry?: EnterpriseTelemetry;
  readonly logger?: EnterpriseLogger;
  readonly modules?: readonly EnterpriseModule[];
  /**
   * Opt-in grant-aware execution -- the first production composition of layer
   * E onto a provider-neutral execution boundary.
   *
   * **Omitting it changes nothing.** No grant is issued on any path, no
   * bounded-grant store exists, `evaluate()` and the frozen v1 HTTP surface
   * behave byte-identically to this capability not existing, and no module is
   * registered. This is the same posture every optional Kernel port in this
   * repository already takes.
   *
   * Supplying it composes `createAuthorityControlledExecution()` and exposes it
   * as `AocEnterprise.authorityControlledExecution`. It adds no route: a caller
   * must never be able to issue, extend, revoke or exercise its own grant, so
   * the composition is reachable from trusted in-process host code only. See
   * `docs/enterprise/AOC_AUTHORITY_CONTROLLED_EXECUTION.md`.
   */
  readonly authorityControlledExecution?: EnterpriseAuthorityControlledExecutionOptions;
  /**
   * Opt-in secure customer-plane identity admission: credential → principal →
   * organization → external subject → Frontera actor.
   *
   * **Omitting it changes nothing**, and on its own it adds **no route**: no
   * legacy route is rerouted through it, and `evaluate()` keeps its v1
   * authentication exactly. `POST /api/governed-actions` exists only when this
   * **and** `governedActionOrchestrator` are both composed.
   *
   * Supplying `{ enabled: true }` composes it over this Host's Kernel Authority
   * store — the one binding source of truth — and the configured
   * `authentication.apiKeys`. It fails composition, rather than producing a
   * weaker mode, when there is no Kernel Authority store, no credential
   * carrying `customerIdentity`, or any customer credential that is unscoped,
   * malformed, ambiguous or scoped to an organization this instance does not
   * serve. See `docs/enterprise/AOC_CUSTOMER_PRINCIPAL_BINDING.md`.
   */
  readonly customerIdentityAdmission?: EnterpriseCustomerIdentityAdmissionOptions;
  /**
   * Opt-in Governed Action Orchestrator: bound customer identity → Kernel →
   * **committed** Governance Record → bounded grant → exercise → adapter.
   *
   * **Omitting it changes nothing.** Supplying it exposes
   * `AocEnterprise.governedActionOrchestrator` to trusted in-process code and,
   * because it cannot compose without customer identity admission, mounts the
   * one customer route onto it: `POST /api/governed-actions`
   * (`AocEnterprise.governAction`), which admits the caller and then calls
   * `govern()` — nothing below the orchestrator is reachable from it.
   *
   * It composes from capabilities this Host already has and fails composition,
   * rather than producing a weaker mode, unless customer identity admission
   * is enabled, `authorityControlledExecution` is supplied with a Kernel this
   * root built (so its grant-awareness is proven by construction), and the
   * Governance Store can append, re-read, verify and reference decisions. See
   * `docs/enterprise/AOC_GOVERNED_ACTION_ORCHESTRATOR.md`.
   */
  readonly governedActionOrchestrator?: EnterpriseGovernedActionOrchestratorOptions;
  /**
   * P9 — canonical monetary semantics: the assets this deployment recognizes
   * (each with its trusted scale) and the actions it classifies as financial.
   * Trusted host configuration; nothing a caller sends can extend or contradict
   * it. See `docs/architecture/ADR-CANONICAL-MONETARY-SEMANTICS.md`.
   *
   * Built once, here, into one asset registry and one classifier, and the same
   * two instances are handed to the governed-action boundary and to the P7
   * exercise-control gate. **Omitted, nothing is financial and no asset is
   * recognized**: every governed intent carrying an amount is refused, and no
   * money moves through the governed spine. Malformed configuration fails
   * `createEnterprise` with a `MonetaryConfigurationError`.
   */
  readonly monetary?: EnterpriseMonetaryOptions;
  /**
   * CORE-03 — the governed-action semantic model: declared parameter
   * dimensions, domain-declared action and resource classes over the
   * envelope's existing `action` / `resource` identifiers, and versioned,
   * declarative Governance Profiles for each Action × Resource combination.
   * Trusted host configuration; nothing a caller sends can extend, select or
   * contradict it. See `docs/architecture/ADR-GOVERNED-ACTION-SEMANTIC-PARAMETER-MODEL.md`.
   *
   * Built once, here, into one frozen registry handed to the governed-action
   * boundary. **Omitted, nothing is classified**: every governed intent is
   * evaluated exactly as before CORE-03 and may carry no typed parameters.
   * Malformed configuration fails `createEnterprise` with a
   * `GovernanceProfileConfigurationError`.
   */
  readonly governance?: GovernanceConfiguration;
  /**
   * CORE-04 — the Trusted Context Boundary for governed actions: the trusted
   * source registry (which source may **attest** which fact classes, for this
   * organization, with what freshness) and the context `provider` that reads
   * candidate facts from those sources. Trusted host configuration; a request
   * can neither register a source, select one, nor state a trust class.
   *
   * Required — and refused if absent — when any Governance Profile declares
   * material or restrict-only facts; with none declared it is not needed and
   * nothing changes. Malformed configuration fails `createEnterprise` with a
   * `GovernedActionConfigurationError` before any store opens. See
   * `docs/architecture/ADR-TRUSTED-CONTEXT-AND-OBLIGATIONS-ON-THE-GOVERNED-PATH.md`.
   */
  readonly trustedContext?: TrustedContextConfiguration & { readonly provider?: ContextProvider };
  /**
   * CORE-04 — obligations on the governed path: the configured discharge
   * sources (each with its verification class) whose reports the obligation
   * runtime derives state from. Required when any Governance Profile declares
   * obligations. The discharge store is the durable SQLite one under `sqlite`
   * persistence (`obligationDischarge.sqlitePath`), in-memory otherwise, unless
   * a host supplies `store` (which the host then closes).
   */
  readonly obligations?: ObligationConfiguration & { readonly store?: ObligationDischargeStore };
  /**
   * CORE-05 — durable approvals on the governed path. Composed whenever a
   * Governance Profile declares an `approval` requirement; nothing to
   * configure here but, optionally, the store. The approval store is the
   * durable, authenticated SQLite one under `sqlite` persistence
   * (`approval.sqlitePath`), in-memory otherwise, unless a host supplies
   * `store` (which the host then closes). Approver authority is read from the
   * durable Kernel-Authority world — the one governed-path authority source.
   */
  readonly approvals?: { readonly store?: ApprovalStore };
  /**
   * Opt-in durable emergency control: the operational safety interlock that
   * lets an operator stop execution on the bounded-grant path.
   *
   * **Omitting it changes nothing.** No check runs anywhere, no store is
   * opened, and every existing behaviour is byte-identical — the same posture
   * every other optional capability here takes.
   *
   * Supplying `{ enabled: true }` composes **one** reader and hands that same
   * instance to all four checkpoints: the Governed Action Orchestrator's
   * admission check, the bounded-grant store's synchronous commit guard, the
   * exercise gate after the authoritative grant re-read, and the execution
   * adapter registry's adapter-scoped check. Four readers would be four
   * different worlds, and an operator stopping one of them would believe they
   * had stopped all four.
   *
   * It adds **no route and no SDK method**. A caller can never activate,
   * release, inspect or evade a control; the operator surface is
   * `AocEnterprise.emergencyControlAdministration`, reachable only from trusted
   * in-process host code. See `docs/enterprise/AOC_EMERGENCY_CONTROL.md`.
   */
  readonly emergencyControl?: EnterpriseEmergencyControlOptions;
  /**
   * P8 — the canonical authority event stream, when governed actions are
   * composed. **Evidence only.**
   *
   * The stream is composed automatically with `governedActionOrchestrator` —
   * the one lifecycle Stage A projects — and not otherwise. This block only
   * lets a host hand in a store it opened and owns (never closed from here).
   * Omitted, the composition root selects one the way it selects every other
   * store: durable SQLite at `authorityEventStream.sqlitePath` when
   * `persistence.provider === 'sqlite'`, process-local otherwise.
   *
   * Nothing on any authorization path is handed the store: lifecycle modules
   * get the write-only recorder, and trusted in-process operator code gets the
   * read-only `AocEnterprise.authorityEventStream`. A store that cannot be
   * opened, or that fails, makes the stream's module unhealthy or degraded and
   * changes no decision, grant, reservation, routing or outcome.
   */
  readonly authorityEventStream?: EnterpriseAuthorityEventStreamOptions;
  /**
   * P11 — the durable execution outcome store, composed **automatically** with
   * `governedActionOrchestrator`: there is no switch that runs governed
   * executions without it. This block only lets a host hand in a store it
   * opened and owns (never closed from here). Omitted, the composition root
   * selects one the way it selects every other store: durable SQLite at
   * `executionOutcome.sqlitePath` when `persistence.provider === 'sqlite'`,
   * process-local (not durable) otherwise. A store that cannot be opened fails
   * startup.
   *
   * The orchestrator is handed the narrow prepare / record / read port; trusted
   * in-process operator code gets the read-only
   * `AocEnterprise.executionOutcomes`. Nothing that decides, issues, admits or
   * routes is handed either.
   */
  readonly executionOutcomes?: EnterpriseExecutionOutcomeOptions;
  /**
   * P12 — execution reconciliation and resolution authority. **Optional.**
   * Omitted, or `enabled` anything but `true`, governed executions behave
   * exactly as under P11.
   *
   * Enabled, it requires governed actions and composes:
   *
   * - the host's trusted **resolution authorities** and **selector**,
   *   validated and snapshotted here, once — unique recordable ids, a
   *   synchronous selector, no discovery per request;
   * - a durable **binding** of every new governed execution to one authority,
   *   written after P11 preparation and **before** the write-ahead claim — an
   *   execution that cannot be bound never reaches its claim or its provider;
   * - the execution resolution store (its own SQLite file at
   *   `executionResolution.sqlitePath` under `persistence.provider = 'sqlite'`,
   *   process-local otherwise; a host may supply one it owns);
   * - resolved **replay**: an execution P11 left uncertain replays a verified
   *   definitive resolution through the existing statuses. Replay reads; it
   *   never asks an authority;
   * - the trusted in-process surfaces `AocEnterprise.executionReconciliation`
   *   (reconcile, adopt) and `AocEnterprise.executionResolutions` (read-only).
   *
   * No HTTP route, SDK method, status or wire field is added. See
   * `docs/architecture/ADR-EXECUTION-RECONCILIATION-AND-RESOLUTION-AUTHORITY.md`.
   */
  readonly executionReconciliation?: EnterpriseExecutionReconciliationOptions;
}

/** What a host states to enable P12 execution reconciliation. Trusted host composition; never caller input. */
export interface EnterpriseExecutionReconciliationOptions {
  readonly enabled: boolean;
  /** The trusted resolution authorities. At least one; every `authorityId` unique and recordable. Snapshotted at composition. */
  readonly authorities: readonly ExecutionResolutionAuthority[];
  /** Trusted, synchronous selection of the authority bound to a new execution. There is no default and no fallback. */
  readonly selectAuthority: ExecutionResolutionAuthoritySelector;
  /** A store the **host** opened and owns. Used verbatim and never closed from here. */
  readonly store?: ExecutionResolutionStore;
}

/** What a host may state about the durable execution outcome store (P11). Its store only; the store itself is composed with governed actions. */
export interface EnterpriseExecutionOutcomeOptions {
  /** A store the **host** opened and owns. Used verbatim and never closed from here. */
  readonly store?: ExecutionOutcomeStore;
}

/** What a host may state about the canonical authority event stream (P8). Its store only; the stream itself is composed with governed actions. */
export interface EnterpriseAuthorityEventStreamOptions {
  /** A store the **host** opened and owns. Used verbatim and never closed from here. */
  readonly store?: AuthorityEventStreamStore;
}

/**
 * What a host states to adopt emergency control.
 *
 * Nothing here is caller input, and there is deliberately no "permissive" or
 * "advisory" mode: a deployment that enables the interlock and whose store
 * cannot be opened fails composition rather than running with a stand-in that
 * always answers `clear`.
 */
export interface EnterpriseEmergencyControlOptions {
  readonly enabled: boolean;
  /**
   * A store the **host** opened and owns.
   *
   * Supplied, it is used verbatim and is never closed from here — the host
   * closes what the host opened, exactly as the bounded-grant store rule
   * states. Omitted, the composition root selects one the way it selects every
   * other store: the durable store when `persistence.provider === 'sqlite'`, on
   * `emergencyControl.sqlitePath`; the process-local one otherwise, which is
   * **not durable** and loses every control on restart.
   */
  readonly store?: EmergencyControlStorePort;
}

/** What a host states to adopt governed actions. Everything else is composed from capabilities the Host already has. */
export interface EnterpriseGovernedActionOrchestratorOptions {
  readonly enabled: boolean;
  /** The trust domain governed-action requests are evaluated in. Trusted host configuration; never caller input. */
  readonly trustDomainId: string;
  /** **Required.** The trusted grant expiry (and optional narrowing) for each governed action. No default exists, and `undefined` withholds. */
  readonly grantPolicy: GovernedActionGrantPolicy;
  /**
   * Whether governed execution is this Host's reason to exist. Default `false`.
   *
   * `true` registers the governed spine's modules — Authority-Controlled
   * Execution (and with it the authenticated grant store's revocation-state
   * probe), exercise controls, the orchestrator and the durable outcome store —
   * as `required`: a failure in any of them makes `/health` unhealthy and
   * `/ready` not ready. The Enterprise Host bootstrap sets it; an embedder
   * whose Host also serves other purposes may leave it off.
   */
  readonly required?: boolean;
}

/** What a host states about money. See `EnterpriseOptions.monetary`. */
export interface EnterpriseMonetaryOptions {
  /** Every asset this deployment recognizes, once each, with its maximum fractional digits. */
  readonly assets: readonly MonetaryAssetDefinition[];
  /** Every action identifier this deployment classifies as financial. Any other action is non-financial and may carry no amount. */
  readonly financialActions: readonly string[];
}

/** What a host states to adopt customer identity admission. Credentials come from `configuration.authentication.apiKeys`; the binding source is always the Kernel Authority store. */
export interface EnterpriseCustomerIdentityAdmissionOptions {
  readonly enabled: boolean;
}

/**
 * What a host must state to adopt grant-aware execution.
 *
 * `kernel` and `now` are supplied by the composition root; everything else is
 * the deployment's own decision, and `resolveAuthorityBinding` is deliberately
 * **required** -- a mandate-backed flow whose authority ceiling is missing must
 * fail closed rather than issue under an empty ceiling list, and the only way
 * to guarantee that is to make the host unable to compose without answering the
 * question.
 */
export interface EnterpriseAuthorityControlledExecutionOptions
  extends Omit<AuthorityControlledExecutionOptions, 'kernel' | 'now' | 'grantStore' | 'executionAdapter' | 'emergencyControl' | 'exerciseControls' | 'financialAuthority'> {
  /**
   * One provider adapter, when this deployment has one.
   *
   * Still the whole story for a single-provider deployment: nothing about that
   * composition changed, and no host is forced to adopt routing. Exactly one of
   * this and `executionAdapterRouting` must be stated — "both, and one wins" is
   * not a thing to resolve by precedence when what it decides is which provider
   * receives a real-world effect.
   */
  readonly executionAdapter?: ExecutionAdapter;
  /**
   * Trusted **server-side** routing across several provider adapters.
   *
   * The composition root builds `createExecutionAdapterRegistry(...)` from it
   * and hands the result to ACE as the execution adapter, so the registry is
   * the composite that satisfies the port and the children are reached only
   * through it. Building it here rather than in the host is what lets the
   * emergency-control reader be the *same instance* the other three checkpoints
   * use.
   *
   * Nothing a caller sends reaches the selector: it receives the
   * `ValidatedExecutionAction` the exercise gate built, and nothing else. See
   * `docs/enterprise/AOC_EXECUTION_ADAPTER_REGISTRY.md`.
   */
  readonly executionAdapterRouting?: EnterpriseExecutionAdapterRoutingOptions;
  /**
   * The grant-aware Kernel this composition evaluates through.
   *
   * Omitted, the composition root builds a **separate** `AocKernel` instance
   * over the same providers and policy pack, configured with
   * `grants: { declaration }`. It is a separate instance on purpose: the Kernel
   * the frozen `POST /api/governance/evaluate` path uses stays composed exactly
   * as it was, so its `KernelEvaluationResult` gains no `grants` block and the
   * Governance Record it commits is byte-identical to a deployment that never
   * adopted layer E. Both instances read the same authority world; only the
   * capability set differs.
   */
  readonly kernel?: AocKernel;
  /**
   * The authoritative home of issued grants.
   *
   * Omitted, the composition root selects one exactly as it selects every other
   * store: the **durable** bounded-grant store when
   * `persistence.provider === 'sqlite'`, on `boundedGrant.sqlitePath`; the
   * in-memory store otherwise. A store supplied here overrides both, and the
   * host that supplied it is the one that closes it.
   *
   * **Under `persistence.provider === 'sqlite'` a supplied store must itself be
   * an authenticated durable store** — one built by
   * `createSqliteBoundedGrantStore`, unwrapped. Anything else (the in-memory
   * store, a wrapper, a custom implementation) is refused at startup with
   * `EXECUTION_GRANT_STORE_NOT_AUTHENTICATED` (CORE-01): a durable deployment
   * never silently downgrades to authority storage that does not sign and
   * verify. Under `memory` persistence any `BoundedGrantStorePort` is accepted,
   * as before — that configuration never promised durable, authenticated
   * authority.
   *
   * **In-memory grants do not survive a process restart**, and a grant that is
   * gone reads as `GRANT_EXERCISE_NOT_FOUND` at the next exercise -- no
   * execution, which is the closed direction. With the durable store, grants
   * and revocations both survive, and an acknowledged revocation can never be
   * the half that is lost. See
   * `docs/security/AUTHORITATIVE_GRANT_STORE.md` and the persistence section of
   * `docs/enterprise/AOC_AUTHORITY_CONTROLLED_EXECUTION.md`.
   */
  readonly grantStore?: AuthorityControlledExecutionOptions['grantStore'];
  /**
   * P7 — aggregate / velocity exercise controls, a durable reservation ledger
   * and exercise-time authority-binding revalidation on this path.
   *
   * **Omitting it changes nothing**: no ledger file is opened or created, no
   * reservation is made, and every exercise behaves exactly as before.
   *
   * Supplied, `policy` and `revalidateAuthorityBinding` are **required** — a
   * block missing either fails `createEnterprise` before any store is opened —
   * and the whole block is trusted host composition: nothing a caller sends can
   * name a limit, bucket, reservation or binding. See
   * `docs/enterprise/AOC_EXERCISE_CONTROLS.md`.
   */
  readonly exerciseControls?: EnterpriseExerciseControlsOptions;
}

/**
 * What a host states to adopt P7 exercise controls.
 *
 * `ledger` is optional **here only**. Omitted, the composition root opens the
 * durable SQLite ledger at `exerciseLedger.sqlitePath` — always the durable one,
 * whatever `persistence.provider` says, because an aggregate limit whose
 * consumption is forgotten on restart fails open — and closes it on shutdown.
 * Supplied, it is used verbatim and the host that supplied it closes it.
 */
export interface EnterpriseExerciseControlsOptions extends Omit<AuthorityControlledExerciseControls, 'reservationLedger' | 'actionClassifier'> {
  readonly ledger?: ExerciseControlLedgerPort;
}

/** The trusted routing table. Host configuration; never caller input, and never mutable after composition. */
export interface EnterpriseExecutionAdapterRoutingOptions {
  /** The registry's own identity, reported on outcomes. Defaults to the registry's canonical id. */
  readonly adapterId?: string;
  /** Host-written provider adapters. May be empty when `genericHttpAdapters` supplies at least one child. */
  readonly adapters: readonly ExecutionAdapter[];
  /**
   * Pinned Generic HTTP integrations, each built by the composition root into
   * one more child of the **same** registry — after `adapters`, with every
   * identity required to be unique across both lists.
   *
   * Each entry is one operator-pinned HTTPS origin with a closed, declarative
   * mapping from `ValidatedExecutionAction` fields and literals. It is not a
   * proxy and has no router of its own: which entry an action reaches is
   * `selectAdapter`'s trusted decision, and the adapter-scoped emergency stop
   * is checked by the registry before the child is invoked. Invalid
   * configuration fails `createEnterprise` before any store is opened. See
   * `docs/enterprise/AOC_GENERIC_HTTP_EXECUTION_ADAPTER.md`.
   */
  readonly genericHttpAdapters?: readonly EnterpriseGenericHttpExecutionAdapterOptions[];
  /** Synchronous, trusted, and fed only the validated action. Returning `undefined` means "no route", which fails the execution safely rather than falling through to an arbitrary provider. */
  readonly selectAdapter: ExecutionAdapterSelector;
}

/**
 * The Soberanía Enterprise Host's stable application-level boundary. The HTTP
 * server (`host/enterprise-server.ts`) consumes exactly this interface and
 * nothing more of the composition root's internals. `evaluate()` is the
 * only place governance requests reach the Kernel; `health()` reports
 * operational status.
 *
 * `createEnterprise()` auto-starts the module lifecycle before resolving
 * (mission section 20, "Option A -- Auto-start compatibility"): existing
 * PR-002 consumers call `createEnterprise()` then `evaluate()` immediately,
 * with no intervening `start()` call, and that must keep working unchanged.
 * `start()` is still exposed, and is a safe idempotent no-op when the
 * instance is already `ready`/`degraded` -- it exists for callers that want
 * to observe/await the lifecycle explicitly, not because callers are
 * required to invoke it.
 */
export interface AocEnterprise {
  /**
   * The redacted, secret-free configuration view (R004.B). Never carries raw
   * provider/application secrets (e.g. `authentication.apiKeys[].key`) --
   * only non-secret operational settings and redacted diagnostic fields
   * (`authentication.apiKeyCount`). Trusted in-process code that must
   * authenticate callers with the real configured credentials (the Node HTTP
   * adapter) obtains the full configuration via
   * `getInternalEnterpriseConfiguration`, never through this field.
   */
  readonly configuration: PublicEnterpriseConfiguration;
  readonly kernel: AocKernel;
  readonly kernelProviders: KernelProviderSet;
  readonly persistence: GovernanceStore;
  /** Authenticated, tenant-scoped read/verify surface over the Governance Store (PR-004). HTTP handlers and embedders consume this instead of building store queries directly. */
  readonly governanceReads: GovernanceReadService;
  /** PR-005: the Evidence Bundle Store, independent of the Governance Store. */
  readonly evidenceStore: EvidenceStore;
  /** PR-005: build/read/verify surface for Evidence Bundles. HTTP handlers and embedders consume this instead of calling the projector/verifier directly. */
  readonly evidence: EvidenceService;
  /** PR-006: the Agent Passport Store, independent of the Governance Store and Evidence Bundle Store. */
  readonly passportStore: AgentPassportStore;
  /** PR-006: issue/lifecycle/reference/verify/view surface for Agent Passports. HTTP handlers and embedders consume this instead of calling the Passport Store directly. */
  readonly passports: AgentPassportService;
  /** PR-007: the Assurance Store, independent of every other store. */
  readonly assuranceStore: AssuranceStore;
  /** PR-007: assess/verify/findings/eligibility/signals/report surface for the Assurance Runtime. HTTP handlers and embedders consume this instead of touching the engines directly. */
  readonly assurance: AssuranceService;
  /** PR-007: the frozen Assurance Framework Registry (read surface: `get`/`list`/`validate`). */
  readonly assuranceFrameworks: AssuranceFrameworkRegistry;
  /**
   * P0-PKG-07: the durable authority source, when this deployment configured
   * one. `undefined` means this Host runs the historical empty, fail-closed
   * Kernel world -- never that authority is unrestricted.
   */
  readonly kernelAuthorityStore?: KernelAuthorityStore;
  /**
   * P0-PKG-07: the **trusted operator** write surface over the durable
   * authority source, present only when one is configured.
   *
   * Exposed here so a deployment's own administration code (a bootstrap
   * script, a CLI, an authenticated admin route) can provision without
   * reaching into internals. It is emphatically not part of the evaluation
   * path: `evaluate()` never touches it, every method on it requires a
   * privileged operator context, and an application that is handed an
   * `AocEnterprise` should be handed the evaluation surface rather than this
   * object. See `docs/enterprise/AOC_DURABLE_KERNEL_AUTHORITY.md`.
   */
  readonly kernelAuthorityProvisioning?: KernelAuthorityProvisioningService;
  /**
   * Grant-aware execution, present only when this deployment composed it.
   *
   * `undefined` means this Host issues no bounded grants and runs nothing
   * through a grant-gated execution boundary -- never that execution is
   * ungoverned, because without this composition there is no grant-aware
   * execution path at all.
   *
   * It is emphatically not part of `evaluate()`: the frozen v1 evaluation
   * surface never touches it, and an application handed an `AocEnterprise`
   * should be handed the evaluation surface rather than this object.
   */
  readonly authorityControlledExecution?: AuthorityControlledExecutionService;
  /**
   * Customer-plane identity admission, present only when this deployment
   * composed it. Admits a caller as the Frontera actor bound to its
   * authenticated external subject, or refuses; it never decides what that
   * actor may do. On its own it mounts no route; `governAction` consumes it
   * only when `governedActionOrchestrator` is composed too.
   */
  readonly customerIdentityAdmission?: CustomerIdentityAdmissionService;
  /**
   * Internal governed-action orchestration, present only when this deployment
   * composed it. Trusted in-process code hands it a `BoundCustomerIdentity`
   * from `customerIdentityAdmission` and an intent; the customer route reaches
   * it only through `governAction`.
   */
  readonly governedActionOrchestrator?: GovernedActionOrchestrator;
  /**
   * The customer-facing governed-action application call behind
   * `POST /api/governed-actions`, present **only** when both
   * `customerIdentityAdmission` and `governedActionOrchestrator` are composed.
   * Absent otherwise — there is no weaker implementation to fall back to.
   *
   * `Authorization` header → customer identity admission → `BoundCustomerIdentity`
   * → `governedActionOrchestrator.govern(identity, rawIntent)`. It accepts no
   * identity, actor, organization, grant or adapter, and it requires a bound
   * customer credential whatever `AOC_ENTERPRISE_REQUIRE_AUTH` says. An
   * admission failure rejects with the Enterprise error envelope; every
   * orchestrator outcome resolves as `{ httpStatus, body: GovernedActionResult }`.
   */
  readonly governAction?: (rawIntent: unknown, context?: EnterpriseGovernedActionContext) => Promise<EnterpriseGovernedActionResponse>;
  /**
   * The **trusted operator** surface over the emergency-control store, present
   * only when this deployment composed one.
   *
   * Exposed here for the reason `kernelAuthorityProvisioning` is: a
   * deployment's own administration code — a bootstrap script, a CLI, an
   * authenticated operator route the deployment writes and owns — must be able
   * to stop and resume execution without reaching into internals.
   *
   * It is emphatically not part of any caller path. `evaluate()` never touches
   * it, `govern()` never touches it, no frozen HTTP route reaches it, the SDK
   * has no method for it, and `GovernedActionIntent` has no field that could
   * name it. An application handed an `AocEnterprise` should be handed the
   * evaluation surface rather than this object.
   *
   * `undefined` means this Host enforces no emergency control — never that
   * execution is unstoppable, because without this composition there are no
   * checks to satisfy.
   */
  readonly emergencyControlAdministration?: EmergencyControlStorePort;
  /**
   * CTRL-01 — the authority administration API's application service, present
   * **only** when at least one administrator credential is configured
   * (`configuration.administration`). Behind `/api/admin/...`.
   *
   * Every call takes the caller's `Authorization` header and authenticates it
   * as an administrator itself — an ordinary API key, legacy or customer, is
   * refused — then runs the existing authoritative operation (bounded-grant
   * read and CORE-01 revocation, Kernel Authority read and revocation,
   * emergency control) under the operator identity configured for that
   * credential. It issues nothing, provisions nothing and un-revokes nothing.
   */
  readonly authorityAdministration?: AuthorityAdministrationService;
  /**
   * CORE-04 — the trusted, **in-process** writer of obligation discharge
   * reports, present when obligations are composed. It records what a
   * configured discharge source reported, attributed to a trusted writer
   * context; it cannot state an obligation's resulting state, which the
   * obligation runtime derives from the source's configured verification
   * class. No HTTP route, SDK method or CTRL-01 administration call reaches it.
   */
  readonly obligationDischarges?: ObligationDischargeRecorder;
  /**
   * CORE-05 — the engine-side, **in-process** approval command port, present
   * when durable approvals are composed: open approval requests, what each
   * one is (the canonical subject — with its requirement snapshot — an
   * approver is shown), and approve / reject / requestChanges / escalate /
   * revoke by an authenticated actor context on exactly that subject. It
   * cannot write a state, a quorum or a proof: those are derived from the
   * authenticated verdicts through approval-runtime's policies and the
   * actors' live Kernel-Authority. No HTTP route, SDK method or CTRL-01
   * administration call reaches it (CTRL-04 owns the human surface).
   */
  readonly approvals?: ApprovalCommandPort;
  /**
   * P8 — the **read-only** surface over the canonical authority event stream,
   * present only when governed actions are composed and a stream store is
   * available.
   *
   * For trusted in-process operator and audit code. Tenant-scoped on every call,
   * verify-first (a corrupt stream is reported, never returned as a prefix), and
   * without any append, update or delete. It is not part of any caller path: no
   * HTTP route reaches it, the SDK has no method for it, and nothing that
   * decides, issues, exercises, admits, routes or replays is handed it.
   */
  readonly authorityEventStream?: AuthorityEventStreamReader;
  /**
   * P11 — the **read-only** surface over the durable execution outcome store,
   * present only when governed actions are composed.
   *
   * For trusted in-process operator and audit code (and, later,
   * reconciliation): the exact prepared context and the initial observation of
   * an execution, tenant-scoped on every call and verified before it is
   * returned. No prepare, no record, no update, no delete. No HTTP route, SDK
   * method or authorization path reaches it.
   */
  readonly executionOutcomes?: ExecutionOutcomeReader;
  /**
   * P12 — the **read-only** surface over the execution resolution store,
   * present only when execution reconciliation is enabled: an execution's
   * resolution-authority binding and its definitive resolution, tenant-scoped
   * and verified before they are returned. No bind, no record, no delete.
   */
  readonly executionResolutions?: ExecutionResolutionReader;
  /**
   * P12 — the trusted in-process **reconciliation** surface, present only when
   * execution reconciliation is enabled. It may ask an execution's bound
   * resolution authority what happened, record the definitive answer, and
   * apply it to P7 capacity; it never executes, resubmits or retries anything.
   * Not part of any caller path: no HTTP route, no SDK method, and nothing the
   * governed-action path holds reaches it. An application handed an
   * `AocEnterprise` should be handed the evaluation surface rather than this.
   */
  readonly executionReconciliation?: ExecutionReconciliationService;
  readonly eventPublisher: EnterpriseEventPublisher;
  readonly telemetry: EnterpriseTelemetry;
  readonly logger: EnterpriseLogger;
  readonly bootId: string;
  evaluate(request: EnterpriseEvaluationRequest, context?: EnterpriseRequestContext): Promise<EnterpriseEvaluationResponse>;
  health(): Promise<EnterpriseHealthReport>;
  /** Idempotent: resolves immediately if already started; rejects if the instance previously failed to start or has been stopped. */
  start(): Promise<void>;
  /** Is the Enterprise process running and capable of responding at all? True until `close()`/`stop()` completes -- a live process may still be `degraded` or not `ready`. */
  isLive(): boolean;
  /** Can the Enterprise Host safely accept governance evaluations right now? False before startup completes, during shutdown, after stop, or if a required module failed. */
  isReady(): boolean;
  lifecycleState(): EnterpriseLifecycleState;
  /** Read-only diagnostic snapshot of every registered module -- see `docs/enterprise/AOC_ENTERPRISE_MODULE_LIFECYCLE.md`. */
  modules(): readonly EnterpriseModuleSnapshot[];
  close(): Promise<void>;
  /** Alias for `close()` -- some callers find `stop()` more consistent with `start()`. */
  stop(): Promise<void>;
}

async function buildStore(configuration: EnterpriseConfiguration, now: () => string): Promise<GovernanceStore> {
  const storeOptions = {
    now,
    limits: configuration.persistence.limits,
    enterpriseVersion: configuration.enterpriseVersion,
  };
  if (configuration.persistence.provider === 'sqlite') {
    return createSqliteGovernanceStore(configuration.persistence.sqlitePath, { ...storeOptions, busyTimeoutMs: configuration.persistence.busyTimeoutMs });
  }
  return createInMemoryGovernanceStore(storeOptions);
}

/** Mirrors `buildStore`, but for the independent Passport Store (mission section 9) -- a distinct on-disk file from the Governance Store even when both use `sqlite`. */
async function buildPassportStore(configuration: EnterpriseConfiguration, now: () => string, nextId: (prefix: string) => string): Promise<AgentPassportStore> {
  const storeOptions = { now, nextId, enterpriseVersion: configuration.enterpriseVersion };
  if (configuration.persistence.provider === 'sqlite') {
    return createSqlitePassportStore(configuration.passport.sqlitePath, { ...storeOptions, busyTimeoutMs: configuration.persistence.busyTimeoutMs });
  }
  return createInMemoryPassportStore(storeOptions);
}

/** Mirrors `buildPassportStore`, but for the independent Assurance Store (PR-007 section 48) -- again a distinct on-disk file. */
async function buildAssuranceStore(configuration: EnterpriseConfiguration, now: () => string): Promise<AssuranceStore> {
  if (configuration.persistence.provider === 'sqlite') {
    return createSqliteAssuranceStore(configuration.assurance.sqlitePath, { now, busyTimeoutMs: configuration.persistence.busyTimeoutMs });
  }
  return createInMemoryAssuranceStore({ now });
}

/**
 * Mirrors `buildPassportStore`, but for the independent Kernel Authority Store
 * -- again a distinct on-disk file, because an authority registry and a record
 * of past evaluations are different things and a deployment must be able to
 * back up, restore and rotate them independently.
 *
 * Fails closed on purpose: a configured SQLite authority source that cannot be
 * opened raises, and is never quietly replaced by an empty in-memory store.
 * That substitution would erase every provisioned actor and grant while the
 * Host reported itself healthy -- authority would appear to have been revoked
 * en masse, and a later write would begin building a second, divergent world.
 */
async function buildKernelAuthorityStore(configuration: EnterpriseConfiguration, now: () => string, nextId: (prefix: string) => string): Promise<KernelAuthorityStore> {
  if (configuration.persistence.provider === 'sqlite') {
    return createSqliteKernelAuthorityStore(configuration.kernelAuthority.sqlitePath, {
      now,
      nextId,
      busyTimeoutMs: configuration.persistence.busyTimeoutMs,
    });
  }
  return createInMemoryKernelAuthorityStore({ now, nextId });
}

/**
 * The authoritative home of bounded grants, when the host did not supply one.
 *
 * Mirrors every other store's selection exactly: a deployment that configured
 * `persistence.provider = 'sqlite'` gets the durable store, on its own file;
 * one that did not keeps the in-memory store it has always had. That is a
 * deliberate choice rather than a default: the alternative — durable always —
 * would put an on-disk database under deployments that never asked for
 * persistence anywhere, including every test that composes this capability.
 *
 * It is also the one place where the security claim becomes conditional.
 * Grants and revocations survive a restart **when the durable store is
 * configured**, and `docs/security/AUTHORITATIVE_GRANT_STORE.md` §14 states the
 * exact configuration required. A deployment on the in-memory store loses both
 * together on restart, which fails closed — the same posture it has today.
 *
 * Fails closed like `buildKernelAuthorityStore`: a configured SQLite store that
 * cannot be opened raises rather than being quietly replaced by an empty
 * in-memory one. That substitution would drop every committed revocation while
 * the Host reported itself healthy, which is the fail-open shape this whole
 * store exists to remove.
 *
 * The in-memory branch is never reached under external custody: that
 * configuration is refused before anything is opened (CORE-02R round 2), so
 * external custody never silently means an unsigned in-process store.
 */
async function buildBoundedGrantStore(
  configuration: EnterpriseConfiguration,
  authenticity: () => Promise<AuthorityAuthenticityBoundary>,
  freshness: () => Promise<AuthorityStateFreshnessBoundary | undefined>,
): Promise<BoundedGrantStorePort> {
  if (configuration.persistence.provider === 'sqlite') {
    const { signer, verifier } = await authenticity();
    const boundary = await freshness();
    return createSqliteBoundedGrantStore(configuration.boundedGrant.sqlitePath, {
      busyTimeoutMs: configuration.persistence.busyTimeoutMs,
      authenticity: { signer, verifier },
      // CORE-07: anchored at the external witness when one is configured.
      ...(boundary !== undefined ? { freshness: { boundary } } : {}),
    });
  }
  return createInMemoryBoundedGrantStore();
}

/**
 * The emergency-control store, when the host did not supply one.
 *
 * Mirrors `buildBoundedGrantStore` exactly, including its fail-closed posture:
 * a configured SQLite store that cannot be opened raises rather than being
 * quietly replaced by a process-local one. That substitution is the specific
 * shape this capability exists to prevent — a deployment that believes it has a
 * durable kill switch, running on one that forgets every control at restart.
 *
 * The in-memory selection under `persistence.provider === 'memory'` is not that
 * substitution: it is the same store-selection rule every other store follows,
 * it is what a test and a single-process development host want, and it is
 * documented as non-durable everywhere it appears.
 */
async function buildEmergencyControlStore(configuration: EnterpriseConfiguration): Promise<EmergencyControlStorePort> {
  if (configuration.persistence.provider === 'sqlite') {
    return createSqliteEmergencyControlStore(configuration.emergencyControl.sqlitePath, { busyTimeoutMs: configuration.persistence.busyTimeoutMs });
  }
  return createInMemoryEmergencyControlStore();
}

/**
 * The authority event stream store, when the host did not supply one: the same
 * selection rule as every other store — durable SQLite under
 * `persistence.provider === 'sqlite'`, process-local (not durable) otherwise.
 * Unlike an authority store, a failure to open it is caught by the caller and
 * degrades the stream rather than the Host: evidence is never a prerequisite.
 */
async function buildAuthorityEventStreamStore(configuration: EnterpriseConfiguration, now: () => string): Promise<AuthorityEventStreamStore> {
  if (configuration.persistence.provider === 'sqlite') {
    return createSqliteAuthorityEventStreamStore(configuration.authorityEventStream.sqlitePath, { now, busyTimeoutMs: configuration.persistence.busyTimeoutMs });
  }
  return createInMemoryAuthorityEventStreamStore({ now });
}

/**
 * The execution outcome store, when the host did not supply one: durable SQLite
 * under `persistence.provider === 'sqlite'`, process-local (not durable)
 * otherwise. Unlike the evidence stream, a failure to open it is a startup
 * failure: no governed execution may run without durable preparation.
 */
async function buildExecutionOutcomeStore(configuration: EnterpriseConfiguration, now: () => string): Promise<ExecutionOutcomeStore> {
  if (configuration.persistence.provider === 'sqlite') {
    return createSqliteExecutionOutcomeStore(configuration.executionOutcome.sqlitePath, { now, busyTimeoutMs: configuration.persistence.busyTimeoutMs });
  }
  return createInMemoryExecutionOutcomeStore({ now });
}

/**
 * The execution resolution store (P12), when the host did not supply one:
 * durable SQLite under `persistence.provider === 'sqlite'`, process-local (not
 * durable) otherwise. A failure to open it is a startup failure: with
 * reconciliation enabled, no governed execution may run without a durable
 * binding, so there is no silent in-memory fallback.
 */
async function buildExecutionResolutionStore(configuration: EnterpriseConfiguration, now: () => string): Promise<ExecutionResolutionStore> {
  if (configuration.persistence.provider === 'sqlite') {
    return createSqliteExecutionResolutionStore(configuration.executionResolution.sqlitePath, { now, busyTimeoutMs: configuration.persistence.busyTimeoutMs });
  }
  return createInMemoryExecutionResolutionStore({ now });
}

/** A fresh one-method object over the resolution store: `bind`, `recordResolution`, `health` and `close` are unreachable from it even by a cast. */
function createExecutionResolutionReader(store: ExecutionResolutionStore): ExecutionResolutionReader {
  return Object.freeze({ read: (context: Parameters<ExecutionResolutionReader['read']>[0], executionId: string) => store.read(context, executionId) });
}

/** P7's one reconciliation capability, as a fresh one-method object — reserve, settle, release and read are unreachable from it even by a cast. `undefined` when the ledger offers none. */
function createExerciseReconciliationCapability(ledger: ExerciseControlLedgerPort | undefined): ExerciseControlReconciliationPort | undefined {
  const candidate = ledger as Partial<ExerciseControlReconciliationPort> | undefined;
  if (candidate === undefined || typeof candidate.reconcileResolution !== 'function') return undefined;
  const reconcileResolution = candidate.reconcileResolution.bind(ledger);
  return Object.freeze({ reconcileResolution: (input: Parameters<ExerciseControlReconciliationPort['reconcileResolution']>[0]) => reconcileResolution(input) });
}

/** A fresh one-method object over the store: `prepareAttempt`, `recordTerminal`, `health` and `close` are unreachable from it even by a cast. */
function createExecutionOutcomeReader(store: ExecutionOutcomeStore): ExecutionOutcomeReader {
  return Object.freeze({ read: (context: Parameters<ExecutionOutcomeReader['read']>[0], executionId: string) => store.read(context, executionId) });
}

/**
 * A fresh two-method object over the store: `append`, `health` and `close` are
 * unreachable from it even by a cast, exactly as the emergency-control reader
 * narrows its store.
 */
function createAuthorityEventStreamReader(store: AuthorityEventStreamStore): AuthorityEventStreamReader {
  return Object.freeze({
    readStream: (context: Parameters<AuthorityEventStreamReader['readStream']>[0], streamId: string) => store.readStream(context, streamId),
    verifyStream: (context: Parameters<AuthorityEventStreamReader['verifyStream']>[0], streamId: string) => store.verifyStream(context, streamId),
  });
}

/**
 * Builds the two halves of the authenticity boundary, **separately**, and
 * refuses every configuration in which they would not agree.
 *
 * The separation is the point, and it is visible in the return type: a signer
 * and a verifier, constructed independently, handed to different parts of the
 * store. `buildBoundedGrantStore` passes both because it builds the object that
 * does both jobs; nothing downstream of it receives the signer, and the exercise
 * path receives neither — it gets `BoundedGrantReaderPort`, which has one
 * method.
 *
 * ## Why this throws rather than degrading
 *
 * Fails closed like `buildKernelAuthorityStore` and like the durable store
 * itself. A deployment that selects durable authority but configures no key
 * boundary has asked for two things that contradict each other, and the
 * resolutions available are: run durable authority unsigned (destroys the
 * property), mint a key at startup (makes the process its own root of trust, so
 * anything that can restart the process can mint authority), or refuse. Only the
 * third is a security posture, so only the third is implemented. There is no
 * flag that selects either of the others.
 */
/** The two halves of the authenticity boundary, plus — under external custody — the non-signing monitor of the custody service (CORE-02). */
interface AuthorityAuthenticityBoundary {
  readonly signer: AuthorityArtifactSigner;
  readonly verifier: AuthorityArtifactVerifier;
  readonly custody: AuthoritySignerCustody;
  readonly monitor: ExternalAuthoritySignerMonitor | undefined;
}

async function buildAuthorityAuthenticity(configuration: EnterpriseConfiguration): Promise<AuthorityAuthenticityBoundary> {
  const authenticity = configuration.authorityAuthenticity;
  const { activeSigningKeyId, verificationKeys } = authenticity;

  // CORE-02: external custody holds no private key, so there is nothing to
  // parse and nothing to fall back to. Checked first, so a contradictory
  // configuration is refused before any key or network is touched.
  if (authenticity.mode === 'external') {
    if (authenticity.conflictingSigningKeyPresent || 'signingKeyPem' in authenticity) {
      throw new AuthorityAuthenticityConfigurationError(
        'External authority-key custody is configured, and an authority signing private key (AOC_ENTERPRISE_AUTHORITY_SIGNING_KEY_PEM) is present in this process as well. External custody means this process holds no authority private key; remove it. There is no mixed or fallback mode.',
      );
    }
    if (activeSigningKeyId === undefined || activeSigningKeyId.length === 0) {
      throw new AuthorityAuthenticityConfigurationError('External authority-key custody requires AOC_ENTERPRISE_AUTHORITY_SIGNING_KEY_ID: the key id the external signer must answer as.');
    }
  } else if (activeSigningKeyId === undefined || authenticity.signingKeyPem === undefined) {
    throw new AuthorityAuthenticityConfigurationError(
      'The durable bounded-grant store requires an authority signing key. Configure AOC_ENTERPRISE_AUTHORITY_SIGNING_KEY_ID and AOC_ENTERPRISE_AUTHORITY_SIGNING_KEY_PEM, or external custody (AOC_ENTERPRISE_AUTHORITY_SIGNER_MODE=external), or do not select the durable store. There is no unsigned durable authority mode.',
    );
  }

  const active = verificationKeys.find((entry) => entry.keyId === activeSigningKeyId);
  if (active === undefined) {
    // A signing key absent from the trusted set would produce artifacts this
    // deployment cannot read back. The store's own read-back on issuance would
    // catch it on the first grant, but a startup refusal is the better place:
    // the alternative is a Host that reports itself healthy and fails at the
    // first exercise.
    throw new AuthorityAuthenticityConfigurationError(
      `The active authority signing key '${activeSigningKeyId}' is not present in the trusted verification set. An artifact signed by a key this deployment does not trust could never be read back.`,
    );
  }
  if (!isSupportedAuthoritySignatureAlgorithm(active.algorithm)) {
    throw new AuthorityAuthenticityConfigurationError(
      `The active authority signing key '${activeSigningKeyId}' names algorithm '${active.algorithm}', which is outside the supported registry.`,
    );
  }

  const trusted: readonly TrustedVerificationKey[] = verificationKeys.map((entry) => {
    if (!isSupportedAuthoritySignatureAlgorithm(entry.algorithm)) {
      throw new AuthorityAuthenticityConfigurationError(
        `Trusted authority verification key '${entry.keyId}' names algorithm '${entry.algorithm}', which is outside the supported registry.`,
      );
    }
    return { keyId: entry.keyId, algorithm: entry.algorithm, publicKeyPem: entry.publicKeyPem };
  });
  const verifier = createAuthorityArtifactVerifier(trusted);

  if (authenticity.mode === 'external') {
    // The pin is this deployment's own trusted entry for the key id — key id,
    // algorithm and public key together. The custody service's identity is
    // checked against it before this returns (no TOFU), and every signature it
    // later returns is verified locally under it before any store sees it.
    const { signer, monitor } = await establishExternalAuthorityArtifactSigner({
      transport: createHttpExternalAuthoritySignerTransport({ endpoint: authenticity.externalSigner.endpoint, credential: authenticity.externalSigner.credential }),
      pinned: { keyId: active.keyId, algorithm: active.algorithm, publicKeyPem: active.publicKeyPem },
      verifier,
      timeoutMs: authenticity.externalSigner.timeoutMs,
      maxAttempts: authenticity.externalSigner.maxAttempts,
      probeIntervalMs: authenticity.externalSigner.probeIntervalMs,
    });
    return { signer, verifier, custody: 'external', monitor };
  }

  const signingKeyPem = authenticity.signingKeyPem as string;
  // The configured public half must be the public half of the configured
  // private key. Without this, a deployment could sign with one key pair while
  // trusting another's public key under the same id, and every issuance would
  // fail its own read-back for a reason that looks like corruption.
  if (authorityVerificationKeyFromPrivateKey(signingKeyPem).trim() !== active.publicKeyPem.trim()) {
    throw new AuthorityAuthenticityConfigurationError(
      `The configured authority signing key does not match the verification key registered under id '${activeSigningKeyId}'.`,
    );
  }

  return {
    signer: createSoftwareAuthorityArtifactSigner({ keyId: activeSigningKeyId as string, algorithm: active.algorithm, privateKeyPem: signingKeyPem }),
    verifier,
    custody: 'software',
    monitor: undefined,
  };
}

/**
 * CORE-02: the authority signer's state on `/health`. Under external custody
 * it is probed with the service's **identity** call — never a signature, so a
 * health check never spends a metered signing operation (single-flight, and at
 * most once per `probeIntervalMs`). The probe proves reachability and identity
 * only: an unresolved signing failure — unreachable, throttled, timed out, or a
 * signature that did not verify — keeps the signer `unavailable` however the
 * identity endpoint answers, until a real signature succeeds (CORE-02R).
 * Either failure makes the Host `degraded`, not `unhealthy`:
 * every existing grant, revocation state, discharge and approval still reads
 * and verifies locally; only new authority mutations (issuance, revocation,
 * discharge and approval appends) cannot be signed. Signer availability is not
 * verifier trust. No credential, endpoint path or key material appears here.
 */
async function withAuthoritySignerHealth(report: EnterpriseHealthReport, authenticity: AuthorityAuthenticityBoundary | undefined): Promise<EnterpriseHealthReport> {
  if (authenticity === undefined) return report;
  if (authenticity.monitor === undefined) {
    return { ...report, authoritySigner: { custody: 'software', keyId: authenticity.signer.activeKeyId, algorithm: authenticity.signer.algorithm, state: 'ready' } };
  }
  const probed = await authenticity.monitor.probe();
  const signing = Object.values(probed.operations).reduce(
    (total, counters) => ({ calls: total.calls + counters.calls, attempts: total.attempts + counters.attempts, succeeded: total.succeeded + counters.succeeded, failed: total.failed + counters.failed, retried: total.retried + counters.retried }),
    { calls: 0, attempts: 0, succeeded: 0, failed: 0, retried: 0 },
  );
  return {
    ...report,
    status: probed.state === 'unavailable' && report.status === 'healthy' ? 'degraded' : report.status,
    authoritySigner: {
      custody: 'external',
      keyId: probed.keyId,
      algorithm: probed.algorithm,
      state: probed.state,
      ...(probed.reason !== undefined ? { reason: probed.reason } : {}),
      identity: probed.identity,
      lastSigning: probed.lastSigning,
      signing,
    },
  };
}

/**
 * CORE-07: the authority-state freshness boundary, built **once**, before any
 * authority store is opened: the witness's pinned identity (id and Ed25519
 * receipt key, from configuration, never from the witness) is proven by a
 * signed handshake, or the Host does not start. Refuses a witness key that is
 * also an authority verification key, and a witness credential that is also
 * the signer's: the freshness witness and the authority signer are different
 * trust roles, and neither is allowed to stand in for the other.
 */
async function buildAuthorityFreshness(configuration: EnterpriseConfiguration): Promise<AuthorityStateFreshnessBoundary | undefined> {
  const freshness = configuration.authorityFreshness;
  if (freshness?.mode !== 'external') return undefined;
  const { witness } = freshness;
  const witnessKey = authorityStateWitnessKeyBytes(witness.publicKeyPem);
  if (witnessKey === undefined) throw new AuthorityStateFreshnessError('AUTHORITY_FRESHNESS_CONFIGURATION_INVALID', 'The pinned authority-state witness key is not a parseable public key.');
  for (const entry of configuration.authorityAuthenticity.verificationKeys) {
    const authorityKey = authorityStateWitnessKeyBytes(entry.publicKeyPem);
    if (authorityKey !== undefined && authorityKey.equals(witnessKey)) {
      throw new AuthorityStateFreshnessError(
        'AUTHORITY_FRESHNESS_CONFIGURATION_INVALID',
        `The pinned authority-state witness key is also the trusted authority verification key '${entry.keyId}'. The freshness witness and the authority signer are different trust roles and never share a key.`,
      );
    }
  }
  if (configuration.authorityAuthenticity.mode === 'external' && configuration.authorityAuthenticity.externalSigner.credential === witness.credential) {
    throw new AuthorityStateFreshnessError('AUTHORITY_FRESHNESS_CONFIGURATION_INVALID', 'The authority-state witness credential is also the external signer credential. Different trust roles never share a credential.');
  }
  const { anchor, monitor } = await establishAuthorityStateWitness({
    transport: createHttpAuthorityStateWitnessTransport({ endpoint: witness.endpoint, credential: witness.credential }),
    pinned: { witnessId: witness.witnessId, publicKeyPem: witness.publicKeyPem },
    timeoutMs: witness.timeoutMs,
    maxAttempts: witness.maxAttempts,
    probeIntervalMs: witness.probeIntervalMs,
  });
  return createAuthorityStateFreshnessBoundary({ anchor, monitor, organizationId: configuration.kernelAuthority.organizationId, probeIntervalMs: witness.probeIntervalMs });
}

/**
 * CORE-07: the freshness state on `/health` — the witness's signed identity
 * and each anchored store's witness-then-local comparison, single-flight and
 * at most once per probe interval. A store whose freshness has failed
 * (`regressed`, `forked`, `pending-recovery`, `unbound`) refuses every
 * authority read and makes the Host `unhealthy` — and so not ready. A witness
 * that cannot be reached after freshness was established at startup makes it
 * `degraded`: existing authority still reads against the startup floor and
 * the in-process witness, and no authority mutation can be prepared. No
 * credential, endpoint path, receipt, signature or digest appears here.
 */
async function withAuthorityFreshnessHealth(report: EnterpriseHealthReport, boundary: AuthorityStateFreshnessBoundary | undefined): Promise<EnterpriseHealthReport> {
  if (boundary === undefined) return report;
  const probed = await boundary.probe();
  const failed = probed.stores.some((store) => isFailedAuthorityStateFreshnessStatus(store.status));
  const unavailable = probed.witness?.state === 'unavailable' || probed.stores.some((store) => store.status === 'unavailable');
  const status = failed ? 'unhealthy' : unavailable && report.status === 'healthy' ? 'degraded' : report.status;
  return {
    ...report,
    status,
    authorityFreshness: {
      mode: 'external',
      witnessId: boundary.witnessId,
      witness: probed.witness === undefined ? { state: 'ready' } : { state: probed.witness.state, ...(probed.witness.reason !== undefined ? { reason: probed.witness.reason } : {}) },
      stores: probed.stores.map((store) => ({ stateKind: store.stateKind, status: store.status, ...(store.reason !== undefined ? { reason: store.reason } : {}), sequence: store.sequence })),
    },
  };
}

/** The `freshness` store option for the boundary, or nothing. */
async function withFreshness(resolve: () => Promise<AuthorityStateFreshnessBoundary | undefined>): Promise<{ readonly freshness?: { readonly boundary: AuthorityStateFreshnessBoundary } }> {
  const boundary = await resolve();
  return boundary !== undefined ? { freshness: { boundary } } : {};
}

/** Closes a store that may or may not own a handle (the in-memory ones own none). Used by the atomic-startup cleanup in `createEnterprise`. */
async function closeIfClosable(resource: unknown): Promise<void> {
  const closable = resource as Partial<{ close: () => Promise<void> }> | undefined;
  if (typeof closable?.close === 'function') await closable.close();
}

/** A dedicated id source for Enterprise-internal bookkeeping (event ids, boot id) -- independent of the Kernel's own `idGenerator`, so Enterprise bookkeeping never perturbs the Kernel's internal id sequence. */
function createEnterpriseIdGenerator(): KernelIdGenerator {
  return { nextId: (prefix: string) => `${prefix}-${randomUUID()}` };
}

/**
 * R004.B: the full, secret-bearing `EnterpriseConfiguration` behind each
 * constructed `AocEnterprise` -- keyed by instance identity so it is never a
 * property of the object itself (not enumerable, not serializable, not
 * spreadable). `AocEnterprise.configuration` only ever holds the redacted
 * `PublicEnterpriseConfiguration` view; this registry is the sole route back
 * to the real credentials, reserved for trusted in-process consumers that
 * must authenticate callers (the Node HTTP adapter). This module is never
 * re-exported from `enterprise/index.ts`'s public entrypoint, so
 * `getInternalEnterpriseConfiguration` does not reach `package.json`'s
 * published `./enterprise` subpath.
 */
const internalConfigurationRegistry = new WeakMap<AocEnterprise, EnterpriseConfiguration>();

/**
 * Returns the full, secret-bearing configuration backing `enterprise`.
 * Reserved for trusted in-process code (e.g. `adapters/node-http-adapter.ts`)
 * that must compare a caller's bearer token against real configured
 * `authentication.apiKeys`. Throws if `enterprise` was not produced by
 * `createEnterprise()` in this process.
 */
export function getInternalEnterpriseConfiguration(enterprise: AocEnterprise): EnterpriseConfiguration {
  const configuration = internalConfigurationRegistry.get(enterprise);
  if (configuration === undefined) {
    throw new Error('getInternalEnterpriseConfiguration: enterprise instance was not produced by createEnterprise() in this process.');
  }
  return configuration;
}

/**
 * The Soberanía Enterprise Host's single composition root (mission: "Create one
 * Enterprise composition root"). Every dependency `AocKernel` is handed --
 * and every dependency the Enterprise Host itself needs -- is constructed
 * exactly once, here. The Kernel only ever receives the narrow interfaces
 * it defines in `kernel/contracts/ports.ts`; it never sees
 * `EnterpriseConfiguration`, the `GovernanceStore`, the event publisher, or
 * any other Enterprise concern.
 *
 * The Enterprise layer hosts; it does not decide. It may validate
 * transport-level requests, authenticate callers, compose providers, call
 * the Kernel, persist decisions, emit events, expose health, collect
 * telemetry, and map errors to HTTP -- it may not evaluate authority,
 * decide policy outcomes, invent reason codes, reinterpret Kernel results,
 * bypass the Kernel, or duplicate governance semantics.
 *
 * PR-003 evolves this from a flat sequence of `const` bindings
 * (`docs/enterprise/AOC_ENTERPRISE_CURRENT_COMPOSITION_MODEL.md`) into:
 * register built-in real modules -> register any caller-supplied modules ->
 * freeze the registry -> run the lifecycle controller -> return a ready
 * `AocEnterprise`. Every dependency below is still constructed exactly the
 * same way it always was; only the *sequencing/observability* of bringing
 * them online is new.
 */
export async function createEnterprise(options: CreateEnterpriseOptions = {}): Promise<AocEnterprise> {
  // Atomic startup (PROD-01). Every store this root opens registers its close
  // here; if composition or the lifecycle start fails part-way, each is closed
  // in reverse before the root error is rethrown. A refused Host leaves no
  // SQLite handle, WAL lock or listener behind. Host-supplied stores are never
  // registered: the host closes what the host opened.
  const opened: (() => Promise<void>)[] = [];
  try {
    return await composeEnterprise(options, opened);
  } catch (error) {
    for (const close of opened.reverse()) await close().catch(() => {});
    throw error;
  }
}

async function composeEnterprise(options: CreateEnterpriseOptions, opened: (() => Promise<void>)[]): Promise<AocEnterprise> {
  const configuration = options.configuration ?? loadEnterpriseConfiguration();
  const eventIdGenerator = createEnterpriseIdGenerator();

  // Customer identity admission is checked before anything is opened: a
  // deployment that asked for the customer plane with credentials that could
  // only ever produce an ambiguous or foreign principal, or with no binding
  // source at all, is refused outright instead of starting in a weaker mode.
  const customerIdentityRequested = options.customerIdentityAdmission?.enabled === true;
  if (customerIdentityRequested) {
    if (options.kernelAuthorityStore === undefined && !configuration.kernelAuthority.enabled) {
      throw new CustomerIdentityConfigurationError(
        'CUSTOMER_IDENTITY_AUTHORITY_UNAVAILABLE',
        'Customer identity admission resolves actors only through the Kernel Authority store, and this Host has none configured.',
      );
    }
    assertCustomerCredentialConfiguration(configuration.authentication.apiKeys, configuration.kernelAuthority.organizationId);
  }

  // CORE-01: no silent authenticity downgrade. Checked before anything is
  // opened. A deployment that configured durable persistence has asked for
  // authority that is signed, verified on every read and tamper-evident against
  // revocation removal; a host-supplied store that is not the authenticated
  // durable store would quietly replace all of that while the configuration
  // still said "sqlite". This guards an honest composition mistake — a test
  // double or wrapper carried into a durable deployment. It is not a defense
  // against a malicious host, which runs in this process and can replace this
  // function; that boundary is stated in AUTHORITY_ARTIFACT_AUTHENTICITY.md.
  const suppliedGrantStore = options.authorityControlledExecution?.grantStore;
  if (suppliedGrantStore !== undefined && configuration.persistence.provider === 'sqlite' && !isAuthenticatedDurableBoundedGrantStore(suppliedGrantStore)) {
    throw new ExecutionGovernanceError(
      'EXECUTION_GRANT_STORE_NOT_AUTHENTICATED',
      'This Host is configured for durable persistence, and the supplied authorityControlledExecution.grantStore is not an authenticated durable bounded-grant store. Omit it so the Host opens the signed store itself, or supply one built by createSqliteBoundedGrantStore. There is no unauthenticated durable authority mode.',
    );
  }

  // CORE-02 / CORE-02R: under external custody the composition root builds
  // every authority-bearing store itself, over the one boundary it establishes
  // against the *configured* signer (pinned key id, algorithm and public key,
  // proven by the identity handshake) and the *configured* trust registry — and
  // accepts none from the host. A custody brand says only where a store's key
  // lives, not which key or which trust set: a supplied store branded
  // `external` could be signed by another custody service (signer
  // substitution), by another key under the same id, or read through a wider
  // verifier (trust substitution), and adopting it would let the configured
  // signer go uncontacted while posture still said `external`. No supplied
  // store is safe to adopt on the strength of what it can say about itself, so
  // none is adopted — in any persistence mode. Software custody keeps host
  // injection (CORE-01's authenticated-store rule above); it makes no external
  // claim. Same boundary as every brand here: this stops a supported
  // composition API from contradicting the configuration, not a malicious
  // in-process host.
  if (configuration.authorityAuthenticity.mode === 'external') {
    const supplied: readonly [string, unknown][] = [
      ['authorityControlledExecution.grantStore', suppliedGrantStore],
      ['obligations.store', options.obligations?.store],
      ['approvals.store', options.approvals?.store],
    ];
    for (const [name, store] of supplied) {
      if (store !== undefined) {
        throw new AuthorityAuthenticityConfigurationError(
          `This Host is configured for external authority-key custody, and a ${name} was supplied. Under external custody the Host composes its authority stores itself, over the signer and trust registry it was configured with and has proven; it adopts none. Omit ${name}. There is no mixed custody.`,
        );
      }
    }
    // CORE-02R round 2: external custody requires authenticated persistence
    // for each authority-bearing store actually composed. The grant/revocation
    // store exists whenever authority-controlled execution is composed, and it
    // is signed only when `persistence.provider` is `sqlite`; anywhere else it
    // is in-process and unsigned, and the configured signer would never be
    // contacted while the configuration still said `external`. There is no
    // externally signed in-memory authority store, so that combination is
    // refused rather than silently meaning "external under SQLite, unsigned
    // otherwise". Without authority-controlled execution no authority store
    // exists and nothing is signed. The obligation and approval stores follow
    // the composed Governance Store instead; they are checked below, once the
    // governed-action configuration that decides whether they exist is known —
    // still before any store is opened or the signer contacted.
    if (options.authorityControlledExecution !== undefined && configuration.persistence.provider !== 'sqlite') {
      throw new AuthorityAuthenticityConfigurationError(
        `This Host is configured for external authority-key custody with authority-controlled execution, and persistence.provider '${configuration.persistence.provider}' would place its grant and revocation authority in process memory, unsigned — the configured signer would never be contacted. External custody requires durable persistence (AOC_ENTERPRISE_PERSISTENCE_PROVIDER=sqlite). There is no unsigned external mode.`,
      );
    }
  }

  // CORE-07: under an external freshness witness the composition root builds
  // every authority-bearing store itself, over the one boundary it proves
  // against the *configured* witness — and adopts none from the host. A store
  // the host opened could have been opened without the anchor (or against
  // another witness), and adopting it would let posture say `external` over
  // authority whose freshness was never established. Checked before anything
  // is opened or the witness contacted. In-memory authority stores hold no
  // cross-restart state, so there is nothing to anchor: they are composed
  // without a session, and the posture says `not-composed` — never `external`
  // — which the secure Host refuses.
  const freshnessExternal = configuration.authorityFreshness?.mode === 'external';
  if (freshnessExternal) {
    const supplied: readonly [string, unknown][] = [
      ['authorityControlledExecution.grantStore', suppliedGrantStore],
      ['obligations.store', options.obligations?.store],
      ['approvals.store', options.approvals?.store],
    ];
    for (const [name, store] of supplied) {
      if (store !== undefined) {
        throw new AuthorityStateFreshnessError(
          'AUTHORITY_FRESHNESS_CONFIGURATION_INVALID',
          `This Host is configured with an external authority-state freshness witness, and a ${name} was supplied. Under an external witness the Host composes its authority stores itself and anchors each one; it adopts none. Omit ${name}.`,
        );
      }
    }
  }

  // Adapter composition is checked before anything is opened: a deployment that
  // states both a single adapter and a routing table, or neither, has not said
  // which provider an authorized action reaches, and that is not a question to
  // answer by precedence.
  if (options.authorityControlledExecution !== undefined) {
    const single = options.authorityControlledExecution.executionAdapter !== undefined;
    const routed = options.authorityControlledExecution.executionAdapterRouting !== undefined;
    if (single === routed) {
      throw new ExecutionGovernanceError(
        'EXECUTION_ADAPTER_COMPOSITION_INVALID',
        'Authority-Controlled Execution needs exactly one of executionAdapter or executionAdapterRouting: one provider adapter, or a trusted server-side routing table over several.',
      );
    }
  }

  // Generic HTTP children are built — and their configuration validated,
  // snapshotted and frozen — here, before any store or listener exists. A bad
  // origin, mapping, header or credential therefore fails startup rather than
  // one customer action at a time, and nothing the host's option objects do
  // afterwards reaches the adapters. Pure: no DNS, no socket, no I/O.
  const genericHttpOptions = options.authorityControlledExecution?.executionAdapterRouting?.genericHttpAdapters;
  if (genericHttpOptions !== undefined && !Array.isArray(genericHttpOptions)) {
    throw new GenericHttpConfigurationError('GENERIC_HTTP_OPTIONS_INVALID', 'executionAdapterRouting.genericHttpAdapters must be an array of Generic HTTP adapter options.');
  }
  const genericHttpAdapters: readonly ExecutionAdapter[] = Object.freeze((genericHttpOptions ?? []).map((entry) => createGenericHttpExecutionAdapter(entry)));

  // P7 exercise controls are checked just as early: a block with no policy, no
  // exercise-time binding resolver, a ledger that is not a ledger, or no usable
  // ledger location fails startup — before any store, ledger file or listener
  // exists — rather than one customer action at a time.
  const exerciseControlOptions = options.authorityControlledExecution?.exerciseControls;
  if (options.authorityControlledExecution !== undefined && 'exerciseControls' in options.authorityControlledExecution && exerciseControlOptions === undefined) {
    throw new ExecutionGovernanceError('EXECUTION_EXERCISE_CONTROLS_INVALID', 'authorityControlledExecution.exerciseControls was stated without a value; omit it to compose no exercise controls.');
  }
  if (exerciseControlOptions !== undefined) {
    assertValidExerciseControlCallbacks(exerciseControlOptions, 'authorityControlledExecution.exerciseControls');
    if (exerciseControlOptions.ledger !== undefined) assertValidExerciseControlStore(exerciseControlOptions.ledger, 'authorityControlledExecution.exerciseControls.ledger');
    const sqlitePath: unknown = configuration.exerciseLedger?.sqlitePath;
    if (exerciseControlOptions.ledger === undefined && (typeof sqlitePath !== 'string' || sqlitePath.trim().length === 0)) {
      throw new ExecutionGovernanceError(
        'EXECUTION_EXERCISE_CONTROLS_INVALID',
        'Exercise controls need a durable ledger: supply exerciseControls.ledger, or configure a non-empty exerciseLedger.sqlitePath (AOC_ENTERPRISE_EXERCISE_LEDGER_SQLITE_PATH).',
      );
    }
  }

  // Governed actions are checked just as early, and for the same reason: the
  // canonical ordering needs every one of its prerequisites, and a deployment
  // missing any of them gets no orchestrator rather than a weaker one.
  // P9: the trusted monetary configuration, built once and validated before any
  // store is opened. Absent, it recognizes no asset and classifies nothing as
  // financial — the closed direction.
  const monetary: GovernedActionMonetaryTrust = Object.freeze({
    assets: createMonetaryAssetRegistry(options.monetary?.assets ?? []),
    actionClassifier: createFinancialActionClassifier({ financialActions: options.monetary?.financialActions ?? [] }),
  });
  // CORE-03: the trusted semantic configuration, built and validated with the
  // same timing and for the same reason — before any store opens. Absent, it
  // classifies nothing, which is the pre-CORE-03 behaviour exactly.
  const governance: GovernanceProfileRegistry = createGovernanceProfileRegistry(options.governance);

  const governedActionOptions = options.governedActionOrchestrator?.enabled === true ? options.governedActionOrchestrator : undefined;
  if (governedActionOptions !== undefined) {
    if (!customerIdentityRequested) {
      throw new GovernedActionConfigurationError(
        'GOVERNED_ACTION_CUSTOMER_IDENTITY_REQUIRED',
        'Governed actions act only for a bound customer identity, and customer identity admission is not enabled.',
      );
    }
    if (options.authorityControlledExecution === undefined) {
      throw new GovernedActionConfigurationError(
        'GOVERNED_ACTION_EXECUTION_REQUIRED',
        'Governed actions issue and exercise bounded grants, and authorityControlledExecution is not composed.',
      );
    }
    if (options.authorityControlledExecution.kernel !== undefined) {
      throw new GovernedActionConfigurationError(
        'GOVERNED_ACTION_KERNEL_NOT_PROVABLY_GRANT_AWARE',
        'Governed actions require the execution Kernel this composition root builds with the declared grant capability; a host-supplied Kernel cannot be proven grant-aware here.',
      );
    }
    if (!isCanonicalCustomerIdentifier(governedActionOptions.trustDomainId) || typeof governedActionOptions.grantPolicy !== 'function') {
      throw new GovernedActionConfigurationError(
        'GOVERNED_ACTION_CONFIGURATION_INVALID',
        'Governed actions require a canonical trustDomainId and a trusted grantPolicy function.',
      );
    }
  }

  // CORE-04: the Trusted Context Boundary and obligations, validated and
  // composed now — before any store opens — so a profile that declares a fact
  // no source may attest, or obligations nothing can discharge, stops
  // composition instead of failing every request that depends on it.
  let governedTrust: GovernedTrustComposition | undefined;
  if (governedActionOptions !== undefined) {
    const { provider: contextProvider, ...trustedContextConfiguration } = options.trustedContext ?? { sources: [] };
    const { store: _obligationStore, ...obligationConfiguration } = options.obligations ?? { sources: [] };
    governedTrust = composeGovernedTrust({
      governance,
      organizationId: configuration.kernelAuthority.organizationId,
      ...(options.trustedContext !== undefined ? { trustedContext: trustedContextConfiguration } : {}),
      ...(contextProvider !== undefined ? { contextProvider } : {}),
      ...(options.obligations !== undefined ? { obligations: obligationConfiguration } : {}),
      policyComposed: options.policyPackProvider !== undefined,
    });
  } else if (options.trustedContext !== undefined || options.obligations !== undefined) {
    throw new GovernedActionConfigurationError('GOVERNED_ACTION_TRUSTED_CONTEXT_INVALID', 'trustedContext and obligations configure the governed-action path, and governed actions are not enabled.');
  }

  // Which governed authority-bearing stores this composition will open, decided
  // here — before any store opens — and used verbatim where they are composed
  // below, so the external-custody check and the composition cannot disagree.
  // CORE-04: the obligation discharge store exists exactly when obligations are
  // composed on the governed path. CORE-05: the approval store exists exactly
  // when governed actions are enabled and some Governance Profile declares how
  // its decisions can be approved.
  const obligationStoreComposed = governedTrust?.obligations !== undefined;
  const approvalsDeclared = governedActionOptions !== undefined && governance.profiles.some((profile) => profile.definition.approval !== undefined);
  // Both follow the composed Governance Store: signed SQLite when it is SQLite,
  // in-process and unsigned otherwise.
  const governanceStoreKind: GovernanceStore['providerKind'] = options.persistence?.providerKind ?? (configuration.persistence.provider === 'sqlite' ? 'sqlite' : 'memory');
  // CORE-02R round 2: under external custody neither may be selected in
  // memory. A supplied ephemeral Governance Store is refused only when it would
  // actually carry obligation or approval authority; a legacy composition that
  // opens neither keeps its grant/revocation authority on the signed SQLite
  // store and may run over any Governance Store.
  if (configuration.authorityAuthenticity.mode === 'external' && governanceStoreKind !== 'sqlite') {
    const inMemoryAuthority = [...(obligationStoreComposed ? ['obligation discharge'] : []), ...(approvalsDeclared ? ['approval'] : [])];
    if (inMemoryAuthority.length > 0) {
      const selected = options.persistence !== undefined ? `a supplied '${governanceStoreKind}' Governance Store` : `persistence.provider '${configuration.persistence.provider}'`;
      throw new AuthorityAuthenticityConfigurationError(
        `This Host is configured for external authority-key custody with authority-controlled execution, and ${selected} would select in-memory, unsigned ${inMemoryAuthority.join(' and ')} stores for the governed actions composed here — the configured signer would never be contacted. External custody requires durable persistence for every authority-bearing store it composes (a SQLite Governance Store). There is no unsigned external mode.`,
      );
    }
  }

  // PROD-01: the authenticity boundary is resolved before any store is opened,
  // so a missing, mismatched or untrusted signing key refuses the Host before a
  // single SQLite file exists — not after the Governance, Passport, Assurance
  // and Kernel Authority stores have been opened. Software custody: key parsing
  // only. External custody (CORE-02): the custody service's pinned identity is
  // proven here — before any store is opened — or the Host does not start.
  // Established after the pure configuration checks above, so a composition
  // they refuse never reaches the signer. Resolved at most once: every store
  // this root opens shares one boundary.
  let authorityAuthenticityOnce: Promise<AuthorityAuthenticityBoundary> | undefined;
  const resolveAuthorityAuthenticity = (): Promise<AuthorityAuthenticityBoundary> => (authorityAuthenticityOnce ??= buildAuthorityAuthenticity(configuration));
  if (options.authorityControlledExecution !== undefined && options.authorityControlledExecution.grantStore === undefined && configuration.persistence.provider === 'sqlite') {
    await resolveAuthorityAuthenticity();
  }
  // CORE-07: the freshness witness, likewise proven before any store is
  // opened — whenever some durable authority store will be composed here. At
  // most once; every store shares one boundary.
  let authorityFreshnessOnce: Promise<AuthorityStateFreshnessBoundary | undefined> | undefined;
  const resolveAuthorityFreshness = (): Promise<AuthorityStateFreshnessBoundary | undefined> => (authorityFreshnessOnce ??= buildAuthorityFreshness(configuration));
  if (freshnessExternal && ((options.authorityControlledExecution !== undefined && configuration.persistence.provider === 'sqlite') || (governanceStoreKind === 'sqlite' && (obligationStoreComposed || approvalsDeclared)))) {
    await resolveAuthorityFreshness();
  }

  // P12: execution reconciliation, validated and snapshotted before any store
  // is opened. The authorities and the selector are read here, once; nothing
  // later discovers, adds or swaps one.
  let resolutionAuthorities: ResolutionAuthorityComposition | undefined;
  if (options.executionReconciliation?.enabled === true) {
    if (governedActionOptions === undefined) {
      throw new ExecutionReconciliationConfigurationError('executionReconciliation requires governedActionOrchestrator: there are no governed executions to reconcile without it.');
    }
    resolutionAuthorities = snapshotResolutionAuthorities(options.executionReconciliation.authorities, options.executionReconciliation.selectAuthority, 'executionReconciliation');
  }

  // P0-PKG-07: the durable authority path. Explicitly-supplied
  // `kernelProviders` still win outright -- that is how the Kernel's own
  // characterization suite injects a seeded world, and how an embedder
  // composes a provider set this root knows nothing about.
  //
  // Otherwise: a deployment that configured (or injected) a Kernel Authority
  // Store gets its operator-provisioned world restored from that store; every
  // other deployment gets exactly what it always got.
  // Opening the authority source and restoring its world is where a
  // misconfigured or corrupt deployment fails, so the module's declared
  // criticality has to be honoured *here* -- the lifecycle controller only
  // sees modules that were successfully constructed.
  //
  // `required` (the default) fails startup outright: a Host that cannot read
  // its authority source must not run. `optional` degrades instead, and
  // degrading means falling back to the empty, fail-closed world -- which
  // denies everything. It never means carrying on with a stale or invented
  // one. Either way no request is ever allowed out of a world this Host could
  // not verify.
  let kernelAuthorityStore: KernelAuthorityStore | undefined;
  let kernelAuthorityStartupFailure: Error | undefined;
  if (options.kernelAuthorityStore !== undefined) {
    kernelAuthorityStore = options.kernelAuthorityStore;
  } else if (configuration.kernelAuthority.enabled) {
    try {
      const store = await buildKernelAuthorityStore(configuration, () => new Date().toISOString(), eventIdGenerator.nextId);
      opened.push(() => store.close());
      kernelAuthorityStore = store;
    } catch (error) {
      if (configuration.kernelAuthority.required) throw error;
      kernelAuthorityStartupFailure = error instanceof Error ? error : new Error(String(error));
    }
  }

  let durableKernelWorld: DurableKernelWorld | undefined;
  if (options.kernelProviders === undefined && kernelAuthorityStore !== undefined) {
    try {
      durableKernelWorld = await createDurableKernelWorld({ store: kernelAuthorityStore, organizationId: configuration.kernelAuthority.organizationId });
    } catch (error) {
      if (configuration.kernelAuthority.required) throw error;
      kernelAuthorityStartupFailure = error instanceof Error ? error : new Error(String(error));
    }
  }

  const kernelProviders: KernelProviderSet = options.kernelProviders ?? durableKernelWorld?.providerSet ?? createDefaultKernelProviders();

  // The write half of the provisioning/evaluation separation. It is
  // constructed only when a durable authority source exists, it is never
  // consulted by `evaluate()`, and every method on it independently demands a
  // privileged operator context -- so possessing this object is not by itself
  // authority to use it.
  const kernelAuthorityProvisioning: KernelAuthorityProvisioningService | undefined =
    kernelAuthorityStore === undefined
      ? undefined
      : createKernelAuthorityProvisioningService({
          store: kernelAuthorityStore,
          organizationId: configuration.kernelAuthority.organizationId,
          ...(durableKernelWorld !== undefined ? { onCommitted: () => durableKernelWorld.service.reload() } : {}),
          // P10: obvious monetary-authority faults (an unknown asset, a value
          // beyond its trusted scale) are refused when provisioned.
          monetaryAssets: monetary.assets,
        });

  // The read half, narrowed further: customer admission is handed a
  // one-method binding reader over this same store, never the store and never
  // the provisioning surface above.
  let customerIdentityAdmission: CustomerIdentityAdmissionService | undefined;
  if (customerIdentityRequested) {
    if (kernelAuthorityStore === undefined) {
      throw new CustomerIdentityConfigurationError(
        'CUSTOMER_IDENTITY_AUTHORITY_UNAVAILABLE',
        'Customer identity admission was requested, but the Kernel Authority store could not be opened; no customer principal can be bound without it.',
      );
    }
    customerIdentityAdmission = createCustomerIdentityAdmission({
      apiKeys: configuration.authentication.apiKeys,
      subjectBindings: createKernelAuthoritySubjectBindingReader(kernelAuthorityStore),
      organizationId: configuration.kernelAuthority.organizationId,
    });
  }

  const persistence = options.persistence ?? (await buildStore(configuration, kernelProviders.clock.now));
  if (options.persistence === undefined) opened.push(() => persistence.close());
  if (governedActionOptions !== undefined) {
    // Checked here, against the store actually composed, because a host may inject its own.
    // Before the lifecycle starts, so a refused composition leaves nothing running.
    const canonicalStore = [persistence.appendEvaluation, persistence.resolveIdempotency, persistence.getByRequestId, persistence.getByEvaluationId, persistence.verify, persistence.appendReference].every(
      (method) => typeof method === 'function',
    );
    if (!canonicalStore) {
      throw new GovernedActionConfigurationError(
        'GOVERNED_ACTION_GOVERNANCE_STORE_UNAVAILABLE',
        'Governed actions commit every decision to the Governance Store before issuing authority, and the composed store cannot append, re-read, verify and reference decisions.',
      );
    }
  }
  const evidenceStore = options.evidenceStore ?? createInMemoryEvidenceStore({ now: kernelProviders.clock.now });
  const passportStore = options.passportStore ?? (await buildPassportStore(configuration, kernelProviders.clock.now, eventIdGenerator.nextId));
  if (options.passportStore === undefined) opened.push(() => passportStore.close());
  const assuranceStore = options.assuranceStore ?? (await buildAssuranceStore(configuration, kernelProviders.clock.now));
  if (options.assuranceStore === undefined) opened.push(() => assuranceStore.close());
  const eventPublisher = options.eventPublisher ?? createInProcessEventPublisher();
  const telemetry = options.telemetry ?? createEnterpriseTelemetry();
  const logger = options.logger ?? createEnterpriseLogger(configuration.logLevel);

  const kernel =
    options.kernel ??
    createAocKernel({
      recognitionProvider: kernelProviders.recognitionProvider,
      clock: kernelProviders.clock,
      idGenerator: kernelProviders.idGenerator,
      ...(options.policyPackProvider !== undefined ? { policyPackProvider: options.policyPackProvider } : {}),
    });

  // Opt-in, and narrow on purpose. `contextResolution`, `obligations` and
  // `grants` are NOT enabled on the Kernel above merely because the runtimes
  // exist: the Kernel the frozen evaluation path uses is composed exactly as it
  // was. A deployment adopting layer E gets a second, grant-aware instance over
  // the same providers, so the record `POST /api/governance/evaluate` commits
  // is unchanged whether or not this capability is composed.
  // Resolved here rather than inside the expression below, so the composition
  // root holds a reference to the store it will hand over and knows whether it
  // was the one that opened it. A host-supplied store is never closed from
  // here: the host closes what the host opened.
  const grantStore: BoundedGrantStorePort | undefined =
    options.authorityControlledExecution === undefined
      ? undefined
      : (options.authorityControlledExecution.grantStore ?? (await buildBoundedGrantStore(configuration, resolveAuthorityAuthenticity, resolveAuthorityFreshness)));
  const grantStoreOpenedHere = options.authorityControlledExecution !== undefined && options.authorityControlledExecution.grantStore === undefined;
  if (grantStoreOpenedHere) opened.push(() => closeIfClosable(grantStore));

  // The exercise-control ledger (P7), opened **only** when exercise controls
  // are composed and the host supplied no ledger — and then always the durable
  // SQLite one. Same ownership rule as every store above: what this root
  // opened, this root closes; what a host supplied, the host closes.
  const exerciseLedger: ExerciseControlLedgerPort | undefined =
    exerciseControlOptions === undefined
      ? undefined
      : (exerciseControlOptions.ledger ??
        (await createSqliteExerciseControlLedger(configuration.exerciseLedger.sqlitePath, {
          busyTimeoutMs: configuration.persistence.busyTimeoutMs,
          // The same clock the grant is assessed by: the ledger samples it
          // inside BEGIN IMMEDIATE to assign the reservation instant.
          now: kernelProviders.clock.now,
        })));
  const exerciseLedgerOpenedHere = exerciseControlOptions !== undefined && exerciseControlOptions.ledger === undefined;
  if (exerciseLedgerOpenedHere) opened.push(() => closeIfClosable(exerciseLedger));

  // P8: the canonical authority event stream, composed with governed actions
  // only. Evidence, so an unopenable store is *not* a startup failure: the
  // projector runs over no store, records every failure, and the module reports
  // unhealthy — while decisions, grants and effects proceed exactly as without
  // a stream. A host-supplied store is used verbatim and never closed here.
  let authorityEventStore: AuthorityEventStreamStore | undefined;
  let authorityEventStoreOpenFailure: Error | undefined;
  if (governedActionOptions !== undefined) {
    if (options.authorityEventStream?.store !== undefined) {
      authorityEventStore = options.authorityEventStream.store;
    } else {
      try {
        authorityEventStore = await buildAuthorityEventStreamStore(configuration, kernelProviders.clock.now);
      } catch (error) {
        authorityEventStoreOpenFailure = error instanceof Error ? error : new Error(String(error));
      }
    }
  }
  const authorityEventStoreOpenedHere = authorityEventStore !== undefined && options.authorityEventStream?.store === undefined;
  if (authorityEventStoreOpenedHere) opened.push(() => closeIfClosable(authorityEventStore));

  // P11: the durable execution outcome store, composed with governed actions
  // and never without them. Load-bearing — a governed execution is refused
  // before its claim when it cannot be prepared — so a store that cannot be
  // opened fails startup here rather than one action at a time.
  const executionOutcomeStore: ExecutionOutcomeStore | undefined =
    governedActionOptions === undefined ? undefined : (options.executionOutcomes?.store ?? (await buildExecutionOutcomeStore(configuration, kernelProviders.clock.now)));
  const executionOutcomeStoreOpenedHere = executionOutcomeStore !== undefined && options.executionOutcomes?.store === undefined;
  if (executionOutcomeStoreOpenedHere) opened.push(() => closeIfClosable(executionOutcomeStore));
  // P12: the execution resolution store, only when reconciliation is enabled.
  // Load-bearing before the claim, so a store that cannot be opened fails
  // startup here — never a silent fallback to memory.
  const executionResolutionStore: ExecutionResolutionStore | undefined =
    resolutionAuthorities === undefined ? undefined : (options.executionReconciliation?.store ?? (await buildExecutionResolutionStore(configuration, kernelProviders.clock.now)));
  const executionResolutionStoreOpenedHere = executionResolutionStore !== undefined && options.executionReconciliation?.store === undefined;
  if (executionResolutionStoreOpenedHere) opened.push(() => closeIfClosable(executionResolutionStore));
  // CORE-04: the obligation discharge store, only when obligations are
  // composed — the durable SQLite file under `sqlite` persistence (an
  // obligation that forgot its verified discharge on restart would withhold
  // forever; one that forgot a pending one would be harmless — but a durable
  // deployment never silently downgrades either way), in-memory otherwise.
  const obligationDischargeStore: ObligationDischargeStore | undefined =
    !obligationStoreComposed
      ? undefined
      : (options.obligations?.store ??
        (persistence.providerKind === 'sqlite'
          ? await createSqliteObligationDischargeStore(configuration.obligationDischarge.sqlitePath, {
              now: kernelProviders.clock.now,
              busyTimeoutMs: configuration.persistence.busyTimeoutMs,
              organizationId: configuration.kernelAuthority.organizationId,
              // The same authority signer and trusted verifier the grant store
              // uses: a verified discharge releases issuance, so its store's
              // committed state is an authority artifact.
              authenticity: await resolveAuthorityAuthenticity(),
              // CORE-07: anchored at the same witness, when one is configured.
              ...(await withFreshness(resolveAuthorityFreshness)),
            })
          : createInMemoryObligationDischargeStore({ organizationId: configuration.kernelAuthority.organizationId })));
  const obligationDischargeStoreOpenedHere = obligationDischargeStore !== undefined && options.obligations?.store === undefined;
  if (obligationDischargeStoreOpenedHere) opened.push(() => closeIfClosable(obligationDischargeStore));
  // CORE-04: the one trusted answer to "which Governance Profile governs this
  // request?" — the frozen registry resolving its action and resource. The
  // Kernel's context and obligation capabilities select by this, never by the
  // semantics a request carries (which a direct Kernel caller controls).
  const resolveEffectiveProfile: KernelEffectiveProfileResolver = (action, resourceScope) => {
    const resolution = governance.resolve(action, resourceScope);
    if (resolution.kind === 'resolved') return { kind: 'resolved', profile: resolution.profile.reference };
    return resolution.kind === 'unclassified' ? { kind: 'unclassified' } : { kind: 'refused' };
  };
  // CORE-05: the durable approval store, only when some Governance Profile
  // declares how its decisions can be approved — the authenticated SQLite
  // file under `sqlite` persistence (an approval that forgot itself on
  // restart would withhold forever, and one that forgot a rejection could be
  // re-approved), in-memory otherwise.
  const approvalStore: ApprovalStore | undefined = !approvalsDeclared
    ? undefined
    : (options.approvals?.store ??
      (persistence.providerKind === 'sqlite'
        ? await createSqliteApprovalStore(configuration.approval.sqlitePath, {
            now: kernelProviders.clock.now,
            busyTimeoutMs: configuration.persistence.busyTimeoutMs,
            organizationId: configuration.kernelAuthority.organizationId,
            // The same authority signer and trusted verifier the grant store
            // uses: a completed approval resumes a decision into a grant, so
            // its store's committed state is an authority artifact.
            authenticity: await resolveAuthorityAuthenticity(),
            // CORE-07: anchored at the same witness, when one is configured.
            ...(await withFreshness(resolveAuthorityFreshness)),
          })
        : createInMemoryApprovalStore({ organizationId: configuration.kernelAuthority.organizationId })));
  const approvalStoreOpenedHere = approvalStore !== undefined && options.approvals?.store === undefined;
  if (approvalStoreOpenedHere) opened.push(() => closeIfClosable(approvalStore));
  // Approver standing is Kernel-Authority — the one governed-path authority
  // source — read live from the same world the Kernel decides against, through
  // approval-runtime's own recognition and authority integrations (so its
  // policies judge exactly what they judge everywhere else), and additionally
  // required to be live on every hop (the CORE-04 lineage revalidator). Never
  // taken from a command. The world handles are read through the provider
  // getters on every call: a Kernel-Authority revocation reloads the world and
  // is seen by the next approval read.
  const approvalAuthority: ApprovalAuthority | undefined =
    approvalStore === undefined || governedActionOptions === undefined
      ? undefined
      : (() => {
          const organizationId = configuration.kernelAuthority.organizationId;
          const trustDomainId = governedActionOptions.trustDomainId;
          const lineage = createKernelAuthorityLineageRevalidator({ organizationId, trustDomainId, authority: () => kernelProviders.authorityRuntime });
          return createApprovalAuthority({
            store: approvalStore,
            governance,
            resolveEffectiveProfile,
            organizationId,
            authority: {
              recognition: (actorId) => createActorRegistryRecognitionIntegration(kernelProviders.recognitionRuntime.actorRegistry).getApproverRecognitionStatus(actorId),
              authority: ({ actorId, capability, resourceScope, at }) => {
                const check = createApprovalAuthorityGraphIntegration(kernelProviders.authorityRuntime).verifyAuthority({
                  requestId: 'approval-authority:check',
                  actorId,
                  trustDomainId,
                  action: capability,
                  resourceScope,
                  requestedAt: at,
                });
                if (check.valid && !lineage({ subject: actorId, action: capability, resourceScope, organizationId, at })) {
                  return { ...check, valid: false, type: 'authority_missing', reasonCode: 'APPROVER_AUTHORITY_NOT_LIVE', reason: 'A hop of the approver authority chain is no longer active.' };
                }
                return check;
              },
            },
            now: kernelProviders.clock.now,
          });
        })();
  // The one obligation capability shape the grant-aware Kernel decides with
  // and the orchestrator re-reads at issuance: same sources, same profile
  // declarations, same store, same trusted profile resolution.
  const governedObligationOptions =
    governedTrust?.obligations === undefined || obligationDischargeStore === undefined
      ? undefined
      : {
          provider: createStoredObligationDischargeProvider(obligationDischargeStore, configuration.kernelAuthority.organizationId),
          sources: governedTrust.obligations.sources,
          declaration: { requirements: [] },
          profileDeclarations: governedTrust.obligations.profileDeclarations,
          resolveEffectiveProfile,
        };
  // The write-only projector: the one object lifecycle modules are handed.
  const authorityEvents: AuthorityEventProjector | undefined =
    governedActionOptions === undefined || grantStore === undefined || customerIdentityAdmission === undefined
      ? undefined
      : createAuthorityEventProjector({ organizationId: customerIdentityAdmission.organizationId, store: authorityEventStore, grants: grantStore });

  // ONE emergency-control instance for the whole deployment. Every checkpoint
  // below reads this object: the orchestrator's admission check, the grant
  // store's synchronous commit guard, the exercise gate, and the adapter
  // registry. Composing more than one would create worlds that disagree, and an
  // operator who stopped one of them would believe they had stopped execution.
  const emergencyControlRequested = options.emergencyControl?.enabled === true;
  const emergencyControlStore: EmergencyControlStorePort | undefined = emergencyControlRequested
    ? (options.emergencyControl?.store ?? (await buildEmergencyControlStore(configuration)))
    : undefined;
  const emergencyControlOpenedHere = emergencyControlRequested && options.emergencyControl?.store === undefined;
  if (emergencyControlOpenedHere) opened.push(() => closeIfClosable(emergencyControlStore));
  // Narrowed to the **read** capability before it is handed to anything that
  // executes — a fresh one-method object over the same store, exactly as
  // customer admission is handed a binding reader rather than the authority
  // store. Typing alone would make `activate`/`release` unreachable to the
  // compiler; this makes them unreachable to a cast as well, while keeping one
  // emergency-control world behind all four checkpoints.
  const emergencyControl: EmergencyControlReaderPort | undefined =
    emergencyControlStore === undefined ? undefined : createEmergencyControlReader(emergencyControlStore);

  // The execution boundary: one provider adapter, or the composite registry
  // built from the host's trusted routing table. The registry is built *here*
  // rather than by the host so it receives the same emergency-control reader
  // every other checkpoint uses.
  const executionAdapter: ExecutionAdapter | undefined =
    options.authorityControlledExecution === undefined
      ? undefined
      : options.authorityControlledExecution.executionAdapterRouting !== undefined
        ? createExecutionAdapterRegistry({
            ...(options.authorityControlledExecution.executionAdapterRouting.adapterId !== undefined
              ? { adapterId: options.authorityControlledExecution.executionAdapterRouting.adapterId }
              : {}),
            // Host adapters, then the Generic HTTP children built above, as
            // members of the one registry. A non-array `adapters` is handed
            // through untouched so the registry refuses it exactly as before.
            adapters:
              genericHttpAdapters.length === 0 || !Array.isArray(options.authorityControlledExecution.executionAdapterRouting.adapters)
                ? options.authorityControlledExecution.executionAdapterRouting.adapters
                : [...options.authorityControlledExecution.executionAdapterRouting.adapters, ...genericHttpAdapters],
            selectAdapter: options.authorityControlledExecution.executionAdapterRouting.selectAdapter,
            ...(emergencyControl !== undefined ? { emergencyControl } : {}),
          })
        : options.authorityControlledExecution.executionAdapter;

  // One options object, so the legacy service and the governed-action
  // issuance core are composed over exactly the same Kernel, declaration,
  // grant store, adapter, clock and binding resolver.
  const authorityControlledExecutionOptions: AuthorityControlledExecutionOptions | undefined =
    options.authorityControlledExecution === undefined || grantStore === undefined || executionAdapter === undefined
      ? undefined
      : {
          kernel:
            options.authorityControlledExecution.kernel ??
            createAocKernel({
              recognitionProvider: kernelProviders.recognitionProvider,
              clock: kernelProviders.clock,
              idGenerator: kernelProviders.idGenerator,
              ...(options.policyPackProvider !== undefined ? { policyPackProvider: options.policyPackProvider } : {}),
              grants: { declaration: options.authorityControlledExecution.grantCapability.declaration },
              // CORE-04: the Trusted Context Boundary — admission, per effective
              // Governance Profile, before deterministic policy — and the
              // profile-declared obligations, on the one grant-aware Kernel.
              ...(governedTrust?.context !== undefined
                ? {
                    contextResolution: {
                      provider: governedTrust.context.provider,
                      sources: governedTrust.context.sources,
                      declaration: { requirements: [] },
                      profileDeclarations: governedTrust.context.profileDeclarations,
                      resolveEffectiveProfile,
                    },
                  }
                : {}),
              ...(governedObligationOptions !== undefined ? { obligations: governedObligationOptions } : {}),
            }),
          grantCapability: options.authorityControlledExecution.grantCapability,
          grantStore,
          executionAdapter,
          resolveAuthorityBinding: options.authorityControlledExecution.resolveAuthorityBinding,
          ...(options.authorityControlledExecution.revalidateSource !== undefined
            ? { revalidateSource: options.authorityControlledExecution.revalidateSource }
            : {}),
          ...(emergencyControl !== undefined ? { emergencyControl } : {}),
          ...(exerciseControlOptions !== undefined && exerciseLedger !== undefined
            ? {
                exerciseControls: {
                  policy: exerciseControlOptions.policy,
                  revalidateAuthorityBinding: exerciseControlOptions.revalidateAuthorityBinding,
                  reservationLedger: exerciseLedger,
                  actionClassifier: monetary.actionClassifier,
                },
              }
            : {}),
          // P10: authority-sourced payment ceilings and durable spending limits,
          // resolved from the same hydrated authority world the Kernel decides
          // against, for the trust domain governed actions are evaluated in.
          // Composed only together with P7, which enforces the aggregate
          // limits; without it every financial action is withheld at issuance.
          ...(exerciseControlOptions !== undefined && exerciseLedger !== undefined && governedActionOptions !== undefined
            ? {
                financialAuthority: {
                  resolve: createKernelFinancialAuthorityResolver({
                    organizationId: configuration.kernelAuthority.organizationId,
                    trustDomainId: governedActionOptions.trustDomainId,
                    assets: monetary.assets,
                    authority: () => kernelProviders.authorityRuntime,
                  }),
                },
              }
            : {}),
          // CORE-04: exercise-time lineage revalidation for non-financial
          // grants, from the same authority world — composed wherever P10's
          // financial revalidation is.
          ...(exerciseControlOptions !== undefined && exerciseLedger !== undefined && governedActionOptions !== undefined
            ? {
                authorityLineage: (() => {
                  const revalidate = createKernelAuthorityLineageRevalidator({
                    organizationId: configuration.kernelAuthority.organizationId,
                    trustDomainId: governedActionOptions.trustDomainId,
                    authority: () => kernelProviders.authorityRuntime,
                  });
                  return (query: { readonly subject: string; readonly organization?: string; readonly at: string; readonly correlation: { readonly action: string; readonly resourceScope: string } }) =>
                    revalidate({
                      subject: query.subject,
                      action: query.correlation.action,
                      resourceScope: query.correlation.resourceScope,
                      ...(query.organization !== undefined ? { organizationId: query.organization } : {}),
                      at: query.at,
                    });
                })(),
              }
            : {}),
          // P8: write-only evidence of revocations and reservation facts.
          ...(authorityEvents !== undefined ? { evidence: authorityEvents } : {}),
          now: kernelProviders.clock.now,
        };
  const authorityControlledExecution: AuthorityControlledExecutionService | undefined =
    authorityControlledExecutionOptions === undefined ? undefined : createAuthorityControlledExecution(authorityControlledExecutionOptions);

  const bootId = eventIdGenerator.nextId('boot');
  await persistence.recordEnterpriseVersion({
    bootId,
    enterpriseVersion: configuration.enterpriseVersion,
    kernelVersion: AOC_KERNEL_VERSION,
    recordedAt: kernelProviders.clock.now(),
  });

  // Durable lifecycle history (PR-004 section 6): every lifecycle/module
  // event published from here on is appended to the Governance Store as a
  // standalone event record (linked by correlation, never by foreign key).
  // Best-effort by design — operational history must never block or fail
  // startup/shutdown, and events raced past `close()` are dropped silently.
  /**
   * Closes the bounded-grant store **only** when this composition root opened
   * it. A host-supplied store outlives this Host by design: it may be shared,
   * and closing someone else's authoritative store on shutdown would make a
   * second Host's grants unreadable.
   *
   * A store with no `close` is the in-memory one, which owns no handle.
   */
  async function closeComposedGrantStore(): Promise<void> {
    if (!grantStoreOpenedHere || grantStore === undefined) return;
    const closable = grantStore as Partial<{ close: () => Promise<void> }>;
    if (typeof closable.close === 'function') await closable.close();
  }

  /**
   * The same ownership discipline for the emergency-control store: closed only
   * when this composition root opened it.
   *
   * A host-supplied store outlives this Host by design. It may be shared with
   * an operator CLI or a second Host, and closing someone else's kill switch on
   * shutdown would leave them unable to read it — which, since an unreadable
   * control withholds, would stop their execution rather than free it. Closed
   * is the safe direction here, but it is still not ours to do.
   */
  async function closeComposedEmergencyControlStore(): Promise<void> {
    if (!emergencyControlOpenedHere || emergencyControlStore === undefined) return;
    const closable = emergencyControlStore as Partial<{ close: () => Promise<void> }>;
    if (typeof closable.close === 'function') await closable.close();
  }

  /** The same ownership discipline for the exercise-control ledger: closed only when this composition root opened it. */
  /** The same ownership discipline for the authority event stream store: closed only when this composition root opened it. */
  async function closeComposedAuthorityEventStore(): Promise<void> {
    if (!authorityEventStoreOpenedHere || authorityEventStore === undefined) return;
    await authorityEventStore.close();
  }

  /** The same ownership discipline for the execution outcome store: closed only when this composition root opened it. */
  async function closeComposedExecutionOutcomeStore(): Promise<void> {
    if (!executionOutcomeStoreOpenedHere || executionOutcomeStore === undefined) return;
    await executionOutcomeStore.close();
  }

  /** The same ownership discipline for the execution resolution store: closed only when this composition root opened it. */
  async function closeComposedExecutionResolutionStore(): Promise<void> {
    if (!executionResolutionStoreOpenedHere || executionResolutionStore === undefined) return;
    await executionResolutionStore.close();
  }

  async function closeComposedExerciseLedger(): Promise<void> {
    if (!exerciseLedgerOpenedHere || exerciseLedger === undefined) return;
    const closable = exerciseLedger as Partial<{ close: () => Promise<void> }>;
    if (typeof closable.close === 'function') await closable.close();
  }

  const unsubscribeLifecyclePersistence = eventPublisher.subscribe((event) => {
    if ('lifecycleCorrelationId' in event) {
      void persistence.appendLifecycleEvent(event).catch(() => {});
    }
  });

  // PR-007: register Assurance frameworks at composition time (mission
  // section 46) -- the built-in `aoc.saf` 1.0.0 plus any caller-supplied
  // frameworks; the registry freezes when the Assurance module initializes.
  const assuranceFrameworkRegistry = createAssuranceFrameworkRegistry();
  assuranceFrameworkRegistry.register(AOC_SAF_FRAMEWORK_V1);
  for (const framework of options.assuranceFrameworks ?? []) assuranceFrameworkRegistry.register(framework);
  for (const framework of assuranceFrameworkRegistry.list()) {
    const definition = assuranceFrameworkRegistry.get(framework.frameworkId, framework.frameworkVersion);
    if (definition !== undefined) {
      // Best-effort persistence of the definition so stored assessments can be
      // verified against their framework even across process restarts.
      await assuranceStore.saveFramework({ system: true }, definition).catch(() => {});
    }
  }

  // The governed spine is `required` only when the host says governed
  // execution is what it runs for (the Enterprise Host bootstrap does).
  const spineCriticality: 'required' | 'optional' = governedActionOptions?.required === true ? 'required' : 'optional';

  const registry = createEnterpriseModuleRegistry();
  registry.register(createTelemetryModule(telemetry, configuration.telemetry.enabled, kernelProviders.clock.now));
  registry.register(createEventsModule(eventPublisher, configuration.eventPublishing.enabled, kernelProviders.clock.now));
  registry.register(createGovernanceStoreModule(persistence, kernelProviders.clock.now));
  registry.register(createProvidersModule(kernelProviders, kernelProviders.clock.now, options.policyPackProvider !== undefined));
  registry.register(createKernelModule(kernel, kernelProviders.clock.now));
  if (authorityControlledExecution !== undefined && options.authorityControlledExecution !== undefined) {
    registry.register(
      createAuthorityControlledExecutionModule(
        authorityControlledExecution,
        // The composite registry's own id when routing is composed, so the
        // module reports the boundary this Host actually holds rather than one
        // of the children behind it.
        executionAdapter?.adapterId ?? 'unknown',
        kernelProviders.clock.now,
        grantStore,
        spineCriticality,
      ),
    );
  }
  if (authorityControlledExecution !== undefined && exerciseLedger !== undefined) {
    registry.register(createExerciseControlModule(exerciseLedger, kernelProviders.clock.now, spineCriticality));
  }
  if (governedActionOptions !== undefined) {
    registry.register(createGovernedActionOrchestratorModule(kernelProviders.clock.now, spineCriticality));
    if (executionOutcomeStore !== undefined) registry.register(createExecutionOutcomeModule(executionOutcomeStore, kernelProviders.clock.now, spineCriticality));
    if (executionResolutionStore !== undefined && resolutionAuthorities !== undefined) {
      registry.register(createExecutionResolutionModule(executionResolutionStore, resolutionAuthorities.authorities.size, kernelProviders.clock.now));
    }
    if (authorityEvents !== undefined) {
      registry.register(
        createAuthorityEventStreamModule({
          store: authorityEventStore,
          ...(authorityEventStoreOpenFailure !== undefined ? { openFailure: authorityEventStoreOpenFailure } : {}),
          projection: () => authorityEvents.health(),
          now: kernelProviders.clock.now,
        }),
      );
    }
  }
  registry.register(createAgentPassportModule(passportStore, kernelProviders.clock.now, configuration.passport.required));
  registry.register(createAssuranceModule(assuranceStore, assuranceFrameworkRegistry, kernelProviders.clock.now, configuration.assurance.required));
  if (kernelAuthorityStore !== undefined) {
    registry.register(createKernelAuthorityModule(kernelAuthorityStore, kernelProviders.clock.now, configuration.kernelAuthority.required));
  } else if (kernelAuthorityStartupFailure !== undefined) {
    // Configured, optional, and unusable: the deployment is entitled to know
    // that from health rather than from the absence of a module.
    registry.register(createUnavailableKernelAuthorityModule(kernelAuthorityStartupFailure, kernelProviders.clock.now));
  }
  for (const module of options.modules ?? []) registry.register(module);
  registry.freeze();

  const lifecycle = createEnterpriseLifecycleController({
    registry,
    logger,
    telemetry,
    eventPublisher,
    configuration,
    enterpriseVersion: configuration.enterpriseVersion,
    now: kernelProviders.clock.now,
    nextId: eventIdGenerator.nextId,
  });

  // Auto-start (mission section 20, Option A): existing consumers expect
  // `createEnterprise()` to return a fully usable instance with no
  // additional `start()` call.
  await lifecycle.start();

  /** Live Enterprise context captured into every appended governance aggregate (PR-004 section 7): lifecycle state, module snapshot, provider snapshot, environment. Bounded — never configuration, credentials, or connection strings. */
  const enterpriseContext = (): GovernanceEnterpriseContext => ({
    enterpriseVersion: configuration.enterpriseVersion,
    lifecycleState: lifecycle.lifecycleState(),
    modules: lifecycle.modules(),
    providers: [
      { providerType: durableKernelWorld !== undefined ? 'recognition-durable' : 'recognition', ready: true },
      ...(options.policyPackProvider !== undefined ? [{ providerType: 'policy-pack', ready: true }] : []),
    ],
    environment: configuration.environment,
  });

  let governedActionOrchestrator: GovernedActionOrchestrator | undefined;
  if (governedActionOptions !== undefined) {
    if (customerIdentityAdmission === undefined || authorityControlledExecution === undefined || authorityControlledExecutionOptions === undefined || executionOutcomeStore === undefined) {
      // Unreachable after the checks above; kept so a future refactor that breaks them fails closed.
      throw new GovernedActionConfigurationError('GOVERNED_ACTION_EXECUTION_REQUIRED', 'Governed actions require customer identity admission and Authority-Controlled Execution.');
    }
    governedActionOrchestrator = createGovernedActionOrchestrator({
      organizationId: customerIdentityAdmission.organizationId,
      trustDomainId: governedActionOptions.trustDomainId,
      issuance: createAuthorityControlledIssuanceCore(authorityControlledExecutionOptions),
      execution: authorityControlledExecution,
      governanceStore: persistence,
      grantPolicy: governedActionOptions.grantPolicy,
      // P9: the same registry and classifier instances the exercise gate holds.
      monetary,
      // CORE-03: the one frozen semantic registry.
      governance,
      // CORE-04: the obligations a committed decision stands under, re-read
      // from the discharge store at issuance — never from the request.
      ...(governedObligationOptions !== undefined
        ? {
            obligations: (() => {
              const capability = new KernelObligationCapability(governedObligationOptions);
              return {
                async satisfiedNow(request: import('../../kernel/index.js').KernelEvaluationRequest): Promise<boolean> {
                  const resolution = await resolveKernelObligations(capability, request, kernelProviders.clock.now());
                  return resolution === undefined ? true : resolveKernelObligationFacts(resolution).evaluation.allBlockingObligationsSatisfied;
                },
              };
            })(),
          }
        : {}),
      // CORE-05: the approval authority's assess port only — never its recorder.
      ...(approvalAuthority !== undefined ? { approvals: { assess: (input) => approvalAuthority.assess(input) } } : {}),
      now: kernelProviders.clock.now,
      enterpriseContext,
      events: { enabled: configuration.eventPublishing.enabled, publisher: eventPublisher, nextId: eventIdGenerator.nextId },
      traceLevel: configuration.features.traceLevel,
      ...(authorityControlledExecutionOptions.revalidateSource !== undefined ? { revalidateSource: authorityControlledExecutionOptions.revalidateSource } : {}),
      // The same instance ACE's commit guard, the exercise gate and the adapter
      // registry read.
      ...(emergencyControl !== undefined ? { emergencyControl } : {}),
      // P8: write-only. The orchestrator reports facts it has established; it
      // never reads the stream, and a failed report changes no result.
      ...(authorityEvents !== undefined ? { evidence: authorityEvents } : {}),
      // P11: the narrow prepare / record / read port — never `health` or `close`.
      executionOutcomes: {
        prepareAttempt: (context, input) => executionOutcomeStore.prepareAttempt(context, input),
        recordTerminal: (context, input) => executionOutcomeStore.recordTerminal(context, input),
        read: (context, executionId) => executionOutcomeStore.read(context, executionId),
      },
      // P12: a binder and a read-only reader — never an authority, never the
      // reconciliation service. Customer replay can read a resolution; it can
      // never ask for one.
      ...(executionResolutionStore !== undefined && resolutionAuthorities !== undefined
        ? {
            executionResolution: {
              binder: createExecutionResolutionBinder({ store: executionResolutionStore, composition: resolutionAuthorities, now: kernelProviders.clock.now }),
              reader: createExecutionResolutionReader(executionResolutionStore),
            },
          }
        : {}),
    });
  }

  // P12: the trusted reconciliation service. It reads P11 through the
  // read-only reader, verifies the existing Governance write-ahead claim,
  // holds the resolution store, the snapshotted authorities and P7's one
  // reconciliation capability — and no execution adapter, exercise gate,
  // grant writer or Kernel.
  const exerciseReconciliation = createExerciseReconciliationCapability(exerciseLedger);
  const executionReconciliation: ExecutionReconciliationService | undefined =
    executionResolutionStore === undefined || resolutionAuthorities === undefined || executionOutcomeStore === undefined
      ? undefined
      : createExecutionReconciliationService({
          outcomes: createExecutionOutcomeReader(executionOutcomeStore),
          resolutions: executionResolutionStore,
          composition: resolutionAuthorities,
          claimed: async (scope, evaluationId, executionId) => {
            const record = await persistence.getByEvaluationId({ system: false, organizationId: scope.organizationId }, evaluationId);
            return record !== null && record.request.organizationId === scope.organizationId && executionClaimRecorded(record, executionId);
          },
          ...(exerciseReconciliation !== undefined ? { capacity: exerciseReconciliation } : {}),
          governanceEvidence: (scope, evaluationId, executionId, resolution) =>
            createExecutionLedger(persistence, { system: false, organizationId: scope.organizationId }, kernelProviders.clock.now).recordResolution(evaluationId, executionId, {
              certainty: resolution.certainty,
              ...(resolution.failure !== undefined ? { failure: resolution.failure } : {}),
              resolutionDigest: resolution.resolutionDigest,
            }),
          ...(authorityEvents !== undefined ? { evidence: authorityEvents } : {}),
          now: kernelProviders.clock.now,
        });

  const governanceReads = createGovernanceReadService(persistence, configuration, telemetry);
  const evidence = createEvidenceService({
    governanceStore: persistence,
    evidenceStore,
    configuration,
    now: kernelProviders.clock.now,
    nextId: eventIdGenerator.nextId,
  });
  const passports = createAgentPassportService({
    store: passportStore,
    governanceStore: persistence,
    evidenceStore,
    telemetry,
    now: kernelProviders.clock.now,
    nextId: eventIdGenerator.nextId,
  });
  const assurance = createAssuranceService({
    store: assuranceStore,
    registry: assuranceFrameworkRegistry,
    evidenceSources: {
      governanceStore: persistence,
      evidenceStore,
      passportStore,
      runtimeHealth: async () => ({
        ready: lifecycle.isReady(),
        lifecycleState: lifecycle.lifecycleState(),
        modules: lifecycle.modules().map((module) => ({ moduleId: module.id, version: module.version, status: module.state })),
        observedAt: kernelProviders.clock.now(),
      }),
    },
    telemetry,
    eventPublisher,
    logger,
    now: kernelProviders.clock.now,
    nextId: eventIdGenerator.nextId,
    enterpriseVersion: configuration.enterpriseVersion,
    moduleSnapshot: () => lifecycle.modules().map((module) => ({ moduleId: module.id, version: module.version, status: module.state })),
  });

  // CTRL-01: composed from the objects above — never a second path to any of
  // them. Absent unless an administrator is configured: there is no default
  // administrator, and no other credential reaches it.
  const administrators = configuration.administration?.administrators ?? [];
  const authorityAdministration: AuthorityAdministrationService | undefined =
    administrators.length === 0
      ? undefined
      : createAuthorityAdministrationService({
          administrators,
          ordinaryCredentials: configuration.authentication.apiKeys,
          organizationId: configuration.kernelAuthority.organizationId,
          now: kernelProviders.clock.now,
          isReady: () => lifecycle.isReady(),
          lifecycleState: () => lifecycle.lifecycleState(),
          logger,
          ...(grantStore !== undefined && authorityControlledExecution !== undefined
            ? { grants: { reader: { read: (grantId: string) => grantStore.read(grantId) }, revoke: (input) => authorityControlledExecution.revokeGrant(input) } }
            : {}),
          ...(kernelAuthorityStore !== undefined && kernelAuthorityProvisioning !== undefined
            ? {
                kernelAuthority: {
                  store: { getRecord: (context, organizationId, entityKind, entityId) => kernelAuthorityStore.getRecord(context, organizationId, entityKind, entityId) },
                  provisioning: { revoke: (context, input, provisioningOptions) => kernelAuthorityProvisioning.revoke(context, input, provisioningOptions) },
                },
              }
            : {}),
          ...(emergencyControlStore !== undefined ? { emergencyControl: emergencyControlStore } : {}),
          ...(executionOutcomeStore !== undefined ? { executionOutcomes: createExecutionOutcomeReader(executionOutcomeStore) } : {}),
        });

  // CORE-02: the authenticity boundary this root built, if any — for the
  // posture and for the custody service's non-signing health probe.
  const authorityAuthenticity = authorityAuthenticityOnce === undefined ? undefined : await authorityAuthenticityOnce;
  // CORE-07: the freshness boundary this root built, if any.
  const authorityFreshness = authorityFreshnessOnce === undefined ? undefined : await authorityFreshnessOnce;
  // Which custody actually signs for the composed grant store — read from the
  // store's own brand when it is the authenticated durable store (so a
  // host-supplied store reports its own custody), never from configuration.
  // Under external custody no store is supplied (CORE-02R), so this is the
  // custody of the boundary this root established against the configured signer.
  const composedSignerCustody: 'software' | 'external' | 'not-composed' = (() => {
    if (grantStore === undefined || !isAuthenticatedDurableBoundedGrantStore(grantStore)) return authorityAuthenticity?.custody ?? 'not-composed';
    const custody = storeSignerCustody(grantStore);
    return custody === 'unknown' ? 'software' : custody;
  })();

  // PROD-01: what this Host actually composed, stated in `/health` so a
  // deployment on ephemeral state, disabled authentication or unauthenticated
  // authority storage never looks identical to one that is not. Computed from
  // the composed objects, never from what the configuration asked for.
  const posture: EnterpriseHealthPosture = Object.freeze({
    environment: configuration.environment,
    persistence: persistence.providerKind === 'sqlite' ? 'durable' : 'ephemeral',
    authentication: configuration.features.requireAuthentication ? 'required' : 'disabled',
    governedActions: governedActionOrchestrator !== undefined && customerIdentityAdmission !== undefined ? 'composed' : 'not-composed',
    authorityStore: grantStore === undefined ? 'not-composed' : isAuthenticatedDurableBoundedGrantStore(grantStore) ? 'authenticated-durable' : 'unauthenticated',
    kernelAuthority: kernelAuthorityStore !== undefined ? 'composed' : kernelAuthorityStartupFailure !== undefined ? 'unavailable' : 'not-composed',
    emergencyControl: emergencyControlStore !== undefined ? 'composed' : 'not-composed',
    exerciseControls: exerciseLedger !== undefined ? 'composed' : 'not-composed',
    executionAdapters:
      options.authorityControlledExecution === undefined
        ? 0
        : options.authorityControlledExecution.executionAdapterRouting !== undefined
          ? genericHttpAdapters.length + (Array.isArray(options.authorityControlledExecution.executionAdapterRouting.adapters) ? options.authorityControlledExecution.executionAdapterRouting.adapters.length : 0)
          : 1,
    authorityAdministration: authorityAdministration !== undefined ? 'enabled' : 'not-configured',
    // CORE-04: from the composed objects, never from what was asked for.
    trustedContext: governedTrust?.context !== undefined && governedActionOrchestrator !== undefined ? 'composed' : 'not-configured',
    obligations: obligationDischargeStore === undefined || governedActionOrchestrator === undefined ? 'not-configured' : obligationDischargeStore.kind === 'durable-authenticated' ? 'durable' : 'ephemeral',
    // CORE-05: likewise.
    approvals: approvalAuthority === undefined || governedActionOrchestrator === undefined ? 'not-configured' : approvalAuthority.storeKind === 'durable-authenticated' ? 'durable' : 'ephemeral',
    // CORE-02: where the authority private key lives — `external` means not in this process.
    authoritySigner: composedSignerCustody,
    // CORE-07: from the composed boundary — `external` only when every durable
    // authority store composed here established freshness against it.
    authorityFreshness: (() => {
      // Every durable authority store composed here, each read back from its
      // own brand: `external` only when all of them were opened under this
      // root's boundary (established at open, or refusing every read).
      const durable: unknown[] = [
        ...(grantStore !== undefined && isAuthenticatedDurableBoundedGrantStore(grantStore) ? [grantStore] : []),
        ...(obligationDischargeStore?.kind === 'durable-authenticated' ? [obligationDischargeStore] : []),
        ...(approvalStore?.kind === 'durable-authenticated' ? [approvalStore] : []),
      ];
      return authorityFreshness !== undefined && durable.length > 0 && durable.every((store) => freshnessBoundaryOf(store) === authorityFreshness) ? 'external' : 'not-composed';
    })(),
  });

  const enterprise: AocEnterprise = {
    configuration: toPublicEnterpriseConfiguration(configuration),
    kernel,
    kernelProviders,
    persistence,
    governanceReads,
    evidenceStore,
    evidence,
    passportStore,
    passports,
    assuranceStore,
    assurance,
    assuranceFrameworks: assuranceFrameworkRegistry,
    ...(kernelAuthorityStore !== undefined ? { kernelAuthorityStore } : {}),
    ...(kernelAuthorityProvisioning !== undefined ? { kernelAuthorityProvisioning } : {}),
    ...(customerIdentityAdmission !== undefined ? { customerIdentityAdmission } : {}),
    ...(authorityControlledExecution !== undefined ? { authorityControlledExecution } : {}),
    ...(governedActionOrchestrator !== undefined ? { governedActionOrchestrator } : {}),
    ...(customerIdentityAdmission !== undefined && governedActionOrchestrator !== undefined
      ? {
          governAction: (rawIntent: unknown, context?: EnterpriseGovernedActionContext) => {
            if (!lifecycle.isReady()) {
              return Promise.reject(EnterpriseHttpErrors.enterpriseNotReady(lifecycle.lifecycleState()));
            }
            return governGovernedActionRequest(
              { rawIntent, ...(typeof context?.authorizationHeader === 'string' ? { authorizationHeader: context.authorizationHeader } : {}) },
              { admission: customerIdentityAdmission, orchestrator: governedActionOrchestrator, logger },
            );
          },
        }
      : {}),
    ...(emergencyControlStore !== undefined ? { emergencyControlAdministration: emergencyControlStore } : {}),
    ...(authorityAdministration !== undefined ? { authorityAdministration } : {}),
    ...(obligationDischargeStore !== undefined && governedTrust?.obligations !== undefined && governedActionOrchestrator !== undefined
      ? {
          obligationDischarges: createObligationDischargeRecorder({
            store: obligationDischargeStore,
            sources: governedTrust.obligations.sources,
            organizationId: configuration.kernelAuthority.organizationId,
            now: kernelProviders.clock.now,
          }),
        }
      : {}),
    ...(approvalAuthority !== undefined && governedActionOrchestrator !== undefined
      ? {
          approvals: Object.freeze<ApprovalCommandPort>({
            pending: () => approvalAuthority.pending(),
            describe: (requestId: string) => approvalAuthority.describe(requestId),
            approve: (context, command) => approvalAuthority.approve(context, command),
            reject: (context, command) => approvalAuthority.reject(context, command),
            requestChanges: (context, command) => approvalAuthority.requestChanges(context, command),
            escalate: (context, command) => approvalAuthority.escalate(context, command),
            revoke: (context, command) => approvalAuthority.revoke(context, command),
          }),
        }
      : {}),
    ...(authorityEventStore !== undefined && authorityEvents !== undefined ? { authorityEventStream: createAuthorityEventStreamReader(authorityEventStore) } : {}),
    ...(executionOutcomeStore !== undefined ? { executionOutcomes: createExecutionOutcomeReader(executionOutcomeStore) } : {}),
    ...(executionResolutionStore !== undefined ? { executionResolutions: createExecutionResolutionReader(executionResolutionStore) } : {}),
    ...(executionReconciliation !== undefined ? { executionReconciliation } : {}),
    eventPublisher,
    telemetry,
    logger,
    bootId,
    evaluate(request, context) {
      if (!lifecycle.isReady()) {
        return Promise.reject(EnterpriseHttpErrors.enterpriseNotReady(lifecycle.lifecycleState()));
      }
      const input: EvaluateGovernanceRequestInput = {
        rawBody: request,
        ...(context?.authorizationHeader !== undefined ? { authorizationHeader: context.authorizationHeader } : {}),
        ...(context?.idempotencyKey !== undefined ? { idempotencyKey: context.idempotencyKey } : {}),
      };
      return evaluateGovernanceRequest(input, {
        kernel,
        clock: kernelProviders.clock,
        idGenerator: kernelProviders.idGenerator,
        eventIdGenerator,
        store: persistence,
        eventPublisher,
        telemetry,
        logger,
        configuration,
        enterpriseContext,
      });
    },
    async health() {
      const lifecycleSnapshot = await lifecycle.healthSnapshot();
      const report = await computeEnterpriseHealth({
        configuration,
        store: persistence,
        hasPolicyPackProvider: options.policyPackProvider !== undefined,
        eventPublishingEnabled: configuration.eventPublishing.enabled,
        now: kernelProviders.clock.now,
        lifecycle: lifecycleSnapshot,
        posture,
      });
      return withAuthorityFreshnessHealth(await withAuthoritySignerHealth(report, authorityAuthenticity), authorityFreshness);
    },
    start: () => lifecycle.start(),
    isLive: () => lifecycle.isLive(),
    isReady: () => lifecycle.isReady(),
    lifecycleState: () => lifecycle.lifecycleState(),
    modules: () => lifecycle.modules(),
    close: async () => {
      await lifecycle.shutdown();
      unsubscribeLifecyclePersistence();
      await evidenceStore.close();
      await closeComposedGrantStore();
      await closeComposedEmergencyControlStore();
      await closeComposedExerciseLedger();
      await closeComposedAuthorityEventStore();
      await closeComposedExecutionOutcomeStore();
      await closeComposedExecutionResolutionStore();
    },
    stop: async () => {
      await lifecycle.shutdown();
      unsubscribeLifecyclePersistence();
      await evidenceStore.close();
      await closeComposedGrantStore();
      await closeComposedEmergencyControlStore();
      await closeComposedExerciseLedger();
      await closeComposedAuthorityEventStore();
      await closeComposedExecutionOutcomeStore();
      await closeComposedExecutionResolutionStore();
    },
  };

  internalConfigurationRegistry.set(enterprise, configuration);

  return enterprise;
}

/**
 * Convenience zero-configuration factory: `createEnterprise({configuration})`
 * with every other dependency defaulted. Real use: local development and
 * `scripts/run-enterprise-host.mjs`, where nothing needs to be injected.
 */
export function createDefaultEnterprise(configuration?: EnterpriseConfiguration): Promise<AocEnterprise> {
  return createEnterprise(configuration !== undefined ? { configuration } : {});
}

/**
 * CORE-07 — the explicit enrollment ceremony for **existing** durable authority
 * stores the freshness witness has never seen (an upgrade to CORE-07, or a
 * store created before the witness was configured).
 *
 * A trusted, in-process, one-shot operator action — never a route, never a
 * runtime fallback, and never reached by `createEnterprise`. The operator
 * states, through `context`, that each store's **currently verified** state is
 * the baseline from which monotonic freshness begins. That statement is the
 * operator's, not CORE-07's: nothing can know whether a store was rolled back
 * *before* its first trusted enrollment. After it, a regression is refused.
 *
 * Opens each named store exactly as the Host would — the same signer, trusted
 * verifier and witness — so its whole signed history is verified before its
 * head is enrolled. A store file that does not exist is refused, never
 * created: enrollment never produces a genesis. A slot the witness already
 * binds to other state is refused (`AUTHORITY_FRESHNESS_ALREADY_ENROLLED`):
 * enrollment never rebinds.
 */
export async function enrollExistingAuthorityStores(
  configuration: EnterpriseConfiguration,
  context: AuthorityStateEnrollmentContext,
  stateKinds: readonly AuthorityStateKind[],
): Promise<readonly { readonly stateKind: AuthorityStateKind; readonly sequence: number }[]> {
  if (!isAuthorityStateEnrollmentContext(context)) {
    throw new AuthorityStateFreshnessError('AUTHORITY_FRESHNESS_CONFIGURATION_INVALID', 'Enrolling an existing store requires a trusted enrollment context { operator: true, operatorId, attestation }.');
  }
  if (configuration.authorityFreshness?.mode !== 'external') {
    throw new AuthorityStateFreshnessError('AUTHORITY_FRESHNESS_CONFIGURATION_INVALID', 'Enrollment needs the external authority-state witness configured (AOC_ENTERPRISE_AUTHORITY_FRESHNESS_MODE=external).');
  }
  if (configuration.persistence.provider !== 'sqlite') {
    throw new AuthorityStateFreshnessError('AUTHORITY_FRESHNESS_CONFIGURATION_INVALID', 'Only durable (SQLite) authority stores are enrolled.');
  }
  const kinds = [...new Set(stateKinds)];
  if (kinds.length === 0) throw new AuthorityStateFreshnessError('AUTHORITY_FRESHNESS_CONFIGURATION_INVALID', 'Name at least one authority store to enroll.');
  const pathOf: Record<AuthorityStateKind, string> = {
    'bounded-grant-revocation-state': configuration.boundedGrant.sqlitePath,
    'obligation-discharge-state': configuration.obligationDischarge.sqlitePath,
    'approval-state': configuration.approval.sqlitePath,
  };
  for (const kind of kinds) {
    const path = pathOf[kind];
    if (path === undefined || !existsSync(path) || statSync(path).size === 0) {
      throw new AuthorityStateFreshnessError('AUTHORITY_FRESHNESS_CONFIGURATION_INVALID', `There is no existing ${kind} store to enroll. Enrollment never creates a store.`);
    }
  }
  const authenticity = await buildAuthorityAuthenticity(configuration);
  const boundary = await buildAuthorityFreshness(configuration);
  if (boundary === undefined) throw new AuthorityStateFreshnessError('AUTHORITY_FRESHNESS_CONFIGURATION_INVALID', 'The authority-state witness could not be composed.');
  const signed = { signer: authenticity.signer, verifier: authenticity.verifier };
  const organizationId = configuration.kernelAuthority.organizationId;
  const busyTimeoutMs = configuration.persistence.busyTimeoutMs;
  const now = (): string => new Date().toISOString();
  for (const kind of kinds) {
    const freshness = { boundary, enrollment: context };
    const store =
      kind === 'bounded-grant-revocation-state'
        ? await createSqliteBoundedGrantStore(pathOf[kind], { busyTimeoutMs, authenticity: signed, freshness })
        : kind === 'obligation-discharge-state'
          ? await createSqliteObligationDischargeStore(pathOf[kind], { now, busyTimeoutMs, organizationId, authenticity: signed, freshness })
          : await createSqliteApprovalStore(pathOf[kind], { now, busyTimeoutMs, organizationId, authenticity: signed, freshness });
    await store.close();
  }
  return boundary.sessions().map((session) => ({ stateKind: session.binding.stateKind, sequence: session.status().sequence }));
}
