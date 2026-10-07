import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { ValidatedExecutionAction } from '../../features/execution-runtime/index.js';
import type { KernelEvaluationRequest } from '../../kernel/index.js';
import { GOVERNED_ACTION_REASON_CODES as R } from '../governed-action/contracts.js';
import { deriveBusinessIntentId, deriveGovernedActionRequestId, reconsiderationLinkReferenceId, reconsiderationRealizationReferenceId } from '../governed-action/identifiers.js';
import { DURABLE_FIXTURE_OPERATOR, buildDurableAuthorityPayloads } from '../kernel-authority/fixtures/durable-authority.fixture.js';
import type { ObligationDischargeRecordInput, ObligationDischargeWriterContext } from '../obligation-discharge/index.js';
import {
  GOVERNANCE,
  LEGACY_KEY,
  ORG,
  PAYABLES,
  PAYABLES_WORLD,
  SETTLE,
  TRUST_DOMAIN,
  Workspace,
  boot,
  call,
  committedRecord,
  createContextTable,
  govern,
  governedFile,
  provision,
  secureEnv,
  settle,
  type Booted,
  type ContextTable,
  type Reply,
} from './core04-host-fixture.js';

/**
 * LAND-01 — linked reconsideration on the shipped, rail-neutral Host.
 *
 * The CORE-04 Host (SQLite, durable authority, policy, trusted context, the
 * recording adapter) with no rail of its own. A settlement is denied because
 * the ERP does not attest the invoice; the ERP later does, and the agent
 * explicitly reconsiders the denied request as the same business intent:
 *
 * ```
 * original (denied, INVOICE_NOT_FOUND) ── committed, never written to
 *   ▲ reconsideration_link (on the new evaluation)
 * reconsideration ── own key ── fresh Kernel evaluation ── allowed
 *   └─ realization marker (unique per original) ── grant ── adapter, once
 * ```
 *
 * Every refusal is proven at the HTTP boundary with its exact reason code and
 * with the adapter's call count unchanged; the lineage is proven on the
 * committed records and on the ASSURE-01 trace a third party fetches.
 */

const workspace = new Workspace();
after(() => workspace.cleanup());

const OTHER_KEY = 'FRONTERA_LAND01_OTHER_AGENT_KEY_SENTINEL_91c3e7';
const OTHER_ACTOR = 'actor-land01-other';
const OTHER_SUBJECT = { system: 'core04-app', subjectId: 'land01-other-1' } as const;
const FOREIGN_ORG = 'org-land01-foreign';
const OPERATOR = `Bearer ${LEGACY_KEY}`;

/** The ERP does not attest the invoice: the policy's own `INVOICE_NOT_FOUND`. */
const NO_INVOICE = PAYABLES_WORLD.map((reading) => (reading.key === 'invoice.exists' ? { ...reading, value: false } : reading));

const requestIdOf = (reply: Reply): string => {
  const requestId = reply.body['requestId'];
  assert.equal(typeof requestId, 'string', reply.text);
  return requestId as string;
};
const decisionOf = (reply: Reply) => reply.body['decision'] as { readonly decisionId: string; readonly evaluationId: string; readonly status: string };
const codesOf = (reply: Reply) => (reply.body['reasonCodes'] as readonly string[] | undefined) ?? [];
const reconsider = (of: string, reason = 'context-changed') => ({ reconsideration: { of, reason } });

function assertRefused(reply: Reply, code: string, label: string): void {
  assert.equal(reply.body['status'], 'rejected', `${label}: ${reply.text}`);
  assert.deepEqual(codesOf(reply), [code], label);
}

async function provisionOtherActor(booted: Booted): Promise<void> {
  const service = booted.host.enterprise.kernelAuthorityProvisioning;
  assert.ok(service !== undefined);
  const payloads = buildDurableAuthorityPayloads(ORG, TRUST_DOMAIN);
  await service.provisionActor(DURABLE_FIXTURE_OPERATOR, { ...payloads.agentActor, actorId: OTHER_ACTOR, displayName: 'Other agent', externalSubject: OTHER_SUBJECT });
}

async function fetchTrace(baseUrl: string, requestId: string) {
  const reply = await call(baseUrl, 'GET', `/api/evidence/traces/${encodeURIComponent(requestId)}?level=AUDITOR`, { authorization: OPERATOR });
  assert.equal(reply.status, 200, reply.text);
  return reply.body['trace'] as { readonly stages: Record<string, Record<string, unknown>> };
}

async function verifyTrace(baseUrl: string, requestId: string) {
  const reply = await call(baseUrl, 'GET', `/api/evidence/traces/${encodeURIComponent(requestId)}/verify`, { authorization: OPERATOR });
  assert.equal(reply.status, 200, reply.text);
  return reply.body['checks'] as readonly { readonly check: string; readonly status: string; readonly detail?: string }[];
}

function assertAllPass(checks: readonly { readonly check: string; readonly status: string; readonly detail?: string }[], label: string): void {
  const failures = checks.filter((entry) => entry.status === 'fail');
  assert.deepEqual(failures, [], `${label}: ${JSON.stringify(failures)}`);
}

/** A genuine committed record of another organization, in this Host's own Governance Store. */
async function plantForeignOriginal(booted: Booted): Promise<string> {
  const requestId = deriveGovernedActionRequestId({ organizationId: FOREIGN_ORG, principalId: 'principal-agent', idempotencyKey: 'land01-foreign' });
  const request: KernelEvaluationRequest = {
    requestId,
    actor: { id: 'actor-agent', trustDomainId: TRUST_DOMAIN, type: 'agent' },
    action: { type: SETTLE, resourceScope: PAYABLES },
    organization: { id: FOREIGN_ORG },
    requestedAt: '2026-10-06T00:00:00.000Z',
  };
  await booted.host.enterprise.persistence.appendEvaluation({
    request,
    result: {
      requestId,
      decisionId: 'decision-land01-foreign',
      status: 'denied',
      reasonCodes: ['DOMAIN_POLICY_DENIED'],
      summary: 'Denied.',
      recognition: { performed: true, recognized: true },
      authority: { performed: false },
      policies: [],
      approval: { performed: false, status: 'not_applicable' },
      evidence: [],
      trace: { steps: [{ sequence: 1, operator: 'policy_chain', status: 'failed', reasonCodes: ['DOMAIN_POLICY_DENIED'] }], decisionId: 'decision-land01-foreign', kernelVersion: '1.0.0' },
      evaluatedAt: '2026-10-06T00:00:00.100Z',
      kernelVersion: '1.0.0',
    },
    receivedAt: '2026-10-06T00:00:00.050Z',
    enterpriseContext: { enterpriseVersion: '1.0.0', lifecycleState: 'ready', modules: [], providers: [], environment: 'test' },
    events: [],
    accessContext: { system: true },
  });
  assert.notEqual(await booted.host.enterprise.persistence.getByRequestId({ system: true }, requestId), null, 'the foreign original exists in this very store');
  return requestId;
}

describe('LAND-01 — linked reconsideration of a denied governed action, on the rail-neutral Host', () => {
  let booted: Booted;
  let context: ContextTable;
  let original: Reply;
  let originalId: string;
  let realized: Reply;
  let realizedId: string;

  before(async () => {
    const dir = workspace.dir();
    context = createContextTable();
    const file = governedFile({
      customerPrincipals: [
        { principalId: 'principal-agent', externalSubject: { system: 'core04-app', subjectId: 'agent-1' }, apiKeyEnv: 'FRONTERA_TEST_AGENT_KEY' },
        { principalId: 'principal-other', externalSubject: OTHER_SUBJECT, apiKeyEnv: 'FRONTERA_TEST_OTHER_KEY' },
      ],
    });
    booted = await boot(workspace, { ...secureEnv(dir, file), FRONTERA_TEST_OTHER_KEY: OTHER_KEY }, { context });
    await provision(booted.host);
    await provisionOtherActor(booted);

    // 1. The original: the ERP does not attest the invoice — denied by policy, nothing executed.
    context.set(NO_INVOICE);
    original = await govern(booted.baseUrl, settle(), 'land01-original');
    assert.equal(original.body['status'], 'denied', original.text);
    assert.ok(codesOf(original).includes('DOMAIN_POLICY_DENIED'), original.text);
    originalId = requestIdOf(original);
    assert.equal(booted.calls.length, 0);
  });

  it('a reconsideration before governance state changed is a linked, fresh denial — and realizes nothing', async () => {
    const early = await govern(booted.baseUrl, { ...settle(), ...reconsider(originalId) }, 'land01-early');
    assert.equal(early.body['status'], 'denied', early.text);
    assert.notEqual(requestIdOf(early), originalId);
    assert.notEqual(decisionOf(early).decisionId, decisionOf(original).decisionId, 'a fresh Kernel decision, never the original one');
    const record = await committedRecord(booted.host, early);
    const link = record.references.find((entry) => entry.referenceId === reconsiderationLinkReferenceId(requestIdOf(early)));
    assert.equal(link?.referenceType, 'reconsideration_link', 'a still-denied reconsideration is still a linked, attributable attempt');
    assert.equal(record.references.some((entry) => entry.referenceId === reconsiderationRealizationReferenceId(originalId)), false, 'a denial claims no realization');
    assert.equal(booted.calls.length, 0);
  });

  it('2–3. after the ERP attests the invoice: a new request id, the same business intent, the original reference and the reason — executed once', async () => {
    context.set(PAYABLES_WORLD);
    const originalRecordBefore = await committedRecord(booted.host, original);

    realized = await govern(booted.baseUrl, { ...settle(), ...reconsider(originalId) }, 'land01-realize');
    assert.equal(realized.body['status'], 'executed', realized.text);
    realizedId = requestIdOf(realized);
    assert.notEqual(realizedId, originalId, 'a new governed request id');
    assert.equal(realizedId, deriveGovernedActionRequestId({ organizationId: ORG, principalId: 'principal-agent', idempotencyKey: 'land01-realize' }));
    assert.equal(decisionOf(realized).status, 'allowed');
    assert.equal(booted.calls.length, 1, 'the adapter ran once, for the realizing reconsideration');

    const businessIntentId = deriveBusinessIntentId({ organizationId: ORG, originalRequestId: originalId });
    const record = await committedRecord(booted.host, realized);
    assert.equal(record.request.correlationId, businessIntentId, 'the committed correlation is the server-derived business-intent id');
    const link = record.references.find((entry) => entry.referenceId === reconsiderationLinkReferenceId(realizedId));
    assert.ok(link !== undefined);
    assert.equal(link.externalId, originalId, 'the original request reference');
    assert.equal(link.externalVersion, decisionOf(original).decisionId, 'the original decision reference');
    assert.equal(link.uri, 'urn:aoc:reconsideration:reason:context-changed', 'the reconsideration reason');
    assert.match(link.digest ?? '', /^sha256:[0-9a-f]{64}$/);
    const marker = record.references.find((entry) => entry.referenceId === reconsiderationRealizationReferenceId(originalId));
    assert.equal(marker?.externalId, originalId, 'this reconsideration holds the original’s one realization');
    assert.ok(record.references.some((entry) => entry.referenceType === 'authorization_artifact'), 'the normal grant path followed');

    // The original is only read, never written to.
    const originalRecordAfter = await committedRecord(booted.host, original);
    assert.deepEqual(originalRecordAfter, originalRecordBefore, 'the original record is byte-for-byte what was committed');
  });

  it('10. the adapter is rail-neutral: it receives exactly what a plain request would, with no lineage field', () => {
    const action = booted.calls[0] as ValidatedExecutionAction;
    assert.equal(action.action, SETTLE);
    assert.equal(action.resource, PAYABLES);
    assert.equal(JSON.stringify(action).includes('reconsideration'), false);
    assert.equal(JSON.stringify(action).includes(originalId), false, 'the adapter learns nothing about the lineage');
  });

  it('4. another organization’s original is simply not found — even though it exists in the same store', async () => {
    const foreignId = await plantForeignOriginal(booted);
    assertRefused(await govern(booted.baseUrl, { ...settle(), ...reconsider(foreignId) }, 'land01-foreign-try'), R.GOVERNED_ACTION_RECONSIDERATION_TARGET_NOT_FOUND, 'cross-organization');
    assert.equal(booted.calls.length, 1);
  });

  it('5. another actor of the same organization may not reconsider this actor’s original', async () => {
    const reply = await call(booted.baseUrl, 'POST', '/api/governed-actions', { authorization: `Bearer ${OTHER_KEY}`, body: { idempotencyKey: 'land01-other-actor', ...settle(), ...reconsider(originalId) } });
    assertRefused(reply, R.GOVERNED_ACTION_RECONSIDERATION_TARGET_OTHER_ACTOR, 'actor substitution');
    assert.equal(booted.calls.length, 1);
  });

  it('6. a missing, malformed or self-naming original is refused before anything is evaluated', async () => {
    assertRefused(await govern(booted.baseUrl, { ...settle(), ...reconsider('aoc.gar:0123456789abcdef0123456789abcdef') }, 'land01-missing'), R.GOVERNED_ACTION_RECONSIDERATION_TARGET_NOT_FOUND, 'missing');
    assertRefused(await govern(booted.baseUrl, { ...settle(), ...reconsider('not-a-request-id') }, 'land01-malformed'), R.GOVERNED_ACTION_INTENT_INVALID, 'malformed id');
    assertRefused(await govern(booted.baseUrl, { ...settle(), ...reconsider(originalId, 'because') }, 'land01-bad-reason'), R.GOVERNED_ACTION_INTENT_INVALID, 'open reason');
    assertRefused(await govern(booted.baseUrl, { ...settle(), reconsideration: { of: originalId, reason: 'context-changed', approved: true } }, 'land01-extra-key'), R.GOVERNED_ACTION_INTENT_INVALID, 'closed shape');
    const selfId = deriveGovernedActionRequestId({ organizationId: ORG, principalId: 'principal-agent', idempotencyKey: 'land01-self' });
    assertRefused(await govern(booted.baseUrl, { ...settle(), ...reconsider(selfId) }, 'land01-self'), R.GOVERNED_ACTION_RECONSIDERATION_TARGET_SELF, 'self');
    assert.equal(await booted.host.enterprise.persistence.getByRequestId({ system: true }, selfId), null, 'a refusal commits nothing');
    assert.equal(booted.calls.length, 1);
  });

  it('a different business intent, a caller-chosen correlation, a reconsideration as target and an allowed original are refused', async () => {
    assertRefused(await govern(booted.baseUrl, { ...settle(501), ...reconsider(originalId) }, 'land01-amount'), R.GOVERNED_ACTION_RECONSIDERATION_INTENT_MISMATCH, 'amount drift');
    assertRefused(await govern(booted.baseUrl, { ...settle(500, 'supplier-y'), ...reconsider(originalId) }, 'land01-destination'), R.GOVERNED_ACTION_RECONSIDERATION_INTENT_MISMATCH, 'counterparty parameter drift');
    assertRefused(await govern(booted.baseUrl, { ...settle(), correlationId: 'caller-chosen', ...reconsider(originalId) }, 'land01-correlation'), R.GOVERNED_ACTION_RECONSIDERATION_INTENT_MISMATCH, 'caller correlation');
    assertRefused(await govern(booted.baseUrl, { ...settle(), ...reconsider(realizedId) }, 'land01-chain'), R.GOVERNED_ACTION_RECONSIDERATION_TARGET_NOT_ORIGINAL, 'chain');
    // H2: an allowed original is not reconsiderable — its own key is its recovery path.
    const allowed = await govern(booted.baseUrl, settle(), 'land01-allowed');
    assert.equal(allowed.body['status'], 'executed', allowed.text);
    assertRefused(await govern(booted.baseUrl, { ...settle(), ...reconsider(requestIdOf(allowed)) }, 'land01-allowed-recon'), R.GOVERNED_ACTION_RECONSIDERATION_TARGET_NOT_WITHHELD, 'allowed original');
    assert.equal(booted.calls.length, 2, 'only the plain allowed request ran');
    // 10. The reconsideration's adapter call has exactly the shape of a plain request's.
    assert.deepEqual(Object.keys(booted.calls[0] as object).sort(), Object.keys(booted.calls[1] as object).sort());
  });

  it('7. a second realization of the same original is withheld before any grant', async () => {
    const second = await govern(booted.baseUrl, { ...settle(), ...reconsider(originalId, 'policy-changed') }, 'land01-second');
    assert.equal(second.body['status'], 'withheld', second.text);
    assert.equal(second.body['withheldBy'], 'reconsideration');
    assert.deepEqual(codesOf(second), [R.GOVERNED_ACTION_RECONSIDERATION_ALREADY_REALIZED]);
    assert.equal(decisionOf(second).status, 'allowed', 'the fresh decision stands; only the realization is refused');
    const record = await committedRecord(booted.host, second);
    assert.equal(record.references.some((entry) => entry.referenceType === 'authorization_artifact'), false, 'no grant');
    assert.equal(booted.calls.length, 2);
  });

  it('8. idempotent replay: the realizing key replays, the original key still says denied, and no committed key can be reused to reconsider', async () => {
    const replay = await govern(booted.baseUrl, { ...settle(), ...reconsider(originalId) }, 'land01-realize');
    assert.equal(replay.body['status'], 'executed', replay.text);
    assert.equal(replay.body['replayed'], true);
    assert.equal(decisionOf(replay).decisionId, decisionOf(realized).decisionId);

    const originalReplay = await govern(booted.baseUrl, settle(), 'land01-original');
    assert.equal(originalReplay.body['status'], 'denied', 'replay of the original never re-evaluates — even though the ERP now attests the invoice');
    assert.equal(decisionOf(originalReplay).decisionId, decisionOf(original).decisionId);

    // The original's own key resolves to the original's own request id: it can only name itself.
    assertRefused(await govern(booted.baseUrl, { ...settle(), ...reconsider(originalId) }, 'land01-original'), R.GOVERNED_ACTION_RECONSIDERATION_TARGET_SELF, 'original key reused');
    // Another committed plain request's key, reused for a reconsideration: never a replay of it.
    const reused = await govern(booted.baseUrl, { ...settle(), ...reconsider(originalId) }, 'land01-allowed');
    assert.equal(reused.body['status'], 'rejected', reused.text);
    assert.deepEqual(codesOf(reused), [R.GOVERNED_ACTION_IDEMPOTENCY_CONFLICT]);
    assert.equal(booted.calls.length, 2);
  });

  it('9. the ASSURE-01 trace exposes the verified lineage — and only on a reconsideration', async () => {
    const trace = await fetchTrace(booted.baseUrl, realizedId);
    const lineage = trace.stages['request']?.['lineage'] as Record<string, unknown> | undefined;
    assert.ok(lineage !== undefined, JSON.stringify(trace.stages['request']));
    assert.equal(lineage['role'], 'reconsideration');
    assert.equal(lineage['businessIntentId'], deriveBusinessIntentId({ organizationId: ORG, originalRequestId: originalId }));
    assert.equal(lineage['reason'], 'context-changed');
    assert.equal(lineage['realizedOriginal'], true);
    const reconsiders = lineage['reconsiders'] as Record<string, unknown>;
    assert.equal(reconsiders['requestId'], originalId);
    assert.equal(reconsiders['decisionId'], decisionOf(original).decisionId);
    assert.equal(reconsiders['evaluationId'], decisionOf(original).evaluationId);
    assert.equal(reconsiders['status'], 'denied', 'the original’s committed status, never rewritten');

    const checks = await verifyTrace(booted.baseUrl, realizedId);
    assertAllPass(checks, 'realizing reconsideration');
    for (const name of ['lineage.original-record', 'lineage.original-identity', 'lineage.original-decision', 'lineage.original-was-withheld', 'lineage.original-is-root', 'lineage.original-never-authorized', 'lineage.same-business-intent', 'lineage.business-intent-id', 'lineage.reason']) {
      assert.equal(checks.find((entry) => entry.check === name)?.status, 'pass', name);
    }
    assert.equal(checks.find((entry) => entry.check === 'lineage.realization-before-authority')?.status, 'pass');

    const second = await fetchTrace(booted.baseUrl, deriveGovernedActionRequestId({ organizationId: ORG, principalId: 'principal-agent', idempotencyKey: 'land01-second' }));
    assert.equal((second.stages['request']?.['lineage'] as Record<string, unknown>)['realizedOriginal'], false);

    const plain = await fetchTrace(booted.baseUrl, originalId);
    assert.equal('lineage' in (plain.stages['request'] ?? {}), false, 'a plain request’s trace carries no lineage');
    assertAllPass(await verifyTrace(booted.baseUrl, originalId), 'original');
    assert.equal((await verifyTrace(booted.baseUrl, originalId)).some((entry) => entry.check.startsWith('lineage.')), false);
  });

  it('a forged lineage fails trace verification: a link row grafted onto a plain request, and an orphan link row', async () => {
    const store = booted.host.enterprise.persistence;
    const genuine = (await committedRecord(booted.host, realized)).references.find((entry) => entry.referenceId === reconsiderationLinkReferenceId(realizedId));
    assert.ok(genuine !== undefined);

    // A plain, executed request grafted into the lineage with a copy of the genuine link's fields.
    const grafted = await govern(booted.baseUrl, settle(), 'land01-grafted');
    assert.equal(grafted.body['status'], 'executed', grafted.text);
    await store.appendReference({ system: true }, {
      referenceId: reconsiderationLinkReferenceId(requestIdOf(grafted)),
      evaluationId: decisionOf(grafted).evaluationId,
      referenceType: 'reconsideration_link',
      externalId: originalId,
      ...(genuine.externalVersion !== undefined ? { externalVersion: genuine.externalVersion } : {}),
      ...(genuine.digest !== undefined ? { digest: genuine.digest } : {}),
      ...(genuine.uri !== undefined ? { uri: genuine.uri } : {}),
      createdAt: new Date().toISOString(),
    });
    const graftedChecks = await verifyTrace(booted.baseUrl, requestIdOf(grafted));
    assert.equal(graftedChecks.find((entry) => entry.check === 'lineage.business-intent-id')?.status, 'fail', 'its committed correlation was never the business-intent id');
    assert.equal(graftedChecks.find((entry) => entry.check === 'lineage.realization-before-authority')?.status, 'fail', 'it holds authority without the realization');

    // A link-typed row that is not this request's own link.
    const orphaned = await govern(booted.baseUrl, settle(), 'land01-orphaned');
    await store.appendReference({ system: true }, {
      referenceId: 'aoc.gar.ref:forged-orphan',
      evaluationId: decisionOf(orphaned).evaluationId,
      referenceType: 'reconsideration_link',
      externalId: originalId,
      createdAt: new Date().toISOString(),
    });
    const orphanChecks = await verifyTrace(booted.baseUrl, requestIdOf(orphaned));
    assert.equal(orphanChecks.find((entry) => entry.check === 'lineage.no-orphan-link-rows')?.status, 'fail');
  });
});

/**
 * H1 / H2 — the realization marker is an exclusive right to realize, taken
 * before issuance; it is not a statement that an effect happened. A
 * reconsideration that claimed it and was then withheld at issuance (here: a
 * blocking obligation) keeps it: another reconsideration is refused, and the
 * holder realizes the intent by retrying under its own key once the gate
 * clears. An original that the Kernel allowed is never reconsiderable; its own
 * key is its recovery path, and it meets the same live gates.
 */
describe('LAND-01 — the realization right survives an issuance-stage withholding, and only its holder can use it', () => {
  /** The settlement profile with a blocking obligation: a gate that withholds at issuance, after the realization claim. */
  const SETTLEMENT_WITH_OBLIGATION = {
    ...GOVERNANCE,
    profiles: (GOVERNANCE.profiles ?? []).map((profile) => (profile.profileId === 'invoice-settlement' ? { ...profile, obligations: [{ obligationType: 'change.approval', blocking: true }] } : profile)),
  };
  const WRITER: ObligationDischargeWriterContext = { system: true, actorId: 'operator:change-board-integration' };
  let observed = Date.now() - 3_600_000;
  const discharge = (requestId: string): ObligationDischargeRecordInput => {
    observed += 1000;
    return {
      correlation: { requestId, action: SETTLE, resourceScope: PAYABLES },
      obligationType: 'change.approval',
      sourceId: 'change-approvals',
      outcome: 'discharged',
      observedAt: new Date(observed).toISOString(),
      reference: 'CAB-LAND01',
      subjectId: 'approver-1',
    };
  };

  it('claimed → withheld by obligations → another reconsideration is ALREADY_REALIZED → the holder’s own retry executes once', async () => {
    const context = createContextTable();
    const booted = await boot(workspace, secureEnv(workspace.dir(), governedFile({ governance: SETTLEMENT_WITH_OBLIGATION })), { context });
    await provision(booted.host);
    const discharges = booted.host.enterprise.obligationDischarges;
    assert.ok(discharges !== undefined);

    context.set(NO_INVOICE);
    const original = await govern(booted.baseUrl, settle(), 'h1-original');
    assert.equal(original.body['status'], 'denied', original.text);
    const originalId = requestIdOf(original);

    context.set(PAYABLES_WORLD);
    const holder = await govern(booted.baseUrl, { ...settle(), ...reconsider(originalId) }, 'h1-holder');
    assert.equal(holder.body['status'], 'withheld', holder.text);
    assert.equal(holder.body['withheldBy'], 'obligations');
    assert.equal(decisionOf(holder).status, 'allowed');
    const holderRecord = await committedRecord(booted.host, holder);
    assert.ok(holderRecord.references.some((entry) => entry.referenceId === reconsiderationRealizationReferenceId(originalId)), 'the right to realize was claimed before issuance');
    assert.equal(holderRecord.references.some((entry) => entry.referenceType === 'authorization_artifact'), false, 'no grant was issued');

    const rival = await govern(booted.baseUrl, { ...settle(), ...reconsider(originalId) }, 'h1-rival');
    assert.equal(rival.body['status'], 'withheld', rival.text);
    assert.equal(rival.body['withheldBy'], 'reconsideration');
    assert.deepEqual(codesOf(rival), [R.GOVERNED_ACTION_RECONSIDERATION_ALREADY_REALIZED]);
    assert.equal(booted.calls.length, 0);

    await discharges.record(WRITER, discharge(requestIdOf(holder)));
    const released = await govern(booted.baseUrl, { ...settle(), ...reconsider(originalId) }, 'h1-holder');
    assert.equal(released.body['status'], 'executed', released.text);
    assert.equal(decisionOf(released).decisionId, decisionOf(holder).decisionId, 'the holder’s committed decision, never re-made');
    assert.equal(booted.calls.length, 1);

    // The rival stays refused even after the gate cleared for the holder: one intent, one realization.
    await discharges.record(WRITER, discharge(requestIdOf(rival)));
    const rivalAgain = await govern(booted.baseUrl, { ...settle(), ...reconsider(originalId) }, 'h1-rival');
    assert.deepEqual(codesOf(rivalAgain), [R.GOVERNED_ACTION_RECONSIDERATION_ALREADY_REALIZED]);
    assert.equal(booted.calls.length, 1);
  });

  it('H2: an allowed original withheld at issuance is not reconsiderable — its own key realizes it once the gate clears', async () => {
    const context = createContextTable();
    const booted = await boot(workspace, secureEnv(workspace.dir(), governedFile({ governance: SETTLEMENT_WITH_OBLIGATION })), { context });
    await provision(booted.host);
    const discharges = booted.host.enterprise.obligationDischarges;
    assert.ok(discharges !== undefined);

    context.set(PAYABLES_WORLD);
    const original = await govern(booted.baseUrl, settle(), 'h2-original');
    assert.equal(original.body['status'], 'withheld', original.text);
    assert.equal(original.body['withheldBy'], 'obligations');
    assertRefused(await govern(booted.baseUrl, { ...settle(), ...reconsider(requestIdOf(original)) }, 'h2-recon'), R.GOVERNED_ACTION_RECONSIDERATION_TARGET_NOT_WITHHELD, 'allowed-but-withheld original');

    await discharges.record(WRITER, discharge(requestIdOf(original)));
    const released = await govern(booted.baseUrl, settle(), 'h2-original');
    assert.equal(released.body['status'], 'executed', released.text);
    assert.equal(booted.calls.length, 1);
  });
});
