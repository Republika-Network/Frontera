import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { MAX_STATUS_REQUEST_BYTES, type StatusHttpRequest, type StatusHttpResponse } from '../conformance/status-http.js';

/**
 * RN-CONFORM-03 / WP-08 — the LOCAL, TEST-ONLY listener for the status binding.
 *
 * Disabled by default: `startLocalStatusServer` refuses to start unless the
 * caller passes the exact enablement literal below, and it binds only to a
 * loopback address (127.0.0.1 or ::1 — never `0.0.0.0`, `::`, a hostname or a
 * routable address). Requests whose `Host` header is not that loopback address
 * are refused (DNS-rebinding). Nothing imports this module except its test: no
 * Enterprise Host, composition root, CLI, package export, environment variable
 * or deployment configuration can start it. It is outside the frozen v1 API
 * surface by construction.
 */

export const LOCAL_STATUS_SERVER_ENABLEMENT = 'rn-conform-03-local-synthetic-test-only' as const;
const LOOPBACK = new Set(['127.0.0.1', '::1']);
const HEADER_TIMEOUT_MS = 5_000;
const REQUEST_TIMEOUT_MS = 10_000;

export class LocalStatusServerError extends Error {
  readonly code: 'NOT_ENABLED' | 'NOT_LOOPBACK' | 'BIND_FAILED';
  constructor(code: LocalStatusServerError['code'], detail = '') {
    super(`Local status server refused: ${code}${detail === '' ? '' : ` (${detail})`}`);
    this.name = 'LocalStatusServerError';
    this.code = code;
  }
}

export interface LocalStatusServer {
  readonly host: string;
  readonly port: number;
  close(): Promise<void>;
}

function hostAllowed(header: string | undefined, host: string, port: number): boolean {
  if (header === undefined) return false;
  const expected = host === '::1' ? `[::1]:${port}` : `${host}:${port}`;
  return header === expected;
}

export async function startLocalStatusServer(options: {
  readonly enable?: string;
  readonly host?: string;
  readonly port?: number;
  readonly handle: (request: StatusHttpRequest) => StatusHttpResponse;
}): Promise<LocalStatusServer> {
  if (options.enable !== LOCAL_STATUS_SERVER_ENABLEMENT) throw new LocalStatusServerError('NOT_ENABLED');
  const host = options.host ?? '127.0.0.1';
  if (!LOOPBACK.has(host)) throw new LocalStatusServerError('NOT_LOOPBACK', host);
  const port = options.port ?? 0;
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new LocalStatusServerError('BIND_FAILED', 'port');

  let boundPort = 0;
  const server: Server = createServer({ maxHeaderSize: 8 * 1024 }, (req: IncomingMessage, res: ServerResponse) => {
    const send = (r: StatusHttpResponse) => {
      res.writeHead(r.status, { ...r.headers, 'content-length': String(Buffer.byteLength(r.body, 'utf8')) });
      res.end(r.body);
    };
    const refuse = (status: number, code: string) => send({ status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }, body: JSON.stringify({ error: code, signed: false }) });
    const peer = req.socket.remoteAddress ?? '';
    if (!(peer === '127.0.0.1' || peer === '::1' || peer === '::ffff:127.0.0.1')) return refuse(403, 'NOT_LOOPBACK');
    if (!hostAllowed(req.headers.host, host, boundPort)) return refuse(421, 'MISDIRECTED_REQUEST');
    const chunks: Buffer[] = [];
    let size = 0;
    let aborted = false;
    req.on('data', (chunk: Buffer) => {
      if (aborted) return;
      size += chunk.length;
      if (size > MAX_STATUS_REQUEST_BYTES) {
        aborted = true;
        refuse(413, 'REQUEST_TOO_LARGE');
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (aborted) return;
      const body = chunks.length === 0 ? null : Buffer.concat(chunks).toString('utf8');
      const contentType = typeof req.headers['content-type'] === 'string' ? req.headers['content-type'] : null;
      send(options.handle({ method: req.method ?? '', url: req.url ?? '', contentType, body, clientKey: peer }));
    });
  });
  server.headersTimeout = HEADER_TIMEOUT_MS;
  server.requestTimeout = REQUEST_TIMEOUT_MS;

  await new Promise<void>((settle, reject) => {
    server.once('error', (e) => reject(new LocalStatusServerError('BIND_FAILED', e instanceof Error ? e.message : 'error')));
    server.listen({ host, port, exclusive: true }, () => settle());
  });
  const address = server.address() as AddressInfo | null;
  if (address === null || typeof address === 'string' || !LOOPBACK.has(address.address)) {
    await new Promise<void>((settle) => server.close(() => settle()));
    throw new LocalStatusServerError('NOT_LOOPBACK', 'bound address');
  }
  boundPort = address.port;
  return Object.freeze({
    host,
    port: boundPort,
    close: () =>
      new Promise<void>((settle) => {
        server.close(() => settle());
        // Idle keep-alive and in-flight sockets are ended so close completes deterministically.
        server.closeAllConnections();
      }),
  });
}
