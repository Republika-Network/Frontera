import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import Database from 'better-sqlite3';

import type { ExecutionAdapterResult, ValidatedExecutionAction } from '../../features/execution-runtime/index.js';
import { computeDigest } from '../governance-store/digest.js';
import {
  createSqliteTradeSequenceInterlock,
  createTradeOfferExecutionAdapter,
  createTradeRecoveryCoordinator,
  createTradeResolutionAuthority,
  readOnlyTradeLedger,
  readOnlyTradeRecoveryLedger,
  type TradeRecoveryP11View,
} from '../xrpl-trade-execution/index.js';
import type { DelegatedOfferSigningPort } from '../xrpl-trade-rail/index.js';
import { initializeReferenceCapabilityLedger } from '../xrpl-trade-rail/reference/reference-delegated-offer-signer.js';
import { ORG as HOST_ORG } from './core04-host-fixture.js';
import { closeAllWitnesses, closeDeploymentWitnesses, startWitness } from './core07-freshness-fixture.js';
import { ACTION, FakeXrplLedger, NETWORK_ID, ORG, executorRig, pairWorld, rawProposal, scratch, validatedAction, type ExecutorRig } from './trade04c-execution-fixture.js';
import { Workspace, admit, bootTradeHost, post, proposalFor } from './trade04c-host-fixture.js';
import { testCapabilityIssuer } from './trade04c-s1-capability-fixture.js';
import { validatedEntryReader } from './trade04d-intent-fixture.js';

/**
 * TRADE-04D — a forged local expiry never closes an execution (PR #193
 * security review, Option C).
 *
 * The interlock records `expired` as a local, unanchored transition whose
 * state digest is unkeyed. A writer of the interlock file can therefore forge
 * one with the production schema: two statements its triggers allow
 * (`signing → expired`, an appended transition) and a digest recomputed from
 * the row's own columns with the public digest function. The store's
 * integrity checks accept it — that is the residual this suite is about.
 *
 * What must hold regardless: P12 answers only on validated ledger evidence
 * read in the resolving call. For an intent whose transaction reached the
 * ledger (its `Sequence` consumed), or whose non-inclusion cannot be read,
 * the forged `expired` yields `unresolved` — never `confirmed-not-completed`,
 * no P12 resolution, no P7 capacity returned — and the recovery assessment
 * raises `intent-settlement-contradicts-ledger`.
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

/** Reproduced from `sqlite-trade-sequence-interlock.ts` source, as a writer of the file would: the unkeyed intent-state digest domain. */
const INTENT_STATE_DIGEST_DOMAIN = 'aoc.trade-sequence-interlock.intent-state.v1';

/**
 * What a writer of the interlock file can do with the production schema and
 * nothing else: no trigger dropped, no private hook — the row moved forward to
 * `expired` (the forward-only trigger admits `signing → expired`), its state
 * digest recomputed, and an `expired` transition appended carrying a proof
 * detail in the interlock's own format.
 */
function forgeExpired(path: string, executionId: string, proof: { readonly ledgerIndex: number; readonly ledgerHash: string }): void {
  const db = new Database(path, { fileMustExist: true });
  try {
    db.pragma('busy_timeout = 5000');
    const row = db.prepare('SELECT identity_digest, capability_id, state FROM trade_intents WHERE execution_id = ?').get(executionId) as { identity_digest: string; capability_id: string | null; state: string } | undefined;
    assert.ok(row !== undefined, 'the intent exists');
    assert.equal(row.state, 'signing');
    const updatedAt = new Date().toISOString();
    const stateDigest = computeDigest({ domain: INTENT_STATE_DIGEST_DOMAIN, identityDigest: row.identity_digest, state: 'expired', capabilityId: row.capability_id, updatedAt });
    db.transaction(() => {
      db.prepare('UPDATE trade_intents SET state = ?, updated_at = ?, state_digest = ? WHERE execution_id = ?').run('expired', updatedAt, stateDigest, executionId);
      db.prepare('INSERT INTO trade_intent_transitions (execution_id, from_state, to_state, detail, recorded_at) VALUES (?, ?, ?, ?, ?)').run(executionId, 'signing', 'expired', `unconsumed.${proof.ledgerIndex}.${proof.ledgerHash}`, updatedAt);
    })();
  } finally {
    db.close();
  }
}

function order(rig: ExecutorRig): { readonly action: ValidatedExecutionAction } {
  const raw = rawProposal(rig.pairs[0]!);
  rig.book.attest(raw);
  return { action: validatedAction(raw) };
}
const withSigner = (wrap: (port: DelegatedOfferSigningPort) => DelegatedOfferSigningPort): typeof createTradeOfferExecutionAdapter => (options) => createTradeOfferExecutionAdapter({ ...options, signer: wrap(options.signer) });
/** The delegated signer signs, and its answer is lost: H-1 — `unconfirmed`, an intent `signing`, no reservation, no hash. */
const responseLost = withSigner((port) => ({ signDelegatedOffer: async (request) => { await port.signDelegatedOffer(request); throw new Error('lost'); } }));
function resolverFor(rig: ExecutorRig) {
  const reads = readOnlyTradeRecoveryLedger(rig.ledger.client(NETWORK_ID, rig.interlock));
  return createTradeResolutionAuthority({ networkId: NETWORK_ID, action: ACTION, requestTimeoutMs: 1_000, ledger: readOnlyTradeLedger(rig.ledger.client(NETWORK_ID, rig.interlock)), interlock: rig.interlock, entries: validatedEntryReader(reads, NETWORK_ID) });
}
function coordinatorFor(rig: ExecutorRig) {
  return createTradeRecoveryCoordinator({
    networkId: NETWORK_ID,
    requestTimeoutMs: 1_000,
    maxValidatedLedgerAgeSeconds: 10,
    ledger: readOnlyTradeRecoveryLedger(rig.ledger.client(NETWORK_ID, rig.interlock)),
    interlock: { read: (id: string) => rig.interlock.read(id), readIntent: (id: string) => rig.interlock.readIntent(id), health: () => rig.interlock.health() },
  });
}
const queryOf = (action: ValidatedExecutionAction) => ({ organizationId: ORG, executionId: action.correlation.executionId, evaluationId: 'eval-forged', requestId: action.correlation.requestId, decisionId: action.correlation.decisionId, boundedGrantId: action.boundedGrantId, action: ACTION, basis: 'initial-observation-unconfirmed' as const });
function p11Of(action: ValidatedExecutionAction, result: ExecutionAdapterResult): TradeRecoveryP11View {
  const attempt = { organizationId: ORG, executionId: action.correlation.executionId, requestId: action.correlation.requestId, decisionId: action.correlation.decisionId, boundedGrantId: action.boundedGrantId, action: action.action };
  return { record: { attempt, terminal: { observation: { kind: 'provider', certainty: result.outcome === 'unconfirmed' ? 'unconfirmed' : 'confirmed-not-completed' } } } };
}
const UNRESOLVED = { outcome: 'unresolved' };

describe('TRADE-04D — a forged local expiry never closes an execution', () => {
  it('on a real interlock file reopened by the production store: the forged expiry passes the store’s unkeyed checks, and P12 still answers unresolved — the consumed Sequence, an unreadable ledger and an unavailable server all stay unresolved; the assessment raises the contradiction', async () => {
    const dir = persistent();
    const signerLedgerPath = join(persistent(), 'signer-ledger.sqlite');
    await initializeReferenceCapabilityLedger(signerLedgerPath);
    const ledger = new FakeXrplLedger();
    const witness = await startWitness();
    const world = { dir, witness, ledger, pairs: [pairWorld(ledger)], signerLedgerPath };

    const issuer = testCapabilityIssuer();
    const rig = await executorRig({ ...world, issuer, create: responseLost });
    rig.ledger.autoAdvance = false;
    const { action } = order(rig);
    const result = await rig.adapter.execute(action);
    assert.equal(result.outcome, 'unconfirmed');
    const executionId = action.correlation.executionId;
    const intent = (await rig.interlock.readIntent(executionId))!;
    assert.equal(intent.state, 'signing');
    assert.ok(ledger.validatedIndex < intent.lastLedgerSequence, 'the fixture starts inside the window');
    // The signed order reached the ledger inside its window: its Sequence is consumed.
    ledger.fund(intent.account, intent.sequence + 1);
    ledger.advance(intent.lastLedgerSequence - ledger.validatedIndex + 1);
    assert.deepEqual(await resolverFor(rig).resolve(queryOf(action)), UNRESOLVED, 'before the forgery: never closed on a consumed Sequence');
    await rig.close();

    // The writer forges the release, naming a real validated ledger past LastLedgerSequence.
    forgeExpired(join(dir, 'trade-interlock.sqlite'), executionId, { ledgerIndex: ledger.validatedIndex, ledgerHash: ledger.hashOf(ledger.validatedIndex) });

    const issuer2 = testCapabilityIssuer();
    const restarted = await executorRig({ ...world, issuer: issuer2 });
    try {
      const forged = await restarted.interlock.readIntent(executionId);
      assert.equal(forged?.state, 'expired', 'the forgery passes the store’s unkeyed integrity checks: this is the residual under test, not a guarantee');

      for (let pass = 0; pass < 2; pass += 1) assert.deepEqual(await resolverFor(restarted).resolve(queryOf(action)), UNRESOLVED, 'the consumed Sequence, read now, is what P12 answers on');
      restarted.ledger.faults.accountRootThrows = true;
      assert.deepEqual(await resolverFor(restarted).resolve(queryOf(action)), UNRESOLVED, 'an unreadable owner entry: non-inclusion cannot be proven');
      restarted.ledger.faults.accountRootThrows = false;
      restarted.ledger.faults.serverInfoThrows = true;
      assert.deepEqual(await resolverFor(restarted).resolve(queryOf(action)), UNRESOLVED, 'an unavailable server: nothing is read, nothing is closed');
      restarted.ledger.faults.serverInfoThrows = false;

      const report = await coordinatorFor(restarted).assess(executionId, { p11: p11Of(action, result) });
      assert.deepEqual([report.assessment.class, report.assessment.certainty], ['inconsistent-evidence', 'refused'], JSON.stringify(report.assessment));
      assert.ok(report.assessment.inconsistencies.includes('intent-settlement-contradicts-ledger'), 'the forged expiry against the consumed Sequence is an integrity alarm');
      assert.deepEqual({ capabilities: issuer2.issued.length, signatures: restarted.signer.signatures(), submissions: restarted.ledger.submitCalls.length }, { capabilities: 0, signatures: 0, submissions: 0 });
    } finally {
      await restarted.close();
    }
  });

  it('on the shipped Host, forged while it runs: P12 reconcile stays unresolved, writes no resolution, and the P7 reservation stays settled — no capacity returned', async () => {
    const trade = await bootTradeHost(workspace);
    try {
      trade.signer.forge = () => ({});
      const before = { signatures: trade.signer.signatures(), sends: trade.ledger.submitCalls.length };
      const reply = await post(trade, await admit(trade, proposalFor(trade, '40')));
      assert.equal(reply.body['status'], 'execution_unconfirmed', reply.text);
      const executionId = reply.body['executionId'] as string;
      trade.signer.forge = undefined;

      const interlockPath = join(trade.dir, 'xrpl-trade-sequence-interlock.sqlite');
      const read = new Database(interlockPath, { readonly: true, fileMustExist: true });
      let intentRow: { account: string; sequence: number; last_ledger_sequence: number };
      try {
        intentRow = read.prepare('SELECT account, sequence, last_ledger_sequence FROM trade_intents WHERE execution_id = ?').get(executionId) as typeof intentRow;
      } finally {
        read.close();
      }
      assert.ok(intentRow !== undefined, 'the H-1 execution left an intent');
      // The order reached the ledger (its Sequence consumed), and the ledger passed LastLedgerSequence.
      trade.ledger.fund(intentRow.account, intentRow.sequence + 1);
      trade.ledger.advance(intentRow.last_ledger_sequence - trade.ledger.validatedIndex + 1);
      forgeExpired(interlockPath, executionId, { ledgerIndex: trade.ledger.validatedIndex, ledgerHash: trade.ledger.hashOf(trade.ledger.validatedIndex) });
      // The production store's own decode accepts the forged row (verification open of the Host's file): P12's refusal below is the ledger's, not the store's.
      const verifier = await createSqliteTradeSequenceInterlock(interlockPath, { now: () => new Date().toISOString() });
      try {
        assert.equal((await verifier.readIntent(executionId))?.state, 'expired', 'the forgery passes the store’s unkeyed integrity checks: the residual under test');
      } finally {
        await verifier.close();
      }

      for (let pass = 0; pass < 2; pass += 1) {
        const answer = (await trade.host.enterprise.executionReconciliation!.reconcile({ organizationId: HOST_ORG, executionId })) as { readonly outcome: string };
        assert.equal(answer.outcome, 'unresolved', JSON.stringify(answer));
      }

      const p7 = new Database(join(trade.dir, 'exercise-ledger.sqlite'), { readonly: true, fileMustExist: true });
      try {
        const terminal = p7
          .prepare(
            `SELECT t.terminal_kind AS kind, t.reason AS reason
               FROM exercise_control_reservations r
               LEFT JOIN exercise_control_terminal_events t ON t.reservation_id = r.reservation_id
              WHERE r.execution_id = ?`,
          )
          .get(executionId) as { kind: string | null; reason: string | null } | undefined;
        assert.deepEqual(terminal, { kind: 'settled', reason: 'execution-unconfirmed' }, 'the capacity stays consumed');
        const resolutions = p7.prepare('SELECT COUNT(*) AS n FROM exercise_control_reservation_resolutions WHERE execution_id = ?').get(executionId) as { n: number };
        assert.equal(resolutions.n, 0, 'no P7 resolution: nothing returns capacity');
      } finally {
        p7.close();
      }
      assert.deepEqual({ signatures: trade.signer.signatures(), sends: trade.ledger.submitCalls.length }, before, 'nothing signed by the reference service, nothing sent');
    } finally {
      await trade.signer.close();
    }
  });
});
