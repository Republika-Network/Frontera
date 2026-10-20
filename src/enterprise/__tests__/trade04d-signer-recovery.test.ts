import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { inspectReferenceCapabilityLedger, openReferenceCapabilityLedger } from '../xrpl-trade-rail/reference/reference-capability-ledger.js';
import { initializeReferenceCapabilityLedger, startReferenceDelegatedOfferSigner } from '../xrpl-trade-rail/reference/reference-delegated-offer-signer.js';
import { s1ReferenceOptions } from './trade04c-s1-capability-fixture.js';
import { testDelegate, testAccount } from './trade04b-xrpl-fixture.js';

/**
 * TRADE-04D §4 — signer v2 recovery on the customer-operated reference
 * signer's capability ledger (S-1): never recreated implicitly, refused when
 * not a sound ledger, read for recovery without writing, and permanent in
 * every consumed state across restarts. The Host never opens this file; the
 * signer's operator reads it (`inspect-capability`) and hands the report over.
 */

const dir = mkdtempSync(join(tmpdir(), 'trade04d-signer-'));
after(() => rmSync(dir, { recursive: true, force: true }));
let n = 0;
const fresh = (): string => join(dir, `ledger-${(n += 1)}.sqlite`);
const entry = (capabilityId: string, executionId: string) => ({ capabilityId, executionId, boundedGrantId: 'grant-d', signingPreimageDigest: `sha256:${'1'.repeat(64)}`, expiresAt: new Date(Date.now() - 1_000).toISOString() });
const HASH = 'C'.repeat(64);

describe('TRADE-04D S-1 — a missing ledger is never recreated', () => {
  it('opening a missing ledger is refused (no file is created); only an explicit create, or initialization, makes one', async () => {
    const path = fresh();
    await assert.rejects(openReferenceCapabilityLedger(path), /never recreated implicitly/);
    assert.equal(existsSync(path), false, 'nothing was created by the refusal');
    (await openReferenceCapabilityLedger(path, { create: true })).close();
    assert.equal(existsSync(path), true);
  });

  it('the signer refuses to start over a missing ledger; a deleted ledger is not silently replaced by an empty one', async () => {
    const path = fresh();
    await initializeReferenceCapabilityLedger(path);
    const ledger = await openReferenceCapabilityLedger(path);
    ledger.consume(entry('cap-1', 'exec-1'), new Date().toISOString());
    ledger.close();
    for (const suffix of ['', '-wal', '-shm']) rmSync(`${path}${suffix}`, { force: true });
    const world = { owner: testAccount(), delegate: testDelegate() };
    const { consumption: _unused, ...s1 } = s1ReferenceOptions();
    await assert.rejects(startReferenceDelegatedOfferSigner({ ...s1, consumptionLedgerPath: path, signerId: 'trade04d-signer', network: 'xrp-ledger-testnet', credential: 'FRONTERA_TRADE04D_SIGNER_TOKEN_0123456789abcdef', keys: [{ ownerAccount: world.owner, delegateSeed: world.delegate.seed }], maximumFeeDrops: '100' }), /never recreated implicitly/);
    assert.equal(existsSync(path), false);
  });

  it('initialization refuses anything already at the path: it never replaces, resets or adopts a ledger', async () => {
    const path = fresh();
    await initializeReferenceCapabilityLedger(path);
    await assert.rejects(initializeReferenceCapabilityLedger(path), /already exists/);
  });

  it('a file that is not an initialized ledger, or fails the integrity check, is refused — never repaired', async () => {
    const empty = fresh();
    writeFileSync(empty, '');
    await assert.rejects(openReferenceCapabilityLedger(empty), /not an initialized ledger/);
    const garbage = fresh();
    writeFileSync(garbage, Buffer.concat([Buffer.from('SQLite format 3\0'), Buffer.alloc(4_096, 0x5a)]));
    await assert.rejects(openReferenceCapabilityLedger(garbage));
    await assert.rejects(openReferenceCapabilityLedger(garbage, { create: true }), Error, 'create never overrides a damaged file');
  });
});

describe('TRADE-04D §4 — consumed states are permanent across restarts; the recovery read is fail-closed', () => {
  it('consumed (no hash), signed and signing-failed survive a restart unchanged; none is reusable; inspect reports each', async () => {
    const path = fresh();
    await initializeReferenceCapabilityLedger(path);
    const ledger = await openReferenceCapabilityLedger(path);
    ledger.consume(entry('cap-consumed', 'exec-consumed'), new Date().toISOString());
    ledger.consume(entry('cap-signed', 'exec-signed'), new Date().toISOString());
    ledger.markSigned('cap-signed', HASH);
    ledger.consume(entry('cap-failed', 'exec-failed'), new Date().toISOString());
    ledger.markFailed('cap-failed');
    ledger.close();

    const restarted = await openReferenceCapabilityLedger(path);
    try {
      assert.deepEqual(restarted.inspect('exec-consumed'), { source: 'customer-signer-ledger', executionId: 'exec-consumed', state: 'consumed', capabilityId: 'cap-consumed' });
      assert.deepEqual(restarted.inspect('exec-signed'), { source: 'customer-signer-ledger', executionId: 'exec-signed', state: 'signed', capabilityId: 'cap-signed', transactionHash: HASH });
      assert.deepEqual(restarted.inspect('exec-failed'), { source: 'customer-signer-ledger', executionId: 'exec-failed', state: 'signing-failed', capabilityId: 'cap-failed' });
      assert.deepEqual(restarted.inspect('exec-none'), { source: 'customer-signer-ledger', executionId: 'exec-none', state: 'absent' });
      // Never signed again; never reusable; a replacement capability for the execution is refused too.
      for (const [capabilityId, executionId] of [['cap-consumed', 'exec-consumed'], ['cap-signed', 'exec-signed'], ['cap-failed', 'exec-failed']] as const) {
        assert.equal(restarted.consume(entry(capabilityId, executionId), new Date().toISOString()), 'capability-consumed');
        assert.equal(restarted.consume(entry(`${capabilityId}-replacement`, executionId), new Date().toISOString()), 'execution-consumed');
      }
      restarted.markSigned('cap-failed', HASH);
      restarted.markSigned('cap-signed', 'D'.repeat(64));
      assert.equal(restarted.inspect('exec-failed').state, 'signing-failed', 'signing-failed stays failed');
      assert.equal((restarted.inspect('exec-signed') as { transactionHash: string }).transactionHash, HASH, 'a signed hash is never rewritten');
      assert.deepEqual(restarted.counts(), { consumed: 1, signed: 1, 'signing-failed': 1 });
    } finally {
      restarted.close();
    }
  });

  it('an expired capability is still consumed: expiry establishes nothing about a signature or a submission', async () => {
    const path = fresh();
    await initializeReferenceCapabilityLedger(path);
    const ledger = await openReferenceCapabilityLedger(path);
    ledger.consume(entry('cap-expired', 'exec-expired'), new Date().toISOString());
    ledger.close();
    assert.equal((await inspectReferenceCapabilityLedger(path, 'exec-expired')).state, 'consumed');
  });

  it('inspectReferenceCapabilityLedger never creates or writes, and answers unavailable — never absent — when the ledger cannot be read', async () => {
    const missing = fresh();
    assert.deepEqual(await inspectReferenceCapabilityLedger(missing, 'exec-1'), { source: 'customer-signer-ledger', executionId: 'exec-1', state: 'unavailable' });
    assert.equal(existsSync(missing), false);
    const garbage = fresh();
    writeFileSync(garbage, 'not a database');
    assert.equal((await inspectReferenceCapabilityLedger(garbage, 'exec-1')).state, 'unavailable');
    const foreign = fresh();
    const { default: Database } = await import('better-sqlite3');
    const db = new Database(foreign);
    db.exec('CREATE TABLE capability_ledger_versions (id INTEGER PRIMARY KEY, schema_version TEXT); INSERT INTO capability_ledger_versions VALUES (1, \'other.v9\'); CREATE TABLE consumed_capabilities (capability_id TEXT);');
    db.close();
    assert.equal((await inspectReferenceCapabilityLedger(foreign, 'exec-1')).state, 'unavailable', 'another schema is not this ledger');
    const sound = fresh();
    await initializeReferenceCapabilityLedger(sound);
    const before = (await import('node:fs')).statSync(sound).mtimeMs;
    assert.equal((await inspectReferenceCapabilityLedger(sound, 'exec-1')).state, 'absent');
    assert.equal((await import('node:fs')).statSync(sound).mtimeMs, before, 'query-only');
  });

  it('a stale restore is invisible to the ledger itself (no anchor): it reads as authoritative-looking "absent" — which is why the Host treats it as a hint only', async () => {
    const path = fresh();
    await initializeReferenceCapabilityLedger(path);
    copyFileSync(path, `${path}.backup`);
    const ledger = await openReferenceCapabilityLedger(path);
    ledger.consume(entry('cap-r', 'exec-r'), new Date().toISOString());
    ledger.markSigned('cap-r', HASH);
    ledger.close();
    for (const suffix of ['-wal', '-shm']) rmSync(`${path}${suffix}`, { force: true });
    copyFileSync(`${path}.backup`, path);
    const reopened = await openReferenceCapabilityLedger(path);
    try {
      assert.equal(reopened.inspect('exec-r').state, 'absent', 'SQLite durability does not detect a restore of an older copy');
    } finally {
      reopened.close();
    }
  });
});

describe('TRADE-04D S-1 — the launcher’s explicit ledger commands (separate process)', () => {
  const launcher = join(process.cwd(), 'scripts', 'run-reference-xrpl-offer-signer.mjs');
  const run = (args: readonly string[], ledgerPath: string) => spawnSync(process.execPath, [launcher, ...args], { env: { PATH: process.env['PATH'] ?? '', FRONTERA_REFERENCE_XRPL_OFFER_SIGNER_CONSUMPTION_LEDGER: ledgerPath }, encoding: 'utf8' });

  it('init-consumption-ledger creates once and refuses a second time; inspect-capability reads without writing; serving needs the key file and an existing ledger', async () => {
    const path = fresh();
    const absent = run(['inspect-capability', 'exec-x'], path);
    assert.equal(absent.status, 0);
    assert.deepEqual(JSON.parse(absent.stdout), { source: 'customer-signer-ledger', executionId: 'exec-x', state: 'unavailable' });
    assert.equal(existsSync(path), false);
    assert.equal(run(['init-consumption-ledger'], path).status, 0);
    assert.notEqual(run(['init-consumption-ledger'], path).status, 0, 'never re-initialized');
    const ledger = await openReferenceCapabilityLedger(path);
    ledger.consume(entry('cap-l', 'exec-l'), new Date().toISOString());
    ledger.markSigned('cap-l', HASH);
    ledger.close();
    const inspected = run(['inspect-capability', 'exec-l'], path);
    assert.deepEqual(JSON.parse(inspected.stdout), { source: 'customer-signer-ledger', executionId: 'exec-l', state: 'signed', capabilityId: 'cap-l', transactionHash: HASH });
    assert.equal(/seed|secret|token|credential/i.test(inspected.stdout + inspected.stderr), false);
    assert.notEqual(run(['inspect-capability'], path).status, 0, 'exactly one execution id');
  });
});
