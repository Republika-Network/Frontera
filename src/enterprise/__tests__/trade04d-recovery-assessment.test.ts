import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { TRADE_RECOVERY_CLASSES, assessTradeRecovery, type TradeLedgerEvidence, type TradeRecoveryP11Record, type TradeRecoveryP11View, type TradeSignerObservation, type TradeSubmissionRecord } from '../xrpl-trade-execution/index.js';
import { testAccount } from './trade04b-xrpl-fixture.js';

/**
 * TRADE-04D §3 — the recovery decision table, pure: each of the twelve
 * classes from the inputs that prove it, every cross-input contradiction
 * refused, and no input able to turn an assessment into a permission.
 */

const OWNER = testAccount();
const DELEGATE = testAccount();
const EXEC = 'aoc.exec:trade04d-unit-1';
const HASH = 'A'.repeat(64);

function row(state: TradeSubmissionRecord['state'], settlement?: TradeSubmissionRecord['settlement'], overrides: Partial<TradeSubmissionRecord> = {}): TradeSubmissionRecord {
  return {
    executionId: EXEC,
    account: OWNER,
    sequence: 41,
    lastLedgerSequence: 120,
    minLedger: 101,
    transactionHash: HASH,
    transactionType: 'OfferCreate',
    state,
    ...(settlement !== undefined ? { settlement } : {}),
    submissionAttempts: state === 'reserved' ? 0 : 1,
    transitions: [],
    reservedAt: '2026-10-15T00:00:00.000Z',
    updatedAt: '2026-10-15T00:00:00.000Z',
    evidence: { organizationId: 'org-acme', subject: 's', requestId: 'req-1', decisionId: 'dec-1', boundedGrantId: 'grant-1', proposalDigest: 'sha256:x', delegateAccount: DELEGATE, signerId: 'sig', signerRequestId: 'r', signingPublicKey: 'ED00', keyAuthority: 'master-key', preparedDigest: 'sha256:p', delegationAssessmentDigest: 'sha256:a', delegationFactsDigest: 'sha256:f', referenceLedgerIndex: 100, referenceLedgerHash: 'B'.repeat(64), delegationLedgerIndex: 100, delegateRootLedgerIndex: 100, ownerRootLedgerIndex: 100, fee: '12', ledgerProvenance: 'injected-ledger-client' },
    ...overrides,
  };
}
const p11 = (terminal?: TradeRecoveryP11Record['terminal'], attempt: Partial<TradeRecoveryP11Record['attempt']> = {}): TradeRecoveryP11View => ({
  record: { attempt: { organizationId: 'org-acme', executionId: EXEC, requestId: 'req-1', decisionId: 'dec-1', boundedGrantId: 'grant-1', action: 'trade.offer-create', ...attempt }, ...(terminal !== undefined ? { terminal } : {}) },
});
const provider = (certainty: 'confirmed-completed' | 'confirmed-not-completed' | 'unconfirmed', providerRef?: string) => ({ observation: { kind: 'provider' as const, certainty, ...(providerRef !== undefined ? { providerRef } : {}) } });
const signer = (state: TradeSignerObservation['state'], extra: Record<string, unknown> = {}): TradeSignerObservation => ({ source: 'customer-signer-ledger', executionId: EXEC, state, ...(state === 'absent' || state === 'unavailable' ? {} : { capabilityId: 'cap-1' }), ...(state === 'signed' ? { transactionHash: HASH } : {}), ...extra }) as TradeSignerObservation;
const includedEvidence = (resultClass: 'tesSUCCESS' | 'tec'): TradeLedgerEvidence => ({ status: 'included', networkId: 1, transactionHash: HASH, engineResult: resultClass === 'tec' ? 'tecKILLED' : 'tesSUCCESS', resultClass, ledgerIndex: 110, ledgerHash: 'B'.repeat(64), validatedIndexBefore: 111, validatedIndexAfter: 112, transaction: {} });
const notIncluded: TradeLedgerEvidence = { status: 'not-included', networkId: 1, transactionHash: HASH, searchedFrom: 101, searchedTo: 120, validatedIndexBefore: 120, validatedIndexAfter: 121 };
const unresolved = (reason: Extract<TradeLedgerEvidence, { status: 'unresolved' }>['reason'], validatedIndexBefore = 105): TradeLedgerEvidence => ({ status: 'unresolved', reason, validatedIndexBefore });
const read = (record?: TradeSubmissionRecord) => ({ status: 'read' as const, record });

describe('TRADE-04D §3 — the twelve classes', () => {
  const cases: readonly [string, Parameters<typeof assessTradeRecovery>[0], (typeof TRADE_RECOVERY_CLASSES)[number], string][] = [
    ['1 no P11 claim, no row', { executionId: EXEC, interlock: read(), p11: { record: undefined } }, 'no-trade-record', 'proven'],
    ['1 no P11 claim; the signer agrees (absent): still proven by the Host — the signer’s report is consistent, not needed', { executionId: EXEC, interlock: read(), p11: { record: undefined }, signer: signer('absent') }, 'no-trade-record', 'proven'],
    ['1 claimed, no row, no signer report: Frontera never sent anything; signature unknown', { executionId: EXEC, interlock: read(), p11: p11(provider('confirmed-not-completed')) }, 'no-trade-record', 'indeterminate'],
    ['2 signer reports no consumption', { executionId: EXEC, interlock: read(), p11: p11(provider('confirmed-not-completed')), signer: signer('absent') }, 'capability-not-consumed', 'indeterminate'],
    ['3 consumed, no hash', { executionId: EXEC, interlock: read(), p11: p11(provider('confirmed-not-completed')), signer: signer('consumed') }, 'capability-consumed-unsigned', 'indeterminate'],
    ['3 signing-failed', { executionId: EXEC, interlock: read(), p11: p11(provider('confirmed-not-completed')), signer: signer('signing-failed') }, 'capability-consumed-unsigned', 'indeterminate'],
    ['4 signed, no row', { executionId: EXEC, interlock: read(), p11: p11(provider('confirmed-not-completed')), signer: signer('signed') }, 'signed-not-reserved', 'indeterminate'],
    ['5 reserved', { executionId: EXEC, interlock: read(row('reserved')), p11: p11(provider('unconfirmed', HASH)), ledger: unresolved('window-open') }, 'reserved-not-claimed', 'pending'],
    ['6 claimed', { executionId: EXEC, interlock: read(row('submitting')), p11: p11() }, 'submission-claimed', 'pending'],
    ['7 unconfirmed', { executionId: EXEC, interlock: read(row('unconfirmed')), p11: p11(provider('unconfirmed', HASH)), ledger: unresolved('window-open') }, 'submission-response-unknown', 'pending'],
    ['8 validated tesSUCCESS', { executionId: EXEC, interlock: read(row('unconfirmed')), p11: p11(provider('unconfirmed', HASH)), ledger: includedEvidence('tesSUCCESS') }, 'validated-success', 'proven'],
    ['9 validated tec', { executionId: EXEC, interlock: read(row('unconfirmed')), p11: p11(provider('unconfirmed', HASH)), ledger: includedEvidence('tec') }, 'validated-failure', 'proven'],
    ['10 proven not included', { executionId: EXEC, interlock: read(row('unconfirmed')), p11: p11(provider('unconfirmed', HASH)), ledger: notIncluded }, 'proven-not-included', 'proven'],
    ['10 settled malformed (tem submit answer), no fresh read', { executionId: EXEC, interlock: read(row('settled', 'malformed')), p11: p11(provider('confirmed-not-completed', HASH)) }, 'proven-not-included', 'proven'],
    ['11 timeout', { executionId: EXEC, interlock: read(row('unconfirmed')), p11: p11(provider('unconfirmed', HASH)), ledger: unresolved('read-timeout') }, 'indeterminate', 'indeterminate'],
    ['11 incomplete history', { executionId: EXEC, interlock: read(row('unconfirmed')), p11: p11(provider('unconfirmed', HASH)), ledger: unresolved('history-incomplete', 125) }, 'indeterminate', 'indeterminate'],
    ['11 interlock freshness unproven', { executionId: EXEC, interlock: { status: 'unavailable', reason: 'freshness-unproven' } }, 'indeterminate', 'indeterminate'],
    ['12 interlock corrupt', { executionId: EXEC, interlock: { status: 'unavailable', reason: 'corrupt' } }, 'inconsistent-evidence', 'refused'],
  ];
  for (const [name, input, klass, certainty] of cases) {
    it(name, () => {
      const assessment = assessTradeRecovery(input);
      assert.deepEqual([assessment.class, assessment.certainty], [klass, certainty]);
      assert.equal(assessment.automatedRecovery.permitted, false);
      assert.ok(assessment.automatedRecovery.refusals.includes('assessment-only'));
      assert.ok(Object.isFrozen(assessment));
    });
  }

  it('all twelve classes are reachable from the table above', () => {
    assert.deepEqual([...new Set(cases.map(([, , klass]) => klass))].sort(), [...TRADE_RECOVERY_CLASSES].sort());
  });
});

describe('TRADE-04D §3 — never inferred', () => {
  it('a signature is never inferred from a consumed capability; a submission never from a signature; delivery never from a claim', () => {
    assert.equal(assessTradeRecovery({ executionId: EXEC, interlock: read(), p11: p11(), signer: signer('consumed') }).signature, 'possible');
    assert.equal(assessTradeRecovery({ executionId: EXEC, interlock: read(), p11: p11(), signer: signer('signed') }).fronteraSubmission, 'never');
    const claimed = assessTradeRecovery({ executionId: EXEC, interlock: read(row('submitting')), p11: p11() });
    assert.equal(claimed.fronteraSubmission, 'claimed');
    assert.ok(claimed.uncertainties.includes('delivery-unknown'));
  });

  it('non-submission is never inferred from a missing response, and absence never from an incomplete search: the Sequence stays held', () => {
    const assessment = assessTradeRecovery({ executionId: EXEC, interlock: read(row('unconfirmed')), p11: p11(provider('unconfirmed', HASH)), ledger: unresolved('history-incomplete', 125) });
    assert.notEqual(assessment.class, 'proven-not-included');
    const open = assessTradeRecovery({ executionId: EXEC, interlock: read(row('unconfirmed')), p11: p11(provider('unconfirmed', HASH)), ledger: unresolved('window-open', 105) });
    assert.equal(open.sequence.status, 'blocked');
    assert.ok(open.automatedRecovery.refusals.includes('sequence-held-until-ledger-fact'));
    const unknown = assessTradeRecovery({ executionId: EXEC, interlock: read(row('unconfirmed')), p11: p11(provider('unconfirmed', HASH)) });
    assert.equal(unknown.sequence.status, 'unknown', 'no validated index read: never released');
  });

  it('a signed capability without a Host window: inclusion unprovable — the uncertainty is preserved, and the missing evidence named', () => {
    const assessment = assessTradeRecovery({ executionId: EXEC, interlock: read(), p11: p11(provider('confirmed-not-completed')), signer: signer('signed') });
    assert.ok(assessment.uncertainties.includes('inclusion-unprovable-without-window'));
    assert.ok(assessment.evidenceNeeded.includes('host-record-of-transaction-window'));
    assert.ok(assessment.automatedRecovery.refusals.includes('execution-already-attempted'));
    assert.ok(assessment.automatedRecovery.refusals.includes('signed-bytes-not-retained'));
  });

  it('a reserved row later found included: a ledger fact, flagged as included without Frontera’s claim', () => {
    const assessment = assessTradeRecovery({ executionId: EXEC, interlock: read(row('reserved')), p11: p11(provider('unconfirmed', HASH)), ledger: includedEvidence('tesSUCCESS') });
    assert.equal(assessment.class, 'validated-success');
    assert.ok(assessment.uncertainties.includes('included-without-frontera-claim'));
  });

  it('tesSUCCESS without an established offer state says so', () => {
    assert.ok(assessTradeRecovery({ executionId: EXEC, interlock: read(row('unconfirmed')), p11: p11(provider('unconfirmed', HASH)), ledger: includedEvidence('tesSUCCESS') }).uncertainties.includes('offer-state-not-established'));
  });

  it('the assessment reads no clock: elapsed time, capability expiry and grant revocation are not inputs', () => {
    const source = readFileSync('src/enterprise/xrpl-trade-execution/trade-recovery-assessment.ts', 'utf8');
    assert.equal(/Date\.now|new Date|performance\.now|\bnow\(|expiresAt|notAfter|revoked/.test(source.replace(/\/\*[\s\S]*?\*\//g, '')), false);
  });
});

describe('TRADE-04D §3 — contradictions are refused, never reconciled', () => {
  const contradictions: readonly [string, Parameters<typeof assessTradeRecovery>[0], string][] = [
    ['P11 names another hash', { executionId: EXEC, interlock: read(row('unconfirmed')), p11: p11(provider('unconfirmed', 'C'.repeat(64))) }, 'p11-reference-mismatch'],
    ['P11 names a hash, no trade record (a lost or rolled-back store)', { executionId: EXEC, interlock: read(), p11: p11(provider('unconfirmed', HASH)) }, 'p11-reference-without-trade-record'],
    ['a trade record with no P11 claim', { executionId: EXEC, interlock: read(row('reserved')), p11: { record: undefined } }, 'trade-record-without-p11-claim'],
    ['another grant / decision / request', { executionId: EXEC, interlock: read(row('reserved')), p11: p11(undefined, { boundedGrantId: 'grant-2' }) }, 'p11-identity-mismatch'],
    ['withheld at exercise, yet a trade record', { executionId: EXEC, interlock: read(row('reserved')), p11: p11({ observation: { kind: 'withheld' } }) }, 'withheld-execution-has-trade-record'],
    ['P11 completed, ledger proves not included', { executionId: EXEC, interlock: read(row('unconfirmed')), p11: p11(provider('confirmed-completed', HASH)), ledger: notIncluded }, 'p11-outcome-contradicts-ledger'],
    ['P12 resolved not-completed, ledger tesSUCCESS', { executionId: EXEC, interlock: read(row('unconfirmed')), p11: { ...p11(provider('unconfirmed', HASH)), resolution: { certainty: 'confirmed-not-completed' } }, ledger: includedEvidence('tesSUCCESS') }, 'p12-resolution-contradicts-ledger'],
    ['settled expired, ledger now shows inclusion', { executionId: EXEC, interlock: read(row('settled', 'expired')), p11: p11(provider('confirmed-not-completed', HASH)), ledger: includedEvidence('tec') }, 'settlement-contradicts-ledger'],
    ['the signer signed another hash', { executionId: EXEC, interlock: read(row('unconfirmed')), p11: p11(provider('unconfirmed', HASH)), signer: signer('signed', { transactionHash: 'C'.repeat(64) }) }, 'signer-hash-mismatch'],
    ['the signer (a stale restore) denies the signature the Host verified', { executionId: EXEC, interlock: read(row('unconfirmed')), p11: p11(provider('unconfirmed', HASH)), signer: signer('absent') }, 'signer-denies-host-verified-signature'],
    ['the signer reports another execution', { executionId: EXEC, interlock: read(row('unconfirmed')), signer: signer('signed', { executionId: 'aoc.exec:other' }) }, 'signer-execution-mismatch'],
    ['the signer reports a consumption for an execution P11 never claimed (not authorized by this Host)', { executionId: EXEC, interlock: read(), p11: { record: undefined }, signer: signer('consumed') }, 'signer-consumption-without-p11-claim'],
    ['a ledger answer that does not bind', { executionId: EXEC, interlock: read(row('unconfirmed')), p11: p11(provider('unconfirmed', HASH)), ledger: unresolved('wrong-account', 125) }, 'ledger-binding-mismatch'],
    ['the wrong network', { executionId: EXEC, interlock: read(row('unconfirmed')), p11: p11(provider('unconfirmed', HASH)), ledger: { status: 'unresolved', reason: 'network-mismatch' } }, 'ledger-binding-mismatch'],
  ];
  for (const [name, input, inconsistency] of contradictions) {
    it(name, () => {
      const assessment = assessTradeRecovery(input);
      assert.equal(assessment.class, 'inconsistent-evidence');
      assert.equal(assessment.certainty, 'refused');
      assert.ok(assessment.inconsistencies.includes(inconsistency as never), JSON.stringify(assessment.inconsistencies));
      assert.ok(assessment.automatedRecovery.refusals.includes('evidence-inconsistent'));
      assert.equal(assessment.existingPaths.includes('p12-reconcile'), false, 'no automated path is suggested over contradictory evidence');
    });
  }

  it('the signer’s report can add uncertainty, never remove it: "absent" does not close a reserved row, and its evidence is labelled non-authoritative', () => {
    const assessment = assessTradeRecovery({ executionId: EXEC, interlock: read(row('reserved')), p11: p11(provider('unconfirmed', HASH)), signer: signer('consumed'), ledger: unresolved('window-open') });
    assert.equal(assessment.class, 'reserved-not-claimed');
    assert.ok(assessment.uncertainties.includes('signer-evidence-not-authoritative'));
  });
});
