import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createHttpAuthorityStateWitnessTransport } from '../authority-state-freshness/index.js';
import { openSqliteHumanIdentityStore, type HumanIdentityStore } from '../human-identity/index.js';
import { testAuthenticity } from './authority-authenticity-fixture.js';
import { ScriptedWitnessTransport, WITNESS_TOKEN, boundaryFor, startWitness, witnessRows, type StartedWitness } from './core07-freshness-fixture.js';

/**
 * AUTH-04D1R — the shutdown race at the identity store, reproduced and closed.
 *
 * An identity write signs the next head, PREPARES it at the CORE-07 witness,
 * commits locally and finalizes. Closing the store between prepare and local
 * commit (what a clean Host shutdown did with `close()`) leaves the witness
 * holding a prepared successor the file never received: the next open is
 * `AUTHORITY_FRESHNESS_PENDING_RECOVERY`, which nothing may auto-clear.
 * `closeWhenSettled` refuses new writes before they are signed or prepared and
 * lets accepted ones finish, so a graceful shutdown never creates that state;
 * a write still running at the deadline fails closed exactly as before.
 */

const ORG = 'org-auth04d1r';
const roots: string[] = [];
const stores: HumanIdentityStore[] = [];
const witnesses: StartedWitness[] = [];
after(async () => {
  for (const store of stores) store.close();
  for (const witness of witnesses) await witness.close().catch(() => {});
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

/** A prepare the test holds until it says so: the witness has not received it yet. */
class HeldPrepare {
  private release: (() => void) | undefined;
  private gate: Promise<void> | undefined;
  armed = false;
  seen = 0;
  arm(): void {
    this.armed = true;
    this.gate = new Promise<void>((resolveGate) => {
      this.release = resolveGate;
    });
  }
  async wait(): Promise<void> {
    this.seen += 1;
    await this.gate;
  }
  open(): void {
    this.armed = false;
    this.release?.();
  }
  async reached(): Promise<void> {
    for (let attempt = 0; attempt < 200 && this.seen === 0; attempt += 1) await sleep(10);
    assert.ok(this.seen > 0, 'the write reached its witness prepare');
  }
}

async function fixture(): Promise<{ readonly path: string; readonly witness: StartedWitness; readonly held: HeldPrepare; readonly store: HumanIdentityStore; readonly transport: ScriptedWitnessTransport }> {
  const dir = mkdtempSync(join(tmpdir(), 'frontera-auth04d1r-'));
  roots.push(dir);
  const witness = await startWitness();
  witnesses.push(witness);
  const held = new HeldPrepare();
  const transport = new ScriptedWitnessTransport(createHttpAuthorityStateWitnessTransport({ endpoint: witness.endpoint, credential: WITNESS_TOKEN }));
  transport.answer = async (request, forward) => {
    if (request.operation === 'prepare' && held.armed) await held.wait();
    return forward();
  };
  const path = join(dir, 'human-identity.sqlite');
  const store = await openSqliteHumanIdentityStore(path, { organizationId: ORG, now: () => new Date().toISOString(), create: true, authenticity: testAuthenticity(), freshness: { boundary: await boundaryFor(witness, ORG, { transport }) } });
  stores.push(store);
  return { path, witness, held, store, transport };
}

const row = (operatorId: string) => ({ kind: 'principal_created' as const, operatorId, objectId: null, payload: '{}', recordedBy: 'auth04d1r-test', recordedAt: new Date().toISOString() });

async function reopen(path: string, witness: StartedWitness): Promise<HumanIdentityStore> {
  const store = await openSqliteHumanIdentityStore(path, { organizationId: ORG, now: () => new Date().toISOString(), authenticity: testAuthenticity(), freshness: { boundary: await boundaryFor(witness, ORG) } });
  stores.push(store);
  return store;
}

const codeOf = (error: unknown): unknown => (error as { code?: unknown }).code;
const identitySlot = async (witness: StartedWitness): Promise<Record<string, unknown> | undefined> => (await witnessRows(witness.databasePath)).find((entry) => entry['state_kind'] === 'human-identity-state');

describe('AUTH-04D1R — the identity-store shutdown race', () => {
  it('REPRODUCED: an immediate close() between the witness prepare and the local commit leaves a prepared successor the file never got; the next open refuses (PENDING_RECOVERY)', async () => {
    const { path, witness, held, store } = await fixture();
    await store.append(row('before'), () => undefined);
    held.arm();
    const write = store.append(row('in-flight'), () => undefined);
    await held.reached();
    store.close(); // what a clean Host shutdown did before AUTH-04D1R
    held.open();
    await assert.rejects(write);
    const slot = await identitySlot(witness);
    assert.equal(slot?.['committed_sequence'], 1);
    assert.equal(slot?.['pending_sequence'], 2, 'the witness holds the prepared successor');
    await assert.rejects(reopen(path, witness), (error: unknown) => codeOf(error) === 'AUTHORITY_FRESHNESS_PENDING_RECOVERY' || assert.fail(String(codeOf(error))));
  });

  it('FIXED: closeWhenSettled refuses new writes before anything is signed or prepared, lets the accepted write finish, and closes clean; the next open is ready', async () => {
    const { path, witness, held, store, transport } = await fixture();
    await store.append(row('before'), () => undefined);
    held.arm();
    const write = store.append(row('in-flight'), () => undefined);
    await held.reached();
    const closing = store.closeWhenSettled(10_000);
    const prepares = transport.count('prepare');
    await assert.rejects(store.append(row('late'), () => undefined), (error: unknown) => codeOf(error) === 'HUMAN_IDENTITY_STORE_UNAVAILABLE' || assert.fail(String(codeOf(error))));
    assert.throws(() => store.saveChallenge({ challenge: 'late-challenge', ceremony: 'authentication', operatorId: null, enrolmentId: null, targetCredentialId: null, issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString() }), (error: unknown) => codeOf(error) === 'HUMAN_IDENTITY_STORE_UNAVAILABLE');
    assert.equal(transport.count('prepare'), prepares, 'the refused write never reached the witness');
    let settled = false;
    void closing.then(() => (settled = true));
    await sleep(100);
    assert.equal(settled, false, 'the store waits for the accepted write');
    held.open();
    const recorded = await write;
    assert.equal(recorded.sequence, 2);
    assert.equal(await closing, 'settled');
    const slot = await identitySlot(witness);
    assert.deepEqual([slot?.['committed_sequence'], slot?.['pending_sequence']], [2, null], 'committed and finalized; nothing pending');
    const reopened = await reopen(path, witness);
    assert.equal(reopened.head().sequence, 2);
    assert.deepEqual(reopened.history().map((entry) => entry.operatorId), ['before', 'in-flight'], 'nothing dropped, nothing replayed, the late write never happened');
  });

  it('BOUNDED: a write still running at the deadline is cut off and fails closed, exactly as a crash at that instant (PENDING_RECOVERY); the drain never waits forever', async () => {
    const { path, witness, held, store } = await fixture();
    await store.append(row('before'), () => undefined);
    held.arm();
    const write = store.append(row('stuck'), () => undefined);
    await held.reached();
    const started = Date.now();
    assert.equal(await store.closeWhenSettled(200), 'interrupted');
    assert.ok(Date.now() - started < 5_000, 'bounded');
    held.open();
    await assert.rejects(write);
    await assert.rejects(reopen(path, witness), (error: unknown) => codeOf(error) === 'AUTHORITY_FRESHNESS_PENDING_RECOVERY' || assert.fail(String(codeOf(error))));
  });

  it('an idle store settles at once; the call is idempotent and refuses a nonsensical bound', async () => {
    const { path, witness, store } = await fixture();
    await store.append(row('only'), () => undefined);
    await assert.rejects(store.closeWhenSettled(0), (error: unknown) => codeOf(error) === 'HUMAN_IDENTITY_CONFIGURATION_INVALID');
    assert.equal(await store.closeWhenSettled(1_000), 'settled');
    assert.equal(await store.closeWhenSettled(1_000), 'settled');
    assert.equal((await reopen(path, witness)).head().sequence, 1);
  });
});
