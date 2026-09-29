import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import Database from 'better-sqlite3';

import { ApprovalAuthorityError, createInMemoryApprovalStore, createSqliteApprovalStore, type ApprovalStore } from '../approval-authority/index.js';
import type { AuthorityArtifactSigner } from '../authority-authenticity/signer.js';
import { AUTHORITY_KEY_A, AUTHORITY_KEY_B, testAuthenticity, testSigner, testVerifier } from './authority-authenticity-fixture.js';
import {
  Clock,
  INSERT_ROW,
  ORG,
  actor,
  at,
  authorityOver,
  cleanup,
  corrupt,
  forge,
  forgedVerdict,
  opened,
  openStore,
  rawHead,
  rawRows,
  storePath,
  target,
} from './core05-approval-fixture.js';

/**
 * CORE-05 — a database-only writer cannot manufacture, restore or keep an
 * approval.
 *
 * Every attack is judged by the one read that resumes a decision (`assess`,
 * the orchestrator's port), by `describe`, and by a restart (`open`). Every
 * attack recomputes every unkeyed digest this repository defines.
 */

after(cleanup);

async function assertRefusedEverywhere(file: string, store: ApprovalStore): Promise<void> {
  // The resuming read believes nothing — withheld, never approved.
  assert.deepEqual(await authorityOver(store).assess(target()), { kind: 'withheld', status: 'unavailable' });
  await assert.rejects(() => authorityOver(store).describe('aoc.gar:target'), corrupt);
  // And a Host restarting over the file refuses to start on it.
  await assert.rejects(() => openStore(file), corrupt);
}

/** A genuine store whose target request holds `verdicts` (by approver, in order). */
type Verdict = 'approve' | 'reject' | 'revoke' | 'requestChanges' | 'escalate';

async function genuine(verdicts: readonly (readonly [string, Verdict])[]): Promise<{ readonly file: string; readonly store: ApprovalStore }> {
  const file = storePath();
  const store = await openStore(file);
  const authority = authorityOver(store);
  const command = await opened(authority);
  for (const [approver, kind] of verdicts) await authority[kind](actor(approver), command);
  return { file, store };
}

describe('CORE-05 — baseline: the genuine store resumes only on a genuine quorum', () => {
  it('requested → one approval pending → two distinct approvals approved', async () => {
    const { file, store } = await genuine([['approver-a', 'approve']]);
    assert.deepEqual(await authorityOver(store).assess(target()), { kind: 'withheld', status: 'pending' });
    await authorityOver(store).approve(actor('approver-b'), { approvalRequestId: (await authorityOver(store).describe('aoc.gar:target'))!.approvalRequestId, subjectDigest: rawRows(file)[0]!.subject_digest });
    assert.equal((await authorityOver(store).assess(target())).kind, 'approved');
    assert.equal(rawRows(file).length, 3);
  });
});

describe('CORE-05 — forged, altered, deleted, reordered and transplanted approvals are refused', () => {
  it('a forged approval quorum (or a forged proof-completing approval) inserted under the kept head or re-signed with an attacker key', async () => {
    for (const signature of ['keep', 'attacker-key'] as const) {
      const { file, store } = await genuine([]);
      await forge(file, (current) => [...current, forgedVerdict(current[0]!, 'approver-a'), forgedVerdict(current[0]!, 'approver-b')], signature);
      await assertRefusedEverywhere(file, store);
    }
  });

  it('rows rewritten under the untouched signed head: approver swapped, verdict turned into an approval, proof expiry moved', async () => {
    const edits: readonly ((rows: ReturnType<typeof rawRows>) => ReturnType<typeof rawRows>)[] = [
      (current) => current.map((row) => (row.kind === 'approved' ? { ...row, actor_id: 'approver-c' } : row)),
      (current) => current.map((row) => (row.kind === 'rejected' ? { ...row, kind: 'approved' } : row)),
      // `approvedAt` (and so the proof's `notAfter`) comes from the completing row's time.
      (current) => current.map((row) => (row.kind === 'approved' ? { ...row, recorded_at: at(3000) } : row)),
    ];
    for (const edit of edits) {
      const { file, store } = await genuine([
        ['approver-a', 'approve'],
        ['approver-c', 'reject'],
      ]);
      await forge(file, edit, 'head-untouched');
      await assertRefusedEverywhere(file, store);
    }
  });

  it('deletion widens authority, so every deletion is refused: a rejection, a revocation, an approval, the request (and its requirement snapshot)', async () => {
    const cases: readonly { readonly verdicts: readonly (readonly [string, Verdict])[]; readonly drop: string }[] = [
      { verdicts: [['approver-c', 'reject']], drop: 'rejected' },
      { verdicts: [['approver-a', 'approve'], ['approver-b', 'approve'], ['approver-c', 'revoke']], drop: 'revoked' },
      { verdicts: [['approver-a', 'approve']], drop: 'approved' },
      { verdicts: [], drop: 'requested' },
    ];
    for (const { verdicts, drop } of cases) {
      for (const signature of ['head-untouched', 'attacker-key'] as const) {
        const { file, store } = await genuine(verdicts);
        await forge(file, (current) => current.filter((row) => row.kind !== drop), signature);
        await assertRefusedEverywhere(file, store);
      }
    }
  });

  it('reorder, duplicate and gap under the untouched head', async () => {
    const edits: readonly ((rows: ReturnType<typeof rawRows>) => ReturnType<typeof rawRows>)[] = [
      (current) => [current[0]!, current[2]!, current[1]!],
      (current) => [...current, { ...current[1]! }],
    ];
    for (const edit of edits) {
      const { file, store } = await genuine([
        ['approver-c', 'requestChanges'],
        ['approver-a', 'reject'],
      ]);
      await forge(file, edit, 'head-untouched');
      await assertRefusedEverywhere(file, store);
    }
    // A gap: a row removed and the sequence numbers left as they were.
    const { file, store } = await genuine([
      ['approver-a', 'approve'],
      ['approver-b', 'approve'],
    ]);
    const db = new Database(file);
    db.exec('DROP TRIGGER IF EXISTS approval_records_no_delete;');
    db.prepare('DELETE FROM approval_records WHERE sequence = 2').run();
    db.close();
    await assertRefusedEverywhere(file, store);
  });

  it('a genuine, correctly signed approval history copied from another store is refused — rows and head are bound to their store', async () => {
    const donor = await genuine([
      ['approver-a', 'approve'],
      ['approver-b', 'approve'],
    ]);
    assert.equal((await authorityOver(donor.store).assess(target())).kind, 'approved');
    const { file, store } = await genuine([]);
    const donorRows = rawRows(donor.file);
    const donorHead = rawHead(donor.file);
    const db = new Database(file);
    db.exec('DROP TRIGGER IF EXISTS approval_records_no_update; DROP TRIGGER IF EXISTS approval_records_no_delete;');
    db.prepare('DELETE FROM approval_records').run();
    for (const row of donorRows) db.prepare(INSERT_ROW).run(row);
    db.close();
    await assertRefusedEverywhere(file, store);
    const withHead = new Database(file);
    withHead.prepare('UPDATE approval_head SET sequence = ?, chain_digest = ?, signature_json = ? WHERE id = 1').run(donorHead.sequence, donorHead.chain_digest, donorHead.signature_json);
    withHead.close();
    await assert.rejects(() => openStore(file), corrupt);
  });

  it('a store created for another organization is refused at open; a row of another organization is refused', async () => {
    const file = storePath();
    await (await openStore(file, { organizationId: 'org-other' })).close();
    await assert.rejects(() => openStore(file), corrupt);
    const { file: mine, store } = await genuine([]);
    await forge(mine, (current) => [...current, { ...forgedVerdict(current[0]!, 'approver-a'), organization_id: 'org-other' }], 'attacker-key');
    await assertRefusedEverywhere(mine, store);
  });
});

describe('CORE-05 — genesis, schema, laundering and atomicity', () => {
  it('a file with content but no authenticated identity, or identity without a head, is refused — never given a fresh genesis', async () => {
    const file = storePath();
    const db = new Database(file);
    db.exec('CREATE TABLE approval_records (sequence INTEGER PRIMARY KEY); INSERT INTO approval_records VALUES (1);');
    db.close();
    await assert.rejects(() => openStore(file), corrupt);
    const headless = storePath();
    await (await openStore(headless)).close();
    const edit = new Database(headless);
    edit.prepare('DELETE FROM approval_head').run();
    edit.close();
    await assert.rejects(() => openStore(headless), corrupt);
  });

  it('there is no unauthenticated durable mode, and an unknown schema version is refused', async () => {
    await assert.rejects(
      () => createSqliteApprovalStore(storePath(), { now: () => at(0), organizationId: ORG, authenticity: undefined as never }),
      (error: unknown) => error instanceof ApprovalAuthorityError && error.code === 'APPROVAL_STORE_UNSUPPORTED',
    );
    const file = storePath();
    await (await openStore(file)).close();
    const db = new Database(file);
    db.prepare('UPDATE approval_store_meta SET schema_version = 99').run();
    db.close();
    await assert.rejects(() => openStore(file), (error: unknown) => error instanceof ApprovalAuthorityError && error.code === 'APPROVAL_STORE_UNSUPPORTED');
  });

  it('laundering, before planning: a legitimate approval over tampered rows is refused and the signed head stays byte-identical', async () => {
    const { file, store } = await genuine([]);
    const authority = authorityOver(store);
    const command = { approvalRequestId: (await authority.describe('aoc.gar:target'))!.approvalRequestId, subjectDigest: rawRows(file)[0]!.subject_digest };
    await forge(file, (current) => [...current, forgedVerdict(current[0]!, 'approver-b')], 'head-untouched');
    const before = rawHead(file);
    await assert.rejects(() => authority.approve(actor('approver-a'), command), corrupt);
    assert.deepEqual(rawHead(file), before);
  });

  it('laundering, during signing: rows tampered after the plan and before the write lock are never signed over', async () => {
    const file = storePath();
    let tamper = false;
    const inner = testSigner(AUTHORITY_KEY_A);
    const signer: AuthorityArtifactSigner = {
      ...inner,
      async signApprovalState(state) {
        const signature = await inner.signApprovalState(state);
        if (tamper) {
          // An attacker rewrites the committed history between the plan and the
          // transaction (a new row at the planned position would merely collide
          // with the legitimate insert; a rewrite is what only re-verification
          // under the lock can see).
          const db = new Database(file);
          db.exec('DROP TRIGGER IF EXISTS approval_records_no_update;');
          db.prepare("UPDATE approval_records SET recorded_by = 'attacker' WHERE sequence = 1").run();
          db.close();
          tamper = false;
        }
        return signature;
      },
    };
    const store = await createSqliteApprovalStore(file, { now: () => at(60), organizationId: ORG, authenticity: { signer, verifier: testVerifier([AUTHORITY_KEY_A]) } });
    const authority = authorityOver(store);
    const command = await opened(authority);
    const before = rawHead(file);
    tamper = true;
    await assert.rejects(() => authority.approve(actor('approver-a'), command));
    assert.deepEqual(rawHead(file), before, 'the legitimate signer never signed the attacker state');
    await assert.rejects(() => openStore(file), corrupt);
    await store.close();
  });

  it('crash between row and head: both roll back together; a half-written state is refused at restart', async () => {
    const { file, store } = await genuine([]);
    const authority = authorityOver(store);
    const command = { approvalRequestId: (await authority.describe('aoc.gar:target'))!.approvalRequestId, subjectDigest: rawRows(file)[0]!.subject_digest };
    const before = { rows: rawRows(file), head: rawHead(file) };
    const db = new Database(file);
    db.exec(`CREATE TRIGGER crash_on_head BEFORE UPDATE ON approval_head BEGIN SELECT RAISE(ABORT, 'simulated crash'); END;`);
    db.close();
    await assert.rejects(() => authority.approve(actor('approver-a'), command), /simulated crash/);
    assert.deepEqual(rawRows(file), before.rows, 'the row did not survive without its head');
    assert.deepEqual(rawHead(file), before.head);
    const fix = new Database(file);
    fix.exec('DROP TRIGGER crash_on_head;');
    fix.close();
    await (await openStore(file)).close();
    // A half-written state — a row without its signed head — is refused.
    const half = new Database(file);
    half.prepare(INSERT_ROW).run({ ...before.rows[0]!, sequence: 2, kind: 'approved', subject: null, actor_id: 'approver-a', recorded_by: 'crash' });
    half.close();
    await assert.rejects(() => openStore(file), corrupt);
  });

  it('the ephemeral store says so', () => {
    assert.equal(createInMemoryApprovalStore({ organizationId: ORG }).kind, 'ephemeral');
  });
});

describe('CORE-05 — key rotation follows the CORE-01 rule', () => {
  it('an unchanged state signed by a trusted previous key is re-attested under the active key and survives retiring the old key; a tampered one never is', async () => {
    const file = storePath();
    const first = await openStore(file, { authenticity: testAuthenticity({ signWith: AUTHORITY_KEY_A }) });
    const command = await opened(authorityOver(first));
    await authorityOver(first).approve(actor('approver-a'), command);
    await first.close();
    await assert.rejects(() => openStore(file, { authenticity: testAuthenticity({ signWith: AUTHORITY_KEY_B, trust: [AUTHORITY_KEY_B] }) }), corrupt);
    const before = rawHead(file);
    const rotated = await openStore(file, { authenticity: testAuthenticity({ signWith: AUTHORITY_KEY_B, trust: [AUTHORITY_KEY_A, AUTHORITY_KEY_B] }) });
    const afterRotation = rawHead(file);
    assert.equal(afterRotation.chain_digest, before.chain_digest, 're-attestation signs the same state, never a new one');
    assert.equal((JSON.parse(afterRotation.signature_json) as { keyId: string }).keyId, AUTHORITY_KEY_B.keyId);
    await rotated.close();
    const retired = await openStore(file, { authenticity: { signer: testSigner(AUTHORITY_KEY_B), verifier: testVerifier([AUTHORITY_KEY_B]) } });
    assert.deepEqual((await authorityOver(retired).describe('aoc.gar:target'))?.state.approvers, ['approver-a']);

    // Tampered under the old key: refused, and never re-attested.
    const tampered = storePath();
    const old = await openStore(tampered, { authenticity: testAuthenticity({ signWith: AUTHORITY_KEY_A }) });
    await opened(authorityOver(old));
    await old.close();
    await forge(tampered, (current) => [...current, forgedVerdict(current[0]!, 'approver-a')], 'head-untouched');
    const headBefore = rawHead(tampered);
    await assert.rejects(() => openStore(tampered, { authenticity: testAuthenticity({ signWith: AUTHORITY_KEY_B, trust: [AUTHORITY_KEY_A, AUTHORITY_KEY_B] }) }), corrupt);
    assert.deepEqual(rawHead(tampered), headBefore);
  });
});

describe('CORE-05 — rollback (the CORE-07 residual, pinned)', () => {
  it('S1 approved → S2 revoked → S1 restored: refused while the process lives; across a restart the older genuine state is believed (stated residual)', async () => {
    const clock = new Clock();
    const file = storePath();
    const store = await openStore(file, { clock });
    const authority = authorityOver(store, { clock });
    const command = await opened(authority);
    await authority.approve(actor('approver-a'), command);
    await authority.approve(actor('approver-b'), command);
    assert.equal((await authority.assess(target())).kind, 'approved');
    const s1 = { head: rawHead(file), rows: rawRows(file) };
    await authority.revoke(actor('approver-c'), command);
    assert.deepEqual(await authority.assess(target()), { kind: 'withheld', status: 'revoked' });

    // The older, genuinely signed S1, restored underneath the running process.
    const rollback = new Database(file);
    rollback.exec('DROP TRIGGER IF EXISTS approval_records_no_delete;');
    rollback.prepare('DELETE FROM approval_records WHERE sequence > ?').run(s1.rows.length);
    rollback.prepare('UPDATE approval_head SET sequence = ?, chain_digest = ?, signature_json = ? WHERE id = 1').run(s1.head.sequence, s1.head.chain_digest, s1.head.signature_json);
    rollback.close();
    await assert.rejects(() => authority.describe('aoc.gar:target'), (error: unknown) => corrupt(error) && /regressed/.test((error as Error).message));
    assert.deepEqual(await authority.assess(target()), { kind: 'withheld', status: 'unavailable' });

    // RESIDUAL (CORE-07): after a restart there is no witness, and the older
    // genuine state — approved — verifies. CORE-05 does not claim to detect
    // this; it is bounded by the approval's own validity window and by every
    // other issuance gate, and closed by CORE-07's external anchoring.
    const restarted = authorityOver(await openStore(file, { clock }), { clock });
    assert.equal((await restarted.assess(target())).kind, 'approved');
  });
});
