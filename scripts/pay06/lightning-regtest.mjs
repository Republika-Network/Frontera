#!/usr/bin/env node
/**
 * PAY-06 — Lightning regtest qualification topology (qualification tooling only;
 * the product never depends on Docker).
 *
 *   alice (payer, Frontera's node) ──channel──► carol (router, charges a fee) ──channel──► bob (payee)
 *
 * One bitcoind (regtest) and three LND nodes, pinned:
 *   lightninglabs/bitcoin-core:29.1 · lightninglabs/lnd:v0.20.5-beta
 *
 *   node scripts/pay06/lightning-regtest.mjs up      start, fund, open channels, write <state>/regtest.json
 *   node scripts/pay06/lightning-regtest.mjs down    remove the containers and the network
 *
 * <state> is FRONTERA_LIGHTNING_REGTEST_DIR or <tmpdir>/frontera-pay06-regtest —
 * never inside the repository. It receives alice's REST endpoint and TLS
 * certificate and two macaroons BAKED NARROW on alice:
 *
 *   payer.macaroon   offchain:read offchain:write info:read   (the rail: read + the one send)
 *   reader.macaroon  offchain:read info:read                  (P12 / finality: LND itself refuses a send with it)
 *
 * and, for the payer-identity qualification only, carol's REST endpoint, TLS
 * certificate and a read-only macaroon baked on carol (another real node on the
 * same network — never a payer Frontera composes):
 *
 *   carol-reader.macaroon  offchain:read info:read
 *
 * bob's invoices (plain and hold) are created by the qualification test with
 * `docker exec … lncli` — the payee is outside Frontera, which never creates
 * or authorizes the invoice it pays. Regtest only: no mainnet, no real funds.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BITCOIND_IMAGE = 'lightninglabs/bitcoin-core:29.1';
const LND_IMAGE = 'lightninglabs/lnd:v0.20.5-beta';
const NETWORK = 'frontera-pay06-regtest';
const PREFIX = 'frontera-pay06';
const RPC = ['-rpcuser=pay06', '-rpcpassword=pay06-regtest-only'];
const NODES = { alice: 18080, bob: 18081, carol: 18082 };
/** carol's fee on the carol → bob channel: 5 000 msat base + 1 000 ppm. A 250 000 sat payment costs ≈ 255 000 msat. */
export const CAROL_FEE = { baseMsat: 5000, ppm: 1000 };

export const stateDirectory = () => process.env.FRONTERA_LIGHTNING_REGTEST_DIR ?? join(tmpdir(), 'frontera-pay06-regtest');

function docker(args, options = {}) {
  return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', options.quiet ? 'ignore' : 'pipe'], timeout: options.timeout ?? 120_000 }).trim();
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function lncli(node, args) {
  return JSON.parse(lncliRaw(node, args));
}

function lncliRaw(node, args) {
  return docker(['exec', `${PREFIX}-${node}`, 'lncli', '--network=regtest', ...args]);
}

function bitcoinCli(args) {
  return docker(['exec', `${PREFIX}-bitcoind`, 'bitcoin-cli', '-regtest', ...RPC, ...args]);
}

export function mine(blocks) {
  const address = bitcoinCli(['-rpcwallet=miner', 'getnewaddress']);
  bitcoinCli(['-rpcwallet=miner', 'generatetoaddress', String(blocks), address]);
}

async function until(label, probe, attempts = 90) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const value = await probe();
      if (value) return value;
    } catch {
      // not yet
    }
    await sleep(1000);
  }
  throw new Error(`regtest: timed out waiting for ${label}`);
}

export function down() {
  for (const name of ['alice', 'bob', 'carol', 'bitcoind']) {
    try {
      docker(['rm', '-f', `${PREFIX}-${name}`], { quiet: true });
    } catch {
      // absent
    }
  }
  try {
    docker(['network', 'rm', NETWORK], { quiet: true });
  } catch {
    // absent
  }
}

export async function up() {
  down();
  docker(['network', 'create', NETWORK]);
  docker([
    'run', '-d', '--name', `${PREFIX}-bitcoind`, '--network', NETWORK, BITCOIND_IMAGE,
    '-regtest', '-server', '-txindex', '-fallbackfee=0.0002', '-rpcbind=0.0.0.0', '-rpcallowip=0.0.0.0/0', ...RPC,
    '-zmqpubrawblock=tcp://0.0.0.0:28332', '-zmqpubrawtx=tcp://0.0.0.0:28333',
  ]);
  await until('bitcoind', () => bitcoinCli(['getblockchaininfo']).includes('regtest'));
  bitcoinCli(['createwallet', 'miner']);
  mine(101);
  for (const [name, port] of Object.entries(NODES)) {
    docker([
      'run', '-d', '--name', `${PREFIX}-${name}`, '--network', NETWORK, '-p', `127.0.0.1:${port}:8080`, LND_IMAGE,
      '--bitcoin.regtest', '--bitcoin.node=bitcoind', `--bitcoind.rpchost=${PREFIX}-bitcoind`, '--bitcoind.rpcuser=pay06', '--bitcoind.rpcpass=pay06-regtest-only',
      `--bitcoind.zmqpubrawblock=tcp://${PREFIX}-bitcoind:28332`, `--bitcoind.zmqpubrawtx=tcp://${PREFIX}-bitcoind:28333`,
      '--noseedbackup', '--restlisten=0.0.0.0:8080', '--rpclisten=0.0.0.0:10009', '--listen=0.0.0.0:9735', `--alias=${name}`,
      `--tlsextradomain=${PREFIX}-${name}`, '--bitcoin.defaultchanconfs=1', '--trickledelay=100', '--maxpendingchannels=4',
    ]);
  }
  const info = {};
  for (const name of Object.keys(NODES)) info[name] = await until(`${name} synced`, () => {
    const answer = lncli(name, ['getinfo']);
    return answer.synced_to_chain === true ? answer : undefined;
  });
  // Fund alice and carol on chain.
  for (const name of ['alice', 'carol']) {
    const { address } = lncli(name, ['newaddress', 'p2wkh']);
    bitcoinCli(['-rpcwallet=miner', 'sendtoaddress', address, '5']);
  }
  mine(6);
  await until('wallets funded', () => ['alice', 'carol'].every((name) => Number(lncli(name, ['walletbalance']).confirmed_balance) > 0));
  // Peers and channels: alice → carol, carol → bob.
  lncli('alice', ['connect', `${info.carol.identity_pubkey}@${PREFIX}-carol:9735`]);
  lncli('carol', ['connect', `${info.bob.identity_pubkey}@${PREFIX}-bob:9735`]);
  lncli('alice', ['openchannel', `--node_key=${info.carol.identity_pubkey}`, '--local_amt=5000000']);
  lncli('carol', ['openchannel', `--node_key=${info.bob.identity_pubkey}`, '--local_amt=5000000']);
  mine(6);
  await until('channels active', () => lncli('alice', ['listchannels']).channels?.some((channel) => channel.active) && lncli('carol', ['listchannels']).channels?.filter((channel) => channel.active).length === 2);
  // carol charges for forwarding to bob.
  const carolToBob = lncli('carol', ['listchannels']).channels.find((channel) => channel.remote_pubkey === info.bob.identity_pubkey);
  const setPolicy = () => lncli('carol', ['updatechanpolicy', `--base_fee_msat=${CAROL_FEE.baseMsat}`, `--fee_rate_ppm=${CAROL_FEE.ppm}`, '--time_lock_delta=40', `--chan_point=${carolToBob.channel_point}`]);
  setPolicy();
  mine(6);
  // alice must see carol's policy before routing: wait until a route to bob is quoted with carol's fee. An update made
  // before the channel was announced can be dropped by gossip, so it is re-issued (a fresh timestamp) while waiting.
  let polls = 0;
  await until('alice learns the route and carol’s fee', () => {
    polls += 1;
    if (polls % 10 === 0) setPolicy();
    const routes = lncli('alice', ['queryroutes', `--dest=${info.bob.identity_pubkey}`, '--amt=250000']);
    return routes.routes?.length > 0 && Number(routes.routes[0].total_fees_msat) >= CAROL_FEE.baseMsat;
  }, 120);
  // Narrow macaroons on alice: the rail's (read + send) and the authorities' (read only).
  const payer = lncliRaw('alice', ['bakemacaroon', 'offchain:read', 'offchain:write', 'info:read']);
  const reader = lncliRaw('alice', ['bakemacaroon', 'offchain:read', 'info:read']);
  if (!/^[0-9a-f]+$/.test(payer) || !/^[0-9a-f]+$/.test(reader)) throw new Error('regtest: a baked macaroon is not hex');
  const certificate = docker(['exec', `${PREFIX}-alice`, 'cat', '/root/.lnd/tls.cert']);
  const carolReader = lncliRaw('carol', ['bakemacaroon', 'offchain:read', 'info:read']);
  if (!/^[0-9a-f]+$/.test(carolReader)) throw new Error('regtest: a baked macaroon is not hex');
  const carolCertificate = docker(['exec', `${PREFIX}-carol`, 'cat', '/root/.lnd/tls.cert']);
  const directory = stateDirectory();
  mkdirSync(directory, { recursive: true });
  const state = {
    network: 'regtest',
    alice: { endpoint: `https://127.0.0.1:${NODES.alice}`, identity: info.alice.identity_pubkey },
    bob: { identity: info.bob.identity_pubkey },
    carol: { endpoint: `https://127.0.0.1:${NODES.carol}`, identity: info.carol.identity_pubkey, fee: CAROL_FEE },
    files: {
      certificate: join(directory, 'alice-tls.cert'),
      payerMacaroon: join(directory, 'payer.macaroon'),
      readerMacaroon: join(directory, 'reader.macaroon'),
      carolCertificate: join(directory, 'carol-tls.cert'),
      carolReaderMacaroon: join(directory, 'carol-reader.macaroon'),
    },
  };
  writeFileSync(state.files.certificate, `${certificate}\n`);
  writeFileSync(state.files.payerMacaroon, payer, { mode: 0o600 });
  writeFileSync(state.files.readerMacaroon, reader, { mode: 0o600 });
  writeFileSync(state.files.carolCertificate, `${carolCertificate}\n`);
  writeFileSync(state.files.carolReaderMacaroon, carolReader, { mode: 0o600 });
  writeFileSync(join(directory, 'regtest.json'), JSON.stringify(state, null, 2));
  return state;
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop())) {
  const command = process.argv[2];
  if (command === 'up') {
    const state = await up();
    console.log(`PAY-06 regtest up — state in ${stateDirectory()} (alice ${state.alice.identity.slice(0, 12)}…, bob ${state.bob.identity.slice(0, 12)}…)`);
  } else if (command === 'down') {
    down();
    console.log('PAY-06 regtest down');
  } else {
    console.error('usage: node scripts/pay06/lightning-regtest.mjs up|down');
    process.exit(2);
  }
}
