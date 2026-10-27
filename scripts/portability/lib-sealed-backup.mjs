// AUTH-04D1 — a sealed container for one backup:v1 set.
//
// backup:v1 writes plaintext files and leaves confidentiality to the operator
// ("store backups encrypted, access-controlled and off-host"). The Authority
// pilot backup carries the human identity store (passkey public keys, decision
// evidence) and CORE-05's approval subjects, so its profile seals the whole set
// into ONE authenticated, encrypted file before it leaves the Host machine.
//
// Format `frontera.authority-pilot.sealed-backup.v1`:
//
//   MAGIC | header length (uint32 BE) | header (canonical JSON) | IV (12) | tag (16) | ciphertext
//
// - AES-256-GCM with a 256-bit key the operator holds outside the backup
//   storage. The header is the GCM additional data: it is readable without the
//   key (organization, backup id, the signed heads — never a row, a passkey or
//   a secret) and cannot be altered without the key.
// - The plaintext is a deterministic archive of the backup:v1 directory: every
//   regular file, by relative path, with its size and SHA-256.
// - Fail closed: a truncated, altered or foreign file, a wrong key, a header
//   that is not exactly its canonical form, an archive path that escapes, a
//   duplicate path, a size or digest mismatch — each refuses with nothing
//   written outside a fresh private directory.
//
// Node's built-in crypto only; no dependency. Never logs or returns key bytes.

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { closeSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, writeFileSync, writeSync, fsyncSync, rmSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

export const SEALED_BACKUP_FORMAT = 'frontera.authority-pilot.sealed-backup.v1';
export const BACKUP_ARCHIVE_FORMAT = 'frontera.authority-pilot.backup-archive.v1';
const CIPHER = 'aes-256-gcm';
const MAGIC = Buffer.from('FRONTERA-SEALED-BACKUP/1\n', 'ascii');
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const MAX_HEADER_BYTES = 64 * 1024;
/** Pilot bound on the plaintext backup set. A larger set is refused, never truncated. */
export const MAX_ARCHIVED_BYTES = 128 * 1024 * 1024;
const MAX_SEALED_BYTES = MAGIC.length + 4 + MAX_HEADER_BYTES + IV_BYTES + TAG_BYTES + Math.ceil((MAX_ARCHIVED_BYTES * 4) / 3) + 1024 * 1024;
const ARCHIVE_PATH = /^[A-Za-z0-9_-][A-Za-z0-9._-]*(\/[A-Za-z0-9_-][A-Za-z0-9._-]*)*$/;

export class SealedBackupError extends Error {}

/** Recursively sorted keys, no whitespace: the one serialization of a header. */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .filter((key) => value[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }
  if (typeof value === 'number' && !Number.isFinite(value)) throw new SealedBackupError('A sealed-backup header holds only finite numbers.');
  return JSON.stringify(value);
}

const sha256 = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

// -- the key ------------------------------------------------------------------------

/** A key id that names the key without revealing anything usable about it. */
export function backupKeyId(key) {
  return `fbk1-${createHash('sha256').update('frontera.authority-pilot.backup-key-id.v1\0').update(key).digest('hex').slice(0, 32)}`;
}

/**
 * Reads the backup key: a regular file (never a link) readable by its owner
 * only, holding exactly 64 hexadecimal characters. Errors never quote it.
 */
export function readBackupKey(path) {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    throw new SealedBackupError('The backup key file does not exist or cannot be read.');
  }
  if (!stat.isFile()) throw new SealedBackupError('The backup key file must be a regular file, never a link or a directory.');
  if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) throw new SealedBackupError('The backup key file must be readable by its owner only (chmod 600).');
  const text = readFileSync(path, 'utf8').trim();
  if (!/^[0-9a-f]{64}$/.test(text)) throw new SealedBackupError('The backup key file must hold exactly 64 lowercase hexadecimal characters (256 bits).');
  return Buffer.from(text, 'hex');
}

/** Writes a new random key, owner-only, refusing to replace any existing file. */
export function generateBackupKey(path) {
  const key = randomBytes(KEY_BYTES);
  try {
    writeFileSync(path, `${key.toString('hex')}\n`, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    throw new SealedBackupError(error?.code === 'EEXIST' ? 'A file already exists at the key path; a key is never overwritten.' : 'The backup key file could not be created.');
  }
  return { keyId: backupKeyId(key) };
}

// -- the archive ----------------------------------------------------------------------

/** Every regular file under `dir`, by relative POSIX path. A link or special file anywhere refuses. */
function collectFiles(dir) {
  const files = [];
  const walk = (current) => {
    for (const name of readdirSync(current).sort()) {
      const path = join(current, name);
      const stat = lstatSync(path);
      if (stat.isDirectory()) walk(path);
      else if (stat.isFile()) files.push({ path, archivePath: relative(dir, path).split(sep).join('/') });
      else throw new SealedBackupError(`The backup set holds '${relative(dir, path)}', which is neither a regular file nor a directory; refusing to seal it.`);
    }
  };
  walk(dir);
  return files;
}

function packDirectory(dir) {
  const files = collectFiles(dir);
  let total = 0;
  const entries = files.map(({ path, archivePath }) => {
    if (!ARCHIVE_PATH.test(archivePath)) throw new SealedBackupError(`The backup set holds a file with an unsupported name ('${archivePath}').`);
    const bytes = readFileSync(path);
    total += bytes.length;
    if (total > MAX_ARCHIVED_BYTES) throw new SealedBackupError(`The backup set exceeds the pilot bound of ${MAX_ARCHIVED_BYTES} bytes; refusing to seal a partial set.`);
    return { path: archivePath, sizeBytes: bytes.length, sha256: sha256(bytes), data: bytes.toString('base64') };
  });
  if (entries.length === 0) throw new SealedBackupError('The backup set is empty.');
  return Buffer.from(canonicalJson({ format: BACKUP_ARCHIVE_FORMAT, files: entries }), 'utf8');
}

/** Writes the archive's files into `dir`, which must be a fresh, empty directory. Every entry is checked before anything is written. */
function unpackArchive(plaintext, dir) {
  let archive;
  try {
    archive = JSON.parse(plaintext.toString('utf8'));
  } catch {
    throw new SealedBackupError('The sealed backup does not hold a readable archive.');
  }
  if (archive === null || typeof archive !== 'object' || archive.format !== BACKUP_ARCHIVE_FORMAT || !Array.isArray(archive.files) || archive.files.length === 0) {
    throw new SealedBackupError(`The sealed backup's archive is not '${BACKUP_ARCHIVE_FORMAT}'.`);
  }
  const seen = new Set();
  const decoded = archive.files.map((entry) => {
    if (entry === null || typeof entry !== 'object' || typeof entry.path !== 'string' || !ARCHIVE_PATH.test(entry.path) || entry.path.split('/').some((part) => part === '.' || part === '..')) {
      throw new SealedBackupError('The archive names a file outside the backup set; refusing to unpack it.');
    }
    if (seen.has(entry.path)) throw new SealedBackupError(`The archive names '${entry.path}' twice.`);
    seen.add(entry.path);
    if (typeof entry.data !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(entry.data)) throw new SealedBackupError(`The archive entry '${entry.path}' is not base64.`);
    const bytes = Buffer.from(entry.data, 'base64');
    if (bytes.length !== entry.sizeBytes || sha256(bytes) !== entry.sha256) throw new SealedBackupError(`The archive entry '${entry.path}' does not match its recorded size and digest.`);
    return { path: entry.path, bytes };
  });
  for (const { path, bytes } of decoded) {
    const parts = path.split('/');
    if (parts.length > 1) mkdirSync(join(dir, ...parts.slice(0, -1)), { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, ...parts), bytes, { flag: 'wx', mode: 0o600 });
  }
  return decoded.map(({ path, bytes }) => ({ path, sizeBytes: bytes.length }));
}

// -- sealing --------------------------------------------------------------------------

/**
 * Seals the backup set in `sourceDir` into `outputFile` (created exclusively,
 * owner-only). `header` is public metadata, bound as GCM additional data.
 */
export function sealBackupSet({ sourceDir, outputFile, key, header }) {
  if (!Buffer.isBuffer(key) || key.length !== KEY_BYTES) throw new SealedBackupError('A backup key is 32 bytes.');
  const plaintext = packDirectory(sourceDir);
  const fullHeader = { ...header, format: SEALED_BACKUP_FORMAT, cipher: CIPHER, keyId: backupKeyId(key), archiveFormat: BACKUP_ARCHIVE_FORMAT, archivedBytes: plaintext.length };
  const headerBytes = Buffer.from(canonicalJson(fullHeader), 'utf8');
  if (headerBytes.length > MAX_HEADER_BYTES) throw new SealedBackupError('The sealed-backup header is too large.');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(headerBytes.length, 0);
  const aad = Buffer.concat([MAGIC, length, headerBytes]);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(CIPHER, key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  plaintext.fill(0);
  let fd;
  try {
    fd = openSync(outputFile, 'wx', 0o600);
  } catch (error) {
    throw new SealedBackupError(error?.code === 'EEXIST' ? `A file already exists at '${outputFile}'; a sealed backup never replaces one.` : `The sealed backup could not be created at '${outputFile}'.`);
  }
  try {
    for (const part of [aad, iv, tag, ciphertext]) writeSync(fd, part);
    fsyncSync(fd);
  } catch (error) {
    closeSync(fd);
    rmSync(outputFile, { force: true });
    throw error;
  }
  closeSync(fd);
  return { header: fullHeader, sealedBytes: aad.length + iv.length + tag.length + ciphertext.length, sha256: sha256(readFileSync(outputFile)) };
}

/** Reads and checks the header without the key. Throws on anything but a well-formed v1 container. */
export function readSealedHeader(bytes) {
  if (bytes.length < MAGIC.length + 4 || !bytes.subarray(0, MAGIC.length).equals(MAGIC)) throw new SealedBackupError(`Not a ${SEALED_BACKUP_FORMAT} file.`);
  const headerLength = bytes.readUInt32BE(MAGIC.length);
  if (headerLength === 0 || headerLength > MAX_HEADER_BYTES) throw new SealedBackupError('The sealed-backup header length is invalid.');
  const headerEnd = MAGIC.length + 4 + headerLength;
  if (bytes.length < headerEnd + IV_BYTES + TAG_BYTES + 1) throw new SealedBackupError('The sealed backup is truncated.');
  const headerBytes = bytes.subarray(MAGIC.length + 4, headerEnd);
  let header;
  try {
    header = JSON.parse(headerBytes.toString('utf8'));
  } catch {
    throw new SealedBackupError('The sealed-backup header is not JSON.');
  }
  if (header === null || typeof header !== 'object' || Array.isArray(header) || canonicalJson(header) !== headerBytes.toString('utf8')) {
    throw new SealedBackupError('The sealed-backup header is not in its one canonical form.');
  }
  if (header.format !== SEALED_BACKUP_FORMAT || header.cipher !== CIPHER || header.archiveFormat !== BACKUP_ARCHIVE_FORMAT) throw new SealedBackupError(`Unsupported sealed backup: this build reads only '${SEALED_BACKUP_FORMAT}' (${CIPHER}).`);
  return { header, headerEnd };
}

/**
 * Opens a sealed backup into `outputDir` (a fresh directory this function
 * creates owner-only). Authenticates header and content with the key before a
 * single byte is written.
 */
export function unsealBackupSet({ sealedFile, key, outputDir }) {
  let fd;
  try {
    fd = openSync(sealedFile, 'r');
  } catch {
    throw new SealedBackupError('The sealed backup cannot be read.');
  }
  let bytes;
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new SealedBackupError('A sealed backup is a regular file.');
    if (stat.size > MAX_SEALED_BYTES) throw new SealedBackupError('The sealed backup exceeds the pilot bound.');
    bytes = readFileSync(fd);
  } finally {
    closeSync(fd);
  }
  const { header, headerEnd } = readSealedHeader(bytes);
  if (header.keyId !== backupKeyId(key)) throw new SealedBackupError(`This backup was sealed with key '${header.keyId}', not with the key supplied.`);
  const aad = bytes.subarray(0, headerEnd);
  const iv = bytes.subarray(headerEnd, headerEnd + IV_BYTES);
  const tag = bytes.subarray(headerEnd + IV_BYTES, headerEnd + IV_BYTES + TAG_BYTES);
  const ciphertext = bytes.subarray(headerEnd + IV_BYTES + TAG_BYTES);
  let plaintext;
  try {
    const decipher = createDecipheriv(CIPHER, key, iv, { authTagLength: TAG_BYTES });
    decipher.setAAD(aad);
    decipher.setAuthTag(tag);
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new SealedBackupError('The sealed backup does not authenticate: it is truncated, altered, or was not sealed with this key. Nothing was unpacked.');
  }
  if (plaintext.length !== header.archivedBytes) throw new SealedBackupError('The sealed backup does not hold the archive its header describes.');
  mkdirSync(outputDir, { mode: 0o700 });
  try {
    const files = unpackArchive(plaintext, outputDir);
    return { header, files };
  } catch (error) {
    rmSync(outputDir, { recursive: true, force: true });
    throw error;
  } finally {
    plaintext.fill(0);
  }
}
