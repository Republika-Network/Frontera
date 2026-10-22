import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { executionCapabilityActionBindingDigest, serializeExecutionCapability, type ExecutionCapability, type ExecutionCapabilityVerifierOptions } from '../execution-capability/index.js';
import { AUTHORITY_KEY_A, AUTHORITY_KEY_B } from './authority-authenticity-fixture.js';
import { G02A_AUDIENCE, G02A_BINDING_FORMAT, G02A_ORGANIZATION, G02A_TRUST_DOMAIN, NOW, bindingValue, capabilityFor, iso, issuerPinning, present, requestFor, signCapability, signText, verifierFor } from './g02a-execution-capability-fixture.js';

/**
 * G-02A mutation qualification, in TRADE-04C-S1's manner: each load-bearing
 * check is removed from the **compiled** module, the mutant is loaded beside
 * the original, and the guarding property must then fail. The original is
 * never modified; every mutant file is removed after use.
 *
 * Each guard presents a case whose every *other* check agrees, so that only
 * the mutated check stands between it and acceptance. Where two mechanisms
 * guard one property (the ledger's explicit checks and its key constraints),
 * they are removed together.
 */

const load = createRequire(__filename);
const ROOT = join(__dirname, '..');

interface Mutant<M> {
  readonly id: string;
  readonly file: string;
  readonly replacements: readonly (readonly [string, string])[];
  /** Resolves `true` when the safety property holds for this module. */
  readonly guard: (module: M) => boolean | Promise<boolean>;
}

async function qualify<M>(mutant: Mutant<M>): Promise<void> {
  const path = join(ROOT, mutant.file);
  let source = readFileSync(path, 'utf8');
  for (const [search, replace] of mutant.replacements) {
    assert.equal(source.split(search).length - 1, 1, `${mutant.id}: the mutation site must occur exactly once in ${mutant.file}: ${search.slice(0, 60)}`);
    source = source.replace(search, replace);
  }
  const mutantPath = path.replace(/\.js$/, `.mutant-g02a-${mutant.id}.js`);
  writeFileSync(mutantPath, source);
  try {
    assert.equal(await mutant.guard(load(path) as M), true, `${mutant.id}: the guard holds for the shipped module`);
    assert.equal(await mutant.guard(load(mutantPath) as M), false, `${mutant.id}: the guard detects the removed check`);
  } finally {
    delete load.cache[load.resolve(mutantPath)];
    rmSync(mutantPath, { force: true });
  }
}

// ── The verifier ────────────────────────────────────────────────────────────

type VerifierModule = typeof import('../execution-capability/verifier.js');
const VERIFIER = join('execution-capability', 'verifier.js');

function verifierOf(m: VerifierModule, options: Partial<ExecutionCapabilityVerifierOptions> = {}) {
  return m.createExecutionCapabilityVerifier({
    trustedIssuers: [issuerPinning()],
    executor: { audience: G02A_AUDIENCE, organizationIds: [G02A_ORGANIZATION], trustDomain: G02A_TRUST_DOMAIN },
    clock: () => NOW,
    ...options,
  });
}

/** Refused by this module's verifier. */
const refuses = (m: VerifierModule, presentation: unknown, overrides: Parameters<typeof requestFor>[1] = {}, options: Partial<ExecutionCapabilityVerifierOptions> = {}): boolean =>
  verifierOf(m, options).verify(requestFor(presentation, overrides)).verification === 'rejected';

const reject = (check: string, failure: string): string => `return reject('${check}', '${failure}');`;

describe('G-02A mutation — the verifier', () => {
  const mutants: readonly Mutant<VerifierModule>[] = [
    { id: 'skip-signature', file: VERIFIER, replacements: [["return reject('signature', 'SIGNATURE_INVALID', verdict.failure);", ';']], guard: (m) => {
      const capability = capabilityFor();
      return refuses(m, { capability: serializeExecutionCapability(capability), signature: signCapability(capability, AUTHORITY_KEY_B, AUTHORITY_KEY_A.keyId) });
    } },
    { id: 'skip-key-binding', file: VERIFIER, replacements: [[reject('issuer', 'ISSUER_KEY_MISMATCH'), ';']], guard: (m) => {
      // Both keys pinned for the issuer; the capability names A, the envelope B — signed by B, so the signature itself verifies.
      const capability = capabilityFor({}, AUTHORITY_KEY_A);
      return refuses(m, { capability: serializeExecutionCapability(capability), signature: signCapability(capability, AUTHORITY_KEY_B) });
    } },
    { id: 'skip-audience', file: VERIFIER, replacements: [[reject('audience', 'AUDIENCE_MISMATCH'), ';']], guard: (m) => refuses(m, present(capabilityFor({ audience: 'executor-data-worker' }))) },
    { id: 'skip-organization', file: VERIFIER, replacements: [[reject('organization', 'ORGANIZATION_MISMATCH'), ';']], guard: (m) => refuses(m, present(capabilityFor({ organizationId: 'org-other' }))) },
    { id: 'skip-trust-domain', file: VERIFIER, replacements: [[reject('trustDomain', 'TRUST_DOMAIN_MISMATCH'), ';']], guard: (m) => refuses(m, present(capabilityFor({ trustDomain: 'trust-domain-other' }))) },
    { id: 'skip-expiry', file: VERIFIER, replacements: [[reject('validityWindow', 'CAPABILITY_EXPIRED'), ';']], guard: (m) => refuses(m, present(capabilityFor({ issuedAt: iso(NOW - 30_000), expiresAt: iso(NOW) }))) },
    { id: 'skip-not-yet-valid', file: VERIFIER, replacements: [[reject('validityWindow', 'CAPABILITY_NOT_YET_VALID'), ';']], guard: (m) => refuses(m, present(capabilityFor({ issuedAt: iso(NOW + 5_001), expiresAt: iso(NOW + 20_000) }))) },
    { id: 'skip-maximum-lifetime', file: VERIFIER, replacements: [[reject('validityWindow', 'CAPABILITY_LIFETIME_INVALID'), ';']], guard: (m) => refuses(m, present(capabilityFor({ issuedAt: iso(NOW - 1_000), expiresAt: iso(NOW + 59_001) }))) },
    { id: 'skip-action', file: VERIFIER, replacements: [[reject('action', 'ACTION_MISMATCH'), ';']], guard: (m) => refuses(m, present(capabilityFor()), { action: 'rollback-release' }) },
    { id: 'skip-resource', file: VERIFIER, replacements: [[reject('resource', 'RESOURCE_MISMATCH'), ';']], guard: (m) => refuses(m, present(capabilityFor()), { resource: 'production-cluster-us' }) },
    { id: 'skip-binding-format', file: VERIFIER, replacements: [[reject('actionBinding', 'ACTION_BINDING_FORMAT_MISMATCH'), ';']], guard: (m) => {
      // The capability binds the same record under another format, digested under that format: only the format check differs.
      const format = 'frontera.job-message-binding.v1';
      const capability = capabilityFor({ actionBinding: { format, digest: executionCapabilityActionBindingDigest({ format, value: bindingValue() }) } });
      return refuses(m, present(capability));
    } },
    { id: 'skip-binding-digest', file: VERIFIER, replacements: [[reject('actionBinding', 'ACTION_BINDING_MISMATCH'), ';']], guard: (m) => refuses(m, present(capabilityFor()), { value: bindingValue({ body: { strategy: 'rolling', replicas: 5, requestId: 'deploy-7' } }) }) },
    {
      id: 'status-required-consumable',
      file: VERIFIER,
      replacements: [["Object.freeze({ eligible: false, reason: 'STATUS_REQUIRED_UNAVAILABLE' })", 'Object.freeze({ eligible: true })']],
      guard: (m) => {
        const result = verifierOf(m).verify(requestFor(present(capabilityFor({ statusRequirement: 'online-status-required' }))));
        return result.verification === 'verified' && result.consumption.eligible === false;
      },
    },
    {
      id: 'brand-any-shape',
      file: VERIFIER,
      replacements: [['!VERIFIED.has(value)', 'false']],
      guard: (m) => {
        const genuine = verifierFor().verify(requestFor(present(capabilityFor())));
        return m.readVerifiedExecutionCapability({ ...genuine }) === undefined;
      },
    },
  ];
  for (const mutant of mutants) it(`detected: ${mutant.id}`, () => qualify(mutant));
  it('control: a genuine presentation verifies under the shipped verifier', () => {
    assert.equal(refuses(load(join(ROOT, VERIFIER)) as VerifierModule, present(capabilityFor())), false);
  });
});

// ── The codec ───────────────────────────────────────────────────────────────

type CapabilityModule = typeof import('../execution-capability/capability.js');
const CAPABILITY = join('execution-capability', 'capability.js');

describe('G-02A mutation — the canonical codec', () => {
  const mutants: readonly Mutant<CapabilityModule>[] = [
    {
      id: 'accept-noncanonical',
      file: CAPABILITY,
      replacements: [['=== canonical ? { ok: true, capability }', '!== undefined ? { ok: true, capability }']],
      guard: (m) => {
        const text = serializeExecutionCapability(capabilityFor());
        return m.parseExecutionCapability(text.replace('{', '{ ')).ok === false && m.parseExecutionCapability(text.replace('"action":"deploy-release",', '"action":"rollback-release","action":"deploy-release",')).ok === false;
      },
    },
    {
      id: 'accept-unpaired-surrogate-identifier',
      file: CAPABILITY,
      replacements: [['!UNPAIRED_SURROGATE.test(value)', 'true']],
      guard: (m) => m.isWellFormedExecutionCapability(capabilityFor({ subjectActorId: 'agent:\ud800' })) === false,
    },
    {
      id: 'audience-pattern',
      file: CAPABILITY,
      replacements: [[" && !value.includes('*')", '']],
      guard: (m) => m.isWellFormedExecutionCapability(capabilityFor({ audience: '*' })) === false,
    },
    {
      id: 'drop-undefined-binding-value',
      file: CAPABILITY,
      replacements: [['if (descriptor.value === undefined)', 'if (false)']],
      guard: (m) => {
        try {
          m.executionCapabilityActionBindingDigest({ format: G02A_BINDING_FORMAT, value: { a: undefined } });
          return false;
        } catch {
          return true;
        }
      },
    },
    {
      id: 'self-delegation',
      file: CAPABILITY,
      replacements: [[" && onBehalfOf !== c['subjectActorId']", '']],
      guard: (m) => m.isWellFormedExecutionCapability(capabilityFor({ onBehalfOfActorId: 'agent:release-bot' })) === false,
    },
  ];
  for (const mutant of mutants) it(`detected: ${mutant.id}`, () => qualify(mutant));
  it('control: a non-canonical text is still validly signed by the attacker — only the codec refuses it', () => {
    const text = serializeExecutionCapability(capabilityFor()).replace('{', '{ ');
    assert.equal(verifierFor().verify(requestFor({ capability: text, signature: signText(text) })).verification, 'rejected');
  });
});

// ── The reference ledger ────────────────────────────────────────────────────

type LedgerModule = typeof import('../execution-capability/reference/consumption-ledger.js');
const LEDGER = join('execution-capability', 'reference', 'consumption-ledger.js');
const workDir = mkdtempSync(join(tmpdir(), 'aoc-g02a-mutation-'));
after(() => rmSync(workDir, { recursive: true, force: true }));
let files = 0;

async function withLedger<T>(m: LedgerModule, run: (ledger: Awaited<ReturnType<LedgerModule['openExecutionCapabilityConsumptionLedger']>>) => T, clock: () => number = () => NOW): Promise<T> {
  const ledger = await m.openExecutionCapabilityConsumptionLedger(join(workDir, `ledger-${(files += 1)}.sqlite`), { audience: G02A_AUDIENCE, clock, create: true });
  try {
    return run(ledger);
  } finally {
    ledger.close();
  }
}

const verifiedFor = (overrides: Partial<Record<keyof ExecutionCapability, unknown>> = {}) => verifierFor().verify(requestFor(present(capabilityFor(overrides))));

describe('G-02A mutation — the reference consumption ledger', () => {
  const mutants: readonly Mutant<LedgerModule>[] = [
    {
      id: 'single-use-removed',
      file: LEDGER,
      replacements: [
        ["return { outcome: 'refused', reason: 'CAPABILITY_CONSUMED' };", ';'],
        ["return { outcome: 'refused', reason: 'EXECUTION_CONSUMED' };", ';'],
        ['capability_id TEXT PRIMARY KEY,', 'capability_id TEXT,'],
        [',\n  UNIQUE (issuer, execution_id)', ''],
      ],
      guard: (m) =>
        withLedger(m, (ledger) => {
          const result = verifiedFor();
          return ledger.claim(result).outcome === 'claimed' && ledger.claim(result).outcome === 'refused';
        }),
    },
    {
      id: 'execution-uniqueness-removed',
      file: LEDGER,
      replacements: [
        ["return { outcome: 'refused', reason: 'EXECUTION_CONSUMED' };", ';'],
        [',\n  UNIQUE (issuer, execution_id)', ''],
      ],
      guard: (m) =>
        withLedger(m, (ledger) => {
          const executionId = 'aoc.exec:mutation-shared';
          return ledger.claim(verifiedFor({ executionId })).outcome === 'claimed' && ledger.claim(verifiedFor({ executionId })).outcome === 'refused';
        }),
    },
    {
      id: 'status-required-claimable',
      file: LEDGER,
      replacements: [["return refuse('STATUS_REQUIRED_UNAVAILABLE');", ';']],
      guard: (m) => withLedger(m, (ledger) => ledger.claim(verifiedFor({ statusRequirement: 'online-status-required' })).outcome === 'refused'),
    },
    {
      id: 'audience-unpinned',
      file: LEDGER,
      replacements: [["return refuse('AUDIENCE_MISMATCH');", ';']],
      guard: async (m) => {
        const ledger = await m.openExecutionCapabilityConsumptionLedger(join(workDir, `ledger-${(files += 1)}.sqlite`), { audience: 'executor-data-worker', clock: () => NOW, create: true });
        try {
          return ledger.claim(verifiedFor()).outcome === 'refused';
        } finally {
          ledger.close();
        }
      },
    },
    {
      id: 'expiry-not-rechecked',
      file: LEDGER,
      replacements: [["return refuse('CAPABILITY_EXPIRED');", ';']],
      guard: (m) => withLedger(m, (ledger) => ledger.claim(verifiedFor()).outcome === 'refused', () => NOW + 60_000),
    },
  ];
  for (const mutant of mutants) it(`detected: ${mutant.id}`, () => qualify(mutant));
});
