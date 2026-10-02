import assert from 'node:assert/strict';

import {
  AUTH,
  bootCtrl02,
  call,
  createWorkspace,
  ctrl02Env,
  ctrl02File,
  logLines,
  SECRETS,
  type Booted,
  type Reply,
  type Workspace,
} from '../../enterprise/__tests__/ctrl02-host-fixture.js';
import { createControlPlaneWebServer, loadControlPlaneWebConfiguration, type ControlPlaneWebServer } from '../index.js';
import { Browser, freePort } from './web-browser.js';

/**
 * CTRL-03 — the qualification harness: the shipped Host and the shipped web
 * control plane, side by side, over loopback HTTP.
 *
 * - The Host boots through `bootEnterpriseHost()` (the CTRL-02 harness: secure
 *   profile, SQLite stores in a fresh directory, Ed25519 authority signing,
 *   external freshness witness, operators configured, **no** static customer
 *   principal). Nothing is seeded after boot.
 * - The console boots through `createControlPlaneWebServer()` — what
 *   `npm run start:control-plane` runs — from a plain environment naming the
 *   Host's URL.
 * - Operators act only through `Browser` (HTML, forms, cookies). Ground truth is
 *   read back from the Host's own HTTP API with an observer credential.
 *
 * The governance world is the qualified non-monetary deploy domain: dimension
 * `replicaCount` (integer, maximum) and `deploymentStrategy` (token, exact),
 * one `deploy-production` profile in the operator-promoted catalog (a draft
 * until a profile steward activates it).
 */

export const DEPLOY = 'deploy-release';
export const CLUSTER = 'production-cluster';
export const TRUST_DOMAIN = 'trust-domain-pilot';
export const ISSUER = 'actor-pilot-org';
export const OWNER = 'actor-release-owner';
export const AGENT = 'actor-release-agent';
export const AGENT_SUBJECT = { system: 'pilot-ci', subjectId: 'release-agent-7' } as const;

export const GOVERNANCE = {
  parameterDimensions: [
    { id: 'replicaCount', type: 'integer', bound: 'maximum' },
    { id: 'deploymentStrategy', type: 'token', bound: 'exact' },
  ],
  actionClasses: [{ id: 'deploy', actions: [DEPLOY] }],
  resourceClasses: [{ id: 'production', resources: [CLUSTER] }],
  profiles: [
    {
      profileId: 'deploy-production',
      version: 1,
      owner: 'org-pilot',
      provenance: { authoredBy: 'platform-team', approvedBy: 'change-board' },
      actionClass: 'deploy',
      resourceClass: 'production',
      parameters: [
        { dimension: 'replicaCount', required: true },
        { dimension: 'deploymentStrategy', required: true },
      ],
      materialFacts: [],
      relevantPolicies: [],
    },
  ],
};

export function ctrl03File(): Record<string, unknown> {
  return ctrl02File({ monetary: undefined, governance: GOVERNANCE, profileLifecycle: 'operator-promoted', routes: [{ action: DEPLOY, adapterId: 'pilot.recording' }] });
}

export const consoleLogLines: string[] = [];

export interface Qualification {
  readonly workspace: Workspace;
  readonly host: Booted;
  readonly console: ControlPlaneWebServer;
  readonly consoleOrigin: string;
  browser(name?: string): Browser;
  /** Ground truth: the Host's own operator API, read with an observer credential. */
  truth(path: string): Promise<Reply>;
  close(): Promise<void>;
}

export async function bootQualification(prefix = 'frontera-ctrl03-'): Promise<Qualification> {
  const workspace = createWorkspace(prefix);
  const host = await bootCtrl02(workspace, ctrl02Env(workspace.dir(), ctrl03File()));
  const port = await freePort();
  const configuration = loadControlPlaneWebConfiguration({ FRONTERA_CONSOLE_HOST_URL: host.baseUrl, FRONTERA_CONSOLE_HTTP_HOST: '127.0.0.1', FRONTERA_CONSOLE_HTTP_PORT: String(port) });
  const console = createControlPlaneWebServer(configuration, { logger: { info: (message, fields) => consoleLogLines.push(JSON.stringify({ message, ...fields })) } });
  const bound = await console.listen();
  assert.equal(bound.port, port);
  const consoleOrigin = configuration.publicOrigin;
  return {
    workspace,
    host,
    console,
    consoleOrigin,
    browser: (name = 'browser') => new Browser(consoleOrigin, name),
    truth: (path: string) => call(host.baseUrl, 'GET', path, { authorization: AUTH.observer }),
    async close() {
      await console.close();
      await workspace.close();
    },
  };
}

export const OPERATOR_SECRETS = {
  administrator: SECRETS.administrator,
  provisioner: SECRETS.provisioner,
  observer: SECRETS.observer,
  responder: SECRETS.responder,
  steward: SECRETS.steward,
  legacyAdministrator: SECRETS.legacyAdministrator,
  legacyKey: SECRETS.legacyKey,
} as const;

export { AUTH, call, logLines, SECRETS };

/** Extracts the one-time secret from the credential-issued page, if rendered. */
export function revealedSecret(html: string): string | undefined {
  const match = /<pre class="secret" data-testid="one-time-secret">([^<]*)<\/pre>/.exec(html);
  return match?.[1];
}
