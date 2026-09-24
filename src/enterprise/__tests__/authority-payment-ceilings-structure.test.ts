import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { EMERGENCY_CONTROL_REASON_CODES } from '../../features/emergency-control-runtime/index.js';
import { EXERCISE_CONTROL_REASON_CODES as X, EXERCISE_CONTROL_REASON_CODE_VALUES } from '../../features/exercise-control-runtime/index.js';
import { GRANT_EXERCISE_REASON_CODE_VALUES } from '../../features/execution-runtime/index.js';
import { GRANT_REASON_CODE_VALUES, boundedGrantDigest, boundedGrantId, type BoundedGrant } from '../../features/grant-runtime/index.js';
import { AOC_KERNEL_REASON_CODES } from '../../kernel/index.js';
import {
  AUTHORITY_BINDING_REASON_CODE_VALUES,
  FINANCIAL_AUTHORITY_REASON_CODE_VALUES,
  financialAuthorityDigest,
  grantAuthorityBindingDigest,
  grantAuthorityProvenanceDigest,
  type FinancialAuthority,
} from '../execution-governance/index.js';
import { GOVERNED_ACTION_REASON_CODES, GOVERNED_ACTION_RESERVED_CONTEXT_KEYS } from '../governed-action/index.js';
import { DRAFTING_IS_FINANCIAL, IDENTITY, NO_TEMPORAL_BOUND, ALLOWED_INTENT, buildGovernedWorld, monetaryAuthority } from './governed-action-support.js';

/**
 * P10 — the structural guarantees that keep the increment from quietly
 * regressing: the request never flows back into the source ceiling, the
 * layers that must stay blind to durable authority stay blind, the vocabulary
 * stays separate, and a financial grant's provenance really does commit to
 * the monetary authority behind it.
 */

function codeOf(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .map((line) => {
      const index = line.indexOf('//');
      return index === -1 ? line : line.slice(0, index);
    })
    .join('\n');
}

function sourceFiles(dir: string): readonly string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === '__tests__' || name === 'tests' || name === 'fixtures') continue;
      out.push(...sourceFiles(full));
    } else if (full.endsWith('.ts') && !full.endsWith('.test.ts')) out.push(full);
  }
  return out;
}

function importsOf(file: string): readonly string[] {
  return [...codeOf(file).matchAll(/from\s+'([^']+)'/g)].map((match) => match[1] ?? '');
}

describe('P10 §24 / §76 — the requested amount never becomes the source ceiling again', () => {
  it('the Kernel grant adapter reads no amount and no currency from the request', () => {
    const code = codeOf('src/kernel/orchestration/grant-adapter.ts');
    assert.equal(/action\.amount/.test(code), false, 'request.action.amount must not reach GrantSourceAuthorization.scope');
    assert.equal(/action\.currency/.test(code), false);
    assert.equal(/kind:\s*'ceiling'/.test(code), false, 'the Kernel projection constructs no ceiling bound at all');
  });

  it('the issuance core compares the requested amount against authority and never uses it as a ceiling', () => {
    const code = codeOf('src/enterprise/execution-governance/issuance-core.ts');
    assert.ok(/compareMonetaryAmounts\(\{ value: amount, unit: asset \}, resolution\.authority\.ceiling\)/.test(code), 'the requested effect is tested against the authority ceiling');
    assert.equal(/limit:\s*(request\.action\.amount|amount)\b/.test(code), false, 'no ceiling is built from the requested amount');
  });
});

describe('P10 §23 / §76 / §100 — the layers that must stay blind to durable authority stay blind', () => {
  it('the Kernel and the grant runtime import no Kernel Authority store, no financial-authority resolver, no P7 ledger and no SQLite', () => {
    for (const file of [...sourceFiles('src/kernel'), ...sourceFiles('src/features/grant-runtime')]) {
      for (const specifier of importsOf(file)) {
        assert.equal(/kernel-authority|execution-governance|exercise-control-ledger|better-sqlite3|exercise-control-runtime/.test(specifier), false, `${file} imports '${specifier}'`);
      }
    }
  });

  it('the financial-authority resolver reads the hydrated projection only: no SQLite, no ledger, no evidence stream, no adapter', () => {
    const file = 'src/enterprise/kernel-authority/financial-authority-resolver.ts';
    for (const specifier of importsOf(file)) {
      assert.equal(/better-sqlite3|sqlite|exercise-control-ledger|authority-event-stream|execution-adapters|governance-store|governed-action/.test(specifier), false, `${file} imports '${specifier}'`);
    }
    const code = codeOf(file);
    assert.equal(/\bawait\b|\basync\b|\.then\s*\(/.test(code), false, 'the resolver is synchronous');
    assert.equal(/\bNumber\s*\(|parseFloat|parseInt|toFixed|Math\.(round|floor|ceil)/.test(code), false, 'no monetary value passes through a JavaScript number');
  });

  it('the financial-authority port imports no authority store and names no payment provider', () => {
    const file = 'src/enterprise/execution-governance/financial-authority.ts';
    for (const specifier of importsOf(file)) {
      assert.equal(/kernel-authority|better-sqlite3|exercise-control-ledger|authority-event-stream/.test(specifier), false, `${file} imports '${specifier}'`);
    }
    for (const candidate of [file, 'src/enterprise/kernel-authority/financial-authority-resolver.ts', 'src/enterprise/kernel-authority/monetary-constraints.ts']) {
      const code = codeOf(candidate);
      for (const pattern of [/\bstripe\b/i, /\bxrpl\b/i, /\bmpp\b/i, /PaymentIntent/, /\bchallenge\b/i, /\bwallet\b/i, /\bsettlement\b/i, /\breceipt\b/i]) {
        assert.equal(pattern.test(code), false, `${candidate} must stay provider-neutral (${String(pattern)})`);
      }
    }
  });

  it('there is no second authority model, budget engine or payment path', () => {
    const everything = sourceFiles('src').map((file) => codeOf(file)).join('\n');
    for (const pattern of [/\bPaymentKernel\b/, /\bPaymentAuthorizationService\b/, /\bPaymentGrant\b/, /\bPaymentPolicyEngine\b/, /\bPaymentExecutionPath\b/, /\bBudgetLedger\b/]) {
      assert.equal(pattern.test(everything), false, String(pattern));
    }
  });

  it('the commit guard re-resolves financial authority synchronously, inside the same critical-section function', () => {
    const code = codeOf('src/enterprise/execution-governance/issuance-core.ts');
    const start = code.indexOf('revalidateSource: (correlation: GrantCorrelation): GrantSourceAuthorization | undefined => {');
    const end = code.indexOf('return withAuthorityCeilings(current, binding);', start);
    assert.notEqual(start, -1);
    assert.notEqual(end, -1);
    const body = code.slice(start, end);
    assert.ok(/resolveFinancialAuthority\(/.test(body) && /'commit'/.test(body), 'financial authority participates in the commit boundary');
    assert.equal(/\bawait\b|\basync\b|\.then\s*\(/.test(body), false);
  });

  it('a payment ceiling is neither deployment safety configuration nor monetary configuration', () => {
    const declaration = codeOf('src/features/grant-runtime/services/grant-declaration.ts');
    assert.equal(/payment|spend|maximumAmount|amountCeiling/i.test(declaration), false, 'GrantDeclaration carries no financial authority');
    const composition = readFileSync('src/enterprise/composition/composition-root.ts', 'utf8');
    const monetaryOptions = composition.slice(composition.indexOf('export interface EnterpriseMonetaryOptions'), composition.indexOf('}', composition.indexOf('export interface EnterpriseMonetaryOptions')));
    assert.equal(/ceiling|spend|limit|budget|maxAmount/i.test(monetaryOptions.replace(/\/\*\*[\s\S]*?\*\//g, '')), false, 'the monetary registry answers what assets exist, never how much may be spent');
  });

  it('no authority record, grant or ledger path stores consumption on the authority side', () => {
    for (const file of ['src/enterprise/kernel-authority/contracts.ts', 'src/features/authority-graph/domain/authority-grant.ts']) {
      const code = codeOf(file);
      assert.equal(/\b(spent|remaining|usageCount|amountRemaining)\s*[?]?:/.test(code), false, `${file} must not carry consumption`);
    }
  });
});

describe('P10 §32 / §74 — the caller cannot name authority, and the vocabulary stays truthful', () => {
  it('the P10 authority vocabulary is reserved in asserted context', () => {
    for (const key of ['maxAmount', 'max_amount', 'paymentCeiling', 'spendingLimit', 'spendingLimits', 'budget', 'budgetId', 'remaining', 'limitId', 'scopeKey', 'window', 'financialAuthority', 'authorityLimit']) {
      assert.ok(GOVERNED_ACTION_RESERVED_CONTEXT_KEYS.includes(key), key);
    }
  });

  it('FINANCIAL_AUTHORITY_* overlaps no other vocabulary — least of all a policy denial', () => {
    const others: readonly string[] = [
      ...Object.values(AOC_KERNEL_REASON_CODES),
      ...GRANT_REASON_CODE_VALUES,
      ...GRANT_EXERCISE_REASON_CODE_VALUES,
      ...EXERCISE_CONTROL_REASON_CODE_VALUES,
      ...AUTHORITY_BINDING_REASON_CODE_VALUES,
      ...Object.values(EMERGENCY_CONTROL_REASON_CODES),
      ...Object.values(GOVERNED_ACTION_REASON_CODES),
    ];
    for (const code of FINANCIAL_AUTHORITY_REASON_CODE_VALUES) assert.equal(others.includes(code), false, code);
  });
});

describe('P10 §38 – §40 / §65 — financial-authority provenance', () => {
  const AUTHORITY: FinancialAuthority = {
    organizationId: 'org-a',
    trustDomainId: 'td-a',
    subject: 'agent-a',
    lineage: ['delegation-grant:d-1', 'authority-grant:g-1'],
    ceiling: { value: '100', unit: 'USD' },
    spendingLimits: [
      { limitId: 'authority:daily', scopeKey: 's-1', maximum: '500', unit: 'USD', window: { kind: 'rolling', seconds: 86_400 } },
      { limitId: 'authority:lifetime', scopeKey: 's-1', maximum: '1000', unit: 'USD', window: { kind: 'lifetime' } },
    ],
  };

  it('a non-financial grant’s provenance is byte-identical to its pre-P10 binding digest', () => {
    assert.equal(grantAuthorityProvenanceDigest(NO_TEMPORAL_BOUND, undefined), grantAuthorityBindingDigest(NO_TEMPORAL_BOUND));
  });

  it('a financial grant’s provenance commits to the financial authority: equivalent state digests identically, any change differs', () => {
    const reordered: FinancialAuthority = { ...AUTHORITY, spendingLimits: [...AUTHORITY.spendingLimits].reverse() };
    assert.equal(financialAuthorityDigest(reordered), financialAuthorityDigest(AUTHORITY), 'canonical ordering');
    const base = grantAuthorityProvenanceDigest(NO_TEMPORAL_BOUND, AUTHORITY);
    assert.notEqual(base, grantAuthorityBindingDigest(NO_TEMPORAL_BOUND));
    for (const changed of [
      { ...AUTHORITY, ceiling: { value: '99.99', unit: 'USD' } },
      { ...AUTHORITY, lineage: ['delegation-grant:d-2', 'authority-grant:g-1'] },
      { ...AUTHORITY, spendingLimits: AUTHORITY.spendingLimits.slice(1) },
      { ...AUTHORITY, spendingLimits: [{ ...(AUTHORITY.spendingLimits[0] as FinancialAuthority['spendingLimits'][number]), maximum: '501' }, ...AUTHORITY.spendingLimits.slice(1)] },
      { ...AUTHORITY, subject: 'agent-b' },
      { ...AUTHORITY, organizationId: 'org-b' },
    ]) {
      assert.notEqual(grantAuthorityProvenanceDigest(NO_TEMPORAL_BOUND, changed), base);
    }
  });

  it('§40 a financial grant issued before P10 — binding-only provenance — is withheld at exercise and never re-dated or repaired', async () => {
    const world = buildGovernedWorld({ monetary: DRAFTING_IS_FINANCIAL, financialAuthority: monetaryAuthority('1000') });
    const first = await world.orchestrator.govern(IDENTITY, { ...ALLOWED_INTENT, idempotencyKey: 'p10-legacy-seed', amount: { value: '10', currency: 'USD' } });
    assert.equal(first.status, 'executed', JSON.stringify(first));
    const issued = world.issueOutcomes.find((outcome) => outcome.outcome === 'issued');
    assert.ok(issued !== undefined && issued.outcome === 'issued');

    // Exactly what a P9 Host would have written: the same grant, provenance
    // committing to the authority binding alone.
    const legacyProvenance = grantAuthorityBindingDigest(NO_TEMPORAL_BOUND);
    const id = boundedGrantId({ correlation: issued.grant.correlation, subject: issued.grant.subject, scope: issued.grant.scope, expiresAt: issued.grant.expiresAt, authorityBindingDigest: legacyProvenance });
    const withoutDigest = { ...issued.grant, id, authorityBindingDigest: legacyProvenance };
    const legacy: BoundedGrant = { ...withoutDigest, digest: boundedGrantDigest(withoutDigest) };
    const stored = await world.grantStore.issue({ grant: legacy, commitGuard: () => ({ permitted: true, reasonCodes: [] }) });
    assert.equal(stored.outcome, 'issued');

    const calls = world.adapter.callCount;
    const outcome = await world.ace.exercise({
      boundedGrantId: legacy.id,
      subject: legacy.subject,
      action: legacy.correlation.action,
      resource: legacy.correlation.resourceScope,
      organization: 'org-datasys',
      amount: { value: '10', unit: 'USD' },
      correlation: legacy.correlation,
      executionId: 'p10-legacy-exercise',
    });
    assert.equal(outcome.status, 'withheld');
    assert.ok(outcome.status === 'withheld' && outcome.withheldBy === 'exercise-control');
    assert.deepEqual(outcome.status === 'withheld' && outcome.withheldBy === 'exercise-control' ? [...outcome.exerciseControl.reasonCodes] : [], [X.EXERCISE_CONTROL_AUTHORITY_BINDING_CHANGED]);
    assert.equal(world.adapter.callCount, calls, 'no provider effect under a financial grant with no P10 provenance');
    assert.equal((await world.grantStore.read(legacy.id)).grant?.authorityBindingDigest, legacyProvenance, 'the old record was not rewritten');
  });
});
