// API freeze verification (PR-RC Objective 5 / 11).
//
// The v1 HTTP surface is frozen in release/api-surface.v1.json. This check
// fails if the routing source drifts from the freeze file in either
// direction (routes added, removed, or re-patterned), and live-probes every
// frozen route against an in-memory Host to prove each is actually wired.
//
// Capability-gated routes (`capabilityGatedProbes`) are frozen exactly like
// every other route -- their literals are in `routeLiterals`, so a removed,
// renamed or undeclared one fails the static drift check -- but they are
// mounted only when the Host composes the capabilities they name. The default
// Host composes none of them, so here they are probed the other way round: the
// default Host must answer them with the unmounted-route envelope, proving the
// gate holds. That they ARE mounted under full composition is proven by the
// suite each entry names in `provenMountedBy`, which must exist.
// Run AFTER `npm run build`.

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(new URL('..', import.meta.url).pathname);
const freeze = JSON.parse(readFileSync(resolve(root, 'release/api-surface.v1.json'), 'utf8'));
const adapterSource = readFileSync(resolve(root, 'src/enterprise/adapters/node-http-adapter.ts'), 'utf8');

function fail(message) {
  console.error(`[api-freeze] ${message}`);
  process.exit(1);
}

function diffSets(actual, frozen, label) {
  const added = [...actual].filter((entry) => !frozen.includes(entry)).sort();
  const removed = frozen.filter((entry) => !actual.has(entry)).sort();
  if (added.length > 0 || removed.length > 0) {
    fail(
      `${label} drifted from the freeze file.` +
        (added.length > 0 ? ` Added: ${JSON.stringify(added)}.` : '') +
        (removed.length > 0 ? ` Removed: ${JSON.stringify(removed)}.` : '') +
        ' The v1 HTTP surface is frozen (docs/enterprise/API_STABILITY_V1.md); additive changes require updating release/api-surface.v1.json deliberately in review.',
    );
  }
}

// -- static drift detection ---------------------------------------------------

const literalMatches = new Set(
  [...adapterSource.matchAll(/url\.pathname === '([^']+)'/g)].map((match) => match[1]),
);
diffSets(literalMatches, freeze.routeLiterals, 'Route literals');

const patternMatches = new Set(
  [...adapterSource.matchAll(/(\^\\\/api\\\/[^;]*?)\/\.exec/g)].map((match) => match[1].replaceAll('\\/', '\\/')),
);
diffSets(patternMatches, freeze.routePatterns, 'Route patterns');

const prefixMatches = new Set(
  [...adapterSource.matchAll(/pathname\.startsWith\('([^']+)'\)/g)].map((match) => match[1]),
);
diffSets(prefixMatches, freeze.routePrefixGuards, 'Route prefix guards');

// -- capability-gated routes: frozen statically, never an exemption -------------

const gatedProbes = freeze.capabilityGatedProbes ?? [];
for (const gated of gatedProbes) {
  if (!freeze.routeLiterals.includes(gated.path)) {
    fail(`Capability-gated route ${gated.method} ${gated.path} is not in routeLiterals; gating is not an exemption from drift detection.`);
  }
  if (freeze.probes.some((probe) => probe.method === gated.method && probe.path === gated.path)) {
    fail(`Route ${gated.method} ${gated.path} is listed both as an unconditional probe and as capability-gated.`);
  }
  if (!Array.isArray(gated.requires) || gated.requires.length === 0) {
    fail(`Capability-gated route ${gated.method} ${gated.path} must name the capabilities it requires.`);
  }
  if (typeof gated.provenMountedBy !== 'string' || !existsSync(resolve(root, gated.provenMountedBy))) {
    fail(`Capability-gated route ${gated.method} ${gated.path} must name an existing suite proving it is mounted under full composition.`);
  }
}

const actionsMatch = adapterSource.match(/const PASSPORT_ACTIONS[^=]*= \[([^\]]+)\]/);
if (!actionsMatch) fail('Could not locate PASSPORT_ACTIONS in the adapter source.');
const actionSet = new Set([...actionsMatch[1].matchAll(/'([^']+)'/g)].map((match) => match[1]));
diffSets(actionSet, freeze.passportActions, 'Passport actions');

// -- live probes: every frozen route must be wired ---------------------------

const { createEnterpriseServer, loadEnterpriseConfiguration } = await import(resolve(root, 'dist/src/enterprise/index.js'));
const server = await createEnterpriseServer({
  configuration: loadEnterpriseConfiguration({
    AOC_ENTERPRISE_HTTP_PORT: '0',
    AOC_ENTERPRISE_HTTP_HOST: '127.0.0.1',
    AOC_ENTERPRISE_LOG_LEVEL: 'error',
    AOC_ENTERPRISE_PERSISTENCE_PROVIDER: 'memory',
  }),
});
const { port } = await server.listen();
const baseUrl = `http://127.0.0.1:${port}`;

try {
  // Canary: an unknown route must produce the frozen NOT_FOUND envelope...
  const canary = await fetch(`${baseUrl}/api/definitely-not-a-route`);
  const canaryBody = await canary.json();
  if (canary.status !== 404 || canaryBody?.error?.code !== 'NOT_FOUND') {
    fail(`Unknown-route canary expected 404 NOT_FOUND envelope, got ${canary.status} ${JSON.stringify(canaryBody).slice(0, 120)}.`);
  }

  // ...and every frozen route must NOT: any other response proves the route is wired.
  for (const probe of freeze.probes) {
    const response = await fetch(`${baseUrl}${probe.path}`, {
      method: probe.method,
      headers: { 'content-type': 'application/json' },
      ...(probe.method === 'POST' ? { body: '{}' } : {}),
    });
    const body = await response.json();
    const isUnrouted = response.status === 404 && body?.error?.code === 'NOT_FOUND' && String(body.error.message).startsWith('No route');
    if (isUnrouted) {
      fail(`Frozen route ${probe.method} ${probe.path} is no longer wired (got the unknown-route envelope). Removing or renaming a v1 route is a breaking change.`);
    }
  }

  // ...while every capability-gated route must stay unmounted on a Host that
  // composed none of its capabilities: a route that answers here has lost its gate.
  for (const gated of gatedProbes) {
    const response = await fetch(`${baseUrl}${gated.path}`, {
      method: gated.method,
      headers: { 'content-type': 'application/json' },
      ...(gated.method === 'POST' ? { body: '{}' } : {}),
    });
    const body = await response.json();
    const isUnrouted = response.status === 404 && body?.error?.code === 'NOT_FOUND' && String(body.error.message).startsWith('No route');
    if (!isUnrouted) {
      fail(`Capability-gated route ${gated.method} ${gated.path} answered on a Host without ${gated.requires.join(' + ')} (got ${response.status}). It must be mounted only when those capabilities are composed.`);
    }
  }
} finally {
  await server.close();
}

console.log(
  `API freeze check passed: ${freeze.probes.length} frozen routes wired, ${gatedProbes.length} capability-gated route(s) unmounted on the default Host, no source drift (${freeze.endpointCount} endpoints).`,
);
