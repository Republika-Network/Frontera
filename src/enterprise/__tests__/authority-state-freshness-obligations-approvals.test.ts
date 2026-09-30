import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdtempSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';

import { ObligationLifecycleService, type ObligationDischargeSource } from '../../features/obligation-runtime/index.js';
import {
  createObligationDischargeRecorder,
  createSqliteObligationDischargeStore,
  createStoredObligationDischargeProvider,
  type ObligationDischargeStore,
} from '../obligation-discharge/index.js';
import { createSqliteApprovalStore, type ApprovalStore } from '../approval-authority/index.js';
import {
  AuthorityStateFreshnessError,
  createAuthorityStateFreshnessBoundary,
  createHttpAuthorityStateWitnessTransport,
  type AuthorityStateFreshnessBoundary,
  type AuthorityStateFreshnessErrorCode,
} from '../authority-state-freshness/index.js';
import { testAuthenticity } from './authority-authenticity-fixture.js';
import { Clock, ORG as APPROVAL_ORG, actor, authorityOver, opened, target } from './core05-approval-fixture.js';
import { ScriptedWitnessTransport, WITNESS_TOKEN, boundaryFor, closeAllWitnesses, connect, startWitness, witnessRows, type StartedWitness } from './core07-freshness-fixture.js';

/**
 * CORE-07 — cross-restart freshness of the obligation-discharge (CORE-04) and
 * approval (CORE-05) stores' signed chain heads.
 *
 * The two stores differ in what a rollback does, and this suite does not
 * pretend otherwise:
 *
 * - **Obligations.** Reports are recorded in strictly increasing observation
 *   time and a satisfied obligation is terminal, so a restored earlier prefix
 *   can only *remove* satisfaction — it withholds, it never manufactures
 *   authority (pinned by `obligation-discharge-authenticity.test.ts`). CORE-07
 *   still anchors it: authority state has one freshness story, and "withheld
 *   because an old snapshot came back" is not a state a Host should silently
 *   run in.
 * - **Approvals.** A prefix *can* be more permissive than its whole — approved
 *   before a revocation or a rejection — so a restored prefix used to make a
 *   revoked approval usable again after a restart. That is refused here.
 */

const ORG = 'org-a';
const NOW = '2026-09-28T12:00:00.000Z';
const SOURCES: readonly ObligationDischargeSource[] = [
  { id: 'board', kind: 'approval_runtime', name: 'Board', verificationClass: 'independent' },
  { id: 'notes', kind: 'internal_store', name: 'Notes', verificationClass: 'self_reported' },
];
const CORRELATION = { requestId: 'aoc.gar:target', action: 'deploy-release', resourceScope: 'production' } as const;
const WRITER = { system: true, actorId: 'operator:board-sync' } as const;
const lifecycle = new ObligationLifecycleService({ sources: SOURCES, declaration: { requirements: [{ obligationType: 'change.approval', blocking: true }] } });
assert.equal(APPROVAL_ORG, ORG);

const directories: string[] = [];
const closables: { close(): Promise<void> }[] = [];
after(async () => {
  for (const store of closables) await store.close().catch(() => {});
  await closeAllWitnesses();
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
});

function fileIn(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `frontera-core07-${name}-`));
  directories.push(dir);
  return join(dir, `${name}.sqlite`);
}

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

async function scriptedBoundary(witness: StartedWitness, organizationId = ORG): Promise<{ readonly boundary: AuthorityStateFreshnessBoundary; readonly transport: ScriptedWitnessTransport }> {
  const transport = new ScriptedWitnessTransport(createHttpAuthorityStateWitnessTransport({ endpoint: witness.endpoint, credential: WITNESS_TOKEN }));
  const { anchor, monitor } = await connect(witness, { transport });
  return { boundary: createAuthorityStateFreshnessBoundary({ anchor, monitor, organizationId }), transport };
}

class Crash extends Error {}

async function slot(witness: StartedWitness, stateKind: string): Promise<Record<string, unknown> | undefined> {
  return (await witnessRows(witness.databasePath)).find((row) => row['state_kind'] === stateKind);
}

// ── obligations ────────────────────────────────────────────────────────────

async function openDischarges(file: string, boundary: AuthorityStateFreshnessBoundary | undefined): Promise<ObligationDischargeStore> {
  const store = await createSqliteObligationDischargeStore(file, { now: () => NOW, organizationId: ORG, authenticity: testAuthenticity(), ...(boundary !== undefined ? { freshness: { boundary } } : {}) });
  closables.push(store);
  return store;
}

let clock = Date.parse(NOW) - 3_600_000;
const tick = (): string => new Date((clock += 1000)).toISOString();

async function record(store: ObligationDischargeStore, sourceId: string, outcome: 'discharged' | 'waived'): Promise<void> {
  await createObligationDischargeRecorder({ store, sources: SOURCES, organizationId: ORG, now: () => NOW }).record(WRITER, { correlation: CORRELATION, obligationType: 'change.approval', sourceId, outcome, observedAt: tick() });
}

async function obligationState(store: ObligationDischargeStore): Promise<string> {
  const provider = createStoredObligationDischargeProvider(store, ORG);
  const { observations } = await provider.resolveObligationDischarges({ obligationTypes: ['change.approval'], correlation: CORRELATION, actorId: 'a', trustDomainId: 't', organizationId: ORG, at: NOW });
  return lifecycle.resolve(observations, CORRELATION, NOW).obligations[0]?.state ?? 'none';
}

function dischargeHead(file: string): { sequence: number; chain_digest: string } {
  const db = new Database(file, { readonly: true });
  try {
    return db.prepare('SELECT sequence, chain_digest FROM obligation_discharge_head').get() as { sequence: number; chain_digest: string };
  } finally {
    db.close();
  }
}

describe('CORE-07 — obligation-discharge state freshness', () => {
  it('O1: the current head matching the witness opens, across restarts', async () => {
    const witness = await startWitness();
    const file = fileIn('discharges');
    let store = await openDischarges(file, await boundaryFor(witness, ORG));
    await record(store, 'board', 'discharged');
    await store.close();
    store = await openDischarges(file, await boundaryFor(witness, ORG));
    assert.equal(await obligationState(store), 'verified');
    assert.equal((await slot(witness, 'obligation-discharge-state'))?.['committed_sequence'], 1);
  });

  it('O2: a restored older authenticated head after a restart is refused', async () => {
    const witness = await startWitness();
    const file = fileIn('discharges');
    let store = await openDischarges(file, await boundaryFor(witness, ORG));
    await record(store, 'notes', 'discharged');
    await store.close();
    const earlier = capture(file, 'seq1');
    store = await openDischarges(file, await boundaryFor(witness, ORG));
    await record(store, 'board', 'discharged');
    assert.equal(await obligationState(store), 'verified');
    await store.close();
    restore(file, earlier);
    await assert.rejects(async () => openDischarges(file, await boundaryFor(witness, ORG)), refusedWith('AUTHORITY_FRESHNESS_ROLLBACK_DETECTED'));
  });

  it('O3: the same sequence with a different chain digest is refused as a fork', async () => {
    const witness = await startWitness();
    const file = fileIn('discharges');
    let store = await openDischarges(file, await boundaryFor(witness, ORG));
    await store.close();
    const genesis = capture(file, 'genesis');
    store = await openDischarges(file, await boundaryFor(witness, ORG));
    await record(store, 'board', 'discharged');
    await store.close();
    restore(file, genesis);
    const rogue = await openDischarges(file, undefined);
    await record(rogue, 'notes', 'discharged');
    await rogue.close();
    assert.equal(dischargeHead(file).sequence, 1);
    await assert.rejects(async () => openDischarges(file, await boundaryFor(witness, ORG)), refusedWith('AUTHORITY_FRESHNESS_FORK_DETECTED'));
  });

  it('O4: another genuine store substituted under the slot is refused', async () => {
    const witness = await startWitness();
    const file = fileIn('discharges');
    await (await openDischarges(file, await boundaryFor(witness, ORG))).close();
    const otherFile = fileIn('other-discharges');
    await (await openDischarges(otherFile, undefined)).close();
    restore(file, capture(otherFile, 'swap'));
    await assert.rejects(async () => openDischarges(file, await boundaryFor(witness, ORG)), refusedWith('AUTHORITY_FRESHNESS_BINDING_MISMATCH'));
  });

  it('O5: a witness answer about another organization — even an authentic one — is refused, and a boundary for another organization is refused outright', async () => {
    const witness = await startWitness();
    const file = fileIn('discharges');
    await (await openDischarges(file, await boundaryFor(witness, ORG))).close();
    const { boundary, transport } = await scriptedBoundary(witness);
    const inner = createHttpAuthorityStateWitnessTransport({ endpoint: witness.endpoint, credential: WITNESS_TOKEN });
    transport.answer = (request, forward) => (request.operation === 'read' ? inner.call({ ...request, binding: { ...request.binding, organizationId: 'org-b' } }, { timeoutMs: 2_000 }) : forward());
    await assert.rejects(() => openDischarges(file, boundary), refusedWith('AUTHORITY_FRESHNESS_BINDING_MISMATCH'));
    await assert.rejects(async () => openDischarges(file, await boundaryFor(witness, 'org-b')), refusedWith('AUTHORITY_FRESHNESS_CONFIGURATION_INVALID'));
  });

  it('O6: a witness that cannot prepare an append leaves no usable committed transition — nothing is written', async () => {
    const witness = await startWitness();
    const file = fileIn('discharges');
    const store = await openDischarges(file, await boundaryFor(witness, ORG));
    await record(store, 'notes', 'discharged');
    const before = dischargeHead(file);
    await witness.close();
    await assert.rejects(() => record(store, 'board', 'discharged'), refusedWith('AUTHORITY_FRESHNESS_UNAVAILABLE'));
    assert.deepEqual(dischargeHead(file), before);
    assert.equal(await obligationState(store), 'discharged', 'the verified discharge never became a committed authority transition');
  });

  it('O7: crash after prepare → restart is pending-recovery; crash after commit → restart finalizes', async () => {
    const witness = await startWitness();
    const beforeCommit = fileIn('discharges');
    let scripted = await scriptedBoundary(witness);
    let store = await openDischarges(beforeCommit, scripted.boundary);
    scripted.transport.answer = async (request, forward) => {
      const answer = await forward();
      if (request.operation === 'prepare') throw new Crash('died after prepare');
      return answer;
    };
    await assert.rejects(() => record(store, 'board', 'discharged'));
    await store.close();
    await assert.rejects(async () => openDischarges(beforeCommit, await boundaryFor(witness, ORG)), refusedWith('AUTHORITY_FRESHNESS_PENDING_RECOVERY'));

    const other = await startWitness();
    const afterCommit = fileIn('discharges');
    scripted = await scriptedBoundary(other);
    store = await openDischarges(afterCommit, scripted.boundary);
    scripted.transport.answer = (request, forward) => {
      if (request.operation === 'finalize') throw new Crash('died before finalize');
      return forward();
    };
    await record(store, 'board', 'discharged');
    await store.close();
    assert.equal((await slot(other, 'obligation-discharge-state'))?.['pending_sequence'], 1);
    store = await openDischarges(afterCommit, await boundaryFor(other, ORG));
    assert.equal(await obligationState(store), 'verified');
    assert.equal((await slot(other, 'obligation-discharge-state'))?.['committed_sequence'], 1);
  });

  it('O8: the in-process witness still refuses a local regression — and now also a different state at the same sequence', async () => {
    const file = fileIn('discharges');
    const store = await openDischarges(file, undefined);
    const genesis = capture(file, 'genesis');
    await record(store, 'board', 'discharged');
    // A different genuine sequence-1 state, written by another holder of the key from the same genesis.
    const forkFile = fileIn('fork');
    restore(forkFile, genesis);
    const rogue = await openDischarges(forkFile, undefined);
    await record(rogue, 'notes', 'discharged');
    await rogue.close();
    const forkDb = new Database(forkFile, { readonly: true });
    const rows = forkDb.prepare('SELECT * FROM obligation_discharges ORDER BY sequence').all() as Record<string, unknown>[];
    const head = forkDb.prepare('SELECT sequence, chain_digest, signature_json FROM obligation_discharge_head').get() as { sequence: number; chain_digest: string; signature_json: string };
    const forkMeta = forkDb.prepare('SELECT store_id FROM obligation_discharge_store_meta').get() as { store_id: string };
    forkDb.close();
    const db = new Database(file);
    const meta = db.prepare('SELECT store_id FROM obligation_discharge_store_meta').get() as { store_id: string };
    assert.equal(forkMeta.store_id, meta.store_id, 'the same store, forked');
    db.exec('DROP TRIGGER IF EXISTS obligation_discharges_no_delete; DROP TRIGGER IF EXISTS obligation_discharges_no_update;');
    db.prepare('DELETE FROM obligation_discharges').run();
    for (const row of rows) db.prepare(`INSERT INTO obligation_discharges (${Object.keys(row).join(', ')}) VALUES (${Object.keys(row).map(() => '?').join(', ')})`).run(...Object.values(row));
    db.prepare('UPDATE obligation_discharge_head SET sequence = ?, chain_digest = ?, signature_json = ? WHERE id = 1').run(head.sequence, head.chain_digest, head.signature_json);
    db.close();
    await assert.rejects(() => obligationState(store), (error: unknown) => error instanceof Error && /different committed state at the same sequence/.test(error.message));
  });
});

// ── approvals ──────────────────────────────────────────────────────────────

async function openApprovals(file: string, boundary: AuthorityStateFreshnessBoundary | undefined, clock = new Clock()): Promise<ApprovalStore> {
  const store = await createSqliteApprovalStore(file, { now: clock.now, organizationId: ORG, authenticity: testAuthenticity(), ...(boundary !== undefined ? { freshness: { boundary } } : {}) });
  closables.push(store);
  return store;
}

function approvalHead(file: string): { sequence: number; chain_digest: string } {
  const db = new Database(file, { readonly: true });
  try {
    return db.prepare('SELECT sequence, chain_digest FROM approval_head').get() as { sequence: number; chain_digest: string };
  } finally {
    db.close();
  }
}

describe('CORE-07 — approval state freshness', () => {
  it('P1: the current authenticated approval head matching the witness opens', async () => {
    const witness = await startWitness();
    const file = fileIn('approvals');
    const clock = new Clock();
    let store = await openApprovals(file, await boundaryFor(witness, ORG), clock);
    const authority = authorityOver(store, { clock });
    const command = await opened(authority);
    await authority.approve(actor('approver-a'), command);
    await authority.approve(actor('approver-b'), command);
    await store.close();
    store = await openApprovals(file, await boundaryFor(witness, ORG), clock);
    assert.equal((await authorityOver(store, { clock }).assess(target())).kind, 'approved');
    assert.equal((await slot(witness, 'approval-state'))?.['committed_sequence'], 3);
  });

  it('P2/P3: approved → revoked → the approved prefix restored → restart refused; the revoked approval never becomes usable again', async () => {
    const witness = await startWitness();
    const file = fileIn('approvals');
    const clock = new Clock();
    let store = await openApprovals(file, await boundaryFor(witness, ORG), clock);
    let authority = authorityOver(store, { clock });
    const command = await opened(authority);
    await authority.approve(actor('approver-a'), command);
    await authority.approve(actor('approver-b'), command);
    assert.equal((await authority.assess(target())).kind, 'approved');
    await store.close();
    const approvedPrefix = capture(file, 'approved');
    store = await openApprovals(file, await boundaryFor(witness, ORG), clock);
    authority = authorityOver(store, { clock });
    await authority.revoke(actor('approver-c'), command);
    assert.deepEqual(await authority.assess(target()), { kind: 'withheld', status: 'revoked' });
    await store.close();
    restore(file, approvedPrefix);
    // Before CORE-07 this restart believed the older, genuine state: `approved`.
    await assert.rejects(async () => openApprovals(file, await boundaryFor(witness, ORG), clock), refusedWith('AUTHORITY_FRESHNESS_ROLLBACK_DETECTED'));
  });

  it('P4: the same sequence with a different chain digest is refused as a fork', async () => {
    const witness = await startWitness();
    const file = fileIn('approvals');
    const clock = new Clock();
    let store = await openApprovals(file, await boundaryFor(witness, ORG), clock);
    const command = await opened(authorityOver(store, { clock }));
    await store.close();
    const requested = capture(file, 'requested');
    store = await openApprovals(file, await boundaryFor(witness, ORG), clock);
    await authorityOver(store, { clock }).approve(actor('approver-a'), command);
    await store.close();
    restore(file, requested);
    const rogue = await openApprovals(file, undefined, clock);
    await authorityOver(rogue, { clock }).reject(actor('approver-c'), command);
    await rogue.close();
    assert.equal(approvalHead(file).sequence, 2);
    await assert.rejects(async () => openApprovals(file, await boundaryFor(witness, ORG), clock), refusedWith('AUTHORITY_FRESHNESS_FORK_DETECTED'));
  });

  it('P5: another genuine approval store substituted under the slot is refused', async () => {
    const witness = await startWitness();
    const file = fileIn('approvals');
    await (await openApprovals(file, await boundaryFor(witness, ORG))).close();
    const otherFile = fileIn('other-approvals');
    await (await openApprovals(otherFile, undefined)).close();
    restore(file, capture(otherFile, 'swap'));
    await assert.rejects(async () => openApprovals(file, await boundaryFor(witness, ORG)), refusedWith('AUTHORITY_FRESHNESS_BINDING_MISMATCH'));
  });

  it('P6: a witness answer about another organization is refused', async () => {
    const witness = await startWitness();
    const file = fileIn('approvals');
    await (await openApprovals(file, await boundaryFor(witness, ORG))).close();
    const { boundary, transport } = await scriptedBoundary(witness);
    const inner = createHttpAuthorityStateWitnessTransport({ endpoint: witness.endpoint, credential: WITNESS_TOKEN });
    transport.answer = (request, forward) => (request.operation === 'read' ? inner.call({ ...request, binding: { ...request.binding, organizationId: 'org-b' } }, { timeoutMs: 2_000 }) : forward());
    await assert.rejects(() => openApprovals(file, boundary), refusedWith('AUTHORITY_FRESHNESS_BINDING_MISMATCH'));
  });

  it('P7: a witness outage during a state transition fails closed — the verdict is not recorded and nothing changes', async () => {
    const witness = await startWitness();
    const file = fileIn('approvals');
    const clock = new Clock();
    const store = await openApprovals(file, await boundaryFor(witness, ORG), clock);
    const authority = authorityOver(store, { clock });
    const command = await opened(authority);
    await authority.approve(actor('approver-a'), command);
    const before = approvalHead(file);
    await witness.close();
    await assert.rejects(() => authority.approve(actor('approver-b'), command), refusedWith('AUTHORITY_FRESHNESS_UNAVAILABLE'));
    assert.deepEqual(approvalHead(file), before);
    assert.deepEqual(await authority.assess(target()), { kind: 'withheld', status: 'pending' });
  });

  it('P8: a pending transition that exactly matches the local next state is finalized at restart', async () => {
    const witness = await startWitness();
    const file = fileIn('approvals');
    const clock = new Clock();
    const scripted = await scriptedBoundary(witness);
    let store = await openApprovals(file, scripted.boundary, clock);
    const authority = authorityOver(store, { clock });
    const command = await opened(authority);
    await authority.approve(actor('approver-a'), command);
    scripted.transport.answer = (request, forward) => {
      if (request.operation === 'finalize') throw new Crash('died before finalize');
      return forward();
    };
    await authority.approve(actor('approver-b'), command);
    await store.close();
    assert.equal((await slot(witness, 'approval-state'))?.['pending_sequence'], 3);
    store = await openApprovals(file, await boundaryFor(witness, ORG), clock);
    assert.equal((await authorityOver(store, { clock }).assess(target())).kind, 'approved');
    const bound = await slot(witness, 'approval-state');
    assert.equal(bound?.['committed_sequence'], 3);
    assert.equal(bound?.['pending_sequence'], null);
  });

  it('P9: a pending transition over an old local state is refused as pending-recovery — never auto-abandoned', async () => {
    const witness = await startWitness();
    const file = fileIn('approvals');
    const clock = new Clock();
    const scripted = await scriptedBoundary(witness);
    const store = await openApprovals(file, scripted.boundary, clock);
    const authority = authorityOver(store, { clock });
    const command = await opened(authority);
    scripted.transport.answer = async (request, forward) => {
      const answer = await forward();
      if (request.operation === 'prepare') throw new Crash('died after prepare');
      return answer;
    };
    await assert.rejects(() => authority.reject(actor('approver-c'), command));
    await store.close();
    await assert.rejects(async () => openApprovals(file, await boundaryFor(witness, ORG), clock), refusedWith('AUTHORITY_FRESHNESS_PENDING_RECOVERY'));
    assert.equal((await slot(witness, 'approval-state'))?.['pending_sequence'], 2, 'still pending');
  });
});
