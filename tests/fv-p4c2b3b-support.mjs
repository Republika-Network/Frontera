// FV-P4C-2B3B — test support for the protected FV Host composition: a synthetic world with the real
// AUTH-03 identity service (software passkeys), real SQLite histories, the real protected store and the
// real receiver package. Synthetic principals, statuses, sources and databases. Not a test file itself;
// nothing here is used outside tests, and nothing here is reachable from the Host.
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { establishStatusHistory, verifySovereignStatus } from '@aoc-enterprise/sovereign-receiver-verification';

import { INTENDED_PRODUCTION_RP_ID, createHumanIdentityService, createRelyingPartyConfiguration, identityAdministratorFor, openSqliteHumanIdentityStore } from '../dist/src/enterprise/human-identity/index.js';
import { bootstrapAuthorityDecisionInput, bootstrapBindingDigest, bootstrapBindingOf, captureHistoryContinuity, openSqliteStatusHighWaterMarkStore, parseStatusHistoryBootstrapRequest } from '../dist/src/enterprise/sovereign-status-history/index.js';
import { openProtectedContinuityStore } from '../dist/src/enterprise/sovereign-status-history/protected-continuity-store.js';
import { composeFvProtectedHost } from '../dist/src/enterprise/sovereign-status-history/protected-host-composition.js';
import { AUTHORITY_KEY_A, testSigner, testVerifier } from '../dist/src/enterprise/__tests__/authority-authenticity-fixture.js';
import { SoftwareAuthenticator } from '../dist/src/enterprise/__tests__/auth02-software-authenticator.js';
import { FIXTURE, S, SUBJECT, addSeconds, resolver, sourceAttesting } from './fv-status-bootstrap-support.mjs';

export { FIXTURE, S, SUBJECT, addSeconds };
export const ORG = 'org-fv-p4c2b3b';
export const ORIGIN = `https://${INTENDED_PRODUCTION_RP_ID}`;
export const RP = createRelyingPartyConfiguration({ rpId: INTENDED_PRODUCTION_RP_ID, rpName: 'Frontera Authority', allowedOrigins: [ORIGIN] });
export const T = '2026-10-28T12:00:00Z';
export const NS_A = 'receiver:fv-b3b-a';
export const NS_B = 'receiver:fv-b3b-b';
export const OPERATORS = ['requester-a', 'approver-b', 'approver-c'];
export const GRACE = 300;

/** CORE-05's standing port, synthetic: requester-a may request, approver-b may approve; approver-c holds nothing. */
export const standing = Object.freeze({
  recognition: (actorId) => ({ recognized: OPERATORS.some((id) => actorId === `operator:${id}`) }),
  authority: ({ actorId, capability }) => ({
    valid: (capability === 'status-history.bootstrap.request' && actorId === 'operator:requester-a') || (capability === 'status-history.bootstrap.approve' && actorId === 'operator:approver-b'),
  }),
});

export function makeClock(iso = T) {
  return {
    ms: Date.parse(iso),
    now() {
      return new Date(this.ms);
    },
    iso() {
      return new Date(this.ms).toISOString();
    },
    advance(seconds) {
      this.ms += seconds * 1000;
    },
  };
}

export const pathsOf = (dir) => ({
  dir,
  identity: join(dir, 'human-identity.sqlite'),
  protectedStore: join(dir, 'fv-protected.sqlite'),
  history: (namespace) => join(dir, `${namespace.replace(/[^a-z0-9]/g, '_')}.sqlite`),
});

/** The world's synthetic authority key (generated per process by the fixture), shared with its child processes through the world's temporary directory. */
const keyFile = (dir) => join(dir, 'synthetic-test-authority-key.json');
const authorityKeyOf = (dir) => {
  try {
    return JSON.parse(readFileSync(keyFile(dir), 'utf8'));
  } catch {
    return AUTHORITY_KEY_A;
  }
};

export function openIdentity(dir, clock, create = false) {
  const key = authorityKeyOf(dir);
  return openSqliteHumanIdentityStore(pathsOf(dir).identity, { organizationId: ORG, now: () => clock.iso(), authenticity: { signer: testSigner(key), verifier: testVerifier([key]) }, create });
}

/**
 * The registration ceremony a B3C operator would perform, done here directly: the identity store with
 * three enrolled passkeys, one history per namespace, and the protected store holding each history's
 * continuity record. Everything is closed afterwards; the devices stay in this process.
 */
export async function prepareWorld({ namespaces = [NS_A, NS_B], dir = mkdtempSync(join(tmpdir(), 'fv-p4c2b3b-')) } = {}) {
  const paths = pathsOf(dir);
  const clock = makeClock();
  writeFileSync(keyFile(dir), JSON.stringify(AUTHORITY_KEY_A), { mode: 0o600 });
  const identityStore = await openIdentity(dir, clock, true);
  const identity = createHumanIdentityService({ store: identityStore, relyingParty: RP, operatorIds: OPERATORS, now: () => clock.now() });
  const admin = identityAdministratorFor({ plane: 'operator', operatorId: 'ops-admin', organizationId: ORG, role: 'organization-administrator', credentialClass: 'operator', actorRef: 'operator-plane:ops-admin' });
  const devices = {};
  for (const operatorId of OPERATORS) {
    devices[operatorId] = new SoftwareAuthenticator({ origin: ORIGIN });
    await identity.createPrincipal(admin, { operatorId, displayName: `Synthetic ${operatorId}` });
    const issued = await identity.authorizeEnrolment(admin, operatorId);
    await identity.finishRegistration(issued.enrolmentToken, devices[operatorId].register(identity.beginRegistration(issued.enrolmentToken)));
  }
  identityStore.close();
  const records = await openProtectedContinuityStore(paths.protectedStore, { create: true, now: () => clock.iso() });
  for (const namespace of namespaces) {
    const history = await openSqliteStatusHighWaterMarkStore(paths.history(namespace), { namespace, create: true });
    records.save(captureHistoryContinuity(history, { namespace, databasePath: paths.history(namespace), generation: 1, recordedAt: clock.iso() }));
    history.close();
  }
  records.close();
  return { dir, paths, devices, namespaces };
}

export const configurationOf = (world, namespaces = world.namespaces) => () => ({ generation: 1, histories: namespaces.map((namespace) => ({ namespace, databasePath: world.paths.history(namespace) })) });

/** The protected composition over `world`, as the trusted Host composition root would build it. */
export async function compose(world, identityStore, clock, overrides = {}) {
  return composeFvProtectedHost({
    protectedStorePath: world.paths.protectedStore,
    configuration: configurationOf(world),
    identity: { store: identityStore, relyingParty: RP, operatorIds: OPERATORS },
    standing,
    organizationId: ORG,
    clock: () => clock.now(),
    graceSeconds: GRACE,
    receiver: { verifySovereignStatus, establishStatusHistory },
    verificationKeyResolver: resolver,
    trustedSubjectOf: (id) => (id === SUBJECT.sovereignAssetId ? { ...SUBJECT } : undefined),
    // Synthetic, test-only: no trusted issuer-currentness source exists in the Host (B6).
    statusSource: { verifier: sourceAttesting(clock.iso()), policy: { acceptedSourceClasses: ['issuer-status-channel'], maxSourceAgeSeconds: 3600 } },
    ...overrides,
  });
}

let counter = 0;
export function requestFor(namespace, { status = S.active1, createdAt = T, ...overrides } = {}) {
  counter += 1;
  return {
    schemaVersion: 'frontera.sovereign-status-bootstrap/1',
    requestId: `req:fv-p4c2b3b-${process.pid}-${counter}`,
    operation: 'establish',
    purpose: 'initial-trust-anchor',
    namespace,
    sovereignAssetId: FIXTURE.sovereignAssetId,
    issuer: FIXTURE.registrant.issuer,
    manifestDigest: FIXTURE.manifestDigest,
    status: { sequence: status.sequence, statusDigest: status.digest },
    terms: JSON.parse(status.text).status.currentTerms,
    operatorRef: 'operator:requester-a',
    sourceRef: 'source:issuer-channel',
    createdAt,
    expiresAt: addSeconds(createdAt, 600),
    ...overrides,
  };
}

export const bindingOf = (request) => {
  const binding = bootstrapBindingOf(parseStatusHistoryBootstrapRequest(request));
  return { binding, digest: bootstrapBindingDigest(binding) };
};

/** Both humans' signed decisions for `request`, through the composition's own AUTH-03 ceremony. */
export function decisionsFor(host, devices, request, { requester = 'requester-a', approver = 'approver-b', binding = bindingOf(request).binding } = {}) {
  const sign = (operatorId, role) => devices[operatorId].assert(host.beginBootstrapDecision({ operatorId, ...bootstrapAuthorityDecisionInput(binding, role) }).options);
  return { requesterResponse: sign(requester, 'requester'), approverResponse: sign(approver, 'approver') };
}
