import { conformanceDigest, snapshotPlainJson } from './canonical.js';
import {
  HUMAN_ACTIONS,
  HUMAN_DECISION_FORMAT,
  isDigest,
  isIdentifier,
  isTimestamp,
  readClosed,
  toMs,
  type HumanAction,
  type HumanDecisionPayload,
  type HumanDecisionRef,
  type SignedHumanDecision,
} from './contracts.js';
import { deriveConformanceKeyId, verifyConformanceSignature } from './signing.js';

/**
 * RN-CONFORM-02 / CC-D-04 — two distinct human approvals for issuance,
 * reinstatement after a confirmed critical violation, explicit revocation and
 * validator enrollment.
 *
 * ## Why an adapter and not `createHumanDecisionBootstrapAuthorizer`
 *
 * The FV-P4C-2B2 authorizer (`sovereign-status-history/human-decision-authorizer.ts`)
 * is the AUTH-03 pattern this follows, but it cannot be reused directly:
 * its port is AUTH-03's *bootstrap* decision format
 * (`frontera.sovereign-status-bootstrap-authority.v2`), its binding is a
 * status-history bootstrap, and its decisions are WebAuthn passkey
 * assertions verified by the AUTH-03 identity service, which the synthetic
 * circuit has no business composing. This adapter keeps the same semantics —
 * signed `attest`/`approve` roles, requester ≠ approver, exact subject and
 * digest binding, permission per role, every check before any consumption,
 * single use — over synthetic Ed25519 approval keys held in a synthetic
 * directory. Consumption is durable and lives in the conformance store
 * (`consumed_human_decisions`, primary key `decision_id`), inside the same
 * transaction as the record the decisions authorize.
 *
 * ## Limitation (recorded in RN_CONFORM_02_IMPLEMENTATION.md §7)
 *
 * No passkey, no user-verification flag, no AUTH-03 identity chain: a
 * synthetic approval key stands in for a passkey. Identity separation is
 * enforced by principal id **and** by key: one key can never belong to two
 * principals, and one principal's two keys never make two approvals.
 */

/** Maximum lifetime of a decision (issuedAt → expiresAt). AUTH-03 decisions expire within 120 s; the synthetic adapter allows 15 min to keep fixtures readable. */
export const HUMAN_DECISION_MAX_LIFETIME_MS = 15 * 60 * 1000;

export interface SyntheticHumanPrincipal {
  readonly principalId: string;
  readonly organizationId: string;
  readonly keys: readonly { readonly publicKeyPem: string; readonly revokedAt?: string }[];
  /** Per action, which roles this principal may sign. */
  readonly permissions: Readonly<Partial<Record<HumanAction, readonly ('attest' | 'approve')[]>>>;
}

interface DirectoryKey {
  readonly principalId: string;
  readonly organizationId: string;
  readonly publicKeyPem: string;
  readonly revokedAtMs: number | null;
}

export interface SyntheticHumanDirectory {
  keyFor(keyId: string): DirectoryKey | undefined;
  mayAct(principalId: string, action: HumanAction, role: 'attest' | 'approve'): boolean;
  /** Protective: revoking an approval key needs no approval. */
  revokeKey(keyId: string, at: string): void;
}

export function createSyntheticHumanDirectory(principals: readonly SyntheticHumanPrincipal[]): SyntheticHumanDirectory {
  const keys = new Map<string, DirectoryKey>();
  const permissions = new Map<string, SyntheticHumanPrincipal['permissions']>();
  for (const principal of principals) {
    if (!isIdentifier(principal.principalId) || !isIdentifier(principal.organizationId)) throw new TypeError('A synthetic principal needs identifiers.');
    if (permissions.has(principal.principalId)) throw new TypeError(`Duplicate synthetic principal '${principal.principalId}'.`);
    permissions.set(principal.principalId, principal.permissions);
    for (const key of principal.keys) {
      const keyId = deriveConformanceKeyId(key.publicKeyPem);
      // One key, one human: a key shared by two principals would let one person stand in for two.
      if (keys.has(keyId)) throw new TypeError('An approval key is registered to more than one principal.');
      if (key.revokedAt !== undefined && !isTimestamp(key.revokedAt)) throw new TypeError('A key revocation time must be a timestamp.');
      keys.set(keyId, { principalId: principal.principalId, organizationId: principal.organizationId, publicKeyPem: key.publicKeyPem, revokedAtMs: key.revokedAt === undefined ? null : toMs(key.revokedAt) });
    }
  }
  return Object.freeze({
    keyFor: (keyId: string) => keys.get(keyId),
    mayAct: (principalId: string, action: HumanAction, role: 'attest' | 'approve') => permissions.get(principalId)?.[action]?.includes(role) === true,
    revokeKey(keyId: string, at: string) {
      const existing = keys.get(keyId);
      if (existing === undefined || !isTimestamp(at)) throw new TypeError('Unknown approval key or bad time.');
      if (existing.revokedAtMs === null || existing.revokedAtMs > toMs(at)) keys.set(keyId, { ...existing, revokedAtMs: toMs(at) });
    },
  });
}

export const HUMAN_AUTHORITY_DENIALS = Object.freeze([
  'DECISIONS_MISSING',
  'DECISION_MALFORMED',
  'DECISION_FORMAT_UNSUPPORTED',
  'NOT_SYNTHETIC',
  'ROLE_MISMATCH',
  'ACTION_MISMATCH',
  'SUBJECT_MISMATCH',
  'ORGANIZATION_MISMATCH',
  'BINDING_DIGEST_MISMATCH',
  'UNKNOWN_APPROVAL_KEY',
  'APPROVAL_KEY_REVOKED',
  'PRINCIPAL_KEY_MISMATCH',
  'SIGNATURE_INVALID',
  'SAME_PRINCIPAL',
  'SAME_DECISION',
  'NOT_PERMITTED',
  'NOT_YET_VALID',
  'EXPIRED',
  'LIFETIME_TOO_LONG',
  'ALREADY_CONSUMED',
] as const);
export type HumanAuthorityDenial = (typeof HUMAN_AUTHORITY_DENIALS)[number];

export interface HumanAuthorityRequest {
  readonly action: HumanAction;
  readonly organizationId: string;
  readonly subjectRef: string;
  readonly actionBindingDigest: string;
  readonly now: string;
}

export type HumanAuthorityResult =
  | { readonly authorized: true; readonly refs: readonly [HumanDecisionRef, HumanDecisionRef]; readonly signed: readonly [SignedHumanDecision, SignedHumanDecision] }
  | { readonly authorized: false; readonly denial: HumanAuthorityDenial };

const DECISION_FIELDS = ['format', 'decisionId', 'principalId', 'role', 'action', 'organizationId', 'subjectRef', 'actionBindingDigest', 'issuedAt', 'expiresAt', 'synthetic'] as const;

function readDecision(value: unknown): { decision: HumanDecisionPayload; signature: unknown } | HumanAuthorityDenial {
  const outer = readClosed(value, ['decision', 'signature']);
  if (!outer.ok) return 'DECISION_MALFORMED';
  const inner = readClosed(outer.record['decision'], DECISION_FIELDS);
  if (!inner.ok) return 'DECISION_MALFORMED';
  const d = inner.record;
  if (d['format'] !== HUMAN_DECISION_FORMAT) return 'DECISION_FORMAT_UNSUPPORTED';
  if (d['synthetic'] !== true) return 'NOT_SYNTHETIC';
  if (!isIdentifier(d['decisionId']) || !isIdentifier(d['principalId']) || !isIdentifier(d['organizationId']) || !isIdentifier(d['subjectRef'])) return 'DECISION_MALFORMED';
  if (d['role'] !== 'attest' && d['role'] !== 'approve') return 'DECISION_MALFORMED';
  if (typeof d['action'] !== 'string' || !(HUMAN_ACTIONS as readonly string[]).includes(d['action'])) return 'DECISION_MALFORMED';
  if (!isDigest(d['actionBindingDigest']) || !isTimestamp(d['issuedAt']) || !isTimestamp(d['expiresAt'])) return 'DECISION_MALFORMED';
  // A snapshot: later reads of the caller's object cannot change what was checked.
  const decision: HumanDecisionPayload = Object.freeze({
    format: HUMAN_DECISION_FORMAT,
    decisionId: d['decisionId'],
    principalId: d['principalId'],
    role: d['role'],
    action: d['action'] as HumanAction,
    organizationId: d['organizationId'],
    subjectRef: d['subjectRef'],
    actionBindingDigest: d['actionBindingDigest'],
    issuedAt: d['issuedAt'],
    expiresAt: d['expiresAt'],
    synthetic: true,
  });
  let signature: unknown;
  try {
    signature = snapshotPlainJson(outer.record['signature']);
  } catch {
    return 'DECISION_MALFORMED';
  }
  return { decision, signature };
}

/**
 * Checks two decisions — one `attest` (requester), one `approve` (approver) —
 * for exactly `request`. Pure apart from `isConsumed`; consumes nothing. The
 * caller must record both decision ids as consumed in the same transaction
 * as the record they authorize; the store's primary key makes a second use
 * fail even if this check was raced.
 */
export function verifyTwoPersonAuthority(
  directory: SyntheticHumanDirectory,
  decisions: readonly unknown[],
  request: HumanAuthorityRequest,
  isConsumed: (decisionId: string) => boolean,
): HumanAuthorityResult {
  const deny = (denial: HumanAuthorityDenial): HumanAuthorityResult => ({ authorized: false, denial });
  try {
    if (!Array.isArray(decisions) || decisions.length !== 2) return deny('DECISIONS_MISSING');
    const read = decisions.map(readDecision);
    for (const entry of read) if (typeof entry === 'string') return deny(entry);
    const [first, second] = read as { decision: HumanDecisionPayload; signature: unknown }[];
    const requester = [first!, second!].find((entry) => entry.decision.role === 'attest');
    const approver = [first!, second!].find((entry) => entry.decision.role === 'approve');
    if (requester === undefined || approver === undefined) return deny('ROLE_MISMATCH');
    if (requester.decision.decisionId === approver.decision.decisionId) return deny('SAME_DECISION');

    const nowMs = toMs(request.now);
    const refs: HumanDecisionRef[] = [];
    const signedCopies: SignedHumanDecision[] = [];
    const keyIds: string[] = [];
    for (const entry of [requester, approver]) {
      const { decision, signature } = entry;
      if (decision.action !== request.action) return deny('ACTION_MISMATCH');
      if (decision.subjectRef !== request.subjectRef) return deny('SUBJECT_MISMATCH');
      if (decision.organizationId !== request.organizationId) return deny('ORGANIZATION_MISMATCH');
      if (decision.actionBindingDigest !== request.actionBindingDigest) return deny('BINDING_DIGEST_MISMATCH');
      const keyId = typeof signature === 'object' && signature !== null ? (signature as { keyId?: unknown }).keyId : undefined;
      const key = typeof keyId === 'string' ? directory.keyFor(keyId) : undefined;
      if (key === undefined || typeof keyId !== 'string') return deny('UNKNOWN_APPROVAL_KEY');
      if (key.principalId !== decision.principalId || key.organizationId !== decision.organizationId) return deny('PRINCIPAL_KEY_MISMATCH');
      if (key.revokedAtMs !== null && key.revokedAtMs <= nowMs) return deny('APPROVAL_KEY_REVOKED');
      if (!verifyConformanceSignature('humanDecision', decision, signature, key.publicKeyPem).ok) return deny('SIGNATURE_INVALID');
      const issued = toMs(decision.issuedAt);
      const expires = toMs(decision.expiresAt);
      if (expires <= issued || expires - issued > HUMAN_DECISION_MAX_LIFETIME_MS) return deny('LIFETIME_TOO_LONG');
      if (nowMs < issued) return deny('NOT_YET_VALID');
      if (nowMs >= expires) return deny('EXPIRED');
      if (!directory.mayAct(decision.principalId, request.action, decision.role)) return deny('NOT_PERMITTED');
      keyIds.push(keyId);
      const signatureCopy = signature as SignedHumanDecision['signature'];
      signedCopies.push(Object.freeze({ decision, signature: signatureCopy }));
      refs.push(Object.freeze({
        format: HUMAN_DECISION_FORMAT,
        decisionId: decision.decisionId,
        principalId: decision.principalId,
        role: decision.role,
        decisionDigest: conformanceDigest({ decision, signature: signatureCopy }),
        actionBindingDigest: decision.actionBindingDigest,
      }));
    }
    // Two humans: distinct principals and distinct keys. Self-approval is the same principal in both roles.
    if (requester.decision.principalId === approver.decision.principalId || keyIds[0] === keyIds[1]) return deny('SAME_PRINCIPAL');
    for (const ref of refs) if (isConsumed(ref.decisionId)) return deny('ALREADY_CONSUMED');
    return { authorized: true, refs: [refs[0]!, refs[1]!], signed: [signedCopies[0]!, signedCopies[1]!] };
  } catch {
    return deny('DECISION_MALFORMED');
  }
}

export function isSignedHumanDecision(value: unknown): value is SignedHumanDecision {
  return typeof readDecision(value) !== 'string';
}
