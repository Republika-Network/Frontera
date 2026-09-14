import { AOC_ENTERPRISE_HOST_VERSION } from '../version.js';

/**
 * Centralizes every environment-derived knob the Soberanía Enterprise Host needs.
 * The Kernel itself takes none of this -- `AocKernel` is constructed once by
 * the composition root (`composition/composition-root.ts`) and never reads
 * configuration directly, per the mission's "Kernel remains
 * configuration-independent" principle.
 */
export type EnterpriseEnvironment = 'development' | 'test' | 'staging' | 'production';

export type EnterprisePersistenceProviderKind = 'memory' | 'sqlite';

/** A configured caller credential. `organizationId`, when present, scopes the key to requests naming that same `organization.id` -- a request for a different organization is a 403, not a 401 (the key is valid; it just isn't authorized for that organization). */
export interface EnterpriseApiKey {
  readonly key: string;
  readonly organizationId?: string;
}

export interface EnterpriseFeatureFlags {
  readonly traceLevel: 'basic' | 'full';
  readonly requireAuthentication: boolean;
}

/**
 * Timeouts the module lifecycle actually enforces (mission section 29:
 * "only implement timeouts that are actually enforced"). No separate
 * graceful-shutdown-drain timeout exists because this PR does not implement
 * in-flight-evaluation draining (see the Module Lifecycle doc's
 * "Limitations" section) -- `shutdownTimeoutMs` bounds each module's own
 * `shutdown()` call, which is all v1 needs.
 */
export interface EnterpriseLifecycleConfiguration {
  readonly startupTimeoutMs: number;
  readonly shutdownTimeoutMs: number;
  readonly healthCheckTimeoutMs: number;
}

export interface EnterpriseConfiguration {
  readonly environment: EnterpriseEnvironment;
  readonly enterpriseVersion: string;
  readonly logLevel: 'debug' | 'info' | 'warn' | 'error';
  readonly persistence: {
    readonly provider: EnterprisePersistenceProviderKind;
    readonly sqlitePath: string;
    /** Bounded wait (ms) on a locked SQLite file before failing, instead of an immediate SQLITE_BUSY. Enforced via `PRAGMA busy_timeout`. */
    readonly busyTimeoutMs: number;
    /** Enforced Governance Store persistence limits (PR-004 section 38) — every value here is actually applied on append; none is decorative. */
    readonly limits: {
      readonly maxRequestPayloadBytes: number;
      readonly maxResultPayloadBytes: number;
      readonly maxEventPayloadBytes: number;
      readonly maxTraceSteps: number;
    };
  };
  readonly eventPublishing: {
    readonly enabled: boolean;
  };
  readonly telemetry: {
    readonly enabled: boolean;
  };
  readonly authentication: {
    /** Static bearer tokens accepted by the Enterprise Host's own authentication step. Never forwarded to the Kernel. */
    readonly apiKeys: readonly EnterpriseApiKey[];
  };
  readonly features: EnterpriseFeatureFlags;
  readonly http: {
    readonly port: number;
    readonly host: string;
  };
  readonly lifecycle: EnterpriseLifecycleConfiguration;
  /** PR-006: Agent Passport Runtime configuration (mission section 52 -- module criticality is deployment-configurable, never hardcoded). */
  readonly passport: {
    /** SQLite path for the Passport Store when `persistence.provider === 'sqlite'`. Independent of `persistence.sqlitePath` -- a distinct on-disk database file, since the Passport Store is an independent store (mission section 9). */
    readonly sqlitePath: string;
    /** When `true`, a Passport Store outage makes the Enterprise Host not-ready (`criticality: 'required'`). Defaults to `false`: Passport-backed agent recognition degrades gracefully rather than blocking governance evaluation. */
    readonly required: boolean;
  };
  /**
   * P0-PKG-07: Kernel Authority Runtime configuration -- the durable,
   * operator-provisioned recognition/authority world the Kernel decides
   * against.
   *
   * Opt-in (`enabled: false` by default) because turning it on changes where
   * the Kernel's world comes from. A deployment that has not adopted durable
   * authority keeps `createDefaultKernelProviders()`'s real-but-empty,
   * fail-closed world byte for byte.
   */
  readonly kernelAuthority: {
    /** When `true`, the composition root restores the Kernel's world from the Kernel Authority Store instead of composing an empty one. */
    readonly enabled: boolean;
    /** The organization whose authority world this deployment decides for. One Enterprise instance serves exactly one authority organization. */
    readonly organizationId: string;
    /** SQLite path for the Kernel Authority Store when `persistence.provider === 'sqlite'`. Independent of every other store's path -- authority source-of-truth is never stored inside an evaluation-history database. */
    readonly sqlitePath: string;
    /** When `true` (the default), an authority-source outage makes the Enterprise Host not-ready rather than letting it answer out of a world it can no longer verify. */
    readonly required: boolean;
  };
  /**
   * The authoritative bounded-grant store's durable location.
   *
   * Read only when a host composes `authorityControlledExecution` **and**
   * supplies no `grantStore` of its own. Independent of every other store's
   * path, for the reason the Kernel Authority Store states: an authority
   * source-of-truth is never kept inside an evaluation-history database, and a
   * deployment must be able to back it up, restore it and rotate it on its own
   * terms. See `docs/security/AUTHORITATIVE_GRANT_STORE.md`.
   */
  readonly boundedGrant: {
    /** SQLite path for the bounded-grant store when `persistence.provider === 'sqlite'`. */
    readonly sqlitePath: string;
  };
  /** PR-007: Assurance Runtime configuration (mission section 57 -- Assurance criticality is deployment-configurable, never hardcoded). */
  readonly assurance: {
    /** SQLite path for the Assurance Store when `persistence.provider === 'sqlite'`. Independent of every other store's path -- the Assurance Store is an independent store (mission section 48). */
    readonly sqlitePath: string;
    /** When `true`, an Assurance Store outage makes the Enterprise Host not-ready. Defaults to `false`: Assurance degrades gracefully without blocking `POST /api/governance/evaluate`. */
    readonly required: boolean;
  };
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return value === '1' || value.toLowerCase() === 'true';
}

/** Parses a positive-integer millisecond timeout, falling back to `fallback` for anything missing, non-numeric, zero, or negative -- an unreasonable value is never silently allowed to disable a timeout. */
function parsePositiveIntMs(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseEnvironment(value: string | undefined): EnterpriseEnvironment {
  if (value === 'production' || value === 'staging' || value === 'test' || value === 'development') return value;
  return 'development';
}

/** Parses `AOC_ENTERPRISE_API_KEYS="key1,key2:org-acme,key3:org-beta"` -- a bare key grants access regardless of the request's organization; a `key:orgId` pair scopes it. */
function parseApiKeys(value: string | undefined): readonly EnterpriseApiKey[] {
  if (!value) return [];
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => {
      const separatorIndex = entry.indexOf(':');
      if (separatorIndex === -1) return { key: entry };
      const key = entry.slice(0, separatorIndex).trim();
      const organizationId = entry.slice(separatorIndex + 1).trim();
      return organizationId.length > 0 ? { key, organizationId } : { key };
    });
}

/**
 * Reads `env` (defaults to `process.env`) into a fully-resolved
 * `EnterpriseConfiguration`. Every field has a safe, local-dev-friendly
 * default so the Enterprise Host can boot with zero configuration;
 * production deployments override via environment variables.
 */
export function loadEnterpriseConfiguration(env: Readonly<Record<string, string | undefined>> = process.env): EnterpriseConfiguration {
  return {
    environment: parseEnvironment(env.AOC_ENTERPRISE_ENV),
    enterpriseVersion: env.AOC_ENTERPRISE_VERSION ?? AOC_ENTERPRISE_HOST_VERSION,
    logLevel: (env.AOC_ENTERPRISE_LOG_LEVEL as EnterpriseConfiguration['logLevel'] | undefined) ?? 'info',
    persistence: {
      provider: env.AOC_ENTERPRISE_PERSISTENCE_PROVIDER === 'sqlite' ? 'sqlite' : 'memory',
      sqlitePath: env.AOC_ENTERPRISE_SQLITE_PATH ?? '.data/enterprise-host.sqlite',
      busyTimeoutMs: parsePositiveIntMs(env.AOC_ENTERPRISE_STORE_BUSY_TIMEOUT_MS, 5_000),
      limits: {
        maxRequestPayloadBytes: parsePositiveIntMs(env.AOC_ENTERPRISE_STORE_MAX_REQUEST_PAYLOAD_BYTES, 262_144),
        maxResultPayloadBytes: parsePositiveIntMs(env.AOC_ENTERPRISE_STORE_MAX_RESULT_PAYLOAD_BYTES, 524_288),
        maxEventPayloadBytes: parsePositiveIntMs(env.AOC_ENTERPRISE_STORE_MAX_EVENT_PAYLOAD_BYTES, 65_536),
        maxTraceSteps: parsePositiveIntMs(env.AOC_ENTERPRISE_STORE_MAX_TRACE_STEPS, 500),
      },
    },
    eventPublishing: {
      enabled: parseBoolean(env.AOC_ENTERPRISE_EVENTS_ENABLED, true),
    },
    telemetry: {
      enabled: parseBoolean(env.AOC_ENTERPRISE_TELEMETRY_ENABLED, true),
    },
    authentication: {
      apiKeys: parseApiKeys(env.AOC_ENTERPRISE_API_KEYS),
    },
    features: {
      traceLevel: env.AOC_ENTERPRISE_TRACE_LEVEL === 'full' ? 'full' : 'basic',
      requireAuthentication: parseBoolean(env.AOC_ENTERPRISE_REQUIRE_AUTH, false),
    },
    http: {
      port: Number.parseInt(env.AOC_ENTERPRISE_HTTP_PORT ?? '8787', 10),
      host: env.AOC_ENTERPRISE_HTTP_HOST ?? '0.0.0.0',
    },
    lifecycle: {
      startupTimeoutMs: parsePositiveIntMs(env.AOC_ENTERPRISE_STARTUP_TIMEOUT_MS, 30_000),
      shutdownTimeoutMs: parsePositiveIntMs(env.AOC_ENTERPRISE_SHUTDOWN_TIMEOUT_MS, 30_000),
      healthCheckTimeoutMs: parsePositiveIntMs(env.AOC_ENTERPRISE_HEALTH_CHECK_TIMEOUT_MS, 5_000),
    },
    passport: {
      sqlitePath: env.AOC_ENTERPRISE_PASSPORT_SQLITE_PATH ?? '.data/agent-passport.sqlite',
      required: parseBoolean(env.AOC_ENTERPRISE_PASSPORT_REQUIRED, false),
    },
    kernelAuthority: {
      enabled: parseBoolean(env.AOC_ENTERPRISE_KERNEL_AUTHORITY_ENABLED, false),
      organizationId: env.AOC_ENTERPRISE_KERNEL_AUTHORITY_ORGANIZATION_ID ?? 'default',
      sqlitePath: env.AOC_ENTERPRISE_KERNEL_AUTHORITY_SQLITE_PATH ?? '.data/kernel-authority.sqlite',
      // Defaults to required, unlike Passport and Assurance: an authority
      // source that is silently absent is not a degraded feature, it is a Host
      // answering out of a world it cannot verify.
      required: parseBoolean(env.AOC_ENTERPRISE_KERNEL_AUTHORITY_REQUIRED, true),
    },
    boundedGrant: {
      sqlitePath: env.AOC_ENTERPRISE_BOUNDED_GRANT_SQLITE_PATH ?? '.data/bounded-grants.sqlite',
    },
    assurance: {
      sqlitePath: env.AOC_ENTERPRISE_ASSURANCE_SQLITE_PATH ?? '.data/assurance.sqlite',
      required: parseBoolean(env.AOC_ENTERPRISE_ASSURANCE_REQUIRED, false),
    },
  };
}

/**
 * The redacted, secret-free view of `EnterpriseConfiguration` (R004.B). This
 * is the shape exposed on the public `AocEnterprise.configuration` surface --
 * every field a legitimate embedder needs (environment, ports, feature
 * flags, timeouts) with `authentication.apiKeys` replaced by a non-secret
 * count and per-key organization scoping. Never carries `EnterpriseApiKey.key`.
 */
export type PublicEnterpriseConfiguration = Omit<EnterpriseConfiguration, 'authentication'> & {
  readonly authentication: {
    readonly requireAuthentication: boolean;
    readonly apiKeyCount: number;
    /** Non-secret: which configured keys are organization-scoped, in configured order. Never the key values themselves. */
    readonly apiKeyOrganizationScopes: readonly (string | undefined)[];
  };
};

/**
 * Strips every raw secret out of a resolved `EnterpriseConfiguration`,
 * producing the safe shape `AocEnterprise.configuration` actually exposes.
 * The full, secret-bearing `EnterpriseConfiguration` never leaves the
 * composition root / trusted in-process adapters (see
 * `composition-root.ts`'s `getInternalEnterpriseConfiguration`).
 */
export function toPublicEnterpriseConfiguration(config: EnterpriseConfiguration): PublicEnterpriseConfiguration {
  const { authentication, ...rest } = config;
  return {
    ...rest,
    authentication: {
      requireAuthentication: config.features.requireAuthentication,
      apiKeyCount: authentication.apiKeys.length,
      apiKeyOrganizationScopes: authentication.apiKeys.map((apiKey) => apiKey.organizationId),
    },
  };
}

/**
 * A short, stable checksum of the resolved configuration (never the raw
 * values -- `apiKeys` are secrets) so `/health` can report "configuration
 * changed since last deploy" without leaking what changed.
 */
export function computeConfigurationChecksum(config: EnterpriseConfiguration): string {
  const shape = {
    environment: config.environment,
    enterpriseVersion: config.enterpriseVersion,
    logLevel: config.logLevel,
    persistenceProvider: config.persistence.provider,
    eventsEnabled: config.eventPublishing.enabled,
    telemetryEnabled: config.telemetry.enabled,
    apiKeyCount: config.authentication.apiKeys.length,
    traceLevel: config.features.traceLevel,
    requireAuthentication: config.features.requireAuthentication,
    passportRequired: config.passport.required,
    assuranceRequired: config.assurance.required,
    kernelAuthorityEnabled: config.kernelAuthority.enabled,
    kernelAuthorityOrganizationId: config.kernelAuthority.organizationId,
    kernelAuthorityRequired: config.kernelAuthority.required,
  };
  const serialized = JSON.stringify(shape);
  let hash = 0;
  for (let i = 0; i < serialized.length; i += 1) {
    hash = (Math.imul(31, hash) + serialized.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(16);
}
