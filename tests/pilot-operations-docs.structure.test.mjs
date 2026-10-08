// PROD-03-04 — the pilot operations documentation, structurally.
//
// docs/pilot/ states facts other files own: script names, npm scripts,
// Compose services, HTTP routes (the API freeze), section numbers. Each is
// checked against its owner here, so a drift fails `npm test`. The documented
// commands themselves are executed by scripts/deploy/qualify-pilot-acceptance.mjs
// (needs Docker); this test proves every command block is either executed
// there or explicitly marked as reference, and that no block or sentence
// teaches what the pilot forbids.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { EXECUTED_BLOCKS, EXECUTED_DOCUMENTS, executableBlocks } from '../scripts/deploy/qualify-pilot-acceptance.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (path) => readFileSync(join(ROOT, path), 'utf8').replace(/\r\n/g, '\n');

const PILOT_DOCS = ['README.md', 'PILOT_READINESS.md', 'SHARED_RESPONSIBILITY.md', 'OPERATIONS_RUNBOOK.md', 'INCIDENT_TRIAGE.md', 'PILOT_ACCEPTANCE.md'];
const DOCS = Object.fromEntries(PILOT_DOCS.map((name) => [name, read(`docs/pilot/${name}`)]));
const COMPOSE = read('deploy/pilot/compose.yaml');
const PKG = JSON.parse(read('package.json'));
const FREEZE = JSON.parse(read('release/api-surface.v1.json'));

/** Every fenced shell block: the document, its text (indentation removed) and the marker line before it. */
function shellBlocks() {
  const out = [];
  for (const [name, text] of Object.entries(DOCS)) {
    for (const match of text.matchAll(/^([ \t]*)```(?:bash|sh)\n([\s\S]*?)\n\1```$/gm)) {
      const before = text.slice(0, match.index).trimEnd().split('\n').pop().trim();
      out.push({ name, body: match[2].split('\n').map((line) => line.slice(match[1].length)).join('\n'), marker: before });
    }
  }
  return out;
}
const BLOCKS = shellBlocks();
const ALL_COMMANDS = BLOCKS.map((block) => block.body).join('\n');

/** Prose lines: everything outside fenced blocks. */
function proseLines(text) {
  const lines = [];
  let fenced = false;
  for (const line of text.split('\n')) {
    if (/^\s*```/.test(line)) fenced = !fenced;
    else if (!fenced) lines.push(line);
  }
  return lines;
}

/**
 * Prose sentences: paragraphs and list items joined across line wraps, then
 * split at sentence ends; table rows cell by cell, except a "Forbidden" column,
 * whose cells name what must not be done.
 */
function proseSentences(text) {
  const units = [];
  let current = [];
  let header = null;
  const flush = () => {
    if (current.length > 0) units.push(current.join(' '));
    current = [];
  };
  const cells = (line) => line.trim().replace(/^\||\|$/g, '').split('|').map((cell) => cell.trim());
  for (const line of proseLines(text)) {
    if (!/^\s*\|/.test(line)) header = null;
    if (line.trim() === '' || /^\s*#/.test(line)) flush();
    else if (/^\s*\|/.test(line)) {
      flush();
      if (header === null) header = cells(line);
      else if (!/^\s*\|[\s|:-]+\|\s*$/.test(line)) units.push(...cells(line).filter((_, index) => !/forbidden/i.test(header[index] ?? '')).map((cell) => `| ${cell}`));
    } else {
      if (/^\s*(?:[-*]|\d+\.)\s/.test(line)) flush();
      current.push(line.trim());
    }
  }
  flush();
  return units.flatMap((unit) => (unit.trimStart().startsWith('|') ? [unit] : unit.split(/(?<=[.!?:])\s+(?=[A-Z*`])/)));
}

describe('PROD-03-04 pilot operations documentation', () => {
  it('is one small set with one entry point that links every document and the PROD-03-03 guide', () => {
    assert.deepEqual(readdirSync(join(ROOT, 'docs/pilot')).sort(), [...PILOT_DOCS].sort());
    for (const name of PILOT_DOCS.filter((doc) => doc !== 'README.md')) assert.ok(DOCS['README.md'].includes(`](${name})`), `README links ${name}`);
    assert.ok(DOCS['README.md'].includes('](../deployment/PILOT_DEPLOYMENT.md)'));
    assert.ok(read('docs/deployment/PILOT_DEPLOYMENT.md').includes('docs/pilot/README.md'), 'the deployment guide points to the operations entry point');
    assert.ok(read('README.md').includes('docs/pilot/README.md'), 'the repository README indexes it');
  });

  it('every command block is executed by the acceptance qualification or explicitly marked as reference', () => {
    assert.ok(BLOCKS.length > 0);
    for (const block of BLOCKS) {
      assert.match(block.marker, /^<!-- (exec: [a-z0-9-]+|ref: .{10,}) -->$/, `${block.name}: unmarked block:\n${block.body}`);
      if (block.marker.startsWith('<!-- exec:')) assert.ok(EXECUTED_DOCUMENTS.includes(`docs/pilot/${block.name}`), `${block.name} is not a document the qualification executes`);
    }
    const ids = EXECUTED_DOCUMENTS.flatMap((document) => [...executableBlocks(read(document)).keys()]);
    assert.equal(new Set(ids).size, ids.length, 'exec ids are unique');
    assert.deepEqual([...ids].sort(), [...EXECUTED_BLOCKS].sort(), 'the documents carry exactly the blocks the qualification executes');
    const markers = BLOCKS.filter((block) => block.marker.startsWith('<!-- exec:')).length;
    assert.equal(markers, ids.length, 'every exec marker parses as an executable block');
  });

  it('every script, npm script, Compose service and HTTP route a command names exists', () => {
    for (const [, script] of ALL_COMMANDS.matchAll(/node (scripts\/[A-Za-z0-9/_.-]+\.mjs)/g)) assert.ok(existsSync(join(ROOT, script)), script);
    for (const [, name] of ALL_COMMANDS.matchAll(/npm run ([a-z0-9:-]+)/g)) assert.ok(PKG.scripts[name] !== undefined, `npm run ${name}`);
    const services = [...ALL_COMMANDS.matchAll(/docker compose (?:run --rm(?: -T)?(?: --entrypoint \S+)?|logs(?: --[a-z-]+(?: \d+)?)*|stop|start|restart|ps -a -q) ([a-z][a-z-]*)/g)].map((match) => match[1]);
    for (const service of ['config-check', 'witness-init', 'frontera', 'authority-witness']) assert.ok(services.includes(service), `a command uses ${service}`);
    for (const service of services) assert.match(COMPOSE, new RegExp(`^  ${service}:$`, 'm'), service);
    assert.match(COMPOSE, /^name: frontera-pilot$/m, 'the documented volume names assume the frontera-pilot project');
    // A single quote inside `sh -c '…'` ends the script early (curl would receive `-w n`).
    for (const [, script] of ALL_COMMANDS.matchAll(/sh -c '([^'\n]*)'(?=[^\s;|&)])/g)) assert.fail(`nested single quote inside sh -c '${script}'`);
    for (const volume of ALL_COMMANDS.match(/frontera-pilot_[a-z-]+/g) ?? []) assert.match(COMPOSE, new RegExp(`^  ${volume.slice('frontera-pilot_'.length)}:$`, 'm'), volume);
    const patterns = FREEZE.routePatterns.map((pattern) => new RegExp(pattern));
    const paths = [...`${ALL_COMMANDS}\n${Object.values(DOCS).join('\n')}`.matchAll(/(?:http:\/\/127\.0\.0\.1:8787|`(?:GET|POST) )(\/[A-Za-z0-9/_.{}$:-]*)/g)].map((match) => match[1]);
    assert.ok(paths.length > 20);
    for (const path of paths) {
      const concrete = path.replace(/\{[^}]+\}|\$[A-Z_]+/g, 'x').replace(/\/(?:…|\.\.\.)$/, '');
      assert.ok(FREEZE.routeLiterals.includes(concrete) || patterns.some((pattern) => pattern.test(concrete)), `route ${path} is not in the API freeze`);
    }
  });

  it('section references between the pilot documents resolve to a heading', () => {
    for (const [name, text] of Object.entries(DOCS)) {
      for (const [, target, section] of text.matchAll(/([A-Z_]+\.md)`?\]?(?:\([A-Za-z_.]+\))?\s+§(\d+(?:\.\d+)?)/g)) {
        if (!PILOT_DOCS.includes(target)) continue;
        const heading = section.includes('.') ? `### ${section} ` : `## ${section}. `;
        assert.ok(DOCS[target].includes(`\n${heading}`), `${name}: ${target} §${section} has no heading`);
      }
    }
  });

  it('no command deletes volumes, kills the Host, edits a store or resets the witness', () => {
    for (const block of BLOCKS) {
      assert.equal(/down\s+-v\b|\bkill\s+-9\b|docker\s+kill|\bsqlite3\b|\bUPDATE\s|\bDELETE\s+FROM\b|\brm\s+-rf?\s+\/var\/lib|volume\s+rm/i.test(block.body), false, `${block.name}:\n${block.body}`);
    }
    // `down -v` is named only to forbid it.
    for (const [name, text] of Object.entries(DOCS)) {
      for (const line of proseLines(text).filter((candidate) => /down -v/.test(candidate))) {
        assert.match(line, /\bnever\b|\bNOT\b|deletes|\*\*deleted\*\*|out of every command/i, `${name}: ${line}`);
      }
    }
  });

  it('backup and restore run only on a stopped Host, and archives are created private', () => {
    for (const block of BLOCKS) {
      for (const line of block.body.split('\n').filter((candidate) => /(backup|restore)-enterprise-v1\.mjs/.test(candidate))) {
        const guarded = block.body.slice(0, block.body.indexOf(line) + line.length);
        assert.match(guarded, /docker compose ps -q --status running frontera\)" \] &&/, `${block.name}: ${line.slice(0, 80)} runs without checking the Host is stopped`);
      }
      for (const line of block.body.split('\n').filter((candidate) => /> "\$BACKUP_(?:FILE|DIR)/.test(candidate) && /\.tar|BACKUP_FILE"/.test(candidate))) {
        assert.match(line, /umask 077/, `${block.name}: archive written without umask 077: ${line.slice(0, 80)}`);
      }
    }
  });

  it('no sentence teaches retrying, replaying or resending a governed action', () => {
    const word = /\b(retr(?:y|ies|ied|ying)|replay(?:s|ed|ing)?|resen(?:d|ds|t|ding)|re-?run(?:s|ning)?|re-?execut\w*)\b/i;
    const allowed = /\b(?:no|not|never|nothing|none|without|forbidden|cannot|do not|isn't)\b|outcome: replayed|`replayed`|POSTs/i;
    for (const [name, text] of Object.entries(DOCS)) {
      for (const sentence of proseSentences(text).filter((candidate) => word.test(candidate))) {
        assert.match(sentence, allowed, `${name}: "${sentence.trim()}"`);
      }
    }
    assert.equal(word.test(ALL_COMMANDS), false, 'no command retries or replays anything');
  });

  it('the rollback boundary promises no schema downgrade; the go-live gate cannot override /ready', () => {
    const runbook = DOCS['OPERATIONS_RUNBOOK.md'];
    assert.match(runbook, /There is \*\*no store schema downgrade\*\*/);
    assert.equal(/downgrade (?:is|are) supported|supports? (?:a )?(?:schema )?downgrade/i.test(Object.values(DOCS).join('\n')), false);
    const readiness = DOCS['PILOT_READINESS.md'];
    for (const decision of ['**READY**', '**READY WITH ACCEPTED DEGRADATION**', '**NOT READY**']) assert.ok(readiness.includes(decision), decision);
    assert.match(readiness, /Human acceptance never overrides a failed `\/ready`/);
  });

  it('acceptance lists A1–A17, O1–O15 and the three statuses, and never lets acceptance override readiness', () => {
    const acceptance = DOCS['PILOT_ACCEPTANCE.md'];
    for (let n = 1; n <= 17; n += 1) assert.match(acceptance, new RegExp(`^\\| A${n} \\|`, 'm'), `A${n}`);
    for (let n = 1; n <= 15; n += 1) assert.match(acceptance, new RegExp(`^\\| O${n} \\|`, 'm'), `O${n}`);
    for (const status of ['**ACCEPTED**', '**ACCEPTED WITH DOCUMENTED LIMITATIONS**', '**NOT ACCEPTED**']) assert.ok(acceptance.includes(status), status);
    assert.match(acceptance, /`\/ready` is not 200/);
    assert.match(acceptance, /"schema": "frontera\.pilot-acceptance-evidence\.v1"/);
  });

  it('the shared-responsibility matrix covers every pilot responsibility', () => {
    const matrix = DOCS['SHARED_RESPONSIBILITY.md'].toLowerCase();
    for (const topic of ['operating system', 'docker runtime', 'firewall', 'dns', 'tls', 'reverse proxy', 'secret storage', 'authority signing key custody', 'operator credentials', 'provider credentials', 'backup scheduling', 'backup storage', 'restore execution', 'release artifact integrity', 'configuration correctness', 'host readiness', 'module health', 'application logs', 'infrastructure monitoring', 'governed-action policy', 'approvals', 'emergency stop', 'operator resolution', 'audit retention', 'escalation', 'data retention', 'upgrades', 'rollback', 'vulnerability patching']) {
      assert.ok(matrix.includes(topic), topic);
    }
  });

  it('names no personal path, Windows or WSL path, cloud provider, stale endpoint count or payment rail', () => {
    const files = { ...Object.fromEntries(Object.entries(DOCS).map(([name, text]) => [`docs/pilot/${name}`, text])), 'scripts/deploy/qualify-pilot-acceptance.mjs': read('scripts/deploy/qualify-pilot-acceptance.mjs') };
    const personalOrPlatform = /[A-Z]:\\|C:\/Users|\/mnt\/c\/|\/home\/[a-z]|vicvalch|onchainfest|\bWSL\b|digitalocean|amazonaws|\bAWS\b|\bAzure\b|\bGCP\b|vercel|\bandrew\b|\blumx\b/i;
    // The qualification's O15 detector names the rails it looks for: the one file that may.
    const rail = /xrpl|rlusd|lightning|wallet/i;
    for (const [file, text] of Object.entries(files)) {
      const hit = personalOrPlatform.exec(text) ?? (file.endsWith('.mjs') ? null : rail.exec(text));
      assert.equal(hit, null, `${file}: ${hit?.[0]}`);
      for (const [, count] of text.matchAll(/\b(\d+) (?:HTTP )?endpoints?\b/g)) assert.equal(Number(count), FREEZE.endpointCount, `${file}: stale endpoint count ${count}`);
    }
  });

  it('CI runs the acceptance qualification', () => {
    assert.match(read('.github/workflows/ci.yml'), /qualify-pilot-acceptance\.mjs --commit/);
  });
});
