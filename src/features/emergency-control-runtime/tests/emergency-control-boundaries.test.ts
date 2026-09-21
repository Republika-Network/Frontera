import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import * as emergencyControlRuntime from '../index.js';
import { EMERGENCY_CONTROL_REASON_CODE_VALUES } from '../index.js';
import { GRANT_EXERCISE_REASON_CODE_VALUES, EXECUTION_FAILURE_REASON_VALUES } from '../../execution-runtime/index.js';
import { GRANT_REASON_CODE_VALUES } from '../../grant-runtime/index.js';
import { AOC_KERNEL_REASON_CODES } from '../../../kernel/reason-codes/reason-codes.js';
import { AOC_KERNEL_EXERCISE_REASON_CODES } from '../../../kernel/reason-codes/exercise-reason-codes.js';

/**
 * What the emergency-control module is allowed to be, enforced structurally.
 *
 * It is an **interlock**: one question, one closed answer, no rules. The rules
 * below exist because every one of the things it must not become is a thing
 * something named "emergency control" could plausibly grow into — a second
 * policy engine, a risk scorer, an approval workflow, a revocation mechanism,
 * an HTTP admin panel — and each of those would move an authorization decision
 * out of the Kernel.
 */

const ROOT = 'src/features/emergency-control-runtime';

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

/** Comments stripped: what is forbidden is a *call* or an *import*, not a word this module's prose legitimately explains. */
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

describe('Emergency control boundaries — it is not a second decision producer', () => {
  it('has real production sources to measure', () => {
    assert.ok(PRODUCTION_SOURCES.length >= 5, `expected the emergency-control runtime to have production sources, found ${PRODUCTION_SOURCES.length}`);
  });

  it('the comment stripper keeps code and drops prose, so the rules below are not vacuous', () => {
    const port = codeOf('src/features/emergency-control-runtime/domain/emergency-control-port.ts');
    assert.equal(port.includes('export interface EmergencyControlReaderPort'), true, 'real code must survive stripping');
    assert.equal(port.includes('operational safety interlock'), false, 'doc-comment prose must be stripped');
  });

  it('constructs no decision: no allow, no deny, no kernel status, no policy effect', () => {
    const forbidden = [
      /\ballowed\s*:/,
      /\bdenied\s*:/,
      /\bKernelDecisionStatus\b/,
      /\bPolicyEffect\b/,
      /\bPolicyDecision\b/,
      /\bEnforcementDecision\b/,
      /'approval_required'/,
      /'indeterminate'/,
      /'allowed'/,
      /'denied'/,
    ];
    for (const file of PRODUCTION_SOURCES) {
      const text = codeOf(file);
      for (const pattern of forbidden) {
        assert.equal(pattern.test(text), false, `${file} must carry no decision shape (${String(pattern)}) — the Kernel is the only decision producer`);
      }
    }
  });

  it('evaluates no policy, resolves no context, discharges no obligation and revokes no grant', () => {
    const forbidden = [
      /\bevaluatePolicy\b/,
      /\bPolicyPack\b/,
      /\bpolicyRule\b/i,
      /\bContextFact\b/,
      /\bContextResolution\b/,
      /\bdischarge/i,
      /\bObligationState\b/,
      /\brevoke/i,
      /\bGrantRevocation\b/,
      /\bissueGrant\b/,
      /\bBoundedGrant\b/,
    ];
    for (const file of PRODUCTION_SOURCES) {
      const text = codeOf(file);
      for (const pattern of forbidden) {
        assert.equal(pattern.test(text), false, `${file} must not reach into another layer's lifecycle (${String(pattern)}) — an interlock withholds, it never revokes or re-decides`);
      }
    }
  });

  it('imports nothing outside its own module — no Kernel, no Enterprise, no grant runtime, no execution runtime', () => {
    for (const file of PRODUCTION_SOURCES) {
      for (const match of readFileSync(file, 'utf8').matchAll(/from '([^']+)'/g)) {
        const specifier = match[1] ?? '';
        assert.equal(
          specifier.startsWith('./') || specifier.startsWith('../'),
          true,
          `${file} imports '${specifier}'; the emergency-control runtime is self-contained state and a port`,
        );
        for (const forbidden of ['kernel', 'enterprise', 'grant-runtime', 'execution-runtime', 'action-enforcement', 'governance-store']) {
          assert.equal(specifier.includes(forbidden), false, `${file} must not import ${forbidden}`);
        }
      }
    }
  });

  it('is not an AI, a risk scorer or a recognition provider', () => {
    const forbidden = [/\banthropic\b/i, /\bopenai\b/i, /\bllm\b/i, /\binference\b/i, /\bembedding\b/i, /\brisk[Ss]core/, /\banomal/i, /\brecommend/i, /\brecognition\b/i];
    for (const file of PRODUCTION_SOURCES) {
      const text = codeOf(file);
      for (const pattern of forbidden) {
        assert.equal(pattern.test(text), false, `${file} must contain no intelligence dependency (${String(pattern)})`);
      }
    }
  });

  it('is not an HTTP surface, a credential store, a wallet or a provider SDK', () => {
    const forbidden = [
      /\brequestListener\b/,
      /\bIncomingMessage\b/,
      /\bServerResponse\b/,
      /from ['"]node:http/,
      /\bfetch\s*\(/,
      /\bapiKey\b/i,
      /\bsecret\b/i,
      /\bcredential\b/i,
      /\bprivate[_-]?key\b/i,
      /\bwallet\b/i,
      /\bsignTransaction\b/i,
      /\bxrpl\b/i,
      /\bPinata\b/i,
      /\bStripe\b/i,
    ];
    for (const file of PRODUCTION_SOURCES) {
      const text = codeOf(file);
      for (const pattern of forbidden) {
        assert.equal(pattern.test(text), false, `${file} must not become a route, a credential store or a provider client (${String(pattern)})`);
      }
    }
  });

  it('exports no HTTP handler, route, controller or request-body validator', () => {
    const surface = Object.keys(emergencyControlRuntime).filter((name) => /handler|route|controller|endpoint|validate.*RequestBody|httpz?/i.test(name));
    assert.deepEqual(surface, [], 'a caller must never be able to reach an emergency control');
  });

  it('exports no decision-shaped function', () => {
    const decisional = Object.keys(emergencyControlRuntime).filter((name) => /^(allow|deny|decide|authorize)|Decision$|evaluatePolicy|preflight/i.test(name));
    assert.deepEqual(decisional, [], 'the emergency-control runtime produces no decision');
  });

  it('reads no ambient clock and invents no identifier — every instant and every identity is supplied', () => {
    const forbidden = [/Date\.now\s*\(/, /new\s+Date\s*\(\s*\)/, /randomUUID/, /Math\.random/, /randomBytes/];
    for (const file of PRODUCTION_SOURCES) {
      const text = codeOf(file);
      for (const pattern of forbidden) {
        assert.equal(pattern.test(text), false, `${file} must not read an ambient clock or generate an identity (${String(pattern)})`);
      }
    }
  });

  it('uses no eval, no dynamic import, no timer and no background job', () => {
    const forbidden = [/\beval\s*\(/, /new\s+Function\s*\(/, /\bimport\s*\(/, /setTimeout\s*\(/, /setInterval\s*\(/, /\bcron\b/i, /\bsweep/i];
    for (const file of PRODUCTION_SOURCES) {
      const text = codeOf(file);
      for (const pattern of forbidden) {
        assert.equal(pattern.test(text), false, `${file} must contain no dynamic evaluation or background job (${String(pattern)})`);
      }
    }
  });
});

describe('Emergency control boundaries — the read is synchronous by contract', () => {
  it('the port declares a non-Promise return, so an async reader cannot satisfy it', () => {
    const port = codeOf('src/features/emergency-control-runtime/domain/emergency-control-port.ts');
    const declaration = /export interface EmergencyControlReaderPort \{([\s\S]*?)\n\}/.exec(port);
    assert.ok(declaration?.[1] !== undefined, 'EmergencyControlReaderPort must remain a declared interface');
    assert.ok(/read\(query: EmergencyControlQuery\): EmergencyControlAssessment;/.test(declaration[1]), 'read must return an assessment, never a promise');
    assert.equal(/Promise</.test(declaration[1]), false, 'a Promise-returning read could not be honoured inside the grant store commit guard');
  });

  it('no production source in this module awaits anything', () => {
    for (const file of PRODUCTION_SOURCES) {
      const text = codeOf(file);
      assert.equal(/\bawait\b/.test(text), false, `${file} must contain no await — the whole module is synchronous so the commit-boundary read can be`);
      assert.equal(/\basync\b/.test(text), false, `${file} must declare no async function`);
    }
  });
});

describe('Emergency control boundaries — the vocabularies stay disjoint', () => {
  const emergency: readonly string[] = EMERGENCY_CONTROL_REASON_CODE_VALUES;

  it('every emergency code carries the EMERGENCY_CONTROL_ prefix, so a new one cannot be added into an overlap', () => {
    for (const code of emergency) assert.equal(code.startsWith('EMERGENCY_CONTROL_'), true, `${code} must carry the vocabulary's prefix`);
  });

  it('no emergency code belongs to any other vocabulary', () => {
    const others: readonly (readonly string[])[] = [
      Object.values(AOC_KERNEL_REASON_CODES),
      Object.values(AOC_KERNEL_EXERCISE_REASON_CODES),
      GRANT_REASON_CODE_VALUES,
      GRANT_EXERCISE_REASON_CODE_VALUES,
      EXECUTION_FAILURE_REASON_VALUES,
    ];
    for (const code of emergency) {
      for (const vocabulary of others) {
        assert.equal(vocabulary.includes(code), false, `${code} overlaps another layer's vocabulary`);
      }
    }
  });

  it('the vocabularies are non-empty, so the disjointness assertions are not vacuous', () => {
    assert.ok(emergency.length >= 2);
    assert.ok(GRANT_EXERCISE_REASON_CODE_VALUES.length >= 12);
    assert.ok(EXECUTION_FAILURE_REASON_VALUES.length >= 4);
  });
});

describe('Emergency control boundaries — the reader capability carries no mutation', () => {
  it('the reader port declares exactly one method, and it is a read', () => {
    const port = codeOf('src/features/emergency-control-runtime/domain/emergency-control-port.ts');
    const declaration = /export interface EmergencyControlReaderPort \{([\s\S]*?)\n\}/.exec(port);
    const body = declaration?.[1] ?? '';
    for (const mutation of ['activate', 'release', 'set(', 'clear(', 'delete', 'write']) {
      assert.equal(body.includes(mutation), false, `EmergencyControlReaderPort must not expose '${mutation}' — an execution path able to mutate the interlock could disable it`);
    }
  });

  it('the store port extends the reader rather than replacing it, so a host injects one object', () => {
    const port = codeOf('src/features/emergency-control-runtime/domain/emergency-control-port.ts');
    assert.ok(/export interface EmergencyControlStorePort extends EmergencyControlReaderPort/.test(port));
  });
});
