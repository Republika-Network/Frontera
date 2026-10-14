import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  DELEGATED_OFFER_ALLOWED_FLAGS,
  DELEGATED_OFFER_OPTIONAL_FIELDS,
  DELEGATED_OFFER_REQUIRED_FIELDS,
  DELEGATED_OFFER_SIGNER_OPERATION,
  DELEGATED_OFFER_SIGNER_PATHS,
  DELEGATED_OFFER_SIGNER_PROTOCOL,
  parseDelegatedOfferSignerIdentity,
  parseDelegatedOfferSigningRequest,
  parseDelegatedOfferSigningResponse,
  parsePreparedDelegatedOffer,
} from '../xrpl-trade-rail/index.js';
import { TRADE_OFFER_FLAGS } from '../../features/trade-runtime/index.js';
import { EXTERNAL_XRPL_SIGNER_OPERATION, EXTERNAL_XRPL_SIGNER_PATHS, EXTERNAL_XRPL_SIGNER_PROTOCOL } from '../xrpl-payment-rail/signer-protocol.js';
import { AUDIT, offerWorld, testAccount } from './trade04b-xrpl-fixture.js';

/**
 * TRADE-04B — the closed protocol (adversarial matrix A) and the closed
 * prepared OfferCreate (matrix B). Every refusal is `undefined`; nothing is
 * repaired. Each negative case changes exactly one thing from a valid
 * control that is itself asserted to pass.
 */

const world = offerWorld();
const KEY = world.delegate.publicKey;

const identity = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  protocol: DELEGATED_OFFER_SIGNER_PROTOCOL,
  signerId: 'customer-a-signer-1',
  operations: [DELEGATED_OFFER_SIGNER_OPERATION],
  network: 'xrp-ledger-testnet',
  pairs: [{ ownerAccount: world.owner, delegateAccount: world.delegate.address, signingPublicKey: KEY }],
  ...overrides,
});

const request = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  protocol: DELEGATED_OFFER_SIGNER_PROTOCOL,
  signerId: 'customer-a-signer-1',
  requestId: 'a1'.repeat(32),
  network: 'xrp-ledger-testnet',
  ownerAccount: world.owner,
  delegateAccount: world.delegate.address,
  transaction: { ...world.offer() },
  audit: { ...AUDIT },
  ...overrides,
});

describe('TRADE-04B A — protocol grammar: identity', () => {
  it('a valid closed identity parses, frozen, and is distinct from PAY-03’s protocol', () => {
    const parsed = parseDelegatedOfferSignerIdentity(identity());
    assert.ok(parsed !== undefined);
    assert.ok(Object.isFrozen(parsed) && Object.isFrozen(parsed.pairs) && Object.isFrozen(parsed.pairs[0]));
    assert.notEqual(DELEGATED_OFFER_SIGNER_PROTOCOL, EXTERNAL_XRPL_SIGNER_PROTOCOL);
    assert.notEqual(DELEGATED_OFFER_SIGNER_OPERATION, EXTERNAL_XRPL_SIGNER_OPERATION);
    assert.equal(DELEGATED_OFFER_SIGNER_PATHS.signDelegatedOffer, '/v1/sign/xrpl-delegated-offer');
    assert.notEqual(DELEGATED_OFFER_SIGNER_PATHS.signDelegatedOffer, EXTERNAL_XRPL_SIGNER_PATHS.signPayment);
  });

  const cases: readonly [string, unknown][] = [
    ['missing protocol version', (() => { const { protocol: _p, ...rest } = identity(); return rest; })()],
    ['wrong protocol version', identity({ protocol: 'frontera.xrpl-delegated-offer-signer.v2' })],
    ['the Payment protocol', identity({ protocol: EXTERNAL_XRPL_SIGNER_PROTOCOL })],
    ['wrong operation', identity({ operations: ['sign-xrpl-payment'] })],
    ['additional operation', identity({ operations: [DELEGATED_OFFER_SIGNER_OPERATION, 'sign-bytes'] })],
    ['no operation', identity({ operations: [] })],
    ['unknown field', identity({ keyExport: true })],
    ['mainnet', identity({ network: 'xrp-ledger-mainnet' })],
    ['no pairs', identity({ pairs: [] })],
    ['duplicate owner/delegate pair', identity({ pairs: [identity().pairs, identity().pairs].flat() })],
    ['invalid owner address', identity({ pairs: [{ ownerAccount: 'rNotAnAddress', delegateAccount: world.delegate.address, signingPublicKey: KEY }] })],
    ['reserved owner account', identity({ pairs: [{ ownerAccount: 'rrrrrrrrrrrrrrrrrrrrrhoLvTp', delegateAccount: world.delegate.address, signingPublicKey: KEY }] })],
    ['owner equals delegate', identity({ pairs: [{ ownerAccount: world.owner, delegateAccount: world.owner, signingPublicKey: KEY }] })],
    ['invalid signing key (lower case)', identity({ pairs: [{ ownerAccount: world.owner, delegateAccount: world.delegate.address, signingPublicKey: KEY.toLowerCase() }] })],
    ['invalid signing key (short)', identity({ pairs: [{ ownerAccount: world.owner, delegateAccount: world.delegate.address, signingPublicKey: KEY.slice(0, 64) }] })],
    ['unknown field in a pair', identity({ pairs: [{ ownerAccount: world.owner, delegateAccount: world.delegate.address, signingPublicKey: KEY, seed: 'x' }] })],
    ['malformed signer id', identity({ signerId: 'has space' })],
    ['too many pairs', identity({ pairs: Array.from({ length: 65 }, () => ({ ownerAccount: testAccount(), delegateAccount: world.delegate.address, signingPublicKey: KEY })) })],
  ];
  for (const [name, value] of cases) {
    it(`refuses: ${name}`, () => assert.equal(parseDelegatedOfferSignerIdentity(value), undefined));
  }

  it('refuses non-data: a class instance, an accessor, a symbol key, an inherited property, an own __proto__ and a non-array operations list', () => {
    class Identity {
      constructor() {
        Object.assign(this, identity());
      }
    }
    assert.equal(parseDelegatedOfferSignerIdentity(new Identity()), undefined);
    const accessor = identity();
    Object.defineProperty(accessor, 'signerId', { get: () => 'customer-a-signer-1', enumerable: true });
    assert.equal(parseDelegatedOfferSignerIdentity(accessor), undefined);
    assert.equal(parseDelegatedOfferSignerIdentity({ ...identity(), [Symbol('x')]: 1 }), undefined);
    const inherited = Object.create({ protocol: DELEGATED_OFFER_SIGNER_PROTOCOL }) as Record<string, unknown>;
    Object.assign(inherited, (({ protocol: _p, ...rest }) => rest)(identity()));
    assert.equal(parseDelegatedOfferSignerIdentity(inherited), undefined);
    assert.equal(parseDelegatedOfferSignerIdentity(JSON.parse(JSON.stringify(identity()).replace('{', '{"__proto__":{"x":1},'))), undefined);
    assert.equal(parseDelegatedOfferSignerIdentity(identity({ operations: { 0: DELEGATED_OFFER_SIGNER_OPERATION, length: 1 } })), undefined);
    const sparse = identity();
    (sparse['operations'] as unknown[]).push(undefined);
    (sparse['operations'] as unknown[]).length = 1;
    Object.defineProperty(sparse['operations'], 'extra', { value: 1, enumerable: false });
    assert.equal(parseDelegatedOfferSignerIdentity(sparse), undefined, 'an array with an extra own key');
  });
});

describe('TRADE-04B A — protocol grammar: request and response', () => {
  it('a valid request parses and binds the transaction to its named owner and delegate', () => {
    const parsed = parseDelegatedOfferSigningRequest(request());
    assert.ok(parsed !== undefined);
    assert.equal(parsed.transaction.Account, parsed.ownerAccount);
    assert.equal(parsed.transaction.Delegate, parsed.delegateAccount);
  });

  const other = testAccount();
  const cases: readonly [string, Record<string, unknown>][] = [
    ['malformed request id (upper case)', request({ requestId: 'A1'.repeat(32) })],
    ['malformed request id (short)', request({ requestId: 'a1'.repeat(16) })],
    ['malformed request id (number)', request({ requestId: 1 })],
    ['invalid execution reference', request({ audit: { ...AUDIT, executionId: 'has space' } })],
    ['credential-shaped execution reference', request({ audit: { ...AUDIT, executionId: 'Bearer abc' } })],
    ['incorrect grant reference', request({ audit: { ...AUDIT, grantRef: '' } })],
    ['grant digest not a sha256 digest', request({ audit: { ...AUDIT, grantDigest: 'md5:abc' } })],
    ['a serialized grant smuggled into the audit block', request({ audit: { ...AUDIT, grant: { decision: 'allow' } } })],
    ['missing audit', (({ audit: _a, ...rest }) => rest)(request())],
    ['transaction for another owner than named', request({ ownerAccount: other })],
    ['transaction for another delegate than named', request({ delegateAccount: other })],
    ['malformed nested transaction', request({ transaction: { TransactionType: 'OfferCreate' } })],
    ['a caller-selected algorithm', request({ algorithm: 'secp256k1' })],
    ['a private key', request({ privateKey: 'ED00' })],
    ['a seed', request({ seed: 'sEd…' })],
    ['raw signing bytes', request({ signingBytes: '53545800' })],
    ['custom metadata', request({ metadata: { note: 'x' } })],
    ['a signer-side policy override', request({ maximumFeeDrops: '1000000' })],
    ['mainnet', request({ network: 'xrp-ledger-mainnet' })],
    ['the Payment protocol id', request({ protocol: EXTERNAL_XRPL_SIGNER_PROTOCOL })],
  ];
  for (const [name, value] of cases) {
    it(`refuses: ${name}`, () => assert.equal(parseDelegatedOfferSigningRequest(value), undefined));
  }

  it('the response is closed too: exact fields, a hex blob, a hash', () => {
    const response = { protocol: DELEGATED_OFFER_SIGNER_PROTOCOL, signerId: 's-1', requestId: 'a1'.repeat(32), ownerAccount: world.owner, delegateAccount: world.delegate.address, signedTransaction: 'AB'.repeat(64), hash: 'CD'.repeat(32) };
    assert.ok(parseDelegatedOfferSigningResponse(response) !== undefined, 'control');
    for (const variant of [
      { ...response, extra: 1 },
      { ...response, signedTransaction: 'ab'.repeat(64) },
      { ...response, signedTransaction: 'AB'.repeat(4097) },
      { ...response, hash: 'cd'.repeat(32) },
      { ...response, requestId: undefined },
      { ...response, protocol: EXTERNAL_XRPL_SIGNER_PROTOCOL },
      (({ delegateAccount: _d, ...rest }) => rest)(response),
    ]) {
      assert.equal(parseDelegatedOfferSigningResponse(variant), undefined, JSON.stringify(variant).slice(0, 80));
    }
  });
});

describe('TRADE-04B B — the closed prepared OfferCreate', () => {
  it('the field set is exactly enumerated, and the allowed flags are exactly TRADE-01’s', () => {
    assert.deepEqual([...DELEGATED_OFFER_REQUIRED_FIELDS], ['TransactionType', 'Account', 'Delegate', 'TakerGets', 'TakerPays', 'Flags', 'Sequence', 'Fee', 'LastLedgerSequence']);
    assert.deepEqual([...DELEGATED_OFFER_OPTIONAL_FIELDS], ['Expiration']);
    assert.equal(DELEGATED_OFFER_ALLOWED_FLAGS, Object.values(TRADE_OFFER_FLAGS).reduce((mask, bit) => mask | bit, 0));
    assert.equal(DELEGATED_OFFER_ALLOWED_FLAGS, 0x000f_0000);
  });

  it('a correct delegated OfferCreate parses — XRP for issued, issued for XRP, issued for issued, 40-hex currency, with and without Expiration', () => {
    const other = testAccount();
    for (const overrides of [
      {},
      { TakerGets: { currency: 'USD', issuer: world.issuer, value: '12.5' }, TakerPays: '25000000', Flags: 0 },
      { TakerGets: { currency: 'USD', issuer: world.issuer, value: '1' }, TakerPays: { currency: 'EUR', issuer: other, value: '0.9' } },
      { TakerPays: { currency: '0158415500000000C1F76FF6ECB0BAC600000000', issuer: world.issuer, value: '3' } },
      { Expiration: 800_000_000 },
      { Flags: TRADE_OFFER_FLAGS.passive | TRADE_OFFER_FLAGS.sell },
      { Flags: TRADE_OFFER_FLAGS['fill-or-kill'] },
    ]) {
      const parsed = parsePreparedDelegatedOffer(world.offer(overrides));
      assert.ok(parsed !== undefined, JSON.stringify(overrides));
      assert.ok(Object.isFrozen(parsed));
    }
  });

  const MEMO = [{ Memo: { MemoData: 'AA' } }];
  const cases: readonly [string, Record<string, unknown>][] = [
    ['TransactionType = Payment', { TransactionType: 'Payment' }],
    ['TransactionType = OfferCancel', { TransactionType: 'OfferCancel' }],
    ['wrong Account (malformed)', { Account: 'rBadAddress' }],
    ['wrong Delegate (malformed)', { Delegate: 'rBadAddress' }],
    ['Account equal to Delegate', { Delegate: world.owner }],
    ['missing TakerGets', { TakerGets: undefined }],
    ['missing TakerPays', { TakerPays: undefined }],
    ['XRP drops as a number', { TakerGets: 25_000_000 }],
    ['XRP drops with a fraction', { TakerGets: '25000000.5' }],
    ['XRP drops with a leading zero', { TakerGets: '025000000' }],
    ['XRP drops zero', { TakerGets: '0' }],
    ['XRP above the total supply', { TakerGets: '100000000000000001' }],
    ['XRP as an object', { TakerGets: { currency: 'XRP', drops: '1' } }],
    ['issued value non-canonical (trailing zero)', { TakerPays: { currency: 'USD', issuer: world.issuer, value: '12.50' } }],
    ['issued value with an exponent', { TakerPays: { currency: 'USD', issuer: world.issuer, value: '1e3' } }],
    ['issued value negative', { TakerPays: { currency: 'USD', issuer: world.issuer, value: '-1' } }],
    ['issued value beyond 16 significant digits', { TakerPays: { currency: 'USD', issuer: world.issuer, value: '1.2345678901234567' } }],
    ['issued value as a number', { TakerPays: { currency: 'USD', issuer: world.issuer, value: 12.5 } }],
    ['issued currency XRP', { TakerPays: { currency: 'XRP', issuer: world.issuer, value: '1' } }],
    ['issued 40-hex currency in lower case (not normalized)', { TakerPays: { currency: '0158415500000000c1f76ff6ecb0bac600000000', issuer: world.issuer, value: '3' } }],
    ['wrong issuer (malformed)', { TakerPays: { currency: 'USD', issuer: 'rBadIssuer', value: '1' } }],
    ['wrong issuer (reserved account)', { TakerPays: { currency: 'USD', issuer: 'rrrrrrrrrrrrrrrrrrrrrhoLvTp', value: '1' } }],
    ['issued amount without issuer', { TakerPays: { currency: 'USD', value: '1' } }],
    ['issued amount with an extra field', { TakerPays: { currency: 'USD', issuer: world.issuer, value: '1', counterparty: world.owner } }],
    ['XRP for XRP', { TakerPays: '1000' }],
    ['same issued asset on both sides', { TakerGets: { currency: 'USD', issuer: world.issuer, value: '1' }, TakerPays: { currency: 'USD', issuer: world.issuer, value: '2' } }],
    ['unsupported flag (tfHybrid)', { Flags: 0x0010_0000 }],
    ['unsupported flag (tfFullyCanonicalSig)', { Flags: 0x8000_0000 }],
    ['unsupported flag (tfInnerBatchTxn)', { Flags: 0x4000_0000 }],
    ['immediate-or-cancel and fill-or-kill together', { Flags: TRADE_OFFER_FLAGS['immediate-or-cancel'] | TRADE_OFFER_FLAGS['fill-or-kill'] }],
    ['negative flags', { Flags: -1 }],
    ['flags as text', { Flags: '524288' }],
    ['invalid Sequence (zero)', { Sequence: 0 }],
    ['invalid Sequence (fraction)', { Sequence: 1.5 }],
    ['invalid Sequence (above 32 bits)', { Sequence: 2 ** 32 }],
    ['invalid LastLedgerSequence (zero)', { LastLedgerSequence: 0 }],
    ['invalid LastLedgerSequence (text)', { LastLedgerSequence: '1020' }],
    ['Fee as a number', { Fee: 12 }],
    ['Fee zero', { Fee: '0' }],
    ['Fee with a fraction', { Fee: '1.5' }],
    ['Fee beyond 16 digits', { Fee: '12345678901234567' }],
    ['invalid Expiration (zero)', { Expiration: 0 }],
    ['invalid Expiration (above 32 bits)', { Expiration: 2 ** 32 }],
    ['invalid Expiration (text)', { Expiration: '800000000' }],
    ['unexpected Memos', { Memos: MEMO }],
    ['unexpected Signers', { Signers: [] }],
    ['unexpected SigningPubKey', { SigningPubKey: KEY }],
    ['unexpected TxnSignature', { TxnSignature: 'AB' }],
    ['OfferSequence (replace an offer)', { OfferSequence: 3 }],
    ['DomainID (permissioned DEX)', { DomainID: 'AB'.repeat(32) }],
    ['NetworkID', { NetworkID: 1 }],
    ['TicketSequence', { TicketSequence: 5 }],
    ['SourceTag', { SourceTag: 1 }],
    ['Payment field Destination', { Destination: world.owner }],
    ['Payment field Amount', { Amount: '1' }],
    ['unknown field', { Anything: 1 }],
  ];
  for (const [name, overrides] of cases) {
    it(`refuses: ${name}`, () => {
      const offer = world.offer() as unknown as Record<string, unknown>;
      const variant: Record<string, unknown> = { ...offer, ...overrides };
      for (const [key, value] of Object.entries(overrides)) if (value === undefined) delete variant[key];
      assert.equal(parsePreparedDelegatedOffer(variant), undefined);
    });
  }

  it('preserves XRPL meaning: TakerGets is what the owner gives, TakerPays what it receives — never swapped or normalized', () => {
    const parsed = parsePreparedDelegatedOffer(world.offer());
    assert.equal(parsed?.TakerGets, '25000000');
    assert.deepEqual(parsed?.TakerPays, { currency: 'USD', issuer: world.issuer, value: '12.5' });
  });
});
