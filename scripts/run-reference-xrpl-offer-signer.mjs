// The local REFERENCE delegated XRPL OfferCreate signer (TRADE-04B, hardened by
// TRADE-04C-S1) — a separate process that holds disposable XRPL *delegate* keys
// and answers the closed `frontera.xrpl-delegated-offer-signer.v2` protocol:
// it signs only for a CORE-02 delegated-offer signing capability it verifies
// against the authority key it pins, and consumes each capability durably
// before touching a key. NOT an HSM, NOT a
// KMS, NOT hardware-backed, NOT a custody certification: a reference custody
// boundary for development and isolated XRPL Testnet qualification. Binds a
// literal loopback address only. Never connects to XRPL, never submits, never
// holds an owner key. Run after `npm run build`.
//
//   node scripts/run-reference-xrpl-offer-signer.mjs create-key <network> <ownerAccount> [<ownerAccount> …]
//       Explicitly creates FRONTERA_REFERENCE_XRPL_OFFER_SIGNER_KEY_FILE (create-only, mode 0600,
//       refused on a filesystem that cannot enforce it — e.g. /mnt/c under WSL) with one fresh
//       delegate key per owner, and writes its PUBLIC identity to <file>.pub for the operator to pin.
//       Owner accounts are public; no seed is ever accepted as an argument.
//
//   node scripts/run-reference-xrpl-offer-signer.mjs
//       Serves an EXISTING key file. A missing key file is refused, never created.
//
// Its own environment (never the Host's):
//   FRONTERA_REFERENCE_XRPL_OFFER_SIGNER_KEY_FILE   the key file (Linux filesystem, 0600)
//   FRONTERA_REFERENCE_XRPL_OFFER_SIGNER_ID         the signer id it answers as
//   FRONTERA_REFERENCE_XRPL_OFFER_SIGNER_TOKEN      the bearer credential callers present (>= 32 chars)
//   FRONTERA_REFERENCE_XRPL_OFFER_SIGNER_MAX_FEE    fee ceiling in drops (default 100)
//   FRONTERA_REFERENCE_XRPL_OFFER_SIGNER_PORT       default 0 (ephemeral)
//   FRONTERA_REFERENCE_XRPL_OFFER_SIGNER_HOST       default 127.0.0.1; literal loopback only
//   FRONTERA_REFERENCE_XRPL_OFFER_SIGNER_AUTHORITY_KEY_ID          the CORE-02 authority key id it accepts capabilities from
//   FRONTERA_REFERENCE_XRPL_OFFER_SIGNER_AUTHORITY_PUBLIC_KEY_FILE that key's PUBLIC half (SPKI PEM, e.g. the reference
//                                                                  authority signer's <key>.pub); never a private key
//   FRONTERA_REFERENCE_XRPL_OFFER_SIGNER_TRUST_DOMAIN              the Host's governedActions.trustDomainId
//   FRONTERA_REFERENCE_XRPL_OFFER_SIGNER_ORGANIZATION_ID           the organization it signs for
//   FRONTERA_REFERENCE_XRPL_OFFER_SIGNER_CONSUMPTION_LEDGER        the durable capability consumption ledger (SQLite file)
//
// No trusted ledger reference is injected here (the reference reads no ledger), so its
// LastLedgerSequence horizon check is deferred to the Host-side client. See
// docs/integrations/trade/TRADE-04B-PROTECTED-DELEGATED-SIGNER.md.
import { readFileSync } from 'node:fs';

import {
  createReferenceDelegatedOfferKeyFile,
  loadReferenceDelegatedOfferKeyFile,
  startReferenceDelegatedOfferSigner,
} from '../dist/src/enterprise/xrpl-trade-rail/reference/reference-delegated-offer-signer.js';

function refuse(message) {
  // Never a key, seed or credential: a value-free line.
  console.error(`reference delegated offer signer refused: ${message}`);
  process.exit(1);
}

function required(name) {
  const value = process.env[name];
  if (value === undefined || value.length === 0) refuse(`${name} is required.`);
  return value;
}

const keyFile = required('FRONTERA_REFERENCE_XRPL_OFFER_SIGNER_KEY_FILE');

if (process.argv[2] === 'create-key') {
  const [network, ...ownerAccounts] = process.argv.slice(3);
  try {
    const { pairs } = createReferenceDelegatedOfferKeyFile(keyFile, { network, ownerAccounts });
    console.log(`reference delegated offer key file created; public identity written to ${keyFile}.pub (${pairs.length} pair(s)). Pin it in the Host; authorize each delegate on the ledger (XLS-75 DelegateSet, OfferCreate) from its owner.`);
  } catch (error) {
    refuse(error instanceof Error ? error.message.split('\n')[0] : 'key creation failed');
  }
  process.exit(0);
}
if (process.argv.length > 2) refuse('unknown arguments; the only command is create-key.');

const signerId = required('FRONTERA_REFERENCE_XRPL_OFFER_SIGNER_ID');
const credential = required('FRONTERA_REFERENCE_XRPL_OFFER_SIGNER_TOKEN');
const maximumFeeDrops = process.env.FRONTERA_REFERENCE_XRPL_OFFER_SIGNER_MAX_FEE ?? '100';
const port = Number.parseInt(process.env.FRONTERA_REFERENCE_XRPL_OFFER_SIGNER_PORT ?? '0', 10);
const host = process.env.FRONTERA_REFERENCE_XRPL_OFFER_SIGNER_HOST ?? '127.0.0.1';
const authorityKeyId = required('FRONTERA_REFERENCE_XRPL_OFFER_SIGNER_AUTHORITY_KEY_ID');
const authorityPublicKeyFile = required('FRONTERA_REFERENCE_XRPL_OFFER_SIGNER_AUTHORITY_PUBLIC_KEY_FILE');
const trustDomain = required('FRONTERA_REFERENCE_XRPL_OFFER_SIGNER_TRUST_DOMAIN');
const organizationId = required('FRONTERA_REFERENCE_XRPL_OFFER_SIGNER_ORGANIZATION_ID');
const consumptionLedgerPath = required('FRONTERA_REFERENCE_XRPL_OFFER_SIGNER_CONSUMPTION_LEDGER');

let signer;
try {
  const { network, keys } = loadReferenceDelegatedOfferKeyFile(keyFile);
  let publicKeyPem;
  try {
    publicKeyPem = readFileSync(authorityPublicKeyFile, 'utf8');
  } catch {
    refuse('the authority public key file is not readable.');
  }
  signer = await startReferenceDelegatedOfferSigner({
    signerId,
    network,
    credential,
    keys,
    maximumFeeDrops,
    clock: () => Date.now(),
    authorization: { issuerKeys: [{ keyId: authorityKeyId, algorithm: 'ed25519-v1', publicKeyPem }], trustDomain, organizationId },
    consumptionLedgerPath,
    host,
    port,
  });
} catch (error) {
  refuse(error instanceof Error ? error.message.split('\n')[0] : 'startup failed');
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    signer.close().then(() => process.exit(0));
  });
}

// Public identity only.
const where = host.includes(':') ? `[${host}]` : host;
console.log(`reference delegated offer signer (NOT an HSM) listening on http://${where}:${signer.port} signerId=${signerId} network=${signer.identity.network} pairs=${JSON.stringify(signer.identity.pairs)} authorization=${JSON.stringify(signer.identity.authorization)}`);
