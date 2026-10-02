import type { IncomingMessage } from 'node:http';

/**
 * CTRL-03 — browser-facing security controls of the web control plane.
 *
 * The console ships **no client-side script**: every page is server-rendered
 * HTML and every operation an HTML form. The Content-Security-Policy below
 * therefore allows no script at all, so an injected `<script>` (or event
 * handler) does not run. Framing is refused, nothing is cached, no referrer
 * leaves for another origin, and no cross-origin reader is allowed.
 */

/**
 * Cookie names. On an HTTPS origin they carry the `__Host-` prefix, which a
 * browser accepts only with `Secure`, `Path=/` and no `Domain` — so no sibling
 * host can plant or overwrite them. On loopback HTTP (no `Secure` possible)
 * they are unprefixed.
 */
export const SESSION_COOKIE = 'frontera_console_session';
export const LOGIN_COOKIE = 'frontera_console_login';

export function cookieNames(secure: boolean): { readonly session: string; readonly login: string } {
  return secure ? { session: `__Host-${SESSION_COOKIE}`, login: `__Host-${LOGIN_COOKIE}` } : { session: SESSION_COOKIE, login: LOGIN_COOKIE };
}

/**
 * `same-origin`, deliberately — not `no-referrer`. Under the Fetch standard a
 * browser sends `Origin: null` on a form POST from a `no-referrer` document,
 * which would make every same-origin form indistinguishable from a forged one.
 * `same-origin` sends the true `Origin` (and `Referer`) to the console itself
 * and nothing to any other origin.
 */
export const REFERRER_POLICY = 'same-origin';

export const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "style-src 'self'",
  "img-src 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
].join('; ');

export function securityHeaders(secure: boolean): Readonly<Record<string, string>> {
  return {
    'content-security-policy': CONTENT_SECURITY_POLICY,
    'x-frame-options': 'DENY',
    'x-content-type-options': 'nosniff',
    'referrer-policy': REFERRER_POLICY,
    ...(secure ? { 'strict-transport-security': 'max-age=31536000' } : {}),
    'cache-control': 'no-store',
    pragma: 'no-cache',
    'cross-origin-opener-policy': 'same-origin',
    'cross-origin-resource-policy': 'same-origin',
    'permissions-policy': 'camera=(), microphone=(), geolocation=(), clipboard-read=(), clipboard-write=()',
  };
}

export interface CookieOptions {
  readonly secure: boolean;
  readonly maxAgeSeconds?: number;
}

/** `HttpOnly; SameSite=Strict; Path=/`, and `Secure` whenever the console's public origin is HTTPS. */
export function setCookie(name: string, value: string, options: CookieOptions): string {
  return [
    `${name}=${value}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    ...(options.secure ? ['Secure'] : []),
    ...(options.maxAgeSeconds !== undefined ? [`Max-Age=${options.maxAgeSeconds}`] : []),
  ].join('; ');
}

export function clearCookie(name: string, options: CookieOptions): string {
  return setCookie(name, '', { ...options, maxAgeSeconds: 0 });
}

export function readCookie(req: IncomingMessage, name: string): string | undefined {
  const header = req.headers.cookie;
  if (typeof header !== 'string') return undefined;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    if (part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return undefined;
}

/**
 * A state-changing request must come from the console's own origin: the
 * `Origin` header (or, when a browser omits it, the `Referer`'s origin) must be
 * exactly the configured public origin. A request with neither — or with
 * `Origin: null` — is refused. This is in addition to the per-session CSRF
 * token and `SameSite=Strict`.
 */
export function sameOrigin(req: IncomingMessage, publicOrigin: string): boolean {
  const origin = req.headers.origin;
  if (typeof origin === 'string') return origin === publicOrigin;
  const referer = req.headers.referer;
  if (typeof referer !== 'string') return false;
  try {
    return new URL(referer).origin === publicOrigin;
  } catch {
    return false;
  }
}

export const FORM_MAX_BYTES = 64 * 1024;

/** Reads an `application/x-www-form-urlencoded` body (bounded). Repeated keys keep every value, in order. */
export function readForm(req: IncomingMessage, maxBytes: number = FORM_MAX_BYTES): Promise<FormFields> {
  return new Promise((resolvePromise, rejectPromise) => {
    const contentType = req.headers['content-type'];
    if (typeof contentType !== 'string' || !/^application\/x-www-form-urlencoded\s*(?:;.*)?$/i.test(contentType)) {
      rejectPromise(new ConsoleRequestError(415, 'Forms must be submitted as application/x-www-form-urlencoded.'));
      req.resume();
      return;
    }
    const chunks: Buffer[] = [];
    let total = 0;
    let failed = false;
    req.on('data', (chunk: Buffer) => {
      if (failed) return;
      total += chunk.length;
      if (total > maxBytes) {
        failed = true;
        rejectPromise(new ConsoleRequestError(413, 'The form is too large.'));
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (failed) return;
      resolvePromise(new FormFields(new URLSearchParams(Buffer.concat(chunks).toString('utf8'))));
    });
    req.on('error', (error) => rejectPromise(error));
  });
}

export class FormFields {
  constructor(private readonly params: URLSearchParams) {}

  /** The single value of a field, trimmed; `''` when absent. */
  text(name: string): string {
    return (this.params.get(name) ?? '').trim();
  }

  /** The raw single value, untrimmed (a credential is compared exactly as typed). */
  raw(name: string): string {
    return this.params.get(name) ?? '';
  }

  all(name: string): readonly string[] {
    return this.params.getAll(name);
  }

  has(name: string): boolean {
    return this.params.has(name);
  }

  names(): readonly string[] {
    return [...new Set(this.params.keys())];
  }
}

export class ConsoleRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ConsoleRequestError';
  }
}
