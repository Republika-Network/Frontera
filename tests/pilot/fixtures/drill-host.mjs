// PROD-03 clean-room drill — the Host process.
//
// TEST ONLY. This is `scripts/run-enterprise-host.mjs` — the same deployment
// preflight, the same `bootEnterpriseHost()`, the same listen banner and the
// same graceful SIGTERM shutdown — run from a staged RELEASE root (a copy of
// the build with a recorded release identity, as the pilot image is), plus
// exactly one in-process provider adapter: the documented embedder seam
// (`BootEnterpriseHostOptions.executionAdapters`, used by every CTRL host
// qualification). The adapter is a member of the Host's trusted registry and is
// reached only through the governed-action file's route, after authorization;
// it forwards the validated action to the reference target, a separate process.
//
// Why not Generic HTTP: the shipped Generic HTTP adapter refuses loopback and
// private targets by design (SSRF boundary, `public-address-policy.ts`), so a
// drill on one machine cannot point it at a local target. Its request mapping
// and transport are qualified by their own suites; a pilot points it at its own
// public https target (docs/pilot/ONBOARDING_RUNBOOK.md §2).
import { request } from 'node:http';

const stage = process.env.FRONTERA_DRILL_STAGE;
const targetUrl = process.env.FRONTERA_DRILL_TARGET_URL;
if (stage === undefined || targetUrl === undefined) {
  console.error('drill-host: FRONTERA_DRILL_STAGE and FRONTERA_DRILL_TARGET_URL are required');
  process.exit(1);
}
const { bootEnterpriseHost, createEnterpriseLogger, isEnterpriseHostConfigurationError } = await import(`${stage}/dist/src/enterprise/index.js`);
const { firstFailure, formatPreflight, runHostPreflight } = await import(`${stage}/scripts/deploy/host-preflight.mjs`);

export const REFERENCE_TARGET_ADAPTER_ID = 'pilot.reference-target';
const TIMEOUT_MS = Number(process.env.FRONTERA_DRILL_TARGET_TIMEOUT_MS ?? '1500');

/** One POST to the target. Refused before sending → failed; sent and unanswered → unconfirmed; answered → by status. */
function forward(action) {
  const body = JSON.stringify({ executionId: action.correlation.executionId, requestId: action.correlation.requestId, action: action.action, resource: action.resource, parameters: action.parameters ?? null });
  return new Promise((resolveResult) => {
    let sent = false;
    const req = request(new URL('/effects', targetUrl), { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }, timeout: TIMEOUT_MS }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        if (res.statusCode === 200) {
          try {
            resolveResult({ outcome: 'completed', providerRef: JSON.parse(Buffer.concat(chunks).toString('utf8')).effectId });
          } catch {
            resolveResult({ outcome: 'unconfirmed' });
          }
        } else if (res.statusCode === 409) resolveResult({ outcome: 'failed', reason: 'PROVIDER_REJECTED' });
        else resolveResult({ outcome: 'unconfirmed' });
      });
    });
    req.on('finish', () => {
      sent = true;
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (error) => resolveResult(!sent && error.code === 'ECONNREFUSED' ? { outcome: 'failed', reason: 'PROVIDER_UNAVAILABLE' } : { outcome: 'unconfirmed' }));
    req.end(body);
  });
}

const referenceTarget = { adapterId: REFERENCE_TARGET_ADAPTER_ID, execute: forward };

// ---- from here on: scripts/run-enterprise-host.mjs, unchanged in substance ----

function describe(error) {
  const code = isEnterpriseHostConfigurationError(error) ? error.code : typeof error?.code === 'string' ? error.code : 'HOST_STARTUP_FAILED';
  return `[${code}] ${error instanceof Error ? error.message : String(error)}`;
}
let host;
let stopRequested = false;
function exitAfterFlush(code) {
  process.stdout.write('', () => process.stderr.write('', () => process.exit(code)));
}
function shutdown() {
  host.close().then(
    () => exitAfterFlush(0),
    (error) => {
      console.error(`Frontera Enterprise Host shutdown failed ${describe(error)}`);
      exitAfterFlush(1);
    },
  );
}
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    if (stopRequested) return;
    stopRequested = true;
    if (host !== undefined) shutdown();
  });
}
async function start() {
  const preflight = await runHostPreflight(process.env, { root: stage });
  if (!preflight.ok) {
    for (const line of formatPreflight(preflight)) console.error(line);
    const failure = firstFailure(preflight);
    createEnterpriseLogger('error').error('enterprise.host.refused', { phase: 'preflight', errorCode: failure.code });
    console.error(`Frontera Enterprise Host refused to start [${failure.code}] ${failure.detail}`);
    return 1;
  }
  host = await bootEnterpriseHost({ executionAdapters: [referenceTarget] });
  if (stopRequested) {
    shutdown();
    return undefined;
  }
  const { host: address, port } = await host.listen();
  console.log(`Frontera Enterprise Host listening on http://${address}:${port}`);
  console.log(`release: ${host.release.release} build=${host.release.build} api=${host.release.api.surface}`);
  return undefined;
}
try {
  const refused = await start();
  if (refused !== undefined) exitAfterFlush(refused);
} catch (error) {
  console.error(`Frontera Enterprise Host refused to start ${describe(error)}`);
  exitAfterFlush(1);
}
