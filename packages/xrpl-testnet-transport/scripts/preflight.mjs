#!/usr/bin/env node
/**
 * ANDREW-P0-08 — read-only XRPL Testnet preflight for the Andrew demo.
 * Reads only the public *_ADDRESS entries of the secrets file (never a seed),
 * signs nothing, submits nothing, and prints non-secret facts as JSON. The
 * required treasury RLUSD balance is the live demo amount
 * (FRONTERA_ANDREW_LIVE_AMOUNT_USD, default 10).
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { connectXrplPreflightReader, isMainnetEndpoint, runXrplPreflight, XRPL_TESTNET_DOCUMENTED_ENDPOINT, XRPL_TESTNET_NETWORK_ID } from '../dist/index.js';

const RLUSD_CURRENCY = '524C555344000000000000000000000000000000';
const RLUSD_TESTNET_ISSUER = 'rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV';
const secretsFile = process.env.FRONTERA_ANDREW_TESTNET_SECRETS ?? join(homedir(), '.config', 'frontera-andrew', 'testnet.env');
const endpoint = process.env.FRONTERA_XRPL_TESTNET_ENDPOINT ?? XRPL_TESTNET_DOCUMENTED_ENDPOINT;
if (isMainnetEndpoint(endpoint)) {
  console.error('Refusing: Mainnet endpoint.');
  process.exit(2);
}

const addresses = {};
if (existsSync(secretsFile)) {
  for (const line of readFileSync(secretsFile, 'utf8').split(/\r?\n/)) {
    const match = /^(FRONTERA_XRPL_TESTNET_(TREASURY|RECIPIENT)_ADDRESS)=(r[1-9A-HJ-NP-Za-km-z]{24,34})$/.exec(line.trim());
    if (match) addresses[match[2].toLowerCase()] = match[3];
  }
}
if (!addresses.treasury || !addresses.recipient) {
  console.error('Missing treasury or recipient address; run provision-testnet-accounts.mjs first.');
  process.exit(3);
}

const reader = await connectXrplPreflightReader(endpoint);
try {
  const report = await runXrplPreflight(reader, {
    expectedNetworkId: XRPL_TESTNET_NETWORK_ID,
    treasury: addresses.treasury,
    recipient: addresses.recipient,
    currency: RLUSD_CURRENCY,
    issuer: RLUSD_TESTNET_ISSUER,
    requiredValue: process.env.FRONTERA_ANDREW_LIVE_AMOUNT_USD ?? '10', // the live demo amount (a demo parameter), default 10
    minimumXrpDrops: 20_000_000n,
  });
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.ready ? 0 : 1;
} finally {
  await reader.disconnect();
}
