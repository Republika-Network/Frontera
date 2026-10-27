/**
 * AUTH-02 — individual human identity and passkey credentials.
 *
 * This module answers exactly two questions:
 *
 * 1. **Who is this human?** A `HumanPrincipal`: one CTRL-02 operator identity
 *    (`operator:<operatorId>`, the CTRL-04 identity bridge), in the one
 *    organization this Host serves, with a lifecycle.
 * 2. **Which credentials belong to that human?** WebAuthn passkeys registered
 *    under an administrator-authorized, single-use enrolment, verified by an
 *    established WebAuthn implementation, durable, revocable.
 *
 * It deliberately answers nothing else:
 *
 * - **Not authorization.** Holding a passkey grants nothing. Whether a human
 *   may approve is still CORE-05's question, answered from Kernel-Authority
 *   standing at every read. A `RecognizedHuman` is evidence of *who*, never of
 *   *may*.
 * - **Not a session.** Recognizing a human returns a value; it issues no
 *   cookie, token or bearer, and nothing here is reachable over HTTP.
 * - **Decision authorization (AUTH-03)** binds a passkey assertion to one exact
 *   approve or reject of one exact CORE-05 subject (`decision-challenge.ts`),
 *   and yields decision evidence. Whether that verdict counts is still
 *   CORE-05's: the command is given to CORE-05, which re-checks standing.
 *
 * Private key material never exists here: a passkey's private key stays in
 * the user's authenticator. Only public keys, identifiers, counters and
 * verifiers of random secrets are stored.
 */

/** v2 (AUTH-03): the signed head. v1 stores (AUTH-02, never composed by any Host) are refused, never migrated. */
export const HUMAN_IDENTITY_STORE_SCHEMA_VERSION = 2;

export type HumanPrincipalState = 'active' | 'revoked';

/** One individual human approver. Its `operatorId` is the CTRL-02 operator identity; its organization is the Host's, never a request's. */
export interface HumanPrincipal {
  readonly operatorId: string;
  /** `operator:<operatorId>` — the Kernel-Authority actor CORE-05 resolves approver standing for. */
  readonly actorRef: string;
  readonly organizationId: string;
  readonly displayName: string;
  readonly state: HumanPrincipalState;
  readonly createdAt: string;
  readonly createdBy: string;
  readonly revokedAt: string | null;
  readonly revokedBy: string | null;
  readonly revocationReason: string | null;
}

export type EnrolmentState = 'open' | 'consumed' | 'revoked' | 'expired';

/** An administrator's single-use authorization for one named human to register one passkey. The token itself is never stored or shown again. */
export interface EnrolmentAuthorizationView {
  readonly enrolmentId: string;
  readonly operatorId: string;
  readonly state: EnrolmentState;
  readonly authorizedAt: string;
  readonly authorizedBy: string;
  readonly expiresAt: string;
}

/** Returned once, when an enrolment is authorized: the only time the token exists outside the human's hands. */
export interface IssuedEnrolment extends EnrolmentAuthorizationView {
  /** `fre1.<enrolmentId>.<secret>`. Deliver out of band to the named human. Never logged, never stored (only its SHA-256 verifier is). */
  readonly enrolmentToken: string;
}

export type PasskeyCredentialState = 'active' | 'revoked';
export type CredentialDeviceType = 'singleDevice' | 'multiDevice';

/** A registered passkey, as public facts only. */
export interface PasskeyCredentialView {
  /** The WebAuthn credential id, base64url. Unique across the store forever: a revoked id is never registered again. */
  readonly credentialId: string;
  readonly operatorId: string;
  readonly organizationId: string;
  readonly enrolmentId: string;
  readonly state: PasskeyCredentialState;
  /** The latest signature counter accepted. `0` throughout for authenticators (typically synced passkeys) that do not count. */
  readonly counter: number;
  /** `multiDevice`: a synced passkey. Never treated as device-bound. */
  readonly deviceType: CredentialDeviceType;
  readonly backedUp: boolean;
  readonly transports: readonly string[];
  /** The attestation format received. Recorded, never trusted: no attestation is verified against a vendor root, so nothing is claimed about the authenticator model. */
  readonly attestationFormat: string;
  readonly aaguid: string;
  readonly rpId: string;
  readonly registeredAt: string;
  readonly lastUsedAt: string | null;
  readonly revokedAt: string | null;
  readonly revokedBy: string | null;
  readonly revocationReason: string | null;
}

/**
 * The result of verifying a passkey assertion: who the human is, by which
 * credential. Not a session, not an authorization, not a decision.
 */
export interface RecognizedHuman {
  readonly operatorId: string;
  readonly actorRef: string;
  readonly organizationId: string;
  readonly credentialId: string;
  readonly userVerified: true;
  readonly deviceType: CredentialDeviceType;
  readonly backedUp: boolean;
  readonly counter: number;
  readonly recognizedAt: string;
}

/** Public options for the browser's `navigator.credentials.create()`, as JSON. Contains no secret. */
export interface RegistrationOptionsJSON {
  readonly rp: { readonly id: string; readonly name: string };
  readonly user: { readonly id: string; readonly name: string; readonly displayName: string };
  readonly challenge: string;
  readonly pubKeyCredParams: readonly { readonly type: 'public-key'; readonly alg: number }[];
  readonly timeout: number;
  readonly attestation: 'none';
  readonly excludeCredentials: readonly { readonly type: 'public-key'; readonly id: string }[];
  readonly authenticatorSelection: { readonly residentKey: 'required'; readonly requireResidentKey: true; readonly userVerification: 'required' };
}

/** Public options for the browser's `navigator.credentials.get()`, as JSON. Contains no secret. */
export interface AuthenticationOptionsJSON {
  readonly rpId: string;
  readonly challenge: string;
  readonly timeout: number;
  readonly userVerification: 'required';
  readonly allowCredentials: readonly { readonly type: 'public-key'; readonly id: string }[];
}

export type HumanIdentityErrorCode =
  /** The relying-party configuration is malformed or unsafe (fails at construction). */
  | 'HUMAN_IDENTITY_CONFIGURATION_INVALID'
  /** The caller is not an organization administrator of this Host's organization. */
  | 'HUMAN_IDENTITY_ADMINISTRATOR_REQUIRED'
  /** The operator id is not one of this Host's configured operators. */
  | 'HUMAN_IDENTITY_UNKNOWN_OPERATOR'
  /** No human principal exists for the operator. */
  | 'HUMAN_IDENTITY_UNKNOWN_PRINCIPAL'
  | 'HUMAN_IDENTITY_PRINCIPAL_EXISTS'
  | 'HUMAN_IDENTITY_PRINCIPAL_REVOKED'
  /** The enrolment token is malformed, unknown, wrong, expired, consumed or revoked — deliberately one code. */
  | 'HUMAN_IDENTITY_ENROLMENT_INVALID'
  /** The ceremony challenge is unknown, of another ceremony, bound elsewhere, expired or already used — deliberately one code. */
  | 'HUMAN_IDENTITY_CHALLENGE_INVALID'
  /** The WebAuthn registration response did not verify (origin, RP ID, flags, attestation, key, shape…). */
  | 'HUMAN_IDENTITY_REGISTRATION_INVALID'
  /** The WebAuthn assertion did not verify (origin, RP ID, flags, signature, shape…). */
  | 'HUMAN_IDENTITY_AUTHENTICATION_INVALID'
  /** The credential id is already registered (active or revoked). */
  | 'HUMAN_IDENTITY_CREDENTIAL_DUPLICATE'
  /** The credential is unknown or revoked, or its human is revoked. */
  | 'HUMAN_IDENTITY_CREDENTIAL_UNUSABLE'
  /** The assertion names another human than the credential's owner, or the credential is not the expected human's. */
  | 'HUMAN_IDENTITY_CREDENTIAL_OWNERSHIP_MISMATCH'
  /** A verified assertion carried a signature counter that did not advance. Recorded; the credential is not trusted for this attempt. */
  | 'HUMAN_IDENTITY_COUNTER_REGRESSION'
  | 'HUMAN_IDENTITY_ALREADY_REVOKED'
  /** The store's history does not verify, or the file belongs to another organization or schema. Nothing is believed. */
  | 'HUMAN_IDENTITY_STORE_CORRUPT'
  /** The store could not commit (for example, another writer holds the lock). Nothing was recorded. */
  | 'HUMAN_IDENTITY_STORE_UNAVAILABLE'
  /** The store needs an authority signer that signs human identity state, and its verifier; or the file is of another schema. */
  | 'HUMAN_IDENTITY_STORE_UNSUPPORTED'
  /** The decision challenge was already consumed by an authorized decision. Its outcome can be read; it never authorizes again. */
  | 'HUMAN_IDENTITY_DECISION_CHALLENGE_CONSUMED';

export class HumanIdentityError extends Error {
  constructor(
    readonly code: HumanIdentityErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'HumanIdentityError';
  }
}
