import { existsSync } from 'node:fs';

import { createAuthoritySignatureRegistry } from '../authority-authenticity/signature-verification.js';
import type { AuthorityStateFreshnessAnchor, AuthorityStateFreshnessBoundary } from '../authority-state-freshness/index.js';
import { createExecutionCapabilityVerifier, executionCapabilityActionBindingDigest, executionCapabilitySigningBytes, parseExecutionCapability, type ExecutionCapabilityVerification, type ExecutionCapabilityVerificationFailure } from '../execution-capability/index.js';
import type { ExecutionCapabilityClaimRefusal, ExecutionCapabilityConsumptionLedger } from '../execution-capability/reference/consumption-ledger.js';
import { canonicalJson, humanIdentityGenesisDigest, type StoredHumanIdentityRow } from '../human-identity/chain.js';
import {
  FV_ADMINISTRATOR_ROLE,
  appendFirstAdministrator,
  firstAdministratorCredentialDigest,
  firstAdministratorPlanOf,
  firstAdministratorProgress,
  firstAdministratorRegistrationOptions,
  newFirstAdministratorPlan,
  verifyFirstAdministratorAttestation,
  type FirstAdministratorPlan,
} from '../human-identity/first-administrator.js';
import { FV_BOOTSTRAP_IDENTITY_STATE_KIND, HumanIdentityError, openSqliteHumanIdentityStore, type HumanIdentityStore, type RegistrationOptionsJSON, type RelyingPartyConfiguration } from '../human-identity/index.js';
import { checkProtectedFile, confirmExclusivelyHeld, exclusiveCloser, heldByAnotherProcess, type ProtectedPathRefusal } from './executor-exclusivity.js';
import { fileIdentityOf, type FvIdentityRegistrationEvent, type FvIdentityRegistrationRecord, type FvRegistrationRecordFile } from './identity-registration-record.js';
import { FvIdentityRegistrationError, fvIdentityRegistrationResource, fvRegistrarInternals, type FvIdentityRegistrarOptions, type FvIdentityRegistrationOutcome, type FvRegistrarConfiguration } from './identity-registration.js';

/**
 * FV-P4C-2B3C-2A2A — enrolment of the **first FV administrator** of a registered FV bootstrap identity store
 * (internal and non-operational: nothing in the Host, its scripts, its deployment, the dedicated executor or
 * its supervisor invokes it; structure tests pin this). See
 * `docs/integration/FV_IDENTITY_REGISTRATION_AND_OPERATOR_LIFECYCLE.md` §15.
 *
 * - **Authority.** A G-02A capability for `frontera.fv-bootstrap-identity.enroll-first-administrator`, from a
 *   pinned **registration** issuer (independent of the store and of the Host), verified by G-02A's verifier
 *   against an action binding the ceremony recomputes: the registration (id, store id, path, witness id and
 *   key, deployment, signing key), the store's head **at its genesis** (sequence 0), the candidate's operator
 *   id and display name, and the relying party. Its execution id is the enrolment id. No Host administrator,
 *   operator-plane credential, enrolment token or configuration flag is accepted. The administrator never
 *   authorizes itself, and running the ceremony makes no one an administrator.
 * - **Registered store only.** The registration record must be `registered`, for exactly this configuration,
 *   authorized by a pinned issuer's signature, on the file it reserved; the store is opened only as its
 *   exclusive, pinned, FV-domain owner under CORE-07 freshness, and must hold **no row at all**.
 * - **Proof of possession before consumption.** The candidate's authenticator answers a challenge derived
 *   from the capability's id and a fresh nonce; the attestation is verified (pinned RP ID and origins, user
 *   verification) before the capability is consumed. A failed or refused authenticator consumes nothing.
 * - **One-time, from evidence.** The capability is consumed in G-02A's ledger (with HF01's claim-intent and
 *   refusal events); then the whole plan (the stored capability, the nonce, the raw attestation and the rows)
 *   is recorded in the registration record before the store is written; then the three rows are appended, each
 *   signed, chained and witnessed. A crash or a lost witness answer is `pending`; completing needs a separate
 *   single-use **resume** capability that names exactly the recorded credential, and re-verifies both the
 *   stored capability's signature and the stored attestation. The store's own rule (only an empty store, only
 *   this plan's prefix) makes a second administrator by this path impossible.
 *
 * Further operators (an FV administrator's decision) and revocation are B3C-2A2B and B3C-2A3: not here.
 * It never returns a store, a handle, a key or a capability: only non-secret evidence.
 */

export const FV_FIRST_ADMINISTRATOR_BINDING_FORMAT = 'frontera.fv-first-administrator-binding.v1';
export const FV_FIRST_ADMINISTRATOR_ACTIONS = Object.freeze({ enroll: 'frontera.fv-bootstrap-identity.enroll-first-administrator', resume: 'frontera.fv-bootstrap-identity.resume-first-administrator' } as const);
export type FvFirstAdministratorOperation = keyof typeof FV_FIRST_ADMINISTRATOR_ACTIONS;

const ENROLLMENT_ID = /^fvadm-[0-9a-f]{32}$/;
const OPERATOR_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const INTENT_EVENT = 'first-administrator-intent';
const ENROLLED_EVENT = 'first-administrator-enrolled';
const RESUME_EVENT = 'first-administrator-resume-authorized';
/** How long the candidate's authenticator may take (seconds). The capability's own window (≤ 60 s) is re-checked after it answers. */
const AUTHENTICATOR_TIMEOUT_SECONDS = 60;

/** Exactly what a first-administrator capability's action binding commits to. Recomputed by the ceremony; never handed in. */
export interface FvFirstAdministratorBindingValue {
  readonly operation: FvFirstAdministratorOperation;
  readonly enrollmentId: string;
  readonly registrationId: string;
  readonly organizationId: string;
  readonly stateKind: typeof FV_BOOTSTRAP_IDENTITY_STATE_KIND;
  readonly deploymentId: string;
  readonly witnessId: string;
  readonly witnessKeyDigest: string;
  readonly storeId: string;
  readonly storePath: string;
  readonly authenticityKeyId: string;
  /** The store's head the enrolment starts from: its genesis. A store holding any row is never this head. */
  readonly storeHeadSequence: 0;
  readonly storeHeadDigest: string;
  readonly operatorId: string;
  readonly displayName: string;
  readonly role: typeof FV_ADMINISTRATOR_ROLE;
  readonly rpId: string;
  /** `null` to enrol; for a resume, exactly the recorded credential (`firstAdministratorCredentialDigest`). */
  readonly credentialDigest: string | null;
}

export function fvFirstAdministratorBinding(value: FvFirstAdministratorBindingValue): { readonly format: typeof FV_FIRST_ADMINISTRATOR_BINDING_FORMAT; readonly value: FvFirstAdministratorBindingValue } {
  return Object.freeze({ format: FV_FIRST_ADMINISTRATOR_BINDING_FORMAT, value: Object.freeze({ ...value }) });
}

/** Durable steps, reported after each commits. Diagnostics only: the return value is ignored, and a throw is swallowed. */
export type FvFirstAdministratorStep = 'attestation-verified' | 'capability-claimed' | 'intent-recorded' | 'principal_created' | 'enrolment_authorized' | 'credential_registered' | 'enrolled';

export interface FvFirstAdministratorOptions extends Omit<FvIdentityRegistrarOptions, 'observer'> {
  /** The relying party the FV executor's identity service is configured with: the credential is bound to it. */
  readonly relyingParty: RelyingPartyConfiguration;
  readonly observer?: (step: FvFirstAdministratorStep) => void;
}

/** The candidate's authenticator: answers the creation options with a WebAuthn registration response. */
export type FvFirstAdministratorAuthenticator = (options: RegistrationOptionsJSON) => unknown;

export interface FvFirstAdministratorEvidence {
  readonly enrollmentId: string;
  readonly registrationId: string;
  readonly organizationId: string;
  readonly storeId: string;
  readonly operatorId: string;
  readonly role: typeof FV_ADMINISTRATOR_ROLE;
  readonly credentialId: string;
  readonly credentialDigest: string;
  readonly capabilityId: string;
  readonly capabilityIssuer: string;
  /** The store's head after the enrolment: the three rows. */
  readonly storeSequence: 3;
}

export const FV_FIRST_ADMINISTRATOR_REFUSALS = Object.freeze([
  'REQUEST_INVALID',
  'CAPABILITY_REJECTED',
  'CAPABILITY_NOT_CLAIMED',
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
  'STORE_NOT_EMPTY',
  'ATTESTATION_INVALID',
  'LEDGER_UNAVAILABLE',
  'ALREADY_ENROLLED',
  'ENROLLMENT_PENDING',
  'NO_ENROLLMENT',
  'ENROLLMENT_CONFLICT',
] as const);
export type FvFirstAdministratorRefusal = (typeof FV_FIRST_ADMINISTRATOR_REFUSALS)[number];

export type FvFirstAdministratorPendingReason = 'WITNESS_UNAVAILABLE' | 'STORE_UNAVAILABLE' | 'SIGNER_UNAVAILABLE';

export type FvFirstAdministratorOutcome =
  | { readonly outcome: 'enrolled'; readonly evidence: FvFirstAdministratorEvidence }
  /** Recorded and authorized, not complete: continue with a resume capability naming `credentialDigest`. */
  | { readonly outcome: 'pending'; readonly reason: FvFirstAdministratorPendingReason; readonly enrollmentId: string; readonly operatorId: string; readonly credentialId: string; readonly credentialDigest: string }
  | { readonly outcome: 'refused'; readonly reason: FvFirstAdministratorRefusal; readonly detail?: ExecutionCapabilityVerificationFailure | ExecutionCapabilityClaimRefusal | ProtectedPathRefusal | string };

const refused = (reason: FvFirstAdministratorRefusal, detail?: string): FvFirstAdministratorOutcome => Object.freeze({ outcome: 'refused' as const, reason, ...(detail !== undefined ? { detail } : {}) });

/** The registrar's refusal (from its shared helpers), as this ceremony's. */
function fromRegistrar(outcome: FvIdentityRegistrationOutcome): FvFirstAdministratorOutcome {
  if (outcome.outcome !== 'refused') return refused('RECORD_UNAVAILABLE');
  const known = (FV_FIRST_ADMINISTRATOR_REFUSALS as readonly string[]).includes(outcome.reason) ? (outcome.reason as FvFirstAdministratorRefusal) : 'RECORD_UNAVAILABLE';
  return refused(known, outcome.detail);
}

interface Configuration {
  readonly registrar: FvRegistrarConfiguration;
  readonly relyingParty: RelyingPartyConfiguration;
  readonly observer: ((step: FvFirstAdministratorStep) => void) | undefined;
}

function configurationOf(options: FvFirstAdministratorOptions): Configuration {
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

function observe(config: Configuration, step: FvFirstAdministratorStep): void {
  try {
    config.observer?.(step);
  } catch {
    // Diagnostics never change the ceremony.
  }
}

const iso = (config: Configuration): string => new Date(config.registrar.clock()).toISOString();

function bindingOf(config: Configuration, record: FvIdentityRegistrationRecord, operation: FvFirstAdministratorOperation, input: { readonly enrollmentId: string; readonly operatorId: string; readonly displayName: string; readonly credentialDigest: string | null }): FvFirstAdministratorBindingValue {
  return {
    operation,
    enrollmentId: input.enrollmentId,
    registrationId: record.registrationId,
    organizationId: record.organizationId,
    stateKind: FV_BOOTSTRAP_IDENTITY_STATE_KIND,
    deploymentId: record.deploymentId,
    witnessId: record.witnessId,
    witnessKeyDigest: record.witnessKeyDigest,
    storeId: record.storeId,
    storePath: record.storePath,
    authenticityKeyId: record.authenticityKeyId,
    storeHeadSequence: 0,
    storeHeadDigest: humanIdentityGenesisDigest(record.storeId, record.organizationId),
    operatorId: input.operatorId,
    displayName: input.displayName,
    role: FV_ADMINISTRATOR_ROLE,
    rpId: config.relyingParty.rpId,
    credentialDigest: input.credentialDigest,
  };
}

function verifierOf(config: Configuration) {
  const { registrar } = config;
  return createExecutionCapabilityVerifier({ trustedIssuers: registrar.trustedIssuers, executor: { audience: registrar.audience, organizationIds: [registrar.organizationId], trustDomain: registrar.trustDomain }, clock: registrar.clock });
}

/**
 * The registration record, locked: `registered`, for exactly this configuration, authorized by a pinned
 * issuer's signature over its binding, on the very file the registration reserved. Anything else is refused.
 */
async function registeredRecord(config: Configuration): Promise<{ readonly record: FvRegistrationRecordFile; readonly current: FvIdentityRegistrationRecord } | FvFirstAdministratorOutcome> {
  const { registrar } = config;
  const refusal = checkProtectedFile(registrar.recordPath);
  if (refusal !== undefined) return existsSync(registrar.recordPath) ? refused('PATH_REFUSED', `record:${refusal}`) : refused('NO_REGISTRATION');
  const opened = await fvRegistrarInternals.openRecord(registrar, false);
  if (!('read' in opened)) return fromRegistrar(opened);
  const record = opened;
  const fail = (outcome: FvFirstAdministratorOutcome): FvFirstAdministratorOutcome => {
    record.close();
    return outcome;
  };
  let current: FvIdentityRegistrationRecord | undefined;
  try {
    current = record.read();
  } catch {
    return fail(refused('RECORD_CORRUPT'));
  }
  if (current === undefined) return fail(refused('NO_REGISTRATION'));
  if (current.state === 'quarantined') return fail(refused('REGISTRATION_QUARANTINED'));
  if (current.state !== 'registered') return fail(refused('REGISTRATION_PENDING'));
  if (!fvRegistrarInternals.configurationMatches(registrar, current)) return fail(refused('CONFIGURATION_MISMATCH'));
  if (!fvRegistrarInternals.registrationAuthorized(current, registrar)) return fail(refused('RECORD_CORRUPT', 'AUTHORIZATION_UNVERIFIED'));
  if (current.storeFileIdentity === null || fileIdentityOf(current.storePath) !== current.storeFileIdentity) return fail(refused('STORE_FILE_MISMATCH'));
  return { record, current };
}

/** Opens the registered store as its exclusive, pinned, FV-domain owner under freshness; never creates it. A refusal is reported, never classified as evidence about the registration. */
async function openStore(config: Configuration, record: FvRegistrationRecordFile, current: FvIdentityRegistrationRecord, boundary: AuthorityStateFreshnessBoundary): Promise<HumanIdentityStore | FvFirstAdministratorOutcome> {
  const { registrar } = config;
  const { storePath, storeId, storeFileIdentity } = current;
  const fence = (): void => {
    if (!(record.held() && checkProtectedFile(storePath) === undefined && confirmExclusivelyHeld([storePath]) && fileIdentityOf(storePath) === storeFileIdentity)) throw new Error('the first-administrator ceremony does not hold the registered store');
  };
  if (checkProtectedFile(storePath) !== undefined) return refused('STORE_FILE_MISMATCH');
  try {
    return await openSqliteHumanIdentityStore(storePath, {
      organizationId: registrar.organizationId,
      now: () => iso(config),
      authenticity: registrar.authenticity,
      freshness: Object.freeze({ boundary, stateKind: FV_BOOTSTRAP_IDENTITY_STATE_KIND }),
      exclusive: { beforeWrite: fence, closer: exclusiveCloser, storeId },
    });
  } catch (error) {
    if (heldByAnotherProcess(storePath)) return refused('STORE_HELD');
    const code = fvRegistrarInternals.freshnessCode(error);
    if (code !== undefined) return fvRegistrarInternals.witnessEvidenceCodes.has(code) ? refused('STORE_REFUSED', code) : refused('WITNESS_UNAVAILABLE', code);
    if (error instanceof HumanIdentityError) return error.code === 'HUMAN_IDENTITY_STORE_UNAVAILABLE' ? refused('STORE_UNAVAILABLE') : refused('STORE_REFUSED', error.code);
    return refused('STORE_UNAVAILABLE');
  }
}

/** A failed append: what is known about it. A write that may have reached the witness is never success. */
function pendingReason(error: unknown): FvFirstAdministratorPendingReason {
  if ((error as { name?: unknown }).name === 'AuthoritySigningUnavailableError') return 'SIGNER_UNAVAILABLE';
  if (fvRegistrarInternals.freshnessCode(error) !== undefined) return 'WITNESS_UNAVAILABLE';
  return 'STORE_UNAVAILABLE';
}

/** The ledger's advisory statement of what became of a consumed capability. Never changes the enrolment. */
function settle(ledger: ExecutionCapabilityConsumptionLedger, capabilityId: string, state: 'completed' | 'failed' | 'outcome-unknown'): void {
  try {
    ledger.recordOutcome(capabilityId, state);
  } catch {
    // Advisory.
  }
}

/** Consumes `verification`'s capability under HF01's ownership evidence. `undefined` when claimed; otherwise the refusal (nothing consumed unless `detail` says so). */
function claim(config: Configuration, record: FvRegistrationRecordFile, ledger: ExecutionCapabilityConsumptionLedger, operation: 'enroll-first-administrator' | 'resume-first-administrator', verification: Extract<ExecutionCapabilityVerification, { readonly verification: 'verified' }>): FvFirstAdministratorOutcome | undefined {
  const { registrar } = config;
  fvRegistrarInternals.settleOrphans(ledger, record, registrar.organizationId);
  const intent = fvRegistrarInternals.claimIntentRefusal(fvRegistrarInternals.recordClaimIntent(registrar, record, ledger, operation, verification.capability));
  if (intent !== undefined) return fromRegistrar(intent);
  let claimed: ReturnType<ExecutionCapabilityConsumptionLedger['claim']>;
  try {
    claimed = ledger.claim(verification);
  } catch {
    fvRegistrarInternals.recordClaimRefused(registrar, record, verification.capability.capabilityId);
    return refused('LEDGER_UNAVAILABLE');
  }
  if (claimed.outcome !== 'claimed') {
    fvRegistrarInternals.recordClaimRefused(registrar, record, verification.capability.capabilityId);
    return refused('CAPABILITY_NOT_CLAIMED', claimed.reason);
  }
  observe(config, 'capability-claimed');
  return undefined;
}

interface RecordedIntent {
  readonly enrollmentId: string;
  readonly capabilityId: string;
  readonly capabilityIssuer: string;
  readonly capability: string;
  readonly signature: unknown;
  readonly nonce: string;
  readonly attestation: unknown;
  readonly plan: FirstAdministratorPlan;
}

/**
 * The enrolment events of a record: every recorded intent, oldest first, and whether one completed. More than one
 * intent is normal: an intent whose ceremony stopped before the store was written is superseded by a new
 * enrolment. Which intent is real is decided by the store (its first row pins its plan), never by the record.
 */
function enrollmentEvents(events: readonly FvIdentityRegistrationEvent[]): { readonly intents: readonly RecordedIntent[]; readonly enrolled: boolean } | 'corrupt' {
  const enrolled = events.some((event) => event.kind === ENROLLED_EVENT);
  const intents: RecordedIntent[] = [];
  for (const event of events) {
    if (event.kind !== INTENT_EVENT) continue;
    // A malformed intent is ignored, never fatal: the store decides which intent is real, and a record its host's
    // user wrote garbage into must not block a genuine enrolment (publication review, finding 1).
    try {
      const parsed = JSON.parse(event.detail) as Record<string, unknown>;
      const { enrollmentId, capabilityId, capabilityIssuer, capability, signature, nonce, attestation, plan } = parsed;
      if (typeof enrollmentId !== 'string' || !ENROLLMENT_ID.test(enrollmentId) || typeof capabilityId !== 'string' || typeof capabilityIssuer !== 'string' || typeof capability !== 'string' || typeof nonce !== 'string') continue;
      intents.push(Object.freeze({ enrollmentId, capabilityId, capabilityIssuer, capability, signature, nonce, attestation, plan: firstAdministratorPlanOf(plan) }));
    } catch {
      continue;
    }
  }
  return { intents, enrolled };
}

/** Every recorded intent the store's own rows are the beginning of (its first row pins the whole plan). */
function intentsInStore(history: readonly StoredHumanIdentityRow[], intents: readonly RecordedIntent[]): readonly { readonly intent: RecordedIntent; readonly progress: number }[] {
  if (history.length === 0) return [];
  return intents.flatMap((intent) => {
    const progress = firstAdministratorProgress(history, intent.plan);
    return progress !== undefined && progress >= 1 ? [{ intent, progress }] : [];
  });
}

/**
 * Whether a recorded intent is what it claims: its stored capability is the canonical text a pinned issuer key
 * signed, for the enrol action, this organization, audience and trust domain, the intent's enrolment id as its
 * execution, and exactly the binding the record and the plan recompute to; the plan names that capability;
 * and the stored attestation, verified again against that capability's challenge, proves exactly the plan's
 * credential. A rewritten intent is never continued.
 */
async function intentAuthorized(config: Configuration, current: FvIdentityRegistrationRecord, intent: RecordedIntent): Promise<boolean> {
  const { registrar } = config;
  try {
    const parsed = parseExecutionCapability(intent.capability);
    if (!parsed.ok) return false;
    const capability = parsed.capability;
    const signature = intent.signature as { keyId?: unknown } | null;
    const pinned = registrar.trustedIssuers.filter((entry) => entry?.issuer === capability.issuer);
    if (pinned.length !== 1 || signature === null || typeof signature !== 'object' || signature.keyId !== capability.issuerKeyId) return false;
    const registry = createAuthoritySignatureRegistry(pinned[0]!.keys);
    if (!registry.keyIds.includes(capability.issuerKeyId) || !registry.verify(executionCapabilitySigningBytes(capability), signature as Parameters<typeof registry.verify>[1]).verified) return false;
    const { plan } = intent;
    const digest = executionCapabilityActionBindingDigest(fvFirstAdministratorBinding(bindingOf(config, current, 'enroll', { enrollmentId: intent.enrollmentId, operatorId: plan.operatorId, displayName: plan.displayName, credentialDigest: null })));
    const authorized =
      capability.capabilityId === intent.capabilityId &&
      capability.issuer === intent.capabilityIssuer &&
      capability.action === FV_FIRST_ADMINISTRATOR_ACTIONS.enroll &&
      capability.resource === fvIdentityRegistrationResource(registrar.organizationId) &&
      capability.organizationId === registrar.organizationId &&
      capability.audience === registrar.audience &&
      capability.trustDomain === registrar.trustDomain &&
      capability.executionId === intent.enrollmentId &&
      capability.actionBinding.format === FV_FIRST_ADMINISTRATOR_BINDING_FORMAT &&
      capability.actionBinding.digest === digest &&
      plan.authorization.capabilityId === capability.capabilityId &&
      plan.authorization.issuer === capability.issuer;
    if (!authorized) return false;
    const credential = await verifyFirstAdministratorAttestation({ relyingParty: config.relyingParty, capabilityId: capability.capabilityId, nonce: intent.nonce, response: intent.attestation });
    const exact = (c: typeof credential): string => canonicalJson({ ...c, transports: [...c.transports] });
    return exact(credential) === exact(plan.credential);
  } catch {
    return false;
  }
}

function evidenceOf(current: FvIdentityRegistrationRecord, intent: RecordedIntent): FvFirstAdministratorEvidence {
  return Object.freeze({
    enrollmentId: intent.enrollmentId,
    registrationId: current.registrationId,
    organizationId: current.organizationId,
    storeId: current.storeId,
    operatorId: intent.plan.operatorId,
    role: FV_ADMINISTRATOR_ROLE,
    credentialId: intent.plan.credential.credentialId,
    credentialDigest: firstAdministratorCredentialDigest(intent.plan.credential),
    capabilityId: intent.capabilityId,
    capabilityIssuer: intent.capabilityIssuer,
    storeSequence: 3 as const,
  });
}

/**
 * Appends the recorded plan's missing rows, confirms the verified store holds exactly all three **and** that the
 * witness, read again, has committed that very head with nothing pending, then records completion. A local
 * commit whose witness finalize was not confirmed is `pending` (the next open completes it), never `enrolled`.
 */
async function complete(config: Configuration, record: FvRegistrationRecordFile, store: HumanIdentityStore, anchor: AuthorityStateFreshnessAnchor, current: FvIdentityRegistrationRecord, intent: RecordedIntent): Promise<FvFirstAdministratorOutcome> {
  const pending = (reason: FvFirstAdministratorPendingReason): FvFirstAdministratorOutcome =>
    Object.freeze({ outcome: 'pending' as const, reason, enrollmentId: intent.enrollmentId, operatorId: intent.plan.operatorId, credentialId: intent.plan.credential.credentialId, credentialDigest: firstAdministratorCredentialDigest(intent.plan.credential) });
  try {
    await appendFirstAdministrator(store, intent.plan, (kind) => observe(config, kind));
  } catch (error) {
    if (error instanceof HumanIdentityError && error.code === 'HUMAN_IDENTITY_FIRST_ADMINISTRATOR_CONFLICT') return refused('ENROLLMENT_CONFLICT');
    return pending(pendingReason(error));
  }
  // The authoritative readback: the verified history is exactly the plan, every row of it.
  let progress: number | undefined;
  let head: ReturnType<HumanIdentityStore['head']>;
  try {
    progress = firstAdministratorProgress(store.history(), intent.plan);
    head = store.head();
  } catch (error) {
    return pending(pendingReason(error));
  }
  if (progress !== 3) return refused('ENROLLMENT_CONFLICT');
  let witnessed: Awaited<ReturnType<AuthorityStateFreshnessAnchor['read']>>;
  try {
    witnessed = await anchor.read({ stateKind: FV_BOOTSTRAP_IDENTITY_STATE_KIND, organizationId: current.organizationId });
  } catch {
    return pending('WITNESS_UNAVAILABLE');
  }
  if (!(witnessed.status === 'bound' && witnessed.storeId === current.storeId && witnessed.pending === undefined && witnessed.committed.sequence === head.sequence && witnessed.committed.stateDigest === head.chainDigest)) return pending('WITNESS_UNAVAILABLE');
  try {
    record.appendEvent(iso(config), ENROLLED_EVENT, JSON.stringify({ enrollmentId: intent.enrollmentId, capabilityId: intent.capabilityId, credentialId: intent.plan.credential.credentialId }));
  } catch {
    // The signed, witnessed store is the authority and holds the administrator; a resume records this later.
  }
  observe(config, 'enrolled');
  return Object.freeze({ outcome: 'enrolled' as const, evidence: evidenceOf(current, intent) });
}

/**
 * Enrols the first FV administrator of a registered FV store: verifies the capability, checks the registration
 * and that the store holds nothing, has the candidate's authenticator prove possession, then consumes the
 * capability, records the plan and appends the rows. `enrolled` only once the verified store holds exactly them.
 */
export async function enrollFvFirstAdministrator(
  options: FvFirstAdministratorOptions,
  request: { readonly presentation: unknown; readonly enrollmentId: string; readonly registrationId: string; readonly storeId: string; readonly operatorId: string; readonly displayName: string; readonly authenticator: FvFirstAdministratorAuthenticator },
): Promise<FvFirstAdministratorOutcome> {
  const config = configurationOf(options);
  fvRegistrarInternals.platformOrThrow();
  const { registrar } = config;
  const presentation = fvRegistrarInternals.presentationOf(request?.presentation);
  const { enrollmentId, registrationId, storeId, operatorId, displayName, authenticator } = request ?? ({} as Partial<typeof request>);
  if (presentation === undefined || typeof enrollmentId !== 'string' || !ENROLLMENT_ID.test(enrollmentId) || typeof registrationId !== 'string' || typeof storeId !== 'string' || typeof operatorId !== 'string' || typeof displayName !== 'string' || typeof authenticator !== 'function') return refused('REQUEST_INVALID');
  if (!OPERATOR_ID.test(operatorId) || displayName.trim() !== displayName || displayName.length === 0 || displayName.length > 128) return refused('REQUEST_INVALID');

  // 1. The registration, locked: one ceremony of this record at a time, in any process.
  const locked = await registeredRecord(config);
  if (!('record' in locked)) return locked;
  const { record, current } = locked;
  try {
    if (current.registrationId !== registrationId || current.storeId !== storeId) return refused('CONFIGURATION_MISMATCH');

    // 2. The authorization, against the ceremony's own pins and its own recomputed binding.
    const binding = fvFirstAdministratorBinding(bindingOf(config, current, 'enroll', { enrollmentId, operatorId, displayName, credentialDigest: null }));
    const verify = () => verifierOf(config).verify({ presentation, action: FV_FIRST_ADMINISTRATOR_ACTIONS.enroll, resource: fvIdentityRegistrationResource(registrar.organizationId), actionBinding: binding });
    const verification = verify();
    if (verification.verification !== 'verified') return refused('CAPABILITY_REJECTED', verification.failure);
    if (verification.capability.executionId !== enrollmentId) return refused('CAPABILITY_REJECTED', 'EXECUTION_MISMATCH');

    // 3. The recorded intents. Whether an enrolment exists is decided below by the store, never by the record's
    // events (publication review, finding 1): an intent whose ceremony never wrote the store is superseded.
    let events: ReturnType<typeof enrollmentEvents>;
    try {
      events = enrollmentEvents(record.events());
    } catch {
      return refused('RECORD_CORRUPT');
    }
    if (events === 'corrupt') return refused('RECORD_CORRUPT');
    if (!(await fvRegistrarInternals.authenticityRoundTrips(registrar, current.storeId))) return refused('AUTHENTICITY_UNVERIFIED');

    // 4. The store, exclusively, under freshness: it must hold no row at all.
    const witness = await fvRegistrarInternals.connectWitness(registrar);
    if (witness === undefined) return refused('WITNESS_UNAVAILABLE');
    const opened = await openStore(config, record, current, witness.boundary);
    if (!('history' in opened)) return opened;
    const store = opened;
    try {
      const genesis = humanIdentityGenesisDigest(current.storeId, current.organizationId);
      try {
        const head = store.head();
        const history = store.history();
        if (history.length !== 0 || head.sequence !== 0 || head.chainDigest !== genesis || head.storeId !== current.storeId) {
          const held = intentsInStore(history, events.intents);
          return refused(held.some((entry) => entry.progress === 3) ? 'ALREADY_ENROLLED' : held.length > 0 ? 'ENROLLMENT_PENDING' : 'STORE_NOT_EMPTY');
        }
      } catch {
        return refused('STORE_UNAVAILABLE');
      }

      // 5. Proof of possession, before anything is consumed.
      const capability = verification.capability;
      const issued = firstAdministratorRegistrationOptions({ relyingParty: config.relyingParty, operatorId, displayName, capabilityId: capability.capabilityId, timeoutSeconds: AUTHENTICATOR_TIMEOUT_SECONDS });
      let attestation: unknown;
      let credential: Awaited<ReturnType<typeof verifyFirstAdministratorAttestation>>;
      try {
        attestation = JSON.parse(JSON.stringify(await authenticator(issued.options))) as unknown;
        credential = await verifyFirstAdministratorAttestation({ relyingParty: config.relyingParty, capabilityId: capability.capabilityId, nonce: issued.nonce, response: attestation });
      } catch {
        return refused('ATTESTATION_INVALID');
      }
      // The plan, built and validated before anything is consumed (re-review 1: a credential the plan cannot hold
      // is refused here, never after the capability is spent).
      let plan: FirstAdministratorPlan;
      try {
        plan = newFirstAdministratorPlan({ operatorId, displayName, userHandle: issued.userHandle, recordedAt: iso(config), authorization: { capabilityId: capability.capabilityId, issuer: capability.issuer }, credential });
      } catch {
        return refused('ATTESTATION_INVALID', 'PLAN_UNREPRESENTABLE');
      }
      observe(config, 'attestation-verified');
      // The capability's window again, after the human answered: an expired capability is never consumed.
      const fresh = verify();
      if (fresh.verification !== 'verified' || fresh.capability.capabilityId !== capability.capabilityId) return refused('CAPABILITY_REJECTED', fresh.verification === 'verified' ? 'CAPABILITY_CHANGED' : fresh.failure);

      // 6. Durable single use, then the whole plan, before the store is written.
      const ledger = await fvRegistrarInternals.openLedger(registrar, false);
      if (ledger === undefined) return refused('LEDGER_UNAVAILABLE');
      try {
        const notClaimed = claim(config, record, ledger, 'enroll-first-administrator', fresh);
        if (notClaimed !== undefined) return notClaimed;
        // Earlier intents that never reached the (empty, held) store are superseded. Their claims are left as the
        // ledger holds them: a spent claim decides nothing, and settling claims a record merely names would bypass
        // HF01's ownership rule (re-review 2).
        const intent: RecordedIntent = Object.freeze({ enrollmentId, capabilityId: capability.capabilityId, capabilityIssuer: capability.issuer, capability: presentation.capability, signature: presentation.signature, nonce: issued.nonce, attestation, plan });
        try {
          record.appendEvent(iso(config), INTENT_EVENT, JSON.stringify(intent));
        } catch {
          // Consumed, nothing written to the store: the store is still empty, so a new capability can enrol.
          settle(ledger, capability.capabilityId, 'failed');
          return refused('RECORD_UNAVAILABLE');
        }
        observe(config, 'intent-recorded');

        // 7. The rows, from the evidence just recorded.
        const outcome = await complete(config, record, store, witness.anchor, current, intent);
        settle(ledger, capability.capabilityId, outcome.outcome === 'enrolled' ? 'completed' : outcome.outcome === 'pending' ? 'outcome-unknown' : 'failed');
        return outcome;
      } finally {
        ledger.close();
      }
    } finally {
      store.close();
    }
  } finally {
    record.close();
  }
}

/**
 * Continues a first-administrator enrolment that a crash or a lost witness answer left recorded but
 * incomplete, from its recorded evidence only. Needs its **own** capability (`…resume-first-administrator`),
 * bound to exactly this enrolment and the recorded credential (`credentialDigest`), consumed once. An enrolment
 * the store already holds completely is reported without consuming anything.
 */
export async function resumeFvFirstAdministratorEnrollment(options: FvFirstAdministratorOptions, request: { readonly presentation: unknown }): Promise<FvFirstAdministratorOutcome> {
  const config = configurationOf(options);
  fvRegistrarInternals.platformOrThrow();
  const { registrar } = config;
  const presentation = fvRegistrarInternals.presentationOf(request?.presentation);
  if (presentation === undefined) return refused('REQUEST_INVALID');

  const locked = await registeredRecord(config);
  if (!('record' in locked)) return locked;
  const { record, current } = locked;
  try {
    let events: ReturnType<typeof enrollmentEvents>;
    try {
      events = enrollmentEvents(record.events());
    } catch {
      return refused('RECORD_CORRUPT');
    }
    if (events === 'corrupt') return refused('RECORD_CORRUPT');
    if (events.intents.length === 0) return refused('NO_ENROLLMENT');
    if (!(await fvRegistrarInternals.authenticityRoundTrips(registrar, current.storeId))) return refused('AUTHENTICITY_UNVERIFIED');

    // The store decides which intent is real: its signed, witnessed first row pins that plan (review F1–F3). An
    // empty store holds nothing to continue: the ceremony stopped before writing it, and a new enrolment is the way on.
    const witness = await fvRegistrarInternals.connectWitness(registrar);
    if (witness === undefined) return refused('WITNESS_UNAVAILABLE');
    const opened = await openStore(config, record, current, witness.boundary);
    if (!('history' in opened)) return opened;
    const store = opened;
    try {
      let matching: ReturnType<typeof intentsInStore>;
      let empty: boolean;
      try {
        const history = store.history();
        empty = history.length === 0;
        matching = intentsInStore(history, events.intents);
      } catch {
        return refused('STORE_UNAVAILABLE');
      }
      if (empty) return refused('NO_ENROLLMENT', 'STORE_EMPTY');
      if (matching.length === 0) return refused('ENROLLMENT_CONFLICT');
      // Defence in depth: of the intents the store pins, the one a pinned issuer authorized, for the credential that
      // proved possession. Every candidate is tried, so an inserted copy cannot hide the genuine intent (re-review 3).
      let found: (typeof matching)[number] | undefined;
      for (const candidate of matching) {
        if (await intentAuthorized(config, current, candidate.intent)) {
          found = candidate;
          break;
        }
      }
      if (found === undefined) return refused('RECORD_CORRUPT', 'AUTHORIZATION_UNVERIFIED');
      const { intent, progress } = found;

      const binding = fvFirstAdministratorBinding(bindingOf(config, current, 'resume', { enrollmentId: intent.enrollmentId, operatorId: intent.plan.operatorId, displayName: intent.plan.displayName, credentialDigest: firstAdministratorCredentialDigest(intent.plan.credential) }));
      const verification = verifierOf(config).verify({ presentation, action: FV_FIRST_ADMINISTRATOR_ACTIONS.resume, resource: fvIdentityRegistrationResource(registrar.organizationId), actionBinding: binding });
      if (verification.verification !== 'verified') return refused('CAPABILITY_REJECTED', verification.failure);
      if (verification.capability.executionId === intent.enrollmentId) return refused('CAPABILITY_REJECTED', 'EXECUTION_MISMATCH');

      const ledger = await fvRegistrarInternals.openLedger(registrar, false);
      if (ledger === undefined) return refused('LEDGER_UNAVAILABLE');
      try {
        if (progress === 3) {
          // Already complete in the authoritative store: reported, nothing consumed.
          const outcome = await complete(config, record, store, witness.anchor, current, intent);
          if (outcome.outcome === 'enrolled') settle(ledger, intent.capabilityId, 'completed');
          return outcome;
        }
        const notClaimed = claim(config, record, ledger, 'resume-first-administrator', verification);
        if (notClaimed !== undefined) return notClaimed;
        const capabilityId = verification.capability.capabilityId;
        try {
          record.appendEvent(iso(config), RESUME_EVENT, JSON.stringify({ enrollmentId: intent.enrollmentId, capabilityId, issuer: verification.capability.issuer, capability: presentation.capability, signature: presentation.signature }));
        } catch {
          settle(ledger, capabilityId, 'failed');
          return refused('RECORD_UNAVAILABLE');
        }
        const outcome = await complete(config, record, store, witness.anchor, current, intent);
        settle(ledger, capabilityId, outcome.outcome === 'enrolled' ? 'completed' : outcome.outcome === 'pending' ? 'outcome-unknown' : 'failed');
        // The enrol capability this intent holds is this record's own claim; settled once the enrolment is final.
        if (outcome.outcome === 'enrolled') settle(ledger, intent.capabilityId, 'completed');
        return outcome;
      } finally {
        ledger.close();
      }
    } finally {
      store.close();
    }
  } finally {
    record.close();
  }
}

/** Non-secret view of a registration's first-administrator enrolment, **as its record holds it** (record-only evidence, not authority). */
export type FvFirstAdministratorEnrollmentView =
  | { readonly state: 'none' }
  | { readonly state: 'pending' | 'enrolled'; readonly enrollmentId: string; readonly operatorId: string; readonly credentialId: string; readonly credentialDigest: string; readonly capabilityId: string };

/**
 * What the record says about the first administrator: none, recorded-but-incomplete (`pending`), or `enrolled`.
 * A resume capability names `credentialDigest`; the issuer must confirm that digest with the candidate's own
 * authenticator out of band, because the record can be rewritten by its host's user — a rewritten intent is
 * still refused by the store's pinned first row, but only the issuer can refuse to sign for it. Takes the record's lock (`REGISTRAR_BUSY` while a
 * ceremony runs), writes nothing and contacts nothing. The record is evidence for the operator, not authority:
 * only the signed, witnessed store decides whether the administrator exists.
 */
export async function readFvFirstAdministratorEnrollment(options: FvFirstAdministratorOptions): Promise<FvFirstAdministratorEnrollmentView | Extract<FvFirstAdministratorOutcome, { readonly outcome: 'refused' }>> {
  const config = configurationOf(options);
  fvRegistrarInternals.platformOrThrow();
  const locked = await registeredRecord(config);
  if (!('record' in locked)) return locked as Extract<FvFirstAdministratorOutcome, { readonly outcome: 'refused' }>;
  const { record } = locked;
  try {
    let events: ReturnType<typeof enrollmentEvents>;
    try {
      events = enrollmentEvents(record.events());
    } catch {
      return refused('RECORD_CORRUPT') as Extract<FvFirstAdministratorOutcome, { readonly outcome: 'refused' }>;
    }
    if (events === 'corrupt') return refused('RECORD_CORRUPT') as Extract<FvFirstAdministratorOutcome, { readonly outcome: 'refused' }>;
    // The latest intent: the one a resume would be asked about. Only the store decides whether it is real.
    const intent = events.intents.at(-1);
    if (intent === undefined) return Object.freeze({ state: 'none' as const });
    return Object.freeze({
      state: events.enrolled ? ('enrolled' as const) : ('pending' as const),
      enrollmentId: intent.enrollmentId,
      operatorId: intent.plan.operatorId,
      credentialId: intent.plan.credential.credentialId,
      credentialDigest: firstAdministratorCredentialDigest(intent.plan.credential),
      capabilityId: intent.capabilityId,
    });
  } finally {
    record.close();
  }
}
