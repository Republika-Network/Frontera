import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { createMonetaryAssetRegistry } from '../../features/monetary-runtime/index.js';
import { paymentIntentOfProtocolTerms } from '../../features/payment-runtime/index.js';
import { lightningDestinationOf } from '../../features/payment-runtime/rails/lightning/index.js';
import { BTC_ASSET, testNodeKey, testPreimage } from '../../features/payment-runtime/rails/lightning/tests/lightning-test-fixtures.js';

/**
 * PAY-06 — structural proof that the existing architecture was rail-neutral:
 * Lightning implements PAY-01's rail port, P12's resolution port and PAY-05's
 * finality port as they stood, and no CORE layer learns Lightning exists.
 *
 * - No Lightning vocabulary (bolt11, invoice, payment hash, preimage, HTLC,
 *   channel, routing fee, node pubkey, LND, CLN, macaroon) in the Kernel, the
 *   grant and recognition runtimes, generic policy, P7, P10, P11, P12, the
 *   governed-action path, the execution runtime or CORE-04.
 * - The generic PAY-01 / PAY-05 contracts are unchanged in shape and name no
 *   rail word.
 * - The Lightning edge reaches governance only as a composed rail: it imports
 *   no Kernel, grant, orchestrator or governed-action code; its read-only
 *   authorities hold no send capability; node credentials live in one file.
 * - XRPL and Lightning never import each other.
 */

const EDGE = 'src/enterprise/lightning-payment-rail';
const RAIL = 'src/features/payment-runtime/rails/lightning';

function walk(dir: string): readonly string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === '__tests__' || name === 'tests' || name === 'fixtures') continue;
      out.push(...walk(full));
    } else if (full.endsWith('.ts') && !full.endsWith('.test.ts')) {
      out.push(full);
    }
  }
  return out;
}

function codeOf(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^\s*\/\/.*$/gm, ' ');
}

const importsOf = (file: string): readonly string[] => [...codeOf(file).matchAll(/\bfrom\s+'([^']+)'/g)].map((match) => match[1] ?? '');

/** Lightning words, as code or prose. "invoice" alone is a generic English word elsewhere (a policy-pack evidence kind), so it is matched only in Lightning's own phrasings. */
const LIGHTNING_VOCABULARY = /lightning|bolt\s?11|\bbolt-11\b|preimage|payment[_ -]?hash|paymentHash|\bhtlcs?\b|routing[_ -]?fee|fee[_ -]?limit[_ -]?msat|\bmsat\b|millisatoshi|node[_ -]?pubkey|\blnd\b|\bcln\b|core lightning|macaroon|payreq|lnbc|lntb/i;

const EDGE_SOURCES = walk(EDGE);
const RAIL_SOURCES = walk(RAIL);

describe('PAY-06 structure — CORE does not know Lightning exists', () => {
  for (const [label, roots] of [
    ['the Kernel', ['src/kernel', 'src/kernel-host', 'src/enterprise/kernel-authority']],
    ['the grant runtime', ['src/features/grant-runtime', 'src/enterprise/bounded-grant-store']],
    ['the recognition runtime', ['src/features/recognition-runtime']],
    ['generic policy', ['src/features/domain-policy-pack-runtime', 'src/features/policy-pack-foundation']],
    ['P7 exercise controls', ['src/features/exercise-control-runtime', 'src/enterprise/exercise-control-ledger']],
    ['P10 authority and the governed-action path', ['src/features/authority-graph', 'src/enterprise/governed-action', 'src/enterprise/governance-profile']],
    ['P11 / P12 generic contracts', ['src/enterprise/execution-outcome-store', 'src/enterprise/execution-resolution-store', 'src/enterprise/execution-reconciliation', 'src/features/execution-runtime']],
    ['the CORE obligation lifecycle', ['src/features/obligation-runtime', 'src/enterprise/obligation-discharge']],
    ['CORE-07 freshness', ['src/enterprise/authority-state-freshness']],
    ['P9 money', ['src/features/monetary-runtime']],
  ] as const) {
    it(`${label} names no Lightning concept and imports no Lightning code`, () => {
      const files = roots.flatMap((root) => walk(root));
      assert.ok(files.length > 0, label);
      for (const file of files) {
        assert.equal(LIGHTNING_VOCABULARY.test(codeOf(file)), false, `${file} names a Lightning concept`);
        for (const specifier of importsOf(file)) assert.equal(/lightning/.test(specifier), false, `${file} imports '${specifier}'`);
      }
    });
  }

  it('the vocabulary pattern detects Lightning words and not ordinary ones', () => {
    for (const hit of ['decodeBolt11Invoice', 'paymentHash', 'preimage', 'lightning-btc', 'macaroon', 'htlc', 'fee_limit_msat', 'lnbcrt1']) assert.equal(LIGHTNING_VOCABULARY.test(hit), true, hit);
    for (const miss of ['invoice', 'payment', 'hash', 'feeLimit', 'channel', 'node']) assert.equal(LIGHTNING_VOCABULARY.test(miss), false, miss);
  });

  it('PAY-01 and PAY-05 generic contracts name no rail word: the rail port, the execution request, the finality port and evidence are unchanged in shape', () => {
    for (const file of ['payment-rail.ts', 'payment-execution.ts', 'payment-settlement.ts', 'payment-refund.ts', 'payment-intent.ts', 'payment-governance.ts', 'payment-protocol.ts'].map((name) => `src/features/payment-runtime/domain/${name}`)) {
      assert.equal(LIGHTNING_VOCABULARY.test(codeOf(file)), false, file);
    }
    const settlement = codeOf('src/features/payment-runtime/domain/payment-settlement.ts');
    assert.match(settlement, /const EVIDENCE_KEYS = \['executionId', 'method', 'providerRef', 'amount', 'source', 'destination', 'finalizedAt', 'facts'\];/, 'the finality evidence keys are PAY-05’s, unchanged');
    assert.match(settlement, /verifyFinality\(query: PaymentFinalityQuery\): Promise<PaymentFinalityAnswer>;/);
    const rail = codeOf('src/features/payment-runtime/domain/payment-rail.ts');
    assert.match(rail, /execute\(request: PaymentExecutionRequest\): Promise<PaymentRailResult>;/);
    const resolution = codeOf('src/enterprise/execution-reconciliation/authority.ts');
    assert.match(resolution, /resolve\(query: ExecutionResolutionQuery\): Promise<ExecutionResolutionAuthorityResult>;/);
  });

  it('CORE-07 gains exactly one neutral slot for PAY-06, and names no Lightning concept', () => {
    const checkpoint = readFileSync('src/enterprise/authority-state-freshness/checkpoint.ts', 'utf8');
    assert.match(checkpoint, /'payment-refund-state', 'payment-initiation-reservations'\] as const/);
    assert.equal(LIGHTNING_VOCABULARY.test(checkpoint), false);
  });
});

describe('PAY-06 structure — the Lightning edge reaches money only through the governed rail', () => {
  it('the edge has exactly the expected production sources', () => {
    assert.deepEqual(EDGE_SOURCES.map((file) => file.slice(EDGE.length + 1)).sort(), ['lightning-finality-authority.ts', 'lightning-resolution-authority.ts', 'lnd-rest-node.ts', 'sqlite-lightning-payment-interlock.ts']);
  });

  it('nothing in the Lightning edge or rail reaches governance directly: no Kernel, grant, orchestrator, governed-action, P7 or execution adapter', () => {
    for (const file of [...EDGE_SOURCES, ...RAIL_SOURCES]) {
      for (const specifier of importsOf(file)) {
        assert.equal(/kernel|grant|orchestrat|governed-action|exercise-control|execution-adapters|composition|bounded-grant|approval|obligation/.test(specifier), false, `${file} imports '${specifier}'`);
      }
      assert.equal(/createPaymentRailExecutionAdapter|\.govern\s*\(|issueGrant|recordTerminal|prepareAttempt|recordResolution/.test(codeOf(file)), false, file);
    }
  });

  it('the P12 and finality authorities hold no send capability: a reader type only, never the node port, never the rail', () => {
    for (const file of ['lightning-resolution-authority.ts', 'lightning-finality-authority.ts'].map((name) => `${EDGE}/${name}`)) {
      const code = codeOf(file);
      assert.equal(/sendPayment|LightningNodePort\b|createLightningRail|createLndRestLightningNode\b|lnd-rest-node/.test(code), false, file);
      assert.match(code, /readonly node: LightningNodeReader;/);
      assert.equal(/interlock\.reserve|\.reserve\(/.test(code), false, `${file} never writes the interlock`);
    }
  });

  it('node credentials live in exactly one production file — the LND adapter — and nowhere in payment-runtime', () => {
    const production = ['src', 'packages', 'apps', 'scripts'].flatMap((root) => walk(root)).filter((file) => /macaroon/i.test(codeOf(file)));
    assert.deepEqual(production, [`${EDGE}/lnd-rest-node.ts`]);
    for (const file of walk('src/features/payment-runtime')) assert.equal(/macaroon|tls\.?cert|grpc/i.test(codeOf(file)), false, file);
    const adapter = codeOf(`${EDGE}/lnd-rest-node.ts`);
    assert.equal([...adapter.matchAll(/\bsend\(/g)].length, 1, 'one request primitive call site');
    assert.equal(/\/v2\/router\/send/.test(adapter) && [...adapter.matchAll(/\/v2\/router\/send/g)].length, 1, 'one send route, written once');
    assert.equal(/retry|retries|resend/i.test(adapter), false);
  });

  it('XRPL and Lightning never import each other, at either layer', () => {
    for (const file of [...EDGE_SOURCES, ...RAIL_SOURCES]) for (const specifier of importsOf(file)) assert.equal(/xrpl/.test(specifier), false, `${file} imports '${specifier}'`);
    for (const file of [...walk('src/enterprise/xrpl-payment-rail'), ...walk('src/features/payment-runtime/rails/xrpl')]) for (const specifier of importsOf(file)) assert.equal(/lightning/.test(specifier), false, `${file} imports '${specifier}'`);
  });

  it('nothing in PAY-06 is exported from a package entrypoint or composed by the shipped Host', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { readonly exports?: unknown };
    assert.equal(JSON.stringify(pkg.exports).includes('lightning'), false);
    for (const root of ['src/index.ts', 'src/enterprise/index.ts', 'src/runtime/index.ts', 'src/kernel/index.ts', 'src/kernel-host/index.ts']) {
      if (existsSync(root)) assert.equal(/lightning/i.test(readFileSync(root, 'utf8')), false, root);
    }
    for (const file of [...walk('src/enterprise/host'), ...walk('src/enterprise/composition'), ...walk('src/enterprise/configuration')]) assert.equal(/lightning/i.test(codeOf(file)), false, `${file} composes Lightning`);
  });
});

describe('PAY-06 structure — protocol and direct ingress compatibility', () => {
  it('PAY-04: MPP hard-codes no rail — protocol terms naming a Lightning destination and rail become a canonical PaymentIntent', async () => {
    for (const file of [...walk('src/features/payment-runtime/protocols'), ...walk('src/enterprise/payment-protocol-ingress')]) assert.equal(/xrpl|lightning/i.test(codeOf(file)), false, `${file} names a rail`);
    const assets = createMonetaryAssetRegistry([{ assetId: BTC_ASSET, scale: 11 }]);
    const validation = paymentIntentOfProtocolTerms(
      { destination: lightningDestinationOf(await testNodeKey('payee-node'), testPreimage('mpp').paymentHash), amount: { value: '0.000025', unit: BTC_ASSET }, rail: 'lightning-btc' },
      { source: { accountId: 'treasury' }, purpose: 'purchase', idempotencyKey: 'mpp-op-1' },
      { assets },
    );
    assert.equal(validation.valid, true, JSON.stringify(validation));
  });
});
