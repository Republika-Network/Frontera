import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildDraftClosureEmailGuardInput } from '../../features/action-enforcement/fixtures/allowed-action.fixture.js';
import { buildSendClientFollowUpGuardInput } from '../../features/action-enforcement/fixtures/approval-required-action.fixture.js';
import { bridgeRecognitionRuntime, buildDatasysEnforcementFixture } from '../../features/action-enforcement/fixtures/datasys-enforcement.fixture.js';
import { buildUnknownAgentReadGuardInput } from '../../features/action-enforcement/fixtures/denied-action.fixture.js';
import { createManualEnforcementClock, createSequentialEnforcementIdGenerator } from '../../features/action-enforcement/runtime/enforcement-runtime-context.js';
import { createInMemoryObligationDischargeProvider, type ObligationDischargeSource } from '../../features/obligation-runtime/index.js';
import { AocKernel, type AocKernelOptions } from '../AocKernel.js';
import type { ExternalAuthorizationInput, ExternalAuthorizationProvider } from '../contracts/ports.js';
import type { KernelEvaluationRequest } from '../contracts/kernel-request.js';
import type { KernelEvaluationResult } from '../contracts/kernel-result.js';
import { KernelConfigurationError } from '../errors/kernel-errors.js';
import { AOC_KERNEL_REASON_CODES } from '../reason-codes/reason-codes.js';
import { assertThrowsInstance } from './assert-helpers.js';
import { NOW, toKernelRequest } from './characterization/support.js';

/**
 * The optional deny-only external authorization port (FRONTERA-SOBE-PILOT-01B).
 *
 * The invariant under test:
 *
 * ```
 * final = Kernel allowed AND external answered exactly { decision: 'allow' } in time
 * ```
 *
 * and nothing else: the port can never rescue a denial, clear an
 * `approval_required`, or add to what the Kernel allowed. Each `describe` maps
 * to one lettered requirement (A–J) of the increment.
 */

/**
 * Generous on purpose. The bound is enforced on elapsed monotonic time, so an
 * answer that is meant to arrive *inside* it needs headroom against CI load;
 * the deadline suite below uses its own short bound with a wide overrun.
 */
const BOUND_MS = 250;

/** A requester-written time far from the Kernel clock's, so a test can tell which one reached the port. */
const REQUESTER_TIME = '2031-06-01T00:00:00.000Z';

interface RecordingProvider extends ExternalAuthorizationProvider {
  readonly calls: ExternalAuthorizationInput[];
}

function recording(answer: (input: ExternalAuthorizationInput) => unknown): RecordingProvider {
  const calls: ExternalAuthorizationInput[] = [];
  return {
    calls,
    authorize(input) {
      calls.push(input);
      return answer(input) as never;
    },
  };
}

const allowing = () => recording(async () => ({ decision: 'allow' }));
const denying = () => recording(async () => ({ decision: 'deny' }));

function buildKernel(extra: Partial<AocKernelOptions> = {}): AocKernel {
  const fixture = buildDatasysEnforcementFixture();
  return new AocKernel({
    recognitionProvider: bridgeRecognitionRuntime(fixture.recognitionRuntime),
    clock: createManualEnforcementClock(NOW),
    idGenerator: createSequentialEnforcementIdGenerator(),
    ...extra,
  });
}

function withPort(provider: ExternalAuthorizationProvider, extra: Partial<AocKernelOptions> = {}): AocKernel {
  return buildKernel({ externalAuthorization: { provider, timeoutMs: BOUND_MS }, ...extra });
}

function allowedRequest(requestId: string): KernelEvaluationRequest {
  return { ...toKernelRequest(buildDraftClosureEmailGuardInput()), requestId, requestedAt: REQUESTER_TIME, organization: { id: 'org-datasys' } };
}

function deniedRequest(requestId: string): KernelEvaluationRequest {
  return { ...toKernelRequest(buildUnknownAgentReadGuardInput()), requestId };
}

function approvalRequest(requestId: string): KernelEvaluationRequest {
  return { ...toKernelRequest(buildSendClientFollowUpGuardInput()), requestId };
}

/** The result with everything this layer adds removed, for comparing against a Kernel with no port. */
function withoutExternalLayer(result: KernelEvaluationResult): KernelEvaluationResult {
  const { externalAuthorization: _ignored, ...rest } = result;
  return { ...rest, trace: { ...rest.trace, steps: rest.trace.steps.filter((step) => step.operator !== 'external_authorization') } };
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('A. port absent: existing behaviour is unchanged', () => {
  it('evaluate() of an allowed action carries no external field and no external trace step', async () => {
    const result = await buildKernel().evaluate(allowedRequest('ext-a-1'));

    assert.equal(result.status, 'allowed');
    assert.equal('externalAuthorization' in result, false);
    assert.equal(result.trace.steps.some((step) => step.operator === 'external_authorization'), false);
  });

  it('enforce() of an allowed action executes exactly once with no external field', async () => {
    let executions = 0;
    const result = await buildKernel().enforce(allowedRequest('ext-a-2'), () => {
      executions += 1;
      return 'sent';
    });

    assert.equal(result.status, 'allowed');
    assert.equal(result.execution.executed, true);
    assert.equal(executions, 1);
    assert.equal('externalAuthorization' in result, false);
  });
});

describe('B. a Kernel DENY stays DENY whatever the external authority says', () => {
  for (const [label, make] of [
    ['allow', allowing],
    ['deny', denying],
  ] as const) {
    it(`evaluate(): Kernel deny + external ${label} -> denied, Kernel reasons, port never asked`, async () => {
      const baseline = await buildKernel().evaluate(deniedRequest('ext-b-eval'));
      const provider = make();
      const result = await withPort(provider).evaluate(deniedRequest('ext-b-eval'));

      assert.equal(result.status, 'denied');
      assert.deepEqual(result.reasonCodes, baseline.reasonCodes);
      assert.equal(result.summary, baseline.summary);
      assert.equal(provider.calls.length, 0, 'evaluate() asks the port only about an allowed outcome');
      assert.deepEqual(result.externalAuthorization, { performed: false, outcome: 'not_consulted', narrowed: false });
    });

    it(`enforce(): Kernel deny + external ${label} -> denied, Kernel reasons, executor never runs`, async () => {
      const baseline = await buildKernel().enforce(deniedRequest('ext-b-enf'), () => 'x');
      let executions = 0;
      const result = await withPort(make()).enforce(deniedRequest('ext-b-enf'), () => {
        executions += 1;
      });

      assert.equal(result.status, 'denied');
      assert.deepEqual(result.reasonCodes, baseline.reasonCodes, 'the denial keeps the reason the Kernel gave');
      assert.equal(result.externalAuthorization?.narrowed, false);
      assert.equal(result.execution.executed, false);
      assert.equal(executions, 0);
    });
  }

  it('an approval_required outcome is never cleared by an external allow, nor rewritten by an external deny', async () => {
    const baseline = await buildKernel().evaluate(approvalRequest('ext-b-approval'));
    assert.equal(baseline.status, 'approval_required');

    for (const make of [allowing, denying]) {
      const evaluated = await withPort(make()).evaluate(approvalRequest('ext-b-approval'));
      assert.equal(evaluated.status, 'approval_required');
      assert.deepEqual(evaluated.reasonCodes, baseline.reasonCodes);

      let executions = 0;
      const enforced = await withPort(make()).enforce(approvalRequest('ext-b-approval'), () => {
        executions += 1;
      });
      assert.equal(enforced.status, 'approval_required');
      assert.deepEqual(enforced.reasonCodes, baseline.reasonCodes);
      assert.equal(enforced.externalAuthorization?.narrowed, false);
      assert.equal(executions, 0);
    }
  });
});

describe('C. Kernel ALLOW + external DENY -> final DENY', () => {
  it('evaluate() narrows to denied, leads with the external code and keeps the Kernel trail', async () => {
    const result = await withPort(denying()).evaluate(allowedRequest('ext-c-1'));

    assert.equal(result.status, 'denied');
    assert.equal(result.reasonCodes[0], AOC_KERNEL_REASON_CODES.EXTERNAL_AUTHORIZATION_DENIED);
    assert.ok(result.reasonCodes.includes(AOC_KERNEL_REASON_CODES.ACTION_ALLOWED), 'the Kernel chain that passed stays visible');
    assert.equal(result.recognition.recognized, true);
    assert.deepEqual(result.externalAuthorization, {
      performed: true,
      outcome: 'denied',
      narrowed: true,
      reasonCode: AOC_KERNEL_REASON_CODES.EXTERNAL_AUTHORIZATION_DENIED,
    });
  });

  it('enforce() never reaches the executor and reports not_executed without an obligation label', async () => {
    let executions = 0;
    const result = await withPort(denying()).enforce(allowedRequest('ext-c-2'), () => {
      executions += 1;
    });

    assert.equal(result.status, 'denied');
    assert.equal(result.reasonCodes[0], AOC_KERNEL_REASON_CODES.EXTERNAL_AUTHORIZATION_DENIED);
    assert.equal(result.execution.executed, false);
    assert.equal(result.execution.status, 'not_executed');
    assert.equal(result.execution.withheldBy, undefined, 'a denial is its own reason');
    assert.equal(executions, 0);
  });
});

describe('D. Kernel ALLOW + external ALLOW keeps eligibility and adds no permission', () => {
  const grants = { declaration: { maximumGrantLifetimeSeconds: 600 } };

  it('evaluate(): identical to the Kernel without a port, apart from the recorded external step', async () => {
    const baseline = await buildKernel({ grants }).evaluate(allowedRequest('ext-d-1'));
    const result = await withPort(allowing(), { grants }).evaluate(allowedRequest('ext-d-1'));

    assert.equal(result.status, 'allowed');
    assert.deepEqual(result.externalAuthorization, { performed: true, outcome: 'allowed', narrowed: false });
    assert.deepEqual(withoutExternalLayer(result), baseline);
    assert.equal(result.grants?.eligibility, 'eligible');
    assert.deepEqual(result.grants, baseline.grants, 'the grant a decision could produce is not widened');
  });

  it('enforce(): executes exactly once, with the same decision and grant evaluation as without a port', async () => {
    let executions = 0;
    const baseline = await buildKernel({ grants }).enforce(allowedRequest('ext-d-2'), () => 'sent');
    const result = await withPort(allowing(), { grants }).enforce(allowedRequest('ext-d-2'), () => {
      executions += 1;
      return 'sent';
    });

    assert.equal(result.status, 'allowed');
    assert.equal(executions, 1);
    assert.deepEqual(result.reasonCodes, baseline.reasonCodes);
    assert.deepEqual(result.grants, baseline.grants);
    assert.deepEqual(result.execution.value, baseline.execution.value);
  });

  it('the port receives a frozen Kernel-built input carrying the Kernel clock, not the requester time', async () => {
    const provider = allowing();
    await withPort(provider).evaluate(allowedRequest('ext-d-3'));

    assert.equal(provider.calls.length, 1);
    const input = provider.calls[0]!;
    assert.equal(Object.isFrozen(input), true);
    assert.equal(input.at, NOW);
    assert.notEqual(input.at, REQUESTER_TIME);
    assert.equal(input.requestId, 'ext-d-3');
    assert.equal(input.organizationId, 'org-datasys');
    assert.equal('context' in input, false, 'no caller-supplied context bag crosses the port');
    assert.deepEqual(Object.keys(input).sort(), ['action', 'actorId', 'at', 'capability', 'organizationId', 'requestId', 'resourceScope', 'signal', 'trustDomainId'].sort());
  });
});

describe('E. provider rejection or throw -> DENY', () => {
  const cases: ReadonlyArray<readonly [string, () => RecordingProvider]> = [
    ['rejects', () => recording(async () => Promise.reject(new Error('secret-bearing upstream message')))],
    ['throws synchronously', () => recording(() => {
      throw new Error('secret-bearing upstream message');
    })],
    ['rejects with a non-Error', () => recording(() => Promise.reject('raw string'))],
  ];

  for (const [label, make] of cases) {
    it(`a provider that ${label} denies, in evaluate() and enforce(), without leaking its message`, async () => {
      const evaluated = await withPort(make()).evaluate(allowedRequest(`ext-e-${label}`));
      assert.equal(evaluated.status, 'denied');
      assert.equal(evaluated.reasonCodes[0], AOC_KERNEL_REASON_CODES.EXTERNAL_AUTHORIZATION_UNAVAILABLE);
      assert.equal(evaluated.externalAuthorization?.outcome, 'unavailable');
      assert.equal(JSON.stringify(evaluated).includes('secret-bearing'), false);

      let executions = 0;
      const enforced = await withPort(make()).enforce(allowedRequest(`ext-e-${label}`), () => {
        executions += 1;
      });
      assert.equal(enforced.status, 'denied');
      assert.equal(enforced.execution.executed, false);
      assert.equal(executions, 0);
    });
  }
});

describe('F. provider timeout -> DENY', () => {
  it('a provider that never settles denies once the bound elapses and has its signal aborted', async () => {
    const provider = recording(() => new Promise(() => {}));
    const started = Date.now();
    const result = await withPort(provider).evaluate(allowedRequest('ext-f-1'));

    assert.equal(result.status, 'denied');
    assert.equal(result.reasonCodes[0], AOC_KERNEL_REASON_CODES.EXTERNAL_AUTHORIZATION_TIMEOUT);
    assert.equal(result.externalAuthorization?.outcome, 'timeout');
    assert.equal(provider.calls[0]!.signal.aborted, true);
    assert.ok(Date.now() - started < 5_000, 'the wait is bounded');
  });

  it('enforce() under a timeout never runs the executor', async () => {
    let executions = 0;
    const result = await withPort(recording(() => new Promise(() => {}))).enforce(allowedRequest('ext-f-2'), () => {
      executions += 1;
    });

    assert.equal(result.status, 'denied');
    assert.equal(result.execution.executed, false);
    assert.equal(executions, 0);
  });

  it('an answer inside the bound does not abort the signal', async () => {
    const provider = allowing();
    await withPort(provider).evaluate(allowedRequest('ext-f-3'));
    assert.equal(provider.calls[0]!.signal.aborted, false);
  });
});

describe('G. a late ALLOW after the timeout cannot change the result', () => {
  const lateAllow = () => recording(() => delay(BOUND_MS * 2).then(() => ({ decision: 'allow' })));
  const lateReject = () => recording(() => delay(BOUND_MS * 2).then(() => Promise.reject(new Error('late'))));

  it('evaluate(): the result is fixed at timeout and stays denied after the late answer lands', async () => {
    const result = await withPort(lateAllow()).evaluate(allowedRequest('ext-g-1'));
    const snapshot = structuredClone(result);
    await delay(BOUND_MS * 4);

    assert.equal(result.status, 'denied');
    assert.equal(result.reasonCodes[0], AOC_KERNEL_REASON_CODES.EXTERNAL_AUTHORIZATION_TIMEOUT);
    assert.deepEqual(result, snapshot, 'nothing mutates the returned result afterwards');
  });

  it('enforce(): the executor never runs, before or after the late allow arrives', async () => {
    let executions = 0;
    const result = await withPort(lateAllow()).enforce(allowedRequest('ext-g-2'), () => {
      executions += 1;
    });
    await delay(BOUND_MS * 4);

    assert.equal(result.status, 'denied');
    assert.equal(result.execution.executed, false);
    assert.equal(executions, 0);
  });

  it('a late rejection after the timeout is consumed, not surfaced as an unhandled rejection', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      const result = await withPort(lateReject()).evaluate(allowedRequest('ext-g-3'));
      await delay(BOUND_MS * 4);
      assert.equal(result.reasonCodes[0], AOC_KERNEL_REASON_CODES.EXTERNAL_AUTHORIZATION_TIMEOUT);
      assert.deepEqual(unhandled, []);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});

describe('H. malformed or unexpected responses -> DENY', () => {
  class AllowLike {
    readonly decision = 'allow';
  }
  const malformed: ReadonlyArray<readonly [string, unknown]> = [
    ['undefined', undefined],
    ['null', null],
    ['a bare string', 'allow'],
    ['a boolean', true],
    ['an array', ['allow']],
    ['an empty object', {}],
    ['a wrong-case decision', { decision: 'ALLOW' }],
    ['an unknown decision', { decision: 'permit' }],
    ['an allow carrying a scope', { decision: 'allow', scope: '*' }],
    ['an allow carrying a grant', { decision: 'allow', grant: { capability: 'admin' } }],
    ['an allow carrying an identity', { decision: 'allow', actorId: 'root' }],
    ['a deny carrying extra fields', { decision: 'deny', reason: 'details' }],
    ['an inherited decision', Object.create({ decision: 'allow' })],
    ['a class instance', new AllowLike()],
    ['an accessor decision', Object.defineProperty({}, 'decision', { get: () => 'allow', enumerable: true })],
    ['a throwing accessor', Object.defineProperty({}, 'decision', { get: () => { throw new Error('boom'); }, enumerable: true })],
    ['a symbol-keyed extra', { decision: 'allow', [Symbol('grant')]: true }],
  ];

  for (const [label, response] of malformed) {
    it(`${label} -> denied with INVALID_RESPONSE`, async () => {
      const result = await withPort(recording(async () => response)).evaluate(allowedRequest(`ext-h-${label}`));

      assert.equal(result.status, 'denied');
      assert.equal(result.reasonCodes[0], AOC_KERNEL_REASON_CODES.EXTERNAL_AUTHORIZATION_INVALID_RESPONSE);
      assert.equal(result.externalAuthorization?.outcome, 'invalid_response');
    });
  }

  it('a synchronous (non-promise) valid answer is accepted; a synchronous malformed one denies', async () => {
    const allowed = await withPort(recording(() => ({ decision: 'allow' }))).evaluate(allowedRequest('ext-h-sync-1'));
    assert.equal(allowed.status, 'allowed');
    const denied = await withPort(recording(() => 'allow')).evaluate(allowedRequest('ext-h-sync-2'));
    assert.equal(denied.status, 'denied');
  });

  it('enforce() never runs the executor on a malformed answer', async () => {
    let executions = 0;
    const result = await withPort(recording(async () => ({ decision: 'allow', scope: '*' }))).enforce(allowedRequest('ext-h-enf'), () => {
      executions += 1;
    });
    assert.equal(result.status, 'denied');
    assert.equal(executions, 0);
  });
});

describe('I. traces and reason codes are accurate, structured and deterministic', () => {
  const expectations = [
    ['allow', () => allowing(), 'allowed', 'passed', undefined],
    ['deny', () => denying(), 'denied', 'failed', AOC_KERNEL_REASON_CODES.EXTERNAL_AUTHORIZATION_DENIED],
    ['reject', () => recording(() => Promise.reject(new Error('x'))), 'unavailable', 'failed', AOC_KERNEL_REASON_CODES.EXTERNAL_AUTHORIZATION_UNAVAILABLE],
    ['timeout', () => recording(() => new Promise(() => {})), 'timeout', 'failed', AOC_KERNEL_REASON_CODES.EXTERNAL_AUTHORIZATION_TIMEOUT],
    ['malformed', () => recording(async () => ({ decision: 'yes' })), 'invalid_response', 'failed', AOC_KERNEL_REASON_CODES.EXTERNAL_AUTHORIZATION_INVALID_RESPONSE],
  ] as const;

  for (const [label, make, outcome, stepStatus, code] of expectations) {
    it(`${label}: one final trace step, in sequence, carrying only the Kernel's own code`, async () => {
      const result = await withPort(make()).evaluate(allowedRequest(`ext-i-${label}`));
      const steps = result.trace.steps;
      const last = steps.at(-1)!;

      assert.equal(steps.filter((step) => step.operator === 'external_authorization').length, 1);
      assert.equal(last.operator, 'external_authorization');
      assert.equal(last.sequence, steps.at(-2)!.sequence + 1);
      assert.equal(last.status, stepStatus);
      assert.deepEqual(last.reasonCodes, code === undefined ? [] : [code]);
      assert.equal(last.startedAt, undefined, 'no timing is recorded');
      assert.equal(last.metadata, undefined, 'no payload is recorded');
      assert.equal(result.externalAuthorization?.outcome, outcome);
      assert.equal(result.externalAuthorization?.reasonCode, code);
    });
  }

  it('the same world evaluated twice produces byte-identical results for every outcome', async () => {
    for (const [label, make] of expectations) {
      const first = await withPort(make()).evaluate(allowedRequest(`ext-i-det-${label}`));
      const second = await withPort(make()).evaluate(allowedRequest(`ext-i-det-${label}`));
      assert.equal(JSON.stringify(first), JSON.stringify(second), label);
    }
  });

  it('a not-consulted step is recorded as skipped with no code', async () => {
    const result = await withPort(allowing()).evaluate(deniedRequest('ext-i-skip'));
    const last = result.trace.steps.at(-1)!;
    assert.equal(last.operator, 'external_authorization');
    assert.equal(last.status, 'skipped');
    assert.deepEqual(last.reasonCodes, []);
  });

  it('every external code is in the authorization vocabulary and none collides with an existing code', () => {
    const external = Object.values(AOC_KERNEL_REASON_CODES).filter((code) => code.startsWith('EXTERNAL_AUTHORIZATION_'));
    assert.deepEqual(external.sort(), [
      'EXTERNAL_AUTHORIZATION_DENIED',
      'EXTERNAL_AUTHORIZATION_INVALID_RESPONSE',
      'EXTERNAL_AUTHORIZATION_TIMEOUT',
      'EXTERNAL_AUTHORIZATION_UNAVAILABLE',
    ]);
    assert.equal(new Set(Object.values(AOC_KERNEL_REASON_CODES)).size, Object.values(AOC_KERNEL_REASON_CODES).length);
  });
});

describe('J. grant and commit-before-execution behaviour are unchanged', () => {
  const grants = { declaration: { maximumGrantLifetimeSeconds: 600 } };

  it('a vetoed authorization reports grant eligibility ineligible, as every denial does', async () => {
    const result = await withPort(denying(), { grants }).evaluate(allowedRequest('ext-j-1'));
    assert.equal(result.status, 'denied');
    assert.equal(result.grants?.eligibility, 'ineligible');
  });

  it('enforce() settles the external answer before the decision is made, and the executor runs after both', async () => {
    const events: string[] = [];
    const provider = recording(async () => {
      events.push('external:asked');
      await delay(1);
      events.push('external:answered');
      return { decision: 'allow' };
    });
    const result = await withPort(provider).enforce(allowedRequest('ext-j-2'), () => {
      events.push('executor');
      return 'sent';
    });

    assert.equal(result.execution.executed, true);
    assert.deepEqual(events, ['external:asked', 'external:answered', 'executor']);
  });

  it('the idempotency commit is unchanged: a second enforce() with the same key is suppressed', async () => {
    const kernel = withPort(allowing());
    const request = { ...allowedRequest('ext-j-3'), idempotencyKey: 'ext-j-3-key' };
    let executions = 0;

    const first = await kernel.enforce(request, () => {
      executions += 1;
    });
    const second = await kernel.enforce({ ...request, requestId: 'ext-j-3b' }, () => {
      executions += 1;
    });

    assert.equal(first.execution.executed, true);
    assert.equal(second.execution.executed, false);
    assert.ok(second.reasonCodes.includes(AOC_KERNEL_REASON_CODES.ACTION_DUPLICATE_SUPPRESSED));
    assert.equal(executions, 1);
  });

  it('an unmet obligation still withholds an allowed decision labelled by the obligation, with the port allowing', async () => {
    const approvals: ObligationDischargeSource = { id: 'obl.src.approval', kind: 'approval_runtime', name: 'Approvals', verificationClass: 'independent' };
    const obligations = {
      provider: createInMemoryObligationDischargeProvider([]),
      sources: [approvals],
      declaration: { requirements: [{ obligationType: 'finance.approval', blocking: true }] },
    };
    let executions = 0;
    const result = await withPort(allowing(), { obligations }).enforce(allowedRequest('ext-j-4'), () => {
      executions += 1;
    });

    assert.equal(result.status, 'allowed');
    assert.equal(result.execution.withheldBy, 'obligation');
    assert.equal(result.externalAuthorization?.outcome, 'allowed');
    assert.equal(executions, 0);
  });
});

describe('K. the bound is enforced on elapsed time, not on the timer alone (PR #217 review, P2)', () => {
  /**
   * A provider that blocks the event loop keeps the timeout timer from firing,
   * so its answer can win the race after the bound has elapsed. These cases
   * block for six times the bound, so they cannot pass by timing luck, and
   * they never assert a sub-millisecond duration. The bound is kept short so
   * the busy-waiting stays small: it occupies a core while other test files
   * run in parallel.
   */
  const DEADLINE_MS = 20;
  const BLOCK_MS = DEADLINE_MS * 6;

  /** Busy-waits on the monotonic clock: the event loop is blocked throughout, as with synchronous work. */
  function block(ms: number): void {
    const end = performance.now() + ms;
    while (performance.now() < end) {
      // deliberately synchronous
    }
  }

  function withDeadline(provider: ExternalAuthorizationProvider, extra: Partial<AocKernelOptions> = {}): AocKernel {
    return buildKernel({ externalAuthorization: { provider, timeoutMs: DEADLINE_MS }, ...extra });
  }

  /** Synchronous provider: blocks, then returns a plain allow. */
  const blockingSync = () => recording(() => {
    block(BLOCK_MS);
    return { decision: 'allow' };
  });
  /** Async provider doing synchronous work before its first await. */
  const blockingAsync = () => recording(async () => {
    block(BLOCK_MS);
    return { decision: 'allow' };
  });
  /** Blocks, then returns an already-resolved promise. */
  const blockingResolved = () => recording(() => {
    block(BLOCK_MS);
    return Promise.resolve({ decision: 'allow' });
  });

  it('A. a synchronously blocking provider that then allows is denied by evaluate() as a timeout', async () => {
    const result = await withDeadline(blockingSync()).evaluate(allowedRequest('ext-k-a'));

    assert.equal(result.status, 'denied');
    assert.equal(result.reasonCodes[0], AOC_KERNEL_REASON_CODES.EXTERNAL_AUTHORIZATION_TIMEOUT);
    assert.deepEqual(result.externalAuthorization, {
      performed: true,
      outcome: 'timeout',
      narrowed: true,
      reasonCode: AOC_KERNEL_REASON_CODES.EXTERNAL_AUTHORIZATION_TIMEOUT,
    });
  });

  it('B. the same provider is denied by enforce() and the executor is never invoked', async () => {
    let executions = 0;
    const result = await withDeadline(blockingSync()).enforce(allowedRequest('ext-k-b'), () => {
      executions += 1;
    });

    assert.equal(result.status, 'denied');
    assert.equal(result.reasonCodes[0], AOC_KERNEL_REASON_CODES.EXTERNAL_AUTHORIZATION_TIMEOUT);
    assert.equal(result.execution.executed, false);
    assert.equal(executions, 0);
  });

  it('C. the provider signal is aborted once the deadline has expired', async () => {
    const provider = blockingSync();
    await withDeadline(provider).evaluate(allowedRequest('ext-k-c'));
    assert.equal(provider.calls[0]!.signal.aborted, true);
  });

  for (const [label, make] of [
    ['D. an async provider blocking before its first await', blockingAsync],
    ['E. a provider returning an already-resolved promise after blocking', blockingResolved],
  ] as const) {
    it(`${label} is a timeout in evaluate() and enforce(), with the signal aborted`, async () => {
      const evaluatedProvider = make();
      const evaluated = await withDeadline(evaluatedProvider).evaluate(allowedRequest(`ext-k-${label[0]}-eval`));
      assert.equal(evaluated.status, 'denied');
      assert.equal(evaluated.externalAuthorization?.outcome, 'timeout');
      assert.equal(evaluatedProvider.calls[0]!.signal.aborted, true);

      let executions = 0;
      const enforced = await withDeadline(make()).enforce(allowedRequest(`ext-k-${label[0]}-enf`), () => {
        executions += 1;
      });
      assert.equal(enforced.status, 'denied');
      assert.equal(enforced.reasonCodes[0], AOC_KERNEL_REASON_CODES.EXTERNAL_AUTHORIZATION_TIMEOUT);
      assert.equal(executions, 0);
    });
  }

  it('F. an allow inside the bound still preserves an allowed Kernel decision, unaborted', async () => {
    const provider = allowing();
    let executions = 0;
    const evaluated = await withPort(provider).evaluate(allowedRequest('ext-k-f'));
    const enforced = await withPort(allowing()).enforce(allowedRequest('ext-k-f2'), () => {
      executions += 1;
    });

    assert.equal(evaluated.status, 'allowed');
    assert.deepEqual(evaluated.externalAuthorization, { performed: true, outcome: 'allowed', narrowed: false });
    assert.equal(provider.calls[0]!.signal.aborted, false);
    assert.equal(enforced.execution.executed, true);
    assert.equal(executions, 1);
  });

  it('G. a Kernel denial is unaltered by an overrunning provider', async () => {
    const baseline = await buildKernel().enforce(deniedRequest('ext-k-g'), () => 'x');
    const evaluateProvider = blockingSync();
    const evaluated = await withDeadline(evaluateProvider).evaluate(deniedRequest('ext-k-g'));
    const enforced = await withDeadline(blockingSync()).enforce(deniedRequest('ext-k-g'), () => 'x');

    assert.equal(evaluated.status, 'denied');
    assert.equal(evaluateProvider.calls.length, 0, 'evaluate() does not consult the port for a denial');
    assert.equal(enforced.status, 'denied');
    assert.deepEqual(enforced.reasonCodes, baseline.reasonCodes);
    assert.equal(enforced.externalAuthorization?.narrowed, false);
  });

  it('H. a delayed asynchronous allow remains a timeout', async () => {
    const provider = recording(() => delay(BLOCK_MS).then(() => ({ decision: 'allow' })));
    const result = await withDeadline(provider).evaluate(allowedRequest('ext-k-h'));
    await delay(BLOCK_MS);

    assert.equal(result.status, 'denied');
    assert.equal(result.externalAuthorization?.outcome, 'timeout');
    assert.equal(provider.calls[0]!.signal.aborted, true);
  });

  it('an overrunning deny or rejection is classified as a timeout, deterministically', async () => {
    const overrunDeny = recording(() => {
      block(BLOCK_MS);
      return { decision: 'deny' };
    });
    const overrunReject = recording(() => {
      block(BLOCK_MS);
      return Promise.reject(new Error('late'));
    });
    for (const provider of [overrunDeny, overrunReject]) {
      const result = await withDeadline(provider).evaluate(allowedRequest('ext-k-det'));
      assert.equal(result.reasonCodes[0], AOC_KERNEL_REASON_CODES.EXTERNAL_AUTHORIZATION_TIMEOUT);
    }
  });

  it('I. blocking rejections and throws leave no unhandled rejection behind', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      const rejecting = recording(() => {
        block(BLOCK_MS);
        return Promise.reject(new Error('blocked then rejected'));
      });
      const throwing = recording(() => {
        block(BLOCK_MS);
        throw new Error('blocked then thrown');
      });
      const delayedReject = recording(() => delay(BLOCK_MS).then(() => Promise.reject(new Error('delayed'))));
      for (const provider of [rejecting, throwing, delayedReject]) {
        const result = await withDeadline(provider).evaluate(allowedRequest('ext-k-i'));
        assert.equal(result.status, 'denied');
      }
      await delay(BLOCK_MS * 2);
      assert.deepEqual(unhandled, []);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});

describe('configuration is validated when the Kernel is wired', () => {
  const provider = allowing();
  const fixture = buildDatasysEnforcementFixture();
  const base = { recognitionProvider: bridgeRecognitionRuntime(fixture.recognitionRuntime) };

  for (const timeoutMs of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 30_001, undefined]) {
    it(`rejects timeoutMs ${String(timeoutMs)}`, () => {
      assertThrowsInstance(() => new AocKernel({ ...base, externalAuthorization: { provider, timeoutMs } as never }), KernelConfigurationError);
    });
  }

  for (const [label, bad] of [
    ['a missing provider', undefined],
    ['a provider without authorize()', {}],
    ['a non-function authorize', { authorize: 'yes' }],
  ] as const) {
    it(`rejects ${label}`, () => {
      assertThrowsInstance(() => new AocKernel({ ...base, externalAuthorization: { provider: bad, timeoutMs: 100 } as never }), KernelConfigurationError);
    });
  }

  it('accepts the maximum bound', () => {
    new AocKernel({ ...base, externalAuthorization: { provider, timeoutMs: 30_000 } });
  });
});
