// The local REFERENCE external authority signer (CORE-02) — a separate process
// that owns an authority private key and answers the structured
// `frontera.external-authority-signer.v1` protocol. NOT an HSM, NOT a KMS, NOT
// hardware-backed: a reference custody boundary for development and
// qualification. Binds loopback only. Run after `npm run build`.
//
// Its own environment (never the Host's):
//   FRONTERA_REFERENCE_SIGNER_KEY_FILE  PKCS#8 key file. Created (mode 0600) with
//                                       a fresh Ed25519 key if absent; its public
//                                       half is written to <file>.pub for the
//                                       operator to install in the Host's
//                                       AOC_ENTERPRISE_AUTHORITY_VERIFICATION_KEYS.
//   FRONTERA_REFERENCE_SIGNER_KEY_ID    the key id it signs as.
//   FRONTERA_REFERENCE_SIGNER_TOKEN     the bearer credential callers present (>= 32 chars).
//   FRONTERA_REFERENCE_SIGNER_PORT      default 0 (ephemeral).
//   FRONTERA_REFERENCE_SIGNER_HOST      default 127.0.0.1; loopback only.
//   FRONTERA_REFERENCE_SIGNER_EXTENSIONS optional, comma-separated extension operations to offer
//                                       (TRADE-04C-S1: signDelegatedOfferCapability — required by a
//                                       Host that composes the governed trade executor; G-02B:
//                                       signExecutionCapability — required by a Host that composes
//                                       execution-capability issuance).
//   FRONTERA_REFERENCE_SIGNER_EXECUTION_CAPABILITY_POLICY_FILE
//                                       required exactly when signExecutionCapability is offered: a JSON
//                                       file holding this service's own issuance policy { issuer,
//                                       organizationId, trustDomain, lifetimeMs, audiences }. The rule runs
//                                       against it, never against what a request says.
//
// See docs/architecture/ADR-EXTERNAL-AUTHORITY-SIGNER-AND-KEY-CUSTODY.md.
import { readFileSync } from 'node:fs';

import { loadOrCreateReferenceSignerKey, startReferenceAuthoritySigner } from '../dist/src/enterprise/external-authority-signer/reference/reference-signer-service.js';

function required(name) {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    console.error(`reference authority signer refused to start: ${name} is required.`);
    process.exit(1);
  }
  return value;
}

const keyFile = required('FRONTERA_REFERENCE_SIGNER_KEY_FILE');
const keyId = required('FRONTERA_REFERENCE_SIGNER_KEY_ID');
const credential = required('FRONTERA_REFERENCE_SIGNER_TOKEN');
const port = Number.parseInt(process.env.FRONTERA_REFERENCE_SIGNER_PORT ?? '0', 10);
const host = process.env.FRONTERA_REFERENCE_SIGNER_HOST ?? '127.0.0.1';
const extensions = (process.env.FRONTERA_REFERENCE_SIGNER_EXTENSIONS ?? '').split(',').map((entry) => entry.trim()).filter((entry) => entry.length > 0);

const policyFile = process.env.FRONTERA_REFERENCE_SIGNER_EXECUTION_CAPABILITY_POLICY_FILE;

let signer;
try {
  const executionCapabilityIssuance = policyFile === undefined || policyFile.length === 0 ? undefined : JSON.parse(readFileSync(policyFile, 'utf8'));
  const { privateKeyPem } = loadOrCreateReferenceSignerKey(keyFile);
  signer = await startReferenceAuthoritySigner({ keyId, privateKeyPem, credential, host, port, extensions, ...(executionCapabilityIssuance !== undefined ? { executionCapabilityIssuance } : {}) });
} catch (error) {
  // Never the key, never the credential: a code-free, value-free line.
  console.error(`reference authority signer refused to start: ${error instanceof Error ? error.message.split('\n')[0] : 'startup failed'}`);
  process.exit(1);
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    signer.close().then(() => process.exit(0));
  });
}

console.log(`reference authority signer (NOT an HSM) listening on http://${host}:${signer.port} keyId=${keyId}${extensions.length > 0 ? ` extensions=${extensions.join(',')}` : ''}`);
