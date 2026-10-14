import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

import type { ContextFactObservation } from '../../features/context-resolution-runtime/index.js';
import {
  checkTradingRiskReliance,
  parseTradeDelegationPolicy,
  sealTradeActiveOrderSnapshot,
  sealTradeExposureSnapshot,
  type TradeDelegationPolicy,
  type TradingRiskAssessmentEvidence,
} from '../../features/trade-runtime/index.js';
import { createXrplDelegationVerifier } from '../../features/trade-runtime/rails/xrpl/index.js';
import { DELEGATION_POLICY, exposureReading, market, ordersReading, profileData } from '../../features/trade-runtime/tests/trade-risk-fixture.js';
import { TRADE_RISK_MATERIAL_FACTS, TRADE_RISK_SIMULATION_ACKNOWLEDGEMENT, createTradeRiskContext, type TradeRiskContext, type TradeRiskSourcePorts } from '../trade-risk-context/index.js';
import { FakeXrplLedger, NETWORK, ORG, PRINCIPAL, pairWorld, rawProposal, type TradePairWorld } from './trade04c-execution-fixture.js';

/**
 * F-1 regression (TRADE-03 reliance time, corrected under TRADE-04C).
 *
 * Before: the TRADE-03 edge assessed every source fact at the Kernel's evaluation instant `at`, captured
 * before the provider was asked — so a real source that stamps its read time (TRADE-02's verifier, an
 * honest market feed) was "from the future" whenever a millisecond elapsed: 55–68 % of reads refused in
 * the original reproduction, ~100 % on the shipped Host.
 *
 * After: the edge reads the trusted Host clock once, after every source answered — the reliance instant —
 * requires `at ≤ relianceAt < binding expiry`, and assesses every fact against it with zero future
 * tolerance; readings are stated to CORE-04 at `at` and end at the same absolute, fact-derived instant.
 *
 * Every source here stamps its **real** observation time from the same trusted clock the edge uses: the
 * TRADE-02 verifier is the shipped one (over the labelled fake ledger), and nothing is back-dated. Boundary
 * cases use a deterministic clock that only moves forward unless a case is about a regression.
 */

const ACTION = 'trade.offer-create';
const ACTOR = 'actor-f1';
const IDENTITY = { principal: { plane: 'customer', principalId: PRINCIPAL, organizationId: ORG }, actor: { actorId: ACTOR } } as never;
const iso = (ms: number): string => new Date(ms).toISOString();
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The one trusted time authority of a world: the Kernel's instant, the edge's reliance instant and every honest source stamp come from it. */
interface Clock {
  now(): number;
}
const realClock: Clock = { now: () => Date.now() };
class ManualClock implements Clock {
  constructor(public ms: number) {}
  now(): number {
    return this.ms;
  }
}

interface World {
  readonly edge: TradeRiskContext;
  readonly ledger: FakeXrplLedger;
  readonly pair: TradePairWorld;
  readonly evidence: TradingRiskAssessmentEvidence[];
  readonly hooks: Hooks;
  readonly profile: Record<string, unknown>;
  readonly delegations: unknown[];
}

/** Per-source behavior a case may change. `before*` runs before the source stamps; `stamp*` decides the stamp (default: the trusted clock now). */
interface Hooks {
  beforeDelegation?: () => Promise<void> | void;
  afterDelegation?: () => Promise<void> | void;
  marketStamp?: (now: number) => string;
  marketOrganization?: string;
  marketSource?: string;
  exposureStamp?: (now: number) => string;
  ordersStamp?: (now: number) => string;
  afterSources?: () => Promise<void> | void;
}

function world(clock: Clock, options: { readonly bindingSeconds?: number; readonly profile?: Record<string, unknown>; readonly verifierClock?: Clock; readonly create?: typeof createTradeRiskContext } = {}): World {
  const delegations: unknown[] = [];
  const ledger = new FakeXrplLedger();
  const pair = pairWorld(ledger);
  const hooks: Hooks = {};
  const policy = parseTradeDelegationPolicy(DELEGATION_POLICY) as TradeDelegationPolicy;
  const verifierClock = options.verifierClock ?? clock;
  const verifier = createXrplDelegationVerifier({ port: { serverInfo: async () => ledger.serverInfo(), ledgerEntryDelegate: async (request) => ledger.ledgerEntry({ ...request }) }, network: NETWORK, clock: () => iso(verifierClock.now()), maxValidatedLedgerAgeSeconds: 10, policy });
  const stamp = (custom: ((now: number) => string) | undefined): string => (custom ?? ((now: number) => iso(now)))(clock.now());
  const ports: TradeRiskSourcePorts = {
    market: { read: async (request) => request.quotes.map((quote) => market({ organizationId: hooks.marketOrganization ?? ORG, ...(hooks.marketSource !== undefined ? { sourceId: hooks.marketSource } : {}), network: request.network as typeof NETWORK, base: request.base, quote, observedAt: stamp(hooks.marketStamp) })) },
    exposure: { read: async (request) => sealTradeExposureSnapshot(exposureReading({ organizationId: ORG, ownerAccount: request.ownerAccount, observedAt: stamp(hooks.exposureStamp) })) },
    activeOrders: { read: async (request) => sealTradeActiveOrderSnapshot(ordersReading({ organizationId: ORG, scopeKey: request.scopeKey, observedAt: stamp(hooks.ordersStamp) })) },
    delegation: {
      verify: async (request) => {
        await hooks.beforeDelegation?.();
        const assessment = await verifier.verify(request);
        delegations.push(assessment);
        await hooks.afterDelegation?.();
        return assessment;
      },
    },
  };
  const evidence: TradingRiskAssessmentEvidence[] = [];
  const t = clock.now();
  const profile = profileData({ organizationId: ORG, effectiveFrom: iso(t - 86_400_000), expiresAt: iso(t + 86_400_000), ownerAccounts: [pair.owner], delegateAccounts: [pair.delegate.address], ...options.profile });
  const edge = (options.create ?? createTradeRiskContext)({
    organizationId: ORG,
    action: ACTION,
    profile,
    ports: {
      ...ports,
      market: {
        read: async (request) => {
          const answer = await ports.market!.read(request);
          await hooks.afterSources?.();
          return answer;
        },
      },
    },
    sourceIds: { risk: 'trade-risk-assessor', delegation: 'trade-delegation-verifier' },
    bindingSeconds: options.bindingSeconds ?? 30,
    clock: () => iso(clock.now()),
    simulation: TRADE_RISK_SIMULATION_ACKNOWLEDGEMENT,
    onAssessment: (record) => evidence.push(record),
  });
  return { edge, ledger, pair, evidence, hooks, profile, delegations };
}

/** Admit a fresh proposal, then ask as the Kernel does: `at` taken from the trusted clock immediately before the provider is called. */
async function evaluate(w: World, clock: Clock, options: { readonly at?: number } = {}): Promise<{ readonly observations: readonly ContextFactObservation[]; readonly at: string; readonly intent: { readonly action: string; readonly resource: string }; readonly proposal: Record<string, unknown> }> {
  const proposal = rawProposal(w.pair, { organizationId: ORG, principalId: PRINCIPAL });
  const admission = w.edge.admitProposal(IDENTITY, proposal);
  assert.ok(admission.admitted, JSON.stringify(admission));
  const at = iso(options.at ?? clock.now());
  const out = await w.edge.provider.resolveContext({ keys: [...TRADE_RISK_MATERIAL_FACTS].sort(), actorId: ACTOR, trustDomainId: 'trust-f1', action: admission.intent.action, resourceScope: admission.intent.resource, organizationId: ORG, at });
  return { observations: out.observations, at, intent: admission.intent, proposal };
}

const admitted = (observations: readonly ContextFactObservation[]): boolean => observations.length === TRADE_RISK_MATERIAL_FACTS.length;
const refusals = (w: World): readonly string[] => (w.evidence.at(-1)?.controls ?? []).filter((control) => control.outcome !== 'SATISFIED').map((control) => `${control.control}:${control.reason}`);

describe('F-1 — honest real-time sources are relied on (the defect, fixed)', () => {
  it('A: an observation made immediately after the Kernel’s evaluation instant is admitted', async () => {
    const w = world(realClock);
    const { observations } = await evaluate(w, realClock);
    assert.ok(admitted(observations), JSON.stringify(refusals(w)));
  });

  for (const latency of [0, 2, 50]) {
    it(`B/C: ${latency} ms of source latency, 200 real-time trials: zero false refusals (a real clock regression is refused, and counted as such)`, async () => {
      const w = world(realClock);
      if (latency > 0) w.hooks.beforeDelegation = () => sleep(latency);
      let falseRefusals = 0;
      let regressionTrials = 0;
      const reasons = new Set<string>();
      for (let trial = 0; trial < 200; trial += 1) {
        // An independent witness of the host clock: if the wall clock advanced less than the monotonic clock during
        // the trial, the trusted clock stepped backwards (this WSL2 host re-syncs its clock in ~1 s backward steps).
        const wall0 = Date.now();
        const mono0 = performance.now();
        const { observations } = await evaluate(w, realClock);
        const regressed = Date.now() - wall0 < performance.now() - mono0 - 5;
        if (regressed) {
          regressionTrials += 1;
          continue; // a regression between the Kernel instant and the reliance instant must refuse (case O); either way it is no evidence of F-1
        }
        if (!admitted(observations)) {
          falseRefusals += 1;
          for (const reason of refusals(w)) reasons.add(reason);
        }
      }
      assert.equal(falseRefusals, 0, `false refusals without any clock regression: ${[...reasons].join(', ') || '(no assessment)'}`);
      assert.ok(regressionTrials < 200, 'the clock regressed in every trial: nothing was measured');
    });
  }

  it('D: a legitimate two-second source delay inside the binding’s lifetime is admitted', async () => {
    const w = world(realClock, { bindingSeconds: 30 });
    w.hooks.beforeDelegation = () => sleep(2_000);
    // A trial during which the host clock stepped backwards is no evidence either way (it must refuse: case O); re-run, at most five times.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const wall0 = Date.now();
      const mono0 = performance.now();
      const { observations, at } = await evaluate(w, realClock);
      if (Date.now() - wall0 < performance.now() - mono0 - 5) continue;
      assert.ok(admitted(observations), JSON.stringify(refusals(w)));
      assert.ok(Date.parse(w.evidence.at(-1)!.assessedAt) - Date.parse(at) >= 2_000, 'assessed at the post-collection reliance instant');
      return;
    }
    assert.fail('the host clock regressed during five consecutive two-second trials');
  });
});

describe('F-1 — every refusal still refuses (deterministic trusted clock)', () => {
  const T0 = Date.parse('2026-10-14T12:00:00.000Z');

  it('E: collection that outlives the admission binding is refused — exactly at expiry; one millisecond before is admitted', async () => {
    for (const [advanceTo, expected] of [
      [999, true],
      [1_000, false],
      [1_500, false],
    ] as const) {
      const clock = new ManualClock(T0);
      const w = world(clock, { bindingSeconds: 1 });
      w.hooks.afterSources = () => {
        clock.ms = T0 + advanceTo;
      };
      const { observations } = await evaluate(w, clock, { at: T0 });
      assert.equal(admitted(observations), expected, `relianceAt = admission + ${advanceTo} ms`);
    }
  });

  it('F: a delegation observation fresh at the Kernel’s instant but stale at the reliance instant is refused', async () => {
    const clock = new ManualClock(T0);
    const w = world(clock);
    w.hooks.afterDelegation = () => {
      clock.ms += 10_001; // the delegation policy's bound is 10 s
    };
    const { observations } = await evaluate(w, clock);
    assert.equal(admitted(observations), false);
    assert.ok(refusals(w).some((reason) => reason.startsWith('DELEGATION_VERIFIED:') && /STALE/.test(reason)), JSON.stringify(refusals(w)));
  });

  it('G, H: a stale reference price, exposure or active-order fact is refused', async () => {
    for (const [hook, control] of [
      ['marketStamp', /REFERENCE_PRICE:.*STALE/],
      ['exposureStamp', /EXPOSURE_CEILING:EXPOSURE_STALE/],
      ['ordersStamp', /ACTIVE_ORDER_LIMIT:ACTIVE_ORDER_STALE/],
    ] as const) {
      const clock = new ManualClock(T0);
      const w = world(clock);
      w.hooks[hook] = (now) => iso(now - 30_001); // each source's bound is 30 s
      const { observations } = await evaluate(w, clock);
      assert.equal(admitted(observations), false, hook);
      assert.ok(refusals(w).some((reason) => control.test(reason)), `${hook}: ${JSON.stringify(refusals(w))}`);
    }
  });

  it('I: a fact dated after the reliance instant — by 1 ms or by 60 s — is refused (no future tolerance)', async () => {
    for (const ahead of [1, 60_000]) {
      for (const hook of ['marketStamp', 'exposureStamp', 'ordersStamp'] as const) {
        const clock = new ManualClock(T0);
        const w = world(clock);
        w.hooks[hook] = (now) => iso(now + ahead);
        const { observations } = await evaluate(w, clock);
        assert.equal(admitted(observations), false, `${hook} +${ahead} ms`);
        assert.ok(refusals(w).some((reason) => /FROM_FUTURE/.test(reason)), `${hook} +${ahead}: ${JSON.stringify(refusals(w))}`);
      }
      // A delegation source whose own clock runs ahead of the trusted clock.
      const clock = new ManualClock(T0);
      const w = world(clock, { verifierClock: { now: () => clock.ms + ahead } });
      const { observations } = await evaluate(w, clock);
      assert.equal(admitted(observations), false, `delegation +${ahead} ms`);
      assert.ok(refusals(w).some((reason) => /DELEGATION_RELIANCE_FROM_FUTURE|FROM_FUTURE/.test(reason)), JSON.stringify(refusals(w)));
    }
  });

  it('J: a missing or malformed observation time, or a malformed trusted clock, is refused', async () => {
    for (const bad of ['', 'not-a-time', '2026-10-14T12:00:00Z', '2026-13-01T00:00:00.000Z']) {
      const clock = new ManualClock(T0);
      const w = world(clock);
      w.hooks.marketStamp = () => bad;
      let observations: readonly ContextFactObservation[] = [];
      try {
        ({ observations } = await evaluate(w, clock));
      } catch {
        observations = [];
      }
      assert.equal(admitted(observations), false, JSON.stringify(bad));
    }
    const clock = new ManualClock(T0);
    const w = world(clock);
    w.hooks.afterSources = () => {
      clock.ms = Number.NaN;
    };
    assert.equal(admitted((await evaluate(w, clock, { at: T0 })).observations), false, 'no reliance instant: nothing relied on');
  });

  it('K, N: another organization’s fact, a source the profile does not accept, or a revoked delegation is refused', async () => {
    const cases: readonly ((w: World) => void)[] = [
      (w) => {
        w.hooks.marketOrganization = 'org-rival';
      },
      (w) => {
        w.hooks.marketSource = 'unaccepted-market';
      },
      (w) => w.ledger.revoke(w.pair.owner, w.pair.delegate.address),
    ];
    for (const arrange of cases) {
      const clock = new ManualClock(T0);
      const w = world(clock);
      arrange(w);
      assert.equal(admitted((await evaluate(w, clock)).observations), false, String(arrange));
    }
  });

  it('L: a replayed evaluation finds no binding — the one-shot binding is unchanged', async () => {
    const clock = new ManualClock(T0);
    const w = world(clock);
    const first = await evaluate(w, clock);
    assert.ok(admitted(first.observations));
    const replay = await w.edge.provider.resolveContext({ keys: [...TRADE_RISK_MATERIAL_FACTS].sort(), actorId: ACTOR, trustDomainId: 'trust-f1', action: first.intent.action, resourceScope: first.intent.resource, organizationId: ORG, at: iso(clock.ms) });
    assert.deepEqual(replay.observations, []);
  });

  it('M: a profile that expires between the Kernel’s instant and the reliance instant is refused', async () => {
    const clock = new ManualClock(T0);
    const w = world(clock, { profile: { expiresAt: iso(T0 + 500) } });
    w.hooks.afterSources = () => {
      clock.ms = T0 + 600;
    };
    const { observations } = await evaluate(w, clock, { at: T0 + 100 });
    assert.equal(admitted(observations), false);
    assert.ok(refusals(w).some((reason) => reason.startsWith('PROFILE_IN_FORCE:')), JSON.stringify(refusals(w)));
  });

  it('O: a trusted-clock regression (reliance instant before the Kernel’s instant) is refused, never accommodated', async () => {
    const clock = new ManualClock(T0);
    const w = world(clock);
    w.hooks.afterSources = () => {
      clock.ms = T0 - 1;
    };
    assert.equal(admitted((await evaluate(w, clock, { at: T0 })).observations), false);
  });

  it('P: an expired binding (the Kernel asks after the admission lifetime) is refused before any source is asked', async () => {
    const clock = new ManualClock(T0);
    const w = world(clock, { bindingSeconds: 1 });
    let asked = false;
    w.hooks.beforeDelegation = () => {
      asked = true;
    };
    assert.equal(admitted((await evaluate(w, clock, { at: T0 + 1_000 })).observations), false);
    assert.equal(asked, false);
  });
});

describe('F-1 — evidence and validity are truthful', () => {
  const T0 = Date.parse('2026-10-14T12:00:00.000Z');

  it('Q: the sealed evidence records the reliance instant and the actual observation times; its digest verifies at the reliance instant; readings are stated at the Kernel’s instant', async () => {
    const clock = new ManualClock(T0);
    const w = world(clock);
    let delegationObserved = 0;
    w.hooks.beforeDelegation = () => {
      clock.ms = T0 + 40;
      delegationObserved = clock.ms;
    };
    w.hooks.marketStamp = (now) => iso(now); // stamped at T0 + 40 too (after delegation)
    w.hooks.afterSources = () => {
      clock.ms = T0 + 75;
    };
    const { observations, at, proposal } = await evaluate(w, clock, { at: T0 });
    assert.ok(admitted(observations), JSON.stringify(refusals(w)));
    const evidence = w.evidence.at(-1)!;
    assert.equal(evidence.assessedAt, iso(T0 + 75), 'assessedAt is the reliance instant');
    // The sealed digest verifies, at the reliance instant, for exactly this proposal and profile; not before it.
    assert.equal(checkTradingRiskReliance(evidence, { proposal, profile: w.profile, at: iso(T0 + 75) }).reliable, true);
    assert.equal(checkTradingRiskReliance(evidence, { proposal, profile: w.profile, at }).reliable, false, 'relied on before it was assessed: refused');
    for (const observation of observations) assert.equal(observation.reference !== undefined && observation.reference.length > 0, true);
    const freshness = evidence.freshness.map((entry) => entry.observedAt);
    assert.ok(freshness.includes(iso(T0 + 40)), `actual observation instants recorded: ${JSON.stringify(freshness)}`);
    assert.ok(freshness.every((stamp) => Date.parse(stamp) > Date.parse(at)), 'no recorded observation was moved to the Kernel instant');
    for (const observation of observations) {
      assert.equal(observation.observedAt, at, `${observation.key} is stated at the Kernel instant`);
      assert.equal(observation.organizationId, ORG);
    }
    assert.equal(delegationObserved, T0 + 40);
  });

  it('R: no reading’s window ends later than the facts it rests on (nothing is extended); the binding bound is the admission’s own', async () => {
    const clock = new ManualClock(T0);
    const w = world(clock);
    w.hooks.beforeDelegation = () => {
      clock.ms = T0 + 3_000;
    };
    w.hooks.afterSources = () => {
      clock.ms = T0 + 3_500;
    };
    const { observations } = await evaluate(w, clock, { at: T0 });
    assert.ok(admitted(observations), JSON.stringify(refusals(w)));
    const evidence = w.evidence.at(-1)!;
    // Absolute ends: the delegation observation + 10 s; each source fact + its bound; the assessment + 30 s.
    const delegationEnd = T0 + 3_000 + 10_000;
    const factEnds = evidence.freshness.map((entry) => Date.parse(entry.observedAt) + entry.maxAgeSeconds * 1000);
    const riskEnd = Math.min(Date.parse(evidence.assessedAt) + 30_000, ...factEnds);
    for (const observation of observations) {
      const end = Date.parse(observation.observedAt) + (observation.maxAgeSeconds ?? 0) * 1000;
      const bound = observation.key === 'trade.delegation.offercreate' ? delegationEnd : riskEnd;
      assert.ok(end <= bound, `${observation.key}: reading ends ${iso(end)}, its facts end ${iso(bound)}`);
    }
  });
});

// ── F-1 security mutations ─────────────────────────────────────────────────────

const load = createRequire(__filename);
const DIST = join(__dirname, '..', '..');
type EdgeModule = typeof import('../trade-risk-context/trade-risk-context.js');
type RelianceModule = typeof import('../../features/trade-runtime/policy/trade-risk-reliance.js');
type DelegationModule = typeof import('../../features/trade-runtime/domain/trade-delegation-assessment.js');

/**
 * `detected`: the guard holds for the shipped module and fails for the mutant. `contained`: the guard still holds
 * for the mutant because another, independent rule refuses the same case — named at each use, never hidden.
 */
async function qualify<M>(file: string, search: string, replace: string, guard: (module: M) => Promise<boolean>, expect: 'detected' | 'contained' = 'detected'): Promise<void> {
  const path = join(DIST, file);
  const source = readFileSync(path, 'utf8');
  assert.equal(source.split(search).length - 1, 1, `the mutation site occurs exactly once in ${file}`);
  const mutantPath = path.replace(/\.js$/, `.mutant-f1-${Math.random().toString(36).slice(2)}.js`);
  writeFileSync(mutantPath, source.replace(search, replace));
  try {
    assert.equal(await guard(load(path) as M), true, 'the guard holds for the shipped module');
    assert.equal(await guard(load(mutantPath) as M), expect === 'contained', expect === 'detected' ? 'the guard detects the mutant' : 'an independent rule contains the mutant');
  } finally {
    delete load.cache[load.resolve(mutantPath)];
    rmSync(mutantPath, { force: true });
  }
}

describe('F-1 mutations — each removed or relaxed check is detected', () => {
  const T0 = Date.parse('2026-10-14T12:00:00.000Z');
  const EDGE = 'enterprise/trade-risk-context/trade-risk-context.js';
  const RELIANCE = 'features/trade-runtime/policy/trade-risk-reliance.js';
  const DELEGATION = 'features/trade-runtime/domain/trade-delegation-assessment.js';

  /** Clock regression between the Kernel instant and the reliance instant must refuse (case O). */
  const refusesRegression = async (module: EdgeModule): Promise<boolean> => {
    const clock = new ManualClock(T0);
    const w = world(clock, { create: module.createTradeRiskContext });
    w.hooks.afterSources = () => {
      clock.ms = T0 - 1;
    };
    return !admitted((await evaluate(w, clock, { at: T0 })).observations);
  };
  /** Collection reaching the binding's expiry must refuse (case E boundary). */
  const refusesAtExpiry = async (module: EdgeModule): Promise<boolean> => {
    const clock = new ManualClock(T0);
    const w = world(clock, { bindingSeconds: 1, create: module.createTradeRiskContext });
    w.hooks.afterSources = () => {
      clock.ms = T0 + 1_000;
    };
    return !admitted((await evaluate(w, clock, { at: T0 })).observations);
  };
  /** An honest observation 40 ms after the Kernel instant must be admitted (the F-1 property itself). */
  const admitsHonestLateObservation = async (module: EdgeModule): Promise<boolean> => {
    const clock = new ManualClock(T0);
    const w = world(clock, { create: module.createTradeRiskContext });
    w.hooks.beforeDelegation = () => {
      clock.ms = T0 + 40;
    };
    return admitted((await evaluate(w, clock, { at: T0 })).observations);
  };
  /** A fact dated 1 ms after the reliance instant must refuse (case I). */
  const refusesFutureFact = async (module: EdgeModule): Promise<boolean> => {
    const clock = new ManualClock(T0);
    const w = world(clock, { create: module.createTradeRiskContext });
    w.hooks.marketStamp = (now) => iso(now + 1);
    return !admitted((await evaluate(w, clock)).observations);
  };

  // Contained twice over: facts stamped at the Kernel instant are after a regressed reliance instant (zero future
  // tolerance), and a reading may not be stated after the reliance instant (`readingInstantOf`, its own mutant below is detected).
  it('contained: remove the at ≤ relianceAt check', () => qualify<EdgeModule>(EDGE, 'if (relianceMs < Date.parse(at) || relianceMs >= entry.expiresAtMs)', 'if (relianceMs >= entry.expiresAtMs)', refusesRegression, 'contained'));
  it('remove the binding-expiry check', () => qualify<EdgeModule>(EDGE, 'if (relianceMs < Date.parse(at) || relianceMs >= entry.expiresAtMs)', 'if (relianceMs < Date.parse(at))', refusesAtExpiry));
  it('relax the binding-expiry check (strictly inside → inclusive)', () => qualify<EdgeModule>(EDGE, 'if (relianceMs < Date.parse(at) || relianceMs >= entry.expiresAtMs)', 'if (relianceMs < Date.parse(at) || relianceMs > entry.expiresAtMs)', refusesAtExpiry));
  it('evaluate freshness against the earlier Kernel instant again', () => qualify<EdgeModule>(EDGE, 'assessedAt: relianceAt,', 'assessedAt: at,', admitsHonestLateObservation));
  // Contained: the projection re-checks the sealed evidence at the true reliance instant, and evidence assessed after it is RISK_RELIANCE_FROM_FUTURE.
  it('contained: assess 60 s later than the trusted clock (would accept later observations)', () => qualify<EdgeModule>(EDGE, 'assessedAt: relianceAt,', 'assessedAt: new Date(relianceMs + 60000).toISOString(),', refusesFutureFact, 'contained'));
  it('accept a source fact observed after the assessment instant (the shared freshness primitive)', () =>
    qualify<typeof import('../../features/trade-runtime/policy/trade-risk-exact.js')>('features/trade-runtime/policy/trade-risk-exact.js', '    if (age < 0)\n        return \'future\';', '', async (module) => {
      const relianceAt = iso(T0);
      return module.freshnessAt(iso(T0 + 1), 30, relianceAt) === 'future' && module.freshnessAt(iso(T0 + 60_000), 30, relianceAt) === 'future' && module.freshnessAt(iso(T0), 30, relianceAt) === 'fresh';
    }));
  it('accept a TRADE-02 assessment observed after the reliance instant', () =>
    qualify<DelegationModule>(DELEGATION, '    if (ageMs < 0)\n        return refuse(R.FROM_FUTURE);', '', async (module) => {
      const clock = new ManualClock(T0);
      const w = world(clock, { verifierClock: { now: () => clock.ms + 1 } });
      const { proposal } = await evaluate(w, clock);
      const validation = (await import('../../features/trade-runtime/index.js')).validateTradeProposal(proposal);
      assert.ok(validation.valid);
      return !module.checkTradeDelegationReliance(w.delegations.at(-1), { proposal: validation.accepted.proposal, proposalDigest: validation.accepted.digest, at: iso(T0), policy: DELEGATION_POLICY as never }).reliable;
    }));

  /** Every projected reading's window ends no later than its facts (case R), computed on a captured, admitted evaluation. */
  const noExtension = async (module: RelianceModule): Promise<boolean> => {
    const clock = new ManualClock(T0);
    const w = world(clock);
    w.hooks.beforeDelegation = () => {
      clock.ms = T0 + 3_000;
    };
    w.hooks.afterSources = () => {
      clock.ms = T0 + 3_500;
    };
    const { observations, at, proposal, intent } = await evaluate(w, clock, { at: T0 });
    assert.ok(admitted(observations));
    const evidence = w.evidence.at(-1)!;
    const query = { action: intent.action, resourceScope: intent.resource, organizationId: ORG };
    const risk = module.tradingRiskContextReadings(evidence, { proposal, profile: w.profile, at: evidence.assessedAt, readingAt: at }, query);
    const delegated = module.tradeDelegationContextReading(w.delegations.at(-1), { proposal, at: evidence.assessedAt, readingAt: at, policy: DELEGATION_POLICY as never, action: ACTION }, query);
    if (!risk.projected || !delegated.projected) return false;
    const riskEnd = Math.min(Date.parse(evidence.assessedAt) + 30_000, ...evidence.freshness.map((entry) => Date.parse(entry.observedAt) + entry.maxAgeSeconds * 1000));
    const end = (reading: { readonly observedAt: string; readonly maxAgeSeconds?: number }): number => Date.parse(reading.observedAt) + (reading.maxAgeSeconds ?? 0) * 1000;
    return risk.readings.every((reading) => end(reading) <= riskEnd) && end(delegated.reading) <= T0 + 3_000 + 10_000;
  };
  it('extend the risk readings’ validity', () => qualify<RelianceModule>(RELIANCE, 'wholeSecondsBetween(readingAt.ms, reliance.validUntilMs)', 'wholeSecondsBetween(readingAt.ms, reliance.validUntilMs + 60000)', noExtension));
  it('extend the delegation reading’s validity', () => qualify<RelianceModule>(RELIANCE, 'wholeSecondsBetween(readingAt.ms, freshUntilMs)', 'wholeSecondsBetween(readingAt.ms, freshUntilMs + 60000)', noExtension));
  it('state a reading after the reliance instant', () =>
    qualify<RelianceModule>(RELIANCE, 'return reading <= reliance ?', 'return true ?', async (module) => {
      const clock = new ManualClock(T0);
      const w = world(clock);
      const { observations, proposal, intent } = await evaluate(w, clock);
      assert.ok(admitted(observations));
      const evidence = w.evidence.at(-1)!;
      const later = iso(Date.parse(evidence.assessedAt) + 1);
      const risk = module.tradingRiskContextReadings(evidence, { proposal, profile: w.profile, at: evidence.assessedAt, readingAt: later }, { action: intent.action, resourceScope: intent.resource, organizationId: ORG });
      return !risk.projected;
    }));
});
