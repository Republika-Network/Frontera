import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

/**
 * P12 — execution reconciliation, enforced structurally:
 *
 * 1. **Reconciliation is not execution** (§146): no P12 module holds or reaches
 *    an execution adapter, the exercise gate or the execution service.
 * 2. **Resolution authority is not Kernel authority** (§147, §77): no Kernel,
 *    grant issuance, policy pack, bounded-grant writer or authority graph.
 * 3. **P8 is never read** (§148): only the write-only recorder type.
 * 4. **Customer replay cannot query an authority** (§48, §145): the
 *    orchestrator holds a binder and a reader — never an authority, a `resolve`
 *    call or the reconciliation service.
 * 5. **The narrow P7 capability** (§58): the gate cannot record a resolution;
 *    P12 cannot reserve, settle or release.
 * 6. **Scope** (§12, §42, §81, §101, §160, §161): no timer, poll, retry,
 *    provider-specific code, providerRef dereference, settlement, receipts or
 *    floating money.
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

function importsOf(file: string): readonly string[] {
  return [...readFileSync(file, 'utf8').matchAll(/from '([^']+)'/g)].map((match) => match[1] ?? '');
}

const RECONCILIATION = walk('src/enterprise/execution-reconciliation');
const STORE = walk('src/enterprise/execution-resolution-store');
const P12_SOURCES = [
  ...RECONCILIATION,
  ...STORE,
  'src/enterprise/modules/execution-resolution-module.ts',
  'src/features/exercise-control-runtime/domain/exercise-reservation-resolution.ts',
];

describe('P12 boundaries — there are real sources to measure', () => {
  it('the reconciliation layer and the store exist', () => {
    assert.ok(RECONCILIATION.length >= 5, RECONCILIATION.join(','));
    assert.ok(STORE.length >= 7, STORE.join(','));
  });
});

describe('P12 boundaries — §146 reconciliation is not execution', () => {
  it('no P12 module calls or reaches an execution adapter, the exercise gate or the execution service', () => {
    for (const file of P12_SOURCES) {
      const text = code(file);
      for (const forbidden of [/executionAdapter\.execute\(/, /childAdapter\.execute\(/, /execution\.exercise\(/, /\.execute\(/, /\.exercise\(/, /\bExecutionAdapter\b/, /assessExercise/, /createGrantExecutionService|GrantExecutionService/, /AuthorityControlledExecutionService/, /\.reserve\(/, /\.settle\(/, /\.release\(/]) {
        assert.equal(forbidden.test(text), false, `${file}: ${String(forbidden)}`);
      }
      for (const specifier of importsOf(file)) {
        for (const reach of ['execution-adapters', 'execution-governance', 'execution-runtime/services', 'grant-execution', 'adapters/']) assert.equal(specifier.includes(reach), false, `${file} imports ${specifier}`);
      }
    }
  });
});

describe('P12 boundaries — §147 / §77 resolution authority is not Kernel authority', () => {
  it('no Kernel, grant issuance, policy pack, bounded-grant writer, authority graph or financial authority', () => {
    for (const file of P12_SOURCES) {
      const text = readFileSync(file, 'utf8');
      for (const specifier of importsOf(file)) {
        for (const reach of ['kernel', 'grant-runtime', 'bounded-grant-store', 'kernel-authority', 'policy', 'authority-governance', 'customer-identity', 'emergency-control']) {
          assert.equal(specifier.includes(reach), false, `${file} imports ${specifier}`);
        }
      }
      for (const forbidden of [/Kernel\.evaluate|\.evaluate\(/, /issueFromDecision|issueGrant|revokeGrant/, /BoundedGrantStore/, /PolicyPack/]) assert.equal(forbidden.test(code(file)), false, `${file}: ${String(forbidden)}`);
      void text;
    }
  });

  it('the authority answer has no field through which spending authority could come back', () => {
    const authority = code('src/enterprise/execution-reconciliation/authority.ts');
    const union = authority.slice(authority.indexOf('export type ExecutionResolutionAuthorityResult'), authority.indexOf('export interface ExecutionResolutionSelectionContext'));
    assert.ok(union.length > 0);
    for (const word of ['amount', 'asset', 'currency', 'grant', 'budget', 'ceiling', 'decision', 'allowed', 'authorized', 'confidence', 'probab', 'score', 'likelihood']) assert.equal(union.toLowerCase().includes(word), false, word);
  });

  it('the resolution record has no amount, asset, grant, budget or settlement field', () => {
    const contracts = code('src/enterprise/execution-resolution-store/contracts.ts');
    const record = contracts.slice(contracts.indexOf('export interface RecordExecutionResolutionInput'), contracts.indexOf('export interface ExecutionResolutionRecord'));
    const fields = [...record.matchAll(/^ {2}readonly (\w+)\??:/gm)].map((match) => match[1]);
    assert.deepEqual(fields.sort(), ['attemptDigest', 'authorityId', 'basisObservationDigest', 'bindingDigest', 'certainty', 'executionId', 'failure', 'organizationId', 'providerRef', 'resolvedAt'].sort());
  });
});

describe('P12 boundaries — §148 P8 is evidence only', () => {
  it('no P12 module imports a P8 reader, store or projector — only the write-only recorder type', () => {
    for (const file of P12_SOURCES) {
      for (const specifier of importsOf(file).filter((entry) => entry.includes('authority-event-stream'))) {
        assert.equal(specifier, '../authority-event-stream/recorder.js', `${file} imports ${specifier}`);
        assert.match(readFileSync(file, 'utf8'), /import type \{ ExecutionResolutionEvidenceRecorder \} from '\.\.\/authority-event-stream\/recorder\.js'/);
      }
      assert.equal(/readStream|verifyStream|AuthorityEventStreamReader|AuthorityEventStreamStore/.test(code(file)), false, file);
    }
  });

  it('evidence comes after the canonical resolution and the P7 row, and never decides', () => {
    const service = code('src/enterprise/execution-reconciliation/service.ts');
    const record = service.indexOf('await resolutions.recordResolution(');
    const finish = service.indexOf('async function finish(');
    const capacity = service.indexOf('const adjusted = await applyCapacity(', finish);
    const p8 = service.indexOf('recorder.executionOutcomeResolved(', finish);
    const governance = service.indexOf('await governanceEvidence(', finish);
    for (const index of [record, finish, capacity, p8, governance]) assert.notEqual(index, -1);
    assert.ok(capacity < p8 && p8 < governance, 'P7, then P8, then Governance');
    assert.ok(service.indexOf('return finish(', record) > record, 'finish runs only after the resolution append');
  });
});

describe('P12 boundaries — §48 / §145 customer replay can read a resolution and never ask for one', () => {
  const orchestrator = code('src/enterprise/governed-action/orchestrator.ts');

  it('the orchestrator holds a binder and a reader — no authority, no resolve, no reconciliation service', () => {
    for (const forbidden of [/\.resolve\(/, /ExecutionResolutionAuthority\b/, /ExecutionReconciliationService/, /reconcile\(/, /recordResolution/, /adoptResolutionAuthority/]) {
      assert.equal(forbidden.test(orchestrator), false, String(forbidden));
    }
    for (const line of readFileSync('src/enterprise/governed-action/orchestrator.ts', 'utf8').split('\n').filter((entry) => /execution-resolution-store\/|execution-reconciliation\//.test(entry))) {
      assert.match(line, /^import type /, line);
    }
  });

  it('the only resolution read is inside replayExecution, after the claim said the identity was attempted', () => {
    const reads = [...orchestrator.matchAll(/executionResolution\.reader\.read\(/g)];
    assert.equal(reads.length, 1);
    const start = orchestrator.indexOf('async function replayExecution(');
    const end = orchestrator.indexOf('function observedExpiry(');
    assert.ok((reads[0]?.index ?? -1) > start && (reads[0]?.index ?? -1) < end);
  });

  it('the binding happens after P11 preparation and before the write-ahead claim', () => {
    const order = ['await executionOutcomes.prepareAttempt(', 'executionResolution.binder.bindBeforeClaim(', 'claim = await ledger.claim(', 'outcome = await execution.exercise(exercise)'].map((needle) => orchestrator.indexOf(needle));
    for (const index of order) assert.notEqual(index, -1);
    assert.deepEqual([...order].sort((a, b) => a - b), order);
  });

  it('the composition root hands the orchestrator a binder and a reader — never the service or an authority', () => {
    const root = code('src/enterprise/composition/composition-root.ts');
    const orchestratorBlock = root.slice(root.indexOf('governedActionOrchestrator = createGovernedActionOrchestrator({'), root.indexOf('const exerciseReconciliation ='));
    assert.ok(orchestratorBlock.length > 0);
    assert.equal(/executionReconciliation\b|createExecutionReconciliationService|resolutionAuthorities\.authorities/.test(orchestratorBlock.replace(/composition: resolutionAuthorities/, '')), false);
    for (const construct of root.matchAll(/createAuthorityControlledExecution\(\{[\s\S]*?\}\)|createExecutionAdapterRegistry\(\{[\s\S]*?\}\)|createAocKernel\(\{[\s\S]*?\}\)/g)) {
      assert.equal(/executionResolution|resolutionAuthorit|executionReconciliation/.test(construct[0]), false);
    }
  });
});

describe('P12 boundaries — §58 the narrow P7 capability', () => {
  it('the exercise gate cannot record a resolution, and ExerciseControlLedgerPort has no such method', () => {
    const gate = code('src/features/exercise-control-runtime/services/exercise-control-gate.ts');
    assert.equal(/reconcileResolution|ExerciseControlReconciliationPort/.test(gate), false);
    const port = code('src/features/exercise-control-runtime/domain/exercise-control-ledger-port.ts');
    const ledgerPort = port.slice(port.indexOf('export interface ExerciseControlLedgerPort'));
    assert.equal(ledgerPort.includes('reconcileResolution'), false);
  });

  it('the composition root hands P12 a fresh one-method P7 object, and no adapter or policy receives it', () => {
    const root = code('src/enterprise/composition/composition-root.ts');
    assert.match(root, /return Object\.freeze\(\{ reconcileResolution: \(input[^)]*\) => reconcileResolution\(input\) \}\);/);
    for (const construct of root.matchAll(/createExecutionAdapterRegistry\(\{[\s\S]*?\}\)|exerciseControls: \{[\s\S]*?\}/g)) assert.equal(construct[0].includes('exerciseReconciliation'), false);
  });

  it('the P7 resolution row names a resolution digest, and only the reconciliation service writes one', () => {
    const holders = walk('src').filter((file) => /\.reconcileResolution\(/.test(code(file)));
    assert.deepEqual(holders.map((file) => file.split('\\').join('/')), ['src/enterprise/execution-reconciliation/service.ts']);
    const domain = code('src/features/exercise-control-runtime/domain/exercise-reservation-resolution.ts');
    assert.match(domain, /readonly resolutionDigest: string;/);
  });
});

describe('P12 boundaries — who may hold the resolution store', () => {
  const HOLDERS = new Set([
    'src/enterprise/composition/composition-root.ts',
    'src/enterprise/governed-action/orchestrator.ts',
    'src/enterprise/modules/execution-resolution-module.ts',
    'src/enterprise/execution-reconciliation/binder.ts',
    'src/enterprise/execution-reconciliation/service.ts',
    'src/enterprise/execution-reconciliation/authority.ts',
    'src/enterprise/execution-reconciliation/contracts.ts',
    'src/enterprise/index.ts',
  ]);

  it('no other production module imports it — no Kernel, grant, P7, emergency, P8, identity or adapter module', () => {
    for (const file of walk('src')) {
      if (file.startsWith(join('src', 'enterprise', 'execution-resolution-store'))) continue;
      if (!readFileSync(file, 'utf8').includes('execution-resolution-store/')) continue;
      assert.ok(HOLDERS.has(file.split('\\').join('/')), `${file} may not reach the execution resolution store`);
    }
  });

  it('the store imports only primitives: P11 validation, the Governance canonicalization and digest, and the provider-neutral vocabulary', () => {
    const allowed = new Set([
      '../../features/execution-runtime/index.js',
      '../execution-outcome-store/validation.js',
      '../governance-store/canonical-json.js',
      '../governance-store/digest.js',
      '../governance-store/store-common.js',
      'node:fs',
      'node:path',
    ]);
    for (const file of STORE) {
      for (const specifier of importsOf(file)) assert.ok(specifier.startsWith('./') || allowed.has(specifier), `${file} imports ${specifier}`);
    }
  });

  it('its port can bind, record and read — nothing that updates, deletes, unbinds, repairs or retries', () => {
    const port = code('src/enterprise/execution-resolution-store/resolution-store.ts');
    const interfaces = [...port.matchAll(/export interface \w+[^{]*\{([\s\S]*?)\n\}/g)].map((match) => match[1] ?? '').join('\n');
    const members = [...interfaces.matchAll(/^\s+(\w+)\(/gm)].map((match) => match[1]);
    assert.deepEqual([...new Set(members.filter((name) => name !== undefined))].sort(), ['bind', 'close', 'health', 'read', 'recordResolution'].sort());
    for (const file of STORE) {
      for (const forbidden of [/\bUPDATE\s+execution_/, /\bDELETE\s+FROM\s+execution_/, /\bunbind/i, /\brepair\w*\(/, /\bretry/i]) assert.equal(forbidden.test(code(file)), false, `${file}: ${String(forbidden)}`);
    }
  });

  it('the P11 store stays untouched by P12: no new table, column or writer', () => {
    const p11 = code('src/enterprise/execution-outcome-store/sqlite-execution-outcome-store.ts');
    for (const word of ['resolution', 'binding', 'authority_id']) assert.equal(p11.includes(word), false, word);
  });
});

describe('P12 boundaries — §12 / §42 / §81 / §101 / §160 / §161 scope', () => {
  it('no timer, poll, background job, original-effect retry, providerRef dereference, rail-specific code, settlement or receipt semantics', () => {
    for (const file of P12_SOURCES) {
      const text = code(file);
      for (const forbidden of [
        /setInterval|setTimeout|setImmediate|cron/i,
        /\bpoll/i,
        /\bretry\w*\(|resubmit/i,
        /\bfetch\s*\(|node:https?|node:net|new URL\(|XMLHttpRequest/,
        /statusPath|lookupTemplate|reconciliationUrl/i,
        /stripe|paymentintent|xrpl|stellar|\bmpp\b|ledger_index|txhash|wallet/i,
        /settlement_status|receipt|\bfinality\b|funds_available|\bcleared\b/i,
        /Date\.now\(|new Date\(\)/,
      ]) {
        assert.equal(forbidden.test(text), false, `${file}: ${String(forbidden)}`);
      }
    }
  });

  it('no monetary value passes through a JavaScript number in P12 code', () => {
    for (const file of P12_SOURCES) {
      const text = code(file);
      for (const forbidden of [/\bNumber\(/, /parseFloat\(/, /parseInt\(/, /\.toFixed\(/, /Math\.(round|floor|ceil)\(/]) assert.equal(forbidden.test(text), false, `${file}: ${String(forbidden)}`);
    }
  });

  it('no public route, SDK method or wire status is added for reconciliation', () => {
    for (const file of [...walk('src/enterprise/api'), ...walk('src/enterprise/host'), ...walk('packages').filter((file) => !file.includes('node_modules'))]) {
      assert.equal(/reconcil|executionResolution|resolutionAuthorit/i.test(code(file)), false, file);
    }
  });
});
