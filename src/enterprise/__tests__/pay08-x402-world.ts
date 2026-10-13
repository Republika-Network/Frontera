import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createInMemoryExerciseControlLedger } from '../../features/exercise-control-runtime/index.js';
import { createInMemoryBoundedGrantStore } from '../../features/grant-runtime/index.js';
import { createFinancialActionClassifier, createMonetaryAssetRegistry } from '../../features/monetary-runtime/index.js';
import {
  PAYMENT_PARAMETER_DIMENSIONS,
  PAYMENT_PROFILE_PARAMETERS,
  PAYMENT_PROTOCOL_RESERVED_CONTEXT_KEYS,
  createPaymentGovernanceBinding,
  createPaymentRailExecutionAdapter,
  type PaymentExecutionRequest,
  type PaymentRail,
} from '../../features/payment-runtime/index.js';
import { MPP_RESERVED_CONTEXT_KEYS } from '../../features/payment-runtime/protocols/mpp/index.js';
import { X402_RESERVED_CONTEXT_KEYS, createX402PaymentProtocolAdapter, decodeX402PaymentSignatureHeader, type X402JsonObject, type X402PaymentProtocolAdapter } from '../../features/payment-runtime/protocols/x402/index.js';
import { createLightningRail, decodeBolt11Invoice, readOnlyLightningNode } from '../../features/payment-runtime/rails/lightning/index.js';
import { TEST_NOW_MS, TEST_NOW_SECONDS, buildInvoice, createSimulatedLightningNode, testPreimage, testRailConfiguration, type SimulatedLightningNode } from '../../features/payment-runtime/rails/lightning/tests/lightning-test-fixtures.js';
import { createAuthorityEventProjector, createInMemoryAuthorityEventStreamStore, type AuthorityEventProjector } from '../authority-event-stream/index.js';
import type { BoundCustomerIdentity } from '../customer-identity/index.js';
import { authorityTraceVerificationOf, buildAuthorityTrace, type AuthorityTraceSources } from '../evidence/trace-builder.js';
import { snapshotResolutionAuthorities } from '../execution-reconciliation/authority.js';
import { createExecutionReconciliationService } from '../execution-reconciliation/service.js';
import type { ExecutionOutcomeStore } from '../execution-outcome-store/outcome-store.js';
import { createSqliteExecutionOutcomeStore } from '../execution-outcome-store/sqlite-execution-outcome-store.js';
import type { ExecutionResolutionStore } from '../execution-resolution-store/resolution-store.js';
import { createSqliteExecutionResolutionStore } from '../execution-resolution-store/sqlite-execution-resolution-store.js';
import { createGovernanceProfileRegistry } from '../governance-profile/index.js';
import { createInMemoryGovernanceStore } from '../governance-store/in-memory-governance-store.js';
import { createExecutionLedger, executionClaimRecorded } from '../governed-action/execution-ledger.js';
import { createLightningFinalityAuthority } from '../lightning-payment-rail/lightning-finality-authority.js';
import { createLightningResolutionAuthority } from '../lightning-payment-rail/lightning-resolution-authority.js';
import { createSqliteLightningPaymentInterlock, type DurableLightningPaymentInterlock } from '../lightning-payment-rail/sqlite-lightning-payment-interlock.js';
import {
  createPaymentProtocolContextReader,
  createPaymentProtocolIngress,
  createSqlitePaymentBusinessOperationStore,
  type DurablePaymentBusinessOperationStore,
  type PaymentProtocolIngressResult,
} from '../payment-protocol-ingress/index.js';
import { createPaymentSettlementService, createSqlitePaymentSettlementStore, type PaymentSettlementStore } from '../payment-settlement/index.js';
import {
  X402_LNBTC_ATOMIC_SCALE,
  X402_LNBTC_NETWORKS,
  createX402LightningBinding,
  createX402LightningExecutionInvoices,
  createX402LightningInvoiceVerifier,
  createX402PaymentSignatureBuilder,
  createX402Presentation,
  lightningNodeProofSource,
  x402LightningBindingId,
  type X402PaymentSignatureResult,
} from '../x402-payment-protocol/index.js';
import { drained } from './authority-event-stream-support.js';
import { boundaryFor, startWitness, type StartedWitness } from './core07-freshness-fixture.js';
import { ALLOWED_INTENT, IDENTITY, NO_TEMPORAL_BOUND, NOW, ORG, buildGovernedWorld, monetaryAuthority, type GovernedWorld } from './governed-action-support.js';

/**
 * PAY-08 — the governed world an x402 payment is proven in, and a test-only
 * reference x402 resource server to pay.
 *
 * The world is PAY-07's shared stack, composed the same way — the real
 * Kernel, Governance Store, CORE-03 profile, P10 ceiling, grant store, ACE,
 * P7, P11 (SQLite), P12 (SQLite), PAY-04 ingress with its business-operation
 * store anchored at a real CORE-07 witness, PAY-05 settlement (SQLite), the P8
 * event stream and the ASSURE-01 trace — with exactly one protocol change:
 * the ingress composes PAY-08's x402 adapter, and the rail is PAY-06's
 * Lightning rail on testnet (the `lnbtc` binding's network), its durable
 * interlock anchored at the same witness, over PAY-06's deterministic node
 * simulator.
 *
 * The reference server is the merchant: it implements the resource-server and
 * facilitator `/settle` half of `scheme_exact_lnbtc.md` independently of
 * PAY-08's code (its own request-hash, its own checks, a replay store), so a
 * round trip proves interoperability, not self-agreement. It is test code: no
 * Host route, no production resource-server mode.
 */

export const PAYMENT_ACTION = ALLOWED_INTENT.action;
export const GOVERNED_ACCOUNT = ALLOWED_INTENT.resource;
export const BINDING = createPaymentGovernanceBinding({ action: PAYMENT_ACTION });
export const BTC = 'net:BTC';
export const LNBTC_TESTNET = X402_LNBTC_NETWORKS.testnet.network;
export const RESOURCE_URL = 'https://api.merchant.example/reports/42?format=json';
export const TARGET = 'merchant:report-42';
export const PROTECTED_GET = Object.freeze({ target: TARGET, method: 'GET' });
/** The governed bound: a ceiling of 0.001 BTC; 25 000 msat is within it, 100 001 000 msat over it. */
export const CEILING = '0.001';
export const WITHIN_MSAT = 25_000n;
export const OVER_MSAT = 100_001_000n;

/** An HTTP request as the agent's network layer sends it. */
export interface AgentRequest {
  readonly method: string;
  readonly url: string;
  readonly body?: Buffer;
  /** Lower-case names → values. */
  readonly headers?: Readonly<Record<string, string>>;
}

export interface MerchantResponse {
  readonly status: number;
  readonly headers: readonly (readonly [string, string])[];
  readonly body?: string;
}

const sha256Hex = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex');

/** The merchant's own `http:1` binding object, JCS-serialized — written from the spec, independently of the edge's implementation. */
export function merchantBindingText(request: AgentRequest, boundHeaders: readonly string[]): string {
  const bodyHash = sha256Hex(request.body ?? Buffer.alloc(0));
  const headers = boundHeaders.map((name) => {
    const value = request.headers?.[name];
    return `{"name":${JSON.stringify(name)},"valueHash":"${value === undefined ? sha256Hex(Uint8Array.of(0)) : sha256Hex(Buffer.concat([Uint8Array.of(1), Buffer.from(value, 'ascii')]))}"}`;
  });
  return `{"bodyHash":"${bodyHash}","domain":"x402:exact:lnbtc:bolt11:http:1","headers":[${headers.join(',')}],"method":${JSON.stringify(request.method)},"url":${JSON.stringify(request.url)}}`;
}

/** RFC 9530 Content-Digest (sha-256) of a body, as the trusted network layer computes it. */
export function contentDigestOf(body: Buffer): string {
  return `sha-256=:${createHash('sha256').update(body).digest('base64')}:`;
}

export interface ReferenceServerOptions {
  readonly node: SimulatedLightningNode;
  readonly amountMsat?: bigint;
  readonly maxTimeoutSeconds?: number;
  readonly boundHeaders?: readonly string[];
  readonly extensions?: Record<string, unknown>;
  /** Signing key label of the merchant's receiving node. */
  readonly payeeKeyLabel?: string;
}

export interface ReferenceServer {
  /** The merchant's answer to the agent's request: 402 + PAYMENT-REQUIRED, or the resource for a valid proof. */
  respond(request: AgentRequest): Promise<MerchantResponse>;
  /** Builds a challenge's requirement JSON object for the request (and registers its invoice with the payee node). */
  requirementFor(request: AgentRequest, label: string, overrides?: Record<string, unknown>): Promise<Record<string, unknown>>;
  paymentRequiredJson(request: AgentRequest, accepts: readonly unknown[]): Record<string, unknown>;
  readonly counters: { challenges: number; verifyCalls: number; settleCalls: number; served: number; refused: string[] };
}

const b64 = (json: unknown): string => Buffer.from(JSON.stringify(json), 'utf8').toString('base64');

export function createReferenceX402Server(options: ReferenceServerOptions): ReferenceServer {
  const amountMsat = options.amountMsat ?? WITHIN_MSAT;
  const maxTimeoutSeconds = options.maxTimeoutSeconds ?? 600;
  const boundHeaders = options.boundHeaders ?? [];
  const payeeKeyLabel = options.payeeKeyLabel ?? 'payee-node';
  /** The facilitator's restart-durable replay store, in this test: one process. */
  const consumed = new Set<string>();
  const counters = { challenges: 0, verifyCalls: 0, settleCalls: 0, served: 0, refused: [] as string[] };
  let issued = 0;

  async function requirementFor(request: AgentRequest, label: string, overrides: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const description = merchantBindingText(request, boundHeaders);
    const amount = typeof overrides['invoiceAmountMsat'] === 'bigint' ? (overrides['invoiceAmountMsat'] as bigint) : amountMsat;
    const { paymentHash } = testPreimage(label);
    const invoice = await buildInvoice({ network: 'testnet', amountMsat: amount, paymentHash, payeeKeyLabel, description, descriptionHash: true, expirySeconds: maxTimeoutSeconds, timestamp: TEST_NOW_SECONDS - 60 });
    // The merchant's receiving node knows the preimage for the hash (the simulator pays by payment hash).
    // A cheap route: the deployment's trusted fee cap (1 % of a 25-sat payment = 250 msat) must admit it.
    await options.node.registerInvoice({ label, amountMsat: amount, payeeKeyLabel, routeFeeMsat: 100n });
    const decoded = await decodeBolt11Invoice(invoice);
    if (!decoded.valid) throw new Error(`reference server built an invalid invoice: ${decoded.refusal}`);
    const { invoiceAmountMsat: _ignored, extra: extraOverride, ...rest } = overrides;
    return {
      scheme: 'exact',
      network: LNBTC_TESTNET,
      amount: amount.toString(),
      asset: 'BTC',
      payTo: decoded.invoice.payee,
      maxTimeoutSeconds,
      extra: {
        assetTransferMethod: 'bolt11',
        paymentFlow: 'upfront',
        requestHash: sha256Hex(Buffer.from(description, 'utf8')),
        requestBindingProfile: 'http:1',
        requestBindingParams: { headers: [...boundHeaders] },
        invoice,
        ...((extraOverride as Record<string, unknown> | undefined) ?? {}),
      },
      ...rest,
    };
  }

  function paymentRequiredJson(request: AgentRequest, accepts: readonly unknown[]): Record<string, unknown> {
    return {
      x402Version: 2,
      error: 'PAYMENT-SIGNATURE header is required',
      resource: { url: request.url, description: 'Quarterly report 42', mimeType: 'application/json' },
      accepts,
      ...(options.extensions !== undefined ? { extensions: options.extensions } : {}),
    };
  }

  async function settle(request: AgentRequest, signature: string): Promise<{ ok: true; paymentHash: string } | { ok: false; reason: string }> {
    // The upfront flow: /settle only — never /verify.
    counters.settleCalls += 1;
    const payload = decodeX402PaymentSignatureHeader(signature);
    if (!payload.valid) return { ok: false, reason: 'invalid_payload' };
    const accepted = payload.value.accepted;
    const extra = accepted.extra ?? {};
    const expected = sha256Hex(Buffer.from(merchantBindingText(request, boundHeaders), 'utf8'));
    if (accepted.scheme !== 'exact') return { ok: false, reason: 'unsupported_scheme' };
    if (accepted.network !== LNBTC_TESTNET) return { ok: false, reason: 'network_mismatch' };
    if (accepted.asset !== 'BTC') return { ok: false, reason: 'invalid_exact_lnbtc_asset' };
    if (accepted.amount !== amountMsat.toString()) return { ok: false, reason: 'invalid_exact_lnbtc_amount_mismatch' };
    if (accepted.maxTimeoutSeconds !== maxTimeoutSeconds) return { ok: false, reason: 'invalid_exact_lnbtc_max_timeout_mismatch' };
    if (extra['paymentFlow'] !== 'upfront') return { ok: false, reason: 'invalid_exact_lnbtc_payment_flow' };
    if (extra['requestHash'] !== expected) return { ok: false, reason: 'invalid_exact_lnbtc_request_mismatch' };
    const decoded = await decodeBolt11Invoice(extra['invoice']);
    if (!decoded.valid) return { ok: false, reason: 'invalid_exact_lnbtc_invoice_decode_failed' };
    if (decoded.invoice.descriptionHash !== expected) return { ok: false, reason: 'invalid_exact_lnbtc_invoice_request_mismatch' };
    if (decoded.invoice.payee !== accepted.payTo) return { ok: false, reason: 'invalid_exact_lnbtc_invoice_payee_mismatch' };
    if (decoded.invoice.amountMsat !== amountMsat) return { ok: false, reason: 'invalid_exact_lnbtc_invoice_amount_mismatch' };
    const preimage = payload.value.payload['preimage'];
    if (typeof preimage !== 'string' || !/^[0-9a-f]{64}$/.test(preimage)) return { ok: false, reason: 'invalid_exact_lnbtc_preimage_malformed' };
    if (sha256Hex(Buffer.from(preimage, 'hex')) !== decoded.invoice.paymentHash) return { ok: false, reason: 'invalid_exact_lnbtc_preimage_hash_mismatch' };
    const key = `${LNBTC_TESTNET}:${decoded.invoice.paymentHash}`;
    if (consumed.has(key)) return { ok: false, reason: 'duplicate_settlement' };
    consumed.add(key);
    return { ok: true, paymentHash: decoded.invoice.paymentHash };
  }

  return {
    counters,
    requirementFor,
    paymentRequiredJson,
    async respond(request: AgentRequest): Promise<MerchantResponse> {
      const signature = request.headers?.['payment-signature'];
      if (signature === undefined) {
        counters.challenges += 1;
        issued += 1;
        const requirement = await requirementFor(request, `pay08-invoice-${String(issued)}-${amountMsat.toString()}`);
        return { status: 402, headers: [['PAYMENT-REQUIRED', b64(paymentRequiredJson(request, [requirement]))]] };
      }
      const settled = await settle(request, signature);
      if (!settled.ok) {
        counters.refused.push(settled.reason);
        return { status: 402, headers: [['PAYMENT-RESPONSE', b64({ success: false, errorReason: settled.reason, transaction: '', network: LNBTC_TESTNET })]] };
      }
      counters.served += 1;
      return { status: 200, headers: [['PAYMENT-RESPONSE', b64({ success: true, transaction: settled.paymentHash, network: LNBTC_TESTNET })], ['content-type', 'application/json']], body: '{"report":42}' };
    },
  };
}

// ─── the governed world ──────────────────────────────────────────────────────

const GOVERNANCE = createGovernanceProfileRegistry({
  parameterDimensions: PAYMENT_PARAMETER_DIMENSIONS,
  actionClasses: [{ id: 'payment', actions: [PAYMENT_ACTION] }],
  resourceClasses: [{ id: 'governed-account', resources: [GOVERNED_ACCOUNT] }],
  profiles: [
    {
      profileId: 'governed-payment',
      version: 1,
      owner: ORG,
      provenance: { authoredBy: 'operator:treasury', approvedBy: 'operator:security' },
      actionClass: 'payment',
      resourceClass: 'governed-account',
      parameters: PAYMENT_PROFILE_PARAMETERS,
      materialFacts: [],
      relevantPolicies: [],
    },
  ],
  reservedContextKeys: [...PAYMENT_PROTOCOL_RESERVED_CONTEXT_KEYS, ...MPP_RESERVED_CONTEXT_KEYS, ...X402_RESERVED_CONTEXT_KEYS],
});

export const ASSETS = createMonetaryAssetRegistry([
  { assetId: 'USD', scale: 2 },
  { assetId: BTC, scale: 11 },
]);
export const MONETARY = Object.freeze({ assets: ASSETS, actionClassifier: createFinancialActionClassifier({ financialActions: [PAYMENT_ACTION] }) });
export const CONFIGURATION = testRailConfiguration({ network: 'testnet', sourceAccounts: [GOVERNED_ACCOUNT] });

const directories: string[] = [];
export function cleanupPay08Directories(): void {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
}

let ingressTick = 0;
/** The ingress observes at the Lightning fixtures' "now" (the invoices are valid then), independent of the governance clock. */
const ingressClock = (): string => new Date(TEST_NOW_MS + (ingressTick += 1)).toISOString();

export interface X402WorldOptions {
  /** Trusted request fields the network layer can attest (bound headers). */
  readonly fields?: Readonly<Record<string, string | null>>;
  readonly ceiling?: string;
  /** The decoding cache's window (default 256). */
  readonly verifierEntries?: number;
}

export interface Presentation {
  readonly carrier: unknown;
  readonly businessOperationId?: string;
  readonly protectedRequest?: { readonly target: string; readonly method: string; readonly contentDigest?: string };
  readonly identity?: BoundCustomerIdentity;
}

export interface X402World {
  readonly directory: string;
  readonly paths: { readonly operations: string; readonly outcomes: string; readonly resolutions: string; readonly settlements: string; readonly interlock: string };
  readonly node: SimulatedLightningNode;
  readonly witness: StartedWitness;
  readonly adapter: X402PaymentProtocolAdapter;
  /** Every intent handed to `govern()`. */
  readonly governedIntents: unknown[];
  /** Every PAY-01 instruction the rail bridge issued. */
  readonly railInstructions: PaymentExecutionRequest[];
  /** Every invoice lookup PAY-06's rail made, with the exact text it was given (or `undefined`). */
  readonly invoiceLookups: { readonly executionId: string; readonly paymentHash: string; readonly served: string | undefined }[];
  present(presentation: Presentation): Promise<PaymentProtocolIngressResult>;
  /** The raw presentation call, for hostile-request tests. */
  presentRaw(identity: BoundCustomerIdentity, request: unknown): Promise<PaymentProtocolIngressResult>;
  /** Money-moving calls at the node boundary. */
  effects(): number;
  kernelEvaluations(): number;
  verifySettlement(executionId: string): ReturnType<ReturnType<typeof createPaymentSettlementService>['verifySettlement']>;
  readSettlement(executionId: string): ReturnType<ReturnType<typeof createPaymentSettlementService>['readSettlement']>;
  receipt(executionId: string): ReturnType<ReturnType<typeof createPaymentSettlementService>['receipt']>;
  buildSignature(request: { readonly requestId: string; readonly executionId: string; readonly clientExtensions?: X402JsonObject }): Promise<X402PaymentSignatureResult>;
  reconcile(executionId: string): Promise<unknown>;
  trace(requestId: string): Promise<{ readonly verified: boolean; readonly path?: string; readonly finalState?: string; readonly failed: readonly string[]; readonly json: string }>;
  operations(): DurablePaymentBusinessOperationStore;
  contexts(): ReturnType<typeof createPaymentProtocolContextReader>;
  restart(): Promise<void>;
  /** Copies the business-operation store while every store is closed (a cold backup), then reopens. */
  backupOperations(): Promise<string>;
  /** Restores a backup of the business-operation store and recomposes — the stale restore CORE-07 must refuse. */
  restoreOperations(backup: string): Promise<{ readonly refused: boolean; readonly code?: string }>;
  close(): Promise<void>;
}

export async function openX402World(options: X402WorldOptions = {}): Promise<X402World> {
  const directory = mkdtempSync(join(tmpdir(), 'frontera-pay08-'));
  directories.push(directory);
  const paths = {
    outcomes: join(directory, 'outcomes.sqlite'),
    resolutions: join(directory, 'resolutions.sqlite'),
    settlements: join(directory, 'settlements.sqlite'),
    operations: join(directory, 'business-operations.sqlite'),
    interlock: join(directory, 'lightning-payment-interlock.sqlite'),
  };
  const witness = await startWitness();
  const node = await createSimulatedLightningNode({ network: 'testnet' });
  const verifier = createX402LightningInvoiceVerifier(options.verifierEntries !== undefined ? { maximumEntries: options.verifierEntries } : {});
  const adapter = createX402PaymentProtocolAdapter({
    mappings: [{ scheme: 'exact', network: LNBTC_TESTNET, asset: 'BTC', unit: BTC, atomicScale: X402_LNBTC_ATOMIC_SCALE, bindingId: x402LightningBindingId('testnet'), paymentFlows: ['upfront'], maximumTimeoutSeconds: 3_600, rail: CONFIGURATION.railId }],
    bindings: [createX402LightningBinding({ network: 'testnet', verifier })],
    resolveRequest: ({ target }) => (target === TARGET ? { url: RESOURCE_URL, fields: options.fields ?? {} } : undefined),
    assets: ASSETS,
  });

  const governanceStore = createInMemoryGovernanceStore();
  const grantStore = createInMemoryBoundedGrantStore();
  const reservationLedger = createInMemoryExerciseControlLedger({ now: () => NOW });
  const eventStream = createInMemoryAuthorityEventStreamStore({ now: () => NOW });
  const governedIntents: unknown[] = [];
  const railInstructions: PaymentExecutionRequest[] = [];
  const invoiceLookups: { executionId: string; paymentHash: string; served: string | undefined }[] = [];
  // One per process, like the verifier: it reads through to whichever stores are composed now.
  // eslint-disable-next-line prefer-const
  let current: Composed;
  const executionInvoices = createX402LightningExecutionInvoices({
    organizationId: ORG,
    contexts: { readByGovernedRequestId: (organizationId, requestId) => createPaymentProtocolContextReader(current.operations).readByGovernedRequestId(organizationId, requestId) },
    decisions: { getByRequestId: (context, requestId) => current.world.rawStore.getByRequestId(context, requestId) },
  });
  const observedInvoices = {
    async invoiceFor(query: Parameters<typeof executionInvoices.invoices.invoiceFor>[0]) {
      const served = await executionInvoices.invoices.invoiceFor(query);
      invoiceLookups.push({ executionId: query.executionId, paymentHash: query.paymentHash, served });
      return served;
    },
  };
  let generation = 0;
  let history = 0;

  interface Composed {
    world: GovernedWorld;
    projector: AuthorityEventProjector;
    outcomes: ExecutionOutcomeStore & { close(): Promise<void> };
    resolutions: ExecutionResolutionStore & { close(): Promise<void> };
    settlements: PaymentSettlementStore & { close(): Promise<void> };
    operations: DurablePaymentBusinessOperationStore;
    interlock: DurableLightningPaymentInterlock;
    present: ReturnType<typeof createX402Presentation>['present'];
  }

  async function compose(): Promise<Composed> {
    generation += 1;
    // The business-operation store first: a refused (rolled-back) open leaves nothing else open.
    const operations = await createSqlitePaymentBusinessOperationStore(paths.operations, { now: ingressClock, freshness: { boundary: await boundaryFor(witness, ORG) } });
    const outcomes = await createSqliteExecutionOutcomeStore(paths.outcomes, { now: () => NOW });
    const resolutions = await createSqliteExecutionResolutionStore(paths.resolutions, { now: () => NOW });
    const settlements = await createSqlitePaymentSettlementStore(paths.settlements, { now: () => NOW });
    const interlock = await createSqliteLightningPaymentInterlock(paths.interlock, { scope: { railId: CONFIGURATION.railId, network: CONFIGURATION.network }, now: () => new Date().toISOString(), freshness: { boundary: await boundaryFor(witness, ORG) } });
    const projector = createAuthorityEventProjector({ organizationId: ORG, store: eventStream, grants: grantStore });
    const rail = createLightningRail({ configuration: CONFIGURATION, node, invoices: observedInvoices, interlock, now: () => TEST_NOW_MS });
    const observedRail: PaymentRail = {
      railId: rail.railId,
      execute: (request) => {
        railInstructions.push(request);
        return rail.execute(request);
      },
    };
    const world = buildGovernedWorld({
      store: governanceStore,
      grantStore,
      monetary: MONETARY,
      governance: GOVERNANCE,
      financialAuthority: monetaryAuthority(options.ceiling ?? CEILING, '0.1', BTC),
      exerciseControls: { policy: () => [], revalidateAuthorityBinding: () => NO_TEMPORAL_BOUND, reservationLedger },
      executionAdapter: createPaymentRailExecutionAdapter({ rail: observedRail, binding: BINDING }),
      executionOutcomes: outcomes,
      evidence: projector,
      kernelIdStart: generation * 1000,
    });
    const orchestrator = {
      organizationId: world.orchestrator.organizationId,
      govern: (who: Parameters<GovernedWorld['orchestrator']['govern']>[0], intent: unknown) => {
        governedIntents.push(intent);
        return world.orchestrator.govern(who, intent);
      },
    };
    const ingress = createPaymentProtocolIngress({ orchestrator, store: operations, adapters: [adapter], binding: BINDING, monetary: MONETARY, governance: GOVERNANCE, now: ingressClock });
    const { present } = createX402Presentation({ adapter, ingress, invoices: executionInvoices });
    return { world, projector, outcomes, resolutions, settlements, operations, interlock, present };
  }

  current = await compose();

  const settlementService = () => {
    const authority = createLightningFinalityAuthority({ configuration: CONFIGURATION, node: readOnlyLightningNode(node), interlock: current.interlock });
    return createPaymentSettlementService({
      outcomes: current.outcomes,
      resolutions: current.resolutions,
      governance: current.world.rawStore,
      payments: [BINDING],
      store: current.settlements,
      authorities: [authority],
      selectAuthority: (context) => (context.railId === CONFIGURATION.railId || context.rail === CONFIGURATION.railId ? authority.authorityId : 'none'),
      now: () => NOW,
    });
  };

  async function traceSources(): Promise<AuthorityTraceSources> {
    await drained(() => current.projector.health());
    const { world, outcomes, resolutions } = current;
    return {
      governance: { getByRequestId: (context, requestId) => world.rawStore.getByRequestId(context, requestId), verify: (context, evaluationId) => world.rawStore.verify(context, evaluationId) },
      grants: { kind: 'unauthenticated', read: (grantId: string) => grantStore.read(grantId) },
      reservations: { read: (reservationId: string) => reservationLedger.read(reservationId) },
      outcomes: { read: (context: { readonly organizationId: string }, executionId: string) => outcomes.read(context, executionId) },
      resolutions: { read: (context: { readonly organizationId: string }, executionId: string) => resolutions.read(context, executionId) },
      events: { readStreamBounded: (context: { readonly organizationId: string }, streamId: string, bound: { readonly maxEvents: number }) => eventStream.readStreamBounded(context, streamId, bound) },
    };
  }

  return {
    directory,
    paths,
    node,
    witness,
    adapter,
    governedIntents,
    railInstructions,
    invoiceLookups,
    present: (presentation) =>
      current.present(presentation.identity ?? IDENTITY, {
        businessOperationId: presentation.businessOperationId ?? 'pay08-checkout-1',
        protocol: 'x402',
        challenges: presentation.carrier,
        protectedRequest: presentation.protectedRequest ?? PROTECTED_GET,
        payment: { source: { accountId: GOVERNED_ACCOUNT }, purpose: 'vendor-payment' },
        envelope: { assertedContext: ALLOWED_INTENT.assertedContext },
      }),
    presentRaw: (identity, request) => current.present(identity, request as never),
    effects: () => node.calls.sendPayment,
    kernelEvaluations: () => history + current.world.kernelRequests.length,
    verifySettlement: (executionId) => settlementService().verifySettlement({ organizationId: ORG, executionId }),
    readSettlement: (executionId) => settlementService().readSettlement({ organizationId: ORG, executionId }),
    receipt: (executionId) => settlementService().receipt({ organizationId: ORG, executionId }),
    buildSignature: (request) =>
      createX402PaymentSignatureBuilder({ contexts: createPaymentProtocolContextReader(current.operations), settlements: settlementService(), proofs: lightningNodeProofSource(readOnlyLightningNode(node)) }).build({ organizationId: ORG, ...request }),
    async reconcile(executionId: string) {
      const authority = createLightningResolutionAuthority({ configuration: CONFIGURATION, node: readOnlyLightningNode(node), interlock: current.interlock });
      const { world, outcomes, resolutions, projector } = current;
      const service = createExecutionReconciliationService({
        outcomes: Object.freeze({ read: (context: { readonly organizationId: string }, id: string) => outcomes.read(context, id) }),
        resolutions,
        composition: snapshotResolutionAuthorities([authority], () => authority.authorityId, 'pay08'),
        claimed: async (scope, evaluationId, id) => {
          const record = await world.rawStore.getByEvaluationId({ system: false, organizationId: scope.organizationId }, evaluationId);
          return record !== null && record.request.organizationId === scope.organizationId && executionClaimRecorded(record, id);
        },
        capacity: Object.freeze({ reconcileResolution: (input: Parameters<typeof reservationLedger.reconcileResolution>[0]) => reservationLedger.reconcileResolution(input) }),
        governanceEvidence: (scope, evaluationId, id, resolution) =>
          createExecutionLedger(world.rawStore, { system: false, organizationId: scope.organizationId }, () => world.clock.now()).recordResolution(evaluationId, id, {
            certainty: resolution.certainty,
            ...(resolution.failure !== undefined ? { failure: resolution.failure } : {}),
            resolutionDigest: resolution.resolutionDigest,
          }),
        evidence: projector,
        now: () => NOW,
      });
      await service.adoptResolutionAuthority({ organizationId: ORG, executionId, authorityId: authority.authorityId });
      return service.reconcile({ organizationId: ORG, executionId });
    },
    async trace(requestId: string) {
      const build = await buildAuthorityTrace(await traceSources(), { system: false, organizationId: ORG }, requestId);
      if (build === null) return { verified: false, failed: ['not-found'], json: '' };
      const verification = authorityTraceVerificationOf(build, NOW);
      return {
        verified: verification.verified,
        path: build.trace.path,
        finalState: build.trace.finalState,
        failed: verification.checks.filter((check) => check.status === 'fail').map((check) => `${check.category}:${check.check}`),
        json: JSON.stringify(build.trace),
      };
    },
    operations: () => current.operations,
    contexts: () => createPaymentProtocolContextReader(current.operations),
    async restart() {
      await drained(() => current.projector.health());
      history += current.world.kernelRequests.length;
      await Promise.all([current.outcomes.close(), current.resolutions.close(), current.settlements.close(), current.operations.close(), current.interlock.close()]);
      current = await compose();
    },
    async backupOperations() {
      await drained(() => current.projector.health());
      history += current.world.kernelRequests.length;
      await Promise.all([current.outcomes.close(), current.resolutions.close(), current.settlements.close(), current.operations.close(), current.interlock.close()]);
      const backup = join(directory, `business-operations.backup-${String(Date.now())}.sqlite`);
      copyFileSync(paths.operations, backup);
      current = await compose();
      return backup;
    },
    async restoreOperations(backup: string) {
      await drained(() => current.projector.health());
      history += current.world.kernelRequests.length;
      await Promise.all([current.outcomes.close(), current.resolutions.close(), current.settlements.close(), current.operations.close(), current.interlock.close()]);
      for (const suffix of ['-wal', '-shm']) if (existsSync(`${paths.operations}${suffix}`)) rmSync(`${paths.operations}${suffix}`, { force: true });
      copyFileSync(backup, paths.operations);
      try {
        current = await compose();
        return { refused: false };
      } catch (error) {
        const code = typeof error === 'object' && error !== null && typeof (error as { code?: unknown }).code === 'string' ? (error as { code: string }).code : 'UNCODED';
        return { refused: true, code };
      }
    },
    async close() {
      await drained(() => current.projector.health()).catch(() => false);
      await Promise.allSettled([current.outcomes.close(), current.resolutions.close(), current.settlements.close(), current.operations.close(), current.interlock.close()]);
      await witness.close().catch(() => undefined);
    },
  };
}

/** The agent's network layer: what the agent sends, and how it turns a merchant response into an x402 carrier. */
export function carrierOf(response: MerchantResponse): { readonly status: number; readonly headers: readonly (readonly [string, string])[] } {
  return { status: response.status, headers: response.headers };
}

export function b64Json(json: unknown): string {
  return b64(json);
}
