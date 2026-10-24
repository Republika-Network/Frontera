import { chmodSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { GenericHttpExchangeEvidence } from '../execution-adapters/generic-http/generic-http-execution-adapter.js';
import { GENERIC_HTTP_PRESENTATION_HEADER } from '../execution-adapters/generic-http/governed-headers.js';
import type { GenericHttpWireRequest } from '../execution-adapters/generic-http/request-mapper.js';
import type { ExecutionCapability } from '../execution-capability/index.js';
import { serializeExecutorReceipt, type ExecutorReceipt } from '../executor-receipt/index.js';
import { createExecutionReceiptTrust, type ExecutionReceiptExchange } from '../execution-receipt-evidence/index.js';
import { G02B_ISSUER, G02B_ORGANIZATION, G02B_TRUST_DOMAIN } from './g02b-execution-capability-issuance-fixture.js';
import { countingNetwork, gatedPlan, recordingGate } from './g02c0-execution-binding-fixture.js';
import { generateReceiptKey } from './g02c1c-executor-receipt-fixture.js';
import { E2E_ADAPTER_ID, E2E_AUDIENCE, UNKNOWN, deliverableReceipt, e2eTrustedExecutor, hostWorld, presentedCapability, privateDirectory, receiptAbout, signReceiptText, type HostWorld } from './g02c1d-end-to-end-fixture.js';

/**
 * G-02C1D mutation qualification, in the manner of G-02A … G-02C1C: each
 * load-bearing control of the presentation header, the receipt transport
 * encoding, the Host's receipt verification and issuance correlation, and the
 * evidence store is removed from the **compiled** module (module-local sites,
 * each occurring exactly once), the mutant is loaded beside the original, and
 * its guard must hold for the original and fail for the mutant.
 *
 * "Retry to obtain a receipt" has no code to remove: the adapter has one send
 * and the recorder neither sends nor presents (pinned by the structure suite).
 */

const load = createRequire(__filename);
const ROOT = join(__dirname, '..');
const cleanups: (() => void)[] = [];
after(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

const keys = privateDirectory('frontera-g02c1d-mutation-keys-');
cleanups.push(() => rmSync(keys, { recursive: true, force: true }));
const KEY = generateReceiptKey(keys, 'executor.pem');
const TRUSTED = [e2eTrustedExecutor(KEY.publicKeyPem)];
const OPTIONS = { issuer: G02B_ISSUER, organizationId: G02B_ORGANIZATION, trustDomain: G02B_TRUST_DOMAIN, clock: () => Date.now() };

interface Mutant<M> {
  readonly id: string;
  readonly file: string;
  readonly replacements: readonly (readonly [string, string])[];
  readonly guard: (module: M) => boolean | Promise<boolean>;
}

async function qualify<M>(mutant: Mutant<M>): Promise<void> {
  const path = join(ROOT, mutant.file);
  let source = readFileSync(path, 'utf8');
  for (const [search, replace] of mutant.replacements) {
    assert.equal(source.split(search).length - 1, 1, `${mutant.id}: the mutation site must occur exactly once in ${mutant.file}: ${search.slice(0, 60)}`);
    source = source.replace(search, replace);
  }
  const mutantPath = path.replace(/\.js$/, `.mutant-g02c1d-${mutant.id}.js`);
  writeFileSync(mutantPath, source);
  try {
    assert.equal(await mutant.guard(load(path) as M), true, `${mutant.id}: the guard holds for the shipped module`);
    assert.equal(await mutant.guard(load(mutantPath) as M), false, `${mutant.id}: the guard detects the removed control`);
  } finally {
    delete load.cache[load.resolve(mutantPath)];
    rmSync(mutantPath, { force: true });
  }
}

/** A real issued capability and its presented exchange, through the real issuer, gate and adapter. */
async function issued(): Promise<{ readonly world: HostWorld; readonly capability: ExecutionCapability; readonly exchange: GenericHttpExchangeEvidence }> {
  const world = await hostWorld({ trustedExecutors: TRUSTED, respond: () => ({ kind: 'response', status: 201, providerRefValues: [], receiptValues: [] }) });
  cleanups.push(() => world.close());
  const signed = await world.grant();
  await world.execute(world.actionFor(signed));
  const exchange = world.exchanges[0];
  assert.ok(exchange !== undefined);
  return { world, capability: presentedCapability(world.sent[0] as GenericHttpWireRequest), exchange };
}

const signed = (receipt: ExecutorReceipt): readonly string[] => [deliverableReceipt(KEY.keyFile, receipt)];

// ── The presentation header (D1) ───────────────────────────────────────────

type AdapterModule = typeof import('../execution-adapters/generic-http/generic-http-execution-adapter.js');
const ADAPTER = join('execution-adapters', 'generic-http', 'generic-http-execution-adapter.js');
type HeadersModule = typeof import('../execution-adapters/generic-http/governed-headers.js');
const HEADERS = join('execution-adapters', 'generic-http', 'governed-headers.js');

async function sentWith(m: AdapterModule, verdict: unknown, observe?: (exchange: GenericHttpExchangeEvidence) => void) {
  const network = countingNetwork(201);
  const world = await issued();
  const action = world.exchange.action;
  await m.createGenericHttpExecutionAdapterCore(gatedPlan(), network, recordingGate(verdict).gate, observe === undefined ? undefined : async (exchange) => observe(exchange)).execute(action);
  return network.sent;
}

describe('G-02C1D mutation — the one presentation header', () => {
  const mutants: readonly (Mutant<AdapterModule> | Mutant<HeadersModule>)[] = [
    {
      id: 'verdict-extra-member-accepted',
      file: ADAPTER,
      replacements: [["key === 'proceed' || key === 'presentation'", 'true']],
      guard: async (m) => (await sentWith(m as AdapterModule, { proceed: true, presentation: 'abc', header: 'authorization' })).length === 0,
    },
    {
      id: 'presentation-replaces-the-request-headers',
      file: ADAPTER,
      replacements: [['[...request.headers, ', '[']],
      guard: async (m) => {
        const sent = (await sentWith(m as AdapterModule, { proceed: true, presentation: 'abc' }))[0];
        return sent !== undefined && sent.headers.some(([name]) => name === 'authorization') && sent.headers.filter(([name]) => name === GENERIC_HTTP_PRESENTATION_HEADER).length === 1;
      },
    },
    {
      id: 'unpresented-exchange-observed',
      file: ADAPTER,
      replacements: [['if (exchange.presented && observer !== undefined)', 'if (observer !== undefined)']],
      guard: async (m) => {
        let observed = 0;
        await sentWith(m as AdapterModule, { proceed: true }, () => {
          observed += 1;
        });
        return observed === 0;
      },
    },
    {
      id: 'presentation-unbounded',
      file: HEADERS,
      replacements: [['value.length <= maximum && ', '']],
      guard: (m) => (m as HeadersModule).isGovernedHeaderValue('A'.repeat(8_193), 8_192) === false,
    },
    {
      id: 'presentation-any-alphabet',
      file: HEADERS,
      replacements: [['BASE64URL.test(value)', 'true']],
      guard: (m) => (m as HeadersModule).isGovernedHeaderValue('abc\r\nx-injected: 1', 8_192) === false,
    },
  ];
  for (const mutant of mutants) it(mutant.id, () => qualify(mutant as Mutant<unknown>));
});

// ── The receipt transport encoding ─────────────────────────────────────────

type TransportModule = typeof import('../executor-receipt/transport.js');
const TRANSPORT = join('executor-receipt', 'transport.js');

describe('G-02C1D mutation — the receipt transport encoding', () => {
  const mutants: readonly Mutant<TransportModule>[] = [
    {
      id: 'duplicated-receipt-read',
      file: TRANSPORT,
      replacements: [['if (values.length > 1)', 'if (false)']],
      guard: async (m) => {
        const { capability } = await issued();
        const one = signed(receiptAbout(capability))[0] as string;
        return !m.decodeExecutorReceiptTransport([one, one]).ok;
      },
    },
    {
      id: 'noncanonical-envelope-accepted',
      file: TRANSPORT,
      replacements: [['}) !== text)', '}) === null)']],
      guard: async (m) => {
        const { capability } = await issued();
        const text = serializeExecutorReceipt(receiptAbout(capability));
        const signature = signReceiptText(KEY.keyFile, text);
        const reordered = Buffer.from(JSON.stringify({ receipt: text, format: 'frontera.executor-receipt-transport.v1', signature }), 'utf8').toString('base64url');
        return !m.decodeExecutorReceiptTransport([reordered]).ok;
      },
    },
    {
      id: 'receipt-text-unchecked',
      file: TRANSPORT,
      replacements: [['parseExecutorReceipt)(receipt).ok)', 'parseExecutorReceipt)(receipt).ok || true)']],
      guard: async (m) => {
        const { capability } = await issued();
        const text = `${serializeExecutorReceipt(receiptAbout(capability))} `;
        const signature = signReceiptText(KEY.keyFile, text);
        const envelope = Buffer.from(JSON.stringify({ format: 'frontera.executor-receipt-transport.v1', receipt: text, signature: { algorithm: signature['algorithm'], artifactVersion: signature['artifactVersion'], keyId: signature['keyId'], signature: signature['signature'] } }), 'utf8').toString('base64url');
        return !m.decodeExecutorReceiptTransport([envelope]).ok;
      },
    },
  ];
  for (const mutant of mutants) it(mutant.id, () => qualify(mutant));
});

// ── Verification and correlation ───────────────────────────────────────────

type RecorderModule = typeof import('../execution-receipt-evidence/recorder.js');
const RECORDER = join('execution-receipt-evidence', 'recorder.js');

/** The disposition the recorder built by `m` gives `values` for a real issued execution. */
async function dispositionOf(m: RecorderModule, values: (capability: ExecutionCapability) => readonly string[], options: { readonly unissued?: boolean } = {}) {
  const { world, capability, exchange } = await issued();
  const recorder = m.createExecutionReceiptEvidenceRecorder({ adapterId: E2E_ADAPTER_ID, audience: E2E_AUDIENCE, issuer: G02B_ISSUER, organizationId: G02B_ORGANIZATION, trustDomain: G02B_TRUST_DOMAIN, verifier: createExecutionReceiptTrust(TRUSTED) });
  recorder.bind({ issuance: options.unissued === true ? { read: () => ({ state: 'absent' as const }) } : world.issuance, store: world.evidence });
  await recorder.observe({ ...exchange, receiptValues: values(capability) });
  const observations = world.evidence.observationsFor(capability.executionId);
  const last = observations[observations.length - 1];
  return last === undefined ? undefined : [last.disposition, last.failure];
}

const otherExecution = (capability: ExecutionCapability) => `${capability.executionId.slice(0, -1)}${capability.executionId.endsWith('0') ? '1' : '0'}`;

describe('G-02C1D mutation — the Host verifies and correlates before it records evidence', () => {
  const same = (value: unknown, expected: readonly unknown[]) => JSON.stringify(value) === JSON.stringify(expected);
  const mutants: readonly Mutant<RecorderModule>[] = [
    {
      id: 'issuance-correlation-skipped',
      file: RECORDER,
      replacements: [["if (correlated.identityMatch !== 'yes' || correlated.bindingMatch !== 'yes' || correlated.failure !== null)", 'if (false)']],
      guard: async (m) => same(await dispositionOf(m, (capability) => signed(receiptAbout(capability, { executionId: otherExecution(capability) }))), ['receipt-uncorrelated', 'IDENTITY_MISMATCH']),
    },
    {
      id: 'issuance-not-required',
      file: RECORDER,
      replacements: [['if (issued === undefined)', 'if (false)']],
      guard: async (m) => same(await dispositionOf(m, (capability) => signed(receiptAbout(capability)), { unissued: true }), ['receipt-uncorrelated', 'ISSUANCE_NOT_FOUND']),
    },
    {
      id: 'claim-window-unchecked',
      file: RECORDER,
      replacements: [['if (!inWindow)', 'if (false)']],
      guard: async (m) => same(await dispositionOf(m, (capability) => signed(receiptAbout(capability, { consumption: { claimedAt: capability.expiresAt }, observedAt: capability.expiresAt }))), ['receipt-uncorrelated', 'TEMPORALLY_INCONSISTENT']),
    },
    {
      id: 'executor-scope-unchecked',
      file: RECORDER,
      replacements: [["if (authenticated.scope !== 'permitted')", 'if (false)']],
      guard: async (m) => same(await dispositionOf(m, (capability) => signed(receiptAbout(capability, { organizationId: 'org-elsewhere' }))), ['receipt-invalid', 'SCOPE_NOT_PERMITTED']),
    },
    {
      id: 'unconfirmed-compared',
      file: RECORDER,
      replacements: [["if (httpOutcome === 'unconfirmed')", 'if (false)']],
      guard: (m) => m.receiptAgreementOf('unconfirmed', 'completed-observed') === 'not-comparable',
    },
  ];
  for (const mutant of mutants) it(mutant.id, () => qualify(mutant));
});

// ── The evidence store ─────────────────────────────────────────────────────

type StoreModule = typeof import('../execution-receipt-evidence/evidence-store.js');
const STORE = join('execution-receipt-evidence', 'evidence-store.js');

/** A fresh store opened by `m` (created by the shipped module, as the operator would), and an exchange builder for `capability`. */
async function storeWorld(m: StoreModule) {
  const { capability, exchange } = await issued();
  const dir = privateDirectory('frontera-g02c1d-mutation-store-');
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'evidence.sqlite');
  const shipped = load(join(ROOT, STORE)) as StoreModule;
  (await shipped.openExecutionReceiptEvidenceStore(path, { ...OPTIONS, create: true })).close();
  const store = await m.openExecutionReceiptEvidenceStore(path, OPTIONS);
  cleanups.push(() => store.close());
  const entry = (receipt: ExecutorReceipt, overrides: Partial<ExecutionReceiptExchange> = {}): ExecutionReceiptExchange => {
    const canonical = serializeExecutorReceipt(receipt);
    return {
      executionId: capability.executionId,
      adapterId: exchange.adapterId,
      capabilityId: capability.capabilityId,
      transmission: 'response',
      httpStatus: 201,
      httpOutcome: 'completed',
      candidate: { receipt, canonical, signature: signReceiptText(KEY.keyFile, canonical) },
      disposition: null,
      failure: null,
      receiptDigest: null,
      agreement: 'consistent',
      ...overrides,
    };
  };
  return { capability, path, store, entry };
}

const attempts = (run: () => unknown): string => {
  try {
    const outcome = run() as { readonly disposition?: string; readonly failure?: string | null };
    return `${outcome.disposition ?? ''}:${outcome.failure ?? ''}`;
  } catch {
    return 'threw';
  }
};

describe('G-02C1D mutation — the evidence store keeps one receipt per position, forward only, and refuses tampering', () => {
  const mutants: readonly Mutant<StoreModule>[] = [
    {
      id: 'taken-position-not-a-conflict',
      file: STORE,
      replacements: [['if (statements.evidenceAt.get(receipt.capabilityId, receipt.sequence) !== undefined)', 'if (false)']],
      guard: async (m) => {
        const { capability, store, entry } = await storeWorld(m);
        store.record(entry(receiptAbout(capability)));
        const rival = receiptAbout(capability, { observation: { kind: 'frontera.synthetic-deployment-record.v1', reference: `${capability.capabilityId}.json`, digest: `sha256:${'f'.repeat(64)}` } });
        return attempts(() => store.record(entry(rival))) === 'receipt-conflicting:POSITION_TAKEN';
      },
    },
    {
      id: 'identical-repeat-inserted-again',
      file: STORE,
      replacements: [['if (!placed.repeated)', 'if (true)']],
      guard: async (m) => {
        const { capability, store, entry } = await storeWorld(m);
        store.record(entry(receiptAbout(capability)));
        return attempts(() => store.record(entry(receiptAbout(capability)))) === 'receipt-correlated:';
      },
    },
    {
      id: 'supersession-of-a-definite-outcome-accepted',
      file: STORE,
      replacements: [['return forward ? { accept: true, repeated: false }', 'return true ? { accept: true, repeated: false }']],
      guard: async (m) => {
        const { capability, store, entry } = await storeWorld(m);
        const first = receiptAbout(capability);
        store.record(entry(first));
        return attempts(() => store.record(entry(receiptAbout(capability, {}, { sequence: 2, supersedes: first.receiptId })))) === 'receipt-conflicting:SUPERSESSION_INVALID';
      },
    },
    {
      id: 'unanchored-successor-accepted',
      file: STORE,
      replacements: [['if (priorRow === undefined)', 'if (false)']],
      guard: async (m) => {
        const { capability, store, entry } = await storeWorld(m);
        const anchor = receiptAbout(capability, UNKNOWN);
        return attempts(() => store.record(entry(receiptAbout(capability, {}, { sequence: 2, supersedes: anchor.receiptId })))) === 'receipt-conflicting:PREDECESSOR_UNKNOWN';
      },
    },
    {
      id: 'foreign-receipt-stored',
      file: STORE,
      replacements: [
        [
          'if (receipt.issuer !== issuer || receipt.organizationId !== organizationId || receipt.trustDomain !== trustDomain || receipt.executionId !== exchange.executionId || receipt.capabilityId !== exchange.capabilityId)',
          'if (false)',
        ],
      ],
      guard: async (m) => {
        const { capability, store, entry } = await storeWorld(m);
        return attempts(() => store.record(entry(receiptAbout(capability), { executionId: otherExecution(capability) }))) === 'threw';
      },
    },
    {
      id: 'handed-object-trusted-over-text',
      file: STORE,
      replacements: [['if (!reparsed.ok || reparsed.receipt.receiptId !== candidate.receipt.receiptId)', 'if (!reparsed.ok)']],
      guard: async (m) => {
        const { capability, store, entry } = await storeWorld(m);
        const honest = entry(receiptAbout(capability));
        const lying = { ...honest, candidate: { ...(honest.candidate as NonNullable<ExecutionReceiptExchange['candidate']>), receipt: { ...receiptAbout(capability), receiptId: 'f'.repeat(64) } as ExecutorReceipt } };
        return attempts(() => store.record(lying)) === 'threw';
      },
    },
    {
      id: 'corrupted-row-accepted-on-open',
      file: STORE,
      replacements: [["for (const row of db.prepare('SELECT * FROM receipt_evidence').all())", 'for (const row of [])']],
      guard: async (m) => {
        const { capability, path, store, entry } = await storeWorld(m);
        store.record(entry(receiptAbout(capability)));
        store.close();
        const { default: Database } = await import('better-sqlite3');
        const raw = new Database(path);
        raw.exec('DROP TRIGGER receipt_evidence_never_updated');
        raw.prepare("UPDATE receipt_evidence SET canonical = canonical || ' '").run();
        raw.exec("CREATE TRIGGER receipt_evidence_never_updated BEFORE UPDATE ON receipt_evidence BEGIN SELECT RAISE(ABORT, 'receipt evidence is immutable'); END;");
        raw.close();
        try {
          (await m.openExecutionReceiptEvidenceStore(path, OPTIONS)).close();
          return false;
        } catch {
          return true;
        }
      },
    },
    {
      id: 'dropped-trigger-accepted',
      file: STORE,
      replacements: [['if (triggers.n !== TRIGGERS.length)', 'if (false)']],
      guard: async (m) => {
        const { path, store } = await storeWorld(m);
        store.close();
        const { default: Database } = await import('better-sqlite3');
        const raw = new Database(path);
        raw.exec('DROP TRIGGER receipt_evidence_forward_supersession');
        raw.close();
        try {
          (await m.openExecutionReceiptEvidenceStore(path, OPTIONS)).close();
          return false;
        } catch {
          return true;
        }
      },
    },
    {
      id: 'another-identity-accepted',
      file: STORE,
      replacements: [['if (meta.issuer !== issuer || meta.organization_id !== organizationId || meta.trust_domain !== trustDomain)', 'if (false)']],
      guard: async (m) => {
        const { path, store } = await storeWorld(m);
        store.close();
        try {
          (await m.openExecutionReceiptEvidenceStore(path, { ...OPTIONS, issuer: 'frontera-deployment-elsewhere' })).close();
          return false;
        } catch {
          return true;
        }
      },
    },
    {
      id: 'shared-store-file-accepted',
      file: STORE,
      replacements: [["|| (!create && !private_(file, 'file'))", '']],
      guard: async (m) => {
        const { path, store } = await storeWorld(m);
        store.close();
        chmodSync(path, 0o666);
        try {
          (await m.openExecutionReceiptEvidenceStore(path, OPTIONS)).close();
          return false;
        } catch {
          return true;
        }
      },
    },
  ];
  for (const mutant of mutants) it(mutant.id, () => qualify(mutant));
});
