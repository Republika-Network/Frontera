import { copyFileSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import Database from 'better-sqlite3';

import type { AuthorityArtifactSigner, AuthoritySignature, ExecutionCapabilityIssuanceRequest } from '../authority-authenticity/index.js';
import { ExternalAuthoritySignerTransportError } from '../external-authority-signer/transport.js';
import { EXTERNAL_AUTHORITY_SIGNER_OPERATIONS } from '../external-authority-signer/index.js';
import { AUTHORITY_KEY_A, AUTHORITY_KEY_B, AUTHORITY_KEY_UNTRUSTED, testVerifier, trustedKeyOf } from './authority-authenticity-fixture.js';
import {
  G02B_ISSUER,
  G02B_OTHER_AUDIENCE,
  LedgerDirectory,
  NOW,
  POLICY,
  bindingDigest,
  capabilityFor,
  custodySigner,
  inputFor,
  policyInput,
  readerOf,
  requestFor,
  signCapabilityBytes,
  signedGrant,
  type SignedGrant,
} from './g02b-execution-capability-issuance-fixture.js';

/**
 * G-02B mutation qualification, in G-02A's and TRADE-04C-S1's manner: each
 * load-bearing control is removed from the **compiled** module, the mutant is
 * loaded beside the original, and the guarding property must hold for the
 * original and fail for the mutant. Every guard presents a case whose every
 * *other* check agrees, so only the mutated control stands between it and
 * acceptance. Where two mechanisms guard one property they are removed
 * together. Mutation sites name only module-local identifiers and never span
 * a line break the emitter introduces (tsc puts a brace-less `if` body on its
 * own line), so they read the same in TypeScript and in the emitted CommonJS.
 */

const load = createRequire(__filename);
const ROOT = join(__dirname, '..');
const ledgers = new LedgerDirectory();
after(() => ledgers.cleanup());

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
  const mutantPath = path.replace(/\.js$/, `.mutant-g02b-${mutant.id}.js`);
  writeFileSync(mutantPath, source);
  try {
    assert.equal(await mutant.guard(load(path) as M), true, `${mutant.id}: the guard holds for the shipped module`);
    assert.equal(await mutant.guard(load(mutantPath) as M), false, `${mutant.id}: the guard detects the removed control`);
  } finally {
    delete load.cache[load.resolve(mutantPath)];
    rmSync(mutantPath, { force: true });
  }
}

// ── The custody rule ────────────────────────────────────────────────────────

type RuleModule = typeof import('../authority-authenticity/execution-capability-issuance.js');
const RULE = join('authority-authenticity', 'execution-capability-issuance.js');

/** Refused by this module's rule. */
const refuses = (m: RuleModule, request: ExecutionCapabilityIssuanceRequest, now = NOW): boolean =>
  !m.assessExecutionCapabilityIssuance(request, { verifyGrant: testVerifier([AUTHORITY_KEY_A, AUTHORITY_KEY_UNTRUSTED]).verifyGrant, activeKeyId: AUTHORITY_KEY_A.keyId, policy: POLICY, now }).issuable;

const skip = (line: string): readonly [string, string] => [line, ';'];

describe('G-02B mutation — the custody rule', () => {
  const mutants: readonly Mutant<RuleModule>[] = [
    { id: 'skip-issuer', file: RULE, replacements: [skip("return refuse('CAPABILITY_ISSUER_MISMATCH');")], guard: async (m) => refuses(m, requestFor(await signedGrant(), { issuer: 'frontera-deployment-other' })) },
    { id: 'skip-organization', file: RULE, replacements: [skip("return refuse('CAPABILITY_ORGANIZATION_MISMATCH');")], guard: async (m) => refuses(m, requestFor(await signedGrant(), { organizationId: 'org-other' })) },
    { id: 'skip-trust-domain', file: RULE, replacements: [skip("return refuse('CAPABILITY_TRUST_DOMAIN_MISMATCH');")], guard: async (m) => refuses(m, requestFor(await signedGrant(), { trustDomain: 'trust-domain-other' })) },
    {
      id: 'skip-terms',
      file: RULE,
      replacements: [skip("return refuse('CAPABILITY_TERMS_UNSUPPORTED');")],
      guard: async (m) => refuses(m, requestFor(await signedGrant(), { statusRequirement: 'online-status-required' })) && refuses(m, requestFor(await signedGrant(), { onBehalfOfActorId: 'actor-principal' })),
    },
    { id: 'any-registered-audience', file: RULE, replacements: [['const registration = policy.audiences.find((entry) => entry.audience === capability.audience);', 'const registration = policy.audiences[0];']], guard: async (m) => refuses(m, requestFor(await signedGrant(), { audience: 'executor-unknown' })) },
    { id: 'skip-audience-action', file: RULE, replacements: [skip("return refuse('AUDIENCE_ACTION_NOT_PERMITTED');")], guard: async (m) => refuses(m, requestFor(await signedGrant({ action: 'export-records' }))) },
    {
      id: 'skip-audience-binding-format',
      file: RULE,
      replacements: [skip("return refuse('AUDIENCE_BINDING_FORMAT_NOT_PERMITTED');")],
      guard: async (m) => refuses(m, requestFor(await signedGrant(), { actionBinding: { format: 'frontera.other-binding.v1', digest: bindingDigest() } })),
    },
    {
      id: 'skip-grant-signature',
      file: RULE,
      replacements: [skip("return refuse('GRANT_SIGNATURE_INVALID');")],
      // Signed by a key the verifier knows but that is not the custody key: only the "own key" half refuses.
      guard: async (m) => refuses(m, requestFor(await signedGrant({ key: AUTHORITY_KEY_UNTRUSTED }))),
    },
    { id: 'skip-grant-reference', file: RULE, replacements: [['capability.grantReference !== reference)', 'false)']], guard: async (m) => refuses(m, { ...requestFor(await signedGrant()), grantReferenceNonce: 'ab'.repeat(32) }) },
    { id: 'skip-grant-organization', file: RULE, replacements: [skip("return refuse('GRANT_ORGANIZATION_MISMATCH');")], guard: async (m) => refuses(m, requestFor(await signedGrant({ organizationId: 'org-other' }))) },
    { id: 'skip-subject', file: RULE, replacements: [skip("return refuse('GRANT_SUBJECT_MISMATCH');")], guard: async (m) => refuses(m, requestFor(await signedGrant(), { subjectActorId: 'actor-other' })) },
    {
      id: 'skip-grant-action',
      file: RULE,
      replacements: [skip("return refuse('GRANT_ACTION_MISMATCH');")],
      // The second audience may receive both actions, so only the grant comparison refuses.
      guard: async (m) => refuses(m, requestFor(await signedGrant({ action: 'export-records' }), { action: 'deploy-release', audience: G02B_OTHER_AUDIENCE })),
    },
    { id: 'skip-grant-resource', file: RULE, replacements: [skip("return refuse('GRANT_RESOURCE_MISMATCH');")], guard: async (m) => refuses(m, requestFor(await signedGrant(), { resource: 'production-cluster-us' })) },
    { id: 'skip-execution-derivation', file: RULE, replacements: [skip("return refuse('EXECUTION_DERIVATION_MISMATCH');")], guard: async (m) => refuses(m, requestFor(await signedGrant(), { executionId: 'aoc.exec:0123456789abcdef0123456789abcdef' })) },
    {
      id: 'skip-grant-expiry',
      file: RULE,
      replacements: [['|| !(context.now < grantExpiresAt))', ')']],
      // The grant ends at the custody instant; the capability ends with it, so no window check refuses.
      guard: async (m) => refuses(m, requestFor(await signedGrant({ expiresAt: NOW }), {}, { now: NOW - 1_000, lifetimeMs: 1_000 })),
    },
    { id: 'skip-clock-skew', file: RULE, replacements: [['Math.abs(issuedAt - context.now) >', 'Math.abs(issuedAt - context.now) * 0 >']], guard: async (m) => refuses(m, requestFor(await signedGrant(), {}, { now: NOW - 5_001 })) },
    { id: 'skip-lifetime', file: RULE, replacements: [['expiresAt - issuedAt > Math.min(', 'expiresAt - issuedAt > Infinity + Math.min(']], guard: async (m) => refuses(m, requestFor(await signedGrant(), {}, { lifetimeMs: 30_001 })) },
    { id: 'skip-outlive-grant', file: RULE, replacements: [['if (expiresAt > grantExpiresAt || issuedAt < grantIssuedAt)', 'if (false)']], guard: async (m) => refuses(m, requestFor(await signedGrant({ expiresAt: NOW + 10_000 }))) },
  ];
  for (const mutant of mutants) it(mutant.id, () => qualify(mutant));
});

// ── Software custody ────────────────────────────────────────────────────────

type SignerModule = typeof import('../authority-authenticity/signer.js');
const SIGNER = join('authority-authenticity', 'signer.js');

describe('G-02B mutation — software custody', () => {
  it('sign-despite-refusal', () =>
    qualify<SignerModule>({
      id: 'sign-despite-refusal',
      file: SIGNER,
      replacements: [
        ['if (!ruling.issuable)', 'if (false)'],
        ['(ruling.capability))', '(request.capability))'],
      ],
      guard: async (m) => {
        const signer = m.createSoftwareAuthorityArtifactSigner({ keyId: AUTHORITY_KEY_A.keyId, algorithm: 'ed25519-v1', privateKeyPem: AUTHORITY_KEY_A.privateKeyPem, now: () => NOW, executionCapabilityIssuance: policyInput() });
        try {
          await signer.signExecutionCapability!(requestFor(await signedGrant(), { audience: 'executor-unknown' }));
          return false;
        } catch {
          return true;
        }
      },
    }));
});

// ── The issuer ──────────────────────────────────────────────────────────────

type IssuerModule = typeof import('../execution-capability-issuance/issuer.js');
const ISSUER = join('execution-capability-issuance', 'issuer.js');

function counted(behaviour?: (request: ExecutionCapabilityIssuanceRequest) => Promise<AuthoritySignature>): { readonly signer: AuthorityArtifactSigner; calls(): number } {
  const base = custodySigner();
  let calls = 0;
  return {
    signer: {
      ...base,
      signExecutionCapability: async (request: ExecutionCapabilityIssuanceRequest) => {
        calls += 1;
        return behaviour !== undefined ? behaviour(request) : base.signExecutionCapability!(request);
      },
    },
    calls: () => calls,
  };
}

async function issuerOf(m: IssuerModule, signed: SignedGrant, signer: AuthorityArtifactSigner, revoked: readonly string[] = []) {
  return m.createExecutionCapabilityIssuer({ grants: readerOf([signed], revoked), signer, verifier: testVerifier([AUTHORITY_KEY_A, AUTHORITY_KEY_B]), policy: POLICY, ledger: await ledgers.create(), now: () => NOW });
}

describe('G-02B mutation — the issuer', () => {
  const mutants: readonly Mutant<IssuerModule>[] = [
    {
      id: 'skip-revocation',
      file: ISSUER,
      replacements: [['if (read.revocation !== undefined)', 'if (false)']],
      // Custody never sees revocation: this Host-side check is the only one.
      guard: async (m) => {
        const signed = await signedGrant();
        const issuer = await issuerOf(m, signed, custodySigner(), [signed.grant.id]);
        try {
          await issuer.issue(inputFor(signed));
          return false;
        } catch {
          return true;
        }
      },
    },
    {
      id: 'ignore-existing-execution',
      file: ISSUER,
      replacements: [["if (before !== 'absent')", 'if (false)'], ["if (reserved.outcome === 'exists')", 'if (false)']],
      guard: async (m) => {
        const signed = await signedGrant();
        const custody = counted();
        const issuer = await issuerOf(m, signed, custody.signer);
        await issuer.issue(inputFor(signed)).catch(() => undefined);
        await issuer.issue(inputFor(signed)).catch(() => undefined);
        return custody.calls() === 1;
      },
    },
    {
      id: 'ignore-concurrent-reservation',
      file: ISSUER,
      replacements: [["if (reserved.outcome === 'exists')", 'if (false)']],
      guard: async (m) => {
        const signed = await signedGrant();
        const custody = counted();
        const issuer = await issuerOf(m, signed, custody.signer);
        await Promise.allSettled([issuer.issue(inputFor(signed)), issuer.issue(inputFor(signed))]);
        return custody.calls() === 1;
      },
    },
    {
      id: 'accept-unverified-signature',
      file: ISSUER,
      replacements: [['if (!verification.verified || verification.keyId !== signer.activeKeyId) {', 'if (false) {']],
      guard: async (m) => {
        const signed = await signedGrant();
        const issuer = await issuerOf(m, signed, counted(async (request) => signCapabilityBytes(request.capability, AUTHORITY_KEY_B)).signer);
        try {
          await issuer.issue(inputFor(signed));
          return false;
        } catch {
          return true;
        }
      },
    },
  ];
  for (const mutant of mutants) it(mutant.id, () => qualify(mutant));
});

// ── The issuance ledger ─────────────────────────────────────────────────────

type LedgerModule = typeof import('../execution-capability-issuance/issuance-ledger.js');
const LEDGER = join('execution-capability-issuance', 'issuance-ledger.js');

async function reservation(signed?: SignedGrant) {
  const grant = signed ?? (await signedGrant());
  const { capability, nonce } = capabilityFor(grant);
  return { capability, boundedGrantId: grant.grant.id, grantStoreId: grant.storeId, grantDigest: grant.grant.digest, grantReferenceNonce: nonce };
}

describe('G-02B mutation — the issuance ledger', () => {
  const mutants: readonly Mutant<LedgerModule>[] = [
    {
      id: 'replace-existing-reservation',
      file: LEDGER,
      replacements: [
        ['if (existing !== undefined)', 'if (false)'],
        ['INSERT INTO execution_capability_issuances (execution_id,', 'INSERT OR REPLACE INTO execution_capability_issuances (execution_id,'],
      ],
      guard: async (m) => {
        const ledger = ledgers.track(await m.openExecutionCapabilityIssuanceLedger(ledgers.path(), { issuer: G02B_ISSUER, clock: () => NOW, create: true }));
        const signed = await signedGrant();
        ledger.reserve(await reservation(signed));
        try {
          return ledger.reserve(await reservation(signed)).outcome === 'exists';
        } catch {
          return true;
        }
      },
    },
    {
      id: 'skip-row-reference-check',
      file: LEDGER,
      replacements: [['if (capability.grantReference !== reference)', 'if (false)']],
      guard: async (m) => {
        const path = ledgers.path();
        const ledger = await m.openExecutionCapabilityIssuanceLedger(path, { issuer: G02B_ISSUER, clock: () => NOW, create: true });
        const entry = await reservation();
        ledger.reserve(entry);
        ledger.close();
        const db = new Database(path);
        db.exec('DROP TRIGGER execution_capability_issuances_forward_only');
        db.prepare(`UPDATE execution_capability_issuances SET grant_reference_nonce = '${'ab'.repeat(32)}'`).run();
        db.exec(`CREATE TRIGGER execution_capability_issuances_forward_only BEFORE UPDATE ON execution_capability_issuances WHEN 0 BEGIN SELECT 1; END;`);
        db.close();
        const reopened = ledgers.track(await m.openExecutionCapabilityIssuanceLedger(path, { issuer: G02B_ISSUER, clock: () => NOW }));
        try {
          reopened.read(entry.capability.executionId);
          return false;
        } catch {
          return true;
        }
      },
    },
    {
      id: 'create-missing-ledger',
      file: LEDGER,
      replacements: [['const create = options.create === true;', 'const create = options.create === true || true;']],
      guard: async (m) => {
        try {
          ledgers.track(await m.openExecutionCapabilityIssuanceLedger(ledgers.path(), { issuer: G02B_ISSUER, clock: () => NOW }));
          return false;
        } catch {
          return true;
        }
      },
    },
    {
      id: 'skip-trigger-check',
      file: LEDGER,
      replacements: [['if (triggers.n !== LEDGER_TRIGGERS.length)', 'if (false)']],
      guard: async (m) => {
        const path = ledgers.path();
        (await m.openExecutionCapabilityIssuanceLedger(path, { issuer: G02B_ISSUER, clock: () => NOW, create: true })).close();
        const stripped = ledgers.path();
        copyFileSync(path, stripped);
        const db = new Database(stripped);
        db.exec('DROP TRIGGER execution_capability_issuances_never_deleted');
        db.close();
        try {
          ledgers.track(await m.openExecutionCapabilityIssuanceLedger(stripped, { issuer: G02B_ISSUER, clock: () => NOW }));
          return false;
        } catch {
          return true;
        }
      },
    },
  ];
  for (const mutant of mutants) it(mutant.id, () => qualify(mutant));
});

// ── External custody ────────────────────────────────────────────────────────

type ExternalModule = typeof import('../external-authority-signer/external-signer.js');
const EXTERNAL = join('external-authority-signer', 'external-signer.js');

describe('G-02B mutation — external custody', () => {
  it('retry-capability-request', () =>
    qualify<ExternalModule>({
      id: 'retry-capability-request',
      file: EXTERNAL,
      replacements: [["return request.operation === 'signExecutionCapability' ? 1 : maxAttempts;", 'return maxAttempts;']],
      guard: async (m) => {
        let attempts = 0;
        const pinned = { keyId: AUTHORITY_KEY_A.keyId, algorithm: 'ed25519-v1' as const, publicKeyPem: trustedKeyOf(AUTHORITY_KEY_A).publicKeyPem };
        const transport = {
          identity: async () => ({ protocol: 'frontera.external-authority-signer.v1', keyId: AUTHORITY_KEY_A.keyId, algorithm: 'ed25519-v1', publicKeyPem: AUTHORITY_KEY_A.publicKeyPem, artifactVersion: 'aoc.authority-artifact.v1', operations: [...EXTERNAL_AUTHORITY_SIGNER_OPERATIONS, 'signExecutionCapability'] }),
          sign: async () => {
            attempts += 1;
            throw new ExternalAuthoritySignerTransportError('EXTERNAL_SIGNER_TIMEOUT', 'timed out');
          },
        };
        const { signer } = await m.establishExternalAuthorityArtifactSigner({ transport, pinned, verifier: testVerifier([AUTHORITY_KEY_A]), timeoutMs: 1_000, maxAttempts: 3, extensions: ['signExecutionCapability'] });
        await signer.signExecutionCapability!(requestFor(await signedGrant())).catch(() => undefined);
        return attempts === 1;
      },
    }));
});
