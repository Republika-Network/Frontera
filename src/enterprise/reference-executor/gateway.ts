import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';

import { REFERENCE_EXECUTOR_ADMISSION_LIMITS } from './admission.js';
import type { ReferenceExecutorConfiguration } from './configuration.js';
import { createReferenceExecutorVerificationPipeline, type ReferenceExecutorAssessment, type ReferenceExecutorAssessmentCode, type ReferenceExecutorStage } from './verification-pipeline.js';

/**
 * G-02C1A — the reference executor's **verification-only** HTTP/1.1 gateway.
 *
 * A loopback `node:http` server, in its own process (`launcher.ts`), that
 * parses each request with Node's strict parser, hands exactly what it parsed
 * to the verification pipeline, and answers with the assessment. It has no
 * effect handler, no ledger and no signer: it can refuse, or report that a
 * capability would be eligible, and nothing else.
 *
 * ## Every answer is a 4xx — nothing ever ran
 *
 * | Assessment | Status |
 * |---|---|
 * | refused at admission | 400 (413 body too large, 431 headers too large, 417 expectation) |
 * | refused at the credential | 401 |
 * | refused at presentation, policy, binding or verification; assessed ineligible | 403 |
 * | assessed eligible | 409 — verification only, not performed |
 *
 * The Host's Generic HTTP classifier reads every one of these as a definite
 * "not completed" (`PROVIDER_REJECTED`), which is the truth: no 2xx is ever
 * sent, so no answer can be read as success.
 *
 * ## Strict and bounded
 *
 * Node's strict parser (`insecureHTTPParser: false`) refuses malformed lines
 * and `Content-Length` with `Transfer-Encoding`; the
 * server counts every header line (`maxHeadersCount = 0`, so `rawHeaders` is
 * never silently truncated) and admission bounds them. Headers, body and total
 * processing time are bounded. One request per connection: a second request on
 * the same socket (pipelining, or a smuggled request), or a parse error after
 * the first, refuses **both** — the first is reported refused and never
 * answered — and closes the socket, so the log and the answer never disagree.
 * A reset or broken pipe is not reported. Upgrades, `CONNECT` and `Expect` are refused through their own server
 * events, never handed to a handler.
 *
 * Diagnostics are the assessment record only: never a header value, the
 * credential, the capability text or the body.
 */

export const REFERENCE_EXECUTOR_GATEWAY_LIMITS = Object.freeze({
  /** Node's per-request header byte bound (the presentation header included). */
  maximumHeaderBytes: 32 * 1024,
  /** Whole-request budget, from headers to answer. */
  processingTimeoutMs: 5_000,
});

export const REFERENCE_EXECUTOR_ASSESSMENT_FORMAT = 'frontera.reference-executor-assessment.v1';

export interface ReferenceExecutorGatewayOptions {
  readonly configuration: ReferenceExecutorConfiguration;
  readonly clock: () => number;
  /** Receives every assessment, refusals at the socket level included. Never a value from the request. */
  readonly onAssessment?: (assessment: ReferenceExecutorAssessment) => void;
}

export interface ReferenceExecutorGateway {
  readonly host: string;
  readonly port: number;
  close(): Promise<void>;
}

const STATUS_TEXT: Readonly<Record<number, string>> = Object.freeze({ 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 409: 'Conflict', 413: 'Payload Too Large', 417: 'Expectation Failed', 431: 'Request Header Fields Too Large' });

function refusal(stage: ReferenceExecutorStage, code: ReferenceExecutorAssessmentCode): ReferenceExecutorAssessment {
  return Object.freeze({ mode: 'verification-only' as const, outcome: 'refused' as const, stage, code, bindingDigest: null });
}

/** The status for an assessment. Never 2xx. */
export function referenceExecutorStatusOf(assessment: ReferenceExecutorAssessment): number {
  if (assessment.outcome === 'assessed-eligible') return 409;
  if (assessment.stage === 'admission') {
    if (assessment.code === 'BODY_TOO_LARGE') return 413;
    if (assessment.code === 'HEADER_COUNT_EXCEEDED' || assessment.code === 'HEADERS_TOO_LARGE') return 431;
    if (assessment.code === 'EXPECTATION_REFUSED') return 417;
    return 400;
  }
  if (assessment.stage === 'credential') return 401;
  return 403;
}

function respond(res: ServerResponse, assessment: ReferenceExecutorAssessment): void {
  if (res.headersSent || res.destroyed) return;
  const body = JSON.stringify({ format: REFERENCE_EXECUTOR_ASSESSMENT_FORMAT, ...assessment });
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'content-length': String(Buffer.byteLength(body, 'utf8')),
    'cache-control': 'no-store',
    connection: 'close',
    'frontera-executor-assessment': assessment.outcome,
  };
  if (assessment.bindingDigest !== null) headers['frontera-executor-binding-digest'] = assessment.bindingDigest;
  res.shouldKeepAlive = false;
  res.writeHead(referenceExecutorStatusOf(assessment), headers);
  res.end(body);
}

/** A bare refusal on a socket the HTTP layer will not hand to a handler. */
function refuseSocket(socket: Duplex, status: number): void {
  try {
    if (socket.writable) socket.end(`HTTP/1.1 ${String(status)} ${STATUS_TEXT[status] ?? 'Bad Request'}\r\nconnection: close\r\ncontent-length: 0\r\n\r\n`);
  } catch {
    // The peer is already gone; there is nothing left to refuse.
  }
  socket.destroy();
}

export async function startReferenceExecutorGateway(options: ReferenceExecutorGatewayOptions): Promise<ReferenceExecutorGateway> {
  const { configuration } = options;
  const pipeline = createReferenceExecutorVerificationPipeline(configuration, options.clock);
  const report = (assessment: ReferenceExecutorAssessment): void => {
    try {
      options.onAssessment?.(assessment);
    } catch {
      // A diagnostic sink never changes an answer.
    }
  };
  const L = REFERENCE_EXECUTOR_GATEWAY_LIMITS;
  const maximumBodyBytes = REFERENCE_EXECUTOR_ADMISSION_LIMITS.maximumBodyBytes;
  const served = new WeakSet<object>();
  /** The one request in flight on a socket, until it is answered: a socket-level refusal refuses it too, so its log and its answer can never disagree. */
  const inFlight = new WeakMap<object, (assessment: ReferenceExecutorAssessment) => void>();

  const finish = (res: ServerResponse, assessment: ReferenceExecutorAssessment): void => {
    report(assessment);
    respond(res, assessment);
  };

  function handle(req: IncomingMessage, res: ServerResponse): void {
    // One request per connection: the Host sends one and closes.
    if (served.has(req.socket)) {
      inFlight.get(req.socket)?.(refusal('admission', 'REQUEST_PIPELINED'));
      report(refusal('admission', 'REQUEST_PIPELINED'));
      req.socket.destroy();
      return;
    }
    served.add(req.socket);

    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      inFlight.delete(req.socket);
      report(refusal('admission', 'PROCESSING_TIMEOUT'));
      req.socket.destroy();
    }, L.processingTimeoutMs);
    const settle = (assessment: ReferenceExecutorAssessment): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      inFlight.delete(req.socket);
      finish(res, assessment);
    };
    // Refused from outside (a second request, a parse error on the socket): reported, never answered, never assessed.
    inFlight.set(req.socket, (assessment) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      inFlight.delete(req.socket);
      report(assessment);
    });

    const declared = req.headers['content-length'];
    if (typeof declared === 'string' && /^[0-9]+$/.test(declared) && Number(declared) > maximumBodyBytes) {
      settle(refusal('admission', 'BODY_TOO_LARGE'));
      req.socket.destroySoon();
      return;
    }

    const chunks: Buffer[] = [];
    let received = 0;
    req.on('data', (chunk: Buffer) => {
      if (settled) return;
      received += chunk.length;
      if (received > maximumBodyBytes) {
        settle(refusal('admission', 'BODY_TOO_LARGE'));
        req.socket.destroySoon();
        return;
      }
      chunks.push(chunk);
    });
    req.on('error', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      inFlight.delete(req.socket);
      req.socket.destroy();
    });
    req.on('end', () => {
      if (settled) return;
      settle(
        pipeline.assess({
          httpVersion: req.httpVersion,
          method: req.method ?? '',
          target: req.url ?? '',
          rawHeaders: req.rawHeaders,
          body: Buffer.concat(chunks),
        }),
      );
    });
  }

  const server: Server = createServer(
    {
      insecureHTTPParser: false,
      maxHeaderSize: L.maximumHeaderBytes,
      // Admission refuses a missing Host itself, so the refusal is reported like every other.
      requireHostHeader: false,
      joinDuplicateHeaders: false,
      // The gateway's own timer (above) answers first; Node's are the backstop.
      headersTimeout: L.processingTimeoutMs,
      requestTimeout: L.processingTimeoutMs + 1_000,
      keepAliveTimeout: 1,
      // Node enforces headersTimeout/requestTimeout only when it checks; check every second, not every 30 s.
      connectionsCheckingInterval: 1_000,
    },
    handle,
  );
  // Count every header line: Node otherwise stops at 2000 and drops the rest silently. Admission bounds the count.
  server.maxHeadersCount = 0;

  server.on('clientError', (error: Error, socket: Duplex) => {
    const code = String((error as NodeJS.ErrnoException).code ?? '');
    const malformed = code.startsWith('HPE_') || code === 'ERR_HTTP_REQUEST_TIMEOUT';
    const pending = inFlight.get(socket);
    if (pending !== undefined) {
      // Bytes after a request on its own connection: that request is refused too, and nothing more is written.
      pending(refusal('admission', 'REQUEST_PIPELINED'));
      if (malformed) report(refusal('admission', 'HTTP_MALFORMED'));
      socket.destroy();
      return;
    }
    // A reset or a broken pipe is not a request: nothing to assess, nothing to answer.
    if (!malformed) {
      socket.destroy();
      return;
    }
    const overflow = code === 'HPE_HEADER_OVERFLOW';
    report(refusal('admission', overflow ? 'HEADERS_TOO_LARGE' : 'HTTP_MALFORMED'));
    refuseSocket(socket, overflow ? 431 : 400);
  });
  server.on('upgrade', (_req: IncomingMessage, socket: Duplex) => {
    report(refusal('admission', 'UPGRADE_REFUSED'));
    refuseSocket(socket, 400);
  });
  server.on('connect', (_req: IncomingMessage, socket: Duplex) => {
    report(refusal('admission', 'METHOD_NOT_PERMITTED'));
    refuseSocket(socket, 400);
  });
  const refuseExpectation = (req: IncomingMessage, res: ServerResponse): void => {
    served.add(req.socket);
    finish(res, refusal('admission', 'EXPECTATION_REFUSED'));
    req.socket.destroySoon();
  };
  server.on('checkContinue', refuseExpectation);
  server.on('checkExpectation', refuseExpectation);

  const host = configuration.listen.host;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(configuration.listen.port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;

  return Object.freeze({
    host,
    port,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  });
}
