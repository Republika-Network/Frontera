import { spawnSync } from 'node:child_process';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, truncateSync, unlinkSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import Database from 'better-sqlite3';

import type { ApprovalCommandPort } from '../approval-authority/index.js';
import { AUTHORITY_CSRF_HEADER } from '../authority-gateway/index.js';
import { createSoftwareAuthorityArtifactSigner } from '../authority-authenticity/index.js';
import { humanIdentityRowDigest, nextHumanIdentityChainDigest } from '../human-identity/chain.js';
import { INTENDED_PRODUCTION_RP_ID, identityAdministratorFor, type AuthenticationOptionsJSON, type RegistrationOptionsJSON } from '../human-identity/index.js';
import { AUTHORITY_KEY_A } from './authority-authenticity-fixture.js';
import { SoftwareAuthenticator } from './auth02-software-authenticator.js';
import { witnessRows } from './core07-freshness-fixture.js';
import { call, expectStatus, recordingAdapter } from './ctrl02-host-fixture.js';
import {
  DEPLOY,
  EDGE,
  LEGACY,
  ORG,
  PROD,
  RELEASE,
  STAGING,
  approvalCommand,
  approvalFor,
  approverStanding,
  authFor,
  bootProd02,
  bootRefusal,
  bootstrap,
  createDeployment,
  govern,
  key,
  onboard,
  portability,
  release,
  secretsFound,
  transition,
  type BootedProd02,
  type Deployment,
} from './prod02-recovery-fixture.js';

/**
 * AUTH-04D1 — the Authority pilot backup profile against CORE-07, on the
 * canonical shipped Host (production profile, software custody, a reference
 * witness in its own process and directory, the human-decision authority and
 * its gateway enabled).
 *
 * The profile (`scripts/portability/authority-pilot-backup.mjs`) is backup:v1
 * (now covering the signed human identity store) sealed with AES-256-GCM, plus
 * an explicit verification. These drills prove the restore semantics the
 * founder asked for: a current snapshot recovers; a truncated, corrupted,
 * forged or foreign one refuses; an older identity state refuses once the
 * surviving witness has advanced, so a revoked passkey and a consumed decision
 * challenge cannot come back; an unreachable or missing witness fails closed;
 * and the witness itself is never touched. Software authenticators only — no
 * real device is claimed.
 */

type Env = Record<string, string | undefined>;

interface SignedHead {
  storeId: string;
  organizationId: string | null;
  sequence: number;
  stateDigest: string;
  signingKeyId: string | null;
  freshnessStateKind: string | null;
}
type SealedAuthorityStore = SignedHead & { readonly name: string };
interface StoreEntry {
  name: string;
  filename: string;
  checksum: string;
  sizeBytes: number;
  signedHead?: SignedHead;
}
interface BackupManifest {
  backupId: string;
  stores: StoreEntry[];
  [field: string]: unknown;
}

interface AuthorityPilotProfile {
  readonly runAuthorityPilotBackup: (options: { readonly output: string; readonly keyFile: string; readonly env: Env }) => Promise<Record<string, unknown>>;
  readonly runAuthorityPilotVerify: (options: { readonly archive: string; readonly keyFile: string; readonly env: Env }) => Promise<Record<string, unknown>>;
  readonly runAuthorityPilotRestore: (options: { readonly archive: string; readonly keyFile: string; readonly target: string; readonly env: Env; readonly force?: boolean }) => Promise<Record<string, unknown>>;
  readonly inspectSealedBackup: (archive: string) => Record<string, unknown>;
  readonly authorityBinding: (manifest: BackupManifest) => Record<string, unknown>;
}
interface SealedLibrary {
  readonly generateBackupKey: (path: string) => { readonly keyId: string };
  readonly readBackupKey: (path: string) => Buffer;
  readonly sealBackupSet: (options: { readonly sourceDir: string; readonly outputFile: string; readonly key: Buffer; readonly header: Record<string, unknown> }) => { readonly sha256: string };
  readonly unsealBackupSet: (options: { readonly sealedFile: string; readonly key: Buffer; readonly outputDir: string }) => { readonly header: Record<string, unknown> };
}

const PROFILE_SCRIPT = resolve('scripts/portability/authority-pilot-backup.mjs');
let modules: { readonly profile: AuthorityPilotProfile; readonly sealed: SealedLibrary } | undefined;
async function tooling(): Promise<{ readonly profile: AuthorityPilotProfile; readonly sealed: SealedLibrary }> {
  if (modules === undefined) {
    const profile = (await import(pathToFileURL(PROFILE_SCRIPT).href)) as AuthorityPilotProfile;
    const sealed = (await import(pathToFileURL(resolve('scripts/portability/lib-sealed-backup.mjs')).href)) as SealedLibrary;
    modules = { profile, sealed };
  }
  return modules;
}

const ORIGIN = `https://${INTENDED_PRODUCTION_RP_ID}`;
const deployments: Deployment[] = [];
const hosts: BootedProd02[] = [];
after(async () => {
  for (const booted of hosts) await booted.host.close().catch(() => {});
  for (const deployment of deployments) await deployment.close().catch(() => {});
});

/** The Host environment of the Authority pilot: the PROD-02 secure deployment plus the human-decision authority and its gateway, every store under `dataDir`. */
async function authorityEnv(deployment: Deployment, dataDir: string, overrides: Env = {}): Promise<Env> {
  const { registry } = await portability();
  return {
    ...deployment.envFor(dataDir),
    ...registry.storeEnvironmentFor(dataDir, { humanAuthorityEnabled: true }),
    AOC_ENTERPRISE_HUMAN_AUTHORITY_MODE: 'enabled',
    AOC_ENTERPRISE_HUMAN_AUTHORITY_RP_ID: INTENDED_PRODUCTION_RP_ID,
    AOC_ENTERPRISE_HUMAN_AUTHORITY_ALLOWED_ORIGINS: ORIGIN,
    AOC_ENTERPRISE_HUMAN_AUTHORITY_INITIALIZE: 'false',
    AOC_ENTERPRISE_AUTHORITY_GATEWAY_MODE: 'enabled',
    AOC_ENTERPRISE_AUTHORITY_GATEWAY_HOST: '127.0.0.1',
    AOC_ENTERPRISE_AUTHORITY_GATEWAY_PORT: '0',
    AOC_ENTERPRISE_AUTHORITY_GATEWAY_PUBLIC_ORIGIN: ORIGIN,
    ...overrides,
  };
}

async function boot(env: Env): Promise<BootedProd02 & { readonly gatewayPort: number }> {
  const booted = await bootProd02(env);
  hosts.push(booted);
  const gatewayPort = booted.host.authorityGateway?.address()?.port;
  assert.ok(gatewayPort !== undefined, 'the Authority gateway listens');
  return { ...booted, gatewayPort };
}

async function close(booted: BootedProd02): Promise<void> {
  await booted.host.close();
  const index = hosts.findIndex((entry) => entry.host === booted.host);
  if (index >= 0) hosts.splice(index, 1);
}

/** A deployment directory that exists (sealed files and keys are created exclusively inside an existing directory). */
function made(deployment: Deployment, name: string): string {
  const dir = deployment.dir(name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

const refusalCode = (error: Error): unknown => (error as Error & { code?: unknown }).code;

// ── the named human on the gateway (a loopback CI fixture; no DNS, no TLS) ─────────────

interface Reply {
  readonly status: number;
  readonly body: Record<string, unknown>;
  readonly text: string;
}

class Browser {
  private readonly jar = new Map<string, string>();
  private csrf: string | undefined;
  constructor(private readonly port: number) {}

  async send(method: 'GET' | 'POST', path: string, body?: unknown): Promise<Reply> {
    const payload = body !== undefined ? JSON.stringify(body) : method === 'POST' ? '{}' : undefined;
    const headers: Record<string, string> = {
      host: INTENDED_PRODUCTION_RP_ID,
      ...(method === 'POST' ? { origin: ORIGIN, 'content-type': 'application/json' } : {}),
      ...(this.csrf !== undefined ? { [AUTHORITY_CSRF_HEADER]: this.csrf } : {}),
      ...(this.jar.size > 0 ? { cookie: [...this.jar].map(([name, value]) => `${name}=${value}`).join('; ') } : {}),
    };
    const reply = await new Promise<{ status: number; text: string; setCookies: string[] }>((resolvePromise, rejectPromise) => {
      const req = request({ host: '127.0.0.1', port: this.port, method, path, headers }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => resolvePromise({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8'), setCookies: res.headers['set-cookie'] ?? [] }));
      });
      req.on('error', rejectPromise);
      if (payload !== undefined) req.write(payload);
      req.end();
    });
    for (const header of reply.setCookies) {
      const pair = header.split(';')[0] ?? '';
      const index = pair.indexOf('=');
      if (/Max-Age=0/.test(header) || pair.slice(index + 1) === '') this.jar.delete(pair.slice(0, index));
      else this.jar.set(pair.slice(0, index), pair.slice(index + 1));
    }
    let parsed: Record<string, unknown> = {};
    try {
      parsed = JSON.parse(reply.text) as Record<string, unknown>;
    } catch {
      parsed = {};
    }
    return { status: reply.status, text: reply.text, body: parsed };
  }

  async signIn(device: SoftwareAuthenticator): Promise<Reply> {
    const options = await this.send('POST', '/authority/v1/session/login/options');
    assert.equal(options.status, 200, options.text);
    const reply = await this.send('POST', '/authority/v1/session/login', { assertion: device.assert(options.body['publicKey'] as AuthenticationOptionsJSON) });
    if (reply.status === 200) this.csrf = reply.body['csrfToken'] as string;
    return reply;
  }
}

async function enrol(booted: BootedProd02 & { readonly gatewayPort: number }, administrator: string, operatorId: string): Promise<SoftwareAuthenticator> {
  const issued = expectStatus(await call(booted.baseUrl, 'POST', '/api/admin/passkey-invitations', { authorization: administrator, body: { operatorId } }), 200, 'invitation');
  const token = (issued.body['invitation'] as Record<string, unknown>)['token'] as string;
  const device = new SoftwareAuthenticator({ origin: ORIGIN });
  const browser = new Browser(booted.gatewayPort);
  const options = await browser.send('POST', '/authority/v1/enrolment/options', { invitation: token });
  assert.equal(options.status, 200, options.text);
  const registered = await browser.send('POST', '/authority/v1/enrolment', { invitation: token, credential: device.register(options.body['publicKey'] as RegistrationOptionsJSON) });
  assert.equal(registered.status, 201, registered.text);
  return device;
}

async function pendingApproval(booted: BootedProd02, agentCredential: string): Promise<{ readonly idempotencyKey: string; readonly approvalRequestId: string; readonly subjectDigest: string }> {
  const idempotencyKey = key('auth04d1');
  const reply = await govern(booted.baseUrl, agentCredential, release(PROD, idempotencyKey));
  assert.deepEqual([reply.body['status'], reply.body['withheldBy']], ['withheld', 'approval'], reply.text);
  const view = (await (booted.host.enterprise.approvals as ApprovalCommandPort).list()).find((candidate) => candidate.requestId === reply.body['requestId']);
  assert.ok(view !== undefined);
  return { idempotencyKey, approvalRequestId: view.approvalRequestId, subjectDigest: view.subjectDigest };
}

const verdictsOn = async (booted: BootedProd02, approvalRequestId: string): Promise<number> =>
  ((await (booted.host.enterprise.approvals as ApprovalCommandPort).list()).find((view) => view.approvalRequestId === approvalRequestId)?.state.verdicts.length ?? 0);

// ── backup-set surgery, as an attacker who controls the backup storage AND holds the backup key ──

const sha256Hex = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex');

function readSetManifest(set: string): BackupManifest {
  const manifest: BackupManifest = JSON.parse(readFileSync(join(set, 'backup-manifest.json'), 'utf8'));
  return manifest;
}

/**
 * Makes the manifest and checksums describe the files as they now are — what a
 * storage-level attacker can always do (backups are checksummed, not signed).
 * `head`: also record the identity store's current signed head.
 */
function rewriteManifest(set: string, storeName: string, head: boolean): BackupManifest {
  const manifest = readSetManifest(set);
  const entry = manifest.stores.find((store) => store.name === storeName);
  assert.ok(entry !== undefined, storeName);
  const file = join(set, 'stores', entry.filename);
  entry.checksum = `sha256:${sha256Hex(file)}`;
  entry.sizeBytes = statSync(file).size;
  if (head && entry.signedHead !== undefined) {
    const db = new Database(file, { readonly: true });
    try {
      const head = db.prepare('SELECT sequence, chain_digest, signature_json FROM human_identity_head WHERE id = 1').get() as { sequence: number; chain_digest: string; signature_json: string } | undefined;
      if (head !== undefined) {
        entry.signedHead.sequence = head.sequence;
        entry.signedHead.stateDigest = head.chain_digest;
      }
    } finally {
      db.close();
    }
  }
  writeFileSync(join(set, 'backup-manifest.json'), JSON.stringify(manifest, null, 2));
  const lines = readFileSync(join(set, 'checksums.sha256'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => {
      const path = line.slice(line.indexOf('  ') + 2);
      return `${sha256Hex(join(set, path))}  ${path}`;
    });
  writeFileSync(join(set, 'checksums.sha256'), `${lines.join('\n')}\n`);
  return manifest;
}

async function unseal(deployment: Deployment, sealedFile: string, keyFile: string, name: string): Promise<string> {
  const { sealed } = await tooling();
  const outputDir = join(made(deployment, name), 'set');
  sealed.unsealBackupSet({ sealedFile, key: sealed.readBackupKey(keyFile), outputDir });
  return outputDir;
}

/** Seals `set` again with the real key. `header`: the public header to bind; by default the one the profile itself would derive. */
async function reseal(deployment: Deployment, set: string, keyFile: string, name: string, header?: Record<string, unknown>): Promise<string> {
  const { profile, sealed } = await tooling();
  const outputFile = join(made(deployment, name), 'pilot.sealed');
  sealed.sealBackupSet({ sourceDir: set, outputFile, key: sealed.readBackupKey(keyFile), header: header ?? { ...profile.authorityBinding(readSetManifest(set)), sealedAt: new Date().toISOString() } });
  return outputFile;
}

const storeFilesIn = (dir: string): string[] => (existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith('.sqlite')) : []);
const leftoverWorkDirs = (): string[] => readdirSync(tmpdir()).filter((name) => name.startsWith('frontera-authority-pilot-'));

// ── the drill ───────────────────────────────────────────────────────────────────────────

describe('AUTH-04D1 — Authority pilot backup and restore under CORE-07 (software authenticators; no real device)', () => {
  let deployment: Deployment;
  let auth: ReturnType<typeof authFor>;
  let agentCredential: string;
  let keyFile: string;
  let data: string;
  let cto: SoftwareAuthenticator;
  let lostDevice: SoftwareAuthenticator;
  let backupBeforeRevocation: string;
  let backupCurrent: string;
  let decided: { readonly approvalRequestId: string; readonly idempotencyKey: string; readonly commitment: string; readonly assertion: Record<string, unknown> };
  let witnessAfterBackup: readonly Record<string, unknown>[];

  it('builds the pilot state on the real Host: a CTO and a second device enrolled through invitations; the profile refuses a running Host and a deployment without the authority', async () => {
    deployment = await createDeployment('software');
    deployments.push(deployment);
    auth = authFor(deployment.secrets);
    data = deployment.dir('data');
    keyFile = join(made(deployment, 'backup-key'), 'authority-pilot.key');
    const { profile, sealed } = await tooling();
    sealed.generateBackupKey(keyFile);

    const host = await boot(await authorityEnv(deployment, data, { AOC_ENTERPRISE_HUMAN_AUTHORITY_INITIALIZE: 'true' }));
    assert.equal(host.host.posture.humanAuthority, 'composed');
    await bootstrap(host.baseUrl, auth);
    await transition(host.baseUrl, auth, 'release-production', 'activate');
    await approverStanding(host.baseUrl, auth, 'approver-a');
    agentCredential = (await onboard(host.baseUrl, auth, { agentId: RELEASE, subjectId: 'release-auth04d1', actions: [DEPLOY], resources: [PROD, LEGACY, EDGE, STAGING] })).credential;
    expectStatus(await call(host.baseUrl, 'POST', '/api/admin/passkey-humans', { authorization: auth.administrator, body: { operatorId: 'approver-a', displayName: 'CTO (synthetic)' } }), 200, 'register the human');
    cto = await enrol(host, auth.administrator, 'approver-a');
    lostDevice = await enrol(host, auth.administrator, 'approver-a');

    // A running Host is refused (non-empty WAL): the Authority pilot backup is cold only.
    const running = join(deployment.dir('refused-running'), 'pilot.sealed');
    await assert.rejects(profile.runAuthorityPilotBackup({ output: running, keyFile, env: await authorityEnv(deployment, data) }), /--cold was requested/);
    assert.equal(existsSync(running), false);
    await close(host);
    // A deployment without the human-decision authority is not this profile's.
    await assert.rejects(profile.runAuthorityPilotBackup({ output: running, keyFile, env: deployment.envFor(data) }), /AOC_ENTERPRISE_HUMAN_AUTHORITY_MODE=enabled/);
    assert.deepEqual(leftoverWorkDirs(), [], 'no plaintext work directory survives a refusal');
  });

  it('backup S0 (both passkeys active) → a decision and a revocation → backup S1, through the CLI: cold, complete, sealed, bound to the organization and the witnessed heads; no secret, passkey or subject in any byte', async () => {
    const { profile } = await tooling();
    backupBeforeRevocation = join(made(deployment, 'backup-s0'), 'pilot.sealed');
    await profile.runAuthorityPilotBackup({ output: backupBeforeRevocation, keyFile, env: await authorityEnv(deployment, data) });

    // S0 → S1: the CTO approves through the gateway with a fresh assertion; the second device is revoked (reported lost).
    const host = await boot(await authorityEnv(deployment, data));
    const pending = await pendingApproval(host, agentCredential);
    const browser = new Browser(host.gatewayPort);
    assert.equal((await browser.signIn(cto)).status, 200);
    const issued = await browser.send('POST', `/authority/v1/approvals/${encodeURIComponent(pending.approvalRequestId)}/decision-challenges`, { subjectDigest: pending.subjectDigest, verdict: 'approve' });
    assert.equal(issued.status, 200, issued.text);
    const assertion = cto.assert(issued.body['publicKey'] as AuthenticationOptionsJSON);
    const outcome = await browser.send('POST', '/authority/v1/decisions', { assertion });
    assert.deepEqual([outcome.status, outcome.body['outcome'], outcome.body['execution']], [200, 'recorded', 'not_observed'], outcome.text);
    decided = { approvalRequestId: pending.approvalRequestId, idempotencyKey: pending.idempotencyKey, commitment: issued.body['commitment'] as string, assertion };
    const authority = host.host.enterprise.humanAuthority;
    assert.ok(authority !== undefined);
    await authority.identity.revokeCredential(
      identityAdministratorFor({ plane: 'operator', operatorId: 'ops-admin', organizationId: ORG, role: 'organization-administrator', credentialClass: 'operator', actorRef: 'operator:ops-admin' }),
      lostDevice.id,
      'device reported lost',
    );
    await close(host);

    // S1, through the CLI exactly as an operator runs it.
    backupCurrent = join(made(deployment, 'backup-s1'), 'pilot.sealed');
    const env = await authorityEnv(deployment, data);
    const cli = spawnSync(process.execPath, [PROFILE_SCRIPT, 'backup', '--output', backupCurrent, '--key-file', keyFile], { env: env as NodeJS.ProcessEnv, encoding: 'utf8' });
    assert.equal(cli.status, 0, cli.stderr);
    const report = JSON.parse(cli.stdout) as Record<string, unknown>;
    assert.deepEqual([report['status'], report['organizationId'], report['consistency'], report['coverageComplete']], ['sealed', ORG, 'cold-attested', true]);
    witnessAfterBackup = await witnessRows(deployment.witness.databasePath);

    // The public header (no key needed) binds the organization, the store ids and the signed heads the surviving witness holds.
    const header = profile.inspectSealedBackup(backupCurrent);
    const stores = header['authorityStores'] as readonly SealedAuthorityStore[];
    for (const store of stores) {
      const slot = witnessAfterBackup.find((row) => row['state_kind'] === store.freshnessStateKind);
      assert.ok(slot !== undefined, `${store.name} is anchored`);
      assert.deepEqual([slot['store_id'], slot['committed_sequence'], slot['committed_digest']], [store.storeId, store.sequence, store.stateDigest], `${store.name}: sealed head = witnessed head`);
    }
    assert.ok(stores.some((store) => store.name === 'human-identity'));
    const older = (profile.inspectSealedBackup(backupBeforeRevocation)['authorityStores'] as readonly SealedAuthorityStore[]).find((store) => store.name === 'human-identity');
    const newer = stores.find((store) => store.name === 'human-identity');
    assert.ok(older !== undefined && newer !== undefined && older.sequence < newer.sequence, 'the decision and the revocation advanced the identity head');

    // Confidentiality and secrecy: no secret value, no backup key, no passkey id, no operator or subject in the sealed file, the header or the CLI output.
    const sealedBytes = readFileSync(backupCurrent);
    const keyHex = readFileSync(keyFile, 'utf8').trim();
    const forbidden = [...deployment.secretValues(), keyHex, cto.id, lostDevice.id, decided.approvalRequestId, 'approver-a', 'release-2026-10-02'];
    for (const value of forbidden) assert.equal(sealedBytes.includes(Buffer.from(value)), false, `sealed file holds '${value.slice(0, 12)}…'`);
    assert.deepEqual(secretsFound(deployment.dir('backup-s1'), [...deployment.secretValues(), keyHex], [cli.stdout, cli.stderr]), []);
    for (const value of [cto.id, 'approver-a']) assert.equal(JSON.stringify(header).includes(value), false, 'the public header names no human or passkey');
    assert.deepEqual(leftoverWorkDirs(), [], 'plaintext lived only in a private work directory, now removed');
  });

  it('explicit verification under the trusted keys, without touching the witness; a valid current snapshot restores and the Host starts on it', async () => {
    const { profile } = await tooling();
    const verified = await profile.runAuthorityPilotVerify({ archive: backupCurrent, keyFile, env: await authorityEnv(deployment, deployment.dir('verify-scratch')) });
    assert.equal(verified['status'], 'verified');
    const verification = verified['objectVerification'] as Record<string, Record<string, unknown>>;
    for (const name of ['human-identity', 'approvals', 'bounded-grants']) assert.equal(verification[name]?.['authenticity'], 'verified-under-trusted-keys', name);

    const restoredDir = deployment.dir('restored-s1');
    const report = await profile.runAuthorityPilotRestore({ archive: backupCurrent, keyFile, target: restoredDir, env: await authorityEnv(deployment, restoredDir) });
    assert.equal(report['status'], 'restored');
    assert.ok((report['targets'] as { store: string }[]).some((target) => target.store === 'human-identity'));
    assert.deepEqual(await witnessRows(deployment.witness.databasePath), witnessAfterBackup, 'verification and restore never touched the witness');

    const host = await boot(await authorityEnv(deployment, restoredDir));
    assert.equal(host.host.posture.authorityFreshness, 'external');
    assert.equal(host.host.posture.humanAuthority, 'composed');
    const authority = host.host.enterprise.humanAuthority;
    assert.ok(authority !== undefined);

    // A consumed decision challenge stays consumed: the old assertion replayed into the restored store is refused, and CORE-05 keeps one verdict.
    await assert.rejects(authority.decisions.decide(decided.assertion), (error: unknown) => (error as { code?: unknown }).code === 'HUMAN_IDENTITY_DECISION_CHALLENGE_CONSUMED' || assert.fail(String((error as { code?: unknown }).code)));
    assert.equal(await verdictsOn(host, decided.approvalRequestId), 1);
    // The revoked passkey stays revoked; the CTO's passkey works.
    const lost = await new Browser(host.gatewayPort).signIn(lostDevice);
    assert.notEqual(lost.status, 200, lost.text);
    const browser = new Browser(host.gatewayPort);
    assert.equal((await browser.signIn(cto)).status, 200, 'the CTO signs in on the recovered Host (this advances the witnessed identity head)');
    const status = await browser.send('GET', `/authority/v1/decisions/${encodeURIComponent(decided.commitment)}`);
    assert.deepEqual([status.body['decision'], status.body['execution']], ['approved', 'not_observed'], status.text);
    // Execution evidence is separate: the agent resumes through the canonical path, exactly once.
    const resumed = await govern(host.baseUrl, agentCredential, release(PROD, decided.idempotencyKey));
    assert.equal(resumed.body['status'], 'executed', resumed.text);
    assert.equal(host.adapter.calls.length, 1);
    await close(host);
  });

  it('an older identity state refuses once the surviving witness has advanced: the pre-revocation backup (which would resurrect the lost passkey) and even S1 after one more sign-in', async () => {
    const { profile } = await tooling();
    const witnessBefore = await witnessRows(deployment.witness.databasePath);
    // S0 holds the lost device as active — exactly what restoring it would resurrect.
    const s0 = await unseal(deployment, backupBeforeRevocation, keyFile, 'inspect-s0');
    const s0Identity = new Database(join(s0, 'stores', 'human-identity.sqlite'), { readonly: true });
    try {
      assert.equal((s0Identity.prepare(`SELECT COUNT(*) AS n FROM human_identity_records WHERE kind = 'credential_revoked'`).get() as { n: number }).n, 0, 'S0 holds the lost passkey as active');
    } finally {
      s0Identity.close();
    }
    for (const [name, archive] of [
      ['S0 (before the revocation and the decision)', backupBeforeRevocation],
      ['S1 (before the recovered Host’s sign-in)', backupCurrent],
    ] as const) {
      const target = deployment.dir(`stale-${name.slice(0, 2)}`);
      const report = await profile.runAuthorityPilotRestore({ archive, keyFile, target, env: await authorityEnv(deployment, target) });
      assert.equal(report['status'], 'restored', 'restore cannot know freshness; the Host decides at startup against the surviving witness');
      const adapter = recordingAdapter();
      const refused = await bootRefusal(await authorityEnv(deployment, target), adapter);
      assert.equal(refusalCode(refused), 'AUTHORITY_FRESHNESS_ROLLBACK_DETECTED', `${name}: ${refused.message}`);
      assert.equal(adapter.calls.length, 0, 'no authority was handed out');
    }
    assert.deepEqual(await witnessRows(deployment.witness.databasePath), witnessBefore, 'nothing reset, rebound or re-enrolled the witness');
  });

  it('a stale identity store alone, inside an otherwise current restore, is refused; so is a stale approval store', async () => {
    const { profile } = await tooling();
    // The current state is the recovered Host's: back it up (cold, the Host is stopped).
    const recovered = deployment.dir('restored-s1');
    const current = join(made(deployment, 'backup-s2'), 'pilot.sealed');
    await profile.runAuthorityPilotBackup({ output: current, keyFile, env: await authorityEnv(deployment, recovered) });
    backupCurrent = current;
    const s0 = await unseal(deployment, backupBeforeRevocation, keyFile, 'mixed-source');
    for (const store of ['human-identity', 'approvals']) {
      const target = deployment.dir(`mixed-${store}`);
      await profile.runAuthorityPilotRestore({ archive: current, keyFile, target, env: await authorityEnv(deployment, target) });
      writeFileSync(join(target, `${store}.sqlite`), readFileSync(join(s0, 'stores', `${store}.sqlite`)));
      const adapter = recordingAdapter();
      const refused = await bootRefusal(await authorityEnv(deployment, target), adapter);
      assert.equal(refusalCode(refused), 'AUTHORITY_FRESHNESS_ROLLBACK_DETECTED', `${store}: ${refused.message}`);
      assert.equal(adapter.calls.length, 0);
    }
  });

  it('a forged identity head (an attacker passkey inserted and re-signed with an untrusted key under the trusted key id), with manifest, checksums and seal all rewritten, refuses before the target is touched', async () => {
    const { profile } = await tooling();
    const set = await unseal(deployment, backupCurrent, keyFile, 'forged');
    const file = join(set, 'stores', 'human-identity.sqlite');
    const { privateKey } = generateKeyPairSync('ed25519');
    const attacker = createSoftwareAuthorityArtifactSigner({ keyId: AUTHORITY_KEY_A.keyId, algorithm: 'ed25519-v1', privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() });
    const db = new Database(file);
    try {
      const meta = db.prepare('SELECT store_id FROM human_identity_meta WHERE id = 1').get() as { store_id: string };
      const head = db.prepare('SELECT sequence, chain_digest FROM human_identity_head WHERE id = 1').get() as { sequence: number; chain_digest: string };
      const content = { organizationId: ORG, kind: 'credential_registered' as const, operatorId: 'approver-a', objectId: 'attacker-credential', payload: '{}', recordedBy: 'webauthn-ceremony', recordedAt: new Date().toISOString() };
      const sequence = head.sequence + 1;
      const digest = humanIdentityRowDigest(meta.store_id, sequence, content);
      const next = { storeId: meta.store_id, organizationId: ORG, sequence, chainDigest: nextHumanIdentityChainDigest(head.chain_digest, digest) };
      assert.ok(attacker.signHumanIdentityState !== undefined);
      const signature = await attacker.signHumanIdentityState(next);
      db.prepare('INSERT INTO human_identity_records (sequence, organization_id, kind, operator_id, object_id, payload, recorded_by, recorded_at, row_digest) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(sequence, ORG, content.kind, content.operatorId, content.objectId, content.payload, content.recordedBy, content.recordedAt, digest);
      db.prepare('UPDATE human_identity_head SET sequence = ?, chain_digest = ?, signature_json = ? WHERE id = 1').run(sequence, next.chainDigest, JSON.stringify(signature));
      db.pragma('journal_mode = DELETE');
    } finally {
      db.close();
    }
    rewriteManifest(set, 'human-identity', true);
    const forged = await reseal(deployment, set, keyFile, 'forged-sealed');
    const target = deployment.dir('forged-target');
    await assert.rejects(profile.runAuthorityPilotVerify({ archive: forged, keyFile, env: await authorityEnv(deployment, deployment.dir('forged-verify')) }), /human-identity.*(not authentic|does not open)/s);
    await assert.rejects(profile.runAuthorityPilotRestore({ archive: forged, keyFile, target, env: await authorityEnv(deployment, target) }), /human-identity.*(not authentic|does not open)/s);
    assert.deepEqual(storeFilesIn(target), [], 'the target was never touched');
  });

  it('a truncated or corrupted snapshot refuses: at the seal without the key, and inside the seal with it', async () => {
    const { profile } = await tooling();
    // Without the key: truncation and a flipped byte fail authentication.
    const bytes = readFileSync(backupCurrent);
    for (const [name, variant] of [
      ['truncated', bytes.subarray(0, Math.floor(bytes.length / 2))],
      ['flipped', Buffer.from(bytes.map((byte, index) => (index === bytes.length - 100 ? byte ^ 0xff : byte)))],
    ] as const) {
      const file = join(made(deployment, `damaged-${name}`), 'pilot.sealed');
      writeFileSync(file, variant);
      const target = deployment.dir(`damaged-${name}-target`);
      await assert.rejects(profile.runAuthorityPilotRestore({ archive: file, keyFile, target, env: await authorityEnv(deployment, target) }), /does not authenticate|truncated/);
      assert.deepEqual(storeFilesIn(target), []);
    }
    // With the key: a store file cut in half, its checksums recomputed, sealed again.
    const set = await unseal(deployment, backupCurrent, keyFile, 'cut');
    const file = join(set, 'stores', 'human-identity.sqlite');
    truncateSync(file, Math.floor(statSync(file).size / 2));
    rewriteManifest(set, 'human-identity', false);
    const cut = await reseal(deployment, set, keyFile, 'cut-sealed');
    const target = deployment.dir('cut-target');
    await assert.rejects(profile.runAuthorityPilotRestore({ archive: cut, keyFile, target, env: await authorityEnv(deployment, target) }), /human-identity/);
    assert.deepEqual(storeFilesIn(target), []);
    // And without the identity store at all, under the original (complete) header: refused as incomplete.
    const missing = await unseal(deployment, backupCurrent, keyFile, 'missing');
    unlinkSync(join(missing, 'stores', 'human-identity.sqlite'));
    const manifest = readSetManifest(missing);
    manifest.stores = manifest.stores.filter((store) => store.name !== 'human-identity');
    writeFileSync(join(missing, 'backup-manifest.json'), JSON.stringify(manifest));
    const withoutIdentity = await reseal(deployment, missing, keyFile, 'missing-sealed', profile.inspectSealedBackup(backupCurrent));
    const missingTarget = deployment.dir('missing-target');
    await assert.rejects(profile.runAuthorityPilotRestore({ archive: withoutIdentity, keyFile, target: missingTarget, env: await authorityEnv(deployment, missingTarget) }), /does not include the signed 'human-identity' store/);
    assert.deepEqual(storeFilesIn(missingTarget), []);
  });

  it('a wrong-organization restore is refused', async () => {
    const { profile } = await tooling();
    const target = deployment.dir('foreign-target');
    await assert.rejects(
      profile.runAuthorityPilotRestore({ archive: backupCurrent, keyFile, target, env: await authorityEnv(deployment, target, { AOC_ENTERPRISE_KERNEL_AUTHORITY_ORGANIZATION_ID: 'org-other' }) }),
      /belongs to organization 'org-prod02', but the restoring deployment serves 'org-other'/,
    );
    assert.deepEqual(storeFilesIn(target), []);
  });

  it('an unreachable or missing witness fails closed; with the surviving witness the same restore starts', async () => {
    const { profile } = await tooling();
    const target = deployment.dir('witness-target');
    await profile.runAuthorityPilotRestore({ archive: backupCurrent, keyFile, target, env: await authorityEnv(deployment, target) });
    const adapter = recordingAdapter();
    const unreachable = await bootRefusal(await authorityEnv(deployment, target, { AOC_ENTERPRISE_AUTHORITY_FRESHNESS_ENDPOINT: 'http://127.0.0.1:9' }), adapter);
    assert.equal(refusalCode(unreachable), 'AUTHORITY_FRESHNESS_UNAVAILABLE', unreachable.message);
    const missing = await bootRefusal(
      await authorityEnv(deployment, target, {
        AOC_ENTERPRISE_AUTHORITY_FRESHNESS_MODE: undefined,
        AOC_ENTERPRISE_AUTHORITY_FRESHNESS_ENDPOINT: undefined,
        AOC_ENTERPRISE_AUTHORITY_FRESHNESS_TOKEN: undefined,
        AOC_ENTERPRISE_AUTHORITY_FRESHNESS_WITNESS_ID: undefined,
        AOC_ENTERPRISE_AUTHORITY_FRESHNESS_WITNESS_PUBLIC_KEY: undefined,
      }),
      adapter,
    );
    assert.equal(refusalCode(missing), 'HOST_AUTHORITY_FRESHNESS_REQUIRED', missing.message);
    assert.equal(adapter.calls.length, 0);
    const host = await boot(await authorityEnv(deployment, target));
    assert.equal(host.host.posture.humanAuthority, 'composed');
    await close(host);
  });

  it('availability: a lost identity file over an advanced witness slot is never recreated; disabling the human authority restores the rest of the Host, where CTRL-04 operators still decide', async () => {
    const target = deployment.dir('witness-target');
    const witnessBefore = await witnessRows(deployment.witness.databasePath);
    unlinkSync(join(target, 'human-identity.sqlite'));
    const adapter = recordingAdapter();
    const refused = await bootRefusal(await authorityEnv(deployment, target, { AOC_ENTERPRISE_HUMAN_AUTHORITY_INITIALIZE: 'true' }), adapter);
    assert.equal(refusalCode(refused), 'AUTHORITY_FRESHNESS_ROLLBACK_DETECTED', refused.message);
    assert.equal(adapter.calls.length, 0);
    // Degraded but safe: the Host without the human-decision authority. Nothing is widened: no passkey decides anything.
    const degraded = await bootProd02(deployment.envFor(target));
    hosts.push(degraded);
    assert.equal(degraded.host.enterprise.humanAuthority, undefined);
    const pending = await govern(degraded.baseUrl, agentCredential, release(PROD, key('auth04d1-degraded')));
    assert.deepEqual([pending.body['status'], pending.body['withheldBy']], ['withheld', 'approval'], pending.text);
    const view = await approvalFor(degraded.baseUrl, auth, pending.body['requestId'] as string);
    assert.equal((await approvalCommand(degraded.baseUrl, auth.approverA, view, 'approve')).status, 200, 'the private CTRL-04 operator plane still decides');
    await close(degraded);
    const identitySlot = (rows: readonly Record<string, unknown>[]): unknown => rows.find((row) => row['state_kind'] === 'human-identity-state');
    assert.deepEqual(identitySlot(await witnessRows(deployment.witness.databasePath)), identitySlot(witnessBefore), 'the identity slot was neither reset nor re-enrolled');
  });
});
