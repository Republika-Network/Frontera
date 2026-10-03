import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/**
 * ASSURE-01 — structural boundaries of the Unified Authority-to-Outcome Trace.
 *
 * Measured over the production sources with comments removed, so prose never
 * satisfies or violates a rule. Every detector is first shown to match a real
 * violation.
 */

function codeOf(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .map((line) => line.replace(/^\s*\/\/.*$/, '').replace(/\s\/\/\s.*$/, ''))
    .join('\n');
}
const importsOf = (file: string): readonly string[] => [...codeOf(file).matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)].map((match) => match[1] ?? '');
const valueImportsOf = (file: string): readonly string[] => [...codeOf(file).matchAll(/^import\s+(?!type\b)[^;]*?from\s+['"]([^'"]+)['"]/gm)].map((match) => match[1] ?? '');

const BUILDER = 'src/enterprise/evidence/trace-builder.ts';
const DISCLOSURE = 'src/enterprise/evidence/trace-disclosure.ts';
const CONTRACTS = 'src/enterprise/evidence/trace-contracts.ts';
const SERVICE = 'src/enterprise/evidence/evidence-service.ts';
const STORE = 'src/enterprise/evidence/sqlite-evidence-store.ts';
const ROOT = 'src/enterprise/composition/composition-root.ts';
const ROUTER = 'src/enterprise/adapters/node-http-adapter.ts';
const TRACE = [BUILDER, DISCLOSURE, CONTRACTS];

/** Every authority-, execution- or evidence-mutating call a trace could make. */
const WRITE_CALL =
  /\.(append|appendReference|appendEvaluation|appendLifecycleEvent|issue|issueFromDecision|revoke|revokeGrant|record|recordResolution|recordTerminal|recordAuthorization|recordOutcome|prepareAttempt|bind|bindBeforeClaim|reconcile|adoptResolutionAuthority|execute|exercise|authorize|assess|approve|reject|requestChanges|escalate|reserve|settle|release|activate|claim|transition|provision\w*|store|markVerified|markExported|supersede|governAction|evaluate|enforce)\(/;
/** Modules that hold authority, execution or resolution capability. */
const WRITE_MODULE =
  /execution-ledger|orchestrator|execution-adapters|execution-runtime|execution-governance|execution-reconciliation\/service|approval-authority\/service|obligation-discharge\/recorder|authority-administration|operator-control|kernel-authority\/provisioning|emergency-control\/|bounded-grant-store\/sqlite|composition-root|kernel\/|AocKernel|signer|witness/;

describe('ASSURE-01 structure — the trace is a projection: no write path into any authority', () => {
  it('the detectors match real violations and not mentions', () => {
    assert.equal(WRITE_CALL.test('await store.append(row)'), true);
    assert.equal(WRITE_CALL.test('await grants.revoke({ grantId })'), true);
    assert.equal(WRITE_CALL.test('await service.reconcile(request)'), true);
    assert.equal(WRITE_CALL.test('await adapter.execute(action)'), true);
    assert.equal(WRITE_CALL.test('await sources.grants.read(grantId)'), false);
    assert.equal(WRITE_MODULE.test('../governed-action/execution-ledger.js'), true);
    assert.equal(WRITE_MODULE.test('../governed-action/identifiers.js'), false);
  });

  it('no trace module calls a write method or imports a module holding authority, execution or resolution capability', () => {
    for (const file of TRACE) {
      assert.equal(WRITE_CALL.test(codeOf(file)), false, `${file} makes a write call: ${String(WRITE_CALL.exec(codeOf(file))?.[0])}`);
      for (const specifier of importsOf(file)) assert.equal(WRITE_MODULE.test(specifier), false, `${file} imports '${specifier}'`);
    }
  });

  it('the builder’s value imports are exactly the pure identity derivations, the digest, and its own contracts', () => {
    assert.deepEqual([...valueImportsOf(BUILDER)].sort(), [
      '../../features/exercise-control-runtime/index.js',
      '../authority-event-stream/identifiers.js',
      '../governance-store/digest.js',
      '../governed-action/identifiers.js',
      './errors.js',
      './trace-contracts.js',
    ]);
    // From the exercise-control runtime it takes the reservation id derivation only.
    assert.match(codeOf(BUILDER), /import \{ exerciseReservationId, type ExerciseReservationView \} from '\.\.\/\.\.\/features\/exercise-control-runtime\/index\.js';/);
  });

  it('every source the builder is handed is a read: its port type names read methods only', () => {
    const block = /export interface AuthorityTraceSources \{([\s\S]*?)\n\}/.exec(codeOf(BUILDER))?.[1] ?? '';
    assert.ok(block.length > 0);
    const methods = [...block.matchAll(/(\w+)\(/g)].map((match) => match[1]).sort();
    assert.deepEqual([...new Set(methods)], ['getByRequestId', 'read', 'readStream', 'verify', 'verifyStream']);
  });

  it('the composition hands the trace one read per store — never a writer, signer, reconciler, approval command or adapter', () => {
    const root = codeOf(ROOT);
    const block = /const traceSources: AuthorityTraceSources = \{([\s\S]*?)\n {2}\};/.exec(root)?.[1] ?? '';
    assert.ok(block.length > 0, 'the trace sources block exists');
    const calls = [...block.matchAll(/=> (\w+)\.(\w+)\(/g)].map((match) => `${match[1]}.${match[2]}`).sort();
    assert.deepEqual(calls, [
      'approvalStore.read',
      'authorityEventStore.readStream',
      'authorityEventStore.verifyStream',
      'executionOutcomeStore.read',
      'executionResolutionStore.read',
      'exerciseLedger.read',
      'grantStore.read',
      'obligationDischargeStore.read',
      'persistence.getByRequestId',
      'persistence.verify',
    ]);
    assert.equal(WRITE_CALL.test(block), false);
  });

  it('fetching and verifying a trace writes nothing — not even the evidence store’s own lifecycle', () => {
    const service = codeOf(SERVICE);
    for (const method of ['getTrace', 'verifyTrace']) {
      const body = new RegExp(`async ${method}\\([^)]*\\) \\{([\\s\\S]*?)\\n {4}\\},`).exec(service)?.[1] ?? '';
      assert.ok(body.length > 0, method);
      assert.equal(/evidenceStore\.|governanceStore\./.test(body), false, `${method} touches no store directly`);
      assert.equal(WRITE_CALL.test(body), false, `${method} makes no write call`);
    }
  });
});

describe('ASSURE-01 structure — action neutrality and bounds', () => {
  const DOMAIN = /xrpl|lightning|invoice|payment|stripe|wallet|kubernetes|treasury|\bx402\b|\bmpp\b|rlusd|bitcoin|\biban\b|swift|payables|deploy|replica/i;

  it('the trace contract, builder and disclosure carry no rail, payment or domain vocabulary', () => {
    assert.equal(DOMAIN.test('readonly invoiceTotal: string'), true);
    for (const file of [...TRACE, STORE]) assert.equal(DOMAIN.test(codeOf(file)), false, `${file}: ${String(DOMAIN.exec(codeOf(file))?.[0])}`);
  });

  it('every trace bound exists and every store list carries a LIMIT; there is no route that lists traces', () => {
    assert.match(codeOf(CONTRACTS), /maxEvents: 256,\s*maxGrants: 16,\s*maxApprovalRecords: 256,\s*maxObligationDischarges: 256,/);
    const store = codeOf(STORE);
    const selects = [...store.matchAll(/SELECT \$\{COLUMNS\} FROM evidence_bundles WHERE \$\{column\} = \? ORDER BY sequence DESC LIMIT \$\{EVIDENCE_STORE_LIST_LIMIT\}/g)];
    assert.equal(selects.length, 1, 'the one parameterized list query is bounded');
    const router = codeOf(ROUTER);
    const tracePatterns = [...router.matchAll(/\/(\^\\\/api\\\/evidence\\\/traces[^/]*?(?:\/[^/]+?)*?)\/\.exec/g)].map((match) => match[1]);
    assert.deepEqual(tracePatterns.sort(), ['^\\/api\\/evidence\\/traces\\/([^/]+)$', '^\\/api\\/evidence\\/traces\\/([^/]+)\\/verify$']);
    const surface = JSON.parse(readFileSync('release/api-surface.v1.json', 'utf8')) as { routePatterns: string[] };
    assert.deepEqual(surface.routePatterns.filter((pattern) => pattern.includes('evidence')).sort(), [
      '^\\/api\\/admin\\/evidence\\/decisions\\/([^/]+)$',
      '^\\/api\\/evidence\\/([^/]+)$',
      '^\\/api\\/evidence\\/traces\\/([^/]+)$',
      '^\\/api\\/evidence\\/traces\\/([^/]+)\\/verify$',
    ]);
  });

  it('the lookup identity is closed to the governed request format', () => {
    assert.match(codeOf(CONTRACTS), /export const GOVERNED_REQUEST_ID_PATTERN = \/\^aoc\\\.gar:\[0-9a-f\]\{32\}\$\/;/);
  });
});

describe('ASSURE-01 structure — durability on the secure Host', () => {
  it('a sqlite deployment composes the durable store; the secure profile refuses anything else', () => {
    const root = codeOf(ROOT);
    assert.match(root, /configuration\.persistence\.provider === 'sqlite'\s*\?\s*await createSqliteEvidenceStore\(configuration\.evidence\.sqlitePath/);
    assert.match(root, /evidenceStore: evidenceStore\.providerKind === 'sqlite' \? 'durable' : 'ephemeral',/);
    assert.match(codeOf('src/enterprise/host/enterprise-host.ts'), /evidenceStore: 'durable',/);
  });

  it('the store is classified by the PROD-02 registry, required whenever the deployment is durable', async () => {
    const registry = (await import(`${process.cwd()}/scripts/portability/store-registry.mjs`)) as { STORE_DEFINITIONS: readonly { name: string; envVar: string; condition: string }[]; EXCLUDED_DURABLE_STATE: readonly { name: string }[] };
    const entry = registry.STORE_DEFINITIONS.find((storeDef) => storeDef.name === 'evidence-bundles');
    assert.deepEqual([entry?.envVar, entry?.condition], ['AOC_ENTERPRISE_EVIDENCE_SQLITE_PATH', 'always']);
    assert.equal(registry.EXCLUDED_DURABLE_STATE.some((excluded) => excluded.name === 'evidence-bundle-store'), false, 'no longer excused as in-memory');
  });
});
