import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { dirname, join, normalize } from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

/**
 * CORE-06 — the structural half of the Governance Core qualification
 * (`docs/security/CORE-06-GOVERNANCE-CORE-QUALIFICATION.md`). The runtime half
 * is `core06-governance-core-qualification-host.test.ts`, on the canonical Host.
 *
 * 1. **INTEL independence (§11.1 item 10, Master Plan invariant 32).** The
 *    transitive import closure of the canonical Host names no model, provider
 *    SDK, vector store or agent framework, and no deterministic Governance
 *    Core source names one — including the directories no earlier structural
 *    test scanned. No workspace declares such a dependency.
 * 2. **The composed boundary has no side door.** The Host's embedding
 *    options accept no Kernel, store, signer or grant authority; the HTTP
 *    surface has no issue / provision / un-revoke / force / debug route; the
 *    five emergency-control checkpoints are present and ordered.
 * 3. **Evidence and counts cannot drift silently (§11.1 item 9).** Every
 *    BLOCKED row of `THREAT_MODEL_V1.md` has a row in the CORE-06 coverage
 *    matrix; every matrix row names test evidence that exists; no row is left
 *    MISSING TEST; and every current-state effect-path count matches §5.11.
 *
 * Sources are read with CRLF normalized, so a Windows working copy measures
 * the same text as the committed LF tree.
 */

const read = (file: string): string => readFileSync(file, 'utf8').replace(/\r\n/g, '\n');

/** Code with block and line comments removed — what is forbidden is a use, not a word in an explanation. */
function codeOf(file: string): string {
  const text = read(file).replace(/\/\*[\s\S]*?\*\//g, ' ');
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

function productionTsFiles(dir: string): readonly string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === '__tests__' || name === 'tests' || name === 'fixtures' || name === 'node_modules' || name === 'dist') continue;
      out.push(...productionTsFiles(full));
    } else if (full.endsWith('.ts') && !full.endsWith('.d.ts') && !full.endsWith('.test.ts') && !/fixture/i.test(name)) {
      out.push(full);
    }
  }
  return out;
}

// ─── 1. INTEL independence ──────────────────────────────────────────────────

/** Module specifiers of intelligence dependencies: model / provider SDKs, agent frameworks, vector stores, inference runtimes. */
const INTELLIGENCE_SPECIFIER =
  /^(?:(?:openai|anthropic|langchain|ai|cohere-ai|onnxruntime|llamaindex|ollama|replicate|chromadb|weaviate|faiss|hnswlib|groq-sdk|together-ai)(?:$|[/-])|@(?:openai|anthropic-ai|langchain|ai-sdk|mistralai|huggingface|tensorflow|xenova|pinecone-database|qdrant)\/|@google\/(?:generative-ai|genai)|@google-cloud\/(?:aiplatform|vertexai)|@aws-sdk\/client-bedrock)/;

/** Identifiers only an intelligence integration would use, in code (comments stripped). */
const INTELLIGENCE_VOCABULARY = /\b(?:openai|anthropic|langchain|llm|llms|embeddings?|vector_?store|vectorStore|chat_?completions?|chatCompletions?|model_?provider|modelProvider|inference_?(?:client|service|endpoint)|inferenceClient|anomaly_?model|anomalyModel|risk_?score_?model)\b/i;

/** The deterministic Governance Core: every directory whose code decides, binds, stores or exercises authority on the governed path. */
const CORE_DIRECTORIES = [
  'src/kernel',
  'src/features/grant-runtime',
  'src/features/execution-runtime',
  'src/features/action-enforcement',
  'src/features/domain-policy-pack-runtime',
  'src/features/policy-pack-foundation',
  'src/features/context-resolution-runtime',
  'src/features/obligation-runtime',
  'src/features/approval-runtime',
  'src/features/authority-graph',
  'src/features/recognition-runtime',
  'src/features/exercise-control-runtime',
  'src/features/emergency-control-runtime',
  'src/features/governed-parameter-runtime',
  'src/features/monetary-runtime',
  'src/enterprise/composition',
  'src/enterprise/configuration',
  'src/enterprise/host',
  'src/enterprise/adapters',
  'src/enterprise/api',
  'src/enterprise/orchestration',
  'src/enterprise/customer-identity',
  'src/enterprise/governed-action',
  'src/enterprise/governance-store',
  'src/enterprise/governance-profile',
  'src/enterprise/trusted-context',
  'src/enterprise/obligation-discharge',
  'src/enterprise/approval-authority',
  'src/enterprise/bounded-grant-store',
  'src/enterprise/kernel-authority',
  'src/enterprise/authority-authenticity',
  'src/enterprise/external-authority-signer',
  'src/enterprise/authority-state-freshness',
  'src/enterprise/execution-governance',
  'src/enterprise/execution-adapters',
  'src/enterprise/exercise-control-ledger',
  'src/enterprise/emergency-control',
  'src/enterprise/execution-outcome-store',
  'src/enterprise/execution-resolution-store',
  'src/enterprise/execution-reconciliation',
  'src/enterprise/authority-event-stream',
  'src/enterprise/authority-administration',
  'src/enterprise/providers',
] as const;

const IMPORT_SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)['"]([^'"]+)['"]/g;

/** Runtime module specifiers: type-only imports and re-exports are erased by the compiler and load nothing. */
function specifiersOf(file: string): readonly string[] {
  const code = codeOf(file).replace(/\b(?:import|export)\s+type\b[\s\S]*?\bfrom\s*['"][^'"]+['"]/g, ' ');
  return [...code.matchAll(IMPORT_SPECIFIER)].map((match) => match[1] ?? '').filter((spec) => spec.length > 0 && !spec.includes('${') && !/\s/.test(spec));
}

const isBuiltin = (specifier: string): boolean => specifier.startsWith('node:') || builtinModules.includes(specifier.split('/')[0] ?? specifier);

/** Workspace packages, by their package name, so a closure can follow `@aoc-enterprise/*` imports into their sources. */
function workspacePackages(): ReadonlyMap<string, string> {
  const packages = new Map<string, string>();
  for (const root of ['packages', 'apps']) {
    if (!existsSync(root)) continue;
    for (const name of readdirSync(root)) {
      const manifest = join(root, name, 'package.json');
      if (existsSync(manifest)) packages.set((JSON.parse(read(manifest)) as { name: string }).name, join(root, name));
    }
  }
  return packages;
}

function resolveRelative(from: string, specifier: string): string | undefined {
  const base = normalize(join(dirname(from), specifier));
  for (const candidate of [base.replace(/\.js$/, '.ts'), base.replace(/\.mjs$/, '.mts'), `${base}.ts`, join(base, 'index.ts'), base]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return undefined;
}

function workspaceEntry(directory: string): string | undefined {
  for (const candidate of ['src/index.ts', 'index.ts', 'src/index.tsx']) {
    const full = join(directory, candidate);
    if (existsSync(full)) return full;
  }
  return undefined;
}

/** The transitive import closure of `entries`, following relative and workspace imports, with every bare specifier it meets. */
function importClosure(entries: readonly string[]): { readonly files: ReadonlySet<string>; readonly bare: ReadonlySet<string> } {
  const packages = workspacePackages();
  const files = new Set<string>();
  const bare = new Set<string>();
  const queue = [...entries];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (files.has(file)) continue;
    files.add(file);
    for (const specifier of specifiersOf(file)) {
      if (specifier.startsWith('.')) {
        const target = resolveRelative(file, specifier);
        if (target !== undefined && target.endsWith('.ts')) queue.push(target);
        continue;
      }
      const packageName = specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : (specifier.split('/')[0] ?? specifier);
      const local = packages.get(packageName);
      if (local !== undefined) {
        const entry = workspaceEntry(local);
        if (entry !== undefined) queue.push(entry);
        continue;
      }
      bare.add(specifier);
    }
  }
  return { files, bare };
}

describe('CORE-06 §20 — the deterministic Governance Core is independent of INTEL', () => {
  const closure = importClosure(['src/enterprise/host/enterprise-host.ts', 'src/enterprise/composition/composition-root.ts']);

  it('the detection is not vacuous: the patterns match real intelligence imports and identifiers, and not an explanation in a comment', () => {
    for (const specifier of ['openai', '@anthropic-ai/sdk', 'langchain/llms', '@langchain/core', 'ai', '@ai-sdk/openai', '@pinecone-database/pinecone', 'onnxruntime-node']) {
      assert.ok(INTELLIGENCE_SPECIFIER.test(specifier), specifier);
    }
    for (const benign of ['better-sqlite3', 'node:crypto', 'node:http', '@aoc-enterprise/identity', 'aim', 'airtable']) assert.ok(!INTELLIGENCE_SPECIFIER.test(benign), benign);
    assert.ok(INTELLIGENCE_VOCABULARY.test('const client = new OpenAI(); await client.chatCompletions.create()'));
    assert.ok(INTELLIGENCE_VOCABULARY.test('const embeddings = await model.embed(text)'));
    assert.ok(!INTELLIGENCE_VOCABULARY.test('const grantExpiresAt = evaluatedAt + lifetime'));
  });

  it('the canonical Host closure is real: it reaches the Kernel, the grant store, the orchestrator, the exercise gate and the adapter registry', () => {
    const paths = [...closure.files].map((file) => file.replace(/\\/g, '/'));
    for (const required of [
      'src/kernel/AocKernel.ts',
      'src/enterprise/bounded-grant-store/sqlite-bounded-grant-store.ts',
      'src/enterprise/governed-action/orchestrator.ts',
      'src/features/execution-runtime/services/grant-execution-service.ts',
      'src/features/execution-runtime/services/execution-adapter-registry.ts',
      'src/enterprise/approval-authority/service.ts',
      'src/enterprise/authority-state-freshness/session.ts',
    ]) {
      assert.ok(paths.includes(required), `the closure must include ${required}`);
    }
    assert.ok(closure.files.size > 200, `a real closure (${closure.files.size} files)`);
  });

  it('no module the canonical Host can load imports a model, provider SDK, vector store, agent framework or inference runtime', () => {
    const offending = [...closure.bare].filter((specifier) => INTELLIGENCE_SPECIFIER.test(specifier));
    assert.deepEqual(offending, []);
    // Everything bare the Host loads is Node itself or one declared runtime dependency.
    const declared = new Set(Object.keys((JSON.parse(read('package.json')) as { dependencies?: Record<string, string> }).dependencies ?? {}));
    const undeclared = [...closure.bare].filter((specifier) => !isBuiltin(specifier) && !declared.has(specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : (specifier.split('/')[0] ?? specifier)));
    assert.deepEqual(undeclared, [], 'the canonical Host loads nothing beyond Node built-ins and its declared runtime dependencies');
  });

  it('no module the canonical Host can load lives under an intelligence path', () => {
    const offending = [...closure.files].filter((file) => /(^|[\\/])(intel|intelligence|llm|ml|agentic|inference)([\\/]|$)/i.test(file));
    assert.deepEqual(offending, []);
  });

  it('no deterministic Governance Core source names an intelligence dependency, in imports or in code', () => {
    const missing = CORE_DIRECTORIES.filter((dir) => !existsSync(dir));
    assert.deepEqual(missing, [], 'every listed Governance Core directory exists — a rename must update this list, not silently shrink it');
    const offending: string[] = [];
    for (const dir of CORE_DIRECTORIES) {
      for (const file of productionTsFiles(dir)) {
        for (const specifier of specifiersOf(file)) if (INTELLIGENCE_SPECIFIER.test(specifier)) offending.push(`${file}: import '${specifier}'`);
        const hit = INTELLIGENCE_VOCABULARY.exec(codeOf(file));
        if (hit !== null) offending.push(`${file}: '${hit[0]}'`);
      }
    }
    assert.deepEqual(offending, []);
  });

  it('no workspace manifest declares an intelligence dependency', () => {
    const manifests = ['package.json', ...[...workspacePackages().values()].map((dir) => join(dir, 'package.json'))];
    const offending: string[] = [];
    for (const manifest of manifests) {
      const parsed = JSON.parse(read(manifest)) as Record<string, Record<string, string> | undefined>;
      for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
        for (const name of Object.keys(parsed[field] ?? {})) if (INTELLIGENCE_SPECIFIER.test(name)) offending.push(`${manifest} ${field}: ${name}`);
      }
    }
    assert.deepEqual(offending, []);
  });

  it('the only intelligence-adjacent input the governed path admits is a restrict-only fact — and a pack cannot make it permit', () => {
    const validator = codeOf('src/features/domain-policy-pack-runtime/services/policy-pack-validator.ts');
    assert.match(validator, /validateRestrictiveMonotonicity/, 'restrictive facts are validated for monotonicity at pack registration');
    // The grant's scope is built from the committed decision and the host policy — never from admitted context.
    const orchestrator = codeOf('src/enterprise/governed-action/orchestrator.ts');
    assert.ok(!/restrictiveFact|riskSignal|RiskSignal/.test(orchestrator), 'the orchestrator never reads a signal: it cannot shape a grant from one');
    const issuance = codeOf('src/enterprise/execution-governance/issuance-core.ts');
    assert.ok(!/restrictiveFact|riskSignal|RiskSignal/.test(issuance), 'issuance never reads a signal');
  });
});

// ─── 2. No side door in the composition ─────────────────────────────────────

describe('CORE-06 §23 — the canonical Host cannot be handed a Kernel, store, signer or grant authority', () => {
  const host = read('src/enterprise/host/enterprise-host.ts');

  it('BootEnterpriseHostOptions accepts exactly: env, executionAdapters, contextProvider, policyPackProvider, logger', () => {
    const body = /export interface BootEnterpriseHostOptions \{([\s\S]*?)\n\}/.exec(host)?.[1] ?? '';
    const members = [...body.matchAll(/^\s*readonly (\w+)\??:/gm)].map((match) => match[1]).sort();
    assert.deepEqual(members, ['contextProvider', 'env', 'executionAdapters', 'logger', 'policyPackProvider']);
  });

  it('the Host composes its own Kernel, stores and signer: it forwards no kernel, provider set, store or signer to the composition root', () => {
    const translate = /function toCreateEnterpriseOptions\([\s\S]*?\n\}\n/.exec(host)?.[0] ?? '';
    assert.ok(translate.length > 0);
    const code = translate.replace(/\/\/.*$/gm, '');
    for (const forbidden of [/\bkernel\s*:/, /\bkernelProviders\s*:/, /\bgrantStore\s*:/, /\bstore\s*:/, /\bsigner\s*:/, /\bauthenticity\s*:/, /\bfreshness\s*:/, /\brevalidateSource\s*:/, /\bexecutionAdapter\s*:/]) {
      assert.ok(!forbidden.test(code), `toCreateEnterpriseOptions must not forward ${String(forbidden)}`);
    }
    // Every adapter goes into the one trusted registry, routed by the file's table.
    assert.match(code, /executionAdapterRouting:\s*\{/);
    assert.match(code, /selectAdapter: \(action: ValidatedExecutionAction\) => routes\.get\(action\.action\)/);
  });
});

describe('CORE-06 §25 — the HTTP surface exposes no issue, provision, un-revoke, force, reset, debug or approval route', () => {
  const adapter = codeOf('src/enterprise/adapters/node-http-adapter.ts');

  it('no route literal or pattern names a forbidden verb', () => {
    const routeText = [...adapter.matchAll(/(?:pathname\s*===\s*'([^']+)'|\/\^(\\\/api[^/]*?(?:\\\/[^\s]*?)?)\$\/)/g)].map((match) => match[1] ?? match[2] ?? '');
    assert.ok(routeText.length >= 20, `the route table is measured (${routeText.length} routes)`);
    const forbidden = /debug|force|bypass|reset|override|impersonat|unrevoke|un-revoke|provision|issue|approv|discharge|freshness|witness|sign(?:er)?\b|enroll|grants\\\/[^\\]*\\\/(?:exercise|activate)/i;
    const offending = routeText.filter((route) => forbidden.test(route));
    assert.deepEqual(offending, []);
  });

  it('the administration mutations are exactly: grant revoke, entity revoke, emergency activate, emergency release', () => {
    const block = /function matchAdministrationRoute[\s\S]*?\n\}/.exec(adapter)?.[0] ?? '';
    const post = block.slice(block.indexOf("if (method === 'POST')"));
    const kinds = [...post.matchAll(/kind: '([a-z-]+)'/g)].map((match) => match[1]).sort();
    assert.deepEqual(kinds, ['emergency-control-activate', 'emergency-control-release', 'entity-revoke', 'grant-revoke']);
  });
});

describe('CORE-06 §32 — the five emergency-control checkpoints are present, share one reader and are ordered', () => {
  it('orchestrator admission precedes issuance', () => {
    const code = codeOf('src/enterprise/governed-action/orchestrator.ts');
    const admission = code.indexOf('readEmergencyControl(emergencyControl');
    const issue = code.indexOf('issuance.issueFromDecision(');
    assert.ok(admission > 0 && issue > admission, 'checkpoint 1 runs before any grant is issued');
  });

  it('the issuance commit boundary reads the interlock inside the synchronous source guard', () => {
    const code = codeOf('src/enterprise/execution-governance/issuance-core.ts');
    assert.equal(code.match(/readEmergencyControl\(/g)?.length, 1, 'checkpoint 2');
  });

  it('the exercise gate reads it twice — after the authoritative read and again after the reservation — and both precede the adapter', () => {
    const code = codeOf('src/features/execution-runtime/services/grant-execution-service.ts');
    const positions = [...code.matchAll(/readEmergencyControl\(/g)].map((match) => match.index ?? -1);
    assert.equal(positions.length, 2, 'checkpoints 3 and 4');
    const firstRead = code.indexOf('const first = await readAndAssess()');
    const admit = code.indexOf('await exerciseControl.admit(');
    const secondRead = code.indexOf('const second = await readAndAssess()');
    const revalidate = code.indexOf('exerciseControl.revalidate(');
    const execute = code.indexOf('await adapter.execute(action)');
    const [third, fourth] = positions as [number, number];
    assert.ok(firstRead < third && third < admit && admit < secondRead && secondRead < revalidate && revalidate < fourth && fourth < execute, 'read #1 → emergency #3 → reserve → read #2 → revalidate → emergency #4 → adapter');
  });

  it('the registry reads it after routing and before its one child', () => {
    const code = codeOf('src/features/execution-runtime/services/execution-adapter-registry.ts');
    const check = code.indexOf('readEmergencyControl(emergencyControl, query)');
    const child = code.indexOf('await childAdapter.execute(action)');
    assert.ok(check > 0 && child > check, 'checkpoint 5');
  });

  it('the composition root builds one reader and hands the same one to every checkpoint', () => {
    const code = codeOf('src/enterprise/composition/composition-root.ts');
    assert.equal(code.match(/createEmergencyControlReader\(/g)?.length, 1, 'one reader');
    assert.ok((code.match(/\.\.\.\(emergencyControl !== undefined \? \{ emergencyControl \} : \{\}\)/g)?.length ?? 0) >= 3, 'registry, execution service and orchestrator receive the same reader');
  });
});

// ─── 3. Evidence and counts ─────────────────────────────────────────────────

const QUALIFICATION_DOC = 'docs/security/CORE-06-GOVERNANCE-CORE-QUALIFICATION.md';
/**
 * Master Plan §11.1 item 9 reads "Every BLOCKED security claim has a test" — with no scope. So no row may be exempted as
 * "not applicable": every BLOCKED-bearing row, in the Governance Core or in Agent Passport Web, needs executable evidence.
 */
const STATUSES = ['PROVEN', 'PROVEN (CONDITIONAL)', 'PARTIAL AS DOCUMENTED'] as const;

interface MatrixRow {
  readonly id: string;
  readonly source: string;
  readonly threat: string;
  readonly disposition: string;
  readonly status: string;
  readonly evidence: string;
}

const plain = (cell: string): string => cell.replace(/\*\*/g, '').replace(/`/g, '').replace(/\s+/g, ' ').trim();

function matrixRows(): readonly MatrixRow[] {
  const doc = read(QUALIFICATION_DOC);
  const start = doc.indexOf('<!-- core06:blocked-matrix:start -->');
  const end = doc.indexOf('<!-- core06:blocked-matrix:end -->');
  assert.ok(start > 0 && end > start, 'the coverage matrix is delimited');
  return doc
    .slice(start, end)
    .split('\n')
    .filter((line) => /^\| [A-Z]{2,4}-[\w.§-]+ \|/.test(line))
    .map((line) => {
      const cells = line.split(' | ').map((cell) => cell.replace(/^\| ?/, '').replace(/ ?\|$/, ''));
      assert.equal(cells.length, 6, `six cells: ${line.slice(0, 80)}`);
      const [id, source, threat, disposition, status, evidence] = cells as [string, string, string, string, string, string];
      return { id, source, threat: plain(threat), disposition: plain(disposition), status: plain(status), evidence };
    });
}

/** `file.test.ts` › “title fragment” references in an evidence cell. */
function evidenceOf(cell: string): readonly { readonly file: string; readonly title: string }[] {
  return [...cell.matchAll(/`([\w./-]+\.test\.(?:ts|mjs|tsx))` › “([^”]+)”/g)].map((match) => ({ file: match[1] ?? '', title: match[2] ?? '' }));
}

const TEST_FILES: ReadonlyMap<string, string> = (() => {
  const map = new Map<string, string>();
  const walk = (dir: string): void => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (name === 'node_modules' || name === 'dist' || name === '.next') continue;
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.test\.(?:ts|mjs|tsx)$/.test(name)) map.set(full.replace(/\\/g, '/'), full);
    }
  };
  for (const root of ['src', 'tests', 'packages', 'apps']) walk(root);
  return map;
})();

function testFile(reference: string): string | undefined {
  if (TEST_FILES.has(reference)) return reference;
  const matches = [...TEST_FILES.keys()].filter((path) => path.endsWith(`/${reference}`));
  return matches.length === 1 ? matches[0] : undefined;
}

/** Every row of THREAT_MODEL_V1.md whose disposition cell says BLOCKED, keyed by its threat cell. */
function threatModelBlockedRows(): readonly { readonly threat: string; readonly disposition: string }[] {
  return read('docs/security/THREAT_MODEL_V1.md')
    .split('\n')
    .filter((line) => line.startsWith('| ') && !line.startsWith('| Threat') && !line.startsWith('|---'))
    .map((line) => line.split(' | '))
    .filter((cells) => cells.length >= 3 && /BLOCKED/.test(cells[1] ?? ''))
    .map((cells) => ({ threat: plain((cells[0] ?? '').replace(/^\| /, '')), disposition: plain(cells[1] ?? '') }));
}

/** Every BLOCKED-bearing row of the Agent Passport Web abuse-case matrix (§18), keyed by its letter. */
function agentPassportWebBlockedRows(): readonly { readonly id: string; readonly threat: string; readonly disposition: string }[] {
  const doc = read('docs/security/AGENT_PASSPORT_WEB_THREAT_MODEL.md');
  const section = doc.slice(doc.indexOf('## 18. Abuse-Case Matrix'), doc.indexOf('## 19. Findings'));
  return section
    .split('\n')
    .filter((line) => /^\| [A-Z] \|/.test(line))
    .map((line) => line.split(' | '))
    .filter((cells) => /BLOCKED/.test(cells[2] ?? ''))
    .map((cells) => ({ id: `APW-${(cells[0] ?? '').replace(/^\| /, '')}`, threat: plain(cells[1] ?? ''), disposition: plain(cells[2] ?? '') }));
}

describe('CORE-06 §16–§18 — every BLOCKED claim maps to executable evidence', () => {
  const rows = matrixRows();

  it('the matrix is measured: it has rows, each with a closed status', () => {
    assert.ok(rows.length >= 100, `${rows.length} rows`);
    for (const row of rows) assert.ok((STATUSES as readonly string[]).includes(row.status), `${row.id}: '${row.status}'`);
    assert.equal(new Set(rows.map((row) => row.id)).size, rows.length, 'row ids are unique');
  });

  it('every BLOCKED row of THREAT_MODEL_V1.md appears in the matrix with its disposition verbatim', () => {
    const tm = threatModelBlockedRows();
    assert.ok(tm.length >= 45, `${tm.length} threat-model rows`);
    const inMatrix = rows.filter((row) => row.source === 'TM');
    for (const threat of tm) {
      const row = inMatrix.find((candidate) => candidate.threat === threat.threat);
      assert.ok(row !== undefined, `no matrix row for THREAT_MODEL_V1 "${threat.threat}"`);
      assert.equal(row.disposition, threat.disposition, `the matrix restates "${threat.threat}"'s disposition verbatim — a condition is never dropped`);
    }
  });

  it('every BLOCKED-bearing row of the Agent Passport Web threat model appears in the matrix with its disposition verbatim', () => {
    const apw = agentPassportWebBlockedRows();
    assert.ok(apw.length >= 10, `${apw.length} Agent Passport Web rows`);
    for (const expected of apw) {
      const row = rows.find((candidate) => candidate.id === expected.id);
      assert.ok(row !== undefined, `no matrix row for ${expected.id}`);
      assert.equal(row.threat, expected.threat, expected.id);
      assert.equal(row.disposition, expected.disposition, `${expected.id}: the disposition is restated verbatim`);
    }
  });

  it('no row is left without evidence: every row names at least one test that exists and contains the named title', () => {
    for (const row of rows) {
      const references = evidenceOf(row.evidence);
      assert.ok(references.length > 0, `${row.id} (${row.status}) names no test`);
      for (const reference of references) {
        const file = testFile(reference.file);
        assert.ok(file !== undefined, `${row.id}: test file ${reference.file} does not exist (or is ambiguous)`);
        assert.ok(read(file).replace(/\s+/g, ' ').includes(reference.title), `${row.id}: ${reference.file} has no test titled “${reference.title}”`);
      }
    }
  });

  it('nothing is MISSING TEST, STALE, OVERCLAIMED or exempted as not applicable — each is resolved by a test or a narrowed claim, never left standing', () => {
    const unresolved = rows.filter((row) => /MISSING|STALE|OVERCLAIMED|NOT APPLICABLE/.test(row.status));
    assert.deepEqual(unresolved.map((row) => row.id), []);
  });
});

describe('CORE-06 §42 — every current-state effect-path count matches the inventory', () => {
  const words = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
  const tens = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
  const inWords = (n: number): string => (n < 20 ? (words[n] ?? '') : `${tens[Math.floor(n / 10)] ?? ''}${n % 10 === 0 ? '' : `-${words[n % 10] ?? ''}`}`);
  const nb = read('docs/security/NO_BYPASS_AUTHORITY_CONTROLLED_EXECUTION.md');
  const section = nb.slice(nb.indexOf('### 5.11 Classification totals'), nb.indexOf('## 6. Bounded-Grant Execution Proof'));
  const total = Number(/\| \*\*Total\*\* \| \*\*(\d+)\*\* \|/.exec(section)?.[1]);
  const numerator = Number(/\| PROVEN — PATH LOCAL \| \*\*(\d+)\*\* \|/.exec(section)?.[1]);

  it('the inventory states a total and a numerator', () => {
    assert.ok(Number.isInteger(total) && total > 0);
    assert.ok(Number.isInteger(numerator) && numerator > 0);
  });

  it('each current-state statement uses the current count', () => {
    const word = inWords(total);
    const capital = `${word.charAt(0).toUpperCase()}${word.slice(1)}`;
    const statements: readonly [string, string][] = [
      ['docs/security/NO_BYPASS_AUTHORITY_CONTROLLED_EXECUTION.md', `${capital} production-capable effect paths, enumerated from current source`],
      ['docs/security/NO_BYPASS_AUTHORITY_CONTROLLED_EXECUTION.md', `${inWords(numerator).replace(/^./, (c) => c.toUpperCase())} of ${word} effect paths are under bounded-grant control.`],
      ['docs/security/NO_BYPASS_AUTHORITY_CONTROLLED_EXECUTION.md', `${numerator} of ${total} effect paths are bounded-grant controlled`],
      ['docs/security/SECURITY_INVARIANTS.md', `${word} production-capable effect paths`],
      ['docs/security/SECURITY_INVARIANTS.md', `${inWords(numerator).replace(/^./, (c) => c.toUpperCase())} of ${word} effect paths are bounded-grant controlled.`],
      ['docs/architecture/FRONTERA-MASTER-PLAN.md', `${numerator} of ${total} effect paths are grant-controlled`],
      [QUALIFICATION_DOC, `${numerator} of ${total}`],
    ];
    for (const [file, statement] of statements) assert.ok(read(file).includes(statement), `${file} must state the current count: “${statement}”`);
  });

  it('no current-state sentence keeps a superseded count', () => {
    for (const stale of ['Fifty-five production-capable effect paths', 'Fifty-seven production-capable effect paths', '(Three: EP-011, EP-012, EP-013.)', '3 of 46 effect paths are grant-controlled']) {
      assert.ok(!nb.includes(stale) && !read('docs/architecture/FRONTERA-MASTER-PLAN.md').includes(stale), `superseded current-state statement: ${stale}`);
    }
  });
});
