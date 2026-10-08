import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';

import { LEGACY_ADMINISTRATOR_ROLE, OPERATOR_ROLES, operatorMay, permissionsOf } from '../operator-control/roles.js';

/**
 * PROD-03-01 — structural boundaries of operational visibility.
 *
 * Measured over code with comments removed, so prose never satisfies or
 * violates a rule; every detector is first shown to match a real violation.
 */

function codeOf(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\r\n/g, '\n')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .map((line) => line.replace(/^\s*\/\/.*$/, '').replace(/\s\/\/\s.*$/, ''))
    .join('\n');
}

function sourcesUnder(dir: string): readonly string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === '__tests__' || name === 'fixtures') continue;
      out.push(...sourcesUnder(full));
    } else if (/\.tsx?$/.test(full) && !/\.test\.tsx?$/.test(full)) out.push(full.replace(/\\/g, '/'));
  }
  return out;
}

const importsOf = (file: string): readonly string[] => [...codeOf(file).matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)].map((match) => match[1] ?? '');

const OPERATIONS = sourcesUnder('src/enterprise/operations');
const OBSERVER_PORT = 'src/enterprise/governed-action/path-observer.ts';
const CONSOLE_PAGES = 'src/control-plane-web/views/pages-operations.tsx';
const NEW_PRODUCT_CODE = [...OPERATIONS, OBSERVER_PORT, CONSOLE_PAGES];
const SERVICE = 'src/enterprise/operations/service.ts';
const ROUTER = 'src/enterprise/adapters/node-http-adapter.ts';
const ROOT = 'src/enterprise/composition/composition-root.ts';
const ORCHESTRATOR = 'src/enterprise/governed-action/orchestrator.ts';

/** Rails, test networks, the demo, wallet and signer code, payment adapters, models. */
const FORBIDDEN = /xrpl|ripple|rlusd|testnet|devnet|faucet|andrew|lumx|wallet|seed\b|private[-_ ]?key|signer|signing|commercial-demo|aoc-enterprise-demo|payment|\bpay[-_/]|stripe|lightning|x402|openai|anthropic|\bllm\b/i;

/** The transitive local import closure of a set of entry files (TypeScript sources, `.js` specifiers resolved to `.ts`/`.tsx`). */
function closureOf(entries: readonly string[]): ReadonlySet<string> {
  const seen = new Set<string>();
  const queue = [...entries];
  while (queue.length > 0) {
    const file = queue.shift() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const specifier of importsOf(file)) {
      if (!specifier.startsWith('.')) continue;
      const base = normalize(join(dirname(file), specifier)).replace(/\\/g, '/').replace(/\.js$/, '');
      const resolved = [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`].find((candidate) => existsSync(candidate));
      if (resolved !== undefined) queue.push(resolved);
    }
  }
  return seen;
}

describe('PROD-03-01 structure — the measured scope is real', () => {
  it('the operations module, the observer port and the console pages exist', () => {
    assert.ok(OPERATIONS.length >= 4, `operations sources: ${OPERATIONS.length}`);
    for (const file of [SERVICE, 'src/enterprise/operations/classification.ts', 'src/enterprise/operations/contracts.ts', 'src/enterprise/operations/governed-path-log.ts', OBSERVER_PORT, CONSOLE_PAGES]) assert.ok(existsSync(file), file);
  });

  it('the forbidden-vocabulary detector matches real uses', () => {
    for (const bad of ["import { Client } from 'xrpl'", 'composeAndrewDemo()', 'createWalletSigner', 'testnet-transport', '../pay-adapters/rlusd.js', 'lumx.client']) assert.equal(FORBIDDEN.test(bad), true, bad);
    assert.equal(FORBIDDEN.test("import { buildAuthorityTrace } from '../evidence/trace-builder.js'"), false);
  });
});

describe('PROD-03-01 structure — rail-neutral', () => {
  it('no new operational-visibility module names a rail, test network, the demo, a wallet, a signer, a payment adapter or a model', () => {
    for (const file of NEW_PRODUCT_CODE) {
      assert.equal(FORBIDDEN.test(codeOf(file)), false, file);
      for (const specifier of importsOf(file)) assert.equal(FORBIDDEN.test(specifier), false, `${file} imports '${specifier}'`);
    }
  });

  it('the whole import closure of operational visibility reaches no rail, demo, wallet, signer or payment module', () => {
    const closure = closureOf([...OPERATIONS, OBSERVER_PORT]);
    assert.ok(closure.size >= 10, `closure: ${closure.size}`);
    for (const file of closure) assert.equal(FORBIDDEN.test(file), false, `the closure reaches ${file}`);
    const consoleClosure = closureOf([CONSOLE_PAGES, 'src/control-plane-web/app.tsx']);
    for (const file of consoleClosure) {
      assert.equal(FORBIDDEN.test(file), false, `the console closure reaches ${file}`);
      assert.equal(file.startsWith('src/enterprise/'), false, `the console reaches the Host's internals (${file}) instead of its API`);
    }
  });

  it('operations imports only generic governed-action, evidence, governance-store, health, telemetry and operator-plane abstractions', () => {
    const allowed = /^\.\.\/(api\/enterprise-http-errors|evidence\/(errors|trace-builder|trace-contracts|trace-disclosure|contracts)|governance-store\/(contracts|errors)|health\/health-check|telemetry\/enterprise-logger|governed-action\/path-observer|operator-control\/(contracts|operator-authenticator))\.js$|^\.\/[a-z-]+\.js$/;
    // PROD-03-02: the resolution command (and the view's naming of an attestation) also reach P12's contracts, the
    // attestation authority's id and the closed execution failure vocabulary — no store, no service, no adapter.
    const prod0302 = /^\.\.\/execution-reconciliation\/(contracts|operator-attestation)\.js$|^\.\.\/\.\.\/features\/execution-runtime\/index\.js$/;
    const prod0302Files = new Set(['src/enterprise/operations/resolution.ts', 'src/enterprise/operations/classification.ts']);
    for (const file of OPERATIONS) {
      for (const specifier of importsOf(file)) {
        if (prod0302Files.has(file) && prod0302.test(specifier)) continue;
        assert.match(specifier, allowed, `${file} imports '${specifier}'`);
      }
    }
    assert.deepEqual(importsOf(OBSERVER_PORT), [], 'the observer port imports nothing');
  });
});

describe('PROD-03-01 structure — read only', () => {
  it('the service is handed reads only: query and count, the trace builder, health and a clock', () => {
    const service = codeOf(SERVICE);
    assert.match(
      service,
      /readonly governanceRecords: \{\s*query\([^)]*\): Promise<GovernanceStoreQueryResult>;\s*count\([^)]*\): Promise<number>;\s*\};\s*readonly traces: \{ build\([^)]*\): Promise<AuthorityTraceBuild \| null> \};\s*readonly health: \(\) => Promise<EnterpriseHealthReport>;\s*readonly now: \(\) => string;/,
    );
    assert.equal(/append|\.claim\(|recordOutcome|recordTerminal|recordResolution|reconcile|resolve\(|retry|resend|approve|reject|revoke|issue|exercise|execute\(|prepareAttempt|markVerified|store\(/i.test(service.replace(/resolvedOnRead|ResolvedOnRead/g, '')), false, 'no write verb');
    const root = codeOf(ROOT);
    assert.match(
      root,
      /governanceRecords: \{\s*query: \(context, query\) => persistence\.query\(context, query\),\s*count: \(context, query\) => countRecords\(context, query\),\s*\},\s*traces: \{ build: \(context, requestId\) => buildAuthorityTrace\(traceSources, context, requestId\) \},\s*health: \(\) => enterprise\.health\(\),/,
      'composed from the Governance Store read half, the one ASSURE-01 trace builder over the read-only trace sources, and the Host health',
    );
  });

  it('every read authorizes first, with an explicit read permission, under an organization-scoped non-system context', () => {
    const service = codeOf(SERVICE);
    for (const [method, permission] of [
      ['listExecutions', 'operations.read'],
      ['listAttention', 'operations.read'],
      ['readTrace', 'trace.read'],
      ['metrics', 'operations.read'],
      ['health', 'operations.read'],
    ] as const) {
      assert.ok(new RegExp(`async ${method}\\([^)]*\\)[^{]*\\{\\s*authenticator\\.authorize\\(authorizationHeader, '${permission.replace('.', '\\.')}'\\);`).test(service), `${method} authorizes '${permission}' first`);
    }
    assert.match(service, /const context: GovernanceStoreAccessContext = Object\.freeze\(\{ system: false, organizationId \}\);/);
    assert.equal(/system: true/.test(service), false);
  });

  it('the trace is the ASSURE-01 trace: no second builder, and FULL is never offered to an operator', () => {
    for (const file of OPERATIONS) assert.equal(/function buildAuthorityTrace|finalStateOf|readStreamBounded|getByRequestId/.test(codeOf(file)), false, file);
    const contracts = codeOf('src/enterprise/operations/contracts.ts');
    assert.match(contracts, /export const OPERATOR_TRACE_LEVELS = \['AUDITOR', 'PARTNER', 'CUSTOMER', 'PUBLIC'\] as const;/);
  });

  it('the HTTP surface is GET only, through `enterprise.operatorOperations`, and names no write — but PROD-03-02’s one resolution POST', () => {
    const router = codeOf(ROUTER);
    const matcher = /function matchOperationsRoute[\s\S]*?\n\}/.exec(router)?.[0] ?? '';
    assert.ok(matcher.length > 0);
    // PROD-03-02: exactly one POST, to `…/executions/{id}/resolution`, matched before the GET-only rule; everything else is unchanged.
    const post = /if \(method === 'POST'\) \{[\s\S]*?\n  \}\n/.exec(matcher)?.[0] ?? '';
    assert.match(post, /\/\^\\\/api\\\/admin\\\/operations\\\/executions\\\/\(\[\^\/\]\+\)\\\/resolution\$\/\.exec\(pathname\)/);
    assert.match(post, /\{ kind: 'resolution', executionId: decodeURIComponent\(resolution\[1\]\) \} : undefined;/);
    const reads = matcher.replace(post, '');
    assert.match(reads, /if \(method !== 'GET'\) return undefined;/);
    assert.equal(/resolve|retry|resend|reconcile|claim|mark|complete|POST|PUT|PATCH|DELETE/i.test(reads.replace(/return undefined/g, '')), false);
    assert.equal(/retry|resend|replay|reconcile|execute|claim|PUT|PATCH|DELETE/i.test(post), false, 'the one write names no execution');
    assert.deepEqual([...new Set([...router.matchAll(/operatorOperations\.(\w+)\(/g)].map((match) => match[1]))].sort(), ['health', 'listAttention', 'listExecutions', 'metrics', 'readTrace', 'resolveExecution']);
    const surface = JSON.parse(readFileSync('release/api-surface.v1.json', 'utf8')) as { routePatterns: string[] };
    assert.deepEqual(
      surface.routePatterns.filter((pattern) => pattern.includes('operations')),
      [
        '^\\/api\\/admin\\/operations\\/executions$',
        '^\\/api\\/admin\\/operations\\/attention$',
        '^\\/api\\/admin\\/operations\\/traces\\/([^/]+)$',
        '^\\/api\\/admin\\/operations\\/metrics$',
        '^\\/api\\/admin\\/operations\\/health$',
        '^\\/api\\/admin\\/operations\\/executions\\/([^/]+)\\/resolution$',
      ],
    );
  });

  it('the console pages post nothing — but PROD-03-02’s one resolution form — and offer no resolve, retry, reconcile or resend control; the client reads them with GET', () => {
    const pages = codeOf(CONSOLE_PAGES);
    // PROD-03-02: one form, in ResolutionPage, posting to the resolution path; every other operations page posts nothing.
    // Review hardening: one more form, ReconcileAgainForm, re-submits the identical recorded resolution — hidden fields
    // only, to the same path (P12's replay re-runs the capacity step and nothing else). It is rendered only for a
    // `pending` capacity result, or from the trace while capacity is unreconciled, to the attesting operator.
    const resolutionPage = /export function ResolutionPage[\s\S]*$/.exec(pages)?.[0] ?? '';
    assert.equal([...resolutionPage.matchAll(/method="post"/g)].length, 2);
    assert.match(resolutionPage, /<form method="post" action=\{resolutionPath\(view\.requestId\)\}/);
    const again = /function ReconcileAgainForm[\s\S]*?<form method="post" action=\{resolutionPath\(requestId\)\}[\s\S]*?<\/form>/.exec(resolutionPage)?.[0] ?? '';
    assert.ok(again.length > 0, 'the second form is the identical-resolution form');
    assert.deepEqual(
      [...pages.matchAll(/<ReconcileAgainForm /g)].length,
      2,
      'rendered from exactly two places',
    );
    assert.match(pages, /\{recorded\.capacity === 'pending' \? <ReconcileAgainForm /);
    assert.match(pages, /const submitted = identicalResolutionOf\(view, context\);\s*if \(submitted !== undefined\) return <ReconcileAgainForm /);
    assert.match(pages, /\{capacityReconciliationMissing\(trace\.stages\) \? \([\s\S]*?<CapacityReconcileAgain /);
    assert.deepEqual([...again.matchAll(/<input ([^>]*)\/>/g)].map((match) => /type="hidden"/.test(match[1] ?? '')), [true, true, true, true], 'it carries only hidden, identical fields (resolution, failure when stated, observedOutcome, confirm)');
    assert.equal(/<select|<textarea|type="(?:radio|text|checkbox)"/.test(again), false, 'nothing in it can be chosen');
    const reads = pages.replace(resolutionPage, '');
    assert.equal(/method="post"|method=\{|<button[^>]*name=|\b(Resolve|Retry|Reconcile|Resend)\b/.test(reads), false);
    assert.equal(/<button[^>]*name=|\b(Resolve|Retry|Reconcile|Resend|Replay|Re-execute)\b/.test(resolutionPage), false);
    const client = codeOf('src/control-plane-web/host-client.ts');
    const operations = [...client.matchAll(/send\('(GET|POST)', [`'](\/api\/admin\/operations\/[^`'$]*)/g)].map((match) => `${match[1]} ${match[2]}`);
    assert.deepEqual(
      operations.sort(),
      ['GET /api/admin/operations/attention', 'GET /api/admin/operations/executions', 'GET /api/admin/operations/health', 'GET /api/admin/operations/metrics', 'GET /api/admin/operations/traces/', 'POST /api/admin/operations/executions/'].sort(),
    );
  });
});

describe('PROD-03-01 structure — authorization is explicit', () => {
  it('operations.read and trace.read are held by observer, responder and organization-administrator only', () => {
    const matrix = Object.fromEntries([...OPERATOR_ROLES, LEGACY_ADMINISTRATOR_ROLE].map((role) => [role, permissionsOf(role).filter((permission) => permission === 'operations.read' || permission === 'trace.read')]));
    assert.deepEqual(matrix, {
      observer: ['operations.read', 'trace.read'],
      responder: ['operations.read', 'trace.read'],
      provisioner: [],
      'profile-steward': [],
      approver: [],
      'organization-administrator': ['operations.read', 'trace.read'],
      'legacy-administrator': [],
    });
  });

  it('the new read permissions confer nothing else: observer still holds no mutation, and no role gained a write', () => {
    assert.deepEqual(permissionsOf('observer'), ['organization.read', 'authority.inspect', 'inventory.read', 'approval.read', 'operations.read', 'trace.read']);
    for (const role of OPERATOR_ROLES) for (const permission of ['operations.read', 'trace.read'] as const) if (operatorMay(role, permission)) assert.ok(role === 'observer' || role === 'responder' || role === 'organization-administrator', role);
  });
});

describe('PROD-03-01 structure — governed-path logging is guarded and write-only', () => {
  it('the orchestrator reaches the observer only through one guard, and never reads it', () => {
    const orchestrator = codeOf(ORCHESTRATOR);
    assert.match(orchestrator, /function observe\(fact: \(observer: GovernedPathObserver\) => void\): void \{\s*if \(pathObserver === undefined\) return;\s*try \{\s*fact\(pathObserver\);\s*\} catch \{\s*\}\s*\}/);
    const uses = [...orchestrator.matchAll(/pathObserver\b/g)].length;
    assert.equal(uses, 5, 'the option, read once from the options, guarded, invoked — nothing else');
    assert.equal(/=\s*(await\s+)?observe\(|if \(observe\(|observer\.\w+\([^)]*\)\s*[!=]==/.test(orchestrator), false, 'no result depends on an observation');
    const port = codeOf(OBSERVER_PORT);
    for (const signature of port.matchAll(/^\s+(\w+)\(ref: [^;]+\): (\w+);$/gm)) assert.equal(signature[2], 'void', `${signature[1]} returns nothing`);
  });

  it('the log module writes closed fields only, through the existing EnterpriseLogger', () => {
    const log = codeOf('src/enterprise/operations/governed-path-log.ts');
    assert.equal(/\.\.\.ref\b|\.\.\.input\b|JSON\.stringify|console\.|process\.env|headers|authorization|amount|providerRef|adapterId/.test(log), false);
    assert.match(log, /import type \{ EnterpriseLogger \} from '\.\.\/telemetry\/enterprise-logger\.js';/);
  });
});
