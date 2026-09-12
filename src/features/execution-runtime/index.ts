/**
 * Execution Runtime — the provider-neutral boundary between an issued bounded
 * grant (layer **E**) and an external action.
 *
 * > **Is this specific presented bounded grant still valid and sufficient for
 * > this specific action, right now — and if so, what does the provider do?**
 *
 * See `README.md` for the whole design. The two things to know from here:
 * nothing exported below authorizes anything, and nothing below runs unless a
 * grant held by the authoritative store was proven to cover the exact action
 * being attempted. `tests/execution-layer-boundaries.test.ts` fails the build
 * if either stops being true.
 */
export * from './domain/index.js';
export * from './services/index.js';
