import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { RLUSD_CURRENCY_CODE, RLUSD_XRPL_TESTNET_ISSUER, composeAndrewDemo, type AndrewDemo } from '../../../dist/src/enterprise/andrew-demo/index.js';
import { loadDemoConfiguration } from './configuration.js';
import { DemoFailure, type DemoConfiguration, type DemoFailureCategory, type DemoInterceptor, type DemoLedgerPorts, type DemoStepObserver, type DemoSummary, type DemoTransportBinding } from './contracts.js';
import { runDemoPreflight } from './preflight.js';
import { createPresenter, grouped, type Presenter } from './presentation.js';
import { renderMarkdownReport } from './report.js';
import { createRun, demoIdentity, newRunId, startRunInfrastructure, type RunInfrastructure, type RunPaths } from './run-infrastructure.js';
import { PRODUCTION_MOTIVATING_EXAMPLE_USD, runScenarioA, runScenarioB, type ScenarioContext } from './scenarios.js';
import { SecretExposureError, createSecretGuard, type SecretGuard } from './secret-guard.js';

/**
 * ANDREW-P0-11 — `npm run demo:andrew`: preflight, then Scenario A and
 * Scenario B on one fresh run, then the evidence summary.
 *
 * Exit codes: 0 only when every invariant held (DEMO RESULT: PASS); 1 for any
 * failure after preflight — an unexpected grant, signature or submission, a
 * wrong reason, an ambiguous XRPL outcome, a trace that does not verify, an
 * interruption; 2 when preflight is NOT READY (nothing governed was attempted).
 * "DEMO RESULT: PASS" is printed on exactly one path: after both scenarios
 * completed and the summary was written.
 */

export interface RunAndrewDemoOptions {
  /** Non-secret overrides (state root, secrets file path, endpoint, amount). Secrets come from the secrets file only. */
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly ports: DemoLedgerPorts;
  readonly write: (line: string) => void;
  readonly preflightOnly?: boolean;
  readonly observer?: DemoStepObserver;
  /** Test seam only; see `DemoInterceptor`. */
  readonly intercept?: DemoInterceptor;
  readonly isInterrupted?: () => boolean;
  readonly now?: () => Date;
}

export interface RunAndrewDemoResult {
  readonly verdict: 'PASS' | 'FAIL' | 'NOT READY' | 'READY';
  readonly exitCode: 0 | 1 | 2;
  readonly runId?: string;
  readonly summaryPath?: string;
  readonly reportPath?: string;
  readonly summary?: DemoSummary;
}

function honesty(present: Presenter, configuration: DemoConfiguration): void {
  present.line('What this demo moves, and what it does not:');
  present.fact('Governed amount (live)', `USD ${grouped(configuration.amountUsd)}`);
  present.fact('Testnet transfer', `${grouped(configuration.amountUsd)} Test RLUSD on XRPL Testnet — no real-world value`);
  present.fact('Production example', `USD ${grouped(PRODUCTION_MOTIVATING_EXAMPLE_USD)} (Andrew/LUMX) — motivating scenario only, never sent`);
  present.fact('Scenario B request', 'USD 125,000 — governed request only, withheld, never sent');
}

export async function runAndrewDemo(options: RunAndrewDemoOptions): Promise<RunAndrewDemoResult> {
  const guard: SecretGuard = createSecretGuard();
  const present = createPresenter(options.write, guard);
  const now = options.now ?? (() => new Date());

  present.banner('FRONTERA — Andrew / LUMX governed payment demo (XRPL Testnet only)');

  // ── Configuration and preflight: read-only; NOT READY stops before any governed action. ──
  const loaded = loadDemoConfiguration(options.environment, guard);
  if (!loaded.ok) {
    present.result('PREFLIGHT NOT READY');
    for (const reason of loaded.reasons) present.line(`  - ${reason}`);
    present.line('No governed action was made.');
    return { verdict: 'NOT READY', exitCode: 2 };
  }
  const { configuration, secrets } = loaded.loaded;
  honesty(present, configuration);

  present.banner('PREFLIGHT (read-only)');
  const preflight = await runDemoPreflight(configuration, secrets, options.ports);
  present.fact('Network', `XRPL Testnet (expected network_id ${configuration.expectedNetworkId}, connected ${String(preflight.xrpl?.connectedNetworkId)})`);
  present.fact('Endpoint', configuration.endpoint);
  present.fact('Treasury', configuration.treasury);
  present.fact('Recipient', configuration.recipient);
  present.fact('RLUSD Testnet issuer', RLUSD_XRPL_TESTNET_ISSUER);
  if (preflight.xrpl !== undefined) {
    present.fact('Treasury XRP (drops)', String(preflight.xrpl.treasury.xrpDrops ?? 'account not found'));
    present.fact('Recipient XRP (drops)', String(preflight.xrpl.recipient.xrpDrops ?? 'account not found'));
    present.fact('Trust lines (T / R)', `${preflight.xrpl.treasury.trustLine ? 'YES' : 'NO'} / ${preflight.xrpl.recipient.trustLine ? 'YES' : 'NO'}`);
    present.fact('Treasury Test RLUSD', String(preflight.xrpl.treasury.tokenBalance ?? '0'));
  }
  present.fact('Demo amount', `${configuration.amountUsd} (USD governed / Test RLUSD on Testnet)`);
  present.fact('Attempt state', preflight.reasons.some((reason) => /XRPL attempt|attempt store/.test(reason)) ? 'UNRESOLVED ATTEMPT FOUND' : 'no unresolved attempt; this run gets a fresh store');
  present.fact('Secrets file', `${configuration.secretsFile} (owner-only)`);
  if (preflight.verdict === 'NOT READY') {
    present.result('PREFLIGHT NOT READY');
    for (const reason of preflight.reasons) present.line(`  - ${reason}`);
    present.line('Stopped before any governed action. Scenario A was not started.');
    return { verdict: 'NOT READY', exitCode: 2 };
  }
  present.result('PREFLIGHT READY');
  if (options.preflightOnly === true) {
    present.line('Preflight only: no governed action was made.');
    return { verdict: 'READY', exitCode: 0 };
  }

  // ── The run: fresh state, explicit infrastructure, both scenarios. ──
  const startedAt = now().toISOString();
  const runId = newRunId(now());
  const checkpoints: DemoSummary['checkpoints'][number][] = [];
  let paths: RunPaths | undefined;
  let infrastructure: RunInfrastructure | undefined;
  let binding: DemoTransportBinding | undefined;
  let demo: AndrewDemo | undefined;
  let scenarioA: Readonly<Record<string, unknown>> | undefined;
  let scenarioB: Readonly<Record<string, unknown>> | undefined;
  let failure: DemoSummary['failure'] | undefined;
  try {
    paths = createRun(configuration, runId, startedAt);
    present.line(`Run ${runId} — state in ${paths.runDirectory}`);
    infrastructure = await startRunInfrastructure(paths, guard);
    binding = options.ports.openTransport(configuration, secrets, paths.attemptStorePath);
    if (binding.attemptCount() !== 0) throw new DemoFailure('PRECONDITION FAILURE', 'the run\'s attempt store is not fresh');
    demo = await composeAndrewDemo({ directory: paths.hostDirectory, environment: infrastructure.environment, identity: demoIdentity(), transport: binding.transport as Parameters<typeof composeAndrewDemo>[0]['transport'] });
    const context: ScenarioContext = {
      demo,
      configuration,
      paths,
      credentials: infrastructure.credentials,
      binding,
      ports: options.ports,
      present,
      checkpoints,
      ...(options.observer !== undefined ? { observer: options.observer } : {}),
      ...(options.intercept !== undefined ? { intercept: options.intercept } : {}),
      ...(options.isInterrupted !== undefined ? { isInterrupted: options.isInterrupted } : {}),
    };
    scenarioA = await runScenarioA(context);
    scenarioB = await runScenarioB(context);
  } catch (error) {
    const category: DemoFailureCategory = error instanceof DemoFailure ? error.category : 'UNEXPECTED DEMO ASSERTION FAILURE';
    let message = error instanceof DemoFailure || error instanceof SecretExposureError ? error.message : 'an unexpected error stopped the run';
    try {
      guard.check(message);
    } catch {
      message = 'an unexpected error stopped the run (details withheld: they matched secret material)';
    }
    failure = { category, message, ...(checkpoints.at(-1) !== undefined ? { step: `after ${checkpoints.at(-1)?.step ?? ''}` } : {}) };
  } finally {
    await demo?.close().catch(() => {});
    binding?.close();
    await infrastructure?.close().catch(() => {});
  }

  const verdict: 'PASS' | 'FAIL' = failure === undefined && scenarioA !== undefined && scenarioB !== undefined ? 'PASS' : 'FAIL';
  const summary: DemoSummary = {
    schema: 'frontera.andrew-demo.summary.v1',
    runId,
    startedAt,
    finishedAt: now().toISOString(),
    network: { name: 'XRPL Testnet', ...(preflight.xrpl?.connectedNetworkId !== undefined ? { networkId: preflight.xrpl.connectedNetworkId } : {}), endpoint: configuration.endpoint, ...(preflight.xrpl?.validatedLedgerIndex !== undefined ? { validatedLedgerAtPreflight: preflight.xrpl.validatedLedgerIndex } : {}) },
    amounts: {
      governedAmount: { value: configuration.amountUsd, unit: 'USD' },
      testnetTransfer: { value: configuration.amountUsd, asset: 'Test RLUSD (XRPL Testnet)', currencyCode: RLUSD_CURRENCY_CODE, issuer: RLUSD_XRPL_TESTNET_ISSUER },
      productionMotivatingExample: { value: PRODUCTION_MOTIVATING_EXAMPLE_USD, unit: 'USD', note: 'Andrew/LUMX production example; the motivating scenario — nothing of this size moved on Testnet or anywhere else' },
    },
    accounts: { treasury: configuration.treasury, recipient: configuration.recipient },
    ...(infrastructure !== undefined ? { verificationMaterial: infrastructure.verificationMaterial } : {}),
    preflight: { verdict: preflight.verdict, reasons: preflight.reasons, ...(preflight.xrpl?.treasury.tokenBalance !== undefined ? { treasuryTestRlusd: preflight.xrpl.treasury.tokenBalance } : {}), ...(preflight.xrpl?.connectedNetworkId !== undefined ? { networkId: preflight.xrpl.connectedNetworkId } : {}) },
    ...(scenarioA !== undefined ? { scenarioA } : {}),
    ...(scenarioB !== undefined ? { scenarioB } : {}),
    checkpoints: failure === undefined ? checkpoints : [...checkpoints, { step: failure.step ?? 'start', result: 'FAIL', detail: `${failure.category}: ${failure.message}` }],
    ...(failure !== undefined ? { failure } : {}),
    finalVerdict: verdict,
  };

  let summaryPath: string | undefined;
  let reportPath: string | undefined;
  let finalVerdict = verdict;
  if (paths !== undefined) {
    try {
      const json = guard.check(`${JSON.stringify(summary, null, 2)}\n`);
      const markdown = guard.check(renderMarkdownReport(summary));
      summaryPath = join(paths.runDirectory, 'summary.json');
      reportPath = join(paths.runDirectory, `ANDREW-DEMO-${runId}.md`);
      writeFileSync(summaryPath, json, { mode: 0o600 });
      writeFileSync(reportPath, markdown, { mode: 0o600 });
    } catch (error) {
      finalVerdict = 'FAIL';
      present.line(`Evidence summary NOT written: ${error instanceof SecretExposureError ? error.message : 'it could not be written'}`);
    }
  } else {
    finalVerdict = 'FAIL';
  }

  present.banner('DEMO RESULT');
  if (finalVerdict === 'PASS' && summaryPath !== undefined) {
    present.line('PASS');
    present.line('  Governance blocked what was forbidden.');
    present.line('  Governance allowed what became authorized.');
    present.line('  Only authorized execution reached XRPL Testnet.');
    present.line('  Every material outcome is evidenced and verified.');
  } else {
    present.line(`FAIL — ${summary.failure?.category ?? 'UNEXPECTED DEMO ASSERTION FAILURE'}: ${summary.failure?.message ?? 'the evidence summary could not be written'}`);
  }
  if (summaryPath !== undefined) present.fact('Summary', summaryPath);
  if (reportPath !== undefined) present.fact('Report', reportPath);
  present.line('-'.repeat(60));
  return { verdict: finalVerdict, exitCode: finalVerdict === 'PASS' ? 0 : 1, runId, ...(summaryPath !== undefined ? { summaryPath } : {}), ...(reportPath !== undefined ? { reportPath } : {}), summary: { ...summary, finalVerdict } };
}
