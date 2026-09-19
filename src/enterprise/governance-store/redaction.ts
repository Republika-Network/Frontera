/**
 * Deterministic redaction of sensitive fields, applied to every payload the
 * Governance Store persists (request payload, trace metadata, event
 * payloads) *before* digest calculation — the digest attests to the
 * sanitized record actually persisted, never to undisclosed raw secrets.
 *
 * Matching is deliberately structural, not exact-string: a key is split
 * into words on camelCase / snake_case / kebab-case boundaries and redacted
 * when its words contain a sensitive term ("accessToken", "access_token",
 * "ACCESS-TOKEN" all match "token"). One documented exemption: keys whose
 * final word is `id`/`ids` are *references to* governed objects, not secret
 * material — `capabilityTokenId`, `approvalProofId`, `sessionId` name
 * things the governance record must keep to stay reconstructable, and are
 * kept. `accessToken`, `authorization`, `api_key` etc. are redacted.
 */

export const GOVERNANCE_REDACTED_VALUE = '[REDACTED]' as const;

/** Default sensitive terms. Multi-word terms (`apiKey`, `privateKey`) match as consecutive words so a bare `key` (e.g. `sortKey`) is not over-redacted. */
export const DEFAULT_SENSITIVE_KEY_TERMS: readonly string[] = [
  'authorization',
  'token',
  'api key',
  'secret',
  'password',
  'passphrase',
  'private key',
  'cookie',
  'session',
  'credential',
  'bearer',
];

function splitKeyIntoWords(key: string): readonly string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[\s_\-.]+/)
    .map((word) => word.toLowerCase())
    .filter((word) => word.length > 0);
}

function containsConsecutiveWords(words: readonly string[], term: string): boolean {
  const termWords = term.split(' ');
  outer: for (let start = 0; start + termWords.length <= words.length; start += 1) {
    for (let offset = 0; offset < termWords.length; offset += 1) {
      if (words[start + offset] !== termWords[offset]) continue outer;
    }
    return true;
  }
  return false;
}

/** Deterministically decides whether one object key names sensitive material. Exported so tests and documentation can state the exact rule. */
export function isSensitiveKey(key: string, sensitiveTerms: readonly string[] = DEFAULT_SENSITIVE_KEY_TERMS): boolean {
  const words = splitKeyIntoWords(key);
  if (words.length === 0) return false;
  const lastWord = words[words.length - 1];
  if (lastWord === 'id' || lastWord === 'ids') return false;
  return sensitiveTerms.some((term) => containsConsecutiveWords(words, term));
}

function redactValue(value: unknown, sensitiveTerms: readonly string[]): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Date) return value;
  if (Array.isArray(value)) return value.map((item) => redactValue(item, sensitiveTerms));

  const source = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(source)) {
    const entry = source[key];
    if (entry === undefined) continue;
    // Defined, never assigned: an own `__proto__` key is data, and assignment
    // would invoke the prototype setter and drop it from the digest.
    Object.defineProperty(result, key, {
      value: isSensitiveKey(key, sensitiveTerms) ? GOVERNANCE_REDACTED_VALUE : redactValue(entry, sensitiveTerms),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return result;
}

/**
 * Returns a deep copy of `value` with every sensitive-keyed property (at any
 * depth, including inside arrays) replaced by `[REDACTED]`. Never mutates
 * the input. Redaction happens before persistence, before digesting, and
 * before logging.
 */
export function redactSensitiveValues<T>(value: T, sensitiveTerms: readonly string[] = DEFAULT_SENSITIVE_KEY_TERMS): T {
  return redactValue(value, sensitiveTerms) as T;
}
