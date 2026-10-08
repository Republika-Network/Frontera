// `npm run check:host-configuration` — validates an Enterprise Host deployment
// without starting it (PROD-03-03).
//
// Reads the same process environment the launcher reads and runs the same
// preflight the launcher runs before boot (scripts/deploy/host-preflight.mjs):
// the build's release identity, example placeholders, the Host's own strict
// configuration parser and secure-profile rules, and the storage every composed
// store will use. Binds nothing, writes no store, contacts no signer or witness.
//
// Exit 0: every check passed (warnings allowed). Exit 1: at least one failure.
// Output names checks, variables and closed codes — never a value or a path.
// Run after `npm run build`. In the pilot container:
//   docker compose run --rm config-check   (deploy/pilot: no network, nothing else started)
import { formatPreflight, runHostPreflight } from './deploy/host-preflight.mjs';

let result;
try {
  result = await runHostPreflight(process.env);
} catch (error) {
  console.error(`Frontera Host preflight could not run: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`);
}
if (result !== undefined) for (const line of formatPreflight(result)) console.log(line);
// Set, not process.exit(): the process ends once the report has been written
// out, even when stdout is a pipe.
process.exitCode = result?.ok === true ? 0 : 1;
