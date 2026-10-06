import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { Wallet } from 'xrpl';

import { DemoFailure } from '../contracts.js';
import { expectAlreadyRealized, expectCeilingWithholding, expectDestinationDenial, expectLinkedReconsideration, expectSameDecision, reconsiderationFailure } from '../expectations.js';
import { createPresenter } from '../presentation.js';
import { SecretExposureError, createSecretGuard } from '../secret-guard.js';

/** ANDREW-P0-11 — the harness's rules against the wrong answers a live run never produces. */

const decision = (status: string, reasonCodes: readonly string[], id = 'd-1') => ({ decisionId: id, evaluationId: `e-${id}`, status, reasonCodes });
const reply = (body: Record<string, unknown>) => ({ body });
const failsAs = (category: string, fn: () => unknown) =>
  assert.throws(fn, (error: unknown) => {
    assert.ok(error instanceof DemoFailure, String(error));
    assert.equal(error.category, category);
    return true;
  });

describe('ANDREW-P0-11 — expected blocks pass only with the exact expected reason', () => {
  it('A2: the destination-policy denial passes; any other denial, or an execution, fails', () => {
    assert.equal(expectDestinationDenial(reply({ status: 'denied', requestId: 'r', decision: decision('denied', ['DOMAIN_POLICY_DENIED', 'POLICY_ACTION_PROHIBITED']) })).status, 'denied');
    failsAs('UNEXPECTED DEMO ASSERTION FAILURE', () => expectDestinationDenial(reply({ status: 'denied', decision: decision('denied', ['AUTHORITY_INSUFFICIENT']) })));
    failsAs('UNEXPECTED DEMO ASSERTION FAILURE', () => expectDestinationDenial(reply({ status: 'indeterminate', decision: decision('indeterminate', ['DOMAIN_POLICY_DENIED']) })));
    failsAs('UNEXPECTED DEMO ASSERTION FAILURE', () => expectDestinationDenial(reply({ status: 'executed', decision: decision('allowed', ['ACTION_ALLOWED']) })));
  });
  it('A3/A10: a replay must carry the identical committed decision', () => {
    const original = reply({ status: 'denied', requestId: 'r', decision: decision('denied', ['DOMAIN_POLICY_DENIED']) });
    expectSameDecision(original, reply({ ...original.body }), 'A3');
    failsAs('UNEXPECTED DEMO ASSERTION FAILURE', () => expectSameDecision(original, reply({ ...original.body, decision: decision('denied', ['DOMAIN_POLICY_DENIED'], 'd-2') }), 'A3'));
    failsAs('UNEXPECTED DEMO ASSERTION FAILURE', () => expectSameDecision(original, reply({ ...original.body, requestId: 'other' }), 'A3'));
    failsAs('UNEXPECTED DEMO ASSERTION FAILURE', () => expectSameDecision(original, reply({ ...original.body, status: 'executed' }), 'A10'));
  });
  it('A5: the reconsideration must be linked to the denied original', () => {
    const lineage = { role: 'reconsideration', businessIntentId: 'aoc.intent:x', reason: 'destination-approved', reconsiders: { requestId: 'r-1', status: 'denied' } };
    expectLinkedReconsideration(lineage, 'r-1');
    failsAs('UNEXPECTED DEMO ASSERTION FAILURE', () => expectLinkedReconsideration(lineage, 'r-2'));
    failsAs('UNEXPECTED DEMO ASSERTION FAILURE', () => expectLinkedReconsideration({ ...lineage, reconsiders: { requestId: 'r-1', status: 'allowed' } }, 'r-1'));
    failsAs('UNEXPECTED DEMO ASSERTION FAILURE', () => expectLinkedReconsideration({}, 'r-1'));
  });
  it('A6/A7: a reconsideration that did not execute is classified, never passed', () => {
    assert.equal(reconsiderationFailure(reply({ status: 'denied' }), undefined).category, 'GOVERNANCE DENIAL');
    assert.equal(reconsiderationFailure(reply({ status: 'withheld' }), undefined).category, 'GOVERNANCE DENIAL');
    const attempt = (state: string) => ({ state, attempt: { transactionHash: 'H', sourceAccount: 's', destination: 'd', value: '10', currency: 'c', issuer: 'i' }, events: [] });
    assert.equal(reconsiderationFailure(reply({ status: 'failed' }), attempt('validated-tec')).category, 'XRPL VALIDATION FAILURE');
    assert.equal(reconsiderationFailure(reply({ status: 'unconfirmed' }), attempt('submit-uncertain')).category, 'XRPL SUBMISSION FAILURE');
    assert.equal(reconsiderationFailure(reply({ status: 'unconfirmed' }), attempt('unresolved')).category, 'XRPL SUBMISSION FAILURE');
  });
  it('A9: only ALREADY_REALIZED passes; a second execution fails', () => {
    expectAlreadyRealized(reply({ status: 'withheld', reasonCodes: ['GOVERNED_ACTION_RECONSIDERATION_ALREADY_REALIZED'] }));
    failsAs('UNEXPECTED DEMO ASSERTION FAILURE', () => expectAlreadyRealized(reply({ status: 'executed', reasonCodes: [] })));
    failsAs('UNEXPECTED DEMO ASSERTION FAILURE', () => expectAlreadyRealized(reply({ status: 'withheld', reasonCodes: ['GOVERNED_ACTION_RECONSIDERATION_TARGET_NOT_WITHHELD'] })));
  });
  it('B: only an allowed decision withheld by authority-binding for exactly the ceiling passes', () => {
    const ok = { status: 'withheld', withheldBy: 'authority-binding', reasonCodes: ['FINANCIAL_AUTHORITY_CEILING_EXCEEDED'], decision: decision('allowed', ['ACTION_ALLOWED']) };
    expectCeilingWithholding(reply(ok));
    for (const wrong of [
      { ...ok, reasonCodes: ['FINANCIAL_AUTHORITY_ASSET_MISMATCH'] },
      { ...ok, reasonCodes: ['FINANCIAL_AUTHORITY_CEILING_EXCEEDED', 'OTHER'] },
      { ...ok, withheldBy: 'grant' },
      { ...ok, decision: decision('denied', ['DOMAIN_POLICY_DENIED']) },
      { ...ok, status: 'executed' },
      { ...ok, executionId: 'aoc.exec:x' },
      { ...ok, providerRef: 'HASH' },
    ]) {
      failsAs('UNEXPECTED DEMO ASSERTION FAILURE', () => expectCeilingWithholding(reply(wrong)));
    }
  });
});

describe('ANDREW-P0-11 — the secret guard', () => {
  it('refuses registered secrets and secret shapes, without echoing them', () => {
    const guard = createSecretGuard();
    const wallet = Wallet.generate();
    guard.register('frontera-andrew-agent-0123456789abcdef');
    assert.equal(guard.check('agent-1 requested 10 RLUSD'), 'agent-1 requested 10 RLUSD');
    for (const text of [`seed ${String(wallet.seed)}`, 'credential frontera-andrew-agent-0123456789abcdef', `-----BEGIN ${'PRIVATE'} KEY-----`, `blob ${'12'.repeat(150)}`]) {
      assert.throws(
        () => guard.check(text),
        (error: unknown) => error instanceof SecretExposureError && !error.message.includes(String(wallet.seed)) && !error.message.includes('0123456789abcdef'),
      );
    }
  });
  it('the presenter never writes a line the guard refuses', () => {
    const lines: string[] = [];
    const present = createPresenter((line) => lines.push(line), createSecretGuard());
    const seed = String(Wallet.generate().seed);
    assert.throws(() => present.fact('Treasury', seed), SecretExposureError);
    assert.throws(() => present.line(`x ${seed}`), SecretExposureError);
    assert.equal(lines.some((line) => line.includes(seed)), false);
  });
});
