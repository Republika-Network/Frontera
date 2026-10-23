import { chmodSync, copyFileSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createPrivateKey, sign } from 'node:crypto';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { AUTHORITY_ARTIFACT_VERSION } from '../authority-authenticity/index.js';
import { EXECUTOR_RECEIPT_SIGNING_DOMAIN, parseExecutorReceipt, positionExecutorReceipt, serializeExecutorReceipt, type ExecutorReceipt, type ExecutorReceiptDraft } from '../executor-receipt/index.js';
import { openExecutionCapabilityConsumptionLedger } from '../execution-capability/reference/consumption-ledger.js';
import { openExecutorReceiptLedger } from '../reference-executor/receipt-ledger.js';
import { loadExecutorReceiptSigner } from '../reference-executor/receipt-signer.js';
import { AUDIENCE, EXECUTOR_ID, hostVector, observedWith } from './g02c1a-reference-executor-fixture.js';
import { syntheticCapability } from './g02c1b-synthetic-execution-fixture.js';
import { BINDING_FORMAT, ISSUER_PINS, RECEIPT_KEY_ID, generateReceiptKey, receiptDomain, receiptWorld, trustedExecutor, type ReceiptDomain } from './g02c1c-executor-receipt-fixture.js';

/**
 * G-02C1C mutation qualification, in the manner of G-02A … G-02C1B: each
 * load-bearing control of the receipt path is removed from the **compiled**
 * module (module-local sites, each occurring exactly once), the mutant is
 * loaded beside the original, and its guard must hold for the original and
 * fail for the mutant.
 *
 * "Automatic effect retry" has no code to remove: no receipt module calls the
 * effect, claims or records a consumption outcome (pinned by the structure
 * suite).
 */

const load = createRequire(__filename);
const ROOT = join(__dirname, '..');
const domains: ReceiptDomain[] = [];
after(() => {
  for (const domain of domains) domain.cleanup();
});
async function freshDomain(): Promise<ReceiptDomain> {
  const domain = await receiptDomain();
  domains.push(domain);
  return domain;
}

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
  const mutantPath = path.replace(/\.js$/, `.mutant-g02c1c-${mutant.id}.js`);
  writeFileSync(mutantPath, source);
  try {
    assert.equal(await mutant.guard(load(path) as M), true, `${mutant.id}: the guard holds for the shipped module`);
    assert.equal(await mutant.guard(load(mutantPath) as M), false, `${mutant.id}: the guard detects the removed control`);
  } finally {
    delete load.cache[load.resolve(mutantPath)];
    rmSync(mutantPath, { force: true });
  }
}

const VECTOR = hostVector('POST with body and headers', {
  body: { kind: 'json-object', fields: { subject: { kind: 'source', source: 'subject' }, amount: { kind: 'source', source: 'amount.value' } } },
  headers: { 'X-Release-Channel': { kind: 'literal', value: 'stable' } },
});

/** One real completed receipt (signed by the domain's executor key in process) and its domain. */
async function realReceipt(): Promise<{ readonly domain: ReceiptDomain; readonly receipt: ExecutorReceipt; readonly presented: { readonly receipt: string; readonly signature: Readonly<Record<string, string>> } }> {
  const domain = await freshDomain();
  const world = await receiptWorld(domain);
  try {
    const { capability, presentation } = syntheticCapability(VECTOR.digest);
    world.flow.execute(observedWith(VECTOR, { presentation }));
    const presented = world.receipts.history(capability.capabilityId)[0];
    assert.ok(presented !== undefined);
    const parsed = parseExecutorReceipt(presented.receipt);
    assert.ok(parsed.ok);
    return { domain, receipt: parsed.receipt, presented };
  } finally {
    world.close();
  }
}

function forge(keyFile: string, text: string, keyId: string): { readonly receipt: string; readonly signature: Record<string, string> } {
  const signature = sign(null, Buffer.from(`${EXECUTOR_RECEIPT_SIGNING_DOMAIN}${text}`, 'utf8'), createPrivateKey(readFileSync(keyFile, 'utf8'))).toString('base64url');
  return { receipt: text, signature: { algorithm: 'ed25519-v1', artifactVersion: AUTHORITY_ARTIFACT_VERSION, keyId, signature } };
}

const draftOf = (receipt: ExecutorReceipt): ExecutorReceiptDraft => {
  const { receiptId: _id, sequence: _sequence, supersedes: _supersedes, ...draft } = receipt;
  return draft;
};

// ── The receipt contract ────────────────────────────────────────────────────

type ReceiptModule = typeof import('../executor-receipt/receipt.js');
const RECEIPT = join('executor-receipt', 'receipt.js');

describe('G-02C1C mutation — the receipt contract', () => {
  const mutants: readonly Mutant<ReceiptModule>[] = [
    {
      id: 'completed-from-claimed-state-accepted',
      file: RECEIPT,
      replacements: [["!outcomeConsistent(r['outcome'], consumption['ledgerState'], r['basis']) || ", '']],
      guard: async (m) => {
        const { receipt } = await realReceipt();
        return !m.isWellFormedExecutorReceipt({ ...receipt, consumption: { ...receipt.consumption, ledgerState: 'claimed' } });
      },
    },
    {
      id: 'receipt-id-unbound',
      file: RECEIPT,
      replacements: [["r['receiptId'] === executorReceiptId({ executorId, capabilityId, sequence })", "typeof r['receiptId'] === 'string'"]],
      guard: async (m) => {
        const { receipt } = await realReceipt();
        return !m.isWellFormedExecutorReceipt({ ...receipt, receiptId: 'a'.repeat(64) });
      },
    },
    {
      id: 'wrong-signing-domain',
      file: RECEIPT,
      replacements: [["serializeExecutorReceipt(receipt)}`, 'utf8');", "serializeExecutorReceipt(receipt)}`.replace('frontera:executor-receipt:v1\\n', 'frontera:authority-artifact:execution-capability:v1\\n'), 'utf8');"]],
      guard: async (m) => {
        const { receipt } = await realReceipt();
        return m.executorReceiptSigningBytes(receipt).toString('utf8').startsWith('frontera:executor-receipt:v1\n');
      },
    },
  ];
  for (const mutant of mutants) it(mutant.id, () => qualify(mutant));
});

// ── The verifier ────────────────────────────────────────────────────────────

type VerifierModule = typeof import('../executor-receipt/verifier.js');
const VERIFIER = join('executor-receipt', 'verifier.js');

describe('G-02C1C mutation — the standalone verifier', () => {
  const scoped = (overrides: Record<string, unknown>) => async (m: VerifierModule) => {
    const { domain, presented } = await realReceipt();
    return m.createExecutorReceiptVerifier({ trustedExecutors: [{ ...trustedExecutor(domain.publicKeyPem), ...overrides }] }).verify(presented).scope === 'not-permitted';
  };
  const mutants: readonly Mutant<VerifierModule>[] = [
    {
      id: 'executor-key-binding-unchecked',
      file: VERIFIER,
      replacements: [['const keyPinned = envelopeKeyId === receipt.executorKeyId && keyOwners.get(receipt.executorKeyId) === receipt.executorId;', 'const keyPinned = true;']],
      // Both keys pinned for the executor; the receipt names the first, the signature is the second's.
      guard: async (m) => {
        const { domain, presented } = await realReceipt();
        const second = generateReceiptKey(domain.keyDirectory, 'second.pem');
        const verifier = m.createExecutorReceiptVerifier({ trustedExecutors: [trustedExecutor(domain.publicKeyPem, RECEIPT_KEY_ID, [{ keyId: 'g02c1c-second', publicKeyPem: second.publicKeyPem }])] });
        return verifier.verify(forge(second.keyFile, presented.receipt, 'g02c1c-second')).executorTrust === 'untrusted';
      },
    },
    { id: 'audience-unchecked', file: VERIFIER, replacements: [['pinned.audiences.includes(receipt.audience) && ', '']], guard: scoped({ audiences: ['executor-elsewhere'] }) },
    { id: 'organization-unchecked', file: VERIFIER, replacements: [['pinned.organizationIds.includes(receipt.organizationId) && ', '']], guard: scoped({ organizationIds: ['org-elsewhere'] }) },
    { id: 'trust-domain-unchecked', file: VERIFIER, replacements: [[' && pinned.trustDomains.includes(receipt.trustDomain)', '']], guard: scoped({ trustDomains: ['trust-domain-elsewhere'] }) },
    {
      id: 'forged-signature-accepted',
      file: VERIFIER,
      replacements: [['if (!verdict.verified) {', 'if (false) {']],
      guard: async (m) => {
        const { domain, presented } = await realReceipt();
        const bytes = Buffer.from(presented.signature['signature'] as string, 'base64url');
        bytes[5] = (bytes[5] ?? 0) ^ 0x10;
        return m.createExecutorReceiptVerifier({ trustedExecutors: [trustedExecutor(domain.publicKeyPem)] }).verify({ receipt: presented.receipt, signature: { ...presented.signature, signature: bytes.toString('base64url') } }).signature === 'invalid';
      },
    },
    {
      id: 'supersession-relation-unchecked',
      file: VERIFIER,
      replacements: [["const forward = receipt.supersedes === prior.receiptId && prior.outcome === 'attempted-outcome-unknown' && receipt.outcome !== 'attempted-outcome-unknown' && receipt.observedAt >= prior.observedAt;", 'const forward = true;']],
      // A well-formed successor of a definite outcome: only the forward-supersession check refuses it.
      guard: async (m) => {
        const { domain, receipt, presented } = await realReceipt();
        const successor = serializeExecutorReceipt(positionExecutorReceipt(draftOf(receipt), 2, receipt.receiptId));
        return m.createExecutorReceiptVerifier({ trustedExecutors: [trustedExecutor(domain.publicKeyPem)] }).assessHistory([presented, forge(domain.keyFile, successor, RECEIPT_KEY_ID)]).chain === 'conflicting';
      },
    },
    {
      id: 'duplicate-position-accepted',
      file: VERIFIER,
      replacements: [['if (seen !== undefined && JSON.stringify(seen) !== JSON.stringify(receipt))', 'if (false)']],
      guard: async (m) => {
        const { domain, receipt, presented } = await realReceipt();
        const observation = receipt.observation as NonNullable<ExecutorReceipt['observation']>;
        const rival = serializeExecutorReceipt(positionExecutorReceipt({ ...draftOf(receipt), observation: { ...observation, digest: `sha256:${'9'.repeat(64)}` } }, 1, null));
        return m.createExecutorReceiptVerifier({ trustedExecutors: [trustedExecutor(domain.publicKeyPem)] }).assessHistory([presented, forge(domain.keyFile, rival, RECEIPT_KEY_ID)]).chain === 'conflicting';
      },
    },
  ];
  for (const mutant of mutants) it(mutant.id, () => qualify(mutant));
});

// ── The receipt ledger ──────────────────────────────────────────────────────

type LedgerModule = typeof import('../reference-executor/receipt-ledger.js');
const LEDGER = join('reference-executor', 'receipt-ledger.js');

/** A new receipt ledger made by `m`, then raw SQL against it. Does `attack` fail? */
async function rawAttackRefused(m: LedgerModule, attack: (db: import('better-sqlite3').Database) => void): Promise<boolean> {
  const domain = await freshDomain();
  const path = join(domain.root, 'receipts', 'mutant.sqlite');
  (await m.openExecutorReceiptLedger(path, { executorId: EXECUTOR_ID, audience: AUDIENCE, clock: () => Date.now(), create: true })).close();
  const { default: Database } = await import('better-sqlite3');
  const db = new Database(path);
  try {
    attack(db);
    return false;
  } catch {
    return true;
  } finally {
    db.close();
  }
}

const insert = (db: import('better-sqlite3').Database, id: string, sequence: number, supersedes: string | null, outcome: string): void => {
  db.prepare('INSERT INTO executor_receipts (receipt_id, capability_id, execution_id, issuer, sequence, supersedes, outcome, ledger_state, key_id, canonical, digest, state, reserved_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    id,
    'c'.repeat(64),
    'e',
    'i',
    sequence,
    supersedes,
    outcome,
    'completed',
    'k',
    '{}',
    'd',
    'reserved',
    'now',
  );
};

describe('G-02C1C mutation — the receipt ledger', () => {
  const mutants: readonly Mutant<LedgerModule>[] = [
    {
      id: 'receipt-overwrite-allowed',
      file: LEDGER,
      replacements: [
        ['BEFORE UPDATE ON executor_receipts\nWHEN NOT', 'BEFORE UPDATE ON executor_receipts\nWHEN 0 AND (NOT'],
        ['OR NEW.reserved_at IS NOT OLD.reserved_at\nBEGIN', 'OR NEW.reserved_at IS NOT OLD.reserved_at)\nBEGIN'],
      ],
      guard: (m) =>
        rawAttackRefused(m, (db) => {
          insert(db, 'a'.repeat(64), 1, null, 'completed-observed');
          db.prepare("UPDATE executor_receipts SET canonical = 'rewritten'").run();
        }),
    },
    {
      id: 'duplicate-sequence-accepted',
      file: LEDGER,
      replacements: [['  UNIQUE (capability_id, sequence),\n', '']],
      guard: (m) =>
        rawAttackRefused(m, (db) => {
          insert(db, 'a'.repeat(64), 1, null, 'completed-observed');
          insert(db, 'b'.repeat(64), 1, null, 'completed-observed');
        }),
    },
    {
      id: 'supersession-unchecked-in-ledger',
      file: LEDGER,
      replacements: [['WHEN NEW.supersedes IS NOT NULL AND NOT EXISTS (', 'WHEN 0 AND NOT EXISTS (']],
      guard: (m) =>
        rawAttackRefused(m, (db) => {
          insert(db, 'a'.repeat(64), 1, null, 'completed-observed');
          insert(db, 'b'.repeat(64), 2, 'a'.repeat(64), 'failed-observed');
        }),
    },
    {
      id: 'corrupted-receipt-accepted-on-reopen',
      file: LEDGER,
      replacements: [['for (const row of all)', 'for (const row of [])']],
      guard: async (m) => {
        const { domain, presented } = await realReceipt();
        const { default: Database } = await import('better-sqlite3');
        const db = new Database(domain.receiptLedgerPath);
        try {
          const trigger = (db.prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'executor_receipts_issue_only'").get() as { sql: string }).sql;
          db.exec('DROP TRIGGER executor_receipts_issue_only');
          db.prepare('UPDATE executor_receipts SET canonical = ?').run(presented.receipt.replace('completed-observed', 'failed-observed'));
          db.exec(trigger);
        } finally {
          db.close();
        }
        try {
          (await m.openExecutorReceiptLedger(domain.receiptLedgerPath, { executorId: EXECUTOR_ID, audience: AUDIENCE, clock: () => Date.now() })).close();
          return false;
        } catch {
          return true;
        }
      },
    },
    {
      id: 'stale-reservation-superseded',
      file: LEDGER,
      replacements: [["if (newest.state === 'reserved')", 'if (false)']],
      // An unsigned reservation, then a changed state: the reservation must come back to be signed first.
      guard: async (m) => {
        const { receipt } = await realReceipt();
        const domain = await freshDomain();
        const ledger = await m.openExecutorReceiptLedger(join(domain.root, 'receipts', 'stale.sqlite'), { executorId: EXECUTOR_ID, audience: AUDIENCE, clock: () => Date.now(), create: true });
        try {
          ledger.reserve({ ...draftOf(receipt), consumption: { ...receipt.consumption, ledgerState: 'claimed' }, outcome: 'attempted-outcome-unknown', basis: 'durable-state', observedAt: receipt.consumption.claimedAt, observation: null });
          return ledger.reserve(draftOf(receipt)).sequence === 1;
        } catch {
          return false;
        } finally {
          ledger.close();
        }
      },
    },
    {
      id: 'shared-receipt-ledger-accepted',
      file: LEDGER,
      replacements: [["|| (!create && !private_(file, 'file'))", '']],
      guard: async (m) => {
        const domain = await freshDomain();
        chmodSync(domain.receiptLedgerPath, 0o666);
        try {
          (await m.openExecutorReceiptLedger(domain.receiptLedgerPath, { executorId: EXECUTOR_ID, audience: AUDIENCE, clock: () => Date.now() })).close();
          return false;
        } catch {
          return true;
        }
      },
    },
    {
      id: 'conflicting-change-reserved',
      file: LEDGER,
      replacements: [['if (!forward)', 'if (false)']],
      guard: async (m) => {
        const { receipt } = await realReceipt();
        const domain = await freshDomain();
        const path = join(domain.root, 'receipts', 'conflict.sqlite');
        const ledger = await m.openExecutorReceiptLedger(path, { executorId: EXECUTOR_ID, audience: AUDIENCE, clock: () => Date.now(), create: true });
        try {
          ledger.reserve(draftOf(receipt));
          ledger.reserve({ ...draftOf(receipt), consumption: { ...receipt.consumption, ledgerState: 'failed' }, outcome: 'attempted-outcome-unknown', basis: 'durable-state', observation: null });
          return false;
        } catch (error) {
          return (error as Error).name === 'ExecutorReceiptConflictError';
        } finally {
          ledger.close();
        }
      },
    },
  ];
  for (const mutant of mutants) it(mutant.id, () => qualify(mutant));
});

// ── The signer ──────────────────────────────────────────────────────────────

type SignerModule = typeof import('../reference-executor/receipt-signer.js');
const SIGNER = join('reference-executor', 'receipt-signer.js');

describe('G-02C1C mutation — the receipt signer', () => {
  const loadWith = (m: SignerModule, domain: ReceiptDomain, overrides: Record<string, unknown> = {}) =>
    m.loadExecutorReceiptSigner({ executorId: EXECUTOR_ID, keyId: RECEIPT_KEY_ID, privateKeyFile: domain.keyFile, receiptLedger: { owns: () => false }, issuerKeys: ISSUER_PINS, ...overrides });
  const mutants: readonly Mutant<SignerModule>[] = [
    {
      id: 'unverified-record-signed',
      file: SIGNER,
      replacements: [['if (!branded)', 'if (false)']],
      // A look-alike of a reservation — not one the receipt ledger produced from durable state — is never signed.
      guard: async (m) => {
        const { domain, receipt, presented } = await realReceipt();
        const ledger = await openExecutorReceiptLedger(domain.receiptLedgerPath, { executorId: EXECUTOR_ID, audience: AUDIENCE, clock: () => Date.now() });
        try {
          const stored = ledger.read(receipt.receiptId);
          assert.ok(stored !== undefined && stored.canonical === presented.receipt);
          loadWith(m, domain, { receiptLedger: ledger }).signExecutorReceipt({ ...stored });
          return false;
        } catch {
          return true;
        } finally {
          ledger.close();
        }
      },
    },
    {
      id: 'issuer-key-id-collision-accepted',
      file: SIGNER,
      replacements: [['if (issuerKey.keyId === keyId)', 'if (false)']],
      guard: async (m) => {
        const domain = await freshDomain();
        try {
          loadWith(m, domain, { keyId: ISSUER_PINS[0]?.keyId });
          return false;
        } catch {
          return true;
        }
      },
    },
    {
      id: 'receipt-private-key-exported',
      file: SIGNER,
      replacements: [['return Object.freeze({ executorId, keyId, publicKeyPem, signExecutorReceipt });', 'return Object.freeze({ executorId, keyId, publicKeyPem, signExecutorReceipt, privateKey });']],
      guard: async (m) => {
        const domain = await freshDomain();
        return Object.keys(loadWith(m, domain)).sort().join(',') === 'executorId,keyId,publicKeyPem,signExecutorReceipt';
      },
    },
    {
      id: 'key-file-exposure-accepted',
      file: SIGNER,
      replacements: [['if (stat.uid !== uid || (stat.mode & 0o077) !== 0)', 'if (false)']],
      guard: async (m) => {
        const domain = await freshDomain();
        const open = join(domain.keyDirectory, 'open.pem');
        copyFileSync(domain.keyFile, open);
        chmodSync(open, 0o644);
        try {
          loadWith(m, domain, { privateKeyFile: open });
          return false;
        } catch {
          return true;
        }
      },
    },
  ];
  for (const mutant of mutants) it(mutant.id, () => qualify(mutant));
});

// ── The issuer ──────────────────────────────────────────────────────────────

type IssuerModule = typeof import('../reference-executor/receipt-issuer.js');
const ISSUER = join('reference-executor', 'receipt-issuer.js');

describe('G-02C1C mutation — issuance from durable state', () => {
  const mutants: readonly Mutant<IssuerModule>[] = [
    {
      id: 'claimed-or-unknown-reported-completed',
      file: ISSUER,
      replacements: [["return { outcome: 'attempted-outcome-unknown', basis: 'durable-state' };", "return { outcome: 'completed-observed', basis: 'durable-state' };"]],
      guard: (m) => m.receiptOutcomeFor('claimed').outcome === 'attempted-outcome-unknown' && m.receiptOutcomeFor('outcome-unknown').outcome === 'attempted-outcome-unknown',
    },
    {
      id: 'failed-refined-without-observation',
      file: ISSUER,
      replacements: [["const precise = observed === 'failed-observed' || observed === 'consumed-not-attempted';", 'const precise = true;']],
      guard: (m) => m.receiptOutcomeFor('failed').outcome === 'attempted-outcome-unknown',
    },
    {
      id: 'substituted-reservation-signed',
      file: ISSUER,
      replacements: [['if (!supportedBy(reservation.receipt, draft))', 'if (false)']],
      // A reserved row whose organization differs from the durable consumption: never signed.
      guard: async (m) => {
        const { domain, receipt } = await realReceipt();
        const consumption = await openExecutionCapabilityConsumptionLedger(domain.ledgerPath, { audience: AUDIENCE, clock: () => Date.now() });
        const receipts = await openExecutorReceiptLedger(join(domain.root, 'receipts', 'substituted.sqlite'), { executorId: EXECUTOR_ID, audience: AUDIENCE, clock: () => Date.now(), create: true });
        try {
          receipts.reserve({ ...draftOf(receipt), organizationId: 'org-substituted' });
          const signer = loadExecutorReceiptSigner({ executorId: EXECUTOR_ID, keyId: RECEIPT_KEY_ID, privateKeyFile: domain.keyFile, receiptLedger: receipts, issuerKeys: ISSUER_PINS });
          const issuance = m.createExecutorReceiptIssuer({ executorId: EXECUTOR_ID, audience: AUDIENCE, bindingFormat: BINDING_FORMAT, consumption, receipts, signer, outputDirectory: domain.outputDirectory }).issue(receipt.capabilityId);
          return issuance.status === 'refused' && issuance.code === 'RECEIPT_CONFLICT';
        } finally {
          consumption.close();
          receipts.close();
        }
      },
    },
    {
      id: 'completed-without-matching-evidence',
      file: ISSUER,
      replacements: [["const matches = record['format'] ===", "const matches = true || record['format'] ==="]],
      guard: async (m) => {
        const domain = await freshDomain();
        const world = await receiptWorld(domain, {
          receiptFault: (point) => {
            if (point === 'before-receipt') throw new Error('no in-path receipt');
          },
        });
        const { capability, presentation } = syntheticCapability(VECTOR.digest);
        try {
          world.flow.execute(observedWith(VECTOR, { presentation }));
        } finally {
          world.close();
        }
        const record = join(domain.outputDirectory, `${capability.capabilityId}.json`);
        const text = readFileSync(record, 'utf8');
        rmSync(record);
        writeFileSync(record, text.replace(VECTOR.digest, `sha256:${'0'.repeat(64)}`), { mode: 0o600 });
        const consumption = await openExecutionCapabilityConsumptionLedger(domain.ledgerPath, { audience: AUDIENCE, clock: () => Date.now() });
        const receipts = await openExecutorReceiptLedger(domain.receiptLedgerPath, { executorId: EXECUTOR_ID, audience: AUDIENCE, clock: () => Date.now() });
        try {
          const signer = loadExecutorReceiptSigner({ executorId: EXECUTOR_ID, keyId: RECEIPT_KEY_ID, privateKeyFile: domain.keyFile, receiptLedger: receipts, issuerKeys: ISSUER_PINS });
          const issuance = m.createExecutorReceiptIssuer({ executorId: EXECUTOR_ID, audience: AUDIENCE, bindingFormat: BINDING_FORMAT, consumption, receipts, signer, outputDirectory: domain.outputDirectory }).issue(capability.capabilityId);
          return issuance.status === 'refused' && issuance.code === 'EVIDENCE_UNAVAILABLE';
        } finally {
          consumption.close();
          receipts.close();
        }
      },
    },
  ];
  for (const mutant of mutants) it(mutant.id, () => qualify(mutant));
});
