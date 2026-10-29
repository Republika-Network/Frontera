// FV-P4C-2B1 — trusted bootstrap through the real coordinator, the real receiver package and a real SQLite history:
// authority, source currentness, history transitions, atomic evidence and every fail-closed path. Synthetic fixture and
// synthetic providers only.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import Database from 'better-sqlite3';
import {
  DOCUMENT_USE_FRESHNESS_CEILINGS,
  checkDocumentUseFreshness,
  evaluateDocumentUsePolicy,
  verifyDocumentUseEligibility,
} from '@aoc-enterprise/sovereign-receiver-verification';

import { coordinateStatusHistoryBootstrap, openSqliteStatusHighWaterMarkStore } from '../dist/src/enterprise/sovereign-status-history/index.js';
import { FIXTURE, S, bootstrapContext, bootstrapRequest, recordingAuthorizer, resolver, sourceAttesting, trustedBootstrap } from './fv-status-bootstrap-support.mjs';

const T = '2026-10-28T12:00:00Z';
const KEY = { sovereignAssetId: FIXTURE.sovereignAssetId, issuer: FIXTURE.registrant.issuer };

async function withStore(work, namespace = 'receiver:fv-p4c2b1') {
  const dir = mkdtempSync(join(tmpdir(), 'fv-p4c2b1-'));
  const path = join(dir, 'history.sqlite');
  const store = await openSqliteStatusHighWaterMarkStore(path, { namespace, create: true });
  try {
    return await work(store, path, dir);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

const coordinate = (store, status, request = {}, context = {}, time = T) =>
  coordinateStatusHistoryBootstrap(bootstrapRequest(store, status, time, request), status.text, bootstrapContext(store, time, context));

function refused(result, reason, detail) {
  assert.equal(result.outcome, 'refused', `${result.reason} ${result.detail}`);
  assert.equal(result.reason, reason, `detail ${result.detail}`);
  if (detail !== undefined) assert.equal(result.detail, detail);
  assert.equal(result.evidence, null);
  assert.equal(result.documentAuthorization, 'not_evaluated');
  assert.equal(result.execution, 'not_performed');
}

async function empty(store) {
  assert.equal(await store.read(KEY), undefined);
  assert.equal((await store.readBootstrapEvidence(KEY)).length, 0);
}

async function eligibleDecision(evaluationTime) {
  const eligibility = await verifyDocumentUseEligibility(FIXTURE.bundleText, {
    verificationKeyResolver: resolver,
    expectedSovereignAssetId: FIXTURE.sovereignAssetId,
    contentBytes: new Uint8Array(Buffer.from(FIXTURE.contentBase64, 'base64')),
  });
  return evaluateDocumentUsePolicy(eligibility, { action: 'aoc.licensing:access' }, {
    receiverPrincipal: FIXTURE.receiver,
    evaluationTime,
    expectedSovereignAssetId: FIXTURE.sovereignAssetId,
    policyReference: { ...FIXTURE.terms },
  });
}

const freshness = async (store, status, evaluationTime) =>
  checkDocumentUseFreshness(await eligibleDecision(evaluationTime), status.text, {
    verificationKeyResolver: resolver,
    evaluationTime,
    operationId: `op:check:${evaluationTime}`,
    maxStatusAgeSeconds: { ...DOCUMENT_USE_FRESHNESS_CEILINGS },
    historyStore: store,
  });

describe('FV-P4C-2B1 — an authorized, currently-sourced bootstrap', () => {
  it('establishes the history and commits exactly one evidence record with it', async () => {
    await withStore(async (store) => {
      const authorizer = recordingAuthorizer();
      const result = await coordinate(store, S.active1, {}, { authorizer });
      assert.equal(result.outcome, 'established');
      assert.equal(result.reason, 'ESTABLISHED');
      const evidence = result.evidence;
      assert.equal(evidence.schemaVersion, 'frontera.sovereign-status-bootstrap-evidence/1');
      assert.equal(evidence.classification, 'host-recorded-unsigned');
      assert.equal(evidence.bindingDigest, authorizer.seen[0].bindingDigest);
      assert.equal(evidence.authorityRef, `authority:synthetic:${result.requestId}`);
      assert.deepEqual(evidence.status, { sequence: 1, statusDigest: S.active1.digest });
      assert.deepEqual(evidence.next, { revision: 1, sequence: 1, statusDigest: S.active1.digest });
      assert.equal(evidence.previous, null);
      assert.deepEqual(evidence.sources, [{ sourceClass: 'issuer-status-channel', sourceRef: 'source:issuer-channel', observedAt: T }]);
      assert.deepEqual(await store.readBootstrapEvidence(KEY), [evidence]);
      assert.equal((await store.read(KEY)).mark.anchoredAt, T);
      // 40. A bootstrap authorizes no document operation; the gate still decides, and here it is fresh.
      assert.equal((await freshness(store, S.active1, T)).freshnessVerdict, 'FRESH');
      for (const forbidden of ['#key=', 'BEGIN', 'privateKey', FIXTURE.contentBase64]) assert.equal(JSON.stringify(evidence).includes(forbidden), false, forbidden);
    });
  });

  it('the authorizer is asked about exactly this binding, and only after the request and status are checked', async () => {
    await withStore(async (store) => {
      const authorizer = recordingAuthorizer();
      refused(await coordinate(store, S.active1, { sovereignAssetId: 'sa:wrong' }, { authorizer }), 'SUBJECT_MISMATCH');
      refused(await coordinate(store, S.active1, { status: { sequence: 1, statusDigest: 'f'.repeat(64) } }, { authorizer }), 'STATUS_MISMATCH');
      assert.equal(authorizer.seen.length, 0, 'no decision is requested for an invalid request');
      await coordinate(store, S.active1, {}, { authorizer });
      const { binding } = authorizer.seen[0];
      assert.deepEqual(Object.keys(binding).sort(), ['expiresAt', 'issuer', 'manifestDigest', 'namespace', 'operation', 'operatorRef', 'purpose', 'requestId', 'schemaVersion', 'sovereignAssetId', 'status', 'terms']);
      assert.equal(binding.namespace, store.namespace);
    });
  });
});

describe('FV-P4C-2B1 — authority (S7)', () => {
  it('1/29/37. an unauthorized, denied or revoked operator is refused, for establish and reanchor alike', async () => {
    await withStore(async (store) => {
      refused(await coordinate(store, S.active1, {}, { authorizer: recordingAuthorizer(() => false) }), 'OPERATOR_UNAUTHORIZED');
      refused(await coordinate(store, S.active1, {}, { authorizer: { async authorizeStatusHistoryBootstrap() { throw new Error('credential revoked; directory says so'); } } }), 'AUTHORITY_UNAVAILABLE');
      await empty(store);
      await trustedBootstrap(store, S.active1, T);
      refused(await coordinate(store, S.superseding2, { operation: 'reanchor' }, { authorizer: recordingAuthorizer(() => false) }), 'OPERATOR_UNAUTHORIZED');
    });
  });

  it('2/3. roles, approval flags and look-alike answers are never authority', async () => {
    await withStore(async (store) => {
      refused(await coordinate(store, S.active1, { role: 'admin' }), 'REQUEST_INVALID');
      refused(await coordinate(store, S.active1, { approved: true }), 'REQUEST_INVALID');
      refused(await coordinateStatusHistoryBootstrap(bootstrapRequest(store, S.active1, T), S.active1.text, { ...bootstrapContext(store, T), approved: true }), 'CONTEXT_INVALID');
      const answers = [
        [{ approved: true }, 'OPERATOR_UNAUTHORIZED'],
        [{ outcome: 'AUTHORIZED', bindingDigest: 'x', authorityRef: 'a' }, 'OPERATOR_UNAUTHORIZED'],
        [{ outcome: 'authorized' }, 'AUTHORITY_BINDING_INVALID'],
        [{ outcome: 'authorized', bindingDigest: 'a'.repeat(64), authorityRef: 'authority:x' }, 'AUTHORITY_BINDING_INVALID'],
        [{ outcome: 'authorized', role: 'admin' }, 'OPERATOR_UNAUTHORIZED'],
        [true, 'OPERATOR_UNAUTHORIZED'],
        ['authorized', 'OPERATOR_UNAUTHORIZED'],
      ];
      for (const [answer, reason] of answers) {
        refused(await coordinate(store, S.active1, {}, { authorizer: { async authorizeStatusHistoryBootstrap() { return answer; } } }), reason);
      }
      await empty(store);
    });
  });

  it('13. an authorization for another request cannot be replayed onto this one', async () => {
    await withStore(async (store) => {
      const first = recordingAuthorizer(() => false);
      await coordinate(store, S.active1, {}, { authorizer: first });
      const stolen = first.seen[0].bindingDigest;
      const replaying = { async authorizeStatusHistoryBootstrap() { return { outcome: 'authorized', bindingDigest: stolen, authorityRef: 'authority:stolen' }; } };
      refused(await coordinate(store, S.active1, {}, { authorizer: replaying }), 'AUTHORITY_BINDING_INVALID');
      await empty(store);
    });
  });
});

describe('FV-P4C-2B1 — the request', () => {
  it('11/33/34/35/36. form, lifetime, schema, unknown fields and accessors fail closed', async () => {
    await withStore(async (store) => {
      refused(await coordinate(store, S.active1, { schemaVersion: 'frontera.sovereign-status-bootstrap/2' }), 'REQUEST_INVALID');
      refused(await coordinate(store, S.active1, { purpose: 'continuity-restoration' }), 'REQUEST_INVALID');
      refused(await coordinate(store, S.active1, { operatorRef: 'mailto:op@example.com?token=abc' }), 'REQUEST_INVALID');
      refused(await coordinate(store, S.active1, { sourceRef: 'https://portal.example/d#key=abc' }), 'REQUEST_INVALID');
      refused(await coordinate(store, S.active1, { expiresAt: '2026-10-28T12:15:00.000000001Z' }), 'REQUEST_INVALID', undefined);
      refused(await coordinate(store, S.active1, { createdAt: '2026-10-28T12:00:00.000000001Z', expiresAt: '2026-10-28T12:05:00Z' }), 'REQUEST_NOT_YET_VALID');
      refused(await coordinate(store, S.active1, { createdAt: '2026-10-28T11:50:00Z', expiresAt: T }), 'REQUEST_EXPIRED');
      refused(await coordinate(store, S.active1, {}, { operationId: '' }), 'CONTEXT_INVALID');
      refused(await coordinate(store, S.active1, {}, { evaluationTime: 'now' }), 'CONTEXT_INVALID');
      const getter = bootstrapRequest(store, S.active1, T);
      let invoked = false;
      Object.defineProperty(getter, 'operatorRef', { enumerable: true, get() { invoked = true; return 'operator:synthetic-1'; } });
      refused(await coordinateStatusHistoryBootstrap(getter, S.active1.text, bootstrapContext(store, T)), 'REQUEST_INVALID');
      refused(await coordinateStatusHistoryBootstrap(Object.create(bootstrapRequest(store, S.active1, T)), S.active1.text, bootstrapContext(store, T)), 'REQUEST_INVALID');
      refused(await coordinateStatusHistoryBootstrap(bootstrapRequest(store, S.active1, T), S.active1.text, Object.create(bootstrapContext(store, T))), 'CONTEXT_INVALID');
      assert.equal(invoked, false);
      await empty(store);
    });
  });

  it('7/8/9/10/39. wrong asset, issuer, namespace or status, and cross-namespace replay, are refused', async () => {
    await withStore(async (store) => {
      refused(await coordinate(store, S.active1, { sovereignAssetId: 'sa:other' }), 'SUBJECT_MISMATCH');
      refused(await coordinate(store, S.active1, { issuer: 'did:example:other' }), 'SUBJECT_MISMATCH');
      refused(await coordinate(store, S.active1, { manifestDigest: 'c'.repeat(64) }), 'SUBJECT_MISMATCH');
      refused(await coordinate(store, S.active1, { namespace: 'receiver:another-tenant' }), 'NAMESPACE_MISMATCH');
      refused(await coordinate(store, S.active1, { status: { sequence: 2, statusDigest: S.active1.digest } }), 'STATUS_MISMATCH');
      refused(await coordinate(store, S.active1, { terms: null }), 'STATUS_MISMATCH');
      // The request names one status, the text presented is another.
      refused(await coordinateStatusHistoryBootstrap(bootstrapRequest(store, S.active1, T), S.withdrawn2.text, bootstrapContext(store, T)), 'STATUS_MISMATCH');
      refused(await coordinateStatusHistoryBootstrap(bootstrapRequest(store, S.active1, T), 'not a status', bootstrapContext(store, T)), 'STATUS_REJECTED', 'STATUS_MALFORMED');
      await empty(store);
      // A request built for another namespace's store is refused here, even with the same id.
      await withStore(async (other) => {
        const foreign = bootstrapRequest(other, S.active1, T);
        refused(await coordinateStatusHistoryBootstrap(foreign, S.active1.text, bootstrapContext(store, T)), 'NAMESPACE_MISMATCH');
      }, 'receiver:another-tenant');
    });
  });

  it('12. a request id is used at most once, successful or not', async () => {
    await withStore(async (store) => {
      const request = bootstrapRequest(store, S.active1, T);
      assert.equal((await coordinateStatusHistoryBootstrap(request, S.active1.text, bootstrapContext(store, T))).outcome, 'established');
      refused(await coordinateStatusHistoryBootstrap(request, S.active1.text, bootstrapContext(store, T)), 'REQUEST_REPLAYED');
    });
  });
});

describe('FV-P4C-2B1 — source currentness (S8)', () => {
  it('4/6. sources outside the policy, too old, or from the future are refused; a weaker class is recorded as such', async () => {
    await withStore(async (store) => {
      const manual = sourceAttesting(T, (q) => ({ sourceClass: 'manual-out-of-band', sourceRef: 'source:manual-review-7', observedAt: T, status: { ...q.status } }));
      refused(await coordinate(store, S.active1, {}, { sourceVerifier: manual }), 'SOURCE_UNTRUSTED');
      refused(await coordinate(store, S.active1, {}, { sourceVerifier: sourceAttesting('2026-10-28T11:54:59Z') }), 'SOURCE_STALE');
      refused(await coordinate(store, S.active1, {}, { sourceVerifier: sourceAttesting('2026-10-28T12:00:00.000000001Z') }), 'SOURCE_UNTRUSTED');
      refused(await coordinate(store, S.active1, {}, { sourceVerifier: sourceAttesting(T, () => ({ sourceClass: 'issuer-status-channel' })) }), 'SOURCE_UNTRUSTED');
      refused(await coordinate(store, S.active1, {}, { sourceVerifier: sourceAttesting(T, (q) => ({ sourceClass: 'issuer-status-channel', sourceRef: 'https://x/#key=1', observedAt: T, status: q.status })) }), 'SOURCE_UNTRUSTED');
      await empty(store);
      const result = await coordinate(store, S.active1, {}, { sourceVerifier: manual, sourcePolicy: { acceptedSourceClasses: ['issuer-status-channel', 'manual-out-of-band'], maxSourceAgeSeconds: 300 } });
      assert.equal(result.outcome, 'established');
      assert.equal(result.evidence.sources[0].sourceClass, 'manual-out-of-band', 'the weaker basis is in the evidence');
    });
  });

  it('5/32. a source that knows a newer status refuses the old one; one that withholds it cannot be detected', async () => {
    await withStore(async (store) => {
      const newer = sourceAttesting(T, () => ({ sourceClass: 'issuer-status-channel', sourceRef: 'source:issuer-channel', observedAt: T, status: { sequence: 2, statusDigest: S.withdrawn2.digest } }));
      refused(await coordinate(store, S.active1, {}, { sourceVerifier: newer }), 'SOURCE_REPORTS_NEWER');
      const different = sourceAttesting(T, () => ({ sourceClass: 'issuer-status-channel', sourceRef: 'source:issuer-channel', observedAt: T, status: { sequence: 1, statusDigest: 'e'.repeat(64) } }));
      refused(await coordinate(store, S.active1, {}, { sourceVerifier: different }), 'SOURCE_MISMATCH');
      await empty(store);
      // LIMIT: a source that withholds the withdrawal and attests sequence 1 is believed. The evidence names it.
      const withholding = await coordinate(store, S.active1);
      assert.equal(withholding.outcome, 'established');
    });
  });

  it('30/31. an unavailable witness, or sources that disagree, refuse', async () => {
    await withStore(async (store) => {
      refused(await coordinate(store, S.active1, {}, { sourceVerifier: { async attestStatusSource() { throw new Error('witness down'); } } }), 'SOURCE_UNAVAILABLE');
      const split = sourceAttesting(T, (q) => [
        { sourceClass: 'issuer-status-channel', sourceRef: 'source:a', observedAt: T, status: { ...q.status } },
        { sourceClass: 'receiver-trusted-registry', sourceRef: 'source:b', observedAt: T, status: { sequence: 2, statusDigest: S.withdrawn2.digest } },
      ]);
      refused(await coordinate(store, S.active1, {}, { sourceVerifier: split, sourcePolicy: { acceptedSourceClasses: ['issuer-status-channel', 'receiver-trusted-registry'], maxSourceAgeSeconds: 300 } }), 'SOURCE_CONFLICT');
      await empty(store);
    });
  });
});

describe('FV-P4C-2B1 — the history transition (S2–S6)', () => {
  it('18/20. re-anchoring nothing, and anything over a latched conflict, is refused before authority is asked', async () => {
    await withStore(async (store) => {
      refused(await coordinate(store, S.active1, { operation: 'reanchor' }), 'HISTORY_REFUSED', 'NOT_ESTABLISHED');
      await trustedBootstrap(store, S.active1, T);
      assert.equal((await freshness(store, S.withdrawn2, T)).freshnessVerdict, 'WITHDRAWN');
      assert.equal((await freshness(store, S.equivocating2, T)).freshnessVerdict, 'CONFLICT_DETECTED');
      const authorizer = recordingAuthorizer();
      for (const [status, operation] of [[S.withdrawn2, 'reanchor'], [S.equivocating2, 'reanchor'], [S.reopening3, 'reanchor'], [S.active1, 'establish']]) {
        refused(await coordinate(store, status, { operation }, { authorizer }), 'HISTORY_REFUSED', 'CONFLICT_DETECTED');
      }
      assert.equal(authorizer.seen.length, 0);
      assert.equal((await store.read(KEY)).mark.conflict, true);
      assert.equal((await store.readBootstrapEvidence(KEY)).length, 1);
    });
  });

  it('21/22/23. no re-anchor reopens a withdrawal, revives retired terms or lowers the sequence', async () => {
    await withStore(async (store) => {
      await trustedBootstrap(store, S.active1, T);
      await freshness(store, S.withdrawn2, T);
      refused(await coordinate(store, S.reopening3, { operation: 'reanchor' }), 'HISTORY_REFUSED', 'REANCHOR_REACTIVATES_WITHDRAWN');
    });
    await withStore(async (store) => {
      await trustedBootstrap(store, S.active1, T);
      assert.equal((await freshness(store, S.superseding2, T)).freshnessVerdict, 'SUPERSEDED');
      refused(await coordinate(store, S.reviving3, { operation: 'reanchor' }), 'HISTORY_REFUSED', 'REANCHOR_REINTRODUCES_RETIRED_TERMS');
      refused(await coordinate(store, S.active1, { operation: 'reanchor' }), 'HISTORY_REFUSED', 'REANCHOR_ROLLBACK');
      // An ordinary bootstrap never touches an existing history.
      refused(await coordinate(store, S.superseding2), 'HISTORY_REFUSED', 'ALREADY_ESTABLISHED');
      assert.equal((await store.readBootstrapEvidence(KEY)).length, 1);
    });
  });

  it('a legitimate re-anchor commits its own evidence, linked to the state it replaced', async () => {
    await withStore(async (store) => {
      await trustedBootstrap(store, S.active1, T);
      await freshness(store, S.superseding2, T);
      const result = await coordinate(store, S.superseding2, { operation: 'reanchor' }, {}, '2026-10-28T12:01:00Z');
      assert.equal(result.reason, 'REESTABLISHED');
      assert.deepEqual(result.evidence.previous, { revision: 2, sequence: 2, statusDigest: S.superseding2.digest });
      assert.deepEqual(result.evidence.next, { revision: 3, sequence: 2, statusDigest: S.superseding2.digest });
      assert.equal((await store.readBootstrapEvidence(KEY)).length, 2);
    });
  });

  it('24/33. a status from the future of the trusted clock is refused', async () => {
    await withStore(async (store) => {
      refused(await coordinate(store, S.withdrawn2, {}, {}, '2026-10-28T11:54:00Z'), 'STATUS_REJECTED', 'STATUS_FROM_FUTURE');
      await empty(store);
    });
  });

  it('14/15/16. concurrent identical and conflicting bootstraps: exactly one commits, with exactly one evidence record', async () => {
    await withStore(async (store, path) => {
      const second = await openSqliteStatusHighWaterMarkStore(path, { namespace: store.namespace });
      try {
        const request = bootstrapRequest(store, S.active1, T);
        const identical = await Promise.all([store, second, store, second].map((s) => coordinateStatusHistoryBootstrap(request, S.active1.text, bootstrapContext(s, T))));
        assert.equal(identical.filter((r) => r.outcome === 'established').length, 1, identical.map((r) => r.reason).join());
        assert.equal((await store.readBootstrapEvidence(KEY)).length, 1);
      } finally {
        second.close();
      }
    });
    await withStore(async (store, path) => {
      const second = await openSqliteStatusHighWaterMarkStore(path, { namespace: store.namespace });
      try {
        const results = await Promise.all([trustedBootstrap(store, S.active1, T), trustedBootstrap(second, S.withdrawn2, T), trustedBootstrap(store, S.superseding2, T)]);
        assert.equal(results.filter((r) => r.outcome === 'established').length, 1, results.map((r) => `${r.reason}/${r.detail}`).join());
        const evidence = await store.readBootstrapEvidence(KEY);
        assert.equal(evidence.length, 1);
        assert.equal((await store.read(KEY)).mark.statusDigest, evidence[0].status.statusDigest, 'the evidence names the status that won');
      } finally {
        second.close();
      }
    });
  });
});

describe('FV-P4C-2B1 — store failures, atomicity and R2', () => {
  it('17/19. an unavailable or corrupt history is refused, never re-initialized', async () => {
    await withStore(async (store, path) => {
      await trustedBootstrap(store, S.active1, T);
      const db = new Database(path);
      db.pragma('ignore_check_constraints = ON');
      db.exec('DROP TRIGGER sovereign_status_history_forward_only');
      db.exec("UPDATE sovereign_status_history SET status_digest = 'tampered'");
      db.close();
      refused(await coordinate(store, S.active1), 'HISTORY_STORE_UNAVAILABLE');
      refused(await coordinate(store, S.superseding2, { operation: 'reanchor' }), 'HISTORY_STORE_UNAVAILABLE');
    });
    const dir = mkdtempSync(join(tmpdir(), 'fv-p4c2b1-closed-'));
    try {
      const closed = await openSqliteStatusHighWaterMarkStore(join(dir, 'h.sqlite'), { namespace: 'receiver:fv-p4c2b1', create: true });
      closed.close();
      refused(await coordinate(closed, S.active1), 'HISTORY_STORE_UNAVAILABLE');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('25. evidence missing after a commit quarantines the history for the gate and for bootstrap', async () => {
    await withStore(async (store, path) => {
      await trustedBootstrap(store, S.active1, T);
      const db = new Database(path);
      db.exec('DROP TRIGGER sovereign_status_bootstrap_evidence_never_deleted');
      db.exec('DELETE FROM sovereign_status_bootstrap_evidence');
      db.close();
      assert.equal((await freshness(store, S.active1, T)).freshnessVerdict, 'HISTORY_STORE_UNAVAILABLE');
      refused(await coordinate(store, S.active1), 'HISTORY_STORE_UNAVAILABLE');
      refused(await coordinate(store, S.active1, { operation: 'reanchor' }), 'HISTORY_STORE_UNAVAILABLE');
    });
  });

  it('26/27. a failure writing either half leaves neither: no evidence without a history, no history without evidence', async () => {
    for (const [table, trigger] of [['sovereign_status_history', 'inject_history'], ['sovereign_status_bootstrap_evidence', 'inject_evidence']]) {
      await withStore(async (store, path) => {
        const db = new Database(path);
        db.exec(`CREATE TRIGGER ${trigger} BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT, 'injected'); END;`);
        refused(await coordinate(store, S.active1), 'HISTORY_STORE_UNAVAILABLE');
        db.exec(`DROP TRIGGER ${trigger}`);
        db.close();
        await empty(store);
      });
    }
  });

  it('a receiver that reports success without committing is never reported as established', async () => {
    await withStore(async (store) => {
      const { verifySovereignStatus } = await import('@aoc-enterprise/sovereign-receiver-verification');
      const lying = { verifySovereignStatus, async establishStatusHistory() { return { outcome: 'established', reason: 'ESTABLISHED', statusRejection: null, mark: null }; } };
      refused(await coordinate(store, S.active1, {}, { receiver: lying }), 'HISTORY_REFUSED', 'ESTABLISHED');
      await empty(store);
    });
  });

  it('a store that reports a commit it did not make, or evidence that is not this request, is refused', async () => {
    await withStore(async (store) => {
      const pretending = {
        namespace: store.namespace,
        read: (k) => store.read(k),
        hasBootstrapRequest: (id) => store.hasBootstrapRequest(id),
        async compareAndSetWithEvidence(k, revision, next, draft) {
          return { ...draft, previous: null, next: { revision: 1, sequence: next.sequence, statusDigest: next.statusDigest }, reason: 'ESTABLISHED' };
        },
      };
      refused(await coordinate(store, S.active1, {}, { store: pretending }), 'COMMIT_UNVERIFIED');
      await empty(store);
    });
    await withStore(async (store) => {
      const substituting = {
        namespace: store.namespace,
        read: (k) => store.read(k),
        hasBootstrapRequest: (id) => store.hasBootstrapRequest(id),
        async compareAndSetWithEvidence(k, revision, next, draft) {
          const real = await store.compareAndSetWithEvidence(k, revision, next, draft);
          return real === false ? false : { ...real, authorityRef: 'authority:someone-else' };
        },
      };
      refused(await coordinate(store, S.active1, {}, { store: substituting }), 'COMMIT_UNVERIFIED');
    });
    await withStore(async (store) => {
      // The history and evidence really commit, but the store denies having recorded the request.
      const forgetful = {
        namespace: store.namespace,
        read: (k) => store.read(k),
        async hasBootstrapRequest() { return false; },
        compareAndSetWithEvidence: (...args) => store.compareAndSetWithEvidence(...args),
      };
      refused(await coordinate(store, S.active1, {}, { store: forgetful }), 'COMMIT_UNVERIFIED');
    });
    await withStore(async (store) => {
      let committed = false;
      const unreadable = {
        namespace: store.namespace,
        async read(k) {
          if (committed) throw new Error('disk vanished');
          return store.read(k);
        },
        hasBootstrapRequest: (id) => store.hasBootstrapRequest(id),
        async compareAndSetWithEvidence(...args) {
          const real = await store.compareAndSetWithEvidence(...args);
          committed = real !== false;
          return real;
        },
      };
      refused(await coordinate(store, S.active1, {}, { store: unreadable }), 'HISTORY_STORE_UNAVAILABLE');
    });
  });

  it('a bootstrap stays verifiable through later ordinary advances and a reopen', async () => {
    await withStore(async (store, path) => {
      const result = await trustedBootstrap(store, S.active1, T);
      assert.equal((await freshness(store, S.superseding2, T)).history.transition, 'advanced');
      assert.equal((await freshness(store, S.reviving3, '2026-10-28T12:01:00Z')).freshnessVerdict, 'CONFLICT_DETECTED');
      const reopened = await openSqliteStatusHighWaterMarkStore(path, { namespace: store.namespace });
      try {
        const entry = await reopened.read(KEY);
        assert.equal(entry.revision, 3);
        assert.equal(entry.mark.anchoredAt, T);
        assert.deepEqual(await reopened.readBootstrapEvidence(KEY), [result.evidence], 'the bootstrap record is unchanged and still matches its anchor');
        assert.equal((await freshness(reopened, S.superseding2, '2026-10-28T12:02:00Z')).freshnessVerdict, 'CONFLICT_DETECTED');
      } finally {
        reopened.close();
      }
    });
  });

  it('38. forged evidence written by a raw writer is detected when it does not validate, and grants nothing', async () => {
    await withStore(async (store, path) => {
      const db = new Database(path);
      db.prepare('INSERT INTO sovereign_status_bootstrap_evidence (request_id, sovereign_asset_id, issuer, next_revision, anchored_at, record) VALUES (?, ?, ?, 1, ?, ?)').run(
        'req:forged', KEY.sovereignAssetId, KEY.issuer, T, JSON.stringify({ schemaVersion: 'frontera.sovereign-status-bootstrap-evidence/1', approved: true }),
      );
      db.close();
      await assert.rejects(store.readBootstrapEvidence(KEY));
      assert.equal(await store.read(KEY), undefined, 'evidence alone creates no history');
      assert.equal((await freshness(store, S.active1, T)).freshnessVerdict, 'HISTORY_UNINITIALIZED');
    });
  });

  it('LIMIT 28. a database restored from a copy taken before the bootstrap looks like a fresh installation', async () => {
    await withStore(async (store, path, dir) => {
      const snapshot = join(dir, 'before.sqlite');
      const db = new Database(path);
      db.exec(`VACUUM INTO '${snapshot.replace(/'/g, "''")}'`);
      db.close();
      await trustedBootstrap(store, S.active1, T);
      await freshness(store, S.withdrawn2, T);
      const restored = await openSqliteStatusHighWaterMarkStore(snapshot, { namespace: store.namespace });
      try {
        assert.equal(await restored.read(KEY), undefined, 'the withdrawal and its evidence are forgotten: an external anchor is FV-P4D');
        assert.equal((await freshness(restored, S.active1, T)).freshnessVerdict, 'HISTORY_UNINITIALIZED', 'still fail-closed: it must be bootstrapped again');
      } finally {
        restored.close();
      }
    });
  });
});
