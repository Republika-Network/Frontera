import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

/**
 * TRADE-04D — the recovery surface, enforced structurally. Pure predicates
 * over source text (comments stripped), each with a negative fixture proving
 * it detects what it guards:
 *
 * - the four recovery modules hold no write: no settle, reserve, claim,
 *   submit, signing call or capability issuance;
 * - the coordinator's ledger view has exactly six reads, and the composed
 *   `recovery()` is handed the interlock's `read` and `health` only;
 * - no route, server or API module names the recovery surface;
 * - the assessment and the coordinator read no clock and take no grant or
 *   capability expiry as input;
 * - the operator diagnostic projects no amount, price, key or credential;
 * - the executor and the P12 authority read the ledger through the trade
 *   evidence contract, which wraps the shared transport's qualified readers
 *   (never a replacement);
 * - the signer ledger is never created implicitly, and the launcher's serve
 *   path never initializes one.
 */

const EDGE = 'src/enterprise/xrpl-trade-execution';
const RECOVERY = ['trade-ledger-evidence.ts', 'trade-offer-state.ts', 'trade-recovery-assessment.ts', 'trade-recovery-coordinator.ts'].map((file) => `${EDGE}/${file}`);
const codeOf = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
const code = (path: string): string => codeOf(readFileSync(path, 'utf8'));

const WRITE = /\.settle\s*\(|\.markUnconfirmed\s*\(|\.reserve\s*\(|claimSubmission|submitReserved|\.submit\s*\(|signDelegatedOffer|\.issue\s*\(|\.consume\s*\(|\.markSigned\s*\(|\.markFailed\s*\(|INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM/i;
const CLOCK = /Date\.now|new Date\b|performance\.now|\bnow\s*\(|expiresAt|notAfter|\brevoked\b/;
const AMOUNTS = /takerGets|takerPays|TakerGets|TakerPays|price|quantity|amount/;

function walk(dir: string): readonly string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (['node_modules', 'dist', '__tests__', 'tests'].includes(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.(?:ts|mjs|js)$/.test(full) && !full.includes('.test.')) out.push(full);
  }
  return out;
}

describe('TRADE-04D structure — the recovery modules are read-only', () => {
  it('no settle, reserve, claim, submit, signing, issuance, consumption or SQL write in any recovery module (negative fixture: each pattern detects)', () => {
    for (const path of RECOVERY) assert.equal(WRITE.test(code(path)), false, path);
    for (const fixture of ['interlock.settle(a)', 'x.reserve(y)', 'claimSubmission', 'ledger.submitReserved(', 'signer.signDelegatedOffer(', 'issuer.issue({', 'INSERT INTO t']) assert.equal(WRITE.test(fixture), true, fixture);
  });

  it('the coordinator’s ledger view has exactly six reads; the composed recovery() gets the interlock’s read and health only', () => {
    const coordinator = code(`${EDGE}/trade-recovery-coordinator.ts`);
    const view = coordinator.slice(coordinator.indexOf('export function readOnlyTradeRecoveryLedger('), coordinator.indexOf('export interface TradeRecoveryCoordinatorOptions'));
    assert.deepEqual([...view.matchAll(/^\s+(\w+): \(/gm)].map((match) => match[1]), ['connect', 'serverInfo', 'validatedLedgerIndex', 'lookupTransaction', 'ledgerHeader', 'ledgerEntry']);
    const composition = code(`${EDGE}/host-composition.ts`);
    assert.match(composition, /ledger: readOnlyTradeRecoveryLedger\(resolverClient\),\s*interlock: \{ read: \(executionId: string\) => interlock\.read\(executionId\), health: \(\) => interlock\.health\(\) \}/);
  });

  it('no route: no API, server, adapter or control-plane module names the recovery surface', () => {
    const production = ['src', 'packages', 'apps'].flatMap(walk);
    for (const path of production.filter((entry) => /src\/enterprise\/(?:api|adapters|operator-control|operations|host\/enterprise-server)|src\/control-plane-web\//.test(entry))) {
      assert.equal(/createTradeRecoveryCoordinator|TradeRecoveryDiagnostic|assessTradeRecovery|\.recovery\(/.test(readFileSync(path, 'utf8')), false, path);
    }
  });

  it('the assessment and the coordinator read no clock and no expiry or revocation input (negative fixture)', () => {
    for (const path of [`${EDGE}/trade-recovery-assessment.ts`, `${EDGE}/trade-recovery-coordinator.ts`, `${EDGE}/trade-offer-state.ts`, `${EDGE}/trade-ledger-evidence.ts`]) assert.equal(CLOCK.test(code(path)), false, path);
    assert.equal(CLOCK.test('const t = Date.now();'), true);
  });

  it('the operator diagnostic projects no amount, price or quantity, and no key, credential or blob field', () => {
    const coordinator = code(`${EDGE}/trade-recovery-coordinator.ts`);
    const projection = coordinator.slice(coordinator.indexOf('export function diagnosticOf('));
    const shape = coordinator.slice(coordinator.indexOf('export interface TradeRecoveryDiagnostic'), coordinator.indexOf('export interface TradeRecoveryReport'));
    for (const text of [projection, shape]) {
      assert.equal(AMOUNTS.test(text), false);
      assert.equal(/seed|secret|credential|token|privateKey|signedTransaction|blob/i.test(text), false);
    }
    assert.equal(AMOUNTS.test('offer.takerGets'), true);
  });
});

describe('TRADE-04D structure — the evidence contract wraps, never replaces, the qualified transport readers', () => {
  it('the evidence module calls readXrplInclusion and xrplNonInclusionProven; the executor and the P12 authority read through it', () => {
    const evidence = code(`${EDGE}/trade-ledger-evidence.ts`);
    assert.match(evidence, /readXrplInclusion\)?\(raw, identity\.transactionHash\)|readXrplInclusion\(raw, identity\.transactionHash\)/);
    assert.match(evidence, /xrplNonInclusionProven\(reading, before, identity\.lastLedgerSequence\)/);
    const executor = code(`${EDGE}/trade-offer-executor.ts`);
    assert.match(executor, /readTradeInclusion\(await ledger\.lookupTransaction\(\{ hash, \.\.\.window \}/);
    assert.match(executor, /xrplNonInclusionProven\(reading, before, window\.maxLedger\)/);
    assert.equal(/readXrplInclusion\(/.test(executor), false, 'the executor no longer reads an unbound answer');
    const resolver = code(`${EDGE}/trade-resolution-authority.ts`);
    assert.match(resolver, /readTradeLedgerEvidence\(ledger, tradeTransactionIdentityOf\(record\)/);
    assert.equal(/readXrplInclusion\(/.test(resolver), false);
  });

  it('the shared transport is unchanged by TRADE-04D (no file added; the two readers keep their qualified bodies)', () => {
    assert.deepEqual(readdirSync('src/features/xrpl-transport').filter((name) => name.endsWith('.ts')).sort(), ['index.ts', 'xrpl-ledger-grammar.ts', 'xrpl-network-identity.ts', 'xrpl-restart-quarantine.ts', 'xrpl-sequence-safety.ts', 'xrpl-signature.ts', 'xrpl-submission-reading.ts', 'xrpl-validated-ledger-reader.ts', 'xrpl-validated-ledger.ts']);
    const reading = code('src/features/xrpl-transport/xrpl-submission-reading.ts');
    assert.match(reading, /return reading\.kind === 'not-found-complete' && validatedIndexBeforeLookup !== undefined && xrplWindowClosed\(validatedIndexBeforeLookup, lastLedgerSequence\);/);
    assert.match(reading, /if \(error === 'txnNotFound'\) return result\['searched_all'\] === true \? \{ kind: 'not-found-complete' \} : \{ kind: 'pending' \};/);
  });
});

describe('TRADE-04D structure — the customer signer ledger is never recreated implicitly', () => {
  it('a non-create open passes fileMustExist and refuses a missing file first; the launcher’s serve path never initializes a ledger', () => {
    const ledger = code('src/enterprise/xrpl-trade-rail/reference/reference-capability-ledger.ts');
    assert.match(ledger, /if \(!existsSync\(file\) && !create\) \{/);
    assert.match(ledger, /new Database\(file, create \? \{\} : \{ fileMustExist: true \}\)/);
    const signer = code('src/enterprise/xrpl-trade-rail/reference/reference-delegated-offer-signer.ts');
    assert.match(signer, /openReferenceCapabilityLedger\(options\.consumptionLedgerPath, \{ create: options\.createConsumptionLedger === true \}\)/);
    const launcher = code('scripts/run-reference-xrpl-offer-signer.mjs');
    const serve = launcher.slice(launcher.indexOf("const keyFile = required('FRONTERA_REFERENCE_XRPL_OFFER_SIGNER_KEY_FILE');"));
    assert.equal(/initializeReferenceCapabilityLedger|createConsumptionLedger|create:\s*true/.test(serve), false, 'serving never creates a ledger');
  });
});
