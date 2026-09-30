import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type Database from 'better-sqlite3';

import { updateRegistryBillingProfile, getRegistryBillingProfile } from '../src/lib/billing-repository.js';
import { createBuyerAccount } from '../src/lib/buyer-account-repository.js';
import { createBuyerAccountSession, BUYER_ACCOUNT_SESSION_COOKIE } from '../src/lib/buyer-account-session.js';
import { createTestDb } from '../src/lib/db.js';
import { ensureOrganizationRegistry, rotateRegistryAdminToken, verifyRegistryAccess } from '../src/lib/organization-registry-service.js';
import { createPurchaseRecord } from '../src/lib/purchase-repository.js';
import { resolveRegistryAccessFromRequest } from '../src/lib/registry-account-access.js';
import { generateRegistryExport, getRegistryExportForDownload } from '../src/lib/registry-export-service.js';
import { createRegistryMembership } from '../src/lib/registry-membership-repository.js';
import { handleStripeSubscriptionLifecycleEvent } from '../src/lib/stripe-billing-service.js';

/**
 * Executable evidence for the two Agent Passport Web abuse cases that
 * `docs/security/AGENT_PASSPORT_WEB_THREAT_MODEL.md` §18 classifies BLOCKED
 * and that, until CORE-06's coverage check, rested on audit evidence only
 * (§8 "No CALLER-SUPPLIED-UNBOUND pattern found"; §13 "Tenant binding —
 * server-derived"). Master Plan §11.1 item 9: every BLOCKED security claim
 * has a test.
 *
 * - **Row C — a tenant user submits another tenant's id in body, query or
 *   path.** The protection is that a registry id a caller names is only ever
 *   honoured together with a credential verified against **that** registry:
 *   an active membership keyed by `(registryId, accountId)`, or an admin token
 *   / session / recovery code checked against that registry's own stored hash
 *   (and an export id is additionally bound to its registry). Runtime, over
 *   the real access gates and services; plus a structural rule over every
 *   route (the route layer is Next.js and is not compiled by this harness).
 * - **Row P — a valid Stripe event applied to the wrong tenant.** The
 *   protection is that the tenant is resolved from Frontera's own server-held
 *   linkage (stored subscription id, then stored customer id) — and a
 *   checkout event from the purchase its session id names — never from a
 *   caller, and never from event metadata while a server-held link exists.
 *   Runtime, over the real lifecycle handler; plus a structural pin on the
 *   webhook route's checkout branch.
 */

const ORG_TIER = 'organization_agent_registry';

interface Tenant {
  readonly registryId: string;
  readonly token: string;
}

let db: Database.Database;
let a: Tenant;
let b: Tenant;
let memberOfA: string;

function tenant(): Tenant {
  const purchase = createPurchaseRecord(ORG_TIER, db);
  const created = ensureOrganizationRegistry({ purchaseId: purchase.id, tier: ORG_TIER, organizationName: `Org ${purchase.id}` }, db);
  assert.ok(created !== null && created.adminAccessToken !== null);
  return { registryId: created.registry.registryId, token: created.adminAccessToken };
}

/** The two request surfaces the gate reads — the URL (path/query) and cookies — and nothing else. */
type GateRequest = Parameters<typeof resolveRegistryAccessFromRequest>[0]['request'];
function request(url: string, cookies: Record<string, string> = {}): GateRequest {
  return { url, cookies: { get: (name: string) => (cookies[name] !== undefined ? { name, value: cookies[name] } : undefined) } } as unknown as GateRequest;
}

before(() => {
  db = createTestDb();
  a = tenant();
  b = tenant();
  const account = createBuyerAccount({ email: 'member-of-a@example.com', displayName: null, passwordHash: 'x' }, db);
  createRegistryMembership({ registryId: a.registryId, accountId: account.account_id, role: 'owner' }, db);
  memberOfA = createBuyerAccountSession(account.account_id, db).sessionToken;
});

describe('APW §18 row C — another tenant’s id in path, query or body never selects that tenant', () => {
  it('control: each tenant’s own credential opens exactly its own registry', () => {
    const own = resolveRegistryAccessFromRequest({ registryId: a.registryId, request: request(`https://app.example/api/organization-registry/${a.registryId}`, { [BUYER_ACCOUNT_SESSION_COOKIE]: memberOfA }), db });
    assert.equal(own?.registryId, a.registryId);
    assert.equal(own?.accessMode, 'buyer_account');
    assert.equal(verifyRegistryAccess(b.registryId, b.token, db).ok, true);
  });

  it('a member of A naming B in the path is refused — membership is keyed by (registryId, accountId)', () => {
    const context = resolveRegistryAccessFromRequest({ registryId: b.registryId, request: request(`https://app.example/api/organization-registry/${b.registryId}`, { [BUYER_ACCOUNT_SESSION_COOKIE]: memberOfA }), db });
    assert.equal(context, null);
  });

  it('A’s admin token presented for B — in the query, or directly to the verifier — is refused against B’s own hash', () => {
    assert.equal(resolveRegistryAccessFromRequest({ registryId: b.registryId, request: request(`https://app.example/api/organization-registry/${b.registryId}?access_token=${encodeURIComponent(a.token)}`), db }), null);
    assert.deepEqual(verifyRegistryAccess(b.registryId, a.token, db), { ok: false, errorCode: 'REGISTRY_ACCESS_DENIED' });
  });

  it('query parameters naming A cannot override the path B: the gate authorizes the path id or nothing, and never returns another', () => {
    const smuggled = `?registryId=${a.registryId}&registry_id=${a.registryId}&tenant_id=${a.registryId}&access_token=${encodeURIComponent(a.token)}`;
    assert.equal(resolveRegistryAccessFromRequest({ registryId: b.registryId, request: request(`https://app.example/api/organization-registry/${b.registryId}${smuggled}`, { [BUYER_ACCOUNT_SESSION_COOKIE]: memberOfA }), db }), null);
    const legit = resolveRegistryAccessFromRequest({ registryId: b.registryId, request: request(`https://app.example/api/organization-registry/${b.registryId}?registry_id=${a.registryId}&access_token=${encodeURIComponent(b.token)}`), db });
    assert.equal(legit?.registryId, b.registryId, 'the context is the path registry, whatever the query names');
  });

  it('an export id of A cannot be downloaded through B, and A’s token cannot rotate B’s credential', () => {
    const exported = generateRegistryExport({ registryId: a.registryId, accessToken: a.token, exportType: 'registry_inventory_csv', db });
    assert.equal(exported.ok, true, JSON.stringify(exported));
    const exportId = exported.result?.artifact.exportId;
    assert.ok(exportId !== undefined);
    assert.deepEqual(getRegistryExportForDownload({ registryId: b.registryId, accessToken: b.token, exportId, db }), { ok: false, errorCode: 'REGISTRY_EXPORT_ACCESS_DENIED' });
    assert.equal(getRegistryExportForDownload({ registryId: b.registryId, accessToken: a.token, exportId, db }).ok, false);
    assert.equal(getRegistryExportForDownload({ registryId: a.registryId, accessToken: a.token, exportId, db }).ok, true);

    const rotated = rotateRegistryAdminToken({ registryId: b.registryId, currentAccessToken: a.token }, db);
    assert.ok('error' in rotated, JSON.stringify(rotated));
    assert.equal(verifyRegistryAccess(b.registryId, b.token, db).ok, true, 'B’s credential is untouched');
  });
});

// ── Structural half of row C: the route layer ──────────────────────────────

const APP_ROOT = resolve(__dirname, '..', '..');
const API_ROOT = join(APP_ROOT, 'src', 'app', 'api');

function routes(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...routes(full));
    else if (name === 'route.ts') out.push(full);
  }
  return out;
}
const code = (file: string): string => readFileSync(file, 'utf8').replace(/\r\n/g, '\n').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, '');
const rel = (file: string): string => relative(API_ROOT, file).replace(/\\/g, '/');

/** A tenant identifier read from a request body or query string. */
const TENANT_READ = /\b(?:body|payload|json|input)\s*(?:\.\s*|\[\s*['"])(?:claim_registry_id|registry_id|registryId|organization_id|organizationId|tenant_id|tenantId)\b|searchParams\.get\(\s*['"](?:registry_id|registryId|tenant_id|tenantId|organization_id|organizationId)['"]\s*\)/g;

/** Every route that reads one, and the credential check against that same registry's own hash that binds it. */
const VALIDATED_TENANT_READS: Readonly<Record<string, RegExp>> = {
  'account/signup/route.ts': /verifyRegistryAdminAccessToken\(accessToken, registry\.adminAccessTokenHash\)/,
  'account/claim-registry/route.ts': /verifyRegistryAdminAccessToken\(accessToken, registry\.adminAccessTokenHash\)/,
  'agent-passports/route.ts': /verifyRegistryAccess\(registryId, accessToken\)/,
  'organization-registry/recover/route.ts': /recoveryCode/,
};

/** A route under `[registryId]` must hand the path id, with the caller's credential, to one of these. */
const REGISTRY_GATES = /\b(?:resolveRegistryAccessFromRequest|requireRegistryAccess|verifyRegistryAccess|resolveAdminAccessFromRequest|requireRegistryAdminAccess|verifyRegistryAdminAccess|generateRegistryExport|listRegistryExports|getRegistryExportForDownload|rotateRegistryAdminToken)\s*\(/;

describe('APW §18 row C — structural: no route trusts a caller-named tenant', () => {
  const all = routes(API_ROOT);

  it('the route inventory is measured', () => {
    assert.ok(all.length >= 25, `${all.length} route files`);
  });

  it('only the enumerated routes read a tenant id from body or query, and each binds it to that registry’s own credential', () => {
    const readers = all.filter((file) => { TENANT_READ.lastIndex = 0; return TENANT_READ.test(code(file)); }).map(rel).sort();
    assert.deepEqual(readers, Object.keys(VALIDATED_TENANT_READS).sort(), 'a new route reading a tenant id from the request must be validated and enumerated here');
    for (const [route, binding] of Object.entries(VALIDATED_TENANT_READS)) {
      assert.match(code(join(API_ROOT, route)), binding, `${route} binds the caller-named registry to its own credential`);
    }
  });

  it('every route under /organization-registry/[registryId] authorizes the path id through a registry gate', () => {
    const scoped = all.filter((file) => rel(file).startsWith('organization-registry/[registryId]/'));
    assert.ok(scoped.length >= 13, `${scoped.length} registry-scoped routes`);
    const ungated = scoped.filter((file) => !REGISTRY_GATES.test(code(file))).map(rel);
    assert.deepEqual(ungated, []);
  });
});

// ── Row P — a valid Stripe event is applied only to its own tenant ─────────

describe('APW §18 row P — a valid Stripe event is applied to the tenant Frontera linked, never another', () => {
  let billingA: Tenant;
  let billingB: Tenant;

  before(() => {
    billingA = tenant();
    billingB = tenant();
    for (const [t, suffix] of [[billingA, 'A'], [billingB, 'B']] as const) {
      updateRegistryBillingProfile({ registryId: t.registryId, stripeCustomerId: `cus_${suffix}`, stripeSubscriptionId: `sub_${suffix}`, subscriptionStatus: 'active', billingStatus: 'active', stripeEventId: `evt_link_${suffix}` }, db);
    }
  });

  const status = (t: Tenant) => getRegistryBillingProfile(t.registryId, db)?.billingStatus;

  it('control: an event for B’s subscription changes B', async () => {
    await handleStripeSubscriptionLifecycleEvent({ eventType: 'customer.subscription.updated', eventId: 'evt_p_control', data: { id: 'sub_B', customer: 'cus_B', status: 'past_due' } }, db);
    assert.equal(status(billingB), 'past_due');
    assert.equal(status(billingA), 'active');
    await handleStripeSubscriptionLifecycleEvent({ eventType: 'customer.subscription.updated', eventId: 'evt_p_control_restore', data: { id: 'sub_B', customer: 'cus_B', status: 'active' } }, db);
    assert.equal(status(billingB), 'active');
  });

  it('event metadata naming A cannot redirect B’s subscription event to A', async () => {
    await handleStripeSubscriptionLifecycleEvent({ eventType: 'customer.subscription.deleted', eventId: 'evt_p_meta', data: { id: 'sub_B', customer: 'cus_B', status: 'canceled', metadata: { registry_id: billingA.registryId } } }, db);
    assert.equal(status(billingA), 'active', 'A is untouched');
    assert.equal(status(billingB), 'canceled', 'the event applied to the tenant that owns the subscription');
  });

  it('a subscription of A billed to B’s customer applies to A — the subscription link wins; B is untouched', async () => {
    await handleStripeSubscriptionLifecycleEvent({ eventType: 'customer.subscription.updated', eventId: 'evt_p_mixed', data: { id: 'sub_A', customer: 'cus_B', status: 'past_due', metadata: { registry_id: billingB.registryId } } }, db);
    assert.equal(status(billingA), 'past_due');
    assert.equal(status(billingB), 'canceled', 'B keeps the state its own event gave it');
  });

  it('an invoice event resolves by the stored subscription, then the stored customer — never by anything else in the event', async () => {
    await handleStripeSubscriptionLifecycleEvent({ eventType: 'customer.subscription.updated', eventId: 'evt_p_restore_a', data: { id: 'sub_A', customer: 'cus_A', status: 'active' } }, db);
    await handleStripeSubscriptionLifecycleEvent({ eventType: 'invoice.payment_failed', eventId: 'evt_p_invoice', data: { subscription: 'sub_B', customer: 'cus_A', metadata: { registry_id: billingA.registryId } } }, db);
    assert.equal(status(billingA), 'active', 'A untouched by an invoice of B’s subscription');
    assert.equal(status(billingB), 'past_due');
  });

  it('an event Frontera cannot link to a tenant through its own records changes no registry it does not name', async () => {
    const before = [status(billingA), status(billingB)];
    await handleStripeSubscriptionLifecycleEvent({ eventType: 'invoice.payment_failed', eventId: 'evt_p_unlinked', data: { subscription: 'sub_unknown', customer: 'cus_unknown' } }, db);
    assert.deepEqual([status(billingA), status(billingB)], before);
  });

  it('structural: the webhook’s checkout branch selects the tenant only from the purchase its session id names', () => {
    const webhook = code(join(API_ROOT, 'stripe', 'webhook', 'route.ts'));
    const branch = webhook.slice(webhook.indexOf('// Checkout session events') >= 0 ? webhook.indexOf('const stripeSessionId') : 0);
    assert.match(branch, /const purchase = getPurchaseByStripeSessionId\(stripeSessionId\)/);
    assert.match(branch, /ensureOrganizationRegistry\(\{\s*purchaseId: updatedPurchase\.id/);
    assert.match(branch, /getRegistryByPurchaseId\(updatedPurchase\.id\)/);
    // No registry, purchase or tenant id is taken from the event's metadata.
    assert.ok(!/sessionMetadata\[\s*['"](?:registry_id|purchase_id|tenant_id|organization_id)['"]\s*\]/.test(branch), 'the checkout branch reads no tenant id from event metadata');
    assert.ok(!/data\[\s*['"](?:registry_id|purchase_id)['"]\s*\]/.test(branch));
  });
});
