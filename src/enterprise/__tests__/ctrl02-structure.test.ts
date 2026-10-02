import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * CTRL-02 — structural boundaries of the operator plane, and the passport
 * reconciliation decision pinned in code.
 *
 * Every rule is asserted over a measured scope (a minimum file count proves
 * the scope is real) and over code with comments removed, so prose never
 * satisfies or violates a rule.
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
      if (name === '__tests__' || name === 'fixtures' || name === 'tests') continue;
      out.push(...sourcesUnder(full));
    } else if (full.endsWith('.ts') && !full.endsWith('.test.ts')) out.push(full);
  }
  return out;
}

const importsOf = (file: string): readonly string[] => [...codeOf(file).matchAll(/from\s+['"]([^'"]+)['"]/g)].map((match) => match[1] ?? '');

const OPERATOR_CONTROL = sourcesUnder('src/enterprise/operator-control');
/** The HTTP-facing CTRL-02 modules: everything but the store. */
const OPERATOR_HTTP_FACING = OPERATOR_CONTROL.filter((file) => !file.endsWith('control-plane-store.ts'));
const ADAPTER = 'src/enterprise/adapters/node-http-adapter.ts';
const ENTERPRISE = sourcesUnder('src/enterprise');

describe('CTRL-02 structure — the measured scopes are real', () => {
  it('operator-control has its modules, and the enterprise tree is measured whole', () => {
    assert.ok(OPERATOR_CONTROL.length >= 7, `operator-control sources: ${OPERATOR_CONTROL.length}`);
    assert.ok(OPERATOR_HTTP_FACING.length >= 6);
    assert.ok(ENTERPRISE.length >= 200, `enterprise sources: ${ENTERPRISE.length}`);
  });
});

describe('CTRL-02 structure — identity, organization and system context never come from a request', () => {
  it('no operator-plane module reads an operator id, role, permission, organization, system flag or provenance from request data', () => {
    for (const file of [...OPERATOR_HTTP_FACING, 'src/enterprise/authority-administration/service.ts', 'src/enterprise/authority-administration/contracts.ts']) {
      const code = codeOf(file);
      for (const pattern of [
        /(body|raw|input|query|request)\s*(\[\s*['"]|\.)(operatorId|role|permissions|organizationId|system|actorRef|issuerRef|provisionedBy|approvedBy|authoredBy|activatedBy)\b/,
        /\.\.\.\s*(raw|body|rawBody|request|query)\b/,
        /headers\[['"]x-/i,
      ]) {
        assert.equal(pattern.test(code), false, `${file} must not match ${String(pattern)}`);
      }
    }
  });

  it('`system: true` is constructed in exactly one place on the operator plane — after authorization, from the authenticated operator', () => {
    const service = codeOf('src/enterprise/operator-control/service.ts');
    assert.equal(service.match(/system:\s*true/g)?.length, 1);
    assert.match(service, /function operatorContext\(operator: EnterpriseOperatorPrincipal\): KernelAuthorityAccessContext \{\s*return Object\.freeze\(\{ system: true, organizationId, actorId: operator\.actorRef \}\);/);
    for (const file of OPERATOR_HTTP_FACING.filter((candidate) => !candidate.endsWith('service.ts'))) assert.equal(/system:\s*true/.test(codeOf(file)), false, file);
    assert.equal(/system:\s*true/.test(codeOf(ADAPTER)), false);
  });

  it('every operator-plane write names its operator from the authenticated principal, and the principal from configuration', () => {
    const service = codeOf('src/enterprise/operator-control/service.ts');
    for (const match of service.matchAll(/operatorRef:\s*([\w.]+)/g)) assert.equal(match[1], 'operator.actorRef');
    const authenticator = codeOf('src/enterprise/operator-control/operator-authenticator.ts');
    assert.match(authenticator, /actorRef: `operator:\$\{identity\.operatorId\}`/);
  });
});

describe('CTRL-02 structure — no path around the authoritative services', () => {
  it('no HTTP-facing module imports a database driver, SQL, a signer or key material', () => {
    for (const file of [...OPERATOR_HTTP_FACING, ADAPTER]) {
      for (const specifier of importsOf(file)) {
        assert.equal(/better-sqlite3|sqlite|authority-authenticity|signer|signing|node:fs/.test(specifier), false, `${file} must not import '${specifier}'`);
      }
      const code = codeOf(file);
      assert.equal(/\b(INSERT|UPDATE|DELETE)\b\s+(INTO|FROM|\w+\s+SET)/i.test(code), false, `${file} holds no SQL`);
    }
  });

  it('no operator-plane module appends a Kernel-Authority event, or reaches the store’s write half, except through the provisioning service', () => {
    for (const file of [...OPERATOR_CONTROL, ADAPTER]) {
      const code = codeOf(file);
      assert.equal(/appendEvent|buildKernelAuthorityEvent|sqlite-kernel-authority-store|in-memory-kernel-authority-store|createKernelAuthorityProvisioningService/.test(code), false, file);
    }
    // The service is handed reads and the provisioning service's provision methods — never `revoke`, never `appendEvent`.
    const service = codeOf('src/enterprise/operator-control/service.ts');
    assert.match(service, /Pick<KernelAuthorityStore, 'getRecord' \| 'listRecords'>/);
    assert.equal(/provisioning\.revoke|\.revoke\(context/.test(service), false, 'revocation stays the CTRL-01 route');
  });

  it('the operator plane cannot mint or issue a bounded grant', () => {
    for (const file of [...OPERATOR_CONTROL, ADAPTER]) {
      const code = codeOf(file);
      for (const specifier of importsOf(file)) {
        assert.equal(/grant-runtime|bounded-grant-store|execution-governance|governed-action\/|kernel\/|grant-adapter/.test(specifier), false, `${file} must not import '${specifier}'`);
      }
      assert.equal(/issueFromDecision|issueGrant|BoundedGrantStore|boundedGrantStore|\.issue\(/.test(code), false, file);
    }
    const contracts = codeOf('src/enterprise/operator-control/contracts.ts');
    assert.equal(/'bounded-grant'|boundedGrant/.test(contracts), false, 'no provisioning schema exists for a bounded grant');
  });

  it('role checks live in one place: the policy table, asked through operatorMay by the authenticator only', () => {
    for (const file of [...OPERATOR_CONTROL, ADAPTER, 'src/enterprise/authority-administration/service.ts']) {
      const code = codeOf(file);
      if (file.endsWith('roles.ts')) continue;
      assert.equal(/\brole\s*[!=]==?\s*['"]/.test(code) || /['"]\s*[!=]==?\s*\w*\.?role\b/.test(code), false, `${file} compares a role directly`);
      if (!file.endsWith('operator-authenticator.ts')) assert.equal(/operatorMay\(/.test(code), false, `${file} decides a permission itself`);
    }
    assert.equal(codeOf('src/enterprise/operator-control/operator-authenticator.ts').match(/operatorMay\(/g)?.length, 1);
  });

  it('the HTTP adapter reaches the operator plane only through `enterprise.operatorControl`, and its mutations are exactly the six CTRL-02 verbs', () => {
    const adapter = codeOf(ADAPTER);
    for (const pattern of [/operator-control\//, /kernelAuthorityProvisioning|kernelAuthorityStore|controlPlane|appendEvent/]) assert.equal(pattern.test(adapter), false, String(pattern));
    for (const call of adapter.matchAll(/operatorControl\.(\w+)\(/g)) {
      assert.ok(
        // CTRL-03 added two reads (`listDecisionActivity`, `inspectDecisionEvidence`); the mutations below stay exactly six.
        ['describeOrganization', 'listAgents', 'inspectAgent', 'issueAgentCredential', 'rotateAgentCredential', 'revokeAgentCredential', 'listAuthorityEntities', 'provisionAuthorityEntity', 'listGovernanceProfiles', 'transitionGovernanceProfile', 'listDecisionActivity', 'inspectDecisionEvidence'].includes(call[1] ?? ''),
        String(call[1]),
      );
    }
    const block = /function matchOperatorRoute[\s\S]*?\n\}/.exec(adapter)?.[0] ?? '';
    assert.ok(block.length > 0);
    const post = block.slice(block.indexOf("if (method === 'POST')"));
    const kinds = [...post.matchAll(/kind: '([a-z-]+)'/g)].map((match) => match[1]).sort();
    assert.deepEqual(kinds, ['agent-credential-issue', 'entity-create', 'profile-transition']);
    assert.deepEqual([...post.matchAll(/\(([a-z]+(?:\|[a-z]+)+)\)\$/g)].map((match) => match[1]), ['rotate|revoke', 'activate|retire']);
    assert.equal(/'(PUT|PATCH|DELETE)'/.test(block), false);
    assert.equal(/unrevoke|restore|reactivate|reinstate|mint|issue\b|bounded/i.test(block.replace(/agent-credential-issue|const issue|issue\?\.|issue\[/g, '')), false);
  });
});

describe('CTRL-02 structure — the generic control plane stays generic and deterministic', () => {
  it('no payment rail, protocol or domain vocabulary in the operator plane', () => {
    for (const file of OPERATOR_CONTROL) {
      assert.equal(/xrpl|lightning|bolt11|x402|\bmpp\b|qnt|overledger|xls-6|invoice|stripe|ethereum|solana|hedera|rlusd|deploy|kubernetes|customer-data/i.test(codeOf(file)), false, file);
    }
  });

  it('no model, AI or remote-inference dependency, no network, process or dynamic code', () => {
    for (const file of OPERATOR_CONTROL) {
      const code = codeOf(file);
      for (const pattern of [/openai|anthropic|langchain|llm|inference|embedding/i, /node:net|node:http|node:https|node:dns|\bfetch\s*\(/, /child_process/, /\beval\s*\(/, /new\s+Function\s*\(/, /\brequire\s*\(/]) {
        assert.equal(pattern.test(code), false, `${file} must not match ${String(pattern)}`);
      }
    }
  });
});

describe('CTRL-02 passport reconciliation — pinned in code', () => {
  it('passport-web, agent-governance and the PMFreak foundation are never imported or loaded by the Enterprise runtime', () => {
    for (const file of ENTERPRISE) {
      for (const specifier of importsOf(file)) {
        assert.equal(/agent-passport-web|apps\/|@aoc-enterprise\/agent-governance|agent-governance\/|pmfreak/.test(specifier), false, `${file} imports ${specifier}`);
      }
      // Not only static imports: no code (comments stripped) names passport-web or PMFreak at all, and nothing loads
      // agent-governance dynamically. (The assurance framework's `agent-governance-levels` tags are metadata, not loads.)
      const code = codeOf(file);
      assert.equal(/agent-passport-web|pmfreak/i.test(code), false, `${file} names a separate passport product in code`);
      assert.equal(/(?:import|require)\s*\([^)]*(?:agent-governance|apps\/)/.test(code), false, `${file} loads a separate passport product`);
    }
  });

  it('the governed-action authority path — admission, the operator plane, Kernel Authority — never consults the Enterprise AgentPassport store', () => {
    for (const dir of ['src/enterprise/operator-control', 'src/enterprise/customer-identity', 'src/enterprise/kernel-authority', 'src/enterprise/governed-action']) {
      const files = sourcesUnder(dir);
      assert.ok(files.length > 0, dir);
      for (const file of files) {
        for (const specifier of importsOf(file)) assert.equal(/\.\.\/passport\/|passport-store|passport\/service/.test(specifier), false, `${file} imports ${specifier}`);
      }
    }
  });

  it('no passport signer, HMAC signer or passport key role exists in the Enterprise runtime; the authority signer stays authority-only', () => {
    for (const file of ENTERPRISE) {
      assert.equal(/createTestSigner|AgentPassportSignerPort|createHmac|PASSPORT_SIGNING_KEY|passportSigner/.test(codeOf(file)), false, file);
    }
    const signer = codeOf('src/enterprise/authority-authenticity/signer.ts');
    const signerInterface = /export interface AuthorityArtifactSigner[\s\S]*?\n\}/.exec(signer)?.[0] ?? '';
    assert.ok(signerInterface.length > 0);
    assert.equal(/passport/i.test(signerInterface), false, 'the authority signer has no passport operation');
    for (const file of OPERATOR_CONTROL) assert.equal(/\bsign\w*\(/.test(codeOf(file)), false, `${file} signs nothing`);
  });

  it('the canonical governed-action principal is the Kernel-Authority actor: an operator-issued credential is resolved through the Kernel Authority binding, never through its own record alone', () => {
    const admission = codeOf('src/enterprise/customer-identity/admission-service.ts');
    const dynamic = admission.indexOf('agentCredentials.authenticate(');
    const binding = admission.indexOf('subjectBindings.findActorByExternalSubject(');
    const agreement = admission.indexOf('issuedForActorId !== binding.actorId');
    assert.ok(dynamic > 0 && binding > dynamic && agreement > binding, 'credential → Kernel Authority binding → agreement check, in that order');
  });

  it('the CTRL-02 qualification report states the reconciliation and keeps TD-5 open', () => {
    const report = readFileSync('docs/security/CTRL-02-ORGANIZATIONS-OPERATORS-AGENT-INVENTORY.md', 'utf8');
    assert.match(report, /TD-5/);
    assert.match(report, /not publicly verifiable/i);
    assert.match(report, /Kernel-Authority passport/);
  });
});

describe('CTRL-02 structure — no customer-plane SDK method appeared for the operator plane', () => {
  it('the enterprise-host SDK names no admin, operator, agent-credential or profile-lifecycle route', () => {
    const sdk = [readFileSync('packages/enterprise-host-sdk/src/client.ts', 'utf8'), readFileSync('packages/enterprise-host-sdk/src/index.ts', 'utf8')].join('\n');
    assert.equal(/\/api\/admin|operatorControl|agentCredential|governance-profiles|provisionAuthority/i.test(sdk), false);
  });
});
