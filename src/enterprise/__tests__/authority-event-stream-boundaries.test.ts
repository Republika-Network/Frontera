import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { AuthorityEventDecisionStatus } from '../authority-event-stream/index.js';
import type { KernelDecisionStatus } from '../../kernel/index.js';

/**
 * §6 / §32 — the event stream cannot authorize, and is never awaited, enforced
 * structurally.
 *
 * Evidence flows one way: authority → events → evidence. These rules make two
 * reverses fail the build the moment someone writes them.
 *
 * 1. **"Read the stream to decide."** No authority-bearing module may import the
 *    stream's store, reader, verifier, projector or health; the one thing
 *    lifecycle modules may name is the write-only recorder, as a type.
 * 2. **"Wait for the evidence."** Every reporting method returns `void`, and no
 *    authority-bearing source may `await` a recorder or observer call. The
 *    earlier contract — a promise awaited inside a `catch` — is gone: catching a
 *    rejection never protected the path from a projection that simply never
 *    settled, and these scans now refuse that shape outright.
 *
 * This is control-flow decoupling. Projection still shares the process and the
 * event loop, so these scans do not — and must not be read to — claim latency or
 * thread isolation (SEC-INV-088).
 */

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === '__tests__' || name === 'tests') continue;
      out.push(...walk(full));
    } else if (full.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

/** Comments stripped: what is forbidden is code, not the prose that explains why. */
function code(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

const STREAM = walk('src/enterprise/authority-event-stream');

/**
 * Every production module that decides, issues, holds, admits, routes, executes
 * or replays authority. None of them may read the stream.
 */
const AUTHORITY_BEARING = [
  ...walk('src/kernel'),
  ...walk('src/features/grant-runtime'),
  ...walk('src/features/execution-runtime'),
  ...walk('src/features/exercise-control-runtime'),
  ...walk('src/features/emergency-control-runtime'),
  ...walk('src/features/obligation-runtime'),
  ...walk('src/features/policy-pack-foundation'),
  ...walk('src/features/context-resolution-runtime'),
  ...walk('src/enterprise/execution-governance'),
  ...walk('src/enterprise/governed-action'),
  ...walk('src/enterprise/bounded-grant-store'),
  ...walk('src/enterprise/exercise-control-ledger'),
  ...walk('src/enterprise/emergency-control'),
  ...walk('src/enterprise/customer-identity'),
  ...walk('src/enterprise/execution-adapters'),
  ...walk('src/enterprise/kernel-authority'),
  ...walk('src/enterprise/governance-store'),
  ...walk('src/enterprise/orchestration'),
];

/** The only modules that may hold the store or the reader, and why. */
const STREAM_HOLDERS = new Set([
  'src/enterprise/composition/composition-root.ts', // opens/selects the store, hands the reader to operators
  'src/enterprise/modules/authority-event-stream-module.ts', // health only
  'src/enterprise/index.ts', // type-only re-exports
]);

/** The one permitted import of the stream from an authority-bearing module: the write-only recorder, as a type. */
const RECORDER_IMPORT = /^import type \{ AuthorityEventRecorder \} from '\.\.\/authority-event-stream\/recorder\.js';$/;

describe('P8 boundaries — §32 the event stream cannot authorize', () => {
  it('measures real sources on both sides', () => {
    assert.ok(STREAM.length >= 9, `stream sources: ${STREAM.length}`);
    assert.ok(AUTHORITY_BEARING.length > 100, `authority-bearing sources: ${AUTHORITY_BEARING.length}`);
  });

  it('no authority-bearing module imports the stream — except the write-only recorder, type-only', () => {
    const recorderImporters: string[] = [];
    for (const file of AUTHORITY_BEARING) {
      for (const line of readFileSync(file, 'utf8').split('\n')) {
        if (!/from '[^']*authority-event-stream/.test(line)) continue;
        assert.match(line.trim(), RECORDER_IMPORT, `${file}: '${line.trim()}' reaches the stream beyond the write-only recorder`);
        recorderImporters.push(file);
      }
    }
    assert.deepEqual(recorderImporters.sort(), ['src/enterprise/execution-governance/service.ts', 'src/enterprise/governed-action/orchestrator.ts'], 'exactly the two documented write boundaries');
  });

  it('the Kernel and every feature runtime know nothing of the stream — not even the recorder', () => {
    for (const file of AUTHORITY_BEARING.filter((path) => path.startsWith('src/kernel/') || path.startsWith('src/features/'))) {
      assert.equal(/authority-event-stream|AuthorityEvent/.test(code(file)), false, file);
    }
  });

  it('no production module outside the stream reads, verifies or holds it, other than the three documented holders', () => {
    const production = walk('src').filter((file) => !file.startsWith('src/enterprise/authority-event-stream/'));
    for (const file of production) {
      const text = code(file);
      const holds = /AuthorityEventStreamStore|AuthorityEventStreamReader|readStream\s*\(|verifyStream\s*\(|verifyAuthorityEventStream|createSqliteAuthorityEventStreamStore|createInMemoryAuthorityEventStreamStore|createAuthorityEventProjector|AuthorityEventProjectionHealth/.test(text);
      if (holds) assert.ok(STREAM_HOLDERS.has(file), `${file} holds or reads the event stream`);
    }
  });

  it('the recorder answers nothing and promises nothing: every method returns void, so durable projection is not awaitable', () => {
    const recorder = code('src/enterprise/authority-event-stream/recorder.ts');
    const methods = [...recorder.matchAll(/^\s+(\w+)\([^)]*\): ([^;]+);$/gm)];
    assert.ok(methods.length >= 6);
    for (const [, name, returned] of methods) assert.equal(returned, 'void', `${name ?? ''} returns ${returned ?? ''}`);
    assert.equal(/Promise<void>/.test(recorder), false, 'no method may hand back a completion promise');
    const observer = code('src/features/exercise-control-runtime/domain/exercise-control-observer.ts');
    assert.match(observer, /reservationObserved\(observation: ExerciseReservationObservation\): void;/);
    assert.equal(/Promise</.test(observer), false);
    // The projector still satisfies the recorder, so `void` is a real contract, not a comment.
    const projector = code('src/enterprise/authority-event-stream/projector.ts');
    assert.match(projector, /export function createAuthorityEventProjector\(options: AuthorityEventProjectorOptions\): AuthorityEventProjector \{/);
    assert.equal(/async (decisionCommitted|grantIssued|grantRevoked|grantExpiryObserved|executionClaimed|executionOutcomeObserved|reservationObserved)\(/.test(projector), false, 'no recorder method is async');
  });

  it('every call site enqueues and moves on: reported as a statement, never awaited, assigned, compared or branched on', () => {
    const orchestrator = code('src/enterprise/governed-action/orchestrator.ts');
    assert.ok([...orchestrator.matchAll(/(?<!await )report\(\(recorder\)/g)].length >= 6, 'the orchestrator still reports every fact');
    assert.equal(/await\s+report\(/.test(orchestrator), false, 'the orchestrator never awaits evidence');
    assert.equal(/(=|return|if\s*\(|\?|&&|\|\|)\s*report\(/.test(orchestrator), false, 'a report result is never used');
    assert.equal(/evidence\.\w+\(/.test(orchestrator.replace(/fact\(evidence\)/, '')), false, 'the recorder is reached only through report()');
    const report = orchestrator.slice(orchestrator.indexOf('function report('), orchestrator.indexOf('function observedExpiry('));
    assert.match(report, /try \{\s*fact\(evidence\);\s*\} catch \{/, 'report is synchronous: build, hand over, return');
    assert.equal(/async function report\(/.test(orchestrator), false);

    const ace = code('src/enterprise/execution-governance/service.ts');
    assert.match(ace, /try \{\s*evidence\.grantRevoked\(outcome\.revocation\);\s*\} catch \{/);
    assert.equal(/await\s+evidence\./.test(ace), false, 'a revocation never waits for its evidence');
    assert.equal([...ace.matchAll(/evidence\.\w+\(/g)].length, 1);

    const gate = code('src/features/exercise-control-runtime/services/exercise-control-gate.ts');
    assert.match(gate, /try \{\s*const built = observation\(\);\s*if \(built !== undefined\) observer\.reservationObserved\(built\);\s*\} catch \{/);
    assert.equal(/await\s+observer\./.test(gate), false, 'the gate never waits for an observation');
    assert.equal(/await\s+observe\(/.test(gate), false);
    assert.equal(/async function observe\(/.test(gate), false, 'observe is synchronous, so admission cannot be held by it');
    assert.equal([...gate.matchAll(/observer\.reservationObserved\(/g)].length, 1, 'reached only through observe()');
    assert.equal(/(=|return|if\s*\()\s*observe\(/.test(gate), false);
  });

  it('no authority-bearing source awaits anything the stream hands back', () => {
    for (const file of AUTHORITY_BEARING) {
      const text = code(file);
      for (const pattern of [/await\s+\w*[Rr]ecorder\./, /await\s+evidence\./, /await\s+observer\./, /await\s+report\(/, /await\s+observe\(/, /await\s+\w+\.reservationObserved\(/]) {
        assert.equal(pattern.test(text), false, `${file}: ${String(pattern)}`);
      }
    }
  });

  it('a revocation is attributed inside its grant\'s intake chain, so a later fact of the same lifecycle cannot overtake it', () => {
    const projector = code('src/enterprise/authority-event-stream/projector.ts');
    assert.match(projector, /function grantIntakeKey\(boundedGrantId: string\): string \{\s*return `intake:grant:\$\{boundedGrantId\}`;/);
    // Every grant-scoped fact is placed through the intake chain…
    assert.match(projector, /const boundedGrantId = input\.references\.boundedGrantId;\s*if \(boundedGrantId === undefined\) \{\s*placeInStream\(input\);\s*return;\s*\}\s*chain\(grantIntakeKey\(boundedGrantId\), async \(\) => \{\s*placeInStream\(input\);/);
    // …and the revocation's attribution read is a step of that same chain.
    const revocation = projector.slice(projector.indexOf('grantRevoked(revocation: GrantRevocation): void {'), projector.indexOf('grantExpiryObserved('));
    assert.match(revocation, /chain\(grantIntakeKey\(grantId\), async \(\) => \{/);
    assert.match(revocation, /const read = await grants\.read\(grantId\);/);
    assert.match(revocation, /if \(input !== undefined\) placeInStream\(input\);/, 'the revocation is placed directly, not re-queued behind the facts it must precede');
    assert.equal(/chain\(`grant:/.test(projector), false, 'no separate per-grant chain outside intake');
  });

  it('the projector owns ordering with a per-key serial chain, and no timer, worker or sweeper', () => {
    const projector = code('src/enterprise/authority-event-stream/projector.ts');
    assert.match(projector, /const tails = new Map<string, Promise<void>>\(\);/);
    assert.match(projector, /const previous = tails\.get\(key\) \?\? Promise\.resolve\(\);/, 'an idle chain still starts on a microtask, so no store work runs on the caller stack');
    assert.match(projector, /const next = previous\.then\(run, run\);/, 'a chain continues past a failed step');
    for (const pattern of [/setTimeout/, /setInterval/, /setImmediate/, /worker_threads/, /queueMicrotask/, /process\.nextTick/]) {
      assert.equal(pattern.test(projector), false, `${String(pattern)} is not the scheduling mechanism`);
    }
    // Sequence, previous digest and recordedAt stay the store's.
    for (const pattern of [/sequence\s*:/, /previousEventDigest\s*:/, /recordedAt\s*:/]) {
      assert.equal(pattern.test(projector), false, `the projector must not choose ${String(pattern)}`);
    }
  });

  it('observations sit after the facts they report: never before the ledger, the claim or the outcome', () => {
    const gate = code('src/features/exercise-control-runtime/services/exercise-control-gate.ts');
    assert.ok(gate.indexOf("if (kind !== 'reserved') return withheld") < gate.indexOf('observe(() => {'), 'reserved is observed only after the ledger said reserved');
    assert.ok(gate.includes('admittedAt: recorded.reservedAt'), "the reserved observation's instant is the ledger's recorded one, never a clock sample");
    assert.equal(/admittedAt:\s*now\(/.test(gate), false);
    const revalidate = gate.slice(gate.indexOf('revalidate(reservation: ExerciseReservationHandle, input: ExerciseControlAdmissionInput): ExerciseControlRevalidation {'), gate.indexOf('async finalize('));
    assert.ok(revalidate.length > 0);
    assert.equal(/observe|observer/.test(revalidate), false, 'nothing is awaited between the last revalidation and the adapter');
    const orchestrator = code('src/enterprise/governed-action/orchestrator.ts');
    const order = [
      'const committed = await committer.commit(',
      'recorder.decisionCommitted(record)',
      'authorization = await issuance.issueFromDecision(',
      'recorder.grantIssued(grant)',
      'claim = await ledger.claim(',
      'recorder.executionClaimed(',
      'outcome = await execution.exercise(exercise)',
      'const outcomeRecorded = await ledger.recordOutcome(',
      'recorder.executionOutcomeObserved(',
    ].map((needle) => orchestrator.indexOf(needle));
    for (const index of order) assert.notEqual(index, -1);
    assert.deepEqual([...order].sort((a, b) => a - b), order);
    const ace = code('src/enterprise/execution-governance/service.ts');
    assert.ok(ace.indexOf('createGrantIssuanceService({ store: grantStore }).revokeGrant(') < ace.indexOf('evidence.grantRevoked('));
  });

  it('the results the orchestrator returns are built from authoritative values only — no recorder, projector or health in a result', () => {
    const orchestrator = code('src/enterprise/governed-action/orchestrator.ts');
    for (const match of orchestrator.matchAll(/return result\(\{([^}]*)\}\)/g)) {
      assert.equal(/evidence|report|recorder|projection|health/.test(match[1] ?? ''), false, match[0]);
    }
  });

  it('the composition root hands the projector to ACE and the orchestrator only — never to a Kernel, an adapter, a store or a policy', () => {
    const root = code('src/enterprise/composition/composition-root.ts');
    const handed = [...root.matchAll(/evidence: authorityEvents/g)].length;
    assert.equal(handed, 2);
    for (const kernel of root.matchAll(/createAocKernel\(\{[\s\S]*?\}\)/g)) assert.equal(kernel[0].includes('authorityEvent'), false);
    for (const registry of root.matchAll(/createExecutionAdapterRegistry\(\{[\s\S]*?\}\)/g)) assert.equal(registry[0].includes('authorityEvent'), false);
  });
});

describe('P8 boundaries — the stream module itself', () => {
  it('imports no Kernel, no adapter, no governed-action, no customer identity, no emergency or exercise-control store', () => {
    for (const file of STREAM) {
      for (const match of readFileSync(file, 'utf8').matchAll(/from '([^']+)'/g)) {
        const specifier = match[1] ?? '';
        assert.equal(/\/kernel\/|execution-adapters|governed-action|customer-identity|emergency-control\/|exercise-control-ledger|kernel-authority|orchestration|\/api\//.test(specifier), false, `${file} imports '${specifier}'`);
      }
    }
  });

  it('the decision status it restates is exactly the Kernel\'s', () => {
    type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
    const agree: Equal<AuthorityEventDecisionStatus, KernelDecisionStatus> = true;
    assert.equal(agree, true);
  });

  it('reads no ambient clock and generates no randomness — recordedAt is the injected store clock, ids are derived', () => {
    for (const file of STREAM) {
      const text = code(file);
      for (const pattern of [/Date\.now\s*\(/, /new\s+Date\s*\(\s*\)/, /performance\.now/, /process\.hrtime/, /randomUUID/, /Math\.random/, /randomBytes/]) {
        assert.equal(pattern.test(text), false, `${file}: ${String(pattern)}`);
      }
    }
  });

  it('has no timer, sweeper, TTL, retention, cleanup or repair', () => {
    for (const file of STREAM) {
      const text = code(file);
      for (const pattern of [/setTimeout\s*\(/, /setInterval\s*\(/, /setImmediate\s*\(/, /\bsweep/i, /\bttl\b/i, /retention/i, /cleanup/i, /\brepair\s*\(/i, /\bpurge/i, /\bcron\b/i]) {
        assert.equal(pattern.test(text), false, `${file}: ${String(pattern)}`);
      }
    }
  });

  it('SQLite: prepared statements only, no interpolated data, and no UPDATE or DELETE of an event anywhere', () => {
    const sqlite = code('src/enterprise/authority-event-stream/sqlite-authority-event-stream-store.ts');
    assert.equal(/\.(prepare|exec)\(`[^`]*\$\{/.test(sqlite), false, 'no template-interpolated SQL');
    assert.equal(/DELETE\s+FROM/i.test(sqlite), false);
    assert.equal(/UPDATE\s+authority_events\s+SET/i.test(sqlite), false);
    assert.ok(/runAppend\.immediate\(input\)/.test(sqlite), 'appends run under BEGIN IMMEDIATE');
    assert.equal(/AUTOINCREMENT[\s\S]*authority_events \(/.test(sqlite.slice(sqlite.indexOf('CREATE TABLE IF NOT EXISTS authority_events'))), false);
  });

  it('is not a bus: no Kafka, NATS, Redis, SSE, WebSocket, webhook, network or HTTP client', () => {
    for (const file of STREAM) {
      const text = code(file);
      for (const pattern of [/kafka/i, /\bnats\b/i, /redis/i, /\bEventSource\b|text\/event-stream/, /WebSocket/, /webhook/i, /node:(http|https|net|dns|tls)/, /\bfetch\s*\(/, /subscribe\s*\(/]) {
        assert.equal(pattern.test(text), false, `${file}: ${String(pattern)}`);
      }
    }
  });
});

describe('P8 boundaries — §23 no public surface was added', () => {
  it('no HTTP route, no frozen-surface entry and no SDK method names the stream', () => {
    const adapter = readFileSync('src/enterprise/adapters/node-http-adapter.ts', 'utf8');
    assert.equal(/\/api\/[a-z/-]*(event|stream|evidence-stream|authority-event)/i.test(adapter.replace(/\/api\/governance\/events/g, '')), false);
    const freeze = JSON.parse(readFileSync('release/api-surface.v1.json', 'utf8')) as { routeLiterals: string[]; routePatterns: string[] };
    assert.equal(JSON.stringify(freeze).match(/authority-event|event-stream|eventStream/i), null);
    const sdk = [readFileSync('packages/enterprise-host-sdk/src/client.ts', 'utf8'), readFileSync('packages/enterprise-host-sdk/src/index.ts', 'utf8')].join('\n');
    assert.equal(/authorityEvent|eventStream|AuthorityEvent|readStream|verifyStream/.test(sdk), false);
  });

  it('the Enterprise barrel exposes the stream as types only — no store, projector, verifier or recorder value', () => {
    const barrel = code('src/enterprise/index.ts');
    for (const value of ['createSqliteAuthorityEventStreamStore', 'createInMemoryAuthorityEventStreamStore', 'createAuthorityEventProjector', 'verifyAuthorityEventStream', 'buildAuthorityEvent', 'deriveAuthorityEventId', 'createAuthorityEventStreamModule']) {
      assert.equal(barrel.includes(value), false, value);
    }
    assert.match(barrel, /export type \{ EnterpriseAuthorityEventStreamOptions \}/);
    const streamExport = /export type \{[^}]*\} from '\.\/authority-event-stream\/index\.js';/.exec(barrel);
    assert.ok(streamExport !== null);
    assert.equal(/^export \{[^}]*\} from '\.\/authority-event-stream/m.test(barrel), false, 'no value re-export');
  });

  it('the public governed-action result and intent gained nothing', () => {
    const contracts = code('src/enterprise/governed-action/contracts.ts');
    assert.equal(/event|stream|evidence|projection/i.test(contracts.slice(contracts.indexOf('export type GovernedActionResult'))), false);
    const intent = code('src/enterprise/governed-action/intent.ts');
    assert.equal(/authorityEvent|eventStream/i.test(intent), false);
  });
});
