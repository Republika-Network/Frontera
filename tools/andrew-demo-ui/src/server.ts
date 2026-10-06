import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';

import { ActionRefused, type DemoController } from './controller.js';

/**
 * ANDREW-DEMO-UI-01 — the local demo server.
 *
 * - Binds to 127.0.0.1 only; there is no host option.
 * - Serves three fixed static files and a fixed set of API routes. There is
 *   no generic command, no path parameter, and no request body is accepted:
 *   every governed request the backend sends is the fixed Andrew composition's
 *   own, never something the browser composed.
 * - Rejects any request whose Host header is not this loopback origin (DNS
 *   rebinding), and any POST without the demo header or from another Origin
 *   (cross-site requests).
 * - Every API response is serialized, then passed through the secret guard;
 *   a hit withholds the response (fail closed) and marks the run as unable to
 *   PASS.
 */

export const DEMO_UI_HOST = '127.0.0.1';
export const DEMO_UI_DEFAULT_PORT = 4317;
export const DEMO_REQUEST_HEADER = 'x-frontera-demo';

/** The only files served: the page and stylesheet from `web/`, the compiled client from `dist/web/`. */
const STATIC: Readonly<Record<string, { readonly file: string; readonly compiled: boolean; readonly type: string }>> = {
  '/': { file: 'index.html', compiled: false, type: 'text/html; charset=utf-8' },
  '/app.js': { file: 'app.js', compiled: true, type: 'text/javascript; charset=utf-8' },
  '/styles.css': { file: 'styles.css', compiled: false, type: 'text/css; charset=utf-8' },
};

const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'cache-control': 'no-store',
  'cross-origin-resource-policy': 'same-origin',
};

type Action = (controller: DemoController) => Promise<unknown>;

const ACTIONS: Readonly<Record<string, Action>> = {
  '/api/preflight': (c) => c.preflight(),
  '/api/session': (c) => c.createSession(),
  '/api/scenario-a/request': (c) => c.request(),
  '/api/scenario-a/replay': (c) => c.replay(),
  '/api/scenario-a/approve': (c) => c.approve(),
  '/api/scenario-a/reconsider': (c) => c.reconsider(),
  // Returns once the held execution is released; the browser follows the real lifecycle by polling.
  '/api/scenario-a/execute': (c) => c.execute(),
  '/api/scenario-a/abandon': (c) => c.abandon(),
  '/api/scenario-a/verify-evidence': (c) => c.verifyEvidence(),
  '/api/scenario-a/reconsider-again': (c) => c.reconsiderAgain(),
  '/api/scenario-a/historical': (c) => c.historical(),
  '/api/scenario-b/run': (c) => c.scenarioB(),
};

export interface DemoServer {
  readonly server: Server;
  readonly port: number;
  readonly url: string;
  close(): Promise<void>;
}

/** `dist/server.js` → `web/` (page, stylesheet) and `dist/web/` (compiled client). */
const WEB_SOURCE = join(__dirname, '..', 'web');
const WEB_COMPILED = join(__dirname, 'web');

export async function startDemoServer(controller: DemoController, options: { readonly port?: number } = {}): Promise<DemoServer> {
  const guard = controller.secretGuard();
  let port = 0;

  const send = (response: ServerResponse, status: number, type: string, body: string, extra: Readonly<Record<string, string>> = {}): void => {
    response.writeHead(status, { ...SECURITY_HEADERS, 'content-type': type, ...extra });
    response.end(body);
  };
  /** Serialize, then refuse to send anything the secret guard rejects. */
  const sendJson = (response: ServerResponse, status: number, value: unknown): void => {
    const text = JSON.stringify(value);
    try {
      guard.check(text);
    } catch {
      controller.noteGuardTripped();
      send(response, 500, 'application/json; charset=utf-8', JSON.stringify({ error: 'RESPONSE_WITHHELD', message: 'The response matched secret material and was withheld. This run cannot PASS.' }));
      return;
    }
    send(response, status, 'application/json; charset=utf-8', text);
  };
  const sendGuardedText = (response: ServerResponse, type: string, text: string, extra: Readonly<Record<string, string>> = {}): void => {
    try {
      guard.check(text);
    } catch {
      controller.noteGuardTripped();
      sendJson(response, 500, { error: 'RESPONSE_WITHHELD' });
      return;
    }
    send(response, 200, type, text, extra);
  };

  const loopbackOrigins = (): readonly string[] => [`127.0.0.1:${port}`, `localhost:${port}`];

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const host = request.headers.host ?? '';
    if (!loopbackOrigins().includes(host)) {
      sendJson(response, 421, { error: 'HOST_REFUSED', message: 'This demo answers only on its loopback address.' });
      return;
    }
    const url = new URL(request.url ?? '/', `http://${host}`);
    const path = url.pathname;
    const method = request.method ?? 'GET';

    if (method === 'GET') {
      const asset = STATIC[path];
      if (asset !== undefined) {
        try {
          send(response, 200, asset.type, readFileSync(join(asset.compiled ? WEB_COMPILED : WEB_SOURCE, asset.file), 'utf8'));
        } catch {
          sendJson(response, 500, { error: 'ASSET_MISSING', message: 'Run the build first.' });
        }
        return;
      }
      const state = () => controller.state();
      switch (path) {
        case '/api/status':
          sendJson(response, 200, state());
          return;
        case '/api/scenario-a':
          sendJson(response, 200, { mode: state().mode, scenarioA: state().scenarioA, allowed: state().allowed });
          return;
        case '/api/scenario-b':
          sendJson(response, 200, { mode: state().mode, scenarioB: state().scenarioB, allowed: state().allowed });
          return;
        case '/api/evidence': {
          const s = state();
          sendJson(response, 200, { mode: s.mode, session: s.session, scenarioA: s.scenarioA, scenarioB: s.scenarioB, verdict: s.verdict, checkpoints: s.checkpoints });
          return;
        }
        case '/api/summary': {
          const summary = controller.summaryText();
          if (summary === undefined) sendJson(response, 404, { error: 'NO_SUMMARY', message: 'The run has not finished; no summary was written yet.' });
          else sendGuardedText(response, 'application/json; charset=utf-8', summary);
          return;
        }
        case '/api/report': {
          const report = controller.reportText();
          if (report === undefined) sendJson(response, 404, { error: 'NO_REPORT', message: 'The run has not finished; no report was written yet.' });
          else sendGuardedText(response, 'text/markdown; charset=utf-8', report.text, url.searchParams.get('download') === '1' ? { 'content-disposition': `attachment; filename="${report.name}"` } : {});
          return;
        }
        default:
          sendJson(response, 404, { error: 'NOT_FOUND' });
          return;
      }
    }

    if (method === 'POST') {
      const action = ACTIONS[path];
      if (action === undefined) {
        sendJson(response, 404, { error: 'NOT_FOUND' });
        return;
      }
      if (request.headers[DEMO_REQUEST_HEADER] !== '1') {
        sendJson(response, 403, { error: 'FORBIDDEN', message: 'Missing demo request header.' });
        return;
      }
      const origin = request.headers.origin;
      if (origin !== undefined && !loopbackOrigins().map((o) => `http://${o}`).includes(origin)) {
        sendJson(response, 403, { error: 'FORBIDDEN', message: 'Cross-origin request refused.' });
        return;
      }
      const length = Number(request.headers['content-length'] ?? '0');
      if (request.headers['transfer-encoding'] !== undefined || (Number.isFinite(length) && length > 0)) {
        request.resume();
        sendJson(response, 400, { error: 'BODY_REFUSED', message: 'Demo actions take no input; the backend owns the fixed Andrew demo composition.' });
        return;
      }
      try {
        await action(controller);
        sendJson(response, 200, controller.state());
      } catch (error) {
        if (error instanceof ActionRefused) sendJson(response, 409, { error: 'ACTION_NOT_ALLOWED', action: error.action, message: error.message, state: controller.state() });
        else sendJson(response, 500, { error: 'ACTION_FAILED', message: 'The action failed; see the run state.', state: controller.state() });
      }
      return;
    }

    sendJson(response, 405, { error: 'METHOD_NOT_ALLOWED' });
  };

  const server = createServer((request, response) => {
    handle(request, response).catch(() => {
      if (!response.headersSent) sendJson(response, 500, { error: 'INTERNAL' });
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? DEMO_UI_DEFAULT_PORT, DEMO_UI_HOST, () => resolve());
  });
  port = (server.address() as AddressInfo).port;
  return {
    server,
    port,
    url: `http://${DEMO_UI_HOST}:${port}/`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
