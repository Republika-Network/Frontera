// AUTH-04D1 — the sealed container of the Authority pilot backup profile
// (scripts/portability/lib-sealed-backup.mjs), adversarially.
//
// Pure file-level contract: no Host, no build. The Host-level CORE-07 restore
// drills are src/enterprise/__tests__/auth04d1-authority-recovery-host.test.ts.

import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createCipheriv, createHash, randomBytes } from 'node:crypto';

import {
  BACKUP_ARCHIVE_FORMAT,
  SEALED_BACKUP_FORMAT,
  SealedBackupError,
  backupKeyId,
  canonicalJson,
  generateBackupKey,
  readBackupKey,
  readSealedHeader,
  sealBackupSet,
  unsealBackupSet,
} from '../scripts/portability/lib-sealed-backup.mjs';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const roots = [];
test.after(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});
const scratch = () => {
  const dir = mkdtempSync(join(tmpdir(), 'frontera-auth04d1-sealed-'));
  roots.push(dir);
  return dir;
};

/** A plausible backup:v1 set: a manifest, checksums, metadata and two "stores" carrying recognizable sensitive markers. */
const PASSKEY_MARKER = 'passkey-public-key-MARKER-2f9c41d07ab3';
const SUBJECT_MARKER = 'approval-subject-MARKER-8e11c5a2b6f0';
function backupSet() {
  const dir = join(scratch(), 'set');
  mkdirSync(join(dir, 'stores'), { recursive: true });
  mkdirSync(join(dir, 'metadata'));
  writeFileSync(join(dir, 'backup-manifest.json'), JSON.stringify({ backupId: 'backup-test', marker: SUBJECT_MARKER }));
  writeFileSync(join(dir, 'checksums.sha256'), 'abc  stores/human-identity.sqlite\n');
  writeFileSync(join(dir, 'RESTORE.md'), '# Restore\n');
  writeFileSync(join(dir, 'metadata', 'store-versions.json'), '{}');
  writeFileSync(join(dir, 'stores', 'human-identity.sqlite'), Buffer.concat([randomBytes(4096), Buffer.from(PASSKEY_MARKER), randomBytes(512)]));
  writeFileSync(join(dir, 'stores', 'approvals.sqlite'), Buffer.concat([randomBytes(2048), Buffer.from(SUBJECT_MARKER)]));
  return dir;
}

function keyFile(dir = scratch()) {
  const path = join(dir, 'backup.key');
  generateBackupKey(path);
  return path;
}

const HEADER = Object.freeze({ backupId: 'backup-test', organizationId: 'org-pilot', authorityStores: [{ name: 'human-identity', storeId: 'human-identity-store:1', sequence: 7, stateDigest: `sha256:${'a'.repeat(64)}` }] });

function sealed() {
  const set = backupSet();
  const key = readBackupKey(keyFile());
  const outputFile = join(scratch(), 'pilot.sealed');
  const result = sealBackupSet({ sourceDir: set, outputFile, key, header: HEADER });
  return { set, key, outputFile, result };
}

const filesOf = (dir) => readdirSync(dir, { recursive: true }).filter((entry) => statSync(join(dir, entry)).isFile()).sort();
const refused = (fn, pattern) => assert.throws(fn, (error) => error instanceof SealedBackupError && pattern.test(error.message));

test('a sealed backup round-trips byte for byte, and its header is public, canonical and bound to the key', () => {
  const { set, key, outputFile, result } = sealed();
  assert.equal(result.header.format, SEALED_BACKUP_FORMAT);
  assert.equal(result.header.archiveFormat, BACKUP_ARCHIVE_FORMAT);
  assert.equal(result.header.cipher, 'aes-256-gcm');
  assert.equal(result.header.keyId, backupKeyId(key));
  if (process.platform !== 'win32') assert.equal(statSync(outputFile).mode & 0o777, 0o600, 'owner-only');
  const { header } = readSealedHeader(readFileSync(outputFile));
  assert.deepEqual(header, JSON.parse(canonicalJson(result.header)));
  assert.equal(header.organizationId, 'org-pilot');
  const out = join(scratch(), 'out');
  const unsealed = unsealBackupSet({ sealedFile: outputFile, key, outputDir: out });
  assert.deepEqual(filesOf(out), filesOf(set));
  for (const file of filesOf(set)) assert.ok(readFileSync(join(out, file)).equals(readFileSync(join(set, file))), file);
  assert.equal(unsealed.files.length, filesOf(set).length);
});

test('confidentiality: no byte of a store, the manifest or the key appears in the sealed file', () => {
  const { outputFile, key } = sealed();
  const bytes = readFileSync(outputFile);
  for (const marker of [PASSKEY_MARKER, SUBJECT_MARKER, key.toString('hex'), key.toString('base64')]) assert.equal(bytes.includes(Buffer.from(marker)), false, marker.slice(0, 16));
  assert.equal(bytes.includes(key), false);
});

test('a wrong key is refused before decryption, and a forged key id over another key does not authenticate', () => {
  const { outputFile } = sealed();
  const other = readBackupKey(keyFile());
  refused(() => unsealBackupSet({ sealedFile: outputFile, key: other, outputDir: join(scratch(), 'x') }), /sealed with key 'fbk1-[0-9a-f]{32}', not with the key supplied/);
  // An attacker rewrites the header's key id to match their key: the header is authenticated data, so the tag fails.
  const bytes = readFileSync(outputFile);
  const forged = Buffer.from(bytes.toString('latin1').replace(/fbk1-[0-9a-f]{32}/, backupKeyId(other)), 'latin1');
  const forgedFile = join(scratch(), 'forged.sealed');
  writeFileSync(forgedFile, forged);
  const out = join(scratch(), 'x');
  refused(() => unsealBackupSet({ sealedFile: forgedFile, key: other, outputDir: out }), /does not authenticate/);
  assert.equal(existsSync(out), false, 'nothing was unpacked');
});

test('truncation, a flipped byte anywhere, an altered header and appended bytes are all refused with nothing unpacked', () => {
  const { outputFile, key } = sealed();
  const bytes = readFileSync(outputFile);
  const { headerEnd } = readSealedHeader(bytes);
  const variants = {
    'truncated by one byte': bytes.subarray(0, bytes.length - 1),
    'truncated to the header': bytes.subarray(0, headerEnd + 4),
    'empty': Buffer.alloc(0),
    'appended byte': Buffer.concat([bytes, Buffer.from([0])]),
  };
  for (const offset of [0, 30, headerEnd - 2, headerEnd + 3, headerEnd + 20, headerEnd + 40, bytes.length - 1]) {
    const flipped = Buffer.from(bytes);
    flipped[offset] ^= 0x01;
    variants[`flipped byte at ${offset}`] = flipped;
  }
  // The organization in the header, rewritten to another of the same length.
  variants['organization rewritten'] = Buffer.from(bytes.toString('latin1').replace('"org-pilot"', '"org-other"'), 'latin1');
  for (const [name, variant] of Object.entries(variants)) {
    const file = join(scratch(), 'variant.sealed');
    writeFileSync(file, variant);
    const out = join(scratch(), 'out');
    assert.throws(() => unsealBackupSet({ sealedFile: file, key, outputDir: out }), SealedBackupError, name);
    assert.equal(existsSync(out), false, `${name}: nothing was unpacked`);
  }
});

test('a non-canonical or unsupported header is refused even when the rest is intact', () => {
  const { outputFile } = sealed();
  const bytes = readFileSync(outputFile);
  const magicLength = bytes.indexOf(0x0a) + 1;
  const length = bytes.readUInt32BE(magicLength);
  const header = bytes.subarray(magicLength + 4, magicLength + 4 + length).toString('utf8');
  const rebuild = (text) => {
    const headerBytes = Buffer.from(text, 'utf8');
    const prefix = Buffer.alloc(4);
    prefix.writeUInt32BE(headerBytes.length);
    return Buffer.concat([bytes.subarray(0, magicLength), prefix, headerBytes, bytes.subarray(magicLength + 4 + length)]);
  };
  refused(() => readSealedHeader(rebuild(` ${header}`)), /canonical form/);
  refused(() => readSealedHeader(rebuild(header.replace(SEALED_BACKUP_FORMAT, 'frontera.authority-pilot.sealed-backup.v2'))), /Unsupported sealed backup/);
  refused(() => readSealedHeader(rebuild(header.replace('"aes-256-gcm"', '"aes-128-gcm"'))), /Unsupported sealed backup/);
  refused(() => readSealedHeader(Buffer.from('PK\u0003\u0004 not a sealed backup')), /Not a frontera\.authority-pilot\.sealed-backup\.v1 file/);
});

test('the key file: owner-only, exactly 256 bits of hex, never a link, never overwritten', () => {
  const dir = scratch();
  const path = keyFile(dir);
  assert.match(readFileSync(path, 'utf8'), /^[0-9a-f]{64}\n$/);
  refused(() => generateBackupKey(path), /never overwritten/);
  if (process.platform !== 'win32') {
    assert.equal(statSync(path).mode & 0o777, 0o600);
    chmodSync(path, 0o644);
    refused(() => readBackupKey(path), /owner only/);
    chmodSync(path, 0o600);
    const link = join(dir, 'link.key');
    symlinkSync(path, link);
    refused(() => readBackupKey(link), /regular file/);
  }
  for (const content of ['', 'abc', 'Z'.repeat(64), `${'a'.repeat(63)}`, `${'A'.repeat(64)}`, randomBytes(32).toString('base64')]) {
    const bad = join(dir, `bad-${randomBytes(4).toString('hex')}.key`);
    writeFileSync(bad, content, { mode: 0o600 });
    refused(() => readBackupKey(bad), /64 lowercase hexadecimal/);
  }
  refused(() => readBackupKey(join(dir, 'absent.key')), /does not exist/);
  // Errors never quote the key.
  const secret = readFileSync(path, 'utf8').trim();
  try {
    unsealBackupSet({ sealedFile: join(dir, 'absent'), key: Buffer.from(secret, 'hex'), outputDir: join(dir, 'o') });
  } catch (error) {
    assert.equal(String(error.message).includes(secret), false);
  }
});

test('sealing refuses a link or special file in the set, never replaces an existing file, and leaves nothing behind on refusal', () => {
  const key = readBackupKey(keyFile());
  const set = backupSet();
  const outputFile = join(scratch(), 'pilot.sealed');
  writeFileSync(outputFile, 'existing');
  refused(() => sealBackupSet({ sourceDir: set, outputFile, key, header: HEADER }), /never replaces/);
  assert.equal(readFileSync(outputFile, 'utf8'), 'existing');
  if (process.platform !== 'win32') {
    symlinkSync('/etc/hostname', join(set, 'stores', 'planted.sqlite'));
    const target = join(scratch(), 'linked.sealed');
    refused(() => sealBackupSet({ sourceDir: set, outputFile: target, key, header: HEADER }), /neither a regular file nor a directory/);
    assert.equal(existsSync(target), false);
  }
  const empty = join(scratch(), 'empty-set');
  mkdirSync(empty);
  const emptyTarget = join(scratch(), 'empty.sealed');
  refused(() => sealBackupSet({ sourceDir: empty, outputFile: emptyTarget, key, header: HEADER }), /empty/);
  assert.equal(existsSync(emptyTarget), false);
});

test('an authenticated archive that names an escaping, duplicate or mismatched entry is still refused (defence in depth against a compromised key holder)', () => {
  // Build sealed files directly, as a key holder could.
  const key = randomBytes(32);
  const seal = (archive) => {
    const plaintext = Buffer.from(canonicalJson(archive), 'utf8');
    const header = { ...HEADER, format: SEALED_BACKUP_FORMAT, cipher: 'aes-256-gcm', keyId: backupKeyId(key), archiveFormat: BACKUP_ARCHIVE_FORMAT, archivedBytes: plaintext.length };
    const headerBytes = Buffer.from(canonicalJson(header), 'utf8');
    const length = Buffer.alloc(4);
    length.writeUInt32BE(headerBytes.length);
    const aad = Buffer.concat([Buffer.from('FRONTERA-SEALED-BACKUP/1\n', 'ascii'), length, headerBytes]);
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
    cipher.setAAD(aad);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const file = join(scratch(), 'crafted.sealed');
    writeFileSync(file, Buffer.concat([aad, iv, cipher.getAuthTag(), ciphertext]));
    return file;
  };
  const entry = (path, data = 'x', overrides = {}) => {
    const bytes = Buffer.from(data);
    return { path, sizeBytes: bytes.length, sha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}`, data: bytes.toString('base64'), ...overrides };
  };
  const cases = {
    'a parent-directory escape': [entry('../escaped.sqlite')],
    'an absolute path': [entry('/etc/escaped')],
    'a dot segment': [entry('stores/../x')],
    'a hidden file': [entry('.hidden')],
    'a duplicate path': [entry('stores/a.sqlite'), entry('stores/a.sqlite')],
    'a size mismatch': [entry('stores/a.sqlite', 'abc', { sizeBytes: 4 })],
    'a digest mismatch': [entry('stores/a.sqlite', 'abc', { sha256: `sha256:${'0'.repeat(64)}` })],
  };
  for (const [name, files] of Object.entries(cases)) {
    const out = join(scratch(), 'out');
    refused(() => unsealBackupSet({ sealedFile: seal({ format: BACKUP_ARCHIVE_FORMAT, files }), key, outputDir: out }), /./);
    assert.equal(existsSync(out), false, `${name}: nothing was unpacked`);
    assert.equal(existsSync(join(out, '..', 'escaped.sqlite')), false, name);
  }
  refused(() => unsealBackupSet({ sealedFile: seal({ format: 'something-else', files: [entry('a')] }), key, outputDir: join(scratch(), 'o') }), /is not 'frontera\.authority-pilot\.backup-archive\.v1'/);
});

test('the profile seals only through this library and never names the witness, a key value or a store file of its own', () => {
  const profile = readFileSync(join(ROOT, 'scripts/portability/authority-pilot-backup.mjs'), 'utf8');
  assert.match(profile, /await runBackup\(\{ output: set, cold: true, env \}\)/, 'backup:v1, cold, nothing missing allowed');
  assert.equal(/allowMissingStores|allowIncomplete|allowLegacyBackup|noTargetCheck/.test(profile), false, 'no incomplete, legacy or unchecked path');
  assert.equal(/FRONTERA_REFERENCE_WITNESS|witness_bindings|enroll[A-Z]|genesisStoreId|AuthorityStateFreshness|freshness\.boundary/.test(profile), false, 'the witness is never contacted, read, reset or enrolled');
  assert.equal(/createCipheriv|createDecipheriv/.test(profile), false, 'one sealing implementation');
  assert.equal(/console\.(log|error)\([^)]*key(?!File|Id|-file)/i.test(profile), false, 'no key material is printed');
  assert.match(profile, /rmSync\(work, \{ recursive: true, force: true \}\)/, 'plaintext is removed on every path');
});
