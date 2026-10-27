import type { ExecutionAdapter, ValidatedExecutionAction } from '../../features/execution-runtime/index.js';
import { XrplSequenceOwnershipError, assertXrplSequenceOwnership, type XrplSequenceDomain } from '../../features/xrpl-transport/index.js';
import type { ContextProvider, PolicyPackProvider } from '../../kernel/index.js';
import { KernelGrantCapability } from '../../kernel/orchestration/grant-adapter.js';
import type { AocEnterprise, CreateEnterpriseOptions } from '../composition/composition-root.js';
import type { GrantAuthorityBinding } from '../execution-governance/index.js';
import type { ExecutionResolutionAuthority } from '../execution-reconciliation/authority.js';
import { OPERATOR_ATTESTATION_AUTHORITY_ID, createOperatorAttestationAuthority } from '../execution-reconciliation/operator-attestation.js';
import type { ComposedXrplPaymentRail, XrplLedgerClientFactory } from '../xrpl-payment-rail/host-composition.js';
import { xrplKeyMaterialVariables } from '../xrpl-payment-rail/host-configuration.js';
import type { ComposeXrplTradeExecutionOptions, ComposedXrplTradeExecution } from '../xrpl-trade-execution/host-composition.js';
import { xrplTradeKeyMaterialVariables } from '../xrpl-trade-execution/host-configuration.js';
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
import { createApprovalPolicyPackProvider } from './approval-policy.js';
import { createExecutionCapabilityIssuerSlot, type ExecutionCapabilityIssuerSlot } from '../execution-capability-issuance/index.js';

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
  /**
   * TRADE-04C — trusted in-process composition for the governed trade
   * executor, used only when the governed-action file configures
   * `xrplTradeExecution`:
   *
   * - `attested` (required then): the TRADE-03 trade risk context's
   *   attested-proposal source — the same edge the embedder passes as
   *   `contextProvider`. Without it the Host refuses to start.
   * - `ledgerClient`: a ledger capability factory for offline qualification
   *   (default the official SDK client; an injected one is recorded in every
   *   reservation's evidence as `injected-ledger-client`).
   * - `simulation`: the in-code acknowledgement that lets offline
   *   qualification execute on simulated-source facts. Never configuration.
   *
   * The launcher passes none, so a started process configured for trade
   * execution refuses until an embedder composes the trade risk context.
   */
  readonly xrplTradeExecution?: Pick<ComposeXrplTradeExecutionOptions, 'attested' | 'ledgerClient' | 'simulation' | 'onTrace'>;
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

/**
 * The one policy source this Host composes: the embedder's in-process
 * provider, or (PROD-03) the governed-action file's `approvalPolicy`, compiled
 * into the existing policy-pack runtime. Both at once is refused before
 * composition (`HOST_POLICY_SOURCE_AMBIGUOUS`), so no rule is ever silently
 * dropped or shadowed.
 */
function policyPackProviderOf(host: EnterpriseHostConfiguration, options: BootEnterpriseHostOptions): PolicyPackProvider | undefined {
  const declared = host.governedActions?.approvalPolicy;
  if (declared === undefined) return options.policyPackProvider;
  return createApprovalPolicyPackProvider(declared, host.governedActions!.trustDomainId);
}

function toCreateEnterpriseOptions(
  host: EnterpriseHostConfiguration,
  options: BootEnterpriseHostOptions,
  xrpl?: ComposedXrplPaymentRail,
  trade?: ComposedXrplTradeExecution,
  executionCapabilities?: ExecutionCapabilityIssuerSlot,
): CreateEnterpriseOptions {
  const governed = host.governedActions;
  const policyPackProvider = policyPackProviderOf(host, options);
  const base: CreateEnterpriseOptions = {
    configuration: host.configuration,
    ...(options.logger !== undefined ? { logger: options.logger } : {}),
    ...(policyPackProvider !== undefined ? { policyPackProvider } : {}),
  };
  if (governed === undefined) return base;

  // PAY-03: the composed XRPL rail joins the same trusted registry, reachable only through its configured route.
  // TRADE-04C: and so does the governed trade executor, reachable only through the trade action's route.
  const extra = [...(options.executionAdapters ?? []), ...(xrpl !== undefined ? [xrpl.adapter] : []), ...(trade !== undefined ? [trade.adapter] : [])];
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
      // TRADE-04C-S1: the executor's capability-issuer slot, bound by the composition over the authenticated grant store and authority signer.
      ...(trade !== undefined ? { delegatedOfferCapabilities: trade.capabilities } : {}),
      // G-02B: the opt-in execution-capability issuer, bound by the composition over the authenticated grant store, the
      // authority signer (with this policy) and the operator-initialized issuance ledger. Its one caller is the G-02C0 gate.
      ...(executionCapabilities !== undefined && governed.executionCapabilities !== undefined
        ? {
            executionCapabilities: {
              policy: governed.executionCapabilities.policy,
              ledgerPath: governed.executionCapabilities.issuanceLedgerPath,
              slot: executionCapabilities,
              // G-02C0: the listed Generic HTTP adapters bind every request to an issued, verified capability before sending.
              ...(governed.executionCapabilities.adapters.length > 0 ? { adapters: governed.executionCapabilities.adapters } : {}),
              // G-02C1D: and record each presented exchange's receipt as evidence, against the operator-pinned executors.
              ...(governed.executionCapabilities.receiptEvidence !== undefined ? { receiptEvidence: governed.executionCapabilities.receiptEvidence } : {}),
            },
          }
        : {}),
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
    ...executionReconciliationOf(host, xrpl, trade),
    ...(xrpl !== undefined || trade !== undefined ? { modules: [...(xrpl?.modules ?? []), ...(trade?.modules ?? [])] } : {}),
  };
}

function executionReconciliationOf(host: EnterpriseHostConfiguration, xrpl: ComposedXrplPaymentRail | undefined, trade?: ComposedXrplTradeExecution): Pick<CreateEnterpriseOptions, 'executionReconciliation'> {
  const operators = (host.configuration.administration?.operators?.length ?? 0) > 0;
  if (!operators && xrpl === undefined && trade === undefined) return {};
  const authorities: ExecutionResolutionAuthority[] = [...(operators ? [createOperatorAttestationAuthority()] : []), ...(xrpl !== undefined ? [xrpl.authority] : []), ...(trade !== undefined ? [trade.authority] : [])];
  // Synchronous and total over the trusted action; there is no fallback inside P12.
  // Without an operator plane, every other action binds to an XRPL authority, which
  // holds no interlock record for it and therefore only ever answers `unresolved`.
  const fallback = operators ? OPERATOR_ATTESTATION_AUTHORITY_ID : (xrpl?.authorityId ?? trade!.authorityId);
  const selectAuthority = (context: { readonly action: string }): string => {
    if (xrpl !== undefined && context.action === xrpl.paymentAction) return xrpl.authorityId;
    // TRADE-04C: every execution of the trade action is bound to the read-only trade ledger authority before its claim.
    if (trade !== undefined && context.action === trade.tradeAction) return trade.authorityId;
    return fallback;
  };
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
  const payment = host.governedActions?.xrplPaymentRail !== undefined;
  const trade = host.governedActions?.xrplTradeExecution !== undefined;
  if (!payment && !trade) return;
  // TRADE-04C: with the trade executor, also the reference offer signer's configuration and any owner/delegate key variable.
  const scan = (source: Readonly<Record<string, string | undefined>>): readonly string[] => [...(payment ? xrplKeyMaterialVariables(source) : []), ...(trade ? xrplTradeKeyMaterialVariables(source) : [])];
  const present = [...new Set([...scan(env), ...scan(process.env)])].sort();
  if (present.length === 0) return;
  throw new EnterpriseHostConfigurationError(
    'HOST_ENVIRONMENT_INVALID',
    `An XRPL submission domain is configured and this process environment carries ${present.join(', ')}. The Host only requests XRPL signatures from the external signer; XRPL key material and the signer's own configuration belong to the signer's process, never this one.`,
  );
}

/**
 * TRADE-04A rule, enforced at boot (TRADE-04C, G4): every (network, account)
 * whose `Sequence` an XRPL submission domain consumes belongs to exactly one
 * domain — Payment source accounts, trade **owner** accounts (never the
 * delegates). Run over every configured domain, from configuration alone,
 * before any interlock is opened or any signer contacted. Shared-account
 * coordination is gate G1 and is not implemented: an overlap refuses the Host.
 */
function assertXrplDomainsDisjoint(host: EnterpriseHostConfiguration): void {
  const governed = host.governedActions;
  const domains: XrplSequenceDomain[] = [];
  const payment = governed?.xrplPaymentRail;
  if (payment !== undefined) domains.push({ domainId: payment.rail.railId, networkId: payment.rail.networkId, sequenceAccounts: payment.rail.sourceAccounts.map((mapping) => mapping.address) });
  const trade = governed?.xrplTradeExecution;
  if (trade !== undefined) domains.push({ domainId: trade.executor.adapterId, networkId: TRADE_NETWORK_IDS[trade.executor.network] ?? -1, sequenceAccounts: trade.executor.pairs.map((pair) => pair.ownerAccount) });
  if (domains.length === 0) return;
  try {
    assertXrplSequenceOwnership(domains, { allowMainnet: payment?.rail.network === 'mainnet' });
  } catch (error) {
    const code = error instanceof XrplSequenceOwnershipError ? error.code : 'XRPL_SEQUENCE_DOMAIN_INVALID';
    throw new EnterpriseHostConfigurationError('HOST_XRPL_SEQUENCE_OWNERSHIP_INVALID', `${GOVERNED_ACTIONS_FILE_VARIABLE}: the configured XRPL submission domains do not own disjoint sequence accounts (${code}). One account's Sequence is never consumed by two interlocks; nothing was opened.`);
  }
}

/** TRADE-01's network ids, restated as data the Host can check without loading the trade vertical. Pinned equal to TRADE_NETWORKS by test. */
const TRADE_NETWORK_IDS: Readonly<Record<string, number>> = Object.freeze({ 'xrp-ledger-testnet': 1, 'xrp-ledger-devnet': 2 });

/** PROD-03: the file's `approvalPolicy` and an embedder's `policyPackProvider` are two policy sources; the Host composes one. */
function assertOnePolicySource(host: EnterpriseHostConfiguration, options: BootEnterpriseHostOptions): void {
  if (host.governedActions?.approvalPolicy === undefined || options.policyPackProvider === undefined) return;
  throw new EnterpriseHostConfigurationError(
    'HOST_POLICY_SOURCE_AMBIGUOUS',
    `${GOVERNED_ACTIONS_FILE_VARIABLE} declares approvalPolicy and an in-process policyPackProvider was also composed. One deterministic policy source per Host: express the approval requirement in the embedder's policy, or drop the provider.`,
  );
}

/**
 * R8 (TRADE-04C): a Host that executes trades composes exactly TRADE-03's mandatory policy provider.
 *
 * TRADE-03's review requirement and proposal-binding rules are policy-pack rules, and the Kernel's policy port
 * is opaque — so the Host cannot inspect an arbitrary provider. Before this check, any provider (or a PROD-03
 * `approvalPolicy` ruling another profile) satisfied composition, and an order TRADE-03 marked for review
 * executed with no human approval. Now the provider the Kernel receives must be the very object
 * `createTradeRiskPolicyPackProvider` produced (provenance is keyed by that object: a wrapper or copy has
 * none), bound to the same TRADE-03 edge whose readings and attestations this Host composes, for the
 * configured trade action, this trust domain and organization, and every configured owner — with the
 * mandatory rule set. A file `approvalPolicy` beside trade execution is a second policy source and is refused.
 * Configuration and object identity only; nothing is opened. The trade vertical is loaded only when configured.
 */
async function assertTradePolicyComposed(host: EnterpriseHostConfiguration, options: BootEnterpriseHostOptions): Promise<void> {
  const governed = host.governedActions;
  const trade = governed?.xrplTradeExecution;
  if (governed === undefined || trade === undefined) return;
  const required = (detail: string): never => {
    throw new EnterpriseHostConfigurationError('HOST_TRADE_POLICY_REQUIRED', `${GOVERNED_ACTIONS_FILE_VARIABLE}: xrplTradeExecution requires TRADE-03's mandatory trade policy (createTradeRiskPolicyPackProvider) as the Host's policy provider: ${detail}. Nothing was opened.`);
  };
  if (governed.approvalPolicy !== undefined) {
    throw new EnterpriseHostConfigurationError(
      'HOST_TRADE_POLICY_SOURCE_CONFLICT',
      `${GOVERNED_ACTIONS_FILE_VARIABLE} declares approvalPolicy beside xrplTradeExecution. A trade-executing Host composes exactly TRADE-03's mandatory trade policy; a second policy source is refused. Nothing was opened.`,
    );
  }
  // The exact object the Kernel will evaluate with (policyPackProviderOf returns it unchanged when the file declares no approvalPolicy).
  const effective = policyPackProviderOf(host, options);
  if (effective === undefined) required('no policy provider is composed');
  const { TRADE_RISK_MANDATORY_POLICY_RULE_IDS, tradeRiskPolicyProvenanceOf } = await import('../trade-risk-context/index.js');
  const provenance = tradeRiskPolicyProvenanceOf(effective);
  if (provenance === undefined) return required('the composed provider was not produced by the TRADE-03 factory');
  if (JSON.stringify(provenance.ruleIds) !== JSON.stringify(TRADE_RISK_MANDATORY_POLICY_RULE_IDS)) required('its rule set is not the mandatory one');
  if (provenance.action !== trade.tradeAction) required('it is bound to another action');
  if (provenance.trustDomainId !== governed.trustDomainId) required('it is bound to another trust domain');
  if (provenance.organizationId !== host.configuration.kernelAuthority?.organizationId) required('it is bound to another organization');
  if (options.contextProvider !== provenance.contextProvider) required("the Host's contextProvider is not the policy's TRADE-03 edge");
  const attested = options.xrplTradeExecution?.attested;
  // An absent attestation source is refused by the trade composition itself (XRPL_TRADE_ATTESTATION_SOURCE_MISSING), before its interlock opens.
  if (attested !== undefined && attested !== provenance.attested) required("the executor's attestation source is not the policy's TRADE-03 edge");
  const scopes = new Set(provenance.resourceScopes);
  for (const pair of trade.executor.pairs) {
    if (!scopes.has(`${trade.executor.network}:${pair.ownerAccount}`)) required('a configured owner account is outside its scope');
  }
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
    // TRADE-04C: before either interlock is opened.
    assertXrplDomainsDisjoint(host);
    // R8: a trade-executing Host composes exactly TRADE-03's mandatory policy, before anything trade-related opens.
    await assertTradePolicyComposed(host, options);
    assertOnePolicySource(host, options);
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
      const { buildAuthorityStateFreshnessBoundary } = await import('../composition/composition-root.js');
      xrpl = await composeXrplPaymentRail({
        configuration: xrplConfiguration,
        // PAY-03: the CORE-07 witness the interlock's reservation history is anchored at (configuration refuses an XRPL rail without one).
        freshness: await buildAuthorityStateFreshnessBoundary(host.configuration),
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
  // TRADE-04C (G4): only an explicitly configured executor is composed, after the ownership check, with its own interlock and CORE-07 slot.
  let trade: ComposedXrplTradeExecution | undefined;
  const tradeConfiguration = host.governedActions?.xrplTradeExecution;
  if (tradeConfiguration !== undefined) {
    try {
      const { composeXrplTradeExecution } = await import('../xrpl-trade-execution/host-composition.js');
      const { buildAuthorityStateFreshnessBoundary } = await import('../composition/composition-root.js');
      trade = await composeXrplTradeExecution({
        configuration: tradeConfiguration,
        freshness: await buildAuthorityStateFreshnessBoundary(host.configuration),
        interlockPath: host.configuration.xrplTradeInterlock?.sqlitePath ?? '.data/xrpl-trade-sequence-interlock.sqlite',
        busyTimeoutMs: host.configuration.persistence.busyTimeoutMs,
        attested: options.xrplTradeExecution?.attested,
        // TRADE-04C-S1: every signing capability names the deployment's trust domain; the delegated signer pins it.
        trustDomain: host.governedActions!.trustDomainId,
        logger,
        ...(options.xrplTradeExecution?.ledgerClient !== undefined ? { ledgerClient: options.xrplTradeExecution.ledgerClient } : {}),
        ...(options.xrplTradeExecution?.simulation !== undefined ? { simulation: options.xrplTradeExecution.simulation } : {}),
        ...(options.xrplTradeExecution?.onTrace !== undefined ? { onTrace: options.xrplTradeExecution.onTrace } : {}),
      });
    } catch (error) {
      logger.error('enterprise.host.refused', { phase: 'xrpl_trade_execution', errorCode: refusalCode(error) });
      await xrpl?.close();
      throw error;
    }
  }
  // G-02B: a write-once slot only when the file opts in; the composition binds it or refuses. The Host keeps it: no option,
  // route or response hands the issuer out (CORE-06 §23), and nothing calls it before G-02C.
  const executionCapabilities = host.governedActions?.executionCapabilities !== undefined ? createExecutionCapabilityIssuerSlot() : undefined;
  let server: EnterpriseServer;
  try {
    server = await createEnterpriseServer(toCreateEnterpriseOptions(host, { ...options, logger }, xrpl, trade, executionCapabilities));
  } catch (error) {
    logger.error('enterprise.host.refused', { phase: 'composition', errorCode: refusalCode(error) });
    await trade?.close();
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
    // TRADE-04C-S1: a trade executor whose signing capabilities cannot be issued is not served — never a bearer-only signer.
    if (trade !== undefined && !trade.capabilities.bound()) {
      throw new EnterpriseHostConfigurationError('HOST_COMPOSITION_INCOMPLETE', 'The governed trade executor was composed but no delegated-offer capability issuer was bound; it would refuse every order.');
    }
    // G-02B: an opted-in issuer that was not bound is a composition defect, never a silently absent feature.
    if (executionCapabilities !== undefined && !executionCapabilities.bound()) {
      throw new EnterpriseHostConfigurationError('HOST_COMPOSITION_INCOMPLETE', 'Execution-capability issuance was configured but no issuer was bound.');
    }
    // CORE-02: a Host configured for external custody runs on an external
    // signer, or not at all — in any profile. Checked against the composed
    // object, so nothing between configuration and composition can have put a
    // process-resident signer back.
    if (host.configuration.authorityAuthenticity.mode === 'external' && posture.authorityStore !== 'not-composed' && posture.authoritySigner !== 'external') {
      throw new EnterpriseHostConfigurationError('HOST_COMPOSITION_INCOMPLETE', `External authority-key custody was configured but the composed authority signer is '${posture.authoritySigner}'.`);
    }
    // AUTH-04A: an enabled human-decision authority is composed (signed, witnessed, exposed in-process) or the Host does not start.
    if (host.configuration.humanAuthority?.mode === 'enabled' && (posture.humanAuthority !== 'composed' || enterprise.humanAuthority === undefined)) {
      throw new EnterpriseHostConfigurationError('HOST_COMPOSITION_INCOMPLETE', 'The human-decision authority was enabled but the composed Enterprise does not expose it over a witnessed identity store.');
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
        if (store.status !== 'ready' && store.status !== 'unavailable') failing.push(`authority-freshness:${store.stateKind}${store.namespace !== undefined ? `[${store.namespace}]` : ''} (${store.reason ?? store.status})`);
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
    await trade?.close();
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
