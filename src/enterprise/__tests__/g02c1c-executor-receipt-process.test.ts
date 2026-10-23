import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { parseExecutorReceipt } from '../executor-receipt/index.js';
import { openExecutorReceiptLedger } from '../reference-executor/receipt-ledger.js';
import {
  AUDIENCE,
  BEARER,
  EXECUTOR_ENVIRONMENT,
  EXECUTOR_ID,
  ISSUER_KEY,
  captureHostBytes,
  exchange,
  hostVector,
  parseRaw,
  rawExchange,
  refusedStart,
  serializeRaw,
  spawnExecutor,
  withPresentation,
  type RawRequest,
  type SpawnedExecutor,
} from './g02c1a-reference-executor-fixture.js';
import { presentedWith, syntheticCapability } from './g02c1b-synthetic-execution-fixture.js';
import { BINDING_FORMAT, RECEIPT_KEY_ID, generateReceiptKey, receiptConfiguration, receiptDomain, type ReceiptDomain } from './g02c1c-executor-receipt-fixture.js';

/**
 * G-02C1C across real processes. The executor process holds its receipt key
 * (made by a separate key-generation process); this process holds only the
 * public half and verifies with the standalone verifier. It never loads the
 * private key. Loopback, synthetic, CI only.
 */

const VECTOR = hostVector('POST with body and headers', {
  body: { kind: 'json-object', fields: { subject: { kind: 'source', source: 'subject' }, amount: { kind: 'source', source: 'amount.value' } } },
  headers: { 'X-Release-Channel': { kind: 'literal', value: 'stable' } },
});
const FAULT_VARIABLE = 'FRONTERA_REFERENCE_EXECUTOR_FAULT_INJECTION';

const domains: ReceiptDomain[] = [];
const executors: SpawnedExecutor[] = [];
let base: RawRequest;

before(async () => {
  base = parseRaw(await captureHostBytes(withPresentation(VECTOR.request, syntheticCapability(VECTOR.digest).presentation)));
});
after(async () => {
  await Promise.all(executors.map((executor) => executor.kill()));
  for (const domain of domains) domain.cleanup();
});

async function domainOf(): Promise<ReceiptDomain> {
  const domain = await receiptDomain();
  domains.push(domain);
  return domain;
}
async function executorOver(domain: ReceiptDomain, overrides: Record<string, unknown> = {}, extra: Readonly<Record<string, string>> = {}): Promise<SpawnedExecutor> {
  const executor = await spawnExecutor(receiptConfiguration(domain, overrides), { ...EXECUTOR_ENVIRONMENT, ...extra });
  executors.push(executor);
  return executor;
}
const bytesFor = (presentation: string): Buffer => serializeRaw(presentedWith(base, presentation));

/** Waits until the executor has written `count` receipt lines. */
async function receiptLines(executor: SpawnedExecutor, count: number, timeoutMs = 5_000): Promise<readonly Record<string, unknown>[]> {
  const limit = Date.now() + timeoutMs;
  for (;;) {
    const lines = executor
      .stdout()
      .split('\n')
      .filter((line) => line.includes('"event":"receipt"'))
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    if (lines.length >= count) return lines;
    assert.ok(Date.now() < limit, `expected ${count} receipt lines`);
    await new Promise((settle) => setTimeout(settle, 50));
  }
}

describe('G-02C1C process — signed in the executor, verified here with the public key only', () => {
  it('a completed synthetic execution is receipted by the executor process; this process verifies it, and refuses it altered', async () => {
    const domain = await domainOf();
    const executor = await executorOver(domain);
    const { capability, presentation } = syntheticCapability(VECTOR.digest);
    const { response } = await exchange(executor, bytesFor(presentation));
    assert.equal(response.status, 201);
    const [line] = await receiptLines(executor, 1);
    assert.deepEqual(line, { event: 'receipt', status: 'issued', sequence: 1, outcome: 'completed-observed' });
    const history = await domain.history(capability.capabilityId);
    assert.equal(history.length, 1);
    const presented = history[0] as { readonly receipt: string; readonly signature: Readonly<Record<string, string>> };
    const verified = domain.verifier.verify(presented, { expected: { executorId: EXECUTOR_ID, capabilityId: capability.capabilityId, audience: AUDIENCE, actionBinding: { format: BINDING_FORMAT, digest: VECTOR.digest } }, history });
    assert.deepEqual([verified.canonical, verified.executorTrust, verified.signature, verified.scope, verified.identityMatch, verified.bindingMatch, verified.receiptState, verified.reportedOutcome, verified.externalConfirmation, verified.issuedHere], ['valid', 'trusted', 'valid', 'permitted', 'yes', 'yes', 'current', 'completed-observed', 'not-established', 'not-evaluated']);
    const tampered = domain.verifier.verify({ receipt: presented.receipt.replace('completed-observed', 'failed-observed'), signature: presented.signature });
    assert.equal(tampered.receipt, null);
    assert.equal(domain.verifier.verify({ receipt: presented.receipt, signature: { ...presented.signature, signature: `A${String(presented.signature['signature']).slice(1)}` } }).signature, 'invalid');
    // The executor held the key; this process was given only the public half and a file path it never reads.
    assert.equal(executor.environment[FAULT_VARIABLE], undefined);
    assert.equal(readFileSync(executor.configPath, 'utf8').includes('PRIVATE KEY'), false);
    const written = `${executor.stdout()}${executor.stderr()}`;
    for (const secret of ['PRIVATE KEY', 'BEGIN', presented.signature['signature'] as string, BEARER]) assert.equal(written.includes(secret), false, 'no key, signature or credential in diagnostics');
  });

  it('a duplicate delivery performs nothing and returns no second receipt; a restart keeps the same signed artifact', async () => {
    const domain = await domainOf();
    const executor = await executorOver(domain);
    const { capability, presentation } = syntheticCapability(VECTOR.digest);
    await exchange(executor, bytesFor(presentation));
    const first = await domain.history(capability.capabilityId);
    const again = await exchange(executor, bytesFor(presentation));
    assert.equal(again.response.status, 202);
    await executor.kill();
    const restarted = await executorOver(domain);
    assert.equal((await exchange(restarted, bytesFor(presentation))).response.status, 202);
    assert.deepEqual(await domain.history(capability.capabilityId), first);
    assert.equal(domain.records().length, 1);
  });
});

describe('G-02C1C process — crash recovery: never re-executed, never upgraded, signed the same', () => {
  const MATRIX: readonly (readonly [string, string, string, string])[] = [
    // point, consumption after the crash, receipt after the crash, receipt once recovered
    ['before-receipt', 'completed', 'none', 'completed-observed'],
    ['after-receipt-construction', 'completed', 'none', 'completed-observed'],
    ['after-receipt-reservation', 'completed', 'reserved', 'completed-observed'],
    ['after-receipt-signature', 'completed', 'reserved', 'completed-observed'],
    ['after-receipt', 'completed', 'issued', 'completed-observed'],
    ['after-claim', 'claimed', 'none', 'attempted-outcome-unknown'],
  ];
  for (const [point, consumption, receiptState, recovered] of MATRIX) {
    it(`crash ${point}: consumption ${consumption}, receipt ${receiptState}; recovery yields ${recovered} and the effect is not repeated`, async (t) => {
      const domain = await domainOf();
      const crashing = await executorOver(domain, { faultInjection: { crashAt: point } }, { [FAULT_VARIABLE]: 'enabled' });
      const { capability, presentation } = syntheticCapability(VECTOR.digest);
      const response = await rawExchange(crashing.port, bytesFor(presentation));
      assert.equal((await crashing.exited()).signal, 'SIGKILL');
      assert.equal(response.status, undefined);
      assert.equal((await domain.state(capability.capabilityId)).state, consumption);
      const ledger = await openExecutorReceiptLedger(domain.receiptLedgerPath, { executorId: EXECUTOR_ID, audience: AUDIENCE, clock: () => Date.now() });
      const left = ledger.latest(capability.capabilityId);
      ledger.close();
      assert.equal(left === undefined ? 'none' : left.state, receiptState);
      const recordsBefore = domain.records().length;
      // Recovery: a restart (its sweep covers unresolved claims), then a redelivery (which covers the rest). Nothing performs the effect.
      const restarted = await executorOver(domain);
      const next = await exchange(restarted, bytesFor(presentation));
      assert.equal(next.response.status, 202);
      const history = await domain.history(capability.capabilityId);
      assert.equal(history.length, 1, 'one receipt');
      const parsed = parseExecutorReceipt(history[0]?.receipt);
      assert.ok(parsed.ok);
      assert.equal(parsed.receipt.outcome, recovered);
      assert.equal(domain.verifier.verify(history[0]).signature, 'valid');
      if (left?.state === 'issued') assert.deepEqual(history[0]?.signature, left.signature, 'the recorded signature is the one returned');
      assert.equal(domain.records().length, recordsBefore, 'no effect on recovery');
      t.diagnostic(`R-${point}: consumption=${consumption} receipt=${receiptState} recovered=${recovered}`);
    });
  }

  it('crash inside the receipt-ledger transaction (before commit): nothing is recorded', async () => {
    const domain = await domainOf();
    const script = [
      "const Database = require('better-sqlite3');",
      'const db = new Database(process.env.LEDGER);',
      "db.prepare('BEGIN IMMEDIATE').run();",
      "db.prepare(\"INSERT INTO executor_receipts (receipt_id, capability_id, execution_id, issuer, sequence, supersedes, outcome, ledger_state, key_id, canonical, digest, state, reserved_at) VALUES ('" + 'a'.repeat(64) + "', '" + 'b'.repeat(64) + "', 'e', 'i', 1, NULL, 'attempted-outcome-unknown', 'claimed', 'k', '{}', 'd', 'reserved', 'now')\").run();",
      "process.kill(process.pid, 'SIGKILL');",
    ].join('\n');
    const child = spawnSync(process.execPath, ['-e', script], { env: { PATH: process.env.PATH ?? '', LEDGER: domain.receiptLedgerPath }, encoding: 'utf8' });
    assert.equal(child.signal, 'SIGKILL', child.stderr);
    const ledger = await openExecutorReceiptLedger(domain.receiptLedgerPath, { executorId: EXECUTOR_ID, audience: AUDIENCE, clock: () => Date.now() });
    try {
      assert.equal(ledger.latest('b'.repeat(64)), undefined);
    } finally {
      ledger.close();
    }
  });

  it('with the receipt key unavailable the executor refuses to start; the consumption is untouched; with the key back, the receipt is recovered and nothing re-executes', async () => {
    const domain = await domainOf();
    const crashing = await executorOver(domain, { faultInjection: { crashAt: 'before-receipt' } }, { [FAULT_VARIABLE]: 'enabled' });
    const { capability, presentation } = syntheticCapability(VECTOR.digest);
    await rawExchange(crashing.port, bytesFor(presentation));
    await crashing.exited();
    const away = `${domain.keyFile}.away`;
    renameSync(domain.keyFile, away);
    const refused = await refusedStart(receiptConfiguration(domain));
    assert.deepEqual([refused.code, refused.refusal.code], [1, 'RECEIPT_KEY_INVALID']);
    assert.equal((await domain.state(capability.capabilityId)).state, 'completed');
    renameSync(away, domain.keyFile);
    const restarted = await executorOver(domain);
    assert.equal((await exchange(restarted, bytesFor(presentation))).response.status, 202);
    assert.equal((await domain.history(capability.capabilityId)).length, 1);
    assert.equal(domain.records().length, 1);
  });
});

describe('G-02C1C process — key rotation never strands a reservation silently', () => {
  it('a restart with a rotated key while a reservation is pending is refused by name; with the old key it completes', async () => {
    const domain = await domainOf();
    const crashing = await executorOver(domain, { faultInjection: { crashAt: 'after-receipt-reservation' } }, { [FAULT_VARIABLE]: 'enabled' });
    const { capability, presentation } = syntheticCapability(VECTOR.digest);
    await rawExchange(crashing.port, bytesFor(presentation));
    assert.equal((await crashing.exited()).signal, 'SIGKILL');
    const rotated = generateReceiptKey(domain.keyDirectory, 'rotated.pem');
    const refused = await refusedStart(receiptConfiguration(domain, { executorReceipts: { keyId: 'g02c1c-executor-receipt-key-2', privateKeyFile: rotated.keyFile, receiptLedgerPath: domain.receiptLedgerPath } }));
    assert.deepEqual([refused.code, refused.refusal.code], [1, 'RECEIPT_LEDGER_INVALID']);
    assert.match(refused.refusal.message, /reservations under another key/);
    const restarted = await executorOver(domain);
    assert.equal((await exchange(restarted, bytesFor(presentation))).response.status, 202);
    const history = await domain.history(capability.capabilityId);
    assert.equal(history.length, 1);
    assert.equal(domain.verifier.verify(history[0]).signature, 'valid');
  });
});

describe('G-02C1C process — concurrent signers', () => {
  it('two executor processes, one consumption ledger, one receipt ledger, one key: per capability one effect and one valid receipt chain, never a conflict', async (t) => {
    const domain = await domainOf();
    const [a, b] = await Promise.all([executorOver(domain), executorOver(domain)]);
    assert.ok(a !== undefined && b !== undefined);
    const lengths: number[] = [];
    for (let round = 0; round < 6; round += 1) {
      const { capability, presentation } = syntheticCapability(VECTOR.digest);
      const bytes = bytesFor(presentation);
      const [left, right] = await Promise.all([rawExchange(a.port, bytes), rawExchange(b.port, bytes)]);
      assert.deepEqual([left.status, right.status].sort(), [201, 202]);
      await new Promise((settle) => setTimeout(settle, 150));
      // The loser may read the consumption as still claimed and receipt it unknown first; the winner then supersedes it.
      // Either way: one valid chain, no conflict, its current receipt the observed completion, and one effect.
      const history = await domain.history(capability.capabilityId);
      const assessed = domain.verifier.assessHistory(history);
      assert.equal(assessed.chain, 'valid', `round ${String(round)}`);
      assert.ok(history.length === 1 || history.length === 2, `round ${String(round)}: ${String(history.length)} receipts`);
      const current = history.find((entry) => parseExecutorReceipt(entry.receipt).ok && (parseExecutorReceipt(entry.receipt) as { receipt: { receiptId: string } }).receipt.receiptId === assessed.current);
      assert.equal(current !== undefined && (parseExecutorReceipt(current.receipt) as { receipt: { outcome: string } }).receipt.outcome, 'completed-observed');
      lengths.push(history.length);
    }
    assert.equal(domain.records().length, 6, 'one effect per capability');
    t.diagnostic(`concurrent signers: 6 rounds, receipts per capability ${lengths.join(',')}, every chain valid`);
  });

  it('two executors starting together over the same stranded claims each sweep, and still one receipt per claim', async () => {
    const domain = await domainOf();
    const crashing = await executorOver(domain, { faultInjection: { crashAt: 'after-claim' } }, { [FAULT_VARIABLE]: 'enabled' });
    const { capability, presentation } = syntheticCapability(VECTOR.digest);
    await rawExchange(crashing.port, bytesFor(presentation));
    await crashing.exited();
    await Promise.all([executorOver(domain), executorOver(domain)]);
    const history = await domain.history(capability.capabilityId);
    assert.equal(history.length, 1);
    assert.equal(parseExecutorReceipt(history[0]?.receipt).ok && (parseExecutorReceipt(history[0]?.receipt) as { receipt: { outcome: string } }).receipt.outcome, 'attempted-outcome-unknown');
    assert.deepEqual(domain.records(), [], 'a stranded claim is never performed');
  });
});

describe('G-02C1C process — startup refuses unsafe receipt custody', () => {
  it('a missing, foreign or corrupted receipt ledger, an unsafe or issuer key, or receipts outside synthetic mode stop the executor', async () => {
    const domain = await domainOf();
    const foreign = await domainOf();
    const foreignLedger = join(foreign.root, 'receipts', 'other-executor.sqlite');
    (await openExecutorReceiptLedger(foreignLedger, { executorId: 'reference-executor-other', audience: AUDIENCE, clock: () => Date.now(), create: true })).close();
    const damaged = join(domain.root, 'receipts', 'damaged.sqlite');
    writeFileSync(damaged, 'not a database');
    const open = join(domain.keyDirectory, 'open.pem');
    copyFileSync(domain.keyFile, open);
    chmodSync(open, 0o644);
    const issuerKey = join(domain.keyDirectory, 'issuer.pem');
    writeFileSync(issuerKey, ISSUER_KEY.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    const receipts = (overrides: Record<string, unknown>) => ({ executorReceipts: { keyId: RECEIPT_KEY_ID, privateKeyFile: domain.keyFile, receiptLedgerPath: domain.receiptLedgerPath, ...overrides } });
    const cases: readonly (readonly [string, Record<string, unknown>, string])[] = [
      ['a missing receipt ledger', receiptConfiguration(domain, receipts({ receiptLedgerPath: join(domain.root, 'receipts', 'missing.sqlite') })), 'RECEIPT_LEDGER_INVALID'],
      ['a receipt ledger of another executor', receiptConfiguration(domain, receipts({ receiptLedgerPath: foreignLedger })), 'RECEIPT_LEDGER_INVALID'],
      ['a file that is not a receipt ledger', receiptConfiguration(domain, receipts({ receiptLedgerPath: damaged })), 'RECEIPT_LEDGER_INVALID'],
      ['a key readable by others', receiptConfiguration(domain, receipts({ privateKeyFile: open })), 'RECEIPT_KEY_INVALID'],
      ['an issuer’s private key as the receipt key', receiptConfiguration(domain, receipts({ privateKeyFile: issuerKey })), 'RECEIPT_KEY_INVALID'],
      ['a receipt key id that is an issuer key id', receiptConfiguration(domain, receipts({ keyId: ISSUER_KEY.keyId })), 'EXECUTOR_RECEIPTS_INVALID'],
      ['receipts outside synthetic mode', { ...receiptConfiguration(domain), mode: 'verification-only', syntheticExecution: undefined }, 'MODE_INCONSISTENT'],
    ];
    for (const [name, config, code] of cases) {
      const refused = await refusedStart(JSON.parse(JSON.stringify(config)) as Record<string, unknown>);
      assert.deepEqual([refused.code, refused.refusal.code], [1, code], name);
      for (const secret of ['PRIVATE KEY', 'BEGIN', domain.root]) assert.equal(refused.stderr.includes(secret), false, `${name}: echoes nothing`);
    }
  });
});
