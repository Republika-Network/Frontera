#!/usr/bin/env node
/**
 * ANDREW-DEMO-UI-01 — the visual Andrew/LUMX demo (local, 127.0.0.1 only).
 *
 *   npm run demo:andrew:ui         REHEARSAL — scripted ledger, no XRPL transaction, no secrets read
 *   npm run demo:andrew:ui:live    LIVE • XRPL TESTNET — real Testnet payment only on an explicit EXECUTE click
 *
 * Opt-in: run only by these explicit commands. Forwards only non-secret
 * overrides (state root, secrets-file path, Testnet endpoint, amount, port);
 * secrets are read by the backend from the owner-only secrets file in LIVE
 * mode only and never reach the browser.
 */
import { startAndrewDemoUi } from '../tools/andrew-demo-ui/dist/main.js';

const mode = process.argv.includes('--live') ? 'live' : 'rehearsal';
const environment = {
  FRONTERA_ANDREW_SECRETS_FILE: process.env.FRONTERA_ANDREW_SECRETS_FILE,
  FRONTERA_ANDREW_STATE_ROOT: process.env.FRONTERA_ANDREW_STATE_ROOT,
  FRONTERA_XRPL_TESTNET_ENDPOINT: process.env.FRONTERA_XRPL_TESTNET_ENDPOINT,
  FRONTERA_ANDREW_LIVE_AMOUNT_USD: process.env.FRONTERA_ANDREW_LIVE_AMOUNT_USD,
};
for (const name of Object.keys(environment)) if (environment[name] === undefined) delete environment[name];
const port = process.env.FRONTERA_ANDREW_UI_PORT === undefined ? undefined : Number(process.env.FRONTERA_ANDREW_UI_PORT);

const started = await startAndrewDemoUi({ mode, environment, ...(port !== undefined ? { port } : {}), write: (line) => process.stdout.write(`${line}\n`) });
if (started === undefined) {
  process.exitCode = 2;
} else {
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await started.stop();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
