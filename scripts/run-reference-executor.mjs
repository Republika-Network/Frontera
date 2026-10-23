// The REFERENCE independent executor (G-02C1A) — VERIFICATION ONLY. A separate
// process that receives HTTP/1.1 requests carrying a signed execution
// capability, rebuilds the request binding from what it received, verifies
// the capability against issuer public keys it pinned itself, and answers with
// an assessment. It never performs, claims or receipts anything. Synthetic
// CI qualification only: binds loopback, refuses any other environment.
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
