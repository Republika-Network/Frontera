import { createHash, randomBytes } from 'node:crypto';

import type { AuthorityStateFreshnessAnchor } from '../authority-state-freshness/index.js';
import { firstAdministratorCredentialDigest } from '../human-identity/first-administrator.js';
import { FV_OPERATOR_ROLE, fvRolesOf } from '../human-identity/fv-domain.js';
import {
  FV_OPERATOR_AUTHORIZATION_FORMAT,
  FV_OPERATOR_AUTHORIZATION_MAX_LIFETIME_SECONDS,
  FV_OPERATOR_ENROLL_ACTION,
  FvOperatorRefusedError,
  appendFvOperator,
  fvOperatorAdministratorOptions,
  fvOperatorPlanUnfinished,
  fvOperatorCandidateOptions,
  verifyFvOperatorCandidate,
  verifyFvOperatorEvidence,
  type FvOperatorAuthorization,
  type FvOperatorEvidence,
  type FvOperatorRefusal,
} from '../human-identity/fv-operator.js';
import { FV_BOOTSTRAP_IDENTITY_STATE_KIND, type AuthenticationOptionsJSON, type HumanIdentityStore, type RegistrationOptionsJSON, type RelyingPartyConfiguration } from '../human-identity/index.js';
import type { FvIdentityRegistrationEvent, FvIdentityRegistrationRecord, FvRegistrationRecordFile } from './identity-registration-record.js';
import { fvRegisteredStoreAccess } from './identity-registration-first-administrator.js';
import { FvIdentityRegistrationError, fvRegistrarInternals, type FvIdentityRegistrarOptions, type FvRegistrarConfiguration } from './identity-registration.js';

/**
 * FV-P4C-2B3C-2A2B — enrolment of an **FV operator** under the authority of the registered FV store's administrator
 * (internal and non-operational: nothing in the Host, its scripts, its deployment, the dedicated executor or its
 * supervisor invokes it; structure tests pin this). See
 * `docs/integration/FV_IDENTITY_REGISTRATION_AND_OPERATOR_LIFECYCLE.md` §16.
 *
 * An offline ceremony that holds the registration record and the registered store exclusively:
 * 1. The registration must be `registered`, for exactly this configuration, on its reserved file; the store is
 *    opened as its exclusive, pinned, FV-domain owner under CORE-07 freshness.
 * 2. The candidate proves possession first (a passkey attestation over a challenge derived from the request id).
 * 3. The administrator then authorizes exactly that enrolment: a WebAuthn assertion, by one of its own credentials,
 *    over the commitment to a contract naming the organization, deployment, store, witness, the store's **current
 *    head**, the administrator, the candidate and its proven credential, the role `fv-operator`, the request id and
 *    a validity window (≤ 300 s).
 * 4. AUTH-03 (`human-identity/fv-operator.ts`) verifies all of it against the store's own signed history — the
 *    administrator's role is read from signed rows — then appends the rows. The first new row consumes the
 *    administrator's challenge and pins the plan.
 * 5. `enrolled` only once the verified store holds every row **and** a fresh witness read shows that head committed.
 *
 * No G-02A capability is involved: the administrator's signed assertion is the authorization, and its single use is
 * a chained, witnessed row of the store itself (bound to the prior head), not a ledger claim. No Host administrator,
 * operator-plane credential, enrolment token or flag is accepted; an FV operator has no administration at all. The
 * record holds only progress: a resume re-verifies the recorded evidence, which no record writer can forge.
 */

const REQUEST_ID = /^fvop-[0-9a-f]{32}$/;
const OPERATOR_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const INTENT_EVENT = 'operator-enrollment-intent';
const ENROLLED_EVENT = 'operator-enrolled';
const PROOF_TIMEOUT_SECONDS = 60;
const DEFAULT_LIFETIME_SECONDS = 120;

export type FvOperatorEnrollmentStep = 'candidate-verified' | 'administrator-verified' | 'intent-recorded' | 'credential_used' | 'principal_created' | 'enrolment_authorized' | 'credential_registered' | 'enrolled';

export interface FvOperatorEnrollmentOptions extends Omit<FvIdentityRegistrarOptions, 'observer'> {
  readonly relyingParty: RelyingPartyConfiguration;
  readonly observer?: (step: FvOperatorEnrollmentStep) => void;
}

export interface FvOperatorEnrollmentEvidence {
  readonly requestId: string;
  readonly organizationId: string;
  readonly storeId: string;
  readonly operatorId: string;
  readonly role: typeof FV_OPERATOR_ROLE;
  readonly credentialId: string;
  readonly credentialDigest: string;
  readonly administratorOperatorId: string;
  readonly authorizedAtSequence: number;
  readonly storeSequence: number;
}

export const FV_OPERATOR_ENROLLMENT_REFUSALS = Object.freeze([
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
  'CANDIDATE_PROOF_INVALID',
  'ADMINISTRATOR_PROOF_INVALID',
  'NOT_ADMINISTRATOR',
  'ADMINISTRATOR_CREDENTIAL_UNUSABLE',
  'CANDIDATE_EXISTS',
  'CREDENTIAL_DUPLICATE',
  'STALE_HEAD',
  'WINDOW_CLOSED',
  'ENROLLMENT_CONFLICT',
  'ENROLLMENT_PENDING',
  'EVIDENCE_INVALID',
] as const);
export type FvOperatorEnrollmentRefusal = (typeof FV_OPERATOR_ENROLLMENT_REFUSALS)[number];

export type FvOperatorEnrollmentOutcome =
  | { readonly outcome: 'enrolled'; readonly evidence: FvOperatorEnrollmentEvidence }
  /** Recorded, not complete: continue with `resumeFvOperatorEnrollment` and the same request id. */
  | { readonly outcome: 'pending'; readonly reason: 'WITNESS_UNAVAILABLE' | 'STORE_UNAVAILABLE' | 'SIGNER_UNAVAILABLE'; readonly requestId: string }
  | { readonly outcome: 'refused'; readonly reason: FvOperatorEnrollmentRefusal; readonly detail?: string };

const refused = (reason: FvOperatorEnrollmentRefusal, detail?: string): FvOperatorEnrollmentOutcome => Object.freeze({ outcome: 'refused' as const, reason, ...(detail !== undefined ? { detail } : {}) });

/** A refusal of the shared helpers, as this ceremony's. */
function fromShared(outcome: { readonly outcome: string; readonly reason?: string; readonly detail?: string }): FvOperatorEnrollmentOutcome {
  const reason = (FV_OPERATOR_ENROLLMENT_REFUSALS as readonly string[]).includes(outcome.reason ?? '') ? (outcome.reason as FvOperatorEnrollmentRefusal) : 'RECORD_UNAVAILABLE';
  return refused(reason, outcome.detail);
}

/** AUTH-03's refusal reasons, as this ceremony's. */
function fromVerification(reason: FvOperatorRefusal): FvOperatorEnrollmentOutcome {
  switch (reason) {
    case 'NOT_ADMINISTRATOR':
    case 'ADMINISTRATOR_CREDENTIAL_UNUSABLE':
    case 'CANDIDATE_EXISTS':
    case 'CREDENTIAL_DUPLICATE':
    case 'STALE_HEAD':
    case 'WINDOW_CLOSED':
      return refused(reason);
    case 'ASSERTION_INVALID':
    case 'COUNTER_REGRESSION':
      return refused('ADMINISTRATOR_PROOF_INVALID', reason);
    case 'ATTESTATION_INVALID':
    case 'CANDIDATE_MISMATCH':
      return refused('CANDIDATE_PROOF_INVALID', reason);
    case 'CONFLICT':
      return refused('ENROLLMENT_CONFLICT');
    case 'PLAN_INCOMPLETE':
      return refused('ENROLLMENT_PENDING');
    default:
      return refused('EVIDENCE_INVALID', reason);
  }
}

interface Configuration {
  readonly registrar: FvRegistrarConfiguration;
  readonly relyingParty: RelyingPartyConfiguration;
  readonly observer: ((step: FvOperatorEnrollmentStep) => void) | undefined;
}

function configurationOf(options: FvOperatorEnrollmentOptions): Configuration {
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

function observe(config: Configuration, step: FvOperatorEnrollmentStep): void {
  try {
    config.observer?.(step);
  } catch {
    // Diagnostics never change the ceremony.
  }
}

const isoOf = (config: Configuration): string => new Date(config.registrar.clock()).toISOString();
const plain = (value: unknown): unknown => JSON.parse(JSON.stringify(value)) as unknown;

function expectationOf(config: Configuration, current: FvIdentityRegistrationRecord) {
  return Object.freeze({ deploymentId: current.deploymentId, stateKind: FV_BOOTSTRAP_IDENTITY_STATE_KIND, witnessId: current.witnessId, witnessKeyDigest: current.witnessKeyDigest });
}

/** The recorded intents for `requestId`, oldest first. Malformed ones are ignored: the store and the signatures decide. */
function intentsFor(events: readonly FvIdentityRegistrationEvent[], requestId: string): readonly FvOperatorEvidence[] {
  const found: FvOperatorEvidence[] = [];
  for (const event of events) {
    if (event.kind !== INTENT_EVENT) continue;
    try {
      const parsed = JSON.parse(event.detail) as { requestId?: unknown; evidence?: unknown };
      if (parsed.requestId === requestId && typeof parsed.evidence === 'object' && parsed.evidence !== null) found.push(parsed.evidence as FvOperatorEvidence);
    } catch {
      continue;
    }
  }
  return found;
}

/**
 * Appends (or completes) the rows of verified evidence, then requires the verified store to hold them all and a fresh
 * witness read to show that head committed with nothing pending. Otherwise `pending`, never `enrolled`.
 */
async function complete(config: Configuration, record: FvRegistrationRecordFile, store: HumanIdentityStore, anchor: AuthorityStateFreshnessAnchor, current: FvIdentityRegistrationRecord, evidence: FvOperatorEvidence): Promise<FvOperatorEnrollmentOutcome> {
  const requestId = evidence.authorization.requestId;
  const pending = (reason: 'WITNESS_UNAVAILABLE' | 'STORE_UNAVAILABLE' | 'SIGNER_UNAVAILABLE'): FvOperatorEnrollmentOutcome => Object.freeze({ outcome: 'pending' as const, reason, requestId });
  const context = { relyingParty: config.relyingParty, expected: expectationOf(config, current), now: new Date(config.registrar.clock()) };
  let appended: Awaited<ReturnType<typeof appendFvOperator>>;
  try {
    appended = await appendFvOperator(store, evidence, context, (kind) => observe(config, kind));
  } catch (error) {
    if (error instanceof FvOperatorRefusedError) return fromVerification(error.reason);
    return pending(fvRegisteredStoreAccess.pendingReason(error));
  }
  // The authoritative readback: every row held, and the witness has committed exactly that head.
  let head: ReturnType<HumanIdentityStore['head']>;
  try {
    const readback = await verifyFvOperatorEvidence(store.history(), store, evidence, context);
    if (!readback.verified || readback.progress !== readback.rows.length) return refused('ENROLLMENT_CONFLICT');
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
    record.appendEvent(isoOf(config), ENROLLED_EVENT, JSON.stringify({ requestId, operatorId: evidence.authorization.candidate.operatorId, credentialId: appended.credential.credentialId }));
  } catch {
    // The signed, witnessed store is the authority and holds the operator.
  }
  observe(config, 'enrolled');
  const { authorization } = evidence;
  return Object.freeze({
    outcome: 'enrolled' as const,
    evidence: Object.freeze({
      requestId,
      organizationId: current.organizationId,
      storeId: current.storeId,
      operatorId: authorization.candidate.operatorId,
      role: FV_OPERATOR_ROLE,
      credentialId: appended.credential.credentialId,
      credentialDigest: firstAdministratorCredentialDigest(appended.credential),
      administratorOperatorId: authorization.administrator.operatorId,
      authorizedAtSequence: authorization.priorHead.sequence,
      storeSequence: head.sequence,
    }),
  });
}

/** Locks the registration and opens its store and witness; runs `use`; closes everything. */
async function withRegisteredStore(config: Configuration, use: (record: FvRegistrationRecordFile, current: FvIdentityRegistrationRecord, store: HumanIdentityStore, anchor: AuthorityStateFreshnessAnchor) => Promise<FvOperatorEnrollmentOutcome>): Promise<FvOperatorEnrollmentOutcome> {
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
 * Enrols one FV operator: the candidate proves possession, the store's FV administrator authorizes exactly that
 * enrolment at the store's current head, AUTH-03 verifies both against the signed history and appends the rows.
 * `enrolled` only once the verified store holds them all and the witness confirms that head.
 */
export async function enrollFvOperator(
  options: FvOperatorEnrollmentOptions,
  request: {
    readonly requestId: string;
    readonly operatorId: string;
    readonly displayName: string;
    readonly administratorOperatorId: string;
    readonly administratorCredentialId: string;
    readonly lifetimeSeconds?: number;
    readonly candidate: (options: RegistrationOptionsJSON) => unknown;
    readonly administrator: (options: AuthenticationOptionsJSON) => unknown;
  },
): Promise<FvOperatorEnrollmentOutcome> {
  const config = configurationOf(options);
  fvRegistrarInternals.platformOrThrow();
  const { requestId, operatorId, displayName, administratorOperatorId, administratorCredentialId, candidate, administrator } = request ?? ({} as Partial<typeof request>);
  const lifetime = request?.lifetimeSeconds ?? DEFAULT_LIFETIME_SECONDS;
  if (
    typeof requestId !== 'string' || !REQUEST_ID.test(requestId) ||
    typeof operatorId !== 'string' || !OPERATOR_ID.test(operatorId) ||
    typeof displayName !== 'string' || displayName.trim() !== displayName || displayName.length === 0 || displayName.length > 128 ||
    typeof administratorOperatorId !== 'string' || !OPERATOR_ID.test(administratorOperatorId) ||
    typeof administratorCredentialId !== 'string' || administratorCredentialId.length === 0 || administratorCredentialId.length > 1_024 ||
    typeof candidate !== 'function' || typeof administrator !== 'function' ||
    !Number.isSafeInteger(lifetime) || lifetime < 1 || lifetime > FV_OPERATOR_AUTHORIZATION_MAX_LIFETIME_SECONDS
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

    // Early refusals, before any human is asked (AUTH-03 decides them again from the signed history).
    let history: ReturnType<HumanIdentityStore['history']>;
    let head: ReturnType<HumanIdentityStore['head']>;
    try {
      history = store.history();
      head = store.head();
    } catch {
      return refused('STORE_UNAVAILABLE');
    }
    if (fvRolesOf(history).get(administratorOperatorId) !== 'fv-administrator') return refused('NOT_ADMINISTRATOR');
    // Codex P2 (PR #267): another enrolment's plan is unfinished; it is resumed first, never stranded.
    if (fvOperatorPlanUnfinished(history)) return refused('ENROLLMENT_PENDING');
    if (history.some((row) => row.kind === 'principal_created' && row.operatorId === operatorId)) return refused('CANDIDATE_EXISTS');

    // 1. The candidate proves possession.
    const issued = fvOperatorCandidateOptions({ relyingParty: config.relyingParty, requestId, operatorId, displayName, timeoutSeconds: PROOF_TIMEOUT_SECONDS, excludeCredentialIds: [] });
    let candidateAttestation: unknown;
    let credential: Awaited<ReturnType<typeof verifyFvOperatorCandidate>>;
    try {
      candidateAttestation = plain(await candidate(issued.options));
      credential = await verifyFvOperatorCandidate({ relyingParty: config.relyingParty, requestId, nonce: issued.nonce, response: candidateAttestation });
    } catch {
      return refused('CANDIDATE_PROOF_INVALID');
    }
    observe(config, 'candidate-verified');

    // 2. The administrator authorizes exactly this enrolment, at the store's current head.
    const notBefore = new Date(config.registrar.clock());
    const authorization: FvOperatorAuthorization = Object.freeze({
      format: FV_OPERATOR_AUTHORIZATION_FORMAT,
      action: FV_OPERATOR_ENROLL_ACTION,
      requestId,
      organizationId: current.organizationId,
      deploymentId: current.deploymentId,
      stateKind: FV_BOOTSTRAP_IDENTITY_STATE_KIND,
      storeId: current.storeId,
      witnessId: current.witnessId,
      witnessKeyDigest: current.witnessKeyDigest,
      priorHead: Object.freeze({ sequence: head.sequence, chainDigest: head.chainDigest }),
      administrator: Object.freeze({ operatorId: administratorOperatorId, credentialId: administratorCredentialId }),
      candidate: Object.freeze({ operatorId, displayName, userHandle: issued.userHandle, credentialDigest: firstAdministratorCredentialDigest(credential), attestationChallengeDigest: credential.challengeDigest }),
      role: FV_OPERATOR_ROLE,
      enrolment: Object.freeze({ enrolmentId: `enr-${randomBytes(16).toString('hex')}`, tokenVerifier: createHash('sha256').update(randomBytes(32)).digest('hex') }),
      notBefore: notBefore.toISOString(),
      notAfter: new Date(notBefore.getTime() + lifetime * 1000).toISOString(),
    });
    let administratorAssertion: unknown;
    try {
      administratorAssertion = plain(await administrator(fvOperatorAdministratorOptions({ relyingParty: config.relyingParty, authorization, timeoutSeconds: PROOF_TIMEOUT_SECONDS })));
    } catch {
      return refused('ADMINISTRATOR_PROOF_INVALID');
    }
    const evidence: FvOperatorEvidence = Object.freeze({
      authorization,
      candidateNonce: issued.nonce,
      candidateAttestation,
      administratorAssertion,
    });

    // 3. Everything verified against the signed history, before anything is recorded or written.
    const verification = await verifyFvOperatorEvidence(history, store, evidence, { relyingParty: config.relyingParty, expected: expectationOf(config, current), now: new Date(config.registrar.clock()) });
    if (!verification.verified) return fromVerification(verification.reason);
    observe(config, 'administrator-verified');

    // 4. Progress (not authority), then the rows.
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
 * Continues an operator enrolment a crash or a lost witness answer left recorded but incomplete. The recorded
 * evidence is re-verified against the signed history (it authorizes nothing by being recorded): with no row written
 * yet, the window must still be open and the head unchanged (otherwise authorize the enrolment again); with rows
 * written, they must be exactly this plan's. Every recorded copy for the request is tried.
 */
export async function resumeFvOperatorEnrollment(options: FvOperatorEnrollmentOptions, request: { readonly requestId: string }): Promise<FvOperatorEnrollmentOutcome> {
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
    const context = { relyingParty: config.relyingParty, expected: expectationOf(config, current), now: new Date(config.registrar.clock()) };
    let first: FvOperatorRefusal | undefined;
    for (const evidence of recorded) {
      const verification = await verifyFvOperatorEvidence(history, store, evidence, context);
      if (verification.verified) return complete(config, record, store, anchor, current, evidence);
      first ??= verification.reason;
    }
    return fromVerification(first ?? 'MALFORMED');
  });
}
