import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { GRANT_REASON_CODES, grantSourceDigest, type GrantSourceAuthorization } from '../../features/grant-runtime/index.js';
import { GRANT_EXERCISE_REASON_CODES, createExecutionAdapterRegistry, type ExecutionAdapter } from '../../features/execution-runtime/index.js';
import { createRecordingExecutionAdapter } from '../../features/execution-runtime/tests/execution-fixture.js';
import { deriveGrantSourceAuthorization } from '../../kernel/orchestration/grant-adapter.js';
import { AUTHORITY_BINDING_REASON_CODES } from '../execution-governance/index.js';
import { computeGovernanceRequestPayloadDigest } from '../governance-store/projection.js';
import { toKernelEvaluationResult } from '../governance-store/store-common.js';
import type { GovernanceRecord } from '../governance-store/contracts.js';
import { createInMemoryGovernanceStore } from '../governance-store/in-memory-governance-store.js';
import {
  GOVERNED_ACTION_REASON_CODES as R,
  deriveGovernedActionExecutionId,
  deriveGovernedActionRequestId,
  validateGovernedActionIntent,
  type GovernedActionResult,
} from '../governed-action/index.js';
import { executionOutcomeReferenceId } from '../governed-action/identifiers.js';
import { EXECUTION_UNCONFIRMED_OUTCOME, createExecutionLedger } from '../governed-action/execution-ledger.js';
import {
  ALLOWED_INTENT,
  APPROVAL_INTENT,
  DENIED_ACTOR,
  DENIED_INTENT,
  DRAFTING_IS_FINANCIAL,
  EVALUATED_AT_POLICY,
  IDENTITY,
  NOW,
  NO_TEMPORAL_BOUND,
  ORG,
  PMFREAK_ACTOR_ID,
  TEST_MONETARY,
  TRUST_DOMAIN_ID,
  buildGovernedWorld,
  faultyOutcomes,
  preP11History,
  monetaryAuthority,
  identityFor,
  type GovernedWorld,
} from './governed-action-support.js';

/**
 * The Governed Action Orchestrator, proved against the real Kernel, the real
 * Governance Store, the real bounded-grant store and real ACE.
 *
 * GOV-ACT-01  every canonical decision is committed before grant issuance
 * GOV-ACT-02  a persistence failure → no grant, no external effect
 * GOV-ACT-03  actor and organization come only from BoundCustomerIdentity
 * GOV-ACT-04  intent cannot mint, select or mutate authority
 * GOV-ACT-05  the grant source is the committed decision
 * GOV-ACT-06  no raw bounded grant reaches the consumer
 * GOV-ACT-07  every executed action passes the ACE exercise gate
 * GOV-ACT-08  the adapter receives only a ValidatedExecutionAction
 * GOV-ACT-09  references are evidence; they never grant authority
 * GOV-ACT-12  execution identity is server-derived
 */

const REQUEST_ID = deriveGovernedActionRequestId({ organizationId: ORG, principalId: IDENTITY.principal.principalId, idempotencyKey: ALLOWED_INTENT.idempotencyKey });

async function recordFor(world: GovernedWorld, requestId: string): Promise<GovernanceRecord | null> {
  return world.rawStore.getByRequestId({ system: false, organizationId: ORG }, requestId);
}

function assertNoGrantLeak(result: GovernedActionResult, grantId?: string): void {
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes('aoc.grant:'), false, 'no grant id reaches the consumer');
  if (grantId !== undefined) assert.equal(serialized.includes(grantId), false);
  for (const key of ['grant', 'grantId', 'boundedGrantId', 'scope', 'sourceDigest', 'digest', 'expiresAt', 'authorityBinding', 'credential', 'adapter', 'system']) {
    assert.equal(Object.hasOwn(result, key), false, `result must not carry '${key}'`);
  }
}

function withheldBy(result: GovernedActionResult): string | undefined {
  return result.status === 'withheld' ? result.withheldBy : undefined;
}

describe('Governed action — the canonical path executes once, through every gate', () => {
  it('bound identity + allowed intent → committed decision → grant → exercise → adapter', async () => {
    const world = buildGovernedWorld();
    const result = await world.orchestrator.govern(IDENTITY, ALLOWED_INTENT);

    assert.equal(result.status, 'executed', JSON.stringify(result));
    assert.ok(result.status === 'executed');
    assert.equal(result.requestId, REQUEST_ID);
    assert.equal(result.providerRef, 'provider-ref-1');
    assert.equal(result.replayed, false);
    assert.equal(result.outcomeRecorded, true);
    assert.equal(result.decision?.status, 'allowed');
    assert.equal(world.adapter.callCount, 1);

    const record = await recordFor(world, REQUEST_ID);
    assert.ok(record !== null, 'the decision is durably recorded');
    assert.equal(record.evaluation.decisionId, result.decision?.decisionId);
    assert.equal(record.evaluation.evaluationId, result.decision?.evaluationId);
    assert.equal(record.request.organizationId, ORG);
    assert.equal(record.request.actorId, PMFREAK_ACTOR_ID);
    assert.equal((await world.rawStore.verify({ system: false, organizationId: ORG }, record.evaluation.evaluationId)).valid, true);
    assert.deepEqual(
      record.events.map((event) => event.eventType),
      ['GovernanceEvaluationRequested', 'GovernanceEvaluationCompleted'],
      'the evaluation events are embedded in the committed aggregate',
    );
  });

  it('GOV-ACT-01: appendEvaluation strictly precedes BoundedGrantStore.issue, which precedes the adapter', async () => {
    const world = buildGovernedWorld();
    await world.orchestrator.govern(IDENTITY, ALLOWED_INTENT);
    const order = world.log.entries;
    const append = order.indexOf('store.appendEvaluation');
    const issue = order.indexOf('grantStore.issue');
    const adapter = order.indexOf('adapter.execute');
    assert.ok(append >= 0 && issue >= 0 && adapter >= 0, order.join(' → '));
    assert.ok(order.indexOf('kernel.evaluate') < append, 'the Kernel decides before anything is recorded');
    assert.ok(append < issue, 'index(appendEvaluation) < index(issue)');
    assert.ok(order.indexOf('store.verify') > append && order.indexOf('store.verify') < issue, 'the committed record is verified before issuance');
    assert.ok(order.indexOf('store.appendReference:execution_record:attempt') < adapter, 'the execution is claimed before the adapter runs');
    assert.ok(issue < adapter);
  });

  it('GOV-ACT-08: the adapter receives a ValidatedExecutionAction bound to the bound identity and the committed decision', async () => {
    const world = buildGovernedWorld();
    const result = await world.orchestrator.govern(IDENTITY, ALLOWED_INTENT);
    const [action] = world.adapter.calls;
    assert.ok(action !== undefined);
    assert.deepEqual(Object.keys(action).sort(), ['action', 'boundedGrantId', 'correlation', 'notAfter', 'organization', 'resource', 'subject'].sort());
    assert.equal(action.subject, PMFREAK_ACTOR_ID);
    assert.equal(action.organization, ORG);
    assert.equal(action.correlation.requestId, REQUEST_ID);
    assert.equal(action.correlation.decisionId, result.decision?.decisionId);
    assert.equal(action.correlation.executionId, result.executionId);
  });

  it('GOV-ACT-12: the execution id is derived from the server request id and the committed decision', async () => {
    const world = buildGovernedWorld();
    const result = await world.orchestrator.govern(IDENTITY, ALLOWED_INTENT);
    assert.equal(result.executionId, deriveGovernedActionExecutionId({ requestId: REQUEST_ID, decisionId: result.decision?.decisionId ?? '' }));
  });

  it('GOV-ACT-06: the result carries no bounded grant, scope, digest, expiry, credential or adapter — and is frozen', async () => {
    const world = buildGovernedWorld();
    const result = await world.orchestrator.govern(IDENTITY, ALLOWED_INTENT);
    const grantId = world.adapter.calls[0]?.boundedGrantId;
    assert.ok(grantId !== undefined && grantId.startsWith('aoc.grant:'));
    assertNoGrantLeak(result, grantId);
    assert.equal(Object.isFrozen(result), true);
  });

  it('GOV-ACT-09: the grant and the execution are recorded as evidence references on the committed decision', async () => {
    const world = buildGovernedWorld();
    const result = await world.orchestrator.govern(IDENTITY, ALLOWED_INTENT);
    const record = await recordFor(world, REQUEST_ID);
    assert.ok(record !== null);
    const grantId = world.adapter.calls[0]?.boundedGrantId;
    const byType = record.references.map((reference) => `${reference.referenceType}:${reference.externalId}:${reference.externalVersion ?? ''}`);
    // The outcome row names the adapter that **performed** the effect, so "which
    // provider did this" is answerable from the durable record rather than only
    // from whichever boundary happened to be composed.
    assert.deepEqual(byType, [
      `authorization_artifact:${String(grantId)}:`,
      `execution_record:${String(result.executionId)}:attempt`,
      `execution_record:${String(result.executionId)}:executed@${world.adapter.adapterId}`,
    ]);
    assert.equal((await world.rawStore.verify({ system: false, organizationId: ORG }, record.evaluation.evaluationId)).checks.referenceIntegrity, true);
  });
});

describe('Governed action — every decision is committed, whatever it says', () => {
  it('DENIED → persisted, no grant, no adapter', async () => {
    const world = buildGovernedWorld();
    const result = await world.orchestrator.govern(identityFor({ actorId: DENIED_ACTOR }), DENIED_INTENT);
    assert.equal(result.status, 'denied');
    assert.deepEqual(result.reasonCodes, result.decision?.reasonCodes, 'the Kernel reason codes, verbatim');
    assert.ok((await recordFor(world, result.requestId ?? '')) !== null);
    assert.equal(world.log.indexOf('grantStore.issue'), -1);
    assert.equal(world.adapter.callCount, 0);
  });

  it('INDETERMINATE → persisted, no grant, no adapter', async () => {
    const world = buildGovernedWorld({ kernelOverride: (result) => ({ ...result, status: 'indeterminate', reasonCodes: ['KERNEL_TEST_INDETERMINATE'] }) });
    const result = await world.orchestrator.govern(IDENTITY, ALLOWED_INTENT);
    assert.equal(result.status, 'indeterminate');
    const record = await recordFor(world, REQUEST_ID);
    assert.equal(record?.evaluation.status, 'indeterminate');
    assert.equal(world.log.indexOf('grantStore.issue'), -1);
    assert.equal(world.adapter.callCount, 0);
  });

  it('APPROVAL_REQUIRED → persisted, withheld by approval, no grant, no adapter', async () => {
    const world = buildGovernedWorld();
    const result = await world.orchestrator.govern(IDENTITY, APPROVAL_INTENT);
    assert.equal(result.status, 'withheld');
    assert.equal(withheldBy(result), 'approval');
    assert.equal(result.decision?.status, 'approval_required');
    assert.ok((await recordFor(world, result.requestId ?? '')) !== null);
    assert.equal(world.log.indexOf('grantStore.issue'), -1);
    assert.equal(world.adapter.callCount, 0);
  });

  it('a pending blocking obligation → ALLOW persisted, withheld by obligations, no adapter', async () => {
    const world = buildGovernedWorld({ obligationsPending: true });
    const result = await world.orchestrator.govern(IDENTITY, ALLOWED_INTENT);
    assert.equal(result.status, 'withheld');
    assert.equal(withheldBy(result), 'obligations');
    assert.equal(result.decision?.status, 'allowed', 'a condition not yet met does not un-authorize the request');
    assert.deepEqual([...result.reasonCodes], [GRANT_REASON_CODES.GRANT_OBLIGATIONS_UNSATISFIED]);
    assert.ok((await recordFor(world, REQUEST_ID)) !== null);
    assert.equal(world.adapter.callCount, 0);
  });

  it('an unresolved authority binding → persisted, withheld by authority-binding, no grant, no adapter', async () => {
    const world = buildGovernedWorld({ resolveAuthorityBinding: () => undefined });
    const result = await world.orchestrator.govern(IDENTITY, ALLOWED_INTENT);
    assert.equal(withheldBy(result), 'authority-binding');
    assert.deepEqual([...result.reasonCodes], [AUTHORITY_BINDING_REASON_CODES.AUTHORITY_BINDING_UNRESOLVED]);
    assert.ok((await recordFor(world, REQUEST_ID)) !== null);
    assert.equal(world.log.indexOf('grantStore.issue'), -1);
    assert.equal(world.adapter.callCount, 0);
  });

  it('a malformed authority binding → withheld, no adapter', async () => {
    const world = buildGovernedWorld({ resolveAuthorityBinding: () => ({ kind: 'bounded-authority', authorityKind: 'mandate', authorityRef: 'm-1', expiresAt: 'not-a-date' }) });
    const result = await world.orchestrator.govern(IDENTITY, ALLOWED_INTENT);
    assert.deepEqual([...result.reasonCodes], [AUTHORITY_BINDING_REASON_CODES.AUTHORITY_BINDING_MALFORMED]);
    assert.equal(world.adapter.callCount, 0);
  });

  it('a binding that changes at the commit boundary refuses the grant — the sync re-resolution still runs on this path', async () => {
    const world = buildGovernedWorld({
      resolveAuthorityBinding: (query) =>
        query.phase === 'issuance'
          ? { kind: 'bounded-authority', authorityKind: 'mandate', authorityRef: 'mandate-1', expiresAt: '2026-01-01T01:00:00.000Z' }
          : { kind: 'bounded-authority', authorityKind: 'mandate', authorityRef: 'mandate-1', expiresAt: '2026-01-01T00:05:00.000Z' },
    });
    const result = await world.orchestrator.govern(IDENTITY, ALLOWED_INTENT);
    assert.equal(withheldBy(result), 'grant');
    assert.deepEqual([...result.reasonCodes], [GRANT_REASON_CODES.GRANT_CORRELATION_INVALID]);
    assert.equal(world.adapter.callCount, 0);
  });

  it('a mandate ceiling still contains the grant: an expiry inside it is accepted', async () => {
    const world = buildGovernedWorld({
      resolveAuthorityBinding: () => ({ kind: 'bounded-authority', authorityKind: 'mandate', authorityRef: 'mandate-1', expiresAt: '2026-01-01T00:30:00.000Z' }),
    });
    const result = await world.orchestrator.govern(IDENTITY, ALLOWED_INTENT);
    assert.equal(result.status, 'executed');
    assert.equal(world.adapter.calls[0]?.notAfter, '2026-01-01T00:10:00.000Z');
  });

  it('a mandate ceiling still contains the grant: an expiry beyond it is refused, never clamped silently', async () => {
    const world = buildGovernedWorld({
      resolveAuthorityBinding: () => ({ kind: 'bounded-authority', authorityKind: 'mandate', authorityRef: 'mandate-1', expiresAt: '2026-01-01T00:05:00.000Z' }),
    });
    const result = await world.orchestrator.govern(IDENTITY, ALLOWED_INTENT);
    assert.equal(withheldBy(result), 'grant');
    assert.deepEqual([...result.reasonCodes], [GRANT_REASON_CODES.GRANT_SCOPE_BROADENING]);
    assert.equal(world.adapter.callCount, 0);
  });
});

/**
 * The current source a host revalidator would answer if nothing had changed
 * since the decision: the projection of the decision the Kernel returned,
 * which the orchestrator has already proved equal to the committed record.
 */
function unchangedCurrentSource(world: GovernedWorld): GrantSourceAuthorization {
  const [request] = world.kernelRequests;
  const [decision] = world.kernelResults;
  assert.ok(request !== undefined && decision !== undefined);
  return deriveGrantSourceAuthorization(world.grantCapability, request, decision);
}

function assertRefusedAtCommit(world: GovernedWorld, result: GovernedActionResult, reasonCodes: readonly string[]): void {
  assert.equal(withheldBy(result), 'grant');
  assert.deepEqual([...result.reasonCodes], [...reasonCodes]);
  assert.ok(world.revalidatedSources.length > 0, 'the host revalidator was consulted at the commit boundary');
  assert.ok(world.log.indexOf('grantStore.issue') !== -1, 'issuance reached the grant store');
  assert.deepEqual(
    world.issueOutcomes.map((outcome) => outcome.outcome),
    ['refused'],
    'the grant store refused the commit',
  );
  assert.equal(world.adapter.callCount, 0);
  assertNoGrantLeak(result);
}

describe('Governed action — the host ACE revalidateSource is the commit guard\'s current source, not a veto', () => {
  it('revalidateSource returns undefined → no grant, no adapter', async () => {
    const world = buildGovernedWorld({ revalidateSource: () => undefined });
    const result = await world.orchestrator.govern(IDENTITY, ALLOWED_INTENT);
    assertRefusedAtCommit(world, result, [GRANT_REASON_CODES.GRANT_CORRELATION_INVALID]);
    assert.deepEqual(world.revalidatedSources, [undefined]);
  });

  it('revalidateSource returns a current source that is no longer eligible → issuance refused, no adapter', async () => {
    const world = buildGovernedWorld({
      revalidateSource: (_correlation, self) => ({ ...unchangedCurrentSource(self), authorizationPermitsExercise: false }),
    });
    const result = await world.orchestrator.govern(IDENTITY, ALLOWED_INTENT);
    assertRefusedAtCommit(world, result, [GRANT_REASON_CODES.GRANT_AUTHORIZATION_NOT_PERMITTED]);
  });

  it('revalidateSource returns a current source whose scope has narrowed → issuance refused, no adapter', async () => {
    const world = buildGovernedWorld({
      revalidateSource: (_correlation, self) => {
        const current = unchangedCurrentSource(self);
        return { ...current, scope: { ...current.scope, resources: { kind: 'set', values: ['resource-no-longer-covered'] } } };
      },
    });
    const result = await world.orchestrator.govern(IDENTITY, ALLOWED_INTENT);
    assertRefusedAtCommit(world, result, [GRANT_REASON_CODES.GRANT_SCOPE_BROADENING]);
  });

  it('revalidateSource returns a current source whose validity has narrowed → issuance refused, no adapter', async () => {
    // The grant ends ten minutes after the decision; the authority now ends at five.
    const world = buildGovernedWorld({
      revalidateSource: (_correlation, self) => {
        const current = unchangedCurrentSource(self);
        return { ...current, validityCeilings: [...current.validityCeilings, { source: 'authority', notAfter: '2026-01-01T00:05:00.000Z' }] };
      },
    });
    const result = await world.orchestrator.govern(IDENTITY, ALLOWED_INTENT);
    assertRefusedAtCommit(world, result, [GRANT_REASON_CODES.GRANT_SCOPE_BROADENING]);
  });

  it('revalidateSource returns the unchanged current source → normal execution, grant derived from the committed record', async () => {
    const world = buildGovernedWorld({ revalidateSource: (_correlation, self) => unchangedCurrentSource(self) });
    const result = await world.orchestrator.govern(IDENTITY, ALLOWED_INTENT);
    assert.equal(result.status, 'executed');
    assert.equal(world.adapter.callCount, 1);
    assert.equal(world.revalidatedSources.length, 1);

    const record = await recordFor(world, REQUEST_ID);
    assert.ok(record !== null);
    const read = await world.grantStore.read(world.adapter.calls[0]?.boundedGrantId ?? '');
    assert.ok(read.grant !== undefined);
    const [request] = world.kernelRequests;
    assert.ok(request !== undefined);
    const persistedDigest = grantSourceDigest(deriveGrantSourceAuthorization(world.grantCapability, request, toKernelEvaluationResult(record)));
    assert.equal(read.grant.sourceDigest, persistedDigest, 'the artifact is still derived from the persisted decision');
  });
});

describe('Governed action — GOV-ACT-02: no durable decision, no authority, no effect', () => {
  it('appendEvaluation fails → system_error, issue never called, adapter never called', async () => {
    const world = buildGovernedWorld({ storeFault: { appendEvaluation: true } });
    const result = await world.orchestrator.govern(IDENTITY, ALLOWED_INTENT);
    assert.equal(result.status, 'system_error');
    assert.deepEqual([...result.reasonCodes], [R.GOVERNED_ACTION_DECISION_PERSISTENCE_FAILED]);
    assert.equal(world.log.indexOf('grantStore.issue'), -1, 'issue was never called');
    assert.equal(world.adapter.callCount, 0);
    assert.equal(result.decision, undefined, 'no decision is reported that was not recorded');
    assert.ok(world.events.some((event) => event.type === 'GovernanceRecordCommitFailed'));
    assert.equal(world.events.some((event) => event.type === 'GovernanceRecordCommitted'), false);
  });

  it('the committed record cannot be re-read → no grant, no adapter', async () => {
    const world = buildGovernedWorld({ storeFault: { getByEvaluationId: true } });
    const result = await world.orchestrator.govern(IDENTITY, ALLOWED_INTENT);
    assert.deepEqual([...result.reasonCodes], [R.GOVERNED_ACTION_PERSISTED_DECISION_UNVERIFIABLE]);
    assert.equal(world.log.indexOf('grantStore.issue'), -1);
    assert.equal(world.adapter.callCount, 0);
  });

  it('the committed record does not verify → no grant, no adapter', async () => {
    const world = buildGovernedWorld({ storeFault: { verifyInvalid: true } });
    const result = await world.orchestrator.govern(IDENTITY, ALLOWED_INTENT);
    assert.deepEqual([...result.reasonCodes], [R.GOVERNED_ACTION_PERSISTED_DECISION_UNVERIFIABLE]);
    assert.equal(world.log.indexOf('grantStore.issue'), -1);
    assert.equal(world.adapter.callCount, 0);
  });

  it('the idempotency probe itself fails → no Kernel, no grant, no adapter', async () => {
    const world = buildGovernedWorld({ storeFault: { resolveIdempotency: true } });
    const result = await world.orchestrator.govern(IDENTITY, ALLOWED_INTENT);
    assert.equal(result.status, 'system_error');
    assert.equal(world.log.indexOf('kernel.evaluate'), -1);
    assert.equal(world.adapter.callCount, 0);
  });

  it('the Kernel throws → system_error, nothing persisted, no grant', async () => {
    const world = buildGovernedWorld({ kernelThrows: new Error('kernel down') });
    const result = await world.orchestrator.govern(IDENTITY, ALLOWED_INTENT);
    assert.deepEqual([...result.reasonCodes], [R.GOVERNED_ACTION_KERNEL_FAILED]);
    assert.equal(await recordFor(world, REQUEST_ID), null);
    assert.equal(world.log.indexOf('grantStore.issue'), -1);
  });

  it('the grant store fails to issue → system_error, adapter never called, decision retained', async () => {
    const world = buildGovernedWorld({ grantIssueThrows: true });
    const result = await world.orchestrator.govern(IDENTITY, ALLOWED_INTENT);
    assert.deepEqual([...result.reasonCodes], [R.GOVERNED_ACTION_GRANT_ISSUANCE_FAILED]);
    assert.equal(world.adapter.callCount, 0);
    assert.ok((await recordFor(world, REQUEST_ID)) !== null);
  });

  it('the authorization reference cannot be appended → adapter never called', async () => {
    const world = buildGovernedWorld({ storeFault: { appendReferenceFor: ['authorization_artifact'] } });
    const result = await world.orchestrator.govern(IDENTITY, ALLOWED_INTENT);
    assert.deepEqual([...result.reasonCodes], [R.GOVERNED_ACTION_AUTHORIZATION_EVIDENCE_FAILED]);
    assert.equal(world.adapter.callCount, 0);
  });

  it('the write-ahead execution record cannot be appended → adapter never called', async () => {
    const world = buildGovernedWorld({ storeFault: { appendReferenceFor: ['execution_record'] } });
    const result = await world.orchestrator.govern(IDENTITY, ALLOWED_INTENT);
    assert.equal(result.status, 'system_error');
    assert.deepEqual([...result.reasonCodes], [R.GOVERNED_ACTION_EXECUTION_CLAIM_FAILED]);
    assert.equal(world.adapter.callCount, 0);
  });

  it('the adapter fails → execution_failed, and the decision and authorization history stay intact', async () => {
    const world = buildGovernedWorld({ adapterBehaviour: () => ({ outcome: 'failed', reason: 'PROVIDER_REJECTED' }) });
    const result = await world.orchestrator.govern(IDENTITY, ALLOWED_INTENT);
    assert.equal(result.status, 'execution_failed');
    assert.ok(result.status === 'execution_failed');
    assert.equal(result.failure, 'PROVIDER_REJECTED');
    const record = await recordFor(world, REQUEST_ID);
    assert.ok(record !== null);
    assert.equal(record.evaluation.status, 'allowed');
    assert.equal((await world.rawStore.verify({ system: false, organizationId: ORG }, record.evaluation.evaluationId)).valid, true);
    assert.deepEqual(
      record.references.map((reference) => reference.externalVersion ?? reference.referenceType),
      ['authorization_artifact', 'attempt', `execution-failed:PROVIDER_REJECTED@${world.adapter.adapterId}`],
    );
  });

  it('an adapter that throws is contained as execution_failed / ADAPTER_ERROR — never as a denial', async () => {
    const world = buildGovernedWorld({
      adapterBehaviour: () => {
        throw new Error('socket hang up');
      },
    });
    const result = await world.orchestrator.govern(IDENTITY, ALLOWED_INTENT);
    assert.equal(result.status, 'execution_failed');
    assert.ok(result.status === 'execution_failed');
    assert.equal(result.failure, 'ADAPTER_ERROR');
    assert.equal(JSON.stringify(result).includes('socket hang up'), false, 'provider detail is not echoed to the consumer');
  });

  it('P11 — the Governance outcome summary fails → the canonical observation stands: recorded, and replayed as executed with its providerRef', async () => {
    const world = buildGovernedWorld({ storeFault: { appendOutcomeReference: true } });
    const result = await world.orchestrator.govern(IDENTITY, ALLOWED_INTENT);
    assert.equal(result.status, 'executed');
    assert.equal(result.status === 'executed' ? result.outcomeRecorded : undefined, true, 'outcomeRecorded is the canonical P11 observation, not the summary row');
    assert.equal(result.reasonCodes.includes(R.GOVERNED_ACTION_EXECUTION_OUTCOME_UNRECORDED), false);
    const retry = await world.orchestrator.govern(IDENTITY, ALLOWED_INTENT);
    assert.equal(retry.status, 'executed');
    assert.equal(retry.status === 'executed' ? retry.replayed : undefined, true);
    assert.equal(retry.status === 'executed' ? retry.providerRef : undefined, 'provider-ref-1');
    assert.equal(world.adapter.callCount, 1);
  });

  it('the post-effect canonical outcome write fails → the effect is still reported as executed, flagged unrecorded', async () => {
    const world = buildGovernedWorld({ executionOutcomes: faultyOutcomes({ recordTerminal: true }) });
    const result = await world.orchestrator.govern(IDENTITY, ALLOWED_INTENT);
    assert.equal(result.status, 'executed', 'an effect that happened is never reported as one that did not');
    assert.ok(result.status === 'executed');
    assert.equal(result.outcomeRecorded, false);
    assert.ok(result.reasonCodes.includes(R.GOVERNED_ACTION_EXECUTION_OUTCOME_UNRECORDED));
    assert.equal(world.adapter.callCount, 1);

    // A retry cannot tell whether the effect happened, so it does not run it again.
    const retry = await world.orchestrator.govern(IDENTITY, ALLOWED_INTENT);
    assert.equal(retry.status, 'execution_unconfirmed');
    assert.deepEqual([...retry.reasonCodes], [R.GOVERNED_ACTION_EXECUTION_ALREADY_ATTEMPTED]);
    assert.equal(world.adapter.callCount, 1);
  });
});

describe('Governed action — GOV-ACT-05: the grant source is the committed decision', () => {
  it('the issued grant is derived from the decision reconstructed out of the Governance Record', async () => {
    const world = buildGovernedWorld();
    await world.orchestrator.govern(IDENTITY, ALLOWED_INTENT);
    const record = await recordFor(world, REQUEST_ID);
    assert.ok(record !== null);
    const grantId = world.adapter.calls[0]?.boundedGrantId ?? '';
    const read = await world.grantStore.read(grantId);
    assert.ok(read.grant !== undefined);
    const persisted = toKernelEvaluationResult(record);
    const [request] = world.kernelRequests;
    assert.ok(request !== undefined);
    const expected = grantSourceDigest(deriveGrantSourceAuthorization(world.grantCapability, request, persisted));
    assert.equal(read.grant.sourceDigest, expected, 'GRANT ⊆ PERSISTED AUTHORIZATION');
    assert.equal(read.grant.correlation.decisionId, record.evaluation.decisionId);
    assert.equal(read.grant.correlation.requestId, record.evaluation.requestId);
  });

  it('a persisted record that diverges from the transient decision fails closed — the transient result never wins', async () => {
    // The Kernel says ALLOW with obligations satisfied; the record read back says otherwise.
    const tamper = (record: GovernanceRecord): GovernanceRecord => ({
      ...record,
      evaluation: { ...record.evaluation, resultPayload: { ...record.evaluation.resultPayload, evaluatedAt: '2025-12-31T00:00:00.000Z' } },
    });
    const world = buildGovernedWorld({ storeFault: { tamperRead: tamper } });
    const result = await world.orchestrator.govern(IDENTITY, ALLOWED_INTENT);
    assert.equal(result.status, 'system_error');
    assert.deepEqual([...result.reasonCodes], [R.GOVERNED_ACTION_PERSISTED_DECISION_MISMATCH]);
    assert.equal(world.log.indexOf('grantStore.issue'), -1, 'no grant from either source');
    assert.equal(world.adapter.callCount, 0);
  });

  it('a persisted record whose status disagrees with the transient one fails closed', async () => {
    const tamper = (record: GovernanceRecord): GovernanceRecord => ({ ...record, evaluation: { ...record.evaluation, status: 'denied' } });
    const world = buildGovernedWorld({ storeFault: { tamperRead: tamper } });
    const result = await world.orchestrator.govern(IDENTITY, ALLOWED_INTENT);
    assert.deepEqual([...result.reasonCodes], [R.GOVERNED_ACTION_PERSISTED_DECISION_MISMATCH]);
    assert.equal(world.log.indexOf('grantStore.issue'), -1);
  });

  it('a record read back under a different aggregate digest than the one committed is unverifiable', async () => {
    const tamper = (record: GovernanceRecord): GovernanceRecord => ({ ...record, integrity: { ...record.integrity, aggregateDigest: 'sha256:other' } });
    const world = buildGovernedWorld({ storeFault: { tamperRead: tamper } });
    const result = await world.orchestrator.govern(IDENTITY, ALLOWED_INTENT);
    assert.deepEqual([...result.reasonCodes], [R.GOVERNED_ACTION_PERSISTED_DECISION_UNVERIFIABLE]);
    assert.equal(world.log.indexOf('grantStore.issue'), -1);
  });
});

describe('Governed action — GOV-ACT-03/04: identity is bound, intent is intent', () => {
  it('builds the Kernel request from the bound identity: organization, actor and trust domain are server-derived', async () => {
    const world = buildGovernedWorld();
    await world.orchestrator.govern(IDENTITY, ALLOWED_INTENT);
    const [request] = world.kernelRequests;
    assert.ok(request !== undefined);
    assert.equal(request.requestId, REQUEST_ID);
    assert.deepEqual(request.actor, { id: PMFREAK_ACTOR_ID, trustDomainId: TRUST_DOMAIN_ID });
    assert.deepEqual(request.organization, { id: ORG });
    assert.equal(request.requestedAt, NOW);
    assert.deepEqual(Object.keys(request.action).sort(), ['resourceScope', 'type']);
  });

  for (const [field, value] of [
    ['actorId', 'actor-attacker'],
    ['actor', { id: 'actor-attacker', trustDomainId: 'td' }],
    ['organizationId', 'org-other'],
    ['organization', { id: 'org-other' }],
    ['system', true],
    ['externalSubject', { system: 'x', subjectId: 'y' }],
    ['principalId', 'principal-other'],
    ['grant', { id: 'aoc.grant:forged', expiresAt: '2099-01-01T00:00:00.000Z' }],
    ['grantId', 'aoc.grant:forged'],
    ['grantExpiresAt', '2099-01-01T00:00:00.000Z'],
    ['authorityBinding', { kind: 'no-temporal-authority-bound' }],
    ['executionId', 'exec-forged'],
    ['requestId', 'request-forged'],
    ['adapter', 'other-adapter'],
    ['adapterId', 'other-adapter'],
    ['credential', 'Bearer stolen'],
    ['url', 'https://attacker.example'],
    ['payload', { amount: 1_000_000 }],
  ] as const) {
    it(`an intent carrying '${field}' is rejected before the Kernel, and nothing is recorded`, async () => {
      const world = buildGovernedWorld();
      const result = await world.orchestrator.govern(IDENTITY, { ...ALLOWED_INTENT, [field]: value });
      assert.equal(result.status, 'rejected');
      assert.deepEqual([...result.reasonCodes], [R.GOVERNED_ACTION_INTENT_INVALID]);
      assert.equal(world.kernelRequests.length, 0);
      assert.equal(world.log.indexOf('store.appendEvaluation'), -1);
      assert.equal(world.adapter.callCount, 0);
    });
  }

  for (const key of ['actorId', 'organizationId', 'system', 'principalId', 'grantId', 'executionId']) {
    it(`an asserted context carrying '${key}' is rejected`, async () => {
      const world = buildGovernedWorld();
      const result = await world.orchestrator.govern(IDENTITY, { ...ALLOWED_INTENT, assertedContext: { ...ALLOWED_INTENT.assertedContext, [key]: 'forged' } });
      assert.deepEqual([...result.reasonCodes], [R.GOVERNED_ACTION_INTENT_INVALID]);
      assert.equal(world.kernelRequests.length, 0);
    });
  }

  it('identity-shaped decoration on the identity object itself is never read', async () => {
    const world = buildGovernedWorld();
    const decorated = { ...IDENTITY, system: true, actorId: 'actor-attacker', organizationId: 'org-other', principal: { ...IDENTITY.principal, system: true } };
    const result = await world.orchestrator.govern(decorated, ALLOWED_INTENT);
    assert.equal(result.status, 'executed');
    const [request] = world.kernelRequests;
    assert.equal(request?.actor.id, PMFREAK_ACTOR_ID);
    assert.equal(request?.organization?.id, ORG);
    for (const context of world.accessContexts) {
      assert.equal((context as { system: boolean }).system, false, 'every Store call runs under the tenant scope, never a system context');
      assert.equal((context as { organizationId?: string }).organizationId, ORG);
    }
  });

  it('a bound identity for an organization this orchestrator does not serve is rejected, cross-tenant', async () => {
    const world = buildGovernedWorld();
    const result = await world.orchestrator.govern(identityFor({ organizationId: 'org-other' }), ALLOWED_INTENT);
    assert.equal(result.status, 'rejected');
    assert.deepEqual([...result.reasonCodes], [R.GOVERNED_ACTION_IDENTITY_INVALID]);
    assert.equal(world.kernelRequests.length, 0);
  });

  it('a non-customer identity is rejected', async () => {
    const world = buildGovernedWorld();
    const operator = { principal: { ...IDENTITY.principal, plane: 'operator' }, actor: IDENTITY.actor } as unknown as typeof IDENTITY;
    assert.equal((await world.orchestrator.govern(operator, ALLOWED_INTENT)).status, 'rejected');
  });

  it('the caller cannot choose the grant expiry: the trusted policy does, and an unresolvable one withholds', async () => {
    const world = buildGovernedWorld({ grantPolicy: () => undefined });
    const result = await world.orchestrator.govern(IDENTITY, ALLOWED_INTENT);
    assert.equal(withheldBy(result), 'grant-terms');
    assert.deepEqual([...result.reasonCodes], [R.GOVERNED_ACTION_GRANT_TERMS_UNAVAILABLE]);
    assert.equal(world.log.indexOf('grantStore.issue'), -1);
    assert.equal(world.adapter.callCount, 0);
  });

  it('a policy expiry that is not after issuance is refused by issuance — no unbounded or backdated grant', async () => {
    const world = buildGovernedWorld({ grantPolicy: () => ({ grantExpiresAt: NOW }) });
    const result = await world.orchestrator.govern(IDENTITY, ALLOWED_INTENT);
    assert.equal(withheldBy(result), 'grant');
    assert.equal(world.adapter.callCount, 0);
  });
});

describe('Governed action — decision idempotency', () => {
  it('same principal, organization, key and payload → one decision, Kernel run once, adapter run once', async () => {
    const world = buildGovernedWorld();
    const first = await world.orchestrator.govern(IDENTITY, ALLOWED_INTENT);
    world.clock.advance(60_000);
    const second = await world.orchestrator.govern(IDENTITY, ALLOWED_INTENT);

    assert.equal(world.kernelRequests.length, 1, 'the Kernel is not re-run for a replay');
    assert.equal(second.decision?.decisionId, first.decision?.decisionId);
    assert.equal(second.decision?.evaluationId, first.decision?.evaluationId);
    assert.equal(second.executionId, first.executionId);
    assert.equal(second.status, 'executed');
    assert.ok(second.status === 'executed');
    assert.equal(second.replayed, true);
    assert.equal(world.adapter.callCount, 1, 'the execution is not repeated');
    const summaries = await world.rawStore.query({ system: false, organizationId: ORG }, { requestId: REQUEST_ID });
    assert.equal(summaries.records.length, 1, 'no duplicate decision');
  });

  it('a retry does not mint a wider or later grant: it re-derives the same one', async () => {
    // The first call stops at the pre-assessment, before any execution is
    // claimed, so the retry is not a replay and reaches issuance again.
    let revokeOnce = true;
    const world = buildGovernedWorld({
      beforeAssess: async ({ ace }, grantId) => {
        if (!revokeOnce) return;
        revokeOnce = false;
        await ace.revokeGrant({ grantId, reason: 'manual-revocation', issuerRef: 'operator-1' });
      },
    });
    await world.orchestrator.govern(IDENTITY, ALLOWED_INTENT);
    world.clock.advance(60_000);
    await world.orchestrator.govern(IDENTITY, ALLOWED_INTENT);
    assert.deepEqual(
      world.issueOutcomes.map((outcome) => outcome.outcome),
      ['issued', 'already-issued'],
    );
    const [first, second] = world.issueOutcomes;
    assert.ok(first?.outcome !== 'refused' && second?.outcome !== 'refused');
    assert.equal(second?.grant.id, first?.grant.id);
  });

  it('same key, different payload → conflict; the original decision stands and nothing re-runs', async () => {
    const world = buildGovernedWorld();
    await world.orchestrator.govern(IDENTITY, ALLOWED_INTENT);
    const conflict = await world.orchestrator.govern(IDENTITY, { ...ALLOWED_INTENT, resource: 'project:other' });
    assert.equal(conflict.status, 'rejected');
    assert.deepEqual([...conflict.reasonCodes], [R.GOVERNED_ACTION_IDEMPOTENCY_CONFLICT]);
    assert.equal(world.kernelRequests.length, 1);
    assert.equal(world.adapter.callCount, 1);
  });

  it('a retry cannot change the actor: the same principal and key under a different actor conflicts', async () => {
    const world = buildGovernedWorld();
    await world.orchestrator.govern(IDENTITY, ALLOWED_INTENT);
    const replayedAsOther = await world.orchestrator.govern(identityFor({ actorId: DENIED_ACTOR }), ALLOWED_INTENT);
    assert.deepEqual([...replayedAsOther.reasonCodes], [R.GOVERNED_ACTION_IDEMPOTENCY_CONFLICT]);
    assert.equal((await recordFor(world, REQUEST_ID))?.request.actorId, PMFREAK_ACTOR_ID);
  });

  it('the same key under a different principal is a different request — no collision', async () => {
    const world = buildGovernedWorld();
    const first = await world.orchestrator.govern(IDENTITY, ALLOWED_INTENT);
    const other = await world.orchestrator.govern(identityFor({ principalId: 'principal-other' }), ALLOWED_INTENT);
    assert.notEqual(other.requestId, first.requestId);
    assert.notEqual(other.decision?.decisionId, first.decision?.decisionId);
    assert.equal(other.status, 'executed');
    assert.equal(world.kernelRequests.length, 2);
  });

  it('the same key and principal id in a different organization is a different request — no collision', async () => {
    const store = createInMemoryGovernanceStore();
    const orgA = buildGovernedWorld({ store });
    // One Host has one Kernel id sequence; two test worlds sharing a store must not reuse one.
    const orgB = buildGovernedWorld({ store, organizationId: 'org-beta', kernelIdStart: 1_000 });
    const a = await orgA.orchestrator.govern(IDENTITY, ALLOWED_INTENT);
    const b = await orgB.orchestrator.govern(identityFor({ organizationId: 'org-beta' }), ALLOWED_INTENT);
    assert.notEqual(a.requestId, b.requestId);
    assert.equal(a.status, 'executed');
    assert.equal(b.status, 'executed', 'no idempotency conflict across tenants');
    const recordB = await store.getByRequestId({ system: false, organizationId: 'org-beta' }, b.requestId ?? '');
    assert.equal(recordB?.request.organizationId, 'org-beta');
    assert.equal(await store.getByRequestId({ system: false, organizationId: 'org-beta' }, a.requestId ?? ''), null, 'tenant A’s record is invisible to tenant B');
  });

  it('two concurrent calls for one logical request invoke the adapter at most once', async () => {
    const world = buildGovernedWorld();
    const results = await Promise.all([world.orchestrator.govern(IDENTITY, ALLOWED_INTENT), world.orchestrator.govern(IDENTITY, ALLOWED_INTENT)]);
    assert.equal(world.adapter.callCount, 1);
    const statuses = results.map((result) => result.status).sort();
    assert.ok(statuses.includes('executed'));
    for (const status of statuses) assert.ok(status === 'executed' || status === 'execution_unconfirmed', status);
    const summaries = await world.rawStore.query({ system: false, organizationId: ORG }, { requestId: REQUEST_ID });
    assert.equal(summaries.records.length, 1);
  });
});

describe('Governed action — GOV-ACT-07: the ACE exercise gate still decides whether anything runs', () => {
  it('a grant revoked between issuance and exercise → withheld by exercise, no adapter', async () => {
    const world = buildGovernedWorld({
      beforeAssess: async ({ ace }, grantId) => {
        await ace.revokeGrant({ grantId, reason: 'manual-revocation', issuerRef: 'operator-1' });
      },
    });
    const result = await world.orchestrator.govern(IDENTITY, ALLOWED_INTENT);
    assert.equal(withheldBy(result), 'exercise');
    assert.ok(result.reasonCodes.includes(GRANT_EXERCISE_REASON_CODES.GRANT_EXERCISE_REVOKED));
    assert.equal(world.adapter.callCount, 0);
  });

  it('a grant that expires before exercise → withheld by exercise, no adapter', async () => {
    const world = buildGovernedWorld({
      beforeAssess: async ({ clock }) => {
        clock.advance(11 * 60 * 1000);
      },
    });
    const result = await world.orchestrator.govern(IDENTITY, ALLOWED_INTENT);
    assert.equal(withheldBy(result), 'exercise');
    assert.ok(result.reasonCodes.includes(GRANT_EXERCISE_REASON_CODES.GRANT_EXERCISE_EXPIRED));
    assert.equal(world.adapter.callCount, 0);
  });

  it('an amount beyond the grant → withheld by exercise, no adapter', async () => {
    // The trusted policy narrows the grant below the amount the caller intends
    // — beneath the durable authority ceiling (P10), which alone would allow it.
    const world = buildGovernedWorld({
      monetary: DRAFTING_IS_FINANCIAL,
      financialAuthority: monetaryAuthority('1000'),
      grantPolicy: (query) => ({ ...EVALUATED_AT_POLICY(query)!, requestedBounds: { amount: { kind: 'ceiling', limit: '100', unit: 'USD' } } }),
    });
    const result = await world.orchestrator.govern(IDENTITY, { ...ALLOWED_INTENT, amount: { value: '250', currency: 'USD' } });
    assert.equal(withheldBy(result), 'exercise', JSON.stringify(result));
    assert.ok(result.reasonCodes.includes(GRANT_EXERCISE_REASON_CODES.GRANT_EXERCISE_AMOUNT_EXCEEDED));
    assert.equal(world.adapter.callCount, 0);
  });

  it('GOV-ACT-09: evidence rows grant nothing — a forged authorization reference cannot be exercised', async () => {
    const world = buildGovernedWorld();
    const denied = await world.orchestrator.govern(identityFor({ actorId: DENIED_ACTOR }), DENIED_INTENT);
    const evaluationId = denied.decision?.evaluationId ?? '';
    const forgedGrantId = 'aoc.grant:00000000000000000000000000000000';
    await world.rawStore.appendReference({ system: false, organizationId: ORG }, {
      referenceId: 'forged-ref-1',
      evaluationId,
      referenceType: 'authorization_artifact',
      externalId: forgedGrantId,
      createdAt: NOW,
    });
    const outcome = await world.ace.exercise({
      boundedGrantId: forgedGrantId,
      subject: DENIED_ACTOR,
      action: DENIED_INTENT.action,
      resource: DENIED_INTENT.resource,
      correlation: { requestId: denied.requestId ?? '', decisionId: denied.decision?.decisionId ?? '', action: DENIED_INTENT.action, resourceScope: DENIED_INTENT.resource },
      executionId: 'exec-forged',
    });
    assert.equal(outcome.status, 'withheld');
    assert.deepEqual([...outcome.assessment.reasonCodes], [GRANT_EXERCISE_REASON_CODES.GRANT_EXERCISE_NOT_FOUND]);
    assert.equal(world.adapter.callCount, 0);
  });
});

describe('Governed action — a recorded execution is replayed before any mutable gate', () => {
  it('executed and recorded; the grant policy then yields nothing → the retry still reports the recorded execution', async () => {
    let policyAvailable = true;
    const world = buildGovernedWorld({ grantPolicy: (query) => (policyAvailable ? EVALUATED_AT_POLICY(query) : undefined) });
    const first = await world.orchestrator.govern(IDENTITY, ALLOWED_INTENT);
    assert.equal(first.status, 'executed');
    assert.ok(first.status === 'executed');
    assert.equal(first.outcomeRecorded, true);

    policyAvailable = false;
    world.clock.advance(60_000);
    const retry = await world.orchestrator.govern(IDENTITY, ALLOWED_INTENT);
    assert.equal(retry.status, 'executed', JSON.stringify(retry));
    assert.ok(retry.status === 'executed');
    assert.equal(retry.replayed, true);
    assert.equal(retry.outcomeRecorded, true);
    assert.equal(retry.executionId, first.executionId);
    assert.equal(world.adapter.callCount, 1);
    assert.equal(world.issueOutcomes.length, 1, 'no issuance on replay');
  });

  it('executed and recorded; source revalidation and the authority binding would now refuse → the retry reports the recorded outcome and issues nothing', async () => {
    let authorityStands = true;
    const world = buildGovernedWorld({
      resolveAuthorityBinding: () => (authorityStands ? NO_TEMPORAL_BOUND : undefined),
      revalidateSource: (_correlation, self) => (authorityStands ? unchangedCurrentSource(self) : undefined),
    });
    const first = await world.orchestrator.govern(IDENTITY, ALLOWED_INTENT);
    assert.equal(first.status, 'executed');

    authorityStands = false;
    const retry = await world.orchestrator.govern(IDENTITY, ALLOWED_INTENT);
    assert.equal(retry.status, 'executed', JSON.stringify(retry));
    assert.ok(retry.status === 'executed');
    assert.equal(retry.replayed, true);
    assert.equal(world.adapter.callCount, 1);
    assert.equal(world.log.entries.filter((entry) => entry === 'grantStore.issue').length, 1, 'no new grant is issued');
    assert.equal(world.revalidatedSources.length, 1, 'revalidation is not consulted on replay');
  });

  it('a recorded execution failure is replayed as that failure — no re-issuance, no adapter call', async () => {
    const world = buildGovernedWorld({ adapterBehaviour: () => ({ outcome: 'failed', reason: 'PROVIDER_REJECTED' }) });
    const first = await world.orchestrator.govern(IDENTITY, ALLOWED_INTENT);
    assert.equal(first.status, 'execution_failed');

    const retry = await world.orchestrator.govern(IDENTITY, ALLOWED_INTENT);
    assert.equal(retry.status, 'execution_failed');
    assert.ok(retry.status === 'execution_failed');
    assert.equal(retry.failure, 'PROVIDER_REJECTED');
    assert.deepEqual([...retry.reasonCodes], ['PROVIDER_REJECTED']);
    assert.equal(retry.replayed, true);
    assert.equal(retry.outcomeRecorded, true);
    assert.equal(world.adapter.callCount, 1);
    assert.equal(world.issueOutcomes.length, 1);
  });
});

describe('Governed action — a withheld exercise keeps its reasons on replay', () => {
  it('exercise withheld (revoked after the claim) → reasons persisted → the retry reports the same reasons', async () => {
    let revokeOnce = true;
    const world = buildGovernedWorld({
      beforeExercise: async ({ ace }, grantId) => {
        if (!revokeOnce) return;
        revokeOnce = false;
        await ace.revokeGrant({ grantId, reason: 'manual-revocation', issuerRef: 'operator-1' });
      },
    });
    const first = await world.orchestrator.govern(IDENTITY, ALLOWED_INTENT);
    assert.equal(withheldBy(first), 'exercise');
    assert.deepEqual([...first.reasonCodes], [GRANT_EXERCISE_REASON_CODES.GRANT_EXERCISE_REVOKED]);

    const record = await recordFor(world, REQUEST_ID);
    assert.deepEqual(
      record?.references.map((reference) => reference.externalVersion ?? reference.referenceType),
      // `withheld:<layer>:<CODE>`. The layer is recorded rather than inferred
      // from the codes, because two layers can withhold an effect and a replay
      // must report the one that actually did.
      ['authorization_artifact', 'attempt', `withheld:grant-exercise:${GRANT_EXERCISE_REASON_CODES.GRANT_EXERCISE_REVOKED}`],
    );

    const retry = await world.orchestrator.govern(IDENTITY, ALLOWED_INTENT);
    assert.equal(withheldBy(retry), 'exercise');
    assert.deepEqual([...retry.reasonCodes], [...first.reasonCodes]);
    assert.equal(retry.executionId, first.executionId);
    assert.equal(world.adapter.callCount, 0);
    assert.equal(world.issueOutcomes.length, 1);
  });

  it('several reasons survive in their assessed order (expired after the claim)', async () => {
    let expireOnce = true;
    const world = buildGovernedWorld({
      beforeExercise: async ({ ace, clock }, grantId) => {
        if (!expireOnce) return;
        expireOnce = false;
        clock.advance(11 * 60 * 1000);
        await ace.revokeGrant({ grantId, reason: 'manual-revocation', issuerRef: 'operator-1' });
      },
    });
    const first = await world.orchestrator.govern(IDENTITY, ALLOWED_INTENT);
    assert.equal(withheldBy(first), 'exercise');
    assert.ok(first.reasonCodes.length >= 2, JSON.stringify(first.reasonCodes));
    const retry = await world.orchestrator.govern(IDENTITY, ALLOWED_INTENT);
    assert.deepEqual([...retry.reasonCodes], [...first.reasonCodes]);
    assert.equal(world.adapter.callCount, 0);
  });

  it('a recorded withheld row that does not decode exactly is never reported as a withheld refusal', async () => {
    // The attempt is claimed, then the exercise port fails: an attempt with no outcome.
    const allowedWorld = buildGovernedWorld({
      // Legacy rows are forged below: model history written before P11, which has no P11 record.
      executionOutcomes: preP11History(),
      beforeExercise: async () => {
        throw new Error('the exercise port is unreachable');
      },
    });
    const unconfirmed = await allowedWorld.orchestrator.govern(IDENTITY, ALLOWED_INTENT);
    assert.equal(unconfirmed.status, 'execution_unconfirmed');
    const record = await recordFor(allowedWorld, REQUEST_ID);
    assert.ok(record !== null && unconfirmed.executionId !== undefined);
    // A hand-written outcome row naming no known reason: evidence cannot manufacture an explanation.
    await allowedWorld.rawStore.appendReference({ system: false, organizationId: ORG }, {
      referenceId: executionOutcomeReferenceId(unconfirmed.executionId),
      evaluationId: record.evaluation.evaluationId,
      referenceType: 'execution_record',
      externalId: unconfirmed.executionId,
      externalVersion: 'withheld:NOT_A_REASON',
      createdAt: NOW,
    });
    const retry = await allowedWorld.orchestrator.govern(IDENTITY, ALLOWED_INTENT);
    assert.equal(retry.status, 'execution_unconfirmed');
    assert.equal(allowedWorld.adapter.callCount, 0);
  });

  it('a row naming a layer it did not come from, or a code from the other layer, decodes as nothing', async () => {
    // Every one of these is a well-formed-looking string that must not be read
    // back as a withholding reason: a code from the wrong vocabulary, an
    // invented layer, and an empty code list.
    for (const [index, forged] of [
      'withheld:grant-exercise:EMERGENCY_CONTROL_ACTIVE',
      'withheld:emergency-control:GRANT_EXERCISE_REVOKED',
      'withheld:made-up-layer:GRANT_EXERCISE_REVOKED',
      'withheld:emergency-control:',
      'withheld:',
    ].entries()) {
      const world = buildGovernedWorld({
        // Legacy rows are forged below: model history written before P11, which has no P11 record.
        executionOutcomes: preP11History(),
        beforeExercise: async () => {
          throw new Error('the exercise port is unreachable');
        },
      });
      const intent = { ...ALLOWED_INTENT, idempotencyKey: `key-forged-${index}` };
      const unconfirmed = await world.orchestrator.govern(IDENTITY, intent);
      assert.equal(unconfirmed.status, 'execution_unconfirmed');
      const record = await recordFor(world, unconfirmed.requestId ?? '');
      assert.ok(record !== null && unconfirmed.executionId !== undefined);
      await world.rawStore.appendReference({ system: false, organizationId: ORG }, {
        referenceId: executionOutcomeReferenceId(unconfirmed.executionId),
        evaluationId: record.evaluation.evaluationId,
        referenceType: 'execution_record',
        externalId: unconfirmed.executionId,
        externalVersion: forged,
        createdAt: NOW,
      });
      const retry = await world.orchestrator.govern(IDENTITY, intent);
      assert.equal(retry.status, 'execution_unconfirmed', `'${forged}' must not decode into a withholding`);
      assert.equal(world.adapter.callCount, 0);
    }
  });

  it('the Prompt 3 unlayered form still replays, as the only layer that could have written it', async () => {
    const world = buildGovernedWorld({
      // Legacy rows are forged below: model history written before P11, which has no P11 record.
      executionOutcomes: preP11History(),
      beforeExercise: async () => {
        throw new Error('the exercise port is unreachable');
      },
    });
    const intent = { ...ALLOWED_INTENT, idempotencyKey: 'key-legacy-form' };
    const unconfirmed = await world.orchestrator.govern(IDENTITY, intent);
    const record = await recordFor(world, unconfirmed.requestId ?? '');
    assert.ok(record !== null && unconfirmed.executionId !== undefined);
    await world.rawStore.appendReference({ system: false, organizationId: ORG }, {
      referenceId: executionOutcomeReferenceId(unconfirmed.executionId),
      evaluationId: record.evaluation.evaluationId,
      referenceType: 'execution_record',
      externalId: unconfirmed.executionId,
      externalVersion: `withheld:${GRANT_EXERCISE_REASON_CODES.GRANT_EXERCISE_REVOKED}`,
      createdAt: NOW,
    });
    const retry = await world.orchestrator.govern(IDENTITY, intent);
    assert.equal(withheldBy(retry), 'exercise');
    assert.deepEqual([...retry.reasonCodes], [GRANT_EXERCISE_REASON_CODES.GRANT_EXERCISE_REVOKED]);
    assert.equal(world.adapter.callCount, 0);
  });
});

describe('Governed action — an own "__proto__" key in the asserted context is data', () => {
  const contextWith = (topLevel: unknown, nested: unknown): unknown =>
    JSON.parse(
      JSON.stringify({ ...ALLOWED_INTENT, assertedContext: { ...ALLOWED_INTENT.assertedContext, nested: { keep: 1 } } })
        .replace('"nested":{', `"__proto__":${JSON.stringify(topLevel)},"nested":{"__proto__":${JSON.stringify(nested)},`),
    ) as unknown;

  it('top-level and nested own "__proto__" keys survive validation as own enumerable data, and no prototype moves', () => {
    const raw = contextWith({ polluted: true }, 'nested-value') as { assertedContext: Record<string, unknown> };
    assert.ok(Object.hasOwn(raw.assertedContext, '__proto__'), 'fixture: JSON.parse defines an own key');

    const validation = validateGovernedActionIntent(raw, TEST_MONETARY);
    assert.ok(validation.valid, JSON.stringify(validation));
    const context = validation.intent.assertedContext as Record<string, unknown>;
    assert.ok(Object.hasOwn(context, '__proto__'));
    assert.ok(Object.prototype.propertyIsEnumerable.call(context, '__proto__'));
    assert.deepEqual(Object.getOwnPropertyDescriptor(context, '__proto__')?.value, { polluted: true });
    assert.equal(Object.getPrototypeOf(context), Object.prototype, 'the copy keeps an ordinary prototype');
    assert.equal((context as { polluted?: unknown }).polluted, undefined);

    const nested = context['nested'] as Record<string, unknown>;
    assert.ok(Object.hasOwn(nested, '__proto__'));
    assert.ok(Object.prototype.propertyIsEnumerable.call(nested, '__proto__'));
    assert.equal(Object.getOwnPropertyDescriptor(nested, '__proto__')?.value, 'nested-value');
    assert.equal(Object.getPrototypeOf(nested), Object.prototype);
    assert.equal(nested['keep'], 1);

    assert.equal(({} as { polluted?: unknown }).polluted, undefined, 'Object.prototype is untouched');
  });

  it('the Kernel request carries the value, and it is covered by the payload digest', async () => {
    const world = buildGovernedWorld();
    const result = await world.orchestrator.govern(IDENTITY, contextWith({ marker: 'a' }, 'n'));
    assert.equal(result.status, 'executed', JSON.stringify(result));
    const [request] = world.kernelRequests;
    assert.ok(request?.context !== undefined);
    assert.deepEqual(Object.getOwnPropertyDescriptor(request.context, '__proto__')?.value, { marker: 'a' });
    assert.equal(Object.getOwnPropertyDescriptor(request.context['nested'] as object, '__proto__')?.value, 'n');

    // The Kernel evaluated it — its own request snapshot kept the key — and the
    // committed record's payload digest is over the request that carries it.
    const record = await recordFor(world, REQUEST_ID);
    assert.equal(record?.request.payloadDigest, computeGovernanceRequestPayloadDigest(request));

    const withoutValue = { ...request, context: { ...request.context } };
    delete (withoutValue.context as Record<string, unknown>)['__proto__'];
    assert.equal(Object.hasOwn(withoutValue.context, '__proto__'), false);
    assert.notEqual(computeGovernanceRequestPayloadDigest(request), computeGovernanceRequestPayloadDigest(withoutValue));
  });

  it('two contexts differing only in "__proto__" are different payloads — the second is an idempotency conflict, not a replay', async () => {
    const world = buildGovernedWorld();
    const first = await world.orchestrator.govern(IDENTITY, contextWith({ marker: 'a' }, 'n'));
    assert.equal(first.status, 'executed', JSON.stringify(first));
    const second = await world.orchestrator.govern(IDENTITY, contextWith({ marker: 'b' }, 'n'));
    assert.equal(second.status, 'rejected');
    assert.deepEqual([...second.reasonCodes], [R.GOVERNED_ACTION_IDEMPOTENCY_CONFLICT]);
    const nestedOnly = await world.orchestrator.govern(IDENTITY, contextWith({ marker: 'a' }, 'other'));
    assert.deepEqual([...nestedOnly.reasonCodes], [R.GOVERNED_ACTION_IDEMPOTENCY_CONFLICT]);
    const same = await world.orchestrator.govern(IDENTITY, contextWith({ marker: 'a' }, 'n'));
    assert.equal(same.decision?.decisionId, first.decision?.decisionId, 'the identical payload is still the same logical request');
    assert.equal(world.kernelRequests.length, 1);
  });
});

describe('Governed action — P6: an adapter-reported unconfirmed effect is recorded, replayed and never retried', () => {
  async function referencesOf(world: GovernedWorld, requestId: string): Promise<readonly string[]> {
    const record = await recordFor(world, requestId);
    assert.ok(record !== null);
    return record.references.map((reference) => reference.externalVersion ?? reference.referenceType);
  }

  it('an unconfirmed adapter result is execution_unconfirmed with its own reason code, and a canonical outcome row naming the adapter', async () => {
    const world = buildGovernedWorld({ adapterBehaviour: () => ({ outcome: 'unconfirmed', detail: 'lost after send' }) });
    const result = await world.orchestrator.govern(IDENTITY, ALLOWED_INTENT);
    assert.equal(result.status, 'execution_unconfirmed');
    assert.deepEqual([...result.reasonCodes], [R.GOVERNED_ACTION_EXECUTION_OUTCOME_UNCONFIRMED]);
    assert.equal(world.adapter.callCount, 1);
    assert.deepEqual(await referencesOf(world, REQUEST_ID), ['authorization_artifact', 'attempt', `execution-unconfirmed@${world.adapter.adapterId}`]);
    assert.equal(JSON.stringify(result).includes('lost after send'), false, 'adapter detail is not echoed to the consumer');
    for (const key of ['failure', 'providerRef', 'replayed', 'outcomeRecorded']) assert.equal(key in result, false, `the unchanged execution_unconfirmed shape has no ${key}`);
  });

  it('the write-ahead claim is still appended before the adapter runs', async () => {
    const world = buildGovernedWorld({ adapterBehaviour: () => ({ outcome: 'unconfirmed' }) });
    await world.orchestrator.govern(IDENTITY, ALLOWED_INTENT);
    const claim = world.log.indexOf('store.appendReference:execution_record:attempt');
    const call = world.log.indexOf('adapter.execute');
    assert.ok(claim !== -1 && call !== -1 && claim < call);
  });

  it('replaying a recorded unconfirmed outcome answers from the record — the adapter is not invoked again', async () => {
    const world = buildGovernedWorld({ adapterBehaviour: () => ({ outcome: 'unconfirmed' }) });
    await world.orchestrator.govern(IDENTITY, ALLOWED_INTENT);
    const replay = await world.orchestrator.govern(IDENTITY, ALLOWED_INTENT);
    assert.equal(replay.status, 'execution_unconfirmed');
    assert.deepEqual([...replay.reasonCodes], [R.GOVERNED_ACTION_EXECUTION_OUTCOME_UNCONFIRMED]);
    assert.equal(world.adapter.callCount, 1);
  });

  it('under routing, the row names the child that may have acted, and a child cannot forge it', async () => {
    const child = createRecordingExecutionAdapter(() => ({ outcome: 'unconfirmed', adapterId: 'someone-else' }));
    const named: ExecutionAdapter = { adapterId: 'adapter-a', execute: (action) => child.execute(action) };
    const registry = createExecutionAdapterRegistry({ adapterId: 'router', adapters: [named], selectAdapter: () => 'adapter-a' });
    const world = buildGovernedWorld({ executionAdapter: registry });
    const result = await world.orchestrator.govern(IDENTITY, ALLOWED_INTENT);
    assert.equal(result.status, 'execution_unconfirmed');
    assert.deepEqual(await referencesOf(world, REQUEST_ID), ['authorization_artifact', 'attempt', 'execution-unconfirmed@adapter-a']);
    assert.equal(JSON.stringify(result).includes('adapter-a'), false, 'no adapter identity reaches the customer result');
  });

  it('a claim with no outcome row stays distinguishable: ALREADY_ATTEMPTED, not OUTCOME_UNCONFIRMED — and prior() says why', async () => {
    const world = buildGovernedWorld({
      beforeExercise: async () => {
        throw new Error('crash between claim and outcome');
      },
    });
    const crashed = await world.orchestrator.govern(IDENTITY, ALLOWED_INTENT);
    assert.equal(crashed.status, 'execution_unconfirmed');
    assert.deepEqual([...crashed.reasonCodes], [R.GOVERNED_ACTION_EXECUTION_ALREADY_ATTEMPTED]);
    const record = await recordFor(world, REQUEST_ID);
    assert.ok(record !== null && crashed.executionId !== undefined);
    const ledger = createExecutionLedger(world.rawStore, { system: false, organizationId: ORG, actorId: PMFREAK_ACTOR_ID }, () => NOW);
    assert.deepEqual(ledger.prior(record, crashed.executionId), { attempted: true }, 'no outcome row: nothing is known');

    const recorded = buildGovernedWorld({ adapterBehaviour: () => ({ outcome: 'unconfirmed' }) });
    const unconfirmed = await recorded.orchestrator.govern(IDENTITY, ALLOWED_INTENT);
    const recordedRecord = await recordFor(recorded, REQUEST_ID);
    assert.ok(recordedRecord !== null && unconfirmed.executionId !== undefined);
    const recordedLedger = createExecutionLedger(recorded.rawStore, { system: false, organizationId: ORG, actorId: PMFREAK_ACTOR_ID }, () => NOW);
    assert.deepEqual({ ...recordedLedger.prior(recordedRecord, unconfirmed.executionId) }, { attempted: true, outcome: EXECUTION_UNCONFIRMED_OUTCOME, adapterId: recorded.adapter.adapterId });
  });

  it('a malformed or tampered unconfirmed row never becomes executed or failed, and never permits a second effect', async () => {
    for (const [index, forged] of [
      'execution-unconfirmed:PROVIDER_REJECTED',
      'execution-unconfirmed@',
      'execution-unconfirmed@bad id!',
      'EXECUTION-UNCONFIRMED',
      'execution-unconfirmedexecuted',
      'executed-unconfirmed',
      ' execution-unconfirmed',
    ].entries()) {
      const world = buildGovernedWorld({
        // Legacy rows are forged below: model history written before P11, which has no P11 record.
        executionOutcomes: preP11History(),
        beforeExercise: async () => {
          throw new Error('the exercise port is unreachable');
        },
      });
      const intent = { ...ALLOWED_INTENT, idempotencyKey: `key-tampered-unconfirmed-${index}` };
      const first = await world.orchestrator.govern(IDENTITY, intent);
      const record = await recordFor(world, first.requestId ?? '');
      assert.ok(record !== null && first.executionId !== undefined);
      await world.rawStore.appendReference({ system: false, organizationId: ORG }, {
        referenceId: executionOutcomeReferenceId(first.executionId),
        evaluationId: record.evaluation.evaluationId,
        referenceType: 'execution_record',
        externalId: first.executionId,
        externalVersion: forged,
        createdAt: NOW,
      });
      const retry = await world.orchestrator.govern(IDENTITY, intent);
      assert.equal(retry.status, 'execution_unconfirmed', `'${forged}'`);
      assert.deepEqual([...retry.reasonCodes], [R.GOVERNED_ACTION_EXECUTION_ALREADY_ATTEMPTED], `'${forged}' is not the canonical form and decodes as nothing`);
      assert.equal(world.adapter.callCount, 0);
    }
  });

  it('the canonical form with an attribution suffix replays as OUTCOME_UNCONFIRMED', async () => {
    const world = buildGovernedWorld({
      // Legacy rows are forged below: model history written before P11, which has no P11 record.
      executionOutcomes: preP11History(),
      beforeExercise: async () => {
        throw new Error('the exercise port is unreachable');
      },
    });
    const first = await world.orchestrator.govern(IDENTITY, ALLOWED_INTENT);
    const record = await recordFor(world, REQUEST_ID);
    assert.ok(record !== null && first.executionId !== undefined);
    await world.rawStore.appendReference({ system: false, organizationId: ORG }, {
      referenceId: executionOutcomeReferenceId(first.executionId),
      evaluationId: record.evaluation.evaluationId,
      referenceType: 'execution_record',
      externalId: first.executionId,
      externalVersion: 'execution-unconfirmed@erp.invoice-payment',
      createdAt: NOW,
    });
    const retry = await world.orchestrator.govern(IDENTITY, ALLOWED_INTENT);
    assert.deepEqual([...retry.reasonCodes], [R.GOVERNED_ACTION_EXECUTION_OUTCOME_UNCONFIRMED]);
    assert.equal(world.adapter.callCount, 0);
  });

  it('an unconfirmed outcome whose row cannot be written is still unconfirmed, flagged unrecorded, and never retried', async () => {
    const world = buildGovernedWorld({ adapterBehaviour: () => ({ outcome: 'unconfirmed' }), executionOutcomes: faultyOutcomes({ recordTerminal: true }) });
    const result = await world.orchestrator.govern(IDENTITY, ALLOWED_INTENT);
    assert.equal(result.status, 'execution_unconfirmed');
    assert.deepEqual([...result.reasonCodes], [R.GOVERNED_ACTION_EXECUTION_OUTCOME_UNCONFIRMED, R.GOVERNED_ACTION_EXECUTION_OUTCOME_UNRECORDED]);
    const retry = await world.orchestrator.govern(IDENTITY, ALLOWED_INTENT);
    assert.equal(retry.status, 'execution_unconfirmed');
    assert.deepEqual([...retry.reasonCodes], [R.GOVERNED_ACTION_EXECUTION_ALREADY_ATTEMPTED]);
    assert.equal(world.adapter.callCount, 1);
  });

  it('no ledger row authorizes anything: the two unconfirmed codes are orchestration-owned and neither is a Kernel status', () => {
    for (const code of [R.GOVERNED_ACTION_EXECUTION_OUTCOME_UNCONFIRMED, R.GOVERNED_ACTION_EXECUTION_ALREADY_ATTEMPTED]) {
      assert.ok(code.startsWith('GOVERNED_ACTION_'));
      for (const status of ['allowed', 'denied', 'approval_required', 'indeterminate']) assert.equal(code.toLowerCase().includes(status), false);
    }
  });
});
