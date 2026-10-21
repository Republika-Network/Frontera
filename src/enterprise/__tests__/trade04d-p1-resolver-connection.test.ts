import { readFileSync } from 'node:fs';
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { ExecutionAdapterResult, ValidatedExecutionAction } from '../../features/execution-runtime/index.js';
import { createTradeOfferExecutionAdapter, createTradeRecoveryCoordinator, readOnlyTradeRecoveryLedger, type TradeRecoveryP11View } from '../xrpl-trade-execution/index.js';
import type { DelegatedOfferSigningPort } from '../xrpl-trade-rail/index.js';
import { ORG as HOST_ORG } from './core04-host-fixture.js';
import { closeAllWitnesses, closeDeploymentWitnesses } from './core07-freshness-fixture.js';
import { FakeXrplLedger, NETWORK_ID, ORG, executorRig, rawProposal, validatedAction, type ExecutorRig } from './trade04c-execution-fixture.js';
import { Workspace, admit, bootTradeHost, post, proposalFor } from './trade04c-host-fixture.js';
import { testCapabilityIssuer } from './trade04c-s1-capability-fixture.js';

/**
 * TRADE-04D post-merge hardening — P1, the resolver-side reads connect their
 * own client.
 *
 * The Host composes the P12 trade authority and the recovery coordinator over
 * their own ledger client. Before this fix only a transaction lookup (an
 * execution with a reservation) called `connect()`. A real XRPL client refuses
 * a request before `connect()`, so the owner-Sequence read for an intent-only
 * execution — exactly the H-1 outcome — stayed `unresolved` until some other
 * read happened to connect the shared client. Here every fake client refuses
 * reads until **it** connected (`strictConnections`): no read can lean on a
 * connection another client opened.
 *
 * A failed connection and an unavailable ledger stay `unresolved`; the
 * intent's window stays held; nothing is signed or sent. Offline: the
 * labelled fake ledger, the real executor, the real CORE-07-anchored
 * interlock and witness, the real reference signer.
 */

const workspace = new Workspace();
after(async () => {
  await closeAllWitnesses();
  workspace.cleanup();
  await closeDeploymentWitnesses();
});

function order(rig: ExecutorRig): { readonly action: ValidatedExecutionAction } {
  const raw = rawProposal(rig.pairs[0]!);
  rig.book.attest(raw);
  return { action: validatedAction(raw) };
}

const effects = (rig: ExecutorRig, issuer: { readonly issued: readonly unknown[] }) => ({ capabilities: issuer.issued.length, signatures: rig.signer.signatures(), submissions: rig.ledger.submitCalls.length });
const withSigner = (wrap: (port: DelegatedOfferSigningPort) => DelegatedOfferSigningPort): typeof createTradeOfferExecutionAdapter => (options) => createTradeOfferExecutionAdapter({ ...options, signer: wrap(options.signer) });
/** The delegated signer signs, and its answer is lost: H-1 — `unconfirmed`, an intent `signing`, no reservation, no hash. */
const responseLost = withSigner((port) => ({ signDelegatedOffer: async (request) => { await port.signDelegatedOffer(request); throw new Error('lost'); } }));

function p11Of(action: ValidatedExecutionAction, result: ExecutionAdapterResult): TradeRecoveryP11View {
  const attempt = { organizationId: ORG, executionId: action.correlation.executionId, requestId: action.correlation.requestId, decisionId: action.correlation.decisionId, boundedGrantId: action.boundedGrantId, action: action.action };
  return { record: { attempt, terminal: { observation: { kind: 'provider', certainty: result.outcome === 'unconfirmed' ? 'unconfirmed' : 'confirmed-not-completed' } } } };
}

describe('TRADE-04D P1 — the resolver-side reads connect their own client', () => {
  it('on the shipped Host, every client refusing reads until it connected: an H-1 intent-only execution stays unresolved while the ledger cannot be connected or read, then P12 closes it on the owner-Sequence proof — once', async () => {
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
      assert.equal((await reconcile()).outcome, 'unresolved', 'a ledger that cannot be connected proves nothing');
      trade.ledger.faults.connectThrows = false;
      // Connected, but the server cannot answer: never evidence either.
      trade.ledger.faults.serverInfoThrows = true;
      assert.equal((await reconcile()).outcome, 'unresolved', 'an unavailable ledger proves nothing');
      trade.ledger.faults.serverInfoThrows = false;

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
      rig.ledger.autoAdvance = false;
      const { action } = order(rig);
      const result = await rig.adapter.execute(action);
      assert.equal(result.outcome, 'unconfirmed');
      const executionId = action.correlation.executionId;
      const intent = (await rig.interlock.readIntent(executionId))!;
      assert.equal(intent.state, 'signing');
      if (rig.ledger.validatedIndex < intent.lastLedgerSequence) rig.ledger.advance(intent.lastLedgerSequence - rig.ledger.validatedIndex);
      const coordinator = createTradeRecoveryCoordinator({
        networkId: NETWORK_ID,
        requestTimeoutMs: 1_000,
        maxValidatedLedgerAgeSeconds: 10,
        ledger: readOnlyTradeRecoveryLedger(rig.ledger.client(NETWORK_ID, rig.interlock)),
        interlock: { read: (id: string) => rig.interlock.read(id), readIntent: (id: string) => rig.interlock.readIntent(id), health: () => rig.interlock.health() },
      });

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

  it('structure: both validated-read ports connect before server_info, which every validated read asks first; the read-only views gain no write', () => {
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
    const ports = [
      composition.slice(composition.indexOf('const ownerSequenceReader'), composition.indexOf('const authority = createTradeResolutionAuthority')),
      coordinator.slice(coordinator.indexOf('const reader: XrplValidatedLedgerReader'), coordinator.indexOf('async function offerStateOf')),
    ];
    for (const port of ports) {
      assert.ok(port.length > 0);
      assert.equal(/submitReserved|claimSubmission|\.reserve\s*\(|\.settle\s*\(/.test(port), false, 'connecting a read port adds no write');
    }
  });
});
