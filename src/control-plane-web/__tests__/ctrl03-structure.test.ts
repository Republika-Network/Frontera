import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * CTRL-03 — structural boundaries of the shipped web control plane.
 *
 * Measured over every production source of `src/control-plane-web` (tests
 * excluded), with comments removed so prose never satisfies or violates a
 * rule. Every detector is first shown to match a real violation and not a
 * mention of one.
 */

function codeOf(file: string): string {
  return readFileSync(file, 'utf8')
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
      if (name === '__tests__') continue;
      out.push(...sourcesUnder(full));
    } else if (/\.(ts|tsx)$/.test(full) && !/\.test\.tsx?$/.test(full)) out.push(full.replace(/\\/g, '/'));
  }
  return out;
}

const WEB = sourcesUnder('src/control-plane-web');
const importsOf = (file: string): readonly string[] => [...codeOf(file).matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)].map((match) => match[1] ?? '');

/** The only modules outside the console it may import: React, the Node server primitives, and two legacy presentation components that fit. */
const ALLOWED_EXTERNAL = new Set(['react', 'react-dom/server', 'node:http', 'node:net', 'node:crypto', '../../features/aoc-control-plane/components/AocEmptyState.js', '../../features/aoc-control-plane/components/AocErrorState.js']);
const FORBIDDEN_SPECIFIER = /better-sqlite3|sqlite|node:fs|^fs$|child_process|kernel-authority|composition-root|composition\/|governance-store|bounded-grant|authority-authenticity|signer|signing|private-key|enterprise\/|\/kernel\/|\.\.\/kernel|runtime\/|control-plane-command-service|read-model-service|fixtures?\/|operator-control/;

describe('CTRL-03 structure — the measured scope is real', () => {
  it('the web control plane has its modules', () => {
    assert.ok(WEB.length >= 18, `web sources: ${WEB.length}`);
    for (const required of ['src/control-plane-web/host-client.ts', 'src/control-plane-web/app.tsx', 'src/control-plane-web/server.ts', 'src/control-plane-web/session.ts', 'src/control-plane-web/security.ts']) assert.ok(WEB.includes(required), required);
  });
});

describe('CTRL-03 structure — the browser application reaches the Host over HTTP only', () => {
  it('the import detector matches a real forbidden import and not an allowed one', () => {
    for (const bad of ['better-sqlite3', '../enterprise/kernel-authority/contracts.js', '../../enterprise/composition/composition-root.js', 'node:fs', '../features/aoc-control-plane/services/control-plane-command-service.js', '../../kernel/index.js']) {
      assert.equal(FORBIDDEN_SPECIFIER.test(bad), true, bad);
    }
    assert.equal(FORBIDDEN_SPECIFIER.test('./host-client.js'), false);
    assert.equal(FORBIDDEN_SPECIFIER.test('react-dom/server'), false);
  });

  it('every import is the console’s own, React, a Node server primitive, or one of the two reused presentation components', () => {
    for (const file of WEB) {
      for (const specifier of importsOf(file)) {
        const local = specifier.startsWith('./') || (specifier.startsWith('../') && !specifier.startsWith('../../'));
        assert.ok(local || ALLOWED_EXTERNAL.has(specifier), `${file} imports '${specifier}'`);
        assert.equal(FORBIDDEN_SPECIFIER.test(specifier), false, `${file} must not import '${specifier}'`);
      }
    }
  });

  it('the reused legacy components are pure: props in, markup out — no runtime, fixture, store or command', () => {
    for (const component of ['src/features/aoc-control-plane/components/AocEmptyState.tsx', 'src/features/aoc-control-plane/components/AocErrorState.tsx']) {
      const specifiers = importsOf(component);
      assert.deepEqual(specifiers, ['react'], component);
      assert.equal(/on[A-Z]\w*=|Soberan|fetch|runtime/i.test(codeOf(component)), false, component);
    }
  });

  it('exactly one module performs network I/O — the Host client — and it holds no state, follows no redirect and logs nothing', () => {
    const fetching = WEB.filter((file) => /\bfetch\s*\(/.test(codeOf(file)));
    assert.deepEqual(fetching, ['src/control-plane-web/host-client.ts']);
    const client = codeOf('src/control-plane-web/host-client.ts');
    assert.match(client, /redirect: 'manual'/);
    assert.equal(/logger|console\.|\blet\s+\w+\s*=\s*new Map/.test(client), false);
    for (const file of WEB) assert.equal(/node:https?['"]\s*;?[\s\S]*\brequest\s*\(/.test(codeOf(file)) || /\bhttps?\.(request|get)\s*\(/.test(codeOf(file)), false, file);
  });

  it('the operator bearer travels only in the Authorization header of the Host client, and is never logged, rendered or put in a URL or cookie', () => {
    for (const file of WEB) {
      const code = codeOf(file);
      if (file.endsWith('host-client.ts')) {
        assert.equal([...code.matchAll(/\bauthorization\s*:/g)].length, 1, 'one Authorization header, built in one place');
        continue;
      }
      // A header key in code is lowercase `authorization:`; help text that mentions the header is not a header.
      assert.equal(/\bauthorization\s*:/.test(code), false, `${file} sets no Authorization header`);
    }
    const app = codeOf('src/control-plane-web/app.tsx');
    for (const pattern of [/logger[\s\S]{0,80}bearer/, /setCookie\([^)]*bearer/, /href=\{[^}]*bearer/, /location[^\n]*bearer/]) assert.equal(pattern.test(app), false, String(pattern));
    const server = codeOf('src/control-plane-web/server.ts');
    const logged = [...server.matchAll(/logger\?\.info\('console\.request', \{([^}]*)\}\)/g)].map((match) => match[1] ?? '');
    assert.ok(logged.length > 0);
    for (const fields of logged) assert.deepEqual([...fields.matchAll(/(\w+):/g)].map((match) => match[1]), ['method', 'route', 'status'], 'request logs carry method, route shape and status only');
  });
});

describe('CTRL-03 structure — no browser persistence, no client script, no DOM injection', () => {
  const BROWSER_STORAGE = /localStorage|sessionStorage|indexedDB|document\.cookie|navigator\.clipboard|serviceWorker|caches\.open/;
  const SCRIPTING = /dangerouslySetInnerHTML|<script|\beval\s*\(|new\s+Function\s*\(|javascript:/i;

  it('the detectors match real uses', () => {
    assert.equal(BROWSER_STORAGE.test('window.localStorage.setItem("k", v)'), true);
    assert.equal(BROWSER_STORAGE.test('await indexedDB.open("x")'), true);
    assert.equal(SCRIPTING.test('<div dangerouslySetInnerHTML={{ __html: x }} />'), true);
    assert.equal(SCRIPTING.test('<script src="/a.js"></script>'), true);
  });

  it('no module stores anything in the browser or ships a script', () => {
    for (const file of WEB) {
      const code = codeOf(file);
      assert.equal(BROWSER_STORAGE.test(code), false, file);
      assert.equal(SCRIPTING.test(code), false, file);
    }
    assert.doesNotMatch(codeOf('src/control-plane-web/security.ts'), /script-src/, 'the CSP grants no script source');
  });
});

describe('CTRL-03 structure — the console decides nothing', () => {
  it('no role table: no module compares a role name; permission questions are the Host-reported list, asked in one helper', () => {
    for (const file of WEB) {
      const code = codeOf(file);
      assert.equal(/\brole\s*[!=]==?\s*['"]|['"]\s*[!=]==?\s*\w*\.?role\b/.test(code), false, `${file} compares a role`);
      assert.equal(/'(observer|responder|provisioner|profile-steward|organization-administrator|legacy-administrator)'/.test(code), false, `${file} names a role`);
    }
    const layout = codeOf('src/control-plane-web/views/layout.tsx');
    assert.match(layout, /export function may\(context: OrganizationContext, permission: string\): boolean \{\s*return context\.operator\.permissions\.includes\(permission\);/);
  });

  it('every operation is forwarded: the request handler never refuses an operation on a permission it believes the role lacks', () => {
    assert.equal(/may\(/.test(codeOf('src/control-plane-web/app.tsx')), false);
  });

  it('no module mints, edits or un-revokes authority: no bounded-grant issuance, no un-revoke, no reactivation route', () => {
    for (const file of WEB) {
      const code = codeOf(file);
      assert.equal(/issueGrant|issueFromDecision|boundedGrant\s*:|unrevoke|un-revoke['"/]|reactivate|reinstate|restoreAuthority/i.test(code.replace(/There is no un-revoke|no un-revoke|\(and no un-revoke\)/g, '')), false, file);
    }
    const client = codeOf('src/control-plane-web/host-client.ts');
    const posts = [...client.matchAll(/send\('POST', `([^`]+)`/g)].map((match) => (match[1] ?? '').replace(/\$\{[^}]+\}/g, '{}'));
    const literalPosts = [...client.matchAll(/send\('POST', '([^']+)'/g)].map((match) => match[1] ?? '');
    assert.deepEqual(
      [...posts, ...literalPosts].sort(),
      [
        '/api/admin/agents/{}/credentials',
        '/api/admin/agents/{}/credentials/{}/revoke',
        '/api/admin/agents/{}/credentials/{}/rotate',
        '/api/admin/authority/entities/{}',
        '/api/admin/authority/entities/{}/{}/revoke',
        '/api/admin/authority/grants/{}/revoke',
        '/api/admin/emergency-controls/activate',
        '/api/admin/emergency-controls/release',
        '/api/admin/governance-profiles/{}/versions/{}/{}',
      ].sort(),
      'the console writes only through the CTRL-01 / CTRL-02 operator routes',
    );
    assert.equal(/'(PUT|PATCH|DELETE)'/.test(client), false);
    for (const path of [...posts, ...literalPosts]) assert.ok(path.startsWith('/api/admin/'), path);
  });
});

describe('CTRL-03 structure — CTRL-04, PAY, domain and model boundaries', () => {
  const APPROVAL_WORKFLOW = /\bapprove\b|\bapproveApproval|\breject(ion)?\b|\bescalat|\bquorum\b|requestChanges|ApprovalPanel|ApprovalActionBar|ApprovalRequestsTable|\/approvals/i;
  const RAIL = /xrpl|lightning|bolt11|x402|stripe|\bqnt\b|overledger|wallet|rlusd|ethereum|solana|hedera|\bmpp\b/i;
  const DOMAIN = /replica|kubernetes|treasury|customer-data|payables|invoice/i;
  const MODEL = /openai|anthropic|langchain|\bllm\b|inference|embedding|gpt-/i;

  it('the detectors match real uses and not mentions in prose', () => {
    assert.equal(APPROVAL_WORKFLOW.test('onApprove={() => approve(id)}'), true);
    assert.equal(APPROVAL_WORKFLOW.test("<a href='/approvals'>"), true);
    assert.equal(RAIL.test('import { Client } from "xrpl"'), true);
    assert.equal(DOMAIN.test('const replicas = 3'), true);
    assert.equal(MODEL.test('new OpenAI()'), true);
  });

  it('no approval inbox, approve, reject, request-changes, escalate or quorum wiring ships (CTRL-04)', () => {
    for (const file of WEB) assert.equal(APPROVAL_WORKFLOW.test(codeOf(file)), false, file);
  });

  it('no payment rail, protocol, wallet, domain or model vocabulary in the generic control plane', () => {
    for (const file of WEB) {
      const code = codeOf(file);
      assert.equal(RAIL.test(code), false, `${file} (rail)`);
      assert.equal(DOMAIN.test(code), false, `${file} (domain)`);
      assert.equal(MODEL.test(code), false, `${file} (model)`);
    }
  });

  it('the product chrome is Frontera, not the historical Soberanía / AOC identity', () => {
    for (const file of WEB) assert.equal(/Soberan|AOC Control|Datasys/i.test(codeOf(file).replace(/AocEmptyState|AocErrorState|aoc-control-plane|aoc-empty-state|aoc-error-state/g, '')), false, file);
    assert.match(codeOf('src/control-plane-web/views/layout.tsx'), /Frontera <span className="brand__product">Control Plane<\/span>/);
  });
});

describe('CTRL-03 structure — the two new Host reads are reads', () => {
  it('the operator service reaches the Governance Store only through query, getByEvaluationId and verify', () => {
    const service = codeOf('src/enterprise/operator-control/service.ts');
    assert.match(service, /readonly governanceRecords\?: \{\s*query\([^)]*\): Promise<GovernanceStoreQueryResult>;\s*getByEvaluationId\([^)]*\): Promise<GovernanceRecord \| null>;\s*verify\([^)]*\): Promise<GovernanceRecordVerificationResult>;\s*\};/);
    assert.equal(/appendReference|appendEvaluation|\.append\(|governanceRecords\(\)\.(?!query|getByEvaluationId|verify)/.test(service), false);
    const root = codeOf('src/enterprise/composition/composition-root.ts');
    assert.match(root, /governanceRecords: \{\s*query: \(context, query\) => persistence\.query\(context, query\),\s*getByEvaluationId: \(context, evaluationId\) => persistence\.getByEvaluationId\(context, evaluationId\),\s*verify: \(context, evaluationId\) => persistence\.verify\(context, evaluationId\),\s*\}/);
  });

  it('both reads authorize inventory.read before anything else, with an organization-scoped, non-system store context', () => {
    const service = codeOf('src/enterprise/operator-control/service.ts');
    for (const method of ['listDecisionActivity', 'inspectDecisionEvidence']) {
      const body = new RegExp(`async ${method}\\([^)]*\\)[^{]*\\{\\s*authenticator\\.authorize\\(authorizationHeader, 'inventory\\.read'\\);`).exec(service);
      assert.ok(body !== null, `${method} authorizes first`);
    }
    assert.match(service, /const governanceContext: GovernanceStoreAccessContext = Object\.freeze\(\{ system: false, organizationId \}\);/);
  });
});
