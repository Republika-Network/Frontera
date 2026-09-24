import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

/**
 * P13 — MPP challenge adaptation and business-level idempotency, enforced
 * structurally:
 *
 * 1. **A machine payment is a governed action** (§2, §95, §162–§165): the
 *    Kernel, P10 authority, P7, P11, P12, P8 and the orchestrator never reach
 *    P13; P13 reaches the governed-action path only through `govern()`.
 * 2. **An ingress transformation, not an effect path** (§178, §221): no P13
 *    module holds an execution adapter, a grant store, a P7 ledger, a P11/P12
 *    writer or a Kernel.
 * 3. **No P14** (§8, §47, §48, §126): no credential construction, no Stripe, no
 *    EVM, no XRPL, no wallet, no signature, no secret.
 * 4. **No network, no retry, no outcome** (§10, §124, §125, §212).
 * 5. **Exact money** (§138): no JavaScript number carries money in P13 code.
 * 6. **The adapter boundary is not widened** (§82, §83).
 * 7. **No public surface** (§90, §91).
 */

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === '__tests__' || name === 'tests' || name === 'fixtures') continue;
      out.push(...walk(full));
    } else if (full.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

const normalize = (file: string): string => file.split('\\').join('/');

/** Comments stripped: what is forbidden is code, not the prose that explains why. */
function code(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

function importsOf(file: string): readonly string[] {
  return [...readFileSync(file, 'utf8').matchAll(/from '([^']+)'/g)].map((match) => match[1] ?? '');
}

const CHALLENGE = walk('src/enterprise/mpp-challenge');
const STORE = walk('src/enterprise/mpp-business-operation-store');
const P13_SOURCES = [...CHALLENGE, ...STORE, 'src/enterprise/modules/mpp-business-operation-module.ts'];

describe('P13 boundaries — there are real sources to measure', () => {
  it('the challenge layer and the store exist', () => {
    assert.ok(CHALLENGE.length >= 7, CHALLENGE.join(','));
    assert.ok(STORE.length >= 8, STORE.join(','));
  });

  it('the comment stripper keeps code and drops prose, so the scans below are not vacuous', () => {
    assert.match(code('src/enterprise/mpp-challenge/service.ts'), /orchestrator\.govern\(/);
    assert.doesNotMatch(code('src/enterprise/mpp-challenge/service.ts'), /No network I\/O, no credential/);
  });
});

describe('P13 boundaries — §95 / §162–§165 nothing below the governed-action boundary knows MPP', () => {
  it('the Kernel has no MPP, challenge or business-operation vocabulary', () => {
    for (const file of walk('src/kernel')) {
      const text = code(file);
      assert.equal(/\bmpp|www-authenticate|payment challenge|businessOperation|mpp-challenge|mpp-business-operation/i.test(text), false, file);
    }
  });

  it('only the composition root, the P13 modules and the type-only index may import P13', () => {
    const allowed = new Set(['src/enterprise/composition/composition-root.ts', 'src/enterprise/index.ts', 'src/enterprise/modules/mpp-business-operation-module.ts']);
    for (const file of walk('src')) {
      const path = normalize(file);
      if (path.startsWith('src/enterprise/mpp-challenge/') || path.startsWith('src/enterprise/mpp-business-operation-store/')) continue;
      const reaches = importsOf(file).some((specifier) => /mpp-challenge\/|mpp-business-operation-store\/|mpp-business-operation-module/.test(specifier));
      if (reaches) assert.ok(allowed.has(path), `${path} may not reach P13`);
    }
    for (const line of readFileSync('src/enterprise/index.ts', 'utf8').split('\n').filter((entry) => /mpp-challenge\/|mpp-business-operation-store\//.test(entry))) {
      assert.match(line, /^(export type|} from)/, `the enterprise entrypoint exports P13 types only: ${line}`);
    }
  });

  it('the orchestrator, P10 authority, P7, P11, P12 and P8 are unaware of MPP', () => {
    for (const root of ['src/enterprise/governed-action', 'src/enterprise/execution-governance', 'src/enterprise/exercise-control-ledger', 'src/enterprise/execution-outcome-store', 'src/enterprise/execution-resolution-store', 'src/enterprise/execution-reconciliation', 'src/enterprise/authority-event-stream', 'src/features']) {
      for (const file of walk(root)) {
        const text = code(file);
        // The one exception is the reserved asserted-context vocabulary, which refuses P13 words.
        const withoutReserved = normalize(file) === 'src/enterprise/governed-action/intent.ts' ? text.replace(/GOVERNED_ACTION_RESERVED_CONTEXT_KEYS[\s\S]*?\];/, '') : text;
        assert.equal(/\bmpp|businessOperation|paymentChallenge|mpp-challenge|mpp-business-operation/i.test(withoutReserved), false, file);
      }
    }
  });
});

describe('P13 boundaries — §178 / §221 an ingress transformation, never a new effect path', () => {
  it('no P13 module holds an execution adapter, exercise gate, grant store, P7 ledger, P11/P12 writer, Kernel or P8', () => {
    for (const file of P13_SOURCES) {
      const text = code(file);
      for (const forbidden of [/\.execute\(/, /\.exercise\(/, /assessExercise/, /\bExecutionAdapter\b/, /issueFromDecision|issueGrant|revokeGrant/, /\.reserve\(|\.settle\(|\.release\(/, /prepareAttempt|recordTerminal|recordResolution|bindBeforeClaim|reconcile\(/, /Kernel\.evaluate|\.evaluate\(/]) {
        assert.equal(forbidden.test(text), false, `${file}: ${String(forbidden)}`);
      }
      for (const specifier of importsOf(file)) {
        assert.equal(/(^|\/)kernel\//.test(specifier), false, `${file} imports the Kernel: ${specifier}`);
        for (const reach of ['grant-runtime', 'bounded-grant-store', 'exercise-control', 'execution-runtime', 'execution-governance', 'execution-adapters', 'execution-resolution-store', 'execution-reconciliation', 'authority-event-stream', 'kernel-authority', 'policy', 'emergency-control', 'stripe', 'xrpl', 'viem', 'mppx']) {
          assert.equal(specifier.includes(reach), false, `${file} imports ${specifier}`);
        }
      }
    }
  });

  it('the service reaches the spine only through orchestrator.govern(), once, after the durable record', () => {
    const service = code('src/enterprise/mpp-challenge/service.ts');
    const record = service.indexOf('await store.record(');
    const govern = service.indexOf('await orchestrator.govern(');
    assert.ok(record !== -1 && govern !== -1 && record < govern, 'the business operation is durable before governance');
    assert.equal([...service.matchAll(/orchestrator\.govern\(/g)].length, 1);
    assert.equal(/assertedContext/.test(service), false, 'no challenge data rides in asserted context');
    const imports = importsOf('src/enterprise/mpp-challenge/service.ts');
    assert.ok(imports.every((specifier) => specifier.startsWith('./') || /customer-identity|governed-action\/(contracts|intent|kernel-request|orchestrator)|mpp-business-operation-store\/(contracts|errors|operation-store)/.test(specifier)), imports.join(','));
    for (const line of readFileSync('src/enterprise/mpp-challenge/service.ts', 'utf8').split('\n').filter((entry) => /governed-action\/orchestrator/.test(entry))) assert.match(line, /^import type /);
  });

  it('the composition root hands the service govern, a record-only writer, the snapshot and P9 — never a store handle, adapter or Kernel', () => {
    const root = code('src/enterprise/composition/composition-root.ts');
    const block = root.slice(root.indexOf('createMppChallengePaymentService({'), root.indexOf('const mppChallengeContexts'));
    assert.ok(block.length > 0);
    assert.match(block, /store: \{ record: \(context, input\) => mppBusinessOperationStore\.record\(context, input\) \}/);
    assert.equal(/executionAdapter|kernel\b|grantStore|exerciseLedger|executionOutcomeStore|executionResolutionStore/.test(block), false);
    for (const construct of root.matchAll(/createAuthorityControlledExecution\(\{[\s\S]*?\}\)|createExecutionAdapterRegistry\(\{[\s\S]*?\}\)|createAocKernel\(\{[\s\S]*?\}\)|governedActionOrchestrator = createGovernedActionOrchestrator\(\{[\s\S]*?\n {4}\}\);/g)) {
      assert.equal(/mpp/i.test(construct[0]), false, 'no MPP value reaches the Kernel, ACE, the registry or the orchestrator');
    }
  });
});

describe('P13 boundaries — §82 / §83 / §152 the adapter boundary is not widened', () => {
  it('ValidatedExecutionAction declares exactly its pre-P13 fields', () => {
    const port = code('src/features/execution-runtime/domain/execution-adapter-port.ts');
    const body = port.slice(port.indexOf('export interface ValidatedExecutionAction'), port.indexOf('export interface ValidatedExecutionCorrelation'));
    const fields = [...body.matchAll(/^ {2}readonly (\w+)\??:/gm)].map((match) => match[1]);
    assert.deepEqual(fields.sort(), ['action', 'amount', 'boundedGrantId', 'correlation', 'counterparty', 'notAfter', 'organization', 'resource', 'subject'].sort());
  });

  it('the MPP method is never an adapter routing input', () => {
    for (const file of [...walk('src/enterprise/execution-adapters'), ...walk('src/features/execution-runtime')]) assert.equal(/\bmpp|challenge\.method/i.test(code(file)), false, file);
  });
});

describe('P13 boundaries — §8 / §47 / §48 / §126 / §127 no P14: no credential, no rail, no secret', () => {
  it('no Stripe, EVM, XRPL, wallet, key, seed or signature in P13 code', () => {
    for (const file of P13_SOURCES) {
      const text = code(file);
      for (const forbidden of [/stripe|paymentintent|\bspt\b/i, /permit2|eip-?3009|chainId|viem|ethers|web3/i, /xrpl|stellar|solana/i, /wallet|privateKey|secretKey|seed|mnemonic|signature/i, /createHmac|createSign|\.sign\(|sodium|secp256/]) {
        assert.equal(forbidden.test(text), false, `${file}: ${String(forbidden)}`);
      }
    }
  });

  it('no Payment credential is ever constructed — "credential" appears only as the header-placement helper', () => {
    for (const file of P13_SOURCES) {
      const text = code(file);
      const mentions = text.match(/\w*credential\w*/gi) ?? [];
      for (const mention of mentions) assert.ok(['mppCredentialHeaderField', 'credentialHeaderField'].includes(mention), `${file}: ${mention}`);
      assert.equal(/Authorization:\s*Payment|['"`]Payment ['"`]\s*\+|`Payment \$\{|payload:/i.test(text), false, file);
    }
  });

  it('no Frontera customer Authorization value is read or persisted by P13', () => {
    for (const file of P13_SOURCES) assert.equal(/authorizationHeader|apiKey|bearer/i.test(code(file)), false, file);
  });
});

describe('P13 boundaries — §10 / §124 / §125 / §212 no network, no retry, no outcome', () => {
  it('no network client, timer, poll or retry in P13 code', () => {
    for (const file of P13_SOURCES) {
      const text = code(file);
      for (const forbidden of [/\bfetch\s*\(|node:https?|node:net|node:tls|undici|axios|XMLHttpRequest|http\.request|https\.request/, /setInterval|setTimeout|setImmediate|\bpoll/i, /\bretry|resubmit/i]) {
        assert.equal(forbidden.test(text), false, `${file}: ${String(forbidden)}`);
      }
    }
  });

  it('no receipt, settlement, refund or outcome state in P13 code', () => {
    for (const file of P13_SOURCES) assert.equal(/receipt|settle|refund|chargeback|finality|'paid'|status:\s*'(pending|paid|failed)'/i.test(code(file)), false, file);
  });

  it('P13 core reads no ambient clock', () => {
    for (const file of P13_SOURCES) assert.equal(/Date\.now\(|new Date\(\)/.test(code(file)), false, file);
  });
});

describe('P13 boundaries — §138 no monetary value passes through a JavaScript number', () => {
  it('no Number(), parseFloat, parseInt, toFixed or Math rounding in P13 code', () => {
    for (const file of P13_SOURCES) {
      const text = code(file);
      for (const forbidden of [/\bNumber\(/, /parseFloat\(/, /parseInt\(/, /\.toFixed\(/, /Math\.(round|floor|ceil)\(/]) assert.equal(forbidden.test(text), false, `${file}: ${String(forbidden)}`);
    }
  });

  it('money is stored as text', () => {
    const sqlite = code('src/enterprise/mpp-business-operation-store/sqlite-mpp-business-operation-store.ts');
    assert.match(sqlite, /amount_value TEXT NOT NULL/);
    assert.match(sqlite, /amount_unit TEXT NOT NULL/);
  });
});

describe('P13 boundaries — §16 / §20 / §32 / §86 identity derivations', () => {
  const identity = code('src/enterprise/mpp-challenge/business-identity.ts');

  it('the request id is the orchestrator derivation, imported — never re-implemented', () => {
    assert.match(readFileSync('src/enterprise/mpp-challenge/business-identity.ts', 'utf8'), /import \{ deriveGovernedActionRequestId \} from '\.\.\/governed-action\/identifiers\.js';/);
    assert.equal(identity.includes('aoc.governed-action.request.v1'), false);
  });

  it('the business key and semantic digest never read a challenge id, expiry, opaque, realm, method or header', () => {
    const key = identity.slice(identity.indexOf('export function deriveMppGovernedIdempotencyKey'), identity.indexOf('export function deriveMppGovernedRequestId'));
    assert.equal(/\bchallenge|\bexpires|\bopaque|\brealm|random|\bDate\b/i.test(key.replace(/update\(/g, '')), false);
    const semantics = identity.slice(identity.indexOf('export function computeMppBusinessSemanticDigest'), identity.indexOf('export function computeMppChallengeDigest'));
    for (const word of ['.id', 'expires', 'opaque', 'realm', '.method', 'header', 'description', 'merchantReference']) assert.equal(semantics.includes(word), false, word);
  });

  it('the challenge digest excludes description', () => {
    const digest = identity.slice(identity.indexOf('export function computeMppChallengeDigest'));
    assert.equal(digest.includes('description'), false);
  });
});

describe('P13 boundaries — the store', () => {
  it('its port can record and read — nothing that updates, deletes, repairs, retries or stores an outcome', () => {
    const port = code('src/enterprise/mpp-business-operation-store/operation-store.ts');
    const interfaces = [...port.matchAll(/export interface \w+[^{]*\{([\s\S]*?)\n\}/g)].map((match) => match[1] ?? '').join('\n');
    const members = [...interfaces.matchAll(/^\s+(\w+)\(/gm)].map((match) => match[1]);
    assert.deepEqual([...new Set(members.filter((name) => name !== undefined))].sort(), ['close', 'health', 'readByGovernedRequestId', 'readOperation', 'record'].sort());
    for (const file of STORE) {
      for (const forbidden of [/\bUPDATE\s+mpp_/, /\bDELETE\s+FROM\s+mpp_/, /\brepair\w*\(/, /\bretry/i]) assert.equal(forbidden.test(code(file)), false, `${file}: ${String(forbidden)}`);
    }
  });

  it('the record shapes carry no status, outcome, credential or secret field', () => {
    const all = code('src/enterprise/mpp-business-operation-store/contracts.ts');
    // The persisted shapes only; the write result's created/existing is not a stored field.
    const contracts = all.slice(all.indexOf('export interface MppBusinessOperationInput'), all.indexOf('export interface RecordMppChallengeInput'));
    assert.ok(contracts.length > 0);
    const fields = [...contracts.matchAll(/^ {2}readonly (\w+)\??:/gm)].map((match) => match[1] ?? '');
    for (const field of fields) assert.equal(/status|outcome|paid|settle|credential|authorization|secret|token|signature|key$/i.test(field) && field !== 'governedIdempotencyKey', false, field);
  });
});

describe('P13 boundaries — §90 / §91 / §171 no public route, wire field or SDK method', () => {
  it('no HTTP adapter, host, API contract or package mentions P13', () => {
    for (const file of [...walk('src/enterprise/api'), ...walk('src/enterprise/host'), ...walk('src/enterprise/adapters'), ...walk('packages').filter((entry) => !entry.includes('node_modules'))]) {
      assert.equal(/\bmpp|businessOperation|paymentChallenge|mppChallenge/i.test(code(file)), false, file);
    }
  });

  it('§204 no production module imports the test-only MPP fixtures', () => {
    for (const file of walk('src')) assert.equal(importsOf(file).some((specifier) => specifier.includes('mpp-challenge-support') || specifier.includes('__tests__')), false, file);
  });
});
