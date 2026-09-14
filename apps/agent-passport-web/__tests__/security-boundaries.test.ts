import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

/**
 * Structural security properties of the Agent Passport Web application.
 *
 * Every assertion here pins a property the application **already has** and that
 * `docs/security/AGENT_PASSPORT_WEB_THREAT_MODEL.md` credits it with. None of
 * them implements a fix, and none asserts a weakness: the threat model's
 * findings (APW-001..APW-012) are deliberately *not* encoded here, because a
 * test that locks in a finding would have to be deleted to fix it.
 *
 * What is pinned is the set of things that are currently right and currently
 * undefended — the ones a refactor could silently undo:
 *
 *   - no secret is exposed to the browser bundle;
 *   - the role policy stays server-side;
 *   - the Stripe webhook keeps verifying signatures and keeps failing closed.
 *
 * Compiled to `dist-test/__tests__/`, so the application root is two levels up.
 */

const APP_ROOT = resolve(__dirname, '..', '..');

/** Env names that are real secrets in this application (threat model section 15). */
const SECRET_ENV_NAMES: readonly string[] = [
  'AOC_ISSUER_PRIVATE_KEY_PEM',
  'PASSPORT_SIGNING_SECRET',
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'AOC_DEV_SIGNING_SECRET',
];

function sourceFiles(dir: string): readonly string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === 'node_modules' || name === 'dist-test' || name === '.next') continue;
      out.push(...sourceFiles(full));
    } else if (/\.(ts|tsx)$/.test(full)) {
      out.push(full);
    }
  }
  return out;
}

const SRC = join(APP_ROOT, 'src');

describe('Agent Passport Web — no secret reaches the browser bundle', () => {
  it('has application sources to measure', () => {
    assert.ok(sourceFiles(SRC).length >= 40, 'expected the application to have sources');
  });

  it('no secret is declared under the NEXT_PUBLIC_ prefix', () => {
    // Next.js inlines every NEXT_PUBLIC_* value into the client bundle. A secret
    // acquiring that prefix would be published to every visitor, silently.
    for (const file of sourceFiles(SRC)) {
      const text = readFileSync(file, 'utf8');
      for (const match of text.matchAll(/NEXT_PUBLIC_[A-Z0-9_]+/g)) {
        const name = match[0];
        const bare = name.replace('NEXT_PUBLIC_', '');
        assert.equal(
          SECRET_ENV_NAMES.some((secret) => secret === bare || secret.endsWith(bare) || bare.endsWith(secret)),
          false,
          `${file} exposes ${name} to the client bundle; that name corresponds to a secret`,
        );
        assert.equal(
          /SECRET|PRIVATE_KEY|_TOKEN$|PASSWORD/.test(bare),
          false,
          `${file} declares ${name}: a NEXT_PUBLIC_ value is inlined into the browser bundle and must never be secret-shaped`,
        );
      }
    }
  });

  it('no client component reads a secret from process.env', () => {
    for (const file of sourceFiles(SRC)) {
      const text = readFileSync(file, 'utf8');
      if (!/^\s*['"]use client['"]/m.test(text)) continue;
      for (const secret of SECRET_ENV_NAMES) {
        assert.equal(text.includes(secret), false, `${file} is a client component and references the secret ${secret}`);
      }
    }
  });
});

describe('Agent Passport Web — the role policy stays server-side', () => {
  it('no client component imports the registry role policy', () => {
    // Role is authoritative only because it is resolved server-side from
    // `registry_account_memberships`. A client component importing the policy is
    // the first step toward a client-trusted role decision.
    for (const file of sourceFiles(SRC)) {
      const text = readFileSync(file, 'utf8');
      if (!/^\s*['"]use client['"]/m.test(text)) continue;
      assert.equal(
        /registry-role-policy|roleHasPermission|requireRegistryPermission|getRegistryRolePermissions/.test(text),
        false,
        `${file} is a client component and imports role-policy logic; role must be decided on the server`,
      );
    }
  });

  it('the role policy itself reads no request, cookie or environment input', () => {
    const policy = readFileSync(join(SRC, 'lib', 'registry-role-policy.ts'), 'utf8');
    for (const pattern of [/process\.env/, /NextRequest/, /cookies\(/, /headers\(/]) {
      assert.equal(pattern.test(policy), false, `registry-role-policy.ts must stay a pure static map (${String(pattern)})`);
    }
  });
});

describe('Agent Passport Web — the Stripe webhook boundary holds', () => {
  const webhook = join(SRC, 'app', 'api', 'stripe', 'webhook', 'route.ts');

  it('verifies the Stripe signature over the raw body', () => {
    const text = readFileSync(webhook, 'utf8');
    assert.ok(/constructEvent\s*\(/.test(text), 'the webhook must verify the Stripe signature');
    assert.ok(/req\.text\(\)/.test(text), 'signature verification requires the raw body, not a parsed one');
  });

  it('fails closed when the webhook secret is not configured', () => {
    const text = readFileSync(webhook, 'utf8');
    const guard = text.indexOf('STRIPE_WEBHOOK_SECRET');
    const verify = text.indexOf('constructEvent');
    assert.notEqual(guard, -1, 'the webhook must read its signing secret');
    assert.ok(guard < verify, 'the missing-secret guard must precede verification');
    assert.ok(/if\s*\(\s*!webhookSecret\s*\)/.test(text), 'an unset webhook secret must be rejected rather than defaulted');
  });

  it('rejects a request with no stripe-signature header', () => {
    const text = readFileSync(webhook, 'utf8');
    assert.ok(/stripe-signature/.test(text), 'the webhook must require the signature header');
    assert.ok(/if\s*\(\s*!stripeSignature\s*\)/.test(text), 'a missing signature header must be rejected');
  });

  it('deduplicates events so a replayed webhook cannot re-apply state', () => {
    const repo = readFileSync(join(SRC, 'lib', 'stripe-webhook-repository.ts'), 'utf8');
    assert.ok(/stripe_event_id/.test(repo), 'replay protection is keyed on the Stripe event id');
  });
});
