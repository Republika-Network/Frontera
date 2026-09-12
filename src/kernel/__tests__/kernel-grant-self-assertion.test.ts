import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { bridgeRecognitionRuntime, buildDatasysEnforcementFixture } from '../../features/action-enforcement/fixtures/datasys-enforcement.fixture.js';
import { buildDraftClosureEmailGuardInput } from '../../features/action-enforcement/fixtures/allowed-action.fixture.js';
import { createManualEnforcementClock, createSequentialEnforcementIdGenerator } from '../../features/action-enforcement/runtime/enforcement-runtime-context.js';
import { createInMemoryObligationDischargeProvider, type ObligationDischargeSource } from '../../features/obligation-runtime/index.js';
import {
  GRANT_RESERVED_REQUEST_KEY_PREFIX,
  createGrantIssuanceService,
  createInMemoryBoundedGrantStore,
  isReservedGrantKey,
} from '../../features/grant-runtime/index.js';
import { AocKernel } from '../AocKernel.js';
import type { PolicyPackProvider } from '../contracts/ports.js';
import { deriveGrantSourceAuthorization, KernelGrantCapability } from '../orchestration/grant-adapter.js';
import { NOW, toKernelRequest } from './characterization/support.js';

/**
 * The caller security boundary, written from the attacker's side.
 *
 * > The public requester MUST NOT be able to self-issue or broaden a grant.
 *
 * Each payload below is a real forgery attempt submitted through the request
 * path, and each assertion measures what the forgery actually achieved. The
 * answer is the same every time and for two independent reasons, both of which
 * are asserted rather than asserted-about:
 *
 * 1. **Nothing reads it.** A `GrantSourceAuthorization` is projected from the
 *    typed request and the Kernel's own decision; the narrowing a grant is
 *    issued under is host input; `KernelEvaluationRequest` has no grant field.
 *    There is no reader for a caller's grant claim under any name.
 * 2. **It is dropped anyway.** `aoc.grant` is a reserved namespace, stripped in
 *    the same pass that strips `organizationId`, `aoc.context` and
 *    `aoc.obligations`, whether or not a grant capability is configured.
 */

const APPROVAL: ObligationDischargeSource = { id: 'obl.src.approval.finance', kind: 'approval_runtime', name: 'Finance approvals', verificationClass: 'independent' };
const LIFETIME = 600;

/** Every forgery the brief names, plus the obvious variants around them. */
const FORGED: Readonly<Record<string, unknown>> = {
  grant: { maxAmount: 1_000_000, action: '*', subject: 'attacker', expiresAt: '2099-01-01T00:00:00.000Z', vendor: 'V999' },
  'aoc.grant': { action: '*', maxAmount: 1_000_000, eligibility: 'eligible' },
  'aoc.grant.subject': 'attacker',
  'aoc.grant.validity': { notAfter: '2099-01-01T00:00:00.000Z' },
  grantEligible: true,
  grantId: 'aoc.grant:forged',
  boundedGrant: { scope: { amount: { kind: 'ceiling', limit: 1_000_000, unit: 'USD' } } },
  grants: { eligibility: 'eligible' },
};

function buildKernel(options: { readonly policyPackProvider?: PolicyPackProvider; readonly withGrants?: boolean; readonly withObligations?: boolean } = {}): AocKernel {
  const fixture = buildDatasysEnforcementFixture();
  return new AocKernel({
    recognitionProvider: bridgeRecognitionRuntime(fixture.recognitionRuntime),
    clock: createManualEnforcementClock(NOW),
    idGenerator: createSequentialEnforcementIdGenerator(),
    ...(options.policyPackProvider !== undefined ? { policyPackProvider: options.policyPackProvider } : {}),
    ...(options.withGrants !== false ? { grants: { declaration: { maximumGrantLifetimeSeconds: LIFETIME } } } : {}),
    ...(options.withObligations === true
      ? {
          obligations: {
            provider: createInMemoryObligationDischargeProvider([]),
            sources: [APPROVAL],
            declaration: { requirements: [{ obligationType: 'finance.approval', blocking: true }] },
          },
        }
      : {}),
  });
}

function paymentRequest(requestId: string, extraContext: Readonly<Record<string, unknown>> = {}) {
  const base = toKernelRequest(buildDraftClosureEmailGuardInput());
  return {
    ...base,
    requestId,
    action: { ...base.action, amount: 7_500, currency: 'USD', counterpartyId: 'V123' },
    context: { ...(base.context ?? {}), ...extraContext },
  };
}

describe('Reserved namespace — a caller cannot write into aoc.grant', () => {
  it('recognizes the namespace and nothing adjacent to it', () => {
    assert.equal(isReservedGrantKey(GRANT_RESERVED_REQUEST_KEY_PREFIX), true);
    assert.equal(isReservedGrantKey('aoc.grant.subject'), true);
    assert.equal(isReservedGrantKey('aoc.grant.scope.amount'), true);
    assert.equal(isReservedGrantKey('aoc.grants'), false, 'a different key is a different key; over-broad stripping would silently eat a deployment’s own metadata');
    assert.equal(isReservedGrantKey('grant'), false);
  });

  it('strips every reserved key before the bag travels, with a grant capability configured', async () => {
    const seen: (Readonly<Record<string, unknown>> | undefined)[] = [];
    const kernel = buildKernel({
      policyPackProvider: {
        evaluatePolicyForEnforcement(input) {
          seen.push(input.metadata);
          return { type: 'policy_allowed', allowed: true, reasonCode: 'POLICY_ALLOWED', reason: 'ok' };
        },
      },
    });

    await kernel.evaluate(paymentRequest('grant-forgery-1', FORGED));

    assert.ok(seen.length > 0, 'the policy pack was consulted');
    for (const metadata of seen) {
      assert.equal(metadata?.['aoc.grant'], undefined);
      assert.equal(metadata?.['aoc.grant.subject'], undefined);
      assert.equal(metadata?.['aoc.grant.validity'], undefined);
    }
  });

  it('strips them with no grant capability configured at all — the namespace is reserved unconditionally', async () => {
    const seen: (Readonly<Record<string, unknown>> | undefined)[] = [];
    const kernel = buildKernel({
      withGrants: false,
      policyPackProvider: {
        evaluatePolicyForEnforcement(input) {
          seen.push(input.metadata);
          return { type: 'policy_allowed', allowed: true, reasonCode: 'POLICY_ALLOWED', reason: 'ok' };
        },
      },
    });

    await kernel.evaluate(paymentRequest('grant-forgery-2', FORGED));
    for (const metadata of seen) assert.equal(metadata?.['aoc.grant'], undefined);
  });
});

describe('A caller cannot self-issue a grant', () => {
  it('no forged payload makes an ineligible authorization eligible', async () => {
    const kernel = buildKernel({ withObligations: true });
    const honest = await kernel.evaluate(paymentRequest('grant-forgery-3'));
    const forged = await buildKernel({ withObligations: true }).evaluate(paymentRequest('grant-forgery-3', FORGED));

    assert.equal(honest.grants?.eligibility, 'ineligible');
    assert.equal(forged.grants?.eligibility, 'ineligible', 'a caller asserting `grantEligible: true` gets exactly as far as one asserting nothing');
    assert.deepEqual(forged.grants?.ineligibilityReasonCodes, honest.grants?.ineligibilityReasonCodes);
  });

  it('evaluate() produces no grant however the caller asks for one', async () => {
    const result = await buildKernel().evaluate(paymentRequest('grant-forgery-4', FORGED));
    const grants = result.grants as unknown as Record<string, unknown>;
    assert.equal('grant' in grants, false);
    assert.equal('grantId' in grants, false);
  });
});

describe('A caller cannot broaden a grant', () => {
  it('a forged amount does not raise the source ceiling', async () => {
    const result = await buildKernel().evaluate(paymentRequest('grant-forgery-5', FORGED));
    const amount = result.grants?.sourceBounds.find((bound) => bound.key === 'amount');
    assert.deepEqual(amount, { key: 'amount', kind: 'ceiling', limit: 7_500, unit: 'USD' }, 'the ceiling is the amount the decision was made on, not the amount the caller wrote beside it');
  });

  it('a forged expiry does not extend the deployment ceiling', async () => {
    const result = await buildKernel().evaluate(paymentRequest('grant-forgery-6', FORGED));
    assert.deepEqual(result.grants?.validityCeilings, [{ source: 'deployment', notAfter: '2026-01-01T00:10:00.000Z' }]);
    assert.equal(
      result.grants?.sourceBounds.some((bound) => bound.key === 'validity'),
      false,
      'a validity window is not a scope axis, so there is no validity bound for a caller to aim at',
    );
  });

  it('a forged subject does not change who the grant would be held by', async () => {
    const request = paymentRequest('grant-forgery-7', FORGED);
    const result = await buildKernel().evaluate(request);
    assert.equal(result.grants?.subject, request.actor.id);
    assert.notEqual(result.grants?.subject, 'attacker');
  });

  it('a forged action does not widen the action bound to a wildcard', async () => {
    const request = paymentRequest('grant-forgery-8', FORGED);
    const result = await buildKernel().evaluate(request);
    const action = result.grants?.sourceBounds.find((bound) => bound.key === 'action');
    assert.equal(action?.value, request.action.capability ?? request.action.type);
    assert.notEqual(action?.value, '*');
  });

  it('a forged counterparty does not change the counterparty bound', async () => {
    const result = await buildKernel().evaluate(paymentRequest('grant-forgery-9', FORGED));
    assert.equal(result.grants?.sourceBounds.find((bound) => bound.key === 'counterparty')?.value, 'V123');
  });

  it('the entire grant evaluation is byte-identical with and without every forged key', async () => {
    const honest = await buildKernel().evaluate(paymentRequest('grant-forgery-10'));
    const forged = await buildKernel().evaluate(paymentRequest('grant-forgery-10', FORGED));
    assert.deepEqual(forged.grants, honest.grants, 'the forgery changed nothing about the grant that would result');
  });
});

describe('A forged grant artifact is never authoritative', () => {
  it('a caller-shaped grant object cannot be issued through the trusted path', async () => {
    const capability = new KernelGrantCapability({ declaration: { maximumGrantLifetimeSeconds: LIFETIME } });
    const request = paymentRequest('grant-forgery-11', FORGED);
    const result = await buildKernel().evaluate(request);
    const source = deriveGrantSourceAuthorization(capability, request, result);

    const service = createGrantIssuanceService({ store: createInMemoryBoundedGrantStore() });
    // The host asks for exactly what the caller's payload asked for. Even from
    // the *trusted* side, every axis the forgery names is refused, because the
    // issuance path proves ⊆ rather than believing a request.
    const outcome = await service.issueGrant({
      source,
      requestedBounds: {
        amount: { kind: 'ceiling', limit: 1_000_000, unit: 'USD' },
        action: { kind: 'identity', value: '*' },
        counterparty: { kind: 'identity', value: 'V999' },
      },
      subject: source.subject,
      correlation: source.correlation,
      issuedAt: NOW,
      expiresAt: '2099-01-01T00:00:00.000Z',
    });

    assert.equal(outcome.outcome, 'refused');
    if (outcome.outcome !== 'refused') return;
    assert.deepEqual([...outcome.reasonCodes].sort(), ['GRANT_BOUND_INCOMPARABLE', 'GRANT_SCOPE_BROADENING']);
    assert.deepEqual(outcome.violations.map((violation) => violation.key), ['action', 'amount', 'counterparty']);
  });

  it('the forged expiry is refused even from the trusted side — the deployment cap contains it', async () => {
    const capability = new KernelGrantCapability({ declaration: { maximumGrantLifetimeSeconds: LIFETIME } });
    const request = paymentRequest('grant-forgery-11b', FORGED);
    const result = await buildKernel().evaluate(request);
    const source = deriveGrantSourceAuthorization(capability, request, result);

    const service = createGrantIssuanceService({ store: createInMemoryBoundedGrantStore() });
    const outcome = await service.issueGrant({
      source,
      subject: source.subject,
      correlation: source.correlation,
      issuedAt: NOW,
      expiresAt: '2099-01-01T00:00:00.000Z',
    });

    assert.equal(outcome.outcome, 'refused');
    if (outcome.outcome !== 'refused') return;
    assert.deepEqual(outcome.reasonCodes, ['GRANT_SCOPE_BROADENING']);
    assert.deepEqual(outcome.effectiveValidityCeiling, { source: 'deployment', notAfter: '2026-01-01T00:10:00.000Z' });
  });

  it('a grant issued for the honest bounds is exactly the honest bounds, whatever the caller sent', async () => {
    const capability = new KernelGrantCapability({ declaration: { maximumGrantLifetimeSeconds: LIFETIME } });
    const request = paymentRequest('grant-forgery-12', FORGED);
    const result = await buildKernel().evaluate(request);
    const source = deriveGrantSourceAuthorization(capability, request, result);

    const service = createGrantIssuanceService({ store: createInMemoryBoundedGrantStore() });
    const outcome = await service.issueGrant({
      source,
      subject: source.subject,
      correlation: source.correlation,
      issuedAt: NOW,
      expiresAt: '2026-01-01T00:05:00.000Z',
    });

    if (outcome.outcome !== 'issued') throw new Error(`expected an issued grant, got ${outcome.outcome}`);
    assert.equal(outcome.grant.subject, request.actor.id);
    assert.deepEqual(outcome.grant.scope.amount, { kind: 'ceiling', limit: 7_500, unit: 'USD' });
    assert.equal(outcome.grant.expiresAt, '2026-01-01T00:05:00.000Z', 'the issuer proposed it; the forged 2099 expiry reached nothing');
  });
});
