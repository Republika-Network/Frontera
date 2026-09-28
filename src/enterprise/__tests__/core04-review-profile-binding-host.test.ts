import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { KernelEvaluationRequest } from '../../kernel/index.js';
import type { AuthorityControlledAuthorizationOutcome } from '../execution-governance/index.js';
import { createGovernanceProfileRegistry } from '../governance-profile/index.js';
import { DEPLOY, GOVERNANCE, PRODUCTION, Workspace, boot, committedRecord, createContextTable, govern, provision, secureEnv } from './core04-host-fixture.js';

/**
 * CORE-04 review (Codex P1) on the canonical Host — a direct Kernel caller
 * cannot choose a permissive Governance Profile.
 *
 * The governed-action API fills semantics from the trusted registry, but
 * Authority-Controlled Execution's `authorize()` accepts a request a host
 * assembled — the semantics in it are a claim. Before the fix, a deploy
 * request naming a profile that matched no declaration fell back to the empty
 * deployment-wide declarations: no required facts, no blocking obligation,
 * and a bounded grant past the change-approval obligation. Now the profile is
 * the one the registry resolves for deploy × production, and a disagreeing
 * claim is denied before any grant exists.
 */

const workspace = new Workspace();
after(() => workspace.cleanup());

const registry = createGovernanceProfileRegistry(GOVERNANCE);
const reference = (id: string) => {
  const profile = registry.profiles.find((entry) => entry.definition.profileId === id);
  assert.ok(profile !== undefined);
  return profile.reference;
};

describe('CORE-04 review — the effective profile on the canonical Host is the trusted one', () => {
  it('bogus id, wrong version, wrong digest, another configured profile: denied CONTEXT_PROFILE_UNTRUSTED, no grant, no adapter call', async () => {
    const booted = await boot(workspace, secureEnv(workspace.dir()), { context: createContextTable() });
    await provision(booted.host);
    // The genuine request, exactly as the governed path built it: withheld by its blocking obligation.
    const genuine = await govern(booted.baseUrl, { action: DEPLOY, resource: PRODUCTION, parameters: { releaseVersion: 'v1' } });
    assert.equal(genuine.body['status'], 'withheld', genuine.text);
    assert.equal(genuine.body['withheldBy'], 'obligations');
    const payload = (await committedRecord(booted.host, genuine)).request.requestPayload as unknown as KernelEvaluationRequest;
    const trusted = reference('production-deploy');
    assert.equal(payload.action.semantics?.governanceProfile.digest, trusted.digest);

    const ace = booted.host.enterprise.authorityControlledExecution;
    assert.ok(ace !== undefined);
    const claims = [
      ['bogus id', { ...trusted, id: 'no-such-profile' }],
      ['wrong version', { ...trusted, version: trusted.version + 1 }],
      ['wrong digest', { ...trusted, digest: `sha256:${'0'.repeat(64)}` }],
      ['another configured profile', reference('customer-data-read')],
    ] as const;
    for (const [index, [label, claim]] of claims.entries()) {
      const request: KernelEvaluationRequest = {
        ...payload,
        requestId: `aoc.gar:direct-${String(index)}`,
        requestedAt: new Date().toISOString(),
        action: { ...payload.action, semantics: { ...payload.action.semantics!, governanceProfile: claim } },
      };
      const authorization: AuthorityControlledAuthorizationOutcome = await ace.authorize({ request, grantExpiresAt: new Date(Date.now() + 600_000).toISOString() });
      assert.notEqual(authorization.outcome, 'grant-issued', label);
      assert.equal(authorization.decision.status, 'denied', label);
      assert.deepEqual(authorization.decision.reasonCodes, ['CONTEXT_PROFILE_UNTRUSTED'], label);
    }
    assert.equal(booted.calls.length, 0);
  });
});
