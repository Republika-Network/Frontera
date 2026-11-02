import { createHash } from 'node:crypto';

/**
 * Reviewer references (ASSURE-OPS-01, R-04).
 *
 * An Assurance reviewer credential's `reviewerId` serves three purposes:
 *
 * 1. **Internal identity** -- the authenticated principal (SEC-01B);
 * 2. **Audit identity** -- the stable attribution of reviews and releases in
 *    the store, in separation of duties and in the operator log;
 * 3. **Public reviewer reference** -- the identifier printed in a delivered
 *    report (`content.controls[].review.reviewers`, `content.review.reviewers`)
 *    and in its release record (`approvedBy`).
 *
 * They are one string, deliberately: the release record must name the
 * credential custody recorded, and the report must name the reviewers the
 * store recorded, or the package could not be verified against custody. So
 * the identifier itself must be safe to disclose. This policy makes it so
 * for every credential configured from now on, and withholds -- never
 * rewrites -- an unsafe identifier that a historical review already carries.
 *
 * A safe reference is an opaque ASCII token:
 *
 * - 1 to 64 characters;
 * - lower-case letters `a-z` and digits `0-9`, optionally joined by single
 *   `.`, `_` or `-` separators, starting and ending with a letter or digit
 *   (so no `@`, `+`, `:`, `/`, `\`, whitespace, newline, control character,
 *   markup, Markdown syntax, non-ASCII look-alike or upper/lower-case twin);
 * - no run of seven or more digits, even with single separators between them
 *   (telephone-number-like: `555-123-4567`);
 * - not in the reserved `withheld-reviewer-` namespace.
 *
 * What it cannot decide: whether a well-formed token such as `jane.doe` is a
 * person's name. That remains procedural -- issue role-style references such
 * as `rn-reviewer-01` (docs/security/ASSURE-OPS-01-CUSTOMER-DELIVERY-HARDENING.md §4).
 */

export const REVIEWER_REFERENCE_MAX_LENGTH = 64;
/** Prefix of the deterministic stand-in a report prints for an unsafe historical identifier. Reserved: no credential may use it. */
export const WITHHELD_REVIEWER_PREFIX = 'withheld-reviewer-';

export type ReviewerReferenceViolation = 'not_a_string' | 'empty' | 'too_long' | 'email_like' | 'charset' | 'phone_like' | 'reserved_prefix';

const SAFE_TOKEN = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const PHONE_LIKE = /\d(?:[._-]?\d){6,}/;

/** Why `value` may not be disclosed as a reviewer reference, or `undefined` when it may. Never echoes the value. */
export function reviewerReferenceViolation(value: unknown): ReviewerReferenceViolation | undefined {
  if (typeof value !== 'string') return 'not_a_string';
  if (value.length === 0) return 'empty';
  if (value.length > REVIEWER_REFERENCE_MAX_LENGTH) return 'too_long';
  if (value.includes('@')) return 'email_like';
  if (!SAFE_TOKEN.test(value)) return 'charset';
  if (value.startsWith(WITHHELD_REVIEWER_PREFIX)) return 'reserved_prefix';
  if (PHONE_LIKE.test(value)) return 'phone_like';
  return undefined;
}

export function isSafeReviewerReference(value: unknown): value is string {
  return reviewerReferenceViolation(value) === undefined;
}

/**
 * What a newly built report prints for a stored reviewer identifier: the
 * identifier itself when it is safe, otherwise `withheld-reviewer-<16 hex>`,
 * the first 64 bits of its SHA-256. Deterministic (the same identifier always
 * renders the same way), distinct identifiers render distinctly (barring a
 * 64-bit collision), and the original never appears. The stored review is
 * not changed: audit attribution and separation of duties keep reading the
 * original identifier.
 */
export function publicReviewerReference(reviewerId: string): string {
  if (isSafeReviewerReference(reviewerId)) return reviewerId;
  return `${WITHHELD_REVIEWER_PREFIX}${createHash('sha256').update(reviewerId, 'utf8').digest('hex').slice(0, 16)}`;
}

/** A human-readable description of a violation, for configuration errors. */
export function describeReviewerReferenceViolation(violation: ReviewerReferenceViolation): string {
  switch (violation) {
    case 'not_a_string':
    case 'empty':
      return 'must be a non-empty string';
    case 'too_long':
      return `must be at most ${REVIEWER_REFERENCE_MAX_LENGTH} characters`;
    case 'email_like':
      return 'must not be an email address (it is printed in delivered reports)';
    case 'charset':
      return 'must be an opaque token of lower-case ASCII letters and digits joined by single ".", "_" or "-" (no whitespace, markup, path or non-ASCII characters)';
    case 'phone_like':
      return 'must not contain a telephone-number-like run of seven or more digits';
    case 'reserved_prefix':
      return `must not start with the reserved '${WITHHELD_REVIEWER_PREFIX}' prefix`;
  }
}
