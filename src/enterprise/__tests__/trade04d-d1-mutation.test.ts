import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import Database from 'better-sqlite3';

import type { TradeIntentRecord, TradeReservationInput } from '../xrpl-trade-execution/index.js';
import { XRPL_TRADE_EXECUTOR_ID } from '../xrpl-trade-execution/host-configuration.js';
import { boundaryFor, closeAllWitnesses, startWitness } from './core07-freshness-fixture.js';
import { testAccount } from './trade04b-xrpl-fixture.js';
import { ACTION, FakeXrplLedger, NETWORK_ID, ORG, executorRig, rawProposal, scratch, validatedAction } from './trade04c-execution-fixture.js';
import { readOnlyTradeLedger } from '../xrpl-trade-execution/index.js';
import { testCapabilityIssuer } from './trade04c-s1-capability-fixture.js';
import { intendAndSign, intentFor, intentRecordFor, reserveWithIntent, testCapabilityId, validatedEntryReader } from './trade04d-intent-fixture.js';
import { createV1TradeSequenceInterlockForMigrationTests } from './trade04d-v1-interlock-fixture.js';

/**
 * TRADE-04D D-1 — mutation qualification of the pre-signing intent. Each
 * mutant edits the compiled module at one site and must be **detected** by
 * its guard, or **contained** by a named, independently qualified boundary
 * (the guard still holds against the mutant). Nothing is hidden: a mutant
 * that survives fails this suite.
 */

const load = createRequire(__filename);
const ENTERPRISE = join(__dirname, '..');
const spaces: { cleanup(): void }[] = [];
after(async () => {
  await closeAllWitnesses();
  for (const space of spaces.splice(0)) space.cleanup();
});
const dir = (): string => {
  const space = scratch();
  spaces.push(space);
  return space.dir;
};
const now = (): string => new Date().toISOString();

interface Mutant<M> {
  readonly id: string;
  readonly file: string;
  readonly replacements: readonly (readonly [string, string])[];
  readonly guard: (module: M) => boolean | Promise<boolean>;
  readonly expect?: 'detected' | 'contained';
  readonly containedBy?: string;
}

async function qualify<M>(mutant: Mutant<M>): Promise<void> {
  const path = join(ENTERPRISE, mutant.file);
  let source = readFileSync(path, 'utf8');
  for (const [search, replace] of mutant.replacements) {
    assert.equal(source.split(search).length - 1, 1, `${mutant.id}: the mutation site occurs exactly once in ${mutant.file}: ${search.slice(0, 100)}`);
    source = source.split(search).join(replace);
  }
  const mutantPath = path.replace(/\.js$/, `.mutant-${mutant.id}.js`);
  writeFileSync(mutantPath, source);
  try {
    assert.equal(await mutant.guard(load(path) as M), true, `${mutant.id}: the guard holds for the shipped module`);
    const held = await mutant.guard(load(mutantPath) as M);
    if ((mutant.expect ?? 'detected') === 'detected') assert.equal(held, false, `${mutant.id}: the guard detects the mutation`);
    else assert.equal(held, true, `${mutant.id}: contained by ${mutant.containedBy}`);
  } finally {
    delete load.cache[load.resolve(mutantPath)];
    rmSync(mutantPath, { force: true });
  }
}

type InterlockModule = typeof import('../xrpl-trade-execution/sqlite-trade-sequence-interlock.js');
type ExecutorModule = typeof import('../xrpl-trade-execution/trade-offer-executor.js');
type AssessmentModule = typeof import('../xrpl-trade-execution/trade-recovery-assessment.js');
type EvidenceModule = typeof import('../xrpl-trade-execution/trade-sequence-evidence.js');
type AuthorityModule = typeof import('../xrpl-trade-execution/trade-resolution-authority.js');
const INTERLOCK = 'xrpl-trade-execution/sqlite-trade-sequence-interlock.js';
const EXECUTOR = 'xrpl-trade-execution/trade-offer-executor.js';
const ASSESSMENT = 'xrpl-trade-execution/trade-recovery-assessment.js';
const EVIDENCE = 'xrpl-trade-execution/trade-sequence-evidence.js';
const AUTHORITY = 'xrpl-trade-execution/trade-resolution-authority.js';

const OWNER = testAccount();
const DELEGATE = testAccount();
const SCOPE = { domainId: XRPL_TRADE_EXECUTOR_ID, networkId: 1 };
let n = 0;
const reservation = (sequence = 40): TradeReservationInput => {
  n += 1;
  return {
    executionId: `aoc.exec:d1-mutant-${n}`,
    account: OWNER,
    sequence,
    lastLedgerSequence: 520,
    minLedger: 501,
    transactionHash: n.toString(16).toUpperCase().padStart(64, 'A'),
    evidence: { organizationId: ORG, subject: 's', requestId: `r${n}`, decisionId: `d${n}`, boundedGrantId: `g${n}`, proposalDigest: `sha256:${'a'.repeat(64)}`, delegateAccount: DELEGATE, signerId: 'signer', signerRequestId: 'f'.repeat(64), signingPublicKey: `ED${'1'.repeat(64)}`, keyAuthority: 'master-key', preparedDigest: `sha256:${'b'.repeat(64)}`, delegationAssessmentDigest: `sha256:${'c'.repeat(64)}`, delegationFactsDigest: `sha256:${'d'.repeat(64)}`, referenceLedgerIndex: 500, referenceLedgerHash: 'E'.repeat(64), delegationLedgerIndex: 500, delegateRootLedgerIndex: 500, ownerRootLedgerIndex: 500, fee: '12', ledgerProvenance: 'injected-ledger-client' },
  };
};

/** A store from the (possibly mutated) module, on a fresh file and witness. */
async function withStore<T>(module: InterlockModule, body: (store: Awaited<ReturnType<InterlockModule['createSqliteTradeSequenceInterlock']>>, path: string) => Promise<T>, path = join(dir(), 'i.sqlite')): Promise<T> {
  const witness = await startWitness();
  const store = await module.createSqliteTradeSequenceInterlock(path, { scope: SCOPE, sequenceAccounts: [OWNER], now, freshness: { boundary: await boundaryFor(witness, ORG) } });
  try {
    return await body(store, path);
  } finally {
    await store.close();
    await witness.close();
  }
}
const refused = (promise: Promise<unknown>): Promise<boolean> => promise.then(() => false, () => true);

describe('TRADE-04D D-1 mutations — the intent in the interlock', () => {
  const mutants: readonly Mutant<InterlockModule>[] = [
    {
      id: 'intent-ignores-open-windows',
      file: INTERLOCK,
      replacements: [["                    if (openBlocking(input.account, input.sequence, validatedLedgerIndex))\n                        return { done: { outcome: 'blocked' } };", '']],
      guard: (m) => withStore(m, async (store) => {
        await store.recordIntent(intentFor(reservation(40)), 500);
        return (await store.recordIntent(intentFor(reservation(40)), 500)).outcome === 'blocked';
      }),
    },
    {
      id: 'open-intent-does-not-block',
      file: INTERLOCK,
      replacements: [['open: exports.TRADE_INTENT_OPEN_STATES.includes(intent.state) }, sequence, validatedLedgerIndex));', 'open: false }, sequence, validatedLedgerIndex));']],
      guard: (m) => withStore(m, async (store) => {
        await intendAndSign(store, reservation(40), 500);
        return (await store.blocking({ account: OWNER, sequence: 40, validatedLedgerIndex: 500 })) === true;
      }),
    },
    {
      id: 'intent-not-anchored',
      file: INTERLOCK,
      replacements: [["                    ev.insert.run('intent', input.executionId, intentEventDigest(identity));", '']],
      guard: (m) => withStore(m, async (store) => {
        const r = reservation();
        await store.recordIntent(intentFor(r), 500).catch(() => undefined);
        return (await store.readIntent(r.executionId).catch(() => undefined))?.state === 'intended';
      }),
    },
    {
      id: 'signing-marker-not-anchored',
      file: INTERLOCK,
      replacements: [["                    ev.insert.run('sign', executionId, signEventDigest(identity, capabilityId));", '']],
      guard: (m) => withStore(m, async (store) => {
        const r = reservation();
        await store.recordIntent(intentFor(r), 500);
        await store.markSigning(r.executionId, testCapabilityId()).catch(() => undefined);
        return (await store.readIntent(r.executionId).catch(() => undefined))?.state === 'signing';
      }),
    },
    {
      id: 'abandon-a-contacted-intent',
      file: INTERLOCK,
      replacements: [['            if (intent.state !== from)\n                return intent.state;', '            void from;']],
      expect: 'contained',
      containedBy: 'the forward-only intent trigger (signing → abandoned is not a transition the schema admits)',
      guard: (m) => withStore(m, async (store) => {
        const r = reservation();
        await intendAndSign(store, r, 500);
        await store.abandonIntent(r.executionId).catch(() => undefined);
        return (await store.readIntent(r.executionId))?.state === 'signing' && (await store.blocking({ account: OWNER, sequence: 40, validatedLedgerIndex: 500 })) === true;
      }),
    },
    {
      id: 'reservation-ignores-intent-binding',
      file: INTERLOCK,
      replacements: [['                if (mismatch !== undefined)\n                    throw intentRefused(`reservation-intent-${mismatch}`);', '']],
      guard: (m) => withStore(m, async (store) => {
        const r = reservation();
        await intendAndSign(store, r, 500);
        return refused(store.reserve({ ...r, evidence: { ...r.evidence, preparedDigest: `sha256:${'0'.repeat(64)}` } }, 500));
      }),
    },
    {
      id: 'reservation-on-an-uncontacted-intent',
      file: INTERLOCK,
      replacements: [["                if (intent.state !== 'signing')\n                    throw intentRefused('intent-not-signing');", '']],
      expect: 'contained',
      containedBy: 'the forward-only intent trigger (intended → bound is not a transition the schema admits)',
      guard: (m) => withStore(m, async (store) => {
        const r = reservation();
        await store.recordIntent(intentFor(r), 500);
        return refused(store.reserve(r, 500));
      }),
    },
  ];
  for (const mutant of mutants) it(`${mutant.expect ?? 'detected'}: ${mutant.id}`, () => qualify(mutant));
});

describe('TRADE-04D D-1 mutations — the migration', () => {
  const legacy = (k: number): TradeReservationInput => ({ ...reservation(10 + k), executionId: `aoc.exec:d1-legacy-${k}-${(n += 1)}` });
  /** A genuine v1 file with one legacy reservation, anchored at the witness, migrated by `m`; a new execution then reserves under v2. */
  const migrated = (m: InterlockModule): Promise<boolean> =>
    (async () => {
      const witness = await startWitness();
      const path = join(dir(), 'i.sqlite');
      const v1 = await createV1TradeSequenceInterlockForMigrationTests(path, { scope: SCOPE, sequenceAccounts: [OWNER], now, freshness: { boundary: await boundaryFor(witness, ORG) } });
      await v1.reserve(legacy(1), 500);
      await v1.close();
      try {
        const store = await m.createSqliteTradeSequenceInterlock(path, { scope: SCOPE, sequenceAccounts: [OWNER], now, freshness: { boundary: await boundaryFor(witness, ORG) } });
        try {
          return (await reserveWithIntent(store, reservation(70), 500)).outcome === 'reserved' && (await store.verifyAll()).records === 2;
        } finally {
          await store.close();
        }
      } catch {
        return false;
      } finally {
        await witness.close();
      }
    })();
  const mutants: readonly Mutant<InterlockModule>[] = [
    {
      id: 'v2-event-ids-overlap-v1',
      file: INTERLOCK,
      replacements: [["                db.prepare(`INSERT INTO sqlite_sequence (name, seq) VALUES ('trade_anchored_events_v2', ?)`).run(eventCeiling);", '                void 0;']],
      guard: migrated,
    },
    {
      id: 'legacy-ceiling-dropped',
      file: INTERLOCK,
      replacements: [['                legacyReservationCeiling: reservationCeiling,', '                legacyReservationCeiling: 0,']],
      guard: migrated,
    },
    {
      id: 'verification-migrates-without-freshness',
      file: INTERLOCK,
      replacements: [['        else if (storeId !== undefined) {\n            currentHead();', "        else if (storeId !== undefined) {\n            if (schema === 'v1')\n                migrateToV2();\n            currentHead();"]],
      guard: async (m) => {
        const witness = await startWitness();
        const path = join(dir(), 'i.sqlite');
        const v1 = await createV1TradeSequenceInterlockForMigrationTests(path, { scope: SCOPE, sequenceAccounts: [OWNER], now, freshness: { boundary: await boundaryFor(witness, ORG) } });
        await v1.reserve(legacy(2), 500);
        await v1.close();
        await witness.close();
        const verifier = await m.createSqliteTradeSequenceInterlock(path, { now });
        await verifier.close();
        const db = new Database(path, { readonly: true });
        try {
          return (db.prepare('SELECT schema_version FROM trade_interlock_store_versions ORDER BY id DESC LIMIT 1').get() as { schema_version: string }).schema_version === 'aoc.trade-sequence-interlock.schema.v1';
        } finally {
          db.close();
        }
      },
    },
  ];
  for (const mutant of mutants) it(`${mutant.expect ?? 'detected'}: ${mutant.id}`, () => qualify(mutant));
});

describe('TRADE-04D D-1 mutations — the executor', () => {
  const run = async (m: ExecutorModule, body: (rig: Awaited<ReturnType<typeof executorRig>>, issuer: ReturnType<typeof testCapabilityIssuer>) => Promise<boolean>, options: Parameters<typeof executorRig>[0] = {}): Promise<boolean> => {
    const issuer = testCapabilityIssuer();
    const rig = await executorRig({ create: m.createTradeOfferExecutionAdapter, ...options, issuer });
    try {
      return await body(rig, issuer);
    } finally {
      await rig.close();
    }
  };
  const order = (rig: Awaited<ReturnType<typeof executorRig>>) => {
    const raw = rawProposal(rig.pairs[0]!);
    rig.book.attest(raw);
    return validatedAction(raw);
  };
  const mutants: readonly Mutant<ExecutorModule>[] = [
    {
      id: 'signer-contacted-without-the-signing-marker',
      file: EXECUTOR,
      replacements: [['                    await interlock.markSigning(executionId, issued.capability.capabilityId);', '                    void 0;']],
      guard: (m) => run(m, async (rig) => (await rig.adapter.execute(order(rig))).outcome === 'completed' && rig.ledger.submitCalls.length === 1),
    },
    {
      id: 'abandon-after-the-signer-was-contacted',
      file: EXECUTOR,
      replacements: [['                    throw new Refusal(F.PROVIDER_UNAVAILABLE, trade_execution_details_js_1.TRADE_EXECUTION_DETAILS.SIGNER_UNAVAILABLE);', '                    return abandonBeforeSigning(new Refusal(F.PROVIDER_UNAVAILABLE, trade_execution_details_js_1.TRADE_EXECUTION_DETAILS.SIGNER_UNAVAILABLE));']],
      expect: 'contained',
      containedBy: 'the interlock’s compare-and-set (only an `intended` intent is abandoned) and the forward-only trigger',
      guard: (m) =>
        run(
          m,
          async (rig) => {
            const action = order(rig);
            await rig.adapter.execute(action);
            return (await rig.interlock.readIntent(action.correlation.executionId))?.state === 'signing';
          },
          { create: (options) => m.createTradeOfferExecutionAdapter({ ...options, signer: { signDelegatedOffer: async () => Promise.reject(new Error('connection reset')) } }) },
        ),
    },
    {
      id: 'blocked-intent-ignored',
      file: EXECUTOR,
      replacements: [["                if (intent?.outcome === 'blocked')\n                    throw new Refusal(F.PROVIDER_UNAVAILABLE, trade_execution_details_js_1.TRADE_EXECUTION_DETAILS.SEQUENCE_IN_FLIGHT);", '']],
      expect: 'contained',
      containedBy: 'the closed intent-outcome check (anything but `recorded` refuses before issuance)',
      guard: (m) =>
        run(
          m,
          async (rig, issuer) => {
            rig.ledger.behavior = { kind: 'drop' };
            rig.ledger.autoAdvance = false;
            await rig.adapter.execute(order(rig));
            const issued = issuer.issued.length;
            const second = await rig.adapter.execute(order(rig));
            return second.outcome === 'failed' && issuer.issued.length === issued;
          },
          // The pre-signing probe is bypassed, so the competing order reaches its intent.
          { configuration: { finalityTimeoutMs: 0 }, create: (options) => m.createTradeOfferExecutionAdapter({ ...options, interlock: { ...options.interlock, blocking: async () => false } }) },
        ),
    },
    {
      id: 'previous-intent-ignored-on-retry',
      file: EXECUTOR,
      replacements: [["                if (attempted)\n                    return finish(Object.freeze({ outcome: 'unconfirmed', detail: trade_execution_details_js_1.TRADE_EXECUTION_DETAILS.PREVIOUSLY_RECORDED }));", '']],
      expect: 'contained',
      containedBy: 'the anchored intent itself (`recordIntent` answers execution-recorded) and the window it holds',
      guard: (m) =>
        run(
          m,
          async (rig, issuer) => {
            const action = order(rig);
            await rig.adapter.execute(action);
            const before = issuer.issued.length;
            await rig.adapter.execute(action);
            rig.ledger.advance(30);
            await rig.adapter.execute(action);
            return issuer.issued.length === before;
          },
          { create: (options) => m.createTradeOfferExecutionAdapter({ ...options, signer: { signDelegatedOffer: async () => Promise.reject(new Error('connection reset')) } }) },
        ),
    },
  ];
  for (const mutant of mutants) it(`${mutant.expect ?? 'detected'}: ${mutant.id}`, () => qualify(mutant));
});

describe('TRADE-04D D-1 mutations — the owner-Sequence proof, the assessment and P12', () => {
  const at = (ledgerIndex: number, sequence: number | undefined) => ({
    ledgerEntry: async () => ({ outcome: 'read' as const, value: { validatedLedger: {} as never, ledgerIndex, ledgerHash: 'B'.repeat(64), entry: sequence === undefined ? { state: 'absent' as const } : { state: 'present' as const, node: { LedgerEntryType: 'AccountRoot', Account: OWNER, Sequence: sequence } } } }),
  });
  const window = { account: OWNER, sequence: 40, lastLedgerSequence: 520 };
  const evidenceMutants: readonly Mutant<EvidenceModule>[] = [
    {
      id: 'consumed-sequence-read-as-proof',
      file: EVIDENCE,
      replacements: [["        return Object.freeze({ status: 'sequence-consumed', ...at, accountSequence });", "        return Object.freeze({ status: 'not-included', proof: 'owner-sequence-unconsumed', ...at, accountSequence });"]],
      guard: async (m) => (await m.readTradeSequenceEvidence(at(530, 41), window)).status === 'sequence-consumed',
    },
    {
      id: 'proof-before-last-ledger-sequence',
      file: EVIDENCE,
      replacements: [["    if (ledgerIndex < window.lastLedgerSequence)\n        return Object.freeze({ status: 'unresolved', reason: 'window-open', ...at });", '']],
      guard: async (m) => (await m.readTradeSequenceEvidence(at(519, 40), window)).status === 'unresolved',
    },
    {
      id: 'absent-entry-read-as-proof',
      file: EVIDENCE,
      replacements: [["    if (entry.state !== 'present')\n        return Object.freeze({ status: 'unresolved', reason: 'entry-absent', ...at });", '']],
      expect: 'contained',
      containedBy: 'the AccountRoot parse (`readXrplOwnerSequence` reads no Sequence from an absent entry → entry-malformed, unresolved)',
      guard: async (m) => (await m.readTradeSequenceEvidence(at(530, undefined), window)).status === 'unresolved',
    },
  ];
  for (const mutant of evidenceMutants) it(`${mutant.expect ?? 'detected'}: ${mutant.id}`, () => qualify(mutant));

  const signingIntent = intentRecordFor(reservation(), 'signing');
  const assessmentMutants: readonly Mutant<AssessmentModule>[] = [
    {
      id: 'contacted-intent-read-as-never-signed',
      file: ASSESSMENT,
      replacements: [["    const unsignedByHost = record === undefined && (intent?.state === 'intended' || intent?.state === 'abandoned');", "    const unsignedByHost = record === undefined && (intent?.state === 'intended' || intent?.state === 'abandoned' || intent?.state === 'signing');"]],
      guard: (m) => {
        const a = m.assessTradeRecovery({ executionId: signingIntent.executionId, interlock: { status: 'read', record: undefined, intent: signingIntent } });
        return a.signature === 'possible' && a.certainty !== 'proven';
      },
    },
  ];
  for (const mutant of assessmentMutants) it(`${mutant.expect ?? 'detected'}: ${mutant.id}`, () => qualify(mutant));

  const query = (intent: TradeIntentRecord) => ({ organizationId: ORG, executionId: intent.executionId, evaluationId: 'e', requestId: intent.evidence.requestId, decisionId: intent.evidence.decisionId, boundedGrantId: intent.evidence.boundedGrantId, action: ACTION, basis: 'initial-observation-unconfirmed' as const });
  /** The labelled fake ledger (validated index 1 000, past the intent's LastLedgerSequence 520) with the owner at `sequence`. */
  const authorityOf = (m: AuthorityModule, intent: TradeIntentRecord, abandoned: TradeIntentRecord['state'], sequence: number) => {
    const fake = new FakeXrplLedger();
    fake.fund(OWNER, sequence);
    const client = fake.client(NETWORK_ID, { claimSubmission: async () => {} });
    return m.createTradeResolutionAuthority({
      networkId: NETWORK_ID,
      action: ACTION,
      requestTimeoutMs: 1_000,
      ledger: readOnlyTradeLedger(client),
      interlock: { read: async () => undefined, settle: async () => {}, readIntent: async () => intent, abandonIntent: async () => abandoned, expireIntent: async () => 'expired' },
      entries: validatedEntryReader(client, NETWORK_ID),
    });
  };
  const authorityMutants: readonly Mutant<AuthorityModule>[] = [
    {
      id: 'p12-closes-a-signing-intent-without-the-proof',
      file: AUTHORITY,
      replacements: [["            if (evidence.status !== 'not-included')\n                return UNRESOLVED;", '']],
      guard: async (m) => (await authorityOf(m, signingIntent, 'signing', 41).resolve(query(signingIntent))).outcome === 'unresolved',
    },
    {
      id: 'p12-abandon-without-compare-and-set',
      file: AUTHORITY,
      replacements: [["                if (state !== 'abandoned')\n                    return UNRESOLVED;", '']],
      guard: async (m) => {
        // The executor's signing marker won the race: the abandonment answered `signing`.
        const intended = intentRecordFor(reservation(), 'intended');
        return (await authorityOf(m, intended, 'signing', 40).resolve(query(intended))).outcome === 'unresolved';
      },
    },
  ];
  for (const mutant of authorityMutants) it(`${mutant.expect ?? 'detected'}: ${mutant.id}`, () => qualify(mutant));
});
