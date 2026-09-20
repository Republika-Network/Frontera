import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { createInMemoryEmergencyControlStore, type EmergencyControlReaderPort } from '../../features/emergency-control-runtime/index.js';
import {
  createInMemoryBoundedGrantStore,
  type BoundedGrantStorePort,
  type IssueBoundedGrantInput,
} from '../../features/grant-runtime/index.js';
import { ALLOWED_INTENT, IDENTITY, NOW, buildGovernedWorld } from './governed-action-support.js';

/**
 * EMERGENCY-10, given its own suite because it is the invariant most easily
 * satisfied in appearance and broken in substance.
 *
 * `BoundedGrantStorePort.issue` takes a **synchronous** `commitGuard`, called
 * inside the store's critical section with no `await` between the read that
 * decides and the write that records. An emergency-control read placed
 * anywhere else — before `issueGrant`, after it, or behind a promise inside the
 * guard — leaves a window in which a stop activates and a grant is minted under
 * it anyway.
 *
 * So two things are proven here: that the read really happens inside the guard,
 * and that nothing on that path can suspend.
 */

const ISSUER = 'operator:on-call';

/** Comments stripped: what is forbidden is a *call*, not a word the file uses to explain the rule. */
function codeOf(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .map((line) => {
      const index = line.indexOf('//');
      return index === -1 ? line : line.slice(0, index);
    })
    .join('\n');
}

describe('EMERGENCY-10 — the commit-boundary read happens inside the guard', () => {
  it('the guard runs inside the store transaction, and the interlock is read there', async () => {
    const order: string[] = [];
    const emergencyControl: EmergencyControlReaderPort = {
      read(query) {
        order.push(`read:${query.adapterId ?? 'no-adapter'}`);
        return { state: 'clear', reasonCodes: [] };
      },
    };

    const inner = createInMemoryBoundedGrantStore();
    const grantStore: BoundedGrantStorePort = {
      async issue(input: IssueBoundedGrantInput) {
        order.push('store.issue:enter');
        const wrapped: IssueBoundedGrantInput = {
          grant: input.grant,
          commitGuard: () => {
            order.push('commitGuard:enter');
            const precondition = input.commitGuard();
            order.push('commitGuard:exit');
            return precondition;
          },
        };
        const outcome = await inner.issue(wrapped);
        order.push('store.issue:exit');
        return outcome;
      },
      read: (grantId) => inner.read(grantId),
      revoke: (input) => inner.revoke(input),
    };

    const world = buildGovernedWorld({ emergencyControl, grantStore });
    const result = await world.orchestrator.govern(IDENTITY, ALLOWED_INTENT);
    assert.equal(result.status, 'executed', JSON.stringify(result));

    const guardEnter = order.indexOf('commitGuard:enter');
    const guardExit = order.indexOf('commitGuard:exit');
    assert.ok(guardEnter !== -1 && guardExit !== -1, 'the store must still call the synchronous commit guard');

    // Exactly one interlock read lies strictly between the guard's entry and
    // its exit. Admission's read is before the store is entered at all, and the
    // exercise read is after it has returned.
    const readsInsideGuard = order.map((entry, index) => ({ entry, index })).filter(({ entry, index }) => entry.startsWith('read:') && index > guardEnter && index < guardExit);
    assert.equal(readsInsideGuard.length, 1, `expected exactly one read inside the commit guard, saw ${JSON.stringify(order)}`);
    assert.ok(order.indexOf('store.issue:enter') < guardEnter, 'the guard runs inside the store call');
    assert.ok(guardExit < order.indexOf('store.issue:exit'), 'the guard returns before the store call does');
  });

  it('a stop activated between admission and the guard is seen by the guard', async () => {
    const emergencyControl = createInMemoryEmergencyControlStore();
    const world = buildGovernedWorld({
      emergencyControl,
      beforeGrantIssue: () => emergencyControl.activate({ scope: 'global', issuerRef: ISSUER, declaredAt: NOW }),
    });
    const result = await world.orchestrator.govern(IDENTITY, ALLOWED_INTENT);
    assert.equal(result.status === 'withheld' ? result.withheldBy : undefined, 'emergency-control');
    assert.equal(world.adapter.callCount, 0);
    assert.equal(world.issueOutcomes[0]?.outcome, 'refused', 'the store was asked and refused: no grant exists');
  });

  it('a reader that returns a promise is not believed — it is unreadable, which withholds', async () => {
    // The shape that would silently defeat the invariant: a "synchronous" read
    // that actually resolves later. It is refused rather than awaited.
    const promising = { read: () => Promise.resolve({ state: 'clear', reasonCodes: [] }) } as unknown as EmergencyControlReaderPort;
    const world = buildGovernedWorld({ emergencyControl: promising });
    const result = await world.orchestrator.govern(IDENTITY, ALLOWED_INTENT);
    assert.equal(result.status === 'withheld' ? result.withheldBy : undefined, 'emergency-control');
    assert.equal(world.adapter.callCount, 0);
  });
});

describe('EMERGENCY-10 — nothing on the commit-boundary path can suspend', () => {
  const ISSUANCE_CORE = 'src/enterprise/execution-governance/issuance-core.ts';
  const ISSUANCE_SERVICE = 'src/features/grant-runtime/services/grant-issuance-service.ts';

  /** The body of the synchronous `revalidateSource` the issuance core hands the grant issuance service — the function the commit guard calls. */
  function commitBoundaryBody(): string {
    const code = codeOf(ISSUANCE_CORE);
    const start = code.indexOf('revalidateSource: (correlation: GrantCorrelation): GrantSourceAuthorization | undefined => {');
    assert.notEqual(start, -1, 'the commit-boundary revalidator must remain a single, findable function');
    const end = code.indexOf('\n      },', start);
    assert.notEqual(end, -1, 'the commit-boundary revalidator must remain a single, findable function');
    return code.slice(start, end);
  }

  it('the commit-boundary revalidator contains no await, no async, no promise and no I/O', () => {
    const body = commitBoundaryBody();
    for (const forbidden of [/\bawait\b/, /\basync\b/, /\.then\s*\(/, /Promise\s*\./, /\bfetch\s*\(/, /readFile/, /writeFile/, /better-sqlite3/, /\bstore\s*\./, /getByDecisionId|getByEvaluationId|getByRequestId/]) {
      assert.equal(forbidden.test(body), false, `the commit-boundary path must not contain ${String(forbidden)} — a suspension there reopens the TOCTOU window the guard exists to close`);
    }
    assert.ok(/readEmergencyControl\(emergencyControl/.test(body), 'the interlock must actually be read there, or this suite is vacuous');
  });

  it('the commit guard the grant issuance service builds is synchronous, and declares itself so', () => {
    const code = codeOf(ISSUANCE_SERVICE);
    const start = code.indexOf('const commitGuard = (): GrantCommitPrecondition => {');
    assert.notEqual(start, -1, 'the commit guard must remain a synchronous arrow function returning a precondition');
    const end = code.indexOf('\n      };', start);
    const body = code.slice(start, end);
    for (const forbidden of [/\bawait\b/, /\basync\b/, /\.then\s*\(/, /\bfetch\s*\(/]) {
      assert.equal(forbidden.test(body), false, `the commit guard must not contain ${String(forbidden)}`);
    }
  });

  it('the port itself forbids an asynchronous reader, so the rule is a type rule and not only a convention', () => {
    const port = codeOf('src/features/emergency-control-runtime/domain/emergency-control-port.ts');
    assert.ok(/read\(query: EmergencyControlQuery\): EmergencyControlAssessment;/.test(port));
    assert.equal(/read\([^)]*\):\s*Promise</.test(port), false);
  });

  it('the whole emergency-control module is synchronous, so no implementation of the port can smuggle one in', () => {
    for (const file of ['domain/emergency-control-port.ts', 'domain/emergency-control-signal.ts', 'domain/emergency-control-reason-codes.ts', 'services/in-memory-emergency-control-store.ts']) {
      const code = codeOf(`src/features/emergency-control-runtime/${file}`);
      assert.equal(/\bawait\b|\basync\b/.test(code), false, `${file} must contain no await or async`);
    }
  });

  it('the durable store answers the read synchronously — better-sqlite3 is why this is possible at all', () => {
    const code = codeOf('src/enterprise/emergency-control/sqlite-emergency-control-store.ts');
    const start = code.indexOf('read(query: EmergencyControlQuery): EmergencyControlAssessment {');
    assert.notEqual(start, -1, 'the durable read must remain a synchronous method');
    const end = code.indexOf('\n    },', start);
    const body = code.slice(start, end);
    assert.equal(/\bawait\b|\basync\b|\.then\s*\(/.test(body), false, 'the durable read must not suspend');
  });
});
