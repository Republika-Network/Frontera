import type { ExecutionAdapter } from '../../features/execution-runtime/index.js';
import { createPaymentGovernanceBinding, createPaymentRailExecutionAdapter } from '../../features/payment-runtime/index.js';
import { XRPL_RAIL_DETAILS, createXrplRlusdRail, createXrplSdkClient, type XrplClientPort, type XrplRailLogger, type XrplRlusdRailConfiguration } from '../../features/payment-runtime/rails/xrpl/index.js';
import type { ExecutionResolutionAuthority } from '../execution-reconciliation/authority.js';
import type { EnterpriseModule, EnterpriseModuleHealth } from '../modules/enterprise-module.js';
import { AOC_ENTERPRISE_HOST_VERSION } from '../version.js';
import { createExternalXrplSigner, type ExternalXrplSigner } from './external-xrpl-signer.js';
import type { EnterpriseHostXrplPaymentRailConfiguration } from './host-configuration.js';
import { createHttpExternalXrplSignerTransport } from './signer-http-transport.js';
import { createSqliteXrplSubmissionInterlock, type DurableXrplSubmissionInterlock } from './sqlite-xrpl-submission-interlock.js';
import { XRPL_RESOLUTION_AUTHORITY_ID, createXrplResolutionAuthority, readOnlyXrplLedger } from './xrpl-resolution-authority.js';

export const XRPL_PAYMENT_RAIL_MODULE_ID = 'aoc.enterprise.xrpl-payment-rail';
export const XRPL_SUBMISSION_INTERLOCK_MODULE_ID = 'aoc.enterprise.xrpl-submission-interlock';
const LEDGER_PROBE_INTERVAL_MS = 5_000;

/** Why PAY-03 composition refused. A closed code; the message names no value. */
export type XrplCompositionFailure = 'XRPL_INTERLOCK_UNAVAILABLE' | 'XRPL_SIGNER_IDENTITY_MISMATCH' | 'XRPL_NETWORK_MISMATCH' | 'XRPL_COMPOSITION_FAILED';

export class XrplCompositionError extends Error {
  readonly code: XrplCompositionFailure;

  constructor(code: XrplCompositionFailure, message: string) {
    super(message);
    this.name = 'XrplCompositionError';
    this.code = code;
  }
}

export interface ComposedXrplPaymentRail {
  readonly paymentAction: string;
  readonly adapter: ExecutionAdapter;
  readonly authority: ExecutionResolutionAuthority;
  readonly authorityId: typeof XRPL_RESOLUTION_AUTHORITY_ID;
  /** `xrpl-submission-interlock` (required: the store) and `xrpl-payment-rail` (optional: signer and network). Their shutdown closes everything below. */
  readonly modules: readonly EnterpriseModule[];
  /** For a composition that never reached the Enterprise: closes everything opened here. Idempotent. Never clears interlock state. */
  close(): Promise<void>;
}

/** Trusted in-process composition: builds the ledger client the rail (and, separately, the resolver) talks through. */
export type XrplLedgerClientFactory = (configuration: XrplRlusdRailConfiguration) => XrplClientPort;

export interface ComposeXrplPaymentRailOptions {
  readonly configuration: EnterpriseHostXrplPaymentRailConfiguration;
  readonly interlockPath: string;
  readonly busyTimeoutMs?: number;
  readonly logger?: XrplRailLogger;
  /**
   * Trusted in-process composition: the ledger client factory. Default the
   * official SDK client over the configured endpoint (`createXrplSdkClient`).
   * Called twice — once for the rail, once for the read-only resolver — so the
   * two never share a connection.
   */
  readonly ledgerClient?: XrplLedgerClientFactory;
}

/**
 * PAY-03 — composes the production XRPL / RLUSD rail, once, at Host boot,
 * before the Enterprise is created:
 *
 * ```
 * 1. durable interlock   open + verify every record (corrupt / foreign scope → refuse)
 * 2. external signer     identity handshake against the pins (mismatch → refuse; unreachable → degraded, proven before first signature)
 * 3. XRPL client         one for the rail; one, read-only, for the resolver
 * 4. rail                PAY-02 rail + interlock; readiness connects, checks network_id (mismatch → refuse; unreachable → degraded), starts the restart quarantine
 * 5. adapter             PAY-01 bridge — the existing ExecutionAdapter registry is the only way in
 * 6. resolver            the read-only P12 authority
 * ```
 *
 * Nothing here can execute a payment: the adapter is handed to the existing
 * governed path, which alone invokes it.
 */
export async function composeXrplPaymentRail(options: ComposeXrplPaymentRailOptions): Promise<ComposedXrplPaymentRail> {
  const { configuration } = options;
  const railConfiguration = configuration.rail;
  const now = (): string => new Date().toISOString();
  const opened: (() => Promise<void>)[] = [];
  const closeAll = async (): Promise<void> => {
    for (const close of opened.splice(0).reverse()) await close().catch(() => {});
  };

  try {
    let interlock: DurableXrplSubmissionInterlock;
    try {
      interlock = await createSqliteXrplSubmissionInterlock(options.interlockPath, {
        scope: { railId: railConfiguration.railId, networkId: railConfiguration.networkId },
        now,
        ...(options.busyTimeoutMs !== undefined ? { busyTimeoutMs: options.busyTimeoutMs } : {}),
      });
    } catch {
      throw new XrplCompositionError('XRPL_INTERLOCK_UNAVAILABLE', 'The XRPL submission interlock could not be opened and verified; the XRPL rail is not composed.');
    }
    opened.push(() => interlock.close());

    const signer: ExternalXrplSigner = createExternalXrplSigner({
      transport: createHttpExternalXrplSignerTransport({ endpoint: configuration.signer.endpoint, credential: configuration.signer.credential }),
      pin: { signerId: configuration.signer.signerId, accounts: configuration.signingKeys },
      timeoutMs: configuration.signer.timeoutMs,
    });
    const identity = await signer.probe();
    if (identity.state === 'mismatch') throw new XrplCompositionError('XRPL_SIGNER_IDENTITY_MISMATCH', 'The external XRPL signer does not answer with the pinned signer id and signing keys; the XRPL rail is not composed.');

    const clientFor = options.ledgerClient ?? createXrplSdkClient;
    const railClient = clientFor(railConfiguration);
    opened.push(() => railClient.disconnect());
    const resolverClient = clientFor(railConfiguration);
    opened.push(() => resolverClient.disconnect());

    const rail = createXrplRlusdRail({ configuration: railConfiguration, client: railClient, signers: signer.signers, interlock, ...(options.logger !== undefined ? { logger: options.logger } : {}) });
    const readiness = await rail.readiness();
    if (readiness.status === 'unavailable' && readiness.detail === XRPL_RAIL_DETAILS.NETWORK_MISMATCH) {
      throw new XrplCompositionError('XRPL_NETWORK_MISMATCH', 'The configured XRPL endpoint reports a different network than the one configured; the XRPL rail is not composed.');
    }

    const adapter = createPaymentRailExecutionAdapter({ rail, binding: createPaymentGovernanceBinding({ action: configuration.paymentAction }) });
    const authority = createXrplResolutionAuthority({ configuration: railConfiguration, ledger: readOnlyXrplLedger(resolverClient), interlock });

    let closed: Promise<void> | undefined;
    const close = (): Promise<void> => (closed ??= closeAll());

    /** The ledger's readiness, refreshed at most every few seconds and single-flight, so a health probe never waits on a slow server twice. */
    let ledger: { readonly at: number; readonly state: string } = { at: Date.now(), state: readiness.status === 'ready' ? 'ready' : readiness.detail };
    let refreshing: Promise<void> | undefined;
    const ledgerState = async (): Promise<string> => {
      if (Date.now() - ledger.at >= LEDGER_PROBE_INTERVAL_MS && refreshing === undefined) {
        refreshing = rail
          .readiness()
          .then(
            (ready) => {
              ledger = { at: Date.now(), state: ready.status === 'ready' ? 'ready' : ready.detail };
            },
            () => {
              ledger = { at: Date.now(), state: XRPL_RAIL_DETAILS.NETWORK_UNAVAILABLE };
            },
          )
          .finally(() => {
            refreshing = undefined;
          });
      }
      return ledger.state;
    };

    const interlockModule: EnterpriseModule = {
      descriptor: {
        id: XRPL_SUBMISSION_INTERLOCK_MODULE_ID,
        version: AOC_ENTERPRISE_HOST_VERSION,
        displayName: 'XRPL Submission Interlock',
        description: 'Durable record of every XRPL Payment signed for an execution, written before its one submission; blocks a competing sequence across restarts and processes. No route.',
        criticality: 'required',
        capabilities: ['payment.xrpl.submission-interlock'],
      },
      async initialize() {},
      async health(): Promise<EnterpriseModuleHealth> {
        const report = await interlock.health();
        return {
          status: report.status,
          checkedAt: now(),
          ...(report.status === 'healthy' ? {} : { message: 'The XRPL submission interlock is unreadable or failed its integrity checks; every XRPL payment is refused before signing.' }),
          // An open record is the interlock doing its job — counted, never unhealthy.
          details: { provider: interlock.providerKind, readable: report.readable, writable: report.writable, schemaVersion: report.schemaVersion, ...(report.open !== undefined ? { openSubmissions: report.open } : {}) },
        };
      },
      async shutdown() {
        // Closing never clears a record: an unresolved submission outlives every shutdown.
        await interlock.close();
      },
    };

    const railModule: EnterpriseModule = {
      descriptor: {
        id: XRPL_PAYMENT_RAIL_MODULE_ID,
        version: AOC_ENTERPRISE_HOST_VERSION,
        displayName: 'XRPL / RLUSD Payment Rail',
        description: 'The PAY-02 rail behind the PAY-01 adapter boundary, an external customer-controlled transaction signer, and the read-only P12 XRPL resolution authority. No route.',
        criticality: 'optional',
        dependencies: [{ moduleId: XRPL_SUBMISSION_INTERLOCK_MODULE_ID }],
        capabilities: ['payment.xrpl.rail', 'payment.xrpl.resolution-authority'],
      },
      async initialize() {},
      async health(): Promise<EnterpriseModuleHealth> {
        // Never waits on the signer: the probe runs single-flight in the background (rate-limited) and health reports what is known.
        void signer.probe().catch(() => {});
        const signerStatus = signer.status();
        const network = await ledgerState();
        const status = signerStatus.state === 'mismatch' || network === XRPL_RAIL_DETAILS.NETWORK_MISMATCH ? 'unhealthy' : signerStatus.state === 'verified' && network === 'ready' ? 'healthy' : 'degraded';
        return {
          status,
          checkedAt: now(),
          ...(status === 'healthy' ? {} : { message: 'XRPL payments are refused before signing until the external signer identity is proven and the configured XRPL network answers.' }),
          // Identity and closed reasons only: never an endpoint, address, credential or key.
          details: {
            railId: railConfiguration.railId,
            network: railConfiguration.network,
            ledger: network,
            signer: signerStatus.state,
            ...(signerStatus.reason !== undefined ? { signerReason: signerStatus.reason } : {}),
            signerId: signerStatus.signerId,
            sourceAccounts: signerStatus.accounts,
            resolutionAuthority: XRPL_RESOLUTION_AUTHORITY_ID,
          },
        };
      },
      async shutdown() {
        await rail.close().catch(() => {});
        await resolverClient.disconnect().catch(() => {});
      },
    };

    return Object.freeze({
      paymentAction: configuration.paymentAction,
      adapter,
      authority,
      authorityId: XRPL_RESOLUTION_AUTHORITY_ID,
      modules: Object.freeze([interlockModule, railModule]),
      close,
    });
  } catch (error) {
    await closeAll();
    if (error instanceof XrplCompositionError) throw error;
    throw new XrplCompositionError('XRPL_COMPOSITION_FAILED', 'The XRPL payment rail could not be composed.');
  }
}
