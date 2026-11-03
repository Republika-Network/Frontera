import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import Database from 'better-sqlite3';

import { AUTHORITY_ARTIFACT_VERSION } from '../authority-authenticity/signature-envelope.js';
import { SYNTHETIC_DESIGNATION, toMs, type CredentialState } from './contracts.js';
import { verifyConformanceSignature } from './signing.js';
import { STATUS_CLOCK_SKEW_MS, hasValidLifetime, parseStatusArtifact, statusArtifactDigest, type StatusAssertion } from './status-contracts.js';
import type { StatusIssuerKeyRegistry } from './status-signer.js';

/**
 * RN-CONFORM-03 / WP-05–WP-07 — the status verifier library and its durable
 * high-water mark.
 *
 * `verifyConformanceStatus` answers one question — *is this exact integration,
 * under this exact profile, conformant right now for this operation?* — from a
 * signed status artifact, the verifier's **pinned** issuer keys and its own
 * trusted clock. It never trusts the presenter, never throws, and returns
 * CONFORMANT only when every check passes (INV-09):
 *
 * 1. exact canonical text, closed schema;
 * 2. pinned, issuer-bound, currently usable key; supported envelope; signature
 *    in the status domain;
 * 3. validity window `issuedAt − skew ≤ now < validUntil`, lifetime ≤ 15 min;
 *    no clock rollback against the store's latched trusted time;
 * 4. online: the echoed nonce equals the one sent;
 * 5. exact subject, profile (id, version, digest), SDK and adapter versions;
 * 6. continuity against the durable high-water mark: lower sequence →
 *    ROLLBACK_DETECTED; same sequence, different digest, or a broken
 *    predecessor link → CONFLICT_DETECTED (latched, persisted); a gap →
 *    CONTINUITY_UNPROVEN for stapled presentations (online, the nonce proves
 *    currency, so a gap is accepted and recorded);
 * 7. credential term; state ACTIVE; operation covered and not excluded;
 *    evidence freshness FRESH and `freshUntil > now`.
 *
 * An offline (stapled) ACTIVE assertion issued before a suspension remains
 * cryptographically valid until its `validUntil` (≤ 15 min): offline mode does
 * not provide instantaneous revocation, and the result says how fresh it is.
 */

export const STATUS_VERIFICATION_RESULTS = Object.freeze([
  'CONFORMANT',
  'NOT_CONFORMANT',
  'INVALID_SCHEMA',
  'INVALID_SIGNATURE',
  'UNTRUSTED_ISSUER',
  'NONCE_MISMATCH',
  'SUBJECT_MISMATCH',
  'PROFILE_MISMATCH',
  'SCOPE_MISMATCH',
  'STALE_EVIDENCE',
  'EXPIRED_ASSERTION',
  'EXPIRED_CREDENTIAL',
  'CLOCK_ROLLBACK',
  'ROLLBACK_DETECTED',
  'CONFLICT_DETECTED',
  'CONTINUITY_UNPROVEN',
  'UNAVAILABLE',
] as const);
export type StatusVerificationResult = (typeof STATUS_VERIFICATION_RESULTS)[number];

export interface StatusExpectation {
  readonly credentialId: string;
  readonly platformId: string;
  readonly organizationId: string;
  readonly integrationId: string;
  readonly integrationVersion: number;
  readonly integrationDigest: string;
  readonly profileId: string;
  readonly profileVersion: string;
  /** Optional pins: when given they must match exactly. */
  readonly profileDigest?: string;
  readonly sdkVersion?: string;
  readonly adapterVersion?: string;
  readonly operation: string;
}

export interface StatusVerdict {
  /** True only for CONFORMANT. */
  readonly conformant: boolean;
  readonly result: StatusVerificationResult;
  readonly detail: string | null;
  readonly state: CredentialState | null;
  readonly sequence: number | null;
  readonly stateVersion: number | null;
  readonly issuedAt: string | null;
  readonly validUntil: string | null;
  /** Milliseconds of signed validity left at verification time (how stale an offline answer may already be). */
  readonly remainingValidityMs: number | null;
  readonly evidenceFreshUntil: string | null;
  readonly continuity: 'FIRST_OBSERVATION' | 'NEXT' | 'SAME' | 'GAP_ACCEPTED_ONLINE' | 'NOT_TRACKED' | null;
  readonly designation: typeof SYNTHETIC_DESIGNATION;
}

// ---------------------------------------------------------------------------
// Durable verifier state.
// ---------------------------------------------------------------------------

export type HighWaterDecision =
  | { readonly kind: 'ok'; readonly continuity: 'FIRST_OBSERVATION' | 'NEXT' | 'SAME' | 'GAP_ACCEPTED_ONLINE' }
  | { readonly kind: 'refused'; readonly result: 'ROLLBACK_DETECTED' | 'CONFLICT_DETECTED' | 'CONTINUITY_UNPROVEN' | 'CLOCK_ROLLBACK'; readonly detail: string };

export interface StatusVerifierStore {
  readonly path: string;
  /** Atomically checks the trusted clock and the credential's high-water mark and advances them (one IMMEDIATE transaction). */
  observe(input: {
    readonly credentialId: string;
    readonly issuer: string;
    readonly sequence: number;
    readonly digest: string;
    readonly previousDigest: string | null;
    readonly stateVersion: number;
    readonly state: CredentialState;
    readonly nowMs: number;
    readonly online: boolean;
  }): HighWaterDecision;
  /** The latched conflict for this credential, or `undefined`. Latches are append-only; there is no API that clears one (§10). */
  latch(credentialId: string): { readonly kind: string; readonly detail: string } | undefined;
  close(): void;
}

const VERIFIER_SCHEMA = `
CREATE TABLE vs_meta (id INTEGER PRIMARY KEY CHECK (id = 1), schema_version TEXT NOT NULL);
CREATE TABLE vs_clock (id INTEGER PRIMARY KEY CHECK (id = 1), max_trusted_ms INTEGER NOT NULL);
CREATE TABLE vs_high_water (
  credential_id TEXT PRIMARY KEY,
  issuer TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  assertion_digest TEXT NOT NULL,
  state_version INTEGER NOT NULL,
  state TEXT NOT NULL,
  observed_at_ms INTEGER NOT NULL
);
CREATE TABLE vs_latches (
  latch_seq INTEGER PRIMARY KEY AUTOINCREMENT,
  credential_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('ROLLBACK_DETECTED', 'CONFLICT_DETECTED')),
  detail TEXT NOT NULL,
  at_ms INTEGER NOT NULL
);
-- Forward only: a high-water mark never moves back, and the trusted clock never decreases.
CREATE TRIGGER vs_high_water_forward BEFORE UPDATE ON vs_high_water BEGIN
  SELECT RAISE(ABORT, 'vs:high-water mark moved backwards') WHERE NEW.sequence < OLD.sequence OR NEW.state_version < OLD.state_version OR NEW.credential_id <> OLD.credential_id OR NEW.issuer <> OLD.issuer;
END;
CREATE TRIGGER vs_high_water_no_delete BEFORE DELETE ON vs_high_water BEGIN SELECT RAISE(ABORT, 'vs:immutable'); END;
CREATE TRIGGER vs_clock_forward BEFORE UPDATE ON vs_clock BEGIN SELECT RAISE(ABORT, 'vs:clock moved backwards') WHERE NEW.max_trusted_ms < OLD.max_trusted_ms; END;
CREATE TRIGGER vs_clock_no_delete BEFORE DELETE ON vs_clock BEGIN SELECT RAISE(ABORT, 'vs:immutable'); END;
CREATE TRIGGER vs_latches_no_update BEFORE UPDATE ON vs_latches BEGIN SELECT RAISE(ABORT, 'vs:immutable'); END;
CREATE TRIGGER vs_latches_no_delete BEFORE DELETE ON vs_latches BEGIN SELECT RAISE(ABORT, 'vs:immutable'); END;
`;
const VERIFIER_SCHEMA_VERSION = 'rn.conformance.status-verifier-store/1';

/** Opens (or with `create`, creates) a verifier's own durable state. Independent of the issuer and of every platform-controlled cache. */
export function openStatusVerifierStore(path: string, options: { readonly create?: boolean; readonly busyTimeoutMs?: number } = {}): StatusVerifierStore {
  const file = resolve(path);
  const create = options.create === true;
  if (create && existsSync(file)) throw new Error('A verifier store already exists at that path; it is never re-initialized.');
  if (!create && !existsSync(file)) throw new Error('No verifier store exists at that path; it is never recreated implicitly.');
  if (create) mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const db = new Database(file, create ? {} : { fileMustExist: true });
  db.pragma(`busy_timeout = ${Math.max(0, Math.floor(options.busyTimeoutMs ?? 2000))}`);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = FULL');
  if (create) {
    db.transaction(() => {
      db.exec(VERIFIER_SCHEMA);
      db.prepare('INSERT INTO vs_meta (id, schema_version) VALUES (1, ?)').run(VERIFIER_SCHEMA_VERSION);
      db.prepare('INSERT INTO vs_clock (id, max_trusted_ms) VALUES (1, 0)').run();
    }).immediate();
  } else {
    const meta = db.prepare('SELECT schema_version FROM vs_meta WHERE id = 1').get() as { schema_version: string } | undefined;
    const triggers = (db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'vs_%'").get() as { n: number }).n;
    if (meta?.schema_version !== VERIFIER_SCHEMA_VERSION || triggers !== 6) {
      db.close();
      throw new Error('The verifier store is not intact.');
    }
  }
  const latchOf = db.prepare('SELECT kind, detail FROM vs_latches WHERE credential_id = ? ORDER BY latch_seq LIMIT 1');
  const addLatch = db.prepare('INSERT INTO vs_latches (credential_id, kind, detail, at_ms) VALUES (?, ?, ?, ?)');
  return Object.freeze<StatusVerifierStore>({
    path: file,
    latch: (credentialId: string) => latchOf.get(credentialId) as { kind: string; detail: string } | undefined,
    close: () => db.close(),
    observe(input) {
      return db.transaction((): HighWaterDecision => {
        const clock = (db.prepare('SELECT max_trusted_ms FROM vs_clock WHERE id = 1').get() as { max_trusted_ms: number }).max_trusted_ms;
        // Clock rollback: the trusted clock may not run backwards beyond the supported tolerance.
        if (input.nowMs < clock - STATUS_CLOCK_SKEW_MS) return { kind: 'refused', result: 'CLOCK_ROLLBACK', detail: `${clock - input.nowMs}ms` };
        if (input.nowMs > clock) db.prepare('UPDATE vs_clock SET max_trusted_ms = ? WHERE id = 1').run(input.nowMs);
        const latched = latchOf.get(input.credentialId) as { kind: 'ROLLBACK_DETECTED' | 'CONFLICT_DETECTED'; detail: string } | undefined;
        if (latched !== undefined) return { kind: 'refused', result: latched.kind, detail: `latched: ${latched.detail}` };
        const hw = db.prepare('SELECT * FROM vs_high_water WHERE credential_id = ?').get(input.credentialId) as
          | { issuer: string; sequence: number; assertion_digest: string; state_version: number }
          | undefined;
        const latch = (kind: 'ROLLBACK_DETECTED' | 'CONFLICT_DETECTED', detail: string): HighWaterDecision => {
          addLatch.run(input.credentialId, kind, detail, input.nowMs);
          return { kind: 'refused', result: kind, detail };
        };
        const advance = () =>
          hw === undefined
            ? db.prepare('INSERT INTO vs_high_water (credential_id, issuer, sequence, assertion_digest, state_version, state, observed_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?)').run(input.credentialId, input.issuer, input.sequence, input.digest, input.stateVersion, input.state, input.nowMs)
            : db.prepare('UPDATE vs_high_water SET sequence = ?, assertion_digest = ?, state_version = ?, state = ?, observed_at_ms = ? WHERE credential_id = ?').run(input.sequence, input.digest, input.stateVersion, input.state, input.nowMs, input.credentialId);
        if (hw === undefined) {
          advance();
          return { kind: 'ok', continuity: 'FIRST_OBSERVATION' };
        }
        if (hw.issuer !== input.issuer) return latch('CONFLICT_DETECTED', 'issuer changed');
        if (input.sequence < hw.sequence) return latch('ROLLBACK_DETECTED', `sequence ${input.sequence} < ${hw.sequence}`);
        if (input.sequence === hw.sequence) return input.digest === hw.assertion_digest ? { kind: 'ok', continuity: 'SAME' } : latch('CONFLICT_DETECTED', `sequence ${input.sequence} with two digests`);
        if (input.stateVersion < hw.state_version) return latch('ROLLBACK_DETECTED', `stateVersion ${input.stateVersion} < ${hw.state_version}`);
        if (input.sequence === hw.sequence + 1) {
          if (input.previousDigest !== hw.assertion_digest) return latch('CONFLICT_DETECTED', `sequence ${input.sequence} does not link to ${hw.sequence}`);
          advance();
          return { kind: 'ok', continuity: 'NEXT' };
        }
        // A gap: the newer assertion is recorded (so nothing older is accepted later), but continuity is unproven.
        advance();
        return input.online ? { kind: 'ok', continuity: 'GAP_ACCEPTED_ONLINE' } : { kind: 'refused', result: 'CONTINUITY_UNPROVEN', detail: `gap ${hw.sequence} → ${input.sequence}` };
      }).immediate();
    },
  });
}

// ---------------------------------------------------------------------------
// The verifier.
// ---------------------------------------------------------------------------

export function verifyConformanceStatus(input: {
  /** The exact serialized artifact as received. */
  readonly artifact: unknown;
  readonly expect: StatusExpectation;
  readonly mode: { readonly kind: 'online'; readonly nonce: string } | { readonly kind: 'stapled' };
  /** Pinned out of band. Never the issuer's `/keys` response alone. */
  readonly trustedKeys: StatusIssuerKeyRegistry;
  readonly clock: { now(): string };
  /** Durable continuity state. Without it, continuity is NOT_TRACKED (a stateless verifier cannot detect rollback). */
  readonly highWaterMark?: StatusVerifierStore;
}): StatusVerdict {
  const base = {
    state: null as CredentialState | null,
    sequence: null as number | null,
    stateVersion: null as number | null,
    issuedAt: null as string | null,
    validUntil: null as string | null,
    remainingValidityMs: null as number | null,
    evidenceFreshUntil: null as string | null,
    continuity: null as StatusVerdict['continuity'],
  };
  const verdict = (result: StatusVerificationResult, detail: string | null = null, extra: Partial<typeof base> = {}): StatusVerdict =>
    Object.freeze({ conformant: result === 'CONFORMANT', result, detail, ...base, ...extra, designation: SYNTHETIC_DESIGNATION });
  try {
    const nowMs = toMs(input.clock.now());
    if (!Number.isFinite(nowMs)) return verdict('UNAVAILABLE', 'no trusted time');
    // 1 — exact text, closed schema.
    const parsed = parseStatusArtifact(input.artifact);
    if (!parsed.ok) return verdict('INVALID_SCHEMA', parsed.field === undefined ? parsed.reason : `${parsed.reason}:${parsed.field}`);
    const a = parsed.artifact;
    // 2 — pinned, issuer-bound, usable key; supported envelope; signature.
    if (a.signature.artifactVersion !== AUTHORITY_ARTIFACT_VERSION || a.signature.algorithm !== 'ed25519-v1') return verdict('INVALID_SIGNATURE', 'unsupported envelope');
    const key = input.trustedKeys.resolve(a.signature.keyId);
    const usability = input.trustedKeys.usability(a.signature.keyId, a.issuer, toMs(a.issuedAt), nowMs);
    if (key === undefined || usability !== 'USABLE') return verdict('UNTRUSTED_ISSUER', usability);
    const { signature, ...payload } = a;
    if (!verifyConformanceSignature(parsed.kind === 'assertion' ? 'status' : 'statusRefusal', payload, signature, key.publicKeyPem).ok) return verdict('INVALID_SIGNATURE');
    // 3 — validity window (skew only tolerates an early issuedAt; it never extends validUntil).
    const window = { issuedAt: a.issuedAt, validUntil: a.validUntil, remainingValidityMs: toMs(a.validUntil) - nowMs };
    if (!hasValidLifetime(a.issuedAt, a.validUntil)) return verdict('EXPIRED_ASSERTION', 'INVALID_VALIDITY_INTERVAL', window);
    if (nowMs < toMs(a.issuedAt) - STATUS_CLOCK_SKEW_MS) return verdict('EXPIRED_ASSERTION', 'NOT_YET_VALID', window);
    if (nowMs >= toMs(a.validUntil)) return verdict('EXPIRED_ASSERTION', 'EXPIRED', window);
    // 4 — online freshness: the exact nonce we sent.
    if (input.mode.kind === 'online' && a.requestNonce !== input.mode.nonce) return verdict('NONCE_MISMATCH', null, window);
    const e = input.expect;
    if (parsed.kind === 'refusal') {
      if (parsed.artifact.requestedCredentialId !== e.credentialId) return verdict('SUBJECT_MISMATCH', 'refusal for another credential', window);
      const r = parsed.artifact.result;
      return verdict(r === 'SUBJECT_MISMATCH' ? 'SUBJECT_MISMATCH' : r === 'PROFILE_MISMATCH' ? 'PROFILE_MISMATCH' : 'NOT_CONFORMANT', `signed refusal: ${r}`, window);
    }
    const s = a as StatusAssertion;
    const at = { ...window, state: s.state, sequence: s.sequence, stateVersion: s.stateVersion, evidenceFreshUntil: s.evidenceFreshness.freshUntil };
    // 5 — exact subject and profile.
    if (
      s.credentialId !== e.credentialId || s.subject.platformId !== e.platformId || s.subject.organizationId !== e.organizationId || s.subject.integrationId !== e.integrationId ||
      s.subject.integrationVersion !== e.integrationVersion || s.subject.integrationDigest !== e.integrationDigest
    ) {
      return verdict('SUBJECT_MISMATCH', null, at);
    }
    if (e.sdkVersion !== undefined && s.sdk.version !== e.sdkVersion) return verdict('SUBJECT_MISMATCH', 'SDK_VERSION', at);
    if (e.adapterVersion !== undefined && s.adapter.version !== e.adapterVersion) return verdict('SUBJECT_MISMATCH', 'ADAPTER_VERSION', at);
    if (s.profile.id !== e.profileId || s.profile.version !== e.profileVersion || (e.profileDigest !== undefined && s.profile.digest !== e.profileDigest)) return verdict('PROFILE_MISMATCH', null, at);
    // 6 — continuity against the durable high-water mark (also latches clock rollback).
    let continuity: StatusVerdict['continuity'] = 'NOT_TRACKED';
    if (input.highWaterMark !== undefined) {
      const decision = input.highWaterMark.observe({
        credentialId: s.credentialId,
        issuer: s.issuer,
        sequence: s.sequence,
        digest: statusArtifactDigest(s),
        previousDigest: s.previousAssertionDigest,
        stateVersion: s.stateVersion,
        state: s.state,
        nowMs,
        online: input.mode.kind === 'online',
      });
      if (decision.kind === 'refused') return verdict(decision.result, decision.detail, at);
      continuity = decision.continuity;
    }
    const final = { ...at, continuity };
    // 7 — term, state, scope, evidence freshness.
    if (nowMs >= toMs(s.credentialValidUntil)) return verdict('EXPIRED_CREDENTIAL', null, final);
    if (s.state !== 'ACTIVE') return verdict('NOT_CONFORMANT', `state ${s.state}${s.reasonCode === null ? '' : ` (${s.reasonCode})`}`, final);
    if (s.scope.declaredExclusions.includes(e.operation)) return verdict('SCOPE_MISMATCH', 'OPERATION_EXCLUDED', final);
    if (!s.scope.coveredOperations.includes(e.operation)) return verdict('SCOPE_MISMATCH', 'OPERATION_NOT_COVERED', final);
    const freshUntil = s.evidenceFreshness.freshUntil;
    if (s.evidenceFreshness.status !== 'FRESH' || freshUntil === null || nowMs >= toMs(freshUntil)) return verdict('STALE_EVIDENCE', s.evidenceFreshness.status, final);
    return verdict('CONFORMANT', null, final);
  } catch {
    return verdict('UNAVAILABLE', 'verifier error');
  }
}
