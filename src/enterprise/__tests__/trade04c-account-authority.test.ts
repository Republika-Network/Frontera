import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { XRPL_ACCOUNT_FLAG_DISABLE_MASTER, XRPL_DELEGATE_KEY_REFUSALS as R, assessXrplDelegateSigningKey, readXrplOwnerSequence, xrplAddressOfSigningPublicKey } from '../../features/trade-runtime/rails/xrpl/index.js';
import { testAccount, testDelegate, vectorDelegate } from './trade04b-xrpl-fixture.js';

/**
 * TRADE-04C — delegate signing-key authority and owner Sequence from a
 * validated AccountRoot (`xrpl-account-authority.ts`). The account id of a
 * key is derived with `node:crypto` only (no new SDK importer); here it is
 * compared with the SDK's own derivation (the TRADE-04B fixture's wallets)
 * for generated and pinned keys of both algorithms.
 */

const root = (account: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({ LedgerEntryType: 'AccountRoot', Account: account, Flags: 0, Sequence: 9, Balance: '1', OwnerCount: 0, ...extra });

describe('TRADE-04C — account id derivation equals the SDK’s', () => {
  it('for 40 generated keys and 4 pinned vectors, ed25519 and secp256k1', () => {
    const delegates = [...Array.from({ length: 20 }, () => testDelegate('ed25519')), ...Array.from({ length: 20 }, () => testDelegate('secp256k1')), vectorDelegate(1, 'ed25519'), vectorDelegate(2, 'ed25519'), vectorDelegate(3, 'secp256k1'), vectorDelegate(4, 'secp256k1')];
    for (const delegate of delegates) assert.equal(xrplAddressOfSigningPublicKey(delegate.publicKey), delegate.address, delegate.publicKey);
  });

  it('anything that is not a 33-byte uppercase key derives nothing', () => {
    const key = testDelegate().publicKey;
    for (const value of [undefined, '', key.toLowerCase(), key.slice(2), `${key}00`, `04${key.slice(2)}`, 42]) assert.equal(xrplAddressOfSigningPublicKey(value), undefined, String(value));
  });
});

describe('TRADE-04C — delegate key authority', () => {
  const delegate = testDelegate();
  const regular = testDelegate();
  const expected = { delegate: delegate.address, signingPublicKey: delegate.publicKey };

  it('master key, enabled → authorized via master-key', () => {
    assert.deepEqual(assessXrplDelegateSigningKey(root(delegate.address), expected), { authorized: true, via: 'master-key' });
  });

  it('master key with lsfDisableMaster → refused, even when a regular key is set', () => {
    assert.deepEqual(assessXrplDelegateSigningKey(root(delegate.address, { Flags: XRPL_ACCOUNT_FLAG_DISABLE_MASTER }), expected), { authorized: false, code: R.MASTER_DISABLED });
    assert.deepEqual(assessXrplDelegateSigningKey(root(delegate.address, { Flags: XRPL_ACCOUNT_FLAG_DISABLE_MASTER, RegularKey: regular.address }), expected), { authorized: false, code: R.MASTER_DISABLED });
  });

  it('a pinned key that is the account’s regular key → authorized via regular-key (master disabled or not)', () => {
    const pinned = { delegate: delegate.address, signingPublicKey: regular.publicKey };
    assert.deepEqual(assessXrplDelegateSigningKey(root(delegate.address, { RegularKey: regular.address }), pinned), { authorized: true, via: 'regular-key' });
    assert.deepEqual(assessXrplDelegateSigningKey(root(delegate.address, { RegularKey: regular.address, Flags: XRPL_ACCOUNT_FLAG_DISABLE_MASTER }), pinned), { authorized: true, via: 'regular-key' });
  });

  it('a changed or different key → refused (the key changed on the ledger, or the pin is stale)', () => {
    const pinned = { delegate: delegate.address, signingPublicKey: regular.publicKey };
    assert.deepEqual(assessXrplDelegateSigningKey(root(delegate.address), pinned), { authorized: false, code: R.KEY_NOT_AUTHORIZED });
    assert.deepEqual(assessXrplDelegateSigningKey(root(delegate.address, { RegularKey: testAccount() }), pinned), { authorized: false, code: R.KEY_NOT_AUTHORIZED });
  });

  it('a root for another account, a non-root, malformed fields or a malformed pin → refused', () => {
    assert.deepEqual(assessXrplDelegateSigningKey(root(testAccount()), expected), { authorized: false, code: R.ROOT_MISMATCH });
    for (const node of [undefined, null, [], { ...root(delegate.address), LedgerEntryType: 'Delegate' }, root(delegate.address, { Flags: -1 }), root(delegate.address, { Flags: '0' }), root(delegate.address, { RegularKey: 'not-an-address' })]) {
      assert.equal(assessXrplDelegateSigningKey(node, expected).authorized, false, JSON.stringify(node));
    }
    assert.deepEqual(assessXrplDelegateSigningKey(root(delegate.address), { delegate: delegate.address, signingPublicKey: 'ED' }), { authorized: false, code: R.KEY_MALFORMED });
    // A getter is never read.
    const sneaky = root(delegate.address);
    Object.defineProperty(sneaky, 'Flags', { get: () => 0, enumerable: true });
    assert.equal(assessXrplDelegateSigningKey(sneaky, expected).authorized, false);
  });
});

describe('TRADE-04C — owner Sequence', () => {
  const owner = testAccount();
  it('only the owner’s own root, a positive 32-bit Sequence', () => {
    assert.equal(readXrplOwnerSequence(root(owner), owner), 9);
    assert.equal(readXrplOwnerSequence(root(owner), testAccount()), undefined);
    for (const sequence of [0, -1, 1.5, 2 ** 32, '9', null]) assert.equal(readXrplOwnerSequence(root(owner, { Sequence: sequence }), owner), undefined, String(sequence));
  });
});
