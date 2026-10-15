import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { boundedGrantId } from '../../features/grant-runtime/index.js';
import { EnterpriseHttpError } from '../api/enterprise-http-errors.js';
import { AuthorityStateFreshnessError, type AuthorityStateFreshnessErrorCode } from '../authority-state-freshness/errors.js';
import { createAuthorityAdministrationService } from '../authority-administration/service.js';
import { bootEnterpriseHost } from '../host/enterprise-host.js';
import { freshnessEnv, startWitness } from './core07-freshness-fixture.js';
import { AUTH, bootstrapOrganization, call, capturingLogger, createWorkspace, ctrl02Env, expectStatus, govern, onboardAgent, recordingAdapter, transfer } from './ctrl02-host-fixture.js';

/**
 * PROD-03 (found by the clean-room pilot drill) — revoking a bounded grant
 * while the CORE-07 witness is unreachable.
 *
 * The revocation is a witness-anchored transition: the witness must prepare
 * it before the local write. When it cannot, nothing is written. Before
 * PROD-03 the administration API turned that into `500 INFRASTRUCTURE_FAILURE`
 * — "an unexpected failure", leaving an operator in an incident unable to
 * tell whether the grant was revoked. It now answers what is true:
 * `503 AUTHORITY_STATE_UNAVAILABLE`, `failure: AUTHORITY_FRESHNESS_UNAVAILABLE`,
 * `recorded: false`, and the grant is still active; any other freshness code
 * (rollback, fork, pending recovery) is an integrity condition, never an
 * outage.
 */

const ADMIN_SECRET = 'PROD03_UNIT_ADMIN_SECRET_0123456789abcdef';
const admin = `Bearer ${ADMIN_SECRET}`;
const body = (value: unknown) => async () => value;
const GRANT_ID = boundedGrantId({
  correlation: { requestId: 'aoc.gar:req-1', decisionId: 'decision-1', action: 'invoice.approve', resourceScope: 'resource-ledger-1' },
  subject: 'actor-agent',
  scope: { action: { kind: 'identity', value: 'invoice.approve' }, resources: { kind: 'set', values: ['resource-ledger-1'] } },
  expiresAt: '2026-10-13T10:05:00.000Z',
} as never);

async function httpError(promise: Promise<unknown>): Promise<EnterpriseHttpError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof EnterpriseHttpError, `expected an EnterpriseHttpError, got ${String(error)}`);
    return error;
  }
  assert.fail('expected a refusal');
}

function serviceRevokingWith(error: unknown) {
  return createAuthorityAdministrationService({
    administrators: [{ operatorId: 'ops-1', key: ADMIN_SECRET }],
    ordinaryCredentials: [],
    organizationId: 'org-acme',
    now: () => '2026-10-13T10:00:00.000Z',
    isReady: () => true,
    lifecycleState: () => 'ready',
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    grants: {
      reader: { read: async () => ({ status: 'not-found' }) as never },
      revoke: async () => {
        throw error;
      },
    },
  });
}

describe('PROD-03 — a revocation the witness did not accept is reported as not recorded', () => {
  for (const code of ['AUTHORITY_FRESHNESS_UNAVAILABLE', 'AUTHORITY_FRESHNESS_CONFLICT'] as const) {
    it(`${code} → 503 AUTHORITY_STATE_UNAVAILABLE, recorded: false`, async () => {
      const error = await httpError(serviceRevokingWith(new AuthorityStateFreshnessError(code, 'witness')).revokeGrant(admin, GRANT_ID, body({ reason: 'security-incident' })));
      assert.equal(error.httpStatus, 503);
      assert.equal(error.code, 'AUTHORITY_STATE_UNAVAILABLE');
      assert.deepEqual(error.extra, { failure: code, recorded: false });
      assert.match(error.message, /nothing was recorded/);
    });
  }

  for (const code of ['AUTHORITY_FRESHNESS_ROLLBACK_DETECTED', 'AUTHORITY_FRESHNESS_FORK_DETECTED', 'AUTHORITY_FRESHNESS_PENDING_RECOVERY', 'AUTHORITY_FRESHNESS_BINDING_MISMATCH', 'AUTHORITY_FRESHNESS_WITNESS_UNAUTHENTIC'] as const satisfies readonly AuthorityStateFreshnessErrorCode[]) {
    it(`${code} → 500 AUTHORITY_STATE_INTEGRITY_FAILED, never an outage`, async () => {
      const error = await httpError(serviceRevokingWith(new AuthorityStateFreshnessError(code, 'witness')).revokeGrant(admin, GRANT_ID, body({ reason: 'security-incident' })));
      assert.equal(error.httpStatus, 500);
      assert.equal(error.code, 'AUTHORITY_STATE_INTEGRITY_FAILED');
      assert.deepEqual(error.extra, { failure: code });
    });
  }

  it('an unrelated error still surfaces as itself (no blanket mapping)', async () => {
    const unrelated = new Error('boom');
    await assert.rejects(serviceRevokingWith(unrelated).revokeGrant(admin, GRANT_ID, body({ reason: 'security-incident' })), (error) => error === unrelated);
  });
});

describe('PROD-03 — through the real Host: witness down, revocation refused with nothing written, the grant still active, an emergency stop still works', () => {
  const workspace = createWorkspace('frontera-prod03-witness-outage-');
  after(() => workspace.close());

  it('revoke → 503 recorded:false → the grant reads active → the stop (witness-independent) withholds', async () => {
    const witness = await startWitness();
    const env = { ...ctrl02Env(workspace.dir()), ...freshnessEnv(witness) };
    const adapter = recordingAdapter();
    const host = workspace.track(await bootEnterpriseHost({ env, executionAdapters: [adapter], logger: capturingLogger }));
    const baseUrl = `http://127.0.0.1:${(await host.listen()).port}`;
    await bootstrapOrganization(baseUrl);
    const agent = await onboardAgent(baseUrl);
    const executed = await govern(baseUrl, agent.credential, transfer('100'));
    assert.equal(executed.body['status'], 'executed', executed.text);
    const decision = (expectStatus(await call(baseUrl, 'GET', `/api/admin/activity/decisions?requestId=${encodeURIComponent(executed.body['requestId'] as string)}`, { authorization: AUTH.observer }), 200, 'activity').body['decisions'] as Record<string, unknown>[])[0];
    const references = expectStatus(await call(baseUrl, 'GET', `/api/admin/evidence/decisions/${encodeURIComponent(decision?.['evaluationId'] as string)}`, { authorization: AUTH.observer }), 200, 'evidence').body['references'] as Record<string, unknown>[];
    const grantId = references.find((reference) => reference['referenceType'] === 'authorization_artifact')?.['externalId'] as string;
    assert.equal(typeof grantId, 'string');

    await witness.close();
    const refused = await call(baseUrl, 'POST', `/api/admin/authority/grants/${encodeURIComponent(grantId)}/revoke`, { authorization: AUTH.responder, body: { reason: 'security-incident' } });
    assert.equal(refused.status, 503, refused.text);
    const error = refused.body['error'] as Record<string, unknown>;
    assert.equal(error['code'], 'AUTHORITY_STATE_UNAVAILABLE');
    assert.equal((error['details'] as Record<string, unknown> | undefined)?.['recorded'] ?? error['recorded'], false, refused.text);
    const inspected = expectStatus(await call(baseUrl, 'GET', `/api/admin/authority/grants/${encodeURIComponent(grantId)}`, { authorization: AUTH.observer }), 200, 'inspect');
    assert.notEqual(inspected.body['status'], 'revoked', 'nothing was recorded');

    expectStatus(await call(baseUrl, 'POST', '/api/admin/emergency-controls/activate', { authorization: AUTH.responder, body: { scope: 'global' } }), 200, 'activate');
    const stopped = await govern(baseUrl, agent.credential, transfer('50'));
    assert.equal(stopped.body['withheldBy'], 'emergency-control', stopped.text);
    assert.equal(adapter.calls.length, 1);
  });
});
