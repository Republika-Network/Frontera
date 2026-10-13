import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { contextObservationProvenanceDigest, type ContextFactObservation, type ContextResolutionQuery } from '../../features/context-resolution-runtime/index.js';
import type { PolicyCondition } from '../../features/domain-policy-pack-runtime/domain/policy-pack-condition.js';
import type { PolicyPackRule } from '../../features/domain-policy-pack-runtime/domain/policy-pack-rule.js';
import { createActionEnforcementPolicyPackIntegration } from '../../features/domain-policy-pack-runtime/integrations/action-enforcement-policy-pack-integration.js';
import { createPolicyPackRuntimeContext } from '../../features/domain-policy-pack-runtime/runtime/policy-pack-runtime-context.js';
import { createPolicyPackRuntime } from '../../features/domain-policy-pack-runtime/services/policy-pack-runtime.js';
import {
  TRADE_PARAMETER_DIMENSIONS,
  TRADE_PARAMETER_DIMENSION_IDS as D,
  TRADE_PROFILE_PARAMETERS,
  TRADE_RESERVED_CONTEXT_KEYS,
  TRADE_RISK_FACT_CLASSES as F,
  assessTradingRisk,
  compileTradeProposal,
  createTradeGovernanceBinding,
  sealTradeActiveOrderSnapshot,
  sealTradeExposureSnapshot,
  tradeDelegationContextReading,
  tradingRiskContextReadings,
  type TradeContextReading,
  type TradeGovernedActionIntent,
} from '../../features/trade-runtime/index.js';
import {
  DELEGATION_POLICY,
  ISSUER,
  ISSUER_B,
  OWNER,
  RLUSD,
  delegationFor,
  exposureReading,
  grantedObservation,
  market,
  ordersReading,
  pairData,
  profileData,
  proposal as fixtureProposal,
} from '../../features/trade-runtime/tests/trade-risk-fixture.js';
import type { GovernanceConfiguration } from '../governance-profile/index.js';
import { buildDurableAuthorityPayloads, DURABLE_FIXTURE_OPERATOR } from '../kernel-authority/fixtures/durable-authority.fixture.js';
import { ADMIN, AGENT, AGENT_SUBJECT, ORG, OWNER as OWNER_ACTOR, POLICY_WRITER, TRUST_DOMAIN, Workspace, boot, call, governedFile, govern, secureEnv, type Booted, type ContextTable, type Reply } from './core04-host-fixture.js';

/**
 * TRADE-03 — trading-risk prerequisites on the **canonical shipped Host**
 * (`bootEnterpriseHost()`, production profile, SQLite everywhere, signed
 * grants, durable approvals and emergency controls, a real loopback
 * listener), through the **unchanged** governed path:
 *
 *   compiled TradeProposal → envelope (P9, CORE-03) → Kernel → Trusted Context
 *   Boundary (material trade facts) → policy pack → CORE-05 → emergency →
 *   P10 / grant → P7 → recording adapter.
 *
 * What is **test-only composition** here (no production edge exists —
 * `TRADE_COMPOSITION_EDGES` stays empty): the trusted context provider. It
 * plays the role a reviewed TRADE composition edge would: for the Kernel's own
 * query it assesses the pending proposal with `assessTradingRisk` over **fake
 * trusted sources** (TRADE-02's own assessor over a fake ledger read, sealed
 * fixture market / exposure / order snapshots, all marked `simulated`), and
 * projects only a reliable assessment into readings. The policy is data.
 * Nothing reads a ledger or market, signs, submits or executes a trade: the
 * adapter is the fixture's recording adapter and only its call count matters.
 */

const ACTION = 'trade.offer-create';
const NETWORK = 'xrp-ledger-testnet';
const RESOURCE = `${NETWORK}:${OWNER}`;
const PRINCIPAL = 'principal-agent';
const XRP_ID = `${NETWORK}:XRP`;
/**
 * The Host world's issued token is a three-character code from the fixture
 * issuer. A 40-hex-digit code (`RLUSD`) makes a P9 asset id of 94 bytes, above
 * P7's 64-byte amount-unit bound — see the pinned characterization below.
 */
const TOKEN = 'USD';
const TOKEN_RECORD = Object.freeze({ currency: TOKEN, issuer: ISSUER });
const TOKEN_ID = `${NETWORK}:${TOKEN}/${ISSUER}`;
const TOKEN_B_ID = `${NETWORK}:${TOKEN}/${ISSUER_B}`;
const RLUSD_ID = `${NETWORK}:${RLUSD}/${ISSUER}`;
const BINDING = createTradeGovernanceBinding({ action: ACTION });
const IDENTITY = Object.freeze({ organizationId: ORG, principalId: PRINCIPAL });
const RISK_SOURCE = 'trade-risk-assessor';
const DELEGATION_SOURCE = 'trade-delegation-verifier';
const MATERIAL = [F.assessedProposal, F.assessedAmount, F.assessedAsset, F.profile, F.approvalRequired, F.delegation];
const POLICY_VERSION = 'policy-pack-trade03-v1';
/** Rules that also deny on an *absent* fact (`not_exists`, and `not_equals` against a literal, which is true on absence). */
const ABSENCE_SENSITIVE_RULES: ReadonlySet<string> = new Set(['risk-facts-present', 'risk-profile-pinned']);

// ── Trusted configuration: the trading-risk profile in force ─────────────────

const NOW = Date.now();
const iso = (ms: number): string => new Date(ms).toISOString();

/** The fixture pair on the Host's token: deviation ≤ 1000 bps, notional ≤ 5000 XRP, review above 3000 XRP. */
function hostPair(overrides: Record<string, unknown> = {}, base: Record<string, unknown> = TOKEN_RECORD): Record<string, unknown> {
  return pairData({
    base,
    referenceDeviation: { mode: 'enforce', maxBasisPoints: 1000, rule: 'symmetric' },
    notional: { mode: 'enforce', valuationAsset: { currency: 'XRP' }, maximum: '5000' },
    approval: { restricted: false, notionalAbove: '3000' },
    ...overrides,
  });
}

/** The fixture profile, for this Host's organization and token, in force around now. */
function hostProfile(overrides: Record<string, unknown> = {}, pair: Record<string, unknown> = hostPair()): Record<string, unknown> {
  return profileData({ organizationId: ORG, effectiveFrom: iso(NOW - 86_400_000), expiresAt: iso(NOW + 30 * 86_400_000), pairs: [pair], ...overrides });
}

// ── The governance configuration a trading deployment declares ──────────────

const GOVERNANCE: GovernanceConfiguration = {
  parameterDimensions: TRADE_PARAMETER_DIMENSIONS,
  actionClasses: [{ id: 'place-order', actions: [ACTION] }],
  resourceClasses: [{ id: 'trading-account', resources: [RESOURCE] }],
  profiles: [
    {
      profileId: 'governed-trading',
      version: 1,
      owner: ORG,
      provenance: { authoredBy: 'operator:trading-desk', approvedBy: 'operator:security' },
      actionClass: 'place-order',
      resourceClass: 'trading-account',
      parameters: TRADE_PROFILE_PARAMETERS,
      // Every trading-risk prerequisite is a *material* fact: missing, stale, conflicting or untrusted → the Kernel denies before policy runs.
      materialFacts: MATERIAL,
      relevantPolicies: ['trade03-policy'],
      approval: { approverAction: 'approve-trade', minimumApprovals: 1, requestTtlSeconds: 3600, approvalValiditySeconds: 900 },
    },
  ],
  reservedContextKeys: TRADE_RESERVED_CONTEXT_KEYS,
};

const TRUSTED_CONTEXT = {
  maxFutureSkewSeconds: 0,
  sources: [
    { sourceId: RISK_SOURCE, kind: 'risk_engine', name: 'Trading-risk assessor (test composition)', trustClass: 'authoritative', organizationId: ORG, attests: MATERIAL.filter((key) => key !== F.delegation).map((factClass) => ({ factClass, maxAgeSeconds: 30 })) },
    { sourceId: `${RISK_SOURCE}-2`, kind: 'risk_engine', name: 'Second assessor', trustClass: 'authoritative', organizationId: ORG, attests: [{ factClass: F.assessedProposal, maxAgeSeconds: 30 }] },
    { sourceId: DELEGATION_SOURCE, kind: 'ledger', name: 'XLS-75 delegation verifier (test composition)', trustClass: 'authoritative', organizationId: ORG, attests: [{ factClass: F.delegation, maxAgeSeconds: 10 }] },
  ],
} as const;

// ── The organization's policy: data, every rule over admitted facts only ────

const pred = (condition: Record<string, unknown>): PolicyCondition => ({ type: 'predicate', ...condition }) as PolicyCondition;
const notAssessed = (field: Record<string, unknown>, factClass: string): PolicyCondition => pred({ ...field, operator: 'not_equals', valueFrom: { field: 'contextFact', factClass } });

function rule(id: string, condition: PolicyCondition, effect: PolicyPackRule['effect']): PolicyPackRule {
  return { id, policyPackVersionId: POLICY_VERSION, name: id, description: id, status: 'active', priority: 100, condition, effect, obligations: [], evidenceRequirements: [], approvalRequirements: [], severity: 'error', sourceIds: ['trade03-source'] };
}

/**
 * Deny unless the admitted facts name **this** request; never only "deny on
 * violation". Each binding rule compares a request field against an admitted
 * fact (`valueFrom`), and the belt rule denies if any fact is absent — which a
 * material fact already guarantees, so it is defence in depth, not the gate.
 */
export const TRADE_RULES: readonly PolicyPackRule[] = [
  rule('risk-assessed-this-proposal', notAssessed({ field: 'parameter', parameterId: D.proposalDigest }, F.assessedProposal), { type: 'deny', reasonCode: 'TRADE_RISK_PROPOSAL_NOT_ASSESSED', reason: 'The admitted risk assessment is for another proposal.' }),
  rule('risk-assessed-this-amount', notAssessed({ field: 'amount' }, F.assessedAmount), { type: 'deny', reasonCode: 'TRADE_RISK_AMOUNT_NOT_ASSESSED', reason: 'The governed amount differs from the assessed proposal.' }),
  rule('risk-assessed-this-asset', notAssessed({ field: 'currency' }, F.assessedAsset), { type: 'deny', reasonCode: 'TRADE_RISK_ASSET_NOT_ASSESSED', reason: 'The governed asset differs from the assessed proposal.' }),
  rule('delegation-verified-for-this-proposal', notAssessed({ field: 'parameter', parameterId: D.proposalDigest }, F.delegation), { type: 'deny', reasonCode: 'TRADE_DELEGATION_NOT_VERIFIED', reason: 'No reliable XLS-75 delegation for this proposal.' }),
  rule('risk-profile-pinned', pred({ field: 'contextFact', factClass: F.profile, operator: 'not_equals', value: 'mm-desk@3' }), { type: 'deny', reasonCode: 'TRADE_RISK_PROFILE_MISMATCH', reason: 'The assessment relied on another risk profile version.' }),
  rule('risk-facts-present', { type: 'group', operator: 'any', conditions: MATERIAL.map((factClass) => pred({ field: 'contextFact', factClass, operator: 'not_exists' })) }, { type: 'deny', reasonCode: 'TRADE_RISK_FACT_MISSING', reason: 'A trading-risk fact is missing.' }),
  rule('risk-review', pred({ field: 'contextFact', factClass: F.approvalRequired, operator: 'equals', value: true }), { type: 'require_approval', reasonCode: 'TRADE_RISK_REVIEW_REQUIRED', reason: 'The order is marked for human review.' }),
];

function tradePolicy(rules: readonly PolicyPackRule[] = TRADE_RULES) {
  const runtime = createPolicyPackRuntime(createPolicyPackRuntimeContext('2026-01-01T00:00:00.000Z'));
  runtime.registerPolicyPack(POLICY_WRITER, { id: 'trade03-policy', name: 'TRADE-03 trading-risk policy', description: 'Synthetic', kind: 'data_boundary', domain: 'general_enterprise' });
  runtime.registerPolicyPackVersion(POLICY_WRITER, {
    id: POLICY_VERSION,
    policyPackId: 'trade03-policy',
    version: '1.0.0',
    scope: { resourceScopes: [RESOURCE] },
    rules,
    sources: [{ id: 'trade03-source', type: 'internal_control', title: 'Synthetic', description: 'Synthetic', authority: 'demo_only' }],
    effectiveFrom: '2026-01-01T00:00:00.000Z',
    demoOnly: true,
    legalCompleteness: 'not_legal_advice',
  });
  runtime.activatePolicyPackVersion(POLICY_WRITER, POLICY_VERSION);
  return createActionEnforcementPolicyPackIntegration(runtime);
}

// ── The test-only trusted composition (the role a reviewed edge would play) ─

interface Pending {
  /** The proposal the trusted side received and will assess — never the request body. */
  readonly proposal: Record<string, unknown>;
  readonly profile?: Record<string, unknown>;
  readonly delegation?: 'granted' | 'missing' | 'unavailable';
  readonly marketAgeSeconds?: number;
  /** The issued asset the market reference is for (defaults to the Host token). */
  readonly marketBase?: { readonly currency: string; readonly issuer: string };
  /** Rewrites readings after projection, to stand in for a broken or hostile provider. */
  readonly tamper?: (readings: ContextFactObservation[], query: ContextResolutionQuery) => ContextFactObservation[];
  readonly throws?: boolean;
}

interface TradeContext extends ContextTable {
  pending: Pending | undefined;
  readonly assessments: string[];
}

function createTradeContext(): TradeContext {
  const queries: ContextResolutionQuery[] = [];
  const assessments: string[] = [];
  const context: TradeContext = {
    pending: undefined,
    queries,
    assessments,
    set() {
      throw new Error('The trade composition is driven by `pending`.');
    },
    provider: {
      resolveContext(query) {
        queries.push(query);
        const pending = context.pending;
        if (pending === undefined) return Promise.resolve({ observations: [] });
        if (pending.throws === true) return Promise.reject(new Error('risk source unavailable'));
        const at = query.at;
        const observed = iso(Date.parse(at) - 2000);
        const profile = pending.profile ?? hostProfile();
        const proposal = pending.proposal;
        const delegation =
          pending.delegation === 'missing'
            ? undefined
            : pending.delegation === 'unavailable'
              ? delegationFor(proposal, { outcome: 'unavailable', failure: 'TRANSPORT_UNAVAILABLE' }, at)
              : delegationFor(proposal, { outcome: 'observed', observation: grantedObservation({ observedAt: observed }) }, at);
        const result = assessTradingRisk({
          proposal,
          identity: IDENTITY,
          binding: { action: ACTION },
          profile,
          facts: {
            delegation,
            marketPrices: [market({ organizationId: ORG, base: { kind: 'issued', ...(pending.marketBase ?? TOKEN_RECORD) }, observedAt: iso(Date.parse(at) - (pending.marketAgeSeconds ?? 2) * 1000) })],
            exposure: sealTradeExposureSnapshot(exposureReading({ organizationId: ORG, observedAt: observed })),
            activeOrders: sealTradeActiveOrderSnapshot(ordersReading({ organizationId: ORG, observedAt: observed })),
          },
          governanceProfile: { id: 'governed-trading', version: 1 },
          assessedAt: at,
        });
        assessments.push(result.assessed ? `${result.evidence.outcome}/${result.evidence.disposition}` : `REFUSED/${result.refusal}`);
        const binding = { action: query.action, resourceScope: query.resourceScope, organizationId: query.organizationId ?? '' };
        const readings: TradeContextReading[] = [];
        if (result.assessed) {
          const risk = tradingRiskContextReadings(result.evidence, { proposal, profile, at, governanceProfile: { id: 'governed-trading', version: 1 } }, binding);
          if (risk.projected) readings.push(...risk.readings);
        }
        const delegated = delegation === undefined ? undefined : tradeDelegationContextReading(delegation, { proposal, at, policy: DELEGATION_POLICY, action: ACTION }, binding);
        if (delegated?.projected === true) readings.push(delegated.reading);
        let observations = readings
          .filter((reading) => query.keys.includes(reading.key))
          .map((reading): ContextFactObservation => {
            const base = { key: reading.key, value: reading.value, sourceId: reading.key === F.delegation ? DELEGATION_SOURCE : RISK_SOURCE, observedAt: reading.observedAt, reference: reading.reference, organizationId: ORG, maxAgeSeconds: reading.maxAgeSeconds };
            return { ...base, provenanceDigest: contextObservationProvenanceDigest(base) };
          });
        if (pending.tamper !== undefined) observations = pending.tamper(observations, query);
        return Promise.resolve({ observations });
      },
    },
  };
  return context;
}

/** Re-seals a reading after a change, as a provider that *believes* it is right would. */
function resealed(observation: ContextFactObservation, change: Partial<ContextFactObservation>): ContextFactObservation {
  const { provenanceDigest: _digest, ...rest } = { ...observation, ...change };
  return { ...rest, provenanceDigest: contextObservationProvenanceDigest({ ...rest, reference: rest.reference ?? '' }) };
}

// ── Host, authority, requests ────────────────────────────────────────────────

/** P10: per-order ceilings and lifetime limits in each governed asset — the existing authority, which TRADE never widens. */
const CONSTRAINTS = [
  { type: 'max_amount', currency: XRP_ID, value: '2000' },
  { type: 'spending_limit', limitId: 'xrp-lifetime', currency: XRP_ID, maximum: '1000000', window: { kind: 'lifetime' } },
  { type: 'max_amount', currency: TOKEN_ID, value: '1000' },
  { type: 'spending_limit', limitId: 'token-lifetime', currency: TOKEN_ID, maximum: '1000000', window: { kind: 'lifetime' } },
  { type: 'max_amount', currency: TOKEN_B_ID, value: '1000' },
  { type: 'spending_limit', limitId: 'token-b-lifetime', currency: TOKEN_B_ID, maximum: '1000000', window: { kind: 'lifetime' } },
  { type: 'max_amount', currency: RLUSD_ID, value: '1000' },
  { type: 'spending_limit', limitId: 'rlusd-lifetime', currency: RLUSD_ID, maximum: '1000000', window: { kind: 'lifetime' } },
];

async function provisionTrading(booted: Booted): Promise<void> {
  const service = booted.host.enterprise.kernelAuthorityProvisioning;
  assert.ok(service !== undefined);
  const payloads = buildDurableAuthorityPayloads(ORG, TRUST_DOMAIN);
  const operator = DURABLE_FIXTURE_OPERATOR;
  await service.provisionActor(operator, payloads.issuerActor);
  await service.provisionTrustDomain(operator, payloads.trustDomain);
  await service.provisionRootIssuer(operator, payloads.rootIssuer);
  await service.provisionActor(operator, { ...payloads.ownerActor, actorId: OWNER_ACTOR, displayName: 'Owner', externalSubject: { system: 'core04-app', subjectId: 'owner-1' } });
  await service.provisionActor(operator, { ...payloads.agentActor, actorId: AGENT, displayName: 'Trading engine', externalSubject: AGENT_SUBJECT });
  await service.provisionPassport(operator, { ...payloads.passport, passportId: `passport-${AGENT}`, subjectActorId: AGENT });
  await service.provisionCapabilityToken(operator, { ...payloads.capabilityToken, capabilityTokenId: `cap-${AGENT}`, subjectActorId: AGENT, principalActorId: OWNER_ACTOR, issuerActorId: OWNER_ACTOR, actions: [ACTION], resourceScopes: [RESOURCE] });
  await service.provisionAuthorityGrant(operator, { ...payloads.authorityGrant, authorityGrantId: 'authority-grant-trading', subjectActorId: OWNER_ACTOR, actions: [ACTION], resourceScopes: [RESOURCE], constraints: CONSTRAINTS as never });
  await service.provisionDelegationGrant(operator, {
    ...payloads.delegationGrant,
    delegationGrantId: 'delegation-trading',
    delegatorActorId: OWNER_ACTOR,
    delegateActorId: AGENT,
    sourceAuthorityGrantId: 'authority-grant-trading',
    actions: [ACTION],
    resourceScopes: [RESOURCE],
  });
}

let sequence = 0;
/** A fresh proposal for this Host's organization and principal; each gets its own idempotency key. */
function order(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  sequence += 1;
  return fixtureProposal({ organizationId: ORG, principalId: PRINCIPAL, requestId: `trade03-req-${sequence}`, idempotencyKey: `trade03-offer-${sequence}`, takerGets: { ...TOKEN_RECORD, value: '100' }, ...overrides });
}

const intentOf = (raw: Record<string, unknown>): TradeGovernedActionIntent => compileTradeProposal(raw, BINDING, IDENTITY, { expectedGovernanceProfile: { id: 'governed-trading', version: 1 } }).intent;

const workspace = new Workspace();
let booted: Booted;
let context: TradeContext;
/** A second Host whose policy has no rule that reacts to an absent fact: the material-fact gate alone. */
let gateOnly: Booted;
let gateContext: TradeContext;

function tradingFile(): Record<string, unknown> {
  return governedFile({
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

before(async () => {
  context = createTradeContext();
  booted = await boot(workspace, secureEnv(workspace.dir(), tradingFile()), { context, policy: tradePolicy() });
  await provisionTrading(booted);
  gateContext = createTradeContext();
  gateOnly = await boot(workspace, secureEnv(workspace.dir(), tradingFile()), { context: gateContext, policy: tradePolicy(TRADE_RULES.filter((entry) => !ABSENCE_SENSITIVE_RULES.has(entry.id))) });
  await provisionTrading(gateOnly);
});
after(() => workspace.cleanup());

/** Governs `raw` (as the trusted side holds it) with `intent` (as the applicant sends it), counting adapter calls. */
async function submit(pending: Pending, intent: TradeGovernedActionIntent | Record<string, unknown> = intentOf(pending.proposal), host: Booted = booted, table: TradeContext = context): Promise<{ readonly reply: Reply; readonly calls: number }> {
  table.pending = pending;
  const before = host.calls.length;
  const reply = await govern(host.baseUrl, intent as Record<string, unknown>, (intent as { idempotencyKey: string }).idempotencyKey);
  return { reply, calls: host.calls.length - before };
}

const codesOf = (reply: Reply): readonly string[] => (reply.body['reasonCodes'] as readonly string[] | undefined) ?? [];

async function committedText(reply: Reply, host: Booted = booted): Promise<string> {
  const decision = reply.body['decision'] as { readonly evaluationId?: string } | undefined;
  if (decision?.evaluationId === undefined) return reply.text;
  const record = await host.host.enterprise.persistence.getByEvaluationId({ system: false, organizationId: ORG }, decision.evaluationId);
  return JSON.stringify(record);
}

interface Unsatisfied {
  readonly key: string;
  readonly status: string;
  readonly refusalReasons?: readonly string[];
}

/** What the Trusted Context Boundary recorded as unsatisfied in the committed decision. */
async function unsatisfiedOf(reply: Reply, host: Booted = booted): Promise<readonly Unsatisfied[]> {
  const record = JSON.parse(await committedText(reply, host)) as { readonly evaluation?: { readonly resultPayload?: { readonly context?: { readonly unsatisfiedRequirements?: readonly Unsatisfied[] } } } };
  return record.evaluation?.resultPayload?.context?.unsatisfiedRequirements ?? [];
}

/**
 * Denied, and the Trusted Context Boundary itself recorded the material-fact
 * gap. (On the main Host the defence-in-depth policy rule also fires, and a
 * policy denial is the reported reason — the boundary's record is the proof
 * that the material-fact gate held regardless.)
 */
async function assertBoundaryHeld(reply: Reply, expected: { readonly status: string; readonly key?: string; readonly refusal?: string }, host: Booted = booted): Promise<void> {
  assert.equal(reply.body['status'], 'denied', reply.text);
  const gaps = await unsatisfiedOf(reply, host);
  const match = gaps.some((gap) => gap.status === expected.status && (expected.key === undefined || gap.key === expected.key) && (expected.refusal === undefined || (gap.refusalReasons ?? []).includes(expected.refusal)));
  assert.ok(match, `expected ${JSON.stringify(expected)} in ${JSON.stringify(gaps)}`);
}

async function assertPolicyDenied(reply: Reply, ruleCode: string): Promise<void> {
  assert.equal(reply.body['status'], 'denied', reply.text);
  assert.ok(codesOf(reply).includes('DOMAIN_POLICY_DENIED'), reply.text);
  assert.ok((await committedText(reply)).includes(ruleCode), `the committed decision records ${ruleCode}`);
}

function assertContextDenied(reply: Reply, code: string): void {
  assert.equal(reply.body['status'], 'denied', reply.text);
  assert.ok(codesOf(reply).includes(code), `${code}: ${reply.text}`);
}

const admin = (path: string, body: unknown) => call(booted.baseUrl, 'POST', path, { authorization: ADMIN, body });
const sellToken = (value: string, drops: string, overrides: Record<string, unknown> = {}) => order({ takerGets: { ...TOKEN_RECORD, value }, takerPays: { currency: 'XRP', drops }, ...overrides });
const buyToken = (drops: string, value: string, overrides: Record<string, unknown> = {}) => order({ takerGets: { currency: 'XRP', drops }, takerPays: { ...TOKEN_RECORD, value }, ...overrides });

// ── Qualification ────────────────────────────────────────────────────────────

describe('TRADE-03 on the shipped Host — scenario A and replay', () => {
  it('A: an order whose risk prerequisites are all SATISFIED is decided by the unchanged Governance Core and executed once (recording adapter)', async () => {
    const raw = order();
    const { reply, calls } = await submit({ proposal: raw });
    assert.equal(context.assessments.at(-1), 'SATISFIED/ELIGIBLE');
    assert.equal(reply.body['status'], 'executed', reply.text);
    assert.equal(calls, 1);
    assert.ok(JSON.stringify(booted.calls.at(-1)).includes(intentOf(raw).parameters[D.proposalDigest] as string), 'the exercised action carries exactly the assessed proposal digest');
  });

  it('A: the grant cannot outlive the trading facts it relied on — context validity caps it far below the Host’s one-hour grant lifetime', async () => {
    const { reply } = await submit({ proposal: order() });
    assert.equal(reply.body['status'], 'executed', reply.text);
    const record = JSON.parse(await committedText(reply)) as { readonly evaluation: { readonly resultPayload: { readonly context: { readonly validUntil: string }; readonly evaluatedAt: string } } };
    const validity = Date.parse(record.evaluation.resultPayload.context.validUntil) - Date.parse(record.evaluation.resultPayload.evaluatedAt);
    assert.ok(validity > 0 && validity <= 10_000, `the delegation reading bounds validity to ≤ 10 s, got ${validity} ms`);
  });

  it('replay: the same request again is the same outcome and no second adapter call', async () => {
    const raw = order();
    const intent = intentOf(raw);
    const first = await submit({ proposal: raw }, intent);
    assert.equal(first.reply.body['status'], 'executed', first.reply.text);
    const second = await submit({ proposal: raw }, intent);
    assert.equal(second.calls, 0, second.reply.text);
    assert.equal(second.reply.body['executionId'], first.reply.body['executionId'], second.reply.text);
  });
});

describe('TRADE-03 on the shipped Host — risk violations and unavailability never reach authority (B, C, E, H, I, J)', () => {
  const cases: readonly [string, () => Pending, string][] = [
    ['B wrong issuer (a registered asset, an unapproved issuer)', () => ({ proposal: sellToken('100', '200000000', { takerGets: { currency: TOKEN, issuer: ISSUER_B, value: '100' } }), marketBase: { currency: TOKEN, issuer: ISSUER_B } }), 'VIOLATED/PROHIBITED'],
    ['E sell below the price floor', () => ({ proposal: sellToken('100', '180000000') }), 'VIOLATED/PROHIBITED'],
    ['F buy above the price ceiling', () => ({ proposal: buyToken('220000000', '100') }), 'VIOLATED/PROHIBITED'],
    ['G limit 2.25 against reference 2 (1250 bps > 1000)', () => ({ proposal: sellToken('100', '225000000') }), 'VIOLATED/PROHIBITED'],
    ['H stale market reference', () => ({ proposal: order(), marketAgeSeconds: 120 }), 'UNAVAILABLE/WITHHELD'],
    ['I missing delegation evidence', () => ({ proposal: order(), delegation: 'missing' }), 'UNAVAILABLE/WITHHELD'],
    ['J delegation reader unavailable', () => ({ proposal: order(), delegation: 'unavailable' }), 'UNAVAILABLE/WITHHELD'],
    ['profile suspended (a policy-level trading halt)', () => ({ proposal: order(), profile: hostProfile({ status: 'suspended' }) }), 'VIOLATED/PROHIBITED'],
  ];
  for (const [label, pending, assessed] of cases) {
    it(`${label}: no reading is admitted, the material facts are unresolved, zero adapter calls`, async () => {
      const { reply, calls } = await submit(pending());
      assert.equal(context.assessments.at(-1), assessed);
      await assertBoundaryHeld(reply, { status: 'unresolved', key: F.assessedProposal });
      assert.equal(calls, 0);
    });
  }

  it('C: a pair the registry does not know is refused by the unchanged envelope (P9) before any decision', async () => {
    const { reply, calls } = await submit({ proposal: order({ takerGets: { currency: 'EUR', issuer: ISSUER, value: '100' } }) });
    assert.equal(reply.body['status'], 'rejected', reply.text);
    assert.equal(calls, 0);
  });
});

describe('TRADE-03 on the shipped Host — existing authority stays authoritative (D)', () => {
  it('D: a risk-SATISFIED order above the P10 authority ceiling is withheld by the existing financial authority — TRADE never widens it', async () => {
    // Buy 1000 for 2100 XRP: the risk profile allows 2500 XRP given; the owner's authority allows 2000 XRP per order.
    const { reply, calls } = await submit({ proposal: buyToken('2100000000', '1000') });
    assert.equal(context.assessments.at(-1), 'SATISFIED/ELIGIBLE');
    assert.equal(reply.body['decision'] !== undefined && (reply.body['decision'] as Record<string, unknown>)['status'], 'allowed', reply.text);
    assert.equal(reply.body['status'], 'withheld', reply.text);
    assert.ok(codesOf(reply).includes('FINANCIAL_AUTHORITY_CEILING_EXCEEDED'), reply.text);
    assert.equal(calls, 0);
  });

  it('characterization: a 40-hex-digit issued currency makes a P9 asset id longer than P7’s 64-byte unit bound — decided, then withheld at exercise, fail-closed', async () => {
    const hexPair = hostPair({}, { currency: RLUSD, issuer: ISSUER });
    const raw = order({ takerGets: { currency: RLUSD, issuer: ISSUER, value: '100' } });
    const { reply, calls } = await submit({ proposal: raw, profile: hostProfile({}, hexPair), marketBase: { currency: RLUSD, issuer: ISSUER } });
    assert.equal(context.assessments.at(-1), 'SATISFIED/ELIGIBLE');
    assert.ok(Buffer.byteLength(RLUSD_ID, 'utf8') > 64, RLUSD_ID);
    assert.equal(reply.body['status'], 'withheld', reply.text);
    assert.equal(reply.body['withheldBy'], 'exercise', reply.text);
    assert.deepEqual(codesOf(reply), ['EXERCISE_CONTROL_POLICY_INVALID']);
    assert.equal(calls, 0);
  });
});

describe('TRADE-03 on the shipped Host — the digest binding cannot be substituted, replayed or self-asserted (P, Q, R, SEC-TRADE03-06/09/23)', () => {
  it('P: an assessed proposal’s digest beside a different amount is denied by the amount binding', async () => {
    const raw = order();
    const intent = intentOf(raw);
    const { reply, calls } = await submit({ proposal: raw }, { ...intent, amount: { ...intent.amount, value: '99' } });
    await assertPolicyDenied(reply, 'TRADE_RISK_AMOUNT_NOT_ASSESSED');
    assert.equal(calls, 0);
  });

  it('P: an assessed proposal’s digest beside a different governed asset is denied by the asset binding', async () => {
    const raw = order();
    const intent = intentOf(raw);
    const { reply, calls } = await submit({ proposal: raw }, { ...intent, amount: { ...intent.amount, currency: TOKEN_B_ID } });
    await assertPolicyDenied(reply, 'TRADE_RISK_ASSET_NOT_ASSESSED');
    assert.equal(calls, 0);
  });

  it('P: a request whose digest names another proposal than the one assessed is denied by the digest bindings', async () => {
    const assessed = order();
    const other = sellToken('100', '200000001');
    const { reply, calls } = await submit({ proposal: assessed }, intentOf(other));
    assert.equal(reply.body['status'], 'denied', reply.text);
    const committed = await committedText(reply);
    assert.ok(committed.includes('TRADE_RISK_PROPOSAL_NOT_ASSESSED') || committed.includes('TRADE_DELEGATION_NOT_VERIFIED'), committed);
    assert.equal(calls, 0);
  });

  it('replay of an executed proposal under a fresh idempotency key is a different request whose digest has no assessment: denied', async () => {
    const executed = order();
    assert.equal((await submit({ proposal: executed })).reply.body['status'], 'executed');
    const replayed = { ...intentOf(executed), idempotencyKey: `trade03-replay-${sequence}` };
    const { reply, calls } = await submit({ proposal: order() }, replayed);
    assert.equal(reply.body['status'], 'denied', reply.text);
    assert.equal(calls, 0);
  });

  it('Q: readings scoped to another organization are refused by the Trusted Context Boundary', async () => {
    const { reply, calls } = await submit({ proposal: order(), tamper: (readings) => readings.map((reading) => resealed(reading, { organizationId: 'org-rival' })) });
    await assertBoundaryHeld(reply, { status: 'unresolved', refusal: 'organization_mismatch' });
    assert.equal(calls, 0);
  });

  it('Q: a proposal of another organization never compiles for this identity', () => {
    assert.throws(() => intentOf(order({ organizationId: 'org-rival' })), /ORGANIZATION_MISMATCH/);
  });

  it('R: an assessment under another risk-profile version is denied by the pinned profile rule', async () => {
    const { reply, calls } = await submit({ proposal: order(), profile: hostProfile({ profileVersion: 2 }) });
    await assertPolicyDenied(reply, 'TRADE_RISK_PROFILE_MISMATCH');
    assert.equal(calls, 0);
  });

  it('SEC-TRADE03-06: the applicant cannot state any trading fact — every fact class (any case) and every reserved trade key in assertedContext is refused', async () => {
    const raw = order();
    for (const key of [...MATERIAL, F.assessedProposal.toUpperCase(), 'delegationVerified', 'referencePrice', 'exposure', 'activeOrders']) {
      const { reply, calls } = await submit({ proposal: raw }, { ...intentOf(raw), assertedContext: { [key]: intentOf(raw).parameters[D.proposalDigest] } });
      assert.equal(reply.body['status'], 'rejected', `${key}: ${reply.text}`);
      assert.equal(calls, 0);
    }
  });

  it('SEC-TRADE03-06: with no trusted reading at all, nothing the applicant sends satisfies a material fact', async () => {
    const raw = order();
    context.pending = undefined;
    const before = booted.calls.length;
    const reply = await govern(booted.baseUrl, { ...intentOf(raw), assertedContext: { note: 'risk assessed SATISFIED', tradeRisk: { assessedProposal: 'x' } } } as Record<string, unknown>);
    await assertBoundaryHeld(reply, { status: 'unresolved', key: F.delegation });
    assert.equal(booted.calls.length, before);
  });
});

describe('TRADE-03 on the shipped Host — material trading facts fail closed at the boundary (SEC-TRADE03-04/05)', () => {
  it('a provider that fails yields no context: denied, never allowed', async () => {
    const { reply, calls } = await submit({ proposal: order(), throws: true });
    assert.equal(reply.body['status'], 'denied', reply.text);
    assert.equal(calls, 0);
  });

  it('each material fact alone, when missing, is recorded unresolved and denies', async () => {
    for (const key of MATERIAL) {
      const { reply, calls } = await submit({ proposal: order(), tamper: (readings) => readings.filter((reading) => reading.key !== key) });
      await assertBoundaryHeld(reply, { status: 'unresolved', key });
      assert.equal(calls, 0, key);
    }
  });

  it('stale, conflicting, unregistered-source and tampered readings are each recorded and deny', async () => {
    const stale = await submit({ proposal: order(), tamper: (readings) => readings.map((reading) => resealed(reading, { observedAt: iso(Date.parse(reading.observedAt) - 60_000) })) });
    await assertBoundaryHeld(stale.reply, { status: 'stale' });
    const conflicting = await submit({
      proposal: order(),
      tamper: (readings) => {
        const original = readings.find((reading) => reading.key === F.assessedProposal);
        assert.ok(original !== undefined);
        return [...readings, resealed(original, { sourceId: `${RISK_SOURCE}-2`, value: `sha256:${'0'.repeat(64)}` })];
      },
    });
    await assertBoundaryHeld(conflicting.reply, { status: 'conflicted', key: F.assessedProposal });
    const untrusted = await submit({ proposal: order(), tamper: (readings) => readings.map((reading) => resealed(reading, { sourceId: 'trading-engine' })) });
    await assertBoundaryHeld(untrusted.reply, { status: 'unresolved', refusal: 'source_untrusted' });
    const tampered = await submit({ proposal: order(), tamper: (readings) => readings.map((reading) => (reading.key === F.approvalRequired ? { ...reading, maxAgeSeconds: 29 } : reading)) });
    await assertBoundaryHeld(tampered.reply, { status: 'unresolved', key: F.approvalRequired, refusal: 'provenance_invalid' });
    assert.equal(stale.calls + conflicting.calls + untrusted.calls + tampered.calls, 0);
  });
});

describe('TRADE-03 — the material-fact gate alone, with no defence-in-depth policy rule, denies with the Trusted Context Boundary’s own codes', () => {
  const gate = (pending: Pending, intent?: TradeGovernedActionIntent) => submit(pending, intent ?? intentOf(pending.proposal), gateOnly, gateContext);

  it('control: a satisfied order executes on this Host too', async () => {
    const { reply, calls } = await gate({ proposal: order() });
    assert.equal(reply.body['status'], 'executed', reply.text);
    assert.equal(calls, 1);
  });

  it('missing → UNRESOLVED, stale → STALE, conflicting → CONFLICTED, unregistered source → SOURCE_NOT_AUTHORIZED, tampered → PROVENANCE_INVALID, other organization → SOURCE_NOT_AUTHORIZED', async () => {
    const cases: readonly [Pending, string][] = [
      [{ proposal: order(), delegation: 'missing' }, 'CONTEXT_REQUIRED_FACT_UNRESOLVED'],
      [{ proposal: sellToken('100', '180000000') }, 'CONTEXT_REQUIRED_FACT_UNRESOLVED'],
      [{ proposal: order(), tamper: (readings) => readings.map((reading) => resealed(reading, { observedAt: iso(Date.parse(reading.observedAt) - 60_000) })) }, 'CONTEXT_REQUIRED_FACT_STALE'],
      [
        {
          proposal: order(),
          tamper: (readings) => {
            const original = readings.find((reading) => reading.key === F.assessedProposal) as ContextFactObservation;
            return [...readings, resealed(original, { sourceId: `${RISK_SOURCE}-2`, value: `sha256:${'0'.repeat(64)}` })];
          },
        },
        'CONTEXT_REQUIRED_FACT_CONFLICTED',
      ],
      [{ proposal: order(), tamper: (readings) => readings.map((reading) => resealed(reading, { sourceId: 'trading-engine' })) }, 'CONTEXT_REQUIRED_FACT_SOURCE_NOT_AUTHORIZED'],
      [{ proposal: order(), tamper: (readings) => readings.map((reading) => ({ ...reading, maxAgeSeconds: 29 })) }, 'CONTEXT_REQUIRED_FACT_PROVENANCE_INVALID'],
      [{ proposal: order(), tamper: (readings) => readings.map((reading) => resealed(reading, { organizationId: 'org-rival' })) }, 'CONTEXT_REQUIRED_FACT_SOURCE_NOT_AUTHORIZED'],
    ];
    for (const [pending, code] of cases) {
      const { reply, calls } = await gate(pending);
      assertContextDenied(reply, code);
      assert.equal(calls, 0, code);
    }
  });
});

describe('TRADE-03 on the shipped Host — CORE-05 approvals and emergency control are reused, never bypassed (N, O, SEC-TRADE03-16/17)', () => {
  it('N: an order marked for review is withheld by the existing CORE-05 approval gate, with zero adapter calls', async () => {
    const { reply, calls } = await submit({ proposal: order(), profile: hostProfile({}, hostPair({ approval: { restricted: true } })) });
    assert.equal(context.assessments.at(-1), 'SATISFIED/APPROVAL_REQUIRED');
    assert.equal(reply.body['status'], 'withheld', reply.text);
    assert.equal(reply.body['withheldBy'], 'approval', reply.text);
    assert.equal(calls, 0);
  });

  it('N: notional above the review threshold (3000 XRP) goes to approval; within it, it does not', async () => {
    const above = await submit({ proposal: sellToken('1000', '2000000000'), profile: hostProfile({}, hostPair({ approval: { restricted: false, notionalAbove: '1999' } })) });
    assert.equal(context.assessments.at(-1), 'SATISFIED/APPROVAL_REQUIRED');
    assert.equal(above.reply.body['withheldBy'], 'approval', above.reply.text);
    assert.equal(above.calls, 0);
  });

  it('approval never lifts a prohibition: a restricted pair with a violated price is denied, never sent for approval', async () => {
    const { reply, calls } = await submit({ proposal: sellToken('100', '180000000'), profile: hostProfile({}, hostPair({ approval: { restricted: true } })) });
    assert.equal(context.assessments.at(-1), 'VIOLATED/PROHIBITED');
    await assertBoundaryHeld(reply, { status: 'unresolved', key: F.assessedProposal });
    assert.equal(calls, 0);
  });

  it('O: an emergency stop on the owner account withholds a fully satisfied order; release restores it', async () => {
    const stop = await admin('/api/admin/emergency-controls/activate', { scope: 'resource', value: RESOURCE });
    assert.equal(stop.status, 200, stop.text);
    try {
      const { reply, calls } = await submit({ proposal: order() });
      assert.equal(context.assessments.at(-1), 'SATISFIED/ELIGIBLE');
      assert.equal(reply.body['status'], 'withheld', reply.text);
      assert.equal(reply.body['withheldBy'], 'emergency-control', reply.text);
      assert.equal(calls, 0);
    } finally {
      const release = await admin('/api/admin/emergency-controls/release', { scope: 'resource', value: RESOURCE });
      assert.equal(release.status, 200, release.text);
    }
    assert.equal((await submit({ proposal: order() })).reply.body['status'], 'executed');
  });

  it('O: an organization-wide stop and a trading-desk (agent actor) stop withhold trading; a stop on another owner account does not apply', async () => {
    const otherOwner = `${NETWORK}:rG8uoRH9uA6AJ6NRj8P4cJG1HNfYcnMPrt`;
    assert.equal((await admin('/api/admin/emergency-controls/activate', { scope: 'resource', value: otherOwner })).status, 200);
    try {
      assert.equal((await submit({ proposal: order() })).reply.body['status'], 'executed', 'a stop on another owner account does not halt this one');
    } finally {
      await admin('/api/admin/emergency-controls/release', { scope: 'resource', value: otherOwner });
    }
    for (const scope of [{ scope: 'organization', value: ORG }, { scope: 'actor', value: AGENT }]) {
      const activated = await admin('/api/admin/emergency-controls/activate', scope);
      assert.equal(activated.status, 200, activated.text);
      try {
        const { reply, calls } = await submit({ proposal: order() });
        assert.equal(reply.body['withheldBy'], 'emergency-control', `${scope.scope}: ${reply.text}`);
        assert.equal(calls, 0);
      } finally {
        await admin('/api/admin/emergency-controls/release', scope);
      }
    }
  });

  it('SEC-TRADE03-17: an order marked for review under an active stop is not executed', async () => {
    assert.equal((await admin('/api/admin/emergency-controls/activate', { scope: 'resource', value: RESOURCE })).status, 200);
    try {
      const { reply, calls } = await submit({ proposal: order(), profile: hostProfile({}, hostPair({ approval: { restricted: true } })) });
      assert.equal(reply.body['status'], 'withheld', reply.text);
      assert.equal(calls, 0);
    } finally {
      await admin('/api/admin/emergency-controls/release', { scope: 'resource', value: RESOURCE });
    }
  });
});
