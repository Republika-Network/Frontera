// The local REFERENCE external XRPL transaction signer (PAY-03) — a separate
// process that owns one XRPL key and answers the structured
// `frontera.external-xrpl-transaction-signer.v1` protocol. NOT an HSM, NOT a
// KMS, NOT hardware-backed, NOT a custody recommendation: a reference custody
// boundary for development and XRPL Testnet qualification. Binds loopback
// only. Never connects to XRPL, never submits. Run after `npm run build`.
//
// Its own environment (never the Host's — the Host refuses to start if it
// sees any of these):
//   FRONTERA_REFERENCE_XRPL_SIGNER_KEY_FILE  key file. Created (mode 0600) with a
//                                            fresh key if absent; its public
//                                            identity (address + signing public
//                                            key) is written to <file>.pub for
//                                            the operator to pin in the Host's
//                                            governed-action file.
//   FRONTERA_REFERENCE_XRPL_SIGNER_ID        the signer id it answers as.
//   FRONTERA_REFERENCE_XRPL_SIGNER_TOKEN     the bearer credential callers present (>= 32 chars).
//   FRONTERA_REFERENCE_XRPL_SIGNER_PORT      default 0 (ephemeral).
//   FRONTERA_REFERENCE_XRPL_SIGNER_HOST      default 127.0.0.1; loopback only.
//
// See docs/payments/XRPL_PRODUCTION_COMPOSITION.md.
import { loadOrCreateReferenceXrplSignerKey, startReferenceXrplSigner } from '../dist/src/enterprise/xrpl-payment-rail/reference/reference-xrpl-signer-service.js';

function required(name) {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    console.error(`reference XRPL signer refused to start: ${name} is required.`);
    process.exit(1);
  }
  return value;
}

const keyFile = required('FRONTERA_REFERENCE_XRPL_SIGNER_KEY_FILE');
const signerId = required('FRONTERA_REFERENCE_XRPL_SIGNER_ID');
const credential = required('FRONTERA_REFERENCE_XRPL_SIGNER_TOKEN');
const port = Number.parseInt(process.env.FRONTERA_REFERENCE_XRPL_SIGNER_PORT ?? '0', 10);
const host = process.env.FRONTERA_REFERENCE_XRPL_SIGNER_HOST ?? '127.0.0.1';

let signer;
try {
  const { seed } = loadOrCreateReferenceXrplSignerKey(keyFile);
  signer = await startReferenceXrplSigner({ signerId, seed, credential, host, port });
} catch (error) {
  // Never the key, never the credential: a value-free line.
  console.error(`reference XRPL signer refused to start: ${error instanceof Error ? error.message.split('\n')[0] : 'startup failed'}`);
  process.exit(1);
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    signer.close().then(() => process.exit(0));
  });
}

// Public identity only.
console.log(`reference XRPL signer (NOT an HSM) listening on http://${host}:${signer.port} signerId=${signerId} account=${signer.address} signingPublicKey=${signer.signingPublicKey}`);
