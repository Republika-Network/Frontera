import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import Database from 'better-sqlite3';

import { EXECUTION_FAILURE_REASONS } from '../../features/execution-runtime/index.js';
import type { PaymentFinalityQuery } from '../../features/payment-runtime/index.js';
import { createSqliteExecutionOutcomeStore } from '../execution-outcome-store/sqlite-execution-outcome-store.js';
import { createSqliteGovernanceStore } from '../governance-store/sqlite-governance-store.js';
import {
  PAYMENT_RECEIPT_FORMAT,
  createInMemoryPaymentSettlementStore,
  createSqlitePaymentSettlementStore,
  derivePaymentReceipt,
  disclosePaymentReceipt,
  isPaymentSettlementStoreError,
  paymentReceiptId,
  paymentSettlementId,
  verifyPaymentReceipt,
  type PaymentReceipt,
  type PaymentSettlementRecord,
} from '../payment-settlement/index.js';
import {
  BINDING,
  FINALITY_AUTHORITY_ID,
  GOVERNED_ACCOUNT,
  IDENTITY,
  NOW,
  ORG,
  exactEvidence,
  finalityAuthority,
  governed,
  payment,
  paymentWorld,
  resolveByP12,
  scratchDirectory,
  settlementHarness,
} from './pay05-settlement-support.js';

/**
 * PAY-05 — settlement and receipt qualification (S1 – S20, R1 – R10).
 *
 * The exit criterion, made executable: **"settled" means funds finality with
 * evidence**, distinct from P11's provider confirmation, P12's execution
 * resolution and P7's capacity settlement. A payment reaches `settled` only by
 * an explicit verification that a trusted finality authority answered `final`,
 * with bounded evidence that matches the canonical payment exactly, durably
 * recorded once; its receipt is derived from that record and nothing else.
 */

const scratch = scratchDirectory('aoc-pay05-settlement-');
after(() => scratch.cleanup());

async function executedPayment(options: Parameters<typeof paymentWorld>[0] = {}) {
  const { world, rail } = paymentWorld(options);
  const result = await world.orchestrator.govern(IDENTITY, governed(payment()));
  assert.ok(result.executionId !== undefined, JSON.stringify(result));
  return { world, rail, result, executionId: result.executionId };
}

describe('PAY-05 S1 – S6 — the settlement basis: completion is necessary, never sufficient', () => {
  it('S1: P11 confirmed-completed alone is NOT settled — it is awaiting finality, and no receipt exists', async () => {
    const { world, result, executionId } = await executedPayment();
    assert.equal(result.status, 'executed');
    const { service, authority } = settlementHarness(world);
    const status = await service.readSettlement({ organizationId: ORG, executionId });
    assert.deepEqual(status, { outcome: 'status', state: 'awaiting-finality' });
    assert.equal(await service.receipt({ organizationId: ORG, executionId }), undefined, 'R1: no receipt without a settlement');
    assert.equal(authority.queries.length, 0, 'a read asks nobody');
  });

  it('S2: P11 confirmed-not-completed can never settle — the authority is not even asked', async () => {
    const { world, result, executionId } = await executedPayment({ behaviour: () => ({ status: 'not-completed', reason: EXECUTION_FAILURE_REASONS.PROVIDER_REJECTED }) });
    assert.equal(result.status, 'execution_failed');
    const { service, authority } = settlementHarness(world);
    assert.deepEqual(await service.verifySettlement({ organizationId: ORG, executionId }), { outcome: 'not-eligible', state: 'not-settleable' });
    assert.deepEqual(await service.readSettlement({ organizationId: ORG, executionId }), { outcome: 'status', state: 'not-settleable' });
    assert.equal(authority.queries.length, 0);
  });

  it('S3: P11 unconfirmed with no P12 resolution cannot settle — execution-uncertain, authority not asked', async () => {
    const { world, result, executionId } = await executedPayment({ behaviour: () => ({ status: 'unconfirmed', externalReference: 'ref-uncertain' }) });
    assert.equal(result.status, 'execution_unconfirmed');
    const { service, authority } = settlementHarness(world);
    assert.deepEqual(await service.verifySettlement({ organizationId: ORG, executionId }), { outcome: 'not-eligible', state: 'execution-uncertain' });
    assert.equal(authority.queries.length, 0);
  });

  it('S4: P11 unconfirmed + P12 resolved completed is ELIGIBLE for finality verification — not automatically settled', async () => {
    const { world, rail, executionId } = await executedPayment({ behaviour: () => ({ status: 'unconfirmed', externalReference: 'ref-uncertain' }) });
    const harness = settlementHarness(world);
    await resolveByP12(world, harness.resolutions, executionId, { outcome: 'resolved', certainty: 'confirmed-completed', providerRef: 'ref-uncertain' });
    assert.deepEqual(await harness.service.readSettlement({ organizationId: ORG, executionId }), { outcome: 'status', state: 'awaiting-finality' }, 'P12 completed is not settled');
    const settled = await harness.service.verifySettlement({ organizationId: ORG, executionId });
    assert.equal(settled.outcome, 'settled', JSON.stringify(settled));
    assert.equal(harness.authority.queries[0]?.basis, 'resolution-confirmed-completed');
    assert.equal(harness.authority.queries[0]?.providerRef, 'ref-uncertain');
    assert.equal(settled.outcome === 'settled' && settled.settlement.basis.resolutionDigest !== undefined, true, 'the settlement names the P12 resolution it stands on');
    assert.equal(rail.callCount, 1, 'resolution and settlement re-sent nothing');
  });

  it('S4b: P12 proving non-completion makes the payment not-settleable for good', async () => {
    const { world, executionId } = await executedPayment({ behaviour: () => ({ status: 'unconfirmed' }) });
    const harness = settlementHarness(world);
    await resolveByP12(world, harness.resolutions, executionId, { outcome: 'resolved', certainty: 'confirmed-not-completed', failure: EXECUTION_FAILURE_REASONS.PROVIDER_REJECTED });
    assert.deepEqual(await harness.service.verifySettlement({ organizationId: ORG, executionId }), { outcome: 'not-eligible', state: 'not-settleable' });
    assert.equal(harness.authority.queries.length, 0);
  });

  it('S5: an authority that cannot establish finality ("not final") leaves the payment awaiting finality, nothing written', async () => {
    const { world, executionId } = await executedPayment();
    const harness = settlementHarness(world, { authority: finalityAuthority(() => ({ outcome: 'not-final' })) });
    assert.deepEqual(await harness.service.verifySettlement({ organizationId: ORG, executionId }), { outcome: 'not-final' });
    assert.equal(await harness.store.read({ organizationId: ORG }, executionId), undefined);
    assert.deepEqual(await harness.service.readSettlement({ organizationId: ORG, executionId }), { outcome: 'status', state: 'awaiting-finality' });
  });

  it('S6: an unavailable authority (throws, times out, answers garbage) is never "settled" and never "not settled"', async () => {
    const { world, executionId } = await executedPayment();
    for (const [answer, reason] of [
      [
        () => {
          throw new Error('ECONNRESET');
        },
        'failed',
      ],
      [() => Promise.reject(new Error('timeout')), 'failed'],
      [() => ({ outcome: 'final' }), 'invalid-answer'],
      [() => ({ outcome: 'settled' }), 'invalid-answer'],
      [() => ({ outcome: 'not-final', evidence: {} }), 'invalid-answer'],
      [() => 'final', 'invalid-answer'],
    ] as const) {
      const harness = settlementHarness(world, { authority: finalityAuthority(answer as (query: PaymentFinalityQuery) => unknown) });
      assert.deepEqual(await harness.service.verifySettlement({ organizationId: ORG, executionId }), { outcome: 'authority-unavailable', reason });
      assert.equal(await harness.store.read({ organizationId: ORG }, executionId), undefined);
      assert.deepEqual(await harness.service.readSettlement({ organizationId: ORG, executionId }), { outcome: 'status', state: 'awaiting-finality' }, 'availability lost; no fact changed');
    }
  });

  it('no trusted selection is no authority: an unselected or unknown authority id writes nothing', async () => {
    const { world, executionId } = await executedPayment();
    const { createPaymentSettlementService } = await import('../payment-settlement/index.js');
    for (const select of [() => 'other.authority', () => 42 as unknown as string, () => { throw new Error('no'); }]) {
      const service = createPaymentSettlementService({
        outcomes: world.outcomes,
        resolutions: settlementHarness(world).resolutions,
        governance: world.rawStore,
        payments: [BINDING],
        store: createInMemoryPaymentSettlementStore({ now: () => NOW }),
        authorities: [finalityAuthority()],
        selectAuthority: select,
        now: () => NOW,
      });
      assert.deepEqual(await service.verifySettlement({ organizationId: ORG, executionId }), { outcome: 'authority-unavailable', reason: 'unselected' });
    }
  });
});

describe('PAY-05 S7 – S13 — finality evidence must be exactly this payment', () => {
  it('S7: exact, valid finality evidence settles — durably, with bounded evidence and a derived receipt', async () => {
    const { world, rail, executionId, result } = await executedPayment();
    const harness = settlementHarness(world);
    const settled = await harness.service.verifySettlement({ organizationId: ORG, executionId });
    assert.equal(settled.outcome, 'settled', JSON.stringify(settled));
    if (settled.outcome !== 'settled') return;
    assert.equal(settled.established, 'now');
    const record = settled.settlement;
    assert.equal(record.settlementId, paymentSettlementId(ORG, executionId));
    assert.equal(record.requestId, result.requestId);
    assert.equal(record.basis.kind, 'provider-confirmed-completed');
    assert.deepEqual(record.payment, { source: { accountId: GOVERNED_ACCOUNT }, destination: { kind: 'account', reference: 'vendor-4471' }, amount: { value: '100', unit: 'USD' }, purpose: 'vendor-payment', reference: 'INV-2026-0042' });
    assert.equal(record.finality.authorityId, FINALITY_AUTHORITY_ID);
    assert.equal(record.finality.finalizedAt, '2026-01-01T00:00:05Z');
    assert.equal(settled.receipt.receiptId, paymentReceiptId(ORG, record.settlementId));
    assert.equal(rail.callCount, 1, 'settlement never reaches the rail');
    const query = harness.authority.queries[0]!;
    const observation = (await world.outcomes.read({ organizationId: ORG }, executionId))?.terminal?.observation;
    assert.equal(observation?.kind === 'provider' && observation.certainty, 'confirmed-completed');
    assert.equal(query.providerRef, observation?.kind === 'provider' ? observation.providerRef : undefined, 'the authority is told the handle P11 recorded — a locator, not proof');
    assert.equal(query.basis, 'provider-confirmed-completed');
    assert.equal(Object.isFrozen(query), true);
  });

  for (const [label, overrides, field] of [
    ['S8 wrong execution', (query: PaymentFinalityQuery) => ({ executionId: `${query.executionId}-other` }), 'execution'],
    ['S8b wrong provider reference', () => ({ providerRef: 'ref-of-another-transfer' }), 'provider-reference'],
    ['S9 wrong amount', (query: PaymentFinalityQuery) => ({ amount: { value: '99.99', unit: query.payment.amount.unit } }), 'amount'],
    ['S10 wrong asset', (query: PaymentFinalityQuery) => ({ amount: { value: query.payment.amount.value, unit: 'EUR' } }), 'asset'],
    ['S11 wrong destination', () => ({ destination: { kind: 'account', reference: 'vendor-9999' } }), 'destination'],
    ['S11b wrong destination kind', () => ({ destination: { kind: 'beneficiary', reference: 'vendor-4471' } }), 'destination'],
    ['S12 wrong source', () => ({ source: { accountId: 'another-account' } }), 'source'],
  ] as const) {
    it(`${label}: refused (evidence-mismatch ${field}); nothing written`, async () => {
      const { world, executionId } = await executedPayment();
      const harness = settlementHarness(world, { authority: finalityAuthority((query) => ({ outcome: 'final', evidence: exactEvidence(query, overrides(query)) })) });
      assert.deepEqual(await harness.service.verifySettlement({ organizationId: ORG, executionId }), { outcome: 'evidence-mismatch', field });
      assert.equal(await harness.store.read({ organizationId: ORG }, executionId), undefined);
    });
  }

  it('S13: a rail that contradicts the completed execution (wrong network, validated failure) records nothing and rewrites nothing', async () => {
    const { world, executionId } = await executedPayment();
    const before = await world.outcomes.read({ organizationId: ORG }, executionId);
    const harness = settlementHarness(world, { authority: finalityAuthority(() => ({ outcome: 'contradicted', reason: 'test.validated-failure' })) });
    assert.deepEqual(await harness.service.verifySettlement({ organizationId: ORG, executionId }), { outcome: 'finality-contradicted', reason: 'test.validated-failure' });
    assert.equal(await harness.store.read({ organizationId: ORG }, executionId), undefined);
    assert.deepEqual(await world.outcomes.read({ organizationId: ORG }, executionId), before, 'P11 is never rewritten');
  });

  it('S13b / R8: evidence carrying a secret, a URL, a giant value or an unbounded fact list is not an answer', async () => {
    const { world, executionId } = await executedPayment();
    const secretShaped: readonly Record<string, unknown>[] = [
      { facts: [{ name: 'test.authorization', value: 'Bearer abcdefghijklmnop' }] },
      { facts: [{ name: 'test.privateKey', value: 'deadbeef' }] },
      { facts: [{ name: 'test.seed', value: 'sEdTM1uX8pu2do5XvTnutH6HsouMaM2' }] },
      { facts: [{ name: 'test.token', value: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc' }] },
      { facts: [{ name: 'test.cert', value: '-----BEGIN PRIVATE KEY-----' }] },
      { facts: [{ name: 'test.link', value: 'https://provider.example/tx/1' }] },
      { facts: [{ name: 'test.blob', value: 'x'.repeat(257) }] },
      { facts: Array.from({ length: 17 }, (_, index) => ({ name: `test.fact-${String(index).padStart(2, '0')}`, value: '1' })) },
      { facts: [{ name: 'test.dup', value: '1' }, { name: 'test.dup', value: '2' }] },
      { providerRef: 'Bearer abcdefghijklmnopqrstuvwxyz' },
      { finalizedAt: 'yesterday' },
      { raw: { body: 'the provider response' } },
      { amount: { value: 100, unit: 'USD' } },
    ];
    for (const overrides of secretShaped) {
      const harness = settlementHarness(world, { authority: finalityAuthority((query) => ({ outcome: 'final', evidence: exactEvidence(query, overrides) })) });
      const verification = await harness.service.verifySettlement({ organizationId: ORG, executionId });
      assert.deepEqual(verification, { outcome: 'authority-unavailable', reason: 'invalid-answer' }, JSON.stringify(overrides).slice(0, 80));
    }
  });
});

describe('PAY-05 S14 – S17 — one execution, one settlement truth', () => {
  it('S14: replaying the same finality proof is idempotent — the same settlement, the same receipt, and the authority is not asked again', async () => {
    const { world, executionId } = await executedPayment();
    const harness = settlementHarness(world);
    const first = await harness.service.verifySettlement({ organizationId: ORG, executionId });
    const second = await harness.service.verifySettlement({ organizationId: ORG, executionId });
    assert.equal(first.outcome === 'settled' && second.outcome === 'settled', true);
    if (first.outcome !== 'settled' || second.outcome !== 'settled') return;
    assert.equal(second.established, 'previously');
    assert.equal(second.settlement.settlementDigest, first.settlement.settlementDigest);
    assert.deepEqual(second.receipt, first.receipt, 'R3: the same logical receipt');
    assert.equal(harness.authority.queries.length, 1, 'a settled payment is never re-asked');
  });

  it('S15: conflicting final evidence for the same execution fails closed — the first truth stands, no second record', async () => {
    const dir = scratch.dir();
    const { world, executionId } = await executedPayment();
    const path = join(dir, 'settlements.sqlite');
    const storeA = await createSqlitePaymentSettlementStore(path, { now: () => NOW });
    const storeB = await createSqlitePaymentSettlementStore(path, { now: () => NOW });
    let release: () => void = () => {};
    const gate = new Promise<void>((resolveGate) => (release = resolveGate));
    let waiting = 0;
    const held = (facts: readonly { name: string; value: string }[]) =>
      finalityAuthority(async (query) => {
        waiting += 1;
        if (waiting === 2) release();
        await gate;
        return { outcome: 'final', evidence: exactEvidence(query, { facts }) };
      });
    const a = settlementHarness(world, { store: storeA, authority: held([{ name: 'test.block-height', value: '42' }]) });
    const b = settlementHarness(world, { store: storeB, authority: held([{ name: 'test.block-height', value: '43' }]) });
    const [left, right] = await Promise.all([a.service.verifySettlement({ organizationId: ORG, executionId }), b.service.verifySettlement({ organizationId: ORG, executionId })]);
    const outcomes = [left.outcome, right.outcome].sort();
    assert.deepEqual(outcomes, ['conflict', 'settled']);
    const winner = (left.outcome === 'settled' ? left : right) as Extract<typeof left, { outcome: 'settled' }>;
    assert.deepEqual(await storeA.read({ organizationId: ORG }, executionId), winner.settlement, 'one canonical fact; never latest-wins');
    await storeA.close();
    await storeB.close();
  });

  it('S16: two workers verifying the same execution concurrently converge on ONE settlement and ONE receipt', async () => {
    const dir = scratch.dir();
    const { world, executionId } = await executedPayment();
    const path = join(dir, 'settlements.sqlite');
    const stores = await Promise.all([createSqlitePaymentSettlementStore(path, { now: () => NOW }), createSqlitePaymentSettlementStore(path, { now: () => NOW })]);
    const harnesses = stores.map((store) => settlementHarness(world, { store }));
    const results = await Promise.all(harnesses.map((harness) => harness.service.verifySettlement({ organizationId: ORG, executionId })));
    assert.equal(results.every((result) => result.outcome === 'settled'), true, JSON.stringify(results));
    const settled = results as Extract<(typeof results)[number], { outcome: 'settled' }>[];
    assert.equal(new Set(settled.map((result) => result.settlement.settlementDigest)).size, 1);
    assert.equal(new Set(settled.map((result) => result.receipt.receiptDigest)).size, 1);
    const db = new Database(path, { readonly: true });
    const rows = db.prepare('SELECT COUNT(*) AS n FROM payment_settlements').get() as { n: number };
    db.close();
    assert.equal(rows.n, 1);
    for (const store of stores) await store.close();
  });

  it('S16b: in one process, concurrent verifications share one in-flight query', async () => {
    const { world, executionId } = await executedPayment();
    const harness = settlementHarness(world);
    const results = await Promise.all([1, 2, 3].map(() => harness.service.verifySettlement({ organizationId: ORG, executionId })));
    assert.equal(results.every((result) => result.outcome === 'settled'), true);
    assert.equal(harness.authority.queries.length, 1);
  });

  it('S17 / R10: across a restart the same settlement and the same receipt are read back — no authority, no rail', async () => {
    const dir = scratch.dir();
    const paths = { governance: join(dir, 'governance.sqlite'), outcomes: join(dir, 'outcomes.sqlite'), settlements: join(dir, 'settlements.sqlite') };
    const governance = await createSqliteGovernanceStore(paths.governance);
    const outcomes = await createSqliteExecutionOutcomeStore(paths.outcomes, { now: () => NOW });
    const { world, rail, executionId } = await executedPayment({ store: governance, executionOutcomes: outcomes });
    const store = await createSqlitePaymentSettlementStore(paths.settlements, { now: () => NOW });
    const first = await settlementHarness(world, { store }).service.verifySettlement({ organizationId: ORG, executionId });
    assert.equal(first.outcome, 'settled');
    await store.close();

    const reopened = await createSqlitePaymentSettlementStore(paths.settlements, { now: () => NOW });
    const harness = settlementHarness(world, { store: reopened });
    const read = await harness.service.readSettlement({ organizationId: ORG, executionId });
    assert.equal(read.outcome === 'status' && read.state, 'settled');
    const receipt = await harness.service.receipt({ organizationId: ORG, executionId });
    assert.deepEqual(receipt, first.outcome === 'settled' ? first.receipt : undefined);
    const again = await harness.service.verifySettlement({ organizationId: ORG, executionId });
    assert.equal(again.outcome === 'settled' && again.established, 'previously');
    assert.equal(harness.authority.queries.length, 0, 'a restart re-asks nobody');
    assert.equal(rail.callCount, 1);
    await reopened.close();
    await outcomes.close();
    await governance.close();
  });
});

describe('PAY-05 S18 — a stale or lost settlement store never fakes eligibility', () => {
  it('S18: a rolled-back settlement store reads NOT settled (never settled-by-default), and re-verification re-derives the byte-identical receipt', async () => {
    const dir = scratch.dir();
    const path = join(dir, 'settlements.sqlite');
    const backup = join(dir, 'settlements.backup.sqlite');
    const { world, executionId } = await executedPayment();
    const store = await createSqlitePaymentSettlementStore(path, { now: () => NOW });
    await store.close();
    copyFileSync(path, backup);
    const live = await createSqlitePaymentSettlementStore(path, { now: () => NOW });
    const first = await settlementHarness(world, { store: live }).service.verifySettlement({ organizationId: ORG, executionId });
    assert.equal(first.outcome, 'settled');
    await live.close();

    // Stale restore: the file from before the settlement.
    copyFileSync(backup, path);
    for (const suffix of ['-wal', '-shm']) if (existsSync(`${path}${suffix}`)) rmSync(`${path}${suffix}`);
    const restored = await createSqlitePaymentSettlementStore(path, { now: () => '2026-01-01T09:00:00.000Z' });
    const harness = settlementHarness(world, { store: restored, now: () => '2026-01-01T09:00:00.000Z' });
    assert.deepEqual(await harness.service.readSettlement({ organizationId: ORG, executionId }), { outcome: 'status', state: 'awaiting-finality' }, 'availability lost, never a false settled');
    assert.equal(await harness.service.receipt({ organizationId: ORG, executionId }), undefined);
    const again = await harness.service.verifySettlement({ organizationId: ORG, executionId });
    assert.equal(again.outcome, 'settled');
    if (first.outcome === 'settled' && again.outcome === 'settled') {
      assert.notEqual(again.settlement.verifiedAt, first.settlement.verifiedAt, 'a later, local instant');
      assert.equal(again.settlement.contentDigest, first.settlement.contentDigest, 'the same final transfer');
      assert.deepEqual(again.receipt, first.receipt, 'the receipt carries no local instant: byte-identical after the restore');
    }
    await restored.close();
  });

  it('S18b: a settlement row that no longer matches the canonical P11 basis is never believed (settlement-inconsistent)', async () => {
    const other = await executedPayment();
    const settledWorld = await executedPayment();
    const harness = settlementHarness(settledWorld.world);
    const settled = await harness.service.verifySettlement({ organizationId: ORG, executionId: settledWorld.executionId });
    assert.equal(settled.outcome, 'settled');
    // The same settlement row under a P11 that never saw that execution (a row written by anything but this service, or a
    // settlement store restored beside another spine): it cannot be believed — no settled state, no receipt.
    const foreign = settlementHarness(other.world, { store: harness.store });
    assert.deepEqual(await foreign.service.readSettlement({ organizationId: ORG, executionId: settledWorld.executionId }), { outcome: 'basis-unavailable', reason: 'settlement-inconsistent' });
    assert.equal(await foreign.service.receipt({ organizationId: ORG, executionId: settledWorld.executionId }), undefined);
  });

  it('S18c: a tampered settlement row is corrupt — refused, never repaired, never a receipt', async () => {
    const dir = scratch.dir();
    const path = join(dir, 'settlements.sqlite');
    const { world, executionId } = await executedPayment();
    const store = await createSqlitePaymentSettlementStore(path, { now: () => NOW });
    const settled = await settlementHarness(world, { store }).service.verifySettlement({ organizationId: ORG, executionId });
    assert.equal(settled.outcome, 'settled');
    await store.close();
    const db = new Database(path);
    db.exec('DROP TRIGGER payment_settlements_append_only_update');
    const row = db.prepare('SELECT record_json FROM payment_settlements').get() as { record_json: string };
    db.prepare('UPDATE payment_settlements SET record_json = ?').run(row.record_json.replace('"value":"100"', '"value":"1000"'));
    db.close();
    const reopened = await createSqlitePaymentSettlementStore(path, { now: () => NOW });
    const harness = settlementHarness(world, { store: reopened });
    await assert.rejects(reopened.read({ organizationId: ORG }, executionId), (error) => isPaymentSettlementStoreError(error) && error.code === 'PAYMENT_SETTLEMENT_CORRUPT');
    assert.deepEqual(await harness.service.readSettlement({ organizationId: ORG, executionId }), { outcome: 'basis-unavailable', reason: 'settlement-corrupt' });
    assert.equal(await harness.service.receipt({ organizationId: ORG, executionId }), undefined);
    assert.deepEqual(await harness.service.verifySettlement({ organizationId: ORG, executionId }), { outcome: 'basis-unavailable', reason: 'settlement-corrupt' });
    assert.equal(harness.authority.queries.length, 0);
    await reopened.close();
  });

  it('the settlement store refuses UPDATE and DELETE and a file under another schema', async () => {
    const dir = scratch.dir();
    const path = join(dir, 'settlements.sqlite');
    const { world, executionId } = await executedPayment();
    const store = await createSqlitePaymentSettlementStore(path, { now: () => NOW });
    await settlementHarness(world, { store }).service.verifySettlement({ organizationId: ORG, executionId });
    await store.close();
    const db = new Database(path);
    assert.throws(() => db.prepare('DELETE FROM payment_settlements').run(), /immutable/);
    assert.throws(() => db.prepare("UPDATE payment_settlements SET recorded_at = 'x'").run(), /immutable/);
    db.prepare("INSERT INTO payment_settlement_store_versions (schema_version, migration_state, recorded_at) VALUES ('aoc.payment-settlement-store.schema.v9', 'current', 'x')").run();
    db.close();
    await assert.rejects(createSqlitePaymentSettlementStore(path, { now: () => NOW }), (error) => isPaymentSettlementStoreError(error) && error.code === 'PAYMENT_SETTLEMENT_STORE_UNAVAILABLE');
  });

  it('tenant confinement: another organization reads nothing and learns nothing', async () => {
    const { world, executionId } = await executedPayment();
    const harness = settlementHarness(world);
    await harness.service.verifySettlement({ organizationId: ORG, executionId });
    assert.deepEqual(await harness.service.readSettlement({ organizationId: 'org-other', executionId }), { outcome: 'not-found' });
    assert.deepEqual(await harness.service.verifySettlement({ organizationId: 'org-other', executionId }), { outcome: 'not-found' });
    await assert.rejects(harness.store.read({ organizationId: 'org-other' }, executionId), (error) => isPaymentSettlementStoreError(error) && error.code === 'PAYMENT_SETTLEMENT_TENANT_VIOLATION');
  });

  it('a non-payment execution is never settled', async () => {
    const { world, executionId } = await executedPayment();
    const { createPaymentSettlementService } = await import('../payment-settlement/index.js');
    const service = createPaymentSettlementService({
      outcomes: world.outcomes,
      resolutions: settlementHarness(world).resolutions,
      governance: world.rawStore,
      payments: [{ action: 'some.other-payment-action' }],
      store: createInMemoryPaymentSettlementStore({ now: () => NOW }),
      authorities: [finalityAuthority()],
      selectAuthority: () => FINALITY_AUTHORITY_ID,
      now: () => NOW,
    });
    assert.deepEqual(await service.verifySettlement({ organizationId: ORG, executionId }), { outcome: 'not-a-payment' });
  });
});

describe('PAY-05 S19 / S20 — reads are local; settlement observes, never executes', () => {
  it('S19: readSettlement and receipt never contact the authority', async () => {
    const { world, executionId } = await executedPayment();
    const harness = settlementHarness(world);
    await harness.service.verifySettlement({ organizationId: ORG, executionId });
    const before = harness.authority.queries.length;
    for (let index = 0; index < 5; index += 1) {
      await harness.service.readSettlement({ organizationId: ORG, executionId });
      await harness.service.receipt({ organizationId: ORG, executionId });
    }
    assert.equal(harness.authority.queries.length, before);
  });

  it('S20: no verification outcome — final, not final, contradicted, unavailable — ever reaches the rail again', async () => {
    const { world, rail, executionId } = await executedPayment();
    for (const answer of [() => ({ outcome: 'not-final' }), () => ({ outcome: 'contradicted', reason: 'test.x' }), () => Promise.reject(new Error('down')), (query: PaymentFinalityQuery) => ({ outcome: 'final', evidence: exactEvidence(query) })]) {
      await settlementHarness(world, { authority: finalityAuthority(answer) }).service.verifySettlement({ organizationId: ORG, executionId });
    }
    assert.equal(rail.callCount, 1);
    const replay = await world.orchestrator.govern(IDENTITY, governed(payment({ idempotencyKey: 'pay-s20-other' })));
    assert.equal(replay.status, 'executed', 'an unrelated new payment still governs normally');
  });
});

describe('PAY-05 R1 – R10 — receipts', () => {
  async function settledReceipt(): Promise<{ readonly receipt: PaymentReceipt; readonly settlement: PaymentSettlementRecord }> {
    const { world, executionId } = await executedPayment();
    const settled = await settlementHarness(world).service.verifySettlement({ organizationId: ORG, executionId });
    assert.equal(settled.outcome, 'settled');
    if (settled.outcome !== 'settled') throw new Error('unreachable');
    return { receipt: settled.receipt, settlement: settled.settlement };
  }

  it('R2: a settled payment has a receipt that verifies against its settlement', async () => {
    const { receipt, settlement } = await settledReceipt();
    assert.equal(receipt.format, PAYMENT_RECEIPT_FORMAT);
    assert.equal(receipt.status, 'settled');
    assert.equal(receipt.settlementContentDigest, settlement.contentDigest);
    assert.deepEqual(verifyPaymentReceipt(receipt), { valid: true });
    assert.deepEqual(verifyPaymentReceipt(receipt, settlement), { valid: true });
    assert.deepEqual(derivePaymentReceipt(settlement), receipt, 'R3: deterministic');
  });

  for (const [label, mutate] of [
    ['R4 altered amount', (receipt: PaymentReceipt) => ({ ...receipt, payment: { ...receipt.payment, amount: { ...receipt.payment.amount, value: '1000' } } })],
    ['R5 altered asset', (receipt: PaymentReceipt) => ({ ...receipt, payment: { ...receipt.payment, amount: { ...receipt.payment.amount, unit: 'EUR' } } })],
    ['R6 altered execution id', (receipt: PaymentReceipt) => ({ ...receipt, executionId: 'exec-someone-else' })],
    ['R7 altered evidence digest', (receipt: PaymentReceipt) => ({ ...receipt, finality: { ...receipt.finality, proofDigest: `sha256:${'0'.repeat(64)}` } })],
    ['R7b altered provider reference', (receipt: PaymentReceipt) => ({ ...receipt, finality: { ...receipt.finality, providerRef: 'ref-other' } })],
    ['R7c altered destination', (receipt: PaymentReceipt) => ({ ...receipt, payment: { ...receipt.payment, destination: { kind: 'account', reference: 'attacker' } } })],
  ] as const) {
    it(`${label}: verification fails — alone (digest) and against the settlement`, async () => {
      const { receipt, settlement } = await settledReceipt();
      const altered = mutate(receipt) as PaymentReceipt;
      assert.equal(verifyPaymentReceipt(altered).valid, false);
      assert.equal(verifyPaymentReceipt(altered, settlement).valid, false);
    });
  }

  it('R7d: a receipt with a recomputed digest over altered content still fails against the canonical settlement', async () => {
    const { receipt, settlement } = await settledReceipt();
    const forgedSettlement = { ...settlement, payment: { ...settlement.payment, amount: { value: '1000', unit: 'USD' } } } as PaymentSettlementRecord;
    const forged = derivePaymentReceipt(forgedSettlement);
    assert.deepEqual(verifyPaymentReceipt(forged), { valid: true }, 'integrity alone: a self-consistent receipt');
    assert.deepEqual(verifyPaymentReceipt(forged, settlement), { valid: false, failure: 'settlement' }, 'correlation: not the receipt of the canonical settlement');
    void receipt;
  });

  it('R8: a receipt carries no secret, signer, credential, raw provider body or finality fact; disclosure tiers narrow it further', async () => {
    const { receipt } = await settledReceipt();
    const text = JSON.stringify(receipt);
    for (const forbidden of [/secret|seed|private|mnemonic|bearer|credential|password|signature|signer/i, /BEGIN /, /https?:\/\//, /test\.block-height/]) assert.equal(forbidden.test(text), false, String(forbidden));
    const auditor = disclosePaymentReceipt(receipt, 'auditor');
    const partner = disclosePaymentReceipt(receipt, 'partner');
    const customer = disclosePaymentReceipt(receipt, 'customer');
    const publicView = disclosePaymentReceipt(receipt, 'public');
    for (const view of [auditor, partner, customer, publicView]) assert.equal(JSON.stringify(view).includes('vendor-4471'), false, 'no tier discloses the destination');
    assert.equal('amount' in auditor, true);
    assert.equal('amount' in partner, false);
    assert.equal('providerRef' in partner, true);
    assert.equal('providerRef' in customer, false);
    assert.deepEqual(Object.keys(publicView).sort(), ['receiptId', 'status']);
  });

  it('R9: a receipt authorizes nothing — presented as a governed action it is refused before any decision', async () => {
    const { world, rail } = paymentWorld();
    const { receipt } = await settledReceipt();
    const result = await world.orchestrator.govern(IDENTITY, receipt as unknown);
    assert.equal(result.status, 'rejected');
    assert.equal(world.kernelRequests.length, 0);
    assert.equal(rail.callCount, 0);
  });

  it('R10: a backed-up and restored settlement file derives the identical receipt, which still verifies', async () => {
    const dir = scratch.dir();
    const path = join(dir, 'settlements.sqlite');
    const restoredPath = join(scratch.dir(), 'restored.sqlite');
    const { world, executionId } = await executedPayment();
    const store = await createSqlitePaymentSettlementStore(path, { now: () => NOW });
    const settled = await settlementHarness(world, { store }).service.verifySettlement({ organizationId: ORG, executionId });
    assert.equal(settled.outcome, 'settled');
    await store.close();
    copyFileSync(path, restoredPath);
    const restored = await createSqlitePaymentSettlementStore(restoredPath, { now: () => NOW });
    const record = await restored.read({ organizationId: ORG }, executionId);
    assert.ok(record !== undefined);
    const receipt = derivePaymentReceipt(record);
    assert.deepEqual(receipt, settled.outcome === 'settled' ? settled.receipt : undefined);
    assert.deepEqual(verifyPaymentReceipt(receipt, record), { valid: true });
    await restored.close();
  });
});
