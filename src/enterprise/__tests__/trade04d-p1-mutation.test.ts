import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { TradeReservationInput } from '../xrpl-trade-execution/index.js';
import { readOnlyTradeRecoveryLedger } from '../xrpl-trade-execution/index.js';
import { testAccount } from './trade04b-xrpl-fixture.js';
import { FakeXrplLedger, NETWORK_ID, ORG } from './trade04c-execution-fixture.js';
import { intentRecordFor } from './trade04d-intent-fixture.js';

/**
 * TRADE-04D post-merge hardening — mutation qualification of P1: the
 * recovery coordinator connects its own client before a validated read. The
 * mutant edits the compiled module at one site and must be **detected** by
 * its guard; the guard must hold for the shipped module. The Host
 * composition's identical port is pinned structurally
 * (`trade04d-p1-resolver-connection.test.ts`) and exercised end to end on the
 * shipped Host.
 */

const load = createRequire(__filename);
const ENTERPRISE = join(__dirname, '..');

interface Mutant<M> {
  readonly id: string;
  readonly file: string;
  readonly replacements: readonly (readonly [string, string])[];
  readonly guard: (module: M) => boolean | Promise<boolean>;
}

async function qualify<M>(mutant: Mutant<M>): Promise<void> {
  const path = join(ENTERPRISE, mutant.file);
  let source = readFileSync(path, 'utf8');
  for (const [search, replace] of mutant.replacements) {
    assert.equal(source.split(search).length - 1, 1, `${mutant.id}: the mutation site occurs exactly once in ${mutant.file}: ${search.slice(0, 100)}`);
    source = source.split(search).join(replace);
  }
  const mutantPath = path.replace(/\.js$/, `.mutant-${mutant.id}.js`);
  writeFileSync(mutantPath, source);
  try {
    assert.equal(await mutant.guard(load(path) as M), true, `${mutant.id}: the guard holds for the shipped module`);
    assert.equal(await mutant.guard(load(mutantPath) as M), false, `${mutant.id}: the guard detects the mutation`);
  } finally {
    delete load.cache[load.resolve(mutantPath)];
    rmSync(mutantPath, { force: true });
  }
}

type CoordinatorModule = typeof import('../xrpl-trade-execution/trade-recovery-coordinator.js');
const COORDINATOR = 'xrpl-trade-execution/trade-recovery-coordinator.js';

const OWNER = testAccount();
const DELEGATE = testAccount();
const reservation: TradeReservationInput = {
  executionId: 'aoc.exec:p1-mutant',
  account: OWNER,
  sequence: 40,
  lastLedgerSequence: 520,
  minLedger: 501,
  transactionHash: 'B'.repeat(64),
  evidence: { organizationId: ORG, subject: 's', requestId: 'r', decisionId: 'd', boundedGrantId: 'g', proposalDigest: `sha256:${'a'.repeat(64)}`, delegateAccount: DELEGATE, signerId: 'signer', signerRequestId: 'f'.repeat(64), signingPublicKey: `ED${'1'.repeat(64)}`, keyAuthority: 'master-key', preparedDigest: `sha256:${'b'.repeat(64)}`, delegationAssessmentDigest: `sha256:${'c'.repeat(64)}`, delegationFactsDigest: `sha256:${'d'.repeat(64)}`, referenceLedgerIndex: 500, referenceLedgerHash: 'E'.repeat(64), delegationLedgerIndex: 500, delegateRootLedgerIndex: 500, ownerRootLedgerIndex: 500, fee: '12', ledgerProvenance: 'injected-ledger-client' },
};

describe('TRADE-04D P1 mutations — the coordinator connects its own client before a validated read', () => {
  const signing = intentRecordFor(reservation, 'signing');
  const mutants: readonly Mutant<CoordinatorModule>[] = [
    {
      id: 'coordinator-reads-before-connecting',
      file: COORDINATOR,
      replacements: [['await ledger.connect();', '']],
      // A client that answers only once it connected, and nothing else connects it: the intent past LastLedgerSequence must still be proven.
      guard: async (m) => {
        const fake = new FakeXrplLedger();
        fake.strictConnections = true;
        fake.fund(OWNER, signing.sequence);
        const coordinator = m.createTradeRecoveryCoordinator({ networkId: NETWORK_ID, requestTimeoutMs: 1_000, maxValidatedLedgerAgeSeconds: 10, ledger: readOnlyTradeRecoveryLedger(fake.client(NETWORK_ID, { claimSubmission: async () => {} })), interlock: { read: async () => undefined, readIntent: async () => signing } });
        const report = await coordinator.assess(signing.executionId);
        return report.assessment.class === 'proven-not-included' && report.assessment.ledger.via === 'owner-sequence';
      },
    },
  ];
  for (const mutant of mutants) it(`detected: ${mutant.id}`, () => qualify(mutant));
});
