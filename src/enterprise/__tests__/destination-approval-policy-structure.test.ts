import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { GRANT_BOUND_KEYS } from '../../features/grant-runtime/index.js';

/**
 * ANDREW-P0-05 — what the destination approval policy may reach, enforced
 * structurally, read from the TypeScript sources with comments stripped (so
 * documentation that names a forbidden thing to forbid it is not mistaken for
 * a dependency on it).
 */

const POLICY = 'src/enterprise/trusted-context/destination-policy.ts';

function codeOf(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function walk(dir: string): readonly string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === 'tests' || name === '__tests__') continue;
      out.push(...walk(full));
    } else if (full.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

const importsOf = (file: string): readonly string[] => [...new Set([...codeOf(file).matchAll(/from ['"]([^'"]+)['"]/g)].map((match) => match[1] ?? ''))].sort();

describe('ANDREW-P0-05 structure — the destination policy is data over resolved facts', () => {
  it('imports only policy and governance-profile types and the P0-04 fact class names', () => {
    assert.deepEqual(importsOf(POLICY), ['../../features/domain-policy-pack-runtime/domain/index.js', '../governance-profile/index.js', './destination-context.js']);
    const code = codeOf(POLICY);
    assert.match(code, /import type \{ PolicyCondition, PolicyPackRule \} from '\.\.\/\.\.\/features\/domain-policy-pack-runtime\/domain\/index\.js'/, 'policy types only');
    assert.match(code, /import type \{ GovernanceConfiguration \} from '\.\.\/governance-profile\/index\.js'/, 'configuration type only');
    assert.match(code, /import \{ DESTINATION_CONTEXT_FACT_CLASSES as F \} from '\.\/destination-context\.js'/, 'fact class names, nothing else of the provider');
  });

  it('reads no store, registry, approval history or administration — and calls no resolver', () => {
    const code = codeOf(POLICY);
    const forbidden = [
      /better-sqlite3|sqlite|\bSELECT\b|\bINSERT\b/i,
      /destination-registry\/|destination-approval\/|destination-runtime/,
      /administration|createDestinationApprovalAdministration/,
      /\.lookup\s*\(|\.read\s*\(|\.history\s*\(|\.register\s*\(|\.approve\s*\(|\.revoke\s*\(/,
      /resolveTrustedDestinationContext|createDestinationContextProvider|resolveContext/,
    ];
    for (const pattern of forbidden) assert.equal(pattern.test(code), false, `${POLICY} must not match ${String(pattern)}`);
  });

  it('reaches no rail, signer, grant, execution, network, clock or randomness', () => {
    const code = codeOf(POLICY);
    const forbidden = [
      /xrpl|ripple|testnet|wallet/i,
      /signer|signing|sign\(/i,
      /grant-runtime|bounded-grant|execution-runtime|execution-adapter|adapters\//,
      /node:http|node:https|node:net|\bfetch\s*\(/,
      /Date\.now\s*\(|new Date\s*\(|Math\.random/,
    ];
    for (const pattern of forbidden) assert.equal(pattern.test(code), false, `${POLICY} must not match ${String(pattern)}`);
  });

  it('carries no amount threshold and no demo special case', () => {
    const code = codeOf(POLICY);
    assert.equal(/'amount'|'currency'|'counterpartyId'|'metadata'|'parameter'/.test(code), false, 'reads no monetary, counterparty, metadata or parameter field');
    assert.equal(/75[,_]?000|74[,_]?999|100[,_]?000/.test(code), false, 'no demo amount');
    assert.equal(/andrew|demo|requestId|org-|network-a/i.test(code), false, 'no demo identifier');
  });

  it('refuses rather than pends: the only effect is deny, never an action approval that could resume the decision', () => {
    const code = codeOf(POLICY);
    assert.match(code, /type: 'deny'/);
    assert.equal(/require_approval|require_evidence|require_external_standing|'allow'|no_op/.test(code), false);
    assert.equal(/\bhold\b/i.test(code), false);
  });
});

describe('ANDREW-P0-05 structure — nothing downstream learned destination policy', () => {
  it('the policy engine and enforcement stay generic: no destination vocabulary, no trusted-context import', () => {
    const files = [...walk('src/features/domain-policy-pack-runtime'), ...walk('src/features/action-enforcement')];
    assert.ok(files.length > 10);
    for (const file of files) {
      const code = codeOf(file);
      assert.equal(/from ['"][^'"]*(trusted-context|destination-runtime|destination-registry|destination-approval)/.test(code), false, file);
      assert.equal(/DESTINATION_(UNKNOWN|NOT_APPROVED|APPROVAL_INACTIVE|APPROVAL_UNVERIFIED)|destination\.approved|destination\.known/.test(code), false, file);
    }
  });

  it('execution adapters, the execution and grant runtimes, issuance and the signers contain no destination governance', () => {
    const files = [
      ...walk('src/features/execution-runtime'),
      ...walk('src/features/grant-runtime'),
      ...walk('src/enterprise/execution-adapters'),
      ...walk('src/enterprise/execution-governance'),
      ...walk('src/enterprise/bounded-grant-store'),
      ...walk('src/enterprise/external-authority-signer'),
      ...walk('src/enterprise/authority-authenticity'),
    ];
    assert.ok(files.length > 20);
    for (const file of files) {
      const code = codeOf(file);
      assert.equal(/trusted-context|destination-policy|destinationApprovalPolicyRules|DESTINATION_(UNKNOWN|NOT_APPROVED|APPROVAL_INACTIVE|APPROVAL_UNVERIFIED)|destination\.approved/.test(code), false, file);
    }
  });

  it('the Kernel gained no HOLD status and no destination interpretation', () => {
    for (const file of walk('src/kernel')) {
      const code = codeOf(file);
      assert.equal(/'hold'|'held'|"hold"/.test(code), false, file);
      assert.equal(/destination-policy|destinationApprovalPolicyRules|DESTINATION_NOT_APPROVED/.test(code), false, file);
    }
  });

  it('the grant format is unchanged: the same bound keys, no destination-approval axis', () => {
    assert.deepEqual([...GRANT_BOUND_KEYS], ['action', 'actionClass', 'amount', 'counterparty', 'governanceProfile', 'organization', 'resourceClass', 'resources']);
  });

  it('destination approval reaches policy only through trusted context: the policy module is composed by the embedder, never by the Host, an HTTP route or the public barrel', () => {
    assert.equal(/destination-policy|destinationApprovalPolicyRules/.test(readFileSync('src/enterprise/index.ts', 'utf8')), false);
    for (const file of [...walk('src/enterprise/api'), ...walk('src/enterprise/host'), ...walk('src/enterprise/composition'), ...walk('src/enterprise/governed-action')]) {
      assert.equal(/destination-policy|destinationApprovalPolicyRules|assertDestinationPolicyGovernance/.test(codeOf(file)), false, file);
    }
  });
});
