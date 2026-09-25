import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';

import { EXERCISE_CONTROL_REASON_CODES as X, createInMemoryExerciseControlLedger, type ExerciseControlQuery } from '../../features/exercise-control-runtime/index.js';
import {
  boundedGrantDigest,
  boundedGrantDigestMatches,
  boundedGrantId,
  serializeBoundedGrant,
  serializeGrantCorrelation,
  serializeGrantScope,
  type BoundedGrant,
} from '../../features/grant-runtime/index.js';
import { TEST_CORRELATION, TEST_EXPIRES_AT, TEST_SCOPE, buildTestGrant } from '../../features/execution-runtime/tests/execution-fixture.js';
import { isBoundedGrantStoreError } from '../bounded-grant-store/index.js';
import { openDurableStore } from './authority-authenticity-fixture.js';
import {
  GRANT_AUTHORITY_BINDING_FORMAT,
  exerciseAuthorityBindingDigestResolver,
  grantAuthorityBindingDigest,
  serializeGrantAuthorityBinding,
  type ExerciseAuthorityBindingResolver,
  type GrantAuthorityBinding,
} from '../execution-governance/index.js';
import { ALLOWED_INTENT, IDENTITY, NOW, NO_TEMPORAL_BOUND, ORG, buildGovernedWorld } from './governed-action-support.js';

/**
 * §22–§25, §47, §52 — the authority binding a grant was issued under becomes
 * durable provenance on the grant, is revalidated for exact equality at
 * exercise time, and pre-P7 grants keep their bytes, identity and digest.
 */

const directories: string[] = [];
after(() => {
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
});

const MANDATE: GrantAuthorityBinding = { kind: 'bounded-authority', authorityKind: 'mandate', authorityRef: 'mandate:m-1', expiresAt: '2026-01-02T00:00:00.000Z' };

describe('§22 canonical authority-binding serialization and digest', () => {
  it('serializes every meaningful field in fixed lexicographic order, with the format in the bytes', () => {
    assert.equal(
      serializeGrantAuthorityBinding(MANDATE),
      `{"authorityKind":"mandate","authorityRef":"mandate:m-1","expiresAt":"2026-01-02T00:00:00.000Z","format":"${GRANT_AUTHORITY_BINDING_FORMAT}","kind":"bounded-authority"}`,
    );
    assert.equal(
      serializeGrantAuthorityBinding(NO_TEMPORAL_BOUND),
      `{"format":"${GRANT_AUTHORITY_BINDING_FORMAT}","justification":${JSON.stringify(NO_TEMPORAL_BOUND.kind === 'no-temporal-authority-bound' ? NO_TEMPORAL_BOUND.justification : '')},"kind":"no-temporal-authority-bound","sourceKind":"standing-capability"}`,
    );
  });

  it('2. is deterministic and independent of the object key order a host happens to build', () => {
    const reordered = { expiresAt: MANDATE.kind === 'bounded-authority' ? MANDATE.expiresAt : '', authorityRef: 'mandate:m-1', kind: 'bounded-authority', authorityKind: 'mandate' } as GrantAuthorityBinding;
    assert.equal(grantAuthorityBindingDigest(reordered), grantAuthorityBindingDigest(MANDATE));
    assert.match(grantAuthorityBindingDigest(MANDATE), /^sha256:[0-9a-f]{64}$/);
  });

  it('3–7. covers authorityRef, expiry, kind, authority kind, source kind and justification', () => {
    const base = grantAuthorityBindingDigest(MANDATE);
    const variants: GrantAuthorityBinding[] = [
      { ...MANDATE, authorityRef: 'mandate:m-2' },
      { ...MANDATE, expiresAt: '2026-01-01T06:00:00.000Z' },
      { ...MANDATE, authorityKind: 'representative-authority' },
      NO_TEMPORAL_BOUND,
    ];
    for (const variant of variants) assert.notEqual(grantAuthorityBindingDigest(variant), base);
    const standing = grantAuthorityBindingDigest(NO_TEMPORAL_BOUND);
    assert.notEqual(grantAuthorityBindingDigest({ kind: 'no-temporal-authority-bound', sourceKind: 'organizational-authority', justification: NO_TEMPORAL_BOUND.kind === 'no-temporal-authority-bound' ? NO_TEMPORAL_BOUND.justification : '' }), standing);
    assert.notEqual(grantAuthorityBindingDigest({ kind: 'no-temporal-authority-bound', sourceKind: 'standing-capability', justification: 'a different reason' }), standing);
  });
});

describe('§25 the exercise-time bridge: host binding → canonical digest', () => {
  const query = {} as ExerciseControlQuery;
  const digestOf = (resolver: ExerciseAuthorityBindingResolver) => exerciseAuthorityBindingDigestResolver(resolver)(query);

  it('a well-formed binding becomes its canonical digest', () => {
    assert.equal(digestOf(() => MANDATE), grantAuthorityBindingDigest(MANDATE));
  });

  it('13–14. undefined, a throw, a promise, a malformed or an accessor-bearing binding are all undefined (unverifiable)', () => {
    const accessor = { ...MANDATE };
    Object.defineProperty(accessor, 'authorityRef', { enumerable: true, get: () => 'mandate:m-1' });
    for (const resolver of [
      () => undefined,
      () => {
        throw new Error('down');
      },
      () => Promise.resolve(MANDATE) as unknown as GrantAuthorityBinding,
      () => ({ ...MANDATE, expiresAt: 'not-a-date' }),
      () => ({ ...MANDATE, authorityKind: 'self-asserted' }) as unknown as GrantAuthorityBinding,
      () => ({ kind: 'no-temporal-authority-bound', sourceKind: 'standing-capability', justification: '   ' }) as GrantAuthorityBinding,
      () => ({ kind: 'unbounded' }) as unknown as GrantAuthorityBinding,
      () => accessor,
    ] satisfies ExerciseAuthorityBindingResolver[]) {
      assert.equal(digestOf(resolver), undefined);
    }
  });
});

describe('§24 issuance records the binding digest, and §47 exercise revalidates it exactly', () => {
  function governed(options: { readonly issuedUnder?: GrantAuthorityBinding; readonly atExercise?: ExerciseAuthorityBindingResolver } = {}) {
    const inner = createInMemoryExerciseControlLedger({ now: () => NOW });
    const reserves: string[] = [];
    const ledger = { ...inner, reserve: (request: Parameters<typeof inner.reserve>[0]) => (reserves.push(request.reservationId), inner.reserve(request)) };
    const queries: ExerciseControlQuery[] = [];
    const world = buildGovernedWorld({
      resolveAuthorityBinding: () => options.issuedUnder ?? MANDATE,
      exerciseControls: {
        policy: () => [],
        revalidateAuthorityBinding: (query) => {
          queries.push(query);
          return (options.atExercise ?? (() => options.issuedUnder ?? MANDATE))(query);
        },
        reservationLedger: ledger,
      },
    });
    return { world, ledger, queries, reserves };
  }

  async function issuedGrant(world: ReturnType<typeof buildGovernedWorld>, requestId: string | undefined): Promise<BoundedGrant> {
    const record = await world.store.getByRequestId({ system: false, organizationId: ORG }, requestId ?? '');
    const grantId = record?.references.find((reference) => reference.referenceType === 'authorization_artifact')?.externalId;
    assert.ok(grantId !== undefined);
    const read = await world.grantStore.read(grantId);
    assert.ok(read.grant !== undefined);
    return read.grant;
  }

  it('1–2 / 8. a new ACE grant carries the canonical digest of the binding it was issued under, and the exact binding permits', async () => {
    const { world, queries } = governed();
    const result = await world.orchestrator.govern(IDENTITY, ALLOWED_INTENT);
    assert.equal(result.status, 'executed', JSON.stringify(result));
    const grant = await issuedGrant(world, result.requestId);
    assert.equal(grant.authorityBindingDigest, grantAuthorityBindingDigest(MANDATE));
    assert.ok(boundedGrantDigestMatches(grant));
    assert.equal(world.adapter.callCount, 1);
    assert.equal(queries.length, 2, 'revalidated before and after the reservation');
  });

  const changed: readonly (readonly [string, GrantAuthorityBinding])[] = [
    ['9. changed authorityRef with the same expiry', { ...MANDATE, authorityRef: 'mandate:m-2' }],
    ['10. same authorityRef, shortened expiry that still outlasts the grant', { ...MANDATE, expiresAt: '2026-01-01T06:00:00.000Z' }],
    ['10b. same authorityRef, extended expiry', { ...MANDATE, expiresAt: '2027-01-01T00:00:00.000Z' }],
    ['11. bounded → no-temporal', NO_TEMPORAL_BOUND],
  ];
  for (const [label, current] of changed) {
    it(`${label} → withheld / exercise / AUTHORITY_BINDING_CHANGED; no reservation, no adapter`, async () => {
      const { world, reserves } = governed({ atExercise: () => current });
      const result = await world.orchestrator.govern(IDENTITY, ALLOWED_INTENT);
      assert.equal(result.status, 'withheld');
      assert.equal(result.status === 'withheld' ? result.withheldBy : undefined, 'exercise');
      assert.deepEqual([...result.reasonCodes], [X.EXERCISE_CONTROL_AUTHORITY_BINDING_CHANGED]);
      assert.equal(world.adapter.callCount, 0);
      assert.deepEqual(reserves, [], 'revalidation #1 runs before any reservation');
    });
  }

  it('a changed no-temporal justification is a changed binding', async () => {
    const { world } = governed({ issuedUnder: NO_TEMPORAL_BOUND, atExercise: () => ({ kind: 'no-temporal-authority-bound', sourceKind: 'standing-capability', justification: 'Reworded after the fact.' }) });
    const result = await world.orchestrator.govern(IDENTITY, ALLOWED_INTENT);
    assert.deepEqual([...result.reasonCodes], [X.EXERCISE_CONTROL_AUTHORITY_BINDING_CHANGED]);
    assert.equal(world.adapter.callCount, 0);
  });

  it('12–14. an undefined, malformed or throwing exercise-time resolver withholds as unverifiable', async () => {
    for (const atExercise of [
      () => undefined,
      () => ({ ...MANDATE, expiresAt: 'garbage' }),
      () => {
        throw new Error('authority store down');
      },
    ] satisfies ExerciseAuthorityBindingResolver[]) {
      const { world } = governed({ atExercise });
      const result = await world.orchestrator.govern(IDENTITY, ALLOWED_INTENT);
      assert.equal(result.status === 'withheld' ? result.withheldBy : undefined, 'exercise');
      assert.deepEqual([...result.reasonCodes], [X.EXERCISE_CONTROL_AUTHORITY_BINDING_UNVERIFIABLE]);
      assert.equal(world.adapter.callCount, 0);
    }
  });

  it('18. the exercise-time resolver receives trusted grant material only — no intent, no asserted context, no Kernel request', async () => {
    const { world, queries } = governed();
    await world.orchestrator.govern(IDENTITY, ALLOWED_INTENT);
    for (const query of queries) {
      const serialized = JSON.stringify(query);
      for (const value of Object.values(ALLOWED_INTENT.assertedContext)) assert.equal(serialized.includes(String(value)), false, 'assertedContext never reaches the resolver');
      assert.equal(serialized.includes(ALLOWED_INTENT.idempotencyKey), false, 'the raw intent never reaches the resolver');
      assert.equal('request' in query, false, 'no synthesized KernelEvaluationRequest');
      assert.equal(query.subject, IDENTITY.actor.actorId);
    }
  });

  it('the commit-boundary binding comparison is still load-bearing at issuance: a binding that changes between issuance and commit issues nothing', async () => {
    let calls = 0;
    const world = buildGovernedWorld({
      resolveAuthorityBinding: () => {
        calls += 1;
        return calls === 1 ? MANDATE : { ...MANDATE, authorityRef: 'mandate:m-2' };
      },
    });
    const result = await world.orchestrator.govern(IDENTITY, ALLOWED_INTENT);
    assert.equal(result.status, 'withheld');
    assert.equal(world.adapter.callCount, 0);
    assert.equal(world.issueOutcomes[0]?.outcome, 'refused');
  });
});

describe('§23 / §52 bounded-grant backward compatibility', () => {
  /** The pre-P7 identity formula, restated verbatim from the baseline so "unchanged" is measured against the old code's bytes rather than the new code's. */
  function prePhase7GrantId(grant: Pick<BoundedGrant, 'correlation' | 'subject' | 'scope' | 'expiresAt'>): string {
    const canonical = `{${serializeGrantCorrelation(grant.correlation)},"expiresAt":${JSON.stringify(grant.expiresAt)},"scope":${serializeGrantScope(grant.scope)},"subject":${JSON.stringify(grant.subject)}}`;
    return `aoc.grant:${createHash('sha256').update(canonical).digest('hex').slice(0, 32)}`;
  }

  const legacy = buildTestGrant();
  const provenanced = buildTestGrant({ authorityBindingDigest: grantAuthorityBindingDigest(MANDATE) });

  it('a pre-P7 grant keeps its canonical bytes, its deterministic id and its digest', () => {
    assert.equal(legacy.authorityBindingDigest, undefined);
    assert.equal(legacy.id, prePhase7GrantId(legacy));
    assert.equal(legacy.id, 'aoc.grant:' + createHash('sha256').update(`{${serializeGrantCorrelation(TEST_CORRELATION)},"expiresAt":${JSON.stringify(TEST_EXPIRES_AT)},"scope":${serializeGrantScope(TEST_SCOPE)},"subject":"agent-A"}`).digest('hex').slice(0, 32));
    assert.equal(serializeBoundedGrant(legacy).includes('authorityBindingDigest'), false);
    assert.ok(serializeBoundedGrant(legacy).startsWith('{"correlation":'), 'the pre-P7 canonical form starts exactly where it always did');
    assert.ok(boundedGrantDigestMatches(legacy));
  });

  it('a grant with provenance gets a deterministic, different identity and digest, with the digest inside both', () => {
    assert.notEqual(provenanced.id, legacy.id);
    assert.equal(provenanced.id, boundedGrantId({ correlation: TEST_CORRELATION, subject: 'agent-A', scope: TEST_SCOPE, expiresAt: TEST_EXPIRES_AT, authorityBindingDigest: grantAuthorityBindingDigest(MANDATE) }));
    assert.ok(serializeBoundedGrant(provenanced).startsWith('{"authorityBindingDigest":'), 'lexicographically first');
    assert.ok(boundedGrantDigestMatches(provenanced));
  });

  it('removing or modifying the provenance fails integrity', () => {
    const { authorityBindingDigest: _removed, ...stripped } = provenanced;
    assert.equal(boundedGrantDigestMatches(stripped as BoundedGrant), false);
    assert.equal(boundedGrantDigestMatches({ ...provenanced, authorityBindingDigest: grantAuthorityBindingDigest(NO_TEMPORAL_BOUND) }), false);
    assert.equal(boundedGrantDigestMatches({ ...legacy, authorityBindingDigest: grantAuthorityBindingDigest(MANDATE) }), false, 'provenance cannot be bolted onto a legacy grant');
    const rebuilt = { ...provenanced, digest: boundedGrantDigest({ ...provenanced }) };
    assert.ok(boundedGrantDigestMatches(rebuilt));
  });

  async function storeWith(grant: BoundedGrant): Promise<string> {
    const directory = mkdtempSync(join(tmpdir(), 'aoc-grant-compat-'));
    directories.push(directory);
    const path = join(directory, 'bounded-grants.sqlite');
    const store = await openDurableStore(path);
    assert.equal((await store.issue({ grant, commitGuard: () => ({ permitted: true, reasonCodes: [] }) })).outcome, 'issued');
    await store.close();
    return path;
  }

  it('a pre-P7 SQLite grant row reopens and reads exactly as it was written', async () => {
    const path = await storeWith(legacy);
    const db = new Database(path, { readonly: true });
    const row = db.prepare(`SELECT grant_json FROM bounded_grants WHERE grant_id = ?`).get(legacy.id) as { grant_json: string };
    db.close();
    assert.equal(row.grant_json.includes('authorityBindingDigest'), false, 'the stored bytes are the pre-P7 bytes');
    const reopened = await openDurableStore(path);
    const read = await reopened.read(legacy.id);
    assert.deepEqual(read.grant, legacy);
    await reopened.close();
  });

  it('a P7 SQLite grant row round-trips its provenance, and a stored row with it removed or altered fails closed', async () => {
    const path = await storeWith(provenanced);
    const reopened = await openDurableStore(path);
    assert.equal((await reopened.read(provenanced.id)).grant?.authorityBindingDigest, provenanced.authorityBindingDigest);
    await reopened.close();

    for (const edit of [
      (json: string) => json.replace(/"authorityBindingDigest":"[^"]+",/, ''),
      (json: string) => json.replace(provenanced.authorityBindingDigest ?? '', grantAuthorityBindingDigest(NO_TEMPORAL_BOUND)),
      (json: string) => json.replace(/"authorityBindingDigest":"[^"]+"/, '"authorityBindingDigest":7'),
    ]) {
      const copy = await storeWith(provenanced);
      const db = new Database(copy);
      const row = db.prepare(`SELECT grant_json FROM bounded_grants WHERE grant_id = ?`).get(provenanced.id) as { grant_json: string };
      db.prepare(`UPDATE bounded_grants SET grant_json = ? WHERE grant_id = ?`).run(edit(row.grant_json), provenanced.id);
      db.close();
      const store = await openDurableStore(copy);
      await assert.rejects(store.read(provenanced.id), (error: unknown) => isBoundedGrantStoreError(error) && error.code === 'BOUNDED_GRANT_STORE_STATE_CORRUPT');
      await store.close();
    }
  });
});
