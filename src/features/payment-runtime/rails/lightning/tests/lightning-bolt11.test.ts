import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { BOLT11_REFUSALS, decodeBolt11Invoice } from '../index.js';
import { bytesToWords } from '../lightning-bech32.js';
import { BOLT11_SPEC_VECTORS } from './bolt11-spec-vectors.js';
import { buildInvoice, testNodeKey, testPreimage } from './lightning-test-fixtures.js';

/**
 * PAY-06 — the BOLT11 decoder, pinned to BOLT #11 at lightning/bolts
 * `14901bdcacee53d95b46dc276b0f09c85d7d71fd` (2026-03-09).
 *
 * Every spec vector is decoded and compared with a pinned answer. Two answers
 * deliberately differ from where the spec files the vector, both conservative:
 *
 * 1. "Same, but including fields which must be ignored." carries `p`, `h`, `s`
 *    and `n` fields of the wrong length, labelled "(ignored)" — but the
 *    requirements at the pinned commit say a reader **MUST fail** on a wrong
 *    fixed `data_length` (bolts #1243 removed the old "skip" rule and left this
 *    vector stale). Refused (it also repeats single-occurrence fields).
 * 2. "Non canonical signature (high-S) with 'n' field defined" is refused as
 *    the spec intends, but first for repeating the `s` field it carries twice;
 *    the high-S-with-`n` rule itself is proven on a generated invoice (B11-H).
 *
 * The high-S **recovery** vector is valid and recovers
 * `02d0139c…` with its stated recovery id — literal recovery, exactly as
 * libsecp256k1's `secp256k1_ecdsa_recover` and btcec's `RecoverCompact` (LND)
 * compute it; the signature also verifies under `03e7156a…`, which is precisely
 * why the payee must be recovered and never merely verified under an expected
 * key (B11-RECOVERY).
 */

const PAYEE = 'payee-node';

/** JSON with BigInt as text, for assertion messages. */
const show = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) => (typeof item === 'bigint' ? item.toString() : item));

async function invoice(overrides: Partial<Parameters<typeof buildInvoice>[0]> = {}): Promise<string> {
  return buildInvoice({ amountMsat: 2_500_000n, paymentHash: testPreimage('b11').paymentHash, payeeKeyLabel: PAYEE, ...overrides });
}

describe('PAY-06 BOLT11 — the spec vectors (pinned baseline)', () => {
  for (const vector of BOLT11_SPEC_VECTORS) {
    it(`${vector.spec}: ${vector.title.slice(0, 90)}`, async () => {
      const decoded = await decodeBolt11Invoice(vector.invoice);
      if (vector.expected.valid) {
        assert.equal(decoded.valid, true, show(decoded));
        if (!decoded.valid) return;
        assert.equal(decoded.invoice.network, vector.expected.network);
        assert.equal(decoded.invoice.amountMsat, vector.expected.amountMsat);
        assert.equal(decoded.invoice.payee, vector.expected.payee);
        assert.equal(decoded.invoice.paymentHash, vector.expected.paymentHash);
        assert.equal(decoded.invoice.timestamp, vector.expected.timestamp);
        assert.equal(decoded.invoice.expirySeconds, vector.expected.expirySeconds);
        assert.ok(Object.isFrozen(decoded.invoice));
      } else {
        assert.deepEqual(decoded, { valid: false, refusal: vector.expected.refusal });
      }
    });
  }

  it('every vector the spec lists as valid decodes, except the one stale "fields which must be ignored" vector', () => {
    const refusedValid = BOLT11_SPEC_VECTORS.filter((vector) => vector.spec === 'VALID' && !vector.expected.valid).map((vector) => vector.title);
    assert.deepEqual(refusedValid, ['Same, but including fields which must be ignored.']);
    assert.ok(BOLT11_SPEC_VECTORS.filter((vector) => vector.spec === 'INVALID').every((vector) => !vector.expected.valid), 'every invalid vector is refused');
    // The spec's payee for every signed vector but the high-S recovery one.
    const payees = new Set(BOLT11_SPEC_VECTORS.filter((vector) => vector.expected.valid).map((vector) => (vector.expected as { payee: string }).payee));
    assert.deepEqual([...payees].sort(), ['02d0139ce7427d6dfffd26a326c18be754ef1e64672b42694ba5b23ef6e6e7803d', '03e7156ae33b0a208d0744199163177e909e80176e55d97a2f221ede0f934dd9ad']);
  });
});

describe('PAY-06 BOLT11 — B11 matrix (generated invoices)', () => {
  it('B11-1 valid invoice: every field read exactly, the payee recovered', async () => {
    const decoded = await decodeBolt11Invoice(await invoice({ expirySeconds: 600, minFinalCltvExpiryDelta: 80 }));
    assert.equal(decoded.valid, true, show(decoded));
    if (!decoded.valid) return;
    assert.equal(decoded.invoice.network, 'regtest');
    assert.equal(decoded.invoice.amountMsat, 2_500_000n);
    assert.equal(decoded.invoice.payee, await testNodeKey(PAYEE));
    assert.equal(decoded.invoice.payeeSource, 'recovered');
    assert.equal(decoded.invoice.paymentHash, testPreimage('b11').paymentHash);
    assert.equal(decoded.invoice.expirySeconds, 600);
    assert.equal(decoded.invoice.minFinalCltvExpiryDelta, 80);
    assert.deepEqual(decoded.invoice.requiredFeatures, [8, 14]);
    // Nothing merchant-controlled is returned: no description, secret, route or fallback contents.
    assert.deepEqual(Object.keys(decoded.invoice).sort(), ['amountMsat', 'canonical', 'expirySeconds', 'fallbackCount', 'minFinalCltvExpiryDelta', 'network', 'payee', 'payeeSource', 'paymentHash', 'requiredFeatures', 'routeHintCount', 'timestamp']);
  });

  it('B11-1b with the n field: verified under it, low-S', async () => {
    const decoded = await decodeBolt11Invoice(await invoice({ nField: true }));
    assert.equal(decoded.valid && decoded.invoice.payeeSource, 'n-field');
    assert.equal(decoded.valid && decoded.invoice.payee, await testNodeKey(PAYEE));
  });

  it('B11-2 bad checksum / forged signature: refused', async () => {
    const good = await invoice();
    const flipped = good.slice(0, -1) + (good.endsWith('q') ? 'p' : 'q');
    assert.deepEqual(await decodeBolt11Invoice(flipped), { valid: false, refusal: 'bolt11-encoding-invalid' });
    // Signed by another key, but presenting the payee's n field: the signature does not verify under it.
    assert.deepEqual(await decodeBolt11Invoice(await invoice({ nField: true, signWithLabel: 'mallory' })), { valid: false, refusal: 'bolt11-signature-invalid' });
    // Signed by another key without n: it decodes — with the forger as payee (the rail then refuses the payee binding, B11-13).
    const forged = await decodeBolt11Invoice(await invoice({ signWithLabel: 'mallory' }));
    assert.equal(forged.valid && forged.invoice.payee, await testNodeKey('mallory'));
  });

  it('B11-RECOVERY a flipped recovery id still "verifies" but recovers ANOTHER payee — the payee is recovered, never assumed', async () => {
    const decoded = await decodeBolt11Invoice(await invoice({ flipRecovery: true }));
    assert.equal(decoded.valid, true);
    assert.notEqual(decoded.valid && decoded.invoice.payee, await testNodeKey(PAYEE));
  });

  it('B11-H high-S: accepted for recovery (same payee), refused with the n field', async () => {
    const recovered = await decodeBolt11Invoice(await invoice({ highS: true }));
    assert.equal(recovered.valid && recovered.invoice.payee, await testNodeKey(PAYEE));
    assert.deepEqual(await decodeBolt11Invoice(await invoice({ highS: true, nField: true })), { valid: false, refusal: 'bolt11-signature-high-s' });
  });

  it('B11-3 every network prefix is read; an unknown one is refused', async () => {
    for (const network of ['mainnet', 'testnet', 'signet', 'regtest'] as const) {
      const decoded = await decodeBolt11Invoice(await invoice({ network }));
      assert.equal(decoded.valid && decoded.invoice.network, network);
    }
    const text = await invoice();
    assert.equal((await decodeBolt11Invoice(text.replace(/^lnbcrt/, 'lnxx'))).valid, false);
  });

  it('B11-5 malformed amounts: leading zero, unknown multiplier, sub-millisatoshi pico, zero', async () => {
    for (const hrpAmount of ['025u', '25x', '2501p', '0', '0m']) {
      const decoded = await decodeBolt11Invoice(await invoice({ hrpAmount }));
      assert.equal(decoded.valid, false, hrpAmount);
    }
    assert.equal((await decodeBolt11Invoice(await invoice({ hrpAmount: '2500p' })))?.valid, true, 'a p amount ending in 0 is exactly 250 msat');
  });

  it('B11-7 an unknown REQUIRED (even) feature is refused; B11-8 an unknown optional (odd) one is ignored', async () => {
    assert.deepEqual(await decodeBolt11Invoice(await invoice({ features: [8, 14, 100] })), { valid: false, refusal: 'bolt11-feature-unsupported' });
    assert.deepEqual(await decodeBolt11Invoice(await invoice({ features: [8, 14, 24] })), { valid: false, refusal: 'bolt11-feature-unsupported' }, 'route blinding required: not honoured, refused');
    const optional = await decodeBolt11Invoice(await invoice({ features: [8, 14, 101, 25] }));
    assert.equal(optional.valid, true);
    assert.deepEqual(optional.valid && optional.invoice.requiredFeatures, [8, 14]);
    assert.deepEqual(await decodeBolt11Invoice(await invoice({ features: [8, 17] })), { valid: false, refusal: 'bolt11-feature-dependency-missing' }, 'basic_mpp needs payment_secret');
    assert.equal((await decodeBolt11Invoice(await invoice({ features: [8, 14, 16] }))).valid, true, 'required basic_mpp is honoured');
  });

  it('B11-9 malformed tagged fields: wrong fixed lengths, non-minimal x / c / 9, invalid UTF-8 description, malformed route hint', async () => {
    const hash = testPreimage('b11').paymentHash;
    // A p field of 51 words.
    const shortHash = bytesToWords(Buffer.from(hash, 'hex')).slice(0, 51);
    assert.deepEqual(await decodeBolt11Invoice(await invoice({ omit: ['p'], extraFields: [{ tag: 1, words: shortHash }] })), { valid: false, refusal: 'bolt11-field-length-invalid' });
    assert.deepEqual(await decodeBolt11Invoice(await invoice({ extraFields: [{ tag: 6, words: [0, 1] }] })), { valid: false, refusal: 'bolt11-field-non-minimal' });
    assert.deepEqual(await decodeBolt11Invoice(await invoice({ omit: ['d'], extraFields: [{ tag: 13, words: bytesToWords(Uint8Array.from([0xff, 0xfe])) }] })), { valid: false, refusal: 'bolt11-description-invalid' });
    assert.deepEqual(await decodeBolt11Invoice(await invoice({ routeHints: [Uint8Array.from([4, ...new Uint8Array(50)])] })), { valid: false, refusal: 'bolt11-route-hint-invalid' }, 'a hop must start with a compressed key');
    assert.deepEqual(await decodeBolt11Invoice(await invoice({ routeHints: [new Uint8Array(30).fill(2)] })), { valid: false, refusal: 'bolt11-route-hint-invalid' }, 'not a whole number of hops');
    const hop = Uint8Array.from([2, ...new Uint8Array(32).fill(7), ...new Uint8Array(18)]);
    const hinted = await decodeBolt11Invoice(await invoice({ routeHints: [hop, Uint8Array.from([...hop, ...hop])] }));
    assert.equal(hinted.valid && hinted.invoice.routeHintCount, 3, 'route hints are counted, never interpreted');
  });

  it('B11-10 duplicated single fields are refused; missing p, s, d are refused; d and h together are refused', async () => {
    const hash = testPreimage('b11').paymentHash;
    assert.deepEqual(await decodeBolt11Invoice(await invoice({ extraFields: [{ tag: 1, words: bytesToWords(Buffer.from(hash, 'hex')) }] })), { valid: false, refusal: 'bolt11-field-duplicated' });
    assert.deepEqual(await decodeBolt11Invoice(await invoice({ omit: ['p'] })), { valid: false, refusal: 'bolt11-payment-hash-missing' });
    assert.deepEqual(await decodeBolt11Invoice(await invoice({ omit: ['s'] })), { valid: false, refusal: 'bolt11-payment-secret-missing' });
    assert.deepEqual(await decodeBolt11Invoice(await invoice({ omit: ['d'] })), { valid: false, refusal: 'bolt11-description-invalid' });
    assert.deepEqual(await decodeBolt11Invoice(await invoice({ extraFields: [{ tag: 23, words: bytesToWords(Buffer.alloc(32, 1)) }] })), { valid: false, refusal: 'bolt11-description-invalid' });
  });

  it('B11-11 oversized input is refused before any work; non-strings and garbage are closed refusals', async () => {
    const text = await invoice();
    assert.deepEqual(await decodeBolt11Invoice(text, 64), { valid: false, refusal: 'bolt11-oversized' });
    assert.deepEqual(await decodeBolt11Invoice(`lnbcrt1${'q'.repeat(8000)}`), { valid: false, refusal: 'bolt11-oversized' });
    for (const garbage of [undefined, null, 42, {}, [], '', 'lnbc', ' lnbcrt1qqq', Object.create(null)]) {
      const decoded = await decodeBolt11Invoice(garbage);
      assert.equal(decoded.valid, false);
      assert.ok(!decoded.valid && BOLT11_REFUSALS.includes(decoded.refusal));
    }
  });

  it('B11-12 amountless invoices decode without an amount (the rail refuses them)', async () => {
    const decoded = await decodeBolt11Invoice(await invoice({ hrpAmount: '' }));
    assert.equal(decoded.valid, true);
    assert.equal(decoded.valid && 'amountMsat' in decoded.invoice, false);
  });

  it('upper case is read as its lowercase spelling; mixed case is refused', async () => {
    const text = await invoice();
    const upper = await decodeBolt11Invoice(text.toUpperCase());
    assert.equal(upper.valid && upper.invoice.canonical, text);
    assert.equal((await decodeBolt11Invoice(text.slice(0, 10).toUpperCase() + text.slice(10))).valid, false);
  });

  it('a hostile decoded structure is never trusted: the answer is a fresh frozen object with exactly its own keys', async () => {
    const decoded = await decodeBolt11Invoice(await invoice());
    assert.ok(decoded.valid && Object.isFrozen(decoded.invoice) && Object.isFrozen(decoded.invoice.requiredFeatures));
    assert.equal(decoded.valid && Object.getPrototypeOf(decoded.invoice), Object.prototype);
  });
});
