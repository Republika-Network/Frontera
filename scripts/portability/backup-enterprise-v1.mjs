#!/usr/bin/env node
// AOC Enterprise v1 backup command (`npm run backup:v1 -- --output <dir>`).
//
// Produces a self-describing `aoc.enterprise.backup.v1` backup set: a
// transactionally-consistent copy of every durable SQLite store the deployment
// composes (via SQLite's Online Backup API, never a plain `cp` of a live WAL
// database), a canonical manifest with an explicit PROD-02 coverage block, a
// checksums file, and a generated RESTORE.md. See
// docs/operations/AOC_ENTERPRISE_BACKUP_V1.md for the full contract.
//
// Usage:
//   node scripts/portability/backup-enterprise-v1.mjs --output <dir> [--force] [--cold] [--allow-missing-stores]
//
// Reads store locations from the same environment variables the Enterprise
// Host itself reads (AOC_ENTERPRISE_SQLITE_PATH and friends) via
// `loadEnterpriseConfiguration()`, and which conditional stores the
// deployment composes from the governed-action file's *structure*
// (`deriveDeploymentRequirements`) — never by resolving a secret. The store
// list itself is `store-registry.mjs`; there is no second one here.
//
// What is never written into a backup: any secret value, any private key, the
// CORE-07 freshness witness's state. The manifest names the secret variables
// an operator must restore from the secret manager, and records only public,
// non-secret identities (key ids, algorithms, public-key fingerprints, the
// witness id).

import { createHash, createPublicKey } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { platform, arch } from 'node:os';

import {
  BACKUP_FORMAT,
  REPO_ROOT,
  loadEnterpriseModule,
  sha256File,
  stableJsonStringify,
  assertNoPathOverlap,
  sqliteIntegrityCheck,
  readStoreVersion,
  recordCount,
  tableCounts,
  readSignedHead,
  sqliteSidecars,
  safeSqliteCopy,
  gitInfo,
  createStagingDir,
  atomicPromote,
  cleanupDir,
  fileSize,
} from './lib-portability.mjs';
import {
  COVERAGE_MODEL,
  STORE_DEFINITIONS,
  EXCLUDED_DURABLE_STATE,
  STATIC_SECRET_ENV_VARS,
  deriveDeploymentRequirements,
  conditionHolds,
  loadRegistryModules,
} from './store-registry.mjs';

function parseArgs(argv) {
  const args = { force: false, cold: false, allowMissingStores: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--output') args.output = argv[++i];
    else if (arg === '--force' || arg === '--replace') args.force = true;
    else if (arg === '--cold') args.cold = true;
    else if (arg === '--allow-missing-stores') args.allowMissingStores = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!args.output) throw new Error('Usage: backup-enterprise-v1.mjs --output <dir> [--force] [--cold] [--allow-missing-stores]');
  return args;
}

/** SHA-256 of a public key's SPKI DER — a fingerprint that identifies the key without carrying it. `null` if it does not parse as a public key. */
function publicKeyFingerprint(publicKeyPem) {
  if (typeof publicKeyPem !== 'string' || /PRIVATE KEY/.test(publicKeyPem)) return null;
  try {
    const der = createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' });
    return `sha256:${createHash('sha256').update(der).digest('hex')}`;
  } catch {
    return null;
  }
}

/**
 * The non-secret identity of the authority signer and the freshness witness:
 * which mode, which key ids, which public keys (fingerprints), which witness.
 * Built from named fields only — the private key, the signer token and the
 * witness token are never read here.
 */
function safeAuthorityIdentity(configuration) {
  const authenticity = configuration.authorityAuthenticity ?? {};
  const freshness = configuration.authorityFreshness ?? { mode: 'none' };
  return {
    signer: {
      mode: authenticity.mode === 'external' ? 'external' : 'software',
      activeSigningKeyId: authenticity.activeSigningKeyId ?? null,
      trustedVerificationKeys: (authenticity.verificationKeys ?? []).map((key) => ({
        keyId: key.keyId,
        algorithm: key.algorithm,
        publicKeyFingerprint: publicKeyFingerprint(key.publicKeyPem),
      })),
      privateKeyIncluded: false,
      signerCredentialIncluded: false,
    },
    freshness: {
      mode: freshness.mode === 'external' ? 'external' : 'none',
      witnessId: freshness.mode === 'external' ? freshness.witness.witnessId : null,
      witnessPublicKeyFingerprint: freshness.mode === 'external' ? publicKeyFingerprint(freshness.witness.publicKeyPem) : null,
      // CORE-07: the witness's own state is never part of this backup set.
      witnessStateIncluded: false,
      witnessCredentialIncluded: false,
    },
  };
}

function renderRestoreMd(manifest) {
  const storeLines = manifest.stores
    .map((store) => `- \`stores/${store.filename}\` -- ${store.name} (\`${store.envVar}\`; schema \`${store.schemaVersion}\`, ${store.sizeBytes} bytes, ${store.checksum})`)
    .join('\n');
  const notIncluded = manifest.coverage.stores.filter((entry) => !entry.included).map((entry) => `- ${entry.name}: ${entry.status}`).join('\n');
  const secretLines = manifest.configuration.secretEnvironmentVariables.map((name) => `- \`${name}\``).join('\n');
  return `# Restoring backup \`${manifest.backupId}\`

Created: ${manifest.createdAt}
Source commit: \`${manifest.source.commit}\`
Enterprise version: \`${manifest.enterprise.enterpriseVersion}\`
Coverage: **${manifest.coverage.complete ? 'complete' : 'INCOMPLETE'}** for the source configuration (\`${manifest.coverage.coverageModel}\`)
Consistency: \`${manifest.consistency.mode}\`

## Contents

${storeLines}

${notIncluded.length > 0 ? `Not included:\n\n${notIncluded}\n` : 'Every store the source deployment composes is included.\n'}
## Restore

From the repository root of a build at commit \`${manifest.source.commit}\` (or a
build whose store schema versions match \`metadata/store-versions.json\`):

\`\`\`bash
npm run restore:v1 -- --backup <this-directory> --target <fresh-data-directory>
\`\`\`

See \`docs/operations/AOC_ENTERPRISE_RESTORE_V1.md\` for the full procedure,
compatibility matrix, and failure modes. Do not hand-copy these files --
\`restore:v1\` validates coverage, checksums, SQLite integrity, schema
compatibility and signed-head consistency before touching the target
directory, and refuses to overwrite existing stores without \`--force\`.

## What this backup does NOT contain

No secret value and no private key. Restore these from your secret manager
(names only, never values):

${secretLines}

The CORE-07 freshness witness's state is **not** in this backup and must not
be restored with it: restore the authority stores only, and start the Host
against the **surviving** witness (witness id \`${manifest.authority.freshness.witnessId ?? 'n/a'}\`).
Never reset or re-enroll the witness to make a restored store start --
docs/operations/AOC_ENTERPRISE_RESTORE_V1.md, "Freshness witness".
`;
}

/**
 * Takes a backup.
 *
 * `cold` — the operator attests the Host is stopped. The tool cannot prove a
 * Host is stopped; it can only refuse when it sees evidence that one is not
 * (a non-empty WAL sidecar beside a source store). The manifest records both
 * the attestation and what was observed, and never claims more.
 *
 * `allowMissingStores` — development/forensics only: a configured store whose
 * file is absent is recorded as `missing-allowed`, and the backup is marked
 * `coverage.complete: false`. A restore refuses an incomplete backup unless it
 * is told to accept one explicitly.
 */
export async function runBackup({ output, force = false, cold = false, allowMissingStores = false, env = process.env }) {
  const enterprise = await loadEnterpriseModule();
  const modules = await loadRegistryModules(REPO_ROOT);
  const configuration = enterprise.loadEnterpriseConfiguration(env);

  if (configuration.persistence.provider !== 'sqlite') {
    throw new Error(
      "backup:v1 requires AOC_ENTERPRISE_PERSISTENCE_PROVIDER=sqlite. The 'memory' provider keeps no durable state and has nothing to back up.",
    );
  }

  const requirements = deriveDeploymentRequirements(env, configuration);
  const outputPath = resolve(output);

  // A store is read only when this deployment requires it, or when the
  // operator named its file explicitly (an embedder-composed store, e.g. P12).
  // A default path that merely happens to exist is never swept in: it is not
  // this deployment's state.
  const plan = STORE_DEFINITIONS.map((storeDef) => {
    const configuredPath = storeDef.configPathOf(configuration);
    const sourcePath = resolve(configuredPath);
    const required = conditionHolds(storeDef.condition, requirements);
    const named = typeof env[storeDef.envVar] === 'string' && env[storeDef.envVar] !== '';
    const onDisk = existsSync(sourcePath);
    const present = (required || named) && onDisk;
    // Neither required nor named, yet a file sits at its default path: not
    // backed up, but never silently -- the manifest and the report say so.
    const unclaimed = !required && !named && onDisk;
    return { storeDef, configuredPath, sourcePath, required, present, unclaimed };
  });

  for (const entry of plan) {
    if (!entry.required && !entry.present) continue;
    assertNoPathOverlap(outputPath, entry.sourcePath, `Backup output directory must not overlap a source store path (${entry.storeDef.name})`);
  }

  const missingRequired = plan.filter((entry) => entry.required && !entry.present);
  if (missingRequired.length > 0 && !allowMissingStores) {
    const [first] = missingRequired;
    throw new Error(
      `Required store '${first.storeDef.name}' has no database file at '${first.sourcePath}' (${first.storeDef.envVar}; condition '${first.storeDef.condition}'). ` +
        `Missing: ${missingRequired.map((entry) => entry.storeDef.name).join(', ')}. A complete backup cannot omit a store this deployment composes. ` +
        'Start the Enterprise Host once against this configuration (it creates its stores), or -- for development/forensics only -- pass --allow-missing-stores to write a backup explicitly marked INCOMPLETE.',
    );
  }

  // Quiescence evidence (never proof): a non-empty WAL beside a source store
  // means some connection has uncheckpointed writes -- a live Host, or one
  // that did not shut down cleanly.
  const walObserved = plan
    .filter((entry) => entry.present)
    .flatMap((entry) => sqliteSidecars(entry.sourcePath).filter((path) => path.endsWith('-wal') && statSync(path).size > 0).map(() => entry.storeDef.name));
  if (cold && walObserved.length > 0) {
    throw new Error(
      `--cold was requested, but store(s) ${walObserved.join(', ')} have a non-empty WAL sidecar: a Host appears to be running (or did not shut down cleanly). Stop the Host and retry; a cold backup is the only cross-store-consistent backup.`,
    );
  }

  if (existsSync(outputPath) && readdirSync(outputPath).length > 0 && !force) {
    throw new Error(`Output directory '${outputPath}' already exists and is non-empty. Pass --force to replace it.`);
  }

  const startedAt = new Date().toISOString();
  const staging = createStagingDir(outputPath, 'backup');
  const storesDir = join(staging, 'stores');
  const metadataDir = join(staging, 'metadata');
  mkdirSync(storesDir, { recursive: true });
  mkdirSync(metadataDir, { recursive: true });

  try {
    const storeEntries = [];
    const coverageStores = [];
    for (const entry of plan) {
      const { storeDef, required, present } = entry;
      if (!present) {
        coverageStores.push({
          name: storeDef.name,
          envVar: storeDef.envVar,
          condition: storeDef.condition,
          required,
          present: entry.unclaimed,
          included: false,
          status: required ? 'missing-allowed' : entry.unclaimed ? 'present-not-configured' : 'not-configured',
        });
        continue;
      }

      const destPath = join(storesDir, storeDef.filename);
      try {
        await safeSqliteCopy(entry.sourcePath, destPath);
      } catch (error) {
        throw new Error(`Store '${storeDef.name}' could not be copied with the SQLite Online Backup API (${error.message}). Refusing to back up a store that is not a readable database.`);
      }

      const integrity = await sqliteIntegrityCheck(destPath).catch((error) => ({ ok: false, detail: error.message }));
      if (!integrity.ok) {
        throw new Error(`SQLite integrity check failed for store '${storeDef.name}' immediately after copy: ${integrity.detail}`);
      }

      const version = await readStoreVersion(destPath, storeDef.version);
      const supported = storeDef.supportedSchemaVersionsOf(modules);
      if (version.schemaVersion === null || !supported.includes(version.schemaVersion)) {
        throw new Error(
          `Store '${storeDef.name}' reports schema version '${String(version.schemaVersion)}' but this build's runtime supports ${supported.map((v) => `'${v}'`).join(', ')}. Refusing to back up a store this build cannot itself open.`,
        );
      }

      // The signed head travels inside the same file as its rows (the whole
      // database is copied); this only records it, and refuses a file whose
      // head and rows already disagree.
      const signedHead = await readSignedHead(destPath, storeDef.signedHead);
      if (signedHead !== null && !signedHead.consistent) {
        throw new Error(`Store '${storeDef.name}' has an inconsistent signed head (${signedHead.problem}). Refusing to back up authority state that does not verify structurally.`);
      }

      storeEntries.push({
        name: storeDef.name,
        filename: storeDef.filename,
        envVar: storeDef.envVar,
        originalPath: entry.configuredPath,
        sizeBytes: fileSize(destPath),
        checksum: sha256File(destPath),
        schemaVersion: version.schemaVersion,
        migrationState: version.migrationState,
        required,
        condition: storeDef.condition,
        recordCount: await recordCount(destPath, storeDef.recordTable),
        tableCounts: await tableCounts(destPath),
        integrityCheck: 'ok',
        ...(signedHead !== null
          ? {
              signedHead: {
                storeId: signedHead.storeId,
                organizationId: signedHead.organizationId,
                sequence: signedHead.sequence,
                stateDigest: signedHead.stateDigest,
                signingKeyId: signedHead.signingKeyId,
                freshnessStateKind: storeDef.freshnessStateKind ?? null,
              },
            }
          : {}),
      });
      coverageStores.push({ name: storeDef.name, envVar: storeDef.envVar, condition: storeDef.condition, required, present: true, included: true, status: 'included' });
    }

    if (storeEntries.length === 0) {
      throw new Error('No store files were found to back up.');
    }

    const complete = coverageStores.every((entry) => !entry.required || entry.included);
    const { commit, branch } = gitInfo();
    const backupId = `backup-${startedAt.replace(/[:.]/g, '-')}-${commit ? commit.slice(0, 12) : 'unknown'}`;
    const secretEnvironmentVariables = [...new Set([...STATIC_SECRET_ENV_VARS, ...requirements.secretReferenceEnvVars])].sort();

    const manifest = {
      backupFormat: BACKUP_FORMAT,
      backupId,
      createdAt: startedAt,
      source: {
        commit: commit ?? 'unknown',
        branch: branch ?? 'unknown',
        releaseVersion: configuration.enterpriseVersion,
        nodeVersion: process.version,
        platform: platform(),
        architecture: arch(),
      },
      enterprise: {
        enterpriseVersion: enterprise.AOC_ENTERPRISE_HOST_VERSION,
        kernelVersion: configuration.enterpriseVersion,
        governanceStoreVersion: enterprise.AOC_GOVERNANCE_STORE_VERSION,
        evidenceRuntimeVersion: enterprise.AOC_EVIDENCE_BUNDLE_VERSION,
        passportRuntimeVersion: enterprise.AOC_AGENT_PASSPORT_RUNTIME_VERSION,
        assuranceRuntimeVersion: enterprise.AOC_ASSURANCE_RUNTIME_VERSION,
      },
      stores: storeEntries,
      // PROD-02: explicit coverage, so an incomplete backup can never pass for
      // a complete one, and a pre-PROD-02 backup (no `coverage`) is
      // recognizable as such.
      coverage: {
        coverageModel: COVERAGE_MODEL,
        complete,
        registry: STORE_DEFINITIONS.map((storeDef) => storeDef.name),
        deployment: {
          environment: configuration.environment,
          organizationId: configuration.kernelAuthority.organizationId,
          persistenceProvider: requirements.persistenceProvider,
          kernelAuthorityEnabled: requirements.kernelAuthorityEnabled,
          governedActions: requirements.governedActions,
          obligationsDeclared: requirements.obligationsDeclared,
          approvalsDeclared: requirements.approvalsDeclared,
          operatorsConfigured: requirements.operatorsConfigured,
          executionReconciliation: requirements.executionReconciliation,
          governedActionsFileDigest: requirements.governedActionsFileDigest,
        },
        stores: coverageStores,
        excluded: EXCLUDED_DURABLE_STATE.map((entry) => ({ name: entry.name, reason: entry.reason })),
      },
      consistency: {
        // `cold-attested`: the operator said the Host was stopped and no
        // evidence contradicted it. The tool never claims to have proven it.
        mode: cold ? 'cold-attested' : 'live-per-file',
        operatorAttestedStopped: cold,
        nonEmptyWalObserved: walObserved,
        toolVerifiedHostStopped: false,
        crossStoreAtomic: false,
      },
      authority: safeAuthorityIdentity(configuration),
      configuration: {
        requiredEnvironmentVariables: STORE_DEFINITIONS.filter((storeDef) => coverageStores.find((c) => c.name === storeDef.name)?.included).map((storeDef) => storeDef.envVar),
        // Names only. Values live in the secret manager and are never read here.
        secretEnvironmentVariables,
        excludedSecrets: secretEnvironmentVariables,
        secretValuesIncluded: false,
      },
      verification: {
        checksumAlgorithm: 'sha256',
        sqliteIntegrityChecked: true,
        schemaVersionChecked: true,
        signedHeadStructureChecked: true,
        recordIntegrityChecked: false,
      },
      notes: [
        'Evidence Bundles are not included: the Evidence Bundle Store is in-memory only in v1 (see AOC_ENTERPRISE_V1_PORTABILITY_CURRENT_STATE.md). Bundles are deterministically rebuildable from the Governance Store after restore.',
        'Each store is a transactionally-consistent copy taken with the SQLite Online Backup API. The store files are NOT one atomic snapshot: for strict cross-store consistency, stop the Host and pass --cold (docs/operations/BACKUP_RECOVERY_V1.md, "Cold backup").',
        'The CORE-07 freshness witness state is never part of this backup. Restore the authority stores only and start against the surviving witness.',
      ],
    };

    writeFileSync(join(metadataDir, 'store-versions.json'), stableJsonStringify(Object.fromEntries(storeEntries.map((s) => [s.name, { schemaVersion: s.schemaVersion, migrationState: s.migrationState }]))));
    writeFileSync(join(metadataDir, 'runtime-versions.json'), stableJsonStringify(manifest.enterprise));
    writeFileSync(join(metadataDir, 'release-context.json'), stableJsonStringify(manifest.source));

    const finishedAt = new Date().toISOString();
    const verificationSummary = {
      startedAt,
      finishedAt,
      storesBackedUp: storeEntries.map((s) => s.name),
      coverageComplete: complete,
      allIntegrityChecksPassed: storeEntries.every((s) => s.integrityCheck === 'ok'),
    };
    writeFileSync(join(metadataDir, 'verification-summary.json'), stableJsonStringify(verificationSummary));

    writeFileSync(join(staging, 'backup-manifest.json'), stableJsonStringify(manifest));
    writeFileSync(join(staging, 'RESTORE.md'), renderRestoreMd(manifest));

    const checksumLines = [];
    for (const store of storeEntries) checksumLines.push(`${store.checksum.replace('sha256:', '')}  stores/${store.filename}`);
    for (const file of ['metadata/store-versions.json', 'metadata/runtime-versions.json', 'metadata/release-context.json', 'metadata/verification-summary.json', 'backup-manifest.json']) {
      checksumLines.push(`${sha256File(join(staging, file)).replace('sha256:', '')}  ${file}`);
    }
    writeFileSync(join(staging, 'checksums.sha256'), `${checksumLines.join('\n')}\n`);

    atomicPromote(staging, outputPath, { force });

    const report = {
      backupId,
      sourceCommit: manifest.source.commit,
      releaseVersion: manifest.enterprise.enterpriseVersion,
      coverageComplete: complete,
      consistency: manifest.consistency.mode,
      stores: storeEntries.map((s) => ({ name: s.name, schemaVersion: s.schemaVersion, checksum: s.checksum, sizeBytes: s.sizeBytes, recordCount: s.recordCount })),
      notIncluded: coverageStores.filter((c) => !c.included).map((c) => ({ name: c.name, status: c.status })),
      warnings: coverageStores
        .filter((c) => c.status === 'present-not-configured')
        .map((c) => `A '${c.name}' database exists at its default path but ${c.envVar} is not set and this deployment does not require it: NOT backed up. If an embedder composes it, set ${c.envVar} explicitly.`),
      excludedSecrets: secretEnvironmentVariables,
      startedAt,
      finishedAt,
      durationMs: Date.parse(finishedAt) - Date.parse(startedAt),
      outputPath,
    };
    return report;
  } catch (error) {
    cleanupDir(staging);
    throw error;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const report = await runBackup(args);
  console.log(`Backup '${report.backupId}' written to ${report.outputPath}${report.coverageComplete ? '' : ' -- INCOMPLETE (missing stores were allowed)'}`);
  for (const warning of report.warnings) console.log(`WARNING: ${warning}`);
  console.log(JSON.stringify(report, null, 2));
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname);
if (isMain) {
  main().catch((error) => {
    console.error(`[backup:v1] ${error.message}`);
    process.exitCode = 1;
  });
}
