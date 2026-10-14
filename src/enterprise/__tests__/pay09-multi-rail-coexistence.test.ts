import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';

import type { PaymentExecutionRequest } from '../../features/payment-runtime/index.js';
import { testRailConfiguration as lightningConfiguration } from '../../features/payment-runtime/rails/lightning/tests/lightning-test-fixtures.js';
import { testRailConfiguration as stripeConfiguration } from '../../features/payment-runtime/rails/stripe/tests/stripe-test-fixtures.js';
import { canonicalSerialize } from '../governance-store/canonical-json.js';
import { computeDigest } from '../governance-store/digest.js';
import { createSqliteLightningPaymentInterlock } from '../lightning-payment-rail/sqlite-lightning-payment-interlock.js';
import { createSqliteStripePaymentInterlock } from '../stripe-payment-rail/sqlite-stripe-payment-interlock.js';
import { boundaryFor, closeAllWitnesses, connect, startWitness, witnessRows, type StartedWitness } from './core07-freshness-fixture.js';
import { GOVERNED_ACCOUNT, type OpenedPaymentRailEdge, type PaymentRailEdge } from './pay07-governed-payment-world.js';
import { LIGHTNING_EDGE } from './pay07-lightning-edge.js';
import { STRIPE_EDGE } from './pay07-stripe-edge.js';

/**
 * PAY-09 multi-rail hardening — Lightning and Stripe interlocks of ONE
 * organization, anchored at ONE CORE-07 witness, each in its own namespaced
 * slot of `payment-initiation-reservations`.
 *
 * Every failure here is driven into ONE rail; the assertion is always about
 * BOTH: the failing rail refuses exactly as PAY-06 / PAY-09 always did, and
 * the other rail's witnessed binding is byte-identical and it keeps executing.
 *
 * Each rail reaches the witness through its own loopback relay, so a test can
 * take one rail's witness path down (or restart the witness behind both)
 * without the rail edges knowing.
 */

const ORG = 'org-pay09-coexistence';
const LIGHTNING_RAIL = LIGHTNING_EDGE.railId;
const STRIPE_RAIL = STRIPE_EDGE.railId;
const made: string[] = [];
const relays: Relay[] = [];
after(async () => {
  for (const relay of relays.splice(0)) await relay.close();
  await closeAllWitnesses();
  for (const directory of made) rmSync(directory, { recursive: true, force: true });
});

/** A loopback relay in front of the witness: `forward`, or `down` (HTTP 503 — the witness unreachable). */
interface Relay {
  readonly endpoint: string;
  mode: 'forward' | 'down';
  target: StartedWitness;
  close(): Promise<void>;
}

async function relayTo(target: StartedWitness): Promise<Relay> {
  const relay = { mode: 'forward', target } as Relay;
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      if (relay.mode === 'down') {
        res.writeHead(503).end();
        return;
      }
      const upstream = new URL(relay.target.endpoint);
      const out = httpRequest({ host: upstream.hostname, port: upstream.port, path: req.url, method: req.method, headers: req.headers, agent: false }, (answer) => {
        res.writeHead(answer.statusCode ?? 502, answer.headers);
        answer.pipe(res);
      });
      out.on('error', () => res.writeHead(503).end());
      out.end(Buffer.concat(chunks));
    });
  });
  server.unref();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  Object.assign(relay, {
    endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  });
  relays.push(relay);
  return relay;
}

/** The witness as one rail sees it: the real witness's identity, reached through that rail's relay. */
const through = (relay: Relay): StartedWitness => ({ ...relay.target, endpoint: relay.endpoint }) as StartedWitness;

interface World {
  readonly directory: string;
  witness: StartedWitness;
  readonly relays: Record<'lightning' | 'stripe', Relay>;
  readonly edges: Record<'lightning' | 'stripe', OpenedPaymentRailEdge>;
}

async function world(order: readonly ('lightning' | 'stripe')[] = ['lightning', 'stripe']): Promise<World> {
  const directory = mkdtempSync(join(tmpdir(), 'frontera-pay09-coexistence-'));
  made.push(directory);
  const witness = await startWitness();
  const relayed = { lightning: await relayTo(witness), stripe: await relayTo(witness) };
  const edges = {} as Record<'lightning' | 'stripe', OpenedPaymentRailEdge>;
  try {
    for (const name of order) {
      const edge: PaymentRailEdge = name === 'lightning' ? LIGHTNING_EDGE : STRIPE_EDGE;
      edges[name] = await edge.open({ directory, witness: through(relayed[name]), organizationId: ORG, accountId: GOVERNED_ACCOUNT });
    }
  } catch (error) {
    for (const edge of Object.values(edges)) await edge.close().catch(() => undefined);
    throw error;
  }
  return { directory, witness, relays: relayed, edges };
}

let counter = 0;
async function pay(name: 'lightning' | 'stripe', w: World): Promise<string> {
  counter += 1;
  const edge = name === 'lightning' ? LIGHTNING_EDGE : STRIPE_EDGE;
  const opened = w.edges[name];
  const executionId = `exec-pay09-coex-${name}-${counter}`;
  const payee = await opened.preparePayee(edge.economics.withinCeiling, `pay09-coex-${counter}`);
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
  return (await opened.rail.execute(request)).status;
}

/** One rail's witnessed slot, exactly as the witness stores it. */
async function slotOf(w: World, railId: string): Promise<Record<string, unknown>> {
  const row = (await witnessRows(w.witness.databasePath)).find((entry) => entry['state_kind'] === 'payment-initiation-reservations' && entry['organization_id'] === ORG && entry['namespace'] === railId);
  assert.ok(row !== undefined, `no witnessed slot for ${railId}`);
  return row;
}

const PATHS = { lightning: 'lightning-payment-interlock.sqlite', stripe: 'stripe-payment-interlock.sqlite' } as const;
const STRIPE = stripeConfiguration();
const LIGHTNING = lightningConfiguration();
const now = (): string => new Date().toISOString();

/** Opens one rail's interlock file directly (as a restarting Host would), against the witness behind `relay`. */
async function openDirect(name: 'lightning' | 'stripe', w: World, relay: Relay = w.relays[name]): Promise<{ close(): Promise<void> }> {
  const boundary = await boundaryFor(through(relay), ORG);
  const path = join(w.directory, PATHS[name]);
  return name === 'lightning'
    ? createSqliteLightningPaymentInterlock(path, { scope: { railId: LIGHTNING.railId, network: LIGHTNING.network }, now, freshness: { boundary } })
    : createSqliteStripePaymentInterlock(path, { scope: { railId: STRIPE.railId, mode: STRIPE.mode, platformAccountId: STRIPE.platformAccountId }, now, freshness: { boundary } });
}

const failsWith = (code: string) => (error: { code?: string }) => error.code === code;

/**
 * A perfect local forgery of the LAST entry of one rail's history: content
 * changed (its instant), entry digest and chain recomputed — locally consistent,
 * so integrity checks pass and only the witness can tell. The rails' own,
 * public digest rules, restated (the PAY-06 PAYER-10 technique).
 */
function forgeLastEntry(name: 'lightning' | 'stripe', w: World): void {
  const path = join(w.directory, PATHS[name]);
  const table = name === 'lightning' ? 'lightning_payment_reservations' : 'stripe_payment_entries';
  const trigger = name === 'lightning' ? 'lightning_reservations_append_only_update' : 'stripe_entries_append_only_update';
  const instant = name === 'lightning' ? 'reservedAt' : 'recordedAt';
  const chainDomain = name === 'lightning' ? 'aoc.lightning-payment-interlock.chain.v1' : 'aoc.stripe-payment-interlock.chain.v1';
  const entryDomain = (content: Record<string, unknown>): string =>
    name === 'lightning' ? 'aoc.lightning-payment-interlock.entry.v2' : content['kind'] === 'reservation' ? 'aoc.stripe-payment-interlock.reservation.v1' : 'aoc.stripe-payment-interlock.binding.v1';
  const raw = new Database(path);
  try {
    raw.exec(`DROP TRIGGER IF EXISTS ${trigger}`);
    const rows = raw.prepare(`SELECT sequence, entry_json, chain_digest FROM ${table} ORDER BY sequence`).all() as { sequence: number; entry_json: string; chain_digest: string }[];
    assert.ok(rows.length >= 2, 'the forgery needs a previous entry to chain from');
    const last = rows[rows.length - 1]!;
    const previous = rows[rows.length - 2]!;
    const original = JSON.parse(last.entry_json) as Record<string, unknown>;
    assert.equal(computeDigest({ domain: chainDomain, previous: previous.chain_digest, entryDigest: computeDigest({ domain: entryDomain(original), ...original }) }), last.chain_digest, 'the restated digest rules match the interlock');
    const forged = { ...original, [instant]: '2026-01-01T00:00:00.000Z' };
    const entryDigest = computeDigest({ domain: entryDomain(forged), ...forged });
    raw.prepare(`UPDATE ${table} SET entry_json = ?, entry_digest = ?, chain_digest = ? WHERE sequence = ?`).run(canonicalSerialize(forged), entryDigest, computeDigest({ domain: chainDomain, previous: previous.chain_digest, entryDigest }), last.sequence);
  } finally {
    raw.close();
  }
}

describe('PAY-09 coexistence — state isolation (COEX-5, COEX-6)', () => {
  for (const [title, moving, still] of [
    ['COEX-5 advancing the stripe interlock leaves the lightning freshness checkpoint byte-identical and valid', 'stripe', 'lightning'],
    ['COEX-6 advancing the lightning interlock leaves the stripe freshness checkpoint byte-identical and valid', 'lightning', 'stripe'],
  ] as const) {
    it(title, async () => {
      const w = await world();
      assert.equal(await pay(still, w), 'completed');
      const before = await slotOf(w, still === 'lightning' ? LIGHTNING_RAIL : STRIPE_RAIL);
      for (let i = 0; i < 3; i += 1) assert.equal(await pay(moving, w), 'completed');
      assert.deepEqual(await slotOf(w, still === 'lightning' ? LIGHTNING_RAIL : STRIPE_RAIL), before, `${still}: store, committed head and (absent) pending unchanged`);
      await w.edges[still].restart();
      assert.equal(await pay(still, w), 'completed', `${still} re-establishes on its unchanged checkpoint`);
      for (const edge of Object.values(w.edges)) await edge.close();
    });
  }
});

describe('PAY-09 coexistence — fork isolation (COEX-9, COEX-10)', () => {
  for (const [title, forked, survivor] of [
    ['COEX-9 a same-sequence digest fork in the stripe slot is refused; lightning stays valid, restarts and executes', 'stripe', 'lightning'],
    ['COEX-10 a same-sequence digest fork in the lightning slot is refused; stripe stays valid, restarts and executes', 'lightning', 'stripe'],
  ] as const) {
    it(title, async () => {
      const w = await world();
      for (let i = 0; i < 2; i += 1) assert.equal(await pay(forked, w), 'completed');
      assert.equal(await pay(survivor, w), 'completed');
      const survivorSlot = await slotOf(w, survivor === 'lightning' ? LIGHTNING_RAIL : STRIPE_RAIL);
      await w.edges[forked].close();
      forgeLastEntry(forked, w);
      await assert.rejects(openDirect(forked, w), failsWith('AUTHORITY_FRESHNESS_FORK_DETECTED'));
      assert.deepEqual(await slotOf(w, survivor === 'lightning' ? LIGHTNING_RAIL : STRIPE_RAIL), survivorSlot);
      await w.edges[survivor].restart();
      assert.equal(await pay(survivor, w), 'completed');
      await w.edges[survivor].close();
    });
  }
});

describe('PAY-09 coexistence — store substitution across namespaces (COEX-11, COEX-12)', () => {
  for (const [title, from, into] of [
    ['COEX-11 the stripe store presented in the lightning namespace — as a checkpoint, as a configured rail id, or as the file itself — is refused; the lightning slot is untouched', 'stripe', 'lightning'],
    ['COEX-12 the lightning store presented in the stripe namespace — as a checkpoint, as a configured rail id, or as the file itself — is refused; the stripe slot is untouched', 'lightning', 'stripe'],
  ] as const) {
    it(title, async () => {
      const w = await world();
      assert.equal(await pay(from, w), 'completed');
      assert.equal(await pay(into, w), 'completed');
      const fromRail = from === 'lightning' ? LIGHTNING_RAIL : STRIPE_RAIL;
      const intoRail = into === 'lightning' ? LIGHTNING_RAIL : STRIPE_RAIL;
      const fromSlot = await slotOf(w, fromRail);
      const intoSlot = await slotOf(w, intoRail);
      // (a) The checkpoint: the from-store's exact witnessed head, relabelled into the other namespace.
      const { anchor, monitor } = await connect(w.witness);
      const { createAuthorityStateFreshnessBoundary } = await import('../authority-state-freshness/index.js');
      const boundary = createAuthorityStateFreshnessBoundary({ anchor, monitor, organizationId: ORG });
      const relabelled = { stateKind: 'payment-initiation-reservations' as const, organizationId: ORG, namespace: intoRail, storeId: String(fromSlot['store_id']), sequence: Number(fromSlot['committed_sequence']), stateDigest: String(fromSlot['committed_digest']) };
      await assert.rejects(() => boundary.establish(relabelled, () => relabelled), failsWith('AUTHORITY_FRESHNESS_BINDING_MISMATCH'));
      assert.equal((await anchor.prepare(relabelled, { ...relabelled, sequence: relabelled.sequence + 1 })).outcome, 'conflict');
      // (b) A fresh from-rail interlock misconfigured with the other rail's id: its genesis meets an occupied slot.
      const misconfigured = join(w.directory, `misconfigured-${from}.sqlite`);
      const misBoundary = await boundaryFor(w.witness, ORG);
      await assert.rejects(
        from === 'stripe'
          ? createSqliteStripePaymentInterlock(misconfigured, { scope: { railId: intoRail, mode: STRIPE.mode, platformAccountId: STRIPE.platformAccountId }, now, freshness: { boundary: misBoundary } })
          : createSqliteLightningPaymentInterlock(misconfigured, { scope: { railId: intoRail, network: LIGHTNING.network }, now, freshness: { boundary: misBoundary } }),
        (error: { code?: string }) => typeof error.code === 'string' && error.code.startsWith('AUTHORITY_FRESHNESS_'),
      );
      // (c) The from-rail file copied over the other rail's file.
      for (const edge of Object.values(w.edges)) await edge.close();
      copyFileSync(join(w.directory, PATHS[from]), join(w.directory, PATHS[into]));
      for (const suffix of ['-wal', '-shm']) rmSync(join(w.directory, `${PATHS[into]}${suffix}`), { force: true });
      await assert.rejects(openDirect(into, w));
      assert.deepEqual(await slotOf(w, intoRail), intoSlot, 'no substitution attempt moved the target slot');
      assert.deepEqual(await slotOf(w, fromRail), fromSlot, 'nor the source slot');
    });
  }
});

describe('PAY-09 coexistence — witness outage and pending transitions (COEX-13, COEX-14, pending isolation)', () => {
  it('COEX-13 the witness unreachable while BOTH existing stores open: each is refused (no permissive fallback); with the witness back, both establish', async () => {
    const w = await world();
    for (const name of ['lightning', 'stripe'] as const) assert.equal(await pay(name, w), 'completed');
    for (const edge of Object.values(w.edges)) await edge.close();
    for (const relay of Object.values(w.relays)) relay.mode = 'down';
    await assert.rejects(openDirect('lightning', w), failsWith('AUTHORITY_FRESHNESS_UNAVAILABLE'));
    await assert.rejects(openDirect('stripe', w), failsWith('AUTHORITY_FRESHNESS_UNAVAILABLE'));
    // The same witness, restarted (same key, same database), behind both relays.
    w.witness = await w.witness.restart();
    for (const relay of Object.values(w.relays)) {
      relay.target = w.witness;
      relay.mode = 'forward';
    }
    for (const name of ['lightning', 'stripe'] as const) await (await openDirect(name, w)).close();
  });

  for (const [title, failing, healthy] of [
    ["COEX-14 the witness lost on the stripe path during a payment: stripe fails closed before any effect; lightning's binding is intact and it keeps executing", 'stripe', 'lightning'],
    ["COEX-14 (reverse) the witness lost on the lightning path during a payment: lightning fails closed before any effect; stripe's binding is intact and it keeps executing", 'lightning', 'stripe'],
  ] as const) {
    it(title, async () => {
      const w = await world();
      assert.equal(await pay(failing, w), 'completed');
      const failingSlot = await slotOf(w, failing === 'lightning' ? LIGHTNING_RAIL : STRIPE_RAIL);
      const effects = w.edges[failing].effects();
      w.relays[failing].mode = 'down';
      assert.equal(await pay(failing, w), 'not-completed');
      assert.equal(w.edges[failing].effects(), effects, 'no provider effect without a witnessed reservation');
      assert.deepEqual(await slotOf(w, failing === 'lightning' ? LIGHTNING_RAIL : STRIPE_RAIL), failingSlot);
      const healthySlot = await slotOf(w, healthy === 'lightning' ? LIGHTNING_RAIL : STRIPE_RAIL);
      assert.equal(await pay(healthy, w), 'completed');
      assert.ok(Number((await slotOf(w, healthy === 'lightning' ? LIGHTNING_RAIL : STRIPE_RAIL))['committed_sequence']) > Number(healthySlot['committed_sequence']));
      w.relays[failing].mode = 'forward';
      assert.equal(await pay(failing, w), 'completed', 'the witness back: the failed rail resumes');
      for (const edge of Object.values(w.edges)) await edge.close();
    });
  }

  for (const [title, pendingRail, other] of [
    ['a stripe transition left prepared at the witness (crash before its local commit) refuses stripe only: lightning reopens and its slot is never touched', 'stripe', 'lightning'],
    ['a lightning transition left prepared at the witness (crash before its local commit) refuses lightning only: stripe reopens and its slot is never touched', 'lightning', 'stripe'],
  ] as const) {
    it(title, async () => {
      const w = await world();
      assert.equal(await pay(other, w), 'completed');
      for (const edge of Object.values(w.edges)) await edge.close();
      const pendingNamespace = pendingRail === 'lightning' ? LIGHTNING_RAIL : STRIPE_RAIL;
      const slot = await slotOf(w, pendingNamespace);
      const { anchor } = await connect(w.witness);
      const expected = { stateKind: 'payment-initiation-reservations' as const, organizationId: ORG, namespace: pendingNamespace, storeId: String(slot['store_id']), sequence: Number(slot['committed_sequence']), stateDigest: String(slot['committed_digest']) };
      assert.equal((await anchor.prepare(expected, { ...expected, sequence: expected.sequence + 1, stateDigest: `sha256:${'cd'.repeat(32)}` })).outcome, 'prepared');
      await assert.rejects(openDirect(pendingRail, w), failsWith('AUTHORITY_FRESHNESS_PENDING_RECOVERY'));
      const otherSlot = await slotOf(w, other === 'lightning' ? LIGHTNING_RAIL : STRIPE_RAIL);
      await (await openDirect(other, w)).close();
      assert.deepEqual(await slotOf(w, other === 'lightning' ? LIGHTNING_RAIL : STRIPE_RAIL), otherSlot);
      assert.equal((await slotOf(w, pendingNamespace))['pending_sequence'], expected.sequence + 1, 'the pending transition stays, for trusted recovery');
    });
  }
});

describe('PAY-09 coexistence — the namespace comes from trusted configuration only (C7, M-C9)', () => {
  it('each payment-initiation interlock anchors under exactly `scope.railId` — its trusted configured rail id — and nothing else names a namespace', () => {
    for (const file of ['lightning-payment-rail/sqlite-lightning-payment-interlock.ts', 'stripe-payment-rail/sqlite-stripe-payment-interlock.ts']) {
      const source = readFileSync(join(process.cwd(), 'src/enterprise', file), 'utf8');
      const namespaces = [...source.matchAll(/namespace:\s*([^,}\s]+)/g)].map((match) => match[1]);
      assert.deepEqual(namespaces, ['scope.railId', 'scope.railId'], `${file}: the checkpoint and the genesis slot, both from the configured scope`);
      assert.match(source, /const scope = options\.scope;/, `${file}: the scope is the composition's option, never a request field`);
      assert.match(source, /if \(!isAuthorityStateNamespace\(scope\.railId\)\)/, `${file}: a non-canonical rail id is refused before anything is opened`);
    }
  });

  it('a rail id that is not a canonical namespace is refused at open, before any file or witness slot is created', async () => {
    const witness = await startWitness();
    const directory = mkdtempSync(join(tmpdir(), 'frontera-pay09-coexistence-ns-'));
    made.push(directory);
    for (const railId of ['Stripe-USD', 'stripe.usd', 'stripe_usd', 'rail/stripe']) {
      await assert.rejects(createSqliteStripePaymentInterlock(join(directory, 's.sqlite'), { scope: { railId, mode: STRIPE.mode, platformAccountId: STRIPE.platformAccountId }, now, freshness: { boundary: await boundaryFor(witness, ORG) } }), /canonical freshness namespace/, railId);
      await assert.rejects(createSqliteLightningPaymentInterlock(join(directory, 'l.sqlite'), { scope: { railId, network: LIGHTNING.network }, now, freshness: { boundary: await boundaryFor(witness, ORG) } }), /canonical freshness namespace/, railId);
    }
    assert.deepEqual(await witnessRows(witness.databasePath), []);
  });
});
