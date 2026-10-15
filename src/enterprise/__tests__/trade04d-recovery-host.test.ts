import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import { TRADE_PARAMETER_DIMENSION_IDS } from '../../features/trade-runtime/index.js';
import {
  TRADE_EXECUTION_SIMULATION_ACKNOWLEDGEMENT,
  XRPL_TRADE_EXECUTOR_ID,
  composeXrplTradeExecution,
  createSqliteTradeSequenceInterlock,
  createTradeRecoveryCoordinator,
  parseXrplTradeExecutionSection,
  readOnlyTradeRecoveryLedger,
  type TradeRecoveryP11View,
  type TradeRecoveryReport,
  type TradeSignerObservation,
} from '../xrpl-trade-execution/index.js';
import { ORG } from './core04-host-fixture.js';
import { approvals, as, commandFor } from './core05-host-fixture.js';
import { boundaryFor, closeAllWitnesses, closeDeploymentWitnesses, startWitness } from './core07-freshness-fixture.js';
import { ACTION, AttestationBook, FakeXrplLedger, NETWORK_ID, SIGNER_TOKEN, pairWorld, scratch, startSigner } from './trade04c-execution-fixture.js';
import { APPROVER, SIGNER_TOKEN_ENV, Workspace, admit, bootTradeHost, governTrade, post, proposalFor, tradeExecutionSection, type TradeHost } from './trade04c-host-fixture.js';
import { S1_TRUST_DOMAIN } from './trade04c-s1-capability-fixture.js';

/**
 * TRADE-04D §11 — recovery assessment over the **shipped Host**: real
 * governed requests through the canonical Host (TRADE-03 admission, Kernel,
 * CORE-05 approvals, P10 grant, P11 claim, the composed executor, TRADE-04B
 * signer client, G2 submit site, CORE-07-anchored interlock), assessed by the
 * shipped coordinator with the P11 record read from the Host's own outcome
 * store and the signer's report read from the customer signer's ledger. The
 * coordinator reads the Host's interlock file in verification mode (it writes
 * nothing). The last suite composes the trade execution directly to qualify
 * the composed `recovery()` on the anchored interlock. Offline: labelled fake
 * ledger, no XRPL network.
 */

const workspace = new Workspace();
let main: TradeHost;
before(async () => {
  main = await bootTradeHost(workspace);
});
after(async () => {
  await main?.signer.close().catch(() => {});
  workspace.cleanup();
  await closeDeploymentWitnesses();
  await closeAllWitnesses();
});

const counts = (trade: TradeHost) => ({ signatures: trade.signer.signatures(), sends: trade.ledger.submitCalls.length });

async function p11Of(trade: TradeHost, executionId: string): Promise<TradeRecoveryP11View> {
  return { record: await trade.host.enterprise.executionOutcomes?.read({ organizationId: ORG }, executionId) };
}

/** The shipped coordinator over a verification-mode read of the Host's interlock file and a read-only view of the ledger. */
async function assess(trade: TradeHost, executionId: string, extra: { readonly resolution?: TradeRecoveryP11View['resolution'] } = {}): Promise<TradeRecoveryReport> {
  const reader = await createSqliteTradeSequenceInterlock(join(trade.dir, 'xrpl-trade-sequence-interlock.sqlite'), { now: () => new Date().toISOString() });
  try {
    const refuse = { claimSubmission: async () => Promise.reject(new Error('read-only')) };
    const ledgerView = readOnlyTradeRecoveryLedger(trade.ledger.client(NETWORK_ID, refuse));
    const p11 = await p11Of(trade, executionId);
    const signer = trade.signer.ledger.inspect(executionId) as TradeSignerObservation;
    const context = { p11: { ...p11, ...(extra.resolution !== undefined ? { resolution: extra.resolution } : {}) }, signer };
    // Handed the verification reader's own health, the coordinator refuses it: an unanchored read is never trusted silently.
    const unanchored = await createTradeRecoveryCoordinator({ networkId: NETWORK_ID, requestTimeoutMs: 1_000, maxValidatedLedgerAgeSeconds: 10, ledger: ledgerView, interlock: reader }).assess(executionId, context);
    assert.deepEqual([unanchored.assessment.class, unanchored.assessment.lifecycle], ['indeterminate', 'unavailable']);
    // The harness's view: the Host's verified rows (the Host itself holds the anchored interlock; its composed recovery() is qualified below).
    return await createTradeRecoveryCoordinator({ networkId: NETWORK_ID, requestTimeoutMs: 1_000, maxValidatedLedgerAgeSeconds: 10, ledger: ledgerView, interlock: { read: (id: string) => reader.read(id) } }).assess(executionId, context);
  } finally {
    await reader.close();
  }
}

describe('TRADE-04D Scenario A — normal confirmed execution, on the shipped Host', () => {
  it('one capability, one signature, one submission; recovery: validated-success, consistent across P11, interlock, signer and ledger; offer resting at an identified ledger; the diagnostic carries no secret', async () => {
    const before = counts(main);
    const reply = await governTrade(main, proposalFor(main, '100'));
    assert.equal(reply.body['status'], 'executed', reply.text);
    const executionId = reply.body['executionId'] as string;
    assert.deepEqual(counts(main), { signatures: before.signatures + 1, sends: before.sends + 1 });
    assert.match(main.traces.at(-1)?.capabilityId ?? '', /^[0-9a-f]{64}$/, 'one per-order capability');
    main.ledger.autoAdvance = false;
    try {
      const report = await assess(main, executionId);
      const a = report.assessment;
      assert.deepEqual([a.class, a.certainty, a.lifecycle, a.settlement, a.signature, a.fronteraSubmission], ['validated-success', 'proven', 'settled', 'validated-success', 'verified-by-host', 'claimed']);
      assert.deepEqual(a.inconsistencies, []);
      assert.equal(a.sequence.status, 'released-by-ledger-fact');
      assert.equal(a.offer?.interpretation, 'resting-as-of-snapshot');
      const d = report.diagnostic;
      assert.deepEqual([d.organizationId, d.ownerAccount, d.delegateAccount, d.networkId, d.signerCapability, d.submissionClaimRecorded, d.permission], [ORG, main.pair.owner, main.pair.delegate.address, 1, 'signed', true, 'none']);
      assert.equal(d.evidence.transactionHash, main.ledger.submitted.at(-1)?.hash);
      const text = JSON.stringify(report);
      for (const secret of [SIGNER_TOKEN, main.pair.delegate.seed, main.ledger.submitted.at(-1)!.blob]) assert.equal(text.includes(secret), false, 'no credential, key or signed blob');
      assert.deepEqual(counts(main), { signatures: before.signatures + 1, sends: before.sends + 1 }, 'the assessment added nothing');
    } finally {
      main.ledger.autoAdvance = true;
    }
  });
});

describe('TRADE-04D Scenario B — denied order: no capability, signature, reservation or submission', () => {
  it('the Kernel denies; nothing is claimed; recovery proves there is no trade record', async () => {
    const before = counts(main);
    const traces = main.traces.length;
    const reply = await governTrade(main, proposalFor(main, '3000'));
    assert.equal(reply.body['status'], 'denied', reply.text);
    assert.deepEqual(counts(main), before);
    assert.equal(main.traces.length, traces, 'the executor was never invoked: no capability issued');
    const executionId = typeof reply.body['executionId'] === 'string' ? (reply.body['executionId'] as string) : 'aoc.exec:never-claimed';
    const report = await assess(main, executionId);
    assert.deepEqual([report.assessment.class, report.assessment.certainty, report.assessment.lifecycle], ['no-trade-record', 'proven', 'absent']);
  });
});

describe('TRADE-04D Scenario C — approval required: zero signing and submission until approved; then exactly one execution', () => {
  it('withheld → nothing to recover; approved and resumed → one execution, validated-success', async () => {
    const before = counts(main);
    const intent = await admit(main, proposalFor(main, '800'));
    const withheld = await post(main, intent);
    assert.equal(withheld.body['status'], 'withheld', withheld.text);
    assert.deepEqual(counts(main), before);
    const view = await approvals(main.host).describe(withheld.body['requestId'] as string);
    await approvals(main.host).approve(as(APPROVER), commandFor(view!));
    const resumed = await post(main, intent);
    assert.equal(resumed.body['status'], 'executed', resumed.text);
    assert.deepEqual(counts(main), { signatures: before.signatures + 1, sends: before.sends + 1 });
    main.ledger.autoAdvance = false;
    try {
      assert.equal((await assess(main, resumed.body['executionId'] as string)).assessment.class, 'validated-success');
    } finally {
      main.ledger.autoAdvance = true;
    }
  });
});

describe('TRADE-04D Scenario E — submit response lost, on the shipped Host: recovery reads validated evidence; P12 settles; nothing is sent again', () => {
  it('unconfirmed with its hash in P11 → submission-response-unknown (Sequence held) → validated-success → P12 resolves; the P12 answer agrees with the assessment', async () => {
    main.ledger.behavior = { kind: 'throw-after-send', includeWith: 'tesSUCCESS' };
    main.ledger.autoAdvance = false;
    try {
      const before = counts(main);
      const reply = await governTrade(main, proposalFor(main, '30'));
      const executionId = reply.body['executionId'] as string;
      const pending = await assess(main, executionId);
      assert.deepEqual([pending.assessment.class, pending.assessment.sequence.status], ['submission-response-unknown', 'blocked']);
      assert.deepEqual(pending.assessment.inconsistencies, [], 'P11 names exactly the reserved hash');
      main.ledger.advance(1);
      assert.equal((await assess(main, executionId)).assessment.class, 'validated-success');
      const resolved = await main.host.enterprise.executionReconciliation?.reconcile({ organizationId: ORG, executionId });
      assert.equal((resolved as { outcome?: string }).outcome, 'resolved');
      const after = await assess(main, executionId, { resolution: { certainty: 'confirmed-completed' } });
      assert.deepEqual([after.assessment.class, after.assessment.lifecycle, after.assessment.inconsistencies], ['validated-success', 'settled', []]);
      assert.deepEqual(counts(main), { signatures: before.signatures + 1, sends: before.sends + 1 });
    } finally {
      main.ledger.behavior = { kind: 'accept' };
      main.ledger.autoAdvance = true;
    }
  });
});

describe('TRADE-04D — the composed recovery() on the CORE-07-anchored interlock', () => {
  it('composeXrplTradeExecution exposes recovery(): read-only over the anchored interlock; a witness that cannot be reached is reported, never hidden', async () => {
    const space = scratch();
    const witness = await startWitness();
    const ledger = new FakeXrplLedger();
    const pair = pairWorld(ledger);
    const signer = await startSigner([pair]);
    const book = new AttestationBook();
    const configuration = parseXrplTradeExecutionSection(
      { [SIGNER_TOKEN_ENV]: SIGNER_TOKEN },
      tradeExecutionSection(pair, signer.endpoint),
      { routes: new Map([[ACTION, XRPL_TRADE_EXECUTOR_ID]]), financialActions: [ACTION], parameterDimensions: Object.values(TRADE_PARAMETER_DIMENSION_IDS), otherAdapterIds: [] },
    );
    const composed = await composeXrplTradeExecution({ configuration, interlockPath: join(space.dir, 'interlock.sqlite'), freshness: await boundaryFor(witness, ORG), attested: book, trustDomain: S1_TRUST_DOMAIN, ledgerClient: ledger.factory(), simulation: TRADE_EXECUTION_SIMULATION_ACKNOWLEDGEMENT });
    try {
      const none = await composed.recovery('aoc.exec:trade04d-composed-none', { p11: { record: undefined } });
      assert.deepEqual([none.assessment.class, none.assessment.certainty], ['no-trade-record', 'proven']);
      assert.deepEqual(none.assessment.uncertainties, []);
      await witness.close();
      // The interlock module's health probes the witness; a later recovery read reports the unproven freshness.
      for (const module of composed.modules) await module.health().catch(() => undefined);
      const unproven = await composed.recovery('aoc.exec:trade04d-composed-none', { p11: { record: undefined } });
      assert.ok(unproven.assessment.uncertainties.includes('interlock-freshness-unproven'), JSON.stringify(unproven.assessment));
    } finally {
      await composed.close();
      await signer.close();
      space.cleanup();
    }
  });
});
