import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createHumanDecisionChannel } from '../approval-authority/human-decision.js';
import {
  BOOTSTRAP_AUTHORITY_CHALLENGE_FORMAT,
  HUMAN_DECISION_CHALLENGE_FORMAT,
  INTENDED_PRODUCTION_RP_ID,
  bootstrapAuthorityChallengeCommitment,
  createHumanIdentityServiceWithBootstrapSettlement,
  createRelyingPartyConfiguration,
  humanDecisionChallengeCommitment,
  identityAdministratorFor,
  openSqliteHumanIdentityStore,
  type BootstrapAuthoritySettlement,
  type BootstrapSettlementCapability,
  type HumanIdentityService,
  type HumanIdentityStore,
} from '../human-identity/index.js';
import { createKernelAuthorityLineageRevalidator } from '../kernel-authority/authority-lineage-revalidator.js';
import { createDurableKernelWorld } from '../kernel-authority/durable-kernel-providers.js';
import { createInMemoryKernelAuthorityStore } from '../kernel-authority/in-memory-kernel-authority-store.js';
import { createKernelAuthorityProvisioningService, type KernelAuthorityProvisioningService } from '../kernel-authority/provisioning-service.js';
import { OPERATOR_PERMISSIONS, OPERATOR_ROLES, operatorMay } from '../operator-control/roles.js';
import {
  STATUS_HISTORY_BOOTSTRAP_APPROVE_PERMISSION,
  STATUS_HISTORY_BOOTSTRAP_EVIDENCE_SCHEMA,
  STATUS_HISTORY_BOOTSTRAP_PERMISSIONS,
  STATUS_HISTORY_BOOTSTRAP_REQUEST_PERMISSION,
  STATUS_HISTORY_RESOURCE_SCOPE,
  bootstrapAuthorityDecisionInput,
  bootstrapBindingDigest,
  bootstrapBindingOf,
  bootstrapEvidenceDigest,
  createBootstrapAuthorityReconciler,
  createHumanDecisionBootstrapAuthorizer,
  createKernelAuthorityBootstrapPermissions,
  openSqliteStatusHighWaterMarkStore,
  parseBootstrapAuthorityRef,
  parseStatusHistoryBootstrapRequest,
  statusHistoryResourceScope,
} from '../sovereign-status-history/index.js';
import type {
  BootstrapAuthoritySettlementPort,
  BootstrapEvidenceHistory,
  BootstrapHumanPermissions,
  BootstrapStandingPort,
  SqliteStatusHighWaterMarkStore,
  StatusHistoryBootstrapBinding,
  StatusHistoryBootstrapEvidence,
} from '../sovereign-status-history/index.js';
import { createActorRegistryRecognitionIntegration } from '../../features/approval-runtime/services/approval-actor-recognition-integration.js';
import { createApprovalAuthorityGraphIntegration } from '../../features/approval-runtime/services/approval-authority-graph-integration.js';
import { testSigner, testVerifier } from './authority-authenticity-fixture.js';
import { SoftwareAuthenticator } from './auth02-software-authenticator.js';

// FV-P4C-2B2B — the authority lifecycle of a sovereign status history bootstrap, against REAL Host
// services: the AUTH-03 identity service (software passkeys, signed chain), the Kernel-Authority world
// (provisioned grants, revocation, lineage), the CORE-05 passkey channel's reconciliation, and a real
// SQLite status history written through its own evidence path. Synthetic principals; no composition.

const ORG = 'org-fv-p4c2b2b';
const NAMESPACE = 'receiver:fv-p4c2b2b';
const ORIGIN = `https://${INTENDED_PRODUCTION_RP_ID}`;
const RP = createRelyingPartyConfiguration({ rpId: INTENDED_PRODUCTION_RP_ID, rpName: 'Frontera Authority', allowedOrigins: [ORIGIN] });
const OPERATORS = ['requester-a', 'approver-b', 'approver-c', 'admin-x'];
const allow: BootstrapHumanPermissions = { mayRequest: (id) => id === 'requester-a', mayApprove: (id) => id === 'approver-b' || id === 'approver-c' };
const GRACE = 300;

class Clock {
  ms = Date.parse('2026-10-29T12:00:00Z');
  now = (): Date => new Date(this.ms);
  iso = (): string => this.now().toISOString();
  advance(seconds: number): void {
    this.ms += seconds * 1000;
  }
}

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

interface World {
  readonly dir: string;
  readonly clock: Clock;
  readonly identityPath: string;
  service: HumanIdentityService;
  capability: BootstrapSettlementCapability;
  store: HumanIdentityStore;
  history: SqliteStatusHighWaterMarkStore;
  readonly historyPath: string;
  readonly devices: Record<string, SoftwareAuthenticator>;
  readonly admin: ReturnType<typeof identityAdministratorFor>;
}

async function world(): Promise<World> {
  const dir = mkdtempSync(join(tmpdir(), 'fv-p4c2b2b-'));
  directories.push(dir);
  const clock = new Clock();
  const identityPath = join(dir, 'human-identity.sqlite');
  const store = await openSqliteHumanIdentityStore(identityPath, { organizationId: ORG, now: clock.iso, authenticity: { signer: testSigner(), verifier: testVerifier() }, create: true });
  closers.push(() => store.close());
  const { service, settlementCapability: capability } = createHumanIdentityServiceWithBootstrapSettlement({ store, relyingParty: RP, operatorIds: OPERATORS, now: clock.now });
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
  return { dir, clock, identityPath, service, capability, store, history, historyPath, devices, admin };
}

/** Reopens the identity store and service over the same file: a restarted process. */
async function restartIdentity(w: World): Promise<void> {
  w.store.close();
  w.store = await openSqliteHumanIdentityStore(w.identityPath, { organizationId: ORG, now: w.clock.iso, authenticity: { signer: testSigner(), verifier: testVerifier() } });
  closers.push(() => w.store.close());
  const rebuilt = createHumanIdentityServiceWithBootstrapSettlement({ store: w.store, relyingParty: RP, operatorIds: OPERATORS, now: w.clock.now });
  w.service = rebuilt.service;
  w.capability = rebuilt.settlementCapability;
}

/** Reopens the real history file: a restarted process, with a new genuine handle. */
async function restartHistory(w: World): Promise<void> {
  w.history.close();
  w.history = await openSqliteStatusHighWaterMarkStore(w.historyPath, { namespace: NAMESPACE });
  closers.push(() => w.history.close());
}

let counter = 0;
function binding(overrides: Record<string, unknown> = {}): { binding: StatusHistoryBootstrapBinding; digest: string } {
  counter += 1;
  const request = parseStatusHistoryBootstrapRequest({
    schemaVersion: 'frontera.sovereign-status-bootstrap/1',
    requestId: `req:fv-p4c2b2b-${counter}`,
    operation: 'establish',
    purpose: 'initial-trust-anchor',
    namespace: NAMESPACE,
    sovereignAssetId: `sa:synthetic-asset-${counter}`,
    issuer: 'did:example:registrant',
    manifestDigest: 'a'.repeat(64),
    status: { sequence: 1, statusDigest: 'b'.repeat(64) },
    terms: null,
    operatorRef: 'operator:requester-a',
    sourceRef: 'source:issuer-channel',
    createdAt: '2026-10-29T12:00:00Z',
    expiresAt: '2026-10-29T12:10:00Z',
    ...overrides,
  });
  assert.ok(request !== undefined);
  const b = bootstrapBindingOf(request);
  return { binding: b, digest: bootstrapBindingDigest(b) };
}

const decide = (w: World, operatorId: string, digest: string, role: 'requester' | 'approver'): unknown =>
  w.devices[operatorId]!.assert(w.service.beginBootstrapAuthorityDecision({ operatorId, ...bootstrapAuthorityDecisionInput(digest, role) }).options);

/** A consumed requester/approver pair for `b`, through the real authorizer: what the coordinator's step 3 leaves. */
async function consumedPair(w: World, b: { binding: StatusHistoryBootstrapBinding; digest: string }, approverId = 'approver-b') {
  const authorizer = createHumanDecisionBootstrapAuthorizer({ decisions: w.service, organizationId: ORG, permissions: allow, requesterResponse: decide(w, 'requester-a', b.digest, 'requester'), approverResponse: decide(w, approverId, b.digest, 'approver') });
  const result = (await authorizer.authorizeStatusHistoryBootstrap(b.binding, b.digest)) as { outcome: string; authorityRef: string };
  assert.equal(result.outcome, 'authorized', String(authorizer.lastDenial()));
  const ref = parseBootstrapAuthorityRef(result.authorityRef)!;
  return { authorityRef: result.authorityRef, requester: ref.requesterCommitment, approver: ref.approverCommitment };
}

/** Anchors `b` in the real history through the store's own evidence transaction, naming `authorityRef`. */
async function anchor(w: World, b: { binding: StatusHistoryBootstrapBinding; digest: string }, authorityRef: string, operatorRef = b.binding.operatorRef): Promise<StatusHistoryBootstrapEvidence> {
  const at = '2026-10-29T12:00:30Z';
  const key = { sovereignAssetId: b.binding.sovereignAssetId, issuer: b.binding.issuer };
  const recorded = await w.history.compareAndSetWithEvidence(
    key,
    null,
    { ...key, sequence: b.binding.status.sequence, statusDigest: b.binding.status.statusDigest, issuedAt: '2026-10-29T11:59:00Z', currentTermsDigest: null, timeFloor: '2026-10-29T11:59:00Z', withdrawn: false, retiredTermsDigests: [], continuity: 'verified', conflict: false, anchoredAt: at },
    {
      schemaVersion: STATUS_HISTORY_BOOTSTRAP_EVIDENCE_SCHEMA,
      operationId: `op:${b.binding.requestId}`,
      requestId: b.binding.requestId,
      namespace: NAMESPACE,
      sovereignAssetId: key.sovereignAssetId,
      issuer: key.issuer,
      operation: 'establish',
      purpose: 'initial-trust-anchor',
      bindingDigest: b.digest,
      operatorRef,
      authorityRef,
      sources: [{ sourceClass: 'issuer-status-channel', sourceRef: 'source:issuer-channel', observedAt: at }],
      status: { ...b.binding.status },
      evaluationTime: at,
      result: 'committed',
      classification: 'host-recorded-unsigned',
    },
  );
  assert.notEqual(recorded, false);
  return recorded as StatusHistoryBootstrapEvidence;
}

const historiesOf = (w: World): readonly BootstrapEvidenceHistory[] => [{ store: w.history, namespace: NAMESPACE, databasePath: w.historyPath }];
const reconciler = (w: World, extra: { histories?: readonly BootstrapEvidenceHistory[]; decisions?: BootstrapAuthoritySettlementPort; inFlight?: (c: string) => boolean } = {}) =>
  createBootstrapAuthorityReconciler({ settlement: extra.decisions ?? w.capability, histories: extra.histories ?? historiesOf(w), organizationId: ORG, now: w.clock.iso, graceSeconds: GRACE, inFlight: extra.inFlight ?? (() => false) });

const summary = (entries: readonly { result: string; reason?: string; settlement?: { outcome: string } }[]) => entries.map((e) => [e.result, e.reason ?? e.settlement?.outcome]);
const outcomeRows = (w: World) => w.store.history().filter((row) => row.kind === 'decision_outcome');

// ── B2: the dedicated domain ─────────────────────────────────────────────────

describe('FV-P4C-2B2B B2 — the bootstrap-authority domain cannot be confused with CORE-05', () => {
  it('identical fields commit differently in the two domains; the format names the domain', () => {
    const fields = { organizationId: ORG, approvalRequestId: 'frontera.sovereign-status-bootstrap:' + 'e'.repeat(64), subjectDigest: 'sha256:' + 'e'.repeat(64), verdict: 'approve' as const, operatorId: 'approver-b', nonce: 'n', issuedAt: '2026-10-29T12:00:00.000Z', expiresAt: '2026-10-29T12:02:00.000Z' };
    const core05 = humanDecisionChallengeCommitment({ ...fields, format: HUMAN_DECISION_CHALLENGE_FORMAT });
    const bootstrap = bootstrapAuthorityChallengeCommitment({ ...fields, format: BOOTSTRAP_AUTHORITY_CHALLENGE_FORMAT });
    assert.notEqual(core05, bootstrap);
    // A bootstrap contract recomputed under the CORE-05 domain (what a relabelled store row would claim) matches nothing.
    assert.notEqual(humanDecisionChallengeCommitment({ ...fields, format: BOOTSTRAP_AUTHORITY_CHALLENGE_FORMAT }), bootstrap);
  });

  it('a bootstrap decision is invisible to every CORE-05 read, and the CORE-05 channel cannot record an outcome for it', async () => {
    const w = await world();
    const b = binding();
    const pair = await consumedPair(w, b);
    for (const commitment of [pair.requester, pair.approver]) {
      assert.equal(w.service.decision(commitment), undefined);
      assert.equal(w.service.bootstrapAuthorityDecision(commitment)?.state, 'consumed');
      // False abandonment is impossible: AUTH-03 refuses a CORE-05 outcome for this domain.
      await assert.rejects(w.service.recordDecisionOutcome(commitment, { outcome: 'abandoned' }), /No authorized decision/);
      await assert.rejects(w.service.recordDecisionOutcome(commitment, { outcome: 'recorded', verdictRowDigest: 'sha256:' + '0'.repeat(64) }), /No authorized decision/);
    }
    assert.equal(outcomeRows(w).length, 0);
  });

  it('CORE-05 regression: the real channel’s reconcile() still abandons its own consumed decisions, and never touches bootstrap ones', async () => {
    const w = await world();
    const b = binding();
    const pair = await consumedPair(w, b);
    // A CORE-05-domain decision, consumed with no CORE-05 verdict (a crash between the two stores).
    const core05 = w.devices['approver-c']!.assert(w.service.beginDecision({ operatorId: 'approver-c', approvalRequestId: `approval-request:${'a'.repeat(64)}`, subjectDigest: `sha256:${'d'.repeat(64)}`, verdict: 'approve' }).options);
    const consumed = await w.service.authorizeDecision(core05);
    const channel = createHumanDecisionChannel({
      organizationId: ORG,
      approvals: { list: async () => [], approve: async () => assert.fail('no verdict'), reject: async () => assert.fail('no verdict') },
      identity: w.service,
      roleOf: () => 'approver',
    });
    assert.deepEqual(await channel.reconcile(), [{ commitment: consumed.commitment, settled: 'abandoned' }]);
    assert.equal(w.service.decision(consumed.commitment)?.outcome?.outcome, 'abandoned');
    // The bootstrap decisions are untouched, still awaiting their own settlement.
    assert.deepEqual(w.service.unsettledBootstrapAuthorityDecisions().map((d) => d.commitment), [pair.requester, pair.approver]);
    assert.deepEqual(await channel.reconcile(), []);
  });
});

// ── B1: AUTH-03 settlement checks ────────────────────────────────────────────

describe('FV-P4C-2B2B B1 — AUTH-03 records a settlement only when it agrees with the signed decisions', () => {
  const committed = (bindingDigest: string, counterpartCommitment: string, overrides: Record<string, unknown> = {}): BootstrapAuthoritySettlement =>
    ({ outcome: 'bootstrap-committed', bindingDigest, counterpartCommitment, bootstrapRequestId: 'req:x', bootstrapEvidenceDigest: 'sha256:' + '9'.repeat(64), historyRevision: 1, statusSequence: 1, statusDigest: 'b'.repeat(64), ...overrides }) as BootstrapAuthoritySettlement;

  it('refuses another binding, a same-role or same-human counterpart, a CORE-05 counterpart, unknown keys and a CORE-05 decision', async () => {
    const w = await world();
    const b = binding();
    const pair = await consumedPair(w, b);
    const other = binding();
    const otherPair = await consumedPair(w, other, 'approver-c');
    const core05 = await w.service.authorizeDecision(w.devices['approver-c']!.assert(w.service.beginDecision({ operatorId: 'approver-c', approvalRequestId: 'approval-request:x', subjectDigest: `sha256:${'d'.repeat(64)}`, verdict: 'approve' }).options));
    const conflict = /HUMAN_IDENTITY_DECISION_SETTLEMENT_CONFLICT|settlement|counterpart/i;
    await assert.rejects(w.service.recordBootstrapAuthoritySettlement(w.capability, pair.requester, committed(other.digest, pair.approver)), conflict);
    await assert.rejects(w.service.recordBootstrapAuthoritySettlement(w.capability, pair.requester, committed(b.digest, otherPair.requester)), conflict, 'counterpart of another bootstrap');
    await assert.rejects(w.service.recordBootstrapAuthoritySettlement(w.capability, pair.requester, committed(b.digest, pair.requester)), conflict, 'itself');
    await assert.rejects(w.service.recordBootstrapAuthoritySettlement(w.capability, pair.requester, committed(b.digest, core05.commitment)), conflict, 'a CORE-05 decision');
    await assert.rejects(w.service.recordBootstrapAuthoritySettlement(w.capability, pair.requester, committed(b.digest, 'sha256:' + '7'.repeat(64))), conflict, 'unknown');
    await assert.rejects(w.service.recordBootstrapAuthoritySettlement(w.capability, pair.requester, { ...committed(b.digest, pair.approver), external: true } as never), conflict, 'an external flag is an unknown key, not trust');
    await assert.rejects(w.service.recordBootstrapAuthoritySettlement(w.capability, pair.requester, { outcome: 'bootstrap-not-committed', bindingDigest: b.digest, code: 'OPERATOR_SAYS_SO' } as never), conflict);
    await assert.rejects(w.service.recordBootstrapAuthoritySettlement(w.capability, pair.requester, { outcome: 'recorded', verdictRowDigest: 'sha256:' + '0'.repeat(64) } as never), conflict);
    await assert.rejects(w.service.recordBootstrapAuthoritySettlement(w.capability, core05.commitment, committed(b.digest, pair.approver)), /No consumed bootstrap-authority decision/);
    assert.equal(outcomeRows(w).length, 0, 'nothing was recorded');
  });

  it('a same-human counterpart is refused even when both roles were consumed', async () => {
    const w = await world();
    const b = binding();
    // Both roles signed by one human, consumed directly (the authorizer would refuse them as SAME_PRINCIPAL).
    const attest = await w.service.authorizeBootstrapAuthorityDecision(decide(w, 'requester-a', b.digest, 'requester'));
    const approve = await w.service.authorizeBootstrapAuthorityDecision(decide(w, 'requester-a', b.digest, 'approver'));
    await assert.rejects(w.service.recordBootstrapAuthoritySettlement(w.capability, attest.commitment, committed(b.digest, approve.commitment)), /another human/);
  });

  it('an identical second settlement is unchanged; a different one is a conflict; nothing is rewritten; a restart reproduces it', async () => {
    const w = await world();
    const b = binding();
    const pair = await consumedPair(w, b);
    const before = w.store.history().map((row) => row.digest);
    const s = committed(b.digest, pair.approver);
    assert.equal(await w.service.recordBootstrapAuthoritySettlement(w.capability, pair.requester, s), 'recorded');
    assert.equal(await w.service.recordBootstrapAuthoritySettlement(w.capability, pair.requester, { ...s }), 'unchanged');
    await assert.rejects(w.service.recordBootstrapAuthoritySettlement(w.capability, pair.requester, { outcome: 'bootstrap-not-committed', bindingDigest: b.digest, code: 'NO_BOOTSTRAP_EVIDENCE' }), /different settlement/);
    await assert.rejects(w.service.recordBootstrapAuthoritySettlement(w.capability, pair.requester, committed(b.digest, pair.approver, { historyRevision: 2 })), /different settlement/);
    // The counterpart cannot be settled inconsistently with it.
    await assert.rejects(w.service.recordBootstrapAuthoritySettlement(w.capability, pair.approver, committed(b.digest, pair.requester, { bootstrapEvidenceDigest: 'sha256:' + '8'.repeat(64) })), /contradicts the counterpart/);
    const afterRows = w.store.history();
    assert.equal(afterRows.length, before.length + 1, 'exactly one append');
    assert.deepEqual(afterRows.slice(0, before.length).map((row) => row.digest), before, 'no earlier signed row changed');
    await restartIdentity(w);
    assert.deepEqual(w.service.bootstrapAuthorityDecision(pair.requester)?.settlement, s);
    assert.deepEqual(w.service.unsettledBootstrapAuthorityDecisions().map((d) => d.commitment), [pair.approver]);
  });
});

// ── B1: reconciliation from the receiver's evidence ──────────────────────────

describe('FV-P4C-2B2B B1 — settlement is correlated to the receiver’s own bootstrap evidence', () => {
  it('committed: both decisions settle bootstrap-committed, citing the evidence and the exact transition; a rerun finds nothing', async () => {
    const w = await world();
    const b = binding();
    const pair = await consumedPair(w, b);
    const evidence = await anchor(w, b, pair.authorityRef);
    assert.deepEqual(await w.history.readBootstrapEvidenceForBinding(b.digest), [evidence]);
    const entries = await reconciler(w).reconcile();
    assert.deepEqual(summary(entries), [['settled', 'bootstrap-committed'], ['settled', 'bootstrap-committed']]);
    const requester = w.service.bootstrapAuthorityDecision(pair.requester)!.settlement!;
    assert.deepEqual(requester, { outcome: 'bootstrap-committed', bindingDigest: b.digest, counterpartCommitment: pair.approver, bootstrapRequestId: b.binding.requestId, bootstrapEvidenceDigest: bootstrapEvidenceDigest(evidence), historyRevision: 1, statusSequence: 1, statusDigest: 'b'.repeat(64) });
    assert.equal((w.service.bootstrapAuthorityDecision(pair.approver)!.settlement as { counterpartCommitment: string }).counterpartCommitment, pair.requester);
    assert.deepEqual(await reconciler(w).reconcile(), []);
  });

  it('missing evidence: in flight or within grace is unresolved (no write); after grace it is auditable as NOT committed', async () => {
    const w = await world();
    const pair = await consumedPair(w, binding());
    assert.deepEqual(summary(await reconciler(w).reconcile()), [['unresolved', 'WITHIN_GRACE'], ['unresolved', 'WITHIN_GRACE']]);
    w.clock.advance(GRACE + 1);
    assert.deepEqual(summary(await reconciler(w, { inFlight: (c) => c === pair.approver }).reconcile()), [['settled', 'bootstrap-not-committed'], ['unresolved', 'IN_FLIGHT']]);
    assert.equal(outcomeRows(w).length, 1);
    assert.deepEqual(w.service.bootstrapAuthorityDecision(pair.requester)?.settlement, { outcome: 'bootstrap-not-committed', bindingDigest: w.service.bootstrapAuthorityDecision(pair.requester)!.contract.subjectDigest.slice(7), code: 'NO_BOOTSTRAP_EVIDENCE' });
  });

  it('partial consumption (the approver refused at consumption) settles the requester as not committed', async () => {
    const w = await world();
    const b = binding();
    const requester = decide(w, 'requester-a', b.digest, 'requester');
    const approver = decide(w, 'approver-b', b.digest, 'approver');
    await w.service.revokePrincipal(w.admin, 'approver-b', 'revoked mid-ceremony');
    const a = createHumanDecisionBootstrapAuthorizer({ decisions: w.service, organizationId: ORG, permissions: allow, requesterResponse: requester, approverResponse: approver });
    assert.deepEqual(await a.authorizeStatusHistoryBootstrap(b.binding, b.digest), { outcome: 'denied' });
    w.clock.advance(GRACE + 1);
    assert.deepEqual(summary(await reconciler(w).reconcile()), [['settled', 'bootstrap-not-committed']]);
  });

  it('the binding anchored by OTHER decisions settles this attempt as ANCHORED_BY_OTHER_DECISIONS, without waiting', async () => {
    const w = await world();
    const b = binding();
    const losing = await consumedPair(w, b, 'approver-c');
    const winning = await consumedPair(w, b, 'approver-b');
    await anchor(w, b, winning.authorityRef);
    const entries = await reconciler(w).reconcile();
    const byCommitment = new Map(entries.map((e) => [e.commitment, e]));
    for (const c of [losing.requester, losing.approver]) assert.equal((byCommitment.get(c) as { settlement: { code: string } }).settlement.code, 'ANCHORED_BY_OTHER_DECISIONS');
    for (const c of [winning.requester, winning.approver]) assert.equal((byCommitment.get(c) as { settlement: { outcome: string } }).settlement.outcome, 'bootstrap-committed');
  });

  it('tampered evidence — roles swapped in its authorityRef, or another operator — is a conflict, and nothing is written', async () => {
    const w = await world();
    const b = binding();
    const pair = await consumedPair(w, b);
    await anchor(w, b, `frontera.sovereign-status-bootstrap-authority.v1:${pair.approver}:${pair.requester}`);
    assert.deepEqual(summary(await reconciler(w).reconcile()), [['conflict', 'EVIDENCE_CONTRADICTS_DECISION'], ['conflict', 'EVIDENCE_CONTRADICTS_DECISION']]);
    // Real evidence, in the real store, naming the pair in role order but another operator than the requester.
    const c = binding();
    const pair2 = await consumedPair(w, c);
    await anchor(w, c, pair2.authorityRef, 'operator:approver-c');
    const entries = await reconciler(w).reconcile();
    assert.deepEqual(entries.filter((e) => e.commitment === pair2.requester).map((e) => [e.result, (e as { reason?: string }).reason]), [['conflict', 'EVIDENCE_CONTRADICTS_DECISION']]);
    assert.equal(w.service.bootstrapAuthorityDecision(pair.requester)?.settlement, undefined);
  });

  it('cross-store failures fail closed: an unreadable history or a failed AUTH-03 append leaves the decision unsettled, and the next run settles it', async () => {
    const w = await world();
    const b = binding();
    const pair = await consumedPair(w, b);
    w.clock.advance(GRACE + 1);
    // A closed (unavailable) history: never "no evidence".
    w.history.close();
    assert.deepEqual(summary(await reconciler(w).reconcile()), [['unresolved', 'HISTORY_UNAVAILABLE'], ['unresolved', 'HISTORY_UNAVAILABLE']], 'never "no evidence"');
    await restartHistory(w);
    await anchor(w, b, pair.authorityRef);
    const failing: BootstrapAuthoritySettlementPort = { unsettledBootstrapAuthorityDecisions: () => w.capability.unsettledBootstrapAuthorityDecisions(), recordBootstrapAuthoritySettlement: async () => { throw new Error('witness unavailable'); } };
    assert.deepEqual(summary(await reconciler(w, { decisions: failing }).reconcile()), [['unresolved', 'SETTLEMENT_FAILED'], ['unresolved', 'SETTLEMENT_FAILED']]);
    assert.equal(outcomeRows(w).length, 0);
    // Restart of both stores, then recovery.
    await restartIdentity(w);
    await restartHistory(w);
    assert.deepEqual(summary(await reconciler(w).reconcile()), [['settled', 'bootstrap-committed'], ['settled', 'bootstrap-committed']]);
  });

  it('concurrent reconcilers settle each decision exactly once', async () => {
    const w = await world();
    const b = binding();
    const pair = await consumedPair(w, b);
    await anchor(w, b, pair.authorityRef);
    const [first, second] = await Promise.all([reconciler(w).reconcile(), reconciler(w).reconcile()]);
    for (const entries of [first, second]) for (const e of entries) assert.ok(e.result === 'settled' || e.result === 'unchanged', e.result);
    assert.equal(outcomeRows(w).length, 2);
  });

  it('a conflicting settlement is surfaced, and evidence that appears after a not-committed settlement is a conflict', async () => {
    const w = await world();
    const b = binding();
    const pair = await consumedPair(w, b);
    w.clock.advance(GRACE + 1);
    // A commit lands right after the not-committed settlement is written (the grace race), in the real store.
    let landed = false;
    const racing: BootstrapAuthoritySettlementPort = {
      unsettledBootstrapAuthorityDecisions: () => w.capability.unsettledBootstrapAuthorityDecisions(),
      recordBootstrapAuthoritySettlement: async (commitment, settlement) => {
        const written = await w.capability.recordBootstrapAuthoritySettlement(commitment, settlement);
        if (!landed) {
          landed = true;
          await anchor(w, b, pair.authorityRef);
        }
        return written;
      },
    };
    const entries = await reconciler(w, { decisions: racing }).reconcile();
    assert.deepEqual(summary(entries)[0], ['conflict', 'EVIDENCE_APPEARED_AFTER_NOT_COMMITTED']);
    // The requester stays recorded as not committed (append-only); the approver can no longer be settled as committed against it.
    assert.equal(w.service.bootstrapAuthorityDecision(pair.requester)?.settlement?.outcome, 'bootstrap-not-committed');
    assert.deepEqual(summary(await reconciler(w).reconcile()), [['conflict', 'SETTLEMENT_CONFLICT']]);
  });

  it('an unknown domain, or a record that merely claims to be external, is never settled', async () => {
    const w = await world();
    const pair = await consumedPair(w, binding());
    const real = w.service.unsettledBootstrapAuthorityDecisions()[0]!;
    let writes = 0;
    const forged: BootstrapAuthoritySettlementPort = {
      unsettledBootstrapAuthorityDecisions: () => [
        { ...real, contract: { ...real.contract, format: HUMAN_DECISION_CHALLENGE_FORMAT } },
        { ...real, contract: { ...real.contract, format: 'frontera.payment-approval.v1' } },
        { ...real, contract: { ...real.contract, organizationId: 'org-other' } },
        { ...real, evidence: { ...real.evidence!, verdict: 'approve' } },
        { commitment: pair.approver, external: true, state: 'consumed' },
      ],
      recordBootstrapAuthoritySettlement: async () => ((writes += 1), 'recorded'),
    };
    w.clock.advance(GRACE + 1);
    assert.deepEqual(summary(await reconciler(w, { decisions: forged }).reconcile()), Array.from({ length: 5 }, () => ['conflict', 'DECISION_MALFORMED']));
    assert.equal(writes, 0);
  });

  it('the reconciler is bounded and searches every history store once', () => {
    const w = { history: { store: {}, namespace: NAMESPACE, databasePath: '/x/history.sqlite' } };
    const base = { settlement: { unsettledBootstrapAuthorityDecisions: () => [], recordBootstrapAuthoritySettlement: async () => 'recorded' as const }, inFlight: () => false, organizationId: ORG, now: () => '2026-10-29T12:00:00Z' };
    assert.throws(() => createBootstrapAuthorityReconciler({ ...base, histories: [], graceSeconds: 1 }), /every history/);
    assert.throws(() => createBootstrapAuthorityReconciler({ ...base, histories: [w.history, w.history], graceSeconds: 1 }), /once each/);
    assert.throws(() => createBootstrapAuthorityReconciler({ ...base, histories: [w.history], graceSeconds: 0 }), /graceSeconds/);
    assert.throws(() => createBootstrapAuthorityReconciler({ ...base, histories: [w.history], graceSeconds: 3601 }), /graceSeconds/);
    assert.throws(() => createBootstrapAuthorityReconciler({ ...base, histories: [w.history], graceSeconds: 1, maxDecisions: 1001 }), /maxDecisions/);
    // Review fix: the in-flight registry is required; there is no "nothing is in flight" default.
    assert.throws(() => createBootstrapAuthorityReconciler({ ...base, inFlight: undefined as never, histories: [w.history], graceSeconds: 1 }), /inFlight/);
  });
});

// ── B4: permissions from the Kernel-Authority world ──────────────────────────

const TRUST_DOMAIN = 'trust-domain-fv';
const ISSUER = 'actor-org-fv';
const PROVISIONER = { system: true, actorId: 'operator-fv-provisioner' } as const;

interface Authority {
  readonly provisioning: KernelAuthorityProvisioningService;
  readonly standing: BootstrapStandingPort;
  grant(operatorId: string, permission: string, scopes: readonly string[], extra?: Record<string, unknown>): Promise<string>;
}

/** A real Kernel-Authority world, and the standing port built exactly as the composition root builds CORE-05's. */
async function authority(clock: Clock): Promise<Authority> {
  const store = createInMemoryKernelAuthorityStore({ now: clock.iso });
  // The engine judges expiry by its own clock: the test's, as the Host's trusted clock would be.
  const kernelClock = { now: clock.iso };
  let kernel = await createDurableKernelWorld({ store, organizationId: ORG, clock: kernelClock });
  const provisioning = createKernelAuthorityProvisioningService({ store, organizationId: ORG, onCommitted: async () => { kernel = await createDurableKernelWorld({ store, organizationId: ORG, clock: kernelClock }); } });
  await provisioning.provisionActor(PROVISIONER, { actorId: ISSUER, type: 'organization', displayName: 'FV Org' });
  await provisioning.provisionTrustDomain(PROVISIONER, { trustDomainId: TRUST_DOMAIN, name: 'FV', issuerActorId: ISSUER, acceptedIssuerIds: [ISSUER], acceptedActorTypes: ['human', 'organization'] });
  await provisioning.provisionRootIssuer(PROVISIONER, { trustDomainId: TRUST_DOMAIN, actorId: ISSUER });
  for (const operatorId of OPERATORS) await provisioning.provisionActor(PROVISIONER, { actorId: `operator:${operatorId}`, type: 'human', displayName: operatorId, issuerId: ISSUER, trustDomainId: TRUST_DOMAIN });
  const lineage = createKernelAuthorityLineageRevalidator({ organizationId: ORG, trustDomainId: TRUST_DOMAIN, authority: () => kernel.providerSet.authorityRuntime });
  const standing: BootstrapStandingPort = {
    recognition: (actorId) => createActorRegistryRecognitionIntegration(kernel.providerSet.recognitionRuntime.actorRegistry).getApproverRecognitionStatus(actorId),
    authority: ({ actorId, capability, resourceScope, at }) => {
      const check = createApprovalAuthorityGraphIntegration(kernel.providerSet.authorityRuntime).verifyAuthority({ requestId: 'fv-bootstrap-permission:check', actorId, trustDomainId: TRUST_DOMAIN, action: capability, resourceScope, requestedAt: at });
      return check.valid && !lineage({ subject: actorId, action: capability, resourceScope, organizationId: ORG, at }) ? { ...check, valid: false } : check;
    },
  };
  let grants = 0;
  return {
    provisioning,
    standing,
    async grant(operatorId, permission, scopes, extra = {}) {
      grants += 1;
      const authorityGrantId = `grant-fv-${grants}`;
      await provisioning.provisionAuthorityGrant(PROVISIONER, { authorityGrantId, issuerActorId: ISSUER, subjectActorId: `operator:${operatorId}`, trustDomainId: TRUST_DOMAIN, capability: 'status-history.bootstrap', actions: [permission], resourceScopes: [...scopes], canDelegate: false, ...extra });
      return authorityGrantId;
    },
  };
}

describe('FV-P4C-2B2B B4 — status-history.bootstrap.request / .approve, default-deny, from Kernel-Authority grants', () => {
  const scope = (namespace = NAMESPACE, organizationId = ORG) => ({ organizationId, namespace, bindingDigest: 'e'.repeat(64) });

  it('CTRL-02 is unchanged: no operator role — organization administrator included — holds either permission', () => {
    for (const permission of STATUS_HISTORY_BOOTSTRAP_PERMISSIONS) {
      assert.equal((OPERATOR_PERMISSIONS as readonly string[]).includes(permission), false);
      for (const role of OPERATOR_ROLES) assert.equal(operatorMay(role, permission as never), false, role);
    }
    assert.equal(statusHistoryResourceScope('receiver-1'), `${STATUS_HISTORY_RESOURCE_SCOPE}:receiver-1`);
  });

  it('default deny; an explicit grant allows exactly its permission, for its namespace; neither implies the other', async () => {
    const clock = new Clock();
    const ka = await authority(clock);
    const permissions = createKernelAuthorityBootstrapPermissions({ standing: ka.standing, organizationId: ORG, now: clock.iso });
    for (const id of OPERATORS) assert.deepEqual([permissions.mayRequest(id, scope()), permissions.mayApprove(id, scope())], [false, false], id);
    await ka.grant('requester-a', STATUS_HISTORY_BOOTSTRAP_REQUEST_PERMISSION, [statusHistoryResourceScope(NAMESPACE)]);
    await ka.grant('approver-b', STATUS_HISTORY_BOOTSTRAP_APPROVE_PERMISSION, [statusHistoryResourceScope(NAMESPACE)]);
    // An organization-wide grant of an unrelated action confers nothing.
    await ka.grant('admin-x', 'authority.bootstrap', [STATUS_HISTORY_RESOURCE_SCOPE]);
    assert.equal(permissions.mayRequest('requester-a', scope()), true);
    assert.equal(permissions.mayApprove('requester-a', scope()), false, 'request does not imply approve');
    assert.equal(permissions.mayApprove('approver-b', scope()), true);
    assert.equal(permissions.mayRequest('approver-b', scope()), false, 'approve does not imply request');
    assert.deepEqual([permissions.mayRequest('admin-x', scope()), permissions.mayApprove('admin-x', scope())], [false, false]);
    assert.equal(permissions.mayRequest('requester-a', scope('receiver:other')), false, 'another namespace');
    assert.equal(permissions.mayRequest('requester-a', scope(NAMESPACE, 'org-other')), false, 'another organization');
    assert.equal(permissions.mayRequest('requester-a', { organizationId: ORG, namespace: NAMESPACE } as never), false, 'no binding');
    assert.equal(permissions.mayRequest('Requester-A', scope()), false, 'not an operator id');
    // Review fix: a namespace that is a ':'-prefix of another grants nothing over it (the namespace is encoded).
    await ka.grant('approver-c', STATUS_HISTORY_BOOTSTRAP_APPROVE_PERMISSION, [statusHistoryResourceScope('receiver')]);
    assert.equal(permissions.mayApprove('approver-c', scope('receiver')), true);
    assert.equal(permissions.mayApprove('approver-c', scope(NAMESPACE)), false, 'receiver does not contain receiver:fv-p4c2b2b');
    assert.equal(statusHistoryResourceScope(NAMESPACE), `${STATUS_HISTORY_RESOURCE_SCOPE}:receiver%3Afv-p4c2b2b`);
    // Kernel-Authority scope containment: a grant over the root scope covers every namespace — explicitly.
    // (On another operator: Kernel-Authority's resolver weighs only an actor's first grant for an action, so a second,
    // wider grant of the same action to approver-c would be ignored — a pre-existing false deny, fail-closed.)
    await ka.grant('admin-x', STATUS_HISTORY_BOOTSTRAP_APPROVE_PERMISSION, [STATUS_HISTORY_RESOURCE_SCOPE]);
    assert.equal(permissions.mayApprove('admin-x', scope('receiver:other')), true);
  });

  it('revocation, expiry, an unrecognized actor and a bad clock all deny', async () => {
    const clock = new Clock();
    const ka = await authority(clock);
    const permissions = createKernelAuthorityBootstrapPermissions({ standing: ka.standing, organizationId: ORG, now: clock.iso });
    const grant = await ka.grant('approver-b', STATUS_HISTORY_BOOTSTRAP_APPROVE_PERMISSION, [statusHistoryResourceScope(NAMESPACE)]);
    assert.equal(permissions.mayApprove('approver-b', scope()), true);
    await ka.provisioning.revoke(PROVISIONER, { entityKind: 'authority-grant', entityId: grant, reason: 'left the team' });
    assert.equal(permissions.mayApprove('approver-b', scope()), false, 'revoked grant');
    await ka.grant('approver-c', STATUS_HISTORY_BOOTSTRAP_APPROVE_PERMISSION, [statusHistoryResourceScope(NAMESPACE)], { expiresAt: '2026-10-29T12:05:00.000Z' });
    assert.equal(permissions.mayApprove('approver-c', scope()), true);
    clock.advance(600);
    assert.equal(permissions.mayApprove('approver-c', scope()), false, 'expired grant');
    await ka.grant('requester-a', STATUS_HISTORY_BOOTSTRAP_REQUEST_PERMISSION, [statusHistoryResourceScope(NAMESPACE)]);
    await ka.provisioning.revoke(PROVISIONER, { entityKind: 'actor', entityId: 'operator:requester-a', reason: 'offboarded' });
    assert.equal(permissions.mayRequest('requester-a', scope()), false, 'revoked actor');
    const broken = createKernelAuthorityBootstrapPermissions({ standing: ka.standing, organizationId: ORG, now: () => 'yesterday' });
    assert.equal(broken.mayRequest('approver-c', scope()), false);
  });

  it('end to end: the authorizer under real grants authorizes; after the approver’s grant is revoked a new pair is refused before consumption', async () => {
    const w = await world();
    const ka = await authority(w.clock);
    const permissions = createKernelAuthorityBootstrapPermissions({ standing: ka.standing, organizationId: ORG, now: w.clock.iso });
    await ka.grant('requester-a', STATUS_HISTORY_BOOTSTRAP_REQUEST_PERMISSION, [statusHistoryResourceScope(NAMESPACE)]);
    const approverGrant = await ka.grant('approver-b', STATUS_HISTORY_BOOTSTRAP_APPROVE_PERMISSION, [statusHistoryResourceScope(NAMESPACE)]);
    const b = binding();
    const first = createHumanDecisionBootstrapAuthorizer({ decisions: w.service, organizationId: ORG, permissions, requesterResponse: decide(w, 'requester-a', b.digest, 'requester'), approverResponse: decide(w, 'approver-b', b.digest, 'approver') });
    assert.equal(((await first.authorizeStatusHistoryBootstrap(b.binding, b.digest)) as { outcome: string }).outcome, 'authorized');
    // admin-x holds the passkey and the CTRL-02 administrator role elsewhere, but no grant: refused.
    const c = binding();
    const byAdmin = createHumanDecisionBootstrapAuthorizer({ decisions: w.service, organizationId: ORG, permissions, requesterResponse: decide(w, 'requester-a', c.digest, 'requester'), approverResponse: decide(w, 'admin-x', c.digest, 'approver') });
    assert.deepEqual(await byAdmin.authorizeStatusHistoryBootstrap(c.binding, c.digest), { outcome: 'denied' });
    assert.equal(byAdmin.lastDenial(), 'APPROVER_NOT_PERMITTED');
    await ka.provisioning.revoke(PROVISIONER, { entityKind: 'authority-grant', entityId: approverGrant, reason: 'rotation' });
    const d = binding();
    const approver = decide(w, 'approver-b', d.digest, 'approver');
    const second = createHumanDecisionBootstrapAuthorizer({ decisions: w.service, organizationId: ORG, permissions, requesterResponse: decide(w, 'requester-a', d.digest, 'requester'), approverResponse: approver });
    assert.deepEqual(await second.authorizeStatusHistoryBootstrap(d.binding, d.digest), { outcome: 'denied' });
    assert.equal(second.lastDenial(), 'APPROVER_NOT_PERMITTED');
    assert.deepEqual(second.consumedDecisions(), []);
    assert.equal(await w.service.authorizeBootstrapAuthorityDecision(approver).then(() => true, () => false), true, 'not consumed');
  });
});
