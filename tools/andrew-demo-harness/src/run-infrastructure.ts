import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { startReferenceAuthorityStateWitness } from '../../../dist/src/enterprise/authority-state-freshness/reference/reference-witness-service.js';
import type { DemoConfiguration } from './contracts.js';
import { DemoFailure } from './contracts.js';
import type { SecretGuard } from './secret-guard.js';

/**
 * ANDREW-P0-11 — one run's own infrastructure, all scoped to its run directory.
 *
 * ```
 * <stateRoot>/runs/<runId>/
 *   run.json                      manifest: demo identity, network, treasury (written before any payment)
 *   host/                         fresh Host + destination governance state — Scenario A always starts unapproved
 *   witness/witness.sqlite        the CORE-07 freshness witness's own database, never beside an authority store
 *   xrpl-attempts.sqlite          the transport's attempt store, fresh for this run
 *   evidence/                     non-secret verification material: the authority public key, the witness public key
 *   summary.json, ANDREW-DEMO-<runId>.md
 * ```
 *
 * Generated per run and held in memory only: the Ed25519 authority signing key
 * (its public half is written to `evidence/` so the run stays independently
 * verifiable), the witness receipt key and token, and the agent, operator and
 * auditor credentials. Each is registered with the secret guard. Nothing is
 * reused from an earlier run, and nothing from the test fixtures is used.
 */

export const DEMO_IDENTITY = 'frontera.andrew-lumx-demo.v1';
export const DEMO_ORGANIZATION = 'org-andrew-demo';
export const DEMO_TRUST_DOMAIN = 'trust-domain-andrew-demo';
export const DEMO_AGENT_PRINCIPAL = 'principal-andrew-agent';
export const DEMO_OPERATOR = { operatorId: 'andrew-admin', role: 'organization-administrator' } as const;
export const DEMO_REGISTRAR = 'operator:andrew-registrar';

export interface RunPaths {
  readonly runId: string;
  readonly runDirectory: string;
  readonly hostDirectory: string;
  readonly witnessDirectory: string;
  readonly evidenceDirectory: string;
  readonly attemptStorePath: string;
}

export interface RunManifest {
  readonly schema: 'frontera.andrew-demo.run.v1';
  readonly runId: string;
  readonly demoIdentity: string;
  readonly network: 'xrpl-testnet';
  readonly networkId: number;
  readonly treasury: string;
  readonly recipient: string;
  readonly startedAt: string;
}

export function newRunId(now: Date): string {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  return `andrew-${stamp}-${randomBytes(3).toString('hex')}`;
}

/** Creates a brand-new run directory (never reuses one) and writes its manifest before anything else happens. */
export function createRun(configuration: DemoConfiguration, runId: string, startedAt: string): RunPaths {
  const runsRoot = join(configuration.stateRoot, 'runs');
  mkdirSync(runsRoot, { recursive: true, mode: 0o700 });
  const runDirectory = join(runsRoot, runId);
  try {
    mkdirSync(runDirectory, { mode: 0o700 });
  } catch {
    throw new DemoFailure('PRECONDITION FAILURE', `the run directory ${runDirectory} already exists — a run is never reused`);
  }
  const paths: RunPaths = {
    runId,
    runDirectory,
    hostDirectory: join(runDirectory, 'host'),
    witnessDirectory: join(runDirectory, 'witness'),
    evidenceDirectory: join(runDirectory, 'evidence'),
    attemptStorePath: join(runDirectory, 'xrpl-attempts.sqlite'),
  };
  for (const directory of [paths.hostDirectory, paths.witnessDirectory, paths.evidenceDirectory]) mkdirSync(directory, { mode: 0o700 });
  const manifest: RunManifest = { schema: 'frontera.andrew-demo.run.v1', runId, demoIdentity: DEMO_IDENTITY, network: 'xrpl-testnet', networkId: configuration.expectedNetworkId, treasury: configuration.treasury, recipient: configuration.recipient, startedAt };
  writeFileSync(join(runDirectory, 'run.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  return paths;
}

export interface RunInfrastructure {
  /** The Host's secure environment. Holds generated secrets: in memory only, never printed or written. */
  readonly environment: Readonly<Record<string, string>>;
  readonly credentials: { readonly agent: string; readonly operator: string; readonly auditor: string };
  readonly verificationMaterial: { readonly authorityKeyId: string; readonly authorityVerificationKeysFile: string; readonly witnessId: string; readonly witnessPublicKeyFile: string };
  close(): Promise<void>;
}

function ed25519(): { readonly privateKeyPem: string; readonly publicKeyPem: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return { privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString() };
}

const credential = (label: string): string => `frontera-andrew-${label}-${randomBytes(24).toString('hex')}`;

/** Start the run's witness (explicit demo infrastructure, scoped to the run) and assemble the Host environment. */
export async function startRunInfrastructure(paths: RunPaths, guard: SecretGuard): Promise<RunInfrastructure> {
  const authorityKey = ed25519();
  const authorityKeyId = `andrew-demo-authority-${paths.runId}`;
  const witnessKey = ed25519();
  const witnessToken = randomBytes(32).toString('hex');
  const witnessId = `andrew-demo-witness-${paths.runId}`;
  const credentials = { agent: credential('agent'), operator: credential('operator'), auditor: credential('auditor') };
  for (const secret of [authorityKey.privateKeyPem, witnessKey.privateKeyPem, witnessToken, credentials.agent, credentials.operator, credentials.auditor]) guard.register(secret);

  const verificationKeys = [{ keyId: authorityKeyId, algorithm: 'ed25519-v1', publicKeyPem: authorityKey.publicKeyPem }];
  const authorityVerificationKeysFile = join(paths.evidenceDirectory, 'authority-verification-keys.json');
  const witnessPublicKeyFile = join(paths.evidenceDirectory, 'witness-public-key.pem');
  writeFileSync(authorityVerificationKeysFile, `${JSON.stringify(verificationKeys, null, 2)}\n`);
  writeFileSync(witnessPublicKeyFile, witnessKey.publicKeyPem);

  const witness = await startReferenceAuthorityStateWitness({ witnessId, privateKeyPem: witnessKey.privateKeyPem, credential: witnessToken, databasePath: join(paths.witnessDirectory, 'witness.sqlite') });
  let closed = false;
  const dir = paths.hostDirectory;
  const environment: Record<string, string> = {
    AOC_ENTERPRISE_ENV: 'production',
    AOC_ENTERPRISE_PERSISTENCE_PROVIDER: 'sqlite',
    AOC_ENTERPRISE_REQUIRE_AUTH: 'true',
    AOC_ENTERPRISE_API_KEYS: `${credentials.auditor}:${DEMO_ORGANIZATION}`,
    AOC_ENTERPRISE_HTTP_HOST: '127.0.0.1',
    AOC_ENTERPRISE_HTTP_PORT: '0',
    AOC_ENTERPRISE_LOG_LEVEL: 'error',
    AOC_ENTERPRISE_KERNEL_AUTHORITY_ENABLED: 'true',
    AOC_ENTERPRISE_KERNEL_AUTHORITY_ORGANIZATION_ID: DEMO_ORGANIZATION,
    AOC_ENTERPRISE_SQLITE_PATH: join(dir, 'governance.sqlite'),
    AOC_ENTERPRISE_PASSPORT_SQLITE_PATH: join(dir, 'passport.sqlite'),
    AOC_ENTERPRISE_ASSURANCE_SQLITE_PATH: join(dir, 'assurance.sqlite'),
    AOC_ENTERPRISE_KERNEL_AUTHORITY_SQLITE_PATH: join(dir, 'kernel-authority.sqlite'),
    AOC_ENTERPRISE_BOUNDED_GRANT_SQLITE_PATH: join(dir, 'bounded-grants.sqlite'),
    AOC_ENTERPRISE_EMERGENCY_CONTROL_SQLITE_PATH: join(dir, 'emergency-controls.sqlite'),
    AOC_ENTERPRISE_EXERCISE_LEDGER_SQLITE_PATH: join(dir, 'exercise-ledger.sqlite'),
    AOC_ENTERPRISE_AUTHORITY_EVENT_STREAM_SQLITE_PATH: join(dir, 'authority-event-stream.sqlite'),
    AOC_ENTERPRISE_EXECUTION_OUTCOME_SQLITE_PATH: join(dir, 'execution-outcomes.sqlite'),
    AOC_ENTERPRISE_EXECUTION_RESOLUTION_SQLITE_PATH: join(dir, 'execution-resolutions.sqlite'),
    AOC_ENTERPRISE_OBLIGATION_DISCHARGE_SQLITE_PATH: join(dir, 'obligation-discharges.sqlite'),
    AOC_ENTERPRISE_APPROVAL_SQLITE_PATH: join(dir, 'approvals.sqlite'),
    AOC_ENTERPRISE_AUTHORITY_SIGNING_KEY_ID: authorityKeyId,
    AOC_ENTERPRISE_AUTHORITY_SIGNING_KEY_PEM: authorityKey.privateKeyPem,
    AOC_ENTERPRISE_AUTHORITY_VERIFICATION_KEYS: JSON.stringify(verificationKeys),
    AOC_ENTERPRISE_AUTHORITY_FRESHNESS_MODE: 'external',
    AOC_ENTERPRISE_AUTHORITY_FRESHNESS_ENDPOINT: `http://127.0.0.1:${witness.port}`,
    AOC_ENTERPRISE_AUTHORITY_FRESHNESS_TOKEN: witnessToken,
    AOC_ENTERPRISE_AUTHORITY_FRESHNESS_WITNESS_ID: witnessId,
    AOC_ENTERPRISE_AUTHORITY_FRESHNESS_WITNESS_PUBLIC_KEY: witnessKey.publicKeyPem,
    AOC_ENTERPRISE_AUTHORITY_FRESHNESS_TIMEOUT_MS: '2000',
    AOC_ENTERPRISE_AUTHORITY_FRESHNESS_MAX_ATTEMPTS: '1',
    AOC_ENTERPRISE_AUTHORITY_FRESHNESS_PROBE_INTERVAL_MS: '0',
    FRONTERA_ANDREW_AGENT_KEY: credentials.agent,
    FRONTERA_ANDREW_OPERATOR_KEY: credentials.operator,
  };
  return {
    environment: Object.freeze(environment),
    credentials,
    verificationMaterial: { authorityKeyId, authorityVerificationKeysFile, witnessId, witnessPublicKeyFile },
    async close() {
      if (closed) return;
      closed = true;
      await witness.close();
    },
  };
}

/** The identity the Andrew composition provisions: Andrew's agent, and one CTRL-02 operator who may approve destinations. */
export function demoIdentity() {
  return {
    trustDomainId: DEMO_TRUST_DOMAIN,
    agent: { principalId: DEMO_AGENT_PRINCIPAL, externalSubject: { system: 'andrew-demo', subjectId: 'treasury-agent' }, apiKeyEnv: 'FRONTERA_ANDREW_AGENT_KEY' },
    operators: [{ ...DEMO_OPERATOR, apiKeyEnv: 'FRONTERA_ANDREW_OPERATOR_KEY' }],
  };
}
