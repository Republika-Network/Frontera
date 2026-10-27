// RSDK-02B — the governed sovereign receiver, in process: the real G-02 pipeline (Host-built requests, signed
// presentations, pinned issuer keys), the real consumption ledger, the real synthetic effect and real receipts.
// Only the injected sovereign verifier is a double here; rsdk02-governed-receiver.e2e.test.mjs uses RSDK-01 itself.
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { decodeExecutorReceiptTransport, EXECUTOR_RECEIPT_TRANSPORT_HEADER } from '../executor-receipt/index.js';
import { openExecutionCapabilityConsumptionLedger, type ExecutionCapabilityConsumptionLedger } from '../execution-capability/reference/consumption-ledger.js';
import { createGovernedSovereignReceiver, type GovernedReceiverAnswer, type GovernedSovereignReceiverOptions, type SovereignAssetEligibilityPolicy } from '../governed-receiver/index.js';
import { createDemonstrationAssetPolicy } from '../governed-receiver/demonstration-policy.js';
import { createReferenceExecutorVerificationPipeline, parseReferenceExecutorConfiguration, type ObservedHttpRequest, type ReferenceExecutorFaultPoint } from '../reference-executor/index.js';
import { createExecutorReceiptIssuer, type ExecutorReceiptIssuer } from '../reference-executor/receipt-issuer.js';
import { openExecutorReceiptLedger } from '../reference-executor/receipt-ledger.js';
import { loadExecutorReceiptSigner } from '../reference-executor/receipt-signer.js';
import { admitsEffect, openSyntheticDeploymentEffect, type SyntheticDeploymentEffect, type SyntheticEffectObservation } from '../reference-executor/synthetic-effect.js';
import {
  ACTION,
  AUDIENCE,
  EXECUTOR_ENVIRONMENT,
  EXECUTOR_ID,
  ISSUER,
  ISSUER_KEY,
  ORGANIZATION,
  RESOURCE,
  TRUST_DOMAIN,
  UNPINNED_KEY,
  capabilityFor,
  executorConfiguration,
  hostVector,
  observedWith,
  presentationFor,
  setRawHeader,
  validatedAction,
  type HostVector,
} from './g02c1a-reference-executor-fixture.js';
import { SYNTHETIC_ACTION } from './g02c1b-synthetic-execution-fixture.js';
import { BINDING_FORMAT, ISSUER_PINS, RECEIPT_KEY_ID, receiptConfiguration, receiptDomain, type ReceiptDomain } from './g02c1c-executor-receipt-fixture.js';

const REGISTRANT = 'did:example:rsdk02-registrant';
const FOREIGN = 'did:example:rsdk02-foreign';
const ASSET = 'aoc:sovereign-asset:6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b';
const OTHER_ASSET = 'aoc:sovereign-asset:0a1b2c3d-4e5f-4a6b-9c7d-8e9f0a1b2c3d';
const BUNDLE = '{"synthetic":"bundle"}';

// ── the injected ports ──────────────────────────────────────────────────────────

type State = 'active' | 'disputed' | 'withdrawn' | 'superseded';

/** An RSDK-01-shaped verified result (the double stands in for the deployment's composed verifier). */
function verifiedResult(sovereignAssetId: string, options: { readonly state?: State; readonly claims?: readonly { readonly claimType: string; readonly issuer: string }[]; readonly overrides?: Record<string, unknown> } = {}): unknown {
  const state = options.state ?? 'active';
  const claims = (options.claims ?? [{ claimType: 'Origin', issuer: REGISTRANT }]).map((claim, index) => Object.freeze({ claimId: `claim-${index}`, claimType: claim.claimType, issuer: claim.issuer, keyId: 'registrant-key' }));
  return Object.freeze({
    outcome: 'verified',
    profile: 'aoc-enterprise.strict-receiver-verification/1',
    authorization: 'not_evaluated',
    revocation: 'not_evaluated',
    freshness: 'not_evaluated',
    sovereignAssetId,
    currentManifestVersion: 1,
    currentManifestBasis: 'highest_version_in_bundle',
    currentIssuer: REGISTRANT,
    currentState: state,
    contentIdentity: 'verified',
    compatibility: 'compatible',
    standings: 'none',
    manifests: Object.freeze([Object.freeze({ manifestVersion: 1, manifestDigest: `sha256:${'a'.repeat(64)}`, issuer: REGISTRANT, keyId: 'registrant-key', state })]),
    claims: Object.freeze(claims),
    reasons: Object.freeze([]),
    ...options.overrides,
  });
}

const rejectedResult = (reasons: readonly string[]) =>
  Object.freeze({ outcome: 'rejected', profile: 'aoc-enterprise.strict-receiver-verification/1', authorization: 'not_evaluated', revocation: 'not_evaluated', freshness: 'not_evaluated', reasons: Object.freeze([...reasons]) });

const demonstrationPolicy = createDemonstrationAssetPolicy({
  trustedRegistrants: [REGISTRANT],
  operations: { [SYNTHETIC_ACTION]: { claimTypes: ['Origin'], requiredClaimTypes: ['Origin'] } },
});

/** Timers the test fires itself: no sleeps, no races. */
function manualScheduler() {
  const pending = new Set<() => void>();
  return {
    schedule: (_ms: number, fire: () => void) => {
      pending.add(fire);
      return () => pending.delete(fire);
    },
    fireAll: () => {
      for (const fire of [...pending]) {
        pending.delete(fire);
        fire();
      }
    },
    get size() {
      return pending.size;
    },
  };
}

/** A promise the test resolves; used to hold a port open deterministically. */
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

const flush = () => new Promise<void>((done) => setImmediate(done));

// ── one receiver over real G-02 parts ───────────────────────────────────────────

interface World {
  readonly domain: ReceiptDomain;
  readonly ledger: ExecutionCapabilityConsumptionLedger;
  readonly issuer: ExecutorReceiptIssuer;
  readonly events: string[];
  readonly verifyCalls: { readonly bundleText: string; readonly expectedSovereignAssetId: string; readonly contentBytes?: Uint8Array }[];
  handle(observed: ObservedHttpRequest): Promise<GovernedReceiverAnswer>;
  close(): void;
}

interface WorldOptions {
  readonly assets?: GovernedSovereignReceiverOptions['assets'];
  readonly verify?: (bundleText: string, expectedSovereignAssetId: string) => unknown;
  readonly policy?: SovereignAssetEligibilityPolicy;
  readonly limits?: GovernedSovereignReceiverOptions['limits'];
  readonly schedule?: GovernedSovereignReceiverOptions['schedule'];
  readonly clock?: () => number;
  readonly fault?: (point: ReferenceExecutorFaultPoint) => void;
  readonly observe?: (observation: SyntheticEffectObservation) => SyntheticEffectObservation;
  readonly effectThrows?: boolean;
  readonly claimThrows?: boolean;
}

const worlds: World[] = [];
after(() => {
  for (const world of worlds) world.close();
});

async function world(options: WorldOptions = {}): Promise<World> {
  const domain = await receiptDomain();
  const configuration = parseReferenceExecutorConfiguration(receiptConfiguration(domain), EXECUTOR_ENVIRONMENT);
  const clock = options.clock ?? (() => Date.now());
  const opened = await openExecutionCapabilityConsumptionLedger(domain.ledgerPath, { audience: AUDIENCE, clock });
  const events: string[] = [];
  const ledger: ExecutionCapabilityConsumptionLedger = Object.freeze({
    audience: opened.audience,
    claim: (verification: unknown) => {
      events.push('claim');
      if (options.claimThrows === true) throw new Error('ledger unavailable');
      const claim = opened.claim(verification);
      events.push(`claim:${claim.outcome}`);
      return claim;
    },
    recordOutcome: (capabilityId: string, outcome: Parameters<ExecutionCapabilityConsumptionLedger['recordOutcome']>[1]) => {
      events.push(`record:${outcome}`);
      return opened.recordOutcome(capabilityId, outcome);
    },
    read: (capabilityId: string) => opened.read(capabilityId),
    readExecution: (issuer: string, executionId: string) => opened.readExecution(issuer, executionId),
    readDetail: (capabilityId: string) => opened.readDetail(capabilityId),
    listUnresolved: (page?: Parameters<ExecutionCapabilityConsumptionLedger['listUnresolved']>[0]) => opened.listUnresolved(page),
    close: () => opened.close(),
  });
  const real = openSyntheticDeploymentEffect({ outputDirectory: domain.outputDirectory, durablyClaimed: (capabilityId) => admitsEffect(opened.read(capabilityId).state) });
  const effect: SyntheticDeploymentEffect = Object.freeze({
    outputDirectory: real.outputDirectory,
    apply: (input: Parameters<SyntheticDeploymentEffect['apply']>[0], during?: () => void) => {
      events.push(`effect-start:${opened.read(input.capabilityId).state}`);
      if (options.effectThrows === true) throw new Error('effect interrupted');
      const observed = real.apply(input, during);
      const reported = options.observe === undefined ? observed : options.observe(observed);
      events.push(`effect:${reported}`);
      return reported;
    },
  });
  const receiptLedger = await openExecutorReceiptLedger(domain.receiptLedgerPath, { executorId: EXECUTOR_ID, audience: AUDIENCE, clock });
  const signer = loadExecutorReceiptSigner({ executorId: EXECUTOR_ID, keyId: RECEIPT_KEY_ID, privateKeyFile: domain.keyFile, receiptLedger, issuerKeys: ISSUER_PINS });
  const issuer = createExecutorReceiptIssuer({ executorId: EXECUTOR_ID, audience: AUDIENCE, bindingFormat: BINDING_FORMAT, consumption: opened, receipts: receiptLedger, signer, outputDirectory: domain.outputDirectory });
  const verifyCalls: World['verifyCalls'] = [];
  const store = options.assets ?? { load: (id: string) => (id === ASSET || id === OTHER_ASSET ? { bundleText: BUNDLE } : undefined) };
  const receiver = createGovernedSovereignReceiver({
    configuration,
    ledger,
    effect,
    clock,
    receipts: issuer,
    ...(options.fault !== undefined ? { fault: options.fault } : {}),
    assets: { load: (id, limits) => { events.push(`load:${id}`); return store.load(id, limits); } },
    verifyAsset: async (bundleText, request) => {
      verifyCalls.push({ bundleText, ...request });
      events.push('verify-asset');
      return options.verify === undefined ? verifiedResult(request.expectedSovereignAssetId) : options.verify(bundleText, request.expectedSovereignAssetId);
    },
    policy: async (input) => {
      events.push('policy');
      return (options.policy ?? demonstrationPolicy)(input);
    },
    ...(options.limits !== undefined ? { limits: options.limits } : {}),
    ...(options.schedule !== undefined ? { schedule: options.schedule } : {}),
  });
  const built: World = {
    domain,
    ledger,
    issuer,
    events,
    verifyCalls,
    handle: (observed) => receiver.handle(observed),
    close: () => {
      opened.close();
      receiptLedger.close();
      domain.cleanup();
    },
  };
  worlds.push(built);
  return built;
}

/** The Host's real mapper and binding for one synthetic action on `resource`. */
function vectorFor(resource: string, action: string = SYNTHETIC_ACTION): HostVector {
  return hostVector(`rsdk02:${resource}`, {}, validatedAction({ action, resource }));
}

/** A governed request for `resource`, presented with a capability signed for exactly that request. */
function governed(resource: string = ASSET, capability: Record<string, unknown> = {}, options: Parameters<typeof observedWith>[1] = {}): ObservedHttpRequest {
  const action = (capability['action'] as string | undefined) ?? SYNTHETIC_ACTION;
  return observedWith(vectorFor(resource, action), { capability: { action, resource, ...capability }, ...options });
}

function assertNothingSpent(w: World, answer: GovernedReceiverAnswer): void {
  assert.equal(w.events.includes('claim'), false, `nothing may be claimed: ${w.events.join(' ')}`);
  assert.equal(w.events.some((event) => event.startsWith('effect')), false, 'no effect may run');
  assert.equal(w.domain.records().length, 0, 'no synthetic record may exist');
  assert.equal(answer.record.ledgerState, null);
  assert.deepEqual(answer.headers, {});
}

function assertRefusedBeforeAsset(w: World, answer: GovernedReceiverAnswer, code: string): void {
  assert.equal(answer.record.outcome, 'refused', JSON.stringify(answer.record));
  assert.equal(answer.record.code, code);
  assert.deepEqual(w.verifyCalls, [], 'an unverified capability never reaches the asset gate');
  assert.equal(w.events.some((event) => event.startsWith('load:')), false);
  assertNothingSpent(w, answer);
}

function assertAssetRefusal(w: World, answer: GovernedReceiverAnswer, code: string, status: number): void {
  assert.equal(answer.record.mode, 'governed-sovereign-receiver', JSON.stringify(answer.record));
  assert.equal(answer.record.outcome, 'refused');
  assert.equal(answer.record.code, code);
  assert.equal(answer.status, status);
  assertNothingSpent(w, answer);
}

function receiptOf(answer: GovernedReceiverAnswer): unknown {
  const decoded = decodeExecutorReceiptTransport([answer.headers[EXECUTOR_RECEIPT_TRANSPORT_HEADER]]);
  assert.ok(decoded.ok, 'the answer carries one decodable receipt');
  return decoded.presented;
}

// ── the governed path ───────────────────────────────────────────────────────────

describe('RSDK-02B governed receiver — the permitted path', () => {
  it('verifies capability, then asset, then policy, then claims, performs the synthetic effect once and receipts it', async () => {
    const w = await world();
    const observed = governed();
    const answer = await w.handle(observed);
    assert.equal(answer.record.outcome, 'completed-observed', JSON.stringify(answer.record));
    assert.equal(answer.status, 201);
    assert.equal(answer.record.ledgerState, 'completed');
    assert.deepEqual(w.events, [`load:${ASSET}`, 'verify-asset', 'policy', 'claim', 'claim:claimed', 'effect-start:claimed', 'effect:completed', 'record:completed']);
    assert.deepEqual(w.verifyCalls, [{ bundleText: BUNDLE, expectedSovereignAssetId: ASSET }]);
    assert.equal(w.domain.records().length, 1);
    const verification = w.domain.verifier.verify(receiptOf(answer), { expected: { executorId: EXECUTOR_ID, issuer: ISSUER, audience: AUDIENCE, organizationId: ORGANIZATION, trustDomain: TRUST_DOMAIN } });
    assert.equal(verification.failure, null);
    assert.equal(verification.signature, 'valid');
    assert.equal(verification.reportedOutcome, 'completed-observed');
    assert.equal(verification.externalConfirmation, 'not-established');
  });

  it('takes the asset identity from the verified capability, never from the request', async () => {
    const w = await world();
    // The request names OTHER_ASSET in its path, but the capability (and its binding) say ASSET: the binding refuses it.
    const vector = vectorFor(OTHER_ASSET);
    const answer = await w.handle(observedWith(vector, { capability: { action: SYNTHETIC_ACTION, resource: ASSET, actionBinding: { format: BINDING_FORMAT, digest: vectorFor(ASSET).digest } } }));
    assertRefusedBeforeAsset(w, answer, 'ACTION_BINDING_MISMATCH');
  });
});

// ── capability security ─────────────────────────────────────────────────────────

describe('RSDK-02B governed receiver — capability security (nothing reaches the asset gate)', () => {
  it('refuses a forged signature', async () => {
    const w = await world();
    const vector = vectorFor(ASSET);
    const forged = presentationFor(capabilityFor(vector.digest, { action: SYNTHETIC_ACTION, resource: ASSET }), UNPINNED_KEY, ISSUER_KEY.keyId);
    assertRefusedBeforeAsset(w, await w.handle(observedWith(vector, { presentation: forged })), 'SIGNATURE_INVALID');
  });

  it('refuses an untrusted issuer, another audience, organization or trust domain', async () => {
    for (const [capability, code] of [
      [{ issuer: 'frontera-deployment-unknown' }, 'ISSUER_NOT_PINNED'],
      [{ audience: 'executor-another-receiver' }, 'AUDIENCE_NOT_THIS_EXECUTOR'],
      [{ organizationId: 'org-other' }, 'ORGANIZATION_NOT_PERMITTED'],
      [{ trustDomain: 'trust-domain-other' }, 'TRUST_DOMAIN_NOT_PERMITTED'],
    ] as const) {
      const w = await world();
      assertRefusedBeforeAsset(w, await w.handle(governed(ASSET, capability)), code);
    }
  });

  it('refuses an expired capability', async () => {
    const w = await world();
    const now = Date.now();
    const answer = await w.handle(governed(ASSET, { issuedAt: new Date(now - 40_000).toISOString(), expiresAt: new Date(now - 10_000).toISOString() }));
    assertRefusedBeforeAsset(w, answer, 'CAPABILITY_EXPIRED');
  });

  it('refuses a substituted method, path or body, and a capability bound to another digest', async () => {
    const cases: readonly [Parameters<typeof observedWith>[1], Record<string, unknown>][] = [
      [{ method: 'PUT' }, {}],
      [{ target: '/v1/deployments/other' }, {}],
      [{ body: Buffer.from('{"substituted":true}', 'utf8') }, {}],
      [{}, { actionBinding: { format: BINDING_FORMAT, digest: `sha256:${'0'.repeat(64)}` } }],
    ];
    for (const [options, capability] of cases) {
      const w = await world();
      const answer = await w.handle(governed(ASSET, capability, options));
      assert.equal(answer.record.outcome, 'refused', JSON.stringify(answer.record));
      assert.deepEqual(w.verifyCalls, []);
      assertNothingSpent(w, answer);
    }
  });

  it('refuses a resource that is not a sovereign asset identifier, without consulting the asset gate', async () => {
    const w = await world();
    assertRefusedBeforeAsset(w, await w.handle(governed('cluster-eu-1')), 'RESOURCE_NOT_PERMITTED');
  });

  it('never runs the asset gate for a permitted action that is not the synthetic operation', async () => {
    const w = await world();
    const answer = await w.handle(governed(ASSET, { action: ACTION }));
    assertRefusedBeforeAsset(w, answer, 'ACTION_NOT_SYNTHETIC');
  });

  it('refuses to compose over a ledger pinned to another audience', async () => {
    const domain = await receiptDomain();
    try {
      const configuration = parseReferenceExecutorConfiguration(receiptConfiguration(domain), EXECUTOR_ENVIRONMENT);
      const foreign = await openExecutionCapabilityConsumptionLedger(`${domain.root}/foreign.sqlite`, { audience: 'executor-another-receiver', clock: () => Date.now(), create: true });
      try {
        const effect = openSyntheticDeploymentEffect({ outputDirectory: domain.outputDirectory, durablyClaimed: () => false });
        assert.throws(() =>
          createGovernedSovereignReceiver({ configuration, ledger: foreign, effect, clock: () => Date.now(), assets: { load: () => undefined }, verifyAsset: async () => undefined, policy: () => ({ decision: 'eligible' }) }),
        );
      } finally {
        foreign.close();
      }
    } finally {
      domain.cleanup();
    }
  });
});

// ── asset security ──────────────────────────────────────────────────────────────

describe('RSDK-02B governed receiver — asset security (the capability stays unclaimed)', () => {
  it('refuses a missing bundle', async () => {
    const w = await world({ assets: { load: () => undefined } });
    assertAssetRefusal(w, await w.handle(governed()), 'ASSET_NOT_FOUND', 403);
    assert.deepEqual(w.verifyCalls, []);
  });

  it('refuses an oversized bundle before RSDK-01 sees it, counting UTF-8 bytes', async () => {
    for (const bundleText of ['x'.repeat(65), 'é'.repeat(33)]) {
      const w = await world({ assets: { load: () => ({ bundleText }) }, limits: { maximumBundleBytes: 64 } });
      assertAssetRefusal(w, await w.handle(governed()), 'ASSET_TOO_LARGE', 403);
      assert.deepEqual(w.verifyCalls, []);
    }
    const w = await world({ assets: { load: () => ({ bundleText: 'é'.repeat(32) }) }, limits: { maximumBundleBytes: 64 } });
    assert.equal((await w.handle(governed())).record.outcome, 'completed-observed', 'exactly at the limit passes');
  });

  it('refuses a configured limit above 1 MiB or a deadline outside its bounds', async () => {
    for (const limits of [{ maximumBundleBytes: 1_048_577 }, { maximumBundleBytes: 0 }, { assetDeadlineMs: 0 }, { assetDeadlineMs: 30_001 }]) {
      await assert.rejects(world({ limits }));
    }
  });

  it('refuses a malformed stored asset and a throwing store', async () => {
    const getter = Object.defineProperty({}, 'bundleText', { get: () => BUNDLE, enumerable: true });
    for (const [load, code, status] of [
      [() => ({ bundleText: 42 }), 'ASSET_MALFORMED', 403],
      [() => getter, 'ASSET_MALFORMED', 403],
      [() => ({ bundleText: BUNDLE, contentBytes: [1, 2, 3] }), 'ASSET_MALFORMED', 403],
      [() => { throw new Error('store down'); }, 'ASSET_STORE_FAILED', 503],
      [async () => { throw new Error('store down'); }, 'ASSET_STORE_FAILED', 503],
    ] as const) {
      const w = await world({ assets: { load: load as never } });
      assertAssetRefusal(w, await w.handle(governed()), code, status);
    }
  });

  it('asks RSDK-01 about exactly the capability resource, and refuses a result about another asset', async () => {
    const w = await world({ verify: () => verifiedResult(OTHER_ASSET) });
    assertAssetRefusal(w, await w.handle(governed()), 'ASSET_VERIFICATION_MALFORMED', 403);
    assert.deepEqual(w.verifyCalls.map((call) => call.expectedSovereignAssetId), [ASSET]);
  });

  it('refuses every RSDK-01 outcome other than verified, keeping its closed reasons', async () => {
    const w = await world({ verify: () => rejectedResult(['SUBJECT_MISMATCH']) });
    const answer = await w.handle(governed());
    assertAssetRefusal(w, answer, 'ASSET_REJECTED', 403);
    assert.equal(answer.record.mode === 'governed-sovereign-receiver' ? answer.record.assetRejection?.join() : null, 'SUBJECT_MISMATCH');
  });

  it('refuses shapes that are not RSDK-01 verified results', async () => {
    const shapes: unknown[] = [
      undefined,
      { outcome: 'verified' },
      verifiedResult(ASSET, { overrides: { authorization: 'granted' } }),
      verifiedResult(ASSET, { overrides: { profile: 'some-other-profile' } }),
      verifiedResult(ASSET, { overrides: { reasons: ['X'] } }),
      verifiedResult(ASSET, { overrides: { currentState: 'withdrawn' } }), // the summary contradicts the manifest evidence
      Object.defineProperty({ ...(verifiedResult(ASSET) as object) }, 'outcome', { get: () => 'verified', enumerable: true }),
    ];
    for (const shape of shapes) {
      const w = await world({ verify: () => shape });
      assertAssetRefusal(w, await w.handle(governed()), 'ASSET_VERIFICATION_MALFORMED', 403);
    }
  });

  it('refuses a throwing verifier', async () => {
    const w = await world({ verify: () => { throw new Error('verifier down'); } });
    assertAssetRefusal(w, await w.handle(governed()), 'ASSET_VERIFICATION_FAILED', 503);
  });

  it('refuses withdrawn, disputed and superseded current manifests', async () => {
    for (const state of ['withdrawn', 'disputed', 'superseded'] as const) {
      const w = await world({ verify: (_text, id) => verifiedResult(id, { state }) });
      const answer = await w.handle(governed());
      assertAssetRefusal(w, answer, 'ASSET_INELIGIBLE', 403);
      assert.equal(answer.record.mode === 'governed-sovereign-receiver' ? answer.record.ineligibleReason : null, 'STATE_NOT_ACTIVE');
    }
  });

  it('refuses foreign claims, unconsumed claim types, an untrusted registrant and a missing required claim', async () => {
    for (const [result, reason] of [
      [(id: string) => verifiedResult(id, { claims: [{ claimType: 'Origin', issuer: REGISTRANT }, { claimType: 'Origin', issuer: FOREIGN }] }), 'FOREIGN_CLAIM'],
      [(id: string) => verifiedResult(id, { claims: [{ claimType: 'Origin', issuer: REGISTRANT }, { claimType: 'Authorship', issuer: REGISTRANT }] }), 'CLAIM_TYPE_NOT_CONSUMED'],
      [(id: string) => verifiedResult(id, { claims: [] }), 'REQUIRED_CLAIM_MISSING'],
      [(id: string) => verifiedResult(id, { overrides: { currentIssuer: FOREIGN, manifests: [{ manifestVersion: 1, manifestDigest: `sha256:${'a'.repeat(64)}`, issuer: FOREIGN, keyId: 'k', state: 'active' }] } }), 'REGISTRANT_NOT_TRUSTED'],
    ] as const) {
      const w = await world({ verify: (_text, id) => result(id) });
      const answer = await w.handle(governed());
      assertAssetRefusal(w, answer, 'ASSET_INELIGIBLE', 403);
      assert.equal(answer.record.mode === 'governed-sovereign-receiver' ? answer.record.ineligibleReason : null, reason);
    }
  });

  it('accepts a foreign claim only where the operation deliberately trusts its issuer', async () => {
    const trusting = createDemonstrationAssetPolicy({ trustedRegistrants: [REGISTRANT], operations: { [SYNTHETIC_ACTION]: { claimTypes: ['Origin'], requiredClaimTypes: ['Origin'], trustedClaimIssuers: [FOREIGN] } } });
    const w = await world({ policy: trusting, verify: (_text, id) => verifiedResult(id, { claims: [{ claimType: 'Origin', issuer: FOREIGN }] }) });
    assert.equal((await w.handle(governed())).record.outcome, 'completed-observed');
  });

  it('refuses unknown, malformed and throwing policy decisions', async () => {
    for (const [decision, code] of [
      [() => ({ decision: 'maybe' }), 'ASSET_POLICY_INVALID'],
      [() => 'eligible', 'ASSET_POLICY_INVALID'],
      [() => ({ decision: 'eligible', because: 'yes' }), 'ASSET_POLICY_INVALID'],
      [() => ({ decision: 'ineligible' }), 'ASSET_POLICY_INVALID'],
      [() => Object.defineProperty({}, 'decision', { get: () => 'eligible', enumerable: true }), 'ASSET_POLICY_INVALID'],
      [() => undefined, 'ASSET_POLICY_INVALID'],
      [() => { throw new Error('policy down'); }, 'ASSET_POLICY_FAILED'],
    ] as const) {
      const w = await world({ policy: decision as never });
      assertAssetRefusal(w, await w.handle(governed()), code, code === 'ASSET_POLICY_FAILED' ? 503 : 403);
    }
  });

  it('refuses a hanging store, verifier or policy at the deadline, deterministically', async () => {
    for (const stage of ['store', 'verifier', 'policy'] as const) {
      const scheduler = manualScheduler();
      const never = new Promise<never>(() => undefined);
      const w = await world({
        schedule: scheduler.schedule,
        ...(stage === 'store' ? { assets: { load: () => never } } : {}),
        ...(stage === 'verifier' ? { verify: () => never } : {}),
        ...(stage === 'policy' ? { policy: () => never } : {}),
      });
      const pending = w.handle(governed());
      const reached = (): boolean => (stage === 'store' ? w.events.some((event) => event.startsWith('load:')) : stage === 'verifier' ? w.verifyCalls.length === 1 : w.events.includes('policy'));
      for (let i = 0; i < 50 && !(reached() && scheduler.size === 1); i += 1) await flush();
      assert.ok(reached() && scheduler.size === 1, `the ${stage} holds the only pending deadline`);
      scheduler.fireAll(); // a finished stage cancels its own timer, so this fires only the hanging stage's
      const code = stage === 'store' ? 'ASSET_STORE_TIMEOUT' : stage === 'verifier' ? 'ASSET_VERIFICATION_TIMEOUT' : 'ASSET_POLICY_TIMEOUT';
      assertAssetRefusal(w, await pending, code, 503);
    }
  });

  it('never spends more of the deadline than the capability has left', async () => {
    let now = Date.now();
    const scheduler = manualScheduler();
    const late = deferred<{ bundleText: string }>();
    const w = await world({ clock: () => now, schedule: scheduler.schedule, assets: { load: () => late.promise } });
    // Valid when verified (2 s left); the store then answers after the capability's expiry.
    const pending = w.handle(governed(ASSET, { issuedAt: new Date(now - 1_000).toISOString(), expiresAt: new Date(now + 2_000).toISOString() }));
    await flush();
    now += 5_000;
    late.resolve({ bundleText: BUNDLE });
    // The verifier stage starts with no budget left: refused before RSDK-01 runs, nothing claimed.
    assertAssetRefusal(w, await pending, 'ASSET_VERIFICATION_TIMEOUT', 503);
    assert.deepEqual(w.verifyCalls, []);
  });
});

// ── execution ───────────────────────────────────────────────────────────────────

describe('RSDK-02B governed receiver — execution', () => {
  it('never runs the effect without a committed claim', async () => {
    const w = await world({ claimThrows: true });
    const answer = await w.handle(governed());
    assert.equal(answer.record.outcome, 'claim-unavailable');
    assert.equal(answer.status, 503);
    assert.equal(w.events.some((event) => event.startsWith('effect')), false);
    assert.equal(w.domain.records().length, 0);
  });

  it('answers a replayed capability from the ledger and performs nothing again', async () => {
    const w = await world();
    const observed = governed();
    assert.equal((await w.handle(observed)).record.outcome, 'completed-observed');
    const replay = await w.handle(observed);
    assert.equal(replay.record.outcome, 'already-consumed');
    assert.equal(replay.record.code, 'CAPABILITY_CONSUMED');
    assert.equal(replay.status, 202);
    assert.equal(w.events.filter((event) => event.startsWith('effect-start')).length, 1);
    assert.equal(w.domain.records().length, 1);
  });

  it('refuses a second capability for an execution that was already consumed', async () => {
    const w = await world();
    const executionId = 'aoc.exec:rsdk02-shared-execution';
    assert.equal((await w.handle(governed(ASSET, { executionId }))).record.outcome, 'completed-observed');
    const second = await w.handle(governed(ASSET, { executionId }));
    assert.equal(second.record.outcome, 'already-consumed');
    assert.equal(second.record.code, 'EXECUTION_CONSUMED');
    assert.equal(w.events.filter((event) => event.startsWith('effect-start')).length, 1);
  });

  it('after an interruption past the claim: the outcome stays unknown, the capability is spent, nothing is retried', async () => {
    const w = await world({ fault: (point) => { if (point === 'after-claim') throw new Error('process stopped'); } });
    const observed = governed();
    const interrupted = await w.handle(observed);
    assert.equal(interrupted.record.outcome, 'attempted-outcome-unknown', JSON.stringify(interrupted.record));
    assert.equal(interrupted.status, 502);
    assert.equal(interrupted.record.ledgerState, 'claimed');
    assert.equal(w.events.some((event) => event.startsWith('effect')), false);
    assert.equal((await w.domain.state(observedCapabilityId(w))).state, 'claimed');
    // A new receiver over the same durable ledger (a restart) refuses the replay and performs nothing.
    const restarted = await reopen(w);
    const replay = await restarted(observed);
    assert.equal(replay.record.outcome, 'already-consumed');
    assert.equal(w.domain.records().length, 0);
    // The receipt the durable state alone supports: possibly attempted, outcome unknown — never completed.
    const issuance = w.issuer.issue(observedCapabilityId(w));
    assert.equal(issuance.status, 'issued');
    if (issuance.status === 'issued') assert.equal(issuance.outcome, 'attempted-outcome-unknown');
  });

  it('records a failed or uncertain effect honestly and never reports it completed', async () => {
    for (const [reported, outcome, ledgerState, status] of [
      ['failed', 'failed-observed', 'failed', 422],
      ['unknown', 'attempted-outcome-unknown', 'outcome-unknown', 502],
      ['not-attempted', 'consumed-not-attempted', 'failed', 422],
    ] as const) {
      const w = await world({ observe: () => reported });
      const answer = await w.handle(governed());
      assert.equal(answer.record.outcome, outcome);
      assert.equal(answer.record.ledgerState, ledgerState);
      assert.equal(answer.status, status);
      assert.equal(w.events.filter((event) => event.startsWith('effect-start')).length, 1, 'exactly one attempt');
      const receipt = w.domain.verifier.verify(receiptOf(answer));
      assert.equal(receipt.reportedOutcome === 'completed-observed', false);
    }
  });

  it('treats a throwing effect as an attempt with unknown outcome, never retried', async () => {
    const w = await world({ effectThrows: true });
    const observed = governed();
    const answer = await w.handle(observed);
    assert.equal(answer.record.outcome, 'attempted-outcome-unknown');
    assert.equal(answer.status, 502);
    assert.equal(answer.record.ledgerState, 'claimed');
    assert.equal((await w.handle(observed)).record.outcome, 'already-consumed');
    assert.equal(w.events.filter((event) => event.startsWith('effect-start')).length, 1);
  });

  it('reads its options once: replacing the policy afterwards changes nothing', async () => {
    const domain = await receiptDomain();
    const configuration = parseReferenceExecutorConfiguration(receiptConfiguration(domain), EXECUTOR_ENVIRONMENT);
    const ledger = await openExecutionCapabilityConsumptionLedger(domain.ledgerPath, { audience: AUDIENCE, clock: () => Date.now() });
    try {
      const effect = openSyntheticDeploymentEffect({ outputDirectory: domain.outputDirectory, durablyClaimed: (id) => admitsEffect(ledger.read(id).state) });
      const options = {
        configuration,
        ledger,
        effect,
        clock: () => Date.now(),
        assets: { load: () => ({ bundleText: BUNDLE }) },
        verifyAsset: async (_text: string, request: { readonly expectedSovereignAssetId: string }) => verifiedResult(request.expectedSovereignAssetId),
        policy: (() => ({ decision: 'ineligible', reason: 'ORIGINAL' })) as SovereignAssetEligibilityPolicy,
      };
      const receiver = createGovernedSovereignReceiver(options);
      options.policy = () => ({ decision: 'eligible' });
      const answer = await receiver.handle(governed());
      assert.equal(answer.record.code, 'ASSET_INELIGIBLE');
    } finally {
      ledger.close();
      domain.cleanup();
    }
  });
});

// ── RSDK-02C preflight A: the resource predicate ────────────────────────────────

describe('RSDK-02C preflight — the pipeline resource predicate', () => {
  const configuration = parseReferenceExecutorConfiguration(executorConfiguration(), EXECUTOR_ENVIRONMENT);
  const clock = () => Date.now();
  const assess = (observed: ObservedHttpRequest, options?: Parameters<typeof createReferenceExecutorVerificationPipeline>[2]) =>
    createReferenceExecutorVerificationPipeline(configuration, clock, options).assess(observed);
  const allowListed = (capability: Record<string, unknown> = {}, options: Parameters<typeof observedWith>[1] = {}) =>
    observedWith(hostVector('rsdk02c:allow-listed'), { capability, ...options });

  it('without a predicate, the static allow-list decides exactly as before', () => {
    assert.equal(assess(allowListed()).code, 'VERIFICATION_ONLY');
    const other = observedWith(hostVector('rsdk02c:other', {}, validatedAction({ resource: 'cluster-not-listed' })), { capability: { resource: 'cluster-not-listed' } });
    assert.equal(assess(other).code, 'RESOURCE_NOT_PERMITTED');
  });

  it('a predicate replaces only the allow-list: it can refuse an allow-listed resource', () => {
    assert.equal(assess(allowListed(), { resourcePermitted: (resource) => resource !== RESOURCE }).code, 'RESOURCE_NOT_PERMITTED');
  });

  it('a predicate that admits everything still cannot pass a forged signature, another audience, organization, trust domain, an expired window or a substituted request', () => {
    const admitAll = { resourcePermitted: () => true };
    const vector = hostVector('rsdk02c:admit-all');
    const now = Date.now();
    const cases: readonly [ObservedHttpRequest, string][] = [
      [observedWith(vector, { presentation: presentationFor(capabilityFor(vector.digest), UNPINNED_KEY, ISSUER_KEY.keyId) }), 'SIGNATURE_INVALID'],
      [observedWith(vector, { capability: { audience: 'executor-another' } }), 'AUDIENCE_NOT_THIS_EXECUTOR'],
      [observedWith(vector, { capability: { organizationId: 'org-other' } }), 'ORGANIZATION_NOT_PERMITTED'],
      [observedWith(vector, { capability: { trustDomain: 'trust-domain-other' } }), 'TRUST_DOMAIN_NOT_PERMITTED'],
      [observedWith(vector, { capability: { issuedAt: new Date(now - 40_000).toISOString(), expiresAt: new Date(now - 10_000).toISOString() } }), 'CAPABILITY_EXPIRED'],
      // Framing-consistent substitution reaches the binding check; an inconsistent one is refused earlier, by admission.
      [observedWith(vector, { body: Buffer.from('{"substituted":true}'), edit: (raw) => setRawHeader(raw, 'content-length', '20') }), 'ACTION_BINDING_MISMATCH'],
      [observedWith(vector, { body: Buffer.from('{"substituted":true}') }), 'FRAMING_AMBIGUOUS'],
      [observedWith(vector, { capability: { actionBinding: { format: BINDING_FORMAT, digest: `sha256:${'0'.repeat(64)}` } } }), 'ACTION_BINDING_MISMATCH'],
    ];
    for (const [observed, code] of cases) {
      const result = assess(observed, admitAll);
      assert.equal(result.outcome, 'refused', code);
      assert.equal(result.code, code);
    }
  });

  it('a throwing predicate, or one answering anything but true, refuses', () => {
    assert.equal(assess(allowListed(), { resourcePermitted: () => { throw new Error('predicate'); } }).code, 'EXECUTOR_FAILURE');
    for (const answer of [1, 'true', {}, [], undefined]) {
      assert.equal(assess(allowListed(), { resourcePermitted: () => answer as unknown as boolean }).code, 'RESOURCE_NOT_PERMITTED', String(answer));
    }
  });

  it('the predicate is read once: replacing it afterwards changes nothing', () => {
    const options = { resourcePermitted: (_resource: string) => false };
    const pipeline = createReferenceExecutorVerificationPipeline(configuration, clock, options);
    options.resourcePermitted = () => true;
    assert.equal(pipeline.assess(allowListed()).code, 'RESOURCE_NOT_PERMITTED');
  });
});

// ── RSDK-02C preflight B: the precomputed verdict ───────────────────────────────

describe('RSDK-02C preflight — the precomputed verdict and the asynchronous gate', () => {
  it('interleaved requests each act on their own verdict: one held in the policy cannot borrow another\'s', async () => {
    const held = deferred();
    let calls = 0;
    const w = await world({
      policy: async (input) => {
        calls += 1;
        if (calls === 1) await held.promise;
        return demonstrationPolicy(input);
      },
    });
    const first = w.handle(governed(ASSET));
    await flush();
    const second = await w.handle(governed(OTHER_ASSET));
    assert.equal(second.record.outcome, 'completed-observed');
    held.resolve();
    const firstAnswer = await first;
    assert.equal(firstAnswer.record.outcome, 'completed-observed');
    assert.notEqual(firstAnswer.record.bindingDigest, second.record.bindingDigest);
    assert.equal(w.domain.records().length, 2, 'two capabilities, two claims, two effects');
  });

  it('the same request delivered twice concurrently is claimed once and performed once', async () => {
    const held = deferred();
    const w = await world({ policy: async (input) => { await held.promise; return demonstrationPolicy(input); } });
    const observed = governed();
    const a = w.handle(observed);
    const b = w.handle(observed);
    await flush();
    held.resolve();
    const outcomes = (await Promise.all([a, b])).map((answer) => answer.record.outcome).sort();
    assert.deepEqual(outcomes, ['already-consumed', 'completed-observed']);
    assert.equal(w.events.filter((event) => event.startsWith('effect-start')).length, 1);
  });

  it('a capability that expires while the policy runs is refused at the claim: no effect', async () => {
    let now = Date.now();
    const held = deferred();
    const w = await world({ clock: () => now, policy: async (input) => { await held.promise; return demonstrationPolicy(input); } });
    const pending = w.handle(governed(ASSET, { issuedAt: new Date(now - 1_000).toISOString(), expiresAt: new Date(now + 2_000).toISOString() }));
    await flush();
    now += 2_500; // past expiry, while the policy is still deciding (no timer fires: the default scheduler is real and far away)
    held.resolve();
    const answer = await pending;
    assert.equal(answer.record.outcome, 'refused', JSON.stringify(answer.record));
    assert.equal(answer.record.code, 'CAPABILITY_EXPIRED');
    assert.equal(w.events.includes('claim:claimed'), false);
    assert.equal(w.events.some((event) => event.startsWith('effect')), false);
  });

  it('a policy that answers eligible after its deadline triggers nothing later', async () => {
    const scheduler = manualScheduler();
    const late = deferred<{ readonly decision: 'eligible' }>();
    const w = await world({ schedule: scheduler.schedule, policy: () => late.promise });
    const pending = w.handle(governed());
    for (let i = 0; i < 50 && !(w.events.includes('policy') && scheduler.size === 1); i += 1) await flush();
    scheduler.fireAll();
    assertAssetRefusal(w, await pending, 'ASSET_POLICY_TIMEOUT', 503);
    late.resolve({ decision: 'eligible' });
    for (let i = 0; i < 10; i += 1) await flush();
    assert.equal(w.events.includes('claim'), false, 'the late answer is discarded unread');
    assert.equal(w.domain.records().length, 0);
  });

  it('mutating the received request while the asset gate is suspended changes nothing that is executed', async () => {
    const held = deferred();
    const w = await world({ policy: async (input) => { await held.promise; return demonstrationPolicy(input); } });
    const observed = governed() as { -readonly [K in keyof ObservedHttpRequest]: ObservedHttpRequest[K] };
    const pending = w.handle(observed);
    await flush();
    const originalTarget = observed.target;
    observed.target = '/v1/deployments/somewhere-else';
    observed.body = Buffer.from('{"substituted":true}');
    held.resolve();
    const answer = await pending;
    assert.equal(answer.record.outcome, 'completed-observed');
    const record = JSON.parse(w.domain.recordText(observedRecordId(w)) ?? '{}') as { readonly target?: string };
    assert.equal(record.target, ASSET, 'the effect acts on the verified capability\'s resource');
    assert.notEqual(originalTarget, observed.target);
  });
});

// ── helpers that read back durable state ────────────────────────────────────────

/** The one capability this world claimed, read back from the ledger's unresolved or resolved rows. */
function observedCapabilityId(w: World): string {
  const unresolved = w.ledger.listUnresolved().records;
  assert.equal(unresolved.length, 1);
  return unresolved[0]!.capabilityId;
}

/** The capability id of the one synthetic record this world wrote. */
function observedRecordId(w: World): string {
  const records = w.domain.records();
  assert.equal(records.length, 1);
  return records[0]!.replace(/\.json$/, '');
}

/** A second receiver over the same ledger file and output, as after a restart. */
async function reopen(w: World): Promise<(observed: ObservedHttpRequest) => Promise<GovernedReceiverAnswer>> {
  const configuration = parseReferenceExecutorConfiguration(receiptConfiguration(w.domain), EXECUTOR_ENVIRONMENT);
  const ledger = await openExecutionCapabilityConsumptionLedger(w.domain.ledgerPath, { audience: AUDIENCE, clock: () => Date.now() });
  after(() => ledger.close());
  const effect = openSyntheticDeploymentEffect({ outputDirectory: w.domain.outputDirectory, durablyClaimed: (id) => admitsEffect(ledger.read(id).state) });
  const receiver = createGovernedSovereignReceiver({
    configuration,
    ledger,
    effect,
    clock: () => Date.now(),
    assets: { load: () => ({ bundleText: BUNDLE }) },
    verifyAsset: async (_text, request) => verifiedResult(request.expectedSovereignAssetId),
    policy: demonstrationPolicy,
  });
  return (observed) => receiver.handle(observed);
}
