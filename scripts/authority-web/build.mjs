// AUTH-04C — reproducible build of the Frontera Authority web client.
//
// Compiles src/authority-web/*.ts to browser ES modules with the repository's
// own TypeScript (apps/authority-web/tsconfig.json), copies the static shell
// (index.html, styles.css, security-headers.json) and writes an asset manifest
// of SHA-256 digests. No bundler, no network, no new dependency. The output is
// a static directory meant to be served by the Authority origin's ingress,
// with /authority/v1/* routed to the Host's Authority gateway (same origin).
//
// Usage: node scripts/authority-web/build.mjs [--out <dir>]   (default apps/authority-web/dist)

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const APP = join(ROOT, 'apps', 'authority-web');
const STATIC_FILES = ['index.html', 'styles.css', 'security-headers.json'];

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

export async function buildAuthorityWeb(options = {}) {
  const outDir = resolve(options.outDir ?? join(APP, 'dist'));
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(join(outDir, 'js'), { recursive: true });
  const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc');
  const result = spawnSync(process.execPath, [tsc, '-p', join(APP, 'tsconfig.json'), '--outDir', join(outDir, 'js'), '--pretty', 'false'], { cwd: ROOT, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`authority-web: TypeScript failed:\n${result.stdout ?? ''}${result.stderr ?? ''}`);
  for (const file of STATIC_FILES) copyFileSync(join(APP, file), join(outDir, file));
  const files = walk(outDir)
    .map((path) => relative(outDir, path).split(sep).join('/'))
    .filter((path) => path !== 'asset-manifest.json')
    .sort();
  const manifest = {
    format: 'frontera.authority-web.assets.v1',
    files: files.map((path) => ({ path, sha256: createHash('sha256').update(readFileSync(join(outDir, path))).digest('hex'), bytes: statSync(join(outDir, path)).size })),
  };
  writeFileSync(join(outDir, 'asset-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return { outDir, files: [...files, 'asset-manifest.json'] };
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const flag = process.argv.indexOf('--out');
  const built = await buildAuthorityWeb(flag > 0 && process.argv[flag + 1] !== undefined ? { outDir: process.argv[flag + 1] } : {});
  console.log(`authority-web: built ${String(built.files.length)} files into ${relative(ROOT, built.outDir) || built.outDir}`);
}
