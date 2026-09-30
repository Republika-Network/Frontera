// The local REFERENCE authority-state freshness witness (CORE-07) — a separate
// process that holds, for each (state kind, organization) slot, the newest
// checkpoint of a durable authority store's signed head, advances it only by
// compare-and-advance, and signs every answer with its own Ed25519 receipt key.
// NOT an HSM, NOT a cloud immutable ledger, NOT a timestamping authority, NOT a
// blockchain, NOT consensus. Binds loopback only. Run after `npm run build`.
//
// Its security claim holds ONLY while FRONTERA_REFERENCE_WITNESS_DB lives outside
// the authority stores' restore domain: a different volume, backup set and
// snapshot schedule. Restoring the authority databases and this file together
// to the same earlier moment is undetectable by design.
//
// Its own environment (never the Host's):
//   FRONTERA_REFERENCE_WITNESS_DB        its own SQLite database (created if absent).
//   FRONTERA_REFERENCE_WITNESS_KEY_FILE  PKCS#8 Ed25519 receipt key. Created (mode 0600)
//                                        if absent; its public half is written to
//                                        <file>.pub for the operator to install as the
//                                        Host's AOC_ENTERPRISE_AUTHORITY_FRESHNESS_WITNESS_PUBLIC_KEY.
//   FRONTERA_REFERENCE_WITNESS_ID        the witness id every receipt names.
//   FRONTERA_REFERENCE_WITNESS_TOKEN     the bearer credential callers present (>= 32 chars).
//   FRONTERA_REFERENCE_WITNESS_PORT      default 0 (ephemeral).
//   FRONTERA_REFERENCE_WITNESS_HOST      default 127.0.0.1; loopback only.
//
// See docs/architecture/ADR-AUTHORITY-STATE-FRESHNESS-AND-ROLLBACK-DETECTION.md.
import { loadOrCreateReferenceWitnessKey, startReferenceAuthorityStateWitness } from '../dist/src/enterprise/authority-state-freshness/reference/reference-witness-service.js';

function required(name) {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    console.error(`reference authority-state witness refused to start: ${name} is required.`);
    process.exit(1);
  }
  return value;
}

const databasePath = required('FRONTERA_REFERENCE_WITNESS_DB');
const keyFile = required('FRONTERA_REFERENCE_WITNESS_KEY_FILE');
const witnessId = required('FRONTERA_REFERENCE_WITNESS_ID');
const credential = required('FRONTERA_REFERENCE_WITNESS_TOKEN');
const port = Number.parseInt(process.env.FRONTERA_REFERENCE_WITNESS_PORT ?? '0', 10);
const host = process.env.FRONTERA_REFERENCE_WITNESS_HOST ?? '127.0.0.1';

let witness;
try {
  const { privateKeyPem } = loadOrCreateReferenceWitnessKey(keyFile);
  witness = await startReferenceAuthorityStateWitness({ witnessId, privateKeyPem, credential, databasePath, host, port });
} catch (error) {
  // Never the key, never the credential, never a path: a value-free line.
  console.error(`reference authority-state witness refused to start: ${error instanceof Error ? error.message.split('\n')[0] : 'startup failed'}`);
  process.exit(1);
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    witness.close().then(() => process.exit(0));
  });
}

console.log(`reference authority-state witness (NOT a ledger, NOT an HSM) listening on http://${host}:${witness.port} witnessId=${witnessId}`);
