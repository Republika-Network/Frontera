import { createHash } from 'node:crypto';

import type { EnterpriseApiKey } from '../configuration/enterprise-configuration.js';

const BEARER_SCHEME = 'bearer';

/**
 * `Bearer <token>`, scheme matched ASCII case-insensitively, one or more
 * whitespace separators, a non-empty single-line token. Parsed without a
 * regular expression: every step is one linear pass over the header, so an
 * attacker-shaped value cannot trigger backtracking. Accepts exactly what
 * `/^Bearer\s+(.+)$/i` over the trimmed header accepted: `trim`/`trimStart`
 * strip the same characters as `\s`, and `.` refuses only line terminators.
 */
export function extractBearerToken(authorizationHeader: string | undefined): string | undefined {
  if (authorizationHeader === undefined) return undefined;
  const header = authorizationHeader.trim();
  if (header.length <= BEARER_SCHEME.length) return undefined;
  for (let index = 0; index < BEARER_SCHEME.length; index += 1) {
    const code = header.charCodeAt(index);
    const lower = code >= 0x41 && code <= 0x5a ? code + 0x20 : code;
    if (lower !== BEARER_SCHEME.charCodeAt(index)) return undefined;
  }
  const afterScheme = header.slice(BEARER_SCHEME.length);
  const token = afterScheme.trimStart();
  if (token.length === afterScheme.length || token.length === 0) return undefined;
  for (let index = 0; index < token.length; index += 1) {
    const code = token.charCodeAt(index);
    if (code === 0x0a || code === 0x0d || code === 0x2028 || code === 0x2029) return undefined;
  }
  return token;
}

// Both sides are hashed to fixed-length hex before comparison, so comparison
// time depends on neither the candidate's length nor the position of the
// first differing byte.
function credentialsEqual(candidate: string, configured: string): boolean {
  const candidateDigest = createHash('sha256').update(candidate, 'utf8').digest('hex');
  const configuredDigest = createHash('sha256').update(configured, 'utf8').digest('hex');
  let difference = 0;
  for (let index = 0; index < candidateDigest.length; index += 1) {
    difference |= candidateDigest.charCodeAt(index) ^ configuredDigest.charCodeAt(index);
  }
  return difference === 0;
}

/**
 * Constant-time lookup of a presented bearer token among the configured API
 * keys. Every configured key is always compared, so the match position cannot
 * be inferred from response timing either.
 */
export function matchApiKey(token: string, apiKeys: readonly EnterpriseApiKey[]): EnterpriseApiKey | undefined {
  let matched: EnterpriseApiKey | undefined;
  for (const apiKey of apiKeys) {
    if (credentialsEqual(token, apiKey.key) && matched === undefined) {
      matched = apiKey;
    }
  }
  return matched;
}
