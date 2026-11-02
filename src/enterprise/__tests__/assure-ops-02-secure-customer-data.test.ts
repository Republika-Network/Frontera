import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { closeDeploymentWitnesses, withDeploymentWitness } from './core07-freshness-fixture.js';
import { SECRETS, bearer, call, capturingLogger, ctrl02Env, ctrl02File, logLines, recordingAdapter, type Reply } from './ctrl02-host-fixture.js';
import { bootEnterpriseHost, type EnterpriseHost } from '../host/enterprise-host.js';
import { PILOT_CUTOFF, PILOT_ENGAGEMENT, PILOT_ORG, pilotEvidence } from './assure-pilot-01-scenario.js';
import { reviewAllOverHttp, todayIssue } from './assure-rel-01d-host-fixture.js';

/**
 * ASSURE-OPS-02 -- secure customer-data operations, one private Host per
 * customer engagement. Two synthetic customers, each with its own engagement
 * root, Host, stores, credentials and sealed backups, driven through the real
 * Host over HTTP and through `scripts/assurance/engagement-ops.mjs`.
 *
 * What is proven here is technical. Volume encryption cannot be proven on a
 * test machine; the preflight's detection is exercised with injected probe
 * output, and once live, where it only reports.
 */

type Json = Record<string, unknown>;
interface EngagementOps {
  initEngagement(input: Json): Json;
  readEngagement(root: string): Json;
  preflightEngagement(input: Json): { status: string; checks: { id: string; status: string; detail?: Json }[] };
  recordEvent(input: Json): Json;
  engagementStatus(input: Json): Promise<Json & { state: string; releases: Json[] }>;
  backupEngagement(input: Json): Promise<Json & { releases: Json[] }>;
  verifyEngagementBackup(input: Json): Promise<Json & { releases: Json[] }>;
  restoreEngagement(input: Json): Promise<Json>;
  inventoryEngagement(input: Json): Json & { files: { path: string; class: string; size: number; sha256: string }[] };
  planDisposition(input: Json): Promise<Json & { planDigest: string; destroy: { path: string }[]; refusals: string[]; lifecycleState: string }>;
  executeDisposition(input: Json): Promise<Json>;
  detectVolumeEncryption(path: string, options?: Json): { status: string; detail: string };
  parseManageBdeStatus(text: string): { status: string };
  parseFdesetupStatus(text: string): { status: string };
}
interface SealedBackupLib {
  generateBackupKey(path: string): { keyId: string };
  readBackupKey(path: string): Buffer;
  unsealBackupSet(input: Json): { header: Json };
}
interface StoreRegistry {
  STORE_DEFINITIONS: readonly { name: string; envVar: string; targetFilename: string }[];
}

let ops: EngagementOps;
let sealed: SealedBackupLib;
let registry: StoreRegistry;
const dirs: string[] = [];
const hosts: EnterpriseHost[] = [];
before(async () => {
  const load = async (path: string): Promise<unknown> => import(pathToFileURL(join(process.cwd(), path)).href);
  ops = (await load('scripts/assurance/engagement-ops.mjs')) as EngagementOps;
  sealed = (await load('scripts/portability/lib-sealed-backup.mjs')) as SealedBackupLib;
  registry = (await load('scripts/portability/store-registry.mjs')) as StoreRegistry;
});
after(async () => {
  for (const host of hosts) await host.close().catch(() => {});
  await closeDeploymentWitnesses();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});
const tempDir = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};

const ENCRYPTED = (): { status: string; detail: string } => ({ status: 'ENCRYPTED', detail: 'injected probe (test)' });

/** A synthetic customer engagement: its own root, governed-action file, store paths, organization and credentials. */
interface Customer {
  readonly id: string;
  readonly org: string;
  readonly root: string;
  readonly env: Record<string, string | undefined>;
  readonly secrets: { readonly reviewer: string; readonly approver: string; readonly apiKey: string };
  readonly auth: { readonly reviewer: string; readonly approver: string; readonly organizationKey: string };
  readonly keyFile: string;
}

async function customer(id: string, org: string, options: { readonly reuseSecretsOf?: Customer; readonly envOverrides?: Record<string, string | undefined>; readonly reviewers?: Json[] } = {}): Promise<Customer> {
  const parent = tempDir(`assure-ops-02-${id}-`);
  const root = join(parent, 'engagement');
  ops.initEngagement({ root, engagementId: id, organizationId: org });
  const token = (label: string): string => `OPS02_${id.toUpperCase().replace(/-/g, '_')}_${label}_${Math.random().toString(36).slice(2).padEnd(12, '0')}_SYNTHETIC_0000`;
  const secrets = options.reuseSecretsOf?.secrets ?? { reviewer: token('REVIEWER'), approver: token('APPROVER'), apiKey: token('ORGKEY') };
  const reviewers = options.reviewers ?? [
    { reviewerId: `${id}-reviewer-01`, roles: ['assure.reviewer'], apiKeyEnv: 'OPS02_REVIEWER_KEY' },
    { reviewerId: `${id}-approver-01`, roles: ['assure.report-release'], apiKeyEnv: 'OPS02_APPROVER_KEY' },
  ];
  const base = ctrl02Env(root, ctrl02File({ assuranceReviewers: reviewers }), {
    AOC_ENTERPRISE_API_KEYS: `${secrets.apiKey}:${org}`,
    AOC_ENTERPRISE_KERNEL_AUTHORITY_ORGANIZATION_ID: org,
    OPS02_REVIEWER_KEY: secrets.reviewer,
    OPS02_APPROVER_KEY: secrets.approver,
    AOC_ENTERPRISE_ASSURANCE_FRAMEWORKS: 'rn.sv@0.1.0',
    AOC_ENTERPRISE_ASSURANCE_REVIEWER_ONLY: 'true',
  });
  // Every store the fixture configures, moved to <root>/data/<registry restore filename>.
  const dataDir = join(root, 'data');
  for (const definition of registry.STORE_DEFINITIONS) {
    if (base[definition.envVar] !== undefined) base[definition.envVar] = join(dataDir, definition.targetFilename);
  }
  const env = await withDeploymentWitness({ ...base, ...(options.envOverrides ?? {}) });
  const keyFile = join(parent, 'backup-key.bin');
  sealed.generateBackupKey(keyFile);
  return { id, org, root, env, secrets, auth: { reviewer: bearer(secrets.reviewer), approver: bearer(secrets.approver), organizationKey: bearer(secrets.apiKey) }, keyFile };
}

async function boot(target: Customer): Promise<{ host: EnterpriseHost; base: string }> {
  const host = await bootEnterpriseHost({ env: target.env, executionAdapters: [recordingAdapter()], logger: capturingLogger });
  hosts.push(host);
  const { port } = await host.listen();
  return { host, base: `http://127.0.0.1:${port}` };
}

function expect(reply: Reply, status: number, where: string): Reply {
  assert.equal(reply.status, status, `${where}: ${reply.text.slice(0, 400)}`);
  return reply;
}

const evidenceFor = (org: string) => pilotEvidence().map((reference) => (reference.organizationId === PILOT_ORG ? { ...reference, organizationId: org } : reference));

/** Create -> evidence -> evaluate -> review -> complete over HTTP; optionally draft and release. */
async function assess(target: Customer, base: string, release: boolean): Promise<{ assessmentId: string; reportId?: string }> {
  const created = expect(
    await call(base, 'POST', '/api/assurance/assessments', {
      authorization: target.auth.reviewer,
      body: { subject: { subjectType: 'system', subjectId: `${target.id}-system`, organizationId: target.org }, frameworkId: 'rn.sv', frameworkVersion: '0.1.0', evidenceCutoffAt: PILOT_CUTOFF, purpose: 'ASSURE-OPS-02 synthetic engagement' },
    }),
    201,
    'create',
  );
  const assessmentId = created.body['assessmentId'] as string;
  expect(await call(base, 'POST', `/api/assurance/assessments/${assessmentId}/evidence`, { authorization: target.auth.reviewer, body: { manualEvidence: evidenceFor(target.org) } }), 200, 'evidence');
  expect(await call(base, 'POST', `/api/assurance/assessments/${assessmentId}/evaluate`, { authorization: target.auth.reviewer, body: { complete: false } }), 200, 'evaluate');
  for (const review of await reviewAllOverHttp(base, target.auth.reviewer, assessmentId)) expect(review, 201, 'review');
  expect(await call(base, 'POST', `/api/assurance/assessments/${assessmentId}/evaluate`, { authorization: target.auth.reviewer, body: {} }), 200, 'complete');
  if (!release) return { assessmentId };
  const draftBody = { engagement: PILOT_ENGAGEMENT, issue: todayIssue() };
  const draft = expect(await call(base, 'POST', `/api/assurance/assessments/${assessmentId}/commercial-report/draft`, { authorization: target.auth.approver, body: draftBody }), 200, 'draft');
  const digest = (draft.body['manifest'] as Json)['contentDigest'];
  const released = expect(
    await call(base, 'POST', `/api/assurance/assessments/${assessmentId}/commercial-report/release`, {
      authorization: target.auth.approver,
      body: { ...draftBody, approvedContentDigest: digest, acknowledgements: { limitationsReviewed: true, commercialUseRestrictionAcknowledged: true } },
    }),
    201,
    'release',
  );
  return { assessmentId, reportId: (released.body['release'] as Json)['reportId'] as string };
}

const exportPackage = async (base: string, auth: string, reportId: string): Promise<Reply> => call(base, 'GET', `/api/assurance/commercial-releases/${encodeURIComponent(reportId)}/package`, { authorization: auth });

const rejects = async (promise: Promise<unknown>, pattern: RegExp, where: string): Promise<void> => {
  await assert.rejects(promise, (error: unknown) => error instanceof Error && pattern.test(error.message), where);
};
const throws = (fn: () => unknown, pattern: RegExp, where: string): void => {
  assert.throws(fn, (error: unknown) => error instanceof Error && pattern.test(error.message), where);
};
const checkOf = (report: { checks: { id: string; status: string }[] }, id: string): string | undefined => report.checks.find((entry) => entry.id === id)?.status;

/** The two isolated customers every test below shares: A has a released report, B a completed assessment. */
let A: Customer;
let B: Customer;
let A_report = '';
let A_assessment = '';
let A_exportBefore: Json = {};
let hostA: { host: EnterpriseHost; base: string };
let hostB: { host: EnterpriseHost; base: string };

describe('ASSURE-OPS-02 -- one private Host per customer engagement', () => {
  before(async () => {
    A = await customer('eng-a', 'org-customer-a');
    B = await customer('eng-b', 'org-customer-b');
    hostA = await boot(A);
    hostB = await boot(B);
    const a = await assess(A, hostA.base, true);
    A_report = a.reportId ?? '';
    A_assessment = a.assessmentId;
    await assess(B, hostB.base, false);
    A_exportBefore = expect(await exportPackage(hostA.base, A.auth.approver, A_report), 200, 'A exports').body;
  });

  describe('isolation', () => {
    it('ISO-01 each customer has its own root, store files and organization; preflight passes every isolation check', () => {
      assert.notEqual(A.env['AOC_ENTERPRISE_ASSURANCE_SQLITE_PATH'], B.env['AOC_ENTERPRISE_ASSURANCE_SQLITE_PATH']);
      for (const target of [A, B]) {
        const report = ops.preflightEngagement({ root: target.root, env: target.env, detect: ENCRYPTED });
        for (const id of ['E01', 'E02', 'E03', 'E04', 'E05', 'E06', 'E07', 'E08', 'E09', 'E10', 'E11', 'E13']) assert.equal(checkOf(report, id), 'PASS', `${target.id} ${id}: ${JSON.stringify(report.checks.find((entry) => entry.id === id))}`);
        assert.ok(existsSync(join(target.root, 'data', 'assurance.sqlite')));
      }
    });

    it('ISO-02 a customer A credential authenticates nothing on Host B, and B cannot read, export or corroborate A’s report', async () => {
      expect(await call(hostB.base, 'GET', `/api/assurance/commercial-releases/${encodeURIComponent(A_report)}`, { authorization: A.auth.approver }), 401, 'A credential on Host B');
      expect(await exportPackage(hostB.base, A.auth.approver, A_report), 401, 'A credential exports nothing from B');
      expect(await call(hostB.base, 'GET', `/api/assurance/commercial-releases/${encodeURIComponent(A_report)}`, { authorization: B.auth.approver }), 404, 'A report is absent on B');
      expect(await exportPackage(hostB.base, B.auth.approver, A_report), 404, 'A report cannot be exported from B');
      expect(await call(hostB.base, 'GET', `/api/assurance/assessments/${A_assessment}`, { authorization: B.auth.reviewer }), 404, 'A assessment is absent on B');
      // A's genuine package is not corroborated by B's custody.
      const files = (A_exportBefore['files'] as { path: string; contentBase64: string }[]).reduce<Record<string, string>>((all, file) => ({ ...all, [file.path]: Buffer.from(file.contentBase64, 'base64').toString('utf8') }), {});
      const delivered = { content: JSON.parse(files['report.json'] ?? '{}'), markdown: files['report.md'], manifest: JSON.parse(files['integrity-manifest.json'] ?? '{}'), release: JSON.parse(files['release-record.json'] ?? '{}') };
      const onB = expect(await call(hostB.base, 'POST', '/api/assurance/commercial-releases/verify', { authorization: B.auth.reviewer, body: delivered }), 200, 'verify on B');
      assert.equal(onB.body['authority'], 'RELEASE_NOT_IN_CUSTODY');
      const onA = expect(await call(hostA.base, 'POST', '/api/assurance/commercial-releases/verify', { authorization: A.auth.reviewer, body: delivered }), 200, 'verify on A');
      assert.equal(onA.body['authority'], 'RELEASE_MATCHES_AUTHORITY');
    });

    it('ISO-03 customer A evidence offered to a customer B assessment is rejected per reference', async () => {
      const created = expect(
        await call(hostB.base, 'POST', '/api/assurance/assessments', {
          authorization: B.auth.reviewer,
          body: { subject: { subjectType: 'system', subjectId: 'eng-b-second', organizationId: B.org }, frameworkId: 'rn.sv', frameworkVersion: '0.1.0', evidenceCutoffAt: PILOT_CUTOFF, purpose: 'ASSURE-OPS-02 cross-customer evidence' },
        }),
        201,
        'create on B',
      );
      const collected = expect(await call(hostB.base, 'POST', `/api/assurance/assessments/${created.body['assessmentId'] as string}/evidence`, { authorization: B.auth.reviewer, body: { manualEvidence: evidenceFor(A.org) } }), 200, 'A evidence on B');
      const resolutions = JSON.stringify(collected.body['evidenceResolutions'] ?? []);
      assert.match(resolutions, /EVIDENCE_WRONG_TENANT/);
      assert.equal((collected.body['evidenceResolutions'] as { status?: string }[]).some((resolution) => resolution.status === 'accepted'), false, 'nothing of A was accepted by B');
    });

    it('ISO-04 a credential reused across engagements, or shared within one, fails the preflight; the ledger never stores a secret', async () => {
      const ledger = join(tempDir('assure-ops-02-ledger-'), 'credential-ledger.json');
      const first = ops.preflightEngagement({ root: A.root, env: A.env, credentialLedger: ledger, recordCredentials: true, detect: ENCRYPTED });
      assert.equal(checkOf(first, 'E12'), 'PASS');
      assert.equal(checkOf(ops.preflightEngagement({ root: B.root, env: B.env, credentialLedger: ledger, recordCredentials: true, detect: ENCRYPTED }), 'E12'), 'PASS');
      const reuse = await customer('eng-c', 'org-customer-c', { reuseSecretsOf: A });
      const reused = ops.preflightEngagement({ root: reuse.root, env: reuse.env, credentialLedger: ledger, detect: ENCRYPTED });
      assert.equal(checkOf(reused, 'E12'), 'FAIL');
      assert.equal(reused.status, 'FAIL');
      const shared = await customer('eng-d', 'org-customer-d', { envOverrides: { OPS02_APPROVER_KEY: 'OPS02_SHARED_WITHIN_ENGAGEMENT_SYNTHETIC_000000000' , OPS02_REVIEWER_KEY: 'OPS02_SHARED_WITHIN_ENGAGEMENT_SYNTHETIC_000000000' } });
      assert.equal(checkOf(ops.preflightEngagement({ root: shared.root, env: shared.env, credentialLedger: ledger, detect: ENCRYPTED }), 'E12'), 'FAIL');
      const text = readFileSync(ledger, 'utf8');
      for (const secret of [A.secrets.reviewer, A.secrets.approver, A.secrets.apiKey, B.secrets.reviewer]) assert.equal(text.includes(secret), false, 'the ledger holds fingerprints only');
    });

    it('ISO-05 a shared or misplaced store, reviewer-only off, a public bind, another framework, a dual-role credential or another organization each fail the preflight', async () => {
      const cases: readonly (readonly [string, Record<string, string | undefined>, string])[] = [
        ['shared store', { AOC_ENTERPRISE_ASSURANCE_SQLITE_PATH: B.env['AOC_ENTERPRISE_ASSURANCE_SQLITE_PATH'] }, 'E08'],
        ['reviewer-only off', { AOC_ENTERPRISE_ASSURANCE_REVIEWER_ONLY: 'false' }, 'E04'],
        ['public bind', { AOC_ENTERPRISE_HTTP_HOST: '0.0.0.0' }, 'E07'],
        ['other framework', { AOC_ENTERPRISE_ASSURANCE_FRAMEWORKS: '' }, 'E05'],
        ['memory persistence', { AOC_ENTERPRISE_PERSISTENCE_PROVIDER: 'memory' }, 'E03'],
        ['another organization', { AOC_ENTERPRISE_KERNEL_AUTHORITY_ORGANIZATION_ID: B.org }, 'E02'],
      ];
      for (const [label, overrides, id] of cases) {
        const report = ops.preflightEngagement({ root: A.root, env: { ...A.env, ...overrides }, detect: ENCRYPTED });
        assert.equal(checkOf(report, id), 'FAIL', label);
        assert.equal(report.status, 'FAIL', label);
      }
      const dual = await customer('eng-e', 'org-customer-e', { reviewers: [{ reviewerId: 'eng-e-dual-01', roles: ['assure.reviewer', 'assure.report-release'], apiKeyEnv: 'OPS02_REVIEWER_KEY' }] });
      assert.equal(checkOf(ops.preflightEngagement({ root: dual.root, env: dual.env, detect: ENCRYPTED }), 'E11'), 'FAIL');
    });
  });

  describe('encryption and secrets', () => {
    it('ENC-01 volume-encryption detection: encrypted passes, not encrypted fails, unverified fails when required and warns with an attestation', () => {
      assert.equal(ops.parseManageBdeStatus('    Conversion Status:    Fully Encrypted\n    Protection Status:    Protection On\n').status, 'ENCRYPTED');
      assert.equal(ops.parseManageBdeStatus('    Conversion Status:    Fully Decrypted\n    Protection Status:    Protection Off\n').status, 'NOT_ENCRYPTED');
      assert.equal(ops.parseManageBdeStatus('    Conversion Status:    Encryption in Progress\n    Protection Status:    Protection Off\n').status, 'NOT_ENCRYPTED');
      assert.equal(ops.parseManageBdeStatus('Access is denied.').status, 'UNVERIFIED');
      assert.equal(ops.parseFdesetupStatus('FileVault is On.').status, 'ENCRYPTED');
      assert.equal(ops.parseFdesetupStatus('FileVault is Off.').status, 'NOT_ENCRYPTED');
      const notEncrypted = ops.preflightEngagement({ root: A.root, env: A.env, detect: () => ({ status: 'NOT_ENCRYPTED', detail: 'injected' }) });
      assert.equal(checkOf(notEncrypted, 'E13'), 'FAIL');
      const unverified = (): { status: string; detail: string } => ({ status: 'UNVERIFIED', detail: 'injected' });
      assert.equal(checkOf(ops.preflightEngagement({ root: A.root, env: A.env, detect: unverified, requireEncryption: true }), 'E13'), 'FAIL', 'missing encryption evidence refuses where it is required');
      assert.equal(checkOf(ops.preflightEngagement({ root: A.root, env: A.env, detect: unverified, attestEncryptedVolume: 'custody admin: LUKS2 volume on the engagement VM (synthetic)' }), 'E13'), 'WARN', 'an attestation is recorded, never upgraded to PASS');
      // Live, read-only probe of this machine: reported, never asserted to be encrypted.
      const live = ops.detectVolumeEncryption(A.root);
      assert.ok(['ENCRYPTED', 'NOT_ENCRYPTED', 'UNVERIFIED'].includes(live.status), JSON.stringify(live));
    });

    it('ENC-02 / BAK-05 a sealed engagement backup refuses a wrong key, a flipped ciphertext byte, an altered header and a truncation; a missing key writes nothing', async () => {
      await hostA.host.close();
      const dir = tempDir('assure-ops-02-seal-');
      const archive = join(dir, 'a.sealed');
      const made = await ops.backupEngagement({ root: A.root, keyFile: A.keyFile, output: archive, env: A.env });
      assert.equal(made['status'], 'sealed');
      await rejects(ops.verifyEngagementBackup({ root: A.root, keyFile: B.keyFile, archive, env: A.env }), /key|authenticat|decrypt|unseal/i, 'wrong key');
      const bytes = readFileSync(archive);
      const flipped = Buffer.from(bytes);
      flipped[flipped.length - 10] = (flipped[flipped.length - 10] ?? 0) ^ 0xff;
      writeFileSync(join(dir, 'flipped.sealed'), flipped);
      await rejects(ops.verifyEngagementBackup({ root: A.root, keyFile: A.keyFile, archive: join(dir, 'flipped.sealed'), env: A.env }), /./, 'flipped ciphertext');
      const headerTampered = Buffer.from(bytes.toString('latin1').replace('"assessments":1', '"assessments":2'), 'latin1');
      assert.notDeepEqual(headerTampered, bytes);
      writeFileSync(join(dir, 'header.sealed'), headerTampered);
      await rejects(ops.verifyEngagementBackup({ root: A.root, keyFile: A.keyFile, archive: join(dir, 'header.sealed'), env: A.env }), /./, 'altered header');
      writeFileSync(join(dir, 'truncated.sealed'), bytes.subarray(0, Math.floor(bytes.length / 2)));
      await rejects(ops.verifyEngagementBackup({ root: A.root, keyFile: A.keyFile, archive: join(dir, 'truncated.sealed'), env: A.env }), /./, 'truncated (an interrupted copy)');
      await rejects(ops.backupEngagement({ root: A.root, keyFile: '', output: join(dir, 'plain.sealed'), env: A.env }), /key file is required/, 'no key');
      await rejects(ops.backupEngagement({ root: A.root, keyFile: join(dir, 'absent.key'), output: join(dir, 'plain2.sealed'), env: A.env }), /./, 'unreadable key');
      assert.equal(existsSync(join(dir, 'plain.sealed')) || existsSync(join(dir, 'plain2.sealed')), false, 'no plaintext or partial backup was written');
      assert.deepEqual(readdirSync(join(A.root, 'work')), [], 'no plaintext backup set remains in the work directory');
      hostA = await boot(A);
    });

    it('ENC-03 no credential reaches the logs, the export package, the sealed header or the backup set itself', async () => {
      const dir = tempDir('assure-ops-02-scan-');
      await hostA.host.close();
      const archive = join(dir, 'a.sealed');
      await ops.backupEngagement({ root: A.root, keyFile: A.keyFile, output: archive, env: A.env });
      const plain = join(dir, 'unsealed');
      const key = sealed.readBackupKey(A.keyFile);
      sealed.unsealBackupSet({ sealedFile: archive, key, outputDir: plain });
      hostA = await boot(A);
      const secrets = [A.secrets.reviewer, A.secrets.approver, A.secrets.apiKey, B.secrets.reviewer, B.secrets.approver, B.secrets.apiKey, SECRETS.administrator, key.toString('hex'), key.toString('base64')];
      const haystacks: [string, Buffer][] = [['logs', Buffer.from(logLines.join('\n'))], ['export', Buffer.from(JSON.stringify(A_exportBefore))], ['sealed file', readFileSync(archive)]];
      const walk = (path: string): void => {
        for (const name of readdirSync(path)) {
          const full = join(path, name);
          if (statSync(full).isDirectory()) walk(full);
          else haystacks.push([full, readFileSync(full)]);
        }
      };
      walk(plain);
      for (const [where, bytes] of haystacks) for (const secret of secrets) assert.equal(bytes.includes(Buffer.from(secret)), false, `${where} must not contain a credential`);
    });
  });

  describe('backup and restore', () => {
    it('BAK-01 / BAK-02 a backup before release and one after record the custody they hold; verification restores into a throwaway target and checks every release', async () => {
      await hostB.host.close();
      const dir = tempDir('assure-ops-02-bak-');
      const beforeRelease = await ops.backupEngagement({ root: B.root, keyFile: B.keyFile, output: join(dir, 'b.sealed'), env: B.env });
      assert.deepEqual(beforeRelease.releases, [], 'B has no release yet');
      const verifiedB = await ops.verifyEngagementBackup({ root: B.root, keyFile: B.keyFile, archive: join(dir, 'b.sealed'), env: B.env });
      assert.equal(verifiedB['status'], 'verified');
      hostB = await boot(B);

      await hostA.host.close();
      const afterRelease = await ops.backupEngagement({ root: A.root, keyFile: A.keyFile, output: join(dir, 'a.sealed'), env: A.env });
      assert.equal(afterRelease.releases.length, 1);
      assert.equal(afterRelease.releases[0]?.['reportId'], A_report);
      assert.equal(afterRelease.releases[0]?.['custodyVersion'], 'aoc.assurance.commercial-release-custody.v2');
      const verified = await ops.verifyEngagementBackup({ root: A.root, keyFile: A.keyFile, archive: join(dir, 'a.sealed'), env: A.env });
      assert.deepEqual(verified.releases.map((release) => release['releaseDigest']), afterRelease.releases.map((release) => release['releaseDigest']));
      assert.match(String(verified['authenticity']), /not signed/);
      hostA = await boot(A);
    });

    it('BAK-03 restore into the engagement preserves custody: the original release verifies and exports byte-identically', async () => {
      await hostA.host.close();
      const dir = tempDir('assure-ops-02-restore-');
      const archive = join(dir, 'a.sealed');
      await ops.backupEngagement({ root: A.root, keyFile: A.keyFile, output: archive, env: A.env });
      await rejects(ops.restoreEngagement({ root: A.root, keyFile: A.keyFile, archive, env: A.env }), /not empty/, 'a restore never replaces live stores');
      // Simulated loss of the data directory (test-owned synthetic files only).
      rmSync(join(A.root, 'data'), { recursive: true, force: true });
      const restored = await ops.restoreEngagement({ root: A.root, keyFile: A.keyFile, archive, env: A.env });
      assert.equal(restored['status'], 'restored');
      hostA = await boot(A);
      const again = expect(await exportPackage(hostA.base, A.auth.approver, A_report), 200, 'export after restore').body;
      assert.equal(again['packageDigest'], A_exportBefore['packageDigest']);
      assert.deepEqual(again['files'], A_exportBefore['files'], 'byte-identical package after restore');
    });

    it('BAK-04 a backup of customer A is never restored into customer B, with either key; an interrupted (Host running) backup writes nothing', async () => {
      const dir = tempDir('assure-ops-02-cross-');
      await hostA.host.close();
      const archive = join(dir, 'a.sealed');
      await ops.backupEngagement({ root: A.root, keyFile: A.keyFile, output: archive, env: A.env });
      hostA = await boot(A);
      await hostB.host.close();
      const bDataBefore = ops.inventoryEngagement({ root: B.root }).files.filter((file) => file.class === 'store');
      for (const keyFile of [A.keyFile, B.keyFile]) {
        await rejects(ops.restoreEngagement({ root: B.root, keyFile, archive, env: B.env }), /another engagement|not empty/, 'cross-customer restore');
        await rejects(ops.verifyEngagementBackup({ root: B.root, keyFile, archive, env: B.env }), /another engagement/, 'cross-customer verify');
      }
      await rejects(ops.restoreEngagement({ root: A.root, keyFile: A.keyFile, archive, env: B.env }), /another organization/, 'A archive with B environment');
      assert.deepEqual(ops.inventoryEngagement({ root: B.root }).files.filter((file) => file.class === 'store'), bDataBefore, 'B data untouched');
      hostB = await boot(B);
      // Host A running: the cold backup refuses (non-empty WAL) and leaves nothing behind.
      expect(
        await call(hostA.base, 'POST', '/api/assurance/assessments', {
          authorization: A.auth.reviewer,
          body: { subject: { subjectType: 'system', subjectId: 'eng-a-live-write', organizationId: A.org }, frameworkId: 'rn.sv', frameworkVersion: '0.1.0', evidenceCutoffAt: PILOT_CUTOFF, purpose: 'ASSURE-OPS-02 live write' },
        }),
        201,
        'a write on the running Host',
      );
      const live = join(dir, 'live.sealed');
      await assert.rejects(ops.backupEngagement({ root: A.root, keyFile: A.keyFile, output: live, env: A.env }));
      assert.equal(existsSync(live), false);
      assert.deepEqual(readdirSync(join(A.root, 'work')), []);
    });
  });

  describe('retention and offboarding', () => {
    it('RET-01 the lifecycle is derived from the store and recorded events; retention needs an approved policy reference', async () => {
      const status = await ops.engagementStatus({ root: A.root });
      assert.equal(status.state, 'RELEASE_ISSUED');
      assert.equal((await ops.engagementStatus({ root: B.root })).state, 'ASSESSMENT_COMPLETED');
      throws(() => ops.recordEvent({ root: A.root, event: 'retention-set', until: '2027-01-01', by: 'rn-custody-admin-01' }), /policy-reference/, 'no policy reference');
      throws(() => ops.recordEvent({ root: A.root, event: 'handoff-accepted', by: 'Jane Doe' }), /role-style/, 'names are refused');
      ops.recordEvent({ root: A.root, event: 'handoff-accepted', by: 'rn-custody-admin-01' });
      assert.equal((await ops.engagementStatus({ root: A.root })).state, 'HANDOFF_COMPLETED');
      ops.recordEvent({ root: A.root, event: 'retention-set', until: '2099-12-31', policyReference: 'SYNTHETIC-POLICY-REF-001', by: 'rn-custody-admin-01' });
      assert.equal((await ops.engagementStatus({ root: A.root })).state, 'RETENTION_ACTIVE');
    });

    it('RET-02 inventory lists every engagement file by class; the dry-run plan lists exactly those paths and deletes nothing', async () => {
      await hostA.host.close();
      writeFileSync(join(A.root, 'exports', 'export.json'), JSON.stringify(A_exportBefore));
      writeFileSync(join(A.root, 'intake', 'evidence-sv03.synthetic.txt'), 'synthetic evidence file');
      const inventory = ops.inventoryEngagement({ root: A.root });
      const classes = new Set(inventory.files.map((file) => file.class));
      for (const kind of ['engagement-record', 'store', 'export', 'evidence-intake']) assert.ok(classes.has(kind), kind);
      const plan = await ops.planDisposition({ root: A.root });
      assert.deepEqual(plan.destroy.map((file) => file.path).sort(), inventory.files.map((file) => file.path).sort());
      assert.deepEqual(ops.inventoryEngagement({ root: A.root }).files, inventory.files, 'a dry run deletes nothing');
      assert.equal((await ops.planDisposition({ root: A.root })).planDigest, plan.planDigest, 'deterministic');
    });

    it('RET-03 unapproved, mismatched or unsafe disposition is refused and deletes nothing; another customer is never touched', async () => {
      const plan = await ops.planDisposition({ root: A.root });
      const dir = tempDir('assure-ops-02-approval-');
      const approval = (overrides: Json): string => {
        const path = join(dir, `approval-${Math.random().toString(36).slice(2)}.json`);
        writeFileSync(path, JSON.stringify({ format: 'frontera.assurance.disposition-approval.v1', engagementId: A.id, organizationId: A.org, planDigest: plan.planDigest, approvedBy: 'rn-founder-01', approverRole: 'founder', approvedAt: '2026-11-02', basis: 'customer_request', ...overrides }));
        return path;
      };
      const certificate = join(dir, 'certificate.json');
      const before = ops.inventoryEngagement({ root: A.root }).files;
      const bBefore = ops.inventoryEngagement({ root: B.root }).files;
      const refusals: readonly (readonly [string, Json, RegExp])[] = [
        ['no approval file', { approvalFile: join(dir, 'absent.json'), confirm: A.id, certificate }, /approval file is required/],
        ['wrong confirmation', { approvalFile: approval({}), confirm: B.id, certificate }, /--confirm/],
        ['another plan', { approvalFile: approval({ planDigest: `sha256:${'0'.repeat(64)}` }), confirm: A.id, certificate }, /another plan/],
        ['another engagement', { approvalFile: approval({ engagementId: B.id }), confirm: A.id, certificate }, /another engagement/],
        ['retention not expired', { approvalFile: approval({ basis: 'retention_expired' }), confirm: A.id, certificate }, /RETENTION_EXPIRED/],
        ['named approver', { approvalFile: approval({ approvedBy: 'Jane Doe' }), confirm: A.id, certificate }, /role-style/],
        ['certificate inside the root', { approvalFile: approval({}), confirm: A.id, certificate: join(A.root, 'certificate.json') }, /outside the engagement root/],
      ];
      for (const [label, input, pattern] of refusals) await rejects(ops.executeDisposition({ root: A.root, ...input }), pattern, label);
      // A file changed after approval: the approved plan no longer describes the engagement.
      const stale = approval({});
      writeFileSync(join(A.root, 'exports', 'late-export.json'), '{}');
      await rejects(ops.executeDisposition({ root: A.root, approvalFile: stale, confirm: A.id, certificate }), /another plan/, 'changed after approval');
      rmSync(join(A.root, 'exports', 'late-export.json'));
      // A non-empty WAL (a running Host) refuses.
      writeFileSync(join(A.root, 'data', 'assurance.sqlite-wal'), 'synthetic non-empty wal');
      const walPlan = await ops.planDisposition({ root: A.root });
      assert.ok(walPlan.refusals.some((reason) => /WAL/.test(reason)));
      await rejects(ops.executeDisposition({ root: A.root, approvalFile: approval({ planDigest: walPlan.planDigest }), confirm: A.id, certificate }), /Disposition refused/, 'running Host');
      rmSync(join(A.root, 'data', 'assurance.sqlite-wal'));
      assert.deepEqual(ops.inventoryEngagement({ root: A.root }).files, before, 'nothing was deleted');
      assert.deepEqual(ops.inventoryEngagement({ root: B.root }).files, bBefore, 'customer B untouched');
      assert.equal(existsSync(certificate), false);
    });

    it('RET-04 an approved disposition of synthetic engagement A removes exactly its root and writes a certificate; customer B is intact and still serves', async () => {
      const plan = await ops.planDisposition({ root: A.root });
      const dir = tempDir('assure-ops-02-dispose-');
      const approvalFile = join(dir, 'approval.json');
      writeFileSync(approvalFile, JSON.stringify({ format: 'frontera.assurance.disposition-approval.v1', engagementId: A.id, organizationId: A.org, planDigest: plan.planDigest, approvedBy: 'rn-founder-01', approverRole: 'founder', approvedAt: '2026-11-02', basis: 'customer_request' }));
      const bBefore = ops.inventoryEngagement({ root: B.root }).files;
      const certificate = join(dir, 'certificate.json');
      const done = await ops.executeDisposition({ root: A.root, approvalFile, confirm: A.id, certificate });
      assert.equal(done['status'], 'disposed');
      assert.equal(existsSync(A.root), false, 'the engagement root is gone');
      assert.ok(existsSync(join(A.root, '..', 'backup-key.bin')), 'nothing outside the root was touched (the key is a MANUAL step)');
      const record = JSON.parse(readFileSync(certificate, 'utf8')) as Json & { destroyed: unknown[]; manualStepsOutstanding: string[]; limitations: string[] };
      assert.equal(record.destroyed.length, plan.destroy.length);
      assert.ok(record.manualStepsOutstanding.some((step) => /backup key/.test(step)));
      assert.ok(record.limitations.some((line) => /physical erasure/.test(line)));
      assert.deepEqual(ops.inventoryEngagement({ root: B.root }).files, bBefore, 'customer B untouched');
      expect(await call(hostB.base, 'GET', '/ready'), 200, 'B still serves');
    });
  });
});
