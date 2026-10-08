import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { exerciseReservationId } from '../../features/exercise-control-runtime/index.js';
import { deriveAuthorityEventStreamId } from '../authority-event-stream/identifiers.js';
import type { AuthorityEvent } from '../authority-event-stream/contracts.js';
import type { GovernanceRecord, GovernanceReferenceRecord } from '../governance-store/contracts.js';
import { authorizationReferenceId, deriveGovernedActionExecutionId, executionAttemptReferenceId, executionOutcomeReferenceId, executionResolutionReferenceId } from '../governed-action/identifiers.js';
import {
  AUDITOR_DISCLOSURE_POLICY_V2,
  EVIDENCE_FIELD_KEYS_V2,
  PUBLIC_DISCLOSURE_POLICY_V2,
  authorityTraceVerificationOf,
  buildAuthorityTrace,
  buildEvidenceBundleV2,
  compareDisclosedTraces,
  discloseAuthorityTrace,
  discloseTraceVerification,
  listDisclosurePolicies,
  listDisclosurePoliciesV2,
  verifyEvidenceBundle,
  type AuthorityTraceSources,
  type EvidenceBundle,
} from '../evidence/index.js';

/**
 * ASSURE-01 — the trace builder, disclosure and v2 bundle verification, over
 * synthetic canonical sources: a consistent world, then one precise corruption
 * at a time. Each corruption must be reported in the right category and never
 * be turned into a successful stage.
 */

const ORG = 'org-unit';
const REQUEST = `aoc.gar:${'a'.repeat(32)}`;
const OTHER_REQUEST = `aoc.gar:${'b'.repeat(32)}`;
const DECISION = 'decision-unit';
const EVALUATION = 'evaluation-unit';
const EXECUTION = deriveGovernedActionExecutionId({ requestId: REQUEST, decisionId: DECISION });
const GRANT = `aoc.grant:${'c'.repeat(32)}`;
const GRANT_DIGEST = `sha256:${'d'.repeat(64)}`;
const AGGREGATE = `sha256:${'e'.repeat(64)}`;
const ATTEMPT_DIGEST = `sha256:${'f'.repeat(64)}`;
const OBSERVATION_DIGEST = `sha256:${'1'.repeat(64)}`;
const BINDING_DIGEST = `sha256:${'2'.repeat(64)}`;
const RESOLUTION_DIGEST = `sha256:${'3'.repeat(64)}`;
const STREAM = deriveAuthorityEventStreamId({ organizationId: ORG, requestId: REQUEST });
const RESERVATION = exerciseReservationId({ boundedGrantId: GRANT, executionId: EXECUTION });
const T = '2026-10-03T00:00:00.000Z';
const ACTOR = 'actor-unit';
const SYSTEM = { system: true } as const;

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

interface World {
  status: string;
  references: GovernanceReferenceRecord[];
  grant: Record<string, unknown> | undefined;
  revocation?: Record<string, unknown>;
  attempt: Record<string, unknown> | undefined;
  terminal: Record<string, unknown> | undefined;
  binding?: Record<string, unknown> | undefined;
  resolution?: Record<string, unknown> | undefined;
  events: Mutable<AuthorityEvent>[];
  streamValid: boolean;
  approvals: Record<string, unknown>[];
  governanceValid: boolean;
  throwOn?: string;
  reservation?: Record<string, unknown> | undefined;
}

const ref = (referenceId: string, referenceType: GovernanceReferenceRecord['referenceType'], externalId: string, extra: Partial<GovernanceReferenceRecord> = {}): GovernanceReferenceRecord => ({
  referenceId,
  evaluationId: EVALUATION,
  referenceType,
  externalId,
  createdAt: T,
  ...extra,
});

function event(sequence: number, eventType: string, references: Record<string, string>, payload: Record<string, unknown>): Mutable<AuthorityEvent> {
  return {
    eventId: `aoc.aev:${sequence}`,
    streamId: STREAM,
    organizationId: ORG,
    occurredAt: T,
    eventType,
    references: { requestId: REQUEST, ...references },
    payload,
    schemaVersion: 'aoc.authority-event.v1',
    sequence,
    recordedAt: T,
    eventDigest: `sha256:${String(sequence).repeat(64).slice(0, 64)}`,
  } as unknown as Mutable<AuthorityEvent>;
}

/** A consistent executed-and-confirmed world. */
function executedWorld(): World {
  return {
    status: 'allowed',
    governanceValid: true,
    references: [
      ref(authorizationReferenceId({ evaluationId: EVALUATION, grantId: GRANT }), 'authorization_artifact', GRANT, { digest: GRANT_DIGEST }),
      ref(executionAttemptReferenceId(EXECUTION), 'execution_record', EXECUTION, { externalVersion: 'attempt' }),
      ref(executionOutcomeReferenceId(EXECUTION), 'execution_record', EXECUTION, { externalVersion: 'executed@adapter-unit', digest: OBSERVATION_DIGEST }),
    ],
    grant: { id: GRANT, correlation: { requestId: REQUEST, decisionId: DECISION, action: 'act', resourceScope: 'res' }, subject: ACTOR, scope: {}, issuedAt: T, expiresAt: T, sourceDigest: 'sha256:s', digest: GRANT_DIGEST },
    attempt: { organizationId: ORG, executionId: EXECUTION, evaluationId: EVALUATION, requestId: REQUEST, decisionId: DECISION, boundedGrantId: GRANT, action: 'act', preparedAt: T, schemaVersion: 'v2', recordedAt: T, attemptDigest: ATTEMPT_DIGEST },
    terminal: { schemaVersion: 'v1', organizationId: ORG, executionId: EXECUTION, attemptDigest: ATTEMPT_DIGEST, observation: { kind: 'provider', certainty: 'confirmed-completed', adapterId: 'adapter-unit', observedAt: T }, recordedAt: T, observationDigest: OBSERVATION_DIGEST },
    events: [
      event(1, 'governance.decision.committed', { evaluationId: EVALUATION, decisionId: DECISION }, { status: 'allowed', reasonCodes: [], evaluatedAt: T, aggregateDigest: AGGREGATE }),
      event(2, 'grant.issued', { decisionId: DECISION, boundedGrantId: GRANT }, { grantDigest: GRANT_DIGEST, expiresAt: T }),
      event(3, 'execution.attempt.claimed', { evaluationId: EVALUATION, decisionId: DECISION, boundedGrantId: GRANT, executionId: EXECUTION }, {}),
      event(4, 'execution.outcome.observed', { evaluationId: EVALUATION, decisionId: DECISION, boundedGrantId: GRANT, executionId: EXECUTION }, { status: 'executed', reasonCodes: [], adapterId: 'adapter-unit', outcomeRecorded: true }),
    ],
    streamValid: true,
    approvals: [],
    reservation: { reservation: { executionId: EXECUTION, boundedGrantId: GRANT }, state: 'settled', terminal: { reason: 'executed' } },
  };
}

/** The same world, unconfirmed at the provider and later resolved by P12. */
function resolvedWorld(): World {
  const world = executedWorld();
  world.terminal = { ...world.terminal, observation: { kind: 'provider', certainty: 'unconfirmed', adapterId: 'adapter-unit', observedAt: T } };
  world.references[2] = ref(executionOutcomeReferenceId(EXECUTION), 'execution_record', EXECUTION, { externalVersion: 'execution-unconfirmed@adapter-unit', digest: OBSERVATION_DIGEST });
  world.references.push(ref(executionResolutionReferenceId(EXECUTION), 'execution_record', EXECUTION, { externalVersion: 'resolved:confirmed-completed', digest: RESOLUTION_DIGEST }));
  (world.events[3] as { payload: Record<string, unknown> }).payload = { status: 'execution-unconfirmed', reasonCodes: [], adapterId: 'adapter-unit', outcomeRecorded: true };
  world.binding = { organizationId: ORG, executionId: EXECUTION, attemptDigest: ATTEMPT_DIGEST, authorityId: 'resolver', origin: 'pre-claim', boundAt: T, recordedAt: T, schemaVersion: 'v1', bindingDigest: BINDING_DIGEST };
  world.resolution = { organizationId: ORG, executionId: EXECUTION, attemptDigest: ATTEMPT_DIGEST, bindingDigest: BINDING_DIGEST, basisObservationDigest: OBSERVATION_DIGEST, authorityId: 'resolver', certainty: 'confirmed-completed', resolvedAt: T, recordedAt: T, schemaVersion: 'v1', resolutionDigest: RESOLUTION_DIGEST };
  world.events.push(event(5, 'execution.outcome.resolved', { evaluationId: EVALUATION, decisionId: DECISION, boundedGrantId: GRANT, executionId: EXECUTION }, { certainty: 'confirmed-completed', authorityId: 'resolver', resolutionDigest: RESOLUTION_DIGEST }));
  return world;
}

/** Read-only sources over a world. Any property beyond the declared reads throws: the builder may not reach for a writer. */
function sources(world: World, options: { readonly composed?: Partial<Record<keyof AuthorityTraceSources, boolean>> } = {}): AuthorityTraceSources {
  const fail = (name: string): void => {
    if (world.throwOn === name) throw Object.assign(new Error('corrupt'), { code: `${name.toUpperCase()}_CORRUPT` });
  };
  const record = (): GovernanceRecord =>
    ({
      request: { requestId: REQUEST, organizationId: ORG, actorId: ACTOR, actionType: 'act', resourceScope: 'res', requestedAt: T, receivedAt: T, payloadDigest: 'sha256:p' },
      evaluation: { evaluationId: EVALUATION, decisionId: DECISION, requestId: REQUEST, status: world.status, summary: world.status, reasonCodes: [], evaluatedAt: T, kernelVersion: 'k', enterpriseVersion: 'e' },
      integrity: { aggregateDigest: AGGREGATE, chainPosition: 7 },
      trace: [],
      events: [],
      metadata: { lifecycleState: 'running', moduleSnapshot: [], schemaVersion: 'aoc.governance-store.schema.v1' },
      references: world.references,
    }) as unknown as GovernanceRecord;
  const all: AuthorityTraceSources = {
    governance: {
      getByRequestId: async (context, requestId) => (requestId === REQUEST && (context.system || context.organizationId === ORG) ? record() : null),
      verify: async () => ({ valid: world.governanceValid, failures: world.governanceValid ? [] : [{ check: 'aggregateDigest', message: 'x' }] }) as never,
    },
    grants: { kind: 'authenticated-durable', read: async () => (fail('grant'), { ...(world.grant !== undefined ? { grant: world.grant as never } : {}), ...(world.revocation !== undefined ? { revocation: world.revocation as never } : {}) }) },
    approvals: { kind: 'durable-authenticated', read: async () => (fail('approval'), world.approvals as never) },
    obligations: { kind: 'durable-authenticated', read: async () => [] },
    reservations: { read: async (id) => (fail('reservation'), id === RESERVATION ? (world.reservation as never) : undefined) },
    outcomes: { read: async () => (fail('outcome'), world.attempt === undefined ? undefined : ({ attempt: world.attempt, ...(world.terminal !== undefined ? { terminal: world.terminal } : {}) } as never)) },
    resolutions: { read: async () => (fail('resolution'), world.binding === undefined && world.resolution === undefined ? undefined : ({ ...(world.binding !== undefined ? { binding: world.binding } : {}), ...(world.resolution !== undefined ? { resolution: world.resolution } : {}) } as never)) },
    events: {
      readStreamBounded: async (_context, streamId, options) => {
        fail('events');
        const held = streamId === STREAM ? world.events : [];
        if (held.length > options.maxEvents) return { outcome: 'exceeds-bound', maxEvents: options.maxEvents, eventCount: held.length };
        const verification = { streamId, valid: world.streamValid, eventCount: held.length, failures: world.streamValid ? [] : ['digest'], ...(held.length > 0 ? { head: { streamId, organizationId: ORG, sequence: held.length, eventDigest: 'sha256:h' } } : {}) };
        return { outcome: 'within-bound', verification, events: world.streamValid ? held : [] } as never;
      },
    },
  };
  const composed = options.composed ?? {};
  const out: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(all)) if (composed[name as keyof AuthorityTraceSources] !== false) out[name] = Object.freeze(value);
  return Object.freeze(out) as unknown as AuthorityTraceSources;
}

async function build(world: World, options: Parameters<typeof sources>[1] = {}) {
  const result = await buildAuthorityTrace(sources(world, options), SYSTEM, REQUEST);
  assert.ok(result !== null);
  return { ...result, verification: authorityTraceVerificationOf(result, T) };
}

const failed = (verification: { checks: readonly { check: string; category: string; status: string }[] }) => verification.checks.filter((entry) => entry.status === 'fail').map((entry) => `${entry.category}:${entry.check}`);

describe('ASSURE-01 trace builder — a consistent world verifies, deterministically', () => {
  it('executed and confirmed: every stage recorded, every check passes, the digest is stable', async () => {
    const first = await build(executedWorld());
    assert.deepEqual(failed(first.verification), []);
    assert.equal(first.verification.verified, true);
    assert.equal(first.trace.finalState, 'executed-confirmed-completed');
    assert.equal(first.trace.stages.reservation.presence, 'recorded');
    assert.equal(first.traceDigest, (await build(executedWorld())).traceDigest, 'same canonical records, same digest');
  });

  it('unconfirmed then resolved: resolution recorded and bound to the observation it resolved', async () => {
    const resolved = await build(resolvedWorld());
    assert.deepEqual(failed(resolved.verification), []);
    assert.equal(resolved.trace.finalState, 'resolved-confirmed-completed');
    assert.equal(resolved.trace.stages.outcome.certainty, 'unconfirmed', 'the initial observation is kept as it was');
  });

  it('unconfirmed with no resolution yet: unresolved — never completed', async () => {
    const world = resolvedWorld();
    world.resolution = undefined;
    world.references.pop();
    world.events.pop();
    const unresolved = await build(world);
    assert.deepEqual(failed(unresolved.verification), []);
    assert.equal(unresolved.trace.stages.resolution.presence, 'unresolved');
    assert.equal(unresolved.trace.finalState, 'executed-unconfirmed');
  });

  it('scope: another organization sees nothing; a malformed id is refused before any read', async () => {
    assert.equal(await buildAuthorityTrace(sources(executedWorld()), { system: false, organizationId: 'org-other' }, REQUEST), null);
    assert.equal(await buildAuthorityTrace(sources(executedWorld()), SYSTEM, OTHER_REQUEST), null);
    for (const bad of ['', 'aoc.gar:short', `aoc.gar:${'A'.repeat(32)}`, `aoc.exec:${'a'.repeat(32)}`, `aoc.gar:${'a'.repeat(32)}\n`]) {
      await assert.rejects(buildAuthorityTrace(sources(executedWorld()), SYSTEM, bad), { code: 'EVIDENCE_VALIDATION_ERROR' }, JSON.stringify(bad));
    }
  });

  it('a request whose event stream exceeds the bound is refused by the store’s bounded read — never truncated', async () => {
    const world = executedWorld();
    for (let index = world.events.length; index < 257; index += 1) world.events.push(event(index + 1, 'exercise.reservation.reserved', { decisionId: DECISION, boundedGrantId: GRANT, executionId: EXECUTION, reservationId: RESERVATION }, {}));
    await assert.rejects(build(world), { code: 'EVIDENCE_TRACE_TOO_LARGE' });
    world.events.length = 256;
    assert.equal((await build(world)).trace.stages.events.events.length, 256, 'at the bound, the whole stream');
  });

  it('bounded: a request whose canonical records exceed the bounds is refused, never truncated', async () => {
    const world = executedWorld();
    for (let index = 0; index < 20; index += 1) world.references.push(ref(`extra-${index}`, 'authorization_artifact', `aoc.grant:${String(index).padStart(32, '0')}`));
    await assert.rejects(build(world), { code: 'EVIDENCE_TRACE_TOO_LARGE' });
  });
});

describe('ASSURE-01 trace builder — wrong joins are correlation failures, and the request becomes "inconsistent"', () => {
  const cases: [string, (world: World) => void, string][] = [
    ['a grant for another request', (world) => { (world.grant as { correlation: Record<string, string> }).correlation = { requestId: OTHER_REQUEST, decisionId: DECISION, action: 'act', resourceScope: 'res' }; }, `correlation:correlation.grant:${GRANT}`],
    ['a grant for another decision', (world) => { (world.grant as { correlation: Record<string, string> }).correlation = { requestId: REQUEST, decisionId: 'decision-other', action: 'act', resourceScope: 'res' }; }, `correlation:correlation.grant:${GRANT}`],
    ['a grant held by another actor', (world) => { (world.grant as Record<string, unknown>)['subject'] = 'actor-other'; }, `correlation:correlation.grant:${GRANT}`],
    ['an attempt for another request', (world) => { (world.attempt as Record<string, unknown>)['requestId'] = OTHER_REQUEST; }, 'correlation:correlation.execution-attempt'],
    ['an attempt naming a grant never authorized for this decision', (world) => { (world.attempt as Record<string, unknown>)['boundedGrantId'] = `aoc.grant:${'9'.repeat(32)}`; }, `correlation:correlation.exercised-grant-authorized:aoc.grant:${'9'.repeat(32)}`],
    ['an observation of another attempt', (world) => { (world.terminal as Record<string, unknown>)['attemptDigest'] = `sha256:${'0'.repeat(64)}`; }, 'correlation:correlation.observation-binds-attempt'],
    ['an event of another request', (world) => { (world.events[2] as unknown as { references: Record<string, string> }).references = { requestId: OTHER_REQUEST }; }, 'correlation:correlation.event:3'],
    ['an event naming another execution', (world) => { (world.events[2] as unknown as { references: Record<string, string> }).references = { requestId: REQUEST, executionId: 'aoc.exec:other' }; }, 'correlation:correlation.event:3'],
    ['a decision event of another aggregate', (world) => { (world.events[0] as { payload: Record<string, unknown> }).payload = { status: 'allowed', reasonCodes: [], evaluatedAt: T, aggregateDigest: 'sha256:other' }; }, 'correlation:correlation.event-decision-payload'],
    ['a grant event with another grant digest', (world) => { (world.events[1] as { payload: Record<string, unknown> }).payload = { grantDigest: 'sha256:forged', expiresAt: T }; }, `correlation:correlation.event-grant-payload:${GRANT}`],
    ['an outcome event contradicting the observation', (world) => { (world.events[3] as { payload: Record<string, unknown> }).payload = { status: 'execution-failed', reasonCodes: [], adapterId: 'adapter-unit', failure: 'PROVIDER_REJECTED', outcomeRecorded: true }; }, 'correlation:correlation.event-outcome-payload'],
    ['a reservation of another execution', (world) => { world.reservation = { reservation: { executionId: 'aoc.exec:other', boundedGrantId: GRANT }, state: 'settled' }; }, 'correlation:correlation.reservation'],
    ['an approval on an allowed decision', (world) => { world.approvals = [{ organizationId: ORG, requestId: REQUEST, decisionId: DECISION, kind: 'approved', subjectDigest: 'sha256:s', recordedBy: 'x', recordedAt: T, sequence: 1, digest: 'sha256:a' }]; }, 'correlation:correlation.approval-only-on-approval-path'],
  ];
  for (const [name, corrupt, expected] of cases) {
    it(name, async () => {
      const world = executedWorld();
      corrupt(world);
      const result = await build(world);
      assert.ok(failed(result.verification).includes(expected), `${expected} in ${JSON.stringify(failed(result.verification))}`);
      assert.equal(result.verification.verified, false);
      assert.equal(result.verification.categories.correlation, 'fail');
      assert.equal(result.trace.finalState, 'inconsistent', 'a wrong join never presents as a clean outcome');
    });
  }

  const resolutionCases: [string, (world: World) => void, string][] = [
    ['a resolution of another attempt', (world) => { (world.resolution as Record<string, unknown>)['attemptDigest'] = `sha256:${'0'.repeat(64)}`; }, 'correlation:correlation.resolution-binds-execution'],
    ['a resolution of another execution', (world) => { (world.resolution as Record<string, unknown>)['executionId'] = 'aoc.exec:other'; }, 'correlation:correlation.resolution-binds-execution'],
    ['a resolution under another binding', (world) => { (world.resolution as Record<string, unknown>)['bindingDigest'] = `sha256:${'0'.repeat(64)}`; }, 'correlation:correlation.resolution-binds-execution'],
    ['a resolution of another observation', (world) => { (world.resolution as Record<string, unknown>)['basisObservationDigest'] = `sha256:${'0'.repeat(64)}`; }, 'correlation:correlation.resolution-basis-observation'],
    ['a binding of another attempt', (world) => { (world.binding as Record<string, unknown>)['attemptDigest'] = `sha256:${'0'.repeat(64)}`; }, 'correlation:correlation.resolution-binding-attempt'],
    ['a resolved event naming another resolution', (world) => { (world.events[4] as { payload: Record<string, unknown> }).payload = { certainty: 'confirmed-completed', authorityId: 'resolver', resolutionDigest: 'sha256:other' }; }, 'correlation:correlation.event-resolution-payload'],
    [
      'a resolution of an outcome that was already confirmed',
      (world) => {
        world.terminal = { ...world.terminal, observation: { kind: 'provider', certainty: 'confirmed-completed', adapterId: 'adapter-unit', observedAt: T } };
        (world.events[3] as { payload: Record<string, unknown> }).payload = { status: 'executed', reasonCodes: [], adapterId: 'adapter-unit', outcomeRecorded: true };
      },
      'correlation:correlation.resolution-only-when-uncertain',
    ],
  ];
  for (const [name, corrupt, expected] of resolutionCases) {
    it(name, async () => {
      const world = resolvedWorld();
      corrupt(world);
      const result = await build(world);
      assert.ok(failed(result.verification).includes(expected), `${expected} in ${JSON.stringify(failed(result.verification))}`);
      assert.equal(result.trace.finalState, 'inconsistent');
    });
  }

  it('a denial with a fabricated grant or execution is refused as a correlation failure — never a grant on a denial', async () => {
    const world = executedWorld();
    world.status = 'denied';
    const result = await build(world);
    assert.ok(failed(result.verification).includes('correlation:correlation.no-authority-on-non-executable-decision'));
    assert.equal(result.trace.executionId, undefined);
    assert.equal(result.trace.stages.authority.presence, 'not-applicable');
    assert.equal(result.trace.finalState, 'inconsistent');
  });
});

describe('ASSURE-01 trace builder — "missing unexpectedly" is never "not applicable"', () => {
  it('a referenced grant that is gone', async () => {
    const world = executedWorld();
    world.grant = undefined;
    const result = await build(world);
    assert.equal(result.trace.stages.authority.presence, 'missing');
    assert.ok(failed(result.verification).includes(`completeness:completeness.grant:${GRANT}`));
  });

  it('a claimed execution whose P11 attempt is gone', async () => {
    const world = executedWorld();
    world.attempt = undefined;
    world.terminal = undefined;
    const result = await build(world);
    assert.equal(result.trace.stages.execution.attempt?.presence, 'missing');
    assert.ok(failed(result.verification).includes('completeness:completeness.execution-attempt'));
  });

  it('a recorded outcome summary whose canonical observation is gone', async () => {
    const world = executedWorld();
    world.terminal = undefined;
    const result = await build(world);
    assert.equal(result.trace.stages.outcome.presence, 'missing');
    assert.ok(failed(result.verification).includes('completeness:completeness.execution-outcome'));
    assert.notEqual(result.trace.finalState, 'executed-confirmed-completed');
  });

  it('a recorded resolution summary whose P12 record is gone', async () => {
    const world = resolvedWorld();
    world.resolution = undefined;
    world.events.pop();
    const result = await build(world);
    assert.equal(result.trace.stages.resolution.presence, 'missing');
    assert.ok(failed(result.verification).includes('completeness:completeness.execution-resolution'));
    assert.equal(result.trace.finalState, 'executed-unconfirmed', 'never resolved by a summary alone');
  });

  it('a recorded resolution the deployment cannot read because P12 is not composed', async () => {
    const result = await build(resolvedWorld(), { composed: { resolutions: false } });
    assert.equal(result.trace.stages.resolution.presence, 'not-composed');
    assert.ok(failed(result.verification).includes('completeness:completeness.execution-resolution'));
  });

  it('an event-stream anchor that is absent: incomplete evidence, not a fact that did not occur', async () => {
    const world = executedWorld();
    world.events.splice(3, 1);
    const result = await build(world);
    assert.ok(failed(result.verification).includes('completeness:completeness.event:execution.outcome.observed'));
    assert.equal(result.trace.stages.outcome.presence, 'recorded', 'the canonical observation still stands');
  });

  it('a claim event with no ledger claim is a fabricated fact', async () => {
    const world = executedWorld();
    world.references = world.references.filter((entry) => entry.externalVersion !== 'attempt' && entry.externalVersion === undefined);
    world.terminal = undefined;
    const result = await build(world);
    assert.ok(failed(result.verification).includes('correlation:correlation.event-claim-without-ledger-claim'));
  });

  it('a grant issued on an approval path with no approval verdict', async () => {
    const world = executedWorld();
    world.status = 'approval_required';
    world.approvals = [{ organizationId: ORG, requestId: REQUEST, decisionId: DECISION, kind: 'requested', subjectDigest: 'sha256:s', recordedBy: 'x', recordedAt: T, sequence: 1, digest: 'sha256:a' }];
    (world.events[0] as { payload: Record<string, unknown> }).payload = { status: 'approval_required', reasonCodes: [], evaluatedAt: T, aggregateDigest: AGGREGATE };
    const result = await build(world);
    assert.ok(failed(result.verification).includes('completeness:completeness.approval-before-authority'));
  });
});

describe('ASSURE-01 trace builder — store integrity failures are reported, never hidden', () => {
  for (const [source, check] of [
    ['grant', `authenticity:authenticity.grant-signature:${GRANT}`],
    ['outcome', 'integrity:integrity.execution-outcome'],
    ['resolution', 'integrity:integrity.execution-resolution'],
    ['approval', 'integrity:integrity.approval-log'],
    ['reservation', 'integrity:integrity.reservation'],
    ['events', 'integrity:integrity.event-stream'],
  ] as const) {
    it(`an unreadable ${source} store`, async () => {
      const world = source === 'resolution' ? resolvedWorld() : executedWorld();
      world.throwOn = source;
      const result = await build(world);
      assert.ok(failed(result.verification).includes(check), JSON.stringify(failed(result.verification)));
      assert.equal(result.verification.verified, false);
      assert.equal(JSON.stringify(result.trace).includes('corrupt'), false, 'only the closed code is reported, never the store message');
    });
  }

  it('a Governance Record that fails its own verification, and an event stream that fails its chain', async () => {
    const world = executedWorld();
    world.governanceValid = false;
    world.streamValid = false;
    const result = await build(world);
    assert.ok(failed(result.verification).includes('integrity:integrity.governance-record'));
    assert.ok(failed(result.verification).includes('integrity:integrity.event-stream'));
    assert.equal(result.trace.stages.events.presence, 'unreadable');
  });

  it('a grant digest that differs from what the Governance Store referenced', async () => {
    const world = executedWorld();
    (world.grant as Record<string, unknown>)['digest'] = 'sha256:substituted';
    const result = await build(world);
    assert.ok(failed(result.verification).includes(`integrity:integrity.grant-reference-digest:${GRANT}`));
  });

  it('an observation digest that differs from the Governance outcome summary', async () => {
    const world = executedWorld();
    (world.terminal as Record<string, unknown>)['observationDigest'] = 'sha256:substituted';
    const result = await build(world);
    assert.ok(failed(result.verification).includes('integrity:integrity.outcome-summary-digest'));
  });
});

describe('ASSURE-01 disclosure — v2 policies, projection and comparison', () => {
  it('every v2 policy partitions the v2 vocabulary; the v1 policies are untouched', () => {
    for (const policy of listDisclosurePoliciesV2()) {
      assert.deepEqual([...policy.visibleFields, ...policy.hiddenFields].sort(), [...EVIDENCE_FIELD_KEYS_V2].sort(), policy.policyId);
      assert.match(policy.policyId, /\.v2$/);
    }
    assert.deepEqual(
      listDisclosurePolicies().map((policy) => [policy.policyId, policy.version, policy.visibleFields.length + policy.hiddenFields.length]),
      [
        ['evidence.disclosure.full.v1', '1.0.0', 10],
        ['evidence.disclosure.auditor.v1', '1.0.0', 10],
        ['evidence.disclosure.partner.v1', '1.0.0', 10],
        ['evidence.disclosure.customer.v1', '1.0.0', 10],
        ['evidence.disclosure.public.v1', '1.0.0', 10],
      ],
    );
  });

  it('a hidden stage is absent and the organization follows its own field', async () => {
    const { trace } = await build(executedWorld());
    const pub = discloseAuthorityTrace(trace, PUBLIC_DISCLOSURE_POLICY_V2);
    assert.deepEqual(Object.keys(pub.stages), []);
    assert.equal(pub.organizationId, undefined);
    const auditor = discloseAuthorityTrace(trace, AUDITOR_DISCLOSURE_POLICY_V2);
    assert.equal(auditor.organizationId, ORG);
    assert.equal(Object.keys(auditor.stages).length, 11);
  });

  it('progression is recognized; a changed recorded fact, or an illegal final-state move, is a contradiction — at every level, PUBLIC included', async () => {
    const unresolvedWorld = resolvedWorld();
    unresolvedWorld.resolution = undefined;
    unresolvedWorld.references.pop();
    unresolvedWorld.events.pop();
    const before = (await build(unresolvedWorld)).trace;
    const after = (await build(resolvedWorld())).trace;
    for (const policy of [AUDITOR_DISCLOSURE_POLICY_V2, PUBLIC_DISCLOSURE_POLICY_V2]) {
      assert.equal(compareDisclosedTraces(discloseAuthorityTrace(before, policy), discloseAuthorityTrace(after, policy)).result, 'progressed', policy.policyId);
      assert.equal(compareDisclosedTraces(discloseAuthorityTrace(after, policy), discloseAuthorityTrace(after, policy)).result, 'matches');
      // Backwards is never progress.
      assert.equal(compareDisclosedTraces(discloseAuthorityTrace(after, policy), discloseAuthorityTrace(before, policy)).result, 'contradicted', `${policy.policyId}: a resolved request does not become unresolved`);
    }
    // A recorded fact that changes while the final state does not is still a contradiction.
    const regrantedWorld = executedWorld();
    (regrantedWorld.grant as Record<string, unknown>)['expiresAt'] = '2026-10-04T00:00:00.000Z';
    const regranted = (await build(regrantedWorld)).trace;
    const original = (await build(executedWorld())).trace;
    assert.equal(regranted.finalState, original.finalState);
    const regrantComparison = compareDisclosedTraces(discloseAuthorityTrace(original, AUDITOR_DISCLOSURE_POLICY_V2), discloseAuthorityTrace(regranted, AUDITOR_DISCLOSURE_POLICY_V2));
    assert.equal(regrantComparison.result, 'contradicted');
    assert.equal(regrantComparison.stages.authority, 'contradicted');
    const failedWorld = executedWorld();
    failedWorld.terminal = { ...failedWorld.terminal, observation: { kind: 'provider', certainty: 'confirmed-not-completed', adapterId: 'adapter-unit', failure: 'PROVIDER_REJECTED', observedAt: T } };
    (failedWorld.events[3] as { payload: Record<string, unknown> }).payload = { status: 'execution-failed', reasonCodes: [], adapterId: 'adapter-unit', failure: 'PROVIDER_REJECTED', outcomeRecorded: true };
    const confirmed = (await build(executedWorld())).trace;
    const contradicted = (await build(failedWorld)).trace;
    for (const policy of [AUDITOR_DISCLOSURE_POLICY_V2, PUBLIC_DISCLOSURE_POLICY_V2]) {
      assert.equal(compareDisclosedTraces(discloseAuthorityTrace(confirmed, policy), discloseAuthorityTrace(contradicted, policy)).result, 'contradicted', `${policy.policyId}: completed never becomes not-completed`);
    }
  });
});

describe('ASSURE-01 bundles — v2 verification, and historical v1 bundles unchanged', () => {
  const historical = JSON.parse(readFileSync('src/enterprise/__tests__/fixtures/pre-assure-01/v1-bundles.json', 'utf8')) as { record: GovernanceRecord; bundles: Record<string, EvidenceBundle> };

  it('every v1 bundle built by the pre-ASSURE-01 code still verifies, byte for byte, with no migration', () => {
    for (const [level, bundle] of Object.entries(historical.bundles)) {
      const result = verifyEvidenceBundle(bundle, { record: historical.record, now: () => T });
      assert.equal(result.valid, true, `${level}: ${JSON.stringify(result.failures)}`);
      assert.equal(result.freshness, undefined, 'v1 verification is what it always was');
      assert.equal(bundle.bundleVersion, 'evidence.bundle.v1');
    }
  });

  it('a trace attached to a v1 bundle is refused: v1 digests do not cover it', () => {
    const bundle = { ...historical.bundles['AUDITOR'], trace: { traceVersion: 'x' } } as unknown as EvidenceBundle;
    const result = verifyEvidenceBundle(bundle, { record: historical.record, now: () => T });
    assert.equal(result.valid, false);
    assert.equal(result.checks.versionSupported, false);
  });

  async function v2(): Promise<{ bundle: EvidenceBundle; current: { disclosed: ReturnType<typeof discloseAuthorityTrace>; verification: ReturnType<typeof authorityTraceVerificationOf> }; record: GovernanceRecord }> {
    const built = await build(executedWorld());
    const record = built.record;
    const bundle = buildEvidenceBundleV2(record, built.trace, AUDITOR_DISCLOSURE_POLICY_V2, { now: () => T, nextId: () => 'evidence-bundle-unit' });
    return { bundle, current: { disclosed: discloseAuthorityTrace(built.trace, AUDITOR_DISCLOSURE_POLICY_V2), verification: built.verification }, record };
  }

  it('a v2 bundle verifies against its canonical trace, current', async () => {
    const { bundle, current, record } = await v2();
    const result = verifyEvidenceBundle(bundle, { record, now: () => T, currentTrace: current });
    assert.equal(result.valid, true, JSON.stringify(result.failures));
    assert.equal(result.freshness, 'current');
  });

  it('tampering with the carried trace, the policy, a hidden stage or the binding is detected; an unbuildable source trace never verifies', async () => {
    const { bundle, current, record } = await v2();
    const tamperedTrace = { ...bundle, trace: { ...bundle.trace, summary: { ...(bundle.trace?.summary as object), finalState: 'denied' } } } as EvidenceBundle;
    assert.equal(verifyEvidenceBundle(tamperedTrace, { record, now: () => T, currentTrace: current }).checks.traceDigest, false);
    const resealedOnlyBundle = { ...bundle, integrity: { ...bundle.integrity, traceDigest: 'sha256:other' } } as EvidenceBundle;
    assert.equal(verifyEvidenceBundle(resealedOnlyBundle, { record, now: () => T, currentTrace: current }).valid, false);
    const noSource = verifyEvidenceBundle(bundle, { record, now: () => T });
    assert.equal(noSource.valid, false, 'without its canonical sources a v2 bundle is not verified');
    assert.equal(noSource.freshness, 'unknown');
    const publicPolicy = buildEvidenceBundleV2(record, (await build(executedWorld())).trace, PUBLIC_DISCLOSURE_POLICY_V2, { now: () => T, nextId: () => 'evidence-bundle-public' });
    const leaked = { ...publicPolicy, trace: { ...publicPolicy.trace, stages: { request: { actorId: ACTOR } } } } as unknown as EvidenceBundle;
    const leakedResult = verifyEvidenceBundle(leaked, { record, now: () => T });
    assert.equal(leakedResult.checks.policyMatch, false, 'a hidden stage that reappears is a disclosure breach');
    const contradicted = { disclosed: { ...current.disclosed, stages: { ...current.disclosed.stages, decision: { presence: 'recorded', status: 'denied' } } }, verification: current.verification };
    assert.equal(verifyEvidenceBundle(bundle, { record, now: () => T, currentTrace: contradicted }).checks.traceConsistent, false);
  });
});

describe('ASSURE-01 review hardening — a recorded fact never passes as progress; history is read as it was written', () => {
  const PARTNER = listDisclosurePoliciesV2().find((policy) => policy.level === 'PARTNER');
  assert.ok(PARTNER !== undefined);
  const levels = [AUDITOR_DISCLOSURE_POLICY_V2, PARTNER];

  function unresolvedWorld(): World {
    const world = resolvedWorld();
    world.resolution = undefined;
    world.references.pop();
    world.events.pop();
    return world;
  }

  it('an unresolved execution whose binding is later replaced is contradicted, not progressed', async () => {
    const before = (await build(unresolvedWorld())).trace;
    const rebound = resolvedWorld();
    (rebound.binding as Record<string, unknown>)['authorityId'] = 'resolver-other';
    (rebound.binding as Record<string, unknown>)['bindingDigest'] = `sha256:${'7'.repeat(64)}`;
    (rebound.resolution as Record<string, unknown>)['bindingDigest'] = `sha256:${'7'.repeat(64)}`;
    const after = (await build(rebound)).trace;
    for (const policy of levels) {
      const comparison = compareDisclosedTraces(discloseAuthorityTrace(before, policy), discloseAuthorityTrace(after, policy));
      assert.equal(comparison.result, 'contradicted', policy.policyId);
      assert.equal(comparison.stages.resolution, 'contradicted', policy.policyId);
    }
  });

  it('a prepared attempt whose digest changes before its claim is contradicted, not progressed', async () => {
    const prepared = executedWorld();
    prepared.references = prepared.references.filter((entry) => entry.referenceType === 'authorization_artifact');
    prepared.terminal = undefined;
    prepared.events = prepared.events.slice(0, 2);
    prepared.reservation = undefined;
    const before = (await build(prepared)).trace;
    assert.equal(before.stages.execution.presence, 'not-reached');
    assert.equal(before.stages.execution.attempt?.presence, 'recorded');
    const swapped = executedWorld();
    (swapped.attempt as Record<string, unknown>)['attemptDigest'] = `sha256:${'8'.repeat(64)}`;
    (swapped.terminal as Record<string, unknown>)['attemptDigest'] = `sha256:${'8'.repeat(64)}`;
    const after = (await build(swapped)).trace;
    for (const policy of levels) assert.equal(compareDisclosedTraces(discloseAuthorityTrace(before, policy), discloseAuthorityTrace(after, policy)).stages.execution, 'contradicted', policy.policyId);
    // The same request with its attempt unchanged did progress.
    const claimed = (await build(executedWorld())).trace;
    for (const policy of levels) assert.equal(compareDisclosedTraces(discloseAuthorityTrace(before, policy), discloseAuthorityTrace(claimed, policy)).result, 'progressed', policy.policyId);
  });

  it('the in-flight window (claimed, observation not yet recorded) and a lagging event stream move on as progress', async () => {
    const inFlight = executedWorld();
    inFlight.terminal = undefined;
    inFlight.references = inFlight.references.filter((entry) => entry.externalVersion !== 'executed@adapter-unit');
    inFlight.events = [];
    const before = (await build(inFlight)).trace;
    assert.equal(before.finalState, 'claimed-outcome-unrecorded');
    assert.equal(before.stages.events.presence, 'missing');
    const after = (await build(executedWorld())).trace;
    for (const policy of [...levels, PUBLIC_DISCLOSURE_POLICY_V2]) assert.equal(compareDisclosedTraces(discloseAuthorityTrace(before, policy), discloseAuthorityTrace(after, policy)).result, 'progressed', policy.policyId);
  });

  it('an execution answered before P11 existed is shown as its Governance summary — never as unanswered, never eligible for resolution', async () => {
    const legacy = executedWorld();
    legacy.attempt = undefined;
    legacy.terminal = undefined;
    legacy.reservation = undefined;
    legacy.references[2] = ref(executionOutcomeReferenceId(EXECUTION), 'execution_record', EXECUTION, { externalVersion: 'withheld:grant-exercise:GRANT_EXPIRED' });
    legacy.events = legacy.events.slice(0, 3);
    const result = await build(legacy);
    assert.deepEqual(failed(result.verification), []);
    assert.equal(result.trace.stages.outcome.presence, 'recorded');
    assert.equal(result.trace.stages.outcome.legacy, true);
    assert.equal(result.trace.stages.outcome.governanceSummary, 'withheld:grant-exercise:GRANT_EXPIRED');
    assert.equal(result.trace.finalState, 'withheld-at-exercise');
    assert.equal(result.trace.stages.resolution.presence, 'not-applicable');
    assert.equal(result.trace.stages.execution.attempt?.presence, 'none-recorded');
  });

  it('event payloads are compared field by field: withholding layer, failure, revocation reason and reservation reason', async () => {
    const withheld = executedWorld();
    withheld.terminal = { ...withheld.terminal, observation: { kind: 'withheld', withheldBy: 'exercise-control', reasonCodes: ['LIMIT'], observedAt: T } };
    withheld.references[2] = ref(executionOutcomeReferenceId(EXECUTION), 'execution_record', EXECUTION, { externalVersion: 'withheld:exercise-control:LIMIT', digest: OBSERVATION_DIGEST });
    (withheld.events[3] as { payload: Record<string, unknown> }).payload = { status: 'withheld', withheldBy: 'emergency-control', reasonCodes: ['LIMIT'], outcomeRecorded: true };
    assert.ok(failed((await build(withheld)).verification).includes('correlation:correlation.event-outcome-payload'));

    const revoked = executedWorld();
    revoked.revocation = { grantId: GRANT, revokedAt: T, reason: 'security-incident', issuerRef: 'operator:x' };
    revoked.events.push(event(5, 'grant.revoked', { decisionId: DECISION, boundedGrantId: GRANT }, { reason: 'policy-changed' }));
    assert.ok(failed((await build(revoked)).verification).includes(`correlation:correlation.event-revocation-payload:${GRANT}`));

    const settled = executedWorld();
    settled.events.push(event(5, 'exercise.reservation.settled', { decisionId: DECISION, boundedGrantId: GRANT, executionId: EXECUTION, reservationId: RESERVATION }, { reason: 'execution-unconfirmed' }));
    assert.ok(failed((await build(settled)).verification).includes('correlation:correlation.event-reservation-payload'));
  });

  it('a degraded store never yields a reassuring final state', async () => {
    const approvalUnreadable = executedWorld();
    approvalUnreadable.status = 'approval_required';
    approvalUnreadable.throwOn = 'approval';
    (approvalUnreadable.events[0] as { payload: Record<string, unknown> }).payload = { status: 'approval_required', reasonCodes: [], evaluatedAt: T, aggregateDigest: AGGREGATE };
    assert.equal((await build(approvalUnreadable)).trace.finalState, 'unverifiable');

    const outcomeUnreadable = resolvedWorld();
    outcomeUnreadable.throwOn = 'outcome';
    const unreadable = await build(outcomeUnreadable);
    assert.equal(unreadable.trace.finalState, 'unverifiable');
    assert.equal(unreadable.verification.checks.some((entry) => entry.detail === 'resolution-of-a-confirmed-outcome'), false, 'an unreadable observation is not reported as a confirmed one');

    const claimNoGrant = executedWorld();
    claimNoGrant.references = claimNoGrant.references.filter((entry) => entry.referenceType !== 'authorization_artifact');
    claimNoGrant.attempt = undefined;
    claimNoGrant.terminal = undefined;
    const ungranted = await build(claimNoGrant, { composed: { outcomes: false } });
    assert.equal(ungranted.trace.stages.authority.presence, 'missing');
    assert.ok(failed(ungranted.verification).includes('completeness:completeness.grant-for-claim'));
  });

  it('below AUDITOR, a verification discloses no identity, detail or canonical digest', async () => {
    const world = executedWorld();
    world.grant = undefined;
    const verification = (await build(world)).verification;
    const customer = listDisclosurePoliciesV2().find((policy) => policy.level === 'CUSTOMER');
    assert.ok(customer !== undefined);
    const disclosed = discloseTraceVerification(verification, customer);
    assert.equal(disclosed.traceDigest, undefined);
    assert.equal(JSON.stringify(disclosed).includes(GRANT), false);
    assert.ok(disclosed.checks.some((entry) => entry.check === 'completeness.grant'));
    assert.ok(disclosed.checks.every((entry) => entry.status === 'fail' && entry.detail === undefined && !entry.check.includes(':')));
    assert.equal(disclosed.verified, false);
    assert.equal(discloseTraceVerification(verification, AUDITOR_DISCLOSURE_POLICY_V2), verification, 'AUDITOR sees every check');
  });
});

describe('ASSURE-01 second review — read order, degraded stores, summaries and history', () => {
  it('the event stream is read before every canonical store, and the Governance Record is re-read after it', async () => {
    const order: string[] = [];
    const base = sources(executedWorld());
    const recorded = Object.fromEntries(
      Object.entries(base).map(([name, source]) => [
        name,
        Object.fromEntries(
          Object.entries(source as Record<string, unknown>).map(([method, value]) => [
            method,
            typeof value === 'function' ? (...args: unknown[]) => (order.push(`${name}.${method}`), (value as (...inner: unknown[]) => unknown)(...args)) : value,
          ]),
        ),
      ]),
    ) as unknown as AuthorityTraceSources;
    assert.ok((await buildAuthorityTrace(recorded, SYSTEM, REQUEST)) !== null);
    const firstCanonical = order.findIndex((entry) => !entry.startsWith('events.') && entry !== 'governance.getByRequestId');
    assert.ok(order.indexOf('events.readStreamBounded') >= 0 && order.indexOf('events.readStreamBounded') < firstCanonical, order.join(' '));
    assert.equal(order.filter((entry) => entry === 'governance.getByRequestId').length, 2, 'located, then re-read after the stream');
    assert.ok(order.lastIndexOf('governance.getByRequestId') > order.indexOf('events.readStreamBounded'));
  });

  it('a fact committed after the stream was read is incomplete evidence, never a sealed contradiction', async () => {
    const lagging = executedWorld();
    lagging.events = lagging.events.slice(0, 3);
    const result = await build(lagging);
    assert.equal(result.trace.finalState, 'executed-confirmed-completed');
    assert.deepEqual(failed(result.verification), ['completeness:completeness.event:execution.outcome.observed']);
    const later = (await build(executedWorld())).trace;
    assert.equal(compareDisclosedTraces(discloseAuthorityTrace(result.trace, AUDITOR_DISCLOSURE_POLICY_V2), discloseAuthorityTrace(later, AUDITOR_DISCLOSURE_POLICY_V2)).result, 'progressed');
  });

  it('unverifiable is scoped to the observed path, includes a failed Governance Record, and is never reported as a contradiction', async () => {
    const denied = executedWorld();
    denied.status = 'denied';
    denied.references = [];
    denied.attempt = undefined;
    denied.terminal = undefined;
    denied.grant = undefined;
    denied.events = denied.events.slice(0, 1);
    (denied.events[0] as { payload: Record<string, unknown> }).payload = { status: 'denied', reasonCodes: [], evaluatedAt: T, aggregateDigest: AGGREGATE };
    denied.throwOn = 'approval';
    assert.equal((await build(denied)).trace.finalState, 'denied', 'an unreadable approval log says nothing about a denial');
    const tampered = executedWorld();
    tampered.governanceValid = false;
    const unverifiable = await build(tampered);
    assert.equal(unverifiable.trace.finalState, 'unverifiable');
    const sealed = (await build(executedWorld())).trace;
    for (const policy of [AUDITOR_DISCLOSURE_POLICY_V2, PUBLIC_DISCLOSURE_POLICY_V2]) {
      assert.equal(compareDisclosedTraces(discloseAuthorityTrace(sealed, policy), discloseAuthorityTrace(unverifiable.trace, policy)).result, 'unverifiable', policy.policyId);
    }
  });

  it('a Governance summary must state what the canonical record states', async () => {
    const outcome = executedWorld();
    outcome.references[2] = ref(executionOutcomeReferenceId(EXECUTION), 'execution_record', EXECUTION, { externalVersion: 'withheld:grant-exercise:GRANT_EXPIRED', digest: OBSERVATION_DIGEST });
    assert.ok(failed((await build(outcome)).verification).includes('correlation:correlation.outcome-summary-text'));
    const resolution = resolvedWorld();
    resolution.references[3] = ref(executionResolutionReferenceId(EXECUTION), 'execution_record', EXECUTION, { externalVersion: 'resolved:confirmed-not-completed:PROVIDER_REJECTED', digest: RESOLUTION_DIGEST });
    assert.ok(failed((await build(resolution)).verification).includes('correlation:correlation.resolution-summary-text'));
    const orphan = executedWorld();
    orphan.references.push(ref(executionResolutionReferenceId(EXECUTION), 'execution_record', EXECUTION, { externalVersion: 'resolved:confirmed-completed', digest: RESOLUTION_DIGEST }));
    const orphaned = await build(orphan);
    assert.equal(orphaned.trace.stages.resolution.presence, 'missing', 'a resolution summary with no canonical resolution is missing, whatever the outcome');
    assert.ok(failed(orphaned.verification).includes('completeness:completeness.execution-resolution'));
  });

  it('a malformed pre-P11 withheld summary states no outcome, exactly as the execution ledger replays it', async () => {
    const legacy = executedWorld();
    legacy.attempt = undefined;
    legacy.terminal = undefined;
    legacy.reservation = undefined;
    legacy.events = legacy.events.slice(0, 3);
    legacy.references[2] = ref(executionOutcomeReferenceId(EXECUTION), 'execution_record', EXECUTION, { externalVersion: 'withheld:not a reason' });
    assert.equal((await build(legacy)).trace.finalState, 'claimed-outcome-unrecorded');
    legacy.references[2] = ref(executionOutcomeReferenceId(EXECUTION), 'execution_record', EXECUTION, { externalVersion: 'withheld:GRANT_EXPIRED' });
    assert.equal((await build(legacy)).trace.finalState, 'withheld-at-exercise', 'the Prompt 3 form (no layer) decodes as grant-exercise');
  });

  it('the store-wide chain position is not disclosed below AUDITOR; expiry and reservation payloads are checked', async () => {
    const { trace } = await build(executedWorld());
    const partner = listDisclosurePoliciesV2().find((policy) => policy.level === 'PARTNER');
    assert.ok(partner !== undefined);
    assert.equal((discloseAuthorityTrace(trace, partner).stages.decision as Record<string, unknown>)['chainPosition'], undefined);
    assert.equal((discloseAuthorityTrace(trace, AUDITOR_DISCLOSURE_POLICY_V2).stages.decision as Record<string, unknown>)['chainPosition'], 7);
    const expiry = executedWorld();
    expiry.events.push(event(5, 'grant.expiry.observed', { decisionId: DECISION, boundedGrantId: GRANT }, { expiresAt: '2030-01-01T00:00:00.000Z' }));
    assert.ok(failed((await build(expiry)).verification).includes(`correlation:correlation.event-expiry-payload:${GRANT}`));
    const reserved = executedWorld();
    reserved.reservation = { reservation: { executionId: EXECUTION, boundedGrantId: GRANT, policyDigest: 'sha256:p', authorityBindingDigest: 'sha256:b' }, state: 'settled', terminal: { reason: 'executed' } };
    reserved.events.push(event(5, 'exercise.reservation.reserved', { decisionId: DECISION, boundedGrantId: GRANT, executionId: EXECUTION, reservationId: RESERVATION }, { policyDigest: 'sha256:other', authorityBindingDigest: 'sha256:b' }));
    assert.ok(failed((await build(reserved)).verification).includes('correlation:correlation.event-reservation-reserved-payload'));
  });
});

describe('ASSURE-01 trace builder — PROD-03-02 hardening: a reservation reconciliation must be for this execution’s resolution', () => {
  const RECONCILED = 'correlation:correlation.reservation-reconciliation';
  const reconciledWorld = (reconciliation: Record<string, unknown>, terminal: Record<string, unknown> = { kind: 'settled', reason: 'execution-unconfirmed' }): World => {
    const world = resolvedWorld();
    world.reservation = {
      reservation: { executionId: EXECUTION, boundedGrantId: GRANT },
      state: 'settled',
      terminal,
      resolution: { reservationId: RESERVATION, executionId: EXECUTION, resolution: 'confirmed-completed', resolutionDigest: RESOLUTION_DIGEST, recordedAt: T, ...reconciliation },
    } as World['reservation'];
    return world;
  };

  it('the same answer for the same resolution digest, with an agreeing terminal history, verifies — and the stage states the digest', async () => {
    const built = await build(reconciledWorld({}));
    assert.deepEqual(failed(built.verification), []);
    assert.equal(built.verification.checks.find((entry) => entry.check === 'correlation.reservation-reconciliation')?.status, 'pass');
    assert.equal(built.trace.stages.reservation.resolutionDigest, RESOLUTION_DIGEST);
  });

  it('a reconciliation for another resolution digest (P7 `conflict`) fails verification, even with no P8 event to compare', async () => {
    const built = await build(reconciledWorld({ resolutionDigest: 'sha256:another-resolution' }));
    assert.deepEqual(failed(built.verification), [RECONCILED]);
    assert.equal(built.verification.verified, false);
  });

  it('a reconciliation with another answer fails verification', async () => {
    assert.deepEqual(failed((await build(reconciledWorld({ resolution: 'confirmed-not-completed' }))).verification), [RECONCILED]);
  });

  it('a terminal history P7’s own rule contradicts (released beside an unconfirmed observation resolved completed) fails verification', async () => {
    assert.deepEqual(failed((await build(reconciledWorld({}, { kind: 'released', reason: 'execution-failed' }))).verification), [RECONCILED]);
  });

  it('without a composed resolution source it is not applicable, never a pass', async () => {
    const built = await build(reconciledWorld({}), { composed: { resolutions: false } });
    assert.equal(built.verification.checks.find((entry) => entry.check === 'correlation.reservation-reconciliation')?.status, 'not-applicable');
  });
});
