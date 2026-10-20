import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { DELEGATED_OFFER_SIGNER_PROTOCOL } from '../xrpl-trade-rail/index.js';
import { createReferenceDelegatedOfferKeyFile, loadReferenceDelegatedOfferKeyFile } from '../xrpl-trade-rail/reference/reference-delegated-offer-signer.js';
import { openReferenceCapabilityLedger } from '../xrpl-trade-rail/reference/reference-capability-ledger.js';
import { ORG, TRUST_DOMAIN } from './core04-host-fixture.js';
import { approvals, as, commandFor } from './core05-host-fixture.js';
import { closeDeploymentWitnesses } from './core07-freshness-fixture.js';
import { AUTHORITY_KEY_A } from './authority-authenticity-fixture.js';
import { decodeBlob, delegateFromSeed, testAccount } from './trade04b-xrpl-fixture.js';
import { FakeXrplLedger, SIGNER_ID, SIGNER_TOKEN } from './trade04c-execution-fixture.js';
import { APPROVER, Workspace, admit, bootTradeHost, governTrade, post, proposalFor, type TradeHost } from './trade04c-host-fixture.js';
import { httpJson, spawnOfferSigner } from './trade04c-s1-capability-fixture.js';

/**
 * TRADE-04C-S1 on the canonical shipped Host (production profile, SQLite,
 * signed grants under the Host's authority key, CORE-05 approvals, CORE-07
 * witness): every order the Host executes is signed only for a CORE-02
 * capability the composition issued over the authenticated grant store, and
 * the delegated signer refuses anyone — the Host's own credential included —
 * who presents none. OFFLINE: the labelled fake ledger, the reference signer
 * on loopback (in process behind HTTP, and as a separate process).
 */

const workspace = new Workspace();
let main: TradeHost;
/** Every request body the Host sent to the signer (the capability is not secret: what matters is that it cannot be reused). */
const observed: Record<string, unknown>[] = [];

before(async () => {
  main = await bootTradeHost(workspace);
  main.signer.rewrite = (request) => {
    observed.push(request);
    return request;
  };
});
after(async () => {
  await main?.signer.close().catch(() => {});
  workspace.cleanup();
  await closeDeploymentWitnesses();
});

/** The Host's last request to the signer — the proxy also sees the attacker's own requests, which carry no capability. */
const lastHostRequest = (): Record<string, unknown> => [...observed].reverse().find((request) => request['authorization'] !== undefined)!;

const counts = (trade: TradeHost) => ({ signatures: trade.signer.signatures(), sends: trade.ledger.submitCalls.length, consumed: Object.values(trade.signer.ledger.counts()).reduce((sum, n) => sum + n, 0) });

describe('TRADE-04C-S1 — the shipped Host: authorized orders sign under a capability, exactly once', () => {
  it('an executed order: one capability, issued by the composition for this P11 execution and its grant, consumed by the one signature that was sent', async () => {
    const before = counts(main);
    const reply = await governTrade(main, proposalFor(main, '60'));
    assert.equal(reply.body['status'], 'executed', reply.text);
    assert.deepEqual(counts(main), { signatures: before.signatures + 1, sends: before.sends + 1, consumed: before.consumed + 1 });
    const trace = main.traces.at(-1)!;
    assert.match(trace.capabilityId ?? '', /^[0-9a-f]{64}$/);
    const row = main.signer.ledger.read(trace.capabilityId!);
    assert.equal(row?.state, 'signed');
    assert.equal(row?.transactionHash, main.ledger.submitted.at(-1)!.hash, 'the consumed capability signed exactly the transaction that was sent');
    const sent = lastHostRequest();
    const capability = JSON.parse((sent['authorization'] as { capability: string }).capability) as Record<string, unknown>;
    assert.equal(capability['executionId'], reply.body['executionId']);
    assert.equal(capability['trustDomain'], TRUST_DOMAIN);
    assert.equal(capability['organizationId'], ORG);
    assert.equal(capability['issuerKeyId'], AUTHORITY_KEY_A.keyId);
    assert.ok(Date.parse(capability['expiresAt'] as string) - Date.parse(capability['issuedAt'] as string) <= 60_000);
  });

  it('withheld for approval or denied: no capability is issued or consumed before a grant exists; approved, the resumed request consumes exactly one', async () => {
    const before = counts(main);
    const intent = await admit(main, proposalFor(main, '850'));
    const withheld = await post(main, intent);
    assert.equal(withheld.body['status'], 'withheld', withheld.text);
    const denied = await governTrade(main, proposalFor(main, '3000'));
    assert.equal(denied.body['status'], 'denied', denied.text);
    assert.deepEqual(counts(main), before, 'zero capabilities, signatures and sends');
    const view = await approvals(main.host).describe(withheld.body['requestId'] as string);
    await approvals(main.host).approve(as(APPROVER), commandFor(view!));
    const resumed = await post(main, intent);
    assert.equal(resumed.body['status'], 'executed', resumed.text);
    assert.deepEqual(counts(main), { signatures: before.signatures + 1, sends: before.sends + 1, consumed: before.consumed + 1 });
  });
});

describe('TRADE-04C-S1 — an attacker holding the Host’s signer credential, on the signer’s own port', () => {
  it('without a capability: zero signatures, however the request is shaped', async () => {
    const before = counts(main);
    const url = `${main.signer.endpoint}/v1/sign/xrpl-delegated-offer`;
    const template = lastHostRequest();
    const transaction = { ...(template['transaction'] as Record<string, unknown>), Sequence: 7_777, TakerPays: '999000000' };
    const base = { protocol: DELEGATED_OFFER_SIGNER_PROTOCOL, signerId: SIGNER_ID, requestId: 'e1'.repeat(32), network: template['network'], ownerAccount: template['ownerAccount'], delegateAccount: template['delegateAccount'], transaction };
    for (const request of [base, { ...base, audit: { executionId: 'x', grantRef: 'y', grantDigest: `sha256:${'ab'.repeat(32)}` } }, { ...base, proposal: template['proposal'] }]) {
      const answer = await httpJson(url, 'POST', SIGNER_TOKEN, request);
      assert.equal(answer.status, 422, JSON.stringify(answer.body));
    }
    assert.deepEqual(counts(main), before);
  });

  it('with a capability the Host used (observed in transit): replay refused; re-bound to another order refused', async () => {
    const before = counts(main);
    const url = `${main.signer.endpoint}/v1/sign/xrpl-delegated-offer`;
    const used = lastHostRequest();
    assert.deepEqual(await httpJson(url, 'POST', SIGNER_TOKEN, { ...used, requestId: 'e2'.repeat(32) }), { status: 409, body: { error: 'capability-consumed' } });
    const rebound = { ...used, requestId: 'e3'.repeat(32), transaction: { ...(used['transaction'] as Record<string, unknown>), TakerPays: '1' } };
    assert.deepEqual(await httpJson(url, 'POST', SIGNER_TOKEN, rebound), { status: 422, body: { error: 'capability-transaction-mismatch' } });
    assert.deepEqual(counts(main), before);
  });

  it('a capability intercepted before the Host used it (credential and channel both compromised): at most the exact authorized blob, once; Frontera sends nothing and signs nothing twice', async () => {
    const trade = await bootTradeHost(workspace);
    try {
      let intercepted: Record<string, unknown> | undefined;
      // The attacker sits on the channel: it keeps the Host's request and spoils what reaches the signer.
      trade.signer.rewrite = (request) => {
        intercepted = request;
        return { ...request, authorization: { capability: '{"stripped":true}', signature: (request['authorization'] as { signature: unknown }).signature } };
      };
      const raced = { signatures: 0 };
      const reply = await governTrade(trade, proposalFor(trade, '45'));
      assert.notEqual(reply.body['status'], 'executed', 'the Host’s own request was spoiled in transit');
      assert.ok(intercepted !== undefined);
      trade.signer.rewrite = undefined;
      const stolen = await httpJson(`${trade.signer.endpoint}/v1/sign/xrpl-delegated-offer`, 'POST', SIGNER_TOKEN, { ...intercepted, requestId: 'e4'.repeat(32) });
      assert.equal(stolen.status, 200, 'the race yields the authorized order, once');
      raced.signatures += 1;
      const fields = decodeBlob((stolen.body as { signedTransaction: string }).signedTransaction);
      assert.deepEqual(fields['TakerPays'], (intercepted['transaction'] as Record<string, unknown>)['TakerPays'], 'and nothing but the granted terms');
      assert.equal((await httpJson(`${trade.signer.endpoint}/v1/sign/xrpl-delegated-offer`, 'POST', SIGNER_TOKEN, { ...intercepted, requestId: 'e5'.repeat(32) })).status, 409);
      assert.equal(trade.ledger.submitCalls.length, 0, 'Frontera sent nothing');
      assert.equal(raced.signatures, 1);
    } finally {
      await trade.signer.close();
    }
  });
});

describe('TRADE-04C-S1 §7 — the shipped Host against a real separate-process reference signer', () => {
  it('Scenario A through a separate signer process: executed once under a capability; a replay and a credential-only request refused by that process', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'trade04c-s1-host-process-'));
    let stop: (() => Promise<void>) | undefined;
    try {
      const ledger = new FakeXrplLedger();
      const owner = testAccount();
      const keyFile = join(dir, 'delegate-keys.json');
      createReferenceDelegatedOfferKeyFile(keyFile, { network: 'xrp-ledger-testnet', ownerAccounts: [owner] });
      const delegate = delegateFromSeed(loadReferenceDelegatedOfferKeyFile(keyFile).keys[0]!.delegateSeed);
      ledger.fund(owner, 41);
      ledger.fund(delegate.address, 5);
      ledger.delegate(owner, delegate.address, ['OfferCreate']);
      const authorityPublicKeyFile = join(dir, 'authority.pub');
      writeFileSync(authorityPublicKeyFile, AUTHORITY_KEY_A.publicKeyPem);
      const ledgerPath = join(dir, 'capability-ledger.sqlite');
      const signer = await spawnOfferSigner({ keyFile, signerId: SIGNER_ID, credential: SIGNER_TOKEN, authorityKeyId: AUTHORITY_KEY_A.keyId, authorityPublicKeyFile, trustDomain: TRUST_DOMAIN, organizationId: ORG, ledgerPath, initializeLedger: true });
      stop = () => signer.stop();
      const trade = await bootTradeHost(workspace, { ledger, pair: { owner, delegate }, signerEndpoint: signer.endpoint });
      try {
        const reply = await governTrade(trade, proposalFor(trade, '70'));
        assert.equal(reply.body['status'], 'executed', reply.text);
        assert.equal(trade.ledger.submitCalls.length, 1);
        assert.equal(trade.signer.signatures(), 0, 'the in-process proxy was not used: the separate process signed');
        const reading = await openReferenceCapabilityLedger(ledgerPath);
        try {
          assert.deepEqual(reading.counts(), { consumed: 0, signed: 1, 'signing-failed': 0 });
          assert.equal(reading.read(trade.traces.at(-1)!.capabilityId!)?.transactionHash, trade.ledger.submitted.at(-1)!.hash);
        } finally {
          reading.close();
        }
        const credentialOnly = await httpJson(`${signer.endpoint}/v1/sign/xrpl-delegated-offer`, 'POST', SIGNER_TOKEN, { protocol: DELEGATED_OFFER_SIGNER_PROTOCOL, signerId: SIGNER_ID, requestId: 'f1'.repeat(32), network: 'xrp-ledger-testnet', ownerAccount: owner, delegateAccount: delegate.address, transaction: { TransactionType: 'OfferCreate', Account: owner, Delegate: delegate.address, TakerGets: '1000000', TakerPays: '2000000', Flags: 0, Sequence: 41, Fee: '12', LastLedgerSequence: 99 } });
        assert.equal(credentialOnly.status, 422);
        const second = await governTrade(trade, proposalFor(trade, '71'));
        assert.equal(second.body['status'], 'executed', second.text);
        assert.equal(trade.ledger.submitCalls.length, 2);
      } finally {
        await trade.signer.close();
      }
    } finally {
      await stop?.().catch(() => {});
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
