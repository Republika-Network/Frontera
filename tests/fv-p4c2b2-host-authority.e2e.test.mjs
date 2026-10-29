// FV-P4C-2B2 — the acceptance scenario with REAL Host authority: two synthetic humans enrolled with
// passkeys in the real AUTH-03 identity service, the human-decision authorizer, the bootstrap
// coordinator, the real receiver package and a real SQLite history, across restarts. Synthetic
// principals, statuses, sources and databases. The source verifier is still a synthetic provider:
// no trusted status source exists in the Host (see FV_HOST_AUTHORITY_INTEGRATION.md).
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { DOCUMENT_USE_FRESHNESS_CEILINGS, checkDocumentUseFreshness, evaluateDocumentUsePolicy, verifyDocumentUseEligibility } from '@aoc-enterprise/sovereign-receiver-verification';

import {
  INTENDED_PRODUCTION_RP_ID,
  createHumanIdentityService,
  createRelyingPartyConfiguration,
  identityAdministratorFor,
  openSqliteHumanIdentityStore,
} from '../dist/src/enterprise/human-identity/index.js';
import {
  bootstrapBindingDigest,
  bootstrapBindingOf,
  bootstrapHumanDecisionInputs,
  coordinateStatusHistoryBootstrap,
  createHumanDecisionBootstrapAuthorizer,
  openSqliteStatusHighWaterMarkStore,
  parseStatusHistoryBootstrapRequest,
} from '../dist/src/enterprise/sovereign-status-history/index.js';
import { testSigner, testVerifier } from '../dist/src/enterprise/__tests__/authority-authenticity-fixture.js';
import { SoftwareAuthenticator } from '../dist/src/enterprise/__tests__/auth02-software-authenticator.js';
import { FIXTURE, S, bootstrapContext, bootstrapRequest, resolver } from './fv-status-bootstrap-support.mjs';

const ORG = 'org-fv-p4c2b2-e2e';
const ORIGIN = `https://${INTENDED_PRODUCTION_RP_ID}`;
const RP = createRelyingPartyConfiguration({ rpId: INTENDED_PRODUCTION_RP_ID, rpName: 'Frontera Authority', allowedOrigins: [ORIGIN] });
const T = '2026-10-28T12:00:00Z';
const KEY = { sovereignAssetId: FIXTURE.sovereignAssetId, issuer: FIXTURE.registrant.issuer };
const permissions = { mayRequest: (id) => id === 'requester-a', mayApprove: (id) => id === 'approver-b' };

const cleanup = [];
after(() => {
  for (const step of cleanup.splice(0).reverse()) {
    try {
      step();
    } catch {
      // already closed
    }
  }
});

async function host() {
  const dir = mkdtempSync(join(tmpdir(), 'fv-p4c2b2-e2e-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const clock = { ms: Date.parse(T), now() { return new Date(this.ms); }, iso() { return this.now().toISOString(); } };
  const identityStore = await openSqliteHumanIdentityStore(join(dir, 'human-identity.sqlite'), {
    organizationId: ORG,
    now: () => clock.iso(),
    authenticity: { signer: testSigner(), verifier: testVerifier() },
    create: true,
  });
  cleanup.push(() => identityStore.close());
  const identity = createHumanIdentityService({ store: identityStore, relyingParty: RP, operatorIds: ['requester-a', 'approver-b'], now: () => clock.now() });
  const admin = identityAdministratorFor({ plane: 'operator', operatorId: 'ops-admin', organizationId: ORG, role: 'organization-administrator', credentialClass: 'operator', actorRef: 'operator-plane:ops-admin' });
  const devices = {};
  for (const operatorId of ['requester-a', 'approver-b']) {
    devices[operatorId] = new SoftwareAuthenticator({ origin: ORIGIN });
    await identity.createPrincipal(admin, { operatorId, displayName: `Synthetic ${operatorId}` });
    const issued = await identity.authorizeEnrolment(admin, operatorId);
    await identity.finishRegistration(issued.enrolmentToken, devices[operatorId].register(identity.beginRegistration(issued.enrolmentToken)));
  }
  const historyPath = join(dir, 'sovereign-status-history.sqlite');
  let history = await openSqliteStatusHighWaterMarkStore(historyPath, { namespace: 'receiver:fv-p4c2b2', create: true });
  cleanup.push(() => history.close());
  return {
    identity,
    devices,
    get history() {
      return history;
    },
    async restart() {
      history.close();
      history = await openSqliteStatusHighWaterMarkStore(historyPath, { namespace: 'receiver:fv-p4c2b2' });
      cleanup.push(() => history.close());
    },
  };
}

/** The two humans' passkey decisions over this request's binding, and the authorizer built from them. */
function humanAuthority(h, request) {
  const digest = bootstrapBindingDigest(bootstrapBindingOf(parseStatusHistoryBootstrapRequest(request)));
  const decide = (operatorId) => h.devices[operatorId].assert(h.identity.beginDecision({ operatorId, ...bootstrapHumanDecisionInputs(digest) }).options);
  const requesterResponse = decide('requester-a');
  const approverResponse = decide('approver-b');
  const authorizer = createHumanDecisionBootstrapAuthorizer({ decisions: h.identity, organizationId: ORG, permissions, requesterResponse, approverResponse });
  return { authorizer, requesterResponse, approverResponse };
}

async function decision(evaluationTime) {
  const eligibility = await verifyDocumentUseEligibility(FIXTURE.bundleText, {
    verificationKeyResolver: resolver,
    expectedSovereignAssetId: FIXTURE.sovereignAssetId,
    contentBytes: new Uint8Array(Buffer.from(FIXTURE.contentBase64, 'base64')),
  });
  return evaluateDocumentUsePolicy(eligibility, { action: 'aoc.licensing:access' }, { receiverPrincipal: FIXTURE.receiver, evaluationTime, expectedSovereignAssetId: FIXTURE.sovereignAssetId, policyReference: { ...FIXTURE.terms } });
}

const freshness = async (store, status, evaluationTime) =>
  checkDocumentUseFreshness(await decision(evaluationTime), status.text, {
    verificationKeyResolver: resolver,
    evaluationTime,
    operationId: `op:check:${evaluationTime}`,
    maxStatusAgeSeconds: { ...DOCUMENT_USE_FRESHNESS_CEILINGS },
    historyStore: store,
  });

const stillUsable = async (h, response) => h.identity.authorizeDecision(response).then(() => true, () => false);

describe('FV-P4C-2B2 — bootstrap under real AUTH-03 authority (synthetic source)', () => {
  it('the acceptance scenario: authorize, anchor, persist, refuse rollback and conflict, refuse re-anchor, execute nothing', async () => {
    // 1–4. A Host composition for the test: real identity service, two distinct humans, decisions bound to the digest.
    const h = await host();
    const request = bootstrapRequest(h.history, S.active1, T, { operatorRef: 'operator:requester-a' });
    const { authorizer } = humanAuthority(h, request);

    // 5–8. Source (synthetic provider), signed status (real FV-P4B), history and atomic evidence.
    const established = await coordinateStatusHistoryBootstrap(request, S.active1.text, bootstrapContext(h.history, T, { authorizer }));
    assert.equal(established.outcome, 'established', `${established.reason}/${established.detail} ${authorizer.lastDenial()}`);
    assert.match(established.evidence.authorityRef, /^frontera\.human-decision:sha256:[0-9a-f]{64}:sha256:[0-9a-f]{64}$/);
    assert.equal(established.evidence.operatorRef, 'operator:requester-a');

    // 9–11. The evidence reads back, and survives a restart with the history.
    assert.deepEqual(await h.history.readBootstrapEvidence(KEY), [established.evidence]);
    await h.restart();
    assert.deepEqual(await h.history.readBootstrapEvidence(KEY), [established.evidence]);
    assert.equal((await h.history.read(KEY)).mark.statusDigest, S.active1.digest);
    assert.equal((await freshness(h.history, S.active1, T)).freshnessVerdict, 'FRESH');

    // 12–13. After a withdrawal is accepted, the old signed status is a rollback.
    assert.equal((await freshness(h.history, S.withdrawn2, T)).freshnessVerdict, 'WITHDRAWN');
    await h.restart();
    assert.equal((await freshness(h.history, S.active1, '2026-10-28T12:01:00Z')).freshnessVerdict, 'ROLLBACK_DETECTED');

    // 14–15. A conflicting status latches the conflict.
    assert.equal((await freshness(h.history, S.equivocating2, '2026-10-28T12:01:00Z')).freshnessVerdict, 'CONFLICT_DETECTED');

    // 16–17. A re-anchor, even with fresh, valid human decisions, is refused before they are consumed.
    const reanchor = bootstrapRequest(h.history, S.withdrawn2, '2026-10-28T12:01:30Z', { operation: 'reanchor', operatorRef: 'operator:requester-a' });
    const second = humanAuthority(h, reanchor);
    const refused = await coordinateStatusHistoryBootstrap(reanchor, S.withdrawn2.text, bootstrapContext(h.history, '2026-10-28T12:01:30Z', { authorizer: second.authorizer }));
    assert.equal(refused.outcome, 'refused');
    assert.equal(refused.reason, 'HISTORY_REFUSED');
    assert.equal(refused.detail, 'CONFLICT_DETECTED');
    assert.equal(await stillUsable(h, second.approverResponse), true, 'the human decisions were never consumed for a refused history');

    // 20. Nothing was authorized for a document, executed or paid.
    assert.equal(established.documentAuthorization, 'not_evaluated');
    assert.equal(established.execution, 'not_performed');
    assert.equal((await h.history.readBootstrapEvidence(KEY)).length, 1);
  });

  it('the same human cannot request and approve; an unauthorized authority never anchors', async () => {
    const h = await host();
    const request = bootstrapRequest(h.history, S.active1, T, { operatorRef: 'operator:requester-a' });
    const digest = bootstrapBindingDigest(bootstrapBindingOf(parseStatusHistoryBootstrapRequest(request)));
    const decide = () => h.devices['requester-a'].assert(h.identity.beginDecision({ operatorId: 'requester-a', ...bootstrapHumanDecisionInputs(digest) }).options);
    const authorizer = createHumanDecisionBootstrapAuthorizer({ decisions: h.identity, organizationId: ORG, permissions: { mayRequest: () => true, mayApprove: () => true }, requesterResponse: decide(), approverResponse: decide() });
    const result = await coordinateStatusHistoryBootstrap(request, S.active1.text, bootstrapContext(h.history, T, { authorizer }));
    assert.equal(result.reason, 'OPERATOR_UNAUTHORIZED');
    assert.equal(authorizer.lastDenial(), 'SAME_PRINCIPAL');
    assert.equal(await h.history.read(KEY), undefined);
  });

  it('decisions made for one bootstrap request cannot authorize another', async () => {
    const h = await host();
    const first = bootstrapRequest(h.history, S.active1, T, { operatorRef: 'operator:requester-a' });
    const { authorizer } = humanAuthority(h, first);
    const other = bootstrapRequest(h.history, S.active1, T, { operatorRef: 'operator:requester-a' });
    const result = await coordinateStatusHistoryBootstrap(other, S.active1.text, bootstrapContext(h.history, T, { authorizer }));
    assert.equal(result.reason, 'OPERATOR_UNAUTHORIZED');
    assert.equal(authorizer.lastDenial(), 'DECISION_NOT_FOR_THIS_BOOTSTRAP');
  });
});
