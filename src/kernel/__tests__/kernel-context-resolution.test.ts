import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildDraftClosureEmailGuardInput } from '../../features/action-enforcement/fixtures/allowed-action.fixture.js';
import { buildUnknownAgentReadGuardInput } from '../../features/action-enforcement/fixtures/denied-action.fixture.js';
import { bridgeRecognitionRuntime, buildDatasysEnforcementFixture } from '../../features/action-enforcement/fixtures/datasys-enforcement.fixture.js';
import { createManualEnforcementClock, createSequentialEnforcementIdGenerator } from '../../features/action-enforcement/runtime/enforcement-runtime-context.js';
import {
  createFailingContextResolver,
  createInMemoryContextResolver,
  type ContextDeclaration,
  type ContextFactObservation,
  type ContextResolverPort,
  type ContextSource,
} from '../../features/context-resolution-runtime/index.js';
import { AocKernel } from '../AocKernel.js';
import { ContextConfigurationError } from '../../features/context-resolution-runtime/index.js';
import type { KernelEvaluationRequest } from '../contracts/kernel-request.js';
import type { PolicyPackProvider } from '../contracts/ports.js';
import { AOC_KERNEL_REASON_CODES } from '../reason-codes/reason-codes.js';
import { NOW, toKernelRequest } from './characterization/support.js';

const ERP: ContextSource = { id: 'ctx.src.erp.sap-prod', kind: 'erp', name: 'SAP production', trustClass: 'authoritative' };
const CRM: ContextSource = { id: 'ctx.src.crm.salesforce', kind: 'crm', name: 'Salesforce', trustClass: 'authoritative' };
const REQUEST_SOURCE: ContextSource = { id: 'ctx.src.request', kind: 'request', name: 'The requester', trustClass: 'asserted' };
const SOURCES = [ERP, CRM, REQUEST_SOURCE];

function buildKernel(options: {
  readonly declaration?: ContextDeclaration;
  readonly resolver?: ContextResolverPort;
  readonly observations?: readonly ContextFactObservation[];
  readonly policyPackProvider?: PolicyPackProvider;
  readonly sources?: readonly ContextSource[];
}): AocKernel {
  const fixture = buildDatasysEnforcementFixture();
  return new AocKernel({
    recognitionProvider: bridgeRecognitionRuntime(fixture.recognitionRuntime),
    clock: createManualEnforcementClock(NOW),
    idGenerator: createSequentialEnforcementIdGenerator(),
    ...(options.policyPackProvider !== undefined ? { policyPackProvider: options.policyPackProvider } : {}),
    ...(options.declaration !== undefined
      ? {
          contextResolution: {
            provider: options.resolver ?? createInMemoryContextResolver(options.observations ?? []),
            sources: options.sources ?? SOURCES,
            declaration: options.declaration,
          },
        }
      : {}),
  });
}

function allowedRequest(overrides: Partial<KernelEvaluationRequest> = {}): KernelEvaluationRequest {
  return { ...toKernelRequest(buildDraftClosureEmailGuardInput()), ...overrides };
}

const VENDOR_OPTIONAL: ContextDeclaration = {
  requirements: [{ key: 'vendor.status', minimumTrustClass: 'authoritative', required: false }],
};
const VENDOR_REQUIRED: ContextDeclaration = {
  requirements: [{ key: 'vendor.status', minimumTrustClass: 'authoritative', required: true }],
};

const APPROVED_BY_ERP: readonly ContextFactObservation[] = [{ key: 'vendor.status', value: 'approved', sourceId: ERP.id, observedAt: NOW }];

describe('Kernel context capability — a trusted fact resolves', () => {
  it('reports what was resolved, from which source, at what class, without the value', async () => {
    const result = await buildKernel({ declaration: VENDOR_OPTIONAL, observations: APPROVED_BY_ERP }).evaluate(allowedRequest());

    assert.equal(result.status, 'allowed');
    assert.equal(result.context?.performed, true);
    assert.equal(result.context?.resolved, true);
    assert.deepEqual(result.context?.declaredKeys, ['vendor.status']);
    const fact = result.context?.facts[0];
    assert.equal(fact?.key, 'vendor.status');
    assert.equal(fact?.sourceId, ERP.id);
    assert.equal(fact?.sourceKind, 'erp');
    assert.equal(fact?.trustClass, 'authoritative');
    assert.equal(fact?.resolution, 'resolved');
    assert.equal('value' in (fact ?? {}), false, 'a fact value never reaches the decision record');
  });

  it('the resolved facts, values and all, reach the policy pack under `aoc.context`', async () => {
    let seen: unknown;
    await buildKernel({
      declaration: VENDOR_OPTIONAL,
      observations: APPROVED_BY_ERP,
      policyPackProvider: {
        evaluatePolicyForEnforcement(input) {
          seen = input.metadata?.['aoc.context'];
          return { type: 'policy_allowed', allowed: true, reasonCode: 'POLICY_ALLOWED', reason: 'ok' };
        },
      },
    }).evaluate(allowedRequest());

    const context = seen as { readonly resolved: boolean; readonly facts: readonly { readonly key: string; readonly value: unknown }[] } | undefined;
    assert.ok(context !== undefined, 'the resolved context reached policy');
    assert.equal(context.resolved, true);
    assert.equal(context.facts[0]?.value, 'approved', 'policy needs the value to decide; the record does not need it to be provable');
  });

  it('a declaration with no requirements resolves nothing — indistinguishable from no capability', async () => {
    const result = await buildKernel({ declaration: { requirements: [] } }).evaluate(allowedRequest());
    assert.equal('context' in result, false);
  });
});

describe('Kernel context capability — unresolved, stale and conflicted', () => {
  it('an optional requirement that did not resolve is reported and changes no outcome', async () => {
    const result = await buildKernel({ declaration: VENDOR_OPTIONAL, observations: [] }).evaluate(allowedRequest());

    assert.equal(result.status, 'allowed', 'Frontera ships no rule about what an unresolved fact means');
    assert.deepEqual(result.context?.unresolved, ['vendor.status']);
    assert.equal(result.context?.unsatisfiedRequirements, undefined);
  });

  it('a declared-required key that did not resolve denies, and says so', async () => {
    const result = await buildKernel({ declaration: VENDOR_REQUIRED, observations: [] }).evaluate(allowedRequest());

    assert.equal(result.status, 'denied');
    assert.deepEqual(result.reasonCodes, [AOC_KERNEL_REASON_CODES.CONTEXT_REQUIRED_FACT_UNRESOLVED]);
    assert.deepEqual(result.context?.unsatisfiedRequirements, [{ key: 'vendor.status', status: 'unresolved', minimumTrustClass: 'authoritative' }]);
  });

  it('a stale required fact denies with its own code — distinct from unresolved', async () => {
    const declaration: ContextDeclaration = { requirements: [{ key: 'vendor.status', minimumTrustClass: 'authoritative', maxAgeSeconds: 60, required: true }] };
    const result = await buildKernel({
      declaration,
      observations: [{ key: 'vendor.status', value: 'approved', sourceId: ERP.id, observedAt: '2025-12-31T00:00:00.000Z' }],
    }).evaluate(allowedRequest());

    assert.equal(result.status, 'denied');
    assert.deepEqual(result.reasonCodes, [AOC_KERNEL_REASON_CODES.CONTEXT_REQUIRED_FACT_STALE]);
    assert.deepEqual(result.context?.stale, ['vendor.status']);
  });

  it('two sources disagreeing on a required fact denies with the conflict code, and neither side is chosen', async () => {
    const result = await buildKernel({
      declaration: VENDOR_REQUIRED,
      observations: [
        { key: 'vendor.status', value: 'approved', sourceId: ERP.id, observedAt: NOW },
        { key: 'vendor.status', value: 'suspended', sourceId: CRM.id, observedAt: NOW },
      ],
    }).evaluate(allowedRequest());

    assert.equal(result.status, 'denied');
    assert.deepEqual(result.reasonCodes, [AOC_KERNEL_REASON_CODES.CONTEXT_REQUIRED_FACT_CONFLICTED]);
    assert.deepEqual(result.context?.conflicted, ['vendor.status']);
    assert.equal(result.context?.facts.length, 2);
  });

  it('a required fact answered below the declared class denies as untrusted', async () => {
    const result = await buildKernel({
      declaration: VENDOR_REQUIRED,
      observations: [{ key: 'vendor.status', value: 'approved', sourceId: REQUEST_SOURCE.id, observedAt: NOW }],
    }).evaluate(allowedRequest());

    assert.equal(result.status, 'denied');
    assert.deepEqual(result.reasonCodes, [AOC_KERNEL_REASON_CODES.CONTEXT_REQUIRED_FACT_UNTRUSTED]);
  });

  it('a resolver that throws produces `resolved: false`, never an empty fact set and never an indeterminate evaluation', async () => {
    const result = await buildKernel({ declaration: VENDOR_OPTIONAL, resolver: createFailingContextResolver() }).evaluate(allowedRequest());

    assert.equal(result.status, 'allowed', 'an unreadable source is a fact, not an authorization outcome the source chose');
    assert.equal(result.context?.resolved, false);
    assert.deepEqual(result.context?.unresolved, ['vendor.status']);
  });

  it('a resolver that throws denies only where the deployment declared the fact required', async () => {
    const result = await buildKernel({ declaration: VENDOR_REQUIRED, resolver: createFailingContextResolver() }).evaluate(allowedRequest());

    assert.equal(result.status, 'denied');
    assert.deepEqual(result.reasonCodes, [AOC_KERNEL_REASON_CODES.CONTEXT_REQUIRED_FACT_UNRESOLVED]);
    assert.deepEqual(result.context?.unsatisfiedRequirements, [{ key: 'vendor.status', status: 'context_not_resolved', minimumTrustClass: 'authoritative' }]);
  });

  it('a resolver returning a malformed result fails closed the same way', async () => {
    const malformed = { resolveContext: () => Promise.resolve({ observations: 'everything is fine' } as unknown as { observations: readonly ContextFactObservation[] }) };
    const result = await buildKernel({ declaration: VENDOR_REQUIRED, resolver: malformed }).evaluate(allowedRequest());

    assert.equal(result.status, 'denied');
    assert.equal(result.context?.resolved, false);
  });
});

describe('Kernel context capability — narrowing only', () => {
  it('a satisfied context requirement cannot rescue an outcome the chain already denied', async () => {
    const denied = toKernelRequest(buildUnknownAgentReadGuardInput());
    const result = await buildKernel({ declaration: VENDOR_REQUIRED, observations: APPROVED_BY_ERP }).evaluate(denied);

    assert.equal(result.status, 'denied');
    assert.ok(!result.reasonCodes.includes(AOC_KERNEL_REASON_CODES.ACTION_ALLOWED), 'context never produces an allow');
    assert.equal(result.context?.performed, true, 'what was resolved is still reported on a denial');
  });

  it('an unsatisfied required fact does not relabel an outcome that was already denied for another reason', async () => {
    const denied = toKernelRequest(buildUnknownAgentReadGuardInput());
    const withContext = await buildKernel({ declaration: VENDOR_REQUIRED, observations: [] }).evaluate(denied);
    const withoutContext = await buildKernel({}).evaluate(denied);

    assert.deepEqual(withContext.reasonCodes, withoutContext.reasonCodes, 'a denial keeps the reason it actually stopped for');
  });

  it('removing `required: true` leaves the identical facts changing no outcome — the test that settles whether layer C decided', async () => {
    const required = await buildKernel({ declaration: VENDOR_REQUIRED, observations: [] }).evaluate(allowedRequest({ requestId: 'ctx-narrow-1' }));
    const optional = await buildKernel({ declaration: VENDOR_OPTIONAL, observations: [] }).evaluate(allowedRequest({ requestId: 'ctx-narrow-1' }));

    assert.equal(required.status, 'denied');
    assert.equal(optional.status, 'allowed');
    assert.deepEqual(required.context?.unresolved, optional.context?.unresolved, 'the facts were identical; only the declaration differed');
  });
});

describe('Kernel context capability — enforce()', () => {
  it('an unsatisfied required fact stops the executor before it runs', async () => {
    let ran = 0;
    const result = await buildKernel({ declaration: VENDOR_REQUIRED, observations: [] }).enforce(allowedRequest(), () => {
      ran += 1;
      return 'done';
    });

    assert.equal(result.status, 'denied');
    assert.equal(result.execution.executed, false);
    assert.equal(ran, 0, 'a side effect that has already happened cannot be denied afterwards');
  });

  it('a satisfied required fact lets the executor run, and the resolved context travels on the result', async () => {
    let ran = 0;
    const result = await buildKernel({ declaration: VENDOR_REQUIRED, observations: APPROVED_BY_ERP }).enforce(allowedRequest(), () => {
      ran += 1;
      return 'done';
    });

    assert.equal(result.status, 'allowed');
    assert.equal(ran, 1);
    assert.equal(result.context?.facts[0]?.sourceId, ERP.id);
  });
});

describe('Kernel context capability — determinism and configuration', () => {
  it('repeated evaluation of the same request against the same world produces the same context evaluation', async () => {
    const kernel = buildKernel({ declaration: VENDOR_OPTIONAL, observations: APPROVED_BY_ERP });
    const first = await kernel.evaluate(allowedRequest({ requestId: 'ctx-determinism-1' }));
    const second = await kernel.evaluate(allowedRequest({ requestId: 'ctx-determinism-1' }));

    assert.equal(JSON.stringify(first.context), JSON.stringify(second.context));
  });

  it('a mis-declared capability fails at kernel construction, never mid-evaluation', () => {
    assert.throws(
      () => buildKernel({ declaration: { requirements: [{ key: 'vendor.status', minimumTrustClass: 'authoritative', required: true }], assertableKeys: ['invoice.status'] } }),
      ContextConfigurationError,
    );
    assert.throws(
      () => buildKernel({ declaration: VENDOR_OPTIONAL, sources: [{ ...REQUEST_SOURCE, trustClass: 'authoritative' }] }),
      ContextConfigurationError,
    );
  });

  it('the `report` posture names every requirement that turned on a requester-supplied fact', async () => {
    const declaration: ContextDeclaration = {
      requirements: [{ key: 'vendor.status', minimumTrustClass: 'asserted', required: false }],
      assertedFactPolicy: 'report',
    };
    const result = await buildKernel({
      declaration,
      observations: [{ key: 'vendor.status', value: 'approved', sourceId: REQUEST_SOURCE.id, observedAt: NOW }],
    }).evaluate(allowedRequest());

    assert.equal(result.status, 'allowed', 'report still lets an asserted fact decide — the migration is a list before it is an outage');
    assert.deepEqual(result.context?.assertedFactReads, ['vendor.status']);
    assert.equal(result.context?.assertedFactPolicy, 'report');
  });

  it('the `require-declaration` posture stops an undeclared asserted fact from satisfying a required key', async () => {
    const observations = [{ key: 'vendor.status', value: 'approved', sourceId: REQUEST_SOURCE.id, observedAt: NOW }];
    const permitted = await buildKernel({
      declaration: { requirements: [{ key: 'vendor.status', minimumTrustClass: 'asserted', required: true }], assertedFactPolicy: 'permit' },
      observations,
    }).evaluate(allowedRequest({ requestId: 'ctx-posture-permit' }));
    const required = await buildKernel({
      declaration: { requirements: [{ key: 'vendor.status', minimumTrustClass: 'asserted', required: true }], assertedFactPolicy: 'require-declaration' },
      observations,
    }).evaluate(allowedRequest({ requestId: 'ctx-posture-require' }));
    const declared = await buildKernel({
      declaration: {
        requirements: [{ key: 'vendor.status', minimumTrustClass: 'asserted', required: true }],
        assertedFactPolicy: 'require-declaration',
        assertableKeys: ['vendor.status'],
      },
      observations,
    }).evaluate(allowedRequest({ requestId: 'ctx-posture-declared' }));

    assert.equal(permitted.status, 'allowed', 'permit is today’s behaviour exactly');
    assert.equal(required.status, 'denied');
    assert.deepEqual(required.reasonCodes, [AOC_KERNEL_REASON_CODES.CONTEXT_REQUIRED_FACT_UNTRUSTED]);
    assert.equal(declared.status, 'allowed', 'a reviewed, declared assertable key still decides');
  });
});
