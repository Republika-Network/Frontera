import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  assessGrantExercise,
  boundedGrantDigest,
  boundedGrantId,
  type BoundedGrant,
  type GrantRevocation,
  type ReadBoundedGrantResult,
} from '../../features/grant-runtime/index.js';
import { EnterpriseHttpError } from '../api/enterprise-http-errors.js';
import { createAuthorityAdministrationService, type AuthorityAdministrationDependencies } from '../authority-administration/service.js';
import { validateAuthorityEntityRevocationRequest, validateEmergencyControlTarget, validateGrantRevocationRequest } from '../authority-administration/contracts.js';
import { BoundedGrantStoreError } from '../bounded-grant-store/errors.js';
import type { RevokeBoundedGrantRequest } from '../execution-governance/service.js';

/**
 * CTRL-01 — the authority administration service, below HTTP.
 *
 * What is proved here needs a fixed clock or a failure a real store cannot be
 * made to produce on demand: status derived by the grant runtime's own
 * assessment (including expiry), fail-closed integrity mapping, the closed
 * request schemas, the credential split, and the structural no-bypass rules.
 * Everything else is proved through the real Host in
 * `authority-administration-api.test.ts`.
 */

const ADMIN_SECRET = 'CTRL01_UNIT_ADMIN_SECRET_0123456789abcdef';
const ORDINARY_SECRET = 'CTRL01_UNIT_ORDINARY_SECRET_0123456789abcd';
const ISSUED_AT = '2026-09-26T10:00:00.000Z';
const EXPIRES_AT = '2026-09-26T10:05:00.000Z';

function grant(overrides: Partial<Omit<BoundedGrant, 'id' | 'digest'>> = {}): BoundedGrant {
  const body = {
    correlation: { requestId: 'aoc.gar:req-1', decisionId: 'decision-1', action: 'invoice.approve', resourceScope: 'resource-ledger-1' },
    subject: 'actor-agent',
    scope: { action: { kind: 'identity', value: 'invoice.approve' }, resources: { kind: 'set', values: ['resource-ledger-1'] } },
    issuedAt: ISSUED_AT,
    expiresAt: EXPIRES_AT,
    sourceDigest: 'sha256:source',
    ...overrides,
  } as Omit<BoundedGrant, 'id' | 'digest'>;
  const id = boundedGrantId({ correlation: body.correlation, subject: body.subject, scope: body.scope, expiresAt: body.expiresAt });
  const withId = { ...body, id };
  return { ...withId, digest: boundedGrantDigest(withId) };
}

interface Harness {
  readonly service: ReturnType<typeof createAuthorityAdministrationService>;
  readonly revokes: RevokeBoundedGrantRequest[];
  clock: string;
}

function harness(read: (grantId: string) => Promise<ReadBoundedGrantResult>, overrides: Partial<AuthorityAdministrationDependencies> = {}): Harness {
  const revokes: RevokeBoundedGrantRequest[] = [];
  const state: Harness = { service: undefined as never, revokes, clock: '2026-09-26T10:01:00.000Z' };
  const service = createAuthorityAdministrationService({
    administrators: [{ operatorId: 'ops-1', key: ADMIN_SECRET }],
    ordinaryCredentials: [{ key: ORDINARY_SECRET, organizationId: 'org-acme' }],
    organizationId: 'org-acme',
    now: () => state.clock,
    isReady: () => true,
    lifecycleState: () => 'ready',
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    grants: {
      reader: { read },
      revoke: async (input) => {
        revokes.push(input);
        return { outcome: 'revoked', revocation: { grantId: input.grantId, reason: input.reason, issuerRef: input.issuerRef, revokedAt: input.revokedAt ?? state.clock } };
      },
    },
    ...overrides,
  });
  return Object.assign(state, { service });
}

async function httpError(promise: Promise<unknown>): Promise<EnterpriseHttpError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof EnterpriseHttpError, `expected an EnterpriseHttpError, got ${String(error)}`);
    return error;
  }
  assert.fail('expected the administration call to be refused');
}

const admin = `Bearer ${ADMIN_SECRET}`;
const ordinary = `Bearer ${ORDINARY_SECRET}`;
const body = (value: unknown) => async () => value;

describe('CTRL-01 service — status is the grant runtime\'s own assessment, never an HTTP-layer algorithm', () => {
  it('an active grant reads exercisable; the same grant after its expiry (fixed clock, no sleep) reads unusable/GRANT_EXPIRED', async () => {
    const issued = grant();
    const h = harness(async () => ({ grant: issued }));
    const before = await h.service.inspectGrant(admin, issued.id);
    assert.deepEqual(before.status, { eligibility: 'exercisable', reasonCodes: [], assessedAt: '2026-09-26T10:01:00.000Z' });
    assert.equal(before.revocation, null);

    h.clock = EXPIRES_AT;
    const after = await h.service.inspectGrant(admin, issued.id);
    assert.equal(after.status.eligibility, 'unusable');
    assert.deepEqual(after.status.reasonCodes, ['GRANT_EXPIRED']);
    // Identical to what the exercise path's assessment says at the same instant.
    assert.deepEqual(after.status.reasonCodes, assessGrantExercise({ grant: issued, at: EXPIRES_AT }).reasonCodes);
  });

  it('a revoked and expired grant reports both reasons, and the revocation as stored', async () => {
    const issued = grant();
    const revocation: GrantRevocation = { grantId: issued.id, revokedAt: '2026-09-26T10:02:00.000Z', reason: 'security-incident', issuerRef: 'operator:ops-1' };
    const h = harness(async () => ({ grant: issued, revocation }));
    h.clock = '2026-09-26T11:00:00.000Z';
    const view = await h.service.inspectGrant(admin, issued.id);
    assert.deepEqual(view.status.reasonCodes, ['GRANT_REVOKED', 'GRANT_EXPIRED']);
    assert.deepEqual(view.revocation, { revokedAt: '2026-09-26T10:02:00.000Z', reason: 'security-incident', revokedBy: 'operator:ops-1' });
  });

  it('the response is a DTO: no digest, source digest, signature or internal field is serialized', async () => {
    const issued = grant();
    const h = harness(async () => ({ grant: issued }));
    const text = JSON.stringify(await h.service.inspectGrant(admin, issued.id));
    for (const leaked of [issued.digest, 'sha256:source', '"digest"', 'sourceDigest', 'signature', 'correlation"']) {
      assert.equal(text.includes(leaked), false, `the grant view must not carry ${leaked}`);
    }
  });
});

describe('CTRL-01 service — unverifiable state fails closed, never as absent or active', () => {
  it('a grant whose own digest does not match its fields is an integrity failure, not a status', async () => {
    const issued = grant();
    const tampered: BoundedGrant = { ...issued, subject: 'actor-attacker' };
    const error = await httpError(harness(async () => ({ grant: tampered })).service.inspectGrant(admin, issued.id));
    assert.equal(error.httpStatus, 500);
    assert.equal(error.code, 'AUTHORITY_STATE_INTEGRITY_FAILED');
  });

  for (const code of ['BOUNDED_GRANT_STORE_STATE_CORRUPT', 'BOUNDED_GRANT_STORE_AUTHENTICITY_FAILED', 'BOUNDED_GRANT_STORE_REVOCATION_STATE_INCONSISTENT'] as const) {
    it(`${code} → 500 AUTHORITY_STATE_INTEGRITY_FAILED, on read and on revoke; never 404, never success`, async () => {
      const failing = async (): Promise<never> => {
        throw new BoundedGrantStoreError(code, 'redacted');
      };
      const h = harness(failing, {
        grants: {
          reader: { read: failing },
          revoke: failing,
        },
      });
      const read = await httpError(h.service.inspectGrant(admin, grant().id));
      assert.equal(read.httpStatus, 500);
      assert.equal(read.code, 'AUTHORITY_STATE_INTEGRITY_FAILED');
      assert.deepEqual(read.extra, { failure: code });
      const revoke = await httpError(h.service.revokeGrant(admin, grant().id, body({ reason: 'security-incident' })));
      assert.equal(revoke.code, 'AUTHORITY_STATE_INTEGRITY_FAILED');
    });
  }

  it('an unavailable store is 503, not 404', async () => {
    const error = await httpError(
      harness(async () => {
        throw new BoundedGrantStoreError('BOUNDED_GRANT_STORE_UNAVAILABLE', 'closed');
      }).service.inspectGrant(admin, grant().id),
    );
    assert.equal(error.httpStatus, 503);
    assert.equal(error.code, 'AUTHORITY_STATE_UNAVAILABLE');
  });
});

describe('CTRL-01 service — authentication is not administrative authority', () => {
  it('no header, a malformed header, an unknown secret → 401; an ordinary credential → 403; nothing is read or revoked', async () => {
    let reads = 0;
    const h = harness(async () => {
      reads += 1;
      return { grant: grant() };
    });
    for (const header of [undefined, '', 'Basic abc', `Bearer ${ADMIN_SECRET.slice(0, -1)}`, 'Bearer admin']) {
      const error = await httpError(h.service.revokeGrant(header, grant().id, body({ reason: 'security-incident' })));
      assert.equal(error.httpStatus, 401, String(header));
    }
    const forbidden = await httpError(h.service.revokeGrant(ordinary, grant().id, body({ reason: 'security-incident' })));
    assert.equal(forbidden.httpStatus, 403);
    assert.equal(forbidden.code, 'AUTHORIZATION_FAILED');
    assert.equal((await httpError(h.service.inspectGrant(ordinary, grant().id))).httpStatus, 403);
    assert.equal(reads, 0);
    assert.equal(h.revokes.length, 0);
  });

  it('the body is not read until the caller is an administrator', async () => {
    let bodyReads = 0;
    const reader = async () => {
      bodyReads += 1;
      return { reason: 'security-incident' };
    };
    const h = harness(async () => ({ grant: grant() }));
    await httpError(h.service.revokeGrant(undefined, grant().id, reader));
    await httpError(h.service.revokeGrant(ordinary, grant().id, reader));
    assert.equal(bodyReads, 0);
  });

  it('the recorded actor is the configured operator, whatever the request says', async () => {
    const h = harness(async () => ({ grant: grant() }));
    const result = await h.service.revokeGrant(admin, grant().id, body({ reason: 'security-incident' }));
    assert.equal(result.revocation.revokedBy, 'operator:ops-1');
    assert.deepEqual(h.revokes.map((input) => input.issuerRef), ['operator:ops-1']);
  });

  it('a Host that is not ready refuses administrators with 503 and does nothing', async () => {
    const h = harness(async () => ({ grant: grant() }), { isReady: () => false, lifecycleState: () => 'stopping' });
    const error = await httpError(h.service.revokeGrant(admin, grant().id, body({ reason: 'security-incident' })));
    assert.equal(error.httpStatus, 503);
    assert.equal(h.revokes.length, 0);
  });

  it('a capability the Host did not compose is a precise 404, never a fallback', async () => {
    const bare = createAuthorityAdministrationService({
      administrators: [{ operatorId: 'ops-1', key: ADMIN_SECRET }],
      ordinaryCredentials: [],
      organizationId: 'org-acme',
      now: () => ISSUED_AT,
      isReady: () => true,
      lifecycleState: () => 'ready',
      logger: { debug() {}, info() {}, warn() {}, error() {} },
    });
    for (const call of [bare.inspectGrant(admin, grant().id), bare.listEmergencyControls(admin), bare.inspectAuthorityEntity(admin, 'actor', 'actor-agent'), bare.inspectExecutionGrant(admin, 'x')]) {
      const error = await httpError(call);
      assert.equal(error.httpStatus, 404);
      assert.equal(error.code, 'AUTHORITY_ADMIN_CAPABILITY_NOT_COMPOSED');
    }
  });

  it('refuses to compose with no administrator', () => {
    assert.throws(() => harness(async () => ({}), { administrators: [] }));
  });
});

describe('CTRL-01 contracts — closed request schemas (mass-assignment defense)', () => {
  const smuggled = ['admin', 'role', 'operator', 'operatorId', 'actor', 'issuerRef', 'revokedBy', 'administrator', 'organizationId', 'tenantId', 'authorized', 'permissions', 'revokedAt', 'signature', 'grantId'];

  for (const field of smuggled) {
    it(`a revocation body carrying '${field}' is refused`, () => {
      assert.throws(() => validateGrantRevocationRequest({ reason: 'security-incident', [field]: 'x' }), (error: unknown) => error instanceof EnterpriseHttpError && error.httpStatus === 400);
      assert.throws(() => validateAuthorityEntityRevocationRequest({ reason: 'offboarded', [field]: 'x' }), (error: unknown) => error instanceof EnterpriseHttpError && error.httpStatus === 400);
      assert.throws(() => validateEmergencyControlTarget({ scope: 'global', [field]: 'x' }), (error: unknown) => error instanceof EnterpriseHttpError && error.httpStatus === 400);
    });
  }

  it('grant revocation reasons come from the closed vocabulary; entity reasons are bounded text', () => {
    assert.throws(() => validateGrantRevocationRequest({ reason: 'because' }));
    assert.throws(() => validateGrantRevocationRequest({}));
    assert.throws(() => validateGrantRevocationRequest([]));
    assert.throws(() => validateAuthorityEntityRevocationRequest({ reason: '' }));
    assert.throws(() => validateAuthorityEntityRevocationRequest({ reason: 'x'.repeat(513) }));
    assert.throws(() => validateAuthorityEntityRevocationRequest({ reason: 'line\nbreak' }));
    assert.deepEqual(validateAuthorityEntityRevocationRequest({ reason: 'offboarded' }), { reason: 'offboarded' });
  });

  it('emergency controls: global takes no value, every other scope needs one, and the inert workflow scope is refused', () => {
    assert.deepEqual(validateEmergencyControlTarget({ scope: 'global' }), { scope: 'global' });
    assert.throws(() => validateEmergencyControlTarget({ scope: 'global', value: 'x' }));
    assert.throws(() => validateEmergencyControlTarget({ scope: 'actor' }));
    assert.throws(() => validateEmergencyControlTarget({ scope: 'workflow', value: 'wf-1' }));
    assert.throws(() => validateEmergencyControlTarget({ scope: 'everything' }));
    assert.deepEqual(validateEmergencyControlTarget({ scope: 'actor', value: 'actor-agent' }), { scope: 'actor', value: 'actor-agent' });
  });

  it('malformed grant ids are refused before any read', async () => {
    let reads = 0;
    const h = harness(async () => {
      reads += 1;
      return {};
    });
    for (const id of ['', 'grant-1', 'aoc.grant:XYZ', `aoc.grant:${'a'.repeat(31)}`, `aoc.grant:${'a'.repeat(33)}`, `../aoc.grant:${'a'.repeat(32)}`]) {
      assert.equal((await httpError(h.service.inspectGrant(admin, id))).httpStatus, 400, id);
    }
    assert.equal(reads, 0);
  });
});

// -- structural no-bypass --------------------------------------------------------

/** Source without comments, so a rule is about code and never about prose. */
function codeOf(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .map((line) => line.replace(/^\s*\/\/.*$/, '').replace(/\s\/\/\s.*$/, ''))
    .join('\n');
}

const MODULE_FILES = ['src/enterprise/authority-administration/service.ts', 'src/enterprise/authority-administration/contracts.ts', 'src/enterprise/authority-administration/index.ts'];

describe('CTRL-01 structure — the administration layer has no path around the authoritative services', () => {
  it('imports no database driver, no SQLite implementation, no signer or key material', () => {
    for (const file of MODULE_FILES) {
      const imports = [...codeOf(file).matchAll(/from '([^']+)'/g)].map((match) => match[1] ?? '');
      for (const specifier of imports) {
        assert.equal(/better-sqlite3|sqlite|authority-authenticity|signer|signing|node:crypto|node:fs/.test(specifier), false, `${file} must not import '${specifier}'`);
      }
    }
  });

  it('contains no SQL and never calls an issue, provision, sign or un-revoke operation', () => {
    for (const file of MODULE_FILES) {
      const code = codeOf(file);
      assert.equal(/\b(INSERT|UPDATE|DELETE)\b\s+(INTO|FROM|\w+\s+SET)/i.test(code), false, `${file} must hold no SQL`);
      for (const call of [/\.issue\(/, /\.provision\w*\(/, /\.sign\(/, /\bunrevoke|un-revoke|reinstate|restoreGrant|deleteRevocation/i, /issueFromDecision|issueGrant/]) {
        assert.equal(call.test(code), false, `${file} must not match ${String(call)}`);
      }
    }
  });

  it('never spreads a request body into anything', () => {
    for (const file of MODULE_FILES) {
      const code = codeOf(file);
      assert.equal(/\.\.\.\s*(raw|body|rawBody|request|input)\b/.test(code), false, `${file} must not spread request data`);
    }
  });

  it('the service surface is exactly inspect, revoke and emergency control — no issuance, no provisioning, no un-revoke', () => {
    const h = harness(async () => ({}));
    assert.deepEqual(Object.keys(h.service).sort(), [
      'activateEmergencyControl',
      'inspectAuthorityEntity',
      'inspectExecutionGrant',
      'inspectGrant',
      'listEmergencyControls',
      'releaseEmergencyControl',
      'revokeAuthorityEntity',
      'revokeGrant',
    ]);
    assert.ok(Object.isFrozen(h.service));
  });

  it('the HTTP adapter mounts administration only through the service, with GET for reads and POST for the three verbs', () => {
    const adapter = codeOf('src/enterprise/adapters/node-http-adapter.ts');
    const section = /function matchAdministrationRoute[\s\S]*?\n}\n/.exec(adapter)?.[0] ?? '';
    assert.ok(section.length > 0, 'the administration route matcher exists');
    // The literal last segment of every administration path: the revoke verb, and the read-only list.
    const suffixes = [...section.matchAll(/\\\/([a-z-]+)\$/g)].map((match) => match[1]);
    for (const suffix of suffixes) assert.ok(['revoke', 'emergency-controls'].includes(suffix ?? ''), `unexpected route suffix '${String(suffix)}'`);
    // The only alternation of verbs is the emergency-control transition pair.
    assert.deepEqual([...section.matchAll(/\(([a-z]+(?:\|[a-z]+)+)\)\$/g)].map((match) => match[1]), ['activate|release']);
    assert.equal(/'(PUT|PATCH|DELETE)'/.test(section), false, 'no PUT, PATCH or DELETE administration route');
    assert.equal(/unrevoke|restore|reactivate|reinstate|issue|provision/i.test(section), false);
    assert.equal(/emergencyControlAdministration|kernelAuthorityProvisioning|authorityControlledExecution/.test(adapter), false, 'the adapter reaches no operator surface directly');
  });
});
