import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  BOOTSTRAP_AUTHORITY_CHALLENGE_FORMAT,
  BOOTSTRAP_AUTHORITY_REQUEST_PREFIX,
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
  BOOTSTRAP_HUMAN_DECISION_REQUEST_PREFIX,
  bootstrapAuthorityDecisionInput,
  bootstrapBindingDigest,
  bootstrapBindingOf,
  bootstrapHumanDecisionInputs,
  createHumanDecisionBootstrapAuthorizer,
  parseBootstrapAuthorityRef,
  parseStatusHistoryBootstrapRequest,
} from '../sovereign-status-history/index.js';
import type { BootstrapHumanDecisionPort, BootstrapHumanPermissions, StatusHistoryBootstrapBinding } from '../sovereign-status-history/index.js';
import { testSigner, testVerifier } from './authority-authenticity-fixture.js';
import { SoftwareAuthenticator } from './auth02-software-authenticator.js';

// FV-P4C-2B2 / 2B2B — the bootstrap authorizer against the REAL AUTH-03 identity service, in the
// dedicated bootstrap-authority domain: real passkey ceremonies (synthetic software authenticators),
// real single-use decision challenges, signed roles (attest / approve), real revocation and expiry.
// Synthetic principals; no Host composition, no route.

const ORG = 'org-fv-p4c2b2';
const ORIGIN = `https://${INTENDED_PRODUCTION_RP_ID}`;
const RP = createRelyingPartyConfiguration({ rpId: INTENDED_PRODUCTION_RP_ID, rpName: 'Frontera Authority', allowedOrigins: [ORIGIN] });
const OPERATORS = ['requester-a', 'approver-b', 'approver-c'];
const REQUESTERS = new Set(['requester-a']);
const APPROVERS = new Set(['approver-b', 'approver-c']);
const permissions: BootstrapHumanPermissions = { mayRequest: (id) => REQUESTERS.has(id), mayApprove: (id) => APPROVERS.has(id) };

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

type Role = 'requester' | 'approver';

/** A passkey decision by `operatorId` in the bootstrap-authority domain, for `role`, over this binding. */
function decide(w: World, operatorId: string, digest: string, role: Role, device = w.devices[operatorId]!): unknown {
  const issued = w.service.beginBootstrapAuthorityDecision({ operatorId, ...bootstrapAuthorityDecisionInput(digest, role) });
  return device.assert(issued.options);
}

/** A CORE-05-domain decision (AUTH-03's original format) by `operatorId`. */
function core05Decision(w: World, operatorId: string, inputs: { approvalRequestId: string; subjectDigest: string; verdict: 'approve' | 'reject' }): unknown {
  return w.devices[operatorId]!.assert(w.service.beginDecision({ operatorId, ...inputs }).options);
}

function authorizer(w: World, requesterResponse: unknown, approverResponse: unknown, extra: { decisions?: BootstrapHumanDecisionPort; permissions?: BootstrapHumanPermissions; organizationId?: string } = {}) {
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

/** Whether AUTH-03 still accepts this bootstrap-authority assertion: proves a denial did not consume it. */
async function stillUsable(w: World, response: unknown): Promise<boolean> {
  try {
    await w.service.authorizeBootstrapAuthorityDecision(response);
    return true;
  } catch {
    return false;
  }
}

describe('FV-P4C-2B2B human-decision bootstrap authorizer — against the real AUTH-03 service', () => {
  it('the port is AUTH-03’s own bootstrap-authority API, and the format and prefix are AUTH-03’s constants', async () => {
    const w = await world();
    const port: BootstrapHumanDecisionPort = w.service;
    assert.equal(typeof port.peekBootstrapAuthorityDecision, 'function');
    assert.equal(BOOTSTRAP_HUMAN_DECISION_FORMAT, BOOTSTRAP_AUTHORITY_CHALLENGE_FORMAT);
    assert.notEqual(BOOTSTRAP_HUMAN_DECISION_FORMAT, HUMAN_DECISION_CHALLENGE_FORMAT);
    assert.equal(BOOTSTRAP_HUMAN_DECISION_REQUEST_PREFIX, BOOTSTRAP_AUTHORITY_REQUEST_PREFIX);
    assert.equal(new Set(BOOTSTRAP_HUMAN_DECISION_DENIALS).size, BOOTSTRAP_HUMAN_DECISION_DENIALS.length);
  });

  it('1. an attesting requester and a distinct, permitted approver, both passkey-verified over this binding, authorize it once', async () => {
    const w = await world();
    const b = binding();
    const requester = decide(w, 'requester-a', b.digest, 'requester');
    const approver = decide(w, 'approver-b', b.digest, 'approver');
    const a = authorizer(w, requester, approver);
    const result = (await a.authorizeStatusHistoryBootstrap(b.binding, b.digest)) as { outcome: string; bindingDigest: string; authorityRef: string };
    assert.equal(result.outcome, 'authorized');
    assert.equal(result.bindingDigest, b.digest);
    const ref = parseBootstrapAuthorityRef(result.authorityRef);
    assert.deepEqual(ref, { requesterCommitment: w.service.peekBootstrapAuthorityDecision(requester).commitment, approverCommitment: w.service.peekBootstrapAuthorityDecision(approver).commitment });
    assert.equal(a.lastDenial(), null);
    assert.equal(a.consumedDecisions().length, 2);
    // Both decisions are consumed in AUTH-03's signed chain, with their signed roles, and never authorize again.
    const consumed = w.store.history().filter((row) => row.kind === 'decision_authorized').map((row) => (JSON.parse(row.payload) as { evidence: { verdict: string; format: string } }).evidence);
    assert.deepEqual(consumed.map((e) => e.verdict), ['attest', 'approve']);
    assert.equal(new Set(consumed.map((e) => e.format)).size, 1);
    assert.equal(await stillUsable(w, requester), false);
    assert.equal(await stillUsable(w, approver), false);
    await denied(a, b, 'ALREADY_USED');
    // B1 resolved: CORE-05 reconciliation never sees them; they await their own settlement.
    assert.deepEqual(w.service.unsettledDecisions(), []);
    assert.deepEqual(w.service.unsettledBootstrapAuthorityDecisions().map((d) => [d.contract.verdict, d.contract.approvalRequestId]), [['attest', bootstrapHumanDecisionInputs(b.digest).approvalRequestId], ['approve', bootstrapHumanDecisionInputs(b.digest).approvalRequestId]]);
    assert.equal(w.service.decision(ref!.requesterCommitment), undefined, 'not a CORE-05 decision by any read');
  });

  it('2. the same principal cannot both request and approve, and nothing is consumed', async () => {
    const w = await world();
    const b = binding();
    const attest = decide(w, 'requester-a', b.digest, 'requester');
    const approve = decide(w, 'requester-a', b.digest, 'approver');
    await denied(authorizer(w, attest, approve, { permissions: { mayRequest: () => true, mayApprove: () => true } }), b, 'SAME_PRINCIPAL');
    assert.equal(await stillUsable(w, attest), true, 'peeked, not consumed');
  });

  it('B5. roles are signed: an approval cannot stand for an attestation, nor the reverse, nor one decision for both', async () => {
    const w = await world();
    const b = binding();
    const attest = decide(w, 'requester-a', b.digest, 'requester');
    const approve = decide(w, 'approver-b', b.digest, 'approver');
    const requesterApproves = decide(w, 'requester-a', b.digest, 'approver');
    const approverAttests = decide(w, 'approver-b', b.digest, 'requester');
    await denied(authorizer(w, approve, attest), b, 'ROLE_MISMATCH');
    await denied(authorizer(w, requesterApproves, approve), b, 'ROLE_MISMATCH');
    await denied(authorizer(w, attest, approverAttests), b, 'ROLE_MISMATCH');
    await denied(authorizer(w, attest, attest), b, 'ROLE_MISMATCH');
    for (const response of [attest, approve, requesterApproves, approverAttests]) assert.equal(await stillUsable(w, response), true);
    assert.throws(() => w.service.beginBootstrapAuthorityDecision({ operatorId: 'requester-a', bindingDigest: b.digest, role: 'reject' as never }), /attest or approve/);
  });

  it('3/16. an approver assertion made with another person’s passkey is refused by AUTH-03', async () => {
    const w = await world();
    const b = binding();
    const forged = decide(w, 'approver-b', b.digest, 'approver', w.devices['approver-c']!);
    await denied(authorizer(w, decide(w, 'requester-a', b.digest, 'requester'), forged), b, 'DECISION_REFUSED');
  });

  it('4. the request’s operator reference must be the requester who attested', async () => {
    const w = await world();
    const b = binding({ operatorRef: 'operator:approver-c' });
    await denied(authorizer(w, decide(w, 'requester-a', b.digest, 'requester'), decide(w, 'approver-b', b.digest, 'approver')), b, 'OPERATOR_REF_MISMATCH');
    const raw = binding({ operatorRef: 'requester-a' });
    await denied(authorizer(w, decide(w, 'requester-a', raw.digest, 'requester'), decide(w, 'approver-b', raw.digest, 'approver')), raw, 'OPERATOR_REF_MISMATCH');
  });

  it('B2/5. a CORE-05-domain decision — even over this binding’s own request id and subject — is refused and NOT consumed', async () => {
    const w = await world();
    const b = binding();
    const inputs = bootstrapHumanDecisionInputs(b.digest);
    // The 2B2A shape: a CORE-05-format decision that names the bootstrap request id and subject.
    const legacy = core05Decision(w, 'approver-b', { ...inputs, verdict: 'approve' });
    await denied(authorizer(w, decide(w, 'requester-a', b.digest, 'requester'), legacy), b, 'DECISION_UNREADABLE');
    const core05 = core05Decision(w, 'approver-b', { approvalRequestId: `approval-request:${'a'.repeat(64)}`, subjectDigest: `sha256:${'d'.repeat(64)}`, verdict: 'approve' });
    await denied(authorizer(w, decide(w, 'requester-a', b.digest, 'requester'), core05), b, 'DECISION_UNREADABLE');
    // Never consumed: the CORE-05 domain still accepts both.
    assert.equal(await w.service.authorizeDecision(legacy).then(() => true, () => false), true);
    assert.equal(await w.service.authorizeDecision(core05).then(() => true, () => false), true);
    // And the reverse: AUTH-03's CORE-05 methods refuse a bootstrap-authority decision.
    const bootstrap = decide(w, 'approver-b', b.digest, 'approver');
    assert.throws(() => w.service.peekDecision(bootstrap), /does not match its commitment/);
    await assert.rejects(w.service.authorizeDecision(bootstrap), /does not match its commitment/);
    assert.equal(await stillUsable(w, bootstrap), true);
  });

  it('6. a digest that is not the binding’s own is refused', async () => {
    const w = await world();
    const b = binding();
    await denied(authorizer(w, decide(w, 'requester-a', b.digest, 'requester'), decide(w, 'approver-b', b.digest, 'approver')), { binding: b.binding, digest: 'f'.repeat(64) }, 'BINDING_INVALID');
    await denied(authorizer(w, null, null), { binding: b.binding, digest: 'not-hex' }, 'BINDING_INVALID');
  });

  it('7. an expired decision is refused by AUTH-03', async () => {
    const w = await world();
    const b = binding();
    const requester = decide(w, 'requester-a', b.digest, 'requester');
    const approver = decide(w, 'approver-b', b.digest, 'approver');
    w.clock.advance(121);
    await denied(authorizer(w, requester, approver), b, 'DECISION_REFUSED');
  });

  it('8. a revoked approver, or a revoked passkey, cannot authorize, even with an assertion made before the revocation', async () => {
    const w = await world();
    const b = binding();
    const requester = decide(w, 'requester-a', b.digest, 'requester');
    const approver = decide(w, 'approver-b', b.digest, 'approver');
    await w.service.revokePrincipal(w.admin, 'approver-b', 'left the organization');
    await denied(authorizer(w, requester, approver), b, 'DECISION_REFUSED');
    const c = binding();
    const requester2 = decide(w, 'requester-a', c.digest, 'requester');
    const approver2 = decide(w, 'approver-c', c.digest, 'approver');
    await w.service.revokeCredential(w.admin, w.service.credentialsOf('approver-c')[0]!.credentialId, 'lost device');
    await denied(authorizer(w, requester2, approver2), c, 'DECISION_REFUSED');
  });

  it('partial consumption is fail-closed and auditable: the requester stays consumed, nothing is authorized', async () => {
    const w = await world();
    const b = binding();
    const requester = decide(w, 'requester-a', b.digest, 'requester');
    const approver = decide(w, 'approver-b', b.digest, 'approver');
    await w.service.revokePrincipal(w.admin, 'approver-b', 'revoked during the ceremony');
    const a = authorizer(w, requester, approver);
    await denied(a, b, 'DECISION_REFUSED');
    const requesterCommitment = w.service.peekBootstrapAuthorityDecision(requester).commitment;
    assert.deepEqual(a.consumedDecisions(), [requesterCommitment], 'the consumed requester decision is reported');
    assert.equal(await stillUsable(w, requester), false, 'it can never authorize again: a new attempt needs a new decision');
    assert.deepEqual(w.service.unsettledBootstrapAuthorityDecisions().map((d) => d.commitment), [requesterCommitment], 'unsettled, never successful');
    const untouched = authorizer(w, decide(w, 'requester-a', b.digest, 'requester'), decide(w, 'requester-a', b.digest, 'approver'));
    await denied(untouched, b, 'SAME_PRINCIPAL');
    assert.deepEqual(untouched.consumedDecisions(), []);
  });

  it('9–13. a pair cannot be replayed onto another request, namespace, asset, issuer or status', async () => {
    const w = await world();
    const b = binding();
    const requester = decide(w, 'requester-a', b.digest, 'requester');
    const approver = decide(w, 'approver-b', b.digest, 'approver');
    for (const other of [binding(), binding({ namespace: 'receiver:other' }), binding({ sovereignAssetId: 'sa:other' }), binding({ issuer: 'did:example:other' }), binding({ status: { sequence: 2, statusDigest: 'b'.repeat(64) } }), binding({ purpose: 'continuity-restoration', operation: 'reanchor' })]) {
      await denied(authorizer(w, requester, approver), other, 'DECISION_NOT_FOR_THIS_BOOTSTRAP');
    }
    assert.equal(((await authorizer(w, requester, approver).authorizeStatusHistoryBootstrap(b.binding, b.digest)) as { outcome: string }).outcome, 'authorized');
    await denied(authorizer(w, requester, approver), b, 'DECISION_REFUSED');
  });

  it('16. permissions come from the Host, per organization, namespace and binding: not permitted, or failing, refuse', async () => {
    const w = await world();
    const b = binding();
    const requester = decide(w, 'requester-a', b.digest, 'requester');
    const approver = decide(w, 'approver-b', b.digest, 'approver');
    const asked: unknown[] = [];
    const recording: BootstrapHumanPermissions = { mayRequest: (id, scope) => (asked.push(['request', id, scope]), false), mayApprove: () => true };
    await denied(authorizer(w, requester, approver, { permissions: recording }), b, 'REQUESTER_NOT_PERMITTED');
    assert.deepEqual(asked, [['request', 'requester-a', { organizationId: ORG, namespace: 'receiver:fv-p4c2b2', bindingDigest: b.digest }]]);
    await denied(authorizer(w, requester, approver, { permissions: { mayRequest: () => true, mayApprove: () => false } }), b, 'APPROVER_NOT_PERMITTED');
    await denied(authorizer(w, requester, approver, { permissions: { mayRequest: () => true, mayApprove: () => { throw new Error('directory down'); } } }), b, 'PERMISSION_SERVICE_FAILED');
    await denied(authorizer(w, requester, approver, { permissions: { mayRequest: () => true, mayApprove: () => 'yes' as unknown as boolean } }), b, 'APPROVER_NOT_PERMITTED');
    assert.equal(await stillUsable(w, approver), true);
  });

  it('14/15. an unknown format, another organization, a failing service or a substituted decision refuse', async () => {
    const w = await world();
    const b = binding();
    const requester = decide(w, 'requester-a', b.digest, 'requester');
    const approver = decide(w, 'approver-b', b.digest, 'approver');
    const relabel = (patch: Record<string, unknown>): BootstrapHumanDecisionPort => ({
      peekBootstrapAuthorityDecision: (r) => {
        const peeked = w.service.peekBootstrapAuthorityDecision(r);
        return { ...peeked, contract: { ...peeked.contract, ...patch } };
      },
      authorizeBootstrapAuthorityDecision: (r) => w.service.authorizeBootstrapAuthorityDecision(r),
    });
    await denied(authorizer(w, requester, approver, { decisions: relabel({ format: HUMAN_DECISION_CHALLENGE_FORMAT }) }), b, 'DECISION_FORMAT_UNSUPPORTED');
    await denied(authorizer(w, requester, approver, { decisions: relabel({ format: 'frontera.sovereign-status-bootstrap-authority.v2' }) }), b, 'DECISION_FORMAT_UNSUPPORTED');
    await denied(authorizer(w, requester, approver, { organizationId: 'org-other' }), b, 'ORGANIZATION_MISMATCH');
    await denied(authorizer(w, requester, approver, { decisions: { peekBootstrapAuthorityDecision: () => { throw new Error('down'); }, authorizeBootstrapAuthorityDecision: (r) => w.service.authorizeBootstrapAuthorityDecision(r) } }), b, 'DECISION_UNREADABLE');
    await denied(authorizer(w, 'garbage', approver), b, 'DECISION_UNREADABLE');
    const swapping: BootstrapHumanDecisionPort = {
      peekBootstrapAuthorityDecision: (r) => w.service.peekBootstrapAuthorityDecision(r),
      authorizeBootstrapAuthorityDecision: async (r) => {
        const real = await w.service.authorizeBootstrapAuthorityDecision(r);
        return { ...real, commitment: `sha256:${'0'.repeat(64)}` };
      },
    };
    await denied(authorizer(w, requester, approver, { decisions: swapping }), b, 'DECISION_SUBSTITUTED');
  });
});
