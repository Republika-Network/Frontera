import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import Database from 'better-sqlite3';

import type { ExecutionAdapterResult, ValidatedExecutionAction } from '../../features/execution-runtime/index.js';
import { DELEGATED_OFFER_CAPABILITY_ISSUER_FAILURES, DelegatedOfferCapabilityError, type DelegatedOfferCapabilityIssuerFailure } from '../authority-authenticity/delegated-offer-capability-issuer.js';
import {
  TRADE_EXECUTION_DETAILS as D,
  createTradeOfferExecutionAdapter,
  createTradeResolutionAuthority,
  readOnlyTradeLedger,
  readOnlyTradeRecoveryLedger,
  type TradeExecutionInterlock,
} from '../xrpl-trade-execution/index.js';
import type { DelegatedOfferSigningPort } from '../xrpl-trade-rail/index.js';
import { AUTHORITY_KEY_B } from './authority-authenticity-fixture.js';
import { closeDeploymentWitnesses, closeAllWitnesses, startWitness } from './core07-freshness-fixture.js';
import { ACTION, FakeXrplLedger, NETWORK_ID, ORG, executorRig, pairWorld, rawProposal, scratch, validatedAction, type ExecutorRig } from './trade04c-execution-fixture.js';
import { Workspace, admit, bootTradeHost, post, proposalFor } from './trade04c-host-fixture.js';
import { testCapabilityIssuer } from './trade04c-s1-capability-fixture.js';
import { validatedEntryReader } from './trade04d-intent-fixture.js';

/**
 * TRADE-04D H-1 — post-intent outcome certainty.
 *
 * Once the executor has asked the CORE-02 custody boundary for a capability,
 * a signature may exist outside the Host (the custody boundary and the
 * delegated signer are other processes) until the validated ledger passes
 * `LastLedgerSequence`. So from the issuance call on, no refusal is a terminal
 * `failed`: the outcome is `unconfirmed`, with **no** provider reference (the
 * Host holds no reservation and no hash — a P11 reference without a trade
 * record is an inconsistency the recovery assessment refuses), the P7 capacity
 * stays settled, and only P12's owner-Sequence proof closes it. A terminal
 * `failed` remains only where non-issuance is proven: before the intent, or a
 * refusal the issuer made before asking the authority signer.
 *
 * Every case counts the effects no refusal, retry or restart may add:
 * capabilities issued, signatures, submissions. Offline: the labelled fake
 * ledger, the real executor, the real CORE-07-anchored interlock and witness,
 * the real reference signer.
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

const detail = (result: ExecutionAdapterResult): string | undefined => ('detail' in result ? result.detail : undefined);
const providerRef = (result: ExecutionAdapterResult): string | undefined => ('providerRef' in result && typeof result.providerRef === 'string' ? result.providerRef : undefined);
const effects = (rig: ExecutorRig, issuer: { readonly issued: readonly unknown[] }) => ({ capabilities: issuer.issued.length, signatures: rig.signer.signatures(), submissions: rig.ledger.submitCalls.length });

const withSigner = (wrap: (port: DelegatedOfferSigningPort) => DelegatedOfferSigningPort): typeof createTradeOfferExecutionAdapter => (options) => createTradeOfferExecutionAdapter({ ...options, signer: wrap(options.signer) });
const withInterlock = (override: Partial<TradeExecutionInterlock>): typeof createTradeOfferExecutionAdapter => (options) => createTradeOfferExecutionAdapter({ ...options, interlock: { ...options.interlock, ...override } as TradeExecutionInterlock });

function resolverFor(rig: ExecutorRig) {
  const reads = readOnlyTradeRecoveryLedger(rig.ledger.client(NETWORK_ID, rig.interlock));
  return createTradeResolutionAuthority({ networkId: NETWORK_ID, action: ACTION, requestTimeoutMs: 1_000, ledger: readOnlyTradeLedger(rig.ledger.client(NETWORK_ID, rig.interlock)), interlock: rig.interlock, entries: validatedEntryReader(reads, NETWORK_ID) });
}
const queryOf = (action: ValidatedExecutionAction) => ({ organizationId: ORG, executionId: action.correlation.executionId, evaluationId: 'eval-h1', requestId: action.correlation.requestId, decisionId: action.correlation.decisionId, boundedGrantId: action.boundedGrantId, action: ACTION });

/** Before the issuance call the issuer refused on its own: no capability exists. Terminal failure, exactly as before H-1. */
const PROVEN_NOT_ISSUED: readonly (readonly [DelegatedOfferCapabilityIssuerFailure, string])[] = [
  ['CAPABILITY_ISSUER_UNBOUND', D.CAPABILITY_UNAVAILABLE],
  ['CAPABILITY_ISSUER_UNSUPPORTED', D.CAPABILITY_UNAVAILABLE],
  ['CAPABILITY_GRANT_UNAVAILABLE', D.CAPABILITY_UNAVAILABLE],
  ['CAPABILITY_REQUEST_INVALID', D.CAPABILITY_REFUSED],
  ['CAPABILITY_GRANT_NOT_FOUND', D.CAPABILITY_REFUSED],
  ['CAPABILITY_GRANT_REVOKED', D.CAPABILITY_REFUSED],
  ['CAPABILITY_REFUSED', D.CAPABILITY_REFUSED],
];

describe('TRADE-04D H-1 — a refusal before the authority signer is asked stays a terminal failure (non-issuance proven)', () => {
  for (const [code, expected] of PROVEN_NOT_ISSUED) {
    it(`${code}: failed (${expected}); nothing issued, signed or sent; the intent keeps holding its window`, async () => {
      const issuer = testCapabilityIssuer({ refuse: () => new DelegatedOfferCapabilityError(code, code) });
      const rig = await executorRig({ issuer });
      try {
        const { action } = order(rig);
        const result = await rig.adapter.execute(action);
        assert.deepEqual([result.outcome, detail(result)], ['failed', expected], JSON.stringify(result));
        assert.deepEqual(effects(rig, issuer), { capabilities: 0, signatures: 0, submissions: 0 });
        assert.equal(rig.traces.at(-1)?.signingRequests, 0, 'the signer was never contacted');
        assert.equal((await rig.interlock.readIntent(action.correlation.executionId))?.state, 'intended', 'a terminal outcome never releases the window: only the ledger does');
      } finally {
        await rig.close();
      }
    });
  }
});

interface UncertainCase {
  readonly name: string;
  readonly expected: string;
  readonly issued: number;
  readonly signatures: number;
  readonly intent: 'intended' | 'signing';
  readonly setup: () => { readonly issuer: ReturnType<typeof testCapabilityIssuer>; readonly create?: typeof createTradeOfferExecutionAdapter; readonly before?: (rig: ExecutorRig) => Promise<void> };
}

const UNCERTAIN: readonly UncertainCase[] = [
  {
    name: 'the authority signing call failed or timed out (CAPABILITY_SIGNING_UNAVAILABLE) — it may have signed',
    expected: D.CAPABILITY_UNAVAILABLE,
    issued: 0,
    signatures: 0,
    intent: 'intended',
    setup: () => ({ issuer: testCapabilityIssuer({ refuse: () => new DelegatedOfferCapabilityError('CAPABILITY_SIGNING_UNAVAILABLE', 'timed out') }) }),
  },
  {
    name: 'the authority answered a signature that does not verify (CAPABILITY_SIGNATURE_INVALID)',
    expected: D.CAPABILITY_UNAVAILABLE,
    issued: 0,
    signatures: 0,
    intent: 'intended',
    setup: () => ({ issuer: testCapabilityIssuer({ refuse: () => new DelegatedOfferCapabilityError('CAPABILITY_SIGNATURE_INVALID', 'does not verify') }) }),
  },
  {
    name: 'the issuer failed with an unrecognized error',
    expected: D.CAPABILITY_UNAVAILABLE,
    issued: 0,
    signatures: 0,
    intent: 'intended',
    setup: () => ({ issuer: testCapabilityIssuer({ refuse: () => new Error('socket hang up') }) }),
  },
  {
    name: 'the capability was issued but the signing marker could not be recorded (markSigning failed)',
    expected: D.INTENT_FAILED,
    issued: 1,
    signatures: 0,
    intent: 'intended',
    setup: () => ({
      issuer: testCapabilityIssuer(),
      create: withInterlock({
        markSigning: async () => {
          throw new Error('witness did not answer');
        },
      }),
    }),
  },
  {
    name: 'the delegated signer is unreachable',
    expected: D.SIGNER_UNAVAILABLE,
    issued: 1,
    signatures: 0,
    intent: 'signing',
    setup: () => ({ issuer: testCapabilityIssuer(), before: (rig) => rig.signer.close() }),
  },
  {
    name: 'the delegated signer refuses (a capability under a key it does not pin)',
    expected: D.SIGNER_REFUSED,
    issued: 1,
    signatures: 0,
    intent: 'signing',
    setup: () => ({ issuer: testCapabilityIssuer({ key: AUTHORITY_KEY_B }) }),
  },
  {
    name: 'the delegated signer signed, then its response was lost',
    expected: D.SIGNER_UNAVAILABLE,
    issued: 1,
    signatures: 1,
    intent: 'signing',
    setup: () => ({
      issuer: testCapabilityIssuer(),
      create: withSigner((port) => ({
        signDelegatedOffer: async (request) => {
          await port.signDelegatedOffer(request);
          throw new Error('the response was lost after the signature');
        },
      })),
    }),
  },
  {
    name: 'the delegated signer answered a signature that fails the independent check',
    expected: D.SIGNATURE_REJECTED,
    issued: 1,
    signatures: 1,
    intent: 'signing',
    setup: () => ({
      issuer: testCapabilityIssuer(),
      create: withSigner((port) => ({ signDelegatedOffer: async (request) => ({ ...(await port.signDelegatedOffer(request)), signingPublicKey: `ED${'0'.repeat(64)}` }) })),
    }),
  },
  {
    name: 'the reservation failed after a verified signature',
    expected: D.RESERVATION_FAILED,
    issued: 1,
    signatures: 1,
    intent: 'signing',
    setup: () => ({
      issuer: testCapabilityIssuer(),
      create: withInterlock({
        reserve: async () => {
          throw new Error('disk full');
        },
      }),
    }),
  },
];

describe('TRADE-04D H-1 — once a capability may exist, every refusal is unconfirmed, never a terminal failure', () => {
  for (const c of UNCERTAIN) {
    it(`${c.name}: unconfirmed (${c.expected}), no provider reference, nothing sent; a repeat adds no capability, signature or submission`, async () => {
      const { issuer, create, before } = c.setup();
      const rig = await executorRig({ issuer, ...(create !== undefined ? { create } : {}) });
      try {
        await before?.(rig);
        const { action } = order(rig);
        const executionId = action.correlation.executionId;
        const result = await rig.adapter.execute(action);
        assert.deepEqual([result.outcome, detail(result), providerRef(result)], ['unconfirmed', c.expected, undefined], JSON.stringify(result));
        assert.deepEqual(effects(rig, issuer), { capabilities: c.issued, signatures: c.signatures, submissions: 0 });
        assert.equal(await rig.interlock.recorded(executionId), undefined, 'no reservation: the submit site can never send it');
        assert.equal((await rig.interlock.readIntent(executionId))?.state, c.intent, 'the window stays held');

        const again = await rig.adapter.execute(action);
        assert.deepEqual([again.outcome, detail(again), providerRef(again)], ['unconfirmed', D.PREVIOUSLY_RECORDED, undefined]);
        assert.deepEqual(effects(rig, issuer), { capabilities: c.issued, signatures: c.signatures, submissions: 0 }, 'no duplicate capability, signature or submission');
      } finally {
        await rig.close();
      }
    });
  }
});

describe('TRADE-04D H-1 — reconciliation closes an uncertain execution only on the ledger fact', () => {
  it('signed, response lost: P12 is unresolved before LastLedgerSequence; past it, with the owner Sequence unconsumed, confirmed-not-completed — no signature or submission added', async () => {
    const issuer = testCapabilityIssuer();
    const rig = await executorRig({ issuer, create: withSigner((port) => ({ signDelegatedOffer: async (request) => { await port.signDelegatedOffer(request); throw new Error('lost'); } })) });
    try {
      rig.ledger.autoAdvance = false;
      const { action } = order(rig);
      const result = await rig.adapter.execute(action);
      assert.equal(result.outcome, 'unconfirmed');
      const intent = (await rig.interlock.readIntent(action.correlation.executionId))!;
      assert.ok(rig.ledger.validatedIndex < intent.lastLedgerSequence);
      assert.deepEqual(await resolverFor(rig).resolve(queryOf(action)), { outcome: 'unresolved' }, 'elapsed time is never evidence');
      assert.equal((await rig.interlock.readIntent(action.correlation.executionId))?.state, 'signing');

      rig.ledger.advance(intent.lastLedgerSequence - rig.ledger.validatedIndex);
      assert.deepEqual(await resolverFor(rig).resolve(queryOf(action)), { outcome: 'resolved', certainty: 'confirmed-not-completed', failure: 'PROVIDER_REJECTED' });
      assert.equal((await rig.interlock.readIntent(action.correlation.executionId))?.state, 'expired');
      assert.deepEqual(effects(rig, issuer), { capabilities: 1, signatures: 1, submissions: 0 });
    } finally {
      await rig.close();
    }
  });

  it('signed, response lost, and the owner Sequence consumed out of band: never reported not-completed', async () => {
    const issuer = testCapabilityIssuer();
    const rig = await executorRig({ issuer, create: withSigner((port) => ({ signDelegatedOffer: async (request) => { await port.signDelegatedOffer(request); throw new Error('lost'); } })) });
    try {
      rig.ledger.autoAdvance = false;
      const { action } = order(rig);
      assert.equal((await rig.adapter.execute(action)).outcome, 'unconfirmed');
      const intent = (await rig.interlock.readIntent(action.correlation.executionId))!;
      rig.ledger.fund(intent.account, intent.sequence + 1);
      rig.ledger.advance(intent.lastLedgerSequence - rig.ledger.validatedIndex + 1);
      assert.deepEqual(await resolverFor(rig).resolve(queryOf(action)), { outcome: 'unresolved' });
      assert.equal((await rig.interlock.readIntent(action.correlation.executionId))?.state, 'signing', 'the window is never released on a guess');
    } finally {
      await rig.close();
    }
  });

  it('restart after an issuance outcome unknown: the same execution is refused before any new capability; past LastLedgerSequence P12 closes it on the owner-Sequence proof', async () => {
    const { initializeReferenceCapabilityLedger } = await import('../xrpl-trade-rail/reference/reference-delegated-offer-signer.js');
    const dir = persistent();
    const signerLedgerPath = join(persistent(), 'signer-ledger.sqlite');
    await initializeReferenceCapabilityLedger(signerLedgerPath);
    const ledger = new FakeXrplLedger();
    const witness = await startWitness();
    const pairs = [pairWorld(ledger)];
    const world = { dir, witness, ledger, pairs, signerLedgerPath };

    const issuer = testCapabilityIssuer({ refuse: () => new DelegatedOfferCapabilityError('CAPABILITY_SIGNING_UNAVAILABLE', 'timed out') });
    const rig = await executorRig({ ...world, issuer });
    const { raw, action } = order(rig);
    const result = await rig.adapter.execute(action);
    assert.deepEqual([result.outcome, detail(result), providerRef(result)], ['unconfirmed', D.CAPABILITY_UNAVAILABLE, undefined]);
    await rig.close();

    const issuer2 = testCapabilityIssuer();
    const restarted = await executorRig({ ...world, issuer: issuer2 });
    try {
      restarted.book.attest(raw);
      const again = await restarted.adapter.execute(action);
      assert.deepEqual([again.outcome, detail(again), providerRef(again)], ['unconfirmed', D.PREVIOUSLY_RECORDED, undefined]);
      assert.deepEqual(effects(restarted, issuer2), { capabilities: 0, signatures: 0, submissions: 0 }, 'no replacement capability after a restart');
      const intent = (await restarted.interlock.readIntent(action.correlation.executionId))!;
      assert.equal(intent.state, 'intended');
      if (restarted.ledger.validatedIndex < intent.lastLedgerSequence) restarted.ledger.advance(intent.lastLedgerSequence - restarted.ledger.validatedIndex);
      assert.deepEqual(await resolverFor(restarted).resolve(queryOf(action)), { outcome: 'resolved', certainty: 'confirmed-not-completed', failure: 'PROVIDER_REJECTED' });
      assert.deepEqual(effects(restarted, issuer2), { capabilities: 0, signatures: 0, submissions: 0 });
    } finally {
      await restarted.close();
    }
  });
});

describe('TRADE-04D H-1 — on the shipped Host: an uncertain execution keeps its P7 capacity and is never retried', () => {
  it('the signer answers out of protocol after the capability was issued: execution_unconfirmed, the P7 reservation is settled (not released), a replay calls nothing', async () => {
    const trade = await bootTradeHost(workspace);
    try {
      trade.signer.forge = () => ({});
      const before = { signatures: trade.signer.signatures(), sends: trade.ledger.submitCalls.length };
      const intent = await admit(trade, proposalFor(trade, '40'));
      const reply = await post(trade, intent);
      assert.equal(reply.body['status'], 'execution_unconfirmed', reply.text);
      const executionId = reply.body['executionId'];
      assert.equal(typeof executionId, 'string', reply.text);
      assert.equal(trade.traces.at(-1)?.detail, 'trade-signer-unavailable');
      assert.deepEqual({ signatures: trade.signer.signatures(), sends: trade.ledger.submitCalls.length }, before, 'nothing signed by the reference service, nothing sent');

      const db = new Database(join(trade.dir, 'exercise-ledger.sqlite'), { readonly: true });
      try {
        const row = db
          .prepare(
            `SELECT t.terminal_kind AS kind, t.reason AS reason
               FROM exercise_control_reservations r
               LEFT JOIN exercise_control_terminal_events t ON t.reservation_id = r.reservation_id
              WHERE r.execution_id = ?`,
          )
          .get(executionId) as { kind: string | null; reason: string | null } | undefined;
        assert.deepEqual(row, { kind: 'settled', reason: 'execution-unconfirmed' }, 'the capacity is never returned while the order may still reach the ledger');
      } finally {
        db.close();
      }

      trade.signer.forge = undefined;
      const traces = trade.traces.length;
      const replay = await post(trade, intent);
      assert.equal(replay.body['status'], 'execution_unconfirmed', replay.text);
      assert.equal(trade.traces.length, traces, 'the replay is answered from P11: the executor is not called again');
      assert.deepEqual({ signatures: trade.signer.signatures(), sends: trade.ledger.submitCalls.length }, before);
    } finally {
      await trade.signer.close();
    }
  });
});

describe('TRADE-04D H-1 structure — the outcome mapping', () => {
  const codeOf = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
  const executor = codeOf(readFileSync('src/enterprise/xrpl-trade-execution/trade-offer-executor.ts', 'utf8'));
  const issuerSource = codeOf(readFileSync('src/enterprise/authority-authenticity/delegated-offer-capability-issuer.ts', 'utf8'));

  it('CAPABILITY_NEVER_REQUESTED is exactly the issuer’s refusals made before its signing call (and the unbound slot); every issuer failure is classified', () => {
    const declared = executor.slice(executor.indexOf('const CAPABILITY_NEVER_REQUESTED'), executor.indexOf(']);', executor.indexOf('const CAPABILITY_NEVER_REQUESTED')));
    const neverRequested = [...declared.matchAll(/'(CAPABILITY_[A-Z_]+)'/g)].map((match) => match[1]!).sort();
    const issue = issuerSource.slice(issuerSource.indexOf('async issue(input: DelegatedOfferCapabilityIssuanceInput): Promise<IssuedDelegatedOfferCapability> {'));
    const signingCall = issue.indexOf('signature = await sign.call(signer, request);');
    assert.ok(signingCall > 0);
    const beforeSigning = [...issue.slice(0, signingCall).matchAll(/fail\('(CAPABILITY_[A-Z_]+)'/g)].map((match) => match[1]!);
    const afterSigning = [...issue.slice(signingCall, issue.indexOf('export interface DelegatedOfferCapabilityIssuerSlot')).matchAll(/fail\('(CAPABILITY_[A-Z_]+)'/g)].map((match) => match[1]!);
    assert.match(issuerSource, /if \(target === undefined\) throw new DelegatedOfferCapabilityError\('CAPABILITY_ISSUER_UNBOUND'/);
    assert.deepEqual(neverRequested, [...new Set([...beforeSigning, 'CAPABILITY_ISSUER_UNBOUND'])].sort());
    assert.deepEqual(afterSigning.sort(), ['CAPABILITY_SIGNATURE_INVALID', 'CAPABILITY_SIGNING_UNAVAILABLE']);
    assert.equal(neverRequested.some((code) => afterSigning.includes(code)), false);
    assert.deepEqual([...neverRequested, ...afterSigning].sort(), [...DELEGATED_OFFER_CAPABILITY_ISSUER_FAILURES].sort(), 'a new issuer failure must be classified');
  });

  it('the flag is raised at the issuance call (after the intent, before issue) and a refusal after it maps to unconfirmed with no provider reference', () => {
    const body = executor.slice(executor.indexOf('async function execute('));
    const positions = ['interlock.recordIntent(', 'capabilityMayExist = true;', 'authorization.issuer.issue(', 'CAPABILITY_NEVER_REQUESTED.has(code)', 'interlock.markSigning('].map((marker) => body.indexOf(marker));
    for (const position of positions) assert.notEqual(position, -1);
    assert.deepEqual([...positions].sort((a, b) => a - b), positions);
    const outer = body.slice(body.lastIndexOf('const refusal = error instanceof Refusal'));
    assert.match(outer, /if \(capabilityMayExist\) return finish\(Object\.freeze\(\{ outcome: 'unconfirmed', detail: refusal\.detail \}\)\);\s*return finish\(failed\(refusal\.reason, refusal\.detail\)\);/);
    assert.equal(/capabilityMayExist = true;/.test(body.slice(body.indexOf('CAPABILITY_NEVER_REQUESTED.has(code)'))), false, 'nothing after the issuance call lowers certainty back to a terminal failure except a proven refusal');
  });
});
