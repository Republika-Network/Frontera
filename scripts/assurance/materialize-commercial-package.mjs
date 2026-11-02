#!/usr/bin/env node
// Materializes an exported commercial release package (ASSURE-OPS-01, R-05).
//
//   node scripts/assurance/materialize-commercial-package.mjs <export.json> --out <empty-or-absent-dir>
//
// <export.json> is the body of `GET /api/assurance/commercial-releases/{reportId}/package`
// (Enterprise Host SDK: `exportCommercialReleasePackage`). This script writes
// each file's exact bytes into <dir>, and nothing else:
//
// - only the six names of the closed delivery set are accepted; any other
//   name, a path separator, `..`, a duplicate or a missing file refuses the
//   whole package before anything is written (no traversal, no overwrite);
// - each file's base64 must be canonical and its bytes must match the size
//   and sha256 the Host declared; the total is bounded;
// - <dir> must not exist or must be empty; files are created exclusively.
//
// It contains no generator or verification code and authenticates nothing:
// it proves only that the files are the bytes the Host described. Verify the
// result with scripts/assurance/verify-commercial-package.mjs, and ask the
// issuer to verify it against its custody
// (docs/security/ASSURE-OPS-01-CUSTOMER-DELIVERY-HARDENING.md).
//
// Exit 0: written. Exit 1: refused (nothing written). Exit 2: usage.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const FILES = ['integrity-manifest.json', 'limitations.md', 'release-record.json', 'report.json', 'report.md', 'verification-instructions.md'];
const PACKAGE_VERSION = 'aoc.assurance.commercial-release-package.v1';
const MAX_BYTES = 4 * 1024 * 1024;
const MAX_INPUT_BYTES = 8 * MAX_BYTES;

function usage(message) {
  process.stderr.write(`${message}\nusage: materialize-commercial-package.mjs <export.json> --out <dir>\n`);
  process.exitCode = 2;
}

function refuse(reason) {
  process.stdout.write(`${JSON.stringify({ written: false, reason }, null, 2)}\n`);
  process.exitCode = 1;
}

const args = process.argv.slice(2);
const outIndex = args.indexOf('--out');
const input = args.find((arg, index) => !arg.startsWith('--') && (outIndex < 0 || index !== outIndex + 1));
const out = outIndex >= 0 ? args[outIndex + 1] : undefined;

if (input === undefined || out === undefined) {
  usage('An export file and --out are required.');
} else {
  materialize(resolve(input), resolve(out));
}

function materialize(inputPath, outDir) {
  let exported;
  try {
    if (statSync(inputPath).size > MAX_INPUT_BYTES) return refuse('The export file exceeds the input bound.');
    exported = JSON.parse(readFileSync(inputPath, 'utf8'));
  } catch {
    return refuse('The export file cannot be read as JSON.');
  }
  if (exported === null || typeof exported !== 'object' || exported.packageVersion !== PACKAGE_VERSION) return refuse(`Not a ${PACKAGE_VERSION} export.`);
  if (!Array.isArray(exported.files)) return refuse('The export has no file list.');
  const seen = new Set();
  const decoded = [];
  let total = 0;
  for (const entry of exported.files) {
    const path = entry?.path;
    if (typeof path !== 'string' || !FILES.includes(path)) return refuse('The export names a file outside the closed delivery set.');
    if (seen.has(path)) return refuse('The export names a file twice.');
    seen.add(path);
    const encoded = entry.contentBase64;
    if (typeof encoded !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) return refuse(`${path}: the content is not base64.`);
    const bytes = Buffer.from(encoded, 'base64');
    if (bytes.toString('base64') !== encoded) return refuse(`${path}: the content is not canonical base64.`);
    total += bytes.length;
    if (total > MAX_BYTES) return refuse('The package exceeds the delivery size bound.');
    const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    if (entry.size !== bytes.length || entry.sha256 !== digest) return refuse(`${path}: the bytes do not match their declared size and digest.`);
    decoded.push({ path, bytes, sha256: digest, binding: entry.binding });
  }
  for (const name of FILES) if (!seen.has(name)) return refuse(`The export is missing ${name}.`);
  if (existsSync(outDir) && readdirSync(outDir).length > 0) return refuse('The output directory is not empty; nothing was written.');
  mkdirSync(outDir, { recursive: true });
  for (const file of decoded.sort((a, b) => (a.path < b.path ? -1 : 1))) writeFileSync(join(outDir, file.path), file.bytes, { flag: 'wx' });
  process.stdout.write(
    `${JSON.stringify(
      {
        written: true,
        reportId: exported.reportId,
        packageDigest: exported.packageDigest,
        files: decoded.map(({ path, sha256, binding }) => ({ path, sha256, binding })),
        externalSignature: 'EXTERNAL_SIGNATURE_NOT_AVAILABLE',
        next: 'Run scripts/assurance/verify-commercial-package.mjs on the directory, and confirm the release with the issuer over an independent channel.',
      },
      null,
      2,
    )}\n`,
  );
}
