import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, timingSafeEqual, type KeyObject } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { isBoundedIdentifier, sameHead, type AuthorityStateBinding, type AuthorityStateCheckpoint, type AuthorityStateHead } from '../checkpoint.js';
import {
  AUTHORITY_STATE_WITNESS_OPERATIONS,
  AUTHORITY_STATE_WITNESS_PATHS,
  AUTHORITY_STATE_WITNESS_PROTOCOL,
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
 * `frontera.authority-state-witness.v1`.
 *
 * What it is: a small HTTP service, run as its **own process**, over its
 * **own** SQLite file, holding its **own** Ed25519 receipt key. For each
 * `(stateKind, organizationId)` slot it records the store id, the committed
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

const SCHEMA = `
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
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = FULL');
  db.pragma('busy_timeout = 5000');
  db.exec(SCHEMA);
  const meta = db.prepare('SELECT witness_id, protocol FROM witness_meta WHERE id = 1').get() as { witness_id: string; protocol: string } | undefined;
  if (meta === undefined) {
    db.prepare('INSERT INTO witness_meta (id, witness_id, protocol) VALUES (1, ?, ?)').run(options.witnessId, AUTHORITY_STATE_WITNESS_PROTOCOL);
  } else if (meta.witness_id !== options.witnessId || meta.protocol !== AUTHORITY_STATE_WITNESS_PROTOCOL) {
    db.close();
    throw new Error('The reference authority-state witness database belongs to another witness or protocol version; refusing to serve from it.');
  }

  const selectBinding = db.prepare('SELECT store_id, committed_sequence, committed_digest, pending_sequence, pending_digest FROM witness_bindings WHERE state_kind = ? AND organization_id = ?');
  const insertBinding = db.prepare('INSERT INTO witness_bindings (state_kind, organization_id, store_id, committed_sequence, committed_digest, pending_sequence, pending_digest, updated_at) VALUES (?, ?, ?, ?, ?, NULL, NULL, ?)');
  const setPending = db.prepare(
    'UPDATE witness_bindings SET pending_sequence = ?, pending_digest = ?, updated_at = ? WHERE state_kind = ? AND organization_id = ? AND store_id = ? AND committed_sequence = ? AND committed_digest = ? AND pending_sequence IS NULL',
  );
  const commitPending = db.prepare(
    'UPDATE witness_bindings SET committed_sequence = pending_sequence, committed_digest = pending_digest, pending_sequence = NULL, pending_digest = NULL, updated_at = ? WHERE state_kind = ? AND organization_id = ? AND store_id = ? AND pending_sequence = ? AND pending_digest = ?',
  );
  const appendHistory = db.prepare('INSERT INTO witness_history (state_kind, organization_id, store_id, event, sequence, state_digest, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?)');

  const read = (binding: AuthorityStateBinding): BindingRow | undefined => selectBinding.get(binding.stateKind, binding.organizationId) as BindingRow | undefined;
  const record = (checkpoint: AuthorityStateCheckpoint, event: string): void => {
    appendHistory.run(checkpoint.stateKind, checkpoint.organizationId, checkpoint.storeId, event, checkpoint.sequence, checkpoint.stateDigest, now());
  };

  /** Applies one request inside one immediate transaction. Compare-and-advance only; returns the outcome and the state after it. */
  const apply = db.transaction((request: Exclude<WitnessRequest, { operation: 'identity' }>): { readonly outcome: WitnessReceiptOutcome; readonly binding: AuthorityStateBinding; readonly state: WitnessBindingState } => {
    switch (request.operation) {
      case 'read': {
        return { outcome: 'current', binding: request.binding, state: stateOf(read(request.binding)) };
      }
      case 'enroll': {
        const { checkpoint } = request;
        const binding = { stateKind: checkpoint.stateKind, organizationId: checkpoint.organizationId };
        const existing = read(binding);
        if (existing !== undefined) {
          // Idempotent only for the exact same state; never a rebind.
          const same = existing.store_id === checkpoint.storeId && existing.pending_sequence === null && sameHead({ sequence: existing.committed_sequence, stateDigest: existing.committed_digest }, checkpoint);
          return { outcome: same ? 'enrolled' : 'conflict', binding, state: stateOf(existing) };
        }
        insertBinding.run(checkpoint.stateKind, checkpoint.organizationId, checkpoint.storeId, checkpoint.sequence, checkpoint.stateDigest, now());
        record(checkpoint, request.enrollment === 'genesis' ? 'enrolled-genesis' : 'enrolled-baseline');
        return { outcome: 'enrolled', binding, state: stateOf(read(binding)) };
      }
      case 'prepare': {
        const { expected, proposed } = request;
        const binding = { stateKind: proposed.stateKind, organizationId: proposed.organizationId };
        const existing = read(binding);
        if (existing === undefined || existing.store_id !== expected.storeId) return { outcome: 'conflict', binding, state: stateOf(existing) };
        const committed = { sequence: existing.committed_sequence, stateDigest: existing.committed_digest };
        if (!sameHead(committed, expected)) return { outcome: 'conflict', binding, state: stateOf(existing) };
        if (existing.pending_sequence !== null) {
          // The same prepare, repeated (a retried request), is the same prepare.
          const same = existing.pending_sequence === proposed.sequence && existing.pending_digest === proposed.stateDigest;
          return { outcome: same ? 'prepared' : 'conflict', binding, state: stateOf(existing) };
        }
        const changed = setPending.run(proposed.sequence, proposed.stateDigest, now(), binding.stateKind, binding.organizationId, expected.storeId, expected.sequence, expected.stateDigest).changes;
        if (changed !== 1) return { outcome: 'conflict', binding, state: stateOf(read(binding)) };
        record(proposed, 'prepared');
        return { outcome: 'prepared', binding, state: stateOf(read(binding)) };
      }
      case 'finalize': {
        const { checkpoint } = request;
        const binding = { stateKind: checkpoint.stateKind, organizationId: checkpoint.organizationId };
        const existing = read(binding);
        if (existing === undefined || existing.store_id !== checkpoint.storeId) return { outcome: 'conflict', binding, state: stateOf(existing) };
        if (existing.pending_sequence === null) {
          // Already finalized: the same finalize, repeated.
          const same = sameHead({ sequence: existing.committed_sequence, stateDigest: existing.committed_digest }, checkpoint);
          return { outcome: same ? 'finalized' : 'conflict', binding, state: stateOf(existing) };
        }
        const changed = commitPending.run(now(), binding.stateKind, binding.organizationId, checkpoint.storeId, checkpoint.sequence, checkpoint.stateDigest).changes;
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
