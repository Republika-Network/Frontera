import { randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * AUTH-04B — Authority sessions and login ceremonies, in this process's memory.
 *
 * A session proves **which human is signed in** — never that they may approve
 * anything. It holds the operator id and the credential the human signed in
 * with, a per-session CSRF token, and the decision commitments issued to it.
 * No permission, role, approval or verdict is ever stored here: every read is
 * scoped again on the server, and every decision needs its own fresh WebAuthn
 * assertion over its own AUTH-03 challenge.
 *
 * Bounded: an absolute lifetime and an idle timeout on a **monotonic** clock
 * (a wall-clock step can neither extend nor end one; a reading that goes
 * backwards ends it), and at most `maxSessions` live sessions. One Host
 * process (the pilot model): a restart drops every session, and the human
 * signs in again. Nothing about a session survives a restart, so nothing can
 * authorize from memory after one.
 */

export interface AuthoritySession {
  readonly id: string;
  readonly operatorId: string;
  /** The credential the human signed in with. Its revocation ends the session. */
  readonly credentialId: string;
  readonly csrfToken: string;
  readonly createdAtMs: number;
  lastSeenAtMs: number;
  /** Decision commitments issued to this session; a submission must answer one of them. */
  readonly issued: Set<string>;
}

export interface LoginCeremony {
  readonly nonce: string;
  readonly challenge: string;
  readonly createdAtMs: number;
}

export interface AuthoritySessionStoreOptions {
  readonly now?: () => number;
  readonly absoluteTtlMs: number;
  readonly idleTtlMs: number;
  /** Lifetime of a pending login ceremony (the login challenge's own lifetime). */
  readonly loginTtlMs: number;
  readonly maxSessions?: number;
  readonly maxCeremonies?: number;
}

export interface AuthoritySessionStore {
  create(operatorId: string, credentialId: string): AuthoritySession;
  get(id: string | undefined): AuthoritySession | undefined;
  destroy(id: string | undefined): void;
  /** Ends every session of a human (revocation). */
  destroyHuman(operatorId: string): void;
  beginLogin(challenge: string): LoginCeremony;
  /** Takes (one-shot) the live ceremony for a nonce. */
  takeLogin(nonce: string | undefined): LoginCeremony | undefined;
  size(): number;
}

const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const MAX_ISSUED = 32;

export const newToken = (): string => randomBytes(32).toString('base64url');

export function createAuthoritySessionStore(options: AuthoritySessionStoreOptions): AuthoritySessionStore {
  const now = options.now ?? ((): number => performance.now());
  const { absoluteTtlMs, idleTtlMs, loginTtlMs } = options;
  const maxSessions = options.maxSessions ?? 256;
  const maxCeremonies = options.maxCeremonies ?? 1_024;
  if (!(absoluteTtlMs > 0 && idleTtlMs > 0 && idleTtlMs <= absoluteTtlMs && loginTtlMs > 0)) throw new Error('createAuthoritySessionStore: lifetimes must be positive and the idle timeout at most the absolute lifetime.');
  const sessions = new Map<string, AuthoritySession>();
  const ceremonies = new Map<string, LoginCeremony>();

  const expired = (session: AuthoritySession, at: number): boolean => at - session.createdAtMs >= absoluteTtlMs || at - session.lastSeenAtMs >= idleTtlMs || at < session.lastSeenAtMs;
  const bounded = <T>(map: Map<string, T>, maximum: number): void => {
    while (map.size >= maximum) {
      const oldest = map.keys().next().value;
      if (oldest === undefined) break;
      map.delete(oldest);
    }
  };

  return Object.freeze({
    create(operatorId: string, credentialId: string): AuthoritySession {
      const at = now();
      for (const [id, session] of sessions) if (expired(session, at)) sessions.delete(id);
      bounded(sessions, maxSessions);
      const session: AuthoritySession = { id: newToken(), operatorId, credentialId, csrfToken: newToken(), createdAtMs: at, lastSeenAtMs: at, issued: new Set() };
      sessions.set(session.id, session);
      return session;
    },
    get(id: string | undefined): AuthoritySession | undefined {
      if (id === undefined || !TOKEN.test(id)) return undefined;
      const session = sessions.get(id);
      if (session === undefined) return undefined;
      const at = now();
      if (expired(session, at)) {
        sessions.delete(id);
        return undefined;
      }
      session.lastSeenAtMs = at;
      return session;
    },
    destroy(id: string | undefined): void {
      if (id !== undefined) sessions.delete(id);
    },
    destroyHuman(operatorId: string): void {
      for (const [id, session] of sessions) if (session.operatorId === operatorId) sessions.delete(id);
    },
    beginLogin(challenge: string): LoginCeremony {
      const at = now();
      for (const [nonce, ceremony] of ceremonies) if (at - ceremony.createdAtMs >= loginTtlMs || at < ceremony.createdAtMs) ceremonies.delete(nonce);
      bounded(ceremonies, maxCeremonies);
      const ceremony: LoginCeremony = { nonce: newToken(), challenge, createdAtMs: at };
      ceremonies.set(ceremony.nonce, ceremony);
      return ceremony;
    },
    takeLogin(nonce: string | undefined): LoginCeremony | undefined {
      if (nonce === undefined || !TOKEN.test(nonce)) return undefined;
      const ceremony = ceremonies.get(nonce);
      ceremonies.delete(nonce);
      if (ceremony === undefined) return undefined;
      const at = now();
      return at - ceremony.createdAtMs >= loginTtlMs || at < ceremony.createdAtMs ? undefined : ceremony;
    },
    size: () => sessions.size,
  });
}

/** Records a commitment issued to a session (bounded; the oldest is forgotten first). */
export function rememberIssued(session: AuthoritySession, commitment: string): void {
  while (session.issued.size >= MAX_ISSUED) {
    const oldest = session.issued.values().next().value;
    if (oldest === undefined) break;
    session.issued.delete(oldest);
  }
  session.issued.add(commitment);
}

/** Constant-time comparison of two tokens (a length mismatch is simply unequal). */
export function tokensEqual(left: string | undefined, right: string | undefined): boolean {
  if (left === undefined || right === undefined) return false;
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}
