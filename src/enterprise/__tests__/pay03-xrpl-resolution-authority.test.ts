import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { EXECUTION_FAILURE_REASONS } from '../../features/execution-runtime/index.js';
import type { PaymentExecutionRequest } from '../../features/payment-runtime/index.js';
import { createXrplRlusdRail } from '../../features/payment-runtime/rails/xrpl/index.js';
import { GOVERNED_ACCOUNT, RLUSD_ASSET, TREASURY, VENDOR, createTestSoftwareXrplSigner, testClock, testConfiguration } from '../../features/payment-runtime/rails/xrpl/tests/xrpl-test-fixtures.js';
import type { ExecutionResolutionQuery } from '../execution-reconciliation/authority.js';
import { normalizeResolutionAnswer } from '../execution-reconciliation/authority.js';
import { createSqliteXrplSubmissionInterlock, type DurableXrplSubmissionInterlock } from '../xrpl-payment-rail/sqlite-xrpl-submission-interlock.js';
import { XRPL_RESOLUTION_AUTHORITY_ID, createXrplResolutionAuthority, readOnlyXrplLedger } from '../xrpl-payment-rail/xrpl-resolution-authority.js';
import { createLedgerSimulator, scratch, type LedgerSimulator, type SimulatedOutcome } from './pay03-xrpl-fixture.js';

/**
 * PAY-03 — the read-only P12 XRPL resolution authority (R1–R10). Every
 * scenario starts from a real unconfirmed payment made by the real rail and
 * recorded by the real interlock, then lets the ledger decide.
 */

const tmp = scratch('frontera-pay03-resolver-');
after(() => tmp.cleanup());

const CONFIGURATION = testConfiguration({ sourceAccounts: [{ accountId: GOVERNED_ACCOUNT, address: TREASURY.classicAddress }], finalityTimeoutMs: 5_000, pollIntervalMs: 1_000 });

let counter = 0;
function request(): PaymentExecutionRequest {
  counter += 1;
  return {
    executionId: `aoc.exec:pay03-resolve-${counter}`,
    requestId: `req-${counter}`,
    decisionId: `dec-${counter}`,
    grantId: `grant-${counter}`,
    notAfter: '2030-01-01T00:00:00.000Z',
    source: { accountId: GOVERNED_ACCOUNT },
    destination: { kind: 'xrpl-account', reference: VENDOR.classicAddress },
    amount: { value: '40.25', unit: RLUSD_ASSET },
    purpose: 'vendor-payment',
    rail: 'xrpl-rlusd',
  };
}

interface Unconfirmed {
  readonly ledger: LedgerSimulator;
  readonly store: DurableXrplSubmissionInterlock;
  readonly query: ExecutionResolutionQuery;
  readonly hash: string;
  readonly lastLedgerSequence: number;
}

/** A real unconfirmed payment: the rail submitted once and saw no validated answer by its deadline. */
async function unconfirmed(eventual: SimulatedOutcome = 'pending'): Promise<Unconfirmed> {
  const ledger = createLedgerSimulator();
  ledger.nextOutcome = eventual;
  const store = await createSqliteXrplSubmissionInterlock(join(tmp.dir(), 'interlock.sqlite'), { scope: { railId: CONFIGURATION.railId, networkId: CONFIGURATION.networkId }, now: () => new Date().toISOString() });
  const rail = createXrplRlusdRail({ configuration: CONFIGURATION, client: ledger, signers: [createTestSoftwareXrplSigner(TREASURY)], interlock: store, ...testClock() });
  await rail.readiness();
  ledger.index += CONFIGURATION.lastLedgerOffset + 4;
  // The rail's own finality loop sees "pending" whatever the eventual outcome; the ledger decides only afterwards.
  const lookup = ledger.lookupTransaction.bind(ledger);
  let railReading = true;
  ledger.lookupTransaction = async (query, timeoutMs) => (railReading ? { hash: query.hash, validated: false } : lookup(query, timeoutMs));
  const req = request();
  const outcome = await rail.execute(req);
  assert.equal(outcome.status, 'unconfirmed');
  railReading = false;
  const hash = (outcome as { externalReference: string }).externalReference;
  const record = (await store.read(req.executionId))!;
  return {
    ledger,
    store,
    hash,
    lastLedgerSequence: record.lastLedgerSequence,
    query: Object.freeze({ organizationId: 'org-pay03', executionId: req.executionId, evaluationId: 'eval', requestId: req.requestId, decisionId: req.decisionId, boundedGrantId: req.grantId, action: 'payment.execute', amount: { value: '40.25', unit: RLUSD_ASSET }, providerRef: hash, basis: 'initial-observation-unconfirmed' }),
  };
}

function authorityFor(u: Unconfirmed) {
  return createXrplResolutionAuthority({ configuration: CONFIGURATION, ledger: readOnlyXrplLedger(u.ledger), interlock: u.store });
}

describe('PAY-03 XRPL resolution qualification (R1–R10)', () => {
  it('R1: validated tesSUCCESS delivering exactly the recorded amount → confirmed-completed, with the hash; the record settles', async () => {
    const u = await unconfirmed('success');
    const answer = await authorityFor(u).resolve(u.query);
    assert.deepEqual(answer, { outcome: 'resolved', certainty: 'confirmed-completed', providerRef: u.hash });
    assert.deepEqual(normalizeResolutionAnswer(answer), answer, 'inside P12’s closed answer');
    assert.deepEqual([(await u.store.read(u.query.executionId))?.state, (await u.store.read(u.query.executionId))?.settlement], ['settled', 'validated-success']);
    await u.store.close();
  });

  it('R2: validated tec failure → confirmed-not-completed PROVIDER_REJECTED', async () => {
    const u = await unconfirmed('tec');
    assert.deepEqual(await authorityFor(u).resolve(u.query), { outcome: 'resolved', certainty: 'confirmed-not-completed', failure: EXECUTION_FAILURE_REASONS.PROVIDER_REJECTED, providerRef: u.hash });
    await u.store.close();
  });

  it('R3: proven expiry — not found over the full window, complete history, validated index at LastLedgerSequence → confirmed-not-completed', async () => {
    const u = await unconfirmed('dropped');
    u.ledger.index = u.lastLedgerSequence - 1;
    assert.deepEqual(await authorityFor(u).resolve(u.query), { outcome: 'unresolved' }, 'one ledger early is not proof');
    u.ledger.index = u.lastLedgerSequence;
    assert.deepEqual(await authorityFor(u).resolve(u.query), { outcome: 'resolved', certainty: 'confirmed-not-completed', failure: EXECUTION_FAILURE_REASONS.PROVIDER_REJECTED, providerRef: u.hash });
    assert.equal((await u.store.read(u.query.executionId))?.settlement, 'expired');
    await u.store.close();
  });

  it('R4: the transaction is still pending → unresolved; the record stays open', async () => {
    const u = await unconfirmed('pending');
    assert.deepEqual(await authorityFor(u).resolve(u.query), { outcome: 'unresolved' });
    assert.equal((await u.store.read(u.query.executionId))?.state, 'unconfirmed');
    await u.store.close();
  });

  it('R5: not found, but the server lacks complete history (searched_all false) → unresolved even after the window', async () => {
    const u = await unconfirmed('dropped');
    u.ledger.searchedAll = false;
    u.ledger.index = u.lastLedgerSequence + 50;
    assert.deepEqual(await authorityFor(u).resolve(u.query), { outcome: 'unresolved' });
    await u.store.close();
  });

  it('R6: network unavailable, or a server on another network → unresolved', async () => {
    const u = await unconfirmed('success');
    u.ledger.unavailable = true;
    assert.deepEqual(await authorityFor(u).resolve(u.query), { outcome: 'unresolved' });
    u.ledger.unavailable = false;
    u.ledger.networkId = 0;
    assert.deepEqual(await authorityFor(u).resolve(u.query), { outcome: 'unresolved' });
    await u.store.close();
  });

  it('R7: a malformed provider response → unresolved', async () => {
    const u = await unconfirmed('success');
    u.ledger.malformedLookups = true;
    assert.deepEqual(await authorityFor(u).resolve(u.query), { outcome: 'unresolved' });
    await u.store.close();
  });

  it('R8: validated success but a delivered amount other than the recorded one → unresolved, never completed', async () => {
    const u = await unconfirmed('delivered-mismatch');
    assert.deepEqual(await authorityFor(u).resolve(u.query), { outcome: 'unresolved' });
    await u.store.close();
  });

  it('R9: delivered in the wrong issuer → unresolved; and a P11 attempt that disagrees with the record (hash, asset, amount) → unresolved', async () => {
    const u = await unconfirmed('wrong-issuer');
    assert.deepEqual(await authorityFor(u).resolve(u.query), { outcome: 'unresolved' });
    await u.store.close();
    const v = await unconfirmed('success');
    for (const query of [
      { ...v.query, providerRef: 'A'.repeat(64) },
      { ...v.query, amount: { value: '40.26', unit: RLUSD_ASSET } },
      { ...v.query, amount: { value: '40.25', unit: 'USD' } },
      { ...v.query, executionId: 'aoc.exec:never-recorded' },
    ]) {
      assert.deepEqual(await authorityFor(v).resolve(query), { outcome: 'unresolved' });
    }
    assert.equal((await v.store.read(v.query.executionId))?.state, 'unconfirmed', 'nothing settled on a mismatched query');
    // Absence is never evidence: no record (even with a hash P11 kept) is unresolved, never "not completed".
    const { providerRef: _ignored, ...withoutReference } = v.query;
    void _ignored;
    assert.deepEqual(await authorityFor(v).resolve({ ...withoutReference, executionId: 'aoc.exec:crashed-before-reserve', basis: 'no-initial-observation' }), { outcome: 'unresolved' });
    await v.store.close();
  });

  it('R10: the resolver makes zero submissions and zero preparations; its ledger capability has no write at all', async () => {
    const u = await unconfirmed('success');
    const submits = u.ledger.calls.submit;
    const autofills = u.ledger.calls.autofill;
    const reader = readOnlyXrplLedger(u.ledger);
    assert.deepEqual(Object.keys(reader).sort(), ['connect', 'lookupTransaction', 'serverInfo', 'validatedLedgerIndex']);
    assert.equal(Object.isFrozen(reader), true);
    for (let i = 0; i < 3; i += 1) await authorityFor(u).resolve(u.query);
    assert.equal(u.ledger.calls.submit, submits);
    assert.equal(u.ledger.calls.autofill, autofills);
    assert.equal(authorityFor(u).authorityId, XRPL_RESOLUTION_AUTHORITY_ID);
    // Structurally: the authority's source names no write capability.
    const source = readFileSync('src/enterprise/xrpl-payment-rail/xrpl-resolution-authority.ts', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    for (const forbidden of [/\.submit\s*\(/, /\.autofill\s*\(/, /\bsign\s*\(/, /createXrplSdkClient/, /createXrplRlusdRail/, /signers?\b/]) assert.equal(forbidden.test(source), false, String(forbidden));
    await u.store.close();
  });
});
