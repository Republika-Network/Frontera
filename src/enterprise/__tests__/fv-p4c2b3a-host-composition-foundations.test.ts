import { existsSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import Database from 'better-sqlite3';

import {
  INTENDED_PRODUCTION_RP_ID,
  createHumanIdentityServiceWithBootstrapSettlement,
  createRelyingPartyConfiguration,
  identityAdministratorFor,
  openSqliteHumanIdentityStore,
  isBootstrapSettlementCapabilityOf,
  revokeBootstrapSettlementCapability,
  type BootstrapSettlementCapability,
  type HumanIdentityService,
  type HumanIdentityStore,
} from '../human-identity/index.js';
import {
  HISTORY_CONTINUITY_SCHEMA,
  SOVEREIGN_STATUS_HISTORY_SCHEMA_VERSION,
  STATUS_HISTORY_BOOTSTRAP_EVIDENCE_SCHEMA,
  assessHistoryContinuity,
  assessRestoreCandidate,
  bootstrapAuthorityDecisionInput,
  bootstrapBindingDigest,
  bootstrapBindingOf,
  captureHistoryContinuity,
  createBootstrapOperationRegistry,
  createFvBootstrapAuthorityBoundary,
  createHostHistoryInventory,
  createHumanDecisionBootstrapAuthorizer,
  openSqliteStatusHighWaterMarkStore,
  parseBootstrapAuthorityRef,
  parseStatusHistoryBootstrapRequest,
  readHistoryContinuityRecord,
} from '../sovereign-status-history/index.js';
import * as fvIndex from '../sovereign-status-history/index.js';
import type {
  BootstrapAuthorityReconciliationEntry,
  BootstrapIntent,
  BootstrapAuthoritySettlementPort,
  BootstrapHumanPermissions,
  HistoryContinuityRecord,
  HostHistoryConfiguration,
  SqliteStatusHighWaterMarkStore,
  StatusHistoryBootstrapBinding,
} from '../sovereign-status-history/index.js';
import { testSigner, testVerifier } from './authority-authenticity-fixture.js';
import { SoftwareAuthenticator } from './auth02-software-authenticator.js';

// FV-P4C-2B3A — Host composition foundations, against REAL services: the AUTH-03 identity service
// (software passkeys, signed chain), real SQLite status histories written through their own evidence
// path, and the real FV authorizer and reconciler. Synthetic principals and data; nothing is composed.

const ORG = 'org-fv-p4c2b3a';
const NS_A = 'receiver:fv-p4c2b3a-a';
const NS_B = 'receiver:fv-p4c2b3a-b';
const ORIGIN = `https://${INTENDED_PRODUCTION_RP_ID}`;
const RP = createRelyingPartyConfiguration({ rpId: INTENDED_PRODUCTION_RP_ID, rpName: 'Frontera Authority', allowedOrigins: [ORIGIN] });
const OPERATORS = ['requester-a', 'approver-b'];
const allow: BootstrapHumanPermissions = { mayRequest: (id) => id === 'requester-a', mayApprove: (id) => id === 'approver-b' };
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
  readonly service: HumanIdentityService;
  readonly capability: BootstrapSettlementCapability;
  readonly store: HumanIdentityStore;
  readonly devices: Record<string, SoftwareAuthenticator>;
  readonly paths: Record<string, string>;
  readonly records: Map<string, unknown>;
  readonly intents: Map<string, Map<string, BootstrapIntent>>;
  config: HostHistoryConfiguration | undefined;
}

const pathOf = (dir: string, namespace: string) => join(dir, `${namespace.replace(/[^a-z0-9]/g, '_')}.sqlite`);

async function world(): Promise<World> {
  const dir = mkdtempSync(join(tmpdir(), 'fv-p4c2b3a-'));
  directories.push(dir);
  const clock = new Clock();
  const store = await openSqliteHumanIdentityStore(join(dir, 'human-identity.sqlite'), { organizationId: ORG, now: clock.iso, authenticity: { signer: testSigner(), verifier: testVerifier() }, create: true });
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
  // The registration ceremony a B3B operator would perform: create each history, record its continuity.
  const paths: Record<string, string> = {};
  const records = new Map<string, unknown>();
  for (const namespace of [NS_A, NS_B]) {
    paths[namespace] = pathOf(dir, namespace);
    const created = await openSqliteStatusHighWaterMarkStore(paths[namespace]!, { namespace, create: true });
    records.set(namespace, captureHistoryContinuity(created, { namespace, databasePath: paths[namespace]!, generation: 1, recordedAt: clock.iso() }));
    created.close();
  }
  const w: World = { dir, clock, service, capability, store, devices, paths, records, intents: new Map(), config: undefined };
  w.config = { generation: 1, histories: [NS_A, NS_B].map((namespace) => ({ namespace, databasePath: paths[namespace]! })) };
  return w;
}

/** `hooks` inject a fault or an observation into the record port (R3: crash points inside `trackBootstrap`). */
function hostInventory(w: World, hooks: { readonly onSave?: () => void; readonly onComplete?: () => void } = {}) {
  const inventory = createHostHistoryInventory({
    configuration: () => w.config,
    records: {
      load: (namespace) => w.records.get(namespace),
      save: (record) => {
        hooks.onSave?.();
        w.records.set(record.namespace, record);
      },
      pendingIntents: (namespace) => [...(w.intents.get(namespace)?.values() ?? [])],
      beginIntent: (namespace, intent) => void (w.intents.get(namespace) ?? w.intents.set(namespace, new Map()).get(namespace)!).set(intent.requestId, intent),
      completeIntent: (namespace, requestId) => {
        hooks.onComplete?.();
        w.intents.get(namespace)?.delete(requestId);
      },
    },
    now: w.clock.iso,
  });
  closers.push(() => inventory.close());
  return inventory;
}

let counter = 0;
function bootstrapRequest(namespace = NS_A, overrides: Record<string, unknown> = {}) {
  counter += 1;
  return {
    schemaVersion: 'frontera.sovereign-status-bootstrap/1',
    requestId: `req:fv-p4c2b3a-${counter}`,
    operation: 'establish',
    purpose: 'initial-trust-anchor',
    namespace,
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
  };
}
const bindingOf = (request: unknown): { binding: StatusHistoryBootstrapBinding; digest: string } => {
  const b = bootstrapBindingOf(parseStatusHistoryBootstrapRequest(request)!);
  return { binding: b, digest: bootstrapBindingDigest(b) };
};
const decide = (w: World, operatorId: string, binding: StatusHistoryBootstrapBinding, role: 'requester' | 'approver'): unknown =>
  w.devices[operatorId]!.assert(w.service.beginBootstrapAuthorityDecision({ operatorId, ...bootstrapAuthorityDecisionInput(binding, role) }).options);

/** Steps 3 and 5 of the coordinator, with the real authorizer and the store's own evidence transaction; `gate` stands in for a slow step 4. */
async function attempt(w: World, decisions: { peekBootstrapAuthorityDecision: never; authorizeBootstrapAuthorityDecision: never } | unknown, history: SqliteStatusHighWaterMarkStore, request: unknown, gate: () => Promise<void> = async () => undefined, commit = true) {
  const { binding, digest } = bindingOf(request);
  const authorizer = createHumanDecisionBootstrapAuthorizer({ decisions: decisions as never, organizationId: ORG, permissions: allow, requesterResponse: decide(w, 'requester-a', binding, 'requester'), approverResponse: decide(w, 'approver-b', binding, 'approver') });
  const result = (await authorizer.authorizeStatusHistoryBootstrap(binding, digest)) as { outcome: string; authorityRef: string };
  assert.equal(result.outcome, 'authorized', String(authorizer.lastDenial()));
  const ref = parseBootstrapAuthorityRef(result.authorityRef)!;
  await gate();
  if (commit) await anchor(history, binding, digest, result.authorityRef);
  return { requester: ref.requesterCommitment, approver: ref.approverCommitment, authorityRef: result.authorityRef };
}

async function anchor(history: SqliteStatusHighWaterMarkStore, b: StatusHistoryBootstrapBinding, digest: string, authorityRef: string): Promise<void> {
  const at = '2026-10-29T12:00:30Z';
  const key = { sovereignAssetId: b.sovereignAssetId, issuer: b.issuer };
  const recorded = await history.compareAndSetWithEvidence(
    key,
    null,
    { ...key, sequence: 1, statusDigest: 'b'.repeat(64), issuedAt: '2026-10-29T11:59:00Z', currentTermsDigest: null, timeFloor: '2026-10-29T11:59:00Z', withdrawn: false, retiredTermsDigests: [], continuity: 'verified', conflict: false, anchoredAt: at },
    {
      schemaVersion: STATUS_HISTORY_BOOTSTRAP_EVIDENCE_SCHEMA,
      operationId: `op:${b.requestId}`,
      requestId: b.requestId,
      namespace: b.namespace,
      sovereignAssetId: key.sovereignAssetId,
      issuer: key.issuer,
      operation: 'establish',
      purpose: 'initial-trust-anchor',
      bindingDigest: digest,
      operatorRef: b.operatorRef,
      authorityRef,
      sources: [{ sourceClass: 'issuer-status-channel', sourceRef: 'source:issuer-channel', observedAt: at }],
      status: { sequence: 1, statusDigest: 'b'.repeat(64) },
      evaluationTime: at,
      result: 'committed',
      classification: 'host-recorded-unsigned',
    },
  );
  assert.notEqual(recorded, false);
}

function boundary(w: World, inventory: ReturnType<typeof hostInventory>, settlement: BootstrapAuthoritySettlementPort = w.capability) {
  return createFvBootstrapAuthorityBoundary({ service: w.service, settlement, custody: isBootstrapSettlementCapabilityOf, histories: inventory, organizationId: ORG, now: w.clock.iso, graceSeconds: GRACE });
}

/** One of this Host's own bootstraps, through the inventory's write-ahead intent, on the admitted handle. */
async function tracked(w: World, inventory: ReturnType<typeof hostInventory>, request: ReturnType<typeof bootstrapRequest>, commit = true) {
  const ran = await inventory.trackBootstrap(request.namespace, intentOf(request), async (history, ensureIntent) => {
    ensureIntent(); // what the boundary's gated authorize does before consumption
    return attempt(w, w.service, history, request, async () => undefined, commit);
  });
  assert.equal(ran.outcome, 'ran');
  return (ran as { value: Awaited<ReturnType<typeof attempt>> }).value;
}

const intentOf = (request: ReturnType<typeof bootstrapRequest>): BootstrapIntent => ({ requestId: request.requestId, bindingDigest: bindingOf(request).digest });
/** A crash with this intent pending: written, never completed. */
const pend = (w: World, request: ReturnType<typeof bootstrapRequest>) => void (w.intents.get(request.namespace) ?? w.intents.set(request.namespace, new Map()).get(request.namespace)!).set(request.requestId, intentOf(request));

/** A status update by the receiver's freshness gate: a row advances, with no evidence. */
async function gateAdvance(history: SqliteStatusHighWaterMarkStore, request: ReturnType<typeof bootstrapRequest>): Promise<void> {
  const key = { sovereignAssetId: request.sovereignAssetId, issuer: request.issuer };
  const current = await history.read(key);
  assert.ok(current !== undefined);
  assert.equal(await history.compareAndSet(key, current.revision, { ...current.mark, sequence: 2, statusDigest: 'd'.repeat(64) }), true);
}

const rmHistory = (path: string) => {
  for (const s of ['', '-wal', '-shm']) rmSync(`${path}${s}`, { force: true });
};

/** One startup's assessment, closed afterwards so no handle stays open on the file. */
async function probe(w: World) {
  const inv = hostInventory(w);
  const status = await inv.refresh();
  inv.close();
  return status;
}

const summary = (entries: readonly BootstrapAuthorityReconciliationEntry[]) => entries.map((e) => [e.result, 'reason' in e ? e.reason : e.settlement.outcome]);
const of = (entries: readonly BootstrapAuthorityReconciliationEntry[], commitment: string) => summary(entries.filter((e) => e.commitment === commitment));
const outcomeRows = (w: World) => w.store.history().filter((row) => row.kind === 'decision_outcome');
const classes = (status: { histories: readonly { namespace: string; class: string }[] }) => Object.fromEntries(status.histories.map((h) => [h.namespace, h.class]));

function backupOf(source: string, target: string): void {
  const db = new Database(source, { readonly: true });
  try {
    db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
  } finally {
    db.close();
  }
}

/** Opens a writable handle on an admitted history for the test's own "bootstrap" commits. */
async function writer(w: World, namespace: string): Promise<SqliteStatusHighWaterMarkStore> {
  const store = await openSqliteStatusHighWaterMarkStore(w.paths[namespace]!, { namespace });
  closers.push(() => store.close());
  return store;
}

// ── Authority custody ───────────────────────────────────────────────────────

describe('FV-P4C-2B3A authority custody — the boundary splits the AUTH-03 pair; the capability and the store never leave it', () => {
  it('the bootstrap path receives exactly peek and authorize; nothing reachable from the boundary is the service, its store or the capability', async () => {
    const w = await world();
    const inventory = hostInventory(w);
    await inventory.refresh();
    const b = boundary(w, inventory);
    assert.ok(Object.isFrozen(b) && Object.isFrozen(b.bootstrapDecisions));
    assert.deepEqual(Object.keys(b.bootstrapDecisions).sort(), ['authorizeBootstrapAuthorityDecision', 'peekBootstrapAuthorityDecision']);
    assert.deepEqual(Object.keys(b).sort(), ['bootstrapDecisions', 'dispose', 'inFlightOperations', 'reconcile', 'runBootstrap']);
    const seen = new Set<unknown>();
    const walk = (value: unknown, depth: number) => {
      if ((typeof value !== 'object' && typeof value !== 'function') || value === null || seen.has(value) || depth > 4) return;
      seen.add(value);
      assert.notEqual(value, w.service);
      assert.notEqual(value, w.store);
      assert.notEqual(value, w.capability);
      for (const key of Reflect.ownKeys(value as object)) {
        const descriptor = Reflect.getOwnPropertyDescriptor(value as object, key);
        if (descriptor !== undefined && 'value' in descriptor) walk(descriptor.value, depth + 1);
      }
    };
    walk(b, 0);
    // Its decision port is the bootstrap domain only: a CORE-05 challenge is refused by AUTH-03.
    const core05 = w.devices['approver-b']!.assert(w.service.beginDecision({ operatorId: 'approver-b', approvalRequestId: 'approval:core05-1', subjectDigest: `sha256:${'c'.repeat(64)}`, verdict: 'approve' }).options);
    assert.throws(() => b.bootstrapDecisions.peekBootstrapAuthorityDecision(core05));
  });

  it('exact custody: a look-alike port, another service’s capability (even with nothing listed) and a revoked capability are refused at construction', async () => {
    const w = await world();
    const inventory = hostInventory(w);
    await inventory.refresh();
    const lookAlike: BootstrapAuthoritySettlementPort = { unsettledBootstrapAuthorityDecisions: () => w.capability.unsettledBootstrapAuthorityDecisions(), recordBootstrapAuthoritySettlement: async () => 'recorded' };
    assert.throws(() => boundary(w, inventory, lookAlike), /not this identity service/);
    // Review M4: both listings empty, the old heuristic passed; the exact check does not.
    const other = await world();
    assert.deepEqual(other.capability.unsettledBootstrapAuthorityDecisions(), []);
    assert.deepEqual(w.capability.unsettledBootstrapAuthorityDecisions(), []);
    assert.throws(() => boundary(w, inventory, other.capability), /not this identity service/);
    // A second service over the very same store: its capability is not this service's.
    const twin = createHumanIdentityServiceWithBootstrapSettlement({ store: w.store, relyingParty: RP, operatorIds: OPERATORS, now: w.clock.now });
    assert.throws(() => boundary(w, inventory, twin.settlementCapability), /not this identity service/);
    assert.throws(() => createFvBootstrapAuthorityBoundary({ service: w.service, settlement: w.capability, custody: () => true as never, histories: inventory, organizationId: ORG, now: w.clock.iso, graceSeconds: GRACE }) && boundary(w, inventory, lookAlike));
    revokeBootstrapSettlementCapability(w.capability);
    assert.throws(() => boundary(w, inventory), /not this identity service/);
  });

  it('a capability revoked after construction settles nothing: AUTH-03 refuses, reported unresolved', async () => {
    const w = await world();
    const inventory = hostInventory(w);
    await inventory.refresh();
    const b = boundary(w, inventory);
    await tracked(w, inventory, bootstrapRequest(NS_A));
    revokeBootstrapSettlementCapability(w.capability);
    assert.deepEqual(summary(await b.reconcile()), [['unresolved', 'SETTLEMENT_UNAUTHORIZED'], ['unresolved', 'SETTLEMENT_UNAUTHORIZED']]);
    assert.equal(outcomeRows(w).length, 0);
  });

  it('dispose: every later call is refused, and the registry takes no new run', async () => {
    const w = await world();
    const inventory = hostInventory(w);
    await inventory.refresh();
    const b = boundary(w, inventory);
    b.dispose();
    await assert.rejects(b.reconcile(), /disposed/);
    assert.throws(() => b.bootstrapDecisions.peekBootstrapAuthorityDecision({}), /disposed/);
    await assert.rejects(b.bootstrapDecisions.authorizeBootstrapAuthorityDecision({}), /disposed/);
    let ran = false;
    assert.deepEqual(await b.runBootstrap(bootstrapRequest(), async () => (ran = true)), { outcome: 'refused', reason: 'CLOSED' });
    assert.equal(ran, false);
  });

  it('a malformed service, capability, custody check, inventory or clock is refused at construction', async () => {
    const w = await world();
    const inventory = hostInventory(w);
    const base = { service: w.service, settlement: w.capability, custody: isBootstrapSettlementCapabilityOf, histories: inventory, organizationId: ORG, now: w.clock.iso, graceSeconds: GRACE };
    for (const patch of [{ service: {} }, { settlement: {} }, { custody: undefined }, { histories: { inventory: inventory.inventory } }, { now: undefined }, { service: { ...w.service, bootstrapAuthorityDecision: undefined } }]) {
      assert.throws(() => createFvBootstrapAuthorityBoundary({ ...base, ...patch } as never), TypeError);
    }
  });
});

// ── Durable namespace identity ──────────────────────────────────────────────

describe('FV-P4C-2B3A namespace continuity — a history is admitted only if it holds everything the Host last recorded', () => {
  it('same store reopened: CONTINUOUS; a tracked bootstrap re-captures the record; a freshness-gate advance is ADVANCED; an untracked commit is UNEXPLAINED_EVIDENCE', async () => {
    const w = await world();
    const inventory = hostInventory(w);
    assert.deepEqual(classes(await inventory.refresh()), { [NS_A]: 'CONTINUOUS', [NS_B]: 'CONTINUOUS' });
    assert.equal(inventory.status().readiness, 'ready');
    const request = bootstrapRequest(NS_A);
    await tracked(w, inventory, request);
    assert.deepEqual([...(w.intents.get(NS_A) ?? [])], [], 'intent completed after the record was re-captured');
    const after = await inventory.refresh();
    assert.equal(classes(after)[NS_A], 'CONTINUOUS');
    assert.equal(after.histories.find((h) => h.namespace === NS_A)!.proof, 'content');
    await gateAdvance(inventory.historyFor(NS_A)!, request);
    assert.equal(classes(await inventory.refresh())[NS_A], 'ADVANCED');
    // Review M1: a commit outside this Host's tracked path (a forged row, another writer).
    inventory.close();
    const outside = await writer(w, NS_A);
    await attempt(w, w.service, outside, bootstrapRequest(NS_A));
    outside.close();
    assert.equal(classes(await probe(w))[NS_A], 'UNEXPLAINED_EVIDENCE');
  });

  it('review H1: a commit, then a crash before the record is re-captured, then the file replaced or rolled back — quarantined (INTENT_UNRESOLVED), never a confident negative', async () => {
    const w = await world();
    const inventory = hostInventory(w);
    await inventory.refresh();
    const backup = join(w.dir, 'pre-commit.sqlite');
    backupOf(w.paths[NS_A]!, backup);
    // The crash: the intent was written, the commit happened, the record was never re-captured.
    const request = bootstrapRequest(NS_A);
    pend(w, request);
    const pair = await attempt(w, w.service, inventory.historyFor(NS_A) ?? (await writer(w, NS_A)), request);
    inventory.close();
    // The file is then replaced by its pre-commit copy (or a fresh history): the evidence is gone.
    rmHistory(w.paths[NS_A]!);
    backupOf(backup, w.paths[NS_A]!);
    const restarted = hostInventory(w);
    assert.equal(classes(await restarted.refresh())[NS_A], 'INTENT_UNRESOLVED');
    assert.deepEqual(restarted.inventory()!.histories.map((h) => h.namespace), [NS_B]);
    w.clock.advance(GRACE + 1);
    const entries = await boundary(w, restarted).reconcile();
    for (const c of [pair.requester, pair.approver]) assert.deepEqual(of(entries, c), [['unresolved', 'HISTORY_NOT_IN_INVENTORY']]);
    assert.equal(outcomeRows(w).length, 0, 'no false NO_BOOTSTRAP_EVIDENCE');
    assert.equal(classes(await restarted.refresh())[NS_A], 'INTENT_UNRESOLVED', 'never cleared automatically');
  });

  it('remap (another path), an older backup at the path, an empty or a different history, a missing and a corrupt file: each quarantined; the other namespace is served', async () => {
    const w = await world();
    const inventory = hostInventory(w);
    await inventory.refresh();
    const first = bootstrapRequest(NS_A);
    await tracked(w, inventory, first);
    const backup = join(w.dir, 'a-backup.sqlite');
    backupOf(w.paths[NS_A]!, backup); // one commit
    await tracked(w, inventory, bootstrapRequest(NS_A)); // the Host recorded two
    inventory.close();
    const expect = async (expected: string) => {
      const status = await probe(w);
      assert.equal(classes(status)[NS_A], expected);
      assert.equal(classes(status)[NS_B], 'CONTINUOUS');
      assert.equal(status.readiness, 'degraded');
    };
    w.config = { generation: 2, histories: [{ namespace: NS_A, databasePath: backup }, { namespace: NS_B, databasePath: w.paths[NS_B]! }] };
    await expect('MOVED');
    w.config = { generation: 3, histories: [NS_A, NS_B].map((namespace) => ({ namespace, databasePath: w.paths[namespace]! })) };
    rmHistory(w.paths[NS_A]!);
    backupOf(backup, w.paths[NS_A]!);
    await expect('ROLLED_BACK');
    rmHistory(w.paths[NS_A]!);
    const replacement = await openSqliteStatusHighWaterMarkStore(w.paths[NS_A]!, { namespace: NS_A, create: true });
    await expect('ROLLED_BACK');
    await attempt(w, w.service, replacement, first);
    replacement.close();
    await expect('DIVERGED');
    rmHistory(w.paths[NS_A]!);
    await expect('MISSING');
    assert.equal(existsSync(w.paths[NS_A]!), false, 'never recreated');
    writeFileSync(w.paths[NS_A]!, 'not a database at all, just bytes');
    await expect('CORRUPT');
  });

  it('review M2: a fork at an equal revision (same evidence, another status) is DIVERGED', async () => {
    const w = await world();
    const inventory = hostInventory(w);
    await inventory.refresh();
    const request = bootstrapRequest(NS_A);
    await tracked(w, inventory, request);
    const fork = join(w.dir, 'fork.sqlite');
    backupOf(w.paths[NS_A]!, fork);
    await gateAdvance(inventory.historyFor(NS_A)!, request);
    await inventory.refresh(); // ADVANCED is admitted, but the record is not re-captured by the gate
    // Re-capture through a tracked bootstrap of another asset, so the record holds revision 2 of the first.
    await tracked(w, inventory, bootstrapRequest(NS_A));
    inventory.close();
    // The fork advanced the same row to revision 2 with other content.
    const forked = await openSqliteStatusHighWaterMarkStore(fork, { namespace: NS_A });
    const key = { sovereignAssetId: request.sovereignAssetId, issuer: request.issuer };
    const current = (await forked.read(key))!;
    assert.equal(await forked.compareAndSet(key, current.revision, { ...current.mark, sequence: 3, statusDigest: 'e'.repeat(64) }), true);
    forked.close();
    rmHistory(w.paths[NS_A]!);
    backupOf(fork, w.paths[NS_A]!);
    assert.equal(classes(await probe(w))[NS_A], 'DIVERGED');
  });

  it('review M3/M6: a file swapped under an open handle is FILE_REPLACED; a quarantined file is never written to', async () => {
    const w = await world();
    const inventory = hostInventory(w);
    await inventory.refresh();
    await tracked(w, inventory, bootstrapRequest(NS_A));
    const copy = join(w.dir, 'copy.sqlite');
    backupOf(w.paths[NS_A]!, copy);
    const before = inventory.inventory()!;
    // Swap the file at the configured path while the inventory holds its handle (POSIX semantics; skipped where the OS refuses).
    let swapped = true;
    try {
      rmSync(w.paths[NS_A]!);
      backupOf(copy, w.paths[NS_A]!);
    } catch {
      swapped = false;
    }
    if (process.platform !== 'win32') assert.equal(swapped, true, 'POSIX allows replacing an open file: the check must be exercised');
    if (swapped) {
      const after = inventory.inventory()!;
      assert.ok(after.generation > before.generation);
      assert.deepEqual(after.histories.map((h) => h.namespace), [NS_B]);
      assert.equal(inventory.historyFor(NS_A), undefined);
    }
    inventory.close();
    // A namespace-mismatched file is assessed read-only: no WAL or SHM files appear, and its bytes are unchanged.
    rmHistory(w.paths[NS_A]!);
    const foreign = await openSqliteStatusHighWaterMarkStore(join(w.dir, 'foreign.sqlite'), { namespace: 'receiver:foreign', create: true });
    foreign.close();
    for (const s of ['-wal', '-shm']) rmSync(join(w.dir, `foreign.sqlite${s}`), { force: true });
    backupOf(join(w.dir, 'foreign.sqlite'), w.paths[NS_A]!);
    const bytes = readFileSync(w.paths[NS_A]!);
    assert.equal(classes(await probe(w))[NS_A], 'NAMESPACE_MISMATCH');
    assert.deepEqual(readFileSync(w.paths[NS_A]!), bytes);
    assert.equal(existsSync(`${w.paths[NS_A]}-wal`), false);
  });

  it('unknown namespace, an altered record, a configuration naming one file twice and non-genuine handles are never admitted', async () => {
    const w = await world();
    w.records.delete(NS_B);
    assert.equal(classes(await probe(w))[NS_B], 'UNREGISTERED');
    const record = w.records.get(NS_A) as HistoryContinuityRecord;
    w.records.set(NS_B, { ...record, createdRows: record.createdRows + 1 });
    assert.equal(classes(await probe(w))[NS_B], 'RECORD_INVALID');
    assert.equal(readHistoryContinuityRecord({ ...record, extra: true }), undefined);
    assert.equal(readHistoryContinuityRecord({ ...record, revisions: [['b', 'x', 1, `sha256:${'0'.repeat(64)}`], ['a', 'x', 1, `sha256:${'0'.repeat(64)}`]], createdRows: 2 }), undefined, 'unsorted is not one spelling');
    w.config = { generation: 2, histories: [{ namespace: NS_A, databasePath: w.paths[NS_A]! }, { namespace: NS_B, databasePath: w.paths[NS_A]! }] };
    assert.equal((await probe(w)).readiness, 'configuration-invalid', 'one file twice');
    const handle = await writer(w, NS_A);
    assert.equal(assessHistoryContinuity(record, { namespace: NS_A, databasePath: w.paths[NS_A]!, store: { ...handle } }).class, 'NOT_GENUINE');
    assert.equal(assessHistoryContinuity(record, { namespace: NS_A, databasePath: w.paths[NS_A]!, store: await writer(w, NS_B) }).class, 'NOT_GENUINE');
    assert.equal(assessHistoryContinuity(record, { namespace: NS_B, databasePath: w.paths[NS_A]!, store: handle }).class, 'NAMESPACE_MISMATCH');
    assert.throws(() => captureHistoryContinuity({ ...handle }, { namespace: NS_A, databasePath: w.paths[NS_A]!, generation: 1, recordedAt: w.clock.iso() }), /genuine/);
    assert.equal(HISTORY_CONTINUITY_SCHEMA, SOVEREIGN_STATUS_HISTORY_SCHEMA_VERSION);
  });

  it('LIMITATION: records and configuration are the Host’s trust root — a record re-captured from another file is believed (B3B protected storage)', async () => {
    const w = await world();
    const status = await probe(w);
    assert.equal(status.histories.find((h) => h.namespace === NS_A)!.proof, 'none', 'nothing to compare yet');
    const alternative = join(w.dir, 'alt.sqlite');
    const alt = await openSqliteStatusHighWaterMarkStore(alternative, { namespace: NS_A, create: true });
    w.records.set(NS_A, captureHistoryContinuity(alt, { namespace: NS_A, databasePath: alternative, generation: 2, recordedAt: w.clock.iso() }));
    alt.close();
    w.config = { generation: 2, histories: [{ namespace: NS_A, databasePath: alternative }, { namespace: NS_B, databasePath: w.paths[NS_B]! }] };
    assert.equal(classes(await probe(w))[NS_A], 'CONTINUOUS');
  });
});

// ── Inventory ────────────────────────────────────────────────────────────────

describe('FV-P4C-2B3A Host inventory — explicit readiness, monotonic generations, revalidated snapshots, per-namespace containment', () => {
  it('not loaded, missing configuration, duplicates, a bad, lowered or reused generation: no snapshot at all', async () => {
    const w = await world();
    const inventory = hostInventory(w);
    assert.equal(inventory.inventory(), undefined);
    assert.equal(inventory.status().readiness, 'not-loaded');
    const good = w.config!;
    for (const [config, readiness] of [
      [undefined, 'not-loaded'],
      [{ generation: 1, histories: [good.histories[0], good.histories[0]] }, 'configuration-invalid'],
      [{ generation: 1, histories: [good.histories[0], { namespace: NS_B, databasePath: good.histories[0]!.databasePath }] }, 'configuration-invalid'],
      [{ generation: -1, histories: good.histories }, 'configuration-invalid'],
      [{ generation: 1, histories: [] }, 'configuration-invalid'],
    ] as const) {
      w.config = config as never;
      assert.equal((await inventory.refresh()).readiness, readiness);
      assert.equal(inventory.inventory(), undefined);
    }
    w.config = { ...good, generation: 5 };
    assert.equal((await inventory.refresh()).readiness, 'ready');
    w.config = { generation: 5, histories: [good.histories[0]!] };
    assert.equal((await inventory.refresh()).readiness, 'configuration-invalid', 'review L2: one generation names one set');
    w.config = { ...good, generation: 4 };
    assert.equal((await inventory.refresh()).readiness, 'configuration-invalid', 'never lower');
    assert.equal(inventory.inventory(), undefined);
  });

  it('snapshots are revalidated on every read; a namespace with a pending intent or an altered record drops out under a new generation', async () => {
    const w = await world();
    const inventory = hostInventory(w);
    await inventory.refresh();
    const first = inventory.inventory()!;
    assert.deepEqual(inventory.inventory(), first, 'stable while nothing changes');
    pend(w, bootstrapRequest(NS_A));
    const during = inventory.inventory()!;
    assert.ok(during.generation > first.generation);
    assert.deepEqual(during.histories.map((h) => h.namespace), [NS_B]);
    w.intents.delete(NS_A);
    const record = w.records.get(NS_B) as HistoryContinuityRecord;
    w.records.set(NS_B, { ...record, createdRows: record.createdRows + 1 });
    assert.deepEqual(inventory.inventory()!.histories.map((h) => h.namespace), [NS_A]);
  });

  it('per-namespace containment through the real reconciler: a quarantined namespace stays unresolved while the other settles', async () => {
    const w = await world();
    const historyA = await writer(w, NS_A);
    const lone = await w.service.authorizeBootstrapAuthorityDecision(decide(w, 'requester-a', bindingOf(bootstrapRequest(NS_B)).binding, 'requester'));
    const pairA = await attempt(w, w.service, historyA, bootstrapRequest(NS_A), async () => undefined, false);
    historyA.close();
    rmHistory(w.paths[NS_A]!);
    const inventory = hostInventory(w);
    assert.equal((await inventory.refresh()).readiness, 'degraded');
    w.clock.advance(GRACE + 1);
    const entries = await boundary(w, inventory).reconcile();
    for (const c of [pairA.requester, pairA.approver]) assert.deepEqual(of(entries, c), [['unresolved', 'HISTORY_NOT_IN_INVENTORY']]);
    assert.deepEqual(of(entries, lone.commitment), [['settled', 'bootstrap-not-committed']]);
  });

  it('trackBootstrap refuses a namespace that is not admitted; an intent that cannot be recorded refuses the consumption', async () => {
    const w = await world();
    w.records.delete(NS_B);
    const inventory = hostInventory(w);
    await inventory.refresh();
    let ran = 0;
    const x = { requestId: 'req:x', bindingDigest: 'f'.repeat(64) };
    assert.deepEqual(await inventory.trackBootstrap(NS_B, x, async () => (ran += 1)), { outcome: 'refused', reason: 'HISTORY_NOT_ADMITTED' });
    const failing = createHostHistoryInventory({
      configuration: () => w.config,
      records: { load: (n) => w.records.get(n), save: () => undefined, pendingIntents: () => [], beginIntent: () => { throw new Error('disk full'); }, completeIntent: () => undefined },
      now: w.clock.iso,
    });
    closers.push(() => failing.close());
    await failing.refresh();
    await assert.rejects(failing.trackBootstrap(NS_A, x, async (_history, ensureIntent) => {
      ensureIntent();
      ran += 1;
    }), /disk full/);
    assert.equal(ran, 0, 'nothing consumed after a failed intent write');
  });
});

// ── In-flight (F3) ───────────────────────────────────────────────────────────

describe('FV-P4C-2B3A in-flight registry (F3) — an operation is never settled as failed while it runs', () => {
  it('registered before any decision is consumed; a source check or commit delayed past grace stays IN_FLIGHT; then it commits and settles committed', async () => {
    const w = await world();
    const inventory = hostInventory(w);
    await inventory.refresh();
    const b = boundary(w, inventory);
    const request = bootstrapRequest(NS_A);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let registeredFirst = false;
    let noIntentBeforeConsumption = false;
    let intentBeforeCommit = false;
    let duringGate: readonly BootstrapAuthorityReconciliationEntry[] = [];
    const running = b.runBootstrap(request, async (parsed, history) => {
      registeredFirst = b.inFlightOperations().length === 1;
      noIntentBeforeConsumption = w.intents.get(NS_A)?.has(parsed.requestId) !== true;
      assert.ok(Object.isFrozen(parsed));
      return attempt(w, b.bootstrapDecisions, history, parsed, async () => {
        intentBeforeCommit = w.intents.get(NS_A)?.has(parsed.requestId) === true;
        w.clock.advance(GRACE + 60); // the slow step outlives the grace bound
        duringGate = await b.reconcile();
        await gate;
      });
    });
    while (duringGate.length === 0) await new Promise((r) => setTimeout(r, 5));
    assert.equal(registeredFirst, true);
    assert.equal(noIntentBeforeConsumption, true, 're-review N4: nothing is written for a request that has not reached consumption');
    assert.equal(intentBeforeCommit, true, 'written by the gated authorize, before the decisions were consumed');
    assert.deepEqual(summary(duringGate), [['unresolved', 'IN_FLIGHT'], ['unresolved', 'IN_FLIGHT']]);
    assert.equal(outcomeRows(w).length, 0, 'never a false failure while it runs');
    release();
    assert.equal((await running).outcome, 'ran');
    assert.equal(b.inFlightOperations().length, 0);
    assert.deepEqual([...(w.intents.get(NS_A) ?? [])], []);
    assert.deepEqual(summary(await b.reconcile()), [['settled', 'bootstrap-committed'], ['settled', 'bootstrap-committed']]);
  });

  it('re-review N1: a decision cannot be consumed outside a registered bootstrap of its own binding', async () => {
    const w = await world();
    const inventory = hostInventory(w);
    await inventory.refresh();
    const b = boundary(w, inventory);
    const request = bootstrapRequest(NS_A);
    const { binding } = bindingOf(request);
    const response = decide(w, 'requester-a', binding, 'requester');
    await assert.rejects(b.bootstrapDecisions.authorizeBootstrapAuthorityDecision(response), /only inside a registered bootstrap/);
    // Inside a run of ANOTHER binding: still refused.
    const other = bootstrapRequest(NS_A);
    const ran = await b.runBootstrap(other, async () => b.bootstrapDecisions.authorizeBootstrapAuthorityDecision(response).then(() => 'consumed', (e: Error) => e.message));
    assert.match((ran as { value: string }).value, /only inside a registered bootstrap/);
    assert.deepEqual(w.service.unsettledBootstrapAuthorityDecisions(), [], 'nothing consumed');
    assert.deepEqual([...(w.intents.get(NS_A)?.values() ?? [])], [], 'and no intent left behind');
    // A run that fails before consumption, and one that consumes but never commits: both leave nothing pending.
    await b.runBootstrap(bootstrapRequest(NS_A), async () => 'refused early');
    const lost = bootstrapRequest(NS_A);
    await b.runBootstrap(lost, (parsed, history) => attempt(w, b.bootstrapDecisions, history, parsed, async () => undefined, false));
    assert.deepEqual([...(w.intents.get(NS_A)?.values() ?? [])], [], 're-review N4: settled in process without evidence completes the intent');
    assert.equal(classes(await inventory.refresh())[NS_A], 'CONTINUOUS');
  });

  it('re-review N2/N3: evidence under a pending request id but another binding is unexplained; refresh() never runs under a tracked bootstrap', async () => {
    const w = await world();
    const inventory = hostInventory(w);
    await inventory.refresh();
    // N3: a refresh during a tracked bootstrap changes nothing; the bootstrap completes and its intent is completed.
    const request = bootstrapRequest(NS_A);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const running = inventory.trackBootstrap(NS_A, intentOf(request), async (history, ensureIntent) => {
      ensureIntent();
      return attempt(w, w.service, history, request, () => gate);
    });
    await new Promise((r) => setTimeout(r, 20));
    const before = inventory.status();
    assert.deepEqual(await inventory.refresh(), before);
    release();
    assert.equal((await running).outcome, 'ran');
    assert.deepEqual([...(w.intents.get(NS_A)?.values() ?? [])], []);
    assert.equal(classes(await inventory.refresh())[NS_A], 'CONTINUOUS');
    // N2: an intent pending for request R explains only R's evidence for R's binding.
    const forged = bootstrapRequest(NS_A);
    w.intents.get(NS_A)!.set(forged.requestId, { requestId: forged.requestId, bindingDigest: 'f'.repeat(64) });
    inventory.close();
    const outside = await writer(w, NS_A);
    await attempt(w, w.service, outside, forged);
    outside.close();
    assert.equal(classes(await probe(w))[NS_A], 'UNEXPLAINED_EVIDENCE');
  });

  it('a caller that stops waiting (timeout) does not end the registration; an operation that never settles stays in flight; a restart starts empty', async () => {
    const w = await world();
    const registry = createBootstrapOperationRegistry({ now: w.clock.iso });
    const request = bootstrapRequest(NS_A);
    const { binding, digest } = bindingOf(request);
    const never = registry.run(request, () => new Promise<never>(() => undefined));
    const timedOut = await Promise.race([never.then(() => 'settled'), new Promise((r) => setTimeout(() => r('timeout'), 20))]);
    assert.equal(timedOut, 'timeout');
    assert.equal(registry.isInFlight(binding.namespace, digest), true);
    assert.deepEqual(registry.inFlightOperations().map((o) => o.requestId), [binding.requestId]);
    assert.equal(createBootstrapOperationRegistry({ now: w.clock.iso }).isInFlight(binding.namespace, digest), false);
  });

  it('a duplicate concurrent operation for the same binding or request id is refused before it starts; an invalid request never runs; a throwing operation releases; the operation gets the registered request', async () => {
    const w = await world();
    const registry = createBootstrapOperationRegistry({ now: w.clock.iso });
    const request = bootstrapRequest(NS_A);
    let release!: () => void;
    let handed: unknown;
    const first = registry.run(request, (parsed) => ((handed = parsed), new Promise<void>((r) => (release = r))));
    let ran = 0;
    assert.deepEqual(await registry.run(request, async () => (ran += 1)), { outcome: 'refused', reason: 'DUPLICATE' });
    assert.deepEqual(await registry.run({ ...request, sovereignAssetId: 'sa:other' }, async () => (ran += 1)), { outcome: 'refused', reason: 'DUPLICATE' }, 'same request id');
    assert.deepEqual(await registry.run({ ...request, requestId: 'req:garbage', namespace: '' }, async () => (ran += 1)), { outcome: 'refused', reason: 'REQUEST_INVALID' });
    assert.equal(ran, 0);
    assert.notEqual(handed, request);
    assert.equal(bootstrapBindingDigest(bootstrapBindingOf(handed as never)), bindingOf(request).digest);
    release();
    await first;
    await assert.rejects(registry.run(request, async () => {
      throw new Error('coordinator threw');
    }), /coordinator threw/);
    const { binding, digest } = bindingOf(request);
    assert.equal(registry.isInFlight(binding.namespace, digest), false, 'released when the operation settled, by throwing');
  });

  it('crash before the commit (one or both decisions consumed): quarantined until an operator decides; crash after the commit: resolved by evidence and settled committed', async () => {
    const w = await world();
    const inventory = hostInventory(w);
    await inventory.refresh();
    // NS_A: a crash after both decisions were consumed, before the commit. The intent stays pending.
    const lost = bootstrapRequest(NS_A);
    pend(w, lost);
    const both = await attempt(w, w.service, (await writer(w, NS_A)), lost, async () => undefined, false);
    // NS_B: a crash after the commit, before the record was re-captured.
    const done = bootstrapRequest(NS_B);
    pend(w, done);
    const committed = await attempt(w, w.service, (await writer(w, NS_B)), done);
    inventory.close();
    w.clock.advance(GRACE + 1);
    const restarted = hostInventory(w);
    const status = await restarted.refresh();
    assert.deepEqual(classes(status), { [NS_A]: 'INTENT_UNRESOLVED', [NS_B]: 'ADVANCED' });
    assert.deepEqual([...(w.intents.get(NS_B) ?? [])], [], 'resolved by its evidence');
    const entries = await boundary(w, restarted).reconcile();
    for (const c of [both.requester, both.approver]) assert.deepEqual(of(entries, c), [['unresolved', 'HISTORY_NOT_IN_INVENTORY']]);
    for (const c of [committed.requester, committed.approver]) assert.deepEqual(of(entries, c), [['settled', 'bootstrap-committed']]);
  });

  it('a decision that cannot be resolved to its signed target is treated as in flight, never as a negative', async () => {
    const w = await world();
    const registry = createBootstrapOperationRegistry({ now: w.clock.iso });
    for (const lookup of [() => undefined, () => ({ contract: { approvalRequestId: 'garbage' } }), () => { throw new Error('down'); }]) {
      assert.equal(registry.inFlightByCommitment(lookup)(`sha256:${'1'.repeat(64)}`), true);
    }
  });
});

// ── Restore quarantine ──────────────────────────────────────────────────────

describe('FV-P4C-2B3A restore candidates — never promoted automatically; only a candidate holding everything recorded is promotable', () => {
  it('older backup, corrupt, wrong namespace, another history, missing record or file, an extra unexplained commit; a current copy is promotable but never automatic', async () => {
    const w = await world();
    const inventory = hostInventory(w);
    await inventory.refresh();
    const older = join(w.dir, 'older.sqlite');
    backupOf(w.paths[NS_A]!, older);
    await tracked(w, inventory, bootstrapRequest(NS_A));
    const current = join(w.dir, 'current.sqlite');
    backupOf(w.paths[NS_A]!, current);
    const ahead = join(w.dir, 'ahead.sqlite');
    backupOf(w.paths[NS_A]!, ahead);
    const aheadStore = await openSqliteStatusHighWaterMarkStore(ahead, { namespace: NS_A });
    await attempt(w, w.service, aheadStore, bootstrapRequest(NS_A));
    aheadStore.close();
    const corrupt = join(w.dir, 'corrupt.sqlite');
    writeFileSync(corrupt, 'garbage');
    const otherHistory = join(w.dir, 'other.sqlite');
    const other = await openSqliteStatusHighWaterMarkStore(otherHistory, { namespace: NS_A, create: true });
    await attempt(w, w.service, other, bootstrapRequest(NS_A));
    other.close();
    const record = w.records.get(NS_A);
    const cases: Array<readonly [string, unknown, string, string]> = [
      ['ROLLED_BACK', record, NS_A, older],
      ['CORRUPT', record, NS_A, corrupt],
      ['NAMESPACE_MISMATCH', record, NS_B, w.paths[NS_B]!],
      ['DIVERGED', record, NS_A, otherHistory],
      ['UNEXPLAINED_EVIDENCE', record, NS_A, ahead],
      ['UNREGISTERED', undefined, NS_A, current],
      ['MISSING', record, NS_A, join(w.dir, 'never-staged.sqlite')],
      ['RECORD_INVALID', { ...(record as object), generation: 99 }, NS_A, current],
      ['CONTINUOUS', record, NS_A, current],
    ];
    for (const [cls, rec, namespace, stagedPath] of cases) {
      const verdict = await assessRestoreCandidate(rec, { namespace, stagedPath });
      assert.equal(verdict.class, cls, stagedPath);
      assert.equal(verdict.promotable, cls === 'CONTINUOUS');
      assert.equal(verdict.automatic, false);
    }
    assert.equal((await assessRestoreCandidate(record, { namespace: NS_A, stagedPath: current })).proof, 'content');
    assert.equal(statSync(older).size > 0, true);
  });

  it('quarantine bypass: restoring the older copy over the configured path is quarantined on every refresh; only the right file clears it', async () => {
    const w = await world();
    const inventory = hostInventory(w);
    await inventory.refresh();
    const older = join(w.dir, 'older.sqlite');
    backupOf(w.paths[NS_A]!, older);
    await tracked(w, inventory, bootstrapRequest(NS_A));
    const current = join(w.dir, 'current.sqlite');
    backupOf(w.paths[NS_A]!, current);
    inventory.close();
    rmHistory(w.paths[NS_A]!);
    backupOf(older, w.paths[NS_A]!);
    const quarantined = hostInventory(w);
    assert.equal(classes(await quarantined.refresh())[NS_A], 'ROLLED_BACK');
    assert.equal(classes(await quarantined.refresh())[NS_A], 'ROLLED_BACK', 'a second refresh does not clear it');
    quarantined.close();
    rmHistory(w.paths[NS_A]!);
    backupOf(current, w.paths[NS_A]!);
    assert.equal(classes(await probe(w))[NS_A], 'CONTINUOUS');
  });
});

// ── R3: independent-review regressions ──────────────────────────────────────

const targetOf = (record: unknown): string => String((record as { contract: { approvalRequestId: string } }).contract.approvalRequestId);
const unsettledTargets = (w: World) => w.service.unsettledBootstrapAuthorityDecisions().map(targetOf);

describe('FV-P4C-2B3A-R3 independent review — gate snapshot (F1), refresh exclusion (F2), crash after re-capture (F3)', () => {
  it('F1: a response whose getter or proxy changes between reads cannot show the gate one decision and consume another', async () => {
    const w = await world();
    const inventory = hostInventory(w);
    await inventory.refresh();
    const b = boundary(w, inventory);
    const running = bootstrapRequest(NS_A);
    const victim = bootstrapRequest(NS_A);
    const respA = decide(w, 'requester-a', bindingOf(running).binding, 'requester') as Record<string, unknown>;
    const respB = decide(w, 'requester-a', bindingOf(victim).binding, 'requester') as Record<string, unknown>;
    const switching = (first: Record<string, unknown>, then: Record<string, unknown>) => {
      let reads = 0;
      const { response: _ignored, ...rest } = first;
      return Object.defineProperty({ ...rest }, 'response', { enumerable: true, get: () => (reads++ === 0 ? first['response'] : then['response']) });
    };
    const proxied = (first: Record<string, unknown>, then: Record<string, unknown>) => {
      let reads = 0;
      return new Proxy(first, { get: (target, key) => (key === 'response' ? (reads++ === 0 ? first['response'] : then['response']) : Reflect.get(target, key)) });
    };
    for (const make of [switching, proxied]) {
      // Shows B first: refused, whatever it would show next.
      const shownB = await b.runBootstrap(running, async () => b.bootstrapDecisions.authorizeBootstrapAuthorityDecision(make(respB, respA)).then(() => 'consumed', (e: Error) => e.message));
      assert.match((shownB as { value: string }).value, /only inside a registered bootstrap/);
      assert.deepEqual(unsettledTargets(w), [], 'nothing consumed');
    }
    // Shows A first (the running binding), then B: exactly A is consumed, never B.
    const shownA = await b.runBootstrap(running, async () => targetOf(await b.bootstrapDecisions.authorizeBootstrapAuthorityDecision(proxied(respA, respB))));
    assert.ok((shownA as { value: string }).value.endsWith(bindingOf(running).digest));
    assert.deepEqual(unsettledTargets(w).map((t) => t.endsWith(bindingOf(running).digest)), [true], 'only the running binding’s decision was consumed');
    assert.equal(unsettledTargets(w).some((t) => t.endsWith(bindingOf(victim).digest)), false);
    // A response that is not plain JSON is refused before anything is consumed.
    const ran = await b.runBootstrap(bootstrapRequest(NS_A), async () => b.bootstrapDecisions.authorizeBootstrapAuthorityDecision({ ...respA, extra: 1n }).then(() => 'consumed', (e: Error) => e.message));
    assert.match((ran as { value: string }).value, /plain WebAuthn JSON/);
    assert.equal(unsettledTargets(w).length, 1);
  });

  it('N1 recheck: wrong namespace, a callback kept after release, an operation that throws, and a replayed decision', async () => {
    const w = await world();
    const inventory = hostInventory(w);
    await inventory.refresh();
    const b = boundary(w, inventory);
    const gated = /only inside a registered bootstrap/;
    const authorizeLater = (response: unknown) => b.bootstrapDecisions.authorizeBootstrapAuthorityDecision(response).then(() => 'consumed', (e: Error) => e.message);
    // A decision for NS_B's binding, inside a run of NS_A: refused.
    const forB = decide(w, 'requester-a', bindingOf(bootstrapRequest(NS_B)).binding, 'requester');
    const inA = await b.runBootstrap(bootstrapRequest(NS_A), async () => authorizeLater(forB));
    assert.match((inA as { value: string }).value, gated);
    // The run's own decision, consumed through a callback kept after the run settled: refused.
    const request = bootstrapRequest(NS_A);
    const own = decide(w, 'requester-a', bindingOf(request).binding, 'requester');
    let kept!: () => Promise<string>;
    await b.runBootstrap(request, async () => void (kept = () => authorizeLater(own)));
    assert.match(await kept(), gated);
    // An operation that throws releases its registration: the decision is refused afterwards.
    const throwing = bootstrapRequest(NS_A);
    const its = decide(w, 'requester-a', bindingOf(throwing).binding, 'requester');
    await assert.rejects(b.runBootstrap(throwing, async () => { throw new Error('coordinator failed'); }), /coordinator failed/);
    assert.match(await authorizeLater(its), gated);
    assert.deepEqual(unsettledTargets(w), [], 'nothing consumed so far');
    // Replay: the same decision consumed twice inside its own run — AUTH-03 consumes it once.
    const replayed = bootstrapRequest(NS_A);
    const once = decide(w, 'requester-a', bindingOf(replayed).binding, 'requester');
    const twice = await b.runBootstrap(replayed, async () => [await authorizeLater(once), await authorizeLater(once)]);
    assert.equal((twice as { value: string[] }).value[0], 'consumed');
    assert.notEqual((twice as { value: string[] }).value[1], 'consumed');
    assert.equal(unsettledTargets(w).length, 1);
  });

  it('F2: a bootstrap is refused while a refresh is in progress, a refresh is a no-op during a bootstrap’s post-settle work, and a close during refresh is final', async () => {
    const w = await world();
    let duringSave: Promise<unknown> | undefined;
    let inventory!: ReturnType<typeof hostInventory>;
    inventory = hostInventory(w, { onSave: () => void (duringSave ??= inventory.refresh()) });
    await inventory.refresh();
    const b = boundary(w, inventory);
    // Refresh first: it is awaiting its opens when the bootstrap arrives.
    const refreshing = inventory.refresh();
    const request = bootstrapRequest(NS_A);
    const refused = await b.runBootstrap(request, (parsed, history) => attempt(w, b.bootstrapDecisions, history, parsed));
    assert.deepEqual(refused, { outcome: 'refused', reason: 'INVENTORY_REFRESHING' });
    assert.equal((await refreshing).readiness, 'ready');
    assert.deepEqual(unsettledTargets(w), [], 'nothing consumed');
    assert.deepEqual([...(w.intents.get(NS_A)?.values() ?? [])], []);
    // Bootstrap first: a refresh started inside its post-settle re-capture (the record save) changes nothing.
    const before = inventory.status();
    const ran = await b.runBootstrap(bootstrapRequest(NS_A), (parsed, history) => attempt(w, b.bootstrapDecisions, history, parsed));
    assert.equal(ran.outcome, 'ran');
    assert.ok(duringSave !== undefined, 'the hook ran inside the post-settle re-capture');
    assert.deepEqual(await duringSave, before, 'refresh was a no-op while the bootstrap was still settling');
    assert.deepEqual([...(w.intents.get(NS_A)?.values() ?? [])], []);
    assert.equal(classes(await inventory.refresh())[NS_A], 'CONTINUOUS');
    // Two refreshes at once: the second is a no-op that reports the state before the first completes.
    const fresh = hostInventory(w);
    const [first, second] = await Promise.all([fresh.refresh(), fresh.refresh()]);
    assert.equal(first.readiness, 'ready');
    assert.equal(second.readiness, 'not-loaded', 'a refresh never runs inside another');
    fresh.close();
    // Closed while a refresh awaits: the inventory stays closed and keeps no handle.
    const late = inventory.refresh();
    inventory.close();
    assert.equal((await late).readiness, 'closed');
    assert.equal(inventory.inventory(), undefined);
  });

  it('H1 crash matrix through the real boundary: at every crash point the restart either settles by evidence or quarantines; never a confident negative', async () => {
    // A crash is a run that never settles (its finally never runs), then a new inventory and boundary over the same
    // durable state: the record, the intents, the history file and AUTH-03's store.
    const never = new Promise<never>(() => undefined);
    type Point = 'intent-only' | 'first-consumed' | 'both-consumed' | 'committed' | 'committed-then-replaced' | 'committed-then-rolled-back';
    const crashAt = async (point: Point) => {
      const w = await world();
      const inventory = hostInventory(w);
      await inventory.refresh();
      const b = boundary(w, inventory);
      const request = bootstrapRequest(NS_A);
      const preCommit = join(w.dir, 'pre-commit.sqlite');
      backupOf(w.paths[NS_A]!, preCommit);
      const consumed: string[] = [];
      let reached!: () => void;
      const crashed = new Promise<void>((r) => (reached = r));
      if (point === 'intent-only') {
        void inventory.trackBootstrap(NS_A, intentOf(request), async (_history, ensureIntent) => {
          ensureIntent();
          reached();
          return never;
        });
      } else {
        void b.runBootstrap(request, async (parsed, history) => {
          if (point === 'first-consumed') {
            consumed.push((await b.bootstrapDecisions.authorizeBootstrapAuthorityDecision(decide(w, 'requester-a', bindingOf(parsed).binding, 'requester'))).commitment);
          } else {
            // both consumed; then either a source check that never returns (step 4) or a commit that is never followed up
            const commit = point !== 'both-consumed';
            const pair = await attempt(w, b.bootstrapDecisions, history, parsed, async () => (commit ? undefined : (reached(), never)), commit);
            consumed.push(pair.requester, pair.approver);
          }
          reached();
          return never;
        });
      }
      await crashed;
      if (point === 'both-consumed') consumed.push(...w.service.unsettledBootstrapAuthorityDecisions().map((d) => (d as { commitment: string }).commitment));
      assert.deepEqual([...(w.intents.get(NS_A)?.keys() ?? [])], [request.requestId], `${point}: the intent was durable before any consumption`);
      if (point === 'committed-then-replaced' || point === 'committed-then-rolled-back') {
        rmHistory(w.paths[NS_A]!);
        if (point === 'committed-then-replaced') {
          const other = await openSqliteStatusHighWaterMarkStore(join(w.dir, 'other.sqlite'), { namespace: NS_A, create: true });
          other.close();
          backupOf(join(w.dir, 'other.sqlite'), w.paths[NS_A]!);
        } else backupOf(preCommit, w.paths[NS_A]!);
      }
      w.clock.advance(GRACE + 1);
      const restarted = hostInventory(w);
      const status = await restarted.refresh();
      const entries = await boundary(w, restarted).reconcile();
      return { cls: classes(status)[NS_A], outcomes: [...new Set(consumed)].map((c) => of(entries, c)), pending: [...(w.intents.get(NS_A)?.keys() ?? [])], requestId: request.requestId };
    };
    const quarantined = [['unresolved', 'HISTORY_NOT_IN_INVENTORY']];
    const intentOnly = await crashAt('intent-only');
    assert.deepEqual(intentOnly, { cls: 'INTENT_UNRESOLVED', outcomes: [], pending: [intentOnly.requestId], requestId: intentOnly.requestId });
    for (const point of ['first-consumed', 'both-consumed', 'committed-then-replaced', 'committed-then-rolled-back'] as const) {
      const r = await crashAt(point);
      assert.equal(r.cls, 'INTENT_UNRESOLVED', point);
      assert.ok(r.outcomes.length >= 1 && r.outcomes.every((o) => JSON.stringify(o) === JSON.stringify(quarantined)), `${point}: ${JSON.stringify(r.outcomes)}`);
      assert.deepEqual(r.pending, [r.requestId], `${point}: the intent stays pending for an operator`);
    }
    const committed = await crashAt('committed');
    assert.equal(committed.cls, 'ADVANCED');
    assert.deepEqual(committed.outcomes, [[['settled', 'bootstrap-committed']], [['settled', 'bootstrap-committed']]]);
    assert.deepEqual(committed.pending, [], 'resolved by its evidence');
    // Checkpoint re-captured but the intent not completed: the F3 test below.
  });

  it('LIMITATION (FV-P4D): the history, its record and the intent journal restored together to before a commit are indistinguishable from no commit', async () => {
    const w = await world();
    const inventory = hostInventory(w);
    await inventory.refresh();
    const b = boundary(w, inventory);
    const preCommit = join(w.dir, 'pre-commit.sqlite');
    backupOf(w.paths[NS_A]!, preCommit);
    const recordBefore = w.records.get(NS_A);
    const ran = await b.runBootstrap(bootstrapRequest(NS_A), (parsed, history) => attempt(w, b.bootstrapDecisions, history, parsed));
    const pair = (ran as { value: Awaited<ReturnType<typeof attempt>> }).value;
    inventory.close();
    // Everything on the FV side goes back together; AUTH-03's store keeps the consumed decisions.
    rmHistory(w.paths[NS_A]!);
    backupOf(preCommit, w.paths[NS_A]!);
    w.records.set(NS_A, recordBefore);
    w.intents.clear();
    w.clock.advance(GRACE + 1);
    const restarted = hostInventory(w);
    assert.equal(classes(await restarted.refresh())[NS_A], 'CONTINUOUS');
    const entries = await boundary(w, restarted).reconcile();
    for (const c of [pair.requester, pair.approver]) assert.deepEqual(of(entries, c), [['settled', 'bootstrap-not-committed']], 'undetectable without an independent witness (FV-P4D)');
  });

  it('F3: a crash after the record is re-captured, before the intent is completed, resolves by evidence at restart (no permanent quarantine, no false negative)', async () => {
    const w = await world();
    let fail = true;
    const inventory = hostInventory(w, {
      onComplete: () => {
        if (fail) throw new Error('crash before completeIntent');
      },
    });
    await inventory.refresh();
    const b = boundary(w, inventory);
    const request = bootstrapRequest(NS_A);
    const ran = await b.runBootstrap(request, (parsed, history) => attempt(w, b.bootstrapDecisions, history, parsed));
    assert.equal(ran.outcome, 'ran');
    const record = readHistoryContinuityRecord(w.records.get(NS_A))!;
    assert.deepEqual(record.evidence.map((e) => e[0]), [request.requestId], 'the record already holds the evidence');
    assert.deepEqual([...(w.intents.get(NS_A)?.keys() ?? [])], [request.requestId], 'and the intent is still pending');
    inventory.close();
    fail = false;
    const restarted = hostInventory(w);
    const status = await restarted.refresh();
    const a = status.histories.find((h) => h.namespace === NS_A)!;
    assert.equal(a.class, 'CONTINUOUS');
    assert.deepEqual(a.committedIntents, [request.requestId]);
    assert.deepEqual([...(w.intents.get(NS_A)?.values() ?? [])], []);
    restarted.close();
    // Resolved by the exact (request id, binding): the same request id under another binding resolves nothing.
    w.intents.set(NS_A, new Map([[request.requestId, { requestId: request.requestId, bindingDigest: 'f'.repeat(64) }]]));
    const again = hostInventory(w);
    assert.equal(classes(await again.refresh())[NS_A], 'INTENT_UNRESOLVED');
    again.close();
  });
});

// ── R3 N6: substitution at the path while the store opens it ────────────────

/**
 * Deterministic, with no production seam: the store's identity samples are its own `fs.statSync` calls on
 * the configured file (sample 1 before the connection opens, sample 2 after validation). The test wraps
 * the real `fs.statSync` and substitutes the file at an exact sample, so the window is hit every run.
 */
const realFs = createRequire(join(process.cwd(), 'package.json'))('node:fs') as { statSync: unknown };
async function openAcrossSubstitution(target: string, namespace: string, at: { readonly afterSample1?: () => void; readonly beforeSample2?: () => void }) {
  const original = realFs.statSync;
  let samples = 0;
  const hooked = function (this: unknown, path: unknown, options?: unknown) {
    const mine = typeof path === 'string' && resolve(path) === resolve(target);
    if (mine && samples === 1) at.beforeSample2?.();
    const result = (original as (...args: unknown[]) => unknown).call(realFs, path, options);
    if (mine) {
      samples += 1;
      if (samples === 1) at.afterSample1?.();
    }
    return result;
  };
  realFs.statSync = hooked;
  syncBuiltinESMExports();
  try {
    const opened = await openSqliteStatusHighWaterMarkStore(target, { namespace }).then(
      (store) => ({ store }),
      (error: unknown) => ({ error }),
    );
    return { ...opened, samples };
  } finally {
    realFs.statSync = original;
    syncBuiltinESMExports();
  }
}

describe('FV-P4C-2B3A-R3 N6 — a history file substituted at the configured path while the store opens it', () => {
  it('substituted between the pre-open sample and the connection: the open is refused (both samples observed)', async () => {
    const w = await world();
    const inventory = hostInventory(w);
    await inventory.refresh();
    const older = join(w.dir, 'older.sqlite');
    backupOf(w.paths[NS_A]!, older);
    await tracked(w, inventory, bootstrapRequest(NS_A));
    inventory.close();
    const P = w.paths[NS_A]!;
    assert.equal(existsSync(`${P}-wal`), false, 'no handle is open on the history');
    const aside = join(w.dir, 'aside.sqlite');
    const result = await openAcrossSubstitution(P, NS_A, {
      afterSample1: () => {
        renameSync(P, aside);
        renameSync(older, P);
      },
    });
    assert.equal(result.samples, 2, 'the hook observed both identity samples: the window was exercised');
    assert.ok('error' in result && /changed while it was being opened/.test(String((result.error as Error).message)), 'the substituted open is refused');
    // The substitute is itself a valid history of the namespace: the refusal is the identity check, not invalidity.
    const plain = await openSqliteStatusHighWaterMarkStore(P, { namespace: NS_A, readOnly: true });
    plain.close();
    // And the independent content layer quarantines it as an older copy.
    assert.equal(classes(await probe(w))[NS_A], 'ROLLED_BACK');
  });

  it('LIMITATION (ABA): substituted after the pre-open sample and put back before the post-validation sample, the open is accepted; an older substitute is still ROLLED_BACK; an identical one writes through the by-name WAL sidecar', async () => {
    const w = await world();
    const inventory = hostInventory(w);
    await inventory.refresh();
    const request = bootstrapRequest(NS_A);
    await tracked(w, inventory, request);
    inventory.close();
    const P = w.paths[NS_A]!;
    const record = w.records.get(NS_A);
    const aside = join(w.dir, 'aside.sqlite');
    const heldOpen = join(w.dir, 'held-open.sqlite');
    const substitute = (copy: string) => ({
      afterSample1: () => {
        renameSync(P, aside);
        renameSync(copy, P);
      },
      beforeSample2: () => {
        renameSync(P, heldOpen);
        renameSync(aside, P);
      },
    });

    // 1. An older substitute: the path-sampled identity cannot see it; the content comparison on that very handle does.
    const older = join(w.dir, 'older.sqlite');
    const blank = await openSqliteStatusHighWaterMarkStore(join(w.dir, 'blank.sqlite'), { namespace: NS_A, create: true });
    blank.close();
    backupOf(join(w.dir, 'blank.sqlite'), older);
    const first = await openAcrossSubstitution(P, NS_A, substitute(older));
    assert.equal(first.samples, 2);
    assert.ok('store' in first, 'residual: an ABA substitution inside the open window is not detected by the identity samples');
    const handle1 = first.store as SqliteStatusHighWaterMarkStore;
    assert.equal(assessHistoryContinuity(record, { namespace: NS_A, databasePath: P, store: handle1 }, []).class, 'ROLLED_BACK');
    handle1.close();
    rmSync(heldOpen, { force: true });

    // 2. An identical substitute is admitted. SQLite opens the WAL sidecar by path name, so after the put-back its
    //    writes go to `${P}-wal`, which the original at the path then replays: the sidecars are part of the file-writer
    //    trust root (N2), not covered by the main file's device and inode. Pinned as observed with this SQLite.
    const identical = join(w.dir, 'identical.sqlite');
    backupOf(P, identical);
    const second = await openAcrossSubstitution(P, NS_A, substitute(identical));
    assert.ok('store' in second);
    const handle2 = second.store as SqliteStatusHighWaterMarkStore;
    assert.equal(assessHistoryContinuity(record, { namespace: NS_A, databasePath: P, store: handle2 }, []).class, 'CONTINUOUS');
    await gateAdvance(handle2, request);
    handle2.close();
    const reopened = await openSqliteStatusHighWaterMarkStore(P, { namespace: NS_A, readOnly: true });
    const mark = await reopened.read({ sovereignAssetId: request.sovereignAssetId, issuer: request.issuer });
    reopened.close();
    assert.equal(mark?.mark.sequence, 2, 'observed: the advance reached the configured path through its by-name WAL sidecar');
    // The path's file passes the store's integrity check and holds the recorded content plus that advance: ADVANCED, no evidence invented.
    assert.equal(classes(await probe(w))[NS_A], 'ADVANCED');
  });
});

// ── Structure ────────────────────────────────────────────────────────────────

const ROOT = join(process.cwd());
const SRC = join(ROOT, 'src', 'enterprise');
const walkFiles = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
  const path = join(dir, name);
  return statSync(path).isDirectory() ? walkFiles(path) : path.endsWith('.ts') ? [path] : [];
});

describe('FV-P4C-2B3A structure — foundations only: nothing composes or reaches them', () => {
  it('no Host source names the boundary, the registry, the inventory or the continuity record; the checkpoint stays internal', () => {
    const NAMES = /createFvBootstrapAuthorityBoundary|createBootstrapOperationRegistry|createHostHistoryInventory|captureHistoryContinuity|assessRestoreCandidate|openRecordedHistory|storeCheckpointOf/;
    const MODULE = join(SRC, 'sovereign-status-history');
    const callers = walkFiles(join(ROOT, 'src'))
      .filter((file) => !file.startsWith(MODULE) && !file.includes('__tests__'))
      .filter((file) => NAMES.test(readFileSync(file, 'utf8')))
      .map((file) => relative(ROOT, file));
    assert.deepEqual(callers, []);
    // Review L6: scripts and the Host launcher too (any extension), and no deep import of the module from them.
    const scriptFiles = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      return name === 'node_modules' ? [] : statSync(path).isDirectory() ? scriptFiles(path) : /\.(m?js|ts)$/.test(name) ? [path] : [];
    });
    const scriptCallers = scriptFiles(join(ROOT, 'scripts')).filter((file) => NAMES.test(readFileSync(file, 'utf8')) || /sovereign-status-history/.test(readFileSync(file, 'utf8'))).map((file) => relative(ROOT, file));
    assert.deepEqual(scriptCallers, []);
    assert.equal(/isBootstrapSettlementCapabilityOf|createHumanIdentityServiceWithBootstrapSettlement/.test(readFileSync(join(SRC, 'composition', 'human-authority-composition.ts'), 'utf8')), false, 'AUTH-04A does not issue the capability yet (B3B)');
    assert.equal('storeCheckpointOf' in fvIndex, false);
    assert.equal('trustedBootstrapEvidenceSource' in fvIndex, false);
    const MODULE_DIR = join(SRC, 'sovereign-status-history');
    for (const script of walkFiles(join(ROOT, 'src')).filter((f) => !f.includes('__tests__') && !f.startsWith(MODULE_DIR) && (f.includes('composition') || f.includes(`${join('enterprise', 'host')}`)))) {
      assert.equal(/sovereign-status-history/.test(readFileSync(script, 'utf8')), false, relative(ROOT, script));
    }
  });

  it('R3 N5: whoever composes the boundary passes AUTH-03’s own predicate, imported from the identity module; the boundary has no default and accepts no capability later', () => {
    // Vacuous until B3B composes it; then every non-test caller must satisfy it.
    const MODULE = join(SRC, 'sovereign-status-history');
    for (const file of walkFiles(join(ROOT, 'src')).filter((f) => !f.startsWith(MODULE) && !f.includes('__tests__'))) {
      const text = readFileSync(file, 'utf8');
      if (!/createFvBootstrapAuthorityBoundary\s*\(/.test(text)) continue;
      assert.match(text, /custody:\s*isBootstrapSettlementCapabilityOf\b/, `${relative(ROOT, file)} passes AUTH-03's predicate`);
      assert.match(text, /import\s*\{[^}]*\bisBootstrapSettlementCapabilityOf\b[^}]*\}\s*from\s*'[^']*human-identity\/(index|service)\.js'/, `${relative(ROOT, file)} imports it from AUTH-03`);
    }
    const boundarySource = readFileSync(join(MODULE, 'authority-boundary.ts'), 'utf8');
    assert.equal(/custody\s*\?\?|custody\s*=\s*\(/.test(boundarySource), false, 'no default custody check');
    assert.equal(/human-identity/.test(boundarySource), false, 'the FV module does not import AUTH-03 (the predicate is passed in)');
    // The predicate itself: exact and live, over AUTH-03's module-private instances.
    const service = readFileSync(join(SRC, 'human-identity', 'service.ts'), 'utf8');
    assert.match(service, /const SERVICE_INSTANCES = new WeakMap<object, object>\(\);/);
    assert.match(service, /return held !== undefined && !held\.revoked && instance !== undefined && held\.instance === instance;/);
  });
});
