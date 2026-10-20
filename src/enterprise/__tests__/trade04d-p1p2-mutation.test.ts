import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { TradeIntentRecord, TradeReservationInput, TradeSequenceEvidence } from '../xrpl-trade-execution/index.js';
import { readOnlyTradeLedger, readOnlyTradeRecoveryLedger } from '../xrpl-trade-execution/index.js';
import { testAccount } from './trade04b-xrpl-fixture.js';
import { ACTION, FakeXrplLedger, NETWORK_ID, ORG } from './trade04c-execution-fixture.js';
import { intentRecordFor, validatedEntryReader } from './trade04d-intent-fixture.js';

/**
 * TRADE-04D post-merge hardening — mutation qualification of P1 (the
 * resolver-side reads connect their own client) and P2 (an `expired` intent
 * answers from its recorded owner-Sequence proof). Each mutant edits the
 * compiled module at one site and must be **detected** by its guard; the
 * guard must hold for the shipped module. A mutant that survives fails this
 * suite.
 */

const load = createRequire(__filename);
const ENTERPRISE = join(__dirname, '..');

interface Mutant<M> {
  readonly id: string;
  readonly file: string;
  readonly replacements: readonly (readonly [string, string])[];
  readonly guard: (module: M) => boolean | Promise<boolean>;
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
    assert.equal(await mutant.guard(load(mutantPath) as M), false, `${mutant.id}: the guard detects the mutation`);
  } finally {
    delete load.cache[load.resolve(mutantPath)];
    rmSync(mutantPath, { force: true });
  }
}

type CoordinatorModule = typeof import('../xrpl-trade-execution/trade-recovery-coordinator.js');
type AssessmentModule = typeof import('../xrpl-trade-execution/trade-recovery-assessment.js');
type EvidenceModule = typeof import('../xrpl-trade-execution/trade-sequence-evidence.js');
type AuthorityModule = typeof import('../xrpl-trade-execution/trade-resolution-authority.js');
const COORDINATOR = 'xrpl-trade-execution/trade-recovery-coordinator.js';
const ASSESSMENT = 'xrpl-trade-execution/trade-recovery-assessment.js';
const EVIDENCE = 'xrpl-trade-execution/trade-sequence-evidence.js';
const AUTHORITY = 'xrpl-trade-execution/trade-resolution-authority.js';

const OWNER = testAccount();
const DELEGATE = testAccount();
const LAST_LEDGER_SEQUENCE = 520;
const PROOF_LEDGER = 600;
const HASH = 'A'.repeat(64);
let n = 0;
const reservation = (sequence = 40): TradeReservationInput => {
  n += 1;
  return {
    executionId: `aoc.exec:p1p2-mutant-${n}`,
    account: OWNER,
    sequence,
    lastLedgerSequence: LAST_LEDGER_SEQUENCE,
    minLedger: 501,
    transactionHash: n.toString(16).toUpperCase().padStart(64, 'B'),
    evidence: { organizationId: ORG, subject: 's', requestId: `r${n}`, decisionId: `d${n}`, boundedGrantId: `g${n}`, proposalDigest: `sha256:${'a'.repeat(64)}`, delegateAccount: DELEGATE, signerId: 'signer', signerRequestId: 'f'.repeat(64), signingPublicKey: `ED${'1'.repeat(64)}`, keyAuthority: 'master-key', preparedDigest: `sha256:${'b'.repeat(64)}`, delegationAssessmentDigest: `sha256:${'c'.repeat(64)}`, delegationFactsDigest: `sha256:${'d'.repeat(64)}`, referenceLedgerIndex: 500, referenceLedgerHash: 'E'.repeat(64), delegationLedgerIndex: 500, delegateRootLedgerIndex: 500, ownerRootLedgerIndex: 500, fee: '12', ledgerProvenance: 'injected-ledger-client' },
  };
};
const at = '2026-10-20T00:00:00.000Z';
/** An `expired` intent exactly as the interlock records it: one `expired` transition carrying the proof's validated ledger. */
const expiredIntent = (detail = `unconsumed.${PROOF_LEDGER}.${HASH}`): TradeIntentRecord =>
  intentRecordFor(reservation(), 'expired', {
    transitions: [
      { from: null, to: 'intended', at },
      { from: 'intended', to: 'signing', at },
      { from: 'signing', to: 'expired', detail, at },
    ],
  });
const consumedAt = (ledgerIndex: number): TradeSequenceEvidence => ({ status: 'sequence-consumed', ledgerIndex, ledgerHash: HASH, accountSequence: 41 });
const query = (intent: TradeIntentRecord) => ({ organizationId: ORG, executionId: intent.executionId, evaluationId: 'e', requestId: intent.evidence.requestId, decisionId: intent.evidence.decisionId, boundedGrantId: intent.evidence.boundedGrantId, action: ACTION, basis: 'initial-observation-unconfirmed' as const });

describe('TRADE-04D P1 mutations — the coordinator connects its own client before a validated read', () => {
  const signing = intentRecordFor(reservation(), 'signing');
  const mutants: readonly Mutant<CoordinatorModule>[] = [
    {
      id: 'coordinator-reads-before-connecting',
      file: COORDINATOR,
      replacements: [['await ledger.connect();', '']],
      // A client that answers only once it connected, and nothing else connects it: the intent past LastLedgerSequence must still be proven.
      guard: async (m) => {
        const fake = new FakeXrplLedger();
        fake.strictConnections = true;
        fake.fund(OWNER, signing.sequence);
        const coordinator = m.createTradeRecoveryCoordinator({ networkId: NETWORK_ID, requestTimeoutMs: 1_000, maxValidatedLedgerAgeSeconds: 10, ledger: readOnlyTradeRecoveryLedger(fake.client(NETWORK_ID, { claimSubmission: async () => {} })), interlock: { read: async () => undefined, readIntent: async () => signing } });
        const report = await coordinator.assess(signing.executionId);
        return report.assessment.class === 'proven-not-included' && report.assessment.ledger.via === 'owner-sequence';
      },
    },
  ];
  for (const mutant of mutants) it(`detected: ${mutant.id}`, () => qualify(mutant));
});

describe('TRADE-04D P2 mutations — the recorded expiry proof', () => {
  const evidenceMutants: readonly Mutant<EvidenceModule>[] = [
    {
      id: 'recorded-expiry-before-last-ledger-sequence-accepted',
      file: EVIDENCE,
      replacements: [['|| ledgerIndex < intent.lastLedgerSequence)', ')']],
      guard: (m) => m.recordedTradeSequenceExpiry(expiredIntent(`unconsumed.${LAST_LEDGER_SEQUENCE - 1}.${HASH}`)) === undefined && m.recordedTradeSequenceExpiry(expiredIntent()) !== undefined,
    },
    {
      id: 'second-expiry-transition-accepted',
      file: EVIDENCE,
      replacements: [['if (expiries.length !== 1)', 'if (expiries.length < 1)']],
      guard: (m) => {
        const twice = expiredIntent();
        const transitions: TradeIntentRecord['transitions'] = [...twice.transitions, { from: 'signing', to: 'expired', detail: `unconsumed.${PROOF_LEDGER + 1}.${HASH}`, at }];
        return m.recordedTradeSequenceExpiry({ ...twice, transitions }) === undefined;
      },
    },
    {
      id: 'malformed-recorded-proof-accepted',
      file: EVIDENCE,
      replacements: [['if (match === null)\n        return undefined;', '']],
      guard: (m) => {
        try {
          return m.recordedTradeSequenceExpiry(expiredIntent('trade-transaction-expired')) === undefined;
        } catch {
          return false;
        }
      },
    },
  ];
  for (const mutant of evidenceMutants) it(`detected: ${mutant.id}`, () => qualify(mutant));

  const assess = (m: AssessmentModule, intent: TradeIntentRecord, evidence: TradeSequenceEvidence) => m.assessTradeRecovery({ executionId: intent.executionId, interlock: { status: 'read', record: undefined, intent }, sequenceEvidence: evidence });
  const assessmentMutants: readonly Mutant<AssessmentModule>[] = [
    {
      id: 'sequence-reuse-after-expiry-read-as-contradiction',
      file: ASSESSMENT,
      replacements: [['expiry === undefined || sequenceEvidence.ledgerIndex <= expiry.ledgerIndex', 'true']],
      guard: (m) => {
        const a = assess(m, expiredIntent(), consumedAt(PROOF_LEDGER + 1));
        return a.class === 'proven-not-included' && a.inconsistencies.length === 0 && !a.uncertainties.includes('sequence-consumed-by-unknown-transaction');
      },
    },
    {
      id: 'consumption-before-the-recorded-proof-ignored',
      file: ASSESSMENT,
      replacements: [['sequenceEvidence.ledgerIndex <= expiry.ledgerIndex', 'false']],
      guard: (m) => {
        const a = assess(m, expiredIntent(), consumedAt(PROOF_LEDGER));
        return a.class === 'inconsistent-evidence' && a.inconsistencies.includes('intent-settlement-contradicts-ledger');
      },
    },
  ];
  for (const mutant of assessmentMutants) it(`detected: ${mutant.id}`, () => qualify(mutant));

  /** P12 over a fake ledger on which the owner's Sequence is already consumed (a later order reused it). */
  const authorityOf = (m: AuthorityModule, intent: TradeIntentRecord) => {
    const fake = new FakeXrplLedger();
    fake.fund(OWNER, intent.sequence + 1);
    const client = fake.client(NETWORK_ID, { claimSubmission: async () => {} });
    return m.createTradeResolutionAuthority({
      networkId: NETWORK_ID,
      action: ACTION,
      requestTimeoutMs: 1_000,
      ledger: readOnlyTradeLedger(client),
      interlock: { read: async () => undefined, settle: async () => {}, readIntent: async () => intent, expireIntent: async () => intent.state },
      entries: validatedEntryReader(client, NETWORK_ID),
    });
  };
  const authorityMutants: readonly Mutant<AuthorityModule>[] = [
    {
      id: 'p12-ignores-the-recorded-expiry',
      file: AUTHORITY,
      replacements: [[')(intent) !== undefined ? NOT_COMPLETED : UNRESOLVED;', ')(intent) !== undefined ? UNRESOLVED : UNRESOLVED;']],
      guard: async (m) => {
        const intent = expiredIntent();
        return (await authorityOf(m, intent).resolve(query(intent))).outcome === 'resolved';
      },
    },
    {
      id: 'p12-closes-an-expired-intent-without-its-proof',
      file: AUTHORITY,
      replacements: [[')(intent) !== undefined ? NOT_COMPLETED : UNRESOLVED;', ')(intent) !== null ? NOT_COMPLETED : UNRESOLVED;']],
      guard: async (m) => {
        const intent = intentRecordFor(reservation(), 'expired');
        return (await authorityOf(m, intent).resolve(query(intent))).outcome === 'unresolved';
      },
    },
  ];
  for (const mutant of authorityMutants) it(`detected: ${mutant.id}`, () => qualify(mutant));
});
