import { copyFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import Database from 'better-sqlite3';

import type { ValidatedExecutionAction } from '../../features/execution-runtime/index.js';
import { createHttpAuthorityStateWitnessTransport } from '../authority-state-freshness/index.js';
import { XRPL_TRADE_EXECUTOR_ID } from '../xrpl-trade-execution/host-configuration.js';
import {
  TRADE_INTERLOCK_STORE_SCHEMA_VERSION,
  TRADE_INTERLOCK_STORE_SCHEMA_VERSION_V1,
  TRADE_INTERLOCK_SUPPORTED_SCHEMA_VERSIONS,
  createSqliteTradeSequenceInterlock,
  createTradeOfferExecutionAdapter,
  createTradeRecoveryCoordinator,
  createTradeResolutionAuthority,
  readOnlyTradeLedger,
  readOnlyTradeRecoveryLedger,
  type DurableTradeSequenceInterlock,
  type TradeExecutionInterlock,
  type TradeReservationInput,
} from '../xrpl-trade-execution/index.js';
import { ScriptedWitnessTransport, WITNESS_TOKEN, boundaryFor, closeAllWitnesses, startWitness, type StartedWitness } from './core07-freshness-fixture.js';
import { ACTION, FakeXrplLedger, NETWORK_ID, ORG, executorRig, rawProposal, scratch, validatedAction, type ExecutorRig, type TradePairWorld } from './trade04c-execution-fixture.js';
import { testCapabilityIssuer } from './trade04c-s1-capability-fixture.js';
import { intendAndSign, intentFor, reserveWithIntent, testCapabilityId, validatedEntryReader } from './trade04d-intent-fixture.js';
import { createV1TradeSequenceInterlockForMigrationTests } from './trade04d-v1-interlock-fixture.js';
import { testAccount } from './trade04b-xrpl-fixture.js';
import { readXrplOwnerSequence } from '../../features/trade-runtime/rails/xrpl/index.js';
import { readTradeOwnerSequence, readTradeSequenceEvidence } from '../xrpl-trade-execution/trade-sequence-evidence.js';

/**
 * TRADE-04D D-1 — the durable pre-signing intent, qualified offline on the
 * real executor, the real CORE-07-anchored SQLite interlock and a real
 * loopback reference witness, the real reference signer (its durable
 * capability ledger), and the labelled fake ledger. Every scenario counts the
 * effects no crash or recovery may add — capabilities issued, signatures,
 * submissions — and the durable records (intents, reservations).
 *
 * Crash model: the executor is a promise that never resumes (a boundary that
 * never answers), then the rig is closed and a new one opened on the same
 * interlock file, witness, fake ledger and signer ledger.
 */

const spaces: { cleanup(): void }[] = [];
after(async () => {
  await closeAllWitnesses();
  for (const space of spaces.splice(0)) space.cleanup();
});
const persistent = (): string => {
  const space = scratch();
  spaces.push(space);
  return space.dir;
};
const never = <T>(): Promise<T> => new Promise<T>(() => {});
const now = (): string => new Date().toISOString();

function order(rig: ExecutorRig, pair: TradePairWorld = rig.pairs[0]!): { readonly raw: Record<string, unknown>; readonly action: ValidatedExecutionAction } {
  const raw = rawProposal(pair);
  rig.book.attest(raw);
  return { raw, action: validatedAction(raw) };
}

/** The effects no recovery may add, and the durable records. */
async function counts(rig: ExecutorRig, issuer: { readonly issued: readonly unknown[] }) {
  const durable = await rig.interlock.verifyAll();
  return { capabilities: issuer.issued.length, signatures: rig.signer.signatures(), submissions: rig.ledger.submitCalls.length, intents: durable.intents, reservations: durable.records };
}

/** An executor over a wrapped interlock: `hang` makes one interlock step never answer (the process "dies" there). */
function crashingAt(step: keyof TradeExecutionInterlock): typeof createTradeOfferExecutionAdapter {
  return (options) => createTradeOfferExecutionAdapter({ ...options, interlock: { ...options.interlock, [step]: () => never() } as TradeExecutionInterlock });
}

function resolverFor(rig: ExecutorRig) {
  const reads = readOnlyTradeRecoveryLedger(rig.ledger.client(NETWORK_ID, rig.interlock));
  return createTradeResolutionAuthority({ networkId: NETWORK_ID, action: ACTION, requestTimeoutMs: 1_000, ledger: readOnlyTradeLedger(rig.ledger.client(NETWORK_ID, rig.interlock)), interlock: rig.interlock, entries: validatedEntryReader(reads, NETWORK_ID) });
}
function coordinatorFor(rig: ExecutorRig) {
  return createTradeRecoveryCoordinator({ networkId: NETWORK_ID, requestTimeoutMs: 1_000, maxValidatedLedgerAgeSeconds: 10, ledger: readOnlyTradeRecoveryLedger(rig.ledger.client(NETWORK_ID, rig.interlock)), interlock: rig.interlock });
}
const queryOf = (action: ValidatedExecutionAction, providerRef?: string) => ({ organizationId: ORG, executionId: action.correlation.executionId, evaluationId: 'eval-d1', requestId: action.correlation.requestId, decisionId: action.correlation.decisionId, boundedGrantId: action.boundedGrantId, action: ACTION, ...(providerRef !== undefined ? { providerRef } : {}), basis: 'initial-observation-unconfirmed' as const });
const p11Of = (action: ValidatedExecutionAction) => ({ record: { attempt: { organizationId: ORG, executionId: action.correlation.executionId, requestId: action.correlation.requestId, decisionId: action.correlation.decisionId, boundedGrantId: action.boundedGrantId, action: action.action } } });

/** A world that survives a crash: the interlock directory, witness, fake ledger, pairs and an explicitly initialized signer ledger. */
async function world() {
  const { initializeReferenceCapabilityLedger } = await import('../xrpl-trade-rail/reference/reference-delegated-offer-signer.js');
  const dir = persistent();
  const signerLedgerPath = join(persistent(), 'signer-ledger.sqlite');
  await initializeReferenceCapabilityLedger(signerLedgerPath);
  const ledger = new FakeXrplLedger();
  const witness = await startWitness();
  const { pairWorld } = await import('./trade04c-execution-fixture.js');
  return { dir, witness, ledger, pairs: [pairWorld(ledger)], signerLedgerPath };
}

describe('TRADE-04D D-1 — the intent is durable and anchored before any capability exists', () => {
  it('a normal execution: intent → signing → bound, exactly one capability, one signature, one submission; the anchored history holds intent, sign, reserve and claim', async () => {
    const issuer = testCapabilityIssuer();
    const rig = await executorRig({ issuer });
    try {
      const { action } = order(rig);
      const result = await rig.adapter.execute(action);
      assert.equal(result.outcome, 'completed');
      const intent = await rig.interlock.readIntent(action.correlation.executionId);
      assert.equal(intent?.state, 'bound');
      assert.deepEqual(intent?.transitions.map((transition) => transition.to), ['intended', 'signing', 'bound']);
      assert.equal(intent?.capabilityId, issuer.issued[0]?.capabilityId, 'the capability handed to the signer is bound to the intent');
      assert.equal(intent?.signingPreimageDigest, issuer.issued[0]?.signingPreimageDigest, 'the intent fixed the exact preimage the capability names');
      const record = (await rig.interlock.read(action.correlation.executionId))!;
      assert.deepEqual([intent?.account, intent?.sequence, intent?.lastLedgerSequence, intent?.minLedger, intent?.evidence.fee, intent?.evidence.network, intent?.evidence.referenceLedgerHash], [record.account, record.sequence, record.lastLedgerSequence, record.minLedger, record.evidence.fee, 'xrp-ledger-testnet', record.evidence.referenceLedgerHash]);
      assert.deepEqual(await counts(rig, issuer), { capabilities: 1, signatures: 1, submissions: 1, intents: 1, reservations: 1 });
      const db = new Database(rig.path, { readonly: true });
      try {
        assert.deepEqual((db.prepare('SELECT kind FROM trade_anchored_history ORDER BY row_id').all() as { kind: string }[]).map((row) => row.kind), ['intent', 'sign', 'reserve', 'claim']);
      } finally {
        db.close();
      }
    } finally {
      await rig.close();
    }
  });

  it('witness unavailable before the intent: refused before any capability (no issuance, no signature, no record)', async () => {
    const witness = await startWitness();
    const issuer = testCapabilityIssuer();
    const rig = await executorRig({ witness, issuer, create: (options) => createTradeOfferExecutionAdapter({ ...options, interlock: { ...options.interlock, blocking: async () => false } as TradeExecutionInterlock }) });
    try {
      await witness.close();
      const { action } = order(rig);
      const result = await rig.adapter.execute(action);
      assert.deepEqual([result.outcome, 'detail' in result ? result.detail : undefined], ['failed', 'trade-intent-failed'], 'even with the pre-signing probe bypassed, the anchored intent refuses');
      assert.deepEqual([issuer.issued.length, rig.signer.signatures(), rig.ledger.submitCalls.length], [0, 0, 0]);
    } finally {
      await rig.close();
    }
  });

  it('crash during CORE-07 preparation of the intent (witness prepared, file never committed): no intent, no capability; the next open is PENDING_RECOVERY — never guessed', async () => {
    const witness = await startWitness();
    const dir = persistent();
    const path = join(dir, 'trade-interlock.sqlite');
    const scripted = new ScriptedWitnessTransport(createHttpAuthorityStateWitnessTransport({ endpoint: witness.endpoint, credential: WITNESS_TOKEN }));
    const boundary = await boundaryFor(witness, ORG, { transport: scripted });
    let blocker: InstanceType<typeof Database> | undefined;
    const issuer = testCapabilityIssuer();
    const rig = await executorRig({ dir, witness, issuer, createInterlock: (file, options) => createSqliteTradeSequenceInterlock(file, { ...options, busyTimeoutMs: 0, freshness: { boundary } }) });
    try {
      scripted.answer = async (request, forward) => {
        const answer = await forward();
        if (request.operation === 'prepare') {
          blocker = new Database(path);
          blocker.exec('BEGIN EXCLUSIVE');
        }
        return answer;
      };
      const { action } = order(rig);
      const result = await rig.adapter.execute(action);
      blocker?.exec('ROLLBACK');
      blocker?.close();
      scripted.answer = (_request, forward) => forward();
      assert.deepEqual([result.outcome, 'detail' in result ? result.detail : undefined], ['failed', 'trade-intent-failed']);
      assert.deepEqual([issuer.issued.length, rig.signer.signatures(), rig.ledger.submitCalls.length], [0, 0, 0]);
    } finally {
      await rig.close();
    }
    await assert.rejects(createSqliteTradeSequenceInterlock(path, { scope: { domainId: XRPL_TRADE_EXECUTOR_ID, networkId: NETWORK_ID }, sequenceAccounts: [testAccount()], now, freshness: { boundary: await boundaryFor(witness, ORG) } }), (error: { code?: string }) => error.code === 'AUTHORITY_FRESHNESS_PENDING_RECOVERY');
    const verifier = await createSqliteTradeSequenceInterlock(path, { now });
    assert.deepEqual(await verifier.verifyAll(), { records: 0, open: 0, intents: 0, openIntents: 0 }, 'the file holds no intent: nothing was issued against it');
    await verifier.close();
  });
});

describe('TRADE-04D D-1 — crash points: no re-signing, no resubmission, the window held until a ledger fact', () => {
  it('crash before the intent commit (the process dies inside recordIntent): nothing durable, no capability; a restart executes nothing twice and a fresh order runs', async () => {
    const w = await world();
    const issuer = testCapabilityIssuer();
    const rig = await executorRig({ ...w, issuer, create: crashingAt('recordIntent') });
    const { raw, action } = order(rig);
    void rig.adapter.execute(action);
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.deepEqual(await counts(rig, issuer), { capabilities: 0, signatures: 0, submissions: 0, intents: 0, reservations: 0 });
    await rig.close();
    const issuer2 = testCapabilityIssuer();
    const restarted = await executorRig({ ...w, issuer: issuer2 });
    try {
      restarted.book.attest(raw);
      // No record anywhere: P11's claim (never reopened) is what keeps the same execution from running again; a fresh order runs normally.
      const fresh = await restarted.adapter.execute(order(restarted).action);
      assert.equal(fresh.outcome, 'completed');
      assert.deepEqual(await counts(restarted, issuer2), { capabilities: 1, signatures: 1, submissions: 1, intents: 1, reservations: 1 });
    } finally {
      await restarted.close();
    }
  });

  for (const [name, step, issued] of [
    ['after the intent commit, before capability issuance', 'issue', 0],
    ['after capability issuance, before the signing marker', 'markSigning', 1],
  ] as const) {
    it(`crash ${name}: the intent stays \`intended\` and its window held — never released on the Host's own record (a capability may exist outside it); restart refuses; only the owner-Sequence proof past LastLedgerSequence releases it`, async () => {
      const w = await world();
      const issuer = step === 'issue' ? { issued: [] as unknown[], issue: () => never<never>() } : testCapabilityIssuer();
      const rig = await executorRig({ ...w, issuer: issuer as ReturnType<typeof testCapabilityIssuer>, ...(step === 'markSigning' ? { create: crashingAt('markSigning') } : {}) });
      const { raw, action } = order(rig);
      void rig.adapter.execute(action);
      await new Promise((resolve) => setTimeout(resolve, 400));
      const executionId = action.correlation.executionId;
      assert.equal((await rig.interlock.readIntent(executionId))?.state, 'intended');
      assert.deepEqual(await counts(rig, issuer), { capabilities: issued, signatures: 0, submissions: 0, intents: 1, reservations: 0 });
      await rig.close();

      const issuer2 = testCapabilityIssuer();
      const restarted = await executorRig({ ...w, issuer: issuer2, quarantine: true });
      try {
        restarted.book.attest(raw);
        restarted.ledger.autoAdvance = false;
        const intent = (await restarted.interlock.readIntent(executionId))!;
        assert.equal(await restarted.interlock.blocking({ account: intent.account, sequence: intent.sequence, validatedLedgerIndex: intent.lastLedgerSequence - 1 }), true, 'restart with an unresolved intent: the window is still held');
        const again = await restarted.adapter.execute(action);
        assert.deepEqual([again.outcome, 'detail' in again ? again.detail : undefined], ['unconfirmed', 'trade-execution-previously-recorded']);
        const report = await coordinatorFor(restarted).assess(executionId, { p11: p11Of(action) });
        assert.deepEqual([report.assessment.class, report.assessment.certainty, report.assessment.signature, report.assessment.sequence.status], ['capability-not-consumed', 'pending', 'not-sent-by-host', 'blocked']);
        assert.ok(report.assessment.uncertainties.includes('capability-issuance-unknown'));
        assert.deepEqual(await resolverFor(restarted).resolve(queryOf(action)), { outcome: 'unresolved' }, 'P12 never closes an intent on the Host’s own record');
        assert.equal((await restarted.interlock.readIntent(executionId))?.state, 'intended');
        restarted.ledger.advance(intent.lastLedgerSequence - restarted.ledger.validatedIndex);
        assert.deepEqual(await resolverFor(restarted).resolve(queryOf(action)), { outcome: 'resolved', certainty: 'confirmed-not-completed', failure: 'PROVIDER_REJECTED' });
        assert.equal((await restarted.interlock.readIntent(executionId))?.state, 'expired');
        assert.deepEqual(await counts(restarted, issuer2), { capabilities: 0, signatures: 0, submissions: 0, intents: 1, reservations: 0 });
      } finally {
        await restarted.close();
      }
    });
  }

  it('capability issued while the Host saw a timeout (external issuance outcome unknown): the intent stays open; a holder of the signer credential and the intercepted capability can sign only the original transaction; no other order takes the Sequence; P12 never reports it not-completed while the Sequence is consumed', async () => {
    const { validateTradeProposal } = await import('../../features/trade-runtime/index.js');
    const { preparedDelegatedOfferFromProposal } = await import('../xrpl-trade-rail/index.js');
    const w = await world();
    const inner = testCapabilityIssuer();
    let intercepted: Awaited<ReturnType<typeof inner.issue>> | undefined;
    // The external authority signer signed; its answer was lost to the Host but copied off the wire.
    const issuer = { issued: inner.issued, issue: async (input: Parameters<typeof inner.issue>[0]) => {
      intercepted = await inner.issue(input);
      throw new (await import('../authority-authenticity/delegated-offer-capability-issuer.js')).DelegatedOfferCapabilityError('CAPABILITY_SIGNING_UNAVAILABLE', 'timed out');
    } };
    const rig = await executorRig({ ...w, issuer: issuer as ReturnType<typeof testCapabilityIssuer> });
    try {
      rig.ledger.autoAdvance = false;
      const { raw, action } = order(rig);
      const result = await rig.adapter.execute(action);
      assert.deepEqual([result.outcome, 'detail' in result ? result.detail : undefined], ['failed', 'trade-capability-unavailable']);
      const executionId = action.correlation.executionId;
      const intent = (await rig.interlock.readIntent(executionId))!;
      assert.equal(intent.state, 'intended', 'the Host never handed the capability to the signer — and does not release the window for it');
      assert.ok(intercepted !== undefined);

      // A competing order on the same owner is refused before any capability.
      const before = inner.issued.length;
      const competing = await rig.adapter.execute(order(rig).action);
      assert.deepEqual([competing.outcome, 'detail' in competing ? competing.detail : undefined], ['failed', 'trade-sequence-in-flight']);
      assert.equal(inner.issued.length, before);

      // The attacker presents the intercepted capability with the signer credential: it signs exactly the intent's transaction.
      const accepted = validateTradeProposal(raw);
      assert.ok(accepted.valid);
      const offer = preparedDelegatedOfferFromProposal(accepted.accepted.proposal, accepted.accepted.terms.flagsValue, { sequence: intent.sequence, fee: intent.evidence.fee, lastLedgerSequence: intent.lastLedgerSequence });
      const signature = await rig.signerClient.signDelegatedOffer({ transaction: offer, proposal: accepted.accepted.proposal, authorization: { capability: intercepted!.canonical, signature: intercepted!.signature }, validatedLedgerIndex: intent.minLedger - 1 });
      assert.equal(signature.status, 'signed-not-submitted');
      assert.equal(signature.transaction.Sequence, intent.sequence, 'the capability binds the intent’s exact preimage: the same Sequence and window');
      // Out of band, it is included: the owner Sequence is consumed.
      rig.ledger.fund(intent.account, intent.sequence + 1);
      rig.ledger.advance(intent.lastLedgerSequence - rig.ledger.validatedIndex + 1);
      assert.deepEqual(await resolverFor(rig).resolve(queryOf(action)), { outcome: 'unresolved' }, 'before this review the executor abandoned such an intent and P12 reported it not-completed');
      const report = await coordinatorFor(rig).assess(executionId, { p11: p11Of(action) });
      assert.ok(report.assessment.uncertainties.includes('sequence-consumed-by-unknown-transaction'));
      assert.equal((await rig.interlock.readIntent(executionId))?.state, 'intended');
      assert.equal(rig.ledger.submitCalls.length, 0, 'Frontera sent nothing');
    } finally {
      await rig.close();
    }
  });

  it('crash after the signing marker, before the signer answers (capability consumed, maybe signed): the window is held; a forged release is refused; the owner-Sequence proof past LastLedgerSequence closes it — never a second signature', async () => {
    const w = await world();
    const issuer = testCapabilityIssuer();
    const rig = await executorRig({ ...w, issuer, create: (options) => createTradeOfferExecutionAdapter({ ...options, signer: { signDelegatedOffer: async (request) => { await options.signer.signDelegatedOffer(request); return never(); } } }) });
    const { raw, action } = order(rig);
    const executionId = action.correlation.executionId;
    void rig.adapter.execute(action);
    for (let i = 0; i < 50 && rig.signer.signatures() === 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(await counts(rig, issuer), { capabilities: 1, signatures: 1, submissions: 0, intents: 1, reservations: 0 });
    await rig.close();

    const issuer2 = testCapabilityIssuer();
    const restarted = await executorRig({ ...w, issuer: issuer2, quarantine: true });
    try {
      restarted.book.attest(raw);
      restarted.ledger.autoAdvance = false;
      const intent = (await restarted.interlock.readIntent(executionId))!;
      assert.equal(intent.state, 'signing');
      await assert.rejects(restarted.interlock.expireIntent(executionId, { status: 'not-included', proof: 'owner-sequence-unconsumed', window: { account: intent.account, sequence: intent.sequence, lastLedgerSequence: intent.lastLedgerSequence }, ledgerIndex: intent.lastLedgerSequence, ledgerHash: 'B'.repeat(64), accountSequence: intent.sequence }), (error: { check?: string }) => error.check === 'expiry-without-qualified-proof', 'a forged proof never releases it');
      // The same Sequence for another order is blocked while the window is open.
      assert.equal(await restarted.interlock.blocking({ account: intent.account, sequence: intent.sequence, validatedLedgerIndex: intent.lastLedgerSequence - 1 }), true);
      const again = await restarted.adapter.execute(action);
      assert.deepEqual([again.outcome, 'detail' in again ? again.detail : undefined], ['unconfirmed', 'trade-execution-previously-recorded']);
      // Window open: unresolved, never closed by elapsed time.
      if (restarted.ledger.validatedIndex >= intent.lastLedgerSequence) assert.fail('the fixture must still be inside the window');
      assert.deepEqual(await resolverFor(restarted).resolve(queryOf(action)), { outcome: 'unresolved' });
      const pending = await coordinatorFor(restarted).assess(executionId, { p11: p11Of(action) });
      assert.deepEqual([pending.assessment.class, pending.assessment.sequence.status], ['signing-attempted', 'blocked']);
      restarted.ledger.advance(intent.lastLedgerSequence - restarted.ledger.validatedIndex);
      const proven = await coordinatorFor(restarted).assess(executionId, { p11: p11Of(action) });
      assert.deepEqual([proven.assessment.class, proven.assessment.ledger.via, proven.assessment.ledger.accountSequence], ['proven-not-included', 'owner-sequence', intent.sequence]);
      assert.deepEqual(await resolverFor(restarted).resolve(queryOf(action)), { outcome: 'resolved', certainty: 'confirmed-not-completed', failure: 'PROVIDER_REJECTED' });
      assert.equal((await restarted.interlock.readIntent(executionId))?.state, 'expired');
      // The restarted signer process counts from zero: its count is the new signatures; the original one was counted before the crash.
      assert.deepEqual(await counts(restarted, issuer2), { capabilities: 0, signatures: 0, submissions: 0, intents: 1, reservations: 0 }, 'nothing re-signed, nothing sent');
    } finally {
      await restarted.close();
    }
  });

  it('crash at the old reservation point (signed and verified, reserve never ran): before D-1 there was no Host record; now the window is held — and if the customer’s copy of the blob consumes the Sequence, the outcome stays uncertain, never closed', async () => {
    const w = await world();
    const issuer = testCapabilityIssuer();
    const rig = await executorRig({ ...w, issuer, create: crashingAt('reserve') });
    const { raw, action } = order(rig);
    const executionId = action.correlation.executionId;
    void rig.adapter.execute(action);
    for (let i = 0; i < 50 && rig.signer.signatures() === 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 50));
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(await counts(rig, issuer), { capabilities: 1, signatures: 1, submissions: 0, intents: 1, reservations: 0 });
    assert.equal(await rig.interlock.recorded(executionId), undefined);
    await rig.close();

    const restarted = await executorRig({ ...w, quarantine: true });
    try {
      restarted.book.attest(raw);
      restarted.ledger.autoAdvance = false;
      const intent = (await restarted.interlock.readIntent(executionId))!;
      assert.equal(intent.state, 'signing');
      // Out of band, the blob is included: the owner Sequence is consumed by a transaction Frontera never recorded.
      restarted.ledger.fund(intent.account, intent.sequence + 1);
      restarted.ledger.advance(intent.lastLedgerSequence - restarted.ledger.validatedIndex + 1);
      const report = await coordinatorFor(restarted).assess(executionId, { p11: p11Of(action) });
      assert.deepEqual([report.assessment.class, report.assessment.ledger.status], ['signing-attempted', 'sequence-consumed']);
      assert.ok(report.assessment.uncertainties.includes('sequence-consumed-by-unknown-transaction'));
      assert.deepEqual(await resolverFor(restarted).resolve(queryOf(action)), { outcome: 'unresolved' }, 'a consumed Sequence is never read as either outcome');
      assert.equal((await restarted.interlock.readIntent(executionId))?.state, 'signing');
      assert.equal(restarted.ledger.submitCalls.length, 0);
    } finally {
      await restarted.close();
    }
  });

  it('incomplete or unavailable validated ledger: the intent stays unresolved and its window held', async () => {
    const w = await world();
    const rig = await executorRig({ ...w, create: crashingAt('reserve') });
    const { action } = order(rig);
    void rig.adapter.execute(action);
    for (let i = 0; i < 50 && rig.signer.signatures() === 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 50));
    await new Promise((resolve) => setTimeout(resolve, 100));
    try {
      rig.ledger.autoAdvance = false;
      const intent = (await rig.interlock.readIntent(action.correlation.executionId))!;
      rig.ledger.advance(intent.lastLedgerSequence - rig.ledger.validatedIndex + 1);
      rig.ledger.faults.networkId = 2;
      assert.deepEqual(await resolverFor(rig).resolve(queryOf(action)), { outcome: 'unresolved' }, 'another network never proves anything');
      delete (rig.ledger.faults as { networkId?: number }).networkId;
      rig.ledger.faults.validatedAge = 600;
      assert.deepEqual(await resolverFor(rig).resolve(queryOf(action)), { outcome: 'unresolved' }, 'a stale validated ledger never proves anything');
      const report = await coordinatorFor(rig).assess(action.correlation.executionId, { p11: p11Of(action) });
      assert.deepEqual([report.assessment.class, report.assessment.certainty], ['signing-attempted', 'indeterminate']);
      assert.equal((await rig.interlock.readIntent(action.correlation.executionId))?.state, 'signing');
    } finally {
      await rig.close();
    }
  });
});

describe('TRADE-04D D-1 — uniqueness and contention', () => {
  const OWNER = testAccount();
  const DELEGATE = testAccount();
  let n = 0;
  const reservation = (overrides: Partial<TradeReservationInput> = {}): TradeReservationInput => {
    n += 1;
    return {
      executionId: `aoc.exec:d1-${n}`,
      account: OWNER,
      sequence: 40,
      lastLedgerSequence: 520,
      minLedger: 501,
      transactionHash: n.toString(16).toUpperCase().padStart(64, 'D'),
      evidence: { organizationId: ORG, subject: 's', requestId: `r-${n}`, decisionId: `d-${n}`, boundedGrantId: `g-${n}`, proposalDigest: `sha256:${'a'.repeat(64)}`, delegateAccount: DELEGATE, signerId: 'signer', signerRequestId: 'f'.repeat(64), signingPublicKey: `ED${'1'.repeat(64)}`, keyAuthority: 'master-key', preparedDigest: `sha256:${'b'.repeat(64)}`, delegationAssessmentDigest: `sha256:${'c'.repeat(64)}`, delegationFactsDigest: `sha256:${'d'.repeat(64)}`, referenceLedgerIndex: 500, referenceLedgerHash: 'E'.repeat(64), delegationLedgerIndex: 500, delegateRootLedgerIndex: 500, ownerRootLedgerIndex: 500, fee: '12', ledgerProvenance: 'injected-ledger-client' },
      ...overrides,
    };
  };
  async function open(path: string, witness: StartedWitness): Promise<DurableTradeSequenceInterlock> {
    return createSqliteTradeSequenceInterlock(path, { scope: { domainId: XRPL_TRADE_EXECUTOR_ID, networkId: 1 }, sequenceAccounts: [OWNER], now, freshness: { boundary: await boundaryFor(witness, ORG) } });
  }

  it('one intent per execution id, ever: a duplicate (any evidence) is execution-recorded; a reservation never runs without its signing intent, nor with a mismatched one', async () => {
    const witness = await startWitness();
    const store = await open(join(persistent(), 'i.sqlite'), witness);
    try {
      const first = reservation();
      assert.deepEqual(await store.recordIntent(intentFor(first), 500), { outcome: 'recorded' });
      assert.deepEqual(await store.recordIntent(intentFor({ ...first, sequence: 99 }), 500), { outcome: 'execution-recorded', intentState: 'intended' });
      await assert.rejects(store.reserve(first, 500), (error: { check?: string }) => error.check === 'intent-not-signing', 'an intent the signer was never contacted for cannot be reserved');
      await store.markSigning(first.executionId, testCapabilityId());
      await assert.rejects(store.markSigning(first.executionId, testCapabilityId()), (error: { check?: string }) => error.check === 'not-intended', 'the signing marker is set once');
      for (const [field, value] of [['sequence', 41], ['lastLedgerSequence', 519], ['account', testAccount()]] as const) {
        await assert.rejects(store.reserve({ ...first, [field]: value }, 500), field);
      }
      await assert.rejects(store.reserve({ ...first, evidence: { ...first.evidence, preparedDigest: `sha256:${'0'.repeat(64)}` } }, 500), (error: { check?: string }) => error.check === 'reservation-intent-evidence.preparedDigest');
      await assert.rejects(store.reserve({ ...first, evidence: { ...first.evidence, boundedGrantId: 'g-other' } }, 500), (error: { check?: string }) => error.check === 'reservation-intent-evidence.boundedGrantId');
      const orphan = reservation({ sequence: 60 });
      await assert.rejects(store.reserve(orphan, 500), (error: { check?: string }) => error.check === 'reservation-without-intent');
      assert.deepEqual(await store.reserve(first, 500), { outcome: 'reserved' });
      assert.deepEqual(await store.recordIntent(intentFor(first), 500), { outcome: 'execution-recorded', intentState: 'bound', transactionHash: first.transactionHash });
      assert.deepEqual(await store.verifyAll(), { records: 1, open: 1, intents: 1, openIntents: 0 });
    } finally {
      await store.close();
    }
  });

  it('same-owner Sequence contention: an open intent blocks a competing intent on that owner (same or lower Sequence) until the ledger closes the window; it is released early only by a qualified owner-Sequence proof for exactly its window', async () => {
    const witness = await startWitness();
    const store = await open(join(persistent(), 'i.sqlite'), witness);
    try {
      const a = reservation();
      assert.equal((await store.recordIntent(intentFor(a), 500)).outcome, 'recorded');
      assert.equal(await store.blocking({ account: OWNER, sequence: 40, validatedLedgerIndex: 500 }), true);
      assert.equal(await store.blocking({ account: OWNER, sequence: 41, validatedLedgerIndex: 500 }), false);
      assert.deepEqual(await store.recordIntent(intentFor(reservation()), 500), { outcome: 'blocked' });
      assert.equal(await store.blocking({ account: OWNER, sequence: 40, validatedLedgerIndex: 519 }), true, 'not at LastLedgerSequence - 1');
      assert.equal(await store.blocking({ account: OWNER, sequence: 40, validatedLedgerIndex: 520 }), false, 'the validated ledger reached LastLedgerSequence: the ledger fact, not elapsed time');
      // Release attempts that are not a qualified proof for exactly this window: refused, nothing changes.
      const window = { account: OWNER, sequence: 40, lastLedgerSequence: 520 };
      const forged = { status: 'not-included', proof: 'owner-sequence-unconsumed', window, ledgerIndex: 600, ledgerHash: 'B'.repeat(64), accountSequence: 40 } as const;
      const refusedRelease = (error: { check?: string }) => error.check === 'expiry-without-qualified-proof';
      await assert.rejects(store.expireIntent(a.executionId, forged), refusedRelease, 'a plain object asserting finality');
      await assert.rejects(store.expireIntent(a.executionId, undefined as never), refusedRelease, 'nothing but the execution id');
      const reader = (ledgerIndex: number, sequence: number, account = OWNER) => ({ ledgerEntry: async () => ({ outcome: 'read' as const, value: { ledgerIndex, ledgerHash: 'B'.repeat(64), entry: { state: 'present' as const, node: { LedgerEntryType: 'AccountRoot', Account: account, Sequence: sequence } } } }) });
      const otherWindow = await readTradeSequenceEvidence(reader(600, 41), { ...window, sequence: 41 });
      assert.equal(otherWindow.status, 'not-included');
      await assert.rejects(store.expireIntent(a.executionId, otherWindow), refusedRelease, 'a genuine proof for another Sequence');
      const otherOwner = testAccount();
      const otherOwnerProof = await readTradeSequenceEvidence(reader(600, 40, otherOwner), { ...window, account: otherOwner });
      await assert.rejects(store.expireIntent(a.executionId, otherOwnerProof), refusedRelease, 'a genuine proof for another owner');
      assert.equal((await readTradeSequenceEvidence(reader(519, 40), window)).status, 'unresolved', 'no proof before LastLedgerSequence');
      assert.equal((await readTradeSequenceEvidence(reader(600, 41), window)).status, 'sequence-consumed', 'no proof once the Sequence is consumed');
      assert.equal((await store.readIntent(a.executionId))?.state, 'intended');
      const proof = await readTradeSequenceEvidence(reader(600, 40), window);
      assert.equal(await store.expireIntent(a.executionId, proof), 'expired');
      assert.equal((await store.readIntent(a.executionId))?.transitions.at(-1)?.detail, `unconsumed.600.${'B'.repeat(64)}`, 'the release records the validated ledger it rests on');
      assert.equal(await store.expireIntent(a.executionId, proof), 'expired', 'idempotent');
      await assert.rejects(store.expireIntent('aoc.exec:never-recorded', proof), (error: { check?: string }) => error.check === 'no-intent');
    } finally {
      await store.close();
    }
  });

  it('many concurrent intents in one process, and two processes on one file and witness: exactly one intent per contested Sequence', async () => {
    const witness = await startWitness();
    const path = join(persistent(), 'i.sqlite');
    const store = await open(path, witness);
    const other = await open(path, witness);
    try {
      const local = await Promise.all(Array.from({ length: 8 }, () => store.recordIntent(intentFor(reservation({ sequence: 70 })), 500)));
      assert.equal(local.filter((outcome) => outcome.outcome === 'recorded').length, 1);
      const across = await Promise.allSettled([store.recordIntent(intentFor(reservation({ sequence: 80 })), 500), other.recordIntent(intentFor(reservation({ sequence: 80 })), 500)]);
      assert.equal(across.filter((result) => result.status === 'fulfilled' && result.value.outcome === 'recorded').length, 1, JSON.stringify(across.map((result) => (result.status === 'fulfilled' ? result.value : (result.reason as { code?: string }).code))));
      // A signing marker raced by forged releases from another connection: the forgeries never commit.
      const contested = reservation({ sequence: 90 });
      await store.recordIntent(intentFor(contested), 500);
      const forged = { status: 'not-included', proof: 'owner-sequence-unconsumed', window: { account: OWNER, sequence: 90, lastLedgerSequence: 520 }, ledgerIndex: 600, ledgerHash: 'B'.repeat(64), accountSequence: 90 } as const;
      const race = await Promise.allSettled([store.markSigning(contested.executionId, testCapabilityId()), other.expireIntent(contested.executionId, forged), other.expireIntent(contested.executionId, forged)]);
      assert.equal(race[0].status, 'fulfilled');
      assert.deepEqual(race.slice(1).map((result) => result.status), ['rejected', 'rejected']);
      assert.equal((await store.readIntent(contested.executionId))!.state, 'signing');
    } finally {
      await store.close();
      await other.close();
    }
  });
});

describe('TRADE-04D D-1 — CORE-07 rollback and stale restores', () => {
  function restore(backup: string, path: string): void {
    for (const suffix of ['-wal', '-shm']) if (existsSync(`${path}${suffix}`)) rmSync(`${path}${suffix}`);
    copyFileSync(backup, path);
  }
  const owner = testAccount();
  const record = (sequence: number): TradeReservationInput => ({
    executionId: `aoc.exec:d1-rollback-${sequence}`,
    account: owner,
    sequence,
    lastLedgerSequence: 520,
    minLedger: 501,
    transactionHash: sequence.toString(16).toUpperCase().padStart(64, 'C'),
    evidence: { organizationId: ORG, subject: 's', requestId: 'r', decisionId: 'd', boundedGrantId: 'g', proposalDigest: `sha256:${'a'.repeat(64)}`, delegateAccount: testAccount(), signerId: 'signer', signerRequestId: 'f'.repeat(64), signingPublicKey: `ED${'1'.repeat(64)}`, keyAuthority: 'master-key', preparedDigest: `sha256:${'b'.repeat(64)}`, delegationAssessmentDigest: `sha256:${'c'.repeat(64)}`, delegationFactsDigest: `sha256:${'d'.repeat(64)}`, referenceLedgerIndex: 500, referenceLedgerHash: 'E'.repeat(64), delegationLedgerIndex: 500, delegateRootLedgerIndex: 500, ownerRootLedgerIndex: 500, fee: '12', ledgerProvenance: 'injected-ledger-client' },
  });
  const open = async (path: string, witness: StartedWitness) => createSqliteTradeSequenceInterlock(path, { scope: { domainId: XRPL_TRADE_EXECUTOR_ID, networkId: 1 }, sequenceAccounts: [owner], now, freshness: { boundary: await boundaryFor(witness, ORG) } });
  const refusedAsRollback = (error: { code?: string; message?: string }) => /ROLLBACK|REGRESSED|PENDING|FORK/.test(`${error.code} ${error.message}`);

  it('a stale backup that predates an intent, or that loses the signing marker, is refused at open — it would release a window or hide a signer contact', async () => {
    const witness = await startWitness();
    const path = join(persistent(), 'i.sqlite');
    const store = await open(path, witness);
    const r = record(40);
    await store.recordIntent(intentFor(r), 500);
    await store.close();
    copyFileSync(path, `${path}.intended`);
    const again = await open(path, witness);
    await again.markSigning(r.executionId, testCapabilityId());
    await again.close();
    restore(`${path}.intended`, path);
    await assert.rejects(open(path, witness), refusedAsRollback, 'the signing marker is anchored: a copy without it is stale');

    const path2 = join(persistent(), 'j.sqlite');
    const witness2 = await startWitness();
    const s2 = await open(path2, witness2);
    await s2.close();
    copyFileSync(path2, `${path2}.empty`);
    const s3 = await open(path2, witness2);
    await s3.recordIntent(intentFor(record(41)), 500);
    await s3.close();
    restore(`${path2}.empty`, path2);
    await assert.rejects(open(path2, witness2), refusedAsRollback, 'the intent is anchored: a copy without it is stale');
  });

  it('a lost reservation after the intent (restore between sign and reserve) is refused; the restored-forward file reopens with every record', async () => {
    const witness = await startWitness();
    const path = join(persistent(), 'i.sqlite');
    const store = await open(path, witness);
    const r = record(42);
    await intendAndSign(store, r, 500);
    await store.close();
    copyFileSync(path, `${path}.signing`);
    const again = await open(path, witness);
    await again.reserve(r, 500);
    await again.close();
    copyFileSync(path, `${path}.latest`);
    restore(`${path}.signing`, path);
    await assert.rejects(open(path, witness), refusedAsRollback);
    restore(`${path}.latest`, path);
    const reopened = await open(path, witness);
    assert.deepEqual(await reopened.verifyAll(), { records: 1, open: 1, intents: 1, openIntents: 0 });
    await reopened.close();
  });
});

describe('TRADE-04D D-1 — the v1 → v2 migration', () => {
  const owner = testAccount();
  const delegate = testAccount();
  const scope = { domainId: XRPL_TRADE_EXECUTOR_ID, networkId: 1 };
  const legacy = (n: number): TradeReservationInput => ({
    executionId: `aoc.exec:legacy-${n}`,
    account: owner,
    sequence: 30 + n,
    lastLedgerSequence: 520,
    minLedger: 501,
    transactionHash: n.toString(16).toUpperCase().padStart(64, 'F'),
    evidence: { organizationId: ORG, subject: 's', requestId: `r${n}`, decisionId: `d${n}`, boundedGrantId: `g${n}`, proposalDigest: `sha256:${'a'.repeat(64)}`, delegateAccount: delegate, signerId: 'signer', signerRequestId: 'f'.repeat(64), signingPublicKey: `ED${'1'.repeat(64)}`, keyAuthority: 'master-key', preparedDigest: `sha256:${'b'.repeat(64)}`, delegationAssessmentDigest: `sha256:${'c'.repeat(64)}`, delegationFactsDigest: `sha256:${'d'.repeat(64)}`, referenceLedgerIndex: 500, referenceLedgerHash: 'E'.repeat(64), delegationLedgerIndex: 500, delegateRootLedgerIndex: 500, ownerRootLedgerIndex: 500, fee: '12', ledgerProvenance: 'injected-ledger-client' },
  });
  const claimOf = (r: TradeReservationInput) => ({ executionId: r.executionId, networkId: 1, transactionHash: r.transactionHash, transactionType: 'OfferCreate', account: r.account, sequence: r.sequence, lastLedgerSequence: r.lastLedgerSequence });
  const openV2 = async (path: string, witness: StartedWitness) => createSqliteTradeSequenceInterlock(path, { scope, sequenceAccounts: [owner], now, freshness: { boundary: await boundaryFor(witness, ORG) } });
  const events = (path: string, table: string) => {
    const db = new Database(path, { readonly: true });
    try {
      return db.prepare(`SELECT row_id, kind, execution_id, event_digest FROM ${table} ORDER BY row_id`).all();
    } finally {
      db.close();
    }
  };
  const latestVersion = (path: string) => {
    const db = new Database(path, { readonly: true });
    try {
      return (db.prepare('SELECT schema_version FROM trade_interlock_store_versions ORDER BY id DESC LIMIT 1').get() as { schema_version: string }).schema_version;
    } finally {
      db.close();
    }
  };

  /** A genuine TRADE-04C v1 file: two legacy reservations (one claimed, one open), anchored at the witness. */
  async function v1File() {
    const witness = await startWitness();
    const path = join(persistent(), 'trade-interlock.sqlite');
    const v1 = await createV1TradeSequenceInterlockForMigrationTests(path, { scope, sequenceAccounts: [owner], now, freshness: { boundary: await boundaryFor(witness, ORG) } });
    const [a, b] = [legacy(1), legacy(2)];
    await v1.reserve(a, 500);
    await v1.claimSubmission(claimOf(a));
    await v1.reserve(b, 500);
    await v1.close();
    return { witness, path, a, b };
  }

  it('verification tooling opens an unmigrated v1 file read-only and never migrates it', async () => {
    const { path } = await v1File();
    const before = events(path, 'trade_anchored_events');
    const verifier = await createSqliteTradeSequenceInterlock(path, { now });
    assert.equal(verifier.schemaVersion, TRADE_INTERLOCK_STORE_SCHEMA_VERSION_V1);
    assert.deepEqual(await verifier.verifyAll(), { records: 2, open: 2, intents: 0, openIntents: 0 });
    await assert.rejects(verifier.recordIntent(intentFor(legacy(9)), 500));
    await verifier.close();
    assert.equal(latestVersion(path), TRADE_INTERLOCK_STORE_SCHEMA_VERSION_V1);
    assert.deepEqual(events(path, 'trade_anchored_events'), before);
    assert.deepEqual([...TRADE_INTERLOCK_SUPPORTED_SCHEMA_VERSIONS], [TRADE_INTERLOCK_STORE_SCHEMA_VERSION_V1, TRADE_INTERLOCK_STORE_SCHEMA_VERSION], 'backup and restore accept both');
  });

  it('the Host open migrates a fresh v1 file once, after full verification and CORE-07 establishment: the witnessed head is unchanged, every legacy record, claim and digest is preserved, and the v1 history is frozen', async () => {
    const { witness, path, a, b } = await v1File();
    const v1Events = events(path, 'trade_anchored_events');
    const store = await openV2(path, witness);
    try {
      assert.equal(store.schemaVersion, TRADE_INTERLOCK_STORE_SCHEMA_VERSION);
      const migration = store.migration()!;
      assert.deepEqual([migration.fromVersion, migration.toVersion, migration.legacyReservationCeiling, migration.legacyEventCeiling, migration.historySequence], [TRADE_INTERLOCK_STORE_SCHEMA_VERSION_V1, TRADE_INTERLOCK_STORE_SCHEMA_VERSION, 2, 3, 3]);
      assert.deepEqual(await store.verifyAll(), { records: 2, open: 2, intents: 0, openIntents: 0 });
      assert.deepEqual([(await store.read(a.executionId))?.state, (await store.read(a.executionId))?.submissionAttempts, (await store.read(b.executionId))?.state], ['submitting', 1, 'reserved']);
      // The open legacy reservation still blocks and is still claimed only through its own record (the submit site), now anchored in the v2 table.
      assert.equal(await store.blocking({ account: owner, sequence: b.sequence, validatedLedgerIndex: 500 }), true);
      assert.deepEqual(await store.recordIntent(intentFor(legacy(3), { sequence: b.sequence }), 500), { outcome: 'blocked' }, 'legacy windows hold under v2');
      await store.claimSubmission(claimOf(b));
      // New executions need an intent.
      const fresh = legacy(4);
      await assert.rejects(store.reserve({ ...fresh, sequence: 90 }, 500), (error: { check?: string }) => error.check === 'reservation-without-intent');
      assert.deepEqual(await reserveWithIntent(store, { ...fresh, sequence: 90 }, 500), { outcome: 'reserved' });
    } finally {
      await store.close();
    }
    assert.deepEqual(events(path, 'trade_anchored_events'), v1Events, 'the v1 rows are untouched');
    const db = new Database(path);
    try {
      assert.throws(() => db.prepare(`INSERT INTO trade_anchored_events (kind, execution_id, event_digest) VALUES ('reserve', 'x', 'y')`).run(), /frozen/);
      const v2 = db.prepare('SELECT MIN(row_id) AS low FROM trade_anchored_events_v2').get() as { low: number };
      assert.ok(v2.low > 3, 'v2 row ids continue after the last v1 row');
    } finally {
      db.close();
    }
    const reopened = await openV2(path, witness);
    assert.deepEqual(await reopened.verifyAll(), { records: 3, open: 3, intents: 1, openIntents: 0 });
    assert.equal(reopened.migration()?.legacyReservationCeiling, 2, 'migrated once');
    await reopened.close();
  });

  it('a stale v1 copy is refused by CORE-07 and left unmigrated; a partially migrated or mixed file is refused unmutated', async () => {
    const { witness, path, b } = await v1File();
    copyFileSync(path, `${path}.stale`);
    const store = await openV2(path, witness);
    await store.claimSubmission(claimOf(b));
    await store.close();
    const stale = join(persistent(), 'trade-interlock.sqlite');
    copyFileSync(`${path}.stale`, stale);
    await assert.rejects(openV2(stale, witness), (error: { code?: string; message?: string }) => /ROLLBACK|REGRESSED|FORK/.test(`${error.code} ${error.message}`));
    assert.equal(latestVersion(stale), TRADE_INTERLOCK_STORE_SCHEMA_VERSION_V1, 'never upgraded before it was proven fresh');

    for (const [label, sql] of [
      ['v2 recorded, intent table missing', 'DROP TABLE trade_intents;'],
      ['v2 recorded, history view missing', 'DROP VIEW trade_anchored_history;'],
      ['v2 recorded, v2 events missing', 'DROP TABLE trade_anchored_events_v2;'],
    ] as const) {
      const copy = join(persistent(), 'trade-interlock.sqlite');
      copyFileSync(path, copy);
      const db = new Database(copy);
      db.exec(sql);
      db.close();
      await assert.rejects(createSqliteTradeSequenceInterlock(copy, { now }), /partially migrated or damaged/, label);
    }
    const mixed = join(persistent(), 'trade-interlock.sqlite');
    copyFileSync(`${path}.stale`, mixed);
    const db = new Database(mixed);
    db.exec('CREATE TABLE trade_intents (x INTEGER);');
    db.close();
    await assert.rejects(createSqliteTradeSequenceInterlock(mixed, { now }), /partially migrated/);
    const forgedVersion = join(persistent(), 'trade-interlock.sqlite');
    copyFileSync(`${path}.stale`, forgedVersion);
    const db2 = new Database(forgedVersion);
    db2.prepare(`INSERT INTO trade_interlock_store_versions (schema_version, migration_state, recorded_at) VALUES (?, 'current', ?)`).run(TRADE_INTERLOCK_STORE_SCHEMA_VERSION, now());
    db2.close();
    await assert.rejects(createSqliteTradeSequenceInterlock(forgedVersion, { now }), /partially migrated or damaged/, 'a v2 version row on v1 tables');
  });

  it('a tampered migration record or a legacy reservation forged after the migration is refused', async () => {
    const { witness, path } = await v1File();
    (await openV2(path, witness)).close();
    for (const sql of [
      'DROP TRIGGER trade_interlock_migrations_immutable; UPDATE trade_interlock_migrations SET legacy_reservation_ceiling = 99;',
      'DROP TRIGGER trade_interlock_migrations_no_delete; DELETE FROM trade_interlock_migrations;',
    ]) {
      const copy = join(persistent(), 'trade-interlock.sqlite');
      copyFileSync(path, copy);
      const db = new Database(copy);
      db.exec(sql);
      db.close();
      await assert.rejects(createSqliteTradeSequenceInterlock(copy, { now }), (error: { code?: string }) => error.code === 'TRADE_INTERLOCK_CORRUPT', sql);
    }
  });
});

describe('TRADE-04D D-1 — the owner-Sequence parser equals TRADE-02’s', () => {
  it('readTradeOwnerSequence answers exactly what readXrplOwnerSequence answers, on valid and hostile nodes', () => {
    const owner = testAccount();
    const nodes: unknown[] = [
      { LedgerEntryType: 'AccountRoot', Account: owner, Sequence: 7 },
      { LedgerEntryType: 'AccountRoot', Account: owner, Sequence: 0xffff_ffff },
      { LedgerEntryType: 'AccountRoot', Account: owner, Sequence: 0x1_0000_0000 },
      { LedgerEntryType: 'AccountRoot', Account: owner, Sequence: 0 },
      { LedgerEntryType: 'AccountRoot', Account: owner, Sequence: -1 },
      { LedgerEntryType: 'AccountRoot', Account: owner, Sequence: 1.5 },
      { LedgerEntryType: 'AccountRoot', Account: owner, Sequence: '7' },
      { LedgerEntryType: 'AccountRoot', Account: testAccount(), Sequence: 7 },
      { LedgerEntryType: 'Offer', Account: owner, Sequence: 7 },
      { LedgerEntryType: 'AccountRoot', Account: owner },
      null,
      undefined,
      [],
      'AccountRoot',
      Object.create({ LedgerEntryType: 'AccountRoot', Account: owner, Sequence: 7 }),
    ];
    for (const node of nodes) assert.equal(readTradeOwnerSequence(node, owner), readXrplOwnerSequence(node, owner), JSON.stringify(node));
  });
});

describe('TRADE-04D D-1 — release authority (structural)', () => {
  it('there is no abandonment anywhere; only the P12 trade authority calls expireIntent, and only with a proof readTradeSequenceEvidence produced', async () => {
    const { readFileSync } = await import('node:fs');
    const edge = 'src/enterprise/xrpl-trade-execution';
    const files = ['host-composition.ts', 'sqlite-trade-sequence-interlock.ts', 'trade-offer-executor.ts', 'trade-recovery-assessment.ts', 'trade-recovery-coordinator.ts', 'trade-resolution-authority.ts', 'trade-sequence-evidence.ts'];
    for (const file of files) assert.equal(/abandon(?:Intent|ed')/.test(readFileSync(`${edge}/${file}`, 'utf8')), false, file);
    const callers = files.filter((file) => /\.expireIntent!?\(/.test(readFileSync(`${edge}/${file}`, 'utf8')));
    assert.deepEqual(callers, ['trade-resolution-authority.ts']);
    const authority = readFileSync(`${edge}/trade-resolution-authority.ts`, 'utf8');
    assert.match(authority, /const evidence = await readTradeSequenceEvidence\(reader, intent\);[\s\S]*?interlock\.expireIntent!\(intent\.executionId, evidence\)/);
    assert.match(readFileSync(`${edge}/sqlite-trade-sequence-interlock.ts`, 'utf8'), /if \(!isQualifiedTradeSequenceProof\(proof, intent\) \|\| proof\.status !== 'not-included'\) throw intentRefused\('expiry-without-qualified-proof'\);/);
    assert.equal(/expireIntent/.test(readFileSync(`${edge}/trade-offer-executor.ts`, 'utf8')), false, 'the executor cannot release');
  });
});
