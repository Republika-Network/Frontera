import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { ExecutionAdapterResult, ValidatedExecutionAction } from '../../features/execution-runtime/index.js';
import {
  createTradeOfferExecutionAdapter,
  createTradeRecoveryCoordinator,
  createTradeResolutionAuthority,
  readOnlyTradeLedger,
  readOnlyTradeRecoveryLedger,
  type TradeIntentRecord,
  type TradeRecoveryP11View,
} from '../xrpl-trade-execution/index.js';
import { recordedTradeSequenceExpiry } from '../xrpl-trade-execution/trade-sequence-evidence.js';
import type { DelegatedOfferSigningPort } from '../xrpl-trade-rail/index.js';
import { initializeReferenceCapabilityLedger } from '../xrpl-trade-rail/reference/reference-delegated-offer-signer.js';
import { ORG as HOST_ORG } from './core04-host-fixture.js';
import { closeAllWitnesses, closeDeploymentWitnesses, startWitness } from './core07-freshness-fixture.js';
import { ACTION, FakeXrplLedger, NETWORK_ID, ORG, executorRig, pairWorld, rawProposal, scratch, validatedAction, type ExecutorRig } from './trade04c-execution-fixture.js';
import { Workspace, admit, bootTradeHost, post, proposalFor } from './trade04c-host-fixture.js';
import { testCapabilityIssuer } from './trade04c-s1-capability-fixture.js';
import { intentRecordFor, validatedEntryReader } from './trade04d-intent-fixture.js';

/**
 * TRADE-04D post-merge hardening — the two findings left open on PR #192.
 *
 * **P1.** The Host composes the P12 resolver and the recovery coordinator
 * over their own ledger client, which nothing connected: only a transaction
 * lookup (an execution with a reservation) called `connect()`. A real XRPL
 * client refuses a request before `connect()`, so the owner-Sequence read for
 * an intent-only execution — exactly the H-1 outcome — stayed `unresolved`
 * until some other read happened to connect the shared client. Here every
 * fake client refuses reads until **it** connected (`strictConnections`).
 *
 * **P2.** An `expired` intent records a qualified owner-Sequence proof. Its
 * released `Sequence` is then the owner's next one, and a later order may
 * consume it. The assessment read that as a contradiction of the expiry, and
 * P12 — asked again after a restart between the expiry and P12's record —
 * re-read the ledger and answered `unresolved` forever. The recorded proof is
 * the evidence; a consumption at or before the proof's ledger is still a
 * contradiction, and an open intent is still never closed on a consumed
 * `Sequence`.
 *
 * Every case counts the effects no answer may add: capabilities issued,
 * signatures, submissions. Offline: the labelled fake ledger, the real
 * executor, the real CORE-07-anchored interlock and witness, the real
 * reference signer.
 */

const spaces: { cleanup(): void }[] = [];
const workspace = new Workspace();
after(async () => {
  await closeAllWitnesses();
  for (const space of spaces.splice(0)) space.cleanup();
  workspace.cleanup();
  await closeDeploymentWitnesses();
});
const persistent = (): string => {
  const space = scratch();
  spaces.push(space);
  return space.dir;
};

function order(rig: ExecutorRig): { readonly raw: Record<string, unknown>; readonly action: ValidatedExecutionAction } {
  const raw = rawProposal(rig.pairs[0]!);
  rig.book.attest(raw);
  return { raw, action: validatedAction(raw) };
}

const effects = (rig: ExecutorRig, issuer: { readonly issued: readonly unknown[] }) => ({ capabilities: issuer.issued.length, signatures: rig.signer.signatures(), submissions: rig.ledger.submitCalls.length });
const withSigner = (wrap: (port: DelegatedOfferSigningPort) => DelegatedOfferSigningPort): typeof createTradeOfferExecutionAdapter => (options) => createTradeOfferExecutionAdapter({ ...options, signer: wrap(options.signer) });
/** The delegated signer signs, and its answer is lost: H-1 — `unconfirmed`, an intent `signing`, no reservation, no hash. */
const responseLost = withSigner((port) => ({ signDelegatedOffer: async (request) => { await port.signDelegatedOffer(request); throw new Error('lost'); } }));

function resolverFor(rig: ExecutorRig) {
  const reads = readOnlyTradeRecoveryLedger(rig.ledger.client(NETWORK_ID, rig.interlock));
  return createTradeResolutionAuthority({ networkId: NETWORK_ID, action: ACTION, requestTimeoutMs: 1_000, ledger: readOnlyTradeLedger(rig.ledger.client(NETWORK_ID, rig.interlock)), interlock: rig.interlock, entries: validatedEntryReader(reads, NETWORK_ID) });
}
function coordinatorFor(rig: ExecutorRig, client = rig.ledger.client(NETWORK_ID, rig.interlock)) {
  return createTradeRecoveryCoordinator({
    networkId: NETWORK_ID,
    requestTimeoutMs: 1_000,
    maxValidatedLedgerAgeSeconds: 10,
    ledger: readOnlyTradeRecoveryLedger(client),
    interlock: { read: (executionId: string) => rig.interlock.read(executionId), readIntent: (executionId: string) => rig.interlock.readIntent(executionId), health: () => rig.interlock.health() },
  });
}
const queryOf = (action: ValidatedExecutionAction) => ({ organizationId: ORG, executionId: action.correlation.executionId, evaluationId: 'eval-p1p2', requestId: action.correlation.requestId, decisionId: action.correlation.decisionId, boundedGrantId: action.boundedGrantId, action: ACTION, basis: 'initial-observation-unconfirmed' as const });
/** What the governed path records in P11 for the adapter's (unconfirmed) answer. */
function p11Of(action: ValidatedExecutionAction, result: ExecutionAdapterResult): TradeRecoveryP11View {
  const attempt = { organizationId: ORG, executionId: action.correlation.executionId, requestId: action.correlation.requestId, decisionId: action.correlation.decisionId, boundedGrantId: action.boundedGrantId, action: action.action };
  return { record: { attempt, terminal: { observation: { kind: 'provider', certainty: result.outcome === 'unconfirmed' ? 'unconfirmed' : 'confirmed-not-completed' } } } };
}
const NOT_COMPLETED = { outcome: 'resolved', certainty: 'confirmed-not-completed', failure: 'PROVIDER_REJECTED' };
const UNRESOLVED = { outcome: 'unresolved' };

/** An H-1 intent-only execution, the ledger held still: the adapter's answer and the intent it left `signing`. */
async function uncertain(rig: ExecutorRig): Promise<{ readonly raw: Record<string, unknown>; readonly action: ValidatedExecutionAction; readonly result: ExecutionAdapterResult; readonly intent: TradeIntentRecord }> {
  rig.ledger.autoAdvance = false;
  const { raw, action } = order(rig);
  const result = await rig.adapter.execute(action);
  assert.equal(result.outcome, 'unconfirmed');
  const intent = (await rig.interlock.readIntent(action.correlation.executionId))!;
  assert.equal(intent.state, 'signing');
  assert.ok(rig.ledger.validatedIndex < intent.lastLedgerSequence, 'the fixture starts inside the window');
  return { raw, action, result, intent };
}
const pastWindow = (rig: ExecutorRig, intent: TradeIntentRecord): void => {
  if (rig.ledger.validatedIndex < intent.lastLedgerSequence) rig.ledger.advance(intent.lastLedgerSequence - rig.ledger.validatedIndex);
};

describe('TRADE-04D P1 — the resolver-side reads connect their own client', () => {
  it('on the shipped Host, every client refusing reads until it connected: an H-1 intent-only execution stays unresolved while the ledger cannot be reached, then P12 closes it on the owner-Sequence proof — once', async () => {
    const ledger = new FakeXrplLedger();
    ledger.strictConnections = true;
    const trade = await bootTradeHost(workspace, { ledger });
    try {
      trade.signer.forge = () => ({});
      const before = { signatures: trade.signer.signatures(), sends: trade.ledger.submitCalls.length };
      const reply = await post(trade, await admit(trade, proposalFor(trade, '40')));
      assert.equal(reply.body['status'], 'execution_unconfirmed', reply.text);
      const executionId = reply.body['executionId'] as string;
      trade.signer.forge = undefined;
      const reconcile = () => trade.host.enterprise.executionReconciliation!.reconcile({ organizationId: HOST_ORG, executionId }) as Promise<{ readonly outcome: string; readonly established?: string }>;

      // Past LastLedgerSequence (offset 20), but the resolver cannot open its connection: never evidence.
      trade.ledger.advance(30);
      trade.ledger.faults.connectThrows = true;
      assert.equal((await reconcile()).outcome, 'unresolved', 'a ledger that cannot be reached proves nothing');
      trade.ledger.faults.connectThrows = false;

      // Nothing else connected the resolver's client (no reservation lookup ran; the executor's client is its own).
      const resolved = await reconcile();
      assert.deepEqual([resolved.outcome, resolved.established], ['resolved', 'now'], JSON.stringify(resolved));
      const replay = await reconcile();
      assert.deepEqual([replay.outcome, replay.established], ['resolved', 'previously'], 'recorded once; the authority is not asked again');
      assert.deepEqual({ signatures: trade.signer.signatures(), sends: trade.ledger.submitCalls.length }, before, 'nothing signed by the reference service, nothing sent');
    } finally {
      await trade.signer.close();
    }
  });

  it('the recovery coordinator, over a client nothing else connected: a failed connect is ledger-unavailable (the window stays held); connected, the intent is proven not included — one connection, reused', async () => {
    const ledger = new FakeXrplLedger();
    ledger.strictConnections = true;
    const issuer = testCapabilityIssuer();
    const rig = await executorRig({ ledger, issuer, create: responseLost });
    try {
      const { action, result, intent } = await uncertain(rig);
      const executionId = action.correlation.executionId;
      pastWindow(rig, intent);
      const coordinator = coordinatorFor(rig, rig.ledger.client(NETWORK_ID, rig.interlock));

      rig.ledger.faults.connectThrows = true;
      const down = await coordinator.assess(executionId, { p11: p11Of(action, result) });
      assert.deepEqual([down.assessment.class, down.assessment.certainty, down.assessment.ledger.status, down.assessment.sequence.status], ['signing-attempted', 'indeterminate', 'unresolved', 'unknown'], JSON.stringify(down.assessment));
      assert.ok(down.assessment.uncertainties.includes('ledger-evidence-unavailable'));
      rig.ledger.faults.connectThrows = false;

      const opened = rig.ledger.connectionsOpened;
      for (let pass = 0; pass < 2; pass += 1) {
        const proven = await coordinator.assess(executionId, { p11: p11Of(action, result) });
        assert.deepEqual([proven.assessment.class, proven.assessment.certainty, proven.assessment.ledger.via], ['proven-not-included', 'proven', 'owner-sequence'], JSON.stringify(proven.assessment));
        assert.deepEqual(proven.assessment.inconsistencies, []);
      }
      assert.equal(rig.ledger.connectionsOpened - opened, 1, 'the coordinator opened its own connection once and reused it');
      assert.equal((await rig.interlock.readIntent(executionId))?.state, 'signing', 'an assessment releases nothing');
      assert.deepEqual(effects(rig, issuer), { capabilities: 1, signatures: 1, submissions: 0 });
    } finally {
      await rig.close();
    }
  });

  it('structure: both validated-read ports connect before server_info, which every validated read asks first', () => {
    const codeOf = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
    const composition = codeOf(readFileSync('src/enterprise/xrpl-trade-execution/host-composition.ts', 'utf8'));
    assert.match(composition, /const ownerSequenceReader = createXrplValidatedLedgerReader\(\{\s*port: Object\.freeze\(\{\s*serverInfo: async \(\) => \{\s*await resolverReads\.connect\(\);\s*return resolverReads\.serverInfo\(\);\s*\},/);
    const coordinator = codeOf(readFileSync('src/enterprise/xrpl-trade-execution/trade-recovery-coordinator.ts', 'utf8'));
    assert.match(coordinator, /createXrplValidatedLedgerReader\(\{\s*port: Object\.freeze\(\{\s*serverInfo: async \(\) => \{\s*await ledger\.connect\(\);\s*return ledger\.serverInfo\(\);\s*\},/);
    const reader = codeOf(readFileSync('src/features/xrpl-transport/xrpl-validated-ledger-reader.ts', 'utf8'));
    for (const read of ['async function ledgerHeader(', 'async function ledgerEntry(']) {
      const body = reader.slice(reader.indexOf(read));
      assert.ok(body.indexOf('await currentValidatedLedger()') !== -1 && body.indexOf('await currentValidatedLedger()') < body.indexOf('await ask(() => port.'), `${read} asks server_info first`);
    }
  });
});

describe('TRADE-04D P2 — an expired intent answers from its recorded proof', () => {
  it('a later order consumes the released Sequence: P12 still answers confirmed-not-completed (replays alike) and the assessment stays proven-not-included, with no contradiction', async () => {
    const issuer = testCapabilityIssuer();
    const rig = await executorRig({ issuer, create: responseLost });
    try {
      const { action, result, intent } = await uncertain(rig);
      const executionId = action.correlation.executionId;
      pastWindow(rig, intent);
      assert.deepEqual(await resolverFor(rig).resolve(queryOf(action)), NOT_COMPLETED);
      const expired = (await rig.interlock.readIntent(executionId))!;
      const recorded = recordedTradeSequenceExpiry(expired);
      assert.ok(recorded !== undefined && recorded.ledgerIndex >= intent.lastLedgerSequence, JSON.stringify(expired.transitions));
      assert.equal(await rig.interlock.blocking({ account: intent.account, sequence: intent.sequence, validatedLedgerIndex: rig.ledger.validatedIndex }), false, 'the Sequence was released by the ledger fact');

      // The owner's next transaction takes that Sequence, after the proof's ledger.
      rig.ledger.fund(intent.account, intent.sequence + 1);
      rig.ledger.advance(1);
      for (let pass = 0; pass < 2; pass += 1) assert.deepEqual(await resolverFor(rig).resolve(queryOf(action)), NOT_COMPLETED, 'asked again, the same answer');
      const report = await coordinatorFor(rig).assess(executionId, { p11: p11Of(action, result) });
      assert.deepEqual([report.assessment.class, report.assessment.certainty, report.assessment.ledger.status, report.assessment.sequence.status], ['proven-not-included', 'proven', 'sequence-consumed', 'released-by-ledger-fact'], JSON.stringify(report.assessment));
      assert.deepEqual(report.assessment.inconsistencies, []);
      assert.equal(report.assessment.uncertainties.includes('sequence-consumed-by-unknown-transaction'), false);
      assert.equal((await rig.interlock.readIntent(executionId))?.state, 'expired');
      assert.deepEqual(effects(rig, issuer), { capabilities: 1, signatures: 1, submissions: 0 });
    } finally {
      await rig.close();
    }
  });

  it('restart after the proven expiry, before P12 recorded its answer, with the Sequence since reused: asked again, P12 answers from the record — no capability, signature or submission added', async () => {
    const dir = persistent();
    const signerLedgerPath = join(persistent(), 'signer-ledger.sqlite');
    await initializeReferenceCapabilityLedger(signerLedgerPath);
    const ledger = new FakeXrplLedger();
    const witness = await startWitness();
    const world = { dir, witness, ledger, pairs: [pairWorld(ledger)], signerLedgerPath };

    const issuer = testCapabilityIssuer();
    const rig = await executorRig({ ...world, issuer, create: responseLost });
    const { action, intent } = await uncertain(rig);
    const executionId = action.correlation.executionId;
    pastWindow(rig, intent);
    // The authority expires the intent; the process stops before P12 records the answer.
    assert.deepEqual(await resolverFor(rig).resolve(queryOf(action)), NOT_COMPLETED);
    await rig.close();
    ledger.fund(intent.account, intent.sequence + 1);
    ledger.advance(1);

    const issuer2 = testCapabilityIssuer();
    const restarted = await executorRig({ ...world, issuer: issuer2 });
    try {
      assert.equal((await restarted.interlock.readIntent(executionId))?.state, 'expired', 'the expiry survived the restart');
      for (let pass = 0; pass < 2; pass += 1) assert.deepEqual(await resolverFor(restarted).resolve(queryOf(action)), NOT_COMPLETED);
      assert.deepEqual(effects(restarted, issuer2), { capabilities: 0, signatures: 0, submissions: 0 });
    } finally {
      await restarted.close();
    }
  });

  it('a Sequence consumed inside the window (possibly by this intent’s own transaction) is never an expiry: unresolved past LastLedgerSequence, the intent stays signing', async () => {
    const issuer = testCapabilityIssuer();
    const rig = await executorRig({ issuer, create: responseLost });
    try {
      const { action, result, intent } = await uncertain(rig);
      const executionId = action.correlation.executionId;
      rig.ledger.fund(intent.account, intent.sequence + 1);
      pastWindow(rig, intent);
      rig.ledger.advance(1);
      assert.deepEqual(await resolverFor(rig).resolve(queryOf(action)), UNRESOLVED);
      assert.equal((await rig.interlock.readIntent(executionId))?.state, 'signing', 'never released on a guess');
      const report = await coordinatorFor(rig).assess(executionId, { p11: p11Of(action, result) });
      assert.deepEqual([report.assessment.class, report.assessment.inconsistencies], ['signing-attempted', []], JSON.stringify(report.assessment));
      assert.ok(report.assessment.uncertainties.includes('sequence-consumed-by-unknown-transaction'));
      assert.deepEqual(effects(rig, issuer), { capabilities: 1, signatures: 1, submissions: 0 });
    } finally {
      await rig.close();
    }
  });

  it('an unreadable owner Sequence: an open intent stays unresolved; once expired, P12 answers from the record and the assessment reports the unavailable read without a contradiction', async () => {
    const issuer = testCapabilityIssuer();
    const rig = await executorRig({ issuer, create: responseLost });
    try {
      const { action, result, intent } = await uncertain(rig);
      const executionId = action.correlation.executionId;
      pastWindow(rig, intent);
      rig.ledger.faults.malformedSequence = true;
      assert.deepEqual(await resolverFor(rig).resolve(queryOf(action)), UNRESOLVED);
      assert.equal((await rig.interlock.readIntent(executionId))?.state, 'signing');
      rig.ledger.faults.malformedSequence = false;
      assert.deepEqual(await resolverFor(rig).resolve(queryOf(action)), NOT_COMPLETED);

      rig.ledger.faults.malformedSequence = true;
      assert.deepEqual(await resolverFor(rig).resolve(queryOf(action)), NOT_COMPLETED, 'the recorded proof does not depend on a fresh read');
      const report = await coordinatorFor(rig).assess(executionId, { p11: p11Of(action, result) });
      assert.deepEqual([report.assessment.class, report.assessment.inconsistencies], ['proven-not-included', []], JSON.stringify(report.assessment));
      assert.ok(report.assessment.uncertainties.includes('ledger-evidence-unavailable'));
      rig.ledger.faults.malformedSequence = false;
    } finally {
      await rig.close();
    }
  });

  it('a consumption at or before the recorded proof’s ledger still contradicts the expiry: inconsistent-evidence, never silently accepted', async () => {
    const issuer = testCapabilityIssuer();
    const rig = await executorRig({ issuer, create: responseLost });
    try {
      const { action, result, intent } = await uncertain(rig);
      const executionId = action.correlation.executionId;
      pastWindow(rig, intent);
      assert.deepEqual(await resolverFor(rig).resolve(queryOf(action)), NOT_COMPLETED);
      const recorded = recordedTradeSequenceExpiry((await rig.interlock.readIntent(executionId))!)!;
      // Same validated ledger as the proof, now reporting the Sequence consumed: a Sequence never moves back.
      assert.equal(rig.ledger.validatedIndex, recorded.ledgerIndex);
      rig.ledger.fund(intent.account, intent.sequence + 1);
      const report = await coordinatorFor(rig).assess(executionId, { p11: p11Of(action, result) });
      assert.deepEqual([report.assessment.class, report.assessment.inconsistencies], ['inconsistent-evidence', ['intent-settlement-contradicts-ledger']], JSON.stringify(report.assessment));
    } finally {
      await rig.close();
    }
  });

  it('the recorded proof is read strictly: only an expired intent with exactly one expired transition carrying a proof at or past LastLedgerSequence; P12 never closes an expired intent without it', async () => {
    const hash = 'C'.repeat(64);
    const base = intentRecordFor(
      {
        executionId: 'aoc.exec:p2-record',
        account: pairWorld(new FakeXrplLedger()).owner,
        sequence: 40,
        lastLedgerSequence: 520,
        minLedger: 501,
        transactionHash: 'D'.repeat(64),
        evidence: { organizationId: ORG, subject: 's', requestId: 'r', decisionId: 'd', boundedGrantId: 'g', proposalDigest: `sha256:${'a'.repeat(64)}`, delegateAccount: pairWorld(new FakeXrplLedger()).delegate.address, signerId: 'signer', signerRequestId: 'f'.repeat(64), signingPublicKey: `ED${'1'.repeat(64)}`, keyAuthority: 'master-key', preparedDigest: `sha256:${'b'.repeat(64)}`, delegationAssessmentDigest: `sha256:${'c'.repeat(64)}`, delegationFactsDigest: `sha256:${'d'.repeat(64)}`, referenceLedgerIndex: 500, referenceLedgerHash: 'E'.repeat(64), delegationLedgerIndex: 500, delegateRootLedgerIndex: 500, ownerRootLedgerIndex: 500, fee: '12', ledgerProvenance: 'injected-ledger-client' },
      },
      'expired',
    );
    const at = '2026-10-20T00:00:00.000Z';
    const withExpiry = (...details: string[]): TradeIntentRecord => ({ ...base, transitions: [{ from: null, to: 'intended', at }, { from: 'intended', to: 'signing', at }, ...details.map((detail) => ({ from: 'signing' as const, to: 'expired' as const, detail, at }))] });
    assert.deepEqual(recordedTradeSequenceExpiry(withExpiry(`unconsumed.520.${hash}`)), { ledgerIndex: 520, ledgerHash: hash });
    assert.equal(recordedTradeSequenceExpiry({ ...withExpiry(`unconsumed.520.${hash}`), state: 'signing' }), undefined, 'not expired');
    assert.equal(recordedTradeSequenceExpiry(withExpiry()), undefined, 'no expired transition');
    assert.equal(recordedTradeSequenceExpiry(withExpiry(`unconsumed.519.${hash}`)), undefined, 'a proof inside the window');
    assert.equal(recordedTradeSequenceExpiry(withExpiry(`unconsumed.520.${hash}`, `unconsumed.521.${hash}`)), undefined, 'two expiries');
    for (const detail of ['trade-transaction-expired', `unconsumed.520.${hash.toLowerCase()}`, `unconsumed.0520.${hash}`, `unconsumed.520.${hash}.x`, `unconsumed.99999999999.${hash}`]) assert.equal(recordedTradeSequenceExpiry(withExpiry(detail)), undefined, detail);

    const authority = (intent: TradeIntentRecord) => {
      const fake = new FakeXrplLedger();
      fake.fund(intent.account, intent.sequence);
      const client = fake.client(NETWORK_ID, { claimSubmission: async () => {} });
      return createTradeResolutionAuthority({ networkId: NETWORK_ID, action: ACTION, requestTimeoutMs: 1_000, ledger: readOnlyTradeLedger(client), interlock: { read: async () => undefined, settle: async () => {}, readIntent: async () => intent, expireIntent: async () => intent.state }, entries: validatedEntryReader(client, NETWORK_ID) });
    };
    const ask = (intent: TradeIntentRecord) => ({ organizationId: ORG, executionId: intent.executionId, evaluationId: 'e', requestId: 'r', decisionId: 'd', boundedGrantId: 'g', action: ACTION, basis: 'initial-observation-unconfirmed' as const });
    assert.deepEqual(await authority(withExpiry(`unconsumed.520.${hash}`)).resolve(ask(base)), NOT_COMPLETED);
    assert.deepEqual(await authority(withExpiry()).resolve(ask(base)), UNRESOLVED, 'an expired state without its proof is never a closure — even on a ledger that would prove it now');
    assert.deepEqual(await authority(withExpiry(`unconsumed.520.${hash}`)).resolve({ ...ask(base), providerRef: 'D'.repeat(64) }), UNRESOLVED, 'a reference the intent never reserved');
    assert.deepEqual(await authority(withExpiry(`unconsumed.520.${hash}`)).resolve({ ...ask(base), boundedGrantId: 'other' }), UNRESOLVED, 'another grant');
  });
});
