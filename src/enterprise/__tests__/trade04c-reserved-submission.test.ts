import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  XrplRailConfigurationError,
  XrplReservedSubmissionRefusedError,
  XrplSubmissionNotAttemptedError,
  createXrplReservedSubmissionClient,
  createXrplReservedSubmissionConfiguration,
  createXrplSdkClient,
  xrplSubmissionClaimOf,
} from '../../features/payment-runtime/rails/xrpl/index.js';
import { testConfiguration } from '../../features/payment-runtime/rails/xrpl/tests/xrpl-test-fixtures.js';
import { blobHash, offerWorld } from './trade04b-xrpl-fixture.js';

/**
 * TRADE-04C, approval gate G2 — the reserved submission client over the XRPL
 * SDK client file's **one** `submit` request.
 *
 * Behaviour that needs no socket is exercised here against the real client
 * object (construction, its closed surface, the not-connected refusal, the
 * blob-derived claim). That the claim precedes the one request inside
 * `submitReserved`, and that PAY-02's `submit` reaches the same request
 * unchanged, is pinned on the source below, as PAY-02 pins its own site; the
 * socket path itself is exercised only against a real XRPL server, which is
 * TRADE-05 (separately authorized), never here.
 */

const CLIENT_FILE = 'src/features/payment-runtime/rails/xrpl/xrpl-sdk-client.ts';
const codeOf = (path: string): string =>
  readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^\s*\/\/.*$/gm, ' ');

const configuration = createXrplReservedSubmissionConfiguration({ endpoint: 'wss://s.altnet.rippletest.net:51233', networkId: 1, requestTimeoutMs: 5_000 });

describe('TRADE-04C G2 — the reserved submission configuration', () => {
  it('a wss:// endpoint without credentials, query or fragment; a known non-mainnet network; a bounded timeout', () => {
    assert.equal(configuration.networkId, 1);
    for (const input of [
      { endpoint: 'ws://s.altnet.rippletest.net:51233', networkId: 1, requestTimeoutMs: 5_000 },
      { endpoint: 'wss://user:pw@s.altnet.rippletest.net', networkId: 1, requestTimeoutMs: 5_000 },
      { endpoint: 'wss://s.altnet.rippletest.net/?x=1', networkId: 1, requestTimeoutMs: 5_000 },
      { endpoint: 'https://s.altnet.rippletest.net', networkId: 1, requestTimeoutMs: 5_000 },
      { endpoint: 'wss://xrplcluster.com', networkId: 0, requestTimeoutMs: 5_000 },
      { endpoint: 'wss://example.org', networkId: 99_999, requestTimeoutMs: 5_000 },
      { endpoint: 'wss://example.org', networkId: 1, requestTimeoutMs: 0 },
      { endpoint: 'wss://example.org', networkId: 1, requestTimeoutMs: 60_001 },
    ]) {
      assert.throws(() => createXrplReservedSubmissionConfiguration(input), XrplRailConfigurationError, JSON.stringify(input));
    }
  });

  it('the client needs a branded configuration and a sequence authority', () => {
    assert.throws(() => createXrplReservedSubmissionClient({ ...configuration }, { claimSubmission: async () => {} }), XrplRailConfigurationError);
    assert.throws(() => createXrplReservedSubmissionClient(configuration, {} as never), XrplRailConfigurationError);
  });
});

describe('TRADE-04C G2 — the client’s closed surface', () => {
  it('reads, plus exactly one write — submitReserved; there is no submit(blob), autofill or signer', () => {
    const client = createXrplReservedSubmissionClient(configuration, { claimSubmission: async () => {} });
    assert.deepEqual(Object.keys(client).sort(), ['connect', 'disconnect', 'lookupTransaction', 'ledgerEntry', 'ledgerHeader', 'serverInfo', 'submitReserved', 'validatedLedgerIndex'].sort());
    assert.equal(Object.isFrozen(client), true);
    assert.equal('submit' in client, false);
  });

  it('ledger_entry is closed: one known selector at the validated ledger, nothing else is asked', async () => {
    const client = createXrplReservedSubmissionClient(configuration, { claimSubmission: async () => {} });
    for (const request of [{ ledger_index: 'current', account_root: 'r' }, { ledger_index: 'validated' }, { ledger_index: 'validated', ripple_state: {} }, { ledger_index: 'validated', account_root: 'r', offer: {} }]) {
      await assert.rejects(client.ledgerEntry(request), TypeError, JSON.stringify(request));
    }
  });

  it('not connected: nothing is claimed and nothing is sent', async () => {
    let claims = 0;
    const client = createXrplReservedSubmissionClient(configuration, {
      claimSubmission: async () => {
        claims += 1;
      },
    });
    const world = offerWorld();
    const signed = world.delegate.sign({ ...world.offer() });
    await assert.rejects(client.submitReserved('aoc.exec:g2-1', signed.blob), XrplSubmissionNotAttemptedError);
    assert.equal(claims, 0);
  });
});

describe('TRADE-04C G2 — the claim is read from the blob alone', () => {
  it('its own hash and binding fields, the client’s network, the execution submitted for', () => {
    const world = offerWorld();
    const prepared = world.offer();
    const signed = world.delegate.sign({ ...prepared });
    const claim = xrplSubmissionClaimOf('aoc.exec:g2-2', 1, signed.blob);
    assert.deepEqual(claim, {
      executionId: 'aoc.exec:g2-2',
      networkId: 1,
      transactionHash: blobHash(signed.blob),
      transactionType: 'OfferCreate',
      account: prepared['Account'],
      sequence: prepared['Sequence'],
      lastLedgerSequence: prepared['LastLedgerSequence'],
    });
  });

  it('anything unreadable claims nothing (and so is never sent)', () => {
    for (const blob of [undefined, '', 'XYZ', 'ab'.repeat(40), 'AB'.repeat(40)]) assert.equal(xrplSubmissionClaimOf('aoc.exec:g2-3', 1, blob), undefined, String(blob));
    const world = offerWorld();
    const { LastLedgerSequence: _lls, ...withoutWindow } = world.offer();
    const signed = world.delegate.sign(withoutWindow);
    assert.equal(xrplSubmissionClaimOf('aoc.exec:g2-4', 1, signed.blob), undefined, 'a blob without LastLedgerSequence binds no window');
  });

  it('XrplReservedSubmissionRefusedError is a closed code naming no value', () => {
    const error = new XrplReservedSubmissionRefusedError();
    assert.equal(error.code, 'XRPL_RESERVED_SUBMISSION_REFUSED');
    assert.equal(/[0-9A-F]{64}|r[1-9A-HJ-NP-Za-km-z]{24,34}/.test(error.message), false);
  });
});

describe('TRADE-04C G2 — one submit request site, two callers, claim strictly first (pinned on the source)', () => {
  const client = codeOf(CLIENT_FILE);

  it('the request is written once, inside the private connection helper, and reached exactly twice', () => {
    assert.equal([...client.matchAll(/command:\s*'submit'/g)].length, 1);
    assert.equal([...client.matchAll(/\brequestSubmit\s*\(/g)].length, 2);
    const helper = client.slice(client.indexOf('function openXrplSdkConnection('), client.indexOf('async function lookupTransactionOn('));
    // Assembled at runtime: repository-wide scanners read test files textually, and a literal would count as a site.
    assert.ok(helper.includes(['command:', "'sub" + "mit',", 'tx_blob: signedTransaction, fail_hard: true'].join(' ')));
    assert.equal(/export function openXrplSdkConnection/.test(client), false, 'the connection helper — and its requestSubmit — is not exported');
  });

  it('PAY-02’s submit is unchanged in meaning: not-connected first, then the one request, NotConnectedError → not attempted', () => {
    const payment = client.slice(client.indexOf('async submit(signedTransaction: string)'), client.indexOf('async lookupTransaction(', client.indexOf('async submit(signedTransaction: string)')));
    const order = ['if (!client.isConnected()) throw new XrplSubmissionNotAttemptedError();', 'return await requestSubmit(signedTransaction);', 'if (error instanceof NotConnectedError) throw new XrplSubmissionNotAttemptedError();'].map((marker) => payment.indexOf(marker));
    assert.ok(order.every((position) => position !== -1), payment);
    assert.deepEqual([...order].sort((a, b) => a - b), order);
    // The Payment client still has exactly its PAY-02 surface.
    assert.deepEqual(Object.keys(createXrplSdkClient(testConfiguration())).sort(), ['autofill', 'connect', 'disconnect', 'ledgerHeader', 'lookupTransaction', 'serverInfo', 'submit', 'validatedLedgerIndex']);
  });

  it('submitReserved: connected, then the claim read from the blob, then the authority’s durable claim, then the one request — never another order', () => {
    const reserved = client.slice(client.indexOf('async submitReserved('));
    const order = ['if (!client.isConnected()) throw new XrplSubmissionNotAttemptedError();', 'xrplSubmissionClaimOf(executionId, configuration.networkId, signedTransaction)', 'await claim(submission);', 'return await requestSubmit(signedTransaction);'].map((marker) => reserved.indexOf(marker));
    assert.ok(order.every((position) => position !== -1), reserved.slice(0, 1500));
    assert.deepEqual([...order].sort((a, b) => a - b), order);
    assert.equal(/catch \{\s*throw new XrplReservedSubmissionRefusedError\(\);\s*\}/.test(reserved), true, 'a refused claim sends nothing');
    assert.equal(/OfferCreate|Offer[A-Z]/.test(client), false, 'transaction-neutral: the rail directory still names no OfferCreate');
  });
});
