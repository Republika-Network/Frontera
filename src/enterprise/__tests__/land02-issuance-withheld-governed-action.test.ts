import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createInMemoryEmergencyControlStore } from '../../features/emergency-control-runtime/index.js';
import { createMonetaryAssetRegistry } from '../../features/monetary-runtime/index.js';
import { authorityTraceVerificationOf, buildAuthorityTrace } from '../evidence/trace-builder.js';
import { AUDITOR_DISCLOSURE_POLICY_V2, PARTNER_DISCLOSURE_POLICY_V2, compareDisclosedTraces, discloseAuthorityTrace } from '../evidence/trace-disclosure.js';
import { FINANCIAL_AUTHORITY_REASON_CODES as F } from '../execution-governance/index.js';
import type { GovernanceRecord } from '../governance-store/contracts.js';
import { createInMemoryGovernanceStore } from '../governance-store/in-memory-governance-store.js';
import { createExecutionLedger } from '../governed-action/execution-ledger.js';
import { issuanceWithheldReferenceId } from '../governed-action/identifiers.js';
import { issuanceWithheldDigest, issuanceWithheldUri, issuanceWithheldVersion, parseIssuanceWithheldRow, type IssuanceWithheldEvidence } from '../governed-action/issuance-record.js';
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
    assert.equal(row.referenceId, issuanceWithheldReferenceId({ evaluationId: record.evaluation.evaluationId, version: row.externalVersion ?? '', ceiling: { value: '100', unit: 'USD' } }));
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

/** The ASSURE-01 trace over the world's own Governance Store, and its verification. */
async function traceOf(world: GovernedWorld, requestId: string) {
  const build = await buildAuthorityTrace({ governance: world.rawStore }, { system: true }, requestId);
  assert.ok(build !== null);
  return { ...build, verification: authorityTraceVerificationOf(build, NOW) };
}
const issuanceChecks = (checks: readonly { readonly check: string; readonly status: string }[]) => checks.filter((entry) => entry.check.startsWith('issuance.'));

/** One over-ceiling request withheld in `world`: its evaluation, its parsed issuance row, and the world's ledger. */
async function withheldOnceFor(world: GovernedWorld) {
  const result = await world.orchestrator.govern(IDENTITY, OVER);
  const record = await recordFor(world, result.requestId ?? '');
  const first = parseIssuanceWithheldRow(issuanceRows(record)[0] ?? { externalId: '' });
  assert.ok(first !== undefined);
  return { world, requestId: result.requestId ?? '', evaluationId: record.evaluation.evaluationId, first, ledger: createExecutionLedger(world.rawStore, { system: true }, () => NOW) };
}

/** A financial world whose one recognized asset is `assetId`, with its ceiling of 100 in that asset. */
const assetWorld = (assetId: string, options: WorldOptions = {}): GovernedWorld =>
  buildGovernedWorld({
    monetary: { ...DRAFTING_IS_FINANCIAL, assets: createMonetaryAssetRegistry([{ assetId, scale: 2 }]) },
    financialAuthority: monetaryAuthority('100', undefined, assetId),
    ...options,
  });

/** Everything the product accepts is recorded: the evidence grammar is never stricter than the contracts it records. */
describe('LAND-02 — issuance evidence records every identifier the product accepts', () => {
  async function assertRecordedAndTraced(world: GovernedWorld, intent: typeof OVER, expected: { readonly unit: string; readonly decisionId?: string }): Promise<void> {
    const result = await world.orchestrator.govern(IDENTITY, intent);
    assert.equal(result.status, 'withheld', JSON.stringify(result));
    assert.deepEqual([...result.reasonCodes], [F.FINANCIAL_AUTHORITY_CEILING_EXCEEDED]);
    assert.equal(result.decision?.status, 'allowed', 'the product accepted the request and the Kernel allowed it');
    if (expected.decisionId !== undefined) assert.equal(result.decision?.decisionId, expected.decisionId, 'the decision committed under its own id');
    assert.equal(world.adapter.callCount, 0);
    const record = await recordFor(world, result.requestId ?? '');
    const [row, ...rest] = issuanceRows(record);
    assert.ok(row !== undefined, 'the issuance row was written');
    assert.deepEqual(rest, []);
    assert.deepEqual(parseIssuanceWithheldRow(row), {
      requestId: result.requestId,
      decisionId: result.decision?.decisionId,
      withheldBy: 'authority-binding',
      reasonCodes: [F.FINANCIAL_AUTHORITY_CEILING_EXCEEDED],
      requested: { value: intent.amount.value, unit: expected.unit },
      ceiling: { value: '100', unit: expected.unit },
    });
    const { trace, verification } = await traceOf(world, result.requestId ?? '');
    assert.equal(verification.verified, true, JSON.stringify(verification.checks.filter((entry) => entry.status === 'fail')));
    assert.ok(issuanceChecks(verification.checks).length > 0 && issuanceChecks(verification.checks).every((entry) => entry.status !== 'fail'));
    assert.equal(trace.stages.authority.issuance?.withheldBy, 'authority-binding');
    assert.deepEqual(trace.stages.authority.issuance?.ceiling, { value: '100', unit: expected.unit });
  }

  it('a canonical asset id with an underscore (token_USD)', async () => {
    await assertRecordedAndTraced(assetWorld('token_USD'), { ...OVER, amount: { value: '125', currency: 'token_USD' } }, { unit: 'token_USD' });
  });

  it('a canonical asset id at the canonical maximum length (128)', async () => {
    const longest = `A${'b'.repeat(126)}_`;
    assert.equal(longest.length, 128);
    await assertRecordedAndTraced(assetWorld(longest), { ...OVER, amount: { value: '125', currency: longest } }, { unit: longest });
  });

  it('an opaque Kernel decision id carrying `/`, a space, `;`, `=` and `%`', async () => {
    const decisionId = 'tenant/decision 1;x=%';
    await assertRecordedAndTraced(financialWorld({ kernelOverride: (result) => ({ ...result, decisionId, trace: { ...result.trace, decisionId } }) }), OVER, { unit: 'USD', decisionId });
  });

  it('a simple USD request is unchanged: the same row as before the hardening', async () => {
    await assertRecordedAndTraced(financialWorld(), OVER, { unit: 'USD' });
  });
});

describe('LAND-02 — a replay that meets a different withholding extends the evidence; it never contradicts it', () => {
  const withheldOnce = () => withheldOnceFor(financialWorld());
  const audited = async (world: GovernedWorld, requestId: string) => discloseAuthorityTrace((await traceOf(world, requestId)).trace, AUDITOR_DISCLOSURE_POLICY_V2);

  it('the same layer and code under a changed ceiling is a new fact: recorded, not taken for the earlier row', async () => {
    const { world, requestId, evaluationId, first, ledger } = await withheldOnce();
    const sealed = await audited(world, requestId);
    const raised: IssuanceWithheldEvidence = { ...first, ceiling: { value: '110', unit: 'USD' } };
    assert.equal(await ledger.recordIssuanceWithheld(evaluationId, raised), true);
    assert.equal(await ledger.recordIssuanceWithheld(evaluationId, raised), true, 'and the same fact again is the same row');
    const rows = issuanceRows(await recordFor(world, requestId));
    assert.deepEqual(rows.map((row) => parseIssuanceWithheldRow(row)), [first, raised]);
    const { trace, verification } = await traceOf(world, requestId);
    assert.equal(verification.verified, true, JSON.stringify(verification.checks.filter((entry) => entry.status === 'fail')));
    assert.deepEqual(trace.stages.authority.issuance?.records.map((entry) => entry.ceiling), [{ value: '100', unit: 'USD' }, { value: '110', unit: 'USD' }]);
    assert.deepEqual(trace.stages.authority.issuance?.ceiling, { value: '100', unit: 'USD' }, 'the stage still states the first withholding');
    assert.equal(compareDisclosedTraces(sealed, await audited(world, requestId)).result, 'progressed');
  });

  it('an emergency stop, then — once cleared — the ceiling: the trace sealed after the first still verifies, as progress', async () => {
    const emergencyControl = createInMemoryEmergencyControlStore();
    emergencyControl.activate({ scope: 'global', issuerRef: 'operator-1', declaredAt: NOW });
    const world = financialWorld({ emergencyControl });
    const stopped = await world.orchestrator.govern(IDENTITY, OVER);
    assert.equal(stopped.status === 'withheld' ? stopped.withheldBy : undefined, 'emergency-control');
    const requestId = stopped.requestId ?? '';
    const sealed = await audited(world, requestId);
    emergencyControl.release({ scope: 'global', issuerRef: 'operator-1', releasedAt: NOW });
    const replay = await world.orchestrator.govern(IDENTITY, OVER);
    assert.equal(replay.status === 'withheld' ? replay.withheldBy : undefined, 'authority-binding');
    assert.deepEqual([...replay.reasonCodes], [F.FINANCIAL_AUTHORITY_CEILING_EXCEEDED]);
    assert.equal(world.adapter.callCount, 0);
    const { trace, verification } = await traceOf(world, requestId);
    assert.equal(verification.verified, true, JSON.stringify(verification.checks.filter((entry) => entry.status === 'fail')));
    assert.deepEqual(trace.stages.authority.issuance?.records.map((entry) => entry.withheldBy), ['emergency-control', 'authority-binding']);
    assert.equal(trace.stages.authority.issuance?.withheldBy, 'emergency-control', 'the stage still states the first withholding');
    assert.equal(compareDisclosedTraces(sealed, await audited(world, requestId)).result, 'progressed');
  });
});

describe('LAND-02 — rows written by the original LAND-02 commit still verify', () => {
  it('a ceiling row whose identity covered only the layer and codes verifies; a row under any other identity does not', async () => {
    // The evidence write is faulted, so the evaluation holds no issuance row — then the original commit's row is placed beside it.
    const world = financialWorld({ storeFault: { appendReferenceFor: ['issuance_record'] } });
    const result = await world.orchestrator.govern(IDENTITY, OVER);
    const record = await recordFor(world, result.requestId ?? '');
    assert.deepEqual(issuanceRows(record), []);
    const evaluationId = record.evaluation.evaluationId;
    const evidence: IssuanceWithheldEvidence = {
      requestId: result.requestId ?? '',
      decisionId: result.decision?.decisionId ?? '',
      withheldBy: 'authority-binding',
      reasonCodes: [F.FINANCIAL_AUTHORITY_CEILING_EXCEEDED],
      requested: { value: '125', unit: 'USD' },
      ceiling: { value: '100', unit: 'USD' },
    };
    const version = issuanceWithheldVersion(evidence);
    const row = (referenceId: string) => ({ referenceId, evaluationId, referenceType: 'issuance_record' as const, externalId: evidence.requestId, externalVersion: version, uri: issuanceWithheldUri(evidence), digest: issuanceWithheldDigest(evidence), createdAt: NOW });
    await world.rawStore.appendReference({ system: true }, row(issuanceWithheldReferenceId({ evaluationId, version })));
    const legacy = await traceOf(world, result.requestId ?? '');
    assert.equal(legacy.verification.verified, true, JSON.stringify(legacy.verification.checks.filter((entry) => entry.status === 'fail')));
    assert.deepEqual(legacy.trace.stages.authority.issuance?.ceiling, { value: '100', unit: 'USD' });

    await world.rawStore.appendReference({ system: true }, row('aoc.gar.ref:land02-not-a-derived-identity'));
    const forged = await traceOf(world, result.requestId ?? '');
    assert.equal(forged.checks.find((entry) => entry.check === 'issuance.record-well-formed')?.status, 'fail');
  });
});

describe('LAND-02 — a PARTNER trace never carries the amounts its policy hides', () => {
  it('the requested amount and the ceiling are stripped from the issuance evidence below the parameter-visible levels', async () => {
    const { world, requestId } = await withheldOnceFor(financialWorld());
    const { trace } = await traceOf(world, requestId);
    assert.deepEqual((discloseAuthorityTrace(trace, AUDITOR_DISCLOSURE_POLICY_V2).stages['authority'] as Record<string, unknown> | undefined)?.['issuance'], trace.stages.authority.issuance, 'an auditor sees everything');
    assert.ok(PARTNER_DISCLOSURE_POLICY_V2.hiddenFields.includes('trace.parameters') && !PARTNER_DISCLOSURE_POLICY_V2.hiddenFields.includes('trace.authority'));
    const partner = discloseAuthorityTrace(trace, PARTNER_DISCLOSURE_POLICY_V2).stages['authority'] as Record<string, unknown> | undefined;
    const issuance = partner?.['issuance'] as Record<string, unknown> | undefined;
    assert.ok(issuance !== undefined, 'the withholding itself stays visible');
    assert.equal(issuance['withheldBy'], 'authority-binding');
    assert.deepEqual(issuance['reasonCodes'], [F.FINANCIAL_AUTHORITY_CEILING_EXCEEDED]);
    const text = JSON.stringify(issuance);
    assert.equal(/"requested"|"ceiling"|"125"|"100"/.test(text), false, text);
  });
});
