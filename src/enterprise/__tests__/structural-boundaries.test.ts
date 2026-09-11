import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

/**
 * Enforces the architectural boundaries this iteration establishes:
 * `src/enterprise` is the new Enterprise Host, `src/runtime` (grants/
 * delegation/vault/federation) and `src/kernel` (the decision engine) are
 * both untouched and unaware of it. These run against the repo-root-
 * relative TypeScript sources (not `dist/`) so they hold regardless of
 * build artifacts, matching this repo's existing `tests/*.mjs` convention
 * of asserting on source text directly.
 */

function walkTsFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      out.push(...walkTsFiles(full));
    } else if (full.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

function importsMatching(files: readonly string[], pattern: RegExp): string[] {
  const hits: string[] = [];
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    if (pattern.test(text)) hits.push(file);
  }
  return hits;
}

describe('Structural boundaries: src/enterprise, src/runtime, src/kernel', () => {
  it('src/enterprise exists as the Soberanía Enterprise Host', () => {
    assert.ok(existsSync('src/enterprise'), 'src/enterprise must exist');
    assert.ok(statSync('src/enterprise').isDirectory());
    assert.ok(existsSync('src/enterprise/index.ts'), 'src/enterprise must have a public index.ts');
  });

  it('src/runtime (grants/delegation/vault/federation) is untouched by this iteration -- it never imports from src/enterprise or src/kernel-host', () => {
    assert.ok(existsSync('src/runtime'), 'src/runtime must still exist');
    const runtimeFiles = walkTsFiles('src/runtime');
    assert.ok(runtimeFiles.length > 0, 'src/runtime must still contain real files');

    const leaks = importsMatching(runtimeFiles, /from ['"]\.\.\/enterprise\/|from ['"]\.\.\/kernel-host\//);
    assert.deepEqual(leaks, [], 'src/runtime must not import the new Enterprise Host');
  });

  it('src/kernel (the decision engine) remains behaviorally unchanged -- it never imports from src/enterprise, src/kernel-host, or src/runtime', () => {
    assert.ok(existsSync('src/kernel'), 'src/kernel must still exist');
    const kernelFiles = walkTsFiles('src/kernel');
    assert.ok(kernelFiles.length > 0);

    const leaks = importsMatching(kernelFiles, /from ['"]\.\.\/enterprise\/|from ['"]\.\.\/kernel-host\/|from ['"]\.\.\/runtime\//);
    assert.deepEqual(leaks, [], 'src/kernel must remain independent of both the Enterprise Host and src/runtime');
  });

  it('src/enterprise imports the Kernel (a one-way dependency, never the reverse)', () => {
    const enterpriseFiles = walkTsFiles('src/enterprise').filter((f) => !f.includes('/__tests__/'));
    const kernelImporters = importsMatching(enterpriseFiles, /from ['"]\.\.\/\.\.\/kernel\/(index\.js)?['"]/);
    assert.ok(kernelImporters.length > 0, 'at least one src/enterprise module must import the Kernel');
  });

  it('src/enterprise does not import from src/runtime directly (no implicit coupling to the unrelated grants/vault/federation system)', () => {
    const enterpriseFiles = walkTsFiles('src/enterprise').filter((f) => !f.includes('/__tests__/'));
    const leaks = importsMatching(enterpriseFiles, /from ['"]\.\.\/\.\.\/runtime\//);
    assert.deepEqual(leaks, [], 'src/enterprise must not import src/runtime without an explicit public contract');
  });

  it('no circular dependency exists between src/kernel and src/enterprise', () => {
    const kernelFiles = walkTsFiles('src/kernel');
    const enterpriseFiles = walkTsFiles('src/enterprise').filter((f) => !f.includes('/__tests__/'));

    // Matches the Enterprise *Host* — `src/enterprise`, by any relative path
    // — rather than the string "enterprise" anywhere in a specifier. The
    // distinction became load-bearing when the Kernel started consuming the
    // governed-right vocabulary: `@aoc-enterprise/governed-authorization` is
    // an npm scope naming ownership, not a layer, and a pure-data contract
    // package is not the Host. The rule this guards is "the decision engine
    // must not depend on the composition, stores and services layered above
    // it", and that rule is unchanged. The companion test below is what keeps
    // the looser regex honest.
    const kernelImportsEnterpriseHost = importsMatching(kernelFiles, /from ['"](?:\.\.\/)+enterprise\//);
    const enterpriseImportsKernel = importsMatching(enterpriseFiles, /from ['"].*kernel\//);

    assert.deepEqual(kernelImportsEnterpriseHost, [], 'Kernel must never import the Enterprise Host');
    assert.ok(enterpriseImportsKernel.length > 0, 'Enterprise importing Kernel is the one legitimate direction');
  });

  it('src/kernel depends on workspace packages only where they are pure data — never on one carrying a runtime, a store or a service', () => {
    const kernelFiles = walkTsFiles('src/kernel');

    /**
     * The complete allow-list, and it is short on purpose. Both entries are
     * contract-only packages: no persistence, no policy engine, no
     * orchestration, no service, no provider SDK. The Kernel imports them for
     * the same reason it imports nothing else from `packages/` — because a
     * governed right and an exact quantity of one are *types*, and encoding
     * them as strings inside the kernel contracts is exactly the untyped
     * convention this foundation exists to replace.
     *
     * Adding an entry here means claiming a package is pure data. Adding one
     * that is not would put a store or a runtime underneath the decision
     * engine, which is the failure this test exists to catch.
     */
    const PURE_DATA_PACKAGES = ['@aoc-enterprise/governed-authorization', '@aoc-enterprise/governed-authority'];

    const imported = new Set<string>();
    for (const file of kernelFiles) {
      for (const match of readFileSync(file, 'utf8').matchAll(/from '(@aoc[^']*)'/g)) {
        const specifier = match[1];
        if (specifier !== undefined) imported.add(specifier);
      }
    }

    const unexpected = [...imported].filter((specifier) => !PURE_DATA_PACKAGES.includes(specifier)).sort();
    assert.deepEqual(unexpected, [], 'the Kernel may only import the pure-data contract packages on the allow-list above');

    for (const name of PURE_DATA_PACKAGES) {
      const root = join('packages', name.replace('@aoc-enterprise/', ''));
      const sources = walkTsFiles(root).filter((file) => !file.includes('/__tests__/'));
      assert.ok(sources.length > 0, `${name} must exist as a workspace package`);
      // A pure-data package cannot reach a database, a filesystem, a network,
      // a clock or a random source. Checked structurally rather than trusted,
      // so a future edit that quietly adds persistence to one of these fails
      // here rather than silently placing a store under the Kernel.
      const impure = importsMatching(sources, /from ['"](?:node:|better-sqlite3|crypto|fs|path)/);
      assert.deepEqual(impure, [], `${name} must remain pure data with no runtime dependency`);
    }
  });
});

describe('Structural boundaries: Governance Store (PR-004)', () => {
  it('the Kernel never imports the Governance Store — it remains persistence-independent', () => {
    const kernelFiles = walkTsFiles('src/kernel');
    const leaks = importsMatching(kernelFiles, /from ['"].*governance-store/);
    assert.deepEqual(leaks, [], 'src/kernel must not know the Governance Store exists');
  });

  it('the Governance Store contains no decision logic — it never imports the wrapped engine or evaluates anything', () => {
    const storeFiles = walkTsFiles('src/enterprise/governance-store');
    assert.ok(storeFiles.length > 0);
    const engineImports = importsMatching(storeFiles, /from ['"].*features\/action-enforcement/);
    assert.deepEqual(engineImports, [], 'the Store records decisions; it must never reach into the decision engine');
    const evaluateCalls = importsMatching(storeFiles, /kernel\.evaluate|\.evaluate\(/);
    assert.deepEqual(evaluateCalls, [], 'the Store must never invoke an evaluation');
  });

  it('HTTP handlers execute no SQL — better-sqlite3 and SQL strings stay inside the Store', () => {
    const adapterFiles = walkTsFiles('src/enterprise/adapters').concat(walkTsFiles('src/enterprise/host'));
    const sqlLeaks = importsMatching(adapterFiles, /better-sqlite3|SELECT |INSERT INTO|CREATE TABLE/);
    assert.deepEqual(sqlLeaks, [], 'no HTTP-facing module may touch the database directly');
  });

  it('the public Store contracts expose no better-sqlite3 types', () => {
    for (const file of ['src/enterprise/governance-store/contracts.ts', 'src/enterprise/governance-store/governance-store.ts', 'src/enterprise/governance-store/errors.ts']) {
      const text = readFileSync(file, 'utf8');
      assert.ok(!text.includes('better-sqlite3'), `${file} must not reference the SQLite driver`);
    }
  });

  it('the Store interface exposes no public update or delete methods', () => {
    const text = readFileSync('src/enterprise/governance-store/governance-store.ts', 'utf8');
    assert.ok(!/\b(update|delete|remove|purge)\w*\s*\(/.test(text), 'the GovernanceStore interface must stay append-oriented');
  });

  it('both providers implement the same interface via the same shared projection (no drift by construction)', () => {
    for (const file of ['src/enterprise/governance-store/in-memory-governance-store.ts', 'src/enterprise/governance-store/sqlite-governance-store.ts']) {
      const text = readFileSync(file, 'utf8');
      assert.ok(text.includes('buildGovernanceAggregate'), `${file} must build aggregates through the shared projection`);
      assert.ok(text.includes('verifyGovernanceRecordIntegrity'), `${file} must verify through the shared verification`);
    }
  });

  it('the module registry remains generic — it never mentions the Governance Store', () => {
    const registryFiles = walkTsFiles('src/enterprise/registry');
    const leaks = importsMatching(registryFiles, /governance-store/);
    assert.deepEqual(leaks, [], 'the registry stays module-agnostic');
  });
});

describe('Structural boundaries: Agent Passport Runtime (PR-006)', () => {
  it('the Kernel never imports the Agent Passport Runtime — it decides, the Passport identifies', () => {
    const kernelFiles = walkTsFiles('src/kernel');
    const leaks = importsMatching(kernelFiles, /from ['"].*\/passport\//);
    assert.deepEqual(leaks, [], 'src/kernel must not know the Agent Passport Runtime exists');
  });

  it('the Governance Store never imports the Agent Passport Runtime — Passport references the Store, never the reverse', () => {
    const storeFiles = walkTsFiles('src/enterprise/governance-store');
    const leaks = importsMatching(storeFiles, /from ['"].*\/passport\//);
    assert.deepEqual(leaks, [], 'the Governance Store must not depend on the Passport Runtime');
  });

  it('the Evidence Runtime never imports the Agent Passport Runtime — Passport references Evidence, never the reverse', () => {
    const evidenceFiles = walkTsFiles('src/enterprise/evidence');
    const leaks = importsMatching(evidenceFiles, /from ['"].*\/passport\//);
    assert.deepEqual(leaks, [], 'the Evidence Runtime must not depend on the Passport Runtime');
  });

  it('the Passport Runtime references public Governance Store and Evidence contracts, never their SQL/internal implementation', () => {
    const passportFiles = walkTsFiles('src/enterprise/passport');
    assert.ok(passportFiles.length > 0);
    const sqlLeaks = importsMatching(passportFiles, /better-sqlite3/).filter((file) => !file.endsWith('sqlite-passport-store.ts'));
    assert.deepEqual(sqlLeaks, [], 'only sqlite-passport-store.ts may reference better-sqlite3');
    const references = importsMatching(passportFiles, /from ['"]\.\.\/governance-store\/(digest|canonical-json)\.js['"]/);
    assert.ok(references.length > 0, 'the Passport Runtime reuses the Governance Store\'s canonical serialization/digest primitives rather than redefining them');
  });

  it('the Passport Runtime never evaluates governance — it never imports the decision engine or calls kernel.evaluate', () => {
    const passportFiles = walkTsFiles('src/enterprise/passport');
    const engineImports = importsMatching(passportFiles, /from ['"].*features\/action-enforcement/);
    assert.deepEqual(engineImports, [], 'the Passport Runtime must never reach into the decision engine');
    const evaluateCalls = importsMatching(passportFiles, /kernel\.evaluate|\.evaluate\(/);
    assert.deepEqual(evaluateCalls, [], 'the Passport Runtime must never invoke an evaluation');
  });

  it('HTTP handlers execute no Passport SQL — better-sqlite3 and SQL strings stay inside the Store', () => {
    const adapterFiles = walkTsFiles('src/enterprise/adapters').concat(walkTsFiles('src/enterprise/host'));
    const sqlLeaks = importsMatching(adapterFiles, /better-sqlite3|SELECT |INSERT INTO agent_passport|CREATE TABLE agent_passport/);
    assert.deepEqual(sqlLeaks, [], 'no HTTP-facing module may touch the Passport database directly');
  });

  it('the public Passport contracts expose no better-sqlite3 types', () => {
    for (const file of ['src/enterprise/passport/contracts.ts', 'src/enterprise/passport/passport-store.ts', 'src/enterprise/passport/errors.ts']) {
      const text = readFileSync(file, 'utf8');
      assert.ok(!text.includes('better-sqlite3'), `${file} must not reference the SQLite driver`);
    }
  });

  it('the Passport Store interface exposes no public update or delete methods (append-only, mission section 10)', () => {
    const text = readFileSync('src/enterprise/passport/passport-store.ts', 'utf8');
    assert.ok(!/\b(update|delete|remove|purge)\w*\s*\(/i.test(text), 'the AgentPassportStore interface must stay append-oriented');
  });

  it('both providers reconstruct through the same shared fold (no drift by construction)', () => {
    for (const file of ['src/enterprise/passport/in-memory-passport-store.ts', 'src/enterprise/passport/sqlite-passport-store.ts']) {
      const text = readFileSync(file, 'utf8');
      assert.ok(text.includes('reconstructAgentPassportFromEvents'), `${file} must reconstruct state through the shared fold`);
    }
  });

  it('Passport disclosure views are built only through the shared projector — the service never assembles a view field set by hand', () => {
    const text = readFileSync('src/enterprise/passport/service.ts', 'utf8');
    assert.ok(text.includes('buildAgentPassportView'), 'service.ts must delegate view construction to disclosure.ts');
  });
});

describe('Structural boundaries: Provider credential exposure (R004.B)', () => {
  it('AocEnterprise.configuration is declared as the redacted PublicEnterpriseConfiguration, never the secret-bearing EnterpriseConfiguration', () => {
    const text = readFileSync('src/enterprise/composition/composition-root.ts', 'utf8');
    assert.match(text, /readonly configuration: PublicEnterpriseConfiguration;/, 'the AocEnterprise interface must expose the redacted configuration view');
    assert.doesNotMatch(text, /readonly configuration: EnterpriseConfiguration;/, 'the AocEnterprise interface must not expose the raw configuration type');
  });

  it('getInternalEnterpriseConfiguration (the route to real credentials) is never re-exported from the public enterprise entrypoint', () => {
    const publicEntrypoint = readFileSync('src/enterprise/index.ts', 'utf8');
    assert.doesNotMatch(publicEntrypoint, /getInternalEnterpriseConfiguration/, 'src/enterprise/index.ts must never re-export the internal credential accessor');

    const exportKeys = Object.keys(JSON.parse(readFileSync('package.json', 'utf8')).exports ?? {});
    assert.deepEqual(exportKeys.filter((key) => key.includes('composition-root') || key.includes('composition/')), [], 'no package.json subpath may point at the composition root module directly');
  });

  it('no source module defines a DEFAULT_API_KEYS (or equivalent) hardcoded production-credential export', () => {
    const enterpriseFiles = walkTsFiles('src/enterprise').filter((f) => !f.includes('/__tests__/'));
    const hits = importsMatching(enterpriseFiles, /export\s+(const|let)\s+DEFAULT_[A-Z_]*(API_KEY|SECRET|CREDENTIAL|TOKEN)/);
    assert.deepEqual(hits, [], 'no default/fallback credential constant may be exported from src/enterprise');
  });

  it('loadEnterpriseConfiguration never falls back to a hardcoded, non-empty API key when the environment provides none', () => {
    const text = readFileSync('src/enterprise/configuration/enterprise-configuration.ts', 'utf8');
    assert.match(text, /parseApiKeys\(value: string \| undefined\).*\n\s*if \(!value\) return \[\];/, 'an unset AOC_ENTERPRISE_API_KEYS must resolve to an empty key list, never a default credential');
  });

  it('the Node HTTP adapter authenticates callers via getInternalEnterpriseConfiguration, never via the public enterprise.configuration field', () => {
    const text = readFileSync('src/enterprise/adapters/node-http-adapter.ts', 'utf8');
    assert.doesNotMatch(text, /resolveGovernanceAccessContext\(req\.headers\.authorization,\s*enterprise\.configuration\)/, 'authentication must read the internal (unredacted) configuration, not the public redacted view');
    assert.match(text, /getInternalEnterpriseConfiguration\(enterprise\)/, 'authentication must go through the internal accessor');
  });
});

/**
 * Layer C's classification, asserted over the whole tree rather than over the
 * context runtime alone.
 *
 * `ADR-AUTHORITY-CONTROL-LAYERING.md` §2 makes the dependency rule a structural
 * test "in the same family as the existing `structural-boundaries.test.ts`, run
 * by `npm test`, not review conventions." The tests inside the context runtime
 * assert what that module may not reach; these assert what may not reach *into*
 * it, and that the one component allowed to bridge C and the decision is the
 * Kernel.
 */
describe('Authority-control layering: the Context layer (C)', () => {
  const CONTEXT_ROOT = 'src/features/context-resolution-runtime';

  it('the context runtime exists and is a real module', () => {
    assert.ok(existsSync(CONTEXT_ROOT), 'the Context layer must exist as a module');
    assert.ok(existsSync(`${CONTEXT_ROOT}/index.ts`), 'it must have a public entrypoint');
    assert.ok(existsSync(`${CONTEXT_ROOT}/README.md`), 'a layer boundary that is not written down is a convention, not a boundary');
  });

  it('the policy runtime never reaches into the context runtime — B receives its context, it does not resolve it', () => {
    const policyFiles = walkTsFiles('src/features/domain-policy-pack-runtime').filter((file) => !file.includes('/tests/'));
    const leaks = importsMatching(policyFiles, /context-resolution-runtime/);
    assert.deepEqual(leaks, [], 'Domain Policy Pack Runtime must not resolve its own context');
  });

  it('the enforcement engine never reaches into the context runtime either', () => {
    const enforcementFiles = walkTsFiles('src/features/action-enforcement').filter((file) => !file.includes('/__tests__/') && !file.includes('/tests/'));
    const leaks = importsMatching(enforcementFiles, /context-resolution-runtime/);
    assert.deepEqual(leaks, [], 'Action Enforcement receives a policy input; it does not resolve facts');
  });

  it('the Kernel is the only component that composes the context port', () => {
    const kernelImporters = walkTsFiles('src/kernel')
      .filter((file) => !file.includes('/__tests__/'))
      .filter((file) => /context-resolution-runtime/.test(readFileSync(file, 'utf8')));
    assert.deepEqual(
      kernelImporters.map((file) => file.replace(/\\/g, '/')).sort(),
      ['src/kernel/contracts/ports.ts', 'src/kernel/orchestration/context-adapter.ts', 'src/kernel/orchestration/request-adapter.ts'],
      'the context port is composed at exactly the kernel boundary, and nowhere else',
    );
  });

  it('the context runtime imports no layer above it', () => {
    const contextFiles = walkTsFiles(CONTEXT_ROOT).filter((file) => !file.includes('/tests/'));
    const leaks = importsMatching(contextFiles, /from ['"][^'"]*(domain-policy-pack-runtime|action-enforcement|\/kernel\/|\/enterprise\/)/);
    assert.deepEqual(leaks, [], 'C never imports B, and never imports the decision producer');
  });

  it('the reserved context namespace is defined once, in the layer that owns it', () => {
    const definitions = walkTsFiles('src').filter((file) => /CONTEXT_RESOLUTION_POLICY_METADATA_KEY\s*=/.test(readFileSync(file, 'utf8')));
    assert.deepEqual(definitions.map((file) => file.replace(/\\/g, '/')), [`${CONTEXT_ROOT}/domain/context-resolution.ts`]);
  });
});

/**
 * Layer D's classification, asserted over the whole tree rather than over the
 * obligation runtime alone.
 *
 * The tests inside the obligation runtime assert what that module may not
 * reach; these assert what may not reach *into* it, that the one component
 * allowed to bridge D and the decision is the Kernel, and that the dependency
 * direction the future Grants layer will need is already the one in place.
 */
describe('Authority-control layering: the Obligation layer (D)', () => {
  const OBLIGATION_ROOT = 'src/features/obligation-runtime';

  it('the obligation runtime exists and is a real module', () => {
    assert.ok(existsSync(OBLIGATION_ROOT), 'the Obligation layer must exist as a module');
    assert.ok(existsSync(`${OBLIGATION_ROOT}/index.ts`), 'it must have a public entrypoint');
    assert.ok(existsSync(`${OBLIGATION_ROOT}/README.md`), 'a layer boundary that is not written down is a convention, not a boundary');
  });

  it('the policy runtime never reaches into the obligation runtime — B decides, D reads the result', () => {
    const policyFiles = walkTsFiles('src/features/domain-policy-pack-runtime').filter((file) => !file.includes('/tests/'));
    const leaks = importsMatching(policyFiles, /obligation-runtime/);
    assert.deepEqual(leaks, [], 'a policy rule must never be able to turn on whether an obligation was discharged');
  });

  it('the enforcement engine never reaches into the obligation runtime either', () => {
    const enforcementFiles = walkTsFiles('src/features/action-enforcement').filter((file) => !file.includes('/__tests__/') && !file.includes('/tests/'));
    const leaks = importsMatching(enforcementFiles, /obligation-runtime/);
    assert.deepEqual(leaks, [], 'the engine produces a decision; the obligation layer reads one');
  });

  it('the context runtime never reaches into the obligation runtime — C and D are independent boundaries', () => {
    const contextFiles = walkTsFiles('src/features/context-resolution-runtime').filter((file) => !file.includes('/tests/'));
    const leaks = importsMatching(contextFiles, /obligation-runtime/);
    assert.deepEqual(leaks, [], 'a context fact must never depend on an obligation, or the two security boundaries collapse into one');
  });

  it('the Kernel is the only component that composes the obligation port', () => {
    const kernelImporters = walkTsFiles('src/kernel')
      .filter((file) => !file.includes('/__tests__/'))
      .filter((file) => /obligation-runtime/.test(readFileSync(file, 'utf8')));
    assert.deepEqual(
      kernelImporters.map((file) => file.replace(/\\/g, '/')).sort(),
      [
        'src/kernel/contracts/ports.ts',
        // Names the module in a doc comment only, to say where the reason-code
        // constants live for a consumer that wants them. It re-exports types
        // from `obligation-adapter.ts` and imports nothing from layer D.
        'src/kernel/index.ts',
        'src/kernel/orchestration/obligation-adapter.ts',
        'src/kernel/orchestration/request-adapter.ts',
      ],
      'the obligation port is composed at exactly the kernel boundary, and nowhere else',
    );
  });

  it('the obligation runtime imports no layer above it, and no layer below it either', () => {
    const obligationFiles = walkTsFiles(OBLIGATION_ROOT).filter((file) => !file.includes('/tests/'));
    const leaks = importsMatching(obligationFiles, /from ['"][^'"]*(domain-policy-pack-runtime|action-enforcement|\/kernel\/|\/enterprise\/|context-resolution-runtime)/);
    assert.deepEqual(leaks, [], 'D never imports B, never imports C, and never imports the decision producer');
  });

  it('the obligation runtime never imports the Grants layer — D → future E, never the reverse', () => {
    const obligationFiles = walkTsFiles(OBLIGATION_ROOT).filter((file) => !file.includes('/tests/'));
    const leaks = importsMatching(obligationFiles, /access-grant|grant-revocation|scoped-access|capability-tokens|evidence-correlation/);
    assert.deepEqual(leaks, [], 'a future Grants layer consumes a typed obligation result; the obligation layer must not know it exists');
  });

  it('the obligation runtime never instantiates or invokes the Kernel — no recursive evaluation', () => {
    const obligationFiles = walkTsFiles(OBLIGATION_ROOT).filter((file) => !file.includes('/tests/'));
    const leaks = importsMatching(obligationFiles, /AocKernel|createAocKernel|kernel\.evaluate|\.enforce\(/);
    assert.deepEqual(leaks, [], 'an obligation reads the decision it is attached to; it never asks for another one');
  });

  it('the obligation runtime never sees an HTTP request type or a transport concept', () => {
    const obligationFiles = walkTsFiles(OBLIGATION_ROOT).filter((file) => !file.includes('/tests/'));
    const leaks = importsMatching(obligationFiles, /IncomingMessage|ServerResponse|node:http|from ['"]express|GovernanceEvaluateRequestBody/);
    assert.deepEqual(leaks, [], 'the capability is composed, never submitted');
  });

  it('the reserved obligation namespace is defined once, in the layer that owns it', () => {
    const definitions = walkTsFiles('src').filter((file) => /OBLIGATION_RESERVED_REQUEST_KEY_PREFIX\s*=/.test(readFileSync(file, 'utf8')));
    assert.deepEqual(definitions.map((file) => file.replace(/\\/g, '/')), [`${OBLIGATION_ROOT}/domain/obligation-resolution.ts`]);
  });

  it('the obligation adapter never writes an authorization field — it adds one and reads none', () => {
    const adapter = readFileSync('src/kernel/orchestration/obligation-adapter.ts', 'utf8');
    const start = adapter.indexOf('export function applyObligationStep');
    // The function body alone: the file's other exports legitimately *read* a
    // decision status to decide how to report a withheld execution, which is
    // the read-only orchestration boundary this layer is allowed.
    const applyStep = adapter.slice(start, adapter.indexOf('\n}', start));
    for (const forbidden of ['status:', 'reasonCodes:', 'summary:']) {
      assert.equal(applyStep.includes(forbidden), false, `applyObligationStep must not write '${forbidden}' — the decision is not its to change`);
    }
  });

  it('the exercise reason codes are a separate vocabulary from the authorization reason codes', async () => {
    const authorization = (await import('../../kernel/reason-codes/reason-codes.js')).AOC_KERNEL_REASON_CODES;
    const exercise = (await import('../../kernel/reason-codes/exercise-reason-codes.js')).AOC_KERNEL_EXERCISE_REASON_CODES;

    const authorizationCodes = new Set<string>(Object.values(authorization));
    const overlap = Object.values(exercise).filter((code) => authorizationCodes.has(code));
    assert.deepEqual(overlap, [], 'an exercise condition must never be expressible as an authorization reason, or the distinction is a typo away');
  });
});

describe('Structural boundaries: Grant Runtime (layer E)', () => {
  const GRANT_RUNTIME = walkTsFiles('src/features/grant-runtime').filter((file) => !file.includes('/tests/'));
  const KERNEL = walkTsFiles('src/kernel').filter((file) => !file.includes('/__tests__/'));

  it('the grant runtime has production sources to measure', () => {
    assert.ok(GRANT_RUNTIME.length >= 10, `expected grant runtime sources, found ${GRANT_RUNTIME.length}`);
  });

  it('the grant layer never imports the Kernel — E is read by the Kernel adapter, never the reverse', () => {
    assert.deepEqual(importsMatching(GRANT_RUNTIME, /from '[^']*\/kernel\//), []);
  });

  it('the grant layer never imports the Enterprise Host, the Governance Store or the legacy runtime', () => {
    assert.deepEqual(importsMatching(GRANT_RUNTIME, /from '[^']*\/enterprise\//), []);
    assert.deepEqual(importsMatching(GRANT_RUNTIME, /from '[^']*governance-store/), []);
    assert.deepEqual(importsMatching(GRANT_RUNTIME, /from '[^']*\/runtime\//), []);
  });

  it('the grant layer never imports layer C or layer D — it reads a projected decision, not the facts and discharges behind it', () => {
    assert.deepEqual(importsMatching(GRANT_RUNTIME, /from '[^']*context-resolution-runtime/), []);
    assert.deepEqual(importsMatching(GRANT_RUNTIME, /from '[^']*obligation-runtime/), []);
  });

  it('no circular dependency exists between the grant layer and the layers it reads', () => {
    const contextAndObligation = [...walkTsFiles('src/features/context-resolution-runtime'), ...walkTsFiles('src/features/obligation-runtime')].filter(
      (file) => !file.includes('/tests/'),
    );
    assert.deepEqual(importsMatching(contextAndObligation, /from '[^']*grant-runtime/), [], 'C and D must never reach forward into E');
  });

  it('the grant layer never reaches a ledger, a signer or a wallet — a bounded grant is provider-neutral', () => {
    for (const pattern of [/\bxrpl\b/i, /\bxrp-ledger\b/i, /\bsignTransaction\b/, /\bwallet\b/i, /\bledgerIndex\b/i, /\bsequenceNumber\b/i]) {
      assert.deepEqual(importsMatching(GRANT_RUNTIME, pattern), [], `grant sources must not mention ${String(pattern)}`);
    }
  });

  it('the Kernel issues no grant — only eligibility crosses into evaluate(), and issuance lives in the feature', () => {
    // Measured on imports rather than on any mention of the name: the adapter's
    // own doc comments point a reader at `createGrantIssuanceService`, which is
    // the documentation working, not a dependency.
    const importedNames = /import\s*\{[^}]*\b(createGrantIssuanceService|createInMemoryBoundedGrantStore|BoundedGrantStorePort|GrantIssuanceService)\b[^}]*\}/;
    assert.deepEqual(importsMatching(KERNEL, importedNames), [], 'no production Kernel source may import the issuance path or the grant store');
  });

  it('the Kernel result carries no grant artifact type — evaluate() reports eligibility, never an issued grant', () => {
    const contracts = readFileSync('src/kernel/contracts/kernel-result.ts', 'utf8');
    assert.equal(/\bBoundedGrant\b/.test(contracts), false, 'a grant artifact must not travel on an evaluation result');
  });

  it('the grant step reads no decision field — it adds a field and changes nothing', () => {
    const adapter = readFileSync('src/kernel/orchestration/grant-adapter.ts', 'utf8');
    const applyStep = adapter.slice(adapter.indexOf('export function applyGrantStep'));
    for (const forbidden of ['result.status', 'result.reasonCodes', 'result.summary', 'result.policies']) {
      assert.equal(applyStep.includes(forbidden), false, `applyGrantStep must not read ${forbidden}`);
    }
  });
});
