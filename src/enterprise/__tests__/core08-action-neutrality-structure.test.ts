import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createGovernanceProfileRegistry } from '../governance-profile/index.js';
import { GOVERNANCE } from './core08-reference-domains-fixture.js';

/**
 * CORE-08 §31 / §32 / §66 — structural action neutrality of the generic CORE.
 *
 * `governed-action-neutrality-structure.test.ts` (CORE-03) keeps the Kernel,
 * orchestrator, grant, execution, parameter and profile layers free of domain
 * vocabulary and branching. CORE-08 widens the scope to every generic layer the
 * three reference domains traverse — adding the P11 outcome store, P12
 * reconciliation and the generic policy engine — and the vocabulary to every
 * word the CORE-08 reference domains introduce. Domain words remain free in
 * tests, documentation, reference configuration and adapter plans; what is
 * forbidden is generic CORE **code** that names or branches on them.
 *
 * A regex proves absence of vocabulary, not runtime equivalence: the runtime
 * half is `core08-action-neutrality-host.test.ts`. The detectors below are
 * themselves tested against the branch shapes they must catch, and the
 * mutation campaign inserts real branches into real sources
 * (`docs/security/CORE-08-ACTION-NEUTRALITY-QUALIFICATION.md` §13).
 */

export const GENERIC_CORE_ROOTS = [
  'src/kernel',
  'src/enterprise/governed-action',
  'src/features/grant-runtime',
  'src/features/execution-runtime',
  'src/features/governed-parameter-runtime',
  'src/enterprise/governance-profile',
  'src/enterprise/execution-outcome-store',
  'src/enterprise/execution-reconciliation',
  'src/enterprise/execution-resolution-store',
  'src/features/domain-policy-pack-runtime/services',
  'src/features/domain-policy-pack-runtime/domain',
  'src/features/domain-policy-pack-runtime/runtime',
  'src/features/domain-policy-pack-runtime/integrations',
];

function productionSources(dir: string): readonly string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name !== 'tests' && name !== '__tests__' && name !== 'fixtures') out.push(...productionSources(full));
    } else if (full.endsWith('.ts') && !full.endsWith('.test.ts')) out.push(full);
  }
  return out;
}

/** Comments stripped — block, JSDoc and line — string literals kept: a literal is exactly where a domain branch hides. */
export function codeOf(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .map((line) => {
      let quote: string | undefined;
      for (let index = 0; index < line.length; index += 1) {
        const char = line[index];
        if (quote !== undefined) {
          if (char === quote && line[index - 1] !== '\\') quote = undefined;
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

/**
 * The reference domains' vocabulary. `deployment` alone is deliberately *not*
 * here: it is the generic word for a Host installation throughout CORE
 * (`deploymentGrantValidityCeiling`). `deploy` as a word, and every compound
 * the DevOps domain uses, are.
 */
export const DOMAIN_VOCABULARY: readonly RegExp[] = [
  /treasur/i,
  /invoice/i,
  /payable/i,
  /\bxrpl?\b/i,
  /\blightning\b/i,
  /\bdeploy\b/i,
  /deploymentStrategy|deployment[_-]?strategy/i,
  /kubernetes|\bk8s\b/i,
  /replica/i,
  /\bcluster/i,
  /rollback/i,
  /changeWindow|change[_-]window/i,
  /dataset/i,
  /customer[_-]?(data|database|record)/i,
  /customerData/i,
  /['"`]export['"`]/,
  /exportFormat|export[_-]?format/i,
  /recordCount|record[_-]?count/i,
  /supplier/i,
];

/** Shapes of a domain branch: a semantic or routing value compared with a literal, or switched on. */
export const DOMAIN_BRANCHES: readonly RegExp[] = [
  /\b(actionClass|resourceClass|governanceProfile|governanceProfileVersion)\b[\w.?]*\s*(===|!==|==|!=)\s*['"`]/,
  /['"`]\s*(===|!==|==|!=)\s*[\w.?]*\b(actionClass|resourceClass|governanceProfile)\b/,
  /\b(dimension|parameterId)\s*(===|!==|==|!=)\s*['"`]/,
  /\baction(\.type|\.actionId)?\s*(===|!==|==|!=)\s*['"`]/,
  /\.action\b[\w.?]*\s*(===|!==|==|!=)\s*['"`]/,
  /['"`]\s*(===|!==|==|!=)\s*[\w.?]*\.action\b/,
  /\b(resource|resourceScope)\s*(===|!==|==|!=)\s*['"`]/,
  /\badapterId\s*(===|!==|==|!=)\s*['"`]/,
  /switch\s*\([^)]*\b(action|actionClass|resourceClass|governanceProfile|dimension|parameterId|resourceScope|adapterId)\b[^)]*\)/,
  /\bcase\s+['"`](transfer|settle|deploy|read|export|payment|pay)\b/i,
  /\[\s*['"`](transfer|deploy|export|read|settle)[\w-]*['"`]\s*(,\s*['"`][\w-]*['"`]\s*)*\]\s*\.\s*includes\s*\(/i,
];

/**
 * Two exact carve-outs, nothing broader:
 *
 * - P9's host-trusted financial classification is monetary specialization, not
 *   a domain class (the CORE-03 carve-out), and `typeof x === 'string'` is a
 *   type test.
 * - The policy-pack **evidence-document** vocabulary (pre-existing since the
 *   Domain Policy Pack Runtime) lists `invoice` as a kind of source document —
 *   one member of a closed union and one key of a uniform mapping to
 *   `source_document`. It classifies attached evidence; no authorization,
 *   routing or execution branch reads it. Recorded as a residual in the
 *   qualification document; only these two exact spellings are exempt.
 */
function normalized(code: string): string {
  return code
    .replace(/^\s*\| 'invoice'$/m, 'EVIDENCE_DOCUMENT_KIND')
    .replace(/^\s*invoice: 'source_document',$/m, 'EVIDENCE_DOCUMENT_KIND')
    .replace(/\bactionClass\s*(===|!==)\s*'(financial|non-financial)'/g, 'P9_FINANCIAL_CLASSIFICATION')
    .replace(/typeof\s+[\w.?]+\s*(===|!==)\s*'(string|number|boolean|object|function|undefined|bigint|symbol)'/g, 'TYPEOF_TEST');
}

export function domainFindings(text: string): readonly string[] {
  const code = normalized(codeOf(text));
  return [...DOMAIN_VOCABULARY, ...DOMAIN_BRANCHES].filter((pattern) => pattern.test(code)).map(String);
}

const SOURCES = GENERIC_CORE_ROOTS.flatMap(productionSources);

describe('CORE-08 §32 — the detectors catch real branch shapes (non-vacuous)', () => {
  const branches = [
    "if (request.action === 'deploy') { return deny(); }",
    "if (intent.action !== 'export-customer-records') return;",
    "if (action.type === 'export') {}",
    "if ('deploy' === request.action) {}",
    'switch (resourceClass) { default: }',
    "switch (request.action) { case 'export': break; }",
    "if (dimension === 'recordCount') {}",
    "if (semantics.actionClass === 'export') {}",
    "if (outcome.adapterId === 'devops-http') {}",
    "if (['deploy', 'export'].includes(action)) {}",
    "const strict = profile.id === 'customer-data-export';",
  ];
  for (const branch of branches) {
    it(`catches: ${branch}`, () => {
      assert.ok(domainFindings(branch).length > 0, branch);
    });
  }
  it('ignores prose, the P9 financial carve-out and type tests', () => {
    assert.deepEqual(domainFindings("/** a deploy, an export, a treasury */\nconst x = 1; // replicaCount\nif (actionClass === 'financial') {}\nif (typeof value === 'string') {}"), []);
  });
});

describe('CORE-08 §31 / §66 — generic CORE names no reference domain and branches on none', () => {
  it('measures real sources in every generic layer', () => {
    for (const root of GENERIC_CORE_ROOTS) assert.ok(productionSources(root).length > 0, `no sources under ${root}`);
    assert.ok(SOURCES.length >= 100, `found ${SOURCES.length}`);
  });

  it('no generic CORE source names a reference-domain word or branches on a domain value', () => {
    for (const file of SOURCES) assert.deepEqual(domainFindings(readFileSync(file, 'utf8')), [], file);
  });

  it('no generic CORE module is named after a domain', () => {
    for (const file of SOURCES) assert.equal(/treasur|invoice|payable|deploy|kubern|export|customer|payment|xrp|lightning/i.test(file.split(/[\\/]/).pop() ?? ''), false, file);
  });
});

describe('CORE-08 §29 / §45 / §46 / §49 / §51 — no domain-specific primitive exists anywhere in production code', () => {
  const ALL = productionSources('src');
  const primitives =
    /\b(Treasury|Payment|Deploy(?:ment)?|DevOps|Kubernetes|CustomerData|Data|Export|DataExport)(ExecutionAdapter|ExecutionRecord|PolicyEngine|Approval|GovernedAction|Grant|Kernel|Pipeline)\b|\b(paymentSettled|deploymentSucceeded|exportCompleted)\b|\b(paymentParameters|treasuryParameters|deployParameters|kubernetesParameters|dataParameters|exportParameters|xrplParameters|transactionPayload|executionPayload|opaquePayload)\b/;

  it('no domain adapter class, execution record, policy engine, approval primitive, outcome status or payload field', () => {
    assert.ok(ALL.length > 500);
    for (const file of ALL) assert.equal(primitives.test(codeOf(readFileSync(file, 'utf8'))), false, `${file} declares a domain-specific primitive`);
  });

  it('the execution outcome vocabulary stays the shared four statuses and three certainties', () => {
    const outcome = codeOf(readFileSync('src/features/execution-runtime/domain/execution-outcome.ts', 'utf8'));
    const statuses = new Set([...outcome.matchAll(/status:\s*'([\w-]+)'/g)].map((match) => match[1]));
    assert.deepEqual([...statuses].sort(), ['executed', 'execution-failed', 'execution-unconfirmed', 'withheld']);
    const certainty = codeOf(readFileSync('src/features/execution-runtime/domain/provider-certainty.ts', 'utf8'));
    for (const value of ['confirmed-completed', 'confirmed-not-completed', 'unconfirmed']) assert.ok(certainty.includes(`'${value}'`), value);
  });
});

describe('CORE-08 §41 — a Governance Profile stays declarative data', () => {
  it('a profile carrying a callback, a mapper, a validator or an expression is refused at composition', () => {
    const base = GOVERNANCE.profiles?.[1];
    assert.ok(base !== undefined);
    for (const extra of [{ authorize: () => true }, { parameterMapper: () => ({}) }, { validate: 'return true' }, { policy: { expression: 'replicaCount < 10' } }, { execute: () => undefined }]) {
      assert.throws(() => createGovernanceProfileRegistry({ ...GOVERNANCE, profiles: [{ ...base, ...extra } as never] }), `${Object.keys(extra)[0]}`);
    }
    assert.doesNotThrow(() => createGovernanceProfileRegistry(GOVERNANCE), 'the reference configuration itself is valid data');
  });
});

describe('CORE-08 §43 / §47 — the adapter boundary and INTEL independence, re-measured on the widened scope', () => {
  it('the adapter port still carries no decision, policy, approval, obligation, context, grant scope or Kernel', () => {
    const port = codeOf(readFileSync('src/features/execution-runtime/domain/execution-adapter-port.ts', 'utf8'));
    const action = port.slice(port.indexOf('export interface ValidatedExecutionAction'), port.indexOf('export interface ValidatedExecutionCorrelation'));
    for (const forbidden of [/\bdecision\b(?!Id)/, /\bstatus\b/, /\bpolic/i, /\bapproval/i, /\bobligation/i, /\bcontext\b/i, /\bscope\b/, /\bgrant\b(?!Id)/, /\bkernel/i, /\bsourceAuthorization\b/, /\bdigest\b/i]) {
      assert.equal(forbidden.test(action), false, String(forbidden));
    }
  });

  it('no generic CORE source imports an AI, model, inference or agent-framework dependency', () => {
    for (const file of SOURCES) {
      const code = codeOf(readFileSync(file, 'utf8'));
      for (const pattern of [/\banthropic\b/i, /\bopenai\b/i, /\bllm\b/i, /\binference\b/i, /\bembedding/i, /\bprompt\b/i, /\bintelligence\b/i]) assert.equal(pattern.test(code), false, `${file} ${String(pattern)}`);
      for (const match of code.matchAll(/from\s+['"]([^'"]+)['"]/g)) assert.equal(/intel|agent-framework|langchain|openai|anthropic|model-provider/i.test(match[1] ?? ''), false, `${file} imports ${match[1]}`);
    }
  });
});
