import { createHash } from 'node:crypto';

import { canonicalJson } from './chain.js';

/**
 * AUTH-03 — the human decision challenge and the decision evidence.
 *
 * ## The challenge
 *
 * The Host issues one challenge per intended decision. Its contract binds,
 * exactly and only:
 *
 * | Field | Meaning |
 * |---|---|
 * | `format` | `frontera.human-decision-challenge.v1` (domain and version) |
 * | `organizationId` | the Host's own organization — never a caller's |
 * | `approvalRequestId` | the CORE-05 approval request |
 * | `subjectDigest` | the exact CORE-05 subject digest the human was shown |
 * | `verdict` | `approve` or `reject` |
 * | `operatorId` | the human who may answer it |
 * | `nonce` | 256 bits from the CSPRNG |
 * | `issuedAt`, `expiresAt` | at most 120 seconds apart |
 *
 * The **WebAuthn challenge is the commitment itself**: the 32 bytes of
 * SHA-256 over `frontera:human-decision-challenge:v1\n` followed by the
 * canonical JSON of the contract. A passkey assertion signs client data that
 * contains it, so the authenticator's signature covers every bound field, and
 * the Host recomputes the commitment from its own stored contract before it
 * believes anything: a stored contract altered after issuance (another
 * organization, request, subject, verdict or human) no longer matches and is
 * refused. Approve and reject, and one request and another, are different
 * commitments.
 *
 * ## The evidence
 *
 * A verified decision yields a `HumanDecisionEvidence` record whose digest is
 * recorded twice: as a chained, signed row of the human identity store, and as
 * an `approval_proof` evidence reference inside the CORE-05 verdict row (whose
 * digest the signed approval log commits to). The record names the human, the
 * credential, the challenge commitment, a digest of the exact assertion
 * (client data, authenticator data, signature), the approval subject, the
 * verdict and the decision time. It holds no secret, no session and no raw
 * authenticator output beyond digests.
 *
 * What it proves: the holder of that registered passkey completed a
 * user-verified WebAuthn assertion over this exact decision's commitment, at
 * the relying party's pinned origin. It does not claim that biometric
 * verification itself "signs business semantics": the authenticator signs
 * WebAuthn client data, which is bound to the decision by the commitment.
 */

export const HUMAN_DECISION_CHALLENGE_FORMAT = 'frontera.human-decision-challenge.v1';
export const HUMAN_DECISION_CHALLENGE_DOMAIN = 'frontera:human-decision-challenge:v1\n';
export const HUMAN_DECISION_EVIDENCE_FORMAT = 'frontera.human-decision-evidence.v1';
/** The maximum lifetime of a decision challenge, in seconds. */
export const HUMAN_DECISION_CHALLENGE_MAX_LIFETIME_SECONDS = 120;

export type HumanDecisionVerdict = 'approve' | 'reject';

export interface HumanDecisionChallengeContract {
  readonly format: string;
  readonly organizationId: string;
  readonly approvalRequestId: string;
  readonly subjectDigest: string;
  readonly verdict: HumanDecisionVerdict;
  readonly operatorId: string;
  readonly nonce: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Canonical bytes of a contract: sorted keys, no whitespace. */
export function canonicalHumanDecisionChallenge(contract: HumanDecisionChallengeContract): string {
  return canonicalJson({
    approvalRequestId: contract.approvalRequestId,
    expiresAt: contract.expiresAt,
    format: contract.format,
    issuedAt: contract.issuedAt,
    nonce: contract.nonce,
    operatorId: contract.operatorId,
    organizationId: contract.organizationId,
    subjectDigest: contract.subjectDigest,
    verdict: contract.verdict,
  });
}

/** `sha256:<hex>` — the commitment to one decision. */
export function humanDecisionChallengeCommitment(contract: HumanDecisionChallengeContract): string {
  return `sha256:${sha256Hex(`${HUMAN_DECISION_CHALLENGE_DOMAIN}${canonicalHumanDecisionChallenge(contract)}`)}`;
}

/** The WebAuthn challenge for a commitment: its 32 digest bytes, base64url. */
export function webAuthnChallengeOf(commitment: string): string {
  return Buffer.from(commitment.slice('sha256:'.length), 'hex').toString('base64url');
}

/** `sha256:<hex>` over the exact assertion: credential id, client data, authenticator data and signature, as received. */
export function humanDecisionAssertionDigest(assertion: { readonly credentialId: string; readonly clientDataJSON: string; readonly authenticatorData: string; readonly signature: string }): string {
  return `sha256:${sha256Hex(canonicalJson({ authenticatorData: assertion.authenticatorData, clientDataJSON: assertion.clientDataJSON, credentialId: assertion.credentialId, signature: assertion.signature }))}`;
}

/** The auditable record of one authorized human decision. Digests and public facts only. */
export interface HumanDecisionEvidence {
  readonly format: string;
  readonly organizationId: string;
  readonly operatorId: string;
  readonly actorRef: string;
  readonly credentialId: string;
  readonly challengeCommitment: string;
  readonly assertionDigest: string;
  readonly approvalRequestId: string;
  readonly subjectDigest: string;
  readonly verdict: HumanDecisionVerdict;
  readonly decidedAt: string;
  readonly rpId: string;
  readonly origin: string;
  readonly userVerified: true;
  readonly backedUp: boolean;
}

export function canonicalHumanDecisionEvidence(evidence: HumanDecisionEvidence): string {
  return canonicalJson({
    actorRef: evidence.actorRef,
    approvalRequestId: evidence.approvalRequestId,
    assertionDigest: evidence.assertionDigest,
    backedUp: evidence.backedUp,
    challengeCommitment: evidence.challengeCommitment,
    credentialId: evidence.credentialId,
    decidedAt: evidence.decidedAt,
    format: evidence.format,
    operatorId: evidence.operatorId,
    organizationId: evidence.organizationId,
    origin: evidence.origin,
    rpId: evidence.rpId,
    subjectDigest: evidence.subjectDigest,
    userVerified: evidence.userVerified,
    verdict: evidence.verdict,
  });
}

/** `sha256:<hex>` — what the CORE-05 verdict row cites as its `approval_proof` evidence. */
export function humanDecisionEvidenceDigest(evidence: HumanDecisionEvidence): string {
  return `sha256:${sha256Hex(canonicalHumanDecisionEvidence(evidence))}`;
}

// ── FV-P4C-2B2B: the sovereign-status-bootstrap authority domain ───────────
//
// A second, separate decision domain, for the two human decisions that
// authorize one sovereign status history bootstrap. It is not a CORE-05
// decision and is never read as one:
//
// - **Its own format and commitment domain.** `format` is
//   `frontera.sovereign-status-bootstrap-authority.v2`, and the commitment is
//   SHA-256 over `frontera:sovereign-status-bootstrap-authority:v2\n` plus the
//   canonical contract, so no bootstrap commitment equals a CORE-05 one, even
//   for identical fields. AUTH-03's CORE-05 methods (`peekDecision`,
//   `authorizeDecision`, `decision`, `unsettledDecisions`,
//   `recordDecisionOutcome`) refuse or skip this format.
// - **A signed role, not a verdict.** In this domain `verdict` names the
//   signer's role: `attest` (the requester's signed intent to perform exactly
//   this bootstrap) or `approve` (an independent approver's authorization).
//   `reject` does not exist here, and neither role can stand for the other,
//   because the role is inside the commitment the passkey signs.
// - **The subject is the FV binding, in its history.** `approvalRequestId`
//   is `frontera.sovereign-status-bootstrap.v2:<namespace>:<bindingDigest>`
//   (the namespace percent-encoded, so it never contains `:`) and
//   `subjectDigest` is `sha256:<bindingDigest>`, where the binding digest is
//   FV-P4C-2B1's own (`bootstrapBindingDigest`). It commits to the namespace,
//   asset, issuer, manifest, status sequence and digest, terms, operation,
//   purpose, request id, requesting operator and request expiry.
// - **v2 (FV-P4C-2B2C, R5).** The signed request id names the status history
//   namespace the bootstrap targets, so whether a bootstrap committed can be
//   decided from that one history, never from an inventory's claim to be
//   complete. v1 (the pre-release FV-P4C-2B2B format, never composed by any
//   Host) named only the digest. It is retired: a store holding a v1
//   bootstrap row is refused as corrupt, never read as another domain.

export const BOOTSTRAP_AUTHORITY_CHALLENGE_FORMAT = 'frontera.sovereign-status-bootstrap-authority.v2';
export const BOOTSTRAP_AUTHORITY_CHALLENGE_DOMAIN = 'frontera:sovereign-status-bootstrap-authority:v2\n';
export const BOOTSTRAP_AUTHORITY_EVIDENCE_FORMAT = 'frontera.sovereign-status-bootstrap-authority-evidence.v2';
export const BOOTSTRAP_AUTHORITY_EVIDENCE_DOMAIN = 'frontera:sovereign-status-bootstrap-authority-evidence:v2\n';
/** The `approvalRequestId` namespace of the bootstrap domain; never a CORE-05 request id. */
export const BOOTSTRAP_AUTHORITY_REQUEST_PREFIX = 'frontera.sovereign-status-bootstrap.v2:';
/** FV-P4C-2B2C: the retired v1 challenge and evidence formats. Never issued, never read: a row in either is corrupt. */
export const RETIRED_BOOTSTRAP_AUTHORITY_FORMATS: readonly string[] = Object.freeze(['frontera.sovereign-status-bootstrap-authority.v1', 'frontera.sovereign-status-bootstrap-authority-evidence.v1']);
/** The longest status history namespace a bootstrap decision may name (FV's own bound). */
export const BOOTSTRAP_AUTHORITY_MAX_NAMESPACE_LENGTH = 256;

/** A status history namespace as FV defines one: non-empty, untrimmed-free, no control characters, bounded. */
function isBootstrapNamespace(value: unknown): value is string {
  return typeof value === 'string' && value !== '' && value.trim() === value && value.length <= BOOTSTRAP_AUTHORITY_MAX_NAMESPACE_LENGTH && !/[\u0000-\u001f]/.test(value);
}

/** `frontera.sovereign-status-bootstrap.v2:<encodeURIComponent(namespace)>:<bindingDigest>`. Throws on a malformed namespace or digest. */
export function bootstrapAuthorityRequestId(namespace: string, bindingDigest: string): string {
  if (!isBootstrapNamespace(namespace)) throw new TypeError('A bootstrap decision names one status history namespace.');
  if (typeof bindingDigest !== 'string' || !/^[0-9a-f]{64}$/.test(bindingDigest)) throw new TypeError('A bootstrap binding digest is lowercase hex SHA-256.');
  return `${BOOTSTRAP_AUTHORITY_REQUEST_PREFIX}${encodeURIComponent(namespace)}:${bindingDigest}`;
}

/** The namespace and binding digest of a v2 bootstrap request id, only in its one canonical spelling; `undefined` for anything else. */
export function parseBootstrapAuthorityRequestId(value: unknown): { readonly namespace: string; readonly bindingDigest: string } | undefined {
  if (typeof value !== 'string' || !value.startsWith(BOOTSTRAP_AUTHORITY_REQUEST_PREFIX)) return undefined;
  const match = /^([^:]+):([0-9a-f]{64})$/.exec(value.slice(BOOTSTRAP_AUTHORITY_REQUEST_PREFIX.length));
  if (match === null) return undefined;
  let namespace: string;
  try {
    namespace = decodeURIComponent(match[1]!);
  } catch {
    return undefined;
  }
  // One spelling per namespace: an alternative encoding of the same namespace is refused, not normalized.
  if (!isBootstrapNamespace(namespace) || encodeURIComponent(namespace) !== match[1]) return undefined;
  return { namespace, bindingDigest: match[2]! };
}

/** The signed role of a bootstrap-authority decision. Closed. */
export type BootstrapAuthorityRole = 'attest' | 'approve';
export const BOOTSTRAP_AUTHORITY_ROLES: readonly BootstrapAuthorityRole[] = Object.freeze(['attest', 'approve']);

export interface BootstrapAuthorityChallengeContract {
  readonly format: typeof BOOTSTRAP_AUTHORITY_CHALLENGE_FORMAT;
  readonly organizationId: string;
  readonly approvalRequestId: string;
  readonly subjectDigest: string;
  readonly verdict: BootstrapAuthorityRole;
  readonly operatorId: string;
  readonly nonce: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
}

export function isBootstrapAuthorityContract(contract: { readonly format: string }): contract is BootstrapAuthorityChallengeContract {
  return contract.format === BOOTSTRAP_AUTHORITY_CHALLENGE_FORMAT;
}

/** `sha256:<hex>` — the commitment to one bootstrap-authority decision, under its own domain. */
export function bootstrapAuthorityChallengeCommitment(contract: BootstrapAuthorityChallengeContract): string {
  const canonical = canonicalJson({
    approvalRequestId: contract.approvalRequestId,
    expiresAt: contract.expiresAt,
    format: contract.format,
    issuedAt: contract.issuedAt,
    nonce: contract.nonce,
    operatorId: contract.operatorId,
    organizationId: contract.organizationId,
    subjectDigest: contract.subjectDigest,
    verdict: contract.verdict,
  });
  return `sha256:${sha256Hex(`${BOOTSTRAP_AUTHORITY_CHALLENGE_DOMAIN}${canonical}`)}`;
}

/**
 * The commitment of any stored decision contract, by its format: the CORE-05
 * domain for `frontera.human-decision-challenge.v1`, the bootstrap domain for
 * its own format, and `undefined` for anything else (never believed).
 */
export function decisionContractCommitment(contract: HumanDecisionChallengeContract | BootstrapAuthorityChallengeContract): string | undefined {
  if (contract.format === HUMAN_DECISION_CHALLENGE_FORMAT) return humanDecisionChallengeCommitment(contract as HumanDecisionChallengeContract);
  if (contract.format === BOOTSTRAP_AUTHORITY_CHALLENGE_FORMAT) return bootstrapAuthorityChallengeCommitment(contract as BootstrapAuthorityChallengeContract);
  return undefined;
}

/** The auditable record of one authorized bootstrap-authority decision. Same public facts as a CORE-05 decision; the verdict is the signed role. */
export interface BootstrapAuthorityDecisionEvidence extends Omit<HumanDecisionEvidence, 'verdict'> {
  readonly verdict: BootstrapAuthorityRole;
}

/** `sha256:<hex>` over the evidence, under the bootstrap evidence domain. */
export function bootstrapAuthorityEvidenceDigest(evidence: BootstrapAuthorityDecisionEvidence): string {
  return `sha256:${sha256Hex(`${BOOTSTRAP_AUTHORITY_EVIDENCE_DOMAIN}${canonicalHumanDecisionEvidence(evidence as unknown as HumanDecisionEvidence)}`)}`;
}

/** A challenge digest as the chained rows name it — never the challenge string itself. */
export function challengeDigestOf(challenge: string): string {
  return `sha256:${sha256Hex(`frontera:human-identity-challenge:v1\n${challenge}`)}`;
}
