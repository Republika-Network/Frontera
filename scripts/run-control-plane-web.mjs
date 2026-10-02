// `npm run start:control-plane` — the Frontera web control plane (CTRL-03).
//
// A thin process wrapper over `createControlPlaneWebServer()`
// (src/control-plane-web/server.ts): a server-rendered, script-free console
// that operates a running Frontera Host through its operator plane over HTTP
// only. It holds no store, key or Host internals. See
// docs/architecture/ADR-CTRL-03-WEB-CONTROL-PLANE.md.
import { createControlPlaneWebServer, loadControlPlaneWebConfiguration } from '../dist/src/control-plane-web/index.js';

let console_;
try {
  const configuration = loadControlPlaneWebConfiguration(process.env);
  console_ = createControlPlaneWebServer(configuration, {
    // Request attribution only: method, route shape, status. Never a body, header, cookie or query.
    logger: { info: (message, fields) => console.log(JSON.stringify({ message, ...fields })) },
  });
  const { host, port } = await console_.listen();
  console.log(`Frontera Control Plane listening on http://${host.includes(':') ? `[${host}]` : host}:${port} (public origin ${configuration.publicOrigin}), operating ${configuration.hostUrl}`);
} catch (error) {
  console.error(`Frontera Control Plane refused to start: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console_.close().then(() => process.exit(0));
  });
}
