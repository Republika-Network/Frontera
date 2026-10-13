import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createPrivateKey, randomBytes, sign } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';

import {
  AUTHORITY_STATE_CHECKPOINT_FORMAT,
  AUTHORITY_STATE_KINDS,
  AUTHORITY_STATE_NAMESPACED_CHECKPOINT_FORMAT,
  AUTHORITY_STATE_WITNESS_PROTOCOL,
  AUTHORITY_STATE_WITNESS_PROTOCOL_V1,
  AuthorityStateFreshnessError,
  NAMESPACED_AUTHORITY_STATE_KINDS,
  authorityStateBindingProblem,
  createAuthorityStateFreshnessBoundary,
  createHttpAuthorityStateWitnessTransport,
  isAuthorityStateNamespace,
  parseWitnessRequest,
  parseWitnessResponse,
  serializeAuthorityStateCheckpoint,
  witnessReceiptSigningBytes,
  type AuthorityStateCheckpoint,
  type AuthorityStateFreshnessErrorCode,
  type AuthorityStateKind,
} from '../authority-state-freshness/index.js';
import { createReferenceAuthorityStateWitness, rescopeLegacyAuthorityStateBinding } from '../authority-state-freshness/reference/reference-witness-service.js';
import { testRailConfiguration as lightningConfiguration } from '../../features/payment-runtime/rails/lightning/tests/lightning-test-fixtures.js';
import { createSqliteLightningPaymentInterlock } from '../lightning-payment-rail/sqlite-lightning-payment-interlock.js';
import { ScriptedWitnessTransport, WITNESS_ID, WITNESS_TOKEN, boundaryFor, closeAllWitnesses, connect, startWitness, witnessKey, witnessRows } from './core07-freshness-fixture.js';

/**
 * CORE-07 — namespaced slots (PAY-09 multi-rail hardening).
 *
 * A namespaced state kind gives one organization several independent
 * histories of that kind, each in its own witness slot; every other kind keeps
 * its single per-organization slot exactly as before. This suite proves the
 * generic model — and that nothing about the old slots changed:
 *
 * - NS-*      the namespace grammar and the closed per-kind rule;
 * - LEGACY-*  every un-namespaced consumer resolves to the exact same slot,
 *             canonical bytes and witnessed state as under v1;
 * - SCOPE-*   one namespace can never answer, replace, poison or alias another;
 * - MIG-*     the reference witness's v1 → v2 database migration;
 * - RESCOPE-* the explicit operator move of a legacy binding into a namespace.
 */

const made: string[] = [];
after(async () => {
  await closeAllWitnesses();
  for (const directory of made) rmSync(directory, { recursive: true, force: true });
});
const tempDir = (prefix: string): string => {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  made.push(directory);
  return directory;
};

const ORG = 'org-core07-ns';
const KIND = 'payment-initiation-reservations' as const;
const digestOf = (n: number): string => `sha256:${n.toString(16).padStart(64, '0')}`;
const scoped = (namespace: string, sequence: number, overrides: Partial<AuthorityStateCheckpoint> = {}): AuthorityStateCheckpoint => ({
  stateKind: KIND,
  organizationId: ORG,
  namespace,
  storeId: `store-${namespace}`,
  sequence,
  stateDigest: digestOf(sequence + 1),
  ...overrides,
});
const legacy = (stateKind: AuthorityStateKind, sequence: number, overrides: Partial<AuthorityStateCheckpoint> = {}): AuthorityStateCheckpoint => ({
  stateKind,
  organizationId: ORG,
  storeId: `store-${stateKind}`,
  sequence,
  stateDigest: digestOf(sequence + 100),
  ...overrides,
});

function refusedWith(code: AuthorityStateFreshnessErrorCode) {
  return (error: unknown): true => {
    assert.ok(error instanceof AuthorityStateFreshnessError, `expected an AuthorityStateFreshnessError, got ${String(error)}`);
    assert.equal(error.code, code, error.message);
    return true;
  };
}

const UN_NAMESPACED_KINDS = AUTHORITY_STATE_KINDS.filter((kind) => !(NAMESPACED_AUTHORITY_STATE_KINDS as readonly string[]).includes(kind));

describe('CORE-07 namespaces — the grammar and the closed per-kind rule (NS-1 … NS-3)', () => {
  it('NS-1 a namespace is a bounded canonical lowercase token: no path, URL, dot, colon, underscore, space, upper case or empty value; never trimmed or folded', () => {
    for (const ok of ['lightning-btc', 'stripe-usd', 'xrpl-rlusd', 'a', 'a1-b2-c3', 'x'.repeat(64)]) assert.equal(isAuthorityStateNamespace(ok), true, ok);
    for (const bad of ['', 'Stripe-usd', 'STRIPE', 'stripe_usd', 'stripe.usd', 'rail:stripe', 'a/b', 'https://witness', ' stripe', 'stripe ', '-stripe', 'stripe-', 'stripe--usd', '1stripe', 'x'.repeat(65), 'strípe', 'stripe\n', null, undefined, 7, {}]) {
      assert.equal(isAuthorityStateNamespace(bad), false, JSON.stringify(bad));
    }
  });

  it('NS-2 the namespaced kinds are closed — exactly payment-initiation-reservations — and every such binding must name its namespace', () => {
    assert.deepEqual([...NAMESPACED_AUTHORITY_STATE_KINDS], ['payment-initiation-reservations']);
    assert.match(authorityStateBindingProblem({ stateKind: KIND, organizationId: ORG }) ?? '', /without its namespace/);
    assert.match(authorityStateBindingProblem({ stateKind: KIND, organizationId: ORG, namespace: 'Stripe' }) ?? '', /not a bounded canonical token/);
    assert.equal(authorityStateBindingProblem({ stateKind: KIND, organizationId: ORG, namespace: 'stripe-usd' }), undefined);
  });

  it('NS-3 / LEGACY-4 no namespace can be attached to any other kind — revocation, discharge, approval, XRPL, business-operation and refund slots stay single per organization', () => {
    assert.deepEqual(UN_NAMESPACED_KINDS, ['bounded-grant-revocation-state', 'obligation-discharge-state', 'approval-state', 'xrpl-submission-reservations', 'payment-business-operation-state', 'payment-refund-state']);
    for (const stateKind of UN_NAMESPACED_KINDS) {
      assert.equal(authorityStateBindingProblem({ stateKind, organizationId: ORG }), undefined, stateKind);
      assert.match(authorityStateBindingProblem({ stateKind, organizationId: ORG, namespace: 'stripe-usd' }) ?? '', /state kind that has none/, stateKind);
    }
  });
});

describe('CORE-07 namespaces — legacy consumers are byte-for-byte unchanged (LEGACY-1, LEGACY-2)', () => {
  it('LEGACY-1 an un-namespaced checkpoint serializes exactly as v1; a namespaced one only under v2, with the namespace inside the bytes', () => {
    const old = legacy('bounded-grant-revocation-state', 3);
    assert.equal(
      serializeAuthorityStateCheckpoint(old),
      `{"format":"${AUTHORITY_STATE_CHECKPOINT_FORMAT}","organizationId":"${ORG}","sequence":3,"stateDigest":"${digestOf(103)}","stateKind":"bounded-grant-revocation-state","storeId":"store-bounded-grant-revocation-state"}`,
    );
    assert.equal(AUTHORITY_STATE_CHECKPOINT_FORMAT, 'frontera.authority-state-checkpoint.v1');
    const a = serializeAuthorityStateCheckpoint(scoped('rail-a', 3));
    assert.ok(a.startsWith(`{"format":"${AUTHORITY_STATE_NAMESPACED_CHECKPOINT_FORMAT}","namespace":"rail-a",`), a);
    assert.notEqual(a, serializeAuthorityStateCheckpoint(scoped('rail-b', 3, { storeId: 'store-rail-a' })), 'the namespace alone changes the checkpoint');
  });

  it('LEGACY-1 every un-namespaced kind still resolves to its one slot at the witness, unchanged by namespaced slots of the same organization', async () => {
    const witness = await startWitness();
    const { anchor } = await connect(witness);
    for (const kind of UN_NAMESPACED_KINDS) assert.equal((await anchor.enroll('genesis', legacy(kind, 0))).outcome, 'enrolled', kind);
    assert.equal((await anchor.enroll('genesis', scoped('rail-a', 0))).outcome, 'enrolled');
    assert.equal((await anchor.enroll('genesis', scoped('rail-b', 0))).outcome, 'enrolled');
    for (const kind of UN_NAMESPACED_KINDS) {
      assert.deepEqual(await anchor.read({ stateKind: kind, organizationId: ORG }), { status: 'bound', storeId: `store-${kind}`, committed: { sequence: 0, stateDigest: digestOf(100) } }, kind);
    }
    const rows = await witnessRows(witness.databasePath);
    for (const row of rows) assert.equal(row['namespace'], (NAMESPACED_AUTHORITY_STATE_KINDS as readonly unknown[]).includes(row['state_kind']) ? String(row['store_id']).slice('store-'.length) : '', String(row['state_kind']));
  });

  it('LEGACY-2 a legacy binding can never be reinterpreted under a namespace, and a namespaced kind never under the legacy slot — refused by the client, the parser and the witness alike', async () => {
    const challenge = randomBytes(32).toString('hex');
    const read = (binding: Record<string, unknown>) => parseWitnessRequest('read', { protocol: AUTHORITY_STATE_WITNESS_PROTOCOL, challenge, binding });
    assert.ok(read({ stateKind: 'approval-state', organizationId: ORG }));
    assert.equal(read({ stateKind: 'approval-state', organizationId: ORG, namespace: 'rail-a' }), undefined, 'a namespace on an un-namespaced kind');
    assert.equal(read({ stateKind: KIND, organizationId: ORG }), undefined, 'a namespaced kind without its namespace');
    assert.equal(read({ stateKind: KIND, organizationId: ORG, namespace: '' }), undefined, 'the empty (legacy storage) namespace is never a request');
    assert.equal(read({ stateKind: KIND, organizationId: ORG, namespace: 'Rail-A' }), undefined, 'never case-folded');
    assert.equal(read({ stateKind: KIND, organizationId: ORG, namespace: null }), undefined);
    const witness = await startWitness();
    const { anchor } = await connect(witness);
    await assert.rejects(() => anchor.read({ stateKind: 'approval-state', organizationId: ORG, namespace: 'rail-a' }), refusedWith('AUTHORITY_FRESHNESS_CONFIGURATION_INVALID'));
    await assert.rejects(() => anchor.read({ stateKind: KIND, organizationId: ORG }), refusedWith('AUTHORITY_FRESHNESS_CONFIGURATION_INVALID'));
    await assert.rejects(() => anchor.enroll('genesis', { ...legacy('approval-state', 0), namespace: 'rail-a' }), refusedWith('AUTHORITY_FRESHNESS_CONFIGURATION_INVALID'));
    await assert.rejects(() => anchor.enroll('genesis', legacy(KIND, 0)), refusedWith('AUTHORITY_FRESHNESS_CONFIGURATION_INVALID'));
    // And the raw witness, bypassing the client: the same refusal (HTTP 422), nothing written.
    const raw = createHttpAuthorityStateWitnessTransport({ endpoint: witness.endpoint, credential: WITNESS_TOKEN });
    await assert.rejects(() => raw.call({ operation: 'enroll', challenge, enrollment: 'genesis', checkpoint: legacy(KIND, 0) }, { timeoutMs: 2_000 }), refusedWith('AUTHORITY_FRESHNESS_REFUSED'));
    assert.deepEqual(await witnessRows(witness.databasePath), []);
  });
});

describe('CORE-07 namespaces — one namespace never answers, replaces, poisons or aliases another (SCOPE-1 … SCOPE-6)', () => {
  it('SCOPE-1 two namespaces of one kind and organization are independent slots: each enrolls, prepares and finalizes on its own; a store presented in the other namespace is a conflict', async () => {
    const witness = await startWitness();
    const { anchor } = await connect(witness);
    assert.equal((await anchor.enroll('genesis', scoped('rail-a', 0))).outcome, 'enrolled');
    assert.equal((await anchor.enroll('genesis', scoped('rail-b', 0))).outcome, 'enrolled');
    assert.equal((await anchor.prepare(scoped('rail-a', 0), scoped('rail-a', 1))).outcome, 'prepared');
    assert.equal((await anchor.finalize(scoped('rail-a', 1))).outcome, 'finalized');
    assert.deepEqual(await anchor.read({ stateKind: KIND, organizationId: ORG, namespace: 'rail-b' }), { status: 'bound', storeId: 'store-rail-b', committed: { sequence: 0, stateDigest: digestOf(1) } }, 'B untouched by A advancing');
    // Store substitution across namespaces: A's store, in B's namespace — never a rebind.
    assert.equal((await anchor.enroll('baseline', scoped('rail-b', 1, { storeId: 'store-rail-a' }))).outcome, 'conflict');
    assert.equal((await anchor.prepare(scoped('rail-b', 0, { storeId: 'store-rail-a' }), scoped('rail-b', 1, { storeId: 'store-rail-a' }))).outcome, 'conflict');
    assert.equal((await anchor.finalize(scoped('rail-b', 1, { storeId: 'store-rail-a' }))).outcome, 'conflict');
    // A transition can never move between namespaces.
    const challenge = randomBytes(32).toString('hex');
    assert.equal(parseWitnessRequest('prepare', { protocol: AUTHORITY_STATE_WITNESS_PROTOCOL, challenge, expected: scoped('rail-a', 1), proposed: scoped('rail-b', 2, { storeId: 'store-rail-a' }) }), undefined, 'namespace switch');
  });

  it('SCOPE-2 (C4) an authentic receipt about namespace A never answers a question about namespace B — forwarded as-is it is a binding mismatch; relabelled, its signature no longer verifies', async () => {
    const witness = await startWitness();
    const inner = createHttpAuthorityStateWitnessTransport({ endpoint: witness.endpoint, credential: WITNESS_TOKEN });
    const transport = new ScriptedWitnessTransport(inner);
    const { anchor } = await connect(witness, { transport });
    await anchor.enroll('genesis', scoped('rail-a', 0));
    const askA = (request: Parameters<typeof inner.call>[0]) => inner.call(request.operation === 'read' ? { ...request, binding: { ...request.binding, namespace: 'rail-a' } } : request, { timeoutMs: 2_000 });
    transport.answer = (request, forward) => (request.operation === 'read' ? askA(request) : forward());
    await assert.rejects(() => anchor.read({ stateKind: KIND, organizationId: ORG, namespace: 'rail-b' }), refusedWith('AUTHORITY_FRESHNESS_BINDING_MISMATCH'));
    // A relay that also rewrites the namespace inside the receipt: the namespace is in the signed bytes.
    transport.answer = async (request, forward) => {
      if (request.operation !== 'read') return forward();
      const genuine = parseWitnessResponse(await askA(request));
      assert.ok(genuine !== undefined);
      return { receipt: { ...genuine.receipt, binding: { ...genuine.receipt.binding, namespace: 'rail-b' } }, signature: genuine.signature };
    };
    await assert.rejects(() => anchor.read({ stateKind: KIND, organizationId: ORG, namespace: 'rail-b' }), refusedWith('AUTHORITY_FRESHNESS_WITNESS_UNAUTHENTIC'));
  });

  it('SCOPE-3 the namespace is inside the signed receipt bytes: two receipts differing only in namespace sign different bytes', () => {
    const key = witnessKey();
    const receipt = (namespace: string) =>
      ({ protocol: AUTHORITY_STATE_WITNESS_PROTOCOL, witnessId: WITNESS_ID, operation: 'read', challenge: 'ab'.repeat(32), outcome: 'current', binding: { stateKind: KIND, organizationId: ORG, namespace }, state: { status: 'unbound' } }) as const;
    const a = witnessReceiptSigningBytes(receipt('rail-a'));
    const b = witnessReceiptSigningBytes(receipt('rail-b'));
    assert.notDeepEqual(a, b);
    assert.ok(a.toString('utf8').includes('"namespace":"rail-a"'));
    assert.notDeepEqual(sign(null, a, createPrivateKey(key.privateKeyPem)), sign(null, b, createPrivateKey(key.privateKeyPem)));
  });

  it('SCOPE-4 (C9) a pending transition in one namespace refuses only that namespace: the other establishes, transitions and finalizes normally', async () => {
    const witness = await startWitness();
    const { anchor, monitor } = await connect(witness);
    await anchor.enroll('genesis', scoped('rail-a', 0));
    await anchor.enroll('genesis', scoped('rail-b', 0));
    // A's transition was prepared at the witness and its local commit never happened (a crash).
    assert.equal((await anchor.prepare(scoped('rail-a', 0), scoped('rail-a', 1))).outcome, 'prepared');
    const boundary = createAuthorityStateFreshnessBoundary({ anchor, monitor, organizationId: ORG });
    await assert.rejects(() => boundary.establish(scoped('rail-a', 0), () => scoped('rail-a', 0)), refusedWith('AUTHORITY_FRESHNESS_PENDING_RECOVERY'));
    let localB = scoped('rail-b', 0);
    const session = await boundary.establish(localB, () => localB);
    await session.transition(scoped('rail-b', 0), scoped('rail-b', 1), () => {
      localB = scoped('rail-b', 1);
      return { value: undefined, state: localB };
    });
    assert.deepEqual(session.status(), { stateKind: KIND, namespace: 'rail-b', status: 'ready', sequence: 1 });
    assert.deepEqual(await anchor.read({ stateKind: KIND, organizationId: ORG, namespace: 'rail-a' }), { status: 'bound', storeId: 'store-rail-a', committed: { sequence: 0, stateDigest: digestOf(1) }, pending: { sequence: 1, stateDigest: digestOf(2) } }, "B's transition never touched A's pending state");
  });

  it('SCOPE-5 a rollback and a fork in one namespace refuse only that namespace; the other stays established', async () => {
    const witness = await startWitness();
    const { anchor, monitor } = await connect(witness);
    for (const ns of ['rail-a', 'rail-b', 'rail-c']) await anchor.enroll('genesis', scoped(ns, 0));
    for (const ns of ['rail-a', 'rail-b']) {
      await anchor.prepare(scoped(ns, 0), scoped(ns, 1));
      await anchor.finalize(scoped(ns, 1));
    }
    const boundary = createAuthorityStateFreshnessBoundary({ anchor, monitor, organizationId: ORG });
    await assert.rejects(() => boundary.establish(scoped('rail-a', 0), () => scoped('rail-a', 0)), refusedWith('AUTHORITY_FRESHNESS_ROLLBACK_DETECTED'));
    const fork = scoped('rail-b', 1, { stateDigest: digestOf(999) });
    await assert.rejects(() => boundary.establish(fork, () => fork), refusedWith('AUTHORITY_FRESHNESS_FORK_DETECTED'));
    const session = await boundary.establish(scoped('rail-c', 0), () => scoped('rail-c', 0));
    assert.equal(session.status().status, 'ready');
    const probe = await boundary.probe();
    assert.deepEqual(probe.stores, [{ stateKind: KIND, namespace: 'rail-c', status: 'ready', sequence: 0 }]);
  });

  it('SCOPE-6 (C6) the legacy storage key of an un-namespaced slot can never alias a namespace: SQL refuses a malformed namespace, and the empty key is unreachable from the protocol', async () => {
    const witness = await startWitness();
    const { anchor } = await connect(witness);
    await anchor.enroll('genesis', legacy('approval-state', 0));
    await anchor.enroll('genesis', scoped('rail-a', 0));
    const db = new Database(witness.databasePath);
    try {
      const insert = db.prepare('INSERT INTO witness_bindings_v2 (state_kind, organization_id, namespace, store_id, committed_sequence, committed_digest, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?)');
      for (const bad of ['Rail', 'a.b', 'a/b', '-a', 'x'.repeat(65)]) assert.throws(() => insert.run(KIND, ORG, bad, 'store-x', digestOf(1), 'now'), /CHECK/, bad);
    } finally {
      db.close();
    }
    assert.deepEqual(
      (await witnessRows(witness.databasePath)).map((row) => [row['state_kind'], row['namespace']]),
      [
        ['approval-state', ''],
        [KIND, 'rail-a'],
      ],
    );
  });
});

/** The exact v1 schema of the reference witness (main @ 919c175), to build a database as v1 left it. */
const V1_SCHEMA = `
  CREATE TABLE IF NOT EXISTS witness_meta (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    witness_id TEXT NOT NULL,
    protocol TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS witness_bindings (
    state_kind TEXT NOT NULL,
    organization_id TEXT NOT NULL,
    store_id TEXT NOT NULL,
    committed_sequence INTEGER NOT NULL CHECK (committed_sequence >= 0),
    committed_digest TEXT NOT NULL,
    pending_sequence INTEGER,
    pending_digest TEXT,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (state_kind, organization_id),
    CHECK ((pending_sequence IS NULL) = (pending_digest IS NULL)),
    CHECK (pending_sequence IS NULL OR pending_sequence = committed_sequence + 1)
  );
  CREATE TABLE IF NOT EXISTS witness_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    state_kind TEXT NOT NULL,
    organization_id TEXT NOT NULL,
    store_id TEXT NOT NULL,
    event TEXT NOT NULL CHECK (event IN ('enrolled-genesis', 'enrolled-baseline', 'prepared', 'finalized')),
    sequence INTEGER NOT NULL,
    state_digest TEXT NOT NULL,
    recorded_at TEXT NOT NULL
  );
  CREATE TRIGGER IF NOT EXISTS witness_bindings_no_delete BEFORE DELETE ON witness_bindings
    BEGIN SELECT RAISE(ABORT, 'a witness binding is never deleted'); END;
  CREATE TRIGGER IF NOT EXISTS witness_bindings_store_fixed BEFORE UPDATE ON witness_bindings
    WHEN NEW.store_id IS NOT OLD.store_id OR NEW.committed_sequence < OLD.committed_sequence
    BEGIN SELECT RAISE(ABORT, 'a witness binding never changes store and never moves backwards'); END;
  CREATE TRIGGER IF NOT EXISTS witness_history_no_update BEFORE UPDATE ON witness_history
    BEGIN SELECT RAISE(ABORT, 'witness history is append-only'); END;
  CREATE TRIGGER IF NOT EXISTS witness_history_no_delete BEFORE DELETE ON witness_history
    BEGIN SELECT RAISE(ABORT, 'witness history is append-only'); END;
`;

interface V1Row {
  readonly kind: AuthorityStateKind;
  readonly organizationId?: string;
  readonly storeId: string;
  readonly sequence: number;
  readonly digest: string;
  readonly pending?: { readonly sequence: number; readonly digest: string };
}

/** A witness database exactly as the v1 reference witness leaves it: v1 tables, v1 meta, v1 rows and history. */
function writeV1Database(directory: string, rows: readonly V1Row[], options: { readonly witnessId?: string; readonly protocol?: string; readonly extraSql?: string } = {}): string {
  const path = join(directory, 'witness.sqlite');
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.exec(V1_SCHEMA);
  db.prepare('INSERT INTO witness_meta (id, witness_id, protocol) VALUES (1, ?, ?)').run(options.witnessId ?? WITNESS_ID, options.protocol ?? AUTHORITY_STATE_WITNESS_PROTOCOL_V1);
  const insert = db.prepare('INSERT INTO witness_bindings (state_kind, organization_id, store_id, committed_sequence, committed_digest, pending_sequence, pending_digest, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  const history = db.prepare('INSERT INTO witness_history (state_kind, organization_id, store_id, event, sequence, state_digest, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
  for (const row of rows) {
    insert.run(row.kind, row.organizationId ?? ORG, row.storeId, row.sequence, row.digest, row.pending?.sequence ?? null, row.pending?.digest ?? null, '2026-10-01T00:00:00.000Z');
    history.run(row.kind, row.organizationId ?? ORG, row.storeId, 'enrolled-genesis', 0, digestOf(0), '2026-10-01T00:00:00.000Z');
  }
  if (options.extraSql !== undefined) db.exec(options.extraSql);
  db.close();
  return path;
}

const V1_ROWS: readonly V1Row[] = [
  { kind: 'bounded-grant-revocation-state', storeId: 'grants-1', sequence: 7, digest: digestOf(7) },
  { kind: 'approval-state', storeId: 'approval-store:1', sequence: 3, digest: digestOf(3), pending: { sequence: 4, digest: digestOf(4) } },
  { kind: 'obligation-discharge-state', storeId: 'obligation-discharge-store:1', sequence: 2, digest: digestOf(2) },
  { kind: 'xrpl-submission-reservations', storeId: 'xrpl-submission-interlock:1', sequence: 5, digest: digestOf(5) },
  { kind: KIND, storeId: 'lightning-payment-interlock:legacy', sequence: 9, digest: digestOf(9) },
  { kind: 'approval-state', organizationId: 'org-other', storeId: 'approval-store:2', sequence: 1, digest: digestOf(11) },
];

describe('CORE-07 namespaces — the reference witness migrates a v1 database in place (MIG-1 … MIG-4)', () => {
  it('MIG-1 / LEGACY-3 every v1 binding is carried into v2 with the exact store id, committed and pending sequence and digest; the v1 table keeps every row, frozen; the history keeps every event; the migration is recorded once', async () => {
    const directory = tempDir('frontera-core07-mig-');
    const path = writeV1Database(directory, V1_ROWS);
    const key = witnessKey();
    const witness = await startWitness({ directory, key });
    const db = new Database(path);
    try {
      assert.equal((db.prepare('SELECT protocol FROM witness_meta').get() as { protocol: string }).protocol, AUTHORITY_STATE_WITNESS_PROTOCOL);
      const v2 = db.prepare(`SELECT state_kind, organization_id, namespace, store_id, committed_sequence, committed_digest, pending_sequence, pending_digest FROM witness_bindings_v2 ORDER BY state_kind, organization_id`).all() as Record<string, unknown>[];
      const expected = [...V1_ROWS]
        .map((row) => ({ state_kind: row.kind, organization_id: row.organizationId ?? ORG, namespace: '', store_id: row.storeId, committed_sequence: row.sequence, committed_digest: row.digest, pending_sequence: row.pending?.sequence ?? null, pending_digest: row.pending?.digest ?? null }))
        .sort((a, b) => (a.state_kind === b.state_kind ? a.organization_id.localeCompare(b.organization_id) : a.state_kind.localeCompare(b.state_kind)));
      assert.deepEqual(v2, expected);
      assert.equal((db.prepare('SELECT COUNT(*) AS n FROM witness_bindings').get() as { n: number }).n, V1_ROWS.length, 'no v1 row was dropped');
      assert.throws(() => db.prepare(`INSERT INTO witness_bindings (state_kind, organization_id, store_id, committed_sequence, committed_digest, updated_at) VALUES ('approval-state', 'org-new', 's', 0, ?, 'now')`).run(digestOf(0)), /frozen/);
      assert.throws(() => db.prepare('UPDATE witness_bindings SET updated_at = updated_at').run(), /frozen/);
      assert.deepEqual(db.prepare('SELECT DISTINCT namespace FROM witness_history').all(), [{ namespace: '' }]);
      assert.equal((db.prepare('SELECT COUNT(*) AS n FROM witness_history').get() as { n: number }).n, V1_ROWS.length);
      assert.deepEqual(db.prepare('SELECT from_protocol, to_protocol, bindings FROM witness_migrations').all(), [{ from_protocol: AUTHORITY_STATE_WITNESS_PROTOCOL_V1, to_protocol: AUTHORITY_STATE_WITNESS_PROTOCOL, bindings: V1_ROWS.length }]);
    } finally {
      db.close();
    }
    // The migrated slots answer exactly what v1 held, pending included.
    const { anchor } = await connect(witness);
    assert.deepEqual(await anchor.read({ stateKind: 'approval-state', organizationId: ORG }), { status: 'bound', storeId: 'approval-store:1', committed: { sequence: 3, stateDigest: digestOf(3) }, pending: { sequence: 4, stateDigest: digestOf(4) } });
    assert.deepEqual(await anchor.read({ stateKind: 'bounded-grant-revocation-state', organizationId: ORG }), { status: 'bound', storeId: 'grants-1', committed: { sequence: 7, stateDigest: digestOf(7) } });
    assert.equal((await anchor.prepare(legacy('bounded-grant-revocation-state', 7, { storeId: 'grants-1', stateDigest: digestOf(7) }), legacy('bounded-grant-revocation-state', 8, { storeId: 'grants-1', stateDigest: digestOf(8) }))).outcome, 'prepared', 'a migrated slot keeps advancing');
    // MIG-2 / LEGACY-2 / C7: the legacy payment-initiation row is NOT any namespace.
    for (const namespace of ['lightning-btc', 'stripe-usd']) assert.deepEqual(await anchor.read({ stateKind: KIND, organizationId: ORG, namespace }), { status: 'unbound' }, namespace);
    // Restarting does not migrate twice.
    const again = await witness.restart();
    const db2 = new Database(again.databasePath, { readonly: true });
    assert.equal((db2.prepare('SELECT COUNT(*) AS n FROM witness_migrations').get() as { n: number }).n, 1);
    db2.close();
  });

  it('MIG-3 the migration is atomic: a failure at its last step leaves the v1 database exactly as it was, and the witness refuses to serve', async () => {
    const directory = tempDir('frontera-core07-mig-atomic-');
    // A pre-existing, incompatible witness_migrations table: the migration's final INSERT fails after every other step ran.
    const path = writeV1Database(directory, V1_ROWS, { extraSql: 'CREATE TABLE witness_migrations (id INTEGER PRIMARY KEY);' });
    const witnessDb = (() => new Database(path, { readonly: true }))();
    const before = { tables: witnessDb.prepare(`SELECT name FROM sqlite_master WHERE type IN ('table', 'trigger') ORDER BY name`).all(), rows: witnessDb.prepare('SELECT * FROM witness_bindings ORDER BY state_kind, organization_id').all() };
    witnessDb.close();
    const key = witnessKey();
    await assert.rejects(() => createReferenceAuthorityStateWitness({ witnessId: WITNESS_ID, privateKeyPem: key.privateKeyPem, credential: WITNESS_TOKEN, databasePath: path }));
    const after = new Database(path, { readonly: true });
    try {
      assert.deepEqual(after.prepare(`SELECT name FROM sqlite_master WHERE type IN ('table', 'trigger') ORDER BY name`).all(), before.tables, 'no v2 table, trigger or column survived');
      assert.deepEqual(after.prepare('SELECT * FROM witness_bindings ORDER BY state_kind, organization_id').all(), before.rows);
      assert.equal((after.prepare('SELECT protocol FROM witness_meta').get() as { protocol: string }).protocol, AUTHORITY_STATE_WITNESS_PROTOCOL_V1);
      assert.equal((after.prepare(`SELECT COUNT(*) AS n FROM pragma_table_info('witness_history') WHERE name = 'namespace'`).get() as { n: number }).n, 0);
    } finally {
      after.close();
    }
  });

  it('MIG-4 version refusal: another witness, an unknown protocol, witness tables with no record of whose — each refused, nothing changed', async () => {
    const key = witnessKey();
    const open = (path: string) => createReferenceAuthorityStateWitness({ witnessId: WITNESS_ID, privateKeyPem: key.privateKeyPem, credential: WITNESS_TOKEN, databasePath: path });
    await assert.rejects(() => open(writeV1Database(tempDir('frontera-core07-mig-other-'), V1_ROWS, { witnessId: 'another-witness' })), /another witness/);
    await assert.rejects(() => open(writeV1Database(tempDir('frontera-core07-mig-v9-'), V1_ROWS, { protocol: 'frontera.authority-state-witness.v9' })), /protocol this witness does not implement/);
    const orphan = writeV1Database(tempDir('frontera-core07-mig-orphan-'), V1_ROWS, { extraSql: 'DELETE FROM witness_meta;' });
    await assert.rejects(() => open(orphan), /no record of whose/);
  });
});

describe('CORE-07 namespaces — the explicit operator rescope of a legacy binding (RESCOPE-1 … RESCOPE-3)', () => {
  it('RESCOPE-1 a Lightning interlock anchored under the v1 slot is never adopted silently — refused until the operator rescopes it; then it opens at the same witnessed head and keeps rollback detection', async () => {
    const configuration = lightningConfiguration();
    const scope = { railId: configuration.railId, network: configuration.network } as const;
    const now = (): string => new Date().toISOString();
    const stores = tempDir('frontera-core07-rescope-stores-');
    const interlockPath = join(stores, 'lightning.sqlite');
    // 1. A Lightning interlock exists, anchored at some witness; its witnessed head is what a v1 witness would hold, un-namespaced.
    const original = await startWitness();
    await (await createSqliteLightningPaymentInterlock(interlockPath, { scope, now, freshness: { boundary: await boundaryFor(original, ORG) } })).close();
    const [row] = await witnessRows(original.databasePath);
    assert.ok(row !== undefined);
    const storeId = String(row['store_id']);
    // 2. The v1 witness of the legacy deployment holds that head in the un-namespaced slot.
    const directory = tempDir('frontera-core07-rescope-witness-');
    writeV1Database(directory, [{ kind: KIND, storeId, sequence: Number(row['committed_sequence']), digest: String(row['committed_digest']) }]);
    const key = witnessKey();
    let witness = await startWitness({ directory, key });
    // 3. Upgraded, the interlock is refused: its namespaced slot is unbound, and the legacy slot is never read as it.
    await assert.rejects(createSqliteLightningPaymentInterlock(interlockPath, { scope, now, freshness: { boundary: await boundaryFor(witness, ORG) } }), refusedWith('AUTHORITY_FRESHNESS_UNBOUND_STORE'));
    await witness.close();
    // 4. The operator rescopes — stating the exact store. A wrong store, a missing attestation or a non-namespaced kind is refused.
    const operator = { operatorId: 'ops-1', attestation: 'legacy-binding-belongs-to-namespace' } as const;
    const base = { witnessId: WITNESS_ID, stateKind: KIND, organizationId: ORG, storeId, namespace: configuration.railId, operator } as const;
    await assert.rejects(() => rescopeLegacyAuthorityStateBinding(witness.databasePath, { ...base, storeId: 'stripe-payment-interlock:other' }), /another store/);
    await assert.rejects(() => rescopeLegacyAuthorityStateBinding(witness.databasePath, { ...base, operator: { operatorId: 'ops-1' } as never }), /attestation/);
    await assert.rejects(() => rescopeLegacyAuthorityStateBinding(witness.databasePath, { ...base, stateKind: 'approval-state' }), /namespaced state kind/);
    await assert.rejects(() => rescopeLegacyAuthorityStateBinding(witness.databasePath, { ...base, namespace: 'Lightning' }), /well-formed namespaced slot/);
    assert.deepEqual(await rescopeLegacyAuthorityStateBinding(witness.databasePath, base), { sequence: Number(row['committed_sequence']), stateDigest: String(row['committed_digest']) });
    // RESCOPE-2: never twice, never into a second namespace.
    await assert.rejects(() => rescopeLegacyAuthorityStateBinding(witness.databasePath, base), /already bound/);
    await assert.rejects(() => rescopeLegacyAuthorityStateBinding(witness.databasePath, { ...base, namespace: 'lightning-btc-second' }), /UNIQUE/);
    // 5. Reopened: the same store, at the same witnessed head, in its own namespace — the legacy row kept, unaddressable.
    witness = await witness.restart();
    const reopened = await createSqliteLightningPaymentInterlock(interlockPath, { scope, now, freshness: { boundary: await boundaryFor(witness, ORG) } });
    assert.equal((await reopened.health()).status, 'healthy');
    await reopened.close();
    assert.deepEqual(
      (await witnessRows(witness.databasePath)).map((entry) => [entry['namespace'], entry['store_id'], entry['committed_sequence'], entry['committed_digest']]),
      [
        ['', storeId, row['committed_sequence'], row['committed_digest']],
        [configuration.railId, storeId, row['committed_sequence'], row['committed_digest']],
      ],
    );
  });

  it('RESCOPE-3 a legacy binding holding a pending transition is never rescoped — the ambiguity is resolved first', async () => {
    const directory = tempDir('frontera-core07-rescope-pending-');
    writeV1Database(directory, [{ kind: KIND, storeId: 'lightning-payment-interlock:p', sequence: 2, digest: digestOf(2), pending: { sequence: 3, digest: digestOf(3) } }]);
    const witness = await startWitness({ directory, key: witnessKey() });
    await witness.close();
    await assert.rejects(
      () => rescopeLegacyAuthorityStateBinding(witness.databasePath, { witnessId: WITNESS_ID, stateKind: KIND, organizationId: ORG, storeId: 'lightning-payment-interlock:p', namespace: 'lightning-btc', operator: { operatorId: 'ops-1', attestation: 'legacy-binding-belongs-to-namespace' } }),
      /pending transition/,
    );
  });
});
