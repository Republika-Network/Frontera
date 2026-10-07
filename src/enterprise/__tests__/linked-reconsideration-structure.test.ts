import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';

import { GOVERNANCE_REFERENCE_TYPES, GOVERNANCE_STORE_SCHEMA_VERSION } from '../governance-store/contracts.js';

/**
 * LAND-01 structure — linked reconsideration is a rail-neutral governed-action
 * capability. Measured over the production sources with comments removed, so
 * prose never satisfies or violates a rule. Every detector is first shown to
 * match a real violation.
 */

function codeOf(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .map((line) => line.replace(/^\s*\/\/.*$/, '').replace(/\s\/\/\s.*$/, ''))
    .join('\n');
}
const importsOf = (file: string): readonly string[] => [...codeOf(file).matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)].map((match) => match[1] ?? '');

/** Every production file the capability lives in. */
const LAND01 = [
  'src/enterprise/governed-action/reconsideration-lineage.ts',
  'src/enterprise/governed-action/orchestrator.ts',
  'src/enterprise/governed-action/intent.ts',
  'src/enterprise/governed-action/contracts.ts',
  'src/enterprise/governed-action/decision-commit.ts',
  'src/enterprise/governed-action/execution-ledger.ts',
  'src/enterprise/governed-action/identifiers.ts',
  'src/enterprise/governance-store/contracts.ts',
  'src/enterprise/evidence/trace-builder.ts',
  'src/enterprise/evidence/trace-contracts.ts',
];

/** A rail, a transport, a demo composition, tooling, or destination governance. */
const FORBIDDEN_MODULE = /(^|\/)xrpl($|[-/])|execution-adapters\/xrpl|xrpl-testnet-transport|(^|\/)tools\/|andrew|destination-(runtime|registry|approval)/i;
/** Rail-, network- or demo-specific vocabulary in code (not prose). */
const RAIL_VOCABULARY = /xrpl|testnet|rlusd|lumx|andrew|wallet|ledger-?seed/i;

/** Relative `.js` specifiers resolved to their `.ts` sources, transitively. */
function closureOf(entry: string): ReadonlySet<string> {
  const seen = new Set<string>();
  const pending = [entry];
  while (pending.length > 0) {
    const file = pending.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const specifier of importsOf(file)) {
      if (!specifier.startsWith('.')) continue;
      const source = normalize(join(dirname(file), specifier.replace(/\.js$/, '.ts'))).replace(/\\/g, '/');
      if (existsSync(source)) pending.push(source);
    }
  }
  return seen;
}

describe('LAND-01 structure — linked reconsideration stays rail-neutral', () => {
  it('the detectors match real violations and not neighbours', () => {
    for (const bad of ['xrpl', '../execution-adapters/xrpl/index.js', '@aoc-enterprise/xrpl-testnet-transport', '../../tools/demo.js', '../andrew-demo/index.js', '../destination-registry/index.js', '../destination-approval/service.js', '../destination-runtime/index.js']) {
      assert.equal(FORBIDDEN_MODULE.test(bad), true, bad);
    }
    for (const fine of ['../governance-store/contracts.js', './identifiers.js', 'node:crypto', '../execution-runtime/index.js']) assert.equal(FORBIDDEN_MODULE.test(fine), false, fine);
    assert.equal(RAIL_VOCABULARY.test("counterpartyId: 'xrpl.testnet:r…'"), true);
    assert.equal(RAIL_VOCABULARY.test("reason: 'context-changed'"), false);
  });

  it('no LAND-01 file imports a rail, a transport, a demo, tooling or destination governance', () => {
    for (const file of LAND01) {
      const forbidden = importsOf(file).filter((specifier) => FORBIDDEN_MODULE.test(specifier));
      assert.deepEqual(forbidden, [], file);
    }
  });

  it('the lineage module’s whole import closure is the store contract, the identifiers and node:crypto — and it speaks no rail', () => {
    const closure = closureOf('src/enterprise/governed-action/reconsideration-lineage.ts');
    for (const file of closure) {
      assert.deepEqual(importsOf(file).filter((specifier) => FORBIDDEN_MODULE.test(specifier)), [], file);
    }
    const lineage = codeOf('src/enterprise/governed-action/reconsideration-lineage.ts');
    assert.equal(RAIL_VOCABULARY.test(lineage), false);
  });

  it('the public intent field is closed to `of` and `reason`: no approval, destination or governance state can ride on it', () => {
    const intent = codeOf('src/enterprise/governed-action/intent.ts');
    assert.match(intent, /key !== 'of' && key !== 'reason'/);
    const declared = /const DECLARED_KEYS[^=]*= new Set\(\[([^\]]*)\]\)/.exec(intent)?.[1] ?? '';
    assert.deepEqual(
      [...declared.matchAll(/'([^']+)'/g)].map((match) => match[1]),
      ['action', 'resource', 'counterparty', 'amount', 'parameters', 'expectedGovernanceProfile', 'assertedContext', 'correlationId', 'idempotencyKey', 'reconsideration'],
    );
  });

  it('the only new Governance Store write is an additive reference row: no schema, table or version change', () => {
    for (const file of LAND01) {
      const code = codeOf(file);
      assert.equal(/CREATE TABLE|ALTER TABLE|CHECK\s*\(/.test(code), false, file);
    }
    // The version every older runtime checks before reading a store is unchanged.
    assert.equal(GOVERNANCE_STORE_SCHEMA_VERSION, 'aoc.governance-store.schema.v1');
    assert.ok(GOVERNANCE_REFERENCE_TYPES.includes('reconsideration_link'));
    const ledger = codeOf('src/enterprise/governed-action/execution-ledger.ts');
    assert.equal((ledger.match(/referenceType: 'reconsideration_link'/g) ?? []).length, 2, 'the link row and the realization marker');
  });
});
