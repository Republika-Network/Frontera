/**
 * Grant Runtime — layer **E** of
 * `docs/architecture/ADR-AUTHORITY-CONTROL-LAYERING.md`.
 *
 * > **What bounded permission does this already-authorized, obligation-satisfied
 * > result actually produce, and when does it stop?**
 *
 * See `README.md` for the whole design. The one thing to know from here: nothing
 * exported below authorizes anything, and nothing can be made to —
 * `tests/grant-layer-boundaries.test.ts` fails the build if a decision status, a
 * policy effect or an obligation discharge ever appears in this module.
 */
export * from './domain/index.js';
export * from './services/index.js';
