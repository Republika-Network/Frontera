import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
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

function service(options: { readonly maxDischargeAgeSeconds?: number; readonly blocking?: boolean } = {}): ObligationLifecycleService {
  return new ObligationLifecycleService({
    sources: [APPROVAL, SECOND_APPROVAL, HOST, REQUESTER],
    declaration: {
      requirements: [
        {
          obligationType: 'finance.approval',
          blocking: options.blocking ?? true,
          ...(options.maxDischargeAgeSeconds !== undefined ? { maxDischargeAgeSeconds: options.maxDischargeAgeSeconds } : {}),
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

  it('rejects a duplicate obligation and a non-positive discharge window', () => {
    assert.throws(
      () => new ObligationLifecycleService({ sources: [APPROVAL], declaration: { requirements: [{ obligationType: 'finance.approval', blocking: true }, { obligationType: 'finance.approval', blocking: false }] } }),
      ObligationConfigurationError,
    );
    assert.throws(
      () => new ObligationLifecycleService({ sources: [APPROVAL], declaration: { requirements: [{ obligationType: 'finance.approval', blocking: true, maxDischargeAgeSeconds: 0 }] } }),
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

  it('a refusal after a self-reported discharge reaches `rejected`, and stays blocking', () => {
    const resolution = service().resolve(
      [observation({ sourceId: HOST.id, observedAt: '2026-01-01T10:00:00.000Z' }), observation({ outcome: 'refused', observedAt: '2026-01-01T11:00:00.000Z' })],
      CORRELATION,
      NOW,
    );
    const obligation = only(resolution.obligations);

    assert.equal(obligation.state, 'rejected');
    assert.equal(obligation.discharge?.outcome, 'refused');
    assert.equal(resolution.exerciseEligibility, 'blocked');
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

  it('discards a discharge observed outside the declared window, and expires the obligation', () => {
    const resolution = service({ maxDischargeAgeSeconds: 3_600 }).resolve([observation({ observedAt: '2026-01-01T09:00:00.000Z' })], CORRELATION, NOW);
    const obligation = only(resolution.obligations);

    assert.equal(obligation.state, 'expired');
    assert.equal(obligation.discharge, undefined, 'a stale approval never became this obligation’s discharge');
    assert.equal(resolution.exerciseEligibility, 'blocked');
    assert.deepEqual(resolution.disregarded.map((entry) => entry.reason), ['stale_observation']);
  });

  it('a stale discharge alongside a fresh one does not poison the fresh one', () => {
    const resolution = service({ maxDischargeAgeSeconds: 3_600 }).resolve(
      [observation({ observedAt: '2026-01-01T09:00:00.000Z' }), observation({ observedAt: '2026-01-01T11:45:00.000Z' })],
      CORRELATION,
      NOW,
    );

    assert.equal(only(resolution.obligations).state, 'verified');
    assert.equal(resolution.exerciseEligibility, 'eligible');
  });

  it('a discharge inside the window records when it stops being good', () => {
    const resolution = service({ maxDischargeAgeSeconds: 3_600 }).resolve([observation({ observedAt: '2026-01-01T11:45:00.000Z' })], CORRELATION, NOW);
    assert.equal(only(resolution.obligations).dischargeExpiresAt, '2026-01-01T12:45:00.000Z');
  });

  it('the identical discharge is stale at a later instant, with no sweeper having run', () => {
    const fresh = service({ maxDischargeAgeSeconds: 3_600 }).resolve([observation({ observedAt: '2026-01-01T11:45:00.000Z' })], CORRELATION, NOW);
    const later = service({ maxDischargeAgeSeconds: 3_600 }).resolve([observation({ observedAt: '2026-01-01T11:45:00.000Z' })], CORRELATION, '2026-01-01T13:00:00.000Z');

    assert.equal(only(fresh.obligations).state, 'verified');
    assert.equal(only(later.obligations).state, 'expired', 'ADR §6: expiry is derived from the clock at read time');
  });

  it('refuses a refusal of a discharge nobody reported — the ADR draws `rejected` only from `discharged`', () => {
    const resolution = service().resolve([observation({ outcome: 'refused' })], CORRELATION, NOW);

    assert.equal(only(resolution.obligations).state, 'required', 'no discharge is invented in order to refute it');
    assert.equal(resolution.exerciseEligibility, 'blocked');
    assert.deepEqual(resolution.disregarded.map((entry) => entry.reason), ['illegal_transition']);
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

describe('Obligation resolution — duplicates and conflicts', () => {
  it('a duplicate discharge is idempotent: same state, same history, no second record', () => {
    const once = service().resolve([observation()], CORRELATION, NOW);
    const twice = service().resolve([observation(), observation()], CORRELATION, NOW);

    assert.equal(only(twice.obligations).state, 'verified');
    assert.deepEqual(only(twice.obligations).transitions, only(once.obligations).transitions);
    assert.deepEqual(twice.disregarded, [], 'a repeat of the same discharge is not a violation');
  });

  it('two independent sources reporting the same discharge is agreement, not conflict', () => {
    const resolution = service().resolve([observation(), observation({ sourceId: SECOND_APPROVAL.id })], CORRELATION, NOW);
    assert.equal(only(resolution.obligations).state, 'verified');
    assert.equal(only(resolution.obligations).conflicted, undefined);
    assert.equal(resolution.exerciseEligibility, 'eligible');
  });

  it('an independent source refuting a self-report is the verification mechanism, not a conflict', () => {
    const resolution = service().resolve(
      [observation({ sourceId: HOST.id, observedAt: '2026-01-01T10:00:00.000Z' }), observation({ outcome: 'refused', sourceId: APPROVAL.id, observedAt: '2026-01-01T10:30:00.000Z' })],
      CORRELATION,
      NOW,
    );
    const obligation = only(resolution.obligations);

    assert.equal(obligation.conflicted, undefined, 'ADR §2 designs exactly this: the claimant claims, the independent party rules');
    assert.equal(obligation.state, 'rejected');
    assert.equal(resolution.exerciseEligibility, 'blocked');
  });

  it('two independent sources contradicting each other is a conflict, and withholds exercise', () => {
    const resolution = service().resolve(
      [observation({ sourceId: HOST.id, observedAt: '2026-01-01T10:00:00.000Z' }), observation({ outcome: 'refused', sourceId: APPROVAL.id, observedAt: '2026-01-01T10:30:00.000Z' }), observation({ sourceId: SECOND_APPROVAL.id, observedAt: '2026-01-01T11:00:00.000Z' })],
      CORRELATION,
      NOW,
    );
    const obligation = only(resolution.obligations);

    assert.equal(obligation.conflicted, true);
    assert.equal(resolution.exerciseEligibility, 'blocked', 'two sources of the same standing disagreeing is a fact about the world, never a tie to be broken silently');
  });

  it('an independent waiver contradicted by an independent refusal is likewise conflicted rather than resolved in the waiver’s favour', () => {
    const resolution = service().resolve(
      [observation({ sourceId: HOST.id, observedAt: '2026-01-01T09:00:00.000Z' }), observation({ outcome: 'refused', observedAt: '2026-01-01T10:00:00.000Z' }), observation({ outcome: 'waived', sourceId: SECOND_APPROVAL.id, observedAt: '2026-01-01T11:00:00.000Z' })],
      CORRELATION,
      NOW,
    );

    assert.equal(only(resolution.obligations).conflicted, true);
    assert.equal(resolution.exerciseEligibility, 'blocked');
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
