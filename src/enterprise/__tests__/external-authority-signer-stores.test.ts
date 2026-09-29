import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';

import { createGrantIssuanceService, type BoundedGrant, type BoundedGrantStorePort, type GrantCorrelation, type GrantScope, type GrantSourceAuthorization } from '../../features/grant-runtime/index.js';
import type { ApprovalStore } from '../approval-authority/index.js';
import { AuthoritySigningUnavailableError } from '../authority-authenticity/errors.js';
import type { AuthorityArtifactSigner } from '../authority-authenticity/signer.js';
import { createSqliteBoundedGrantStore, type DurableBoundedGrantStore } from '../bounded-grant-store/index.js';
import { createObligationDischargeRecorder, createSqliteObligationDischargeStore, type ObligationDischargeStore } from '../obligation-discharge/index.js';
import type { ExternalAuthorityArtifactSigner } from '../external-authority-signer/index.js';
import { AUTHORITY_KEY_A, AUTHORITY_KEY_B, testAuthenticity, testSigner, testVerifier, type TestAuthorityKey } from './authority-authenticity-fixture.js';
import { ScriptedTransport, establish, establishScripted, startInProcessSigner, unavailable } from './core02-external-signer-fixture.js';
import { actor, authorityOver, cleanup as cleanupApprovals, opened, openStore as openApprovalStore, rawRows as rawApprovalRows, storePath as approvalStorePath, target } from './core05-approval-fixture.js';

/**
 * CORE-02 — the three signed stores under external custody.
 *
 * What changes is only *where* signatures come from. What must not change:
 * nothing is written without a verified signature (issuance, revocation,
 * discharge, approval, genesis); reads verify locally whether or not the signer
 * answers; every signature is taken outside the write transaction and every
 * commit re-validates after it; re-attestation on rotation goes through the
 * external signer and never anywhere else.
 */

const NOW = '2026-01-01T12:00:00.000Z';
const HORIZON = '2026-01-01T12:10:00.000Z';
const REVOKED_AT = '2026-01-01T12:05:00.000Z';
const CORRELATION: GrantCorrelation = { requestId: 'req-1', decisionId: 'dec-1', action: 'payment.send', resourceScope: 'record:contract' };
const SCOPE: GrantScope = { action: { kind: 'identity', value: 'payment.send' }, amount: { kind: 'ceiling', limit: '10000', unit: 'USD' }, resources: { kind: 'set', values: ['record:contract'] } };
const SOURCE: GrantSourceAuthorization = { correlation: CORRELATION, subject: 'actor-a', scope: SCOPE, authorizationPermitsExercise: true, allBlockingObligationsSatisfied: true, evaluatedAt: NOW, validityCeilings: [] };
const ORG = 'org-a';
const DISCHARGE_SOURCES = [{ id: 'board', kind: 'approval_runtime', name: 'Board', verificationClass: 'independent' }] as const;
const WRITER = { system: true, actorId: 'operator:board-sync' } as const;

const work = mkdtempSync(join(tmpdir(), 'frontera-core02-stores-'));
const closers: (() => Promise<void>)[] = [];
after(async () => {
  for (const close of closers.reverse()) await close().catch(() => {});
  await cleanupApprovals();
  rmSync(work, { recursive: true, force: true });
});

let counter = 0;
const file = (name: string): string => join(work, `${name}-${(counter += 1)}.sqlite`);

function correlation(index: number): GrantCorrelation {
  return { ...CORRELATION, requestId: `req-${index}`, decisionId: `dec-${index}` };
}

async function issue(store: BoundedGrantStorePort, index = 1, revalidate?: () => GrantSourceAuthorization | undefined) {
  const c = correlation(index);
  return createGrantIssuanceService({ store, ...(revalidate !== undefined ? { revalidateSource: () => revalidate() } : {}) }).issueGrant({ source: { ...SOURCE, correlation: c }, subject: 'actor-a', correlation: c, issuedAt: NOW, expiresAt: HORIZON });
}

async function issued(store: BoundedGrantStorePort, index = 1): Promise<BoundedGrant> {
  const outcome = await issue(store, index);
  assert.equal(outcome.outcome, 'issued');
  return (outcome as { grant: BoundedGrant }).grant;
}

async function scripted(key: TestAuthorityKey = AUTHORITY_KEY_A, trust: readonly TestAuthorityKey[] = [key], maxAttempts = 1): Promise<{ transport: ScriptedTransport; external: ExternalAuthorityArtifactSigner; authenticity: { signer: AuthorityArtifactSigner; verifier: ReturnType<typeof testVerifier> } }> {
  const transport = new ScriptedTransport(key);
  const external = await establishScripted(transport, { pin: key, trust, maxAttempts });
  return { transport, external, authenticity: { signer: external.signer, verifier: testVerifier(trust) } };
}

async function grantStore(path: string, authenticity: { signer: AuthorityArtifactSigner; verifier: ReturnType<typeof testVerifier> }): Promise<DurableBoundedGrantStore> {
  const store = await createSqliteBoundedGrantStore(path, { authenticity });
  closers.push(() => store.close());
  return store;
}

async function dischargeStore(path: string, authenticity: { signer: AuthorityArtifactSigner; verifier: ReturnType<typeof testVerifier> }): Promise<ObligationDischargeStore> {
  const store = await createSqliteObligationDischargeStore(path, { now: () => NOW, organizationId: ORG, authenticity });
  closers.push(() => store.close());
  return store;
}

let observed = Date.parse(NOW) - 3_600_000;
function record(store: ObligationDischargeStore, requestId = 'aoc.gar:target') {
  return createObligationDischargeRecorder({ store, sources: DISCHARGE_SOURCES, organizationId: ORG, now: () => NOW }).record(WRITER, {
    correlation: { requestId, action: 'deploy-release', resourceScope: 'production' },
    obligationType: 'change.approval',
    sourceId: 'board',
    outcome: 'discharged',
    observedAt: new Date((observed += 1000)).toISOString(),
  });
}

function raw<T>(path: string, query: string): T {
  const db = new Database(path, { readonly: true });
  try {
    return db.prepare(query).get() as T;
  } finally {
    db.close();
  }
}

const signingUnavailable = (error: unknown) => error instanceof AuthoritySigningUnavailableError && error.reason !== undefined;

describe('CORE-02 — a signer outage never writes authority state, and reads continue on local verification', () => {
  it('bounded grants: issuance and revocation write nothing while the signer is down; existing grants still read and verify; recovery commits exactly once', async () => {
    const { transport, authenticity } = await scripted();
    const path = file('grants');
    const store = await grantStore(path, authenticity);
    const live = await issued(store, 1);
    const genuine = transport.answer;

    transport.answer = () => unavailable('EXTERNAL_SIGNER_UNREACHABLE');
    await assert.rejects(() => issue(store, 2), signingUnavailable, 'issuance fails loudly');
    await assert.rejects(() => store.revoke({ grantId: live.id, reason: 'security-incident', revokedAt: REVOKED_AT, issuerRef: 'operator-a' }), signingUnavailable, 'revocation fails loudly — never reported as done');
    assert.equal(raw<{ n: number }>(path, 'SELECT COUNT(*) AS n FROM bounded_grants').n, 1, 'no unsigned grant row');
    assert.equal(raw<{ n: number }>(path, 'SELECT COUNT(*) AS n FROM bounded_grant_revocations').n, 0, 'no unsigned revocation row');
    assert.equal(raw<{ sequence: number }>(path, 'SELECT sequence FROM bounded_grant_revocation_state').sequence, 0, 'the signed revocation head did not move');
    // Reads do not depend on the signer: the grant is read, verified, and — honestly — still live.
    const read = await store.read(live.id);
    assert.equal(read.grant?.id, live.id);
    assert.equal(read.revocation, undefined, 'AA-004: the grant remains exercisable until a revocation can be signed');
    assert.equal((await store.health()).revocationState, 'verified');

    transport.answer = genuine;
    const revoked = await store.revoke({ grantId: live.id, reason: 'security-incident', revokedAt: REVOKED_AT, issuerRef: 'operator-a' });
    assert.equal(revoked.outcome, 'revoked');
    assert.equal((await store.read(live.id)).revocation?.grantId, live.id);
    assert.equal((await issue(store, 2)).outcome, 'issued');
    assert.equal(raw<{ n: number }>(path, 'SELECT COUNT(*) AS n FROM bounded_grant_revocations').n, 1);
  });

  it('obligation discharges: an append during an outage writes no row and leaves the signed head; reads continue; the report appends after recovery', async () => {
    const { transport, authenticity } = await scripted();
    const path = file('discharges');
    const store = await dischargeStore(path, authenticity);
    await record(store, 'aoc.gar:one');
    const head = raw<{ sequence: number; signature_json: string }>(path, 'SELECT sequence, signature_json FROM obligation_discharge_head');
    const genuine = transport.answer;
    transport.answer = () => unavailable('EXTERNAL_SIGNER_TIMEOUT');
    await assert.rejects(() => record(store, 'aoc.gar:two'), signingUnavailable);
    assert.deepEqual(raw(path, 'SELECT sequence, signature_json FROM obligation_discharge_head'), head, 'the signed head is byte-identical');
    assert.equal(raw<{ n: number }>(path, 'SELECT COUNT(*) AS n FROM obligation_discharges').n, 1);
    assert.equal((await store.read(ORG, { requestId: 'aoc.gar:one', action: 'deploy-release', resourceScope: 'production' })).length, 1, 'reads verify locally');
    transport.answer = genuine;
    await record(store, 'aoc.gar:two');
    assert.equal(raw<{ n: number }>(path, 'SELECT COUNT(*) AS n FROM obligation_discharges').n, 2);
  });

  it('approvals: a command during an outage writes no row and is not accepted; opening a request fails closed as unavailable; both proceed after recovery', async () => {
    const { transport, authenticity } = await scripted();
    const path = approvalStorePath();
    const store = await openApprovalStore(path, { authenticity: authenticity as ReturnType<typeof testAuthenticity> });
    const authority = authorityOver(store);
    const command = await opened(authority);
    const before = rawApprovalRows(path).length;
    const genuine = transport.answer;
    transport.answer = () => unavailable('EXTERNAL_SIGNER_UNAVAILABLE');
    await assert.rejects(() => authority.approve(actor('approver-a'), command), signingUnavailable, 'the approval is not accepted');
    assert.equal(rawApprovalRows(path).length, before, 'no approval row');
    // A new request cannot be opened either — it is withheld as unavailable, never approved.
    assert.deepEqual(await authority.assess(target({ requestId: 'aoc.gar:other' })), { kind: 'withheld', status: 'unavailable' });
    assert.equal(rawApprovalRows(path).length, before);
    // Reads continue.
    assert.equal((await authority.describe('aoc.gar:target'))?.approvalRequestId, command.approvalRequestId);
    transport.answer = genuine;
    await authority.approve(actor('approver-a'), command);
    await authority.approve(actor('approver-b'), command);
    assert.equal((await authority.assess(target())).kind, 'approved');
    assert.equal(rawApprovalRows(path).length, before + 2, 'each approval recorded exactly once');
  });

  it('genesis: a new store is never initialized unsigned — the file stays uninitialized and opens normally once the signer answers', async () => {
    const { transport, authenticity } = await scripted();
    const genuine = transport.answer;
    transport.answer = () => unavailable('EXTERNAL_SIGNER_UNREACHABLE');
    const grants = file('genesis-grants');
    await assert.rejects(() => createSqliteBoundedGrantStore(grants, { authenticity }), signingUnavailable);
    assert.equal(existsSync(grants) ? raw<{ n: number }>(grants, "SELECT COUNT(*) AS n FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").n : 0, 0, 'no schema, no unsigned head');
    const discharges = file('genesis-discharges');
    await assert.rejects(() => createSqliteObligationDischargeStore(discharges, { now: () => NOW, organizationId: ORG, authenticity }), signingUnavailable);
    assert.equal(raw<{ n: number }>(discharges, "SELECT COUNT(*) AS n FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").n, 0);
    const approvals = approvalStorePath();
    await assert.rejects(() => openApprovalStore(approvals, { authenticity: authenticity as ReturnType<typeof testAuthenticity> }), signingUnavailable);
    assert.equal(raw<{ n: number }>(approvals, "SELECT COUNT(*) AS n FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").n, 0);

    transport.answer = genuine;
    await grantStore(grants, authenticity);
    await dischargeStore(discharges, authenticity);
    await openApprovalStore(approvals, { authenticity: authenticity as ReturnType<typeof testAuthenticity> });
    assert.equal(transport.count('signRevocationState'), 2, 'one refused, one committed grant-store genesis');
  });

  it('a real outage (the custody service stops): grants, revocation state, discharges and approvals still read; every mutation is refused', async () => {
    const service = await startInProcessSigner(AUTHORITY_KEY_A);
    const external = await establish(service.endpoint, { pin: AUTHORITY_KEY_A, timeoutMs: 500 });
    const authenticity = { signer: external.signer, verifier: testVerifier([AUTHORITY_KEY_A]) };
    const grants = await grantStore(file('outage-grants'), authenticity);
    const live = await issued(grants, 1);
    const revokedGrant = await issued(grants, 2);
    await grants.revoke({ grantId: revokedGrant.id, reason: 'security-incident', revokedAt: REVOKED_AT, issuerRef: 'operator-a' });
    const discharges = await dischargeStore(file('outage-discharges'), authenticity);
    await record(discharges, 'aoc.gar:outage');
    const approvals = await openApprovalStore(approvalStorePath(), { authenticity: authenticity as ReturnType<typeof testAuthenticity> });
    const authority = authorityOver(approvals);
    const command = await opened(authority);

    await service.close();
    assert.equal((await external.monitor.probe()).state, 'unavailable');

    assert.equal((await grants.read(live.id)).grant?.id, live.id);
    assert.equal((await grants.read(revokedGrant.id)).revocation?.grantId, revokedGrant.id, 'a committed revocation still reads — revocation-state verification is local');
    assert.equal((await grants.health()).status, 'healthy', 'the authority store is not corrupt because the signer is offline');
    assert.equal((await discharges.read(ORG, { requestId: 'aoc.gar:outage', action: 'deploy-release', resourceScope: 'production' })).length, 1);
    assert.equal((await authority.describe('aoc.gar:target'))?.approvalRequestId, command.approvalRequestId);

    await assert.rejects(() => issue(grants, 3), signingUnavailable);
    await assert.rejects(() => grants.revoke({ grantId: live.id, reason: 'security-incident', revokedAt: REVOKED_AT, issuerRef: 'operator-a' }), signingUnavailable);
    await assert.rejects(() => record(discharges, 'aoc.gar:after'), signingUnavailable);
    await assert.rejects(() => authority.approve(actor('approver-a'), command), signingUnavailable);
  });
});

describe('CORE-02 — a store never persists a signature its own verifier would refuse, whatever signer produced it', () => {
  it('discharge and approval appends read their new head back inside the write transaction: an untrusted head signature rolls the append back', async () => {
    const genuine = testSigner(AUTHORITY_KEY_A);
    const attacker = testSigner(AUTHORITY_KEY_B);
    let lie = false;
    const lying: AuthorityArtifactSigner = {
      activeKeyId: AUTHORITY_KEY_A.keyId,
      algorithm: 'ed25519-v1',
      signGrant: (grant, storeId) => genuine.signGrant(grant, storeId),
      signRevocation: (revocation, storeId) => genuine.signRevocation(revocation, storeId),
      signRevocationState: (state) => genuine.signRevocationState(state),
      signObligationDischargeState: async (state) => (lie ? { ...(await attacker.signObligationDischargeState(state)), keyId: AUTHORITY_KEY_A.keyId } : genuine.signObligationDischargeState(state)),
      signApprovalState: async (state) => (lie ? { ...(await attacker.signApprovalState(state)), keyId: AUTHORITY_KEY_A.keyId } : genuine.signApprovalState(state)),
    };
    const authenticity = { signer: lying, verifier: testVerifier([AUTHORITY_KEY_A]) };
    const dischargesPath = file('readback-discharges');
    const discharges = await dischargeStore(dischargesPath, authenticity);
    await record(discharges, 'aoc.gar:readback-1');
    const approvalsPath = approvalStorePath();
    const approvals = await openApprovalStore(approvalsPath, { authenticity: authenticity as ReturnType<typeof testAuthenticity> });
    const authority = authorityOver(approvals);
    const command = await opened(authority);
    const dischargeHead = raw(dischargesPath, 'SELECT sequence, chain_digest, signature_json FROM obligation_discharge_head');
    const approvalHead = raw(approvalsPath, 'SELECT sequence, chain_digest, signature_json FROM approval_head');
    const approvalRows = rawApprovalRows(approvalsPath).length;

    lie = true;
    await assert.rejects(() => record(discharges, 'aoc.gar:readback-2'), /not authentic/);
    await assert.rejects(() => authority.approve(actor('approver-a'), command), /not authentic/);
    assert.deepEqual(raw(dischargesPath, 'SELECT sequence, chain_digest, signature_json FROM obligation_discharge_head'), dischargeHead, 'the discharge head is byte-identical');
    assert.equal(raw<{ n: number }>(dischargesPath, 'SELECT COUNT(*) AS n FROM obligation_discharges').n, 1, 'no discharge row');
    assert.deepEqual(raw(approvalsPath, 'SELECT sequence, chain_digest, signature_json FROM approval_head'), approvalHead, 'the approval head is byte-identical');
    assert.equal(rawApprovalRows(approvalsPath).length, approvalRows, 'no approval row');
    lie = false;
    await record(discharges, 'aoc.gar:readback-2');
    await authority.approve(actor('approver-a'), command);
  });
});

describe('CORE-02 / AA-005 — signer calls are spent only where a signature can matter', () => {
  it('call budget: new store 1 · issuance 1 · duplicate 0 · precluded 0 · ineligible 0 · revocation 2 · duplicate revocation 0 · unknown grant 0 · discharge 1 · approval event 1', async () => {
    const { transport, authenticity } = await scripted();
    const grants = await grantStore(file('budget'), authenticity);
    assert.deepEqual([transport.count('signRevocationState'), transport.count('signGrant')], [1, 0], 'genesis: one revocation-state signature');

    const grant = await issued(grants, 1);
    assert.equal(transport.count('signGrant'), 1, 'a new grant: one signature');
    assert.equal((await issue(grants, 1)).outcome, 'already-issued');
    assert.equal(transport.count('signGrant'), 1, 'a duplicate issuance spends none');

    const ineligible = await issue(grants, 7, () => undefined);
    assert.equal(ineligible.outcome, 'refused');
    assert.equal(transport.count('signGrant'), 1, 'an issuance the commit guard already refuses spends none');

    await grants.revoke({ grantId: grant.id, reason: 'security-incident', revokedAt: REVOKED_AT, issuerRef: 'operator-a' });
    assert.deepEqual([transport.count('signRevocation'), transport.count('signRevocationState')], [1, 2], 'a revocation: the revocation and the successor commitment');
    assert.equal((await grants.revoke({ grantId: grant.id, reason: 'manual-revocation', revokedAt: HORIZON, issuerRef: 'operator-b' })).outcome, 'already-revoked');
    assert.equal((await grants.revoke({ grantId: 'aoc.grant:unknown', reason: 'manual-revocation', revokedAt: HORIZON, issuerRef: 'operator-b' })).outcome, 'refused');
    assert.deepEqual([transport.count('signRevocation'), transport.count('signRevocationState')], [1, 2], 'duplicate and unknown revocations spend none');

    // Precluded: the grant id is revoked, so re-issuing it is refused before signing.
    assert.equal((await issue(grants, 1)).outcome, 'already-issued', 'the grant row exists (revoked), so it is returned, not re-signed');
    assert.equal(transport.count('signGrant'), 1);

    const discharges = await dischargeStore(file('budget-discharges'), authenticity);
    const genesisDischarges = transport.count('signObligationDischargeState');
    await record(discharges, 'aoc.gar:budget');
    assert.equal(transport.count('signObligationDischargeState') - genesisDischarges, 1);

    const approvals = await openApprovalStore(approvalStorePath(), { authenticity: authenticity as ReturnType<typeof testAuthenticity> });
    const authority = authorityOver(approvals);
    const genesisApprovals = transport.count('signApprovalState');
    const command = await opened(authority);
    await authority.approve(actor('approver-a'), command);
    assert.equal(transport.count('signApprovalState') - genesisApprovals, 2, 'request + one approval: one signature per event');
    await assert.rejects(() => authority.approve(actor('approver-a'), command));
    assert.equal(transport.count('signApprovalState') - genesisApprovals, 2, 'a refused duplicate approval spends none');
  });

  it('eligibility withdrawn while the signer works: the preflight passed, the signature is spent, and the post-sign commit guard still refuses — the wasted signature is the price of correctness', async () => {
    const { transport, authenticity } = await scripted();
    const grants = await grantStore(file('stale-eligibility'), authenticity);
    let eligible = true;
    const genuine = transport.answer;
    transport.answer = async (request, attempt) => {
      const answer = await genuine(request, attempt);
      if (request.operation === 'signGrant') eligible = false; // withdrawn while signing
      return answer;
    };
    const outcome = await issue(grants, 1, () => (eligible ? { ...SOURCE, correlation: correlation(1) } : undefined));
    assert.equal(outcome.outcome, 'refused');
    assert.equal(transport.count('signGrant'), 1);
    assert.equal((await grants.read((outcome as { grant?: BoundedGrant }).grant?.id ?? 'none')).grant, undefined);
  });
});

describe('CORE-02 — stale plans, unknown outcomes and duplicate signatures commit exactly one transition', () => {
  it('a revocation planned on state S, signed slowly while another writer commits S+1, is never committed over S — it re-plans, signs again, and both revocations stand', async () => {
    const path = file('stale-plan');
    const slow = await scripted();
    const fast = await scripted();
    const a = await grantStore(path, slow.authenticity);
    const b = await grantStore(path, fast.authenticity);
    const g1 = await issued(a, 1);
    const g2 = await issued(a, 2);

    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const genuine = slow.transport.answer;
    let delayed = false;
    slow.transport.answer = async (request, attempt) => {
      if (request.operation === 'signRevocationState' && !delayed) {
        delayed = true;
        await gate; // the signer is slow; the plan goes stale meanwhile
      }
      return genuine(request, attempt);
    };
    const pending = a.revoke({ grantId: g1.id, reason: 'security-incident', revokedAt: REVOKED_AT, issuerRef: 'operator-a' });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal((await b.revoke({ grantId: g2.id, reason: 'security-incident', revokedAt: REVOKED_AT, issuerRef: 'operator-b' })).outcome, 'revoked');
    release();
    assert.equal((await pending).outcome, 'revoked');

    assert.equal(slow.transport.count('signRevocationState'), 1 + 2, 'genesis + the stale signature + the re-planned one');
    const rows = new Database(path, { readonly: true });
    try {
      assert.deepEqual(rows.prepare('SELECT sequence, grant_id FROM bounded_grant_revocations ORDER BY sequence').all(), [
        { sequence: 1, grant_id: g2.id },
        { sequence: 2, grant_id: g1.id },
      ]);
    } finally {
      rows.close();
    }
    assert.equal((await a.read(g1.id)).revocation?.grantId, g1.id);
    assert.equal((await a.read(g2.id)).revocation?.grantId, g2.id);
  });

  it('a discharge append whose base changed while it was being signed is refused, and the other writer’s head stands', async () => {
    const path = file('stale-discharge');
    const slow = await scripted();
    const fast = await scripted();
    const a = await dischargeStore(path, slow.authenticity);
    const b = await dischargeStore(path, fast.authenticity);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const genuine = slow.transport.answer;
    slow.transport.answer = async (request, attempt) => {
      await gate;
      return genuine(request, attempt);
    };
    const pending = record(a, 'aoc.gar:slow');
    await new Promise((resolve) => setTimeout(resolve, 50));
    await record(b, 'aoc.gar:fast');
    const head = raw(path, 'SELECT sequence, chain_digest, signature_json FROM obligation_discharge_head');
    release();
    await assert.rejects(() => pending, /changed while a report was being recorded/);
    assert.deepEqual(raw(path, 'SELECT sequence, chain_digest, signature_json FROM obligation_discharge_head'), head);
  });

  it('unknown outcome: the service signed but the answer was lost; the retry signs again and exactly one grant, one revocation and one discharge commit', async () => {
    const { transport, authenticity } = await scripted(AUTHORITY_KEY_A, [AUTHORITY_KEY_A], 2);
    const genuine = transport.answer;
    const lost = new Set<string>();
    transport.answer = async (request, attempt) => {
      const answer = await genuine(request, attempt); // the remote *did* sign
      if (!lost.has(request.operation)) {
        lost.add(request.operation);
        unavailable('EXTERNAL_SIGNER_TIMEOUT'); // …and the answer never arrived
      }
      return answer;
    };
    const path = file('unknown-outcome');
    const grants = await grantStore(path, authenticity);
    const grant = await issued(grants, 1);
    assert.equal((await grants.revoke({ grantId: grant.id, reason: 'security-incident', revokedAt: REVOKED_AT, issuerRef: 'operator-a' })).outcome, 'revoked');
    assert.equal(raw<{ n: number }>(path, 'SELECT COUNT(*) AS n FROM bounded_grants').n, 1);
    assert.equal(raw<{ n: number }>(path, 'SELECT COUNT(*) AS n FROM bounded_grant_revocations').n, 1);
    assert.equal(transport.count('signGrant'), 2, 'two signatures were produced; one grant exists');
    const discharges = await dischargeStore(file('unknown-outcome-discharges'), authenticity);
    await record(discharges, 'aoc.gar:once');
    assert.equal((await discharges.read(ORG, { requestId: 'aoc.gar:once', action: 'deploy-release', resourceScope: 'production' })).length, 1);
  });
});

describe('CORE-02 — key rotation re-attests through the external signer, and a failed re-attestation leaves still-trusted state readable', () => {
  it('software key A → external key B: every store re-attests its unchanged head externally (one call each); old artifacts verify; nothing is signed in-process', async () => {
    const grantsPath = file('rotation-grants');
    const dischargesPath = file('rotation-discharges');
    const approvalsPath = approvalStorePath();
    const softwareA = testAuthenticity({ signWith: AUTHORITY_KEY_A });
    const legacyGrants = await grantStore(grantsPath, softwareA);
    const oldGrant = await issued(legacyGrants, 1);
    await legacyGrants.close();
    const legacyDischarges = await dischargeStore(dischargesPath, softwareA);
    await record(legacyDischarges, 'aoc.gar:rotation');
    await legacyDischarges.close();
    const legacyApprovals = await openApprovalStore(approvalsPath, { authenticity: softwareA });
    await opened(authorityOver(legacyApprovals));
    await legacyApprovals.close();

    // The custody service holds key B; this deployment pins B and still trusts A.
    const service = await startInProcessSigner(AUTHORITY_KEY_B);
    const external = await establish(service.endpoint, { pin: AUTHORITY_KEY_B, trust: [AUTHORITY_KEY_A, AUTHORITY_KEY_B] });
    const authenticity = { signer: external.signer, verifier: testVerifier([AUTHORITY_KEY_A, AUTHORITY_KEY_B]) };
    const grants = await grantStore(grantsPath, authenticity);
    const discharges = await dischargeStore(dischargesPath, authenticity);
    const approvals = await openApprovalStore(approvalsPath, { authenticity: authenticity as ReturnType<typeof testAuthenticity> });
    assert.deepEqual(await service.counts(), { signGrant: 0, signRevocation: 0, signRevocationState: 1, signObligationDischargeState: 1, signApprovalState: 1 }, 'one external re-attestation per store');
    assert.equal(raw<{ signing_key_id: string }>(grantsPath, 'SELECT signing_key_id FROM bounded_grant_revocation_state').signing_key_id, AUTHORITY_KEY_B.keyId);
    assert.equal(JSON.parse(raw<{ signature_json: string }>(dischargesPath, 'SELECT signature_json FROM obligation_discharge_head').signature_json).keyId, AUTHORITY_KEY_B.keyId);
    assert.equal((await grants.read(oldGrant.id)).grant?.id, oldGrant.id, 'the A-signed grant still verifies');
    const newGrant = await issued(grants, 2);
    await grants.close();
    await discharges.close();
    await approvals.close();

    // Retiring A: the re-attested heads no longer need it; the A-signed grant does (key-trust removal is not revocation).
    const onlyB = { signer: external.signer, verifier: testVerifier([AUTHORITY_KEY_B]) };
    const retired = await grantStore(grantsPath, onlyB);
    assert.equal((await retired.read(newGrant.id)).grant?.id, newGrant.id);
    await assert.rejects(() => retired.read(oldGrant.id), /not authentic/, 'an artifact signed by a retired key is unreadable — retire A only after its grants have expired or been dealt with');
    const retiredDischarges = await dischargeStore(dischargesPath, onlyB);
    assert.equal((await retiredDischarges.read(ORG, { requestId: 'aoc.gar:rotation', action: 'deploy-release', resourceScope: 'production' })).length, 1);
    await openApprovalStore(approvalsPath, { authenticity: onlyB as ReturnType<typeof testAuthenticity> });
    await service.close();
  });

  it('re-attestation during a signer outage: every store still opens and reads under the still-trusted old key; nothing falls back to another signer', async () => {
    const grantsPath = file('rotation-outage-grants');
    const dischargesPath = file('rotation-outage-discharges');
    const approvalsPath = approvalStorePath();
    const softwareA = testAuthenticity({ signWith: AUTHORITY_KEY_A });
    const legacy = await grantStore(grantsPath, softwareA);
    const oldGrant = await issued(legacy, 1);
    await legacy.close();
    await (await dischargeStore(dischargesPath, softwareA)).close();
    await (await openApprovalStore(approvalsPath, { authenticity: softwareA })).close();

    const { transport, authenticity } = await scripted(AUTHORITY_KEY_B, [AUTHORITY_KEY_A, AUTHORITY_KEY_B]);
    transport.answer = () => unavailable('EXTERNAL_SIGNER_UNREACHABLE');
    const grants = await grantStore(grantsPath, authenticity);
    const discharges = await dischargeStore(dischargesPath, authenticity);
    await openApprovalStore(approvalsPath, { authenticity: authenticity as ReturnType<typeof testAuthenticity> });
    assert.deepEqual([transport.count('signRevocationState'), transport.count('signObligationDischargeState'), transport.count('signApprovalState')], [1, 1, 1], 'each attempted through the external signer only');
    assert.equal(raw<{ signing_key_id: string }>(grantsPath, 'SELECT signing_key_id FROM bounded_grant_revocation_state').signing_key_id, AUTHORITY_KEY_A.keyId, 'the head is still A-signed, and still trusted');
    assert.equal((await grants.read(oldGrant.id)).grant?.id, oldGrant.id);
    assert.equal((await grants.health()).status, 'healthy');
    assert.deepEqual(await discharges.read(ORG, { requestId: 'none', action: 'a', resourceScope: 'r' }), []);
  });
});

describe('CORE-02 — structural: external signing happens outside every database transaction', () => {
  const STORES = [
    'src/enterprise/bounded-grant-store/sqlite-bounded-grant-store.ts',
    'src/enterprise/obligation-discharge/sqlite-obligation-discharge-store.ts',
    'src/enterprise/approval-authority/sqlite-approval-store.ts',
  ];

  function codeOf(path: string): string {
    return readFileSync(path, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .split('\n')
      .map((line) => (line.includes('//') ? line.slice(0, line.indexOf('//')) : line))
      .join('\n');
  }

  /** Every `db.transaction(` callback body, by bracket matching. */
  function transactionBodies(code: string): string[] {
    const bodies: string[] = [];
    let from = 0;
    for (;;) {
      const start = code.indexOf('db.transaction(', from);
      if (start === -1) return bodies;
      let depth = 0;
      let index = start + 'db.transaction'.length;
      for (; index < code.length; index += 1) {
        const char = code[index];
        if (char === '(') depth += 1;
        if (char === ')') {
          depth -= 1;
          if (depth === 0) break;
        }
      }
      bodies.push(code.slice(start, index + 1));
      from = index + 1;
    }
  }

  it('no transaction callback is async, awaits, or reaches the signer', () => {
    let measured = 0;
    for (const store of STORES) {
      const code = codeOf(store);
      assert.equal(/db\.transaction\(\s*async/.test(code), false, `${store}: a transaction callback must be synchronous`);
      for (const body of transactionBodies(code)) {
        measured += 1;
        assert.equal(/\bawait\b/.test(body), false, `${store}: no await inside a transaction:\n${body.slice(0, 160)}`);
        assert.equal(/\bsigner\b/.test(body), false, `${store}: the signer is never called inside a transaction:\n${body.slice(0, 160)}`);
      }
    }
    assert.ok(measured >= 12, `expected to measure every transaction, measured ${measured}`);
  });

  it('every commit re-validates after signing: each store re-verifies its state inside the write transaction before it writes', () => {
    const grant = codeOf(STORES[0] as string);
    for (const transaction of ['const runIssue = db.transaction(', 'const runRevoke = db.transaction(']) {
      const body = grant.slice(grant.indexOf(transaction), grant.indexOf(transaction) + 900);
      assert.ok(body.indexOf('verifiedRevocationState()') !== -1, `${transaction} re-verifies`);
    }
    assert.ok(grant.includes('const precondition = input.commitGuard();'), 'the commit guard still runs in the transaction');
    assert.ok(/state\.commitment\.sequence !== plan\.previous\.sequence/.test(grant), 'a stale revocation plan is detected');
    for (const store of STORES.slice(1)) {
      assert.ok(/current\.sequence !== state\.sequence \|\| current\.chainDigest !== state\.chainDigest/.test(codeOf(store)), `${store}: exact-base check after signing`);
    }
  });
});
