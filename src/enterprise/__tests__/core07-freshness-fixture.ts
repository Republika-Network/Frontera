import { spawn, type ChildProcess } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  createAuthorityStateFreshnessBoundary,
  createHttpAuthorityStateWitnessTransport,
  establishAuthorityStateWitness,
  type AuthorityStateFreshnessBoundary,
  type AuthorityStateWitness,
  type AuthorityStateWitnessTransport,
  type WitnessRequest,
} from '../authority-state-freshness/index.js';
import { startReferenceAuthorityStateWitness } from '../authority-state-freshness/reference/reference-witness-service.js';

/**
 * CORE-07 — the authority-state witness, for tests.
 *
 * Three shapes, used for different claims:
 *
 * - `startWitness` — the reference witness in **this** process, over real
 *   loopback HTTP, over its **own** SQLite file in its **own** directory. The
 *   authority stores under test live elsewhere, so a test that restores an
 *   authority database leaves the witness's state exactly as it was — the
 *   deployment requirement the security claim rests on.
 * - `ScriptedWitnessTransport` — a transport whose answers the test controls,
 *   for the malicious/unavailable witness matrix. By default it forwards to a
 *   real transport.
 * - `spawnReferenceWitness` — the reference witness as a **separate process**,
 *   through `scripts/run-reference-authority-state-witness.mjs`, with its own
 *   environment, key file and database. The test reads only the key's public
 *   half (`<file>.pub`) — the out-of-band step an operator takes to pin it.
 */

export const WITNESS_TOKEN = 'FRONTERA_CORE07_WITNESS_TOKEN_SENTINEL_4c1e9a07b2d85f36';
export const WITNESS_ID = 'witness-core07-test';

export function witnessKey(): { readonly privateKeyPem: string; readonly publicKeyPem: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return { privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString() };
}

export interface StartedWitness {
  readonly endpoint: string;
  readonly witnessId: string;
  readonly publicKeyPem: string;
  readonly databasePath: string;
  readonly directory: string;
  operationCounts(): Readonly<Record<string, number>>;
  close(): Promise<void>;
  /** The same witness — same id, same receipt key, same database — restarted on a new port. */
  restart(): Promise<StartedWitness>;
}

const started: StartedWitness[] = [];

/** A reference witness in this process. Its database lives in its own directory — never beside an authority store. */
export async function startWitness(options: { readonly witnessId?: string; readonly key?: ReturnType<typeof witnessKey>; readonly directory?: string } = {}): Promise<StartedWitness> {
  const directory = options.directory ?? mkdtempSync(join(tmpdir(), 'frontera-core07-witness-'));
  const key = options.key ?? witnessKey();
  const witnessId = options.witnessId ?? WITNESS_ID;
  const databasePath = join(directory, 'witness.sqlite');
  const service = await startReferenceAuthorityStateWitness({ witnessId, privateKeyPem: key.privateKeyPem, credential: WITNESS_TOKEN, databasePath });
  // A witness never keeps a test process alive on its own.
  service.server.unref();
  let closed = false;
  const handle: StartedWitness = {
    endpoint: `http://127.0.0.1:${service.port}`,
    witnessId,
    publicKeyPem: key.publicKeyPem,
    databasePath,
    directory,
    operationCounts: () => service.witness.operationCounts(),
    async close() {
      if (closed) return;
      closed = true;
      await service.close();
    },
    async restart() {
      await handle.close();
      return startWitness({ directory, witnessId, key });
    },
  };
  started.push(handle);
  return handle;
}

export async function closeAllWitnesses(): Promise<void> {
  for (const witness of started.splice(0)) await witness.close().catch(() => {});
}

/** The Host environment for an external freshness witness. */
export function freshnessEnv(witness: Pick<StartedWitness, 'endpoint' | 'witnessId' | 'publicKeyPem'>, overrides: Record<string, string> = {}): Record<string, string> {
  return {
    AOC_ENTERPRISE_AUTHORITY_FRESHNESS_MODE: 'external',
    AOC_ENTERPRISE_AUTHORITY_FRESHNESS_ENDPOINT: witness.endpoint,
    AOC_ENTERPRISE_AUTHORITY_FRESHNESS_TOKEN: WITNESS_TOKEN,
    AOC_ENTERPRISE_AUTHORITY_FRESHNESS_WITNESS_ID: witness.witnessId,
    AOC_ENTERPRISE_AUTHORITY_FRESHNESS_WITNESS_PUBLIC_KEY: witness.publicKeyPem,
    AOC_ENTERPRISE_AUTHORITY_FRESHNESS_TIMEOUT_MS: '2000',
    AOC_ENTERPRISE_AUTHORITY_FRESHNESS_MAX_ATTEMPTS: '1',
    AOC_ENTERPRISE_AUTHORITY_FRESHNESS_PROBE_INTERVAL_MS: '0',
    ...overrides,
  };
}

/** A client over HTTP to `witness`, pinned to its key. */
export function connect(
  witness: Pick<StartedWitness, 'endpoint' | 'witnessId' | 'publicKeyPem'>,
  options: { readonly transport?: AuthorityStateWitnessTransport; readonly pin?: { readonly witnessId?: string; readonly publicKeyPem?: string }; readonly maxAttempts?: number; readonly timeoutMs?: number; readonly probeIntervalMs?: number } = {},
): Promise<AuthorityStateWitness> {
  return establishAuthorityStateWitness({
    transport: options.transport ?? createHttpAuthorityStateWitnessTransport({ endpoint: witness.endpoint, credential: WITNESS_TOKEN }),
    pinned: { witnessId: options.pin?.witnessId ?? witness.witnessId, publicKeyPem: options.pin?.publicKeyPem ?? witness.publicKeyPem },
    timeoutMs: options.timeoutMs ?? 2_000,
    maxAttempts: options.maxAttempts ?? 1,
    probeIntervalMs: options.probeIntervalMs ?? 0,
  });
}

/** A freshness boundary for `organizationId` over a fresh client to `witness`. */
export async function boundaryFor(witness: Pick<StartedWitness, 'endpoint' | 'witnessId' | 'publicKeyPem'>, organizationId: string, options: Parameters<typeof connect>[1] = {}): Promise<AuthorityStateFreshnessBoundary> {
  const { anchor, monitor } = await connect(witness, options);
  return createAuthorityStateFreshnessBoundary({ anchor, monitor, organizationId });
}

export type WitnessAnswer = (request: WitnessRequest, forward: () => Promise<unknown>) => unknown | Promise<unknown>;

/** A transport the test scripts. Forwards to `inner` unless `answer` says otherwise; records every operation. */
export class ScriptedWitnessTransport implements AuthorityStateWitnessTransport {
  readonly calls: string[] = [];
  answer: WitnessAnswer = (_request, forward) => forward();

  constructor(private readonly inner: AuthorityStateWitnessTransport) {}

  async call(request: WitnessRequest, options: { readonly timeoutMs: number }): Promise<unknown> {
    this.calls.push(request.operation);
    return this.answer(request, () => this.inner.call(request, options));
  }

  count(operation: string): number {
    return this.calls.filter((entry) => entry === operation).length;
  }
}

/** The raw rows of a witness database, read the way an operator would. */
export async function witnessRows(databasePath: string): Promise<readonly Record<string, unknown>[]> {
  const { default: Database } = await import('better-sqlite3');
  const db = new Database(databasePath, { readonly: true });
  try {
    return db.prepare('SELECT state_kind, organization_id, store_id, committed_sequence, committed_digest, pending_sequence, pending_digest FROM witness_bindings ORDER BY state_kind').all() as Record<string, unknown>[];
  } finally {
    db.close();
  }
}

// ── the separate-process reference witness ──────────────────────────────────

const WITNESS_SCRIPT = resolve('scripts/run-reference-authority-state-witness.mjs');

export interface SpawnedWitness {
  readonly endpoint: string;
  readonly witnessId: string;
  readonly publicKeyPem: string;
  readonly databasePath: string;
  readonly pid: number;
  readonly child: ChildProcess;
  /** SIGKILL: an abrupt outage. */
  kill(): Promise<void>;
}

/** A private directory for a spawned witness's key and database. The test process never reads the private key in it. */
export function witnessDirectory(): { readonly dir: string; cleanup(): void } {
  const dir = mkdtempSync(join(tmpdir(), 'frontera-core07-witness-proc-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export async function spawnReferenceWitness(options: { readonly dir: string; readonly witnessId?: string; readonly port?: number }): Promise<SpawnedWitness> {
  const witnessId = options.witnessId ?? WITNESS_ID;
  const keyFile = join(options.dir, 'witness-key.pem');
  const databasePath = join(options.dir, 'witness.sqlite');
  const child = spawn(process.execPath, [WITNESS_SCRIPT], {
    env: {
      PATH: process.env.PATH ?? '',
      FRONTERA_REFERENCE_WITNESS_DB: databasePath,
      FRONTERA_REFERENCE_WITNESS_KEY_FILE: keyFile,
      FRONTERA_REFERENCE_WITNESS_ID: witnessId,
      FRONTERA_REFERENCE_WITNESS_TOKEN: WITNESS_TOKEN,
      FRONTERA_REFERENCE_WITNESS_PORT: String(options.port ?? 0),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const port = await new Promise<number>((resolvePort, reject) => {
    let out = '';
    let err = '';
    const deadline = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`reference witness did not start: ${err}`));
    }, 20_000);
    child.stdout?.on('data', (chunk: Buffer) => {
      out += chunk.toString();
      const match = /listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(out);
      if (match !== null) {
        clearTimeout(deadline);
        resolvePort(Number.parseInt(match[1] as string, 10));
      }
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      err += chunk.toString();
    });
    child.once('exit', (code) => {
      clearTimeout(deadline);
      reject(new Error(`reference witness exited (${String(code)}): ${err}`));
    });
  });
  return {
    endpoint: `http://127.0.0.1:${port}`,
    witnessId,
    publicKeyPem: readFileSync(`${keyFile}.pub`, 'utf8'),
    databasePath,
    pid: child.pid ?? -1,
    child,
    kill: () =>
      new Promise<void>((resolveKill) => {
        if (child.exitCode !== null || child.signalCode !== null) return resolveKill();
        child.once('exit', () => resolveKill());
        child.kill('SIGKILL');
      }),
  };
}

// ── one witness per secure deployment, for Host-level suites ────────────────

const deploymentWitnesses = new Map<string, Promise<StartedWitness>>();

/** The deployment a secure environment describes: the directory its bounded-grant store lives in. */
function deploymentOf(env: Readonly<Record<string, string | undefined>>): string | undefined {
  const path = env.AOC_ENTERPRISE_BOUNDED_GRANT_SQLITE_PATH;
  return path === undefined ? undefined : resolve(path, '..');
}

/**
 * The environment of a secure deployment, with its CORE-07 witness.
 *
 * A secure Host requires an external freshness witness. Each deployment (its
 * data directory) gets its **own** reference witness — started on first use,
 * reused by every restart of that deployment, and closed with
 * `closeAllWitnesses` — whose database lives in a separate directory, never
 * beside the authority stores. An environment that already states a freshness
 * mode is returned unchanged, so a test about freshness configuration keeps
 * control of it.
 */
export async function withDeploymentWitness(env: Readonly<Record<string, string | undefined>>): Promise<Record<string, string | undefined>> {
  // Descriptors, not values: a test may hand in an environment whose variables
  // are getters, and copying must not read them.
  const copy = Object.defineProperties({}, Object.getOwnPropertyDescriptors(env)) as Record<string, string | undefined>;
  const environment = Object.getOwnPropertyDescriptor(env, 'AOC_ENTERPRISE_ENV')?.value as string | undefined;
  if (environment !== 'production' && environment !== 'staging') return copy;
  if (Object.getOwnPropertyDescriptor(env, 'AOC_ENTERPRISE_AUTHORITY_FRESHNESS_MODE') !== undefined) return copy;
  const deployment = deploymentOf(env);
  if (deployment === undefined) return copy;
  let witness = deploymentWitnesses.get(deployment);
  if (witness === undefined) {
    witness = startWitness();
    deploymentWitnesses.set(deployment, witness);
  }
  return Object.assign(copy, freshnessEnv(await witness));
}

/** Closes every deployment witness this process started. */
export async function closeDeploymentWitnesses(): Promise<void> {
  const all = [...deploymentWitnesses.values()];
  deploymentWitnesses.clear();
  for (const witness of all) await (await witness).close().catch(() => {});
}
