import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  OBLIGATION_STATES,
  OBLIGATION_STATE_TRANSITIONS,
  ObligationConfigurationError,
  ObligationLifecycleService,
  obligationIsSatisfied,
  type ObligationCorrelation,
  type ObligationDischargeObservation,
  type ObligationDischargeSource,
  type ObligationInstance,
} from '../index.js';

const APPROVAL: ObligationDischargeSource = { id: 'obl.src.approval.finance', kind: 'approval_runtime', name: 'Finance approvals', verificationClass: 'independent' };
const SECOND_APPROVAL: ObligationDischargeSource = { id: 'obl.src.approval.treasury', kind: 'approval_runtime', name: 'Treasury approvals', verificationClass: 'independent' };
const HOST: ObligationDischargeSource = { id: 'obl.src.host', kind: 'internal_store', name: 'Host-recorded state', verificationClass: 'self_reported' };
const REQUESTER: ObligationDischargeSource = { id: 'obl.src.request', kind: 'request', name: 'The requester', verificationClass: 'self_reported' };

const CORRELATION: ObligationCorrelation = { requestId: 'req-1', action: 'payment.execute', resourceScope: 'finance:payments' };
const NOW = '2026-01-01T12:00:00.000Z';

function service(options: { readonly expiresAt?: string; readonly blocking?: boolean } = {}): ObligationLifecycleService {
  return new ObligationLifecycleService({
    sources: [APPROVAL, SECOND_APPROVAL, HOST, REQUESTER],
    declaration: {
      requirements: [
        {
          obligationType: 'finance.approval',
          blocking: options.blocking ?? true,
          ...(options.expiresAt !== undefined ? { expiresAt: options.expiresAt } : {}),
        },
      ],
    },
  });
}

function observation(overrides: Partial<ObligationDischargeObservation> = {}): ObligationDischargeObservation {
  return {
    obligationType: 'finance.approval',
    correlation: CORRELATION,
    sourceId: APPROVAL.id,
    outcome: 'discharged',
    observedAt: NOW,
    ...overrides,
  };
}

function only(instances: readonly ObligationInstance[]): ObligationInstance {
  assert.equal(instances.length, 1);
  return instances[0] as ObligationInstance;
}

describe('Obligation declaration — the configuration is validated where it is written', () => {
  it('rejects a requirement that does not say whether it blocks', () => {
    assert.throws(
      () =>
        new ObligationLifecycleService({
          sources: [APPROVAL],
          declaration: { requirements: [{ obligationType: 'finance.approval', blocking: undefined as unknown as boolean }] },
        }),
      (error: unknown) => {
        assert.ok(error instanceof ObligationConfigurationError);
        assert.match(error.violations.join(' '), /"not stated" must never be read as "not blocking"/);
        return true;
      },
    );
  });

  it('rejects an obligation type outside the closed vocabulary — there is no escape hatch for inventing one', () => {
    assert.throws(
      () =>
        new ObligationLifecycleService({
          sources: [APPROVAL],
          declaration: { requirements: [{ obligationType: 'finance.rubber-stamp' as 'finance.approval', blocking: true }] },
        }),
      ObligationConfigurationError,
    );
  });

  it('rejects a duplicate obligation and a malformed deadline', () => {
    assert.throws(
      () => new ObligationLifecycleService({ sources: [APPROVAL], declaration: { requirements: [{ obligationType: 'finance.approval', blocking: true }, { obligationType: 'finance.approval', blocking: false }] } }),
      ObligationConfigurationError,
    );
    assert.throws(
      () => new ObligationLifecycleService({ sources: [APPROVAL], declaration: { requirements: [{ obligationType: 'finance.approval', blocking: true, expiresAt: 'whenever' }] } }),
      ObligationConfigurationError,
    );
  });

  it('asks a provider for exactly the declared obligations and nothing speculative', () => {
    assert.deepEqual(service().declaredTypes(), ['finance.approval']);
  });
});

describe('Obligation resolution — nothing observed', () => {
  it('a declared blocking obligation with no observation stays `required` and withholds exercise', () => {
    const resolution = service().resolve([], CORRELATION, NOW);
    const obligation = only(resolution.obligations);

    assert.equal(resolution.resolved, true, 'the provider answered; it just had nothing to report');
    assert.equal(obligation.state, 'required');
    assert.equal(obligation.blocking, true);
    assert.deepEqual(obligation.transitions, []);
    assert.equal(resolution.exerciseEligibility, 'blocked');
  });

  it('a declared non-blocking obligation with no observation does not withhold exercise', () => {
    const resolution = service({ blocking: false }).resolve([], CORRELATION, NOW);
    assert.equal(only(resolution.obligations).state, 'required');
    assert.equal(resolution.exerciseEligibility, 'eligible');
  });
});

describe('Obligation resolution — discharge and verification', () => {
  it('an independent source reporting a discharge reaches `verified`, and exercise becomes eligible', () => {
    const resolution = service().resolve([observation({ subjectId: 'cfo@example.test', reference: 'AP-771' })], CORRELATION, NOW);
    const obligation = only(resolution.obligations);

    assert.equal(obligation.state, 'verified');
    assert.equal(resolution.exerciseEligibility, 'eligible');
    assert.equal(obligation.discharge?.verificationClass, 'independent');
    assert.equal(obligation.discharge?.sourceId, APPROVAL.id);
    assert.equal(obligation.discharge?.subjectId, 'cfo@example.test');
    assert.equal(obligation.discharge?.reference, 'AP-771');
    assert.deepEqual(
      obligation.transitions.map((transition) => `${transition.from}->${transition.to}`),
      ['required->pending', 'pending->discharged', 'discharged->verified'],
    );
  });

  it('a self-reporting source reporting the identical discharge stops at `discharged`, and exercise stays withheld', () => {
    const resolution = service().resolve([observation({ sourceId: HOST.id })], CORRELATION, NOW);
    const obligation = only(resolution.obligations);

    assert.equal(obligation.state, 'discharged');
    assert.equal(obligationIsSatisfied(obligation), false, 'satisfaction is derived from the state, never stored alongside it');
    assert.equal(resolution.exerciseEligibility, 'blocked', 'ADR §2: "the requester says it did" is not "the provider says so"');
    assert.equal(obligation.discharge?.verificationClass, 'self_reported');
  });

  it('the only difference between those two cases is the registry entry — nothing the observation carried', () => {
    const independent = service().resolve([observation()], CORRELATION, NOW);
    const selfReported = service().resolve([observation({ sourceId: HOST.id })], CORRELATION, NOW);

    assert.equal(only(independent.obligations).state, 'verified');
    assert.equal(only(selfReported.obligations).state, 'discharged');
  });

  it('an outstanding report reaches `pending` and writes no discharge record — progress is not a discharge', () => {
    const resolution = service().resolve([observation({ outcome: 'pending' })], CORRELATION, NOW);
    const obligation = only(resolution.obligations);

    assert.equal(obligation.state, 'pending');
    assert.equal(obligation.discharge, undefined);
    assert.equal(resolution.exerciseEligibility, 'blocked');
  });

  it('a failed verification of a supplied discharge leaves the state `discharged`, and records why', () => {
    const resolution = service().resolve(
      [observation({ sourceId: HOST.id, observedAt: '2026-01-01T10:00:00.000Z' }), observation({ outcome: 'refused', observedAt: '2026-01-01T11:00:00.000Z', reference: 'AP-DECLINED-9' })],
      CORRELATION,
      NOW,
    );
    const obligation = only(resolution.obligations);

    assert.equal(obligation.state, 'discharged', 'ADR §2: a failed verification attempt moves the lifecycle nowhere');
    assert.equal(obligation.verification?.verified, false);
    assert.equal(obligation.verification?.sourceId, APPROVAL.id);
    assert.equal(obligation.verification?.reference, 'AP-DECLINED-9');
    assert.equal(obligation.discharge?.outcome, 'discharged', 'the supplied discharge is still the discharge on record');
    assert.equal(resolution.exerciseEligibility, 'blocked');
    assert.equal(
      obligation.transitions.some((transition) => transition.to === 'verified'),
      false,
      'nothing was verified, so nothing transitioned',
    );
  });

  it('a verification attempt against an obligation with no supplied discharge is not applicable, and is recorded as such', () => {
    const resolution = service().resolve([observation({ outcome: 'refused' })], CORRELATION, NOW);

    assert.equal(only(resolution.obligations).state, 'required');
    assert.equal(only(resolution.obligations).verification, undefined);
    assert.deepEqual(resolution.disregarded.map((entry) => entry.reason), ['verification_not_applicable']);
  });

  it('a failed verification never satisfies, and never un-satisfies something already verified', () => {
    const alreadyVerified = service().resolve(
      [observation({ observedAt: '2026-01-01T10:00:00.000Z' }), observation({ outcome: 'refused', sourceId: SECOND_APPROVAL.id, observedAt: '2026-01-01T11:00:00.000Z' })],
      CORRELATION,
      NOW,
    );

    assert.equal(only(alreadyVerified.obligations).state, 'verified', 'a terminal, satisfied obligation is not reopened by a later attempt');
    assert.equal(alreadyVerified.exerciseEligibility, 'eligible');
    assert.deepEqual(alreadyVerified.disregarded.map((entry) => entry.reason), ['verification_not_applicable']);
  });

  it('a waiver from an independent source reaches `waived` and releases exercise', () => {
    const resolution = service().resolve([observation({ outcome: 'waived' })], CORRELATION, NOW);
    assert.equal(only(resolution.obligations).state, 'waived');
    assert.equal(resolution.exerciseEligibility, 'eligible');
  });

  it('a waiver from a self-reporting source is refused admission — the beneficiary does not excuse itself', () => {
    const resolution = service().resolve([observation({ outcome: 'waived', sourceId: HOST.id })], CORRELATION, NOW);

    assert.equal(only(resolution.obligations).state, 'required');
    assert.equal(resolution.exerciseEligibility, 'blocked');
    assert.deepEqual(resolution.disregarded.map((entry) => entry.reason), ['waiver_not_independent']);
  });
});

describe('Obligation resolution — observations that do not count', () => {
  it('discards an observation citing an unregistered source, and says so', () => {
    const resolution = service().resolve([observation({ sourceId: 'obl.src.nobody' })], CORRELATION, NOW);

    assert.equal(only(resolution.obligations).state, 'required');
    assert.equal(resolution.exerciseEligibility, 'blocked');
    assert.deepEqual(resolution.disregarded.map((entry) => entry.reason), ['unregistered_source']);
  });

  it('discards a discharge of an obligation this decision did not declare', () => {
    const resolution = service().resolve([observation({ obligationType: 'second.signer' })], CORRELATION, NOW);

    assert.equal(only(resolution.obligations).state, 'required');
    assert.deepEqual(resolution.disregarded.map((entry) => entry.reason), ['undeclared_obligation']);
  });

  it('discards a discharge correlated to a different request', () => {
    const resolution = service().resolve([observation({ correlation: { ...CORRELATION, requestId: 'req-other' } })], CORRELATION, NOW);

    assert.equal(only(resolution.obligations).state, 'required');
    assert.deepEqual(resolution.disregarded.map((entry) => entry.reason), ['correlation_mismatch']);
  });

  it('discards a discharge correlated to a different action, and to a different resource scope', () => {
    for (const wrong of [{ action: 'payment.refund' }, { resourceScope: 'finance:payroll' }]) {
      const resolution = service().resolve([observation({ correlation: { ...CORRELATION, ...wrong } })], CORRELATION, NOW);
      assert.equal(only(resolution.obligations).state, 'required', JSON.stringify(wrong));
      assert.deepEqual(resolution.disregarded.map((entry) => entry.reason), ['correlation_mismatch']);
    }
  });

  it('an obligation that declares no deadline never expires, however old anything is', () => {
    const resolution = service().resolve([observation({ observedAt: '2020-01-01T00:00:00.000Z' })], CORRELATION, NOW);

    assert.equal(only(resolution.obligations).state, 'verified', 'a discharge’s age is a verification question, never a lifecycle deadline');
    assert.equal(resolution.exerciseEligibility, 'eligible');
  });

  it('an old discharge still verifies when the obligation declares no deadline — proof freshness is not obligation expiry', () => {
    const resolution = service().resolve([observation({ observedAt: '2026-01-01T09:00:00.000Z' })], CORRELATION, NOW);

    assert.equal(only(resolution.obligations).state, 'verified');
    assert.deepEqual(resolution.disregarded, [], 'nothing is discarded for age');
  });

  it('records an illegal transition rather than applying it, when a later observation would reopen a terminal obligation', () => {
    const resolution = service().resolve(
      [observation({ outcome: 'waived', observedAt: '2026-01-01T10:00:00.000Z' }), observation({ observedAt: '2026-01-01T11:00:00.000Z' })],
      CORRELATION,
      NOW,
    );

    assert.equal(only(resolution.obligations).state, 'waived', 'a waived obligation is not reopened by a later discharge');
    assert.deepEqual(resolution.disregarded.map((entry) => entry.reason), ['illegal_transition']);
  });

  it('a progress report that arrives after the confirmation it precedes is already-taken, not a violation', () => {
    const resolution = service().resolve(
      [observation({ observedAt: '2026-01-01T10:00:00.000Z' }), observation({ outcome: 'pending', observedAt: '2026-01-01T11:00:00.000Z' })],
      CORRELATION,
      NOW,
    );

    assert.equal(only(resolution.obligations).state, 'verified');
    assert.deepEqual(resolution.disregarded, []);
  });
});

describe('Obligation resolution — duplicates and repeated verification', () => {
  it('a duplicate discharge is idempotent: same state, same history, no second record', () => {
    const once = service().resolve([observation()], CORRELATION, NOW);
    const twice = service().resolve([observation(), observation()], CORRELATION, NOW);

    assert.equal(only(twice.obligations).state, 'verified');
    assert.deepEqual(only(twice.obligations).transitions, only(once.obligations).transitions);
    assert.deepEqual(twice.disregarded, [], 'a repeat of the same discharge is not a violation');
  });

  it('two independent sources reporting the same discharge is agreement, and it verifies once', () => {
    const resolution = service().resolve([observation(), observation({ sourceId: SECOND_APPROVAL.id })], CORRELATION, NOW);

    assert.equal(only(resolution.obligations).state, 'verified');
    assert.equal(resolution.exerciseEligibility, 'eligible');
    assert.equal(
      only(resolution.obligations).transitions.filter((transition) => transition.to === 'verified').length,
      1,
      'the second confirmation is idempotent, not a second verification',
    );
  });

  it('an independent source declining to confirm a self-report leaves the obligation `discharged`', () => {
    const resolution = service().resolve(
      [observation({ sourceId: HOST.id, observedAt: '2026-01-01T10:00:00.000Z' }), observation({ outcome: 'refused', sourceId: APPROVAL.id, observedAt: '2026-01-01T10:30:00.000Z' })],
      CORRELATION,
      NOW,
    );
    const obligation = only(resolution.obligations);

    assert.equal(obligation.state, 'discharged', 'ADR §2 gives a failed verification no state of its own');
    assert.equal(obligation.verification?.verified, false);
    assert.equal(resolution.exerciseEligibility, 'blocked');
  });

  it('a later confirmation after a failed attempt still verifies — the failure was provenance, not a terminal state', () => {
    const resolution = service().resolve(
      [
        observation({ sourceId: HOST.id, observedAt: '2026-01-01T10:00:00.000Z' }),
        observation({ outcome: 'refused', sourceId: APPROVAL.id, observedAt: '2026-01-01T10:30:00.000Z' }),
        observation({ sourceId: SECOND_APPROVAL.id, observedAt: '2026-01-01T11:00:00.000Z' }),
      ],
      CORRELATION,
      NOW,
    );

    assert.equal(only(resolution.obligations).state, 'verified');
    assert.equal(resolution.exerciseEligibility, 'eligible');
  });

  it('a waiver arriving after a discharge was supplied is refused — the ADR reaches `waived` only from `required` or `pending`', () => {
    const resolution = service().resolve(
      [
        observation({ sourceId: HOST.id, observedAt: '2026-01-01T09:00:00.000Z' }),
        observation({ outcome: 'refused', observedAt: '2026-01-01T10:00:00.000Z' }),
        observation({ outcome: 'waived', sourceId: SECOND_APPROVAL.id, observedAt: '2026-01-01T11:00:00.000Z' }),
      ],
      CORRELATION,
      NOW,
    );

    // A waiver removes the requirement *to discharge*. Once a discharge has
    // been supplied there is nothing left to excuse — the question is whether
    // it verifies — so the transition table gives `discharged` no edge to
    // `waived`, and this layer refuses rather than inventing one.
    assert.equal(only(resolution.obligations).state, 'discharged');
    assert.equal(only(resolution.obligations).verification?.verified, false);
    assert.equal(resolution.exerciseEligibility, 'blocked', 'fail-closed: an illegal transition never satisfies');
    assert.deepEqual(resolution.disregarded.map((entry) => entry.reason), ['illegal_transition']);
  });

  it('the same waiver on the same obligation before any discharge is supplied is accepted', () => {
    const resolution = service().resolve([observation({ outcome: 'waived', sourceId: SECOND_APPROVAL.id, observedAt: '2026-01-01T11:00:00.000Z' })], CORRELATION, NOW);

    assert.equal(only(resolution.obligations).state, 'waived');
    assert.equal(resolution.exerciseEligibility, 'eligible', 'the difference is only when it arrived, which is what the transition table encodes');
  });
});

describe('Obligation expiry — a declared deadline, not discharge staleness', () => {
  const DEADLINE = '2026-01-01T12:00:00.000Z';
  const BEFORE = '2026-01-01T11:59:59.000Z';
  const AFTER = '2026-01-01T12:00:01.000Z';

  it('expires from `required` once the deadline passes with nothing observed', () => {
    const resolution = service({ expiresAt: DEADLINE }).resolve([], CORRELATION, AFTER);
    const obligation = only(resolution.obligations);

    assert.equal(obligation.state, 'expired');
    assert.equal(obligation.expiresAt, DEADLINE);
    assert.deepEqual(
      obligation.transitions.map((transition) => `${transition.from}->${transition.to}:${transition.reason}`),
      ['required->expired:deadline_passed'],
    );
    assert.equal(resolution.exerciseEligibility, 'blocked');
  });

  it('expires from `pending`', () => {
    const resolution = service({ expiresAt: DEADLINE }).resolve([observation({ outcome: 'pending', observedAt: BEFORE })], CORRELATION, AFTER);

    assert.equal(only(resolution.obligations).state, 'expired');
    assert.equal(
      only(resolution.obligations).transitions.some((transition) => `${transition.from}->${transition.to}` === 'pending->expired'),
      true,
    );
  });

  it('expires from `discharged` — a supplied but unverified discharge does not stop the clock', () => {
    const resolution = service({ expiresAt: DEADLINE }).resolve([observation({ sourceId: HOST.id, observedAt: BEFORE })], CORRELATION, AFTER);

    assert.equal(only(resolution.obligations).state, 'expired');
    assert.equal(
      only(resolution.obligations).transitions.some((transition) => `${transition.from}->${transition.to}` === 'discharged->expired'),
      true,
    );
    assert.equal(resolution.exerciseEligibility, 'blocked');
  });

  it('does NOT expire a `verified` obligation — a deadline passing never withdraws a condition that was met', () => {
    const resolution = service({ expiresAt: DEADLINE }).resolve([observation({ observedAt: BEFORE })], CORRELATION, AFTER);

    assert.equal(only(resolution.obligations).state, 'verified');
    assert.equal(resolution.exerciseEligibility, 'eligible');
  });

  it('does NOT expire a `waived` obligation either', () => {
    const resolution = service({ expiresAt: DEADLINE }).resolve([observation({ outcome: 'waived', observedAt: BEFORE })], CORRELATION, AFTER);

    assert.equal(only(resolution.obligations).state, 'waived');
    assert.equal(resolution.exerciseEligibility, 'eligible');
  });

  it('does not expire before the deadline, and expires exactly at it', () => {
    assert.equal(only(service({ expiresAt: DEADLINE }).resolve([], CORRELATION, BEFORE).obligations).state, 'required');
    assert.equal(only(service({ expiresAt: DEADLINE }).resolve([], CORRELATION, DEADLINE).obligations).state, 'expired', 'the ADR rule is `currentTime >= expiresAt`');
  });

  it('is derived from the passed-in instant, with no sweeper having run', () => {
    const declaration = service({ expiresAt: DEADLINE });

    assert.equal(only(declaration.resolve([], CORRELATION, BEFORE).obligations).state, 'required');
    assert.equal(only(declaration.resolve([], CORRELATION, AFTER).obligations).state, 'expired');
    assert.equal(only(declaration.resolve([], CORRELATION, BEFORE).obligations).state, 'required', 'nothing was mutated by the read that found it expired');
  });

  it('an obligation declaring no deadline never expires, at any instant', () => {
    assert.equal(only(service().resolve([], CORRELATION, '2099-01-01T00:00:00.000Z').obligations).state, 'required');
  });
});

describe('Obligation resolution — two obligations on one decision', () => {
  const twoObligations = new ObligationLifecycleService({
    sources: [APPROVAL, HOST],
    declaration: {
      requirements: [
        { obligationType: 'finance.approval', blocking: true },
        { obligationType: 'second.signer', blocking: false },
      ],
    },
  });

  it('one satisfied blocking obligation and one unsatisfied non-blocking one is eligible', () => {
    const resolution = twoObligations.resolve([observation()], CORRELATION, NOW);

    assert.deepEqual(resolution.obligations.map((obligation) => [obligation.obligationType, obligation.state]), [
      ['finance.approval', 'verified'],
      ['second.signer', 'required'],
    ]);
    assert.equal(resolution.exerciseEligibility, 'eligible', 'a non-blocking obligation is declared and tracked, and gates nothing');
  });

  it('an unsatisfied blocking obligation blocks even when the non-blocking one is verified', () => {
    const resolution = twoObligations.resolve([observation({ obligationType: 'second.signer' })], CORRELATION, NOW);

    assert.equal(resolution.exerciseEligibility, 'blocked');
    assert.deepEqual(resolution.obligations.map((obligation) => obligation.state), ['required', 'verified']);
  });

  it('obligations are reported in a stable order regardless of observation order', () => {
    const left = twoObligations.resolve([observation(), observation({ obligationType: 'second.signer' })], CORRELATION, NOW);
    const right = twoObligations.resolve([observation({ obligationType: 'second.signer' }), observation()], CORRELATION, NOW);
    assert.equal(JSON.stringify(left), JSON.stringify(right));
  });
});

describe('Every legal transition is reachable through the real service', () => {
  /**
   * The transition table asserted as *behaviour* rather than as data.
   *
   * `obligation-state.test.ts` proves the table is exactly the ADR's, which is
   * a statement about a constant. This proves each of its eight edges is
   * actually taken by a real resolution of real observations — so an edge that
   * exists in the table but that nothing can ever reach would fail here.
   */
  const DEADLINE = '2026-01-01T12:00:00.000Z';
  const BEFORE = '2026-01-01T11:00:00.000Z';
  const AFTER = '2026-01-01T13:00:00.000Z';

  const edges: readonly {
    readonly edge: string;
    readonly observations: readonly ObligationDischargeObservation[];
    readonly expiresAt?: string;
    readonly at: string;
    readonly finalState: string;
  }[] = [
    { edge: 'required->pending', observations: [observation({ outcome: 'pending', observedAt: BEFORE })], at: NOW, finalState: 'pending' },
    { edge: 'required->waived', observations: [observation({ outcome: 'waived', observedAt: BEFORE })], at: NOW, finalState: 'waived' },
    { edge: 'required->expired', observations: [], expiresAt: DEADLINE, at: AFTER, finalState: 'expired' },
    { edge: 'pending->discharged', observations: [observation({ sourceId: HOST.id, observedAt: BEFORE })], at: NOW, finalState: 'discharged' },
    {
      edge: 'pending->waived',
      observations: [observation({ outcome: 'pending', observedAt: BEFORE }), observation({ outcome: 'waived', sourceId: SECOND_APPROVAL.id, observedAt: '2026-01-01T11:30:00.000Z' })],
      at: NOW,
      finalState: 'waived',
    },
    { edge: 'pending->expired', observations: [observation({ outcome: 'pending', observedAt: BEFORE })], expiresAt: DEADLINE, at: AFTER, finalState: 'expired' },
    { edge: 'discharged->verified', observations: [observation({ observedAt: BEFORE })], at: NOW, finalState: 'verified' },
    { edge: 'discharged->expired', observations: [observation({ sourceId: HOST.id, observedAt: BEFORE })], expiresAt: DEADLINE, at: AFTER, finalState: 'expired' },
  ];

  for (const { edge, observations, expiresAt, at, finalState } of edges) {
    it(`takes ${edge}, and records it in the history`, () => {
      const resolution = service(expiresAt === undefined ? {} : { expiresAt }).resolve(observations, CORRELATION, at);
      const obligation = only(resolution.obligations);

      assert.equal(obligation.state, finalState, `${edge} must leave the obligation in ${finalState}`);
      assert.equal(
        obligation.transitions.some((transition) => `${transition.from}->${transition.to}` === edge),
        true,
        `expected ${edge} in [${obligation.transitions.map((transition) => `${transition.from}->${transition.to}`).join(', ')}]`,
      );
    });
  }

  it('covers all eight legal edges between them, so none of the table is unreachable', () => {
    const covered = new Set<string>();
    for (const { observations, expiresAt, at } of edges) {
      const resolution = service(expiresAt === undefined ? {} : { expiresAt }).resolve(observations, CORRELATION, at);
      for (const transition of only(resolution.obligations).transitions) covered.add(`${transition.from}->${transition.to}`);
    }

    const declared: string[] = [];
    for (const from of OBLIGATION_STATES) {
      for (const to of OBLIGATION_STATE_TRANSITIONS[from]) declared.push(`${from}->${to}`);
    }

    assert.deepEqual([...covered].sort(), declared.sort(), 'every declared transition must be reachable, and nothing beyond them taken');
  });

  it('every transition carries a reason from the closed vocabulary, never a blank one', () => {
    const reasons = new Set<string>();
    for (const { observations, expiresAt, at } of edges) {
      const resolution = service(expiresAt === undefined ? {} : { expiresAt }).resolve(observations, CORRELATION, at);
      for (const transition of only(resolution.obligations).transitions) {
        assert.equal(transition.at, at, 'a transition instant is passed in, never read from a clock');
        reasons.add(transition.reason);
      }
    }

    for (const reason of reasons) {
      assert.equal(['activated', 'discharge_reported', 'discharge_confirmed', 'waiver_recorded', 'deadline_passed'].includes(reason), true, `'${reason}' is not a declared transition reason`);
    }
  });

  it('an activation and an expiry carry no DischargeRecord — ADR §1, "What a transition carries"', () => {
    const activated = service().resolve([observation({ outcome: 'pending', observedAt: BEFORE })], CORRELATION, NOW);
    assert.equal(only(activated.obligations).discharge, undefined, 'an activation discharged nothing');

    const expired = service({ expiresAt: DEADLINE }).resolve([], CORRELATION, AFTER);
    assert.equal(only(expired.obligations).discharge, undefined, 'an expiry is the absence of a discharge, not one');
  });
});
