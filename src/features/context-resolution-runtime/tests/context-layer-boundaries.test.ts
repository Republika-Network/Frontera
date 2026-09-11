import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import * as contextRuntime from '../index.js';

/**
 * Layer C's contract, enforced structurally rather than by review.
 *
 * `ADR-AUTHORITY-CONTROL-LAYERING.md` names three mechanisms and explains why
 * three rather than one: "a type rule stops the obvious mistake, an import rule
 * stops the clever one, and a determinism test stops the accidental one." All
 * three are exercised here, against the TypeScript sources rather than the
 * build output, matching the convention `structural-boundaries.test.ts`
 * established.
 */

const ROOT = 'src/features/context-resolution-runtime';

function sourceFiles(dir: string, includeTests = false): readonly string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (!includeTests && name === 'tests') continue;
      out.push(...sourceFiles(full, includeTests));
    } else if (full.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

const PRODUCTION_SOURCES = sourceFiles(ROOT);

describe('Context layer boundaries — C never imports B, D, E or the Kernel', () => {
  it('the runtime has real production sources to measure', () => {
    assert.ok(PRODUCTION_SOURCES.length >= 8, `expected the context runtime to have production sources, found ${PRODUCTION_SOURCES.length}`);
  });

  it('imports nothing from the policy runtime, the enforcement engine, the Kernel or the Enterprise host', () => {
    const forbidden = [
      /from ['"][^'"]*domain-policy-pack-runtime/,
      /from ['"][^'"]*policy-pack-foundation/,
      /from ['"][^'"]*action-enforcement/,
      /from ['"][^'"]*\/kernel\//,
      /from ['"][^'"]*\/enterprise\//,
      /from ['"][^'"]*\/runtime\//,
      /from ['"][^'"]*intelligence-advisory/,
    ];
    for (const file of PRODUCTION_SOURCES) {
      const text = readFileSync(file, 'utf8');
      for (const pattern of forbidden) {
        assert.equal(pattern.test(text), false, `${file} must not import across the layer boundary (${String(pattern)})`);
      }
    }
  });

  it('reaches no external system on its own: no network, no filesystem, no process, no database client', () => {
    const forbidden = [/from ['"]node:fs['"]/, /from ['"]node:http/, /from ['"]node:net['"]/, /from ['"]node:child_process['"]/, /\bfetch\s*\(/, /better-sqlite3/];
    for (const file of PRODUCTION_SOURCES) {
      const text = readFileSync(file, 'utf8');
      for (const pattern of forbidden) {
        assert.equal(pattern.test(text), false, `${file} must not perform I/O of its own (${String(pattern)}) — a resolver does that, behind the port`);
      }
    }
  });
});

describe('Context layer boundaries — the facts layer cannot decide', () => {
  it('no production source constructs an allow, a deny or a kernel decision status', () => {
    const forbidden = [
      /\ballowed\s*:/,
      /\bdenied\s*:/,
      /\bKernelDecisionStatus\b/,
      /\bPolicyEffect\b/,
      /\bEnforcementDecision\b/,
      /'approval_required'/,
      /'indeterminate'/,
    ];
    for (const file of PRODUCTION_SOURCES) {
      const text = readFileSync(file, 'utf8');
      for (const pattern of forbidden) {
        assert.equal(pattern.test(text), false, `${file} must carry no decision shape (${String(pattern)})`);
      }
    }
  });

  it('no exported value is a function whose name suggests it decides', () => {
    const exported = Object.keys(contextRuntime);
    const decisional = exported.filter((name) => /allow|deny|decide|decision|authorize|authoriz|grant|permitAction/i.test(name));
    assert.deepEqual(decisional, [], 'the context runtime exports no decision producer');
  });

  it('a resolver output has no field a caller could act on as a verdict', () => {
    // Exercised through a real resolution rather than asserted about the type,
    // so the guarantee holds at runtime and not only at compile time.
    const service = new contextRuntime.ContextResolutionService({
      sources: [{ id: 'ctx.src.erp', kind: 'erp', name: 'ERP', trustClass: 'authoritative' }],
      declaration: { requirements: [{ key: 'vendor.status', minimumTrustClass: 'authoritative', required: true }] },
    });
    const resolution = service.classify([{ key: 'vendor.status', value: 'approved', sourceId: 'ctx.src.erp', observedAt: '2026-01-01T00:00:00.000Z' }], '2026-01-01T00:00:00.000Z');
    for (const forbidden of ['allowed', 'denied', 'decision', 'status', 'effect', 'severity', 'riskLevel', 'outcome']) {
      assert.equal(forbidden in resolution, false, `a ContextResolution must carry no '${forbidden}' field`);
    }
    const fact = resolution.facts[0];
    assert.ok(fact !== undefined);
    for (const forbidden of ['allowed', 'denied', 'decision', 'effect', 'severity', 'riskLevel']) {
      assert.equal(forbidden in fact, false, `a ContextFact must carry no '${forbidden}' field`);
    }
  });
});

describe('Context layer boundaries — no dynamic code, ever', () => {
  it('contains no eval, no Function constructor, no expression parser and no dynamic import', () => {
    const forbidden = [/\beval\s*\(/, /new\s+Function\s*\(/, /\bFunction\s*\(\s*['"]/, /\bimport\s*\(/, /vm\.runIn/];
    for (const file of sourceFiles(ROOT, true)) {
      const text = readFileSync(file, 'utf8');
      for (const pattern of forbidden) {
        assert.equal(pattern.test(text), false, `${file} must execute no dynamically-constructed code (${String(pattern)})`);
      }
    }
  });

  it('reads no clock and no randomness of its own — every instant is passed in', () => {
    const forbidden = [/Math\.random\s*\(/, /new\s+Date\s*\(\s*\)/, /Date\.now\s*\(/, /randomUUID/, /process\.hrtime/];
    for (const file of PRODUCTION_SOURCES) {
      const text = readFileSync(file, 'utf8');
      for (const pattern of forbidden) {
        assert.equal(pattern.test(text), false, `${file} must be a pure function of its inputs (${String(pattern)})`);
      }
    }
  });
});
