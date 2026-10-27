import { copyFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import Database from 'better-sqlite3';

import type { ApprovalCommandPort, ApprovalRequestView } from '../approval-authority/index.js';
import { createHumanDecisionChannel, HUMAN_PASSKEY_DECISION_CHANNEL } from '../approval-authority/human-decision.js';
import { ApprovalAuthorityError } from '../approval-authority/errors.js';
import { assertHumanAuthorityComposable, HumanAuthorityConfigurationError, type HumanAuthorityPort } from '../composition/human-authority-composition.js';
import type { EnabledHumanAuthorityConfiguration } from '../configuration/enterprise-configuration.js';
import { bootEnterpriseHost, type EnterpriseHost } from '../host/enterprise-host.js';
import { HumanIdentityError, INTENDED_PRODUCTION_RP_ID, identityAdministratorFor, openSqliteHumanIdentityStore, type IdentityAdministrator } from '../human-identity/index.js';
import { isOperatorRole, type OperatorRole } from '../operator-control/roles.js';
import { AUTHORITY_KEY_UNTRUSTED, testSigner, testVerifier } from './authority-authenticity-fixture.js';
import { SoftwareAuthenticator } from './auth02-software-authenticator.js';
import { freshnessEnv, startWitness, witnessRows, type StartedWitness } from './core07-freshness-fixture.js';
import { capturingLogger, recordingAdapter, type RecordingAdapter } from './ctrl02-host-fixture.js';
import {
  AUTH,
  CTRL04_OPERATORS,
  ORG,
  PROD,
  approvalPolicy,
  assertAwaitingApproval,
  call,
  createWorkspace,
  ctrl04Env,
  ctrl04File,
  govern,
  provisionOrganization,
  release,
  releaseKey,
  type Organization,
} from './ctrl04-host-fixture.js';

/**
 * AUTH-04A — the passkey human-decision authority composed inside the
 * canonical shipped Host (`bootEnterpriseHost()`, production profile, SQLite,
 * software custody, an external CORE-07 reference witness).
 *
 * The decision port is reached in-process only (`host.enterprise.humanAuthority`):
 * there is no route. Every ceremony is verified by `@simplewebauthn/server`,
 * driven by the spec-faithful software authenticator, against the intended
 * pilot relying party `authority.frontera-systems.com` (no DNS or TLS is
 * involved: WebAuthn verification is local). One Host process.
 */

const ORIGIN = `https://${INTENDED_PRODUCTION_RP_ID}`;
const workspace = createWorkspace('frontera-auth04a-');
const witnesses: StartedWitness[] = [];
after(async () => {
  await workspace.close();
  for (const witness of witnesses.splice(0)) await witness.close().catch(() => {});
});

const identityPath = (dir: string): string => join(dir, 'identity', 'human-identity.sqlite');

/** Folds the WAL into the main file (the Host is closed), so a file-level copy or removal is the whole committed state. */
function checkpointed(path: string): string {
  const db = new Database(path);
  db.pragma('wal_checkpoint(TRUNCATE)');
  db.close();
  for (const suffix of ['-wal', '-shm']) if (existsSync(`${path}${suffix}`)) rmSync(`${path}${suffix}`);
  return path;
}

function humanAuthorityEnv(dir: string, overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    AOC_ENTERPRISE_HUMAN_AUTHORITY_MODE: 'enabled',
    AOC_ENTERPRISE_HUMAN_IDENTITY_SQLITE_PATH: identityPath(dir),
    AOC_ENTERPRISE_HUMAN_AUTHORITY_RP_ID: INTENDED_PRODUCTION_RP_ID,
    AOC_ENTERPRISE_HUMAN_AUTHORITY_ALLOWED_ORIGINS: ORIGIN,
    AOC_ENTERPRISE_HUMAN_AUTHORITY_INITIALIZE: 'true',
    ...overrides,
  };
}

interface Booted {
  readonly host: EnterpriseHost;
  readonly adapter: RecordingAdapter;
  readonly baseUrl: string;
  readonly authority: HumanAuthorityPort;
}

function bootOptions(dir: string, witness: StartedWitness, overrides: Record<string, string | undefined> = {}) {
  const adapter = recordingAdapter();
  return { adapter, options: { env: ctrl04Env(dir, ctrl04File(), { ...freshnessEnv(witness), ...humanAuthorityEnv(dir), ...overrides }), executionAdapters: [adapter], logger: capturingLogger, policyPackProvider: approvalPolicy() } };
}

async function boot(dir: string, witness: StartedWitness, overrides: Record<string, string | undefined> = {}): Promise<Booted> {
  const { adapter, options } = bootOptions(dir, witness, overrides);
  const host = workspace.track(await bootEnterpriseHost(options));
  const { port } = await host.listen();
  const authority = host.enterprise.humanAuthority;
  assert.ok(authority !== undefined, 'the Host exposes the human-decision port');
  return { host, adapter, baseUrl: `http://127.0.0.1:${port}`, authority };
}

async function refusedAtBoot(code: string | RegExp, dir: string, witness: StartedWitness, overrides: Record<string, string | undefined> = {}): Promise<void> {
  const { options } = bootOptions(dir, witness, overrides);
  await assert.rejects(bootEnterpriseHost(options), (error: unknown) => {
    const actual = (error as { code?: unknown }).code;
    if (typeof actual === 'string' && (typeof code === 'string' ? actual === code : code.test(actual))) return true;
    return assert.fail(`expected ${String(code)}, got ${String(actual)}: ${(error as Error).message}`);
  });
}

async function newWitness(): Promise<StartedWitness> {
  const witness = await startWitness();
  witnesses.push(witness);
  return witness;
}

const administrator = (): IdentityAdministrator =>
  identityAdministratorFor({ plane: 'operator', operatorId: 'ops-admin', organizationId: ORG, role: 'organization-administrator', credentialClass: 'operator', actorRef: 'operator:ops-admin' });

async function enrol(authority: HumanAuthorityPort, operatorId: string): Promise<{ readonly device: SoftwareAuthenticator; readonly credentialId: string }> {
  const device = new SoftwareAuthenticator({ origin: ORIGIN });
  const admin = administrator();
  if (authority.identity.principal(operatorId) === undefined) await authority.identity.createPrincipal(admin, { operatorId, displayName: `Human ${operatorId}` });
  const issued = await authority.identity.authorizeEnrolment(admin, operatorId);
  const credential = await authority.identity.finishRegistration(issued.enrolmentToken, device.register(authority.identity.beginRegistration(issued.enrolmentToken)));
  return { device, credentialId: credential.credentialId };
}

async function pending(booted: Booted, org: Organization): Promise<{ readonly key: string; readonly view: ApprovalRequestView }> {
  const key = releaseKey('auth04a');
  const reply = await govern(booted.baseUrl, org.agentCredential, release(PROD, key));
  assertAwaitingApproval(reply);
  const approvals = booted.host.enterprise.approvals as ApprovalCommandPort;
  const view = (await approvals.list()).find((candidate) => candidate.requestId === reply.body['requestId']);
  assert.ok(view !== undefined);
  return { key, view };
}

const verdictsOf = async (booted: Booted, approvalRequestId: string) => ((await (booted.host.enterprise.approvals as ApprovalCommandPort).list()).find((view) => view.approvalRequestId === approvalRequestId) ?? assert.fail('missing')).state.verdicts;

async function identityRefused(code: string, run: () => Promise<unknown>): Promise<void> {
  await assert.rejects(run, (error: unknown) => (error instanceof HumanIdentityError && error.code === code) || assert.fail(`expected ${code}, got ${String((error as { code?: unknown }).code)}: ${(error as Error).message}`));
}

// ── 1. The gate ─────────────────────────────────────────────────────────────────────

describe('AUTH-04A gate — the authority is composed securely or the Host refuses', () => {
  const enabled: EnabledHumanAuthorityConfiguration = { mode: 'enabled', sqlitePath: '/unused', rpId: INTENDED_PRODUCTION_RP_ID, rpName: 'Frontera Authority', allowedOrigins: [ORIGIN], initialize: false, decisionChallengeTtlSeconds: 120, ceremonyChallengeTtlSeconds: 120, enrolmentTtlSeconds: 900, gateway: { mode: 'disabled' } };
  const ready = { persistence: 'sqlite', freshness: 'external', signerCustody: 'software', operators: [{ operatorId: 'approver-a', role: 'approver' }], approvalsDeclared: true } as const;
  const refusedBy = (code: string) => (error: unknown) => (error instanceof HumanAuthorityConfigurationError && error.code === code) || assert.fail(`expected ${code}, got ${String((error as { code?: unknown }).code)}`);

  it('accepts the secure composition and returns the frozen production relying party', () => {
    const rp = assertHumanAuthorityComposable(enabled, ready);
    assert.equal(rp.rpId, 'authority.frontera-systems.com');
    assert.equal(rp.mode, 'production');
    assert.deepEqual([...rp.allowedOrigins], [ORIGIN]);
  });

  it('refuses an unwitnessed store, memory persistence, external custody, no operators and no durable approvals', () => {
    assert.throws(() => assertHumanAuthorityComposable(enabled, { ...ready, freshness: 'none' }), refusedBy('HUMAN_AUTHORITY_FRESHNESS_REQUIRED'));
    assert.throws(() => assertHumanAuthorityComposable(enabled, { ...ready, persistence: 'memory' }), refusedBy('HUMAN_AUTHORITY_PREREQUISITE_MISSING'));
    assert.throws(() => assertHumanAuthorityComposable(enabled, { ...ready, signerCustody: 'external' }), refusedBy('HUMAN_AUTHORITY_SIGNER_UNSUPPORTED'));
    assert.throws(() => assertHumanAuthorityComposable(enabled, { ...ready, operators: [] }), refusedBy('HUMAN_AUTHORITY_PREREQUISITE_MISSING'));
    assert.throws(() => assertHumanAuthorityComposable(enabled, { ...ready, approvalsDeclared: false }), refusedBy('HUMAN_AUTHORITY_PREREQUISITE_MISSING'));
  });

  it('refuses an incorrect relying party: another domain, an http origin, localhost (no loopback mode on a Host)', () => {
    for (const relyingParty of [
      { rpId: INTENDED_PRODUCTION_RP_ID, allowedOrigins: ['https://evil.example'] },
      { rpId: INTENDED_PRODUCTION_RP_ID, allowedOrigins: [`http://${INTENDED_PRODUCTION_RP_ID}`] },
      { rpId: INTENDED_PRODUCTION_RP_ID, allowedOrigins: ['https://frontera-systems.com'] },
      { rpId: 'localhost', allowedOrigins: ['https://localhost'] },
      { rpId: `https://${INTENDED_PRODUCTION_RP_ID}`, allowedOrigins: [ORIGIN] },
    ]) {
      assert.throws(() => assertHumanAuthorityComposable({ ...enabled, ...relyingParty }, ready), refusedBy('HUMAN_AUTHORITY_CONFIGURATION_INVALID'), JSON.stringify(relyingParty));
    }
  });
});

describe('AUTH-04A startup refusals on the shipped Host', () => {
  it('a missing witness configuration, or an unreachable witness, refuses the Host', async () => {
    const witness = await newWitness();
    await refusedAtBoot('HOST_AUTHORITY_FRESHNESS_REQUIRED', workspace.dir(), witness, { AOC_ENTERPRISE_AUTHORITY_FRESHNESS_MODE: 'none', AOC_ENTERPRISE_AUTHORITY_FRESHNESS_ENDPOINT: undefined, AOC_ENTERPRISE_AUTHORITY_FRESHNESS_TOKEN: undefined, AOC_ENTERPRISE_AUTHORITY_FRESHNESS_WITNESS_ID: undefined, AOC_ENTERPRISE_AUTHORITY_FRESHNESS_WITNESS_PUBLIC_KEY: undefined, AOC_ENTERPRISE_AUTHORITY_FRESHNESS_TIMEOUT_MS: undefined, AOC_ENTERPRISE_AUTHORITY_FRESHNESS_MAX_ATTEMPTS: undefined, AOC_ENTERPRISE_AUTHORITY_FRESHNESS_PROBE_INTERVAL_MS: undefined });
    const down = await newWitness();
    await down.close();
    await refusedAtBoot(/^AUTHORITY_FRESHNESS_|^HOST_/, workspace.dir(), down);
  });

  it('an external authority signer (which cannot sign identity state) refuses the Host before anything is opened', async () => {
    const dir = workspace.dir();
    await refusedAtBoot('HUMAN_AUTHORITY_SIGNER_UNSUPPORTED', dir, await newWitness(), {
      AOC_ENTERPRISE_AUTHORITY_SIGNER_MODE: 'external',
      AOC_ENTERPRISE_AUTHORITY_SIGNING_KEY_PEM: undefined,
      AOC_ENTERPRISE_AUTHORITY_SIGNER_ENDPOINT: 'http://127.0.0.1:9',
      AOC_ENTERPRISE_AUTHORITY_SIGNER_TOKEN: 'FRONTERA_AUTH04A_EXTERNAL_SIGNER_TOKEN_0123456789',
    });
    assert.equal(existsSync(identityPath(dir)), false, 'no identity store was created');
  });

  it('an incorrect RP ID or origin refuses the Host; a human-authority variable without the mode is refused, never guessed', async () => {
    const witness = await newWitness();
    await refusedAtBoot('HUMAN_AUTHORITY_CONFIGURATION_INVALID', workspace.dir(), witness, { AOC_ENTERPRISE_HUMAN_AUTHORITY_ALLOWED_ORIGINS: 'https://evil.example' });
    await refusedAtBoot('HUMAN_AUTHORITY_CONFIGURATION_INVALID', workspace.dir(), witness, { AOC_ENTERPRISE_HUMAN_AUTHORITY_RP_ID: 'localhost', AOC_ENTERPRISE_HUMAN_AUTHORITY_ALLOWED_ORIGINS: 'https://localhost' });
    await refusedAtBoot('HOST_ENVIRONMENT_INVALID', workspace.dir(), witness, { AOC_ENTERPRISE_HUMAN_AUTHORITY_ALLOWED_ORIGINS: `http://${INTENDED_PRODUCTION_RP_ID}` });
    await refusedAtBoot('HOST_ENVIRONMENT_INVALID', workspace.dir(), witness, { AOC_ENTERPRISE_HUMAN_AUTHORITY_RP_ID: undefined });
    await refusedAtBoot('HOST_ENVIRONMENT_INVALID', workspace.dir(), witness, { AOC_ENTERPRISE_HUMAN_AUTHORITY_DECISION_TTL_SECONDS: '121' });
    await refusedAtBoot('HOST_ENVIRONMENT_INVALID', workspace.dir(), witness, { AOC_ENTERPRISE_HUMAN_AUTHORITY_MODE: undefined });
  });

  it('no store and no initialization: refused, never created implicitly', async () => {
    const dir = workspace.dir();
    await refusedAtBoot('HUMAN_AUTHORITY_STORE_UNINITIALIZED', dir, await newWitness(), { AOC_ENTERPRISE_HUMAN_AUTHORITY_INITIALIZE: 'false' });
    assert.equal(existsSync(identityPath(dir)), false);
  });

  /** A store file prepared out of band at the Host's identity path. */
  async function prepared(dir: string, options: { readonly organizationId?: string; readonly signWith?: typeof AUTHORITY_KEY_UNTRUSTED } = {}): Promise<void> {
    const store = await openSqliteHumanIdentityStore(identityPath(dir), {
      organizationId: options.organizationId ?? ORG,
      now: () => new Date().toISOString(),
      create: true,
      authenticity: options.signWith !== undefined ? { signer: testSigner(options.signWith), verifier: testVerifier([options.signWith]) } : { signer: testSigner(), verifier: testVerifier() },
    });
    store.close();
  }

  it('an unsigned identity head is refused', async () => {
    const dir = workspace.dir();
    await prepared(dir);
    const raw = new Database(identityPath(dir));
    raw.prepare("UPDATE human_identity_head SET signature_json = '{}'").run();
    raw.close();
    await refusedAtBoot('HUMAN_IDENTITY_STORE_CORRUPT', dir, await newWitness(), { AOC_ENTERPRISE_HUMAN_AUTHORITY_INITIALIZE: 'false' });
  });

  it('a head forged under an untrusted key is refused', async () => {
    const dir = workspace.dir();
    await prepared(dir, { signWith: AUTHORITY_KEY_UNTRUSTED });
    await refusedAtBoot('HUMAN_IDENTITY_STORE_CORRUPT', dir, await newWitness(), { AOC_ENTERPRISE_HUMAN_AUTHORITY_INITIALIZE: 'false' });
  });

  it('a store of another organization is refused', async () => {
    const dir = workspace.dir();
    await prepared(dir, { organizationId: 'org-other' });
    await refusedAtBoot('HUMAN_IDENTITY_STORE_CORRUPT', dir, await newWitness(), { AOC_ENTERPRISE_HUMAN_AUTHORITY_INITIALIZE: 'false' });
  });
});

// ── 2. Operating the authority on the shipped Host ───────────────────────────────────

describe('AUTH-04A on the shipped Host — passkey decisions into CORE-05, nothing public', () => {
  let witness: StartedWitness;
  let booted: Booted;
  let org: Organization;
  const humans = new Map<string, { readonly device: SoftwareAuthenticator; readonly credentialId: string }>();
  const human = (operatorId: string) => humans.get(operatorId) ?? assert.fail(operatorId);

  before(async () => {
    witness = await newWitness();
    booted = await boot(workspace.dir(), witness);
    org = await provisionOrganization(booted.baseUrl);
    for (const operatorId of ['approver-a', 'approver-b', 'approver-c', 'approver-d', 'approver-nostanding']) humans.set(operatorId, await enrol(booted.authority, operatorId));
  });

  it('starts witnessed: posture composed, the identity slot anchored at the witness, the relying party pinned', async () => {
    assert.equal(booted.host.posture.humanAuthority, 'composed');
    assert.equal(booted.host.posture.authorityFreshness, 'external');
    assert.equal(booted.authority.organizationId, ORG);
    assert.equal(booted.authority.relyingParty.rpId, INTENDED_PRODUCTION_RP_ID);
    const slot = (await witnessRows(witness.databasePath)).find((row) => row['state_kind'] === 'human-identity-state');
    assert.ok(slot !== undefined && slot['organization_id'] === ORG, 'the identity store is anchored at the witness');
    assert.ok(Number(slot['committed_sequence']) > 0, 'every enrolment advanced the witnessed head');
    const health = await call(booted.baseUrl, 'GET', '/health', {});
    assert.equal(health.status, 200, health.text);
  });

  it('a valid human decision: the CTO approves with a passkey, CORE-05 records it from the passkey channel, the agent executes exactly once', async () => {
    const { key, view } = await pending(booted, org);
    const issued = await booted.authority.decisions.begin({ operatorId: 'approver-a', approvalRequestId: view.approvalRequestId, subjectDigest: view.subjectDigest, verdict: 'approve' });
    assert.equal(issued.contract.organizationId, ORG);
    const result = await booted.authority.decisions.decide(human('approver-a').device.assert(issued.options));
    assert.equal(result.outcome, 'recorded');
    if (result.outcome === 'recorded') {
      assert.equal(result.approval.state.status, 'approved');
      assert.equal(result.approval.state.verdicts[0]?.recordedBy, HUMAN_PASSKEY_DECISION_CHANNEL);
      assert.deepEqual(result.approval.state.verdicts[0]?.evidence.map((entry) => entry.hash), [result.evidenceDigest]);
    }
    const calls = booted.adapter.calls.length;
    const resumed = await govern(booted.baseUrl, org.agentCredential, release(PROD, key));
    assert.equal(resumed.body['status'], 'executed', resumed.text);
    assert.equal(booted.adapter.calls.length, calls + 1);
  });

  it('a rejected human decision closes the request', async () => {
    const { key, view } = await pending(booted, org);
    const issued = await booted.authority.decisions.begin({ operatorId: 'approver-b', approvalRequestId: view.approvalRequestId, subjectDigest: view.subjectDigest, verdict: 'reject' });
    assert.equal((await booted.authority.decisions.decide(human('approver-b').device.assert(issued.options))).outcome, 'recorded');
    assertAwaitingApproval(await govern(booted.baseUrl, org.agentCredential, release(PROD, key)), 'GOVERNED_ACTION_APPROVAL_REJECTED');
  });

  it('a credential revoked during the decision cannot complete it; nothing is consumed or recorded', async () => {
    const { view } = await pending(booted, org);
    const issued = await booted.authority.decisions.begin({ operatorId: 'approver-c', approvalRequestId: view.approvalRequestId, subjectDigest: view.subjectDigest, verdict: 'reject' });
    await booted.authority.identity.revokeCredential(administrator(), human('approver-c').credentialId, 'device lost mid-decision');
    await identityRefused('HUMAN_IDENTITY_CREDENTIAL_UNUSABLE', () => booted.authority.decisions.decide(human('approver-c').device.assert(issued.options)));
    assert.equal(booted.authority.identity.decision(issued.commitment)?.state, 'issued');
    assert.equal((await verdictsOf(booted, view.approvalRequestId)).length, 0);
  });

  it('a principal revoked during the decision cannot complete it', async () => {
    const { view } = await pending(booted, org);
    const issued = await booted.authority.decisions.begin({ operatorId: 'approver-d', approvalRequestId: view.approvalRequestId, subjectDigest: view.subjectDigest, verdict: 'reject' });
    await booted.authority.identity.revokePrincipal(administrator(), 'approver-d', 'left the release board');
    await identityRefused('HUMAN_IDENTITY_CREDENTIAL_UNUSABLE', () => booted.authority.decisions.decide(human('approver-d').device.assert(issued.options)));
    assert.equal((await verdictsOf(booted, view.approvalRequestId)).length, 0);
  });

  it('approver standing revoked in Kernel Authority: the verified passkey decision is refused by CORE-05 and counts for nothing', async () => {
    const revoked = await call(booted.baseUrl, 'POST', '/api/admin/authority/entities/authority-grant/approval-standing-approver-b/revoke', { authorization: AUTH.responder, body: { reason: 'approver left the release board' } });
    assert.equal(revoked.status, 200, revoked.text);
    const { view } = await pending(booted, org);
    const issued = await booted.authority.decisions.begin({ operatorId: 'approver-b', approvalRequestId: view.approvalRequestId, subjectDigest: view.subjectDigest, verdict: 'approve' });
    const result = await booted.authority.decisions.decide(human('approver-b').device.assert(issued.options));
    assert.equal(result.outcome, 'refused');
    if (result.outcome === 'refused') assert.equal(result.code, 'APPROVAL_APPROVER_INELIGIBLE');
    assert.equal((await verdictsOf(booted, view.approvalRequestId)).filter((verdict) => verdict.counted).length, 0);
    assert.equal((await booted.authority.decisions.outcome(issued.commitment))?.state, 'refused');
  });

  it('a duplicate assertion records exactly one verdict, concurrently or replayed', async () => {
    const { view } = await pending(booted, org);
    const issued = await booted.authority.decisions.begin({ operatorId: 'approver-a', approvalRequestId: view.approvalRequestId, subjectDigest: view.subjectDigest, verdict: 'approve' });
    const assertion = human('approver-a').device.assert(issued.options);
    const outcomes = await Promise.allSettled([booted.authority.decisions.decide(assertion), booted.authority.decisions.decide(assertion)]);
    assert.deepEqual(outcomes.map((outcome) => outcome.status).sort(), ['fulfilled', 'rejected']);
    await assert.rejects(booted.authority.decisions.decide(assertion));
    assert.equal((await verdictsOf(booted, view.approvalRequestId)).length, 1);
  });

  it('no public Authority route exists: no decision, identity, enrolment or passkey path answers', async () => {
    const paths = [
      ['POST', '/api/human-authority/decisions'],
      ['POST', '/api/authority/decisions'],
      ['POST', '/api/decisions'],
      ['POST', '/api/passkeys/register'],
      ['POST', '/api/webauthn/authenticate'],
      ['GET', '/api/human-identity/principals'],
      ['POST', '/api/admin/human-identity/enrolments'],
      ['POST', '/api/admin/approvals/x/passkey'],
      ['GET', '/authority'],
      ['GET', '/.well-known/webauthn'],
    ] as const;
    for (const [method, path] of paths) {
      for (const authorization of [undefined, AUTH.observer]) {
        const reply = await call(booted.baseUrl, method, path, { ...(authorization !== undefined ? { authorization } : {}), ...(method === 'POST' ? { body: {} } : {}) });
        // Unmounted (404), or refused before any routing decision (400/401/403/405): never answered.
        assert.ok([400, 401, 403, 404, 405].includes(reply.status), `${method} ${path} → ${reply.status}`);
        // The 404 body echoes the requested path; anything beyond it must say nothing of the authority.
        assert.equal(/challenge|commitment|credentialId|enrolment/i.test(reply.text.split(path).join('')), false, `${method} ${path} leaks nothing of the authority`);
      }
    }
  });

  it('after the Host is closed, the in-process port refuses; nothing authorizes from memory', async () => {
    const { view } = await pending(booted, org);
    const issued = await booted.authority.decisions.begin({ operatorId: 'approver-a', approvalRequestId: view.approvalRequestId, subjectDigest: view.subjectDigest, verdict: 'reject' });
    await booted.host.close();
    await assert.rejects(booted.authority.decisions.decide(human('approver-a').device.assert(issued.options)));
    await assert.rejects(booted.authority.decisions.begin({ operatorId: 'approver-a', approvalRequestId: view.approvalRequestId, subjectDigest: view.subjectDigest, verdict: 'reject' }));
  });
});

// ── 3. Dual-store failure, recovery and rollback across restarts ─────────────────────

describe('AUTH-04A recovery — interrupted decisions are settled at restart from CORE-05, never re-decided', () => {
  const roleOf = (operatorId: string): OperatorRole | undefined => {
    const role = CTRL04_OPERATORS.find((operator) => operator.operatorId === operatorId)?.role;
    return isOperatorRole(role) ? role : undefined;
  };

  it('crash between consumption and CORE-05, and a lost reply after CORE-05: restart reconciles both; a replay never verdicts; rollback and loss are refused', async () => {
    const witness = await newWitness();
    const dir = workspace.dir();
    let booted = await boot(dir, witness);
    const org = await provisionOrganization(booted.baseUrl);
    const cto = await enrol(booted.authority, 'approver-a');

    // (1) Crash between the two stores: the challenge is consumed (the identity store's signed, witnessed row) and CORE-05 is never reached.
    const crashed = await pending(booted, org);
    const crashIssued = await booted.authority.decisions.begin({ operatorId: 'approver-a', approvalRequestId: crashed.view.approvalRequestId, subjectDigest: crashed.view.subjectDigest, verdict: 'approve' });
    const crashAssertion = cto.device.assert(crashIssued.options);
    await booted.authority.identity.authorizeDecision(crashAssertion);

    // (2) Reply lost after CORE-05 recorded the verdict.
    const lost = await pending(booted, org);
    const approvals = booted.host.enterprise.approvals as ApprovalCommandPort;
    const lossy = createHumanDecisionChannel({
      organizationId: ORG,
      approvals: {
        list: () => approvals.list(),
        approve: async (context, command) => {
          await approvals.approve(context, command);
          throw new ApprovalAuthorityError('APPROVAL_STORE_CLOSED', 'simulated loss of the reply after the CORE-05 append');
        },
        reject: (context, command) => approvals.reject(context, command),
      },
      identity: booted.authority.identity,
      roleOf,
    });
    const lostIssued = await lossy.begin({ operatorId: 'approver-a', approvalRequestId: lost.view.approvalRequestId, subjectDigest: lost.view.subjectDigest, verdict: 'approve' });
    await assert.rejects(lossy.decide(cto.device.assert(lostIssued.options)));
    assert.equal(booted.authority.identity.unsettledDecisions().length, 2, 'both decisions are consumed and unsettled');

    // Restart (no initialization): startup reconciliation settles each from CORE-05.
    await booted.host.close();
    const backup = `${identityPath(dir)}.backup`;
    copyFileSync(checkpointed(identityPath(dir)), backup);
    booted = await boot(dir, witness, { AOC_ENTERPRISE_HUMAN_AUTHORITY_INITIALIZE: 'false' });
    assert.equal(booted.host.posture.humanAuthority, 'composed');
    assert.equal(booted.authority.identity.unsettledDecisions().length, 0);
    assert.equal(booted.authority.identity.decision(crashIssued.commitment)?.outcome?.outcome, 'abandoned');
    assert.equal(booted.authority.identity.decision(lostIssued.commitment)?.outcome?.outcome, 'recorded');
    assert.equal((await booted.authority.decisions.outcome(crashIssued.commitment))?.state, 'not-recorded');
    assert.equal((await booted.authority.decisions.outcome(lostIssued.commitment))?.state, 'recorded');
    assert.equal((await verdictsOf(booted, crashed.view.approvalRequestId)).length, 0, 'no automatic verdict for the interrupted decision');
    assert.equal((await verdictsOf(booted, lost.view.approvalRequestId)).length, 1, 'exactly one verdict for the lost reply');
    // The consumed assertion never authorizes again.
    await identityRefused('HUMAN_IDENTITY_DECISION_CHALLENGE_CONSUMED', () => booted.authority.decisions.decide(crashAssertion));
    assert.equal((await verdictsOf(booted, crashed.view.approvalRequestId)).length, 0);
    // A fresh decision still works on the interrupted request.
    const retry = await booted.authority.decisions.begin({ operatorId: 'approver-a', approvalRequestId: crashed.view.approvalRequestId, subjectDigest: crashed.view.subjectDigest, verdict: 'approve' });
    assert.equal((await booted.authority.decisions.decide(cto.device.assert(retry.options))).outcome, 'recorded');

    // Rollback: restoring the identity file from before reconciliation and the retry is refused at startup.
    await booted.host.close();
    const current = `${identityPath(dir)}.current`;
    copyFileSync(checkpointed(identityPath(dir)), current);
    copyFileSync(backup, identityPath(dir));
    await refusedAtBoot('AUTHORITY_FRESHNESS_ROLLBACK_DETECTED', dir, witness, { AOC_ENTERPRISE_HUMAN_AUTHORITY_INITIALIZE: 'false' });

    // Loss: a deleted store is never re-initialized over the advanced witness slot, even with initialization requested.
    for (const suffix of ['', '-wal', '-shm']) if (existsSync(`${identityPath(dir)}${suffix}`)) rmSync(`${identityPath(dir)}${suffix}`);
    await refusedAtBoot('HUMAN_AUTHORITY_STORE_UNINITIALIZED', dir, witness, { AOC_ENTERPRISE_HUMAN_AUTHORITY_INITIALIZE: 'false' });
    await refusedAtBoot('AUTHORITY_FRESHNESS_ROLLBACK_DETECTED', dir, witness, { AOC_ENTERPRISE_HUMAN_AUTHORITY_INITIALIZE: 'true' });

    // Restoring the newest copy recovers.
    for (const suffix of ['', '-wal', '-shm']) if (existsSync(`${identityPath(dir)}${suffix}`)) rmSync(`${identityPath(dir)}${suffix}`);
    copyFileSync(current, identityPath(dir));
    booted = await boot(dir, witness, { AOC_ENTERPRISE_HUMAN_AUTHORITY_INITIALIZE: 'false' });
    assert.equal(booted.authority.identity.decision(retry.commitment)?.outcome?.outcome, 'recorded');
    await booted.host.close();
  });

  it('witness unavailable during a decision: nothing is consumed into a verdict, CORE-05 records nothing', async () => {
    const witness = await newWitness();
    const dir = workspace.dir();
    const booted = await boot(dir, witness);
    const org = await provisionOrganization(booted.baseUrl);
    const cto = await enrol(booted.authority, 'approver-a');
    const { view } = await pending(booted, org);
    const issued = await booted.authority.decisions.begin({ operatorId: 'approver-a', approvalRequestId: view.approvalRequestId, subjectDigest: view.subjectDigest, verdict: 'approve' });
    await witness.close();
    await assert.rejects(booted.authority.decisions.decide(cto.device.assert(issued.options)));
    await booted.host.close();
    // Read back from the files, read-only: no verdict row exists, and no decision was authorized.
    const approvalsDb = new Database(join(dir, 'approvals.sqlite'), { readonly: true });
    const verdicts = approvalsDb.prepare("SELECT count(*) AS n FROM approval_records WHERE kind <> 'requested'").get() as { n: number };
    approvalsDb.close();
    assert.equal(verdicts.n, 0, 'no verdict without a witnessed consumption');
    const identityDb = new Database(identityPath(dir), { readonly: true });
    const decided = identityDb.prepare("SELECT count(*) AS n FROM human_identity_records WHERE kind = 'decision_authorized'").get() as { n: number };
    identityDb.close();
    assert.equal(decided.n, 0, 'the challenge was not consumed locally');
  });
});
