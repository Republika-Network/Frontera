import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';

import { isPackageScopedProtocolImport } from './protocol/lib-protocol-artifact.mjs';

const roots = ['src', 'packages', 'tests'];
const sourceExt = new Set(['.ts', '.mts', '.cts']);
const ignoredDirs = new Set(['dist', 'build', 'node_modules', '.next', 'coverage']);
const violations = [];

const relImport = /(?:import|export)\s+(?:[^'";]+?\s+from\s+)?['"](\.{1,2}\/[^'"?#]+)['"]/g;
const dynImport = /import\(\s*['"](\.{1,2}\/[^'"?#]+)['"]\s*\)/g;
const legacyAlias = /['"]@\//;
// Captures every occurrence the earlier non-capturing form matched (no closing quote required).
const deepProtocol = /['"](@aoc\/protocol\/[^'"\s]*)/g;

function hasSourceExt(specifier) {
  return ['.js', '.mjs', '.cjs', '.json'].some((ext) => specifier.endsWith(ext));
}

function walk(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const st = statSync(path);
    if (st.isDirectory()) { if (!ignoredDirs.has(name)) walk(path); }
    else if ([...sourceExt].some((ext) => path.endsWith(ext)) && !path.endsWith('.d.ts')) checkFile(path);
  }
}

function checkMatches(path, text, pattern, check) {
  pattern.lastIndex = 0;
  for (const match of text.matchAll(pattern)) {
    const spec = match[1];
    check(spec, match.index ?? 0);
  }
}


function resolvesToIndexTs(path, spec) {
  const abs = resolve(dirname(path), spec);
  try {
    const st = statSync(abs);
    if (!st.isDirectory()) return false;
    return statSync(join(abs, 'index.ts')).isFile();
  } catch {
    return false;
  }
}

function checkFile(path) {
  const text = readFileSync(path, 'utf8');

  if (legacyAlias.test(text)) violations.push(`${path}: forbidden legacy alias '@/'.`);
  // Any quoted deep specifier counts (import, export, require, dynamic import). Only a
  // package-scoped allowance, inside its own package directory, admits one.
  const relPath = path.replace(/\\/g, '/');
  checkMatches(path, text, deepProtocol, (spec) => {
    if (!isPackageScopedProtocolImport(spec, relPath)) violations.push(`${path}: forbidden deep import from @aoc/protocol.`);
  });

  const recordExt = (spec) => {
    if (!hasSourceExt(spec) && !resolvesToIndexTs(path, spec)) violations.push(`${path}: relative import missing Node16 extension -> ${spec}`);
  };

  checkMatches(path, text, relImport, recordExt);
  checkMatches(path, text, dynImport, recordExt);
}

for (const root of roots) {
  try {
    walk(root);
  } catch {
    // Optional trees (e.g., tests) can be absent in some package variants.
  }
}

if (violations.length) {
  console.error('Node16/import boundary violations:');
  for (const v of violations) console.error(`- ${v}`);
  process.exit(1);
}

console.log('Node16 import and boundary checks passed');
