import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';

import { createActionEnforcementPolicyPackIntegration } from '../../features/domain-policy-pack-runtime/integrations/action-enforcement-policy-pack-integration.js';
import { createPolicyPackRuntimeContext } from '../../features/domain-policy-pack-runtime/runtime/policy-pack-runtime-context.js';
import { createPolicyPackRuntime } from '../../features/domain-policy-pack-runtime/services/policy-pack-runtime.js';
import { TRADE_PARAMETER_DIMENSIONS, TRADE_PROFILE_PARAMETERS, TRADE_RESERVED_CONTEXT_KEYS, parseTradeDelegationPolicy, sealTradeActiveOrderSnapshot, sealTradeExposureSnapshot, type TradeDelegationPolicy, type TradeGovernedActionIntent, type TradingRiskAssessmentEvidence } from '../../features/trade-runtime/index.js';
import { createXrplDelegationVerifier } from '../../features/trade-runtime/rails/xrpl/index.js';
import { DELEGATION_POLICY, ISSUER, RLUSD, exposureReading, market, ordersReading, pairData, profileData } from '../../features/trade-runtime/tests/trade-risk-fixture.js';
import type { BoundCustomerIdentity } from '../customer-identity/index.js';
import type { GovernanceConfiguration } from '../governance-profile/index.js';
import { bootEnterpriseHost, type EnterpriseHost } from '../host/enterprise-host.js';
import { buildDurableAuthorityPayloads, DURABLE_FIXTURE_OPERATOR } from '../kernel-authority/fixtures/durable-authority.fixture.js';
import { TRADE_RISK_MATERIAL_FACTS, TRADE_RISK_SIMULATION_ACKNOWLEDGEMENT, createTradeRiskContext, tradeRiskPolicyRules, tradeRiskTrustedContextSources, type TradeRiskContext } from '../trade-risk-context/index.js';
import { TRADE_EXECUTION_SIMULATION_ACKNOWLEDGEMENT, XRPL_TRADE_EXECUTOR_ID, type TradeExecutionTrace } from '../xrpl-trade-execution/index.js';
import { createReferenceDelegatedOfferSignerService } from '../xrpl-trade-rail/reference/reference-delegated-offer-signer.js';
import { AGENT_KEY, AGENT_SUBJECT, ORG, POLICY_WRITER, TRUST_DOMAIN, Workspace, call, governedFile, secureEnv, type Reply } from './core04-host-fixture.js';
import { approverGrant } from './core05-host-fixture.js';
import { withDeploymentWitness } from './core07-freshness-fixture.js';
import { FakeXrplLedger, NETWORK, SIGNER_ID, SIGNER_TOKEN, pairWorld, type TradePairWorld } from './trade04c-execution-fixture.js';

/**
 * TRADE-04C — the governed trade executor on the **canonical shipped Host**
 * (`bootEnterpriseHost()`, production profile, SQLite everywhere, signed
 * grants, durable approvals and emergency control, the external CORE-07
 * witness, a real loopback listener), behind the real TRADE-03 edge and the
 * unchanged governed path:
 *
 *   gateway → TRADE-03 admitProposal → POST /api/governed-actions → Kernel (CORE-04 trade provider)
 *   → policy → CORE-05 → emergency → P10 / grant → P7 → P11 claim → **TRADE-04C executor**
 *   → TRADE-04B signer (loopback reference, over HTTP) → trade interlock (CORE-07) → reserved submission.
 *
 * Simulated, and labelled as such: the TRADE-03 market / exposure / order
 * source ports (sealed snapshots marked simulated, so the executor runs only
 * under its in-code simulation acknowledgement), and the XRPL ledger
 * (`FakeXrplLedger`, injected as the Host's trade ledger client — every
 * reservation records `injected-ledger-client`). The delegation port of the
 * TRADE-03 edge is TRADE-02's real verifier reading that same fake ledger.
 * No XRPL network is contacted and nothing is written to any ledger.
 */

export const ACTION = 'trade.offer-create';
export const PRINCIPAL = 'principal-mm-desk';
export const AGENT = 'actor-agent';
export const OWNER_ACTOR = 'actor-owner';
export const APPROVER = 'actor-trade-approver';
export const APPROVE_TRADE = 'approve-trade';
export const SIGNER_TOKEN_ENV = 'FRONTERA_TRADE04C_OFFER_SIGNER_TOKEN';
const SOURCE_IDS = Object.freeze({ risk: 'trade-risk-assessor', delegation: 'trade-delegation-verifier' });
const POLICY_VERSION = 'policy-pack-trade04c-v1';
const PROFILE_REFERENCE = 'mm-desk@3';
export const GOVERNANCE_PIN = Object.freeze({ id: 'governed-trading', version: 1 });
export const RLUSD_ID = `${NETWORK}:${RLUSD}/${ISSUER}`;
const XRP_ID = `${NETWORK}:XRP`;
const iso = (ms: number): string => new Date(ms).toISOString();

/** A tampering proxy in front of the reference signer: when `tamper` is set, it rewrites the transaction it forwards (Scenario E). */
export interface SignerProxy {
  readonly endpoint: string;
  tamper: ((transaction: Record<string, unknown>) => Record<string, unknown>) | undefined;
  signatures(): number;
  close(): Promise<void>;
}

export async function startSignerProxy(pair: TradePairWorld): Promise<SignerProxy> {
  const service = createReferenceDelegatedOfferSignerService({ signerId: SIGNER_ID, network: NETWORK, credential: SIGNER_TOKEN, keys: [{ ownerAccount: pair.owner, delegateSeed: pair.delegate.seed }], maximumFeeDrops: '1000', maximumLedgerHorizon: 200 });
  const proxy: { tamper: SignerProxy['tamper'] } = { tamper: undefined };
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      let body = Buffer.concat(chunks);
      if (proxy.tamper !== undefined && req.method === 'POST' && body.length > 0) {
        const request = JSON.parse(body.toString('utf8')) as Record<string, unknown>;
        body = Buffer.from(JSON.stringify({ ...request, transaction: proxy.tamper(request['transaction'] as Record<string, unknown>) }), 'utf8');
      }
      const answer = service.answer({ method: req.method ?? 'GET', path: req.url ?? '/', authorization: req.headers.authorization, contentType: req.headers['content-type'], body });
      res.writeHead(answer.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(answer.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  server.unref();
  return Object.assign(proxy, {
    endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    signatures: () => service.signatures(),
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  }) as SignerProxy;
}

/** Notional review above 1500 XRP; at most 5000 XRP; deviation ≤ 1000 bps. */
const hostPair = pairData({
  pairId: 'rlusd-xrp',
  base: { currency: RLUSD, issuer: ISSUER },
  referenceDeviation: { mode: 'enforce', maxBasisPoints: 1000, rule: 'symmetric' },
  notional: { mode: 'enforce', valuationAsset: { currency: 'XRP' }, maximum: '5000' },
  approval: { restricted: false, notionalAbove: '1500' },
});

function governance(resource: string): GovernanceConfiguration {
  return {
    parameterDimensions: TRADE_PARAMETER_DIMENSIONS,
    actionClasses: [{ id: 'place-order', actions: [ACTION] }],
    resourceClasses: [{ id: 'trading-account', resources: [resource] }],
    profiles: [
      {
        profileId: GOVERNANCE_PIN.id,
        version: GOVERNANCE_PIN.version,
        owner: ORG,
        provenance: { authoredBy: 'operator:trading-desk', approvedBy: 'operator:security' },
        actionClass: 'place-order',
        resourceClass: 'trading-account',
        parameters: TRADE_PROFILE_PARAMETERS,
        materialFacts: TRADE_RISK_MATERIAL_FACTS,
        relevantPolicies: ['trade04c-policy'],
        approval: { approverAction: APPROVE_TRADE, minimumApprovals: 1, requestTtlSeconds: 3600, approvalValiditySeconds: 900 },
      },
    ],
    reservedContextKeys: TRADE_RESERVED_CONTEXT_KEYS,
  };
}

function tradePolicy(resource: string) {
  const runtime = createPolicyPackRuntime(createPolicyPackRuntimeContext('2026-01-01T00:00:00.000Z'));
  runtime.registerPolicyPack(POLICY_WRITER, { id: 'trade04c-policy', name: 'TRADE-04C trading-risk policy', description: 'Synthetic', kind: 'data_boundary', domain: 'general_enterprise' });
  runtime.registerPolicyPackVersion(POLICY_WRITER, {
    id: POLICY_VERSION,
    policyPackId: 'trade04c-policy',
    version: '1.0.0',
    scope: { resourceScopes: [resource] },
    rules: tradeRiskPolicyRules({ policyPackVersionId: POLICY_VERSION, profileReference: PROFILE_REFERENCE, sourceIds: ['trade04c-source'] }),
    sources: [{ id: 'trade04c-source', type: 'internal_control', title: 'Synthetic', description: 'Synthetic', authority: 'demo_only' }],
    effectiveFrom: '2026-01-01T00:00:00.000Z',
    demoOnly: true,
    legalCompleteness: 'not_legal_advice',
  });
  runtime.activatePolicyPackVersion(POLICY_WRITER, POLICY_VERSION);
  return createActionEnforcementPolicyPackIntegration(runtime);
}

export interface TradeHostOptions {
  /** Configure the section, but compose no attested-proposal source (refusal test). */
  readonly omitAttestation?: boolean;
  readonly sectionOverrides?: Record<string, unknown>;
  readonly envOverrides?: Record<string, string | undefined>;
  readonly fileOverrides?: Record<string, unknown>;
  /** The signer endpoint to configure (default: a tampering proxy over the reference signer). */
  readonly signerEndpoint?: string;
  readonly dir?: string;
  readonly ledger?: FakeXrplLedger;
  readonly pair?: TradePairWorld;
}

export interface TradeHost {
  readonly host: EnterpriseHost;
  readonly baseUrl: string;
  readonly ledger: FakeXrplLedger;
  readonly pair: TradePairWorld;
  readonly resource: string;
  readonly edge: TradeRiskContext;
  readonly signer: SignerProxy;
  readonly traces: TradeExecutionTrace[];
  readonly assessments: TradingRiskAssessmentEvidence[];
  readonly dir: string;
}

export function tradeExecutionSection(pair: TradePairWorld, signerEndpoint: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tradeAction: ACTION,
    network: NETWORK,
    endpoint: 'wss://fake-ledger.invalid',
    pairs: [{ ownerAccount: pair.owner, delegateAccount: pair.delegate.address, signingPublicKey: pair.delegate.publicKey }],
    signer: { endpoint: signerEndpoint, signerId: SIGNER_ID, credential: { kind: 'bearer', tokenEnv: SIGNER_TOKEN_ENV }, timeoutMs: 5_000 },
    delegation: { sourceId: 'trade-execution-delegation', maxAgeSeconds: 10 },
    feeDrops: '12',
    maximumFeeDrops: '100',
    lastLedgerOffset: 20,
    requestTimeoutMs: 1_000,
    finalityTimeoutMs: 3_000,
    pollIntervalMs: 1,
    ...overrides,
  };
}

export function tradeFile(pair: TradePairWorld, signerEndpoint: string, options: Pick<TradeHostOptions, 'sectionOverrides' | 'fileOverrides'> = {}): Record<string, unknown> {
  const resource = `${NETWORK}:${pair.owner}`;
  return governedFile({
    customerPrincipals: [{ principalId: PRINCIPAL, externalSubject: AGENT_SUBJECT, apiKeyEnv: 'FRONTERA_TEST_AGENT_KEY' }],
    governance: governance(resource),
    trustedContext: { maxFutureSkewSeconds: 0, sources: tradeRiskTrustedContextSources({ organizationId: ORG, sourceIds: SOURCE_IDS, riskMaxAgeSeconds: 30, delegationMaxAgeSeconds: 10 }) },
    monetary: { assets: [{ assetId: XRP_ID, scale: 6 }, { assetId: RLUSD_ID, scale: 15 }], financialActions: [ACTION] },
    routes: [{ action: ACTION, adapterId: XRPL_TRADE_EXECUTOR_ID }],
    xrplTradeExecution: tradeExecutionSection(pair, signerEndpoint, options.sectionOverrides),
    ...options.fileOverrides,
  });
}

/** Boots the shipped Host composed for governed trade execution. Throws whatever boot refuses with. */
export async function bootTradeHost(workspace: Workspace, options: TradeHostOptions = {}): Promise<TradeHost> {
  const ledger = options.ledger ?? new FakeXrplLedger();
  const pair = options.pair ?? pairWorld(ledger);
  const resource = `${NETWORK}:${pair.owner}`;
  const signer = await startSignerProxy(pair);
  const traces: TradeExecutionTrace[] = [];
  const assessments: TradingRiskAssessmentEvidence[] = [];
  const policy = parseTradeDelegationPolicy(DELEGATION_POLICY) as TradeDelegationPolicy;
  // TRADE-03's delegation port: TRADE-02's own verifier, reading the same (fake) ledger the executor re-reads,
  // on the true clock — no back-dating (the F-1 correction assesses at the post-collection reliance instant).
  const verifier = createXrplDelegationVerifier({ port: { serverInfo: async () => ledger.serverInfo(), ledgerEntryDelegate: async (request) => ledger.ledgerEntry({ ...request }) }, network: NETWORK, clock: () => iso(Date.now()), maxValidatedLedgerAgeSeconds: 10, policy });
  const now = Date.now();
  const edge = createTradeRiskContext({
    organizationId: ORG,
    action: ACTION,
    profile: profileData({ organizationId: ORG, effectiveFrom: iso(now - 86_400_000), expiresAt: iso(now + 30 * 86_400_000), ownerAccounts: [pair.owner], delegateAccounts: [pair.delegate.address], pairs: [hostPair] }),
    ports: {
      market: { read: async (request) => request.quotes.map((quote) => market({ organizationId: ORG, network: request.network as typeof NETWORK, base: request.base, quote, observedAt: iso(Date.now()) })) },
      exposure: { read: async (request) => sealTradeExposureSnapshot(exposureReading({ organizationId: ORG, ownerAccount: request.ownerAccount, observedAt: iso(Date.now()) })) },
      activeOrders: { read: async (request) => sealTradeActiveOrderSnapshot(ordersReading({ organizationId: ORG, scopeKey: request.scopeKey, observedAt: iso(Date.now()) })) },
      delegation: { verify: (request) => verifier.verify(request) },
    },
    sourceIds: SOURCE_IDS,
    bindingSeconds: 30,
    clock: () => iso(Date.now()),
    simulation: TRADE_RISK_SIMULATION_ACKNOWLEDGEMENT,
    onAssessment: (record) => assessments.push(record),
  });
  const dir = options.dir ?? workspace.dir();
  const env = {
    ...secureEnv(dir, tradeFile(pair, options.signerEndpoint ?? signer.endpoint, options)),
    AOC_ENTERPRISE_XRPL_TRADE_INTERLOCK_SQLITE_PATH: join(dir, 'xrpl-trade-sequence-interlock.sqlite'),
    [SIGNER_TOKEN_ENV]: SIGNER_TOKEN,
    ...options.envOverrides,
  };
  let host: EnterpriseHost;
  try {
    host = workspace.track(
      await bootEnterpriseHost({
        env: await withDeploymentWitness(env),
        contextProvider: edge.provider,
        policyPackProvider: tradePolicy(resource),
        xrplTradeExecution: {
          attested: options.omitAttestation === true ? undefined : edge.attested,
          ledgerClient: ledger.factory(),
          simulation: TRADE_EXECUTION_SIMULATION_ACKNOWLEDGEMENT,
          onTrace: (trace) => traces.push(trace),
        },
      }),
    );
  } catch (error) {
    await signer.close();
    throw error;
  }
  const { port } = await host.listen();
  await provisionTrading(host, resource);
  // Past the trade executor's restart quarantine (it started at boot).
  ledger.passQuarantine();
  return { host, baseUrl: `http://127.0.0.1:${port}`, ledger, pair, resource, edge, signer, traces, assessments, dir };
}

/** P10 constraints on the owner's authority: per-order ceilings in the traded assets. */
const CONSTRAINTS = [
  { type: 'max_amount', currency: XRP_ID, value: '20000' },
  { type: 'spending_limit', limitId: 'xrp-lifetime', currency: XRP_ID, maximum: '10000000', window: { kind: 'lifetime' } },
  { type: 'max_amount', currency: RLUSD_ID, value: '5000' },
  { type: 'spending_limit', limitId: 'rlusd-lifetime', currency: RLUSD_ID, maximum: '10000000', window: { kind: 'lifetime' } },
];

async function provisionTrading(host: EnterpriseHost, resource: string): Promise<void> {
  const service = host.enterprise.kernelAuthorityProvisioning;
  assert.ok(service !== undefined);
  const payloads = buildDurableAuthorityPayloads(ORG, TRUST_DOMAIN);
  const operator = DURABLE_FIXTURE_OPERATOR;
  await service.provisionActor(operator, payloads.issuerActor);
  await service.provisionTrustDomain(operator, payloads.trustDomain);
  await service.provisionRootIssuer(operator, payloads.rootIssuer);
  await service.provisionActor(operator, { ...payloads.ownerActor, actorId: OWNER_ACTOR, displayName: 'Owner', externalSubject: { system: 'core04-app', subjectId: 'owner-1' } });
  await service.provisionAuthorityGrant(operator, { ...payloads.authorityGrant, authorityGrantId: 'authority-grant-trading', subjectActorId: OWNER_ACTOR, actions: [ACTION], resourceScopes: [resource], constraints: CONSTRAINTS as never });
  await service.provisionActor(operator, { ...payloads.agentActor, actorId: AGENT, displayName: 'Trading engine', externalSubject: AGENT_SUBJECT });
  await service.provisionPassport(operator, { ...payloads.passport, passportId: `passport-${AGENT}`, subjectActorId: AGENT });
  await service.provisionCapabilityToken(operator, { ...payloads.capabilityToken, capabilityTokenId: `cap-${AGENT}`, subjectActorId: AGENT, principalActorId: OWNER_ACTOR, issuerActorId: OWNER_ACTOR, actions: [ACTION], resourceScopes: [resource] });
  await service.provisionDelegationGrant(operator, { ...payloads.delegationGrant, delegationGrantId: 'delegation-trading', delegatorActorId: OWNER_ACTOR, delegateActorId: AGENT, sourceAuthorityGrantId: 'authority-grant-trading', actions: [ACTION], resourceScopes: [resource] });
  await service.provisionActor(operator, { ...payloads.ownerActor, actorId: APPROVER, displayName: 'Trade approver', externalSubject: { system: 'core05-approvals', subjectId: APPROVER } });
  await approverGrant(host, APPROVER, APPROVE_TRADE, resource, `authority-grant-${APPROVER}`);
}

let counter = 0;

/** A canonical proposal for the host's pair: sell `value` RLUSD for `drops` (2 XRP per RLUSD by default). */
export function proposalFor(trade: TradeHost, value = '100', drops = String(BigInt(value.split('.')[0]!) * 2_000_000n), overrides: Record<string, unknown> = {}): Record<string, unknown> {
  counter += 1;
  const id = `trade04c-host-${process.pid}-${counter}`;
  return {
    schema: 'frontera.trade-proposal.v1',
    organizationId: ORG,
    principalId: PRINCIPAL,
    requestId: `${id}-req`,
    idempotencyKey: id,
    network: NETWORK,
    ownerAccount: trade.pair.owner,
    delegateAccount: trade.pair.delegate.address,
    permission: 'OfferCreate',
    takerGets: { currency: RLUSD, issuer: ISSUER, value },
    takerPays: { currency: 'XRP', drops },
    flags: ['passive'],
    requestedValiditySeconds: 60,
    ...overrides,
  };
}

async function identityOf(trade: TradeHost): Promise<BoundCustomerIdentity> {
  const admission = trade.host.enterprise.customerIdentityAdmission;
  assert.ok(admission !== undefined);
  const result = await admission.admit({ authorizationHeader: `Bearer ${AGENT_KEY}` });
  assert.equal(result.status, 'bound', JSON.stringify(result));
  return (result as { readonly identity: BoundCustomerIdentity }).identity;
}

export async function admit(trade: TradeHost, raw: Record<string, unknown>): Promise<TradeGovernedActionIntent> {
  const admission = trade.edge.admitProposal(await identityOf(trade), raw, { expectedGovernanceProfile: GOVERNANCE_PIN });
  assert.ok(admission.admitted, JSON.stringify(admission));
  return admission.intent;
}

export async function post(trade: TradeHost, intent: TradeGovernedActionIntent | Record<string, unknown>): Promise<Reply> {
  return call(trade.baseUrl, 'POST', '/api/governed-actions', { authorization: `Bearer ${AGENT_KEY}`, body: intent });
}

/** Admit through the TRADE-03 edge, then submit through the governed path. */
export async function governTrade(trade: TradeHost, raw: Record<string, unknown>): Promise<Reply> {
  return post(trade, await admit(trade, raw));
}

export const ADMIN_BEARER = 'Bearer FRONTERA_CORE04_ADMIN_KEY_SENTINEL_2b8e4f6a1c9d0e73';
export { Workspace };
