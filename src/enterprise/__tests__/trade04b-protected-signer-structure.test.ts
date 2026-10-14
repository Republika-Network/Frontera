import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { readExecutionAdapterResult } from '../../features/execution-runtime/index.js';
import { EXTERNAL_XRPL_SIGNER_OPERATION, EXTERNAL_XRPL_SIGNER_PATHS, EXTERNAL_XRPL_SIGNER_PROTOCOL, parsePreparedXrplPayment } from '../xrpl-payment-rail/signer-protocol.js';
import {
  DELEGATED_OFFER_SIGNER_FAILURE_REASONS,
  DELEGATED_OFFER_SIGNER_OPERATION,
  DELEGATED_OFFER_SIGNER_PATHS,
  DELEGATED_OFFER_VERIFICATION_FAILURES,
  createDelegatedOfferSigner,
  type DelegatedOfferSigningPort,
  type VerifiedDelegatedOfferSignature,
} from '../xrpl-trade-rail/index.js';
import { createReferenceDelegatedOfferSignerService } from '../xrpl-trade-rail/reference/reference-delegated-offer-signer.js';
import { AUDIT, offerWorld } from './trade04b-xrpl-fixture.js';

/**
 * TRADE-04B — the security invariants of the protected delegated signer
 * (SEC-TRADE04B-01 … -24), enforced over the repository's current source, and
 * the future-integration characterization (adversarial matrix F).
 *
 * TRADE-local numbering, like TRADE-04A's: no global SEC-INV range is
 * allocated (`docs/security/SECURITY_INVARIANTS.md` is not extended by this
 * milestone; `TRADE-04B-PROTECTED-DELEGATED-SIGNER.md` §20). Behavioral
 * evidence lives in the sibling `trade04b-*.test.ts` files; this file pins
 * the structure that keeps it true for every future change.
 *
 * Every scan is a pure predicate over (path, text); the negative fixtures at
 * the end run them over synthetic violations, so a scan that silently
 * matches nothing fails here.
 */

const EDGE = 'src/enterprise/xrpl-trade-rail';
const REFERENCE = `${EDGE}/reference/reference-delegated-offer-signer.ts`;
const LAUNCHER = 'scripts/run-reference-xrpl-offer-signer.mjs';
const BENCH = 'scripts/trade/bench-delegated-offer-signer.mjs';
const SKIPPED = new Set(['node_modules', 'dist', 'dist-test', '.next', '.git', 'vendor']);

interface Source {
  readonly path: string;
  readonly text: string;
}

function walk(dir: string, includeTests = false): readonly string[] {
  if (!existsSync(dir)) return [];
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

const read = (path: string): Source => ({ path, text: readFileSync(path, 'utf8') });
const codeOf = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
/** Code with string and template literals blanked: what the code *does*, not what its messages say. */
const logicOf = (text: string): string => codeOf(text).replace(/'(?:[^'\\\n]|\\.)*'/g, "''").replace(/`(?:[^`\\]|\\.)*`/g, '``');
const importsOf = (text: string): readonly string[] =>
  [...codeOf(text).matchAll(/\bfrom\s+['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]|\brequire\s*\(\s*['"]([^'"]+)['"]/g)].map((match) => match[1] ?? match[2] ?? match[3] ?? '');

const EDGE_SOURCES = walk(EDGE).map(read);
const HOST_SIDE = EDGE_SOURCES.filter((source) => source.path !== REFERENCE);
const PRODUCTION = ['src', 'packages', 'scripts', 'apps'].flatMap((root) => walk(root)).map(read);

type Scan = (sources: readonly Source[]) => readonly string[];

/** Each edge file's imports, against its own allowlist. The reference may additionally import the SDK's `Wallet`/`ECDSA` and the filesystem. */
const HOST_IMPORTS = /^(?:\.\/[a-z-]+\.js|\.\.\/external-authority-signer\/http-transport\.js|\.\.\/\.\.\/features\/trade-runtime\/index\.js|\.\.\/\.\.\/features\/xrpl-transport\/(?:index|xrpl-signature)\.js|node:(?:crypto|http|https))$/;
const REFERENCE_IMPORTS = /^(?:\.\.\/delegated-offer-(?:protocol|verification)\.js|xrpl|node:(?:crypto|fs|http|net))$/;
const disallowedImports: Scan = (sources) =>
  sources.flatMap((source) =>
    importsOf(source.text)
      .filter((specifier) => !(source.path.endsWith('/reference/reference-delegated-offer-signer.ts') ? REFERENCE_IMPORTS : HOST_IMPORTS).test(specifier))
      .map((specifier) => `${source.path} imports '${specifier}'`),
  );

/** Submission, ledger connection, autofill — anything that reaches an XRPL server. */
const SUBMISSION = [/\.submit\s*\(|submitAndWait|\bautofill\s*\(/, /command:\s*['"](?:submit|submit_multisigned|sign|sign_for)['"]/, /\bnew\s+Client\s*\(|\bClient\b/, /wss?:\/\/|WebSocket|\bfetch\s*\(/, /createXrplSdkClient|createXrplRlusdRail|createSqliteXrplSubmissionInterlock|assertXrplSequenceOwnership|createXrplValidatedLedgerReader/];
const submission: Scan = (sources) => sources.flatMap((source) => SUBMISSION.filter((pattern) => pattern.test(codeOf(source.text))).map((pattern) => `${source.path}: ${String(pattern)}`));

/** Key custody: wallets, seeds, key derivation. Only the reference process may hold them. */
const CUSTODY = /\bWallet\b|fromSeed|fromSecret|fromMnemonic|fromEntropy|deriveKeypair|generateSeed|privateKey|ripple-keypairs|secret-numbers|\bseed\b/i;
const custody: Scan = (sources) => sources.filter((source) => CUSTODY.test(logicOf(source.text))).map((source) => source.path);

/** A signing capability that is not the one closed operation: raw bytes, arbitrary transactions, multisigning, key export. */
const ARBITRARY = /signArbitrary|signBytes|signRaw|signTransaction\b|signPayload|sign_for|multisign|exportKey|getSeed|\/v1\/(?:export|seed|keys?)\b/i;
const arbitrary: Scan = (sources) => sources.filter((source) => ARBITRARY.test(codeOf(source.text))).map((source) => source.path);

/** Logging: nothing in the edge writes to a log or the console. */
const LOGGING = /\bconsole\.|\blogger\b|\.log\s*\(|process\.std(?:out|err)/;
const logging: Scan = (sources) => sources.filter((source) => LOGGING.test(codeOf(source.text))).map((source) => source.path);

/** Who reaches the edge, by path. */
const edgeImporters: Scan = (sources) => sources.filter((source) => !source.path.startsWith(`${EDGE}/`) && /xrpl-trade-rail/.test(codeOf(source.text))).map((source) => source.path);

describe('TRADE-04B — the edge is what it says (SEC-TRADE04B-01, -12, -13, -16, -24)', () => {
  it('has exactly the TRADE-04B files', () => {
    assert.deepEqual(
      EDGE_SOURCES.map((source) => source.path.slice(EDGE.length + 1)).sort(),
      ['delegated-offer-protocol.ts', 'delegated-offer-signer-transport.ts', 'delegated-offer-signer.ts', 'delegated-offer-verification.ts', 'index.ts', 'reference/reference-delegated-offer-signer.ts'],
    );
  });

  it('imports only its allowlist: TRADE-01’s barrel, the shared transport (barrel and G3 codec file), CORE-02’s endpoint rules, and Node — the reference adds the SDK and the filesystem', () => {
    assert.deepEqual(disallowedImports(EDGE_SOURCES), []);
    const sdk = [...codeOf(readFileSync(REFERENCE, 'utf8')).matchAll(/^\s*import\s*\{([^}]*)\}\s*from\s*'xrpl';/gm)].map((match) => (match[1] ?? '').split(',').map((name) => name.trim()).filter(Boolean).sort());
    assert.deepEqual(sdk, [['ECDSA', 'Wallet']], 'the reference takes Wallet and ECDSA from the SDK — never a Client');
  });

  it('SEC-TRADE04B-01/24: one operation, two paths; no arbitrary-transaction, raw-byte, multisign or key-export capability anywhere in the edge', () => {
    assert.equal(DELEGATED_OFFER_SIGNER_OPERATION, 'sign-xrpl-delegated-offer');
    assert.deepEqual(Object.values(DELEGATED_OFFER_SIGNER_PATHS).sort(), ['/v1/identity', '/v1/sign/xrpl-delegated-offer']);
    assert.deepEqual(arbitrary(EDGE_SOURCES), []);
    const client = codeOf(readFileSync(`${EDGE}/delegated-offer-signer.ts`, 'utf8'));
    const port = /export interface DelegatedOfferSigningPort \{([\s\S]*?)\n\}/.exec(client)?.[1] ?? '';
    assert.deepEqual([...port.matchAll(/^\s*(\w+)\s*\(/gm)].map((match) => match[1]), ['signDelegatedOffer'], 'the TRADE-04C port has exactly one method');
    assert.equal([...client.matchAll(/transport\.signDelegatedOffer\(/g)].length, 1, 'one signing call site');
    const reference = codeOf(readFileSync(REFERENCE, 'utf8'));
    assert.equal([...reference.matchAll(/\.wallet\.sign\(/g)].length, 1, 'the reference signs from exactly one place');
    const sign = reference.slice(reference.indexOf('function sign(body: Buffer)'), reference.indexOf('function answer('));
    const order = ['parseDelegatedOfferSigningRequest(parsed)', 'wallets.get(', 'seenRequestIds.has(', 'maximumFeeDrops', '.wallet.sign(', 'verifySignedDelegatedOffer('].map((marker) => sign.indexOf(marker));
    assert.ok(order.every((position) => position !== -1), JSON.stringify(order));
    assert.deepEqual([...order].sort((a, b) => a - b), order, 'every refusal precedes the key; the reference verifies its own output');
  });

  it('SEC-TRADE04B-12/16: no submission, ledger connection, autofill, interlock, sequence-domain composition or validated-reader composition anywhere in the edge — and no Testnet or Mainnet write path', () => {
    assert.deepEqual(submission(EDGE_SOURCES), []);
    for (const source of EDGE_SOURCES) assert.equal(/faucet|fundWallet|xrp-ledger-mainnet|mainnet/i.test(logicOf(source.text)), false, source.path);
  });

  it('SEC-TRADE04B-13/02: the Host-side files hold no key, seed or wallet — and nothing anywhere asks for an owner key', () => {
    assert.deepEqual(custody(HOST_SIDE), []);
    assert.deepEqual(custody(EDGE_SOURCES), [REFERENCE], 'only the reference process holds keys');
    for (const source of EDGE_SOURCES) assert.equal(/ownerSeed|ownerKey|ownerSecret|ownerPrivate/i.test(source.text), false, source.path);
  });

  it('SEC-TRADE04B-14: nothing in the edge logs; the launcher prints public identity only, never the credential or the key file’s contents', () => {
    assert.deepEqual(logging(EDGE_SOURCES), []);
    const launcher = codeOf(readFileSync(LAUNCHER, 'utf8'));
    for (const line of launcher.split('\n').filter((text) => /console\.(?:log|error)/.test(text))) assert.equal(/credential|seed|keys\b|TOKEN/.test(line), false, line.trim());
    assert.equal(/process\.argv[\s\S]{0,200}seed/i.test(launcher), false, 'no seed from the command line');
  });

  it('SEC-TRADE04B-19: the transport makes one attempt per call and follows no redirect; plain http only to a literal loopback', () => {
    const transport = readFileSync(`${EDGE}/delegated-offer-signer-transport.ts`, 'utf8');
    const logic = logicOf(transport);
    assert.equal(/\bfor\s*\(|\bwhile\s*\(|retry|attempts?\b|maxAttempts|location|follow/i.test(logic), false);
    assert.equal([...logic.matchAll(/\bsend\s*\(/g)].length, 1);
    assert.match(codeOf(transport), /agent: false/);
    assert.match(codeOf(transport), /plain http is accepted only to a literal loopback address/);
  });

  it('SEC-TRADE04B-18: the reference binds a literal loopback address only, checked before a socket opens', () => {
    const reference = codeOf(readFileSync(REFERENCE, 'utf8'));
    const start = reference.slice(reference.indexOf('export async function startReferenceDelegatedOfferSigner('));
    assert.ok(start.indexOf('isReferenceSignerLoopbackHost(host)') !== -1 && start.indexOf('isReferenceSignerLoopbackHost(host)') < start.indexOf('createServer('));
  });
});

describe('TRADE-04B — no new path to the signer, and Payment unchanged (SEC-TRADE04B-15, -21, -22; F)', () => {
  it('SEC-TRADE04B-21 / F: nothing outside the edge reaches it but its launcher and its benchmark — no Host module, route, configuration, composition or package export', () => {
    assert.deepEqual([...edgeImporters(PRODUCTION)].sort(), [BENCH, LAUNCHER].sort());
    const launcher = codeOf(readFileSync(LAUNCHER, 'utf8'));
    assert.deepEqual([...launcher.matchAll(/from '([^']+)'/g)].map((match) => match[1]), ['../dist/src/enterprise/xrpl-trade-rail/reference/reference-delegated-offer-signer.js']);
    for (const entry of ['src/index.ts', 'src/enterprise/index.ts', 'src/runtime/index.ts', 'src/kernel/index.ts', 'src/kernel-host/index.ts', 'src/enterprise/host/enterprise-host.ts', 'src/enterprise/host/host-configuration.ts']) {
      if (existsSync(entry)) assert.equal(/xrpl-trade-rail|DelegatedOffer/.test(readFileSync(entry, 'utf8')), false, entry);
    }
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { readonly exports?: unknown; readonly scripts?: Record<string, string> };
    assert.equal(/xrpl-trade-rail|offer-signer/.test(JSON.stringify(pkg.exports ?? {})), false);
    assert.equal(/xrpl-trade-rail/.test(JSON.stringify(pkg.scripts ?? {})), false);
  });

  it('F: the benchmark composes only the loopback reference signer — never an external endpoint', () => {
    const bench = codeOf(readFileSync(BENCH, 'utf8'));
    for (const match of bench.matchAll(/endpoint:\s*`([^`]*)`/g)) assert.match(match[1] ?? '', /^http:\/\/127\.0\.0\.1:/);
    assert.equal(/https:\/\/|wss?:\/\/|process\.env/.test(bench), false);
  });

  it('SEC-TRADE04B-15/22: the Payment signer protocol is unchanged, Payment-only, and does not know the trade protocol', () => {
    assert.equal(EXTERNAL_XRPL_SIGNER_PROTOCOL, 'frontera.external-xrpl-transaction-signer.v1');
    assert.equal(EXTERNAL_XRPL_SIGNER_OPERATION, 'sign-xrpl-payment');
    assert.deepEqual(Object.values(EXTERNAL_XRPL_SIGNER_PATHS).sort(), ['/v1/identity', '/v1/sign/xrpl-payment']);
    const world = offerWorld();
    assert.equal(parsePreparedXrplPayment(world.offer()), undefined, 'a delegated OfferCreate is not a Payment');
    for (const file of walk('src/enterprise/xrpl-payment-rail')) assert.equal(/xrpl-trade-rail|DelegatedOffer|delegated-offer/.test(readFileSync(file, 'utf8')), false, file);
    for (const file of walk('src/features/payment-runtime')) assert.equal(/xrpl-trade-rail|DelegatedOffer|OfferCreate/.test(codeOf(readFileSync(file, 'utf8'))), false, file);
  });

  it('SEC-TRADE04B-21: TRADE itself still signs, submits and holds nothing, and TRADE-04A’s sequence-safety tripwire is intact', () => {
    for (const source of walk('src/features/trade-runtime').map(read)) assert.equal(/xrpl-trade-rail|delegated-offer|\bsign\s*\(/.test(codeOf(source.text)), false, source.path);
    for (const source of EDGE_SOURCES) assert.equal(/assertXrplSequenceOwnership|XrplSequenceAuthority|interlock/i.test(logicOf(source.text)), false, source.path);
  });

  it('F: a signed blob is never a completed governed action — the execution path reads it as no adapter result at all', () => {
    const signature: VerifiedDelegatedOfferSignature = {
      kind: 'xrpl-delegated-offer-signature',
      status: 'signed-not-submitted',
      signerId: 's',
      requestId: 'ab'.repeat(32),
      network: 'xrp-ledger-testnet',
      ownerAccount: 'o',
      delegateAccount: 'd',
      signingPublicKey: 'k',
      transaction: offerWorld().offer(),
      signedTransaction: 'AB',
      hash: 'CD',
      audit: AUDIT,
    };
    assert.equal(readExecutionAdapterResult(signature), undefined);
    // @ts-expect-error — a VerifiedDelegatedOfferSignature is not an ExecutionAdapterResult: it has no outcome.
    const asResult: import('../../features/execution-runtime/index.js').ExecutionAdapterResult = signature;
    assert.ok(asResult !== undefined);
  });

  it('F: a typed TRADE-04C consumer composes the port, and gets only a signed-not-submitted value — no execution adapter is introduced', async () => {
    const world = offerWorld();
    const credential = 'trade04b-structure-credential-0123456789';
    const service = createReferenceDelegatedOfferSignerService({ signerId: 'ref-f', network: 'xrp-ledger-testnet', credential, keys: [{ ownerAccount: world.owner, delegateSeed: world.delegate.seed }], maximumFeeDrops: '100' });
    const call = (path: string, method: string, body?: unknown): unknown => JSON.parse(JSON.stringify(service.answer({ method, path, authorization: `Bearer ${credential}`, contentType: 'application/json', body: Buffer.from(body === undefined ? '' : JSON.stringify(body)) }).body));
    const port: DelegatedOfferSigningPort = createDelegatedOfferSigner({
      transport: { identity: async () => call('/v1/identity', 'GET'), signDelegatedOffer: async (request) => call('/v1/sign/xrpl-delegated-offer', 'POST', request) },
      pin: { signerId: 'ref-f', network: 'xrp-ledger-testnet', pairs: [world.pair] },
      timeoutMs: 1_000,
      maximumFeeDrops: '100',
      maximumLedgerHorizon: 40,
    });
    // What a future executor does with it: hold it until its own reservation and single submission (TRADE-04C) — nothing here goes further.
    const futureExecutorStep = async (signing: DelegatedOfferSigningPort): Promise<{ readonly readyForReservation: string }> => {
      const signed = await signing.signDelegatedOffer({ transaction: world.offer(), audit: AUDIT, validatedLedgerIndex: 1_000 });
      return { readyForReservation: signed.hash };
    };
    assert.match((await futureExecutorStep(port)).readyForReservation, /^[0-9A-F]{64}$/);
    assert.equal(PRODUCTION.some((source) => source.path.startsWith(`${EDGE}/`) && /ExecutionAdapter|execute\s*\(|\.govern\s*\(|BoundedGrant|issueFromDecision/.test(codeOf(source.text))), false, 'no execution adapter, orchestrator call or grant handling in the edge');
  });

  it('SEC-TRADE04B-20: no signing failure or result can be read as a transaction result — no engine-result, submission or settlement vocabulary', () => {
    for (const reason of [...DELEGATED_OFFER_SIGNER_FAILURE_REASONS, ...DELEGATED_OFFER_VERIFICATION_FAILURES]) assert.equal(/^(?:tes|tec|tef|tel|tem|ter)|SUBMIT|SETTLE|FILLED|VALIDATED|SUCCESS/i.test(reason), false, reason);
    const client = codeOf(readFileSync(`${EDGE}/delegated-offer-signer.ts`, 'utf8'));
    assert.match(client, /readonly status: 'signed-not-submitted';/);
  });
});

describe('TRADE-04B — tests (SEC-TRADE04B-16)', () => {
  it('TRADE-04B tests open no network beyond loopback: no XRPL endpoint, no SDK client, no faucet', () => {
    const self = 'src/enterprise/__tests__/trade04b-protected-signer-structure.test.ts';
    const files = walk('src/enterprise/__tests__', true).filter((path) => /\/trade04b-/.test(path) && path !== self);
    assert.ok(files.length >= 6, `found ${files.length}`);
    for (const file of files) {
      const code = codeOf(readFileSync(file, 'utf8'));
      assert.equal(/['"`]wss?:\/\/|\bnew\s+Client\s*\(|fundWallet|faucet|createXrplSdkClient/i.test(code), false, file);
      for (const match of code.matchAll(/\.listen\(\s*\w+\s*,\s*'([^']+)'/g)) assert.equal(match[1], '127.0.0.1', file);
    }
  });
});

describe('TRADE-04B — negative fixtures: every scan fails on a synthetic violation', () => {
  const fixture = (path: string, text: string): readonly Source[] => [{ path, text }];
  // Assembled at runtime so repository-wide scanners do not count these samples as real sites.
  it('a disallowed import in the edge is caught; the reference’s own allowlist is narrower than it looks', () => {
    for (const specifier of ['../xrpl-payment-rail/signer-protocol.js', '../../features/payment-runtime/index.js', 'xrpl', 'node:' + 'net', '../host/enterprise-host.js']) {
      assert.equal(disallowedImports(fixture(`${EDGE}/x.ts`, `import { x } from '${specifier}';`)).length, 1, specifier);
    }
    assert.equal(disallowedImports(fixture(REFERENCE, "import { x } from '../../features/payment-runtime/index.js';")).length, 1);
    assert.deepEqual(disallowedImports(fixture(`${EDGE}/x.ts`, "import { x } from './delegated-offer-protocol.js';")), []);
  });

  it('submission, custody, arbitrary signing, logging and an outside importer are each caught', () => {
    for (const text of ['await client.' + 'submit(blob);', ['const c = new', 'Client(url);'].join(' '), ['await c.request({ command:', "'sub" + "mit' });"].join(' '), 'createSqliteXrplSubmissionInterlock' + '(p);', 'assertXrplSequenceOwnership' + '([]);']) {
      assert.ok(submission(fixture(`${EDGE}/x.ts`, text)).length > 0, text);
    }
    for (const text of [['const w = Wallet.', 'fromSeed(v);'].join(''), 'const seed = read();', 'const privateKey = k;']) assert.equal(custody(fixture(`${EDGE}/x.ts`, text)).length, 1, text);
    for (const text of ['export function signArbitrary' + 'Transaction() {}', 'route("/v1/export' + '-key")', 'wallet.multi' + 'sign(tx)']) assert.equal(arbitrary(fixture(`${EDGE}/x.ts`, text)).length, 1, text);
    for (const text of ['console.' + "log('x');", 'logger.' + "info('x');"]) assert.equal(logging(fixture(`${EDGE}/x.ts`, text)).length, 1, text);
    const specifier = ['..', 'xrpl-trade-rail', 'index.js'].join('/');
    assert.equal(edgeImporters(fixture('src/enterprise/host/x.ts', `import { x } from '${specifier}';`)).length, 1);
  });
});
