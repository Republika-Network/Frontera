import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { contextObservationProvenanceDigest, type ContextFactObservation, type ContextResolutionQuery, type ContextResolverPort } from '../../features/context-resolution-runtime/index.js';
import { createActionEnforcementPolicyPackIntegration } from '../../features/domain-policy-pack-runtime/integrations/action-enforcement-policy-pack-integration.js';
import type { PolicyPackRule } from '../../features/domain-policy-pack-runtime/domain/policy-pack-rule.js';
import { createPolicyPackRuntimeContext } from '../../features/domain-policy-pack-runtime/runtime/policy-pack-runtime-context.js';
import { createPolicyPackRuntime } from '../../features/domain-policy-pack-runtime/services/policy-pack-runtime.js';
import {
  TRADE_PARAMETER_DIMENSIONS,
  TRADE_PARAMETER_DIMENSION_IDS as D,
  TRADE_PROFILE_PARAMETERS,
  TRADE_RESERVED_CONTEXT_KEYS,
  TRADE_RISK_FACT_CLASSES as F,
  assessTradeDelegation,
  compileTradeProposal,
  createTradeGovernanceBinding,
  parseTradeDelegationPolicy,
  sealTradeActiveOrderSnapshot,
  sealTradeExposureSnapshot,
  tradeDelegateEntryIndex,
  type TradeDelegationPolicy,
  type TradeDelegationVerificationRequest,
  type TradeGovernedActionIntent,
  type TradingRiskAssessmentEvidence,
} from '../../features/trade-runtime/index.js';
import {
  DELEGATION_POLICY,
  ISSUER,
  ISSUER_B,
  OWNER,
  RLUSD,
  STRANGER_DELEGATE,
  STRANGER_OWNER,
  exposureReading,
  grantedObservation,
  market,
  ordersReading,
  pairData,
  profileData,
  proposal as fixtureProposal,
} from '../../features/trade-runtime/tests/trade-risk-fixture.js';
import type { BoundCustomerIdentity } from '../customer-identity/index.js';
import type { GovernanceConfiguration } from '../governance-profile/index.js';
import { buildDurableAuthorityPayloads, DURABLE_FIXTURE_OPERATOR } from '../kernel-authority/fixtures/durable-authority.fixture.js';
import {
  TRADE_RISK_ABSENCE_SENSITIVE_RULES,
  TRADE_RISK_ADMISSION_REFUSALS as AR,
  TRADE_RISK_MATERIAL_FACTS,
  TRADE_RISK_SIMULATION_ACKNOWLEDGEMENT,
  TradeRiskContextConfigurationError,
  createTradeRiskContext,
  tradeRiskPolicyRules,
  tradeRiskTrustedContextSources,
  type TradeRiskContext,
  type TradeRiskSourcePorts,
} from '../trade-risk-context/index.js';
import { ADMIN, AGENT, AGENT_KEY, AGENT_SUBJECT, ORG, OWNER as OWNER_ACTOR, POLICY_WRITER, TRUST_DOMAIN, Workspace, boot, call, governedFile, secureEnv, type Booted, type Reply } from './core04-host-fixture.js';

/**
 * TRADE-03 (with K1 and K2) — trading-risk governance on the **canonical
 * shipped Host** (`bootEnterpriseHost()`, production profile, SQLite
 * everywhere, signed grants, durable approvals and emergency controls, a real
 * loopback listener), through the **approved composition edge**
 * `src/enterprise/trade-risk-context/` and the unchanged governed path:
 *
 *   gateway → admitProposal(BoundCustomerIdentity, proposal) → compiled intent
 *   POST /api/governed-actions (intent) → envelope (P9, CORE-03) → Kernel →
 *   CORE-04 (edge provider: one-shot binding, fresh trusted reads, assessment,
 *   projection) → policy (bindings) → CORE-05 → emergency → P10 / grant → P7 →
 *   recording adapter.
 *
 * What is simulated: the **source ports** only — fake trusted market,
 * exposure and order sources (sealed snapshots marked `simulated`) and a fake
 * XLS-75 read assessed by TRADE-02's own assessor. The edge, the Host, the
 * Kernel, policy, approvals, emergency control, P9, P10 and P7 are the shipped
 * code. This is architectural enforcement, **not** a live-trading
 * qualification. Nothing reads a ledger or market, signs or submits; the
 * adapter is the fixture's recording adapter and only its call count matters.
 */

const ACTION = 'trade.offer-create';
const NETWORK = 'xrp-ledger-testnet';
const RESOURCE = `${NETWORK}:${OWNER}`;
const STRANGER_RESOURCE = `${NETWORK}:${STRANGER_OWNER}`;
const PRINCIPAL = 'principal-agent';
const PRINCIPAL_B = 'principal-agent-b';
const AGENT_B = 'actor-agent-b';
const AGENT_B_SUBJECT = { system: 'core04-app', subjectId: 'agent-2' } as const;
const AGENT_B_KEY = 'FRONTERA_TRADE03_AGENT_B_KEY_SENTINEL_5d27c1';
const XRP_ID = `${NETWORK}:XRP`;
const TOKEN = 'USD';
const TOKEN_RECORD = Object.freeze({ currency: TOKEN, issuer: ISSUER });
const TOKEN_ID = `${NETWORK}:${TOKEN}/${ISSUER}`;
const TOKEN_B_ID = `${NETWORK}:${TOKEN}/${ISSUER_B}`;
/** K2: a 40-hex-digit XRP Ledger currency's asset id — 93 bytes, above the former 64-byte P7 bound. */
const RLUSD_ID = `${NETWORK}:${RLUSD}/${ISSUER}`;
const SOURCE_IDS = Object.freeze({ risk: 'trade-risk-assessor', delegation: 'trade-delegation-verifier' });
const POLICY_VERSION = 'policy-pack-trade03-v1';
const PROFILE_REFERENCE = 'mm-desk@3';
const GOVERNANCE_PIN = Object.freeze({ id: 'governed-trading', version: 1 });
const BINDING = createTradeGovernanceBinding({ action: ACTION });

const NOW = Date.now();
const iso = (ms: number): string => new Date(ms).toISOString();

// ── Trusted configuration ────────────────────────────────────────────────────

/** A pair on the Host: deviation ≤ 1000 bps, notional ≤ 5000 XRP, review above 1500 XRP of notional. */
const hostPair = (base: Record<string, unknown>, pairId: string): Record<string, unknown> =>
  pairData({
    pairId,
    base,
    referenceDeviation: { mode: 'enforce', maxBasisPoints: 1000, rule: 'symmetric' },
    notional: { mode: 'enforce', valuationAsset: { currency: 'XRP' }, maximum: '5000' },
    approval: { restricted: false, notionalAbove: '1500' },
  });

const PROFILE = profileData({
  organizationId: ORG,
  effectiveFrom: iso(NOW - 86_400_000),
  expiresAt: iso(NOW + 30 * 86_400_000),
  ownerAccounts: [OWNER, STRANGER_OWNER],
  pairs: [hostPair(TOKEN_RECORD, 'usd-xrp'), hostPair({ currency: RLUSD, issuer: ISSUER }, 'rlusd-xrp')],
});

const GOVERNANCE: GovernanceConfiguration = {
  parameterDimensions: TRADE_PARAMETER_DIMENSIONS,
  actionClasses: [{ id: 'place-order', actions: [ACTION] }],
  resourceClasses: [{ id: 'trading-account', resources: [RESOURCE, STRANGER_RESOURCE] }],
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
      relevantPolicies: ['trade03-policy'],
      approval: { approverAction: 'approve-trade', minimumApprovals: 1, requestTtlSeconds: 3600, approvalValiditySeconds: 900 },
    },
  ],
  reservedContextKeys: TRADE_RESERVED_CONTEXT_KEYS,
};

const TRUSTED_CONTEXT = {
  maxFutureSkewSeconds: 0,
  sources: [
    ...tradeRiskTrustedContextSources({ organizationId: ORG, sourceIds: SOURCE_IDS, riskMaxAgeSeconds: 30, delegationMaxAgeSeconds: 10 }),
    { sourceId: `${SOURCE_IDS.risk}-2`, kind: 'risk_engine', name: 'Second assessor (conflict tests)', trustClass: 'authoritative', organizationId: ORG, attests: [{ factClass: F.assessedProposal, maxAgeSeconds: 30 }] },
  ],
};

function tradePolicy(rules: readonly PolicyPackRule[]) {
  const runtime = createPolicyPackRuntime(createPolicyPackRuntimeContext('2026-01-01T00:00:00.000Z'));
  runtime.registerPolicyPack(POLICY_WRITER, { id: 'trade03-policy', name: 'TRADE-03 trading-risk policy', description: 'Synthetic', kind: 'data_boundary', domain: 'general_enterprise' });
  runtime.registerPolicyPackVersion(POLICY_WRITER, {
    id: POLICY_VERSION,
    policyPackId: 'trade03-policy',
    version: '1.0.0',
    scope: { resourceScopes: [RESOURCE, STRANGER_RESOURCE] },
    rules,
    sources: [{ id: 'trade03-source', type: 'internal_control', title: 'Synthetic', description: 'Synthetic', authority: 'demo_only' }],
    effectiveFrom: '2026-01-01T00:00:00.000Z',
    demoOnly: true,
    legalCompleteness: 'not_legal_advice',
  });
  runtime.activatePolicyPackVersion(POLICY_WRITER, POLICY_VERSION);
  return createActionEnforcementPolicyPackIntegration(runtime);
}

const RULES = tradeRiskPolicyRules({ policyPackVersionId: POLICY_VERSION, profileReference: PROFILE_REFERENCE, sourceIds: ['trade03-source'] });

// ── Fake trusted source ports (the only simulated part) ─────────────────────

interface World {
  marketAgeSeconds: number;
  delegation: 'granted' | 'unavailable' | 'throws';
  marketThrows: boolean;
}

function freshWorld(): World {
  return { marketAgeSeconds: 2, delegation: 'granted', marketThrows: false };
}

function fakePorts(world: World): TradeRiskSourcePorts {
  const policy = parseTradeDelegationPolicy(DELEGATION_POLICY) as TradeDelegationPolicy;
  return {
    market: {
      async read(request) {
        if (world.marketThrows) throw new Error('market feed down');
        return request.quotes.map((quote) =>
          market({ organizationId: ORG, network: request.network as typeof NETWORK, base: request.base, quote, observedAt: iso(Date.parse(request.at) - world.marketAgeSeconds * 1000) }),
        );
      },
    },
    exposure: {
      async read(request) {
        return sealTradeExposureSnapshot(exposureReading({ organizationId: ORG, ownerAccount: request.ownerAccount, observedAt: iso(Date.parse(request.at) - 2000) }));
      },
    },
    activeOrders: {
      async read(request) {
        return sealTradeActiveOrderSnapshot(ordersReading({ organizationId: ORG, scopeKey: request.scopeKey, observedAt: iso(Date.parse(request.at) - 2000) }));
      },
    },
    delegation: {
      async verify(request: TradeDelegationVerificationRequest) {
        if (world.delegation === 'throws') throw new Error('ledger reader down');
        const read =
          world.delegation === 'unavailable'
            ? { outcome: 'unavailable' as const, failure: 'TRANSPORT_UNAVAILABLE' }
            : {
                outcome: 'observed' as const,
                observation: grantedObservation({ owner: request.ownerAccount, delegate: request.delegateAccount, entryIndex: tradeDelegateEntryIndex(request.ownerAccount, request.delegateAccount), observedAt: iso(Date.now()) }) as never,
              };
        return assessTradeDelegation({ request, policy, read, assessedAt: iso(Date.now()) });
      },
    },
  };
}

/** A wrapper standing in for a broken or hostile provider (CORE-04 boundary tests only). */
interface Tamperable {
  readonly provider: ContextResolverPort;
  tamper: ((observations: ContextFactObservation[], query: ContextResolutionQuery) => ContextFactObservation[]) | undefined;
}

function tamperable(inner: ContextResolverPort): Tamperable {
  const wrapper: Tamperable = {
    tamper: undefined,
    provider: {
      async resolveContext(query) {
        const output = await inner.resolveContext(query);
        const change = wrapper.tamper;
        return change === undefined ? output : { observations: change([...output.observations], query) };
      },
    },
  };
  return wrapper;
}

function resealed(observation: ContextFactObservation, change: Partial<ContextFactObservation>): ContextFactObservation {
  const { provenanceDigest: _digest, ...rest } = { ...observation, ...change };
  return { ...rest, provenanceDigest: contextObservationProvenanceDigest({ ...rest, reference: rest.reference ?? '' }) };
}

// ── Hosts ────────────────────────────────────────────────────────────────────

/** P10, the owner's existing authority: per-order ceilings and lifetime limits per asset. TRADE never widens them. */
const CONSTRAINTS = [
  { type: 'max_amount', currency: XRP_ID, value: '2000' },
  { type: 'spending_limit', limitId: 'xrp-lifetime', currency: XRP_ID, maximum: '1000000', window: { kind: 'lifetime' } },
  { type: 'max_amount', currency: TOKEN_ID, value: '500' },
  { type: 'spending_limit', limitId: 'token-lifetime', currency: TOKEN_ID, maximum: '1000000', window: { kind: 'lifetime' } },
  { type: 'max_amount', currency: TOKEN_B_ID, value: '500' },
  { type: 'spending_limit', limitId: 'token-b-lifetime', currency: TOKEN_B_ID, maximum: '1000000', window: { kind: 'lifetime' } },
  { type: 'max_amount', currency: RLUSD_ID, value: '1000' },
  { type: 'spending_limit', limitId: 'rlusd-lifetime', currency: RLUSD_ID, maximum: '1000000', window: { kind: 'lifetime' } },
];

async function provisionTrading(booted: Booted): Promise<void> {
  const service = booted.host.enterprise.kernelAuthorityProvisioning;
  assert.ok(service !== undefined);
  const payloads = buildDurableAuthorityPayloads(ORG, TRUST_DOMAIN);
  const operator = DURABLE_FIXTURE_OPERATOR;
  const resources = [RESOURCE, STRANGER_RESOURCE];
  await service.provisionActor(operator, payloads.issuerActor);
  await service.provisionTrustDomain(operator, payloads.trustDomain);
  await service.provisionRootIssuer(operator, payloads.rootIssuer);
  await service.provisionActor(operator, { ...payloads.ownerActor, actorId: OWNER_ACTOR, displayName: 'Owner', externalSubject: { system: 'core04-app', subjectId: 'owner-1' } });
  await service.provisionAuthorityGrant(operator, { ...payloads.authorityGrant, authorityGrantId: 'authority-grant-trading', subjectActorId: OWNER_ACTOR, actions: [ACTION], resourceScopes: resources, constraints: CONSTRAINTS as never });
  for (const [actorId, subject, label] of [
    [AGENT, AGENT_SUBJECT, 'a'],
    [AGENT_B, AGENT_B_SUBJECT, 'b'],
  ] as const) {
    await service.provisionActor(operator, { ...payloads.agentActor, actorId, displayName: `Trading engine ${label}`, externalSubject: subject });
    await service.provisionPassport(operator, { ...payloads.passport, passportId: `passport-${actorId}`, subjectActorId: actorId });
    await service.provisionCapabilityToken(operator, { ...payloads.capabilityToken, capabilityTokenId: `cap-${actorId}`, subjectActorId: actorId, principalActorId: OWNER_ACTOR, issuerActorId: OWNER_ACTOR, actions: [ACTION], resourceScopes: resources });
    await service.provisionDelegationGrant(operator, {
      ...payloads.delegationGrant,
      delegationGrantId: `delegation-trading-${label}`,
      delegatorActorId: OWNER_ACTOR,
      delegateActorId: actorId,
      sourceAuthorityGrantId: 'authority-grant-trading',
      actions: [ACTION],
      resourceScopes: resources,
    });
  }
}

function tradingFile(): Record<string, unknown> {
  return governedFile({
    customerPrincipals: [
      { principalId: PRINCIPAL, externalSubject: AGENT_SUBJECT, apiKeyEnv: 'FRONTERA_TEST_AGENT_KEY' },
      { principalId: PRINCIPAL_B, externalSubject: AGENT_B_SUBJECT, apiKeyEnv: 'FRONTERA_TEST_AGENT_B_KEY' },
    ],
    governance: GOVERNANCE,
    trustedContext: TRUSTED_CONTEXT,
    monetary: {
      assets: [
        { assetId: XRP_ID, scale: 6 },
        { assetId: TOKEN_ID, scale: 15 },
        { assetId: TOKEN_B_ID, scale: 15 },
        { assetId: RLUSD_ID, scale: 15 },
      ],
      financialActions: [ACTION],
    },
    routes: [{ action: ACTION, adapterId: 'test.recording' }],
  });
}

interface TradeHost {
  readonly booted: Booted;
  readonly edge: TradeRiskContext;
  readonly world: World;
  readonly wrapper: Tamperable;
  readonly evidence: TradingRiskAssessmentEvidence[];
}

const workspace = new Workspace();

async function bootTradeHost(rules: readonly PolicyPackRule[], withEdge = true): Promise<TradeHost> {
  const world = freshWorld();
  const evidence: TradingRiskAssessmentEvidence[] = [];
  const edge = createTradeRiskContext({
    organizationId: ORG,
    action: ACTION,
    profile: PROFILE,
    ports: fakePorts(world),
    sourceIds: SOURCE_IDS,
    bindingSeconds: 30,
    clock: () => iso(Date.now()),
    simulation: TRADE_RISK_SIMULATION_ACKNOWLEDGEMENT,
    onAssessment: (record) => evidence.push(record),
  });
  const wrapper = tamperable(edge.provider);
  const env = { ...secureEnv(workspace.dir(), tradingFile()), FRONTERA_TEST_AGENT_B_KEY: AGENT_B_KEY };
  const booted = await boot(workspace, env, { ...(withEdge ? { context: { provider: wrapper.provider, set() {}, queries: [] } } : {}), policy: tradePolicy(rules) });
  await provisionTrading(booted);
  return { booted, edge, world, wrapper, evidence };
}

let main: TradeHost;
/** No absence-sensitive policy rule: the material-fact gate alone. */
let gate: TradeHost;

before(async () => {
  main = await bootTradeHost(RULES);
  gate = await bootTradeHost(RULES.filter((entry) => !TRADE_RISK_ABSENCE_SENSITIVE_RULES.has(entry.id)));
});
after(() => workspace.cleanup());

// ── Requests ─────────────────────────────────────────────────────────────────

let sequence = 0;
const nextId = (label: string): string => `trade03-${label}-${(sequence += 1)}`;

function order(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const id = nextId('offer');
  return fixtureProposal({ organizationId: ORG, principalId: PRINCIPAL, requestId: `${id}-req`, idempotencyKey: id, takerGets: { ...TOKEN_RECORD, value: '100' }, ...overrides });
}
const sellToken = (value: string, drops: string, overrides: Record<string, unknown> = {}) => order({ takerGets: { ...TOKEN_RECORD, value }, takerPays: { currency: 'XRP', drops }, ...overrides });
/** What an applicant could compile on its own — never admitted. */
const selfCompiled = (raw: Record<string, unknown>): TradeGovernedActionIntent => compileTradeProposal(raw, BINDING, { organizationId: ORG, principalId: PRINCIPAL }, { expectedGovernanceProfile: GOVERNANCE_PIN }).intent;

async function identityOf(host: TradeHost, key: string): Promise<BoundCustomerIdentity> {
  const admission = host.booted.host.enterprise.customerIdentityAdmission;
  assert.ok(admission !== undefined);
  const result = await admission.admit({ authorizationHeader: `Bearer ${key}` });
  assert.equal(result.status, 'bound', JSON.stringify(result));
  return (result as { readonly identity: BoundCustomerIdentity }).identity;
}

async function admit(host: TradeHost, raw: Record<string, unknown>, key = AGENT_KEY): Promise<TradeGovernedActionIntent> {
  const admission = host.edge.admitProposal(await identityOf(host, key), raw, { expectedGovernanceProfile: GOVERNANCE_PIN });
  assert.ok(admission.admitted, JSON.stringify(admission));
  return admission.intent;
}

async function post(host: TradeHost, intent: TradeGovernedActionIntent | Record<string, unknown>, key = AGENT_KEY): Promise<{ readonly reply: Reply; readonly calls: number }> {
  const before = host.booted.calls.length;
  const reply = await call(host.booted.baseUrl, 'POST', '/api/governed-actions', { authorization: `Bearer ${key}`, body: intent });
  return { reply, calls: host.booted.calls.length - before };
}

/** Admit through the edge as agent A, then submit — the intent as returned, or as `mutate` rewrites it. */
async function trade(host: TradeHost, raw: Record<string, unknown>, mutate?: (intent: TradeGovernedActionIntent) => Record<string, unknown>) {
  const intent = await admit(host, raw);
  return post(host, mutate === undefined ? intent : mutate(intent));
}

const codesOf = (reply: Reply): readonly string[] => (reply.body['reasonCodes'] as readonly string[] | undefined) ?? [];

async function committedText(host: TradeHost, reply: Reply): Promise<string> {
  const decision = reply.body['decision'] as { readonly evaluationId?: string } | undefined;
  if (decision?.evaluationId === undefined) return reply.text;
  return JSON.stringify(await host.booted.host.enterprise.persistence.getByEvaluationId({ system: false, organizationId: ORG }, decision.evaluationId));
}

async function assertPolicyDenied(host: TradeHost, reply: Reply, ruleCode: string): Promise<void> {
  assert.equal(reply.body['status'], 'denied', reply.text);
  assert.ok(codesOf(reply).includes('DOMAIN_POLICY_DENIED'), reply.text);
  const committed = await committedText(host, reply);
  assert.ok(committed.includes(ruleCode), `the committed decision records ${ruleCode}`);
}

interface Unsatisfied {
  readonly key: string;
  readonly status: string;
  readonly refusalReasons?: readonly string[];
}

/** Denied, and the Trusted Context Boundary itself recorded the material-fact gap. */
async function assertBoundaryHeld(host: TradeHost, reply: Reply, expected: { readonly status: string; readonly key?: string }): Promise<void> {
  assert.equal(reply.body['status'], 'denied', reply.text);
  const record = JSON.parse(await committedText(host, reply)) as { readonly evaluation?: { readonly resultPayload?: { readonly context?: { readonly unsatisfiedRequirements?: readonly Unsatisfied[] } } } };
  const gaps = record.evaluation?.resultPayload?.context?.unsatisfiedRequirements ?? [];
  assert.ok(gaps.some((gap) => gap.status === expected.status && (expected.key === undefined || gap.key === expected.key)), `expected ${JSON.stringify(expected)} in ${JSON.stringify(gaps)}`);
}

function assertContextDenied(reply: Reply, code: string): void {
  assert.equal(reply.body['status'], 'denied', reply.text);
  assert.ok(codesOf(reply).includes(code), `${code}: ${reply.text}`);
}

const admin = (path: string, body: unknown) => call(main.booted.baseUrl, 'POST', path, { authorization: ADMIN, body });

// ── Qualification ────────────────────────────────────────────────────────────

describe('K1 — a canonical trade progresses through the existing governed path via the edge', () => {
  it('A: admitted, assessed SATISFIED from trusted ports, decided by the Kernel, executed once (recording adapter)', async () => {
    const { reply, calls } = await trade(main, order());
    assert.equal(reply.body['status'], 'executed', reply.text);
    assert.equal(calls, 1);
    const evidence = main.evidence.at(-1);
    assert.equal(evidence?.outcome, 'SATISFIED');
    assert.equal(evidence?.disposition, 'ELIGIBLE');
    assert.equal(evidence?.simulatedFacts, true, 'the fake ports are named as simulated in the evidence');
    assert.equal(main.edge.pendingCount(), 0, 'the binding was consumed');
  });

  it('A: the grant cannot outlive the trading facts it relied on', async () => {
    const { reply } = await trade(main, order());
    assert.equal(reply.body['status'], 'executed', reply.text);
    const record = JSON.parse(await committedText(main, reply)) as { readonly evaluation: { readonly resultPayload: { readonly context: { readonly validUntil: string }; readonly evaluatedAt: string } } };
    const validity = Date.parse(record.evaluation.resultPayload.context.validUntil) - Date.parse(record.evaluation.resultPayload.evaluatedAt);
    assert.ok(validity > 0 && validity <= 10_000, `bounded by the delegation reading (≤ 10 s), got ${validity} ms`);
  });

  it('K2: a 40-hex-digit currency (93-byte asset id) is no longer withheld at the P7 boundary — it executes', async () => {
    assert.equal(Buffer.byteLength(RLUSD_ID, 'utf8'), 93);
    const { reply, calls } = await trade(main, order({ takerGets: { currency: RLUSD, issuer: ISSUER, value: '100' } }));
    assert.equal(reply.body['status'], 'executed', reply.text);
    assert.equal(calls, 1);
  });

  it('K2: the hex-currency asset is still held to P10 on its merits — above its ceiling it is withheld by financial authority', async () => {
    const { reply, calls } = await trade(main, order({ takerGets: { currency: RLUSD, issuer: ISSUER, value: '1000.5' }, takerPays: { currency: 'XRP', drops: '2001000000' } }));
    assert.equal(main.evidence.at(-1)?.outcome, 'VIOLATED', 'the risk layer refuses first here (base quantity > 1000)');
    assert.equal(reply.body['status'], 'denied', reply.text);
    assert.equal(calls, 0);
  });

  it('D: a risk-SATISFIED order above the owner’s P10 ceiling is withheld by the existing financial authority', async () => {
    const within = await trade(main, sellToken('480', '960000000'));
    assert.equal(within.reply.body['status'], 'executed', within.reply.text);
    const over = await trade(main, sellToken('600', '1200000000'));
    assert.equal(main.evidence.at(-1)?.outcome, 'SATISFIED');
    assert.equal(over.reply.body['status'], 'withheld', over.reply.text);
    assert.ok(codesOf(over.reply).includes('FINANCIAL_AUTHORITY_CEILING_EXCEEDED'), over.reply.text);
    assert.equal(over.calls, 0);
  });
});

describe('K1 — proposal-to-intent binding: every compiled field is bound (no substitution)', () => {
  const substitutions: readonly [string, (intent: TradeGovernedActionIntent) => Record<string, unknown>, string][] = [
    ['amount', (intent) => ({ ...intent, amount: { ...intent.amount, value: '99' } }), 'TRADE_RISK_AMOUNT_NOT_ASSESSED'],
    ['monetary asset', (intent) => ({ ...intent, amount: { ...intent.amount, currency: TOKEN_B_ID } }), 'TRADE_RISK_ASSET_NOT_ASSESSED'],
    ['delegate', (intent) => ({ ...intent, parameters: { ...intent.parameters, [D.delegateAccount]: STRANGER_DELEGATE } }), 'TRADE_INTENT_DELEGATE_NOT_ASSESSED'],
    ['side', (intent) => ({ ...intent, parameters: { ...intent.parameters, [D.side]: 'buy' } }), 'TRADE_INTENT_SIDE_NOT_ASSESSED'],
    ['base asset', (intent) => ({ ...intent, parameters: { ...intent.parameters, [D.baseAsset]: `${TOKEN}.${ISSUER_B}` } }), 'TRADE_INTENT_BASE_ASSET_NOT_ASSESSED'],
    ['quote asset', (intent) => ({ ...intent, parameters: { ...intent.parameters, [D.quoteAsset]: `${TOKEN}.${ISSUER_B}` } }), 'TRADE_INTENT_QUOTE_ASSET_NOT_ASSESSED'],
    ['quantity', (intent) => ({ ...intent, parameters: { ...intent.parameters, [D.quantity]: '1' } }), 'TRADE_INTENT_QUANTITY_NOT_ASSESSED'],
    ['network', (intent) => ({ ...intent, parameters: { ...intent.parameters, [D.network]: 'xrp-ledger-devnet' } }), 'TRADE_INTENT_NETWORK_NOT_ASSESSED'],
    ['proposal digest', (intent) => ({ ...intent, parameters: { ...intent.parameters, [D.proposalDigest]: `sha256:${'b'.repeat(64)}` } }), 'TRADE_RISK_PROPOSAL_NOT_ASSESSED'],
  ];
  for (const [label, mutate, code] of substitutions) {
    it(`a changed ${label} is refused (${code}), zero adapter calls`, async () => {
      const { reply, calls } = await trade(main, order(), mutate);
      await assertPolicyDenied(main, reply, code);
      assert.equal(calls, 0);
    });
  }

  it('a changed owner (another classified owner resource) finds no binding for it: unresolved, denied — and A’s binding expires unused', async () => {
    const { reply, calls } = await trade(main, order(), (intent) => ({ ...intent, resource: STRANGER_RESOURCE }));
    await assertBoundaryHeld(main, reply, { status: 'unresolved', key: F.assessedProposal });
    assert.equal(calls, 0);
    // Consume the binding the substituted request did not reach.
    assert.equal((await post(main, { ...selfCompiled(order()), idempotencyKey: nextId('drain') })).reply.body['status'], 'denied');
  });

  it('changed flags or economic terms cannot reuse an assessment: the changed proposal’s intent names another digest', async () => {
    for (const change of [{ flags: [] }, { takerPays: { currency: 'XRP', drops: '200000001' } }, { requestedValiditySeconds: 61 }]) {
      const assessed = order();
      await admit(main, assessed);
      const { reply, calls } = await post(main, selfCompiled({ ...assessed, ...change }));
      await assertPolicyDenied(main, reply, 'TRADE_RISK_PROPOSAL_NOT_ASSESSED');
      assert.equal(calls, 0);
    }
  });

  it('an identical retry replays the committed decision; the same intent under a fresh idempotency key finds no binding', async () => {
    const intent = await admit(main, order());
    const first = await post(main, intent);
    assert.equal(first.reply.body['status'], 'executed', first.reply.text);
    const retry = await post(main, intent);
    assert.equal(retry.reply.body['executionId'], first.reply.body['executionId'], retry.reply.text);
    assert.equal(retry.calls, 0);
    const fresh = await post(main, { ...intent, idempotencyKey: nextId('replay') });
    await assertBoundaryHeld(main, fresh.reply, { status: 'unresolved', key: F.assessedProposal });
    assert.equal(fresh.calls, 0);
  });

  it('cross-principal: agent B submitting agent A’s admitted intent finds no binding for its actor — and cannot consume A’s', async () => {
    const intent = await admit(main, order());
    const stolen = await post(main, intent, AGENT_B_KEY);
    await assertBoundaryHeld(main, stolen.reply, { status: 'unresolved', key: F.assessedProposal });
    assert.equal(stolen.calls, 0);
    assert.equal(main.edge.pendingCount(), 1, 'A’s binding is untouched');
    const own = await post(main, intent);
    assert.equal(own.reply.body['status'], 'executed', own.reply.text);
  });

  it('cross-principal and cross-organization admission is refused before any binding exists', async () => {
    const identity = await identityOf(main, AGENT_KEY);
    assert.deepEqual(main.edge.admitProposal(identity, order({ principalId: PRINCIPAL_B })), { admitted: false, refusal: AR.PROPOSAL_REFUSED });
    assert.deepEqual(main.edge.admitProposal(identity, order({ organizationId: 'org-rival' })), { admitted: false, refusal: AR.PROPOSAL_REFUSED });
    const foreign: BoundCustomerIdentity = { principal: { ...identity.principal, organizationId: 'org-rival' }, actor: identity.actor };
    assert.deepEqual(main.edge.admitProposal(foreign, order({ organizationId: 'org-rival' })), { admitted: false, refusal: AR.ORGANIZATION_MISMATCH });
    assert.deepEqual(main.edge.admitProposal({ principal: identity.principal, actor: { actorId: '' } }, order()), { admitted: false, refusal: AR.IDENTITY_INVALID });
    assert.deepEqual(main.edge.admitProposal(identity, order({ ownerAccount: 'rhub8VRN55s94qWKDv6jmDy1pUykJzF3wq' })), { admitted: false, refusal: AR.NOT_IN_PROFILE_SCOPE });
    assert.equal(main.edge.pendingCount(), 0);
  });

  it('one binding per (actor, owner): a second admission waits until the first is consumed', async () => {
    const identity = await identityOf(main, AGENT_KEY);
    const first = await admit(main, order());
    assert.deepEqual(main.edge.admitProposal(identity, order()), { admitted: false, refusal: AR.BINDING_PENDING });
    assert.equal((await post(main, first)).reply.body['status'], 'executed');
    assert.equal((await trade(main, order())).reply.body['status'], 'executed');
  });

  it('SEC-TRADE03-06: the applicant cannot state a trading fact — every fact class and reserved trade key in assertedContext is refused', async () => {
    for (const key of [...TRADE_RISK_MATERIAL_FACTS, F.assessedProposal.toUpperCase(), 'delegationVerified', 'referencePrice', 'exposure']) {
      const intent = await admit(main, order());
      const { reply, calls } = await post(main, { ...intent, assertedContext: { [key]: 'SATISFIED' } });
      assert.equal(reply.body['status'], 'rejected', `${key}: ${reply.text}`);
      assert.equal(calls, 0);
      // A rejected envelope never reaches the Kernel, so the binding is still pending: the clean intent uses it.
      assert.equal((await post(main, intent)).reply.body['status'], 'executed');
    }
  });
});

describe('K1 — missing, stale, unavailable or mismatched trusted context fails closed', () => {
  it('no admission at all: a self-compiled trade intent has no binding — denied', async () => {
    const { reply, calls } = await post(main, selfCompiled(order()));
    await assertBoundaryHeld(main, reply, { status: 'unresolved', key: F.assessedProposal });
    assert.equal(calls, 0);
  });

  const unavailable: readonly [string, (world: World) => void][] = [
    ['stale market reference', (world) => (world.marketAgeSeconds = 120)],
    ['market source failing', (world) => (world.marketThrows = true)],
    ['delegation reader unavailable', (world) => (world.delegation = 'unavailable')],
    ['delegation reader failing', (world) => (world.delegation = 'throws')],
  ];
  for (const [label, breakIt] of unavailable) {
    it(`${label}: no reading, denied, zero adapter calls`, async () => {
      breakIt(main.world);
      try {
        const { reply, calls } = await trade(main, order());
        await assertBoundaryHeld(main, reply, { status: 'unresolved' });
        assert.equal(calls, 0);
      } finally {
        Object.assign(main.world, freshWorld());
      }
    });
  }

  it('a risk violation (price floor) yields no reading', async () => {
    const { reply, calls } = await trade(main, sellToken('100', '180000000'));
    assert.equal(main.evidence.at(-1)?.outcome, 'VIOLATED');
    await assertBoundaryHeld(main, reply, { status: 'unresolved', key: F.assessedProposal });
    assert.equal(calls, 0);
  });

  it('an expired binding is never attested', async () => {
    const shifted = createTradeRiskContext({ organizationId: ORG, action: ACTION, profile: PROFILE, ports: fakePorts(freshWorld()), sourceIds: SOURCE_IDS, bindingSeconds: 1, clock: () => iso(Date.now() - 5000), simulation: TRADE_RISK_SIMULATION_ACKNOWLEDGEMENT });
    const identity = await identityOf(main, AGENT_KEY);
    assert.ok(shifted.admitProposal(identity, order()).admitted);
    const output = await shifted.provider.resolveContext({ keys: [...TRADE_RISK_MATERIAL_FACTS].sort(), actorId: identity.actor.actorId, trustDomainId: TRUST_DOMAIN, action: ACTION, resourceScope: RESOURCE, organizationId: ORG, at: iso(Date.now()) });
    assert.deepEqual(output.observations, []);
  });

  it('invalid profile version: a reading for another profile version is denied by the pinned profile rule', async () => {
    main.wrapper.tamper = (observations) => observations.map((observation) => (observation.key === F.profile ? resealed(observation, { value: 'mm-desk@2' }) : observation));
    try {
      const { reply, calls } = await trade(main, order());
      await assertPolicyDenied(main, reply, 'TRADE_RISK_PROFILE_MISMATCH');
      assert.equal(calls, 0);
    } finally {
      main.wrapper.tamper = undefined;
    }
  });

  it('a Host with the trading sources configured but no provider composed refuses to start at all', async () => {
    await assert.rejects(bootTradeHost(RULES, false), /no context provider is composed/);
  });
});

describe('K1 — the material-fact gate alone (no absence-sensitive policy rule) denies with the boundary’s own codes', () => {
  it('control: a satisfied trade executes on this Host too', async () => {
    const { reply, calls } = await trade(gate, order());
    assert.equal(reply.body['status'], 'executed', reply.text);
    assert.equal(calls, 1);
  });

  const hostile: readonly [string, (observations: ContextFactObservation[]) => ContextFactObservation[], string][] = [
    ['missing', (observations) => observations.filter((observation) => observation.key !== F.assessedSide), 'CONTEXT_REQUIRED_FACT_UNRESOLVED'],
    ['stale', (observations) => observations.map((observation) => resealed(observation, { observedAt: iso(Date.parse(observation.observedAt) - 60_000) })), 'CONTEXT_REQUIRED_FACT_STALE'],
    ['conflicting', (observations) => [...observations, resealed(observations.find((observation) => observation.key === F.assessedProposal) as ContextFactObservation, { sourceId: `${SOURCE_IDS.risk}-2`, value: `sha256:${'0'.repeat(64)}` })], 'CONTEXT_REQUIRED_FACT_CONFLICTED'],
    ['unregistered source', (observations) => observations.map((observation) => resealed(observation, { sourceId: 'trading-engine' })), 'CONTEXT_REQUIRED_FACT_SOURCE_NOT_AUTHORIZED'],
    ['tampered provenance', (observations) => observations.map((observation) => ({ ...observation, maxAgeSeconds: 1 })), 'CONTEXT_REQUIRED_FACT_PROVENANCE_INVALID'],
    ['another organization', (observations) => observations.map((observation) => resealed(observation, { organizationId: 'org-rival' })), 'CONTEXT_REQUIRED_FACT_SOURCE_NOT_AUTHORIZED'],
  ];
  for (const [label, tamper, code] of hostile) {
    it(`${label} → ${code}`, async () => {
      gate.wrapper.tamper = tamper;
      try {
        const { reply, calls } = await trade(gate, order());
        assertContextDenied(reply, code);
        assert.equal(calls, 0);
      } finally {
        gate.wrapper.tamper = undefined;
      }
    });
  }

  it('no admission → CONTEXT_REQUIRED_FACT_UNRESOLVED', async () => {
    const { reply, calls } = await post(gate, selfCompiled(order()));
    assertContextDenied(reply, 'CONTEXT_REQUIRED_FACT_UNRESOLVED');
    assert.equal(calls, 0);
  });
});

describe('K1 — CORE-05 approvals and emergency control remain authoritative', () => {
  it('N: an order above the review threshold is withheld by the existing approval gate', async () => {
    const { reply, calls } = await trade(main, sellToken('800', '1600000000'));
    assert.equal(main.evidence.at(-1)?.disposition, 'APPROVAL_REQUIRED');
    assert.equal(reply.body['status'], 'withheld', reply.text);
    assert.equal(reply.body['withheldBy'], 'approval', reply.text);
    assert.equal(calls, 0);
  });

  it('O: an emergency stop on the owner account, the organization or the desk withholds a satisfied trade; release restores it', async () => {
    for (const scope of [{ scope: 'resource', value: RESOURCE }, { scope: 'organization', value: ORG }, { scope: 'actor', value: AGENT }]) {
      const stop = await admin('/api/admin/emergency-controls/activate', scope);
      assert.equal(stop.status, 200, stop.text);
      try {
        const { reply, calls } = await trade(main, order());
        assert.equal(main.evidence.at(-1)?.outcome, 'SATISFIED');
        assert.equal(reply.body['withheldBy'], 'emergency-control', `${scope.scope}: ${reply.text}`);
        assert.equal(calls, 0);
      } finally {
        assert.equal((await admin('/api/admin/emergency-controls/release', scope)).status, 200);
      }
    }
    assert.equal((await trade(main, order())).reply.body['status'], 'executed');
  });

  it('SEC-TRADE03-17: an order marked for review under an active stop is not executed', async () => {
    assert.equal((await admin('/api/admin/emergency-controls/activate', { scope: 'resource', value: RESOURCE })).status, 200);
    try {
      const { reply, calls } = await trade(main, sellToken('800', '1600000000'));
      assert.equal(reply.body['status'], 'withheld', reply.text);
      assert.equal(calls, 0);
    } finally {
      await admin('/api/admin/emergency-controls/release', { scope: 'resource', value: RESOURCE });
    }
  });
});

describe('K1 — composition refuses anything it cannot serve safely', () => {
  const base = { organizationId: ORG, action: ACTION, profile: PROFILE, ports: fakePorts(freshWorld()), sourceIds: SOURCE_IDS, bindingSeconds: 30, clock: () => iso(Date.now()) };
  const ack = { simulation: TRADE_RISK_SIMULATION_ACKNOWLEDGEMENT };

  it('a profile that admits simulated sources needs the explicit acknowledgement; an operational-only one does not', () => {
    assert.throws(() => createTradeRiskContext(base), TradeRiskContextConfigurationError);
    assert.doesNotThrow(() => createTradeRiskContext({ ...base, ...ack }));
    assert.doesNotThrow(() => createTradeRiskContext({ ...base, profile: { ...PROFILE, factProvenance: 'operational-only' } }));
  });

  it('an enforced control without its port, a missing delegation port, another organization’s profile, or a bad window is refused', () => {
    const { market: _market, ...noMarket } = fakePorts(freshWorld());
    assert.throws(() => createTradeRiskContext({ ...base, ...ack, ports: noMarket }), TradeRiskContextConfigurationError);
    assert.throws(() => createTradeRiskContext({ ...base, ...ack, ports: { ...fakePorts(freshWorld()), delegation: undefined as never } }), TradeRiskContextConfigurationError);
    assert.throws(() => createTradeRiskContext({ ...base, ...ack, organizationId: 'org-rival' }), TradeRiskContextConfigurationError);
    assert.throws(() => createTradeRiskContext({ ...base, ...ack, bindingSeconds: 301 }), TradeRiskContextConfigurationError);
    assert.throws(() => createTradeRiskContext({ ...base, ...ack, sourceIds: { risk: 'same', delegation: 'same' } }), TradeRiskContextConfigurationError);
    assert.throws(() => createTradeRiskContext({ ...base, ...ack, profile: { ...PROFILE, profileVersion: 0 } }), TradeRiskContextConfigurationError);
  });
});
