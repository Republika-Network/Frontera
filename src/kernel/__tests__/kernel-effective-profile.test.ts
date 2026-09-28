import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { ObligationDischargeObservation } from '../../features/obligation-runtime/index.js';
import type { KernelEvaluationRequest } from '../contracts/kernel-request.js';
import type { ObligationDischargeProvider } from '../contracts/ports.js';
import { selectEffectiveProfile, type KernelEffectiveProfileResolver } from '../orchestration/effective-profile.js';
import { EFFECTIVE_PROFILE_UNTRUSTED_OBLIGATION, KernelObligationCapability, resolveKernelObligationFacts, resolveKernelObligations } from '../orchestration/obligation-adapter.js';

/**
 * CORE-04 review (Codex P1) — the effective Governance Profile a request's
 * context requirements **and** obligations are drawn from is established by
 * trusted configuration, never by the semantics the request carries. This
 * suite pins the selection rule and the obligation half; the context half is
 * in `kernel-trusted-context-profiles.test.ts`.
 */

const AT = '2026-09-28T12:00:00.000Z';
const DEPLOY = { id: 'production-deploy', version: 1, digest: `sha256:${'d'.repeat(64)}` } as const;
const READ = { id: 'customer-data-read', version: 1, digest: `sha256:${'e'.repeat(64)}` } as const;

/** The trusted registry's role: deploy × production is governed by DEPLOY; read × customer data by READ; anything else is unclassified. */
const REGISTRY: KernelEffectiveProfileResolver = (action, resource) => {
  if (action === 'deploy-release' && resource === 'production') return { kind: 'resolved', profile: DEPLOY };
  if (action === 'read-records' && resource === 'customer-data') return { kind: 'resolved', profile: READ };
  return { kind: 'unclassified' };
};

type Claim = { readonly id: string; readonly version: number; readonly digest: string } | undefined;

function request(claim: Claim, action = 'deploy-release', resourceScope = 'production', capability?: string): KernelEvaluationRequest {
  return {
    requestId: 'aoc.gar:direct',
    actor: { id: 'actor-agent', trustDomainId: 'td' },
    action: {
      type: action,
      resourceScope,
      ...(capability !== undefined ? { capability } : {}),
      ...(claim !== undefined ? { semantics: { actionClass: 'deploy', resourceClass: 'production_environment', governanceProfile: claim } } : {}),
    },
    organization: { id: 'org-a' },
    requestedAt: AT,
  };
}

describe('CORE-04 review — the selection rule', () => {
  const cases: readonly [string, KernelEvaluationRequest, string][] = [
    ['trusted profile, matching claim', request(DEPLOY), 'profile'],
    ['trusted profile, no claim (the trusted profile still applies)', request(undefined), 'profile'],
    ['bogus profile id', request({ ...DEPLOY, id: 'nope' }), 'refused'],
    ['wrong profile version', request({ ...DEPLOY, version: 7 }), 'refused'],
    ['wrong profile digest', request({ ...DEPLOY, digest: `sha256:${'0'.repeat(64)}` }), 'refused'],
    ['another configured profile', request(READ), 'refused'],
    ['unclassified action, no claim', request(undefined, 'something-else'), 'deployment'],
    ['unclassified action with a claim (the unknown-profile fallback)', request(READ, 'something-else'), 'refused'],
    ['capability resolving to another profile than the type', request(DEPLOY, 'deploy-release', 'production', 'read-records'), 'refused'],
  ];
  for (const [label, input, expected] of cases) {
    it(`${label} → ${expected}`, () => {
      const selection = selectEffectiveProfile(REGISTRY, input);
      assert.equal(selection.kind, expected);
      if (selection.kind === 'profile') assert.equal(selection.key, `${DEPLOY.id}@1#${DEPLOY.digest}`);
    });
  }
});

describe('CORE-04 review — obligations follow the trusted profile, and fail closed otherwise', () => {
  function capability(provider: ObligationDischargeProvider, resolveEffectiveProfile: KernelEffectiveProfileResolver | null = REGISTRY): KernelObligationCapability {
    return new KernelObligationCapability({
      provider,
      sources: [{ id: 'board', kind: 'approval_runtime', name: 'Board', verificationClass: 'independent' }],
      declaration: { requirements: [] },
      profileDeclarations: [{ profile: DEPLOY, declaration: { requirements: [{ obligationType: 'change.approval', blocking: true }] } }],
      ...(resolveEffectiveProfile !== null ? { resolveEffectiveProfile } : {}),
    });
  }
  function recording(observations: readonly ObligationDischargeObservation[] = []): { readonly provider: ObligationDischargeProvider; readonly calls: unknown[] } {
    const calls: unknown[] = [];
    return {
      calls,
      provider: {
        resolveObligationDischarges(query) {
          calls.push(query);
          return Promise.resolve({ observations });
        },
      },
    };
  }

  it('the trusted profile’s blocking obligation stands whether or not the request names the profile', async () => {
    for (const claim of [DEPLOY, undefined] as const) {
      const { provider, calls } = recording();
      const resolution = await resolveKernelObligations(capability(provider), request(claim), AT);
      assert.ok(resolution !== undefined);
      assert.deepEqual(resolution.declaredTypes, ['change.approval']);
      assert.equal(resolveKernelObligationFacts(resolution).eligible, false);
      assert.equal(calls.length, 1);
    }
  });

  for (const [label, claim] of [
    ['bogus id', { ...DEPLOY, id: 'nope' }],
    ['wrong version', { ...DEPLOY, version: 2 }],
    ['wrong digest', { ...DEPLOY, digest: `sha256:${'1'.repeat(64)}` }],
    ['another configured profile (declares no obligation)', READ],
  ] as const) {
    it(`${label}: never the empty deployment-wide declaration — an undischargeable blocking obligation, and no source is read`, async () => {
      // Even a verified discharge of the real obligation, and one of the refusal kind itself, cannot help.
      const { provider, calls } = recording([
        { obligationType: 'change.approval', correlation: { requestId: 'aoc.gar:direct', action: 'deploy-release', resourceScope: 'production' }, sourceId: 'board', outcome: 'discharged', observedAt: AT },
        { obligationType: EFFECTIVE_PROFILE_UNTRUSTED_OBLIGATION, correlation: { requestId: 'aoc.gar:direct', action: 'deploy-release', resourceScope: 'production' }, sourceId: 'board', outcome: 'waived', observedAt: AT },
      ]);
      const resolution = await resolveKernelObligations(capability(provider), request(claim), AT);
      assert.ok(resolution !== undefined, 'a refusal is never "no obligations"');
      assert.equal(resolution.resolved, false);
      assert.deepEqual(resolution.declaredTypes, [EFFECTIVE_PROFILE_UNTRUSTED_OBLIGATION]);
      const facts = resolveKernelObligationFacts(resolution);
      assert.equal(facts.eligible, false);
      assert.equal(facts.evaluation.allBlockingObligationsSatisfied, false);
      assert.equal(calls.length, 0);
    });
  }

  it('an unclassified request with no claim stands under the deployment-wide declaration (here: none)', async () => {
    const { provider } = recording();
    assert.equal(await resolveKernelObligations(capability(provider), request(undefined, 'something-else'), AT), undefined);
  });

  it('profile-keyed obligations without a trusted resolver are refused at construction', () => {
    assert.throws(() => capability(recording().provider, null), /trusted effective-profile resolver/);
  });
});
