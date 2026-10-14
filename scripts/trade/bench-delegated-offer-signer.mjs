// TRADE-04B — diagnostic benchmark of the protected delegated OfferCreate signer.
// Offline and loopback only: no XRPL server, no ledger, no network beyond 127.0.0.1.
// Run after `npm run build`:
//
//   node scripts/trade/bench-delegated-offer-signer.mjs [--iterations 500] [--concurrency 8]
//
// What it measures, separately (never conflated):
//   1. Host-side cryptographic verification (verifySignedDelegatedOffer), ed25519 and secp256k1.
//   2. Local request serialization (JSON of the closed request).
//   3. In-process reference signer (no socket): parse, checks, signature generation, self-verification.
//   4. Loopback reference signer over HTTP: identity handshake, and a full signing round trip through the
//      Host-side client (transport + correlation + verification).
//   5. Bounded concurrency over loopback: throughput and memory with N signatures in flight.
//   6. Timeout behavior: time to a refusal from a server that never answers.
//
// These are single-machine diagnostics of the signing capability. They say nothing about end-to-end XRPL
// execution throughput (ledger close, submission, validation), and nothing about HFT readiness.
// Keys: disposable, created in a fresh OS temporary directory, removed at exit, never funded.
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

import {
  DELEGATED_OFFER_SIGNER_PROTOCOL,
  createDelegatedOfferSigner,
  createHttpDelegatedOfferSignerTransport,
  verifySignedDelegatedOffer,
} from '../../dist/src/enterprise/xrpl-trade-rail/index.js';
import {
  createReferenceDelegatedOfferKeyFile,
  createReferenceDelegatedOfferSignerService,
  loadReferenceDelegatedOfferKeyFile,
  startReferenceDelegatedOfferSigner,
} from '../../dist/src/enterprise/xrpl-trade-rail/reference/reference-delegated-offer-signer.js';

const argument = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  const value = index === -1 ? fallback : Number.parseInt(process.argv[index + 1] ?? '', 10);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`--${name} must be a positive integer`);
  return value;
};
const ITERATIONS = argument('iterations', 500);
const CONCURRENCY = argument('concurrency', 8);

// Public test addresses already used across the repository's tests; no key for them exists here.
const OWNER = 'rf1BiGeXwwQoi8Z2ueFYTEXSwuJYfV2Jpn';
const ISSUER = 'rvYAfWj5gh67oV6fW32ZzP3Aw4Eubs59B';
const CREDENTIAL = `bench-${'0'.repeat(40)}`;
const AUDIT = { executionId: 'bench-exec', grantRef: 'bench-grant', grantDigest: `sha256:${'cd'.repeat(32)}` };

const summarize = (samples) => {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  const mean = sorted.reduce((sum, value) => sum + value, 0) / sorted.length;
  return { n: sorted.length, meanMs: +mean.toFixed(4), p50Ms: +at(0.5).toFixed(4), p95Ms: +at(0.95).toFixed(4), p99Ms: +at(0.99).toFixed(4), maxMs: +sorted[sorted.length - 1].toFixed(4) };
};
const time = (fn) => {
  const started = performance.now();
  fn();
  return performance.now() - started;
};
const timeAsync = async (fn) => {
  const started = performance.now();
  await fn();
  return performance.now() - started;
};

const offer = (delegate, sequence) => ({
  TransactionType: 'OfferCreate',
  Account: OWNER,
  Delegate: delegate,
  TakerGets: '25000000',
  TakerPays: { currency: 'USD', issuer: ISSUER, value: '12.5' },
  Flags: 0x80000,
  Sequence: sequence,
  Fee: '12',
  LastLedgerSequence: 1_020,
});

const dir = mkdtempSync(join(tmpdir(), 'trade04b-bench-'));
const results = { iterations: ITERATIONS, concurrency: CONCURRENCY, node: process.version, platform: `${process.platform}/${process.arch}` };
try {
  for (const algorithm of ['ed25519', 'secp256k1']) {
    const keyFile = join(dir, `${algorithm}.json`);
    createReferenceDelegatedOfferKeyFile(keyFile, { network: 'xrp-ledger-testnet', ownerAccounts: [OWNER], algorithm });
    const { keys, pairs } = loadReferenceDelegatedOfferKeyFile(keyFile);
    const pair = pairs[0];
    const options = { signerId: `bench-${algorithm}`, network: 'xrp-ledger-testnet', credential: CREDENTIAL, keys, maximumFeeDrops: '100' };
    const service = createReferenceDelegatedOfferSignerService(options);
    const request = (sequence) => ({ protocol: DELEGATED_OFFER_SIGNER_PROTOCOL, signerId: options.signerId, requestId: sequence.toString(16).padStart(64, '0'), network: 'xrp-ledger-testnet', ownerAccount: OWNER, delegateAccount: pair.delegateAccount, transaction: offer(pair.delegateAccount, sequence), audit: AUDIT });
    const answer = (body) => service.answer({ method: 'POST', path: '/v1/sign/xrpl-delegated-offer', authorization: `Bearer ${CREDENTIAL}`, contentType: 'application/json', body });

    // 2. serialization; 3. in-process signing
    const serialization = [];
    const inProcess = [];
    const signed = [];
    for (let index = 1; index <= ITERATIONS; index += 1) {
      let body;
      serialization.push(time(() => (body = Buffer.from(JSON.stringify(request(index))))));
      let reply;
      inProcess.push(time(() => (reply = answer(body))));
      if (reply.status !== 200) throw new Error(`in-process signing refused (${reply.status})`);
      signed.push({ sequence: index, ...reply.body });
    }
    // 1. Host-side verification
    const verification = [];
    for (const entry of signed) {
      let ok;
      verification.push(time(() => (ok = verifySignedDelegatedOffer({ prepared: offer(pair.delegateAccount, entry.sequence), pair, signedTransaction: entry.signedTransaction, hash: entry.hash }).verified)));
      if (!ok) throw new Error('verification failed');
    }

    // 4. loopback HTTP
    const server = await startReferenceDelegatedOfferSigner(options);
    try {
      const endpoint = `http://127.0.0.1:${server.port}`;
      const handshake = [];
      for (let index = 0; index < Math.min(ITERATIONS, 200); index += 1) {
        const client = createDelegatedOfferSigner({ transport: createHttpDelegatedOfferSignerTransport({ endpoint, credential: CREDENTIAL }), pin: { signerId: options.signerId, network: 'xrp-ledger-testnet', pairs }, timeoutMs: 5_000, maximumFeeDrops: '100', maximumLedgerHorizon: 40 });
        handshake.push(await timeAsync(async () => {
          if ((await client.probe()).state !== 'VERIFIED') throw new Error('handshake failed');
        }));
      }
      const client = createDelegatedOfferSigner({ transport: createHttpDelegatedOfferSignerTransport({ endpoint, credential: CREDENTIAL }), pin: { signerId: options.signerId, network: 'xrp-ledger-testnet', pairs }, timeoutMs: 5_000, maximumFeeDrops: '100', maximumLedgerHorizon: 40, maximumConcurrentSignatures: CONCURRENCY });
      await client.probe();
      const roundTrip = [];
      for (let index = 1; index <= ITERATIONS; index += 1) {
        roundTrip.push(await timeAsync(() => client.signDelegatedOffer({ transaction: offer(pair.delegateAccount, 100_000 + index), audit: AUDIT, validatedLedgerIndex: 1_000 })));
      }
      // 5. bounded concurrency
      global.gc?.();
      const before = process.memoryUsage();
      let peakRss = before.rss;
      let peakHeap = before.heapUsed;
      const started = performance.now();
      let next = 200_000;
      const worker = async () => {
        for (let count = 0; count < Math.ceil(ITERATIONS / CONCURRENCY); count += 1) {
          await client.signDelegatedOffer({ transaction: offer(pair.delegateAccount, (next += 1)), audit: AUDIT, validatedLedgerIndex: 1_000 });
          const usage = process.memoryUsage();
          peakRss = Math.max(peakRss, usage.rss);
          peakHeap = Math.max(peakHeap, usage.heapUsed);
        }
      };
      await Promise.all(Array.from({ length: CONCURRENCY }, worker));
      const elapsed = performance.now() - started;
      const total = Math.ceil(ITERATIONS / CONCURRENCY) * CONCURRENCY;
      results[algorithm] = {
        hostVerification: summarize(verification),
        requestSerialization: summarize(serialization),
        inProcessReferenceSigning: summarize(inProcess),
        loopbackHandshake: summarize(handshake),
        loopbackSigningRoundTrip: summarize(roundTrip),
        boundedConcurrency: { inFlight: CONCURRENCY, signatures: total, elapsedMs: +elapsed.toFixed(1), signaturesPerSecond: +((total / elapsed) * 1000).toFixed(1), rssDeltaMiB: +((peakRss - before.rss) / 1048576).toFixed(2), heapDeltaMiB: +((peakHeap - before.heapUsed) / 1048576).toFixed(2) },
      };
    } finally {
      await server.close();
    }
  }

  // 6. timeout behavior
  const silent = createServer(() => undefined);
  await new Promise((resolve) => silent.listen(0, '127.0.0.1', resolve));
  try {
    const transport = createHttpDelegatedOfferSignerTransport({ endpoint: `http://127.0.0.1:${silent.address().port}`, credential: CREDENTIAL });
    const samples = [];
    for (let index = 0; index < 5; index += 1) {
      samples.push(await timeAsync(() => transport.identity({ timeoutMs: 100 }).then(() => { throw new Error('answered'); }, (error) => {
        if (error.reason !== 'OFFER_SIGNER_TIMEOUT') throw error;
      })));
    }
    results.timeoutRefusal = { budgetMs: 100, ...summarize(samples) };
  } finally {
    silent.closeAllConnections();
    await new Promise((resolve) => silent.close(resolve));
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(JSON.stringify(results, null, 2));
