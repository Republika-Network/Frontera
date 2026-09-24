import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createEnterprise } from '../composition/composition-root.js';
import { loadEnterpriseConfiguration } from '../configuration/enterprise-configuration.js';
import { MppChallengeConfigurationError } from '../mpp-challenge/composition.js';
import { fakepayNormalizer, testCounterpartyResolver, testSelector } from './mpp-challenge-support.js';

/**
 * P13 — composition posture: omitted, nothing changes; enabled without
 * governed actions, or with a malformed normalizer set, `createEnterprise`
 * fails rather than composing a weaker mode.
 */

describe('P13 composition', () => {
  it('omitted: no MPP surface, no store, no module', async () => {
    const enterprise = await createEnterprise({ configuration: loadEnterpriseConfiguration({}) });
    try {
      assert.equal(enterprise.mppChallengePayments, undefined);
      assert.equal(enterprise.mppChallengeContexts, undefined);
      assert.equal(enterprise.modules().some((module) => module.id === 'aoc.enterprise.mpp-business-operations'), false);
    } finally {
      await enterprise.close();
    }
  });

  it('enabled without governed actions: refused — a machine payment is a governed action, and there is no other path', async () => {
    await assert.rejects(
      createEnterprise({
        configuration: loadEnterpriseConfiguration({}),
        mppChallengePayments: { enabled: true, methods: [fakepayNormalizer()], selectChallenge: testSelector, resolveCounterparty: testCounterpartyResolver },
      }),
      MppChallengeConfigurationError,
    );
  });

  it('enabled: false composes nothing', async () => {
    const enterprise = await createEnterprise({
      configuration: loadEnterpriseConfiguration({}),
      mppChallengePayments: { enabled: false, methods: [], selectChallenge: testSelector, resolveCounterparty: testCounterpartyResolver },
    });
    try {
      assert.equal(enterprise.mppChallengePayments, undefined);
    } finally {
      await enterprise.close();
    }
  });

  it('the configuration names its own store file, distinct from every other store', () => {
    const configuration = loadEnterpriseConfiguration({});
    assert.equal(configuration.mppBusinessOperation.sqlitePath, '.data/mpp-business-operations.sqlite');
    assert.equal(loadEnterpriseConfiguration({ AOC_ENTERPRISE_MPP_BUSINESS_OPERATION_SQLITE_PATH: 'custom/mpp-ops.sqlite' }).mppBusinessOperation.sqlitePath, 'custom/mpp-ops.sqlite');
    const others = [configuration.persistence.sqlitePath, configuration.executionOutcome.sqlitePath, configuration.executionResolution.sqlitePath, configuration.boundedGrant.sqlitePath, configuration.kernelAuthority.sqlitePath];
    assert.equal(others.includes(configuration.mppBusinessOperation.sqlitePath), false);
  });
});
