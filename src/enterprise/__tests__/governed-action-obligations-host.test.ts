import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import Database from 'better-sqlite3';

import { DURABLE_FIXTURE_OPERATOR } from '../kernel-authority/fixtures/durable-authority.fixture.js';
import { toKernelEvaluationResult } from '../governance-store/store-common.js';
import { ObligationDischargeError, type ObligationDischargeRecordInput, type ObligationDischargeWriterContext } from '../obligation-discharge/index.js';
import {
  ADMIN,
  ADMIN_KEY,
  AGENT_KEY,
  DEPLOY,
  PRODUCTION,
  READ,
  Workspace,
  boot,
  call,
  committedRecord,
  createContextTable,
  govern,
  nextKey,
  provision,
  secureEnv,
  type Booted,
  type Reply,
} from './core04-host-fixture.js';

/**
 * CORE-04 §62 / §63 / §94 — obligations on the **canonical shipped Host**.
 *
 * The profile for `deploy-release` × production declares one **blocking**
 * obligation, `change.approval`, in the obligation runtime's own vocabulary.
 * The path proven here is the canonical one:
 *
 * ```
 * governed action → Kernel decision (ALLOWED, obligation required — never a denial)
 *   → committed → grant issuance withheld (withheldBy: 'obligations'), adapter 0
 *   → a configured independent source's discharge, recorded by a trusted writer
 *     into the durable discharge store
 *   → restart
 *   → the same request (same idempotency key → the same committed decision,
 *     never re-made) is issued on the obligation state *now* → executed, adapter 1
 * ```
 *
 * and every way that could be short-circuited is tried and fails: a caller's
 * claim, a self-reported discharge, a discharge for another decision, an
 * untrusted writer, an HTTP route, a tampered store row.
 */

const workspace = new Workspace();
after(() => workspace.cleanup());

const WRITER: ObligationDischargeWriterContext = { system: true, actorId: 'operator:change-board-integration' };
const deploy = (releaseVersion = 'release-2026-09-28') => ({ action: DEPLOY, resource: PRODUCTION, parameters: { releaseVersion } });

function report(reply: Reply, overrides: Partial<ObligationDischargeRecordInput> = {}): ObligationDischargeRecordInput {
  return {
    correlation: { requestId: reply.body['requestId'] as string, action: DEPLOY, resourceScope: PRODUCTION },
    obligationType: 'change.approval',
    sourceId: 'change-approvals',
    outcome: 'discharged',
    observedAt: new Date(Date.now() - 1000).toISOString(),
    reference: 'CAB-7781',
    subjectId: 'approver-17',
    ...overrides,
  };
}

async function started(dir = workspace.dir()): Promise<Booted & { readonly dir: string }> {
  const booted = await boot(workspace, secureEnv(dir), { context: createContextTable() });
  return { ...booted, dir };
}

function recorder(booted: Booted) {
  const discharges = booted.host.enterprise.obligationDischarges;
  assert.ok(discharges !== undefined, 'obligations are composed on this Host');
  return discharges;
}

function assertWithheldForObligations(reply: Reply, label: string): void {
  assert.equal(reply.body['status'], 'withheld', `${label}: ${reply.text}`);
  assert.equal(reply.body['withheldBy'], 'obligations', label);
  assert.ok((reply.body['reasonCodes'] as string[]).includes('GRANT_OBLIGATIONS_UNSATISFIED'), label);
  assert.equal((reply.body['decision'] as { status: string }).status, 'allowed', `${label}: an unmet obligation withholds the grant, never rewrites the decision`);
}

describe('CORE-04 §62 / §94 — a blocking obligation withholds, and only a verified discharge releases — durably, across restart', () => {
  it('withheld → every forged, self-reported, replayed or untrusted release fails → verified discharge → restart → executed exactly once', async () => {
    const first = await started();
    await provision(first.host);
    const key = nextKey('deploy');

    // 1. The decision is ALLOWED; the grant is withheld; nothing executes.
    const withheld = await govern(first.baseUrl, deploy(), key);
    assertWithheldForObligations(withheld, 'initial');
    assert.equal(first.calls.length, 0);
    const decisionId = (withheld.body['decision'] as { decisionId: string }).decisionId;
    const committed = toKernelEvaluationResult(await committedRecord(first.host, withheld));
    assert.equal(committed.status, 'allowed');
    assert.equal(committed.obligations?.allBlockingObligationsSatisfied, false);
    assert.deepEqual(committed.obligations?.obligations.map((obligation) => [obligation.obligationType, obligation.state, obligation.blocking]), [['change.approval', 'required', true]]);

    // 2. A caller cannot claim satisfaction — not in the intent, not over HTTP.
    const claimed = await govern(first.baseUrl, { ...deploy(), assertedContext: { 'aoc.obligations': { 'change.approval': 'verified' } } }, nextKey('claim'));
    assert.equal(claimed.body['status'], 'rejected');
    const claimedInBag = await govern(first.baseUrl, { ...deploy(), assertedContext: { discharged: true, verified: true, complete: true, changeApproval: 'verified' } }, key);
    assert.equal(claimedInBag.body['status'], 'rejected', 'a different payload under the same key is an idempotency conflict, never a release');
    for (const [method, path, authorization] of [
      ['POST', '/api/obligations', `Bearer ${AGENT_KEY}`],
      ['POST', `/api/governed-actions/${encodeURIComponent(withheld.body['requestId'] as string)}/obligations`, `Bearer ${AGENT_KEY}`],
      ['POST', '/api/admin/obligations/discharge', ADMIN],
      ['POST', `/api/admin/authority/obligations/${encodeURIComponent(withheld.body['requestId'] as string)}/verify`, ADMIN],
      ['PUT', '/api/admin/obligations', ADMIN],
    ] as const) {
      const reply = await call(first.baseUrl, method, path, { authorization, body: { obligationType: 'change.approval', outcome: 'discharged', verified: true } });
      assert.ok(reply.status === 404 || reply.status === 405, `${method} ${path} → ${reply.status}: no route may record or verify an obligation`);
    }
    assert.equal(ADMIN_KEY.length > 0, true);

    // 3. The trusted writer surface refuses anything that is not a trusted writer.
    const untrustedWriters: readonly unknown[] = [
      undefined,
      {},
      { system: false, actorId: 'x' },
      { system: 'true', actorId: 'x' },
      { system: true },
      { system: true, actorId: '' },
      Object.create({ system: true, actorId: 'inherited' }) as unknown,
      { get system() { return true; }, actorId: 'getter' },
    ];
    for (const writer of untrustedWriters) {
      await assert.rejects(
        () => recorder(first).record(writer as ObligationDischargeWriterContext, report(withheld)),
        (error: unknown) => error instanceof ObligationDischargeError && error.code === 'OBLIGATION_DISCHARGE_WRITER_UNTRUSTED',
        JSON.stringify(writer),
      );
    }
    for (const invalid of [
      report(withheld, { sourceId: 'unconfigured-source' }),
      report(withheld, { outcome: 'verified' as never }),
      report(withheld, { observedAt: new Date(Date.now() + 60_000).toISOString() }),
      report(withheld, { obligationType: 'Change Approval!' }),
      report(withheld, { correlation: { requestId: '', action: DEPLOY, resourceScope: PRODUCTION } }),
    ]) {
      await assert.rejects(() => recorder(first).record(WRITER, invalid), (error: unknown) => error instanceof ObligationDischargeError && error.code === 'OBLIGATION_DISCHARGE_INVALID', JSON.stringify(invalid));
    }

    // 4. A self-reported discharge is recorded — and releases nothing.
    await recorder(first).record(WRITER, report(withheld, { sourceId: 'ticket-notes', reference: 'TICKET-1' }));
    assertWithheldForObligations(await govern(first.baseUrl, deploy(), key), 'self-reported');

    // 5. §100: a verified discharge for another decision, or another action on this one, releases nothing here.
    await recorder(first).record(WRITER, report(withheld, { correlation: { requestId: 'aoc.gar:another-decision', action: DEPLOY, resourceScope: PRODUCTION } }));
    await recorder(first).record(WRITER, report(withheld, { correlation: { requestId: withheld.body['requestId'] as string, action: READ, resourceScope: PRODUCTION } }));
    assertWithheldForObligations(await govern(first.baseUrl, deploy(), key), 'replayed discharge');
    assert.equal(first.calls.length, 0);

    // 6. The configured independent source reports a discharge. Then the Host stops.
    const recorded = await recorder(first).record(WRITER, report(withheld));
    assert.equal(recorded.recordedBy, 'operator:change-board-integration');
    assert.match(recorded.digest, /^sha256:[0-9a-f]{64}$/);
    await first.host.close();

    // 7. Restart. The same request is issued on the obligation state *now*, the committed decision unchanged.
    const second = await started(first.dir);
    const released = await govern(second.baseUrl, deploy(), key);
    assert.equal(released.body['status'], 'executed', released.text);
    assert.equal((released.body['decision'] as { decisionId: string }).decisionId, decisionId, 'the decision is never re-made');
    assert.equal(second.calls.length, 1);
    const stillCommitted = toKernelEvaluationResult(await committedRecord(second.host, released));
    assert.equal(stillCommitted.obligations?.allBlockingObligationsSatisfied, false, 'the committed record still says what was true when it was decided');

    // 8. At most once: a retry replays the recorded outcome.
    const replay = await govern(second.baseUrl, deploy(), key);
    assert.equal(replay.body['status'], 'executed');
    assert.equal(replay.body['replayed'], true);
    assert.equal(second.calls.length, 1);

    // 9. §41 / §100: a *new* decision for the same action stands under its own obligation — the old discharge is not reusable.
    assertWithheldForObligations(await govern(second.baseUrl, deploy(), nextKey('deploy')), 'new decision');
    assert.equal(second.calls.length, 1);
  });

  it('a waiver releases only when an independent source records it', async () => {
    const booted = await started();
    await provision(booted.host);
    const key = nextKey('waive');
    const withheld = await govern(booted.baseUrl, deploy('release-waiver'), key);
    assertWithheldForObligations(withheld, 'initial');
    await recorder(booted).record(WRITER, report(withheld, { sourceId: 'ticket-notes', outcome: 'waived' }));
    assertWithheldForObligations(await govern(booted.baseUrl, deploy('release-waiver'), key), 'self-reported waiver');
    await recorder(booted).record(WRITER, report(withheld, { outcome: 'waived', reference: 'CAB-WAIVER-3' }));
    assert.equal((await govern(booted.baseUrl, deploy('release-waiver'), key)).body['status'], 'executed');
    assert.equal(booted.calls.length, 1);
  });

  it('a refused verification leaves the obligation unsatisfied', async () => {
    const booted = await started();
    await provision(booted.host);
    const key = nextKey('refused');
    const withheld = await govern(booted.baseUrl, deploy('release-refused'), key);
    await recorder(booted).record(WRITER, report(withheld, { sourceId: 'ticket-notes' }));
    await recorder(booted).record(WRITER, report(withheld, { outcome: 'refused', reference: 'CAB-REJECT-1' }));
    assertWithheldForObligations(await govern(booted.baseUrl, deploy('release-refused'), key), 'refused');
    assert.equal(booted.calls.length, 0);
  });
});

describe('CORE-04 §39 / §40 — the discharge store is append-only and verified on every read', () => {
  it('UPDATE and DELETE are refused; a row rewritten underneath the triggers fails verification, and a failed read withholds — fail closed', async () => {
    const booted = await started();
    await provision(booted.host);
    const key = nextKey('tamper');
    const withheld = await govern(booted.baseUrl, deploy('release-tamper'), key);
    await recorder(booted).record(WRITER, report(withheld, { sourceId: 'ticket-notes', reference: 'TICKET-9' }));
    await booted.host.close();

    const path = join(booted.dir, 'obligation-discharges.sqlite');
    const db = new Database(path);
    try {
      assert.throws(() => db.prepare(`UPDATE obligation_discharges SET source_id = 'change-approvals'`).run(), /append-only/);
      assert.throws(() => db.prepare('DELETE FROM obligation_discharges').run(), /append-only/);
      // A database-level writer can drop the triggers. The digest still holds.
      db.exec('DROP TRIGGER obligation_discharges_no_update');
      db.prepare(`UPDATE obligation_discharges SET source_id = 'change-approvals'`).run();
    } finally {
      db.close();
    }

    const restarted = await started(booted.dir);
    const reply = await govern(restarted.baseUrl, deploy('release-tamper'), key);
    assertWithheldForObligations(reply, 'tampered store');
    assert.equal(restarted.calls.length, 0);
  });
});

describe('CORE-04 / Master Plan — lineage is revalidated at exercise for non-financial actions', () => {
  it('authority revoked between the decision and the verified discharge: the grant may issue, but exercise is withheld and the adapter is never reached', async () => {
    const booted = await started();
    await provision(booted.host);
    const key = nextKey('lineage');
    const withheld = await govern(booted.baseUrl, deploy('release-lineage'), key);
    assertWithheldForObligations(withheld, 'initial');

    const provisioning = booted.host.enterprise.kernelAuthorityProvisioning;
    assert.ok(provisioning !== undefined);
    await provisioning.revoke(DURABLE_FIXTURE_OPERATOR, { entityKind: 'delegation-grant', entityId: 'delegation-agent', reason: 'Delegation withdrawn after the decision.' });
    await recorder(booted).record(WRITER, report(withheld));

    const reply = await govern(booted.baseUrl, deploy('release-lineage'), key);
    assert.equal(reply.body['status'], 'withheld', reply.text);
    assert.equal(reply.body['withheldBy'], 'exercise');
    assert.ok((reply.body['reasonCodes'] as string[]).includes('EXERCISE_CONTROL_AUTHORITY_BINDING_UNVERIFIABLE'), reply.text);
    assert.equal(booted.calls.length, 0);

    // And a fresh request is denied at decision time by the same revocation.
    const fresh = await govern(booted.baseUrl, deploy('release-lineage-2'));
    assert.equal(fresh.body['status'], 'denied', fresh.text);
    assert.equal(booted.calls.length, 0);
  });
});
