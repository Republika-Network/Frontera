import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  sanitizeOrganizationProfile,
  validateOrganizationProfile,
} from '../src/lib/organization-profile-validation.js';

/**
 * Executable evidence for the CodeQL `js/polynomial-redos` remediation of the
 * buyer contact email check. The former `/^[^\s@]+@[^\s@]+\.[^\s@]+$/` was
 * replaced with explicit linear parsing bounded to 254 characters; these tests
 * pin the accept / reject semantics of that parser through the public
 * `validateOrganizationProfile` / `sanitizeOrganizationProfile` entry points.
 */

const ORG = 'Acme Corp';

function validateEmail(buyerContactEmail: unknown) {
  return validateOrganizationProfile({ organizationName: ORG, buyerContactEmail });
}

function assertRejected(buyerContactEmail: unknown) {
  const result = validateEmail(buyerContactEmail);
  assert.equal(result.ok, false, `expected rejection for ${JSON.stringify(buyerContactEmail).slice(0, 80)}`);
  if (result.ok) throw new Error('unreachable');
  assert.equal(result.code, 'ORGANIZATION_PROFILE_INVALID');
}

describe('organization profile email validation', () => {
  it('accepts a normal email', () => {
    const result = validateEmail('cto@acme.com');
    assert.equal(result.ok, true);
    if (!result.ok) throw new Error('unreachable');
    assert.equal(result.profile.buyerContactEmail, 'cto@acme.com');
  });

  it('accepts subdomains and plus-addressing', () => {
    const result = validateEmail('jane.smith+billing@mail.acme.co.uk');
    assert.equal(result.ok, true);
  });

  it('normalizes casing and surrounding whitespace', () => {
    const result = validateEmail('  CTO@Acme.COM \n');
    assert.equal(result.ok, true);
    if (!result.ok) throw new Error('unreachable');
    assert.equal(result.profile.buyerContactEmail, 'cto@acme.com');
    assert.equal(sanitizeOrganizationProfile({ buyerContactEmail: '\tJane@ACME.com  ' }).buyerContactEmail, 'jane@acme.com');
  });

  it('rejects a missing local part', () => {
    assertRejected('@acme.com');
  });

  it('rejects a missing domain', () => {
    assertRejected('cto@');
  });

  it('rejects multiple @ characters', () => {
    assertRejected('cto@acme@acme.com');
    assertRejected('cto@@acme.com');
  });

  it('rejects a domain without a dot', () => {
    assertRejected('cto@localhost');
  });

  it('rejects a domain starting with a dot', () => {
    assertRejected('cto@.com');
  });

  it('rejects a trailing dot', () => {
    assertRejected('cto@acme.');
    assertRejected('cto@acme.com.');
  });

  it('rejects whitespace inside the email', () => {
    assertRejected('c to@acme.com');
    assertRejected('cto@ac me.com');
    assertRejected('cto @acme.com');
  });

  it('rejects an empty or whitespace-only email as missing', () => {
    const result = validateEmail('   ');
    assert.equal(result.ok, false);
    if (result.ok) throw new Error('unreachable');
    assert.equal(result.error, 'Buyer contact email is required');
  });

  it('accepts an email of exactly 254 characters', () => {
    const email = `${'a'.repeat(64)}@${'b'.repeat(185)}.com`;
    assert.equal(email.length, 254);
    assert.equal(validateEmail(email).ok, true);
  });

  it('rejects an oversized email instead of truncating it into a valid one', () => {
    // The first 254 characters of this input are themselves a valid address;
    // it must be rejected as a whole, never shortened and accepted.
    const email = `cto@acme.com${'m'.repeat(243)}`;
    assert.equal(email.length, 255);
    assertRejected(email);
    assertRejected(`cto@acme.com${'m'.repeat(10_000)}`);
  });

  it('rejects CodeQL-style adversarial "!." input in linear time', () => {
    // Shape of the js/polynomial-redos witness for the former regex: a long
    // run of `!.` segments after `@` followed by a character that forces the
    // match to fail, which made `[^\s@]+\.[^\s@]+` backtrack quadratically.
    const inputs = [
      `a@${'!.'.repeat(126)}`,
      `a@${'!.'.repeat(100_000)}@`,
      `a@${'!.'.repeat(100_000)} x`,
      `${'!.'.repeat(100_000)}`,
    ];

    const started = process.hrtime.bigint();
    for (const input of inputs) assertRejected(input);
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

    // A quadratic matcher takes seconds on 200k characters; the linear parser
    // takes well under a millisecond. The bound is deliberately generous.
    assert.ok(elapsedMs < 250, `adversarial inputs took ${elapsedMs.toFixed(1)}ms`);
  });
});
