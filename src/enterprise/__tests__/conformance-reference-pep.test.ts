import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  AUTHORIZED_FOR,
  BYPASS_IDS,
  DECISION_CEILING_SECONDS,
  DECISION_SCHEMA,
  DOCUMENTS,
  FORGER_KEY,
  ORG_ALPHA,
  ORG_BETA,
  PRINCIPALS,
  REFERENCE_OPERATIONS,
  REVOCATION_PROPAGATION_SECONDS,
  conformantDeployment,
  containsSentinel,
  createReferenceIntegration,
  executeProtectedDocumentOperation,
  referenceDigest,
  runReferenceProbe,
  signReferenceDecision,
  type DocumentOperationRequest,
  type PepOutcome,
  type ReferenceChallengeType,
  type ReferenceIntegration,
  type ReferenceOperation,
} from './conformance-reference-pep.js';

/**
 * RN-CONFORM-04 / WP-02, WP-07, WP-08, WP-11 — the synthetic reference PEP on its own: execution order, authorization,
 * freshness, revocation, fail-closed dependencies, tenant isolation and storage isolation. Synthetic only.
 */

const TARGET = DOCUMENTS.alphaContract;

function request(i: ReferenceIntegration, principalId: string, operation: ReferenceOperation, extra: Partial<DocumentOperationRequest> = {}): DocumentOperationRequest {
  const m = i.store.metadata(extra.documentId ?? TARGET);
  return {
    principalId,
    organizationId: ORG_ALPHA,
    documentId: TARGET,
    operation,
    termsDigest: m?.termsDigest ?? 'sha256:none',
    ...(operation === 'document.modify-protected-terms' ? { newTermsDigest: referenceDigest({ new: 'terms' }) } : {}),
    ...extra,
  };
}

const denied = (o: PepOutcome, reason: string) => {
  assert.equal(o.outcome, 'denied', `expected denial ${reason}, got ${o.outcome}`);
  if (o.outcome === 'denied') assert.equal(o.reason, reason);
  assert.equal('result' in o, false, 'a denial carries no result');
  assert.equal(containsSentinel(JSON.stringify(o)), false, 'a denial carries no protected content');
};

describe('RN-CONFORM-04 reference PEP — authorized operations and execution order', () => {
  for (const operation of REFERENCE_OPERATIONS) {
    it(`${operation}: the authorized principal succeeds, and the protected action runs only after every check`, async () => {
      const i = createReferenceIntegration();
      const outcome = await i.execute(request(i, AUTHORIZED_FOR[operation], operation));
      assert.equal(outcome.outcome, 'allowed');
      assert.deepEqual(outcome.evidence.steps, ['1.request-schema', '2.principal-context', '3.resource-binding', '4.policy-terms', '5.decision-obtained', '6.decision-verified', '7.freshness-revocation', '8.permission', '9.resource-action', '10.evidence']);
      if (outcome.outcome === 'allowed' && outcome.result.kind !== 'terms-modified') assert.ok(containsSentinel(outcome.result.bytes), 'the authorized reader gets the document');
      assert.equal(containsSentinel(JSON.stringify(outcome.evidence)), false, 'evidence never contains content');
    });
  }

  it('the exported conformant PEP refuses an unauthorized export exactly as the conformant deployment does', async () => {
    const i = createReferenceIntegration(conformantDeployment());
    const direct = await executeProtectedDocumentOperation(request(i, PRINCIPALS.outsider, 'document.export'), i.ports);
    denied(direct, 'NOT_PERMITTED');
  });
});

describe('RN-CONFORM-04 WP-11 — authorization', () => {
  it('missing, denied, forged, malformed and substituted decisions are all refused', async () => {
    const i = createReferenceIntegration();
    denied(await i.execute(request(i, PRINCIPALS.outsider, 'document.open')), 'NOT_PERMITTED');
    const m = i.store.metadata(TARGET)!;
    const forged = signReferenceDecision({ schema: DECISION_SCHEMA, decisionId: 'x', effect: 'ALLOW', reason: 'F', principalId: PRINCIPALS.outsider, organizationId: ORG_ALPHA, documentId: TARGET, operation: 'document.open', termsClaimId: m.termsClaimId, termsDigest: m.termsDigest, issuedAtMs: i.clock.ms(), expiresAtMs: i.clock.ms() + 1000 }, FORGER_KEY);
    denied(await i.execute(request(i, PRINCIPALS.outsider, 'document.open', { decision: forged })), 'DECISION_INVALID');
    denied(await i.execute(request(i, PRINCIPALS.outsider, 'document.open', { decision: { payload: { effect: 'ALLOW' }, signature: 'AAAA' } })), 'DECISION_INVALID');
    const genuine = (await i.obtainDecision(PRINCIPALS.reader, ORG_ALPHA, TARGET, 'document.open')) as { payload: Record<string, unknown>; signature: string };
    const tampered = { payload: { ...genuine.payload, principalId: PRINCIPALS.outsider }, signature: genuine.signature };
    denied(await i.execute(request(i, PRINCIPALS.outsider, 'document.open', { decision: tampered })), 'DECISION_INVALID');
  });

  it('a decision is bound to its actor, organization, document, operation and terms', async () => {
    const i = createReferenceIntegration();
    const forReader = await i.obtainDecision(PRINCIPALS.reader, ORG_ALPHA, TARGET, 'document.open');
    denied(await i.execute(request(i, PRINCIPALS.editor, 'document.open', { decision: forReader })), 'DECISION_BINDING_MISMATCH');
    const forOpen = await i.obtainDecision(PRINCIPALS.editor, ORG_ALPHA, TARGET, 'document.open');
    denied(await i.execute(request(i, PRINCIPALS.editor, 'document.export', { decision: forOpen })), 'DECISION_BINDING_MISMATCH');
    const forNotice = await i.obtainDecision(PRINCIPALS.reader, ORG_ALPHA, DOCUMENTS.alphaNotice, 'document.open');
    denied(await i.execute(request(i, PRINCIPALS.reader, 'document.open', { decision: forNotice })), 'DECISION_BINDING_MISMATCH');
    denied(await i.execute(request(i, PRINCIPALS.reader, 'document.open', { termsDigest: referenceDigest({ other: 'terms' }) })), 'TERMS_MISMATCH');
    denied(await i.execute(request(i, PRINCIPALS.reader, 'document.open', { organizationId: ORG_BETA })), 'PRINCIPAL_CONTEXT_MISMATCH');
    denied(await i.execute({ ...request(i, PRINCIPALS.reader, 'document.open'), principalId: 'nobody' }), 'UNKNOWN_PRINCIPAL');
    denied(await i.execute(request(i, PRINCIPALS.reader, 'document.open', { documentId: 'doc-missing' })), 'UNKNOWN_DOCUMENT');
    denied(await i.execute({ ...request(i, PRINCIPALS.reader, 'document.open'), extra: true }), 'MALFORMED_REQUEST');
    denied(await i.execute({ ...request(i, PRINCIPALS.reader, 'document.open'), operation: 'document.delete' }), 'MALFORMED_REQUEST');
  });
});

describe('RN-CONFORM-04 WP-07 — freshness and revocation', () => {
  for (const operation of REFERENCE_OPERATIONS) {
    it(`${operation}: a carried decision is honoured until just before its ${DECISION_CEILING_SECONDS[operation]} s ceiling, and refused at and after it`, async () => {
      const at = async (offsetMs: number) => {
        const i = createReferenceIntegration();
        const decision = await i.obtainDecision(AUTHORIZED_FOR[operation], ORG_ALPHA, TARGET, operation);
        i.clock.advance(offsetMs / 1000);
        return i.execute(request(i, AUTHORIZED_FOR[operation], operation, { decision }));
      };
      const ceiling = DECISION_CEILING_SECONDS[operation] * 1000;
      assert.equal((await at(ceiling - 1)).outcome, 'allowed');
      denied(await at(ceiling), 'DECISION_STALE');
      denied(await at(ceiling + 1), 'DECISION_STALE');
    });
  }

  it('clock rollback: a decision issued after the PEP\'s current time is refused', async () => {
    const i = createReferenceIntegration();
    const decision = await i.obtainDecision(PRINCIPALS.reader, ORG_ALPHA, TARGET, 'document.open');
    i.clock.advance(-60);
    denied(await i.execute(request(i, PRINCIPALS.reader, 'document.open', { decision })), 'DECISION_FROM_FUTURE');
  });

  it('revocation is enforced on every operation, cached decision or not; unknown revocation status blocks', async () => {
    const i = createReferenceIntegration();
    const decision = await i.obtainDecision(PRINCIPALS.reader, ORG_ALPHA, TARGET, 'document.open');
    assert.equal((await i.execute(request(i, PRINCIPALS.reader, 'document.open', { decision }))).outcome, 'allowed');
    i.authority.revoke(i.store.metadata(TARGET)!.termsClaimId);
    i.clock.advance(REVOCATION_PROPAGATION_SECONDS);
    denied(await i.execute(request(i, PRINCIPALS.reader, 'document.open', { decision })), 'REVOKED');
    denied(await i.execute(request(i, PRINCIPALS.reader, 'document.open')), 'REVOKED');
    const j = createReferenceIntegration();
    j.authority.revocationMode = 'unknown';
    denied(await j.execute(request(j, PRINCIPALS.reader, 'document.open')), 'REVOCATION_UNKNOWN');
  });

  it('a revocation effective in the future does not yet block (the boundary is the effective time)', async () => {
    const i = createReferenceIntegration();
    i.authority.revoke(i.store.metadata(TARGET)!.termsClaimId, i.clock.ms() + 10_000);
    assert.equal((await i.execute(request(i, PRINCIPALS.reader, 'document.open'))).outcome, 'allowed');
    i.clock.advance(10);
    denied(await i.execute(request(i, PRINCIPALS.reader, 'document.open')), 'REVOKED');
  });
});

describe('RN-CONFORM-04 review P2-1/P2-2 — caller objects are read once (no check-then-use substitution)', () => {
  it('a genuine decision whose getters change after verification is judged by its first reading — the outsider gets nothing', async () => {
    const i = createReferenceIntegration();
    const genuine = (await i.obtainDecision(PRINCIPALS.reader, ORG_ALPHA, TARGET, 'document.open')) as { payload: Record<string, unknown>; signature: string };
    let reads = 0;
    const shifting: Record<string, unknown> = { ...genuine.payload };
    Object.defineProperty(shifting, 'principalId', { enumerable: true, get: () => (reads++ === 0 ? PRINCIPALS.reader : PRINCIPALS.outsider) });
    const outcome = await i.execute(request(i, PRINCIPALS.outsider, 'document.open', { decision: { payload: shifting, signature: genuine.signature } }));
    assert.equal(outcome.outcome, 'denied');
    assert.deepEqual(i.store.accesses, []);
  });

  it('a request whose organization changes between reads cannot cross tenants', async () => {
    const i = createReferenceIntegration();
    let reads = 0;
    const shifting: Record<string, unknown> = { ...request(i, PRINCIPALS.betaAgent, 'document.open') };
    Object.defineProperty(shifting, 'organizationId', { enumerable: true, get: () => (reads++ === 0 ? ORG_BETA : ORG_ALPHA) });
    const outcome = await i.execute(shifting);
    assert.equal(outcome.outcome, 'denied');
    assert.deepEqual(i.store.accesses, []);
  });
});

describe('RN-CONFORM-04 review P3-1 — a throwing, hanging or non-promise dependency denies; it never escapes the PEP', () => {
  const ports = (i: ReferenceIntegration, authorization: unknown, revocation: unknown) => ({ ...i.ports, authorization: authorization as never, revocation: revocation as never });
  it('authorization dependency: synchronous throw, rejection, null answer', async () => {
    const i = createReferenceIntegration();
    for (const decide of [() => { throw new Error('boom'); }, () => Promise.reject(new Error('boom')), () => null]) {
      denied(await executeProtectedDocumentOperation(request(i, PRINCIPALS.reader, 'document.open'), ports(i, { decide }, i.authority)), 'AUTHORITY_UNAVAILABLE');
    }
  });
  it('revocation dependency: throw or hang → REVOCATION_UNKNOWN', async () => {
    const i = createReferenceIntegration();
    for (const revocationOf of [() => { throw new Error('boom'); }, () => new Promise(() => undefined)]) {
      denied(await executeProtectedDocumentOperation(request(i, PRINCIPALS.reader, 'document.open'), ports(i, i.authority, { revocationOf })), 'REVOCATION_UNKNOWN');
    }
    assert.deepEqual(i.store.accesses, []);
  });
});

describe('RN-CONFORM-04 WP-11 — the authorization dependency fails closed', () => {
  for (const mode of ['unavailable', 'timeout', 'malformed'] as const) {
    it(`${mode}: denied, and the store is never touched`, async () => {
      const i = createReferenceIntegration();
      i.authority.mode = mode;
      for (const operation of REFERENCE_OPERATIONS) denied(await i.execute(request(i, AUTHORIZED_FOR[operation], operation)), mode === 'malformed' ? 'DECISION_INVALID' : 'AUTHORITY_UNAVAILABLE');
      assert.deepEqual(i.store.accesses, []);
    });
  }
});

describe('RN-CONFORM-04 WP-08 — document and storage isolation', () => {
  it('denied open/export/modify read and write nothing; a denied modification commits nothing', async () => {
    const i = createReferenceIntegration();
    const before = i.store.currentTermsDigest(TARGET);
    for (const operation of REFERENCE_OPERATIONS) denied(await i.execute(request(i, PRINCIPALS.outsider, operation)), 'NOT_PERMITTED');
    assert.deepEqual(i.store.accesses, []);
    assert.equal(i.store.currentTermsDigest(TARGET), before);
    const ok = await i.execute(request(i, PRINCIPALS.editor, 'document.modify-protected-terms'));
    assert.equal(ok.outcome, 'allowed');
    assert.notEqual(i.store.currentTermsDigest(TARGET), before, 'an authorized modification commits');
  });

  it('the storage locator route serves no protected bytes; the batch interface enforces the same decision', async () => {
    const i = createReferenceIntegration();
    for (const operation of REFERENCE_OPERATIONS) {
      const response = i.storage(i.store.metadata(TARGET)!.locator, operation);
      assert.equal(response.status, 403);
      assert.equal(response.body, null);
    }
    const [batch] = await i.executeBatch([request(i, PRINCIPALS.outsider, 'document.export')]);
    denied(batch!, 'NOT_PERMITTED');
    const [authorized] = await i.executeBatch([request(i, PRINCIPALS.editor, 'document.export')]);
    assert.equal(authorized!.outcome, 'allowed');
  });

  it('cross-tenant: a principal holding every role in organization beta cannot act on organization alpha\'s document', async () => {
    const i = createReferenceIntegration();
    for (const operation of REFERENCE_OPERATIONS) {
      denied(await i.execute({ ...request(i, PRINCIPALS.betaAgent, operation), organizationId: ORG_BETA }), 'CROSS_ORGANIZATION');
    }
    // The role-based authority alone would have allowed it: the PEP's tenant binding is what refuses.
    const decision = (await i.obtainDecision(PRINCIPALS.betaAgent, ORG_BETA, TARGET, 'document.open')) as { payload: { effect: string } };
    assert.equal(decision.payload.effect, 'ALLOW');
    assert.deepEqual(i.store.accesses, []);
  });

  it('an unprotected document is still tenant-bound and decision-bound', async () => {
    const i = createReferenceIntegration();
    const notice = i.store.metadata(DOCUMENTS.alphaNotice)!;
    assert.equal((await i.execute({ principalId: PRINCIPALS.outsider, organizationId: ORG_ALPHA, documentId: DOCUMENTS.alphaNotice, operation: 'document.open', termsDigest: notice.termsDigest })).outcome, 'allowed');
    denied(await i.execute({ principalId: PRINCIPALS.betaAgent, organizationId: ORG_BETA, documentId: DOCUMENTS.alphaNotice, operation: 'document.open', termsDigest: notice.termsDigest }), 'CROSS_ORGANIZATION');
  });
});

describe('RN-CONFORM-04 WP-03 — every defective variant is detectable by a validator procedure, and only on its own operations', () => {
  const expected: Record<string, string> = { 'BYPASS-01': 'G01', 'BYPASS-02': 'G02', 'BYPASS-03': 'G03', 'BYPASS-04': 'G04', 'BYPASS-05': 'G05', 'BYPASS-06': 'G06', 'BYPASS-07': 'G07', 'BYPASS-08': 'G08' };
  for (const id of BYPASS_IDS) {
    it(`${id} is observed by ${expected[id]} and the conformant deployment is not`, async () => {
      const type = expected[id] as ReferenceChallengeType;
      const conformant = await runReferenceProbe(conformantDeployment(), type, 'document.export');
      assert.equal(conformant.observedOutcome, type === 'G08' ? 'digest_reported' : 'denied');
      const defective = { defects: new Set([id]), defectOperations: new Set<ReferenceOperation>(['document.export']) };
      const probe = await runReferenceProbe(defective, type, 'document.export');
      if (type === 'G08') assert.notEqual(probe.observedDeploymentDigest, conformant.observedDeploymentDigest);
      else assert.equal(probe.observedOutcome, 'allowed');
      if (type !== 'G08') {
        for (const other of ['document.open', 'document.modify-protected-terms'] as const) {
          assert.equal((await runReferenceProbe(defective, type, other)).observedOutcome, 'denied', `the defect is scoped to document.export (${other})`);
        }
      }
    });
  }

  it('an open or export defect leaks the sentinel bytes the validator can detect; the conformant probe never does', async () => {
    for (const type of ['G01', 'G03', 'G04', 'G06'] as const) {
      assert.equal((await runReferenceProbe(conformantDeployment(), type, 'document.open')).leakedProtectedContent, false);
    }
    const leak = await runReferenceProbe({ defects: new Set(['BYPASS-04']), defectOperations: new Set() }, 'G04', 'document.open');
    assert.equal(leak.leakedProtectedContent, true);
    assert.equal(containsSentinel(JSON.stringify(leak)), false, 'the probe report itself carries digests, never the content');
  });
});
