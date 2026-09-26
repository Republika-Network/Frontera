import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

/**
 * Drift protection for `docs/security/NO_BYPASS_AUTHORITY_CONTROLLED_EXECUTION.md`.
 *
 * That document's central claim is **resource-centric**: for each protected
 * resource, every way to reach it is enumerated. A claim of that shape decays
 * the moment a new way to reach one of those resources appears, and nothing in
 * this repository failed the build when that happened.
 *
 * These assertions pin the reachability facts the document's claims are built
 * on, and nothing else. Specifically:
 *
 * 1. **The bounded-grant gate is the only Frontera route to an execution
 *    adapter — repository-wide.** `security-invariants.test.ts` asserts the
 *    call sites too, but it walks only `src/features/execution-runtime`.
 *    `src/enterprise/execution-governance/service.ts` holds the *same*
 *    `ExecutionAdapter` reference and lies outside that scan, so a call added
 *    there would have voided SEC-INV-011 with every existing test still green
 *    (NB-001). This widens the scan to `src/`, `packages/` and `apps/`.
 *
 *    Since the execution adapter registry, there are **two** call sites rather
 *    than one, and the claim is correspondingly two-part: the gate invokes the
 *    composite, and the composite invokes exactly one trusted child, after
 *    routing and after the emergency-control check. Both are pinned below, and
 *    so is the ordering inside each, because "two call sites" is only safe
 *    while the second is reachable solely through the first.
 *
 * 2. **The egress inventory stays complete.** The document claims the entire
 *    outbound network surface is two provider SDKs at five construction sites.
 *    A sixth appearing silently would falsify §14 and §18.1 claim 10 without
 *    any test noticing, so each discovered site must also be named in the
 *    document.
 *
 * 3. **The grant is read, never received.** The exercise path's strength comes
 *    from the caller supplying an identifier and a description of the attempt,
 *    and from `subject`/`notAfter` crossing to the adapter having been read
 *    from the trusted store rather than from the request.
 *
 * 4. **The two separate provider authority models stay off the published
 *    surface.** NB-010 records that a published-package consumer cannot reach
 *    Pinata through Frontera. That property is incidental — one barrel export
 *    would lose it — so it is pinned here.
 *
 * 5. **The Agent Passport Web effect surface stays enumerated.** Its threat
 *    model counted `app/api/**\/route.ts` files. A Next.js Server Action is
 *    HTTP-invocable and is not a route file, which is how EP-037 went
 *    unmodelled (NB-004).
 *
 * Every assertion below asserts a property that is **already true** at the
 * commit that introduced this file. None changes production behaviour, and
 * none is a containment feature. §25 of the Prompt 3 result records the
 * non-vacuity validation: each rule was checked to fail when the property it
 * protects is deliberately violated.
 */

const NO_BYPASS_DOC = 'docs/security/NO_BYPASS_AUTHORITY_CONTROLLED_EXECUTION.md';

const SOURCE_ROOTS = ['src', 'packages', 'apps'] as const;

const CODE_EXTENSIONS = ['.ts', '.tsx'] as const;

/** Directory names that never hold production source. */
const NON_PRODUCTION_DIRECTORIES = new Set(['__tests__', 'tests', 'node_modules', 'dist', 'dist-test', '.next']);

/** Files that are test scaffolding despite living outside a test directory. */
function isProductionSource(file: string): boolean {
  if (file.includes('.test.')) return false;
  if (file.endsWith('.fixture.ts')) return false;
  if (file.includes('/fixtures/')) return false;
  return true;
}

function walkSources(dir: string): readonly string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (NON_PRODUCTION_DIRECTORIES.has(name)) continue;
      out.push(...walkSources(full));
    } else if (CODE_EXTENSIONS.some((extension) => full.endsWith(extension)) && isProductionSource(full)) {
      out.push(full);
    }
  }
  return out;
}

/**
 * A source file with block and line comments removed.
 *
 * The same technique `security-invariants.test.ts` and
 * `execution-layer-boundaries.test.ts` use, and for the same reason: what is
 * forbidden is a *call* or an *import*, not a word. The doc comments in this
 * repository legitimately discuss `adapter.execute(`, `new PinataSDK` and
 * `require('stripe')` in order to explain the boundaries around them, and a
 * rule that punished the explanation would push the explanation out of the
 * file.
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

const PRODUCTION_SOURCES = SOURCE_ROOTS.flatMap((root) => walkSources(root));

const DOC = existsSync(NO_BYPASS_DOC) ? readFileSync(NO_BYPASS_DOC, 'utf8') : '';

describe('NB — the canonical no-bypass document exists and is measurable', () => {
  it('has real production sources to measure, across all three roots', () => {
    assert.ok(PRODUCTION_SOURCES.length >= 500, `expected the repository to have production sources, found ${PRODUCTION_SOURCES.length}`);
    for (const root of SOURCE_ROOTS) {
      assert.ok(
        PRODUCTION_SOURCES.some((file) => file.startsWith(`${root}/`)),
        `${root}/ contributed no production sources — the scan below would be vacuous for it`,
      );
    }
  });

  it('the comment stripper keeps code and drops prose, so the rules below are not vacuous', () => {
    const service = codeOf('src/features/execution-runtime/services/grant-execution-service.ts');
    assert.equal(service.includes('await adapter.execute(action)'), true, 'real code must survive stripping');
    assert.equal(service.includes('adapter NOT called'), false, 'doc-comment prose must be stripped');
  });

  it('exists and is the canonical artifact', () => {
    assert.ok(DOC.length > 0, `${NO_BYPASS_DOC} is the canonical no-bypass artifact and must exist`);
  });
});

describe('NB-001 — repository-wide, only the enumerated production sources invoke an execution adapter', () => {
  /**
   * Matches an invocation through any identifier or member expression whose
   * name ends in `adapter` (case-insensitive) — `adapter.execute(`,
   * `executionAdapter.execute(`, `this.adapter.execute(`,
   * `options.executionAdapter.execute(`, `childAdapter.execute(`. That is every
   * spelling the modules holding an `ExecutionAdapter` actually use, and every
   * spelling a new holder would plausibly use — which is why the registry's
   * resolved child is deliberately named `childAdapter` rather than `child`: a
   * call site this pattern cannot see is a call site the inventory loses.
   */
  const ADAPTER_INVOCATION = /\b[\w$]*[Aa]dapter\s*\.\s*execute\s*\(/;

  it('the invocation pattern matches the real call site and not its prose', () => {
    assert.equal(ADAPTER_INVOCATION.test('result = await adapter.execute(action);'), true);
    assert.equal(ADAPTER_INVOCATION.test('await options.executionAdapter.execute(action);'), true);
    assert.equal(ADAPTER_INVOCATION.test('the adapter is invoked only after a usable assessment'), false);
  });

  it('is invoked from exactly the two enumerated production sources — the gate, and the composite it may route through', () => {
    const callSites = PRODUCTION_SOURCES.filter((file) => ADAPTER_INVOCATION.test(codeOf(file)));
    assert.deepEqual(
      callSites.slice().sort(),
      [
        // The registry is a **composite** ExecutionAdapter: it satisfies the
        // port, it is reached only through the gate below, and it resolves one
        // trusted child. `GrantExecutionService -> registry -> child adapter` is
        // one provider boundary, not a second way in — which the ordering rule
        // in this suite proves rather than asserts in prose.
        'src/features/execution-runtime/services/execution-adapter-registry.ts',
        'src/features/execution-runtime/services/grant-execution-service.ts',
      ],
      'SEC-INV-011 holds only because every place an ExecutionAdapter can be invoked is enumerated. ' +
        'A third call site — in src/enterprise/execution-governance, in an app, or anywhere else — voids the ' +
        'PROVEN classification of EP-011 in NO_BYPASS_AUTHORITY_CONTROLLED_EXECUTION.md §17. ' +
        'If a new call site is legitimate, it is a new effect path and needs its own EP id.',
    );
  });

  it('every production holder of the ExecutionAdapter port is accounted for', () => {
    const holders = PRODUCTION_SOURCES.filter((file) => /\bExecutionAdapter\b/.test(codeOf(file)));
    assert.deepEqual(
      holders.slice().sort(),
      [
        // Type-only: the composition root builds the registry from the host's
        // trusted routing table and hands the result to ACE. It invokes nothing.
        'src/enterprise/composition/composition-root.ts',
        // P6: the Generic HTTP adapter **implements** the port — it is a child
        // the composition root hands to the registry. It invokes no adapter;
        // its one outbound call is enumerated by the network scan below.
        'src/enterprise/execution-adapters/generic-http/generic-http-execution-adapter.ts',
        'src/enterprise/execution-governance/service.ts',
        // Type-only (PROD-01): the Enterprise Host bootstrap hands embedder
        // adapters to the composition root's registry and supplies the trusted
        // route selector. It invokes nothing.
        'src/enterprise/host/enterprise-host.ts',
        // Deliberately NOT `src/enterprise/index.ts`: the Enterprise barrel has
        // never re-exported a `src/features` type — not `BoundedGrantStorePort`,
        // not `KernelGrantCapability`, not `ExecutionAdapter` — even where an
        // option type it exports already names one. Routing did not become the
        // exception.
        'src/features/execution-runtime/domain/execution-adapter-port.ts',
        'src/features/execution-runtime/domain/index.ts',
        'src/features/execution-runtime/services/execution-adapter-registry.ts',
        'src/features/execution-runtime/services/grant-execution-service.ts',
      ],
      'NO_BYPASS_AUTHORITY_CONTROLLED_EXECUTION.md §7.1 enumerates every ExecutionAdapter reference. ' +
        'A new holder is a new potential call site and must be added there before it ships.',
    );
  });

  it('the registry invokes at most one child, and only after routing and the emergency-control check', () => {
    const registry = codeOf('src/features/execution-runtime/services/execution-adapter-registry.ts');
    const invocations = [...registry.matchAll(/\b[\w$]*[Aa]dapter\s*\.\s*execute\s*\(/g)];
    assert.equal(invocations.length, 1, 'one routing decision must resolve to exactly one child invocation, written once');

    const select = registry.indexOf('selectAdapter(action)');
    const resolve = registry.indexOf('resolved.get(selected)');
    const unresolvedGuard = registry.indexOf('if (member === undefined)');
    const emergency = registry.indexOf('readEmergencyControl(emergencyControl');
    const permits = registry.indexOf('if (!emergencyControlPermits(assessment))');
    const call = registry.search(/\b[\w$]*[Aa]dapter\s*\.\s*execute\s*\(/);
    for (const [label, index] of [['selection', select], ['resolution', resolve], ['unresolved guard', unresolvedGuard], ['emergency read', emergency], ['emergency gate', permits]] as const) {
      assert.notEqual(index, -1, `the registry must still perform ${label}`);
    }
    assert.ok(select < resolve, 'the selector runs before the adapter is resolved');
    assert.ok(resolve < unresolvedGuard, 'an unresolved route is refused before anything is invoked');
    assert.ok(unresolvedGuard < emergency, 'the emergency check runs on a resolved child, so it can be adapter-scoped');
    assert.ok(permits < call, 'no child may be invoked before the emergency-control gate has returned');
  });

  it('the composite is only reachable through the bounded-grant gate: it holds no store, no Kernel and no policy', () => {
    const registry = codeOf('src/features/execution-runtime/services/execution-adapter-registry.ts');
    for (const forbidden of ['AocKernel', 'KernelEvaluation', 'BoundedGrant', 'GovernanceStore', 'issueGrant', 'assessBoundedGrantExercise', 'evaluatePolicy', 'authorizationHeader']) {
      assert.equal(registry.includes(forbidden), false, `the registry must not reference ${forbidden}: routing chooses where, never whether`);
    }
    for (const match of readFileSync('src/features/execution-runtime/services/execution-adapter-registry.ts', 'utf8').matchAll(/from '([^']+)'/g)) {
      const specifier = match[1] ?? '';
      assert.ok(
        specifier === '../domain/index.js' || specifier === '../../emergency-control-runtime/index.js',
        `the registry imports '${specifier}'; its inputs are the validated action, a trusted selector, trusted adapters and an optional emergency-control reader`,
      );
    }
  });

  it('the single invocation is still preceded, in the same function, by the store read and the usable-assessment gate', () => {
    const service = codeOf('src/features/execution-runtime/services/grant-execution-service.ts');
    const read = service.lastIndexOf('await store.read(');
    const gate = service.indexOf('if (!assessment.usable');
    const call = service.search(/\badapter\s*\.\s*execute\s*\(/);
    assert.notEqual(read, -1, 'the authoritative store must still be re-read inside the exercising function');
    assert.notEqual(gate, -1, 'the usable-assessment gate must still exist');
    assert.notEqual(call, -1, 'the adapter invocation must still exist');
    assert.ok(read < gate, 'the grant must be read before it is assessed');
    assert.ok(gate < call, 'the adapter may only be invoked after the usable-assessment gate has returned');
  });
});

describe('NB — the grant is read, never received (SEC-INV-012)', () => {
  const REQUEST_SOURCE = 'src/features/execution-runtime/domain/grant-exercise-request.ts';

  it('the exercise request declares no grant-content field', () => {
    const declaration = /export interface GrantExerciseRequest \{([\s\S]*?)\n\}/.exec(codeOf(REQUEST_SOURCE));
    assert.ok(declaration?.[1] !== undefined, 'GrantExerciseRequest must remain a declared interface');
    const body = declaration[1];
    for (const field of ['scope', 'expiresAt', 'issuedAt', 'notAfter', 'digest', 'sourceDigest', 'revocation', 'grant:', 'payload']) {
      assert.equal(
        body.includes(field),
        false,
        `GrantExerciseRequest must not carry '${field}'. A caller supplies a grant identifier and a description of ` +
          'the attempt; anything about the grant itself is read from the trusted store (SEC-INV-012).',
      );
    }
  });

  it('the values crossing the adapter boundary come from the store, not from the request', () => {
    const service = codeOf('src/features/execution-runtime/services/grant-execution-service.ts');
    const action = /const action: ValidatedExecutionAction = \{([\s\S]*?)\n\s*\};/.exec(service);
    assert.ok(action?.[1] !== undefined, 'the validated action must still be assembled in one place');
    const body = action[1];
    assert.ok(/subject:\s*trustedGrant\.subject/.test(body), 'subject crossing the boundary must be the grant subject read from the store, never request.subject');
    assert.ok(/notAfter:\s*trustedGrant\.expiresAt/.test(body), 'notAfter crossing the boundary must be the grant horizon read from the store, never a caller value');
    assert.equal(/subject:\s*request\./.test(body), false, 'the caller may not describe the holder that reaches the adapter');
    assert.equal(/notAfter:\s*request\./.test(body), false, 'the caller may not describe the horizon that reaches the adapter');
  });

  it('both store-read values are sourced from the grant the read returned — the latest authoritative read', () => {
    const service = codeOf('src/features/execution-runtime/services/grant-execution-service.ts');
    assert.ok(/grant:\s*read\.grant,/.test(service), 'the trusted grant must be the one the store read returned');
    const assignments = [...service.matchAll(/\btrustedGrant\s*=(?!=)\s*([^;\n]+)/g)].map((match) => (match[1] ?? '').trim());
    assert.deepEqual(assignments, ['first.grant', 'second.grant'], 'the trusted grant is only ever a store read result: read #1, then read #2 after the reservation');
  });
});

describe('NB — the provider egress inventory stays complete', () => {
  const PINATA_SDK = /(?:from|import|require)\s*\(?\s*['"]pinata['"]/;
  const STRIPE_SDK = /(?:from|import|require)\s*\(?\s*['"]stripe['"]|new\s+Stripe\s*\(/;

  const EXPECTED_PINATA_SITES = ['packages/pinata-adapter/src/pinata-provider-client.ts'];

  const EXPECTED_STRIPE_SITES = [
    'apps/agent-passport-web/src/app/api/checkout/session/route.ts',
    'apps/agent-passport-web/src/app/api/organization-registry/recover/route.ts',
    'apps/agent-passport-web/src/app/api/stripe/webhook/route.ts',
    'apps/agent-passport-web/src/lib/stripe-billing-service.ts',
  ];

  /**
   * The sample specifiers below are assembled at runtime rather than written
   * out. This repository already runs its own provider-SDK import-boundary
   * scanners — `packages/pinata-adapter/scripts/check-pinata-boundary.mjs` and
   * the two `compute-*-pinata-boundary-evidence.mjs` scripts — over every `.ts`
   * file including this one, matching the provider specifier textually. A literal
   * sample import here is indistinguishable from a real one to those scanners
   * and would fail the provider-conformance suites. Splitting the specifier
   * keeps this self-check honest without tripping a sibling boundary check.
   */
  const PINATA_SPECIFIER = ['pin', 'ata'].join('');
  const STRIPE_SPECIFIER = ['str', 'ipe'].join('');

  it('the detection patterns match a real import and not a mention of one', () => {
    assert.equal(PINATA_SDK.test(`import { PinataSDK } from '${PINATA_SPECIFIER}';`), true);
    assert.equal(PINATA_SDK.test(`const sdk = require('${PINATA_SPECIFIER}');`), true);
    assert.equal(PINATA_SDK.test('this module never imports the raw provider SDK'), false);
    assert.equal(STRIPE_SDK.test(`const Stripe = (await import('${STRIPE_SPECIFIER}')).default;`), true);
    assert.equal(STRIPE_SDK.test(`const Stripe = require('${STRIPE_SPECIFIER}');`), true);
    assert.equal(STRIPE_SDK.test('the billing boundary is documented separately'), false);
  });

  it('the Pinata SDK is constructed in exactly one production source', () => {
    const sites = PRODUCTION_SOURCES.filter((file) => PINATA_SDK.test(codeOf(file)));
    assert.deepEqual(
      sites.slice().sort(),
      EXPECTED_PINATA_SITES,
      'NO_BYPASS_AUTHORITY_CONTROLLED_EXECUTION.md §7.5 and §14.1 enumerate every route to the Pinata account. ' +
        'A new SDK import is a new route and must be added to the effect-path inventory with its own EP id.',
    );
  });

  it('the Stripe SDK is constructed only in the four enumerated Agent Passport Web sources', () => {
    const sites = PRODUCTION_SOURCES.filter((file) => STRIPE_SDK.test(codeOf(file)));
    assert.deepEqual(
      sites.slice().sort(),
      EXPECTED_STRIPE_SITES,
      'NO_BYPASS_AUTHORITY_CONTROLLED_EXECUTION.md §11.1 and §14.3 enumerate every route to the Stripe merchant account.',
    );
  });

  it('no module under src/ or packages/ reaches Stripe, and none outside the Pinata adapter reaches Pinata', () => {
    for (const file of PRODUCTION_SOURCES) {
      const code = codeOf(file);
      if (file.startsWith('src/') || file.startsWith('packages/')) {
        assert.equal(STRIPE_SDK.test(code), false, `${file} must not reach Stripe — billing is the Agent Passport Web application's own effect domain`);
      }
      if (!file.startsWith('packages/pinata-adapter/')) {
        assert.equal(
          PINATA_SDK.test(code),
          false,
          `${file} must not import the raw Pinata SDK — every consumer talks to the provider-neutral PinataProviderClient seam`,
        );
      }
    }
  });

  it('every egress site is named in the canonical no-bypass document', () => {
    for (const site of [...EXPECTED_PINATA_SITES, ...EXPECTED_STRIPE_SITES]) {
      const basename = site.slice(site.lastIndexOf('/') + 1);
      assert.ok(
        DOC.includes(site) || DOC.includes(basename),
        `${site} produces an external effect and must appear in ${NO_BYPASS_DOC}. ` +
          'An egress site absent from the inventory is covered by no claim in §18.',
      );
    }
  });
});

describe('NB — P6: the Generic HTTP adapter is the one enumerated outbound network call site in src/ and packages/', () => {
  /**
   * An outbound client primitive: a Node network *client* module imported, or
   * a client call made. The inbound HTTP server (`node:http` in the Enterprise
   * listener and the host) is a separate, already-inventoried surface (EP-009)
   * and is pinned separately below, so a client call added there fails too.
   */
  const CLIENT_MODULE = /from\s+['"](?:node:)?(?:https|dns|net|tls|dgram|http2)['"]|require\s*\(\s*['"](?:node:)?(?:https|dns|net|tls|dgram|http2)['"]\s*\)/;
  const CLIENT_CALL = /\b(?:https?|net|tls|http2|dgram)\s*\.\s*(?:request|get|connect|createConnection|createSocket)\s*\(|\bnew\s+(?:net\.)?Socket\s*\(|\bundici\b|\bnode-fetch\b|\baxios\b|\bgot\s*\(/;

  /** Type-only imports carry no capability — `import type { AddressInfo } from 'node:net'` opens nothing — so they are not sites. */
  const valueCode = (file: string): string => codeOf(file).replace(/import\s+type\s[^;]*;/g, '');

  const EXPECTED_CLIENT_MODULE_SITES = [
    // `node:https` and `node:dns`: the single bound transport.
    'src/enterprise/execution-adapters/generic-http/node-https-transport.ts',
    // `isIP` / `isIPv4` / `isIPv6` from `node:net` — syntax checks, no socket.
    'src/enterprise/execution-adapters/generic-http/configuration.ts',
    'src/enterprise/execution-adapters/generic-http/public-address-policy.ts',
  ];

  it('the detection patterns match a real client import or call and not a mention of one', () => {
    assert.equal(CLIENT_MODULE.test("import { request } from 'node:https';"), true);
    assert.equal(CLIENT_MODULE.test("import { lookup } from 'dns';"), true);
    assert.equal(CLIENT_MODULE.test("const tls = require('node:tls');"), true);
    assert.equal(CLIENT_MODULE.test("import { createServer } from 'node:http';"), false, 'the inbound server module is pinned separately');
    assert.equal(CLIENT_CALL.test('const req = https.request(options);'), true);
    assert.equal(CLIENT_CALL.test('http.get(url)'), true);
    assert.equal(CLIENT_CALL.test('net.connect(443, host)'), true);
    assert.equal(CLIENT_CALL.test('the adapter makes one request to the provider'), false);
  });

  it('only the enumerated Generic HTTP modules import a network client module', () => {
    const sites = PRODUCTION_SOURCES.filter((file) => (file.startsWith('src/') || file.startsWith('packages/')) && CLIENT_MODULE.test(valueCode(file)));
    assert.deepEqual(
      sites.slice().sort(),
      EXPECTED_CLIENT_MODULE_SITES.slice().sort(),
      'NO_BYPASS_AUTHORITY_CONTROLLED_EXECUTION.md §7.6 enumerates every outbound network client site. A second one is a new effect path and needs its own EP id.',
    );
  });

  it('exactly one production source performs outbound network I/O, and it is the Generic HTTP transport (EP-050)', () => {
    const transport = 'src/enterprise/execution-adapters/generic-http/node-https-transport.ts';
    const importsClient = (file: string): boolean => /from\s+['"]node:(?:https|dns)['"]/.test(valueCode(file));
    // `fetch(` is counted under src/ only: packages/ holds the customer-side
    // SDK, whose fetch is the caller reaching Frontera, not Frontera reaching a provider.
    const fetches = (file: string): boolean => file.startsWith('src/') && /\bfetch\s*\(/.test(codeOf(file));
    const sites = PRODUCTION_SOURCES.filter((file) => (file.startsWith('src/') || file.startsWith('packages/')) && (importsClient(file) || CLIENT_CALL.test(codeOf(file)) || fetches(file)));
    assert.deepEqual(sites, [transport], 'a second outbound network call site fails the build: add it to the inventory with its own EP id first');
    const code = codeOf(transport);
    assert.equal([...code.matchAll(/\bprimitive\s*\(/g)].length, 1, 'the transport invokes its request primitive from exactly one place');
    assert.equal([...code.matchAll(/\bhttpsRequest\b/g)].length, 2, 'node:https request is imported once and bound once, in the production runtime');
    assert.equal([...code.matchAll(/dnsPromises\s*\.\s*lookup\s*\(/g)].length, 1, 'the resolver is called from exactly one place');
  });

  it('the inbound node:http modules make no outbound call', () => {
    for (const file of ['src/enterprise/adapters/node-http-adapter.ts', 'src/enterprise/host/enterprise-server.ts']) {
      const code = codeOf(file);
      assert.equal(CLIENT_CALL.test(code), false, `${file} must not make an outbound network call`);
      assert.equal(/\brequest\s*\(\s*\{/.test(code), false);
    }
  });

  it('the transport is reachable only through the adapter core, which is reachable only through the composition root', () => {
    const importers = PRODUCTION_SOURCES.filter((file) => /from '[^']*node-https-transport\.js'/.test(readFileSync(file, 'utf8')));
    assert.deepEqual(importers, ['src/enterprise/execution-adapters/generic-http/generic-http-execution-adapter.ts']);
    const factoryUsers = PRODUCTION_SOURCES.filter((file) => /createGenericHttpExecutionAdapter\s*\(/.test(codeOf(file)) && !file.includes('/execution-adapters/generic-http/'));
    assert.deepEqual(factoryUsers, ['src/enterprise/composition/composition-root.ts']);
  });
});

describe('NB-010 — the separate provider authority models stay off the published surface', () => {
  it('src/enterprise/index.ts barrels neither Sovereign Access nor Content Protection', () => {
    const barrel = codeOf('src/enterprise/index.ts');
    for (const symbol of ['createAccessGrantService', 'createContentProtectionService', 'createPinataContentStorageAdapter']) {
      assert.equal(
        barrel.includes(symbol),
        false,
        `${symbol} must not be re-exported from the Enterprise barrel. NO_BYPASS_AUTHORITY_CONTROLLED_EXECUTION.md ` +
          '§3.1 and NB-010 claim a published-package consumer cannot reach Pinata through Frontera; a barrel export loses that.',
      );
    }
  });

  it('the package exports map resolves to no subpath under either module', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { readonly exports?: Record<string, unknown> };
    const exportsMap = pkg.exports ?? {};
    const targets = JSON.stringify(exportsMap);
    assert.equal(targets.includes('access-governance'), false, 'no exports subpath may resolve into access-governance');
    assert.equal(targets.includes('content-protection'), false, 'no exports subpath may resolve into content-protection');
    assert.equal(Object.keys(exportsMap).includes('./*'), false, 'a wildcard subpath would expose every internal module and void NB-010');
  });

  it('the Pinata adapter is neither a declared dependency nor a bundled one of the published artifact', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as {
      readonly dependencies?: Record<string, string>;
      readonly bundleDependencies?: readonly string[];
    };
    assert.equal(
      Object.keys(pkg.dependencies ?? {}).includes('@aoc-enterprise/pinata-adapter'),
      false,
      'declaring the Pinata adapter as a runtime dependency would make the provider reachable from a published consumer (NB-010)',
    );
    assert.equal(
      (pkg.bundleDependencies ?? []).includes('@aoc-enterprise/pinata-adapter'),
      false,
      'bundling the Pinata adapter would make the provider reachable from a published consumer (NB-010)',
    );
  });
});

describe('NB-004 — the Agent Passport Web effect surface stays enumerated', () => {
  const APP_ROOT = 'apps/agent-passport-web/src/app';

  function routeFiles(dir: string): readonly string[] {
    if (!existsSync(dir)) return [];
    const out: string[] = [];
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) out.push(...routeFiles(full));
      else if (name === 'route.ts') out.push(full);
    }
    return out;
  }

  it('the route-file count still matches the inventoried surface', () => {
    const routes = routeFiles(APP_ROOT);
    assert.equal(
      routes.length,
      31,
      'AGENT_PASSPORT_WEB_THREAT_MODEL.md §5 and NO_BYPASS_AUTHORITY_CONTROLLED_EXECUTION.md §5.10 inventory 31 route files. ' +
        `Found ${routes.length}. A new route is a new effect path and needs an EP id before it ships.`,
    );
  });

  it('every Next.js Server Action file is named in the effect-path inventory', () => {
    const actionFiles = walkSources(APP_ROOT).filter((file) => /^\s*['"]use server['"]/m.test(readFileSync(file, 'utf8')));
    assert.ok(actionFiles.length >= 1, 'the detection must find the known Server Action, or it is vacuous');
    for (const file of actionFiles) {
      assert.ok(
        DOC.includes(file) || DOC.includes(file.replace('apps/agent-passport-web/src/', '')),
        `${file} is a Server Action: HTTP-invocable, and not a route file. It must appear in ${NO_BYPASS_DOC}. ` +
          'This is exactly how EP-037 went unmodelled (NB-004).',
      );
    }
  });

  it('no Agent Passport Web source reaches the Core bounded-grant execution path', () => {
    for (const file of walkSources('apps/agent-passport-web/src')) {
      const code = codeOf(file);
      for (const symbol of ['AocKernel', 'BoundedGrant', 'GrantExecutionService', 'AuthorityControlledExecution']) {
        assert.equal(
          code.includes(symbol),
          false,
          `${file} must not reach ${symbol}. §10 excepts this application from the Core proof precisely because it does not.`,
        );
      }
    }
  });
});

describe('NB — the canonical document keeps its shape', () => {
  const CLASSIFICATIONS = [
    'PROVEN — PATH LOCAL',
    'EXCEPTED — SEPARATE AUTHORITY MODEL',
    'PARTIALLY BOUND',
    'DEPLOYMENT-GATED',
    'NON-EFFECTING',
    'DEAD / UNREACHABLE',
  ] as const;

  it('defines every classification it uses', () => {
    for (const classification of CLASSIFICATIONS) {
      assert.ok(DOC.includes(classification), `the classification vocabulary must define ${classification}`);
    }
  });

  it('assigns a contiguous EP id to every effect path, with none skipped', () => {
    const ids = new Set([...DOC.matchAll(/\bEP-(\d{3})\b/g)].map((match) => Number(match[1])));
    assert.ok(ids.size >= 40, `expected the effect-path inventory to be populated, found ${ids.size} ids`);
    const highest = Math.max(...ids);
    for (let id = 1; id <= highest; id += 1) {
      assert.ok(ids.has(id), `EP-${String(id).padStart(3, '0')} is missing — effect-path ids must be contiguous so none is silently dropped`);
    }
  });

  it('assigns a contiguous NB id to every finding', () => {
    const ids = new Set([...DOC.matchAll(/\bNB-(\d{3})\b/g)].map((match) => Number(match[1])));
    assert.ok(ids.size >= 8, `expected findings to be recorded, found ${ids.size}`);
    const highest = Math.max(...ids);
    for (let id = 1; id <= highest; id += 1) {
      assert.ok(ids.has(id), `NB-${String(id).padStart(3, '0')} is missing — finding ids must be contiguous`);
    }
  });

  it('keeps the bounded-grant claim scoped to its path and never states it system-wide', () => {
    assert.ok(/PATH-LOCAL/.test(DOC), 'the document must keep using the PATH-LOCAL scope token');
    assert.ok(
      DOC.includes('Eight of fifty-five effect paths are under bounded-grant control.'),
      'the document must keep stating how few effect paths are bounded-grant controlled — that is the number every external claim must be consistent with. ' +
        'Prompt 4 raised the denominator from forty-six to forty-eight (EP-047/EP-048, the emergency-control operator writes) and left the numerator at three: ' +
        'the execution adapter registry added no effect path. P5 added EP-049, the customer HTTP entry onto the bounded-grant path itself, ' +
        'and P6 added EP-050, the Generic HTTP adapter\'s outbound call below that same path — which is why both numbers moved by one each time, and only for those paths. ' +
        'P7 added EP-051 … EP-053, the exercise-control reserve / settle / release writes reachable only inside the bounded-grant gate — local authority-state writes, not provider effects — so both moved by three. ' +
        'P12 added EP-054 (a host resolution authority\'s status query) and EP-055 (the P7 resolution row), both deployment-gated trusted in-process paths outside the bounded-grant gate, so only the denominator moved, by two.',
    );
  });

  it('the classification totals add up to the stated denominator and the numerator matches the PROVEN — PATH LOCAL row', () => {
    const section = DOC.slice(DOC.indexOf('### 5.11 Classification totals'), DOC.indexOf('## 6. Bounded-Grant Execution Proof'));
    const rows = section.split('\n').filter((line) => /^\| [A-Z]/.test(line) && !line.startsWith('| Classification') && !line.startsWith('| **Total**'));
    const counts = rows.map((line) => Number(/\*\*(\d+)\*\*/.exec(line)?.[1] ?? Number.NaN));
    assert.ok(counts.every((count) => Number.isInteger(count)), 'every classification row states a count');
    const total = counts.reduce((sum, count) => sum + count, 0);
    assert.equal(total, Number(/\| \*\*Total\*\* \| \*\*(\d+)\*\*/.exec(section)?.[1]), 'the rows must add up to the stated total');
    const ids = new Set([...DOC.matchAll(/\*\*EP-(\d{3})\*\*/g)].map((match) => match[1]));
    assert.equal(total, ids.size, 'the total must equal the number of inventoried EP rows');
    const pathLocal = rows.find((line) => line.startsWith('| PROVEN — PATH LOCAL'));
    assert.ok(pathLocal?.includes('**8**') && pathLocal.includes('EP-050') && pathLocal.includes('EP-053'));
  });

  it('inventories the Generic HTTP outbound call as its own effect path, path-local, and without an egress claim', () => {
    const row = DOC.split('\n').find((line) => line.startsWith('| **EP-050** |'));
    assert.ok(row !== undefined, 'the Generic HTTP adapter introduces a concrete network effect site and needs its own EP id');
    assert.ok(row.includes('node-https-transport.ts'), 'EP-050 must name the call site');
    assert.ok(row.includes('PROVEN — PATH LOCAL'));
    assert.ok(/composition-gated/i.test(row), 'EP-050 exists only when a deployment composes a Generic HTTP adapter');
    assert.equal(/blocks all (unauthorized )?egress|system-wide egress control is (now )?implemented/i.test(DOC), false, 'application-level origin pinning is never described as an egress firewall');
    assert.ok(DOC.includes('does **not** retroactively govern'), 'the qualification that P6 governs no other path must stay recorded');
  });

  it('inventories the P7 exercise-control writes as three path-local authority-state writes, split by direction, and adds no provider path', () => {
    for (const [id, direction, method] of [
      ['EP-051', 'restricting', 'ExerciseControlLedgerPort.reserve'],
      ['EP-052', 'neutral', 'ExerciseControlLedgerPort.settle'],
      ['EP-053', 'permitting direction', 'ExerciseControlLedgerPort.release'],
    ] as const) {
      const row = DOC.split('\n').find((line) => line.startsWith(`| **${id}** |`));
      assert.ok(row !== undefined, `${id} must be inventoried`);
      assert.ok(row.includes('PROVEN — PATH LOCAL'), `${id} must be path-local`);
      assert.ok(row.includes(direction), `${id} must state its direction`);
      assert.ok(row.includes(method), `${id} must name its write`);
      assert.ok(/composition-gated|as EP-051/.test(row), `${id} exists only when exercise controls are composed`);
      assert.equal(/EXTERNAL/.test(row), false, `${id} is not a provider effect`);
    }
    assert.ok(DOC.includes('local authority-state writes, not provider effects'), 'the P7 qualification must stay recorded');
    assert.ok(DOC.includes('P7 does **not** retroactively govern'), 'P7 governs no other path');
    const ep050 = DOC.split('\n').find((line) => line.startsWith('| **EP-050** |')) ?? '';
    assert.ok(ep050.includes('EP-051') && ep050.includes('no second adapter invocation site'), 'EP-050 names the optional P7 gate and stays one effect path');
  });

  it('inventories the customer governed-action route as its own effect path, classified and capability-gated', () => {
    const row = DOC.split('\n').find((line) => line.startsWith('| **EP-049** |'));
    assert.ok(row !== undefined, 'POST /api/governed-actions is an externally reachable effect path and needs its own EP id (§9 rule 4 of SECURITY_INVARIANTS.md)');
    assert.ok(row.includes('POST /api/governed-actions'), 'EP-049 must name the route');
    assert.ok(row.includes('PROVEN — PATH LOCAL'), 'EP-049 must carry the path-local classification, never a system-wide one');
    assert.ok(/capability-gated/i.test(row), 'EP-049 must state that it exists only when both capabilities are composed');
    assert.ok(DOC.includes('It does **not** mean any other effect path became governed'), 'the qualification that P5 governs no other path must stay recorded');
  });

  it('keeps the enforce() effect-binding limit stated without overstatement', () => {
    assert.ok(DOC.includes('PARTIALLY BOUND'), 'enforce() must remain classified, not described in prose alone');
    assert.ok(
      /Frontera proves that the executor performed only the declared action/.test(DOC),
      'the illegitimate formulation must stay recorded in §19 so it cannot be re-derived',
    );
  });

  it('keeps both separate provider authority models named', () => {
    assert.ok(/Sovereign Access/.test(DOC), 'the Sovereign Access exception must stay named');
    assert.ok(/Content Protection/.test(DOC), 'the second provider authority model must stay named (NB-003)');
  });

  it('keeps an explicit disposition for SC-002 and SC-003', () => {
    for (const id of ['SC-002', 'SC-003']) {
      assert.ok(DOC.includes(id), `${id} must carry an explicit disposition, not be left implied`);
    }
    assert.ok(/STILL OPEN/.test(DOC), 'neither SC item may be silently marked closed');
  });

  it('states the deployment assumptions every claim is conditional on', () => {
    for (const id of ['D-A1', 'D-A3', 'D-A4', 'D-A8']) {
      assert.ok(DOC.includes(id), `${id} must stay recorded — §18's claims are conditional on it`);
    }
  });
});
