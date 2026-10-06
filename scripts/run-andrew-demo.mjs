#!/usr/bin/env node
/**
 * ANDREW-P0-11 — the one-command Andrew/LUMX demo (XRPL Testnet only).
 *
 *   npm run demo:andrew              preflight, then Scenario A (one real Testnet payment) and Scenario B
 *   npm run demo:andrew:preflight    read-only preflight only; no governed action
 *
 * Opt-in: run only by these explicit commands. Not part of `npm test`, the
 * build, CI, publishability or application startup. Fails closed: a NOT READY
 * preflight stops before any governed action (exit 2); any failure after that
 * exits 1 and never prints DEMO PASS.
 *
 * Secrets come only from the owner-only secrets file
 * (`~/.config/frontera-andrew/testnet.env`, or FRONTERA_ANDREW_SECRETS_FILE);
 * nothing here reads, logs or forwards a secret. Non-secret overrides:
 * FRONTERA_ANDREW_STATE_ROOT, FRONTERA_XRPL_TESTNET_ENDPOINT (Testnet only),
 * FRONTERA_ANDREW_LIVE_AMOUNT_USD (default 10).
 *
 * This file only wires: the harness (tools/andrew-demo-harness) receives the
 * live XRPL Testnet ports by injection.
 */
import { runAndrewDemo } from '../tools/andrew-demo-harness/dist/demo.js';
import { createLedgerPorts } from '../tools/andrew-demo-harness/dist/live-wiring.js';

const preflightOnly = process.argv.includes('--preflight-only');
let interrupted = false;
// An interruption is honoured at the next checkpoint, never in the middle of a submission.
process.on('SIGINT', () => {
  interrupted = true;
});

const environment = {
  FRONTERA_ANDREW_SECRETS_FILE: process.env.FRONTERA_ANDREW_SECRETS_FILE,
  FRONTERA_ANDREW_STATE_ROOT: process.env.FRONTERA_ANDREW_STATE_ROOT,
  FRONTERA_XRPL_TESTNET_ENDPOINT: process.env.FRONTERA_XRPL_TESTNET_ENDPOINT,
  FRONTERA_ANDREW_LIVE_AMOUNT_USD: process.env.FRONTERA_ANDREW_LIVE_AMOUNT_USD,
};
for (const name of Object.keys(environment)) if (environment[name] === undefined) delete environment[name];

const result = await runAndrewDemo({
  environment,
  ports: createLedgerPorts(),
  write: (line) => process.stdout.write(`${line}\n`),
  preflightOnly,
  isInterrupted: () => interrupted,
});
process.exitCode = result.exitCode;
