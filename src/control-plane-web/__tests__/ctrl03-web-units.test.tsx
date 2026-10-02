import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { decisionDownstream, lifecycleTransitions } from '../activity.js';
import { createConsoleApp, statusForFailure } from '../app.js';
import { classifyHostFailure, FAILURE_GUIDANCE, type HostFailure } from '../failures.js';
import { buildParameterBounds, buildProvisionRequest, ENTITY_FORM_SPECS, parseStrictInteger } from '../forms.js';
import { createHostClient, type HostClient, type HostResult } from '../host-client.js';
import { CONTENT_SECURITY_POLICY, cookieNames, FormFields, REFERRER_POLICY, securityHeaders, setCookie, SESSION_COOKIE } from '../security.js';
import { createSessionStore, tokensEqual } from '../session.js';
import { shapes, type AgentView, type DecisionEvidence, type EntityView, type OrganizationContext, type ProfileVersion } from '../wire.js';
import { FailureNotice } from '../views/components.js';
import { AgentPage } from '../views/pages-agents.js';
import { CredentialIssuedPage } from '../views/pages-core.js';
import { EvidencePage } from '../views/pages-records.js';
import { navigationHeaders } from './web-browser.js';

/**
 * CTRL-03 — the web control plane's pure layers: failure taxonomy, closed and
 * strict form serialization, sessions, the activity projection, rendered
 * views, and the request handler against a scripted Host.
 */

const form = (entries: Record<string, string>): FormFields => new FormFields(new URLSearchParams(entries));

describe('CTRL-03 web — the failure taxonomy never turns a refusal into success or a recorded write into "nothing changed"', () => {
  const envelope = (code: string, extra: Record<string, unknown> = {}): unknown => ({ error: { code, message: 'm', ...extra } });

  it('each Host status maps to exactly one kind', () => {
    assert.equal(classifyHostFailure(401, envelope('AUTHENTICATION_FAILED')).kind, 'unauthenticated');
    assert.equal(classifyHostFailure(403, envelope('OPERATOR_PERMISSION_DENIED')).kind, 'unauthorized');
    assert.equal(classifyHostFailure(400, envelope('INVALID_REQUEST')).kind, 'validation');
    assert.equal(classifyHostFailure(415, envelope('INVALID_REQUEST')).kind, 'validation');
    assert.equal(classifyHostFailure(404, envelope('AUTHORITY_ADMIN_TARGET_NOT_FOUND')).kind, 'not-found');
    assert.equal(classifyHostFailure(409, envelope('OPERATOR_IDEMPOTENCY_CONFLICT', { recorded: false })).kind, 'idempotency-conflict');
    assert.equal(classifyHostFailure(409, envelope('OPERATOR_OPERATION_REFUSED', { failure: 'PARAMETER_BOUND_WIDENED', recorded: false })).kind, 'refused');
    assert.equal(classifyHostFailure(500, envelope('AUTHORITY_STATE_INTEGRITY_FAILED')).kind, 'integrity-failed');
    assert.equal(classifyHostFailure(500, envelope('INFRASTRUCTURE_FAILURE')).kind, 'unknown');
    assert.equal(classifyHostFailure(502, undefined).kind, 'unknown');
  });

  it('only an explicit recorded:true makes a 503 a recorded write; any other 503 is unknown-for-a-write, never "unwritten"', () => {
    const recorded = classifyHostFailure(503, envelope('AUTHORITY_STATE_REFRESH_FAILED', { recorded: true, retry: 'same-request' }));
    assert.equal(recorded.kind, 'recorded-refresh-failed');
    assert.equal(recorded.recorded, true);
    assert.equal(classifyHostFailure(503, envelope('AUTHORITY_STATE_REFRESH_FAILED')).kind, 'unavailable');
    assert.equal(classifyHostFailure(503, envelope('AUTHORITY_STATE_UNAVAILABLE')).kind, 'unavailable');
    const guidance = FAILURE_GUIDANCE['recorded-refresh-failed'].guidance;
    assert.match(guidance, /WAS durably recorded/);
    assert.match(guidance, /Retry the SAME request/);
    assert.doesNotMatch(guidance, /Nothing was written|nothing changed/i);
    assert.doesNotMatch(FAILURE_GUIDANCE.unavailable.guidance, /Nothing was written/i, 'an unavailable write is unknown, not unwritten');
    const html = renderToStaticMarkup(<FailureNotice failure={recorded} />);
    assert.match(html, /The Host states this write was recorded\./);
    assert.match(html, /data-failure-kind="recorded-refresh-failed"/);
  });

  it('the console’s own status for a failure is never 2xx or 3xx', () => {
    for (const kind of Object.keys(FAILURE_GUIDANCE) as HostFailure['kind'][]) {
      const status = statusForFailure({ kind, status: 0, code: null, message: '', failure: null, recorded: null });
      assert.ok(status >= 400, `${kind} → ${status}`);
    }
  });
});

describe('CTRL-03 web — closed provisioning forms serialize exactly the canonical DTO', () => {
  it('a typed bound is an integer only as typed: no fraction, sign, leading zero, exponent or unsafe value', () => {
    assert.equal(parseStrictInteger('3'), 3);
    assert.equal(parseStrictInteger('-2'), -2);
    for (const raw of ['3.0', '+3', '03', '3e0', '0x3', '', ' 3', '9007199254740993', '-0', '3 ', 'three']) assert.equal(parseStrictInteger(raw), undefined, raw);
  });

  it('bound rows become canonical CORE-03 bounds; a half-filled row is an error, never silently dropped', () => {
    const errors: Record<string, string> = {};
    const bounds = buildParameterBounds(
      form({
        'bound.0.dimension': 'replicaCount',
        'bound.0.form': 'maximum-integer',
        'bound.0.value': '3',
        'bound.1.dimension': 'deploymentStrategy',
        'bound.1.form': 'exact-token',
        'bound.1.value': 'rolling',
        'bound.2.dimension': 'canary',
        'bound.2.form': 'exact-boolean',
        'bound.2.value': 'false',
      }),
      errors,
    );
    assert.deepEqual(errors, {});
    assert.deepEqual(bounds, [
      { dimension: 'replicaCount', kind: 'maximum', type: 'integer', limit: 3 },
      { dimension: 'deploymentStrategy', kind: 'exact', type: 'token', value: 'rolling' },
      { dimension: 'canary', kind: 'exact', type: 'boolean', value: false },
    ]);
    const partial: Record<string, string> = {};
    assert.deepEqual(buildParameterBounds(form({ 'bound.0.dimension': 'replicaCount', 'bound.0.form': 'maximum-integer', 'bound.0.value': '' }), partial), []);
    assert.ok(partial['bound.0'] !== undefined, 'a dimension without a value is refused, not dropped');
    const noDimension: Record<string, string> = {};
    buildParameterBounds(form({ 'bound.1.value': '3' }), noDimension);
    assert.ok(noDimension['bound.1'] !== undefined);
    const fractional: Record<string, string> = {};
    buildParameterBounds(form({ 'bound.0.dimension': 'replicaCount', 'bound.0.form': 'maximum-integer', 'bound.0.value': '3.5' }), fractional);
    assert.ok(fractional['bound.0'] !== undefined, 'never rounded or coerced');
  });

  it('only the spec’s fields reach the request: organization, operator, system, provenance, digest and grant fields in a form are ignored', () => {
    const built = buildProvisionRequest(
      'authority-grant',
      form({
        authorityGrantId: 'grant-1',
        issuerActorId: 'issuer',
        subjectActorId: 'owner',
        trustDomainId: 'td',
        capability: 'release.manage',
        actions: 'deploy-release',
        resourceScopes: 'production-cluster',
        canDelegate: 'true',
        maxDelegationDepth: '1',
        'bound.0.dimension': 'replicaCount',
        'bound.0.form': 'maximum-integer',
        'bound.0.value': '3',
        idempotencyKey: 'console-key-0001',
        organizationId: 'org-evil',
        operatorId: 'ops-admin',
        system: 'true',
        provisionedBy: 'operator:someone-else',
        approvedBy: 'x',
        digest: 'sha256:00',
        signature: 'sig',
        boundedGrant: '{}',
        role: 'organization-administrator',
      }),
    );
    assert.ok(built.ok);
    assert.deepEqual(Object.keys(built.body).sort(), ['actions', 'authorityGrantId', 'canDelegate', 'capability', 'idempotencyKey', 'issuerActorId', 'maxDelegationDepth', 'parameterBounds', 'resourceScopes', 'subjectActorId', 'trustDomainId']);
    assert.deepEqual(built.body['parameterBounds'], [{ dimension: 'replicaCount', kind: 'maximum', type: 'integer', limit: 3 }]);
    assert.deepEqual(built.body['actions'], ['deploy-release']);
    assert.equal(built.body['canDelegate'], true);
    assert.equal(built.body['maxDelegationDepth'], 1);
  });

  it('no spec names a privileged field, and no spec exists for a bounded grant', () => {
    for (const [kind, specs] of Object.entries(ENTITY_FORM_SPECS)) {
      for (const spec of specs) assert.equal(/^(organizationId|operatorId|system|role|permissions|provisionedBy|approvedBy|authoredBy|activatedBy|actorRef|issuerRef|digest|signature|privateKey)$/.test(spec.name), false, `${kind}.${spec.name}`);
    }
    assert.equal(Object.prototype.hasOwnProperty.call(ENTITY_FORM_SPECS, 'bounded-grant'), false);
  });

  it('monetary limits are all-or-nothing and passed as canonical text for the Host to judge', () => {
    const half = buildProvisionRequest('authority-grant', form({ authorityGrantId: 'g', issuerActorId: 'i', subjectActorId: 's', trustDomainId: 't', capability: 'c', actions: 'a', resourceScopes: 'r', 'maxAmount.currency': 'USD' }));
    assert.equal(half.ok, false);
    const whole = buildProvisionRequest(
      'authority-grant',
      form({
        authorityGrantId: 'g',
        issuerActorId: 'i',
        subjectActorId: 's',
        trustDomainId: 't',
        capability: 'c',
        actions: 'a',
        resourceScopes: 'r',
        'maxAmount.currency': 'USD',
        'maxAmount.value': '500',
        'spendingLimit.limitId': 'lifetime-1',
        'spendingLimit.currency': 'USD',
        'spendingLimit.maximum': '10000',
        'spendingLimit.window': 'lifetime',
      }),
    );
    assert.ok(whole.ok);
    assert.deepEqual(whole.body['constraints'], [
      { type: 'max_amount', currency: 'USD', value: '500' },
      { type: 'spending_limit', limitId: 'lifetime-1', currency: 'USD', maximum: '10000', window: { kind: 'lifetime' } },
    ]);
  });

  it('a required field missing, or a select outside its options, is a form error — nothing is sent', () => {
    const missing = buildProvisionRequest('actor', form({ type: 'agent', displayName: 'A' }));
    assert.equal(missing.ok, false);
    const outside = buildProvisionRequest('actor', form({ actorId: 'a', type: 'superuser', displayName: 'A' }));
    assert.equal(outside.ok, false);
  });
});

describe('CTRL-03 web — sessions are bounded, opaque and destroyable', () => {
  it('absolute and idle expiry, destruction, opaque ids, and a clock moved backwards ends the session', () => {
    let now = 1_000_000;
    const store = createSessionStore({ now: () => now, absoluteTtlMs: 60_000, idleTtlMs: 10_000 });
    const session = store.create('operator-secret-value', 'ops-a');
    assert.match(session.id, /^[A-Za-z0-9_-]{43}$/);
    assert.notEqual(session.id, session.csrfToken);
    assert.equal(session.id.includes('operator-secret-value'), false);
    now += 9_000;
    assert.ok(store.get(session.id));
    now += 9_000;
    assert.ok(store.get(session.id), 'activity keeps it alive');
    now += 10_000;
    assert.equal(store.get(session.id), undefined, 'idle timeout');
    const second = store.create('s', 'ops-b');
    for (let step = 0; step < 7; step += 1) {
      now += 9_000;
      store.get(second.id);
    }
    assert.equal(store.get(second.id), undefined, 'absolute lifetime');
    const third = store.create('s', 'ops-c');
    store.destroy(third.id);
    assert.equal(store.get(third.id), undefined);
    const fourth = store.create('s', 'ops-d');
    now -= 1;
    assert.equal(store.get(fourth.id), undefined, 'a clock moved backwards is not trusted');
    assert.equal(store.get('not-a-session'), undefined);
    assert.throws(() => createSessionStore({ absoluteTtlMs: 13 * 3600 * 1000 }));
  });

  it('tokens compare in constant time and an empty token never matches', () => {
    assert.equal(tokensEqual('abc', 'abc'), true);
    assert.equal(tokensEqual('abc', 'abd'), false);
    assert.equal(tokensEqual('', ''), false);
    assert.equal(tokensEqual(undefined, 'abc'), false);
  });

  it('cookies are HttpOnly and SameSite=Strict, Secure on an HTTPS origin; the CSP allows no script and no framing', () => {
    assert.equal(setCookie(SESSION_COOKIE, 'v', { secure: false }), `${SESSION_COOKIE}=v; Path=/; HttpOnly; SameSite=Strict`);
    assert.match(setCookie(SESSION_COOKIE, 'v', { secure: true }), /; Secure$/);
    assert.doesNotMatch(CONTENT_SECURITY_POLICY, /script-src/);
    assert.match(CONTENT_SECURITY_POLICY, /default-src 'none'/);
    assert.match(CONTENT_SECURITY_POLICY, /frame-ancestors 'none'/);
    const headers = securityHeaders(false);
    assert.equal(headers['x-frame-options'], 'DENY');
    assert.equal(headers['cache-control'], 'no-store');
    assert.equal(headers['strict-transport-security'], undefined, 'no HSTS on loopback HTTP');
    assert.equal(securityHeaders(true)['strict-transport-security'], 'max-age=31536000');
    assert.deepEqual(cookieNames(true), { session: '__Host-frontera_console_session', login: '__Host-frontera_console_login' });
    assert.deepEqual(cookieNames(false), { session: 'frontera_console_session', login: 'frontera_console_login' });
  });

  it('the referrer policy lets a browser send the console’s true Origin on its own form posts — never `null` (no-referrer would make every form look forged)', () => {
    assert.equal(securityHeaders(false)['referrer-policy'], REFERRER_POLICY);
    assert.equal(REFERRER_POLICY, 'same-origin');
    const page = 'http://127.0.0.1:9/agents/a';
    assert.deepEqual(navigationHeaders(REFERRER_POLICY, page, 'http://127.0.0.1:9/agents'), { origin: 'http://127.0.0.1:9', referer: 'http://127.0.0.1:9/agents/a' });
    assert.deepEqual(navigationHeaders(REFERRER_POLICY, page, 'https://elsewhere.example/x'), { origin: 'null' }, 'nothing leaks to another origin');
    // The harness models the Fetch standard: a no-referrer document posts Origin: null.
    assert.deepEqual(navigationHeaders('no-referrer', page, 'http://127.0.0.1:9/agents'), { origin: 'null' });
  });
});

const entity = (overrides: Partial<EntityView>): EntityView => ({
  entityKind: 'authority-grant',
  entityId: 'g-1',
  organizationId: 'org',
  trustDomainId: 'td',
  status: 'active',
  terms: {},
  provisionedBy: 'operator:ops-p',
  provisionedAt: '2026-10-01T10:00:00.000Z',
  revokedBy: null,
  revokedAt: null,
  revocationReason: null,
  sequence: 1,
  ...overrides,
});

describe('CTRL-03 web — the activity projection states only what records say', () => {
  it('one row per recorded transition, with the record’s own id, time, operator and reason', () => {
    const rows = lifecycleTransitions({
      entities: [entity({}), entity({ entityId: 'g-2', status: 'revoked', revokedBy: 'operator:ops-r', revokedAt: '2026-10-01T11:00:00.000Z', revocationReason: 'incident' })],
      agents: [],
      profiles: [],
    });
    assert.deepEqual(
      rows.map((row) => [row.transition, row.targetId, row.at, row.by, row.reason]),
      [
        ['revoked', 'g-2', '2026-10-01T11:00:00.000Z', 'operator:ops-r', 'incident'],
        ['provisioned', 'g-1', '2026-10-01T10:00:00.000Z', 'operator:ops-p', null],
        ['provisioned', 'g-2', '2026-10-01T10:00:00.000Z', 'operator:ops-p', null],
      ],
    );
  });

  it('a missing time or operator is reported missing — never filled in — and revocation is never inferred from a stray field', () => {
    const rows = lifecycleTransitions({
      entities: [entity({ entityId: 'g-3', status: 'revoked', revokedAt: null, revokedBy: null }), entity({ entityId: 'g-4', status: 'active', revokedAt: '2026-10-01T12:00:00.000Z' })],
      agents: [],
      profiles: [],
    });
    const revoked = rows.find((row) => row.targetId === 'g-3' && row.transition === 'revoked');
    assert.ok(revoked !== undefined);
    assert.equal(revoked.at, null);
    assert.deepEqual(revoked.missing, ['time', 'operator']);
    assert.equal(rows[rows.length - 1]?.key, revoked.key, 'an undated row is listed last');
    assert.equal(rows.some((row) => row.targetId === 'g-4' && row.transition === 'revoked'), false, 'status, not a stray timestamp, says what happened');
  });

  it('credential and profile transitions come from their own records', () => {
    const agent = { actorId: 'a', credentials: [{ credentialId: 'agc-1', status: 'revoked', createdBy: 'operator:p', createdAt: '2026-10-01T09:00:00.000Z', revokedBy: 'operator:r', revokedAt: '2026-10-01T09:30:00.000Z', revocationReason: 'rotated', replacesCredentialId: null }] } as unknown as AgentView;
    const profile = { profileId: 'p', version: 2, activatedBy: 'operator:s', activatedAt: '2026-10-01T08:00:00.000Z', retiredBy: null, retiredAt: null, retirementReason: null } as unknown as ProfileVersion;
    const rows = lifecycleTransitions({ entities: [], agents: [agent], profiles: [profile] });
    assert.deepEqual(rows.map((row) => `${row.transition}:${row.targetId}`), ['credential-revoked:agc-1', 'credential-issued:agc-1', 'profile-activated:p@2']);
  });

  it('decision downstream comes only from references: no grant reference, no grant', () => {
    assert.deepEqual(decisionDownstream([]), { grants: [], executions: [] });
    const downstream = decisionDownstream([
      { referenceType: 'authorization_artifact', externalId: 'aoc.grant:1', externalVersion: null },
      { referenceType: 'execution_record', externalId: 'exec-1', externalVersion: 'attempt' },
      { referenceType: 'execution_record', externalId: 'exec-1', externalVersion: 'executed@a' },
      { referenceType: 'evidence_bundle', externalId: 'b', externalVersion: null },
    ]);
    assert.deepEqual(downstream, { grants: ['aoc.grant:1'], executions: [{ executionId: 'exec-1', recorded: ['attempt', 'executed@a'] }] });
  });
});

const context = (permissions: readonly string[]): OrganizationContext => ({
  organization: { organizationId: 'org-pilot', trustDomainId: 'td', agentCredentials: 'enabled', profileLifecycle: 'operator-promoted' },
  operator: { operatorId: 'ops-x', role: 'some-role', credentialClass: 'operator', permissions },
});

const agentView: AgentView = {
  actorId: 'agent-1',
  displayName: 'Agent One',
  status: 'active',
  externalSubject: { system: 'ci', subjectId: 's-1' },
  trustDomainId: 'td',
  provisionedBy: 'operator:ops-p',
  provisionedAt: '2026-10-01T10:00:00.000Z',
  revokedBy: null,
  revokedAt: null,
  revocationReason: null,
  principalId: null,
  credentials: [],
  authority: { passports: [], capabilityTokens: [], authorityGrants: [], delegationGrants: [] },
  onboarding: { actor: 'active', credential: 'none', standingAuthority: 'none' },
};

describe('CTRL-03 web — rendered views', () => {
  it('controls follow the permissions the Host reported — and only those (UX, never authorization)', () => {
    const observer = renderToStaticMarkup(<AgentPage context={context(['organization.read', 'inventory.read', 'authority.inspect'])} csrfToken="t" agent={agentView} entities={[]} issueIdempotencyKey="k" />);
    assert.doesNotMatch(observer, /data-testid="issue-credential"/);
    assert.doesNotMatch(observer, /Revoke agent actor/);
    assert.doesNotMatch(observer, /Provision passport/);
    const provisioner = renderToStaticMarkup(<AgentPage context={context(['inventory.read', 'agent-credential.manage', 'authority.provision', 'authority.revoke'])} csrfToken="t" agent={agentView} entities={[]} issueIdempotencyKey="k" />);
    assert.match(provisioner, /data-testid="issue-credential"/);
    assert.match(provisioner, /Revoke agent actor/);
    assert.match(provisioner, /Provision passport/);
  });

  it('a revoked actor is never shown as holding authority through a still-active credential', () => {
    const revoked = { ...agentView, status: 'revoked', onboarding: { actor: 'revoked', credential: 'active', standingAuthority: 'assigned' }, credentials: [{ credentialId: 'agc-1', status: 'active', createdBy: 'o', createdAt: 't', revokedBy: null, revokedAt: null, revocationReason: null, replacesCredentialId: null }] };
    const html = renderToStaticMarkup(<AgentPage context={context(['inventory.read', 'agent-credential.manage'])} csrfToken="t" agent={revoked} entities={[]} issueIdempotencyKey="k" />);
    assert.match(html, /This agent’s actor is revoked\./);
    assert.match(html, /credentials still recorded as active admit no one/);
    assert.doesNotMatch(html, /data-testid="issue-credential"/);
    assert.doesNotMatch(html, /Rotate credential/);
  });

  it('the one-time secret renders exactly once; a replay renders none', () => {
    const credential = { credentialId: 'agc-1', status: 'active', createdBy: 'operator:p', createdAt: 't', revokedBy: null, revokedAt: null, revocationReason: null, replacesCredentialId: null };
    const secret = 'fra1.agc-00000000000000000000000000000000.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    const issued = renderToStaticMarkup(<CredentialIssuedPage context={context([])} csrfToken="t" result={{ outcome: 'issued', actorId: 'a', principalId: 'agent:a', credential, bearerCredential: secret }} rotated={false} />);
    assert.equal(issued.split(secret).length - 1, 1);
    assert.doesNotMatch(issued, /<script/i);
    const replay = renderToStaticMarkup(<CredentialIssuedPage context={context([])} csrfToken="t" result={{ outcome: 'replayed', actorId: 'a', principalId: 'agent:a', credential, bearerCredential: null }} rotated={false} />);
    assert.doesNotMatch(replay, /data-testid="one-time-secret"/);
    assert.match(replay, /cannot be shown again/);
  });

  it('evidence says "verified" only when the store’s verification is valid', () => {
    const evidence = (valid: boolean): DecisionEvidence => ({
      decision: { evaluationId: 'e', decisionId: 'd', requestId: 'r', correlationId: null, actorId: 'a', actorType: null, actionType: 'act', resourceScope: 'res', requestedAt: 't', status: 'allowed', summary: 's', reasonCodes: [], evaluatedAt: 't', persistedAt: 't', kernelVersion: 'k' },
      integrity: { algorithm: 'sha256', chainPosition: 1, aggregateDigest: 'x', previousAggregateDigest: null },
      references: [],
      verification: { valid, verifiedAt: 't', checks: { evaluationDigest: valid }, failures: valid ? [] : [{ check: 'evaluationDigest', message: 'mismatch' }], referenceIntegrity: { legacyUnprotected: 0, protectedValid: 0, protectedCorrupted: 0, protectedUnsupportedVersion: 0 } },
      coverage: 'governance-store-decision-record',
    });
    const valid = renderToStaticMarkup(<EvidencePage context={context([])} csrfToken="t" evidence={evidence(true)} />);
    assert.match(valid, /Integrity verified by the Governance Store/);
    const invalid = renderToStaticMarkup(<EvidencePage context={context([])} csrfToken="t" evidence={evidence(false)} />);
    assert.doesNotMatch(invalid, /Integrity verified/);
    assert.match(invalid, /Verification FAILED/);
    assert.match(invalid, /data-testid="no-grant"/, 'no grant reference renders as not recorded');
  });
});

// -- the request handler against a scripted Host --------------------------------------------

const ORIGIN = 'http://127.0.0.1:9';
const ok = <T,>(body: T): Promise<HostResult<T>> => Promise.resolve({ ok: true, status: 200, body });
const fail = (status: number, body: unknown): Promise<HostResult<never>> => Promise.resolve({ ok: false, failure: classifyHostFailure(status, body) });

function scriptedHost(overrides: Partial<HostClient>, calls: string[]): HostClient {
  const base: Partial<HostClient> = {
    organization: () => ok(context(['inventory.read', 'authority.provision', 'authority.revoke'])),
    profiles: () => ok({ lifecycle: 'static', profiles: [] }),
    listEntities: () => ok({ entities: [] }),
  };
  return new Proxy({ ...base, ...overrides } as HostClient, {
    get(target, name: string) {
      const value = (target as unknown as Record<string, unknown>)[name];
      if (typeof value !== 'function') return () => Promise.resolve({ ok: false, failure: classifyHostFailure(404, undefined) });
      return (...args: unknown[]) => {
        calls.push(name);
        return (value as (...a: unknown[]) => unknown)(...args);
      };
    },
  });
}

function request(method: string, url: string, headers: Record<string, string>, body = ''): IncomingMessage {
  const stream = Readable.from(body.length > 0 ? [Buffer.from(body)] : []) as unknown as IncomingMessage;
  Object.assign(stream, { method, url, headers });
  return stream;
}

async function signedIn(host: HostClient): Promise<{ app: ReturnType<typeof createConsoleApp>; cookie: string; csrf: string }> {
  const sessions = createSessionStore();
  const app = createConsoleApp({ host, sessions, publicOrigin: ORIGIN });
  const session = sessions.create('operator-bearer-value', 'ops-x');
  return { app, cookie: `${SESSION_COOKIE}=${session.id}`, csrf: session.csrfToken };
}

describe('CTRL-03 web — the request handler shows the Host’s answer, never its own', () => {
  const provisionBody = (csrf: string): string =>
    new URLSearchParams({ csrf, idempotencyKey: 'console-key-0001', actorId: 'agent-9', type: 'agent', displayName: 'Nine', 'externalSubject.system': 's', 'externalSubject.subjectId': 'i' }).toString();
  const post = (cookie: string, path: string, body: string): IncomingMessage =>
    request('POST', path, { cookie, origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded' }, body);

  it('a Host 403 is rendered as a refusal — never a success, a redirect or a flash', async () => {
    const calls: string[] = [];
    const { app, cookie, csrf } = await signedIn(scriptedHost({ provision: () => fail(403, { error: { code: 'OPERATOR_PERMISSION_DENIED', message: 'denied' } }) }, calls));
    const response = await app.handle(post(cookie, '/agents', provisionBody(csrf)));
    assert.equal(response.status, 403);
    assert.equal(response.location, undefined);
    assert.match(response.body ?? '', /Not permitted/);
    assert.match(response.body ?? '', /OPERATOR_PERMISSION_DENIED/);
    assert.doesNotMatch(response.body ?? '', /provisioned\. Stage 1/);
    assert.ok(calls.includes('provision'), 'the console forwarded the operation: the Host decided');
  });

  it('a recorded refresh failure is shown as recorded, with the same idempotency key kept for the same-request retry', async () => {
    const calls: string[] = [];
    const { app, cookie, csrf } = await signedIn(
      scriptedHost({ provision: () => fail(503, { error: { code: 'AUTHORITY_STATE_REFRESH_FAILED', message: 'recorded', recorded: true, retry: 'same-request' } }) }, calls),
    );
    const response = await app.handle(post(cookie, '/agents', provisionBody(csrf)));
    assert.equal(response.status, 503);
    assert.match(response.body ?? '', /The write WAS durably recorded/);
    assert.match(response.body ?? '', /name="idempotencyKey" value="console-key-0001"/);
    assert.doesNotMatch(response.body ?? '', /Nothing was written/);
  });

  it('a successful write is followed by a canonical re-read (redirect-after-POST), never rendered from the write response', async () => {
    const calls: string[] = [];
    const { app, cookie, csrf } = await signedIn(
      scriptedHost(
        {
          revokeEntity: () => ok({ outcome: 'revoked', entity: entity({ entityKind: 'actor', entityId: 'agent-9', status: 'revoked' }) }),
          entity: () => ok(entity({ entityKind: 'actor', entityId: 'agent-9', status: 'revoked' })),
        },
        calls,
      ),
    );
    const response = await app.handle(post(cookie, '/authority/entities/actor/agent-9/revoke', new URLSearchParams({ csrf, confirm: 'yes', reason: 'r' }).toString()));
    assert.equal(response.status, 303);
    assert.equal(response.location, '/authority/entities/actor/agent-9');
    const reread = await app.handle(request('GET', '/authority/entities/actor/agent-9', { cookie }));
    assert.equal(reread.status, 200);
    assert.deepEqual(calls.slice(-3).sort(), ['entity', 'listEntities', 'organization'], 'the page after the write is a fresh Host read');
  });

  it('without confirmation, a destructive form sends nothing to the Host', async () => {
    const calls: string[] = [];
    const { app, cookie, csrf } = await signedIn(scriptedHost({ entity: () => ok(entity({ entityKind: 'actor', entityId: 'agent-9' })) }, calls));
    const response = await app.handle(post(cookie, '/authority/entities/actor/agent-9/revoke', new URLSearchParams({ csrf, reason: 'r' }).toString()));
    assert.equal(response.status, 200);
    assert.equal(calls.includes('revokeEntity'), false);
  });

  it('a missing or foreign CSRF token, a cross-origin POST and a POST without an origin are refused before the Host is asked anything', async () => {
    const calls: string[] = [];
    const { app, cookie, csrf } = await signedIn(scriptedHost({}, calls));
    const attempts = [
      post(cookie, '/agents', provisionBody('not-the-token')),
      post(cookie, '/agents', new URLSearchParams({ actorId: 'x' }).toString()),
      request('POST', '/agents', { cookie, origin: 'https://evil.example', 'content-type': 'application/x-www-form-urlencoded' }, provisionBody(csrf)),
      request('POST', '/agents', { cookie, 'content-type': 'application/x-www-form-urlencoded' }, provisionBody(csrf)),
    ];
    for (const attempt of attempts) assert.equal((await app.handle(attempt)).status, 403);
    assert.deepEqual(calls, []);
  });
});

describe('CTRL-03 web — the Host client', () => {
  it('refuses a dot segment instead of letting URL normalization send the request to another Host route', async () => {
    const client = createHostClient({ baseUrl: 'http://127.0.0.1:9', timeoutMs: 500 });
    for (const target of ['.', '..']) {
      const revoke = await client.revokeEntity('bearer', 'actor', target, 'reason');
      assert.equal(revoke.ok, false);
      assert.equal(revoke.ok ? '' : revoke.failure.kind, 'validation');
      assert.equal(revoke.ok ? 0 : revoke.failure.status, null, 'nothing was sent');
      const issue = await client.issueCredential('bearer', target, 'key-00000001');
      assert.equal(issue.ok ? '' : issue.failure.kind, 'validation');
    }
  });

  it('an unreachable Host is "unavailable" — unknown for a write, never success', async () => {
    const client = createHostClient({ baseUrl: 'http://127.0.0.1:9', timeoutMs: 500 });
    const result = await client.revokeEntity('bearer', 'actor', 'actor-1', 'reason');
    assert.equal(result.ok, false);
    assert.equal(result.ok ? '' : result.failure.kind, 'unavailable');
  });

  it('refuses a Host URL carrying credentials, a query or a fragment', () => {
    for (const baseUrl of ['http://user:pass@127.0.0.1:1', 'http://127.0.0.1:1/?x=1', 'http://127.0.0.1:1/#f']) assert.throws(() => createHostClient({ baseUrl }));
  });
});

describe('CTRL-03 web — adversarial-review fixes', () => {
  const post = (cookie: string, path: string, body: string, origin = ORIGIN): IncomingMessage =>
    request('POST', path, { cookie, origin, 'content-type': 'application/x-www-form-urlencoded' }, body);

  it('a POST carrying Origin: null is refused before the Host is asked anything', async () => {
    const calls: string[] = [];
    const { app, cookie, csrf } = await signedIn(scriptedHost({}, calls));
    const response = await app.handle(post(cookie, '/agents', new URLSearchParams({ csrf, actorId: 'x', type: 'agent', displayName: 'X' }).toString(), 'null'));
    assert.equal(response.status, 403);
    assert.deepEqual(calls, []);
  });

  it('a failed credential issue shows the failure on the re-read agent page and keeps the same idempotency key for the same-request retry', async () => {
    const calls: string[] = [];
    const { app, cookie, csrf } = await signedIn(
      scriptedHost(
        {
          organization: () => ok(context(['inventory.read', 'agent-credential.manage'])),
          issueCredential: () => fail(503, { error: { code: 'AUTHORITY_STATE_UNAVAILABLE', message: 'unavailable' } }),
          agent: () => ok(agentView),
        },
        calls,
      ),
    );
    const response = await app.handle(post(cookie, '/agents/agent-1/credentials', new URLSearchParams({ csrf, idempotencyKey: 'console-issue-key-0001' }).toString()));
    assert.equal(response.status, 503);
    assert.match(response.body ?? '', /Host unavailable/);
    assert.match(response.body ?? '', /name="idempotencyKey" value="console-issue-key-0001"/);
    assert.ok(calls.includes('agent'), 'the agent shown is a fresh Host read');
  });

  it('a delegation form restates every parent bound — five bounds render five prefilled rows, none dropped', async () => {
    const bounds = ['a', 'b', 'c', 'd', 'e'].map((dimension, index) => ({ dimension, kind: 'maximum', type: 'integer', limit: index + 1 }));
    const parent = entity({ entityId: 'g-5', terms: { subjectActorId: 'owner', capability: 'c', actions: ['act'], resourceScopes: ['res'], parameterBounds: bounds } });
    const { app, cookie } = await signedIn(scriptedHost({ listEntities: () => ok({ entities: [parent] }) }, []));
    const response = await app.handle(request('GET', '/authority/new/delegation-grant?source=g-5', { cookie }));
    assert.equal(response.status, 200);
    for (const [row, bound] of bounds.entries()) {
      assert.match(response.body ?? '', new RegExp(`name="bound\\.${row}\\.value"[^>]*value="${bound.limit}"`), `row ${row}`);
    }
    assert.match(response.body ?? '', /name="bound\.5\.dimension"/, 'and one empty row to add another');
  });

  it('a successful sign-in ends any earlier session of the same browser', async () => {
    const sessions = createSessionStore();
    const app = createConsoleApp({ host: scriptedHost({}, []), sessions, publicOrigin: ORIGIN });
    const earlier = sessions.create('old-bearer', 'ops-old');
    const login = await app.handle(request('GET', '/login', {}));
    const loginToken = /name="loginToken" value="([^"]+)"/.exec(login.body ?? '')?.[1] ?? '';
    const signedInResponse = await app.handle(
      request('POST', '/login', { cookie: `${SESSION_COOKIE}=${earlier.id}; frontera_console_login=${loginToken}`, origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded' }, new URLSearchParams({ loginToken, credential: 'operator-bearer-value' }).toString()),
    );
    assert.equal(signedInResponse.status, 303);
    assert.equal(sessions.get(earlier.id), undefined);
  });

  it('a verified record with legacy-unprotected references says those references are not covered', () => {
    const evidence: DecisionEvidence = {
      decision: { evaluationId: 'e', decisionId: 'd', requestId: 'r', correlationId: null, actorId: 'a', actorType: null, actionType: 'act', resourceScope: 'res', requestedAt: 't', status: 'allowed', summary: 's', reasonCodes: [], evaluatedAt: 't', persistedAt: 't', kernelVersion: 'k' },
      integrity: { algorithm: 'sha256', chainPosition: 1, aggregateDigest: 'x', previousAggregateDigest: null },
      references: [{ referenceId: 'r1', referenceType: 'authorization_artifact', externalId: 'aoc.grant:1', externalVersion: null, digest: null, createdAt: 't', sequence: null }],
      verification: { valid: true, verifiedAt: 't', checks: { evaluationDigest: true }, failures: [], referenceIntegrity: { legacyUnprotected: 1, protectedValid: 0, protectedCorrupted: 0, protectedUnsupportedVersion: 0 } },
      coverage: 'governance-store-decision-record',
    };
    const html = renderToStaticMarkup(<EvidencePage context={context([])} csrfToken="t" evidence={evidence} />);
    assert.match(html, /data-testid="unprotected-references"/);
    assert.match(html, /are not covered by this verification/);
  });

  it('a 2xx body whose verification checks are not booleans, or whose emergency transition names no control, is a contract failure — never rendered', () => {
    const base = { decision: { evaluationId: 'e' }, references: [], verification: { valid: true, checks: { evaluationDigest: 'false' }, failures: [], referenceIntegrity: { legacyUnprotected: 0 } } };
    assert.equal(shapes.evidence(base), false);
    assert.equal(shapes.evidence({ ...base, verification: { ...base.verification, checks: { evaluationDigest: true } } }), true);
    assert.equal(shapes.emergencyTransition({ outcome: 'activated', active: [] }), false);
  });
});
