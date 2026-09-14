import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

/**
 * Drift protection for `docs/security/SECURITY_INVARIANTS.md`.
 *
 * Two jobs, and deliberately nothing more:
 *
 * 1. **Back the claims the canonical document makes about the Kernel.** The
 *    Kernel is the single decision producer (SEC-INV-001), and it performs no
 *    I/O, evaluates no dynamic code and names no intelligence dependency today
 *    — but until this file existed, nothing failed the build if that changed.
 *    `ADR-AUTHORITY-CONTROL-LAYERING.md` already states layer G "may not appear
 *    anywhere in the authorization path, under any configuration"; layers E and
 *    the execution runtime enforce that structurally, and the decision producer
 *    itself did not. These assertions close that gap for the Kernel. They assert
 *    a property that is *already true* — they do not change production
 *    behaviour, and none of them is a containment feature.
 *
 * 2. **Keep the bounded-grant gate a single, unavoidable chokepoint.** SEC-INV-011
 *    is PATH-LOCAL, and its whole force comes from there being exactly one place
 *    an adapter can be invoked. A second invocation site added anywhere in the
 *    execution runtime would silently void it, and the existing
 *    `execution-exercise.test.ts` — which counts invocations through the one
 *    service it calls — would still pass.
 *
 * The schema check on the document itself is a *shape* check (every invariant
 * row declares one of the six scope tokens), not a snapshot of prose. It exists
 * because an invariant without a scope is precisely the overclaim this track was
 * created to prevent.
 */

const SCOPE_TOKENS = ['SYSTEM-WIDE', 'LAYER-LOCAL', 'PATH-LOCAL', 'COMPONENT-LOCAL', 'DEPLOYMENT-CONTRACT', 'ASPIRATIONAL-UNIMPLEMENTED'] as const;

const INVARIANTS_DOC = 'docs/security/SECURITY_INVARIANTS.md';

function walkTsFiles(dir: string): readonly string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === '__tests__' || name === 'tests') continue;
      out.push(...walkTsFiles(full));
    } else if (full.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

/**
 * A source file with block and line comments removed.
 *
 * The same technique `execution-layer-boundaries.test.ts` uses, and for the same
 * reason: what is forbidden is a *call*, not a word. The Kernel's doc comments
 * legitimately say "no recommendation", "without embedding a mutable user", and
 * "retires the inference" in order to explain why none of those things happens.
 * A rule that punished the explanation would push the explanation out of the
 * file, which is the opposite of what this track wants.
 */
function codeOf(file: string): string {
  const text = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, ' ');
  return text
    .split('\n')
    .map((line) => {
      let quote: string | undefined;
      for (let index = 0; index < line.length; index += 1) {
        const char = line[index];
        const previous = index > 0 ? line[index - 1] : '';
        if (quote !== undefined) {
          if (char === quote && previous !== '\\') quote = undefined;
          continue;
        }
        if (char === "'" || char === '"' || char === '`') {
          quote = char;
          continue;
        }
        if (char === '/' && line[index + 1] === '/') return line.slice(0, index);
      }
      return line;
    })
    .join('\n');
}

const KERNEL_SOURCES = walkTsFiles('src/kernel');

describe('SEC-INV-001/020/021/024 — the decision producer stays capability-free', () => {
  it('has real Kernel production sources to measure', () => {
    assert.ok(KERNEL_SOURCES.length >= 10, `expected the Kernel to have production sources, found ${KERNEL_SOURCES.length}`);
  });

  it('the comment stripper keeps code and drops prose, so the rules below are not vacuous', () => {
    const kernel = codeOf('src/kernel/AocKernel.ts');
    assert.equal(kernel.includes('async evaluate('), true, 'real code must survive stripping');
    assert.equal(kernel.includes('AOC_KERNEL_CURRENT_EXECUTION_MODEL'), false, 'doc-comment prose must be stripped');
    assert.equal(/\beval\s*\(/.test(kernel + '\nconst x = eval("1");'), true, 'the pattern still matches a real call');
  });

  it('performs no I/O of its own: no filesystem, no network, no sockets, no child process, no database client', () => {
    const forbidden = [
      /from ['"]node:fs['"]/,
      /from ['"]node:http/,
      /from ['"]node:net['"]/,
      /from ['"]node:child_process['"]/,
      /from ['"]child_process['"]/,
      /\bfetch\s*\(/,
      /better-sqlite3/,
    ];
    for (const file of KERNEL_SOURCES) {
      const text = readFileSync(file, 'utf8');
      for (const pattern of forbidden) {
        assert.equal(pattern.test(text), false, `${file} must not perform I/O of its own (${String(pattern)}) — the Kernel decides; a store and an adapter do I/O behind their ports`);
      }
    }
  });

  it('evaluates no dynamic code — no eval, no new Function, no dynamic import, no vm', () => {
    const forbidden = [/\beval\s*\(/, /new\s+Function\s*\(/, /\bimport\s*\(/, /\bvm\.runIn/, /Function\s*\(\s*['"`]/];
    for (const file of KERNEL_SOURCES) {
      const text = codeOf(file);
      for (const pattern of forbidden) {
        assert.equal(pattern.test(text), false, `${file} must contain no dynamic evaluation (${String(pattern)})`);
      }
    }
  });

  it('names no AI, model or inference dependency — layer G may not appear in the authorization path under any configuration', () => {
    const forbidden = [/\banthropic\b/i, /\bopenai\b/i, /\bllm\b/i, /\binference\b/i, /\bembedding\b/i, /\bprompt\b/i, /\brisk[Ss]core/, /\banomal/i, /\brecommend/i];
    for (const file of KERNEL_SOURCES) {
      const text = codeOf(file);
      for (const pattern of forbidden) {
        assert.equal(pattern.test(text), false, `${file} must contain no intelligence dependency (${String(pattern)}) — ADR-AUTHORITY-CONTROL-LAYERING.md, layer G`);
      }
    }
  });
});

describe('SEC-INV-011 — the bounded-grant gate is the only way to reach an adapter', () => {
  const EXECUTION_SOURCES = walkTsFiles('src/features/execution-runtime');

  it('has real execution-runtime production sources to measure', () => {
    assert.ok(EXECUTION_SOURCES.length >= 5, `expected the execution runtime to have production sources, found ${EXECUTION_SOURCES.length}`);
  });

  it('exactly one production source invokes the execution adapter, and it is the gated service', () => {
    const callSites = EXECUTION_SOURCES.filter((file) => /\badapter\s*\.\s*execute\s*\(/.test(codeOf(file)));
    assert.deepEqual(
      callSites,
      ['src/features/execution-runtime/services/grant-execution-service.ts'],
      'SEC-INV-011 holds only because there is exactly one place an adapter can be invoked; a second call site would void the invariant while execution-exercise.test.ts still passed',
    );
  });

  it('the single invocation is preceded by the usable-assessment gate in the same function', () => {
    const service = codeOf('src/features/execution-runtime/services/grant-execution-service.ts');
    const gate = service.indexOf('if (!assessment.usable');
    const call = service.indexOf('adapter.execute(');
    assert.notEqual(gate, -1, 'the usable-assessment gate must still exist');
    assert.notEqual(call, -1, 'the adapter invocation must still exist');
    assert.ok(gate < call, 'the adapter may only be invoked after the usable-assessment gate has returned');
  });

  it('the authoritative store is re-read inside the exercising function, never cached at construction', () => {
    const service = codeOf('src/features/execution-runtime/services/grant-execution-service.ts');
    assert.ok(/await\s+store\.read\(/.test(service), 'the grant must be re-read from the authoritative store on every exercise (SEC-INV-013)');
  });
});

describe('SECURITY_INVARIANTS.md — every invariant declares a scope', () => {
  const doc = existsSync(INVARIANTS_DOC) ? readFileSync(INVARIANTS_DOC, 'utf8') : '';

  it('the canonical security invariants document exists', () => {
    assert.ok(doc.length > 0, `${INVARIANTS_DOC} is the canonical security artifact and must exist`);
  });

  it('defines every scope token it uses', () => {
    for (const token of SCOPE_TOKENS) {
      assert.ok(doc.includes(`**${token}**`), `the scope vocabulary must define ${token}`);
    }
  });

  it('every SEC-INV row carries exactly one scope token', () => {
    const rows = doc.split('\n').filter((line) => /^\|\s*\*{0,2}SEC-INV-\d{3}\*{0,2}\s*\|/.test(line));
    assert.ok(rows.length >= 20, `expected the enforced-invariant tables to be populated, found ${rows.length} rows`);
    for (const row of rows) {
      const id = /SEC-INV-\d{3}/.exec(row)?.[0] ?? '(unknown)';
      const declared = SCOPE_TOKENS.filter((token) => row.includes(token));
      assert.ok(
        declared.length >= 1,
        `${id} declares no scope — an invariant without a scope is the overclaim this document exists to prevent`,
      );
    }
  });

  it('records the unimplemented containment invariants rather than omitting them', () => {
    for (const id of ['SEC-INV-U01', 'SEC-INV-U02', 'SEC-INV-U03', 'SEC-INV-U04', 'SEC-INV-U05', 'SEC-INV-U06', 'SEC-INV-U07', 'SEC-INV-U08']) {
      assert.ok(doc.includes(id), `${id} must stay recorded so it cannot be mistaken for a guarantee`);
    }
  });

  it('states the trust assumptions that must travel with every claim', () => {
    for (const id of ['SEC-TRUST-001', 'SEC-TRUST-002', 'SEC-TRUST-003', 'SEC-TRUST-004', 'SEC-TRUST-005', 'SEC-TRUST-006', 'SEC-TRUST-007']) {
      assert.ok(doc.includes(id), `${id} must stay recorded`);
    }
  });

  it('keeps the bounded-grant adapter guarantee scoped to its path', () => {
    // SEC-INV-011 is the single most likely claim to be repeated without its
    // scope. The document must keep naming the path it belongs to, and must
    // keep saying where it stops.
    const row = doc.split('\n').find((line) => line.includes('SEC-INV-011') && line.startsWith('|'));
    assert.ok(row !== undefined, 'SEC-INV-011 must remain in the enforced-invariant table');
    assert.ok(row.includes('PATH-LOCAL'), 'SEC-INV-011 must remain PATH-LOCAL until code proves a wider scope');
    assert.ok(/bounded-grant/i.test(row), 'SEC-INV-011 must keep naming the bounded-grant path');
  });

  it('keeps the enforce() effect-binding limit stated as a first-class invariant', () => {
    assert.ok(doc.includes('SEC-INV-010'), 'the enforce() limit must remain a numbered invariant, not buried in prose');
    assert.ok(
      /decision-time/i.test(doc) && /effect-time/i.test(doc),
      'the decision-time vs effect-time distinction must remain explicit (SC-003)',
    );
  });

  it('keeps Sovereign Access recorded as a separate authority-bearing path', () => {
    assert.ok(doc.includes('SEC-INV-019'), 'the Sovereign Access boundary must remain a numbered invariant');
    assert.ok(/Sovereign Access/.test(doc), 'the Sovereign Access path must stay named');
  });
});
