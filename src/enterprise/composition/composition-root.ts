import { randomUUID } from 'node:crypto';

import { AOC_KERNEL_VERSION, createAocKernel, type AocKernel, type KernelIdGenerator, type PolicyPackProvider } from '../../kernel/index.js';
import { computeEnterpriseHealth, type EnterpriseHealthReport } from '../health/health-check.js';
import { loadEnterpriseConfiguration, toPublicEnterpriseConfiguration, type EnterpriseConfiguration, type PublicEnterpriseConfiguration } from '../configuration/enterprise-configuration.js';
import { createInProcessEventPublisher, type EnterpriseEventPublisher } from '../events/enterprise-events.js';
import {
  evaluateGovernanceRequest,
  type EnterpriseEvaluationResponse,
  type EvaluateGovernanceRequestInput,
} from '../orchestration/evaluate-governance-request.js';
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
import { createKernelAuthorityProvisioningService, type KernelAuthorityProvisioningService } from '../kernel-authority/provisioning-service.js';
import { createKernelAuthorityModule, createUnavailableKernelAuthorityModule } from '../modules/kernel-authority-module.js';
import { createEnterpriseLogger, type EnterpriseLogger } from '../telemetry/enterprise-logger.js';
import { createEnterpriseTelemetry, type EnterpriseTelemetry } from '../telemetry/enterprise-telemetry.js';
import { EnterpriseHttpErrors } from '../api/enterprise-http-errors.js';
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
import { createInMemoryBoundedGrantStore, type BoundedGrantStorePort } from '../../features/grant-runtime/index.js';
import { createSqliteBoundedGrantStore } from '../bounded-grant-store/sqlite-bounded-grant-store.js';

/** Transport-level input to `AocEnterprise.evaluate()` -- the not-yet-validated wire payload. Validated internally against `GovernanceEvaluateRequestBody`; see `EnterpriseRequestContext` for the side-channel (auth header) that travels alongside it. */
export type EnterpriseEvaluationRequest = unknown;

/** Side-channel request context `AocEnterprise.evaluate()` accepts alongside the request body: the caller's `Authorization` header and (PR-004) the `Idempotency-Key` header value. */
export interface EnterpriseRequestContext {
  readonly authorizationHeader?: string;
  readonly idempotencyKey?: string;
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
export interface EnterpriseAuthorityControlledExecutionOptions extends Omit<AuthorityControlledExecutionOptions, 'kernel' | 'now' | 'grantStore'> {
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
   * **In-memory grants do not survive a process restart**, and a grant that is
   * gone reads as `GRANT_EXERCISE_NOT_FOUND` at the next exercise -- no
   * execution, which is the closed direction. With the durable store, grants
   * and revocations both survive, and an acknowledged revocation can never be
   * the half that is lost. See
   * `docs/security/AUTHORITATIVE_GRANT_STORE.md` and the persistence section of
   * `docs/enterprise/AOC_AUTHORITY_CONTROLLED_EXECUTION.md`.
   */
  readonly grantStore?: AuthorityControlledExecutionOptions['grantStore'];
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
 */
async function buildBoundedGrantStore(configuration: EnterpriseConfiguration): Promise<BoundedGrantStorePort> {
  if (configuration.persistence.provider === 'sqlite') {
    return createSqliteBoundedGrantStore(configuration.boundedGrant.sqlitePath, { busyTimeoutMs: configuration.persistence.busyTimeoutMs });
  }
  return createInMemoryBoundedGrantStore();
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
  const configuration = options.configuration ?? loadEnterpriseConfiguration();
  const eventIdGenerator = createEnterpriseIdGenerator();

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
      kernelAuthorityStore = await buildKernelAuthorityStore(configuration, () => new Date().toISOString(), eventIdGenerator.nextId);
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
        });

  const persistence = options.persistence ?? (await buildStore(configuration, kernelProviders.clock.now));
  const evidenceStore = options.evidenceStore ?? createInMemoryEvidenceStore({ now: kernelProviders.clock.now });
  const passportStore = options.passportStore ?? (await buildPassportStore(configuration, kernelProviders.clock.now, eventIdGenerator.nextId));
  const assuranceStore = options.assuranceStore ?? (await buildAssuranceStore(configuration, kernelProviders.clock.now));
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
      : (options.authorityControlledExecution.grantStore ?? (await buildBoundedGrantStore(configuration)));
  const grantStoreOpenedHere = options.authorityControlledExecution !== undefined && options.authorityControlledExecution.grantStore === undefined;

  const authorityControlledExecution: AuthorityControlledExecutionService | undefined =
    options.authorityControlledExecution === undefined || grantStore === undefined
      ? undefined
      : createAuthorityControlledExecution({
          kernel:
            options.authorityControlledExecution.kernel ??
            createAocKernel({
              recognitionProvider: kernelProviders.recognitionProvider,
              clock: kernelProviders.clock,
              idGenerator: kernelProviders.idGenerator,
              ...(options.policyPackProvider !== undefined ? { policyPackProvider: options.policyPackProvider } : {}),
              grants: { declaration: options.authorityControlledExecution.grantCapability.declaration },
            }),
          grantCapability: options.authorityControlledExecution.grantCapability,
          grantStore,
          executionAdapter: options.authorityControlledExecution.executionAdapter,
          resolveAuthorityBinding: options.authorityControlledExecution.resolveAuthorityBinding,
          ...(options.authorityControlledExecution.revalidateSource !== undefined
            ? { revalidateSource: options.authorityControlledExecution.revalidateSource }
            : {}),
          now: kernelProviders.clock.now,
        });

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
        options.authorityControlledExecution.executionAdapter.adapterId,
        kernelProviders.clock.now,
      ),
    );
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
    ...(authorityControlledExecution !== undefined ? { authorityControlledExecution } : {}),
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
      return computeEnterpriseHealth({
        configuration,
        store: persistence,
        hasPolicyPackProvider: options.policyPackProvider !== undefined,
        eventPublishingEnabled: configuration.eventPublishing.enabled,
        now: kernelProviders.clock.now,
        lifecycle: lifecycleSnapshot,
      });
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
    },
    stop: async () => {
      await lifecycle.shutdown();
      unsubscribeLifecyclePersistence();
      await evidenceStore.close();
      await closeComposedGrantStore();
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
