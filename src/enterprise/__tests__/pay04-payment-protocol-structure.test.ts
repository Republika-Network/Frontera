import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { GOVERNED_ACTION_RESERVED_CONTEXT_KEYS } from '../governed-action/intent.js';
import { PAYMENT_PROTOCOL_RESERVED_CONTEXT_KEYS } from '../../features/payment-runtime/index.js';
import { MPP_RESERVED_CONTEXT_KEYS } from '../../features/payment-runtime/protocols/mpp/index.js';

/**
 * PAY-04 layer K — structural invariants (M39, M40, NO_BYPASS):
 *
 * - **CORE purity**: no payment-protocol vocabulary (MPP, x402, bolt11,
 *   `Payment` challenges, `payment-required`, `httpauth-payment`) in the
 *   Kernel, the runtimes, the Host, the control plane, any generic feature or
 *   any enterprise module but the PAY-04 edge — and PAY-04 introduced no rail
 *   vocabulary into the core either (the set of core files naming XRPL is
 *   exactly PAY-03's Host composition, unchanged);
 * - **no CORE reserved key**: the built-in reserved-context list carries no
 *   protocol word; protocol words reach the registry only as trusted
 *   configuration (L-7);
 * - **the edge is protocol-neutral and rail-neutral**, imports no protocol
 *   adapter and no rail, and builds the governed intent only through PAY-01's
 *   compiler;
 * - **no bypass**: the edge holds no execution adapter, invokes no rail,
 *   signer or submission, retries nothing, and reaches execution only through
 *   `orchestrator.govern()`, after its durable record.
 */

const EDGE = 'src/enterprise/payment-protocol-ingress';
const SKIPPED = new Set(['node_modules', 'dist', 'dist-test', '.next', '.git', 'vendor']);

function walk(dir: string, includeTests = false): readonly string[] {
  if (!existsSync(dir)) return [];
  if (statSync(dir).isFile()) return [dir];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (SKIPPED.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (!includeTests && (name === 'tests' || name === '__tests__' || name === 'fixtures')) continue;
      out.push(...walk(full, includeTests));
    } else if (/\.(?:ts|tsx|mts|cts|js|mjs|cjs)$/.test(full) && !full.endsWith('.d.ts') && (includeTests || !full.includes('.test.'))) {
      out.push(full);
    }
  }
  return out;
}

/** Comments stripped, string literals kept. */
function codeOf(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^\s*\/\/.*$/gm, ' ');
}

/** Generic CORE: everything that is not the payment vertical or one of its two composition edges. */
const CORE = [
  ...['src/kernel', 'src/runtime', 'src/kernel-host', 'src/control-plane-web', 'src/index.ts'].flatMap((root) => walk(root)),
  ...walk('src/enterprise').filter((file) => !file.startsWith(`${EDGE}/`) && !file.startsWith('src/enterprise/xrpl-payment-rail/')),
  ...readdirSync('src/features')
    .filter((name) => name !== 'payment-runtime')
    .flatMap((name) => walk(join('src/features', name))),
  ...walk('packages'),
];

const PROTOCOL_VOCABULARY: readonly RegExp[] = [/\bmpp/i, /mpp[A-Z_]/, /\bx402\b|x402/i, /bolt11/i, /payment-required/i, /httpauth-payment/i, /payment-intent-charge/i, /Payment-Authorization/i];

describe('PAY-04 M39 — no payment-protocol vocabulary in CORE', () => {
  it('scans a non-trivial core', () => {
    assert.ok(CORE.length > 400, `found ${CORE.length}`);
    assert.ok(CORE.includes('src/enterprise/governed-action/orchestrator.ts'));
    assert.ok(CORE.includes('src/kernel/index.ts'));
  });

  it('no core file names a payment protocol — in code or prose', () => {
    for (const file of CORE) {
      const text = readFileSync(file, 'utf8');
      for (const pattern of PROTOCOL_VOCABULARY) assert.equal(pattern.test(text), false, `${file}: ${String(pattern)}`);
    }
  });

  it('PAY-04 added no rail vocabulary to CORE: the core files naming XRPL are exactly PAY-03’s Host composition and P9’s documentation', () => {
    const naming = CORE.filter((file) => /xrpl/i.test(readFileSync(file, 'utf8'))).sort();
    assert.deepEqual(naming, [
      'src/enterprise/authority-state-freshness/checkpoint.ts',
      'src/enterprise/composition/composition-root.ts',
      'src/enterprise/configuration/enterprise-configuration.ts',
      'src/enterprise/host/enterprise-host.ts',
      'src/enterprise/host/host-configuration.ts',
      'src/features/monetary-runtime/domain/monetary-amount.ts',
      'src/features/monetary-runtime/domain/monetary-asset.ts',
    ]);
  });

  it('the core’s built-in reserved-context list carries no protocol word; protocol words reach the registry as configuration only (L-7)', () => {
    const builtIn = new Set(GOVERNED_ACTION_RESERVED_CONTEXT_KEYS.map((key) => key.toLowerCase()));
    for (const key of [...PAYMENT_PROTOCOL_RESERVED_CONTEXT_KEYS, ...MPP_RESERVED_CONTEXT_KEYS]) assert.equal(builtIn.has(key.toLowerCase()), false, key);
    for (const key of GOVERNED_ACTION_RESERVED_CONTEXT_KEYS) for (const pattern of PROTOCOL_VOCABULARY) assert.equal(pattern.test(key), false, key);
  });
});

describe('PAY-04 — the ingress edge is protocol-neutral, rail-neutral and compiles through PAY-01', () => {
  const sources = walk(EDGE);

  it('has the expected production sources', () => {
    assert.deepEqual(sources.map((file) => file.slice(EDGE.length + 1)).sort(), [
      'business-operation.ts',
      'context-reader.ts',
      'contracts.ts',
      'in-memory-payment-business-operation-store.ts',
      'index.ts',
      'service.ts',
      'sqlite-payment-business-operation-store.ts',
      'store-contracts.ts',
      'store-errors.ts',
      'store-integrity.ts',
    ]);
  });

  it('names no protocol and no rail (M40)', () => {
    for (const file of sources) {
      const text = readFileSync(file, 'utf8');
      for (const pattern of [...PROTOCOL_VOCABULARY, /xrpl/i, /rlusd/i, /lightning/i, /stripe/i, /\bledger\b/i, /\bwallet\b/i]) assert.equal(pattern.test(text), false, `${file}: ${String(pattern)}`);
    }
  });

  it('imports PAY only through the payment-runtime barrel — never a protocol adapter, never a rail', () => {
    for (const file of sources) {
      for (const match of codeOf(file).matchAll(/\bfrom\s+'([^']+)'/g)) {
        const specifier = match[1] ?? '';
        assert.equal(/protocols\/|rails\//.test(specifier), false, `${file} imports '${specifier}'`);
        if (specifier.includes('payment-runtime')) assert.equal(specifier, '../../features/payment-runtime/index.js', file);
      }
    }
  });

  it('builds the governed intent only by PAY-01’s compiler, and the canonical intent only by PAY-01’s validator', () => {
    const service = codeOf(join(EDGE, 'service.ts'));
    assert.equal([...service.matchAll(/compilePaymentIntent\(/g)].length, 1);
    assert.equal([...service.matchAll(/paymentIntentOfProtocolTerms\(/g)].length, 1);
    assert.match(service, /orchestrator\.govern\(identity, compiled\)/, 'what is governed is exactly what PAY-01 compiled');
    for (const file of sources) assert.equal(/counterparty:\s|resource:\s/.test(codeOf(file)), false, `${file} hand-builds envelope fields`);
  });
});

describe('PAY-04 post-merge hardening — rollback safety reuses the generic CORE-07 boundary, and nothing else', () => {
  const sources = walk(EDGE);
  const FRESHNESS = 'src/enterprise/authority-state-freshness';

  it('the ingress edge may depend on the generic freshness boundary — its session, errors and checkpoint only; never a transport, a witness client or the reference witness', () => {
    const allowed = new Set(['../authority-state-freshness/session.js', '../authority-state-freshness/errors.js', '../authority-state-freshness/checkpoint.js']);
    const used = new Set<string>();
    for (const file of sources) {
      for (const match of codeOf(file).matchAll(/\bfrom\s+'([^']+)'/g)) {
        const specifier = match[1] ?? '';
        if (!specifier.includes('authority-state-freshness')) continue;
        assert.equal(allowed.has(specifier), true, `${file} imports '${specifier}'`);
        used.add(specifier);
      }
    }
    assert.ok(used.has('../authority-state-freshness/session.js'), 'the store composes the CORE-07 session');
  });

  it('no duplicate witness: the edge implements no witness protocol, transport, receipt, compare-and-advance or witness table', () => {
    for (const file of sources) {
      const code = codeOf(file);
      for (const pattern of [/witness_bindings|committed_sequence|pending_sequence/, /createHttpAuthorityStateWitnessTransport|establishAuthorityStateWitness|startReferenceAuthorityStateWitness/, /\.(?:prepare|finalize|enroll)\(\s*(?:expected|proposed|checkpoint)/, /witnessReceipt|signingBytes|\bed25519\b/i]) {
        assert.equal(pattern.test(code), false, `${file}: ${String(pattern)}`);
      }
    }
    const store = codeOf(join(EDGE, 'sqlite-payment-business-operation-store.ts'));
    assert.match(store, /live\.transition\(expected, proposed,/, 'ownership transitions go through the CORE-07 session');
    assert.match(store, /freshness\.boundary\.establish\(/, 'the open reconciles through the CORE-07 boundary');
    assert.match(store, /freshness\.boundary\.genesisStoreId\(/, 'genesis is enrolled through the CORE-07 boundary');
  });

  it('CORE-07 imports no payment code, and its new slot is protocol- and rail-neutral', () => {
    const core07 = walk(FRESHNESS);
    assert.ok(core07.length >= 8, `found ${core07.length}`);
    for (const file of core07) {
      for (const match of codeOf(file).matchAll(/\bfrom\s+'([^']+)'/g)) {
        const specifier = match[1] ?? '';
        assert.equal(/payment-protocol-ingress|xrpl-payment-rail|payment-runtime|monetary-runtime/.test(specifier), false, `${file} imports '${specifier}'`);
      }
      const text = readFileSync(file, 'utf8');
      for (const pattern of [...PROTOCOL_VOCABULARY, /challenge realm|WWW-Authenticate|Payment header|merchant method/i]) assert.equal(pattern.test(text), false, `${file}: ${String(pattern)}`);
    }
    assert.match(readFileSync(join(FRESHNESS, 'checkpoint.ts'), 'utf8'), /'payment-business-operation-state'/);
  });

  it('the ingress orders the anchored record strictly before governance, and maps every freshness failure to a refusal before it', () => {
    const service = codeOf(join(EDGE, 'service.ts'));
    const recordAt = service.indexOf('await store.record(');
    const freshnessRefusal = service.indexOf("refused('store-freshness-unverified'");
    const governAt = service.indexOf('await orchestrator.govern(');
    assert.ok(recordAt > 0 && freshnessRefusal > recordAt && governAt > freshnessRefusal, 'record → freshness refusal → govern');
    assert.match(service, /freshnessBoundaryOf\(store\)/, 'the composition gate reads the CORE-07 composition record, not the store’s own claim');
  });
});

describe('PAY-04 — NO_BYPASS: the edge reaches execution only through the governed path', () => {
  const sources = walk(EDGE);

  it('holds no execution adapter, invokes no rail, signer or submission, and retries nothing', () => {
    for (const file of sources) {
      const code = codeOf(file);
      for (const pattern of [/ExecutionAdapter|createPaymentRailExecutionAdapter|PaymentRail\b/, /\.execute\s*\(/, /\bsubmit\w*\s*\(/, /\bsign\s*\(|Signer/, /\bretry|retries|resubmit|resend/i, /\bfetch\s*\(|node:http|node:https|node:net/, /issueGrant|evaluate\s*\(|approve\s*\(/]) {
        assert.equal(pattern.test(code), false, `${file}: ${String(pattern)}`);
      }
    }
  });

  it('governs exactly once, after the durable record, and after every refusal', () => {
    const service = codeOf(join(EDGE, 'service.ts'));
    assert.equal([...service.matchAll(/\.govern\(/g)].length, 1);
    const order = ['readPaymentProtectedRequest(', 'adapter.interpret(', 'derivePaymentBusinessOperationKey(', 'paymentIntentOfProtocolTerms(', 'compilePaymentIntent(', 'validateGovernedActionIntent(', 'await store.record(', 'await orchestrator.govern('];
    const positions = order.map((marker) => service.indexOf(marker));
    for (const [index, position] of positions.entries()) assert.notEqual(position, -1, String(order[index]));
    assert.deepEqual([...positions].sort((left, right) => left - right), positions, order.join(' → '));
    const governAt = service.indexOf('await orchestrator.govern(');
    assert.equal(service.slice(governAt).includes("refused('"), false, 'no refusal is decided after governance');
  });

  it('nothing outside the edge composes the ingress: no route, no Host module, no package export', () => {
    for (const file of [...CORE, ...walk('scripts'), ...walk('apps')]) assert.equal(/payment-protocol-ingress|createPaymentProtocolIngress/.test(readFileSync(file, 'utf8')), false, file);
    assert.equal(/payment-protocol-ingress/.test(readFileSync('package.json', 'utf8')), false);
  });
});
