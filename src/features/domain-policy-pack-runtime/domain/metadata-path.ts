/**
 * CORE-04 review (Codex P1) — the one metadata-path grammar, shared by the
 * validator and the evaluator.
 *
 * Before this, the validator checked the reserved namespaces on the raw
 * string while the evaluator dropped empty segments, so `.aoc.context.x` or
 * `aoc..context.x` passed validation and was read as `aoc.context.x` — raw
 * trusted context through an alias. Now a path is a non-empty list of
 * non-empty, dot-separated segments; anything else (a leading, trailing or
 * repeated dot) is not a path at all. Both sides parse with this function, so
 * what is validated is exactly what is read.
 */

/** The namespaces trusted context, obligations and grants use inside the metadata bag. Read only through typed predicates, never by path — in any case. */
export const RESERVED_METADATA_NAMESPACES: readonly string[] = ['aoc.context', 'aoc.obligations', 'aoc.grant'];

const MAX_METADATA_PATH_LENGTH = 256;

/** The segments of a well-formed metadata path, or `undefined` when it is not one. */
export function parseMetadataPath(path: unknown): readonly string[] | undefined {
  if (typeof path !== 'string' || path.length === 0 || path.length > MAX_METADATA_PATH_LENGTH) return undefined;
  const segments = path.split('.');
  return segments.some((segment) => segment.length === 0) ? undefined : segments;
}

/** Whether parsed segments fall inside a reserved namespace, compared case-insensitively on the canonical (re-joined) path. */
export function metadataPathIsReserved(segments: readonly string[]): boolean {
  const folded = segments.join('.').toLowerCase();
  return RESERVED_METADATA_NAMESPACES.some((prefix) => folded === prefix || folded.startsWith(`${prefix}.`));
}
