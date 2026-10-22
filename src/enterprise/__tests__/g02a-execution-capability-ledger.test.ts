import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { Worker } from 'node:worker_threads';
import assert from 'node:assert/strict';

import type { ExecutionCapabilityVerification } from '../execution-capability/index.js';
import { openExecutionCapabilityConsumptionLedger, type ExecutionCapabilityConsumptionLedger } from '../execution-capability/reference/consumption-ledger.js';
import { AUTHORITY_KEY_A, trustedKeyOf } from './authority-authenticity-fixture.js';
import { G02A_AUDIENCE, G02A_ISSUER, G02A_ORGANIZATION, G02A_OTHER_ISSUER, G02A_TRUST_DOMAIN, NOW, capabilityFor, issuerPinning, present, requestFor, signCapability, verifierFor } from './g02a-execution-capability-fixture.js';

/**
 * G-02A — the reference durable consumption ledger. Single use is a property
 * of one ledger file (one consumption domain, one audience); a claim commits
 * before any side effect; nothing moves backwards; uncertainty stays visible.
 * No live side effect is performed: the "executor" here is a counter.
 */

const workDir = mkdtempSync(join(tmpdir(), 'aoc-g02a-ledger-'));
after(() => rmSync(workDir, { recursive: true, force: true }));
let files = 0;
const freshPath = (): string => join(workDir, `ledger-${(files += 1)}.sqlite`);

const ledgers: ExecutionCapabilityConsumptionLedger[] = [];
after(() => {
  for (const ledger of ledgers) ledger.close();
});

async function createLedger(path: string = freshPath(), options: { readonly audience?: string; readonly clock?: () => number } = {}): Promise<ExecutionCapabilityConsumptionLedger> {
  const ledger = await openExecutionCapabilityConsumptionLedger(path, { audience: options.audience ?? G02A_AUDIENCE, clock: options.clock ?? (() => NOW), create: true });
  ledgers.push(ledger);
  return ledger;
}

async function reopen(path: string, options: { readonly audience?: string; readonly clock?: () => number } = {}): Promise<ExecutionCapabilityConsumptionLedger> {
  const ledger = await openExecutionCapabilityConsumptionLedger(path, { audience: options.audience ?? G02A_AUDIENCE, clock: options.clock ?? (() => NOW) });
  ledgers.push(ledger);
  return ledger;
}

const verify = (overrides: Parameters<typeof capabilityFor>[0] = {}): ExecutionCapabilityVerification => verifierFor().verify(requestFor(present(capabilityFor(overrides))));

async function rawDb(path: string): Promise<import('better-sqlite3').Database> {
  const { default: Database } = await import('better-sqlite3');
  return new Database(path, { fileMustExist: true });
}

describe('G-02A ledger — single use within one consumption domain', () => {
  it('a verified capability is claimed once; the same verification, or a re-verification, is refused afterwards', async () => {
    const ledger = await createLedger();
    const capability = capabilityFor();
    const presentation = present(capability);
    const first = verifierFor().verify(requestFor(presentation));
    const claim = ledger.claim(first);
    assert.equal(claim.outcome, 'claimed');
    assert.deepEqual(ledger.claim(first), { outcome: 'refused', reason: 'CAPABILITY_CONSUMED' });
    assert.deepEqual(ledger.claim(verifierFor().verify(requestFor(presentation))), { outcome: 'refused', reason: 'CAPABILITY_CONSUMED' });
  });

  it('a second capability for the same issuer execution is refused; the same execution id from another issuer is another execution', async () => {
    const ledger = await createLedger();
    const executionId = 'aoc.exec:shared-execution';
    assert.equal(ledger.claim(verify({ executionId })).outcome, 'claimed');
    assert.deepEqual(ledger.claim(verify({ executionId })), { outcome: 'refused', reason: 'EXECUTION_CONSUMED' });
    const twoIssuers = verifierFor({ trustedIssuers: [issuerPinning([AUTHORITY_KEY_A]), { issuer: G02A_OTHER_ISSUER, keys: [{ ...trustedKeyOf(AUTHORITY_KEY_A), keyId: 'issuer-2-key' }] }] });
    // Issuer 2 pins the same public material under another id: a distinct issuer, a distinct execution namespace.
    const other = capabilityFor({ executionId, issuer: G02A_OTHER_ISSUER, issuerKeyId: 'issuer-2-key' });
    const otherPresentation = { capability: present(other).capability, signature: signCapability(other, AUTHORITY_KEY_A, 'issuer-2-key') };
    assert.equal(ledger.claim(twoIssuers.verify(requestFor(otherPresentation))).outcome, 'claimed');
  });

  it('only a verified result of this runtime’s verifier is claimable — never a rejection, never a shape-alike copy', async () => {
    const ledger = await createLedger();
    const rejection = verifierFor().verify(requestFor(present(capabilityFor({ audience: 'executor-other' }))));
    assert.equal(rejection.verification, 'rejected');
    assert.deepEqual(ledger.claim(rejection), { outcome: 'refused', reason: 'NOT_VERIFIED' });
    const genuine = verify();
    assert.deepEqual(ledger.claim({ ...genuine }), { outcome: 'refused', reason: 'NOT_VERIFIED' });
    assert.deepEqual(ledger.claim(JSON.parse(JSON.stringify(genuine)) as unknown), { outcome: 'refused', reason: 'NOT_VERIFIED' });
    assert.deepEqual(ledger.claim(undefined), { outcome: 'refused', reason: 'NOT_VERIFIED' });
    assert.equal(ledger.claim(genuine).outcome, 'claimed');
  });

  it('an online-status-required capability is never claimable while status is unavailable', async () => {
    const ledger = await createLedger();
    const result = verify({ statusRequirement: 'online-status-required' });
    assert.equal(result.verification, 'verified');
    assert.deepEqual(ledger.claim(result), { outcome: 'refused', reason: 'STATUS_REQUIRED_UNAVAILABLE' });
  });

  it('a ledger consumes for its own audience only', async () => {
    const ledger = await createLedger(freshPath(), { audience: 'executor-data-worker' });
    assert.deepEqual(ledger.claim(verify()), { outcome: 'refused', reason: 'AUDIENCE_MISMATCH' });
  });

  it('expiry is re-checked at claim time, against the ledger’s clock', async () => {
    const capability = capabilityFor();
    const result = verifierFor().verify(requestFor(present(capability)));
    const late = await createLedger(freshPath(), { clock: () => Date.parse(capability.expiresAt) });
    assert.deepEqual(late.claim(result), { outcome: 'refused', reason: 'CAPABILITY_EXPIRED' });
    const broken = await createLedger(freshPath(), { clock: () => Number.NaN });
    assert.deepEqual(broken.claim(result), { outcome: 'refused', reason: 'CAPABILITY_EXPIRED' });
  });
});

describe('G-02A ledger — durability: restart, no implicit reset, a pinned identity', () => {
  it('a consumption survives a restart', async () => {
    const path = freshPath();
    const presentation = present(capabilityFor());
    const first = await createLedger(path);
    assert.equal(first.claim(verifierFor().verify(requestFor(presentation))).outcome, 'claimed');
    first.close();
    const again = await reopen(path);
    assert.deepEqual(again.claim(verifierFor().verify(requestFor(presentation))), { outcome: 'refused', reason: 'CAPABILITY_CONSUMED' });
  });

  it('a missing ledger is never recreated, and an existing one is never re-initialized', async () => {
    const path = freshPath();
    await assert.rejects(reopen(path), /never recreated implicitly/);
    const ledger = await createLedger(path);
    ledger.close();
    await assert.rejects(createLedger(path), /never re-initialized/);
    const empty = freshPath();
    writeFileSync(empty, '');
    await assert.rejects(createLedger(empty), /never re-initialized/);
    await assert.rejects(openExecutionCapabilityConsumptionLedger(':memory:', { audience: G02A_AUDIENCE, clock: () => NOW, create: true }), /durable file path/);
  });

  it('a ledger pinned to another audience, a foreign file and a ledger stripped of its triggers are refused', async () => {
    const path = freshPath();
    (await createLedger(path)).close();
    await assert.rejects(reopen(path, { audience: 'executor-data-worker' }), /pinned to another audience/);
    const foreign = freshPath();
    const { default: Database } = await import('better-sqlite3');
    const other = new Database(foreign);
    other.exec('CREATE TABLE something (id INTEGER)');
    other.close();
    await assert.rejects(reopen(foreign), /not an initialized ledger/);
    const stripped = await rawDb(path);
    stripped.exec('DROP TRIGGER execution_capability_consumptions_forward_only');
    stripped.close();
    await assert.rejects(reopen(path), /missing its integrity triggers/);
  });

  it('a wildcard or missing audience and a missing clock are refused at open', async () => {
    await assert.rejects(openExecutionCapabilityConsumptionLedger(freshPath(), { audience: '*', clock: () => NOW, create: true }), /exactly one audience/);
    await assert.rejects(openExecutionCapabilityConsumptionLedger(freshPath(), { audience: G02A_AUDIENCE, clock: undefined as never, create: true }), /needs a clock/);
  });
});

describe('G-02A ledger — outcomes move forward only, and uncertainty is explicit', () => {
  it('claimed is not an outcome; outcome-unknown may resolve; nothing moves back', async () => {
    const ledger = await createLedger();
    const result = verify();
    const claim = ledger.claim(result);
    assert.equal(claim.outcome, 'claimed');
    const capabilityId = claim.outcome === 'claimed' ? claim.capabilityId : '';
    const record = ledger.read(capabilityId);
    assert.equal(record.state, 'claimed');
    assert.equal(record.state !== 'absent' && record.outcomeRecorded, false);
    assert.equal(ledger.recordOutcome(capabilityId, 'outcome-unknown'), 'recorded');
    assert.equal(ledger.recordOutcome(capabilityId, 'outcome-unknown'), 'not-forward');
    assert.equal(ledger.recordOutcome(capabilityId, 'completed'), 'recorded');
    assert.equal(ledger.recordOutcome(capabilityId, 'failed'), 'not-forward');
    assert.equal(ledger.recordOutcome(capabilityId, 'outcome-unknown'), 'not-forward');
    assert.equal(ledger.read(capabilityId).state, 'completed');
    assert.equal(ledger.recordOutcome('f'.repeat(64), 'completed'), 'not-claimed');
    assert.throws(() => ledger.recordOutcome(capabilityId, 'claimed' as never));
    // Still consumed in every state.
    assert.deepEqual(ledger.claim(result), { outcome: 'refused', reason: 'CAPABILITY_CONSUMED' });
  });

  it('the database itself refuses deletion, backward moves, rewritten identity and a changed audience', async () => {
    const path = freshPath();
    const ledger = await createLedger(path);
    const claim = ledger.claim(verify());
    assert.equal(claim.outcome, 'claimed');
    const id = claim.outcome === 'claimed' ? claim.capabilityId : '';
    ledger.recordOutcome(id, 'failed');
    const db = await rawDb(path);
    try {
      assert.throws(() => db.prepare('DELETE FROM execution_capability_consumptions WHERE capability_id = ?').run(id), /permanent/);
      assert.throws(() => db.prepare(`UPDATE execution_capability_consumptions SET state = 'claimed' WHERE capability_id = ?`).run(id), /only moves forward/);
      assert.throws(() => db.prepare(`UPDATE execution_capability_consumptions SET execution_id = 'aoc.exec:other' WHERE capability_id = ?`).run(id), /only moves forward/);
      assert.throws(() => db.prepare(`UPDATE execution_capability_ledger_meta SET audience = 'executor-other'`).run(), /fixed/);
      assert.throws(() => db.prepare('DELETE FROM execution_capability_ledger_meta').run(), /fixed/);
    } finally {
      db.close();
    }
  });
});

describe('G-02A ledger — a simulated executor: claim before the side effect, never twice', () => {
  /** The executor's loop: verify, claim, then (and only then) act. */
  function execute(ledger: ExecutionCapabilityConsumptionLedger, presentation: unknown, sideEffects: { count: number }, crash = false): string {
    const result = verifierFor().verify(requestFor(presentation));
    if (result.verification !== 'verified') return `rejected:${result.failure}`;
    const claim = ledger.claim(result);
    if (claim.outcome !== 'claimed') return `refused:${claim.reason}`;
    sideEffects.count += 1;
    if (crash) return 'crashed';
    ledger.recordOutcome(claim.capabilityId, 'completed');
    return 'completed';
  }

  it('retry after a timeout does not act twice', async () => {
    const ledger = await createLedger();
    const presentation = present(capabilityFor());
    const sideEffects = { count: 0 };
    assert.equal(execute(ledger, presentation, sideEffects), 'completed');
    assert.equal(execute(ledger, presentation, sideEffects), 'refused:CAPABILITY_CONSUMED');
    assert.equal(sideEffects.count, 1);
  });

  it('a crash after acting and before recording leaves the capability consumed and the outcome visibly unrecorded', async () => {
    const path = freshPath();
    const capability = capabilityFor();
    const presentation = present(capability);
    const sideEffects = { count: 0 };
    const before = await createLedger(path);
    assert.equal(execute(before, presentation, sideEffects, true), 'crashed');
    before.close();
    const restarted = await reopen(path);
    const record = restarted.readExecution(G02A_ISSUER, capability.executionId);
    assert.equal(record.state, 'claimed');
    assert.equal(record.state !== 'absent' && record.outcomeRecorded, false, 'authorized and possibly attempted, outcome not recorded');
    assert.equal(execute(restarted, presentation, sideEffects), 'refused:CAPABILITY_CONSUMED');
    assert.equal(sideEffects.count, 1);
  });

  it('two executor instances with separate ledgers are separate consumption domains — the documented limit', async () => {
    const presentation = present(capabilityFor());
    const sideEffects = { count: 0 };
    assert.equal(execute(await createLedger(), presentation, sideEffects), 'completed');
    assert.equal(execute(await createLedger(), presentation, sideEffects), 'completed');
    assert.equal(sideEffects.count, 2, 'single use is global only across instances that share one ledger');
  });
});

describe('G-02A ledger — concurrent claims fail closed', () => {
  it('two connections to one file: exactly one claim succeeds', async () => {
    const path = freshPath();
    const one = await createLedger(path);
    const two = await reopen(path);
    const result = verify();
    const outcomes = [one.claim(result), two.claim(result)].map((claim) => (claim.outcome === 'claimed' ? 'claimed' : claim.reason));
    assert.deepEqual(outcomes.sort(), ['CAPABILITY_CONSUMED', 'claimed']);
  });

  it('four threads released at one instant against one file: exactly one claim succeeds', async () => {
    const path = freshPath();
    (await createLedger(path)).close();
    const presentation = present(capabilityFor());
    const threads = 4;
    const barrier = new Int32Array(new SharedArrayBuffer(4));
    const root = join(__dirname, '..', 'execution-capability');
    const source = `
      const { parentPort, workerData } = require('node:worker_threads');
      const { createExecutionCapabilityVerifier } = require(workerData.verifierModule);
      const { openExecutionCapabilityConsumptionLedger } = require(workerData.ledgerModule);
      (async () => {
        const verifier = createExecutionCapabilityVerifier({ trustedIssuers: workerData.trustedIssuers, executor: workerData.executor, clock: () => workerData.now });
        const ledger = await openExecutionCapabilityConsumptionLedger(workerData.path, { audience: workerData.executor.audience, clock: () => workerData.now });
        const result = verifier.verify(workerData.request);
        Atomics.add(workerData.barrier, 0, 1);
        while (Atomics.load(workerData.barrier, 0) < workerData.threads) Atomics.wait(workerData.barrier, 0, Atomics.load(workerData.barrier, 0), 5);
        const claim = ledger.claim(result);
        ledger.close();
        parentPort.postMessage(claim.outcome === 'claimed' ? 'claimed' : claim.reason);
      })().catch((error) => parentPort.postMessage('error:' + String(error && error.message)));
    `;
    const workerData = {
      verifierModule: join(root, 'verifier.js'),
      ledgerModule: join(root, 'reference', 'consumption-ledger.js'),
      trustedIssuers: [issuerPinning()],
      executor: { audience: G02A_AUDIENCE, organizationIds: [G02A_ORGANIZATION], trustDomain: G02A_TRUST_DOMAIN },
      now: NOW,
      path,
      request: requestFor(presentation),
      barrier,
      threads,
    };
    const outcomes = await Promise.all(
      Array.from({ length: threads }, () => new Promise<string>((resolve, reject) => {
        const worker = new Worker(source, { eval: true, workerData });
        worker.once('message', (message: unknown) => {
          resolve(String(message));
          void worker.terminate();
        });
        worker.once('error', reject);
      })),
    );
    assert.deepEqual(outcomes.sort(), ['CAPABILITY_CONSUMED', 'CAPABILITY_CONSUMED', 'CAPABILITY_CONSUMED', 'claimed'], outcomes.join(', '));
  });
});
