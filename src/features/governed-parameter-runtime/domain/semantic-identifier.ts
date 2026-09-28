/**
 * The one grammar for every semantic identifier CORE-03 introduces: parameter
 * dimension ids, action classes, resource classes and Governance Profile ids.
 *
 * Deliberately narrow, because each of these names *means* something to
 * authority and two spellings of one name would be two authorities:
 *
 * - starts with a lowercase ASCII letter;
 * - then ASCII letters and digits, optionally joined by single `.`, `_` or `-`
 *   separators (never leading, trailing or doubled);
 * - at most 64 characters;
 * - so: no whitespace, no control character, no `/`, `\` or `:`, no `..`, and
 *   nothing a path, URL or shell could reinterpret.
 *
 * Case-sensitive — `recordCount` is the identifier a domain declared — but a
 * registry refuses two identifiers that differ only by case
 * (`semanticIdentifierFold`), so `recordCount` and `RecordCount` can never both
 * be meaningful, and a caller that sends the second has sent an undeclared name
 * rather than a shadow of the first.
 */
export const SEMANTIC_IDENTIFIER_MAX_LENGTH = 64;

const SEMANTIC_IDENTIFIER = /^[a-z][A-Za-z0-9]*(?:[._-][A-Za-z0-9]+)*$/;

export function isSemanticIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= SEMANTIC_IDENTIFIER_MAX_LENGTH && SEMANTIC_IDENTIFIER.test(value);
}

/** The collision key: two identifiers with the same fold may not coexist in one registry. ASCII-only by grammar, so `toLowerCase` is locale-free here. */
export function semanticIdentifierFold(identifier: string): string {
  return identifier.toLowerCase();
}
