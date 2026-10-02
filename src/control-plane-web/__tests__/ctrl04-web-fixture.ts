import assert from 'node:assert/strict';

import { AUTH, bootCtrl04, call, createWorkspace, type BootedCtrl04, type Reply, type Workspace } from '../../enterprise/__tests__/ctrl04-host-fixture.js';
import { createControlPlaneWebServer, loadControlPlaneWebConfiguration, type ControlPlaneWebServer } from '../index.js';
import { Browser, freePort } from './web-browser.js';

/**
 * CTRL-04 — the web qualification harness: the shipped Host (CTRL-04 Host
 * fixture: real `bootEnterpriseHost()`, operators incl. approvers, two approval
 * profiles) and the shipped web control plane (`createControlPlaneWebServer()`,
 * what `npm run start:control-plane` runs), side by side over loopback HTTP.
 * Humans act only through `Browser` (HTML, forms, cookies); the agent acts only
 * through the Host's governed-action API; ground truth is the Host's own HTTP
 * API read with an observer credential.
 */

export const consoleLogLines: string[] = [];

export interface WebQualification {
  readonly workspace: Workspace;
  readonly host: BootedCtrl04;
  readonly console: ControlPlaneWebServer;
  readonly consoleOrigin: string;
  browser(name?: string): Browser;
  truth(path: string): Promise<Reply>;
  close(): Promise<void>;
}

export async function bootWebQualification(prefix = 'frontera-ctrl04-web-'): Promise<WebQualification> {
  const workspace = createWorkspace(prefix);
  const host = await bootCtrl04(workspace);
  const port = await freePort();
  const configuration = loadControlPlaneWebConfiguration({ FRONTERA_CONSOLE_HOST_URL: host.baseUrl, FRONTERA_CONSOLE_HTTP_HOST: '127.0.0.1', FRONTERA_CONSOLE_HTTP_PORT: String(port) });
  const console = createControlPlaneWebServer(configuration, { logger: { info: (message, fields) => consoleLogLines.push(JSON.stringify({ message, ...fields })) } });
  const bound = await console.listen();
  assert.equal(bound.port, port);
  return {
    workspace,
    host,
    console,
    consoleOrigin: configuration.publicOrigin,
    browser: (name = 'browser') => new Browser(configuration.publicOrigin, name),
    truth: (path: string) => call(host.baseUrl, 'GET', path, { authorization: AUTH.observer }),
    async close() {
      await console.close();
      await workspace.close();
    },
  };
}
