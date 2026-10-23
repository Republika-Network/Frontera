// The REFERENCE independent executor (G-02C1A/B). A separate process that
// receives HTTP/1.1 requests carrying a signed execution capability, rebuilds
// the request binding from what it received, and verifies the capability
// against issuer public keys it pinned itself. Verification-only by default: it
// answers with an assessment and performs nothing. Only with
// `mode: synthetic-execution` does it claim the capability in an existing G-02A
// ledger and then perform one local synthetic record write. It never produces
// a receipt. Synthetic CI qualification only: binds loopback, refuses any
// other environment.
// Run after `npm run build`.
//
// Its own environment (never the Host's):
//   FRONTERA_REFERENCE_EXECUTOR_CONFIG_FILE  the closed trust configuration
//                                           (frontera.reference-executor-configuration.v1)
//   <the variable the configuration names>   the gateway client credential
//
// See docs/architecture/ADR-INDEPENDENT-EXECUTOR-VERIFICATION.md.
import { referenceExecutorStartupRefusal, startReferenceExecutorProcess } from '../dist/src/enterprise/reference-executor/launcher.js';

try {
  await startReferenceExecutorProcess(process.env, (line) => process.stdout.write(`${line}\n`));
} catch (error) {
  process.stderr.write(`${referenceExecutorStartupRefusal(error)}\n`);
  process.exit(1);
}
