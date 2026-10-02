import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { createConsoleApp, type ConsoleLogger } from './app.js';
import { createHostClient } from './host-client.js';
import { securityHeaders } from './security.js';
import { createSessionStore, type SessionStoreOptions } from './session.js';

/**
 * CTRL-03 — the Frontera web control plane as a process: a same-origin,
 * server-rendered console in front of a Frontera Host's operator plane.
 *
 * Configuration (environment):
 *
 * | Variable | Meaning |
 * |---|---|
 * | `FRONTERA_CONSOLE_HOST_URL` | The Host's base URL. `https://` required unless it is loopback. Required. |
 * | `FRONTERA_CONSOLE_HTTP_HOST` | Bind address. Default `127.0.0.1`. |
 * | `FRONTERA_CONSOLE_HTTP_PORT` | Bind port. Default `8787`. |
 * | `FRONTERA_CONSOLE_PUBLIC_ORIGIN` | The exact origin browsers use. Default `http://127.0.0.1:<port>`; required — and `https://` — when the bind address is not loopback (TLS is terminated in front of the console). |
 * | `FRONTERA_CONSOLE_SESSION_IDLE_SECONDS` | Idle timeout. Default 1800. |
 * | `FRONTERA_CONSOLE_SESSION_MAX_SECONDS` | Absolute session lifetime, at most 43200. Default 28800. |
 *
 * The console holds no database, no store, no key and no Host internals: it
 * reaches the Host over HTTP only, with the signed-in operator's credential.
 */

export interface ControlPlaneWebConfiguration {
  readonly hostUrl: string;
  readonly bindHost: string;
  readonly port: number;
  readonly publicOrigin: string;
  readonly session: Pick<SessionStoreOptions, 'idleTtlMs' | 'absoluteTtlMs'>;
}

export class ControlPlaneWebConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ControlPlaneWebConfigurationError';
  }
}

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

function isLoopbackHostname(hostname: string): boolean {
  const bare = hostname.replace(/^\[|\]$/g, '');
  return LOOPBACK.has(bare) || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(bare);
}

function seconds(env: Readonly<Record<string, string | undefined>>, name: string, fallback: number, max: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  if (!/^[1-9][0-9]{0,6}$/.test(raw) || Number(raw) > max) throw new ControlPlaneWebConfigurationError(`${name} must be a whole number of seconds from 1 to ${max}.`);
  return Number(raw);
}

/** Strict: a value the console cannot use safely refuses the start. */
export function loadControlPlaneWebConfiguration(env: Readonly<Record<string, string | undefined>>): ControlPlaneWebConfiguration {
  const hostUrlRaw = env['FRONTERA_CONSOLE_HOST_URL'];
  if (hostUrlRaw === undefined || hostUrlRaw === '') throw new ControlPlaneWebConfigurationError('FRONTERA_CONSOLE_HOST_URL is required: the Frontera Host the console operates.');
  let hostUrl: URL;
  try {
    hostUrl = new URL(hostUrlRaw);
  } catch {
    throw new ControlPlaneWebConfigurationError('FRONTERA_CONSOLE_HOST_URL is not a URL.');
  }
  if (hostUrl.username !== '' || hostUrl.password !== '' || hostUrl.search !== '' || hostUrl.hash !== '' || (hostUrl.pathname !== '/' && hostUrl.pathname !== '')) {
    throw new ControlPlaneWebConfigurationError('FRONTERA_CONSOLE_HOST_URL must be scheme://host[:port] only — no credentials, path, query or fragment.');
  }
  if (hostUrl.protocol !== 'https:' && !(hostUrl.protocol === 'http:' && isLoopbackHostname(hostUrl.hostname))) {
    throw new ControlPlaneWebConfigurationError('FRONTERA_CONSOLE_HOST_URL must use https:// unless the Host is on loopback: operator credentials cross this connection.');
  }
  const bindHost = env['FRONTERA_CONSOLE_HTTP_HOST'] ?? '127.0.0.1';
  const portRaw = env['FRONTERA_CONSOLE_HTTP_PORT'] ?? '8787';
  if (!/^[0-9]{1,5}$/.test(portRaw) || Number(portRaw) > 65535) throw new ControlPlaneWebConfigurationError('FRONTERA_CONSOLE_HTTP_PORT must be a port number (0-65535).');
  const port = Number(portRaw);
  const loopbackBind = isLoopbackHostname(bindHost);
  const originRaw = env['FRONTERA_CONSOLE_PUBLIC_ORIGIN'];
  let publicOrigin: string;
  if (originRaw === undefined || originRaw === '') {
    if (!loopbackBind) throw new ControlPlaneWebConfigurationError('FRONTERA_CONSOLE_PUBLIC_ORIGIN is required when the console binds a non-loopback address.');
    publicOrigin = `http://${bindHost.includes(':') ? `[${bindHost}]` : bindHost}:${port}`;
  } else {
    let origin: URL;
    try {
      origin = new URL(originRaw);
    } catch {
      throw new ControlPlaneWebConfigurationError('FRONTERA_CONSOLE_PUBLIC_ORIGIN is not a URL.');
    }
    if (origin.origin !== originRaw) throw new ControlPlaneWebConfigurationError('FRONTERA_CONSOLE_PUBLIC_ORIGIN must be an exact origin: scheme://host[:port], nothing else.');
    if (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && isLoopbackHostname(origin.hostname) && loopbackBind)) {
      throw new ControlPlaneWebConfigurationError('FRONTERA_CONSOLE_PUBLIC_ORIGIN must be https:// unless the console is used on loopback only.');
    }
    publicOrigin = origin.origin;
  }
  const absolute = seconds(env, 'FRONTERA_CONSOLE_SESSION_MAX_SECONDS', 8 * 3600, 12 * 3600);
  const idle = seconds(env, 'FRONTERA_CONSOLE_SESSION_IDLE_SECONDS', 30 * 60, absolute);
  return { hostUrl: hostUrl.origin, bindHost, port, publicOrigin, session: { absoluteTtlMs: absolute * 1000, idleTtlMs: idle * 1000 } };
}

export interface ControlPlaneWebServer {
  readonly server: Server;
  listen(): Promise<{ readonly port: number; readonly host: string }>;
  close(): Promise<void>;
}

export interface ControlPlaneWebServerOptions {
  readonly logger?: ConsoleLogger;
  readonly now?: () => number;
}

/** Request attribution without content: method, a route shape with identifiers removed, status. Never a body, a header, a cookie or a query. */
function routeShape(url: string | undefined): string {
  const path = (url ?? '/').split('?')[0] ?? '/';
  const parts = path.split('/').filter((part) => part.length > 0);
  const keep = new Set(['agents', 'credentials', 'rotate', 'revoke', 'authority', 'entities', 'new', 'grants', 'executions', 'emergency', 'activate', 'release', 'profiles', 'retire', 'activity', 'evidence', 'decisions', 'login', 'logout', 'assets']);
  return `/${parts.map((part) => (keep.has(part) ? part : ':id')).join('/')}`;
}

export function createControlPlaneWebServer(configuration: ControlPlaneWebConfiguration, options: ControlPlaneWebServerOptions = {}): ControlPlaneWebServer {
  const logger = options.logger;
  const sessions = createSessionStore({ ...configuration.session, ...(options.now !== undefined ? { now: options.now } : {}) });
  const app = createConsoleApp({ host: createHostClient({ baseUrl: configuration.hostUrl }), sessions, publicOrigin: configuration.publicOrigin, ...(logger !== undefined ? { logger } : {}) });
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    app
      .handle(req)
      .then((response) => {
        const headers: Record<string, string | string[]> = { ...securityHeaders() };
        if (response.contentType !== undefined) headers['content-type'] = response.contentType;
        if (response.location !== undefined) headers['location'] = response.location;
        if (response.cookies !== undefined && response.cookies.length > 0) headers['set-cookie'] = [...response.cookies];
        const body = response.body ?? '';
        headers['content-length'] = String(Buffer.byteLength(body));
        res.writeHead(response.status, headers);
        res.end(body);
        logger?.info('console.request', { method: req.method ?? 'GET', route: routeShape(req.url), status: response.status });
      })
      .catch(() => {
        res.writeHead(500, { ...securityHeaders(), 'content-type': 'text/plain; charset=utf-8' });
        res.end('The console failed to handle this request.');
        logger?.info('console.request', { method: req.method ?? 'GET', route: routeShape(req.url), status: 500 });
      });
  });
  let closing: Promise<void> | undefined;
  return {
    server,
    listen() {
      return new Promise((resolvePromise, rejectPromise) => {
        const onError = (error: Error): void => rejectPromise(error);
        server.once('error', onError);
        server.listen(configuration.port, configuration.bindHost, () => {
          server.off('error', onError);
          const address = server.address() as AddressInfo;
          resolvePromise({ port: address.port, host: configuration.bindHost });
        });
      });
    },
    close() {
      closing ??= new Promise<void>((resolvePromise) => {
        if (!server.listening) {
          resolvePromise();
          return;
        }
        server.close(() => resolvePromise());
        server.closeIdleConnections();
      });
      return closing;
    },
  };
}
