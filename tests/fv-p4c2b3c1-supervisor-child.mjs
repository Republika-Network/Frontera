// FV-P4C-2B3C-1 — a supervisor in its own process, for the supervisor-crash tests: it supervises one
// test-harness executor and reports each lifecycle observation as a JSON line. The test kills THIS
// process; the executor must then stop cleanly on its own. Not a test file itself.
import { fileURLToPath } from 'node:url';

import { createFvExecutorSupervisor } from '../dist/src/enterprise/sovereign-status-history/dedicated-executor-supervisor.js';

const ENTRY = fileURLToPath(new URL('./fv-p4c2b3c1-executor-entry.mjs', import.meta.url));
const supervisor = createFvExecutorSupervisor({
  entry: ENTRY,
  args: [process.argv[2]],
  onEvent: ({ kind, snapshot }) => process.stdout.write(`${JSON.stringify({ kind, pid: snapshot.pid, state: snapshot.executorState, phase: snapshot.phase })}\n`),
});
supervisor.start();
setInterval(() => undefined, 60_000);
