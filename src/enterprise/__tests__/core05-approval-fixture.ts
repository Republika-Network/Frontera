import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';

import type { KernelEffectiveProfileResolver, KernelEvaluationRequest, KernelEvaluationResult } from '../../kernel/index.js';
import {
  ApprovalAuthorityError,
  approvalGenesisDigest,
  approvalRowDigest,
  createApprovalAuthority,
  createSqliteApprovalStore,
  nextApprovalChainDigest,
  type ApprovalAssessInput,
  type ApprovalAuthority,
  type ApprovalAuthorityErrorCode,
  type ApprovalAuthorityPort,
  type ApprovalCommand,
  type ApprovalCommandContext,
  type ApprovalRecordKind,
  type ApprovalRowContent,
  type ApprovalStore,
} from '../approval-authority/index.js';
import { createGovernanceProfileRegistry, type GovernanceProfileApproval, type GovernanceProfileRegistry } from '../governance-profile/index.js';
import { AUTHORITY_KEY_UNTRUSTED, testAuthenticity, testSigner } from './authority-authenticity-fixture.js';

/**
 * CORE-05 — the engine-side approval authority, below the Host: a real
 * Governance Profile registry, the real trusted effective-profile resolution,
 * the real durable signed store, and a Kernel-Authority stand-in whose answers
 * each test controls (the Host suites use the real durable world).
 *
 * The attacker model for the store helpers: direct write access to the SQLite
 * file and every algorithm in this repository — row serialization, row digest,
 * chain, head format, subject digest — but not the deployment's authority
 * signing key (it may sign with one of its own).
 */

export const ORG = 'org-a';
export const EVALUATED = '2026-09-28T12:00:00.000Z';
export const at = (seconds: number): string => new Date(Date.parse(EVALUATED) + seconds * 1000).toISOString();

export const REQUIREMENT: GovernanceProfileApproval = { approverAction: 'approve-payment', minimumApprovals: 2, requestTtlSeconds: 3600, approvalValiditySeconds: 900 };

export function governanceWith(approval: GovernanceProfileApproval | null = REQUIREMENT, version = 1): GovernanceProfileRegistry {
  return createGovernanceProfileRegistry({
    parameterDimensions: [{ id: 'amount', type: 'integer', bound: 'exact' }],
    actionClasses: [
      { id: 'pay', actions: ['pay-vendor'] },
      { id: 'read', actions: ['read-ledger'] },
    ],
    resourceClasses: [{ id: 'ledger', resources: ['ledger-1', 'ledger-2'] }],
    profiles: [
      {
        profileId: 'vendor-payment',
        version,
        owner: ORG,
        provenance: { authoredBy: 'operator:finance', approvedBy: 'operator:security' },
        actionClass: 'pay',
        resourceClass: 'ledger',
        parameters: [{ dimension: 'amount', required: true }],
        materialFacts: [],
        relevantPolicies: [],
        ...(approval !== null ? { approval } : {}),
      },
      {
        profileId: 'ledger-read',
        version: 1,
        owner: ORG,
        provenance: { authoredBy: 'operator:finance', approvedBy: 'operator:security' },
        actionClass: 'read',
        resourceClass: 'ledger',
        parameters: [],
        materialFacts: [],
        relevantPolicies: [],
        approval: { approverAction: 'approve-read', minimumApprovals: 1, requestTtlSeconds: 3600, approvalValiditySeconds: 900 },
      },
    ],
  });
}

export function resolverOf(governance: GovernanceProfileRegistry): KernelEffectiveProfileResolver {
  return (action, resourceScope) => {
    const resolution = governance.resolve(action, resourceScope);
    if (resolution.kind === 'resolved') return { kind: 'resolved', profile: resolution.profile.reference };
    return resolution.kind === 'unclassified' ? { kind: 'unclassified' } : { kind: 'refused' };
  };
}

export const REQUESTER = 'actor-agent';
export const OWNER = 'actor-owner';

export interface TargetOptions {
  readonly requestId?: string;
  readonly decisionId?: string;
  readonly amount?: number;
  readonly action?: string;
  readonly resource?: string;
  readonly contextDigest?: string;
  readonly status?: KernelEvaluationResult['status'];
  readonly reasonCodes?: readonly string[];
  readonly semantics?: 'trusted' | 'absent' | 'bogus' | 'weaker';
  readonly principalId?: string;
  readonly requestDigest?: string;
  readonly governance?: GovernanceProfileRegistry;
}

/** A committed decision awaiting approval, as the orchestrator hands it to `assess`. */
export function target(options: TargetOptions = {}): ApprovalAssessInput {
  const governance = options.governance ?? governanceWith();
  const action = options.action ?? 'pay-vendor';
  const resource = options.resource ?? 'ledger-1';
  const resolution = governance.resolve(action, resource);
  const semantics = options.semantics ?? 'trusted';
  const request: KernelEvaluationRequest = {
    requestId: options.requestId ?? 'aoc.gar:target',
    actor: { id: REQUESTER, trustDomainId: 'td', ...(options.principalId !== undefined ? { principalId: options.principalId } : {}) },
    action: {
      type: action,
      resourceScope: resource,
      ...(semantics === 'absent' || resolution.kind !== 'resolved'
        ? {}
        : semantics === 'weaker'
          ? (() => {
              // Another *configured* profile — one whose requirement is weaker (quorum 1).
              const weaker = governance.profiles.find((profile) => profile.definition.profileId === 'ledger-read');
              if (weaker === undefined) throw new Error('fixture: no ledger-read profile');
              return { semantics: { actionClass: weaker.definition.actionClass, resourceClass: weaker.definition.resourceClass, governanceProfile: weaker.reference } };
            })()
          : {
            semantics: {
              actionClass: resolution.profile.definition.actionClass,
              resourceClass: resolution.profile.definition.resourceClass,
              governanceProfile: semantics === 'bogus' ? { ...resolution.profile.reference, digest: `sha256:${'0'.repeat(64)}` } : resolution.profile.reference,
            },
          }),
      ...(action === 'pay-vendor' ? { governedParameters: [{ dimension: 'amount', type: 'integer', value: options.amount ?? 900, bound: 'exact' }] } : {}),
    },
    organization: { id: ORG },
    requestedAt: EVALUATED,
  } as KernelEvaluationRequest;
  const decision = {
    decisionId: options.decisionId ?? 'decision-target',
    status: options.status ?? 'approval_required',
    reasonCodes: options.reasonCodes ?? ['DOMAIN_POLICY_DENIED', 'APPROVAL_REQUIRED'],
    evaluatedAt: EVALUATED,
    ...(options.contextDigest !== undefined ? { context: { digest: options.contextDigest } } : {}),
  } as unknown as KernelEvaluationResult;
  return {
    request,
    decision,
    evaluationId: 'evaluation-target',
    decisionDigest: { requestDigest: options.requestDigest ?? `sha256:${'1'.repeat(64)}`, evaluationDigest: `sha256:${'2'.repeat(64)}` },
  };
}

/**
 * A controllable Kernel-Authority stand-in: `holders` maps actor → the
 * `capability@resource` pairs they hold live authority for. Unknown actors
 * are unrecognized.
 */
export class Authority implements ApprovalAuthorityPort {
  readonly holders = new Map<string, Set<string>>([
    ['approver-a', new Set(['approve-payment@ledger-1', 'approve-read@ledger-1'])],
    ['approver-b', new Set(['approve-payment@ledger-1'])],
    ['approver-c', new Set(['approve-payment@ledger-1'])],
    ['approver-elsewhere', new Set(['approve-payment@ledger-2'])],
    // The requester holds approver authority too — segregation of duties, not authority, keeps it from approving.
    [REQUESTER, new Set(['approve-payment@ledger-1'])],
    [OWNER, new Set(['approve-payment@ledger-1'])],
    ['actor-no-authority', new Set()],
  ]);

  recognition(actorId: string) {
    return this.holders.has(actorId)
      ? { recognized: true, reasonCode: 'APPROVER_RECOGNIZED', reason: 'known' }
      : { recognized: false, reasonCode: 'APPROVER_UNKNOWN', reason: 'unknown' };
  }

  authority(query: { readonly actorId: string; readonly capability: string; readonly resourceScope: string }) {
    const held = this.holders.get(query.actorId);
    if (held?.has(`${query.capability}@${query.resourceScope}`) === true) return { valid: true, type: 'authority_valid', reasonCode: 'AUTHORITY_VALID', reason: 'held' };
    if ([...(held ?? [])].some((entry) => entry.startsWith(`${query.capability}@`))) return { valid: false, type: 'scope_expansion_detected', reasonCode: 'SCOPE_EXPANSION', reason: 'other scope' };
    return { valid: false, type: 'authority_missing', reasonCode: 'AUTHORITY_MISSING', reason: 'none' };
  }

  revoke(actorId: string): void {
    this.holders.set(actorId, new Set());
  }
}

export class Clock {
  value = at(60);
  readonly now = (): string => this.value;
}

export function authorityOver(store: ApprovalStore, options: { readonly governance?: GovernanceProfileRegistry; readonly authority?: Authority; readonly clock?: Clock } = {}): ApprovalAuthority {
  const governance = options.governance ?? governanceWith();
  const clock = options.clock ?? new Clock();
  return createApprovalAuthority({
    store,
    governance,
    resolveEffectiveProfile: resolverOf(governance),
    organizationId: ORG,
    authority: options.authority ?? new Authority(),
    now: clock.now,
  });
}

export const actor = (actorId: string): ApprovalCommandContext => ({ authenticated: true, actorId, authenticatedBy: 'test:trusted-session' });

export async function opened(authority: ApprovalAuthority, input: ApprovalAssessInput = target()): Promise<ApprovalCommand> {
  assert.deepEqual(await authority.assess(input), { kind: 'withheld', status: 'pending' });
  const view = await authority.describe(input.request.requestId);
  assert.ok(view !== undefined);
  return { approvalRequestId: view.approvalRequestId, subjectDigest: view.subjectDigest };
}

export const refusedWith =
  (code: ApprovalAuthorityErrorCode) =>
  (error: unknown): boolean =>
    error instanceof ApprovalAuthorityError && error.code === code;

export const corrupt = refusedWith('APPROVAL_STORE_CORRUPT');

const directories: string[] = [];
const stores: ApprovalStore[] = [];

export async function cleanup(): Promise<void> {
  for (const store of stores) await store.close().catch(() => {});
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
}

export function storePath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'frontera-approval-'));
  directories.push(dir);
  return join(dir, 'approvals.sqlite');
}

export async function openStore(
  file: string,
  options: { readonly organizationId?: string; readonly authenticity?: ReturnType<typeof testAuthenticity>; readonly clock?: Clock } = {},
): Promise<ApprovalStore> {
  const clock = options.clock ?? new Clock();
  const store = await createSqliteApprovalStore(file, { now: clock.now, organizationId: options.organizationId ?? ORG, authenticity: options.authenticity ?? testAuthenticity() });
  stores.push(store);
  return store;
}

export interface RawRow {
  sequence: number;
  organization_id: string;
  request_id: string;
  decision_id: string;
  subject_digest: string;
  kind: string;
  subject: string | null;
  actor_id: string | null;
  evidence: string | null;
  reason: string | null;
  recorded_by: string;
  recorded_at: string;
  row_digest: string;
}

export function contentOf(row: RawRow): ApprovalRowContent {
  return {
    organizationId: row.organization_id,
    requestId: row.request_id,
    decisionId: row.decision_id,
    subjectDigest: row.subject_digest,
    kind: row.kind as ApprovalRecordKind,
    ...(row.subject !== null ? { subject: row.subject } : {}),
    ...(row.actor_id !== null ? { actorId: row.actor_id } : {}),
    ...(row.evidence !== null ? { evidence: row.evidence } : {}),
    ...(row.reason !== null ? { reason: row.reason } : {}),
    recordedBy: row.recorded_by,
    recordedAt: row.recorded_at,
  };
}

export function rawRows(file: string): RawRow[] {
  const db = new Database(file, { readonly: true });
  try {
    return (db.prepare('SELECT * FROM approval_records ORDER BY sequence').all() as RawRow[]).map((row) => ({ ...row }));
  } finally {
    db.close();
  }
}

export function rawHead(file: string): { sequence: number; chain_digest: string; signature_json: string } {
  const db = new Database(file, { readonly: true });
  try {
    return db.prepare('SELECT sequence, chain_digest, signature_json FROM approval_head WHERE id = 1').get() as { sequence: number; chain_digest: string; signature_json: string };
  } finally {
    db.close();
  }
}

export const INSERT_ROW =
  'INSERT INTO approval_records VALUES (@sequence, @organization_id, @request_id, @decision_id, @subject_digest, @kind, @subject, @actor_id, @evidence, @reason, @recorded_by, @recorded_at, @row_digest)';

/**
 * Rewrites the whole history the way an attacker with the algorithms would:
 * recomputed row digests and chain, and a head that is either kept, left
 * untouched, or re-signed with the attacker's own key.
 */
export async function forge(file: string, edit: (rows: RawRow[]) => RawRow[], signature: 'keep' | 'attacker-key' | 'head-untouched' = 'attacker-key'): Promise<void> {
  const db = new Database(file);
  try {
    const meta = db.prepare('SELECT store_id, organization_id FROM approval_store_meta WHERE id = 1').get() as { store_id: string; organization_id: string };
    const current = db.prepare('SELECT signature_json FROM approval_head WHERE id = 1').get() as { signature_json: string };
    const edited = edit((db.prepare('SELECT * FROM approval_records ORDER BY sequence').all() as RawRow[]).map((row) => ({ ...row })));
    let chain = approvalGenesisDigest(meta.store_id, meta.organization_id);
    edited.forEach((row, index) => {
      row.sequence = index + 1;
      row.row_digest = approvalRowDigest(meta.store_id, row.sequence, contentOf(row));
      chain = nextApprovalChainDigest(chain, row.row_digest);
    });
    const forgedSignature =
      signature !== 'attacker-key'
        ? current.signature_json
        : JSON.stringify(await testSigner(AUTHORITY_KEY_UNTRUSTED).signApprovalState({ storeId: meta.store_id, organizationId: meta.organization_id, sequence: edited.length, chainDigest: chain }));
    db.exec('DROP TRIGGER IF EXISTS approval_records_no_update; DROP TRIGGER IF EXISTS approval_records_no_delete;');
    db.transaction(() => {
      db.prepare('DELETE FROM approval_records').run();
      const insert = db.prepare(INSERT_ROW);
      for (const row of edited) insert.run(row);
      if (signature !== 'head-untouched') db.prepare('UPDATE approval_head SET sequence = ?, chain_digest = ?, signature_json = ? WHERE id = 1').run(edited.length, chain, forgedSignature);
    })();
  } finally {
    db.close();
  }
}

/** A verdict row an attacker would add, modelled on the genuine `requested` row. */
export const forgedVerdict = (template: RawRow, actorId: string, kind: ApprovalRecordKind = 'approved', recordedAt = at(120)): RawRow => ({
  ...template,
  kind,
  subject: null,
  actor_id: actorId,
  evidence: null,
  reason: null,
  recorded_by: 'attacker',
  recorded_at: recordedAt,
});
