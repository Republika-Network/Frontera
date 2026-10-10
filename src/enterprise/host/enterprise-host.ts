import type { ExecutionAdapter, ValidatedExecutionAction } from '../../features/execution-runtime/index.js';
import type { ContextProvider, PolicyPackProvider } from '../../kernel/index.js';
import { KernelGrantCapability } from '../../kernel/orchestration/grant-adapter.js';
import type { AocEnterprise, CreateEnterpriseOptions } from '../composition/composition-root.js';
import type { GrantAuthorityBinding } from '../execution-governance/index.js';
import type { ExecutionResolutionAuthority } from '../execution-reconciliation/authority.js';
import { OPERATOR_ATTESTATION_AUTHORITY_ID, createOperatorAttestationAuthority } from '../execution-reconciliation/operator-attestation.js';
import type { ComposedXrplPaymentRail, XrplLedgerClientFactory } from '../xrpl-payment-rail/host-composition.js';
import { xrplKeyMaterialVariables } from '../xrpl-payment-rail/host-configuration.js';
import type { EnterpriseHealthPosture } from '../health/health-check.js';
import { createEnterpriseLogger, type EnterpriseLogger } from '../telemetry/enterprise-logger.js';
import { createEnterpriseServer, type EnterpriseServer } from './enterprise-server.js';
import {
  EnterpriseHostConfigurationError,
  GOVERNED_ACTIONS_FILE_VARIABLE,
  loadEnterpriseHostConfiguration,
  type EnterpriseHostConfiguration,
} from './host-configuration.js';
import { currentReleaseIdentity, type FronteraReleaseIdentity } from './release-identity.js';

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
  /**
   * Defaults to `process.env`. Under external authority-key custody the real
   * `process.env` is checked as well, whatever map is passed here: the claim is
   * that this **process** holds no authority private key (CORE-02R).
   */
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
  /**
   * CORE-04 — the retrieval side of the Trusted Context Boundary: trusted
   * in-process code that reads **candidate** observations from the sources the
   * governed-action file registers. Being composed confers no trust — every
   * observation it returns is admitted or refused by the boundary against the
   * file's source registry. Required when the file declares `trustedContext`.
   * The launcher passes none, so a started process whose profiles declare
   * facts refuses to start until an embedder supplies one.
   */
  readonly contextProvider?: ContextProvider;
  /**
   * CORE-04 — the organization's deterministic policy, composed in-process
   * (policy packs have no durable store or file format on the Host yet; the
   * pack writer is the NB-008-protected one). Required when any profile
   * declares facts: an admitted fact informs policy, and without policy there
   * is nothing to decide with it.
   */
  readonly policyPackProvider?: PolicyPackProvider;
  /**
   * PAY-03 — trusted in-process composition of the XRPL ledger client used
   * when the governed-action file configures `xrplPaymentRail`. Default: the
   * official SDK client over the configured endpoint. The launcher passes
   * none. It is a client factory only: the rail, the external signer, the
   * interlock and the resolver are always the Host's own.
   */
  readonly xrplLedgerClient?: XrplLedgerClientFactory;
  readonly logger?: EnterpriseLogger;
}

export interface EnterpriseHost {
  readonly enterprise: AocEnterprise;
  readonly server: EnterpriseServer;
  /** What this Host composed. The same object `/health` reports. */
  readonly posture: EnterpriseHealthPosture;
  /** PROD-03-03: the artifact's release identity. The same object `GET /version` serves. */
  readonly release: FronteraReleaseIdentity;
  listen(): Promise<{ readonly port: number; readonly host: string }>;
  /** Stops accepting, closes the listener, then every store the composition opened. Idempotent. */
  close(): Promise<void>;
}

function toCreateEnterpriseOptions(host: EnterpriseHostConfiguration, options: BootEnterpriseHostOptions, xrpl?: ComposedXrplPaymentRail): CreateEnterpriseOptions {
  const governed = host.governedActions;
  const base: CreateEnterpriseOptions = {
    configuration: host.configuration,
    ...(options.logger !== undefined ? { logger: options.logger } : {}),
    ...(options.policyPackProvider !== undefined ? { policyPackProvider: options.policyPackProvider } : {}),
  };
  if (governed === undefined) return base;

  // PAY-03: the composed XRPL rail joins the same trusted registry, reachable only through its configured route.
  const extra = [...(options.executionAdapters ?? []), ...(xrpl !== undefined ? [xrpl.adapter] : [])];
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
    ...(governed.governance !== undefined ? { governance: governed.governance } : {}),
    // CTRL-02: the file's profiles as an operator-promoted catalog.
    ...(governed.profileLifecycle !== undefined ? { governanceLifecycle: governed.profileLifecycle } : {}),
    // CORE-04: the file's source registry, with the in-process provider.
    ...(governed.trustedContext !== undefined
      ? { trustedContext: { ...governed.trustedContext, ...(options.contextProvider !== undefined ? { provider: options.contextProvider } : {}) } }
      : {}),
    ...(governed.obligations !== undefined ? { obligations: governed.obligations } : {}),
    emergencyControl: { enabled: true },
    // PROD-03-02: with an operator plane, P12 with one authority — operator
    // attestation. Every new governed execution is bound to it before its
    // claim, durably (`executionResolution.sqlitePath`), so a claim left with
    // no definitive outcome can later be closed by an authorized operator's
    // recorded attestation, and by nothing else: the authority never answers
    // on its own, and nothing here can execute.
    //
    // PAY-03: with the XRPL rail, P12 also composes the read-only XRPL
    // resolution authority, and every execution of the rail's payment action
    // is bound to it before its claim — so an unconfirmed XRPL payment is
    // resolved from the ledger, under P12's unchanged rules (one binding, one
    // resolution, provider truth first). Nothing here can execute.
    ...executionReconciliationOf(host, xrpl),
    ...(xrpl !== undefined ? { modules: xrpl.modules } : {}),
  };
}

function executionReconciliationOf(host: EnterpriseHostConfiguration, xrpl: ComposedXrplPaymentRail | undefined): Pick<CreateEnterpriseOptions, 'executionReconciliation'> {
  const operators = (host.configuration.administration?.operators?.length ?? 0) > 0;
  if (!operators && xrpl === undefined) return {};
  const authorities: ExecutionResolutionAuthority[] = [...(operators ? [createOperatorAttestationAuthority()] : []), ...(xrpl !== undefined ? [xrpl.authority] : [])];
  // Synchronous and total over the trusted action; there is no fallback inside P12.
  // Without an operator plane, every other action binds to the XRPL authority, which
  // holds no interlock record for it and therefore only ever answers `unresolved`.
  const fallback = operators ? OPERATOR_ATTESTATION_AUTHORITY_ID : xrpl!.authorityId;
  const selectAuthority = (context: { readonly action: string }): string => (xrpl !== undefined && context.action === xrpl.paymentAction ? xrpl.authorityId : fallback);
  return { executionReconciliation: { enabled: true, authorities, selectAuthority } };
}

/**
 * PAY-03: the Host requests XRPL signatures; it never holds an XRPL key. With
 * the rail configured, a variable that would carry XRPL key material — or the
 * reference signer's own configuration — anywhere in this process refuses the
 * Host. Presence alone; the value is never read. Checked against both the
 * configuration map and the real process environment.
 */
function assertProcessHoldsNoXrplKey(host: EnterpriseHostConfiguration, env: Readonly<Record<string, string | undefined>>): void {
  if (host.governedActions?.xrplPaymentRail === undefined) return;
  const present = [...new Set([...xrplKeyMaterialVariables(env), ...xrplKeyMaterialVariables(process.env)])];
  if (present.length === 0) return;
  throw new EnterpriseHostConfigurationError(
    'HOST_ENVIRONMENT_INVALID',
    `The XRPL payment rail is configured and this process environment carries ${present.join(', ')}. The Host only requests XRPL signatures from the external signer; XRPL key material and the signer's own configuration belong to the signer's process, never this one.`,
  );
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
    // CORE-07: every durable authority store anchored at the external witness.
    authorityFreshness: 'external',
    // ASSURE-01: evidence bundles survive a restart and travel with backups.
    evidenceStore: 'durable',
  };
  const shortfalls = Object.entries(expected)
    .filter(([key, value]) => posture[key as keyof EnterpriseHealthPosture] !== value)
    .map(([key, value]) => `${key} is '${String(posture[key as keyof EnterpriseHealthPosture])}', expected '${value}'`);
  // CORE-04: obligations, when composed, are durable on a secure Host — a
  // verified discharge forgotten on restart would withhold forever, and a
  // secure Host never runs authority-relevant state in memory.
  if (posture.obligations === 'ephemeral') shortfalls.push(`obligations is 'ephemeral', expected 'durable' or 'not-configured'`);
  // CORE-05: approvals too — an approval that forgot itself would withhold
  // forever, and one that forgot a rejection could be approved again.
  if (posture.approvals === 'ephemeral') shortfalls.push(`approvals is 'ephemeral', expected 'durable' or 'not-configured'`);
  return shortfalls;
}

/** The declared authority private-key input. Under external custody the Host process must not carry it at all. */
const AUTHORITY_SIGNING_KEY_VARIABLE = 'AOC_ENTERPRISE_AUTHORITY_SIGNING_KEY_PEM';

/**
 * CORE-02R: external custody is a claim about this **process**, so it is
 * checked against the process's real environment — not only against the
 * configuration map, which an embedder may have sanitized while `process.env`
 * still carries the key. Presence is enough (an empty value included), the same
 * rule the environment validation applies to the map: the variable must not be
 * part of this process at all. The value is never read, compared, logged or
 * serialized. Only the declared authority-key input is checked; this is not a
 * scan of the environment or of process memory for key-shaped text.
 */
function assertProcessHoldsNoAuthorityKey(host: EnterpriseHostConfiguration): void {
  if (host.configuration.authorityAuthenticity.mode !== 'external') return;
  if (process.env[AUTHORITY_SIGNING_KEY_VARIABLE] === undefined) return;
  throw new EnterpriseHostConfigurationError(
    'HOST_ENVIRONMENT_INVALID',
    `${AUTHORITY_SIGNING_KEY_VARIABLE} is present in this process environment while external authority-key custody is configured. External custody means this process holds no authority private key; remove it from the process environment (a sanitized configuration map does not change what the process holds).`,
  );
}

/**
 * Boots the Enterprise Host, or refuses. On refusal nothing is left open and
 * no socket was bound. On success the caller calls `listen()`.
 */
export async function bootEnterpriseHost(options: BootEnterpriseHostOptions = {}): Promise<EnterpriseHost> {
  // PROD-03-03: every refusal is one structured `enterprise.host.refused` event
  // with a closed code, including those before the configured log level is
  // known (an error is emitted at every level).
  let host: EnterpriseHostConfiguration;
  try {
    host = loadEnterpriseHostConfiguration(options.env ?? process.env);
  } catch (error) {
    (options.logger ?? createEnterpriseLogger('error')).error('enterprise.host.refused', { phase: 'configuration', errorCode: refusalCode(error) });
    throw error;
  }
  // One logger for the startup phases and the composed Enterprise
  // (composition would otherwise create the same default itself).
  const logger = options.logger ?? createEnterpriseLogger(host.configuration.logLevel);
  let release: FronteraReleaseIdentity;
  try {
    release = currentReleaseIdentity();
  } catch (error) {
    const refusal = new EnterpriseHostConfigurationError('HOST_RELEASE_IDENTITY_INVALID', error instanceof Error ? error.message : 'The recorded release identity is invalid.');
    logger.error('enterprise.host.refused', { phase: 'release_identity', errorCode: refusal.code });
    throw refusal;
  }
  logger.info('enterprise.host.starting', { phase: 'host_starting', release: release.release, build: release.build });
  // Before composition: nothing is opened and the signer is not contacted.
  try {
    assertProcessHoldsNoAuthorityKey(host);
    assertProcessHoldsNoXrplKey(host, options.env ?? process.env);
  } catch (error) {
    logger.error('enterprise.host.refused', { phase: 'configuration', errorCode: refusalCode(error) });
    throw error;
  }
  logger.info('enterprise.host.configuration_validated', { phase: 'config_validated', status: host.configuration.environment });
  // PAY-03: only an explicitly configured rail is composed; the XRPL SDK is not even loaded otherwise.
  let xrpl: ComposedXrplPaymentRail | undefined;
  const xrplConfiguration = host.governedActions?.xrplPaymentRail;
  if (xrplConfiguration !== undefined) {
    try {
      const { composeXrplPaymentRail } = await import('../xrpl-payment-rail/host-composition.js');
      xrpl = await composeXrplPaymentRail({
        configuration: xrplConfiguration,
        interlockPath: host.configuration.xrplInterlock?.sqlitePath ?? '.data/xrpl-submission-interlock.sqlite',
        busyTimeoutMs: host.configuration.persistence.busyTimeoutMs,
        logger,
        ...(options.xrplLedgerClient !== undefined ? { ledgerClient: options.xrplLedgerClient } : {}),
      });
    } catch (error) {
      logger.error('enterprise.host.refused', { phase: 'xrpl_payment_rail', errorCode: refusalCode(error) });
      throw error;
    }
  }
  let server: EnterpriseServer;
  try {
    server = await createEnterpriseServer(toCreateEnterpriseOptions(host, { ...options, logger }, xrpl));
  } catch (error) {
    logger.error('enterprise.host.refused', { phase: 'composition', errorCode: refusalCode(error) });
    await xrpl?.close();
    throw error;
  }
  const { enterprise } = server;
  // Composition is atomic: every store opened, its schema verified (or
  // created) and every module initialized — or nothing is left open.
  logger.info('enterprise.host.composed', { phase: 'modules_initialized' });

  try {
    const report = await enterprise.health();
    const posture = report.posture;
    if (posture === undefined) throw new EnterpriseHostConfigurationError('HOST_COMPOSITION_INCOMPLETE', 'The composed Enterprise reported no posture.');

    if (host.governedActions !== undefined && (posture.governedActions !== 'composed' || enterprise.governAction === undefined)) {
      throw new EnterpriseHostConfigurationError('HOST_COMPOSITION_INCOMPLETE', 'Governed actions were configured but the composed Enterprise does not expose them.');
    }
    // CORE-02: a Host configured for external custody runs on an external
    // signer, or not at all — in any profile. Checked against the composed
    // object, so nothing between configuration and composition can have put a
    // process-resident signer back.
    if (host.configuration.authorityAuthenticity.mode === 'external' && posture.authorityStore !== 'not-composed' && posture.authoritySigner !== 'external') {
      throw new EnterpriseHostConfigurationError('HOST_COMPOSITION_INCOMPLETE', `External authority-key custody was configured but the composed authority signer is '${posture.authoritySigner}'.`);
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
      // CORE-07: a store whose freshness failed is named by kind and closed code — never a digest or path.
      for (const store of report.authorityFreshness?.stores ?? []) {
        if (store.status !== 'ready' && store.status !== 'unavailable') failing.push(`authority-freshness:${store.stateKind} (${store.reason ?? store.status})`);
      }
      throw new EnterpriseHostConfigurationError(
        'HOST_NOT_HEALTHY',
        `The Enterprise Host composed but is not healthy (${report.status}); required modules failing: ${failing.length > 0 ? failing.join(', ') : 'none reported'}. It will not serve traffic.`,
      );
    }

    logger.info('enterprise.host.health_gate_passed', { phase: 'health_gate', status: report.status });

    let closing: Promise<void> | undefined;
    return {
      enterprise,
      server,
      posture,
      release,
      async listen() {
        try {
          const address = await server.listen();
          logger.info('enterprise.host.ready', { phase: 'host_ready', release: release.release });
          return address;
        } catch (error) {
          logger.error('enterprise.host.refused', { phase: 'listen', errorCode: refusalCode(error) });
          await server.close().catch(() => {});
          throw error;
        }
      },
      close() {
        closing ??= (async () => {
          logger.info('enterprise.host.shutdown_started', { phase: 'shutdown_started' });
          await server.close();
          logger.info('enterprise.host.shutdown_complete', { phase: 'shutdown_complete' });
        })();
        return closing;
      },
    };
  } catch (error) {
    logger.error('enterprise.host.refused', { phase: 'health_gate', errorCode: refusalCode(error) });
    await server.close().catch(() => {});
    await xrpl?.close();
    throw error;
  }
}

/** A closed code for the refusal log line — never the message, which can name a module detail. */
function refusalCode(error: unknown): string {
  if (error instanceof EnterpriseHostConfigurationError) return error.code;
  const code = (error as { readonly code?: unknown } | null)?.code;
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : 'HOST_STARTUP_FAILED';
}
