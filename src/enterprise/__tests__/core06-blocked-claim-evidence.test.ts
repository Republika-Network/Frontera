import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import Database from 'better-sqlite3';

import { createGrantExecutionService } from '../../features/execution-runtime/index.js';
import { createRecordingExecutionAdapter } from '../../features/execution-runtime/tests/execution-fixture.js';
import {
  createGrantIssuanceService,
  type BoundedGrant,
  type BoundedGrantStorePort,
  type GrantCorrelation,
  type GrantScope,
  type GrantSourceAuthorization,
} from '../../features/grant-runtime/index.js';
import { createSqliteApprovalStore, type ApprovalStore } from '../approval-authority/index.js';
import type { AuthorityArtifactSigner } from '../authority-authenticity/index.js';
import { AUTHORITY_KEY_A, AUTHORITY_KEY_B, openDurableStore, testAuthenticity, testSigner, testVerifier } from './authority-authenticity-fixture.js';
import { Clock, ORG as APPROVAL_ORG, actor, authorityOver, opened, target } from './core05-approval-fixture.js';

/**
 * CORE-06 — executable evidence for the BLOCKED claims the qualification
 * audit found with none (`docs/security/CORE-06-GOVERNANCE-CORE-QUALIFICATION.md`
 * §6). Each block names the row it proves. Nothing here changes a mechanism:
 * each claim was already true by construction, and is now also asserted.
 *
 * - AUTHORITATIVE_GRANT_STORE.md §5 B and D, THREAT_MODEL_V1 §7.16a row 1 —
 *   crash immediately after an issuance / revocation acknowledgement;
 * - §5 C — crash (a failure) partway through the revocation transaction;
 * - §5 Q — concurrent exercise and revocation in one process;
 * - §5 S — concurrent issuance of one identity on the **durable** store;
 * - §5 W, §7.16a row 8 — database locked by another writer;
 * - THREAT_MODEL_V1 §7.16e "same-sequence fork" — the approval store's
 *   in-process witness, at runtime (it was only pinned lexically).
 */

const NOW = '2026-01-01T12:00:00.000Z';
const HORIZON = '2026-01-01T12:10:00.000Z';
const BEFORE_HORIZON = '2026-01-01T12:05:00.000Z';
const CORRELATION: GrantCorrelation = { requestId: 'req-core06', decisionId: 'dec-core06', action: 'payment.send', resourceScope: 'record:contract' };
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
const REVOCATION = { reason: 'security-incident', revokedAt: BEFORE_HORIZON, issuerRef: 'operator-core06' } as const;

const workDir = mkdtempSync(join(tmpdir(), 'frontera-core06-evidence-'));
after(() => rmSync(workDir, { recursive: true, force: true }));
let counter = 0;
const dbPath = (name: string): string => join(workDir, `${name}-${(counter += 1)}.sqlite`);

function issueWith(store: BoundedGrantStorePort, correlation: GrantCorrelation = CORRELATION) {
  return createGrantIssuanceService({ store }).issueGrant({ source: { ...SOURCE, correlation }, subject: 'actor-a', correlation, issuedAt: NOW, expiresAt: HORIZON });
}
async function issueInto(store: BoundedGrantStorePort, correlation: GrantCorrelation = CORRELATION): Promise<BoundedGrant> {
  const outcome = await issueWith(store, correlation);
  if (outcome.outcome !== 'issued') throw new Error(`expected an issued grant, got ${outcome.outcome}`);
  return outcome.grant;
}

function exercise(store: BoundedGrantStorePort, grant: BoundedGrant, executionId: string) {
  const adapter = createRecordingExecutionAdapter();
  const outcome = createGrantExecutionService({ store, adapter, now: () => BEFORE_HORIZON }).exercise({
    boundedGrantId: grant.id,
    correlation: grant.correlation,
    executionId,
    subject: 'actor-a',
    action: 'payment.send',
    resource: 'record:contract',
    amount: { value: '100', unit: 'USD' },
  });
  return { adapter, outcome };
}

const count = (file: string, sql: string): number => {
  const db = new Database(file, { readonly: true });
  try {
    return (db.prepare(sql).get() as { n: number }).n;
  } finally {
    db.close();
  }
};

// ── §5 B / D, §7.16a row 1 — a crash right after the acknowledgement ─────────

/**
 * A separate Node process opens the durable store, performs the operation,
 * writes the acknowledgement it received to stdout and is SIGKILLed on the
 * spot: no `close()`, no WAL checkpoint, no graceful shutdown of any kind.
 */
function crashAfterAcknowledgement(file: string, operation: 'issue' | 'issue-then-revoke'): { readonly grant: BoundedGrant; readonly acknowledged: string } {
  const here = __dirname;
  const moduleUrl = (relative: string) => pathToFileURL(join(here, relative)).href;
  const script = `
    const { createSqliteBoundedGrantStore } = await import(${JSON.stringify(moduleUrl('../bounded-grant-store/index.js'))});
    const { createSoftwareAuthorityArtifactSigner, createAuthorityArtifactVerifier } = await import(${JSON.stringify(moduleUrl('../authority-authenticity/index.js'))});
    const { createGrantIssuanceService } = await import(${JSON.stringify(moduleUrl('../../features/grant-runtime/index.js'))});
    const key = JSON.parse(process.env.CORE06_KEY);
    const signer = createSoftwareAuthorityArtifactSigner({ keyId: key.keyId, algorithm: key.algorithm, privateKeyPem: key.privateKeyPem });
    const verifier = createAuthorityArtifactVerifier([{ keyId: key.keyId, algorithm: key.algorithm, publicKeyPem: key.publicKeyPem }]);
    const store = await createSqliteBoundedGrantStore(process.env.CORE06_DB, { authenticity: { signer, verifier } });
    const input = JSON.parse(process.env.CORE06_INPUT);
    const issued = await createGrantIssuanceService({ store }).issueGrant(input);
    if (issued.outcome !== 'issued') throw new Error('not issued: ' + issued.outcome);
    let acknowledged = 'issued';
    if (process.env.CORE06_OPERATION === 'issue-then-revoke') {
      const revoked = await store.revoke({ grantId: issued.grant.id, ...JSON.parse(process.env.CORE06_REVOCATION) });
      acknowledged = revoked.outcome;
    }
    process.stdout.write(JSON.stringify({ acknowledged, grant: issued.grant }) + '\\n', () => process.kill(process.pid, 'SIGKILL'));
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: here,
    env: {
      ...process.env,
      CORE06_KEY: JSON.stringify(AUTHORITY_KEY_A),
      CORE06_DB: file,
      CORE06_OPERATION: operation,
      CORE06_INPUT: JSON.stringify({ source: SOURCE, subject: 'actor-a', correlation: CORRELATION, issuedAt: NOW, expiresAt: HORIZON }),
      CORE06_REVOCATION: JSON.stringify(REVOCATION),
    },
    encoding: 'utf8',
    timeout: 60_000,
  });
  assert.equal(child.signal, 'SIGKILL', `the writer was killed, not closed: ${child.stderr}`);
  const line = child.stdout.trim().split('\n').at(-1) ?? '';
  const { acknowledged, grant } = JSON.parse(line) as { acknowledged: string; grant: BoundedGrant };
  return { grant, acknowledged };
}

describe('CORE-06 evidence — AGS §5 B / D, TM §7.16a row 1: a crash immediately after an acknowledgement loses nothing', () => {
  it('an acknowledged issuance is readable, field for field, after the writer is SIGKILLed', async () => {
    const file = dbPath('crash-after-issue');
    const { grant, acknowledged } = crashAfterAcknowledgement(file, 'issue');
    assert.equal(acknowledged, 'issued');
    assert.ok(existsSync(`${file}-wal`) || existsSync(file), 'the killed writer left its files as they were');
    const store = await openDurableStore(file);
    try {
      const read = await store.read(grant.id);
      assert.deepEqual(read.grant, grant);
      assert.equal(read.revocation, undefined);
    } finally {
      await store.close();
    }
  });

  it('an acknowledged revocation survives the writer being SIGKILLed: the grant stays revoked and the adapter is never reached', async () => {
    const file = dbPath('crash-after-revoke');
    const { grant, acknowledged } = crashAfterAcknowledgement(file, 'issue-then-revoke');
    assert.equal(acknowledged, 'revoked');
    const store = await openDurableStore(file);
    try {
      const read = await store.read(grant.id);
      assert.deepEqual(read.revocation, { grantId: grant.id, ...REVOCATION });
      const { adapter, outcome } = exercise(store, grant, 'exec-after-crash');
      assert.equal((await outcome).status, 'withheld');
      assert.equal(adapter.callCount, 0);
    } finally {
      await store.close();
    }
  });

  it('the power-loss half rests on SQLite: the store opens its connection in WAL with synchronous = FULL (a configuration claim, pinned)', () => {
    const source = readFileSync(join(process.cwd(), 'src/enterprise/bounded-grant-store/sqlite-bounded-grant-store.ts'), 'utf8');
    assert.match(source, /db\.pragma\('journal_mode = WAL'\)/);
    assert.match(source, /db\.pragma\('synchronous = FULL'\)/);
  });
});

// ── §5 C — a failure partway through the revocation transaction ─────────────

describe('CORE-06 evidence — AGS §5 C: a revocation that fails inside its transaction leaves no partial state', () => {
  it('the revocation row, the grant link and the commitment roll back together; the store stays verified and a genuine revocation still works', async () => {
    const genuine = testSigner(AUTHORITY_KEY_A);
    const attacker = testSigner(AUTHORITY_KEY_B);
    let lie = false;
    // A signer whose revocation-state signature is well-formed, names the
    // trusted key id and does not verify: the store's in-transaction read-back
    // refuses it *after* the revocation row and the grant's link are written.
    const signer: AuthorityArtifactSigner = {
      activeKeyId: AUTHORITY_KEY_A.keyId,
      algorithm: 'ed25519-v1',
      signGrant: (grant, storeId) => genuine.signGrant(grant, storeId),
      signRevocation: (revocation, storeId) => genuine.signRevocation(revocation, storeId),
      signRevocationState: async (state) => (lie ? { ...(await attacker.signRevocationState(state)), keyId: AUTHORITY_KEY_A.keyId } : genuine.signRevocationState(state)),
      signObligationDischargeState: (state) => genuine.signObligationDischargeState(state),
      signApprovalState: (state) => genuine.signApprovalState(state),
    };
    const file = dbPath('revoke-midway');
    const store = await openDurableStore(file, { authenticity: { signer, verifier: testVerifier([AUTHORITY_KEY_A]) } });
    try {
      const grant = await issueInto(store);
      const commitment = count(file, 'SELECT sequence AS n FROM bounded_grant_revocation_state');
      lie = true;
      await assert.rejects(() => store.revoke({ grantId: grant.id, ...REVOCATION }));
      assert.equal(count(file, 'SELECT COUNT(*) AS n FROM bounded_grant_revocations'), 0, 'no revocation row');
      assert.equal(count(file, 'SELECT COUNT(*) AS n FROM bounded_grants WHERE revocation_digest IS NOT NULL'), 0, 'no grant link');
      assert.equal(count(file, 'SELECT sequence AS n FROM bounded_grant_revocation_state'), commitment, 'the commitment did not advance');
      const read = await store.read(grant.id);
      assert.equal(read.revocation, undefined, 'the grant reads verified and unrevoked — nothing half-written');
      assert.equal((await store.health()).status, 'healthy');
      lie = false;
      assert.equal((await store.revoke({ grantId: grant.id, ...REVOCATION })).outcome, 'revoked');
    } finally {
      await store.close();
    }
  });
});

// ── §5 Q — concurrent exercise and revocation, one process ──────────────────

describe('CORE-06 evidence — AGS §5 Q: exercise racing a revocation in one process sees one state or the other, never a half', () => {
  it('while the revocation is still being signed it is not in force; once acknowledged, the next exercise is withheld', async () => {
    const genuine = testSigner(AUTHORITY_KEY_A);
    let release: () => void = () => {};
    let signing: () => void = () => {};
    const signingStarted = new Promise<void>((resolve) => (signing = resolve));
    const gate = new Promise<void>((resolve) => (release = resolve));
    const signer: AuthorityArtifactSigner = {
      activeKeyId: AUTHORITY_KEY_A.keyId,
      algorithm: 'ed25519-v1',
      signGrant: (grant, storeId) => genuine.signGrant(grant, storeId),
      signRevocation: (revocation, storeId) => genuine.signRevocation(revocation, storeId),
      signRevocationState: async (state) => {
        if (state.sequence > 0) {
          signing();
          await gate;
        }
        return genuine.signRevocationState(state);
      },
      signObligationDischargeState: (state) => genuine.signObligationDischargeState(state),
      signApprovalState: (state) => genuine.signApprovalState(state),
    };
    const file = dbPath('exercise-vs-revoke');
    const store = await openDurableStore(file, { authenticity: { signer, verifier: testVerifier([AUTHORITY_KEY_A]) } });
    try {
      const grant = await issueInto(store);
      const revoking = store.revoke({ grantId: grant.id, ...REVOCATION });
      await signingStarted;
      // Mid-revocation: nothing is committed, so the grant is exactly as it was.
      const during = exercise(store, grant, 'exec-during');
      assert.equal((await during.outcome).status, 'executed');
      assert.equal(during.adapter.callCount, 1);
      release();
      assert.equal((await revoking).outcome, 'revoked');
      const afterwards = exercise(store, grant, 'exec-after');
      assert.equal((await afterwards.outcome).status, 'withheld');
      assert.equal(afterwards.adapter.callCount, 0, 'no exercise after the acknowledgement');
    } finally {
      release();
      await store.close();
    }
  });
});

// ── §5 S — concurrent issuance of one identity on the durable store ─────────

describe('CORE-06 evidence — AGS §5 S: concurrent issuance of one identity on the durable store yields one grant', () => {
  it('two racing issuances — each past its preflight and its signing await — commit one row; the loser is already-issued with the identical grant', async () => {
    const file = dbPath('concurrent-issue');
    const store = await openDurableStore(file);
    try {
      const outcomes = await Promise.all([issueWith(store), issueWith(store), issueWith(store)]);
      const kinds = outcomes.map((outcome) => outcome.outcome).sort();
      assert.deepEqual(kinds, ['already-issued', 'already-issued', 'issued']);
      const grants = outcomes.map((outcome) => ('grant' in outcome ? outcome.grant : undefined));
      assert.ok(grants.every((grant) => grant !== undefined && grant.id === grants[0]?.id));
      assert.equal(count(file, 'SELECT COUNT(*) AS n FROM bounded_grants'), 1);
    } finally {
      await store.close();
    }
  });

  it('two store instances on one file racing the same identity also commit exactly one row', async () => {
    const file = dbPath('concurrent-issue-two-writers');
    const first = await openDurableStore(file);
    const second = await openDurableStore(file);
    try {
      const outcomes = await Promise.all([issueWith(first), issueWith(second)]);
      assert.deepEqual(outcomes.map((outcome) => outcome.outcome).sort(), ['already-issued', 'issued']);
      assert.equal(count(file, 'SELECT COUNT(*) AS n FROM bounded_grants'), 1);
    } finally {
      await first.close();
      await second.close();
    }
  });
});

// ── §5 W, §7.16a row 8 — database locked by another writer ──────────────────

describe('CORE-06 evidence — AGS §5 W, TM §7.16a row 8: a locked database fails closed for every write, and reads stay authoritative', () => {
  it('while another connection holds the write lock: revocation and issuance are refused and never acknowledged; exercise reads the last committed state — never a cache', async () => {
    const file = dbPath('locked');
    const store = await openDurableStore(file, { busyTimeoutMs: 50 });
    const live = await issueInto(store);
    const doomed = await issueInto(store, { ...CORRELATION, requestId: 'req-core06-doomed' });
    // Revoked and committed before the lock: must stay unusable while locked.
    assert.equal((await store.revoke({ grantId: doomed.id, ...REVOCATION })).outcome, 'revoked');
    const locker = new Database(file);
    try {
      locker.exec('BEGIN EXCLUSIVE');
      await assert.rejects(() => store.revoke({ grantId: live.id, ...REVOCATION }), 'a revocation is never acknowledged without its commit');
      await assert.rejects(() => issueInto(store, { ...CORRELATION, requestId: 'req-core06-2' }), 'an issuance is never acknowledged without its commit');
      // WAL: a held write lock does not block readers. The exercise path reads
      // the last *committed* authoritative state — the revoked grant stays
      // revoked, the live one (whose revocation was just refused, and so never
      // acknowledged) stays live. No last-known-good, no memory fallback.
      const revoked = exercise(store, doomed, 'exec-locked-revoked');
      assert.equal((await revoked.outcome).status, 'withheld');
      assert.equal(revoked.adapter.callCount, 0, 'a lock never resurrects a committed revocation');
      assert.equal((await exercise(store, live, 'exec-locked-live').outcome).status, 'executed', 'the committed state is what is read');
    } finally {
      if (locker.inTransaction) locker.exec('ROLLBACK');
      locker.close();
    }
    try {
      const read = await store.read(live.id);
      assert.equal(read.revocation, undefined, 'the refused revocation left nothing behind');
      assert.equal((await store.revoke({ grantId: live.id, ...REVOCATION })).outcome, 'revoked', 'and once the lock is gone the store works');
    } finally {
      await store.close();
    }
  });

  it('a store that cannot answer a read — here, closed — withholds: the adapter is not called', async () => {
    const file = dbPath('closed');
    const store = await openDurableStore(file);
    const grant = await issueInto(store);
    await store.close();
    const { adapter, outcome } = exercise(store, grant, 'exec-closed');
    assert.equal((await outcome).status, 'withheld');
    assert.equal(adapter.callCount, 0);
  });
});

// ── §7.16e — same-sequence fork under a running approval store ──────────────

describe('CORE-06 evidence — TM §7.16e "same-sequence fork": the approval store’s in-process witness refuses it at runtime', () => {
  it('a different genuine state at the same sequence, transplanted under the running store, is refused and never reads as approved', async () => {
    const clock = new Clock();
    const open = async (file: string): Promise<ApprovalStore> => createSqliteApprovalStore(file, { now: clock.now, organizationId: APPROVAL_ORG, authenticity: testAuthenticity() });
    const file = dbPath('approvals');
    const store = await open(file);
    const stores: ApprovalStore[] = [store];
    try {
      const authority = authorityOver(store, { clock });
      const command = await opened(authority);
      // Snapshot of the requested state, before any verdict.
      await store.close();
      const requested = dbPath('approvals-requested');
      for (const suffix of ['', '-wal', '-shm']) if (existsSync(`${file}${suffix}`)) copyFileSync(`${file}${suffix}`, `${requested}${suffix}`);
      const running = await open(file);
      stores.push(running);
      const live = authorityOver(running, { clock });
      // The running store has seen sequence N as **rejected** ...
      await live.approve(actor('approver-a'), command);
      await live.reject(actor('approver-c'), command);
      assert.deepEqual(await live.assess(target()), { kind: 'withheld', status: 'rejected' });
      const headOf = (path: string) => {
        const db = new Database(path, { readonly: true });
        try {
          return db.prepare('SELECT sequence, chain_digest, signature_json FROM approval_head').get() as { sequence: number; chain_digest: string; signature_json: string };
        } finally {
          db.close();
        }
      };
      const seen = headOf(file);

      // ... and a rogue holder of the key, from the same requested state,
      // commits a different genuine successor at the same sequence: an
      // **approved** one — the direction in which a fork would permit.
      const rogue = await open(requested);
      stores.push(rogue);
      const rogueAuthority = authorityOver(rogue, { clock });
      await rogueAuthority.approve(actor('approver-a'), command);
      await rogueAuthority.approve(actor('approver-b'), command);
      assert.equal((await rogueAuthority.assess(target())).kind, 'approved', 'on its own the fork is a genuine approved state');
      await rogue.close();
      const fork = headOf(requested);
      assert.equal(fork.sequence, seen.sequence, 'the fork is at the same sequence');
      assert.notEqual(fork.chain_digest, seen.chain_digest, 'with a different committed state');

      // Transplanted underneath the running store.
      const source = new Database(requested, { readonly: true });
      const rows = source.prepare('SELECT * FROM approval_records ORDER BY sequence').all() as Record<string, unknown>[];
      source.close();
      const target_ = new Database(file);
      target_.exec('DROP TRIGGER IF EXISTS approval_records_no_update; DROP TRIGGER IF EXISTS approval_records_no_delete;');
      target_.prepare('DELETE FROM approval_records').run();
      for (const row of rows) target_.prepare(`INSERT INTO approval_records (${Object.keys(row).join(', ')}) VALUES (${Object.keys(row).map(() => '?').join(', ')})`).run(...Object.values(row));
      target_.prepare('UPDATE approval_head SET sequence = ?, chain_digest = ?, signature_json = ?').run(fork.sequence, fork.chain_digest, fork.signature_json);
      target_.close();

      // The store refuses to read it at all ...
      await assert.rejects(() => running.read(APPROVAL_ORG, target().request.requestId), (error: unknown) => error instanceof Error && /different committed state at the same sequence/.test(error.message));
      // ... so the approval authority answers fail-closed, never `approved`.
      assert.deepEqual(await live.assess(target()), { kind: 'withheld', status: 'unavailable' });
    } finally {
      for (const each of stores) await each.close().catch(() => {});
    }
  });
});
