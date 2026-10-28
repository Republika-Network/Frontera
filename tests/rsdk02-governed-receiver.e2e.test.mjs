// RSDK-02B — the governed sovereign receiver end to end, on loopback, with nothing mocked on the security path:
//
//   Host side   the real Generic HTTP mapper and request binding, a G-02A capability signed with the test issuer key,
//               and the Host's real transport (`sendOnce`) carrying the presentation header and reading the receipt
//   receiver    a loopback HTTP server running the governed receiver: the existing G-02 pipeline under pinned issuer
//               keys, real RSDK-01 verification of a signed synthetic bundle, the demonstration policy, the existing
//               consumption ledger, the existing synthetic effect and the existing receipt issuer
//   evidence    the receipt verified by the standalone G-02C1C verifier, built from the executor's public key only
//
// Not shipped (tests/), synthetic and local. No TLS (the Host's transport is pointed at plain HTTP loopback, as in
// the G-02C1 suites), no production API, no funds, no third party.
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { verifyReceivedSovereignAsset } from '@aoc-enterprise/sovereign-receiver-verification';

import { createGovernedSovereignReceiver } from '../dist/src/enterprise/governed-receiver/index.js';
import { createDemonstrationAssetPolicy } from '../dist/src/enterprise/governed-receiver/demonstration-policy.js';
import { openExecutionCapabilityConsumptionLedger } from '../dist/src/enterprise/execution-capability/reference/consumption-ledger.js';
import { createExecutorReceiptVerifier, decodeExecutorReceiptTransport } from '../dist/src/enterprise/executor-receipt/index.js';
import { parseReferenceExecutorConfiguration } from '../dist/src/enterprise/reference-executor/index.js';
import { createExecutorReceiptIssuer } from '../dist/src/enterprise/reference-executor/receipt-issuer.js';
import { openExecutorReceiptLedger } from '../dist/src/enterprise/reference-executor/receipt-ledger.js';
import { loadExecutorReceiptSigner } from '../dist/src/enterprise/reference-executor/receipt-signer.js';
import { admitsEffect, openSyntheticDeploymentEffect } from '../dist/src/enterprise/reference-executor/synthetic-effect.js';
import {
  AUDIENCE,
  EXECUTOR_ENVIRONMENT,
  EXECUTOR_ID,
  ISSUER,
  ISSUER_KEY,
  ORGANIZATION,
  TRUST_DOMAIN,
  UNPINNED_KEY,
  capabilityFor,
  hostVector,
  presentationFor,
  sendThroughHostTransport,
  validatedAction,
  withPresentation,
} from '../dist/src/enterprise/__tests__/g02c1a-reference-executor-fixture.js';
import { SYNTHETIC_ACTION } from '../dist/src/enterprise/__tests__/g02c1b-synthetic-execution-fixture.js';
import { BINDING_FORMAT, ISSUER_PINS, RECEIPT_KEY_ID, receiptConfiguration, receiptDomain, trustedExecutor } from '../dist/src/enterprise/__tests__/g02c1c-executor-receipt-fixture.js';

const FIXTURE = JSON.parse(readFileSync(new URL('./fixtures/rsdk02-governed-receiver/assets.json', import.meta.url), 'utf8'));
const { active, withdrawn, foreignClaim } = FIXTURE.assets;
const RECEIPT_HEADER = 'frontera-execution-receipt';
const MAXIMUM_BODY_BYTES = 64 * 1024;

/** RSDK-01 composed by the deployment: its trusted resolver and consumer support, never the request's. */
const trustedSovereignKeys = new Map([
  [FIXTURE.registrant.issuer, FIXTURE.registrant.keyId],
  [FIXTURE.foreign.issuer, FIXTURE.foreign.keyId],
]);
const verificationKeyResolver = Object.freeze({
  resolveVerificationKey: (issuer) => (trustedSovereignKeys.has(issuer) ? { keyId: trustedSovereignKeys.get(issuer), issuer, algorithm: 'ed25519' } : undefined),
});
let realVerifications = 0;
const verifyAsset = (bundleText, request) => {
  realVerifications += 1;
  return verifyReceivedSovereignAsset(bundleText, { verificationKeyResolver, consumerSupport: FIXTURE.consumerSupport, ...request });
};

/** The receiver's trusted store. `misfiled` stores another asset's bundle under `active`'s id. */
const stored = (entry) => ({ bundleText: entry.bundleText, contentBytes: new Uint8Array(Buffer.from(entry.contentBase64, 'base64')) });
const STORE = new Map([
  [active.sovereignAssetId, stored(active)],
  [withdrawn.sovereignAssetId, stored(withdrawn)],
  [foreignClaim.sovereignAssetId, stored(foreignClaim)],
]);

const policy = createDemonstrationAssetPolicy({
  trustedRegistrants: [FIXTURE.registrant.issuer],
  operations: { [SYNTHETIC_ACTION]: { claimTypes: ['Origin'], requiredClaimTypes: ['Origin'] } },
});

let domain;
let receiptLedger;
const opened = [];

/** One receiver process stand-in: a loopback server over the shared durable ledger. */
async function startReceiver({ store = STORE, fault } = {}) {
  const configuration = parseReferenceExecutorConfiguration(receiptConfiguration(domain), EXECUTOR_ENVIRONMENT);
  const clock = () => Date.now();
  const ledger = await openExecutionCapabilityConsumptionLedger(domain.ledgerPath, { audience: AUDIENCE, clock });
  opened.push(ledger);
  const effect = openSyntheticDeploymentEffect({ outputDirectory: domain.outputDirectory, durablyClaimed: (id) => admitsEffect(ledger.read(id).state) });
  const signer = loadExecutorReceiptSigner({ executorId: EXECUTOR_ID, keyId: RECEIPT_KEY_ID, privateKeyFile: domain.keyFile, receiptLedger, issuerKeys: ISSUER_PINS });
  const receipts = createExecutorReceiptIssuer({ executorId: EXECUTOR_ID, audience: AUDIENCE, bindingFormat: BINDING_FORMAT, consumption: ledger, receipts: receiptLedger, signer, outputDirectory: domain.outputDirectory });
  const receiver = createGovernedSovereignReceiver({
    configuration,
    ledger,
    effect,
    clock,
    receipts,
    ...(fault !== undefined ? { fault } : {}),
    assets: { load: (id) => store.get(id) },
    verifyAsset,
    policy,
  });
  const server = createServer((req, res) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAXIMUM_BODY_BYTES) req.destroy();
      else chunks.push(chunk);
    });
    req.on('end', async () => {
      const observed = { httpVersion: req.httpVersion, method: req.method ?? '', target: req.url ?? '', rawHeaders: req.rawHeaders, body: Buffer.concat(chunks) };
      const answer = await receiver.handle(observed);
      const body = JSON.stringify(answer.record);
      res.writeHead(answer.status, { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)), connection: 'close', ...answer.headers });
      res.end(body);
    });
  });
  await new Promise((ready) => server.listen(0, '127.0.0.1', ready));
  return {
    port: server.address().port,
    issueFromDurableState: (capabilityId) => receipts.issue(capabilityId),
    close: () => new Promise((done) => server.close(done)),
  };
}

/** A governed request for `resource`, as the Host builds and binds it, presented with a capability for exactly it. */
function governedRequest(resource, { key = ISSUER_KEY, keyId } = {}) {
  const vector = hostVector(`rsdk02-e2e:${resource}`, {}, validatedAction({ action: SYNTHETIC_ACTION, resource }));
  const capability = capabilityFor(vector.digest, { action: SYNTHETIC_ACTION, resource });
  const presentation = presentationFor(capability, key, keyId ?? key.keyId);
  return { capability, request: withPresentation(vector.request, presentation) };
}

/** Sends through the Host's own transport; the receipt values come back exactly as the Host's recorder would read them. */
async function send(receiver, request) {
  const observation = await sendThroughHostTransport(receiver.port, request);
  assert.equal(observation.kind, 'response');
  return observation;
}

const receiptVerifier = () => createExecutorReceiptVerifier({ trustedExecutors: [trustedExecutor(domain.publicKeyPem)] });

before(async () => {
  domain = await receiptDomain();
  receiptLedger = await openExecutorReceiptLedger(domain.receiptLedgerPath, { executorId: EXECUTOR_ID, audience: AUDIENCE, clock: () => Date.now() });
});
after(() => {
  for (const ledger of opened) ledger.close();
  receiptLedger?.close();
  domain?.cleanup();
});

describe('RSDK-02B governed sovereign receiver — loopback PUSH demonstration', () => {
  it('1 · a valid governed request: verified, claimed, the synthetic effect observed once, and an independently verifiable receipt', async () => {
    const receiver = await startReceiver();
    try {
      const before = realVerifications;
      const { capability, request } = governedRequest(active.sovereignAssetId);
      const response = await send(receiver, request);
      assert.equal(response.status, 201);
      assert.equal(realVerifications, before + 1, 'RSDK-01 itself verified the stored bundle');
      assert.equal(domain.records().length, 1);
      const decoded = decodeExecutorReceiptTransport(response.receiptValues ?? []);
      assert.ok(decoded.ok, 'exactly one receipt came back');
      const verification = receiptVerifier().verify(decoded.presented, {
        expected: { executorId: EXECUTOR_ID, issuer: ISSUER, capabilityId: capability.capabilityId, executionId: capability.executionId, audience: AUDIENCE, organizationId: ORGANIZATION, trustDomain: TRUST_DOMAIN, actionBinding: capability.actionBinding },
      });
      assert.equal(verification.failure, null);
      assert.equal(verification.signature, 'valid');
      assert.equal(verification.identityMatch, 'yes');
      assert.equal(verification.bindingMatch, 'yes');
      assert.equal(verification.reportedOutcome, 'completed-observed');
      assert.equal(verification.externalConfirmation, 'not-established', 'a receipt is the executor’s statement, never external proof');

      // 5 · the same governed request again: answered from the ledger, nothing performed again.
      const replay = await send(receiver, request);
      assert.equal(replay.status, 202);
      assert.equal(domain.records().length, 1);
    } finally {
      await receiver.close();
    }
  });

  it('2 · an invalid signature is refused before the asset is touched', async () => {
    const receiver = await startReceiver();
    try {
      const before = realVerifications;
      const { request } = governedRequest(active.sovereignAssetId, { key: UNPINNED_KEY, keyId: ISSUER_KEY.keyId });
      const response = await send(receiver, request);
      assert.equal(response.status, 403);
      assert.equal(realVerifications, before, 'an unverified capability never reaches RSDK-01');
      assert.deepEqual(response.receiptValues ?? [], []);
    } finally {
      await receiver.close();
    }
  });

  it('3 · a stored bundle for the wrong asset is rejected by RSDK-01 and nothing is claimed', async () => {
    const misfiled = new Map([[active.sovereignAssetId, stored(withdrawn)]]);
    const receiver = await startReceiver({ store: misfiled });
    try {
      const records = domain.records().length;
      const { capability, request } = governedRequest(active.sovereignAssetId);
      const response = await send(receiver, request);
      assert.equal(response.status, 403);
      assert.equal(domain.records().length, records);
      assert.equal((await domain.state(capability.capabilityId)).state, 'absent');
    } finally {
      await receiver.close();
    }
  });

  it('4 · verified but ineligible assets (withdrawn; a foreign claim) are refused and nothing is claimed', async () => {
    const receiver = await startReceiver();
    try {
      for (const entry of [withdrawn, foreignClaim]) {
        const records = domain.records().length;
        const { capability, request } = governedRequest(entry.sovereignAssetId);
        const response = await send(receiver, request);
        assert.equal(response.status, 403, entry.sovereignAssetId);
        assert.equal(domain.records().length, records);
        assert.equal((await domain.state(capability.capabilityId)).state, 'absent');
      }
    } finally {
      await receiver.close();
    }
  });

  it('6 · an interruption after the claim leaves the outcome unknown; the replay is refused and the receipt says so', async () => {
    const interrupted = await startReceiver({
      fault: (point) => {
        if (point === 'after-claim') throw new Error('receiver stopped after the claim');
      },
    });
    const { capability, request } = governedRequest(active.sovereignAssetId);
    const records = domain.records().length;
    try {
      const response = await send(interrupted, request);
      assert.equal(response.status, 502);
      assert.equal((await domain.state(capability.capabilityId)).state, 'claimed');
      assert.equal(domain.records().length, records, 'the effect never ran');
    } finally {
      await interrupted.close();
    }
    // A fresh receiver over the same durable ledger, as after a restart.
    const restarted = await startReceiver();
    try {
      const replay = await send(restarted, request);
      assert.equal(replay.status, 202);
      assert.equal(domain.records().length, records, 'nothing is retried');
      const issuance = restarted.issueFromDurableState(capability.capabilityId);
      assert.equal(issuance.status, 'issued');
      assert.equal(issuance.outcome, 'attempted-outcome-unknown');
      // 7 · that receipt, verified independently from the executor's public key alone.
      const verification = receiptVerifier().verify(issuance.receipt, { expected: { capabilityId: capability.capabilityId, executionId: capability.executionId } });
      assert.equal(verification.signature, 'valid');
      assert.equal(verification.reportedOutcome, 'attempted-outcome-unknown');
    } finally {
      await restarted.close();
    }
  });
});
