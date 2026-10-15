import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { join } from 'node:path';

/**
 * R8 security mutations. Each mutant removes or weakens one part of the mandatory-trade-policy contract in the
 * compiled modules and runs, in its own process (`trade04c-r8-mutation-runner.ts`), the R8 scenario: boot a
 * trade Host under a named configuration and govern an 800-RLUSD order TRADE-03 marks APPROVAL_REQUIRED,
 * never approving it. The property: no signature and no submission.
 *
 * - `detected`: with the mutant the property FAILS — the order is signed and submitted with no approval, which
 *   the R8 suite's approval tests would reject. `guard-removed` is the original R8 defect, reproduced.
 * - `contained`: the property still holds, because another, named boundary refuses (`by`) — asserted.
 *
 * Each configuration first runs unmutated (the baseline must hold), and every edit must apply exactly once.
 */

interface Edit {
  readonly file: string;
  readonly search: string;
  readonly replace: string;
  readonly occurrences?: number;
}

interface Outcome {
  readonly booted?: boolean;
  readonly refusal?: string;
  readonly status?: string;
  readonly withheldBy?: string;
  readonly disposition?: string;
  readonly signatures?: number;
  readonly sends?: number;
  readonly applied?: readonly number[];
  readonly error?: string;
}

type Configuration = 'default' | 'approval-policy-other-profile' | 'hand-built-without-review' | 'prototype-forgery' | 'provider-for-another-edge';

interface Mutant {
  readonly id: string;
  readonly edits: readonly Edit[];
  readonly configuration: Configuration;
  readonly expect: 'detected' | 'contained';
  /** For `contained`: what refuses instead (a boot refusal code, or the Kernel's denial). */
  readonly by?: (outcome: Outcome) => boolean;
  readonly reason: string;
}

const RUNNER = join(__dirname, 'trade04c-r8-mutation-runner.js');
const HOST = 'host/enterprise-host.js';
const PROVIDER = 'trade-risk-context/trade-risk-policy-provider.js';
const RULES = 'trade-risk-context/trade-risk-policy.js';

const REVIEW_RULE_EFFECT = "{ type: 'require_approval', reasonCode: 'TRADE_RISK_REVIEW_REQUIRED', reason: 'The order is marked for human review.' }";
const FACTORY_RULE_SET_CHECK = 'if (JSON.stringify(ruleIds) !== JSON.stringify(exports.TRADE_RISK_MANDATORY_POLICY_RULE_IDS))';
const FACTORY_EFFECT_CHECK = "if (rule.status !== 'active' || rule.effect.type !== exports.TRADE_RISK_MANDATORY_POLICY_EFFECTS[rule.id])";

const bootRefused = (code: string) => (outcome: Outcome): boolean => outcome.booted === false && outcome.refusal === code;

const MUTANTS: readonly Mutant[] = [
  {
    id: 'guard-removed',
    reason: 'the Host boot guard is removed — the original R8 defect',
    edits: [{ file: HOST, search: 'await assertTradePolicyComposed(host, options);', replace: '' }],
    configuration: 'approval-policy-other-profile',
    expect: 'detected',
  },
  {
    id: 'unmarked-provider-accepted',
    reason: 'a provider with no TRADE-03 provenance is accepted',
    edits: [{ file: HOST, search: "if (provenance === undefined)\n        return required('the composed provider was not produced by the TRADE-03 factory');", replace: 'if (provenance === undefined)\n        return;' }],
    configuration: 'hand-built-without-review',
    expect: 'detected',
  },
  {
    id: 'provenance-forged-through-prototype',
    reason: 'provenance is read through the prototype chain, so a look-alike inheriting from the genuine provider carries its mark',
    edits: [{ file: PROVIDER, search: 'PROVENANCE.get(provider) : undefined', replace: '(PROVENANCE.get(provider) ?? PROVENANCE.get(Object.getPrototypeOf(provider))) : undefined' }],
    configuration: 'prototype-forgery',
    expect: 'detected',
  },
  {
    id: 'review-requirement-omitted',
    reason: 'trade-risk-review no longer requires approval, and the factory no longer checks effects (CORE-05 approval requirement omitted)',
    edits: [
      { file: RULES, search: REVIEW_RULE_EFFECT, replace: "{ type: 'allow', reasonCode: 'TRADE_RISK_REVIEW_REQUIRED', reason: 'The order is marked for human review.' }" },
      { file: PROVIDER, search: FACTORY_EFFECT_CHECK, replace: 'if (false)' },
    ],
    configuration: 'default',
    expect: 'detected',
  },
  {
    id: 'review-rule-effect-weakened',
    reason: 'trade-risk-review no longer requires approval',
    edits: [{ file: RULES, search: REVIEW_RULE_EFFECT, replace: "{ type: 'allow', reasonCode: 'TRADE_RISK_REVIEW_REQUIRED', reason: 'The order is marked for human review.' }" }],
    configuration: 'default',
    expect: 'contained',
    by: bootRefused('TRADE_RISK_POLICY_PROVIDER_INVALID'),
  },
  {
    id: 'review-rule-removed',
    reason: 'trade-risk-review is dropped from the compiled policy',
    edits: [{ file: PROVIDER, search: "sourceIds: ['trade-risk-profile'] }).map((rule) => Object.freeze({ ...rule })));", replace: "sourceIds: ['trade-risk-profile'] }).filter((rule) => rule.id !== 'trade-risk-review').map((rule) => Object.freeze({ ...rule })));" }],
    configuration: 'default',
    expect: 'contained',
    by: bootRefused('TRADE_RISK_POLICY_PROVIDER_INVALID'),
  },
  {
    id: 'review-rule-removed-and-factory-check-removed',
    reason: 'trade-risk-review is dropped and the factory no longer checks the rule set',
    edits: [
      { file: PROVIDER, search: "sourceIds: ['trade-risk-profile'] }).map((rule) => Object.freeze({ ...rule })));", replace: "sourceIds: ['trade-risk-profile'] }).filter((rule) => rule.id !== 'trade-risk-review').map((rule) => Object.freeze({ ...rule })));" },
      { file: PROVIDER, search: FACTORY_RULE_SET_CHECK, replace: 'if (false)' },
      { file: PROVIDER, search: FACTORY_EFFECT_CHECK, replace: 'if (false)' },
    ],
    configuration: 'default',
    expect: 'contained',
    by: bootRefused('HOST_TRADE_POLICY_REQUIRED'),
  },
  {
    id: 'proposal-binding-removed',
    reason: 'the proposal-binding rules are dropped from the TRADE-03 rule builder',
    edits: [{ file: RULES, search: '...Object.entries(index_js_1.TRADE_INTENT_BINDING_FACTS).map(', replace: '...Object.entries({}).map(' }],
    configuration: 'default',
    expect: 'contained',
    by: bootRefused('TRADE_RISK_POLICY_PROVIDER_INVALID'),
  },
  {
    id: 'edge-binding-removed',
    reason: 'the guard no longer requires the policy to be bound to the Host’s own edge (a provider qualified for another profile version is accepted)',
    edits: [
      { file: HOST, search: "if (options.contextProvider !== provenance.contextProvider)\n        required(\"the Host's contextProvider is not the policy's TRADE-03 edge\");", replace: '' },
      { file: HOST, search: "if (attested !== undefined && attested !== provenance.attested)\n        required(\"the executor's attestation source is not the policy's TRADE-03 edge\");", replace: '' },
    ],
    configuration: 'provider-for-another-edge',
    expect: 'contained',
    // The pinned-profile rule compares the Host edge's @3 reading with the provider's @4 reference: denied before review.
    by: (outcome) => outcome.booted === true && outcome.status === 'denied',
  },
  {
    id: 'approval-policy-conflict-accepted',
    reason: 'a file approvalPolicy beside trade execution is no longer refused',
    edits: [{ file: HOST, search: 'if (governed.approvalPolicy !== undefined) {\n        throw new host_configuration_js_3.EnterpriseHostConfigurationError(\'HOST_TRADE_POLICY_SOURCE_CONFLICT\'', replace: 'if (false) {\n        throw new host_configuration_js_3.EnterpriseHostConfigurationError(\'HOST_TRADE_POLICY_SOURCE_CONFLICT\'' }],
    configuration: 'approval-policy-other-profile',
    expect: 'contained',
    by: bootRefused('HOST_TRADE_POLICY_REQUIRED'),
  },
];

function run(edits: readonly Edit[], configuration: Configuration): Promise<Outcome> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [RUNNER, JSON.stringify(edits), configuration], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => (err += chunk.toString('utf8')));
    const timer = setTimeout(() => child.kill('SIGKILL'), 280_000);
    child.on('close', () => {
      clearTimeout(timer);
      const line = out.split('\n').find((candidate) => candidate.startsWith('R8-RESULT '));
      resolve(line === undefined ? { error: `no result (stderr: ${err.slice(-2000)})` } : (JSON.parse(line.slice('R8-RESULT '.length)) as Outcome));
    });
  });
}

/** Runs `jobs` at most `limit` at a time. */
async function bounded<T>(jobs: readonly (() => Promise<T>)[], limit: number): Promise<T[]> {
  const results: T[] = new Array(jobs.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, jobs.length) }, async () => {
      while (next < jobs.length) {
        const index = next++;
        results[index] = await jobs[index]!();
      }
    }),
  );
  return results;
}

const bypassed = (outcome: Outcome): boolean => (outcome.signatures ?? 0) > 0 || (outcome.sends ?? 0) > 0;

describe('R8 — security mutations of the mandatory trade-policy contract', { timeout: 1_200_000 }, () => {
  it('every configuration holds unmutated; every mutant is detected or contained by its named boundary', async (t) => {
    const configurations = [...new Set(MUTANTS.map((mutant) => mutant.configuration))];
    const jobs = [...configurations.map((configuration) => () => run([], configuration)), ...MUTANTS.map((mutant) => () => run(mutant.edits, mutant.configuration))];
    const results = await bounded(jobs, 4);
    const baselines = results.slice(0, configurations.length);
    configurations.forEach((configuration, index) => {
      const outcome = baselines[index]!;
      assert.equal(outcome.error, undefined, `${configuration} baseline: ${outcome.error}`);
      assert.equal(bypassed(outcome), false, `${configuration} baseline holds: ${JSON.stringify(outcome)}`);
      t.diagnostic(`baseline ${configuration}: ${JSON.stringify({ booted: outcome.booted, refusal: outcome.refusal, status: outcome.status, withheldBy: outcome.withheldBy })}`);
    });
    MUTANTS.forEach((mutant, index) => {
      const outcome = results[configurations.length + index]!;
      assert.equal(outcome.error, undefined, `${mutant.id}: ${outcome.error}`);
      assert.deepEqual(outcome.applied, mutant.edits.map(() => 1), `${mutant.id}: every edit applied exactly once`);
      if (mutant.expect === 'detected') {
        assert.equal(bypassed(outcome), true, `${mutant.id} (${mutant.reason}) must reintroduce the bypass the R8 tests reject: ${JSON.stringify(outcome)}`);
      } else {
        assert.equal(bypassed(outcome), false, `${mutant.id} (${mutant.reason}) is contained: ${JSON.stringify(outcome)}`);
        assert.ok(mutant.by!(outcome), `${mutant.id}: contained by its named boundary, not by accident: ${JSON.stringify(outcome)}`);
      }
      t.diagnostic(`${mutant.expect.toUpperCase()} ${mutant.id}: ${JSON.stringify({ booted: outcome.booted, refusal: outcome.refusal, status: outcome.status, withheldBy: outcome.withheldBy, disposition: outcome.disposition, signatures: outcome.signatures, sends: outcome.sends })}`);
    });
  });
});
