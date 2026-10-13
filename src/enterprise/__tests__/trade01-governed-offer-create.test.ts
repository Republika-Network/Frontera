import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createFinancialActionClassifier, createMonetaryAssetRegistry } from '../../features/monetary-runtime/index.js';
import {
  TRADE_PARAMETER_DIMENSIONS,
  TRADE_PARAMETER_DIMENSION_IDS as D,
  TRADE_PROFILE_PARAMETERS,
  TRADE_PROPOSAL_SCHEMA,
  TRADE_RESERVED_CONTEXT_KEYS,
  compileTradeProposal,
  createTradeGovernanceBinding,
  type TradeGovernedActionIntent,
} from '../../features/trade-runtime/index.js';
import { createGovernanceProfileRegistry } from '../governance-profile/index.js';
import { validateGovernedActionIntent, type GovernedActionIntent } from '../governed-action/index.js';

/**
 * TRADE-01 — a compiled trading proposal is an ordinary governed action.
 *
 * What a host would compose for the trading vertical — P9 classification and
 * assets, the CORE-03 trade dimensions and one profile over the governed
 * owner accounts — and the **unchanged** envelope validator run over the
 * compiler's output. No orchestrator, Kernel, grant, adapter or network is
 * involved: TRADE-01 delivers the contract, and this proves the contract
 * lands on CORE's existing axes without any CORE change.
 */

const ACTION = 'trade.offer-create';
const OWNER = 'rf1BiGeXwwQoi8Z2ueFYTEXSwuJYfV2Jpn';
const DELEGATE = 'ra5nK24KXen9AHvsdFTKHSANinZseWnPcX';
const ISSUER = 'rvYAfWj5gh67oV6fW32ZzP3Aw4Eubs59B';
const ORG = 'org-acme';
const BINDING = createTradeGovernanceBinding({ action: ACTION });
const IDENTITY = Object.freeze({ organizationId: ORG, principalId: 'agent-mm-01' });

const TRUST = Object.freeze({
  assets: createMonetaryAssetRegistry([
    { assetId: 'xrp-ledger-testnet:XRP', scale: 6 },
    { assetId: `xrp-ledger-testnet:USD/${ISSUER}`, scale: 6 },
  ]),
  actionClassifier: createFinancialActionClassifier({ financialActions: [ACTION] }),
});

const GOVERNANCE = createGovernanceProfileRegistry({
  parameterDimensions: TRADE_PARAMETER_DIMENSIONS,
  actionClasses: [{ id: 'place-order', actions: [ACTION] }],
  resourceClasses: [{ id: 'trading-account', resources: [`xrp-ledger-testnet:${OWNER}`] }],
  profiles: [
    {
      profileId: 'governed-trading',
      version: 1,
      owner: ORG,
      provenance: { authoredBy: 'operator:trading-desk', approvedBy: 'operator:security' },
      actionClass: 'place-order',
      resourceClass: 'trading-account',
      parameters: TRADE_PROFILE_PARAMETERS,
      materialFacts: [],
      relevantPolicies: [],
    },
  ],
  reservedContextKeys: TRADE_RESERVED_CONTEXT_KEYS,
});

function compiled(overrides: Record<string, unknown> = {}): TradeGovernedActionIntent {
  return compileTradeProposal(
    {
      schema: TRADE_PROPOSAL_SCHEMA,
      organizationId: ORG,
      principalId: 'agent-mm-01',
      requestId: 'req-0001',
      idempotencyKey: 'offer-0001',
      network: 'xrp-ledger-testnet',
      ownerAccount: OWNER,
      delegateAccount: DELEGATE,
      permission: 'OfferCreate',
      takerGets: { currency: 'XRP', drops: '125000000' },
      takerPays: { currency: 'USD', issuer: ISSUER, value: '50' },
      requestedValiditySeconds: 60,
      ...overrides,
    },
    BINDING,
    IDENTITY,
  ).intent;
}

function violationsOf(intent: unknown): readonly string[] {
  const result = validateGovernedActionIntent(intent, TRUST, GOVERNANCE);
  assert.equal(result.valid, false, 'expected the envelope to refuse');
  return result.valid ? [] : result.violations;
}

describe('TRADE-01 — the compiled proposal is accepted by the unchanged governed-action envelope', () => {
  it('is assignable to GovernedActionIntent (compile-time) and validates as a financial, semantically classified action', () => {
    const intent: GovernedActionIntent = compiled();
    const result = validateGovernedActionIntent(intent, TRUST, GOVERNANCE);
    assert.equal(result.valid, true, JSON.stringify(result));
    if (!result.valid) return;
    assert.equal(result.intent.actionClass, 'financial');
    assert.deepEqual(result.intent.amount, { value: '125', unit: 'xrp-ledger-testnet:XRP' });
    assert.equal(result.intent.semantics?.actionClass, 'place-order');
    assert.equal(result.intent.semantics?.resourceClass, 'trading-account');
    assert.equal(result.intent.semantics?.governanceProfile.id, 'governed-trading');
    const parameters = new Map((result.intent.parameters ?? []).map((parameter) => [parameter.dimension, parameter]));
    assert.equal(parameters.size, Object.keys(D).length);
    for (const parameter of parameters.values()) assert.equal(parameter.bound, 'exact', parameter.dimension);
    assert.equal(parameters.get(D.proposalDigest)?.value, intent.parameters?.[D.proposalDigest]);
  });

  it('a sell of the issued asset is governed on the issued asset — the amount the owner gives up', () => {
    const intent = compiled({ takerGets: { currency: 'USD', issuer: ISSUER, value: '50' }, takerPays: { currency: 'XRP', drops: '125000000' } });
    const result = validateGovernedActionIntent(intent, TRUST, GOVERNANCE);
    assert.equal(result.valid, true, JSON.stringify(result));
    if (result.valid) assert.deepEqual(result.intent.amount, { value: '50', unit: `xrp-ledger-testnet:USD/${ISSUER}` });
  });

  it('P9 stays the authority on assets: an unregistered issuer, or more fractional digits than the registry scale, is refused — never rounded', () => {
    assert.ok(violationsOf(compiled({ takerGets: { currency: 'EUR', issuer: ISSUER, value: '50' }, takerPays: { currency: 'XRP', drops: '1' } })).some((message) => /not an asset this deployment recognizes/.test(message)));
    assert.ok(violationsOf(compiled({ takerGets: { currency: 'USD', issuer: ISSUER, value: '0.0000001' }, takerPays: { currency: 'XRP', drops: '1' } })).some((message) => /refused, never rounded/.test(message)));
  });

  it('an owner account the host did not classify is refused, not governed as something less', () => {
    const intent = { ...compiled(), resource: `xrp-ledger-testnet:${ISSUER}` };
    assert.ok(violationsOf(intent).length > 0);
  });

  it('a tampered or extended parameter set is refused by the envelope', () => {
    const intent = compiled();
    assert.ok(violationsOf({ ...intent, parameters: { ...intent.parameters, tradeLimitPrice: '2' } }).some((message) => /does not declare/.test(message)));
    const withoutDigest: Record<string, string> = { ...intent.parameters };
    delete withoutDigest[D.proposalDigest];
    assert.ok(violationsOf({ ...intent, parameters: withoutDigest }).some((message) => /is required/.test(message)));
  });

  it('asserted context can never carry a trade dimension or a trade fact claim (configured reserved keys)', () => {
    const intent = compiled();
    for (const key of [D.proposalDigest, D.quantity, 'referencePrice', 'delegationVerified', 'exposure']) {
      assert.ok(violationsOf({ ...intent, assertedContext: { [key]: 'x' } }).length > 0, key);
    }
  });
});
