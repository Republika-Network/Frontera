import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createSqliteKernelAuthorityStore } from '../kernel-authority/sqlite-kernel-authority-store.js';
import { KernelAuthorityError } from '../kernel-authority/errors.js';
import { createKernelAuthorityProvisioningService } from '../kernel-authority/provisioning-service.js';
import type { KernelAuthorityAccessContext, ProvisionActorInput } from '../kernel-authority/contracts.js';

/**
 * SQLite implementation tests for the Kernel Authority Store: file durability,
 * on-disk schema-version handling, persisted-payload corruption and
 * single-connection write serialization.
 *
 * The provider-neutral behavioural contract -- the cases that used to run here
 * once per provider -- lives in the shared conformance suite
 * (`kernel-authority-store-conformance.test.ts`), which every provider must
 * pass unchanged. Only what is specific to *this* implementation stays here.
 */

const ORG = 'org-acme';
const OPERATOR: KernelAuthorityAccessContext = { system: true, actorId: 'operator-1' };
const READER: KernelAuthorityAccessContext = { system: false, organizationId: ORG };

const closers: Array<() => Promise<void>> = [];
const tempDirs: string[] = [];
after(async () => {
  await Promise.all(closers.map((close) => close().catch(() => {})));
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function tempDbPath(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'aoc-kernel-authority-'));
  tempDirs.push(dir);
  return join(dir, `${name}.sqlite`);
}

const ACTOR: ProvisionActorInput = { actorId: 'actor-alice', type: 'human', displayName: 'Alice' };
describe('Kernel Authority Store durability and corruption handling (sqlite)', () => {
  it('reopens a closed store and reconstructs the same records', async () => {
    const path = tempDbPath('reopen');
    const first = await createSqliteKernelAuthorityStore(path);
    await createKernelAuthorityProvisioningService({ store: first, organizationId: ORG }).provisionActor(OPERATOR, ACTOR);
    await first.close();

    const second = await createSqliteKernelAuthorityStore(path);
    closers.push(() => second.close());
    const records = await second.listRecords(READER, { organizationId: ORG });
    assert.equal(records.length, 1);
    assert.equal(records[0]?.entityId, ACTOR.actorId);
    assert.equal(records[0]?.status, 'active');
  });

  it('preserves a revocation across a close/reopen cycle', async () => {
    const path = tempDbPath('revocation-durable');
    const first = await createSqliteKernelAuthorityStore(path);
    const firstService = createKernelAuthorityProvisioningService({ store: first, organizationId: ORG });
    await firstService.provisionActor(OPERATOR, ACTOR);
    await firstService.revoke(OPERATOR, { entityKind: 'actor', entityId: ACTOR.actorId, reason: 'offboarded' });
    await first.close();

    const second = await createSqliteKernelAuthorityStore(path);
    closers.push(() => second.close());
    const record = await second.getRecord(READER, ORG, 'actor', ACTOR.actorId);
    assert.equal(record?.status, 'revoked');
    assert.equal(record?.revocationReason, 'offboarded');

    // And it stays terminal in the new process, so no retry ordering resurrects it.
    await assert.rejects(
      () => createKernelAuthorityProvisioningService({ store: second, organizationId: ORG }).provisionActor(OPERATOR, ACTOR),
      (error: unknown) => error instanceof KernelAuthorityError && error.code === 'KERNEL_AUTHORITY_ENTITY_REVOKED',
    );
  });

  it('refuses to open a store recorded under a different schema version, and leaves it untouched', async () => {
    const path = tempDbPath('foreign-schema');
    const { default: Database } = await import('better-sqlite3');
    const db = new Database(path);
    db.exec(`CREATE TABLE kernel_authority_store_versions (id INTEGER PRIMARY KEY AUTOINCREMENT, schema_version TEXT NOT NULL, migration_state TEXT NOT NULL, recorded_at TEXT NOT NULL);`);
    db.prepare(`INSERT INTO kernel_authority_store_versions (schema_version, migration_state, recorded_at) VALUES (?, 'current', ?)`).run(
      'aoc.kernel-authority.schema.v99',
      '2026-01-01T00:00:00.000Z',
    );
    db.close();

    await assert.rejects(
      () => createSqliteKernelAuthorityStore(path),
      (error: unknown) => error instanceof KernelAuthorityError && error.code === 'KERNEL_AUTHORITY_VERSION_UNSUPPORTED',
    );

    const reopened = new Database(path);
    const tables = (reopened.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`).all() as { name: string }[]).map((row) => row.name);
    reopened.close();
    assert.deepEqual(
      tables.filter((name) => !name.startsWith('sqlite_')),
      ['kernel_authority_store_versions'],
      'a foreign-schema database must not have this runtime tables created in it',
    );
  });

  it('refuses to interpret a malformed persisted payload rather than skipping the record', async () => {
    const path = tempDbPath('malformed-payload');
    const store = await createSqliteKernelAuthorityStore(path);
    await createKernelAuthorityProvisioningService({ store, organizationId: ORG }).provisionActor(OPERATOR, ACTOR);
    await store.close();

    const { default: Database } = await import('better-sqlite3');
    const db = new Database(path);
    db.prepare(`UPDATE kernel_authority_events SET payload_json = ? WHERE entity_id = ?`).run('{not json', ACTOR.actorId);
    db.close();

    const reopened = await createSqliteKernelAuthorityStore(path);
    closers.push(() => reopened.close());
    await assert.rejects(
      () => reopened.listRecords(READER, { organizationId: ORG }),
      (error: unknown) => error instanceof KernelAuthorityError && error.code === 'KERNEL_AUTHORITY_INTEGRITY_FAILED',
    );
  });

  it('refuses a broken event chain rather than reading a status the events do not support', async () => {
    const path = tempDbPath('broken-chain');
    const store = await createSqliteKernelAuthorityStore(path);
    const service = createKernelAuthorityProvisioningService({ store, organizationId: ORG });
    await service.provisionActor(OPERATOR, ACTOR);
    await service.revoke(OPERATOR, { entityKind: 'actor', entityId: ACTOR.actorId, reason: 'offboarded' });
    await store.close();

    // Deleting the revocation event is the dangerous direction: a store that
    // tolerated it would report the actor active again.
    const { default: Database } = await import('better-sqlite3');
    const db = new Database(path);
    db.prepare(`DELETE FROM kernel_authority_events WHERE entity_id = ? AND sequence = 1`).run(ACTOR.actorId);
    db.close();

    const reopened = await createSqliteKernelAuthorityStore(path);
    closers.push(() => reopened.close());
    await assert.rejects(
      () => reopened.getRecord(READER, ORG, 'actor', ACTOR.actorId),
      (error: unknown) => error instanceof KernelAuthorityError && error.code === 'KERNEL_AUTHORITY_INTEGRITY_FAILED',
    );
  });

  it('refuses a record naming an entity kind this runtime cannot interpret', async () => {
    const path = tempDbPath('unknown-kind');
    const store = await createSqliteKernelAuthorityStore(path);
    await createKernelAuthorityProvisioningService({ store, organizationId: ORG }).provisionActor(OPERATOR, ACTOR);
    await store.close();

    const { default: Database } = await import('better-sqlite3');
    const db = new Database(path);
    db.pragma('foreign_keys = OFF');
    db.prepare(`UPDATE kernel_authority_records SET entity_kind = 'super-actor' WHERE entity_id = ?`).run(ACTOR.actorId);
    db.close();

    const reopened = await createSqliteKernelAuthorityStore(path);
    closers.push(() => reopened.close());
    await assert.rejects(
      () => reopened.listRecords(READER, { organizationId: ORG }),
      (error: unknown) => error instanceof KernelAuthorityError && error.code === 'KERNEL_AUTHORITY_INTEGRITY_FAILED',
    );
  });

  it('commits a concurrent duplicate provision exactly once', async () => {
    const path = tempDbPath('concurrent-provision');
    const store = await createSqliteKernelAuthorityStore(path);
    closers.push(() => store.close());
    const service = createKernelAuthorityProvisioningService({ store, organizationId: ORG });

    const results = await Promise.allSettled(Array.from({ length: 8 }, () => service.provisionActor(OPERATOR, ACTOR)));
    const committed = results.filter((result) => result.status === 'fulfilled' && result.value.replayed === false);
    assert.equal(committed.length, 1, 'exactly one of the concurrent provisions may append an event');

    const events = await store.listEvents(READER, ORG, 'actor', ACTOR.actorId);
    assert.equal(events.length, 1, 'a race must never produce a second grant for one entity');
  });

  it('serializes a concurrent revocation race into one revocation', async () => {
    const path = tempDbPath('concurrent-revoke');
    const store = await createSqliteKernelAuthorityStore(path);
    closers.push(() => store.close());
    const service = createKernelAuthorityProvisioningService({ store, organizationId: ORG });
    await service.provisionActor(OPERATOR, ACTOR);

    await Promise.allSettled(
      Array.from({ length: 8 }, (_, index) => service.revoke(OPERATOR, { entityKind: 'actor', entityId: ACTOR.actorId, reason: `reason-${index}` })),
    );

    const events = await store.listEvents(READER, ORG, 'actor', ACTOR.actorId);
    assert.equal(events.length, 2, 'provision + exactly one revocation');
    assert.equal((await store.getRecord(READER, ORG, 'actor', ACTOR.actorId))?.status, 'revoked');
  });
});
