import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  EMERGENCY_CONTROL_REASON_CODES,
  EMERGENCY_CONTROL_SCOPES,
  applicableEmergencyControlScopes,
  createInMemoryEmergencyControlStore,
  emergencyControlKey,
  emergencyControlPermits,
  isWellFormedEmergencyControlDeclaration,
  isWellFormedEmergencyControlQuery,
  readEmergencyControl,
  type EmergencyControlAssessment,
  type EmergencyControlQuery,
  type EmergencyControlReaderPort,
} from '../index.js';

/**
 * The interlock, measured from the side that matters: **does it withhold?**
 *
 * Every row below asserts `emergencyControlPermits(...) === false` for a world
 * in which execution must not proceed, and `=== true` only where nothing
 * applicable is active. "The reader said something" is never the property under
 * test.
 */

const ISSUER = 'operator:on-call';
const AT = '2026-01-01T00:00:00.000Z';

function store() {
  return createInMemoryEmergencyControlStore();
}

function query(overrides: EmergencyControlQuery = {}): EmergencyControlQuery {
  return { organizationId: 'org-acme', actorId: 'agent-A', resource: 'vendor/V123', ...overrides };
}

describe('Emergency control — scopes, one row per currently reachable scope', () => {
  it('global blocks every query, including one that states nothing at all', () => {
    const controls = store();
    controls.activate({ scope: 'global', issuerRef: ISSUER, declaredAt: AT });
    for (const q of [query(), {}, { organizationId: 'org-other' }]) {
      assert.equal(emergencyControlPermits(controls.read(q)), false, `global must apply to ${JSON.stringify(q)}`);
    }
  });

  it('organization blocks its own tenant and leaves another tenant alone', () => {
    const controls = store();
    controls.activate({ scope: 'organization', value: 'org-acme', issuerRef: ISSUER, declaredAt: AT });
    assert.equal(emergencyControlPermits(controls.read(query())), false);
    assert.equal(emergencyControlPermits(controls.read(query({ organizationId: 'org-other' }))), true);
  });

  it('actor blocks its own actor and leaves another actor alone', () => {
    const controls = store();
    controls.activate({ scope: 'actor', value: 'agent-A', issuerRef: ISSUER, declaredAt: AT });
    assert.equal(emergencyControlPermits(controls.read(query())), false);
    assert.equal(emergencyControlPermits(controls.read(query({ actorId: 'agent-B' }))), true);
  });

  it('resource blocks its own resource and leaves another resource alone', () => {
    const controls = store();
    controls.activate({ scope: 'resource', value: 'vendor/V123', issuerRef: ISSUER, declaredAt: AT });
    assert.equal(emergencyControlPermits(controls.read(query())), false);
    assert.equal(emergencyControlPermits(controls.read(query({ resource: 'vendor/V999' }))), true);
  });

  it('adapter blocks only the adapter it names, and never an unrelated one', () => {
    const controls = store();
    controls.activate({ scope: 'adapter', value: 'adapter-a', issuerRef: ISSUER, declaredAt: AT });
    assert.equal(emergencyControlPermits(controls.read(query({ adapterId: 'adapter-a' }))), false);
    assert.equal(emergencyControlPermits(controls.read(query({ adapterId: 'adapter-b' }))), true);
    // A query that names no adapter at all is untouched by an adapter control.
    assert.equal(emergencyControlPermits(controls.read(query())), true);
  });

  it('workflow is modelled and matches exactly, so the scope is real rather than decorative', () => {
    const controls = store();
    controls.activate({ scope: 'workflow', value: 'workflow-1', issuerRef: ISSUER, declaredAt: AT });
    assert.equal(emergencyControlPermits(controls.read(query({ workflowId: 'workflow-1' }))), false);
    assert.equal(emergencyControlPermits(controls.read(query({ workflowId: 'workflow-2' }))), true);
    // And it is inert for every query that states no workflow — which is every
    // Governed Action query today, because no canonical trusted source exists.
    assert.equal(emergencyControlPermits(controls.read(query())), true);
  });

  it('matching is exact — no prefix, no glob, no regex', () => {
    const controls = store();
    controls.activate({ scope: 'organization', value: 'org-acme', issuerRef: ISSUER, declaredAt: AT });
    for (const organizationId of ['org-acme-2', 'org-acm', 'ORG-ACME', 'org-acme ']) {
      assert.equal(emergencyControlPermits(controls.read(query({ organizationId }))), true, `${organizationId} must not match 'org-acme'`);
    }
  });

  it('every scope in the closed vocabulary is exercised above, so the coverage is not partial', () => {
    assert.deepEqual([...EMERGENCY_CONTROL_SCOPES].sort(), ['actor', 'adapter', 'global', 'organization', 'resource', 'workflow']);
  });
});

describe('Emergency control — monotonic safety', () => {
  it('one applicable active control blocks, whatever the other applicable scopes say', () => {
    const controls = store();
    controls.activate({ scope: 'actor', value: 'agent-A', issuerRef: ISSUER, declaredAt: AT });
    const assessment = controls.read(query());
    assert.equal(assessment.state, 'blocked');
    assert.deepEqual(assessment.reasonCodes, [EMERGENCY_CONTROL_REASON_CODES.EMERGENCY_CONTROL_ACTIVE]);
  });

  it('a narrower control that is clear never overrides an active global one', () => {
    const controls = store();
    controls.activate({ scope: 'global', issuerRef: ISSUER, declaredAt: AT });
    // Explicitly releasing the narrower scopes cannot buy an exemption.
    controls.release({ scope: 'organization', value: 'org-acme', issuerRef: ISSUER, releasedAt: AT });
    controls.release({ scope: 'actor', value: 'agent-A', issuerRef: ISSUER, releasedAt: AT });
    assert.equal(emergencyControlPermits(controls.read(query())), false);
  });

  it('several matching controls are all reported, so an operator sees everything they must clear', () => {
    const controls = store();
    controls.activate({ scope: 'global', issuerRef: ISSUER, declaredAt: AT });
    controls.activate({ scope: 'organization', value: 'org-acme', issuerRef: ISSUER, declaredAt: AT });
    const assessment = controls.read(query());
    assert.equal(assessment.state, 'blocked');
    assert.deepEqual(
      assessment.state === 'blocked' ? assessment.matchedScopes.map((match) => match.scope).sort() : [],
      ['global', 'organization'],
    );
  });

  it('a released control stops blocking, and releasing is idempotent', () => {
    const controls = store();
    controls.activate({ scope: 'global', issuerRef: ISSUER, declaredAt: AT });
    assert.equal(emergencyControlPermits(controls.read(query())), false);
    controls.release({ scope: 'global', issuerRef: ISSUER, releasedAt: AT });
    controls.release({ scope: 'global', issuerRef: ISSUER, releasedAt: AT });
    assert.equal(emergencyControlPermits(controls.read(query())), true);
  });
});

describe('Emergency control — unreadable is never clear', () => {
  it('a reader that cannot answer reports unavailable, and unavailable withholds', () => {
    const controls = store();
    controls.simulateUnavailable(true);
    const assessment = controls.read(query());
    assert.equal(assessment.state, 'unavailable');
    assert.deepEqual(assessment.reasonCodes, [EMERGENCY_CONTROL_REASON_CODES.EMERGENCY_CONTROL_UNAVAILABLE]);
    assert.equal(emergencyControlPermits(assessment), false);
  });

  it('a reader that throws is unavailable rather than clear', () => {
    const thrower: EmergencyControlReaderPort = {
      read() {
        throw new Error('the control plane is down');
      },
    };
    assert.equal(readEmergencyControl(thrower, query()).state, 'unavailable');
  });

  it('a reader that returns something that is not an assessment is unavailable', () => {
    for (const returned of [undefined, null, 'clear', 42, { state: 'permitted' }]) {
      const broken = { read: () => returned } as unknown as EmergencyControlReaderPort;
      assert.equal(readEmergencyControl(broken, query()).state, 'unavailable', `a reader returning ${JSON.stringify(returned)} must not be believed`);
    }
  });

  it('a reader that reports blocked with no reason still blocks, with the canonical reason re-derived', () => {
    const sloppy = { read: () => ({ state: 'blocked', reasonCodes: [], matchedScopes: [] }) } as unknown as EmergencyControlReaderPort;
    const assessment = readEmergencyControl(sloppy, query());
    assert.equal(assessment.state, 'blocked');
    assert.deepEqual(assessment.reasonCodes, [EMERGENCY_CONTROL_REASON_CODES.EMERGENCY_CONTROL_ACTIVE]);
  });

  it('a malformed query is unavailable rather than matched against nothing', () => {
    const controls = store();
    for (const bad of [{ organizationId: '' }, { actorId: '' }, { adapterId: '' }, { resource: '' }, { workflowId: '' }]) {
      assert.equal(controls.read(bad).state, 'unavailable', `${JSON.stringify(bad)} must not be read as "no control applies"`);
      assert.equal(isWellFormedEmergencyControlQuery(bad), false);
    }
  });

  it('no reader at all is clear — an unconfigured deployment is unchanged, and says so explicitly', () => {
    assert.equal(readEmergencyControl(undefined, query()).state, 'clear');
  });
});

describe('Emergency control — the writer refuses what it could not read back', () => {
  it('a declaration missing what its scope requires is refused at write time', () => {
    const controls = store();
    const malformed = [
      { scope: 'organization', issuerRef: ISSUER, declaredAt: AT },
      { scope: 'global', value: 'org-acme', issuerRef: ISSUER, declaredAt: AT },
      { scope: 'actor', value: '', issuerRef: ISSUER, declaredAt: AT },
      { scope: 'actor', value: 'agent-A', issuerRef: '', declaredAt: AT },
      { scope: 'actor', value: 'agent-A', issuerRef: ISSUER, declaredAt: '' },
      { scope: 'tenant', value: 'org-acme', issuerRef: ISSUER, declaredAt: AT },
    ];
    for (const declaration of malformed) {
      assert.equal(isWellFormedEmergencyControlDeclaration(declaration as never), false, `${JSON.stringify(declaration)} must not be well formed`);
      assert.throws(() => controls.activate(declaration as never));
    }
    assert.deepEqual(controls.active(), []);
  });

  it('activating twice leaves the first declaration standing', () => {
    const controls = store();
    controls.activate({ scope: 'global', issuerRef: ISSUER, declaredAt: AT });
    controls.activate({ scope: 'global', issuerRef: 'operator:someone-else', declaredAt: '2026-02-02T00:00:00.000Z' });
    assert.deepEqual(controls.active(), [{ scope: 'global' }]);
  });
});

describe('Emergency control — the applicable-scope rule is shared, not restated', () => {
  it('global always applies, and every other scope applies only when the query states it', () => {
    assert.deepEqual(applicableEmergencyControlScopes({}), [{ scope: 'global' }]);
    assert.deepEqual(applicableEmergencyControlScopes({ organizationId: 'org-acme', adapterId: 'adapter-a' }), [
      { scope: 'global' },
      { scope: 'organization', value: 'org-acme' },
      { scope: 'adapter', value: 'adapter-a' },
    ]);
  });

  it('keys are exact and unambiguous across scopes', () => {
    assert.equal(emergencyControlKey('global'), 'global');
    assert.equal(emergencyControlKey('organization', 'org-a'), 'organization:org-a');
    assert.notEqual(emergencyControlKey('organization', 'org-a'), emergencyControlKey('actor', 'org-a'));
    assert.notEqual(emergencyControlKey('organization', 'org-a'), emergencyControlKey('organization', 'org-ab'));
  });

  it('a clear assessment carries no reason codes, so "clear" is never explained away', () => {
    const controls = store();
    const assessment: EmergencyControlAssessment = controls.read(query());
    assert.equal(assessment.state, 'clear');
    assert.deepEqual(assessment.reasonCodes, []);
  });
});
