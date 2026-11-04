import { createHash, randomBytes } from 'node:crypto';

import { canonicalJson, humanIdentityGenesisDigest, nextHumanIdentityChainDigest, type HumanIdentityRowContent, type StoredHumanIdentityRow } from './chain.js';
import { HumanIdentityError, type AuthenticationOptionsJSON, type RegistrationOptionsJSON } from './contracts.js';
import { challengeDigestOf, webAuthnChallengeOf } from './decision-challenge.js';
import { FIRST_ADMINISTRATOR_ENROLMENT_EXPIRES_AT, firstAdministratorCredentialDigest, type FirstAdministratorCredential } from './first-administrator.js';
import { FV_OPERATOR_RECORDER, FV_OPERATOR_ROLE, fvOperatorPlanUnfinished, fvRolesOf } from './fv-domain.js';
import type { RelyingPartyConfiguration } from './relying-party.js';
import { humanIdentityStateOf } from './service.js';
import type { HumanIdentityStore } from './sqlite-human-identity-store.js';
import { SUPPORTED_COSE_ALGORITHMS, clientDataOf, parseAuthenticationResponse, parseRegistrationResponse, signatureCounterOf, verifyAssertion, verifyRegistration } from './webauthn.js';

/**
 * FV-P4C-2B3C-2A2B — enrolment of an **FV operator** under the authority of the store's FV administrator (AUTH-03
 * side). The FV operator-enrolment ceremony (in `sovereign-status-history/`) is the only caller (a structure test
 * pins it), but the authority is decided **here**, against the store's own signed, verified history, so that even a
 * caller holding the store cannot add an operator without an administrator's signature:
 *
 * - **The administrator** is the principal whose `fv-administrator` role the history proves (`fv-domain.ts`),
 *   active, using one of its own active credentials, at the authorization's **exact prior head**.
 * - **The authorization** is the administrator's WebAuthn assertion (user verified, pinned RP ID and origins) over a
 *   challenge derived from the commitment to one canonical contract: the organization, deployment, store, witness,
 *   prior head, administrator and credential, the candidate (operator id, display name, user handle, the digest of
 *   the credential it **already proved**, and that proof's challenge), the role `fv-operator`, the request id and a
 *   validity window of at most 300 s. The counter must advance past the stored one.
 * - **The candidate** proved possession first: its attestation answers a challenge derived from the request id and a
 *   fresh nonce. So the administrator approves exactly that credential; it cannot be swapped after approval.
 * - **Rows**, each signed, chained and witnessed by the store's ordinary `append`, only onto the exact prior head:
 *   `credential_used` (the administrator's credential, consuming its challenge: the authorization's single use, and
 *   the plan's digest, so the first new row pins everything after it), `principal_created` (`role: 'fv-operator'`),
 *   `enrolment_authorized` (born expired at the epoch, unusable as a token) and `credential_registered`.
 *
 * **The role is re-verifiable from the store alone.** The `credential_used` row keeps the signed contract and the
 * administrator's raw assertion, so `verifyFvOperatorRoles` re-checks, from the signed history only, that every
 * `fv-operator` row was authorized by the administrator's key (review M1).
 *
 * Re-verifying the same evidence later (a crash) appends only what is missing: with no row written yet it needs the
 * window still open and the head unchanged; with rows written, they must be exactly this plan's.
 */

export const FV_OPERATOR_AUTHORIZATION_FORMAT = 'frontera.fv-operator-enrollment-authorization.v1';
export const FV_OPERATOR_ENROLL_ACTION = 'frontera.fv-bootstrap-identity.enroll-operator';
export const FV_OPERATOR_AUTHORIZATION_MAX_LIFETIME_SECONDS = 300;
const CANDIDATE_CHALLENGE_DOMAIN = 'frontera:fv-operator-candidate-challenge:v1';
const OPERATOR_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const REQUEST_ID = /^fvop-[0-9a-f]{32}$/;
const ENROLMENT_ID = /^enr-[0-9a-f]{32}$/;
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const ROW_KINDS = ['credential_used', 'principal_created', 'enrolment_authorized', 'credential_registered'] as const;

/** What the administrator signs (through the WebAuthn challenge derived from its commitment). */
export interface FvOperatorAuthorization {
  readonly format: typeof FV_OPERATOR_AUTHORIZATION_FORMAT;
  readonly action: typeof FV_OPERATOR_ENROLL_ACTION;
  readonly requestId: string;
  readonly organizationId: string;
  readonly deploymentId: string;
  readonly stateKind: string;
  readonly storeId: string;
  readonly witnessId: string;
  readonly witnessKeyDigest: string;
  readonly priorHead: { readonly sequence: number; readonly chainDigest: string };
  readonly administrator: { readonly operatorId: string; readonly credentialId: string };
  readonly candidate: { readonly operatorId: string; readonly displayName: string; readonly userHandle: string; readonly credentialDigest: string; readonly attestationChallengeDigest: string };
  readonly role: typeof FV_OPERATOR_ROLE;
  /** The enrolment row's id and token verifier (the digest of a secret discarded at once): signed, never chosen later (review L1). */
  readonly enrolment: { readonly enrolmentId: string; readonly tokenVerifier: string };
  /** Also every new row's `recordedAt`: the time is signed too. */
  readonly notBefore: string;
  readonly notAfter: string;
}

/** The scope the caller's own trusted configuration fixes; an authorization for anything else is refused. */
export interface FvOperatorExpectation {
  readonly deploymentId: string;
  readonly stateKind: string;
  readonly witnessId: string;
  readonly witnessKeyDigest: string;
}

/** Everything an enrolment is made of. Recorded by the ceremony; re-verified, never trusted, on a resume. */
export interface FvOperatorEvidence {
  readonly authorization: FvOperatorAuthorization;
  readonly candidateNonce: string;
  readonly candidateAttestation: unknown;
  readonly administratorAssertion: unknown;
}

export type FvOperatorRefusal =
  | 'MALFORMED'
  | 'SCOPE_MISMATCH'
  | 'STALE_HEAD'
  | 'NOT_ADMINISTRATOR'
  | 'ADMINISTRATOR_CREDENTIAL_UNUSABLE'
  | 'ASSERTION_INVALID'
  | 'COUNTER_REGRESSION'
  | 'CANDIDATE_EXISTS'
  | 'CREDENTIAL_DUPLICATE'
  | 'ATTESTATION_INVALID'
  | 'CANDIDATE_MISMATCH'
  | 'WINDOW_CLOSED'
  | 'CHALLENGE_CONSUMED'
  /** Codex P2 (PR #267): the history ends in another enrolment's unfinished plan; that one is resumed first. */
  | 'PLAN_INCOMPLETE'
  | 'CONFLICT';

export type FvOperatorVerification =
  | { readonly verified: true; readonly rows: readonly Omit<HumanIdentityRowContent, 'organizationId'>[]; readonly progress: number; readonly credential: FirstAdministratorCredential; readonly planDigest: string }
  | { readonly verified: false; readonly reason: FvOperatorRefusal };

/** A refusal raised by `appendFvOperator`, carrying the reason. Nothing was written by the call that raised it. */
export class FvOperatorRefusedError extends HumanIdentityError {
  constructor(readonly reason: FvOperatorRefusal) {
    super('HUMAN_IDENTITY_FV_OPERATOR_REFUSED', `The FV operator enrolment was refused: ${reason}.`);
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const exactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean => Object.keys(value).sort().join() === [...keys].sort().join();
const iso = (value: unknown): value is string => typeof value === 'string' && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value;
const text = (value: unknown, max = 256): value is string => typeof value === 'string' && value.length > 0 && value.length <= max;

export function fvOperatorAuthorizationCommitment(authorization: FvOperatorAuthorization): string {
  return `sha256:${createHash('sha256').update(canonicalJson(authorization as unknown as Parameters<typeof canonicalJson>[0]), 'utf8').digest('hex')}`;
}

/** The candidate's WebAuthn challenge: `requestId` and `nonce` committed, nothing else chosen. */
export function fvOperatorCandidateChallenge(requestId: string, nonce: string): string {
  if (!REQUEST_ID.test(requestId) || !BASE64URL.test(nonce)) throw new HumanIdentityError('HUMAN_IDENTITY_CHALLENGE_INVALID', 'An FV operator challenge needs its request id and nonce.');
  return createHash('sha256').update(`${CANDIDATE_CHALLENGE_DOMAIN}\n${requestId}\n${nonce}`, 'utf8').digest('base64url');
}

/** The unfinished-plan rule (`fv-domain.ts`), re-exported for the operator ceremony. */
export { fvOperatorPlanUnfinished };

/** The chain digest at `sequence` of a verified history (the head the store had after its first `sequence` rows). */
export function chainDigestAt(history: readonly StoredHumanIdentityRow[], storeId: string, organizationId: string, sequence: number): string | undefined {
  if (!Number.isSafeInteger(sequence) || sequence < 0 || sequence > history.length) return undefined;
  let chain = humanIdentityGenesisDigest(storeId, organizationId);
  for (const row of history.slice(0, sequence)) chain = nextHumanIdentityChainDigest(chain, row.digest);
  return chain;
}

/** The candidate's creation options: a resident, user-verified credential for exactly the pinned relying party. Nothing is stored. */
export function fvOperatorCandidateOptions(input: { readonly relyingParty: RelyingPartyConfiguration; readonly requestId: string; readonly operatorId: string; readonly displayName: string; readonly timeoutSeconds: number; readonly excludeCredentialIds: readonly string[] }): { readonly options: RegistrationOptionsJSON; readonly nonce: string; readonly userHandle: string } {
  const nonce = randomBytes(32).toString('base64url');
  const userHandle = randomBytes(32).toString('base64url');
  const options: RegistrationOptionsJSON = {
    rp: { id: input.relyingParty.rpId, name: input.relyingParty.rpName },
    user: { id: userHandle, name: input.operatorId, displayName: input.displayName },
    challenge: fvOperatorCandidateChallenge(input.requestId, nonce),
    pubKeyCredParams: SUPPORTED_COSE_ALGORITHMS.map((alg) => ({ type: 'public-key' as const, alg })),
    timeout: input.timeoutSeconds * 1000,
    attestation: 'none',
    excludeCredentials: input.excludeCredentialIds.map((id) => ({ type: 'public-key' as const, id })),
    authenticatorSelection: { residentKey: 'required', requireResidentKey: true, userVerification: 'required' },
  };
  return Object.freeze({ nonce, userHandle, options });
}

/** Verifies the candidate's attestation against the challenge of exactly this request (as AUTH-02 verifies an ordinary registration). */
export async function verifyFvOperatorCandidate(input: { readonly relyingParty: RelyingPartyConfiguration; readonly requestId: string; readonly nonce: string; readonly response: unknown }): Promise<FirstAdministratorCredential> {
  const expected = fvOperatorCandidateChallenge(input.requestId, input.nonce);
  const response = parseRegistrationResponse(input.response);
  const clientData = clientDataOf(response.response.clientDataJSON, 'webauthn.create', input.relyingParty);
  if (clientData.challenge !== expected) throw new HumanIdentityError('HUMAN_IDENTITY_CHALLENGE_INVALID', 'The attestation answers another challenge than this request’s.');
  const verified = await verifyRegistration(response, expected, input.relyingParty);
  if (verified.credentialId.length > 1_024 || verified.publicKey.length > 4_096) throw new HumanIdentityError('HUMAN_IDENTITY_REGISTRATION_INVALID', 'The credential is larger than an FV operator plan holds.');
  return Object.freeze({
    credentialId: verified.credentialId,
    publicKey: verified.publicKey,
    counter: verified.counter,
    deviceType: verified.deviceType,
    backedUp: verified.backedUp,
    transports: Object.freeze([...(response.response.transports ?? [])].filter((entry) => typeof entry === 'string' && entry.length > 0 && entry.length <= 64).slice(0, 16)),
    attestationFormat: verified.attestationFormat,
    aaguid: verified.aaguid,
    rpId: input.relyingParty.rpId,
    origin: verified.origin,
    challengeDigest: challengeDigestOf(expected),
  });
}

/** The administrator's request options: an assertion by one of its own credentials over this authorization's commitment, user verified. */
export function fvOperatorAdministratorOptions(input: { readonly relyingParty: RelyingPartyConfiguration; readonly authorization: FvOperatorAuthorization; readonly timeoutSeconds: number }): AuthenticationOptionsJSON {
  return {
    rpId: input.relyingParty.rpId,
    challenge: webAuthnChallengeOf(fvOperatorAuthorizationCommitment(input.authorization)),
    timeout: input.timeoutSeconds * 1000,
    userVerification: 'required',
    allowCredentials: [{ type: 'public-key' as const, id: input.authorization.administrator.credentialId }],
  };
}

/** Strictly re-reads an authorization (for example from a record). `undefined` when anything is missing, extra or malformed. */
export function fvOperatorAuthorizationOf(value: unknown): FvOperatorAuthorization | undefined {
  if (!isRecord(value) || !exactKeys(value, ['format', 'action', 'requestId', 'organizationId', 'deploymentId', 'stateKind', 'storeId', 'witnessId', 'witnessKeyDigest', 'priorHead', 'administrator', 'candidate', 'role', 'enrolment', 'notBefore', 'notAfter'])) return undefined;
  const { priorHead, administrator, candidate, enrolment } = value;
  if (!isRecord(enrolment) || !exactKeys(enrolment, ['enrolmentId', 'tokenVerifier']) || !text(enrolment['enrolmentId'], 64) || !ENROLMENT_ID.test(enrolment['enrolmentId']) || typeof enrolment['tokenVerifier'] !== 'string' || !/^[0-9a-f]{64}$/.test(enrolment['tokenVerifier'])) return undefined;
  if (value['format'] !== FV_OPERATOR_AUTHORIZATION_FORMAT || value['action'] !== FV_OPERATOR_ENROLL_ACTION || value['role'] !== FV_OPERATOR_ROLE) return undefined;
  if (!text(value['requestId']) || !REQUEST_ID.test(value['requestId']) || ![value['organizationId'], value['deploymentId'], value['stateKind'], value['storeId'], value['witnessId']].every((v) => text(v)) || !text(value['witnessKeyDigest']) || !SHA256.test(value['witnessKeyDigest'])) return undefined;
  if (!iso(value['notBefore']) || !iso(value['notAfter'])) return undefined;
  if (!isRecord(priorHead) || !exactKeys(priorHead, ['sequence', 'chainDigest']) || !Number.isSafeInteger(priorHead['sequence']) || (priorHead['sequence'] as number) < 1 || !text(priorHead['chainDigest']) || !SHA256.test(priorHead['chainDigest'])) return undefined;
  if (!isRecord(administrator) || !exactKeys(administrator, ['operatorId', 'credentialId']) || !text(administrator['operatorId']) || !OPERATOR_ID.test(administrator['operatorId']) || !text(administrator['credentialId'], 1_024) || !BASE64URL.test(administrator['credentialId'])) return undefined;
  if (!isRecord(candidate) || !exactKeys(candidate, ['operatorId', 'displayName', 'userHandle', 'credentialDigest', 'attestationChallengeDigest'])) return undefined;
  const displayName = candidate['displayName'];
  if (!text(candidate['operatorId']) || !OPERATOR_ID.test(candidate['operatorId']) || typeof displayName !== 'string' || displayName.trim() !== displayName || displayName.length === 0 || displayName.length > 128) return undefined;
  if (!text(candidate['userHandle'], 128) || !BASE64URL.test(candidate['userHandle']) || !text(candidate['credentialDigest']) || !SHA256.test(candidate['credentialDigest']) || !text(candidate['attestationChallengeDigest']) || !SHA256.test(candidate['attestationChallengeDigest'])) return undefined;
  return value as unknown as FvOperatorAuthorization;
}

/**
 * Verifies an enrolment's evidence against the store's verified `history`, without writing: the authorization's
 * scope and window, the prior head, the administrator's role, credential, assertion and counter, the candidate's
 * attestation, and how far the history already is along the resulting rows. `now` is the caller's clock.
 */
export async function verifyFvOperatorEvidence(
  history: readonly StoredHumanIdentityRow[],
  store: Pick<HumanIdentityStore, 'organizationId' | 'storeId'>,
  evidence: FvOperatorEvidence,
  context: { readonly relyingParty: RelyingPartyConfiguration; readonly expected: FvOperatorExpectation; readonly now: Date },
): Promise<FvOperatorVerification> {
  const no = (reason: FvOperatorRefusal): FvOperatorVerification => Object.freeze({ verified: false as const, reason });
  if (!isRecord(evidence)) return no('MALFORMED');
  const authorization = fvOperatorAuthorizationOf(evidence.authorization);
  if (authorization === undefined || !text(evidence.candidateNonce, 128) || !BASE64URL.test(evidence.candidateNonce)) return no('MALFORMED');
  const { expected } = context;
  if (
    authorization.organizationId !== store.organizationId ||
    authorization.storeId !== store.storeId ||
    authorization.deploymentId !== expected.deploymentId ||
    authorization.stateKind !== expected.stateKind ||
    authorization.witnessId !== expected.witnessId ||
    authorization.witnessKeyDigest !== expected.witnessKeyDigest
  ) {
    return no('SCOPE_MISMATCH');
  }
  const lifetime = Date.parse(authorization.notAfter) - Date.parse(authorization.notBefore);
  if (lifetime <= 0 || lifetime > FV_OPERATOR_AUTHORIZATION_MAX_LIFETIME_SECONDS * 1000) return no('MALFORMED');

  // The exact prior head, recomputed from the verified history: the authorization is valid only there.
  const { sequence } = authorization.priorHead;
  if (chainDigestAt(history, store.storeId, store.organizationId, sequence) !== authorization.priorHead.chainDigest) return no('STALE_HEAD');
  const prior = history.slice(0, sequence);
  if (fvOperatorPlanUnfinished(prior)) return no('PLAN_INCOMPLETE');
  let state: ReturnType<typeof humanIdentityStateOf>;
  try {
    state = humanIdentityStateOf(prior, store.organizationId);
  } catch {
    return no('MALFORMED');
  }
  const administrator = authorization.administrator;
  if (fvRolesOf(prior).get(administrator.operatorId) !== 'fv-administrator' || state.principals.get(administrator.operatorId)?.state !== 'active') return no('NOT_ADMINISTRATOR');
  const adminCredential = state.credentials.get(administrator.credentialId);
  if (adminCredential === undefined || adminCredential.operatorId !== administrator.operatorId || adminCredential.state !== 'active') return no('ADMINISTRATOR_CREDENTIAL_UNUSABLE');
  if (state.principals.has(authorization.candidate.operatorId)) return no('CANDIDATE_EXISTS');

  // The administrator's assertion over this authorization's commitment, by that credential, user verified; its counter advances.
  const commitment = fvOperatorAuthorizationCommitment(authorization);
  const adminChallenge = webAuthnChallengeOf(commitment);
  let adminUse: { readonly counter: number; readonly backedUp: boolean };
  let assertion: { readonly clientDataJSON: string; readonly authenticatorData: string; readonly signature: string };
  try {
    const response = parseAuthenticationResponse(evidence.administratorAssertion);
    assertion = { clientDataJSON: response.response.clientDataJSON, authenticatorData: response.response.authenticatorData, signature: response.response.signature };
    if (response.id !== administrator.credentialId) return no('ASSERTION_INVALID');
    const clientData = clientDataOf(response.response.clientDataJSON, 'webauthn.get', context.relyingParty);
    if (clientData.challenge !== adminChallenge) return no('ASSERTION_INVALID');
    const userHandle = state.principals.get(administrator.operatorId)?.userHandle;
    if (response.response.userHandle !== undefined && response.response.userHandle !== userHandle) return no('ASSERTION_INVALID');
    const verified = await verifyAssertion(response, adminChallenge, { credentialId: administrator.credentialId, publicKey: adminCredential.publicKey }, context.relyingParty);
    const counter = signatureCounterOf(response.response.authenticatorData);
    if (counter !== verified.counter) return no('ASSERTION_INVALID');
    if ((counter > 0 || adminCredential.counter > 0) && counter <= adminCredential.counter) return no('COUNTER_REGRESSION');
    adminUse = Object.freeze({ counter, backedUp: verified.backedUp });
  } catch {
    return no('ASSERTION_INVALID');
  }

  // The candidate's attestation, against this request's challenge: exactly the credential the administrator approved.
  let credential: FirstAdministratorCredential;
  try {
    credential = await verifyFvOperatorCandidate({ relyingParty: context.relyingParty, requestId: authorization.requestId, nonce: evidence.candidateNonce, response: evidence.candidateAttestation });
  } catch {
    return no('ATTESTATION_INVALID');
  }
  if (firstAdministratorCredentialDigest(credential) !== authorization.candidate.credentialDigest || credential.challengeDigest !== authorization.candidate.attestationChallengeDigest) return no('CANDIDATE_MISMATCH');
  if (state.credentials.has(credential.credentialId)) return no('CREDENTIAL_DUPLICATE');
  const adminChallengeDigest = challengeDigestOf(adminChallenge);
  if (state.usedChallenges.has(adminChallengeDigest) || state.usedChallenges.has(credential.challengeDigest)) return no('CHALLENGE_CONSUMED');

  const plan = {
    authorizationCommitment: commitment,
    administratorUse: { counter: adminUse.counter, backedUp: adminUse.backedUp },
    credential: { ...credential, transports: [...credential.transports] },
  };
  const planDigest = `sha256:${createHash('sha256').update(canonicalJson(plan), 'utf8').digest('hex')}`;
  const { candidate } = authorization;
  const recordedBy = FV_OPERATOR_RECORDER;
  const recordedAt = authorization.notBefore;
  const { enrolmentId, tokenVerifier } = authorization.enrolment;
  const rows = Object.freeze([
    // The authorization's single use: the administrator's credential use, consuming its challenge, pinning the plan.
    { kind: 'credential_used' as const, operatorId: administrator.operatorId, objectId: administrator.credentialId, payload: canonicalJson({ counter: adminUse.counter, backedUp: adminUse.backedUp, challengeDigest: adminChallengeDigest, authorizationCommitment: commitment, planDigest, authorization: authorization as unknown as Parameters<typeof canonicalJson>[0], assertion }), recordedBy, recordedAt },
    { kind: 'principal_created' as const, operatorId: candidate.operatorId, objectId: null, payload: canonicalJson({ displayName: candidate.displayName, userHandle: candidate.userHandle, role: FV_OPERATOR_ROLE, authorizationCommitment: commitment, authorizedBy: administrator.operatorId }), recordedBy, recordedAt },
    { kind: 'enrolment_authorized' as const, operatorId: candidate.operatorId, objectId: enrolmentId, payload: canonicalJson({ expiresAt: FIRST_ADMINISTRATOR_ENROLMENT_EXPIRES_AT, tokenVerifier }), recordedBy, recordedAt },
    {
      kind: 'credential_registered' as const,
      operatorId: candidate.operatorId,
      objectId: credential.credentialId,
      payload: canonicalJson({ enrolmentId, publicKey: credential.publicKey, counter: credential.counter, deviceType: credential.deviceType, backedUp: credential.backedUp, transports: [...credential.transports], attestationFormat: credential.attestationFormat, aaguid: credential.aaguid, rpId: credential.rpId, origin: credential.origin, challengeDigest: credential.challengeDigest }),
      recordedBy,
      recordedAt,
    },
  ]);

  const progress = progressOf(history, sequence, rows);
  if (progress === undefined) return no(history.length > sequence ? 'STALE_HEAD' : 'CONFLICT');
  // Nothing written yet: the authorization must still be in its window (a written first row is its consumption, in time).
  if (progress === 0) {
    const now = context.now.getTime();
    if (now < Date.parse(authorization.notBefore) || now > Date.parse(authorization.notAfter)) return no('WINDOW_CLOSED');
  }
  return Object.freeze({ verified: true as const, rows, progress, credential, planDigest });
}

const sameRow = (stored: StoredHumanIdentityRow, row: Omit<HumanIdentityRowContent, 'organizationId'>): boolean =>
  stored.kind === row.kind && stored.operatorId === row.operatorId && stored.objectId === row.objectId && stored.payload === row.payload && stored.recordedBy === row.recordedBy && stored.recordedAt === row.recordedAt;

/** How many of `rows` follow the prior head exactly; `undefined` when anything else follows it. */
function progressOf(history: readonly StoredHumanIdentityRow[], sequence: number, rows: readonly Omit<HumanIdentityRowContent, 'organizationId'>[]): number | undefined {
  const after = history.slice(sequence);
  if (after.length > rows.length) return undefined;
  for (const [index, stored] of after.entries()) if (!sameRow(stored, rows[index]!)) return undefined;
  return after.length;
}

/**
 * Verifies the evidence (`verifyFvOperatorEvidence`) and appends whatever of its rows the store does not hold yet,
 * one witnessed row at a time. Each guard re-decides against the verified history that the prior head is unchanged
 * and the rows after it are exactly this plan's earlier rows. Throws `FvOperatorRefusedError` (nothing written by
 * this call) or whatever the store throws when a write fails (a lost witness answer leaves CORE-07 pending recovery).
 */
export async function appendFvOperator(
  store: HumanIdentityStore,
  evidence: FvOperatorEvidence,
  context: { readonly relyingParty: RelyingPartyConfiguration; readonly expected: FvOperatorExpectation; readonly now: Date },
  afterRow?: (kind: (typeof ROW_KINDS)[number]) => void,
): Promise<{ readonly credential: FirstAdministratorCredential; readonly planDigest: string }> {
  const verification = await verifyFvOperatorEvidence(store.history(), store, evidence, context);
  if (!verification.verified) throw new FvOperatorRefusedError(verification.reason);
  const { rows, progress } = verification;
  const { sequence, chainDigest } = evidence.authorization.priorHead;
  for (let index = progress; index < rows.length; index += 1) {
    await store.append(rows[index]!, (history) => {
      if (history.length !== sequence + index || chainDigestAt(history, store.storeId, store.organizationId, sequence) !== chainDigest || progressOf(history, sequence, rows) !== index) throw new FvOperatorRefusedError('CONFLICT');
    });
    try {
      afterRow?.(ROW_KINDS[index]!);
    } catch {
      // Diagnostics only.
    }
  }
  return Object.freeze({ credential: verification.credential, planDigest: verification.planDigest });
}

/** How far a verified history is along an already-verified plan's rows (for a readback): 0–4, or `undefined`. */
export function fvOperatorProgress(history: readonly StoredHumanIdentityRow[], priorSequence: number, rows: readonly Omit<HumanIdentityRowContent, 'organizationId'>[]): number | undefined {
  return progressOf(history, priorSequence, rows);
}

/**
 * FV-P4C-2B3C-2A2B (review M1) — re-verifies, from the signed history alone, every principal `fvRolesOf` calls an
 * `fv-operator`: the authorizing `credential_used` row's stored contract recomputes to its commitment, names exactly
 * this principal and organization, was made at exactly that row's position (its prior head and chain digest), names
 * the credential registered right after, and its stored assertion verifies — by the administrator's credential as it was at that point of the
 * history, user verified, pinned RP ID and origins — over that commitment's challenge. A row a holder of the store's
 * signing key appended without an administrator credential's signature fails here. It proves "authorized by a
 * credential the signed history attributes to the administrator", no more: the store's signing key (the deployment's
 * authority key, CORE-02) is itself a trust root, and its holder could also append such a credential. Returns the
 * operators that verify. Anything that trusts the operator role must use this, never `fvRolesOf` alone.
 */
export async function verifyFvOperatorRoles(history: readonly StoredHumanIdentityRow[], organizationId: string, relyingParty: RelyingPartyConfiguration): Promise<ReadonlySet<string>> {
  const verified = new Set<string>();
  for (const [operatorId, role] of fvRolesOf(history)) {
    if (role !== FV_OPERATOR_ROLE) continue;
    const index = history.findIndex((row) => row.kind === 'principal_created' && row.operatorId === operatorId);
    const used = history[index - 1];
    if (index < 1 || used === undefined) continue;
    try {
      const payload = JSON.parse(used.payload) as { authorization?: unknown; assertion?: { clientDataJSON?: unknown; authenticatorData?: unknown; signature?: unknown }; authorizationCommitment?: unknown };
      const authorization = fvOperatorAuthorizationOf(payload.authorization);
      if (authorization === undefined || fvOperatorAuthorizationCommitment(authorization) !== payload.authorizationCommitment || authorization.candidate.operatorId !== operatorId || authorization.administrator.credentialId !== used.objectId) continue;
      // Publication review F1: the context AUTH-03 enforced, not only the signature. The approval was made at exactly the
      // position its authorizing row holds (prior head and chain digest, which also binds the store id), for this
      // organization, and the credential registered right after is the one the administrator approved.
      if (authorization.organizationId !== organizationId || authorization.priorHead.sequence !== index - 1 || chainDigestAt(history, authorization.storeId, organizationId, index - 1) !== authorization.priorHead.chainDigest) continue;
      const registered = history[index + 2];
      if (registered?.kind !== 'credential_registered' || registered.operatorId !== operatorId || registered.objectId === null) continue;
      const registeredKey = (JSON.parse(registered.payload) as { publicKey?: unknown }).publicKey;
      if (typeof registeredKey !== 'string' || firstAdministratorCredentialDigest({ credentialId: registered.objectId, publicKey: registeredKey }) !== authorization.candidate.credentialDigest) continue;
      const prior = humanIdentityStateOf(history.slice(0, index - 1), organizationId);
      const credential = prior.credentials.get(authorization.administrator.credentialId);
      if (credential === undefined || credential.operatorId !== authorization.administrator.operatorId || credential.state !== 'active') continue;
      const assertion = payload.assertion ?? {};
      const response = parseAuthenticationResponse({ id: used.objectId, rawId: used.objectId, type: 'public-key', response: { clientDataJSON: assertion.clientDataJSON, authenticatorData: assertion.authenticatorData, signature: assertion.signature } });
      await verifyAssertion(response, webAuthnChallengeOf(fvOperatorAuthorizationCommitment(authorization)), { credentialId: used.objectId ?? '', publicKey: credential.publicKey }, relyingParty);
      verified.add(operatorId);
    } catch {
      continue;
    }
  }
  return verified;
}
