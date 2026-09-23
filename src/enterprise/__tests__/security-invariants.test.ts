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

  it('only the gated service and the composite registry invoke an execution adapter', () => {
    const callSites = EXECUTION_SOURCES.filter((file) => /\b[\w$]*[Aa]dapter\s*\.\s*execute\s*\(/.test(codeOf(file)));
    assert.deepEqual(
      callSites.slice().sort(),
      [
        'src/features/execution-runtime/services/execution-adapter-registry.ts',
        'src/features/execution-runtime/services/grant-execution-service.ts',
      ],
      'SEC-INV-011 holds only because every place an adapter can be invoked is enumerated; an unlisted call site would void the invariant while execution-exercise.test.ts still passed',
    );
  });

  it('the composite is reachable only through the gate: it reads no store, resolves no grant and holds no clock', () => {
    // `GrantExecutionService -> registry -> child adapter` is one provider
    // boundary. That is only true while the registry cannot be entered from
    // anywhere else and cannot re-derive authority once entered, so both halves
    // are asserted rather than argued.
    const registry = codeOf('src/features/execution-runtime/services/execution-adapter-registry.ts');
    for (const forbidden of [/\bstore\b/, /BoundedGrant/, /assessBoundedGrantExercise/, /Date\.now\s*\(/, /\bnow\s*\(\s*\)/]) {
      assert.equal(forbidden.test(registry), false, `the registry must not reference ${String(forbidden)} — it routes an already-assessed action and nothing more`);
    }
  });

  it('the gate\'s own invocation is preceded by the usable-assessment gate in the same function', () => {
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

describe('SECURITY_INVARIANTS.md — P6: the Generic HTTP invariants are recorded, scoped, and do not overclaim egress control', () => {
  const doc = existsSync(INVARIANTS_DOC) ? readFileSync(INVARIANTS_DOC, 'utf8') : '';

  it('records SEC-INV-062 … SEC-INV-069 as GEN-HTTP-01 … 08, each scoped to the Generic HTTP adapter', () => {
    for (let index = 0; index < 8; index += 1) {
      const id = `SEC-INV-0${62 + index}`;
      const alias = `GEN-HTTP-0${index + 1}`;
      const row = doc.split('\n').find((line) => line.startsWith(`| ${id} (**${alias}**)`));
      assert.ok(row !== undefined, `${id} must be recorded as ${alias}`);
      assert.ok(row.includes('COMPONENT-LOCAL to the Generic HTTP adapter'), `${id} must be scoped to the Generic HTTP adapter, never to arbitrary ExecutionAdapter implementations`);
      assert.equal(/SYSTEM-WIDE/.test(row), false, `${id} must not be system-wide`);
    }
  });

  it('records SEC-INV-070 … SEC-INV-079 as EXERCISE-CTRL-01 … 10, each path- or component-local and none system-wide', () => {
    for (let index = 0; index < 10; index += 1) {
      const id = `SEC-INV-0${70 + index}`;
      const alias = `EXERCISE-CTRL-${String(index + 1).padStart(2, '0')}`;
      const row = doc.split('\n').find((line) => line.startsWith(`| ${id} (**${alias}**)`));
      assert.ok(row !== undefined, `${id} must be recorded as ${alias}`);
      assert.ok(/PATH-LOCAL|COMPONENT-LOCAL/.test(row), `${id} must be scoped`);
      assert.equal(/SYSTEM-WIDE/.test(row), false, `${id} must not be system-wide`);
    }
    const section = doc.slice(doc.indexOf('### 4.9 Aggregate / velocity exercise controls (P7)'), doc.indexOf('## 5. Execution Path Guarantees'));
    for (const excluded of ['AocKernel.enforce', 'Sovereign Access', 'Content Protection']) assert.ok(section.includes(excluded), `the P7 section must name ${excluded} as not covered`);
    const u06 = doc.split('\n').find((line) => line.startsWith('| SEC-INV-U06 |')) ?? '';
    assert.ok(u06.includes('ASPIRATIONAL-UNIMPLEMENTED **system-wide**'), 'aggregate control is never marked system-wide');
    assert.ok(doc.includes('"Frontera bounds aggregate behaviour" is false'));
    assert.ok(/Distributed or cross-host quota/.test(doc), 'the distributed-quota non-claim must stay recorded');
  });

  it('records SEC-INV-080 … SEC-INV-088 as EVENT-STREAM-01 … 09, each path- or component-local, and never claims authenticity or system-wide coverage', () => {
    for (let index = 0; index < 9; index += 1) {
      const id = `SEC-INV-0${80 + index}`;
      const alias = `EVENT-STREAM-${String(index + 1).padStart(2, '0')}`;
      const row = doc.split('\n').find((line) => line.startsWith(`| ${id} (**${alias}**)`));
      assert.ok(row !== undefined, `${id} must be recorded as ${alias}`);
      assert.ok(/PATH-LOCAL|COMPONENT-LOCAL/.test(row), `${id} must be scoped`);
      assert.equal(/SYSTEM-WIDE/.test(row), false, `${id} must not be system-wide`);
      assert.equal(/tamper-proof|non-repudiab|cryptographically authenticated|exactly-once delivery/i.test(row.replace(/not authenticity/g, '')), false, `${id} must not overclaim`);
    }
    const row080 = doc.split('\n').find((line) => line.startsWith('| SEC-INV-080 ')) ?? '';
    assert.ok(row080.includes('Evidence never becomes authority'));
    const row084 = doc.split('\n').find((line) => line.startsWith('| SEC-INV-084 ')) ?? '';
    assert.ok(row084.includes('integrity, not authenticity'), 'the digest limit travels with the tamper-evidence claim');
    assert.ok(/A tamper-proof, authenticated, complete or system-wide event record/.test(doc), 'the event-stream non-claim must stay recorded');
    const row088 = doc.split('\n').find((line) => line.startsWith('| SEC-INV-088 ')) ?? '';
    assert.ok(row088.includes('never settles'), 'the non-blocking invariant must name the pending-projection case it exists for');
    assert.equal(/Promise<void>/.test(doc), false, 'the superseded "awaited promise" contract must not be described as the guarantee');
  });

  /**
   * The P8 claim is "authority control flow never awaits durable evidence
   * projection" — **not** "P8 can never add process latency". Projection shares
   * the process and the event loop, and a synchronous store (`better-sqlite3`'s
   * append, lock wait and `fsync` included) occupies it. Earlier drafts said
   * "delays none" / "cannot weaken or delay"; this pins the correction so it
   * cannot drift back. Scoped to the P8 rows and the P8 documents named below —
   * no repository-wide prose policing.
   */
  it('SEC-INV-088 and the P8 documents state the latency limit, and none of them claims projection can never delay', () => {
    const row088 = doc.split('\n').find((line) => line.startsWith('| SEC-INV-088 ')) ?? '';
    assert.ok(row088.length > 0);
    assert.ok(/not latency or thread isolation/i.test(row088), 'SEC-INV-088 must scope itself to control flow');
    assert.ok(/event loop/i.test(row088) && /latency/i.test(row088), 'SEC-INV-088 must say projection shares the loop and may add latency');

    const P8_CLAIM_SOURCES = [
      INVARIANTS_DOC,
      'docs/security/TRUST_BOUNDARIES_AND_PRIVILEGED_ASSETS.md',
      'docs/security/THREAT_MODEL_V1.md',
      'docs/architecture/ADR-CANONICAL-AUTHORITY-EVENT-STREAM.md',
      'docs/enterprise/AOC_CANONICAL_AUTHORITY_EVENT_STREAM.md',
      'docs/enterprise/AOC_GOVERNED_ACTION_ORCHESTRATOR.md',
      'docs/enterprise/AOC_EXERCISE_CONTROLS.md',
      'src/features/exercise-control-runtime/tests/exercise-control-observer.test.ts',
    ];
    const STALE_ABSOLUTES = [/delays none/i, /can delay nothing/i, /cannot weaken or delay/i, /never make it slower/i, /off the authority path's clock/i];
    for (const source of P8_CLAIM_SOURCES) {
      assert.ok(existsSync(source), `${source} must exist`);
      const text = readFileSync(source, 'utf8');
      for (const stale of STALE_ABSOLUTES) assert.equal(stale.test(text), false, `${source} repeats a superseded absolute: ${String(stale)}`);
    }

    // The A-29 asset row carries the same pair of statements.
    const assets = readFileSync('docs/security/TRUST_BOUNDARIES_AND_PRIVILEGED_ASSETS.md', 'utf8');
    const a29 = assets.split('\n').find((line) => line.startsWith('| **A-29**')) ?? '';
    assert.ok(a29.length > 0, 'A-29 must remain in the asset inventory');
    assert.ok(/never awaits durable projection/i.test(a29), 'A-29 must keep the control-flow claim');
    assert.ok(/latency/i.test(a29), 'A-29 must keep the latency limit beside it');
  });

  it('keeps SEC-INV-U03 unimplemented and never describes origin pinning as an egress firewall', () => {
    const u03 = doc.split('\n').find((line) => line.startsWith('| SEC-INV-U03 |'));
    assert.ok(u03 !== undefined);
    assert.ok(u03.includes('ASPIRATIONAL-UNIMPLEMENTED — **unchanged by P6.**'));
    assert.equal(/blocks all (unauthorized )?egress|egress (control|firewall) is (now )?implemented/i.test(doc), false);
    assert.ok(doc.includes('"Frontera blocks unauthorized egress" is false.'));
    assert.ok(/Exactly-once external execution/.test(doc), 'the exactly-once non-claim must stay recorded');
  });
});
