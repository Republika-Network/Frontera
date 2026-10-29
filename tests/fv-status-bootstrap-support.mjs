// FV-P4C-2B1 — test support: the synthetic document fixture, and a trusted bootstrap through the real coordinator with
// synthetic, recording authority and source providers. Not a test file itself; nothing here is used outside tests.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

import { establishStatusHistory, verifySovereignStatus } from '@aoc-enterprise/sovereign-receiver-verification';

import { coordinateStatusHistoryBootstrap } from '../dist/src/enterprise/sovereign-status-history/index.js';

export const FIXTURE = JSON.parse(readFileSync(new URL('./fixtures/fv-p4c2a-sqlite-status-history/chain.json', import.meta.url), 'utf8'));
export const S = FIXTURE.statuses;
export const resolver = {
  resolveVerificationKey: (issuer) => (issuer === FIXTURE.registrant.issuer ? { keyId: FIXTURE.registrant.keyId, issuer, algorithm: 'ed25519' } : undefined),
};
export const SUBJECT = Object.freeze({ sovereignAssetId: FIXTURE.sovereignAssetId, registrant: FIXTURE.registrant.issuer, manifestDigest: FIXTURE.manifestDigest });

let counter = 0;

/** A bootstrap request for `status`, valid for 10 minutes from `createdAt`. */
export function bootstrapRequest(store, status, createdAt, overrides = {}) {
  counter += 1;
  const operation = overrides.operation ?? 'establish';
  return {
    schemaVersion: 'frontera.sovereign-status-bootstrap/1',
    requestId: `req:fv-p4c2b1-${counter}`,
    operation,
    purpose: operation === 'establish' ? 'initial-trust-anchor' : 'continuity-restoration',
    namespace: store.namespace,
    sovereignAssetId: FIXTURE.sovereignAssetId,
    issuer: FIXTURE.registrant.issuer,
    manifestDigest: FIXTURE.manifestDigest,
    status: { sequence: status.sequence, statusDigest: status.digest },
    terms: JSON.parse(status.text).status.currentTerms,
    operatorRef: 'operator:synthetic-1',
    sourceRef: 'source:issuer-channel',
    createdAt,
    expiresAt: addSeconds(createdAt, 600),
    ...overrides,
  };
}

/** An authorizer that authorizes exactly the bindings it is told to, and records every binding it saw. */
export function recordingAuthorizer(decide = () => true) {
  const seen = [];
  return {
    seen,
    async authorizeStatusHistoryBootstrap(binding, bindingDigest) {
      seen.push({ binding, bindingDigest });
      const recomputed = createHash('sha256').update(canonical(binding)).digest('hex');
      if (recomputed !== bindingDigest) throw new Error('the coordinator sent a digest that is not its binding');
      return decide(binding) ? { outcome: 'authorized', bindingDigest, authorityRef: `authority:synthetic:${binding.requestId}` } : { outcome: 'denied' };
    },
  };
}

/** A source that attests `status` (or what `answer` returns) as the latest it knows, observed at `observedAt`. */
export function sourceAttesting(observedAt, answer) {
  return {
    async attestStatusSource(query) {
      if (answer) return answer(query);
      return { sourceClass: 'issuer-status-channel', sourceRef: 'source:issuer-channel', observedAt, status: { ...query.status } };
    },
  };
}

export function bootstrapContext(store, evaluationTime, overrides = {}) {
  return {
    store,
    trustedSubject: { ...SUBJECT },
    evaluationTime,
    operationId: `op:bootstrap:${evaluationTime}`,
    verificationKeyResolver: resolver,
    receiver: { verifySovereignStatus, establishStatusHistory },
    authorizer: recordingAuthorizer(),
    sourceVerifier: sourceAttesting(evaluationTime),
    sourcePolicy: { acceptedSourceClasses: ['issuer-status-channel'], maxSourceAgeSeconds: 300 },
    ...overrides,
  };
}

/** A trusted bootstrap of `status` through the real coordinator, at `evaluationTime`. */
export function trustedBootstrap(store, status, evaluationTime, { operation = 'establish', request = {}, context = {} } = {}) {
  return coordinateStatusHistoryBootstrap(bootstrapRequest(store, status, evaluationTime, { operation, ...request }), status.text, bootstrapContext(store, evaluationTime, context));
}

function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}

/** Adds whole seconds to a canonical `YYYY-MM-DDTHH:MM:SS[.f]Z` timestamp (test fixtures only). */
export function addSeconds(timestamp, seconds) {
  const base = timestamp.replace(/\.\d+Z$/, 'Z');
  const fraction = /\.(\d+)Z$/.exec(timestamp)?.[1];
  const shifted = new Date(new Date(base).getTime() + seconds * 1000).toISOString().replace('.000Z', 'Z');
  return fraction === undefined ? shifted : shifted.replace('Z', `.${fraction}Z`);
}
