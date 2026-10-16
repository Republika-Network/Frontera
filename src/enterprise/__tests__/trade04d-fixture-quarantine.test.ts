import { afterEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';

import { XRPL_SHARED_RESTART_QUARANTINE_LEDGERS, createXrplRestartQuarantine } from '../../features/xrpl-transport/index.js';
import { FakeXrplLedger } from './trade04c-execution-fixture.js';

/**
 * TRADE-04D final review — the fake ledger's `passQuarantine()` is a test
 * fixture: it must leave the executor's REAL restart quarantine (unchanged:
 * ≥ 204 ledgers, closing > 180 s after the executor started) satisfied however
 * long the Host took to boot between the fake ledger's construction and the
 * call. The quarantine itself is not touched or weakened here.
 *
 * Reproduces the S1 separate-process failure deterministically: a slow boot
 * (the executor starting 50 s after the fake ledger was built) left the
 * ledger 204 back closing before the executor's anchor.
 */

afterEach(() => mock.timers.reset());

async function quarantinedAfterBoot(bootDelayMs: number): Promise<{ readonly quarantined: boolean; readonly ledger: FakeXrplLedger }> {
  mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 9, 15, 12, 0, 0) });
  const ledger = new FakeXrplLedger();
  mock.timers.tick(bootDelayMs);
  // What the executor does at boot: its clock starts the quarantine, readiness observes the validated ledger.
  const quarantine = createXrplRestartQuarantine(Date.now());
  quarantine.observe(ledger.validatedIndex);
  ledger.passQuarantine();
  const quarantined = await quarantine.quarantined(ledger.validatedIndex, async (index) => ledger.closeTimeOf(index));
  return { quarantined, ledger };
}

describe('TRADE-04D — the fake ledger passes the real restart quarantine regardless of boot time', () => {
  for (const delay of [0, 30_000, 50_000, 120_000, 600_000]) {
    it(`a Host that took ${delay / 1000} s to boot after the fake ledger was built is past the quarantine`, async () => {
      const { quarantined, ledger } = await quarantinedAfterBoot(delay);
      assert.equal(quarantined, false);
      assert.ok(ledger.validatedIndex - 1_000 >= XRPL_SHARED_RESTART_QUARANTINE_LEDGERS, 'never fewer ledgers than the quarantine window');
    });
  }

  it('the fake history stays consistent: close times are a fixed function of the index (no rebasing), 4 s apart', async () => {
    mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 9, 15, 12, 0, 0) });
    const ledger = new FakeXrplLedger();
    const before = [1_000, 1_001, 1_100].map((index) => ledger.closeTimeOf(index));
    mock.timers.tick(90_000);
    ledger.passQuarantine();
    assert.deepEqual([1_000, 1_001, 1_100].map((index) => ledger.closeTimeOf(index)), before, 'a ledger observed before passQuarantine keeps its close time');
    assert.equal(ledger.closeTimeOf(1_001) - ledger.closeTimeOf(1_000), 4);
  });

  it('the quarantine is still enforced: a ledger that has not run long enough is refused', async () => {
    mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 9, 15, 12, 0, 0) });
    const ledger = new FakeXrplLedger();
    const quarantine = createXrplRestartQuarantine(Date.now());
    quarantine.observe(ledger.validatedIndex);
    ledger.advance(XRPL_SHARED_RESTART_QUARANTINE_LEDGERS - 1);
    assert.equal(await quarantine.quarantined(ledger.validatedIndex, async (index) => ledger.closeTimeOf(index)), true, 'fewer than 204 ledgers');
    ledger.advance(1);
    assert.equal(await quarantine.quarantined(ledger.validatedIndex, async (index) => ledger.closeTimeOf(index)), true, '204 ledgers whose close times precede the 180 s anchor');
  });
});
