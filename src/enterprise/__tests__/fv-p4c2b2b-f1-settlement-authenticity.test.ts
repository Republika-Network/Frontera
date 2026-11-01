import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import Database from 'better-sqlite3';

import { createHumanDecisionChannel } from '../approval-authority/human-decision.js';
import {
  INTENDED_PRODUCTION_RP_ID,
  createHumanIdentityService,
  createHumanIdentityServiceWithBootstrapSettlement,
  createRelyingPartyConfiguration,
  identityAdministratorFor,
  openSqliteHumanIdentityStore,
  revokeBootstrapSettlementCapability,
  type BootstrapAuthoritySettlement,
  type BootstrapSettlementCapability,
  type HumanIdentityService,
  type HumanIdentityStore,
} from '../human-identity/index.js';
import {
  STATUS_HISTORY_BOOTSTRAP_EVIDENCE_SCHEMA,
  bootstrapAuthorityDecisionInput,
  bootstrapBindingDigest,
  bootstrapBindingOf,
  bootstrapEvidenceDigest,
  createBootstrapAuthorityReconciler,
  createHumanDecisionBootstrapAuthorizer,
  openSqliteStatusHighWaterMarkStore,
  parseBootstrapAuthorityRef,
  parseStatusHistoryBootstrapRequest,
} from '../sovereign-status-history/index.js';
import type { BootstrapAuthoritySettlementPort, SqliteStatusHighWaterMarkStore, StatusHistoryBootstrapBinding, StatusHistoryBootstrapEvidence } from '../sovereign-status-history/index.js';
import { testSigner, testVerifier } from './authority-authenticity-fixture.js';
import { SoftwareAuthenticator } from './auth02-software-authenticator.js';

// FV-P4C-2B2B-F1 — settlement authenticity. Regression tests for the confirmed High finding: a
// `bootstrap-committed` settlement recorded in AUTH-03's signed chain for a bootstrap that never
// committed, (1) by a direct call and (2) through a reconciler fed a look-alike evidence reader.
// Real AUTH-03 (software passkeys, signed chain), real SQLite histories; synthetic principals.

const ORG = 'org-fv-p4c2b2b-f1';
const NAMESPACE = 'receiver:fv-f1';
const ORIGIN = `https://${INTENDED_PRODUCTION_RP_ID}`;
const RP = createRelyingPartyConfiguration({ rpId: INTENDED_PRODUCTION_RP_ID, rpName: 'Frontera Authority', allowedOrigins: [ORIGIN] });
const OPERATORS = ['requester-a', 'approver-b', 'approver-c'];
const GRACE = 300;
const allow = { mayRequest: (id: string) => id === 'requester-a', mayApprove: (id: string) => id !== 'requester-a' };

const ROOT = join(__dirname, '..', '..', '..', '..');
const directories: string[] = [];
const closers: Array<() => void> = [];
after(() => {
  for (const close of closers.splice(0).reverse()) {
    try {
      close();
    } catch {
      // closed by its test
    }
  }
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

class Clock {
  ms = Date.parse('2026-10-29T12:00:00Z');
  now = (): Date => new Date(this.ms);
  iso = (): string => this.now().toISOString();
  advance(seconds: number): void {
    this.ms += seconds * 1000;
  }
}

interface World {
  readonly dir: string;
  readonly clock: Clock;
  readonly identityPath: string;
  readonly historyPath: string;
  store: HumanIdentityStore;
  service: HumanIdentityService;
  capability: BootstrapSettlementCapability;
  history: SqliteStatusHighWaterMarkStore;
  readonly devices: Record<string, SoftwareAuthenticator>;
}

async function world(): Promise<World> {
  const dir = mkdtempSync(join(tmpdir(), 'fv-f1-'));
  directories.push(dir);
  const clock = new Clock();
  const identityPath = join(dir, 'human-identity.sqlite');
  const store = await openSqliteHumanIdentityStore(identityPath, { organizationId: ORG, now: clock.iso, authenticity: { signer: testSigner(), verifier: testVerifier() }, create: true });
  closers.push(() => store.close());
  const { service, settlementCapability } = createHumanIdentityServiceWithBootstrapSettlement({ store, relyingParty: RP, operatorIds: OPERATORS, now: clock.now });
  const admin = identityAdministratorFor({ plane: 'operator', operatorId: 'ops-admin', organizationId: ORG, role: 'organization-administrator', credentialClass: 'operator', actorRef: 'operator-plane:ops-admin' });
  const devices: Record<string, SoftwareAuthenticator> = {};
  for (const operatorId of OPERATORS) {
    const device = new SoftwareAuthenticator({ origin: ORIGIN });
    await service.createPrincipal(admin, { operatorId, displayName: `Synthetic ${operatorId}` });
    const issued = await service.authorizeEnrolment(admin, operatorId);
    await service.finishRegistration(issued.enrolmentToken, device.register(service.beginRegistration(issued.enrolmentToken)));
    devices[operatorId] = device;
  }
  const historyPath = join(dir, 'history.sqlite');
  const history = await openSqliteStatusHighWaterMarkStore(historyPath, { namespace: NAMESPACE, create: true });
  closers.push(() => history.close());
  return { dir, clock, identityPath, historyPath, store, service, capability: settlementCapability, history, devices };
}

let counter = 0;
function binding(): { binding: StatusHistoryBootstrapBinding; digest: string } {
  counter += 1;
  const request = parseStatusHistoryBootstrapRequest({
    schemaVersion: 'frontera.sovereign-status-bootstrap/1',
    requestId: `req:fv-f1-${counter}`,
    operation: 'establish',
    purpose: 'initial-trust-anchor',
    namespace: NAMESPACE,
    sovereignAssetId: `sa:f1-asset-${counter}`,
    issuer: 'did:example:registrant',
    manifestDigest: 'a'.repeat(64),
    status: { sequence: 1, statusDigest: 'b'.repeat(64) },
    terms: null,
    operatorRef: 'operator:requester-a',
    sourceRef: 'source:issuer-channel',
    createdAt: '2026-10-29T12:00:00Z',
    expiresAt: '2026-10-29T12:10:00Z',
  });
  assert.ok(request !== undefined);
  const b = bootstrapBindingOf(request);
  return { binding: b, digest: bootstrapBindingDigest(b) };
}

const decide = (w: World, operatorId: string, binding: StatusHistoryBootstrapBinding, role: 'requester' | 'approver'): unknown =>
  w.devices[operatorId]!.assert(w.service.beginBootstrapAuthorityDecision({ operatorId, ...bootstrapAuthorityDecisionInput(binding, role) }).options);

/** Both decisions consumed by the real authorizer: what the coordinator leaves after step 3, whatever follows. */
async function consumedPair(w: World, b: { binding: StatusHistoryBootstrapBinding; digest: string }, approverId = 'approver-b') {
  const authorizer = createHumanDecisionBootstrapAuthorizer({ decisions: w.service, organizationId: ORG, permissions: allow, requesterResponse: decide(w, 'requester-a', b.binding, 'requester'), approverResponse: decide(w, approverId, b.binding, 'approver') });
  const result = (await authorizer.authorizeStatusHistoryBootstrap(b.binding, b.digest)) as { outcome: string; authorityRef: string };
  assert.equal(result.outcome, 'authorized');
  const ref = parseBootstrapAuthorityRef(result.authorityRef)!;
  return { authorityRef: result.authorityRef, requester: ref.requesterCommitment, approver: ref.approverCommitment };
}

/** Commits `b` in the real history, through the store's own evidence transaction. */
async function anchor(w: World, b: { binding: StatusHistoryBootstrapBinding; digest: string }, authorityRef: string): Promise<StatusHistoryBootstrapEvidence> {
  const at = '2026-10-29T12:00:30Z';
  const key = { sovereignAssetId: b.binding.sovereignAssetId, issuer: b.binding.issuer };
  const recorded = await w.history.compareAndSetWithEvidence(
    key,
    null,
    { ...key, sequence: 1, statusDigest: 'b'.repeat(64), issuedAt: '2026-10-29T11:59:00Z', currentTermsDigest: null, timeFloor: '2026-10-29T11:59:00Z', withdrawn: false, retiredTermsDigests: [], continuity: 'verified', conflict: false, anchoredAt: at },
    {
      schemaVersion: STATUS_HISTORY_BOOTSTRAP_EVIDENCE_SCHEMA,
      operationId: `op:${b.binding.requestId}`,
      requestId: b.binding.requestId,
      namespace: NAMESPACE,
      ...key,
      operation: 'establish',
      purpose: 'initial-trust-anchor',
      bindingDigest: b.digest,
      operatorRef: b.binding.operatorRef,
      authorityRef,
      sources: [{ sourceClass: 'issuer-status-channel', sourceRef: 'source:issuer-channel', observedAt: at }],
      status: { sequence: 1, statusDigest: 'b'.repeat(64) },
      evaluationTime: at,
      result: 'committed',
      classification: 'host-recorded-unsigned',
    },
  );
  assert.notEqual(recorded, false);
  return recorded as StatusHistoryBootstrapEvidence;
}

const genuine = (w: World) => [{ store: w.history, namespace: NAMESPACE, databasePath: w.historyPath }];
const reconcilerOf = (w: World, extra: { settlement?: BootstrapAuthoritySettlementPort; histories?: unknown } = {}) =>
  createBootstrapAuthorityReconciler({
    settlement: extra.settlement ?? w.capability,
    histories: (extra.histories ?? genuine(w)) as never,
    organizationId: ORG,
    now: w.clock.iso,
    graceSeconds: GRACE,
    inFlight: () => false,
  });
const summary = (entries: readonly { result: string; reason?: string; settlement?: { outcome: string } }[]) => entries.map((e) => [e.result, e.reason ?? e.settlement?.outcome]);
const outcomeRows = (w: World) => w.store.history().filter((row) => row.kind === 'decision_outcome');

/** The exact fabricated settlement of the original F1 probe: an invented request id, evidence digest and transition. */
const fabricated = (bindingDigest: string, counterpartCommitment: string, overrides: Record<string, unknown> = {}): BootstrapAuthoritySettlement =>
  ({ outcome: 'bootstrap-committed', bindingDigest, counterpartCommitment, bootstrapRequestId: 'req:NOT-THE-REAL-ONE', bootstrapEvidenceDigest: 'sha256:' + '0'.repeat(64), historyRevision: 7, statusSequence: 99, statusDigest: 'f'.repeat(64), ...overrides }) as BootstrapAuthoritySettlement;

/** Asserts nothing was recorded for the pair: no outcome row, both still unsettled, neither reads as committed. */
function noFalseSuccess(w: World, pair: { requester: string; approver: string }): void {
  assert.equal(outcomeRows(w).length, 0, 'no settlement row in the signed chain');
  for (const commitment of [pair.requester, pair.approver]) assert.equal(w.service.bootstrapAuthorityDecision(commitment)?.settlement, undefined);
}

const UNAUTHORIZED = { code: 'HUMAN_IDENTITY_DECISION_SETTLEMENT_UNAUTHORIZED' };

describe('FV-P4C-2B2B-F1 path 1 — a direct settlement call cannot record a false success', () => {
  it('1–3. THE ORIGINAL EXPLOIT, verbatim (fabricated request, evidence digest and transition) no longer records anything', async () => {
    const w = await world();
    const pair = await consumedPair(w, binding());
    const b = w.service.bootstrapAuthorityDecision(pair.requester)!.contract.subjectDigest.slice('sha256:'.length);
    // The pre-fix call shape: (commitment, settlement). The commitment now lands in the capability slot.
    const original = w.service.recordBootstrapAuthoritySettlement as unknown as (commitment: string, settlement: unknown) => Promise<unknown>;
    await assert.rejects(original.call(w.service, pair.requester, fabricated(b, pair.approver)), UNAUTHORIZED);
    for (const variant of [{ bootstrapRequestId: 'req:invented' }, { bootstrapEvidenceDigest: 'sha256:' + '1'.repeat(64) }, { historyRevision: 42, statusSequence: 42, statusDigest: 'c'.repeat(64) }]) {
      await assert.rejects(original.call(w.service, pair.requester, fabricated(b, pair.approver, variant)), UNAUTHORIZED);
    }
    noFalseSuccess(w, pair);
  });

  it('4/5. without a capability, or with a forged one of the same shape, settlement fails closed before anything is read', async () => {
    const w = await world();
    const pair = await consumedPair(w, binding());
    const b = w.service.bootstrapAuthorityDecision(pair.requester)!.contract.subjectDigest.slice(7);
    const forgeries: unknown[] = [undefined, null, pair.requester, ORG, true, {}, { capability: 'frontera.sovereign-status-bootstrap-settlement.v1' }, Object.freeze({ capability: 'frontera.sovereign-status-bootstrap-settlement.v1' }), Object.create(w.capability as object), { ...w.capability }];
    for (const forged of forgeries) await assert.rejects(w.service.recordBootstrapAuthoritySettlement(forged as BootstrapSettlementCapability, pair.requester, fabricated(b, pair.approver)), UNAUTHORIZED);
    // Even a malformed settlement is refused for authority first (no information about the decision leaks).
    await assert.rejects(w.service.recordBootstrapAuthoritySettlement(undefined as never, 'garbage', {} as never), UNAUTHORIZED);
    noFalseSuccess(w, pair);
  });

  it('6. a capability of another service instance — even over the same signed store — and a revoked one, fail; the plain constructor issues none', async () => {
    const w = await world();
    const pair = await consumedPair(w, binding());
    const b = w.service.bootstrapAuthorityDecision(pair.requester)!.contract.subjectDigest.slice(7);
    const other = createHumanIdentityServiceWithBootstrapSettlement({ store: w.store, relyingParty: RP, operatorIds: OPERATORS, now: w.clock.now });
    await assert.rejects(w.service.recordBootstrapAuthoritySettlement(other.settlementCapability, pair.requester, fabricated(b, pair.approver)), UNAUTHORIZED);
    await assert.rejects(other.service.recordBootstrapAuthoritySettlement(w.capability, pair.requester, fabricated(b, pair.approver)), UNAUTHORIZED);
    const plain = createHumanIdentityService({ store: w.store, relyingParty: RP, operatorIds: OPERATORS, now: w.clock.now });
    await assert.rejects(plain.recordBootstrapAuthoritySettlement(w.capability, pair.requester, fabricated(b, pair.approver)), UNAUTHORIZED);
    revokeBootstrapSettlementCapability(w.capability);
    revokeBootstrapSettlementCapability({});
    await assert.rejects(w.service.recordBootstrapAuthoritySettlement(w.capability, pair.requester, fabricated(b, pair.approver)), UNAUTHORIZED);
    noFalseSuccess(w, pair);
  });
});

describe('FV-P4C-2B2B-F1 path 2 — a reconciler only believes a genuine history handle', () => {
  const forgedEvidence = (b: { digest: string }, authorityRef: string) => ({
    schemaVersion: 'frontera.sovereign-status-bootstrap-evidence/1', operationId: 'op', requestId: 'req:never', namespace: NAMESPACE, sovereignAssetId: 'sa:never', issuer: 'did:example:i',
    operation: 'establish', purpose: 'initial-trust-anchor', bindingDigest: b.digest, operatorRef: 'operator:requester-a', authorityRef, sources: [],
    status: { sequence: 1, statusDigest: 'b'.repeat(64) }, previous: null, next: { revision: 1, sequence: 1, statusDigest: 'b'.repeat(64) },
    evaluationTime: '2026-10-29T12:00:00Z', result: 'committed', reason: 'ESTABLISHED', classification: 'host-recorded-unsigned',
  });

  it('7/8. THE ORIGINAL EXPLOIT: a look-alike reader returning a nonexistent bootstrap is refused at construction, and nothing is settled', async () => {
    const w = await world();
    const b = binding();
    const pair = await consumedPair(w, b);
    const liar = { namespace: NAMESPACE, readBootstrapEvidenceForBinding: async () => [forgedEvidence(b, pair.authorityRef)] };
    assert.throws(() => reconcilerOf(w, { histories: [liar] }), /not a genuine status history store handle/);
    assert.throws(() => reconcilerOf(w, { histories: [{ store: liar, namespace: NAMESPACE, databasePath: w.historyPath }] }), /not a genuine/);
    // A real-looking frozen copy of a real handle is not the handle.
    assert.throws(() => reconcilerOf(w, { histories: [{ store: Object.freeze({ ...w.history }), namespace: NAMESPACE, databasePath: w.historyPath }] }), /not a genuine/);
    noFalseSuccess(w, pair);
    // With the genuine (empty) history, the truth: not committed, after the grace bound.
    w.clock.advance(GRACE + 1);
    assert.deepEqual(summary(await reconcilerOf(w).reconcile()), [['settled', 'bootstrap-not-committed'], ['settled', 'bootstrap-not-committed']]);
  });

  it('9. a genuine handle declared for another namespace or another database file is refused', async () => {
    const w = await world();
    assert.throws(() => reconcilerOf(w, { histories: [{ store: w.history, namespace: 'receiver:other', databasePath: w.historyPath }] }), /not a genuine/);
    assert.throws(() => reconcilerOf(w, { histories: [{ store: w.history, namespace: NAMESPACE, databasePath: join(w.dir, 'elsewhere.sqlite') }] }), /not a genuine/);
    const second = await openSqliteStatusHighWaterMarkStore(join(w.dir, 'second.sqlite'), { namespace: 'receiver:second', create: true });
    closers.push(() => second.close());
    assert.throws(() => reconcilerOf(w, { histories: [{ store: second, namespace: NAMESPACE, databasePath: w.historyPath }] }), /not a genuine/);
    assert.doesNotThrow(() => reconcilerOf(w, { histories: [...genuine(w), { store: second, namespace: 'receiver:second', databasePath: join(w.dir, 'second.sqlite') }] }));
  });

  it('10/11. evidence for another binding, or naming other decisions, never settles this pair as committed', async () => {
    const w = await world();
    const mine = binding();
    const pair = await consumedPair(w, mine);
    const theirs = binding();
    const theirPair = await consumedPair(w, theirs, 'approver-c');
    await anchor(w, theirs, theirPair.authorityRef); // another binding committed
    const sameBinding = await consumedPair(w, mine, 'approver-c');
    await anchor(w, mine, sameBinding.authorityRef); // this binding, by other decisions
    const entries = new Map((await reconcilerOf(w).reconcile()).map((e) => [e.commitment, e]));
    for (const c of [pair.requester, pair.approver]) assert.deepEqual((entries.get(c) as { settlement: unknown }).settlement, { outcome: 'bootstrap-not-committed', bindingDigest: mine.digest, code: 'ANCHORED_BY_OTHER_DECISIONS' });
    for (const c of [theirPair.requester, sameBinding.approver]) assert.equal((entries.get(c) as { settlement: { outcome: string } }).settlement.outcome, 'bootstrap-committed');
  });

  it('12. corrupt persisted evidence fails closed: unresolved, never committed, and the file is never recreated', async () => {
    const w = await world();
    const b = binding();
    const pair = await consumedPair(w, b);
    await anchor(w, b, pair.authorityRef);
    const db = new Database(w.historyPath);
    db.exec('DROP TRIGGER sovereign_status_bootstrap_evidence_never_updated');
    db.prepare("UPDATE sovereign_status_bootstrap_evidence SET record = json_set(record, '$.next.statusDigest', ?) WHERE request_id = ?").run('d'.repeat(64), b.binding.requestId);
    db.exec("CREATE TRIGGER sovereign_status_bootstrap_evidence_never_updated BEFORE UPDATE ON sovereign_status_bootstrap_evidence BEGIN SELECT RAISE(ABORT, 'bootstrap evidence is permanent'); END;");
    db.close();
    assert.deepEqual(summary(await reconcilerOf(w).reconcile()), [['unresolved', 'HISTORY_CORRUPT'], ['unresolved', 'HISTORY_CORRUPT']]);
    w.clock.advance(GRACE + 1);
    assert.deepEqual(summary(await reconcilerOf(w).reconcile()), [['unresolved', 'HISTORY_CORRUPT'], ['unresolved', 'HISTORY_CORRUPT']], 'corruption is never "no evidence"');
    noFalseSuccess(w, pair);
    assert.deepEqual(readdirSync(w.dir).filter((name) => name.startsWith('history') && !name.startsWith('history.sqlite')), [], 'no replacement history was created');
  });

  it('13. a closed handle authorizes nothing: unresolved, never "no evidence"', async () => {
    const w = await world();
    const pair = await consumedPair(w, binding());
    const r = reconcilerOf(w);
    w.history.close();
    w.clock.advance(GRACE + 1);
    assert.deepEqual(summary(await r.reconcile()), [['unresolved', 'HISTORY_UNAVAILABLE'], ['unresolved', 'HISTORY_UNAVAILABLE']]);
    noFalseSuccess(w, pair);
  });

  it('a reconciler with a look-alike settlement port, or one forwarding a forged token to the real service, settles nothing in the real chain', async () => {
    const w = await world();
    const b = binding();
    const pair = await consumedPair(w, b);
    await anchor(w, b, pair.authorityRef);
    assert.throws(() => reconcilerOf(w, { settlement: { capability: 'frontera.sovereign-status-bootstrap-settlement.v1' } as never }), /settlement capability/);
    const forged = { capability: 'frontera.sovereign-status-bootstrap-settlement.v1' };
    const forwarding: BootstrapAuthoritySettlementPort = {
      unsettledBootstrapAuthorityDecisions: () => w.service.unsettledBootstrapAuthorityDecisions(),
      recordBootstrapAuthoritySettlement: (commitment, settlement) => w.service.recordBootstrapAuthoritySettlement(forged as never, commitment, settlement),
    };
    assert.deepEqual(summary(await reconcilerOf(w, { settlement: forwarding }).reconcile()), [['unresolved', 'SETTLEMENT_UNAUTHORIZED'], ['unresolved', 'SETTLEMENT_UNAUTHORIZED']]);
    noFalseSuccess(w, pair);
  });

  it('REVIEW FINDING 1: the capability cannot be intercepted through the shared service object', async () => {
    const w = await world();
    const b = binding();
    const pair = await consumedPair(w, b);
    await anchor(w, b, pair.authorityRef);
    // The independent reviewer's exploit: replace the service's settlement method, wait for the reconciler to pass the token through it.
    assert.equal(Object.isFrozen(w.service), true);
    let captured: unknown;
    const thief = (capability: unknown) => {
      captured = capability;
      return Promise.resolve('recorded' as const);
    };
    assert.throws(() => {
      (w.service as unknown as { recordBootstrapAuthoritySettlement: unknown }).recordBootstrapAuthoritySettlement = thief;
    }, TypeError);
    assert.throws(() => Object.defineProperty(w.service, 'recordBootstrapAuthoritySettlement', { value: thief }), TypeError);
    // A look-alike port handed to the reconciler only ever receives (commitment, settlement): there is no token to keep.
    const seen: unknown[][] = [];
    const spy: BootstrapAuthoritySettlementPort = {
      unsettledBootstrapAuthorityDecisions: () => w.service.unsettledBootstrapAuthorityDecisions(),
      recordBootstrapAuthoritySettlement: async (...args: unknown[]) => (seen.push(args), 'recorded'),
    };
    await reconcilerOf(w, { settlement: spy }).reconcile();
    assert.equal(seen.length, 2);
    for (const args of seen) {
      assert.equal(args.length, 2);
      assert.equal(args.includes(w.capability), false);
    }
    assert.equal(captured, undefined);
    // The real reconciler, with the real capability, still settles from the genuine evidence.
    assert.deepEqual(summary(await reconcilerOf(w).reconcile()), [['settled', 'bootstrap-committed'], ['settled', 'bootstrap-committed']]);
    assert.equal(Object.isFrozen(w.capability), true);
  });

  it('REVIEW FINDING 3: a decision named by a committed counterpart can never be settled as not committed', async () => {
    const w = await world();
    const b = binding();
    const pair = await consumedPair(w, b);
    const evidence = await anchor(w, b, pair.authorityRef);
    const committed = { outcome: 'bootstrap-committed', bindingDigest: b.digest, counterpartCommitment: pair.approver, bootstrapRequestId: b.binding.requestId, bootstrapEvidenceDigest: bootstrapEvidenceDigest(evidence), historyRevision: 1, statusSequence: 1, statusDigest: 'b'.repeat(64) } as BootstrapAuthoritySettlement;
    assert.equal(await w.capability.recordBootstrapAuthoritySettlement(pair.requester, committed), 'recorded');
    await assert.rejects(w.capability.recordBootstrapAuthoritySettlement(pair.approver, { outcome: 'bootstrap-not-committed', bindingDigest: b.digest, code: 'NO_BOOTSTRAP_EVIDENCE' }), { code: 'HUMAN_IDENTITY_DECISION_SETTLEMENT_CONFLICT' });
    assert.deepEqual(summary(await reconcilerOf(w).reconcile()), [['settled', 'bootstrap-committed']]);
  });
});

describe('FV-P4C-2B2B-F1 — the legitimate path, replay, restart, CORE-05 and reachability', () => {
  it('16/14/15. genuine evidence settles through the capability; a replay is unchanged; a different or misplaced replay is refused', async () => {
    const w = await world();
    const b = binding();
    const pair = await consumedPair(w, b);
    const evidence = await anchor(w, b, pair.authorityRef);
    assert.deepEqual(summary(await reconcilerOf(w).reconcile()), [['settled', 'bootstrap-committed'], ['settled', 'bootstrap-committed']]);
    const settled = w.service.bootstrapAuthorityDecision(pair.requester)!.settlement!;
    assert.deepEqual(settled, { outcome: 'bootstrap-committed', bindingDigest: b.digest, counterpartCommitment: pair.approver, bootstrapRequestId: b.binding.requestId, bootstrapEvidenceDigest: bootstrapEvidenceDigest(evidence), historyRevision: 1, statusSequence: 1, statusDigest: 'b'.repeat(64) });
    assert.equal(await w.service.recordBootstrapAuthoritySettlement(w.capability, pair.requester, { ...settled }), 'unchanged');
    await assert.rejects(w.service.recordBootstrapAuthoritySettlement(w.capability, pair.requester, fabricated(b.digest, pair.approver)), { code: 'HUMAN_IDENTITY_DECISION_SETTLEMENT_CONFLICT' });
    await assert.rejects(w.service.recordBootstrapAuthoritySettlement(undefined as never, pair.requester, { ...settled }), UNAUTHORIZED);
    // Replayed onto another pair (another binding): refused.
    const other = await consumedPair(w, binding(), 'approver-c');
    await assert.rejects(w.service.recordBootstrapAuthoritySettlement(w.capability, other.requester, { ...settled, counterpartCommitment: other.approver }), { code: 'HUMAN_IDENTITY_DECISION_SETTLEMENT_CONFLICT' });
    assert.equal(outcomeRows(w).length, 2);
  });

  it('17. after a restart of both stores, the old capability and old handle are dead; the new ones recover from durable evidence', async () => {
    const w = await world();
    const b = binding();
    const pair = await consumedPair(w, b);
    await anchor(w, b, pair.authorityRef);
    const oldCapability = w.capability;
    const oldHistory = w.history;
    w.store.close();
    w.store = await openSqliteHumanIdentityStore(w.identityPath, { organizationId: ORG, now: w.clock.iso, authenticity: { signer: testSigner(), verifier: testVerifier() } });
    closers.push(() => w.store.close());
    ({ service: w.service, settlementCapability: w.capability } = createHumanIdentityServiceWithBootstrapSettlement({ store: w.store, relyingParty: RP, operatorIds: OPERATORS, now: w.clock.now }));
    oldHistory.close();
    w.history = await openSqliteStatusHighWaterMarkStore(w.historyPath, { namespace: NAMESPACE });
    closers.push(() => w.history.close());
    // The old capability is bound to the old service over the closed store: it can neither list nor settle; and it is refused by the new service.
    await assert.rejects(reconcilerOf(w, { settlement: oldCapability }).reconcile());
    await assert.rejects(w.service.recordBootstrapAuthoritySettlement(oldCapability, pair.requester, { outcome: 'bootstrap-not-committed', bindingDigest: b.digest, code: 'NO_BOOTSTRAP_EVIDENCE' }), UNAUTHORIZED);
    assert.equal(outcomeRows(w).length, 0);
    assert.deepEqual(summary(await reconcilerOf(w, { histories: [{ store: oldHistory, namespace: NAMESPACE, databasePath: w.historyPath }] }).reconcile()), [['unresolved', 'HISTORY_UNAVAILABLE'], ['unresolved', 'HISTORY_UNAVAILABLE']]);
    assert.deepEqual(summary(await reconcilerOf(w).reconcile()), [['settled', 'bootstrap-committed'], ['settled', 'bootstrap-committed']]);
  });

  it('partial failures stay truthful: requester-only and source/commit failures settle as NOT committed, never committed', async () => {
    const w = await world();
    const lone = binding();
    await w.service.authorizeBootstrapAuthorityDecision(decide(w, 'requester-a', lone.binding, 'requester'));
    await consumedPair(w, binding()); // both consumed, the bootstrap then failed (no evidence)
    w.clock.advance(GRACE + 1);
    const entries = await reconcilerOf(w).reconcile();
    assert.equal(entries.length, 3);
    for (const entry of entries) assert.deepEqual([entry.result, (entry as { settlement?: { outcome: string; code: string } }).settlement?.outcome, (entry as { settlement?: { code: string } }).settlement?.code], ['settled', 'bootstrap-not-committed', 'NO_BOOTSTRAP_EVIDENCE']);
  });

  it('18. CORE-05: the real channel still abandons its own consumed decisions and never touches bootstrap ones; it never needs the capability', async () => {
    const w = await world();
    const pair = await consumedPair(w, binding());
    const core05 = await w.service.authorizeDecision(w.devices['approver-c']!.assert(w.service.beginDecision({ operatorId: 'approver-c', approvalRequestId: `approval-request:${'a'.repeat(64)}`, subjectDigest: `sha256:${'d'.repeat(64)}`, verdict: 'approve' }).options));
    const channel = createHumanDecisionChannel({ organizationId: ORG, approvals: { list: async () => [], approve: async () => assert.fail('no verdict'), reject: async () => assert.fail('no verdict') }, identity: w.service, roleOf: () => 'approver' });
    assert.deepEqual(await channel.reconcile(), [{ commitment: core05.commitment, settled: 'abandoned' }]);
    assert.deepEqual(w.service.unsettledBootstrapAuthorityDecisions().map((d) => d.commitment), [pair.requester, pair.approver]);
  });

  it('19/20. nothing in the Host reaches the capability, the trusted source or the reconciler; settlement creates no execution capability', () => {
    const walk = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? walk(path) : path.endsWith('.ts') ? [path] : [];
    });
    const SRC = join(ROOT, 'src');
    const allowed = [join(SRC, 'enterprise', 'human-identity'), join(SRC, 'enterprise', 'sovereign-status-history')];
    const PRIVILEGED = /createHumanIdentityServiceWithBootstrapSettlement|revokeBootstrapSettlementCapability|trustedBootstrapEvidenceSource|createBootstrapAuthorityReconciler|recordBootstrapAuthoritySettlement/;
    const reaching = walk(SRC).filter((file) => !file.includes('__tests__') && !allowed.some((dir) => file.startsWith(dir)) && PRIVILEGED.test(readFileSync(file, 'utf8')));
    assert.deepEqual(reaching.map((file) => relative(ROOT, file)), []);
    // trustedBootstrapEvidenceSource stays module-internal: not re-exported by the module's index.
    assert.equal(/trustedBootstrapEvidenceSource/.test(readFileSync(join(SRC, 'enterprise', 'sovereign-status-history', 'index.ts'), 'utf8')), false);
    for (const file of ['authority-settlement.ts', 'sqlite-status-high-water-mark-store.ts']) {
      assert.equal(/executionCapability|issueExecution|governAction|payment|\.execute\(/.test(readFileSync(join(SRC, 'enterprise', 'sovereign-status-history', file), 'utf8')), false, file);
    }
  });
});
