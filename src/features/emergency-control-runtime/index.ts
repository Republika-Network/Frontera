/**
 * Emergency Control Runtime — the operational safety interlock.
 *
 * > **Has an operator administratively stopped execution for what is being
 * > attempted, and can that be established at all right now?**
 *
 * See `README.md` and `docs/enterprise/AOC_EMERGENCY_CONTROL.md`. The three
 * things to know from here: nothing below authorizes, revokes or decides
 * anything; a state that cannot be read withholds rather than permits; and the
 * read is synchronous so it can be honoured inside the bounded-grant store's
 * commit boundary.
 */
export * from './domain/index.js';
export * from './services/index.js';
