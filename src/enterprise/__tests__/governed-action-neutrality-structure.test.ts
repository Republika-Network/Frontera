import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { GovernedActionSemantics } from '../../features/governed-parameter-runtime/index.js';

/**
 * CORE-03 §26 / §60 / §61 / §62 — the generic core stays generic.
 *
 * The Governed Action Thesis (Master Plan §11.6) needs the Kernel and the
 * orchestrator to govern materially different domains **without knowing what
 * any of them is**. These rules are stated against the production sources of
 * every generic CORE layer CORE-03 touched — the Kernel, the orchestrator, the
 * grant and execution runtimes, the parameter primitive and the profile
 * registry — with comments stripped, so a rule is about code, never prose:
 *
 * 1. no domain vocabulary (rails, clusters, customer data, environments,
 *    profile names from any fixture);
 * 2. no domain *branching*: no comparison of an action class, resource class,
 *    profile or dimension against a literal, and no `switch` over one;
 * 3. no universal taxonomy: no enum, and no closed union of action or resource
 *    class names — classes are opaque strings a domain declares;
 * 4. no intelligence dependency (CORE never imports INTEL).
 */

const GENERIC_CORE_ROOTS = [
  'src/kernel',
  'src/enterprise/governed-action',
  'src/features/grant-runtime',
  'src/features/execution-runtime',
  'src/features/governed-parameter-runtime',
  'src/enterprise/governance-profile',
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

/** Comments stripped — block, JSDoc and line — while string literals are kept: a literal is exactly where a domain branch would hide. */
function codeOf(file: string): string {
  const text = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, ' ');
  return text
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

const SOURCES = GENERIC_CORE_ROOTS.flatMap(productionSources);

describe('CORE-03 — the generic core names no domain and branches on none', () => {
  it('measures real sources in every generic CORE layer', () => {
    for (const root of GENERIC_CORE_ROOTS) assert.ok(productionSources(root).length > 0, `no sources under ${root}`);
    assert.ok(SOURCES.length >= 60, `found ${SOURCES.length}`);
  });

  it('contains no domain vocabulary: no rail, cluster, customer dataset, environment or fixture profile name (§60)', () => {
    const forbidden = [
      /\bxrpl?\b/i,
      /\blightning\b/i,
      /kubernetes|\bk8s\b/i,
      /customer[_-]?(data|database|dataset|record)/i,
      /production[_-]?environment/i,
      /\brecordCount\b/,
      /\brollbackAvailable\b/,
      /\breleaseVersion\b/,
      /customer-data-(read|export)|production-deploy/,
      /\bxrpl_asset\b/,
    ];
    for (const file of SOURCES) {
      const code = codeOf(file);
      for (const pattern of forbidden) assert.equal(pattern.test(code), false, `${file} names domain vocabulary ${String(pattern)}`);
    }
  });

  it('never compares a semantic class, profile, dimension, action or resource against a literal (§26)', () => {
    // One deliberate carve-out, and only its two values: P9's host-trusted
    // financial / non-financial classification predates CORE-03 and is still
    // named `actionClass` on the classified intent (renaming it would change a
    // P9 suite, which must pass unchanged). It is monetary specialization, not
    // a domain class; any *other* literal compared to any class is a branch.
    const P9_FINANCIAL_CLASS = /\bactionClass\s*(===|!==)\s*'(financial|non-financial)'/g;
    const branches = [
      /\b(actionClass|resourceClass|governanceProfile)\b[\w.?]*\s*(===|!==|==|!=)\s*['"`]/,
      /['"`]\s*(===|!==|==|!=)\s*[\w.?]*\b(actionClass|resourceClass|governanceProfile)\b/,
      /\bdimension\s*(===|!==|==|!=)\s*['"`]/,
      /\baction(\.type)?\s*(===|!==|==|!=)\s*['"`]/,
      /\b(resource|resourceScope)\s*(===|!==|==|!=)\s*['"`]/,
      /switch\s*\([^)]*\b(actionClass|resourceClass|governanceProfile|dimension|resourceScope)\b/,
    ];
    for (const file of SOURCES) {
      // `typeof x === 'string'` is a JavaScript type test, not a value comparison.
      const code = codeOf(file)
        .replace(P9_FINANCIAL_CLASS, 'P9_FINANCIAL_CLASSIFICATION')
        .replace(/typeof\s+[\w.]+\s*(===|!==)\s*'(string|number|boolean|object|function|undefined|bigint|symbol)'/g, 'TYPEOF_TEST');
      for (const pattern of branches) assert.equal(pattern.test(code), false, `${file} branches on a domain value ${String(pattern)}`);
    }
  });

  it('the orchestrator and the Kernel read semantics only to carry them: into the request, the grant bound and the policy input', () => {
    const orchestration = ['src/enterprise/governed-action/orchestrator.ts', 'src/kernel/orchestration/grant-adapter.ts', 'src/kernel/orchestration/request-adapter.ts'];
    for (const file of orchestration) {
      const code = codeOf(file);
      assert.equal(/\bif\s*\([^)]*\b(actionClass|resourceClass)\b/.test(code), false, `${file} conditions control flow on a class`);
    }
  });
});

describe('CORE-03 §61 — no universal action or resource taxonomy in CORE', () => {
  it('declares no enum, and no closed union or constant list of action or resource class names', () => {
    for (const file of SOURCES) {
      const code = codeOf(file);
      assert.equal(/\benum\s+\w+/.test(code), false, `${file} declares an enum`);
      assert.equal(/type\s+\w*(Action|Resource)(Class|Type|Kind)\w*\s*=\s*['"|]/.test(code), false, `${file} declares a closed action/resource taxonomy`);
      assert.equal(/(ACTION|RESOURCE)_(CLASSES|TYPES|KINDS)\s*=\s*\[/.test(code), false, `${file} declares a constant list of action/resource classes`);
    }
  });

  it('action and resource classes are opaque strings, so a domain may declare a class CORE has never seen', () => {
    const source = readFileSync('src/features/governed-parameter-runtime/domain/governed-action-semantics.ts', 'utf8');
    assert.match(source, /readonly actionClass: string;/);
    assert.match(source, /readonly resourceClass: string;/);
    // Compiles only because the class fields are open identifiers.
    const novel: GovernedActionSemantics = { actionClass: 'rotate', resourceClass: 'credential', governanceProfile: { id: 'credential-rotation', version: 1, digest: `sha256:${'0'.repeat(64)}` } };
    assert.equal(novel.actionClass, 'rotate');
  });
});

describe('CORE-03 §22 / §62 — CORE does not depend on INTEL', () => {
  it('no generic CORE source imports or names an AI, model or inference dependency', () => {
    const forbidden = [/\banthropic\b/i, /\bopenai\b/i, /\bllm\b/i, /\binference\b/i, /\bembedding/i, /\bprompt\b/i, /\brisk[Ss]core/, /\banomal/i, /\brecommend/i, /\bintel\b/i, /\bintelligence\b/i];
    for (const file of SOURCES) {
      const code = codeOf(file);
      for (const pattern of forbidden) assert.equal(pattern.test(code), false, `${file} must contain no intelligence dependency (${String(pattern)})`);
      for (const match of code.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
        assert.equal(/intel|agent-framework|langchain|openai|anthropic|model-provider/i.test(match[1] ?? ''), false, `${file} imports ${match[1]}`);
      }
    }
  });
});

describe('CORE-03 §19 — the orchestrator holds the trusted registry by type only', () => {
  it('every governed-action import of the profile registry is `import type`: nothing there can build, extend or replace one', () => {
    for (const file of productionSources('src/enterprise/governed-action')) {
      for (const line of readFileSync(file, 'utf8').split('\n')) {
        if (/from '\.\.\/governance-profile\/index\.js'/.test(line)) assert.match(line, /^import type /, `${file}: ${line}`);
      }
    }
  });

  it('the registry is built in exactly two trusted places: the composition root and the Host configuration parser', () => {
    const builders = productionSources('src').filter((file) => !file.startsWith(join('src', 'enterprise', 'governance-profile')) && /createGovernanceProfileRegistry\s*\(/.test(codeOf(file)));
    assert.deepEqual(builders.map((file) => file.split(/[\\/]/).join('/')).sort(), ['src/enterprise/composition/composition-root.ts', 'src/enterprise/host/host-configuration.ts']);
  });
});

describe('CORE-03 — the policy engine stays generic: it knows classes, profiles and typed dimensions, never a domain', () => {
  const POLICY_GENERIC_SOURCES = [
    ...productionSources('src/features/domain-policy-pack-runtime/services'),
    ...productionSources('src/features/domain-policy-pack-runtime/domain'),
    'src/features/domain-policy-pack-runtime/integrations/action-enforcement-policy-pack-integration.ts',
    ...productionSources('src/features/action-enforcement/services').filter((file) => file.includes('policy-pack')),
  ];

  it('measures the evaluator, validator, registry, runtime and the enforcement bridge', () => {
    for (const expected of ['policy-condition-evaluator.ts', 'policy-pack-validator.ts', 'policy-pack-registry.ts', 'policy-pack-runtime.ts', 'policy-pack-condition.ts', 'policy-pack-enforcement-service.ts']) {
      assert.ok(POLICY_GENERIC_SOURCES.some((file) => file.endsWith(expected)), expected);
    }
  });

  it('names no CORE-03 domain vocabulary and branches on no class, profile or dimension value', () => {
    const vocabulary = [/customer[_-]?(data|database|dataset|record)/i, /production[_-]?environment/i, /\brecordCount\b/, /\brollbackAvailable\b/, /\breleaseVersion\b/, /customer-data-(read|export)|production-deploy/, /\bxrpl?\b/i, /kubernetes/i];
    const branches = [
      /\b(actionClass|resourceClass|governanceProfile|governanceProfileVersion)\b[\w.?]*\s*(===|!==|==|!=)\s*['"`]/,
      /\b(parameterId|dimension)\s*(===|!==|==|!=)\s*['"`]/,
      /switch\s*\([^)]*\b(actionClass|resourceClass|governanceProfile|parameterId|dimension)\b/,
    ];
    for (const file of POLICY_GENERIC_SOURCES) {
      const code = codeOf(file);
      for (const pattern of [...vocabulary, ...branches]) assert.equal(pattern.test(code), false, `${file} ${String(pattern)}`);
    }
  });

  it('the predicate grammar exposes only generic semantic fields', () => {
    const grammar = codeOf('src/features/domain-policy-pack-runtime/domain/policy-pack-condition.ts');
    for (const field of ["'actionClass'", "'resourceClass'", "'governanceProfile'", "'governanceProfileVersion'", "'parameter'"]) assert.ok(grammar.includes(field), field);
    assert.match(grammar, /readonly parameterId\?: string;/, 'a dimension is addressed by data, never by a field named after it');
  });
});

describe('CORE-03 — one canonical currency ↔ unit mapping point', () => {
  it('only governed-action/monetary-naming.ts translates between the frozen `currency` name and the canonical `unit`', () => {
    const translating = productionSources('src/enterprise/governed-action').filter((file) => /unit:\s*[\w.?[\]'"]*currency|currency:\s*[\w.?]*\.unit\b/.test(codeOf(file)));
    assert.deepEqual(translating.map((file) => file.split(/[\\/]/).join('/')), ['src/enterprise/governed-action/monetary-naming.ts']);
  });
});
