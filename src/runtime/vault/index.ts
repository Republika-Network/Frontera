/**
 * # This is not a cryptographic vault.
 *
 * It stores no key, encrypts nothing, calls no KMS or HSM, and signs nothing.
 * "Vault" here names a *logical* boundary over a `RuntimePersistenceEnvelope`,
 * and what the module actually provides is:
 *
 *   - **drift detection across tenant, workspace and runtime identity** —
 *     `validateRuntimeVaultIsolation`
 *     compares `tenantId`, `workspaceId`, `runtimeId`, `trustDomain` and
 *     `vaultOwnerId` against an expected context;
 *   - **continuity consistency** — epoch, version and sequence agreement between
 *     the boundary and its envelope.
 *
 * `createRuntimeVaultAttestation` is likewise not an attestation in the security
 * sense: it is `parts.join(':')` over identifiers — not a hash, not a digest,
 * not a signature.
 *
 * Recorded as TB-004 in `docs/security/TRUST_BOUNDARIES_AND_PRIVILEGED_ASSETS.md`,
 * with the "no cryptographic primitive" property pinned by
 * `src/runtime/__tests__/naming-boundaries.test.ts`. Secret custody and real
 * attestation are owned by later prompts; nothing here should be cited as
 * providing either.
 */

export type * from './runtime-vault-types.js';
export { createRuntimeVaultManager } from './runtime-vault-manager.js';
export { validateRuntimeVaultBoundary } from './runtime-vault-validation.js';
export { validateRuntimeVaultIsolation } from './runtime-vault-isolation.js';
export { createRuntimeVaultAttestation } from './runtime-vault-attestation.js';
