import { copyFileSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { ExecutionAdapterResult, ValidatedExecutionAction } from '../../features/execution-runtime/index.js';
import { assertXrplSequenceOwnership } from '../../features/xrpl-transport/index.js';
import { DelegatedOfferCapabilityError } from '../authority-authenticity/delegated-offer-capability-issuer.js';
import {
  createSqliteTradeSequenceInterlock,
  createTradeOfferExecutionAdapter,
  createTradeRecoveryCoordinator,
  createTradeResolutionAuthority,
  readOnlyTradeLedger,
  readOnlyTradeRecoveryLedger,
  type DurableTradeSequenceInterlock,
  type TradeRecoveryP11View,
  type TradeRecoveryReport,
  type TradeSignerObservation,
} from '../xrpl-trade-execution/index.js';
import type { DelegatedOfferSigningPort } from '../xrpl-trade-rail/index.js';
import { initializeReferenceCapabilityLedger } from '../xrpl-trade-rail/reference/reference-delegated-offer-signer.js';
import { inspectReferenceCapabilityLedger, openReferenceCapabilityLedger } from '../xrpl-trade-rail/reference/reference-capability-ledger.js';
import { XRPL_TRADE_EXECUTOR_ID } from '../xrpl-trade-execution/host-configuration.js';
import { boundaryFor, closeAllWitnesses, startWitness, type StartedWitness } from './core07-freshness-fixture.js';
import { ACTION, FakeXrplLedger, NETWORK_ID, ORG, executorRig, pairWorld, rawProposal, scratch, validatedAction, type ExecutorRig, type TradePairWorld } from './trade04c-execution-fixture.js';
import { testCapabilityIssuer } from './trade04c-s1-capability-fixture.js';

/**
 * TRADE-04D §11 — offline recovery qualification on the real executor, the
 * real CORE-07-anchored SQLite trade interlock and a real loopback reference
 * witness, the real TRADE-04B signer client over HTTP to the real reference
 * signer with its durable capability ledger, and the labelled fake ledger
 * (no XRPL network). Faults are injected at the boundaries a crash or a lost
 * response would cut. Every scenario counts signatures, capability
 * issuances and submissions: no recovery path may add one.
 */

const spaces: { cleanup(): void }[] = [];
after(async () => {
  await closeAllWitnesses();
  for (const space of spaces.splice(0)) space.cleanup();
});
const persistent = (): { readonly dir: string } => {
  const space = scratch();
  spaces.push(space);
  return space;
};

function order(rig: ExecutorRig, pair: TradePairWorld = rig.pairs[0]!): { readonly raw: Record<string, unknown>; readonly action: ValidatedExecutionAction } {
  const raw = rawProposal(pair);
  rig.book.attest(raw);
  return { raw, action: validatedAction(raw) };
}

/** What the governed path records in P11 for an adapter result (the initial observation), keyed to the action's correlation. */
function p11Of(action: ValidatedExecutionAction, result?: ExecutionAdapterResult): TradeRecoveryP11View {
  const attempt = { organizationId: ORG, executionId: action.correlation.executionId, requestId: action.correlation.requestId, decisionId: action.correlation.decisionId, boundedGrantId: action.boundedGrantId, action: action.action };
  if (result === undefined) return { record: { attempt } };
  const providerRef = 'providerRef' in result && typeof result.providerRef === 'string' ? { providerRef: result.providerRef } : {};
  const certainty = result.outcome === 'completed' ? 'confirmed-completed' : result.outcome === 'failed' ? 'confirmed-not-completed' : 'unconfirmed';
  return { record: { attempt, terminal: { observation: { kind: 'provider', certainty, ...providerRef } } } };
}

function coordinatorFor(rig: ExecutorRig, interlock: Pick<DurableTradeSequenceInterlock, 'read' | 'health'> = rig.interlock) {
  return createTradeRecoveryCoordinator({
    networkId: NETWORK_ID,
    requestTimeoutMs: 1_000,
    maxValidatedLedgerAgeSeconds: 10,
    ledger: readOnlyTradeRecoveryLedger(rig.ledger.client(NETWORK_ID, rig.interlock)),
    interlock: { read: (executionId: string) => interlock.read(executionId), health: () => interlock.health() },
  });
}

function resolverFor(rig: ExecutorRig) {
  return createTradeResolutionAuthority({ networkId: NETWORK_ID, action: ACTION, requestTimeoutMs: 1_000, ledger: readOnlyTradeLedger(rig.ledger.client(NETWORK_ID, rig.interlock)), interlock: rig.interlock });
}

function queryOf(action: ValidatedExecutionAction, providerRef?: string) {
  return { organizationId: ORG, executionId: action.correlation.executionId, evaluationId: 'eval-trade04d', requestId: action.correlation.requestId, decisionId: action.correlation.decisionId, boundedGrantId: action.boundedGrantId, action: ACTION, ...(providerRef !== undefined ? { providerRef } : {}), basis: 'initial-observation-unconfirmed' as const };
}

async function signerObservation(rig: ExecutorRig, executionId: string): Promise<TradeSignerObservation> {
  return (await inspectReferenceCapabilityLedger(rig.signer.ledgerPath, executionId)) as TradeSignerObservation;
}

const withSigner = (wrap: (port: DelegatedOfferSigningPort) => DelegatedOfferSigningPort): typeof createTradeOfferExecutionAdapter => (options) => createTradeOfferExecutionAdapter({ ...options, signer: wrap(options.signer) });

/** The counters no recovery may move. */
const effects = (rig: ExecutorRig, issued?: { readonly issued: readonly unknown[] }) => ({ signatures: rig.signer.signatures(), submissions: rig.ledger.submitCalls.length, ...(issued !== undefined ? { capabilities: issued.issued.length } : {}) });

/** A signer ledger that survives the rig (explicitly initialized), for restarts. */
async function signerLedger(): Promise<string> {
  const path = join(persistent().dir, 'signer-capability-ledger.sqlite');
  await initializeReferenceCapabilityLedger(path);
  return path;
}

async function restartedRig(previous: { readonly dir: string; readonly witness: StartedWitness; readonly ledger: FakeXrplLedger; readonly pairs: readonly TradePairWorld[]; readonly signerLedgerPath: string }, options: Parameters<typeof executorRig>[0] = {}): Promise<ExecutorRig> {
  return executorRig({ ...options, dir: previous.dir, witness: previous.witness, ledger: previous.ledger, pairs: previous.pairs, signerLedgerPath: previous.signerLedgerPath });
}

describe('TRADE-04D Scenario D — signer crash: consumed, response lost; restart and recovery add no signature or submission', () => {
  it('after signing, before the response: Frontera never reserved or sent it; the signer reports the hash; restart → the same execution is refused by the signer’s execution uniqueness, zero new signatures', async () => {
    const dir = persistent().dir;
    const witness = await startWitness();
    const ledger = new FakeXrplLedger();
    const pairs = [pairWorld(ledger)];
    const signerLedgerPath = await signerLedger();
    const issuer = testCapabilityIssuer();
    const rig = await executorRig({ dir, witness, ledger, pairs, signerLedgerPath, issuer, create: withSigner((port) => ({ signDelegatedOffer: async (request) => {
      await port.signDelegatedOffer(request);
      throw new Error('the response was lost after the signature');
    } })) });
    const { raw, action } = order(rig);
    const result = await rig.adapter.execute(action);
    assert.deepEqual([result.outcome, 'detail' in result ? result.detail : undefined], ['failed', 'trade-signer-unavailable']);
    assert.deepEqual(effects(rig, issuer), { signatures: 1, submissions: 0, capabilities: 1 });
    assert.equal(await rig.interlock.recorded(action.correlation.executionId), undefined, 'no reservation: the submit site can never send it');

    const signer = await signerObservation(rig, action.correlation.executionId);
    assert.equal(signer.state, 'signed');
    const report = await coordinatorFor(rig).assess(action.correlation.executionId, { p11: p11Of(action, result), signer });
    assert.equal(report.assessment.class, 'signed-not-reserved');
    assert.equal(report.assessment.fronteraSubmission, 'never');
    assert.equal(report.assessment.signature, 'reported-by-signer');
    assert.ok(report.assessment.uncertainties.includes('inclusion-unprovable-without-window'));
    assert.ok(report.assessment.uncertainties.includes('signer-evidence-not-authoritative'));
    assert.deepEqual(effects(rig, issuer), { signatures: 1, submissions: 0, capabilities: 1 }, 'assessment adds nothing');
    await rig.close();

    // Restart: a new executor, the same interlock file and witness, the same customer signer ledger.
    const issuer2 = testCapabilityIssuer();
    const restarted = await restartedRig({ dir, witness, ledger, pairs, signerLedgerPath }, { issuer: issuer2 });
    try {
      restarted.book.attest(raw);
      // Only a defective caller could hand the adapter the same execution twice (P11's claim never reopens). Even then:
      const again = await restarted.adapter.execute(action);
      assert.deepEqual([again.outcome, 'detail' in again ? again.detail : undefined], ['failed', 'trade-signer-refused']);
      assert.deepEqual(effects(restarted), { signatures: 0, submissions: 0 }, 'the signer’s durable execution uniqueness refuses a second signature');
      assert.equal(issuer2.issued.length, 1, 'contained, not prevented: a replacement capability is issued only to a caller that bypasses P11 — and it signs nothing (no Host record of issuance: gate D-1)');
      const restartedReport = await coordinatorFor(restarted).assess(action.correlation.executionId, { p11: p11Of(action, result), signer: await signerObservation(restarted, action.correlation.executionId) });
      assert.equal(restartedReport.assessment.class, 'signed-not-reserved', 'the signer restart did not clear the replay ledger');
    } finally {
      await restarted.close();
    }
  });

  it('after consumption, before signing (crash between the commit and the key): consumed, no hash — never signed; a restart refuses the execution', async () => {
    const signerLedgerPath = await signerLedger();
    const rig = await executorRig({ signerLedgerPath, create: withSigner(() => ({ signDelegatedOffer: async (request) => {
      const capability = JSON.parse(request.authorization.capability) as Record<string, string>;
      const ledger = await openReferenceCapabilityLedger(signerLedgerPath);
      try {
        assert.equal(ledger.consume({ capabilityId: capability['capabilityId']!, executionId: capability['executionId']!, boundedGrantId: capability['boundedGrantId']!, signingPreimageDigest: capability['signingPreimageDigest']!, expiresAt: capability['expiresAt']! }, new Date().toISOString()), 'consumed');
      } finally {
        ledger.close();
      }
      throw new Error('the signer process died after its consumption commit');
    } })) });
    try {
      const { action } = order(rig);
      const result = await rig.adapter.execute(action);
      assert.equal(result.outcome, 'failed');
      const signer = await signerObservation(rig, action.correlation.executionId);
      assert.equal(signer.state, 'consumed');
      const report = await coordinatorFor(rig).assess(action.correlation.executionId, { p11: p11Of(action, result), signer });
      assert.equal(report.assessment.class, 'capability-consumed-unsigned');
      assert.equal(report.assessment.signature, 'possible', 'a consumed capability never proves a signature, nor its absence');
      assert.ok(report.assessment.uncertainties.includes('signature-existence-unknown'));
      // The executor's real signer (same ledger) refuses the execution from now on.
      const again = await rig.adapter.execute(action);
      assert.equal(again.outcome, 'failed');
      assert.deepEqual(effects(rig), { signatures: 0, submissions: 0 });
    } finally {
      await rig.close();
    }
  });

  it('before consumption (the request never reached the signer): the signer reports nothing — capability-not-consumed, indeterminate (the report is not authoritative)', async () => {
    const signerLedgerPath = await signerLedger();
    const rig = await executorRig({ signerLedgerPath, create: withSigner(() => ({ signDelegatedOffer: async () => Promise.reject(new Error('connection refused')) })) });
    try {
      const { action } = order(rig);
      const result = await rig.adapter.execute(action);
      const report = await coordinatorFor(rig).assess(action.correlation.executionId, { p11: p11Of(action, result), signer: await signerObservation(rig, action.correlation.executionId) });
      assert.deepEqual([report.assessment.class, report.assessment.certainty], ['capability-not-consumed', 'indeterminate']);
      assert.deepEqual(effects(rig), { signatures: 0, submissions: 0 });
    } finally {
      await rig.close();
    }
  });
});

describe('TRADE-04D Scenario E — submit response lost: the claim is durable; recovery reads validated evidence and never sends again', () => {
  it('unconfirmed → pending while the window is open (Sequence held) → validated tesSUCCESS; P12 settles; one signature, one submission throughout', async () => {
    const rig = await executorRig();
    try {
      rig.ledger.behavior = { kind: 'throw-after-send', includeWith: 'tesSUCCESS' };
      const { action } = order(rig);
      const result = await rig.adapter.execute(action);
      assert.equal(result.outcome, 'unconfirmed');
      rig.ledger.autoAdvance = false;
      const coordinator = coordinatorFor(rig);
      const pending = await coordinator.assess(action.correlation.executionId, { p11: p11Of(action, result) });
      assert.deepEqual([pending.assessment.class, pending.assessment.lifecycle, pending.assessment.sequence.status], ['submission-response-unknown', 'unconfirmed', 'blocked']);
      assert.ok(pending.assessment.existingPaths.includes('p12-reconcile'));
      // A competing order on the same owner is refused before signing while the window is open.
      const competing = await rig.adapter.execute(order(rig).action);
      assert.deepEqual([competing.outcome, 'detail' in competing ? competing.detail : undefined], ['failed', 'trade-sequence-in-flight']);
      rig.ledger.advance(1);
      const proven = await coordinator.assess(action.correlation.executionId, { p11: p11Of(action, result) });
      assert.deepEqual([proven.assessment.class, proven.assessment.certainty, proven.assessment.lifecycle], ['validated-success', 'proven', 'unconfirmed'], 'the assessment never changes the lifecycle');
      assert.deepEqual((await resolverFor(rig).resolve(queryOf(action, result.outcome === 'unconfirmed' ? result.providerRef : undefined))).outcome, 'resolved');
      assert.equal((await rig.interlock.read(action.correlation.executionId))?.settlement, 'validated-success');
      assert.deepEqual(effects(rig), { signatures: 1, submissions: 1 });
    } finally {
      await rig.close();
    }
  });
});

describe('TRADE-04D Scenario F — indeterminate ledger: unresolved, and unsafe reuse stays blocked', () => {
  it('a lookup timeout, an unreachable ledger and an incomplete history after LastLedgerSequence are indeterminate; nothing settles; the Sequence is never released by them', async () => {
    const rig = await executorRig({ configuration: { finalityTimeoutMs: 0 } });
    try {
      rig.ledger.behavior = { kind: 'drop' };
      const { action } = order(rig);
      const result = await rig.adapter.execute(action);
      assert.equal(result.outcome, 'unconfirmed');
      rig.ledger.autoAdvance = false;
      const coordinator = coordinatorFor(rig);
      const resolver = resolverFor(rig);
      const query = queryOf(action, result.outcome === 'unconfirmed' ? result.providerRef : undefined);

      rig.ledger.faults.lookupTimeout = true;
      const timeout = await coordinator.assess(action.correlation.executionId, { p11: p11Of(action, result) });
      assert.deepEqual([timeout.assessment.class, timeout.assessment.ledger.reason, timeout.assessment.sequence.status], ['indeterminate', 'read-timeout', 'blocked']);
      assert.deepEqual(await resolver.resolve(query), { outcome: 'unresolved' });
      rig.ledger.faults.lookupTimeout = false;

      rig.ledger.faults.serverInfoThrows = true;
      const unreachable = await coordinator.assess(action.correlation.executionId, { p11: p11Of(action, result) });
      assert.deepEqual([unreachable.assessment.class, unreachable.assessment.sequence.status], ['indeterminate', 'unknown']);
      assert.ok(unreachable.assessment.automatedRecovery.refusals.includes('sequence-held-until-ledger-fact'));
      rig.ledger.faults.serverInfoThrows = false;

      rig.ledger.advance(40); // past LastLedgerSequence
      rig.ledger.faults.historyIncomplete = true;
      const incomplete = await coordinator.assess(action.correlation.executionId, { p11: p11Of(action, result) });
      assert.deepEqual([incomplete.assessment.class, incomplete.assessment.ledger.reason], ['indeterminate', 'history-incomplete']);
      assert.ok(incomplete.assessment.evidenceNeeded.includes('complete-ledger-history-for-window'));
      assert.deepEqual(await resolver.resolve(query), { outcome: 'unresolved' }, 'an incomplete search never proves absence, even after LastLedgerSequence');
      assert.equal((await rig.interlock.read(action.correlation.executionId))?.state, 'unconfirmed', 'nothing settled');
      assert.deepEqual(effects(rig), { signatures: 1, submissions: 1 });
    } finally {
      await rig.close();
    }
  });
});

describe('TRADE-04D Scenario G — proven expiration: the original execution is never retried', () => {
  it('complete non-inclusion after LastLedgerSequence → proven-not-included; P12 settles expired; the same execution again → previously recorded, nothing signed or sent', async () => {
    const rig = await executorRig({ configuration: { finalityTimeoutMs: 0 } });
    try {
      rig.ledger.behavior = { kind: 'drop' };
      const { action } = order(rig);
      const result = await rig.adapter.execute(action);
      rig.ledger.autoAdvance = false;
      rig.ledger.advance(40);
      const report = await coordinatorFor(rig).assess(action.correlation.executionId, { p11: p11Of(action, result) });
      assert.deepEqual([report.assessment.class, report.assessment.certainty, report.assessment.ledger.status], ['proven-not-included', 'proven', 'not-included']);
      assert.equal(report.assessment.sequence.status, 'window-closed-record-open', 'released by the ledger index reaching LastLedgerSequence — a protocol fact, not elapsed time');
      await resolverFor(rig).resolve(queryOf(action, result.outcome === 'unconfirmed' ? result.providerRef : undefined));
      assert.equal((await rig.interlock.read(action.correlation.executionId))?.settlement, 'expired');
      const again = await rig.adapter.execute(action);
      assert.deepEqual([again.outcome, 'detail' in again ? again.detail : undefined], ['unconfirmed', 'trade-execution-previously-recorded']);
      assert.deepEqual(effects(rig), { signatures: 1, submissions: 1 });
    } finally {
      await rig.close();
    }
  });
});

describe('TRADE-04D Scenario H — validated transaction failure: fee consequence, no false success', () => {
  for (const [result, effect, interpretation] of [
    ['tecUNFUNDED_OFFER', 'transaction-failed', 'transaction-failed'],
    ['tecKILLED', 'killed', 'not-placed'],
  ] as const) {
    it(`${result}: validated-failure; offer ${effect}; never completed`, async () => {
      const rig = await executorRig();
      try {
        rig.ledger.behavior = { kind: 'accept', finalResult: result };
        const { action } = order(rig);
        const outcome = await rig.adapter.execute(action);
        assert.equal(outcome.outcome, 'failed');
        rig.ledger.autoAdvance = false;
        const report = await coordinatorFor(rig).assess(action.correlation.executionId, { p11: p11Of(action, outcome) });
        assert.deepEqual([report.assessment.class, report.assessment.ledger.engineResult], ['validated-failure', result]);
        assert.deepEqual([report.assessment.offer?.initial.effect, report.assessment.offer?.interpretation], [effect, interpretation]);
        assert.equal(report.assessment.ledger.status, 'included', 'the transaction is in a validated ledger: its fee was consumed (paid by the delegate under XLS-75)');
      } finally {
        await rig.close();
      }
    });
  }
});

describe('TRADE-04D Scenario I — resting and partially filled offers: only what metadata and an identified snapshot prove', () => {
  for (const [effect, initial, interpretation] of [
    ['rest', 'offer-resting', 'resting-as-of-snapshot'],
    ['partial', 'partially-executed-remainder-resting', 'resting-as-of-snapshot'],
    ['fill', 'applied-not-resting', 'not-placed'],
  ] as const) {
    it(`${effect}: ${initial} at the including ledger; ${interpretation} at a later validated ledger (index and hash recorded)`, async () => {
      const rig = await executorRig();
      try {
        rig.ledger.offerEffect = effect;
        const { action } = order(rig);
        const outcome = await rig.adapter.execute(action);
        assert.equal(outcome.outcome, 'completed');
        rig.ledger.autoAdvance = false;
        rig.ledger.advance(2);
        const report = await coordinatorFor(rig).assess(action.correlation.executionId, { p11: p11Of(action, outcome) });
        assert.equal(report.assessment.class, 'validated-success');
        const offer = report.assessment.offer!;
        assert.deepEqual([offer.initial.effect, offer.interpretation], [initial, interpretation]);
        assert.match(offer.initial.ledgerHash ?? '', /^[0-9A-F]{64}$/);
        if (offer.snapshot !== undefined && offer.snapshot.state !== 'unavailable') assert.ok(offer.snapshot.ledgerIndex > offer.initial.ledgerIndex);
        assert.equal(/"(?:TakerGets|TakerPays|takerGets|takerPays)"/.test(JSON.stringify(report.diagnostic)), false, 'the operator diagnostic carries no amounts');
      } finally {
        await rig.close();
      }
    });
  }

  it('a resting offer later absent from the book: no-longer-present as of that ledger — never "filled"', async () => {
    const rig = await executorRig();
    try {
      const { action } = order(rig);
      const outcome = await rig.adapter.execute(action);
      rig.ledger.autoAdvance = false;
      const record = (await rig.interlock.read(action.correlation.executionId))!;
      rig.ledger.advance(3);
      rig.ledger.removeOffer(record.account, record.sequence);
      const report = await coordinatorFor(rig).assess(action.correlation.executionId, { p11: p11Of(action, outcome) });
      assert.equal(report.assessment.offer?.interpretation, 'no-longer-present-as-of-snapshot');
      assert.equal(report.diagnostic.offer?.interpretation, 'no-longer-present-as-of-snapshot');
    } finally {
      await rig.close();
    }
  });
});

describe('TRADE-04D Scenario J — backup rollback: an older store never silently becomes trusted', () => {
  it('the trade interlock restored behind its CORE-07 history: refused at open (the executor is never composed over it)', async () => {
    const dir = persistent().dir;
    const witness = await startWitness();
    const ledger = new FakeXrplLedger();
    const pairs = [pairWorld(ledger)];
    const signerLedgerPath = await signerLedger();
    const first = await executorRig({ dir, witness, ledger, pairs, signerLedgerPath });
    assert.equal((await first.adapter.execute(order(first).action)).outcome, 'completed');
    await first.interlock.close();
    copyFileSync(first.path, `${first.path}.backup`);
    await first.close();
    const second = await restartedRig({ dir, witness, ledger, pairs, signerLedgerPath });
    assert.equal((await second.adapter.execute(order(second).action)).outcome, 'completed');
    await second.close();
    copyFileSync(`${second.path}.backup`, second.path);
    rmSync(`${second.path}-wal`, { force: true });
    rmSync(`${second.path}-shm`, { force: true });
    await assert.rejects(
      createSqliteTradeSequenceInterlock(second.path, { scope: { domainId: XRPL_TRADE_EXECUTOR_ID, networkId: NETWORK_ID }, sequenceAccounts: pairs.map((pair) => pair.owner), now: () => new Date().toISOString(), freshness: { boundary: await boundaryFor(witness, ORG) } }),
      (error: { code?: string }) => /REGRESSED|ROLLBACK|PENDING|FORK/.test(String(error.code)),
    );
  });

  it('the customer signer ledger restored to before a consumption: the signer’s report contradicts the Host-verified signature (inconsistent); the Host’s own records refuse a second signature', async () => {
    const dir = persistent().dir;
    const witness = await startWitness();
    const ledger = new FakeXrplLedger();
    const pairs = [pairWorld(ledger)];
    const signerLedgerPath = await signerLedger();
    copyFileSync(signerLedgerPath, `${signerLedgerPath}.backup`);
    const rig = await executorRig({ dir, witness, ledger, pairs, signerLedgerPath });
    const { raw, action } = order(rig);
    const outcome = await rig.adapter.execute(action);
    assert.equal(outcome.outcome, 'completed');
    await rig.close();
    copyFileSync(`${signerLedgerPath}.backup`, signerLedgerPath);
    rmSync(`${signerLedgerPath}-wal`, { force: true });
    rmSync(`${signerLedgerPath}-shm`, { force: true });
    const sent = ledger.submitCalls.length;
    const restarted = await restartedRig({ dir, witness, ledger, pairs, signerLedgerPath });
    try {
      restarted.ledger.autoAdvance = false;
      const signer = await signerObservation(restarted, action.correlation.executionId);
      assert.equal(signer.state, 'absent', 'the restored ledger forgot the consumption');
      const report = await coordinatorFor(restarted).assess(action.correlation.executionId, { p11: p11Of(action, outcome), signer });
      assert.equal(report.assessment.class, 'inconsistent-evidence');
      assert.ok(report.assessment.inconsistencies.includes('signer-denies-host-verified-signature'));
      restarted.book.attest(raw);
      const again = await restarted.adapter.execute(action);
      assert.deepEqual([again.outcome, 'detail' in again ? again.detail : undefined], ['unconfirmed', 'trade-execution-previously-recorded']);
      assert.deepEqual(effects(restarted), { signatures: 0, submissions: sent }, 'no new signature, no new submission');
    } finally {
      await restarted.close();
    }
  });
});

describe('TRADE-04D Scenario K — concurrent recovery', () => {
  it('two coordinators and the P12 authority on one execution at once: identical assessments, one settlement, no new effect', async () => {
    const rig = await executorRig();
    try {
      rig.ledger.behavior = { kind: 'throw-after-send', includeWith: 'tesSUCCESS' };
      const { action } = order(rig);
      const result = await rig.adapter.execute(action);
      rig.ledger.autoAdvance = false;
      const before = await rig.interlock.read(action.correlation.executionId);
      const [a, b] = await Promise.all([coordinatorFor(rig).assess(action.correlation.executionId, { p11: p11Of(action, result) }), coordinatorFor(rig).assess(action.correlation.executionId, { p11: p11Of(action, result) })]);
      assert.deepEqual(a, b);
      assert.deepEqual(await rig.interlock.read(action.correlation.executionId), before, 'assessments write nothing');
      rig.ledger.advance(1);
      const providerRef = result.outcome === 'unconfirmed' ? result.providerRef : undefined;
      const [c, d, resolved1, resolved2] = await Promise.all([
        coordinatorFor(rig).assess(action.correlation.executionId, { p11: p11Of(action, result) }),
        coordinatorFor(rig).assess(action.correlation.executionId, { p11: p11Of(action, result) }),
        resolverFor(rig).resolve(queryOf(action, providerRef)),
        resolverFor(rig).resolve(queryOf(action, providerRef)),
      ]);
      assert.deepEqual([c.assessment.class, d.assessment.class], ['validated-success', 'validated-success']);
      assert.deepEqual(resolved1, resolved2);
      const after = (await rig.interlock.read(action.correlation.executionId))!;
      assert.equal(after.transitions.filter((transition) => transition.to === 'settled').length, 1);
      assert.deepEqual(effects(rig), { signatures: 1, submissions: 1 });
    } finally {
      await rig.close();
    }
  });
});

describe('TRADE-04D Scenario L — adversarial evidence refuses authoritative settlement', () => {
  const tamperings: readonly [string, (answer: Record<string, unknown>) => unknown][] = [
    ['tampered hash', (answer) => ({ ...answer, hash: 'F'.repeat(64) })],
    ['another owner', (answer) => ({ ...answer, tx_json: { ...(answer['tx_json'] as object), Account: 'rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe' } })],
    ['another transaction type', (answer) => ({ ...answer, tx_json: { ...(answer['tx_json'] as object), TransactionType: 'Payment' } })],
    ['another Sequence', (answer) => ({ ...answer, tx_json: { ...(answer['tx_json'] as object), Sequence: 1 } })],
    ['another LastLedgerSequence', (answer) => ({ ...answer, tx_json: { ...(answer['tx_json'] as object), LastLedgerSequence: 1 } })],
    ['a ledger outside the window', (answer) => ({ ...answer, ledger_index: 2 })],
    ['a ledger inside the window but beyond the validated index', (answer) => ({ ...answer, ledger_index: (answer['tx_json'] as { LastLedgerSequence: number }).LastLedgerSequence })],
    ['a fabricated, non-validated-class result', (answer) => ({ ...answer, meta: { TransactionResult: 'tefPAST_SEQ' } })],
  ];
  for (const [name, tamper] of tamperings) {
    it(`${name}: the P12 authority answers unresolved and settles nothing; the assessment is not a closure`, async () => {
      const rig = await executorRig({ configuration: { finalityTimeoutMs: 0 } });
      try {
        rig.ledger.behavior = { kind: 'accept' };
        const { action } = order(rig);
        const result = await rig.adapter.execute(action);
        assert.equal(result.outcome, 'unconfirmed');
        rig.ledger.autoAdvance = false;
        rig.ledger.advance(1);
        rig.ledger.faults.tamperLookup = tamper;
        assert.deepEqual(await resolverFor(rig).resolve(queryOf(action, result.outcome === 'unconfirmed' ? result.providerRef : undefined)), { outcome: 'unresolved' });
        assert.notEqual((await rig.interlock.read(action.correlation.executionId))?.state, 'settled');
        const report = await coordinatorFor(rig).assess(action.correlation.executionId, { p11: p11Of(action, result) });
        assert.ok(['inconsistent-evidence', 'indeterminate'].includes(report.assessment.class), report.assessment.class);
      } finally {
        await rig.close();
      }
    });
  }

  it('a wrong network: unresolved, inconsistent; fabricated metadata (two own offers) leaves the transaction fact but no offer claim', async () => {
    const rig = await executorRig();
    try {
      const { action } = order(rig);
      const result = await rig.adapter.execute(action);
      rig.ledger.autoAdvance = false;
      rig.ledger.faults.networkId = 2;
      const wrong = await coordinatorFor(rig).assess(action.correlation.executionId, { p11: p11Of(action, result) });
      assert.deepEqual([wrong.assessment.class, wrong.assessment.ledger.reason], ['inconsistent-evidence', 'network-mismatch']);
      rig.ledger.faults.networkId = 1;
      rig.ledger.faults.tamperLookup = (answer) => {
        const meta = answer['meta'] as { AffectedNodes: unknown[] };
        const created = meta.AffectedNodes.find((node) => 'CreatedNode' in (node as object));
        return { ...answer, meta: { ...meta, AffectedNodes: [...meta.AffectedNodes, created] } };
      };
      const fabricated = await coordinatorFor(rig).assess(action.correlation.executionId, { p11: p11Of(action, result) });
      assert.deepEqual([fabricated.assessment.class, fabricated.assessment.offer?.interpretation, fabricated.assessment.offer?.reason], ['validated-success', 'state-unknown', 'offer-created-twice']);
    } finally {
      await rig.close();
    }
  });
});

describe('TRADE-04D §8 — crash, restart and consistency (Phase 8 A–T not covered above)', () => {
  it('A clean restart: the settled execution assesses identically; the same execution again is previously recorded — nothing signed or sent', async () => {
    const dir = persistent().dir;
    const witness = await startWitness();
    const ledger = new FakeXrplLedger();
    const pairs = [pairWorld(ledger)];
    const signerLedgerPath = await signerLedger();
    const rig = await executorRig({ dir, witness, ledger, pairs, signerLedgerPath });
    const { raw, action } = order(rig);
    const outcome = await rig.adapter.execute(action);
    ledger.autoAdvance = false;
    const before = await coordinatorFor(rig).assess(action.correlation.executionId, { p11: p11Of(action, outcome), offerSnapshot: false });
    await rig.close();
    const sent = ledger.submitCalls.length;
    const restarted = await restartedRig({ dir, witness, ledger, pairs, signerLedgerPath });
    try {
      ledger.autoAdvance = false;
      const after = await coordinatorFor(restarted).assess(action.correlation.executionId, { p11: p11Of(action, outcome), offerSnapshot: false });
      assert.deepEqual([after.assessment.class, after.assessment.lifecycle], [before.assessment.class, before.assessment.lifecycle]);
      restarted.book.attest(raw);
      assert.equal(((await restarted.adapter.execute(action)) as { detail?: string }).detail, 'trade-execution-previously-recorded');
      assert.deepEqual(effects(restarted), { signatures: 0, submissions: sent });
    } finally {
      await restarted.close();
    }
  });

  it('E/G/H a crash after the durable reservation, after the claim, or after the network send — before local bookkeeping: each is assessed from its last durable state and the ledger, never re-sent', async () => {
    for (const [phase, behavior, crashSubmit, expectedState] of [
      ['after reservation', { kind: 'accept' }, 'before-claim', 'reserved'],
      ['after the claim, before the send', { kind: 'accept' }, 'after-claim', 'submitting'],
      ['after the send, before settlement', { kind: 'accept', finalResult: 'tesSUCCESS' }, 'none', 'submitting'],
    ] as const) {
      const rig = await executorRig({
        configuration: { finalityTimeoutMs: 0 },
        createInterlock: async (...args) => {
          const real = await createSqliteTradeSequenceInterlock(...args);
          // The process dies before its local bookkeeping: markUnconfirmed / settle never land.
          return { ...real, markUnconfirmed: async () => Promise.reject(new Error('crash')), settle: async () => Promise.reject(new Error('crash')), read: real.read, health: real.health, close: real.close } as DurableTradeSequenceInterlock;
        },
        create: (options) =>
          createTradeOfferExecutionAdapter({
            ...options,
            ledger: {
              ...options.ledger,
              submitReserved: async (executionId: string, blob: string) => {
                if (crashSubmit === 'before-claim') throw Object.assign(new Error('crash before the submit site ran'), { code: 'XRPL_SUBMISSION_NOT_ATTEMPTED' });
                if (crashSubmit === 'after-claim') {
                  const { xrplSubmissionClaimOf } = await import('../../features/payment-runtime/rails/xrpl/index.js');
                  await (options.interlock as unknown as DurableTradeSequenceInterlock).claimSubmission(xrplSubmissionClaimOf(executionId, NETWORK_ID, blob)!);
                  throw new Error('crash after the claim, before the send');
                }
                return options.ledger.submitReserved(executionId, blob);
              },
            },
          }),
      });
      try {
        rig.ledger.behavior = behavior;
        const { action } = order(rig);
        const result = await rig.adapter.execute(action);
        assert.notEqual(result.outcome, 'completed', phase);
        rig.ledger.autoAdvance = false;
        const record = (await rig.interlock.read(action.correlation.executionId))!;
        assert.equal(record.state, expectedState, phase);
        const pending = await coordinatorFor(rig).assess(action.correlation.executionId, { p11: p11Of(action) });
        assert.equal(pending.assessment.class, expectedState === 'reserved' ? 'reserved-not-claimed' : 'submission-claimed', phase);
        assert.equal(pending.assessment.fronteraSubmission, expectedState === 'reserved' ? 'never' : 'claimed', phase);
        rig.ledger.advance(crashSubmit === 'none' ? 1 : 40);
        const settledBy = await coordinatorFor(rig).assess(action.correlation.executionId, { p11: p11Of(action) });
        assert.equal(settledBy.assessment.class, crashSubmit === 'none' ? 'validated-success' : 'proven-not-included', phase);
        assert.deepEqual(effects(rig).submissions, crashSubmit === 'none' ? 1 : 0, phase);
        assert.equal(effects(rig).signatures, 1, phase);
      } finally {
        await rig.close();
      }
    }
  });

  it('N the witness unavailable: the read reports freshness unproven and new orders are refused before signing (F — a crash during CORE-07 preparation — is TRADE-04C’s PENDING_RECOVERY open refusal, re-run in preservation)', async () => {
    const witness = await startWitness();
    const rig = await executorRig({ witness });
    try {
      const { action } = order(rig);
      const outcome = await rig.adapter.execute(action);
      rig.ledger.autoAdvance = false;
      await witness.close();
      await assert.rejects(rig.interlock.blocking({ account: rig.pairs[0]!.owner, sequence: 1, validatedLedgerIndex: rig.ledger.validatedIndex }));
      const report = await coordinatorFor(rig).assess(action.correlation.executionId, { p11: p11Of(action, outcome) });
      assert.ok(report.assessment.uncertainties.includes('interlock-freshness-unproven'));
      const refused = await rig.adapter.execute(order(rig).action);
      assert.deepEqual([refused.outcome, 'detail' in refused ? refused.detail : undefined], ['failed', 'trade-interlock-unavailable']);
    } finally {
      await rig.close();
    }
  });

  it('K a lost submission claim (the interlock restored to before its claim) is refused by CORE-07 at the next open', async () => {
    const witness = await startWitness();
    const dir = persistent().dir;
    const path = join(dir, 'claim-rollback.sqlite');
    const owner = pairWorld(new FakeXrplLedger()).owner;
    const open = async () => createSqliteTradeSequenceInterlock(path, { scope: { domainId: XRPL_TRADE_EXECUTOR_ID, networkId: NETWORK_ID }, sequenceAccounts: [owner], now: () => new Date().toISOString(), freshness: { boundary: await boundaryFor(witness, ORG) } });
    const store = await open();
    const reservation = { executionId: 'aoc.exec:trade04d-claim', account: owner, sequence: 7, lastLedgerSequence: 520, minLedger: 501, transactionHash: 'A'.repeat(64), evidence: { organizationId: ORG, subject: 's', requestId: 'r', decisionId: 'd', boundedGrantId: 'g', proposalDigest: 'sha256:p', delegateAccount: pairWorld(new FakeXrplLedger()).owner, signerId: 'sig', signerRequestId: 'q', signingPublicKey: 'ED00', keyAuthority: 'master-key' as const, preparedDigest: 'sha256:x', delegationAssessmentDigest: 'sha256:a', delegationFactsDigest: 'sha256:f', referenceLedgerIndex: 500, referenceLedgerHash: 'B'.repeat(64), delegationLedgerIndex: 500, delegateRootLedgerIndex: 500, ownerRootLedgerIndex: 500, fee: '12', ledgerProvenance: 'injected-ledger-client' as const } };
    assert.equal((await store.reserve(reservation, 500)).outcome, 'reserved');
    await store.close();
    copyFileSync(path, `${path}.backup`);
    const reopened = await open();
    await reopened.claimSubmission({ executionId: reservation.executionId, networkId: NETWORK_ID, transactionType: 'OfferCreate', transactionHash: reservation.transactionHash, account: owner, sequence: 7, lastLedgerSequence: 520 });
    await reopened.close();
    copyFileSync(`${path}.backup`, path);
    for (const suffix of ['-wal', '-shm']) if (existsSync(`${path}${suffix}`)) rmSync(`${path}${suffix}`);
    await assert.rejects(open(), (error: { code?: string }) => /REGRESSED|ROLLBACK|PENDING|FORK/.test(String(error.code)));
  });

  it('M a corrupted or incomplete interlock file is refused, never repaired', async () => {
    const path = join(persistent().dir, 'corrupt.sqlite');
    writeFileSync(path, Buffer.concat([Buffer.from('SQLite format 3\0'), Buffer.alloc(512, 0x5a)]));
    await assert.rejects(createSqliteTradeSequenceInterlock(path, { now: () => new Date().toISOString() }));
  });

  it('O the network identity changed after a restart: unresolved and inconsistent, nothing settles', async () => {
    const rig = await executorRig({ configuration: { finalityTimeoutMs: 0 } });
    try {
      const { action } = order(rig);
      const result = await rig.adapter.execute(action);
      rig.ledger.autoAdvance = false;
      rig.ledger.advance(1);
      rig.ledger.faults.networkId = 2;
      assert.deepEqual(await resolverFor(rig).resolve(queryOf(action, result.outcome === 'unconfirmed' ? result.providerRef : undefined)), { outcome: 'unresolved' });
      assert.equal((await coordinatorFor(rig).assess(action.correlation.executionId)).assessment.class, 'inconsistent-evidence');
      assert.notEqual((await rig.interlock.read(action.correlation.executionId))?.state, 'settled');
    } finally {
      await rig.close();
    }
  });

  it('Q Payment and Trade claiming one owner account on one network are refused before either store opens (the rule the Host applies)', () => {
    const owner = pairWorld(new FakeXrplLedger()).owner;
    assert.throws(() => assertXrplSequenceOwnership([{ domainId: 'xrpl-rlusd', networkId: 1, sequenceAccounts: [owner] }, { domainId: XRPL_TRADE_EXECUTOR_ID, networkId: 1, sequenceAccounts: [owner] }]), { code: 'XRPL_SEQUENCE_ACCOUNT_SHARED' });
  });

  it('R/S a capability that expired during the crash, or a grant revoked during recovery: the assessment does not change (no clock, no grant input); a re-execution is refused before signing', async () => {
    let revoked = false;
    const issuer = testCapabilityIssuer({ refuse: () => (revoked ? new DelegatedOfferCapabilityError('CAPABILITY_GRANT_REVOKED', 'revoked') : undefined) });
    const signerLedgerPath = await signerLedger();
    const rig = await executorRig({ issuer, signerLedgerPath, create: withSigner(() => ({ signDelegatedOffer: async () => Promise.reject(new Error('signer crashed')) })) });
    try {
      const { action } = order(rig);
      const result = await rig.adapter.execute(action);
      const context = { p11: p11Of(action, result), signer: await signerObservation(rig, action.correlation.executionId) };
      const first: TradeRecoveryReport = await coordinatorFor(rig).assess(action.correlation.executionId, context);
      revoked = true;
      const second = await coordinatorFor(rig).assess(action.correlation.executionId, context);
      assert.deepEqual(second.assessment, first.assessment);
      const again = await rig.adapter.execute(action);
      assert.deepEqual([again.outcome, 'detail' in again ? again.detail : undefined], ['failed', 'trade-capability-refused']);
      assert.deepEqual(effects(rig, issuer), { signatures: 0, submissions: 0, capabilities: 1 });
    } finally {
      await rig.close();
    }
  });

  it('T a regressing interlock clock changes no assessment: timestamps are recorded, never decided on', async () => {
    let tick = Date.parse('2026-10-15T12:00:00.000Z');
    const rig = await executorRig({ createInterlock: (path, options) => createSqliteTradeSequenceInterlock(path, { ...options, now: () => new Date((tick -= 1_000)).toISOString() }) });
    try {
      const { action } = order(rig);
      const outcome = await rig.adapter.execute(action);
      rig.ledger.autoAdvance = false;
      const report = await coordinatorFor(rig).assess(action.correlation.executionId, { p11: p11Of(action, outcome) });
      assert.equal(report.assessment.class, 'validated-success');
    } finally {
      await rig.close();
    }
  });
});
