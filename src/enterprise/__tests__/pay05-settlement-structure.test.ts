import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * PAY-05 — structural boundaries, enforced on the repository's own sources.
 *
 * - Settlement, receipt, finality and refund semantics live in the payment
 *   vertical only (`src/features/payment-runtime`, the enterprise composition
 *   edge `src/enterprise/payment-settlement`, and the XRPL rail's own edge);
 *   the Kernel, the grant runtime, P7, P11, P12 and CORE-04 never learn them.
 * - Settlement observes; it never executes: no execution adapter, rail
 *   `execute`, XRPL submit / autofill / signer, grant issuance or P7 write is
 *   reachable from it. The refund service's one way to move money is the
 *   existing governed-action orchestrator.
 * - The generic settlement contract names no rail and no protocol.
 * - PAY-05 uses CORE-04 only through its public contracts (the trusted
 *   recorder and the discharge read), and CORE-04 imports no payment code.
 */

const EDGE = 'src/enterprise/payment-settlement';
const CONTRACT = ['src/features/payment-runtime/domain/payment-settlement.ts', 'src/features/payment-runtime/domain/payment-refund.ts'];
const XRPL_FINALITY = ['src/features/payment-runtime/rails/xrpl/xrpl-finality.ts', 'src/enterprise/xrpl-payment-rail/xrpl-finality-authority.ts'];

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

function importsOf(file: string): readonly string[] {
  return [...codeOf(file).matchAll(/\bfrom\s+'([^']+)'/g)].map((match) => match[1] ?? '');
}

const EDGE_SOURCES = walk(EDGE);
const PAY05_IDENTIFIERS = /payment-settlement|PaymentSettlement|PaymentReceipt|PaymentFinality|paymentRefund|PaymentRefund|payment-refund-ledger|createPaymentObligationDischarger/;

describe('PAY-05 structure — settlement semantics stay in the payment vertical', () => {
  it('the edge has exactly the expected production sources', () => {
    assert.deepEqual(EDGE_SOURCES.map((file) => file.slice(EDGE.length + 1)).sort(), [
      'basis.ts',
      'contracts.ts',
      'errors.ts',
      'in-memory-payment-settlement-store.ts',
      'index.ts',
      'integrity.ts',
      'obligation-bridge.ts',
      'refund-ledger.ts',
      'refund-service.ts',
      'service.ts',
      'settlement-store.ts',
      'sqlite-payment-refund-ledger.ts',
      'sqlite-payment-settlement-store.ts',
      'validation.ts',
    ]);
  });

  it('PAY-05 reads P11 / P12 only through read-only readers, in exactly the files the P11 / P12 boundary tests allow', () => {
    const reaching = EDGE_SOURCES.filter((file) => /execution-(?:outcome|resolution)-store\//.test(readFileSync(file, 'utf8'))).map((file) => file.slice(EDGE.length + 1)).sort();
    assert.deepEqual(reaching, ['basis.ts', 'refund-service.ts', 'validation.ts']);
    for (const file of EDGE_SOURCES) assert.equal(/prepareAttempt|recordTerminal|recordResolution|\.bind\(/.test(codeOf(file)), false, file);
  });

  for (const [label, roots, vocabulary] of [
    ['the Kernel', ['src/kernel'], /receipt|finality|refund/i],
    ['the grant runtime', ['src/features/grant-runtime', 'src/enterprise/bounded-grant-store'], /receipt|finality|refund/i],
    ['P7 capacity accounting', ['src/features/exercise-control-runtime', 'src/enterprise/exercise-control-ledger'], /receipt|finality|refund/i],
    ['CORE-04 obligations', ['src/features/obligation-runtime', 'src/enterprise/obligation-discharge'], /receipt|finality|refund|settle/i],
    ['the policy core', ['src/features/domain-policy-pack-runtime'], /payment-settlement|PaymentReceipt|PaymentFinality/],
  ] as const) {
    it(`${label} names no PAY-05 identifier and no receipt / finality / refund vocabulary`, () => {
      const files = roots.flatMap((root) => walk(root));
      assert.ok(files.length > 0, label);
      for (const file of files) {
        const text = readFileSync(file, 'utf8');
        assert.equal(PAY05_IDENTIFIERS.test(text), false, `${file} names PAY-05`);
        assert.equal(vocabulary.test(text), false, `${file}: ${String(vocabulary)}`);
      }
    });
  }

  it('P11, P12, the governed-action path and the execution runtime import nothing from PAY-05', () => {
    for (const root of ['src/enterprise/execution-outcome-store', 'src/enterprise/execution-resolution-store', 'src/enterprise/execution-reconciliation', 'src/enterprise/governed-action', 'src/features/execution-runtime', 'src/enterprise/composition', 'src/enterprise/host']) {
      for (const file of walk(root)) assert.equal(PAY05_IDENTIFIERS.test(readFileSync(file, 'utf8')), false, file);
    }
  });

  it('CORE-04 imports no payment code; PAY-05 reaches CORE-04 only through its recorder and discharge-read contracts', () => {
    for (const file of [...walk('src/features/obligation-runtime'), ...walk('src/enterprise/obligation-discharge')]) {
      for (const specifier of importsOf(file)) assert.equal(/payment/.test(specifier), false, `${file} imports '${specifier}'`);
    }
    const reached = new Set(EDGE_SOURCES.flatMap((file) => importsOf(file)).filter((specifier) => specifier.includes('obligation') && specifier.startsWith('../')));
    assert.deepEqual([...reached].sort(), ['../../features/obligation-runtime/index.js', '../obligation-discharge/contracts.js', '../obligation-discharge/recorder.js']);
    const bridge = codeOf(join(EDGE, 'obligation-bridge.ts'));
    assert.match(bridge, /recorder\.record\(writer,/);
    assert.equal(/\bstate\s*:|verificationClass\s*:|'verified'|'waived'/.test(bridge), false, 'the bridge never names a lifecycle state or a verification class');
  });

  it('the generic settlement contract and edge name no rail and no protocol', () => {
    const forbidden = [/xrpl/i, /rlusd/i, /ledger_index|ledgerIndex/, /\bbolt11\b/i, /lightning/i, /preimage/i, /\bstripe\b/i, /\bbank\b/i, /\bmpp\b/i, /x402/i, /tx_?hash|transactionHash/i];
    for (const file of [...CONTRACT, ...EDGE_SOURCES]) {
      const text = readFileSync(file, 'utf8');
      for (const pattern of forbidden) assert.equal(pattern.test(text), false, `${file}: ${String(pattern)}`);
    }
  });

  it('no MPP / protocol import and no XRPL signer import anywhere in settlement', () => {
    for (const file of [...CONTRACT, ...EDGE_SOURCES, ...XRPL_FINALITY]) {
      for (const specifier of importsOf(file)) {
        assert.equal(/protocols\/|payment-protocol-ingress|mpp/.test(specifier), false, `${file} imports '${specifier}'`);
        assert.equal(/external-xrpl-signer|signer-http-transport|reference-xrpl-signer|signer-protocol/.test(specifier), false, `${file} imports '${specifier}'`);
      }
    }
  });
});

describe('PAY-05 structure — settlement observes; it never executes', () => {
  const EXECUTING = [
    /\.execute\s*\(/,
    /createPaymentRailExecutionAdapter|ExecutionAdapter\b|createGrantExecutionService|GrantExecutionService/,
    /\bsubmit\s*\(|autofill\s*\(|\bsign\s*\(|signedTransaction|XrplTransactionSigner/,
    /issueGrant|createBoundedGrant|KernelGrantCapability|\.issue\(/,
    /reserveExercise|exercise-control|ExerciseControl|reconcileResolution/,
    /recordTerminal|prepareAttempt|recordResolution|adoptResolutionAuthority|\.reconcile\(/,
    /\bretry\b|setInterval|setTimeout\(\s*(?!resolveDelay)/,
  ];

  it('no settlement source executes, signs, submits, issues, reserves, records P11 / P12 or retries', () => {
    for (const file of [...CONTRACT, ...EDGE_SOURCES, ...XRPL_FINALITY]) {
      const code = codeOf(file);
      for (const pattern of EXECUTING) assert.equal(pattern.test(code), false, `${file}: ${String(pattern)}`);
    }
  });

  it('only the refund service governs, and only through the existing orchestrator entry', () => {
    const governing = EDGE_SOURCES.filter((file) => /\.govern\s*\(/.test(codeOf(file)));
    assert.deepEqual(governing, [join(EDGE, 'refund-service.ts')]);
    const refund = codeOf(join(EDGE, 'refund-service.ts'));
    assert.equal([...refund.matchAll(/\.govern\s*\(/g)].length, 1);
    assert.ok(refund.indexOf('await ledger.reserve(') < refund.indexOf('orchestrator.govern('), 'the refundable balance is reserved before anything is governed');
    assert.match(refund, /purpose: 'refund'/);
  });

  it('the XRPL finality authority holds a read-only ledger: connect, server_info, validated index, tx, ledger header — nothing else', () => {
    const authority = codeOf('src/enterprise/xrpl-payment-rail/xrpl-finality-authority.ts');
    assert.match(authority, /Object\.freeze\(\{\s*connect:[\s\S]*serverInfo:[\s\S]*validatedLedgerIndex:[\s\S]*lookupTransaction:/);
    assert.equal(/\bsettle\s*\(|markUnconfirmed|reserve\s*\(/.test(authority), false, 'it never writes the interlock');
    assert.equal(/createXrplSdkClient|new Client/.test(authority), false, 'it opens no connection of its own: the client is composed');
  });

  it('settlement reads are local: the service asks an authority only inside verifyOnce', () => {
    const service = codeOf(join(EDGE, 'service.ts'));
    const calls = [...service.matchAll(/authority\.verify\(/g)];
    assert.equal(calls.length, 1);
    const verifyOnce = service.slice(service.indexOf('async function verifyOnce('), service.indexOf('function requestOf('));
    assert.ok(verifyOnce.includes('authority.verify('), 'the one query is in the explicit verification');
    const reads = service.slice(service.indexOf('async readSettlement('));
    assert.equal(reads.includes('authority.verify('), false);
  });
});

describe('PAY-05 structure — no custody, exact money', () => {
  it('no key, seed or signing material in any PAY-05 source; no floating-point money', () => {
    for (const file of [...CONTRACT, ...EDGE_SOURCES, ...XRPL_FINALITY]) {
      const code = codeOf(file);
      for (const pattern of [/\bWallet\b|fromSeed|fromSecret|fromMnemonic|deriveKeypair/, /privateKey\s*[:=(]|\bseed\s*[:=(]|mnemonic\s*[:=(]/i, /parseFloat\s*\(|toFixed\s*\(|Math\.round\s*\(/, /\bNumber\s*\(\s*(?:amount|value|original|counted)/]) {
        assert.equal(pattern.test(code), false, `${file}: ${String(pattern)}`);
      }
    }
  });

  it('CORE-07 gains exactly one protocol- and rail-neutral slot for refund accounting', () => {
    const checkpoint = readFileSync('src/enterprise/authority-state-freshness/checkpoint.ts', 'utf8');
    assert.match(checkpoint, /'payment-refund-state'(?:, '[a-z-]+')*\] as const/, 'PAY-05’s slot, followed only by later milestones’ slots (PAY-06: payment-initiation-reservations)');
    for (const file of walk('src/enterprise/authority-state-freshness')) {
      for (const specifier of importsOf(file)) assert.equal(/payment/.test(specifier), false, `${file} imports '${specifier}'`);
    }
  });

  it('nothing in PAY-05 is exported from a package entrypoint', () => {
    for (const entry of ['src/index.ts', 'src/enterprise/index.ts', 'src/runtime/index.ts', 'src/kernel/index.ts']) {
      if (existsSync(entry)) assert.equal(PAY05_IDENTIFIERS.test(readFileSync(entry, 'utf8')), false, entry);
    }
  });
});
