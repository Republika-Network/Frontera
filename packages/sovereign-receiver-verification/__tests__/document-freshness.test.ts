import test from 'node:test';
import assert from 'node:assert/strict';

import { mintSovereignAssetId } from '@aoc/protocol/identity';
import { SovereignLicenseTermsAudienceKind } from '@aoc/protocol/licensing';
import { signSovereignPayload } from '@aoc/protocol/manifest';
import type { SovereignKeyPair } from '@aoc/protocol/manifest';

import {
  DOCUMENT_USE_FRESHNESS_CEILINGS,
  DOCUMENT_USE_FRESHNESS_GATE,
  DOCUMENT_USE_FRESHNESS_VERDICTS,
  SOVEREIGN_STATUS_PROFILE,
  SOVEREIGN_STATUS_PURPOSE,
  checkDocumentUseFreshness,
  createInMemoryStatusHighWaterMarkStore,
  establishStatusHistory,
  evaluateDocumentUsePolicy,
  verifyDocumentUseEligibility,
} from '../src/index.js';
import type {
  DocumentUseFreshnessResult,
  DocumentUseFreshnessVerdict,
  DocumentUsePolicyDecision,
  StatusHighWaterMark,
  StatusHighWaterMarkEntry,
  StatusHighWaterMarkStore,
  StatusHistoryKey,
} from '../src/index.js';
import { ATTACKER, ISSUER, SIGNED_AT, attackerKeys, issuerKeys, trustingResolver } from './fixtures.js';
import { ACCESS, EXPORT, MODIFY, PROFILE_RULES, Permission, RECEIVER, eligibleDocument, rule } from './document-fixtures.js';
import type { EligibleDocument, TermsOptions } from './document-fixtures.js';
import { canonical } from './status-fixtures.js';

const NOW = '2026-10-28T12:00:00.000Z';
const VALID_UNTIL = '2026-10-29T00:00:00.000Z';
const READ = ACCESS.termRef;
const OTHER_DIGEST = 'b'.repeat(64);

interface Signed {
  readonly text: string;
  readonly digest: string;
}

interface World {
  readonly doc: EligibleDocument;
  readonly store: StatusHighWaterMarkStore;
  readonly terms: { readonly claimId: string; readonly claimDigest: string };
  status(overrides?: Record<string, unknown>, keys?: SovereignKeyPair): Signed;
  decide(action: string, evaluationTime?: string): DocumentUsePolicyDecision;
  context(overrides?: Record<string, unknown>): Record<string, unknown>;
  bootstrap(status: Signed, overrides?: Record<string, unknown>): ReturnType<typeof establishStatusHistory>;
  check(action: string, status: Signed | null, overrides?: Record<string, unknown>): Promise<DocumentUseFreshnessResult>;
}

/** A verified document with an empty receiver history and helpers to sign its statuses. */
async function world(options: TermsOptions = {}, store: StatusHighWaterMarkStore = createInMemoryStatusHighWaterMarkStore()): Promise<World> {
  const doc = await eligibleDocument(options);
  const terms = { claimId: doc.signedTerms.claim.id, claimDigest: doc.signedTerms.digest };
  const self: World = {
    doc,
    store,
    terms,
    status(overrides = {}, keys = issuerKeys) {
      const payload = {
        schemaVersion: SOVEREIGN_STATUS_PROFILE,
        purpose: SOVEREIGN_STATUS_PURPOSE,
        sovereignAssetId: doc.sovereignAssetId,
        issuer: ISSUER,
        manifestDigest: doc.manifestDigest,
        assetStatus: 'active',
        currentTerms: { ...terms },
        sequence: 1,
        previousStatusDigest: null,
        issuedAt: '2026-10-28T11:55:00.000Z',
        validUntil: VALID_UNTIL,
        ...overrides,
      };
      const proof = signSovereignPayload(payload, keys.privateKeyPem, keys.signingKey, SIGNED_AT);
      return { text: canonical({ status: payload, proof }), digest: proof.payloadHash };
    },
    decide(action, evaluationTime = NOW) {
      return evaluateDocumentUsePolicy(doc.eligibility, { action }, {
        receiverPrincipal: RECEIVER,
        evaluationTime,
        expectedSovereignAssetId: doc.sovereignAssetId,
        policyReference: { ...terms },
      });
    },
    context(overrides = {}) {
      return {
        verificationKeyResolver: trustingResolver(),
        evaluationTime: NOW,
        operationId: 'op-1',
        maxStatusAgeSeconds: { ...DOCUMENT_USE_FRESHNESS_CEILINGS },
        historyStore: store,
        ...overrides,
      };
    },
    bootstrap(status, overrides = {}) {
      return establishStatusHistory(status.text, {
        verificationKeyResolver: trustingResolver(),
        historyStore: store,
        expectedSovereignAssetId: doc.sovereignAssetId,
        expectedRegistrant: ISSUER,
        expectedManifestDigest: doc.manifestDigest,
        evaluationTime: NOW,
        ...overrides,
      });
    },
    async check(action, status, overrides = {}) {
      const evaluationTime = (overrides['evaluationTime'] as string | undefined) ?? NOW;
      return checkDocumentUseFreshness(self.decide(action, evaluationTime), status === null ? null : status.text, self.context(overrides));
    },
  };
  return self;
}

/** A world whose history is anchored at sequence 1. */
async function anchored(options: TermsOptions = {}) {
  const w = await world(options);
  const s1 = w.status({ issuedAt: '2026-10-28T11:50:00.000Z' });
  const boot = await w.bootstrap(s1);
  assert.equal(boot.outcome, 'established');
  return { w, s1 };
}

function next(w: World, previous: Signed, sequence: number, overrides: Record<string, unknown> = {}, keys: SovereignKeyPair = issuerKeys): Signed {
  return w.status({ sequence, previousStatusDigest: previous.digest, issuedAt: `2026-10-28T11:5${Math.min(sequence + 1, 9)}:00.000Z`, ...overrides }, keys);
}

function expect(result: DocumentUseFreshnessResult, verdict: DocumentUseFreshnessVerdict, after: string, message?: string): void {
  assert.equal(result.freshnessVerdict, verdict, message ?? `expected ${verdict}`);
  assert.equal(result.policyDecisionAfterFreshness, after, message ?? `expected ${after}`);
  assert.equal(result.authorization, 'not_evaluated');
  assert.equal(result.execution, 'not_performed');
}

async function mark(w: World): Promise<StatusHighWaterMarkEntry | undefined> {
  return w.store.read({ sovereignAssetId: w.doc.sovereignAssetId, issuer: ISSUER });
}

const RANK: Record<string, number> = { DENIED: 0, WITHHELD: 1, ALLOWED: 2 };

// ---------------------------------------------------------------------------
// Replay and fork detection

test('1. sequence 1 after a trusted bootstrap: READ ALLOWED stays ALLOWED, fresh', async () => {
  const { w, s1 } = await anchored();
  const result = await w.check(READ, s1);
  expect(result, 'FRESH', 'ALLOWED');
  assert.equal(result.policyDecisionBefore, 'ALLOWED');
  assert.equal(result.gate, DOCUMENT_USE_FRESHNESS_GATE);
  assert.equal(result.operationId, 'op-1');
  assert.deepEqual(result.history, { initialization: 'ESTABLISHED', before: { sequence: 1, statusDigest: s1.digest }, after: { sequence: 1, statusDigest: s1.digest }, transition: 'unchanged' });
  assert.deepEqual(result.status, { sequence: 1, statusDigest: s1.digest, assetStatus: 'active', currentTermsDigest: w.terms.claimDigest, issuedAt: '2026-10-28T11:50:00.000Z', validUntil: VALID_UNTIL });
  assert.equal(result.maxStatusAgeSeconds, 86_400);
});

test('2. sequence 2 linked to sequence 1 advances the mark and stays fresh', async () => {
  const { w, s1 } = await anchored();
  const s2 = next(w, s1, 2);
  const result = await w.check(READ, s2);
  expect(result, 'FRESH', 'ALLOWED');
  assert.equal(result.history.transition, 'advanced');
  assert.deepEqual(result.history.after, { sequence: 2, statusDigest: s2.digest });
  assert.equal((await mark(w))!.mark.sequence, 2);
});

test('3. replaying sequence 1 after sequence 2 is a rollback, and the mark does not move', async () => {
  const { w, s1 } = await anchored();
  await w.check(READ, next(w, s1, 2));
  const before = await mark(w);
  const result = await w.check(READ, s1);
  expect(result, 'ROLLBACK_DETECTED', 'DENIED');
  assert.equal(result.history.transition, 'refused');
  assert.deepEqual(await mark(w), before);
});

test('4. repeating sequence 2 with the same digest is idempotent', async () => {
  const { w, s1 } = await anchored();
  const s2 = next(w, s1, 2);
  await w.check(READ, s2);
  const revision = (await mark(w))!.revision;
  for (let index = 0; index < 3; index += 1) {
    const result = await w.check(READ, s2);
    expect(result, 'FRESH', 'ALLOWED');
    assert.equal(result.history.transition, 'unchanged');
  }
  assert.equal((await mark(w))!.revision, revision);
});

test('5. a different sequence 2 is equivocation: the conflict latches for the whole history', async () => {
  const { w, s1 } = await anchored();
  const s2 = next(w, s1, 2);
  const s2b = next(w, s1, 2, { validUntil: '2026-10-29T00:00:00.5Z' });
  expect(await w.check(READ, s2), 'FRESH', 'ALLOWED');
  const conflict = await w.check(READ, s2b);
  expect(conflict, 'CONFLICT_DETECTED', 'DENIED');
  assert.equal(conflict.history.transition, 'conflict_recorded');
  assert.equal((await mark(w))!.mark.conflict, true);
  // The genuine status no longer passes either, and neither does a later one.
  expect(await w.check(READ, s2), 'CONFLICT_DETECTED', 'DENIED');
  expect(await w.check(READ, next(w, s2, 3)), 'CONFLICT_DETECTED', 'DENIED');
});

test('6. a sequence gap advances the mark but continuity stays unproven until re-anchored', async () => {
  const { w, s1 } = await anchored();
  const s2 = next(w, s1, 2);
  const s3 = next(w, s2, 3);
  const gap = await w.check(READ, s3);
  expect(gap, 'CONTINUITY_UNPROVEN', 'DENIED');
  assert.equal(gap.history.transition, 'advanced_with_gap');
  assert.equal((await mark(w))!.mark.continuity, 'unproven');
  // The skipped status can no longer be used, and a linked successor does not repair the gap.
  expect(await w.check(READ, s2), 'ROLLBACK_DETECTED', 'DENIED');
  const s4 = next(w, s3, 4);
  expect(await w.check(READ, s4), 'CONTINUITY_UNPROVEN', 'DENIED');
  // Only a trusted re-anchor restores it.
  const re = await w.bootstrap(s4, { reanchor: true });
  assert.equal(re.reason, 'REESTABLISHED');
  expect(await w.check(READ, s4), 'FRESH', 'ALLOWED');
});

test('7. a branch that does not link to the accepted head is a fork', async () => {
  const { w, s1 } = await anchored();
  const s2 = next(w, s1, 2);
  const s2b = next(w, s1, 2, { validUntil: '2026-10-29T00:00:00.5Z' });
  const s3b = next(w, s2b, 3);
  expect(await w.check(READ, s2), 'FRESH', 'ALLOWED');
  expect(await w.check(READ, s3b), 'CONFLICT_DETECTED', 'DENIED');
  // A sequence-2 status whose predecessor link is not the accepted sequence 1 is a fork too.
  const { w: w2, s1: t1 } = await anchored();
  expect(await w2.check(READ, next(w2, { text: t1.text, digest: OTHER_DIGEST }, 2)), 'CONFLICT_DETECTED', 'DENIED');
});

test('8. withdrawal is terminal: a later active status latches a conflict', async () => {
  const { w, s1 } = await anchored();
  const s2 = next(w, s1, 2, { assetStatus: 'withdrawn', currentTerms: null });
  expect(await w.check(READ, s2), 'WITHDRAWN', 'DENIED');
  assert.equal((await mark(w))!.mark.withdrawn, true);
  expect(await w.check(READ, next(w, s2, 3)), 'CONFLICT_DETECTED', 'DENIED');
});

test('8. withdrawal is terminal even when the reactivation names terms never seen before', async () => {
  const { w, s1 } = await anchored();
  const s2 = next(w, s1, 2, { assetStatus: 'withdrawn', currentTerms: null });
  await w.check(READ, s2);
  const reactivated = await w.check(READ, next(w, s2, 3, { currentTerms: { claimId: 'claim:terms-new', claimDigest: 'd'.repeat(64) } }));
  expect(reactivated, 'CONFLICT_DETECTED', 'DENIED');
  assert.equal((await mark(w))!.mark.conflict, true);
});

test('a later sequence issued before the accepted head is inconsistent history', async () => {
  const { w, s1 } = await anchored();
  const backdated = next(w, s1, 2, { issuedAt: '2026-10-28T11:49:59.999999999Z' });
  expect(await w.check(READ, backdated), 'CONFLICT_DETECTED', 'DENIED');
  assert.equal((await mark(w))!.mark.conflict, true);
});

test('9. retired terms can never become current again', async () => {
  const { w, s1 } = await anchored();
  const s2 = next(w, s1, 2, { currentTerms: { claimId: 'claim:terms-2', claimDigest: OTHER_DIGEST } });
  expect(await w.check(READ, s2), 'SUPERSEDED', 'DENIED');
  assert.deepEqual((await mark(w))!.mark.retiredTermsDigests, [w.terms.claimDigest]);
  expect(await w.check(READ, next(w, s2, 3)), 'CONFLICT_DETECTED', 'DENIED');
  // Revoked terms (currentTerms null) are retired the same way.
  const { w: v, s1: t1 } = await anchored();
  const revoked = next(v, t1, 2, { currentTerms: null });
  expect(await v.check(READ, revoked), 'REVOKED', 'DENIED');
  expect(await v.check(READ, next(v, revoked, 3)), 'CONFLICT_DETECTED', 'DENIED');
});

test('10–13. statuses about another asset, issuer, manifest or terms never pass', async () => {
  const { w, s1 } = await anchored();
  const before = await mark(w);
  const otherAsset = await w.check(READ, next(w, s1, 2, { sovereignAssetId: mintSovereignAssetId() }));
  expect(otherAsset, 'STATUS_BINDING_MISMATCH', 'DENIED');
  assert.equal(otherAsset.statusRejection, 'STATUS_SUBJECT_MISMATCH');
  const otherIssuer = await w.check(READ, next(w, s1, 2, { issuer: ATTACKER }, attackerKeys), {
    verificationKeyResolver: trustingResolver({ [ISSUER]: issuerKeys, [ATTACKER]: attackerKeys }),
  });
  expect(otherIssuer, 'STATUS_BINDING_MISMATCH', 'DENIED');
  assert.equal(otherIssuer.statusRejection, 'STATUS_ISSUER_UNAUTHORIZED');
  const otherKey = await w.check(READ, next(w, s1, 2, {}, attackerKeys));
  expect(otherKey, 'STATUS_VERIFICATION_FAILED', 'DENIED');
  assert.equal(otherKey.statusRejection, 'STATUS_KEY_UNTRUSTED');
  const otherManifest = await w.check(READ, next(w, s1, 2, { manifestDigest: OTHER_DIGEST }));
  expect(otherManifest, 'STATUS_BINDING_MISMATCH', 'DENIED');
  assert.equal(otherManifest.statusRejection, 'MANIFEST_BINDING_MISMATCH');
  assert.deepEqual(await mark(w), before, 'no rejected status moved the mark');
  const otherTerms = await w.check(READ, next(w, s1, 2, { currentTerms: { claimId: w.terms.claimId, claimDigest: OTHER_DIGEST } }));
  expect(otherTerms, 'SUPERSEDED', 'DENIED');
});

test('14. concurrent different sequence-2 statuses: at most one is ever accepted, the rest latch a conflict', async () => {
  const { w, s1 } = await anchored();
  const variants = Array.from({ length: 40 }, (_, index) => next(w, s1, 2, { validUntil: `2026-10-29T00:00:00.${String(index + 1).padStart(3, '0')}Z` }));
  const results = await Promise.all(variants.map((status) => w.check(READ, status)));
  const advanced = results.filter((result) => result.history.transition === 'advanced');
  assert.equal(advanced.length, 1);
  assert.ok(results.filter((result) => result.freshnessVerdict === 'FRESH').length <= 1);
  assert.ok(results.filter((result) => result.freshnessVerdict === 'CONFLICT_DETECTED').length >= 39 - 1);
  assert.equal((await mark(w))!.mark.conflict, true);
});

test('14. concurrent identical statuses: one write, every check fresh', async () => {
  const { w, s1 } = await anchored();
  const s2 = next(w, s1, 2);
  const results = await Promise.all(Array.from({ length: 40 }, () => w.check(READ, s2)));
  assert.ok(results.every((result) => result.freshnessVerdict === 'FRESH'));
  assert.equal(results.filter((result) => result.history.transition === 'advanced').length, 1);
  assert.equal((await mark(w))!.revision, 2);
});

test('14. stress: interleaved writers through a yielding store keep the mark monotonic and consistent', async () => {
  const inner = createInMemoryStatusHighWaterMarkStore();
  const yielding: StatusHighWaterMarkStore = {
    read: async (key) => { await new Promise((resolve) => setImmediate(resolve)); return inner.read(key); },
    compareAndSet: async (key, revision, value) => { await new Promise((resolve) => setImmediate(resolve)); return inner.compareAndSet(key, revision, value); },
  };
  const w = await world({}, yielding);
  const chain: Signed[] = [w.status({ issuedAt: '2026-10-28T11:00:00.000Z' })];
  for (let sequence = 2; sequence <= 12; sequence += 1) {
    chain.push(w.status({ sequence, previousStatusDigest: chain[sequence - 2]!.digest, issuedAt: `2026-10-28T11:${String(sequence).padStart(2, '0')}:00.000Z` }));
  }
  assert.equal((await w.bootstrap(chain[0]!)).outcome, 'established');
  const order = Array.from({ length: 200 }, (_, index) => chain[(index * 7) % chain.length]!);
  const results = await Promise.all(order.map((status) => w.check(READ, status)));
  const final = (await mark(w))!.mark;
  assert.equal(final.conflict, false, 'honest statuses never produce a conflict');
  assert.ok(final.sequence >= 1 && final.sequence <= 12);
  for (const result of results) {
    assert.ok(['FRESH', 'ROLLBACK_DETECTED', 'CONTINUITY_UNPROVEN', 'HISTORY_STORE_UNAVAILABLE'].includes(result.freshnessVerdict), result.freshnessVerdict);
    if (result.history.before !== null && result.history.after !== null) assert.ok(result.history.after.sequence >= result.history.before.sequence);
  }
});

test('15. a lost compare-and-set race is recomputed against the winner, never applied blindly', async () => {
  const w0 = await world();
  const s1 = w0.status({ issuedAt: '2026-10-28T11:50:00.000Z' });
  const inner = w0.store;
  let raced = false;
  const s2 = next(w0, s1, 2);
  const s2b = next(w0, s1, 2, { validUntil: '2026-10-29T00:00:00.5Z' });
  const racing: StatusHighWaterMarkStore = {
    read: (key) => inner.read(key),
    async compareAndSet(key, revision, value) {
      if (!raced && value.sequence === 2) {
        raced = true;
        // Another writer commits the competing sequence 2 between our read and our write.
        const entry = await inner.read(key);
        await inner.compareAndSet(key, entry!.revision, { ...entry!.mark, sequence: 2, statusDigest: s2.digest, issuedAt: '2026-10-28T11:53:00.000Z', timeFloor: '2026-10-28T11:53:00.000Z' });
      }
      return inner.compareAndSet(key, revision, value);
    },
  };
  const w = { ...w0, store: racing, context: (overrides: Record<string, unknown> = {}) => w0.context({ historyStore: racing, ...overrides }) };
  assert.equal((await w0.bootstrap(s1)).outcome, 'established');
  const result = await checkDocumentUseFreshness(w0.decide(READ), s2b.text, w.context());
  expect(result, 'CONFLICT_DETECTED', 'DENIED');
  assert.equal((await inner.read({ sovereignAssetId: w0.doc.sovereignAssetId, issuer: ISSUER }))!.mark.statusDigest, s2.digest);
});

test('15. a store whose compare-and-set never succeeds is reported unavailable, not bypassed', async () => {
  const { w, s1 } = await anchored();
  const stuck: StatusHighWaterMarkStore = { read: (key) => w.store.read(key), compareAndSet: async () => false };
  expect(await w.check(READ, next(w, s1, 2), { historyStore: stuck }), 'HISTORY_STORE_UNAVAILABLE', 'DENIED');
  for (const answer of [1, 'true', {}, null]) {
    const odd: StatusHighWaterMarkStore = { read: (key) => w.store.read(key), compareAndSet: async () => answer as never };
    expect(await w.check(READ, next(w, s1, 2), { historyStore: odd }), 'HISTORY_STORE_UNAVAILABLE', 'DENIED', String(answer));
  }
});

test('16. an invalid status cannot advance the mark', async () => {
  const { w, s1 } = await anchored();
  const before = await mark(w);
  const s2 = next(w, s1, 2);
  const envelope = JSON.parse(s2.text) as { status: Record<string, unknown>; proof: unknown };
  envelope.status['sequence'] = 99;
  envelope.status['previousStatusDigest'] = OTHER_DIGEST;
  const tampered = { text: canonical(envelope), digest: s2.digest };
  const result = await w.check(READ, tampered);
  expect(result, 'STATUS_VERIFICATION_FAILED', 'DENIED');
  assert.equal(result.statusRejection, 'STATUS_SIGNATURE_INVALID');
  assert.deepEqual(await mark(w), before);
});

test('17. store errors fail closed and change nothing', async () => {
  const { w, s1 } = await anchored();
  const before = await mark(w);
  const readFails: StatusHighWaterMarkStore = { read: async () => { throw new Error('disk'); }, compareAndSet: (k, r, v) => w.store.compareAndSet(k, r, v) };
  const writeFails: StatusHighWaterMarkStore = { read: (k) => w.store.read(k), compareAndSet: async () => { throw new Error('disk'); } };
  const syncThrow = { read: () => { throw new Error('sync'); }, compareAndSet: () => { throw new Error('sync'); } };
  expect(await w.check(READ, next(w, s1, 2), { historyStore: readFails }), 'HISTORY_STORE_UNAVAILABLE', 'DENIED');
  expect(await w.check(READ, next(w, s1, 2), { historyStore: writeFails }), 'HISTORY_STORE_UNAVAILABLE', 'DENIED');
  expect(await w.check(READ, next(w, s1, 2), { historyStore: syncThrow }), 'HISTORY_STORE_UNAVAILABLE', 'DENIED');
  assert.deepEqual(await mark(w), before);
});

test('18. with no history every action is refused and nothing is initialized implicitly', async () => {
  const w = await world({ rules: [rule('a', Permission, ACCESS), rule('e', Permission, EXPORT), rule('m', Permission, MODIFY)] });
  const s1 = w.status();
  for (const action of [READ, EXPORT.termRef, MODIFY.termRef]) {
    const result = await w.check(action, s1);
    expect(result, 'HISTORY_UNINITIALIZED', 'DENIED', action);
    assert.equal(result.policyDecisionBefore, 'ALLOWED');
    assert.equal(result.history.initialization, 'UNINITIALIZED');
  }
  assert.equal(await mark(w), undefined);
});

test('19. a tampered or malformed stored mark is refused', async () => {
  const { w, s1 } = await anchored();
  const good = (await mark(w))!;
  const variants: Array<[string, unknown]> = [
    ['not an object', 'mark'],
    ['missing revision', { mark: good.mark }],
    ['zero revision', { revision: 0, mark: good.mark }],
    ['extra key', { ...good, note: 1 }],
    ['negative sequence', { ...good, mark: { ...good.mark, sequence: -1 } }],
    ['bad digest', { ...good, mark: { ...good.mark, statusDigest: 'X' } }],
    ['bad time floor', { ...good, mark: { ...good.mark, timeFloor: 'yesterday' } }],
    ['floor before head', { ...good, mark: { ...good.mark, timeFloor: '2000-01-01T00:00:00Z' } }],
    ['unsorted retired', { ...good, mark: { ...good.mark, retiredTermsDigests: ['b'.repeat(64), 'a'.repeat(64)] } }],
    ['bad continuity', { ...good, mark: { ...good.mark, continuity: 'maybe' } }],
    ['string flag', { ...good, mark: { ...good.mark, conflict: 'false' } }],
    ['other key', { ...good, mark: { ...good.mark, sovereignAssetId: mintSovereignAssetId() } }],
    ['other issuer', { ...good, mark: { ...good.mark, issuer: ATTACKER } }],
    ['accessor', Object.defineProperty({ mark: good.mark }, 'revision', { enumerable: true, get: () => good.revision })],
  ];
  for (const [label, stored] of variants) {
    const store: StatusHighWaterMarkStore = { read: async () => stored as never, compareAndSet: async () => true };
    expect(await w.check(READ, s1, { historyStore: store }), 'HISTORY_STORE_INVALID', 'DENIED', label);
  }
});

test('20. a process restart with the in-memory store loses the history, and the gate refuses', async () => {
  const { w, s1 } = await anchored();
  expect(await w.check(READ, s1), 'FRESH', 'ALLOWED');
  const restarted = createInMemoryStatusHighWaterMarkStore();
  expect(await w.check(READ, s1, { historyStore: restarted }), 'HISTORY_UNINITIALIZED', 'DENIED');
});

// ---------------------------------------------------------------------------
// Policy and operational freshness

test('READ: fresh up to exactly 24 hours, stale one nanosecond later', async () => {
  const { w, s1 } = await anchored();
  const at = (issuedAt: string) => next(w, s1, 2, { issuedAt });
  // Status 2 issued at the 24 h boundary relative to an evaluation 24 h later.
  const s2 = at('2026-10-28T11:50:00.000Z');
  expect(await w.check(READ, s2, { evaluationTime: '2026-10-29T11:50:00.000Z', }), 'EXPIRED', 'DENIED', 'outside its signed window first');
  const w2 = await world();
  const t1 = w2.status({ issuedAt: '2026-10-28T00:00:00.000Z', validUntil: '2026-11-01T00:00:00.000Z' });
  await w2.bootstrap(t1, { evaluationTime: '2026-10-28T00:00:00.000Z' });
  expect(await w2.check(READ, t1, { evaluationTime: '2026-10-29T00:00:00.000Z' }), 'FRESH', 'ALLOWED', 'exactly 24 h');
  expect(await w2.check(READ, t1, { evaluationTime: '2026-10-29T00:00:00.000000001Z' }), 'STALE', 'DENIED', '24 h + 1 ns');
});

test('EXPORT: fresh at exactly 15 minutes, stale one nanosecond later', async () => {
  const w = await world({ rules: [rule('a', Permission, ACCESS), rule('e', Permission, EXPORT)] });
  const s1 = w.status({ issuedAt: '2026-10-28T11:45:00.000Z' });
  await w.bootstrap(s1);
  expect(await w.check(EXPORT.termRef, s1), 'FRESH', 'ALLOWED', 'exactly 15 min');
  expect(await w.check(EXPORT.termRef, s1, { evaluationTime: '2026-10-28T12:00:00.000000001Z' }), 'STALE', 'DENIED');
  // The same status is still fresh for READ at that instant.
  expect(await w.check(READ, s1, { evaluationTime: '2026-10-28T12:00:00.000000001Z' }), 'FRESH', 'ALLOWED');
});

test('a host may be stricter than the ceilings, never looser', async () => {
  const { w, s1 } = await anchored();
  const strict = { ...DOCUMENT_USE_FRESHNESS_CEILINGS, [READ]: 60 };
  expect(await w.check(READ, s1, { maxStatusAgeSeconds: strict }), 'STALE', 'DENIED');
  for (const [label, limits] of [
    ['above ceiling', { ...DOCUMENT_USE_FRESHNESS_CEILINGS, [READ]: 86_401 }],
    ['zero', { ...DOCUMENT_USE_FRESHNESS_CEILINGS, [EXPORT.termRef]: 0 }],
    ['fractional', { ...DOCUMENT_USE_FRESHNESS_CEILINGS, [MODIFY.termRef]: 1.5 }],
    ['string', { ...DOCUMENT_USE_FRESHNESS_CEILINGS, [READ]: '60' }],
    ['missing action', { [READ]: 60, [EXPORT.termRef]: 60 }],
    ['extra action', { ...DOCUMENT_USE_FRESHNESS_CEILINGS, other: 1 }],
    ['not an object', 60],
  ] as const) {
    expect(await w.check(READ, s1, { maxStatusAgeSeconds: limits }), 'CONTEXT_INVALID', 'DENIED', label);
  }
});

test('MODIFY: WITHHELD stays WITHHELD when fresh, and becomes DENIED when revoked', async () => {
  const { w, s1 } = await anchored();
  const fresh = await w.check(MODIFY.termRef, s1);
  expect(fresh, 'FRESH', 'WITHHELD');
  assert.equal(fresh.policyDecisionBefore, 'WITHHELD');
  const revoked = await w.check(MODIFY.termRef, next(w, s1, 2, { currentTerms: null }));
  expect(revoked, 'REVOKED', 'DENIED');
});

test('a DENIED decision stays DENIED even with a fresh status', async () => {
  const { w, s1 } = await anchored();
  const result = await w.check(EXPORT.termRef, s1);
  expect(result, 'FRESH', 'DENIED');
  assert.equal(result.policyDecisionBefore, 'DENIED');
});

test('Public audience with a Restriction stays DENIED', async () => {
  const { w, s1 } = await anchored({ audience: { kind: SovereignLicenseTermsAudienceKind.Public } });
  const decision = w.decide(EXPORT.termRef);
  assert.equal(decision.reason, 'RESTRICTED');
  expect(await w.check(EXPORT.termRef, s1), 'FRESH', 'DENIED');
});

test('expired and future-dated statuses are refused', async () => {
  const { w, s1 } = await anchored();
  expect(await w.check(READ, next(w, s1, 2, { validUntil: '2026-10-28T11:59:59.999999999Z' })), 'EXPIRED', 'DENIED');
  const future = await w.check(READ, next(w, s1, 2, { issuedAt: '2026-10-28T12:00:00.000000001Z' }));
  expect(future, 'STATUS_VERIFICATION_FAILED', 'DENIED');
  assert.equal(future.statusRejection, 'STATUS_FROM_FUTURE');
});

test('a status naming other terms than the evaluated policy is SUPERSEDED', async () => {
  const { w, s1 } = await anchored();
  expect(await w.check(READ, next(w, s1, 2, { currentTerms: { claimId: 'claim:terms-9', claimDigest: OTHER_DIGEST } })), 'SUPERSEDED', 'DENIED');
});

test('an unknown action is UNSUPPORTED_ACTION and stays DENIED', async () => {
  const { w, s1 } = await anchored();
  const result = await w.check('soberania.document:print', s1);
  expect(result, 'UNSUPPORTED_ACTION', 'DENIED');
  assert.equal(result.history.transition, 'not_attempted');
});

test('a clock behind an accepted status is a clock rollback', async () => {
  const { w, s1 } = await anchored();
  await w.check(READ, next(w, s1, 2, { issuedAt: '2026-10-28T11:58:00.000Z' }));
  const result = await w.check(READ, s1, { evaluationTime: '2026-10-28T11:55:00.000Z' });
  expect(result, 'CLOCK_ROLLBACK_DETECTED', 'DENIED');
});

test('the gate uses the decision instant: missing or different evaluation times are refused', async () => {
  const { w, s1 } = await anchored();
  const decision = w.decide(READ);
  const missing = w.context();
  delete missing['evaluationTime'];
  expect(await checkDocumentUseFreshness(decision, s1.text, missing), 'CONTEXT_INVALID', 'DENIED');
  expect(await checkDocumentUseFreshness(decision, s1.text, w.context({ evaluationTime: '2026-10-28T12:00:00.001Z' })), 'CONTEXT_INVALID', 'DENIED');
  expect(await checkDocumentUseFreshness(decision, s1.text, w.context({ evaluationTime: 'now' })), 'CONTEXT_INVALID', 'DENIED');
  // A decision that never had a valid instant cannot be refreshed.
  const timeless = w.decide(READ, 'not-a-time');
  assert.equal(timeless.reason, 'EVALUATION_TIME_INVALID');
  expect(await checkDocumentUseFreshness(timeless, s1.text, w.context()), 'CONTEXT_INVALID', 'DENIED');
  const realNow = Date.now;
  Date.now = () => { throw new Error('the gate must not read the clock'); };
  try {
    expect(await w.check(READ, s1), 'FRESH', 'ALLOWED');
  } finally {
    Date.now = realNow;
  }
});

test('an invalid trusted context is refused', async () => {
  const { w, s1 } = await anchored();
  const decision = w.decide(READ);
  const cases: Array<[string, unknown]> = [
    ['unknown key', w.context({ approved: true })],
    ['missing operation', (() => { const c = w.context(); delete c['operationId']; return c; })()],
    ['blank operation', w.context({ operationId: '' })],
    ['padded operation', w.context({ operationId: ' op-1' })],
    ['long operation', w.context({ operationId: 'x'.repeat(257) })],
    ['store without CAS', w.context({ historyStore: { read: () => undefined } })],
    ['no resolver', w.context({ verificationKeyResolver: {} })],
    ['null', null],
    ['array', []],
  ];
  for (const [label, context] of cases) expect(await checkDocumentUseFreshness(decision, s1.text, context), 'CONTEXT_INVALID', 'DENIED', label);
});

test('getters and inherited fields in the context are refused and never invoked', async () => {
  const { w, s1 } = await anchored();
  let invoked = 0;
  const getter = w.context();
  Object.defineProperty(getter, 'evaluationTime', { enumerable: true, get: () => { invoked += 1; return NOW; } });
  expect(await checkDocumentUseFreshness(w.decide(READ), s1.text, getter), 'CONTEXT_INVALID', 'DENIED');
  const limits = { ...DOCUMENT_USE_FRESHNESS_CEILINGS };
  Object.defineProperty(limits, READ, { enumerable: true, get: () => { invoked += 1; return 60; } });
  expect(await checkDocumentUseFreshness(w.decide(READ), s1.text, w.context({ maxStatusAgeSeconds: limits })), 'CONTEXT_INVALID', 'DENIED');
  const inherited = Object.create(w.context()) as Record<string, unknown>;
  expect(await checkDocumentUseFreshness(w.decide(READ), s1.text, inherited), 'CONTEXT_INVALID', 'DENIED');
  assert.equal(invoked, 0);
});

test('a store whose methods are swapped after the first read keeps using the first ones', async () => {
  const { w, s1 } = await anchored();
  let reads = 0;
  const swapping = {
    get read() { reads += 1; return reads === 1 ? w.store.read : async () => undefined; },
    compareAndSet: w.store.compareAndSet,
  };
  expect(await w.check(READ, next(w, s1, 2), { historyStore: swapping }), 'FRESH', 'ALLOWED');
  assert.equal(reads, 1);
});

// ---------------------------------------------------------------------------
// Provenance and forgery

test('a decision over fabricated eligibility has no provenance', async () => {
  const { w, s1 } = await anchored();
  const forged = { ...w.doc.eligibility };
  const decision = evaluateDocumentUsePolicy(forged, { action: READ }, {
    receiverPrincipal: RECEIVER,
    evaluationTime: NOW,
    expectedSovereignAssetId: w.doc.sovereignAssetId,
    policyReference: { ...w.terms },
  });
  assert.equal(decision.reason, 'ELIGIBILITY_UNVERIFIED');
  const result = await checkDocumentUseFreshness(decision, s1.text, w.context());
  expect(result, 'POLICY_PROVENANCE_INVALID', 'DENIED');
  assert.equal(result.policyDecisionBefore, null);
});

test('fabricated, copied or deserialized FV-P3 decisions are refused, whatever they claim', async () => {
  const { w, s1 } = await anchored();
  const genuine = w.decide(READ);
  const forgeries: unknown[] = [
    { ...genuine },
    JSON.parse(JSON.stringify(genuine)),
    Object.freeze({ ...genuine, decision: 'ALLOWED' }),
    { ...w.decide(EXPORT.termRef), decision: 'ALLOWED', reason: 'PERMITTED' },
    new Proxy(genuine, {}),
    null,
    'ALLOWED',
  ];
  for (const forged of forgeries) {
    const result = await checkDocumentUseFreshness(forged, s1.text, w.context());
    expect(result, 'POLICY_PROVENANCE_INVALID', 'DENIED');
    assert.equal(result.history.transition, 'not_attempted');
  }
});

test('a fabricated FV-P4B verification result is not a status: the gate verifies the artifact itself', async () => {
  const { w, s1 } = await anchored();
  const fake = { outcome: 'authentic_authorized', sequence: 1, statusDigest: s1.digest, assetStatus: 'active', currentTerms: { ...w.terms } };
  for (const input of [fake, JSON.stringify(fake), { text: s1.text }]) {
    const result = await checkDocumentUseFreshness(w.decide(READ), input, w.context());
    expect(result, 'STATUS_VERIFICATION_FAILED', 'DENIED');
    assert.equal(result.statusRejection, 'STATUS_MALFORMED');
  }
});

test('no status at all is UNKNOWN', async () => {
  const { w } = await anchored();
  expect(await w.check(READ, null), 'UNKNOWN', 'DENIED');
});

test('repeated evaluation is deterministic and the result is frozen', async () => {
  const { w, s1 } = await anchored();
  const first = await w.check(READ, s1);
  for (let index = 0; index < 3; index += 1) assert.deepEqual(await w.check(READ, s1), first);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.history), true);
});

test('results authorize nothing, carry no content and cannot pass as an RSDK-02B verdict', async () => {
  const { w, s1 } = await anchored();
  const result = await w.check(READ, s1);
  assert.equal('decision' in result, false);
  for (const key of ['capability', 'authorized', 'latest', 'statement', 'rules', 'content']) assert.equal(key in result, false, key);
  assert.equal(JSON.stringify(result).includes('Synthetic rule'), false);
  assert.deepEqual(Object.keys(result).sort(), [
    'action', 'authorization', 'evaluationTime', 'execution', 'freshnessVerdict', 'gate', 'history', 'maxStatusAgeSeconds',
    'operationId', 'policy', 'policyDecisionAfterFreshness', 'policyDecisionBefore', 'sovereignAssetId', 'status', 'statusRejection',
  ]);
});

test('non-escalation: across every scenario the decision after freshness is never higher than before', async () => {
  const { w, s1 } = await anchored({ rules: [rule('a', Permission, ACCESS), ...PROFILE_RULES.slice(1)] });
  const s2 = next(w, s1, 2);
  const statuses: Array<Signed | null> = [s1, s2, next(w, s1, 2, { currentTerms: null }), next(w, s1, 2, { assetStatus: 'withdrawn', currentTerms: null }), null];
  for (const action of [READ, EXPORT.termRef, MODIFY.termRef, 'unknown']) {
    for (const status of statuses) {
      const result = await w.check(action, status);
      const before = result.policyDecisionBefore ?? 'DENIED';
      assert.ok(RANK[result.policyDecisionAfterFreshness]! <= RANK[before]!, `${action} ${result.freshnessVerdict}`);
      if (result.freshnessVerdict !== 'FRESH') assert.equal(result.policyDecisionAfterFreshness, 'DENIED');
    }
  }
});

test('the verdict set is closed and duplicate-free', () => {
  assert.equal(new Set(DOCUMENT_USE_FRESHNESS_VERDICTS).size, DOCUMENT_USE_FRESHNESS_VERDICTS.length);
  assert.equal(Object.isFrozen(DOCUMENT_USE_FRESHNESS_VERDICTS), true);
  assert.deepEqual({ ...DOCUMENT_USE_FRESHNESS_CEILINGS }, { [READ]: 86_400, [EXPORT.termRef]: 900, [MODIFY.termRef]: 900 });
});

// ---------------------------------------------------------------------------
// Bootstrap

test('bootstrap establishes once and never overwrites without reanchor', async () => {
  const w = await world();
  const s1 = w.status();
  assert.equal((await w.bootstrap(s1)).reason, 'ESTABLISHED');
  const again = await w.bootstrap(next(w, s1, 2));
  assert.equal(again.reason, 'ALREADY_ESTABLISHED');
  assert.equal((await mark(w))!.mark.sequence, 1);
});

test('re-anchoring never rolls back, reopens a withdrawal or revives retired terms', async () => {
  const { w, s1 } = await anchored();
  const s2 = next(w, s1, 2, { currentTerms: { claimId: 'claim:terms-2', claimDigest: OTHER_DIGEST } });
  await w.check(READ, s2);
  assert.equal((await w.bootstrap(s1, { reanchor: true })).reason, 'REANCHOR_ROLLBACK');
  assert.equal((await w.bootstrap(next(w, s2, 3), { reanchor: true })).reason, 'REANCHOR_REINTRODUCES_RETIRED_TERMS');
  const withdrawn = next(w, s2, 3, { assetStatus: 'withdrawn', currentTerms: null });
  await w.check(READ, withdrawn);
  assert.equal((await w.bootstrap(next(w, withdrawn, 4, { currentTerms: { claimId: 'claim:terms-3', claimDigest: 'c'.repeat(64) } }), { reanchor: true })).reason, 'REANCHOR_REACTIVATES_WITHDRAWN');
});

test('re-anchoring after a conflict clears the latch only through the trusted operation', async () => {
  const { w, s1 } = await anchored();
  const s2 = next(w, s1, 2);
  await w.check(READ, s2);
  await w.check(READ, next(w, s1, 2, { validUntil: '2026-10-29T00:00:00.5Z' }));
  expect(await w.check(READ, s2), 'CONFLICT_DETECTED', 'DENIED');
  assert.equal((await w.bootstrap(s2, { reanchor: true })).reason, 'REESTABLISHED');
  expect(await w.check(READ, s2), 'FRESH', 'ALLOWED');
});

test('bootstrap refuses invalid statuses and invalid contexts', async () => {
  const w = await world();
  const forged = w.status({}, attackerKeys);
  const refused = await w.bootstrap(forged);
  assert.equal(refused.reason, 'STATUS_REJECTED');
  assert.equal(refused.statusRejection, 'STATUS_KEY_UNTRUSTED');
  assert.equal((await w.bootstrap(w.status(), { reanchor: false })).reason, 'CONTEXT_INVALID');
  assert.equal((await w.bootstrap(w.status(), { evaluationTime: 'now' })).reason, 'CONTEXT_INVALID');
  assert.equal((await w.bootstrap(w.status(), { extra: 1 })).reason, 'CONTEXT_INVALID');
  assert.equal(await mark(w), undefined);
});

// ---------------------------------------------------------------------------
// Existing behaviour is unchanged

test('FV-P2 and FV-P3 results expose exactly the fields they did before', async () => {
  const w = await world();
  assert.deepEqual(Object.keys(w.doc.eligibility).sort(), [
    'artifactVerification', 'audience', 'authorization', 'currentManifestVersion', 'documentProfile', 'freshness', 'outcome', 'policyEvaluation',
    'profile', 'reasons', 'registrant', 'revocation', 'sovereignAssetId', 'temporalValidity', 'terms',
  ]);
  assert.deepEqual(Object.keys(w.decide(READ)).sort(), [
    'action', 'authorization', 'decision', 'documentProfile', 'evaluationTime', 'evaluator', 'execution', 'freshness', 'matchedRuleIds',
    'policy', 'reason', 'revocation', 'sovereignAssetId',
  ]);
  const again = await verifyDocumentUseEligibility('{}', { verificationKeyResolver: trustingResolver(), expectedSovereignAssetId: w.doc.sovereignAssetId });
  assert.equal(again.outcome, 'ineligible');
});

test('the history store key is exactly the asset and the verified registrant', async () => {
  const keys: StatusHistoryKey[] = [];
  const inner = createInMemoryStatusHighWaterMarkStore();
  const recording: StatusHighWaterMarkStore = {
    read: async (key) => { keys.push(key); return inner.read(key); },
    compareAndSet: (key, revision, value: StatusHighWaterMark) => inner.compareAndSet(key, revision, value),
  };
  const w = await world({}, recording);
  await w.bootstrap(w.status());
  await w.check(READ, w.status());
  assert.ok(keys.length >= 2);
  for (const key of keys) assert.deepEqual(key, { sovereignAssetId: w.doc.sovereignAssetId, issuer: ISSUER });
});
