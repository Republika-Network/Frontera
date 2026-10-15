import {
  createXrplReservedSubmissionClient,
  createXrplReservedSubmissionConfiguration,
  type XrplReservedSubmissionAuthority,
  type XrplReservedSubmissionConfiguration,
} from '../../features/payment-runtime/rails/xrpl/index.js';
import type { XrplSequenceDomain } from '../../features/xrpl-transport/index.js';
import { createDelegatedOfferCapabilityIssuerSlot, type DelegatedOfferCapabilityIssuerSlot } from '../authority-authenticity/delegated-offer-capability-issuer.js';
import { AuthorityStateFreshnessError } from '../authority-state-freshness/errors.js';
import { isAuthorityStateFreshnessBoundary, type AuthorityStateFreshnessBoundary } from '../authority-state-freshness/session.js';
import type { ExecutionResolutionAuthority } from '../execution-reconciliation/authority.js';
import type { EnterpriseModule, EnterpriseModuleHealth } from '../modules/enterprise-module.js';
import type { TradeAttestedProposalSource } from '../trade-risk-context/index.js';
import { AOC_ENTERPRISE_HOST_VERSION } from '../version.js';
import { createDelegatedOfferSigner, createHttpDelegatedOfferSignerTransport, type DelegatedOfferSigner } from '../xrpl-trade-rail/index.js';
import { XRPL_TRADE_EXECUTOR_ID, tradeExecutionNetworkId, type EnterpriseHostXrplTradeExecutionConfiguration } from './host-configuration.js';
import { createSqliteTradeSequenceInterlock, type DurableTradeSequenceInterlock } from './sqlite-trade-sequence-interlock.js';
import { tradeExecutionEvidenceOf, type TradeExecutionEvidenceRecord } from './trade-execution-evidence.js';
import { createTradeOfferExecutionAdapter, type TRADE_EXECUTION_SIMULATION_ACKNOWLEDGEMENT, type TradeExecutionLedger, type TradeExecutionTrace, type TradeOfferExecutionAdapter } from './trade-offer-executor.js';
import { TRADE_RESOLUTION_AUTHORITY_ID, createTradeResolutionAuthority, readOnlyTradeLedger } from './trade-resolution-authority.js';

export const XRPL_TRADE_EXECUTOR_MODULE_ID = 'aoc.enterprise.xrpl-trade-executor';
export const XRPL_TRADE_INTERLOCK_MODULE_ID = 'aoc.enterprise.xrpl-trade-sequence-interlock';
const LEDGER_PROBE_INTERVAL_MS = 5_000;

export type XrplTradeCompositionFailure =
  | 'XRPL_TRADE_INTERLOCK_UNAVAILABLE'
  | 'XRPL_TRADE_INTERLOCK_FRESHNESS_FAILED'
  | 'XRPL_TRADE_ATTESTATION_SOURCE_MISSING'
  | 'XRPL_TRADE_SIGNER_IDENTITY_MISMATCH'
  | 'XRPL_TRADE_NETWORK_MISMATCH'
  | 'XRPL_TRADE_COMPOSITION_FAILED';

export class XrplTradeCompositionError extends Error {
  readonly code: XrplTradeCompositionFailure;

  constructor(code: XrplTradeCompositionFailure, message: string) {
    super(message);
    this.name = 'XrplTradeCompositionError';
    this.code = code;
  }
}

/**
 * Trusted in-process composition (qualification): builds the ledger capability
 * over the reserved submission configuration **and the interlock the Host
 * opened** — so even an injected double reaches its write only through that
 * interlock's claim. Default: the official SDK client
 * (`createXrplReservedSubmissionClient`), the one submit site.
 */
export type XrplTradeLedgerClientFactory = (configuration: XrplReservedSubmissionConfiguration, authority: XrplReservedSubmissionAuthority) => TradeExecutionLedger & { disconnect(): Promise<void> };

export interface ComposeXrplTradeExecutionOptions {
  readonly configuration: EnterpriseHostXrplTradeExecutionConfiguration;
  readonly interlockPath: string;
  readonly freshness: AuthorityStateFreshnessBoundary | undefined;
  /** TRADE-03's attested-proposal source (the in-process trade risk edge the embedder composed as `contextProvider`). Required. */
  readonly attested: TradeAttestedProposalSource | undefined;
  /** TRADE-04C-S1: the deployment's trust-domain id (`governedActions.trustDomainId`), named by every signing capability. */
  readonly trustDomain: string;
  readonly busyTimeoutMs?: number;
  readonly logger?: { info(message: string, fields?: Readonly<Record<string, unknown>>): void; warn(message: string, fields?: Readonly<Record<string, unknown>>): void };
  readonly ledgerClient?: XrplTradeLedgerClientFactory;
  /** In code only, by offline qualification: execute on facts from a simulated-source profile. */
  readonly simulation?: typeof TRADE_EXECUTION_SIMULATION_ACKNOWLEDGEMENT;
  readonly onTrace?: (trace: TradeExecutionTrace) => void;
}

export interface ComposedXrplTradeExecution {
  readonly tradeAction: string;
  readonly adapter: TradeOfferExecutionAdapter;
  readonly authority: ExecutionResolutionAuthority;
  readonly authorityId: typeof TRADE_RESOLUTION_AUTHORITY_ID;
  readonly modules: readonly EnterpriseModule[];
  /**
   * TRADE-04C-S1: the write-once capability-issuer slot the executor asks. The
   * Host hands it to the composition root, which binds it over the
   * authenticated grant store and the authority signer; until then every
   * order is refused before signing, and the Host refuses to serve unbound.
   */
  readonly capabilities: DelegatedOfferCapabilityIssuerSlot;
  /** The trade evidence record for one execution (the verified interlock row), or `undefined`. */
  evidence(executionId: string): Promise<TradeExecutionEvidenceRecord | undefined>;
  close(): Promise<void>;
}

/**
 * The sequence domain the trade executor would consume — its **owner**
 * accounts on its network (never the delegates). Pure, from configuration:
 * the Host passes it, with every other XRPL domain, to
 * `assertXrplSequenceOwnership` **before** any interlock is opened.
 */
export function xrplTradeSequenceDomain(configuration: EnterpriseHostXrplTradeExecutionConfiguration): XrplSequenceDomain {
  return Object.freeze({ domainId: XRPL_TRADE_EXECUTOR_ID, networkId: tradeExecutionNetworkId(configuration), sequenceAccounts: Object.freeze(configuration.executor.pairs.map((pair) => pair.ownerAccount)) });
}

/**
 * TRADE-04C (G4) — composes the governed trade executor, once, at Host boot,
 * after the cross-domain ownership check and before the Enterprise exists:
 *
 * ```
 * 1. trade interlock    open + verify every record; history reconciled with the CORE-07 witness (slot trade-sequence-reservations)
 * 2. offer signer       TRADE-04B client over EP-073; identity proven against the pin (mismatch → refuse; unreachable → degraded)
 * 3. ledger client      the reserved submission client, bound to THIS interlock (G2); a second, read-only one for P12
 * 4. executor           ExecutionAdapter; readiness proves the network (mismatch → refuse; unreachable → degraded)
 * 5. resolver           the read-only P12 authority
 * ```
 *
 * The signer and the submission capability are handed to the executor and to
 * nothing else; the executor is handed to the existing adapter registry,
 * which alone invokes it, below the bounded grant.
 */
export async function composeXrplTradeExecution(options: ComposeXrplTradeExecutionOptions): Promise<ComposedXrplTradeExecution> {
  const { configuration } = options;
  const networkId = tradeExecutionNetworkId(configuration);
  const now = (): string => new Date().toISOString();
  const opened: (() => Promise<void>)[] = [];
  const closeAll = async (): Promise<void> => {
    for (const close of opened.splice(0).reverse()) await close().catch(() => {});
  };

  try {
    const boundary = options.freshness;
    if (!isAuthorityStateFreshnessBoundary(boundary)) throw new XrplTradeCompositionError('XRPL_TRADE_INTERLOCK_FRESHNESS_FAILED', 'The trade sequence interlock needs the external authority-state freshness witness; the trade executor is not composed.');
    const attested = options.attested;
    if (typeof attested?.attestedProposal !== 'function') throw new XrplTradeCompositionError('XRPL_TRADE_ATTESTATION_SOURCE_MISSING', 'The trade executor needs the TRADE-03 attested-proposal source of the composed trade risk context; the trade executor is not composed.');

    let interlock: DurableTradeSequenceInterlock;
    try {
      interlock = await createSqliteTradeSequenceInterlock(options.interlockPath, {
        scope: { domainId: XRPL_TRADE_EXECUTOR_ID, networkId },
        sequenceAccounts: configuration.executor.pairs.map((pair) => pair.ownerAccount),
        now,
        freshness: { boundary },
        ...(options.busyTimeoutMs !== undefined ? { busyTimeoutMs: options.busyTimeoutMs } : {}),
      });
    } catch (error) {
      if (error instanceof AuthorityStateFreshnessError) throw new XrplTradeCompositionError('XRPL_TRADE_INTERLOCK_FRESHNESS_FAILED', `The trade sequence interlock's history could not be proven fresh at the authority-state witness (${error.code}); nothing is signed. The trade executor is not composed.`);
      throw new XrplTradeCompositionError('XRPL_TRADE_INTERLOCK_UNAVAILABLE', 'The trade sequence interlock could not be opened and verified; the trade executor is not composed.');
    }
    opened.push(() => interlock.close());

    const signer: DelegatedOfferSigner = createDelegatedOfferSigner({
      transport: createHttpDelegatedOfferSignerTransport({ endpoint: configuration.signer.endpoint, credential: configuration.signer.credential }),
      pin: configuration.signer.pin,
      timeoutMs: configuration.signer.timeoutMs,
      maximumFeeDrops: configuration.executor.maximumFeeDrops,
      maximumLedgerHorizon: configuration.executor.lastLedgerOffset,
    });
    const identity = await signer.probe();
    if (identity.state === 'MISMATCH') throw new XrplTradeCompositionError('XRPL_TRADE_SIGNER_IDENTITY_MISMATCH', 'The delegated offer signer does not answer with the pinned signer id, network and pairs; the trade executor is not composed.');

    const submission = createXrplReservedSubmissionConfiguration({ endpoint: configuration.endpoint, networkId, requestTimeoutMs: configuration.executor.requestTimeoutMs });
    const clientFor: XrplTradeLedgerClientFactory = options.ledgerClient ?? ((cfg, authority) => createXrplReservedSubmissionClient(cfg, authority));
    const executorClient = clientFor(submission, interlock);
    opened.push(() => executorClient.disconnect());
    const resolverClient = clientFor(submission, interlock);
    opened.push(() => resolverClient.disconnect());

    if (typeof options.trustDomain !== 'string' || options.trustDomain.length === 0) throw new XrplTradeCompositionError('XRPL_TRADE_COMPOSITION_FAILED', 'The trade executor needs the deployment trust-domain id its signing capabilities name.');
    const capabilities = createDelegatedOfferCapabilityIssuerSlot();
    const adapter = createTradeOfferExecutionAdapter({
      configuration: configuration.executor,
      attested,
      signer,
      authorization: { trustDomain: options.trustDomain, issuer: capabilities },
      ledger: executorClient,
      interlock,
      ledgerProvenance: options.ledgerClient === undefined ? 'xrpl-network' : 'injected-ledger-client',
      ...(options.simulation !== undefined ? { simulation: options.simulation } : {}),
      ...(options.logger !== undefined ? { logger: options.logger } : {}),
      ...(options.onTrace !== undefined ? { onTrace: options.onTrace } : {}),
    });
    const readiness = await adapter.readiness();
    if (readiness.status === 'unavailable' && readiness.detail === 'XRPL_READ_NETWORK_MISMATCH') throw new XrplTradeCompositionError('XRPL_TRADE_NETWORK_MISMATCH', 'The configured XRPL endpoint reports a different network than the trade executor is configured for; it is not composed.');

    const authority = createTradeResolutionAuthority({ networkId, action: configuration.tradeAction, requestTimeoutMs: configuration.executor.requestTimeoutMs, ledger: readOnlyTradeLedger(resolverClient), interlock });

    let closed: Promise<void> | undefined;
    const close = (): Promise<void> => (closed ??= closeAll());

    let ledger: { readonly at: number; readonly state: string } = { at: Date.now(), state: readiness.status === 'ready' ? 'ready' : readiness.detail };
    let refreshing: Promise<void> | undefined;
    const ledgerState = (): string => {
      if (Date.now() - ledger.at >= LEDGER_PROBE_INTERVAL_MS && refreshing === undefined) {
        refreshing = adapter
          .readiness()
          .then(
            (ready) => {
              ledger = { at: Date.now(), state: ready.status === 'ready' ? 'ready' : ready.detail };
            },
            () => {
              ledger = { at: Date.now(), state: 'trade-ledger-unavailable' };
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
        id: XRPL_TRADE_INTERLOCK_MODULE_ID,
        version: AOC_ENTERPRISE_HOST_VERSION,
        displayName: 'XRPL Trade Sequence Interlock',
        description: 'Durable record of every delegated OfferCreate the governed trade executor signed, reserved before its one submission and claimed by the submit site; blocks a competing owner Sequence across restarts and processes. No route.',
        criticality: 'required',
        capabilities: ['trade.xrpl.sequence-interlock'],
      },
      async initialize() {},
      async health(): Promise<EnterpriseModuleHealth> {
        await boundary.probe().catch(() => undefined);
        const report = await interlock.health();
        return {
          status: report.status,
          checkedAt: now(),
          ...(report.status === 'healthy' ? {} : { message: 'The trade sequence interlock is unreadable, failed its integrity checks or its history is not proven fresh; every governed order is refused before signing.' }),
          details: {
            provider: interlock.providerKind,
            readable: report.readable,
            writable: report.writable,
            schemaVersion: report.schemaVersion,
            ...(report.open !== undefined ? { openReservations: report.open } : {}),
            ...(report.freshness !== undefined ? { freshness: report.freshness } : {}),
          },
        };
      },
      async shutdown() {
        await interlock.close();
      },
    };

    const executorModule: EnterpriseModule = {
      descriptor: {
        id: XRPL_TRADE_EXECUTOR_MODULE_ID,
        version: AOC_ENTERPRISE_HOST_VERSION,
        displayName: 'XRPL Governed Trade Executor',
        description: 'The TRADE-04C delegated OfferCreate executor behind the adapter registry, its protected TRADE-04B signer client, and the read-only P12 trade resolution authority. No route.',
        criticality: 'optional',
        dependencies: [{ moduleId: XRPL_TRADE_INTERLOCK_MODULE_ID }],
        capabilities: ['trade.xrpl.executor', 'trade.xrpl.resolution-authority'],
      },
      async initialize() {},
      async health(): Promise<EnterpriseModuleHealth> {
        void signer.probe().catch(() => {});
        const signerStatus = signer.status();
        const network = ledgerState();
        const status = signerStatus.state === 'MISMATCH' || network === 'XRPL_READ_NETWORK_MISMATCH' || !capabilities.bound() ? 'unhealthy' : signerStatus.state === 'VERIFIED' && network === 'ready' ? 'healthy' : 'degraded';
        return {
          status,
          checkedAt: now(),
          ...(status === 'healthy' ? {} : { message: 'Governed orders are refused before signing until the delegated offer signer identity is proven and the configured XRPL network answers.' }),
          // Identity and closed reasons only: never an endpoint, address, credential or key.
          details: {
            adapterId: XRPL_TRADE_EXECUTOR_ID,
            network: configuration.executor.network,
            ledger: network,
            signer: signerStatus.state,
            ...(signerStatus.reason !== undefined ? { signerReason: signerStatus.reason } : {}),
            signerId: signerStatus.signerId,
            pairs: signerStatus.pairs,
            // TRADE-04C-S1: whether the per-order signing capability issuer is bound, and what authority the signer says it pins (public ids).
            capabilityIssuer: capabilities.bound() ? 'bound' : 'unbound',
            ...(signerStatus.authorization !== undefined ? { signerAuthorization: { trustDomain: signerStatus.authorization.trustDomain, organizationId: signerStatus.authorization.organizationId, issuerKeyIds: [...signerStatus.authorization.issuerKeyIds] } } : {}),
            resolutionAuthority: TRADE_RESOLUTION_AUTHORITY_ID,
          },
        };
      },
      async shutdown() {
        await executorClient.disconnect().catch(() => {});
        await resolverClient.disconnect().catch(() => {});
      },
    };

    return Object.freeze({
      tradeAction: configuration.tradeAction,
      adapter,
      authority,
      authorityId: TRADE_RESOLUTION_AUTHORITY_ID,
      modules: Object.freeze([interlockModule, executorModule]),
      capabilities,
      async evidence(executionId: string) {
        const record = await interlock.read(executionId);
        return record === undefined ? undefined : tradeExecutionEvidenceOf(record, networkId);
      },
      close,
    });
  } catch (error) {
    await closeAll();
    if (error instanceof XrplTradeCompositionError) throw error;
    throw new XrplTradeCompositionError('XRPL_TRADE_COMPOSITION_FAILED', 'The governed trade executor could not be composed.');
  }
}
