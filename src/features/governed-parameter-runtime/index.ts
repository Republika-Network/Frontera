/**
 * Governed Parameter Runtime — typed parameter dimensions (CORE-03).
 *
 * > **Money is one parameter dimension. It does not define the governed-action
 * > model.**
 *
 * The semantic identifier grammar, the three typed parameter values
 * (`integer`, `token`, `boolean`), the two-kind typed bound algebra (`exact`,
 * `maximum`) with total, exact comparisons, and the declared-dimension
 * registry that closes the world authority is evaluated in. Pure data and
 * logic: no I/O, no clock, no randomness, no number parsing of text, and no
 * import from outside this module — every layer may import it precisely
 * because it imports nothing. See `README.md` and
 * `docs/architecture/ADR-GOVERNED-ACTION-SEMANTIC-PARAMETER-MODEL.md`.
 */
export * from './domain/index.js';
