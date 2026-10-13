import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createParameterDimensionRegistry, parseGovernedParameterValue } from '../../governed-parameter-runtime/index.js';
import {
  TRADE_COMPILATION_REFUSALS as R,
  TRADE_PARAMETER_DIMENSIONS,
  TRADE_PARAMETER_DIMENSION_IDS as D,
  TRADE_PROFILE_PARAMETERS,
  TRADE_PROPOSAL_SCHEMA,
  TRADE_PROPOSAL_VIOLATIONS as V,
  TradeConfigurationError,
  TradeProposalRefusedError,
  compileTradeProposal,
  createTradeGovernanceBinding,
  validateTradeProposal,
} from '../index.js';

/**
 * TRADE-01 — the pure compiler from a trading proposal onto the generic
 * governed-action envelope. The enterprise test
 * `src/enterprise/__tests__/trade01-governed-offer-create.test.ts` proves the
 * envelope validator accepts what this produces.
 */

const OWNER = 'rf1BiGeXwwQoi8Z2ueFYTEXSwuJYfV2Jpn';
const DELEGATE = 'ra5nK24KXen9AHvsdFTKHSANinZseWnPcX';
const ISSUER = 'rvYAfWj5gh67oV6fW32ZzP3Aw4Eubs59B';
const BINDING = createTradeGovernanceBinding({ action: 'trade.offer-create' });
const IDENTITY = Object.freeze({ organizationId: 'org-acme', principalId: 'agent-mm-01' });

function proposal(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: TRADE_PROPOSAL_SCHEMA,
    organizationId: 'org-acme',
    principalId: 'agent-mm-01',
    requestId: 'req-0001',
    idempotencyKey: 'offer-0001',
    network: 'xrp-ledger-testnet',
    ownerAccount: OWNER,
    delegateAccount: DELEGATE,
    permission: 'OfferCreate',
    takerGets: { currency: 'USD', issuer: ISSUER, value: '50' },
    takerPays: { currency: 'XRP', drops: '125000000' },
    requestedValiditySeconds: 60,
    ...overrides,
  };
}

function refusalCodes(run: () => unknown): readonly string[] {
  try {
    run();
  } catch (error) {
    assert.ok(error instanceof TradeProposalRefusedError, String(error));
    return error.violations.map((violation) => violation.code);
  }
  return assert.fail('expected a refusal');
}

describe('TRADE-01 — compiling a proposal onto the governed-action envelope', () => {
  it('maps every field onto an existing envelope axis, deterministically and frozen', () => {
    const { intent, accepted } = compileTradeProposal(proposal(), BINDING, IDENTITY);
    assert.deepEqual(intent, {
      action: 'trade.offer-create',
      resource: `xrp-ledger-testnet:${OWNER}`,
      amount: { value: '50', currency: `xrp-ledger-testnet:USD/${ISSUER}` },
      parameters: {
        tradeBaseAsset: `USD.${ISSUER}`,
        tradeDelegateAccount: DELEGATE,
        tradeNetwork: 'xrp-ledger-testnet',
        tradeProposalDigest: accepted.digest,
        tradeQuantity: '50',
        tradeQuoteAsset: 'XRP',
        tradeSide: 'sell',
      },
      idempotencyKey: 'offer-0001',
      correlationId: 'req-0001',
    });
    assert.ok(Object.isFrozen(intent) && Object.isFrozen(intent.amount) && Object.isFrozen(intent.parameters));
    assert.deepEqual(compileTradeProposal(proposal(), BINDING, IDENTITY), compileTradeProposal(proposal(), BINDING, IDENTITY));
  });

  it('the governed amount is always what the owner gives up, in its own unit — XRP in XRP, never drops', () => {
    const buy = compileTradeProposal(proposal({ takerGets: { currency: 'XRP', drops: '125000000' }, takerPays: { currency: 'USD', issuer: ISSUER, value: '50' } }), BINDING, IDENTITY);
    assert.deepEqual(buy.intent.amount, { value: '125', currency: 'xrp-ledger-testnet:XRP' });
    assert.equal(buy.intent.parameters[D.side], 'buy');
    assert.equal(buy.intent.parameters[D.quantity], '50', 'quantity is the base (USD) the owner receives');
  });

  it('every emitted parameter is a well-formed token of a declared exact dimension', () => {
    const registry = createParameterDimensionRegistry(TRADE_PARAMETER_DIMENSIONS);
    const { intent } = compileTradeProposal(proposal({ takerGets: { currency: '524C555344000000000000000000000000000000', issuer: ISSUER, value: '0.000000000000000000000000000000001' } }), BINDING, IDENTITY);
    assert.deepEqual(Object.keys(intent.parameters).sort(), Object.values(D).sort());
    for (const [dimension, value] of Object.entries(intent.parameters)) {
      const declaration = registry.get(dimension);
      assert.ok(declaration !== undefined && declaration.type === 'token' && declaration.bound === 'exact', dimension);
      assert.equal(parseGovernedParameterValue('token', value).valid, true, `${dimension}=${value}`);
    }
    assert.deepEqual(TRADE_PROFILE_PARAMETERS.map((parameter) => parameter.required), Object.values(D).map(() => true));
  });

  it('the proposal digest — the exact-order binding — changes whenever any bound field changes, even ones no other parameter carries', () => {
    const reference = compileTradeProposal(proposal(), BINDING, IDENTITY).intent.parameters[D.proposalDigest];
    for (const overrides of [{ flags: ['fill-or-kill'] }, { expiration: 5 }, { requestedValiditySeconds: 30 }, { takerPays: { currency: 'XRP', drops: '125000001' } }]) {
      assert.notEqual(compileTradeProposal(proposal(overrides), BINDING, IDENTITY).intent.parameters[D.proposalDigest], reference, JSON.stringify(overrides));
    }
  });

  it('emits no asserted context: compilation can never state a trusted fact', () => {
    const { intent } = compileTradeProposal(proposal({ referenceContextId: 'snap-9', policyContextRef: 'desk-2' }), BINDING, IDENTITY);
    assert.equal('assertedContext' in intent, false);
    assert.equal(JSON.stringify(intent).includes('snap-9'), false, 'an applicant reference is bound inside the digest, not presented as context');
  });

  it('passes a profile pin through exactly, and refuses anything else in the envelope options', () => {
    const pinned = compileTradeProposal(proposal(), BINDING, IDENTITY, { expectedGovernanceProfile: { id: 'governed-trading', version: 2 } });
    assert.deepEqual(pinned.intent.expectedGovernanceProfile, { id: 'governed-trading', version: 2 });
    for (const envelope of [{ assertedContext: { referencePrice: '2' } }, { expectedGovernanceProfile: { id: 'x', version: 1, extra: 1 } }, { expectedGovernanceProfile: { id: 'x', version: 1.5 } }, 'x']) {
      assert.deepEqual(refusalCodes(() => compileTradeProposal(proposal(), BINDING, IDENTITY, envelope as never)), [R.ENVELOPE_OPTIONS_INVALID], JSON.stringify(envelope));
    }
  });
});

describe('TRADE-01 — the compiler refuses before anything is evaluated', () => {
  it('(24) refuses a proposal for another organization or principal than the bound identity', () => {
    assert.deepEqual(refusalCodes(() => compileTradeProposal(proposal(), BINDING, { organizationId: 'org-other', principalId: 'agent-mm-01' })), [R.ORGANIZATION_MISMATCH]);
    assert.deepEqual(refusalCodes(() => compileTradeProposal(proposal(), BINDING, { organizationId: 'org-acme', principalId: 'agent-other' })), [R.PRINCIPAL_MISMATCH]);
    assert.deepEqual(refusalCodes(() => compileTradeProposal(proposal(), BINDING, { organizationId: '', principalId: 'agent-mm-01' })), [R.IDENTITY_MALFORMED]);
  });

  it('refuses an invalid proposal with its validation codes, never values', () => {
    try {
      compileTradeProposal(proposal({ takerGets: { currency: 'USD', issuer: ISSUER, value: '1e3' }, secret: 'sEdTopSecretValue' }), BINDING, IDENTITY);
      assert.fail('expected a refusal');
    } catch (error) {
      assert.ok(error instanceof TradeProposalRefusedError);
      assert.deepEqual(error.violations.map((violation) => violation.code), [V.SECRET_PROPERTY_REFUSED]);
      assert.equal(error.message.includes('sEdTopSecretValue'), false);
    }
  });

  it('refuses a non-canonical binding at wiring time and at compile time', () => {
    for (const action of ['', 'has space', 'a/b', 7]) assert.throws(() => createTradeGovernanceBinding({ action } as never), TradeConfigurationError);
    assert.throws(() => compileTradeProposal(proposal(), { action: 'a b' }, IDENTITY), TradeConfigurationError);
  });

  it('compiling never mutates the caller object, and a compiled intent is independent of it', () => {
    const raw = proposal();
    const before = JSON.stringify(raw);
    const { intent } = compileTradeProposal(raw, BINDING, IDENTITY);
    assert.equal(JSON.stringify(raw), before);
    (raw['takerGets'] as Record<string, unknown>)['value'] = '5000';
    assert.equal(intent.amount.value, '50');
    assert.equal(validateTradeProposal(raw).valid, true);
  });
});
