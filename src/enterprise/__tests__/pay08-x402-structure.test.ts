import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createFinancialActionClassifier } from '../../features/monetary-runtime/index.js';
import { PAYMENT_PARAMETER_DIMENSIONS, PAYMENT_PROFILE_PARAMETERS, PAYMENT_PROTOCOL_RESERVED_CONTEXT_KEYS, createPaymentGovernanceBinding } from '../../features/payment-runtime/index.js';
import { MPP_RESERVED_CONTEXT_KEYS, createMppPaymentProtocolAdapter, type MppMethodNormalizer } from '../../features/payment-runtime/protocols/mpp/index.js';
import { encodeJcs, onlyCandidate } from '../../features/payment-runtime/protocols/mpp/tests/mpp-test-support.js';
import { X402_RESERVED_CONTEXT_KEYS } from '../../features/payment-runtime/protocols/x402/index.js';
import { ASSETS as X402_TEST_ASSETS, DIRECTORY, MAPPING_A, RESOURCE_URL, TARGET, UNIT_A, b64, paymentRequired, requirement, testBinding } from '../../features/payment-runtime/protocols/x402/tests/x402-test-support.js';
import { createX402PaymentProtocolAdapter } from '../../features/payment-runtime/protocols/x402/index.js';
import { GOVERNED_ACTION_RESERVED_CONTEXT_KEYS } from '../governed-action/intent.js';
import { deriveGovernedActionRequestId } from '../governed-action/identifiers.js';
import type { GovernedActionResult } from '../governed-action/index.js';
import { createGovernanceProfileRegistry } from '../governance-profile/index.js';
import { createInMemoryPaymentBusinessOperationStore, createPaymentProtocolIngress, type PaymentBusinessOperationStore, type PaymentProtocolIngressResult } from '../payment-protocol-ingress/index.js';
import { ALLOWED_INTENT, IDENTITY, ORG } from './governed-action-support.js';
import { listCoreSources } from './pay07-core-source-manifest.js';

/**
 * PAY-08 — structural invariants, and the protocol-boundary neutrality proof.
 *
 * - **CORE purity**: no x402 word in any CORE source PAY-07 measures (Kernel,
 *   grant runtime, P7, P10, P11, P12, ASSURE-01, PAY-01's generic contract,
 *   PAY-04's ingress, MPP) — PAY-04's own scan covers the rest of the core;
 * - **the edge is a protocol edge, not an execution path**: it imports the x402
 *   adapter, PAY-06's pure Lightning helpers and PAY-04 / PAY-05 read surfaces
 *   only; it holds no rail, node send, execution adapter, signer, key,
 *   facilitator client or network client; it never governs, settles or
 *   retries; PAY-05 is read before any proof is read, the proof only after;
 * - **one protocol boundary, two protocols**: MPP and x402 enter the same
 *   PAY-04 ingress and, for the same payment, compile to the same governed
 *   intent and the same governed request — another protocol with identical
 *   terms is the same purchase.
 */

const EDGE = 'src/enterprise/x402-payment-protocol';
const X402 = 'src/features/payment-runtime/protocols/x402';

function walk(dir: string): readonly string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name !== 'tests' && name !== '__tests__') out.push(...walk(full));
    } else if (full.endsWith('.ts') && !full.endsWith('.test.ts') && !full.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out;
}

function codeOf(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^\s*\/\/.*$/gm, ' ');
}

const importsOf = (file: string): readonly string[] => [...codeOf(file).matchAll(/\bfrom\s+'([^']+)'/g)].map((match) => match[1] ?? '');

describe('PAY-08 — CORE purity', () => {
  it('no CORE source names x402, lnbtc or the x402 headers — in code or prose', () => {
    const core = listCoreSources('.');
    assert.ok(core.length > 500, `found ${String(core.length)}`);
    for (const file of core) {
      const text = readFileSync(file, 'utf8');
      for (const pattern of [/x402/i, /lnbtc/i, /PAYMENT-SIGNATURE|PAYMENT-RESPONSE|PAYMENT-REQUIRED/i, /facilitator/i]) assert.equal(pattern.test(text), false, `${file}: ${String(pattern)}`);
    }
  });

  it('the core’s built-in reserved list carries no x402 word; x402’s words reach the registry as configuration only (L-7)', () => {
    const builtIn = new Set(GOVERNED_ACTION_RESERVED_CONTEXT_KEYS.map((key) => key.toLowerCase()));
    for (const key of X402_RESERVED_CONTEXT_KEYS) assert.equal(builtIn.has(key.toLowerCase()), false, key);
  });

  it('PAY-04’s port and ingress are unchanged by PAY-08: no x402 import, and the ingress composes no protocol by name', () => {
    for (const file of [...walk('src/enterprise/payment-protocol-ingress'), ...walk('src/features/payment-runtime/domain'), ...walk('src/features/payment-runtime/services')]) {
      for (const specifier of importsOf(file)) assert.equal(/x402|protocols\//.test(specifier), false, `${file} imports '${specifier}'`);
    }
  });
});

describe('PAY-08 — the x402 edge is a protocol edge, not an execution path', () => {
  const sources = walk(EDGE);

  it('has the expected production sources', () => {
    assert.deepEqual(sources.map((file) => file.slice(EDGE.length + 1)).sort(), ['index.ts', 'x402-lightning-binding.ts', 'x402-lightning-execution-invoices.ts', 'x402-payment-response.ts', 'x402-payment-signature.ts', 'x402-presentation.ts']);
  });

  it('imports only the x402 adapter, PAY-06’s barrel, PAY-04 / PAY-05 read surfaces, the bound identity type and node:crypto', () => {
    const allowed = new Set([
      '../../features/payment-runtime/protocols/x402/index.js',
      '../../features/payment-runtime/rails/lightning/index.js',
      '../payment-protocol-ingress/index.js',
      '../payment-settlement/index.js',
      '../customer-identity/index.js',
      // The execution binding (lifecycle hardening): the orchestrator's own identity reader and execution-id
      // derivation — pure functions PAY-04's ingress and PAY-05's refunds already use — and the Governance
      // Store's record type for its read-only `getByRequestId`.
      '../governed-action/kernel-request.js',
      '../governed-action/identifiers.js',
      '../governance-store/index.js',
      'node:crypto',
    ]);
    for (const file of sources) for (const specifier of importsOf(file)) assert.ok(allowed.has(specifier) || /^\.\/x402-[a-z-]+\.js$/.test(specifier), `${file} imports '${specifier}'`);
  });

  it('holds no rail, node send, execution adapter, signer, key, facilitator or network client; never governs, settles, writes or retries', () => {
    for (const file of sources) {
      const code = codeOf(file);
      for (const pattern of [
        /createLightningRail|sendPayment|LightningNodePort\b/,
        /ExecutionAdapter|createPaymentRailExecutionAdapter|PaymentRail\b|\.execute\s*\(/,
        /\bsubmit\w*\s*\(|\bsign\s*\(|createSign|privateKey|secretKey|mnemonic|\bseed\b/i,
        /\bfetch\s*\(|node:https?|node:net|node:tls|XMLHttpRequest|WebSocket/,
        /\/verify\b|\/settle\b|facilitator/i,
        /\bgovern\s*\(|\.verifySettlement\s*\(|recordSettlement|\.record\s*\(/,
        /\bretry|retries|resubmit|resend/i,
        /console\.|\blog\s*\(/,
      ]) {
        assert.equal(pattern.test(code), false, `${file}: ${String(pattern)}`);
      }
    }
  });

  it('the rail’s invoice source is bound to the execution: it reads the committed decision and PAY-04’s record, keeps only what is in flight, and holds no invoice history', () => {
    const code = codeOf(join(EDGE, 'x402-lightning-execution-invoices.ts'));
    assert.match(code, /deriveGovernedActionExecutionId\(\{ requestId, decisionId: record\.evaluation\.decisionId \}\) !== query\.executionId/, 'the execution PAY-06 runs must derive from the request’s committed decision');
    assert.match(code, /executionAttemptReferenceId\(query\.executionId\)/, 'and be claimed on its record');
    assert.match(code, /decisions\.getByRequestId\(/);
    assert.match(code, /contexts\.readByGovernedRequestId\(/);
    assert.doesNotMatch(code, /append\w*\(|\.set\(paymentHash|maximumPaymentHashes|AMBIGUOUS/, 'reads only; no identity map');
    const binding = codeOf(join(EDGE, 'x402-lightning-binding.ts'));
    assert.doesNotMatch(binding, /identities|maximumPaymentHashes|invoiceFor/, 'the decoding cache is not an invoice source and keeps no identity history');
  });

  it('presents through the existing ingress: preparation first, then exactly one prepareAndGovern', () => {
    const code = codeOf(join(EDGE, 'x402-presentation.ts'));
    assert.equal([...code.matchAll(/prepareAndGovern\(/g)].length, 1);
    assert.ok(code.indexOf('await prepare.call(') < code.indexOf('ingress.prepareAndGovern('));
    assert.match(code, /return ingress.prepareAndGovern\(identity, request\);/, 'the caller’s request is forwarded untouched — never copied or spread');
  });

  it('the proof is read only after PAY-05 says settled, and encoded only after it verifies', () => {
    const code = codeOf(join(EDGE, 'x402-payment-signature.ts'));
    const order = ['contexts.readByGovernedRequestId(', 'settlements.readSettlement(', "state !== 'settled'", 'proofs.preimageFor(', 'preimageMatchesPaymentHash(', 'encodeX402PaymentSignatureHeader('];
    const positions = order.map((marker) => code.indexOf(marker));
    for (const [index, position] of positions.entries()) assert.notEqual(position, -1, String(order[index]));
    assert.deepEqual([...positions].sort((left, right) => left - right), positions, order.join(' → '));
    assert.match(code, /paymentStatus\.call\(reader, paymentHash, timeoutMs\)/, 'the proof source reads one payment status — the reader has no send');
  });

  it('nothing but the edge (and tests) composes it: no Host, route, module, script, app or package export', () => {
    const outside = [...['src/kernel', 'src/runtime', 'src/kernel-host', 'src/control-plane-web', 'src/enterprise', 'src/features', 'packages', 'apps', 'scripts'].flatMap((root) => walk(root)), 'src/index.ts'].filter((file) => !file.startsWith(`${EDGE}/`) && !file.startsWith(`${X402}/`));
    for (const file of outside) assert.equal(/x402-payment-protocol|protocols\/x402/.test(readFileSync(file, 'utf8')), false, file);
    assert.equal(/x402/i.test(readFileSync('package.json', 'utf8')), false);
  });

  it('the Lightning rail and its edge know nothing of x402; PAY-08’s only rail-side change is the decoder’s description hash', () => {
    for (const file of [...walk('src/features/payment-runtime/rails'), ...walk('src/enterprise/lightning-payment-rail'), ...walk('src/enterprise/xrpl-payment-rail')]) {
      assert.equal(/x402|lnbtc/i.test(readFileSync(file, 'utf8')), false, file);
    }
    const rail = codeOf('src/features/payment-runtime/rails/lightning/lightning-rail.ts');
    assert.equal(/descriptionHash/.test(rail), false, 'the rail never reads the description hash');
  });
});

describe('PAY-08 — one protocol boundary, two protocols (MPP and x402 conformance)', () => {
  const ACTION = ALLOWED_INTENT.action;
  const ACCOUNT = ALLOWED_INTENT.resource;
  const binding = createPaymentGovernanceBinding({ action: ACTION });
  const monetary = Object.freeze({ assets: X402_TEST_ASSETS, actionClassifier: createFinancialActionClassifier({ financialActions: [ACTION] }) });
  const governance = createGovernanceProfileRegistry({
    parameterDimensions: PAYMENT_PARAMETER_DIMENSIONS,
    actionClasses: [{ id: 'payment', actions: [ACTION] }],
    resourceClasses: [{ id: 'governed-account', resources: [ACCOUNT] }],
    profiles: [{ profileId: 'governed-payment', version: 1, owner: ORG, provenance: { authoredBy: 'operator:treasury', approvedBy: 'operator:security' }, actionClass: 'payment', resourceClass: 'governed-account', parameters: PAYMENT_PROFILE_PARAMETERS, materialFacts: [], relevantPolicies: [] }],
    reservedContextKeys: [...PAYMENT_PROTOCOL_RESERVED_CONTEXT_KEYS, ...MPP_RESERVED_CONTEXT_KEYS, ...X402_RESERVED_CONTEXT_KEYS],
  });
  const clock = () => '2026-09-24T12:00:00.000Z';

  // The same payment, as each protocol's trusted composition reads it: 0.00125 TOK to acct-merchant-a, rail test-rail-a.
  const mppMethod: MppMethodNormalizer = {
    methodId: 'tokpay',
    intent: 'charge',
    rail: 'test-rail-a',
    normalize: (challenge) => (challenge.decodedRequest['amount'] === '1250' ? { amount: { value: '0.00125', unit: UNIT_A }, merchantReference: String(challenge.decodedRequest['recipient']) } : undefined),
  };
  const mpp = createMppPaymentProtocolAdapter({ methods: [mppMethod], resolveCounterparty: (context) => (context.merchantReference === 'merchant-a' ? { kind: 'test-account', reference: DIRECTORY['merchant-a'] as string } : undefined), selectChallenge: onlyCandidate, assets: X402_TEST_ASSETS });
  const x402 = createX402PaymentProtocolAdapter({ mappings: [MAPPING_A], bindings: [testBinding()], resolveRequest: ({ target }) => (target === TARGET ? { url: RESOURCE_URL, fields: {} } : undefined), assets: X402_TEST_ASSETS });
  const mppChallenge = `Payment id="ch-1", realm="api.merchant.example", method="tokpay", intent="charge", request="${encodeJcs({ amount: '1250', currency: 'tok', recipient: 'merchant-a' })}", expires="2026-09-24T12:05:00Z"`;
  const x402Carrier = { status: 402, headers: [['PAYMENT-REQUIRED', b64(paymentRequired([requirement()]))]] };

  function ingressOver(store: PaymentBusinessOperationStore, governed: unknown[]) {
    const orchestrator = {
      organizationId: ORG,
      govern: async (_identity: unknown, intent: unknown): Promise<GovernedActionResult> => {
        governed.push(intent);
        const requestId = deriveGovernedActionRequestId({ organizationId: ORG, principalId: IDENTITY.principal.principalId, idempotencyKey: (intent as { readonly idempotencyKey: string }).idempotencyKey });
        return { status: 'denied', requestId, reasonCodes: [] } as unknown as GovernedActionResult;
      },
    };
    return createPaymentProtocolIngress({ orchestrator, store, adapters: [mpp, x402], binding, monetary, governance, now: clock });
  }

  const present = (ingress: ReturnType<typeof ingressOver>, protocol: 'mpp' | 'x402'): Promise<PaymentProtocolIngressResult> =>
    ingress.prepareAndGovern(IDENTITY, {
      businessOperationId: 'pay08-conformance',
      protocol,
      challenges: protocol === 'mpp' ? mppChallenge : x402Carrier,
      protectedRequest: { target: TARGET, method: 'GET' },
      payment: { source: { accountId: ACCOUNT }, purpose: 'vendor-payment' },
      envelope: { assertedContext: ALLOWED_INTENT.assertedContext },
    });

  it('the same payment through MPP and through x402 compiles to the same governed intent and the same governed request', async () => {
    const viaMpp: unknown[] = [];
    const viaX402: unknown[] = [];
    const a = await present(ingressOver(createInMemoryPaymentBusinessOperationStore({ now: clock }), viaMpp), 'mpp');
    const b = await present(ingressOver(createInMemoryPaymentBusinessOperationStore({ now: clock }), viaX402), 'x402');
    assert.equal(a.outcome, 'governed', JSON.stringify(a));
    assert.equal(b.outcome, 'governed', JSON.stringify(b));
    assert.deepEqual(viaX402, viaMpp, 'one canonical PaymentIntent, one compiler, one envelope');
    assert.equal(a.outcome === 'governed' && b.outcome === 'governed' && a.requestId === b.requestId, true);
  });

  it('on one store, the second protocol is the same business operation (a new challenge under it), never a second purchase', async () => {
    const governed: unknown[] = [];
    const ingress = ingressOver(createInMemoryPaymentBusinessOperationStore({ now: clock }), governed);
    const first = await present(ingress, 'mpp');
    const second = await present(ingress, 'x402');
    assert.ok(first.outcome === 'governed' && second.outcome === 'governed');
    assert.equal(second.operation, 'existing');
    assert.equal(second.challenge, 'appended');
    assert.equal(second.requestId, first.requestId);
    assert.deepEqual(governed[1], governed[0]);
  });

  it('both adapters satisfy the same port shape: protocol id, reserved words the registry must hold, a synchronous interpret', () => {
    for (const adapter of [mpp, x402]) {
      assert.equal(typeof adapter.interpret, 'function');
      for (const key of adapter.reservedContextKeys) assert.equal(governance.reservesContextKey(key), true, key);
    }
    assert.deepEqual([mpp.protocolId, x402.protocolId], ['mpp', 'x402']);
    const answer = x402.interpret(x402Carrier, { organizationId: ORG, businessOperationId: 'b', protectedRequest: { target: TARGET, method: 'GET', bodyBearing: false }, observedAtEpochMilliseconds: 0 });
    assert.equal(answer instanceof Promise, false);
  });
});
