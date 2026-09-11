import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import * as obligationRuntime from '../index.js';

/**
 * Layer D's contract, enforced structurally rather than by review.
 *
 * `ADR-AUTHORITY-CONTROL-LAYERING.md` gives layer D exactly one "may not" list:
 * it may not "grant anything, narrow policy's conclusion, or route, schedule or
 * notify". All three are asserted here, against the TypeScript sources rather
 * than the build output, matching the convention
 * `context-layer-boundaries.test.ts` and `structural-boundaries.test.ts` set.
 */

const ROOT = 'src/features/obligation-runtime';

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

describe('Obligation layer boundaries — D never imports B, E, F, G or the Kernel', () => {
  it('the runtime has real production sources to measure', () => {
    assert.ok(PRODUCTION_SOURCES.length >= 8, `expected the obligation runtime to have production sources, found ${PRODUCTION_SOURCES.length}`);
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

  it('never imports the Grants layer — the dependency runs D → future E, never back', () => {
    const forbidden = [/from ['"][^'"]*access-grant/, /from ['"][^'"]*grant-revocation/, /from ['"][^'"]*scoped-access/, /from ['"][^'"]*capability-tokens/];
    for (const file of PRODUCTION_SOURCES) {
      const text = readFileSync(file, 'utf8');
      for (const pattern of forbidden) {
        assert.equal(pattern.test(text), false, `${file} must not depend on grant issuance (${String(pattern)})`);
      }
    }
  });

  it('imports nothing at all outside its own module — no workspace package, no node builtin', () => {
    for (const file of PRODUCTION_SOURCES) {
      for (const match of readFileSync(file, 'utf8').matchAll(/from '([^']+)'/g)) {
        const specifier = match[1] ?? '';
        assert.equal(specifier.startsWith('.'), true, `${file} imports '${specifier}'; the obligation runtime is self-contained pure data and logic`);
      }
    }
  });

  it('reaches no external system on its own: no network, no filesystem, no process, no database client, no approval system', () => {
    const forbidden = [/from ['"]node:fs['"]/, /from ['"]node:http/, /from ['"]node:net['"]/, /from ['"]node:child_process['"]/, /\bfetch\s*\(/, /better-sqlite3/];
    for (const file of PRODUCTION_SOURCES) {
      const text = readFileSync(file, 'utf8');
      for (const pattern of forbidden) {
        assert.equal(pattern.test(text), false, `${file} must not perform I/O of its own (${String(pattern)}) — a provider does that, behind the port`);
      }
    }
  });
});

describe('Obligation layer boundaries — the obligation layer cannot decide', () => {
  it('no production source constructs an allow, a deny or a kernel decision status', () => {
    const forbidden = [
      /\ballowed\s*:/,
      /\bdenied\s*:/,
      /\bKernelDecisionStatus\b/,
      /\bPolicyEffect\b/,
      /\bEnforcementDecision\b/,
      /\bAocKernelReasonCode\b/,
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

  it('no exported value is a function whose name suggests it decides or grants', () => {
    const exported = Object.keys(obligationRuntime);
    const decisional = exported.filter((name) => /allow|deny|decide|decision|authoriz|issueGrant|grant|permitAction/i.test(name));
    assert.deepEqual(decisional, [], 'the obligation runtime exports no decision producer and no grant issuer');
  });

  it('no exported value routes, notifies, schedules, escalates or assigns — it is not a workflow engine', () => {
    const exported = Object.keys(obligationRuntime);
    const orchestration = exported.filter((name) => /notify|route|assign|escalat|remind|schedul|sla|queue|worker|sweep|dispatch|send/i.test(name));
    assert.deepEqual(orchestration, [], 'Frontera records that an obligation was discharged; obtaining the discharge is the deployment’s business');
  });

  it('a resolution carries no field a caller could act on as a verdict, and no obligation carries an authorization', () => {
    // Exercised through a real resolution rather than asserted about the type,
    // so the guarantee holds at runtime and not only at compile time.
    const service = new obligationRuntime.ObligationLifecycleService({
      sources: [{ id: 'obl.src.approval.finance', kind: 'approval_runtime', name: 'Finance approvals', verificationClass: 'independent' }],
      declaration: { requirements: [{ obligationType: 'finance.approval', blocking: true }] },
    });
    const correlation = { requestId: 'req-1', action: 'payment.execute', resourceScope: 'finance:payments' };
    const resolution = service.resolve(
      [{ obligationType: 'finance.approval', correlation, sourceId: 'obl.src.approval.finance', outcome: 'discharged', observedAt: '2026-01-01T00:00:00.000Z' }],
      correlation,
      '2026-01-01T00:00:00.000Z',
    );

    for (const forbidden of ['allowed', 'denied', 'decision', 'status', 'effect', 'severity', 'riskLevel', 'outcome', 'reasonCodes', 'grant']) {
      assert.equal(forbidden in resolution, false, `an ObligationResolution must carry no '${forbidden}' field`);
    }
    const obligation = resolution.obligations[0];
    assert.ok(obligation !== undefined);
    for (const forbidden of ['allowed', 'denied', 'decision', 'effect', 'severity', 'riskLevel', 'grant', 'grantId', 'token']) {
      assert.equal(forbidden in obligation, false, `an ObligationInstance must carry no '${forbidden}' field`);
    }
  });

  it('an observation cannot name its own verification class or its own lifecycle state', () => {
    const declared = readFileSync(join(ROOT, 'domain/obligation-discharge.ts'), 'utf8');
    const start = declared.indexOf('export interface ObligationDischargeObservation');
    // The interface body alone — the surrounding prose legitimately explains
    // what is missing from it, and a comment saying "there is no
    // `verificationClass` field" must not be read as one.
    const observationBlock = declared.slice(start, declared.indexOf('\n}', start));
    assert.equal(/verificationClass/.test(observationBlock), false, 'a source reports what it saw; the registry decides what that is worth');
    assert.equal(/readonly state\s*:/.test(observationBlock), false, 'a submitted lifecycle state has nowhere to land');
  });
});

describe('Obligation layer boundaries — no dynamic code, no hidden clock, ever', () => {
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
    const forbidden = [/Math\.random\s*\(/, /new\s+Date\s*\(\s*\)/, /Date\.now\s*\(/, /randomUUID/, /crypto/, /process\.hrtime/, /setTimeout/, /setInterval/];
    for (const file of PRODUCTION_SOURCES) {
      const text = readFileSync(file, 'utf8');
      for (const pattern of forbidden) {
        assert.equal(pattern.test(text), false, `${file} must be a pure function of its inputs (${String(pattern)})`);
      }
    }
  });
});
