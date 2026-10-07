import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { GOVERNANCE_REFERENCE_TYPES, GOVERNANCE_STORE_SCHEMA_VERSION } from '../governance-store/contracts.js';

/**
 * LAND-02 structure — durable issuance-withheld evidence is a rail-neutral,
 * evidence-only governed-action capability. Measured over the production
 * sources with comments removed, so prose never satisfies or violates a rule.
 * Every detector is first shown to match a real violation.
 */

function codeOf(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .map((line) => line.replace(/^\s*\/\/.*$/, '').replace(/\s\/\/\s.*$/, ''))
    .join('\n');
}
const importsOf = (file: string): readonly string[] => [...codeOf(file).matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)].map((match) => match[1] ?? '');

const RECORD = 'src/enterprise/governed-action/issuance-record.ts';
const LEDGER = 'src/enterprise/governed-action/execution-ledger.ts';
const ORCHESTRATOR = 'src/enterprise/governed-action/orchestrator.ts';

/** Every production file LAND-02 touches. */
const LAND02 = [
  RECORD,
  LEDGER,
  ORCHESTRATOR,
  'src/enterprise/governed-action/identifiers.ts',
  'src/enterprise/governance-store/contracts.ts',
  'src/enterprise/execution-governance/contracts.ts',
  'src/enterprise/execution-governance/issuance-core.ts',
  'src/enterprise/evidence/trace-builder.ts',
  'src/enterprise/evidence/trace-contracts.ts',
];

/** A rail, a transport, a demo composition, tooling, or destination governance. */
const FORBIDDEN_MODULE = /(^|\/)xrpl($|[-/])|execution-adapters\/xrpl|xrpl-testnet-transport|(^|\/)tools\/|andrew|destination-(runtime|registry|approval|governance)/i;
/** Rail-, network-, wallet- or demo-specific vocabulary in code (not prose). */
const RAIL_VOCABULARY = /xrpl|testnet|rlusd|lumx|andrew|wallet|ledger-?seed|signed-?transaction/i;

/** The body of one method in the ledger's returned object: from its name to the next sibling at the same indent. */
function methodBody(code: string, name: string): string {
  const start = code.indexOf(`    async ${name}(`);
  assert.ok(start >= 0, name);
  const next = code.slice(start + 1).search(/\n {4}(async )?[A-Za-z]+\(|\n {2}\};/);
  return code.slice(start, next < 0 ? undefined : start + 1 + next);
}

describe('LAND-02 structure — issuance-withheld evidence stays rail-neutral and evidence-only', () => {
  it('the detectors match real violations and not neighbours', () => {
    for (const bad of ['xrpl', '../execution-adapters/xrpl/index.js', '@aoc-enterprise/xrpl-testnet-transport', '../../tools/demo.js', '../andrew-demo/index.js', '../destination-governance/service.js', '../destination-registry/index.js']) {
      assert.equal(FORBIDDEN_MODULE.test(bad), true, bad);
    }
    for (const fine of ['../governance-store/contracts.js', './identifiers.js', 'node:crypto', '../../features/monetary-runtime/index.js']) assert.equal(FORBIDDEN_MODULE.test(fine), false, fine);
    assert.equal(RAIL_VOCABULARY.test("const wallet = 'rXYZ'"), true);
    assert.equal(RAIL_VOCABULARY.test("withheldBy: 'authority-binding'"), false);
  });

  it('no LAND-02 file imports a rail, a transport, a demo, tooling or destination governance', () => {
    for (const file of LAND02) assert.deepEqual(importsOf(file).filter((specifier) => FORBIDDEN_MODULE.test(specifier)), [], file);
  });

  it('the issuance-record module is pure node:crypto and speaks no rail, wallet or payment vocabulary', () => {
    assert.deepEqual([...importsOf(RECORD)], ['node:crypto']);
    const code = codeOf(RECORD);
    assert.equal(RAIL_VOCABULARY.test(code), false);
    assert.equal(/payment|payee|settle/i.test(code), false, 'generic value / unit terms only');
    assert.equal(/\.(appendReference|appendEvaluation|issue|exercise|execute|revoke)\s*\(|Date\.now|new Date/.test(code), false, 'grammar, digest and parse only');
  });

  it('recording the evidence calls no adapter, issues or revokes nothing, and writes exactly one issuance row through the existing ledger', () => {
    const body = methodBody(codeOf(LEDGER), 'recordIssuanceWithheld');
    assert.equal(/\.(execute|exercise|issue|revoke|activate|release|reserve)\s*\(|adapter|grantStore/i.test(body), false, body);
    assert.equal((body.match(/appendOnce\(/g) ?? []).length, 1);
    assert.match(body, /referenceType: 'issuance_record'/);
    assert.match(body, /catch \{\s*return false;/, 'a failed write reports false; it never throws');
  });

  it('the orchestrator records issuance evidence only through the ledger, and a failure there cannot change the answer', () => {
    const code = codeOf(ORCHESTRATOR);
    assert.equal((code.match(/\.recordIssuanceWithheld\(/g) ?? []).length, 1, 'one call site: the withheld-at-issuance helper');
    assert.match(code, /\.recordIssuanceWithheld\([\s\S]*?\)\s*\.catch\(\(\) => false\);\s*return result\(\{ status: 'withheld', withheldBy, \.\.\.decided, reasonCodes \}\);/, 'the answer is built after, and independently of, the write');
    // Every pre-grant emergency, authority-binding, obligation or grant withholding goes through the helper — none is answered directly.
    for (const layer of ['emergency-control', 'authority-binding', 'obligations', 'grant']) {
      assert.equal(new RegExp(`result\\(\\{ status: 'withheld', withheldBy: '${layer}', \\.\\.\\.decided`).test(code), false, layer);
    }
    assert.ok(new RegExp(`result\\(\\{ status: 'withheld', withheldBy: 'emergency-control', \\.\\.\\.executed`).test(code), 'the detector matches the exercise-time form it deliberately leaves alone');
  });

  it('the trace reads the issuance rows through the existing evidence path: the record it already holds, never a new store read', () => {
    const builder = codeOf('src/enterprise/evidence/trace-builder.ts');
    assert.match(builder, /references\.filter\(\(entry\) => entry\.referenceType === 'issuance_record'\)/);
    assert.equal(/recordIssuanceWithheld|appendReference/.test(builder), false);
  });

  it('the only new Governance Store write is an additive reference type: no schema, table, CHECK or version change', () => {
    for (const file of LAND02) assert.equal(/CREATE TABLE|ALTER TABLE|CHECK\s*\(/.test(codeOf(file)), false, file);
    assert.equal(GOVERNANCE_STORE_SCHEMA_VERSION, 'aoc.governance-store.schema.v1');
    assert.equal(GOVERNANCE_REFERENCE_TYPES.at(-1), 'issuance_record', 'appended, never reordered');
  });
});
