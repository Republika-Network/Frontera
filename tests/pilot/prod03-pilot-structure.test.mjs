// PROD-03 — structural proof of the pilot qualification's own honesty.
//
// - FOUNDER-FREE: the clean-room drill and its harness reach the deployment
//   only through supported surfaces (documented CLIs, HTTP, the web console,
//   runbook blocks): no SQLite, no store or service import, no source or
//   configuration edit mid-run, no git change.
// - BOUNDARY: the PROD-03 operator tooling (scripts/pilot) cannot write
//   authority, grants, approvals or evidence, clear a stop, touch the witness
//   or call an adapter — it reads.
// - NO FOUNDER-ONLY PATH: no pilot document tells an operator to ask someone,
//   edit a database or source, or run an internal helper.
// - CONFIG SAFETY: the pilot templates carry no secret, by the scanner that
//   operators run, which itself detects every shape it claims to.
// - TIES: the checklist, the threat model, the runbook blocks, the Compose
//   tool and the npm scripts agree with the code.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CHECKS } from '../../scripts/pilot/lib-pilot-readiness.mjs';
import { scanForSecrets } from '../../scripts/pilot/scan-pilot-config.mjs';
import { DRILL_EXECUTED_BLOCKS, DRILL_RUNBOOK, drillBlocks } from './fixtures/drill-lib.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const read = (path) => readFileSync(join(ROOT, path), 'utf8').replace(/\r\n/g, '\n');
const code = (path) => read(path).replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/\s.*$/gm, '');
const PILOT_TESTS = readdirSync(join(ROOT, 'tests/pilot')).filter((name) => name.endsWith('.mjs')).map((name) => `tests/pilot/${name}`);
const FIXTURES = readdirSync(join(ROOT, 'tests/pilot/fixtures')).map((name) => `tests/pilot/fixtures/${name}`);
const TOOLING = readdirSync(join(ROOT, 'scripts/pilot')).map((name) => `scripts/pilot/${name}`);

describe('PROD-03 founder-free proof — the drill uses supported surfaces only', () => {
  const drillSources = [...PILOT_TESTS.filter((file) => /drill/.test(file)), ...FIXTURES];

  it('measures the real drill sources', () => {
    assert.ok(drillSources.includes('tests/pilot/prod03-clean-room-drill.test.mjs'));
    assert.ok(drillSources.includes('tests/pilot/fixtures/drill-lib.mjs'));
    assert.ok(code('tests/pilot/prod03-clean-room-drill.test.mjs').includes('runCli('), 'the scanned source is the proof');
  });

  it('opens no database, imports no store, service or composed Enterprise, and edits no source', () => {
    const forbidden = [
      /\bsqlite3\b/, /better-sqlite3/, /node:sqlite/, /new Database\(/,
      /kernelAuthorityProvisioning/, /\.provision(Actor|Passport|CapabilityToken|AuthorityGrant|DelegationGrant|TrustDomain|RootIssuer)\(/, /appendEvent/, /createEnterprise\(/, /host\.enterprise/,
      /-store\.js/, /\/(execution-outcome|bounded-grant|approval|evidence|emergency-control|kernel-authority|control-plane)-?store/, /authority-state-freshness\/(reference|session)/,
      /\bsed -i\b/, /\bgit (commit|checkout|reset|apply|stash|add)\b/, /writeFileSync\([^)]*\b(src|scripts|docs|deploy)\//,
    ];
    for (const file of drillSources) {
      const source = code(file);
      for (const pattern of forbidden) assert.equal(pattern.test(source), false, `${file}: ${pattern}`);
    }
  });

  it('reaches the Host only as the launcher does: only the Host runner imports Host code, from the staged release, and only its public entry points', () => {
    for (const file of drillSources) {
      const imports = [...code(file).matchAll(/(?:from|import\()\s*[`'"]([^`'"]+)[`'"]/g)].map((match) => match[1]);
      for (const specifier of imports.filter((entry) => entry.includes('dist/'))) {
        assert.ok(
          specifier === '../../dist/src/control-plane-web/__tests__/web-browser.js' || (file.endsWith('drill-host.mjs') && /\$\{stage\}\/(dist\/src\/enterprise\/index\.js|scripts\/deploy\/host-preflight\.mjs)$/.test(specifier)),
          `${file} imports ${specifier}`,
        );
      }
    }
    const runner = code('tests/pilot/fixtures/drill-host.mjs');
    assert.match(runner, /runHostPreflight\(process\.env/);
    assert.match(runner, /bootEnterpriseHost\(\{ executionAdapters: \[referenceTarget\] \}\)/, 'the launcher composition plus one embedder adapter, nothing else');
  });

  it('the drill harness writes configuration only before a Host starts, into its own scratch directories', () => {
    const lib = code('tests/pilot/fixtures/drill-lib.mjs');
    assert.match(lib, /mkdtempSync\(join\(tmpdir\(\)/);
    const drill = code('tests/pilot/prod03-clean-room-drill.test.mjs');
    // Writes to the governed-action file: Phase A (before the first boot) and the handoff (a supported configuration change, followed by a restart).
    const writes = [...drill.matchAll(/writeFileSync\(state\.governedActionsFile/g)].length;
    assert.equal(writes, 2);
    const handoff = drill.slice(drill.indexOf("it('Handoff"), drill.indexOf("it('Phase J"));
    assert.ok(handoff.indexOf('writeFileSync(state.governedActionsFile') < handoff.indexOf('await stopHost()') && handoff.indexOf('await stopHost()') < handoff.indexOf('await startHost()'));
  });
});

describe('PROD-03 tooling boundary — scripts/pilot reads; it cannot write authority or call an adapter', () => {
  it('imports nothing that writes: no store, driver, Host composition, signer, witness or adapter', () => {
    for (const file of TOOLING) {
      const source = code(file);
      const imports = [...source.matchAll(/from '([^']+)'/g)].map((match) => match[1]);
      for (const specifier of imports) assert.match(specifier, /^(node:(crypto|fs|os|path|test|url)|\.\/lib-pilot-readiness\.mjs|\.\.\/deploy\/host-preflight\.mjs)$/, `${file} imports ${specifier}`);
      for (const pattern of [/better-sqlite3/, /node:sqlite/, /node:https?['"]/, /createEnterprise|bootEnterpriseHost/, /execute\(/, /method:\s*'(POST|PUT|PATCH|DELETE)'/]) assert.equal(pattern.test(source), false, `${file}: ${pattern}`);
    }
  });

  it('touches no operator-plane mutation, emergency release, witness or resolution route', () => {
    for (const file of TOOLING) {
      const source = code(file);
      for (const route of ['/revoke', '/activate', '/release', '/approve', '/reject', '/resolution', '/credentials', '/rotate', '/api/governed-actions']) assert.equal(source.includes(route), false, `${file} names ${route}`);
    }
  });
});

describe('PROD-03 — no founder-only path in any pilot-critical document', () => {
  const documents = [...readdirSync(join(ROOT, 'docs/pilot')).map((name) => `docs/pilot/${name}`), 'docs/deployment/PILOT_DEPLOYMENT.md'];
  it('no document asks an operator to ask someone, edit a database or source, or run an internal helper', () => {
    const founderOnly = /\bask (?:victor|the founder|engineering to edit)|\bdeveloper manually\b|\bedit (?:the |a )?(?:database|store|sqlite)\b(?![^.]*\b(?:never|not|forbidden)\b)|\bmodify (?:the )?source\b|internal test helper|\bupdate (?:the )?(?:database|table)\b/i;
    for (const document of documents) {
      for (const [index, line] of read(document).split('\n').entries()) assert.equal(founderOnly.test(line), false, `${document}:${index + 1}: ${line.trim()}`);
    }
  });
});

describe('PROD-03 config repository safety — the templates carry no secret (the scanner operators run)', () => {
  it('every committed pilot template passes the scan', () => {
    for (const file of ['deploy/pilot/governed-actions.example.json', 'deploy/pilot/governed-actions.reference-pilot.json', 'deploy/pilot/.env.example']) {
      assert.deepEqual(scanForSecrets(read(file)), [], file);
    }
  });

  it('the scanner is not vacuous: it finds every shape it claims, and prints no value', () => {
    const planted = {
      'private-key': '-----BEGIN PRIVATE KEY-----',
      'agent-credential': `token fra1.agc-${'a'.repeat(32)}.${'B'.repeat(43)}`,
      'bearer-credential': 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123',
      'stripe-key': `"key": "sk_live_${'A1'.repeat(10)}"`,
      macaroon: '0201036c6e64'.repeat(12),
      'inline-secret-field': '"token": "a-real-looking-secret-value"',
      'wallet-seed': `seed s${'p'.repeat(28)}`,
      'assigned-secret-variable:FRONTERA_OPERATOR_KEY_ADMIN': 'FRONTERA_OPERATOR_KEY_ADMIN=realvalue123456789',
      'assigned-secret-variable:AOC_ENTERPRISE_AUTHORITY_SIGNING_KEY_PEM': 'AOC_ENTERPRISE_AUTHORITY_SIGNING_KEY_PEM="abc"',
    };
    for (const [kind, text] of Object.entries(planted)) assert.ok(scanForSecrets(text).some((finding) => finding.kind === kind), kind);
    assert.deepEqual(scanForSecrets("FRONTERA_PROVIDER_TOKEN='<required-secret>'\nFRONTERA_OPERATOR_KEY_ADMIN=\n"), []);
    const dir = mkdtempSync(join(tmpdir(), 'frontera-prod03-scan-'));
    try {
      writeFileSync(join(dir, 'leaky.json'), '{"tokenEnv": "FRONTERA_PROVIDER_TOKEN", "token": "a-real-looking-secret-value"}');
      // The CLI prints the file, the line and the kind — never the value.
      let out = '';
      try {
        execFileSync(process.execPath, [join(ROOT, 'scripts/pilot/scan-pilot-config.mjs'), join(dir, 'leaky.json')], { encoding: 'utf8' });
      } catch (error) {
        out = `${error.stdout}${error.stderr}`;
        assert.equal(error.status, 1);
      }
      assert.match(out, /inline-secret-field/);
      assert.equal(out.includes('a-real-looking-secret-value'), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('PROD-03 ties — the checklist, threat model, runbook, Compose tool and scripts agree with the code', () => {
  it('PILOT_READINESS.md §5.2 lists exactly PR-01 … PR-20, at the levels the gate uses', () => {
    const section = read('docs/pilot/PILOT_READINESS.md').split('### 5.2 Checklist')[1].split('### 5.3')[0];
    const rows = [...section.matchAll(/^\| (PR-\d{2}) ([a-z-]+) \| ([a-z]+) \|/gm)].map((match) => ({ id: match[1], name: match[2], level: match[3] }));
    assert.deepEqual(rows, CHECKS.map((check) => ({ id: check.id, name: check.name, level: check.level })));
  });

  it('every remediation reference the gate prints resolves to a heading', () => {
    for (const check of CHECKS) {
      for (const reference of check.remediation.split(';').map((entry) => entry.trim())) {
        const [path, section] = reference.split(' §');
        const text = read(path.split(' ')[0]);
        if (section === undefined) continue;
        const number = section.split(' ')[0];
        assert.ok(text.includes(`\n## ${number}. `) || text.includes(`\n### ${number} `), `${check.id}: ${reference}`);
      }
    }
  });

  it('the pilot threat model names PILOT-1 … PILOT-25, each with a closed disposition; every BLOCKED one is in THREAT_MODEL_V1 §7.37 with evidence', () => {
    const posture = read('docs/pilot/SECURITY_POSTURE.md');
    const rows = [...posture.matchAll(/^\| (PILOT-\d+) \| [^|]+ \| \*\*([A-Z]+)\*\* \|/gm)].map((match) => ({ id: match[1], disposition: match[2] }));
    assert.deepEqual(rows.map((row) => row.id), Array.from({ length: 25 }, (_, index) => `PILOT-${index + 1}`));
    for (const row of rows) assert.ok(['BLOCKED', 'MITIGATED', 'ACCEPTED', 'DEPLOYMENT'].includes(row.disposition), row.id);
    const section = read('docs/security/THREAT_MODEL_V1.md').split('### 7.37')[1]?.split('\n## ')[0] ?? '';
    for (const row of rows.filter((entry) => entry.disposition === 'BLOCKED')) assert.match(section, new RegExp(`^\\| ${row.id} [^|]*\\| \\*\\*BLOCKED\\*\\* \\|`, 'm'), `${row.id} is BLOCKED in the pilot model and must be in THREAT_MODEL_V1 §7.37`);
  });

  it('the onboarding runbook carries exactly the blocks the drill executes, each marked drill:', () => {
    const blocks = drillBlocks(read(DRILL_RUNBOOK));
    assert.deepEqual([...blocks.keys()].sort(), [...DRILL_EXECUTED_BLOCKS].sort());
    for (const source of blocks.values()) assert.equal(/\bsqlite3\b|\bUPDATE\s|\bDELETE\s+FROM\b|down\s+-v|retr(y|ies)|resen(d|t)|re-?run/i.test(source), false, source.slice(0, 120));
  });

  it('the Compose kit runs the gate as a tool: profile tools, the Host network namespace, read-only defaults, no published port', () => {
    const compose = read('deploy/pilot/compose.yaml');
    const block = compose.slice(compose.indexOf('  pilot-readiness:')).split(/\n(?=  [a-z])/)[0];
    assert.match(block, /profiles: \["tools"\]/);
    assert.match(block, /network_mode: service:network/);
    assert.match(block, /entrypoint: \["node", "scripts\/pilot\/pilot-readiness\.mjs", "--host", "http:\/\/127\.0\.0\.1:8787", "--preflight", "--credential-env", "FRONTERA_OPERATOR_KEY_OBSERVER", "--operator-env", "FRONTERA_OPERATOR_KEY_ADMIN"\]/);
    assert.equal(/ports:|depends_on/.test(block), false);
  });

  it('the multi-process drills run on their own — in qualify:pilot and the CI job pilot-operations — never silently nowhere', () => {
    for (const file of ['tests/pilot/prod03-clean-room-drill.test.mjs', 'tests/pilot/prod03-signer-outage-drill.test.mjs']) {
      const source = code(file);
      assert.match(source, /const PROCESS_DRILL_SKIP = process\.env\.FRONTERA_PILOT_DRILL === '1' \? false : '/, file);
      assert.match(source, /\{ concurrency: false, skip: PROCESS_DRILL_SKIP \}/, file);
    }
    assert.match(code('scripts/pilot/qualify-pilot.mjs'), /process\.env\.FRONTERA_PILOT_DRILL = '1';/);
    const ci = read('.github/workflows/ci.yml');
    const job = ci.slice(ci.indexOf('  pilot-operations:'));
    assert.ok(ci.includes('  pilot-operations:'), 'CI has the pilot-operations job');
    assert.match(job, /- run: npm ci\n\s+- run: npm run build\n\s+- run: npm run qualify:pilot/);
  });

  it('the npm scripts the documents name exist and point at the tooling', () => {
    const scripts = JSON.parse(read('package.json')).scripts;
    assert.equal(scripts['pilot:readiness'], 'node scripts/pilot/pilot-readiness.mjs');
    assert.equal(scripts['pilot:diagnose'], 'node scripts/pilot/pilot-readiness.mjs --diagnose');
    assert.equal(scripts['pilot:scan-config'], 'node scripts/pilot/scan-pilot-config.mjs');
    assert.equal(scripts['qualify:pilot'], 'node scripts/pilot/qualify-pilot.mjs');
  });

  it('the reference template is the canonical pilot use case: profiles, approval policy, operators by role, an https Generic HTTP target, secrets by name only', () => {
    const template = JSON.parse(read('deploy/pilot/governed-actions.reference-pilot.json'));
    assert.deepEqual(template.operators.map((operator) => operator.role).sort(), ['approver', 'observer', 'organization-administrator', 'profile-steward', 'provisioner', 'responder']);
    assert.equal(template.profileLifecycle, 'operator-promoted');
    assert.equal(template.approvalPolicy.rules[0].governanceProfile, 'deploy-production');
    assert.ok(template.governance.profiles.find((profile) => profile.profileId === 'deploy-production').approval !== undefined);
    assert.match(template.genericHttpAdapters[0].origin, /^https:\/\//);
    assert.deepEqual(template.routes, [{ action: 'deploy-release', adapterId: template.genericHttpAdapters[0].adapterId }]);
    assert.equal(template.genericHttpAdapters[0].credential.tokenEnv, 'FRONTERA_PROVIDER_TOKEN');
  });
});
