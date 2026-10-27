import test from 'node:test';
import assert from 'node:assert/strict';

import { verifyReceivedSovereignAsset } from '../src/index.js';
import { ATTACKER, attackerKeys, consumerSupport, trustingResolver, validFixture, validOptions } from './fixtures.js';

test('a throwing option getter is rejected, not propagated', async () => {
  const options = validOptions();
  Object.defineProperty(options, 'verificationKeyResolver', { enumerable: true, get: () => { throw new Error('getter'); } });
  assert.deepEqual((await verifyReceivedSovereignAsset(validFixture().text, options)).reasons, ['INVALID_OPTIONS']);
});

test('a proxy whose traps throw is rejected as options, resolver, support and content bytes', async () => {
  const hostile = new Proxy({}, {
    get() { throw new Error('trap'); },
    ownKeys() { throw new Error('trap'); },
  });
  const text = validFixture().text;
  assert.deepEqual((await verifyReceivedSovereignAsset(text, hostile)).reasons, ['INVALID_OPTIONS']);
  assert.deepEqual((await verifyReceivedSovereignAsset(text, validOptions({ verificationKeyResolver: hostile }))).reasons, ['INVALID_OPTIONS']);
  assert.deepEqual((await verifyReceivedSovereignAsset(text, validOptions({ consumerSupport: hostile }))).reasons, ['CONSUMER_SUPPORT_INVALID']);
  const hostileBytes = new Proxy(new Uint8Array(4), { get() { throw new Error('trap'); } });
  assert.deepEqual((await verifyReceivedSovereignAsset(text, validOptions({ contentBytes: hostileBytes }))).reasons, ['INVALID_OPTIONS']);
});

test('each option is read once, so a getter cannot swap the trusted resolver after validation', async () => {
  const reads = new Map<string, number>();
  const trusted = trustingResolver();
  const attacker = trustingResolver({ 'did:example:issuer': attackerKeys });
  const base = validOptions();
  const options: Record<string, unknown> = {};
  for (const key of Object.keys(base)) {
    Object.defineProperty(options, key, {
      enumerable: true,
      get: () => {
        const count = (reads.get(key) ?? 0) + 1;
        reads.set(key, count);
        if (key === 'verificationKeyResolver') return count === 1 ? trusted : attacker;
        return base[key];
      },
    });
  }
  const result = await verifyReceivedSovereignAsset(validFixture().text, options);
  assert.equal(result.outcome, 'verified', JSON.stringify(result.reasons));
  for (const [key, count] of reads) assert.equal(count, 1, `${key} read ${count} times`);
});

test('a resolver method swapped after the call starts is not used', async () => {
  const resolver = trustingResolver();
  const original = resolver.resolveVerificationKey;
  let swapped = false;
  const mutable = {
    resolveVerificationKey(issuer: string) {
      if (!swapped) {
        swapped = true;
        mutable.resolveVerificationKey = () => ({ keyId: attackerKeys.signingKey.keyId, issuer: ATTACKER });
      }
      return original.call(resolver, issuer);
    },
  };
  const result = await verifyReceivedSovereignAsset(validFixture().text, validOptions({ verificationKeyResolver: mutable }));
  assert.equal(result.outcome, 'verified', JSON.stringify(result.reasons));
});

test('a consumer support declaration with a throwing toJSON is rejected', async () => {
  const support = { ...consumerSupport(), toJSON() { throw new Error('toJSON'); } };
  assert.deepEqual((await verifyReceivedSovereignAsset(validFixture().text, validOptions({ consumerSupport: support }))).reasons, ['CONSUMER_SUPPORT_INVALID']);
});

test('a consumer support declaration whose getters change between reads is evaluated once', async () => {
  const partial = consumerSupport({ claimTypes: [] });
  const full = consumerSupport();
  let reads = 0;
  const support: Record<string, unknown> = { ...partial };
  Object.defineProperty(support, 'claimTypes', { enumerable: true, get: () => (++reads === 1 ? partial.claimTypes : full.claimTypes) });
  const result = await verifyReceivedSovereignAsset(validFixture().text, validOptions({ consumerSupport: support }));
  assert.deepEqual(result.reasons, ['INTEROPERABILITY_PARTIAL']);
  assert.equal(reads, 1);
});
