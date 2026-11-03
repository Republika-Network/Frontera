import { createHash, createPublicKey } from 'node:crypto';
import { closeSync, existsSync, fstatSync, fsyncSync, lstatSync, openSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { createAuthoritySignatureRegistry } from '../authority-authenticity/signature-verification.js';
import {
  AuthorityStateFreshnessError,
  HOST_IDENTITY_STATE_KIND,
  createAuthorityStateFreshnessBoundary,
  establishAuthorityStateWitness,
  type AuthorityStateFreshnessAnchor,
  type AuthorityStateFreshnessBoundary,
  type AuthorityStateWitnessTransport,
  type PinnedAuthorityStateWitness,
  type WitnessBindingState,
} from '../authority-state-freshness/index.js';
import {
  createExecutionCapabilityVerifier,
  executionCapabilityActionBindingDigest,
  executionCapabilitySigningBytes,
  isExecutionCapabilityIdentifier,
  parseExecutionCapability,
  type ExecutionCapabilityTrustedIssuer,
  type ExecutionCapabilityVerificationFailure,
} from '../execution-capability/index.js';
import { openExecutionCapabilityConsumptionLedger, type ExecutionCapabilityClaimRefusal, type ExecutionCapabilityConsumptionLedger } from '../execution-capability/reference/consumption-ledger.js';
import { humanIdentityGenesisDigest } from '../human-identity/chain.js';
import { FV_BOOTSTRAP_IDENTITY_STATE_KIND, HumanIdentityError, openSqliteHumanIdentityStore, type HumanIdentityStore, type SqliteHumanIdentityStoreOptions } from '../human-identity/index.js';
import { checkProtectedFile, confirmExclusivelyHeld, exclusiveCloser, exclusivitySupported, heldByAnotherProcess, type ProtectedPathRefusal } from './executor-exclusivity.js';
import {
  FvIdentityRegistrationRecordError,
  fileIdentityOf,
  openFvRegistrationRecord,
  readFvRegistrationRecordSnapshot,
  type FvIdentityRegistrationQuarantineReason,
  type FvIdentityRegistrationRecord,
  type FvIdentityRegistrationState,
  type FvRegistrationRecordFile,
} from './identity-registration-record.js';

/**
 * FV-P4C-2B3C-2A1 — the FV bootstrap identity **registration ceremony** (internal and non-operational:
 * nothing in the Host, its scripts, its deployment or the dedicated executor invokes it; structure tests pin
 * this). See `docs/integration/FV_IDENTITY_REGISTRATION_AND_OPERATOR_LIFECYCLE.md`.
 *
 * It is the only path that creates an FV bootstrap identity store, and it creates exactly one per
 * organization, exactly once:
 *
 * 1. **Authority.** A G-02A execution capability (`execution-capability/`), verified by G-02A's standalone
 *    verifier against the registrar's pinned issuers, audience, organization and trust domain, for the
 *    action `frontera.fv-bootstrap-identity.register` and an action binding the registrar **recomputes**
 *    from its own trusted configuration (organization, FV domain, deployment, witness id and key, store
 *    path and policy, signing key) and the two values the issuer chose (the registration id and the store
 *    id). No Host login, operator credential, configuration flag or self-issued token is accepted: only a
 *    signature by a pinned issuer key. Nothing in this repository issues one in production.
 * 2. **One-time.** The capability is consumed in G-02A's durable consumption ledger before anything else
 *    happens, and the consumed capability is kept verbatim in the registration record. The ledger can be
 *    rolled back with its file; the witness's FV slot cannot (it binds once and never rebinds), so a
 *    replay can never create a second store for the organization.
 * 3. **Sequence**, each step recorded before the next externally visible one (the record's states):
 *    - `intent-recorded`: the consumed authorization and the preselected store id, before the witness is
 *      contacted;
 *    - `witness-anchored`: the witness's FV slot, read back through signed receipts, binds exactly this
 *      store id at its genesis;
 *    - the store file reserved with `O_EXCL`, owner-only, its identity recorded before any SQLite content;
 *    - `store-created`: the AUTH-03 store opened with `create`, as its exclusive owner, in the FV domain,
 *      pinned to the store id (its genesis is the one the witness holds);
 *    - `registered`: an authoritative readback (the store reopened under freshness, the witness read
 *      again, the file identity unchanged) agrees.
 * 4. **Uncertainty is never success, and never a new authorization.** A lost or failed witness answer
 *    leaves the state where it was (`pending`); continuing needs a new, separately authorized **resume**
 *    capability bound to this registration, and resumes from evidence only. Evidence that disagrees
 *    quarantines the registration, for good: no reset, rebind, re-enrollment or adoption.
 *
 * It never adopts an existing store: the store path must be free, and a witness slot already bound is refused
 * before the capability is consumed. The one file it takes over unrecorded is a zero-length, owner-only,
 * single-link file with no sidecar at the reserved path (what its own crash between `O_EXCL` and recording can
 * leave). It cannot tell that file from one the same user made there; the same user is outside the trust
 * boundary (publication review finding 2). It never returns a store, a handle, a key or a capability: only non-secret evidence.
 */

export const FV_IDENTITY_REGISTRATION_BINDING_FORMAT = 'frontera.fv-identity-registration-binding.v1';
export const FV_IDENTITY_REGISTRATION_ACTIONS = Object.freeze({ register: 'frontera.fv-bootstrap-identity.register', resume: 'frontera.fv-bootstrap-identity.resume-registration' } as const);
export type FvIdentityRegistrationOperation = keyof typeof FV_IDENTITY_REGISTRATION_ACTIONS;
/** The store policy a registration is authorized for: a new file (O_EXCL, 0600), in a directory owned by this user and writable by no one else (`checkProtectedFile`), exclusively owned, in the FV identity domain. */
export const FV_IDENTITY_STORE_POLICY = 'frontera.fv-identity-store-policy.v1';

const REGISTRATION_ID = /^fvreg-[0-9a-f]{32}$/;
const STORE_ID = /^human-identity-store:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SIDECARS = ['-wal', '-shm', '-journal'] as const;

export function fvIdentityRegistrationResource(organizationId: string): string {
  return `fv-bootstrap-identity:${organizationId}`;
}

/** Exactly what a registration capability's action binding commits to. The registrar recomputes it; it never trusts one handed in. */
export interface FvIdentityRegistrationBindingValue {
  readonly operation: FvIdentityRegistrationOperation;
  readonly registrationId: string;
  readonly organizationId: string;
  readonly stateKind: typeof FV_BOOTSTRAP_IDENTITY_STATE_KIND;
  readonly deploymentId: string;
  readonly witnessId: string;
  readonly witnessKeyDigest: string;
  readonly storeId: string;
  readonly storePath: string;
  readonly storePolicy: typeof FV_IDENTITY_STORE_POLICY;
  readonly authenticityKeyId: string;
}

export function fvIdentityRegistrationBinding(value: FvIdentityRegistrationBindingValue): { readonly format: typeof FV_IDENTITY_REGISTRATION_BINDING_FORMAT; readonly value: FvIdentityRegistrationBindingValue } {
  return Object.freeze({ format: FV_IDENTITY_REGISTRATION_BINDING_FORMAT, value: Object.freeze({ ...value }) });
}

/** `sha256:` over the DER SPKI of a witness's receipt key: what a registration binds as the witness's identity, beside its id. */
export function witnessKeyDigestOf(publicKeyPem: string): string {
  const der = createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' });
  return `sha256:${createHash('sha256').update(der).digest('hex')}`;
}

export class FvIdentityRegistrationError extends Error {
  constructor(
    readonly code: 'OPTIONS_INVALID' | 'PLATFORM_UNSUPPORTED',
    message: string,
  ) {
    super(message);
    this.name = 'FvIdentityRegistrationError';
  }
}

/** Durable steps, reported after each commits (and before the next begins). Diagnostics only: the return value is ignored, and a throw is swallowed. */
export type FvIdentityRegistrationStep = 'capability-claimed' | 'intent-recorded' | 'witness-genesis-answered' | 'witness-anchored' | 'store-file-reserved' | 'store-genesis-committed' | 'store-created' | 'registered';

export interface FvIdentityRegistrarOptions {
  readonly organizationId: string;
  /** The deployment (environment) this registration is for. Bound into the authorization. */
  readonly deploymentId: string;
  /** The registrar's G-02A context: its one audience id, its trust domain and the issuers it pinned out of band. */
  readonly audience: string;
  readonly trustDomain: string;
  readonly trustedIssuers: readonly ExecutionCapabilityTrustedIssuer[];
  /** The registration record (`identity-registration-record.ts`). */
  readonly recordPath: string;
  /** The G-02A consumption ledger of this registrar's audience. */
  readonly ledgerPath: string;
  /** The FV bootstrap identity store to create. */
  readonly storePath: string;
  /** The deployment's authority signer and verifier (the store's head is signed by `signer.activeKeyId`). */
  readonly authenticity: SqliteHumanIdentityStoreOptions['authenticity'];
  /** The deployment's CORE-07 witness: its transport and the identity and key pinned for it. */
  readonly witness: { readonly transport: AuthorityStateWitnessTransport; readonly pinned: PinnedAuthorityStateWitness; readonly timeoutMs?: number; readonly maxAttempts?: number };
  /** Wall clock, ms since the epoch. */
  readonly clock: () => number;
  readonly observer?: (step: FvIdentityRegistrationStep) => void;
}

/** Non-secret evidence of a completed registration. Never a store, handle, key or capability. */
export interface FvIdentityRegistrationEvidence {
  readonly registrationId: string;
  readonly organizationId: string;
  readonly stateKind: typeof FV_BOOTSTRAP_IDENTITY_STATE_KIND;
  readonly storeId: string;
  readonly storePath: string;
  readonly storeFileIdentity: string;
  readonly genesisDigest: string;
  readonly witnessId: string;
  readonly witnessKeyDigest: string;
  readonly capabilityId: string;
  readonly capabilityIssuer: string;
  readonly registeredAt: string;
}

export const FV_IDENTITY_REGISTRATION_REFUSALS = Object.freeze([
  'REQUEST_INVALID',
  'CAPABILITY_REJECTED',
  'CAPABILITY_NOT_CLAIMED',
  'REGISTRAR_BUSY',
  'RECORD_CORRUPT',
  'RECORD_UNAVAILABLE',
  'PATH_REFUSED',
  'ALREADY_REGISTERED',
  'REGISTRATION_PENDING',
  'REGISTRATION_QUARANTINED',
  'NO_REGISTRATION',
  'CONFIGURATION_MISMATCH',
  'STORE_PATH_OCCUPIED',
  'WITNESS_UNAVAILABLE',
  'WITNESS_ALREADY_BOUND',
  'STORE_ID_IN_ANOTHER_DOMAIN',
  'LEDGER_UNAVAILABLE',
  'AUTHENTICITY_UNVERIFIED',
] as const);
export type FvIdentityRegistrationRefusal = (typeof FV_IDENTITY_REGISTRATION_REFUSALS)[number];

/** Why a registration in progress could not move on now. Each leaves the record exactly where it was. */
export type FvIdentityRegistrationPendingReason = 'WITNESS_UNAVAILABLE' | 'STORE_HELD' | 'STORE_UNAVAILABLE' | 'SIGNER_UNAVAILABLE' | 'RECORD_UNAVAILABLE';

export type FvIdentityRegistrationOutcome =
  | { readonly outcome: 'registered'; readonly evidence: FvIdentityRegistrationEvidence }
  | { readonly outcome: 'pending'; readonly state: FvIdentityRegistrationState; readonly reason: FvIdentityRegistrationPendingReason; readonly registrationId: string; readonly storeId: string }
  | { readonly outcome: 'quarantined'; readonly reason: FvIdentityRegistrationQuarantineReason; readonly registrationId: string; readonly storeId: string }
  | { readonly outcome: 'refused'; readonly reason: FvIdentityRegistrationRefusal; readonly detail?: ExecutionCapabilityVerificationFailure | ExecutionCapabilityClaimRefusal | ProtectedPathRefusal | string };

const refused = (reason: FvIdentityRegistrationRefusal, detail?: string): FvIdentityRegistrationOutcome => Object.freeze({ outcome: 'refused' as const, reason, ...(detail !== undefined ? { detail } : {}) });

interface Configuration {
  readonly organizationId: string;
  readonly deploymentId: string;
  readonly audience: string;
  readonly trustDomain: string;
  readonly trustedIssuers: readonly ExecutionCapabilityTrustedIssuer[];
  readonly recordPath: string;
  readonly ledgerPath: string;
  readonly storePath: string;
  readonly authenticity: SqliteHumanIdentityStoreOptions['authenticity'];
  readonly authenticityKeyId: string;
  readonly witness: FvIdentityRegistrarOptions['witness'];
  readonly witnessId: string;
  readonly witnessKeyDigest: string;
  readonly clock: () => number;
  readonly observer: ((step: FvIdentityRegistrationStep) => void) | undefined;
}

/** Every option read exactly once, into a frozen snapshot; every check and use is of the snapshot. */
function configurationOf(options: FvIdentityRegistrarOptions): Configuration {
  const invalid = (message: string): never => {
    throw new FvIdentityRegistrationError('OPTIONS_INVALID', message);
  };
  if (typeof options !== 'object' || options === null) invalid('The registrar needs its options.');
  const { organizationId, deploymentId, audience, trustDomain, trustedIssuers, recordPath, ledgerPath, storePath, authenticity, witness, clock, observer } = options;
  for (const [name, value] of Object.entries({ organizationId, deploymentId, audience, trustDomain })) if (!isExecutionCapabilityIdentifier(value)) invalid(`${name} is a well-formed identifier.`);
  if (!Array.isArray(trustedIssuers) || trustedIssuers.length === 0) invalid('trustedIssuers names at least one pinned registration issuer; there is no default issuer.');
  const paths = [recordPath, ledgerPath, storePath].map((path) => (typeof path === 'string' && path.trim() !== '' && !path.includes('\0') ? resolve(path) : invalid('recordPath, ledgerPath and storePath are files.')));
  if (new Set(paths).size !== 3) invalid('The record, the ledger and the store are three different files.');
  if (paths.some((path) => SIDECARS.some((suffix) => paths.includes(`${path}${suffix}`)))) invalid('No registration file is another one’s SQLite sidecar.');
  if (typeof authenticity?.signer?.signHumanIdentityState !== 'function' || typeof authenticity.verifier?.verifyHumanIdentityState !== 'function' || !isExecutionCapabilityIdentifier(authenticity.signer.activeKeyId)) {
    invalid('authenticity is the deployment’s authority signer and verifier.');
  }
  if (typeof witness?.transport !== 'object' || witness.transport === null || typeof witness.pinned?.publicKeyPem !== 'string' || !isExecutionCapabilityIdentifier(witness.pinned.witnessId)) invalid('witness is the deployment’s CORE-07 witness transport and its pinned identity.');
  if (typeof clock !== 'function') invalid('clock is the registrar’s wall clock.');
  if (observer !== undefined && typeof observer !== 'function') invalid('observer is a function.');
  let witnessKeyDigest: string;
  try {
    witnessKeyDigest = witnessKeyDigestOf(witness.pinned.publicKeyPem);
  } catch {
    return invalid('The pinned witness key is not a public key.');
  }
  return Object.freeze({
    organizationId,
    deploymentId,
    audience,
    trustDomain,
    trustedIssuers: Object.freeze([...trustedIssuers]),
    recordPath: paths[0]!,
    ledgerPath: paths[1]!,
    storePath: paths[2]!,
    authenticity: Object.freeze({ signer: authenticity.signer, verifier: authenticity.verifier }),
    authenticityKeyId: authenticity.signer.activeKeyId,
    witness: Object.freeze({ transport: witness.transport, pinned: Object.freeze({ witnessId: witness.pinned.witnessId, publicKeyPem: witness.pinned.publicKeyPem }), timeoutMs: witness.timeoutMs ?? 5_000, maxAttempts: witness.maxAttempts ?? 1 }),
    witnessId: witness.pinned.witnessId,
    witnessKeyDigest,
    clock,
    observer,
  });
}

function bindingOf(config: Configuration, operation: FvIdentityRegistrationOperation, registrationId: string, storeId: string): FvIdentityRegistrationBindingValue {
  return {
    operation,
    registrationId,
    organizationId: config.organizationId,
    stateKind: FV_BOOTSTRAP_IDENTITY_STATE_KIND,
    deploymentId: config.deploymentId,
    witnessId: config.witnessId,
    witnessKeyDigest: config.witnessKeyDigest,
    storeId,
    storePath: config.storePath,
    storePolicy: FV_IDENTITY_STORE_POLICY,
    authenticityKeyId: config.authenticityKeyId,
  };
}

/** The binding a record's own fields commit to, for one operation: what its capability must have signed. */
function recordBindingOf(record: RecordIntentFields, operation: FvIdentityRegistrationOperation): FvIdentityRegistrationBindingValue {
  return {
    operation,
    registrationId: record.registrationId,
    organizationId: record.organizationId,
    stateKind: record.stateKind as typeof FV_BOOTSTRAP_IDENTITY_STATE_KIND,
    deploymentId: record.deploymentId,
    witnessId: record.witnessId,
    witnessKeyDigest: record.witnessKeyDigest,
    storeId: record.storeId,
    storePath: record.storePath,
    storePolicy: record.storePolicy as typeof FV_IDENTITY_STORE_POLICY,
    authenticityKeyId: record.authenticityKeyId,
  };
}
type RecordIntentFields = Pick<FvIdentityRegistrationRecord, 'registrationId' | 'organizationId' | 'stateKind' | 'deploymentId' | 'witnessId' | 'witnessKeyDigest' | 'storeId' | 'storePath' | 'storePolicy' | 'authenticityKeyId'>;

/** Whether the record was made under exactly this registrar's trusted configuration. */
function configurationMatches(config: Configuration, record: FvIdentityRegistrationRecord): boolean {
  return (
    record.organizationId === config.organizationId &&
    record.stateKind === FV_BOOTSTRAP_IDENTITY_STATE_KIND &&
    record.deploymentId === config.deploymentId &&
    record.witnessId === config.witnessId &&
    record.witnessKeyDigest === config.witnessKeyDigest &&
    record.storePath === config.storePath &&
    record.storePolicy === FV_IDENTITY_STORE_POLICY &&
    record.authenticityKeyId === config.authenticityKeyId &&
    record.audience === config.audience &&
    record.trustDomain === config.trustDomain
  );
}

/** Whether a store path, or any of its SQLite sidecars, names anything at all (metadata only). */
function occupied(path: string): boolean {
  return [path, ...SIDECARS.map((suffix) => `${path}${suffix}`)].some((candidate) => {
    try {
      lstatSync(candidate);
      return true;
    } catch (error) {
      return (error as { code?: unknown }).code !== 'ENOENT';
    }
  });
}

/** Whether `path` is a zero-length regular file with no sidecar: the only file a crash of this ceremony can leave unrecorded. It holds no SQLite state. */
function emptyReservation(path: string): boolean {
  try {
    const st = lstatSync(path);
    return st.isFile() && !st.isSymbolicLink() && st.size === 0 && st.nlink === 1 && !SIDECARS.some((suffix) => existsSync(`${path}${suffix}`));
  } catch {
    return false;
  }
}

/** Creates the store file with O_EXCL, owner-only, and makes it and its directory entry durable. Returns its identity. */
function reserveFile(path: string): string {
  const fd = openSync(path, 'wx', 0o600);
  let identity: string;
  try {
    fsyncSync(fd);
    const st = fstatSync(fd, { bigint: true });
    identity = `${st.dev}:${st.ino}:${st.birthtimeNs}`;
  } finally {
    closeSync(fd);
  }
  const directory = openSync(dirname(path), 'r');
  try {
    fsyncSync(directory);
  } finally {
    closeSync(directory);
  }
  return identity;
}

const freshnessCode = (error: unknown): string | undefined => (error instanceof AuthorityStateFreshnessError ? error.code : undefined);

/**
 * The CORE-07 refusals that are **evidence**: the witness answered, authentically, with a state that disagrees
 * with this registration's (another store, a head it never wrote, a prepared successor, a cross-domain id).
 * Publication review finding 1: every other code — unreachable, refused or unauthenticated transport, a
 * malformed or unauthentic answer, a conflict, a protocol mismatch — is **no answer**, so it is `pending`,
 * never a quarantine: by then the witness slot is bound for good, and a quarantine would lock the
 * organization out on a transient fault.
 */
const WITNESS_EVIDENCE_CODES: ReadonlySet<string> = new Set([
  'AUTHORITY_FRESHNESS_ROLLBACK_DETECTED',
  'AUTHORITY_FRESHNESS_FORK_DETECTED',
  'AUTHORITY_FRESHNESS_PENDING_RECOVERY',
  'AUTHORITY_FRESHNESS_BINDING_MISMATCH',
  'AUTHORITY_FRESHNESS_UNBOUND_STORE',
  'AUTHORITY_FRESHNESS_ALREADY_ENROLLED',
]);

interface Ceremony {
  readonly config: Configuration;
  readonly record: FvRegistrationRecordFile;
  readonly anchor: AuthorityStateFreshnessAnchor;
  readonly boundary: AuthorityStateFreshnessBoundary;
}

function observe(config: Configuration, step: FvIdentityRegistrationStep): void {
  try {
    config.observer?.(step);
  } catch {
    // Diagnostics never change the ceremony.
  }
}

const iso = (config: Configuration): string => new Date(config.clock()).toISOString();

/**
 * Moves a recorded registration forward from its evidence, as far as the evidence allows. Shared by
 * `register` and `resume`; every branch either records the next state, quarantines, or returns `pending`
 * with the record unchanged.
 */
async function advance(ceremony: Ceremony): Promise<FvIdentityRegistrationOutcome> {
  const { config, record, anchor, boundary } = ceremony;
  const fv = Object.freeze({ stateKind: FV_BOOTSTRAP_IDENTITY_STATE_KIND, organizationId: config.organizationId });
  for (;;) {
    const current = record.read();
    if (current === undefined) return refused('NO_REGISTRATION');
    const { registrationId, storeId, storePath } = current;
    const genesis = humanIdentityGenesisDigest(storeId, config.organizationId);
    const pending = (reason: FvIdentityRegistrationPendingReason): FvIdentityRegistrationOutcome => Object.freeze({ outcome: 'pending' as const, state: current.state, reason, registrationId, storeId });
    const quarantine = (reason: FvIdentityRegistrationQuarantineReason): FvIdentityRegistrationOutcome => {
      try {
        record.quarantine(iso(config), reason);
      } catch {
        return pending('RECORD_UNAVAILABLE');
      }
      return Object.freeze({ outcome: 'quarantined' as const, reason, registrationId, storeId });
    };
    const atGenesis = (w: WitnessBindingState): boolean => w.status === 'bound' && w.storeId === storeId && w.pending === undefined && w.committed.sequence === 0 && w.committed.stateDigest === genesis;
    const disagreement = (w: WitnessBindingState): FvIdentityRegistrationQuarantineReason => (w.status === 'bound' && w.storeId !== storeId ? 'WITNESS_BOUND_TO_ANOTHER_STORE' : 'WITNESS_ADVANCED_UNEXPECTEDLY');
    const readWitness = async (): Promise<WitnessBindingState | undefined> => {
      try {
        return await anchor.read(fv);
      } catch {
        return undefined;
      }
    };
    /** Opens the store as its exclusive owner, in the FV domain, pinned; classifies a refusal into pending (availability) or quarantine (evidence). */
    const openStore = async (create: boolean, reserved: string): Promise<HumanIdentityStore | FvIdentityRegistrationOutcome> => {
      const fence = (): void => {
        if (!(record.held() && checkProtectedFile(storePath) === undefined && confirmExclusivelyHeld([storePath]) && fileIdentityOf(storePath) === reserved)) throw new Error('the registration ceremony does not hold the store it reserved');
      };
      try {
        return await openSqliteHumanIdentityStore(storePath, {
          organizationId: config.organizationId,
          now: () => iso(config),
          authenticity: config.authenticity,
          ...(create ? { create: true } : {}),
          freshness: Object.freeze({ boundary, stateKind: FV_BOOTSTRAP_IDENTITY_STATE_KIND }),
          exclusive: { beforeWrite: fence, closer: exclusiveCloser, storeId },
        });
      } catch (error) {
        if (heldByAnotherProcess(storePath)) return pending('STORE_HELD');
        const code = freshnessCode(error);
        if (code === 'AUTHORITY_FRESHNESS_BINDING_MISMATCH') {
          // HF01 (Codex P2 on PR #262): this one code also names a receipt the pinned witness signed about
          // *another* slot (organization, state kind or namespace), answered to this slot's request: authentic,
          // but not about this registration. It is evidence only once this registration's own slot, read again
          // and verified as bound to exactly that slot, disagrees. Unreadable, or still holding this genesis: pending.
          const confirmed = await readWitness();
          if (confirmed === undefined || atGenesis(confirmed)) return pending('WITNESS_UNAVAILABLE');
          return quarantine(disagreement(confirmed));
        }
        if (code !== undefined) {
          if (!WITNESS_EVIDENCE_CODES.has(code)) return pending('WITNESS_UNAVAILABLE');
          return quarantine(code === 'AUTHORITY_FRESHNESS_ROLLBACK_DETECTED' || code === 'AUTHORITY_FRESHNESS_PENDING_RECOVERY' ? 'WITNESS_ADVANCED_UNEXPECTEDLY' : 'STORE_NOT_GENESIS');
        }
        if (error instanceof HumanIdentityError) {
          if (error.code === 'HUMAN_IDENTITY_STORE_UNAVAILABLE') return pending('STORE_UNAVAILABLE');
          return quarantine('STORE_NOT_GENESIS');
        }
        return (error as { name?: unknown }).name === 'AuthoritySigningUnavailableError' ? pending('SIGNER_UNAVAILABLE') : pending('STORE_UNAVAILABLE');
      }
    };
    /** The store must be exactly this registration's genesis, on the file it reserved, still held. Closes it (guarded). */
    const isGenesisStore = (store: HumanIdentityStore, reserved: string): boolean => {
      try {
        const head = store.head();
        return store.storeId === storeId && store.organizationId === config.organizationId && head.storeId === storeId && head.sequence === 0 && head.chainDigest === genesis && fileIdentityOf(storePath) === reserved && confirmExclusivelyHeld([storePath]);
      } catch {
        return false;
      } finally {
        store.close();
      }
    };

    switch (current.state) {
      case 'registered':
        return Object.freeze({ outcome: 'registered' as const, evidence: evidenceOf(current) });
      case 'quarantined':
        return refused('REGISTRATION_QUARANTINED', current.quarantineReason ?? undefined);

      case 'intent-recorded': {
        // Nothing local exists yet: anything at the store path is foreign.
        const witnessed = await readWitness();
        if (witnessed === undefined) return pending('WITNESS_UNAVAILABLE');
        if (witnessed.status === 'unbound') {
          if (occupied(storePath)) return quarantine('FOREIGN_FILE_AT_STORE_PATH');
          let answer: Awaited<ReturnType<AuthorityStateFreshnessAnchor['enroll']>>;
          try {
            answer = await anchor.enroll('genesis', { ...fv, storeId, sequence: 0, stateDigest: genesis });
          } catch {
            // A lost answer proves nothing: the next resume reads the witness again.
            return pending('WITNESS_UNAVAILABLE');
          }
          observe(config, 'witness-genesis-answered');
          if (answer.outcome !== 'enrolled' && !atGenesis(answer.state)) return quarantine(answer.state.status === 'unbound' ? 'WITNESS_REFUSED_STORE_ID' : disagreement(answer.state));
        } else if (!atGenesis(witnessed)) {
          return quarantine(disagreement(witnessed));
        }
        if (occupied(storePath)) return quarantine('FOREIGN_FILE_AT_STORE_PATH');
        try {
          record.markWitnessAnchored(iso(config), genesis);
        } catch {
          return pending('RECORD_UNAVAILABLE');
        }
        observe(config, 'witness-anchored');
        continue;
      }

      case 'witness-anchored': {
        const witnessed = await readWitness();
        if (witnessed === undefined) return pending('WITNESS_UNAVAILABLE');
        if (!atGenesis(witnessed)) return quarantine(disagreement(witnessed));
        let reserved = current.storeFileIdentity;
        if (reserved === null) {
          let identity: string | undefined;
          if (occupied(storePath)) {
            // Only the empty file a crash of this very step can leave is taken over: it holds no state.
            if (!emptyReservation(storePath) || checkProtectedFile(storePath) !== undefined) return quarantine('FOREIGN_FILE_AT_STORE_PATH');
            identity = fileIdentityOf(storePath);
          } else {
            const refusal = checkProtectedFile(storePath, { allowMissing: true });
            if (refusal !== undefined) return refused('PATH_REFUSED', refusal);
            try {
              identity = reserveFile(storePath);
            } catch {
              return occupied(storePath) ? quarantine('FOREIGN_FILE_AT_STORE_PATH') : pending('STORE_UNAVAILABLE');
            }
          }
          if (identity === undefined) return quarantine('FOREIGN_FILE_AT_STORE_PATH');
          try {
            reserved = record.reserveStoreFile(iso(config), identity).storeFileIdentity;
          } catch {
            return pending('RECORD_UNAVAILABLE');
          }
          observe(config, 'store-file-reserved');
        }
        if (reserved === null || fileIdentityOf(storePath) !== reserved) return quarantine('STORE_FILE_REPLACED');
        const refusal = checkProtectedFile(storePath);
        if (refusal !== undefined) return refused('PATH_REFUSED', refusal);
        // The genesis the witness holds is deterministic from the store id: the store's own genesis adopts exactly it.
        const opened = await openStore(true, reserved);
        if (!('head' in opened)) return opened;
        if (!isGenesisStore(opened, reserved)) return quarantine('STORE_NOT_GENESIS');
        observe(config, 'store-genesis-committed');
        try {
          record.markStoreCreated(iso(config));
        } catch {
          return pending('RECORD_UNAVAILABLE');
        }
        observe(config, 'store-created');
        continue;
      }

      case 'store-created': {
        const reserved = current.storeFileIdentity;
        if (reserved === null || fileIdentityOf(storePath) !== reserved) return quarantine('STORE_FILE_REPLACED');
        const refusal = checkProtectedFile(storePath);
        if (refusal !== undefined) return refused('PATH_REFUSED', refusal);
        // The authoritative readback: reopened (never created) under freshness, so the witness itself confirms this exact head.
        const opened = await openStore(false, reserved);
        if (!('head' in opened)) return opened;
        if (!isGenesisStore(opened, reserved)) return quarantine('STORE_NOT_GENESIS');
        const witnessed = await readWitness();
        if (witnessed === undefined) return pending('WITNESS_UNAVAILABLE');
        if (!atGenesis(witnessed)) return quarantine(disagreement(witnessed));
        try {
          record.markRegistered(iso(config));
        } catch {
          return pending('RECORD_UNAVAILABLE');
        }
        observe(config, 'registered');
        continue;
      }
    }
  }
}

function evidenceOf(record: FvIdentityRegistrationRecord): FvIdentityRegistrationEvidence {
  return Object.freeze({
    registrationId: record.registrationId,
    organizationId: record.organizationId,
    stateKind: FV_BOOTSTRAP_IDENTITY_STATE_KIND,
    storeId: record.storeId,
    storePath: record.storePath,
    storeFileIdentity: record.storeFileIdentity as string,
    genesisDigest: record.genesisDigest as string,
    witnessId: record.witnessId,
    witnessKeyDigest: record.witnessKeyDigest,
    capabilityId: record.capabilityId,
    capabilityIssuer: record.capabilityIssuer,
    registeredAt: record.registeredAt as string,
  });
}

/** The capability presentation, read once as plain data (no getter of the caller's is ever invoked twice). */
function presentationOf(value: unknown): { readonly capability: string; readonly signature: unknown } | undefined {
  try {
    const plain = JSON.parse(JSON.stringify(value)) as unknown;
    if (typeof plain !== 'object' || plain === null || Array.isArray(plain)) return undefined;
    const { capability, signature } = plain as Record<string, unknown>;
    return typeof capability === 'string' ? Object.freeze({ capability, signature }) : undefined;
  } catch {
    return undefined;
  }
}

async function openRecord(config: Configuration, create: boolean): Promise<FvRegistrationRecordFile | FvIdentityRegistrationOutcome> {
  try {
    return await openFvRegistrationRecord(config.recordPath, { organizationId: config.organizationId, now: () => iso(config), create });
  } catch (error) {
    const code = error instanceof FvIdentityRegistrationRecordError ? error.code : undefined;
    if (code === 'BUSY') return refused('REGISTRAR_BUSY');
    if (code === 'PATH_REFUSED') return refused('PATH_REFUSED', 'record');
    if (code === 'ABSENT') return refused('NO_REGISTRATION');
    if (code === 'CORRUPT') return refused('RECORD_CORRUPT');
    return refused('RECORD_UNAVAILABLE');
  }
}

async function connectWitness(config: Configuration): Promise<{ readonly anchor: AuthorityStateFreshnessAnchor; readonly boundary: AuthorityStateFreshnessBoundary } | undefined> {
  try {
    // The signed identity handshake under the pinned key: a witness that is not the pinned one is never used.
    const { anchor, monitor } = await establishAuthorityStateWitness({ transport: config.witness.transport, pinned: config.witness.pinned, timeoutMs: config.witness.timeoutMs ?? 5_000, maxAttempts: config.witness.maxAttempts ?? 1 });
    return { anchor, boundary: createAuthorityStateFreshnessBoundary({ anchor, monitor, organizationId: config.organizationId }) };
  } catch {
    return undefined;
  }
}

async function openLedger(config: Configuration, create: boolean): Promise<ExecutionCapabilityConsumptionLedger | undefined> {
  if (checkProtectedFile(config.ledgerPath, { allowMissing: create }) !== undefined) return undefined;
  try {
    return await openExecutionCapabilityConsumptionLedger(config.ledgerPath, { audience: config.audience, clock: config.clock, create });
  } catch {
    return undefined;
  }
}

/** The ledger's own statement of what became of each capability it consumed for this registrar. Advisory; never changes the registration. */
function settleLedger(ledger: ExecutionCapabilityConsumptionLedger, capabilityId: string, outcome: FvIdentityRegistrationOutcome): void {
  try {
    ledger.recordOutcome(capabilityId, outcome.outcome === 'registered' ? 'completed' : outcome.outcome === 'pending' ? 'outcome-unknown' : 'failed');
  } catch {
    // Advisory.
  }
}

/** The event a ceremony records, under the record's exclusive lock, before it asks the ledger to consume a capability. */
const CLAIM_INTENT_EVENT = 'capability-claim-intent';
/** The event a ceremony records when the ledger refused that claim: the capability is not this record's. */
const CLAIM_REFUSED_EVENT = 'capability-claim-refused';

/**
 * Records, before the claim, that this record is about to consume `capability` (its ownership evidence). A
 * capability the ledger already holds is never this record's to claim: it is refused before any intent is
 * written (`'consumed'`), so an intent names only a capability that was unconsumed when it was written.
 */
function recordClaimIntent(config: Configuration, record: FvRegistrationRecordFile, ledger: ExecutionCapabilityConsumptionLedger, operation: 'register' | 'resume', capability: { readonly capabilityId: string; readonly executionId: string; readonly actionBinding: { readonly digest: string } }): 'recorded' | 'consumed' | 'unavailable' {
  try {
    if (ledger.read(capability.capabilityId).state !== 'absent') return 'consumed';
  } catch {
    return 'unavailable';
  }
  try {
    record.appendEvent(iso(config), CLAIM_INTENT_EVENT, JSON.stringify({ capabilityId: capability.capabilityId, executionId: capability.executionId, actionBindingDigest: capability.actionBinding.digest, organizationId: config.organizationId, operation }));
    return 'recorded';
  } catch {
    return 'unavailable';
  }
}

/** The claim-intent step, as the ceremony's outcome when it does not proceed. */
function claimIntentRefusal(state: 'recorded' | 'consumed' | 'unavailable'): FvIdentityRegistrationOutcome | undefined {
  if (state === 'consumed') return refused('CAPABILITY_NOT_CLAIMED', 'CAPABILITY_CONSUMED');
  if (state === 'unavailable') return refused('RECORD_UNAVAILABLE');
  return undefined;
}

function recordClaimRefused(config: Configuration, record: FvRegistrationRecordFile, capabilityId: string): void {
  try {
    record.appendEvent(iso(config), CLAIM_REFUSED_EVENT, JSON.stringify({ capabilityId }));
  } catch {
    // Lost (or a crash before it): see the residual window in `settleOrphans`.
  }
}

/**
 * HF01 (Codex P2 on PR #262): settles only the claims this record **proves** it made and then never recorded
 * using. A ledger can be shared (by audience) with other organizations' and other deployments' registrations,
 * whose in-flight claims this record does not name: those are never touched.
 *
 * A claim is this record's orphan only when all of these hold:
 * - this record logged its claim intent for exactly that capability (same id, execution id, binding digest and
 *   organization), under its exclusive lock, before the claim;
 * - the ledger did not refuse that claim (no refusal event);
 * - no intent, registration row or resume event of this record names it;
 * - the ledger still shows it `claimed`, for this organization, execution and binding.
 *
 * Holding the record's lock proves no ceremony of this record is in flight. Claims of other organizations,
 * of other deployments (another binding, so another capability) and of records written before HF01 (no
 * intent event) are left unchanged. A `claimed` claim is already spent: the ledger never reopens it, and its
 * state decides nothing in this ceremony.
 *
 * Residual window (the ledger and the record are separate files, so intent and claim are not atomic): an
 * intent is written only for a capability the ledger did not hold at that moment. If another record that
 * verifies the *same* capability — the same deployment, store path, witness and key, under another record
 * path, a misconfiguration — claims it between that check and this record's claim, and this record then
 * fails to record the refusal (it dies first, or the append itself fails), this record may later settle the
 * other's claim `failed`. A claim that throws is recorded as refused too. Bookkeeping only; nothing is
 * reopened, consumed twice or created.
 */
function settleOrphans(ledger: ExecutionCapabilityConsumptionLedger, record: FvRegistrationRecordFile, organizationId: string): void {
  try {
    const intents = new Map<string, { readonly executionId: unknown; readonly actionBindingDigest: unknown; readonly organizationId: unknown }>();
    const accounted = new Set<string>();
    const current = record.read();
    if (current !== undefined) accounted.add(current.capabilityId);
    for (const event of record.events()) {
      let detail: { capabilityId?: unknown; executionId?: unknown; actionBindingDigest?: unknown; organizationId?: unknown };
      try {
        detail = JSON.parse(event.detail) as typeof detail;
      } catch {
        continue;
      }
      if (typeof detail.capabilityId !== 'string') continue;
      if (event.kind === CLAIM_INTENT_EVENT) intents.set(detail.capabilityId, { executionId: detail.executionId, actionBindingDigest: detail.actionBindingDigest, organizationId: detail.organizationId });
      else accounted.add(detail.capabilityId);
    }
    const unresolvedClaims: ReturnType<ExecutionCapabilityConsumptionLedger['listUnresolved']>['records'][number][] = [];
    for (let page = ledger.listUnresolved(); ; page = ledger.listUnresolved({ after: page.next! })) {
      unresolvedClaims.push(...page.records);
      if (page.next === undefined || unresolvedClaims.length > 100_000) break;
    }
    for (const unresolved of unresolvedClaims) {
      const intent = intents.get(unresolved.capabilityId);
      if (
        unresolved.state === 'claimed' &&
        intent !== undefined &&
        !accounted.has(unresolved.capabilityId) &&
        intent.organizationId === organizationId &&
        unresolved.organizationId === organizationId &&
        unresolved.executionId === intent.executionId &&
        unresolved.actionBindingDigest === intent.actionBindingDigest
      ) {
        ledger.recordOutcome(unresolved.capabilityId, 'failed');
      }
    }
  } catch {
    // Advisory.
  }
}

function platformOrThrow(): void {
  if (!exclusivitySupported()) throw new FvIdentityRegistrationError('PLATFORM_UNSUPPORTED', 'The registration ceremony holds its files exclusively, which needs Linux and the main thread; nothing was opened.');
}

/**
 * Registers the organization's FV bootstrap identity: verifies and consumes the capability, records the
 * intent, anchors the genesis at the witness, creates the store and verifies it by readback. `registered`
 * only when every piece of evidence agrees; otherwise `pending` (resume later, with a resume capability),
 * `quarantined` (terminal) or `refused` (nothing consumed unless `detail` says the capability was).
 */
/**
 * Whether the configured signer's signature over this registration's genesis verifies under the configured
 * verifier, as its own active key. Any failure, including an unavailable signer, is a refusal before the
 * capability is consumed.
 */
async function authenticityRoundTrips(config: Configuration, storeId: string): Promise<boolean> {
  try {
    const genesis = { storeId, organizationId: config.organizationId, sequence: 0, chainDigest: humanIdentityGenesisDigest(storeId, config.organizationId) };
    const signature = await config.authenticity.signer.signHumanIdentityState!(genesis);
    const verification = config.authenticity.verifier.verifyHumanIdentityState(genesis, signature);
    return verification.verified && verification.keyId === config.authenticityKeyId;
  } catch {
    return false;
  }
}

export async function registerFvIdentity(options: FvIdentityRegistrarOptions, request: { readonly presentation: unknown; readonly registrationId: string; readonly storeId: string }): Promise<FvIdentityRegistrationOutcome> {
  const config = configurationOf(options);
  platformOrThrow();
  const registrationId: unknown = request?.registrationId;
  const storeId: unknown = request?.storeId;
  const presentation = presentationOf(request?.presentation);
  if (typeof registrationId !== 'string' || !REGISTRATION_ID.test(registrationId) || typeof storeId !== 'string' || !STORE_ID.test(storeId) || presentation === undefined) return refused('REQUEST_INVALID');

  // 1. The authorization, verified against the registrar's own pins and its own recomputed binding. Nothing is opened yet.
  const verifier = createExecutionCapabilityVerifier({ trustedIssuers: config.trustedIssuers, executor: { audience: config.audience, organizationIds: [config.organizationId], trustDomain: config.trustDomain }, clock: config.clock });
  const binding = fvIdentityRegistrationBinding(bindingOf(config, 'register', registrationId, storeId));
  const verification = verifier.verify({ presentation, action: FV_IDENTITY_REGISTRATION_ACTIONS.register, resource: fvIdentityRegistrationResource(config.organizationId), actionBinding: binding });
  if (verification.verification !== 'verified') return refused('CAPABILITY_REJECTED', verification.failure);
  // One registration, one execution: a second capability for the same registration is refused by the ledger.
  if (verification.capability.executionId !== registrationId) return refused('CAPABILITY_REJECTED', 'EXECUTION_MISMATCH');

  // 2. The files' policy, before anything is created.
  for (const [name, path] of [['record', config.recordPath], ['ledger', config.ledgerPath], ['store', config.storePath]] as const) {
    const refusal = checkProtectedFile(path, { allowMissing: true });
    if (refusal !== undefined) return refused('PATH_REFUSED', `${name}:${refusal}`);
  }

  // 3. The record, exclusively: one ceremony at a time, in any process.
  const opened = await openRecord(config, true);
  if (!('read' in opened)) return opened;
  const record = opened;
  try {
    let existing: FvIdentityRegistrationRecord | undefined;
    try {
      existing = record.read();
    } catch {
      return refused('RECORD_CORRUPT');
    }
    if (existing !== undefined) return refused(existing.state === 'registered' ? 'ALREADY_REGISTERED' : existing.state === 'quarantined' ? 'REGISTRATION_QUARANTINED' : 'REGISTRATION_PENDING');

    // 4. Nothing to adopt: the store path is free, and the witness's FV slot is unbound (checked again, atomically, by the witness at genesis).
    if (occupied(config.storePath)) return refused('STORE_PATH_OCCUPIED');
    const witness = await connectWitness(config);
    if (witness === undefined) return refused('WITNESS_UNAVAILABLE');
    let fvSlot: WitnessBindingState;
    let hostSlot: WitnessBindingState;
    try {
      fvSlot = await witness.anchor.read({ stateKind: FV_BOOTSTRAP_IDENTITY_STATE_KIND, organizationId: config.organizationId });
      hostSlot = await witness.anchor.read({ stateKind: HOST_IDENTITY_STATE_KIND, organizationId: config.organizationId });
    } catch {
      return refused('WITNESS_UNAVAILABLE');
    }
    if (fvSlot.status !== 'unbound') return refused('WITNESS_ALREADY_BOUND');
    if (hostSlot.status === 'bound' && hostSlot.storeId === storeId) return refused('STORE_ID_IN_ANOTHER_DOMAIN');

    // Publication review L1: the store this ceremony will create must verify under the configured verifier. A
    // misconfiguration is refused here, before anything is consumed or anchored, never quarantined after the genesis.
    if (!(await authenticityRoundTrips(config, storeId))) return refused('AUTHENTICITY_UNVERIFIED');

    // 5. Durable single use, then the intent, before the witness is asked for anything.
    const ledger = await openLedger(config, !existsSync(config.ledgerPath));
    if (ledger === undefined) return refused('LEDGER_UNAVAILABLE');
    try {
      settleOrphans(ledger, record, config.organizationId);
      const intentRefusal = claimIntentRefusal(recordClaimIntent(config, record, ledger, 'register', verification.capability));
      if (intentRefusal !== undefined) return intentRefusal;
      let claim: ReturnType<ExecutionCapabilityConsumptionLedger['claim']>;
      try {
        claim = ledger.claim(verification);
      } catch {
        // Unknown whether it was claimed: never proven this record's (fails closed: at worst its own orphan stays claimed).
        recordClaimRefused(config, record, verification.capability.capabilityId);
        return refused('LEDGER_UNAVAILABLE');
      }
      if (claim.outcome !== 'claimed') {
        recordClaimRefused(config, record, verification.capability.capabilityId);
        return refused('CAPABILITY_NOT_CLAIMED', claim.reason);
      }
      observe(config, 'capability-claimed');
      const capability = verification.capability;
      try {
        record.recordIntent({
          ...bindingOf(config, 'register', registrationId, storeId),
          audience: config.audience,
          trustDomain: config.trustDomain,
          capabilityId: capability.capabilityId,
          capabilityIssuer: capability.issuer,
          capabilityText: presentation.capability,
          capabilitySignature: JSON.stringify(presentation.signature),
          actionBindingDigest: capability.actionBinding.digest,
          intentRecordedAt: iso(config),
        });
      } catch {
        // Consumed and recorded nowhere else: nothing was contacted, and the capability is spent.
        settleLedger(ledger, capability.capabilityId, refused('RECORD_UNAVAILABLE'));
        return refused('RECORD_UNAVAILABLE');
      }
      observe(config, 'intent-recorded');

      // 6. The sequence, from the evidence just recorded.
      const outcome = await advance({ config, record, anchor: witness.anchor, boundary: witness.boundary });
      settleLedger(ledger, capability.capabilityId, outcome);
      return outcome;
    } finally {
      ledger.close();
    }
  } finally {
    record.close();
  }
}

/**
 * Continues a registration a crash, a lost answer or an unavailable witness left in progress, from its
 * recorded evidence only. It needs its **own** capability: action `…resume-registration`, bound to exactly
 * this registration (its id, store id and every intent field), consumed once. A registration already
 * complete is reported without consuming anything; a quarantined one is refused.
 */
export async function resumeFvIdentityRegistration(options: FvIdentityRegistrarOptions, request: { readonly presentation: unknown }): Promise<FvIdentityRegistrationOutcome> {
  const config = configurationOf(options);
  platformOrThrow();
  const presentation = presentationOf(request?.presentation);
  if (presentation === undefined) return refused('REQUEST_INVALID');
  const refusal = checkProtectedFile(config.recordPath);
  if (refusal !== undefined) return existsSync(config.recordPath) ? refused('PATH_REFUSED', `record:${refusal}`) : refused('NO_REGISTRATION');
  const opened = await openRecord(config, false);
  if (!('read' in opened)) return opened;
  const record = opened;
  try {
    let current: FvIdentityRegistrationRecord | undefined;
    try {
      current = record.read();
    } catch {
      return refused('RECORD_CORRUPT');
    }
    if (current === undefined) return refused('NO_REGISTRATION');
    if (current.state === 'registered') return Object.freeze({ outcome: 'registered' as const, evidence: evidenceOf(current) });
    if (current.state === 'quarantined') return refused('REGISTRATION_QUARANTINED', current.quarantineReason ?? undefined);
    // The registration continues only under the configuration it was authorized for: another witness, path, key or deployment is refused.
    if (!configurationMatches(config, current)) return refused('CONFIGURATION_MISMATCH');
    // The intent it continues must be the one a pinned issuer signed: a record whose fields were rewritten is never continued.
    if (!registrationAuthorized(current, { organizationId: config.organizationId, trustedIssuers: config.trustedIssuers, audience: config.audience, trustDomain: config.trustDomain })) return refused('RECORD_CORRUPT', 'AUTHORIZATION_UNVERIFIED');

    if (!(await authenticityRoundTrips(config, current.storeId))) return refused('AUTHENTICITY_UNVERIFIED');

    const verifier = createExecutionCapabilityVerifier({ trustedIssuers: config.trustedIssuers, executor: { audience: config.audience, organizationIds: [config.organizationId], trustDomain: config.trustDomain }, clock: config.clock });
    const verification = verifier.verify({
      presentation,
      action: FV_IDENTITY_REGISTRATION_ACTIONS.resume,
      resource: fvIdentityRegistrationResource(config.organizationId),
      actionBinding: fvIdentityRegistrationBinding(recordBindingOf(current, 'resume')),
    });
    if (verification.verification !== 'verified') return refused('CAPABILITY_REJECTED', verification.failure);
    if (verification.capability.executionId === current.registrationId) return refused('CAPABILITY_REJECTED', 'EXECUTION_MISMATCH');

    const witness = await connectWitness(config);
    if (witness === undefined) return refused('WITNESS_UNAVAILABLE');
    if (!existsSync(config.ledgerPath)) return refused('LEDGER_UNAVAILABLE');
    const ledger = await openLedger(config, false);
    if (ledger === undefined) return refused('LEDGER_UNAVAILABLE');
    try {
      settleOrphans(ledger, record, config.organizationId);
      const intentRefusal = claimIntentRefusal(recordClaimIntent(config, record, ledger, 'resume', verification.capability));
      if (intentRefusal !== undefined) return intentRefusal;
      let claim: ReturnType<ExecutionCapabilityConsumptionLedger['claim']>;
      try {
        claim = ledger.claim(verification);
      } catch {
        recordClaimRefused(config, record, verification.capability.capabilityId);
        return refused('LEDGER_UNAVAILABLE');
      }
      if (claim.outcome !== 'claimed') {
        recordClaimRefused(config, record, verification.capability.capabilityId);
        return refused('CAPABILITY_NOT_CLAIMED', claim.reason);
      }
      observe(config, 'capability-claimed');
      const capabilityId = verification.capability.capabilityId;
      try {
        record.appendEvent(iso(config), 'resume-authorized', JSON.stringify({ capabilityId, issuer: verification.capability.issuer, capability: presentation.capability, signature: presentation.signature }));
      } catch {
        settleLedger(ledger, capabilityId, refused('RECORD_UNAVAILABLE'));
        return refused('RECORD_UNAVAILABLE');
      }
      const outcome = await advance({ config, record, anchor: witness.anchor, boundary: witness.boundary });
      settleLedger(ledger, capabilityId, outcome);
      // HF01: the register capability this record's row holds (verified above) is this record's own claim; its
      // ceremony stopped before settling it. Settled only by a final outcome (a refusal or a pending resume may
      // be followed by one that completes), and the ledger only moves it forward.
      if (outcome.outcome === 'registered' || outcome.outcome === 'quarantined') settleLedger(ledger, current.capabilityId, outcome);
      return outcome;
    } finally {
      ledger.close();
    }
  } finally {
    record.close();
  }
}

/** Non-secret view of a registration, read-only. `undefined` when there is none. Throws `FvIdentityRegistrationRecordError` when unreadable. */
export async function readFvIdentityRegistration(recordPath: string, organizationId: string): Promise<{ readonly state: FvIdentityRegistrationState; readonly registrationId: string; readonly storeId: string; readonly quarantineReason: FvIdentityRegistrationQuarantineReason | null; readonly evidence?: FvIdentityRegistrationEvidence } | undefined> {
  const record = await readFvRegistrationRecordSnapshot(recordPath, organizationId);
  if (record === undefined) return undefined;
  return Object.freeze({ state: record.state, registrationId: record.registrationId, storeId: record.storeId, quarantineReason: record.quarantineReason, ...(record.state === 'registered' ? { evidence: evidenceOf(record) } : {}) });
}

// ── The executor's verification ─────────────────────────────────────────────

export const FV_IDENTITY_REGISTRATION_VERIFICATION_FAILURES = Object.freeze([
  'RECORD_PATH_REFUSED',
  'NOT_REGISTERED',
  'REGISTRATION_PENDING',
  'REGISTRATION_QUARANTINED',
  'RECORD_UNAVAILABLE',
  'RECORD_CORRUPT',
  'STORE_MISMATCH',
  'WITNESS_MISMATCH',
  'AUTHORIZATION_UNVERIFIED',
  'STORE_FILE_MISMATCH',
] as const);
export type FvIdentityRegistrationVerificationFailure = (typeof FV_IDENTITY_REGISTRATION_VERIFICATION_FAILURES)[number];

export type FvIdentityRegistrationVerification =
  | { readonly verified: true; readonly registrationId: string; readonly storeId: string; readonly storeFileIdentity: string; readonly witnessId: string }
  | { readonly verified: false; readonly failure: FvIdentityRegistrationVerificationFailure };

export interface FvIdentityRegistrationExpectation {
  readonly recordPath: string;
  readonly organizationId: string;
  readonly storePath: string;
  readonly storeId: string;
  /** The witness the executor's freshness boundary is pinned to. */
  readonly witnessId: string;
  /** The registration issuers the executor pins, and the registrar's audience and trust domain they issue for. */
  readonly trustedIssuers: readonly ExecutionCapabilityTrustedIssuer[];
  readonly audience: string;
  readonly trustDomain: string;
}

/**
 * FV-P4C-2B3C-2A1 — what the FV executor checks before its identity store is opened: a **registered**
 * registration of exactly this organization, FV domain, store id, store path and witness, on the very file the
 * ceremony reserved, authorized by a capability that a pinned issuer key signed over exactly the binding the
 * record's own fields recompute to. Read-only. It is not the witness check: opening the store under CORE-07
 * freshness then confirms the witness binds this store id at a head the store holds.
 */
export async function verifyFvIdentityRegistration(expected: FvIdentityRegistrationExpectation): Promise<FvIdentityRegistrationVerification> {
  const fail = (failure: FvIdentityRegistrationVerificationFailure): FvIdentityRegistrationVerification => Object.freeze({ verified: false as const, failure });
  let record: FvIdentityRegistrationRecord | undefined;
  try {
    record = await readFvRegistrationRecordSnapshot(expected.recordPath, expected.organizationId);
  } catch (error) {
    const code = error instanceof FvIdentityRegistrationRecordError ? error.code : undefined;
    return fail(code === 'ABSENT' ? 'NOT_REGISTERED' : code === 'PATH_REFUSED' ? 'RECORD_PATH_REFUSED' : code === 'CORRUPT' ? 'RECORD_CORRUPT' : 'RECORD_UNAVAILABLE');
  }
  if (record === undefined) return fail('NOT_REGISTERED');
  if (record.state === 'quarantined') return fail('REGISTRATION_QUARANTINED');
  if (record.state !== 'registered') return fail('REGISTRATION_PENDING');
  if (record.stateKind !== FV_BOOTSTRAP_IDENTITY_STATE_KIND || record.storeId !== expected.storeId || record.storePath !== resolve(expected.storePath)) return fail('STORE_MISMATCH');
  if (record.witnessId !== expected.witnessId) return fail('WITNESS_MISMATCH');
  if (!registrationAuthorized(record, expected)) return fail('AUTHORIZATION_UNVERIFIED');
  if (record.storeFileIdentity === null || fileIdentityOf(record.storePath) !== record.storeFileIdentity) return fail('STORE_FILE_MISMATCH');
  return Object.freeze({ verified: true as const, registrationId: record.registrationId, storeId: record.storeId, storeFileIdentity: record.storeFileIdentity, witnessId: record.witnessId });
}

/**
 * Whether the record's stored capability is the canonical text a pinned issuer key signed, for the
 * registration action, this organization and resource, the registrar's audience and trust domain, this
 * registration as its execution, and exactly the binding the record's own fields recompute to. The window is
 * not re-checked: it bounded when the capability could be consumed, which the record shows it was.
 */
function registrationAuthorized(record: FvIdentityRegistrationRecord, expected: Pick<FvIdentityRegistrationExpectation, 'organizationId' | 'trustedIssuers' | 'audience' | 'trustDomain'>): boolean {
  try {
    const parsed = parseExecutionCapability(record.capabilityText);
    if (!parsed.ok) return false;
    const capability = parsed.capability;
    const signature = JSON.parse(record.capabilitySignature) as { keyId?: unknown };
    const pinned = (Array.isArray(expected.trustedIssuers) ? expected.trustedIssuers : []).filter((entry) => entry?.issuer === capability.issuer);
    if (pinned.length !== 1 || signature === null || typeof signature !== 'object' || signature.keyId !== capability.issuerKeyId) return false;
    const registry = createAuthoritySignatureRegistry(pinned[0]!.keys);
    if (!registry.keyIds.includes(capability.issuerKeyId)) return false;
    if (!registry.verify(executionCapabilitySigningBytes(capability), signature).verified) return false;
    const digest = executionCapabilityActionBindingDigest(fvIdentityRegistrationBinding(recordBindingOf(record, 'register')));
    return (
      capability.capabilityId === record.capabilityId &&
      capability.issuer === record.capabilityIssuer &&
      capability.action === FV_IDENTITY_REGISTRATION_ACTIONS.register &&
      capability.resource === fvIdentityRegistrationResource(expected.organizationId) &&
      capability.organizationId === expected.organizationId &&
      capability.audience === expected.audience &&
      capability.trustDomain === expected.trustDomain &&
      record.audience === expected.audience &&
      record.trustDomain === expected.trustDomain &&
      capability.executionId === record.registrationId &&
      capability.actionBinding.format === FV_IDENTITY_REGISTRATION_BINDING_FORMAT &&
      capability.actionBinding.digest === digest &&
      record.actionBindingDigest === digest
    );
  } catch {
    return false;
  }
}

export type { FvIdentityRegistrationQuarantineReason, FvIdentityRegistrationState } from './identity-registration-record.js';
/** The G-02A pin type the executor's `registration` option takes (re-exported so the composition imports nothing of G-02A). */
export type { ExecutionCapabilityTrustedIssuer } from '../execution-capability/index.js';
