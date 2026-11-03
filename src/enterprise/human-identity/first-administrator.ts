import { createHash, randomBytes } from 'node:crypto';

import { canonicalJson, type HumanIdentityRowContent, type StoredHumanIdentityRow } from './chain.js';
import { HumanIdentityError, type RegistrationOptionsJSON } from './contracts.js';
import { challengeDigestOf } from './decision-challenge.js';
import type { RelyingPartyConfiguration } from './relying-party.js';
import type { HumanIdentityStore } from './sqlite-human-identity-store.js';
import { SUPPORTED_COSE_ALGORITHMS, clientDataOf, parseRegistrationResponse, verifyRegistration } from './webauthn.js';

/**
 * FV-P4C-2B3C-2A2A — the **first administrator** of an FV bootstrap identity store (AUTH-03 side).
 *
 * The FV first-administrator ceremony (in `sovereign-status-history/`) is the only caller (a structure test
 * pins it). It decides the authority: a G-02A capability from the
 * registration issuer, verified and consumed there. This module only:
 *
 * - issues the WebAuthn creation options for the candidate, with a challenge **derived from** the consumed
 *   capability's id and a fresh nonce (so an attestation answers this one authorization, and can be
 *   re-verified from the record after a crash);
 * - verifies the candidate's attestation exactly as AUTH-02 verifies an ordinary passkey registration (pinned RP ID and
 *   origins, user presence **and** verification, supported algorithms, importable key);
 * - appends the three rows AUTH-02's projection already understands — `principal_created` (with
 *   `role: 'fv-administrator'` and the authorizing capability), `enrolment_authorized` (born expired, its
 *   token verifier the digest of a secret nobody holds: it can never be presented) and
 *   `credential_registered` (which consumes that enrolment) — each one signed, chained and witnessed by the
 *   store's ordinary `append`.
 *
 * **The store pins the plan.** The first row commits a digest of the whole plan (credential, enrolment id,
 * token verifier, time, authorization), and every later row must be this plan's: so once the first row is
 * signed and witnessed, nothing outside the store — in particular a rewritten ceremony record — can change
 * what the remaining rows say.
 *
 * **Only into an empty store, only once.** Each append's guard, decided against the verified history before
 * anything is signed or prepared, admits the row only when the history is exactly the earlier rows of this
 * same plan. So the first row needs a store that holds no row at all (no principal, no credential, no
 * decision); a store that holds anything else — another administrator, the Host's humans, a decision — is
 * refused (`HUMAN_IDENTITY_FIRST_ADMINISTRATOR_CONFLICT`) and nothing is written. A plan replayed after it
 * completed adds nothing. No operator-plane administrator, invitation token or stored ceremony challenge is
 * involved: nothing a Host operator holds reaches this path.
 */

export const FV_ADMINISTRATOR_ROLE = 'fv-administrator';
export const FV_FIRST_ADMINISTRATOR_RECORDER = 'fv-first-administrator-ceremony';
const CHALLENGE_DOMAIN = 'frontera:fv-first-administrator-challenge:v1';
const OPERATOR_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const ENROLMENT_ID = /^enr-[0-9a-f]{32}$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const ROW_KINDS = ['principal_created', 'enrolment_authorized', 'credential_registered'] as const;

/** The credential a verified attestation proved: exactly the fields AUTH-02 records for a registration. */
export interface FirstAdministratorCredential {
  readonly credentialId: string;
  readonly publicKey: string;
  readonly counter: number;
  readonly deviceType: 'singleDevice' | 'multiDevice';
  readonly backedUp: boolean;
  readonly transports: readonly string[];
  readonly attestationFormat: string;
  readonly aaguid: string;
  readonly rpId: string;
  readonly origin: string;
  readonly challengeDigest: string;
}

/** Everything the three rows are made of. Deterministic: the same plan always yields the same rows. */
export interface FirstAdministratorPlan {
  readonly operatorId: string;
  readonly displayName: string;
  readonly userHandle: string;
  readonly enrolmentId: string;
  readonly tokenVerifier: string;
  readonly recordedAt: string;
  /** The G-02A capability that authorized this administrator: recorded in the signed principal row. */
  readonly authorization: { readonly capabilityId: string; readonly issuer: string };
  readonly credential: FirstAdministratorCredential;
}

/** The WebAuthn challenge for one authorization: `capabilityId` and `nonce` committed, nothing else chosen. */
export function firstAdministratorChallenge(capabilityId: string, nonce: string): string {
  if (typeof capabilityId !== 'string' || capabilityId.length === 0 || typeof nonce !== 'string' || !BASE64URL.test(nonce)) refuse('HUMAN_IDENTITY_CHALLENGE_INVALID', 'A first-administrator challenge needs its capability id and nonce.');
  return createHash('sha256').update(`${CHALLENGE_DOMAIN}\n${capabilityId}\n${nonce}`, 'utf8').digest('base64url');
}

/** sha256 over the credential id and public key: what an issuer names when it authorizes completing exactly this credential. */
export function firstAdministratorCredentialDigest(credential: Pick<FirstAdministratorCredential, 'credentialId' | 'publicKey'>): string {
  return `sha256:${createHash('sha256').update(canonicalJson({ credentialId: credential.credentialId, publicKey: credential.publicKey }), 'utf8').digest('hex')}`;
}

function refuse(code: 'HUMAN_IDENTITY_CHALLENGE_INVALID' | 'HUMAN_IDENTITY_REGISTRATION_INVALID' | 'HUMAN_IDENTITY_CONFIGURATION_INVALID' | 'HUMAN_IDENTITY_FIRST_ADMINISTRATOR_CONFLICT', message: string): never {
  throw new HumanIdentityError(code, message);
}

function candidateOf(operatorId: unknown, displayName: unknown): { readonly operatorId: string; readonly displayName: string } {
  if (typeof operatorId !== 'string' || !OPERATOR_ID.test(operatorId)) refuse('HUMAN_IDENTITY_CONFIGURATION_INVALID', 'The first administrator needs a well-formed operator id.');
  if (typeof displayName !== 'string' || displayName.trim() !== displayName || displayName.length === 0 || displayName.length > 128) refuse('HUMAN_IDENTITY_CONFIGURATION_INVALID', 'displayName must be a non-empty trimmed string of at most 128 characters.');
  return { operatorId, displayName };
}

/**
 * The candidate's WebAuthn creation options: a resident, user-verified credential for exactly the pinned
 * relying party, under a fresh user handle. Nothing is stored; the caller keeps `nonce` and `userHandle`.
 */
export function firstAdministratorRegistrationOptions(input: { readonly relyingParty: RelyingPartyConfiguration; readonly operatorId: string; readonly displayName: string; readonly capabilityId: string; readonly timeoutSeconds: number }): { readonly options: RegistrationOptionsJSON; readonly nonce: string; readonly userHandle: string } {
  const { operatorId, displayName } = candidateOf(input?.operatorId, input?.displayName);
  const nonce = randomBytes(32).toString('base64url');
  const userHandle = randomBytes(32).toString('base64url');
  const options: RegistrationOptionsJSON = {
      rp: { id: input.relyingParty.rpId, name: input.relyingParty.rpName },
      user: { id: userHandle, name: operatorId, displayName },
      challenge: firstAdministratorChallenge(input.capabilityId, nonce),
      pubKeyCredParams: SUPPORTED_COSE_ALGORITHMS.map((alg) => ({ type: 'public-key' as const, alg })),
      timeout: input.timeoutSeconds * 1000,
      attestation: 'none',
      excludeCredentials: [],
      authenticatorSelection: { residentKey: 'required', requireResidentKey: true, userVerification: 'required' },
  };
  return Object.freeze({ nonce, userHandle, options });
}

/**
 * Verifies the candidate's attestation against the challenge of exactly this authorization (`capabilityId`,
 * `nonce`), as AUTH-02 verifies a registration. Used at enrolment and again when a crashed enrolment is
 * resumed from its record: the credential completed is always one that answered this authorization's challenge.
 */
export async function verifyFirstAdministratorAttestation(input: { readonly relyingParty: RelyingPartyConfiguration; readonly capabilityId: string; readonly nonce: string; readonly response: unknown }): Promise<FirstAdministratorCredential> {
  const expected = firstAdministratorChallenge(input.capabilityId, input.nonce);
  const response = parseRegistrationResponse(input.response);
  const clientData = clientDataOf(response.response.clientDataJSON, 'webauthn.create', input.relyingParty);
  if (clientData.challenge !== expected) refuse('HUMAN_IDENTITY_CHALLENGE_INVALID', 'The attestation answers another challenge than this authorization’s.');
  const verified = await verifyRegistration(response, expected, input.relyingParty);
  return Object.freeze({
    credentialId: verified.credentialId,
    publicKey: verified.publicKey,
    counter: verified.counter,
    deviceType: verified.deviceType,
    backedUp: verified.backedUp,
    transports: Object.freeze([...(response.response.transports ?? [])]),
    attestationFormat: verified.attestationFormat,
    aaguid: verified.aaguid,
    rpId: input.relyingParty.rpId,
    origin: verified.origin,
    challengeDigest: challengeDigestOf(expected),
  });
}

/** A new plan for a verified credential: a fresh enrolment id and a token verifier whose secret is discarded at once. */
export function newFirstAdministratorPlan(input: { readonly operatorId: string; readonly displayName: string; readonly userHandle: string; readonly recordedAt: string; readonly authorization: { readonly capabilityId: string; readonly issuer: string }; readonly credential: FirstAdministratorCredential }): FirstAdministratorPlan {
  const { operatorId, displayName } = candidateOf(input?.operatorId, input?.displayName);
  return firstAdministratorPlanOf({
    operatorId,
    displayName,
    userHandle: input.userHandle,
    enrolmentId: `enr-${randomBytes(16).toString('hex')}`,
    tokenVerifier: createHash('sha256').update(randomBytes(32)).digest('hex'),
    recordedAt: input.recordedAt,
    authorization: { capabilityId: input.authorization.capabilityId, issuer: input.authorization.issuer },
    credential: input.credential,
  });
}

/** Strictly re-reads a plan (for example from a record): exactly the expected fields, each well-formed; otherwise `HUMAN_IDENTITY_CONFIGURATION_INVALID`. */
export function firstAdministratorPlanOf(value: unknown): FirstAdministratorPlan {
  const bad = (): never => refuse('HUMAN_IDENTITY_CONFIGURATION_INVALID', 'The first-administrator plan is malformed.');
  const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
  const text = (v: unknown, max = 4_096): string => (typeof v === 'string' && v.length > 0 && v.length <= max ? v : bad());
  const exactly = (v: Record<string, unknown>, keys: readonly string[]): void => {
    if (Object.keys(v).sort().join() !== [...keys].sort().join()) bad();
  };
  if (!isRecord(value)) return bad();
  exactly(value, ['operatorId', 'displayName', 'userHandle', 'enrolmentId', 'tokenVerifier', 'recordedAt', 'authorization', 'credential']);
  const { operatorId, displayName } = candidateOf(value['operatorId'], value['displayName']);
  const userHandle = text(value['userHandle'], 128);
  const enrolmentId = text(value['enrolmentId'], 64);
  const tokenVerifier = text(value['tokenVerifier'], 64);
  const recordedAt = text(value['recordedAt'], 64);
  if (!BASE64URL.test(userHandle) || !ENROLMENT_ID.test(enrolmentId) || !/^[0-9a-f]{64}$/.test(tokenVerifier) || Number.isNaN(Date.parse(recordedAt)) || new Date(recordedAt).toISOString() !== recordedAt) bad();
  const authorization = value['authorization'];
  if (!isRecord(authorization)) return bad();
  exactly(authorization, ['capabilityId', 'issuer']);
  const credential = value['credential'];
  if (!isRecord(credential)) return bad();
  exactly(credential, ['credentialId', 'publicKey', 'counter', 'deviceType', 'backedUp', 'transports', 'attestationFormat', 'aaguid', 'rpId', 'origin', 'challengeDigest']);
  const counter = credential['counter'];
  const deviceType = credential['deviceType'];
  const transports = credential['transports'];
  if (typeof counter !== 'number' || !Number.isSafeInteger(counter) || counter < 0 || (deviceType !== 'singleDevice' && deviceType !== 'multiDevice') || typeof credential['backedUp'] !== 'boolean') bad();
  if (!Array.isArray(transports) || transports.length > 16 || !transports.every((entry) => typeof entry === 'string' && entry.length > 0 && entry.length <= 64)) bad();
  const credentialId = text(credential['credentialId'], 1_024);
  const challengeDigest = text(credential['challengeDigest'], 80);
  if (!BASE64URL.test(credentialId) || !/^sha256:[0-9a-f]{64}$/.test(challengeDigest)) bad();
  return Object.freeze({
    operatorId,
    displayName,
    userHandle,
    enrolmentId,
    tokenVerifier,
    recordedAt,
    authorization: Object.freeze({ capabilityId: text(authorization['capabilityId'], 256), issuer: text(authorization['issuer'], 256) }),
    credential: Object.freeze({
      credentialId,
      publicKey: text(credential['publicKey']),
      counter: counter as number,
      deviceType: deviceType as FirstAdministratorCredential['deviceType'],
      backedUp: credential['backedUp'] as boolean,
      transports: Object.freeze([...(transports as string[])]),
      attestationFormat: text(credential['attestationFormat'], 64),
      aaguid: text(credential['aaguid'], 64),
      rpId: text(credential['rpId'], 253),
      origin: text(credential['origin'], 2_048),
      challengeDigest,
    }),
  });
}

/**
 * sha256 over the whole plan (canonical JSON). Committed in the first row, so the signed, witnessed store — not
 * the ceremony's record — pins every field of the rows that follow (review F1/F2).
 */
export function firstAdministratorPlanDigest(plan: FirstAdministratorPlan): string {
  const checked = firstAdministratorPlanOf(plan);
  return `sha256:${createHash('sha256').update(canonicalJson({ ...checked, authorization: { ...checked.authorization }, credential: { ...checked.credential, transports: [...checked.credential.transports] } }), 'utf8').digest('hex')}`;
}

/** Every first-administrator enrolment row is born expired at this instant, whatever the plan says (review F2). */
export const FIRST_ADMINISTRATOR_ENROLMENT_EXPIRES_AT = '1970-01-01T00:00:00.000Z';

/** The three rows, in order. */
export function firstAdministratorRows(plan: FirstAdministratorPlan): readonly Omit<HumanIdentityRowContent, 'organizationId'>[] {
  const { operatorId, recordedAt, credential } = plan;
  const planDigest = firstAdministratorPlanDigest(plan);
  const recordedBy = FV_FIRST_ADMINISTRATOR_RECORDER;
  return Object.freeze([
    {
      kind: 'principal_created' as const,
      operatorId,
      objectId: null,
      payload: canonicalJson({ displayName: plan.displayName, userHandle: plan.userHandle, role: FV_ADMINISTRATOR_ROLE, authorizationCapabilityId: plan.authorization.capabilityId, authorizationIssuer: plan.authorization.issuer, planDigest }),
      recordedBy,
      recordedAt,
    },
    // Born expired (at the epoch, never a plan-chosen time), with a verifier no secret matches: never an open
    // invitation, never presentable as a token.
    { kind: 'enrolment_authorized' as const, operatorId, objectId: plan.enrolmentId, payload: canonicalJson({ expiresAt: FIRST_ADMINISTRATOR_ENROLMENT_EXPIRES_AT, tokenVerifier: plan.tokenVerifier }), recordedBy, recordedAt },
    {
      kind: 'credential_registered' as const,
      operatorId,
      objectId: credential.credentialId,
      payload: canonicalJson({
        enrolmentId: plan.enrolmentId,
        publicKey: credential.publicKey,
        counter: credential.counter,
        deviceType: credential.deviceType,
        backedUp: credential.backedUp,
        transports: [...credential.transports],
        attestationFormat: credential.attestationFormat,
        aaguid: credential.aaguid,
        rpId: credential.rpId,
        origin: credential.origin,
        challengeDigest: credential.challengeDigest,
      }),
      recordedBy,
      recordedAt,
    },
  ]);
}

const sameRow = (stored: StoredHumanIdentityRow, row: Omit<HumanIdentityRowContent, 'organizationId'>): boolean =>
  stored.kind === row.kind && stored.operatorId === row.operatorId && stored.objectId === row.objectId && stored.payload === row.payload && stored.recordedBy === row.recordedBy && stored.recordedAt === row.recordedAt;

/** How far the verified history already is along `plan`: 0–3 rows, or `undefined` when it holds anything else. */
export function firstAdministratorProgress(history: readonly StoredHumanIdentityRow[], plan: FirstAdministratorPlan): number | undefined {
  const rows = firstAdministratorRows(plan);
  if (history.length > rows.length) return undefined;
  for (const [index, stored] of history.entries()) if (!sameRow(stored, rows[index]!)) return undefined;
  return history.length;
}

/**
 * Appends whatever of `plan` the store does not hold yet, one witnessed row at a time. Each guard re-decides,
 * against the verified history, that it is exactly the earlier rows of this plan. `afterRow` is told each
 * row's kind once it is committed (diagnostics; its result is ignored and a throw is swallowed). Throws
 * `HUMAN_IDENTITY_FIRST_ADMINISTRATOR_CONFLICT` (nothing written) when the store holds anything else, and
 * whatever the store throws when a write fails (a lost witness answer leaves CORE-07 pending recovery).
 */
export async function appendFirstAdministrator(store: HumanIdentityStore, plan: FirstAdministratorPlan, afterRow?: (kind: (typeof ROW_KINDS)[number]) => void): Promise<void> {
  const checked = firstAdministratorPlanOf(plan);
  const rows = firstAdministratorRows(checked);
  const conflict = (): never => refuse('HUMAN_IDENTITY_FIRST_ADMINISTRATOR_CONFLICT', 'The store holds something other than this first administrator’s rows; nothing was written.');
  const done = firstAdministratorProgress(store.history(), checked);
  if (done === undefined) conflict();
  for (let index = done as number; index < rows.length; index += 1) {
    await store.append(rows[index]!, (history) => {
      if (history.length !== index || firstAdministratorProgress(history, checked) !== index) conflict();
    });
    try {
      afterRow?.(ROW_KINDS[index]!);
    } catch {
      // Diagnostics only.
    }
  }
}
