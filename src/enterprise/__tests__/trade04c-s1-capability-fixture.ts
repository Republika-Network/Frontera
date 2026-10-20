import { createHash, createPrivateKey, randomBytes, sign as cryptoSign } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { GRANT_SEMANTICS_FORMAT_V1, boundedGrantDigest, boundedGrantId, type BoundedGrant, type GrantScope } from '../../features/grant-runtime/index.js';
import { TRADE_OFFER_FLAGS, validateTradeProposal, type TradeOfferFlag, type TradeProposal } from '../../features/trade-runtime/index.js';
import {
  AUTHORITY_ARTIFACT_VERSION,
  DELEGATED_OFFER_CAPABILITY_FORMAT,
  DELEGATED_OFFER_CAPABILITY_OPERATION,
  delegatedOfferCapabilitySigningBytes,
  serializeDelegatedOfferCapability,
  type AuthoritySignature,
  type DelegatedOfferCapability,
  type DelegatedOfferCapabilityIssuanceInput,
  type DelegatedOfferCapabilityIssuer,
  type IssuedDelegatedOfferCapability,
  type TrustedVerificationKey,
} from '../authority-authenticity/index.js';
import { delegatedOfferSigningPreimageDigest, type DelegatedOfferAuthorization, type PreparedDelegatedOffer } from '../xrpl-trade-rail/index.js';
import { openReferenceCapabilityLedger, type ReferenceCapabilityLedger, type ReferenceCapabilityState } from '../xrpl-trade-rail/reference/reference-capability-ledger.js';
import { AUTHORITY_KEY_A, trustedKeyOf, type TestAuthorityKey } from './authority-authenticity-fixture.js';
import type { OfferWorld } from './trade04b-xrpl-fixture.js';

/**
 * TRADE-04C-S1 qualification fixtures — test-only, offline.
 *
 * - `capabilityFor` builds a CORE-02 delegated-offer capability for an offer
 *   and signs it **directly** with a test authority key — bypassing the
 *   custody issuance rule on purpose: the delegated signer's checks are what
 *   these tests qualify, so they need well-formed capabilities (and forged,
 *   expired, foreign, mis-bound ones) without a grant store. The issuance rule
 *   itself is qualified separately, over real signed grants
 *   (`trade04c-s1-capability.test.ts`).
 * - `memoryCapabilityLedger` is an in-process double of the reference
 *   signer's consumption ledger for unit tests that build the service
 *   in-process. Durability, restarts and cross-process competition are
 *   qualified against the real SQLite ledger (`tempCapabilityLedger`) and a
 *   separate signer process.
 */

export const S1_TRUST_DOMAIN = 'trust-domain-trade04c-s1';
export const S1_ORGANIZATION = 'org-trade04c-s1';
export const S1_ISSUER: TestAuthorityKey = AUTHORITY_KEY_A;
export const S1_NETWORK = 'xrp-ledger-testnet' as const;

const FLAG_NAMES = Object.entries(TRADE_OFFER_FLAGS) as [TradeOfferFlag, number][];

/** The canonical TRADE-01 proposal whose order `offer` is (undefined when no proposal can express it). */
export function proposalForOffer(offer: PreparedDelegatedOffer, options: { readonly network?: typeof S1_NETWORK | 'xrp-ledger-devnet'; readonly organizationId?: string } = {}): TradeProposal | undefined {
  const amount = (value: unknown): Record<string, unknown> => (typeof value === 'string' ? { currency: 'XRP', drops: value } : { ...(value as Record<string, unknown>) });
  const raw = {
    schema: 'frontera.trade-proposal.v1',
    organizationId: options.organizationId ?? S1_ORGANIZATION,
    principalId: 'principal-trade04c-s1',
    requestId: 'req-trade04c-s1',
    idempotencyKey: `idem-trade04c-s1-${randomBytes(4).toString('hex')}`,
    network: options.network ?? S1_NETWORK,
    ownerAccount: offer.Account,
    delegateAccount: offer.Delegate,
    permission: 'OfferCreate',
    takerGets: amount(offer.TakerGets),
    takerPays: amount(offer.TakerPays),
    flags: typeof offer.Flags === 'number' ? FLAG_NAMES.filter(([, bit]) => (offer.Flags & bit) !== 0).map(([name]) => name) : [],
    ...(offer.Expiration !== undefined ? { expiration: offer.Expiration } : {}),
    requestedValiditySeconds: 60,
  };
  const validation = validateTradeProposal(raw);
  return validation.valid ? validation.accepted.proposal : undefined;
}

/** A detached CORE-02 signature over a capability, by `key` — the same bytes and envelope the authority signer produces. */
export function signCapability(capability: DelegatedOfferCapability, key: TestAuthorityKey = S1_ISSUER, keyId: string = key.keyId): AuthoritySignature {
  const signature = cryptoSign(null, delegatedOfferCapabilitySigningBytes(capability), createPrivateKey(key.privateKeyPem));
  return { algorithm: 'ed25519-v1', keyId, signature: signature.toString('base64url'), artifactVersion: AUTHORITY_ARTIFACT_VERSION };
}

export interface CapabilityOptions {
  readonly key?: TestAuthorityKey;
  readonly now?: number;
  readonly lifetimeMs?: number;
  readonly proposal?: TradeProposal;
  /** Fields to override in the capability before it is signed. */
  readonly capability?: Partial<Record<keyof DelegatedOfferCapability, unknown>>;
  readonly network?: typeof S1_NETWORK | 'xrp-ledger-devnet';
}

export interface Authorized {
  readonly capability: DelegatedOfferCapability;
  readonly proposal: TradeProposal;
  readonly authorization: DelegatedOfferAuthorization;
}

/** A signed capability authorizing exactly `offer` (signed by `options.key`, default the pinned issuer). */
export function capabilityFor(world: OfferWorld, offer: PreparedDelegatedOffer, options: CapabilityOptions = {}): Authorized {
  const proposal = options.proposal ?? proposalForOffer(offer, { ...(options.network !== undefined ? { network: options.network } : {}) });
  if (proposal === undefined) throw new Error('no proposal expresses this offer');
  const validation = validateTradeProposal(proposal);
  if (!validation.valid) throw new Error('invalid proposal');
  const key = options.key ?? S1_ISSUER;
  const now = options.now ?? Date.now();
  const capability = {
    format: DELEGATED_OFFER_CAPABILITY_FORMAT,
    operation: DELEGATED_OFFER_CAPABILITY_OPERATION,
    capabilityId: randomBytes(32).toString('hex'),
    issuerKeyId: key.keyId,
    organizationId: S1_ORGANIZATION,
    trustDomain: S1_TRUST_DOMAIN,
    grantStoreId: 'grant-store-trade04c-s1',
    executionId: `exec-trade04c-s1-${randomBytes(6).toString('hex')}`,
    boundedGrantId: `grant-trade04c-s1-${randomBytes(6).toString('hex')}`,
    grantDigest: `sha256:${randomBytes(32).toString('hex')}`,
    proposalDigest: validation.accepted.digest,
    signingPreimageDigest: delegatedOfferSigningPreimageDigest(offer, world.pair.signingPublicKey) ?? `sha256:${'00'.repeat(32)}`,
    network: options.network ?? S1_NETWORK,
    ownerAccount: offer.Account,
    delegateAccount: offer.Delegate,
    sequence: offer.Sequence,
    fee: offer.Fee,
    lastLedgerSequence: offer.LastLedgerSequence,
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + (options.lifetimeMs ?? 30_000)).toISOString(),
    ...options.capability,
  } as DelegatedOfferCapability;
  return Object.freeze({ capability, proposal: validation.accepted.proposal, authorization: Object.freeze({ capability: serializeDelegatedOfferCapability(capability), signature: signCapability(capability, key) }) });
}

/** What a signer pins: the issuer key(s), the trust domain and the organization. */
export function signerAuthorization(
  keys: readonly TestAuthorityKey[] = [S1_ISSUER],
  scope: { readonly trustDomain?: string; readonly organizationId?: string } = {},
): { readonly issuerKeys: readonly TrustedVerificationKey[]; readonly trustDomain: string; readonly organizationId: string } {
  return { issuerKeys: keys.map(trustedKeyOf), trustDomain: scope.trustDomain ?? S1_TRUST_DOMAIN, organizationId: scope.organizationId ?? S1_ORGANIZATION };
}

/**
 * A unit-level capability issuer: it assembles the capability from exactly what the executor asks for and signs it with a test
 * authority key — the custody rule and the grant read are the real issuer's (`createDelegatedOfferCapabilityIssuer`), qualified
 * over real signed grants on the shipped Host. `refuse` makes it answer like an authority that said no.
 */
export function testCapabilityIssuer(options: { readonly key?: TestAuthorityKey; readonly lifetimeMs?: number; readonly now?: () => number; readonly refuse?: () => Error | undefined } = {}): DelegatedOfferCapabilityIssuer & { readonly issued: DelegatedOfferCapability[] } {
  const issued: DelegatedOfferCapability[] = [];
  const key = options.key ?? S1_ISSUER;
  return {
    issued,
    async issue(input: DelegatedOfferCapabilityIssuanceInput): Promise<IssuedDelegatedOfferCapability> {
      const refusal = options.refuse?.();
      if (refusal !== undefined) throw refusal;
      const now = (options.now ?? Date.now)();
      const capability = {
        format: DELEGATED_OFFER_CAPABILITY_FORMAT,
        operation: DELEGATED_OFFER_CAPABILITY_OPERATION,
        capabilityId: randomBytes(32).toString('hex'),
        issuerKeyId: key.keyId,
        organizationId: input.organizationId,
        trustDomain: input.trustDomain,
        grantStoreId: 'grant-store-trade04c-s1',
        executionId: input.executionId,
        boundedGrantId: input.boundedGrantId,
        grantDigest: `sha256:${createHash('sha256').update(input.boundedGrantId).digest('hex')}`,
        proposalDigest: input.proposalDigest,
        signingPreimageDigest: input.signingPreimageDigest,
        network: input.network,
        ownerAccount: input.ownerAccount,
        delegateAccount: input.delegateAccount,
        sequence: input.sequence,
        fee: input.fee,
        lastLedgerSequence: input.lastLedgerSequence,
        issuedAt: new Date(now).toISOString(),
        expiresAt: new Date(now + (options.lifetimeMs ?? 30_000)).toISOString(),
      } as DelegatedOfferCapability;
      issued.push(capability);
      return { capability, canonical: serializeDelegatedOfferCapability(capability), signature: signCapability(capability, key) };
    },
  };
}

/** In-process double of the consumption ledger (unit tests only; durability is qualified on the real file). */
export function memoryCapabilityLedger(): ReferenceCapabilityLedger & { readonly rows: Map<string, { executionId: string; state: ReferenceCapabilityState; transactionHash?: string }> } {
  const rows = new Map<string, { executionId: string; state: ReferenceCapabilityState; transactionHash?: string }>();
  return {
    rows,
    consume(entry) {
      if (rows.has(entry.capabilityId)) return 'capability-consumed';
      if ([...rows.values()].some((row) => row.executionId === entry.executionId)) return 'execution-consumed';
      rows.set(entry.capabilityId, { executionId: entry.executionId, state: 'consumed' });
      return 'consumed';
    },
    markSigned(capabilityId, transactionHash) {
      const row = rows.get(capabilityId);
      if (row?.state === 'consumed') rows.set(capabilityId, { ...row, state: 'signed', transactionHash });
    },
    markFailed(capabilityId) {
      const row = rows.get(capabilityId);
      if (row?.state === 'consumed') rows.set(capabilityId, { ...row, state: 'signing-failed' });
    },
    read(capabilityId) {
      const row = rows.get(capabilityId);
      return row === undefined ? undefined : { state: row.state, ...(row.transactionHash !== undefined ? { transactionHash: row.transactionHash } : {}) };
    },
    inspect(executionId) {
      const found = [...rows.entries()].find(([, row]) => row.executionId === executionId);
      if (found === undefined) return { source: 'customer-signer-ledger', executionId, state: 'absent' };
      const [capabilityId, row] = found;
      if (row.state === 'signed') return { source: 'customer-signer-ledger', executionId, state: 'signed', capabilityId, transactionHash: row.transactionHash! };
      return { source: 'customer-signer-ledger', executionId, state: row.state, capabilityId };
    },
    counts() {
      const out: Record<ReferenceCapabilityState, number> = { consumed: 0, signed: 0, 'signing-failed': 0 };
      for (const row of rows.values()) out[row.state] += 1;
      return out;
    },
    close() {},
  };
}

/** The real SQLite ledger in a fresh temporary directory. */
export async function tempCapabilityLedger(): Promise<{ readonly ledger: ReferenceCapabilityLedger; readonly path: string; readonly dir: string; cleanup(): void }> {
  const dir = mkdtempSync(join(tmpdir(), 'trade04c-s1-ledger-'));
  const path = join(dir, 'capability-ledger.sqlite');
  const ledger = await openReferenceCapabilityLedger(path, { create: true });
  return {
    ledger,
    path,
    dir,
    cleanup() {
      ledger.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** The reference signer options TRADE-04C-S1 added, for an in-process service: a clock, the pinned authorization and a ledger. */
export function s1ReferenceOptions(overrides: { readonly consumption?: ReferenceCapabilityLedger; readonly keys?: readonly TestAuthorityKey[]; readonly clock?: () => number; readonly trustDomain?: string; readonly organizationId?: string } = {}) {
  return {
    clock: overrides.clock ?? (() => Date.now()),
    authorization: signerAuthorization(overrides.keys, { ...(overrides.trustDomain !== undefined ? { trustDomain: overrides.trustDomain } : {}), ...(overrides.organizationId !== undefined ? { organizationId: overrides.organizationId } : {}) }),
    consumption: overrides.consumption ?? memoryCapabilityLedger(),
  };
}

/**
 * A semantically complete trade bounded grant (CORE-03 marker and axes, the TRADE-03 exact tokens), with its own digest — the
 * shape the shipped Host issues for an order. Built directly, so the issuance rule can be qualified field by field.
 */
export function tradeGrantFor(
  proposal: TradeProposal,
  options: { readonly organizationId?: string; readonly issuedAt?: string; readonly expiresAt?: string; readonly scope?: Partial<GrantScope>; readonly parameters?: Readonly<Record<string, string>> } = {},
): BoundedGrant {
  const validation = validateTradeProposal(proposal);
  if (!validation.valid) throw new Error('invalid proposal');
  const tokens: Record<string, string> = {
    tradeProposalDigest: validation.accepted.digest,
    tradeNetwork: proposal.network,
    tradeDelegateAccount: proposal.delegateAccount,
    ...options.parameters,
  };
  const scope: GrantScope = {
    action: { kind: 'identity', value: 'trade.offer-create' },
    actionClass: { kind: 'identity', value: 'place-order' },
    governanceProfile: { kind: 'identity', value: `governed-trading@1#sha256:${'d'.repeat(64)}` },
    organization: { kind: 'identity', value: options.organizationId ?? S1_ORGANIZATION },
    parameters: Object.keys(tokens)
      .sort()
      .map((dimension) => ({ dimension, kind: 'exact' as const, type: 'token' as const, value: tokens[dimension]! })),
    resourceClass: { kind: 'identity', value: 'trading-account' },
    resources: { kind: 'set', values: [`${proposal.network}:${proposal.ownerAccount}`] },
    ...options.scope,
  };
  const correlation = { requestId: 'req-s1', decisionId: 'dec-s1', action: 'trade.offer-create', resourceScope: `${proposal.network}:${proposal.ownerAccount}` };
  const issuedAt = options.issuedAt ?? new Date(Date.now() - 1_000).toISOString();
  const expiresAt = options.expiresAt ?? new Date(Date.now() + 300_000).toISOString();
  const draft = {
    id: boundedGrantId({ correlation, subject: 'actor-s1', scope, expiresAt }),
    correlation,
    subject: 'actor-s1',
    scope,
    issuedAt,
    expiresAt,
    sourceDigest: `sha256:${'e'.repeat(64)}`,
    semanticsFormat: GRANT_SEMANTICS_FORMAT_V1,
  };
  return Object.freeze({ ...draft, digest: boundedGrantDigest(draft) });
}

// ── A real, separate reference delegated-signer process (the shipped launcher) ──

export interface SpawnedOfferSigner {
  readonly endpoint: string;
  readonly identity: Record<string, unknown>;
  stop(): Promise<void>;
}

/**
 * Spawns `scripts/run-reference-xrpl-offer-signer.mjs` (after `npm run build`) as its own process on literal loopback, with its
 * own environment only: the key file, the credential, the pinned authority public key file, trust domain, organization and the
 * consumption ledger path. Waits for its public identity line.
 */
export async function spawnOfferSigner(options: {
  readonly keyFile: string;
  readonly signerId: string;
  readonly credential: string;
  readonly authorityKeyId: string;
  readonly authorityPublicKeyFile: string;
  readonly trustDomain: string;
  readonly organizationId: string;
  readonly ledgerPath: string;
  readonly port?: number;
  readonly maximumFeeDrops?: string;
  /** TRADE-04D: run the launcher's explicit `init-consumption-ledger` first (a new signer). Restarts never pass it. */
  readonly initializeLedger?: boolean;
}): Promise<SpawnedOfferSigner> {
  const { spawn, spawnSync } = await import('node:child_process');
  const script = join(process.cwd(), 'scripts', 'run-reference-xrpl-offer-signer.mjs');
  if (options.initializeLedger === true) {
    const init = spawnSync(process.execPath, [script, 'init-consumption-ledger'], { env: { PATH: process.env['PATH'] ?? '', FRONTERA_REFERENCE_XRPL_OFFER_SIGNER_CONSUMPTION_LEDGER: options.ledgerPath }, encoding: 'utf8' });
    if (init.status !== 0) throw new Error(`init-consumption-ledger failed: ${init.stderr}`);
  }
  const child = spawn(process.execPath, [script], {
    env: {
      PATH: process.env['PATH'] ?? '',
      FRONTERA_REFERENCE_XRPL_OFFER_SIGNER_KEY_FILE: options.keyFile,
      FRONTERA_REFERENCE_XRPL_OFFER_SIGNER_ID: options.signerId,
      FRONTERA_REFERENCE_XRPL_OFFER_SIGNER_TOKEN: options.credential,
      FRONTERA_REFERENCE_XRPL_OFFER_SIGNER_MAX_FEE: options.maximumFeeDrops ?? '1000',
      FRONTERA_REFERENCE_XRPL_OFFER_SIGNER_PORT: String(options.port ?? 0),
      FRONTERA_REFERENCE_XRPL_OFFER_SIGNER_AUTHORITY_KEY_ID: options.authorityKeyId,
      FRONTERA_REFERENCE_XRPL_OFFER_SIGNER_AUTHORITY_PUBLIC_KEY_FILE: options.authorityPublicKeyFile,
      FRONTERA_REFERENCE_XRPL_OFFER_SIGNER_TRUST_DOMAIN: options.trustDomain,
      FRONTERA_REFERENCE_XRPL_OFFER_SIGNER_ORGANIZATION_ID: options.organizationId,
      FRONTERA_REFERENCE_XRPL_OFFER_SIGNER_CONSUMPTION_LEDGER: options.ledgerPath,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const port = await new Promise<number>((resolvePort, reject) => {
    let out = '';
    let err = '';
    const deadline = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`reference offer signer did not start: ${err}`));
      // Generous: a cold Node start under full-suite load on this WSL box can take tens of seconds.
    }, 60_000);
    child.stdout?.on('data', (chunk: Buffer) => {
      out += chunk.toString();
      const match = /listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(out);
      if (match !== null) {
        clearTimeout(deadline);
        resolvePort(Number.parseInt(match[1] as string, 10));
      }
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      err += chunk.toString();
    });
    child.on('exit', (code) => {
      clearTimeout(deadline);
      reject(new Error(`reference offer signer exited (${String(code)}): ${err}`));
    });
  });
  const endpoint = `http://127.0.0.1:${port}`;
  const identity = (await httpJson(`${endpoint}/v1/identity`, 'GET', options.credential)).body as Record<string, unknown>;
  return {
    endpoint,
    identity,
    stop: () =>
      new Promise<void>((resolveStop) => {
        if (child.exitCode !== null) return resolveStop();
        child.once('exit', () => resolveStop());
        child.kill('SIGTERM');
      }),
  };
}

/** One HTTP request to a loopback signer: status and parsed body (the attacker's view, or a test's). */
export async function httpJson(url: string, method: 'GET' | 'POST', credential: string, body?: unknown): Promise<{ readonly status: number; readonly body: unknown }> {
  const { request } = await import('node:http');
  return new Promise((resolveAnswer, reject) => {
    const req = request(url, { method, headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json' } }, (res) => {
      let text = '';
      res.on('data', (chunk: Buffer) => (text += chunk.toString('utf8')));
      res.on('end', () => {
        let parsed: unknown = text;
        try {
          parsed = JSON.parse(text);
        } catch {
          // keep text
        }
        resolveAnswer({ status: res.statusCode ?? 0, body: parsed });
      });
    });
    req.on('error', reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
