import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { AUTHORITY_SIGNING_DOMAINS } from '../authority-authenticity/index.js';
import { AUTHORITY_STATE_WITNESS_RECEIPT_DOMAIN } from '../authority-state-freshness/protocol.js';
import { EXECUTION_CAPABILITY_LEDGER_SCHEMA_VERSION } from '../execution-capability/reference/consumption-ledger.js';
import { EXECUTION_CAPABILITY_SIGNING_DOMAIN } from '../execution-capability/index.js';
import { EXECUTOR_RECEIPT_SIGNING_DOMAIN } from '../executor-receipt/index.js';

/**
 * G-02C1C structure: one receipt domain, prefix-free against every other; a
 * verifier with no signing in reach; one signer, reached only by the issuer,
 * only after a durable read and a reservation; the G-02A ledger's schema
 * unchanged; receipts loaded only in synthetic mode; no Host surface.
 */

const EXECUTOR = 'src/enterprise/reference-executor';
const RECEIPT = 'src/enterprise/executor-receipt';

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

function runtimeSpecifiers(file: string): string[] {
  const code = codeOf(file).replace(/\b(?:import|export)\s+type\b[\s\S]*?\bfrom\s*['"][^'"]+['"]/g, ' ');
  return [...code.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)['"]([^'"]+)['"]/g)].map((match) => match[1] ?? '').filter((specifier) => specifier.length > 0);
}

function closureOf(entries: readonly string[]): { readonly files: ReadonlySet<string>; readonly bare: ReadonlySet<string> } {
  const files = new Set<string>();
  const bare = new Set<string>();
  const pending = [...entries];
  while (pending.length > 0) {
    const file = pending.pop() as string;
    if (files.has(file)) continue;
    files.add(file);
    for (const specifier of runtimeSpecifiers(file)) {
      if (!specifier.startsWith('.')) {
        bare.add(specifier);
        continue;
      }
      const target = normalize(join(dirname(file), specifier)).replace(/\\/g, '/');
      const resolved = target.endsWith('.js') ? `${target.slice(0, -3)}.ts` : `${target}/index.ts`;
      assert.ok(existsSync(resolved), `${file} imports ${specifier}`);
      pending.push(resolved);
    }
  }
  return { files, bare };
}

const count = (code: string, pattern: RegExp): number => [...code.matchAll(pattern)].length;

describe('G-02C1C structure — one receipt domain, never confused with another', () => {
  it('frontera:executor-receipt:v1 is prefix-free against every signing domain and every frontera: literal in the source tree', () => {
    assert.equal(EXECUTOR_RECEIPT_SIGNING_DOMAIN, 'frontera:executor-receipt:v1\n');
    const known = [...Object.values(AUTHORITY_SIGNING_DOMAINS), AUTHORITY_STATE_WITNESS_RECEIPT_DOMAIN, EXECUTION_CAPABILITY_SIGNING_DOMAIN];
    const literals = new Set<string>();
    for (const file of sourcesUnder('src')) {
      for (const match of readFileSync(file, 'utf8').matchAll(/'(frontera:[^'\\]*(?:\\n)?)'/g)) literals.add((match[1] ?? '').replace(/\\n$/, '\n'));
    }
    const others = [...new Set([...known, ...literals])].filter((domain) => domain !== EXECUTOR_RECEIPT_SIGNING_DOMAIN);
    assert.ok(others.length >= 9);
    for (const other of others) {
      assert.equal(other.startsWith(EXECUTOR_RECEIPT_SIGNING_DOMAIN), false, other);
      assert.equal(EXECUTOR_RECEIPT_SIGNING_DOMAIN.startsWith(other), false, other);
    }
    const declared = sourcesUnder('src').filter((file) => /'frontera:executor-receipt:v1\\n'/.test(codeOf(file)));
    assert.deepEqual(declared, [`${RECEIPT}/receipt.ts`], 'declared once');
  });
});

describe('G-02C1C structure — the verifier stands alone; one signer, reached one way', () => {
  it('the receipt contract and verifier load only the CORE-02 verification primitives, the G-02A identifier rule and canonical JSON — and never a key', () => {
    const closure = closureOf([`${RECEIPT}/index.ts`]);
    assert.deepEqual([...closure.files].sort(), [
      'src/enterprise/authority-authenticity/errors.ts',
      'src/enterprise/authority-authenticity/signature-envelope.ts',
      'src/enterprise/authority-authenticity/signature-verification.ts',
      'src/enterprise/execution-capability/capability.ts',
      `${RECEIPT}/index.ts`,
      `${RECEIPT}/receipt.ts`,
      `${RECEIPT}/verifier.ts`,
      'src/enterprise/governance-store/canonical-json.ts',
      'src/enterprise/governance-store/digest.ts',
    ]);
    assert.deepEqual([...closure.bare].sort(), ['node:crypto']);
    for (const file of sourcesUnder(RECEIPT)) assert.equal(/createPrivateKey|privateKey|generateKeyPair|[^a-zA-Z.]sign\(|signExecutorReceipt|reference-executor|createHmac/.test(codeOf(file)), false, file);
  });

  it('the receipt signer is the executor’s only key holder, and only the issuer calls it, after a durable read and a reservation', () => {
    for (const file of sourcesUnder(EXECUTOR).filter((path) => path !== `${EXECUTOR}/receipt-signer.ts`)) assert.equal(/createPrivateKey|[^a-zA-Z.]sign\(/.test(codeOf(file)), false, file);
    const callers = sourcesUnder('src').filter((file) => /\.signExecutorReceipt\(/.test(codeOf(file)));
    assert.deepEqual(callers, [`${EXECUTOR}/receipt-issuer.ts`]);
    const issuer = codeOf(`${EXECUTOR}/receipt-issuer.ts`);
    const order = ['consumption.readDetail(capabilityId)', 'receipts.reserve(draft)', 'signer.signExecutorReceipt(reservation)', 'receipts.issue(reservation, signature)'].map((step) => issuer.indexOf(step));
    assert.ok(order.every((index) => index !== -1), JSON.stringify(order));
    assert.deepEqual(order, [...order].sort((a, b) => a - b));
    const signer = codeOf(`${EXECUTOR}/receipt-signer.ts`);
    assert.equal(count(signer, /[^a-zA-Z.]sign\(null, bytes, privateKey\)/g), 1, 'one signing call, over the receipt bytes');
    assert.ok(signer.includes('const bytes = executorReceiptSigningBytes(receipt);'));
    assert.ok(/return Object\.freeze\(\{ executorId, keyId, publicKeyPem, signExecutorReceipt \}\);/.test(signer), 'only public material leaves');
  });

  it('no receipt module performs, claims or records a consumption — a receipt can never cause an effect or a retry', () => {
    for (const file of [`${EXECUTOR}/receipt-issuer.ts`, `${EXECUTOR}/receipt-ledger.ts`, `${EXECUTOR}/receipt-signer.ts`, ...sourcesUnder(RECEIPT)]) {
      assert.equal(/\.claim\(|recordOutcome\(|effect\.apply|\.apply\(|openSyntheticDeploymentEffect|writeSync|writeFileSync|\bwhile\s*\(\s*true|setTimeout|setInterval/.test(codeOf(file)), false, file);
    }
    const flow = codeOf(`${EXECUTOR}/execution-flow.ts`);
    assert.equal(count(flow, /receipts\.issue\(/g), 2, 'the flow asks for a receipt in one helper only');
    assert.ok(flow.indexOf("fault('after-outcome');") < flow.indexOf('receiptFor(capabilityId, outcome);'), 'only after the outcome is durably recorded');
  });
});

describe('G-02C1C structure — durable state and its owners', () => {
  it('the G-02A consumption ledger gains read-only methods only: the same schema, triggers, writes and version', () => {
    const ledger = readFileSync('src/enterprise/execution-capability/reference/consumption-ledger.ts', 'utf8');
    assert.equal(EXECUTION_CAPABILITY_LEDGER_SCHEMA_VERSION, 'frontera.execution-capability-consumption-ledger.v1');
    const schema = /const SCHEMA = `([\s\S]*?)`;/.exec(ledger)?.[1] ?? '';
    assert.equal(count(schema, /CREATE TABLE/g), 2);
    assert.equal(count(schema, /CREATE TRIGGER/g), 4);
    assert.equal(/receipt|executor/i.test(schema), false);
    assert.equal(count(ledger, /INSERT INTO execution_capability_consumptions/g), 1, 'one write: the claim');
    assert.equal(count(ledger, /UPDATE execution_capability_consumptions/g), 1, 'one write: the forward outcome');
    assert.ok(/WHERE state IN \('claimed', 'outcome-unknown'\)[\s\S]*?ORDER BY claimed_at, capability_id LIMIT \?/.test(ledger), 'listUnresolved: bounded, fixed order');
  });

  it('the receipt ledger is its own file and schema, created only by an explicit call, and loaded only in synthetic mode with receipts', () => {
    const launcher = codeOf(`${EXECUTOR}/launcher.ts`);
    for (const module of ['receipt-ledger', 'receipt-signer', 'receipt-issuer']) {
      assert.equal(new RegExp(`^import[^;]*${module}`, 'm').test(launcher), false, `${module}: never a static import`);
      assert.equal(count(launcher, new RegExp(`await import\\('\\./${module}\\.js'\\)`, 'g')), 1, module);
    }
    assert.ok(launcher.includes('await openExecutorReceiptLedger(settings.receiptLedgerPath, { executorId: configuration.executorId, audience: configuration.audience, clock })'));
    assert.equal(/create\s*:/.test(launcher), false, 'the executor never creates a ledger');
    assert.ok(launcher.includes('const receipts = configuration.executorReceipts === null ? undefined : await openReceipts('));
    const ledger = codeOf(`${EXECUTOR}/receipt-ledger.ts`);
    assert.ok(ledger.includes("export const EXECUTOR_RECEIPT_LEDGER_SCHEMA_VERSION = 'frontera.executor-receipt-ledger.v1';"));
    assert.equal(/execution_capability_consumptions|execution_capability_ledger_meta/.test(ledger), false, 'never touches the consumption ledger');
  });

  it('the separate-process suite never reads the executor’s private key', () => {
    const suite = readFileSync('src/enterprise/__tests__/g02c1c-executor-receipt-process.test.ts', 'utf8');
    assert.equal(/receipt-signer|createPrivateKey|readFileSync\(domain\.keyFile|loadExecutorReceiptSigner/.test(suite), false);
  });

  it('no Host, Kernel, P11/P12, route, barrel or exports entry reaches the receipt contract or the receipt path', () => {
    for (const file of sourcesUnder('src').filter((path) => !path.startsWith(`${RECEIPT}/`) && !path.startsWith(`${EXECUTOR}/`))) {
      assert.equal(/executor-receipt\/|receipt-(?:issuer|ledger|signer)/.test(codeOf(file)), false, file);
    }
    assert.equal(/executor-receipt|reference-executor/.test(JSON.stringify((JSON.parse(readFileSync('package.json', 'utf8')) as { exports?: unknown }).exports ?? {})), false);
  });
});
