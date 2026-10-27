import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import type { EnterpriseOperatorPrincipal } from '../operator-control/operator-authenticator.js';
import { canonicalJson, type HumanIdentityJson, type StoredHumanIdentityRow } from './chain.js';
import {
  HumanIdentityError,
  type AuthenticationOptionsJSON,
  type CredentialDeviceType,
  type EnrolmentAuthorizationView,
  type HumanPrincipal,
  type IssuedEnrolment,
  type PasskeyCredentialView,
  type RecognizedHuman,
  type RegistrationOptionsJSON,
} from './contracts.js';
import {
  HUMAN_DECISION_CHALLENGE_FORMAT,
  HUMAN_DECISION_CHALLENGE_MAX_LIFETIME_SECONDS,
  HUMAN_DECISION_EVIDENCE_FORMAT,
  challengeDigestOf,
  humanDecisionAssertionDigest,
  humanDecisionChallengeCommitment,
  humanDecisionEvidenceDigest,
  webAuthnChallengeOf,
  type HumanDecisionChallengeContract,
  type HumanDecisionEvidence,
  type HumanDecisionVerdict,
} from './decision-challenge.js';
import type { RelyingPartyConfiguration } from './relying-party.js';
import type { CeremonyChallenge, CeremonyKind, HumanIdentityStore, StoredDecisionChallenge } from './sqlite-human-identity-store.js';
import { SUPPORTED_COSE_ALGORITHMS, clientDataOf, parseAuthenticationResponse, parseRegistrationResponse, signatureCounterOf, verifyAssertion, verifyRegistration, type AuthenticationResponse } from './webauthn.js';

/**
 * AUTH-02 — the human identity service; AUTH-03 — decision authorization.
 *
 * **Administration.** Every administrative act requires an
 * `IdentityAdministrator`, which only `identityAdministratorFor()` can make,
 * from an `EnterpriseOperatorPrincipal` that the existing operator
 * authenticator produced: a CTRL-02 operator credential (never a legacy
 * administrator), role `organization-administrator`, of this store's
 * organization. The value is branded through a module-private set, so no
 * structurally similar object is accepted.
 *
 * **Enrolment, recognition, revocation** are AUTH-02's, unchanged in meaning.
 * Every write is now signed (the store's head) and every consumed challenge —
 * registration, authentication, owner revocation, decision — is recorded by
 * digest in a chained row and refused if it appears in the verified history
 * again. Restoring an older file to reuse one is a rollback the CORE-07
 * witness refuses.
 *
 * **Decision authorization (AUTH-03).** `beginDecision` issues a challenge
 * bound to one approve or reject of one CORE-05 subject by one human
 * (`decision-challenge.ts`). `authorizeDecision` verifies the assertion —
 * credential owned by that human, human and credential active, pinned RP ID
 * and origin, user verification, the signed challenge equal to the recomputed
 * commitment, unexpired and unconsumed — then consumes the challenge and
 * records the decision evidence in one signed append. It does **not** record a
 * CORE-05 verdict and does not decide whether the human may approve: the
 * CORE-05 passkey channel (`approval-authority/human-decision.ts`) does that,
 * after this consumption, so one challenge yields at most one verdict.
 *
 * Revoking a passkey does **not** revoke anything it was used for: issued
 * grants, capabilities or recorded verdicts keep their own lifecycles.
 *
 * Nothing here is reachable over HTTP.
 */

const ENROLMENT_ID = /^enr-[0-9a-f]{32}$/;
const ENROLMENT_TOKEN = /^fre1\.(enr-[0-9a-f]{32})\.([A-Za-z0-9_-]{43})$/;
const OPERATOR_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const CEREMONY_RECORDER = 'webauthn-ceremony';
const MAX_TEXT = 256;

export const ENROLMENT_TTL_DEFAULT_SECONDS = 900;
export const ENROLMENT_TTL_MAX_SECONDS = 3_600;
export const CHALLENGE_TTL_DEFAULT_SECONDS = 300;
export const CHALLENGE_TTL_MAX_SECONDS = 600;

/** An organization administrator, as established by the operator plane. Only `identityAdministratorFor` makes one. */
export interface IdentityAdministrator {
  readonly operatorId: string;
  readonly organizationId: string;
  readonly actorRef: string;
}

const ADMINISTRATORS = new WeakSet<IdentityAdministrator>();

export function identityAdministratorFor(principal: EnterpriseOperatorPrincipal): IdentityAdministrator {
  if (principal.plane !== 'operator' || principal.credentialClass !== 'operator' || principal.role !== 'organization-administrator') {
    throw new HumanIdentityError('HUMAN_IDENTITY_ADMINISTRATOR_REQUIRED', 'Only a CTRL-02 organization administrator may administer human identities.');
  }
  const administrator: IdentityAdministrator = Object.freeze({ operatorId: principal.operatorId, organizationId: principal.organizationId, actorRef: principal.actorRef });
  ADMINISTRATORS.add(administrator);
  return administrator;
}

/** A decision challenge as issued: the contract, its commitment, and the WebAuthn options that sign over it. */
export interface IssuedHumanDecisionChallenge {
  readonly contract: HumanDecisionChallengeContract;
  readonly commitment: string;
  readonly options: AuthenticationOptionsJSON;
}

/** A verified, consumed human decision: what the CORE-05 passkey channel needs, and the evidence it cites. */
export interface AuthorizedHumanDecision {
  readonly contract: HumanDecisionChallengeContract;
  readonly commitment: string;
  readonly evidence: HumanDecisionEvidence;
  readonly evidenceDigest: string;
}

export type HumanDecisionOutcome = { readonly outcome: 'recorded'; readonly verdictRowDigest: string } | { readonly outcome: 'refused'; readonly code: string };

/** What the identity store knows about one decision commitment. */
export interface HumanDecisionRecord {
  readonly contract: HumanDecisionChallengeContract;
  readonly commitment: string;
  /** `issued` until consumed or expired. `consumed`: an authorized decision exists. */
  readonly state: 'issued' | 'consumed' | 'expired';
  readonly evidence?: HumanDecisionEvidence;
  readonly evidenceDigest?: string;
  readonly outcome?: HumanDecisionOutcome;
}

export interface HumanIdentityServiceOptions {
  readonly store: HumanIdentityStore;
  readonly relyingParty: RelyingPartyConfiguration;
  /** This Host's configured CTRL-02 operator ids. A human principal is only ever one of them. */
  readonly operatorIds: readonly string[];
  readonly now?: () => Date;
  readonly enrolmentTtlSeconds?: number;
  readonly challengeTtlSeconds?: number;
  /** AUTH-03: the decision challenge lifetime, 1–120 seconds. Default 120. */
  readonly decisionChallengeTtlSeconds?: number;
}

export interface HumanIdentityService {
  readonly organizationId: string;
  createPrincipal(administrator: IdentityAdministrator, input: { readonly operatorId: string; readonly displayName: string }): Promise<HumanPrincipal>;
  revokePrincipal(administrator: IdentityAdministrator, operatorId: string, reason: string): Promise<HumanPrincipal>;
  authorizeEnrolment(administrator: IdentityAdministrator, operatorId: string): Promise<IssuedEnrolment>;
  revokeEnrolment(administrator: IdentityAdministrator, enrolmentId: string, reason: string): Promise<EnrolmentAuthorizationView>;
  beginRegistration(enrolmentToken: string): RegistrationOptionsJSON;
  finishRegistration(enrolmentToken: string, response: unknown): Promise<PasskeyCredentialView>;
  beginAuthentication(): AuthenticationOptionsJSON;
  finishAuthentication(response: unknown): Promise<RecognizedHuman>;
  revokeCredential(administrator: IdentityAdministrator, credentialId: string, reason: string): Promise<PasskeyCredentialView>;
  beginOwnerRevocation(credentialId: string): AuthenticationOptionsJSON;
  finishOwnerRevocation(credentialId: string, response: unknown, reason: string): Promise<PasskeyCredentialView>;
  /** AUTH-03: issues a challenge bound to one decision. Never reached by a request naming an organization. */
  beginDecision(input: { readonly operatorId: string; readonly approvalRequestId: string; readonly subjectDigest: string; readonly verdict: HumanDecisionVerdict }): IssuedHumanDecisionChallenge;
  /** AUTH-03: the stored contract an assertion answers, after recomputing its commitment. Verifies nothing about the assertion. */
  peekDecision(response: unknown): { readonly contract: HumanDecisionChallengeContract; readonly commitment: string };
  /** AUTH-03: verifies the assertion against its decision challenge, consumes the challenge and records the decision evidence. */
  authorizeDecision(response: unknown): Promise<AuthorizedHumanDecision>;
  /** AUTH-03: records what CORE-05 did with an authorized decision. At most once per decision. */
  recordDecisionOutcome(commitment: string, outcome: HumanDecisionOutcome): Promise<void>;
  decision(commitment: string): HumanDecisionRecord | undefined;
  principal(operatorId: string): HumanPrincipal | undefined;
  credentialsOf(operatorId: string): readonly PasskeyCredentialView[];
  enrolment(enrolmentId: string): EnrolmentAuthorizationView | undefined;
}

// ── State, derived only from the verified history ──────────────────────────

interface PrincipalState {
  principal: HumanPrincipal;
  readonly userHandle: string;
}

interface EnrolmentRecord {
  readonly enrolmentId: string;
  readonly operatorId: string;
  readonly tokenVerifier: string;
  readonly authorizedAt: string;
  readonly authorizedBy: string;
  readonly expiresAt: string;
  consumed: boolean;
  revoked: boolean;
}

interface CredentialRecord {
  view: PasskeyCredentialView;
  readonly publicKey: string;
}

interface DecisionState {
  readonly evidence: HumanDecisionEvidence;
  readonly evidenceDigest: string;
  outcome?: HumanDecisionOutcome;
}

interface IdentityState {
  readonly principals: Map<string, PrincipalState>;
  readonly enrolments: Map<string, EnrolmentRecord>;
  readonly credentials: Map<string, CredentialRecord>;
  /** Digests of every challenge any chained row consumed. */
  readonly usedChallenges: Set<string>;
  readonly decisions: Map<string, DecisionState>;
}

function payloadOf(row: StoredHumanIdentityRow): Readonly<Record<string, unknown>> {
  const parsed = JSON.parse(row.payload) as unknown;
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new HumanIdentityError('HUMAN_IDENTITY_STORE_CORRUPT', 'A human identity payload is not an object.');
  return parsed as Readonly<Record<string, unknown>>;
}

const text = (payload: Readonly<Record<string, unknown>>, key: string): string => {
  const value = payload[key];
  if (typeof value !== 'string') throw new HumanIdentityError('HUMAN_IDENTITY_STORE_CORRUPT', `A human identity payload lacks '${key}'.`);
  return value;
};

const count = (payload: Readonly<Record<string, unknown>>, key: string): number => {
  const value = payload[key];
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new HumanIdentityError('HUMAN_IDENTITY_STORE_CORRUPT', `A human identity payload lacks '${key}'.`);
  return value;
};

function evidenceOf(payload: Readonly<Record<string, unknown>>): HumanDecisionEvidence {
  const value = payload['evidence'];
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new HumanIdentityError('HUMAN_IDENTITY_STORE_CORRUPT', 'A decision row carries no evidence.');
  const e = value as Readonly<Record<string, unknown>>;
  const verdict = text(e, 'verdict');
  if (verdict !== 'approve' && verdict !== 'reject') throw new HumanIdentityError('HUMAN_IDENTITY_STORE_CORRUPT', 'A decision row has an unknown verdict.');
  return {
    format: text(e, 'format'),
    organizationId: text(e, 'organizationId'),
    operatorId: text(e, 'operatorId'),
    actorRef: text(e, 'actorRef'),
    credentialId: text(e, 'credentialId'),
    challengeCommitment: text(e, 'challengeCommitment'),
    assertionDigest: text(e, 'assertionDigest'),
    approvalRequestId: text(e, 'approvalRequestId'),
    subjectDigest: text(e, 'subjectDigest'),
    verdict,
    decidedAt: text(e, 'decidedAt'),
    rpId: text(e, 'rpId'),
    origin: text(e, 'origin'),
    userVerified: true,
    backedUp: e['backedUp'] === true,
  };
}

function project(rows: readonly StoredHumanIdentityRow[], organizationId: string): IdentityState {
  const principals = new Map<string, PrincipalState>();
  const enrolments = new Map<string, EnrolmentRecord>();
  const credentials = new Map<string, CredentialRecord>();
  const usedChallenges = new Set<string>();
  const decisions = new Map<string, DecisionState>();
  const corrupt = (message: string): never => {
    throw new HumanIdentityError('HUMAN_IDENTITY_STORE_CORRUPT', message);
  };
  for (const row of rows) {
    const payload = payloadOf(row);
    const challengeDigest = payload['challengeDigest'];
    if (typeof challengeDigest === 'string') {
      if (usedChallenges.has(challengeDigest)) corrupt('A challenge was consumed twice in the history.');
      usedChallenges.add(challengeDigest);
    }
    switch (row.kind) {
      case 'principal_created': {
        if (principals.has(row.operatorId)) corrupt('A human principal was created twice.');
        principals.set(row.operatorId, {
          userHandle: text(payload, 'userHandle'),
          principal: {
            operatorId: row.operatorId,
            actorRef: `operator:${row.operatorId}`,
            organizationId,
            displayName: text(payload, 'displayName'),
            state: 'active',
            createdAt: row.recordedAt,
            createdBy: row.recordedBy,
            revokedAt: null,
            revokedBy: null,
            revocationReason: null,
          },
        });
        break;
      }
      case 'principal_revoked': {
        const state = principals.get(row.operatorId) ?? corrupt('A revocation names an unknown human.');
        state.principal = { ...state.principal, state: 'revoked', revokedAt: row.recordedAt, revokedBy: row.recordedBy, revocationReason: text(payload, 'reason') };
        break;
      }
      case 'enrolment_authorized': {
        const enrolmentId = row.objectId ?? corrupt('An enrolment row has no id.');
        if (!principals.has(row.operatorId) || enrolments.has(enrolmentId)) corrupt('An enrolment is inconsistent with the history.');
        enrolments.set(enrolmentId, { enrolmentId, operatorId: row.operatorId, tokenVerifier: text(payload, 'tokenVerifier'), authorizedAt: row.recordedAt, authorizedBy: row.recordedBy, expiresAt: text(payload, 'expiresAt'), consumed: false, revoked: false });
        break;
      }
      case 'enrolment_revoked': {
        const enrolment = enrolments.get(row.objectId ?? '') ?? corrupt('An enrolment revocation names an unknown enrolment.');
        enrolment.revoked = true;
        break;
      }
      case 'credential_registered': {
        const credentialId = row.objectId ?? corrupt('A credential row has no id.');
        const enrolment = enrolments.get(text(payload, 'enrolmentId')) ?? corrupt('A credential names an unknown enrolment.');
        if (credentials.has(credentialId) || enrolment.consumed || enrolment.operatorId !== row.operatorId) corrupt('A credential registration is inconsistent with the history.');
        enrolment.consumed = true;
        const deviceType = text(payload, 'deviceType');
        if (deviceType !== 'singleDevice' && deviceType !== 'multiDevice') corrupt('A credential has an unknown device type.');
        credentials.set(credentialId, {
          publicKey: text(payload, 'publicKey'),
          view: {
            credentialId,
            operatorId: row.operatorId,
            organizationId,
            enrolmentId: enrolment.enrolmentId,
            state: 'active',
            counter: count(payload, 'counter'),
            deviceType: deviceType as CredentialDeviceType,
            backedUp: payload['backedUp'] === true,
            transports: Array.isArray(payload['transports']) ? (payload['transports'] as unknown[]).filter((entry): entry is string => typeof entry === 'string') : [],
            attestationFormat: text(payload, 'attestationFormat'),
            aaguid: text(payload, 'aaguid'),
            rpId: text(payload, 'rpId'),
            registeredAt: row.recordedAt,
            lastUsedAt: null,
            revokedAt: null,
            revokedBy: null,
            revocationReason: null,
          },
        });
        break;
      }
      case 'credential_used': {
        const credential = credentials.get(row.objectId ?? '') ?? corrupt('A credential use names an unknown credential.');
        credential.view = { ...credential.view, counter: count(payload, 'counter'), backedUp: payload['backedUp'] === true, lastUsedAt: row.recordedAt };
        break;
      }
      case 'credential_counter_anomaly': {
        if (!credentials.has(row.objectId ?? '')) corrupt('A counter anomaly names an unknown credential.');
        break;
      }
      case 'credential_revoked': {
        const credential = credentials.get(row.objectId ?? '') ?? corrupt('A credential revocation names an unknown credential.');
        const assertedWith = payload['assertedWith'];
        if (typeof assertedWith === 'string') {
          // An owner revocation records the use of the credential that asserted it, in the same row.
          const asserting = credentials.get(assertedWith) ?? corrupt('An owner revocation names an unknown asserting credential.');
          asserting.view = { ...asserting.view, counter: count(payload, 'counter'), backedUp: payload['backedUp'] === true, lastUsedAt: row.recordedAt };
        }
        credential.view = { ...credential.view, state: 'revoked', revokedAt: row.recordedAt, revokedBy: row.recordedBy, revocationReason: text(payload, 'reason') };
        break;
      }
      case 'decision_authorized': {
        const commitment = row.objectId ?? corrupt('A decision row has no commitment.');
        const evidence = evidenceOf(payload);
        if (decisions.has(commitment) || evidence.challengeCommitment !== commitment || evidence.operatorId !== row.operatorId || !credentials.has(evidence.credentialId)) corrupt('A decision is inconsistent with the history.');
        if (humanDecisionEvidenceDigest(evidence) !== text(payload, 'evidenceDigest')) corrupt('A decision row does not match its evidence digest.');
        decisions.set(commitment, { evidence, evidenceDigest: text(payload, 'evidenceDigest') });
        // The decision row also records the deciding credential's use.
        const deciding = credentials.get(evidence.credentialId) as CredentialRecord;
        deciding.view = { ...deciding.view, counter: count(payload, 'counter'), backedUp: payload['backedUp'] === true, lastUsedAt: row.recordedAt };
        break;
      }
      case 'decision_outcome': {
        const decision = decisions.get(row.objectId ?? '') ?? corrupt('A decision outcome names an unknown decision.');
        if (decision.outcome !== undefined) corrupt('A decision has two outcomes.');
        const outcome = text(payload, 'outcome');
        decision.outcome = outcome === 'recorded' ? { outcome: 'recorded', verdictRowDigest: text(payload, 'verdictRowDigest') } : outcome === 'refused' ? { outcome: 'refused', code: text(payload, 'code') } : corrupt('A decision outcome is of an unknown kind.');
        break;
      }
    }
  }
  return { principals, enrolments, credentials, usedChallenges, decisions };
}

// ── The service ─────────────────────────────────────────────────────────────

function verifierOf(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}

function verifierMatches(secret: string, verifier: string): boolean {
  const presented = Buffer.from(verifierOf(secret), 'hex');
  const stored = Buffer.from(verifier, 'hex');
  return presented.length === 32 && stored.length === 32 && timingSafeEqual(presented, stored);
}

function boundedSeconds(value: number | undefined, fallback: number, maximum: number, name: string): number {
  const seconds = value ?? fallback;
  if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > maximum) throw new HumanIdentityError('HUMAN_IDENTITY_CONFIGURATION_INVALID', `${name} must be an integer between 1 and ${String(maximum)}.`);
  return seconds;
}

function reasonOf(reason: string): string {
  if (typeof reason !== 'string' || reason.trim().length === 0 || reason.length > 512) throw new HumanIdentityError('HUMAN_IDENTITY_CONFIGURATION_INVALID', 'A revocation reason is a non-empty string of at most 512 characters.');
  return reason;
}

function challengeRefused(): HumanIdentityError {
  return new HumanIdentityError('HUMAN_IDENTITY_CHALLENGE_INVALID', 'The ceremony challenge is unknown, of another ceremony, expired or already used.');
}

export function createHumanIdentityService(options: HumanIdentityServiceOptions): HumanIdentityService {
  const { store, relyingParty } = options;
  const organizationId = store.organizationId;
  const operatorIds = new Set(options.operatorIds);
  const now = options.now ?? ((): Date => new Date());
  const enrolmentTtl = boundedSeconds(options.enrolmentTtlSeconds, ENROLMENT_TTL_DEFAULT_SECONDS, ENROLMENT_TTL_MAX_SECONDS, 'enrolmentTtlSeconds');
  const challengeTtl = boundedSeconds(options.challengeTtlSeconds, CHALLENGE_TTL_DEFAULT_SECONDS, CHALLENGE_TTL_MAX_SECONDS, 'challengeTtlSeconds');
  const decisionTtl = boundedSeconds(options.decisionChallengeTtlSeconds, HUMAN_DECISION_CHALLENGE_MAX_LIFETIME_SECONDS, HUMAN_DECISION_CHALLENGE_MAX_LIFETIME_SECONDS, 'decisionChallengeTtlSeconds');
  const iso = (): string => now().toISOString();
  const after = (seconds: number): string => new Date(now().getTime() + seconds * 1000).toISOString();

  const state = (): IdentityState => project(store.history(), organizationId);

  function administrator(value: IdentityAdministrator): IdentityAdministrator {
    if (!ADMINISTRATORS.has(value)) throw new HumanIdentityError('HUMAN_IDENTITY_ADMINISTRATOR_REQUIRED', 'An administrative act requires an administrator established by the operator plane.');
    if (value.organizationId !== organizationId) throw new HumanIdentityError('HUMAN_IDENTITY_ADMINISTRATOR_REQUIRED', "The administrator belongs to another organization than this Host's.");
    return value;
  }

  const row = (kind: StoredHumanIdentityRow['kind'], operatorId: string, objectId: string | null, payload: { readonly [key: string]: HumanIdentityJson }, recordedBy: string) =>
    ({ kind, operatorId, objectId, payload: canonicalJson(payload), recordedBy, recordedAt: iso() }) as const;

  const enrolmentState = (record: EnrolmentRecord, at: string): EnrolmentAuthorizationView['state'] =>
    record.revoked ? 'revoked' : record.consumed ? 'consumed' : record.expiresAt <= at ? 'expired' : 'open';

  const enrolmentView = (record: EnrolmentRecord): EnrolmentAuthorizationView => ({
    enrolmentId: record.enrolmentId,
    operatorId: record.operatorId,
    state: enrolmentState(record, iso()),
    authorizedAt: record.authorizedAt,
    authorizedBy: record.authorizedBy,
    expiresAt: record.expiresAt,
  });

  function activePrincipal(current: IdentityState, operatorId: string): PrincipalState {
    const found = current.principals.get(operatorId);
    if (found === undefined) throw new HumanIdentityError('HUMAN_IDENTITY_UNKNOWN_PRINCIPAL', 'No human principal exists for that operator.');
    if (found.principal.state !== 'active') throw new HumanIdentityError('HUMAN_IDENTITY_PRINCIPAL_REVOKED', 'That human principal is revoked.');
    return found;
  }

  /** The open enrolment a presented token authorizes, or one refusal for every failure. */
  function openEnrolment(current: IdentityState, token: string): EnrolmentRecord {
    const refusal = new HumanIdentityError('HUMAN_IDENTITY_ENROLMENT_INVALID', 'The enrolment token is not valid.');
    const match = typeof token === 'string' ? ENROLMENT_TOKEN.exec(token) : null;
    if (match?.[1] === undefined || match[2] === undefined) throw refusal;
    const record = current.enrolments.get(match[1]);
    if (record === undefined || !verifierMatches(match[2], record.tokenVerifier) || enrolmentState(record, iso()) !== 'open') throw refusal;
    return record;
  }

  function challengeFor(ceremony: CeremonyKind, bindings: { readonly operatorId?: string; readonly enrolmentId?: string; readonly targetCredentialId?: string }): CeremonyChallenge {
    const challenge: Omit<CeremonyChallenge, 'consumedAt'> = {
      challenge: randomBytes(32).toString('base64url'),
      ceremony,
      operatorId: bindings.operatorId ?? null,
      enrolmentId: bindings.enrolmentId ?? null,
      targetCredentialId: bindings.targetCredentialId ?? null,
      issuedAt: iso(),
      expiresAt: after(challengeTtl),
    };
    store.saveChallenge(challenge);
    return { ...challenge, consumedAt: null };
  }

  /** The stored, unused, unexpired challenge of `ceremony` the client data names; one refusal for every failure. */
  function storedChallenge(challenge: string, ceremony: CeremonyKind): CeremonyChallenge {
    const found = store.challenge(challenge);
    if (found === undefined || found.ceremony !== ceremony || found.consumedAt !== null || found.expiresAt <= iso()) throw challengeRefused();
    return found;
  }

  const notUsed = (digest: string) => (history: readonly StoredHumanIdentityRow[]): IdentityState => {
    const current = project(history, organizationId);
    if (current.usedChallenges.has(digest)) throw challengeRefused();
    return current;
  };

  const authenticationOptions = (challenge: string, allow: readonly string[], ttlSeconds: number): AuthenticationOptionsJSON => ({
    rpId: relyingParty.rpId,
    challenge,
    timeout: ttlSeconds * 1000,
    userVerification: 'required',
    allowCredentials: allow.map((id) => ({ type: 'public-key' as const, id })),
  });

  const activeCredentialsOf = (current: IdentityState, operatorId: string): readonly string[] =>
    [...current.credentials.values()].filter((credential) => credential.view.operatorId === operatorId && credential.view.state === 'active').map((credential) => credential.view.credentialId);

  interface VerifiedUse {
    readonly credential: CredentialRecord;
    readonly principal: PrincipalState;
    readonly counter: number;
    readonly backedUp: boolean;
    readonly deviceType: CredentialDeviceType;
    readonly origin: string;
  }

  /**
   * Verifies an assertion by an active credential of an active human over
   * `expectedChallenge`, owned by `expectedOperatorId` when one is bound, and
   * applies the counter rule after the signature has verified. A regression
   * is recorded (consuming the challenge) and refused.
   */
  async function verifiedUse(response: AuthenticationResponse, expectedChallenge: string, expectedOperatorId: string | null, consumedBy: () => Promise<void>): Promise<VerifiedUse> {
    const current = state();
    const credential = current.credentials.get(response.id);
    if (credential === undefined || credential.view.state !== 'active') throw new HumanIdentityError('HUMAN_IDENTITY_CREDENTIAL_UNUSABLE', 'The credential is unknown or revoked.');
    const principal = current.principals.get(credential.view.operatorId);
    if (principal === undefined || principal.principal.state !== 'active') throw new HumanIdentityError('HUMAN_IDENTITY_CREDENTIAL_UNUSABLE', "The credential's human is revoked.");
    if (expectedOperatorId !== null && expectedOperatorId !== credential.view.operatorId) throw new HumanIdentityError('HUMAN_IDENTITY_CREDENTIAL_OWNERSHIP_MISMATCH', 'The credential does not belong to the human this ceremony was opened for.');
    if (response.response.userHandle !== undefined && response.response.userHandle !== principal.userHandle) {
      throw new HumanIdentityError('HUMAN_IDENTITY_CREDENTIAL_OWNERSHIP_MISMATCH', "The assertion's user handle is not the credential owner's.");
    }
    const verified = await verifyAssertion(response, expectedChallenge, { credentialId: credential.view.credentialId, publicKey: credential.publicKey }, relyingParty);
    const counter = signatureCounterOf(response.response.authenticatorData);
    if (counter !== verified.counter) throw new HumanIdentityError('HUMAN_IDENTITY_AUTHENTICATION_INVALID', 'The authenticator data counter is inconsistent.');
    const stored = credential.view.counter;
    if ((counter > 0 || stored > 0) && counter <= stored) {
      // The signature verified, so this is the credential's key speaking with a counter that did not advance: record it (consuming the challenge), refuse it.
      await consumedBy();
      throw new HumanIdentityError('HUMAN_IDENTITY_COUNTER_REGRESSION', 'The signature counter did not advance; the attempt is refused and recorded.');
    }
    return { credential, principal, counter, backedUp: verified.backedUp, deviceType: verified.deviceType, origin: verified.origin };
  }

  /** Re-checks, against the verified history, that a credential and its human are still usable. */
  const stillUsable = (credentialId: string, current: IdentityState): void => {
    const credential = current.credentials.get(credentialId);
    if (credential === undefined || credential.view.state !== 'active' || current.principals.get(credential.view.operatorId)?.principal.state !== 'active') {
      throw new HumanIdentityError('HUMAN_IDENTITY_CREDENTIAL_UNUSABLE', 'The credential or its human was revoked.');
    }
  };

  /** Re-checks, against the verified history, that the counter still advances: a concurrent use may have moved it since verification. */
  const counterStillAdvances = (current: IdentityState, credentialId: string, counter: number): void => {
    const stored = current.credentials.get(credentialId)?.view.counter ?? 0;
    if ((counter > 0 || stored > 0) && counter <= stored) throw new HumanIdentityError('HUMAN_IDENTITY_COUNTER_REGRESSION', 'The signature counter did not advance past a concurrent use; nothing was recorded.');
  };

  const anomaly = (credential: CredentialRecord, challengeDigest: string, presented: number) => async (): Promise<void> => {
    await store.append(row('credential_counter_anomaly', credential.view.operatorId, credential.view.credentialId, { presented, stored: credential.view.counter, challengeDigest }, CEREMONY_RECORDER), (history) => void notUsed(challengeDigest)(history));
  };

  /** The decision challenge an assertion's client data names, with its commitment recomputed from the stored contract; one refusal for every failure. */
  function decisionChallengeOf(response: AuthenticationResponse): { readonly stored: StoredDecisionChallenge; readonly commitment: string } {
    const clientData = clientDataOf(response.response.clientDataJSON, 'webauthn.get', relyingParty);
    const stored = store.decisionChallenge(clientData.challenge);
    if (stored === undefined) throw challengeRefused();
    const commitment = humanDecisionChallengeCommitment(stored.contract);
    if (webAuthnChallengeOf(commitment) !== clientData.challenge || stored.contract.format !== HUMAN_DECISION_CHALLENGE_FORMAT || stored.contract.organizationId !== organizationId) {
      throw new HumanIdentityError('HUMAN_IDENTITY_CHALLENGE_INVALID', 'The decision challenge does not match its commitment.');
    }
    return { stored, commitment };
  }

  const decisionRecord = (current: IdentityState, stored: StoredDecisionChallenge, commitment: string): HumanDecisionRecord => {
    const decided = current.decisions.get(commitment);
    if (decided !== undefined) {
      return { contract: stored.contract, commitment, state: 'consumed', evidence: decided.evidence, evidenceDigest: decided.evidenceDigest, ...(decided.outcome !== undefined ? { outcome: decided.outcome } : {}) };
    }
    return { contract: stored.contract, commitment, state: stored.contract.expiresAt <= iso() ? 'expired' : 'issued' };
  };

  return {
    organizationId,

    async createPrincipal(admin, input) {
      const actor = administrator(admin);
      const operatorId = input?.operatorId;
      if (typeof operatorId !== 'string' || !OPERATOR_ID.test(operatorId) || !operatorIds.has(operatorId)) throw new HumanIdentityError('HUMAN_IDENTITY_UNKNOWN_OPERATOR', "That operator id is not one of this Host's configured operators.");
      const displayName = input.displayName;
      if (typeof displayName !== 'string' || displayName.trim() !== displayName || displayName.length === 0 || displayName.length > 128) throw new HumanIdentityError('HUMAN_IDENTITY_CONFIGURATION_INVALID', 'displayName must be a non-empty trimmed string of at most 128 characters.');
      await store.append(row('principal_created', operatorId, null, { displayName, userHandle: randomBytes(32).toString('base64url') }, actor.actorRef), (history) => {
        if (project(history, organizationId).principals.has(operatorId)) throw new HumanIdentityError('HUMAN_IDENTITY_PRINCIPAL_EXISTS', 'A human principal already exists for that operator.');
      });
      return (state().principals.get(operatorId) as PrincipalState).principal;
    },

    async revokePrincipal(admin, operatorId, reason) {
      const actor = administrator(admin);
      const why = reasonOf(reason);
      await store.append(row('principal_revoked', operatorId, null, { reason: why }, actor.actorRef), (history) => {
        const found = project(history, organizationId).principals.get(operatorId);
        if (found === undefined) throw new HumanIdentityError('HUMAN_IDENTITY_UNKNOWN_PRINCIPAL', 'No human principal exists for that operator.');
        if (found.principal.state === 'revoked') throw new HumanIdentityError('HUMAN_IDENTITY_ALREADY_REVOKED', 'That human principal is already revoked.');
      });
      return (state().principals.get(operatorId) as PrincipalState).principal;
    },

    async authorizeEnrolment(admin, operatorId) {
      const actor = administrator(admin);
      activePrincipal(state(), operatorId);
      const enrolmentId = `enr-${randomBytes(16).toString('hex')}`;
      const secret = randomBytes(32).toString('base64url');
      const expiresAt = after(enrolmentTtl);
      await store.append(row('enrolment_authorized', operatorId, enrolmentId, { expiresAt, tokenVerifier: verifierOf(secret) }, actor.actorRef), (history) => {
        activePrincipal(project(history, organizationId), operatorId);
      });
      const record = state().enrolments.get(enrolmentId) as EnrolmentRecord;
      return { ...enrolmentView(record), enrolmentToken: `fre1.${enrolmentId}.${secret}` };
    },

    async revokeEnrolment(admin, enrolmentId, reason) {
      const actor = administrator(admin);
      const why = reasonOf(reason);
      if (typeof enrolmentId !== 'string' || !ENROLMENT_ID.test(enrolmentId)) throw new HumanIdentityError('HUMAN_IDENTITY_ENROLMENT_INVALID', 'That is not an enrolment id.');
      const current = state().enrolments.get(enrolmentId);
      if (current === undefined) throw new HumanIdentityError('HUMAN_IDENTITY_ENROLMENT_INVALID', 'No such enrolment.');
      await store.append(row('enrolment_revoked', current.operatorId, enrolmentId, { reason: why }, actor.actorRef), (history) => {
        const record = project(history, organizationId).enrolments.get(enrolmentId);
        if (record === undefined) throw new HumanIdentityError('HUMAN_IDENTITY_ENROLMENT_INVALID', 'No such enrolment.');
        if (record.revoked || record.consumed) throw new HumanIdentityError('HUMAN_IDENTITY_ALREADY_REVOKED', 'That enrolment is already revoked or consumed.');
      });
      return enrolmentView(state().enrolments.get(enrolmentId) as EnrolmentRecord);
    },

    beginRegistration(enrolmentToken) {
      const current = state();
      const enrolment = openEnrolment(current, enrolmentToken);
      const principal = activePrincipal(current, enrolment.operatorId);
      const challenge = challengeFor('registration', { operatorId: enrolment.operatorId, enrolmentId: enrolment.enrolmentId });
      const existing = [...current.credentials.values()].filter((credential) => credential.view.operatorId === enrolment.operatorId).map((credential) => credential.view.credentialId);
      return {
        rp: { id: relyingParty.rpId, name: relyingParty.rpName },
        user: { id: principal.userHandle, name: enrolment.operatorId, displayName: principal.principal.displayName },
        challenge: challenge.challenge,
        pubKeyCredParams: SUPPORTED_COSE_ALGORITHMS.map((alg) => ({ type: 'public-key' as const, alg })),
        timeout: challengeTtl * 1000,
        attestation: 'none',
        excludeCredentials: existing.map((id) => ({ type: 'public-key' as const, id })),
        authenticatorSelection: { residentKey: 'required', requireResidentKey: true, userVerification: 'required' },
      };
    },

    async finishRegistration(enrolmentToken, raw) {
      const enrolment = openEnrolment(state(), enrolmentToken);
      const response = parseRegistrationResponse(raw);
      const clientData = clientDataOf(response.response.clientDataJSON, 'webauthn.create', relyingParty);
      const challenge = storedChallenge(clientData.challenge, 'registration');
      if (challenge.enrolmentId !== enrolment.enrolmentId || challenge.operatorId !== enrolment.operatorId) {
        throw new HumanIdentityError('HUMAN_IDENTITY_CHALLENGE_INVALID', 'The ceremony challenge was issued for another enrolment.');
      }
      const verified = await verifyRegistration(response, challenge.challenge, relyingParty);
      const challengeDigest = challengeDigestOf(challenge.challenge);
      await store.append(
        row(
            'credential_registered',
            enrolment.operatorId,
            verified.credentialId,
            {
              enrolmentId: enrolment.enrolmentId,
              publicKey: verified.publicKey,
              counter: verified.counter,
              deviceType: verified.deviceType,
              backedUp: verified.backedUp,
              transports: [...(response.response.transports ?? [])],
              attestationFormat: verified.attestationFormat,
              aaguid: verified.aaguid,
              rpId: relyingParty.rpId,
              origin: verified.origin,
              challengeDigest,
            },
            CEREMONY_RECORDER,
          ),
        (history) => {
          const current = notUsed(challengeDigest)(history);
          if (current.credentials.has(verified.credentialId)) throw new HumanIdentityError('HUMAN_IDENTITY_CREDENTIAL_DUPLICATE', 'That credential id is already registered.');
          const record = current.enrolments.get(enrolment.enrolmentId);
          if (record === undefined || enrolmentState(record, iso()) !== 'open') throw new HumanIdentityError('HUMAN_IDENTITY_ENROLMENT_INVALID', 'The enrolment token is not valid.');
          activePrincipal(current, enrolment.operatorId);
        },
        { challenge: challenge.challenge, ceremony: 'registration', at: iso() },
      );
      return (state().credentials.get(verified.credentialId) as CredentialRecord).view;
    },

    beginAuthentication() {
      return authenticationOptions(challengeFor('authentication', {}).challenge, [], challengeTtl);
    },

    async finishAuthentication(raw) {
      const response = parseAuthenticationResponse(raw);
      const clientData = clientDataOf(response.response.clientDataJSON, 'webauthn.get', relyingParty);
      const challenge = storedChallenge(clientData.challenge, 'authentication');
      const challengeDigest = challengeDigestOf(challenge.challenge);
      const known = state().credentials.get(response.id);
      const use = await verifiedUse(response, challenge.challenge, null, known === undefined ? async () => undefined : anomaly(known, challengeDigest, signatureCounterOf(response.response.authenticatorData)));
      await store.append(
        row('credential_used', use.credential.view.operatorId, use.credential.view.credentialId, { counter: use.counter, backedUp: use.backedUp, challengeDigest }, CEREMONY_RECORDER),
        (history) => {
          const current = notUsed(challengeDigest)(history);
          stillUsable(use.credential.view.credentialId, current);
          counterStillAdvances(current, use.credential.view.credentialId, use.counter);
        },
        { challenge: challenge.challenge, ceremony: 'authentication', at: iso() },
      );
      return {
        operatorId: use.principal.principal.operatorId,
        actorRef: use.principal.principal.actorRef,
        organizationId,
        credentialId: use.credential.view.credentialId,
        userVerified: true,
        deviceType: use.deviceType,
        backedUp: use.backedUp,
        counter: use.counter,
        recognizedAt: iso(),
      };
    },

    async revokeCredential(admin, credentialId, reason) {
      const actor = administrator(admin);
      const why = reasonOf(reason);
      const existing = state().credentials.get(credentialId);
      if (existing === undefined) throw new HumanIdentityError('HUMAN_IDENTITY_CREDENTIAL_UNUSABLE', 'No such credential.');
      await store.append(row('credential_revoked', existing.view.operatorId, credentialId, { reason: why, revokedBy: 'administrator' }, actor.actorRef), (history) => {
        const credential = project(history, organizationId).credentials.get(credentialId);
        if (credential === undefined) throw new HumanIdentityError('HUMAN_IDENTITY_CREDENTIAL_UNUSABLE', 'No such credential.');
        if (credential.view.state === 'revoked') throw new HumanIdentityError('HUMAN_IDENTITY_ALREADY_REVOKED', 'That credential is already revoked.');
      });
      return (state().credentials.get(credentialId) as CredentialRecord).view;
    },

    beginOwnerRevocation(credentialId) {
      const current = state();
      const target = current.credentials.get(credentialId);
      if (target === undefined || target.view.state !== 'active') throw new HumanIdentityError('HUMAN_IDENTITY_CREDENTIAL_UNUSABLE', 'The credential is unknown or revoked.');
      activePrincipal(current, target.view.operatorId);
      const challenge = challengeFor('owner-revocation', { operatorId: target.view.operatorId, targetCredentialId: credentialId });
      return authenticationOptions(challenge.challenge, activeCredentialsOf(current, target.view.operatorId), challengeTtl);
    },

    async finishOwnerRevocation(credentialId, raw, reason) {
      const why = reasonOf(reason);
      const response = parseAuthenticationResponse(raw);
      const clientData = clientDataOf(response.response.clientDataJSON, 'webauthn.get', relyingParty);
      const challenge = storedChallenge(clientData.challenge, 'owner-revocation');
      const challengeDigest = challengeDigestOf(challenge.challenge);
      const known = state().credentials.get(response.id);
      const use = await verifiedUse(response, challenge.challenge, challenge.operatorId, known === undefined ? async () => undefined : anomaly(known, challengeDigest, signatureCounterOf(response.response.authenticatorData)));
      if (challenge.targetCredentialId !== credentialId) throw new HumanIdentityError('HUMAN_IDENTITY_CHALLENGE_INVALID', 'The owner-revocation challenge was issued for another credential.');
      const target = state().credentials.get(credentialId);
      if (target === undefined || target.view.operatorId !== use.credential.view.operatorId) throw new HumanIdentityError('HUMAN_IDENTITY_CREDENTIAL_OWNERSHIP_MISMATCH', 'Only the human who owns a credential may revoke it this way.');
      const asserting = use.credential.view.credentialId;
      await store.append(
        // One row (CORE-07 advances one position per append): the revocation also records the asserting credential's use.
        row('credential_revoked', target.view.operatorId, credentialId, { reason: why, revokedBy: 'owner', assertedWith: asserting, counter: use.counter, backedUp: use.backedUp, challengeDigest }, `owner:${asserting}`),
        (history) => {
          const current = notUsed(challengeDigest)(history);
          stillUsable(asserting, current);
          counterStillAdvances(current, asserting, use.counter);
          const credential = current.credentials.get(credentialId);
          if (credential === undefined || credential.view.state === 'revoked') throw new HumanIdentityError('HUMAN_IDENTITY_ALREADY_REVOKED', 'That credential is already revoked.');
        },
        { challenge: challenge.challenge, ceremony: 'owner-revocation', at: iso() },
      );
      return (state().credentials.get(credentialId) as CredentialRecord).view;
    },

    beginDecision(input) {
      const { operatorId, approvalRequestId, subjectDigest, verdict } = input ?? ({} as Partial<typeof input>);
      if (typeof approvalRequestId !== 'string' || approvalRequestId.trim().length === 0 || approvalRequestId.length > MAX_TEXT) throw new HumanIdentityError('HUMAN_IDENTITY_CHALLENGE_INVALID', 'A decision names one approval request.');
      if (typeof subjectDigest !== 'string' || !SHA256.test(subjectDigest)) throw new HumanIdentityError('HUMAN_IDENTITY_CHALLENGE_INVALID', 'A decision names the exact subject digest the human was shown.');
      if (verdict !== 'approve' && verdict !== 'reject') throw new HumanIdentityError('HUMAN_IDENTITY_CHALLENGE_INVALID', 'A decision verdict is approve or reject.');
      const current = state();
      activePrincipal(current, typeof operatorId === 'string' ? operatorId : '');
      const allow = activeCredentialsOf(current, operatorId as string);
      if (allow.length === 0) throw new HumanIdentityError('HUMAN_IDENTITY_CREDENTIAL_UNUSABLE', 'That human holds no active passkey.');
      const contract: HumanDecisionChallengeContract = {
        format: HUMAN_DECISION_CHALLENGE_FORMAT,
        organizationId,
        approvalRequestId,
        subjectDigest,
        verdict,
        operatorId: operatorId as string,
        nonce: randomBytes(32).toString('base64url'),
        issuedAt: iso(),
        expiresAt: after(decisionTtl),
      };
      const commitment = humanDecisionChallengeCommitment(contract);
      const challenge = webAuthnChallengeOf(commitment);
      store.saveDecisionChallenge({ challenge, contract });
      return { contract, commitment, options: authenticationOptions(challenge, allow, decisionTtl) };
    },

    peekDecision(raw) {
      const { stored, commitment } = decisionChallengeOf(parseAuthenticationResponse(raw));
      return { contract: stored.contract, commitment };
    },

    async authorizeDecision(raw) {
      const response = parseAuthenticationResponse(raw);
      const { stored, commitment } = decisionChallengeOf(response);
      const contract = stored.contract;
      const challengeDigest = challengeDigestOf(stored.challenge);
      const before = state();
      if (before.decisions.has(commitment)) throw new HumanIdentityError('HUMAN_IDENTITY_DECISION_CHALLENGE_CONSUMED', 'This decision challenge was already used; read its outcome instead.');
      if (contract.expiresAt <= iso() || before.usedChallenges.has(challengeDigest)) throw challengeRefused();
      const known = before.credentials.get(response.id);
      const use = await verifiedUse(response, stored.challenge, contract.operatorId, known === undefined ? async () => undefined : anomaly(known, challengeDigest, signatureCounterOf(response.response.authenticatorData)));
      const decidedAt = iso();
      const evidence: HumanDecisionEvidence = {
        format: HUMAN_DECISION_EVIDENCE_FORMAT,
        organizationId,
        operatorId: contract.operatorId,
        actorRef: use.principal.principal.actorRef,
        credentialId: use.credential.view.credentialId,
        challengeCommitment: commitment,
        assertionDigest: humanDecisionAssertionDigest({ credentialId: response.id, clientDataJSON: response.response.clientDataJSON, authenticatorData: response.response.authenticatorData, signature: response.response.signature }),
        approvalRequestId: contract.approvalRequestId,
        subjectDigest: contract.subjectDigest,
        verdict: contract.verdict,
        decidedAt,
        rpId: relyingParty.rpId,
        origin: use.origin,
        userVerified: true,
        backedUp: use.backedUp,
      };
      const evidenceDigest = humanDecisionEvidenceDigest(evidence);
      await store.append(
        // One row (CORE-07 advances one position per append): the decision also records the credential's use.
        row('decision_authorized', contract.operatorId, commitment, { evidence: { ...evidence }, evidenceDigest, challengeDigest, counter: use.counter, backedUp: use.backedUp }, CEREMONY_RECORDER),
        (history) => {
          const current = project(history, organizationId);
          if (current.decisions.has(commitment)) throw new HumanIdentityError('HUMAN_IDENTITY_DECISION_CHALLENGE_CONSUMED', 'This decision challenge was already used; read its outcome instead.');
          if (current.usedChallenges.has(challengeDigest) || contract.expiresAt <= decidedAt) throw challengeRefused();
          stillUsable(use.credential.view.credentialId, current);
          counterStillAdvances(current, use.credential.view.credentialId, use.counter);
        },
      );
      return { contract, commitment, evidence, evidenceDigest };
    },

    async recordDecisionOutcome(commitment, outcome) {
      const decided = state().decisions.get(commitment);
      if (decided === undefined) throw new HumanIdentityError('HUMAN_IDENTITY_CHALLENGE_INVALID', 'No authorized decision exists for that commitment.');
      const payload = outcome.outcome === 'recorded' ? { outcome: 'recorded', verdictRowDigest: outcome.verdictRowDigest } : { outcome: 'refused', code: outcome.code };
      await store.append(row('decision_outcome', decided.evidence.operatorId, commitment, payload, CEREMONY_RECORDER), (history) => {
        const current = project(history, organizationId).decisions.get(commitment);
        if (current === undefined) throw new HumanIdentityError('HUMAN_IDENTITY_CHALLENGE_INVALID', 'No authorized decision exists for that commitment.');
        if (current.outcome !== undefined) throw new HumanIdentityError('HUMAN_IDENTITY_ALREADY_REVOKED', 'That decision already has a recorded outcome.');
      });
    },

    decision(commitment) {
      if (typeof commitment !== 'string' || !SHA256.test(commitment)) return undefined;
      const stored = store.decisionChallenge(webAuthnChallengeOf(commitment));
      if (stored === undefined || humanDecisionChallengeCommitment(stored.contract) !== commitment) return undefined;
      return decisionRecord(state(), stored, commitment);
    },

    principal: (operatorId) => state().principals.get(operatorId)?.principal,
    credentialsOf: (operatorId) => [...state().credentials.values()].filter((credential) => credential.view.operatorId === operatorId).map((credential) => credential.view),
    enrolment: (enrolmentId) => {
      const record = state().enrolments.get(enrolmentId);
      return record === undefined ? undefined : enrolmentView(record);
    },
  };
}
