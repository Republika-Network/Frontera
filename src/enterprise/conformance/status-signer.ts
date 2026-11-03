import { createHmac, createPublicKey, timingSafeEqual, type KeyObject } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import Database from 'better-sqlite3';

import type { AuthoritySignature } from '../authority-authenticity/authority-signature.js';
import { AUTHORITY_ARTIFACT_VERSION } from '../authority-authenticity/signature-envelope.js';
import { canonicalizeConformance, conformanceDigest } from './canonical.js';
import { isIdentifier, isTimestamp, toMs } from './contracts.js';
import { deriveConformanceKeyId, publicKeyPemOf, signConformancePayload } from './signing.js';
import {
  STATUS_CLOCK_SKEW_MS,
  hasValidLifetime,
  parseStatusArtifact,
  statusArtifactDigest,
  type StatusAssertionPayload,
  type StatusRefusalPayload,
} from './status-contracts.js';
import type { StatusProjection, StatusProjectionResult } from './status-projection.js';

/**
 * RN-CONFORM-03 / WP-02 — the status issuer key registry and the isolated status
 * signer (CC-D-07, provisional: an external signer boundary, synthetic keys).
 *
 * ## The boundary (CORE-02 pattern, `external-authority-signer/protocol.ts`)
 *
 * The registry never holds a private key (INV-07). It asks a
 * `StatusSignerPort` for one of exactly two **structured** operations —
 * `signStatusAssertion` or `signStatusRefusal` — carrying the structured payload,
 * never "sign these bytes". The signer:
 *
 * 1. authenticates the requesting component (HMAC-SHA256 over the canonical
 *    request, per-requester secret, constant-time comparison);
 * 2. accepts only those two operations;
 * 3. re-validates the payload through the closed status schema;
 * 4. refuses any issuer but its own, any lifetime over 15 minutes and any
 *    `issuedAt` away from its own clock;
 * 5. **does not trust the registry**: it recomputes the committed-state
 *    projection itself from its read-only source at `issuedAt` and refuses
 *    unless every stated field equals it — so an altered subject, a stale
 *    `stateVersion` or an ACTIVE claim for a suspended head is never signed;
 * 6. enforces the per-credential sequence against its **own journal**, held
 *    outside the registry database's restore domain: only `last + 1`, linked
 *    to the last digest it signed. A restored (rolled-back) registry therefore
 *    gets no signature for an already used sequence;
 * 7. signs the exact canonical bytes in the status domain with its currently
 *    usable key (rotation: newest valid, unrevoked key) and returns the
 *    signature with the pinned key id.
 *
 * In this mission the signer runs in-process behind this port, holding its keys
 * in a closure; a separate process would implement the same port. No network
 * service exists. Keys are synthetic.
 */

export interface StatusIssuerKeyRecord {
  readonly issuer: string;
  readonly keyId: string;
  readonly publicKeyPem: string;
  readonly validFrom: string;
  readonly validUntil: string;
  readonly revokedAt: string | null;
}

export type StatusKeyUsability = 'USABLE' | 'UNKNOWN_KEY' | 'ISSUER_MISMATCH' | 'NOT_YET_VALID' | 'EXPIRED' | 'REVOKED';

export interface StatusIssuerKeyRegistry {
  resolve(keyId: string): StatusIssuerKeyRecord | undefined;
  list(): readonly StatusIssuerKeyRecord[];
  /**
   * Whether `keyId` may vouch for an artifact of `issuer` issued at `issuedAtMs`, judged now (`nowMs`).
   * Policy: the key must have been valid when the artifact was issued **and** still be valid and
   * unrevoked now. A status is a statement about the present, so a later revocation or expiry
   * withdraws trust in everything that key signed — there is no historical acceptance of status.
   */
  usability(keyId: string, issuer: string, issuedAtMs: number, nowMs: number): StatusKeyUsability;
}

/** A pinned, closed issuer key set (distributed out of band). Every entry's key id must be the derivation of its own key. */
export function createStatusIssuerKeyRegistry(records: readonly StatusIssuerKeyRecord[]): StatusIssuerKeyRegistry {
  const byId = new Map<string, StatusIssuerKeyRecord>();
  for (const r of records) {
    if (!isIdentifier(r.issuer) || !isTimestamp(r.validFrom) || !isTimestamp(r.validUntil) || toMs(r.validUntil) <= toMs(r.validFrom) || !(r.revokedAt === null || isTimestamp(r.revokedAt))) {
      throw new TypeError('Malformed status issuer key record.');
    }
    if (/PRIVATE KEY/.test(r.publicKeyPem)) throw new TypeError('A status issuer key registry holds public keys only.');
    if (deriveConformanceKeyId(r.publicKeyPem) !== r.keyId) throw new TypeError('A status issuer key id must be the derivation of its key.');
    if (byId.has(r.keyId)) throw new TypeError('Duplicate status issuer key id.');
    byId.set(r.keyId, Object.freeze({ ...r }));
  }
  const all = Object.freeze([...byId.values()]);
  return Object.freeze({
    resolve: (keyId: string) => byId.get(keyId),
    list: () => all,
    usability(keyId: string, issuer: string, issuedAtMs: number, nowMs: number): StatusKeyUsability {
      const r = byId.get(keyId);
      if (r === undefined) return 'UNKNOWN_KEY';
      if (r.issuer !== issuer) return 'ISSUER_MISMATCH';
      if (r.revokedAt !== null && (toMs(r.revokedAt) <= nowMs || toMs(r.revokedAt) <= issuedAtMs)) return 'REVOKED';
      if (issuedAtMs < toMs(r.validFrom)) return 'NOT_YET_VALID';
      if (issuedAtMs >= toMs(r.validUntil) || nowMs >= toMs(r.validUntil)) return 'EXPIRED';
      return 'USABLE';
    },
  });
}

export const STATUS_SIGNER_OPERATIONS = Object.freeze(['signStatusAssertion', 'signStatusRefusal'] as const);
export type StatusSignerOperation = (typeof STATUS_SIGNER_OPERATIONS)[number];

export interface StatusSigningRequest {
  readonly operation: StatusSignerOperation;
  readonly requesterId: string;
  readonly payload: StatusAssertionPayload | StatusRefusalPayload;
  /** HMAC-SHA256 (base64url) over `canonical({ operation, requesterId, payload })` with the requester's secret. */
  readonly mac: string;
}

export type StatusSignerRefusal =
  | 'UNAUTHENTICATED'
  | 'UNSUPPORTED_OPERATION'
  | 'MALFORMED_PAYLOAD'
  | 'WRONG_ISSUER'
  | 'LIFETIME'
  | 'CLOCK'
  | 'NOT_CURRENT'
  | 'SEQUENCE_DIVERGED'
  | 'NO_USABLE_KEY'
  | 'UNAVAILABLE';

export type StatusSignerResponse = { readonly ok: true; readonly signature: AuthoritySignature } | { readonly ok: false; readonly refusal: StatusSignerRefusal };

export interface StatusSignerPort {
  sign(request: unknown): StatusSignerResponse;
  /** Public material only: the issuer id and its keys with validity windows. A convenience, never a trust root. */
  publicKeys(): readonly StatusIssuerKeyRecord[];
}

export function statusRequestMac(secret: Buffer, request: Omit<StatusSigningRequest, 'mac'>): string {
  return createHmac('sha256', secret).update(canonicalizeConformance({ operation: request.operation, requesterId: request.requesterId, payload: request.payload }), 'utf8').digest('base64url');
}

/** The projection fields of an assertion payload, for comparison with an independently computed projection. */
export function projectionOf(payload: StatusAssertionPayload): StatusProjection {
  const { schema: _s, purpose: _p, issuer: _i, anchors: _a, sequence: _q, previousAssertionDigest: _d, requestNonce: _n, issuedAt: _t, validUntil: _v, designation: _g, ...projection } = payload;
  return projection;
}

const PLACEHOLDER_SIGNATURE = Object.freeze({ algorithm: 'ed25519-v1', keyId: `sha256:${'0'.repeat(64)}`, signature: Buffer.alloc(64).toString('base64url'), artifactVersion: AUTHORITY_ARTIFACT_VERSION });

/** The signer's own append-only journal of what it signed, per credential (outside the registry's database). */
interface SignerJournal {
  last(credentialId: string): { sequence: number; digest: string } | undefined;
  append(credentialId: string, sequence: number, digest: string, atMs: number): void;
  close(): void;
}

const JOURNAL_SCHEMA = `
CREATE TABLE sj_signed (
  credential_id TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK (sequence >= 1),
  assertion_digest TEXT NOT NULL UNIQUE,
  signed_at_ms INTEGER NOT NULL,
  PRIMARY KEY (credential_id, sequence)
);
CREATE TRIGGER sj_signed_contiguous BEFORE INSERT ON sj_signed BEGIN
  SELECT RAISE(ABORT, 'sj:sequence') WHERE NEW.sequence <> COALESCE((SELECT MAX(s.sequence) FROM sj_signed s WHERE s.credential_id = NEW.credential_id), 0) + 1;
END;
CREATE TRIGGER sj_signed_no_update BEFORE UPDATE ON sj_signed BEGIN SELECT RAISE(ABORT, 'sj:immutable'); END;
CREATE TRIGGER sj_signed_no_delete BEFORE DELETE ON sj_signed BEGIN SELECT RAISE(ABORT, 'sj:immutable'); END;
`;

function openSignerJournal(path: string): SignerJournal {
  const file = resolve(path);
  const fresh = !existsSync(file);
  if (fresh) mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = FULL');
  if (fresh) db.exec(JOURNAL_SCHEMA);
  else if (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = 'sj_signed_contiguous'").get() === undefined) {
    db.close();
    throw new Error('The status signer journal is not intact.');
  }
  const last = db.prepare('SELECT sequence, assertion_digest FROM sj_signed WHERE credential_id = ? ORDER BY sequence DESC LIMIT 1');
  const insert = db.prepare('INSERT INTO sj_signed (credential_id, sequence, assertion_digest, signed_at_ms) VALUES (?, ?, ?, ?)');
  return Object.freeze({
    last(credentialId: string) {
      const row = last.get(credentialId) as { sequence: number; assertion_digest: string } | undefined;
      return row === undefined ? undefined : { sequence: Number(row.sequence), digest: String(row.assertion_digest) };
    },
    append(credentialId: string, sequence: number, digest: string, atMs: number) {
      insert.run(credentialId, sequence, digest, atMs);
    },
    close: () => db.close(),
  });
}

export interface SyntheticStatusSigner extends StatusSignerPort {
  /** Test control: make the signer unavailable (an outage), or available again. */
  setAvailable(available: boolean): void;
  close(): void;
}

/**
 * The synthetic, in-process status signer. TEST/SYNTHETIC ONLY: keys are supplied by the caller (derived
 * test keys); there is no network listener and no production key path.
 */
export function createSyntheticStatusSigner(deps: {
  readonly issuer: string;
  readonly keys: readonly { readonly privateKey: KeyObject; readonly validFrom: string; readonly validUntil: string; readonly revokedAt?: string | null }[];
  readonly requesters: readonly { readonly id: string; readonly secret: Buffer }[];
  readonly clock: { now(): string };
  /** The signer's own journal file, outside the registry's database. */
  readonly journalPath: string;
  /** Read-only, independent view of committed credential state, evaluated at `issuedAt`. */
  readonly source: (credentialId: string, at: string) => StatusProjectionResult;
}): SyntheticStatusSigner {
  const keys = deps.keys.map((k) => {
    if (k.privateKey.type !== 'private' || k.privateKey.asymmetricKeyType !== 'ed25519') throw new TypeError('Status signing keys are Ed25519 private keys.');
    const publicKeyPem = publicKeyPemOf(k.privateKey);
    return Object.freeze({ privateKey: k.privateKey, record: Object.freeze({ issuer: deps.issuer, keyId: deriveConformanceKeyId(publicKeyPem), publicKeyPem, validFrom: k.validFrom, validUntil: k.validUntil, revokedAt: k.revokedAt ?? null }) });
  });
  const registry = createStatusIssuerKeyRegistry(keys.map((k) => k.record));
  const secrets = new Map(deps.requesters.map((r) => [r.id, Buffer.from(r.secret)]));
  const journal = openSignerJournal(deps.journalPath);
  let available = true;

  const refuse = (refusal: StatusSignerRefusal): StatusSignerResponse => ({ ok: false, refusal });

  return Object.freeze<SyntheticStatusSigner>({
    publicKeys: () => registry.list(),
    setAvailable(value: boolean) {
      available = value;
    },
    close: () => journal.close(),
    sign(request: unknown): StatusSignerResponse {
      try {
        if (!available) return refuse('UNAVAILABLE');
        if (typeof request !== 'object' || request === null) return refuse('UNAUTHENTICATED');
        const r = request as Partial<StatusSigningRequest>;
        // 1 — authenticate the requesting component.
        const secret = typeof r.requesterId === 'string' ? secrets.get(r.requesterId) : undefined;
        if (secret === undefined || typeof r.mac !== 'string' || r.payload === undefined || typeof r.operation !== 'string') return refuse('UNAUTHENTICATED');
        const expected = Buffer.from(statusRequestMac(secret, { operation: r.operation as StatusSignerOperation, requesterId: r.requesterId as string, payload: r.payload }), 'utf8');
        const given = Buffer.from(r.mac, 'utf8');
        if (expected.length !== given.length || !timingSafeEqual(expected, given)) return refuse('UNAUTHENTICATED');
        // 2 — only the structured status operations.
        if (!(STATUS_SIGNER_OPERATIONS as readonly string[]).includes(r.operation)) return refuse('UNSUPPORTED_OPERATION');
        // 3 — the payload through the closed schema (with a placeholder envelope, so the parser sees a complete artifact).
        let text: string;
        try {
          text = canonicalizeConformance({ ...(r.payload as object), signature: PLACEHOLDER_SIGNATURE });
        } catch {
          return refuse('MALFORMED_PAYLOAD');
        }
        const parsed = parseStatusArtifact(text);
        if (!parsed.ok || (parsed.kind === 'assertion') !== (r.operation === 'signStatusAssertion')) return refuse('MALFORMED_PAYLOAD');
        const payload = parsed.payload;
        // 4 — issuer, lifetime, clock.
        if (payload.issuer !== deps.issuer) return refuse('WRONG_ISSUER');
        if (!hasValidLifetime(payload.issuedAt, payload.validUntil)) return refuse('LIFETIME');
        const nowMs = toMs(deps.clock.now());
        if (Math.abs(toMs(payload.issuedAt) - nowMs) > STATUS_CLOCK_SKEW_MS) return refuse('CLOCK');
        const key = [...keys].filter((k) => registry.usability(k.record.keyId, deps.issuer, toMs(payload.issuedAt), nowMs) === 'USABLE').sort((a, b) => toMs(b.record.validFrom) - toMs(a.record.validFrom))[0];
        if (key === undefined) return refuse('NO_USABLE_KEY');
        if (parsed.kind === 'refusal') return { ok: true, signature: signConformancePayload('statusRefusal', payload, key.privateKey) };

        // 5 — never trust the registry: the stated state must be exactly the committed state at issuedAt.
        const assertion = payload as StatusAssertionPayload;
        const current = deps.source(assertion.credentialId, assertion.issuedAt);
        if (!current.ok || current.digest !== conformanceDigest(projectionOf(assertion))) return refuse('NOT_CURRENT');
        // 6 — sequence continuity against the signer's own journal.
        const last = journal.last(assertion.credentialId);
        if (assertion.sequence !== (last?.sequence ?? 0) + 1 || assertion.previousAssertionDigest !== (last?.digest ?? null)) return refuse('SEQUENCE_DIVERGED');
        // 7 — sign, then journal the signed artifact's digest before releasing the signature.
        const signature = signConformancePayload('status', assertion, key.privateKey);
        const signed = { ...assertion, signature };
        journal.append(assertion.credentialId, assertion.sequence, statusArtifactDigest(signed), nowMs);
        return { ok: true, signature };
      } catch {
        return refuse('UNAVAILABLE');
      }
    },
  });
}

/** The public half of a status issuer key, for building a pinned registry in a verifier. */
export function statusIssuerKeyRecord(issuer: string, publicKey: KeyObject | string, validFrom: string, validUntil: string, revokedAt: string | null = null): StatusIssuerKeyRecord {
  const pem = typeof publicKey === 'string' ? publicKey : publicKeyPemOf(publicKey.type === 'private' ? createPublicKey(publicKey) : publicKey);
  return Object.freeze({ issuer, keyId: deriveConformanceKeyId(pem), publicKeyPem: pem, validFrom, validUntil, revokedAt });
}
