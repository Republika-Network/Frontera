// CORE-07 — the explicit enrollment ceremony for EXISTING durable authority
// stores that the authority-state freshness witness has never seen (an upgrade
// to CORE-07, or a store created before a witness was configured).
//
// A one-shot operator action, run against the Host's own environment while the
// Host is stopped. It verifies each named store exactly as the Host would, then
// enrolls its CURRENTLY VERIFIED state at the witness as the baseline from
// which monotonic freshness begins. That is the operator's declaration, not a
// fact CORE-07 can check: a rollback that happened before this enrollment is
// not detectable. Never creates a store; never rebinds a slot the witness
// already holds. There is no HTTP route for this, and no runtime fallback.
//
// Usage (after `npm run build`):
//   node scripts/enroll-authority-state-freshness.mjs \
//     --operator <operator-id> --attest-current-state \
//     --store grants [--store obligations] [--store approvals]
import { enrollExistingAuthorityStores } from '../dist/src/enterprise/composition/composition-root.js';
import { loadEnterpriseConfiguration, validateEnterpriseEnvironment } from '../dist/src/enterprise/configuration/enterprise-configuration.js';

const KINDS = { grants: 'bounded-grant-revocation-state', obligations: 'obligation-discharge-state', approvals: 'approval-state' };

function refuse(message) {
  console.error(`authority-state enrollment refused: ${message}`);
  process.exit(1);
}

const args = process.argv.slice(2);
let operatorId;
let attested = false;
const stores = [];
for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  if (arg === '--operator') operatorId = args[++index];
  else if (arg === '--attest-current-state') attested = true;
  else if (arg === '--store') {
    const kind = KINDS[args[++index]];
    if (kind === undefined) refuse(`--store must be one of: ${Object.keys(KINDS).join(', ')}.`);
    stores.push(kind);
  } else refuse(`unknown argument '${arg}'.`);
}
if (operatorId === undefined || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(operatorId)) refuse('--operator <operator-id> is required.');
if (!attested) refuse('--attest-current-state is required: you are declaring that each store\'s currently verified state is current.');
if (stores.length === 0) refuse('name at least one --store.');

const problems = validateEnterpriseEnvironment(process.env);
if (problems.length > 0) refuse(`the environment is invalid: ${problems.join(' ')}`);

try {
  const enrolled = await enrollExistingAuthorityStores(
    loadEnterpriseConfiguration(process.env),
    { operator: true, operatorId, attestation: 'verified-local-state-is-current' },
    stores,
  );
  for (const entry of enrolled) console.log(`enrolled ${entry.stateKind} at sequence ${entry.sequence} (operator ${operatorId})`);
} catch (error) {
  // A closed code and the rule — never a credential, key, digest or path.
  refuse(error instanceof Error ? `${error.code ?? error.name}: ${error.message.split('\n')[0]}` : 'enrollment failed');
}
