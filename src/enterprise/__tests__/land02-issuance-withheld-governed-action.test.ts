import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { FINANCIAL_AUTHORITY_REASON_CODES as F } from '../execution-governance/index.js';
import type { GovernanceRecord } from '../governance-store/contracts.js';
import { createInMemoryGovernanceStore } from '../governance-store/in-memory-governance-store.js';
import { createExecutionLedger } from '../governed-action/execution-ledger.js';
import { issuanceWithheldReferenceId } from '../governed-action/identifiers.js';
import { parseIssuanceWithheldRow } from '../governed-action/issuance-record.js';
import { ALLOWED_INTENT, DRAFTING_IS_FINANCIAL, IDENTITY, NOW, ORG, buildGovernedWorld, monetaryAuthority, type GovernedWorld, type WorldOptions } from './governed-action-support.js';

/**
 * LAND-02 — durable issuance-withheld evidence on the canonical governed-action
 * path, measured on the real Kernel, the real issuance core and a recording
 * adapter. The Kernel allows; issuance withholds; the withholding is written
 * as one evidence row — and the answer never depends on whether it was.
 */

const OVER = { ...ALLOWED_INTENT, amount: { value: '125', currency: 'USD' }, idempotencyKey: 'land02-over' };
const UNDER = { ...ALLOWED_INTENT, amount: { value: '75', currency: 'USD' }, idempotencyKey: 'land02-under' };
const financialWorld = (options: WorldOptions = {}): GovernedWorld => buildGovernedWorld({ monetary: DRAFTING_IS_FINANCIAL, financialAuthority: monetaryAuthority('100'), ...options });

async function recordFor(world: GovernedWorld, requestId: string): Promise<GovernanceRecord> {
  const record = await world.rawStore.getByRequestId({ system: false, organizationId: ORG }, requestId);
  assert.ok(record !== null);
  return record;
}
const issuanceRows = (record: GovernanceRecord) => record.references.filter((entry) => entry.referenceType === 'issuance_record');

describe('LAND-02 — the Kernel allows, issuance withholds, and the withholding is durable evidence', () => {
  it('a bounded value above the authority ceiling: allowed, withheld, no grant, no adapter — and one issuance row carrying the ceiling', async () => {
    const w = financialWorld();
    const result = await w.orchestrator.govern(IDENTITY, OVER);
    assert.equal(result.status, 'withheld');
    assert.equal(result.status === 'withheld' ? result.withheldBy : undefined, 'authority-binding');
    assert.deepEqual([...result.reasonCodes], [F.FINANCIAL_AUTHORITY_CEILING_EXCEEDED]);
    assert.equal(result.decision?.status, 'allowed', 'the Kernel permitted the action');
    assert.equal(w.adapter.callCount, 0);
    assert.equal(w.issueOutcomes.length, 0, 'no grant was ever attempted');

    const record = await recordFor(w, result.requestId ?? '');
    assert.equal(record.evaluation.status, 'allowed', 'the committed decision is the Kernel’s own, never rewritten');
    assert.deepEqual(record.references.filter((entry) => entry.referenceType !== 'issuance_record'), [], 'no authorization or execution row');
    const [row, ...rest] = issuanceRows(record);
    assert.ok(row !== undefined);
    assert.deepEqual(rest, []);
    assert.equal(row.referenceId, issuanceWithheldReferenceId({ evaluationId: record.evaluation.evaluationId, version: row.externalVersion ?? '' }));
    assert.deepEqual(parseIssuanceWithheldRow(row), {
      requestId: result.requestId,
      decisionId: result.decision?.decisionId,
      withheldBy: 'authority-binding',
      reasonCodes: [F.FINANCIAL_AUTHORITY_CEILING_EXCEEDED],
      requested: { value: '125', unit: 'USD' },
      ceiling: { value: '100', unit: 'USD' },
    });
  });

  it('the answer does not depend on the evidence: an evidence-write failure leaves the withheld response byte-identical', async () => {
    const healthy = await financialWorld().orchestrator.govern(IDENTITY, OVER);
    const failing = financialWorld({ storeFault: { appendReferenceFor: ['issuance_record'] } });
    const result = await failing.orchestrator.govern(IDENTITY, OVER);
    // Two independent worlds: only the store-minted evaluation id may differ.
    const sameEvaluation = (value: typeof result) => ({ ...value, decision: { ...value.decision, evaluationId: 'normalized' } });
    assert.deepEqual(sameEvaluation(result), sameEvaluation(healthy), 'WITHHELD stays WITHHELD — never ERROR');
    assert.equal(result.status, 'withheld');
    assert.equal(failing.adapter.callCount, 0);
    assert.deepEqual(issuanceRows(await recordFor(failing, result.requestId ?? '')), [], 'nothing was written, and nothing else changed');
  });

  it('the ledger never throws: a store that refuses the row reports false, and malformed evidence is never written', async () => {
    const store = createInMemoryGovernanceStore();
    const refusing = { ...store, appendReference: async () => Promise.reject(new Error('injected')), getByEvaluationId: async () => Promise.reject(new Error('injected')) };
    const evidence = { requestId: 'aoc.gar:0123456789abcdef0123456789abcdef', decisionId: 'decision-1', withheldBy: 'grant', reasonCodes: ['GRANT_OBLIGATIONS_UNSATISFIED'] };
    assert.equal(await createExecutionLedger(refusing, { system: true }, () => NOW).recordIssuanceWithheld('evaluation-1', evidence), false);
    assert.equal(await createExecutionLedger(store, { system: true }, () => NOW).recordIssuanceWithheld('evaluation-1', { ...evidence, reasonCodes: [] }), false);
  });

  it('a replay of the same withheld request re-runs the gates and records the identical outcome once', async () => {
    const w = financialWorld();
    const first = await w.orchestrator.govern(IDENTITY, OVER);
    const again = await w.orchestrator.govern(IDENTITY, OVER);
    assert.equal(again.status, 'withheld');
    assert.deepEqual([...again.reasonCodes], [...first.reasonCodes]);
    assert.equal(issuanceRows(await recordFor(w, first.requestId ?? '')).length, 1);
    assert.equal(w.adapter.callCount, 0);
  });

  it('a value within the ceiling executes exactly as before: one grant, one adapter call, and no issuance row', async () => {
    const w = financialWorld();
    const result = await w.orchestrator.govern(IDENTITY, UNDER);
    assert.equal(result.status, 'executed');
    assert.equal(w.adapter.callCount, 1);
    const record = await recordFor(w, result.requestId ?? '');
    assert.deepEqual(issuanceRows(record), []);
    assert.ok(record.references.some((entry) => entry.referenceType === 'authorization_artifact'));
  });

  it('a Kernel denial is not an issuance withholding: it writes no issuance row', async () => {
    const w = financialWorld({ kernelOverride: (result) => ({ ...result, status: 'denied', reasonCodes: ['DOMAIN_POLICY_DENIED'] }) });
    const result = await w.orchestrator.govern(IDENTITY, OVER);
    assert.equal(result.status, 'denied');
    assert.deepEqual(issuanceRows(await recordFor(w, result.requestId ?? '')), []);
  });
});
