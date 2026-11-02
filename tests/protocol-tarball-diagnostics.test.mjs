// CI-TEST-LOG-01 — the protocol-tarball battery's failure diagnostics. Synthetic, test-only fixtures run by the
// real Node test runner (TAP to a file, as in CI) in temporary directories: no production code, no real suite.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { runLogged, summarizeTapFailures, tailOf } from '../scripts/protocol/lib-test-diagnostics.mjs';

const dirs = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});
const directory = () => {
  const dir = mkdtempSync(join(tmpdir(), 'ci-test-log01-'));
  dirs.push(dir);
  return dir;
};

/** Runs synthetic test files with the real Node test runner, TAP output to a log file, exactly as `npm run test` does in CI. */
function runSuite(files) {
  const dir = directory();
  const paths = Object.entries(files).map(([name, body]) => {
    const path = join(dir, name);
    writeFileSync(path, body);
    return path;
  });
  const logFile = join(dir, 'test.log');
  // A `node --test` started inside a test run would report to its parent (NODE_TEST_CONTEXT); CI's is top-level.
  const { NODE_TEST_CONTEXT: _nested, ...env } = process.env;
  const result = runLogged(process.execPath, ['--test', '--test-reporter=tap', ...paths], dir, logFile, { env });
  return { ...result, output: readFileSync(logFile, 'utf8') };
}

const HEADER = "import { describe, it } from 'node:test';\nimport assert from 'node:assert/strict';\n";

describe('CI-TEST-LOG-01 — every failing test is identifiable, the exit status is the test run’s own', () => {
  it('success: exit 0, ok, no failure listed, the totals still reported', () => {
    const run = runSuite({ 'a.test.mjs': `${HEADER}it('passes', () => assert.equal(1, 1));\nit('also passes', () => {});\n` });
    assert.equal(run.status, 0);
    assert.equal(run.ok, true);
    const { failures, totals, summary } = summarizeTapFailures(run.output);
    assert.deepEqual(failures, []);
    assert.match(totals.join(' '), /tests 2, suites 0, pass 2, fail 0, cancelled 0, skipped 0, todo 0/);
    assert.match(summary, /No failing test was found/);
  });

  it('a single failure: exit 1, not ok; its suite path, name, location and assertion are in the summary', () => {
    const run = runSuite({ 'one.test.mjs': `${HEADER}describe('the suite', () => { describe('inner', () => { it('the failing test', () => assert.equal('actual-value', 'expected-value', 'a precise assertion message')); }); it('a sibling that passes', () => {}); });\n` });
    assert.equal(run.status, 1);
    assert.equal(run.ok, false);
    const { failures, summary } = summarizeTapFailures(run.output);
    assert.equal(failures.length, 1, 'parents failing only through their subtest are not listed again');
    assert.deepEqual(failures[0].path, ['the suite', 'inner']);
    assert.equal(failures[0].name, 'the failing test');
    assert.match(summary, /1\. the suite > inner > the failing test/);
    assert.match(summary, /a precise assertion message/);
    assert.match(summary, /one\.test\.mjs:\d+:\d+/);
    assert.match(summary, /expected-value/);
  });

  it('several failures in several files are all listed; TODO and SKIP are not failures; the exit status is unchanged', () => {
    const run = runSuite({
      'a.test.mjs': `${HEADER}it('first failure', () => { throw new Error('boom one'); });\nit('a todo that fails', { todo: true }, () => { throw new Error('not counted'); });\nit('skipped', { skip: true }, () => {});\n`,
      'b.test.mjs': `${HEADER}describe('group b', () => { it('second failure', () => assert.fail('boom two')); it('third failure', async () => { await Promise.reject(new TypeError('boom three')); }); });\n`,
    });
    assert.equal(run.status, 1);
    const { failures, summary } = summarizeTapFailures(run.output);
    assert.deepEqual(failures.map((f) => [...f.path, f.name].join(' > ')).sort(), ['first failure', 'group b > second failure', 'group b > third failure']);
    for (const message of ['boom one', 'boom two', 'boom three']) assert.match(summary, new RegExp(message));
    assert.doesNotMatch(summary, /a todo that fails|not counted/);
  });

  it('very long output: failures at the beginning, the middle and the end all survive (no reliance on the last 3,000 characters)', () => {
    // Long TAP, as in CI: the failures are separated by thousands of passing tests' results.
    const fillers = (from) => `for (let i = 0; i < 15000; i += 1) it(\`passing filler ${from} \${String(i)}\`, () => {});\n`;
    const run = runSuite({
      'long.test.mjs': `${HEADER}it('early failure', () => assert.fail('early'));\n${fillers('a')}it('middle failure', () => assert.fail('middle'));\n${fillers('b')}it('late failure', () => assert.fail('late'));\nfor (let i = 0; i < 300; i += 1) it(\`trailing filler \${String(i)}\`, () => {});\n`,
    });
    assert.equal(run.status, 1);
    assert.ok(run.output.length > 2 * 1024 * 1024, `the log is complete: ${String(run.output.length)} characters`);
    const { failures, summary } = summarizeTapFailures(run.output);
    assert.deepEqual(failures.map((f) => f.name), ['early failure', 'middle failure', 'late failure']);
    assert.ok(summary.length < 16_100, 'the summary stays bounded');
    // The old diagnostic (the last 3,000 characters) names none of them.
    assert.doesNotMatch(run.output.slice(-3000), /early failure|middle failure/);
  });

  it('the summary is bounded in count, per-failure detail and total size, and says where the rest is', () => {
    const many = Array.from({ length: 60 }, (_, i) => `it('failure ${String(i)}', () => { throw new Error('${'e'.repeat(400)}'); });`).join('\n');
    const run = runSuite({ 'many.test.mjs': `${HEADER}${many}\n` });
    const { failures, summary } = summarizeTapFailures(run.output, { maxFailures: 10, maxChars: 4_000 });
    assert.equal(failures.length, 60, 'every failure is still identified');
    assert.ok(summary.length <= 4_000 + 200);
    assert.match(summary, /60 failing test\(s\)/);
    assert.match(summary, /summary truncated|more failing test\(s\) in the full log/);
  });

  it('infrastructure failures are never success: a command that cannot start, a crashing runner, no output, a signal', () => {
    const dir = directory();
    const missing = runLogged(join(dir, 'no-such-binary'), [], dir, join(dir, 'missing.log'));
    assert.equal(missing.ok, false);
    assert.match(missing.error ?? '', /ENOENT/);
    assert.match(readFileSync(join(dir, 'missing.log'), 'utf8'), /error=ENOENT/);
    const crash = runLogged(process.execPath, ['-e', 'throw new Error("runner exploded")'], dir, join(dir, 'crash.log'));
    assert.equal(crash.ok, false);
    assert.equal(crash.status, 1);
    assert.match(readFileSync(join(dir, 'crash.log'), 'utf8'), /runner exploded/);
    const silent = runLogged(process.execPath, ['-e', 'process.exit(3)'], dir, join(dir, 'silent.log'));
    assert.equal(silent.ok, false);
    assert.equal(silent.status, 3);
    assert.match(summarizeTapFailures(readFileSync(join(dir, 'silent.log'), 'utf8')).summary, /No failing test was found/);
    const killed = runLogged(process.execPath, ['-e', 'process.stdout.write("partial output\\n"); process.kill(process.pid, "SIGKILL")'], dir, join(dir, 'killed.log'));
    assert.equal(killed.ok, false);
    assert.equal(killed.status, null);
    assert.equal(killed.signal, 'SIGKILL');
    assert.match(readFileSync(join(dir, 'killed.log'), 'utf8'), /partial output[\s\S]*signal=SIGKILL/, 'what was written before the kill is kept');
    // An absent log file reads as empty, never as a pass.
    assert.equal(tailOf(join(dir, 'never-written.log'), 100), '');
  });

  it('end to end, the real validator against a synthetic tarball and repository: a failing test is named, its log kept, the exit is 1; a clean run exits 0 with no failure summary', { timeout: 240_000 }, () => {
    const VALIDATOR = fileURLToPath(new URL('../scripts/protocol/validate-enterprise-against-protocol-tarball.mjs', import.meta.url));
    const dir = directory();
    // A minimal @aoc/protocol package, packed locally (no network, no real Protocol checkout).
    const pkg = join(dir, 'protocol');
    mkdirSync(pkg);
    writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: '@aoc/protocol', version: '0.0.0-ci-test-log01', main: 'index.js', exports: { '.': './index.js' } }));
    writeFileSync(join(pkg, 'index.js'), 'module.exports = {};\n');
    const pack = spawnSync('npm', ['pack', '--silent', '--pack-destination', dir], { cwd: pkg, encoding: 'utf8' });
    assert.equal(pack.status, 0, pack.stderr);
    const tarball = join(dir, pack.stdout.trim().split('\n').pop());
    const validate = (testBody, label) => {
      const repo = join(dir, `repo-${label}`);
      mkdirSync(join(repo, 'tests'), { recursive: true });
      const ok = 'node -e 0';
      writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: `ci-test-log01-${label}`, private: true, devDependencies: { '@aoc/protocol': 'file:/placeholder.tgz' }, scripts: { typecheck: ok, build: ok, lint: ok, test: 'node --test --test-reporter=tap tests/battery.test.mjs', 'check:protocol-consumption': ok, 'check:aoc-boundaries': ok, 'validate:publishability': ok, 'check:release-integrity': ok } }));
      writeFileSync(join(repo, 'tsconfig.base.json'), JSON.stringify({ compilerOptions: { paths: {} } }));
      writeFileSync(join(repo, 'tests', 'battery.test.mjs'), `${HEADER}${testBody}`);
      const logs = join(dir, `logs-${label}`);
      const summaryFile = join(dir, `summary-${label}.md`);
      const { NODE_TEST_CONTEXT: _nested, ...env } = process.env;
      const run = spawnSync(process.execPath, [VALIDATOR, tarball], { cwd: repo, encoding: 'utf8', env: { ...env, AOC_TARBALL_VALIDATE_LOG_DIR: logs, GITHUB_STEP_SUMMARY: summaryFile, npm_config_audit: 'false', npm_config_fund: 'false' }, timeout: 180_000 });
      return { run, logs, summaryFile };
    };
    const failing = validate("describe('battery suite', () => { it('the battery’s failing test', () => assert.equal('got', 'wanted', 'a battery assertion')); it('passes', () => {}); });\nit('another failing test', () => { throw new Error('second failure'); });\n", 'failing');
    assert.equal(failing.run.status, 1, failing.run.stderr.slice(-2000));
    assert.match(failing.run.stderr, /FAIL {2}test\n2 failing test\(s\):\n1\. battery suite > the battery’s failing test[\s\S]*a battery assertion[\s\S]*2\. another failing test[\s\S]*second failure[\s\S]*full log: /);
    const testLog = readdirSync(failing.logs).find((name) => /npm-run-test\.log$/.test(name));
    assert.ok(testLog, 'the test step’s complete log is kept in the configured directory');
    assert.match(readFileSync(join(failing.logs, testLog), 'utf8'), /not ok \d+ - the battery’s failing test[\s\S]*exit status=1/);
    assert.match(readFileSync(failing.summaryFile, 'utf8'), /`test` failed[\s\S]*battery suite > the battery’s failing test/);
    assert.equal(JSON.parse(failing.run.stdout).exitCode, 1);
    const passing = validate("it('passes', () => {});\n", 'passing');
    assert.equal(passing.run.status, 0, passing.run.stderr.slice(-2000));
    assert.doesNotMatch(passing.run.stderr, /failing test|FAIL /);
    assert.equal(existsSync(passing.summaryFile), false, 'no failure summary for a clean run');
    assert.equal(JSON.parse(passing.run.stdout).exitCode, 0);
  });

  it('the battery’s own `node --test` commands pass no reporter flag: TAP is the default to a file, so the summary still names the failure', () => {
    const dir = directory();
    const file = join(dir, 'default.test.mjs');
    writeFileSync(file, `${HEADER}it('fails under the default reporter', () => assert.fail('default reporter'));\n`);
    const { NODE_TEST_CONTEXT: _nested, ...env } = process.env;
    const run = runLogged(process.execPath, ['--test', file], dir, join(dir, 'default.log'), { env });
    assert.equal(run.status, 1);
    const output = readFileSync(join(dir, 'default.log'), 'utf8');
    assert.match(output, /^TAP version 13$/m, 'the default reporter for non-TTY output is TAP; if Node changes it, the battery needs --test-reporter=tap');
    assert.deepEqual(summarizeTapFailures(output).failures.map((f) => f.name), ['fails under the default reporter']);
  });

  it('review Low: a log directory that cannot be created fails the run (exit 1) before any isolated copy exists to leak', () => {
    const VALIDATOR = fileURLToPath(new URL('../scripts/protocol/validate-enterprise-against-protocol-tarball.mjs', import.meta.url));
    const dir = directory();
    const tarball = join(dir, 'placeholder.tgz');
    writeFileSync(tarball, 'not really a tarball');
    const notADirectory = join(dir, 'a-file');
    writeFileSync(notADirectory, '');
    const copies = () => readdirSync(tmpdir()).filter((name) => name.startsWith('aoc-enterprise-tarball-validate-') && !name.startsWith('aoc-enterprise-tarball-validate-logs-'));
    const before = new Set(copies());
    const { NODE_TEST_CONTEXT: _nested, ...env } = process.env;
    const run = spawnSync(process.execPath, [VALIDATOR, tarball], { cwd: dir, encoding: 'utf8', env: { ...env, AOC_TARBALL_VALIDATE_LOG_DIR: notADirectory }, timeout: 60_000 });
    assert.equal(run.status, 1);
    assert.match(run.stderr, /FATAL/);
    assert.deepEqual(copies().filter((name) => !before.has(name)), [], 'no isolated copy was left behind');
  });

  it('a log too large to load still yields its tail, read from the end of the file', () => {
    const dir = directory();
    const file = join(dir, 'big.log');
    writeFileSync(file, `${'x'.repeat(3 * 1024 * 1024)}\nTHE-END-MARKER\n`);
    assert.match(tailOf(file, 100), /THE-END-MARKER\n$/);
    assert.ok(tailOf(file, 100).length <= 100);
  });

  it('output is streamed to the file as it is produced (a run killed from outside keeps everything written so far)', () => {
    const dir = directory();
    const logFile = join(dir, 'streamed.log');
    const run = runLogged(process.execPath, ['-e', 'for (let i = 0; i < 3; i += 1) console.log("line " + i); console.error("an error line"); process.kill(process.pid, "SIGTERM")'], dir, logFile);
    assert.equal(run.ok, false);
    const text = readFileSync(logFile, 'utf8');
    for (const expected of ['line 0', 'line 1', 'line 2', 'an error line']) assert.match(text, new RegExp(expected));
  });
});
