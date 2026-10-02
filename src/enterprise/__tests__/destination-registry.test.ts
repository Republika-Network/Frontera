import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';

import Database from 'better-sqlite3';

import {
  DESTINATION_IDENTIFIER_MAX_LENGTH,
  executionDestinationKey,
  parseExecutionDestination,
  sameExecutionDestination,
  type ExecutionDestination,
} from '../../features/destination-runtime/index.js';
import {
  DESTINATION_REGISTRANT_REFERENCE_MAX_LENGTH,
  createInMemoryDestinationRegistry,
  isDestinationRegistryError,
  type DestinationRegistryErrorCode,
  type DestinationRegistryPort,
} from '../../features/destination-runtime/registry/index.js';
import { DESTINATION_REGISTRY_SCHEMA_VERSION, createSqliteDestinationRegistry } from '../destination-registry/index.js';

/**
 * ANDREW-P0-02 — the destination registry contract, against both
 * implementations, then what only the durable registry has: restart, raw
 * SQLite append-only triggers, schema refusal before mutation, fail-closed
 * verification of corrupted rows, and genuinely parallel writers.
 *
 * Registry membership is `unknown` or `known`. Nothing here is, or tests for,
 * approval.
 */

const AT = '2026-10-01T12:00:00.000Z';
const OPERATOR = 'operator:ops-1';

const directories: string[] = [];
after(() => {
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
});

function freshPath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'aoc-destination-registry-'));
  directories.push(directory);
  return join(directory, 'destination-registry.sqlite');
}

function steppingClock(start = AT): () => string {
  let tick = 0;
  return () => new Date(Date.parse(start) + (tick += 1000)).toISOString();
}

/** A stepping clock that remembers what it answered, so a test can name the instant a registration sampled. */
function recordingClock(start = AT): { readonly now: () => string; readonly answers: readonly string[] } {
  const step = steppingClock(start);
  const answers: string[] = [];
  return {
    now: () => {
      const instant = step();
      answers.push(instant);
      return instant;
    },
    answers,
  };
}

function destination(namespace: string, identifier: string): ExecutionDestination {
  const parsed = parseExecutionDestination({ namespace, identifier });
  assert.equal(parsed.valid, true, `${namespace}:${identifier} must be a valid destination`);
  return (parsed as { readonly destination: ExecutionDestination }).destination;
}

function assertRegistryError(fn: () => unknown, code: DestinationRegistryErrorCode): void {
  assert.throws(fn, (error: unknown) => isDestinationRegistryError(error) && error.code === code);
}

interface Harness {
  readonly registry: DestinationRegistryPort;
  close(): Promise<void>;
}

function describeContract(name: string, open: (now: () => string) => Promise<Harness>): void {
  describe(`${name} — the destination registry contract`, () => {
    it('an unknown destination is `unknown`, carrying its P0-01 key — not denied, not an error', async () => {
      const { registry, close } = await open(steppingClock());
      const lookup = registry.lookup(destination('network-a', 'xyz789'));
      assert.deepEqual(lookup, { membership: 'unknown', destinationKey: 'network-a:xyz789' });
      await close();
    });

    it('registers a destination and reads it back as `known`, identity exactly as P0-01 states it', async () => {
      const clock = recordingClock();
      const { registry, close } = await open(clock.now);
      const target = destination('network-a', 'abc123');
      const result = registry.register({ destination: target, registeredBy: OPERATOR });
      const sampledAt = clock.answers.at(-1);
      assert.equal(result.outcome, 'registered');
      assert.deepEqual(result.registration, {
        destination: { namespace: 'network-a', identifier: 'abc123' },
        destinationKey: 'network-a:abc123',
        registeredBy: OPERATOR,
        registeredAt: sampledAt,
      });

      const lookup = registry.lookup(destination('network-a', 'abc123'));
      assert.equal(lookup.membership, 'known');
      if (lookup.membership !== 'known') return;
      assert.deepEqual(lookup.registration, result.registration);
      assert.equal(sameExecutionDestination(lookup.registration.destination, target), true);
      assert.equal(lookup.registration.destinationKey, executionDestinationKey(target));
      assert.deepEqual(Object.keys(lookup.registration.destination), ['namespace', 'identifier']);
      await close();
    });

    it('the same identifier under two namespaces is two destinations; registering one leaves the other unknown', async () => {
      const { registry, close } = await open(steppingClock());
      registry.register({ destination: destination('network-a', 'abc'), registeredBy: OPERATOR });
      assert.equal(registry.lookup(destination('network-b', 'abc')).membership, 'unknown');
      assert.equal(registry.register({ destination: destination('network-b', 'abc'), registeredBy: OPERATOR }).outcome, 'registered');
      assert.equal(registry.lookup(destination('network-a', 'abc')).membership, 'known');
      assert.equal(registry.lookup(destination('network-b', 'abc')).membership, 'known');
      await close();
    });

    it('namespace-prefix and separator confusion never collide', async () => {
      const { registry, close } = await open(steppingClock());
      registry.register({ destination: destination('net', 'a:b'), registeredBy: OPERATOR });
      registry.register({ destination: destination('network-a', 'abc'), registeredBy: OPERATOR });
      for (const [namespace, identifier] of [
        ['net', 'a'],
        ['net.a', 'b'],
        ['net-a', 'b'],
        ['network-a.testnet', 'abc'],
        ['network', 'a:abc'],
        ['network', '-a:abc'],
      ] as const) {
        assert.equal(registry.lookup(destination(namespace, identifier)).membership, 'unknown', `${namespace} / ${identifier}`);
      }
      // A namespace cannot contain the separator, so the forged spelling is refused at ingress.
      assertRegistryError(() => registry.lookup({ namespace: 'net:a', identifier: 'b' }), 'DESTINATION_REGISTRY_INPUT_INVALID');
      await close();
    });

    it('case is preserved and significant: nothing is folded', async () => {
      const { registry, close } = await open(steppingClock());
      const result = registry.register({ destination: destination('network-a', 'rAbC9'), registeredBy: OPERATOR });
      assert.equal(result.registration.destination.identifier, 'rAbC9');
      for (const spelling of ['rabc9', 'RABC9', 'rAbc9']) assert.equal(registry.lookup(destination('network-a', spelling)).membership, 'unknown', spelling);
      assert.equal(registry.register({ destination: destination('network-a', 'RABC9'), registeredBy: OPERATOR }).outcome, 'registered');
      await close();
    });

    it('nothing is trimmed or normalized: whitespace, non-ASCII and look-alike spellings are refused, not repaired', async () => {
      const { registry, close } = await open(steppingClock());
      registry.register({ destination: destination('network-a', 'abc'), registeredBy: OPERATOR });
      for (const identifier of [' abc', 'abc ', 'abc\n', 'ab​c', 'аbc', 'abć', 'ａbc']) {
        assertRegistryError(() => registry.lookup({ namespace: 'network-a', identifier }), 'DESTINATION_REGISTRY_INPUT_INVALID');
        assertRegistryError(() => registry.register({ destination: { namespace: 'network-a', identifier }, registeredBy: OPERATOR }), 'DESTINATION_REGISTRY_INPUT_INVALID');
      }
      for (const namespace of [' network-a', 'Network-a', 'network-a ', 'NETWORK-A']) {
        assertRegistryError(() => registry.lookup({ namespace, identifier: 'abc' }), 'DESTINATION_REGISTRY_INPUT_INVALID');
      }
      await close();
    });

    it('an exact duplicate is `existing`: one record, the original provenance and timestamp intact', async () => {
      const clock = recordingClock();
      const { registry, close } = await open(clock.now);
      const first = registry.register({ destination: destination('network-a', 'abc123'), registeredBy: OPERATOR });
      const sampledAt = clock.answers.at(-1);
      const replay = registry.register({ destination: destination('network-a', 'abc123'), registeredBy: OPERATOR });
      const otherRegistrant = registry.register({ destination: destination('network-a', 'abc123'), registeredBy: 'service:importer' });
      assert.equal(first.outcome, 'registered');
      assert.equal(replay.outcome, 'existing');
      assert.equal(otherRegistrant.outcome, 'existing');
      assert.deepEqual(replay.registration, first.registration);
      // Never last-write-wins: a retry from someone else does not rewrite who recorded it.
      assert.deepEqual(otherRegistrant.registration, first.registration);
      assert.equal(otherRegistrant.registration.registeredBy, OPERATOR);
      assert.equal(otherRegistrant.registration.registeredAt, sampledAt);
      // A replay samples no clock: nothing about it is recorded.
      assert.equal(clock.answers.at(-1), sampledAt);
      await close();
    });

    it('retry is deterministic: ten replays all answer the same record', async () => {
      const { registry, close } = await open(steppingClock());
      const first = registry.register({ destination: destination('network-a', 'abc123'), registeredBy: OPERATOR });
      for (let attempt = 0; attempt < 10; attempt += 1) {
        const replay = registry.register({ destination: destination('network-a', 'abc123'), registeredBy: OPERATOR });
        assert.equal(replay.outcome, 'existing');
        assert.deepEqual(replay.registration, first.registration);
      }
      await close();
    });

    it('refuses malformed destinations through P0-01 ingress, including absurd lengths, for both register and lookup', async () => {
      const { registry, close } = await open(steppingClock());
      const malformed: unknown[] = [
        null,
        undefined,
        'network-a:abc',
        ['network-a', 'abc'],
        {},
        { namespace: 'network-a' },
        { identifier: 'abc' },
        { namespace: 'network-a', identifier: '' },
        { namespace: '', identifier: 'abc' },
        { namespace: 'network-a', identifier: 'x'.repeat(DESTINATION_IDENTIFIER_MAX_LENGTH + 1) },
        { namespace: 'n'.repeat(65), identifier: 'abc' },
        { namespace: 'network-a', identifier: 'x'.repeat(1_000_000) },
        { namespace: 'network-a', identifier: 42 },
        new Map([['namespace', 'network-a']]),
      ];
      for (const candidate of malformed) {
        assertRegistryError(() => registry.register({ destination: candidate as ExecutionDestination, registeredBy: OPERATOR }), 'DESTINATION_REGISTRY_INPUT_INVALID');
        assertRegistryError(() => registry.lookup(candidate as ExecutionDestination), 'DESTINATION_REGISTRY_INPUT_INVALID');
      }
      // The longest admissible identifier is admissible.
      assert.equal(registry.register({ destination: destination('network-a', 'x'.repeat(DESTINATION_IDENTIFIER_MAX_LENGTH)), registeredBy: OPERATOR }).outcome, 'registered');
      await close();
    });

    it('refuses misleading metadata that tries to imply approval — on the destination or on the request — and records nothing', async () => {
      const { registry, close } = await open(steppingClock());
      for (const extra of ['approved', 'approvedBy', 'approvedAt', 'approvalStatus', 'status', 'trusted', 'allowed', 'authorized', 'revokedAt', 'expiresAt', 'known', 'label']) {
        assertRegistryError(
          () => registry.register({ destination: { namespace: 'network-a', identifier: 'abc', [extra]: true } as ExecutionDestination, registeredBy: OPERATOR }),
          'DESTINATION_REGISTRY_INPUT_INVALID',
        );
        assertRegistryError(
          () => registry.register({ destination: destination('network-a', 'abc'), registeredBy: OPERATOR, [extra]: true } as never),
          'DESTINATION_REGISTRY_INPUT_INVALID',
        );
        assertRegistryError(() => registry.lookup({ namespace: 'network-a', identifier: 'abc', [extra]: true } as ExecutionDestination), 'DESTINATION_REGISTRY_INPUT_INVALID');
      }
      assert.equal(registry.lookup(destination('network-a', 'abc')).membership, 'unknown');
      await close();
    });

    it('refuses a request that is not plain data, and a malformed registeredBy', async () => {
      const { registry, close } = await open(steppingClock());
      const target = destination('network-a', 'abc');
      for (const registeredBy of ['', ' ', ' operator', 'operator\n', 'opérateur', 'x'.repeat(DESTINATION_REGISTRANT_REFERENCE_MAX_LENGTH + 1), 7, null, undefined]) {
        assertRegistryError(() => registry.register({ destination: target, registeredBy: registeredBy as string }), 'DESTINATION_REGISTRY_INPUT_INVALID');
      }
      for (const input of [null, 'network-a:abc', [target, OPERATOR]]) assertRegistryError(() => registry.register(input as never), 'DESTINATION_REGISTRY_INPUT_INVALID');
      const accessor = Object.defineProperty({ destination: target }, 'registeredBy', { get: () => OPERATOR, enumerable: true });
      assertRegistryError(() => registry.register(accessor as never), 'DESTINATION_REGISTRY_INPUT_INVALID');
      assert.equal(registry.lookup(target).membership, 'unknown');
      await close();
    });

    it('membership is the whole answer: no record or lookup carries approval, trust, status, revocation or expiry', async () => {
      const { registry, close } = await open(steppingClock());
      const result = registry.register({ destination: destination('network-a', 'abc123'), registeredBy: OPERATOR });
      const lookup = registry.lookup(destination('network-a', 'abc123'));
      assert.deepEqual(Object.keys(result).sort(), ['outcome', 'registration']);
      assert.deepEqual(Object.keys(result.registration).sort(), ['destination', 'destinationKey', 'registeredAt', 'registeredBy']);
      assert.deepEqual(Object.keys(lookup).sort(), ['membership', 'registration']);
      for (const value of [result, lookup, registry.lookup(destination('network-a', 'unknown-1'))]) {
        assert.equal(/approv|trust|allow|authori|status|revok|expir|denied|grant/i.test(JSON.stringify(value)), false, JSON.stringify(value));
      }
      // The only lookup states: unknown and known.
      assert.ok(['unknown', 'known'].includes(lookup.membership));
      await close();
    });

    it('a caller mutating its own input afterwards reaches nothing; returned records are frozen', async () => {
      const { registry, close } = await open(steppingClock());
      const input = { namespace: 'network-a', identifier: 'abc123' };
      const request = { destination: input, registeredBy: OPERATOR };
      const result = registry.register(request);
      input.identifier = 'evil';
      input.namespace = 'network-b';
      request.registeredBy = 'operator:someone-else';

      assert.equal(result.registration.destination.identifier, 'abc123');
      assert.equal(result.registration.registeredBy, OPERATOR);
      assert.equal(Object.isFrozen(result), true);
      assert.equal(Object.isFrozen(result.registration), true);
      assert.equal(Object.isFrozen(result.registration.destination), true);
      assert.throws(() => {
        (result.registration.destination as { identifier: string }).identifier = 'evil';
      }, TypeError);
      assert.throws(() => {
        (result.registration as { registeredBy: string }).registeredBy = 'evil';
      }, TypeError);

      const lookup = registry.lookup(destination('network-a', 'abc123'));
      assert.equal(lookup.membership, 'known');
      if (lookup.membership !== 'known') return;
      assert.equal(Object.isFrozen(lookup), true);
      assert.equal(Object.isFrozen(lookup.registration.destination), true);
      assert.equal(lookup.registration.destination.identifier, 'abc123');
      assert.equal(registry.lookup(destination('network-a', 'evil')).membership, 'unknown');
      assert.equal(registry.lookup(destination('network-b', 'evil')).membership, 'unknown');
      await close();
    });

    it('a clock that answers a non-canonical instant writes nothing', async () => {
      let answer = AT;
      const { registry, close } = await open(() => answer);
      answer = 'yesterday';
      assertRegistryError(() => registry.register({ destination: destination('network-a', 'abc'), registeredBy: OPERATOR }), 'DESTINATION_REGISTRY_UNAVAILABLE');
      answer = '2026-02-30T00:00:00.000Z';
      assertRegistryError(() => registry.register({ destination: destination('network-a', 'abc'), registeredBy: OPERATOR }), 'DESTINATION_REGISTRY_UNAVAILABLE');
      assert.equal(registry.lookup(destination('network-a', 'abc')).membership, 'unknown');
      answer = AT;
      assert.equal(registry.register({ destination: destination('network-a', 'abc'), registeredBy: OPERATOR }).registration.registeredAt, AT);
      await close();
    });
  });
}

describeContract('In-memory', async (now) => ({ registry: createInMemoryDestinationRegistry({ now }), close: async () => undefined }));
describeContract('SQLite', async (now) => {
  const registry = await createSqliteDestinationRegistry(freshPath(), { now });
  return { registry, close: () => registry.close() };
});

describe('Destination registry construction', () => {
  it('both implementations require an injected clock', async () => {
    assertRegistryError(() => createInMemoryDestinationRegistry({} as never), 'DESTINATION_REGISTRY_UNAVAILABLE');
    await assert.rejects(createSqliteDestinationRegistry(freshPath(), {} as never), (error: unknown) => isDestinationRegistryError(error) && error.code === 'DESTINATION_REGISTRY_UNAVAILABLE');
    await assert.rejects(createSqliteDestinationRegistry('  ', { now: steppingClock() }), (error: unknown) => isDestinationRegistryError(error) && error.code === 'DESTINATION_REGISTRY_UNAVAILABLE');
  });
});

describe('SQLite destination registry — durability', () => {
  it('a registration survives close → reopen: process B reads exactly what process A wrote', async () => {
    const path = freshPath();
    const processA = await createSqliteDestinationRegistry(path, { now: steppingClock() });
    const written = processA.register({ destination: destination('network-a', 'abc123'), registeredBy: OPERATOR });
    processA.register({ destination: destination('network-b', 'abc123'), registeredBy: 'service:importer' });
    await processA.close();

    const processB = await createSqliteDestinationRegistry(path, { now: steppingClock('2027-01-01T00:00:00.000Z') });
    const lookup = processB.lookup(destination('network-a', 'abc123'));
    assert.equal(lookup.membership, 'known');
    if (lookup.membership !== 'known') return;
    assert.deepEqual(lookup.registration, written.registration);
    assert.equal(processB.lookup(destination('network-b', 'abc123')).membership, 'known');
    assert.equal(processB.lookup(destination('network-a', 'xyz789')).membership, 'unknown');

    // Re-registering after restart is still `existing`, with the original provenance.
    const replay = processB.register({ destination: destination('network-a', 'abc123'), registeredBy: 'operator:ops-2' });
    assert.equal(replay.outcome, 'existing');
    assert.deepEqual(replay.registration, written.registration);
    await processB.close();
  });

  it('initialization is idempotent: reopening records no second version and touches no row', async () => {
    const path = freshPath();
    for (let opening = 0; opening < 3; opening += 1) {
      const registry = await createSqliteDestinationRegistry(path, { now: steppingClock() });
      if (opening === 0) registry.register({ destination: destination('network-a', 'abc'), registeredBy: OPERATOR });
      await registry.close();
    }
    const db = new Database(path, { readonly: true });
    assert.deepEqual(db.prepare(`SELECT schema_version, migration_state FROM destination_registry_versions`).all(), [{ schema_version: DESTINATION_REGISTRY_SCHEMA_VERSION, migration_state: 'current' }]);
    assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM registered_destinations`).get() as { n: number }).n, 1);
    db.close();
  });

  it('stores identity exactly: two spellings differing only in case are two rows', async () => {
    const path = freshPath();
    const registry = await createSqliteDestinationRegistry(path, { now: steppingClock() });
    registry.register({ destination: destination('network-a', 'abc'), registeredBy: OPERATOR });
    registry.register({ destination: destination('network-a', 'ABC'), registeredBy: OPERATOR });
    await registry.close();
    const db = new Database(path, { readonly: true });
    assert.deepEqual(db.prepare(`SELECT destination_key, namespace, identifier FROM registered_destinations ORDER BY destination_key`).all(), [
      { destination_key: 'network-a:ABC', namespace: 'network-a', identifier: 'ABC' },
      { destination_key: 'network-a:abc', namespace: 'network-a', identifier: 'abc' },
    ]);
    db.close();
  });

  it('the schema has no approval, trust, status, revocation or expiry column', async () => {
    const path = freshPath();
    await (await createSqliteDestinationRegistry(path, { now: steppingClock() })).close();
    const db = new Database(path, { readonly: true });
    const columns = (db.prepare(`PRAGMA table_info(registered_destinations)`).all() as { readonly name: string }[]).map((column) => column.name);
    db.close();
    assert.deepEqual(columns, ['destination_key', 'namespace', 'identifier', 'registered_by', 'registered_at', 'schema_version']);
  });

  it('triggers refuse UPDATE and DELETE; a duplicate identity is refused by key and by (namespace, identifier)', async () => {
    const path = freshPath();
    const registry = await createSqliteDestinationRegistry(path, { now: steppingClock() });
    registry.register({ destination: destination('network-a', 'abc'), registeredBy: OPERATOR });
    await registry.close();
    const db = new Database(path);
    assert.throws(() => db.prepare(`UPDATE registered_destinations SET identifier = 'xyz'`).run(), /immutable/);
    assert.throws(() => db.prepare(`UPDATE registered_destinations SET registered_by = 'someone-else'`).run(), /immutable/);
    assert.throws(() => db.prepare(`DELETE FROM registered_destinations`).run(), /immutable/);
    const insert = db.prepare(`INSERT INTO registered_destinations VALUES (?, ?, ?, ?, ?, ?)`);
    assert.throws(() => insert.run('network-a:abc', 'network-a', 'abc', OPERATOR, AT, DESTINATION_REGISTRY_SCHEMA_VERSION), /UNIQUE|PRIMARY/);
    assert.throws(() => insert.run('forged-key', 'network-a', 'abc', OPERATOR, AT, DESTINATION_REGISTRY_SCHEMA_VERSION), /UNIQUE/);
    assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM registered_destinations`).get() as { n: number }).n, 1);
    db.close();
  });

  it('a file recorded under an unknown schema version is refused, unmutated', async () => {
    const path = freshPath();
    const seed = new Database(path);
    seed.exec(`CREATE TABLE destination_registry_versions (id INTEGER PRIMARY KEY AUTOINCREMENT, schema_version TEXT NOT NULL, migration_state TEXT NOT NULL, recorded_at TEXT NOT NULL)`);
    seed.prepare(`INSERT INTO destination_registry_versions (schema_version, migration_state, recorded_at) VALUES (?, 'current', ?)`).run('aoc.destination-registry.schema.v99', AT);
    seed.close();
    await assert.rejects(createSqliteDestinationRegistry(path, { now: steppingClock() }), (error: unknown) => isDestinationRegistryError(error) && error.code === 'DESTINATION_REGISTRY_UNAVAILABLE');
    const db = new Database(path, { readonly: true });
    assert.equal(db.prepare(`SELECT 1 FROM sqlite_master WHERE name = 'registered_destinations'`).get(), undefined);
    db.close();
  });

  const corruptions: readonly (readonly [string, readonly unknown[]])[] = [
    ['an identifier re-spelled under its key', ['network-a:abc', 'network-a', 'ABC', OPERATOR, AT, DESTINATION_REGISTRY_SCHEMA_VERSION]],
    ['a namespace re-spelled under its key', ['network-a:abc', 'network-b', 'abc', OPERATOR, AT, DESTINATION_REGISTRY_SCHEMA_VERSION]],
    ['a malformed identifier', ['network-a:abc', 'network-a', 'abc ', OPERATOR, AT, DESTINATION_REGISTRY_SCHEMA_VERSION]],
    ['a non-text identifier', ['network-a:abc', 'network-a', 42, OPERATOR, AT, DESTINATION_REGISTRY_SCHEMA_VERSION]],
    ['a blank registered_by', ['network-a:abc', 'network-a', 'abc', '', AT, DESTINATION_REGISTRY_SCHEMA_VERSION]],
    ['a non-canonical registered_at', ['network-a:abc', 'network-a', 'abc', OPERATOR, '2026-10-01', DESTINATION_REGISTRY_SCHEMA_VERSION]],
    ['an unknown record schema version', ['network-a:abc', 'network-a', 'abc', OPERATOR, AT, 'aoc.destination-registry.schema.v0']],
  ];
  for (const [name, row] of corruptions) {
    it(`fails closed on ${name} — never read as unknown, never repaired`, async () => {
      const path = freshPath();
      await (await createSqliteDestinationRegistry(path, { now: steppingClock() })).close();
      const raw = new Database(path);
      raw.prepare(`INSERT INTO registered_destinations VALUES (?, ?, ?, ?, ?, ?)`).run(...row);
      raw.close();
      const registry = await createSqliteDestinationRegistry(path, { now: steppingClock() });
      assertRegistryError(() => registry.lookup(destination('network-a', 'abc')), 'DESTINATION_REGISTRY_CORRUPT');
      assertRegistryError(() => registry.register({ destination: destination('network-a', 'abc'), registeredBy: OPERATOR }), 'DESTINATION_REGISTRY_CORRUPT');
      await registry.close();
    });
  }

  it('a closed registry refuses every call', async () => {
    const registry = await createSqliteDestinationRegistry(freshPath(), { now: steppingClock() });
    await registry.close();
    await registry.close();
    assertRegistryError(() => registry.lookup(destination('network-a', 'abc')), 'DESTINATION_REGISTRY_UNAVAILABLE');
    assertRegistryError(() => registry.register({ destination: destination('network-a', 'abc'), registeredBy: OPERATOR }), 'DESTINATION_REGISTRY_UNAVAILABLE');
  });

  it('two connections on one file in one process: the second registration is `existing`', async () => {
    const path = freshPath();
    const first = await createSqliteDestinationRegistry(path, { now: steppingClock() });
    const second = await createSqliteDestinationRegistry(path, { now: steppingClock('2027-01-01T00:00:00.000Z') });
    const a = first.register({ destination: destination('network-a', 'abc'), registeredBy: 'operator:a' });
    const b = second.register({ destination: destination('network-a', 'abc'), registeredBy: 'operator:b' });
    assert.equal(a.outcome, 'registered');
    assert.equal(b.outcome, 'existing');
    assert.deepEqual(b.registration, a.registration);
    await first.close();
    await second.close();
  });
});

describe('SQLite destination registry — genuinely parallel duplicate registration', () => {
  interface RaceOutcome {
    readonly outcome: string;
    readonly registeredBy?: string;
    readonly registeredAt?: string;
  }

  async function race(path: string, participants: number, target: ExecutionDestination): Promise<readonly RaceOutcome[]> {
    const barrier = new SharedArrayBuffer(4);
    const gate = new Int32Array(barrier);
    let ready = 0;
    const workers = Array.from(
      { length: participants },
      (_, index) =>
        new Worker(join(__dirname, 'destination-registry-concurrency-worker.js'), {
          workerData: { path, barrier, destination: { namespace: target.namespace, identifier: target.identifier }, registeredBy: `operator:racer-${String(index)}`, clockStart: `2026-10-0${String(1 + (index % 8))}T00:00:00.000Z` },
        }),
    );
    const results = workers.map(
      (worker) =>
        new Promise<RaceOutcome>((resolve, reject) => {
          worker.on('error', reject);
          worker.on('message', (message: { kind: string } & RaceOutcome) => {
            if (message.kind === 'ready') {
              ready += 1;
              if (ready === workers.length) {
                Atomics.store(gate, 0, 1);
                Atomics.notify(gate, 0);
              }
            } else if (message.kind === 'done') {
              resolve(message);
            }
          });
        }),
    );
    const outcomes = await Promise.all(results);
    await Promise.all(workers.map((worker) => worker.terminate()));
    return outcomes;
  }

  it('parallel writers registering one destination converge on one row: one `registered`, the rest `existing`, all naming the winner', async () => {
    for (let round = 0; round < 3; round += 1) {
      const path = freshPath();
      // Create the schema first so every racer contends on registration, not initialization.
      await (await createSqliteDestinationRegistry(path, { now: steppingClock() })).close();
      const outcomes = await race(path, 6, destination('network-a', `race-${String(round)}`));
      assert.equal(outcomes.filter((result) => result.outcome === 'registered').length, 1, JSON.stringify(outcomes));
      assert.equal(outcomes.filter((result) => result.outcome === 'existing').length, 5, JSON.stringify(outcomes));
      const winner = outcomes.find((result) => result.outcome === 'registered');
      for (const result of outcomes) {
        assert.equal(result.registeredBy, winner?.registeredBy);
        assert.equal(result.registeredAt, winner?.registeredAt);
      }
      const db = new Database(path, { readonly: true });
      assert.deepEqual(db.prepare(`SELECT destination_key, registered_by, registered_at FROM registered_destinations`).all(), [
        { destination_key: `network-a:race-${String(round)}`, registered_by: winner?.registeredBy, registered_at: winner?.registeredAt },
      ]);
      db.close();
    }
  });

  it('parallel writers opening a brand-new file still initialize it once and record one row', async () => {
    const path = freshPath();
    const outcomes = await race(path, 4, destination('network-a', 'race-fresh'));
    assert.equal(outcomes.filter((result) => result.outcome === 'registered').length, 1, JSON.stringify(outcomes));
    const db = new Database(path, { readonly: true });
    assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM destination_registry_versions`).get() as { n: number }).n, 1);
    assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM registered_destinations`).get() as { n: number }).n, 1);
    db.close();
  });
});
