// PROD-03-03 — the container health probe. The runtime image ships no curl.
//
//   node scripts/deploy/probe.mjs http <path>   GET http://127.0.0.1:<AOC_ENTERPRISE_HTTP_PORT|8787><path>; exit 0 on HTTP 200
//   node scripts/deploy/probe.mjs tcp <port>    exit 0 when 127.0.0.1:<port> accepts a connection
//
// Loopback only, no credential, prints nothing on success and one line on
// failure. The image's HEALTHCHECK and the pilot Compose file use it; it
// decides nothing about the Host (that is `/ready`).
import { connect } from 'node:net';

const [mode, target] = process.argv.slice(2);
const TIMEOUT_MS = 4000;

function done(ok, why) {
  if (!ok) console.error(`probe failed: ${why}`);
  process.exit(ok ? 0 : 1);
}

if (mode === 'http' && typeof target === 'string' && target.startsWith('/')) {
  const port = process.env.AOC_ENTERPRISE_HTTP_PORT ?? '8787';
  fetch(`http://127.0.0.1:${port}${target}`, { signal: AbortSignal.timeout(TIMEOUT_MS) }).then(
    (response) => done(response.status === 200, `${target} answered ${response.status}`),
    () => done(false, `${target} unreachable`),
  );
} else if (mode === 'tcp' && /^\d{1,5}$/.test(target ?? '')) {
  const socket = connect({ host: '127.0.0.1', port: Number(target) });
  socket.setTimeout(TIMEOUT_MS, () => {
    socket.destroy();
    done(false, `port ${target} timed out`);
  });
  socket.once('connect', () => {
    socket.end();
    done(true);
  });
  socket.once('error', () => done(false, `port ${target} refused`));
} else {
  done(false, 'usage: probe.mjs http <path> | tcp <port>');
}
