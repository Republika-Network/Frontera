import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, timingSafeEqual, type KeyObject } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import {
  authorityStateBindingProblem,
  bindingOf,
  isAuthorityStateNamespace,
  isBoundedIdentifier,
  isNamespacedAuthorityStateKind,
  sameHead,
  type AuthorityStateBinding,
  type AuthorityStateCheckpoint,
  type AuthorityStateHead,
  type AuthorityStateKind,
} from '../checkpoint.js';
import {
  AUTHORITY_STATE_WITNESS_OPERATIONS,
  AUTHORITY_STATE_WITNESS_PATHS,
  AUTHORITY_STATE_WITNESS_PROTOCOL,
  AUTHORITY_STATE_WITNESS_PROTOCOL_V1,
  parseWitnessRequest,
  witnessReceiptSigningBytes,
  type AuthorityStateWitnessOperation,
  type WitnessBindingState,
  type WitnessReceipt,
  type WitnessReceiptOutcome,
  type WitnessRequest,
} from '../protocol.js';

/**
 * The **reference authority-state witness** (CORE-07) — a local,
 * separate-process freshness witness speaking
 * `frontera.authority-state-witness.v2`.
 *
 * What it is: a small HTTP service, run as its **own process**, over its
 * **own** SQLite file, holding its **own** Ed25519 receipt key. For each
 * `(stateKind, organizationId, namespace)` slot it records the store id, the committed
 * checkpoint and at most one prepared successor, and it changes them only by
 * compare-and-advance, each operation inside one `BEGIN IMMEDIATE`
 * transaction — so two concurrent writers can never both prepare the same
 * successor. Every change is also appended to an append-only history table:
 * there is no last-writer-wins overwrite, no delete and no rebind.
 *
 * What it is **not**: an HSM, a cloud immutable ledger, a trusted timestamping
 * authority, a blockchain or a consensus system. Its key is an ordinary PKCS#8
 * file, it binds loopback only, speaks plain HTTP and authenticates callers
 * with one bearer credential.
 *
 * Its security claim holds **only** while its database lives outside the
 * authority stores' restore domain — a different volume, backup set and
 * snapshot schedule. Restore the authority databases together with this file
 * to the same earlier moment and nothing can detect it; that is the witness's
 * trust assumption, stated in the ADR, not a property of this code.
 *
 * ## Storage: v2, and the v1 migration
 *
 * A slot is the row `(state_kind, organization_id, namespace)` of
 * `witness_bindings_v2`, where the un-namespaced slot of every kind that has
 * no namespace is stored as `namespace = ''` — a value no namespace can take
 * (`isAuthorityStateNamespace`), so the two can never alias.
 *
 * A v1 database (`witness_bindings`, keyed `(state_kind, organization_id)`) is
 * migrated in place, once, inside ONE `BEGIN IMMEDIATE` transaction, before
 * the service answers anything: every v1 row is copied into
 * `witness_bindings_v2` with `namespace = ''` — the exact store id, committed
 * and pending sequence and digest, verified row by row after the copy — the
 * history gains a `namespace` column (`''` for every v1 event), the v1 table is
 * frozen (it keeps every row, and triggers refuse any further write), and the
 * migration is recorded. Nothing is dropped or recreated; a failure rolls the
 * whole migration back and the service refuses to start.
 *
 * A v1 row of a kind that is now **namespaced** keeps exactly its v1 meaning:
 * the un-namespaced slot of a namespaced kind, which no v2 request can name.
 * It is never reinterpreted as a namespaced slot. Moving it into a namespace is an
 * explicit operator act (`rescopeLegacyAuthorityStateBinding`), never inferred.
 */

export interface ReferenceAuthorityStateWitnessOptions {
  readonly witnessId: string;
  /** PKCS#8 PEM of the Ed25519 receipt key. Held by this service only; never an authority signing key. */
  readonly privateKeyPem: string;
  /** The bearer credential callers must present (>= 32 characters). */
  readonly credential: string;
  /** Path of this witness's own SQLite database. Must not be in any authority store's backup or snapshot set. */
  readonly databasePath: string;
  readonly now?: () => string;
}

export interface ReferenceAuthorityStateWitness {
  handle(req: IncomingMessage, res: ServerResponse): void;
  readonly publicKeyPem: string;
  /** How many times each operation was answered. Counts only. */
  operationCounts(): Readonly<Record<AuthorityStateWitnessOperation, number>>;
  close(): void;
}

const MAXIMUM_REQUEST_BYTES = 16 * 1024;

/** The v2 schema. `witness_bindings` (v1) is never created by it: it exists only in a database migrated from v1, frozen. */
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS witness_meta (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    witness_id TEXT NOT NULL,
    protocol TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS witness_bindings_v2 (
    state_kind TEXT NOT NULL,
    organization_id TEXT NOT NULL,
    namespace TEXT NOT NULL CHECK (namespace = '' OR (length(namespace) BETWEEN 1 AND 64 AND namespace GLOB '[a-z]*' AND namespace NOT GLOB '*[^a-z0-9-]*')),
    store_id TEXT NOT NULL,
    committed_sequence INTEGER NOT NULL CHECK (committed_sequence >= 0),
    committed_digest TEXT NOT NULL,
    pending_sequence INTEGER,
    pending_digest TEXT,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (state_kind, organization_id, namespace),
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
    recorded_at TEXT NOT NULL,
    namespace TEXT NOT NULL DEFAULT ''
  );
  CREATE TABLE IF NOT EXISTS witness_migrations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_protocol TEXT NOT NULL,
    to_protocol TEXT NOT NULL,
    bindings INTEGER NOT NULL,
    migrated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS witness_rescopes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    state_kind TEXT NOT NULL,
    organization_id TEXT NOT NULL,
    store_id TEXT NOT NULL,
    namespace TEXT NOT NULL,
    committed_sequence INTEGER NOT NULL,
    committed_digest TEXT NOT NULL,
    operator_id TEXT NOT NULL,
    recorded_at TEXT NOT NULL,
    UNIQUE (state_kind, organization_id, store_id)
  );
  CREATE TRIGGER IF NOT EXISTS witness_bindings_v2_no_delete BEFORE DELETE ON witness_bindings_v2
    BEGIN SELECT RAISE(ABORT, 'a witness binding is never deleted'); END;
  CREATE TRIGGER IF NOT EXISTS witness_bindings_v2_store_fixed BEFORE UPDATE ON witness_bindings_v2
    WHEN NEW.store_id IS NOT OLD.store_id OR NEW.namespace IS NOT OLD.namespace OR NEW.state_kind IS NOT OLD.state_kind OR NEW.organization_id IS NOT OLD.organization_id OR NEW.committed_sequence < OLD.committed_sequence
    BEGIN SELECT RAISE(ABORT, 'a witness binding never changes slot or store and never moves backwards'); END;
  CREATE TRIGGER IF NOT EXISTS witness_history_no_update BEFORE UPDATE ON witness_history
    BEGIN SELECT RAISE(ABORT, 'witness history is append-only'); END;
  CREATE TRIGGER IF NOT EXISTS witness_history_no_delete BEFORE DELETE ON witness_history
    BEGIN SELECT RAISE(ABORT, 'witness history is append-only'); END;
  CREATE TRIGGER IF NOT EXISTS witness_migrations_append_only_update BEFORE UPDATE ON witness_migrations
    BEGIN SELECT RAISE(ABORT, 'witness migrations are append-only'); END;
  CREATE TRIGGER IF NOT EXISTS witness_migrations_append_only_delete BEFORE DELETE ON witness_migrations
    BEGIN SELECT RAISE(ABORT, 'witness migrations are append-only'); END;
  CREATE TRIGGER IF NOT EXISTS witness_rescopes_append_only_update BEFORE UPDATE ON witness_rescopes
    BEGIN SELECT RAISE(ABORT, 'witness rescopes are append-only'); END;
  CREATE TRIGGER IF NOT EXISTS witness_rescopes_append_only_delete BEFORE DELETE ON witness_rescopes
    BEGIN SELECT RAISE(ABORT, 'witness rescopes are append-only'); END;
`;

/** Freezes the v1 table of a migrated database: it keeps every row it had, and nothing writes it again. */
const FREEZE_V1 = `
  CREATE TRIGGER IF NOT EXISTS witness_bindings_v1_frozen_insert BEFORE INSERT ON witness_bindings
    BEGIN SELECT RAISE(ABORT, 'the v1 witness bindings are frozen; v2 holds every slot'); END;
  CREATE TRIGGER IF NOT EXISTS witness_bindings_v1_frozen_update BEFORE UPDATE ON witness_bindings
    BEGIN SELECT RAISE(ABORT, 'the v1 witness bindings are frozen; v2 holds every slot'); END;
`;

type Db = InstanceType<typeof import('better-sqlite3')>;

function tableExists(db: Db, name: string): boolean {
  return db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name) !== undefined;
}

function columnExists(db: Db, table: string, column: string): boolean {
  return (db.prepare(`SELECT name FROM pragma_table_info(?)`).all(table) as { name: string }[]).some((entry) => entry.name === column);
}

/** The storage key of a binding's namespace: `''` for an un-namespaced slot — a value no namespace can take. */
const namespaceKey = (binding: AuthorityStateBinding): string => binding.namespace ?? '';

/**
 * Opens the witness database at v2: creates a new one, migrates a v1 one (see
 * the module comment), or accepts a v2 one — all inside one immediate
 * transaction. Refuses a database of another witness, of an unknown protocol,
 * or with witness tables but no record of whose they are.
 */
function openAtV2(db: Db, witnessId: string, now: () => string): void {
  db.transaction(() => {
    const meta = tableExists(db, 'witness_meta') ? (db.prepare('SELECT witness_id, protocol FROM witness_meta WHERE id = 1').get() as { witness_id: string; protocol: string } | undefined) : undefined;
    if (meta === undefined) {
      if (tableExists(db, 'witness_bindings') || tableExists(db, 'witness_bindings_v2') || tableExists(db, 'witness_history')) {
        throw new Error('The reference authority-state witness database holds witness tables but no record of whose they are; refusing to serve from it.');
      }
      db.exec(SCHEMA);
      db.prepare('INSERT INTO witness_meta (id, witness_id, protocol) VALUES (1, ?, ?)').run(witnessId, AUTHORITY_STATE_WITNESS_PROTOCOL);
      return;
    }
    if (meta.witness_id !== witnessId) throw new Error('The reference authority-state witness database belongs to another witness; refusing to serve from it.');
    if (meta.protocol === AUTHORITY_STATE_WITNESS_PROTOCOL) {
      if (!tableExists(db, 'witness_bindings_v2') || !columnExists(db, 'witness_history', 'namespace')) throw new Error('The reference authority-state witness database claims v2 but lacks its tables; refusing to serve from it.');
      db.exec(SCHEMA);
      if (tableExists(db, 'witness_bindings')) db.exec(FREEZE_V1);
      return;
    }
    if (meta.protocol !== AUTHORITY_STATE_WITNESS_PROTOCOL_V1) throw new Error('The reference authority-state witness database is recorded under a protocol this witness does not implement; refusing to serve from it.');
    // v1 → v2, once. Every statement below is inside this one transaction.
    if (!tableExists(db, 'witness_bindings') || !tableExists(db, 'witness_history') || tableExists(db, 'witness_bindings_v2')) throw new Error('The reference authority-state witness v1 database is not in the v1 shape; refusing to migrate it.');
    if (!columnExists(db, 'witness_history', 'namespace')) db.exec(`ALTER TABLE witness_history ADD COLUMN namespace TEXT NOT NULL DEFAULT ''`);
    db.exec(SCHEMA);
    const copied = db
      .prepare(
        `INSERT INTO witness_bindings_v2 (state_kind, organization_id, namespace, store_id, committed_sequence, committed_digest, pending_sequence, pending_digest, updated_at)
         SELECT state_kind, organization_id, '', store_id, committed_sequence, committed_digest, pending_sequence, pending_digest, updated_at FROM witness_bindings`,
      )
      .run().changes;
    const v1 = (db.prepare('SELECT COUNT(*) AS n FROM witness_bindings').get() as { n: number }).n;
    const unmatched = (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM witness_bindings AS old LEFT JOIN witness_bindings_v2 AS new
             ON new.state_kind = old.state_kind AND new.organization_id = old.organization_id AND new.namespace = ''
            AND new.store_id = old.store_id AND new.committed_sequence = old.committed_sequence AND new.committed_digest = old.committed_digest
            AND new.pending_sequence IS old.pending_sequence AND new.pending_digest IS old.pending_digest
           WHERE new.state_kind IS NULL`,
        )
        .get() as { n: number }
    ).n;
    if (copied !== v1 || unmatched !== 0 || (db.prepare('SELECT COUNT(*) AS n FROM witness_bindings_v2').get() as { n: number }).n !== v1) {
      throw new Error('The reference authority-state witness v1 → v2 migration did not carry every binding exactly; nothing was migrated.');
    }
    db.exec(FREEZE_V1);
    db.prepare('INSERT INTO witness_migrations (from_protocol, to_protocol, bindings, migrated_at) VALUES (?, ?, ?, ?)').run(AUTHORITY_STATE_WITNESS_PROTOCOL_V1, AUTHORITY_STATE_WITNESS_PROTOCOL, v1, now());
    db.prepare('UPDATE witness_meta SET protocol = ? WHERE id = 1').run(AUTHORITY_STATE_WITNESS_PROTOCOL);
  }).immediate();
}

interface BindingRow {
  readonly store_id: string;
  readonly committed_sequence: number;
  readonly committed_digest: string;
  readonly pending_sequence: number | null;
  readonly pending_digest: string | null;
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), 'cache-control': 'no-store' });
  res.end(payload);
}

function stateOf(row: BindingRow | undefined): WitnessBindingState {
  if (row === undefined) return { status: 'unbound' };
  const committed: AuthorityStateHead = { sequence: row.committed_sequence, stateDigest: row.committed_digest };
  return row.pending_sequence === null || row.pending_digest === null
    ? { status: 'bound', storeId: row.store_id, committed }
    : { status: 'bound', storeId: row.store_id, committed, pending: { sequence: row.pending_sequence, stateDigest: row.pending_digest } };
}

export async function createReferenceAuthorityStateWitness(options: ReferenceAuthorityStateWitnessOptions): Promise<ReferenceAuthorityStateWitness> {
  if (typeof options.credential !== 'string' || options.credential.length < 32) throw new Error('The reference authority-state witness needs a credential of at least 32 characters.');
  if (!isBoundedIdentifier(options.witnessId)) throw new Error('The reference authority-state witness needs a well-formed witness id.');
  const privateKey: KeyObject = createPrivateKey(options.privateKeyPem);
  if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('The reference authority-state witness key must be Ed25519.');
  const publicKeyPem = createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }).toString();
  const now = options.now ?? (() => new Date().toISOString());
  const expected = digest(`Bearer ${options.credential}`);
  const counts = new Map<AuthorityStateWitnessOperation, number>(AUTHORITY_STATE_WITNESS_OPERATIONS.map((operation) => [operation, 0]));
  const byPath = new Map<string, AuthorityStateWitnessOperation>(AUTHORITY_STATE_WITNESS_OPERATIONS.map((operation) => [AUTHORITY_STATE_WITNESS_PATHS[operation], operation]));

  const { default: Database } = await import('better-sqlite3');
  const db = new Database(options.databasePath);
  try {
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = FULL');
    db.pragma('busy_timeout = 5000');
    openAtV2(db, options.witnessId, now);
  } catch (error) {
    db.close();
    throw error;
  }

  const selectBinding = db.prepare('SELECT store_id, committed_sequence, committed_digest, pending_sequence, pending_digest FROM witness_bindings_v2 WHERE state_kind = ? AND organization_id = ? AND namespace = ?');
  const insertBinding = db.prepare(
    'INSERT INTO witness_bindings_v2 (state_kind, organization_id, namespace, store_id, committed_sequence, committed_digest, pending_sequence, pending_digest, updated_at) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?)',
  );
  const setPending = db.prepare(
    'UPDATE witness_bindings_v2 SET pending_sequence = ?, pending_digest = ?, updated_at = ? WHERE state_kind = ? AND organization_id = ? AND namespace = ? AND store_id = ? AND committed_sequence = ? AND committed_digest = ? AND pending_sequence IS NULL',
  );
  const commitPending = db.prepare(
    'UPDATE witness_bindings_v2 SET committed_sequence = pending_sequence, committed_digest = pending_digest, pending_sequence = NULL, pending_digest = NULL, updated_at = ? WHERE state_kind = ? AND organization_id = ? AND namespace = ? AND store_id = ? AND pending_sequence = ? AND pending_digest = ?',
  );
  const appendHistory = db.prepare('INSERT INTO witness_history (state_kind, organization_id, namespace, store_id, event, sequence, state_digest, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');

  const read = (binding: AuthorityStateBinding): BindingRow | undefined => selectBinding.get(binding.stateKind, binding.organizationId, namespaceKey(binding)) as BindingRow | undefined;
  const record = (checkpoint: AuthorityStateCheckpoint, event: string): void => {
    appendHistory.run(checkpoint.stateKind, checkpoint.organizationId, namespaceKey(checkpoint), checkpoint.storeId, event, checkpoint.sequence, checkpoint.stateDigest, now());
  };

  /** Applies one request inside one immediate transaction. Compare-and-advance only; returns the outcome and the state after it. */
  const apply = db.transaction((request: Exclude<WitnessRequest, { operation: 'identity' }>): { readonly outcome: WitnessReceiptOutcome; readonly binding: AuthorityStateBinding; readonly state: WitnessBindingState } => {
    switch (request.operation) {
      case 'read': {
        return { outcome: 'current', binding: request.binding, state: stateOf(read(request.binding)) };
      }
      case 'enroll': {
        const { checkpoint } = request;
        const binding = bindingOf(checkpoint);
        const existing = read(binding);
        if (existing !== undefined) {
          // Idempotent only for the exact same state; never a rebind.
          const same = existing.store_id === checkpoint.storeId && existing.pending_sequence === null && sameHead({ sequence: existing.committed_sequence, stateDigest: existing.committed_digest }, checkpoint);
          return { outcome: same ? 'enrolled' : 'conflict', binding, state: stateOf(existing) };
        }
        insertBinding.run(checkpoint.stateKind, checkpoint.organizationId, namespaceKey(checkpoint), checkpoint.storeId, checkpoint.sequence, checkpoint.stateDigest, now());
        record(checkpoint, request.enrollment === 'genesis' ? 'enrolled-genesis' : 'enrolled-baseline');
        return { outcome: 'enrolled', binding, state: stateOf(read(binding)) };
      }
      case 'prepare': {
        const { expected, proposed } = request;
        const binding = bindingOf(proposed);
        const existing = read(binding);
        if (existing === undefined || existing.store_id !== expected.storeId) return { outcome: 'conflict', binding, state: stateOf(existing) };
        const committed = { sequence: existing.committed_sequence, stateDigest: existing.committed_digest };
        if (!sameHead(committed, expected)) return { outcome: 'conflict', binding, state: stateOf(existing) };
        if (existing.pending_sequence !== null) {
          // The same prepare, repeated (a retried request), is the same prepare.
          const same = existing.pending_sequence === proposed.sequence && existing.pending_digest === proposed.stateDigest;
          return { outcome: same ? 'prepared' : 'conflict', binding, state: stateOf(existing) };
        }
        const changed = setPending.run(proposed.sequence, proposed.stateDigest, now(), binding.stateKind, binding.organizationId, namespaceKey(binding), expected.storeId, expected.sequence, expected.stateDigest).changes;
        if (changed !== 1) return { outcome: 'conflict', binding, state: stateOf(read(binding)) };
        record(proposed, 'prepared');
        return { outcome: 'prepared', binding, state: stateOf(read(binding)) };
      }
      case 'finalize': {
        const { checkpoint } = request;
        const binding = bindingOf(checkpoint);
        const existing = read(binding);
        if (existing === undefined || existing.store_id !== checkpoint.storeId) return { outcome: 'conflict', binding, state: stateOf(existing) };
        if (existing.pending_sequence === null) {
          // Already finalized: the same finalize, repeated.
          const same = sameHead({ sequence: existing.committed_sequence, stateDigest: existing.committed_digest }, checkpoint);
          return { outcome: same ? 'finalized' : 'conflict', binding, state: stateOf(existing) };
        }
        const changed = commitPending.run(now(), binding.stateKind, binding.organizationId, namespaceKey(binding), checkpoint.storeId, checkpoint.sequence, checkpoint.stateDigest).changes;
        if (changed !== 1) return { outcome: 'conflict', binding, state: stateOf(read(binding)) };
        record(checkpoint, 'finalized');
        return { outcome: 'finalized', binding, state: stateOf(read(binding)) };
      }
    }
  });

  function signed(receipt: WitnessReceipt): { readonly receipt: WitnessReceipt; readonly signature: string } {
    return { receipt, signature: sign(null, witnessReceiptSigningBytes(receipt), privateKey).toString('base64') };
  }

  function answer(request: WitnessRequest): { readonly receipt: WitnessReceipt; readonly signature: string } {
    const base = { protocol: AUTHORITY_STATE_WITNESS_PROTOCOL, witnessId: options.witnessId, operation: request.operation, challenge: request.challenge } as const;
    if (request.operation === 'identity') return signed({ ...base, outcome: 'identity', operations: [...AUTHORITY_STATE_WITNESS_OPERATIONS] });
    const applied = apply.immediate(request);
    return signed({ ...base, outcome: applied.outcome, binding: applied.binding, state: applied.state });
  }

  function authenticated(req: IncomingMessage): boolean {
    const presented = req.headers.authorization;
    // Compared as fixed-width digests, so timing reveals neither length nor prefix.
    return typeof presented === 'string' && timingSafeEqual(digest(presented), expected);
  }

  function handle(req: IncomingMessage, res: ServerResponse): void {
    const path = (req.url ?? '').split('?')[0] ?? '';
    if (!authenticated(req)) {
      req.resume();
      return send(res, 401, { error: 'unauthenticated' });
    }
    const operation = byPath.get(path);
    if (operation === undefined) {
      req.resume();
      return send(res, 404, { error: 'not-found' });
    }
    if (req.method !== 'POST') {
      req.resume();
      return send(res, 405, { error: 'method-not-allowed' });
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let aborted = false;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAXIMUM_REQUEST_BYTES && !aborted) {
        aborted = true;
        send(res, 413, { error: 'too-large' });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (aborted) return;
      let body: unknown;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        return send(res, 400, { error: 'not-json' });
      }
      const request = parseWitnessRequest(operation, body);
      if (request === undefined) return send(res, 422, { error: 'not-a-well-formed-request' });
      let response: { readonly receipt: WitnessReceipt; readonly signature: string };
      try {
        response = answer(request);
      } catch {
        return send(res, 503, { error: 'witness-unavailable' });
      }
      counts.set(operation, (counts.get(operation) ?? 0) + 1);
      send(res, 200, response);
    });
  }

  return Object.freeze({
    handle,
    publicKeyPem,
    operationCounts: () => Object.freeze(Object.fromEntries(counts)) as Readonly<Record<AuthorityStateWitnessOperation, number>>,
    close: () => db.close(),
  });
}

/**
 * The explicit operator act that moves a **legacy** binding — the
 * un-namespaced slot of a now-namespaced kind, carried over from a v1 database
 * — into one namespace. Never automatic and never inferred: the operator names
 * the kind, the organization, the exact store the legacy slot binds and the
 * namespace that store's composition opens it under, and attests it. Offline
 * and in-process only (no route), run against the witness's own database while
 * the service is stopped — like the enrollment ceremony, it is trusted
 * operational code.
 *
 * One immediate transaction. Refused, with nothing written, unless: the
 * database is at v2 and is this witness's; the kind is namespaced and the
 * namespace canonical; the legacy slot exists, binds exactly the stated store
 * and holds no pending transition; the target slot is empty; and this store
 * was never rescoped before. The new slot carries the legacy store id,
 * committed sequence and digest exactly, so rollback detection continues from
 * the witnessed head — nothing is re-baselined. The legacy row stays as it was
 * (a binding is never deleted), unaddressable by any v2 request.
 */
export async function rescopeLegacyAuthorityStateBinding(
  databasePath: string,
  request: {
    readonly witnessId: string;
    readonly stateKind: AuthorityStateKind;
    readonly organizationId: string;
    readonly storeId: string;
    readonly namespace: string;
    readonly operator: { readonly operatorId: string; readonly attestation: 'legacy-binding-belongs-to-namespace' };
    readonly now?: () => string;
  },
): Promise<{ readonly sequence: number; readonly stateDigest: string }> {
  const binding: AuthorityStateBinding = { stateKind: request.stateKind, organizationId: request.organizationId, namespace: request.namespace };
  if (!isNamespacedAuthorityStateKind(request.stateKind)) throw new Error('Only a legacy binding of a namespaced state kind can be rescoped.');
  if (!isAuthorityStateNamespace(request.namespace) || authorityStateBindingProblem(binding) !== undefined) throw new Error('The rescope target is not a well-formed namespaced slot.');
  if (!isBoundedIdentifier(request.storeId)) throw new Error('The rescope names no well-formed store.');
  if (request.operator?.attestation !== 'legacy-binding-belongs-to-namespace' || !isBoundedIdentifier(request.operator.operatorId)) throw new Error('A rescope requires an operator attestation { operatorId, attestation }.');
  const now = request.now ?? (() => new Date().toISOString());
  const { default: Database } = await import('better-sqlite3');
  const db = new Database(databasePath, { fileMustExist: true });
  try {
    db.pragma('busy_timeout = 5000');
    return db.transaction(() => {
      const meta = tableExists(db, 'witness_meta') ? (db.prepare('SELECT witness_id, protocol FROM witness_meta WHERE id = 1').get() as { witness_id: string; protocol: string } | undefined) : undefined;
      if (meta === undefined || meta.witness_id !== request.witnessId || meta.protocol !== AUTHORITY_STATE_WITNESS_PROTOCOL) throw new Error('The database is not this witness at v2; open it with the witness first so it migrates.');
      const select = db.prepare('SELECT store_id, committed_sequence, committed_digest, pending_sequence FROM witness_bindings_v2 WHERE state_kind = ? AND organization_id = ? AND namespace = ?');
      const legacy = select.get(request.stateKind, request.organizationId, '') as { store_id: string; committed_sequence: number; committed_digest: string; pending_sequence: number | null } | undefined;
      if (legacy === undefined) throw new Error('There is no legacy binding of this kind for this organization.');
      if (legacy.store_id !== request.storeId) throw new Error('The legacy binding names another store than the one stated; nothing was rescoped.');
      if (legacy.pending_sequence !== null) throw new Error('The legacy binding holds a pending transition; resolve it before rescoping.');
      if (select.get(request.stateKind, request.organizationId, request.namespace) !== undefined) throw new Error('The target namespace is already bound; a slot is never rebound.');
      const at = now();
      db.prepare('INSERT INTO witness_rescopes (state_kind, organization_id, store_id, namespace, committed_sequence, committed_digest, operator_id, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
        request.stateKind,
        request.organizationId,
        request.storeId,
        request.namespace,
        legacy.committed_sequence,
        legacy.committed_digest,
        request.operator.operatorId,
        at,
      );
      db.prepare(
        'INSERT INTO witness_bindings_v2 (state_kind, organization_id, namespace, store_id, committed_sequence, committed_digest, pending_sequence, pending_digest, updated_at) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?)',
      ).run(request.stateKind, request.organizationId, request.namespace, request.storeId, legacy.committed_sequence, legacy.committed_digest, at);
      return { sequence: legacy.committed_sequence, stateDigest: legacy.committed_digest };
    }).immediate();
  } finally {
    db.close();
  }
}

function isLoopback(host: string): boolean {
  return host === 'localhost' || host === '::1' || /^127(?:\.\d{1,3}){3}$/.test(host);
}

/** Starts the reference witness on a loopback address. Refuses any other bind. */
export async function startReferenceAuthorityStateWitness(
  options: ReferenceAuthorityStateWitnessOptions & { readonly host?: string; readonly port?: number },
): Promise<{ readonly server: Server; readonly port: number; readonly publicKeyPem: string; readonly witness: ReferenceAuthorityStateWitness; close(): Promise<void> }> {
  const host = options.host ?? '127.0.0.1';
  if (!isLoopback(host)) throw new Error('The reference authority-state witness binds loopback only.');
  const witness = await createReferenceAuthorityStateWitness(options);
  const server = createServer((req, res) => witness.handle(req, res));
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(options.port ?? 0, host, () => resolve());
    });
  } catch (error) {
    witness.close();
    throw error;
  }
  const port = (server.address() as AddressInfo).port;
  return {
    server,
    port,
    publicKeyPem: witness.publicKeyPem,
    witness,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          witness.close();
          resolve();
        });
      }),
  };
}

/**
 * Loads the witness's receipt key from `path`, or — when the file does not
 * exist — generates a fresh Ed25519 key there (mode 0600, never overwriting)
 * and writes its **public** half beside it as `<path>.pub` for the operator to
 * install as the Host's pinned witness key out of band.
 */
export function loadOrCreateReferenceWitnessKey(path: string): { readonly privateKeyPem: string; readonly publicKeyPem: string } {
  if (!existsSync(path)) {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    writeFileSync(path, privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), { mode: 0o600, flag: 'wx' });
    writeFileSync(`${path}.pub`, publicKey.export({ type: 'spki', format: 'pem' }).toString(), { mode: 0o644, flag: 'w' });
  }
  const privateKeyPem = readFileSync(path, 'utf8');
  return { privateKeyPem, publicKeyPem: createPublicKey(createPrivateKey(privateKeyPem)).export({ type: 'spki', format: 'pem' }).toString() };
}
