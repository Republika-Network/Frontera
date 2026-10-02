import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';

import Database from 'better-sqlite3';

import { executionDestinationKey, parseExecutionDestination, type ExecutionDestination } from '../../features/destination-runtime/index.js';
import type { DestinationRegistryPort } from '../../features/destination-runtime/registry/index.js';
import {
  isDestinationApprovalActive,
  isDestinationApprovalError,
  isDestinationApprovalOrganizationId,
  type DestinationApprovalErrorCode,
  type DestinationGovernanceAuthority,
} from '../../features/destination-runtime/approval/index.js';
import { isCanonicalCustomerIdentifier } from '../customer-identity/identifiers.js';
import { EnterpriseHttpError } from '../api/enterprise-http-errors.js';
import { createOperatorAuthenticator } from '../operator-control/operator-authenticator.js';
import { createSqliteDestinationRegistry } from '../destination-registry/index.js';
import {
  DESTINATION_APPROVAL_SCHEMA_VERSION,
  createDestinationApprovalAdministration,
  createSqliteDestinationApprovalStore,
  type DurableDestinationApprovalStore,
} from '../destination-approval/index.js';

/**
 * ANDREW-P0-03 — destination governance approval.
 *
 * Approval is organization-scoped, explicit, attributable, revocable and
 * optionally expiring, and is never implied by registry membership. Durable
 * history is append-only and verified on every read; damage is refused, never
 * read as "never approved".
 */

const AT = '2026-10-02T12:00:00.000Z';
const ORG_A = 'org-a';
const ORG_B = 'org-b';
const ADMIN = 'operator:admin-1';
const BASIS = 'operator-permission:destination.approve;role:organization-administrator;credential:operator';
const REVOKE_BASIS = 'operator-permission:destination.revoke;role:organization-administrator;credential:operator';

const directories: string[] = [];
after(() => {
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
});

function freshDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'aoc-destination-approval-'));
  directories.push(directory);
  return directory;
}

/** A clock the test sets: every read and write samples exactly the instant the test says. */
function manualClock(start = AT): { readonly now: () => string; set(instant: string): void; advance(ms: number): string } {
  let current = start;
  return {
    now: () => current,
    set(instant: string) {
      current = instant;
    },
    advance(ms: number) {
      current = new Date(Date.parse(current) + ms).toISOString();
      return current;
    },
  };
}

function destination(namespace: string, identifier: string): ExecutionDestination {
  const parsed = parseExecutionDestination({ namespace, identifier });
  assert.equal(parsed.valid, true);
  return (parsed as { readonly destination: ExecutionDestination }).destination;
}

function authority(organizationId: string, actorRef = ADMIN, authorityBasis = BASIS): DestinationGovernanceAuthority {
  return { authenticated: true, organizationId, actorRef, authorityBasis };
}

function assertApprovalError(fn: () => unknown, code: DestinationApprovalErrorCode): void {
  assert.throws(fn, (error: unknown) => {
    assert.ok(isDestinationApprovalError(error), String(error));
    assert.equal(error.code, code, error.message);
    return true;
  });
}

interface World {
  readonly registry: DestinationRegistryPort & { close(): Promise<void> };
  readonly store: DurableDestinationApprovalStore;
  readonly clock: ReturnType<typeof manualClock>;
  readonly registryPath: string;
  readonly approvalPath: string;
  register(target: ExecutionDestination): void;
  reopen(): Promise<World>;
  close(): Promise<void>;
}

async function world(directory = freshDirectory(), clock = manualClock()): Promise<World> {
  const registryPath = join(directory, 'destination-registry.sqlite');
  const approvalPath = join(directory, 'destination-approval.sqlite');
  const registry = await createSqliteDestinationRegistry(registryPath, { now: clock.now });
  const store = await createSqliteDestinationApprovalStore(approvalPath, { now: clock.now, registry });
  return {
    registry,
    store,
    clock,
    registryPath,
    approvalPath,
    register(target) {
      registry.register({ destination: target, registeredBy: 'operator:registrar' });
    },
    async reopen() {
      await store.close();
      await registry.close();
      return world(directory, clock);
    },
    async close() {
      await store.close();
      await registry.close();
    },
  };
}

const D = destination('network-a', 'abc123');

function raw(path: string): Database.Database {
  return new Database(path);
}

function count(path: string, table: string): number {
  const db = new Database(path, { readonly: true });
  const n = (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  db.close();
  return n;
}

describe('Destination approval — known is not approved', () => {
  it('a known destination that was never approved is `never-approved`, and not active', async () => {
    const w = await world();
    w.register(D);
    assert.equal(w.registry.lookup(D).membership, 'known');
    const state = w.store.read({ organizationId: ORG_A, destination: D });
    assert.deepEqual(state, { state: 'never-approved', organizationId: ORG_A, destinationKey: 'network-a:abc123' });
    assert.equal(isDestinationApprovalActive(state), false);
    assert.deepEqual(w.store.history({ organizationId: ORG_A, destination: D }), []);
    await w.close();
  });

  it('an unknown destination cannot be approved — refused, nothing registered, nothing recorded', async () => {
    const w = await world();
    assertApprovalError(() => w.store.approve(authority(ORG_A), { destination: D, idempotencyKey: 'approve-0001' }), 'DESTINATION_APPROVAL_DESTINATION_UNKNOWN');
    assert.equal(w.registry.lookup(D).membership, 'unknown', 'approval never registers a destination');
    assert.equal(w.store.read({ organizationId: ORG_A, destination: D }).state, 'never-approved');
    await w.close();
    assert.equal(count(w.approvalPath, 'destination_approval_events'), 0);
    assert.equal(count(w.approvalPath, 'destination_approval_commands'), 0, 'not even the idempotency key is consumed');
  });

  it('every registered destination is unapproved for every organization until one explicitly approves it', async () => {
    const w = await world();
    const targets = [D, destination('network-b', 'abc123'), destination('network-a', 'ABC123'), destination('scheme', 'scheme://destination/123')];
    for (const target of targets) w.register(target);
    for (const target of targets) {
      for (const organizationId of [ORG_A, ORG_B, 'default']) assert.equal(w.store.read({ organizationId, destination: target }).state, 'never-approved');
    }
    await w.close();
  });
});

describe('Destination approval — organization scope', () => {
  it('approving for organization A records the decision with its provenance, and leaves organization B unapproved', async () => {
    const w = await world();
    w.register(D);
    w.clock.set('2026-10-02T12:00:05.000Z');
    const result = w.store.approve(authority(ORG_A), { destination: D, idempotencyKey: 'approve-0001' });
    assert.equal(result.outcome, 'approved');
    assert.equal(result.replayed, false);
    assert.deepEqual(result.approval, {
      organizationId: ORG_A,
      destination: { namespace: 'network-a', identifier: 'abc123' },
      destinationKey: 'network-a:abc123',
      sequence: 1,
      approvedBy: ADMIN,
      authorityBasis: BASIS,
      approvedAt: '2026-10-02T12:00:05.000Z',
      expiresAt: null,
    });

    const a = w.store.read({ organizationId: ORG_A, destination: D });
    assert.equal(a.state, 'approved');
    assert.equal(isDestinationApprovalActive(a), true);
    if (a.state === 'approved') assert.deepEqual(a.approval, result.approval);

    const b = w.store.read({ organizationId: ORG_B, destination: D });
    assert.deepEqual(b, { state: 'never-approved', organizationId: ORG_B, destinationKey: 'network-a:abc123' });
    assert.deepEqual(w.store.history({ organizationId: ORG_B, destination: D }), [], "organization B cannot see organization A's record");
    assert.equal(/org-a|admin-1/.test(JSON.stringify(b)), false);
    await w.close();
  });

  it("organization A's revocation leaves organization B's own approval of the same destination active", async () => {
    const w = await world();
    w.register(D);
    w.store.approve(authority(ORG_A), { destination: D, idempotencyKey: 'approve-a-001' });
    w.store.approve(authority(ORG_B, 'operator:admin-b'), { destination: D, idempotencyKey: 'approve-b-001' });
    w.clock.advance(1000);
    assert.equal(w.store.revoke(authority(ORG_A, ADMIN, REVOKE_BASIS), { destination: D, idempotencyKey: 'revoke-a-001' }).outcome, 'revoked');
    assert.equal(w.store.read({ organizationId: ORG_A, destination: D }).state, 'revoked');
    const b = w.store.read({ organizationId: ORG_B, destination: D });
    assert.equal(b.state, 'approved');
    if (b.state === 'approved') assert.equal(b.approval.approvedBy, 'operator:admin-b');
    await w.close();
  });

  it('a write takes its organization from the authority only: the same idempotency key is independent per organization', async () => {
    const w = await world();
    w.register(D);
    const a = w.store.approve(authority(ORG_A), { destination: D, idempotencyKey: 'shared-key-0001' });
    const b = w.store.approve(authority(ORG_B), { destination: D, idempotencyKey: 'shared-key-0001' });
    assert.equal(a.outcome, 'approved');
    assert.equal(b.outcome, 'approved');
    assert.equal(b.replayed, false);
    assert.equal(b.approval.organizationId, ORG_B);
    assert.notEqual(a.approval.sequence, b.approval.sequence);
    await w.close();
  });

  it('the same identifier under two namespaces, and case-different spellings, are separate approvals', async () => {
    const w = await world();
    const lower = destination('network-a', 'rabc');
    const upper = destination('network-a', 'RABC');
    const other = destination('network-b', 'rabc');
    for (const target of [lower, upper, other]) w.register(target);
    w.store.approve(authority(ORG_A), { destination: lower, idempotencyKey: 'approve-0001' });
    assert.equal(w.store.read({ organizationId: ORG_A, destination: lower }).state, 'approved');
    assert.equal(w.store.read({ organizationId: ORG_A, destination: upper }).state, 'never-approved');
    assert.equal(w.store.read({ organizationId: ORG_A, destination: other }).state, 'never-approved');
    await w.close();
  });
});

describe('Destination approval — identity, provenance and refusal of self-assertion', () => {
  it('approval does not alter the destination identity or its registry record', async () => {
    const w = await world();
    w.register(D);
    const before = w.registry.lookup(D);
    const { approval } = w.store.approve(authority(ORG_A), { destination: D, idempotencyKey: 'approve-0001' });
    assert.deepEqual(approval.destination, D);
    assert.equal(approval.destinationKey, executionDestinationKey(D));
    assert.deepEqual(w.registry.lookup(D), before, 'the registry record is untouched: same registrant, same instant, no new field');
    await w.close();
    const db = new Database(w.registryPath, { readonly: true });
    const columns = (db.prepare(`PRAGMA table_info(registered_destinations)`).all() as { name: string }[]).map((column) => column.name);
    db.close();
    assert.deepEqual(columns, ['destination_key', 'namespace', 'identifier', 'registered_by', 'registered_at', 'schema_version']);
  });

  it('approval fields cannot be supplied through the destination, the command, the query or the authority', async () => {
    const w = await world();
    w.register(D);
    for (const extra of ['approved', 'approvedBy', 'approvedAt', 'approvalStatus', 'status', 'state', 'authorityBasis', 'organizationId', 'revokedAt', 'trusted', 'label']) {
      assertApprovalError(
        () => w.store.approve(authority(ORG_A), { destination: { namespace: 'network-a', identifier: 'abc123', [extra]: true } as ExecutionDestination, idempotencyKey: 'approve-0001' }),
        'DESTINATION_APPROVAL_INPUT_INVALID',
      );
      assertApprovalError(() => w.store.approve(authority(ORG_A), { destination: D, idempotencyKey: 'approve-0001', [extra]: ORG_B } as never), 'DESTINATION_APPROVAL_INPUT_INVALID');
      assertApprovalError(() => w.store.revoke(authority(ORG_A), { destination: D, idempotencyKey: 'revoke-0001', [extra]: true } as never), 'DESTINATION_APPROVAL_INPUT_INVALID');
      if (extra !== 'organizationId') {
        assertApprovalError(() => w.store.read({ organizationId: ORG_A, destination: D, [extra]: true } as never), 'DESTINATION_APPROVAL_INPUT_INVALID');
        assertApprovalError(() => w.store.approve({ ...authority(ORG_A), [extra]: true } as never, { destination: D, idempotencyKey: 'approve-0001' }), 'DESTINATION_APPROVAL_AUTHORITY_INVALID');
      }
    }
    assert.equal(w.store.read({ organizationId: ORG_A, destination: D }).state, 'never-approved');
    await w.close();
    assert.equal(count(w.approvalPath, 'destination_approval_commands'), 0);
  });

  it('refuses a write without an authenticated, well-formed authority', async () => {
    const w = await world();
    w.register(D);
    const command = { destination: D, idempotencyKey: 'approve-0001' };
    for (const bad of [
      undefined,
      null,
      'operator:admin-1',
      { organizationId: ORG_A, actorRef: ADMIN, authorityBasis: BASIS },
      { authenticated: 'true', organizationId: ORG_A, actorRef: ADMIN, authorityBasis: BASIS },
      { authenticated: true, organizationId: '', actorRef: ADMIN, authorityBasis: BASIS },
      { authenticated: true, organizationId: ' org-a', actorRef: ADMIN, authorityBasis: BASIS },
      { authenticated: true, organizationId: ORG_A, actorRef: '', authorityBasis: BASIS },
      { authenticated: true, organizationId: ORG_A, actorRef: ADMIN, authorityBasis: 'line\nbreak' },
      Object.defineProperty({ authenticated: true, actorRef: ADMIN, authorityBasis: BASIS }, 'organizationId', { get: () => ORG_A, enumerable: true }),
    ]) {
      assertApprovalError(() => w.store.approve(bad as never, command), 'DESTINATION_APPROVAL_AUTHORITY_INVALID');
      assertApprovalError(() => w.store.revoke(bad as never, { destination: D, idempotencyKey: 'revoke-0001' }), 'DESTINATION_APPROVAL_AUTHORITY_INVALID');
    }
    assert.equal(w.store.read({ organizationId: ORG_A, destination: D }).state, 'never-approved');
    await w.close();
  });

  it('refuses malformed commands and queries: destinations, expiry, idempotency keys, organizations', async () => {
    const w = await world();
    w.register(D);
    for (const expiresAt of ['tomorrow', '2026-10-03', '2026-02-30T00:00:00.000Z', 42]) {
      assertApprovalError(() => w.store.approve(authority(ORG_A), { destination: D, idempotencyKey: 'approve-0001', expiresAt } as never), 'DESTINATION_APPROVAL_INPUT_INVALID');
    }
    for (const idempotencyKey of [undefined, '', 'short', ' approve-0001', 'approve 0001', 'x'.repeat(129), 7]) {
      assertApprovalError(() => w.store.approve(authority(ORG_A), { destination: D, idempotencyKey } as never), 'DESTINATION_APPROVAL_INPUT_INVALID');
    }
    for (const bad of [null, {}, { namespace: 'network-a' }, { namespace: 'Network-A', identifier: 'abc' }, { namespace: 'network-a', identifier: 'abc ' }]) {
      assertApprovalError(() => w.store.approve(authority(ORG_A), { destination: bad as never, idempotencyKey: 'approve-0001' }), 'DESTINATION_APPROVAL_INPUT_INVALID');
      assertApprovalError(() => w.store.read({ organizationId: ORG_A, destination: bad as never }), 'DESTINATION_APPROVAL_INPUT_INVALID');
    }
    for (const organizationId of [undefined, '', ' org-a', 'org-a\n', 'x'.repeat(257), 3]) {
      assertApprovalError(() => w.store.read({ organizationId, destination: D } as never), 'DESTINATION_APPROVAL_INPUT_INVALID');
    }
    assertApprovalError(() => w.store.read({ destination: D } as never), 'DESTINATION_APPROVAL_INPUT_INVALID');
    await w.close();
  });

  it('an expiry not later than the decision instant is refused, and nothing is recorded', async () => {
    const w = await world();
    w.register(D);
    for (const expiresAt of [AT, '2026-10-02T11:59:59.999Z']) {
      assertApprovalError(() => w.store.approve(authority(ORG_A), { destination: D, idempotencyKey: 'approve-0001', expiresAt }), 'DESTINATION_APPROVAL_INPUT_INVALID');
    }
    assert.equal(w.store.read({ organizationId: ORG_A, destination: D }).state, 'never-approved');
    await w.close();
    assert.equal(count(w.approvalPath, 'destination_approval_commands'), 0);
  });

  it('a caller mutating its own objects afterwards reaches nothing; returned records are frozen', async () => {
    const w = await world();
    w.register(D);
    const target = { namespace: 'network-a', identifier: 'abc123' };
    const context = { ...authority(ORG_A) } as { authenticated: true; organizationId: string; actorRef: string; authorityBasis: string };
    const command = { destination: target, idempotencyKey: 'approve-0001' };
    const result = w.store.approve(context, command);
    target.identifier = 'evil';
    context.organizationId = ORG_B;
    context.actorRef = 'operator:mallory';
    command.idempotencyKey = 'approve-9999';

    assert.equal(result.approval.destination.identifier, 'abc123');
    assert.equal(result.approval.organizationId, ORG_A);
    assert.equal(result.approval.approvedBy, ADMIN);
    for (const value of [result, result.approval, result.approval.destination]) assert.equal(Object.isFrozen(value), true);
    assert.throws(() => {
      (result.approval as { approvedBy: string }).approvedBy = 'operator:mallory';
    }, TypeError);
    assert.throws(() => {
      (result.approval as { expiresAt: string | null }).expiresAt = '2099-01-01T00:00:00.000Z';
    }, TypeError);

    const state = w.store.read({ organizationId: ORG_A, destination: D });
    assert.equal(Object.isFrozen(state), true);
    assert.equal(state.state === 'approved' && state.approval.approvedBy, ADMIN);
    assert.equal(w.store.read({ organizationId: ORG_B, destination: D }).state, 'never-approved');
    const history = w.store.history({ organizationId: ORG_A, destination: D });
    assert.equal(Object.isFrozen(history), true);
    assert.throws(() => (history as unknown as unknown[]).push({}), TypeError);
    await w.close();
  });
});

describe('Destination approval — idempotency', () => {
  it('a retried approval under the same key replays the original outcome and record: one event, deterministic', async () => {
    const w = await world();
    w.register(D);
    const first = w.store.approve(authority(ORG_A), { destination: D, idempotencyKey: 'approve-0001' });
    for (let attempt = 0; attempt < 10; attempt += 1) {
      w.clock.advance(1000);
      const replay = w.store.approve(authority(ORG_A), { destination: D, idempotencyKey: 'approve-0001' });
      assert.deepEqual(replay, { outcome: 'approved', approval: first.approval, replayed: true });
    }
    await w.close();
    assert.equal(count(w.approvalPath, 'destination_approval_events'), 1);
    assert.equal(count(w.approvalPath, 'destination_approval_commands'), 1);
  });

  it('a second approval under a new key while one is active is `already-approved`: the first stands, its terms and provenance intact', async () => {
    const w = await world();
    w.register(D);
    const first = w.store.approve(authority(ORG_A), { destination: D, idempotencyKey: 'approve-0001', expiresAt: '2026-12-31T00:00:00.000Z' });
    w.clock.advance(60_000);
    const second = w.store.approve(authority(ORG_A, 'operator:admin-2'), { destination: D, idempotencyKey: 'approve-0002' });
    assert.equal(second.outcome, 'already-approved');
    assert.equal(second.replayed, false);
    assert.deepEqual(second.approval, first.approval);
    assert.equal(second.approval.approvedBy, ADMIN);
    assert.equal(second.approval.expiresAt, '2026-12-31T00:00:00.000Z');
    // Its own retry replays `already-approved`, not a fresh evaluation.
    assert.deepEqual(w.store.approve(authority(ORG_A, 'operator:admin-2'), { destination: D, idempotencyKey: 'approve-0002' }), { ...second, replayed: true });
    await w.close();
    assert.equal(count(w.approvalPath, 'destination_approval_events'), 1, 'no contradictory second approval');
  });

  it('the same key for a different request is refused — different destination, terms, operation or actor', async () => {
    const w = await world();
    const other = destination('network-a', 'xyz789');
    w.register(D);
    w.register(other);
    w.store.approve(authority(ORG_A), { destination: D, idempotencyKey: 'approve-0001' });
    assertApprovalError(() => w.store.approve(authority(ORG_A), { destination: other, idempotencyKey: 'approve-0001' }), 'DESTINATION_APPROVAL_IDEMPOTENCY_CONFLICT');
    assertApprovalError(() => w.store.approve(authority(ORG_A), { destination: D, idempotencyKey: 'approve-0001', expiresAt: '2027-01-01T00:00:00.000Z' }), 'DESTINATION_APPROVAL_IDEMPOTENCY_CONFLICT');
    assertApprovalError(() => w.store.revoke(authority(ORG_A), { destination: D, idempotencyKey: 'approve-0001' }), 'DESTINATION_APPROVAL_IDEMPOTENCY_CONFLICT');
    assertApprovalError(() => w.store.approve(authority(ORG_A, 'operator:admin-2'), { destination: D, idempotencyKey: 'approve-0001' }), 'DESTINATION_APPROVAL_IDEMPOTENCY_CONFLICT');
    assert.equal(w.store.read({ organizationId: ORG_A, destination: other }).state, 'never-approved');
    assert.equal(w.store.read({ organizationId: ORG_A, destination: D }).state, 'approved');
    await w.close();
  });

  it('a late retry of an approval after a revocation replays — it never silently re-approves', async () => {
    const w = await world();
    w.register(D);
    const approved = w.store.approve(authority(ORG_A), { destination: D, idempotencyKey: 'approve-0001' });
    w.clock.advance(1000);
    w.store.revoke(authority(ORG_A, ADMIN, REVOKE_BASIS), { destination: D, idempotencyKey: 'revoke-0001' });
    w.clock.advance(1000);
    const late = w.store.approve(authority(ORG_A), { destination: D, idempotencyKey: 'approve-0001' });
    assert.deepEqual(late, { outcome: 'approved', approval: approved.approval, replayed: true });
    assert.equal(w.store.read({ organizationId: ORG_A, destination: D }).state, 'revoked', 'still revoked');
    await w.close();
  });

  it('revocation retries are deterministic: same key replays, a new key is `already-revoked`', async () => {
    const w = await world();
    w.register(D);
    w.store.approve(authority(ORG_A), { destination: D, idempotencyKey: 'approve-0001' });
    w.clock.advance(1000);
    const first = w.store.revoke(authority(ORG_A, ADMIN, REVOKE_BASIS), { destination: D, idempotencyKey: 'revoke-0001' });
    assert.equal(first.outcome, 'revoked');
    w.clock.advance(1000);
    assert.deepEqual(w.store.revoke(authority(ORG_A, ADMIN, REVOKE_BASIS), { destination: D, idempotencyKey: 'revoke-0001' }), { ...first, replayed: true });
    const again = w.store.revoke(authority(ORG_A, 'operator:responder-1', REVOKE_BASIS), { destination: D, idempotencyKey: 'revoke-0002' });
    assert.equal(again.outcome, 'already-revoked');
    if (again.outcome === 'already-revoked' && first.outcome === 'revoked') assert.deepEqual(again.revocation, first.revocation);
    await w.close();
    assert.equal(count(w.approvalPath, 'destination_approval_events'), 2);
  });

  it('revoking what is not active records nothing: never approved, or already expired, is `not-active`', async () => {
    const w = await world();
    w.register(D);
    assert.deepEqual(w.store.revoke(authority(ORG_A), { destination: D, idempotencyKey: 'revoke-0001' }), { outcome: 'not-active', destinationKey: 'network-a:abc123', replayed: false });
    assert.deepEqual(w.store.revoke(authority(ORG_A), { destination: D, idempotencyKey: 'revoke-0001' }), { outcome: 'not-active', destinationKey: 'network-a:abc123', replayed: true });
    w.store.approve(authority(ORG_A), { destination: D, idempotencyKey: 'approve-0001', expiresAt: '2026-10-02T13:00:00.000Z' });
    w.clock.set('2026-10-02T13:00:00.000Z');
    assert.equal(w.store.revoke(authority(ORG_A), { destination: D, idempotencyKey: 'revoke-0002' }).outcome, 'not-active');
    assert.equal(w.store.read({ organizationId: ORG_A, destination: D }).state, 'expired', 'expired stays expired, not revoked');
    await w.close();
    assert.equal(count(w.approvalPath, 'destination_approval_events'), 1);
  });
});

describe('Destination approval — revocation, expiry and re-approval', () => {
  it('revocation ends the approval with its own provenance; the approval itself is kept unchanged', async () => {
    const w = await world();
    w.register(D);
    const { approval } = w.store.approve(authority(ORG_A), { destination: D, idempotencyKey: 'approve-0001' });
    w.clock.set('2026-10-02T15:30:00.000Z');
    const result = w.store.revoke(authority(ORG_A, 'operator:responder-1', 'operator-permission:destination.revoke;role:responder;credential:operator'), { destination: D, idempotencyKey: 'revoke-0001' });
    assert.equal(result.outcome, 'revoked');
    if (result.outcome !== 'revoked') return;
    assert.deepEqual(result.revocation, {
      organizationId: ORG_A,
      destinationKey: 'network-a:abc123',
      sequence: 2,
      approvalSequence: approval.sequence,
      revokedBy: 'operator:responder-1',
      revocationBasis: 'operator-permission:destination.revoke;role:responder;credential:operator',
      revokedAt: '2026-10-02T15:30:00.000Z',
    });
    const state = w.store.read({ organizationId: ORG_A, destination: D });
    assert.equal(state.state, 'revoked');
    assert.equal(isDestinationApprovalActive(state), false);
    if (state.state === 'revoked') {
      assert.deepEqual(state.approval, approval, 'historical approval remains, approvedAt untouched');
      assert.deepEqual(state.revocation, result.revocation);
    }
    await w.close();
  });

  it('expiry is evaluated against the injected clock: active until the instant before, expired exactly at expiresAt', async () => {
    const w = await world();
    w.register(D);
    const expiresAt = '2026-10-02T18:00:00.000Z';
    const { approval } = w.store.approve(authority(ORG_A), { destination: D, idempotencyKey: 'approve-0001', expiresAt });
    assert.equal(approval.expiresAt, expiresAt);
    w.clock.set('2026-10-02T17:59:59.999Z');
    assert.equal(w.store.read({ organizationId: ORG_A, destination: D }).state, 'approved');
    w.clock.set(expiresAt);
    const atBoundary = w.store.read({ organizationId: ORG_A, destination: D });
    assert.equal(atBoundary.state, 'expired');
    assert.equal(isDestinationApprovalActive(atBoundary), false);
    w.clock.set('2027-01-01T00:00:00.000Z');
    const later = w.store.read({ organizationId: ORG_A, destination: D });
    assert.equal(later.state, 'expired');
    if (later.state === 'expired') assert.deepEqual(later.approval, approval, 'expiry does not rewrite approvedAt or anything else');
    // Expiry is derived, not written: the history is exactly the one approval.
    assert.deepEqual(w.store.history({ organizationId: ORG_A, destination: D }), [{ transition: 'approved', approval }]);
    // And a clock that moves back reads the same history as active again — expiry is a function of trusted time, not a stored flag.
    w.clock.set('2026-10-02T17:00:00.000Z');
    assert.equal(w.store.read({ organizationId: ORG_A, destination: D }).state, 'approved');
    await w.close();
    assert.equal(count(w.approvalPath, 'destination_approval_events'), 1);
  });

  it('approve → revoke → approve is a new lifecycle; the full history remains, oldest first', async () => {
    const w = await world();
    w.register(D);
    const first = w.store.approve(authority(ORG_A), { destination: D, idempotencyKey: 'approve-0001' });
    w.clock.advance(1000);
    const revoked = w.store.revoke(authority(ORG_A, ADMIN, REVOKE_BASIS), { destination: D, idempotencyKey: 'revoke-0001' });
    w.clock.advance(1000);
    const second = w.store.approve(authority(ORG_A, 'operator:admin-2'), { destination: D, idempotencyKey: 'approve-0002', expiresAt: '2027-01-01T00:00:00.000Z' });
    assert.equal(second.outcome, 'approved');
    assert.equal(second.approval.sequence, 3);
    assert.equal(second.approval.approvedBy, 'operator:admin-2');

    const state = w.store.read({ organizationId: ORG_A, destination: D });
    assert.equal(state.state, 'approved');
    if (state.state === 'approved') assert.deepEqual(state.approval, second.approval);
    const history = w.store.history({ organizationId: ORG_A, destination: D });
    assert.deepEqual(
      history.map((entry) => entry.transition),
      ['approved', 'revoked', 'approved'],
    );
    assert.deepEqual(history[0], { transition: 'approved', approval: first.approval });
    if (revoked.outcome === 'revoked') assert.deepEqual(history[1], { transition: 'revoked', revocation: revoked.revocation });

    // And it can be revoked again, naming the second approval.
    w.clock.advance(1000);
    const again = w.store.revoke(authority(ORG_A, ADMIN, REVOKE_BASIS), { destination: D, idempotencyKey: 'revoke-0002' });
    assert.equal(again.outcome === 'revoked' && again.revocation.approvalSequence, 3);
    await w.close();
  });

  it('an expired approval can be approved again; the expired one stays in history', async () => {
    const w = await world();
    w.register(D);
    const first = w.store.approve(authority(ORG_A), { destination: D, idempotencyKey: 'approve-0001', expiresAt: '2026-10-02T13:00:00.000Z' });
    w.clock.set('2026-10-02T13:00:00.000Z');
    const second = w.store.approve(authority(ORG_A), { destination: D, idempotencyKey: 'approve-0002' });
    assert.equal(second.outcome, 'approved');
    assert.deepEqual(
      w.store.history({ organizationId: ORG_A, destination: D }).map((entry) => (entry.transition === 'approved' ? entry.approval.sequence : -1)),
      [first.approval.sequence, second.approval.sequence],
    );
    assert.equal(w.store.read({ organizationId: ORG_A, destination: D }).state, 'approved');
    await w.close();
  });
});

describe('Destination approval — durability', () => {
  it('approval, revocation and history survive close → reopen exactly', async () => {
    let w = await world();
    w.register(D);
    const approved = w.store.approve(authority(ORG_A), { destination: D, idempotencyKey: 'approve-0001' });
    w.store.approve(authority(ORG_B), { destination: D, idempotencyKey: 'approve-0001' });

    w = await w.reopen();
    const afterRestart = w.store.read({ organizationId: ORG_A, destination: D });
    assert.equal(afterRestart.state, 'approved');
    if (afterRestart.state === 'approved') {
      assert.deepEqual(afterRestart.approval, approved.approval);
      assert.equal(afterRestart.approval.approvedBy, ADMIN);
      assert.equal(afterRestart.approval.authorityBasis, BASIS);
      assert.equal(afterRestart.approval.approvedAt, AT);
    }
    // The idempotency journal is durable too.
    assert.equal(w.store.approve(authority(ORG_A), { destination: D, idempotencyKey: 'approve-0001' }).replayed, true);

    w.clock.advance(1000);
    const revoked = w.store.revoke(authority(ORG_A, ADMIN, REVOKE_BASIS), { destination: D, idempotencyKey: 'revoke-0001' });
    w = await w.reopen();
    const state = w.store.read({ organizationId: ORG_A, destination: D });
    assert.equal(state.state, 'revoked');
    if (state.state === 'revoked' && revoked.outcome === 'revoked') assert.deepEqual(state.revocation, revoked.revocation);
    assert.equal(w.store.history({ organizationId: ORG_A, destination: D }).length, 2);
    assert.equal(w.store.read({ organizationId: ORG_B, destination: D }).state, 'approved');
    await w.close();
  });

  it('initialization is idempotent: reopening appends no version row and leaves the head where it was', async () => {
    const directory = freshDirectory();
    for (let opening = 0; opening < 3; opening += 1) {
      const w = await world(directory);
      if (opening === 0) {
        w.register(D);
        w.store.approve(authority(ORG_A), { destination: D, idempotencyKey: 'approve-0001' });
      }
      await w.close();
    }
    const db = new Database(join(directory, 'destination-approval.sqlite'), { readonly: true });
    assert.deepEqual(db.prepare(`SELECT schema_version, migration_state FROM destination_approval_versions`).all(), [{ schema_version: DESTINATION_APPROVAL_SCHEMA_VERSION, migration_state: 'current' }]);
    assert.deepEqual(db.prepare(`SELECT event_sequence, event_count, command_count FROM destination_approval_head`).all(), [{ event_sequence: 1, event_count: 1, command_count: 1 }]);
    db.close();
  });

  it('the schema holds history, not a mutable status: no approved/active flag column', async () => {
    const w = await world();
    await w.close();
    const db = new Database(w.approvalPath, { readonly: true });
    const columns = (db.prepare(`PRAGMA table_info(destination_approval_events)`).all() as { name: string }[]).map((column) => column.name);
    db.close();
    assert.deepEqual(columns, [
      'sequence',
      'organization_id',
      'destination_key',
      'namespace',
      'identifier',
      'transition',
      'actor_ref',
      'authority_basis',
      'recorded_at',
      'expires_at',
      'approval_sequence',
      'previous_event_digest',
      'event_digest',
      'schema_version',
    ]);
    assert.equal(columns.some((column) => /status|active|approved$/.test(column)), false);
  });

  it('SQLite itself refuses UPDATE and DELETE of history, a second active approval, and an invalid revocation', async () => {
    const w = await world();
    w.register(D);
    w.store.approve(authority(ORG_A), { destination: D, idempotencyKey: 'approve-0001', expiresAt: '2026-10-02T18:00:00.000Z' });
    await w.close();
    const db = raw(w.approvalPath);
    assert.throws(() => db.prepare(`UPDATE destination_approval_events SET actor_ref = 'operator:mallory'`).run(), /immutable/);
    assert.throws(() => db.prepare(`UPDATE destination_approval_events SET expires_at = NULL`).run(), /immutable/);
    assert.throws(() => db.prepare(`DELETE FROM destination_approval_events`).run(), /immutable/);
    assert.throws(() => db.prepare(`DELETE FROM destination_approval_commands`).run(), /immutable/);
    assert.throws(() => db.prepare(`UPDATE destination_approval_commands SET outcome = 'not-active'`).run(), /immutable/);
    const insert = db.prepare(
      `INSERT INTO destination_approval_events (sequence, organization_id, destination_key, namespace, identifier, transition, actor_ref, authority_basis, recorded_at, expires_at, approval_sequence, previous_event_digest, event_digest, schema_version)
       VALUES (?, ?, 'network-a:abc123', 'network-a', 'abc123', ?, 'operator:x', 'basis', ?, NULL, ?, 'sha256:x', 'sha256:y', ?)`,
    );
    // A second approval while the first is active for the same organization.
    assert.throws(() => insert.run(2, ORG_A, 'approved', '2026-10-02T12:30:00.000Z', null, DESTINATION_APPROVAL_SCHEMA_VERSION), /already active/);
    // A revocation of an approval that is not this organization's latest, active one.
    assert.throws(() => insert.run(2, ORG_B, 'revoked', '2026-10-02T12:30:00.000Z', 1, DESTINATION_APPROVAL_SCHEMA_VERSION), /active approval/);
    assert.throws(() => insert.run(2, ORG_A, 'revoked', '2026-10-02T18:00:00.000Z', 1, DESTINATION_APPROVAL_SCHEMA_VERSION), /active approval/, 'not after it expired');
    // An approval carrying a revocation pointer, or a revocation carrying an expiry.
    assert.throws(() => insert.run(2, ORG_B, 'approved', AT, 1, DESTINATION_APPROVAL_SCHEMA_VERSION), /CHECK/);
    assert.throws(() => insert.run(2, ORG_A, 'paused', AT, null, DESTINATION_APPROVAL_SCHEMA_VERSION), /CHECK/);
    db.close();
  });

  it('a closed store refuses every call', async () => {
    const w = await world();
    w.register(D);
    await w.store.close();
    await w.store.close();
    assertApprovalError(() => w.store.read({ organizationId: ORG_A, destination: D }), 'DESTINATION_APPROVAL_UNAVAILABLE');
    assertApprovalError(() => w.store.history({ organizationId: ORG_A, destination: D }), 'DESTINATION_APPROVAL_UNAVAILABLE');
    assertApprovalError(() => w.store.approve(authority(ORG_A), { destination: D, idempotencyKey: 'approve-0001' }), 'DESTINATION_APPROVAL_UNAVAILABLE');
    assertApprovalError(() => w.store.revoke(authority(ORG_A), { destination: D, idempotencyKey: 'revoke-0001' }), 'DESTINATION_APPROVAL_UNAVAILABLE');
    await w.registry.close();
  });

  it('a clock that answers a non-canonical instant reads nothing and writes nothing', async () => {
    const w = await world();
    w.register(D);
    w.store.approve(authority(ORG_A), { destination: D, idempotencyKey: 'approve-0001' });
    for (const answer of ['yesterday', '2026-02-30T00:00:00.000Z', '2026-10-02T12:00:00Z']) {
      w.clock.set(answer);
      assertApprovalError(() => w.store.read({ organizationId: ORG_A, destination: D }), 'DESTINATION_APPROVAL_UNAVAILABLE');
      assertApprovalError(() => w.store.revoke(authority(ORG_A), { destination: D, idempotencyKey: 'revoke-0001' }), 'DESTINATION_APPROVAL_UNAVAILABLE');
    }
    w.clock.set(AT);
    assert.equal(w.store.read({ organizationId: ORG_A, destination: D }).state, 'approved');
    await w.close();
  });

  it('construction requires a path, an injected clock and the registry reader', async () => {
    const directory = freshDirectory();
    const registry = await createSqliteDestinationRegistry(join(directory, 'r.sqlite'), { now: () => AT });
    const isUnavailable = (error: unknown) => isDestinationApprovalError(error) && error.code === 'DESTINATION_APPROVAL_UNAVAILABLE';
    await assert.rejects(createSqliteDestinationApprovalStore(join(directory, 'a.sqlite'), { registry } as never), isUnavailable);
    await assert.rejects(createSqliteDestinationApprovalStore(join(directory, 'a.sqlite'), { now: () => AT } as never), isUnavailable);
    await assert.rejects(createSqliteDestinationApprovalStore('  ', { now: () => AT, registry }), isUnavailable);
    await registry.close();
  });
});

describe('Destination approval — fails closed on damaged or unknown state', () => {
  /** Approve, then revoke, then close: the shape whose damage would fail *open*. */
  async function revokedWorld(): Promise<World> {
    const w = await world();
    w.register(D);
    w.store.approve(authority(ORG_A), { destination: D, idempotencyKey: 'approve-0001' });
    w.clock.advance(1000);
    w.store.revoke(authority(ORG_A, ADMIN, REVOKE_BASIS), { destination: D, idempotencyKey: 'revoke-0001' });
    await w.close();
    return w;
  }

  const damages: readonly (readonly [string, (db: Database.Database) => void])[] = [
    [
      'a deleted revocation (which would re-activate the approval)',
      (db) => {
        db.exec(`DROP TRIGGER destination_approval_events_append_only_delete`);
        db.exec(`DELETE FROM destination_approval_events WHERE transition = 'revoked'`);
      },
    ],
    [
      'a deleted approval',
      (db) => {
        db.exec(`DROP TRIGGER destination_approval_events_append_only_delete`);
        db.exec(`DELETE FROM destination_approval_events WHERE sequence = 1`);
      },
    ],
    [
      'a rewritten old event (approver changed)',
      (db) => {
        db.exec(`DROP TRIGGER destination_approval_events_append_only_update`);
        db.exec(`UPDATE destination_approval_events SET actor_ref = 'operator:mallory' WHERE sequence = 1`);
      },
    ],
    [
      'a revocation flipped into an approval',
      (db) => {
        db.exec(`DROP TRIGGER destination_approval_events_append_only_update`);
        db.exec(`UPDATE destination_approval_events SET transition = 'approved', approval_sequence = NULL WHERE sequence = 2`);
      },
    ],
    [
      'an expiry quietly added to history',
      (db) => {
        db.exec(`DROP TRIGGER destination_approval_events_append_only_update`);
        db.exec(`UPDATE destination_approval_events SET expires_at = '2099-01-01T00:00:00.000Z' WHERE sequence = 1`);
      },
    ],
    [
      'an event moved to another organization',
      (db) => {
        db.exec(`DROP TRIGGER destination_approval_events_append_only_update`);
        db.exec(`UPDATE destination_approval_events SET organization_id = '${ORG_B}' WHERE sequence = 2`);
      },
    ],
    [
      'a re-spelled destination under its key',
      (db) => {
        db.exec(`DROP TRIGGER destination_approval_events_append_only_update`);
        db.exec(`UPDATE destination_approval_events SET identifier = 'ABC123' WHERE sequence = 1`);
      },
    ],
    ['a deleted head', (db) => db.exec(`DELETE FROM destination_approval_head`)],
    ['a head pointing at an older history', (db) => db.exec(`UPDATE destination_approval_head SET event_sequence = 1, event_count = 1`)],
    [
      'a deleted idempotency record',
      (db) => {
        db.exec(`DROP TRIGGER destination_approval_commands_append_only_delete`);
        db.exec(`DELETE FROM destination_approval_commands WHERE idempotency_key = 'revoke-0001'`);
      },
    ],
    ['every state table dropped', (db) => db.exec(`DROP TABLE destination_approval_events; DROP TABLE destination_approval_commands; DROP TABLE destination_approval_head;`)],
    [
      'an unknown record schema version',
      (db) => {
        db.exec(`DROP TRIGGER destination_approval_events_append_only_update`);
        db.exec(`UPDATE destination_approval_events SET schema_version = 'aoc.destination-approval.schema.v0' WHERE sequence = 1`);
      },
    ],
  ];

  for (const [name, damage] of damages) {
    it(`${name} is DESTINATION_APPROVAL_CORRUPT — never approved, never never-approved, never repaired`, async () => {
      const damaged = await revokedWorld();
      const db = raw(damaged.approvalPath);
      damage(db);
      db.close();
      const w = await world(join(damaged.approvalPath, '..'), damaged.clock);
      assertApprovalError(() => w.store.read({ organizationId: ORG_A, destination: D }), 'DESTINATION_APPROVAL_CORRUPT');
      assertApprovalError(() => w.store.read({ organizationId: ORG_B, destination: D }), 'DESTINATION_APPROVAL_CORRUPT');
      assertApprovalError(() => w.store.history({ organizationId: ORG_A, destination: D }), 'DESTINATION_APPROVAL_CORRUPT');
      assertApprovalError(() => w.store.approve(authority(ORG_A), { destination: D, idempotencyKey: 'approve-0002' }), 'DESTINATION_APPROVAL_CORRUPT');
      assertApprovalError(() => w.store.revoke(authority(ORG_A), { destination: D, idempotencyKey: 'revoke-0002' }), 'DESTINATION_APPROVAL_CORRUPT');
      await w.close();
    });
  }

  it('a tampered idempotency record cannot steer a replay', async () => {
    const damaged = await revokedWorld();
    const db = raw(damaged.approvalPath);
    db.exec(`DROP TRIGGER destination_approval_commands_append_only_update`);
    db.exec(`UPDATE destination_approval_commands SET outcome = 'already-approved' WHERE idempotency_key = 'approve-0001'`);
    db.close();
    const w = await world(join(damaged.approvalPath, '..'), damaged.clock);
    assertApprovalError(() => w.store.approve(authority(ORG_A), { destination: D, idempotencyKey: 'approve-0001' }), 'DESTINATION_APPROVAL_CORRUPT');
    await w.close();
  });

  it('a file recorded under an unknown schema version is refused, unmutated', async () => {
    const directory = freshDirectory();
    const seed = new Database(join(directory, 'destination-approval.sqlite'));
    seed.exec(`CREATE TABLE destination_approval_versions (id INTEGER PRIMARY KEY AUTOINCREMENT, schema_version TEXT NOT NULL, migration_state TEXT NOT NULL, recorded_at TEXT NOT NULL)`);
    seed.prepare(`INSERT INTO destination_approval_versions (schema_version, migration_state, recorded_at) VALUES (?, 'current', ?)`).run('aoc.destination-approval.schema.v99', AT);
    seed.close();
    await assert.rejects(world(directory), (error: unknown) => isDestinationApprovalError(error) && error.code === 'DESTINATION_APPROVAL_UNAVAILABLE');
    const db = new Database(join(directory, 'destination-approval.sqlite'), { readonly: true });
    assert.equal(db.prepare(`SELECT 1 FROM sqlite_master WHERE name = 'destination_approval_events'`).get(), undefined);
    db.close();
  });

  it('approval tables with no schema-version record are refused rather than adopted as new', async () => {
    const damaged = await revokedWorld();
    const db = raw(damaged.approvalPath);
    db.exec(`DROP TABLE destination_approval_versions`);
    db.close();
    await assert.rejects(world(join(damaged.approvalPath, '..'), damaged.clock), (error: unknown) => isDestinationApprovalError(error) && error.code === 'DESTINATION_APPROVAL_UNAVAILABLE');
  });
});

describe('Destination approval — administrative service (CTRL-02 operator plane)', () => {
  const KEYS = { admin: 'k-admin-0000000000000000000000000001', responder: 'k-responder-00000000000000000000001', observer: 'k-observer-000000000000000000000001', legacy: 'k-legacy-0000000000000000000000000001', customer: 'k-customer-0000000000000000000000001' } as const;
  const bearer = (key: string) => `Bearer ${key}`;

  function authenticatorFor(organizationId: string) {
    return createOperatorAuthenticator({
      administrators: [{ operatorId: 'legacy-1', key: KEYS.legacy }],
      operators: [
        { operatorId: 'admin-1', role: 'organization-administrator', key: KEYS.admin },
        { operatorId: 'responder-1', role: 'responder', key: KEYS.responder },
        { operatorId: 'observer-1', role: 'observer', key: KEYS.observer },
      ],
      ordinaryCredentials: [{ key: KEYS.customer }],
      organizationId,
      isReady: () => true,
      lifecycleState: () => 'ready',
    });
  }

  function refusedWith(status: number, code?: string) {
    return (error: unknown) => {
      assert.ok(error instanceof EnterpriseHttpError, String(error));
      assert.equal(error.httpStatus, status);
      if (code !== undefined) assert.equal(error.code, code);
      return true;
    };
  }

  it('an organization administrator approves; provenance and basis come from the authenticated principal, the organization from the Host', async () => {
    const w = await world();
    w.register(D);
    const admin = createDestinationApprovalAdministration({ authenticator: authenticatorFor(ORG_A), store: w.store });
    const result = admin.approveDestination(bearer(KEYS.admin), { destination: D, idempotencyKey: 'approve-0001' });
    assert.equal(result.outcome, 'approved');
    assert.equal(result.approval.organizationId, ORG_A);
    assert.equal(result.approval.approvedBy, 'operator:admin-1');
    assert.equal(result.approval.authorityBasis, 'operator-permission:destination.approve;role:organization-administrator;credential:operator');
    const state = admin.readDestinationApproval(bearer(KEYS.observer), { destination: D });
    assert.equal(state.state, 'approved');
    assert.equal(admin.destinationApprovalHistory(bearer(KEYS.observer), { destination: D }).length, 1);
    await w.close();
  });

  it('a command cannot name an organization, an approver, a basis or a state', async () => {
    const w = await world();
    w.register(D);
    const admin = createDestinationApprovalAdministration({ authenticator: authenticatorFor(ORG_A), store: w.store });
    for (const forged of [{ organizationId: ORG_B }, { approvedBy: 'operator:ceo' }, { authorityBasis: 'board-resolution' }, { approved: true }, { status: 'approved' }, { actorRef: 'operator:ceo' }]) {
      assertApprovalError(() => admin.approveDestination(bearer(KEYS.admin), { destination: D, idempotencyKey: 'approve-0001', ...forged }), 'DESTINATION_APPROVAL_INPUT_INVALID');
      assertApprovalError(() => admin.readDestinationApproval(bearer(KEYS.admin), { destination: D, ...forged }), 'DESTINATION_APPROVAL_INPUT_INVALID');
    }
    assert.equal(admin.readDestinationApproval(bearer(KEYS.admin), { destination: D }).state, 'never-approved');
    await w.close();
  });

  it('only the approve permission approves; revoke narrows only; nothing is written for a refused caller', async () => {
    const w = await world();
    w.register(D);
    const admin = createDestinationApprovalAdministration({ authenticator: authenticatorFor(ORG_A), store: w.store });
    const command = { destination: D, idempotencyKey: 'approve-0001' };
    assert.throws(() => admin.approveDestination(undefined, command), refusedWith(401));
    assert.throws(() => admin.approveDestination('Bearer not-a-key', command), refusedWith(401));
    assert.throws(() => admin.approveDestination(bearer(KEYS.customer), command), refusedWith(403));
    for (const key of [KEYS.responder, KEYS.observer, KEYS.legacy]) assert.throws(() => admin.approveDestination(bearer(key), command), refusedWith(403, 'OPERATOR_PERMISSION_DENIED'));
    assert.throws(() => admin.revokeDestination(bearer(KEYS.observer), { destination: D, idempotencyKey: 'revoke-0001' }), refusedWith(403, 'OPERATOR_PERMISSION_DENIED'));
    assert.throws(() => admin.revokeDestination(bearer(KEYS.legacy), { destination: D, idempotencyKey: 'revoke-0001' }), refusedWith(403, 'OPERATOR_PERMISSION_DENIED'));
    assert.throws(() => admin.readDestinationApproval(bearer(KEYS.legacy), { destination: D }), refusedWith(403, 'OPERATOR_PERMISSION_DENIED'));
    assert.equal(admin.readDestinationApproval(bearer(KEYS.observer), { destination: D }).state, 'never-approved');

    admin.approveDestination(bearer(KEYS.admin), command);
    w.clock.advance(1000);
    const revoked = admin.revokeDestination(bearer(KEYS.responder), { destination: D, idempotencyKey: 'revoke-0001' });
    assert.equal(revoked.outcome, 'revoked');
    if (revoked.outcome === 'revoked') {
      assert.equal(revoked.revocation.revokedBy, 'operator:responder-1');
      assert.equal(revoked.revocation.revocationBasis, 'operator-permission:destination.revoke;role:responder;credential:operator');
    }
    await w.close();
    assert.equal(count(w.approvalPath, 'destination_approval_events'), 2);
    assert.equal(count(w.approvalPath, 'destination_approval_commands'), 2, 'refused callers consumed no idempotency key');
  });

  it('two Hosts serving two organizations over one store never see or change each other', async () => {
    const w = await world();
    w.register(D);
    const hostA = createDestinationApprovalAdministration({ authenticator: authenticatorFor(ORG_A), store: w.store });
    const hostB = createDestinationApprovalAdministration({ authenticator: authenticatorFor(ORG_B), store: w.store });
    hostA.approveDestination(bearer(KEYS.admin), { destination: D, idempotencyKey: 'approve-0001' });
    assert.equal(hostB.readDestinationApproval(bearer(KEYS.admin), { destination: D }).state, 'never-approved');
    assert.deepEqual(hostB.destinationApprovalHistory(bearer(KEYS.admin), { destination: D }), []);
    assert.equal(hostB.revokeDestination(bearer(KEYS.admin), { destination: D, idempotencyKey: 'revoke-0001' }).outcome, 'not-active');
    assert.equal(hostA.readDestinationApproval(bearer(KEYS.admin), { destination: D }).state, 'approved');
    await w.close();
  });
});

describe('Destination approval — organization identity', () => {
  it('admits exactly what the enterprise customer-identity identifier admits', () => {
    const corpus: unknown[] = ['org-a', 'default', 'Org A', 'org/ä', 'x'.repeat(256), 'x'.repeat(257), '', ' org', 'org ', 'org\n', 'org\u0000', 'org\u0085', ' org', null, undefined, 7, {}, ['org']];
    for (const value of corpus) assert.equal(isDestinationApprovalOrganizationId(value), isCanonicalCustomerIdentifier(value), JSON.stringify(value));
  });
});

describe('Destination approval — genuinely parallel writers', () => {
  interface Participant {
    readonly operation: 'approve' | 'revoke';
    readonly organizationId: string;
    readonly idempotencyKey: string;
    readonly actorRef: string;
  }
  interface RaceOutcome {
    readonly outcome: string;
    readonly replayed?: boolean;
    readonly sequence?: number | null;
    readonly approvedBy?: string;
  }

  async function race(directory: string, target: ExecutionDestination, participants: readonly Participant[]): Promise<readonly RaceOutcome[]> {
    const barrier = new SharedArrayBuffer(4);
    const gate = new Int32Array(barrier);
    let ready = 0;
    const workers = participants.map(
      (participant) =>
        new Worker(join(__dirname, 'destination-approval-concurrency-worker.js'), {
          workerData: {
            registryPath: join(directory, 'destination-registry.sqlite'),
            approvalPath: join(directory, 'destination-approval.sqlite'),
            barrier,
            destination: { namespace: target.namespace, identifier: target.identifier },
            clockStart: '2026-10-02T13:00:00.000Z',
            ...participant,
          },
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

  it('six administrators approving one destination at once create exactly one active approval', async () => {
    for (let round = 0; round < 3; round += 1) {
      const directory = freshDirectory();
      const target = destination('network-a', `race-${String(round)}`);
      const w = await world(directory);
      w.register(target);
      await w.close();
      const outcomes = await race(
        directory,
        target,
        Array.from({ length: 6 }, (_, index) => ({ operation: 'approve' as const, organizationId: ORG_A, idempotencyKey: `approve-race-${String(index)}`, actorRef: `operator:racer-${String(index)}` })),
      );
      assert.equal(outcomes.filter((result) => result.outcome === 'approved').length, 1, JSON.stringify(outcomes));
      assert.equal(outcomes.filter((result) => result.outcome === 'already-approved').length, 5, JSON.stringify(outcomes));
      const winner = outcomes.find((result) => result.outcome === 'approved');
      for (const result of outcomes) {
        assert.equal(result.sequence, winner?.sequence);
        assert.equal(result.approvedBy, winner?.approvedBy);
      }
      assert.equal(count(join(directory, 'destination-approval.sqlite'), 'destination_approval_events'), 1);
      const reopened = await world(directory);
      assert.equal(reopened.store.read({ organizationId: ORG_A, destination: target }).state, 'approved');
      await reopened.close();
    }
  });

  it('the same command retried concurrently under one key is applied once and replayed to the rest', async () => {
    const directory = freshDirectory();
    const w = await world(directory);
    w.register(D);
    await w.close();
    const outcomes = await race(
      directory,
      D,
      Array.from({ length: 5 }, () => ({ operation: 'approve' as const, organizationId: ORG_A, idempotencyKey: 'approve-same-0001', actorRef: ADMIN })),
    );
    assert.ok(outcomes.every((result) => result.outcome === 'approved'), JSON.stringify(outcomes));
    assert.equal(outcomes.filter((result) => result.replayed === false).length, 1);
    assert.equal(count(join(directory, 'destination-approval.sqlite'), 'destination_approval_commands'), 1);
  });

  it('approvals and revocations racing for two organizations leave a consistent, verifiable history per organization', async () => {
    for (let round = 0; round < 3; round += 1) {
      const directory = freshDirectory();
      const w = await world(directory);
      w.register(D);
      w.store.approve(authority(ORG_A), { destination: D, idempotencyKey: 'approve-seed-a' });
      w.store.approve(authority(ORG_B), { destination: D, idempotencyKey: 'approve-seed-b' });
      await w.close();
      const participants: Participant[] = [];
      for (const organizationId of [ORG_A, ORG_B]) {
        for (let index = 0; index < 3; index += 1) {
          participants.push({ operation: 'revoke', organizationId, idempotencyKey: `revoke-${organizationId}-${String(index)}`, actorRef: `operator:revoker-${String(index)}` });
          participants.push({ operation: 'approve', organizationId, idempotencyKey: `approve-${organizationId}-${String(index)}`, actorRef: `operator:approver-${String(index)}` });
        }
      }
      const outcomes = await race(directory, D, participants);
      for (const result of outcomes) assert.ok(['approved', 'already-approved', 'revoked', 'already-revoked'].includes(result.outcome), JSON.stringify(result));

      const reopened = await world(directory, manualClock('2026-10-02T14:00:00.000Z'));
      for (const organizationId of [ORG_A, ORG_B]) {
        // Reads verify the whole chain and re-derive every transition: a contradiction would be CORRUPT.
        const history = reopened.store.history({ organizationId, destination: D });
        const state = reopened.store.read({ organizationId, destination: D });
        for (let index = 1; index < history.length; index += 1) assert.notEqual(history[index]?.transition, history[index - 1]?.transition, 'no two approvals, no two revocations in a row');
        assert.equal(state.state, history.at(-1)?.transition === 'revoked' ? 'revoked' : 'approved');
        const raced = outcomes.filter((_, index) => participants[index]?.organizationId === organizationId);
        assert.equal(history.length, 1 + raced.filter((result) => result.outcome === 'approved' || result.outcome === 'revoked').length);
      }
      await reopened.close();
    }
  });

  it('parallel first openings of a brand-new file initialize it once', async () => {
    const directory = freshDirectory();
    const w = await world(directory);
    w.register(D);
    await w.registry.close();
    await w.store.close();
    for (const suffix of ['', '-wal', '-shm']) rmSync(join(directory, `destination-approval.sqlite${suffix}`), { force: true });
    const outcomes = await race(
      directory,
      D,
      Array.from({ length: 4 }, (_, index) => ({ operation: 'approve' as const, organizationId: ORG_A, idempotencyKey: `approve-fresh-${String(index)}`, actorRef: `operator:racer-${String(index)}` })),
    );
    assert.equal(outcomes.filter((result) => result.outcome === 'approved').length, 1, JSON.stringify(outcomes));
    const db = new Database(join(directory, 'destination-approval.sqlite'), { readonly: true });
    assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM destination_approval_versions`).get() as { n: number }).n, 1);
    assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM destination_approval_head`).get() as { n: number }).n, 1);
    assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM destination_approval_events`).get() as { n: number }).n, 1);
    db.close();
  });
});
