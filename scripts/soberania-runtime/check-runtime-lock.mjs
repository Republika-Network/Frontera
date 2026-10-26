#!/usr/bin/env node
// Validates soberania-runtime-consumer.lock.json and the vendored Soberanía runtime artifacts it
// pins (FRONTERA-SOBE-PILOT-01A): lock shape and policy, every vendored tarball's bytes and file
// inventory, no unlisted artifact in the vendor directory, and no Frontera source importing the
// runtime yet. Reads only; installs and writes nothing.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { RUNTIME_VENDOR_DIR, findRuntimeImports, tarballIdentityErrors, validateRuntimeLock } from './lib-runtime-artifacts.mjs';

const root = process.cwd();
const failures = [];

const lock = JSON.parse(readFileSync(resolve(root, 'soberania-runtime-consumer.lock.json'), 'utf8'));
failures.push(...validateRuntimeLock(lock));

if (Array.isArray(lock.packages)) {
  for (const entry of lock.packages) {
    for (const error of tarballIdentityErrors(resolve(root, entry.tarball.vendoredAt), entry)) failures.push(`${entry.name}: ${error}`);
  }
  const listed = new Set(lock.packages.map((entry) => entry.tarball.filename));
  for (const file of readdirSync(resolve(root, RUNTIME_VENDOR_DIR))) {
    if (file.endsWith('.tgz') && !listed.has(file)) failures.push(`${RUNTIME_VENDOR_DIR}/${file} is not pinned by the lock.`);
  }
}

const SOURCE_ROOTS = ['src', 'packages', 'apps', 'types'];
const SOURCE_EXT = /\.(ts|mts|cts|tsx|js|mjs|cjs)$/;
function walk(dir) {
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names.flatMap((name) => {
    if (name === 'node_modules' || name === 'dist' || name.startsWith('.')) return [];
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : SOURCE_EXT.test(name) ? [full] : [];
  });
}
for (const sourceRoot of SOURCE_ROOTS) {
  for (const file of walk(resolve(root, sourceRoot))) {
    for (const specifier of findRuntimeImports(readFileSync(file, 'utf8'))) {
      failures.push(`${file.slice(root.length + 1)}: imports '${specifier}'; no Frontera source may consume the Soberanía runtime yet.`);
    }
  }
}

if (failures.length > 0) {
  console.error('Soberanía runtime lock check failed:');
  for (const failure of failures) console.error(` - ${failure}`);
  process.exit(1);
}
console.log(`Soberanía runtime lock check passed: ${lock.packages.length} artifacts from ${lock.sourceRepository}@${lock.sourceCommit}.`);
