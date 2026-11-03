# Integration Contracts (PROPOSED)

None of these schemas, identifiers or endpoints exist. Names are provisional and must not be treated as a
public API. All schema ids use a `rn.conformance.*` prefix reserved here for discussion only.

## 0. Shared conventions

| Concern | Proposal | Grounding |
|---|---|---|
| Canonicalization | One profile for every signed conformance artifact. Recommended: Protocol `aoc-canonical-json/1` (`@aoc/protocol/canonical` `canonicalizeJSON`) with inputs restricted to plain JSON (no `undefined`, `Date`, `-0`) so Frontera `canonicalSerialize` produces identical bytes. | Two non-identical profiles exist → [CC-D-01](DECISION_REGISTER.md#cc-d-01) |
| Digest | `sha256:<hex>` over canonical bytes | F: `governance-store/digest.ts` `computeDigest` |
| Signature | Ed25519, detached, **domain-separated**: signing bytes = `domain ‖ canonical(payload)`; envelope `{algorithm:'ed25519-v1', keyId, signature(base64url), artifactVersion}`; key resolved from a pinned registry, never from the envelope | F: `authority-authenticity/authority-signature.ts` `AUTHORITY_SIGNING_DOMAINS`, `signature-verification.ts` `createAuthoritySignatureRegistry` |
| Proposed new domains | `frontera:conformance-challenge:v1\n`, `frontera:conformance-observation:v1\n`, `frontera:conformance-transition:v1\n`, `frontera:conformance-status:v1\n`, `frontera:conformance-anchor:v1\n` | Adding a kind requires extending `AUTHORITY_SIGNING_DOMAINS` (or a parallel registry — decide in RN-CONFORM-02) |
| Key ids | Derived from the public key (no free-form ids) | P: SOBE-SEC-01 binding rule; F: FV verifier refuses JWK descriptors |
| Time | RFC 3339 UTC, millisecond precision; trusted clock injected | Assurance and FV inject clocks |
| Identifiers | `<kind>_<ULID>`; never reused | — |

## 1. Identities

```ts
// D1 — PROPOSED
interface PlatformRecord {
  platformId: string;           // plt_…
  organizationId: string;       // tenant boundary; matches Assurance organizationId semantics
  displayName: string;
}

interface IntegrationVersion {   // append-only; a new version = new record
  integrationId: string;        // int_… (stable across versions)
  integrationVersion: number;   // 1, 2, …
  platformId: string;
  organizationId: string;
  sdk: { package: string; version: string; lockDigest: string };     // CC-D-10, CC-D-11
  adapter: { name: string; version: string; digest: string };
  deploymentDigest: string;     // sha256 of the deployed release manifest (platform-declared, validator-observed)
  profile: { id: 'rn.conformance.integration'; version: '0.1.0' };
  coveredOperations: string[];  // e.g. ['document.open','document.export']
  testEndpoints: AuthorizedEndpoint[];   // explicit allowlist; synthetic until authorized
  declaredExclusions: { operation: string; reason: string }[];
  registeredAt: string;
  integrationDigest: string;    // digest of this record minus integrationDigest
}

interface AuthorizedEndpoint {
  endpointId: string; url: string; environment: 'synthetic' | 'staging' | 'production';
  authorizationRef: string;     // signed testing authorization from the platform (CC-D-12)
  validFrom: string; validUntil: string;
}

interface ValidatorRecord {      // D2
  validatorId: string;          // val_…
  operatorId: string;           // legal/administrative operator; independence is per operator
  keys: { keyId: string; publicKey: string; validFrom: string; validUntil?: string; revokedAt?: string }[];
  status: 'enrolled' | 'active' | 'quarantined' | 'revoked';
  enrolledBy: HumanDecisionRef; // two AUTH-03 decisions
}
```

## 2. Challenge (D2 → validator)

```ts
interface ConformanceChallengeV1 {
  schema: 'rn.conformance.challenge/1';
  challengeId: string;
  nonce: string;                // ≥ 32 random bytes, base64url (witness-client pattern)
  integrationId: string; integrationVersion: number; integrationDigest: string;
  profileId: string; profileVersion: string;
  controlId: string;            // e.g. 'CR-02'
  challengeType: string;        // e.g. 'G02.post-revocation-access'
  endpointId: string;
  fixtureRef: string;           // synthetic fixture id/digest
  issuedAt: string; notBefore: string; deadline: string;
  assignedValidatorIds: string[];
  coordinatorSignature: Signature;   // domain frontera:conformance-challenge:v1
}
```

## 3. Observation envelope (validator → D3)

Field list follows mission §8, with additions marked ➕.

```ts
interface ConformanceObservationV1 {
  schema: 'rn.conformance.observation/1';      // ➕
  eventId: string;                              // unique per observation
  challengeId: string;
  challengeNonce: string;                       // ➕ echo — binds to exactly one challenge
  validatorId: string;
  validatorKeyId: string;
  platformId: string;
  integrationId: string;
  integrationVersion: number;                   // ➕
  integrationDigest: string;                    // as challenged
  observedDeploymentDigest: string | null;      // ➕ what the validator actually saw (G08)
  profileId: string;
  profileVersion: string;
  controlId: string;
  operation: string;
  expectedOutcome: 'denied' | 'allowed' | 'fail_closed' | 'revoked_within_interval';
  observedOutcome: 'denied' | 'allowed' | 'error' | 'timeout' | 'unreachable';
  outcomeClass: 'conformant' | 'violation' | 'inconclusive';   // ➕ validator's classification; engine recomputes
  evidenceDigest: string;                       // digest of the redacted evidence package (kept off-chain)
  observedAt: string;
  submittedAt: string;
  validatorSignature: Signature;                // domain frontera:conformance-observation:v1, over all fields above
}
```

The engine **recomputes** `outcomeClass` from `expectedOutcome`/`observedOutcome` and ignores a
mismatching claim (records it as a validator defect). Validators never submit a "conformance decision".
This mirrors X `EvidenceSubmission` having no `conclusion` field.

## 4. Transition record (D5, append-only, hash-chained)

```ts
interface CredentialTransitionV1 {
  schema: 'rn.conformance.transition/1';
  transitionId: string;
  credentialId: string;
  stateVersion: number;                // +1 per transition
  previousTransitionDigest: string | null;
  from: CredentialState | null; to: CredentialState;
  reasonCode: string;                  // see CREDENTIAL_LIFECYCLE.md
  ruleId: string;                      // profile rule that fired
  profileVersion: string;
  evaluationId: string;
  evidenceIds: string[];               // accepted observation eventIds
  humanDecisions: HumanDecisionRef[];  // empty for automatic transitions
  effectiveAt: string;
  transitionDigest: string;
  registrySignature: Signature;        // domain frontera:conformance-transition:v1
}
```

## 5. Status assertion (D6 → verifiers)

See [STATUS_VERIFICATION.md](STATUS_VERIFICATION.md) for verification rules.

```ts
interface ConformanceStatusAssertionV1 {
  schema: 'rn.conformance.status/1';
  purpose: 'rn.conformance.status.assertion';   // domain separator inside payload too (FV pattern)
  issuer: string;                     // Republika status issuer id
  credentialId: string;
  subject: { platformId: string; organizationId: string; integrationId: string;
             integrationVersion: number; integrationDigest: string };
  scope: { coveredOperations: string[]; declaredExclusions: string[] };
  profile: { id: string; version: string };
  sdk: { version: string }; adapter: { version: string };
  state: 'CANDIDATE' | 'ACTIVE' | 'SUSPENDED' | 'REVOKED' | 'EXPIRED';
  stateVersion: number;
  reasonCode: string | null;
  effectiveAt: string;
  lastSuccessfulVerificationAt: string | null;
  evidenceFreshness: { oldestRequiredEvidenceAt: string | null; freshUntil: string | null };
  credentialValidUntil: string;
  historyRef: { latestTransitionDigest: string; transitionsUrlPath: string };
  anchors: { network: string; txHash: string; confirmation: 'validated' | 'pending' }[];
  sequence: number;                   // monotonic per credential (≥ stateVersion)
  previousAssertionDigest: string | null;
  requestNonce: string | null;        // echoed in online mode
  issuedAt: string;
  validUntil: string;                 // ≤ issuedAt + 15 min (proposed SLO)
  signature: Signature;               // domain frontera:conformance-status:v1
}
```

## 6. Read-only API shape (not to be built in this mission)

| Method | Path | Returns |
|---|---|---|
| `POST` | `/conformance/v1/status` body `{credentialId, nonce, expect:{platformId, integrationId, integrationDigest, profileId, profileVersion}}` | `ConformanceStatusAssertionV1` (online, nonce-bound) |
| `GET` | `/conformance/v1/credentials/{credentialId}/status` | Latest stapled assertion (cacheable until `validUntil`, `Cache-Control: max-age ≤ remaining validity`) |
| `GET` | `/conformance/v1/credentials/{credentialId}/transitions?after={stateVersion}` | Signed transition records (public fields only) |
| `GET` | `/conformance/v1/keys` | Status issuer public keys with validity windows (also pinned out of band) |

Mismatched `expect` fields return a signed `SUBJECT_MISMATCH` / `PROFILE_MISMATCH` assertion rather than
the credential state, to prevent substitution.

## 7. Human decision reference

```ts
interface HumanDecisionRef {
  format: 'frontera.conformance-authority.v1';   // modelled on frontera.sovereign-status-bootstrap-authority.v2
  role: 'attest' | 'approve';
  decisionId: string;
  bindingDigest: string;     // digest of the exact transition/enrollment being authorized
}
```
Two decisions from two different humans are required (requester ≠ approver), as in
`createHumanDecisionBootstrapAuthorizer`.
