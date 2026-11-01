import { createHash } from 'node:crypto';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import Database from 'better-sqlite3';

import {
  BOOTSTRAP_AUTHORITY_CHALLENGE_FORMAT,
  BOOTSTRAP_AUTHORITY_REQUEST_PREFIX,
  INTENDED_PRODUCTION_RP_ID,
  RETIRED_BOOTSTRAP_AUTHORITY_FORMATS,
  bootstrapAuthorityRequestId,
  createHumanIdentityServiceWithBootstrapSettlement,
  createRelyingPartyConfiguration,
  humanDecisionEvidenceDigest,
  identityAdministratorFor,
  openSqliteHumanIdentityStore,
  parseBootstrapAuthorityRequestId,
  type BootstrapSettlementCapability,
  type HumanIdentityService,
  type HumanIdentityStore,
} from '../human-identity/index.js';
import {
  BOOTSTRAP_HUMAN_DECISION_FORMAT,
  BOOTSTRAP_HUMAN_DECISION_REQUEST_PREFIX,
  STATUS_HISTORY_BOOTSTRAP_EVIDENCE_SCHEMA,
  bootstrapAuthorityDecisionInput,
  bootstrapBindingDigest,
  bootstrapBindingOf,
  bootstrapHumanDecisionRequestId,
  createBootstrapAuthorityReconciler,
  createHumanDecisionBootstrapAuthorizer,
  openSqliteStatusHighWaterMarkStore,
  parseBootstrapAuthorityRef,
  parseBootstrapHumanDecisionRequestId,
  parseStatusHistoryBootstrapRequest,
} from '../sovereign-status-history/index.js';
import type {
  BootstrapAuthorityReconcilerOptions,
  BootstrapAuthorityReconciliationEntry,
  BootstrapAuthoritySettlementPort,
  BootstrapEvidenceHistory,
  BootstrapEvidenceInventorySnapshot,
  BootstrapHumanPermissions,
  SqliteStatusHighWaterMarkStore,
  StatusHistoryBootstrapBinding,
} from '../sovereign-status-history/index.js';
import { testSigner, testVerifier } from './authority-authenticity-fixture.js';
import { SoftwareAuthenticator } from './auth02-software-authenticator.js';

// FV-P4C-2B2C — reconciler liveness (F2) and history inventory integrity (R5), against REAL services:
// the AUTH-03 identity service (software passkeys, signed chain), real SQLite status histories written
// through their own evidence path, and the real FV authorizer. Synthetic principals and data; no composition.

const ORG = 'org-fv-p4c2b2c';
const NS_A = 'receiver:fv-p4c2b2c-a';
const NS_B = 'receiver:fv-p4c2b2c-b';
const NS_C = 'receiver:fv-p4c2b2c-c';
const ORIGIN = `https://${INTENDED_PRODUCTION_RP_ID}`;
const RP = createRelyingPartyConfiguration({ rpId: INTENDED_PRODUCTION_RP_ID, rpName: 'Frontera Authority', allowedOrigins: [ORIGIN] });
const OPERATORS = ['requester-a', 'approver-b', 'approver-c'];
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

interface History {
  store: SqliteStatusHighWaterMarkStore;
  readonly namespace: string;
  readonly path: string;
}

interface World {
  readonly dir: string;
  readonly clock: Clock;
  readonly service: HumanIdentityService;
  readonly capability: BootstrapSettlementCapability;
  readonly store: HumanIdentityStore;
  readonly devices: Record<string, SoftwareAuthenticator>;
  readonly histories: Record<string, History>;
}

async function openHistory(dir: string, namespace: string, create = true, path = join(dir, `${namespace.replace(/[^a-z0-9]/g, '_')}.sqlite`)): Promise<History> {
  const store = await openSqliteStatusHighWaterMarkStore(path, { namespace, create });
  closers.push(() => store.close());
  return { store, namespace, path };
}

async function world(namespaces: readonly string[] = [NS_A, NS_B]): Promise<World> {
  const dir = mkdtempSync(join(tmpdir(), 'fv-p4c2b2c-'));
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
  const histories: Record<string, History> = {};
  for (const namespace of namespaces) histories[namespace] = await openHistory(dir, namespace);
  return { dir, clock, service, capability, store, devices, histories };
}

let counter = 0;
function binding(namespace = NS_A): { binding: StatusHistoryBootstrapBinding; digest: string } {
  counter += 1;
  const request = parseStatusHistoryBootstrapRequest({
    schemaVersion: 'frontera.sovereign-status-bootstrap/1',
    requestId: `req:fv-p4c2b2c-${counter}`,
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
  });
  assert.ok(request !== undefined);
  const b = bootstrapBindingOf(request);
  return { binding: b, digest: bootstrapBindingDigest(b) };
}

type Bound = ReturnType<typeof binding>;

const decide = (w: World, operatorId: string, b: Bound, role: 'requester' | 'approver'): unknown =>
  w.devices[operatorId]!.assert(w.service.beginBootstrapAuthorityDecision({ operatorId, ...bootstrapAuthorityDecisionInput(b.binding, role) }).options);

/** A consumed requester/approver pair through the real authorizer. */
async function consumedPair(w: World, b: Bound, approverId = 'approver-b') {
  const authorizer = createHumanDecisionBootstrapAuthorizer({ decisions: w.service, organizationId: ORG, permissions: allow, requesterResponse: decide(w, 'requester-a', b, 'requester'), approverResponse: decide(w, approverId, b, 'approver') });
  const result = (await authorizer.authorizeStatusHistoryBootstrap(b.binding, b.digest)) as { outcome: string; authorityRef: string };
  assert.equal(result.outcome, 'authorized', String(authorizer.lastDenial()));
  const ref = parseBootstrapAuthorityRef(result.authorityRef)!;
  return { authorityRef: result.authorityRef, requester: ref.requesterCommitment, approver: ref.approverCommitment };
}

/** One consumed requester decision whose approver never consumed: its bootstrap can never commit. */
async function loneRequester(w: World, b: Bound): Promise<string> {
  const consumed = await w.service.authorizeBootstrapAuthorityDecision(decide(w, 'requester-a', b, 'requester'));
  return consumed.commitment;
}

/** Anchors `b` in the real history of its namespace through the store's own evidence transaction, naming `authorityRef`. */
async function anchor(w: World, b: Bound, authorityRef: string): Promise<void> {
  const at = '2026-10-29T12:00:30Z';
  const key = { sovereignAssetId: b.binding.sovereignAssetId, issuer: b.binding.issuer };
  const recorded = await w.histories[b.binding.namespace]!.store.compareAndSetWithEvidence(
    key,
    null,
    { ...key, sequence: 1, statusDigest: 'b'.repeat(64), issuedAt: '2026-10-29T11:59:00Z', currentTermsDigest: null, timeFloor: '2026-10-29T11:59:00Z', withdrawn: false, retiredTermsDigests: [], continuity: 'verified', conflict: false, anchoredAt: at },
    {
      schemaVersion: STATUS_HISTORY_BOOTSTRAP_EVIDENCE_SCHEMA,
      operationId: `op:${b.binding.requestId}`,
      requestId: b.binding.requestId,
      namespace: b.binding.namespace,
      sovereignAssetId: key.sovereignAssetId,
      issuer: key.issuer,
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
}

/** A pair whose real evidence swaps their roles: both decisions are a permanent conflict (EVIDENCE_CONTRADICTS_DECISION). */
async function stuckPair(w: World, b = binding()): Promise<readonly [string, string]> {
  const pair = await consumedPair(w, b);
  await anchor(w, b, `frontera.sovereign-status-bootstrap-authority.v1:${pair.approver}:${pair.requester}`);
  return [pair.requester, pair.approver];
}

const entryOf = (w: World, namespace: string): BootstrapEvidenceHistory => ({ store: w.histories[namespace]!.store, namespace, databasePath: w.histories[namespace]!.path });
const fixed = (w: World, namespaces = Object.keys(w.histories)) => namespaces.map((namespace) => entryOf(w, namespace));

type Extra = Partial<Omit<BootstrapAuthorityReconcilerOptions, 'organizationId' | 'now' | 'graceSeconds'>>;
const reconciler = (w: World, extra: Extra = {}) =>
  createBootstrapAuthorityReconciler({
    settlement: extra.settlement ?? w.capability,
    ...(extra.inventory !== undefined ? { inventory: extra.inventory } : { histories: extra.histories ?? fixed(w) }),
    organizationId: ORG,
    now: w.clock.iso,
    graceSeconds: GRACE,
    inFlight: extra.inFlight ?? (() => false),
    ...(extra.maxDecisions !== undefined ? { maxDecisions: extra.maxDecisions } : {}),
    ...(extra.progress !== undefined ? { progress: extra.progress } : {}),
  });

const summary = (entries: readonly BootstrapAuthorityReconciliationEntry[]) => entries.map((e) => [e.result, 'reason' in e ? e.reason : e.settlement.outcome]);
const of = (entries: readonly BootstrapAuthorityReconciliationEntry[], commitment: string) => summary(entries.filter((e) => e.commitment === commitment));
const outcomeRows = (w: World) => w.store.history().filter((row) => row.kind === 'decision_outcome');
const settlementOf = (w: World, commitment: string) => w.service.bootstrapAuthorityDecision(commitment)?.settlement;
const sorted = (values: Iterable<string>) => [...values].sort();

/** A durable cursor a Host might keep (B3): here, a variable. */
function memoryProgress(initial?: unknown) {
  const saved: string[] = [];
  let value: unknown = initial;
  return {
    saved,
    load: () => value,
    save: (cursor: string) => {
      saved.push(cursor);
      value = cursor;
    },
  };
}

/** The cursor that makes the next page start at `first` in commitment order. */
function cursorBefore(keys: readonly string[], first: string): string {
  const index = keys.indexOf(first);
  assert.ok(index >= 0);
  return index === 0 ? '' : keys[index - 1]!;
}

/** A synthetic look-alike listing of `n` well-formed commitments that are not decisions: each is a permanent DECISION_MALFORMED conflict. */
function phantomListing(n: number, salt: string): BootstrapAuthoritySettlementPort & { writes: number; readonly listing: readonly { commitment: string }[] } {
  const listing = Array.from({ length: n }, (_, i) => ({ commitment: `sha256:${createDigest(`${salt}:${i}`)}`, state: 'consumed' }));
  const port = {
    writes: 0,
    listing,
    unsettledBootstrapAuthorityDecisions: () => listing,
    recordBootstrapAuthoritySettlement: async () => {
      port.writes += 1;
      return 'recorded' as const;
    },
  };
  return port;
}

const createDigest = (text: string) => createHash('sha256').update(text).digest('hex');

/** A consistent copy of a live WAL-mode history file (a backup, as an operator would take one). */
function backupOf(source: string, target: string): void {
  const db = new Database(source, { readonly: true });
  try {
    db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
  } finally {
    db.close();
  }
}

// ── AUTH-03 v2: the decision names its history ──────────────────────────────

describe('FV-P4C-2B2C R5 — a bootstrap decision signs the namespace of the one history its bootstrap targets', () => {
  it('the request id names namespace and binding, in one canonical spelling, identically in AUTH-03 and FV', () => {
    assert.equal(BOOTSTRAP_HUMAN_DECISION_FORMAT, BOOTSTRAP_AUTHORITY_CHALLENGE_FORMAT);
    assert.equal(BOOTSTRAP_HUMAN_DECISION_REQUEST_PREFIX, BOOTSTRAP_AUTHORITY_REQUEST_PREFIX);
    assert.ok(RETIRED_BOOTSTRAP_AUTHORITY_FORMATS.includes('frontera.sovereign-status-bootstrap-authority.v1'));
    const digest = 'c'.repeat(64);
    for (const namespace of [NS_A, 'receiver:a:b/c d', 'ünïcode:ns', 'x'.repeat(256)]) {
      const id = bootstrapAuthorityRequestId(namespace, digest);
      assert.equal(bootstrapHumanDecisionRequestId(namespace, digest), id);
      assert.deepEqual(parseBootstrapAuthorityRequestId(id), { namespace, bindingDigest: digest });
      assert.deepEqual(parseBootstrapHumanDecisionRequestId(id), { namespace, bindingDigest: digest });
    }
    // A namespace containing ':' cannot shift the digest boundary, and no alternative spelling is accepted.
    for (const bad of [
      `frontera.sovereign-status-bootstrap:${digest}`, // v1: no namespace
      `${BOOTSTRAP_AUTHORITY_REQUEST_PREFIX}${digest}`,
      `${BOOTSTRAP_AUTHORITY_REQUEST_PREFIX}receiver:fv:${digest}`, // unencoded ':'
      `${BOOTSTRAP_AUTHORITY_REQUEST_PREFIX}receiver%3afv:${digest}`, // lowercase escape
      `${BOOTSTRAP_AUTHORITY_REQUEST_PREFIX}%72eceiver:${digest}`, // an unreserved character escaped
      `${BOOTSTRAP_AUTHORITY_REQUEST_PREFIX}%E0%A4%A:${digest}`, // a broken escape
      `${BOOTSTRAP_AUTHORITY_REQUEST_PREFIX}${encodeURIComponent(' padded')}:${digest}`,
      `${BOOTSTRAP_AUTHORITY_REQUEST_PREFIX}${encodeURIComponent('x'.repeat(257))}:${digest}`,
      `${BOOTSTRAP_AUTHORITY_REQUEST_PREFIX}${encodeURIComponent(NS_A)}:${'C'.repeat(64)}`,
    ]) {
      assert.equal(parseBootstrapAuthorityRequestId(bad), undefined, bad);
      assert.equal(parseBootstrapHumanDecisionRequestId(bad), undefined, bad);
    }
    assert.throws(() => bootstrapAuthorityRequestId('', digest), /namespace/);
    assert.throws(() => bootstrapHumanDecisionRequestId('a\u0001b', digest), /namespace/);
  });

  it('AUTH-03 refuses to issue a bootstrap decision that names no namespace; the issued contract is v2 and signs it', async () => {
    const w = await world();
    const b = binding(NS_B);
    assert.throws(() => w.service.beginBootstrapAuthorityDecision({ operatorId: 'requester-a', bindingDigest: b.digest, role: 'attest' } as never), /namespace/);
    assert.throws(() => w.service.beginBootstrapAuthorityDecision({ operatorId: 'requester-a', namespace: ' ', bindingDigest: b.digest, role: 'attest' }), /namespace/);
    const commitment = await loneRequester(w, b);
    const record = w.service.bootstrapAuthorityDecision(commitment)!;
    assert.equal(record.contract.format, 'frontera.sovereign-status-bootstrap-authority.v2');
    assert.deepEqual(parseBootstrapAuthorityRequestId(record.contract.approvalRequestId), { namespace: NS_B, bindingDigest: b.digest });
  });

  it('a retired v1 bootstrap row — challenge or signed decision — is refused as corrupt, never read as a CORE-05 decision', async () => {
    const w = await world();
    const commitment = await loneRequester(w, binding(NS_A));
    const real = w.service.bootstrapAuthorityDecision(commitment)!.evidence!;
    const digest = real.subjectDigest.slice('sha256:'.length);
    // A v1 `approve` would, absent the retirement, look like a CORE-05 verdict: same vocabulary, an unknown format.
    const v1 = { ...real, format: 'frontera.sovereign-status-bootstrap-authority-evidence.v1', verdict: 'approve', approvalRequestId: `frontera.sovereign-status-bootstrap:${digest}`, challengeCommitment: `sha256:${'1'.repeat(64)}` };
    const sortedJson = (value: unknown): string =>
      Array.isArray(value) ? `[${value.map(sortedJson).join(',')}]` : value !== null && typeof value === 'object' ? `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${sortedJson((value as Record<string, unknown>)[k])}`).join(',')}}` : JSON.stringify(value);
    const payload = { evidence: v1, evidenceDigest: humanDecisionEvidenceDigest(v1 as never), challengeDigest: `sha256:${'2'.repeat(64)}`, counter: 0, backedUp: false };
    await w.store.append({ kind: 'decision_authorized', operatorId: real.operatorId, objectId: v1.challengeCommitment, payload: sortedJson(payload), recordedBy: 'webauthn-ceremony', recordedAt: w.clock.iso() }, () => undefined);
    assert.throws(() => w.service.unsettledDecisions(), (error: { code?: string; message?: string }) => error.code === 'HUMAN_IDENTITY_STORE_CORRUPT' && /retired/.test(String(error.message)));
    // The raw challenge table refuses a v1 contract on read, too.
    const w2 = await world();
    w2.store.saveDecisionChallenge({ challenge: 'retired-challenge', contract: { format: 'frontera.sovereign-status-bootstrap-authority.v1', organizationId: ORG, approvalRequestId: `frontera.sovereign-status-bootstrap:${digest}`, subjectDigest: real.subjectDigest, verdict: 'approve', operatorId: 'approver-b', nonce: 'n', issuedAt: w2.clock.iso(), expiresAt: w2.clock.iso() } as never });
    assert.throws(() => w2.store.decisionChallenge('retired-challenge'), /retired/);
  });

  it('a decision signed for another namespace than its binding never authorizes that bootstrap', async () => {
    const w = await world();
    const b = binding(NS_A);
    const wrong = (operatorId: string, role: 'attest' | 'approve') =>
      w.devices[operatorId]!.assert(w.service.beginBootstrapAuthorityDecision({ operatorId, namespace: NS_B, bindingDigest: b.digest, role }).options);
    const authorizer = createHumanDecisionBootstrapAuthorizer({ decisions: w.service, organizationId: ORG, permissions: allow, requesterResponse: wrong('requester-a', 'attest'), approverResponse: wrong('approver-b', 'approve') });
    assert.deepEqual(await authorizer.authorizeStatusHistoryBootstrap(b.binding, b.digest), { outcome: 'denied' });
    assert.equal(authorizer.lastDenial(), 'DECISION_NOT_FOR_THIS_BOOTSTRAP');
    assert.deepEqual(authorizer.consumedDecisions(), [], 'nothing consumed');
  });
});

// ── F2: liveness ────────────────────────────────────────────────────────────

describe('FV-P4C-2B2C F2 — permanently stuck decisions never starve the rest', () => {
  it('ACCEPTANCE: two stuck decisions ahead of one valid decision, maxDecisions = 2 — the valid one is processed within two runs; the stuck stay auditable', async () => {
    const w = await world();
    const stuck = await stuckPair(w);
    const valid = await loneRequester(w, binding(NS_B));
    w.clock.advance(GRACE + 1);
    const keys = sorted([...stuck, valid]);
    // The two stuck decisions are adjacent in commitment order (cyclically): start the first page exactly at them.
    const firstStuck = keys.find((k, i) => stuck.includes(k) && stuck.includes(keys[(i + 1) % keys.length]!))!;
    const progress = memoryProgress(cursorBefore(keys, firstStuck));
    const r = reconciler(w, { maxDecisions: 2, progress });

    const first = await r.reconcile();
    // Run 1 sees only the stuck pair — what a first-N reconciler would see on every run, forever.
    assert.deepEqual(sorted(first.map((e) => e.commitment)), sorted(stuck));
    assert.deepEqual(summary(first), [['conflict', 'EVIDENCE_CONTRADICTS_DECISION'], ['conflict', 'EVIDENCE_CONTRADICTS_DECISION']]);
    assert.equal(outcomeRows(w).length, 0, 'no false settlement of a conflict');

    const second = await r.reconcile();
    assert.deepEqual(of(second, valid), [['settled', 'bootstrap-not-committed']]);
    assert.deepEqual(settlementOf(w, valid), { outcome: 'bootstrap-not-committed', bindingDigest: w.service.bootstrapAuthorityDecision(valid)!.contract.subjectDigest.slice(7), code: 'NO_BOOTSTRAP_EVIDENCE' });
    assert.equal(outcomeRows(w).length, 1, 'exactly the valid decision');

    // The stuck pair: still unsettled, still listed, still reported, never settled either way.
    for (let run = 0; run < 3; run += 1) for (const e of await r.reconcile()) assert.deepEqual(summary([e]), [['conflict', 'EVIDENCE_CONTRADICTS_DECISION']]);
    assert.deepEqual(sorted(w.service.unsettledBootstrapAuthorityDecisions().map((d) => d.commitment)), sorted(stuck));
    for (const c of stuck) assert.equal(settlementOf(w, c), undefined);
    assert.equal(outcomeRows(w).length, 1);
  });

  it('maxDecisions = 1: each run examines one decision, and consecutive runs cover every decision exactly once per revolution', async () => {
    const w = await world();
    const stuck = await stuckPair(w);
    const lone = await loneRequester(w, binding(NS_A));
    const r = reconciler(w, { maxDecisions: 1 });
    const seen: string[] = [];
    for (let run = 0; run < 3; run += 1) {
      const entries = await r.reconcile();
      assert.equal(entries.length, 1);
      seen.push(entries[0]!.commitment);
    }
    assert.deepEqual(sorted(seen), sorted([...stuck, lone]), 'one revolution, no repeats');
    assert.deepEqual(of(await r.reconcile(), seen[0]!).length, 1, 'the next revolution starts again where the first did');
  });

  it('all decisions conflicting: every run reports conflicts, writes nothing, and rotates through them', async () => {
    const w = await world();
    const stuck = [...(await stuckPair(w)), ...(await stuckPair(w))];
    const r = reconciler(w, { maxDecisions: 3 });
    const seen = new Map<string, number>();
    for (let run = 0; run < 4; run += 1) {
      for (const e of await r.reconcile()) {
        assert.deepEqual(summary([e]), [['conflict', 'EVIDENCE_CONTRADICTS_DECISION']]);
        seen.set(e.commitment, (seen.get(e.commitment) ?? 0) + 1);
      }
    }
    // 4 runs × 3 = 12 examinations over 4 decisions: exactly 3 each.
    assert.deepEqual(sorted(seen.keys()), sorted(stuck));
    for (const count of seen.values()) assert.equal(count, 3);
    assert.equal(outcomeRows(w).length, 0);
  });

  it('in-flight decisions are reported, never settled, and never hold the page', async () => {
    const w = await world();
    const pair = await consumedPair(w, binding(NS_A));
    const valid = await loneRequester(w, binding(NS_B));
    w.clock.advance(GRACE + 1);
    const flying = new Set([pair.requester, pair.approver]);
    const keys = sorted([...flying, valid]);
    const firstFlying = keys.find((k, i) => flying.has(k) && flying.has(keys[(i + 1) % 3]!))!;
    const r = reconciler(w, { maxDecisions: 2, inFlight: (c) => flying.has(c), progress: memoryProgress(cursorBefore(keys, firstFlying)) });
    assert.deepEqual(summary(await r.reconcile()), [['unresolved', 'IN_FLIGHT'], ['unresolved', 'IN_FLIGHT']]);
    assert.deepEqual(of(await r.reconcile(), valid), [['settled', 'bootstrap-not-committed']]);
    for (const c of flying) assert.equal(settlementOf(w, c), undefined);
    // R4 hardening: only an answer of exactly `false` is "not in flight"; anything else, or a throw, is in flight.
    for (const answer of [undefined, 'false', 0, null, () => { throw new Error('registry down'); }]) {
      const inFlight = typeof answer === 'function' ? (answer as () => boolean) : () => answer as never;
      for (const e of await reconciler(w, { inFlight }).reconcile()) assert.deepEqual(summary([e]), [['unresolved', 'IN_FLIGHT']], String(answer));
    }
    assert.equal(outcomeRows(w).length, 1);
  });

  it('a decision added between pages is reached within the revolution; a settled one simply leaves; a cursor on a settled record continues after it', async () => {
    const w = await world();
    const a = await loneRequester(w, binding(NS_A));
    const b = await loneRequester(w, binding(NS_A));
    w.clock.advance(GRACE + 1);
    const progress = memoryProgress();
    const r = reconciler(w, { maxDecisions: 1, progress });
    const first = (await r.reconcile())[0]!;
    assert.equal(first.result, 'settled');
    // The cursor now names a settled record that is no longer listed.
    assert.equal(progress.saved.at(-1), first.commitment);
    const c = await loneRequester(w, binding(NS_B));
    w.clock.advance(GRACE + 1);
    const settled = new Set([first.commitment]);
    for (let run = 0; run < 2; run += 1) for (const e of await r.reconcile()) if (e.result === 'settled') settled.add(e.commitment);
    assert.deepEqual(sorted(settled), sorted([a, b, c]));
    assert.deepEqual(await r.reconcile(), []);
    // A cursor past the end, or at a commitment that never existed, wraps or continues; it never throws or stalls.
    for (const cursor of [`sha256:${'f'.repeat(64)}`, `sha256:${'0'.repeat(64)}`, '']) assert.deepEqual(await reconciler(w, { progress: memoryProgress(cursor) }).reconcile(), []);
  });

  it('restart: a durable cursor continues where the last process stopped; without one, restarts start at random positions, never at the same blocked prefix', async () => {
    const w = await world();
    const port = phantomListing(16, 'restart');
    const progress = memoryProgress();
    const keys = sorted(port.listing.map((d) => d.commitment));
    const seen: string[] = [];
    // 16 restarts (a new reconciler each run) sharing one durable cursor: one full revolution, no repeats.
    for (let restart = 0; restart < 16; restart += 1) seen.push(...(await reconciler(w, { settlement: port, maxDecisions: 1, progress }).reconcile()).map((e) => e.commitment));
    assert.deepEqual(sorted(seen), keys);
    // Without a durable cursor: 64 restarts never all begin at the same decision (each start is uniform over 16).
    const starts = new Set<string>();
    for (let restart = 0; restart < 64; restart += 1) starts.add((await reconciler(w, { settlement: port, maxDecisions: 1 }).reconcile())[0]!.commitment);
    assert.ok(starts.size > 1, `restarts began at ${starts.size} distinct position(s)`);
    assert.equal(port.writes, 0);
  });

  it('interruption: a record that throws is malformed and the rest of its page still runs; the cursor is saved before processing', async () => {
    const w = await world();
    const valid = await loneRequester(w, binding(NS_A));
    w.clock.advance(GRACE + 1);
    const real = w.capability.unsettledBootstrapAuthorityDecisions()[0]!;
    const poison = Object.defineProperty({ commitment: `sha256:${'0'.repeat(64)}` }, 'contract', { enumerable: true, get: () => { throw new Error('poison'); } });
    const port: BootstrapAuthoritySettlementPort = {
      unsettledBootstrapAuthorityDecisions: () => [poison, real],
      recordBootstrapAuthoritySettlement: (c, s) => w.capability.recordBootstrapAuthoritySettlement(c, s),
    };
    const progress = memoryProgress('');
    // The poison sorts first; the valid decision is second in the same page (review #4).
    const entries = await reconciler(w, { settlement: port, maxDecisions: 2, progress }).reconcile();
    assert.deepEqual(progress.saved, [sorted([poison.commitment, valid]).at(-1)], 'saved once, before processing');
    assert.deepEqual(of(entries, poison.commitment), [['conflict', 'DECISION_MALFORMED']]);
    assert.deepEqual(of(entries, valid), [['settled', 'bootstrap-not-committed']]);
    // A settlement port that throws synchronously is contained, too.
    const throwing: BootstrapAuthoritySettlementPort = { unsettledBootstrapAuthorityDecisions: () => [poison], recordBootstrapAuthoritySettlement: () => { throw new Error('boom'); } };
    await assert.doesNotReject(reconciler(w, { settlement: throwing }).reconcile());
  });

  it('invalid, unreadable or replayed cursors only change where a run starts — never an outcome; a failing save is tolerated', async () => {
    const w = await world();
    const stuck = await stuckPair(w);
    const valid = await loneRequester(w, binding(NS_B));
    w.clock.advance(GRACE + 1);
    const expected = new Map([[stuck[0], [['conflict', 'EVIDENCE_CONTRADICTS_DECISION']]], [stuck[1], [['conflict', 'EVIDENCE_CONTRADICTS_DECISION']]]]);
    const hostile = [42, 'garbage', `sha256:${'G'.repeat(64)}`, { toString: () => stuck[0] }, null];
    for (const loaded of hostile) {
      const entries = await reconciler(w, { progress: { load: () => loaded, save: () => undefined } }).reconcile();
      for (const [c, want] of expected) assert.deepEqual(of(entries, c), want);
    }
    // The first of those runs settled the valid decision, truthfully; the hostile cursors changed no outcome.
    assert.equal(settlementOf(w, valid)?.outcome, 'bootstrap-not-committed');
    assert.equal(outcomeRows(w).length, 1);
    await assert.doesNotReject(reconciler(w, { progress: { load: () => { throw new Error('unreadable'); }, save: () => { throw new Error('disk full'); } } }).reconcile());
    // Replay: a store that always returns the same old cursor. Each run still advances in-process; outcomes are unchanged.
    const replayed = { load: () => '', save: () => undefined };
    const r = reconciler(w, { maxDecisions: 1, progress: replayed });
    const seen = new Set<string>();
    for (let run = 0; run < 2; run += 1) for (const e of await r.reconcile()) seen.add(e.commitment);
    assert.deepEqual(sorted(seen), sorted(stuck), 'the replayed cursor is read once; the process still advances');
    for (const c of stuck) assert.equal(settlementOf(w, c), undefined);
    assert.throws(() => reconciler(w, { progress: { load: () => '' } as never }), /progress/);
  });

  it('a listing failure rejects the run without moving the cursor; a listing that names a commitment twice is not believed for it', async () => {
    const w = await world();
    const valid = await loneRequester(w, binding(NS_A));
    w.clock.advance(GRACE + 1);
    let fail = true;
    const port: BootstrapAuthoritySettlementPort = {
      unsettledBootstrapAuthorityDecisions: () => {
        if (fail) throw new Error('AUTH-03 store unavailable');
        return w.capability.unsettledBootstrapAuthorityDecisions();
      },
      recordBootstrapAuthoritySettlement: (c, s) => w.capability.recordBootstrapAuthoritySettlement(c, s),
    };
    const progress = memoryProgress();
    const r = reconciler(w, { settlement: port, progress });
    await assert.rejects(r.reconcile(), /unavailable/);
    assert.deepEqual(progress.saved, []);
    // The duplicate: never settled, whichever copy is genuine.
    const real = w.capability.unsettledBootstrapAuthorityDecisions()[0]!;
    const twice: BootstrapAuthoritySettlementPort = { unsettledBootstrapAuthorityDecisions: () => [real, real], recordBootstrapAuthoritySettlement: port.recordBootstrapAuthoritySettlement };
    assert.deepEqual(summary(await reconciler(w, { settlement: twice }).reconcile()), [['conflict', 'DECISION_DUPLICATE']]);
    assert.equal(settlementOf(w, valid), undefined);
    fail = false;
    assert.deepEqual(of(await r.reconcile(), valid), [['settled', 'bootstrap-not-committed']]);
  });

  it('a listed record that names one commitment when grouped and another when read is not believed: one examination per commitment per run', async () => {
    const w = await world();
    const valid = await loneRequester(w, binding(NS_A));
    w.clock.advance(GRACE + 1);
    const real = w.capability.unsettledBootstrapAuthorityDecisions()[0]! as unknown as Record<string, unknown>;
    let reads = 0;
    const flipping = new Proxy(real, { get: (target, key) => (key === 'commitment' ? ((reads += 1), reads === 1 ? `sha256:${'e'.repeat(64)}` : valid) : Reflect.get(target, key)) });
    let writes = 0;
    const port: BootstrapAuthoritySettlementPort = {
      unsettledBootstrapAuthorityDecisions: () => [real, flipping],
      recordBootstrapAuthoritySettlement: async (c, settlement) => ((writes += 1), w.capability.recordBootstrapAuthoritySettlement(c, settlement)),
    };
    const entries = await reconciler(w, { settlement: port }).reconcile();
    assert.deepEqual(of(entries, valid), [['settled', 'bootstrap-not-committed']]);
    assert.deepEqual(of(entries, `sha256:${'e'.repeat(64)}`), [['conflict', 'DECISION_MALFORMED']]);
    assert.equal(writes, 1);
  });

  it('bounded: a run examines at most maxDecisions, however many are listed, and saves its cursor once', async () => {
    const w = await world();
    const port = phantomListing(1500, 'bounded');
    const progress = memoryProgress();
    const entries = await reconciler(w, { settlement: port, maxDecisions: 5, progress }).reconcile();
    assert.equal(entries.length, 5);
    assert.equal(new Set(entries.map((e) => e.commitment)).size, 5);
    for (const e of entries) assert.deepEqual(summary([e]), [['conflict', 'DECISION_MALFORMED']]);
    assert.equal(progress.saved.length, 1);
    assert.equal(port.writes, 0);
    assert.equal((await reconciler(w, { settlement: port, maxDecisions: 1000 }).reconcile()).length, 1000);
  });

  it('concurrent reconcilers (and concurrent pages) settle each decision exactly once', async () => {
    const w = await world();
    const b = binding(NS_A);
    const pair = await consumedPair(w, b);
    await anchor(w, b, pair.authorityRef);
    const runs = await Promise.all([reconciler(w, { maxDecisions: 1 }).reconcile(), reconciler(w, { maxDecisions: 1 }).reconcile(), reconciler(w).reconcile(), reconciler(w).reconcile()]);
    for (const e of runs.flat()) assert.ok(e.result === 'settled' || e.result === 'unchanged', `${e.result}`);
    assert.equal(outcomeRows(w).length, 2);
    for (const c of [pair.requester, pair.approver]) assert.equal(settlementOf(w, c)?.outcome, 'bootstrap-committed');
    assert.deepEqual(await reconciler(w).reconcile(), []);
  });
});

// ── R5: inventory integrity ─────────────────────────────────────────────────

describe('FV-P4C-2B2C R5 — absence of evidence is believed only from the decision’s own, present, genuine history', () => {
  /** A Host inventory provider over mutable configuration. */
  const provider = (w: World, namespaces: readonly string[], generation = 1) => {
    const state = { generation, namespaces: [...namespaces], extra: {} as Record<string, unknown>, fail: false as false | 'throw' | 'unloaded' };
    const inventory = (): BootstrapEvidenceInventorySnapshot | undefined => {
      if (state.fail === 'throw') throw new Error('configuration service down');
      if (state.fail === 'unloaded') return undefined;
      return { generation: state.generation, histories: state.namespaces.map((n) => entryOf(w, n)), ...state.extra } as BootstrapEvidenceInventorySnapshot;
    };
    return { state, inventory };
  };

  it('16/31/18. a verified inventory holding the decision’s history settles NO_BOOTSTRAP_EVIDENCE; unrelated extra histories change nothing', async () => {
    const w = await world([NS_A, NS_B, NS_C]);
    const lone = await loneRequester(w, binding(NS_B));
    w.clock.advance(GRACE + 1);
    const { inventory } = provider(w, [NS_A, NS_B, NS_C]);
    assert.deepEqual(summary(await reconciler(w, { inventory }).reconcile()), [['settled', 'bootstrap-not-committed']]);
    assert.equal(settlementOf(w, lone)?.outcome, 'bootstrap-not-committed');
  });

  it('17/28. the decision’s history missing from the inventory: unresolved, never "no evidence" — even while its evidence exists there', async () => {
    const w = await world();
    const lone = await loneRequester(w, binding(NS_B));
    const b = binding(NS_B);
    const pair = await consumedPair(w, b);
    await anchor(w, b, pair.authorityRef);
    w.clock.advance(GRACE + 1);
    const { inventory } = provider(w, [NS_A]);
    const entries = await reconciler(w, { inventory }).reconcile();
    for (const c of [lone, pair.requester, pair.approver]) assert.deepEqual(of(entries, c), [['unresolved', 'HISTORY_NOT_IN_INVENTORY']]);
    assert.deepEqual(summary(await reconciler(w, { histories: fixed(w, [NS_A]) }).reconcile()), [['unresolved', 'HISTORY_NOT_IN_INVENTORY'], ['unresolved', 'HISTORY_NOT_IN_INVENTORY'], ['unresolved', 'HISTORY_NOT_IN_INVENTORY']]);
    assert.equal(outcomeRows(w).length, 0);
    // Once the Host's configuration includes it, the truth is settled: committed for the pair, not committed for the lone attempt.
    const fullEntries = await reconciler(w, { inventory: provider(w, [NS_A, NS_B]).inventory }).reconcile();
    assert.deepEqual(of(fullEntries, pair.requester), [['settled', 'bootstrap-committed']]);
    assert.deepEqual(of(fullEntries, lone), [['settled', 'bootstrap-not-committed']]);
  });

  it('30. valid matching committed evidence settles committed under a verified inventory', async () => {
    const w = await world();
    const b = binding(NS_B);
    const pair = await consumedPair(w, b);
    await anchor(w, b, pair.authorityRef);
    const entries = await reconciler(w, { inventory: provider(w, [NS_A, NS_B]).inventory }).reconcile();
    assert.deepEqual(of(entries, pair.requester), [['settled', 'bootstrap-committed']]);
    assert.deepEqual(of(entries, pair.approver), [['settled', 'bootstrap-committed']]);
  });

  it('19/20/22/23/24/29. a malformed or untrusted inventory settles nothing, each with its own reason', async () => {
    const w = await world();
    const b = binding(NS_A);
    const pair = await consumedPair(w, b);
    await anchor(w, b, pair.authorityRef);
    await loneRequester(w, binding(NS_A));
    w.clock.advance(GRACE + 1);
    const A = entryOf(w, NS_A);
    const B = entryOf(w, NS_B);
    const copy = join(w.dir, 'copy-of-a.sqlite');
    backupOf(A.databasePath, copy);
    const copied = await openHistory(w.dir, NS_A, false, copy);
    const cases: Array<readonly [string, unknown]> = [
      ['INVENTORY_DUPLICATE_NAMESPACE', { generation: 1, histories: [A, A] }],
      // A copy of a history (a stale backup, say) is a second file for the same namespace.
      ['INVENTORY_DUPLICATE_NAMESPACE', { generation: 1, histories: [A, { store: copied.store, namespace: NS_A, databasePath: copy }] }],
      ['INVENTORY_DUPLICATE_NAMESPACE', { generation: 1, histories: [A, { ...A, databasePath: join(w.dir, '.', 'receiver_fv_p4c2b2c_a.sqlite') }] }],
      ['INVENTORY_UNTRUSTED_HISTORY', { generation: 1, histories: [{ ...A, namespace: NS_B }] }], // wrong namespace for the handle
      ['INVENTORY_UNTRUSTED_HISTORY', { generation: 1, histories: [{ ...A, databasePath: B.databasePath }] }], // wrong file for the handle
      ['INVENTORY_UNTRUSTED_HISTORY', { generation: 1, histories: [{ ...A, store: { namespace: NS_A, readBootstrapEvidenceForBinding: () => [] } }] }], // a look-alike
      ['INVENTORY_UNTRUSTED_HISTORY', { generation: 1, histories: [{ ...A, store: Object.freeze({ ...A.store as object }) }] }], // a copy of a real handle
      // Untrusted completeness: a flag is never read; its presence makes the snapshot invalid.
      ['INVENTORY_INVALID', { generation: 1, histories: [A], complete: true }],
      ['INVENTORY_INVALID', { generation: 1, histories: [] }],
      ['INVENTORY_INVALID', { generation: -1, histories: [A] }],
      ['INVENTORY_INVALID', { generation: 1.5, histories: [A] }],
      ['INVENTORY_INVALID', { generation: '1', histories: [A] }],
      ['INVENTORY_INVALID', { histories: [A] }],
      ['INVENTORY_INVALID', [A]],
      ['INVENTORY_INVALID', { generation: 1, histories: [A, null] }],
      ['INVENTORY_INVALID', { generation: 1, histories: Array.from({ length: 257 }, () => A) }],
    ];
    for (const [reason, snapshot] of cases) {
      const entries = await reconciler(w, { inventory: () => snapshot as never }).reconcile();
      assert.equal(entries.length, 3);
      for (const e of entries) assert.deepEqual(summary([e]), [['unresolved', reason]], `${reason} ${JSON.stringify(snapshot, (k, v) => (k === 'store' ? '<store>' : v)).slice(0, 120)}`);
    }
    assert.equal(outcomeRows(w).length, 0);
    // The fixed form refuses the same things at construction.
    assert.throws(() => reconciler(w, { histories: [A, { store: copied.store, namespace: NS_A, databasePath: copy }] }), /once each/);
    assert.throws(() => reconciler(w, { histories: [{ ...A, namespace: NS_B }] }), /not a genuine/);
    assert.throws(() => createBootstrapAuthorityReconciler({ settlement: w.capability, histories: [A], inventory: () => undefined, organizationId: ORG, now: w.clock.iso, graceSeconds: GRACE, inFlight: () => false }), /Exactly one/);
    assert.throws(() => createBootstrapAuthorityReconciler({ settlement: w.capability, organizationId: ORG, now: w.clock.iso, graceSeconds: GRACE, inFlight: () => false }), /Exactly one/);
  });

  it('21/27/35. a stale generation, a reused generation, an unavailable provider and a configuration not yet loaded each leave everything unresolved', async () => {
    const w = await world();
    const lone = await loneRequester(w, binding(NS_A));
    w.clock.advance(GRACE + 1);
    const p = provider(w, [NS_A, NS_B], 5);
    const r = reconciler(w, { inventory: p.inventory, settlement: { unsettledBootstrapAuthorityDecisions: () => w.capability.unsettledBootstrapAuthorityDecisions(), recordBootstrapAuthoritySettlement: async () => { throw new Error('not reached'); } } });
    p.state.fail = 'unloaded';
    assert.deepEqual(summary(await r.reconcile()), [['unresolved', 'INVENTORY_NOT_LOADED']]);
    p.state.fail = 'throw';
    assert.deepEqual(summary(await r.reconcile()), [['unresolved', 'INVENTORY_UNAVAILABLE']]);
    p.state.fail = false;
    assert.deepEqual(summary(await r.reconcile()), [['unresolved', 'SETTLEMENT_FAILED']], 'generation 5 admitted');
    p.state.generation = 4;
    assert.deepEqual(summary(await r.reconcile()), [['unresolved', 'INVENTORY_STALE']]);
    p.state.generation = 5;
    p.state.namespaces = [NS_A];
    assert.deepEqual(summary(await r.reconcile()), [['unresolved', 'INVENTORY_GENERATION_REUSED']]);
    p.state.generation = 6;
    assert.deepEqual(summary(await r.reconcile()), [['unresolved', 'SETTLEMENT_FAILED']], 'a new generation is admitted');
    assert.equal(settlementOf(w, lone), undefined);
  });

  it('review #1: a namespace remapped to another file (a fresh or restored store elsewhere) is refused, never read as "no evidence"', async () => {
    const w = await world();
    const b = binding(NS_A);
    const pair = await consumedPair(w, b);
    await anchor(w, b, pair.authorityRef);
    const elsewhere = await openHistory(w.dir, NS_A, true, join(w.dir, 'a-restored.sqlite'));
    w.clock.advance(GRACE + 1);
    let generation = 1;
    let remapped = false;
    let flying = true;
    const inventory = () => ({ generation, histories: [remapped ? { store: elsewhere.store, namespace: NS_A, databasePath: elsewhere.path } : entryOf(w, NS_A)] });
    const r = reconciler(w, { inventory, inFlight: () => flying });
    assert.deepEqual(summary(await r.reconcile()), [['unresolved', 'IN_FLIGHT'], ['unresolved', 'IN_FLIGHT']]);
    flying = false;
    generation = 2;
    remapped = true;
    assert.deepEqual(summary(await r.reconcile()), [['unresolved', 'INVENTORY_HISTORY_MOVED'], ['unresolved', 'INVENTORY_HISTORY_MOVED']]);
    assert.equal(outcomeRows(w).length, 0, 'no false NO_BOOTSTRAP_EVIDENCE');
    generation = 3;
    remapped = false;
    assert.deepEqual(summary(await r.reconcile()), [['settled', 'bootstrap-committed'], ['settled', 'bootstrap-committed']]);
  });

  it('review #5: a progress port that never answers delays one run by its bound, and never stalls reconciliation', async () => {
    const w = await world();
    const valid = await loneRequester(w, binding(NS_A));
    w.clock.advance(GRACE + 1);
    const never = new Promise<never>(() => undefined);
    const started = Date.now();
    const entries = await reconciler(w, { progress: { load: () => never, save: () => never } }).reconcile();
    assert.deepEqual(of(entries, valid), [['settled', 'bootstrap-not-committed']]);
    assert.ok(Date.now() - started < 15_000);
  });

  it('34. the inventory changing between the absence read and the negative write leaves the decision unresolved', async () => {
    const w = await world();
    const lone = await loneRequester(w, binding(NS_A));
    w.clock.advance(GRACE + 1);
    let calls = 0;
    const inventory = () => {
      calls += 1;
      // The second read (just before the negative settlement) sees a reconfigured Host.
      return calls === 1 ? { generation: 1, histories: [entryOf(w, NS_A), entryOf(w, NS_B)] } : { generation: 2, histories: [entryOf(w, NS_B)] };
    };
    assert.deepEqual(summary(await reconciler(w, { inventory }).reconcile()), [['unresolved', 'INVENTORY_CHANGED']]);
    assert.equal(settlementOf(w, lone), undefined);
    // Same content under a newer generation is not a change.
    let n = 0;
    const bumped = () => ((n += 1), { generation: n, histories: [entryOf(w, NS_A)] });
    assert.deepEqual(summary(await reconciler(w, { inventory: bumped }).reconcile()), [['settled', 'bootstrap-not-committed']]);
  });

  it('25/32/26. a closed, unreadable or corrupt known history: unresolved, each with its own reason — never "no evidence"', async () => {
    const w = await world();
    const lone = await loneRequester(w, binding(NS_A));
    const b = binding(NS_B);
    const pair = await consumedPair(w, b);
    await anchor(w, b, pair.authorityRef);
    w.clock.advance(GRACE + 1);
    w.histories[NS_A]!.store.close();
    const closed = await reconciler(w, { histories: fixed(w) }).reconcile();
    assert.deepEqual(of(closed, lone), [['unresolved', 'HISTORY_UNAVAILABLE']]);
    // Review #3: only a decision's own history is read, so A being closed never blocks B's decisions.
    for (const c of [pair.requester, pair.approver]) assert.deepEqual(of(closed, c), [['settled', 'bootstrap-committed']]);
    w.histories[NS_A] = await openHistory(w.dir, NS_A, false, w.histories[NS_A]!.path);
    // A second pair in B, so B's corruption has something unsettled to hide.
    const b2 = binding(NS_B);
    const pair2 = await consumedPair(w, b2);
    await anchor(w, b2, pair2.authorityRef);
    w.clock.advance(GRACE + 1);
    // Corrupt the B evidence underneath the store (its permanence trigger dropped and restored).
    const db = new Database(w.histories[NS_B]!.path);
    db.exec('DROP TRIGGER sovereign_status_bootstrap_evidence_never_updated');
    db.prepare("UPDATE sovereign_status_bootstrap_evidence SET record = json_set(record, '$.next.statusDigest', ?) WHERE request_id = ?").run('d'.repeat(64), b2.binding.requestId);
    db.exec("CREATE TRIGGER sovereign_status_bootstrap_evidence_never_updated BEFORE UPDATE ON sovereign_status_bootstrap_evidence BEGIN SELECT RAISE(ABORT, 'bootstrap evidence is permanent'); END;");
    db.close();
    const corrupt = await reconciler(w).reconcile();
    for (const c of [pair2.requester, pair2.approver]) assert.deepEqual(of(corrupt, c), [['unresolved', 'HISTORY_CORRUPT']]);
    for (const c of [pair2.requester, pair2.approver]) assert.equal(settlementOf(w, c), undefined);
    // The lone decision's own history (A) is readable again and answers for its binding: its absence is believed.
    assert.deepEqual(of(corrupt, lone), [['settled', 'bootstrap-not-committed']]);
    assert.equal(outcomeRows(w).length, 3);
  });

  it('33. LIMITATION: a whole-file rollback of the decision’s own history is not detected here (FV-P4D) — it yields a false FAILURE, never a false success', async () => {
    const w = await world();
    const b = binding(NS_A);
    const backup = join(w.dir, 'pre-commit-backup.sqlite');
    backupOf(w.histories[NS_A]!.path, backup);
    const pair = await consumedPair(w, b);
    await anchor(w, b, pair.authorityRef);
    // The receiver's history file is replaced by its pre-commit copy, reopened at the configured path.
    w.histories[NS_A]!.store.close();
    copyFileSync(backup, w.histories[NS_A]!.path);
    for (const suffix of ['-wal', '-shm']) rmSync(`${w.histories[NS_A]!.path}${suffix}`, { force: true });
    w.histories[NS_A] = await openHistory(w.dir, NS_A, false, w.histories[NS_A]!.path);
    w.clock.advance(GRACE + 1);
    const entries = await reconciler(w).reconcile();
    // Documented, not defended: provenance proves origin, not currentness.
    assert.deepEqual(of(entries, pair.requester), [['settled', 'bootstrap-not-committed']]);
    for (const c of [pair.requester, pair.approver]) assert.notEqual(settlementOf(w, c)?.outcome, 'bootstrap-committed');
  });
});
