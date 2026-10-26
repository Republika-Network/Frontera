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
import type { RelyingPartyConfiguration } from './relying-party.js';
import type { CeremonyChallenge, CeremonyKind, HumanIdentityStore } from './sqlite-human-identity-store.js';
import { SUPPORTED_COSE_ALGORITHMS, clientDataOf, parseAuthenticationResponse, parseRegistrationResponse, signatureCounterOf, verifyAssertion, verifyRegistration, type AuthenticationResponse } from './webauthn.js';

/**
 * AUTH-02 — the human identity service.
 *
 * **Administration.** Every administrative act requires an
 * `IdentityAdministrator`, which only `identityAdministratorFor()` can make,
 * from an `EnterpriseOperatorPrincipal` that the existing operator
 * authenticator produced: a CTRL-02 operator credential (never a legacy
 * administrator), role `organization-administrator`, of this store's
 * organization. The value is branded through a module-private set, so no
 * structurally similar object is accepted.
 *
 * **Enrolment.** An administrator authorizes one named human to register one
 * passkey. The token (`fre1.<enrolmentId>.<secret>`, 256-bit secret) is shown
 * once; only its SHA-256 verifier is recorded. It is short-lived, revocable,
 * and consumed by the transaction that records the credential. A ceremony
 * interrupted before that commit leaves the enrolment usable until it expires:
 * nothing half-registered survives.
 *
 * **Recognition.** A verified assertion from an active credential of an
 * active human yields a `RecognizedHuman`. That is identity evidence only: no
 * session, no token, no authority. CORE-05 still decides who may approve.
 *
 * **Revocation.** By an administrator, or by the credential's owner through a
 * fresh assertion over an owner-revocation challenge bound to the target
 * credential. A revoked credential or human is refused from the next read on,
 * across restarts. Revoking a passkey does **not** revoke anything it was ever
 * used for: issued grants, capabilities or recorded approvals are governed by
 * their own lifecycles (CORE-05 re-resolves approver standing at every read;
 * an issued capability lives at most its G-02 lifetime).
 *
 * Nothing here is reachable over HTTP in AUTH-02.
 */

const ENROLMENT_ID = /^enr-[0-9a-f]{32}$/;
const ENROLMENT_TOKEN = /^fre1\.(enr-[0-9a-f]{32})\.([A-Za-z0-9_-]{43})$/;
const OPERATOR_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const CEREMONY_RECORDER = 'webauthn-ceremony';

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

export interface HumanIdentityServiceOptions {
  readonly store: HumanIdentityStore;
  readonly relyingParty: RelyingPartyConfiguration;
  /** This Host's configured CTRL-02 operator ids. A human principal is only ever one of them. */
  readonly operatorIds: readonly string[];
  readonly now?: () => Date;
  readonly enrolmentTtlSeconds?: number;
  readonly challengeTtlSeconds?: number;
}

export interface HumanIdentityService {
  createPrincipal(administrator: IdentityAdministrator, input: { readonly operatorId: string; readonly displayName: string }): HumanPrincipal;
  revokePrincipal(administrator: IdentityAdministrator, operatorId: string, reason: string): HumanPrincipal;
  authorizeEnrolment(administrator: IdentityAdministrator, operatorId: string): IssuedEnrolment;
  revokeEnrolment(administrator: IdentityAdministrator, enrolmentId: string, reason: string): EnrolmentAuthorizationView;
  beginRegistration(enrolmentToken: string): RegistrationOptionsJSON;
  finishRegistration(enrolmentToken: string, response: unknown): Promise<PasskeyCredentialView>;
  beginAuthentication(): AuthenticationOptionsJSON;
  finishAuthentication(response: unknown): Promise<RecognizedHuman>;
  revokeCredential(administrator: IdentityAdministrator, credentialId: string, reason: string): PasskeyCredentialView;
  beginOwnerRevocation(credentialId: string): AuthenticationOptionsJSON;
  finishOwnerRevocation(credentialId: string, response: unknown, reason: string): Promise<PasskeyCredentialView>;
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

interface IdentityState {
  readonly principals: Map<string, PrincipalState>;
  readonly enrolments: Map<string, EnrolmentRecord>;
  readonly credentials: Map<string, CredentialRecord>;
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

function project(rows: readonly StoredHumanIdentityRow[], organizationId: string): IdentityState {
  const principals = new Map<string, PrincipalState>();
  const enrolments = new Map<string, EnrolmentRecord>();
  const credentials = new Map<string, CredentialRecord>();
  const corrupt = (message: string): never => {
    throw new HumanIdentityError('HUMAN_IDENTITY_STORE_CORRUPT', message);
  };
  for (const row of rows) {
    const payload = payloadOf(row);
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
        credential.view = { ...credential.view, state: 'revoked', revokedAt: row.recordedAt, revokedBy: row.recordedBy, revocationReason: text(payload, 'reason') };
        break;
      }
    }
  }
  return { principals, enrolments, credentials };
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

export function createHumanIdentityService(options: HumanIdentityServiceOptions): HumanIdentityService {
  const { store, relyingParty } = options;
  const organizationId = store.organizationId;
  const operatorIds = new Set(options.operatorIds);
  const now = options.now ?? ((): Date => new Date());
  const enrolmentTtl = boundedSeconds(options.enrolmentTtlSeconds, ENROLMENT_TTL_DEFAULT_SECONDS, ENROLMENT_TTL_MAX_SECONDS, 'enrolmentTtlSeconds');
  const challengeTtl = boundedSeconds(options.challengeTtlSeconds, CHALLENGE_TTL_DEFAULT_SECONDS, CHALLENGE_TTL_MAX_SECONDS, 'challengeTtlSeconds');
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
    if (found === undefined || found.ceremony !== ceremony || found.consumedAt !== null || found.expiresAt <= iso()) {
      throw new HumanIdentityError('HUMAN_IDENTITY_CHALLENGE_INVALID', 'The ceremony challenge is unknown, of another ceremony, expired or already used.');
    }
    return found;
  }

  const authenticationOptions = (challenge: CeremonyChallenge, allow: readonly string[]): AuthenticationOptionsJSON => ({
    rpId: relyingParty.rpId,
    challenge: challenge.challenge,
    timeout: challengeTtl * 1000,
    userVerification: 'required',
    allowCredentials: allow.map((id) => ({ type: 'public-key' as const, id })),
  });

  /**
   * Verifies an assertion over a stored challenge of `ceremony` and returns
   * the rows recording its use. The caller appends them (with anything else)
   * in one transaction that also consumes the challenge.
   */
  async function verifiedUse(response: AuthenticationResponse, ceremony: CeremonyKind): Promise<{ readonly credential: CredentialRecord; readonly principal: PrincipalState; readonly challenge: CeremonyChallenge; readonly counter: number; readonly backedUp: boolean; readonly deviceType: CredentialDeviceType }> {
    const clientData = clientDataOf(response.response.clientDataJSON, 'webauthn.get', relyingParty);
    const challenge = storedChallenge(clientData.challenge, ceremony);
    const current = state();
    const credential = current.credentials.get(response.id);
    if (credential === undefined || credential.view.state !== 'active') throw new HumanIdentityError('HUMAN_IDENTITY_CREDENTIAL_UNUSABLE', 'The credential is unknown or revoked.');
    const principal = current.principals.get(credential.view.operatorId);
    if (principal === undefined || principal.principal.state !== 'active') throw new HumanIdentityError('HUMAN_IDENTITY_CREDENTIAL_UNUSABLE', "The credential's human is revoked.");
    if (challenge.operatorId !== null && challenge.operatorId !== credential.view.operatorId) throw new HumanIdentityError('HUMAN_IDENTITY_CREDENTIAL_OWNERSHIP_MISMATCH', 'The credential does not belong to the human this ceremony was opened for.');
    if (response.response.userHandle !== undefined && response.response.userHandle !== principal.userHandle) {
      throw new HumanIdentityError('HUMAN_IDENTITY_CREDENTIAL_OWNERSHIP_MISMATCH', "The assertion's user handle is not the credential owner's.");
    }
    const verified = await verifyAssertion(response, challenge.challenge, { credentialId: credential.view.credentialId, publicKey: credential.publicKey }, relyingParty);
    const counter = signatureCounterOf(response.response.authenticatorData);
    if (counter !== verified.counter) throw new HumanIdentityError('HUMAN_IDENTITY_AUTHENTICATION_INVALID', 'The authenticator data counter is inconsistent.');
    const stored = credential.view.counter;
    if ((counter > 0 || stored > 0) && counter <= stored) {
      // The signature verified, so this is the credential's key speaking with a counter that did not advance: record it, refuse it.
      store.append([row('credential_counter_anomaly', credential.view.operatorId, credential.view.credentialId, { presented: counter, stored }, CEREMONY_RECORDER)], () => undefined, { challenge: challenge.challenge, ceremony, at: iso() });
      throw new HumanIdentityError('HUMAN_IDENTITY_COUNTER_REGRESSION', 'The signature counter did not advance; the attempt is refused and recorded.');
    }
    return { credential, principal, challenge, counter, backedUp: verified.backedUp, deviceType: verified.deviceType };
  }

  /** Re-checks, under the write lock, that a credential and its human are still usable. */
  const stillUsable = (credentialId: string) => (history: readonly StoredHumanIdentityRow[]): void => {
    const current = project(history, organizationId);
    const credential = current.credentials.get(credentialId);
    if (credential === undefined || credential.view.state !== 'active' || current.principals.get(credential.view.operatorId)?.principal.state !== 'active') {
      throw new HumanIdentityError('HUMAN_IDENTITY_CREDENTIAL_UNUSABLE', 'The credential or its human was revoked.');
    }
  };

  return {
    createPrincipal(admin, input) {
      const actor = administrator(admin);
      const operatorId = input?.operatorId;
      if (typeof operatorId !== 'string' || !OPERATOR_ID.test(operatorId) || !operatorIds.has(operatorId)) throw new HumanIdentityError('HUMAN_IDENTITY_UNKNOWN_OPERATOR', "That operator id is not one of this Host's configured operators.");
      const displayName = input.displayName;
      if (typeof displayName !== 'string' || displayName.trim() !== displayName || displayName.length === 0 || displayName.length > 128) throw new HumanIdentityError('HUMAN_IDENTITY_CONFIGURATION_INVALID', 'displayName must be a non-empty trimmed string of at most 128 characters.');
      store.append(
        [row('principal_created', operatorId, null, { displayName, userHandle: randomBytes(32).toString('base64url') }, actor.actorRef)],
        (history) => {
          if (project(history, organizationId).principals.has(operatorId)) throw new HumanIdentityError('HUMAN_IDENTITY_PRINCIPAL_EXISTS', 'A human principal already exists for that operator.');
        },
      );
      return (state().principals.get(operatorId) as PrincipalState).principal;
    },

    revokePrincipal(admin, operatorId, reason) {
      const actor = administrator(admin);
      const why = reasonOf(reason);
      store.append([row('principal_revoked', operatorId, null, { reason: why }, actor.actorRef)], (history) => {
        const found = project(history, organizationId).principals.get(operatorId);
        if (found === undefined) throw new HumanIdentityError('HUMAN_IDENTITY_UNKNOWN_PRINCIPAL', 'No human principal exists for that operator.');
        if (found.principal.state === 'revoked') throw new HumanIdentityError('HUMAN_IDENTITY_ALREADY_REVOKED', 'That human principal is already revoked.');
      });
      return (state().principals.get(operatorId) as PrincipalState).principal;
    },

    authorizeEnrolment(admin, operatorId) {
      const actor = administrator(admin);
      activePrincipal(state(), operatorId);
      const enrolmentId = `enr-${randomBytes(16).toString('hex')}`;
      const secret = randomBytes(32).toString('base64url');
      const expiresAt = after(enrolmentTtl);
      store.append([row('enrolment_authorized', operatorId, enrolmentId, { expiresAt, tokenVerifier: verifierOf(secret) }, actor.actorRef)], (history) => {
        activePrincipal(project(history, organizationId), operatorId);
      });
      const record = state().enrolments.get(enrolmentId) as EnrolmentRecord;
      return { ...enrolmentView(record), enrolmentToken: `fre1.${enrolmentId}.${secret}` };
    },

    revokeEnrolment(admin, enrolmentId, reason) {
      const actor = administrator(admin);
      const why = reasonOf(reason);
      if (typeof enrolmentId !== 'string' || !ENROLMENT_ID.test(enrolmentId)) throw new HumanIdentityError('HUMAN_IDENTITY_ENROLMENT_INVALID', 'That is not an enrolment id.');
      const current = state().enrolments.get(enrolmentId);
      if (current === undefined) throw new HumanIdentityError('HUMAN_IDENTITY_ENROLMENT_INVALID', 'No such enrolment.');
      store.append([row('enrolment_revoked', current.operatorId, enrolmentId, { reason: why }, actor.actorRef)], (history) => {
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
      store.append(
        [
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
            },
            CEREMONY_RECORDER,
          ),
        ],
        (history) => {
          const current = project(history, organizationId);
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
      return authenticationOptions(challengeFor('authentication', {}), []);
    },

    async finishAuthentication(raw) {
      const response = parseAuthenticationResponse(raw);
      const use = await verifiedUse(response, 'authentication');
      store.append(
        [row('credential_used', use.credential.view.operatorId, use.credential.view.credentialId, { counter: use.counter, backedUp: use.backedUp }, CEREMONY_RECORDER)],
        stillUsable(use.credential.view.credentialId),
        { challenge: use.challenge.challenge, ceremony: 'authentication', at: iso() },
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

    revokeCredential(admin, credentialId, reason) {
      const actor = administrator(admin);
      const why = reasonOf(reason);
      const existing = state().credentials.get(credentialId);
      if (existing === undefined) throw new HumanIdentityError('HUMAN_IDENTITY_CREDENTIAL_UNUSABLE', 'No such credential.');
      store.append([row('credential_revoked', existing.view.operatorId, credentialId, { reason: why, revokedBy: 'administrator' }, actor.actorRef)], (history) => {
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
      const owned = [...current.credentials.values()].filter((credential) => credential.view.operatorId === target.view.operatorId && credential.view.state === 'active').map((credential) => credential.view.credentialId);
      return authenticationOptions(challengeFor('owner-revocation', { operatorId: target.view.operatorId, targetCredentialId: credentialId }), owned);
    },

    async finishOwnerRevocation(credentialId, raw, reason) {
      const why = reasonOf(reason);
      const response = parseAuthenticationResponse(raw);
      const use = await verifiedUse(response, 'owner-revocation');
      if (use.challenge.targetCredentialId !== credentialId) throw new HumanIdentityError('HUMAN_IDENTITY_CHALLENGE_INVALID', 'The owner-revocation challenge was issued for another credential.');
      const target = state().credentials.get(credentialId);
      if (target === undefined || target.view.operatorId !== use.credential.view.operatorId) throw new HumanIdentityError('HUMAN_IDENTITY_CREDENTIAL_OWNERSHIP_MISMATCH', 'Only the human who owns a credential may revoke it this way.');
      const asserting = use.credential.view.credentialId;
      store.append(
        [
          row('credential_used', use.credential.view.operatorId, asserting, { counter: use.counter, backedUp: use.backedUp }, CEREMONY_RECORDER),
          row('credential_revoked', target.view.operatorId, credentialId, { reason: why, revokedBy: 'owner', assertedWith: asserting }, `owner:${asserting}`),
        ],
        (history) => {
          stillUsable(asserting)(history);
          const credential = project(history, organizationId).credentials.get(credentialId);
          if (credential === undefined || credential.view.state === 'revoked') throw new HumanIdentityError('HUMAN_IDENTITY_ALREADY_REVOKED', 'That credential is already revoked.');
        },
        { challenge: use.challenge.challenge, ceremony: 'owner-revocation', at: iso() },
      );
      return (state().credentials.get(credentialId) as CredentialRecord).view;
    },

    principal: (operatorId) => state().principals.get(operatorId)?.principal,
    credentialsOf: (operatorId) => [...state().credentials.values()].filter((credential) => credential.view.operatorId === operatorId).map((credential) => credential.view),
    enrolment: (enrolmentId) => {
      const record = state().enrolments.get(enrolmentId);
      return record === undefined ? undefined : enrolmentView(record);
    },
  };
}
