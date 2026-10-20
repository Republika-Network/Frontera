import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createAuthorityArtifactVerifier } from '../authority-authenticity/index.js';
import { DELEGATED_OFFER_SIGNER_PROTOCOL, type DelegatedOfferSignerTransport, type PreparedDelegatedOffer } from '../xrpl-trade-rail/index.js';
import { AUTHORITY_KEY_A, AUTHORITY_KEY_B, AUTHORITY_KEY_UNTRUSTED, testSigner, testVerifier, trustedKeyOf } from './authority-authenticity-fixture.js';
import { authorizedInput, offerWorld } from './trade04b-xrpl-fixture.js';
import { S1_ORGANIZATION, S1_TRUST_DOMAIN, capabilityFor, proposalForOffer, s1ReferenceOptions, signerAuthorization, tempCapabilityLedger, testCapabilityIssuer, tradeGrantFor, type Authorized } from './trade04c-s1-capability-fixture.js';
import { executorRig, rawProposal, validatedAction, type ExecutorRig } from './trade04c-execution-fixture.js';

/**
 * TRADE-04C-S1 mutation qualification, in TRADE-04B's manner: each
 * load-bearing check of the capability is removed from the **compiled**
 * module, the mutant is loaded beside the original, and the guarding
 * property must then fail. The original is never modified; every mutant file
 * is removed after use.
 *
 * Layered checks — removing one alone leaves another that still refuses — are
 * mutated together where they guard one property (the consumption ledger's
 * explicit checks and its key constraints), or are pinned by their own
 * failure codes in the behavioral suites. In particular the signing-preimage
 * digest is backed by the explicit Sequence / Fee / LastLedgerSequence
 * comparisons and the proposal-to-transaction derivation: each guard below
 * presents a capability whose *other* links agree, so that only the mutated
 * link stands between it and a signature.
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
  const mutantPath = path.replace(/\.js$/, `.mutant-s1-${mutant.id}.js`);
  writeFileSync(mutantPath, source);
  try {
    assert.equal(await mutant.guard(load(path) as M), true, `${mutant.id}: the guard holds for the shipped module`);
    assert.equal(await mutant.guard(load(mutantPath) as M), false, `${mutant.id}: the guard detects the removed check`);
  } finally {
    delete load.cache[load.resolve(mutantPath)];
    rmSync(mutantPath, { force: true });
  }
}

// ── The signer's authorization chain ────────────────────────────────────────

type AuthorizationModule = typeof import('../xrpl-trade-rail/delegated-offer-authorization.js');
const AUTHORIZATION = join('xrpl-trade-rail', 'delegated-offer-authorization.js');
const world = offerWorld();
const offer = world.offer();
const pin = { network: 'xrp-ledger-testnet' as const, pair: world.pair, trustDomain: S1_TRUST_DOMAIN, organizationId: S1_ORGANIZATION };

/** Refused by this module's chain, for `transaction` with `authorized`, against the pinned issuers. */
const refuses = (m: AuthorizationModule, authorized: Pick<Authorized, 'proposal' | 'authorization'>, transaction: PreparedDelegatedOffer = offer, issuers: { readonly trusted?: readonly (typeof AUTHORITY_KEY_A)[]; readonly pinned?: readonly string[] } = {}): boolean =>
  !m.authorizeDelegatedOffer({
    transaction,
    proposal: authorized.proposal,
    authorization: authorized.authorization,
    pin,
    issuerKeyIds: issuers.pinned ?? [AUTHORITY_KEY_A.keyId],
    verifier: createAuthorityArtifactVerifier((issuers.trusted ?? [AUTHORITY_KEY_A]).map(trustedKeyOf)),
    now: Date.now(),
  }).authorized;

const otherProposalSameTerms = proposalForOffer(offer)!;
const devnetProposal = proposalForOffer(offer, { network: 'xrp-ledger-devnet' })!;
const offer42 = world.offer({ Sequence: 42 });

describe('TRADE-04C-S1 mutation — the delegated signer’s authorization chain', () => {
  const mutants: readonly Mutant<AuthorizationModule>[] = [
    {
      id: 'skip-signature-verification',
      file: AUTHORIZATION,
      replacements: [['input.verifier.verifyDelegatedOfferCapability(capability, input.authorization.signature)', '({ verified: true, keyId: capability.issuerKeyId })']],
      guard: (m) => refuses(m, capabilityFor(world, offer, { key: AUTHORITY_KEY_UNTRUSTED, capability: { issuerKeyId: AUTHORITY_KEY_A.keyId } })),
    },
    {
      id: 'skip-issuer-pin',
      file: AUTHORIZATION,
      replacements: [['!input.issuerKeyIds.includes(verification.keyId) || ', '']],
      guard: (m) => refuses(m, capabilityFor(world, offer, { key: AUTHORITY_KEY_B }), offer, { trusted: [AUTHORITY_KEY_A, AUTHORITY_KEY_B], pinned: [AUTHORITY_KEY_A.keyId] }),
    },
    {
      id: 'skip-issuer-named-equals-signer',
      file: AUTHORIZATION,
      replacements: [[' || verification.keyId !== capability.issuerKeyId', '']],
      guard: (m) => refuses(m, capabilityFor(world, offer, { capability: { issuerKeyId: AUTHORITY_KEY_B.keyId } }), offer, { trusted: [AUTHORITY_KEY_A, AUTHORITY_KEY_B], pinned: [AUTHORITY_KEY_A.keyId, AUTHORITY_KEY_B.keyId] }),
    },
    {
      id: 'skip-expiry',
      file: AUTHORIZATION,
      replacements: [["if (!(input.now < Date.parse(capability.expiresAt)))\n        return refuse('CAPABILITY_EXPIRED');", '']],
      guard: (m) => refuses(m, capabilityFor(world, offer, { now: Date.now() - 90_000, lifetimeMs: 60_000 })),
    },
    {
      id: 'skip-not-yet-valid',
      file: AUTHORIZATION,
      replacements: [["return refuse('CAPABILITY_NOT_YET_VALID');", ';']],
      guard: (m) => refuses(m, capabilityFor(world, offer, { now: Date.now() + 60_000 })),
    },
    {
      id: 'skip-trust-domain',
      file: AUTHORIZATION,
      replacements: [[' || capability.trustDomain !== pin.trustDomain', '']],
      guard: (m) => refuses(m, capabilityFor(world, offer, { capability: { trustDomain: 'trust-domain-other' } })),
    },
    {
      id: 'skip-organization',
      file: AUTHORIZATION,
      replacements: [[' || capability.organizationId !== pin.organizationId', '']],
      guard: (m) => refuses(m, capabilityFor(world, offer, { capability: { organizationId: 'org-other' } })),
    },
    {
      id: 'skip-network',
      file: AUTHORIZATION,
      replacements: [["if (capability.network !== pin.network)\n        return 'CAPABILITY_NETWORK_MISMATCH';", '']],
      guard: (m) => refuses(m, capabilityFor(world, offer, { network: 'xrp-ledger-devnet', proposal: devnetProposal })),
    },
    {
      id: 'skip-pair',
      file: AUTHORIZATION,
      replacements: [['capability.ownerAccount !== pin.pair.ownerAccount ||\n        capability.delegateAccount !== pin.pair.delegateAccount ||\n        transaction.Account !== capability.ownerAccount ||\n        transaction.Delegate !== capability.delegateAccount', 'false']],
      guard: (m) => refuses(m, capabilityFor(world, offer, { capability: { ownerAccount: offerWorld().owner, delegateAccount: offerWorld().delegate.address } })),
    },
    {
      id: 'skip-signing-preimage',
      file: AUTHORIZATION,
      replacements: [['delegatedOfferSigningPreimageDigest(transaction, pin.pair.signingPublicKey) !== capability.signingPreimageDigest ||', '']],
      // Every other link agrees with offer42; only the preimage names the Sequence-41 transaction.
      guard: (m) => refuses(m, capabilityFor(world, offer, { capability: { sequence: 42 } }), offer42),
    },
    {
      id: 'skip-sequence',
      file: AUTHORIZATION,
      replacements: [['transaction.Sequence !== capability.sequence ||', '']],
      guard: (m) => refuses(m, capabilityFor(world, offer42, { capability: { sequence: 41 } }), offer42),
    },
    {
      id: 'skip-fee',
      file: AUTHORIZATION,
      replacements: [['transaction.Fee !== capability.fee ||', '']],
      guard: (m) => refuses(m, capabilityFor(world, offer, { capability: { fee: '13' } })),
    },
    {
      id: 'skip-last-ledger-sequence',
      file: AUTHORIZATION,
      replacements: [['transaction.LastLedgerSequence !== capability.lastLedgerSequence', 'false']],
      guard: (m) => refuses(m, capabilityFor(world, offer, { capability: { lastLedgerSequence: 1_021 } })),
    },
    {
      id: 'skip-proposal-digest',
      file: AUTHORIZATION,
      replacements: [['validation.accepted.digest !== capability.proposalDigest || ', '']],
      guard: (m) => refuses(m, { ...capabilityFor(world, offer), proposal: otherProposalSameTerms }),
    },
    {
      id: 'skip-proposal-network',
      file: AUTHORIZATION,
      replacements: [[' || validation.accepted.proposal.network !== capability.network', '']],
      guard: (m) => refuses(m, capabilityFor(world, offer, { proposal: devnetProposal })),
    },
    {
      id: 'skip-proposal-terms',
      file: AUTHORIZATION,
      replacements: [["if (!sameDelegatedOffer(granted, transaction))\n        return 'CAPABILITY_TERMS_MISMATCH';", '']],
      guard: (m) => refuses(m, capabilityFor(world, offer, { proposal: proposalForOffer(world.offer({ TakerGets: '26000000' }))! })),
    },
  ];
  for (const mutant of mutants) it(`detected: ${mutant.id}`, () => qualify(mutant));
  it('control: a valid capability authorizes under the shipped module', () => {
    assert.equal(refuses(load(join(ROOT, AUTHORIZATION)) as AuthorizationModule, capabilityFor(world, offer)), false);
  });
});

// ── The reference signer and its consumption ledger ─────────────────────────

type ReferenceModule = typeof import('../xrpl-trade-rail/reference/reference-delegated-offer-signer.js');
const REFERENCE = join('xrpl-trade-rail', 'reference', 'reference-delegated-offer-signer.js');
const CREDENTIAL = 'trade04c-s1-mutation-credential-0123456789';
const serviceOf = (m: ReferenceModule) => m.createReferenceDelegatedOfferSignerService({ ...s1ReferenceOptions(), signerId: 's1-mut', network: 'xrp-ledger-testnet', credential: CREDENTIAL, keys: [{ ownerAccount: world.owner, delegateSeed: world.delegate.seed }], maximumFeeDrops: '100' });
let requestCounter = 0;
const post = (service: ReturnType<typeof serviceOf>, authorized: Pick<Authorized, 'proposal' | 'authorization'>): number =>
  service.answer({
    method: 'POST',
    path: '/v1/sign/xrpl-delegated-offer',
    authorization: `Bearer ${CREDENTIAL}`,
    contentType: 'application/json',
    body: Buffer.from(JSON.stringify({ protocol: DELEGATED_OFFER_SIGNER_PROTOCOL, signerId: 's1-mut', requestId: (requestCounter += 1).toString(16).padStart(64, '0'), network: 'xrp-ledger-testnet', ownerAccount: world.owner, delegateAccount: world.delegate.address, transaction: offer, proposal: authorized.proposal, authorization: authorized.authorization })),
  }).status;

type LedgerModule = typeof import('../xrpl-trade-rail/reference/reference-capability-ledger.js');
const LEDGER = join('xrpl-trade-rail', 'reference', 'reference-capability-ledger.js');
const entry = (capabilityId: string, executionId: string) => ({ capabilityId, executionId, boundedGrantId: 'grant-m', signingPreimageDigest: `sha256:${'1'.repeat(64)}`, expiresAt: new Date(Date.now() + 30_000).toISOString() });
async function withLedger(m: LedgerModule, run: (ledger: Awaited<ReturnType<LedgerModule['openReferenceCapabilityLedger']>>) => boolean): Promise<boolean> {
  const space = await tempCapabilityLedger();
  space.ledger.close();
  rmSync(space.path, { force: true });
  const ledger = await m.openReferenceCapabilityLedger(space.path, { create: true });
  try {
    return run(ledger);
  } finally {
    ledger.close();
    space.cleanup();
  }
}

describe('TRADE-04C-S1 mutation — the reference signer and its durable consumption', () => {
  it('detected: sign-without-authorization (the verified capability is not required)', () =>
    qualify<ReferenceModule>({
      id: 'sign-without-authorization',
      file: REFERENCE,
      replacements: [['if (!authorized.authorized)\n            return authorizationRefusal(authorized.failure);\n        const capability = authorized.capability;', 'const capability = authorized.authorized ? authorized.capability : JSON.parse(request.authorization.capability);']],
      guard: (m) => post(serviceOf(m), capabilityFor(world, offer, { key: AUTHORITY_KEY_UNTRUSTED })) === 422,
    }));
  it('detected: ignore-consumption (a consumed capability signs again)', () =>
    qualify<ReferenceModule>({
      id: 'ignore-consumption',
      file: REFERENCE,
      replacements: [["if (consumed !== 'consumed')\n            return refusal(409, consumed);", '']],
      guard: (m) => {
        const service = serviceOf(m);
        const authorized = capabilityFor(world, offer);
        return post(service, authorized) === 200 && post(service, authorized) === 409;
      },
    }));
  it('detected: no-single-use-ledger (every uniqueness check and constraint removed: a replay is recorded twice)', () =>
    qualify<LedgerModule>({
      id: 'no-single-use',
      file: LEDGER,
      replacements: [
        ["if (selectCapability.get(entry.capabilityId) !== undefined)\n            return 'capability-consumed';", ''],
        ["if (selectExecution.get(entry.executionId) !== undefined)\n            return 'execution-consumed';", ''],
        ['capability_id TEXT PRIMARY KEY,', 'capability_id TEXT,'],
        ['execution_id TEXT NOT NULL UNIQUE,', 'execution_id TEXT NOT NULL,'],
      ],
      guard: (m) => withLedger(m, (ledger) => ledger.consume(entry('ab'.repeat(32), 'exec-m'), 'now') === 'consumed' && ledger.consume(entry('ab'.repeat(32), 'exec-m'), 'now') !== 'consumed'),
    }));
  it('detected: no-execution-uniqueness (a second capability for a consumed execution is accepted)', () =>
    qualify<LedgerModule>({
      id: 'no-execution-uniqueness',
      file: LEDGER,
      replacements: [
        ["if (selectExecution.get(entry.executionId) !== undefined)\n            return 'execution-consumed';", ''],
        ['execution_id TEXT NOT NULL UNIQUE,', 'execution_id TEXT NOT NULL,'],
      ],
      guard: (m) => withLedger(m, (ledger) => ledger.consume(entry('ab'.repeat(32), 'exec-m'), 'now') === 'consumed' && ledger.consume(entry('cd'.repeat(32), 'exec-m'), 'now') === 'execution-consumed'),
    }));
});

// ── The Host-side client ────────────────────────────────────────────────────

type ClientModule = typeof import('../xrpl-trade-rail/delegated-offer-signer.js');
const CLIENT = join('xrpl-trade-rail', 'delegated-offer-signer.js');
const pinned = signerAuthorization();
const identity = { protocol: DELEGATED_OFFER_SIGNER_PROTOCOL, signerId: 's1-mut', operations: ['sign-xrpl-delegated-offer'], network: 'xrp-ledger-testnet', pairs: [world.pair], authorization: { trustDomain: pinned.trustDomain, organizationId: pinned.organizationId, issuerKeyIds: [AUTHORITY_KEY_A.keyId] } };
function transportOf(answerCapabilityId?: string): DelegatedOfferSignerTransport & { signs: number } {
  const transport = {
    signs: 0,
    identity: async () => identity,
    signDelegatedOffer: async (request: { readonly requestId: string; readonly transaction: PreparedDelegatedOffer; readonly authorization: { readonly capability: string } }) => {
      transport.signs += 1;
      const signed = world.delegate.sign({ ...request.transaction });
      const capabilityId = answerCapabilityId ?? (JSON.parse(request.authorization.capability) as { capabilityId: string }).capabilityId;
      return { protocol: DELEGATED_OFFER_SIGNER_PROTOCOL, signerId: 's1-mut', requestId: request.requestId, capabilityId, ownerAccount: world.owner, delegateAccount: world.delegate.address, signedTransaction: signed.blob, hash: signed.hash };
    },
  };
  return transport;
}
const clientOf = (m: ClientModule, transport: DelegatedOfferSignerTransport) => m.createDelegatedOfferSigner({ transport, pin: { signerId: 's1-mut', network: 'xrp-ledger-testnet', pairs: [world.pair] }, timeoutMs: 1_000, maximumFeeDrops: '100', maximumLedgerHorizon: 40, probeIntervalMs: 0 });
const refusedAsync = (promise: Promise<unknown>): Promise<boolean> => promise.then(() => false, () => true);

describe('TRADE-04C-S1 mutation — the Host-side client', () => {
  it('detected: send-unbound-capability (a capability for another transaction reaches the signer)', () =>
    qualify<ClientModule>({
      id: 'send-unbound-capability',
      file: CLIENT,
      replacements: [[") !== undefined) {\n            return refuse('OFFER_SIGNER_REQUEST_INVALID', 'The capability is not bound", ") === 'never') {\n            return refuse('OFFER_SIGNER_REQUEST_INVALID', 'The capability is not bound"]],
      guard: async (m) => {
        const transport = transportOf();
        const input = { ...authorizedInput(world, offer, 1_000), authorization: capabilityFor(world, world.offer({ TakerGets: '26000000' })).authorization };
        await refusedAsync(clientOf(m, transport).signDelegatedOffer(input));
        return transport.signs === 0;
      },
    }));
  it('detected: accept-answer-for-another-capability', () =>
    qualify<ClientModule>({
      id: 'accept-answer-for-another-capability',
      file: CLIENT,
      replacements: [['response.capabilityId !== capability.capabilityId || ', '']],
      guard: (m) => refusedAsync(clientOf(m, transportOf('ee'.repeat(32))).signDelegatedOffer(authorizedInput(world, offer, 1_000))),
    }));
});

// ── The executor ────────────────────────────────────────────────────────────

type ExecutorModule = typeof import('../xrpl-trade-execution/trade-offer-executor.js');
const EXECUTOR = join('xrpl-trade-execution', 'trade-offer-executor.js');
async function withExecutor(m: ExecutorModule, options: Parameters<typeof executorRig>[0], run: (rig: ExecutorRig) => Promise<boolean>): Promise<boolean> {
  const rig = await executorRig({ ...options, create: m.createTradeOfferExecutionAdapter });
  try {
    return await run(rig);
  } finally {
    await rig.close();
  }
}
const orderOf = (rig: ExecutorRig) => {
  const raw = rawProposal(rig.pairs[0]!);
  rig.book.attest(raw);
  return validatedAction(raw);
};

describe('TRADE-04C-S1 mutation — the executor', () => {
  it('detected: use-a-capability-for-another-execution (the issued capability’s identity is not checked before signing)', () =>
    qualify<ExecutorModule>({
      id: 'use-capability-for-another-execution',
      file: EXECUTOR,
      replacements: [['if (issued.capability.executionId !== executionId || issued.capability.boundedGrantId !== action.boundedGrantId || issued.capability.signingPreimageDigest !== signingPreimageDigest)', 'if (false)']],
      guard: (m) => {
        const inner = testCapabilityIssuer();
        return withExecutor(m, { issuer: { issue: (input) => inner.issue({ ...input, executionId: 'exec-other' }) } }, async (rig) => {
          await rig.adapter.execute(orderOf(rig));
          return rig.signer.signatures() === 0;
        });
      },
    }));
  it('detected: accept-a-signature-under-another-capability', () =>
    qualify<ExecutorModule>({
      id: 'accept-signature-under-another-capability',
      file: EXECUTOR,
      replacements: [['signature.capabilityId !== issued.capability.capabilityId ||', '']],
      guard: (m) =>
        withExecutor(m, {}, async (rig) => {
          const original = rig.signerClient.signDelegatedOffer;
          const tampering = { signDelegatedOffer: async (input: Parameters<typeof original>[0]) => ({ ...(await original(input)), capabilityId: 'ee'.repeat(32) }) };
          const { executorConfiguration, NETWORK_ID } = await import('./trade04c-execution-fixture.js');
          const adapter = m.createTradeOfferExecutionAdapter({ configuration: executorConfiguration(rig.pairs), attested: rig.book, signer: tampering, authorization: { trustDomain: S1_TRUST_DOMAIN, issuer: rig.issuer }, ledger: rig.ledger.client(NETWORK_ID, rig.interlock), interlock: rig.interlock, ledgerProvenance: 'injected-ledger-client', simulation: 'simulated-facts-offline-qualification-only' });
          await adapter.readiness();
          rig.ledger.passQuarantine();
          await adapter.execute(orderOf(rig));
          return rig.ledger.submitCalls.length === 0;
        }),
    }));
});

// ── The CORE-02 issuance rule ───────────────────────────────────────────────

type CapabilityModule = typeof import('../authority-authenticity/delegated-offer-capability.js');
const CAPABILITY = join('authority-authenticity', 'delegated-offer-capability.js');
const STORE = 'grant-store-s1-mutation';
async function issuable(m: CapabilityModule, options: { readonly grantKey?: typeof AUTHORITY_KEY_A; readonly capability?: Record<string, unknown>; readonly grant?: Parameters<typeof tradeGrantFor>[1] } = {}): Promise<boolean> {
  const authorized = capabilityFor(world, offer);
  const grant = tradeGrantFor(authorized.proposal, options.grant);
  const grantSignature = await testSigner(options.grantKey ?? AUTHORITY_KEY_A).signGrant(grant, STORE);
  const capability = { ...authorized.capability, issuerKeyId: AUTHORITY_KEY_A.keyId, grantStoreId: STORE, boundedGrantId: grant.id, grantDigest: grant.digest, ...options.capability };
  return m.assessDelegatedOfferCapabilityIssuance({ capability: capability as never, grant, storeId: STORE, grantSignature }, { verifyGrant: testVerifier([AUTHORITY_KEY_A, AUTHORITY_KEY_B]).verifyGrant, activeKeyId: AUTHORITY_KEY_A.keyId, now: Date.now() }).issuable;
}

describe('TRADE-04C-S1 mutation — the custody issuance rule (no free capability oracle)', () => {
  const mutants: readonly Mutant<CapabilityModule>[] = [
    { id: 'skip-grant-signature', file: CAPABILITY, replacements: [["if (!verification.verified || verification.keyId !== context.activeKeyId)\n        return refuse('GRANT_SIGNATURE_INVALID');", '']], guard: async (m) => !(await issuable(m, { grantKey: AUTHORITY_KEY_B })) },
    { id: 'skip-proposal-token', file: CAPABILITY, replacements: [['exactToken(grant, exports.DELEGATED_OFFER_GRANT_DIMENSIONS.proposalDigest) !== capability.proposalDigest ||', '']], guard: async (m) => !(await issuable(m, { capability: { proposalDigest: `sha256:${'7'.repeat(64)}` } })) },
    { id: 'skip-organization', file: CAPABILITY, replacements: [["if (organization?.kind !== 'identity' || organization.value !== capability.organizationId)\n        return refuse('GRANT_ORGANIZATION_MISMATCH');", '']], guard: async (m) => !(await issuable(m, { capability: { organizationId: 'org-other' } })) },
    { id: 'skip-owner-resource', file: CAPABILITY, replacements: [["return refuse('GRANT_RESOURCE_MISMATCH');", ';']], guard: async (m) => !(await issuable(m, { capability: { ownerAccount: offerWorld().owner } })) },
    {
      id: 'skip-maximum-lifetime',
      file: CAPABILITY,
      replacements: [['expiresAt - issuedAt > L.maximumLifetimeMs ||', '']],
      guard: async (m) => !(await issuable(m, { capability: { expiresAt: new Date(Date.now() + 61_000).toISOString() } })),
    },
    {
      id: 'skip-not-past-grant',
      file: CAPABILITY,
      replacements: [['expiresAt > grantExpiresAt ||', '']],
      guard: async (m) => !(await issuable(m, { grant: { expiresAt: new Date(Date.now() + 5_000).toISOString() } })),
    },
  ];
  for (const mutant of mutants) it(`detected: ${mutant.id}`, () => qualify(mutant));
  it('control: a capability for its own grant is issuable under the shipped rule', async () => {
    assert.equal(await issuable(load(join(ROOT, CAPABILITY)) as CapabilityModule), true);
  });
});
