import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

/**
 * Drift protection for `docs/security/TRUST_BOUNDARIES.md`.
 *
 * A boundary-and-asset map is only useful while it still describes the code. The
 * failure mode is not that someone writes something false — it is that the code
 * moves and the map quietly stops matching, so a reviewer answers a
 * questionnaire from a register that has rotted.
 *
 * These assertions are schema and reference checks, never prose snapshots:
 *
 *  - every register row carries a well-formed, unique id;
 *  - every repository path the document cites still exists;
 *  - every environment variable named in the secrets register is still read by
 *    real code, so a removed secret cannot linger in the register and an
 *    inventory claim cannot outlive its subject;
 *  - every `SEC-INV-nnn` / `SEC-TRUST-nnn` cross-reference resolves against
 *    `SECURITY_INVARIANTS.md`, so the two canonical documents cannot drift apart.
 *
 * Nothing here asserts that a weakness exists. A row describing a weak boundary
 * is free to be fixed; what must not happen is the citation behind it going
 * stale without anyone noticing.
 */

const BOUNDARIES_DOC = 'docs/security/TRUST_BOUNDARIES.md';
const INVARIANTS_DOC = 'docs/security/SECURITY_INVARIANTS.md';

const doc = existsSync(BOUNDARIES_DOC) ? readFileSync(BOUNDARIES_DOC, 'utf8') : '';
const invariants = existsSync(INVARIANTS_DOC) ? readFileSync(INVARIANTS_DOC, 'utf8') : '';

/**
 * Ids declared in a leading table cell, e.g. `| **TB-004** | ...`.
 *
 * Zones are single-digit (`TZ-0`) and the two registers are three-digit
 * (`TB-001`, `PA-001`), so the width is deliberately loose here; uniqueness is
 * asserted per prefix by the callers rather than implied by the shape.
 */
function registerIds(prefix: string): readonly string[] {
  const pattern = new RegExp(`^\\|\\s*\\*{0,2}(${prefix}-\\d{1,3})\\*{0,2}\\s*\\|`, 'gm');
  return [...doc.matchAll(pattern)].map((match) => match[1] ?? '');
}

describe('TRUST_BOUNDARIES.md — the registers are well formed', () => {
  it('the canonical trust-boundary document exists', () => {
    assert.ok(doc.length > 0, `${BOUNDARIES_DOC} is the canonical boundary/asset map and must exist`);
  });

  it('declares trust zones, and every zone id is unique', () => {
    const zones = registerIds('TZ');
    assert.ok(zones.length >= 8, `expected the trust-zone table to be populated, found ${zones.length}`);
    assert.equal(new Set(zones).size, zones.length, `duplicate trust-zone id: ${zones.join(', ')}`);
  });

  it('declares trust boundaries, and every boundary id is unique', () => {
    const boundaries = registerIds('TB');
    assert.ok(boundaries.length >= 12, `expected the boundary register to be populated, found ${boundaries.length}`);
    assert.equal(new Set(boundaries).size, boundaries.length, `duplicate boundary id: ${boundaries.join(', ')}`);
  });

  it('declares privileged assets, and every asset id is unique', () => {
    const assets = registerIds('PA');
    assert.ok(assets.length >= 18, `expected the privileged-asset register to be populated, found ${assets.length}`);
    assert.equal(new Set(assets).size, assets.length, `duplicate asset id: ${assets.join(', ')}`);
  });

  it('maps the governed-agent zone, which is the one the architecture does not isolate', () => {
    // TZ-8 is the defining gap. A future edit that drops it would remove the
    // single row a reader most needs to see.
    assert.ok(doc.includes('TZ-8'), 'the governed-agent trust zone must stay in the map');
  });
});

describe('TRUST_BOUNDARIES.md — every citation still resolves', () => {
  it('every repository path the document cites exists', () => {
    const cited = new Set<string>();
    for (const match of doc.matchAll(/`((?:src|apps|packages|docs)\/[A-Za-z0-9_.[\]/-]*)`/g)) {
      const raw = match[1] ?? '';
      // Strip a trailing `:12` / `:12,34` / `:12-34` line reference.
      const path = raw.replace(/:[0-9,\-]*$/, '');
      if (path.length > 0) cited.add(path);
    }
    assert.ok(cited.size >= 6, `expected the document to cite real paths, found ${cited.size}`);
    const missing = [...cited].filter((path) => !existsSync(path)).sort();
    assert.deepEqual(missing, [], 'the boundary map cites paths that no longer exist — the register has drifted from the code');
  });

  it('every environment variable in the secrets register is still read by real code', () => {
    const named = new Set<string>();
    for (const match of doc.matchAll(/`([A-Z][A-Z0-9_]{6,})`/g)) {
      const name = match[1] ?? '';
      // Only names that look like configuration, not reason codes or SQL.
      if (/^(AOC|STRIPE|PINATA|PASSPORT|NODE)_/.test(name)) named.add(name);
    }
    assert.ok(named.size >= 5, `expected the secrets register to name real env vars, found ${named.size}`);

    for (const name of [...named].sort()) {
      // `git grep` over tracked files only: no node_modules, no dist.
      //
      // It exits 1 when nothing matches, which `execFileSync` raises rather
      // than returning — so "no hits" is caught here and turned into the real
      // assertion, instead of surfacing as an opaque spawn failure.
      let hits = '';
      try {
        hits = execFileSync('git', ['grep', '-l', '--', name, '--', 'src', 'apps', 'packages', 'scripts'], {
          encoding: 'utf8',
          cwd: process.cwd(),
          stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
      } catch {
        hits = '';
      }
      assert.ok(hits.length > 0, `${name} is in the privileged-asset register but is no longer read anywhere — the register has drifted`);
    }
  });

  it('every SEC-INV / SEC-TRUST cross-reference resolves against SECURITY_INVARIANTS.md', () => {
    assert.ok(invariants.length > 0, `${INVARIANTS_DOC} must exist for the cross-references to resolve`);
    const referenced = new Set([...doc.matchAll(/\b(SEC-INV-(?:U?\d{2,3})|SEC-TRUST-\d{3})\b/g)].map((match) => match[1] ?? ''));
    assert.ok(referenced.size >= 8, `expected the map to cross-reference the invariants, found ${referenced.size}`);
    const dangling = [...referenced].filter((id) => !invariants.includes(id)).sort();
    assert.deepEqual(dangling, [], 'the boundary map references invariants that do not exist — the two canonical documents have drifted apart');
  });
});
