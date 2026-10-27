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

/** A challenge digest as the chained rows name it — never the challenge string itself. */
export function challengeDigestOf(challenge: string): string {
  return `sha256:${sha256Hex(`frontera:human-identity-challenge:v1\n${challenge}`)}`;
}
