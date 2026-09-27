// `npm run start:enterprise` — the Frontera Enterprise Host launcher.
//
// A thin process wrapper over `bootEnterpriseHost()` (src/enterprise/host/enterprise-host.ts),
// the one canonical bootstrap: configuration, secure-profile validation,
// composition, the posture/health gate and the listener all live there, so this
// file and the tests start the same system. See docs/enterprise/AOC_ENTERPRISE_HOST.md.
import { bootEnterpriseHost, isEnterpriseHostConfigurationError } from '../dist/src/enterprise/index.js';

/** One line, code first. Messages are secret-free by construction; no stack, no environment. */
function describe(error) {
  const code = isEnterpriseHostConfigurationError(error) ? error.code : typeof error?.code === 'string' ? error.code : 'HOST_STARTUP_FAILED';
  const message = error instanceof Error ? error.message : String(error);
  return `[${code}] ${message}`;
}

let host;
let stopRequested = false;

function shutdown() {
  host.close().then(
    () => process.exit(0),
    (error) => {
      console.error(`Frontera Enterprise Host shutdown failed ${describe(error)}`);
      process.exit(1);
    },
  );
}

// Installed before boot: a signal that arrives while the Host is starting is
// honoured once boot settles — stores are closed, never abandoned mid-start —
// instead of killing the process with the default action.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    if (stopRequested) return;
    stopRequested = true;
    if (host !== undefined) shutdown();
  });
}

try {
  host = await bootEnterpriseHost();
  if (stopRequested) {
    shutdown();
  } else {
    const { host: address, port } = await host.listen();
    const p = host.posture;
    console.log(`Frontera Enterprise Host listening on http://${address}:${port}`);
    console.log(
      `posture: environment=${p.environment} persistence=${p.persistence} authentication=${p.authentication} governedActions=${p.governedActions} authorityStore=${p.authorityStore} executionAdapters=${p.executionAdapters}`,
    );
    if (p.persistence === 'ephemeral') {
      console.log('WARNING: ephemeral in-memory state (development only). Every grant, revocation and ledger entry is lost when this process exits.');
    }
  }
} catch (error) {
  console.error(`Frontera Enterprise Host refused to start ${describe(error)}`);
  process.exit(1);
}
