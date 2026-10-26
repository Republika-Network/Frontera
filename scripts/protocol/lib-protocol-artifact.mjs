// Shared helpers for the Protocol tarball build/validate scripts.
// Pure functions here are unit-tested directly (see tests/protocol/*.test.mjs);
// the scripts that shell out to git/npm stay thin wrappers around them.

const FULL_SHA_RE = /^[0-9a-f]{40}$/i;
const DISALLOWED_MUTABLE_REFS = new Set(['main', 'master', 'head', 'latest', 'origin/main', 'origin/master']);

export function isFullCommitSha(ref) {
  return typeof ref === 'string' && FULL_SHA_RE.test(ref);
}

export function assertPinnedRef(ref, { label = 'AOC_PROTOCOL_REF' } = {}) {
  if (typeof ref !== 'string' || ref.length === 0) {
    throw new Error(`${label} is required and must be a full 40-character commit SHA.`);
  }
  if (DISALLOWED_MUTABLE_REFS.has(ref.trim().toLowerCase())) {
    throw new Error(
      `${label}="${ref}" is a mutable reference, not a pinned commit. Resolve it to a full commit SHA first (e.g. "git rev-parse <ref>") and pass that SHA instead.`,
    );
  }
  if (!isFullCommitSha(ref)) {
    throw new Error(`${label}="${ref}" is not a full 40-character commit SHA.`);
  }
  return ref.toLowerCase();
}

export function assertCommitMatches(resolvedSha, expectedRef, { label = 'AOC_PROTOCOL_REF' } = {}) {
  if (typeof resolvedSha !== 'string' || !isFullCommitSha(resolvedSha)) {
    throw new Error(`Resolved commit SHA "${resolvedSha}" is not a full 40-character commit SHA.`);
  }
  if (resolvedSha.toLowerCase() !== expectedRef.toLowerCase()) {
    throw new Error(
      `Checked-out commit "${resolvedSha}" does not match the pinned ${label} "${expectedRef}". Refusing to build an unpinned artifact.`,
    );
  }
  return true;
}

export function assertIsProtocolRepository(rootPkg, protocolPkg) {
  if (!rootPkg || rootPkg.name !== 'aoc-runtime') {
    throw new Error(
      `Repository root package.json name is "${rootPkg?.name ?? '<missing>'}", expected "aoc-runtime". This does not look like the Architects_of_Change_Protocol repository.`,
    );
  }
  if (!protocolPkg || protocolPkg.name !== '@aoc/protocol') {
    throw new Error(
      `packages/protocol/package.json name is "${protocolPkg?.name ?? '<missing>'}", expected "@aoc/protocol".`,
    );
  }
  return true;
}

export function assertTarballMatchesPackage(packMeta, protocolPkg) {
  if (!packMeta || packMeta.name !== '@aoc/protocol') {
    throw new Error(`Packed tarball reports package name "${packMeta?.name ?? '<missing>'}", expected "@aoc/protocol".`);
  }
  if (packMeta.version !== protocolPkg.version) {
    throw new Error(
      `Packed tarball version "${packMeta.version}" does not match packages/protocol/package.json version "${protocolPkg.version}".`,
    );
  }
  return true;
}

/**
 * Validates the shape and internal consistency of a protocol-consumer.lock.json document.
 * Pure/offline -- does not touch the filesystem or network. Used by both the CLI checker
 * and the unit tests (including negative fixtures).
 */
export function validateCompatibilityLock(lock) {
  const errors = [];
  if (lock === null || typeof lock !== 'object' || Array.isArray(lock)) {
    return { valid: false, errors: ['Compatibility lock must be a JSON object.'] };
  }

  const requiredStringFields = [
    'repository',
    'commit',
    'package',
    'expectedVersion',
    'enterpriseSupportedVersion',
    'validatedAt',
    'updateProcedure',
  ];
  for (const field of requiredStringFields) {
    if (typeof lock[field] !== 'string' || lock[field].trim().length === 0) {
      errors.push(`Missing or empty required field "${field}".`);
    }
  }

  if (typeof lock.repository === 'string' && lock.repository !== 'Architects-of-Change-Protocol/Architects_of_Change_Protocol') {
    errors.push(`Field "repository" must be exactly "Architects-of-Change-Protocol/Architects_of_Change_Protocol", got "${lock.repository}".`);
  }

  if (typeof lock.commit === 'string' && !isFullCommitSha(lock.commit)) {
    errors.push(`Field "commit" must be a full 40-character commit SHA, got "${lock.commit}".`);
  }

  if (typeof lock.package === 'string' && lock.package !== '@aoc/protocol') {
    errors.push(`Field "package" must be exactly "@aoc/protocol", got "${lock.package}".`);
  }

  if (!lock.tarball || typeof lock.tarball !== 'object') {
    errors.push('Missing required object field "tarball".');
  } else {
    if (typeof lock.tarball.filename !== 'string' || lock.tarball.filename.trim().length === 0) {
      errors.push('Missing required field "tarball.filename".');
    }
    if (typeof lock.tarball.sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(lock.tarball.sha256)) {
      errors.push(`Field "tarball.sha256" must be a 64-character hex SHA-256 digest, got "${lock.tarball?.sha256}".`);
    }
  }

  if (!Array.isArray(lock.verifiedPublicExports) || lock.verifiedPublicExports.length === 0) {
    errors.push('Field "verifiedPublicExports" must be a non-empty array.');
  }

  if (!Array.isArray(lock.knownGaps)) {
    errors.push('Field "knownGaps" must be an array (use an empty array if there are none).');
  }

  // Optional. When present it may name only INTERNAL_DEPENDENCY_PROTOCOL_SUBPATHS, and none of them
  // may also be listed as a public export Frontera source consumes.
  if (lock.internalDependencySubpaths !== undefined) {
    if (!Array.isArray(lock.internalDependencySubpaths)) {
      errors.push('Field "internalDependencySubpaths" must be an array when present.');
    } else {
      for (const subpath of lock.internalDependencySubpaths) {
        if (!INTERNAL_DEPENDENCY_PROTOCOL_SUBPATHS.includes(subpath)) {
          errors.push(`Field "internalDependencySubpaths" may name only ${INTERNAL_DEPENDENCY_PROTOCOL_SUBPATHS.join(', ')}, got "${subpath}".`);
        }
        if (Array.isArray(lock.verifiedPublicExports) && lock.verifiedPublicExports.includes(subpath)) {
          errors.push(`"${subpath}" is an internal dependency and must not also be listed in "verifiedPublicExports".`);
        }
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

// Public subpaths @aoc/protocol actually declares. Anything else (deep
// imports, /src, /dist, /internal, ...) is forbidden. Shared by
// scripts/check-protocol-consumption.mjs and its unit tests.
export const ALLOWED_PROTOCOL_SUBPATHS = Object.freeze([
  '@aoc/protocol',
  '@aoc/protocol/contracts',
  '@aoc/protocol/errors',
  '@aoc/protocol/claims',
  '@aoc/protocol/adapters',
  '@aoc/protocol/runtime-registry',
]);

// Protocol subpaths the approved Soberanía runtime integration may resolve as an internal
// dependency (its @aoc-runtime/crypto requires @aoc/protocol/canonical). They are deliberately NOT
// in ALLOWED_PROTOCOL_SUBPATHS: Frontera source still may not import them, and
// scripts/check-protocol-consumption.mjs keeps rejecting such an import. Recorded in
// protocol-consumer.lock.json -> internalDependencySubpaths.
export const INTERNAL_DEPENDENCY_PROTOCOL_SUBPATHS = Object.freeze(['@aoc/protocol/canonical']);

const SIBLING_PATH_RE = /['"](?:\.\.\/)+Architects_of_Change_Protocol\b/;
const DECLARE_MODULE_RE = /declare\s+module\s+['"]@aoc\/protocol(\/[^'"]*)?['"]/;
const IMPORT_SPECIFIER_RE = /from\s+['"](@aoc\/protocol[^'"]*)['"]/g;

export function isAllowedProtocolImportSpecifier(specifier, allowedSubpaths = ALLOWED_PROTOCOL_SUBPATHS) {
  return allowedSubpaths.includes(specifier);
}

export function extractProtocolImportSpecifiers(text) {
  return [...text.matchAll(IMPORT_SPECIFIER_RE)].map((match) => match[1]);
}

export function containsProtocolSiblingPath(text) {
  return SIBLING_PATH_RE.test(text);
}

export function declaresProtocolModule(text) {
  return DECLARE_MODULE_RE.test(text);
}

/**
 * Cross-checks a freshly-built tarball artifact against a compatibility lock document.
 * Used both by the isolated Enterprise validator (to refuse a tarball that doesn't match
 * what was recorded) and by negative tests.
 */
export function verifyArtifactAgainstLock(artifact, lock) {
  const errors = [];
  if (!artifact || typeof artifact !== 'object') {
    return { valid: false, errors: ['Artifact descriptor is missing or malformed.'] };
  }
  if (artifact.package !== lock.package) {
    errors.push(`Artifact package "${artifact.package}" does not match lock package "${lock.package}".`);
  }
  if (artifact.commit?.toLowerCase() !== lock.commit?.toLowerCase()) {
    errors.push(`Artifact commit "${artifact.commit}" does not match lock commit "${lock.commit}".`);
  }
  if (artifact.version !== lock.expectedVersion) {
    errors.push(`Artifact version "${artifact.version}" does not match lock expectedVersion "${lock.expectedVersion}".`);
  }
  if (artifact.sha256?.toLowerCase() !== lock.tarball?.sha256?.toLowerCase()) {
    errors.push(`Artifact tarball SHA-256 does not match lock tarball.sha256.`);
  }
  return { valid: errors.length === 0, errors };
}
