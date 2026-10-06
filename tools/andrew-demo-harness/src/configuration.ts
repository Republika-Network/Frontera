import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { DemoConfiguration } from './contracts.js';
import type { SecretGuard } from './secret-guard.js';

/**
 * ANDREW-P0-11 — the live configuration, loaded fail-closed.
 *
 * Secrets come only from a local secrets file with owner-only permissions
 * (default `~/.config/frontera-andrew/testnet.env`). The file is parsed into
 * memory — never into `process.env`, never printed — and every `*_SEED` value
 * in it is registered with the secret guard, including seeds this run never
 * uses. Only the treasury seed is ever handed to a signer.
 *
 * Testnet only: the endpoint defaults to the documented XRPL Testnet WebSocket
 * and any Mainnet server is refused outright; the network id must be 1 and is
 * checked again against every live connection.
 */

export const XRPL_TESTNET_ENDPOINT = 'wss://s.altnet.rippletest.net:51233/';
export const XRPL_TESTNET_NETWORK_ID = 1;
const MAINNET_HOSTS = ['s1.ripple.com', 's2.ripple.com', 'xrplcluster.com', 'xrpl.ws', 'xrpl.link'];
const CANONICAL_DECIMAL = /^(?:0|[1-9]\d*)(?:\.\d*[1-9])?$/;
const CLASSIC_ADDRESS = /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/;

export const SECRET_VARIABLES = { treasurySeed: 'FRONTERA_XRPL_TESTNET_TREASURY_SEED' } as const;

export function defaultStateRoot(): string {
  return join(homedir(), '.config', 'frontera-andrew');
}

export interface LoadedConfiguration {
  readonly configuration: DemoConfiguration;
  /** The parsed secrets file. Seeds by name only; handed to the signer port, never printed or written. */
  readonly secrets: Readonly<Record<string, string>>;
}

export type ConfigurationResult = { readonly ok: true; readonly loaded: LoadedConfiguration } | { readonly ok: false; readonly reasons: readonly string[] };

/** `KEY=value` lines; `#` comments; optional `export `; surrounding quotes stripped. Values are never echoed. */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    const match = /^(?:export\s+)?([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (match === null) continue;
    let value = (match[2] ?? '').trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    out[match[1] ?? ''] = value;
  }
  return out;
}

export function isMainnetEndpoint(endpoint: string): boolean {
  try {
    const host = new URL(endpoint).hostname.toLowerCase();
    return MAINNET_HOSTS.some((mainnet) => host === mainnet || host.endsWith(`.${mainnet}`));
  } catch {
    return false;
  }
}

/** The P0-08 live-amount rules: a positive canonical decimal, at most two decimals (USD scale), below the USD 100,000 authority ceiling. */
export function liveAmountProblem(value: string): string | undefined {
  if (!CANONICAL_DECIMAL.test(value) || value === '0') return 'FRONTERA_ANDREW_LIVE_AMOUNT_USD must be a positive canonical decimal';
  const [integer = '', fraction = ''] = value.split('.');
  if (fraction.length > 2) return 'FRONTERA_ANDREW_LIVE_AMOUNT_USD must have at most two decimals (USD scale)';
  if (BigInt(integer) >= 100_000n) return 'FRONTERA_ANDREW_LIVE_AMOUNT_USD must stay below the USD 100,000 authority ceiling';
  return undefined;
}

/**
 * Load and validate. `environment` supplies non-secret overrides only:
 * `FRONTERA_ANDREW_SECRETS_FILE`, `FRONTERA_ANDREW_STATE_ROOT`,
 * `FRONTERA_XRPL_TESTNET_ENDPOINT`, `FRONTERA_ANDREW_LIVE_AMOUNT_USD`.
 */
export function loadDemoConfiguration(environment: Readonly<Record<string, string | undefined>>, guard: SecretGuard): ConfigurationResult {
  const reasons: string[] = [];
  const stateRoot = environment['FRONTERA_ANDREW_STATE_ROOT'] ?? defaultStateRoot();
  const secretsFile = environment['FRONTERA_ANDREW_SECRETS_FILE'] ?? join(defaultStateRoot(), 'testnet.env');

  let secrets: Record<string, string> = {};
  try {
    const stat = statSync(secretsFile);
    if (!stat.isFile()) reasons.push(`the secrets file ${secretsFile} is not a regular file`);
    else if ((stat.mode & 0o077) !== 0) reasons.push(`the secrets file ${secretsFile} must be readable by its owner only (chmod 600); it is ${(stat.mode & 0o777).toString(8)}`);
    else if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) reasons.push(`the secrets file ${secretsFile} is not owned by the current user`);
    else secrets = parseEnvFile(readFileSync(secretsFile, 'utf8'));
  } catch {
    reasons.push(`the secrets file ${secretsFile} does not exist or cannot be read`);
  }
  for (const [name, value] of Object.entries(secrets)) if (/SEED|SECRET|KEY/.test(name)) guard.register(value);

  const endpoint = environment['FRONTERA_XRPL_TESTNET_ENDPOINT'] ?? XRPL_TESTNET_ENDPOINT;
  let parsed: URL | undefined;
  try {
    parsed = new URL(endpoint);
  } catch {
    reasons.push('the XRPL endpoint is not a URL');
  }
  if (parsed !== undefined) {
    if (parsed.protocol !== 'wss:') reasons.push('the XRPL endpoint must be a wss:// WebSocket endpoint');
    if (parsed.username !== '' || parsed.password !== '') reasons.push('the XRPL endpoint must not carry credentials');
  }
  if (isMainnetEndpoint(endpoint)) reasons.push('the XRPL endpoint is a Mainnet server — this demo is XRPL Testnet only');

  const treasury = secrets['FRONTERA_XRPL_TESTNET_TREASURY_ADDRESS'] ?? '';
  const recipient = secrets['FRONTERA_XRPL_TESTNET_RECIPIENT_ADDRESS'] ?? '';
  if (Object.keys(secrets).length > 0) {
    if (secrets[SECRET_VARIABLES.treasurySeed] === undefined || secrets[SECRET_VARIABLES.treasurySeed] === '') reasons.push(`${SECRET_VARIABLES.treasurySeed} is not set in the secrets file`);
    if (!CLASSIC_ADDRESS.test(treasury)) reasons.push('FRONTERA_XRPL_TESTNET_TREASURY_ADDRESS is missing or not an XRPL classic address');
    if (!CLASSIC_ADDRESS.test(recipient)) reasons.push('FRONTERA_XRPL_TESTNET_RECIPIENT_ADDRESS is missing or not an XRPL classic address');
    if (treasury !== '' && treasury === recipient) reasons.push('the treasury and the recipient must be different accounts');
  }
  const amountUsd = environment['FRONTERA_ANDREW_LIVE_AMOUNT_USD'] ?? '10';
  const amountProblem = liveAmountProblem(amountUsd);
  if (amountProblem !== undefined) reasons.push(amountProblem);

  if (reasons.length > 0) return { ok: false, reasons };
  return {
    ok: true,
    loaded: {
      configuration: Object.freeze({ endpoint, expectedNetworkId: XRPL_TESTNET_NETWORK_ID, treasury, recipient, amountUsd, stateRoot, secretsFile }),
      secrets: Object.freeze({ ...secrets }),
    },
  };
}
