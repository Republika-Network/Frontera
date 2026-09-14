import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type Database from 'better-sqlite3';
import { createTestDb } from '../src/lib/db.js';
import { ensureOrganizationRegistry } from '../src/lib/organization-registry-service.js';
import { getRegistryByPurchaseId } from '../src/lib/organization-registry-repository.js';
import { createPurchaseRecord, markPurchaseCompleted } from '../src/lib/purchase-repository.js';

/**
 * APW-001 regression suite.
 *
 * The defect: `GET /api/checkout/session/[sessionId]` was unauthenticated, yet
 * it called `ensureOrganizationRegistry` — creating privileged state — and on
 * first creation returned `adminAccessToken` and `recoveryCode` in cleartext.
 * A Stripe checkout session id travels in the success URL, so possession of a
 * URL was sufficient for permanent registry takeover, including the recovery
 * factor that would have let the real buyer take it back.
 *
 * These tests pin the remediation from two directions:
 *
 *  - **behaviour** — registry creation still works through the primitive the
 *    signature-verified webhook calls, is idempotent, and yields credentials
 *    exactly once, so the legitimate path is provably intact;
 *  - **structure** — the unauthenticated read route cannot reach that
 *    primitive and cannot name a credential, so the disclosure cannot come
 *    back through a refactor.
 *
 * The structural half is deliberate. The route handler is outside this
 * package's test compilation scope (`tsconfig.test.json` includes
 * `src/lib/**` only), so it cannot be invoked here; asserting on its source is
 * the honest way to cover it rather than claiming behavioural coverage it does
 * not have.
 */

const APP_ROOT = resolve(__dirname, '..', '..');
const CHECKOUT_GET = join(APP_ROOT, 'src', 'app', 'api', 'checkout', 'session', '[sessionId]', 'route.ts');
const WEBHOOK = join(APP_ROOT, 'src', 'app', 'api', 'stripe', 'webhook', 'route.ts');

/** Source with comments removed — the route's doc comment recounts the old defect by name. */
function codeOf(file: string): string {
  const text = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, ' ');
  return text
    .split('\n')
    .map((line) => {
      let quote: string | undefined;
      for (let index = 0; index < line.length; index += 1) {
        const char = line[index];
        const previous = index > 0 ? line[index - 1] : '';
        if (quote !== undefined) {
          if (char === quote && previous !== '\\') quote = undefined;
          continue;
        }
        if (char === "'" || char === '"' || char === '`') {
          quote = char;
          continue;
        }
        if (char === '/' && line[index + 1] === '/') return line.slice(0, index);
      }
      return line;
    })
    .join('\n');
}

function makeDb(): Database.Database {
  return createTestDb();
}

/** A completed organization-registry purchase, as the webhook would observe it. */
function completedOrgPurchase(db: Database.Database): string {
  const purchase = createPurchaseRecord('organization_agent_registry', db);
  markPurchaseCompleted(purchase.id, { buyerEmail: 'buyer@example.com' }, db);
  return purchase.id;
}

describe('APW-001 — the unauthenticated checkout read route cannot create privileged state', () => {
  it('the route exists and its source is measurable', () => {
    assert.ok(existsSync(CHECKOUT_GET), 'the checkout status route must exist');
    assert.ok(codeOf(CHECKOUT_GET).includes('export async function GET'), 'real code must survive comment stripping');
  });

  it('does not import or call the registry-creation primitive', () => {
    const code = codeOf(CHECKOUT_GET);
    assert.equal(
      /ensureOrganizationRegistry/.test(code),
      false,
      'the unauthenticated route must not reach registry creation; creation belongs to the signature-verified webhook',
    );
    assert.equal(/createOrganizationRegistry|createRegistryEntitlement/.test(code), false, 'nor any lower-level creation primitive');
  });

  it('does not mint administrative credentials', () => {
    const code = codeOf(CHECKOUT_GET);
    for (const pattern of [/createRegistryAdminAccessToken/, /createRegistryRecoveryCode/, /updateRegistryAdminToken/, /updateRegistryRecoveryCode/]) {
      assert.equal(pattern.test(code), false, `the unauthenticated route must not mint credentials (${String(pattern)})`);
    }
  });

  it('never names an administrative credential in its response', () => {
    const code = codeOf(CHECKOUT_GET);
    for (const pattern of [/adminAccessToken/, /recoveryCode/, /adminUrl/, /access_token/, /newAccessToken/, /newRecoveryCode/]) {
      assert.equal(pattern.test(code), false, `the unauthenticated response must not carry a credential (${String(pattern)})`);
    }
  });

  it('retains no first-creation disclosure branch', () => {
    const code = codeOf(CHECKOUT_GET);
    assert.equal(/wasCreated/.test(code), false, 'the "expose only on first creation" branch is what APW-001 was; it must not return');
  });

  it('reads the registry rather than ensuring it', () => {
    const code = codeOf(CHECKOUT_GET);
    assert.ok(/getRegistryByPurchaseId\s*\(/.test(code), 'the route should look the registry up');
    assert.ok(/registryPending/.test(code), 'and report a pending state when there is none, rather than creating one');
  });
});

describe('APW-001 — no unauthenticated route discloses administrative credentials', () => {
  /** Routes reachable with no session, no admin token and no Stripe signature. */
  const UNAUTHENTICATED_ROUTES = [
    join('checkout', 'session', '[sessionId]'),
    join('checkout', 'session'),
    join('agent-passports', '[passportId]'),
    join('agent-passports', '[passportId]', 'verify'),
  ];

  it('covers routes that actually exist', () => {
    for (const route of UNAUTHENTICATED_ROUTES) {
      assert.ok(existsSync(join(APP_ROOT, 'src', 'app', 'api', route, 'route.ts')), `${route} must exist for this assertion to mean anything`);
    }
  });

  it('none of them returns a raw admin token or recovery code', () => {
    for (const route of UNAUTHENTICATED_ROUTES) {
      const code = codeOf(join(APP_ROOT, 'src', 'app', 'api', route, 'route.ts'));
      for (const pattern of [/adminAccessToken/, /recoveryCode/, /newAccessToken/, /newRecoveryCode/]) {
        assert.equal(pattern.test(code), false, `${route} is unauthenticated and must not name ${String(pattern)}`);
      }
    }
  });
});

describe('APW-001 — the webhook remains the authoritative creation path', () => {
  it('the webhook still verifies the Stripe signature before acting', () => {
    const code = codeOf(WEBHOOK);
    assert.ok(/constructEvent\s*\(/.test(code), 'signature verification must remain');
    assert.ok(/STRIPE_WEBHOOK_SECRET/.test(code), 'and it must read its signing secret');
  });

  it('the webhook is the route that creates the registry', () => {
    const code = codeOf(WEBHOOK);
    assert.ok(
      /ensureOrganizationRegistry/.test(code),
      'creation must live behind signature verification; if this moves, APW-001 must be re-assessed',
    );
  });

  it('an unset webhook secret fails closed rather than falling back', () => {
    const code = codeOf(WEBHOOK);
    assert.ok(/if\s*\(\s*!webhookSecret\s*\)/.test(code), 'a missing secret must be rejected');
    // And the read route must not compensate for that failure.
    assert.equal(/ensureOrganizationRegistry/.test(codeOf(CHECKOUT_GET)), false, 'no fallback creation path may exist');
  });
});

describe('APW-001 — legitimate webhook-driven onboarding still works', () => {
  it('creates the registry and yields credentials exactly once', () => {
    const db = makeDb();
    const purchaseId = completedOrgPurchase(db);

    // Before the webhook runs, a reader observes nothing — which is what the
    // unauthenticated route now reports as `registryPending`.
    assert.ok(!getRegistryByPurchaseId(purchaseId, db), 'no registry may exist before the webhook creates it');

    const first = ensureOrganizationRegistry(
      { purchaseId, tier: 'organization_agent_registry', buyerEmail: 'buyer@example.com', organizationProfile: null },
      db,
    );
    assert.ok(first, 'the webhook path must still create the registry');
    assert.equal(first.wasCreated, true);
    assert.ok(first.adminAccessToken && first.adminAccessToken.length > 0, 'credentials are issued on the authenticated path');
    assert.ok(first.recoveryCode && first.recoveryCode.length > 0);

    // And a reader now observes completion.
    const observed = getRegistryByPurchaseId(purchaseId, db);
    assert.ok(observed, 'after creation the read route can report the registry');
    assert.equal(observed.registryId, first.registry.registryId);
    db.close();
  });

  it('is idempotent: a repeated webhook re-issues no credential', () => {
    const db = makeDb();
    const purchaseId = completedOrgPurchase(db);

    const first = ensureOrganizationRegistry(
      { purchaseId, tier: 'organization_agent_registry', buyerEmail: 'buyer@example.com', organizationProfile: null },
      db,
    );
    assert.ok(first?.wasCreated);

    const second = ensureOrganizationRegistry(
      { purchaseId, tier: 'organization_agent_registry', buyerEmail: 'buyer@example.com', organizationProfile: null },
      db,
    );
    assert.ok(second, 'a duplicate webhook resolves to the existing registry');
    assert.equal(second.wasCreated, false, 'it must not create a second registry');
    assert.equal(second.registry.registryId, first!.registry.registryId, 'and must resolve to the same one');
    assert.ok(!second.adminAccessToken, 'a repeat must not re-disclose the admin token');
    assert.ok(!second.recoveryCode, 'nor the recovery code');
    db.close();
  });

  it('repeated reads mutate nothing', () => {
    const db = makeDb();
    const purchaseId = completedOrgPurchase(db);
    ensureOrganizationRegistry(
      { purchaseId, tier: 'organization_agent_registry', buyerEmail: 'buyer@example.com', organizationProfile: null },
      db,
    );

    const a = getRegistryByPurchaseId(purchaseId, db);
    const b = getRegistryByPurchaseId(purchaseId, db);
    const c = getRegistryByPurchaseId(purchaseId, db);
    assert.ok(a && b && c);
    assert.equal(a.registryId, b.registryId);
    assert.equal(b.registryId, c.registryId);
    assert.equal(a.adminAccessTokenHash, c.adminAccessTokenHash, 'reading must not rotate the credential');
    db.close();
  });
});
