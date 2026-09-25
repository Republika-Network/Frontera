import type { ExecutionAdapter, ValidatedExecutionAction } from '../../features/execution-runtime/index.js';
import { KernelGrantCapability } from '../../kernel/orchestration/grant-adapter.js';
import type { AocEnterprise, CreateEnterpriseOptions } from '../composition/composition-root.js';
import type { GrantAuthorityBinding } from '../execution-governance/index.js';
import type { EnterpriseHealthPosture } from '../health/health-check.js';
import type { EnterpriseLogger } from '../telemetry/enterprise-logger.js';
import { createEnterpriseServer, type EnterpriseServer } from './enterprise-server.js';
import {
  EnterpriseHostConfigurationError,
  GOVERNED_ACTIONS_FILE_VARIABLE,
  loadEnterpriseHostConfiguration,
  type EnterpriseHostConfiguration,
} from './host-configuration.js';

/**
 * The Enterprise Host bootstrap: the one supported way to start Frontera as a
 * process. `npm run start:enterprise` (`scripts/run-enterprise-host.mjs`) is a
 * thin launcher over `bootEnterpriseHost()`; tests call the same function.
 *
 * ```
 * environment + governed-action file
 *   └─ loadEnterpriseHostConfiguration   strict parse, secure-profile rules      (refuse)
 *       └─ createEnterpriseServer         createEnterprise: authenticity checked
 *           │                             before any store opens; atomic       (refuse, nothing left open)
 *           └─ posture + health gate      what was composed is what was required;
 *                                         the signed revocation state verifies  (refuse, closed)
 *               └─ listen()               only now is a socket bound
 * ```
 *
 * It composes the governed-action spine from capabilities that already exist —
 * customer identity admission, the grant-aware Kernel over the durable Kernel
 * Authority world, the authenticated bounded-grant store, P7 exercise controls
 * (with P10 authority-sourced ceilings), durable emergency control, P8
 * evidence, P11 outcomes and the Generic HTTP adapter behind the trusted
 * registry — and adds no decision logic of its own. See
 * `docs/enterprise/AOC_ENTERPRISE_HOST.md`.
 */

/**
 * The authority binding the production Host states for every grant.
 *
 * The Host decides against the durable Kernel Authority world, whose
 * organization scoping carries no validity window the governed path can read
 * (`organizational-authority`, `authority-binding.ts`). The grant's own
 * lifetime is the configured `grantLifetimeSeconds`, at most one hour. The
 * Host composes no mandate or representative-authority source, so it never
 * claims one.
 */
export const HOST_ORGANIZATIONAL_AUTHORITY_BINDING: GrantAuthorityBinding = Object.freeze({
  kind: 'no-temporal-authority-bound',
  sourceKind: 'organizational-authority',
  justification: 'Durable Kernel Authority organization scope, decided per evaluation by the Kernel; the Enterprise Host composes no mandate or representative-authority window.',
});

export interface BootEnterpriseHostOptions {
  /** Defaults to `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /**
   * Additional in-process provider adapters, as members of the same trusted
   * registry as the configured Generic HTTP adapters, reachable only through
   * a configured route.
   *
   * For embedders that write their own provider adapter. The launcher passes
   * none, so a started process reaches only what its governed-action file
   * configures.
   */
  readonly executionAdapters?: readonly ExecutionAdapter[];
  readonly logger?: EnterpriseLogger;
}

export interface EnterpriseHost {
  readonly enterprise: AocEnterprise;
  readonly server: EnterpriseServer;
  /** What this Host composed. The same object `/health` reports. */
  readonly posture: EnterpriseHealthPosture;
  listen(): Promise<{ readonly port: number; readonly host: string }>;
  /** Stops accepting, closes the listener, then every store the composition opened. Idempotent. */
  close(): Promise<void>;
}

function toCreateEnterpriseOptions(host: EnterpriseHostConfiguration, options: BootEnterpriseHostOptions): CreateEnterpriseOptions {
  const governed = host.governedActions;
  const base: CreateEnterpriseOptions = { configuration: host.configuration, ...(options.logger !== undefined ? { logger: options.logger } : {}) };
  if (governed === undefined) return base;

  const extra = options.executionAdapters ?? [];
  const known = new Set([...extra.map((adapter) => adapter.adapterId), ...governed.genericHttpAdapters.map((adapter) => adapter.adapterId)]);
  for (const [action, adapterId] of governed.routes) {
    if (!known.has(adapterId)) {
      throw new EnterpriseHostConfigurationError('HOST_EXECUTION_ROUTE_INVALID', `${GOVERNED_ACTIONS_FILE_VARIABLE}: action '${action}' is routed to adapter '${adapterId}', which is not configured.`);
    }
  }

  const lifetimeMs = governed.grantLifetimeSeconds * 1000;
  const routes = governed.routes;
  return {
    ...base,
    customerIdentityAdmission: { enabled: true },
    authorityControlledExecution: {
      grantCapability: new KernelGrantCapability({ declaration: {} }),
      executionAdapterRouting: {
        adapters: extra,
        genericHttpAdapters: governed.genericHttpAdapters,
        // Trusted routing on the validated action alone. No route, no adapter:
        // the registry fails the execution safely rather than falling through.
        selectAdapter: (action: ValidatedExecutionAction) => routes.get(action.action),
      },
      resolveAuthorityBinding: () => HOST_ORGANIZATIONAL_AUTHORITY_BINDING,
      // P7 with no host-imposed aggregate limits: the limits that apply are the
      // ones provisioned on the authority itself (P10), and financial actions
      // are exercisable only because P7 is composed.
      exerciseControls: { policy: () => [], revalidateAuthorityBinding: () => HOST_ORGANIZATIONAL_AUTHORITY_BINDING },
    },
    governedActionOrchestrator: {
      enabled: true,
      trustDomainId: governed.trustDomainId,
      // Anchored on the committed decision, so a retry derives the same grant.
      grantPolicy: (query) => {
        const evaluatedAt = Date.parse(query.evaluatedAt);
        return Number.isNaN(evaluatedAt) ? undefined : { grantExpiresAt: new Date(evaluatedAt + lifetimeMs).toISOString() };
      },
      required: true,
    },
    monetary: governed.monetary,
    emergencyControl: { enabled: true },
  };
}

/** Posture a secure-profile Host must have composed. Checked against the composed objects, after composition, before listen. */
function secureProfileShortfalls(posture: EnterpriseHealthPosture): readonly string[] {
  const expected: Partial<Record<keyof EnterpriseHealthPosture, string>> = {
    persistence: 'durable',
    authentication: 'required',
    governedActions: 'composed',
    authorityStore: 'authenticated-durable',
    kernelAuthority: 'composed',
    emergencyControl: 'composed',
    exerciseControls: 'composed',
  };
  return Object.entries(expected)
    .filter(([key, value]) => posture[key as keyof EnterpriseHealthPosture] !== value)
    .map(([key, value]) => `${key} is '${String(posture[key as keyof EnterpriseHealthPosture])}', expected '${value}'`);
}

/**
 * Boots the Enterprise Host, or refuses. On refusal nothing is left open and
 * no socket was bound. On success the caller calls `listen()`.
 */
export async function bootEnterpriseHost(options: BootEnterpriseHostOptions = {}): Promise<EnterpriseHost> {
  const host = loadEnterpriseHostConfiguration(options.env ?? process.env);
  const server = await createEnterpriseServer(toCreateEnterpriseOptions(host, options));
  const { enterprise } = server;

  try {
    const report = await enterprise.health();
    const posture = report.posture;
    if (posture === undefined) throw new EnterpriseHostConfigurationError('HOST_COMPOSITION_INCOMPLETE', 'The composed Enterprise reported no posture.');

    if (host.governedActions !== undefined && (posture.governedActions !== 'composed' || enterprise.governAction === undefined)) {
      throw new EnterpriseHostConfigurationError('HOST_COMPOSITION_INCOMPLETE', 'Governed actions were configured but the composed Enterprise does not expose them.');
    }
    if (host.secureProfile) {
      const shortfalls = secureProfileShortfalls(posture);
      if (shortfalls.length > 0) {
        throw new EnterpriseHostConfigurationError('HOST_COMPOSITION_INCOMPLETE', `The composed Enterprise does not meet the secure profile: ${shortfalls.join('; ')}.`);
      }
    }
    if (!enterprise.isReady() || report.status === 'unhealthy') {
      // Module ids and failure codes only; module details can name paths.
      const failing = Object.entries(report.modules ?? {})
        .filter(([, entry]) => entry.required && entry.health.status !== 'healthy')
        .map(([moduleId, entry]) => {
          const failure = entry.health.details?.['revocationStateFailure'];
          return typeof failure === 'string' ? `${moduleId} (${failure})` : moduleId;
        });
      throw new EnterpriseHostConfigurationError(
        'HOST_NOT_HEALTHY',
        `The Enterprise Host composed but is not healthy (${report.status}); required modules failing: ${failing.length > 0 ? failing.join(', ') : 'none reported'}. It will not serve traffic.`,
      );
    }

    return {
      enterprise,
      server,
      posture,
      async listen() {
        try {
          return await server.listen();
        } catch (error) {
          await server.close().catch(() => {});
          throw error;
        }
      },
      close: () => server.close(),
    };
  } catch (error) {
    await server.close().catch(() => {});
    throw error;
  }
}
