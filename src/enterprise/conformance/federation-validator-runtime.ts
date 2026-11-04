import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import Database from 'better-sqlite3';

import type { AuthoritySignature } from '../authority-authenticity/authority-signature.js';
import { conformanceDigest } from './canonical.js';
import { isIdentifier, readClosed, toMs, toTimestamp, type ChallengePayload, type ObservationPayload, type ObservedOutcome, type SignedChallenge } from './contracts.js';
import { verifyChallenge, type RandomSource } from './coordinator.js';
import { classifyOutcome } from './engine.js';
import type { SubmissionResult, EvidencePackageInput } from './evidence.js';
import { EXECUTABLE_CHALLENGE_TYPES, type ValidatorCapabilities, type ValidatorHeartbeat } from './federation-contracts.js';

/**
 * RN-CONFORM-05 — the standalone validator runtime (WITNESS ONLY).
 *
 * It verifies a coordinator-signed challenge, executes it against an explicitly authorized SYNTHETIC fixture through an
 * injected executor, signs an observation through an injected signing port, and submits it through an injected evidence
 * port. It holds no registry, no credential, no lifecycle and no private key: by construction it imports none of the
 * conformance store, the federation store, the registries, the lifecycle or the status machinery (asserted by the
 * structure test). The `outcomeClass` it sends is a claim; evidence acceptance recomputes it, and only the engine decides.
 *
 * Its own durable outbox (a separate SQLite file holding signed bytes only — never keys) makes delivery idempotent: the
 * observation for a challenge is signed once; a crash, a lost acknowledgement or a redelivery resubmits the IDENTICAL
 * bytes (same eventId, nonce and signature), after first asking the evidence port whether it is already committed.
 * Exactly-once is not claimed: delivery is at-least-once, made safe by idempotency.
 */

/** The custody boundary. Backed in tests by an ephemeral in-memory key; later by a separately managed signer / KMS. */
export interface ObservationSigner {
  readonly keyId: string;
  sign(kind: 'observation' | 'validatorHeartbeat' | 'keyPossession', payload: unknown): AuthoritySignature;
}

export interface ChallengeExecution {
  readonly observedOutcome: ObservedOutcome;
  readonly observedDeploymentDigest: string | null;
  readonly requestDigest: string;
  readonly responseDigest: string;
  readonly statusCode: number;
  readonly latencyMs: number;
}

/** Runs one approved procedure against one authorized synthetic fixture. Never given a URL. */
export interface ChallengeExecutor {
  execute(challenge: ChallengePayload): Promise<ChallengeExecution>;
}

export interface EvidenceSubmissionPort {
  depositEvidencePackage(organizationId: string, pkg: EvidencePackageInput): string;
  submitObservation(raw: string): SubmissionResult;
  /** Whether an observation with this event id is already committed for this challenge and validator (reconciliation). */
  isCommitted(eventId: string, challengeId: string, validatorId: string): boolean;
}

export interface ValidatorRuntimeIdentity {
  readonly validatorId: string;
  readonly operatorId: string;
  readonly generation: number;
  /** The conformance-store identity of this generation (`<validatorId>.k<n>`): the only id this runtime answers to. */
  readonly conformanceValidatorId: string;
  readonly keyId: string;
}

/** What this runtime is allowed to touch: pinned coordinator keys and explicitly authorized synthetic targets. */
export interface ValidatorRuntimePolicy {
  readonly trustedCoordinatorPublicKeyPems: readonly string[];
  /** `deploymentDigest` is the integration's registered (credentialed) deployment, used only to state the outcome-class claim. */
  readonly authorizedTargets: readonly { readonly organizationId: string; readonly integrationDigest: string; readonly deploymentDigest: string; readonly fixtureRefs: readonly string[] }[];
  readonly capabilities: ValidatorCapabilities;
  /** Only 'synthetic' is executable in this mission; anything else is refused before execution. */
  readonly environment: 'synthetic' | 'staging' | 'production';
  readonly clockSkewMs: number;
}

export const RUNTIME_REFUSALS = Object.freeze([
  'MALFORMED_CHALLENGE',
  'COORDINATOR_UNTRUSTED',
  'NOT_SYNTHETIC',
  'ENVIRONMENT_PROHIBITED',
  'WRONG_VALIDATOR',
  'UNAUTHORIZED_TARGET',
  'UNAUTHORIZED_ENDPOINT',
  'UNSUPPORTED_PROFILE',
  'UNSUPPORTED_CHALLENGE',
  'NOT_YET_VALID',
  'CHALLENGE_EXPIRED',
  'WRONG_NONCE',
  'SIGNER_KEY_MISMATCH',
] as const);
export type RuntimeRefusal = (typeof RUNTIME_REFUSALS)[number];

export type RuntimeResult =
  | { readonly status: 'ACCEPTED'; readonly eventId: string; readonly reconciled: boolean; readonly resubmitted: boolean }
  | { readonly status: 'REJECTED'; readonly eventId: string; readonly reason: string }
  | { readonly status: 'REFUSED'; readonly reason: RuntimeRefusal }
  | { readonly status: 'RETRY'; readonly eventId: string; readonly reason: string };

export interface ValidatorRuntime {
  readonly identity: ValidatorRuntimeIdentity;
  receive(signed: unknown): Promise<RuntimeResult>;
  /** On restart: reconcile every signed-but-unacknowledged observation (committed → ACCEPTED; else resubmit the same bytes). */
  recover(): readonly RuntimeResult[];
  heartbeat(sessionId: string, operationalState?: 'READY' | 'DRAINING'): { readonly heartbeat: ValidatorHeartbeat; readonly signature: AuthoritySignature };
}

// ---------------------------------------------------------------------------
// The validator outbox (durable, signed bytes only).
// ---------------------------------------------------------------------------

export const VALIDATOR_OUTBOX_SCHEMA_VERSION = 'rn.conformance.validator-outbox/1';

const OUTBOX_SCHEMA = `
CREATE TABLE vo_meta (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  schema_version TEXT NOT NULL,
  conformance_validator_id TEXT NOT NULL,
  heartbeat_sequence INTEGER NOT NULL CHECK (heartbeat_sequence >= 0),
  event_counter INTEGER NOT NULL CHECK (event_counter >= 0)
);
CREATE TABLE vo_entries (
  challenge_id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL UNIQUE,
  raw TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('SIGNED', 'ACCEPTED', 'REJECTED')),
  reason TEXT,
  updated_ms INTEGER NOT NULL
);
CREATE TRIGGER vo_meta_no_delete BEFORE DELETE ON vo_meta BEGIN SELECT RAISE(ABORT, 'vo:immutable'); END;
CREATE TRIGGER vo_meta_forward BEFORE UPDATE ON vo_meta
WHEN NEW.schema_version IS NOT OLD.schema_version OR NEW.conformance_validator_id IS NOT OLD.conformance_validator_id OR NEW.heartbeat_sequence < OLD.heartbeat_sequence OR NEW.event_counter < OLD.event_counter
BEGIN SELECT RAISE(ABORT, 'vo:meta only moves forward'); END;
CREATE TRIGGER vo_entries_no_delete BEFORE DELETE ON vo_entries BEGIN SELECT RAISE(ABORT, 'vo:immutable'); END;
CREATE TRIGGER vo_entries_signed_once BEFORE UPDATE ON vo_entries
WHEN NEW.challenge_id IS NOT OLD.challenge_id OR NEW.event_id IS NOT OLD.event_id OR NEW.raw IS NOT OLD.raw OR OLD.state <> 'SIGNED'
BEGIN SELECT RAISE(ABORT, 'vo:signed bytes never change'); END;
`;

export interface ValidatorOutbox {
  readonly path: string;
  readonly conformanceValidatorId: string;
  get(challengeId: string): { readonly eventId: string; readonly raw: string; readonly state: 'SIGNED' | 'ACCEPTED' | 'REJECTED'; readonly reason: string | null } | undefined;
  listSigned(): readonly { readonly challengeId: string; readonly eventId: string; readonly raw: string }[];
  /** Records the signed bytes BEFORE submission; returns the existing entry if one is already recorded for the challenge. */
  putSigned(challengeId: string, eventId: string, raw: string, atMs: number): { readonly eventId: string; readonly raw: string };
  settle(challengeId: string, state: 'ACCEPTED' | 'REJECTED', reason: string | null, atMs: number): void;
  nextHeartbeatSequence(): number;
  nextEventNumber(): number;
  close(): void;
}

export function openValidatorOutbox(path: string, conformanceValidatorId: string, options: { readonly create?: boolean } = {}): ValidatorOutbox {
  const file = resolve(path);
  const create = options.create === true;
  if (create && existsSync(file)) throw new TypeError('A validator outbox already exists at that path; it is never re-initialized.');
  if (!create && !existsSync(file)) throw new TypeError('No validator outbox exists at that path; it is never recreated implicitly.');
  if (create) mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const db = new Database(file, create ? {} : { fileMustExist: true });
  try {
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = FULL');
    if (create) {
      db.transaction(() => {
        db.exec(OUTBOX_SCHEMA);
        db.prepare('INSERT INTO vo_meta (id, schema_version, conformance_validator_id, heartbeat_sequence, event_counter) VALUES (1, ?, ?, 0, 0)').run(VALIDATOR_OUTBOX_SCHEMA_VERSION, conformanceValidatorId);
      }).immediate();
    } else {
      const meta = db.prepare('SELECT schema_version, conformance_validator_id FROM vo_meta WHERE id = 1').get() as { schema_version: string; conformance_validator_id: string } | undefined;
      // An outbox belongs to exactly one generation: a rotated key starts a new outbox, never inherits signed bytes.
      if (meta?.schema_version !== VALIDATOR_OUTBOX_SCHEMA_VERSION || meta.conformance_validator_id !== conformanceValidatorId) throw new TypeError('The validator outbox belongs to another identity or schema.');
    }
  } catch (error) {
    db.close();
    throw error;
  }
  const counter = (column: 'heartbeat_sequence' | 'event_counter') =>
    db.transaction((): number => {
      db.prepare(`UPDATE vo_meta SET ${column} = ${column} + 1 WHERE id = 1`).run();
      return (db.prepare(`SELECT ${column} AS n FROM vo_meta WHERE id = 1`).get() as { n: number }).n;
    }).immediate();
  return Object.freeze({
    path: file,
    conformanceValidatorId,
    get(challengeId: string) {
      const r = db.prepare('SELECT event_id, raw, state, reason FROM vo_entries WHERE challenge_id = ?').get(challengeId) as { event_id: string; raw: string; state: 'SIGNED' | 'ACCEPTED' | 'REJECTED'; reason: string | null } | undefined;
      return r === undefined ? undefined : Object.freeze({ eventId: r.event_id, raw: r.raw, state: r.state, reason: r.reason });
    },
    listSigned() {
      return Object.freeze(
        (db.prepare("SELECT challenge_id, event_id, raw FROM vo_entries WHERE state = 'SIGNED' ORDER BY updated_ms, challenge_id").all() as { challenge_id: string; event_id: string; raw: string }[]).map((r) =>
          Object.freeze({ challengeId: r.challenge_id, eventId: r.event_id, raw: r.raw }),
        ),
      );
    },
    putSigned(challengeId: string, eventId: string, raw: string, atMs: number) {
      return db.transaction(() => {
        const existing = db.prepare('SELECT event_id, raw FROM vo_entries WHERE challenge_id = ?').get(challengeId) as { event_id: string; raw: string } | undefined;
        if (existing !== undefined) return Object.freeze({ eventId: existing.event_id, raw: existing.raw });
        db.prepare("INSERT INTO vo_entries (challenge_id, event_id, raw, state, reason, updated_ms) VALUES (?, ?, ?, 'SIGNED', NULL, ?)").run(challengeId, eventId, raw, atMs);
        return Object.freeze({ eventId, raw });
      }).immediate();
    },
    settle(challengeId: string, state: 'ACCEPTED' | 'REJECTED', reason: string | null, atMs: number) {
      db.transaction(() => {
        db.prepare("UPDATE vo_entries SET state = ?, reason = ?, updated_ms = ? WHERE challenge_id = ? AND state = 'SIGNED'").run(state, reason, atMs, challengeId);
      }).immediate();
    },
    nextHeartbeatSequence: () => counter('heartbeat_sequence'),
    nextEventNumber: () => counter('event_counter'),
    close() {
      db.close();
    },
  });
}

// ---------------------------------------------------------------------------
// The runtime.
// ---------------------------------------------------------------------------

const NONCE = /^[A-Za-z0-9_-]{43}$/;

export function createValidatorRuntime(deps: {
  readonly identity: ValidatorRuntimeIdentity;
  readonly signer: ObservationSigner;
  readonly executor: ChallengeExecutor;
  readonly evidence: EvidenceSubmissionPort;
  readonly outbox: ValidatorOutbox;
  readonly policy: ValidatorRuntimePolicy;
  readonly clock: { now(): string };
  readonly random: RandomSource;
}): ValidatorRuntime {
  const { identity, signer, executor, evidence, outbox, policy, clock } = deps;
  if (outbox.conformanceValidatorId !== identity.conformanceValidatorId) throw new TypeError('The outbox belongs to another identity.');

  const submit = (challengeId: string, eventId: string, raw: string, resubmitted: boolean): RuntimeResult => {
    // Reconcile first: a committed observation is never submitted again (lost acknowledgement, restart).
    if (evidence.isCommitted(eventId, challengeId, identity.conformanceValidatorId)) {
      outbox.settle(challengeId, 'ACCEPTED', 'RECONCILED', toMs(clock.now()));
      return { status: 'ACCEPTED', eventId, reconciled: true, resubmitted };
    }
    let result: SubmissionResult;
    try {
      result = evidence.submitObservation(raw);
    } catch (error) {
      // Transport failure: keep the signed bytes; the same bytes go again later. Never re-signed, never a new event id.
      return { status: 'RETRY', eventId, reason: error instanceof Error ? error.message.slice(0, 120) : 'SUBMISSION_FAILED' };
    }
    if (result.accepted) {
      outbox.settle(challengeId, 'ACCEPTED', null, toMs(clock.now()));
      return { status: 'ACCEPTED', eventId, reconciled: false, resubmitted };
    }
    // REPLAYED for our own committed bytes is an acknowledgement that was lost, not a failure.
    if (result.reason === 'REPLAYED' && evidence.isCommitted(eventId, challengeId, identity.conformanceValidatorId)) {
      outbox.settle(challengeId, 'ACCEPTED', 'RECONCILED_REPLAY', toMs(clock.now()));
      return { status: 'ACCEPTED', eventId, reconciled: true, resubmitted };
    }
    outbox.settle(challengeId, 'REJECTED', result.reason, toMs(clock.now()));
    return { status: 'REJECTED', eventId, reason: result.reason };
  };

  const verify = (value: unknown): { ok: true; challenge: ChallengePayload; signed: SignedChallenge; target: ValidatorRuntimePolicy['authorizedTargets'][number] } | { ok: false; reason: RuntimeRefusal } => {
    const outer = readClosed(value, ['challenge', 'coordinatorSignature']);
    if (!outer.ok) return { ok: false, reason: 'MALFORMED_CHALLENGE' };
    let signed: SignedChallenge;
    try {
      // One snapshot: verification and execution read the same bytes.
      signed = JSON.parse(JSON.stringify(outer.record)) as SignedChallenge;
    } catch {
      return { ok: false, reason: 'MALFORMED_CHALLENGE' };
    }
    const c = signed.challenge;
    if (typeof c !== 'object' || c === null || c.schema !== 'rn.conformance.challenge/1' || !isIdentifier(c.challengeId)) return { ok: false, reason: 'MALFORMED_CHALLENGE' };
    if (!policy.trustedCoordinatorPublicKeyPems.some((pem) => verifyChallenge(signed, pem))) return { ok: false, reason: 'COORDINATOR_UNTRUSTED' };
    if (c.synthetic !== true) return { ok: false, reason: 'NOT_SYNTHETIC' };
    if (policy.environment !== 'synthetic') return { ok: false, reason: 'ENVIRONMENT_PROHIBITED' };
    if (!Array.isArray(c.assignedValidatorIds) || !c.assignedValidatorIds.includes(identity.conformanceValidatorId)) return { ok: false, reason: 'WRONG_VALIDATOR' };
    const target = policy.authorizedTargets.find((t) => t.organizationId === c.organizationId && t.integrationDigest === c.integrationDigest);
    if (target === undefined) return { ok: false, reason: 'UNAUTHORIZED_TARGET' };
    if (!target.fixtureRefs.includes(c.fixtureRef)) return { ok: false, reason: 'UNAUTHORIZED_ENDPOINT' };
    if (!policy.capabilities.profiles.some((p) => p.profileId === c.profileId && p.profileVersion === c.profileVersion)) return { ok: false, reason: 'UNSUPPORTED_PROFILE' };
    if (!(EXECUTABLE_CHALLENGE_TYPES as readonly string[]).includes(c.challengeType) || !policy.capabilities.challengeTypes.includes(c.challengeType)) return { ok: false, reason: 'UNSUPPORTED_CHALLENGE' };
    const now = toMs(clock.now());
    if (now + policy.clockSkewMs < toMs(c.issuedAt)) return { ok: false, reason: 'NOT_YET_VALID' };
    if (now > toMs(c.deadline)) return { ok: false, reason: 'CHALLENGE_EXPIRED' };
    if (typeof c.nonce !== 'string' || !NONCE.test(c.nonce)) return { ok: false, reason: 'WRONG_NONCE' };
    if (signer.keyId !== identity.keyId) return { ok: false, reason: 'SIGNER_KEY_MISMATCH' };
    return { ok: true, challenge: c, signed, target };
  };

  const runtime: ValidatorRuntime = {
    identity,
    async receive(value) {
      const checked = verify(value);
      if (!checked.ok) return { status: 'REFUSED', reason: checked.reason };
      const c = checked.challenge;
      // Redelivery: the observation for this challenge was already signed — reuse the identical bytes.
      const prior = outbox.get(c.challengeId);
      if (prior !== undefined) {
        if (prior.state === 'ACCEPTED') return { status: 'ACCEPTED', eventId: prior.eventId, reconciled: true, resubmitted: false };
        if (prior.state === 'REJECTED') return { status: 'REJECTED', eventId: prior.eventId, reason: prior.reason ?? 'REJECTED' };
        return submit(c.challengeId, prior.eventId, prior.raw, true);
      }
      const execution = await executor.execute(c);
      // The deadline is re-checked after execution: a slow probe is not submitted as if it were on time.
      const observedAt = clock.now();
      if (toMs(observedAt) > toMs(c.deadline)) return { status: 'REFUSED', reason: 'CHALLENGE_EXPIRED' };
      const evidenceDigest = evidence.depositEvidencePackage(c.organizationId, {
        schema: 'rn.conformance.evidence-package/1',
        challengeId: c.challengeId,
        validatorId: identity.conformanceValidatorId,
        requestDigest: execution.requestDigest,
        responseDigest: execution.responseDigest,
        statusCode: execution.statusCode,
        latencyMs: execution.latencyMs,
        synthetic: true,
      });
      const deploymentDigest = c.challengeType === 'G08' ? execution.observedDeploymentDigest : null;
      const eventId = `obs-${identity.conformanceValidatorId}-${outbox.nextEventNumber()}`;
      const observation: ObservationPayload = Object.freeze({
        schema: 'rn.conformance.observation/1',
        eventId,
        challengeId: c.challengeId,
        challengeNonce: c.nonce,
        validatorId: identity.conformanceValidatorId,
        validatorKeyId: identity.keyId,
        organizationId: c.organizationId,
        platformId: c.platformId,
        integrationId: c.integrationId,
        integrationVersion: c.integrationVersion,
        integrationDigest: c.integrationDigest,
        observedDeploymentDigest: deploymentDigest,
        profileId: c.profileId,
        profileVersion: c.profileVersion,
        controlId: c.controlId,
        operation: c.operation,
        expectedOutcome: c.expectedOutcome,
        observedOutcome: execution.observedOutcome,
        // A claim only: evidence acceptance recomputes it against the credentialed deployment digest.
        outcomeClass: classifyOutcome(c.expectedOutcome, execution.observedOutcome, deploymentDigest, checked.target.deploymentDigest),
        evidenceDigest,
        observedAt,
        submittedAt: observedAt,
      });
      const raw = JSON.stringify({ observation, validatorSignature: signer.sign('observation', observation) });
      // Durable BEFORE submission: a crash after this line resubmits these exact bytes.
      const kept = outbox.putSigned(c.challengeId, eventId, raw, toMs(observedAt));
      return submit(c.challengeId, kept.eventId, kept.raw, kept.raw !== raw);
    },
    recover() {
      return Object.freeze(outbox.listSigned().map((e) => submit(e.challengeId, e.eventId, e.raw, true)));
    },
    heartbeat(sessionId, operationalState = 'READY') {
      const heartbeat: ValidatorHeartbeat = Object.freeze({
        schema: 'rn.conformance.validator-heartbeat/1',
        validatorId: identity.validatorId,
        operatorId: identity.operatorId,
        generation: identity.generation,
        keyId: identity.keyId,
        sessionId,
        sequence: outbox.nextHeartbeatSequence(),
        emittedAt: toTimestamp(toMs(clock.now())),
        operationalState,
        capabilities: policy.capabilities,
        synthetic: true,
      });
      return Object.freeze({ heartbeat, signature: signer.sign('validatorHeartbeat', heartbeat) });
    },
  };
  return Object.freeze(runtime);
}

/** A digest of what a probe asked, for the redacted evidence package (no content). */
export const requestDigestOf = (challenge: ChallengePayload, conformanceValidatorId: string): string =>
  conformanceDigest({ challengeId: challenge.challengeId, validatorId: conformanceValidatorId, procedure: challenge.challengeType, operation: challenge.operation });
