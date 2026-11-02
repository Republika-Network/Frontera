// CI-TEST-LOG-01 — failure diagnostics for the protocol-tarball validation battery.
//
// The battery's commands used to be run with their output buffered in memory, and only the last
// 3,000 characters of a failed step were kept; the isolated copy (and so everything else) was
// deleted afterwards. Node's test runner prints TAP to a non-TTY: each failure is reported where the
// test ran, with no summary at the end, so the tail never named a failing test that ran earlier.
//
// Here:
// - `runLogged` streams a command's interleaved stdout and stderr straight into a log file (complete,
//   written as it is produced, not limited by an in-memory buffer), and reports its exit exactly:
//   only status 0 is success; a spawn error, a signal or a missing status is a failure.
// - `summarizeTapFailures` lists every failing test in TAP output, with its suite path and the details
//   of its YAML block, bounded in count and size, together with every totals block.
// Neither changes what runs, how tests are discovered, or whether a step passes.
import { spawnSync } from 'node:child_process';
import { appendFileSync, closeSync, fstatSync, openSync, readSync } from 'node:fs';

/**
 * Runs `cmd args` in `cwd` with stdout and stderr appended to `logFile` (created or truncated), and
 * returns `{ ok, status, signal, error, logFile }`. `ok` is true only for exit status 0.
 */
export function runLogged(cmd, args, cwd, logFile, { env = process.env } = {}) {
  // A log that cannot be opened (missing or unwritable directory, full disk) never decides the outcome: the
  // command still runs, its output goes to this process's own stdout/stderr (the job log), and the result says
  // the diagnostics were unavailable. Only the command's exit decides `ok`.
  let fd;
  let logError = null;
  try {
    fd = openSync(logFile, 'w');
  } catch (cause) {
    logError = `${cause.code ?? 'ERROR'}: ${cause.message}`;
  }
  let result;
  try {
    result = spawnSync(cmd, args, { cwd, env, stdio: fd === undefined ? ['ignore', 'inherit', 'inherit'] : ['ignore', fd, fd] });
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  const status = typeof result.status === 'number' ? result.status : null;
  const signal = result.signal ?? null;
  const error = result.error ? `${result.error.code ?? 'ERROR'}: ${result.error.message}` : null;
  if (logError === null) {
    try {
      appendFileSync(logFile, `\n[tarball-validate] ${cmd} ${args.join(' ')} -> exit status=${String(status)} signal=${String(signal)}${error ? ` error=${error}` : ''}\n`);
    } catch (cause) {
      logError = `${cause.code ?? 'ERROR'}: ${cause.message}`;
    }
  }
  return { ok: status === 0 && signal === null && error === null, status, signal, error, logFile, logError };
}

/** About the last `chars` characters of a file (read from its end, however large it is), or '' when it cannot be read. */
export function tailOf(file, chars) {
  let fd;
  try {
    fd = openSync(file, 'r');
    const size = fstatSync(fd).size;
    const length = Math.min(size, chars * 4);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    const text = buffer.toString('utf8');
    return text.length > chars ? text.slice(-chars) : text;
  } catch {
    return '';
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

const SUBTEST = /^(\s*)# Subtest: (.*)$/;
const NOT_OK = /^(\s*)not ok \d+ - (.*)$/;
const DIRECTIVE = /\s#\s*(TODO|SKIP)\b/i;
const TOTAL = /^# (tests|suites|pass|fail|cancelled|skipped|todo) \d+\s*$/;

/**
 * Every failing test in TAP output (Node's test runner): its suite path, name and YAML details. A `# TODO`
 * or `# SKIP` result is not a failure; a parent whose only failure is its subtests' (`subtestsFailed`) is
 * counted but not listed, so each real failure appears once. Bounded: at most `maxFailures` listed, each
 * with at most `maxLinesPerFailure` detail lines, and the rendered text at most `maxChars` characters.
 */
export function summarizeTapFailures(text, { maxFailures = 25, maxLinesPerFailure = 40, maxChars = 16_000 } = {}) {
  const lines = String(text).split(/\r?\n/);
  const path = [];
  const failures = [];
  const totals = [];
  let current = [];
  let parentsOnly = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const sub = SUBTEST.exec(line);
    if (sub) {
      const depth = Math.floor(sub[1].length / 4);
      path.length = depth;
      path[depth] = sub[2];
      continue;
    }
    if (TOTAL.test(line)) {
      current.push(line.slice(2));
      if (/^# todo /.test(line)) {
        totals.push(current.join(', '));
        current = [];
      }
      continue;
    }
    const failed = NOT_OK.exec(line);
    if (!failed || DIRECTIVE.test(failed[2])) continue;
    const indent = failed[1];
    const depth = Math.floor(indent.length / 4);
    const details = [];
    let j = i + 1;
    if (lines[j] !== undefined && lines[j].trimEnd() === `${indent}  ---`) {
      // The block ends at its `...`, or (malformed: never closed) at the first non-empty line that is not
      // indented inside it, so an unterminated block never swallows the failures after it.
      const inside = `${indent}  `;
      for (j += 1; j < lines.length; j += 1) {
        const candidate = lines[j];
        if (candidate.trimEnd() === `${indent}  ...`) break;
        if (candidate.trim() !== '' && !candidate.startsWith(inside)) {
          j -= 1;
          break;
        }
        details.push(candidate.slice(inside.length));
      }
      i = j;
    }
    if (details.some((d) => /^failureType: 'subtestsFailed'/.test(d))) {
      parentsOnly += 1;
      continue;
    }
    failures.push({ path: path.slice(0, depth).filter((p) => p !== undefined), name: failed[2], details });
  }
  if (current.length > 0) totals.push(current.join(', '));
  const rendered = [];
  if (failures.length === 0) {
    rendered.push(parentsOnly > 0 ? `No individual failing test was found in the TAP output (${String(parentsOnly)} suite(s) reported failed subtests).` : 'No failing test was found in the TAP output.');
  } else {
    rendered.push(`${String(failures.length)} failing test(s):`);
    for (const [index, failure] of failures.slice(0, maxFailures).entries()) {
      rendered.push(`${String(index + 1)}. ${[...failure.path, failure.name].join(' > ')}`);
      const shown = failure.details.slice(0, maxLinesPerFailure);
      for (const detail of shown) rendered.push(`     ${detail}`);
      if (failure.details.length > shown.length) rendered.push(`     … ${String(failure.details.length - shown.length)} more detail line(s) in the full log`);
    }
    if (failures.length > maxFailures) rendered.push(`… and ${String(failures.length - maxFailures)} more failing test(s) in the full log`);
  }
  if (totals.length > 0) rendered.push(`Totals: ${totals.join(' | ')}`);
  let summary = rendered.join('\n');
  if (summary.length > maxChars) summary = `${summary.slice(0, maxChars)}\n… summary truncated at ${String(maxChars)} characters; every failing test is in the full log`;
  return { failures, totals, summary };
}
