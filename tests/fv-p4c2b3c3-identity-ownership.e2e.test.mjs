// FV-P4C-2B3C-3 — one owner of each AUTH-03 identity store, and a settlement fenced inside the owner's own
// write. The dedicated FV executor's composition opens and exclusively holds its OWN bootstrap identity store
// (pinned by store id); AUTH-04A's Host store is another file with AUTH-04A as its only owner. Real SQLite,
// real child processes, a real CORE-07 witness; synthetic identities and temporary databases only.
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdtempSync, renameSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { confirmExclusivelyHeld } from '../dist/src/enterprise/sovereign-status-history/executor-exclusivity.js';
import { createHumanIdentityService, identityAdministratorFor, openSqliteHumanIdentityStore } from '../dist/src/enterprise/human-identity/index.js';
import { testSigner, testVerifier, AUTHORITY_KEY_A } from '../dist/src/enterprise/__tests__/authority-authenticity-fixture.js';
import { boundaryFor, closeAllWitnesses, startWitness, witnessRows } from '../dist/src/enterprise/__tests__/core07-freshness-fixture.js';
import { FV_DOMAIN, GRACE, NS_A, ORG, OPERATORS, RP, S, T, addSeconds, compose, decisionsFor, identityConfigOf, makeClock, openIdentity, prepareWorld, requestFor } from './fv-p4c2b3b-support.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHILD = fileURLToPath(new URL('./fv-p4c2b3b-child.mjs', import.meta.url));
const LATER = addSeconds(T, 10);

const cleanup = [];
const pids = new Set();
after(async () => {
  for (const step of cleanup.splice(0).reverse()) {
    try {
      await step();
    } catch {
      // already closed
    }
  }
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // already gone
    }
  }
  await closeAllWitnesses();
});

async function world() {
  const w = await prepareWorld({ dir: mkdtempSync(join(tmpdir(), 'fv-p4c2b3c3-')) });
  cleanup.push(() => rmSync(w.dir, { recursive: true, force: true }));
  return w;
}

/** CORE-07-FV-WITNESS: a world whose FV identity store is anchored at `witness` in its own domain (test-only genesis). */
async function anchoredWorld(witness) {
  // The directory is cleaned up even when the world cannot be prepared.
  const dir = mkdtempSync(join(tmpdir(), 'fv-p4c2b3c3-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return prepareWorld({ dir, boundary: await boundaryFor(witness, ORG) });
}

async function start(w, at = LATER, overrides = {}) {
  const clock = makeClock(at);
  const host = await compose(w, clock, overrides);
  cleanup.push(() => host.close());
  return { host, clock };
}

/** Another process trying an ordinary (AUTH-04A-style, non-exclusive) open of `path`: its exit code. */
function openFromAnotherProcess(path) {
  const script = `
    const { openSqliteHumanIdentityStore } = require(${JSON.stringify(join(ROOT, 'dist/src/enterprise/human-identity/index.js'))});
    const { testSigner, testVerifier } = require(${JSON.stringify(join(ROOT, 'dist/src/enterprise/__tests__/authority-authenticity-fixture.js'))});
    const key = JSON.parse(require('node:fs').readFileSync(${JSON.stringify(join(dirname(path), 'synthetic-test-authority-key.json'))}, 'utf8'));
    openSqliteHumanIdentityStore(${JSON.stringify(path)}, { organizationId: ${JSON.stringify(ORG)}, now: () => new Date().toISOString(), busyTimeoutMs: 200, authenticity: { signer: testSigner(key), verifier: testVerifier([key]) } })
      .then((s) => { s.head(); s.close(); process.exit(0); }, () => process.exit(3));`;
  return spawnSync(process.execPath, ['-e', script], { timeout: 30_000 }).status;
}

function spawnChild(job) {
  const child = spawn(process.execPath, [CHILD, JSON.stringify(job)], { stdio: ['pipe', 'pipe', 'inherit'] });
  pids.add(child.pid);
  cleanup.push(() => child.kill('SIGKILL'));
  const lines = [];
  let buffer = '';
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    for (const line of buffer.split('\n').slice(0, -1)) lines.push(JSON.parse(line));
    buffer = buffer.slice(buffer.lastIndexOf('\n') + 1);
  });
  const exited = new Promise((done) => child.on('exit', (code, signal) => done({ code, signal })));
  const next = async (predicate) => {
    for (let i = 0; i < 2400; i += 1) {
      const found = lines.find(predicate);
      if (found !== undefined) return found;
      await new Promise((done) => setTimeout(done, 25));
    }
    throw new Error('no such line from the child');
  };
  return { child, exited, next, lines };
}

/** Both humans' decisions for one request, through a composition in this process, then closed. */
async function signedJob(w, request = requestFor(NS_A)) {
  const { host } = await start(w, T);
  const decisions = decisionsFor(host, w.devices, request);
  host.close();
  return { request, signedStatusText: S.active1.text, ...decisions };
}

const kinds = async (w, kind) => {
  const store = await openIdentity(w.dir, makeClock(LATER));
  try {
    return store.history().filter((row) => row.kind === kind).length;
  } finally {
    store.close();
  }
};
const summary = (entries) => entries.map((e) => [e.result, 'reason' in e ? e.reason : e.settlement.outcome]);

// ── Single owner ────────────────────────────────────────────────────────────

describe('FV-P4C-2B3C-3 single owner — the executor opens and exclusively holds its own bootstrap identity store', () => {
  it('held exclusively while composed: no other connection, in this process or another, can open it; released at close', async () => {
    const w = await world();
    const { host } = await start(w);
    assert.equal(confirmExclusivelyHeld([w.paths.identity]), true);
    await assert.rejects(openSqliteHumanIdentityStore(w.paths.identity, { organizationId: ORG, now: () => LATER, busyTimeoutMs: 200, authenticity: { signer: testSigner(AUTHORITY_KEY_A), verifier: testVerifier([AUTHORITY_KEY_A]) } }), 'no second connection in this process');
    assert.notEqual(openFromAnotherProcess(w.paths.identity), 0, 'no second owner in another process');
    host.close();
    assert.equal(openFromAnotherProcess(w.paths.identity), 0, 'the guarded close released it');
  });

  it('an already opened store is never accepted: the executor opens its own', async () => {
    const w = await world();
    const handed = await openIdentity(w.dir, makeClock(LATER));
    cleanup.push(() => handed.close());
    await assert.rejects(compose(w, makeClock(LATER), { identity: { ...identityConfigOf(w.dir), store: handed } }), (e) => e.code === 'OPTIONS_INVALID');
  });

  it('the store is pinned by id: another store at the path (AUTH-04A’s, a copy, a replacement), even signed by the same key, is refused', async () => {
    const w = await world();
    const otherPath = join(w.dir, 'host-identity.sqlite');
    const other = await openSqliteHumanIdentityStore(otherPath, { organizationId: ORG, now: () => LATER, authenticity: { signer: testSigner(AUTHORITY_KEY_A), verifier: testVerifier([AUTHORITY_KEY_A]) }, create: true });
    other.close();
    await assert.rejects(compose(w, makeClock(LATER), { identity: identityConfigOf(w.dir, { storePath: otherPath }) }), (e) => e.code === 'IDENTITY_REFUSED', 'another store under the pinned id');
    // The same store substituted at the executor's own path.
    renameSync(otherPath, w.paths.identity);
    await assert.rejects(compose(w, makeClock(LATER)), (e) => e.code === 'IDENTITY_REFUSED', 'a replacement at the path');
    assert.equal(openFromAnotherProcess(w.paths.identity), 0, 'a refused start holds nothing');
  });

  it('the identity store is its own protected file: policy, links and aliasing are refused before anything is opened', async () => {
    const w = await world();
    for (const storePath of [w.paths.protectedStore, w.paths.history(NS_A)]) {
      await assert.rejects(compose(w, makeClock(LATER), { identity: identityConfigOf(w.dir, { storePath }) }), (e) => e.code === 'OPTIONS_INVALID', storePath);
    }
    const link = join(w.dir, 'identity-link.sqlite');
    symlinkSync(w.paths.identity, link);
    await assert.rejects(compose(w, makeClock(LATER), { identity: identityConfigOf(w.dir, { storePath: link }) }), (e) => e.code === 'PATH_REFUSED');
    chmodSync(w.paths.identity, 0o666);
    await assert.rejects(compose(w, makeClock(LATER)), (e) => e.code === 'PATH_REFUSED');
    chmodSync(w.paths.identity, 0o600);
    (await start(w)).host.close();
  });

  it('AUTH-04A’s own store is another file with its own owner: both work at once, independently', async () => {
    const w = await world();
    const { host } = await start(w);
    const hostDir = mkdtempSync(join(tmpdir(), 'fv-p4c2b3c3-host-'));
    cleanup.push(() => rmSync(hostDir, { recursive: true, force: true }));
    const hostStore = await openSqliteHumanIdentityStore(join(hostDir, 'human-identity.sqlite'), { organizationId: ORG, now: () => LATER, authenticity: { signer: testSigner(AUTHORITY_KEY_A), verifier: testVerifier([AUTHORITY_KEY_A]) }, create: true });
    cleanup.push(() => hostStore.close());
    const service = createHumanIdentityService({ store: hostStore, relyingParty: RP, operatorIds: OPERATORS, now: () => new Date(LATER) });
    const admin = identityAdministratorFor({ plane: 'operator', operatorId: 'ops-admin', organizationId: ORG, role: 'organization-administrator', credentialClass: 'operator', actorRef: 'operator-plane:ops-admin' });
    await service.createPrincipal(admin, { operatorId: 'requester-a', displayName: 'Synthetic requester' });
    assert.equal(hostStore.head().sequence, 1, 'AUTH-04A writes its own store while the executor runs');
    const request = requestFor(NS_A);
    const ran = await host.bootstrap({ request, signedStatusText: S.active1.text, ...decisionsFor(host, w.devices, request) });
    assert.equal(ran.result.outcome, 'established', 'and the executor its own');
    assert.deepEqual(summary(await host.reconcile()), [['settled', 'bootstrap-committed'], ['settled', 'bootstrap-committed']]);
    host.close();
    assert.equal(await kinds(w, 'decision_outcome'), 2, 'both settlements are durable in the executor’s own store');
    assert.equal(hostStore.history().some((row) => row.kind === 'decision_authorized' || row.kind === 'decision_outcome'), false, 'nothing of FV in AUTH-04A’s');
  });
});

// ── Settlement fencing ──────────────────────────────────────────────────────

describe('FV-P4C-2B3C-3 settlement — fenced inside the identity owner’s own write transaction', () => {
  it('the B3B residual, closed: the lock lost after the FV settlement guard passed, before the AUTH-03 write, settles nothing', { timeout: 90_000 }, async () => {
    const w = await world();
    const bootstrap = await signedJob(w);
    const child = spawnChild({ mode: 'settle-race', refuseSource: true, grace: GRACE, dir: w.dir, namespaces: w.namespaces, at: addSeconds(T, 5), bootstrap });
    const out = await child.next((l) => 'entries' in l);
    assert.equal(out.bootstrap, 'SOURCE_UNAVAILABLE');
    assert.equal(out.settlementsWritten, 0, 'the store’s in-transaction fence refused the write the guard had let through');
    assert.ok(Array.isArray(out.entries) && out.entries.every(([result]) => result === 'unresolved'), JSON.stringify(out.entries));
    assert.equal((await child.exited).signal, 'SIGKILL', 'and the stale executor stopped before any closing checkpoint');
    assert.equal(await kinds(w, 'decision_outcome'), 0);
    const r = await start(w);
    r.clock.advance(GRACE + 1);
    assert.deepEqual(summary(await r.host.reconcile()), [['settled', 'bootstrap-not-committed'], ['settled', 'bootstrap-not-committed']], 'a later owner settles the truth, from evidence');
  });

  it('the identity store’s lock lost: no challenge, no consumption, no settlement; the decisions stay usable for the next owner', { timeout: 90_000 }, async () => {
    const w = await world();
    const bootstrap = await signedJob(w);
    const child = spawnChild({ mode: 'identity-loss', dir: w.dir, namespaces: w.namespaces, at: addSeconds(T, 5), bootstrap });
    const out = await child.next((l) => 'begin' in l);
    assert.deepEqual([out.identityHeld, out.protectedHeld], [false, true]);
    assert.notEqual(out.begin, 'issued', 'no challenge issued into a store this process no longer holds');
    assert.notEqual(out.bootstrap, 'established');
    assert.equal(out.readiness, 'executor-lost', 'review L3: the identity store’s lock is part of the executor’s authority');
    assert.equal((await child.exited).signal, 'SIGKILL');
    assert.equal(await kinds(w, 'decision_authorized'), 0, 'nothing consumed');
    // A correct owner then finds nothing consumed and nothing to settle, and serves a new, freshly signed bootstrap.
    const r = await start(w);
    assert.deepEqual(summary(await r.host.reconcile()), []);
    const request = requestFor(NS_A);
    const ran = await r.host.bootstrap({ request, signedStatusText: S.active1.text, ...decisionsFor(r.host, w.devices, request) });
    assert.equal(ran.result.outcome, 'established');
  });

  it('CORE-07-FV-WITNESS (closes review M1): the Host’s and the FV store’s identity freshness domains at one witness are independent', async () => {
    const witness = await startWitness();
    const authenticity = { signer: testSigner(AUTHORITY_KEY_A), verifier: testVerifier([AUTHORITY_KEY_A]) };
    const hostDir = mkdtempSync(join(tmpdir(), 'fv-p4c2b3c3-host-'));
    cleanup.push(() => rmSync(hostDir, { recursive: true, force: true }));
    const hostPath = join(hostDir, 'human-identity.sqlite');
    const openHost = async (create = false) => openSqliteHumanIdentityStore(hostPath, { organizationId: ORG, now: () => LATER, authenticity, create, freshness: { boundary: await boundaryFor(witness, ORG) } });
    const admin = identityAdministratorFor({ plane: 'operator', operatorId: 'ops-admin', organizationId: ORG, role: 'organization-administrator', credentialClass: 'operator', actorRef: 'operator-plane:ops-admin' });
    // AUTH-04A's store takes the legacy slot first, exactly as before.
    let hostStore = await openHost(true);
    await createHumanIdentityService({ store: hostStore, relyingParty: RP, operatorIds: OPERATORS, now: () => new Date(LATER) }).createPrincipal(admin, { operatorId: 'requester-a', displayName: 'Synthetic requester' });
    const hostId = hostStore.storeId;
    hostStore.close();
    // The FV store's (test-only) registration genesis enrolls its OWN domain at the same witness: a new store id,
    // never the Host's adopted genesis.
    const w = await anchoredWorld(witness);
    const fvId = identityConfigOf(w.dir).storeId;
    assert.notEqual(fvId, hostId);
    const rows = await witnessRows(witness.databasePath);
    const slot = (kind) => rows.find((row) => row.state_kind === kind && row.organization_id === ORG);
    assert.equal(slot('human-identity-state').store_id, hostId);
    assert.equal(slot('human-identity-state').committed_sequence, 1, 'the Host’s slot is untouched by the FV genesis and appends');
    assert.equal(slot(FV_DOMAIN).store_id, fvId);
    assert.ok(slot(FV_DOMAIN).committed_sequence >= 1);
    // The executor composes against its own domain; the Host keeps advancing its own, independently.
    const fresh = async () => ({ boundary: await boundaryFor(witness, ORG), stateKind: FV_DOMAIN });
    const r = await start(w, LATER, { identity: identityConfigOf(w.dir, { freshness: await fresh() }) });
    hostStore = await openHost();
    await createHumanIdentityService({ store: hostStore, relyingParty: RP, operatorIds: OPERATORS, now: () => new Date(LATER) }).createPrincipal(admin, { operatorId: 'approver-b', displayName: 'Synthetic approver' });
    assert.equal(hostStore.head().sequence, 2);
    hostStore.close();
    const after = await witnessRows(witness.databasePath);
    assert.equal(after.find((row) => row.state_kind === FV_DOMAIN).committed_sequence, slot(FV_DOMAIN).committed_sequence, 'advancing the Host never advances FV');
    r.host.close();
    // The domain is named explicitly, and only the FV domain: none, the Host's slot or an unknown one is refused.
    for (const freshness of [{ boundary: await boundaryFor(witness, ORG) }, { boundary: await boundaryFor(witness, ORG), stateKind: 'human-identity-state' }, { boundary: await boundaryFor(witness, ORG), stateKind: 'fv-bootstrap-identity-state ' }, { boundary: await boundaryFor(witness, ORG), stateKind: 'FV-BOOTSTRAP-IDENTITY-STATE' }]) {
      await assert.rejects(compose(w, makeClock(LATER), { identity: identityConfigOf(w.dir, { freshness }) }), (e) => e.code === 'OPTIONS_INVALID', JSON.stringify(freshness.stateKind));
    }
    // Another organization's boundary is refused at the store.
    await assert.rejects(compose(w, makeClock(LATER), { identity: identityConfigOf(w.dir, { freshness: { boundary: await boundaryFor(witness, 'org-other'), stateKind: FV_DOMAIN } }) }), (e) => e.code === 'IDENTITY_REFUSED');
    // The Host's file at the executor's path is not the pinned store: refused before any write or witness contact.
    const saved = join(w.dir, 'fv-identity.saved');
    copyFileSync(w.paths.identity, saved);
    copyFileSync(hostPath, w.paths.identity);
    await assert.rejects(compose(w, makeClock(LATER), { identity: identityConfigOf(w.dir, { freshness: await fresh() }) }), (e) => e.code === 'IDENTITY_REFUSED');
    copyFileSync(saved, w.paths.identity);
    (await start(w, LATER, { identity: identityConfigOf(w.dir, { freshness: await fresh() }) })).host.close();
    // AUTH-04A's store keeps working under its slot.
    hostStore = await openHost();
    assert.equal(hostStore.storeId, hostId);
    hostStore.close();
  });

  it('PR #255 review: an enrollment hidden from the composition’s check (a Proxy, or added after validation) never reaches the store; the unbound slot stays AUTH-04A’s to bind', async () => {
    const w = await world();
    const witness = await startWitness();
    const boundary = await boundaryFor(witness, ORG);
    const enrollment = { operator: true, operatorId: 'ops-admin', attestation: 'verified-local-state-is-current' };
    // (a) A Proxy that hides `enrollment` from `in` but yields it on read.
    const hidden = new Proxy({ boundary, enrollment, stateKind: FV_DOMAIN }, { has: (target, key) => key !== 'enrollment' && key in target });
    assert.equal('enrollment' in hidden, false);
    await assert.rejects(compose(w, makeClock(LATER), { identity: identityConfigOf(w.dir, { freshness: hidden }) }), (e) => e.code === 'IDENTITY_REFUSED', 'not enrolled: the slot is unbound');
    // (b) An enrollment added after the synchronous validation, while the composition awaits its stores.
    const later = { boundary, stateKind: FV_DOMAIN };
    const composing = compose(w, makeClock(LATER), { identity: identityConfigOf(w.dir, { freshness: later }) });
    later.enrollment = enrollment;
    await assert.rejects(composing, (e) => e.code === 'IDENTITY_REFUSED', 'not enrolled: the slot is unbound');
    // The store layer refuses the combination on its own (defence in depth).
    const authenticity = { signer: testSigner(AUTHORITY_KEY_A), verifier: testVerifier([AUTHORITY_KEY_A]) };
    await assert.rejects(
      openSqliteHumanIdentityStore(w.paths.identity, { organizationId: ORG, now: () => LATER, authenticity, freshness: { boundary, enrollment, stateKind: FV_DOMAIN }, exclusive: { beforeWrite: () => undefined, closer: (_file, connection) => () => void connection.close() } }),
      (e) => e.code === 'HUMAN_IDENTITY_CONFIGURATION_INVALID',
    );
    // The organization's one slot was never bound by FV: AUTH-04A's new store still takes it at genesis (a slot
    // holding any state beyond genesis would refuse this creation).
    const hostDir = mkdtempSync(join(tmpdir(), 'fv-p4c2b3c3-host-'));
    cleanup.push(() => rmSync(hostDir, { recursive: true, force: true }));
    const hostStore = await openSqliteHumanIdentityStore(join(hostDir, 'human-identity.sqlite'), { organizationId: ORG, now: () => LATER, authenticity, create: true, freshness: { boundary: await boundaryFor(witness, ORG) } });
    assert.equal(hostStore.head().sequence, 0);
    hostStore.close();
  });

  it('CORE-07-FV-WITNESS: each identity domain detects its own rollback; restoring one never disturbs the other', async () => {
    const witness = await startWitness();
    const w = await anchoredWorld(witness);
    const fresh = async () => ({ boundary: await boundaryFor(witness, ORG), stateKind: FV_DOMAIN });
    const older = join(w.dir, 'older-identity.sqlite');
    copyFileSync(w.paths.identity, older);
    // The FV store advances (its exclusive owner, in its own domain).
    const admin = identityAdministratorFor({ plane: 'operator', operatorId: 'ops-admin', organizationId: ORG, role: 'organization-administrator', credentialClass: 'operator', actorRef: 'operator-plane:ops-admin' });
    const authenticity = { signer: testSigner(AUTHORITY_KEY_A), verifier: testVerifier([AUTHORITY_KEY_A]) };
    const owner = await openSqliteHumanIdentityStore(w.paths.identity, { organizationId: ORG, now: () => LATER, authenticity, freshness: await fresh(), exclusive: { beforeWrite: () => undefined, closer: (_f, c) => () => void c.close(), storeId: identityConfigOf(w.dir).storeId } });
    await createHumanIdentityService({ store: owner, relyingParty: RP, operatorIds: [...OPERATORS, 'observer-x'], now: () => new Date(LATER) }).createPrincipal(admin, { operatorId: 'observer-x', displayName: 'Synthetic observer' });
    owner.close();
    (await start(w, LATER, { identity: identityConfigOf(w.dir, { freshness: await fresh() }) })).host.close();
    // A Host store in the same organization, at the same witness.
    const hostDir = mkdtempSync(join(tmpdir(), 'fv-p4c2b3c3-host-'));
    cleanup.push(() => rmSync(hostDir, { recursive: true, force: true }));
    const hostPath = join(hostDir, 'human-identity.sqlite');
    const openHost = async (create = false) => openSqliteHumanIdentityStore(hostPath, { organizationId: ORG, now: () => LATER, authenticity, create, freshness: { boundary: await boundaryFor(witness, ORG) } });
    let hostStore = await openHost(true);
    hostStore.close();
    const hostOlder = join(hostDir, 'older.sqlite');
    copyFileSync(hostPath, hostOlder);
    hostStore = await openHost();
    await createHumanIdentityService({ store: hostStore, relyingParty: RP, operatorIds: OPERATORS, now: () => new Date(LATER) }).createPrincipal(admin, { operatorId: 'requester-a', displayName: 'Synthetic requester' });
    hostStore.close();
    // The FV store restored to its older state: refused by its own domain.
    copyFileSync(older, w.paths.identity);
    await assert.rejects(compose(w, makeClock(LATER), { identity: identityConfigOf(w.dir, { freshness: await fresh() }) }), (e) => e.code === 'IDENTITY_REFUSED' && /older than the witnessed/.test(e.message), 'the FV witness knows a newer head');
    // ... while the Host store, current, opens; then the Host restored is refused by its own, while FV's refusal is unchanged.
    (await openHost()).close();
    copyFileSync(hostOlder, hostPath);
    await assert.rejects(openHost(), (e) => e.code === 'AUTHORITY_FRESHNESS_ROLLBACK_DETECTED');
    const rows = await witnessRows(witness.databasePath);
    assert.equal(rows.filter((row) => row.organization_id === ORG).length, 2, 'two slots, one per domain; nothing re-anchored or re-enrolled');
    assert.ok(rows.every((row) => row.pending_sequence === null));
  });
});
