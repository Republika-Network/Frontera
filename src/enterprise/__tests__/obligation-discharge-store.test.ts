import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ObligationLifecycleService, type ObligationDischargeSource } from '../../features/obligation-runtime/index.js';
import {
  ObligationDischargeError,
  createInMemoryObligationDischargeStore,
  createObligationDischargeRecorder,
  createSqliteObligationDischargeStore,
  createStoredObligationDischargeProvider,
  type ObligationDischargeStore,
} from '../obligation-discharge/index.js';
import { testAuthenticity } from './authority-authenticity-fixture.js';

/**
 * CORE-04 — the obligation discharge store, recorder and provider in
 * isolation: attribution, organization scope, verification on read, and the
 * rule that a report's *worth* is decided by the configured source's
 * verification class through the unchanged obligation lifecycle — never by the
 * writer.
 */

const ORG = 'org-a';
const NOW = '2026-09-28T12:00:00.000Z';
const SOURCES: readonly ObligationDischargeSource[] = [
  { id: 'board', kind: 'approval_runtime', name: 'Board', verificationClass: 'independent' },
  { id: 'notes', kind: 'internal_store', name: 'Notes', verificationClass: 'self_reported' },
];
const CORRELATION = { requestId: 'aoc.gar:1', action: 'deploy-release', resourceScope: 'production' } as const;
const WRITER = { system: true, actorId: 'operator:board-sync' } as const;

const directories: string[] = [];
const stores: ObligationDischargeStore[] = [];
after(async () => {
  for (const store of stores) await store.close().catch(() => {});
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
});

async function stores2(): Promise<readonly [string, ObligationDischargeStore][]> {
  const dir = mkdtempSync(join(tmpdir(), 'frontera-obligations-'));
  directories.push(dir);
  const durable = await createSqliteObligationDischargeStore(join(dir, 'obligations.sqlite'), { now: () => NOW, organizationId: ORG, authenticity: testAuthenticity() });
  const ephemeral = createInMemoryObligationDischargeStore({ organizationId: ORG });
  stores.push(durable, ephemeral);
  return [
    ['sqlite', durable],
    ['memory', ephemeral],
  ];
}

const lifecycle = new ObligationLifecycleService({ sources: SOURCES, declaration: { requirements: [{ obligationType: 'change.approval', blocking: true }] } });

async function stateAfter(store: ObligationDischargeStore, organizationId = ORG): Promise<string | undefined> {
  const provider = createStoredObligationDischargeProvider(store, ORG);
  const { observations } = await provider.resolveObligationDischarges({ obligationTypes: ['change.approval'], correlation: CORRELATION, actorId: 'a', trustDomainId: 't', organizationId, at: NOW });
  return lifecycle.resolve(observations, CORRELATION, NOW).obligations[0]?.state;
}

describe('CORE-04 — a report’s worth comes from the configured source, never the writer', () => {
  it('a self-reported discharge reaches `discharged` (unsatisfied); only an independent source reaches `verified`', async () => {
    for (const [name, store] of await stores2()) {
      const recorder = createObligationDischargeRecorder({ store, sources: SOURCES, organizationId: ORG, now: () => NOW });
      assert.equal(await stateAfter(store), 'required', name);
      await recorder.record(WRITER, { correlation: CORRELATION, obligationType: 'change.approval', sourceId: 'notes', outcome: 'discharged', observedAt: '2026-09-28T11:59:00.000Z' });
      assert.equal(await stateAfter(store), 'discharged', name);
      const row = await recorder.record(WRITER, { correlation: CORRELATION, obligationType: 'change.approval', sourceId: 'board', outcome: 'discharged', observedAt: NOW, reference: 'CAB-1' });
      assert.equal(row.recordedBy, 'operator:board-sync', 'attributed');
      assert.equal(row.organizationId, ORG);
      assert.equal(await stateAfter(store), 'verified', name);
    }
  });

  it('§99 / §100 — a report never crosses organizations: another organization reads nothing', async () => {
    for (const [name, store] of await stores2()) {
      const recorder = createObligationDischargeRecorder({ store, sources: SOURCES, organizationId: ORG, now: () => NOW });
      await recorder.record(WRITER, { correlation: CORRELATION, obligationType: 'change.approval', sourceId: 'board', outcome: 'discharged', observedAt: NOW });
      assert.equal(await stateAfter(store, 'org-b'), 'required', name);
    }
  });

  it('refuses a future observation, an unconfigured source, a malformed kind and an untrusted writer before anything is written', async () => {
    for (const [name, store] of await stores2()) {
      const recorder = createObligationDischargeRecorder({ store, sources: SOURCES, organizationId: ORG, now: () => NOW });
      const base = { correlation: CORRELATION, obligationType: 'change.approval', sourceId: 'board', outcome: 'discharged' as const, observedAt: NOW };
      for (const input of [{ ...base, observedAt: '2026-09-28T12:00:01.000Z' }, { ...base, sourceId: 'elsewhere' }, { ...base, obligationType: 'Not A Kind' }]) {
        await assert.rejects(() => recorder.record(WRITER, input), ObligationDischargeError, name);
      }
      await assert.rejects(() => recorder.record({ system: true, actorId: '' }, base), ObligationDischargeError);
      assert.deepEqual(await store.read(ORG, CORRELATION), [], `${name}: nothing was written`);
    }
  });
});
