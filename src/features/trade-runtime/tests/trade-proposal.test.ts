import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  TRADE_PROPOSAL_SCHEMA,
  TRADE_PROPOSAL_VIOLATIONS as V,
  canonicalTradePair,
  checkTradeAccountAddress,
  classifyTradeProposalReplay,
  formatTradePrice,
  parseTradeCurrencyCode,
  serializeTradeProposal,
  tradeProposalDigest,
  validateTradeProposal,
  type AcceptedTradeProposal,
} from '../index.js';

/**
 * TRADE-01 qualification, unit level: the closed OfferCreate proposal, exact
 * amounts and price, XRP Ledger amount direction, canonicalization and the
 * digest. Addresses are well-formed public account addresses used only as
 * format vectors; nothing here signs, submits or contacts a network.
 */

const OWNER = 'rf1BiGeXwwQoi8Z2ueFYTEXSwuJYfV2Jpn';
const DELEGATE = 'ra5nK24KXen9AHvsdFTKHSANinZseWnPcX';
const ISSUER = 'rvYAfWj5gh67oV6fW32ZzP3Aw4Eubs59B';
const ISSUER_B = 'rhub8VRN55s94qWKDv6jmDy1pUykJzF3wq';
const ACCOUNT_ZERO = 'rrrrrrrrrrrrrrrrrrrrrhoLvTp';
const HEX_CURRENCY = '524C555344000000000000000000000000000000';

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
    // The owner gives 100 XRP and wants 50 USD.
    takerGets: { currency: 'XRP', drops: '100000000' },
    takerPays: { currency: 'USD', issuer: ISSUER, value: '50' },
    requestedValiditySeconds: 60,
    ...overrides,
  };
}

function accepted(raw: unknown): AcceptedTradeProposal {
  const result = validateTradeProposal(raw);
  if (!result.valid) assert.fail(JSON.stringify(result.violations));
  return result.accepted;
}

function codes(raw: unknown): readonly string[] {
  const result = validateTradeProposal(raw);
  assert.equal(result.valid, false, 'expected a refusal');
  return result.valid ? [] : result.violations.map((violation) => violation.code);
}

describe('TRADE-01 — a valid proposal is accepted as one canonical, frozen contract', () => {
  it('(1) accepts a complete proposal and returns its canonical form, derived terms and digest', () => {
    const result = accepted(proposal({ flags: ['passive'], expiration: 900_000_000, referenceContextId: 'snap-7', policyContextRef: 'mm-desk' }));
    assert.deepEqual(result.proposal, {
      schema: TRADE_PROPOSAL_SCHEMA,
      organizationId: 'org-acme',
      principalId: 'agent-mm-01',
      requestId: 'req-0001',
      idempotencyKey: 'offer-0001',
      network: 'xrp-ledger-testnet',
      ownerAccount: OWNER,
      delegateAccount: DELEGATE,
      permission: 'OfferCreate',
      takerGets: { currency: 'XRP', drops: '100000000' },
      takerPays: { currency: 'USD', issuer: ISSUER, value: '50' },
      flags: ['passive'],
      expiration: 900_000_000,
      requestedValiditySeconds: 60,
      referenceContextId: 'snap-7',
      policyContextRef: 'mm-desk',
    });
    assert.ok(Object.isFrozen(result) && Object.isFrozen(result.proposal) && Object.isFrozen(result.proposal.takerGets) && Object.isFrozen(result.proposal.flags) && Object.isFrozen(result.terms));
    assert.match(result.digest, /^sha256:[0-9a-f]{64}$/);
    assert.equal(result.terms.flagsValue, 0x0001_0000);
  });

  it('the canonical proposal is itself valid input and validates to itself, with the same digest', () => {
    const first = accepted(proposal({ takerPays: { currency: 'USD', issuer: ISSUER, value: '50.00' } }));
    const again = accepted(first.proposal);
    assert.deepEqual(again.proposal, first.proposal);
    assert.equal(again.digest, first.digest);
  });

  it('(28) is deterministic across repeated invocations', () => {
    const digests = new Set(Array.from({ length: 20 }, () => accepted(proposal()).digest));
    assert.equal(digests.size, 1);
    assert.equal(serializeTradeProposal(accepted(proposal()).proposal), serializeTradeProposal(accepted(proposal()).proposal));
  });
});

describe('TRADE-01 — XRP Ledger OfferCreate direction: takerGets is what the owner gives, takerPays what it receives', () => {
  it('XRP → issued token: the owner sells XRP, so it BUYS the token (base), XRP being the quote', () => {
    const { terms } = accepted(proposal());
    assert.deepEqual(terms.base, { kind: 'issued', currency: 'USD', issuer: ISSUER });
    assert.deepEqual(terms.quote, { kind: 'xrp' });
    assert.equal(terms.side, 'buy');
    assert.equal(terms.quantity, '50', 'base quantity is the USD the owner receives');
    assert.equal(terms.counterQuantity, '100', 'XRP counted in XRP, never in drops');
    assert.equal(formatTradePrice(terms.limitPrice), '2/1', 'at most 2 XRP per USD');
  });

  it('issued token → XRP: the owner gives the base token, so it SELLS', () => {
    const { terms } = accepted(proposal({ takerGets: { currency: 'USD', issuer: ISSUER, value: '50' }, takerPays: { currency: 'XRP', drops: '100000000' } }));
    assert.equal(terms.side, 'sell');
    assert.equal(terms.quantity, '50');
    assert.equal(formatTradePrice(terms.limitPrice), '2/1', 'at least 2 XRP per USD');
  });

  it('issued token A → issued token B: orientation by token order, side relative to it', () => {
    // 'EUR.<issuer>' sorts before 'USD.<issuer>', so EUR is the base.
    const sellEur = accepted(proposal({ takerGets: { currency: 'EUR', issuer: ISSUER_B, value: '10' }, takerPays: { currency: 'USD', issuer: ISSUER, value: '11' } }));
    assert.equal(sellEur.terms.side, 'sell');
    assert.deepEqual(sellEur.terms.base, { kind: 'issued', currency: 'EUR', issuer: ISSUER_B });
    assert.equal(formatTradePrice(sellEur.terms.limitPrice), '11/10');
    const buyEur = accepted(proposal({ takerGets: { currency: 'USD', issuer: ISSUER, value: '11' }, takerPays: { currency: 'EUR', issuer: ISSUER_B, value: '10' } }));
    assert.equal(buyEur.terms.side, 'buy');
    assert.deepEqual(buyEur.terms.base, sellEur.terms.base);
    assert.equal(formatTradePrice(buyEur.terms.limitPrice), '11/10');
  });

  it('canonical pair orientation is independent of argument order', () => {
    const xrp = { kind: 'xrp' } as const;
    const usd = { kind: 'issued', currency: 'USD', issuer: ISSUER } as const;
    assert.deepEqual(canonicalTradePair(xrp, usd), canonicalTradePair(usd, xrp));
  });

  it('the price is an exact reduced fraction, never a rounded decimal', () => {
    const { terms } = accepted(proposal({ takerGets: { currency: 'USD', issuer: ISSUER, value: '3' }, takerPays: { currency: 'XRP', drops: '1000000' } }));
    assert.equal(formatTradePrice(terms.limitPrice), '1/3', '1 XRP for 3 USD — one third of an XRP per USD, exactly');
    const precise = accepted(proposal({ takerGets: { currency: 'USD', issuer: ISSUER, value: '0.3' }, takerPays: { currency: 'XRP', drops: '100000' } }));
    assert.equal(formatTradePrice(precise.terms.limitPrice), '1/3', '0.1 XRP for 0.3 USD is the same price, with no float in between');
  });

  it('(17) refuses a side assertion that contradicts the amounts, and accepts an agreeing one without changing the digest', () => {
    assert.deepEqual(codes(proposal({ side: 'sell' })), [V.SIDE_CONTRADICTS_AMOUNTS]);
    assert.deepEqual(codes(proposal({ side: 'short' })), [V.SIDE_MALFORMED]);
    assert.equal(accepted(proposal({ side: 'buy' })).digest, accepted(proposal()).digest);
  });

  it('reversed pair representation: an asserted pair must be the canonical orientation', () => {
    assert.deepEqual(codes(proposal({ pair: { base: { currency: 'XRP' }, quote: { currency: 'USD', issuer: ISSUER } } })), [V.PAIR_CONTRADICTS_AMOUNTS]);
    assert.equal(accepted(proposal({ pair: { base: { currency: 'USD', issuer: ISSUER }, quote: { currency: 'XRP' } } })).digest, accepted(proposal()).digest);
    assert.deepEqual(codes(proposal({ pair: { base: { currency: 'XRP', issuer: ISSUER }, quote: { currency: 'USD', issuer: ISSUER } } })), [V.PAIR_ASSERTION_MALFORMED]);
  });

  it('(16) refuses a malformed or contradicting limit-price assertion; accepts an equal unreduced one', () => {
    assert.equal(accepted(proposal({ limitPrice: { numerator: '4', denominator: '2' } })).digest, accepted(proposal()).digest);
    assert.deepEqual(codes(proposal({ limitPrice: { numerator: '3', denominator: '2' } })), [V.PRICE_CONTRADICTS_AMOUNTS]);
    for (const bad of [
      { numerator: '1', denominator: '0' },
      { numerator: '-1', denominator: '2' },
      { numerator: '1.5', denominator: '2' },
      { numerator: '01', denominator: '2' },
      { numerator: 2, denominator: 1 },
      { numerator: '1', denominator: '1', extra: '1' },
      { numerator: '1'.repeat(300), denominator: '1' },
      '2/1',
    ]) {
      assert.deepEqual(codes(proposal({ limitPrice: bad })), [V.PRICE_MALFORMED], JSON.stringify(bad));
    }
  });

  it('(9) refuses XRP for XRP, and (10) the same issued asset on both sides', () => {
    assert.deepEqual(codes(proposal({ takerPays: { currency: 'XRP', drops: '5' } })), [V.XRP_FOR_XRP]);
    assert.deepEqual(codes(proposal({ takerGets: { currency: 'USD', issuer: ISSUER, value: '1' }, takerPays: { currency: 'USD', issuer: ISSUER, value: '2' } })), [V.SAME_ASSET]);
    assert.deepEqual(
      codes(proposal({ takerGets: { currency: HEX_CURRENCY.toLowerCase(), issuer: ISSUER, value: '1' }, takerPays: { currency: HEX_CURRENCY, issuer: ISSUER, value: '2' } })),
      [V.SAME_ASSET],
      'one currency spelled in two cases is still one asset',
    );
    // Same currency, different issuers: two different assets, which may trade.
    accepted(proposal({ takerGets: { currency: 'USD', issuer: ISSUER, value: '1' }, takerPays: { currency: 'USD', issuer: ISSUER_B, value: '1' } }));
  });
});

describe('TRADE-01 — exact money: no float, no rounding, no exponent, bounded', () => {
  const issued = (value: unknown) => proposal({ takerPays: { currency: 'USD', issuer: ISSUER, value } });
  const drops = (value: unknown) => proposal({ takerGets: { currency: 'XRP', drops: value } });

  it('(11) refuses zero, (12) negative, and a JavaScript number', () => {
    assert.deepEqual(codes(issued('0')), [V.AMOUNT_NOT_POSITIVE]);
    assert.deepEqual(codes(issued('0.000')), [V.AMOUNT_NOT_POSITIVE]);
    assert.deepEqual(codes(drops('0')), [V.AMOUNT_NOT_POSITIVE]);
    assert.deepEqual(codes(issued('-5')), [V.AMOUNT_NOT_POSITIVE]);
    assert.deepEqual(codes(drops('-1')), [V.AMOUNT_NOT_POSITIVE]);
    assert.deepEqual(codes(issued(50)), [V.AMOUNT_NOT_TEXT]);
    assert.deepEqual(codes(drops(100000000)), [V.AMOUNT_NOT_TEXT]);
  });

  it('(15) refuses scientific notation, and other non-plain spellings, without repairing them', () => {
    for (const value of ['1e3', '1E3', '5e-1']) assert.deepEqual(codes(issued(value)), [V.AMOUNT_EXPONENT_NOT_ACCEPTED], value);
    for (const value of ['+5', ' 5', '5 ', '1,000', '1_000', '05', '.5', '5.', 'NaN', 'Infinity', '0x10', '٥', '']) assert.deepEqual(codes(issued(value)), [V.AMOUNT_MALFORMED], value);
    for (const value of ['0100', '1.0.0', 'abc']) assert.deepEqual(codes(drops(value)), [V.AMOUNT_MALFORMED], value);
  });

  it('(13) refuses more precision than the ledger stores, never rounding', () => {
    accepted(issued('1.234567890123456'));
    accepted(issued('1234567890123456000000'));
    assert.deepEqual(codes(issued('1.2345678901234567')), [V.AMOUNT_PRECISION_EXCEEDED], 'seventeen significant digits would be rounded by the ledger');
    assert.deepEqual(codes(issued('10000000000000001')), [V.AMOUNT_PRECISION_EXCEEDED]);
    assert.deepEqual(codes(drops('1.5')), [V.AMOUNT_PRECISION_EXCEEDED], 'a fraction of a drop does not exist');
  });

  it('(14) refuses overflow: beyond the ledger range or the XRP supply, and unbounded text', () => {
    accepted(issued(`9999999999999999${'0'.repeat(80)}`));
    assert.deepEqual(codes(issued(`1${'0'.repeat(96)}`)), [V.AMOUNT_OUT_OF_RANGE]);
    accepted(issued(`0.${'0'.repeat(80)}1`));
    assert.deepEqual(codes(issued(`0.${'0'.repeat(81)}1`)), [V.AMOUNT_OUT_OF_RANGE]);
    accepted(drops('100000000000000000'));
    assert.deepEqual(codes(drops('100000000000000001')), [V.AMOUNT_OUT_OF_RANGE]);
    assert.deepEqual(codes(issued('9'.repeat(300))), [V.AMOUNT_MALFORMED]);
    assert.deepEqual(codes(drops('9'.repeat(300))), [V.AMOUNT_MALFORMED]);
  });

  it('values above 2^53 stay exact', () => {
    const big = accepted(proposal({ takerGets: { currency: 'XRP', drops: '90071992547409930' } }));
    assert.equal(big.terms.counterQuantity, '90071992547.40993');
  });
});

describe('TRADE-01 — assets: currency and issuer validation', () => {
  const usd = (overrides: Record<string, unknown>) => proposal({ takerPays: { currency: 'USD', issuer: ISSUER, value: '50', ...overrides } });

  it('(6) refuses malformed currency codes, including any issued spelling of XRP', () => {
    assert.deepEqual(codes(usd({ currency: 'XRP' })), [V.ISSUER_NOT_ALLOWED_FOR_XRP], 'XRP never has an issuer');
    for (const currency of ['US', 'USDX', 'xrp', 'Xrp', 'xRP', 'U$D', '', '0000000000000000000000000000000000000000', '0055534400000000000000000000000000000000', 'G'.repeat(40), 7]) {
      assert.deepEqual(codes(usd({ currency })), [V.CURRENCY_MALFORMED], String(currency));
    }
    assert.deepEqual(parseTradeCurrencyCode(HEX_CURRENCY.toLowerCase()), { valid: true, currency: HEX_CURRENCY });
    assert.deepEqual(parseTradeCurrencyCode('usd'), { valid: true, currency: 'usd' }, 'three-character codes are case-sensitive on the ledger and kept exactly');
  });

  it('(7) refuses an issued amount with no issuer, and (8) a malformed or reserved issuer', () => {
    assert.deepEqual(codes(proposal({ takerPays: { currency: 'USD', value: '50' } })), [V.ISSUER_MISSING]);
    assert.deepEqual(codes(usd({ issuer: 'rNotAnAddress' })), [V.ISSUER_MALFORMED]);
    assert.deepEqual(codes(usd({ issuer: `${ISSUER.slice(0, -1)}C` })), [V.ISSUER_MALFORMED], 'checksum failure');
    assert.deepEqual(codes(usd({ issuer: ACCOUNT_ZERO })), [V.ISSUER_RESERVED]);
    assert.deepEqual(codes(proposal({ takerGets: { currency: 'XRP', drops: '1', issuer: ISSUER } })), [V.ISSUER_NOT_ALLOWED_FOR_XRP]);
    assert.deepEqual(codes(proposal({ takerGets: { currency: 'XRP', value: '1' } })), [V.AMOUNT_FIELDS_INVALID], 'XRP is stated in drops');
    assert.deepEqual(codes(usd({ drops: '1' })), [V.AMOUNT_FIELDS_INVALID]);
  });
});

describe('TRADE-01 — accounts, network, permission, schema and identity', () => {
  it('(2) refuses any network other than XRP Ledger Testnet or Devnet — mainnet is not representable', () => {
    for (const network of ['xrp-ledger-mainnet', 'mainnet', 'testnet', 'XRP-LEDGER-TESTNET', 0, 1, undefined]) {
      const raw = proposal({ network });
      if (network === undefined) delete raw['network'];
      assert.deepEqual(codes(raw), [network === undefined ? V.MISSING_FIELD : V.NETWORK_UNSUPPORTED], String(network));
    }
    accepted(proposal({ network: 'xrp-ledger-devnet' }));
  });

  it('(3)(4) refuses malformed owner and delegate addresses; (5) refuses an owner that is its own delegate', () => {
    assert.deepEqual(codes(proposal({ ownerAccount: 'not-an-address' })), [V.ACCOUNT_MALFORMED]);
    assert.deepEqual(codes(proposal({ delegateAccount: `${DELEGATE}x` })), [V.ACCOUNT_MALFORMED]);
    assert.deepEqual(codes(proposal({ delegateAccount: 'X7AcgcsBL6XDcUb289X4mJ8djcdyKaB5hJDWMArnXr61cqZ' })), [V.ACCOUNT_MALFORMED], 'an X-address is not a classic address');
    assert.deepEqual(codes(proposal({ ownerAccount: ACCOUNT_ZERO })), [V.ACCOUNT_RESERVED]);
    assert.deepEqual(codes(proposal({ delegateAccount: OWNER })), [V.OWNER_IS_DELEGATE]);
    assert.equal(checkTradeAccountAddress(OWNER), 'valid');
  });

  it('refuses any delegated permission other than OfferCreate', () => {
    for (const permission of ['OfferCancel', 'Payment', 'offercreate', 8]) assert.deepEqual(codes(proposal({ permission })), [V.PERMISSION_UNSUPPORTED], String(permission));
  });

  it('(26) refuses an unknown schema version', () => {
    for (const schema of ['frontera.trade-proposal.v2', 'frontera.trade-proposal.v0', '', 1]) assert.deepEqual(codes(proposal({ schema })), [V.SCHEMA_UNSUPPORTED], String(schema));
  });

  it('(25) refuses missing or invalid mandatory fields, naming every one', () => {
    const raw = proposal();
    delete raw['takerGets'];
    delete raw['idempotencyKey'];
    assert.deepEqual([...codes(raw)].sort(), [V.MISSING_FIELD, V.MISSING_FIELD]);
    for (const field of ['organizationId', 'principalId', 'requestId', 'idempotencyKey']) {
      for (const value of ['', 'has space', 'a/b', 'x'.repeat(129), 7, 'Bearer abc', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl']) {
        assert.deepEqual(codes(proposal({ [field]: value })), [V.IDENTIFIER_MALFORMED], `${field}=${String(value)}`);
      }
    }
    for (const requestedValiditySeconds of [0, 3601, 1.5, '60', -1]) assert.deepEqual(codes(proposal({ requestedValiditySeconds })), [V.VALIDITY_OUT_OF_RANGE]);
    for (const expiration of [0, 2 ** 32, 1.5, '900']) assert.deepEqual(codes(proposal({ expiration })), [V.EXPIRATION_MALFORMED]);
    assert.deepEqual(codes(proposal({ referenceContextId: 'has space' })), [V.REFERENCE_MALFORMED]);
  });
});

describe('TRADE-01 — the transaction field allowlist is closed', () => {
  it('(18) refuses unsupported, duplicated and conflicting flags', () => {
    assert.deepEqual(codes(proposal({ flags: ['hybrid'] })), [V.FLAG_UNSUPPORTED]);
    assert.deepEqual(codes(proposal({ flags: ['tfPassive'] })), [V.FLAG_UNSUPPORTED]);
    assert.deepEqual(codes(proposal({ flags: [65536] })), [V.FLAG_UNSUPPORTED], 'flags are named, never a raw bit field');
    assert.deepEqual(codes(proposal({ flags: 65536 })), [V.FLAGS_MALFORMED]);
    assert.deepEqual(codes(proposal({ flags: ['passive', 'passive'] })), [V.FLAG_DUPLICATED]);
    assert.deepEqual(codes(proposal({ flags: ['immediate-or-cancel', 'fill-or-kill'] })), [V.FLAGS_CONFLICT]);
    const all = accepted(proposal({ flags: ['sell', 'fill-or-kill', 'passive'] }));
    assert.deepEqual(all.proposal.flags, ['passive', 'fill-or-kill', 'sell'], 'canonical order: ascending ledger bit');
    assert.equal(all.terms.flagsValue, 0x0001_0000 + 0x0004_0000 + 0x0008_0000);
  });

  it('(19) refuses injected transaction fields — the execution adapter alone sets them', () => {
    for (const field of ['Fee', 'fee', 'Sequence', 'TicketSequence', 'LastLedgerSequence', 'OfferSequence', 'DomainID', 'SigningPubKey', 'TxnSignature', 'Signers', 'Memos', 'Flags', 'Account', 'Delegate', 'TransactionType', 'TakerGets', 'tx_json', 'tx_blob', 'NetworkID']) {
      assert.deepEqual(codes(proposal({ [field]: 'x' })), [V.EXECUTION_FIELD_REFUSED], field);
    }
    assert.deepEqual(codes(proposal({ comment: 'hello' })), [V.UNDECLARED_PROPERTY]);
    assert.deepEqual(codes(proposal({ takerPays: { currency: 'USD', issuer: ISSUER, value: '50', Fee: '12' } })), [V.AMOUNT_FIELDS_INVALID]);
  });

  it('(23) refuses claims of trusted facts — a trading engine is not its own oracle, exposure authority or delegation verifier', () => {
    for (const field of ['referencePrice', 'marketPrice', 'oraclePrice', 'exposure', 'openExposure', 'activeOrders', 'delegationVerified', 'delegationProof', 'approved', 'policyDecision', 'grant', 'trustedContext', 'riskScore', 'balance']) {
      assert.deepEqual(codes(proposal({ [field]: 'x' })), [V.TRUSTED_FACT_CLAIM_REFUSED], field);
    }
  });

  it('refuses secret-shaped properties without reading them', () => {
    let read = false;
    const raw = proposal();
    Object.defineProperty(raw, 'seed', { enumerable: true, get: () => ((read = true), 'sEd...') });
    assert.deepEqual(codes(raw), [V.ACCESSOR_PROPERTY]);
    assert.equal(read, false, 'an accessor is never run');
    for (const field of ['seed', 'secret', 'privateKey', 'mnemonic', 'signingKey']) assert.deepEqual(codes(proposal({ [field]: 'x' })), [V.SECRET_PROPERTY_REFUSED], field);
  });

  it('(27) refuses prototype pollution and dangerous keys, symbols, and non-plain objects', () => {
    const polluted = JSON.parse(`{"__proto__":{"admin":true},${JSON.stringify(proposal()).slice(1)}`) as unknown;
    assert.deepEqual(codes(polluted), [V.DANGEROUS_PROPERTY]);
    assert.deepEqual(codes(proposal({ constructor: 'x' })), [V.DANGEROUS_PROPERTY]);
    assert.deepEqual(codes(proposal({ prototype: 'x' })), [V.DANGEROUS_PROPERTY]);
    const nestedPollution = JSON.parse(JSON.stringify(proposal()).replace('"value":"50"', '"value":"50","__proto__":{"x":1}')) as unknown;
    assert.deepEqual(codes(nestedPollution), [V.AMOUNT_FIELDS_INVALID]);
    assert.deepEqual(codes({ ...proposal(), [Symbol('x')]: 1 }), [V.SYMBOL_PROPERTY]);
    assert.deepEqual(codes(new (class Proposal {})()), [V.NOT_AN_OBJECT]);
    assert.deepEqual(codes([proposal()]), [V.NOT_AN_OBJECT]);
    assert.deepEqual(codes(null), [V.NOT_AN_OBJECT]);
    assert.equal(({} as Record<string, unknown>)['admin'], undefined, 'Object.prototype is untouched');
  });
});

describe('TRADE-01 — canonicalization preserves economic meaning', () => {
  it('(21) equivalent inputs — decimal spelling, hex case, key order, flag order, absent vs empty flags, agreeing assertions — share one canonical form and digest', () => {
    const base = accepted(proposal({ takerPays: { currency: HEX_CURRENCY, issuer: ISSUER, value: '50' }, flags: ['passive', 'sell'] }));
    const respelled = proposal({ takerPays: { value: '50.000', issuer: ISSUER, currency: HEX_CURRENCY.toLowerCase() }, flags: ['sell', 'passive'], side: 'buy' });
    const variant = accepted(Object.fromEntries(Object.entries(respelled).reverse()));
    assert.deepEqual(variant.proposal, base.proposal);
    assert.equal(variant.digest, base.digest);
    assert.equal(accepted(proposal({ flags: [] })).digest, accepted(proposal()).digest);
  });

  it('(22) economically different proposals never share a digest — every bound field changes it', () => {
    const reference = accepted(proposal()).digest;
    const variants: Record<string, unknown>[] = [
      { organizationId: 'org-other' },
      { principalId: 'agent-other' },
      { requestId: 'req-0002' },
      { idempotencyKey: 'offer-0002' },
      { network: 'xrp-ledger-devnet' },
      { ownerAccount: ISSUER_B },
      { delegateAccount: ISSUER_B },
      { takerGets: { currency: 'XRP', drops: '100000001' } },
      { takerPays: { currency: 'USD', issuer: ISSUER, value: '50.0000001' } },
      { takerPays: { currency: 'USD', issuer: ISSUER_B, value: '50' } },
      { takerPays: { currency: 'usd', issuer: ISSUER, value: '50' } },
      { takerPays: { currency: 'EUR', issuer: ISSUER, value: '50' } },
      { flags: ['passive'] },
      { expiration: 1 },
      { requestedValiditySeconds: 61 },
      { referenceContextId: 'snap-1' },
      { policyContextRef: 'desk-1' },
    ];
    const digests = new Set([reference]);
    for (const overrides of variants) digests.add(accepted(proposal(overrides)).digest);
    assert.equal(digests.size, variants.length + 1);
    // Swapping what is given and what is received is a different order, not a reformatting.
    const swapped = accepted(proposal({ takerGets: { currency: 'USD', issuer: ISSUER, value: '50' }, takerPays: { currency: 'XRP', drops: '100000000' } }));
    assert.notEqual(swapped.digest, reference);
  });

  it('the digest is domain-separated and computed over the canonical proposal only', () => {
    const result = accepted(proposal());
    assert.equal(tradeProposalDigest(result.proposal), result.digest);
    assert.ok(!serializeTradeProposal(result.proposal).includes(' '), 'no whitespace in canonical bytes');
  });

  it('(20) request identity collision: one idempotency key can never name two different orders', () => {
    const first = accepted(proposal());
    assert.equal(classifyTradeProposalReplay(first, accepted(proposal())), 'replay');
    assert.equal(classifyTradeProposalReplay(first, accepted(proposal({ takerPays: { currency: 'USD', issuer: ISSUER, value: '51' } }))), 'conflict');
    assert.equal(classifyTradeProposalReplay(first, accepted(proposal({ idempotencyKey: 'offer-0002' }))), 'distinct');
    assert.equal(classifyTradeProposalReplay(first, accepted(proposal({ organizationId: 'org-other' }))), 'distinct', 'keys are scoped per organization');
  });
});
