import { createHash } from 'node:crypto';

import { canonicalJson, type HumanIdentityRowContent, type StoredHumanIdentityRow } from './chain.js';
import { HumanIdentityError, type AuthenticationOptionsJSON } from './contracts.js';
import { challengeDigestOf, webAuthnChallengeOf } from './decision-challenge.js';
import { firstAdministratorCredentialDigest } from './first-administrator.js';
import { FV_REVOCATION_RECORDER, fvOperatorPlanUnfinished, fvRolesOf } from './fv-domain.js';
import { chainDigestAt, verifyFvOperatorRoles } from './fv-operator.js';
import type { RelyingPartyConfiguration } from './relying-party.js';
import { humanIdentityStateOf } from './service.js';
import type { HumanIdentityStore } from './sqlite-human-identity-store.js';
import { clientDataOf, parseAuthenticationResponse, signatureCounterOf, verifyAssertion } from './webauthn.js';

/**
 * FV-P4C-2B3C-2A3A — revocation of an **FV operator credential** under the authority of the store's FV administrator
 * (AUTH-03 side). The FV revocation ceremony (in `sovereign-status-history/`) is the only caller (a structure test pins
 * it); the authority is decided **here**, against the store's own signed, verified history:
 *
 * - **The administrator** is the store's FV administrator (`fv-domain.ts`), active, using one of its own credentials
 *   that is **currently** active at the authorization's exact prior head (never merely valid at some older head).
 * - **The target** is a principal whose `fv-operator` role verifies cryptographically (`verifyFvOperatorRoles`) at that
 *   head, and the named credential is its own, currently active, with exactly the public key the administrator
 *   approved (`credentialDigest`): never silently replaced. The administrator itself is never a target (B3C-2A3B).
 * - **The authorization** is the administrator's WebAuthn assertion (user verified, pinned RP ID and origins, counter
 *   advancing) over the commitment to one canonical contract: organization, deployment, FV state kind, store, witness,
 *   the exact prior head, the administrator and its credential, the target and its credential digest, a reason code,
 *   the request id and a window of at most 300 s. The target does not take part.
 * - **One row**, signed, chained and witnessed by the store's ordinary `append`, only onto the exact prior head:
 *   `credential_revoked`, in AUTH-02's own owner-revocation shape (it also records the asserting administrator
 *   credential's use and counter), consuming the administrator's challenge and keeping the contract and the raw
 *   assertion, so it can be re-verified from the store alone (`verifyFvRevocations`). A single row is never a partial
 *   plan: no resume deadlock, no interleaving.
 * - **Never while an operator enrolment is unfinished** (`fvOperatorPlanUnfinished`): that plan is resumed first.
 *
 * After it, AUTH-02's own projection makes the credential unusable for authentication and decisions, and
 * `verifyFvCurrentOperators` no longer counts it. Nothing reactivates a revoked credential. A revocation row a holder
 * of the store's signing key forged only **removes** authority (fail closed); `verifyFvRevocations` reports it as not
 * administrator-authorized.
 */

export const FV_REVOCATION_AUTHORIZATION_FORMAT = 'frontera.fv-operator-revocation-authorization.v1';
export const FV_REVOCATION_ACTION = 'frontera.fv-bootstrap-identity.revoke-operator-credential';
export const FV_REVOCATION_REASONS = Object.freeze(['compromised', 'lost', 'offboarded', 'other'] as const);
export type FvRevocationReason = (typeof FV_REVOCATION_REASONS)[number];
export const FV_REVOCATION_AUTHORIZATION_MAX_LIFETIME_SECONDS = 300;
const REQUEST_ID = /^fvrev-[0-9a-f]{32}$/;
const OPERATOR_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

/** What the administrator signs (through the WebAuthn challenge derived from its commitment). */
export interface FvRevocationAuthorization {
  readonly format: typeof FV_REVOCATION_AUTHORIZATION_FORMAT;
  readonly action: typeof FV_REVOCATION_ACTION;
  readonly requestId: string;
  readonly organizationId: string;
  readonly deploymentId: string;
  readonly stateKind: string;
  readonly storeId: string;
  readonly witnessId: string;
  readonly witnessKeyDigest: string;
  readonly priorHead: { readonly sequence: number; readonly chainDigest: string };
  readonly administrator: { readonly operatorId: string; readonly credentialId: string };
  readonly target: { readonly operatorId: string; readonly credentialId: string; readonly credentialDigest: string };
  readonly reason: FvRevocationReason;
  /** Also the row's `recordedAt`: the time is signed. */
  readonly notBefore: string;
  readonly notAfter: string;
}

export interface FvRevocationExpectation {
  readonly deploymentId: string;
  readonly stateKind: string;
  readonly witnessId: string;
  readonly witnessKeyDigest: string;
}

export interface FvRevocationEvidence {
  readonly authorization: FvRevocationAuthorization;
  readonly administratorAssertion: unknown;
}

export type FvRevocationRefusal =
  | 'MALFORMED'
  | 'SCOPE_MISMATCH'
  | 'STALE_HEAD'
  | 'PLAN_INCOMPLETE'
  | 'NOT_ADMINISTRATOR'
  | 'ADMINISTRATOR_CREDENTIAL_UNUSABLE'
  | 'NOT_OPERATOR'
  | 'TARGET_CREDENTIAL_UNKNOWN'
  | 'TARGET_MISMATCH'
  | 'ALREADY_REVOKED'
  | 'ASSERTION_INVALID'
  | 'COUNTER_REGRESSION'
  | 'CHALLENGE_CONSUMED'
  | 'WINDOW_CLOSED'
  | 'CONFLICT';

export type FvRevocationVerification =
  | { readonly verified: true; readonly row: Omit<HumanIdentityRowContent, 'organizationId'>; readonly done: boolean }
  | { readonly verified: false; readonly reason: FvRevocationRefusal };

export class FvRevocationRefusedError extends HumanIdentityError {
  constructor(readonly reason: FvRevocationRefusal) {
    super('HUMAN_IDENTITY_FV_REVOCATION_REFUSED', `The FV operator credential revocation was refused: ${reason}.`);
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const exactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean => Object.keys(value).sort().join() === [...keys].sort().join();
const iso = (value: unknown): value is string => typeof value === 'string' && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value;
const text = (value: unknown, max = 256): value is string => typeof value === 'string' && value.length > 0 && value.length <= max;

export function fvRevocationAuthorizationCommitment(authorization: FvRevocationAuthorization): string {
  return `sha256:${createHash('sha256').update(canonicalJson(authorization as unknown as Parameters<typeof canonicalJson>[0]), 'utf8').digest('hex')}`;
}

/** The administrator's request options: an assertion by its named credential over this authorization's commitment, user verified. */
export function fvRevocationAdministratorOptions(input: { readonly relyingParty: RelyingPartyConfiguration; readonly authorization: FvRevocationAuthorization; readonly timeoutSeconds: number }): AuthenticationOptionsJSON {
  return {
    rpId: input.relyingParty.rpId,
    challenge: webAuthnChallengeOf(fvRevocationAuthorizationCommitment(input.authorization)),
    timeout: input.timeoutSeconds * 1000,
    userVerification: 'required',
    allowCredentials: [{ type: 'public-key' as const, id: input.authorization.administrator.credentialId }],
  };
}

/** Strictly re-reads an authorization. `undefined` when anything is missing, extra or malformed. */
export function fvRevocationAuthorizationOf(value: unknown): FvRevocationAuthorization | undefined {
  if (!isRecord(value) || !exactKeys(value, ['format', 'action', 'requestId', 'organizationId', 'deploymentId', 'stateKind', 'storeId', 'witnessId', 'witnessKeyDigest', 'priorHead', 'administrator', 'target', 'reason', 'notBefore', 'notAfter'])) return undefined;
  if (value['format'] !== FV_REVOCATION_AUTHORIZATION_FORMAT || value['action'] !== FV_REVOCATION_ACTION || !(FV_REVOCATION_REASONS as readonly unknown[]).includes(value['reason'])) return undefined;
  if (!text(value['requestId']) || !REQUEST_ID.test(value['requestId']) || ![value['organizationId'], value['deploymentId'], value['stateKind'], value['storeId'], value['witnessId']].every((v) => text(v)) || !text(value['witnessKeyDigest']) || !SHA256.test(value['witnessKeyDigest'])) return undefined;
  if (!iso(value['notBefore']) || !iso(value['notAfter'])) return undefined;
  const { priorHead, administrator, target } = value;
  if (!isRecord(priorHead) || !exactKeys(priorHead, ['sequence', 'chainDigest']) || !Number.isSafeInteger(priorHead['sequence']) || (priorHead['sequence'] as number) < 1 || !text(priorHead['chainDigest']) || !SHA256.test(priorHead['chainDigest'])) return undefined;
  for (const party of [administrator, target]) {
    if (!isRecord(party) || !text(party['operatorId']) || !OPERATOR_ID.test(party['operatorId']) || !text(party['credentialId'], 1_024) || !BASE64URL.test(party['credentialId'])) return undefined;
  }
  if (!exactKeys(administrator as Record<string, unknown>, ['operatorId', 'credentialId']) || !exactKeys(target as Record<string, unknown>, ['operatorId', 'credentialId', 'credentialDigest']) || !text((target as Record<string, unknown>)['credentialDigest']) || !SHA256.test((target as Record<string, unknown>)['credentialDigest'] as string)) return undefined;
  return value as unknown as FvRevocationAuthorization;
}

const sameRow = (stored: StoredHumanIdentityRow, row: Omit<HumanIdentityRowContent, 'organizationId'>): boolean =>
  stored.kind === row.kind && stored.operatorId === row.operatorId && stored.objectId === row.objectId && stored.payload === row.payload && stored.recordedBy === row.recordedBy && stored.recordedAt === row.recordedAt;

/**
 * Verifies a revocation's evidence against the store's verified `history`, without writing. `done` when the history
 * already holds exactly this revocation's row right after the prior head (a completed revocation re-reported).
 */
export async function verifyFvRevocationEvidence(
  history: readonly StoredHumanIdentityRow[],
  store: Pick<HumanIdentityStore, 'organizationId' | 'storeId'>,
  evidence: FvRevocationEvidence,
  context: { readonly relyingParty: RelyingPartyConfiguration; readonly expected: FvRevocationExpectation; readonly now: Date },
): Promise<FvRevocationVerification> {
  const no = (reason: FvRevocationRefusal): FvRevocationVerification => Object.freeze({ verified: false as const, reason });
  if (!isRecord(evidence)) return no('MALFORMED');
  const authorization = fvRevocationAuthorizationOf(evidence.authorization);
  if (authorization === undefined) return no('MALFORMED');
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
  if (lifetime <= 0 || lifetime > FV_REVOCATION_AUTHORIZATION_MAX_LIFETIME_SECONDS * 1000) return no('MALFORMED');
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
  // The administrator: the FV administrator, active, with its named credential *currently* active.
  const { administrator, target } = authorization;
  if (fvRolesOf(prior).get(administrator.operatorId) !== 'fv-administrator' || state.principals.get(administrator.operatorId)?.state !== 'active') return no('NOT_ADMINISTRATOR');
  const adminCredential = state.credentials.get(administrator.credentialId);
  if (adminCredential === undefined || adminCredential.operatorId !== administrator.operatorId || adminCredential.state !== 'active') return no('ADMINISTRATOR_CREDENTIAL_UNUSABLE');
  // The target: a cryptographically verified FV operator, its own named credential, exactly the approved key.
  if (target.operatorId === administrator.operatorId || !(await verifyFvOperatorRoles(prior, store.organizationId, context.relyingParty)).has(target.operatorId)) return no('NOT_OPERATOR');
  const targetCredential = state.credentials.get(target.credentialId);
  if (targetCredential === undefined || targetCredential.operatorId !== target.operatorId) return no('TARGET_CREDENTIAL_UNKNOWN');
  if (firstAdministratorCredentialDigest({ credentialId: target.credentialId, publicKey: targetCredential.publicKey }) !== target.credentialDigest) return no('TARGET_MISMATCH');

  // The administrator's assertion over this authorization's commitment; its counter advances.
  const commitment = fvRevocationAuthorizationCommitment(authorization);
  const adminChallenge = webAuthnChallengeOf(commitment);
  let use: { readonly counter: number; readonly backedUp: boolean };
  let assertion: { readonly clientDataJSON: string; readonly authenticatorData: string; readonly signature: string };
  try {
    const response = parseAuthenticationResponse(evidence.administratorAssertion);
    if (response.id !== administrator.credentialId) return no('ASSERTION_INVALID');
    const clientData = clientDataOf(response.response.clientDataJSON, 'webauthn.get', context.relyingParty);
    if (clientData.challenge !== adminChallenge) return no('ASSERTION_INVALID');
    const userHandle = state.principals.get(administrator.operatorId)?.userHandle;
    if (response.response.userHandle !== undefined && response.response.userHandle !== userHandle) return no('ASSERTION_INVALID');
    const verified = await verifyAssertion(response, adminChallenge, { credentialId: administrator.credentialId, publicKey: adminCredential.publicKey }, context.relyingParty);
    const counter = signatureCounterOf(response.response.authenticatorData);
    if (counter !== verified.counter) return no('ASSERTION_INVALID');
    if ((counter > 0 || adminCredential.counter > 0) && counter <= adminCredential.counter) return no('COUNTER_REGRESSION');
    use = Object.freeze({ counter, backedUp: verified.backedUp });
    assertion = { clientDataJSON: response.response.clientDataJSON, authenticatorData: response.response.authenticatorData, signature: response.response.signature };
  } catch {
    return no('ASSERTION_INVALID');
  }
  const challengeDigest = challengeDigestOf(adminChallenge);
  if (state.usedChallenges.has(challengeDigest)) return no('CHALLENGE_CONSUMED');

  const row = Object.freeze({
    kind: 'credential_revoked' as const,
    operatorId: target.operatorId,
    objectId: target.credentialId,
    // AUTH-02's owner-revocation shape: the revocation also records the asserting (administrator) credential's use.
    payload: canonicalJson({ reason: authorization.reason, revokedBy: 'fv-administrator', assertedWith: administrator.credentialId, counter: use.counter, backedUp: use.backedUp, challengeDigest, authorizationCommitment: commitment, authorization: authorization as unknown as Parameters<typeof canonicalJson>[0], assertion }),
    recordedBy: FV_REVOCATION_RECORDER,
    recordedAt: authorization.notBefore,
  });
  // Already written right after its prior head (whatever followed later): a completed revocation, re-reported.
  const at = history[sequence];
  if (at !== undefined && sameRow(at, row)) return Object.freeze({ verified: true as const, row, done: true });
  if (history.length > sequence) return no('STALE_HEAD');
  // Only now, with nothing written: the target credential must still be active, and the window open.
  if (targetCredential.state !== 'active') return no('ALREADY_REVOKED');
  const now = context.now.getTime();
  if (now < Date.parse(authorization.notBefore) || now > Date.parse(authorization.notAfter)) return no('WINDOW_CLOSED');
  return Object.freeze({ verified: true as const, row, done: false });
}

/** Verifies the evidence and appends its one row onto exactly the prior head (nothing when it is already there). */
export async function appendFvRevocation(
  store: HumanIdentityStore,
  evidence: FvRevocationEvidence,
  context: { readonly relyingParty: RelyingPartyConfiguration; readonly expected: FvRevocationExpectation; readonly now: Date },
): Promise<void> {
  const verification = await verifyFvRevocationEvidence(store.history(), store, evidence, context);
  if (!verification.verified) throw new FvRevocationRefusedError(verification.reason);
  if (verification.done) return;
  const { sequence, chainDigest } = evidence.authorization.priorHead;
  await store.append(verification.row, (history) => {
    if (history.length !== sequence || chainDigestAt(history, store.storeId, store.organizationId, sequence) !== chainDigest || fvOperatorPlanUnfinished(history)) throw new FvRevocationRefusedError('CONFLICT');
  });
}

/**
 * Re-verifies, from the signed history alone, **every** `credential_revoked` row of an FV store (review L2: whatever
 * its recorder). A row is `authorized` only when it is the FV revocation ceremony's and every condition AUTH-03 decided
 * at write time (`verifyFvRevocationEvidence`) **that the history can still prove** holds again at its position
 * (review L3; AUDIT-HF01 completed the parity):
 * - the contract: it parses strictly, recomputes to its stored commitment, names this row's target and credential;
 * - its scope: this organization and, against `expected`, this store id, deployment, FV state kind, witness id and
 *   witness key digest (AUDIT-HF01; the store id is compared explicitly — the prior chain digest is recomputed under the
 *   authorization's own store id, so it does not bind that id by itself);
 * - its signed lifetime: positive and at most `FV_REVOCATION_AUTHORIZATION_MAX_LIFETIME_SECONDS` (AUDIT-HF01);
 * - its position and time: exactly that row's prior head (sequence and chain digest), `recordedAt` = `notBefore`;
 * - there: no unfinished operator enrolment; the administrator the FV administrator, active, with that credential
 *   active and owned; the target a cryptographically verified FV operator (`verifyFvOperatorRoles`), not the
 *   administrator, its credential still active, owned and exactly the approved key; the challenge unused;
 * - the stored assertion verifies (user verified, pinned RP ID, origins and type) by the administrator's credential as
 *   it was there, and its counter advances;
 * - and the stored row is byte-for-byte the row AUTH-03 builds from that contract and assertion (publication review F1).
 *
 * `expected` must be the registration's **authenticated** binding — the values every FV ceremony uses, from the
 * registration record as the FV ceremonies' registered-record access opens it (the pinned issuer's signature over the
 * binding, and the registrar's pinned configuration, including the digest of the pinned witness key). A caller-chosen
 * scope proves nothing. Without a complete one, nothing is `authorized` (fail closed). One credential can appear in
 * both sets (a genuine revocation, then a replayed copy of its row later): a consumer asks whether it is in
 * `authorized`, never whether it is absent from `unauthorized`.
 *
 * **What `authorized` does not prove (publication review F2):** *when* the row was appended. AUTH-03 checked the signed
 * window against the ceremony's clock at write time, but neither the store nor the witness records a trusted append
 * time (the reference witness's local `recorded_at` columns are unsigned metadata), so a holder of the store's signing
 * key could append a genuine, in-scope authorization the ceremony never used, after its window, at its exact head while
 * nothing else was written. `authorized` means "the administrator signed exactly this revocation, in this scope, for
 * this position" — not "approved at the time it was appended". It still only removes authority. Anything else is
 * `unauthorized` (for example a holder of the store's signing key forging one). Either way the credential stays revoked:
 * a revocation only ever removes authority.
 */
export async function verifyFvRevocations(
  history: readonly StoredHumanIdentityRow[],
  organizationId: string,
  relyingParty: RelyingPartyConfiguration,
  expected: FvRevocationExpectation & { readonly storeId: string },
): Promise<{ readonly authorized: ReadonlySet<string>; readonly unauthorized: ReadonlySet<string> }> {
  const authorized = new Set<string>();
  const unauthorized = new Set<string>();
  // AUDIT-HF01: no complete authenticated scope, nothing is authorized.
  const scoped = isRecord(expected) && [expected.storeId, expected.deploymentId, expected.stateKind, expected.witnessId, expected.witnessKeyDigest].every((value) => typeof value === 'string' && value.length > 0);
  for (const [index, row] of history.entries()) {
    if (row.kind !== 'credential_revoked' || row.objectId === null) continue;
    let ok = false;
    try {
      const payload = JSON.parse(row.payload) as { authorization?: unknown; authorizationCommitment?: unknown; challengeDigest?: unknown; counter?: unknown; assertion?: { clientDataJSON?: unknown; authenticatorData?: unknown; signature?: unknown } };
      const authorization = fvRevocationAuthorizationOf(payload.authorization);
      const prefix = history.slice(0, index);
      if (
        scoped &&
        row.recordedBy === FV_REVOCATION_RECORDER &&
        authorization !== undefined &&
        fvRevocationAuthorizationCommitment(authorization) === payload.authorizationCommitment &&
        authorization.organizationId === organizationId &&
        // AUDIT-HF01: the scope and the lifetime cap AUTH-03 enforced at write time.
        authorization.storeId === expected.storeId &&
        authorization.deploymentId === expected.deploymentId &&
        authorization.stateKind === expected.stateKind &&
        authorization.witnessId === expected.witnessId &&
        authorization.witnessKeyDigest === expected.witnessKeyDigest &&
        Date.parse(authorization.notAfter) - Date.parse(authorization.notBefore) > 0 &&
        Date.parse(authorization.notAfter) - Date.parse(authorization.notBefore) <= FV_REVOCATION_AUTHORIZATION_MAX_LIFETIME_SECONDS * 1000 &&
        authorization.target.operatorId === row.operatorId &&
        authorization.target.credentialId === row.objectId &&
        authorization.target.operatorId !== authorization.administrator.operatorId &&
        authorization.priorHead.sequence === index &&
        row.recordedAt === authorization.notBefore &&
        chainDigestAt(history, authorization.storeId, organizationId, index) === authorization.priorHead.chainDigest &&
        fvRolesOf(prefix).get(authorization.administrator.operatorId) === 'fv-administrator'
      ) {
        const prior = humanIdentityStateOf(prefix, organizationId);
        const credential = prior.credentials.get(authorization.administrator.credentialId);
        const challenge = webAuthnChallengeOf(fvRevocationAuthorizationCommitment(authorization));
        const counter = payload.counter;
        const targetCredential = prior.credentials.get(authorization.target.credentialId);
        if (
          !fvOperatorPlanUnfinished(prefix) &&
          targetCredential !== undefined &&
          targetCredential.operatorId === authorization.target.operatorId &&
          targetCredential.state === 'active' &&
          firstAdministratorCredentialDigest({ credentialId: authorization.target.credentialId, publicKey: targetCredential.publicKey }) === authorization.target.credentialDigest &&
          prior.principals.get(authorization.administrator.operatorId)?.state === 'active' &&
          credential !== undefined &&
          credential.operatorId === authorization.administrator.operatorId &&
          credential.state === 'active' &&
          payload.challengeDigest === challengeDigestOf(challenge) &&
          !prior.usedChallenges.has(challengeDigestOf(challenge)) &&
          typeof counter === 'number' &&
          !((counter > 0 || credential.counter > 0) && counter <= credential.counter) &&
          (await verifyFvOperatorRoles(prefix, organizationId, relyingParty)).has(authorization.target.operatorId)
        ) {
          const a = payload.assertion ?? {};
          const response = parseAuthenticationResponse({ id: authorization.administrator.credentialId, rawId: authorization.administrator.credentialId, type: 'public-key', response: { clientDataJSON: a.clientDataJSON, authenticatorData: a.authenticatorData, signature: a.signature } });
          const verified = await verifyAssertion(response, challenge, { credentialId: authorization.administrator.credentialId, publicKey: credential.publicKey }, relyingParty);
          // Publication review F1: the stored row must be exactly the one AUTH-03 builds from this contract and this
          // assertion (byte for byte), so no field AUTH-02's projection acts on (`assertedWith`, `counter`, `backedUp`,
          // `reason`) can be swapped under a genuine signature.
          const rebuilt = canonicalJson({ reason: authorization.reason, revokedBy: 'fv-administrator', assertedWith: authorization.administrator.credentialId, counter: verified.counter, backedUp: verified.backedUp, challengeDigest: challengeDigestOf(challenge), authorizationCommitment: fvRevocationAuthorizationCommitment(authorization), authorization: authorization as unknown as Parameters<typeof canonicalJson>[0], assertion: { clientDataJSON: response.response.clientDataJSON, authenticatorData: response.response.authenticatorData, signature: response.response.signature } });
          ok = verified.counter === counter && row.payload === rebuilt;
        }
      }
    } catch {
      ok = false;
    }
    (ok ? authorized : unauthorized).add(row.objectId);
  }
  return Object.freeze({ authorized, unauthorized });
}

/**
 * The FV operators with **current** authority: cryptographically verified operators (`verifyFvOperatorRoles`) whose
 * principal is active and that still hold at least one active credential in the verified history. A revoked
 * credential — revoked by an administrator, or by a forged row — never counts. Authority-sensitive consumers use this,
 * never `fvRolesOf` alone.
 */
export async function verifyFvCurrentOperators(history: readonly StoredHumanIdentityRow[], organizationId: string, relyingParty: RelyingPartyConfiguration): Promise<ReadonlySet<string>> {
  const verified = await verifyFvOperatorRoles(history, organizationId, relyingParty);
  const state = humanIdentityStateOf(history, organizationId);
  const current = new Set<string>();
  for (const operatorId of verified) {
    if (state.principals.get(operatorId)?.state !== 'active') continue;
    if ([...state.credentials.values()].some((credential) => credential.operatorId === operatorId && credential.state === 'active')) current.add(operatorId);
  }
  return current;
}
