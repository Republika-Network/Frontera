import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';

import { createMonetaryAssetRegistry } from '../../features/monetary-runtime/index.js';
import { FINANCIAL_AUTHORITY_REASON_CODES as F, financialAuthorityDigest, type FinancialAuthority } from '../execution-governance/index.js';
import type { KernelAuthorityMonetaryConstraint, KernelAuthorityRecord } from '../kernel-authority/contracts.js';
import { createDurableKernelWorld } from '../kernel-authority/durable-kernel-providers.js';
import { KernelAuthorityError } from '../kernel-authority/errors.js';
import { createKernelFinancialAuthorityResolver, financialSpendingScopeKey } from '../kernel-authority/financial-authority-resolver.js';
import { buildDurableAuthorityPayloads, DURABLE_FIXTURE_OPERATOR, provisionDurableAuthorityFixture } from '../kernel-authority/fixtures/durable-authority.fixture.js';
import { hydrateKernelAuthorityWorld } from '../kernel-authority/hydration.js';
import { createInMemoryKernelAuthorityStore } from '../kernel-authority/in-memory-kernel-authority-store.js';
import type { KernelAuthorityStore } from '../kernel-authority/kernel-authority-store.js';
import { computeKernelAuthorityPayloadDigest } from '../kernel-authority/kernel-authority-store.js';
import { createKernelAuthorityProvisioningService } from '../kernel-authority/provisioning-service.js';
import { createSqliteKernelAuthorityStore } from '../kernel-authority/sqlite-kernel-authority-store.js';

/**
 * P10 — monetary authority as durable Kernel Authority state: provisioned by
 * an operator, validated on append and on hydration, carried in the event
 * digest, surviving restart byte-exact, and resolved on one lineage by the
 * synchronous financial-authority resolver.
 */

const ORG = 'org-acme';
const READ = { system: false, organizationId: ORG } as const;
const ASSETS = createMonetaryAssetRegistry([
  { assetId: 'USD', scale: 2 },
  { assetId: 'EUR', scale: 2 },
  { assetId: 'xrpl:XRP', scale: 6 },
]);
const BEYOND = '9007199254740993.01';

const directories: string[] = [];
const stores: KernelAuthorityStore[] = [];
after(async () => {
  await Promise.all(stores.map((store) => store.close().catch(() => {})));
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
});

function dbPath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'aoc-p10-authority-'));
  directories.push(directory);
  return join(directory, 'kernel-authority.sqlite');
}

const MONETARY: readonly KernelAuthorityMonetaryConstraint[] = [
  { type: 'max_amount', currency: 'USD', value: BEYOND },
  { type: 'spending_limit', limitId: 'lifetime', currency: 'USD', maximum: '18014398509481986.02', window: { kind: 'lifetime' } },
  { type: 'spending_limit', limitId: 'daily', currency: 'USD', maximum: '500', window: { kind: 'rolling', seconds: 86_400 } },
  { type: 'max_amount', currency: 'xrpl:XRP', value: '0.000001' },
];

async function provisionWorld(store: KernelAuthorityStore, options: { readonly constraints?: readonly KernelAuthorityMonetaryConstraint[]; readonly delegationConstraints?: readonly KernelAuthorityMonetaryConstraint[]; readonly organizationId?: string; readonly authorityExpiresAt?: string } = {}) {
  const organizationId = options.organizationId ?? ORG;
  const service = createKernelAuthorityProvisioningService({ store, organizationId, monetaryAssets: ASSETS });
  const payloads = buildDurableAuthorityPayloads(organizationId);
  for (const actor of [payloads.issuerActor]) await service.provisionActor(DURABLE_FIXTURE_OPERATOR, actor);
  await service.provisionTrustDomain(DURABLE_FIXTURE_OPERATOR, payloads.trustDomain);
  await service.provisionActor(DURABLE_FIXTURE_OPERATOR, payloads.ownerActor);
  await service.provisionActor(DURABLE_FIXTURE_OPERATOR, payloads.agentActor);
  await service.provisionPassport(DURABLE_FIXTURE_OPERATOR, payloads.passport);
  await service.provisionCapabilityToken(DURABLE_FIXTURE_OPERATOR, payloads.capabilityToken);
  await service.provisionRootIssuer(DURABLE_FIXTURE_OPERATOR, payloads.rootIssuer);
  await service.provisionAuthorityGrant(DURABLE_FIXTURE_OPERATOR, {
    ...payloads.authorityGrant,
    ...(options.constraints !== undefined ? { constraints: options.constraints } : {}),
    ...(options.authorityExpiresAt !== undefined ? { expiresAt: options.authorityExpiresAt } : {}),
  });
  await service.provisionDelegationGrant(DURABLE_FIXTURE_OPERATOR, { ...payloads.delegationGrant, ...(options.delegationConstraints !== undefined ? { constraints: options.delegationConstraints } : {}) });
  return { service, payloads };
}

function isValidationError(error: unknown): boolean {
  return error instanceof KernelAuthorityError && error.code === 'KERNEL_AUTHORITY_VALIDATION_ERROR';
}

describe('P10 §12 / §44 / §78 — monetary constraints round-trip through the durable store, exactly', () => {
  it('provision → SQLite event → close → reopen → hydrate: AuthorityGrant.constraints is byte-identical to what was provisioned', async () => {
    const path = dbPath();
    const store = await createSqliteKernelAuthorityStore(path);
    const { payloads } = await provisionWorld(store, { constraints: MONETARY, delegationConstraints: [{ type: 'max_amount', currency: 'USD', value: '50' }] });
    await store.close();

    const reopened = await createSqliteKernelAuthorityStore(path);
    stores.push(reopened);
    const world = await createDurableKernelWorld({ store: reopened, organizationId: ORG });
    const grant = world.providerSet.authorityRuntime.store.getGrant(payloads.authorityGrant.authorityGrantId);
    assert.deepEqual(grant?.constraints, MONETARY, 'no constraint disappeared or changed on the round trip');
    assert.equal(typeof grant?.constraints?.[0] === 'object' && 'value' in (grant.constraints[0] ?? {}) ? (grant.constraints[0] as { value: unknown }).value : undefined, BEYOND, 'exact characters, as text');
    const delegation = world.providerSet.authorityRuntime.store.getDelegation(payloads.delegationGrant.delegationGrantId);
    assert.deepEqual(delegation?.constraints, [{ type: 'max_amount', currency: 'USD', value: '50' }]);
  });

  it('the monetary constraints participate in the event digest: a different ceiling is a different payload digest', () => {
    const base = { ...buildDurableAuthorityPayloads().authorityGrant };
    const a = computeKernelAuthorityPayloadDigest({ ...base, constraints: [{ type: 'max_amount', currency: 'USD', value: '100' }] });
    const b = computeKernelAuthorityPayloadDigest({ ...base, constraints: [{ type: 'max_amount', currency: 'USD', value: '1000' }] });
    const none = computeKernelAuthorityPayloadDigest(base);
    assert.notEqual(a, b);
    assert.notEqual(a, none);
  });

  it('a ceiling widened in place in the SQLite file fails integrity and never hydrates as authority', async () => {
    const path = dbPath();
    const store = await createSqliteKernelAuthorityStore(path);
    const { payloads } = await provisionWorld(store, { constraints: [{ type: 'max_amount', currency: 'USD', value: '100' }] });
    await store.close();

    const db = new Database(path);
    const id = payloads.authorityGrant.authorityGrantId;
    const row = db.prepare(`SELECT payload_json FROM kernel_authority_events WHERE entity_id = ?`).get(id) as { payload_json: string };
    const widened = JSON.parse(row.payload_json) as Record<string, unknown>;
    widened.constraints = [{ type: 'max_amount', currency: 'USD', value: '1000000000' }];
    db.prepare(`UPDATE kernel_authority_events SET payload_json = ? WHERE entity_id = ?`).run(JSON.stringify(widened), id);
    db.prepare(`UPDATE kernel_authority_records SET payload_json = ? WHERE entity_id = ?`).run(JSON.stringify(widened), id);
    db.close();

    const reopened = await createSqliteKernelAuthorityStore(path);
    stores.push(reopened);
    await assert.rejects(
      () => createDurableKernelWorld({ store: reopened, organizationId: ORG }),
      (error: unknown) => error instanceof KernelAuthorityError && error.code === 'KERNEL_AUTHORITY_INTEGRITY_FAILED',
    );
  });

  it('a ceiling removed in place (the widening-by-omission attack) fails integrity too', async () => {
    const path = dbPath();
    const store = await createSqliteKernelAuthorityStore(path);
    const { payloads } = await provisionWorld(store, { constraints: [{ type: 'max_amount', currency: 'USD', value: '100' }] });
    await store.close();

    const db = new Database(path);
    const id = payloads.authorityGrant.authorityGrantId;
    const row = db.prepare(`SELECT payload_json FROM kernel_authority_events WHERE entity_id = ?`).get(id) as { payload_json: string };
    const stripped = JSON.parse(row.payload_json) as Record<string, unknown>;
    delete stripped.constraints;
    db.prepare(`UPDATE kernel_authority_events SET payload_json = ? WHERE entity_id = ?`).run(JSON.stringify(stripped), id);
    db.prepare(`UPDATE kernel_authority_records SET payload_json = ? WHERE entity_id = ?`).run(JSON.stringify(stripped), id);
    db.close();

    const reopened = await createSqliteKernelAuthorityStore(path);
    stores.push(reopened);
    await assert.rejects(() => createDurableKernelWorld({ store: reopened, organizationId: ORG }), (error: unknown) => error instanceof KernelAuthorityError);
  });

  it('monetary authority is organization-confined: another organization reads none of it', async () => {
    const store = createInMemoryKernelAuthorityStore();
    stores.push(store);
    await provisionWorld(store, { constraints: MONETARY });
    assert.deepEqual(await store.listRecords({ system: false, organizationId: 'org-other' }, { organizationId: 'org-other' }), []);
    await assert.rejects(() => store.listRecords({ system: false, organizationId: 'org-other' }, { organizationId: ORG }));
  });

  it('revocation is terminal: a revoked authority grant with constraints cannot be re-provisioned under its id', async () => {
    const store = createInMemoryKernelAuthorityStore();
    stores.push(store);
    const { service, payloads } = await provisionWorld(store, { constraints: MONETARY });
    await service.revoke(DURABLE_FIXTURE_OPERATOR, { entityKind: 'authority-grant', entityId: payloads.authorityGrant.authorityGrantId, reason: 'withdrawn' });
    await assert.rejects(
      () => service.provisionAuthorityGrant(DURABLE_FIXTURE_OPERATOR, { ...payloads.authorityGrant, constraints: MONETARY }),
      (error: unknown) => error instanceof KernelAuthorityError && error.code === 'KERNEL_AUTHORITY_ENTITY_REVOKED',
    );
  });

  it('a provisioned grant cannot be rewritten in place with a different ceiling — authority changes only by revoke + new id', async () => {
    const store = createInMemoryKernelAuthorityStore();
    stores.push(store);
    const { service, payloads } = await provisionWorld(store, { constraints: [{ type: 'max_amount', currency: 'USD', value: '100' }] });
    await assert.rejects(
      () => service.provisionAuthorityGrant(DURABLE_FIXTURE_OPERATOR, { ...payloads.authorityGrant, constraints: [{ type: 'max_amount', currency: 'USD', value: '1000' }] }),
      (error: unknown) => error instanceof KernelAuthorityError && error.code === 'KERNEL_AUTHORITY_ENTITY_CONFLICT',
    );
  });

  it('only an operator context can provision monetary authority', async () => {
    const store = createInMemoryKernelAuthorityStore();
    stores.push(store);
    const service = createKernelAuthorityProvisioningService({ store, organizationId: ORG });
    await assert.rejects(
      () => service.provisionAuthorityGrant({ system: false, organizationId: ORG, actorId: 'customer' }, { ...buildDurableAuthorityPayloads().authorityGrant, constraints: MONETARY }),
      (error: unknown) => error instanceof KernelAuthorityError && error.code === 'KERNEL_AUTHORITY_OPERATOR_CONTEXT_REQUIRED',
    );
  });
});

describe('P10 §13 / §14 / §62 / §63 — monetary constraints are validated on append (whoever the caller), at provisioning against the registry, and on hydration', () => {
  const INVALID: readonly [string, unknown][] = [
    ['a JSON number value', { type: 'max_amount', currency: 'USD', value: 100 }],
    ['a trailing-zero alternate spelling', { type: 'max_amount', currency: 'USD', value: '100.00' }],
    ['a leading zero', { type: 'max_amount', currency: 'USD', value: '01' }],
    ['an exponent', { type: 'max_amount', currency: 'USD', value: '1e3' }],
    ['a negative value', { type: 'max_amount', currency: 'USD', value: '-1' }],
    ['NaN', { type: 'max_amount', currency: 'USD', value: 'NaN' }],
    ['zero', { type: 'max_amount', currency: 'USD', value: '0' }],
    ['a self-declared scale', { type: 'max_amount', currency: 'USD', value: '100', scale: 18 }],
    ['a non-canonical asset id', { type: 'max_amount', currency: ' USD', value: '100' }],
    ['a stored usage counter', { type: 'spending_limit', limitId: 'l', currency: 'USD', maximum: '100', window: { kind: 'lifetime' }, spent: '0' }],
    ['a remaining amount', { type: 'spending_limit', limitId: 'l', currency: 'USD', maximum: '100', window: { kind: 'lifetime' }, remaining: '100' }],
    ['a numeric maximum', { type: 'spending_limit', limitId: 'l', currency: 'USD', maximum: 100, window: { kind: 'lifetime' } }],
    ['a non-canonical limit id', { type: 'spending_limit', limitId: 'bad id', currency: 'USD', maximum: '100', window: { kind: 'lifetime' } }],
    ['a zero-second rolling window', { type: 'spending_limit', limitId: 'l', currency: 'USD', maximum: '100', window: { kind: 'rolling', seconds: 0 } }],
    ['a fractional rolling window', { type: 'spending_limit', limitId: 'l', currency: 'USD', maximum: '100', window: { kind: 'rolling', seconds: 1.5 } }],
    ['a window longer than a year', { type: 'spending_limit', limitId: 'l', currency: 'USD', maximum: '100', window: { kind: 'rolling', seconds: 31_536_001 } }],
    ['an unknown window kind', { type: 'spending_limit', limitId: 'l', currency: 'USD', maximum: '100', window: { kind: 'forever' } }],
    ['an unenforced constraint type', { type: 'time_window', endsAt: '2099-01-01T00:00:00.000Z' }],
    ['an unknown constraint type', { type: 'unlimited' }],
  ];

  for (const [name, constraint] of INVALID) {
    it(`${name} is refused by the store itself, bypassing the provisioning service`, async () => {
      const store = createInMemoryKernelAuthorityStore();
      stores.push(store);
      await assert.rejects(
        () =>
          store.appendEvent(DURABLE_FIXTURE_OPERATOR, {
            organizationId: ORG,
            entityKind: 'authority-grant',
            entityId: 'authority-grant-direct',
            eventType: 'KernelAuthorityEntityProvisioned',
            payload: { ...buildDurableAuthorityPayloads().authorityGrant, authorityGrantId: 'authority-grant-direct', constraints: [constraint] },
          }),
        isValidationError,
      );
    });
  }

  it('the SQLite store refuses the same malformed authority on append', async () => {
    const store = await createSqliteKernelAuthorityStore(dbPath());
    stores.push(store);
    await assert.rejects(
      () =>
        store.appendEvent(DURABLE_FIXTURE_OPERATOR, {
          organizationId: ORG,
          entityKind: 'authority-grant',
          entityId: 'authority-grant-direct',
          eventType: 'KernelAuthorityEntityProvisioned',
          payload: { ...buildDurableAuthorityPayloads().authorityGrant, constraints: [{ type: 'max_amount', currency: 'USD', value: 100 }] },
        }),
      isValidationError,
    );
  });

  it('duplicate spending-limit identity on one record is refused rather than merged', async () => {
    const store = createInMemoryKernelAuthorityStore();
    stores.push(store);
    const service = createKernelAuthorityProvisioningService({ store, organizationId: ORG });
    await assert.rejects(
      () =>
        service.provisionAuthorityGrant(DURABLE_FIXTURE_OPERATOR, {
          ...buildDurableAuthorityPayloads().authorityGrant,
          constraints: [
            { type: 'spending_limit', limitId: 'daily', currency: 'USD', maximum: '100', window: { kind: 'lifetime' } },
            { type: 'spending_limit', limitId: 'daily', currency: 'USD', maximum: '900', window: { kind: 'lifetime' } },
          ],
        }),
      isValidationError,
    );
  });

  it('constraints on a record kind that cannot carry authority are refused', async () => {
    const store = createInMemoryKernelAuthorityStore();
    stores.push(store);
    await assert.rejects(
      () =>
        store.appendEvent(DURABLE_FIXTURE_OPERATOR, {
          organizationId: ORG,
          entityKind: 'actor',
          entityId: 'actor-x',
          eventType: 'KernelAuthorityEntityProvisioned',
          payload: { actorId: 'actor-x', type: 'agent', displayName: 'X', constraints: [{ type: 'max_amount', currency: 'USD', value: '1' }] },
        }),
      isValidationError,
    );
  });

  for (const [name, constraint] of [
    ['an asset the trusted registry does not recognize', { type: 'max_amount', currency: 'XAU', value: '1' }],
    ['more fractional digits than the asset’s trusted scale', { type: 'max_amount', currency: 'USD', value: '100.001' }],
    ['a spending limit beyond the asset’s scale', { type: 'spending_limit', limitId: 'l', currency: 'xrpl:XRP', maximum: '0.0000001', window: { kind: 'lifetime' } }],
  ] as const) {
    it(`provisioning with the deployment registry refuses ${name}`, async () => {
      const store = createInMemoryKernelAuthorityStore();
      stores.push(store);
      const service = createKernelAuthorityProvisioningService({ store, organizationId: ORG, monetaryAssets: ASSETS });
      await assert.rejects(() => service.provisionAuthorityGrant(DURABLE_FIXTURE_OPERATOR, { ...buildDurableAuthorityPayloads().authorityGrant, constraints: [constraint] }), isValidationError);
      assert.deepEqual(await store.listRecords(READ, { organizationId: ORG }), [], 'nothing was written');
    });
  }

  it('a malformed monetary record that reached the log another way never hydrates into usable authority', () => {
    const payload = { ...buildDurableAuthorityPayloads().authorityGrant, constraints: [{ type: 'max_amount', currency: 'USD', value: '1e9' }] };
    const record: KernelAuthorityRecord = {
      organizationId: ORG,
      entityKind: 'authority-grant',
      entityId: payload.authorityGrantId,
      trustDomainId: payload.trustDomainId,
      status: 'active',
      payload,
      provisionedBy: 'operator',
      provisionedAt: '2026-01-01T00:00:00.000Z',
      latestSequence: 1,
      latestEventDigest: 'sha256:0',
    };
    assert.throws(
      () => hydrateKernelAuthorityWorld([record], { now: () => '2026-01-01T00:00:00.000Z', nextId: (prefix) => `${prefix}-1` }),
      (error: unknown) => error instanceof KernelAuthorityError && error.code === 'KERNEL_AUTHORITY_INTEGRITY_FAILED',
    );
  });
});

describe('P10 §18 – §21 / §31 / §57 / §65 / §80 — the financial-authority resolver', () => {
  async function resolverOver(options: Parameters<typeof provisionWorld>[1] = {}) {
    const store = createInMemoryKernelAuthorityStore();
    stores.push(store);
    const provisioned = await provisionWorld(store, options);
    const world = await createDurableKernelWorld({ store, organizationId: ORG });
    const resolve = createKernelFinancialAuthorityResolver({ organizationId: ORG, trustDomainId: provisioned.payloads.trustDomain.trustDomainId, assets: ASSETS, authority: () => world.providerSet.authorityRuntime });
    const service = createKernelAuthorityProvisioningService({ store, organizationId: ORG, onCommitted: () => world.service.reload() });
    return { resolve, world, service, payloads: provisioned.payloads };
  }

  const query = (overrides: Record<string, unknown> = {}) => ({
    phase: 'exercise' as const,
    subject: 'actor-agent-1',
    action: 'execute.material-action',
    resourceScope: 'resource-project-1',
    organizationId: ORG,
    asset: 'USD',
    at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  });

  const LIMITED: readonly KernelAuthorityMonetaryConstraint[] = [
    { type: 'max_amount', currency: 'USD', value: '100' },
    { type: 'spending_limit', limitId: 'lifetime', currency: 'USD', maximum: '1000', window: { kind: 'lifetime' } },
  ];

  it('resolves the principal’s ceiling and limits on the delegate’s lineage, with a stable authority-anchored bucket', async () => {
    const { resolve, payloads } = await resolverOver({ constraints: LIMITED });
    const result = resolve(query());
    assert.ok(result.resolved, JSON.stringify(result));
    assert.deepEqual(result.authority.lineage, [`delegation-grant:${payloads.delegationGrant.delegationGrantId}`, `authority-grant:${payloads.authorityGrant.authorityGrantId}`]);
    assert.deepEqual(result.authority.ceiling, { value: '100', unit: 'USD' });
    assert.deepEqual(result.authority.spendingLimits.map((limit) => limit.scopeKey), [
      financialSpendingScopeKey({ organizationId: ORG, entityKind: 'authority-grant', entityId: payloads.authorityGrant.authorityGrantId, currency: 'USD' }),
    ]);
    const again = resolve(query({ at: '2026-06-01T00:00:00.000Z' }));
    assert.ok(again.resolved);
    assert.equal(financialAuthorityDigest(again.authority), financialAuthorityDigest(result.authority), 'equivalent authority state → identical digest');
  });

  it('issuance requires the decision’s own Authority Graph proof; an unknown or absent decision id is unresolved', async () => {
    const { resolve } = await resolverOver({ constraints: LIMITED });
    assert.deepEqual(resolve(query({ phase: 'issuance' })), { resolved: false, reasonCode: F.FINANCIAL_AUTHORITY_UNRESOLVED });
    assert.deepEqual(resolve(query({ phase: 'issuance', authorityDecisionId: 'authority-decision-forged' })), { resolved: false, reasonCode: F.FINANCIAL_AUTHORITY_UNRESOLVED });
  });

  it('a revoked lineage no longer resolves', async () => {
    const { resolve, service, payloads } = await resolverOver({ constraints: LIMITED });
    await service.revoke(DURABLE_FIXTURE_OPERATOR, { entityKind: 'authority-grant', entityId: payloads.authorityGrant.authorityGrantId, reason: 'withdrawn' });
    assert.deepEqual(resolve(query()), { resolved: false, reasonCode: F.FINANCIAL_AUTHORITY_INACTIVE });
  });

  it('an expired lineage no longer resolves — expiry is judged at the instant asked, never assumed', async () => {
    const { resolve } = await resolverOver({ constraints: LIMITED, authorityExpiresAt: '2026-06-01T00:00:00.000Z' });
    assert.equal(resolve(query({ at: '2026-05-31T23:59:59.000Z' })).resolved, true);
    assert.deepEqual(resolve(query({ at: '2026-06-01T00:00:00.000Z' })), { resolved: false, reasonCode: F.FINANCIAL_AUTHORITY_INACTIVE });
    assert.deepEqual(resolve(query({ at: 'not-an-instant' })), { resolved: false, reasonCode: F.FINANCIAL_AUTHORITY_UNRESOLVED });
  });

  it('delegation narrowing intersects, delegation broadening is ignored', async () => {
    const narrow = await resolverOver({ constraints: LIMITED, delegationConstraints: [{ type: 'max_amount', currency: 'USD', value: '40' }] });
    const narrowed = narrow.resolve(query());
    assert.ok(narrowed.resolved);
    assert.equal(narrowed.authority.ceiling.value, '40');
    const broad = await resolverOver({ constraints: LIMITED, delegationConstraints: [{ type: 'max_amount', currency: 'USD', value: '4000' }] });
    const broadened = broad.resolve(query());
    assert.ok(broadened.resolved);
    assert.equal(broadened.authority.ceiling.value, '100');
  });

  it('different monetary authority produces a different digest', async () => {
    const a = (await resolverOver({ constraints: LIMITED })).resolve(query());
    const b = (await resolverOver({ constraints: [LIMITED[0] as KernelAuthorityMonetaryConstraint, { type: 'spending_limit', limitId: 'lifetime', currency: 'USD', maximum: '1001', window: { kind: 'lifetime' } }] })).resolve(query());
    assert.ok(a.resolved && b.resolved);
    assert.notEqual(financialAuthorityDigest(a.authority as FinancialAuthority), financialAuthorityDigest(b.authority as FinancialAuthority));
  });

  it('tenant confinement: a query naming another organization — or none — is unresolved', async () => {
    const { resolve } = await resolverOver({ constraints: LIMITED });
    assert.deepEqual(resolve(query({ organizationId: 'org-b' })), { resolved: false, reasonCode: F.FINANCIAL_AUTHORITY_UNRESOLVED });
    assert.deepEqual(resolve(query({ organizationId: undefined })), { resolved: false, reasonCode: F.FINANCIAL_AUTHORITY_UNRESOLVED });
  });

  it('an actor with no lineage for the action has no monetary authority', async () => {
    const { resolve } = await resolverOver({ constraints: LIMITED });
    assert.deepEqual(resolve(query({ subject: 'actor-bob' })), { resolved: false, reasonCode: F.FINANCIAL_AUTHORITY_UNRESOLVED });
    assert.deepEqual(resolve(query({ action: 'delete.material-action' })), { resolved: false, reasonCode: F.FINANCIAL_AUTHORITY_UNRESOLVED });
  });

  it('assets are never compared across: an XRP ceiling does not bound, or authorize, USD', async () => {
    const { resolve } = await resolverOver({ constraints: [{ type: 'max_amount', currency: 'xrpl:XRP', value: '100' }, { type: 'spending_limit', limitId: 'l', currency: 'xrpl:XRP', maximum: '100', window: { kind: 'lifetime' } }] });
    assert.deepEqual(resolve(query()), { resolved: false, reasonCode: F.FINANCIAL_AUTHORITY_ASSET_MISMATCH });
    const xrp = resolve(query({ asset: 'xrpl:XRP' }));
    assert.ok(xrp.resolved);
    assert.equal(xrp.authority.ceiling.value, '100');
  });

  it('the complete fixture world with no monetary constraints resolves nothing — missing authority is not unlimited authority', async () => {
    const store = createInMemoryKernelAuthorityStore();
    stores.push(store);
    const ids = await provisionDurableAuthorityFixture(createKernelAuthorityProvisioningService({ store, organizationId: ORG }));
    const world = await createDurableKernelWorld({ store, organizationId: ORG });
    const resolve = createKernelFinancialAuthorityResolver({ organizationId: ORG, trustDomainId: ids.trustDomainId, assets: ASSETS, authority: () => world.providerSet.authorityRuntime });
    assert.deepEqual(resolve(query()), { resolved: false, reasonCode: F.FINANCIAL_AUTHORITY_CEILING_MISSING });
  });
});
