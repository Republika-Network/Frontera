import { randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * CTRL-03 — the console's server-side session.
 *
 * The operator's bearer credential is presented once, in the sign-in form,
 * verified against the Host (`GET /api/admin/organization`), and from then on
 * held **only here, in this process's memory**. The browser receives an opaque
 * 256-bit session id in an `HttpOnly`, `SameSite=Strict` cookie and a
 * per-session CSRF token embedded in forms — never the bearer.
 *
 * A session is bounded: an absolute lifetime and an idle timeout, whichever
 * comes first; sign-out deletes it. It holds no authority, no permission list
 * and no cached state: every page asks the Host again, so a session can never
 * permit anything the Host does not.
 */

export interface ConsoleSession {
  readonly id: string;
  /** The operator bearer credential. Read only by the request handler that calls the Host; never rendered, logged or serialized. */
  readonly bearer: string;
  readonly csrfToken: string;
  /** The operator id the Host reported at sign-in — for log attribution only, never for a decision. */
  readonly operatorId: string;
  readonly createdAtMs: number;
  lastSeenAtMs: number;
  /** A one-shot confirmation line for the next page (an outcome the Host returned). Never a secret. */
  flash: string | undefined;
}

export interface SessionStoreOptions {
  readonly now?: () => number;
  /** Absolute lifetime. Default 8 hours. */
  readonly absoluteTtlMs?: number;
  /** Idle timeout. Default 30 minutes. */
  readonly idleTtlMs?: number;
  /** At most this many live sessions; the oldest is dropped beyond it. */
  readonly maxSessions?: number;
}

export interface SessionStore {
  create(bearer: string, operatorId: string): ConsoleSession;
  /** The live session for this id, touched; `undefined` when unknown or expired (an expired one is deleted). */
  get(id: string | undefined): ConsoleSession | undefined;
  destroy(id: string | undefined): void;
  size(): number;
}

const newToken = (): string => randomBytes(32).toString('base64url');

export function createSessionStore(options: SessionStoreOptions = {}): SessionStore {
  const now = options.now ?? Date.now;
  const absoluteTtlMs = options.absoluteTtlMs ?? 8 * 60 * 60 * 1000;
  const idleTtlMs = options.idleTtlMs ?? 30 * 60 * 1000;
  const maxSessions = options.maxSessions ?? 256;
  if (!(absoluteTtlMs > 0 && absoluteTtlMs <= 12 * 60 * 60 * 1000)) throw new Error('createSessionStore: the absolute session lifetime must be greater than 0 and at most 12 hours.');
  if (!(idleTtlMs > 0 && idleTtlMs <= absoluteTtlMs)) throw new Error('createSessionStore: the idle timeout must be greater than 0 and at most the absolute lifetime.');
  const sessions = new Map<string, ConsoleSession>();

  const expired = (session: ConsoleSession, at: number): boolean => at - session.createdAtMs >= absoluteTtlMs || at - session.lastSeenAtMs >= idleTtlMs || at < session.createdAtMs;

  return Object.freeze({
    create(bearer: string, operatorId: string): ConsoleSession {
      const at = now();
      for (const [id, session] of sessions) if (expired(session, at)) sessions.delete(id);
      while (sessions.size >= maxSessions) {
        const oldest = sessions.keys().next().value;
        if (oldest === undefined) break;
        sessions.delete(oldest);
      }
      const session: ConsoleSession = { id: newToken(), bearer, csrfToken: newToken(), operatorId, createdAtMs: at, lastSeenAtMs: at, flash: undefined };
      sessions.set(session.id, session);
      return session;
    },
    get(id: string | undefined): ConsoleSession | undefined {
      if (id === undefined || !/^[A-Za-z0-9_-]{43}$/.test(id)) return undefined;
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
    size: () => sessions.size,
  });
}

/** Constant-time comparison of two tokens of any length (a length mismatch is simply unequal). */
export function tokensEqual(left: string | undefined, right: string | undefined): boolean {
  if (left === undefined || right === undefined) return false;
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

/** Takes (and clears) the session's one-shot confirmation line. */
export function takeFlash(session: ConsoleSession): string | undefined {
  const flash = session.flash;
  session.flash = undefined;
  return flash;
}

export function newFormToken(): string {
  return newToken();
}

/** A fresh idempotency key for one form instance. Re-submitting the same form reuses it — a retry is a replay, never a second write. */
export function newIdempotencyKey(): string {
  return `console-${randomBytes(16).toString('hex')}`;
}
