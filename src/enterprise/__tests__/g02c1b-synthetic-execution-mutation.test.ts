import { mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { openExecutionCapabilityConsumptionLedger } from '../execution-capability/reference/consumption-ledger.js';
import { createReferenceExecutorVerificationPipeline, parseReferenceExecutorConfiguration, referenceExecutorStatusOf } from '../reference-executor/index.js';
import { ACTION, EXECUTOR_ENVIRONMENT, EXECUTOR_ID, RESOURCE, executorConfiguration, hostVector, observedWith } from './g02c1a-reference-executor-fixture.js';
import { SYNTHETIC_ACTION, inProcessFlow, syntheticCapability, syntheticConfiguration, syntheticDomain, type InProcessFlowOptions, type SyntheticDomain } from './g02c1b-synthetic-execution-fixture.js';

/**
 * G-02C1B mutation qualification, in the manner of G-02A … G-02C1A: each
 * load-bearing control G-02C1B adds is removed from the **compiled** module
 * (sites name only module-local identifiers on one emitted line, and each must
 * occur exactly once), the mutant is loaded beside the original, and its guard
 * must hold for the original and fail for the mutant.
 *
 * Controls that G-02C1B reuses are qualified where they live: signature,
 * audience, binding digest, expiry, single use, execution uniqueness, audience
 * pin, status-required and the claim-time expiry re-check by G-02A's mutants;
 * credential, allow-lists, status eligibility, verification and the binding
 * reconstruction by G-02C1A's.
 */

const load = createRequire(__filename);
const ROOT = join(__dirname, '..');
const domains: SyntheticDomain[] = [];
after(() => {
  for (const domain of domains) domain.cleanup();
});
async function freshDomain(audience?: string): Promise<SyntheticDomain> {
  const domain = await syntheticDomain(audience);
  domains.push(domain);
  return domain;
}

interface Mutant<M> {
  readonly id: string;
  readonly file: string;
  readonly replacements: readonly (readonly [string, string])[];
  readonly guard: (module: M) => boolean | Promise<boolean>;
}

async function qualify<M>(mutant: Mutant<M>): Promise<void> {
  const path = join(ROOT, mutant.file);
  let source = readFileSync(path, 'utf8');
  for (const [search, replace] of mutant.replacements) {
    assert.equal(source.split(search).length - 1, 1, `${mutant.id}: the mutation site must occur exactly once in ${mutant.file}: ${search.slice(0, 60)}`);
    source = source.replace(search, replace);
  }
  const mutantPath = path.replace(/\.js$/, `.mutant-g02c1b-${mutant.id}.js`);
  writeFileSync(mutantPath, source);
  try {
    assert.equal(await mutant.guard(load(path) as M), true, `${mutant.id}: the guard holds for the shipped module`);
    assert.equal(await mutant.guard(load(mutantPath) as M), false, `${mutant.id}: the guard detects the removed control`);
  } finally {
    delete load.cache[load.resolve(mutantPath)];
    rmSync(mutantPath, { force: true });
  }
}

const VECTOR = hostVector('POST with body and headers', {
  body: { kind: 'json-object', fields: { subject: { kind: 'source', source: 'subject' }, amount: { kind: 'source', source: 'amount.value' } } },
  headers: { 'X-Release-Channel': { kind: 'literal', value: 'stable' } },
});

// ── The execution flow ──────────────────────────────────────────────────────

type FlowModule = typeof import('../reference-executor/execution-flow.js');
const FLOW = join('reference-executor', 'execution-flow.js');

/** A fresh domain and the flow `m` builds over it; `use` runs against it; the domain is inspected by `use` itself. */
async function withFlow<T>(m: FlowModule, options: Omit<InProcessFlowOptions, 'flowModule'>, use: (world: Awaited<ReturnType<typeof inProcessFlow>>, domain: SyntheticDomain) => Promise<T> | T): Promise<T> {
  const domain = await freshDomain();
  const world = await inProcessFlow(domain, { ...options, flowModule: m });
  try {
    return await use(world, domain);
  } finally {
    world.close();
  }
}

describe('G-02C1B mutation — the execution flow', () => {
  const mutants: readonly Mutant<FlowModule>[] = [
    {
      id: 'claim-skipped',
      file: FLOW,
      replacements: [['claim = ledger.claim(verification);', "claim = { outcome: 'claimed', capabilityId, claimedAt: new Date().toISOString() };"]],
      // The positive path, end to end: performed once, after a durable claim the ledger then shows completed.
      guard: (m) =>
        withFlow(m, {}, async (world, domain) => {
          const { capability, presentation } = syntheticCapability(VECTOR.digest);
          const execution = world.flow.execute(observedWith(VECTOR, { presentation }));
          return execution.outcome === 'completed-observed' && (await domain.state(capability.capabilityId)).state === 'completed';
        }),
    },
    {
      id: 'duplicate-claim-ignored',
      file: FLOW,
      replacements: [["if (claim.outcome !== 'claimed') {", "if (claim.outcome !== 'claimed' && claim.reason !== 'CAPABILITY_CONSUMED') {"]],
      guard: (m) =>
        withFlow(m, {}, (world) => {
          const { presentation } = syntheticCapability(VECTOR.digest);
          world.flow.execute(observedWith(VECTOR, { presentation }));
          return world.flow.execute(observedWith(VECTOR, { presentation })).outcome === 'already-consumed';
        }),
    },
    {
      id: 'post-claim-expiry-skipped',
      file: FLOW,
      replacements: [['if (!stillValid)', 'if (false)']],
      guard: (m) => {
        let offset = 0;
        return withFlow(
          m,
          {
            clock: () => Date.now() + offset,
            fault: (point) => {
              if (point === 'after-claim') offset = 40_000;
            },
          },
          (world, domain) => world.flow.execute(observedWith(VECTOR, { presentation: syntheticCapability(VECTOR.digest).presentation })).outcome === 'consumed-not-attempted' && domain.records().length === 0,
        );
      },
    },
    {
      id: 'unknown-recorded-as-completed',
      file: FLOW,
      replacements: [["return settle('outcome-unknown', 'attempted-outcome-unknown', 'effect', 'SYNTHETIC_EFFECT_UNCONFIRMED');", "return settle('completed', 'completed-observed', 'effect', 'SYNTHETIC_EFFECT_APPLIED');"]],
      guard: (m) =>
        withFlow(
          m,
          {
            fault: (point) => {
              if (point === 'during-effect') throw new Error('the write failed half-way');
            },
          },
          async (world, domain) => {
            const { capability, presentation } = syntheticCapability(VECTOR.digest);
            const execution = world.flow.execute(observedWith(VECTOR, { presentation }));
            return execution.outcome === 'attempted-outcome-unknown' && (await domain.state(capability.capabilityId)).state === 'outcome-unknown';
          },
        ),
    },
    {
      id: 'effect-after-failed-claim',
      file: FLOW,
      replacements: [["return record('claim-unavailable', 'claim', 'LEDGER_UNAVAILABLE', bindingDigest, null);", "claim = { outcome: 'claimed', capabilityId, claimedAt: '' };"]],
      guard: (m) =>
        withFlow(m, { busyTimeoutMs: 50 }, async (world, domain) => {
          const { default: Database } = await import('better-sqlite3');
          const holder = new Database(domain.ledgerPath);
          try {
            holder.prepare('BEGIN IMMEDIATE').run();
            const execution = world.flow.execute(observedWith(VECTOR, { presentation: syntheticCapability(VECTOR.digest).presentation }));
            holder.prepare('ROLLBACK').run();
            return execution.outcome === 'claim-unavailable' && domain.records().length === 0;
          } finally {
            holder.close();
          }
        }),
    },
    {
      id: 'non-synthetic-action-performed',
      file: FLOW,
      replacements: [['if (!isSynthetic)', 'if (false)']],
      guard: (m) =>
        withFlow(m, {}, (world, domain) => {
          const execution = world.flow.execute(observedWith(VECTOR, { presentation: syntheticCapability(VECTOR.digest, { action: ACTION }).presentation }));
          return execution.outcome === 'refused' && execution.code === 'ACTION_NOT_SYNTHETIC' && domain.records().length === 0;
        }),
    },
    {
      id: 'unrecorded-outcome-reported-as-observed',
      file: FLOW,
      replacements: [["if (recorded !== 'recorded')", 'if (false)']],
      guard: (m) =>
        withFlow(
          m,
          {
            recordOutcome: () => {
              throw new Error('the ledger is gone');
            },
          },
          (world) => world.flow.execute(observedWith(VECTOR, { presentation: syntheticCapability(VECTOR.digest).presentation })).outcome === 'attempted-outcome-unknown',
        ),
    },
    {
      id: 'already-consumed-answered-as-success',
      file: FLOW,
      replacements: [['return 202;', 'return 201;']],
      guard: (m) =>
        withFlow(m, {}, (world) => {
          const status = world.flow.statusOf({ mode: 'synthetic-execution', outcome: 'already-consumed', stage: 'claim', code: 'CAPABILITY_CONSUMED', bindingDigest: VECTOR.digest, ledgerState: 'completed' }, (stage, code) =>
            referenceExecutorStatusOf({ mode: 'verification-only', outcome: 'refused', stage, code, bindingDigest: null }),
          );
          return status === 202;
        }),
    },
    {
      id: 'foreign-ledger-accepted',
      file: FLOW,
      replacements: [['if (ledger.audience !== configuration.audience)', 'if (false)']],
      guard: async (m) => {
        const domain = await freshDomain('executor-elsewhere');
        const ledger = await openExecutionCapabilityConsumptionLedger(domain.ledgerPath, { audience: 'executor-elsewhere', clock: () => Date.now() });
        try {
          const configuration = parseReferenceExecutorConfiguration(syntheticConfiguration(domain), EXECUTOR_ENVIRONMENT);
          const effect = { outputDirectory: domain.outputDirectory, apply: () => 'not-attempted' as const };
          m.createReferenceExecutorExecutionFlow({ configuration, pipeline: createReferenceExecutorVerificationPipeline(configuration, () => Date.now()), ledger, effect, clock: () => Date.now() });
          return false;
        } catch {
          return true;
        } finally {
          ledger.close();
        }
      },
    },
  ];
  for (const mutant of mutants) it(mutant.id, () => qualify(mutant));
});

// ── The synthetic effect ────────────────────────────────────────────────────

type EffectModule = typeof import('../reference-executor/synthetic-effect.js');
const EFFECT = join('reference-executor', 'synthetic-effect.js');

const input = (capabilityId: string) => ({ executorId: EXECUTOR_ID, audience: 'a', issuer: 'i', capabilityId, executionId: 'e', operation: SYNTHETIC_ACTION, target: RESOURCE, bindingDigest: VECTOR.digest, claimedAt: 'c', attemptedAt: 'a' });

describe('G-02C1B mutation — the synthetic effect', () => {
  const mutants: readonly Mutant<EffectModule>[] = [
    {
      id: 'record-name-not-checked',
      file: EFFECT,
      replacements: [["if (typeof capabilityId !== 'string' || !CAPABILITY_ID.test(capabilityId))", 'if (false)']],
      guard: async (m) => {
        const domain = await freshDomain();
        const effect = m.openSyntheticDeploymentEffect({ outputDirectory: domain.outputDirectory, durablyClaimed: () => true });
        effect.apply(input('../escaped'));
        return !existsSync(join(domain.root, 'escaped.json'));
      },
    },
    {
      id: 'existing-record-overwritten',
      file: EFFECT,
      replacements: [['const flags = O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW;', 'const flags = O_WRONLY | O_CREAT;']],
      // An earlier record at the name must never be written over (and is reported unknown).
      guard: async (m) => {
        const domain = await freshDomain();
        const id = 'c'.repeat(64);
        const earlier = join(domain.outputDirectory, `${id}.json`);
        writeFileSync(earlier, 'earlier\n', { mode: 0o600 });
        const observation = m.openSyntheticDeploymentEffect({ outputDirectory: domain.outputDirectory, durablyClaimed: () => true }).apply(input(id));
        return observation === 'unknown' && readFileSync(earlier, 'utf8') === 'earlier\n';
      },
    },
    {
      id: 'directory-identity-not-rechecked',
      file: EFFECT,
      replacements: [['if (!sameDirectory)', 'if (false)']],
      guard: async (m) => {
        const domain = await freshDomain();
        const effect = m.openSyntheticDeploymentEffect({ outputDirectory: domain.outputDirectory, durablyClaimed: () => true });
        // A different real, private directory at the same path: only the device/inode comparison tells them apart.
        renameSync(domain.outputDirectory, join(domain.root, 'moved'));
        mkdirSync(domain.outputDirectory, { mode: 0o700 });
        const id = 'd'.repeat(64);
        effect.apply(input(id));
        return !existsSync(join(domain.outputDirectory, `${id}.json`));
      },
    },
    {
      id: 'durable-claim-precondition-removed',
      file: EFFECT,
      replacements: [['if (!claimed)', 'if (false)']],
      guard: async (m) => {
        const domain = await freshDomain();
        const id = 'e'.repeat(64);
        return m.openSyntheticDeploymentEffect({ outputDirectory: domain.outputDirectory, durablyClaimed: () => false }).apply(input(id)) === 'not-attempted' && domain.records().length === 0;
      },
    },
    {
      id: 'effect-admitted-in-another-state',
      file: EFFECT,
      replacements: [["return state === 'claimed';", "return state !== 'absent';"]],
      guard: (m) => m.admitsEffect('claimed') && !m.admitsEffect('completed') && !m.admitsEffect('failed') && !m.admitsEffect('outcome-unknown') && !m.admitsEffect('absent'),
    },
    {
      id: 'shared-output-directory-accepted',
      file: EFFECT,
      replacements: [['if ((stat.mode & 0o022) !== 0)', 'if (false)']],
      guard: async (m) => {
        const domain = await freshDomain();
        const open = join(domain.root, 'open');
        mkdirSync(open);
        (await import('node:fs')).chmodSync(open, 0o777);
        try {
          m.openSyntheticDeploymentEffect({ outputDirectory: open, durablyClaimed: () => true });
          return false;
        } catch {
          return true;
        }
      },
    },
  ];
  for (const mutant of mutants) it(mutant.id, () => qualify(mutant));
});

// ── The closed mode ─────────────────────────────────────────────────────────

type ConfigurationModule = typeof import('../reference-executor/configuration.js');
const CONFIGURATION = join('reference-executor', 'configuration.js');

describe('G-02C1B mutation — the closed mode', () => {
  const mutants: readonly Mutant<ConfigurationModule>[] = [
    {
      id: 'default-mode-not-verification-only',
      file: CONFIGURATION,
      replacements: [["return 'verification-only';", "return 'synthetic-execution';"]],
      guard: (m) => {
        try {
          return m.parseReferenceExecutorConfiguration(executorConfiguration(), EXECUTOR_ENVIRONMENT).mode === 'verification-only';
        } catch {
          return false;
        }
      },
    },
    {
      id: 'synthetic-section-without-mode-accepted',
      file: CONFIGURATION,
      replacements: [["if (mode !== 'synthetic-execution' && fields['syntheticExecution'] !== undefined)", 'if (false)']],
      guard: (m) => {
        const section = syntheticConfiguration({ ledgerPath: '/var/lib/frontera-ref/ledger/c.sqlite', outputDirectory: '/var/lib/frontera-ref/output' })['syntheticExecution'];
        try {
          m.parseReferenceExecutorConfiguration(executorConfiguration({ syntheticExecution: section }), EXECUTOR_ENVIRONMENT);
          return false;
        } catch (error) {
          return (error as { readonly code?: unknown }).code === 'MODE_INCONSISTENT';
        }
      },
    },
  ];
  for (const mutant of mutants) it(mutant.id, () => qualify(mutant));
});
