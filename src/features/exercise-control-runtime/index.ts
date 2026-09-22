/**
 * Exercise Control Runtime — aggregate / velocity limits on repeated use of a
 * bounded grant, a durable reservation model, and exercise-time
 * authority-binding revalidation.
 *
 * > **The grant covered this attempt. Does repeated use of it still fit the
 * > trusted aggregate limits, and does the authority it was issued under still
 * > stand exactly?**
 *
 * See `README.md` and `docs/enterprise/AOC_EXERCISE_CONTROLS.md`. The three
 * things to know from here: this module only narrows — it can stop an effect a
 * grant covered, never permit one it did not; its consumption state is
 * authority state, kept apart from Governance Store evidence; and it imports
 * no Kernel, no Governance Store, no provider and no network.
 */
export * from './domain/index.js';
export * from './services/index.js';
