import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import * as executionRuntime from '../index.js';
import { GRANT_EXERCISE_REASON_CODE_VALUES } from '../index.js';
import { GRANT_REASON_CODE_VALUES } from '../../grant-runtime/index.js';
import { AOC_KERNEL_REASON_CODES } from '../../../kernel/reason-codes/reason-codes.js';
import { AOC_KERNEL_EXERCISE_REASON_CODES } from '../../../kernel/reason-codes/exercise-reason-codes.js';

/**
 * The execution boundary's contract, enforced structurally rather than by
 * review — the convention `grant-layer-boundaries.test.ts`,
 * `obligation-layer-boundaries.test.ts` and `context-layer-boundaries.test.ts`
 * set, applied to the one layer that is allowed to name an adapter.
 *
 * This module sits *below* layer E in the dependency direction the grant
 * runtime's README draws:
 *
 * ```
 * Authority / Policy / Context
 *         ↓
 *     Obligations
 *         ↓
 *       Grants
 *         ↓
 *   execution path      ← this module
 * ```
 *
 * So it reads E and reads nothing above it. It may name an executor, an adapter
 * and a provider — that is its entire job, and the grant runtime is forbidden
 * from naming any of them precisely so that this module is the only place they
 * appear.
 */

const ROOT = 'src/features/execution-runtime';

function sourceFiles(dir: string): readonly string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === 'tests') continue;
      out.push(...sourceFiles(full));
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
 * comment and still do anything. The code-shape rules are asserted against
 * this, because what is forbidden is a *call*, not a word: this module's doc
 * comments deliberately name `Date.now()`, XRPL and JWT in order to say that
 * none of them is used and why, and a rule that punished the explanation would
 * push the explanation out of the file.
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

describe('Execution layer boundaries — it reads layer E and nothing above it', () => {
  it('has real production sources to measure', () => {
    assert.ok(PRODUCTION_SOURCES.length >= 5, `expected the execution runtime to have production sources, found ${PRODUCTION_SOURCES.length}`);
  });

  it('the comment stripper keeps code and drops prose, so the rules below are not vacuous', () => {
    const service = codeOf('src/features/execution-runtime/services/grant-execution-service.ts');
    assert.equal(service.includes('await store.read('), true, 'real code must survive stripping');
    assert.equal(service.includes('ADR-OBLIGATION-DISCHARGE'), false, 'doc-comment prose must be stripped');
    assert.equal(/Date\.now\s*\(/.test(service + '\nconst x = Date.now();'), true, 'the pattern still matches a real call');
  });

  it('imports nothing from the Kernel, the policy runtime, the enforcement engine or the Enterprise host', () => {
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

  it('never imports layer C or layer D — execution reads a grant, not the facts and discharges behind it', () => {
    const forbidden = [/from ['"][^'"]*context-resolution-runtime/, /from ['"][^'"]*obligation-runtime/];
    for (const file of PRODUCTION_SOURCES) {
      const text = readFileSync(file, 'utf8');
      for (const pattern of forbidden) {
        assert.equal(pattern.test(text), false, `${file} must not reach into layers C or D (${String(pattern)})`);
      }
    }
  });

  it('never imports Evidence or Intelligence — F and G read this, never the reverse', () => {
    const forbidden = [/from ['"][^'"]*evidence/i, /from ['"][^'"]*intelligence/i, /from ['"][^'"]*advisory/i, /from ['"][^'"]*verifiable-export-package/];
    for (const file of PRODUCTION_SOURCES) {
      const text = readFileSync(file, 'utf8');
      for (const pattern of forbidden) {
        assert.equal(pattern.test(text), false, `${file} must not depend on Evidence or Intelligence (${String(pattern)})`);
      }
    }
  });

  it('imports nothing outside its own module except the grant runtime it gates', () => {
    for (const file of PRODUCTION_SOURCES) {
      for (const match of readFileSync(file, 'utf8').matchAll(/from '([^']+)'/g)) {
        const specifier = match[1] ?? '';
        if (specifier.startsWith('../../grant-runtime/') || specifier === '../../grant-runtime/index.js') continue;
        assert.equal(specifier.startsWith('.'), true, `${file} imports '${specifier}'; the execution runtime is self-contained logic over a store port and an adapter port`);
      }
    }
  });

  it('reaches no external system on its own: no network, no filesystem, no process, no database client', () => {
    const forbidden = [/from ['"]node:fs['"]/, /from ['"]node:http/, /from ['"]node:net['"]/, /from ['"]node:child_process['"]/, /\bfetch\s*\(/, /better-sqlite3/];
    for (const file of PRODUCTION_SOURCES) {
      const text = readFileSync(file, 'utf8');
      for (const pattern of forbidden) {
        assert.equal(pattern.test(text), false, `${file} must not perform I/O of its own (${String(pattern)}) — a store does that behind its port, and a provider behind the adapter's`);
      }
    }
  });
});

describe('Execution layer boundaries — the execution path cannot authorize', () => {
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
    const decisional = Object.keys(executionRuntime).filter((name) => /^(allow|deny|decide|authorize)|Decision$|evaluatePolicy|preflight/i.test(name));
    assert.deepEqual(decisional, [], 'the execution runtime produces no decision');
  });

  it('no production source resolves context, discharges an obligation or issues a grant', () => {
    const forbidden = [/\bdischarge/i, /\bwaive/i, /ObligationState\b/, /'verified'/, /'waived'/, /\bissueGrant\b/, /\bContextFact\b/, /\bContextResolution\b/, /\btrustClass\b/];
    for (const file of PRODUCTION_SOURCES) {
      const text = codeOf(file);
      for (const pattern of forbidden) {
        assert.equal(pattern.test(text), false, `${file} must not reach into another layer's lifecycle (${String(pattern)})`);
      }
    }
  });

  it('no production source widens a grant bound — it compares, and it never constructs a GrantScope', () => {
    const forbidden = [/attenuateGrantScope/, /withGrantValidityCeiling/, /boundedGrantId\s*\(/, /createGrantIssuanceService/, /createInMemoryBoundedGrantStore/];
    for (const file of PRODUCTION_SOURCES) {
      const text = codeOf(file);
      for (const pattern of forbidden) {
        assert.equal(pattern.test(text), false, `${file} must not mint or narrow a grant (${String(pattern)}) — issuance is layer E's, and this layer only proves containment`);
      }
    }
  });

  it('the store port is used for reads and revocation visibility only — nothing here writes a grant', () => {
    for (const file of PRODUCTION_SOURCES) {
      const text = codeOf(file);
      assert.equal(/store\.issue\s*\(/.test(text), false, `${file} must not issue`);
      assert.equal(/store\.revoke\s*\(/.test(text), false, `${file} must not revoke`);
    }
  });

  it('no production source imports or names an AI, model or inference dependency', () => {
    const forbidden = [/\banthropic\b/i, /\bopenai\b/i, /\bllm\b/i, /\binference\b/i, /\bembedding\b/i, /\bprompt\b/i, /\brisk[Ss]core/, /\banomal/i, /\brecommend/i];
    for (const file of PRODUCTION_SOURCES) {
      const text = codeOf(file);
      for (const pattern of forbidden) {
        assert.equal(pattern.test(text), false, `${file} must contain no intelligence dependency (${String(pattern)}) — AI is outside the authorization path under every configuration`);
      }
    }
  });
});

describe('Execution layer boundaries — provider-neutral, and no chain anywhere', () => {
  it('names no ledger, no wallet, no signer, no transaction and no chain primitive', () => {
    const forbidden = [
      /\bxrpl\b/i,
      /\bxrp\b/i,
      /\bripple\b/i,
      /\bledger\b/i,
      /\bwallet\b/i,
      /\bmnemonic\b/i,
      /\bprivate[_-]?key\b/i,
      /\bsignTransaction\b/i,
      /\bsequenceNumber\b/i,
      /\bnonce\b/i,
      /\bgasLimit\b/i,
      /\bblockchain\b/i,
      /\bon-?chain\b/i,
    ];
    for (const file of PRODUCTION_SOURCES) {
      const text = codeOf(file);
      for (const pattern of forbidden) {
        assert.equal(pattern.test(text), false, `${file} must stay provider-neutral (${String(pattern)}) — a chain adapter is a later implementation of the port, not part of it`);
      }
    }
  });

  it('locks itself to no external token standard', () => {
    const forbidden = [/\bjwt\b/i, /\bjsonwebtoken\b/i, /\bmacaroon\b/i, /\bUCAN\b/, /\boauth\b/i, /\bbearer\b/i, /\bsigned[_-]?url\b/i];
    for (const file of PRODUCTION_SOURCES) {
      const text = codeOf(file);
      for (const pattern of forbidden) {
        assert.equal(pattern.test(text), false, `${file} must choose no token format (${String(pattern)}) — a caller never holds a grant, so it never presents one`);
      }
    }
  });

  it('names no specific provider', () => {
    for (const file of PRODUCTION_SOURCES) {
      const text = codeOf(file);
      for (const pattern of [/\bPinata\b/i, /\bIPFS\b/i, /\bS3\b/, /\bAzure\b/i, /\bSharePoint\b/i, /\bStripe\b/i]) {
        assert.equal(pattern.test(text), false, `${file} must not name a provider (${String(pattern)})`);
      }
    }
  });
});

describe('Execution layer boundaries — nothing dynamic, nothing ambient', () => {
  it('uses no eval, no new Function, no dynamic import and no runtime code construction', () => {
    const forbidden = [/\beval\s*\(/, /new\s+Function\s*\(/, /\bimport\s*\(/, /\bvm\b/, /Function\s*\(\s*['"`]/];
    for (const file of PRODUCTION_SOURCES) {
      const text = codeOf(file);
      for (const pattern of forbidden) {
        assert.equal(pattern.test(text), false, `${file} must contain no dynamic evaluation (${String(pattern)})`);
      }
    }
  });

  it('reads no ambient clock — every instant is injected', () => {
    const forbidden = [/Date\.now\s*\(/, /new\s+Date\s*\(\s*\)/, /performance\.now/];
    for (const file of PRODUCTION_SOURCES) {
      const text = codeOf(file);
      for (const pattern of forbidden) {
        assert.equal(pattern.test(text), false, `${file} must not read an ambient clock (${String(pattern)}) — expiry is derived from the injected instant at read time`);
      }
    }
  });

  it('depends on no sweeper, timer, job or scheduler', () => {
    const forbidden = [/setTimeout\s*\(/, /setInterval\s*\(/, /\bcron\b/i, /\bsweep/i, /\bscheduler?\b/i, /\bqueue\b/i, /\bworker\b/i];
    for (const file of PRODUCTION_SOURCES) {
      const text = codeOf(file);
      for (const pattern of forbidden) {
        assert.equal(pattern.test(text), false, `${file} must not depend on a background job (${String(pattern)}) — correctness never depends on one having run`);
      }
    }
  });

  it('generates no hidden identifier and no hidden randomness', () => {
    const forbidden = [/randomUUID/, /Math\.random/, /randomBytes/, /nextId\s*\(/, /\buuid\b/i];
    for (const file of PRODUCTION_SOURCES) {
      const text = codeOf(file);
      for (const pattern of forbidden) {
        assert.equal(pattern.test(text), false, `${file} must not generate an identifier (${String(pattern)}) — every identity it reports was supplied or derived upstream`);
      }
    }
  });

  it('invents no consumption model — no counter, no remaining uses, no replay ledger', () => {
    const forbidden = [/remainingUses/i, /\busageCount\b/i, /\buseCount\b/i, /\bsingleUse\b/i, /\boneTime\b/i, /\bconsume/i, /\bdecrement/i, /replayLedger/i];
    for (const file of PRODUCTION_SOURCES) {
      const text = codeOf(file);
      for (const pattern of forbidden) {
        assert.equal(pattern.test(text), false, `${file} must invent no consumption model (${String(pattern)}) — every accepted ADR is silent on it, and repeated exercise is currently permitted`);
      }
    }
  });
});

describe('Execution layer boundaries — the four reason-code vocabularies are disjoint', () => {
  const authorization: readonly string[] = Object.values(AOC_KERNEL_REASON_CODES);
  const obligations: readonly string[] = Object.values(AOC_KERNEL_EXERCISE_REASON_CODES);
  const issuance: readonly string[] = GRANT_REASON_CODE_VALUES;
  const exercise: readonly string[] = GRANT_EXERCISE_REASON_CODE_VALUES;

  it('every exercise code is GRANT_EXERCISE_-prefixed, so a new one cannot be added into an overlap', () => {
    for (const code of exercise) assert.equal(code.startsWith('GRANT_EXERCISE_'), true, `${code} must carry the vocabulary's prefix`);
  });

  it('no exercise code is an authorization reason code', () => {
    for (const code of exercise) assert.equal(authorization.includes(code), false, `${code} overlaps the policy-denial vocabulary`);
  });

  it('no exercise code is an obligation reason code', () => {
    for (const code of exercise) assert.equal(obligations.includes(code), false, `${code} overlaps the obligation vocabulary`);
  });

  it('no exercise code is a grant issuance reason code', () => {
    for (const code of exercise) assert.equal(issuance.includes(code), false, `${code} overlaps the issuance vocabulary`);
  });

  it('the vocabularies are non-empty, so the disjointness assertions above are not vacuous', () => {
    assert.ok(exercise.length >= 12);
    assert.ok(issuance.length >= 12);
    assert.ok(authorization.length > 0);
    assert.ok(obligations.length > 0);
  });
});

describe('Execution layer boundaries — no caller-facing surface was added', () => {
  it('exports no HTTP handler, route, controller or request-body validator', () => {
    const orchestration = Object.keys(executionRuntime).filter((name) => /handler|route|controller|endpoint|validate.*RequestBody|httpz?/i.test(name));
    assert.deepEqual(orchestration, [], 'a caller must not be able to issue, extend, revoke or exercise its own grant');
  });

  it('exports no notifier, router, scheduler or workflow primitive', () => {
    const orchestration = Object.keys(executionRuntime).filter((name) => /notify|escalat|remind|schedul|sla|queue|worker|sweep|approv/i.test(name));
    assert.deepEqual(orchestration, [], 'this is an execution boundary, not a workflow engine');
  });
});
