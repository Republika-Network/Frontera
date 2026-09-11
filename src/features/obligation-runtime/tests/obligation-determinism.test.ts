import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  ObligationLifecycleService,
  createFailingObligationDischargeProvider,
  createInMemoryObligationDischargeProvider,
  unresolvedObligationResolution,
  type ObligationCorrelation,
  type ObligationDischargeObservation,
  type ObligationDischargeSource,
} from '../index.js';

const APPROVAL: ObligationDischargeSource = { id: 'obl.src.approval.finance', kind: 'approval_runtime', name: 'Finance approvals', verificationClass: 'independent' };
const HOST: ObligationDischargeSource = { id: 'obl.src.host', kind: 'internal_store', name: 'Host state', verificationClass: 'self_reported' };
const CORRELATION: ObligationCorrelation = { requestId: 'req-1', action: 'payment.execute', resourceScope: 'finance:payments' };
const NOW = '2026-01-01T12:00:00.000Z';

function service(): ObligationLifecycleService {
  return new ObligationLifecycleService({
    sources: [APPROVAL, HOST],
    declaration: {
      requirements: [
        { obligationType: 'finance.approval', blocking: true, expiresAt: '2026-01-01T18:00:00.000Z' },
        { obligationType: 'second.signer', blocking: false },
      ],
    },
  });
}

const OBSERVATIONS: readonly ObligationDischargeObservation[] = [
  { obligationType: 'finance.approval', correlation: CORRELATION, sourceId: APPROVAL.id, outcome: 'discharged', observedAt: '2026-01-01T11:30:00.000Z', subjectId: 'cfo@example.test' },
  { obligationType: 'second.signer', correlation: CORRELATION, sourceId: HOST.id, outcome: 'pending', observedAt: '2026-01-01T11:00:00.000Z' },
];

describe('Obligation resolution is deterministic', () => {
  it('the same world resolves to a byte-identical resolution', () => {
    const left = service().resolve(OBSERVATIONS, CORRELATION, NOW);
    const right = service().resolve(OBSERVATIONS, CORRELATION, NOW);
    assert.equal(JSON.stringify(left), JSON.stringify(right));
  });

  it('observation order does not change the result', () => {
    const forward = service().resolve(OBSERVATIONS, CORRELATION, NOW);
    const reversed = service().resolve([...OBSERVATIONS].reverse(), CORRELATION, NOW);
    assert.equal(JSON.stringify(forward), JSON.stringify(reversed));
  });

  it('re-resolving does not consume anything: a second pass over the same world is identical, so nothing can be double-discharged', () => {
    const instance = service();
    const first = instance.resolve(OBSERVATIONS, CORRELATION, NOW);
    const second = instance.resolve(OBSERVATIONS, CORRELATION, NOW);
    const third = instance.resolve(OBSERVATIONS, CORRELATION, NOW);
    assert.equal(JSON.stringify(first), JSON.stringify(second));
    assert.equal(JSON.stringify(second), JSON.stringify(third));
  });

  it('duplicating every observation changes nothing', () => {
    const once = service().resolve(OBSERVATIONS, CORRELATION, NOW);
    const twice = service().resolve([...OBSERVATIONS, ...OBSERVATIONS], CORRELATION, NOW);
    assert.equal(JSON.stringify(once), JSON.stringify(twice));
  });

  it('the resolution serializes stably — key order is fixed, so a canonical digest of it is too', () => {
    assert.equal(JSON.stringify(service().resolve(OBSERVATIONS, CORRELATION, NOW)), JSON.stringify(service().resolve(OBSERVATIONS, CORRELATION, NOW)));
  });

  it('every timestamp in the result came from an input, never from a clock this layer read', () => {
    const resolution = service().resolve(OBSERVATIONS, CORRELATION, NOW);
    assert.equal(resolution.resolvedAt, NOW);
    for (const obligation of resolution.obligations) {
      assert.equal(obligation.declaredAt, NOW);
      for (const transition of obligation.transitions) assert.equal(transition.at, NOW);
    }
  });

  it('obligation ids carry no randomness: the same request produces the same ids every time', () => {
    const first = service().resolve(OBSERVATIONS, CORRELATION, NOW).obligations.map((obligation) => obligation.id);
    const second = service().resolve(OBSERVATIONS, CORRELATION, NOW).obligations.map((obligation) => obligation.id);
    assert.deepEqual(first, second);
    for (const id of first) assert.match(id, /^aoc\.obligation:req-1:payment\.execute:finance:payments:/);
  });
});

describe('An unreadable discharge source withholds, and never satisfies', () => {
  it('an unresolved resolution reports `resolved: false` and blocks when anything blocking is declared', () => {
    const declared = service().declare(CORRELATION, NOW);
    const resolution = unresolvedObligationResolution({ declaredTypes: ['finance.approval', 'second.signer'], obligations: declared, resolvedAt: NOW });

    assert.equal(resolution.resolved, false);
    assert.equal(resolution.exerciseEligibility, 'blocked');
    assert.deepEqual(resolution.obligations.map((obligation) => obligation.state), ['required', 'required']);
  });

  it('`resolved: false` is never "there are no obligations" — every declared one is still reported', () => {
    const resolution = unresolvedObligationResolution({ declaredTypes: ['finance.approval'], obligations: service().declare(CORRELATION, NOW), resolvedAt: NOW });
    assert.equal(resolution.obligations.length, 2);
  });

  it('a deployment declaring only non-blocking obligations is not blocked by an unreadable source', () => {
    const nonBlocking = new ObligationLifecycleService({ sources: [APPROVAL], declaration: { requirements: [{ obligationType: 'second.signer', blocking: false }] } });
    const resolution = unresolvedObligationResolution({ declaredTypes: ['second.signer'], obligations: nonBlocking.declare(CORRELATION, NOW), resolvedAt: NOW });
    assert.equal(resolution.exerciseEligibility, 'eligible');
  });
});

describe('The in-memory provider is a table, not an integration', () => {
  it('answers only the obligations the query declared', async () => {
    const provider = createInMemoryObligationDischargeProvider([
      ...OBSERVATIONS,
      { obligationType: 'unrelated.thing', correlation: CORRELATION, sourceId: APPROVAL.id, outcome: 'discharged', observedAt: NOW },
    ]);
    const output = await provider.resolveObligationDischarges({
      obligationTypes: ['finance.approval'],
      correlation: CORRELATION,
      actorId: 'actor',
      trustDomainId: 'trust',
      at: NOW,
    });
    assert.deepEqual(output.observations.map((observation) => observation.obligationType), ['finance.approval']);
  });

  it('the failing provider rejects, so the Kernel can prove an unreadable source fails closed', async () => {
    await assert.rejects(() =>
      createFailingObligationDischargeProvider().resolveObligationDischarges({
        obligationTypes: ['finance.approval'],
        correlation: CORRELATION,
        actorId: 'actor',
        trustDomainId: 'trust',
        at: NOW,
      }),
    );
  });
});
