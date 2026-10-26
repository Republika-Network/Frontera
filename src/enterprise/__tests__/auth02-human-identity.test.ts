import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import Database from 'better-sqlite3';

import {
  HumanIdentityError,
  INTENDED_PRODUCTION_RP_ID,
  createHumanIdentityService,
  createRelyingPartyConfiguration,
  identityAdministratorFor,
  openSqliteHumanIdentityStore,
  type HumanIdentityErrorCode,
  type HumanIdentityService,
  type HumanIdentityStore,
  type IdentityAdministrator,
  type RelyingPartyInput,
} from '../human-identity/index.js';
import type { EnterpriseOperatorPrincipal } from '../operator-control/operator-authenticator.js';
import { SoftwareAuthenticator, cbor, offCurveCoseKey, truncatedCoseKey, type Cbor } from './auth02-software-authenticator.js';

/**
 * AUTH-02 — human identity and passkey credential lifecycle.
 *
 * Every ceremony below is verified by the production path: the service, the
 * SQLite store and `@simplewebauthn/server`, driven by a spec-faithful
 * software authenticator (./auth02-software-authenticator.ts). The relying
 * party is the intended production configuration
 * (`authority.frontera-systems.com`, HTTPS only); nothing touches a network.
 */

const ORG = 'org-auth02';
const ORIGIN = `https://${INTENDED_PRODUCTION_RP_ID}`;
const RP = createRelyingPartyConfiguration({ rpId: INTENDED_PRODUCTION_RP_ID, rpName: 'Frontera Authority', allowedOrigins: [ORIGIN] });
const OPERATORS = ['ops-admin', 'cto', 'approver-b', 'ops-observer'];

const operatorPrincipal = (overrides: Partial<EnterpriseOperatorPrincipal> = {}): EnterpriseOperatorPrincipal => ({
  plane: 'operator',
  operatorId: 'ops-admin',
  organizationId: ORG,
  role: 'organization-administrator',
  credentialClass: 'operator',
  actorRef: 'operator-plane:ops-admin',
  ...overrides,
});

class Clock {
  private ms = Date.now();
  now = (): Date => new Date(this.ms);
  advance(seconds: number): void {
    this.ms += seconds * 1000;
  }
}

const directories: string[] = [];
const stores: HumanIdentityStore[] = [];
after(() => {
  for (const store of stores.splice(0)) {
    try {
      store.close();
    } catch {
      // already closed by its test
    }
  }
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface World {
  readonly dir: string;
  readonly path: string;
  readonly clock: Clock;
  readonly store: HumanIdentityStore;
  readonly service: HumanIdentityService;
  readonly admin: IdentityAdministrator;
}

async function openService(path: string, clock: Clock, options: { readonly create?: boolean; readonly busyTimeoutMs?: number; readonly organizationId?: string } = {}): Promise<{ readonly store: HumanIdentityStore; readonly service: HumanIdentityService }> {
  const store = await openSqliteHumanIdentityStore(path, {
    organizationId: options.organizationId ?? ORG,
    now: () => clock.now().toISOString(),
    ...(options.create === true ? { create: true } : {}),
    ...(options.busyTimeoutMs === undefined ? {} : { busyTimeoutMs: options.busyTimeoutMs }),
  });
  stores.push(store);
  return { store, service: createHumanIdentityService({ store, relyingParty: RP, operatorIds: OPERATORS, now: clock.now }) };
}

async function world(options: { readonly busyTimeoutMs?: number } = {}): Promise<World> {
  const dir = mkdtempSync(join(tmpdir(), 'frontera-auth02-'));
  directories.push(dir);
  const path = join(dir, 'identity', 'human-identity.sqlite');
  const clock = new Clock();
  const { store, service } = await openService(path, clock, { create: true, ...options });
  return { dir, path, clock, store, service, admin: identityAdministratorFor(operatorPrincipal()) };
}

async function refused(code: HumanIdentityErrorCode, run: () => unknown): Promise<void> {
  await assert.rejects(
    async () => {
      await run();
    },
    (error: unknown) => {
      if (error instanceof HumanIdentityError && error.code === code) return true;
      return assert.fail(`expected ${code}, got ${String((error as { code?: unknown }).code)}: ${(error as Error).message}`);
    },
  );
}

/** Creates the human (if absent), authorizes one enrolment, and registers `authenticator` through the full ceremony. */
async function enrol(w: World, authenticator: SoftwareAuthenticator, operatorId = 'cto') {
  if (w.service.principal(operatorId) === undefined) w.service.createPrincipal(w.admin, { operatorId, displayName: `Human ${operatorId}` });
  const issued = w.service.authorizeEnrolment(w.admin, operatorId);
  const options = w.service.beginRegistration(issued.enrolmentToken);
  const credential = await w.service.finishRegistration(issued.enrolmentToken, authenticator.register(options));
  return { issued, options, credential };
}

const device = (options: { readonly synced?: boolean; readonly credentialId?: Uint8Array } = {}): SoftwareAuthenticator => new SoftwareAuthenticator({ origin: ORIGIN, ...options });

describe('AUTH-02 relying party — explicit, closed, fail-closed configuration', () => {
  it('accepts the intended production RP ID with HTTPS origins on it or its subdomains', () => {
    const rp = createRelyingPartyConfiguration({ rpId: INTENDED_PRODUCTION_RP_ID, rpName: 'Frontera Authority', allowedOrigins: [ORIGIN, `https://app.${INTENDED_PRODUCTION_RP_ID}`] });
    assert.equal(rp.rpId, 'authority.frontera-systems.com');
    assert.equal(rp.mode, 'production');
    assert.ok(Object.isFrozen(rp) && Object.isFrozen(rp.allowedOrigins));
  });

  const base: RelyingPartyInput = { rpId: INTENDED_PRODUCTION_RP_ID, rpName: 'Frontera Authority', allowedOrigins: [ORIGIN] };
  for (const [name, input] of [
    ['an http origin', { ...base, allowedOrigins: [`http://${INTENDED_PRODUCTION_RP_ID}`] }],
    ['an origin on another domain', { ...base, allowedOrigins: ['https://frontera-systems.com.evil.example'] }],
    ['the parent domain as origin', { ...base, allowedOrigins: ['https://frontera-systems.com'] }],
    ['an origin with a path', { ...base, allowedOrigins: [`${ORIGIN}/approve`] }],
    ['an origin with a trailing slash', { ...base, allowedOrigins: [`${ORIGIN}/`] }],
    ['an RP ID with a scheme', { ...base, rpId: ORIGIN }],
    ['an IP address RP ID', { ...base, rpId: '10.0.0.1', allowedOrigins: ['https://10.0.0.1'] }],
    ['localhost in production mode', { ...base, rpId: 'localhost', allowedOrigins: ['http://localhost:3000'] }],
    ['the loopback test mode on a real domain', { ...base, mode: 'test-loopback-only' as const }],
    ['the loopback test mode with a non-loopback origin', { rpId: 'localhost', rpName: 'Test', allowedOrigins: ['http://127.0.0.1:3000'], mode: 'test-loopback-only' as const }],
    ['duplicate origins', { ...base, allowedOrigins: [ORIGIN, ORIGIN] }],
    ['no origins', { ...base, allowedOrigins: [] }],
    ['an unknown field', { ...base, allowAnyOrigin: true } as unknown as RelyingPartyInput],
  ] as const) {
    it(`refuses ${name}`, () => {
      assert.throws(() => createRelyingPartyConfiguration(input as RelyingPartyInput), (error: unknown) => error instanceof HumanIdentityError && error.code === 'HUMAN_IDENTITY_CONFIGURATION_INVALID');
    });
  }

  it('allows loopback only in the explicit, isolated test mode', () => {
    const rp = createRelyingPartyConfiguration({ rpId: 'localhost', rpName: 'Test', allowedOrigins: ['http://localhost:3000'], mode: 'test-loopback-only' });
    assert.equal(rp.mode, 'test-loopback-only');
  });
});

describe('AUTH-02 principals and administration — identity is not authority', () => {
  it('an organization administrator creates a named human for a configured operator', async () => {
    const w = await world();
    const human = w.service.createPrincipal(w.admin, { operatorId: 'cto', displayName: 'Chief Technology Officer' });
    assert.deepEqual(
      { operatorId: human.operatorId, actorRef: human.actorRef, organizationId: human.organizationId, state: human.state, createdBy: human.createdBy, revokedAt: human.revokedAt },
      { operatorId: 'cto', actorRef: 'operator:cto', organizationId: ORG, state: 'active', createdBy: 'operator-plane:ops-admin', revokedAt: null },
    );
    await refused('HUMAN_IDENTITY_PRINCIPAL_EXISTS', () => w.service.createPrincipal(w.admin, { operatorId: 'cto', displayName: 'Again' }));
  });

  it('refuses an operator id this Host does not configure', async () => {
    const w = await world();
    await refused('HUMAN_IDENTITY_UNKNOWN_OPERATOR', () => w.service.createPrincipal(w.admin, { operatorId: 'ghost', displayName: 'Ghost' }));
    await refused('HUMAN_IDENTITY_UNKNOWN_PRINCIPAL', () => w.service.authorizeEnrolment(w.admin, 'approver-b'));
  });

  it('only a CTRL-02 organization administrator of this organization administers identities', async () => {
    const w = await world();
    for (const role of ['approver', 'observer', 'provisioner', 'responder', 'profile-steward'] as const) {
      await refused('HUMAN_IDENTITY_ADMINISTRATOR_REQUIRED', () => identityAdministratorFor(operatorPrincipal({ role })));
    }
    await refused('HUMAN_IDENTITY_ADMINISTRATOR_REQUIRED', () => identityAdministratorFor(operatorPrincipal({ credentialClass: 'legacy-administrator', role: 'legacy-administrator' })));
    const forged: IdentityAdministrator = { operatorId: 'ops-admin', organizationId: ORG, actorRef: 'operator-plane:ops-admin' };
    await refused('HUMAN_IDENTITY_ADMINISTRATOR_REQUIRED', () => w.service.createPrincipal(forged, { operatorId: 'cto', displayName: 'CTO' }));
    const foreign = identityAdministratorFor(operatorPrincipal({ organizationId: 'org-other' }));
    await refused('HUMAN_IDENTITY_ADMINISTRATOR_REQUIRED', () => w.service.createPrincipal(foreign, { operatorId: 'cto', displayName: 'CTO' }));
    assert.equal(w.service.principal('cto'), undefined, 'nothing was recorded');
  });
});

describe('AUTH-02 enrolment and registration', () => {
  it('registers a passkey through an administrator-authorized, single-use enrolment', async () => {
    const w = await world();
    const authenticator = device();
    const { issued, options, credential } = await enrol(w, authenticator);
    assert.match(issued.enrolmentToken, /^fre1\.enr-[0-9a-f]{32}\.[A-Za-z0-9_-]{43}$/);
    assert.equal(options.rp.id, INTENDED_PRODUCTION_RP_ID);
    assert.equal(options.authenticatorSelection.userVerification, 'required');
    assert.equal(options.authenticatorSelection.residentKey, 'required');
    assert.equal(options.attestation, 'none');
    assert.deepEqual(options.pubKeyCredParams.map((param) => param.alg), [-8, -7, -257]);
    assert.notEqual(options.user.id, 'cto', 'the user handle is opaque, not the operator id');
    assert.deepEqual(
      { id: credential.credentialId, operatorId: credential.operatorId, state: credential.state, counter: credential.counter, deviceType: credential.deviceType, backedUp: credential.backedUp, fmt: credential.attestationFormat, rpId: credential.rpId, transports: credential.transports },
      { id: authenticator.id, operatorId: 'cto', state: 'active', counter: 0, deviceType: 'singleDevice', backedUp: false, fmt: 'none', rpId: INTENDED_PRODUCTION_RP_ID, transports: ['hybrid', 'internal'] },
    );
    assert.equal(w.service.enrolment(issued.enrolmentId)?.state, 'consumed');
    await refused('HUMAN_IDENTITY_ENROLMENT_INVALID', () => w.service.beginRegistration(issued.enrolmentToken));
    await refused('HUMAN_IDENTITY_ENROLMENT_INVALID', () => w.service.finishRegistration(issued.enrolmentToken, authenticator.register(options)));
  });

  async function opened(w: World) {
    w.service.createPrincipal(w.admin, { operatorId: 'cto', displayName: 'CTO' });
    const issued = w.service.authorizeEnrolment(w.admin, 'cto');
    return { issued, options: w.service.beginRegistration(issued.enrolmentToken) };
  }

  for (const [name, code, overrides] of [
    ['a wrong challenge', 'HUMAN_IDENTITY_CHALLENGE_INVALID', { challenge: randomBytes(32).toString('base64url') }],
    ['a wrong origin', 'HUMAN_IDENTITY_REGISTRATION_INVALID', { origin: 'https://evil.example' }],
    ['a wrong RP ID', 'HUMAN_IDENTITY_REGISTRATION_INVALID', { rpId: 'evil.example' }],
    ['a cross-origin ceremony', 'HUMAN_IDENTITY_REGISTRATION_INVALID', { crossOrigin: true }],
    ['an embedded ceremony (top origin)', 'HUMAN_IDENTITY_REGISTRATION_INVALID', { topOrigin: 'https://evil.example' }],
    ['the wrong ceremony type', 'HUMAN_IDENTITY_REGISTRATION_INVALID', { type: 'webauthn.get' }],
    ['missing user verification', 'HUMAN_IDENTITY_REGISTRATION_INVALID', { userVerified: false }],
    ['missing user presence', 'HUMAN_IDENTITY_REGISTRATION_INVALID', { userPresent: false }],
    ['no attested credential data', 'HUMAN_IDENTITY_REGISTRATION_INVALID', { omitAttestedCredentialData: true }],
    ['an unsupported attestation format', 'HUMAN_IDENTITY_REGISTRATION_INVALID', { fmt: 'vendor-unknown' }],
    ['a forged packed attestation', 'HUMAN_IDENTITY_REGISTRATION_INVALID', { fmt: 'packed', attStmt: new Map<number | string, Cbor>([['alg', -7], ['sig', randomBytes(70)]]) }],
    ['a none attestation with a statement', 'HUMAN_IDENTITY_REGISTRATION_INVALID', { attStmt: new Map<number | string, Cbor>([['x5c', [randomBytes(32)]]]) }],
    ['a public key off the curve', 'HUMAN_IDENTITY_REGISTRATION_INVALID', { coseKey: offCurveCoseKey() }],
    ['a truncated public key', 'HUMAN_IDENTITY_REGISTRATION_INVALID', { coseKey: truncatedCoseKey() }],
    ['an RSA key below 2048 bits', 'HUMAN_IDENTITY_REGISTRATION_INVALID', { coseKey: cbor(new Map<number | string, Cbor>([[1, 3], [3, -257], [-1, randomBytes(128)], [-2, Buffer.from([1, 0, 1])]])) }],
    ['an unsupported key algorithm', 'HUMAN_IDENTITY_REGISTRATION_INVALID', { coseKey: cbor(new Map<number | string, Cbor>([[1, 2], [3, -35], [-1, 2], [-2, randomBytes(48)], [-3, randomBytes(48)]])) }],
  ] as const) {
    it(`refuses ${name} and records nothing`, async () => {
      const w = await world();
      const { issued, options } = await opened(w);
      const before = w.store.history().length;
      await refused(code, () => w.service.finishRegistration(issued.enrolmentToken, device().register(options, overrides)));
      assert.equal(w.store.history().length, before, 'nothing was recorded');
      assert.equal(w.service.enrolment(issued.enrolmentId)?.state, 'open', 'the enrolment remains usable');
      assert.deepEqual(w.service.credentialsOf('cto'), []);
    });
  }

  it('refuses malformed response shapes', async () => {
    const w = await world();
    const { issued, options } = await opened(w);
    const genuine = device().register(options);
    const response = genuine['response'] as Record<string, unknown>;
    for (const shape of [
      null,
      'credential',
      { ...genuine, extra: true },
      { ...genuine, rawId: 'AAAA' },
      { ...genuine, type: 'password' },
      { ...genuine, response: { ...response, attestationObject: undefined } },
      { ...genuine, response: { ...response, clientDataJSON: 'not base64url!' } },
      { ...genuine, response: { ...response, transports: ['telepathy'] } },
    ]) {
      await refused('HUMAN_IDENTITY_REGISTRATION_INVALID', () => w.service.finishRegistration(issued.enrolmentToken, shape));
    }
  });

  it('an expired challenge, and a challenge issued for another enrolment, are refused', async () => {
    const w = await world();
    const { issued, options } = await opened(w);
    const other = w.service.authorizeEnrolment(w.admin, 'cto');
    await refused('HUMAN_IDENTITY_CHALLENGE_INVALID', () => w.service.finishRegistration(other.enrolmentToken, device().register(options)));
    w.clock.advance(301);
    await refused('HUMAN_IDENTITY_CHALLENGE_INVALID', () => w.service.finishRegistration(issued.enrolmentToken, device().register(options)));
  });

  it('enrolment tokens: malformed, wrong secret, revoked, expired — all one refusal', async () => {
    const w = await world();
    const { issued } = await opened(w);
    await refused('HUMAN_IDENTITY_ENROLMENT_INVALID', () => w.service.beginRegistration('fre1.nope'));
    await refused('HUMAN_IDENTITY_ENROLMENT_INVALID', () => w.service.beginRegistration(`${issued.enrolmentToken.slice(0, -4)}AAAA`));
    const revocable = w.service.authorizeEnrolment(w.admin, 'cto');
    assert.equal(w.service.revokeEnrolment(w.admin, revocable.enrolmentId, 'sent to the wrong address').state, 'revoked');
    await refused('HUMAN_IDENTITY_ENROLMENT_INVALID', () => w.service.beginRegistration(revocable.enrolmentToken));
    await refused('HUMAN_IDENTITY_ALREADY_REVOKED', () => w.service.revokeEnrolment(w.admin, revocable.enrolmentId, 'again'));
    w.clock.advance(901);
    assert.equal(w.service.enrolment(issued.enrolmentId)?.state, 'expired');
    await refused('HUMAN_IDENTITY_ENROLMENT_INVALID', () => w.service.beginRegistration(issued.enrolmentToken));
  });

  it('a duplicate credential id is refused — for another human, and after revocation (no resurrection)', async () => {
    const w = await world();
    const original = device();
    const { credential } = await enrol(w, original);
    await refused('HUMAN_IDENTITY_CREDENTIAL_DUPLICATE', () => enrol(w, device({ credentialId: original.credentialId }), 'approver-b'));
    w.service.revokeCredential(w.admin, credential.credentialId, 'device lost');
    await refused('HUMAN_IDENTITY_CREDENTIAL_DUPLICATE', () => enrol(w, device({ credentialId: original.credentialId })));
  });

  it('interrupted enrolment recovers: an abandoned or failed ceremony leaves the enrolment usable; nothing is half-registered', async () => {
    const w = await world();
    const { issued, options } = await opened(w);
    // Abandoned: the first options were never answered. A new ceremony starts cleanly.
    const second = w.service.beginRegistration(issued.enrolmentToken);
    assert.notEqual(second.challenge, options.challenge);
    // Failed: a refused response consumes neither the enrolment nor the challenge.
    const authenticator = device();
    await refused('HUMAN_IDENTITY_REGISTRATION_INVALID', () => w.service.finishRegistration(issued.enrolmentToken, authenticator.register(second, { origin: 'https://evil.example' })));
    const credential = await w.service.finishRegistration(issued.enrolmentToken, authenticator.register(second));
    assert.equal(credential.state, 'active');
    assert.equal(w.service.credentialsOf('cto').length, 1);
  });

  it('interrupted persistence: a commit that cannot take the lock records nothing and consumes nothing; the same response then commits once', async () => {
    const w = await world({ busyTimeoutMs: 50 });
    const { issued, options } = await opened(w);
    const response = device().register(options);
    const blocker = new Database(w.path);
    blocker.exec('BEGIN IMMEDIATE');
    try {
      await refused('HUMAN_IDENTITY_STORE_UNAVAILABLE', () => w.service.finishRegistration(issued.enrolmentToken, response));
    } finally {
      blocker.exec('ROLLBACK');
      blocker.close();
    }
    assert.deepEqual(w.service.credentialsOf('cto'), []);
    assert.equal(w.service.enrolment(issued.enrolmentId)?.state, 'open');
    const credential = await w.service.finishRegistration(issued.enrolmentToken, response);
    assert.equal(credential.state, 'active');
    await refused('HUMAN_IDENTITY_ENROLMENT_INVALID', () => w.service.finishRegistration(issued.enrolmentToken, response));
  });

  it('concurrent enrolment over two connections: one enrolment yields exactly one credential; one credential id is registered once', async () => {
    const w = await world();
    const { issued } = await opened(w);
    const peer = await openService(w.path, w.clock);
    const first = w.service.beginRegistration(issued.enrolmentToken);
    const secondOptions = peer.service.beginRegistration(issued.enrolmentToken);
    const outcomes = await Promise.allSettled([w.service.finishRegistration(issued.enrolmentToken, device().register(first)), peer.service.finishRegistration(issued.enrolmentToken, device().register(secondOptions))]);
    assert.deepEqual(outcomes.map((outcome) => outcome.status).sort(), ['fulfilled', 'rejected']);
    const loser = outcomes.find((outcome) => outcome.status === 'rejected') as PromiseRejectedResult;
    assert.ok(loser.reason instanceof HumanIdentityError && ['HUMAN_IDENTITY_ENROLMENT_INVALID', 'HUMAN_IDENTITY_CHALLENGE_INVALID'].includes(loser.reason.code), String(loser.reason));
    assert.equal(w.service.credentialsOf('cto').length, 1);

    const shared = randomBytes(32);
    w.service.createPrincipal(w.admin, { operatorId: 'approver-b', displayName: 'Approver B' });
    const a = w.service.authorizeEnrolment(w.admin, 'cto');
    const b = w.service.authorizeEnrolment(w.admin, 'approver-b');
    const raced = await Promise.allSettled([
      w.service.finishRegistration(a.enrolmentToken, device({ credentialId: shared }).register(w.service.beginRegistration(a.enrolmentToken))),
      peer.service.finishRegistration(b.enrolmentToken, device({ credentialId: shared }).register(peer.service.beginRegistration(b.enrolmentToken))),
    ]);
    assert.deepEqual(raced.map((outcome) => outcome.status).sort(), ['fulfilled', 'rejected']);
    const duplicate = raced.find((outcome) => outcome.status === 'rejected') as PromiseRejectedResult;
    assert.ok(duplicate.reason instanceof HumanIdentityError && duplicate.reason.code === 'HUMAN_IDENTITY_CREDENTIAL_DUPLICATE', String(duplicate.reason));
  });
});

describe('AUTH-02 recognition — a verified assertion says who, never may', () => {
  it('recognizes the human behind an active credential, with user verification, and advances the counter', async () => {
    const w = await world();
    const authenticator = device();
    const { credential } = await enrol(w, authenticator);
    const human = await w.service.finishAuthentication(authenticator.assert(w.service.beginAuthentication()));
    assert.deepEqual(
      { operatorId: human.operatorId, actorRef: human.actorRef, organizationId: human.organizationId, credentialId: human.credentialId, userVerified: human.userVerified, counter: human.counter },
      { operatorId: 'cto', actorRef: 'operator:cto', organizationId: ORG, credentialId: credential.credentialId, userVerified: true, counter: 1 },
    );
    assert.equal(Object.keys(human).some((key) => /session|token|cookie|permission|role|authority|approv/i.test(key)), false, 'no session, token or authority is issued');
    assert.equal((await w.service.finishAuthentication(authenticator.assert(w.service.beginAuthentication()))).counter, 2);
    assert.ok(w.service.credentialsOf('cto')[0]?.lastUsedAt !== null);
  });

  for (const [name, code, overrides] of [
    ['a wrong origin', 'HUMAN_IDENTITY_AUTHENTICATION_INVALID', { origin: 'https://evil.example' }],
    ['a wrong RP ID', 'HUMAN_IDENTITY_AUTHENTICATION_INVALID', { rpId: 'evil.example' }],
    ['a cross-origin ceremony', 'HUMAN_IDENTITY_AUTHENTICATION_INVALID', { crossOrigin: true }],
    ['missing user verification', 'HUMAN_IDENTITY_AUTHENTICATION_INVALID', { userVerified: false }],
    ['missing user presence', 'HUMAN_IDENTITY_AUTHENTICATION_INVALID', { userPresent: false }],
    ['an invalid signature', 'HUMAN_IDENTITY_AUTHENTICATION_INVALID', { corruptSignature: true }],
    ['a wrong challenge', 'HUMAN_IDENTITY_CHALLENGE_INVALID', { challenge: randomBytes(32).toString('base64url') }],
    ['an unknown credential', 'HUMAN_IDENTITY_CREDENTIAL_UNUSABLE', { credentialId: randomBytes(32).toString('base64url') }],
  ] as const) {
    it(`refuses ${name} and records nothing`, async () => {
      const w = await world();
      const authenticator = device();
      await enrol(w, authenticator);
      const before = w.store.history().length;
      await refused(code, () => w.service.finishAuthentication(authenticator.assert(w.service.beginAuthentication(), overrides)));
      assert.equal(w.store.history().length, before);
    });
  }

  it('a challenge is single-use and ceremony-bound; a used challenge stays used across a restart', async () => {
    const w = await world();
    const authenticator = device();
    const { options } = await enrol(w, authenticator);
    const assertion = authenticator.assert(w.service.beginAuthentication());
    await w.service.finishAuthentication(assertion);
    await refused('HUMAN_IDENTITY_CHALLENGE_INVALID', () => w.service.finishAuthentication(assertion));
    await refused('HUMAN_IDENTITY_CHALLENGE_INVALID', () => w.service.finishAuthentication(authenticator.assert({ rpId: INTENDED_PRODUCTION_RP_ID, challenge: options.challenge, timeout: 1, userVerification: 'required', allowCredentials: [] })));
    w.store.close();
    const restarted = await openService(w.path, w.clock);
    await refused('HUMAN_IDENTITY_CHALLENGE_INVALID', () => restarted.service.finishAuthentication(assertion));
    assert.equal((await restarted.service.finishAuthentication(authenticator.assert(restarted.service.beginAuthentication()))).operatorId, 'cto', 'the credential survives the restart');
  });

  it('an expired authentication challenge is refused', async () => {
    const w = await world();
    const authenticator = device();
    await enrol(w, authenticator);
    const options = w.service.beginAuthentication();
    w.clock.advance(301);
    await refused('HUMAN_IDENTITY_CHALLENGE_INVALID', () => w.service.finishAuthentication(authenticator.assert(options)));
  });

  it('incorrect ownership: an assertion naming another human’s user handle is refused', async () => {
    const w = await world();
    const cto = device();
    const other = device();
    await enrol(w, cto);
    await enrol(w, other, 'approver-b');
    await refused('HUMAN_IDENTITY_CREDENTIAL_OWNERSHIP_MISMATCH', () => w.service.finishAuthentication(cto.assert(w.service.beginAuthentication(), { userHandle: other.userHandle ?? null })));
  });

  it('signing counters: a counting authenticator must advance; a regression or a repeat is refused and recorded; the credential is not silently trusted or revoked', async () => {
    const w = await world();
    const authenticator = device();
    const { credential } = await enrol(w, authenticator);
    await w.service.finishAuthentication(authenticator.assert(w.service.beginAuthentication(), { counter: 5 }));
    for (const counter of [5, 4, 0]) {
      await refused('HUMAN_IDENTITY_COUNTER_REGRESSION', () => w.service.finishAuthentication(authenticator.assert(w.service.beginAuthentication(), { counter })));
    }
    const anomalies = w.store.history().filter((row) => row.kind === 'credential_counter_anomaly');
    assert.equal(anomalies.length, 3, 'each verified regression is recorded');
    assert.equal(w.service.credentialsOf('cto')[0]?.counter, 5, 'the stored counter never moves backwards');
    assert.equal(w.service.credentialsOf('cto')[0]?.state, 'active', 'an anomaly is evidence for an administrator, not an automatic revocation');
    assert.equal((await w.service.finishAuthentication(authenticator.assert(w.service.beginAuthentication(), { counter: 6 }))).credentialId, credential.credentialId);
  });

  it('synced passkeys: never counting (0, 0, 0) is accepted; backup state is recorded; nothing assumes the credential is device-bound', async () => {
    const w = await world();
    const synced = device({ synced: true });
    const { credential } = await enrol(w, synced);
    assert.deepEqual([credential.deviceType, credential.backedUp, credential.counter], ['multiDevice', true, 0]);
    for (let i = 0; i < 3; i += 1) assert.equal((await w.service.finishAuthentication(synced.assert(w.service.beginAuthentication()))).counter, 0);
  });
});

describe('AUTH-02 revocation and recovery', () => {
  it('administrator revocation: durable evidence, immediate refusal, no duplicate, no resurrection after restart', async () => {
    const w = await world();
    const authenticator = device();
    const { credential } = await enrol(w, authenticator);
    const revoked = w.service.revokeCredential(w.admin, credential.credentialId, 'device reported lost');
    assert.deepEqual([revoked.state, revoked.revokedBy, revoked.revocationReason], ['revoked', 'operator-plane:ops-admin', 'device reported lost']);
    assert.ok(revoked.revokedAt !== null);
    await refused('HUMAN_IDENTITY_CREDENTIAL_UNUSABLE', () => w.service.finishAuthentication(authenticator.assert(w.service.beginAuthentication())));
    await refused('HUMAN_IDENTITY_ALREADY_REVOKED', () => w.service.revokeCredential(w.admin, credential.credentialId, 'again'));
    w.store.close();
    const restarted = await openService(w.path, w.clock);
    assert.equal(restarted.service.credentialsOf('cto')[0]?.state, 'revoked');
    await refused('HUMAN_IDENTITY_CREDENTIAL_UNUSABLE', () => restarted.service.finishAuthentication(authenticator.assert(restarted.service.beginAuthentication())));
  });

  it('recovery after device loss: revoke the old passkey, authorize a new enrolment, register a new one', async () => {
    const w = await world();
    const lost = device();
    const { credential } = await enrol(w, lost);
    w.service.revokeCredential(w.admin, credential.credentialId, 'device lost');
    const replacement = device();
    await enrol(w, replacement);
    assert.equal((await w.service.finishAuthentication(replacement.assert(w.service.beginAuthentication()))).operatorId, 'cto');
    await refused('HUMAN_IDENTITY_CREDENTIAL_UNUSABLE', () => w.service.finishAuthentication(lost.assert(w.service.beginAuthentication())));
    assert.deepEqual(w.service.credentialsOf('cto').map((view) => view.state).sort(), ['active', 'revoked']);
  });

  it('owner revocation requires a fresh assertion by the same human, bound to the target credential', async () => {
    const w = await world();
    const phone = device();
    const laptop = device();
    const stranger = device();
    const { credential: target } = await enrol(w, phone);
    const { credential: other } = await enrol(w, laptop);
    await enrol(w, stranger, 'approver-b');
    await refused('HUMAN_IDENTITY_CREDENTIAL_OWNERSHIP_MISMATCH', () => w.service.finishOwnerRevocation(target.credentialId, stranger.assert(w.service.beginOwnerRevocation(target.credentialId)), 'not mine'));
    await refused('HUMAN_IDENTITY_CHALLENGE_INVALID', () => w.service.finishOwnerRevocation(target.credentialId, laptop.assert(w.service.beginOwnerRevocation(other.credentialId)), 'wrong target'));
    await refused('HUMAN_IDENTITY_CHALLENGE_INVALID', () => w.service.finishOwnerRevocation(target.credentialId, laptop.assert(w.service.beginAuthentication()), 'plain login'));
    const revoked = await w.service.finishOwnerRevocation(target.credentialId, laptop.assert(w.service.beginOwnerRevocation(target.credentialId)), 'phone replaced');
    assert.deepEqual([revoked.state, revoked.revokedBy], ['revoked', `owner:${other.credentialId}`]);
    await refused('HUMAN_IDENTITY_CREDENTIAL_UNUSABLE', () => w.service.finishAuthentication(phone.assert(w.service.beginAuthentication())));
  });

  it('a revoked human can neither enrol nor be recognized', async () => {
    const w = await world();
    const authenticator = device();
    await enrol(w, authenticator);
    const pending = w.service.authorizeEnrolment(w.admin, 'cto');
    assert.equal(w.service.revokePrincipal(w.admin, 'cto', 'left the company').state, 'revoked');
    await refused('HUMAN_IDENTITY_ALREADY_REVOKED', () => w.service.revokePrincipal(w.admin, 'cto', 'again'));
    await refused('HUMAN_IDENTITY_CREDENTIAL_UNUSABLE', () => w.service.finishAuthentication(authenticator.assert(w.service.beginAuthentication())));
    await refused('HUMAN_IDENTITY_PRINCIPAL_REVOKED', () => w.service.beginRegistration(pending.enrolmentToken));
    await refused('HUMAN_IDENTITY_PRINCIPAL_REVOKED', () => w.service.authorizeEnrolment(w.admin, 'cto'));
  });
});

describe('AUTH-02 store integrity — durable, verified on every read, minimal at rest', () => {
  it('a tampered or deleted row makes the whole history refuse, at read and at open', async () => {
    const w = await world();
    await enrol(w, device());
    const raw = new Database(w.path);
    raw.exec('DROP TRIGGER human_identity_records_no_update; DROP TRIGGER human_identity_records_no_delete;');
    raw.prepare("UPDATE human_identity_records SET payload = replace(payload, 'Human cto', 'Mallory') WHERE kind = 'principal_created'").run();
    raw.close();
    await refused('HUMAN_IDENTITY_STORE_CORRUPT', () => w.store.history());
    w.store.close();
    await refused('HUMAN_IDENTITY_STORE_CORRUPT', () => openService(w.path, w.clock));

    const v = await world();
    await enrol(v, device());
    const raw2 = new Database(v.path);
    raw2.exec('DROP TRIGGER human_identity_records_no_delete;');
    raw2.prepare("DELETE FROM human_identity_records WHERE kind = 'credential_registered'").run();
    raw2.close();
    await refused('HUMAN_IDENTITY_STORE_CORRUPT', () => v.store.history());
  });

  it('the append-only triggers refuse in-place edits as defense in depth', async () => {
    const w = await world();
    await enrol(w, device());
    const raw = new Database(w.path);
    try {
      assert.throws(() => raw.prepare("UPDATE human_identity_records SET recorded_by = 'x'").run(), /append-only/);
      assert.throws(() => raw.prepare('DELETE FROM human_identity_records').run(), /append-only/);
    } finally {
      raw.close();
    }
  });

  it('cross-organization: a store created for one organization is refused by another; a missing store is never created implicitly', async () => {
    const w = await world();
    w.store.close();
    await refused('HUMAN_IDENTITY_STORE_CORRUPT', () => openService(w.path, w.clock, { organizationId: 'org-other' }));
    await refused('HUMAN_IDENTITY_STORE_UNAVAILABLE', () => openService(join(w.dir, 'absent', 'store.sqlite'), w.clock));
    assert.equal(existsSync(join(w.dir, 'absent')), false);
  });

  it('nothing secret is at rest: no enrolment secret, no private key material', async () => {
    const w = await world();
    const { issued } = await enrol(w, device());
    const secret = issued.enrolmentToken.split('.')[2] ?? 'unreachable';
    w.store.close();
    const bytes = [w.path, `${w.path}-wal`].filter((file) => existsSync(file)).map((file) => readFileSync(file).toString('latin1')).join('');
    assert.equal(bytes.includes(secret), false, 'the enrolment secret is never stored');
    assert.equal(bytes.includes(issued.enrolmentToken), false);
    assert.equal(/PRIVATE KEY|"d":"/.test(bytes), false, 'no private key material');
  });
});
