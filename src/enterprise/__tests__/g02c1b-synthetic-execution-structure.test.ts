import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { EXECUTION_CAPABILITY_CONSUMPTION_STATES, EXECUTION_CAPABILITY_LEDGER_SCHEMA_VERSION } from '../execution-capability/reference/consumption-ledger.js';

/**
 * G-02C1B structure: one claim, one effect call, no retry; the effect is local
 * and contained; the ledger is G-02A's, opened and never created; fault
 * injection is a configured kill and nothing else; no Host, receipt or
 * production adapter is reached. Measured against source.
 */

const EXECUTOR = 'src/enterprise/reference-executor';

function codeOf(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

function sourcesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name !== '__tests__') out.push(...sourcesUnder(path));
    } else if (path.endsWith('.ts')) out.push(path.replace(/\\/g, '/'));
  }
  return out.sort();
}

const count = (code: string, pattern: RegExp): number => [...code.matchAll(pattern)].length;

describe('G-02C1B structure — one claim, one effect, no retry', () => {
  const flow = codeOf(`${EXECUTOR}/execution-flow.ts`);

  it('the flow claims once, applies the effect once, records an outcome from one place, and has no loop', () => {
    assert.equal(count(flow, /ledger\.claim\(/g), 1);
    assert.equal(count(flow, /effect\.apply\(/g), 1);
    assert.equal(count(flow, /ledger\.recordOutcome\(/g), 1);
    assert.equal(/\bwhile\b|\bfor\s*\(|setTimeout|setInterval|\bawait\b|\bPromise\b|async /.test(flow), false, 'no loop, retry, timer or await on the execution path');
  });

  it('in source order: claim, the post-claim expiry check, the effect, then the outcome', () => {
    const at = (needle: string): number => {
      const index = flow.indexOf(needle);
      assert.notEqual(index, -1, needle);
      return index;
    };
    const order = [at('claim = ledger.claim(verification);'), at("fault('after-claim');"), at('if (!stillValid)'), at("fault('after-expiry-check');"), at('const observation = effect.apply('), at("fault('after-effect');")];
    assert.deepEqual(order, [...order].sort((a, b) => a - b));
    assert.ok(at('const settle = ') < at('const observation = effect.apply('), 'the outcome record is only reachable after a claim');
  });

  it('the fault hook only observes: it is called at the declared points and its return value is never used', () => {
    for (const point of ['before-claim', 'after-claim', 'after-expiry-check', 'during-effect', 'after-effect', 'after-outcome']) assert.equal(count(flow, new RegExp(`fault\\('${point}'\\)`, 'g')), 1, point);
    assert.equal(/=\s*fault\(|if\s*\(\s*fault\(/.test(flow), false);
  });
});

describe('G-02C1B structure — the synthetic effect is local and contained', () => {
  const effect = codeOf(`${EXECUTOR}/synthetic-effect.ts`);

  it('it imports only node:fs, node:path and canonical JSON', () => {
    assert.deepEqual([...effect.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((match) => match[1]).sort(), ['../governance-store/canonical-json.js', 'node:fs', 'node:path']);
  });

  it('it creates the record exclusively, without following a link, and opens exactly two descriptors (the record and the directory flush)', () => {
    assert.ok(effect.includes('const flags = O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW;'));
    assert.equal(count(effect, /openSync\(/g), 2);
    assert.ok(effect.includes('const recordPath = join(outputDirectory, `${capabilityId}.json`);') && effect.includes('openSync(recordPath, flags, 0o600)'), 'the one name: the checked capability id');
    assert.ok(effect.includes("return code === 'EEXIST' || code === 'ELOOP' ? 'unknown' : 'failed';"), 'a taken name is evidence, never a definite failure');
    assert.equal(/unlinkSync|rmSync|renameSync|appendFileSync|writeFileSync|truncate|chmod|chown|symlink/.test(effect), false, 'no other file-system mutation');
  });

  it('no executor source runs a command, starts a process, evaluates code or reaches the network as a client', () => {
    for (const file of sourcesUnder(EXECUTOR)) {
      const code = codeOf(file);
      assert.equal(/child_process|\beval\s*\(|new\s+Function\s*\(|(?<![.\w])exec(?:Sync|File)?\s*\(|\bspawn\s*\(|\bfork\s*\(|node:(?:https|net|tls|dns|dgram|http2)\b|\bfetch\s*\(|\.request\s*\(/.test(code), false, file);
    }
  });
});

describe('G-02C1B structure — the ledger is G-02A’s, opened and never created', () => {
  const launcher = codeOf(`${EXECUTOR}/launcher.ts`);

  it('the launcher opens the configured ledger with the executor’s audience and never passes create', () => {
    assert.ok(launcher.includes('openExecutionCapabilityConsumptionLedger(synthetic.consumptionLedgerPath, { audience: configuration.audience, clock })'));
    assert.ok(launcher.includes('durablyClaimed: (capabilityId) => admitsEffect(opened.read(capabilityId).state)'), 'the one claim-state predicate, mutation-qualified in synthetic-effect.ts');
    assert.equal(/create\s*:/.test(launcher), false);
    for (const file of sourcesUnder(EXECUTOR)) assert.equal(/create\s*:\s*true/.test(codeOf(file)), false, file);
  });

  it('the ledger and the effect are built only in synthetic-execution mode, and the ledger module is loaded only then', () => {
    assert.ok(launcher.includes("const execution = configuration.mode === 'synthetic-execution' ? await openSyntheticExecution(configuration, clock, writeLine) : undefined;"));
    assert.equal(/^import[^;]*consumption-ledger/m.test(launcher), false, 'never a static import');
    assert.equal(count(launcher, /await import\('\.\.\/execution-capability\/reference\/consumption-ledger\.js'\)/g), 1);
  });

  it('the G-02A ledger contract it relies on is the one it was qualified with (no schema migration, no new state)', () => {
    assert.equal(EXECUTION_CAPABILITY_LEDGER_SCHEMA_VERSION, 'frontera.execution-capability-consumption-ledger.v1');
    assert.deepEqual([...EXECUTION_CAPABILITY_CONSUMPTION_STATES], ['claimed', 'completed', 'failed', 'outcome-unknown']);
    const ledger = readFileSync('src/enterprise/execution-capability/reference/consumption-ledger.ts', 'utf8');
    assert.ok(ledger.includes("WHEN NOT (\n    (OLD.state = 'claimed' AND NEW.state IN ('completed', 'failed', 'outcome-unknown'))\n    OR (OLD.state = 'outcome-unknown' AND NEW.state IN ('completed', 'failed'))\n  )"), 'the forward-only transitions');
    assert.equal(/reference-executor|synthetic/i.test(ledger), false, 'G-02A knows nothing of the executor');
    // Durability under a crash of the process is what CI qualifies (the OS page cache survives SIGKILL); synchronous = FULL is what a power loss would rely on, and is pinned here, not qualified.
    assert.ok(ledger.includes("db.pragma('synchronous = FULL');") && ledger.includes("db.pragma('journal_mode = WAL');"));
  });

  it('fault injection is a configured self-kill in the launcher and nowhere else', () => {
    assert.equal(count(launcher, /process\.kill\(process\.pid, 'SIGKILL'\)/g), 1);
    assert.ok(launcher.includes("if (point === crashAt) process.kill(process.pid, 'SIGKILL');"));
    assert.ok(launcher.includes("environment[REFERENCE_EXECUTOR_FAULT_INJECTION_VARIABLE] !== 'enabled'"), 'a configuration file alone cannot enable it');
    for (const file of sourcesUnder(EXECUTOR).filter((path) => path !== `${EXECUTOR}/launcher.ts`)) assert.equal(/process\.(?:kill|exit|abort)\(/.test(codeOf(file)), false, file);
  });
});

describe('G-02C1B structure — no Host, receipt or production adapter', () => {
  it('no executor source reaches a production execution adapter, the Host, P11/P12 or a signer', () => {
    for (const file of sourcesUnder(EXECUTOR)) {
      assert.equal(/execution-adapters|execution-outcome-store|execution-resolution-store|execution-reconciliation|execution-capability-issuance|execution-capability-gate|external-authority-signer|\/host\/|\/composition\/|grant-store|xrpl|lightning|stripe/.test(codeOf(file)), false, file);
    }
  });

  it('receipts (G-02C1C) live only in the receipt contract, the reference executor, (G-02C1D) the Host receipt evidence module and (AUTH-04D2S) the offline verifier', () => {
    const allowed = ['src/enterprise/executor-receipt/', `${EXECUTOR}/`, 'src/enterprise/execution-receipt-evidence/', 'src/enterprise/synthetic-execution-verification/'];
    for (const file of sourcesUnder('src').filter((path) => !allowed.some((prefix) => path.startsWith(prefix)))) {
      assert.equal(/executor-receipt|ExecutorReceipt|signExecutorReceipt/.test(codeOf(file)), false, file);
    }
  });

  it('no Host module imports the execution flow or the synthetic effect', () => {
    const importers = sourcesUnder('src').filter((file) => !file.startsWith(`${EXECUTOR}/`) && /(execution-flow|synthetic-effect)\.js['"]/.test(codeOf(file)));
    assert.deepEqual(importers, []);
  });
});
