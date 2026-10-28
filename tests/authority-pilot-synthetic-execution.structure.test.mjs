// AUTH-04D2S — the synthetic Authority pilot's verified synthetic execution kit
// (deploy/authority-pilot/compose.executor.yaml, synthetic-execution.additions.json,
// nginx/synthetic-executor*.conf, scripts/deploy/synthetic-execution-pilot.mjs).
// The tools run here for real, against the built dist/, in temporary
// directories: executor-init, host-init and render, and what they produce is
// read back by the Host's own configuration parser and the reference
// executor's own configuration parser. What Compose resolves and what nginx
// does are qualified by the CI job authority-pilot-config; the governed path
// end to end by src/enterprise/__tests__/auth04d2s-verified-synthetic-execution.test.ts.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (path) => readFileSync(join(ROOT, path), 'utf8').replace(/\r\n/g, '\n');
const KIT = 'deploy/authority-pilot';
const SCRIPT = join(ROOT, 'scripts/deploy/synthetic-execution-pilot.mjs');
const BASE = JSON.parse(read(`${KIT}/governed-actions.synthetic-pilot.json`));
const ADDITIONS = JSON.parse(read(`${KIT}/synthetic-execution.additions.json`));
const ORG = 'org-frontera-synthetic-pilot';
const TOKEN = 'synthetic-test-executor-credential-0000000000000000';

function tool(args, env = {}) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { env: { PATH: process.env.PATH ?? '', ...env }, encoding: 'utf8' });
}

/** A copy of the kit whose state paths live in a private temporary directory: the same tools, the same documents, other places. */
function kitIn(dir) {
  const kit = join(dir, 'kit');
  cpSync(join(ROOT, KIT), kit, { recursive: true });
  const additions = structuredClone(ADDITIONS);
  const executorState = join(dir, 'executor', 'synthetic-executor');
  additions.executor.syntheticExecution.consumptionLedgerPath = join(executorState, 'ledger', 'consumption.sqlite');
  additions.executor.syntheticExecution.outputDirectory = join(executorState, 'output');
  additions.executor.executorReceipts.privateKeyFile = join(executorState, 'keys', 'receipt-key.pem');
  additions.executor.executorReceipts.receiptLedgerPath = join(executorState, 'receipts', 'receipts.sqlite');
  additions.executionCapabilities.issuanceLedgerPath = join(dir, 'host', 'execution-capability-issuance.sqlite');
  additions.executionCapabilities.receiptEvidence.storePath = join(dir, 'host', 'execution-evidence', 'receipt-evidence.sqlite');
  writeFileSync(join(kit, 'synthetic-execution.additions.json'), JSON.stringify(additions, null, 2));
  mkdirSync(join(dir, 'executor'), { mode: 0o700 });
  mkdirSync(join(dir, 'host'), { mode: 0o700 });
  mkdirSync(join(dir, 'out'), { mode: 0o700 });
  return { kit, additions };
}

function authorityKeys() {
  const { publicKey } = generateKeyPairSync('ed25519');
  return [{ keyId: 'frontera-authority-test-1', algorithm: 'ed25519-v1', publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString() }];
}

describe('AUTH-04D2S — the synthetic execution kit', () => {
  it('executor-init, host-init and render produce what the Host and the executor accept — public configuration only, each tool once', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'frontera-auth04d2s-kit-')));
    try {
      const { kit, additions } = kitIn(dir);
      const publicKeyOut = join(dir, 'out', 'synthetic-executor-receipt-key.pub.pem');

      // executor-init: its own state, a public key out, a credential printed; never twice.
      const init = tool(['executor-init', '--kit', kit, '--public-key-out', publicKeyOut]);
      assert.equal(init.status, 0, init.stderr);
      assert.match(init.stdout, /^FRONTERA_SYNTHETIC_EXECUTOR_TOKEN=[A-Za-z0-9_-]{64}$/m);
      assert.equal(/PRIVATE KEY/.test(init.stdout), false, 'no private key is printed');
      assert.match(readFileSync(publicKeyOut, 'utf8'), /^-----BEGIN PUBLIC KEY-----/);
      const keyFile = additions.executor.executorReceipts.privateKeyFile;
      assert.equal(statSync(keyFile).mode & 0o777, 0o600, 'the receipt private key is readable by the executor alone');
      assert.equal(statSync(additions.executor.syntheticExecution.outputDirectory).mode & 0o777, 0o700);
      const again = tool(['executor-init', '--kit', kit, '--public-key-out', join(dir, 'out', 'second.pem')]);
      assert.notEqual(again.status, 0, 'a second executor-init is refused');
      assert.match(again.stderr, /already initialized/);

      // host-init: the issuance ledger and the evidence store, once.
      const host = tool(['host-init', '--kit', kit], { AOC_ENTERPRISE_KERNEL_AUTHORITY_ORGANIZATION_ID: ORG });
      assert.equal(host.status, 0, host.stderr);
      // AUTH-04D2V: host-init prints the execution verifier's read-only auditor credential, once.
      assert.match(host.stdout, /^FRONTERA_AUDITOR_KEY_EXECUTION_VERIFIER=[A-Za-z0-9_-]{64}$/m);
      assert.notEqual(tool(['host-init', '--kit', kit], { AOC_ENTERPRISE_KERNEL_AUTHORITY_ORGANIZATION_ID: ORG }).status, 0, 'a second host-init is refused');

      // render: public keys in, public configuration out; never over an existing file.
      const keys = authorityKeys();
      const env = { AOC_ENTERPRISE_KERNEL_AUTHORITY_ORGANIZATION_ID: ORG, AOC_ENTERPRISE_AUTHORITY_VERIFICATION_KEYS: JSON.stringify(keys) };
      const rendered = tool(['render', '--kit', kit, '--out', join(dir, 'out'), '--executor-public-key', publicKeyOut], env);
      assert.equal(rendered.status, 0, rendered.stderr);
      assert.notEqual(tool(['render', '--kit', kit, '--out', join(dir, 'out'), '--executor-public-key', publicKeyOut], env).status, 0, 'render never overwrites');
      const leaky = tool(['render', '--kit', kit, '--out', join(dir, 'host'), '--executor-public-key', keyFile], env);
      assert.notEqual(leaky.status, 0, 'a private key is never accepted as the executor public key');
      const policyText = readFileSync(join(dir, 'out', 'governed-actions.json'), 'utf8');
      const executorText = readFileSync(join(dir, 'out', 'synthetic-executor.json'), 'utf8');
      for (const text of [policyText, executorText]) assert.equal(/PRIVATE KEY/.test(text), false, 'public configuration only');

      // The Host's own parser accepts the rendered policy: two routes, the .invalid one unchanged.
      const policy = JSON.parse(policyText);
      const operatorEnv = Object.fromEntries(policy.operators.map((operator) => [operator.apiKeyEnv, `synthetic-${operator.operatorId}-0000000000000000000000000000`]));
      const { loadEnterpriseHostConfiguration } = await import(join(ROOT, 'dist/src/enterprise/index.js'));
      const configuration = loadEnterpriseHostConfiguration({
        AOC_ENTERPRISE_GOVERNED_ACTIONS_FILE: join(dir, 'out', 'governed-actions.json'),
        AOC_ENTERPRISE_KERNEL_AUTHORITY_ENABLED: 'true',
        AOC_ENTERPRISE_KERNEL_AUTHORITY_ORGANIZATION_ID: ORG,
        AOC_ENTERPRISE_REQUIRE_AUTH: 'true',
        // As the pilot kit fixes it: capabilities are issued only from the durable grant store.
        AOC_ENTERPRISE_PERSISTENCE_PROVIDER: 'sqlite',
        AOC_ENTERPRISE_SQLITE_PATH: join(dir, 'host', 'governance.sqlite'),
        FRONTERA_SYNTHETIC_EXECUTOR_TOKEN: TOKEN,
        FRONTERA_AUDITOR_KEY_EXECUTION_VERIFIER: 'synthetic-test-auditor-credential-000000000000000000',
        ...operatorEnv,
      });
      assert.equal(configuration.governedActions.routes.size, 2);
      assert.equal(configuration.governedActions.routes.get('deploy-release'), BASE.routes[0].adapterId, 'the failure route is the AUTH-04D2A one');
      assert.equal(configuration.governedActions.routes.get('synthetic.deploy-release'), 'synthetic-executor-verified');
      assert.deepEqual(policy.genericHttpAdapters[0], BASE.genericHttpAdapters[0], 'the .invalid adapter is unchanged, byte for byte');
      assert.deepEqual(policy.executionCapabilities.receiptEvidence.trustedExecutors[0].organizationIds, [ORG]);
      assert.deepEqual(policy.auditors, [{ auditorId: 'pilot-execution-verifier', apiKeyEnv: 'FRONTERA_AUDITOR_KEY_EXECUTION_VERIFIER' }], 'one read-only auditor, the execution verifier');

      // The reference executor's own parser accepts the rendered configuration, pinned to the Host's public key alone.
      const { parseReferenceExecutorConfiguration } = await import(join(ROOT, 'dist/src/enterprise/reference-executor/configuration.js'));
      const executor = parseReferenceExecutorConfiguration(JSON.parse(executorText), { FRONTERA_SYNTHETIC_EXECUTOR_TOKEN: TOKEN });
      assert.equal(executor.mode, 'synthetic-execution');
      assert.equal(executor.listen.host, '127.0.0.1');
      assert.equal(executor.listen.port, 8445);
      assert.deepEqual(executor.permittedActions, ['synthetic.deploy-release']);
      assert.deepEqual(executor.permittedResources, ['synthetic-environment']);
      assert.deepEqual(executor.organizationIds, [ORG]);
      assert.equal(JSON.parse(executorText).trustedIssuers[0].keys[0].publicKeyPem, keys[0].publicKeyPem);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the success route adds one synthetic action on one synthetic environment, behind a human approval; the pilot policy is otherwise untouched', () => {
    const governance = ADDITIONS.governance;
    assert.deepEqual(governance.actionClasses.flatMap((entry) => entry.actions), ['synthetic.deploy-release']);
    assert.deepEqual(governance.resourceClasses.flatMap((entry) => entry.resources), ['synthetic-environment']);
    for (const profile of governance.profiles) {
      assert.equal(profile.approval.minimumApprovals, 1, 'a human decides every synthetic execution');
      assert.equal(profile.approval.requiredEvidence, undefined, 'evidence-free, as the pilot policy (AUTH-04D1E Option C)');
    }
    assert.equal(ADDITIONS.route.action, 'synthetic.deploy-release');
    assert.equal(ADDITIONS.genericHttpAdapter.origin, 'https://synthetic-executor.frontera-systems.com:8443');
    assert.equal(ADDITIONS.executor.expectedOrigin, ADDITIONS.genericHttpAdapter.origin, 'the executor expects exactly the origin the adapter sends');
    assert.equal(ADDITIONS.executor.environment, 'reference-synthetic');
    assert.deepEqual(ADDITIONS.executor.syntheticExecution.syntheticActions, ['synthetic.deploy-release']);
    assert.equal(ADDITIONS.executor.syntheticExecution.effect, 'frontera.synthetic-deployment-record.v1', 'one local synthetic record: no downstream');
    assert.deepEqual(ADDITIONS.executor.listen, { host: '127.0.0.1', port: 8445 });
    assert.deepEqual(ADDITIONS.executionCapabilities.adapters, [{ adapterId: ADDITIONS.genericHttpAdapter.adapterId, audience: ADDITIONS.executor.audience }]);
    // The governed request the executor receives names the request, decision and execution it acts for.
    assert.deepEqual(Object.keys(ADDITIONS.genericHttpAdapter.body.fields).sort(), ['decisionId', 'executionId', 'release', 'requestId']);
  });

  it('the executor front: TLS on 8443 to loopback 8445 only, one path and one method, the allow-list included; the Authority ingress never routes there', () => {
    const front = read(`${KIT}/nginx/synthetic-executor.conf`);
    const directives = front.split('\n').filter((line) => !line.trim().startsWith('#')).join('\n');
    assert.deepEqual([...directives.matchAll(/proxy_pass ([^;]+);/g)].map((match) => match[1]), ['http://127.0.0.1:8445']);
    assert.deepEqual([...directives.matchAll(/^\s*listen ([^;]+);/gm)].map((match) => match[1]).sort(), ['80', '8443 ssl', '8443 ssl default_server', '[::]:80', '[::]:8443 ssl', '[::]:8443 ssl default_server']);
    assert.match(directives, /location \^~ \/v1\/deployments\/ \{\s*limit_except POST \{\s*deny all;/);
    assert.match(directives, /proxy_set_header Host \$http_host;/, 'the exact Host, port included, reaches the executor');
    assert.match(directives, /include \/etc\/nginx\/frontera\/synthetic-executor-allowlist\.conf;/);
    assert.match(directives, /client_max_body_size 64k;/);
    assert.equal(/X-Forwarded|X-Real-IP|add_header/i.test(directives), false, 'nothing is added in either direction');
    const authority = read(`${KIT}/nginx/authority.conf`) + read(`${KIT}/nginx/authority-gateway-proxy.conf`);
    assert.equal(/8443|8445|synthetic-executor/.test(authority), false, 'the Authority ingress has no route to the executor');
  });

  it('AUTH-04D2V: the execution verifier reads only — GET on the private listener, store read methods, pinned keys from the rendered directory, no secret printed', () => {
    const source = read('scripts/deploy/verify-synthetic-execution.mjs');
    const code = source.split('\n').filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*')).join('\n');
    assert.equal(/method: '(POST|PUT|PATCH|DELETE)'/.test(code), false, 'GET only');
    assert.match(code, /method: 'GET'/);
    assert.equal(/\.(reserve|markIssued|markFailed|record|accept|claim|append|write|insert|update|delete)\(/.test(code.replace(/process\.(stdout|stderr)\.write\(/g, '')), false, 'read methods only');
    assert.equal(/writeFileSync|appendFileSync|mkdirSync|rmSync|create: true/.test(code), false, 'writes nothing');
    assert.ok(code.includes(String.raw`/^http:\/\/127\.0\.0\.1:\d+$/.test(host)`), 'the private loopback listener only');
    assert.equal(/--key|--public-key|--trusted|--approval/.test(code), false, 'no argument supplies a key or an approval view');
    assert.equal(/headers\[|console\.log\(.*(authorization|observer|auditor)/i.test(code), false, 'no credential is logged');
    const authority = read(`${KIT}/nginx/authority.conf`) + read(`${KIT}/nginx/authority-gateway-proxy.conf`);
    assert.equal(/\/api\/(admin|evidence)/.test(authority), false, 'the Authority origin routes neither the operator plane nor the evidence API');
  });

  it('the executor overlay publishes no port and is absent from every earlier stage', () => {
    const overlay = read(`${KIT}/compose.executor.yaml`);
    assert.equal(/^\s+ports:/m.test(overlay), false);
    for (const earlier of ['compose.host.yaml', 'compose.authority.yaml']) assert.equal(/synthetic-executor|execution-init/.test(read(`${KIT}/${earlier}`)), false, `${earlier} knows nothing of the executor`);
    const template = read(`${KIT}/host.env.example`);
    assert.equal(/^FRONTERA_SYNTHETIC_/m.test(template), false, 'stage 1 needs no executor value');
  });
});
