import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import Database from 'better-sqlite3';

import { bootEnterpriseHost } from '../host/enterprise-host.js';
import { EnterpriseHostConfigurationError } from '../host/host-configuration.js';
import { newAgentCredentialSecret, parseAgentCredential } from '../operator-control/agent-credentials.js';
import { withDeploymentWitness } from './core07-freshness-fixture.js';
import {
  AGENT,
  AGENT_SUBJECT,
  AUTH,
  ISSUER,
  LEGACY_ADMINISTRATORS,
  ORG,
  OWNER,
  SECRETS,
  TRUST_DOMAIN,
  assertNoSecretIn,
  bearer,
  bootCtrl02,
  bootstrapOrganization,
  call,
  create,
  createWorkspace,
  ctrl02Env,
  ctrl02File,
  errorCode,
  expectStatus,
  govern,
  logLines,
  onboardAgent,
  responses,
  transfer,
} from './ctrl02-host-fixture.js';

/**
 * CTRL-02 — the operator plane through the real Host: configuration,
 * compatibility with CTRL-01, separation between every credential class, the
 * HTTP mechanics of the new routes, and the operator-issued agent credential's
 * security properties.
 */

const workspace = createWorkspace('frontera-ctrl02-plane-');
after(() => workspace.close());

async function refusal(file: Record<string, unknown>, env: Record<string, string | undefined> = {}): Promise<EnterpriseHostConfigurationError> {
  const dir = workspace.dir();
  try {
    await bootEnterpriseHost({ env: await withDeploymentWitness(ctrl02Env(dir, file, env)) });
  } catch (error) {
    assert.ok(error instanceof EnterpriseHostConfigurationError, String(error));
    return error;
  }
  assert.fail('expected the Host to refuse to start');
}

describe('CTRL-02 configuration — operators are explicit, server-side, strictly validated, and never a default', () => {
  it('an unknown role, a short secret, an inline secret, a duplicate identity and a reused secret are each refused at boot', async () => {
    const operator = (overrides: Record<string, unknown>) => ctrl02File({ operators: [{ operatorId: 'ops-x', role: 'provisioner', apiKeyEnv: 'FRONTERA_CTRL02_PROVISIONER', ...overrides }] });
    assert.equal((await refusal(operator({ role: 'owner' }))).code, 'HOST_OPERATOR_INVALID');
    assert.equal((await refusal(operator({ role: 'legacy-administrator' }))).code, 'HOST_OPERATOR_INVALID', 'the compatibility class cannot be configured');
    assert.equal((await refusal(operator({ role: 'superuser' }))).code, 'HOST_OPERATOR_INVALID');
    assert.equal((await refusal(operator({}), { FRONTERA_CTRL02_PROVISIONER: 'short' })).code, 'HOST_OPERATOR_INVALID');
    assert.equal((await refusal(operator({ apiKey: SECRETS.provisioner }))).code, 'HOST_GOVERNED_ACTIONS_FILE_INVALID');
    assert.equal((await refusal(operator({ permissions: ['authority.provision'] }))).code, 'HOST_GOVERNED_ACTIONS_FILE_INVALID');
    assert.equal((await refusal(operator({ operatorId: 'ops-legacy' }))).code, 'HOST_OPERATOR_INVALID', 'an operator id is one identity across administrators and operators');
    assert.equal((await refusal(ctrl02File({ operators: [{ operatorId: 'a', role: 'observer', apiKeyEnv: 'FRONTERA_CTRL02_OBSERVER' }, { operatorId: 'a', role: 'provisioner', apiKeyEnv: 'FRONTERA_CTRL02_PROVISIONER' }] }))).code, 'HOST_OPERATOR_INVALID');
    assert.equal((await refusal(operator({ apiKeyEnv: 'FRONTERA_CTRL02_LEGACY_ADMIN' }))).code, 'HOST_CREDENTIALS_AMBIGUOUS', 'one secret, one meaning');
    assert.equal((await refusal(operator({}), { FRONTERA_CTRL02_PROVISIONER: SECRETS.legacyKey.padEnd(40, 'x'), AOC_ENTERPRISE_API_KEYS: `${SECRETS.legacyKey.padEnd(40, 'x')}:${ORG}` })).code, 'HOST_CREDENTIALS_AMBIGUOUS');
    assert.equal((await refusal(ctrl02File({ customerPrincipals: [{ principalId: 'p', externalSubject: { system: 's', subjectId: 'x' }, apiKeyEnv: 'FRONTERA_CTRL02_OBSERVER' }] }))).code, 'HOST_CREDENTIALS_AMBIGUOUS');
  });

  it('without operators a file still needs a static customer principal; a profile lifecycle needs a catalog and someone able to promote it', async () => {
    assert.equal((await refusal(ctrl02File({ operators: undefined }))).code, 'HOST_GOVERNED_ACTIONS_FILE_INVALID');
    assert.equal((await refusal(ctrl02File({ profileLifecycle: 'operator-promoted' }))).code, 'HOST_GOVERNED_ACTIONS_FILE_INVALID');
    assert.equal((await refusal(ctrl02File({ profileLifecycle: 'automatic' }))).code, 'HOST_GOVERNED_ACTIONS_FILE_INVALID');
    assert.equal((await refusal(ctrl02File({ operators: [{ operatorId: 'ops-provisioner', role: 'provisioner', apiKeyEnv: 'FRONTERA_CTRL02_PROVISIONER' }], profileLifecycle: 'operator-promoted' }))).code, 'HOST_OPERATOR_INVALID');
  });

  it('a CTRL-01-only file composes no CTRL-02 surface: the new routes are unmounted, CTRL-01 is unchanged', async () => {
    const booted = await bootCtrl02(
      workspace,
      ctrl02Env(workspace.dir(), ctrl02File({ operators: undefined, customerPrincipals: [{ principalId: 'static-1', externalSubject: { system: 'static', subjectId: 's1' }, apiKeyEnv: 'FRONTERA_CTRL02_STATIC_CUSTOMER' }] })),
    );
    for (const [method, path] of [
      ['GET', '/api/admin/organization'],
      ['GET', '/api/admin/agents'],
      ['GET', '/api/admin/authority/entities'],
      ['POST', '/api/admin/authority/entities/actor'],
      ['GET', '/api/admin/governance-profiles'],
    ] as const) {
      const reply = await call(booted.baseUrl, method, path, { authorization: AUTH.legacyAdministrator, ...(method === 'POST' ? { body: {} } : {}) });
      assert.equal(reply.status, 404, `${method} ${path}`);
      assert.equal(errorCode(reply), 'NOT_FOUND');
    }
    expectStatus(await call(booted.baseUrl, 'GET', '/api/admin/emergency-controls', { authorization: AUTH.legacyAdministrator }), 200, 'CTRL-01 still mounted');
    assert.deepEqual(booted.host.enterprise.configuration.administration, { administratorCount: 1 });
  });
});

describe('CTRL-02 cross-plane separation — every credential reaches exactly its own plane', () => {
  it('customer, legacy, administrator, operator and agent credentials: each refused everywhere but where it belongs', async () => {
    const file = ctrl02File({ customerPrincipals: [{ principalId: 'static-1', externalSubject: { system: 'static-app', subjectId: 'static-1' }, apiKeyEnv: 'FRONTERA_CTRL02_STATIC_CUSTOMER' }] });
    const booted = await bootCtrl02(workspace, ctrl02Env(workspace.dir(), file));
    const { baseUrl } = booted;
    await bootstrapOrganization(baseUrl);
    const agent = await onboardAgent(baseUrl);
    const agentAuth = bearer(agent.credential);

    // Operator plane: only operators (by role) and CTRL-01 administrators (CTRL-01 operations).
    for (const [who, header, status] of [
      ['static customer key', AUTH.staticCustomer, 403],
      ['legacy key', AUTH.legacyKey, 403],
      ['agent credential', agentAuth, 401],
    ] as const) {
      for (const [method, path] of [
        ['GET', '/api/admin/organization'],
        ['GET', '/api/admin/agents'],
        ['POST', '/api/admin/authority/entities/passport'],
        ['GET', '/api/admin/emergency-controls'],
        ['POST', `/api/admin/authority/entities/actor/${AGENT}/revoke`],
      ] as const) {
        const reply = await call(baseUrl, method, path, { authorization: header, ...(method === 'POST' ? { body: { reason: 'x' } } : {}) });
        assert.equal(reply.status, status, `${who} → ${method} ${path}: ${reply.text}`);
      }
    }
    // The CTRL-01 administrator: CTRL-01 yes, CTRL-02 no.
    expectStatus(await call(baseUrl, 'GET', '/api/admin/emergency-controls', { authorization: AUTH.legacyAdministrator }), 200, 'legacy → CTRL-01');
    const legacyProvision = await call(baseUrl, 'POST', '/api/admin/authority/entities/passport', { authorization: AUTH.legacyAdministrator, body: {} });
    assert.equal(legacyProvision.status, 403);
    assert.equal(errorCode(legacyProvision), 'OPERATOR_PERMISSION_DENIED');
    assert.equal((await call(baseUrl, 'GET', '/api/admin/organization', { authorization: AUTH.legacyAdministrator })).status, 403);

    // Customer plane: an operator or administrator credential is not an agent.
    for (const header of [AUTH.administrator, AUTH.provisioner, AUTH.observer, AUTH.legacyAdministrator]) {
      const reply = await call(baseUrl, 'POST', '/api/governed-actions', { authorization: header, body: transfer('10') });
      assert.equal(reply.status, 401, reply.text);
    }
    // A legacy key is a known credential of another plane: 403, exactly as before CTRL-02.
    assert.equal((await call(baseUrl, 'POST', '/api/governed-actions', { authorization: AUTH.legacyKey, body: transfer('10') })).status, 403);
    assert.equal(booted.adapter.calls.length, 0, 'no operator, administrator or legacy credential acted as an agent');
    // The static customer principal keeps working exactly as before (its subject is simply unbound here).
    assert.equal((await call(baseUrl, 'POST', '/api/governed-actions', { authorization: AUTH.staticCustomer, body: transfer('10') })).status, 403);
    // The agent credential works on the governed-action plane …
    assert.equal((await govern(baseUrl, agent.credential, transfer('10'))).body['status'], 'executed');
    // … and on no legacy route.
    for (const [method, path] of [
      ['POST', '/api/governance/evaluate'],
      ['GET', '/api/governance/evaluations/x'],
      ['POST', '/api/passports'],
      ['GET', '/api/evidence/x'],
      ['POST', '/api/assurance/assessments'],
    ] as const) {
      const reply = await call(baseUrl, method, path, { authorization: agentAuth, ...(method === 'POST' ? { body: {} } : {}) });
      assert.equal(reply.status, 401, `agent credential → ${method} ${path}: ${reply.text}`);
    }
    // Operator credentials reach no legacy route either.
    for (const header of [AUTH.administrator, AUTH.observer]) {
      assert.equal((await call(baseUrl, 'POST', '/api/governance/evaluate', { authorization: header, body: {} })).status, 401);
    }
  });
});

describe('CTRL-02 HTTP mechanics — bounded, JSON-only, closed, POST-only for mutations', () => {
  it('malformed JSON, an oversized body, a wrong content type, unknown query parameters and other verbs are refused; nothing is written', async () => {
    const booted = await bootCtrl02(workspace, ctrl02Env(workspace.dir()));
    const { baseUrl } = booted;
    await bootstrapOrganization(baseUrl);
    const malformed = await call(baseUrl, 'POST', '/api/admin/authority/entities/actor', { authorization: AUTH.provisioner, rawBody: '{"actorId": ' });
    assert.equal(malformed.status, 400);
    // An oversized body is cut off by the shared bounded reader: a 400, or the connection closed mid-upload.
    let oversized: number | 'connection-closed';
    try {
      oversized = (await call(baseUrl, 'POST', '/api/admin/authority/entities/actor', { authorization: AUTH.provisioner, rawBody: JSON.stringify({ actorId: 'a', displayName: 'x'.repeat(64 * 1024) }) })).status;
    } catch {
      oversized = 'connection-closed';
    }
    assert.ok(oversized === 400 || oversized === 'connection-closed', String(oversized));
    const wrongType = await call(baseUrl, 'POST', '/api/admin/authority/entities/actor', { authorization: AUTH.provisioner, rawBody: '{}', headers: { 'content-type': 'text/plain' } });
    assert.equal(wrongType.status, 415);
    for (const path of ['/api/admin/agents?organizationId=org-other', '/api/admin/organization?tenant=x', '/api/admin/authority/entities?organizationId=org-other', '/api/admin/governance-profiles?org=x']) {
      assert.equal((await call(baseUrl, 'GET', path, { authorization: AUTH.observer })).status, 400, path);
    }
    for (const method of ['PUT', 'PATCH', 'DELETE']) {
      for (const path of ['/api/admin/authority/entities/actor', `/api/admin/agents/${AGENT}`, `/api/admin/agents/${AGENT}/credentials`, '/api/admin/governance-profiles/p/versions/1/activate']) {
        const reply = await call(baseUrl, method, path, { authorization: AUTH.administrator, body: {} });
        assert.equal(reply.status, 404, `${method} ${path}`);
        assert.equal(errorCode(reply), 'NOT_FOUND');
      }
    }
    for (const path of ['/api/admin/agents/x/credentials', '/api/admin/agents/x/credentials/agc-0/rotate', '/api/admin/governance-profiles/p/versions/1/retire']) {
      assert.equal((await call(baseUrl, 'GET', path, { authorization: AUTH.administrator })).status, 404, `GET ${path}`);
    }
    // There is no route that mints a bounded grant, un-revokes, or deletes.
    for (const path of ['/api/admin/authority/grants', '/api/admin/authority/grants/issue', '/api/admin/authority/entities/actor/x/unrevoke', '/api/admin/authority/entities/actor/x/restore', '/api/admin/agents/x/credentials/agc-x/unrevoke']) {
      assert.equal((await call(baseUrl, 'POST', path, { authorization: AUTH.administrator, body: {} })).status === 200, false, path);
    }
    const bounded = await call(baseUrl, 'POST', '/api/admin/authority/entities/bounded-grant', { authorization: AUTH.administrator, body: {} });
    assert.equal(bounded.status, 400);
    const actors = expectStatus(await call(baseUrl, 'GET', '/api/admin/authority/entities?kind=actor', { authorization: AUTH.observer }), 200, 'list');
    assert.deepEqual((actors.body['entities'] as { entityId: string }[]).map((entity) => entity.entityId), [ISSUER]);
  });

  it('monetary authority over HTTP is checked against the Host’s trusted asset registry before it commits: an unknown asset or an over-scale value is refused', async () => {
    const booted = await bootCtrl02(workspace, ctrl02Env(workspace.dir()));
    const { baseUrl } = booted;
    await bootstrapOrganization(baseUrl);
    await create(baseUrl, AUTH.provisioner, 'actor', { actorId: OWNER, type: 'human', displayName: 'Treasurer', issuerId: ISSUER, trustDomainId: TRUST_DOMAIN });
    const grant = (constraints: unknown): Record<string, unknown> => ({
      authorityGrantId: 'authority-money',
      issuerActorId: ISSUER,
      subjectActorId: OWNER,
      trustDomainId: TRUST_DOMAIN,
      capability: 'payables.manage',
      actions: ['transfer-funds'],
      resourceScopes: ['operating-account'],
      constraints,
    });
    for (const constraints of [[{ type: 'max_amount', currency: 'EUR', value: '100' }], [{ type: 'max_amount', currency: 'USD', value: '100.005' }], [{ type: 'max_amount', currency: 'USD', value: '1e3' }]]) {
      const reply = await call(baseUrl, 'POST', '/api/admin/authority/entities/authority-grant', { authorization: AUTH.provisioner, body: grant(constraints) });
      assert.equal(reply.status, 400, reply.text);
    }
    const listed = expectStatus(await call(baseUrl, 'GET', '/api/admin/authority/entities?kind=authority-grant', { authorization: AUTH.observer }), 200, 'list');
    assert.deepEqual(listed.body['entities'], [], 'nothing committed');
    await create(baseUrl, AUTH.provisioner, 'authority-grant', grant([{ type: 'max_amount', currency: 'USD', value: '100.25' }]));
  });

  it('provisioning idempotency survives a restart: same key + same body replays the original record, different body conflicts', async () => {
    const dir = workspace.dir();
    const env = ctrl02Env(dir);
    const first = await bootCtrl02(workspace, env);
    await bootstrapOrganization(first.baseUrl);
    const body = { actorId: OWNER, type: 'human', displayName: 'Treasurer', issuerId: ISSUER, trustDomainId: TRUST_DOMAIN, idempotencyKey: 'restart-owner-0001' };
    const created = await create(first.baseUrl, AUTH.provisioner, 'actor', body);
    await first.host.close();
    const second = await bootCtrl02(workspace, env);
    const replay = expectStatus(await call(second.baseUrl, 'POST', '/api/admin/authority/entities/actor', { authorization: AUTH.provisioner, body }), 200, 'replay');
    assert.equal(replay.body['outcome'], 'replayed');
    assert.deepEqual(replay.body['entity'], created.body['entity']);
    const conflict = await call(second.baseUrl, 'POST', '/api/admin/authority/entities/actor', { authorization: AUTH.provisioner, body: { ...body, actorId: 'actor-other' } });
    assert.equal(conflict.status, 409);
    assert.equal(errorCode(conflict), 'OPERATOR_IDEMPOTENCY_CONFLICT');
  });
});

describe('CTRL-02 agent credentials — operator-issued, verifier-only, revealed once, rotatable and revocable', () => {
  it('a generated secret is 256 bits of CSPRNG output, distinct every time', () => {
    const seen = new Set<string>();
    for (let index = 0; index < 4096; index += 1) {
      const secret = newAgentCredentialSecret();
      assert.match(secret, /^[A-Za-z0-9_-]{43}$/);
      assert.equal(Buffer.from(secret, 'base64url').length, 32);
      seen.add(secret);
    }
    assert.equal(seen.size, 4096);
  });

  it('revealed once; never on a list, a read, a replay or a log line; stored as a verifier that does not authenticate', async () => {
    const dir = workspace.dir();
    const env = ctrl02Env(dir);
    const booted = await bootCtrl02(workspace, env);
    const { baseUrl } = booted;
    await bootstrapOrganization(baseUrl);
    const agent = await onboardAgent(baseUrl);
    const parts = parseAgentCredential(agent.credential);
    assert.ok(parts !== undefined);

    // Replay of the issuing request: the same credential's metadata, never its secret.
    const replay = expectStatus(await call(baseUrl, 'POST', `/api/admin/agents/${AGENT}/credentials`, { authorization: AUTH.provisioner, body: { idempotencyKey: `issue-${AGENT}` } }), 200, 'replay');
    assert.equal(replay.body['outcome'], 'replayed');
    assert.equal(replay.body['bearerCredential'], null);
    assert.equal((replay.body['credential'] as Record<string, unknown>)['credentialId'], parts.credentialId);
    // Same key, another request: conflict.
    await create(baseUrl, AUTH.provisioner, 'actor', { actorId: 'actor-second-agent', type: 'agent', displayName: 'Second', issuerId: ISSUER, trustDomainId: TRUST_DOMAIN, externalSubject: { system: 'pilot-erp', subjectId: 'second' } });
    const conflict = await call(baseUrl, 'POST', '/api/admin/agents/actor-second-agent/credentials', { authorization: AUTH.provisioner, body: { idempotencyKey: `issue-${AGENT}` } });
    assert.equal(conflict.status, 409);
    assert.equal(errorCode(conflict), 'OPERATOR_IDEMPOTENCY_CONFLICT');

    for (const path of ['/api/admin/agents', `/api/admin/agents/${AGENT}`]) {
      const read = expectStatus(await call(baseUrl, 'GET', path, { authorization: AUTH.observer }), 200, path);
      assert.equal(read.text.includes(parts.secret), false, `${path} carries no secret`);
      assert.equal(/verifier|credentialHash|secret/i.test(read.text), false, `${path} carries no verifier`);
    }
    for (const line of logLines) assertNoSecretIn(line, 'the Host log', [parts.secret]);

    // At rest: the SHA-256 verifier, never the secret.
    await booted.host.close();
    const db = new Database(join(dir, 'control-plane.sqlite'), { readonly: true });
    const rows = db.prepare('SELECT credential_id, verifier, status FROM agent_credentials').all() as { credential_id: string; verifier: string; status: string }[];
    db.close();
    const row = rows.find((candidate) => candidate.credential_id === parts.credentialId);
    assert.ok(row !== undefined);
    assert.equal(row.verifier, createHash('sha256').update(parts.secret, 'utf8').digest('hex'));
    for (const file of ['control-plane.sqlite', 'control-plane.sqlite-wal']) {
      try {
        assert.equal(readFileSync(join(dir, file)).includes(Buffer.from(parts.secret)), false, `${file} holds no secret`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    const reopened = await bootCtrl02(workspace, env);
    // The verifier presented as a credential authenticates nothing.
    for (const presented of [row.verifier, `fra1.${parts.credentialId}.${row.verifier}`, `fra1.${parts.credentialId}.${row.verifier.slice(0, 43)}`]) {
      assert.equal((await govern(reopened.baseUrl, presented, transfer('10'))).status, 401);
    }
    // A wrong secret, another id, a malformed token: 401.
    const wrong = `fra1.${parts.credentialId}.${parts.secret.slice(0, -1)}${parts.secret.endsWith('A') ? 'B' : 'A'}`;
    for (const presented of [wrong, `fra1.agc-${'0'.repeat(32)}.${parts.secret}`, agent.credential.replace('fra1.', 'fra2.'), agent.credential.replace('agc-', 'AGC-')]) {
      assert.equal((await govern(reopened.baseUrl, presented, transfer('10'))).status, 401, presented.slice(0, 20));
    }
    // And the real one still works after restart.
    assert.equal((await govern(reopened.baseUrl, agent.credential, transfer('10'))).body['status'], 'executed');
    for (const text of responses) assert.equal(text.includes(row.verifier), false, 'no response carries a verifier');
  });

  it('rotation invalidates the old credential in the same transaction; revocation is terminal; neither touches the actor', async () => {
    const dir = workspace.dir();
    const env = ctrl02Env(dir);
    const booted = await bootCtrl02(workspace, env);
    const { baseUrl } = booted;
    await bootstrapOrganization(baseUrl);
    const agent = await onboardAgent(baseUrl);
    assert.equal((await govern(baseUrl, agent.credential, transfer('10'))).body['status'], 'executed');

    const rotated = expectStatus(
      await call(baseUrl, 'POST', `/api/admin/agents/${AGENT}/credentials/${agent.credentialId}/rotate`, { authorization: AUTH.provisioner, body: { idempotencyKey: 'rotate-0001' } }),
      200,
      'rotate',
    );
    const next = rotated.body['bearerCredential'] as string;
    assert.equal((rotated.body['replaced'] as Record<string, unknown>)['status'], 'revoked');
    assert.equal((rotated.body['credential'] as Record<string, unknown>)['replacesCredentialId'], agent.credentialId);
    assert.equal((await govern(baseUrl, agent.credential, transfer('10'))).status, 401, 'the rotated-out credential is dead');
    assert.equal((await govern(baseUrl, next, transfer('10'))).body['status'], 'executed');
    // A rotated-out credential cannot be rotated again (or resurrected by retrying a rotation with a new key).
    const again = await call(baseUrl, 'POST', `/api/admin/agents/${AGENT}/credentials/${agent.credentialId}/rotate`, { authorization: AUTH.provisioner, body: { idempotencyKey: 'rotate-0002' } });
    assert.equal(again.status, 409);
    // Concurrent issuance under one key: exactly one credential.
    await create(baseUrl, AUTH.provisioner, 'actor', { actorId: 'actor-burst', type: 'agent', displayName: 'Burst', issuerId: ISSUER, trustDomainId: TRUST_DOMAIN, externalSubject: { system: 'pilot-erp', subjectId: 'burst' } });
    const burst = await Promise.all(Array.from({ length: 6 }, () => call(baseUrl, 'POST', '/api/admin/agents/actor-burst/credentials', { authorization: AUTH.provisioner, body: { idempotencyKey: 'burst-0001' } })));
    assert.equal(burst.filter((reply) => reply.body['outcome'] === 'issued').length, 1);
    assert.equal(burst.filter((reply) => reply.body['outcome'] === 'replayed').length, 5);
    assert.equal(((await call(baseUrl, 'GET', '/api/admin/agents/actor-burst', { authorization: AUTH.observer })).body['credentials'] as unknown[]).length, 1);

    // Revocation of the credential — by a responder — is terminal and distinct from actor revocation.
    const nextId = (rotated.body['credential'] as Record<string, unknown>)['credentialId'] as string;
    const revoke = expectStatus(await call(baseUrl, 'POST', `/api/admin/agents/${AGENT}/credentials/${nextId}/revoke`, { authorization: AUTH.responder, body: { reason: 'credential leaked' } }), 200, 'revoke');
    assert.equal(revoke.body['outcome'], 'revoked');
    assert.equal((revoke.body['credential'] as Record<string, unknown>)['revokedBy'], 'operator:ops-responder');
    assert.equal((await govern(baseUrl, next, transfer('10'))).status, 401);
    assert.equal((await call(baseUrl, 'POST', `/api/admin/agents/${AGENT}/credentials/${nextId}/revoke`, { authorization: AUTH.responder, body: { reason: 'again' } })).body['outcome'], 'already-revoked');
    const view = expectStatus(await call(baseUrl, 'GET', `/api/admin/agents/${AGENT}`, { authorization: AUTH.observer }), 200, 'agent');
    assert.equal(view.body['status'], 'active', 'revoking a credential does not revoke the actor');
    assert.equal((view.body['onboarding'] as Record<string, unknown>)['credential'], 'none');
    // An observer cannot issue; a responder cannot issue; the CTRL-01 administrator cannot issue.
    for (const header of [AUTH.observer, AUTH.responder, AUTH.legacyAdministrator, AUTH.steward]) {
      assert.equal((await call(baseUrl, 'POST', `/api/admin/agents/${AGENT}/credentials`, { authorization: header, body: { idempotencyKey: 'not-allowed-01' } })).status, 403);
    }
    // A fresh credential restores the agent's access — under the same, still-active actor.
    const reissued = expectStatus(await call(baseUrl, 'POST', `/api/admin/agents/${AGENT}/credentials`, { authorization: AUTH.provisioner, body: { idempotencyKey: 'reissue-0001' } }), 200, 'reissue');
    assert.equal((await govern(baseUrl, reissued.body['bearerCredential'] as string, transfer('10'))).body['status'], 'executed');

    // The database itself refuses an un-revoke and a delete.
    await booted.host.close();
    const db = new Database(join(dir, 'control-plane.sqlite'));
    try {
      assert.throws(() => db.prepare(`UPDATE agent_credentials SET status = 'active', revoked_by = NULL, revoked_at = NULL, revocation_reason = NULL WHERE credential_id = ?`).run(nextId), /changes only from active to revoked/);
      assert.throws(() => db.prepare(`DELETE FROM agent_credentials WHERE credential_id = ?`).run(nextId), /never deleted/);
      assert.throws(() => db.prepare(`UPDATE agent_principals SET actor_id = 'actor-other'`).run(), /immutable/);
    } finally {
      db.close();
    }
  });

  it('a credential is never issued for a non-agent, an unknown actor, a revoked actor or a statically configured subject', async () => {
    const file = ctrl02File({ customerPrincipals: [{ principalId: 'static-1', externalSubject: { system: 'static-app', subjectId: 'static-1' }, apiKeyEnv: 'FRONTERA_CTRL02_STATIC_CUSTOMER' }] });
    const booted = await bootCtrl02(workspace, ctrl02Env(workspace.dir(), file));
    const { baseUrl } = booted;
    await bootstrapOrganization(baseUrl);
    await create(baseUrl, AUTH.provisioner, 'actor', { actorId: OWNER, type: 'human', displayName: 'Owner', issuerId: ISSUER, trustDomainId: TRUST_DOMAIN });
    await create(baseUrl, AUTH.provisioner, 'actor', { actorId: 'actor-static', type: 'agent', displayName: 'Static', issuerId: ISSUER, trustDomainId: TRUST_DOMAIN, externalSubject: { system: 'static-app', subjectId: 'static-1' } });
    await create(baseUrl, AUTH.provisioner, 'actor', { actorId: 'actor-no-subject', type: 'agent', displayName: 'No subject', issuerId: ISSUER, trustDomainId: TRUST_DOMAIN });
    await create(baseUrl, AUTH.provisioner, 'actor', { actorId: AGENT, type: 'agent', displayName: 'Agent', issuerId: ISSUER, trustDomainId: TRUST_DOMAIN, externalSubject: AGENT_SUBJECT });
    expectStatus(await call(baseUrl, 'POST', `/api/admin/authority/entities/actor/${AGENT}/revoke`, { authorization: AUTH.responder, body: { reason: 'gone' } }), 200, 'revoke');
    for (const [actorId, status] of [
      [OWNER, 404],
      ['actor-missing', 404],
      [AGENT, 409],
      ['actor-static', 409],
      ['actor-no-subject', 409],
    ] as const) {
      const reply = await call(baseUrl, 'POST', `/api/admin/agents/${actorId}/credentials`, { authorization: AUTH.provisioner, body: { idempotencyKey: `deny-${actorId}` } });
      assert.equal(reply.status, status, `${actorId}: ${reply.text}`);
    }
  });
});
