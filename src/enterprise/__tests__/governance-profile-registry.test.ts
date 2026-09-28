import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { canonicalSerialize } from '../governance-store/canonical-json.js';
import {
  GOVERNANCE_PROFILE_REFUSALS,
  GovernanceProfileConfigurationError,
  createGovernanceProfileRegistry,
  governanceProfileDigest,
  type GovernanceConfiguration,
  type GovernanceProfileDefinition,
} from '../governance-profile/index.js';
import { CUSTOMER_DATA, DEPLOY_ACTION, EXPORT_ACTION, PAYMENT_ACTION, PRODUCTION_ENVIRONMENT, READ_ACTION, SEMANTIC_CONFIGURATION, TREASURY } from './governed-action-semantics-fixture.js';

/**
 * CORE-03 §58 — Governance Profiles are declarative, validated, versioned,
 * identified by their content, and closed: executable content has nowhere to
 * go. Every refusal below is `GovernanceProfileConfigurationError` from the one
 * production registry builder the composition root and the shipped Host both
 * call.
 */

const PROFILES = SEMANTIC_CONFIGURATION.profiles ?? [];
const READ_PROFILE = PROFILES[0] as GovernanceProfileDefinition;

function withProfiles(profiles: readonly unknown[]): GovernanceConfiguration {
  return { ...SEMANTIC_CONFIGURATION, profiles: profiles as readonly GovernanceProfileDefinition[] };
}

function refuses(configuration: unknown, why: string): void {
  assert.throws(() => createGovernanceProfileRegistry(configuration as GovernanceConfiguration), GovernanceProfileConfigurationError, why);
}

describe('CORE-03 §58 — a valid profile set loads, frozen and identified', () => {
  const registry = createGovernanceProfileRegistry(SEMANTIC_CONFIGURATION);

  it('loads every profile with id, version, owner, provenance and a content digest', () => {
    assert.equal(registry.configured, true);
    assert.deepEqual(registry.profiles.map((profile) => `${profile.reference.id}@${profile.reference.version}`), ['customer-data-export@2', 'customer-data-read@1', 'production-deploy@1']);
    for (const profile of registry.profiles) {
      assert.match(profile.reference.digest, /^sha256:[0-9a-f]{64}$/);
      assert.equal(profile.source, 'host-configuration');
      assert.equal(profile.reference.digest, governanceProfileDigest(profile.definition));
      assert.equal(Object.isFrozen(profile.definition), true);
    }
    assert.equal(Object.isFrozen(registry), true);
  });

  it('resolves action × resource to classes and exactly one profile — read and export differ on the same resource', () => {
    const read = registry.resolve(READ_ACTION, CUSTOMER_DATA);
    const exported = registry.resolve(EXPORT_ACTION, CUSTOMER_DATA);
    assert.equal(read.kind, 'resolved');
    assert.equal(exported.kind, 'resolved');
    if (read.kind !== 'resolved' || exported.kind !== 'resolved') return;
    assert.deepEqual([read.semantics.actionClass, read.semantics.resourceClass, read.semantics.governanceProfile.id], ['read', 'customer_dataset', 'customer-data-read']);
    assert.deepEqual([exported.semantics.actionClass, exported.semantics.resourceClass, exported.semantics.governanceProfile.id], ['export', 'customer_dataset', 'customer-data-export']);
  });

  it('an unclassified pair is unclassified; a half-classified or ungoverned pair is refused, never downgraded', () => {
    assert.deepEqual(registry.resolve(PAYMENT_ACTION, TREASURY), { kind: 'unclassified' });
    assert.deepEqual(registry.resolve(PAYMENT_ACTION, CUSTOMER_DATA), { kind: 'refused', reason: GOVERNANCE_PROFILE_REFUSALS.GOVERNANCE_ACTION_CLASS_UNKNOWN });
    assert.deepEqual(registry.resolve(READ_ACTION, TREASURY), { kind: 'refused', reason: GOVERNANCE_PROFILE_REFUSALS.GOVERNANCE_RESOURCE_CLASS_UNKNOWN });
    assert.deepEqual(registry.resolve(DEPLOY_ACTION, CUSTOMER_DATA), { kind: 'refused', reason: GOVERNANCE_PROFILE_REFUSALS.GOVERNANCE_PROFILE_UNKNOWN }, 'deploy × customer_dataset has no profile');
    assert.deepEqual(registry.resolve(READ_ACTION, PRODUCTION_ENVIRONMENT), { kind: 'refused', reason: GOVERNANCE_PROFILE_REFUSALS.GOVERNANCE_PROFILE_UNKNOWN });
    assert.deepEqual(
      registry.resolve('Read-Customer-Records', CUSTOMER_DATA),
      { kind: 'refused', reason: GOVERNANCE_PROFILE_REFUSALS.GOVERNANCE_ACTION_CLASS_UNKNOWN },
      'identifiers are exact: another spelling is an unknown action over a classified resource — refused, never unclassified',
    );
  });

  it('flags a context key that would shadow a declared dimension, in any case', () => {
    for (const key of ['recordCount', 'RecordCount', 'RECORDCOUNT', 'destination']) assert.equal(registry.shadowsDeclaredDimension(key), true, key);
    for (const key of ['passportId', 'constructor', '__proto__']) assert.equal(registry.shadowsDeclaredDimension(key), false, key);
  });

  it('an absent configuration governs nothing: the pre-CORE-03 world exactly', () => {
    const empty = createGovernanceProfileRegistry(undefined);
    assert.equal(empty.configured, false);
    assert.deepEqual(empty.resolve(READ_ACTION, CUSTOMER_DATA), { kind: 'unclassified' });
  });
});

describe('CORE-03 §20 / §59 — identity is content: versioned, digested, never silently mutable', () => {
  it('the digest is canonical content under a format tag, and changes with any edit — even with the version unchanged', () => {
    const base = governanceProfileDigest(READ_PROFILE);
    assert.equal(base, governanceProfileDigest({ ...READ_PROFILE }), 'deterministic');
    assert.notEqual(base, governanceProfileDigest({ ...READ_PROFILE, relevantPolicies: ['another-policy'] }));
    assert.notEqual(base, governanceProfileDigest({ ...READ_PROFILE, parameters: [{ dimension: 'recordCount', required: false }] }));
    assert.notEqual(base, governanceProfileDigest({ ...READ_PROFILE, provenance: { authoredBy: 'operator:someone-else', approvedBy: 'operator:security' } }));
    assert.ok(canonicalSerialize({ format: 'frontera.governance-profile.v1', profile: READ_PROFILE }).length > 0, 'reuses the Governance Store canonicalizer, not a new one');
  });

  it('two versions of one profile cannot both be active in one registry', () => {
    refuses(withProfiles([...PROFILES, { ...READ_PROFILE, version: 2, actionClass: 'export', resourceClass: 'production_environment' }]), 'same profileId twice');
    refuses(withProfiles([...PROFILES, { ...READ_PROFILE, profileId: 'Customer-Data-Read', actionClass: 'deploy', resourceClass: 'customer_dataset' }]), 'case-only duplicate profileId');
  });

  it('two profiles cannot govern one Action × Resource combination', () => {
    refuses(withProfiles([...PROFILES, { ...READ_PROFILE, profileId: 'customer-data-read-alt' }]), 'duplicate combination');
  });
});

describe('CORE-03 §58 — invalid profiles are refused, and executable content is impossible by schema', () => {
  it('refuses an undeclared (executable-looking) property anywhere in a profile', () => {
    for (const extra of [
      { rule: 'recordCount > 100' },
      { condition: { field: 'parameter', operator: 'greater_than', value: 100 } },
      { script: 'return true' },
      { allow: true },
      { status: 'active' },
    ]) {
      refuses(withProfiles([{ ...READ_PROFILE, ...extra }]), JSON.stringify(extra));
    }
    refuses(withProfiles([{ ...READ_PROFILE, provenance: { authoredBy: 'a', approvedBy: 'b', signature: 'x' } }]), 'closed provenance');
    refuses(withProfiles([{ ...READ_PROFILE, parameters: [{ dimension: 'recordCount', required: true, maximum: 100 }] }]), 'no threshold inside a profile parameter');
  });

  it('refuses a function, a number where an identifier belongs, or a string where a boolean belongs', () => {
    refuses(withProfiles([{ ...READ_PROFILE, relevantPolicies: [() => true] }]), 'a function is not a reference');
    refuses(withProfiles([{ ...READ_PROFILE, owner: 42 }]), 'owner must be an identifier');
    refuses(withProfiles([{ ...READ_PROFILE, parameters: [{ dimension: 'recordCount', required: 'yes' }] }]), 'required must be a boolean');
  });

  it('refuses unknown classes, undeclared dimensions, duplicate dimensions, bad versions and malformed identifiers', () => {
    refuses(withProfiles([{ ...READ_PROFILE, actionClass: 'delete' }]), 'undeclared action class');
    refuses(withProfiles([{ ...READ_PROFILE, resourceClass: 'credential' }]), 'undeclared resource class');
    refuses(withProfiles([{ ...READ_PROFILE, parameters: [{ dimension: 'blastRadius', required: true }] }]), 'undeclared dimension');
    refuses(withProfiles([{ ...READ_PROFILE, parameters: [{ dimension: 'recordCount', required: true }, { dimension: 'recordCount', required: false }] }]), 'duplicate dimension');
    for (const version of [0, -1, 1.5, '1', Number.MAX_SAFE_INTEGER]) refuses(withProfiles([{ ...READ_PROFILE, version }]), `version ${String(version)}`);
    for (const profileId of ['', 'Customer', 'a/b', '../x', 'a b']) refuses(withProfiles([{ ...READ_PROFILE, profileId }]), `profileId ${profileId}`);
    refuses(withProfiles([{ ...READ_PROFILE, materialFacts: ['destination', 'destination'] }]), 'duplicate material fact');
  });

  it('refuses an unsupported comparator on a dimension, and a case-only duplicate dimension', () => {
    refuses({ ...SEMANTIC_CONFIGURATION, parameterDimensions: [{ id: 'environment', type: 'token', bound: 'maximum' }] }, 'maximum over a token');
    refuses({ ...SEMANTIC_CONFIGURATION, parameterDimensions: [...(SEMANTIC_CONFIGURATION.parameterDimensions ?? []), { id: 'RecordCount', type: 'integer', bound: 'maximum' }] }, 'case-only duplicate dimension');
  });

  it('refuses an action or resource in two classes, an empty class, and an unknown top-level key', () => {
    refuses({ ...SEMANTIC_CONFIGURATION, actionClasses: [{ id: 'read', actions: [READ_ACTION] }, { id: 'export', actions: [READ_ACTION] }] }, 'action in two classes');
    refuses({ ...SEMANTIC_CONFIGURATION, resourceClasses: [{ id: 'customer_dataset', resources: [] }] }, 'empty class');
    refuses({ ...SEMANTIC_CONFIGURATION, defaultProfile: 'customer-data-read' }, 'no default profile exists, and no key can declare one');
  });
});
