import type { AuthorityStateFreshnessAnchor } from '../authority-state-freshness/index.js';
import { firstAdministratorCredentialDigest } from '../human-identity/first-administrator.js';
import { fvOperatorPlanUnfinished, fvRolesOf } from '../human-identity/fv-domain.js';
import { verifyFvOperatorRoles } from '../human-identity/fv-operator.js';
import {
  FV_REVOCATION_ACTION,
  FV_REVOCATION_AUTHORIZATION_FORMAT,
  FV_REVOCATION_AUTHORIZATION_MAX_LIFETIME_SECONDS,
  FV_REVOCATION_REASONS,
  FvRevocationRefusedError,
  appendFvRevocation,
  fvRevocationAdministratorOptions,
  verifyFvRevocationEvidence,
  type FvRevocationAuthorization,
  type FvRevocationEvidence,
  type FvRevocationReason,
  type FvRevocationRefusal,
} from '../human-identity/fv-revocation.js';
import { FV_BOOTSTRAP_IDENTITY_STATE_KIND, type AuthenticationOptionsJSON, type HumanIdentityStore, type RelyingPartyConfiguration } from '../human-identity/index.js';
import type { FvIdentityRegistrationEvent, FvIdentityRegistrationRecord, FvRegistrationRecordFile } from './identity-registration-record.js';
import { fvRegisteredStoreAccess } from './identity-registration-first-administrator.js';
import { FvIdentityRegistrationError, fvRegistrarInternals, type FvIdentityRegistrarOptions, type FvRegistrarConfiguration } from './identity-registration.js';

/**
 * FV-P4C-2B3C-2A3A — revocation of an **FV operator credential** under the authority of the registered FV store's
 * administrator (internal and non-operational: nothing in the Host, its scripts, its deployment, the dedicated
 * executor or its supervisor invokes it; structure tests pin this). See
 * `docs/integration/FV_IDENTITY_REGISTRATION_AND_OPERATOR_LIFECYCLE.md` §17.
 *
 * An offline ceremony that holds the registration record and the registered store exclusively. The administrator
 * authorizes exactly one revocation at the store's **current** head (a WebAuthn assertion over a signed contract);
 * AUTH-03 (`human-identity/fv-revocation.ts`) verifies it against the signed history — current administrator,
 * cryptographically verified target operator, its exact credential still active, no unfinished enrolment — and
 * appends one signed row. `revoked` only once the verified store holds it **and** a fresh witness read shows that head
 * committed. The target operator takes no part. No Host administrator, operator credential, G-02A capability or flag is
 * accepted. The record holds progress only: a resume re-verifies the recorded evidence. The administrator credential
 * itself is never a target here (B3C-2A3B).
 */

const REQUEST_ID = /^fvrev-[0-9a-f]{32}$/;
const OPERATOR_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const INTENT_EVENT = 'operator-revocation-intent';
const REVOKED_EVENT = 'operator-credential-revoked';
const PROOF_TIMEOUT_SECONDS = 60;
const DEFAULT_LIFETIME_SECONDS = 120;

export type FvRevocationStep = 'administrator-verified' | 'intent-recorded' | 'credential_revoked' | 'revoked';

export interface FvRevocationOptions extends Omit<FvIdentityRegistrarOptions, 'observer'> {
  readonly relyingParty: RelyingPartyConfiguration;
  readonly observer?: (step: FvRevocationStep) => void;
}

export interface FvRevocationOutcomeEvidence {
  readonly requestId: string;
  readonly organizationId: string;
  readonly storeId: string;
  readonly operatorId: string;
  readonly credentialId: string;
  readonly reason: FvRevocationReason;
  readonly administratorOperatorId: string;
  readonly authorizedAtSequence: number;
  readonly storeSequence: number;
}

export const FV_REVOCATION_CEREMONY_REFUSALS = Object.freeze([
  'REQUEST_INVALID',
  'REGISTRAR_BUSY',
  'RECORD_CORRUPT',
  'RECORD_UNAVAILABLE',
  'PATH_REFUSED',
  'NO_REGISTRATION',
  'REGISTRATION_PENDING',
  'REGISTRATION_QUARANTINED',
  'CONFIGURATION_MISMATCH',
  'STORE_FILE_MISMATCH',
  'AUTHENTICITY_UNVERIFIED',
  'WITNESS_UNAVAILABLE',
  'STORE_HELD',
  'STORE_UNAVAILABLE',
  'STORE_REFUSED',
  'REQUEST_PENDING',
  'NO_REQUEST',
  'ENROLLMENT_PENDING',
  'ADMINISTRATOR_PROOF_INVALID',
  'NOT_ADMINISTRATOR',
  'ADMINISTRATOR_CREDENTIAL_UNUSABLE',
  'NOT_OPERATOR',
  'TARGET_CREDENTIAL_UNKNOWN',
  'TARGET_MISMATCH',
  'ALREADY_REVOKED',
  'STALE_HEAD',
  'WINDOW_CLOSED',
  'REVOCATION_CONFLICT',
  'EVIDENCE_INVALID',
] as const);
export type FvRevocationCeremonyRefusal = (typeof FV_REVOCATION_CEREMONY_REFUSALS)[number];

export type FvRevocationOutcome =
  | { readonly outcome: 'revoked'; readonly evidence: FvRevocationOutcomeEvidence }
  /** Recorded, not confirmed: continue with `resumeFvOperatorRevocation` and the same request id. */
  | { readonly outcome: 'pending'; readonly reason: 'WITNESS_UNAVAILABLE' | 'STORE_UNAVAILABLE' | 'SIGNER_UNAVAILABLE'; readonly requestId: string }
  | { readonly outcome: 'refused'; readonly reason: FvRevocationCeremonyRefusal; readonly detail?: string };

const refused = (reason: FvRevocationCeremonyRefusal, detail?: string): FvRevocationOutcome => Object.freeze({ outcome: 'refused' as const, reason, ...(detail !== undefined ? { detail } : {}) });

function fromShared(outcome: { readonly outcome: string; readonly reason?: string; readonly detail?: string }): FvRevocationOutcome {
  const reason = (FV_REVOCATION_CEREMONY_REFUSALS as readonly string[]).includes(outcome.reason ?? '') ? (outcome.reason as FvRevocationCeremonyRefusal) : 'RECORD_UNAVAILABLE';
  return refused(reason, outcome.detail);
}

function fromVerification(reason: FvRevocationRefusal): FvRevocationOutcome {
  switch (reason) {
    case 'NOT_ADMINISTRATOR':
    case 'ADMINISTRATOR_CREDENTIAL_UNUSABLE':
    case 'NOT_OPERATOR':
    case 'TARGET_CREDENTIAL_UNKNOWN':
    case 'TARGET_MISMATCH':
    case 'ALREADY_REVOKED':
    case 'STALE_HEAD':
    case 'WINDOW_CLOSED':
      return refused(reason);
    case 'PLAN_INCOMPLETE':
      return refused('ENROLLMENT_PENDING');
    case 'ASSERTION_INVALID':
    case 'COUNTER_REGRESSION':
      return refused('ADMINISTRATOR_PROOF_INVALID', reason);
    case 'CONFLICT':
      return refused('REVOCATION_CONFLICT');
    default:
      return refused('EVIDENCE_INVALID', reason);
  }
}

interface Configuration {
  readonly registrar: FvRegistrarConfiguration;
  readonly relyingParty: RelyingPartyConfiguration;
  readonly observer: ((step: FvRevocationStep) => void) | undefined;
}

function configurationOf(options: FvRevocationOptions): Configuration {
  const invalid = (message: string): never => {
    throw new FvIdentityRegistrationError('OPTIONS_INVALID', message);
  };
  if (typeof options !== 'object' || options === null) invalid('The ceremony needs its options.');
  const { relyingParty, observer, ...registrarOptions } = options;
  const registrar = fvRegistrarInternals.configurationOf(registrarOptions);
  if (typeof relyingParty?.rpId !== 'string' || !Array.isArray(relyingParty.allowedOrigins) || relyingParty.allowedOrigins.length === 0) invalid('relyingParty is the FV executor’s relying-party configuration.');
  if (observer !== undefined && typeof observer !== 'function') invalid('observer is a function.');
  return Object.freeze({ registrar, relyingParty, observer });
}

function observe(config: Configuration, step: FvRevocationStep): void {
  try {
    config.observer?.(step);
  } catch {
    // Diagnostics never change the ceremony.
  }
}

const isoOf = (config: Configuration): string => new Date(config.registrar.clock()).toISOString();
const plain = (value: unknown): unknown => JSON.parse(JSON.stringify(value)) as unknown;
const expectationOf = (current: FvIdentityRegistrationRecord) => Object.freeze({ deploymentId: current.deploymentId, stateKind: FV_BOOTSTRAP_IDENTITY_STATE_KIND, witnessId: current.witnessId, witnessKeyDigest: current.witnessKeyDigest });

function intentsFor(events: readonly FvIdentityRegistrationEvent[], requestId: string): readonly FvRevocationEvidence[] {
  const found: FvRevocationEvidence[] = [];
  for (const event of events) {
    if (event.kind !== INTENT_EVENT) continue;
    try {
      const parsed = JSON.parse(event.detail) as { requestId?: unknown; evidence?: unknown };
      // Review L1: the event's request id must be the one its signed evidence names (a copy filed under another id is ignored).
      const evidence = parsed.evidence as { authorization?: { requestId?: unknown } } | null | undefined;
      if (parsed.requestId === requestId && typeof evidence === 'object' && evidence !== null && evidence.authorization?.requestId === requestId) found.push(parsed.evidence as FvRevocationEvidence);
    } catch {
      continue;
    }
  }
  return found;
}

/** Appends (or confirms) the verified revocation, then requires the store to hold it and the witness to have committed that head. */
async function complete(config: Configuration, record: FvRegistrationRecordFile, store: HumanIdentityStore, anchor: AuthorityStateFreshnessAnchor, current: FvIdentityRegistrationRecord, evidence: FvRevocationEvidence): Promise<FvRevocationOutcome> {
  const requestId = evidence.authorization.requestId;
  const pending = (reason: 'WITNESS_UNAVAILABLE' | 'STORE_UNAVAILABLE' | 'SIGNER_UNAVAILABLE'): FvRevocationOutcome => Object.freeze({ outcome: 'pending' as const, reason, requestId });
  const context = { relyingParty: config.relyingParty, expected: expectationOf(current), now: new Date(config.registrar.clock()) };
  try {
    await appendFvRevocation(store, evidence, context);
  } catch (error) {
    if (error instanceof FvRevocationRefusedError) return fromVerification(error.reason);
    return pending(fvRegisteredStoreAccess.pendingReason(error));
  }
  observe(config, 'credential_revoked');
  let head: ReturnType<HumanIdentityStore['head']>;
  try {
    const readback = await verifyFvRevocationEvidence(store.history(), store, evidence, context);
    if (!readback.verified || !readback.done) return refused('REVOCATION_CONFLICT');
    head = store.head();
  } catch (error) {
    return pending(fvRegisteredStoreAccess.pendingReason(error));
  }
  let witnessed: Awaited<ReturnType<AuthorityStateFreshnessAnchor['read']>>;
  try {
    witnessed = await anchor.read({ stateKind: FV_BOOTSTRAP_IDENTITY_STATE_KIND, organizationId: current.organizationId });
  } catch {
    return pending('WITNESS_UNAVAILABLE');
  }
  if (!(witnessed.status === 'bound' && witnessed.storeId === current.storeId && witnessed.pending === undefined && witnessed.committed.sequence === head.sequence && witnessed.committed.stateDigest === head.chainDigest)) return pending('WITNESS_UNAVAILABLE');
  try {
    record.appendEvent(isoOf(config), REVOKED_EVENT, JSON.stringify({ requestId, operatorId: evidence.authorization.target.operatorId, credentialId: evidence.authorization.target.credentialId }));
  } catch {
    // The signed, witnessed store is the authority and holds the revocation.
  }
  observe(config, 'revoked');
  const { authorization } = evidence;
  return Object.freeze({
    outcome: 'revoked' as const,
    evidence: Object.freeze({
      requestId,
      organizationId: current.organizationId,
      storeId: current.storeId,
      operatorId: authorization.target.operatorId,
      credentialId: authorization.target.credentialId,
      reason: authorization.reason,
      administratorOperatorId: authorization.administrator.operatorId,
      authorizedAtSequence: authorization.priorHead.sequence,
      storeSequence: head.sequence,
    }),
  });
}

async function withRegisteredStore(config: Configuration, use: (record: FvRegistrationRecordFile, current: FvIdentityRegistrationRecord, store: HumanIdentityStore, anchor: AuthorityStateFreshnessAnchor) => Promise<FvRevocationOutcome>): Promise<FvRevocationOutcome> {
  const { registrar } = config;
  const locked = await fvRegisteredStoreAccess.registeredRecord(registrar, config.relyingParty);
  if (!('record' in locked)) return fromShared(locked);
  const { record, current } = locked;
  try {
    if (!(await fvRegistrarInternals.authenticityRoundTrips(registrar, current.storeId))) return refused('AUTHENTICITY_UNVERIFIED');
    const witness = await fvRegistrarInternals.connectWitness(registrar);
    if (witness === undefined) return refused('WITNESS_UNAVAILABLE');
    const opened = await fvRegisteredStoreAccess.openStore(registrar, config.relyingParty, record, current, witness.boundary);
    if (!('history' in opened)) return fromShared(opened);
    try {
      return await use(record, current, opened, witness.anchor);
    } finally {
      opened.close();
    }
  } finally {
    record.close();
  }
}

/**
 * Revokes one FV operator credential: the store's FV administrator authorizes exactly that revocation at the store's
 * current head; AUTH-03 verifies it against the signed history and appends one row. `revoked` only once the verified
 * store holds it and the witness confirms that head.
 */
export async function revokeFvOperatorCredential(
  options: FvRevocationOptions,
  request: {
    readonly requestId: string;
    readonly operatorId: string;
    readonly credentialId: string;
    readonly reason: FvRevocationReason;
    readonly administratorOperatorId: string;
    readonly administratorCredentialId: string;
    readonly lifetimeSeconds?: number;
    readonly administrator: (options: AuthenticationOptionsJSON) => unknown;
  },
): Promise<FvRevocationOutcome> {
  const config = configurationOf(options);
  fvRegistrarInternals.platformOrThrow();
  const { requestId, operatorId, credentialId, reason, administratorOperatorId, administratorCredentialId, administrator } = request ?? ({} as Partial<typeof request>);
  const lifetime = request?.lifetimeSeconds ?? DEFAULT_LIFETIME_SECONDS;
  if (
    typeof requestId !== 'string' || !REQUEST_ID.test(requestId) ||
    typeof operatorId !== 'string' || !OPERATOR_ID.test(operatorId) ||
    typeof credentialId !== 'string' || credentialId.length === 0 || credentialId.length > 1_024 ||
    !(FV_REVOCATION_REASONS as readonly unknown[]).includes(reason) ||
    typeof administratorOperatorId !== 'string' || !OPERATOR_ID.test(administratorOperatorId) ||
    typeof administratorCredentialId !== 'string' || administratorCredentialId.length === 0 || administratorCredentialId.length > 1_024 ||
    typeof administrator !== 'function' ||
    !Number.isSafeInteger(lifetime) || lifetime < 1 || lifetime > FV_REVOCATION_AUTHORIZATION_MAX_LIFETIME_SECONDS
  ) {
    return refused('REQUEST_INVALID');
  }

  return withRegisteredStore(config, async (record, current, store, anchor) => {
    let events: readonly FvIdentityRegistrationEvent[];
    try {
      events = record.events();
    } catch {
      return refused('RECORD_CORRUPT');
    }
    if (intentsFor(events, requestId).length > 0) return refused('REQUEST_PENDING');
    let history: ReturnType<HumanIdentityStore['history']>;
    let head: ReturnType<HumanIdentityStore['head']>;
    try {
      history = store.history();
      head = store.head();
    } catch {
      return refused('STORE_UNAVAILABLE');
    }
    // Early refusals, before the administrator is asked (AUTH-03 decides them again from the signed history).
    if (fvRolesOf(history).get(administratorOperatorId) !== 'fv-administrator') return refused('NOT_ADMINISTRATOR');
    if (fvOperatorPlanUnfinished(history)) return refused('ENROLLMENT_PENDING');
    if (!(await verifyFvOperatorRoles(history, current.organizationId, config.relyingParty)).has(operatorId)) return refused('NOT_OPERATOR');
    const target = history.find((row) => row.kind === 'credential_registered' && row.objectId === credentialId && row.operatorId === operatorId);
    const publicKey = target === undefined ? undefined : (JSON.parse(target.payload) as { publicKey?: unknown }).publicKey;
    if (target === undefined || typeof publicKey !== 'string') return refused('TARGET_CREDENTIAL_UNKNOWN');

    const notBefore = new Date(config.registrar.clock());
    const authorization: FvRevocationAuthorization = Object.freeze({
      format: FV_REVOCATION_AUTHORIZATION_FORMAT,
      action: FV_REVOCATION_ACTION,
      requestId,
      organizationId: current.organizationId,
      deploymentId: current.deploymentId,
      stateKind: FV_BOOTSTRAP_IDENTITY_STATE_KIND,
      storeId: current.storeId,
      witnessId: current.witnessId,
      witnessKeyDigest: current.witnessKeyDigest,
      priorHead: Object.freeze({ sequence: head.sequence, chainDigest: head.chainDigest }),
      administrator: Object.freeze({ operatorId: administratorOperatorId, credentialId: administratorCredentialId }),
      target: Object.freeze({ operatorId, credentialId, credentialDigest: firstAdministratorCredentialDigest({ credentialId, publicKey }) }),
      reason,
      notBefore: notBefore.toISOString(),
      notAfter: new Date(notBefore.getTime() + lifetime * 1000).toISOString(),
    });
    let administratorAssertion: unknown;
    try {
      administratorAssertion = plain(await administrator(fvRevocationAdministratorOptions({ relyingParty: config.relyingParty, authorization, timeoutSeconds: PROOF_TIMEOUT_SECONDS })));
    } catch {
      return refused('ADMINISTRATOR_PROOF_INVALID');
    }
    const evidence: FvRevocationEvidence = Object.freeze({ authorization, administratorAssertion });
    const verification = await verifyFvRevocationEvidence(history, store, evidence, { relyingParty: config.relyingParty, expected: expectationOf(current), now: new Date(config.registrar.clock()) });
    if (!verification.verified) return fromVerification(verification.reason);
    observe(config, 'administrator-verified');
    try {
      record.appendEvent(isoOf(config), INTENT_EVENT, JSON.stringify({ requestId, evidence }));
    } catch {
      return refused('RECORD_UNAVAILABLE');
    }
    observe(config, 'intent-recorded');
    return complete(config, record, store, anchor, current, evidence);
  });
}

/**
 * Continues a revocation a crash or a lost witness answer left recorded but unconfirmed. The recorded evidence is
 * re-verified against the signed history (it authorizes nothing by being recorded): with its row not written, the
 * window must still be open, the head unchanged and the credential still active (otherwise authorize it again); with
 * its row written, it is confirmed. Every recorded copy for the request is tried.
 */
export async function resumeFvOperatorRevocation(options: FvRevocationOptions, request: { readonly requestId: string }): Promise<FvRevocationOutcome> {
  const config = configurationOf(options);
  fvRegistrarInternals.platformOrThrow();
  const requestId = request?.requestId;
  if (typeof requestId !== 'string' || !REQUEST_ID.test(requestId)) return refused('REQUEST_INVALID');
  return withRegisteredStore(config, async (record, current, store, anchor) => {
    let events: readonly FvIdentityRegistrationEvent[];
    try {
      events = record.events();
    } catch {
      return refused('RECORD_CORRUPT');
    }
    const recorded = intentsFor(events, requestId);
    if (recorded.length === 0) return refused('NO_REQUEST');
    let history: ReturnType<HumanIdentityStore['history']>;
    try {
      history = store.history();
    } catch {
      return refused('STORE_UNAVAILABLE');
    }
    const context = { relyingParty: config.relyingParty, expected: expectationOf(current), now: new Date(config.registrar.clock()) };
    let first: FvRevocationRefusal | undefined;
    for (const evidence of recorded) {
      const verification = await verifyFvRevocationEvidence(history, store, evidence, context);
      if (verification.verified) return complete(config, record, store, anchor, current, evidence);
      first ??= verification.reason;
    }
    return fromVerification(first ?? 'MALFORMED');
  });
}
