#!/usr/bin/env node
// Validates soberania-runtime-consumer.lock.json and the vendored Soberanía runtime artifacts it
// pins (FRONTERA-SOBE-PILOT-01A): lock shape and policy, every vendored tarball's bytes and file
// inventory, no unlisted artifact in the vendor directory, and no Frontera source importing the
// runtime yet. Since FRONTERA-SOBE-PILOT-01C0 it also checks the installation: only the closure
// workspace declares the runtime, and package-lock.json installs exactly the locked artifacts as
// production dependencies. Reads only; installs and writes nothing.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

import {
  CLOSURE_WORKSPACE_DIR,
  RUNTIME_VENDOR_DIR,
  closureManifestErrors,
  findRuntimeImports,
  foreignManifestErrors,
  installedGraphErrors,
  tarballIdentityErrors,
  validateRuntimeLock,
} from './lib-runtime-artifacts.mjs';

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

const readJson = (path) => JSON.parse(readFileSync(resolve(root, path), 'utf8'));
const rootPkg = readJson('package.json');
failures.push(...foreignManifestErrors(rootPkg, 'package.json'));
for (const workspaceRoot of ['packages', 'apps']) {
  for (const name of readdirSync(resolve(root, workspaceRoot))) {
    const manifest = `${workspaceRoot}/${name}/package.json`;
    let pkg;
    try {
      pkg = readJson(manifest);
    } catch {
      continue;
    }
    if (`${workspaceRoot}/${name}` === CLOSURE_WORKSPACE_DIR) failures.push(...closureManifestErrors(pkg, lock, rootPkg, root).map((error) => `${manifest}: ${error}`));
    else failures.push(...foreignManifestErrors(pkg, manifest));
  }
}
failures.push(...installedGraphErrors(readJson('package-lock.json'), lock).map((error) => `package-lock.json: ${error}`));

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
