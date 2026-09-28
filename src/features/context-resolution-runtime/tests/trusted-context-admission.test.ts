import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  ContextConfigurationError,
  ContextResolutionService,
  contextObservationProvenanceDigest,
  contextResolutionDigest,
  readContextFact,
  validateContextSource,
  type ContextDeclaration,
  type ContextFactObservation,
  type ContextSource,
} from '../index.js';

/**
 * CORE-04 — the Trusted Context Boundary, at the unit level.
 *
 * Every case here is a *reading* crossing `ContextResolutionService.classify`
 * — the one admission point — and the question each answers is whether that
 * reading may become a fact a policy can read, and if not, why not. The Host
 * end-to-end suites repeat the security-relevant ones through
 * `bootEnterpriseHost()`.
 */

const ORG = 'org-a';
const NOW = '2026-09-28T12:00:00.000Z';
const minutesAgo = (minutes: number): string => new Date(Date.parse(NOW) - minutes * 60_000).toISOString();
const secondsAgo = (seconds: number): string => new Date(Date.parse(NOW) - seconds * 1000).toISOString();

const ERP: ContextSource = {
  id: 'erp-primary',
  kind: 'erp',
  name: 'ERP (primary)',
  trustClass: 'authoritative',
  organizationId: ORG,
  provenance: 'reference-digest',
  attests: [
    { factClass: 'invoice.exists', maxAgeSeconds: 900 },
    { factClass: 'invoice.amount', maxAgeSeconds: 900 },
  ],
};
const REGISTRY: ContextSource = {
  id: 'wallet-registry',
  kind: 'external_api',
  name: 'Destination registry',
  trustClass: 'authoritative',
  organizationId: ORG,
  provenance: 'reference-digest',
  attests: [{ factClass: 'destination.registered', maxAgeSeconds: 900 }],
};
const OTHER_ORG_ERP: ContextSource = { ...ERP, id: 'erp-org-b', organizationId: 'org-b' };

const DECLARATION: ContextDeclaration = {
  requirements: [
    { key: 'invoice.exists', minimumTrustClass: 'authoritative', required: true },
    { key: 'invoice.amount', minimumTrustClass: 'authoritative', required: true },
    { key: 'destination.registered', minimumTrustClass: 'authoritative', required: true },
  ],
};

function service(sources: readonly ContextSource[] = [ERP, REGISTRY, OTHER_ORG_ERP], declaration: ContextDeclaration = DECLARATION): ContextResolutionService {
  return new ContextResolutionService({ sources, declaration });
}

/** A reading as a connector would take it: provenance digest computed over the whole reading. */
function reading(key: string, value: string | number | boolean, sourceId: string, observedAt = minutesAgo(1), extra: Partial<ContextFactObservation> = {}): ContextFactObservation {
  const reference = extra.reference ?? `${sourceId}:${key}:ref-1`;
  const base = { key, value, sourceId, observedAt, reference, ...(extra.organizationId !== undefined ? { organizationId: extra.organizationId } : {}) };
  return { ...base, provenanceDigest: contextObservationProvenanceDigest(base), ...extra };
}

const GOOD = [reading('invoice.exists', true, 'erp-primary'), reading('invoice.amount', 500, 'erp-primary'), reading('destination.registered', true, 'wallet-registry')];

function satisfied(resolution: ReturnType<ContextResolutionService['classify']>, key: string): boolean {
  const requirement = DECLARATION.requirements.find((entry) => entry.key === key);
  assert.ok(requirement !== undefined);
  return readContextFact(resolution, requirement).status === 'satisfied';
}

describe('CORE-04 — admission: a configured, in-scope source, fresh and provenance-valid', () => {
  it('admits every reading, and each fact keeps its source, reference and verified provenance digest', () => {
    const resolution = service().classify(GOOD, NOW, ORG);
    assert.deepEqual(resolution.refused, []);
    assert.deepEqual(resolution.unresolved, []);
    for (const key of ['invoice.exists', 'invoice.amount', 'destination.registered']) assert.equal(satisfied(resolution, key), true, key);
    const amount = resolution.facts.find((fact) => fact.key === 'invoice.amount');
    assert.equal(amount?.value, 500);
    assert.equal(amount?.sourceId, 'erp-primary');
    assert.equal(amount?.reference, 'erp-primary:invoice.amount:ref-1');
    assert.equal(amount?.provenanceDigest, GOOD[1]?.provenanceDigest);
    assert.equal(amount?.freshness?.maxAgeSeconds, 900, 'the source is the canonical freshness owner');
  });
});

describe('CORE-04 §53 — same fact, same value, wrong source: value equality is not trust equality', () => {
  it('a trusted source is admitted; an unconfigured, a wrong-scope and another organization’s source are refused', () => {
    const cases: readonly [ContextFactObservation, string][] = [
      [reading('invoice.exists', true, 'random-api'), 'source_untrusted'],
      [reading('invoice.exists', true, 'wallet-registry'), 'fact_class_not_attested'],
      [reading('invoice.exists', true, 'erp-org-b'), 'organization_mismatch'],
    ];
    for (const [candidate, reason] of cases) {
      const resolution = service().classify([candidate, GOOD[1] as ContextFactObservation, GOOD[2] as ContextFactObservation], NOW, ORG);
      assert.deepEqual(resolution.refused, [{ key: 'invoice.exists', sourceId: candidate.sourceId, reason }], candidate.sourceId);
      assert.deepEqual(resolution.unresolved, ['invoice.exists']);
      assert.equal(satisfied(resolution, 'invoice.exists'), false);
      assert.equal(resolution.facts.some((fact) => fact.key === 'invoice.exists'), false, 'a refused reading never becomes a fact');
    }
    const trusted = service().classify(GOOD, NOW, ORG);
    assert.equal(satisfied(trusted, 'invoice.exists'), true);
  });
});

describe('CORE-04 §54 — source overreach: authority to attest is per fact class', () => {
  it('a source authorized for invoice.* attesting destination.registered is refused, whatever the value', () => {
    for (const value of [true, false]) {
      const resolution = service().classify([GOOD[0] as ContextFactObservation, GOOD[1] as ContextFactObservation, reading('destination.registered', value, 'erp-primary')], NOW, ORG);
      assert.deepEqual(resolution.refused, [{ key: 'destination.registered', sourceId: 'erp-primary', reason: 'fact_class_not_attested' }]);
      assert.equal(satisfied(resolution, 'destination.registered'), false);
    }
  });

  it('a source must name the classes it may attest: none, a malformed one, a case-only duplicate or an out-of-range bound is refused at configuration', () => {
    const invalid: readonly Partial<ContextSource>[] = [
      { attests: [] },
      { attests: [{ factClass: 'Not A Class' }] },
      { attests: [{ factClass: 'invoice.exists' }, { factClass: 'Invoice.Exists' }] },
      { attests: [{ factClass: 'invoice.exists', maxAgeSeconds: 0 }] },
      { attests: [{ factClass: 'invoice.exists', maxAgeSeconds: 1.5 }] },
      { attests: [{ factClass: 'invoice.exists', maxAgeSeconds: 8 * 24 * 3600 }] },
    ];
    for (const override of invalid) {
      assert.ok(validateContextSource({ ...ERP, ...override }).length > 0, JSON.stringify(override));
      assert.throws(() => service([{ ...ERP, ...override }]), ContextConfigurationError);
    }
  });
});

describe('CORE-04 §55 — freshness: same source, value and provenance, different time', () => {
  it('fresh is admitted; exactly on the boundary and beyond it is stale — reported, never readable as satisfied', () => {
    const at = (observedAt: string): ReturnType<ContextResolutionService['classify']> =>
      service().classify([reading('invoice.exists', true, 'erp-primary', observedAt), GOOD[1] as ContextFactObservation, GOOD[2] as ContextFactObservation], NOW, ORG);
    const fresh = at(secondsAgo(899));
    assert.equal(satisfied(fresh, 'invoice.exists'), true);
    const boundary = at(secondsAgo(900));
    assert.deepEqual(boundary.stale, ['invoice.exists'], 'exactly maxAgeSeconds old is stale — the boundary is exclusive');
    assert.equal(readContextFact(boundary, DECLARATION.requirements[0] as never).status, 'stale');
    assert.equal(readContextFact(boundary, DECLARATION.requirements[0] as never).value, undefined, 'a stale value is not offered to a rule');
    const stale = at(minutesAgo(60));
    assert.deepEqual(stale.stale, ['invoice.exists']);
  });

  it('a requirement or the reading itself may tighten the source’s bound, never relax it', () => {
    const tightened = service([ERP, REGISTRY], { requirements: [{ key: 'invoice.exists', minimumTrustClass: 'authoritative', required: true, maxAgeSeconds: 60 }] });
    assert.deepEqual(tightened.classify([reading('invoice.exists', true, 'erp-primary', secondsAgo(120))], NOW, ORG).stale, ['invoice.exists']);
    const relaxed = service([ERP, REGISTRY], { requirements: [{ key: 'invoice.exists', minimumTrustClass: 'authoritative', required: true, maxAgeSeconds: 86_400 }] });
    assert.deepEqual(relaxed.classify([reading('invoice.exists', true, 'erp-primary', minutesAgo(60))], NOW, ORG).stale, ['invoice.exists'], 'a longer requirement bound does not relax the source’s 900 s');
    const selfRelaxing = { ...reading('invoice.exists', true, 'erp-primary', minutesAgo(60)), maxAgeSeconds: 86_400 };
    assert.deepEqual(service().classify([selfRelaxing], NOW, ORG).stale, ['invoice.exists'], 'a reading cannot relax its own bound');
    const malformedBound = { ...reading('invoice.exists', true, 'erp-primary', secondsAgo(5)), maxAgeSeconds: -1 };
    assert.deepEqual(service().classify([malformedBound], NOW, ORG).stale, ['invoice.exists'], 'a malformed self-stated bound is treated as already stale');
  });

  it('a future-dated or unparseable reading is refused, never clamped; declared skew is honoured and bounded', () => {
    const future = reading('invoice.exists', true, 'erp-primary', new Date(Date.parse(NOW) + 1000).toISOString());
    assert.deepEqual(service().classify([future], NOW, ORG).refused, [{ key: 'invoice.exists', sourceId: 'erp-primary', reason: 'future_dated' }]);
    const tolerated = service([ERP], { requirements: [{ key: 'invoice.exists', minimumTrustClass: 'authoritative', required: true }], maxFutureSkewSeconds: 5 });
    assert.deepEqual(tolerated.classify([future], NOW, ORG).refused, [], 'within the declared skew');
    assert.throws(() => service([ERP], { requirements: [], maxFutureSkewSeconds: 301 }), ContextConfigurationError);
    const garbage = { key: 'invoice.exists', value: true, sourceId: 'erp-primary', observedAt: 'yesterday-ish', reference: 'r', provenanceDigest: 'sha256:0' };
    assert.deepEqual(service().classify([garbage], NOW, ORG).refused, [{ key: 'invoice.exists', sourceId: 'erp-primary', reason: 'observation_time_invalid' }]);
  });
});

describe('CORE-04 §56 — provenance tamper', () => {
  it('changing any covered field after the digest was taken — value, reference, time, organization or the digest — is refused', () => {
    const original = reading('invoice.amount', 500, 'erp-primary');
    const tampered: readonly ContextFactObservation[] = [
      { ...original, value: 50_000 },
      { ...original, reference: 'erp-primary:invoice.amount:ref-2' },
      { ...original, observedAt: secondsAgo(1) },
      { ...original, organizationId: ORG },
      { ...original, provenanceDigest: `sha256:${'0'.repeat(64)}` },
      { key: original.key, value: original.value, sourceId: original.sourceId, observedAt: original.observedAt },
      { ...original, reference: '' },
    ];
    for (const candidate of tampered) {
      const resolution = service().classify([candidate], NOW, ORG);
      assert.deepEqual(resolution.refused, [{ key: 'invoice.amount', sourceId: 'erp-primary', reason: 'provenance_invalid' }], JSON.stringify(candidate));
      assert.equal(resolution.facts.length, 0);
    }
    assert.deepEqual(service().classify([original], NOW, ORG).refused, []);
  });
});

describe('CORE-04 §57 / §99 — organization scope', () => {
  it('a reading claiming another organization is refused even from an in-scope source; a request with no organization cannot use a scoped source', () => {
    assert.deepEqual(service().classify([reading('invoice.exists', true, 'erp-primary', minutesAgo(1), { organizationId: 'org-b' })], NOW, ORG).refused, [
      { key: 'invoice.exists', sourceId: 'erp-primary', reason: 'organization_mismatch' },
    ]);
    assert.deepEqual(service().classify([reading('invoice.exists', true, 'erp-primary', minutesAgo(1), { organizationId: ORG })], NOW, ORG).refused, []);
    assert.deepEqual(service().classify(GOOD.slice(0, 1), NOW, undefined).refused, [{ key: 'invoice.exists', sourceId: 'erp-primary', reason: 'organization_mismatch' }]);
    // A reading copied verbatim into another organization's request is refused there.
    assert.deepEqual(service().classify(GOOD.slice(0, 1), NOW, 'org-b').refused, [{ key: 'invoice.exists', sourceId: 'erp-primary', reason: 'organization_mismatch' }]);
  });
});

describe('CORE-04 §50 — value types: exact, bounded, no floating point', () => {
  it('refuses non-integer numbers, -0, non-finite numbers, empty or oversized strings and structured values', () => {
    for (const value of [0.5, -0, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 60, '', 'x'.repeat(257), { amount: 500 }, ['a'], null]) {
      const candidate = { ...reading('invoice.amount', 1, 'erp-primary'), value: value as never };
      assert.deepEqual(service().classify([candidate], NOW, ORG).refused, [{ key: 'invoice.amount', sourceId: 'erp-primary', reason: 'value_malformed' }], String(value));
    }
  });
});

describe('CORE-04 §16 — missing ≠ false ≠ stale ≠ unverifiable ≠ unauthorized', () => {
  it('each is a distinct, reported state, and only an admitted `false` is a value', () => {
    const present = (value: boolean) => service().classify([reading('invoice.exists', value, 'erp-primary')], NOW, ORG);
    const trueRead = readContextFact(present(true), DECLARATION.requirements[0] as never);
    const falseRead = readContextFact(present(false), DECLARATION.requirements[0] as never);
    assert.deepEqual([trueRead.status, trueRead.value], ['satisfied', true]);
    assert.deepEqual([falseRead.status, falseRead.value], ['satisfied', false], 'an admitted false is a fact, not an absence');
    const missing = service().classify([], NOW, ORG);
    assert.equal(readContextFact(missing, DECLARATION.requirements[0] as never).status, 'unresolved');
    assert.equal(readContextFact(missing, DECLARATION.requirements[0] as never).value, undefined);
    const stale = service().classify([reading('invoice.exists', false, 'erp-primary', minutesAgo(60))], NOW, ORG);
    assert.equal(readContextFact(stale, DECLARATION.requirements[0] as never).status, 'stale');
    const unverifiable = service().classify([{ ...reading('invoice.exists', false, 'erp-primary'), provenanceDigest: 'sha256:bad' }], NOW, ORG);
    assert.equal(readContextFact(unverifiable, DECLARATION.requirements[0] as never).status, 'unresolved');
    assert.deepEqual(unverifiable.refused.map((entry) => entry.reason), ['provenance_invalid']);
    const unauthorized = service().classify([reading('invoice.exists', false, 'random-api')], NOW, ORG);
    assert.deepEqual(unauthorized.refused.map((entry) => entry.reason), ['source_untrusted']);
  });
});

describe('CORE-04 §17 / §18 — conflicts and duplicates', () => {
  const SECOND_ERP: ContextSource = { ...ERP, id: 'erp-secondary' };

  it('two trusted sources disagreeing is conflicted — both reported, neither chosen, never last-writer-wins', () => {
    const first = service([ERP, SECOND_ERP]).classify([reading('invoice.exists', true, 'erp-primary'), reading('invoice.exists', false, 'erp-secondary')], NOW, ORG);
    const second = service([ERP, SECOND_ERP]).classify([reading('invoice.exists', false, 'erp-secondary'), reading('invoice.exists', true, 'erp-primary')], NOW, ORG);
    assert.deepEqual(first.conflicted, ['invoice.exists']);
    assert.equal(readContextFact(first, DECLARATION.requirements[0] as never).status, 'conflicted');
    assert.deepEqual(
      first.facts.map((fact) => [fact.sourceId, fact.value, fact.conflictingSourceIds]),
      [
        ['erp-primary', true, ['erp-secondary']],
        ['erp-secondary', false, ['erp-primary']],
      ],
    );
    assert.equal(contextResolutionDigest(first), contextResolutionDigest(second), 'arrival order changes nothing');
  });

  it('repeated identical readings collapse to one fact, in any order, with one digest — a duplicate multiplies nothing', () => {
    const once = service().classify(GOOD, NOW, ORG);
    const repeated = service().classify([...GOOD, ...GOOD, GOOD[0] as ContextFactObservation], NOW, ORG);
    const reversed = service().classify([...GOOD].reverse(), NOW, ORG);
    assert.equal(repeated.facts.length, 3);
    assert.equal(contextResolutionDigest(repeated), contextResolutionDigest(once));
    assert.equal(contextResolutionDigest(reversed), contextResolutionDigest(once));
  });

  it('a source contradicting itself is conflicted too', () => {
    const resolution = service().classify([reading('invoice.exists', true, 'erp-primary'), reading('invoice.exists', false, 'erp-primary', minutesAgo(2), { reference: 'ref-2' })], NOW, ORG);
    assert.deepEqual(resolution.conflicted, ['invoice.exists']);
  });
});

describe('CORE-04 §43 / §77 — the admitted-context digest', () => {
  it('is deterministic, and moves with any admitted value, source, time, refusal or the resolution instant', () => {
    const base = contextResolutionDigest(service().classify(GOOD, NOW, ORG));
    assert.match(base, /^sha256:[0-9a-f]{64}$/);
    assert.equal(contextResolutionDigest(service().classify(GOOD, NOW, ORG)), base);
    const variants = [
      service().classify([GOOD[0] as ContextFactObservation, reading('invoice.amount', 501, 'erp-primary'), GOOD[2] as ContextFactObservation], NOW, ORG),
      service().classify([reading('invoice.exists', true, 'erp-primary', minutesAgo(2)), GOOD[1] as ContextFactObservation, GOOD[2] as ContextFactObservation], NOW, ORG),
      service().classify([...GOOD, reading('invoice.exists', true, 'random-api')], NOW, ORG),
      service().classify(GOOD, secondsAgo(-1), ORG),
      service().classify(GOOD.slice(0, 2), NOW, ORG),
    ];
    for (const variant of variants) assert.notEqual(contextResolutionDigest(variant), base);
  });
});
