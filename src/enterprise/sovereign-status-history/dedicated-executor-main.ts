import { isAbsolute } from 'node:path';

import { runDedicatedFvExecutorOrRefuse } from './dedicated-executor.js';

/**
 * FV-P4C-2B3C-1 — the production entry of the dedicated FV executor process. **Inactive by
 * construction.** It composes nothing: the executor's identity owner (B3C-3) and a trusted
 * issuer-currentness source (B6) do not exist yet, so its composition function is absent. Started by a
 * supervisor, it runs its preflight, reports `FAILED` / `DEPENDENCIES_UNAVAILABLE`, opens and holds
 * nothing, and waits to be stopped. Run any other way (not a supervised child, not Linux, a worker), it
 * refuses.
 *
 * Its one argument is the protected store's absolute path. No environment variable is read, no module
 * is loaded by name, no configuration file is parsed. Nothing in the Host, scripts or deployment starts
 * it (structure tests pin this).
 */
if (require.main === module) {
  const protectedStorePath = process.argv[2];
  runDedicatedFvExecutorOrRefuse({
    protectedStorePath: typeof protectedStorePath === 'string' && isAbsolute(protectedStorePath) ? protectedStorePath : '',
    compose: undefined,
  });
}
