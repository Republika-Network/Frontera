import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import Database from 'better-sqlite3';

import { RLUSD_XRPL_MAINNET_ISSUER, RLUSD_XRPL_TESTNET_ISSUER } from '../../../dist/src/enterprise/andrew-demo/index.js';
import type { DemoConfiguration, DemoLedgerPorts, DemoXrplPreflight } from './contracts.js';
import { DEMO_IDENTITY, type RunManifest } from './run-infrastructure.js';

/**
 * ANDREW-P0-11 — the read-only preflight. A single verdict, READY or NOT READY,
 * with precise non-secret reasons. Nothing here signs, submits or touches
 * governance; a NOT READY verdict stops the demo before any governed action.
 */

/** Attempt states after which a later payment can never duplicate this one. Everything else blocks another live payment. */
const SETTLED_ATTEMPT_STATES = new Set(['validated-success', 'validated-tec', 'expired']);

export interface PreflightOutcome {
  readonly verdict: 'READY' | 'NOT READY';
  readonly reasons: readonly string[];
  readonly xrpl?: DemoXrplPreflight;
}

/**
 * Earlier runs of **this** demo (same demo identity, XRPL Testnet, same
 * treasury) whose XRPL attempt is not settled: `signed`, `submitted`,
 * `submit-uncertain`, `unresolved` — or `anomaly`, which needs manual
 * reconciliation. Any of them fails closed: an uncertain payment is never
 * followed by another. Runs of another identity, network or treasury are
 * ignored, so unrelated development runs cannot block the demo; an unreadable
 * manifest or store of a matching run blocks (fail closed).
 */
export function unresolvedAttemptReasons(configuration: DemoConfiguration): string[] {
  const runsRoot = join(configuration.stateRoot, 'runs');
  if (!existsSync(runsRoot)) return [];
  const reasons: string[] = [];
  for (const runId of readdirSync(runsRoot)) {
    const manifestPath = join(runsRoot, runId, 'run.json');
    if (!existsSync(manifestPath)) continue;
    let manifest: Partial<RunManifest>;
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Partial<RunManifest>;
    } catch {
      reasons.push(`run ${runId}: its manifest cannot be read — inspect it before another live payment`);
      continue;
    }
    if (manifest.demoIdentity !== DEMO_IDENTITY || manifest.network !== 'xrpl-testnet' || manifest.treasury !== configuration.treasury) continue;
    const storePath = join(runsRoot, runId, 'xrpl-attempts.sqlite');
    if (!existsSync(storePath)) continue;
    let db: Database.Database | undefined;
    try {
      db = new Database(storePath, { readonly: true, fileMustExist: true });
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'xrpl_submission_attempts'").all();
      if (tables.length === 0) continue;
      const rows = db
        .prepare(
          `SELECT a.execution_id AS executionId, a.transaction_hash AS hash, a.network AS network, a.source_account AS source,
                  (SELECT e.state FROM xrpl_submission_attempt_events e WHERE e.execution_id = a.execution_id ORDER BY e.id DESC LIMIT 1) AS state
             FROM xrpl_submission_attempts a`,
        )
        .all() as { readonly executionId: string; readonly hash: string; readonly network: string; readonly source: string; readonly state: string | null }[];
      for (const row of rows) {
        if (row.source !== configuration.treasury) continue;
        const state = row.state ?? 'signed';
        if (!SETTLED_ATTEMPT_STATES.has(state)) reasons.push(`run ${runId}: XRPL attempt ${row.executionId} (tx ${row.hash}) is '${state}' — reconcile it on the ledger before another live payment`);
      }
    } catch {
      reasons.push(`run ${runId}: its XRPL attempt store cannot be read — inspect it before another live payment`);
    } finally {
      db?.close();
    }
  }
  return reasons;
}

export async function runDemoPreflight(configuration: DemoConfiguration, secrets: Readonly<Record<string, string>>, ports: DemoLedgerPorts): Promise<PreflightOutcome> {
  const reasons: string[] = [];
  for (const [label, address] of [['treasury', configuration.treasury], ['recipient', configuration.recipient]] as const) {
    if (address === RLUSD_XRPL_TESTNET_ISSUER || address === RLUSD_XRPL_MAINNET_ISSUER) reasons.push(`the ${label} is an RLUSD issuer account — not part of this demo`);
  }
  try {
    ports.verifySignerAccount(configuration, secrets);
  } catch {
    reasons.push('the treasury signing seed in the secrets file does not belong to FRONTERA_XRPL_TESTNET_TREASURY_ADDRESS (or cannot be read)');
  }
  reasons.push(...unresolvedAttemptReasons(configuration));

  let xrpl: DemoXrplPreflight | undefined;
  try {
    xrpl = await ports.preflight(configuration);
  } catch {
    reasons.push(`the XRPL Testnet endpoint ${configuration.endpoint} could not be read for the preflight`);
  }
  if (xrpl !== undefined) {
    if (xrpl.connectedNetworkId !== configuration.expectedNetworkId) reasons.push(`the connected server reports network_id ${String(xrpl.connectedNetworkId)}, not XRPL Testnet (${configuration.expectedNetworkId})`);
    reasons.push(...xrpl.blockers.filter((blocker) => !/network_id/.test(blocker)));
    if (xrpl.treasury.trustLine && !xrpl.treasury.tokenSufficient) {
      reasons.push(`FUNDING REQUIRED — the demo never refills, resets or faucets the fixture. Fund the treasury with at least ${configuration.amountUsd} Test RLUSD (or run an explicit fixture reset), then rerun.`);
    }
  }
  return { verdict: reasons.length === 0 ? 'READY' : 'NOT READY', reasons, ...(xrpl !== undefined ? { xrpl } : {}) };
}
