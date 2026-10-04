import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import type { EnterpriseApiKey, EnterpriseConfiguration } from '../configuration/enterprise-configuration.js';
import { CUSTOMER_IDENTITY_REFUSAL_REASONS as REFUSED, authenticateCustomerCredential } from '../customer-identity/index.js';
import { createOperatorAuthenticator } from '../operator-control/operator-authenticator.js';
import { extractBearerToken, matchApiKey } from '../orchestration/credential-matching.js';
import { resolveGovernanceAccessContext } from '../orchestration/governance-read-service.js';

/**
 * Bearer credential parsing (CodeQL js/polynomial-redos on PR #163).
 *
 * `extractBearerToken` was `/^Bearer\s+(.+)$/i` over the trimmed header: `\s+`
 * and `.+` both match spaces, so a header of `Bearer`, many spaces and a
 * line terminator inside the token backtracked quadratically before refusing.
 * It is now a linear string parse that accepts exactly the same headers. These
 * cases pin that contract, the callers' refusal semantics, and the absence of
 * a regular expression on the credential path.
 */

const SECRET = 'AOC_BEARER_PARSING_SENTINEL_DO_NOT_USE';
const OTHER = 'AOC_BEARER_PARSING_OTHER_SENTINEL_DO_NOT_USE';

/** `Bearer`, `spaces` spaces, then a token broken by a line feed: the old pattern's worst case. */
const backtrackingHeader = (spaces: number): string => `Bearer${' '.repeat(spaces)}a\na`;

describe('extractBearerToken — accepted and refused headers (unchanged contract)', () => {
  it('returns the token for a Bearer scheme in each letter case', () => {
    for (const header of [`Bearer ${SECRET}`, `bearer ${SECRET}`, `BEARER ${SECRET}`, `bEaReR ${SECRET}`]) {
      assert.equal(extractBearerToken(header), SECRET, header);
    }
  });

  it('accepts one or more whitespace separators of every kind and trims the header', () => {
    for (const header of [`Bearer   ${SECRET}`, `Bearer\t${SECRET}`, `Bearer \t  　${SECRET}`, `Bearer\n${SECRET}`, `  Bearer ${SECRET}  `, `\tBearer ${SECRET}\r\n`]) {
      assert.equal(extractBearerToken(header), SECRET, JSON.stringify(header));
    }
  });

  it('keeps inner spaces as part of the token, as before', () => {
    assert.equal(extractBearerToken('Bearer a b'), 'a b');
    assert.equal(extractBearerToken('Bearer  a \t b  '), 'a \t b');
  });

  it('refuses a missing scheme, a missing separator, a missing token and other schemes', () => {
    assert.equal(extractBearerToken(undefined), undefined);
    for (const header of ['', '   ', 'Bearer', 'bearer', 'Bearer ', 'Bearer    ', 'Bearer\t　', `Bearer${SECRET}`, `Basic ${SECRET}`, `Token ${SECRET}`, SECRET, `Bearer: ${SECRET}`, `Bearerx ${SECRET}`, `X Bearer ${SECRET}`]) {
      assert.equal(extractBearerToken(header), undefined, JSON.stringify(header));
    }
  });

  it('matches the scheme in ASCII only: lookalike letters are refused', () => {
    for (const header of [`Bеarer ${SECRET}`, `Beаrer ${SECRET}`, `Ｂearer ${SECRET}`, `Bearer​${SECRET}`]) {
      assert.equal(extractBearerToken(header), undefined, JSON.stringify(header));
    }
  });

  it('refuses a token that spans lines', () => {
    for (const terminator of ['\n', '\r', ' ', ' ']) {
      assert.equal(extractBearerToken(`Bearer a${terminator}b`), undefined, JSON.stringify(terminator));
    }
  });

  it('a prefix or superstring of a key is extracted verbatim and matches nothing', () => {
    const keys: EnterpriseApiKey[] = [{ key: SECRET }];
    assert.deepEqual(matchApiKey(extractBearerToken(`Bearer ${SECRET}`) ?? '', keys), keys[0]);
    for (const token of [SECRET.slice(0, -1), `${SECRET}x`, `x${SECRET}`, SECRET.toLowerCase(), `${SECRET} ${SECRET}`]) {
      const extracted = extractBearerToken(`Bearer ${token}`);
      assert.equal(extracted, token);
      assert.equal(matchApiKey(extracted ?? '', keys), undefined, token);
    }
  });
});

describe('extractBearerToken — adversarial headers (no backtracking path)', () => {
  it('refuses the old worst case at 100 000 separators, and at every shape near it', () => {
    // The old pattern needed about 1.4 s at 40 000 separators and grew with the
    // square; the bound below is two orders of magnitude above the linear
    // parse and far below the old cost, so it is not a timing-sensitive check.
    const started = performance.now();
    assert.equal(extractBearerToken(backtrackingHeader(100_000)), undefined);
    assert.equal(extractBearerToken(`Bearer${' \t'.repeat(50_000)}x\r${' '.repeat(50_000)}y`), undefined);
    assert.equal(extractBearerToken(`Bearer ${'a '.repeat(50_000)} a`), undefined);
    assert.equal(extractBearerToken(`bearer${' '.repeat(100_000)}`), undefined);
    assert.equal(extractBearerToken(`${'Bearer '.repeat(30_000)}\nx`), undefined);
    assert.ok(performance.now() - started < 2_000, 'adversarial headers are parsed in linear time');
  });

  it('accepts a very long well-formed token whole', () => {
    const token = 'k'.repeat(1_000_000);
    assert.equal(extractBearerToken(`Bearer${' '.repeat(100_000)}${token}`), token);
  });

  it('every caller refuses the adversarial header with its usual malformed-credential outcome', () => {
    const header = backtrackingHeader(100_000);
    const apiKeys: EnterpriseApiKey[] = [{ key: SECRET, organizationId: 'org-acme' }];
    assert.deepEqual(authenticateCustomerCredential(header, apiKeys), { status: 'refused', reason: REFUSED.CUSTOMER_AUTH_MALFORMED });

    const operators = createOperatorAuthenticator({ administrators: [], operators: [{ operatorId: 'op-1', role: 'organization-administrator', key: SECRET }], ordinaryCredentials: [], organizationId: 'org-acme', isReady: () => true, lifecycleState: () => 'ready' });
    assert.throws(() => operators.authorize(header, 'organization.read'), { httpStatus: 401, code: 'AUTHENTICATION_FAILED' });
    assert.equal(operators.authorize(`Bearer ${SECRET}`, 'organization.read').operatorId, 'op-1');

    const configuration = { features: { requireAuthentication: true }, authentication: { apiKeys } } as unknown as EnterpriseConfiguration;
    assert.throws(() => resolveGovernanceAccessContext(header, configuration), { httpStatus: 401, code: 'AUTHENTICATION_FAILED' });
    assert.deepEqual(resolveGovernanceAccessContext(`Bearer ${SECRET}`, configuration), { system: false, organizationId: 'org-acme' });
  });

  it('callers keep REQUIRED, MALFORMED and INVALID apart', () => {
    const apiKeys: EnterpriseApiKey[] = [{ key: SECRET, organizationId: 'org-acme' }];
    for (const header of [undefined, '', ' \t ']) {
      assert.deepEqual(authenticateCustomerCredential(header, apiKeys), { status: 'refused', reason: REFUSED.CUSTOMER_AUTH_REQUIRED }, JSON.stringify(header));
    }
    for (const header of ['Bearer', 'Bearer   ', `Basic ${SECRET}`, `Token ${SECRET}`, `Bearer${SECRET}`, 'Bearer a\nb']) {
      assert.deepEqual(authenticateCustomerCredential(header, apiKeys), { status: 'refused', reason: REFUSED.CUSTOMER_AUTH_MALFORMED }, JSON.stringify(header));
    }
    for (const header of [`Bearer ${OTHER}`, `bearer ${SECRET}x`, `BEARER ${SECRET.slice(1)}`]) {
      assert.deepEqual(authenticateCustomerCredential(header, apiKeys), { status: 'refused', reason: REFUSED.CUSTOMER_AUTH_INVALID }, header);
    }
  });
});

describe('extractBearerToken — structure', () => {
  /** The body of `extractBearerToken` in the production source, comments removed. */
  function parserBody(source: string): string {
    const start = source.indexOf('export function extractBearerToken(');
    assert.ok(start >= 0, 'extractBearerToken is defined in credential-matching.ts');
    const end = source.indexOf('\n}\n', start);
    return source
      .slice(start, end)
      .split('\n')
      .map((line) => line.replace(/^\s*\/\/.*$/, ''))
      .join('\n');
  }
  // A regular expression needs a `/` (literal) or `RegExp`; the parser has no division either.
  const usesRegex = (code: string): boolean => code.includes('/') || /\bRegExp\b|\.(exec|match|matchAll|search|replace|replaceAll|split)\(/.test(code);

  it('the detector flags the old regex-based parser', () => {
    assert.equal(usesRegex(parserBody("export function extractBearerToken(h) {\n  const match = /^Bearer\\s+(.+)$/i.exec(h.trim());\n}\n")), true);
    assert.equal(usesRegex(parserBody("export function extractBearerToken(h) {\n  return new RegExp('^Bearer').test(h);\n}\n")), true);
    assert.equal(usesRegex(parserBody("export function extractBearerToken(h) {\n  return h.trim().split(' ')[1];\n}\n")), true);
  });

  it('runs no regular expression over the Authorization header', () => {
    const body = parserBody(readFileSync('src/enterprise/orchestration/credential-matching.ts', 'utf8'));
    assert.equal(usesRegex(body), false, body);
  });
});
