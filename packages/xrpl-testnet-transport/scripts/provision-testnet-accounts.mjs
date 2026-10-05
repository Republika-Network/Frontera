#!/usr/bin/env node
/**
 * ANDREW-P0-08 — one-time XRPL **Testnet** account setup for the Andrew demo.
 *
 * Creates (or reuses) two Testnet wallets — TREASURY and RECIPIENT — funds them
 * with Test XRP from the official Testnet faucet, and sets an RLUSD trust line
 * on each to the official Testnet RLUSD issuer. It does not obtain RLUSD:
 * Testnet RLUSD comes from Ripple's faucet (tryrlusd.com), by a person.
 *
 * Secrets: seeds are written ONLY to the secrets file (default
 * ~/.config/frontera-andrew/testnet.env, directory 0700, file 0600), outside
 * any repository, and are never printed. The script prints public addresses,
 * balances and transaction results only.
 *
 * Testnet only: it refuses to do anything unless the connected server reports
 * network_id 1, and it refuses any endpoint that is not the documented Testnet
 * one unless FRONTERA_XRPL_TESTNET_ALLOW_ENDPOINT is set to that exact value.
 *
 * A trust line is a ledger fact. It is NOT a Frontera destination approval.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { Client, Wallet } from 'xrpl';

const TESTNET_ENDPOINT = 'wss://s.altnet.rippletest.net:51233/';
const TESTNET_NETWORK_ID = 1;
const RLUSD_CURRENCY = '524C555344000000000000000000000000000000';
const RLUSD_TESTNET_ISSUER = 'rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV';
const TRUST_LIMIT = '1000000';
const TF_SET_NO_RIPPLE = 131072;
const SEED_VARIABLES = { treasury: 'FRONTERA_XRPL_TESTNET_TREASURY_SEED', recipient: 'FRONTERA_XRPL_TESTNET_RECIPIENT_SEED' };

const secretsFile = process.env.FRONTERA_ANDREW_TESTNET_SECRETS ?? join(homedir(), '.config', 'frontera-andrew', 'testnet.env');
const endpoint = process.env.FRONTERA_XRPL_TESTNET_ENDPOINT ?? TESTNET_ENDPOINT;
if (endpoint !== TESTNET_ENDPOINT && process.env.FRONTERA_XRPL_TESTNET_ALLOW_ENDPOINT !== endpoint) {
  console.error('Refusing: the endpoint is not the documented XRPL Testnet endpoint.');
  process.exit(2);
}

function readSecrets() {
  if (!existsSync(secretsFile)) return {};
  const out = {};
  for (const line of readFileSync(secretsFile, 'utf8').split(/\r?\n/)) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (match) out[match[1]] = match[2];
  }
  return out;
}

function writeSecrets(values) {
  mkdirSync(dirname(secretsFile), { recursive: true, mode: 0o700 });
  chmodSync(dirname(secretsFile), 0o700);
  const body = ['# XRPL TESTNET ONLY — Andrew demo. Never commit, print or share.', ...Object.entries(values).map(([key, value]) => `${key}=${value}`), ''].join('\n');
  writeFileSync(secretsFile, body, { mode: 0o600 });
  chmodSync(secretsFile, 0o600);
}

const client = new Client(endpoint);
await client.connect();
try {
  const info = await client.request({ command: 'server_info' });
  const networkId = info.result.info.network_id;
  if (networkId !== TESTNET_NETWORK_ID) {
    console.error(`Refusing: the server does not report XRPL Testnet (network_id ${TESTNET_NETWORK_ID}).`);
    process.exit(3);
  }
  console.log(`connected: XRPL Testnet (network_id ${networkId}), validated ledger ${info.result.info.validated_ledger?.seq ?? 'unknown'}`);

  const secrets = readSecrets();
  const wallets = {};
  for (const [role, variable] of Object.entries(SEED_VARIABLES)) {
    if (secrets[variable]) {
      wallets[role] = Wallet.fromSeed(secrets[variable]);
      console.log(`${role}: reusing ${wallets[role].classicAddress}`);
    } else {
      const funded = await client.fundWallet();
      wallets[role] = funded.wallet;
      secrets[variable] = funded.wallet.seed;
      secrets[`FRONTERA_XRPL_TESTNET_${role.toUpperCase()}_ADDRESS`] = funded.wallet.classicAddress;
      writeSecrets(secrets);
      console.log(`${role}: created and faucet-funded ${funded.wallet.classicAddress} (${funded.balance} XRP)`);
    }
  }
  if (wallets.treasury.classicAddress === RLUSD_TESTNET_ISSUER || wallets.recipient.classicAddress === RLUSD_TESTNET_ISSUER) throw new Error('A demo account must not be the issuer.');

  for (const [role, wallet] of Object.entries(wallets)) {
    const lines = await client.request({ command: 'account_lines', account: wallet.classicAddress, peer: RLUSD_TESTNET_ISSUER, ledger_index: 'validated' });
    const existing = lines.result.lines.find((line) => line.currency === RLUSD_CURRENCY);
    if (existing) {
      console.log(`${role}: RLUSD trust line present (limit ${existing.limit}, balance ${existing.balance})`);
      continue;
    }
    const prepared = await client.autofill({ TransactionType: 'TrustSet', Account: wallet.classicAddress, LimitAmount: { currency: RLUSD_CURRENCY, issuer: RLUSD_TESTNET_ISSUER, value: TRUST_LIMIT }, Flags: TF_SET_NO_RIPPLE });
    const signed = wallet.sign(prepared);
    const result = await client.submitAndWait(signed.tx_blob);
    console.log(`${role}: TrustSet ${result.result.hash} → ${result.result.meta?.TransactionResult} (validated ${result.result.validated}, ledger ${result.result.ledger_index})`);
  }

  for (const [role, wallet] of Object.entries(wallets)) {
    const xrp = await client.getXrpBalance(wallet.classicAddress);
    console.log(`${role}: ${wallet.classicAddress} — ${xrp} XRP`);
  }
  console.log(`secrets file: ${secretsFile} (seeds not shown)`);
} finally {
  await client.disconnect();
}
