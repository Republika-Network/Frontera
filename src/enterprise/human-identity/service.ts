import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import type { EnterpriseOperatorPrincipal } from '../operator-control/operator-authenticator.js';
import { canonicalJson, type HumanIdentityJson, type StoredHumanIdentityRow } from './chain.js';
import { fvOperatorPlanUnfinished, fvOwnedHistory } from './fv-domain.js';
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
  BOOTSTRAP_AUTHORITY_CHALLENGE_FORMAT,
  BOOTSTRAP_AUTHORITY_EVIDENCE_FORMAT,
  RETIRED_BOOTSTRAP_AUTHORITY_FORMATS,
  bootstrapAuthorityRequestId,
  parseBootstrapAuthorityRequestId,
  HUMAN_DECISION_CHALLENGE_FORMAT,
  HUMAN_DECISION_CHALLENGE_MAX_LIFETIME_SECONDS,
  HUMAN_DECISION_EVIDENCE_FORMAT,
  bootstrapAuthorityEvidenceDigest,
  challengeDigestOf,
  decisionContractCommitment,
  humanDecisionAssertionDigest,
  humanDecisionEvidenceDigest,
  webAuthnChallengeOf,
  type BootstrapAuthorityChallengeContract,
  type BootstrapAuthorityDecisionEvidence,
  type BootstrapAuthorityRole,
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
/** AUTH-04B2: at most this many open (unconsumed, unrevoked, unexpired) enrolment invitations per human. */
export const OPEN_ENROLMENTS_MAX = 3;

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

export type HumanDecisionOutcome =
  | { readonly outcome: 'recorded'; readonly verdictRowDigest: string }
  | { readonly outcome: 'refused'; readonly code: string }
  /** AUTH-04A: reconciliation found no CORE-05 verdict citing a consumed decision that is no longer in flight. Terminal: it never authorizes again. */
  | { readonly outcome: 'abandoned' };

/** FV-P4C-2B2B: a bootstrap-authority decision challenge as issued (see `decision-challenge.ts`). */
export interface IssuedBootstrapAuthorityChallenge {
  readonly contract: BootstrapAuthorityChallengeContract;
  readonly commitment: string;
  readonly options: AuthenticationOptionsJSON;
}

/** FV-P4C-2B2B: a verified, consumed bootstrap-authority decision. Consumed is not committed: the bootstrap may still fail. */
export interface AuthorizedBootstrapAuthorityDecision {
  readonly contract: BootstrapAuthorityChallengeContract;
  readonly commitment: string;
  readonly evidence: BootstrapAuthorityDecisionEvidence;
  readonly evidenceDigest: string;
}

/** Why a consumed bootstrap-authority decision anchored nothing. Closed. */
export type BootstrapAuthorityNotCommittedCode =
  /** The receiver's history holds no bootstrap evidence for this binding, and the attempt can no longer commit. */
  | 'NO_BOOTSTRAP_EVIDENCE'
  /** The binding was anchored, but by other decisions: this one's attempt lost. */
  | 'ANCHORED_BY_OTHER_DECISIONS';

export const BOOTSTRAP_AUTHORITY_NOT_COMMITTED_CODES: readonly BootstrapAuthorityNotCommittedCode[] = Object.freeze(['NO_BOOTSTRAP_EVIDENCE', 'ANCHORED_BY_OTHER_DECISIONS']);

/**
 * FV-P4C-2B2B — the external settlement of one consumed bootstrap-authority
 * decision: what happened to the bootstrap it was consumed for, correlated to
 * the receiver's own bootstrap evidence. A settlement of this kind exists only
 * for bootstrap-authority decisions; CORE-05 decisions keep
 * `HumanDecisionOutcome`. One per decision, never rewritten.
 */
export type BootstrapAuthoritySettlement =
  | {
      readonly outcome: 'bootstrap-committed';
      /** The FV-P4C-2B1 binding digest: must be this decision's subject. */
      readonly bindingDigest: string;
      /** The other decision of the same bootstrap: same subject, the other role, another human. */
      readonly counterpartCommitment: string;
      /** The FV bootstrap request id, as the receiver's evidence records it. */
      readonly bootstrapRequestId: string;
      /** `sha256:<hex>` over the receiver's committed bootstrap evidence record, as stored. */
      readonly bootstrapEvidenceDigest: string;
      /** The committed transition: history revision, status sequence and status digest. */
      readonly historyRevision: number;
      readonly statusSequence: number;
      readonly statusDigest: string;
    }
  | { readonly outcome: 'bootstrap-not-committed'; readonly bindingDigest: string; readonly code: BootstrapAuthorityNotCommittedCode };

/** FV-P4C-2B2B: what the identity store knows about one bootstrap-authority commitment. */
export interface BootstrapAuthorityDecisionRecord {
  readonly contract: BootstrapAuthorityChallengeContract;
  readonly commitment: string;
  readonly state: 'issued' | 'consumed' | 'expired';
  readonly evidence?: BootstrapAuthorityDecisionEvidence;
  readonly evidenceDigest?: string;
  readonly settlement?: BootstrapAuthoritySettlement;
}

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
  /** AUTH-04A: every consumed CORE-05 decision with no recorded outcome, oldest first — what reconciliation reads. Never a bootstrap-authority decision. */
  unsettledDecisions(): readonly HumanDecisionRecord[];
  /** FV-P4C-2B2B: issues a challenge in the bootstrap-authority domain, bound to one FV binding digest and one signed role. */
  beginBootstrapAuthorityDecision(input: { readonly operatorId: string; readonly namespace: string; readonly bindingDigest: string; readonly role: BootstrapAuthorityRole }): IssuedBootstrapAuthorityChallenge;
  /** FV-P4C-2B2B: the stored bootstrap-authority contract an assertion answers. Verifies nothing about the assertion; refuses every other domain. */
  peekBootstrapAuthorityDecision(response: unknown): { readonly contract: BootstrapAuthorityChallengeContract; readonly commitment: string };
  /** FV-P4C-2B2B: verifies and consumes a bootstrap-authority decision, exactly as `authorizeDecision` does a CORE-05 one. Refuses every other domain. */
  authorizeBootstrapAuthorityDecision(response: unknown): Promise<AuthorizedBootstrapAuthorityDecision>;
  /**
   * FV-P4C-2B2B: records the external settlement of a consumed bootstrap-authority decision.
   * F1: refused unless `capability` is this very instance's live settlement capability, which only
   * `createHumanIdentityServiceWithBootstrapSettlement` issues. Holding the service, a commitment or
   * a well-formed settlement is not permission. Idempotent for an identical settlement; any other
   * second settlement is a conflict.
   */
  recordBootstrapAuthoritySettlement(capability: BootstrapSettlementCapability, commitment: string, settlement: BootstrapAuthoritySettlement): Promise<'recorded' | 'unchanged'>;
  bootstrapAuthorityDecision(commitment: string): BootstrapAuthorityDecisionRecord | undefined;
  /** FV-P4C-2B2B: every consumed bootstrap-authority decision with no settlement, oldest first. */
  unsettledBootstrapAuthorityDecisions(): readonly BootstrapAuthorityDecisionRecord[];
  principal(operatorId: string): HumanPrincipal | undefined;
  credentialsOf(operatorId: string): readonly PasskeyCredentialView[];
  enrolment(enrolmentId: string): EnrolmentAuthorizationView | undefined;
  /** AUTH-04B2: every enrolment invitation of one human, oldest first. Never a token: only verifiers are stored. */
  enrolmentsOf(operatorId: string): readonly EnrolmentAuthorizationView[];
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

/** FV-P4C-2B2B: a consumed decision is of exactly one domain, fixed by its evidence format; an outcome of the other domain is corruption. */
type DecisionState =
  | { readonly domain: 'core-05'; readonly evidence: HumanDecisionEvidence; readonly evidenceDigest: string; outcome?: HumanDecisionOutcome }
  | { readonly domain: 'bootstrap-authority'; readonly evidence: BootstrapAuthorityDecisionEvidence; readonly evidenceDigest: string; settlement?: BootstrapAuthoritySettlement };

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

function evidenceOf(payload: Readonly<Record<string, unknown>>): { readonly domain: 'core-05'; readonly evidence: HumanDecisionEvidence } | { readonly domain: 'bootstrap-authority'; readonly evidence: BootstrapAuthorityDecisionEvidence } {
  const value = payload['evidence'];
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new HumanIdentityError('HUMAN_IDENTITY_STORE_CORRUPT', 'A decision row carries no evidence.');
  const e = value as Readonly<Record<string, unknown>>;
  const verdict = text(e, 'verdict');
  // FV-P4C-2B2C: a retired bootstrap format is never read, as its own domain or as CORE-05's.
  if (RETIRED_BOOTSTRAP_AUTHORITY_FORMATS.includes(text(e, 'format'))) throw new HumanIdentityError('HUMAN_IDENTITY_STORE_CORRUPT', 'A decision row is of a retired bootstrap-authority format.');
  // FV-P4C-2B2B: the evidence format fixes the domain, and the domain fixes the verdict vocabulary.
  if (text(e, 'format') === BOOTSTRAP_AUTHORITY_EVIDENCE_FORMAT) {
    if (verdict !== 'attest' && verdict !== 'approve') throw new HumanIdentityError('HUMAN_IDENTITY_STORE_CORRUPT', 'A bootstrap-authority decision row has an unknown role.');
    const subjectDigest = text(e, 'subjectDigest');
    const target = parseBootstrapAuthorityRequestId(text(e, 'approvalRequestId'));
    if (!SHA256.test(subjectDigest) || target === undefined || target.bindingDigest !== subjectDigest.slice('sha256:'.length)) {
      throw new HumanIdentityError('HUMAN_IDENTITY_STORE_CORRUPT', 'A bootstrap-authority decision row is not bound to its namespace and binding digest.');
    }
    return { domain: 'bootstrap-authority', evidence: { ...commonEvidenceOf(e), format: BOOTSTRAP_AUTHORITY_EVIDENCE_FORMAT, verdict } };
  }
  if (verdict !== 'approve' && verdict !== 'reject') throw new HumanIdentityError('HUMAN_IDENTITY_STORE_CORRUPT', 'A decision row has an unknown verdict.');
  return { domain: 'core-05', evidence: { ...commonEvidenceOf(e), format: text(e, 'format'), verdict } };
}

function commonEvidenceOf(e: Readonly<Record<string, unknown>>): Omit<HumanDecisionEvidence, 'format' | 'verdict'> {
  return {
    organizationId: text(e, 'organizationId'),
    operatorId: text(e, 'operatorId'),
    actorRef: text(e, 'actorRef'),
    credentialId: text(e, 'credentialId'),
    challengeCommitment: text(e, 'challengeCommitment'),
    assertionDigest: text(e, 'assertionDigest'),
    approvalRequestId: text(e, 'approvalRequestId'),
    subjectDigest: text(e, 'subjectDigest'),
    decidedAt: text(e, 'decidedAt'),
    rpId: text(e, 'rpId'),
    origin: text(e, 'origin'),
    userVerified: true,
    backedUp: e['backedUp'] === true,
  };
}

/** Aborts an append whose decision was settled, identically, by a concurrent call. Module-private: nothing else can throw it. */
const SETTLED_CONCURRENTLY: unique symbol = Symbol('settled-concurrently');

const SETTLEMENT_KEYS = {
  'bootstrap-committed': ['bindingDigest', 'bootstrapEvidenceDigest', 'bootstrapRequestId', 'counterpartCommitment', 'historyRevision', 'outcome', 'statusDigest', 'statusSequence'],
  'bootstrap-not-committed': ['bindingDigest', 'code', 'outcome'],
} as const;
const HEX64 = /^[0-9a-f]{64}$/;

/**
 * FV-P4C-2B2B: a bootstrap settlement, read exactly (closed keys, closed
 * codes, digests, safe integers), and only when it names the decision's own
 * binding digest. Anything else is `undefined`.
 */
function settlementOf(value: unknown, evidence: BootstrapAuthorityDecisionEvidence): BootstrapAuthoritySettlement | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const v = value as Readonly<Record<string, unknown>>;
  const outcome = v['outcome'];
  if (outcome !== 'bootstrap-committed' && outcome !== 'bootstrap-not-committed') return undefined;
  const keys = Object.keys(v).sort();
  if (keys.length !== SETTLEMENT_KEYS[outcome].length || keys.some((key, index) => key !== SETTLEMENT_KEYS[outcome][index])) return undefined;
  const bindingDigest = v['bindingDigest'];
  if (typeof bindingDigest !== 'string' || !HEX64.test(bindingDigest) || evidence.subjectDigest !== `sha256:${bindingDigest}`) return undefined;
  if (outcome === 'bootstrap-not-committed') {
    const code = v['code'];
    return typeof code === 'string' && (BOOTSTRAP_AUTHORITY_NOT_COMMITTED_CODES as readonly string[]).includes(code) ? { outcome, bindingDigest, code: code as BootstrapAuthorityNotCommittedCode } : undefined;
  }
  const { counterpartCommitment, bootstrapRequestId, bootstrapEvidenceDigest, historyRevision, statusSequence, statusDigest } = v;
  const positive = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 1;
  const natural = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
  if (typeof counterpartCommitment !== 'string' || !SHA256.test(counterpartCommitment) || counterpartCommitment === evidence.challengeCommitment) return undefined;
  if (typeof bootstrapRequestId !== 'string' || bootstrapRequestId.length === 0 || bootstrapRequestId.length > 512 || bootstrapRequestId.trim() !== bootstrapRequestId) return undefined;
  if (typeof bootstrapEvidenceDigest !== 'string' || !SHA256.test(bootstrapEvidenceDigest)) return undefined;
  if (!positive(historyRevision) || !natural(statusSequence) || typeof statusDigest !== 'string' || !HEX64.test(statusDigest)) return undefined;
  return { outcome, bindingDigest, counterpartCommitment, bootstrapRequestId, bootstrapEvidenceDigest, historyRevision, statusSequence, statusDigest };
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
        const decided = evidenceOf(payload);
        const evidence = decided.evidence;
        if (decisions.has(commitment) || evidence.challengeCommitment !== commitment || evidence.operatorId !== row.operatorId || !credentials.has(evidence.credentialId)) corrupt('A decision is inconsistent with the history.');
        const digest = decided.domain === 'bootstrap-authority' ? bootstrapAuthorityEvidenceDigest(decided.evidence) : humanDecisionEvidenceDigest(decided.evidence);
        if (digest !== text(payload, 'evidenceDigest')) corrupt('A decision row does not match its evidence digest.');
        decisions.set(commitment, decided.domain === 'bootstrap-authority' ? { domain: 'bootstrap-authority', evidence: decided.evidence, evidenceDigest: digest } : { domain: 'core-05', evidence: decided.evidence, evidenceDigest: digest });
        // The decision row also records the deciding credential's use.
        const deciding = credentials.get(evidence.credentialId) as CredentialRecord;
        deciding.view = { ...deciding.view, counter: count(payload, 'counter'), backedUp: payload['backedUp'] === true, lastUsedAt: row.recordedAt };
        break;
      }
      case 'decision_outcome': {
        const decision = decisions.get(row.objectId ?? '') ?? corrupt('A decision outcome names an unknown decision.');
        if (decision.domain === 'bootstrap-authority') {
          // FV-P4C-2B2B: only a bootstrap settlement settles a bootstrap-authority decision, once.
          if (decision.settlement !== undefined) corrupt('A decision has two outcomes.');
          decision.settlement = settlementOf(payload, decision.evidence) ?? corrupt('A bootstrap-authority settlement is malformed or names another binding.');
          break;
        }
        if (decision.outcome !== undefined) corrupt('A decision has two outcomes.');
        const outcome = text(payload, 'outcome');
        decision.outcome =
          outcome === 'recorded'
            ? { outcome: 'recorded', verdictRowDigest: text(payload, 'verdictRowDigest') }
            : outcome === 'refused'
              ? { outcome: 'refused', code: text(payload, 'code') }
              : outcome === 'abandoned'
                ? { outcome: 'abandoned' }
                : corrupt('A decision outcome is of an unknown kind.');
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

/**
 * FV-P4C-2B2B-F1 — the bootstrap settlement capability.
 *
 * An opaque, frozen token. Its authority is its identity: it is registered
 * in a module-private `WeakMap` against exactly one service instance, so an
 * object of the same shape, a token of another instance, or a revoked token
 * is refused. It is issued only to the caller of
 * `createHumanIdentityServiceWithBootstrapSettlement`, at construction, so a
 * subsystem that is merely handed the service never holds it. It is never
 * derived from a string, role, flag or commitment.
 *
 * What it does not do: it does not verify the bootstrap outcome. AUTH-03
 * cannot read the receiver's history. The holder is trusted to settle only
 * from evidence it read through a branded history handle (the FV
 * reconciler). That is an in-process trust assumption, not a cryptographic
 * guarantee.
 */
export interface BootstrapSettlementCapability {
  readonly capability: 'frontera.sovereign-status-bootstrap-settlement.v1';
  /**
   * Review fix: the capability is itself the settlement port. Its methods are bound, at issuance, to
   * the service it was issued for, and call it directly. A holder never has to hand the token to any
   * other object (which could keep it), and the reconciler never does.
   */
  unsettledBootstrapAuthorityDecisions(): readonly BootstrapAuthorityDecisionRecord[];
  recordBootstrapAuthoritySettlement(commitment: string, settlement: BootstrapAuthoritySettlement): Promise<'recorded' | 'unchanged'>;
}

const SETTLEMENT_CAPABILITIES = new WeakMap<object, { readonly instance: object; revoked: boolean }>();

/** Revokes a settlement capability for good. Idempotent; an unknown value is ignored. */
export function revokeBootstrapSettlementCapability(capability: unknown): void {
  const entry = typeof capability === 'object' && capability !== null ? SETTLEMENT_CAPABILITIES.get(capability) : undefined;
  if (entry !== undefined) entry.revoked = true;
}

export function createHumanIdentityService(options: HumanIdentityServiceOptions): HumanIdentityService {
  return constructHumanIdentityService(options).service;
}

/**
 * FV-P4C-2B2B-F1: the service, and the one settlement capability for it.
 * Meant for the Host's authority-construction boundary only (no Host source
 * calls it yet: B3; a structure test pins it).
 */
export function createHumanIdentityServiceWithBootstrapSettlement(options: HumanIdentityServiceOptions): { readonly service: HumanIdentityService; readonly settlementCapability: BootstrapSettlementCapability } {
  const { service, instance } = constructHumanIdentityService(options);
  // Captured from the frozen service before anyone else can see it.
  const record = service.recordBootstrapAuthoritySettlement.bind(service);
  const unsettled = service.unsettledBootstrapAuthorityDecisions.bind(service);
  const settlementCapability: BootstrapSettlementCapability = Object.freeze({
    capability: 'frontera.sovereign-status-bootstrap-settlement.v1' as const,
    unsettledBootstrapAuthorityDecisions: () => unsettled(),
    recordBootstrapAuthoritySettlement: (commitment: string, settlement: BootstrapAuthoritySettlement) => record(settlementCapability, commitment, settlement),
  });
  SETTLEMENT_CAPABILITIES.set(settlementCapability, { instance, revoked: false });
  SERVICE_INSTANCES.set(service, instance);
  return Object.freeze({ service, settlementCapability });
}

/** FV-P4C-2B3A: each issued service's instance identity, for the custody check below. Module-private. */
const SERVICE_INSTANCES = new WeakMap<object, object>();

/**
 * FV-P4C-2B3A — whether `capability` is the live (unrevoked) settlement capability issued together with
 * exactly this `service`. Exact: by the module-private instance, never by shape or by listing decisions.
 * A predicate only; it grants nothing.
 */
export function isBootstrapSettlementCapabilityOf(capability: unknown, service: unknown): boolean {
  const held = typeof capability === 'object' && capability !== null ? SETTLEMENT_CAPABILITIES.get(capability) : undefined;
  const instance = typeof service === 'object' && service !== null ? SERVICE_INSTANCES.get(service) : undefined;
  return held !== undefined && !held.revoked && instance !== undefined && held.instance === instance;
}

function constructHumanIdentityService(options: HumanIdentityServiceOptions): { readonly service: HumanIdentityService; readonly instance: object } {
  /** This instance's identity for its settlement capability. Never leaves this closure. */
  const instance = Object.freeze({});
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

  /**
   * FV-P4C-2B3C-2A2B — Host administrator authority never implies FV administrator authority. An FV identity store
   * (opened by its exclusive FV owner, or whose signed history begins with the FV administrator) refuses every
   * general administrative act, enrolment-token registration and owner revocation, before anything is signed and
   * again in each append's guard. FV principals are added only by the FV ceremonies' own AUTH-03 rules.
   */
  function notFvOwned(history: readonly StoredHumanIdentityRow[] = store.history()): void {
    if (store.exclusiveOwner || fvOwnedHistory(history)) throw new HumanIdentityError('HUMAN_IDENTITY_FV_ADMINISTRATION_REFUSED', 'This is an FV identity store: Host administration, enrolment tokens and owner revocation do not apply to it.');
  }

  /**
   * FV-P4C-2B3C-2A2B (fix-commit review F1) — every write of this service to an FV store is refused while an FV
   * operator plan is unfinished (a crash mid-enrolment), so that plan stays the history's suffix and its resume can
   * complete it; otherwise it would be stranded and every later enrolment blocked. Decided in the append's guard,
   * against the verified history. Fails closed until the enrolment is resumed.
   */
  const guardedAppend: HumanIdentityStore['append'] = (content, guard, consume) =>
    store.append(
      content,
      (history) => {
        if ((store.exclusiveOwner || fvOwnedHistory(history)) && fvOperatorPlanUnfinished(history)) {
          throw new HumanIdentityError('HUMAN_IDENTITY_FV_ENROLLMENT_PENDING', 'An FV operator enrolment is unfinished on this store: resume it before anything else is written.');
        }
        guard(history);
      },
      consume,
    );

  function administrator(value: IdentityAdministrator): IdentityAdministrator {
    notFvOwned();
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
    await guardedAppend(row('credential_counter_anomaly', credential.view.operatorId, credential.view.credentialId, { presented, stored: credential.view.counter, challengeDigest }, CEREMONY_RECORDER), (history) => void notUsed(challengeDigest)(history));
  };

  const FORMAT_OF = { 'core-05': HUMAN_DECISION_CHALLENGE_FORMAT, 'bootstrap-authority': BOOTSTRAP_AUTHORITY_CHALLENGE_FORMAT } as const;
  type ContractOf<D extends DecisionState['domain']> = D extends 'core-05' ? HumanDecisionChallengeContract : BootstrapAuthorityChallengeContract;

  /**
   * The decision challenge an assertion's client data names, in exactly one
   * domain, with its commitment recomputed from the stored contract under that
   * domain; one refusal for every failure. FV-P4C-2B2B: a challenge of the
   * other domain is refused here, so the CORE-05 methods never see a bootstrap
   * decision and the bootstrap methods never see a CORE-05 one.
   */
  function decisionChallengeOf<D extends DecisionState['domain']>(response: AuthenticationResponse, domain: D): { readonly stored: StoredDecisionChallenge; readonly contract: ContractOf<D>; readonly commitment: string } {
    const clientData = clientDataOf(response.response.clientDataJSON, 'webauthn.get', relyingParty);
    const stored = store.decisionChallenge(clientData.challenge);
    if (stored === undefined) throw challengeRefused();
    const commitment = stored.contract.format === FORMAT_OF[domain] ? decisionContractCommitment(stored.contract) : undefined;
    if (commitment === undefined || webAuthnChallengeOf(commitment) !== clientData.challenge || stored.contract.organizationId !== organizationId) {
      throw new HumanIdentityError('HUMAN_IDENTITY_CHALLENGE_INVALID', 'The decision challenge does not match its commitment.');
    }
    return { stored, contract: stored.contract as ContractOf<D>, commitment };
  }

  /** The stored contract of a commitment in one domain, only when it still recomputes to that commitment. */
  function storedContractOf<D extends DecisionState['domain']>(commitment: string, domain: D): ContractOf<D> | undefined {
    if (typeof commitment !== 'string' || !SHA256.test(commitment)) return undefined;
    const stored = store.decisionChallenge(webAuthnChallengeOf(commitment));
    if (stored === undefined || stored.contract.format !== FORMAT_OF[domain] || decisionContractCommitment(stored.contract) !== commitment) return undefined;
    return stored.contract as ContractOf<D>;
  }

  const decisionRecord = (current: IdentityState, contract: HumanDecisionChallengeContract, commitment: string): HumanDecisionRecord | undefined => {
    const decided = current.decisions.get(commitment);
    if (decided !== undefined) {
      if (decided.domain !== 'core-05') return undefined;
      return { contract, commitment, state: 'consumed', evidence: decided.evidence, evidenceDigest: decided.evidenceDigest, ...(decided.outcome !== undefined ? { outcome: decided.outcome } : {}) };
    }
    return { contract, commitment, state: contract.expiresAt <= iso() ? 'expired' : 'issued' };
  };

  const bootstrapRecord = (current: IdentityState, contract: BootstrapAuthorityChallengeContract, commitment: string): BootstrapAuthorityDecisionRecord | undefined => {
    const decided = current.decisions.get(commitment);
    if (decided !== undefined) {
      if (decided.domain !== 'bootstrap-authority') return undefined;
      return { contract, commitment, state: 'consumed', evidence: decided.evidence, evidenceDigest: decided.evidenceDigest, ...(decided.settlement !== undefined ? { settlement: decided.settlement } : {}) };
    }
    return { contract, commitment, state: contract.expiresAt <= iso() ? 'expired' : 'issued' };
  };

  /** Issues one decision challenge, in either domain, for an active human holding an active passkey. */
  function issue<C extends HumanDecisionChallengeContract | BootstrapAuthorityChallengeContract>(operatorId: unknown, build: (operatorId: string) => C): { readonly contract: C; readonly commitment: string; readonly options: AuthenticationOptionsJSON } {
    const current = state();
    activePrincipal(current, typeof operatorId === 'string' ? operatorId : '');
    const allow = activeCredentialsOf(current, operatorId as string);
    if (allow.length === 0) throw new HumanIdentityError('HUMAN_IDENTITY_CREDENTIAL_UNUSABLE', 'That human holds no active passkey.');
    const contract = build(operatorId as string);
    const commitment = decisionContractCommitment(contract) as string;
    const challenge = webAuthnChallengeOf(commitment);
    store.saveDecisionChallenge({ challenge, contract });
    return { contract, commitment, options: authenticationOptions(challenge, allow, decisionTtl) };
  }

  /**
   * Verifies an assertion against its decision challenge in one domain, then
   * consumes the challenge and records the decision evidence in one signed
   * append. Identical for both domains except the evidence format, verdict
   * vocabulary and evidence digest domain.
   */
  async function consume<D extends DecisionState['domain']>(raw: unknown, domain: D) {
    const response = parseAuthenticationResponse(raw);
    const { stored, contract, commitment } = decisionChallengeOf(response, domain);
    const challengeDigest = challengeDigestOf(stored.challenge);
    const before = state();
    if (before.decisions.has(commitment)) throw new HumanIdentityError('HUMAN_IDENTITY_DECISION_CHALLENGE_CONSUMED', 'This decision challenge was already used; read its outcome instead.');
    if (contract.expiresAt <= iso() || before.usedChallenges.has(challengeDigest)) throw challengeRefused();
    const known = before.credentials.get(response.id);
    const use = await verifiedUse(response, stored.challenge, contract.operatorId, known === undefined ? async () => undefined : anomaly(known, challengeDigest, signatureCounterOf(response.response.authenticatorData)));
    const decidedAt = iso();
    const common = {
      organizationId,
      operatorId: contract.operatorId,
      actorRef: use.principal.principal.actorRef,
      credentialId: use.credential.view.credentialId,
      challengeCommitment: commitment,
      assertionDigest: humanDecisionAssertionDigest({ credentialId: response.id, clientDataJSON: response.response.clientDataJSON, authenticatorData: response.response.authenticatorData, signature: response.response.signature }),
      approvalRequestId: contract.approvalRequestId,
      subjectDigest: contract.subjectDigest,
      decidedAt,
      rpId: relyingParty.rpId,
      origin: use.origin,
      userVerified: true as const,
      backedUp: use.backedUp,
    };
    let evidence: HumanDecisionEvidence | BootstrapAuthorityDecisionEvidence;
    let evidenceDigest: string;
    if (domain === 'bootstrap-authority') {
      const bootstrap: BootstrapAuthorityDecisionEvidence = { ...common, format: BOOTSTRAP_AUTHORITY_EVIDENCE_FORMAT, verdict: (contract as BootstrapAuthorityChallengeContract).verdict };
      evidence = bootstrap;
      evidenceDigest = bootstrapAuthorityEvidenceDigest(bootstrap);
    } else {
      const core05: HumanDecisionEvidence = { ...common, format: HUMAN_DECISION_EVIDENCE_FORMAT, verdict: (contract as HumanDecisionChallengeContract).verdict };
      evidence = core05;
      evidenceDigest = humanDecisionEvidenceDigest(core05);
    }
    await guardedAppend(
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
  }

  /** FV-P4C-2B2B: the checks a bootstrap settlement must pass against the verified history; throws a conflict otherwise. */
  function checkSettlement(current: IdentityState, commitment: string, settlement: BootstrapAuthoritySettlement): Extract<DecisionState, { domain: 'bootstrap-authority' }> {
    const conflict = (message: string): never => {
      throw new HumanIdentityError('HUMAN_IDENTITY_DECISION_SETTLEMENT_CONFLICT', message);
    };
    const decided = current.decisions.get(commitment);
    if (decided === undefined || decided.domain !== 'bootstrap-authority') throw new HumanIdentityError('HUMAN_IDENTITY_CHALLENGE_INVALID', 'No consumed bootstrap-authority decision exists for that commitment.');
    const read = settlementOf(settlement, decided.evidence);
    if (read === undefined) conflict('The settlement is malformed or names another binding than the decision.');
    if (read!.outcome === 'bootstrap-committed') {
      const counterpart = current.decisions.get(read!.counterpartCommitment);
      if (counterpart === undefined || counterpart.domain !== 'bootstrap-authority') conflict('The settlement names no consumed counterpart decision.');
      const other = counterpart as Extract<DecisionState, { domain: 'bootstrap-authority' }>;
      if (other.evidence.subjectDigest !== decided.evidence.subjectDigest || other.evidence.verdict === decided.evidence.verdict || other.evidence.operatorId === decided.evidence.operatorId) {
        conflict('The counterpart is not the other role of the same bootstrap, by another human.');
      }
      const theirs = other.settlement;
      if (theirs !== undefined && (theirs.outcome !== 'bootstrap-committed' || theirs.counterpartCommitment !== commitment || theirs.bootstrapEvidenceDigest !== read!.bootstrapEvidenceDigest || theirs.bootstrapRequestId !== read!.bootstrapRequestId)) {
        conflict("The settlement contradicts the counterpart's.");
      }
    }
    if (read!.outcome === 'bootstrap-not-committed') {
      // Review fix: never "not committed" for a decision a committed counterpart already names.
      for (const [other, entry] of current.decisions) {
        if (other !== commitment && entry.domain === 'bootstrap-authority' && entry.settlement?.outcome === 'bootstrap-committed' && entry.settlement.counterpartCommitment === commitment) {
          conflict("The settlement contradicts the counterpart's.");
        }
      }
    }
    if (decided.settlement !== undefined && canonicalJson({ ...decided.settlement }) !== canonicalJson({ ...read! })) conflict('A different settlement is already recorded for that decision.');
    return decided;
  }

  const service: HumanIdentityService = {
    organizationId,

    async createPrincipal(admin, input) {
      const actor = administrator(admin);
      const operatorId = input?.operatorId;
      if (typeof operatorId !== 'string' || !OPERATOR_ID.test(operatorId) || !operatorIds.has(operatorId)) throw new HumanIdentityError('HUMAN_IDENTITY_UNKNOWN_OPERATOR', "That operator id is not one of this Host's configured operators.");
      const displayName = input.displayName;
      if (typeof displayName !== 'string' || displayName.trim() !== displayName || displayName.length === 0 || displayName.length > 128) throw new HumanIdentityError('HUMAN_IDENTITY_CONFIGURATION_INVALID', 'displayName must be a non-empty trimmed string of at most 128 characters.');
      await guardedAppend(row('principal_created', operatorId, null, { displayName, userHandle: randomBytes(32).toString('base64url') }, actor.actorRef), (history) => {
        notFvOwned(history);
        if (project(history, organizationId).principals.has(operatorId)) throw new HumanIdentityError('HUMAN_IDENTITY_PRINCIPAL_EXISTS', 'A human principal already exists for that operator.');
      });
      return (state().principals.get(operatorId) as PrincipalState).principal;
    },

    async revokePrincipal(admin, operatorId, reason) {
      const actor = administrator(admin);
      const why = reasonOf(reason);
      await guardedAppend(row('principal_revoked', operatorId, null, { reason: why }, actor.actorRef), (history) => {
        notFvOwned(history);
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
      await guardedAppend(row('enrolment_authorized', operatorId, enrolmentId, { expiresAt, tokenVerifier: verifierOf(secret) }, actor.actorRef), (history) => {
        notFvOwned(history);
        const current = project(history, organizationId);
        activePrincipal(current, operatorId);
        // Decided against the verified history, so concurrent issuers cannot exceed it.
        const open = [...current.enrolments.values()].filter((record) => record.operatorId === operatorId && enrolmentState(record, iso()) === 'open').length;
        if (open >= OPEN_ENROLMENTS_MAX) throw new HumanIdentityError('HUMAN_IDENTITY_ENROLMENT_LIMIT', `That human already has ${String(OPEN_ENROLMENTS_MAX)} open enrolment invitations; revoke one before issuing another.`);
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
      await guardedAppend(row('enrolment_revoked', current.operatorId, enrolmentId, { reason: why }, actor.actorRef), (history) => {
        notFvOwned(history);
        const record = project(history, organizationId).enrolments.get(enrolmentId);
        if (record === undefined) throw new HumanIdentityError('HUMAN_IDENTITY_ENROLMENT_INVALID', 'No such enrolment.');
        if (record.revoked || record.consumed) throw new HumanIdentityError('HUMAN_IDENTITY_ALREADY_REVOKED', 'That enrolment is already revoked or consumed.');
      });
      return enrolmentView(state().enrolments.get(enrolmentId) as EnrolmentRecord);
    },

    beginRegistration(enrolmentToken) {
      const current = state();
      notFvOwned(store.history());
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
      notFvOwned();
      const enrolment = openEnrolment(state(), enrolmentToken);
      const response = parseRegistrationResponse(raw);
      const clientData = clientDataOf(response.response.clientDataJSON, 'webauthn.create', relyingParty);
      const challenge = storedChallenge(clientData.challenge, 'registration');
      if (challenge.enrolmentId !== enrolment.enrolmentId || challenge.operatorId !== enrolment.operatorId) {
        throw new HumanIdentityError('HUMAN_IDENTITY_CHALLENGE_INVALID', 'The ceremony challenge was issued for another enrolment.');
      }
      const verified = await verifyRegistration(response, challenge.challenge, relyingParty);
      const challengeDigest = challengeDigestOf(challenge.challenge);
      await guardedAppend(
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
          notFvOwned(history);
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
      await guardedAppend(
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
      await guardedAppend(row('credential_revoked', existing.view.operatorId, credentialId, { reason: why, revokedBy: 'administrator' }, actor.actorRef), (history) => {
        notFvOwned(history);
        const credential = project(history, organizationId).credentials.get(credentialId);
        if (credential === undefined) throw new HumanIdentityError('HUMAN_IDENTITY_CREDENTIAL_UNUSABLE', 'No such credential.');
        if (credential.view.state === 'revoked') throw new HumanIdentityError('HUMAN_IDENTITY_ALREADY_REVOKED', 'That credential is already revoked.');
      });
      return (state().credentials.get(credentialId) as CredentialRecord).view;
    },

    beginOwnerRevocation(credentialId) {
      // FV-P4C-2B3C-2A2B: revocation of an FV credential is B3C-2A3's, never this general path.
      notFvOwned();
      const current = state();
      const target = current.credentials.get(credentialId);
      if (target === undefined || target.view.state !== 'active') throw new HumanIdentityError('HUMAN_IDENTITY_CREDENTIAL_UNUSABLE', 'The credential is unknown or revoked.');
      activePrincipal(current, target.view.operatorId);
      const challenge = challengeFor('owner-revocation', { operatorId: target.view.operatorId, targetCredentialId: credentialId });
      return authenticationOptions(challenge.challenge, activeCredentialsOf(current, target.view.operatorId), challengeTtl);
    },

    async finishOwnerRevocation(credentialId, raw, reason) {
      notFvOwned();
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
      await guardedAppend(
        // One row (CORE-07 advances one position per append): the revocation also records the asserting credential's use.
        row('credential_revoked', target.view.operatorId, credentialId, { reason: why, revokedBy: 'owner', assertedWith: asserting, counter: use.counter, backedUp: use.backedUp, challengeDigest }, `owner:${asserting}`),
        (history) => {
          notFvOwned(history);
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
      return issue(operatorId, (id): HumanDecisionChallengeContract => ({
        format: HUMAN_DECISION_CHALLENGE_FORMAT,
        organizationId,
        approvalRequestId,
        subjectDigest,
        verdict,
        operatorId: id,
        nonce: randomBytes(32).toString('base64url'),
        issuedAt: iso(),
        expiresAt: after(decisionTtl),
      }));
    },

    peekDecision(raw) {
      const { contract, commitment } = decisionChallengeOf(parseAuthenticationResponse(raw), 'core-05');
      return { contract, commitment };
    },

    async authorizeDecision(raw) {
      const { contract, commitment, evidence, evidenceDigest } = await consume(raw, 'core-05');
      return { contract, commitment, evidence: evidence as HumanDecisionEvidence, evidenceDigest };
    },

    async recordDecisionOutcome(commitment, outcome) {
      const decided = state().decisions.get(commitment);
      // FV-P4C-2B2B: a CORE-05 outcome (recorded, refused, abandoned) never settles a bootstrap-authority decision.
      if (decided === undefined || decided.domain !== 'core-05') throw new HumanIdentityError('HUMAN_IDENTITY_CHALLENGE_INVALID', 'No authorized decision exists for that commitment.');
      const payload = outcome.outcome === 'recorded' ? { outcome: 'recorded', verdictRowDigest: outcome.verdictRowDigest } : outcome.outcome === 'refused' ? { outcome: 'refused', code: outcome.code } : { outcome: 'abandoned' };
      await guardedAppend(row('decision_outcome', decided.evidence.operatorId, commitment, payload, CEREMONY_RECORDER), (history) => {
        const current = project(history, organizationId).decisions.get(commitment);
        if (current === undefined || current.domain !== 'core-05') throw new HumanIdentityError('HUMAN_IDENTITY_CHALLENGE_INVALID', 'No authorized decision exists for that commitment.');
        if (current.outcome !== undefined) throw new HumanIdentityError('HUMAN_IDENTITY_ALREADY_REVOKED', 'That decision already has a recorded outcome.');
      });
    },

    decision(commitment) {
      const contract = storedContractOf(commitment, 'core-05');
      return contract === undefined ? undefined : decisionRecord(state(), contract, commitment);
    },

    unsettledDecisions() {
      const current = state();
      const unsettled: HumanDecisionRecord[] = [];
      for (const [commitment, decided] of current.decisions) {
        // FV-P4C-2B2B: only CORE-05 decisions are CORE-05 reconciliation's to settle; a bootstrap-authority decision is never listed here.
        if (decided.domain !== 'core-05' || decided.outcome !== undefined) continue;
        // A consumed decision whose issued contract is missing or altered is never reconciled here: it stays unsettled and unusable.
        const contract = storedContractOf(commitment, 'core-05');
        if (contract === undefined) continue;
        const record = decisionRecord(current, contract, commitment);
        if (record !== undefined) unsettled.push(record);
      }
      return unsettled;
    },

    beginBootstrapAuthorityDecision(input) {
      const { operatorId, namespace, bindingDigest, role } = input ?? ({} as Partial<typeof input>);
      if (typeof bindingDigest !== 'string' || !HEX64.test(bindingDigest)) throw new HumanIdentityError('HUMAN_IDENTITY_CHALLENGE_INVALID', 'A bootstrap-authority decision names one FV bootstrap binding digest (lowercase hex SHA-256).');
      if (role !== 'attest' && role !== 'approve') throw new HumanIdentityError('HUMAN_IDENTITY_CHALLENGE_INVALID', 'A bootstrap-authority role is attest or approve.');
      // FV-P4C-2B2C: the decision names the one history its bootstrap targets, inside the signed contract.
      let approvalRequestId: string;
      try {
        approvalRequestId = bootstrapAuthorityRequestId(namespace as string, bindingDigest);
      } catch {
        throw new HumanIdentityError('HUMAN_IDENTITY_CHALLENGE_INVALID', 'A bootstrap-authority decision names one status history namespace.');
      }
      return issue(operatorId, (id): BootstrapAuthorityChallengeContract => ({
        format: BOOTSTRAP_AUTHORITY_CHALLENGE_FORMAT,
        organizationId,
        approvalRequestId,
        subjectDigest: `sha256:${bindingDigest}`,
        verdict: role,
        operatorId: id,
        nonce: randomBytes(32).toString('base64url'),
        issuedAt: iso(),
        expiresAt: after(decisionTtl),
      }));
    },

    peekBootstrapAuthorityDecision(raw) {
      const { contract, commitment } = decisionChallengeOf(parseAuthenticationResponse(raw), 'bootstrap-authority');
      return { contract, commitment };
    },

    async authorizeBootstrapAuthorityDecision(raw) {
      const { contract, commitment, evidence, evidenceDigest } = await consume(raw, 'bootstrap-authority');
      return { contract, commitment, evidence: evidence as BootstrapAuthorityDecisionEvidence, evidenceDigest };
    },

    async recordBootstrapAuthoritySettlement(capability, commitment, settlement) {
      // F1: authority first, before any read or validation. Shape, strings and commitments grant nothing.
      const held = typeof capability === 'object' && capability !== null ? SETTLEMENT_CAPABILITIES.get(capability) : undefined;
      if (held === undefined || held.revoked || held.instance !== instance) {
        throw new HumanIdentityError('HUMAN_IDENTITY_DECISION_SETTLEMENT_UNAUTHORIZED', 'Recording a bootstrap settlement needs this service’s own live settlement capability.');
      }
      const decided = checkSettlement(state(), commitment, settlement);
      if (decided.settlement !== undefined) return 'unchanged';
      const read = settlementOf(settlement, decided.evidence) as BootstrapAuthoritySettlement;
      try {
        await guardedAppend(row('decision_outcome', decided.evidence.operatorId, commitment, { ...read }, CEREMONY_RECORDER), (history) => {
          const current = project(history, organizationId);
          const now = checkSettlement(current, commitment, read);
          // Settled meanwhile (identically, or checkSettlement would have refused): nothing to append.
          if (now.settlement !== undefined) throw SETTLED_CONCURRENTLY;
        });
      } catch (error) {
        if (error === SETTLED_CONCURRENTLY) return 'unchanged';
        throw error;
      }
      return 'recorded';
    },

    bootstrapAuthorityDecision(commitment) {
      const contract = storedContractOf(commitment, 'bootstrap-authority');
      return contract === undefined ? undefined : bootstrapRecord(state(), contract, commitment);
    },

    unsettledBootstrapAuthorityDecisions() {
      const current = state();
      const unsettled: BootstrapAuthorityDecisionRecord[] = [];
      for (const [commitment, decided] of current.decisions) {
        if (decided.domain !== 'bootstrap-authority' || decided.settlement !== undefined) continue;
        const contract = storedContractOf(commitment, 'bootstrap-authority');
        if (contract === undefined) continue;
        const record = bootstrapRecord(current, contract, commitment);
        if (record !== undefined) unsettled.push(record);
      }
      return unsettled;
    },

    principal: (operatorId) => state().principals.get(operatorId)?.principal,
    credentialsOf: (operatorId) => [...state().credentials.values()].filter((credential) => credential.view.operatorId === operatorId).map((credential) => credential.view),
    enrolment: (enrolmentId) => {
      const record = state().enrolments.get(enrolmentId);
      return record === undefined ? undefined : enrolmentView(record);
    },
    enrolmentsOf: (operatorId) => [...state().enrolments.values()].filter((record) => record.operatorId === operatorId).map(enrolmentView),
  };
  // Review fix: frozen, so no holder of the general service can replace a method and intercept a capability passed to it.
  return { service: Object.freeze(service), instance };
}

/** A read-only summary of AUTH-02's own projection (see {@link humanIdentityStateOf}). */
export interface HumanIdentityStateSummary {
  readonly principals: ReadonlyMap<string, { readonly state: 'active' | 'revoked'; readonly userHandle: string }>;
  readonly credentials: ReadonlyMap<string, { readonly operatorId: string; readonly publicKey: string; readonly state: 'active' | 'revoked'; readonly counter: number }>;
  readonly usedChallenges: ReadonlySet<string>;
}

/**
 * FV-P4C-2B3C-2A2B — AUTH-02's own projection of a verified history (principals, credentials, consumed challenges),
 * read-only, so the FV operator rows (`fv-operator.ts`) decide with exactly AUTH-02's semantics rather than a second
 * reading of the rows. Throws `HUMAN_IDENTITY_STORE_CORRUPT` on a history AUTH-02 itself would refuse.
 */
export function humanIdentityStateOf(history: readonly StoredHumanIdentityRow[], organizationId: string): HumanIdentityStateSummary {
  const current = project(history, organizationId);
  return Object.freeze({
    principals: new Map([...current.principals].map(([id, p]) => [id, Object.freeze({ state: p.principal.state, userHandle: p.userHandle })] as const)),
    credentials: new Map([...current.credentials].map(([id, c]) => [id, Object.freeze({ operatorId: c.view.operatorId, publicKey: c.publicKey, state: c.view.state, counter: c.view.counter })] as const)),
    usedChallenges: new Set(current.usedChallenges),
  });
}
