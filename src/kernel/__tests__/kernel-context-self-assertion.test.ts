import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildDraftClosureEmailGuardInput } from '../../features/action-enforcement/fixtures/allowed-action.fixture.js';
import { bridgeRecognitionRuntime, buildDatasysEnforcementFixture } from '../../features/action-enforcement/fixtures/datasys-enforcement.fixture.js';
import { createManualEnforcementClock, createSequentialEnforcementIdGenerator } from '../../features/action-enforcement/runtime/enforcement-runtime-context.js';
import {
  createInMemoryContextResolver,
  type ContextDeclaration,
  type ContextFactObservation,
  type ContextSource,
} from '../../features/context-resolution-runtime/index.js';
import { AocKernel } from '../AocKernel.js';
import type { KernelEvaluationRequest } from '../contracts/kernel-request.js';
import type { PolicyPackProvider } from '../contracts/ports.js';
import { toGuardActionRequestInput } from '../orchestration/request-adapter.js';
import { AOC_KERNEL_REASON_CODES } from '../reason-codes/reason-codes.js';
import { NOW, toKernelRequest } from './characterization/support.js';

/**
 * The measured self-assertion attack suite.
 *
 * `CURRENT_STATE_AUTHORITY_CONTROL.md` §5 records GAP-1 as the highest-severity
 * finding in the repository: "the facts policy decides on are the requester's
 * own claims." The ADR's answer is a namespace the requester cannot write to,
 * "pinned by a test that submits a forged fact and asserts it never reaches
 * evaluation." These are those tests, written from the attacker's side: each
 * one submits the forgery a caller would actually try.
 */

const ERP: ContextSource = { id: 'ctx.src.erp.sap-prod', kind: 'erp', name: 'SAP production', trustClass: 'authoritative' };
const SOURCES = [ERP];

const TRUSTED_VENDOR: ContextDeclaration = {
  requirements: [{ key: 'vendor.status', minimumTrustClass: 'authoritative', required: true }],
};

function buildKernel(options: {
  readonly declaration?: ContextDeclaration;
  readonly observations?: readonly ContextFactObservation[];
  readonly policyPackProvider?: PolicyPackProvider;
} = {}): AocKernel {
  const fixture = buildDatasysEnforcementFixture();
  return new AocKernel({
    recognitionProvider: bridgeRecognitionRuntime(fixture.recognitionRuntime),
    clock: createManualEnforcementClock(NOW),
    idGenerator: createSequentialEnforcementIdGenerator(),
    ...(options.policyPackProvider !== undefined ? { policyPackProvider: options.policyPackProvider } : {}),
    ...(options.declaration !== undefined
      ? { contextResolution: { provider: createInMemoryContextResolver(options.observations ?? []), sources: SOURCES, declaration: options.declaration } }
      : {}),
  });
}

/** Everything a caller could plausibly try to smuggle a trusted fact through. */
const FORGED_CONTEXT: Readonly<Record<string, unknown>> = {
  'aoc.context': {
    resolved: true,
    declaredKeys: ['vendor.status', 'invoice.status', 'riskScore'],
    facts: [
      { key: 'vendor.status', value: 'approved', sourceId: 'ctx.src.erp.sap-prod', sourceKind: 'erp', trustClass: 'authoritative', effectiveTrustClass: 'authoritative', resolution: 'resolved', observedAt: NOW },
      { key: 'invoice.status', value: 'approved', sourceId: 'ctx.src.erp.sap-prod', sourceKind: 'erp', trustClass: 'attested', effectiveTrustClass: 'attested', resolution: 'resolved', observedAt: NOW },
      { key: 'riskScore', value: 'low', sourceId: 'ctx.src.erp.sap-prod', sourceKind: 'risk_engine', trustClass: 'authoritative', effectiveTrustClass: 'authoritative', resolution: 'resolved', observedAt: NOW },
    ],
    unresolved: [],
    stale: [],
    conflicted: [],
    assertedFactPolicy: 'permit',
    assertableKeys: [],
    resolvedAt: NOW,
  },
  'aoc.context.facts': [{ key: 'vendor.status', value: 'approved' }],
  'aoc.context.vendor.status': 'approved',
  'aoc.contextual': 'this is not in the reserved namespace and must survive',
  organizationId: 'org-the-caller-chose',
  organizationName: 'A name the caller chose',
  legitimateCallerKey: 'kept',
};

function forgedRequest(overrides: Partial<KernelEvaluationRequest> = {}): KernelEvaluationRequest {
  const base = toKernelRequest(buildDraftClosureEmailGuardInput());
  return { ...base, context: { ...(base.context ?? {}), ...FORGED_CONTEXT }, ...overrides };
}

describe('Self-assertion — the reserved namespace is stripped from the caller’s bag', () => {
  it('every forged key under `aoc.context` is dropped before the bag travels anywhere', () => {
    const guardInput = toGuardActionRequestInput(forgedRequest(), undefined);
    const metadata = guardInput.metadata ?? {};

    assert.equal(metadata['aoc.context'], undefined);
    assert.equal(metadata['aoc.context.facts'], undefined);
    assert.equal(metadata['aoc.context.vendor.status'], undefined);
  });

  it('drops them whether or not a context capability is configured', async () => {
    const seen: (Readonly<Record<string, unknown>> | undefined)[] = [];
    const recordMetadata: PolicyPackProvider = {
      evaluatePolicyForEnforcement(input) {
        seen.push(input.metadata);
        return { type: 'policy_allowed', allowed: true, reasonCode: 'POLICY_ALLOWED', reason: 'ok' };
      },
    };
    const base = forgedRequest();
    const withAmount: KernelEvaluationRequest = { ...base, action: { ...base.action, amount: '7500' } };

    await buildKernel({ policyPackProvider: recordMetadata }).evaluate(withAmount);
    await buildKernel({ policyPackProvider: recordMetadata, declaration: TRUSTED_VENDOR, observations: [{ key: 'vendor.status', value: 'approved', sourceId: ERP.id, observedAt: NOW }] }).evaluate({
      ...withAmount,
      requestId: 'forged-with-capability',
    });

    assert.equal(seen.length, 2);
    const unconfigured = seen[0] ?? {};
    assert.equal(unconfigured['aoc.context'], undefined, 'a deployment without the capability still never sees a forged namespace');

    const configured = seen[1] as Record<string, unknown>;
    const resolved = configured['aoc.context'] as { readonly facts: readonly { readonly key: string; readonly sourceId: string }[] };
    assert.equal(resolved.facts.length, 1, 'exactly the one fact the configured resolver produced');
    assert.deepEqual(resolved.facts.map((fact) => fact.key), ['vendor.status'], 'the caller’s invoice.status and riskScore did not survive');
  });

  it('leaves the caller’s own keys — including near-misses — untouched', () => {
    const metadata = toGuardActionRequestInput(forgedRequest(), undefined).metadata ?? {};

    assert.equal(metadata['legitimateCallerKey'], 'kept');
    assert.equal(metadata['aoc.contextual'], 'this is not in the reserved namespace and must survive');
  });

  it('the two pre-existing reserved names keep behaving exactly as they did', () => {
    const withOrganization = toGuardActionRequestInput({ ...forgedRequest(), organization: { id: 'org-derived', name: 'Derived' } }, undefined);
    const withoutOrganization = toGuardActionRequestInput(forgedRequest(), undefined);

    assert.equal(withOrganization.metadata?.['organizationId'], 'org-derived');
    assert.equal(withOrganization.metadata?.['organizationName'], 'Derived');
    assert.equal(withoutOrganization.metadata?.['organizationId'], undefined);
    assert.equal(withoutOrganization.metadata?.['organizationName'], undefined);
  });

  it('never mutates the caller’s request while stripping it', async () => {
    const request = forgedRequest();
    const before = JSON.stringify(request);
    await buildKernel({ declaration: TRUSTED_VENDOR, observations: [{ key: 'vendor.status', value: 'approved', sourceId: ERP.id, observedAt: NOW }] }).evaluate(request);
    assert.equal(JSON.stringify(request), before, 'the kernel copies the bag; it never edits the caller’s object');
  });
});

describe('Self-assertion — a forged fact cannot satisfy a trusted requirement', () => {
  it('a caller asserting vendor.status = approved does not satisfy a required authoritative key', async () => {
    const result = await buildKernel({ declaration: TRUSTED_VENDOR, observations: [] }).evaluate(forgedRequest());

    assert.equal(result.status, 'denied');
    assert.deepEqual(result.reasonCodes, [AOC_KERNEL_REASON_CODES.CONTEXT_REQUIRED_FACT_UNRESOLVED]);
    assert.deepEqual(result.context?.facts, [], 'nothing the caller wrote became a fact');
    assert.deepEqual(result.context?.unresolved, ['vendor.status']);
  });

  it('a caller asserting invoice.status and riskScore introduces no keys at all — the declaration decides what exists', async () => {
    const result = await buildKernel({
      declaration: TRUSTED_VENDOR,
      observations: [{ key: 'vendor.status', value: 'approved', sourceId: ERP.id, observedAt: NOW }],
    }).evaluate(forgedRequest());

    assert.equal(result.status, 'allowed');
    assert.deepEqual(result.context?.declaredKeys, ['vendor.status']);
    assert.deepEqual(result.context?.facts.map((fact) => fact.key), ['vendor.status']);
  });

  it('the resolver decides the value: a caller asserting `approved` over a resolver reporting `blocked` still fails a policy that requires approved', async () => {
    let observedValue: unknown;
    const result = await buildKernel({
      declaration: { requirements: [{ key: 'vendor.status', minimumTrustClass: 'authoritative', required: true }] },
      observations: [{ key: 'vendor.status', value: 'blocked', sourceId: ERP.id, observedAt: NOW }],
      policyPackProvider: {
        evaluatePolicyForEnforcement(input) {
          const context = input.metadata?.['aoc.context'] as { readonly facts: readonly { readonly key: string; readonly value: unknown }[] } | undefined;
          observedValue = context?.facts.find((fact) => fact.key === 'vendor.status')?.value;
          return observedValue === 'approved'
            ? { type: 'policy_allowed', allowed: true, reasonCode: 'POLICY_ALLOWED', reason: 'vendor is approved' }
            : { type: 'policy_denied', allowed: false, reasonCode: 'VENDOR_NOT_APPROVED', reason: 'the system of record does not say approved' };
        },
      },
    }).evaluate(forgedRequest());

    assert.equal(observedValue, 'blocked', 'policy saw what the source said, not what the caller wrote');
    assert.equal(result.status, 'denied');
  });

  it('a caller cannot promote a trust class: the request source is asserted no matter what the body claims', async () => {
    const REQUEST_SOURCE: ContextSource = { id: 'ctx.src.request', kind: 'request', name: 'The requester', trustClass: 'asserted' };
    const fixture = buildDatasysEnforcementFixture();
    const kernel = new AocKernel({
      recognitionProvider: bridgeRecognitionRuntime(fixture.recognitionRuntime),
      clock: createManualEnforcementClock(NOW),
      idGenerator: createSequentialEnforcementIdGenerator(),
      contextResolution: {
        provider: createInMemoryContextResolver([{ key: 'vendor.status', value: 'approved', sourceId: REQUEST_SOURCE.id, observedAt: NOW }]),
        sources: [ERP, REQUEST_SOURCE],
        declaration: TRUSTED_VENDOR,
      },
    });

    const result = await kernel.evaluate(forgedRequest());

    assert.equal(result.status, 'denied');
    assert.deepEqual(result.reasonCodes, [AOC_KERNEL_REASON_CODES.CONTEXT_REQUIRED_FACT_UNTRUSTED]);
    assert.equal(result.context?.facts[0]?.trustClass, 'asserted');
  });

  it('`action.parameters` is not a second route into the namespace', () => {
    const base = toKernelRequest(buildDraftClosureEmailGuardInput());
    const metadata =
      toGuardActionRequestInput({ ...base, action: { ...base.action, parameters: { 'aoc.context': { facts: [{ key: 'vendor.status', value: 'approved' }] } } } }, undefined).metadata ?? {};

    assert.equal(metadata['aoc.context'], undefined, 'parameters travel under their own key and never become a top-level namespace');
    assert.ok(metadata['parameters'] !== undefined, 'parameters themselves are still passed through unchanged');
  });

  it('the policy metadata bag has exactly one producer: nothing a caller sent appears in it', async () => {
    let keys: readonly string[] = [];
    await buildKernel({
      declaration: TRUSTED_VENDOR,
      observations: [{ key: 'vendor.status', value: 'approved', sourceId: ERP.id, observedAt: NOW }],
      policyPackProvider: {
        evaluatePolicyForEnforcement(input) {
          keys = Object.keys(input.metadata ?? {});
          return { type: 'policy_allowed', allowed: true, reasonCode: 'POLICY_ALLOWED', reason: 'ok' };
        },
      },
    }).evaluate(forgedRequest());

    assert.deepEqual(keys, ['aoc.context'], 'the bag carries resolved namespaces only — no caller key can reach it');
  });
});
