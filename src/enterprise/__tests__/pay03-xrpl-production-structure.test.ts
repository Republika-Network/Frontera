import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { EXTERNAL_XRPL_SIGNER_OPERATION, EXTERNAL_XRPL_SIGNER_PATHS, parseExternalXrplSignerIdentity, parsePreparedXrplPayment } from '../xrpl-payment-rail/signer-protocol.js';

/**
 * PAY-03 — what the production XRPL composition is allowed to be, enforced
 * structurally:
 *
 * - the Host composes the rail only from explicit configuration, and loads it
 *   only then (dynamic import);
 * - the Host never holds an XRPL key: no key, seed or wallet anywhere in the
 *   composition edge; the reference signer is a separate process the Host
 *   never imports;
 * - the signer protocol has exactly one, narrowly typed operation and the
 *   transport makes one attempt per signature;
 * - the resolver is read-only, and P12 composition adds no execution path;
 * - XRPL submission stays reachable only through the governed path.
 */

const EDGE = 'src/enterprise/xrpl-payment-rail';
const REFERENCE = `${EDGE}/reference/reference-xrpl-signer-service.ts`;

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist') continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.(?:ts|mjs|js)$/.test(full) && !full.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

/** Comments stripped, string literals kept. */
const codeOf = (file: string): string =>
  readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^\s*\/\/.*$/gm, ' ');

const isTest = (file: string): boolean => file.includes('__tests__') || file.includes('/tests/') || file.includes('.test.');
const PRODUCTION = ['src', 'scripts', 'packages', 'apps'].flatMap(walk).filter((file) => !isTest(file));
const EDGE_PRODUCTION = walk(EDGE).filter((file) => !isTest(file));

describe('PAY-03 structure — composition', () => {
  it('the Host loads the XRPL composition only when configured: a dynamic import, and type-only static imports', () => {
    const host = codeOf('src/enterprise/host/enterprise-host.ts');
    assert.match(host, /if \(xrplConfiguration !== undefined\) \{[\s\S]*?await import\('\.\.\/xrpl-payment-rail\/host-composition\.js'\)/);
    for (const match of host.matchAll(/^import\s+(type\s+)?[^;]*from\s+'([^']+)';/gm)) {
      if (match[2] === '../xrpl-payment-rail/host-composition.js') assert.ok(match[1] !== undefined, 'host-composition is imported statically for types only');
    }
    assert.equal(/payment-runtime/.test(host), false, 'the Host itself never names the payment vertical');
  });

  it('only the composition edge creates the SDK client, and only host-composition calls the factory', () => {
    const callers = PRODUCTION.filter((file) => /createXrplSdkClient\b/.test(codeOf(file)) && !file.startsWith('src/features/payment-runtime/rails/xrpl/'));
    assert.deepEqual(callers, [`${EDGE}/host-composition.ts`]);
  });

  it('the rail is composed through the PAY-01 bridge into the existing registry — the adapter is the only thing the Host receives', () => {
    const composition = codeOf(`${EDGE}/host-composition.ts`);
    assert.match(composition, /createPaymentRailExecutionAdapter\(\{ rail, binding: createPaymentGovernanceBinding/);
    assert.equal(/\.execute\s*\(/.test(composition), false, 'composition never executes anything');
    const host = codeOf('src/enterprise/host/enterprise-host.ts');
    assert.match(host, /const extra = \[\.\.\.\(options\.executionAdapters \?\? \[\]\), \.\.\.\(xrpl !== undefined \? \[xrpl\.adapter\] : \[\]\)\]/);
  });

  it('no HTTP route, admin endpoint or SDK reaches the XRPL composition: the node adapter and the operator plane import none of it', () => {
    for (const file of PRODUCTION.filter((path) => path.startsWith('src/enterprise/') && !path.startsWith(EDGE) && path !== 'src/enterprise/host/enterprise-host.ts' && path !== 'src/enterprise/host/host-configuration.ts')) {
      assert.equal(/xrpl-payment-rail/.test(codeOf(file)), false, `${file} must not reach the XRPL composition`);
    }
    for (const entry of ['src/index.ts', 'src/enterprise/index.ts', 'src/runtime/index.ts', 'src/kernel/index.ts', 'src/kernel-host/index.ts']) {
      if (existsSync(entry)) assert.equal(/xrpl-payment-rail|rails\/xrpl/.test(codeOf(entry)), false, `${entry} publishes no XRPL surface`);
    }
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { exports?: unknown };
    assert.equal(/xrpl/.test(JSON.stringify(pkg.exports)), false, 'no package export');
  });
});

describe('PAY-03 structure — custody', () => {
  it('no XRPL key, seed, wallet or keypair anywhere in the Host’s composition edge — the reference signer process aside', () => {
    const custody = /\bWallet\b|fromSeed|fromSecret|fromMnemonic|fromEntropy|deriveKeypair|generateSeed|privateKey|ripple-keypairs|secret-numbers/;
    for (const file of EDGE_PRODUCTION.filter((path) => path !== REFERENCE)) assert.equal(custody.test(codeOf(file)), false, file);
  });

  it('nothing in the Host imports the reference signer: only its launcher does', () => {
    const importers = PRODUCTION.filter((file) => file !== REFERENCE && /reference-xrpl-signer-service/.test(codeOf(file)));
    assert.deepEqual(importers, ['scripts/run-reference-xrpl-signer.mjs']);
    assert.equal(/from 'xrpl'[\s\S]*\bClient\b|new Client|submit/.test(codeOf(REFERENCE).replace(/'[^']*'/g, (literal) => (literal === "'xrpl'" ? literal : "''"))), false, 'the reference signer never connects to XRPL or submits');
  });

  it('the Host configuration has no field that could carry a key: the closed field lists name no seed, secret or private key', () => {
    const configuration = codeOf(`${EDGE}/host-configuration.ts`);
    const lists = [...configuration.matchAll(/\[('[^\]]+')\]/g)].map((match) => match[1] ?? '').join(' ');
    assert.equal(/seed|secret|private|mnemonic|wallet/i.test(lists), false, lists);
    assert.match(configuration, /credential\['kind'\] !== 'bearer'/);
  });

  it('the Host refuses XRPL key material in its environment before composing anything', () => {
    const host = codeOf('src/enterprise/host/enterprise-host.ts');
    const guard = host.indexOf('assertProcessHoldsNoXrplKey(host, options.env ?? process.env)');
    const compose = host.indexOf("await import('../xrpl-payment-rail/host-composition.js')");
    assert.ok(guard !== -1 && compose !== -1 && guard < compose);
  });
});

describe('PAY-03 structure — signer protocol and transport', () => {
  it('exactly one operation and two paths: no generic signing, no other transaction, no key export', () => {
    assert.equal(EXTERNAL_XRPL_SIGNER_OPERATION, 'sign-xrpl-payment');
    assert.deepEqual(Object.values(EXTERNAL_XRPL_SIGNER_PATHS).sort(), ['/v1/identity', '/v1/sign/xrpl-payment']);
    assert.equal(parseExternalXrplSignerIdentity({ protocol: 'frontera.external-xrpl-transaction-signer.v1', signerId: 's', operations: ['sign-xrpl-payment', 'sign-bytes'], accounts: [] }), undefined);
    assert.equal(parsePreparedXrplPayment({ TransactionType: 'TrustSet' }), undefined);
  });

  it('the transport makes one attempt per call: no retry loop, no redirect following', () => {
    const transport = codeOf(`${EDGE}/signer-http-transport.ts`);
    assert.equal(/\bfor\s*\(|\bwhile\s*\(|retry|attempts?\b|maxAttempts/i.test(transport.replace(/'[^']*'/g, "''").replace(/`[^`]*`/g, '``')), false);
    assert.equal(/location|follow/i.test(transport.replace(/'[^']*'/g, "''")), false);
    const signer = codeOf(`${EDGE}/external-xrpl-signer.ts`);
    assert.equal([...signer.matchAll(/transport\.signPayment\(/g)].length, 1, 'one signing call site');
  });
});

describe('PAY-03 structure — resolver, P12 and no resend', () => {
  it('the resolver holds no write capability and imports no rail, client factory or signer', () => {
    const resolver = codeOf(`${EDGE}/xrpl-resolution-authority.ts`);
    for (const forbidden of [/\.submit\s*\(/, /\.autofill\s*\(/, /createXrplSdkClient/, /createXrplRlusdRail/, /external-xrpl-signer/, /signer-http-transport/]) assert.equal(forbidden.test(resolver), false, String(forbidden));
    assert.match(resolver, /return Object\.freeze\(\{\s*connect:[\s\S]*lookupTransaction:[\s\S]*\}\);/);
  });

  it('P12 composition adds an authority and a selector — never an adapter, a timer or a reconciliation loop', () => {
    const host = codeOf('src/enterprise/host/enterprise-host.ts');
    const reconciliation = host.slice(host.indexOf('function executionReconciliationOf('), host.indexOf('function assertProcessHoldsNoXrplKey('));
    assert.equal(/setInterval|setTimeout|\.reconcile\(|\.execute\(|adapter/.test(reconciliation), false);
  });

  it('the rail submits from one place, after the durable reservation; nothing in the composition edge submits', () => {
    for (const file of EDGE_PRODUCTION) assert.equal(/\.submit\s*\(/.test(codeOf(file)), false, file);
  });

  it('the interlock never deletes: no DELETE statement in its source, and close clears nothing', () => {
    const store = codeOf(`${EDGE}/sqlite-xrpl-submission-interlock.ts`);
    assert.equal(/DELETE\s+FROM/i.test(store), false);
    assert.equal(/DROP\s+TABLE|DROP\s+TRIGGER/i.test(store), false);
    const close = store.slice(store.indexOf('async close()'));
    assert.equal(/UPDATE|INSERT/.test(close.slice(0, close.indexOf('}') + 1)), false);
  });
});
