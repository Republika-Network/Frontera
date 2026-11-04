// FV-P4C-2B3B — test support for the protected FV Host composition: a synthetic world with the real
// AUTH-03 identity service (software passkeys), real SQLite histories, the real protected store and the
// real receiver package. Synthetic principals, statuses, sources and databases. Not a test file itself;
// nothing here is used outside tests, and nothing here is reachable from the Host.
import { createHash, randomBytes } from 'node:crypto';
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
import { appendFirstAdministrator, firstAdministratorCredentialDigest, firstAdministratorRegistrationOptions, newFirstAdministratorPlan, verifyFirstAdministratorAttestation } from '../dist/src/enterprise/human-identity/first-administrator.js';
import { FV_OPERATOR_AUTHORIZATION_FORMAT, FV_OPERATOR_ENROLL_ACTION, appendFvOperator, fvOperatorAdministratorOptions, fvOperatorCandidateOptions, verifyFvOperatorCandidate } from '../dist/src/enterprise/human-identity/fv-operator.js';
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
const identityStoreIdFile = (dir) => join(dir, 'identity-store-id.txt');

/**
 * FV-P4C-2B3C-3 — the executor's own bootstrap identity store, as the trusted composition configures it:
 * its path, its pinned store id and the deployment's synthetic signer. The composition opens it itself.
 */
export function identityConfigOf(dir, overrides = {}) {
  const key = authorityKeyOf(dir);
  return { storePath: pathsOf(dir).identity, storeId: readFileSync(identityStoreIdFile(dir), 'utf8'), authenticity: { signer: testSigner(key), verifier: testVerifier([key]) }, relyingParty: RP, operatorIds: OPERATORS, ...overrides };
}
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

/** CORE-07-FV-WITNESS — the FV bootstrap identity freshness domain (the FV store's own witness slot). */
export const FV_DOMAIN = 'fv-bootstrap-identity-state';

/**
 * CORE-07-FV-WITNESS — the synthetic, TEST-ONLY registration genesis of an FV bootstrap identity store anchored at
 * a CORE-07 witness: created as its exclusive owner, in its own freshness domain, its genesis enrolled at the
 * witness before the local genesis is committed. No production path does this: the composition never creates or
 * enrolls its store, and the FV registration ceremony is not implemented.
 */
export function createAnchoredFvIdentity(path, clock, boundary, key = AUTHORITY_KEY_A) {
  return openSqliteHumanIdentityStore(path, {
    organizationId: ORG,
    now: () => clock.iso(),
    authenticity: { signer: testSigner(key), verifier: testVerifier([key]) },
    create: true,
    freshness: { boundary, stateKind: FV_DOMAIN },
    exclusive: { beforeWrite: () => undefined, closer: (_file, connection) => () => void connection.close() },
  });
}

/** TEST-ONLY scope for the synthetic FV world's operator authorizations (no registration record exists in it). */
const SYNTHETIC_FV_SCOPE = Object.freeze({ deploymentId: 'deployment:synthetic-fv-b3b', stateKind: FV_DOMAIN, witnessId: 'witness:synthetic-fv-b3b', witnessKeyDigest: `sha256:${'5'.repeat(64)}` });

/**
 * FV-P4C-2B3C-2A2B — TEST-ONLY: the FV way to enrol the synthetic humans into an FV-owned store, by AUTH-03's own rows
 * (the ceremonies that normally call them need a registration record this synthetic world does not have): the first
 * operator as the FV administrator, then each other one as an FV operator, authorized by the administrator's passkey.
 */
async function enrollSyntheticFvHumans(store, devices, clock) {
  const [first, ...rest] = OPERATORS;
  devices[first] = new SoftwareAuthenticator({ origin: ORIGIN });
  const capabilityId = randomBytes(32).toString('hex');
  const issued = firstAdministratorRegistrationOptions({ relyingParty: RP, operatorId: first, displayName: `Synthetic ${first}`, capabilityId, timeoutSeconds: 60 });
  const credential = await verifyFirstAdministratorAttestation({ relyingParty: RP, capabilityId, nonce: issued.nonce, response: devices[first].register(issued.options) });
  await appendFirstAdministrator(store, newFirstAdministratorPlan({ operatorId: first, displayName: `Synthetic ${first}`, userHandle: issued.userHandle, recordedAt: clock.iso(), authorization: { capabilityId, issuer: 'issuer:test-only-synthetic' }, credential }));
  const adminCredentialId = credential.credentialId;
  for (const operatorId of rest) {
    devices[operatorId] = new SoftwareAuthenticator({ origin: ORIGIN });
    const head = store.head();
    const requestId = `fvop-${randomBytes(16).toString('hex')}`;
    const candidate = fvOperatorCandidateOptions({ relyingParty: RP, requestId, operatorId, displayName: `Synthetic ${operatorId}`, timeoutSeconds: 60, excludeCredentialIds: [] });
    const attestation = JSON.parse(JSON.stringify(devices[operatorId].register(candidate.options)));
    const proven = await verifyFvOperatorCandidate({ relyingParty: RP, requestId, nonce: candidate.nonce, response: attestation });
    const now = clock.ms;
    const authorization = {
      format: FV_OPERATOR_AUTHORIZATION_FORMAT,
      action: FV_OPERATOR_ENROLL_ACTION,
      requestId,
      organizationId: ORG,
      ...SYNTHETIC_FV_SCOPE,
      storeId: store.storeId,
      priorHead: { sequence: head.sequence, chainDigest: head.chainDigest },
      administrator: { operatorId: first, credentialId: adminCredentialId },
      candidate: { operatorId, displayName: `Synthetic ${operatorId}`, userHandle: candidate.userHandle, credentialDigest: firstAdministratorCredentialDigest(proven), attestationChallengeDigest: proven.challengeDigest },
      role: 'fv-operator',
      enrolment: { enrolmentId: `enr-${randomBytes(16).toString('hex')}`, tokenVerifier: createHash('sha256').update(randomBytes(32)).digest('hex') },
      notBefore: new Date(now).toISOString(),
      notAfter: new Date(now + 60_000).toISOString(),
    };
    const assertion = JSON.parse(JSON.stringify(devices[first].assert(fvOperatorAdministratorOptions({ relyingParty: RP, authorization, timeoutSeconds: 60 }))));
    const evidence = { authorization, candidateNonce: candidate.nonce, candidateAttestation: attestation, administratorAssertion: assertion };
    await appendFvOperator(store, evidence, { relyingParty: RP, expected: SYNTHETIC_FV_SCOPE, now: new Date(now) });
  }
}

/**
 * The registration ceremony a B3C operator would perform, done here directly: the identity store with
 * three enrolled passkeys, one history per namespace, and the protected store holding each history's
 * continuity record. Everything is closed afterwards; the devices stay in this process.
 */
export async function prepareWorld({ namespaces = [NS_A, NS_B], dir = mkdtempSync(join(tmpdir(), 'fv-p4c2b3b-')), boundary } = {}) {
  const paths = pathsOf(dir);
  const clock = makeClock();
  writeFileSync(keyFile(dir), JSON.stringify(AUTHORITY_KEY_A), { mode: 0o600 });
  // CORE-07-FV-WITNESS: with a witness boundary, the store is anchored in its own freshness domain from genesis.
  const identityStore = boundary === undefined ? await openIdentity(dir, clock, true) : await createAnchoredFvIdentity(paths.identity, clock, boundary);
  const devices = {};
  if (boundary === undefined) {
    // A shared (Host-style) store: AUTH-02's ordinary Host administration enrols the humans.
    const identity = createHumanIdentityService({ store: identityStore, relyingParty: RP, operatorIds: OPERATORS, now: () => clock.now() });
    const admin = identityAdministratorFor({ plane: 'operator', operatorId: 'ops-admin', organizationId: ORG, role: 'organization-administrator', credentialClass: 'operator', actorRef: 'operator-plane:ops-admin' });
    for (const operatorId of OPERATORS) {
      devices[operatorId] = new SoftwareAuthenticator({ origin: ORIGIN });
      await identity.createPrincipal(admin, { operatorId, displayName: `Synthetic ${operatorId}` });
      const issued = await identity.authorizeEnrolment(admin, operatorId);
      await identity.finishRegistration(issued.enrolmentToken, devices[operatorId].register(identity.beginRegistration(issued.enrolmentToken)));
    }
  } else {
    // FV-P4C-2B3C-2A2B: an FV-owned store refuses Host administration. The same humans are enrolled the FV way, through
    // AUTH-03's own rows: the first as the FV administrator, the others as FV operators under its passkey's assertion.
    await enrollSyntheticFvHumans(identityStore, devices, clock);
  }
  // FV-P4C-2B3C-3: the registration ceremony pins the executor's bootstrap identity store by its id.
  writeFileSync(identityStoreIdFile(dir), identityStore.storeId, { mode: 0o600 });
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

/** The protected composition over `world`, as the trusted Host composition root would build it (it opens its own identity store). */
export async function compose(world, clock, overrides = {}) {
  return composeFvProtectedHost({
    protectedStorePath: world.paths.protectedStore,
    configuration: configurationOf(world),
    identity: identityConfigOf(world.paths.dir),
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
