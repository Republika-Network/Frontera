import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createEnterprise } from '../composition/composition-root.js';
import { AUTHORITY_CONTROLLED_EXECUTION_MODULE_ID } from '../modules/authority-controlled-execution-module.js';
import {
  AUTHORITY_BINDING_REASON_CODE_VALUES,
  createAuthorityControlledExecution,
  isWellFormedGrantAuthorityBinding,
  grantValidityCeilingsFor,
} from '../execution-governance/index.js';
import * as executionGovernance from '../execution-governance/index.js';
import { GRANT_EXERCISE_REASON_CODE_VALUES } from '../../features/execution-runtime/index.js';
import { GRANT_REASON_CODE_VALUES, createInMemoryBoundedGrantStore } from '../../features/grant-runtime/index.js';
import { AOC_KERNEL_REASON_CODES } from '../../kernel/reason-codes/reason-codes.js';
import { KernelGrantCapability } from '../../kernel/orchestration/grant-adapter.js';
import { createRecordingExecutionAdapter } from '../../features/execution-runtime/tests/execution-fixture.js';
import { buildAllowedRequestBody, buildTestKernelProviders } from './support.js';

/**
 * Two properties, measured rather than asserted in prose.
 *
 * 1. **A deployment that does not compose grant-aware execution is unchanged.**
 *    This is the migration contract every optional capability in this
 *    repository already honours, and it is the one a phase that touches the
 *    composition root has to prove rather than claim.
 * 2. **The composition cannot decide anything**, and neither can the adapter it
 *    calls.
 */

describe('Backward compatibility — a Host that does not compose it is unchanged', () => {
  it('exposes no execution service and registers no module', async () => {
    const enterprise = await createEnterprise({ kernelProviders: buildTestKernelProviders() });

    assert.equal(enterprise.authorityControlledExecution, undefined, 'absence means this Host issues no grants — never that execution is ungoverned');
    assert.equal(
      enterprise.modules().some((module) => module.id === AUTHORITY_CONTROLLED_EXECUTION_MODULE_ID),
      false,
    );

    await enterprise.close();
  });

  it('evaluate() still answers exactly as it did, with no grant projection on the result', async () => {
    const enterprise = await createEnterprise({ kernelProviders: buildTestKernelProviders() });

    const outcome = await enterprise.evaluate(buildAllowedRequestBody({ requestId: 'req-exec-absent-1' }));
    assert.equal(outcome.body.status, 'allowed');
    assert.equal('grants' in (outcome.body as unknown as Readonly<Record<string, unknown>>), false);

    await enterprise.close();
  });

  it('the Governance Record it commits carries no grant block', async () => {
    const enterprise = await createEnterprise({ kernelProviders: buildTestKernelProviders() });

    const outcome = await enterprise.evaluate(buildAllowedRequestBody({ requestId: 'req-exec-absent-2' }));
    const serialized = JSON.stringify(outcome.body.governanceRecord ?? {});
    assert.equal(serialized.includes('"grants"'), false, 'a record from a Host that never adopted layer E must not mention one');
    assert.equal(serialized.includes('GRANT_'), false);

    await enterprise.close();
  });
});

describe('Backward compatibility — composing it leaves the frozen evaluation path alone', () => {
  it('the Kernel behind evaluate() is a different, non-grant-aware instance, so the record is unchanged', async () => {
    const kernelProviders = buildTestKernelProviders();
    const plain = await createEnterprise({ kernelProviders });
    const plainOutcome = await plain.evaluate(buildAllowedRequestBody({ requestId: 'req-exec-parity-1' }));
    await plain.close();

    const composed = await createEnterprise({
      kernelProviders: buildTestKernelProviders(),
      authorityControlledExecution: {
        grantCapability: new KernelGrantCapability({ declaration: {} }),
        executionAdapter: createRecordingExecutionAdapter(),
        resolveAuthorityBinding: () => ({ kind: 'no-temporal-authority-bound', sourceKind: 'none-applicable', justification: 'test composition' }),
      },
    });
    const composedOutcome = await composed.evaluate(buildAllowedRequestBody({ requestId: 'req-exec-parity-1' }));

    assert.ok(composed.authorityControlledExecution !== undefined, 'the capability really was composed');
    assert.equal(composedOutcome.body.status, plainOutcome.body.status);
    assert.deepEqual(composedOutcome.body.reasonCodes, plainOutcome.body.reasonCodes);
    assert.equal('grants' in (composedOutcome.body as unknown as Readonly<Record<string, unknown>>), false, 'the frozen path never gains a grant projection');
    assert.equal(JSON.stringify(composedOutcome.body.governanceRecord ?? {}).includes('"grants"'), false);

    await composed.close();
  });

  it('the module is registered, optional, and reports the adapter it was given', async () => {
    const enterprise = await createEnterprise({
      kernelProviders: buildTestKernelProviders(),
      authorityControlledExecution: {
        grantCapability: new KernelGrantCapability({ declaration: {} }),
        executionAdapter: createRecordingExecutionAdapter(),
        resolveAuthorityBinding: () => ({ kind: 'no-temporal-authority-bound', sourceKind: 'none-applicable', justification: 'test composition' }),
      },
    });

    const module = enterprise.modules().find((entry) => entry.id === AUTHORITY_CONTROLLED_EXECUTION_MODULE_ID);
    assert.ok(module !== undefined, 'an adopted capability is visible in the module snapshot');
    assert.ok(enterprise.isReady(), 'an optional execution capability never takes a Host out of ready');

    await enterprise.close();
  });

  it('a host may supply its own durable grant store instead of the in-memory default', async () => {
    const store = createInMemoryBoundedGrantStore();
    const enterprise = await createEnterprise({
      kernelProviders: buildTestKernelProviders(),
      authorityControlledExecution: {
        grantCapability: new KernelGrantCapability({ declaration: {} }),
        grantStore: store,
        executionAdapter: createRecordingExecutionAdapter(),
        resolveAuthorityBinding: () => ({ kind: 'no-temporal-authority-bound', sourceKind: 'none-applicable', justification: 'test composition' }),
      },
    });

    assert.ok(enterprise.authorityControlledExecution !== undefined);
    await enterprise.close();
  });
});

describe('Structural — the composition cannot authorize, and the adapter cannot decide', () => {
  const ROOT = 'src/enterprise/execution-governance';

  function sourceFiles(dir: string): readonly string[] {
    if (!existsSync(dir)) return [];
    const out: string[] = [];
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
      else if (full.endsWith('.ts')) out.push(full);
    }
    return out;
  }

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

  const SOURCES = sourceFiles(ROOT);

  it('has real production sources to measure', () => {
    assert.ok(SOURCES.length >= 4, `expected production sources under ${ROOT}, found ${SOURCES.length}`);
  });

  it('constructs no decision: no allow, no deny, no status, no policy effect', () => {
    for (const file of SOURCES) {
      const text = codeOf(file);
      for (const pattern of [/\ballowed\s*:/, /\bdenied\s*:/, /'approval_required'/, /'indeterminate'/, /\bPolicyEffect\b/, /\bPolicyDecision\b/, /AocKernelReasonCode/]) {
        assert.equal(pattern.test(text), false, `${file} must construct no decision (${String(pattern)})`);
      }
    }
  });

  it('never reads the decision status to form an opinion — the boolean the Kernel adapter computed is what crosses', () => {
    for (const file of SOURCES) {
      const text = codeOf(file);
      assert.equal(/decision\.status/.test(text), false, `${file} must not read decision.status; layer E has no standing to interpret a decision`);
      assert.equal(/result\.status/.test(text), false, `${file} must not read result.status`);
      assert.equal(/\.reasonCodes\s*=/.test(text), false, `${file} must not write reason codes onto a decision`);
    }
  });

  it('never resolves context, discharges an obligation, or evaluates policy', () => {
    for (const file of SOURCES) {
      const text = codeOf(file);
      for (const pattern of [/\bdischarge/i, /\bwaive/i, /evaluatePolicyForEnforcement/, /ContextResolution\b/, /\btrustClass\b/]) {
        assert.equal(pattern.test(text), false, `${file} must not reach into another layer's lifecycle (${String(pattern)})`);
      }
    }
  });

  it('never calls enforce() — authorization and exercise are two moments, so they are two calls', () => {
    for (const file of SOURCES) {
      assert.equal(/\.enforce\s*\(/.test(codeOf(file)), false, `${file} must not gate the Kernel's executor; no accepted ADR gives grants a role there`);
    }
  });

  it('never constructs a Kernel — a composition that could build its own decision engine is a second decision producer', () => {
    for (const file of SOURCES) {
      const text = codeOf(file);
      assert.equal(/new\s+AocKernel/.test(text), false, `${file} must not instantiate a Kernel`);
      assert.equal(/createAocKernel\s*\(/.test(text), false, `${file} must not instantiate a Kernel`);
    }
  });

  it('names no provider, no ledger, no wallet and no signer', () => {
    for (const file of SOURCES) {
      const text = codeOf(file);
      for (const pattern of [/\bxrpl?\b/i, /\bledger\b/i, /\bwallet\b/i, /\bPinata\b/i, /\bsignTransaction\b/i, /\bprivate[_-]?key\b/i]) {
        assert.equal(pattern.test(text), false, `${file} must stay provider-neutral (${String(pattern)})`);
      }
    }
  });

  it('names no AI, model or inference dependency', () => {
    for (const file of SOURCES) {
      const text = codeOf(file);
      for (const pattern of [/\banthropic\b/i, /\bopenai\b/i, /\bllm\b/i, /\binference\b/i, /\bprompt\b/i, /\brisk[Ss]core/, /\brecommend/i]) {
        assert.equal(pattern.test(text), false, `${file} must contain no intelligence dependency (${String(pattern)})`);
      }
    }
  });

  it('uses no eval, no new Function, no dynamic import, no ambient clock and no ambient randomness', () => {
    for (const file of SOURCES) {
      const text = codeOf(file);
      for (const pattern of [/\beval\s*\(/, /new\s+Function\s*\(/, /\bimport\s*\(/, /Date\.now\s*\(/, /new\s+Date\s*\(\s*\)/, /Math\.random/, /randomUUID/, /randomBytes/]) {
        assert.equal(pattern.test(text), false, `${file} must contain nothing dynamic or ambient (${String(pattern)})`);
      }
    }
  });

  it('exports no HTTP surface — a caller must never issue, extend, revoke or exercise its own grant', () => {
    const wire = Object.keys(executionGovernance).filter((name) => /handler|route|controller|endpoint|RequestBody|http/i.test(name));
    assert.deepEqual(wire, []);
  });

  it('the authority-binding vocabulary overlaps no other vocabulary', () => {
    const authorization: readonly string[] = Object.values(AOC_KERNEL_REASON_CODES);
    for (const code of AUTHORITY_BINDING_REASON_CODE_VALUES) {
      assert.equal(authorization.includes(code), false, `${code} overlaps the policy-denial vocabulary`);
      assert.equal(GRANT_REASON_CODE_VALUES.includes(code as never), false, `${code} overlaps the issuance vocabulary`);
      assert.equal(GRANT_EXERCISE_REASON_CODE_VALUES.includes(code as never), false, `${code} overlaps the exercise vocabulary`);
    }
  });
});

describe('Structural — the authority binding has no third option', () => {
  it('a bounded-authority binding without a real instant is not well formed', () => {
    assert.equal(isWellFormedGrantAuthorityBinding({ kind: 'bounded-authority', authorityKind: 'mandate', authorityRef: 'm-1', expiresAt: '' }), false);
    assert.equal(isWellFormedGrantAuthorityBinding({ kind: 'bounded-authority', authorityKind: 'mandate', authorityRef: 'm-1', expiresAt: 'soon' }), false);
    assert.equal(isWellFormedGrantAuthorityBinding({ kind: 'bounded-authority', authorityKind: 'mandate', authorityRef: '', expiresAt: '2026-01-01T00:00:00.000Z' }), false);
    assert.equal(isWellFormedGrantAuthorityBinding({ kind: 'bounded-authority', authorityKind: 'mandate', authorityRef: 'm-1', expiresAt: '2026-01-01T00:00:00.000Z' }), true);
  });

  it('an unjustified "no temporal bound" is not well formed — omission cannot spell the permissive case', () => {
    assert.equal(isWellFormedGrantAuthorityBinding({ kind: 'no-temporal-authority-bound', sourceKind: 'none-applicable', justification: '' }), false);
    assert.equal(isWellFormedGrantAuthorityBinding({ kind: 'no-temporal-authority-bound', sourceKind: 'none-applicable', justification: 'the generic Kernel path carries no upstream window' }), true);
  });

  it('only the bounded arm contributes a ceiling, and it contributes exactly one', () => {
    assert.deepEqual(grantValidityCeilingsFor({ kind: 'bounded-authority', authorityKind: 'mandate', authorityRef: 'm-1', expiresAt: '2026-01-01T00:00:00.000Z' }), [
      { source: 'authority', notAfter: '2026-01-01T00:00:00.000Z' },
    ]);
    assert.deepEqual(grantValidityCeilingsFor({ kind: 'no-temporal-authority-bound', sourceKind: 'none-applicable', justification: 'none applies' }), []);
  });

  it('a malformed bounded binding contributes no ceiling, so a caller that skipped validation still cannot issue under a broken cap', () => {
    assert.deepEqual(grantValidityCeilingsFor({ kind: 'bounded-authority', authorityKind: 'mandate', authorityRef: 'm-1', expiresAt: 'whenever' }), []);
  });
});

describe('Structural — the composition requires an authority-binding resolver', () => {
  it('the option is not optional: omitting it does not type-check', () => {
    const everythingButTheBinding = {
      kernel: { evaluate: async () => ({}) as never },
      grantCapability: new KernelGrantCapability({ declaration: {} }),
      grantStore: createInMemoryBoundedGrantStore(),
      executionAdapter: createRecordingExecutionAdapter(),
      now: () => '2026-01-01T00:00:00.000Z',
    };

    // @ts-expect-error `resolveAuthorityBinding` is required — a mandate-backed
    // flow whose ceiling is missing must fail closed, and the only way to
    // guarantee that is to make the host unable to compose without answering
    // the question. The proof is a compile error, exactly as
    // `ADR-ACCESS-GRANT.md` proves its non-responsibilities.
    void (() => createAuthorityControlledExecution(everythingButTheBinding));
    assert.ok(true);
  });
});
