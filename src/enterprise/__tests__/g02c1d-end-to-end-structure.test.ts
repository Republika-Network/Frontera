import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { GENERIC_HTTP_PRESENTATION_HEADER, GENERIC_HTTP_RECEIPT_HEADER } from '../execution-adapters/generic-http/governed-headers.js';
import { EXECUTION_CAPABILITY_PRESENTATION_HEADER, EXECUTION_CAPABILITY_PRESENTATION_LIMITS } from '../execution-capability-presentation/index.js';
import { EXECUTION_RECEIPT_EVIDENCE_STORE_SCHEMA_VERSION } from '../execution-receipt-evidence/index.js';
import { EXECUTOR_RECEIPT_TRANSPORT_HEADER, EXECUTOR_RECEIPT_TRANSPORT_LIMITS } from '../executor-receipt/index.js';
import { GENERIC_HTTP_GOVERNED_HEADER_LIMITS } from '../execution-adapters/generic-http/governed-headers.js';

/**
 * G-02C1D structure: one fixed request header and one fixed response header,
 * named once and reserved; the presentation appended after binding and only
 * on a proceed; an observer that runs after the result is fixed and cannot
 * send; receipt evidence verified and correlated in its own module and its own
 * store, reaching neither P11 nor P12; no executor key, signer or receipt
 * ledger in the Host; and an executor that delivers only what it persisted.
 */

const GENERIC_HTTP = 'src/enterprise/execution-adapters/generic-http';
const EVIDENCE = 'src/enterprise/execution-receipt-evidence';
const EXECUTOR = 'src/enterprise/reference-executor';

function codeOf(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

function sourcesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name !== '__tests__') out.push(...sourcesUnder(path));
    } else if (path.endsWith('.ts')) out.push(path.replace(/\\/g, '/'));
  }
  return out.sort();
}

const count = (code: string, needle: string): number => code.split(needle).length - 1;
const PRODUCTION = sourcesUnder('src');

describe('G-02C1D structure — two fixed header names, declared once, reserved, bounded', () => {
  it('the Host and the executor name the same two headers, with the same bounds', () => {
    assert.equal(GENERIC_HTTP_PRESENTATION_HEADER, EXECUTION_CAPABILITY_PRESENTATION_HEADER);
    assert.equal(GENERIC_HTTP_RECEIPT_HEADER, EXECUTOR_RECEIPT_TRANSPORT_HEADER);
    assert.equal(GENERIC_HTTP_GOVERNED_HEADER_LIMITS.maxPresentationLength, EXECUTION_CAPABILITY_PRESENTATION_LIMITS.maximumEncodedLength);
    assert.equal(GENERIC_HTTP_GOVERNED_HEADER_LIMITS.maxReceiptLength, EXECUTOR_RECEIPT_TRANSPORT_LIMITS.maximumEncodedLength);
  });

  it('each name is a literal in exactly one Host module and one executor-side module', () => {
    for (const name of [GENERIC_HTTP_PRESENTATION_HEADER, GENERIC_HTTP_RECEIPT_HEADER]) {
      const declaring = PRODUCTION.filter((file) => codeOf(file).includes(`'${name}'`));
      assert.deepEqual(declaring, name === GENERIC_HTTP_PRESENTATION_HEADER ? [`${GENERIC_HTTP}/governed-headers.ts`, 'src/enterprise/execution-capability-presentation/presentation.ts'] : [`${GENERIC_HTTP}/governed-headers.ts`, 'src/enterprise/executor-receipt/transport.ts'], name);
    }
  });

  it('the adapter appends the presentation under the constant alone, to a copy, after the binding; the transport reads the receipt header and the provider reference, nothing else', () => {
    const adapter = codeOf(`${GENERIC_HTTP}/generic-http-execution-adapter.ts`);
    assert.equal(count(adapter, 'withPresentationHeader('), 2, 'declared once, called once');
    assert.ok(adapter.indexOf('genericHttpRequestBinding(plan, mapped.request)') < adapter.indexOf('outbound = withPresentationHeader(mapped.request, decided.presentation);'), 'appended after binding');
    assert.ok(adapter.indexOf('if (!decided.proceed) return done(') < adapter.indexOf('outbound = withPresentationHeader('), 'never after a refusal');
    const transport = codeOf(`${GENERIC_HTTP}/node-https-transport.ts`);
    assert.equal(count(transport, 'rawHeaderValues(response, '), 2);
    assert.ok(transport.includes('rawHeaderValues(response, GENERIC_HTTP_RECEIPT_HEADER)'));
  });
});

describe('G-02C1D structure — the observer runs after the result and can neither send nor change it', () => {
  it('one observer call, after the one exchange, inside a catch, and the result returned is the exchange’s', () => {
    const adapter = codeOf(`${GENERIC_HTTP}/generic-http-execution-adapter.ts`);
    assert.equal(count(adapter, 'await observer('), 1);
    assert.equal(count(adapter, 'await exchangeOnce(action)'), 1);
    const exchanged = adapter.indexOf('const exchange = await exchangeOnce(action);');
    const observed = adapter.indexOf('await observer(evidence);');
    const returned = adapter.indexOf('return exchange.result;');
    assert.ok(exchanged > 0 && exchanged < observed && observed < returned);
    assert.equal(/runtime\.(send|resolve)\s*\(/.test(adapter.slice(exchanged, returned)), false, 'nothing reaches the network after the exchange');
    assert.ok(adapter.includes('return createGenericHttpExecutionAdapterCore(plan, NODE_GENERIC_HTTP_RUNTIME, gate, gate === undefined ? undefined : observers.get(plan.adapterId));'), 'an observer only beside a gate');
  });
});

describe('G-02C1D structure — receipt evidence is its own module and store, beside P11 and P12, never inside them', () => {
  it('the evidence module verifies and records: no send, no presentation, no signing, no executor module, no P11/P12/reconciliation', () => {
    for (const file of sourcesUnder(EVIDENCE)) {
      const code = codeOf(file);
      assert.equal(/runtime\.send|\.execute\(|beforeSend|encodeExecutionCapabilityPresentation|signExecution|createPrivateKey|\bsign\(|reference-executor|receipt-(?:issuer|ledger|signer)|execution-outcome-store|execution-resolution-store|execution-reconciliation|execution-capability-issuance\//.test(code), false, file);
    }
    const store = codeOf(`${EVIDENCE}/evidence-store.ts`);
    assert.equal(EXECUTION_RECEIPT_EVIDENCE_STORE_SCHEMA_VERSION, 'frontera.execution-receipt-evidence-store.v1');
    assert.equal(/execution_outcome|execution_resolution|reconciliation|consumption|issuance/i.test(store), false, 'no table of P11, P12, G-02A or G-02B');
  });

  it('no P11, P12, reconciliation, Kernel, orchestrator or exercise module reaches the evidence', () => {
    for (const root of ['src/kernel', 'src/enterprise/governed-action', 'src/features/execution-runtime', 'src/enterprise/execution-outcome-store', 'src/enterprise/execution-resolution-store', 'src/enterprise/execution-reconciliation', 'src/enterprise/execution-governance']) {
      for (const file of sourcesUnder(root)) assert.equal(/execution-receipt-evidence|ExecutionReceiptEvidence|executor-receipt/.test(codeOf(file)), false, file);
    }
  });

  it('only the composition root (and the Host configuration, for the registry) imports the evidence module; it opens the store once, never creating it, only with receiptEvidence', () => {
    const importers = PRODUCTION.filter((file) => !file.startsWith(`${EVIDENCE}/`) && /from ['"][^'"]*execution-receipt-evidence\//.test(codeOf(file)));
    assert.deepEqual(importers, ['src/enterprise/composition/composition-root.ts', 'src/enterprise/host/host-configuration.ts']);
    const root = codeOf('src/enterprise/composition/composition-root.ts');
    assert.equal(count(root, 'openExecutionReceiptEvidenceStore('), 1);
    assert.ok(root.indexOf('if (executionCapabilities.receiptEvidence !== undefined) {') < root.indexOf('openExecutionReceiptEvidenceStore('));
    assert.equal(/openExecutionReceiptEvidenceStore\([^)]*create\s*:/.test(root), false, 'the Host never creates the evidence store');
    assert.equal(count(root, 'recorder.bind({ issuance: issuanceLedger, store: evidenceStore })'), 1, 'bound to this Host’s own issuance ledger');
  });

  it('no route, barrel, API contract or package export names the evidence, the receipt or the presentation', () => {
    for (const file of ['src/enterprise/index.ts', 'src/index.ts', ...sourcesUnder('src/enterprise/api'), ...sourcesUnder('src/enterprise/adapters')]) {
      assert.equal(/execution-receipt-evidence|ExecutionReceiptEvidence|executor-receipt|frontera-execution-receipt|frontera-execution-capability/.test(codeOf(file)), false, file);
    }
    assert.equal(/execution-receipt-evidence|executor-receipt|governed-headers/.test(JSON.stringify((JSON.parse(readFileSync('package.json', 'utf8')) as { exports?: unknown }).exports ?? {})), false);
  });

  it('the Host holds no executor key and no receipt signer: no Host-side module reaches them', () => {
    for (const file of PRODUCTION.filter((path) => !path.startsWith(`${EXECUTOR}/`))) {
      assert.equal(/receipt-signer|loadExecutorReceiptSigner|signExecutorReceipt|receipt-ledger|receipt-issuer/.test(codeOf(file)), false, file);
    }
  });
});

describe('G-02C1D structure — the executor delivers only the receipt it persisted, in its one header', () => {
  it('the flow encodes only an issued artifact, adds only the receipt header, and constructs or signs nothing itself', () => {
    const flow = codeOf(`${EXECUTOR}/execution-flow.ts`);
    assert.ok(flow.includes("if (fields.status !== 'issued' || fields.receipt === null || typeof fields.receipt !== 'object') return undefined;"));
    assert.ok(flow.includes('Object.freeze({ [EXECUTOR_RECEIPT_TRANSPORT_HEADER]: encoded })'), 'one header, the receipt');
    assert.equal(/positionExecutorReceipt|serializeExecutorReceipt|signExecutorReceipt|executorReceiptSigningBytes|statusOf\([^)]*\)\s*===?\s*201/.test(flow), false, 'never a receipt built from a status');
    const gateway = codeOf(`${EXECUTOR}/gateway.ts`);
    assert.ok(gateway.includes('if (!(name in headers)) headers[name] = value;'), 'an added header never replaces the gateway’s own');
    assert.equal(count(gateway, 'execution.answerHeadersOf('), 1);
  });
});
