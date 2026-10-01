import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/**
 * CTRL-02 — the control-plane store.
 *
 * Two facts the operator plane owns and Kernel Authority does not:
 *
 * 1. **Operator-issued agent credentials** — which customer-plane credential
 *    authenticates which agent principal. Only a verifier (SHA-256 of a
 *    256-bit random secret) is stored; the secret itself is never written.
 *    A principal binds exactly one external subject, which binds exactly one
 *    Kernel-Authority actor; admission still resolves that actor through the
 *    Kernel Authority on every request, so nothing here decides whether the
 *    actor exists, is revoked, or what it may do.
 * 2. **The Governance Profile lifecycle** — which catalog version of a
 *    profile an identified operator activated or retired, and when.
 *
 * Neither is authority. The Kernel Authority stays the only authority source
 * on the governed path, and this store holds no grant, no constraint and no
 * actor status.
 *
 * Append-only by construction: rows are inserted; the single permitted update
 * is a credential's `active → revoked` transition, and SQLite triggers refuse
 * every other UPDATE and every DELETE — so no code path, current or future,
 * can un-revoke a credential or rewrite lifecycle history through this file's
 * connection. A party with write access to the database file itself is outside
 * this boundary (see the CTRL-02 ADR, residual risks).
 */

export const CONTROL_PLANE_SCHEMA_VERSION = 'frontera.control-plane.schema.v1';

export type ControlPlaneStoreErrorCode =
  | 'CONTROL_PLANE_STORE_UNAVAILABLE'
  | 'CONTROL_PLANE_INTEGRITY_FAILED'
  | 'CONTROL_PLANE_VERSION_UNSUPPORTED'
  | 'CONTROL_PLANE_IDEMPOTENCY_CONFLICT'
  | 'CONTROL_PLANE_CONFLICT'
  | 'CONTROL_PLANE_NOT_FOUND';

export class ControlPlaneStoreError extends Error {
  constructor(
    readonly code: ControlPlaneStoreErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ControlPlaneStoreError';
  }
}

export function isControlPlaneStoreError(error: unknown): error is ControlPlaneStoreError {
  return error instanceof ControlPlaneStoreError;
}

// -- records ------------------------------------------------------------------------

export interface AgentPrincipalRecord {
  readonly organizationId: string;
  readonly principalId: string;
  readonly actorId: string;
  readonly externalSubject: { readonly system: string; readonly subjectId: string };
  readonly createdBy: string;
  readonly createdAt: string;
}

export type AgentCredentialStatus = 'active' | 'revoked';

/** One credential's metadata. There is no secret and no verifier on this type. */
export interface AgentCredentialRecord {
  readonly organizationId: string;
  readonly credentialId: string;
  readonly principalId: string;
  readonly status: AgentCredentialStatus;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly revokedBy?: string;
  readonly revokedAt?: string;
  readonly revocationReason?: string;
  /** Set on a credential issued by rotation: the credential it replaced. */
  readonly replacesCredentialId?: string;
}

/** What admission reads for one presented credential id: the metadata, the principal, and the verifier to compare against. Never leaves the admission path. */
export interface AgentCredentialVerificationRecord {
  readonly credential: AgentCredentialRecord;
  readonly principal: AgentPrincipalRecord;
  readonly verifier: string;
}

export type ProfileLifecycleTransition = 'activated' | 'retired';

export interface ProfileLifecycleEvent {
  readonly sequence: number;
  readonly organizationId: string;
  readonly profileId: string;
  readonly version: number;
  readonly digest: string;
  readonly transition: ProfileLifecycleTransition;
  /** The operator the transition is attributed to (`operator:<operatorId>`), from the authenticated credential. */
  readonly operatorRef: string;
  readonly occurredAt: string;
  readonly reason?: string;
}

export interface IssueAgentCredentialInput {
  readonly organizationId: string;
  /** The principal to bind (created on first issuance; must match an existing one exactly). */
  readonly principal: { readonly principalId: string; readonly actorId: string; readonly externalSubject: { readonly system: string; readonly subjectId: string } };
  readonly credentialId: string;
  readonly verifier: string;
  readonly operatorRef: string;
  readonly at: string;
  readonly idempotencyKey: string;
  /** Digest of the logical request (operation + target + body), pinning the idempotency key to it. */
  readonly requestDigest: string;
  /** Rotation: the active credential of the same principal this one replaces, revoked in the same transaction. */
  readonly replaces?: string;
}

export interface IssueAgentCredentialResult {
  readonly outcome: 'issued' | 'replayed';
  readonly credential: AgentCredentialRecord;
  readonly principal: AgentPrincipalRecord;
  /** On rotation: the replaced credential, now revoked. */
  readonly replaced?: AgentCredentialRecord;
}

export interface RevokeAgentCredentialInput {
  readonly organizationId: string;
  readonly credentialId: string;
  readonly operatorRef: string;
  readonly at: string;
  readonly reason: string;
}

export interface TransitionProfileInput {
  readonly organizationId: string;
  readonly profileId: string;
  readonly version: number;
  readonly digest: string;
  readonly transition: ProfileLifecycleTransition;
  readonly operatorRef: string;
  readonly at: string;
  readonly reason?: string;
}

export interface TransitionProfileResult {
  readonly outcome: 'activated' | 'retired' | 'already-active' | 'already-retired';
  /** Events appended by this call, in order (empty on a replay). Activation over a live version appends that version's retirement first. */
  readonly appended: readonly ProfileLifecycleEvent[];
}

export interface ControlPlaneStore {
  readonly providerKind: 'sqlite';
  issueAgentCredential(input: IssueAgentCredentialInput): Promise<IssueAgentCredentialResult>;
  revokeAgentCredential(input: RevokeAgentCredentialInput): Promise<{ readonly outcome: 'revoked' | 'already-revoked'; readonly credential: AgentCredentialRecord }>;
  /** Admission's one read. Scoped to the organization; a credential of another organization is `undefined`. */
  readAgentCredentialForVerification(organizationId: string, credentialId: string): Promise<AgentCredentialVerificationRecord | undefined>;
  getAgentPrincipalByActor(organizationId: string, actorId: string): Promise<AgentPrincipalRecord | undefined>;
  listAgentPrincipals(organizationId: string): Promise<readonly AgentPrincipalRecord[]>;
  listAgentCredentials(organizationId: string, principalId: string): Promise<readonly AgentCredentialRecord[]>;
  listProfileLifecycleEvents(organizationId: string): Promise<readonly ProfileLifecycleEvent[]>;
  transitionProfile(input: TransitionProfileInput): Promise<TransitionProfileResult>;
  health(): Promise<{ readonly status: 'healthy' | 'unhealthy'; readonly readable: boolean }>;
  close(): Promise<void>;
}

// -- schema -------------------------------------------------------------------------

const SCHEMA_V1 = `
  CREATE TABLE IF NOT EXISTS control_plane_versions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    schema_version TEXT NOT NULL,
    recorded_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS agent_principals (
    organization_id TEXT NOT NULL,
    principal_id TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    external_system TEXT NOT NULL,
    external_subject_id TEXT NOT NULL,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (organization_id, principal_id),
    UNIQUE (organization_id, actor_id),
    UNIQUE (organization_id, external_system, external_subject_id)
  );

  CREATE TABLE IF NOT EXISTS agent_credentials (
    credential_id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    principal_id TEXT NOT NULL,
    verifier TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    revoked_by TEXT,
    revoked_at TEXT,
    revocation_reason TEXT,
    replaces_credential_id TEXT,
    FOREIGN KEY (organization_id, principal_id) REFERENCES agent_principals(organization_id, principal_id)
  );
  CREATE INDEX IF NOT EXISTS idx_agent_credentials_principal ON agent_credentials(organization_id, principal_id);

  CREATE TABLE IF NOT EXISTS agent_credential_idempotency (
    organization_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    request_digest TEXT NOT NULL,
    credential_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (organization_id, idempotency_key)
  );

  CREATE TABLE IF NOT EXISTS profile_lifecycle_events (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    organization_id TEXT NOT NULL,
    profile_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    digest TEXT NOT NULL,
    transition TEXT NOT NULL CHECK (transition IN ('activated', 'retired')),
    operator_ref TEXT NOT NULL,
    occurred_at TEXT NOT NULL,
    reason TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_profile_lifecycle_org ON profile_lifecycle_events(organization_id, sequence);

  CREATE TRIGGER IF NOT EXISTS agent_principals_immutable BEFORE UPDATE ON agent_principals
    BEGIN SELECT RAISE(ABORT, 'agent principals are immutable'); END;
  CREATE TRIGGER IF NOT EXISTS agent_principals_permanent BEFORE DELETE ON agent_principals
    BEGIN SELECT RAISE(ABORT, 'agent principals are never deleted'); END;
  CREATE TRIGGER IF NOT EXISTS agent_credentials_permanent BEFORE DELETE ON agent_credentials
    BEGIN SELECT RAISE(ABORT, 'agent credentials are never deleted'); END;
  CREATE TRIGGER IF NOT EXISTS agent_credentials_revocation_only BEFORE UPDATE ON agent_credentials
    WHEN NOT (
      OLD.status = 'active' AND NEW.status = 'revoked'
      AND NEW.credential_id = OLD.credential_id AND NEW.organization_id = OLD.organization_id
      AND NEW.principal_id = OLD.principal_id AND NEW.verifier = OLD.verifier
      AND NEW.created_by = OLD.created_by AND NEW.created_at = OLD.created_at
      AND NEW.replaces_credential_id IS OLD.replaces_credential_id
      AND NEW.revoked_by IS NOT NULL AND NEW.revoked_at IS NOT NULL AND NEW.revocation_reason IS NOT NULL
    )
    BEGIN SELECT RAISE(ABORT, 'an agent credential changes only from active to revoked, once'); END;
  CREATE TRIGGER IF NOT EXISTS agent_credential_idempotency_immutable BEFORE UPDATE ON agent_credential_idempotency
    BEGIN SELECT RAISE(ABORT, 'idempotency claims are immutable'); END;
  CREATE TRIGGER IF NOT EXISTS agent_credential_idempotency_permanent BEFORE DELETE ON agent_credential_idempotency
    BEGIN SELECT RAISE(ABORT, 'idempotency claims are never deleted'); END;
  CREATE TRIGGER IF NOT EXISTS profile_lifecycle_events_immutable BEFORE UPDATE ON profile_lifecycle_events
    BEGIN SELECT RAISE(ABORT, 'profile lifecycle history is append-only'); END;
  CREATE TRIGGER IF NOT EXISTS profile_lifecycle_events_permanent BEFORE DELETE ON profile_lifecycle_events
    BEGIN SELECT RAISE(ABORT, 'profile lifecycle history is append-only'); END;
`;

interface PrincipalRow {
  readonly organization_id: string;
  readonly principal_id: string;
  readonly actor_id: string;
  readonly external_system: string;
  readonly external_subject_id: string;
  readonly created_by: string;
  readonly created_at: string;
}

interface CredentialRow {
  readonly credential_id: string;
  readonly organization_id: string;
  readonly principal_id: string;
  readonly verifier: string;
  readonly status: string;
  readonly created_by: string;
  readonly created_at: string;
  readonly revoked_by: string | null;
  readonly revoked_at: string | null;
  readonly revocation_reason: string | null;
  readonly replaces_credential_id: string | null;
}

interface LifecycleRow {
  readonly sequence: number;
  readonly organization_id: string;
  readonly profile_id: string;
  readonly version: number;
  readonly digest: string;
  readonly transition: string;
  readonly operator_ref: string;
  readonly occurred_at: string;
  readonly reason: string | null;
}

const VERIFIER = /^[0-9a-f]{64}$/;

function integrity(message: string): ControlPlaneStoreError {
  return new ControlPlaneStoreError('CONTROL_PLANE_INTEGRITY_FAILED', message);
}

function toPrincipal(row: PrincipalRow): AgentPrincipalRecord {
  return Object.freeze({
    organizationId: row.organization_id,
    principalId: row.principal_id,
    actorId: row.actor_id,
    externalSubject: Object.freeze({ system: row.external_system, subjectId: row.external_subject_id }),
    createdBy: row.created_by,
    createdAt: row.created_at,
  });
}

/** A row read back is re-proven before it is believed: a status outside the closed set, or a revoked row without its revocation facts, is corruption. */
function toCredential(row: CredentialRow): AgentCredentialRecord {
  if (row.status !== 'active' && row.status !== 'revoked') throw integrity('An agent credential row carries an unknown status.');
  if (row.status === 'revoked' && (row.revoked_by === null || row.revoked_at === null || row.revocation_reason === null)) throw integrity('A revoked agent credential row lacks its revocation facts.');
  if (row.status === 'active' && (row.revoked_by !== null || row.revoked_at !== null || row.revocation_reason !== null)) throw integrity('An active agent credential row carries revocation facts.');
  if (!VERIFIER.test(row.verifier)) throw integrity('An agent credential row carries a malformed verifier.');
  return Object.freeze({
    organizationId: row.organization_id,
    credentialId: row.credential_id,
    principalId: row.principal_id,
    status: row.status,
    createdBy: row.created_by,
    createdAt: row.created_at,
    ...(row.revoked_by !== null ? { revokedBy: row.revoked_by } : {}),
    ...(row.revoked_at !== null ? { revokedAt: row.revoked_at } : {}),
    ...(row.revocation_reason !== null ? { revocationReason: row.revocation_reason } : {}),
    ...(row.replaces_credential_id !== null ? { replacesCredentialId: row.replaces_credential_id } : {}),
  });
}

function toLifecycleEvent(row: LifecycleRow): ProfileLifecycleEvent {
  if (row.transition !== 'activated' && row.transition !== 'retired') throw integrity('A profile lifecycle event carries an unknown transition.');
  return Object.freeze({
    sequence: row.sequence,
    organizationId: row.organization_id,
    profileId: row.profile_id,
    version: row.version,
    digest: row.digest,
    transition: row.transition,
    operatorRef: row.operator_ref,
    occurredAt: row.occurred_at,
    ...(row.reason !== null ? { reason: row.reason } : {}),
  });
}

/** The state of each profile version, replayed from its history. Total and strict: an illegal sequence is corruption, never a best guess. */
export type ProfileVersionLifecycleState = 'draft' | 'active' | 'retired';

export interface ProfileLifecycleState {
  /** `profileId → version → { state, digest }` for every version with history. A catalog version with none is a draft. */
  readonly versions: ReadonlyMap<string, ReadonlyMap<number, { readonly state: 'active' | 'retired'; readonly digest: string; readonly event: ProfileLifecycleEvent }>>;
  /** `profileId → the one active version`, if any. */
  readonly active: ReadonlyMap<string, { readonly version: number; readonly digest: string }>;
}

/**
 * Replays an organization's lifecycle history. Legal transitions only: a
 * version is activated at most once, never after retirement, retired at most
 * once, under one digest for its whole life; at most one version of a profile
 * is active at any point. Anything else is refused as corruption.
 */
export function replayProfileLifecycle(events: readonly ProfileLifecycleEvent[]): ProfileLifecycleState {
  const versions = new Map<string, Map<number, { state: 'active' | 'retired'; digest: string; event: ProfileLifecycleEvent }>>();
  const active = new Map<string, { version: number; digest: string }>();
  let previous = 0;
  for (const event of events) {
    if (event.sequence <= previous) throw integrity('Profile lifecycle history is not in sequence order.');
    previous = event.sequence;
    const byVersion = versions.get(event.profileId) ?? new Map<number, { state: 'active' | 'retired'; digest: string; event: ProfileLifecycleEvent }>();
    versions.set(event.profileId, byVersion);
    const current = byVersion.get(event.version);
    if (current !== undefined && current.digest !== event.digest) throw integrity(`Profile ${event.profileId}@${event.version} changed digest within its lifecycle.`);
    if (event.transition === 'activated') {
      if (current !== undefined) throw integrity(`Profile ${event.profileId}@${event.version} was activated after it was already ${current.state}.`);
      if (active.has(event.profileId)) throw integrity(`Profile ${event.profileId} has two active versions.`);
      byVersion.set(event.version, { state: 'active', digest: event.digest, event });
      active.set(event.profileId, { version: event.version, digest: event.digest });
    } else {
      if (current?.state === 'retired') throw integrity(`Profile ${event.profileId}@${event.version} was retired twice.`);
      byVersion.set(event.version, { state: 'retired', digest: event.digest, event });
      if (active.get(event.profileId)?.version === event.version) active.delete(event.profileId);
    }
  }
  return { versions, active };
}

export interface CreateSqliteControlPlaneStoreOptions {
  readonly busyTimeoutMs?: number;
}

function resolveOnDisk(dbPath: string): string {
  const absolute = resolve(dbPath);
  const directory = dirname(absolute);
  if (!existsSync(directory)) mkdirSync(directory, { recursive: true });
  return absolute;
}

export async function createSqliteControlPlaneStore(dbPath: string, options: CreateSqliteControlPlaneStoreOptions = {}): Promise<ControlPlaneStore> {
  const { default: Database } = await import('better-sqlite3');
  let db: InstanceType<typeof Database>;
  try {
    db = new Database(dbPath === ':memory:' ? ':memory:' : resolveOnDisk(dbPath));
  } catch {
    throw new ControlPlaneStoreError('CONTROL_PLANE_STORE_UNAVAILABLE', 'The control-plane store could not be opened.');
  }
  db.pragma('foreign_keys = ON');
  if (dbPath !== ':memory:') db.pragma('journal_mode = WAL');
  db.pragma('synchronous = FULL');
  db.pragma(`busy_timeout = ${Math.max(0, Math.floor(options.busyTimeoutMs ?? 5_000))}`);

  const versionTable = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'control_plane_versions'`).get();
  if (versionTable !== undefined) {
    const recorded = db.prepare(`SELECT schema_version FROM control_plane_versions ORDER BY id DESC LIMIT 1`).get() as { schema_version: string } | undefined;
    if (recorded !== undefined && recorded.schema_version !== CONTROL_PLANE_SCHEMA_VERSION) {
      db.close();
      throw new ControlPlaneStoreError('CONTROL_PLANE_VERSION_UNSUPPORTED', 'The control-plane store was written under an unsupported schema version. Refusing to open it.');
    }
  }
  db.exec(SCHEMA_V1);
  if (db.prepare(`SELECT 1 FROM control_plane_versions LIMIT 1`).get() === undefined) {
    db.prepare(`INSERT INTO control_plane_versions (schema_version, recorded_at) VALUES (?, ?)`).run(CONTROL_PLANE_SCHEMA_VERSION, new Date().toISOString());
  }

  let closed = false;
  function live(): InstanceType<typeof Database> {
    if (closed) throw new ControlPlaneStoreError('CONTROL_PLANE_STORE_UNAVAILABLE', 'The control-plane store is closed.');
    return db;
  }

  /** Every driver failure that is not one of ours becomes `unavailable`; the driver's message (paths, SQL) never escapes. */
  function guarded<T>(work: () => T): T {
    try {
      return work();
    } catch (error) {
      if (isControlPlaneStoreError(error)) throw error;
      throw new ControlPlaneStoreError('CONTROL_PLANE_STORE_UNAVAILABLE', 'The control-plane store could not complete the operation.');
    }
  }

  const principalBy = (organizationId: string, principalId: string): PrincipalRow | undefined =>
    live().prepare(`SELECT * FROM agent_principals WHERE organization_id = ? AND principal_id = ?`).get(organizationId, principalId) as PrincipalRow | undefined;
  const credentialBy = (credentialId: string): CredentialRow | undefined => live().prepare(`SELECT * FROM agent_credentials WHERE credential_id = ?`).get(credentialId) as CredentialRow | undefined;

  function lifecycleEvents(organizationId: string): readonly ProfileLifecycleEvent[] {
    return (live().prepare(`SELECT * FROM profile_lifecycle_events WHERE organization_id = ? ORDER BY sequence`).all(organizationId) as LifecycleRow[]).map(toLifecycleEvent);
  }

  return Object.freeze({
    providerKind: 'sqlite' as const,

    async issueAgentCredential(input: IssueAgentCredentialInput): Promise<IssueAgentCredentialResult> {
      if (!VERIFIER.test(input.verifier)) throw new ControlPlaneStoreError('CONTROL_PLANE_CONFLICT', 'A credential verifier must be a SHA-256 hex digest.');
      return guarded(() =>
        live()
          .transaction((): IssueAgentCredentialResult => {
            const claim = live()
              .prepare(`SELECT request_digest, credential_id FROM agent_credential_idempotency WHERE organization_id = ? AND idempotency_key = ?`)
              .get(input.organizationId, input.idempotencyKey) as { request_digest: string; credential_id: string } | undefined;
            if (claim !== undefined) {
              if (claim.request_digest !== input.requestDigest) {
                throw new ControlPlaneStoreError('CONTROL_PLANE_IDEMPOTENCY_CONFLICT', 'This idempotency key was already used for a different credential request.');
              }
              const row = credentialBy(claim.credential_id);
              const principalRow = row === undefined ? undefined : principalBy(input.organizationId, row.principal_id);
              if (row === undefined || principalRow === undefined || row.organization_id !== input.organizationId) throw integrity('An idempotency claim names a credential that is not held.');
              return { outcome: 'replayed', credential: toCredential(row), principal: toPrincipal(principalRow) };
            }

            // The principal: created once, then immutable. A second issuance must name it identically.
            const existing = principalBy(input.organizationId, input.principal.principalId);
            if (existing === undefined) {
              const byActor = live().prepare(`SELECT principal_id FROM agent_principals WHERE organization_id = ? AND actor_id = ?`).get(input.organizationId, input.principal.actorId);
              const bySubject = live()
                .prepare(`SELECT principal_id FROM agent_principals WHERE organization_id = ? AND external_system = ? AND external_subject_id = ?`)
                .get(input.organizationId, input.principal.externalSubject.system, input.principal.externalSubject.subjectId);
              if (byActor !== undefined || bySubject !== undefined) throw new ControlPlaneStoreError('CONTROL_PLANE_CONFLICT', 'That actor or external subject is already bound to another agent principal.');
              live()
                .prepare(
                  `INSERT INTO agent_principals (organization_id, principal_id, actor_id, external_system, external_subject_id, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
                )
                .run(input.organizationId, input.principal.principalId, input.principal.actorId, input.principal.externalSubject.system, input.principal.externalSubject.subjectId, input.operatorRef, input.at);
            } else if (
              existing.actor_id !== input.principal.actorId ||
              existing.external_system !== input.principal.externalSubject.system ||
              existing.external_subject_id !== input.principal.externalSubject.subjectId
            ) {
              throw new ControlPlaneStoreError('CONTROL_PLANE_CONFLICT', 'The agent principal is bound to a different actor or external subject.');
            }

            let replaced: AgentCredentialRecord | undefined;
            if (input.replaces !== undefined) {
              const old = credentialBy(input.replaces);
              if (old === undefined || old.organization_id !== input.organizationId || old.principal_id !== input.principal.principalId) {
                throw new ControlPlaneStoreError('CONTROL_PLANE_NOT_FOUND', 'No credential with that id is held for this agent.');
              }
              if (old.status !== 'active') throw new ControlPlaneStoreError('CONTROL_PLANE_CONFLICT', 'Only an active credential can be rotated; a revoked credential stays revoked.');
              live()
                .prepare(`UPDATE agent_credentials SET status = 'revoked', revoked_by = ?, revoked_at = ?, revocation_reason = ? WHERE credential_id = ? AND status = 'active'`)
                .run(input.operatorRef, input.at, `rotated: replaced by ${input.credentialId}`, input.replaces);
              replaced = toCredential(credentialBy(input.replaces) as CredentialRow);
            }

            live()
              .prepare(
                `INSERT INTO agent_credentials (credential_id, organization_id, principal_id, verifier, status, created_by, created_at, replaces_credential_id) VALUES (?, ?, ?, ?, 'active', ?, ?, ?)`,
              )
              .run(input.credentialId, input.organizationId, input.principal.principalId, input.verifier, input.operatorRef, input.at, input.replaces ?? null);
            live()
              .prepare(`INSERT INTO agent_credential_idempotency (organization_id, idempotency_key, request_digest, credential_id, created_at) VALUES (?, ?, ?, ?, ?)`)
              .run(input.organizationId, input.idempotencyKey, input.requestDigest, input.credentialId, input.at);
            return {
              outcome: 'issued',
              credential: toCredential(credentialBy(input.credentialId) as CredentialRow),
              principal: toPrincipal(principalBy(input.organizationId, input.principal.principalId) as PrincipalRow),
              ...(replaced !== undefined ? { replaced } : {}),
            };
          })
          .immediate(),
      );
    },

    async revokeAgentCredential(input: RevokeAgentCredentialInput) {
      return guarded(() =>
        live()
          .transaction(() => {
            const row = credentialBy(input.credentialId);
            if (row === undefined || row.organization_id !== input.organizationId) throw new ControlPlaneStoreError('CONTROL_PLANE_NOT_FOUND', 'No credential with that id is held for this organization.');
            if (row.status === 'revoked') return { outcome: 'already-revoked' as const, credential: toCredential(row) };
            live()
              .prepare(`UPDATE agent_credentials SET status = 'revoked', revoked_by = ?, revoked_at = ?, revocation_reason = ? WHERE credential_id = ? AND status = 'active'`)
              .run(input.operatorRef, input.at, input.reason, input.credentialId);
            return { outcome: 'revoked' as const, credential: toCredential(credentialBy(input.credentialId) as CredentialRow) };
          })
          .immediate(),
      );
    },

    async readAgentCredentialForVerification(organizationId: string, credentialId: string) {
      return guarded(() => {
        const row = credentialBy(credentialId);
        if (row === undefined || row.organization_id !== organizationId) return undefined;
        const principal = principalBy(organizationId, row.principal_id);
        if (principal === undefined) throw integrity('An agent credential names a principal that is not held.');
        return Object.freeze({ credential: toCredential(row), principal: toPrincipal(principal), verifier: row.verifier });
      });
    },

    async getAgentPrincipalByActor(organizationId: string, actorId: string) {
      return guarded(() => {
        const row = live().prepare(`SELECT * FROM agent_principals WHERE organization_id = ? AND actor_id = ?`).get(organizationId, actorId) as PrincipalRow | undefined;
        return row === undefined ? undefined : toPrincipal(row);
      });
    },

    async listAgentPrincipals(organizationId: string) {
      return guarded(() => (live().prepare(`SELECT * FROM agent_principals WHERE organization_id = ? ORDER BY actor_id`).all(organizationId) as PrincipalRow[]).map(toPrincipal));
    },

    async listAgentCredentials(organizationId: string, principalId: string) {
      return guarded(() =>
        (live().prepare(`SELECT * FROM agent_credentials WHERE organization_id = ? AND principal_id = ? ORDER BY created_at, credential_id`).all(organizationId, principalId) as CredentialRow[]).map(
          toCredential,
        ),
      );
    },

    async listProfileLifecycleEvents(organizationId: string) {
      return guarded(() => lifecycleEvents(organizationId));
    },

    async transitionProfile(input: TransitionProfileInput): Promise<TransitionProfileResult> {
      return guarded(() =>
        live()
          .transaction((): TransitionProfileResult => {
            const state = replayProfileLifecycle(lifecycleEvents(input.organizationId));
            const current = state.versions.get(input.profileId)?.get(input.version);
            if (current !== undefined && current.digest !== input.digest) {
              throw new ControlPlaneStoreError('CONTROL_PLANE_CONFLICT', 'This profile version has lifecycle history under a different content digest; a version is immutable.');
            }
            const insert = (transition: ProfileLifecycleTransition, version: number, digest: string, reason: string | undefined): ProfileLifecycleEvent => {
              const result = live()
                .prepare(`INSERT INTO profile_lifecycle_events (organization_id, profile_id, version, digest, transition, operator_ref, occurred_at, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
                .run(input.organizationId, input.profileId, version, digest, transition, input.operatorRef, input.at, reason ?? null);
              return toLifecycleEvent(live().prepare(`SELECT * FROM profile_lifecycle_events WHERE sequence = ?`).get(result.lastInsertRowid) as LifecycleRow);
            };
            if (input.transition === 'activated') {
              if (current?.state === 'active') return { outcome: 'already-active', appended: [] };
              if (current?.state === 'retired') throw new ControlPlaneStoreError('CONTROL_PLANE_CONFLICT', 'A retired profile version is never activated again; promote a new version.');
              const appended: ProfileLifecycleEvent[] = [];
              const live_ = state.active.get(input.profileId);
              if (live_ !== undefined) appended.push(insert('retired', live_.version, live_.digest, `superseded by version ${input.version}`));
              appended.push(insert('activated', input.version, input.digest, input.reason));
              // Re-proven inside the transaction: the history this commits is a legal one.
              replayProfileLifecycle(lifecycleEvents(input.organizationId));
              return { outcome: 'activated', appended };
            }
            if (current?.state === 'retired') return { outcome: 'already-retired', appended: [] };
            const appended = [insert('retired', input.version, input.digest, input.reason)];
            replayProfileLifecycle(lifecycleEvents(input.organizationId));
            return { outcome: 'retired', appended };
          })
          .immediate(),
      );
    },

    async health() {
      try {
        live().prepare(`SELECT 1`).get();
        return { status: 'healthy' as const, readable: true };
      } catch {
        return { status: 'unhealthy' as const, readable: false };
      }
    },

    async close() {
      if (closed) return;
      closed = true;
      db.close();
    },
  });
}
