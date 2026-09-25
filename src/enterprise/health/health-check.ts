import { AOC_KERNEL_VERSION } from '../../kernel/index.js';
import type { EnterpriseConfiguration, EnterpriseEnvironment } from '../configuration/enterprise-configuration.js';
import { computeConfigurationChecksum } from '../configuration/enterprise-configuration.js';
import type { GovernanceStore } from '../persistence/governance-store.js';
import type { EnterpriseLifecycleState, EnterpriseModuleId } from '../modules/enterprise-module.js';
import type { EnterpriseModuleHealthEntry } from '../lifecycle/enterprise-lifecycle-controller.js';

export type EnterpriseHealthState = 'healthy' | 'degraded' | 'unhealthy';

/** Optional module-lifecycle context merged into the health report (mission section 14/15). Omitting it entirely preserves the pre-PR-003 health computation byte-for-byte. */
export interface EnterpriseHealthLifecycleContext {
  readonly lifecycleState: EnterpriseLifecycleState;
  readonly live: boolean;
  readonly ready: boolean;
  readonly modules: Readonly<Record<EnterpriseModuleId, EnterpriseModuleHealthEntry>>;
}

/**
 * PROD-01: what the Host actually composed, in words an operator can check
 * against what they meant to deploy. Derived from the composed objects, never
 * from what configuration requested, and free of secrets, paths, key material
 * and adapter identities (those are server-side only).
 *
 * Informational: `status` is still computed from module health alone. What
 * makes a deployment *refuse* an unsafe posture is the Enterprise Host
 * bootstrap (`host/enterprise-host.ts`), which checks this same object before
 * it binds a socket.
 */
export interface EnterpriseHealthPosture {
  readonly environment: EnterpriseEnvironment;
  /** `durable` = SQLite stores; `ephemeral` = in-memory, lost on restart. */
  readonly persistence: 'durable' | 'ephemeral';
  /** Whether the legacy v1 routes require a bearer credential. The governed-action route always does. */
  readonly authentication: 'required' | 'disabled';
  readonly governedActions: 'composed' | 'not-composed';
  /** The bounded-grant store's kind. `authenticated-durable` is the signed, revocation-state-verified store (CORE-01). */
  readonly authorityStore: 'authenticated-durable' | 'unauthenticated' | 'not-composed';
  readonly kernelAuthority: 'composed' | 'unavailable' | 'not-composed';
  readonly emergencyControl: 'composed' | 'not-composed';
  readonly exerciseControls: 'composed' | 'not-composed';
  /** How many provider adapters the execution boundary holds. A count, never their identities. */
  readonly executionAdapters: number;
}

/**
 * The mission's suggested field names are `enterpriseVersion`/`kernelVersion`/
 * `status`/`persistence.status`/`providers.loaded`. This report keeps that
 * shape but retains the richer `persistence.provider`/`persistence.connected`
 * detail already exposed in PR-002 -- `persistence.status` is derived from
 * `connected`, not a replacement for it.
 */
export interface EnterpriseHealthReport {
  readonly status: EnterpriseHealthState;
  readonly enterpriseVersion: string;
  readonly kernelVersion: string;
  readonly buildVersion: string;
  readonly persistence: {
    readonly provider: GovernanceStore['providerKind'];
    readonly connected: boolean;
    readonly status: 'connected' | 'unreachable';
  };
  readonly providers: {
    readonly loaded: readonly string[];
  };
  readonly configurationChecksum: string;
  readonly checkedAt: string;
  /** Additive module-lifecycle fields (mission section 14). Present whenever the caller supplied `EnterpriseHealthDependencies.lifecycle`; absent for direct `computeEnterpriseHealth()` callers that predate PR-003, so no existing caller's assertions change shape. */
  readonly lifecycleState?: EnterpriseLifecycleState;
  readonly live?: boolean;
  readonly ready?: boolean;
  readonly modules?: Readonly<Record<EnterpriseModuleId, EnterpriseModuleHealthEntry>>;
  /** PROD-01 — present whenever the caller supplied `EnterpriseHealthDependencies.posture` (every `AocEnterprise.health()`). */
  readonly posture?: EnterpriseHealthPosture;
}

export interface EnterpriseHealthDependencies {
  readonly configuration: EnterpriseConfiguration;
  readonly store: GovernanceStore;
  readonly hasPolicyPackProvider: boolean;
  readonly eventPublishingEnabled: boolean;
  readonly now: () => string;
  /** Optional -- see `EnterpriseHealthLifecycleContext`. */
  readonly lifecycle?: EnterpriseHealthLifecycleContext;
  /** Optional -- see `EnterpriseHealthPosture`. */
  readonly posture?: EnterpriseHealthPosture;
}

/**
 * `/health` never returns provider internals, connection strings, or API
 * keys -- only booleans, an explicit `loaded` provider list, and version
 * identifiers, per the mission's "No sensitive information" requirement.
 * `enterpriseVersion`/`kernelVersion` are reported separately and are never
 * confused with `src/runtime/`'s own, unrelated versioning.
 */
/**
 * Health aggregation rules (mission section 15), applied only when
 * `lifecycle` is supplied: unhealthy if the Host is not ready or any
 * required module is unhealthy/failed; degraded if ready but an optional
 * module is unhealthy/degraded; healthy otherwise. Aggregation belongs to
 * Enterprise, never to an individual module -- no module status here can
 * override this computation.
 */
function aggregateStatus(connected: boolean, lifecycle: EnterpriseHealthLifecycleContext | undefined): EnterpriseHealthState {
  if (!connected) return 'unhealthy';
  if (lifecycle === undefined) return 'healthy';
  if (!lifecycle.ready) return 'unhealthy';

  const entries = Object.values(lifecycle.modules);
  const requiredUnhealthy = entries.some((entry) => entry.required && entry.health.status !== 'healthy');
  if (requiredUnhealthy) return 'unhealthy';

  const optionalImpaired = entries.some((entry) => !entry.required && entry.health.status !== 'healthy');
  return optionalImpaired ? 'degraded' : 'healthy';
}

export async function computeEnterpriseHealth(deps: EnterpriseHealthDependencies): Promise<EnterpriseHealthReport> {
  const connected = await deps.store.checkConnectivity();
  const status = aggregateStatus(connected, deps.lifecycle);

  const loaded: string[] = ['recognitionProvider'];
  if (deps.hasPolicyPackProvider) loaded.push('policyPackProvider');
  if (deps.eventPublishingEnabled) loaded.push('eventPublisher');

  return {
    status,
    enterpriseVersion: deps.configuration.enterpriseVersion,
    kernelVersion: AOC_KERNEL_VERSION,
    buildVersion: process.env.npm_package_version ?? deps.configuration.enterpriseVersion,
    persistence: {
      provider: deps.store.providerKind,
      connected,
      status: connected ? 'connected' : 'unreachable',
    },
    providers: {
      loaded,
    },
    configurationChecksum: computeConfigurationChecksum(deps.configuration),
    checkedAt: deps.now(),
    ...(deps.lifecycle !== undefined
      ? { lifecycleState: deps.lifecycle.lifecycleState, live: deps.lifecycle.live, ready: deps.lifecycle.ready, modules: deps.lifecycle.modules }
      : {}),
    ...(deps.posture !== undefined ? { posture: deps.posture } : {}),
  };
}
