import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import * as grantRuntime from '../index.js';
import { GRANT_REASON_CODE_VALUES } from '../index.js';
import { AOC_KERNEL_REASON_CODES } from '../../../kernel/reason-codes/reason-codes.js';
import { AOC_KERNEL_EXERCISE_REASON_CODES } from '../../../kernel/reason-codes/exercise-reason-codes.js';

/**
 * Layer E's contract, enforced structurally rather than by review.
 *
 * `ADR-AUTHORITY-CONTROL-LAYERING.md` gives layer E one "may not": it may not
 * "issue a grant broader or longer-lived than its decision". The dependency
 * rule in §2 gives it the rest — `E reads A B D`, so it never reads C, never
 * reads F, never reads G, and never reads the Kernel. Every one of those is
 * asserted here against the TypeScript sources rather than the build output,
 * matching the convention `obligation-layer-boundaries.test.ts` and
 * `context-layer-boundaries.test.ts` set.
 */

const ROOT = 'src/features/grant-runtime';

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

/**
 * A source file with its comments removed.
 *
 * Import rules are asserted against the raw text — an import cannot hide in a
 * comment and still do anything. The *code-shape* rules below are asserted
 * against this instead, because the thing being forbidden is a call, not a
 * word: this module's doc comments deliberately name `Date.now()`, `randomUUID`
 * and JWT in order to say that none of them is used and why, and a rule that
 * punished the explanation would push the explanation out of the file. What is
 * measured is what executes.
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

describe('Grant layer boundaries — E reads A, B and D, and never the reverse', () => {
  it('the runtime has real production sources to measure', () => {
    assert.ok(PRODUCTION_SOURCES.length >= 10, `expected the grant runtime to have production sources, found ${PRODUCTION_SOURCES.length}`);
  });

  it('imports nothing from the policy runtime, the enforcement engine, the Kernel or the Enterprise host', () => {
    const forbidden = [
      /from ['"][^'"]*domain-policy-pack-runtime/,
      /from ['"][^'"]*policy-pack-foundation/,
      /from ['"][^'"]*action-enforcement/,
      /from ['"][^'"]*\/kernel\//,
      /from ['"][^'"]*\/enterprise\//,
      /from ['"][^'"]*\/runtime\//,
    ];
    for (const file of PRODUCTION_SOURCES) {
      const text = readFileSync(file, 'utf8');
      for (const pattern of forbidden) {
        assert.equal(pattern.test(text), false, `${file} must not import across the layer boundary (${String(pattern)})`);
      }
    }
  });

  it('never imports layer C or layer D — a grant reads a decision, not the facts and discharges behind it', () => {
    const forbidden = [/from ['"][^'"]*context-resolution-runtime/, /from ['"][^'"]*obligation-runtime/];
    for (const file of PRODUCTION_SOURCES) {
      const text = readFileSync(file, 'utf8');
      for (const pattern of forbidden) {
        assert.equal(pattern.test(text), false, `${file} must not reach into layers C or D (${String(pattern)}); the Kernel adapter projects what E is allowed to see`);
      }
    }
  });

  it('never imports Evidence or Intelligence — F and G read E, never the reverse', () => {
    const forbidden = [
      /from ['"][^'"]*evidence/i,
      /from ['"][^'"]*intelligence/i,
      /from ['"][^'"]*advisory/i,
      /from ['"][^'"]*verifiable-export-package/,
    ];
    for (const file of PRODUCTION_SOURCES) {
      const text = readFileSync(file, 'utf8');
      for (const pattern of forbidden) {
        assert.equal(pattern.test(text), false, `${file} must not depend on Evidence or Intelligence (${String(pattern)})`);
      }
    }
  });

  it('imports nothing outside its own module except the one hashing primitive and the pure monetary primitive', () => {
    for (const file of PRODUCTION_SOURCES) {
      for (const match of readFileSync(file, 'utf8').matchAll(/from '([^']+)'/g)) {
        const specifier = match[1] ?? '';
        if (specifier === 'crypto' || specifier === 'node:crypto') continue;
        if (specifier === '../../monetary-runtime/index.js') continue;
        assert.equal(specifier.startsWith('./') || specifier.startsWith('../domain/') || specifier.startsWith('../services/'), true, `${file} imports '${specifier}'; the grant runtime is self-contained pure data and logic`);
      }
    }
  });

  it('reaches no external system on its own: no network, no filesystem, no process, no database client, no ledger', () => {
    const forbidden = [
      /from ['"]node:fs['"]/,
      /from ['"]node:http/,
      /from ['"]node:net['"]/,
      /from ['"]node:child_process['"]/,
      /\bfetch\s*\(/,
      /better-sqlite3/,
      /\bxrpl\b/i,
      /\bxrp-ledger\b/i,
    ];
    for (const file of PRODUCTION_SOURCES) {
      const text = readFileSync(file, 'utf8');
      for (const pattern of forbidden) {
        assert.equal(pattern.test(text), false, `${file} must not perform I/O of its own (${String(pattern)}) — a store does that, behind the port`);
      }
    }
  });
});

describe('Grant layer boundaries — the grant layer cannot authorize', () => {
  it('no production source constructs an allow, a deny or a kernel decision status', () => {
    const forbidden = [
      /\ballowed\s*:/,
      /\bdenied\s*:/,
      /\bKernelDecisionStatus\b/,
      /\bPolicyEffect\b/,
      /\bPolicyDecision\b/,
      /\bEnforcementDecision\b/,
      /\bAocKernelReasonCode\b/,
      /'approval_required'/,
      /'indeterminate'/,
    ];
    for (const file of PRODUCTION_SOURCES) {
      const text = codeOf(file);
      for (const pattern of forbidden) {
        assert.equal(pattern.test(text), false, `${file} must carry no decision shape (${String(pattern)})`);
      }
    }
  });

  it('no exported value is a function whose name suggests it decides, evaluates policy or authorizes', () => {
    const exported = Object.keys(grantRuntime);
    const decisional = exported.filter((name) => /^(allow|deny|decide|authorize)|Decision$|evaluatePolicy|preflight/i.test(name));
    assert.deepEqual(decisional, [], 'the grant runtime produces no decision');
  });

  it('no production source discharges, verifies or waives an obligation', () => {
    const forbidden = [/\bdischarge/i, /\bwaive/i, /ObligationState\b/, /'verified'/, /'waived'/];
    for (const file of PRODUCTION_SOURCES) {
      const text = codeOf(file);
      for (const pattern of forbidden) {
        assert.equal(pattern.test(text), false, `${file} must not touch obligation lifecycle state (${String(pattern)}) — it reads one aggregate boolean and nothing else`);
      }
    }
  });

  it('no exported value routes, notifies, schedules, escalates, signs or executes — it is not a workflow engine and not an executor', () => {
    const exported = Object.keys(grantRuntime);
    const orchestration = exported.filter((name) => /notify|route|assign|escalat|remind|schedul|sla|queue|worker|sweep|dispatch|send|sign|submit|execute|broadcast/i.test(name));
    assert.deepEqual(orchestration, [], 'the grant layer produces an artifact; exercising it is an execution adapter’s business');
  });

  it('no production source calls an executor, an adapter or a provider', () => {
    const forbidden = [/EnforcementAdapter/, /ProviderAdapter/, /executor/i, /providerSystem/, /\bPinata\b/i];
    for (const file of PRODUCTION_SOURCES) {
      const text = codeOf(file);
      for (const pattern of forbidden) {
        assert.equal(pattern.test(text), false, `${file} must not reach an execution path (${String(pattern)})`);
      }
    }
  });

  it('no production source imports or names an AI, model or inference dependency', () => {
    const forbidden = [/\banthropic\b/i, /\bopenai\b/i, /\bllm\b/i, /\binference\b/i, /\bembedding\b/i, /\bprompt\b/i, /\brisk[Ss]core/, /\banomal/i];
    for (const file of PRODUCTION_SOURCES) {
      const text = codeOf(file);
      for (const pattern of forbidden) {
        assert.equal(pattern.test(text), false, `${file} must contain no intelligence dependency (${String(pattern)}) — AI is outside authorization authority, under every configuration`);
      }
    }
  });
});

describe('Grant layer boundaries — nothing dynamic, nothing ambient', () => {
  it('the comment stripper keeps code and drops prose — the rules below measure what executes', () => {
    const exercise = codeOf('src/features/grant-runtime/domain/grant-exercise.ts');
    assert.equal(exercise.includes('Date.parse(input.grant.expiresAt)'), true, 'real code must survive stripping, or the rules below would pass vacuously');
    assert.equal(exercise.includes('ADR-OBLIGATION-DISCHARGE'), false, 'doc-comment prose must be stripped');
    assert.equal(codeOf('src/features/grant-runtime/domain/bounded-grant.ts').includes("createHash('sha256')"), true);
    assert.equal(/Date\.now\s*\(/.test(codeOf('src/features/grant-runtime/domain/grant-exercise.ts') + '\nconst x = Date.now();'), true, 'the pattern still matches a real call');
  });

  it('uses no eval, no new Function, no dynamic import and no runtime code construction', () => {
    const forbidden = [/\beval\s*\(/, /new\s+Function\s*\(/, /\bimport\s*\(/, /\bvm\b/, /Function\s*\(\s*['"`]/];
    for (const file of PRODUCTION_SOURCES) {
      const text = codeOf(file);
      for (const pattern of forbidden) {
        assert.equal(pattern.test(text), false, `${file} must contain no dynamic evaluation (${String(pattern)}) — a grant bound is strictly less expressive than a policy condition`);
      }
    }
  });

  it('reads no ambient clock — every instant is passed in', () => {
    const forbidden = [/Date\.now\s*\(/, /new\s+Date\s*\(\s*\)/, /performance\.now/];
    for (const file of PRODUCTION_SOURCES) {
      const text = codeOf(file);
      for (const pattern of forbidden) {
        assert.equal(pattern.test(text), false, `${file} must not read an ambient clock (${String(pattern)}) — ADR §6 derives expiry from an injected instant`);
      }
    }
  });

  it('generates no hidden identifier — grant identity is derived, never minted', () => {
    const forbidden = [/randomUUID/, /Math\.random/, /randomBytes/, /nextId\s*\(/, /\buuid\b/i];
    for (const file of PRODUCTION_SOURCES) {
      const text = codeOf(file);
      for (const pattern of forbidden) {
        assert.equal(pattern.test(text), false, `${file} must not generate an identifier (${String(pattern)}) — see boundedGrantId`);
      }
    }
  });

  it('locks itself to no external token standard', () => {
    const forbidden = [/\bjwt\b/i, /\bjsonwebtoken\b/i, /\bmacaroon\b/i, /\bUCAN\b/, /\boauth\b/i, /\bbearer\b/i, /\bsigned[_-]?url\b/i, /\bSAS token\b/i];
    for (const file of PRODUCTION_SOURCES) {
      const text = codeOf(file);
      for (const pattern of forbidden) {
        assert.equal(pattern.test(text), false, `${file} must not adopt a token format no accepted ADR has chosen (${String(pattern)})`);
      }
    }
  });
});

describe('Grant reason codes are a structurally separate vocabulary', () => {
  it('does not overlap the authorization reason codes', () => {
    const authorization = new Set<string>(Object.values(AOC_KERNEL_REASON_CODES));
    const overlap = GRANT_REASON_CODE_VALUES.filter((code) => authorization.has(code));
    assert.deepEqual(overlap, [], 'a grant failure must never be readable as a policy denial');
  });

  it('does not overlap the obligation exercise reason codes', () => {
    const exercise = new Set<string>(Object.values(AOC_KERNEL_EXERCISE_REASON_CODES));
    const overlap = GRANT_REASON_CODE_VALUES.filter((code) => exercise.has(code));
    assert.deepEqual(overlap, [], 'a grant failure must never be readable as an obligation state');
  });

  it('every code is namespaced so the three vocabularies stay distinguishable on sight', () => {
    for (const code of GRANT_REASON_CODE_VALUES) assert.match(code, /^GRANT_/);
  });
});
