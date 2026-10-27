import { readFileSync } from 'node:fs';
import { createServer, request, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, join, normalize, resolve, sep } from 'node:path';

import { API_PREFIX, AuthorityApiError, CSRF_HEADER, type Transport } from '../api.js';

/**
 * AUTH-04C test fixture — the Authority origin, in miniature, on loopback.
 *
 * It reproduces the topology the future ingress must provide for
 * `https://authority.frontera-systems.com`, and nothing more:
 * - `/authority/v1/*` is forwarded to the Host's Authority gateway listener,
 *   preserving `Host`, `Origin`, `Cookie`, the CSRF header and `Set-Cookie`;
 * - everything else is the static client from `apps/authority-web/dist`, served
 *   with `security-headers.json`.
 * One origin, so the gateway's `__Host-` SameSite=Strict cookies, its Origin
 * and Host checks and WebAuthn's RP ID all hold without CORS. Test-only: never
 * shipped, never a service.
 */

const TYPES: Readonly<Record<string, string>> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8' };

export interface AuthorityOrigin {
  readonly port: number;
  close(): Promise<void>;
}

export async function startAuthorityOrigin(options: { readonly distDir: string; readonly gatewayPort: number }): Promise<AuthorityOrigin> {
  const distDir = resolve(options.distDir);
  const headers = Object.fromEntries(Object.entries(JSON.parse(readFileSync(join(distDir, 'security-headers.json'), 'utf8')) as Record<string, string>).filter(([name]) => name !== '//'));

  const forward = (req: IncomingMessage, res: ServerResponse): void => {
    const upstream = request({ host: '127.0.0.1', port: options.gatewayPort, method: req.method, path: req.url, headers: req.headers }, (answer) => {
      res.writeHead(answer.statusCode ?? 502, answer.headers);
      answer.pipe(res);
    });
    upstream.on('error', () => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'AUTHORITY_UNAVAILABLE', message: 'The gateway is unreachable.' } }));
    });
    req.pipe(upstream);
  };

  const serveStatic = (req: IncomingMessage, res: ServerResponse): void => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, headers);
      res.end();
      return;
    }
    const path = new URL(req.url ?? '/', 'https://authority.invalid').pathname;
    const relativePath = path === '/' ? 'index.html' : normalize(decodeURIComponent(path)).replace(/^[/\\]+/, '');
    const file = resolve(distDir, relativePath);
    if (!file.startsWith(distDir + sep) || relativePath === 'security-headers.json') {
      res.writeHead(404, headers);
      res.end();
      return;
    }
    let body: Buffer;
    try {
      body = readFileSync(file);
    } catch {
      res.writeHead(404, headers);
      res.end();
      return;
    }
    res.writeHead(200, { ...headers, 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
    res.end(req.method === 'HEAD' ? undefined : body);
  };

  const server: Server = createServer((req, res) => {
    if ((req.url ?? '').startsWith(`${API_PREFIX}/`)) forward(req, res);
    else serveStatic(req, res);
  });
  await new Promise<void>((resolvePromise) => server.listen(0, '127.0.0.1', () => resolvePromise()));
  const { port } = server.address() as AddressInfo;
  return {
    port,
    close: () =>
      new Promise<void>((resolvePromise) => {
        server.closeAllConnections();
        server.close(() => resolvePromise());
      }),
  };
}

/**
 * The browser, as far as the client's transport is concerned: same-origin
 * requests to the Authority origin with its `Host`, an `Origin` on every POST
 * (as Safari sends for same-origin fetch), and a cookie jar that keeps exactly
 * what the server set. The client code itself is unchanged.
 */
export interface BrowserSession {
  readonly transport: Transport;
  readonly jar: Map<string, string>;
  /** Raw GET of a static path, with response headers (for the shell checks). */
  get(path: string): Promise<{ readonly status: number; readonly headers: Readonly<Record<string, string | string[] | undefined>>; readonly text: string }>;
  /** Drops the next response to a matching request after the server handled it (a lost response). */
  loseNextResponse(match: (method: string, path: string) => boolean): void;
}

export function browserSession(port: number, authorityHost: string): BrowserSession {
  const jar = new Map<string, string>();
  const origin = `https://${authorityHost}`;
  let lose: ((method: string, path: string) => boolean) | undefined;
  const exchange = (method: string, path: string, payload: string | undefined, extra: Record<string, string>): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; text: string }> =>
    new Promise((resolvePromise, rejectPromise) => {
      const req = request(
        {
          host: '127.0.0.1',
          port,
          method,
          path,
          headers: {
            host: authorityHost,
            ...(jar.size > 0 ? { cookie: [...jar].map(([name, value]) => `${name}=${value}`).join('; ') } : {}),
            ...extra,
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => {
            for (const header of res.headers['set-cookie'] ?? []) {
              const pair = header.split(';')[0] ?? '';
              const index = pair.indexOf('=');
              const name = pair.slice(0, index);
              const value = pair.slice(index + 1);
              if (/Max-Age=0/.test(header) || value === '') jar.delete(name);
              else jar.set(name, value);
            }
            resolvePromise({ status: res.statusCode ?? 0, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') });
          });
        },
      );
      req.on('error', rejectPromise);
      if (payload !== undefined) req.write(payload);
      req.end();
    });

  const transport: Transport = async (method, path, body, csrfToken) => {
    const payload = method === 'POST' ? JSON.stringify(body ?? {}) : undefined;
    const reply = await exchange(method, path, payload, {
      accept: 'application/json',
      ...(method === 'POST' ? { origin, 'content-type': 'application/json' } : {}),
      ...(csrfToken !== undefined ? { [CSRF_HEADER]: csrfToken } : {}),
    });
    if (lose !== undefined && lose(method, path)) {
      lose = undefined;
      // The server processed the request; the response never reaches the page — exactly what fetchTransport reports for a failed fetch.
      throw new AuthorityApiError(0, 'NETWORK_UNAVAILABLE', 'The Authority service could not be reached.');
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(reply.text);
    } catch {
      parsed = undefined;
    }
    return { status: reply.status, body: parsed };
  };

  return {
    transport,
    jar,
    get: (path) => exchange('GET', path, undefined, {}),
    loseNextResponse(match) {
      lose = match;
    },
  };
}
