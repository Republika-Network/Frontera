// RN-CONFORM-04 — the synthetic reference PEP over the REAL document-use decision pipeline.
//
// The same enforcement point the conformance scenarios challenge (dist/src/enterprise/__tests__/conformance-reference-pep.js)
// is wired here to an authorization adapter that runs the shipped FV-P2 eligibility, FV-P3 policy and FV-P4C signed-status
// freshness functions of @aoc-enterprise/sovereign-receiver-verification for every decision and every revocation check.
// The PEP itself is unchanged: it still verifies the decision's signature and bindings, the freshness ceiling and the
// revocation state before any protected byte is read.
//
// Synthetic fixture only (tests/fixtures/fv-p4c2a-sqlite-status-history/chain.json: pre-signed, no private key). Nothing here
// contacts Fileverse or any network. The adapter's own decision signature is a test key of the PEP module.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  DOCUMENT_USE_FRESHNESS_CEILINGS,
  checkDocumentUseFreshness,
  createInMemoryStatusHighWaterMarkStore,
  establishStatusHistory,
  evaluateDocumentUsePolicy,
  verifyDocumentUseEligibility,
} from '@aoc-enterprise/sovereign-receiver-verification';

import {
  AUTHORITY_KEY,
  DECISION_CEILING_SECONDS,
  DECISION_SCHEMA,
  FV_ACTION_OF,
  ORG_ALPHA,
  createReferenceIntegration,
  fixtureClock,
  signReferenceDecision,
} from '../dist/src/enterprise/__tests__/conformance-reference-pep.js';

const FIXTURE = JSON.parse(readFileSync(new URL('./fixtures/fv-p4c2a-sqlite-status-history/chain.json', import.meta.url), 'utf8'));
const S = FIXTURE.statuses;
const CONTENT = new Uint8Array(Buffer.from(FIXTURE.contentBase64, 'base64'));
const resolver = {
  resolveVerificationKey: (issuer) => (issuer === FIXTURE.registrant.issuer ? { keyId: FIXTURE.registrant.keyId, issuer, algorithm: 'ed25519' } : undefined),
};
const AT = Date.parse('2026-10-28T12:00:00Z');
const iso = (ms) => new Date(ms).toISOString().replace('.000Z', 'Z');
const STRANGER = 'did:example:rn-conform-04-stranger';

/** The fixture document as the PEP's world: one organization, the FV receiver and a stranger. */
function fvWorld() {
  return {
    principals: new Map([
      [FIXTURE.receiver, { principalId: FIXTURE.receiver, organizationId: ORG_ALPHA, roles: [] }],
      [STRANGER, { principalId: STRANGER, organizationId: ORG_ALPHA, roles: [] }],
    ]),
    documents: new Map([
      [
        FIXTURE.sovereignAssetId,
        {
          documentId: FIXTURE.sovereignAssetId,
          organizationId: ORG_ALPHA,
          locator: `synthetic-storage://${ORG_ALPHA}/fv-fixture`,
          protectedDocument: true,
          content: CONTENT,
          terms: { claimId: FIXTURE.terms.claimId, digest: FIXTURE.terms.claimDigest, rules: { 'document.open': [], 'document.export': [], 'document.modify-protected-terms': [] } },
        },
      ],
    ]),
  };
}

/** Authorization + revocation ports backed by the real FV pipeline. `status()` is the registrant-signed status in force. */
function realPipeline(clock, status) {
  const history = createInMemoryStatusHighWaterMarkStore();
  let eligibility;
  let anchored = false;
  let counter = 0;
  const run = async (action, principal) => {
    eligibility ??= await verifyDocumentUseEligibility(FIXTURE.bundleText, { verificationKeyResolver: resolver, expectedSovereignAssetId: FIXTURE.sovereignAssetId, contentBytes: CONTENT });
    assert.equal(eligibility.outcome, 'eligible_for_evaluation');
    const evaluationTime = iso(clock.ms());
    if (!anchored) {
      const established = await establishStatusHistory(S.active1.text, { verificationKeyResolver: resolver, historyStore: history, expectedSovereignAssetId: FIXTURE.sovereignAssetId, expectedRegistrant: FIXTURE.registrant.issuer, expectedManifestDigest: FIXTURE.manifestDigest, evaluationTime });
      assert.equal(established.reason, 'ESTABLISHED');
      anchored = true;
    }
    const policy = evaluateDocumentUsePolicy(eligibility, { action }, { receiverPrincipal: principal, evaluationTime, expectedSovereignAssetId: FIXTURE.sovereignAssetId, policyReference: { ...FIXTURE.terms } });
    counter += 1;
    const fresh = await checkDocumentUseFreshness(policy, status().text, { verificationKeyResolver: resolver, evaluationTime, operationId: `rn-conform-04-${counter}`, maxStatusAgeSeconds: { ...DOCUMENT_USE_FRESHNESS_CEILINGS }, historyStore: history });
    return { policy: policy.decision, verdict: fresh.freshnessVerdict, after: fresh.policyDecisionAfterFreshness };
  };
  return {
    calls: () => counter,
    async decide(query) {
      const r = await run(FV_ACTION_OF[query.operation], query.principalId);
      const issuedAtMs = clock.ms();
      return {
        kind: 'decision',
        decision: signReferenceDecision(
          { schema: DECISION_SCHEMA, decisionId: `fv-${counter}`, effect: r.after === 'ALLOWED' ? 'ALLOW' : 'DENY', reason: `FV:${r.policy}:${r.verdict}`, ...query, issuedAtMs, expiresAtMs: issuedAtMs + DECISION_CEILING_SECONDS[query.operation] * 1000 },
          AUTHORITY_KEY,
        ),
      };
    },
    async revocationOf() {
      const r = await run('aoc.licensing:access', FIXTURE.receiver);
      if (r.verdict === 'FRESH') return 'NOT_REVOKED';
      return r.verdict === 'REVOKED' || r.verdict === 'WITHDRAWN' ? 'REVOKED' : 'UNKNOWN';
    },
  };
}

function setup() {
  const clock = fixtureClock(AT);
  let current = S.active1;
  const pipeline = realPipeline(clock, () => current);
  // The real pipeline verifies signatures and history on its first call; it gets a generous deadline (review P2-4).
  const integration = createReferenceIntegration(undefined, { world: fvWorld(), clock, authorization: pipeline, revocation: pipeline, authorityTimeoutMs: 10_000 });
  const request = (principalId, operation, extra = {}) => ({
    principalId,
    organizationId: ORG_ALPHA,
    documentId: FIXTURE.sovereignAssetId,
    operation,
    termsDigest: FIXTURE.terms.claimDigest,
    ...(operation === 'document.modify-protected-terms' ? { newTermsDigest: FIXTURE.terms.claimDigest } : {}),
    ...extra,
  });
  return { clock, integration, pipeline, request, withdraw: () => (current = S.withdrawn2) };
}

describe('RN-CONFORM-04 — the reference PEP over the real FV-P2/P3/P4C pipeline', () => {
  it('restates the FV freshness ceilings exactly', () => {
    for (const [operation, action] of Object.entries(FV_ACTION_OF)) assert.equal(DECISION_CEILING_SECONDS[operation], DOCUMENT_USE_FRESHNESS_CEILINGS[action], operation);
  });

  it('open is allowed for the receiver the signed terms name; export and modify are refused as the terms require; a stranger is refused', async () => {
    const { integration, pipeline, request } = setup();
    const open = await integration.execute(request(FIXTURE.receiver, 'document.open'));
    assert.equal(open.outcome, 'allowed');
    assert.deepEqual(Buffer.from(open.result.bytes), Buffer.from(CONTENT));
    for (const operation of ['document.export', 'document.modify-protected-terms']) {
      const outcome = await integration.execute(request(FIXTURE.receiver, operation));
      assert.equal(outcome.outcome, 'denied', operation);
      assert.equal(outcome.reason, 'NOT_PERMITTED', operation);
      assert.equal('result' in outcome, false);
    }
    const stranger = await integration.execute(request(STRANGER, 'document.open'));
    assert.deepEqual([stranger.outcome, stranger.reason], ['denied', 'NOT_PERMITTED']);
    assert.ok(pipeline.calls() >= 8, 'every decision and every revocation check went through the real pipeline');
    assert.deepEqual(integration.store.accesses.map((a) => a.kind), ['open'], 'only the authorized open touched the store');
  });

  it('a registrant-signed withdrawal is enforced on the next operation, including for a decision carried from before it', async () => {
    const { clock, integration, request, withdraw } = setup();
    const carried = await integration.obtainDecision(FIXTURE.receiver, ORG_ALPHA, FIXTURE.sovereignAssetId, 'document.open');
    assert.equal((await integration.execute(request(FIXTURE.receiver, 'document.open', { decision: carried }))).outcome, 'allowed');
    withdraw();
    clock.advance(60);
    const after = await integration.execute(request(FIXTURE.receiver, 'document.open', { decision: carried }));
    assert.deepEqual([after.outcome, after.reason], ['denied', 'REVOKED']);
    const fresh = await integration.execute(request(FIXTURE.receiver, 'document.open'));
    assert.equal(fresh.outcome, 'denied');
    assert.equal(integration.store.accesses.length, 1, 'nothing was served after the withdrawal');
  });

  it('a decision the real pipeline issued is still refused past the PEP ceiling, and tenant binding still applies', async () => {
    const { clock, integration, request } = setup();
    const carried = await integration.obtainDecision(FIXTURE.receiver, ORG_ALPHA, FIXTURE.sovereignAssetId, 'document.open');
    clock.advance(DECISION_CEILING_SECONDS['document.open'] + 1);
    const stale = await integration.execute(request(FIXTURE.receiver, 'document.open', { decision: carried }));
    assert.deepEqual([stale.outcome, stale.reason], ['denied', 'DECISION_STALE']);
    const crossTenant = await integration.execute(request(FIXTURE.receiver, 'document.open', { organizationId: 'org-synthetic-beta' }));
    assert.deepEqual([crossTenant.outcome, crossTenant.reason], ['denied', 'PRINCIPAL_CONTEXT_MISMATCH']);
  });
});
