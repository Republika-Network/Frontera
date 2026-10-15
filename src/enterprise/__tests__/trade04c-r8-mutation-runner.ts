import { strict as assert } from 'node:assert';
import Module from 'node:module';
import { join } from 'node:path';

/**
 * R8 mutation runner — one mutant, one scenario, one process (spawned by `trade04c-r8-mutation.test.ts`).
 *
 * A mutant is a set of exact source edits to compiled modules. They are applied in this process's CommonJS
 * loader before anything is loaded, then the Host fixture is required — so the mutated modules are the cached
 * ones every later `require` or `import()` of them returns (the Host loads the trade vertical with `import()`).
 * The runner proves each edit was applied exactly as expected, runs the scenario, and prints one result line.
 *
 * Scenario: boot a trade Host under the named configuration; if it boots, govern one 800-RLUSD order — one
 * TRADE-03 marks APPROVAL_REQUIRED — and never approve it. The property: nothing is signed or submitted.
 */

interface Edit {
  readonly file: string;
  readonly search: string;
  readonly replace: string;
  readonly occurrences?: number;
}

interface Outcome {
  readonly booted: boolean;
  readonly refusal?: string;
  readonly status?: string;
  readonly withheldBy?: string;
  readonly disposition?: string;
  readonly signatures: number;
  readonly sends: number;
  readonly applied: readonly number[];
}

const ENTERPRISE = join(__dirname, '..');
const [, , editsJson = '[]', configuration = 'default'] = process.argv;
const edits = JSON.parse(editsJson) as readonly Edit[];
const applied = edits.map(() => 0);

type Compile = (this: unknown, content: string, filename: string) => unknown;
const prototype = (Module as unknown as { prototype: { _compile: Compile } }).prototype;
const compile = prototype._compile;
prototype._compile = function mutated(this: unknown, content: string, filename: string): unknown {
  let source = content;
  edits.forEach((edit, index) => {
    if (filename !== join(ENTERPRISE, edit.file)) return;
    assert.equal(source.split(edit.search).length - 1, edit.occurrences ?? 1, `mutation site in ${edit.file}: ${edit.search}`);
    source = source.split(edit.search).join(edit.replace);
    applied[index] = (applied[index] ?? 0) + 1;
  });
  return compile.call(this, source, filename);
};

async function main(): Promise<Outcome> {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const fixture = require('./trade04c-host-fixture.js') as typeof import('./trade04c-host-fixture.js');
  const ledgers = require('./trade04c-execution-fixture.js') as typeof import('./trade04c-execution-fixture.js');
  const witnesses = require('./core07-freshness-fixture.js') as typeof import('./core07-freshness-fixture.js');
  // Every mutated module is loaded now, through this loader (the Host's trade import() then reuses it).
  require('../host/enterprise-host.js');
  require('../trade-risk-context/index.js');
  /* eslint-enable @typescript-eslint/no-require-imports */

  const options = (): Parameters<typeof fixture.bootTradeHost>[1] => {
    switch (configuration) {
      case 'default':
        return {};
      case 'approval-policy-other-profile': {
        const ledger = new ledgers.FakeXrplLedger();
        const pair = ledgers.pairWorld(ledger);
        const governance = structuredClone(fixture.tradeFile(pair, 'http://unused.invalid')['governance']) as { actionClasses: unknown[]; profiles: Record<string, unknown>[] };
        governance.actionClasses.push({ id: 'housekeeping', actions: ['ops.housekeeping'] });
        governance.profiles.push({ ...structuredClone(governance.profiles[0]!), profileId: 'ops-housekeeping', actionClass: 'housekeeping', materialFacts: [], relevantPolicies: [] });
        return {
          ledger,
          pair,
          embedderPolicy: false,
          envOverrides: { FRONTERA_R8_APPROVER: 'FRONTERA_R8_APPROVER_SECRET_7d2a9c4e1b6f3a8e0512' },
          fileOverrides: {
            governance,
            operators: [{ operatorId: 'r8-approver', role: 'approver', apiKeyEnv: 'FRONTERA_R8_APPROVER' }],
            approvalPolicy: { policyId: 'ops', rules: [{ ruleId: 'housekeeping-review', governanceProfile: 'ops-housekeeping', reasonCode: 'OPS_REVIEW' }] },
          },
        };
      }
      case 'hand-built-without-review':
        return { policyProvider: ({ resource }) => fixture.handBuiltTradePolicy(resource, ['trade-risk-review']) };
      case 'prototype-forgery':
        return {
          policyProvider: ({ mandatory, resource }) => {
            const genuine = mandatory();
            const weak = fixture.handBuiltTradePolicy(resource, ['trade-risk-review']);
            return Object.create(genuine, { evaluatePolicyForEnforcement: { value: (input: Parameters<typeof weak.evaluatePolicyForEnforcement>[0]) => weak.evaluatePolicyForEnforcement(input) } }) as typeof genuine;
          },
        };
      case 'provider-for-another-edge':
        return { policyEdgeProfileVersion: 4 };
      default:
        throw new Error(`unknown configuration ${configuration}`);
    }
  };

  const workspace = new fixture.Workspace();
  try {
    let trade: Awaited<ReturnType<typeof fixture.bootTradeHost>>;
    try {
      trade = await fixture.bootTradeHost(workspace, options());
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      return { booted: false, refusal: typeof code === 'string' ? code : (error as Error).name, signatures: 0, sends: 0, applied };
    }
    try {
      const reply = await fixture.governTrade(trade, fixture.proposalFor(trade, '800'));
      return {
        booted: true,
        status: String(reply.body['status']),
        ...(reply.body['withheldBy'] !== undefined ? { withheldBy: String(reply.body['withheldBy']) } : {}),
        ...(trade.assessments.at(-1)?.disposition !== undefined ? { disposition: String(trade.assessments.at(-1)?.disposition) } : {}),
        signatures: trade.signer.signatures(),
        sends: trade.ledger.submitCalls.length,
        applied,
      };
    } finally {
      await trade.signer.close().catch(() => {});
    }
  } finally {
    await workspace.cleanup();
    await witnesses.closeDeploymentWitnesses();
  }
}

main().then(
  (outcome) => {
    process.stdout.write(`R8-RESULT ${JSON.stringify(outcome)}\n`);
    process.exit(0);
  },
  (error: unknown) => {
    process.stdout.write(`R8-RESULT ${JSON.stringify({ error: String(error instanceof Error ? error.stack : error), applied })}\n`);
    process.exit(1);
  },
);
