import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  HUMAN_DECISION_CHALLENGE_FORMAT,
  INTENDED_PRODUCTION_RP_ID,
  createHumanIdentityService,
  createRelyingPartyConfiguration,
  identityAdministratorFor,
  openSqliteHumanIdentityStore,
  type HumanIdentityService,
  type HumanIdentityStore,
} from '../human-identity/index.js';
import {
  BOOTSTRAP_HUMAN_DECISION_DENIALS,
  BOOTSTRAP_HUMAN_DECISION_FORMAT,
  bootstrapBindingDigest,
  bootstrapBindingOf,
  bootstrapHumanDecisionInputs,
  createHumanDecisionBootstrapAuthorizer,
  parseStatusHistoryBootstrapRequest,
} from '../sovereign-status-history/index.js';
import type { BootstrapHumanDecisionPort, StatusHistoryBootstrapBinding } from '../sovereign-status-history/index.js';
import { testSigner, testVerifier } from './authority-authenticity-fixture.js';
import { SoftwareAuthenticator } from './auth02-software-authenticator.js';

// FV-P4C-2B2 — the bootstrap authorizer core against the REAL AUTH-03 identity service: real
// passkey ceremonies (synthetic software authenticators), real single-use decision challenges,
// real revocation and expiry. Synthetic principals; no Host composition, no route.

const ORG = 'org-fv-p4c2b2';
const ORIGIN = `https://${INTENDED_PRODUCTION_RP_ID}`;
const RP = createRelyingPartyConfiguration({ rpId: INTENDED_PRODUCTION_RP_ID, rpName: 'Frontera Authority', allowedOrigins: [ORIGIN] });
const OPERATORS = ['requester-a', 'approver-b', 'approver-c'];
const REQUESTERS = new Set(['requester-a']);
const APPROVERS = new Set(['approver-b', 'approver-c']);
const permissions = { mayRequest: (id: string) => REQUESTERS.has(id), mayApprove: (id: string) => APPROVERS.has(id) };

class Clock {
  private ms = Date.parse('2026-10-29T12:00:00Z');
  now = (): Date => new Date(this.ms);
  iso = (): string => this.now().toISOString();
  advance(seconds: number): void {
    this.ms += seconds * 1000;
  }
}

interface World {
  readonly service: HumanIdentityService;
  readonly store: HumanIdentityStore;
  readonly clock: Clock;
  readonly devices: Record<string, SoftwareAuthenticator>;
  readonly admin: ReturnType<typeof identityAdministratorFor>;
}

const directories: string[] = [];
const stores: HumanIdentityStore[] = [];
after(() => {
  for (const store of stores.splice(0)) {
    try {
      store.close();
    } catch {
      // closed by its test
    }
  }
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function world(): Promise<World> {
  const dir = mkdtempSync(join(tmpdir(), 'fv-p4c2b2-'));
  directories.push(dir);
  const clock = new Clock();
  const store = await openSqliteHumanIdentityStore(join(dir, 'human-identity.sqlite'), {
    organizationId: ORG,
    now: clock.iso,
    authenticity: { signer: testSigner(), verifier: testVerifier() },
    create: true,
  });
  stores.push(store);
  const service = createHumanIdentityService({ store, relyingParty: RP, operatorIds: OPERATORS, now: clock.now });
  const admin = identityAdministratorFor({ plane: 'operator', operatorId: 'ops-admin', organizationId: ORG, role: 'organization-administrator', credentialClass: 'operator', actorRef: 'operator-plane:ops-admin' });
  const devices: Record<string, SoftwareAuthenticator> = {};
  for (const operatorId of OPERATORS) {
    const device = new SoftwareAuthenticator({ origin: ORIGIN });
    await service.createPrincipal(admin, { operatorId, displayName: `Synthetic ${operatorId}` });
    const issued = await service.authorizeEnrolment(admin, operatorId);
    await service.finishRegistration(issued.enrolmentToken, device.register(service.beginRegistration(issued.enrolmentToken)));
    devices[operatorId] = device;
  }
  return { service, store, clock, devices, admin };
}

let requestCounter = 0;
function binding(overrides: Record<string, unknown> = {}): { binding: StatusHistoryBootstrapBinding; digest: string } {
  requestCounter += 1;
  const request = parseStatusHistoryBootstrapRequest({
    schemaVersion: 'frontera.sovereign-status-bootstrap/1',
    requestId: `req:fv-p4c2b2-${requestCounter}`,
    operation: 'establish',
    purpose: 'initial-trust-anchor',
    namespace: 'receiver:fv-p4c2b2',
    sovereignAssetId: 'sa:synthetic-asset',
    issuer: 'did:example:registrant',
    manifestDigest: 'a'.repeat(64),
    status: { sequence: 1, statusDigest: 'b'.repeat(64) },
    terms: { claimId: 'claim:terms-1', claimDigest: 'c'.repeat(64) },
    operatorRef: 'operator:requester-a',
    sourceRef: 'source:issuer-channel',
    createdAt: '2026-10-29T12:00:00Z',
    expiresAt: '2026-10-29T12:10:00Z',
    ...overrides,
  });
  assert.ok(request !== undefined);
  const b = bootstrapBindingOf(request);
  return { binding: b, digest: bootstrapBindingDigest(b) };
}

/** A passkey decision by `operatorId` over this binding's AUTH-03 subject (or `inputs` instead). */
function decide(w: World, operatorId: string, digest: string, inputs: Partial<{ approvalRequestId: string; subjectDigest: string; verdict: 'approve' | 'reject' }> = {}, device = w.devices[operatorId]!): unknown {
  const issued = w.service.beginDecision({ operatorId, ...bootstrapHumanDecisionInputs(digest), ...inputs });
  return device.assert(issued.options);
}

function authorizer(w: World, requesterResponse: unknown, approverResponse: unknown, extra: { decisions?: BootstrapHumanDecisionPort; permissions?: typeof permissions; organizationId?: string } = {}) {
  return createHumanDecisionBootstrapAuthorizer({
    decisions: extra.decisions ?? w.service,
    organizationId: extra.organizationId ?? ORG,
    permissions: extra.permissions ?? permissions,
    requesterResponse,
    approverResponse,
  });
}

async function denied(a: ReturnType<typeof authorizer>, b: { binding: StatusHistoryBootstrapBinding; digest: string }, reason: string): Promise<void> {
  assert.deepEqual(await a.authorizeStatusHistoryBootstrap(b.binding, b.digest), { outcome: 'denied' });
  assert.equal(a.lastDenial(), reason);
}

/** Whether AUTH-03 still accepts this assertion: proves a denial did not consume it. */
async function stillUsable(w: World, response: unknown): Promise<boolean> {
  try {
    await w.service.authorizeDecision(response);
    return true;
  } catch {
    return false;
  }
}

describe('FV-P4C-2B2 human-decision bootstrap authorizer — against the real AUTH-03 service', () => {
  it('the port is AUTH-03’s own decision API, and the format is AUTH-03’s constant', async () => {
    const w = await world();
    const port: BootstrapHumanDecisionPort = w.service;
    assert.equal(typeof port.peekDecision, 'function');
    assert.equal(BOOTSTRAP_HUMAN_DECISION_FORMAT, HUMAN_DECISION_CHALLENGE_FORMAT);
    assert.equal(new Set(BOOTSTRAP_HUMAN_DECISION_DENIALS).size, BOOTSTRAP_HUMAN_DECISION_DENIALS.length);
  });

  it('1. a requester and a distinct, permitted approver, both passkey-verified over this binding, authorize it once', async () => {
    const w = await world();
    const b = binding();
    const requester = decide(w, 'requester-a', b.digest);
    const approver = decide(w, 'approver-b', b.digest);
    const a = authorizer(w, requester, approver);
    const result = (await a.authorizeStatusHistoryBootstrap(b.binding, b.digest)) as { outcome: string; bindingDigest: string; authorityRef: string };
    assert.equal(result.outcome, 'authorized');
    assert.equal(result.bindingDigest, b.digest);
    assert.match(result.authorityRef, /^frontera\.human-decision:sha256:[0-9a-f]{64}:sha256:[0-9a-f]{64}$/);
    assert.equal(a.lastDenial(), null);
    assert.equal(a.consumedDecisions().length, 2);
    // Both decisions are consumed in AUTH-03's signed chain, and never authorize again.
    const consumed = w.store.history().filter((row) => row.kind === 'decision_authorized');
    assert.equal(consumed.length, 2);
    assert.equal(await stillUsable(w, requester), false);
    assert.equal(await stillUsable(w, approver), false);
    await denied(a, b, 'ALREADY_USED');
    // BLOCKER B1, pinned: AUTH-03 has no outcome for a decision that is not a CORE-05 verdict, so both
    // bootstrap decisions stay unsettled, and the CORE-05 channel's reconciliation would label them 'abandoned'.
    const unsettled = w.service.unsettledDecisions().map((decision) => decision.contract.approvalRequestId);
    assert.deepEqual(unsettled, [bootstrapHumanDecisionInputs(b.digest).approvalRequestId, bootstrapHumanDecisionInputs(b.digest).approvalRequestId]);
  });

  it('2. the same principal cannot both request and approve, and nothing is consumed', async () => {
    const w = await world();
    const b = binding();
    const first = decide(w, 'requester-a', b.digest);
    const second = decide(w, 'requester-a', b.digest);
    await denied(authorizer(w, first, second), b, 'SAME_PRINCIPAL');
    await denied(authorizer(w, first, first), b, 'SAME_PRINCIPAL');
    assert.equal(await stillUsable(w, first), true, 'peeked, not consumed');
  });

  it('3/16. an approver assertion made with another person’s passkey is refused by AUTH-03', async () => {
    const w = await world();
    const b = binding();
    const forged = decide(w, 'approver-b', b.digest, {}, w.devices['approver-c']!);
    await denied(authorizer(w, decide(w, 'requester-a', b.digest), forged), b, 'DECISION_REFUSED');
  });

  it('4. the request’s operator reference must be the requester who decided', async () => {
    const w = await world();
    const b = binding({ operatorRef: 'operator:approver-c' });
    await denied(authorizer(w, decide(w, 'requester-a', b.digest), decide(w, 'approver-b', b.digest)), b, 'OPERATOR_REF_MISMATCH');
    const raw = binding({ operatorRef: 'requester-a' });
    await denied(authorizer(w, decide(w, 'requester-a', raw.digest), decide(w, 'approver-b', raw.digest)), raw, 'OPERATOR_REF_MISMATCH');
  });

  it('5. a decision about anything else (a CORE-05 approval, another subject) is refused and NOT consumed', async () => {
    const w = await world();
    const b = binding();
    const core05 = decide(w, 'approver-b', b.digest, { approvalRequestId: `approval-request:${'a'.repeat(64)}`, subjectDigest: `sha256:${'d'.repeat(64)}` });
    await denied(authorizer(w, decide(w, 'requester-a', b.digest), core05), b, 'DECISION_NOT_FOR_THIS_BOOTSTRAP');
    assert.equal(await stillUsable(w, core05), true, 'a foreign decision is never consumed by this authorizer');
    // The right subject under a CORE-05 request id is still not a bootstrap decision.
    const core05RequestId = decide(w, 'approver-b', b.digest, { approvalRequestId: `approval-request:${'a'.repeat(64)}` });
    await denied(authorizer(w, decide(w, 'requester-a', b.digest), core05RequestId), b, 'DECISION_NOT_FOR_THIS_BOOTSTRAP');
    assert.equal(await stillUsable(w, core05RequestId), true);
    const sameRequestIdOtherSubject = decide(w, 'approver-b', b.digest, { subjectDigest: `sha256:${'e'.repeat(64)}` });
    await denied(authorizer(w, decide(w, 'requester-a', b.digest), sameRequestIdOtherSubject), b, 'DECISION_NOT_FOR_THIS_BOOTSTRAP');
  });

  it('6. a digest that is not the binding’s own is refused', async () => {
    const w = await world();
    const b = binding();
    await denied(authorizer(w, decide(w, 'requester-a', b.digest), decide(w, 'approver-b', b.digest)), { binding: b.binding, digest: 'f'.repeat(64) }, 'BINDING_INVALID');
    await denied(authorizer(w, null, null), { binding: b.binding, digest: 'not-hex' }, 'BINDING_INVALID');
  });

  it('7. an expired decision is refused by AUTH-03', async () => {
    const w = await world();
    const b = binding();
    const requester = decide(w, 'requester-a', b.digest);
    const approver = decide(w, 'approver-b', b.digest);
    w.clock.advance(121);
    await denied(authorizer(w, requester, approver), b, 'DECISION_REFUSED');
  });

  it('8. a revoked approver cannot authorize, even with an assertion made before the revocation', async () => {
    const w = await world();
    const b = binding();
    const requester = decide(w, 'requester-a', b.digest);
    const approver = decide(w, 'approver-b', b.digest);
    await w.service.revokePrincipal(w.admin, 'approver-b', 'left the organization');
    await denied(authorizer(w, requester, approver), b, 'DECISION_REFUSED');
  });

  it('partial consumption is fail-closed and auditable: the requester stays consumed, nothing is authorized', async () => {
    const w = await world();
    const b = binding();
    const requester = decide(w, 'requester-a', b.digest);
    const approver = decide(w, 'approver-b', b.digest);
    // The approver is revoked after the checks a peek can make, so only consumption can refuse it.
    await w.service.revokePrincipal(w.admin, 'approver-b', 'revoked during the ceremony');
    const a = authorizer(w, requester, approver);
    await denied(a, b, 'DECISION_REFUSED');
    const requesterCommitment = w.service.peekDecision(requester).commitment;
    assert.deepEqual(a.consumedDecisions(), [requesterCommitment], 'the consumed requester decision is reported');
    assert.equal(await stillUsable(w, requester), false, 'it can never authorize again: a new attempt needs a new decision');
    // Nothing was consumed for a denial before consumption.
    const untouched = authorizer(w, decide(w, 'requester-a', b.digest), decide(w, 'requester-a', b.digest));
    await denied(untouched, b, 'SAME_PRINCIPAL');
    assert.deepEqual(untouched.consumedDecisions(), []);
  });

  it('9–13. an approval cannot be replayed onto another request, namespace, asset, issuer or status', async () => {
    const w = await world();
    const b = binding();
    const requester = decide(w, 'requester-a', b.digest);
    const approver = decide(w, 'approver-b', b.digest);
    for (const other of [binding(), binding({ namespace: 'receiver:other' }), binding({ sovereignAssetId: 'sa:other' }), binding({ issuer: 'did:example:other' }), binding({ status: { sequence: 2, statusDigest: 'b'.repeat(64) } })]) {
      await denied(authorizer(w, requester, approver), other, 'DECISION_NOT_FOR_THIS_BOOTSTRAP');
    }
    // Consumed once, never again.
    assert.equal(((await authorizer(w, requester, approver).authorizeStatusHistoryBootstrap(b.binding, b.digest)) as { outcome: string }).outcome, 'authorized');
    await denied(authorizer(w, requester, approver), b, 'DECISION_REFUSED');
  });

  it('a reject verdict never authorizes', async () => {
    const w = await world();
    const b = binding();
    await denied(authorizer(w, decide(w, 'requester-a', b.digest), decide(w, 'approver-b', b.digest, { verdict: 'reject' })), b, 'VERDICT_NOT_APPROVE');
  });

  it('16. permissions come from the Host: not permitted, or a failing permission service, refuse', async () => {
    const w = await world();
    const b = binding();
    const requester = decide(w, 'requester-a', b.digest);
    const approver = decide(w, 'approver-b', b.digest);
    await denied(authorizer(w, requester, approver, { permissions: { mayRequest: () => false, mayApprove: () => true } }), b, 'REQUESTER_NOT_PERMITTED');
    await denied(authorizer(w, requester, approver, { permissions: { mayRequest: () => true, mayApprove: () => false } }), b, 'APPROVER_NOT_PERMITTED');
    await denied(authorizer(w, requester, approver, { permissions: { mayRequest: () => true, mayApprove: () => { throw new Error('directory down'); } } }), b, 'PERMISSION_SERVICE_FAILED');
    await denied(authorizer(w, requester, approver, { permissions: { mayRequest: () => true, mayApprove: () => 'yes' as unknown as boolean } }), b, 'APPROVER_NOT_PERMITTED');
    assert.equal(await stillUsable(w, approver), true);
  });

  it('14/15. an unknown decision format, another organization, a failing service or a substituted decision refuse', async () => {
    const w = await world();
    const b = binding();
    const requester = decide(w, 'requester-a', b.digest);
    const approver = decide(w, 'approver-b', b.digest);
    const relabel = (patch: Record<string, unknown>): BootstrapHumanDecisionPort => ({
      peekDecision: (r) => {
        const peeked = w.service.peekDecision(r);
        return { ...peeked, contract: { ...peeked.contract, ...patch } };
      },
      authorizeDecision: (r) => w.service.authorizeDecision(r),
    });
    await denied(authorizer(w, requester, approver, { decisions: relabel({ format: 'frontera.human-decision-challenge.v2' }) }), b, 'DECISION_FORMAT_UNSUPPORTED');
    await denied(authorizer(w, requester, approver, { organizationId: 'org-other' }), b, 'ORGANIZATION_MISMATCH');
    await denied(authorizer(w, requester, approver, { decisions: { peekDecision: () => { throw new Error('down'); }, authorizeDecision: (r) => w.service.authorizeDecision(r) } }), b, 'DECISION_UNREADABLE');
    await denied(authorizer(w, 'garbage', approver), b, 'DECISION_UNREADABLE');
    const swapping: BootstrapHumanDecisionPort = {
      peekDecision: (r) => w.service.peekDecision(r),
      authorizeDecision: async (r) => {
        const real = await w.service.authorizeDecision(r);
        return { ...real, commitment: `sha256:${'0'.repeat(64)}` };
      },
    };
    await denied(authorizer(w, requester, approver, { decisions: swapping }), b, 'DECISION_SUBSTITUTED');
  });
});
