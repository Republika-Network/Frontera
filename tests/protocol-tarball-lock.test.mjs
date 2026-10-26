import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ALLOWED_PROTOCOL_SUBPATHS,
  INTERNAL_DEPENDENCY_PROTOCOL_SUBPATHS,
  assertCommitMatches,
  assertIsProtocolRepository,
  assertPinnedRef,
  assertTarballMatchesPackage,
  containsProtocolSiblingPath,
  declaresProtocolModule,
  extractProtocolImportSpecifiers,
  isAllowedProtocolImportSpecifier,
  isFullCommitSha,
  validateCompatibilityLock,
  verifyArtifactAgainstLock,
} from '../scripts/protocol/lib-protocol-artifact.mjs';

const VALID_SHA = '7049fadb6144808b78c5102fce490feba324b80f';
const OTHER_SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';

function validLock(overrides = {}) {
  return {
    repository: 'Architects-of-Change-Protocol/Architects_of_Change_Protocol',
    commit: VALID_SHA,
    package: '@aoc/protocol',
    expectedVersion: '0.1.0',
    enterpriseSupportedVersion: '1.0.0',
    validatedAt: '2026-07-14',
    updateProcedure: 'See docs/integration/PROTOCOL_PACKAGE_CONSUMPTION.md.',
    tarball: { filename: 'aoc-protocol-0.1.0.tgz', sha256: 'a'.repeat(64) },
    verifiedPublicExports: ['@aoc/protocol'],
    knownGaps: [],
    ...overrides,
  };
}

function validArtifact(overrides = {}) {
  return {
    package: '@aoc/protocol',
    commit: VALID_SHA,
    version: '0.1.0',
    sha256: 'a'.repeat(64),
    ...overrides,
  };
}

// --- isFullCommitSha / assertPinnedRef ---------------------------------------

test('isFullCommitSha accepts a full 40-char hex SHA and rejects everything else', () => {
  assert.equal(isFullCommitSha(VALID_SHA), true);
  assert.equal(isFullCommitSha('main'), false);
  assert.equal(isFullCommitSha('HEAD'), false);
  assert.equal(isFullCommitSha('7049fad'), false); // abbreviated
  assert.equal(isFullCommitSha(''), false);
  assert.equal(isFullCommitSha(undefined), false);
});

test('assertPinnedRef rejects mutable refs like main/HEAD/latest', () => {
  for (const mutableRef of ['main', 'master', 'HEAD', 'latest', 'origin/main']) {
    assert.throws(() => assertPinnedRef(mutableRef), /mutable reference/);
  }
});

test('assertPinnedRef rejects a missing or empty ref', () => {
  assert.throws(() => assertPinnedRef(undefined), /required/);
  assert.throws(() => assertPinnedRef(''), /required/);
});

test('assertPinnedRef rejects an abbreviated SHA', () => {
  assert.throws(() => assertPinnedRef('7049fad'), /full 40-character commit SHA/);
});

test('assertPinnedRef accepts and lowercases a full commit SHA', () => {
  assert.equal(assertPinnedRef(VALID_SHA.toUpperCase()), VALID_SHA);
});

// --- assertCommitMatches ------------------------------------------------------

test('assertCommitMatches passes when the resolved commit equals the pinned ref', () => {
  assert.equal(assertCommitMatches(VALID_SHA, VALID_SHA), true);
});

test('assertCommitMatches fails when the checked-out commit does not match the pinned ref', () => {
  assert.throws(() => assertCommitMatches(OTHER_SHA, VALID_SHA), /does not match the pinned/);
});

// --- assertIsProtocolRepository / assertTarballMatchesPackage ---------------

test('assertIsProtocolRepository rejects a repository that is not Soberanía Protocol', () => {
  assert.throws(
    () => assertIsProtocolRepository({ name: 'some-other-repo' }, { name: '@aoc/protocol' }),
    /does not look like the Architects_of_Change_Protocol repository/,
  );
  assert.throws(
    () => assertIsProtocolRepository({ name: 'aoc-runtime' }, { name: '@not/protocol' }),
    /expected "@aoc\/protocol"/,
  );
});

test('assertTarballMatchesPackage rejects a mismatched package name or version', () => {
  const protocolPkg = { name: '@aoc/protocol', version: '0.1.0' };
  assert.throws(() => assertTarballMatchesPackage({ name: '@evil/package', version: '0.1.0' }, protocolPkg), /reports package name/);
  assert.throws(() => assertTarballMatchesPackage({ name: '@aoc/protocol', version: '9.9.9' }, protocolPkg), /does not match/);
  assert.equal(assertTarballMatchesPackage({ name: '@aoc/protocol', version: '0.1.0' }, protocolPkg), true);
});

// --- Import allowlist / sibling-path / declare-module detection --------------

test('isAllowedProtocolImportSpecifier allows only the declared public subpaths', () => {
  for (const allowed of ALLOWED_PROTOCOL_SUBPATHS) {
    assert.equal(isAllowedProtocolImportSpecifier(allowed), true);
  }
  assert.equal(isAllowedProtocolImportSpecifier('@aoc/protocol/src'), false);
  assert.equal(isAllowedProtocolImportSpecifier('@aoc/protocol/src/contracts'), false);
  assert.equal(isAllowedProtocolImportSpecifier('@aoc/protocol/dist'), false);
  assert.equal(isAllowedProtocolImportSpecifier('@aoc/protocol/dist/contracts/index'), false);
  assert.equal(isAllowedProtocolImportSpecifier('@aoc/protocol/internal'), false);
});

test('an internal-dependency subpath is never an allowed source import', () => {
  assert.deepEqual([...INTERNAL_DEPENDENCY_PROTOCOL_SUBPATHS], ['@aoc/protocol/canonical']);
  for (const internal of INTERNAL_DEPENDENCY_PROTOCOL_SUBPATHS) {
    assert.equal(ALLOWED_PROTOCOL_SUBPATHS.includes(internal), false);
    assert.equal(isAllowedProtocolImportSpecifier(internal), false);
  }
});

test('extractProtocolImportSpecifiers finds a forbidden /src deep import', () => {
  const source = `import type { CapabilityToken } from '@aoc/protocol/src/contracts';\n`;
  const specifiers = extractProtocolImportSpecifiers(source);
  assert.deepEqual(specifiers, ['@aoc/protocol/src/contracts']);
  assert.equal(isAllowedProtocolImportSpecifier(specifiers[0]), false);
});

test('extractProtocolImportSpecifiers finds a forbidden /dist deep import', () => {
  const source = `import type { CapabilityToken } from '@aoc/protocol/dist/contracts/index.js';\n`;
  const specifiers = extractProtocolImportSpecifiers(source);
  assert.deepEqual(specifiers, ['@aoc/protocol/dist/contracts/index.js']);
  assert.equal(isAllowedProtocolImportSpecifier(specifiers[0]), false);
});

test('containsProtocolSiblingPath detects a relative path into the Protocol repository', () => {
  assert.equal(containsProtocolSiblingPath(`import x from '../Architects_of_Change_Protocol/packages/protocol';`), true);
  assert.equal(containsProtocolSiblingPath(`import x from '../../Architects_of_Change_Protocol/packages/protocol';`), true);
  assert.equal(containsProtocolSiblingPath(`import x from '@aoc/protocol';`), false);
});

test('declaresProtocolModule detects an ambient module declaration for @aoc/protocol', () => {
  assert.equal(declaresProtocolModule(`declare module '@aoc/protocol' { export type X = string; }`), true);
  assert.equal(declaresProtocolModule(`declare module '@aoc/protocol/contracts' { export type X = string; }`), true);
  assert.equal(declaresProtocolModule(`import type { CapabilityToken } from '@aoc/protocol';`), false);
});

// --- validateCompatibilityLock (protocol-consumer.lock.json shape) -----------

test('validateCompatibilityLock accepts a well-formed lock', () => {
  const { valid, errors } = validateCompatibilityLock(validLock());
  assert.equal(valid, true, errors.join('; '));
});

test('validateCompatibilityLock rejects a non-object', () => {
  assert.equal(validateCompatibilityLock(null).valid, false);
  assert.equal(validateCompatibilityLock('not-json').valid, false);
  assert.equal(validateCompatibilityLock([]).valid, false);
});

test('validateCompatibilityLock rejects a missing required field', () => {
  const lock = validLock();
  delete lock.commit;
  const { valid, errors } = validateCompatibilityLock(lock);
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.includes('commit')));
});

test('validateCompatibilityLock rejects an abbreviated/invalid commit SHA', () => {
  const { valid, errors } = validateCompatibilityLock(validLock({ commit: '7049fad' }));
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.includes('full 40-character commit SHA')));
});

test('validateCompatibilityLock rejects a repository that is not the Protocol repo', () => {
  const { valid, errors } = validateCompatibilityLock(validLock({ repository: 'someone/else' }));
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.includes('repository')));
});

test('validateCompatibilityLock rejects a package name other than @aoc/protocol', () => {
  const { valid, errors } = validateCompatibilityLock(validLock({ package: '@evil/protocol' }));
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.includes('package')));
});

test('validateCompatibilityLock rejects a malformed tarball checksum', () => {
  const { valid, errors } = validateCompatibilityLock(validLock({ tarball: { filename: 'x.tgz', sha256: 'not-a-checksum' } }));
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.includes('sha256')));
});

test('validateCompatibilityLock rejects an empty verifiedPublicExports list', () => {
  const { valid, errors } = validateCompatibilityLock(validLock({ verifiedPublicExports: [] }));
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.includes('verifiedPublicExports')));
});

test('validateCompatibilityLock accepts the approved internal-dependency subpath', () => {
  const { valid, errors } = validateCompatibilityLock(validLock({ internalDependencySubpaths: ['@aoc/protocol/canonical'] }));
  assert.equal(valid, true, errors.join('\n'));
});

test('validateCompatibilityLock rejects any other internal-dependency subpath', () => {
  for (const subpath of ['@aoc/protocol/manifest', '@aoc/protocol/identity', '@aoc/protocol/dist/canonical', '@aoc/protocol']) {
    const { valid, errors } = validateCompatibilityLock(validLock({ internalDependencySubpaths: ['@aoc/protocol/canonical', subpath] }));
    assert.equal(valid, false, subpath);
    assert.ok(errors.some((e) => e.includes(subpath)));
  }
});

test('validateCompatibilityLock rejects a non-array internalDependencySubpaths', () => {
  const { valid, errors } = validateCompatibilityLock(validLock({ internalDependencySubpaths: '@aoc/protocol/canonical' }));
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.includes('internalDependencySubpaths')));
});

test('validateCompatibilityLock rejects an internal dependency that is also listed as a public export', () => {
  const { valid, errors } = validateCompatibilityLock(
    validLock({ verifiedPublicExports: ['@aoc/protocol', '@aoc/protocol/canonical'], internalDependencySubpaths: ['@aoc/protocol/canonical'] }),
  );
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.includes('must not also be listed')));
});

// --- verifyArtifactAgainstLock (the tarball vs. the lock) --------------------

test('verifyArtifactAgainstLock accepts a matching artifact', () => {
  const { valid, errors } = verifyArtifactAgainstLock(validArtifact(), validLock());
  assert.equal(valid, true, errors.join('; '));
});

test('verifyArtifactAgainstLock rejects a checksum mismatch', () => {
  const { valid, errors } = verifyArtifactAgainstLock(validArtifact({ sha256: 'b'.repeat(64) }), validLock());
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.includes('SHA-256')));
});

test('verifyArtifactAgainstLock rejects a commit mismatch', () => {
  const { valid, errors } = verifyArtifactAgainstLock(validArtifact({ commit: OTHER_SHA }), validLock());
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.includes('commit')));
});

test('verifyArtifactAgainstLock rejects a package name mismatch', () => {
  const { valid, errors } = verifyArtifactAgainstLock(validArtifact({ package: '@evil/protocol' }), validLock());
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.includes('package')));
});

test('verifyArtifactAgainstLock rejects a version mismatch', () => {
  const { valid, errors } = verifyArtifactAgainstLock(validArtifact({ version: '9.9.9' }), validLock());
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.includes('version')));
});

test('verifyArtifactAgainstLock rejects a missing artifact', () => {
  const { valid, errors } = verifyArtifactAgainstLock(null, validLock());
  assert.equal(valid, false);
  assert.ok(errors.length > 0);
});
