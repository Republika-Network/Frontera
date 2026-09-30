import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdtempSync, rmSync, statSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createGrantIssuanceService,
  type BoundedGrant,
  type BoundedGrantStorePort,
  type GrantCorrelation,
  type GrantScope,
  type GrantSourceAuthorization,
} from '../../features/grant-runtime/index.js';
import { createGrantExecutionService } from '../../features/execution-runtime/index.js';
import { createRecordingExecutionAdapter } from '../../features/execution-runtime/tests/execution-fixture.js';
import { createSqliteBoundedGrantStore, type DurableBoundedGrantStore } from '../bounded-grant-store/index.js';
import {
  AuthorityStateFreshnessError,
  createAuthorityStateFreshnessBoundary,
  createHttpAuthorityStateWitnessTransport,
  type AuthorityStateEnrollmentContext,
  type AuthorityStateFreshnessBoundary,
  type AuthorityStateFreshnessErrorCode,
} from '../authority-state-freshness/index.js';
import { testAuthenticity } from './authority-authenticity-fixture.js';
import { ScriptedWitnessTransport, WITNESS_TOKEN, boundaryFor, closeAllWitnesses, connect, startWitness, witnessRows, type StartedWitness } from './core07-freshness-fixture.js';

/**
 * CORE-07 — cross-restart freshness of the bounded-grant store's signed
 * revocation state (AA-003 / GS-002).
 *
 * ## The attack every test here is built around
 *
 * Issue a grant, **capture the whole authority database**, revoke the grant,
 * stop the process, restore the captured files wholesale, restart. Every row
 * and the signed revocation-state commitment in the restored files are genuine
 * — the authority key really signed them — so signatures alone cannot tell
 * "never revoked" from "restored to before the revocation". Before CORE-07 the
 * restarted store read the grant as live and the execution path executed it.
 *
 * ## The deployment rule the claim rests on
 *
 * The witness's database is in its own directory, never beside the authority
 * store, and **no test here restores it** — except the ones that restore it on
 * purpose to show what CORE-07 does *not* claim.
 */

const ORG = 'org-core07';
const NOW = '2026-01-01T12:00:00.000Z';
const HORIZON = '2026-01-01T12:10:00.000Z';
const BEFORE_HORIZON = '2026-01-01T12:05:00.000Z';
const CORRELATION: GrantCorrelation = { requestId: 'req-1', decisionId: 'dec-1', action: 'payment.send', resourceScope: 'record:contract' };
const SCOPE: GrantScope = {
  action: { kind: 'identity', value: 'payment.send' },
  amount: { kind: 'ceiling', limit: '10000', unit: 'USD' },
  resources: { kind: 'set', values: ['record:contract'] },
};
const SOURCE: GrantSourceAuthorization = {
  correlation: CORRELATION,
  subject: 'actor-a',
  scope: SCOPE,
  authorizationPermitsExercise: true,
  allBlockingObligationsSatisfied: true,
  evaluatedAt: NOW,
  validityCeilings: [],
};
const OPERATOR: AuthorityStateEnrollmentContext = { operator: true, operatorId: 'operator-core07', attestation: 'verified-local-state-is-current' };

const workDir = mkdtempSync(join(tmpdir(), 'frontera-core07-grants-'));
after(async () => {
  await closeAllWitnesses();
  rmSync(workDir, { recursive: true, force: true });
});
let counter = 0;
function dbPath(name: string): string {
  counter += 1;
  return join(workDir, `${name}-${counter}`, 'bounded-grants.sqlite');
}

function correlationFor(n: number): GrantCorrelation {
  return n === 1 ? CORRELATION : { ...CORRELATION, requestId: `req-${n}`, decisionId: `dec-${n}` };
}

async function issue(store: BoundedGrantStorePort, n = 1): Promise<BoundedGrant> {
  const correlation = correlationFor(n);
  const outcome = await createGrantIssuanceService({ store }).issueGrant({ source: { ...SOURCE, correlation }, subject: 'actor-a', correlation, issuedAt: NOW, expiresAt: HORIZON });
  if (outcome.outcome !== 'issued') throw new Error(`expected an issued grant, got ${outcome.outcome}`);
  return outcome.grant;
}

function revoke(store: BoundedGrantStorePort, grantId: string, issuerRef = 'operator-a') {
  return store.revoke({ grantId, reason: 'security-incident', revokedAt: BEFORE_HORIZON, issuerRef });
}

async function exercise(store: BoundedGrantStorePort, grant: BoundedGrant): Promise<{ readonly status: string; readonly adapterCalls: number }> {
  const adapter = createRecordingExecutionAdapter();
  const outcome = await createGrantExecutionService({ store, adapter, now: () => BEFORE_HORIZON }).exercise({
    boundedGrantId: grant.id,
    correlation: grant.correlation,
    executionId: 'exec-1',
    subject: 'actor-a',
    action: 'payment.send',
    resource: 'record:contract',
    amount: { value: '100', unit: 'USD' },
  });
  return { status: outcome.status, adapterCalls: adapter.callCount };
}

function open(path: string, boundary: AuthorityStateFreshnessBoundary | undefined, enrollment?: AuthorityStateEnrollmentContext): Promise<DurableBoundedGrantStore> {
  return createSqliteBoundedGrantStore(path, { authenticity: testAuthenticity(), ...(boundary !== undefined ? { freshness: { boundary, ...(enrollment !== undefined ? { enrollment } : {}) } } : {}) });
}

/** A whole-database snapshot: the file and its WAL/SHM companions, byte for byte. Taken with the store closed. */
type Snapshot = ReadonlyMap<string, string | undefined>;
function capture(path: string, name: string): Snapshot {
  const snapshot = new Map<string, string | undefined>();
  for (const suffix of ['', '-wal', '-shm']) {
    const file = `${path}${suffix}`;
    const copy = `${path}.${name}${suffix || '-main'}`;
    if (existsSync(file)) {
      copyFileSync(file, copy);
      snapshot.set(suffix, copy);
    } else snapshot.set(suffix, undefined);
  }
  return snapshot;
}
function restore(path: string, snapshot: Snapshot): void {
  for (const [suffix, copy] of snapshot) {
    const file = `${path}${suffix}`;
    if (existsSync(file)) unlinkSync(file);
    if (copy !== undefined) copyFileSync(copy, file);
  }
}

function refusedWith(code: AuthorityStateFreshnessErrorCode) {
  return (error: unknown): true => {
    assert.ok(error instanceof AuthorityStateFreshnessError, `expected an AuthorityStateFreshnessError, got ${String(error)}`);
    assert.equal(error.code, code, error.message);
    return true;
  };
}

async function rawState(path: string): Promise<{ readonly storeId: string; readonly sequence: number; readonly digest: string }> {
  const { default: Database } = await import('better-sqlite3');
  const db = new Database(path, { readonly: true });
  try {
    const row = db.prepare('SELECT store_id, sequence, revocation_set_digest FROM bounded_grant_revocation_state').get() as { store_id: string; sequence: number; revocation_set_digest: string };
    return { storeId: row.store_id, sequence: row.sequence, digest: row.revocation_set_digest };
  } finally {
    db.close();
  }
}

async function grantSlot(witness: StartedWitness): Promise<Record<string, unknown> | undefined> {
  return (await witnessRows(witness.databasePath)).find((row) => row['state_kind'] === 'bounded-grant-revocation-state');
}

// ---------------------------------------------------------------------------
// The reproduction, inverted: the exact CORE-07 bug, now refused
// ---------------------------------------------------------------------------

describe('CORE-07 — a restored pre-revocation snapshot is refused after a restart (AA-003 / GS-002)', () => {
  it('G8/G9: issue → capture → revoke → stop → restore → restart: the restart is refused as a rollback, before any grant can be read or exercised', async () => {
    const witness = await startWitness();
    const path = dbPath('g8');
    let store = await open(path, await boundaryFor(witness, ORG));
    const grant = await issue(store);
    await store.close();
    const pre = await rawState(path);
    const snapshot = capture(path, 'pre-revocation');

    store = await open(path, await boundaryFor(witness, ORG));
    assert.equal((await revoke(store, grant.id)).outcome, 'revoked');
    assert.deepEqual(await exercise(store, grant), { status: 'withheld', adapterCalls: 0 });
    await store.close();
    const post = await rawState(path);
    assert.equal(post.storeId, pre.storeId);
    assert.equal(pre.sequence, 0);
    assert.equal(post.sequence, 1);
    assert.notEqual(post.digest, pre.digest);
    assert.equal((await grantSlot(witness))?.['committed_sequence'], 1, 'the witness holds the post-revocation state, outside the restored domain');

    restore(path, snapshot);
    assert.deepEqual(await rawState(path), pre, 'the restored files are the genuine, signed pre-revocation state');

    // The restarted store refuses to open: no store object exists through which
    // the grant could be read, and so none through which it could be exercised.
    await assert.rejects(async () => open(path, await boundaryFor(witness, ORG)), refusedWith('AUTHORITY_FRESHNESS_ROLLBACK_DETECTED'));
    assert.equal((await grantSlot(witness))?.['committed_sequence'], 1, 'a refused rollback never moves the witness backwards');
  });

  it('G1: a brand-new store and an empty witness open; the genesis is enrolled before the local genesis is committed', async () => {
    const witness = await startWitness();
    const path = dbPath('g1');
    const store = await open(path, await boundaryFor(witness, ORG));
    const local = await rawState(path);
    const slot = await grantSlot(witness);
    assert.equal(slot?.['store_id'], local.storeId);
    assert.equal(slot?.['committed_sequence'], 0);
    assert.equal(slot?.['committed_digest'], local.digest);
    assert.equal((await store.health()).freshness?.status, 'ready');
    await store.close();
  });

  it('G2: a restart over the current state — same sequence, same digest — opens, and every revocation survives', async () => {
    const witness = await startWitness();
    const path = dbPath('g2');
    let store = await open(path, await boundaryFor(witness, ORG));
    const grant = await issue(store);
    await revoke(store, grant.id);
    await store.close();
    for (let restart = 0; restart < 3; restart += 1) {
      store = await open(path, await boundaryFor(witness, ORG));
      assert.ok((await store.read(grant.id)).revocation !== undefined);
      assert.deepEqual(await exercise(store, grant), { status: 'withheld', adapterCalls: 0 });
      await store.close();
    }
  });

  it('G3/C5: a restored state with a lower sequence than the witnessed one is a rollback', async () => {
    const witness = await startWitness();
    const path = dbPath('g3');
    let store = await open(path, await boundaryFor(witness, ORG));
    const first = await issue(store, 1);
    const second = await issue(store, 2);
    await revoke(store, first.id);
    await store.close();
    const atOne = capture(path, 'seq1');
    store = await open(path, await boundaryFor(witness, ORG));
    await revoke(store, second.id);
    await store.close();
    restore(path, atOne);
    await assert.rejects(async () => open(path, await boundaryFor(witness, ORG)), refusedWith('AUTHORITY_FRESHNESS_ROLLBACK_DETECTED'));
  });

  it('G4/C6: the same sequence with a different digest — a fork written by a writer that bypassed the witness — is refused', async () => {
    const witness = await startWitness();
    const path = dbPath('g4');
    let store = await open(path, await boundaryFor(witness, ORG));
    const a = await issue(store, 1);
    const b = await issue(store, 2);
    await store.close();
    const genesis = capture(path, 'genesis');
    store = await open(path, await boundaryFor(witness, ORG));
    await revoke(store, a.id);
    await store.close();
    // From the same genesis, a writer holding the key but not using the
    // witness commits a *different* genuine sequence-1 state.
    restore(path, genesis);
    const rogue = await open(path, undefined);
    await revoke(rogue, b.id);
    await rogue.close();
    assert.equal((await rawState(path)).sequence, 1);
    await assert.rejects(async () => open(path, await boundaryFor(witness, ORG)), refusedWith('AUTHORITY_FRESHNESS_FORK_DETECTED'));
  });

  it('G5: a different genuine store substituted under an occupied slot is refused', async () => {
    const witness = await startWitness();
    const path = dbPath('g5');
    const store = await open(path, await boundaryFor(witness, ORG));
    await store.close();
    // Another store, genuinely signed by the same key, never this slot's.
    const otherPath = dbPath('g5-other');
    const other = await open(otherPath, undefined);
    await other.close();
    restore(path, capture(otherPath, 'swap'));
    assert.notEqual((await rawState(path)).storeId, (await grantSlot(witness))?.['store_id']);
    await assert.rejects(async () => open(path, await boundaryFor(witness, ORG)), refusedWith('AUTHORITY_FRESHNESS_BINDING_MISMATCH'));
  });

  it('G6: a witness receipt for another state kind — even one genuinely signed by the witness — is refused', async () => {
    const witness = await startWitness();
    const path = dbPath('g6');
    const store = await open(path, await boundaryFor(witness, ORG));
    await store.close();
    const inner = createHttpAuthorityStateWitnessTransport({ endpoint: witness.endpoint, credential: WITNESS_TOKEN });
    const scripted = new ScriptedWitnessTransport(inner);
    // Ask the real witness about the *approval* slot instead, and hand that
    // (authentic) answer back for the grant question.
    scripted.answer = (request, forward) => (request.operation === 'read' ? inner.call({ ...request, binding: { ...request.binding, stateKind: 'approval-state' } }, { timeoutMs: 2_000 }) : forward());
    await assert.rejects(async () => open(path, await boundaryFor(witness, ORG, { transport: scripted })), refusedWith('AUTHORITY_FRESHNESS_BINDING_MISMATCH'));
  });

  it('G7: a witness that cannot be reached at a cold start refuses the store — nothing is opened on local-only freshness', async () => {
    const witness = await startWitness();
    const path = dbPath('g7');
    const boundary = await boundaryFor(witness, ORG);
    const store = await open(path, boundary);
    await store.close();
    await witness.close();
    await assert.rejects(async () => open(path, boundary), refusedWith('AUTHORITY_FRESHNESS_UNAVAILABLE'));
  });

  it('G10: a rollback underneath a running store is still refused on the next read (the CORE-01 in-process witness, preserved)', async () => {
    const witness = await startWitness();
    const path = dbPath('g10');
    const store = await open(path, await boundaryFor(witness, ORG));
    const grant = await issue(store);
    const { default: Database } = await import('better-sqlite3');
    const db = new Database(path);
    const captured = db.prepare('SELECT * FROM bounded_grant_revocation_state').get() as Record<string, unknown>;
    db.close();
    await revoke(store, grant.id);
    const attacker = new Database(path);
    for (const { name } of attacker.prepare(`SELECT name FROM sqlite_master WHERE type = 'trigger'`).all() as { name: string }[]) attacker.exec(`DROP TRIGGER "${name}"`);
    attacker.prepare('DELETE FROM bounded_grant_revocations WHERE grant_id = ?').run(grant.id);
    attacker.prepare('UPDATE bounded_grants SET revocation_digest = NULL WHERE grant_id = ?').run(grant.id);
    attacker
      .prepare('UPDATE bounded_grant_revocation_state SET sequence = ?, revocation_set_digest = ?, signing_key_id = ?, signature = ?, signature_version = ?, signature_algorithm = ?')
      .run(captured['sequence'], captured['revocation_set_digest'], captured['signing_key_id'], captured['signature'], captured['signature_version'], captured['signature_algorithm']);
    attacker.close();
    await assert.rejects(() => store.read(grant.id));
    assert.deepEqual(await exercise(store, grant), { status: 'withheld', adapterCalls: 0 });
    assert.equal((await store.health()).status, 'unhealthy');
    await store.close();
  });

  it('G11: a witness itself rolled back behind the local store is refused — the local state is ahead of anything witnessed', async () => {
    let witness = await startWitness();
    const path = dbPath('g11');
    let store = await open(path, await boundaryFor(witness, ORG));
    const grant = await issue(store);
    await store.close();
    await witness.close();
    const witnessAtGenesis = capture(witness.databasePath, 'witness-genesis');
    witness = await witness.restart();
    store = await open(path, await boundaryFor(witness, ORG));
    await revoke(store, grant.id);
    await store.close();
    await witness.close();
    // Roll the *witness* back (its own restore domain), leaving the authority store current.
    restore(witness.databasePath, witnessAtGenesis);
    witness = await witness.restart();
    await assert.rejects(async () => open(path, await boundaryFor(witness, ORG)), refusedWith('AUTHORITY_FRESHNESS_FORK_DETECTED'));
  });

  it('G12: after startup, a witness outage never falls back to local-only freshness — a revocation writes nothing and says so', async () => {
    const witness = await startWitness();
    const path = dbPath('g12');
    const store = await open(path, await boundaryFor(witness, ORG));
    const grant = await issue(store);
    const before = await rawState(path);
    await witness.close();
    await assert.rejects(() => revoke(store, grant.id), refusedWith('AUTHORITY_FRESHNESS_UNAVAILABLE'));
    assert.deepEqual(await rawState(path), before, 'nothing was written');
    // Existing authority still reads against the floor established at startup.
    assert.equal((await store.read(grant.id)).revocation, undefined);
    const health = await store.health();
    assert.equal(health.status, 'healthy', 'a witness outage after an established startup is not a store failure');
    assert.equal(health.freshness?.status, 'unavailable');
    await store.close();
  });
});

// ---------------------------------------------------------------------------
// C — crash consistency: prepare → local commit → finalize
// ---------------------------------------------------------------------------

/** A boundary whose witness transport the test scripts, over the real witness. */
async function scriptedBoundary(witness: StartedWitness): Promise<{ readonly boundary: AuthorityStateFreshnessBoundary; readonly transport: ScriptedWitnessTransport }> {
  const transport = new ScriptedWitnessTransport(createHttpAuthorityStateWitnessTransport({ endpoint: witness.endpoint, credential: WITNESS_TOKEN }));
  const { anchor, monitor } = await connect(witness, { transport });
  return { boundary: createAuthorityStateFreshnessBoundary({ anchor, monitor, organizationId: ORG }), transport };
}

class Crash extends Error {}

describe('CORE-07 — crash consistency of a revocation', () => {
  it('C1: prepare, local commit and finalize — the witness commits exactly the new local state', async () => {
    const witness = await startWitness();
    const path = dbPath('c1');
    const { boundary, transport } = await scriptedBoundary(witness);
    const store = await open(path, boundary);
    const grant = await issue(store);
    await revoke(store, grant.id);
    assert.deepEqual(transport.calls.filter((call) => call === 'prepare' || call === 'finalize'), ['prepare', 'finalize'], 'one prepare before the commit, one finalize after it');
    const local = await rawState(path);
    const slot = await grantSlot(witness);
    assert.equal(slot?.['committed_sequence'], local.sequence);
    assert.equal(slot?.['committed_digest'], local.digest);
    assert.equal(slot?.['pending_sequence'], null);
    await store.close();
  });

  it('C2: a prepare that fails leaves the local authority state unchanged, and the grant is still reported as not revoked', async () => {
    const witness = await startWitness();
    const path = dbPath('c2');
    const { boundary, transport } = await scriptedBoundary(witness);
    const store = await open(path, boundary);
    const grant = await issue(store);
    const before = await rawState(path);
    transport.answer = (request, forward) => {
      if (request.operation === 'prepare') throw new AuthorityStateFreshnessError('AUTHORITY_FRESHNESS_UNAVAILABLE', 'scripted outage');
      return forward();
    };
    await assert.rejects(() => revoke(store, grant.id), refusedWith('AUTHORITY_FRESHNESS_UNAVAILABLE'));
    assert.deepEqual(await rawState(path), before);
    assert.equal((await grantSlot(witness))?.['pending_sequence'], null, 'nothing was prepared');
    await store.close();
  });

  it('C3: a crash after prepare and before the local commit — witness pending, local old — refuses the restart (pending-recovery), never auto-abandons', async () => {
    const witness = await startWitness();
    const path = dbPath('c3');
    const { boundary, transport } = await scriptedBoundary(witness);
    const store = await open(path, boundary);
    const grant = await issue(store);
    // The witness applies the prepare; the process "dies" before it hears back
    // and before its local commit.
    transport.answer = async (request, forward) => {
      const answer = await forward();
      if (request.operation === 'prepare') throw new Crash('process died after prepare');
      return answer;
    };
    await assert.rejects(() => revoke(store, grant.id));
    await store.close();
    const slot = await grantSlot(witness);
    assert.equal(slot?.['committed_sequence'], 0);
    assert.equal(slot?.['pending_sequence'], 1, 'the witness holds the prepared successor');
    assert.equal((await rawState(path)).sequence, 0, 'the local store never committed it');
    await assert.rejects(async () => open(path, await boundaryFor(witness, ORG)), refusedWith('AUTHORITY_FRESHNESS_PENDING_RECOVERY'));
    assert.equal((await grantSlot(witness))?.['pending_sequence'], 1, 'the pending transition is never cleared automatically');
  });

  it('C4: a crash after the local commit and before finalize — witness pending, local exactly that — is finalized at the next start', async () => {
    const witness = await startWitness();
    const path = dbPath('c4');
    const { boundary, transport } = await scriptedBoundary(witness);
    const store = await open(path, boundary);
    const grant = await issue(store);
    transport.answer = (request, forward) => {
      if (request.operation === 'finalize') throw new Crash('process died before finalize');
      return forward();
    };
    // The revocation is acknowledged: local and witness-pending already agree.
    assert.equal((await revoke(store, grant.id)).outcome, 'revoked');
    await store.close();
    const local = await rawState(path);
    assert.equal((await grantSlot(witness))?.['pending_sequence'], local.sequence);
    const restarted = await open(path, await boundaryFor(witness, ORG));
    const slot = await grantSlot(witness);
    assert.equal(slot?.['committed_sequence'], local.sequence, 'finalized on restart');
    assert.equal(slot?.['pending_sequence'], null);
    assert.ok((await restarted.read(grant.id)).revocation !== undefined);
    await restarted.close();
  });

  it('C4 + rollback: after a crash before finalize, restoring the pre-revocation snapshot is still refused — the prepare already made the old state stale', async () => {
    const witness = await startWitness();
    const path = dbPath('c4-rollback');
    let store = await open(path, await boundaryFor(witness, ORG));
    const grant = await issue(store);
    await store.close();
    const snapshot = capture(path, 'pre');
    const { boundary, transport } = await scriptedBoundary(witness);
    store = await open(path, boundary);
    transport.answer = (request, forward) => {
      if (request.operation === 'finalize') throw new Crash('process died before finalize');
      return forward();
    };
    assert.equal((await revoke(store, grant.id)).outcome, 'revoked');
    await store.close();
    restore(path, snapshot);
    await assert.rejects(async () => open(path, await boundaryFor(witness, ORG)), refusedWith('AUTHORITY_FRESHNESS_PENDING_RECOVERY'));
  });

  it('C6b: a pending successor at the witness and a *different* local successor at the same sequence is a fork, never finalized', async () => {
    const witness = await startWitness();
    const path = dbPath('c6b');
    const { boundary, transport } = await scriptedBoundary(witness);
    const store = await open(path, boundary);
    const a = await issue(store, 1);
    const b = await issue(store, 2);
    transport.answer = async (request, forward) => {
      const answer = await forward();
      if (request.operation === 'prepare') throw new Crash('died after preparing the revocation of A');
      return answer;
    };
    await assert.rejects(() => revoke(store, a.id));
    await store.close();
    // A writer holding the key but bypassing the witness commits a different successor: B revoked.
    const rogue = await open(path, undefined);
    await revoke(rogue, b.id);
    await rogue.close();
    const slot = await grantSlot(witness);
    assert.equal(slot?.['pending_sequence'], 1);
    assert.notEqual(slot?.['pending_digest'], (await rawState(path)).digest);
    await assert.rejects(async () => open(path, await boundaryFor(witness, ORG)), refusedWith('AUTHORITY_FRESHNESS_FORK_DETECTED'));
    assert.equal((await grantSlot(witness))?.['pending_sequence'], 1, 'a mismatching successor is never finalized');
  });

  it('C4 in-process: a finalize that did not arrive is completed before the next transition', async () => {
    const witness = await startWitness();
    const path = dbPath('c4-inprocess');
    const { boundary, transport } = await scriptedBoundary(witness);
    const store = await open(path, boundary);
    const first = await issue(store, 1);
    const second = await issue(store, 2);
    let dropFinalize = true;
    transport.answer = (request, forward) => {
      if (request.operation === 'finalize' && dropFinalize) {
        dropFinalize = false;
        throw new AuthorityStateFreshnessError('AUTHORITY_FRESHNESS_UNAVAILABLE', 'scripted lost finalize');
      }
      return forward();
    };
    await revoke(store, first.id);
    assert.equal((await store.health()).freshness?.status, 'unavailable');
    await revoke(store, second.id);
    const slot = await grantSlot(witness);
    assert.equal(slot?.['committed_sequence'], 2);
    assert.equal(slot?.['pending_sequence'], null);
    assert.equal((await store.health()).freshness?.status, 'ready');
    await store.close();
  });

  it('C7/C8: two writers planning the same successor — exactly one prepare wins; the loser commits nothing it planned and re-plans on the winner', async () => {
    const witness = await startWitness();
    const path = dbPath('c7');
    let setup = await open(path, await boundaryFor(witness, ORG));
    const a = await issue(setup, 1);
    const b = await issue(setup, 2);
    await setup.close();
    // Two "processes": two store instances over the same file, each with its own witness client.
    const first = await scriptedBoundary(witness);
    const second = await scriptedBoundary(witness);
    const writerA = await open(path, first.boundary);
    const writerB = await open(path, second.boundary);
    // Hold A's first prepare until B has committed and finalized, so both planned from sequence 0.
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let heldOnce = false;
    first.transport.answer = async (request, forward) => {
      if (request.operation === 'prepare' && !heldOnce) {
        heldOnce = true;
        await held;
      }
      return forward();
    };
    const revokingA = revoke(writerA, a.id);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal((await revoke(writerB, b.id)).outcome, 'revoked');
    release();
    assert.equal((await revokingA).outcome, 'revoked', 'the loser re-planned on the winner and committed its own successor');
    assert.ok(first.transport.count('prepare') >= 2, 'the loser lost its first compare-and-advance');
    await writerA.close();
    await writerB.close();
    const local = await rawState(path);
    assert.equal(local.sequence, 2);
    const slot = await grantSlot(witness);
    assert.equal(slot?.['committed_sequence'], 2);
    assert.equal(slot?.['committed_digest'], local.digest);
    // Every state the witness ever prepared is one the store holds a prefix of: no second accepted successor.
    const { default: Database } = await import('better-sqlite3');
    const db = new Database(witness.databasePath, { readonly: true });
    const prepared = db.prepare(`SELECT sequence FROM witness_history WHERE event = 'prepared' ORDER BY id`).all() as { sequence: number }[];
    db.close();
    assert.deepEqual(prepared.map((row) => row.sequence), [1, 2]);
    setup = await open(path, await boundaryFor(witness, ORG));
    assert.ok((await setup.read(a.id)).revocation !== undefined);
    assert.ok((await setup.read(b.id)).revocation !== undefined);
    await setup.close();
  });
});

// ---------------------------------------------------------------------------
// E — first enrollment and genesis
// ---------------------------------------------------------------------------

describe('CORE-07 — enrollment and genesis', () => {
  it('E1: a brand-new store is enrolled as genesis; a crash between enrollment and the local genesis is adopted, never a second store', async () => {
    const witness = await startWitness();
    const path = dbPath('e1');
    const { boundary, transport } = await scriptedBoundary(witness);
    transport.answer = async (request, forward) => {
      const answer = await forward();
      if (request.operation === 'enroll') throw new Crash('process died after the witness enrolled the genesis');
      return answer;
    };
    await assert.rejects(async () => open(path, boundary));
    const enrolled = await grantSlot(witness);
    assert.equal(enrolled?.['committed_sequence'], 0);
    assert.ok(!existsSync(path) || statSync(path).size === 0 || (await rawStateOrUndefined(path)) === undefined, 'no local genesis was committed');
    const store = await open(path, await boundaryFor(witness, ORG));
    assert.equal((await rawState(path)).storeId, enrolled?.['store_id'], 'the witnessed store id is adopted');
    await store.close();
  });

  it('E1: a deleted store is never re-initialized once the witness holds state beyond genesis', async () => {
    const witness = await startWitness();
    const path = dbPath('e1-deleted');
    const store = await open(path, await boundaryFor(witness, ORG));
    const grant = await issue(store);
    await revoke(store, grant.id);
    await store.close();
    for (const suffix of ['', '-wal', '-shm']) if (existsSync(`${path}${suffix}`)) unlinkSync(`${path}${suffix}`);
    await assert.rejects(async () => open(path, await boundaryFor(witness, ORG)), refusedWith('AUTHORITY_FRESHNESS_ROLLBACK_DETECTED'));
  });

  it('E2: an existing non-genesis store and a witness with no binding — no silent enrollment', async () => {
    const witness = await startWitness();
    const path = dbPath('e2');
    const legacy = await open(path, undefined);
    const grant = await issue(legacy);
    await revoke(legacy, grant.id);
    await legacy.close();
    await assert.rejects(async () => open(path, await boundaryFor(witness, ORG)), refusedWith('AUTHORITY_FRESHNESS_UNBOUND_STORE'));
    assert.equal(await grantSlot(witness), undefined, 'the witness was never bound');
  });

  it('E2: an existing store still at genesis is not silently enrolled either', async () => {
    const witness = await startWitness();
    const path = dbPath('e2-genesis');
    const legacy = await open(path, undefined);
    await issue(legacy);
    await legacy.close();
    await assert.rejects(async () => open(path, await boundaryFor(witness, ORG)), refusedWith('AUTHORITY_FRESHNESS_UNBOUND_STORE'));
  });

  it('E3/E4: explicit trusted enrollment of an existing verified store succeeds; afterwards every start needs the witness', async () => {
    const witness = await startWitness();
    const path = dbPath('e3');
    const legacy = await open(path, undefined);
    const grant = await issue(legacy);
    await revoke(legacy, grant.id);
    await legacy.close();
    const enrolled = await open(path, await boundaryFor(witness, ORG), OPERATOR);
    await enrolled.close();
    const slot = await grantSlot(witness);
    assert.equal(slot?.['committed_sequence'], 1);
    const restarted = await open(path, await boundaryFor(witness, ORG));
    assert.ok((await restarted.read(grant.id)).revocation !== undefined);
    await restarted.close();
    const boundary = await boundaryFor(witness, ORG);
    await witness.close();
    await assert.rejects(async () => open(path, boundary), refusedWith('AUTHORITY_FRESHNESS_UNAVAILABLE'));
  });

  it('E5: a pre-enrollment state restored after enrollment is refused when older than the enrolled checkpoint', async () => {
    const witness = await startWitness();
    const path = dbPath('e5');
    const legacy = await open(path, undefined);
    const grant = await issue(legacy);
    await legacy.close();
    const beforeRevocation = capture(path, 'pre');
    const again = await open(path, undefined);
    await revoke(again, grant.id);
    await again.close();
    await (await open(path, await boundaryFor(witness, ORG), OPERATOR)).close();
    restore(path, beforeRevocation);
    await assert.rejects(async () => open(path, await boundaryFor(witness, ORG)), refusedWith('AUTHORITY_FRESHNESS_ROLLBACK_DETECTED'));
  });

  it('E6: an occupied slot cannot be enrolled again as another state; a forged enrollment context is refused', async () => {
    const witness = await startWitness();
    const path = dbPath('e6');
    const store = await open(path, await boundaryFor(witness, ORG));
    await store.close();
    const otherPath = dbPath('e6-other');
    const other = await open(otherPath, undefined);
    const grant = await issue(other);
    await revoke(other, grant.id);
    await other.close();
    await assert.rejects(async () => open(otherPath, await boundaryFor(witness, ORG), OPERATOR), refusedWith('AUTHORITY_FRESHNESS_ALREADY_ENROLLED'));
    const forged = Object.create({ operator: true, operatorId: 'x', attestation: 'verified-local-state-is-current' }) as AuthorityStateEnrollmentContext;
    await assert.rejects(async () => open(otherPath, await boundaryFor(witness, ORG), forged), refusedWith('AUTHORITY_FRESHNESS_CONFIGURATION_INVALID'));
    // Re-enrolling the exact current state of the bound store is the same enrollment.
    await (await open(path, await boundaryFor(witness, ORG), OPERATOR)).close();
  });
});

async function rawStateOrUndefined(path: string): Promise<unknown> {
  try {
    return await rawState(path);
  } catch {
    return undefined;
  }
}
