import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildDraftClosureEmailGuardInput } from '../../features/action-enforcement/fixtures/allowed-action.fixture.js';
import { bridgeRecognitionRuntime, buildDatasysEnforcementFixture } from '../../features/action-enforcement/fixtures/datasys-enforcement.fixture.js';
import { createManualEnforcementClock, createSequentialEnforcementIdGenerator } from '../../features/action-enforcement/runtime/enforcement-runtime-context.js';
import {
  contextObservationProvenanceDigest,
  createFailingContextResolver,
  createInMemoryContextResolver,
  type ContextFactObservation,
  type ContextResolverPort,
  type ContextSource,
} from '../../features/context-resolution-runtime/index.js';
import { AocKernel } from '../AocKernel.js';
import type { KernelEvaluationRequest } from '../contracts/kernel-request.js';
import type { PolicyPackProvider } from '../contracts/ports.js';
import { AOC_KERNEL_REASON_CODES as R } from '../reason-codes/reason-codes.js';
import { NOW, toKernelRequest } from './characterization/support.js';

/**
 * CORE-04 — the Trusted Context Boundary as the Kernel composes it: per
 * effective Governance Profile, admission before policy, admitted facts only in
 * the policy input, restrict-only ambiguity denying, and the admitted-context
 * digest on the decision. Deterministic throughout: a manual clock, an
 * in-memory resolver, no network.
 */

const ORG = 'org-a';
const PROFILE = { id: 'invoice-settlement', version: 1, digest: `sha256:${'a'.repeat(64)}` } as const;
const ERP: ContextSource = { id: 'erp', kind: 'erp', name: 'ERP', trustClass: 'authoritative', organizationId: ORG, provenance: 'reference-digest', attests: [{ factClass: 'invoice.exists', maxAgeSeconds: 900 }] };
const RISK: ContextSource = { id: 'risk', kind: 'risk_engine', name: 'Signals', trustClass: 'authoritative', organizationId: ORG, provenance: 'reference-digest', attests: [{ factClass: 'signal.x', maxAgeSeconds: 300 }] };
const RISK_2: ContextSource = { ...RISK, id: 'risk-2' };

function observed(key: string, value: string | boolean, sourceId: string): ContextFactObservation {
  const base = { key, value, sourceId, observedAt: new Date(Date.parse(NOW) - 5000).toISOString(), reference: `${sourceId}:${key}` };
  return { ...base, provenanceDigest: contextObservationProvenanceDigest(base) };
}

function kernel(resolver: ContextResolverPort, policyPackProvider?: PolicyPackProvider): AocKernel {
  const fixture = buildDatasysEnforcementFixture();
  return new AocKernel({
    recognitionProvider: bridgeRecognitionRuntime(fixture.recognitionRuntime),
    clock: createManualEnforcementClock(NOW),
    idGenerator: createSequentialEnforcementIdGenerator(),
    ...(policyPackProvider !== undefined ? { policyPackProvider } : {}),
    contextResolution: {
      provider: resolver,
      sources: [ERP, RISK, RISK_2],
      declaration: { requirements: [] },
      profileDeclarations: [
        {
          profile: PROFILE,
          declaration: {
            requirements: [
              { key: 'invoice.exists', minimumTrustClass: 'authoritative', required: true },
              { key: 'signal.x', minimumTrustClass: 'authoritative', required: false, restrictive: true },
            ],
          },
        },
      ],
    },
  });
}

function request(profile: { readonly id: string; readonly version: number; readonly digest: string } | 'unprofiled' = PROFILE): KernelEvaluationRequest {
  const base = toKernelRequest(buildDraftClosureEmailGuardInput());
  return {
    ...base,
    organization: { id: ORG },
    action: { ...base.action, ...(profile !== 'unprofiled' ? { semantics: { actionClass: 'settle', resourceClass: 'payables_ledger', governanceProfile: profile } } : {}) },
  };
}

/** A policy provider that records exactly what the policy layer was given, and decides nothing. */
function recordingPolicy(seen: unknown[]): PolicyPackProvider {
  return {
    evaluatePolicyForEnforcement(input) {
      seen.push(input);
      return { type: 'policy_allowed', allowed: true, reasonCode: 'POLICY_ALLOWED', reason: 'recording only' };
    },
  };
}

describe('CORE-04 — the Kernel resolves the effective profile’s declaration, and only a matching one', () => {
  it('a profiled request resolves its profile’s keys; an unprofiled one resolves nothing and its record carries no context', async () => {
    const queries: string[][] = [];
    const resolver = createInMemoryContextResolver((query) => {
      queries.push([...query.keys]);
      return [observed('invoice.exists', true, 'erp')];
    });
    const profiled = await kernel(resolver).evaluate(request());
    assert.equal(profiled.status, 'allowed');
    assert.deepEqual(queries, [['invoice.exists', 'signal.x']]);
    assert.match(profiled.context?.digest ?? '', /^sha256:/);
    assert.equal(profiled.context?.profile, `${PROFILE.id}@1#${PROFILE.digest}`);
    const unprofiled = await kernel(resolver).evaluate(request('unprofiled'));
    assert.equal(unprofiled.context, undefined);
    assert.equal(queries.length, 1);
  });

  it('a profile edited under the same id and version (another digest) selects nothing — and the library declaration here is empty', async () => {
    const resolver = createInMemoryContextResolver([observed('invoice.exists', true, 'erp')]);
    const edited = await kernel(resolver).evaluate(request({ ...PROFILE, digest: `sha256:${'b'.repeat(64)}` }));
    assert.equal(edited.context, undefined);
  });
});

describe('CORE-04 §49 / §81 — failure model: nothing defaults open', () => {
  it('a resolver that fails denies a required fact as unresolved — never omitted, never false, never allowed', async () => {
    const result = await kernel(createFailingContextResolver('erp down')).evaluate(request());
    assert.equal(result.status, 'denied');
    assert.ok(result.reasonCodes.includes(R.CONTEXT_REQUIRED_FACT_UNRESOLVED));
    assert.ok(result.reasonCodes.includes(R.CONTEXT_RESTRICTIVE_FACT_AMBIGUOUS), 'with no resolution, no restriction can be ruled out');
    assert.equal(result.context?.resolved, false);
  });

  it('a malformed provider result is the same as a failure', async () => {
    const malformed: ContextResolverPort = { resolveContext: () => Promise.resolve({ observations: 'nope' as never }) };
    const result = await kernel(malformed).evaluate(request());
    assert.equal(result.status, 'denied');
    assert.equal(result.context?.resolved, false);
  });

  it('restrict-only: absent is the baseline (allowed); conflicting admitted readings deny', async () => {
    const baseline = await kernel(createInMemoryContextResolver([observed('invoice.exists', true, 'erp')])).evaluate(request());
    assert.equal(baseline.status, 'allowed');
    const conflicted = await kernel(createInMemoryContextResolver([observed('invoice.exists', true, 'erp'), observed('signal.x', 'high', 'risk'), observed('signal.x', 'low', 'risk-2')])).evaluate(request());
    assert.equal(conflicted.status, 'denied');
    assert.deepEqual(conflicted.reasonCodes, [R.CONTEXT_RESTRICTIVE_FACT_AMBIGUOUS]);
  });
});

describe('CORE-04 §27 — policy receives admitted facts only, each in its own typed list', () => {
  it('admitted material facts in contextFacts, admitted restrict-only facts in restrictiveFacts; refused or unadmitted readings nowhere', async () => {
    const seen: Record<string, unknown>[] = [];
    const resolver = createInMemoryContextResolver([
      observed('invoice.exists', true, 'erp'),
      observed('signal.x', 'high', 'risk'),
      // Refused: not authorized for the class, and a tampered reading.
      observed('invoice.exists', false, 'risk'),
      { ...observed('signal.x', 'critical', 'risk-2'), value: 'none' },
    ]);
    const smuggling = request();
    await kernel(resolver, recordingPolicy(seen)).evaluate({ ...smuggling, context: { 'invoice.exists': false, contextFacts: [{ factClass: 'invoice.exists', value: false }], 'AOC.CONTEXT': { facts: [] } } });
    assert.equal(seen.length, 1);
    const input = seen[0] as { contextFacts?: unknown; restrictiveFacts?: unknown; metadata?: Record<string, unknown> };
    assert.deepEqual(input.contextFacts, [{ factClass: 'invoice.exists', value: true }]);
    assert.deepEqual(input.restrictiveFacts, [{ factClass: 'signal.x', value: 'high' }]);
  });
});
