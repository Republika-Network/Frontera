import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type Database from 'better-sqlite3';

import { createBuyerAccount } from '../src/lib/buyer-account-repository.js';
import { BUYER_ACCOUNT_SESSION_COOKIE, createBuyerAccountSession, getBuyerAccountSessionCookieOptions } from '../src/lib/buyer-account-session.js';
import { createTestDb } from '../src/lib/db.js';
import { ensureOrganizationRegistry } from '../src/lib/organization-registry-service.js';
import { createPurchaseRecord } from '../src/lib/purchase-repository.js';
import { resolveRegistryAccessFromRequest } from '../src/lib/registry-account-access.js';
import { createRegistryMembership } from '../src/lib/registry-membership-repository.js';

/**
 * Executable evidence for the **blocked half** of the PARTIALLY BLOCKED Agent
 * Passport Web abuse cases (`docs/security/AGENT_PASSPORT_WEB_THREAT_MODEL.md`
 * §18) that had none — Master Plan §11.1 item 9. The unblocked half of each
 * row stays exactly as the threat model states it (APW-002, APW-005).
 *
 * - **Row T** — "an account holding a *lower* membership is denied rather than
 *   escalated": a member whose role lacks a permission is refused even while
 *   presenting the registry's owner-equivalent admin token.
 * - **Row V** — "`HttpOnly` + `SameSite=Lax` + `Secure` in production": every
 *   session cookie this application sets carries those attributes.
 * - **Row F** — "referrer leak limited (no external subresources)": no page,
 *   component or stylesheet loads anything from another origin, so a URL that
 *   carries the admin token is never sent as a Referer to a third party by a
 *   subresource fetch.
 */

const APP_ROOT = resolve(__dirname, '..', '..');
const read = (file: string): string => readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
function files(dir: string, test: (name: string) => boolean): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...files(full, test));
    else if (test(name)) out.push(full);
  }
  return out;
}

describe('APW §18 row T — a lower membership is denied, never escalated by the admin token', () => {
  let db: Database.Database;
  let registryId: string;
  let token: string;
  let viewerSession: string;

  before(() => {
    db = createTestDb();
    const purchase = createPurchaseRecord('organization_agent_registry', db);
    const created = ensureOrganizationRegistry({ purchaseId: purchase.id, tier: 'organization_agent_registry', organizationName: 'Org T' }, db);
    assert.ok(created !== null && created.adminAccessToken !== null);
    registryId = created.registry.registryId;
    token = created.adminAccessToken;
    const viewer = createBuyerAccount({ email: 'viewer@example.com', displayName: null, passwordHash: 'x' }, db);
    createRegistryMembership({ registryId, accountId: viewer.account_id, role: 'viewer' }, db);
    viewerSession = createBuyerAccountSession(viewer.account_id, db).sessionToken;
  });

  type GateRequest = Parameters<typeof resolveRegistryAccessFromRequest>[0]['request'];
  const request = (query: string, session?: string): GateRequest =>
    ({ url: `https://app.example/api/organization-registry/${registryId}${query}`, cookies: { get: (name: string) => (session !== undefined && name === BUYER_ACCOUNT_SESSION_COOKIE ? { name, value: session } : undefined) } }) as unknown as GateRequest;

  it('control: the token alone is owner-equivalent (the unblocked half, APW-002) and the viewer may view', () => {
    assert.equal(resolveRegistryAccessFromRequest({ registryId, request: request(`?access_token=${encodeURIComponent(token)}`), requiredPermission: 'registry:manage_team', db })?.membership?.role, 'owner');
    assert.equal(resolveRegistryAccessFromRequest({ registryId, request: request('', viewerSession), requiredPermission: 'registry:view', db })?.membership?.role, 'viewer');
  });

  it('a viewer presenting the owner-equivalent admin token for an owner-only permission is denied rather than escalated', () => {
    for (const permission of ['registry:manage_team', 'registry:rotate_admin_access', 'registry:manage_billing', 'registry:generate_exports'] as const) {
      const context = resolveRegistryAccessFromRequest({ registryId, request: request(`?access_token=${encodeURIComponent(token)}`, viewerSession), requiredPermission: permission, db });
      assert.equal(context, null, permission);
    }
  });
});

describe('APW §18 row V — session cookies are HttpOnly, SameSite=Lax, and Secure in production', () => {
  const previous = process.env.NODE_ENV;
  after(() => {
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
  });

  it('the buyer-account session cookie carries HttpOnly and SameSite=Lax always, and Secure in production', () => {
    (process.env as Record<string, string>).NODE_ENV = 'production';
    const production = getBuyerAccountSessionCookieOptions().split('; ');
    for (const attribute of ['HttpOnly', 'SameSite=Lax', 'Secure', 'Path=/']) assert.ok(production.includes(attribute), `production: ${attribute}`);
    (process.env as Record<string, string>).NODE_ENV = 'development';
    const development = getBuyerAccountSessionCookieOptions().split('; ');
    assert.ok(development.includes('HttpOnly') && development.includes('SameSite=Lax'), 'HttpOnly and SameSite do not depend on the environment');
  });

  it('every Set-Cookie any route emits carries HttpOnly and SameSite=Lax, and every one that sets a value is Secure in production', () => {
    const routes = files(join(APP_ROOT, 'src', 'app', 'api'), (name) => name === 'route.ts');
    let seen = 0;
    for (const file of routes) {
      const code = read(file);
      if (!code.includes('Set-Cookie')) continue;
      seen += 1;
      const where = relative(APP_ROOT, file);
      const usesBuyerOptions = code.includes('getBuyerAccountSessionCookieOptions(');
      const inline = [...code.matchAll(/`[^`]*=\$\{[^`]*\}[^`]*`|`[^`]*=; [^`]*`|\[\s*`\$\{ADMIN_SESSION_COOKIE\}[\s\S]*?\]\.filter/g)].map((m) => m[0]);
      assert.ok(usesBuyerOptions || inline.length > 0, `${where}: cookie construction is measured`);
      for (const cookie of inline) {
        if (cookie.includes('cookieOptions')) continue;
        assert.ok(cookie.includes('HttpOnly') && cookie.includes('SameSite=Lax'), `${where}: ${cookie.slice(0, 80)}`);
        if (!cookie.includes('Max-Age=0')) assert.ok(/isProduction \? 'Secure'/.test(cookie), `${where}: a value-setting cookie is Secure in production`);
      }
    }
    assert.ok(seen >= 4, `${seen} cookie-setting routes`);
  });
});

describe('APW §18 row F — no external subresources: a token-bearing URL is never sent as a Referer to another origin', () => {
  const sources = files(join(APP_ROOT, 'src'), (name) => /\.(tsx|ts|css|mjs)$/.test(name) && !name.endsWith('.d.ts'));

  it('the scan is measured and the detector matches a real external subresource', () => {
    assert.ok(sources.length >= 50, `${sources.length} files`);
    assert.ok(EXTERNAL.test('<script src="https://cdn.example.com/x.js"></script>'));
    assert.ok(EXTERNAL.test("<img src='https://tracker.example/p.gif' />"));
    assert.ok(EXTERNAL.test('@import url("https://fonts.example/css");'));
    assert.ok(EXTERNAL.test("import Script from 'next/script';"));
    assert.ok(!EXTERNAL.test('placeholder="https://example.com"'));
  });

  it('no page, component, layout or stylesheet loads a script, image, style, font or frame from another origin', () => {
    const offending: string[] = [];
    for (const file of [...sources, join(APP_ROOT, 'next.config.mjs')]) {
      const hit = EXTERNAL.exec(read(file));
      if (hit !== null) offending.push(`${relative(APP_ROOT, file)}: ${hit[0]}`);
    }
    assert.deepEqual(offending, []);
  });
});

/** An external subresource: `src` / `href` / `srcSet` / `poster` / `action` / CSS `url()` / `@import` pointing at another origin, `next/script`, or a remote image domain. */
const EXTERNAL = /\b(?:src|srcSet|href|poster|data)\s*=\s*\{?\s*["'`](?:https?:)?\/\/[^"'`]+|url\(\s*["']?(?:https?:)?\/\/|@import\s+(?:url\()?\s*["'](?:https?:)?\/\/|from\s+['"]next\/script['"]|remotePatterns|images\s*:\s*\{\s*domains/;
