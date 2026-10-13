import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { PaymentExecutionRequest } from '../../features/payment-runtime/index.js';
import { closeAllWitnesses, startWitness, witnessRows, type StartedWitness } from './core07-freshness-fixture.js';
import { GOVERNED_ACCOUNT, type OpenedPaymentRailEdge, type PaymentRailEdge } from './pay07-governed-payment-world.js';
import { LIGHTNING_EDGE } from './pay07-lightning-edge.js';
import { STRIPE_EDGE } from './pay07-stripe-edge.js';
import { XRPL_EDGE } from './pay07-xrpl-edge.js';

/**
 * PAY-07 — the multi-rail COEXISTENCE extension (PAY-09 multi-rail hardening).
 *
 * The canonical suite (`pay07-multi-rail-qualification.test.ts`) proves each
 * rail is semantically interchangeable — but every run there composes ONE rail
 * in its own world, behind its own witness. That cannot show that the rails
 * COMPOSE: before this hardening the Lightning and Stripe interlocks shared one
 * CORE-07 slot `(payment-initiation-reservations, organization)`, so the
 * second rail of an organization was refused at genesis while every per-rail
 * run stayed green.
 *
 * This extension leaves the canonical suite untouched and adds the missing
 * claim: the SAME CORE, ONE organization, ONE CORE-07 witness, ONE state
 * directory, and every qualified rail edge composed side by side — each with
 * its own external effects and its own freshness state, opened, executed,
 * restarted and rolled back in either order, none taking or disturbing
 * another's slot. Only generic edge capabilities are used: the extension never
 * names a rail concept.
 */

const ORG = 'org-pay07-coexistence';
const made: string[] = [];
after(async () => {
  await closeAllWitnesses();
  for (const directory of made) rmSync(directory, { recursive: true, force: true });
});

interface Composed {
  readonly witness: StartedWitness;
  readonly opened: Map<PaymentRailEdge, OpenedPaymentRailEdge>;
}

/** One directory, one witness, one organization; the edges opened in exactly the order given. */
async function compose(order: readonly PaymentRailEdge[]): Promise<Composed> {
  const directory = mkdtempSync(join(tmpdir(), 'frontera-pay07-coexistence-'));
  made.push(directory);
  const witness = await startWitness();
  const opened = new Map<PaymentRailEdge, OpenedPaymentRailEdge>();
  try {
    for (const edge of order) opened.set(edge, await edge.open({ directory, witness, organizationId: ORG, accountId: GOVERNED_ACCOUNT }));
  } catch (error) {
    // A rail refused to open: release the ones already open (an edge may hold a signer process), then report the refusal.
    for (const edge of opened.values()) await edge.close().catch(() => undefined);
    throw error;
  }
  return { witness, opened };
}

async function closeAll(composed: Composed): Promise<void> {
  for (const edge of composed.opened.values()) await edge.close();
}

let sequence = 0;
/** One governed payment instruction for `edge`, within its ceiling, to the payee its trusted directory prepares. */
async function execute(edge: PaymentRailEdge, opened: OpenedPaymentRailEdge): Promise<{ readonly status: string; readonly executionId: string }> {
  sequence += 1;
  const executionId = `exec-coexistence-${edge.railId}-${sequence}`;
  const payee = await opened.preparePayee(edge.economics.withinCeiling, `coexistence-${sequence}`);
  opened.behave('complete');
  const request: PaymentExecutionRequest = {
    executionId,
    requestId: `req-${executionId}`,
    decisionId: `dec-${executionId}`,
    grantId: `grant-${executionId}`,
    notAfter: '2026-09-24T12:30:00.000Z',
    source: { accountId: GOVERNED_ACCOUNT },
    destination: payee.destination,
    amount: { value: edge.economics.withinCeiling.value, unit: edge.economics.withinCeiling.unit },
    purpose: 'purchase',
  };
  const result = await opened.rail.execute(request);
  return { status: result.status, executionId };
}

/** The witnessed slots, as `kind|organization|namespace|store-family → committed sequence`. */
async function slots(witness: StartedWitness): Promise<Record<string, number>> {
  const rows = await witnessRows(witness.databasePath);
  return Object.fromEntries(rows.map((row) => [`${String(row['state_kind'])}|${String(row['organization_id'])}|${String(row['namespace'])}|${String(row['store_id']).split(':')[0]}`, Number(row['committed_sequence'])]));
}

const EDGES = [XRPL_EDGE, LIGHTNING_EDGE, STRIPE_EDGE] as const;

describe('PAY-07 coexistence — every qualified rail, one organization, one witness (COEX-1 … COEX-4)', () => {
  it('COEX-1 Lightning then Stripe (then XRPL): every rail opens and stays healthy; one witnessed slot each', async () => {
    // The literal rail ids this file's titles name.
    assert.deepEqual([XRPL_EDGE.railId, LIGHTNING_EDGE.railId, STRIPE_EDGE.railId], ['xrpl-rlusd', 'lightning-btc', 'stripe-usd']);
    const composed = await compose([LIGHTNING_EDGE, STRIPE_EDGE, XRPL_EDGE]);
    assert.deepEqual(Object.keys(await slots(composed.witness)).sort(), [
      `payment-initiation-reservations|${ORG}|${LIGHTNING_EDGE.railId}|lightning-payment-interlock`,
      `payment-initiation-reservations|${ORG}|${STRIPE_EDGE.railId}|stripe-payment-interlock`,
      `xrpl-submission-reservations|${ORG}||xrpl-submission-interlock`,
    ]);
    await closeAll(composed);
  });

  it('COEX-2 Stripe then Lightning (then XRPL): the same three slots — the order of opening never matters', async () => {
    const composed = await compose([STRIPE_EDGE, LIGHTNING_EDGE, XRPL_EDGE]);
    assert.equal(Object.keys(await slots(composed.witness)).length, 3);
    await closeAll(composed);
  });

  it('COEX-3 independent executions — Lightning, then Stripe, then XRPL — each completes under its own simulator with exactly its own one effect', async () => {
    const composed = await compose(EDGES);
    for (const edge of [LIGHTNING_EDGE, STRIPE_EDGE, XRPL_EDGE]) {
      const before = EDGES.map((candidate) => composed.opened.get(candidate)!.effects());
      assert.equal((await execute(edge, composed.opened.get(edge)!)).status, 'completed', edge.railId);
      const delta = EDGES.map((candidate, index) => composed.opened.get(candidate)!.effects() - before[index]!);
      assert.deepEqual(delta, EDGES.map((candidate) => (candidate === edge ? 1 : 0)), `${edge.railId}: one effect, on its own provider only`);
    }
    await closeAll(composed);
  });

  it('COEX-4 the reverse execution order — Stripe, then Lightning — both complete; each history advanced only its own slot', async () => {
    const composed = await compose([LIGHTNING_EDGE, STRIPE_EDGE]);
    const initial = await slots(composed.witness);
    assert.equal((await execute(STRIPE_EDGE, composed.opened.get(STRIPE_EDGE)!)).status, 'completed');
    const afterStripe = await slots(composed.witness);
    const lightningSlot = `payment-initiation-reservations|${ORG}|${LIGHTNING_EDGE.railId}|lightning-payment-interlock`;
    const stripeSlot = `payment-initiation-reservations|${ORG}|${STRIPE_EDGE.railId}|stripe-payment-interlock`;
    assert.equal(afterStripe[lightningSlot], initial[lightningSlot], 'Stripe never moved the Lightning slot');
    assert.ok(afterStripe[stripeSlot]! > initial[stripeSlot]!, 'Stripe advanced its own slot');
    assert.equal((await execute(LIGHTNING_EDGE, composed.opened.get(LIGHTNING_EDGE)!)).status, 'completed');
    const afterLightning = await slots(composed.witness);
    assert.equal(afterLightning[stripeSlot], afterStripe[stripeSlot], 'Lightning never moved the Stripe slot');
    assert.ok(afterLightning[lightningSlot]! > afterStripe[lightningSlot]!);
    assert.deepEqual([composed.opened.get(LIGHTNING_EDGE)!.effects(), composed.opened.get(STRIPE_EDGE)!.effects()], [1, 1]);
    await closeAll(composed);
  });
});

describe('PAY-07 coexistence — rollback and restart isolation (COEX-7, COEX-8, COEX-15, COEX-16)', () => {
  for (const [title, stale, survivor] of [
    ['COEX-7 a stale restore of the stripe-usd interlock is refused as a rollback; the lightning-btc rail of the same organization stays open, executes, and its witnessed slot is untouched', STRIPE_EDGE, LIGHTNING_EDGE],
    ['COEX-8 a stale restore of the lightning-btc interlock is refused as a rollback; the stripe-usd rail of the same organization stays open, executes, and its witnessed slot is untouched', LIGHTNING_EDGE, STRIPE_EDGE],
  ] as const) {
    it(title, async () => {
      const composed = await compose([LIGHTNING_EDGE, STRIPE_EDGE]);
      assert.equal((await execute(stale, composed.opened.get(stale)!)).status, 'completed', 'S1: the stale rail advanced past its backup');
      assert.equal((await execute(survivor, composed.opened.get(survivor)!)).status, 'completed');
      const before = await slots(composed.witness);
      const rollback = await composed.opened.get(stale)!.rollback();
      assert.deepEqual(rollback, { refused: true, code: 'AUTHORITY_FRESHNESS_ROLLBACK_DETECTED' });
      assert.deepEqual(await slots(composed.witness), before, 'the refused rollback changed no witnessed slot');
      assert.equal((await execute(survivor, composed.opened.get(survivor)!)).status, 'completed', 'the other rail keeps working');
      await composed.opened.get(survivor)!.restart();
      assert.equal((await execute(survivor, composed.opened.get(survivor)!)).status, 'completed', 'and restarts cleanly');
      await closeAll(composed);
    });
  }

  for (const [title, first, second] of [
    ['COEX-15 both rails hold durable state; both restart — lightning-btc first, then stripe-usd — and establish against their own slots', LIGHTNING_EDGE, STRIPE_EDGE],
    ['COEX-16 both rails hold durable state; both restart — stripe-usd first, then lightning-btc — and establish against their own slots', STRIPE_EDGE, LIGHTNING_EDGE],
  ] as const) {
    it(title, async () => {
      const composed = await compose([LIGHTNING_EDGE, STRIPE_EDGE]);
      for (const edge of [LIGHTNING_EDGE, STRIPE_EDGE]) assert.equal((await execute(edge, composed.opened.get(edge)!)).status, 'completed');
      const before = await slots(composed.witness);
      await composed.opened.get(first)!.restart();
      await composed.opened.get(second)!.restart();
      assert.deepEqual(await slots(composed.witness), before, 'a restart re-establishes; it never re-enrolls or moves a slot');
      for (const edge of [second, first]) assert.equal((await execute(edge, composed.opened.get(edge)!)).status, 'completed', `${edge.railId} after the restart`);
      await closeAll(composed);
    });
  }
});
