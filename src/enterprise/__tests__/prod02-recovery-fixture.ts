import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { createActionEnforcementPolicyPackIntegration } from '../../features/domain-policy-pack-runtime/integrations/action-enforcement-policy-pack-integration.js';
import type { PolicyPackRule } from '../../features/domain-policy-pack-runtime/domain/policy-pack-rule.js';
import { createPolicyPackRuntimeContext } from '../../features/domain-policy-pack-runtime/runtime/policy-pack-runtime-context.js';
import { createPolicyPackRuntime } from '../../features/domain-policy-pack-runtime/services/policy-pack-runtime.js';
import type { PolicyPackProvider } from '../../kernel/index.js';
import { bootEnterpriseHost, type EnterpriseHost } from '../host/enterprise-host.js';
import { AUTHORITY_KEY_A, authorityAuthenticityEnv } from './authority-authenticity-fixture.js';
import { externalCustodyEnv, signerKeyDirectory, spawnReferenceSigner, type SpawnedSigner } from './core02-external-signer-fixture.js';
import { WITNESS_TOKEN, freshnessEnv, spawnReferenceWitness, witnessDirectory, type SpawnedWitness } from './core07-freshness-fixture.js';
import { call, capturingLogger, create, expectStatus, recordingAdapter, type RecordingAdapter, type Reply } from './ctrl02-host-fixture.js';

/**
 * PROD-02 — one production-shaped Frontera deployment, for qualifying disaster
 * recovery through the real Enterprise Host.
 *
 * The deployment composes every store the shipped Host can compose: the
 * governed-action file declares CTRL-02 operators (control plane), a
 * Governance Profile catalog promoted by a profile steward (profile
 * lifecycle), profiles that declare CORE-05 approval and CORE-04 obligations,
 * a financial action with P10 limits (exercise ledger), and the governed spine
 * (bounded grants, emergency control, event stream, execution outcomes, Kernel
 * Authority). Execution resolution (P12) is composed by no shipped Host
 * configuration; the drill creates that store through its own factory, as an
 * embedder would.
 *
 * Every secret is a fresh random canary, so a backup can be scanned for each
 * one byte for byte. The authority signer is software or a separate-process
 * external signer; the CORE-07 freshness witness is always a separate process
 * whose database lives in its own directory — never in a data directory, and
 * never in a backup.
 *
 * The only in-process seams are the recording adapter (counts provider calls),
 * the organization's deterministic policy and the obligation discharge writer
 * (trusted in-process composition, as in CORE-04/05). Synthetic identifiers only.
 */

export const ORG = 'org-prod02';
export const TRUST_DOMAIN = 'trust-domain-prod02';
export const ISSUER = 'actor-prod02-org';
export const OWNER = 'actor-prod02-owner';
export const PAYABLES = 'actor-prod02-payables';
export const RELEASE = 'actor-prod02-release';
export const OFFBOARDED = 'actor-prod02-offboarded';
export const WITHDRAWN = 'actor-prod02-withdrawn';
export const ADAPTER_ID = 'pilot.recording';

export const TRANSFER = 'transfer-funds';
export const DEPLOY = 'deploy-release';
export const MAINTAIN = 'rotate-certificate';
export const RESTART = 'restart-service';
export const ACCOUNT = 'operating-account';
export const FROZEN = 'frozen-account';
export const PROD = 'production-cluster';
export const LEGACY = 'legacy-cluster';
export const EDGE = 'edge-gateway';
export const STAGING = 'staging-cluster';

export const CEILING = '500';
/** The P10 lifetime aggregate limit. 500 consumed before the backup leaves exactly 300. */
export const LIFETIME_LIMIT = '800';
export const APPROVE_RELEASE = 'approve-release';
export const OBLIGATION = 'change.approval';
export const EVIDENCE_HASH = `sha256:${'c3'.repeat(32)}`;

/** Fresh random canaries: one per secret source, unique per run. */
export interface Prod02Secrets {
  readonly legacyKey: string;
  readonly customerKey: string;
  readonly providerToken: string;
  readonly legacyAdministrator: string;
  readonly administrator: string;
  readonly provisioner: string;
  readonly observer: string;
  readonly responder: string;
  readonly steward: string;
  readonly approverA: string;
  readonly approverB: string;
  readonly signerToken: string;
}

function canary(label: string): string {
  return `PROD02CANARY${label}${randomBytes(24).toString('hex')}`;
}

export function newSecrets(): Prod02Secrets {
  return {
    legacyKey: canary('LEGACYKEY'),
    customerKey: canary('CUSTOMERKEY'),
    providerToken: canary('PROVIDERTOKEN'),
    legacyAdministrator: canary('LEGACYADMIN'),
    administrator: canary('ORGADMIN'),
    provisioner: canary('PROVISIONER'),
    observer: canary('OBSERVER'),
    responder: canary('RESPONDER'),
    steward: canary('STEWARD'),
    approverA: canary('APPROVERA'),
    approverB: canary('APPROVERB'),
    signerToken: canary('SIGNERTOKEN'),
  };
}

export const bearer = (secret: string): string => `Bearer ${secret}`;

export const OPERATORS = [
  { operatorId: 'ops-admin', role: 'organization-administrator', apiKeyEnv: 'FRONTERA_PROD02_ADMIN' },
  { operatorId: 'ops-provisioner', role: 'provisioner', apiKeyEnv: 'FRONTERA_PROD02_PROVISIONER' },
  { operatorId: 'ops-observer', role: 'observer', apiKeyEnv: 'FRONTERA_PROD02_OBSERVER' },
  { operatorId: 'ops-responder', role: 'responder', apiKeyEnv: 'FRONTERA_PROD02_RESPONDER' },
  { operatorId: 'ops-steward', role: 'profile-steward', apiKeyEnv: 'FRONTERA_PROD02_STEWARD' },
  { operatorId: 'approver-a', role: 'approver', apiKeyEnv: 'FRONTERA_PROD02_APPROVER_A' },
  { operatorId: 'approver-b', role: 'approver', apiKeyEnv: 'FRONTERA_PROD02_APPROVER_B' },
] as const;

export const GOVERNANCE = {
  parameterDimensions: [
    { id: 'releaseVersion', type: 'token', bound: 'exact' },
    { id: 'certificateSerial', type: 'token', bound: 'exact' },
  ],
  actionClasses: [
    { id: 'deploy', actions: [DEPLOY] },
    { id: 'maintain', actions: [MAINTAIN] },
  ],
  resourceClasses: [
    { id: 'production', resources: [PROD] },
    { id: 'legacy', resources: [LEGACY] },
    { id: 'edge', resources: [EDGE] },
  ],
  profiles: [
    {
      profileId: 'release-production',
      version: 1,
      owner: ORG,
      provenance: { authoredBy: 'platform-team', approvedBy: 'change-board' },
      actionClass: 'deploy',
      resourceClass: 'production',
      parameters: [{ dimension: 'releaseVersion', required: true }],
      materialFacts: [],
      relevantPolicies: ['prod02-policy'],
      approval: { approverAction: APPROVE_RELEASE, minimumApprovals: 1, requestTtlSeconds: 3600, approvalValiditySeconds: 3600, requiredEvidence: ['source_document'] },
    },
    {
      profileId: 'release-legacy',
      version: 1,
      owner: ORG,
      provenance: { authoredBy: 'platform-team', approvedBy: 'change-board' },
      actionClass: 'deploy',
      resourceClass: 'legacy',
      parameters: [{ dimension: 'releaseVersion', required: true }],
      materialFacts: [],
      relevantPolicies: ['prod02-policy'],
      approval: { approverAction: APPROVE_RELEASE, minimumApprovals: 1, requestTtlSeconds: 3600, approvalValiditySeconds: 3600 },
    },
    {
      profileId: 'edge-maintenance',
      version: 1,
      owner: ORG,
      provenance: { authoredBy: 'platform-team', approvedBy: 'change-board' },
      actionClass: 'maintain',
      resourceClass: 'edge',
      parameters: [{ dimension: 'certificateSerial', required: true }],
      materialFacts: [],
      obligations: [{ obligationType: OBLIGATION, blocking: true }],
      relevantPolicies: ['prod02-policy'],
    },
  ],
};

export const OBLIGATIONS = {
  sources: [{ sourceId: 'change-approvals', kind: 'approval_runtime', name: 'Change approval board', verificationClass: 'independent' }],
};

/** The deployment's governed-action file: secret-free, every credential named by an environment variable. */
export function prod02File(): Record<string, unknown> {
  return {
    version: 1,
    trustDomainId: TRUST_DOMAIN,
    grantLifetimeSeconds: 3600,
    customerPrincipals: [{ principalId: 'actor-prod02-static', externalSubject: { system: 'prod02-erp', subjectId: 'static-1' }, apiKeyEnv: 'FRONTERA_PROD02_CUSTOMER_KEY' }],
    administrators: [{ operatorId: 'ops-legacy', apiKeyEnv: 'FRONTERA_PROD02_LEGACY_ADMIN' }],
    operators: OPERATORS,
    profileLifecycle: 'operator-promoted',
    monetary: { assets: [{ assetId: 'USD', scale: 2 }], financialActions: [TRANSFER] },
    governance: GOVERNANCE,
    obligations: OBLIGATIONS,
    genericHttpAdapters: [
      {
        adapterId: 'erp.generic',
        origin: 'https://erp.example.com',
        method: 'POST',
        path: [{ kind: 'literal', value: 'actions' }],
        body: { kind: 'json-object', fields: { action: { kind: 'source', source: 'action' }, executionId: { kind: 'source', source: 'correlation.executionId' } } },
        credential: { kind: 'bearer', tokenEnv: 'FRONTERA_PROD02_PROVIDER_TOKEN' },
      },
    ],
    routes: [
      { action: TRANSFER, adapterId: ADAPTER_ID },
      { action: DEPLOY, adapterId: ADAPTER_ID },
      { action: MAINTAIN, adapterId: ADAPTER_ID },
      { action: RESTART, adapterId: ADAPTER_ID },
    ],
  };
}

// -- portability tooling (the shipped scripts, imported as they are run) -----------------

/** The parts of a `backup-manifest.json` the qualification reads (and, in tamper cases, rewrites). */
export interface ManifestStore {
  name: string;
  filename: string;
  checksum: string;
  schemaVersion: unknown;
  signedHead?: { storeId: string; sequence: number; stateDigest: string; freshnessStateKind: string };
  [field: string]: unknown;
}
export interface Manifest {
  backupFormat: string;
  stores: ManifestStore[];
  coverage?: { coverageModel: string; complete: boolean; stores: { name: string; required: boolean; included: boolean; present: boolean; status: string }[]; [field: string]: unknown };
  consistency: { mode: string; toolVerifiedHostStopped: boolean; crossStoreAtomic: boolean; nonEmptyWalObserved: string[] };
  authority: { signer: { privateKeyIncluded: boolean; mode: string }; freshness: { witnessStateIncluded: boolean; witnessId: string | null } };
  configuration: { secretEnvironmentVariables: string[] };
  [field: string]: unknown;
}
export interface RestoreReport {
  status: string;
  coverage: { model: string; complete: boolean };
  objectVerification: Record<string, { authenticity?: string }>;
  targets: { store: string; envVar: string; path: string }[];
  notRestored: string[];
  preRestoreSafetyCopy: string | null;
  [field: string]: unknown;
}

export function readManifest(backup: string): Manifest {
  return JSON.parse(readFileSync(join(backup, 'backup-manifest.json'), 'utf8')) as Manifest;
}

type AnyFn = (...args: never[]) => unknown;
export interface Portability {
  readonly runBackup: (options: Record<string, unknown>) => Promise<Record<string, unknown>>;
  readonly runRestore: (options: Record<string, unknown>) => Promise<RestoreReport>;
  readonly registry: {
    readonly STORE_DEFINITIONS: readonly { readonly name: string; readonly filename: string; readonly envVar: string; readonly targetFilename: string; readonly condition: string; readonly signedHead?: unknown; readonly freshnessStateKind?: string }[];
    readonly EXCLUDED_DURABLE_STATE: readonly { readonly name: string; readonly envVar: string | null; readonly reason: string }[];
    readonly storeEnvironmentFor: (dir: string) => Record<string, string>;
    readonly deriveDeploymentRequirements: AnyFn;
    readonly conditionHolds: AnyFn;
    readonly COVERAGE_MODEL: string;
  };
}

let portabilityModule: Portability | undefined;
const script = (name: string): string => pathToFileURL(resolve('scripts/portability', name)).href;

export async function portability(): Promise<Portability> {
  if (portabilityModule === undefined) {
    const backup = (await import(script('backup-enterprise-v1.mjs'))) as { runBackup: Portability['runBackup'] };
    const restore = (await import(script('restore-enterprise-v1.mjs'))) as { runRestore: Portability['runRestore'] };
    const registry = (await import(script('store-registry.mjs'))) as Portability['registry'];
    portabilityModule = { runBackup: backup.runBackup, runRestore: restore.runRestore, registry };
  }
  return portabilityModule;
}

/** Runs the backup CLI exactly as an operator would, in a child process, capturing every line it prints. */
export function backupCli(env: Record<string, string | undefined>, output: string, flags: readonly string[] = ['--cold']): { readonly status: number | null; readonly stdout: string; readonly stderr: string } {
  const result = spawnSync(process.execPath, [resolve('scripts/portability/backup-enterprise-v1.mjs'), '--output', output, ...flags], { env: env as NodeJS.ProcessEnv, encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

// -- deployment ------------------------------------------------------------------------

export type Custody = 'software' | 'external';

export interface Deployment {
  readonly root: string;
  readonly configDir: string;
  readonly secrets: Prod02Secrets;
  readonly custody: Custody;
  readonly witness: SpawnedWitness;
  readonly signer?: SpawnedSigner;
  /** The environment for a data directory: the same deployment configuration, pointed at `dataDir`. */
  envFor(dataDir: string): Record<string, string | undefined>;
  /** Every secret value this deployment's processes hold, for byte-for-byte scanning. */
  secretValues(): readonly string[];
  dir(name: string): string;
  close(): Promise<void>;
}

const SIGNER_KEY_ID = 'frontera-prod02-external-key-1';

export async function createDeployment(custody: Custody): Promise<Deployment> {
  const root = mkdtempSync(join(tmpdir(), 'frontera-prod02-'));
  const configDir = join(root, 'config');
  mkdirSync(configDir);
  const secrets = newSecrets();
  // Configuration management: the file lives outside every data directory, so destroying data never loses it.
  const filePath = join(configDir, 'governed-actions.json');
  writeFileSync(filePath, JSON.stringify(prod02File()));

  // CORE-07: the witness is its own process with its own directory, never inside `root`'s data or backup directories.
  const witnessDir = witnessDirectory();
  const witness = await spawnReferenceWitness({ dir: witnessDir.dir, witnessId: 'witness-prod02' });
  const keys = custody === 'external' ? signerKeyDirectory() : undefined;
  const signer = keys !== undefined ? await spawnReferenceSigner({ keyFile: join(keys.dir, 'authority-key.pem'), keyId: SIGNER_KEY_ID, credential: secrets.signerToken }) : undefined;

  const authorityEnv: Record<string, string> =
    signer === undefined
      ? { ...authorityAuthenticityEnv() }
      : externalCustodyEnv({ endpoint: signer.endpoint, keyId: SIGNER_KEY_ID }, [{ keyId: SIGNER_KEY_ID, algorithm: 'ed25519-v1', publicKeyPem: signer.publicKeyPem }], { AOC_ENTERPRISE_AUTHORITY_SIGNER_TOKEN: secrets.signerToken });

  const dirs: string[] = [];
  const { storeEnvironmentFor } = (await portability()).registry;
  return {
    root,
    configDir,
    secrets,
    custody,
    witness,
    ...(signer !== undefined ? { signer } : {}),
    envFor(dataDir) {
      return {
        AOC_ENTERPRISE_ENV: 'production',
        AOC_ENTERPRISE_PERSISTENCE_PROVIDER: 'sqlite',
        AOC_ENTERPRISE_REQUIRE_AUTH: 'true',
        AOC_ENTERPRISE_API_KEYS: `${secrets.legacyKey}:${ORG}`,
        AOC_ENTERPRISE_HTTP_HOST: '127.0.0.1',
        AOC_ENTERPRISE_HTTP_PORT: '0',
        AOC_ENTERPRISE_LOG_LEVEL: 'info',
        AOC_ENTERPRISE_KERNEL_AUTHORITY_ENABLED: 'true',
        AOC_ENTERPRISE_KERNEL_AUTHORITY_REQUIRED: 'true',
        AOC_ENTERPRISE_KERNEL_AUTHORITY_ORGANIZATION_ID: ORG,
        // Every store at the registry's own filenames: what a restore writes is what the Host reads.
        ...storeEnvironmentFor(dataDir),
        ...authorityEnv,
        ...freshnessEnv(witness),
        AOC_ENTERPRISE_GOVERNED_ACTIONS_FILE: filePath,
        FRONTERA_PROD02_ADMIN: secrets.administrator,
        FRONTERA_PROD02_PROVISIONER: secrets.provisioner,
        FRONTERA_PROD02_OBSERVER: secrets.observer,
        FRONTERA_PROD02_RESPONDER: secrets.responder,
        FRONTERA_PROD02_STEWARD: secrets.steward,
        FRONTERA_PROD02_APPROVER_A: secrets.approverA,
        FRONTERA_PROD02_APPROVER_B: secrets.approverB,
        FRONTERA_PROD02_LEGACY_ADMIN: secrets.legacyAdministrator,
        FRONTERA_PROD02_CUSTOMER_KEY: secrets.customerKey,
        FRONTERA_PROD02_PROVIDER_TOKEN: secrets.providerToken,
      };
    },
    secretValues() {
      return [
        ...Object.values(secrets),
        WITNESS_TOKEN,
        // The software-custody private key: the whole PEM and every base64 line of it.
        ...(custody === 'software' ? [AUTHORITY_KEY_A.privateKeyPem, ...AUTHORITY_KEY_A.privateKeyPem.split('\n').filter((line) => line.length > 20 && !line.startsWith('-----'))] : []),
      ];
    },
    dir(name) {
      const path = join(root, name);
      dirs.push(path);
      return path;
    },
    async close() {
      await witness.kill();
      if (signer !== undefined) await signer.kill();
      keys?.cleanup();
      witnessDir.cleanup();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

export interface Prod02Auth {
  readonly administrator: string;
  readonly provisioner: string;
  readonly observer: string;
  readonly responder: string;
  readonly steward: string;
  readonly approverA: string;
  readonly approverB: string;
}

export function authFor(secrets: Prod02Secrets): Prod02Auth {
  return {
    administrator: bearer(secrets.administrator),
    provisioner: bearer(secrets.provisioner),
    observer: bearer(secrets.observer),
    responder: bearer(secrets.responder),
    steward: bearer(secrets.steward),
    approverA: bearer(secrets.approverA),
    approverB: bearer(secrets.approverB),
  };
}

// -- the Host -------------------------------------------------------------------------------

const POLICY_WRITER = { system: true, actorId: 'operator:policy-prod02' } as const;
const POLICY_VERSION = 'policy-pack-prod02-v1';

/** The organization's deterministic policy: every release requires a human approver. */
export function prod02Policy(): PolicyPackProvider {
  const runtime = createPolicyPackRuntime(createPolicyPackRuntimeContext('2026-01-01T00:00:00.000Z'));
  runtime.registerPolicyPack(POLICY_WRITER, { id: 'prod02-policy', name: 'PROD-02 qualification policy', description: 'Synthetic', kind: 'data_boundary', domain: 'general_enterprise' });
  const rule: PolicyPackRule = {
    id: 'release-requires-approval',
    policyPackVersionId: POLICY_VERSION,
    name: 'release-requires-approval',
    description: 'release-requires-approval',
    status: 'active',
    priority: 100,
    condition: { type: 'predicate', field: 'actionClass', operator: 'equals', value: 'deploy' },
    effect: { type: 'require_approval', reasonCode: 'RELEASE_REVIEW', reason: 'A release requires a human approver.' },
    obligations: [],
    evidenceRequirements: [],
    approvalRequirements: [],
    severity: 'error',
    sourceIds: ['prod02-source'],
  };
  runtime.registerPolicyPackVersion(POLICY_WRITER, {
    id: POLICY_VERSION,
    policyPackId: 'prod02-policy',
    version: '1.0.0',
    scope: { resourceScopes: [PROD, LEGACY, EDGE] },
    rules: [rule],
    sources: [{ id: 'prod02-source', type: 'internal_control', title: 'Synthetic', description: 'Synthetic', authority: 'demo_only' }],
    effectiveFrom: '2026-01-01T00:00:00.000Z',
    demoOnly: true,
    legalCompleteness: 'not_legal_advice',
  });
  runtime.activatePolicyPackVersion(POLICY_WRITER, POLICY_VERSION);
  return createActionEnforcementPolicyPackIntegration(runtime);
}

export interface BootedProd02 {
  readonly host: EnterpriseHost;
  readonly adapter: RecordingAdapter;
  readonly baseUrl: string;
}

export async function bootProd02(env: Record<string, string | undefined>, adapter: RecordingAdapter = recordingAdapter()): Promise<BootedProd02> {
  const host = await bootEnterpriseHost({ env, executionAdapters: [adapter], logger: capturingLogger, policyPackProvider: prod02Policy() });
  try {
    const { port } = await host.listen();
    return { host, adapter, baseUrl: `http://127.0.0.1:${port}` };
  } catch (error) {
    await host.close().catch(() => {});
    throw error;
  }
}

/** Boots, expecting a refusal; returns the error. A Host that unexpectedly boots is closed and the test fails. */
export async function bootRefusal(env: Record<string, string | undefined>, adapter: RecordingAdapter): Promise<Error> {
  try {
    const host = await bootEnterpriseHost({ env, executionAdapters: [adapter], logger: capturingLogger, policyPackProvider: prod02Policy() });
    await host.close();
  } catch (error) {
    assert.ok(error instanceof Error);
    return error;
  }
  assert.fail('the Host booted, but it must refuse');
}

// -- provisioning, over HTTP, by identified operators ------------------------------------------

export async function bootstrap(baseUrl: string, auth: Prod02Auth): Promise<void> {
  await create(baseUrl, auth.administrator, 'actor', { actorId: ISSUER, type: 'organization', displayName: 'PROD-02 Organization' });
  await create(baseUrl, auth.administrator, 'trust-domain', { trustDomainId: TRUST_DOMAIN, name: 'PROD-02 Trust Domain', issuerActorId: ISSUER, acceptedIssuerIds: [ISSUER], acceptedActorTypes: ['human', 'organization', 'agent'] });
  await create(baseUrl, auth.administrator, 'root-issuer', { trustDomainId: TRUST_DOMAIN, actorId: ISSUER });
  await create(baseUrl, auth.provisioner, 'actor', { actorId: OWNER, type: 'human', displayName: 'Owner', issuerId: ISSUER, trustDomainId: TRUST_DOMAIN });
}

/** One agent with its credential and delegated authority for `actions` over `resources`. Returns the one-time credential and its id. */
export async function onboard(
  baseUrl: string,
  auth: Prod02Auth,
  options: { readonly agentId: string; readonly subjectId: string; readonly actions: readonly string[]; readonly resources: readonly string[]; readonly constraints?: readonly Record<string, unknown>[] },
): Promise<{ readonly credential: string; readonly credentialId: string }> {
  const { agentId } = options;
  await create(baseUrl, auth.provisioner, 'actor', { actorId: agentId, type: 'agent', displayName: agentId, issuerId: ISSUER, trustDomainId: TRUST_DOMAIN, externalSubject: { system: 'prod02-erp', subjectId: options.subjectId } });
  const issued = expectStatus(await call(baseUrl, 'POST', `/api/admin/agents/${encodeURIComponent(agentId)}/credentials`, { authorization: auth.provisioner, body: { idempotencyKey: `issue-${agentId}` } }), 200, 'issue credential');
  await create(baseUrl, auth.provisioner, 'authority-grant', {
    authorityGrantId: `authority-${agentId}`,
    issuerActorId: ISSUER,
    subjectActorId: OWNER,
    trustDomainId: TRUST_DOMAIN,
    capability: `${agentId}.manage`,
    actions: options.actions,
    resourceScopes: options.resources,
    canDelegate: true,
    allowedDelegateActorTypes: ['agent'],
    maxDelegationDepth: 1,
    ...(options.constraints !== undefined ? { constraints: options.constraints } : {}),
  });
  await create(baseUrl, auth.provisioner, 'passport', { passportId: `passport-${agentId}`, type: 'agent_passport', subjectActorId: agentId, issuerActorId: ISSUER, trustDomainId: TRUST_DOMAIN });
  await create(baseUrl, auth.provisioner, 'capability-token', {
    capabilityTokenId: `capability-${agentId}`,
    subjectActorId: agentId,
    principalActorId: OWNER,
    issuerActorId: OWNER,
    trustDomainId: TRUST_DOMAIN,
    capability: `${agentId}.execute`,
    actions: options.actions,
    resourceScopes: options.resources,
    riskLevel: 'medium',
  });
  await create(baseUrl, auth.provisioner, 'delegation-grant', {
    delegationGrantId: `delegation-${agentId}`,
    delegatorActorId: OWNER,
    delegateActorId: agentId,
    delegateActorType: 'agent',
    trustDomainId: TRUST_DOMAIN,
    sourceAuthorityGrantId: `authority-${agentId}`,
    capability: `${agentId}.execute`,
    actions: options.actions,
    resourceScopes: options.resources,
    canRedelegate: false,
  });
  return { credential: issued.body['bearerCredential'] as string, credentialId: (issued.body['credential'] as { credentialId: string }).credentialId };
}

/** An approver's Kernel-Authority human actor (the operator's canonical identity) with standing for the approver action. */
export async function approverStanding(baseUrl: string, auth: Prod02Auth, operatorId: string): Promise<void> {
  const actorId = `operator:${operatorId}`;
  await create(baseUrl, auth.provisioner, 'actor', { actorId, type: 'human', displayName: `Operator ${operatorId}`, issuerId: ISSUER, trustDomainId: TRUST_DOMAIN });
  await create(baseUrl, auth.provisioner, 'authority-grant', {
    authorityGrantId: `approval-standing-${operatorId}`,
    issuerActorId: ISSUER,
    subjectActorId: actorId,
    trustDomainId: TRUST_DOMAIN,
    capability: `${APPROVE_RELEASE}.standing`,
    actions: [APPROVE_RELEASE],
    resourceScopes: [PROD, LEGACY],
    canDelegate: false,
    allowedDelegateActorTypes: ['human'],
    maxDelegationDepth: 0,
  });
}

export async function profiles(baseUrl: string, auth: Prod02Auth): Promise<readonly Record<string, unknown>[]> {
  return expectStatus(await call(baseUrl, 'GET', '/api/admin/governance-profiles', { authorization: auth.observer }), 200, 'list profiles').body['profiles'] as Record<string, unknown>[];
}

export async function transition(baseUrl: string, auth: Prod02Auth, profileId: string, verb: 'activate' | 'retire'): Promise<void> {
  const view = (await profiles(baseUrl, auth)).find((candidate) => candidate['profileId'] === profileId && candidate['version'] === 1);
  assert.ok(view !== undefined, `${profileId} v1 is in the catalog`);
  expectStatus(await call(baseUrl, 'POST', `/api/admin/governance-profiles/${profileId}/versions/1/${verb}`, { authorization: auth.steward, body: { digest: view['digest'], reason: `prod02 ${verb}` } }), 200, `${verb} ${profileId}`);
}

// -- the governed path ---------------------------------------------------------------------

let sequence = 0;
export function key(prefix: string): string {
  sequence += 1;
  return `prod02-${prefix}-${process.pid}-${sequence}`;
}

export const transfer = (value: string, idempotencyKey: string, resource: string = ACCOUNT): Record<string, unknown> => ({ action: TRANSFER, resource, counterparty: 'vendor-acme', amount: { value, currency: 'USD' }, idempotencyKey });
export const release = (resource: string, idempotencyKey: string): Record<string, unknown> => ({ action: DEPLOY, resource, parameters: { releaseVersion: 'release-2026-10-02' }, idempotencyKey });
export const maintain = (idempotencyKey: string): Record<string, unknown> => ({ action: MAINTAIN, resource: EDGE, parameters: { certificateSerial: 'serial-0042' }, idempotencyKey });
export const restart = (idempotencyKey: string): Record<string, unknown> => ({ action: RESTART, resource: STAGING, idempotencyKey });

export async function govern(baseUrl: string, credential: string, body: Record<string, unknown>): Promise<Reply> {
  return call(baseUrl, 'POST', '/api/governed-actions', { authorization: bearer(credential), body });
}

export async function grantOf(baseUrl: string, auth: Prod02Auth, reply: Reply): Promise<string> {
  const lookup = expectStatus(await call(baseUrl, 'GET', `/api/admin/authority/executions/${encodeURIComponent(reply.body['executionId'] as string)}`, { authorization: auth.observer }), 200, 'execution lookup');
  return lookup.body['grantId'] as string;
}

export async function approvalFor(baseUrl: string, auth: Prod02Auth, requestId: string): Promise<Record<string, unknown>> {
  const all = expectStatus(await call(baseUrl, 'GET', '/api/admin/approvals?view=all', { authorization: auth.observer }), 200, 'inbox').body['approvals'] as Record<string, unknown>[];
  const entry = all.find((candidate) => candidate['requestId'] === requestId);
  assert.ok(entry !== undefined, `request ${requestId} is in the inbox`);
  return expectStatus(await call(baseUrl, 'GET', `/api/admin/approvals/${encodeURIComponent(entry['approvalRequestId'] as string)}`, { authorization: auth.observer }), 200, 'approval detail').body;
}

export async function approvalCommand(baseUrl: string, authorization: string, approval: Record<string, unknown>, verb: 'approve' | 'reject' | 'revoke', body: Record<string, unknown> = {}): Promise<Reply> {
  return call(baseUrl, 'POST', `/api/admin/approvals/${encodeURIComponent(approval['approvalRequestId'] as string)}/${verb}`, { authorization, body: { subjectDigest: approval['subjectDigest'], ...body } });
}

// -- byte-level helpers ------------------------------------------------------------------

/** Every regular file under `dir`, recursively. */
export function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...filesUnder(path));
    else out.push(path);
  }
  return out;
}

/** The secrets found in any file under `dir` (byte-for-byte), and in any extra captured text. */
export function secretsFound(dir: string, secrets: readonly string[], captured: readonly string[] = []): string[] {
  const found: string[] = [];
  const haystacks = [...filesUnder(dir).map((path) => readFileSync(path)), ...captured.map((text) => Buffer.from(text, 'utf8'))];
  for (const secret of secrets) {
    const needle = Buffer.from(secret, 'utf8');
    if (haystacks.some((haystack) => haystack.includes(needle))) found.push(secret.slice(0, 24));
  }
  return found;
}
