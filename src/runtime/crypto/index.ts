export type {
  CapabilityVerificationContext,
  VerificationResult,
} from './verification/capability-verifier.js';
export type { DelegationVerificationContext } from './verification/delegation-verifier.js';

/**
 * Both exports below validate token **structure, expiry and revocation-list
 * membership**. Neither verifies a cryptographic signature, and
 * `verifyDelegatedCapability` performs no delegation-specific check at all — it
 * is an alias. See the header of `verification/capability-verifier.js` and
 * TB-003/TB-006 in `docs/security/TRUST_BOUNDARIES_AND_PRIVILEGED_ASSETS.md`.
 */
export { verifyCapabilityToken } from './verification/capability-verifier.js';
export { verifyDelegatedCapability } from './verification/delegation-verifier.js';
