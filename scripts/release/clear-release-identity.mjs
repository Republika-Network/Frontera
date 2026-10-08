// PROD-03-03 — runs first in `npm run build`.
//
// A recorded release identity (dist/release-identity.json) describes the one
// build `scripts/release/write-release-identity.mjs` ran after. An ordinary
// rebuild produces new code that no one has identified, so the old record is
// removed and the Host reports itself as a `development` build — never as the
// commit it was identified as before. The container build writes a fresh one
// after compiling.
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

rmSync(fileURLToPath(new URL('../../dist/release-identity.json', import.meta.url)), { force: true });
