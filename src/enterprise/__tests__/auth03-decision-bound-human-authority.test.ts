import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import Database from 'better-sqlite3';

import { ApprovalAuthorityError, type ApprovalCommandPort, type ApprovalRequestView } from '../approval-authority/index.js';
import { HUMAN_PASSKEY_DECISION_CHANNEL, HumanDecisionError, createHumanDecisionChannel, type HumanDecisionChannel, type HumanDecisionErrorCode } from '../approval-authority/human-decision.js';
import { AuthorityStateFreshnessError } from '../authority-state-freshness/errors.js';
import type { AuthorityStateFreshnessBoundary } from '../authority-state-freshness/session.js';
import {
  HUMAN_DECISION_CHALLENGE_FORMAT,
  HumanIdentityError,
  INTENDED_PRODUCTION_RP_ID,
  createHumanIdentityService,
  createRelyingPartyConfiguration,
  humanDecisionChallengeCommitment,
  humanDecisionEvidenceDigest,
  identityAdministratorFor,
  openSqliteHumanIdentityStore,
  webAuthnChallengeOf,
  type HumanIdentityErrorCode,
  type HumanIdentityService,
  type HumanIdentityStore,
  type IdentityAdministrator,
} from '../human-identity/index.js';
import { humanIdentityGenesisDigest, nextHumanIdentityChainDigest } from '../human-identity/chain.js';
import { isOperatorRole, type OperatorRole } from '../operator-control/roles.js';
import { AUTHORITY_KEY_A, AUTHORITY_KEY_B, AUTHORITY_KEY_UNTRUSTED, testSigner, testVerifier } from './authority-authenticity-fixture.js';
import { boundaryFor, startWitness, type StartedWitness } from './core07-freshness-fixture.js';
import {
  CTRL04_OPERATORS,
  ORG,
  PROD,
  assertAwaitingApproval,
  bootCtrl04,
  createWorkspace,
  govern,
  provisionOrganization,
  release,
  releaseKey,
  type BootedCtrl04,
  type Organization,
} from './ctrl04-host-fixture.js';
import { SoftwareAuthenticator } from './auth02-software-authenticator.js';

/**
 * AUTH-03 — decision-bound human authority.
 *
 * A human's passkey approves or rejects one exact CORE-05 subject. Every
 * ceremony is verified by the production path (`@simplewebauthn/server`,
 * driven by the spec-faithful software authenticator); every verdict is
 * recorded by the canonical shipped Host's CORE-05 command port
 * (`host.enterprise.approvals`), which still judges Kernel-Authority standing,
 * segregation of duties, duplicates, expiry and quorum. The human identity
 * store is signed by the authority key and anchored at a CORE-07 witness.
 *
 * In-process only, one Host process: no route exists (AUTH-04).
 */

const ORIGIN = `https://${INTENDED_PRODUCTION_RP_ID}`;
const RP = createRelyingPartyConfiguration({ rpId: INTENDED_PRODUCTION_RP_ID, rpName: 'Frontera Authority', allowedOrigins: [ORIGIN] });
const OPERATOR_IDS = CTRL04_OPERATORS.map((operator) => operator.operatorId);
const roleOf = (operatorId: string): OperatorRole | undefined => {
  const role = CTRL04_OPERATORS.find((operator) => operator.operatorId === operatorId)?.role;
  return isOperatorRole(role) ? role : undefined;
};

class Clock {
  private ms = Date.now();
  now = (): Date => new Date(this.ms);
  iso = (): string => this.now().toISOString();
  advance(seconds: number): void {
    this.ms += seconds * 1000;
  }
}

const directories: string[] = [];
const stores: HumanIdentityStore[] = [];
const witnesses: StartedWitness[] = [];
const scratch = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'frontera-auth03-'));
  directories.push(dir);
  return dir;
};
after(async () => {
  for (const store of stores.splice(0)) {
    try {
      store.close();
    } catch {
      // already closed by its test
    }
  }
  for (const witness of witnesses.splice(0)) await witness.close().catch(() => {});
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const device = (): SoftwareAuthenticator => new SoftwareAuthenticator({ origin: ORIGIN });
const digest = (fill: string): string => `sha256:${fill.repeat(64)}`;

async function identityRefused(code: HumanIdentityErrorCode, run: () => unknown): Promise<void> {
  await assert.rejects(
    async () => {
      await run();
    },
    (error: unknown) => (error instanceof HumanIdentityError && error.code === code) || assert.fail(`expected ${code}, got ${String((error as { code?: unknown }).code)}: ${(error as Error).message}`),
  );
}

async function decisionRefused(code: HumanDecisionErrorCode, run: () => unknown): Promise<void> {
  await assert.rejects(
    async () => {
      await run();
    },
    (error: unknown) => (error instanceof HumanDecisionError && error.code === code) || assert.fail(`expected ${code}, got ${String((error as { code?: unknown }).code)}: ${(error as Error).message}`),
  );
}

interface Identity {
  readonly path: string;
  readonly clock: Clock;
  readonly store: HumanIdentityStore;
  readonly service: HumanIdentityService;
  readonly admin: IdentityAdministrator;
  readonly reopen: () => Promise<Identity>;
}

/** A signed human identity store (and, with `witness`, anchored at it) and its service. */
async function identity(options: { readonly path?: string; readonly witness?: StartedWitness; readonly create?: boolean; readonly clock?: Clock; readonly signer?: ReturnType<typeof testSigner>; readonly verifier?: ReturnType<typeof testVerifier> } = {}): Promise<Identity> {
  const path = options.path ?? join(scratch(), 'identity', 'human-identity.sqlite');
  const clock = options.clock ?? new Clock();
  const boundary: AuthorityStateFreshnessBoundary | undefined = options.witness === undefined ? undefined : await boundaryFor(options.witness, ORG);
  const store = await openSqliteHumanIdentityStore(path, {
    organizationId: ORG,
    now: clock.iso,
    authenticity: { signer: options.signer ?? testSigner(), verifier: options.verifier ?? testVerifier() },
    ...((options.create ?? options.path === undefined) ? { create: true } : {}),
    ...(boundary === undefined ? {} : { freshness: { boundary } }),
  });
  stores.push(store);
  const service = createHumanIdentityService({ store, relyingParty: RP, operatorIds: OPERATOR_IDS, now: clock.now });
  const admin = identityAdministratorFor({ plane: 'operator', operatorId: 'ops-admin', organizationId: ORG, role: 'organization-administrator', credentialClass: 'operator', actorRef: 'operator-plane:ops-admin' });
  const self: Identity = {
    path,
    clock,
    store,
    service,
    admin,
    reopen: async () => {
      store.close();
      return identity({ path, clock, create: false, ...(options.witness === undefined ? {} : { witness: options.witness }) });
    },
  };
  return self;
}

async function enrol(w: Identity, authenticator: SoftwareAuthenticator, operatorId: string): Promise<string> {
  if (w.service.principal(operatorId) === undefined) await w.service.createPrincipal(w.admin, { operatorId, displayName: `Human ${operatorId}` });
  const issued = await w.service.authorizeEnrolment(w.admin, operatorId);
  const credential = await w.service.finishRegistration(issued.enrolmentToken, authenticator.register(w.service.beginRegistration(issued.enrolmentToken)));
  return credential.credentialId;
}

const decisionInput = (overrides: Partial<{ operatorId: string; approvalRequestId: string; subjectDigest: string; verdict: 'approve' | 'reject' }> = {}) => ({
  operatorId: 'approver-a',
  approvalRequestId: `approval-request:${'a'.repeat(64)}`,
  subjectDigest: digest('b'),
  verdict: 'approve' as const,
  ...overrides,
});

// ── 1. The decision challenge contract and its verification (identity side) ──────────────

describe('AUTH-03 decision challenge — bound, canonical, short-lived', () => {
  it('binds domain and version, the Host organization, request, subject, verdict, human, a 256-bit nonce and ≤ 120 s; the WebAuthn challenge is the commitment', async () => {
    const w = await identity();
    await enrol(w, device(), 'approver-a');
    const issued = w.service.beginDecision({ ...decisionInput(), organizationId: 'org-attacker' } as ReturnType<typeof decisionInput>);
    const { contract } = issued;
    assert.equal(contract.format, HUMAN_DECISION_CHALLENGE_FORMAT);
    assert.equal(contract.organizationId, ORG, 'the organization is the Host’s own, never a caller’s');
    assert.equal(Buffer.from(contract.nonce, 'base64url').length, 32);
    assert.equal(Date.parse(contract.expiresAt) - Date.parse(contract.issuedAt), 120_000);
    assert.equal(issued.commitment, humanDecisionChallengeCommitment(contract));
    assert.equal(issued.options.challenge, webAuthnChallengeOf(issued.commitment));
    assert.equal(issued.options.userVerification, 'required');
    assert.equal(issued.options.allowCredentials.length, 1, 'only the bound human’s passkeys are offered');
    // Every bound field changes the commitment.
    for (const field of ['organizationId', 'approvalRequestId', 'subjectDigest', 'operatorId', 'nonce', 'issuedAt', 'expiresAt', 'format'] as const) {
      assert.notEqual(humanDecisionChallengeCommitment({ ...contract, [field]: `${contract[field]}x` }), issued.commitment, field);
    }
    assert.notEqual(humanDecisionChallengeCommitment({ ...contract, verdict: 'reject' }), issued.commitment, 'approve and reject are different decisions');
  });

  it('refuses a lifetime above 120 seconds, and malformed decisions', async () => {
    const w = await identity();
    assert.throws(() => createHumanIdentityService({ store: w.store, relyingParty: RP, operatorIds: OPERATOR_IDS, decisionChallengeTtlSeconds: 121 }), (error: unknown) => error instanceof HumanIdentityError && error.code === 'HUMAN_IDENTITY_CONFIGURATION_INVALID');
    await enrol(w, device(), 'approver-a');
    await identityRefused('HUMAN_IDENTITY_CHALLENGE_INVALID', () => w.service.beginDecision(decisionInput({ subjectDigest: 'not-a-digest' })));
    await identityRefused('HUMAN_IDENTITY_CHALLENGE_INVALID', () => w.service.beginDecision({ ...decisionInput(), verdict: 'escalate' } as unknown as ReturnType<typeof decisionInput>));
    await identityRefused('HUMAN_IDENTITY_UNKNOWN_PRINCIPAL', () => w.service.beginDecision(decisionInput({ operatorId: 'approver-b' })));
  });

  it('authorizes once: a verified assertion consumes the challenge and records evidence; the same assertion never authorizes again, even after a restart', async () => {
    const w = await identity();
    const cto = device();
    const credentialId = await enrol(w, cto, 'approver-a');
    const issued = w.service.beginDecision(decisionInput());
    const assertion = cto.assert(issued.options);
    const authorized = await w.service.authorizeDecision(assertion);
    assert.equal(authorized.commitment, issued.commitment);
    assert.equal(authorized.evidence.credentialId, credentialId);
    assert.equal(authorized.evidence.userVerified, true);
    assert.equal(authorized.evidence.origin, ORIGIN);
    assert.equal(authorized.evidenceDigest, humanDecisionEvidenceDigest(authorized.evidence));
    const row = w.store.history().find((candidate) => candidate.kind === 'decision_authorized');
    assert.ok(row !== undefined && row.objectId === issued.commitment);
    await identityRefused('HUMAN_IDENTITY_DECISION_CHALLENGE_CONSUMED', () => w.service.authorizeDecision(assertion));
    await identityRefused('HUMAN_IDENTITY_DECISION_CHALLENGE_CONSUMED', () => w.service.authorizeDecision(cto.assert(issued.options)));
    const restarted = await w.reopen();
    await identityRefused('HUMAN_IDENTITY_DECISION_CHALLENGE_CONSUMED', () => restarted.service.authorizeDecision(assertion));
    assert.equal(restarted.service.decision(issued.commitment)?.state, 'consumed');
  });

  it('an expired challenge is refused and consumes nothing', async () => {
    const w = await identity();
    const cto = device();
    await enrol(w, cto, 'approver-a');
    const issued = w.service.beginDecision(decisionInput());
    w.clock.advance(121);
    const before = w.store.history().length;
    await identityRefused('HUMAN_IDENTITY_CHALLENGE_INVALID', () => w.service.authorizeDecision(cto.assert(issued.options)));
    assert.equal(w.store.history().length, before);
    assert.equal(w.service.decision(issued.commitment)?.state, 'expired');
  });

  for (const [name, code, overrides] of [
    ['a wrong origin', 'HUMAN_IDENTITY_AUTHENTICATION_INVALID', { origin: 'https://evil.example' }],
    ['a wrong RP ID', 'HUMAN_IDENTITY_AUTHENTICATION_INVALID', { rpId: 'evil.example' }],
    ['a cross-origin ceremony', 'HUMAN_IDENTITY_AUTHENTICATION_INVALID', { crossOrigin: true }],
    ['missing user verification', 'HUMAN_IDENTITY_AUTHENTICATION_INVALID', { userVerified: false }],
    ['an invalid signature', 'HUMAN_IDENTITY_AUTHENTICATION_INVALID', { corruptSignature: true }],
    ['a challenge that is no decision challenge', 'HUMAN_IDENTITY_CHALLENGE_INVALID', { challenge: randomBytes(32).toString('base64url') }],
    ['an unknown credential', 'HUMAN_IDENTITY_CREDENTIAL_UNUSABLE', { credentialId: randomBytes(32).toString('base64url') }],
  ] as const) {
    it(`refuses ${name}, consuming nothing`, async () => {
      const w = await identity();
      const cto = device();
      await enrol(w, cto, 'approver-a');
      const issued = w.service.beginDecision(decisionInput());
      const before = w.store.history().length;
      await identityRefused(code, () => w.service.authorizeDecision(cto.assert(issued.options, overrides)));
      assert.equal(w.store.history().length, before, 'nothing was recorded');
      assert.equal((await w.service.authorizeDecision(cto.assert(issued.options))).commitment, issued.commitment, 'the challenge is still usable by the genuine assertion');
    });
  }

  it('another human’s passkey cannot answer a decision bound to the CTO, even with a valid signature', async () => {
    const w = await identity();
    const cto = device();
    const other = device();
    await enrol(w, cto, 'approver-a');
    await enrol(w, other, 'approver-b');
    const issued = w.service.beginDecision(decisionInput());
    await identityRefused('HUMAN_IDENTITY_CREDENTIAL_OWNERSHIP_MISMATCH', () => w.service.authorizeDecision(other.assert(issued.options)));
    await identityRefused('HUMAN_IDENTITY_CREDENTIAL_OWNERSHIP_MISMATCH', () => w.service.authorizeDecision(cto.assert(issued.options, { userHandle: other.userHandle ?? null })));
  });

  it('a revoked passkey, and a revoked human, cannot decide; a challenge issued before revocation is refused after it', async () => {
    const w = await identity();
    const cto = device();
    const credentialId = await enrol(w, cto, 'approver-a');
    const issued = w.service.beginDecision(decisionInput());
    await w.service.revokeCredential(w.admin, credentialId, 'device lost');
    await identityRefused('HUMAN_IDENTITY_CREDENTIAL_UNUSABLE', () => w.service.authorizeDecision(cto.assert(issued.options)));
    const replacement = device();
    await enrol(w, replacement, 'approver-a');
    const second = w.service.beginDecision(decisionInput());
    await w.service.revokePrincipal(w.admin, 'approver-a', 'left');
    await identityRefused('HUMAN_IDENTITY_CREDENTIAL_UNUSABLE', () => w.service.authorizeDecision(replacement.assert(second.options)));
    await identityRefused('HUMAN_IDENTITY_PRINCIPAL_REVOKED', () => w.service.beginDecision(decisionInput()));
  });

  it('ceremonies do not cross: a decision assertion is no login, a login assertion is no decision', async () => {
    const w = await identity();
    const cto = device();
    await enrol(w, cto, 'approver-a');
    const issued = w.service.beginDecision(decisionInput());
    await identityRefused('HUMAN_IDENTITY_CHALLENGE_INVALID', () => w.service.finishAuthentication(cto.assert(issued.options)));
    await identityRefused('HUMAN_IDENTITY_CHALLENGE_INVALID', () => w.service.authorizeDecision(cto.assert(w.service.beginAuthentication())));
  });

  it('a stored contract altered after issuance (verdict, subject, request, human, organization) no longer matches its commitment and is refused', async () => {
    for (const [column, value] of [
      ['verdict', 'reject'],
      ['subject_digest', digest('c')],
      ['approval_request_id', `approval-request:${'d'.repeat(64)}`],
      ['operator_id', 'approver-b'],
      ['organization_id', 'org-other'],
    ] as const) {
      const w = await identity();
      const cto = device();
      await enrol(w, cto, 'approver-a');
      await enrol(w, device(), 'approver-b');
      const issued = w.service.beginDecision(decisionInput());
      const raw = new Database(w.path);
      raw.prepare(`UPDATE human_decision_challenges SET ${column} = ?`).run(value);
      raw.close();
      await identityRefused('HUMAN_IDENTITY_CHALLENGE_INVALID', () => w.service.authorizeDecision(cto.assert(issued.options)));
    }
  });

  it('signing counters: a verified regression is recorded, consumes the challenge, and authorizes nothing', async () => {
    const w = await identity();
    const cto = device();
    await enrol(w, cto, 'approver-a');
    await w.service.authorizeDecision(cto.assert(w.service.beginDecision(decisionInput()).options, { counter: 7 }));
    const issued = w.service.beginDecision(decisionInput({ subjectDigest: digest('e') }));
    await identityRefused('HUMAN_IDENTITY_COUNTER_REGRESSION', () => w.service.authorizeDecision(cto.assert(issued.options, { counter: 7 })));
    assert.equal(w.store.history().filter((row) => row.kind === 'credential_counter_anomaly').length, 1);
    await identityRefused('HUMAN_IDENTITY_CHALLENGE_INVALID', () => w.service.authorizeDecision(cto.assert(issued.options, { counter: 8 })));
    assert.equal(w.service.decision(issued.commitment)?.state, 'issued', 'no decision was authorized');
  });
});

// ── 2. The signed identity state (CORE-02) and its freshness (CORE-07) ─────────────────────

describe('AUTH-03 signed identity state — verified at open and on every read; no unsigned mode', () => {
  it('refuses a signer that does not sign human identity state (external custody until its protocol carries it): no unsigned fallback', async () => {
    const signer = testSigner();
    const { signHumanIdentityState: _omitted, ...withoutOperation } = signer;
    await identityRefused('HUMAN_IDENTITY_STORE_UNSUPPORTED', () =>
      openSqliteHumanIdentityStore(join(scratch(), 'h.sqlite'), { organizationId: ORG, now: () => new Date().toISOString(), create: true, authenticity: { signer: withoutOperation, verifier: testVerifier() } }),
    );
    await identityRefused('HUMAN_IDENTITY_STORE_UNSUPPORTED', () =>
      openSqliteHumanIdentityStore(join(scratch(), 'h.sqlite'), { organizationId: ORG, now: () => new Date().toISOString(), create: true } as unknown as Parameters<typeof openSqliteHumanIdentityStore>[1]),
    );
  });

  it('a consistent rewrite by a database-only writer (a revocation deleted, chain and head recomputed, no key) is refused at read and at open', async () => {
    const w = await identity();
    const credentialId = await enrol(w, device(), 'approver-a');
    await w.service.revokeCredential(w.admin, credentialId, 'device lost');
    const { storeId } = w.store.head();
    // The attacker deletes the revocation and re-chains the remaining history exactly; only the authority key is missing.
    const raw = new Database(w.path);
    raw.exec('DROP TRIGGER human_identity_records_no_delete;');
    raw.prepare("DELETE FROM human_identity_records WHERE kind = 'credential_revoked'").run();
    const digests = (raw.prepare('SELECT row_digest FROM human_identity_records ORDER BY sequence').all() as { row_digest: string }[]).map((row) => row.row_digest);
    const chain = digests.reduce((current, rowDigest) => nextHumanIdentityChainDigest(current, rowDigest), humanIdentityGenesisDigest(storeId, ORG));
    raw.prepare('UPDATE human_identity_head SET sequence = ?, chain_digest = ? WHERE id = 1').run(digests.length, chain);
    raw.close();
    await identityRefused('HUMAN_IDENTITY_STORE_CORRUPT', () => w.store.history());
    w.store.close();
    await identityRefused('HUMAN_IDENTITY_STORE_CORRUPT', () => identity({ path: w.path, clock: w.clock, create: false }));
  });

  it('a head signed by an untrusted key is refused; a head under a trusted, non-active key is re-signed unchanged at open', async () => {
    const w = await identity({ signer: testSigner(AUTHORITY_KEY_UNTRUSTED), verifier: testVerifier([AUTHORITY_KEY_UNTRUSTED]) });
    await enrol(w, device(), 'approver-a');
    w.store.close();
    await identityRefused('HUMAN_IDENTITY_STORE_CORRUPT', () => identity({ path: w.path, clock: w.clock, create: false }));

    const rotated = await identity({ signer: testSigner(AUTHORITY_KEY_A), verifier: testVerifier([AUTHORITY_KEY_A]) });
    await enrol(rotated, device(), 'approver-a');
    const head = rotated.store.head();
    rotated.store.close();
    const reopened = await identity({ path: rotated.path, clock: rotated.clock, create: false, signer: testSigner(AUTHORITY_KEY_B), verifier: testVerifier([AUTHORITY_KEY_A, AUTHORITY_KEY_B]) });
    assert.deepEqual(reopened.store.head(), head);
    reopened.store.close();
    const raw = new Database(rotated.path, { readonly: true });
    const signature = JSON.parse((raw.prepare('SELECT signature_json FROM human_identity_head').get() as { signature_json: string }).signature_json) as { keyId: string };
    raw.close();
    assert.equal(signature.keyId, AUTHORITY_KEY_B.keyId);
    await identity({ path: rotated.path, clock: rotated.clock, create: false, signer: testSigner(AUTHORITY_KEY_B), verifier: testVerifier([AUTHORITY_KEY_B]) });
  });

  it('a v1 (AUTH-02, unsigned) store is refused, never migrated', async () => {
    const w = await identity();
    w.store.close();
    const raw = new Database(w.path);
    raw.prepare('UPDATE human_identity_meta SET schema_version = 1').run();
    raw.close();
    await identityRefused('HUMAN_IDENTITY_STORE_UNSUPPORTED', () => identity({ path: w.path, clock: w.clock, create: false }));
  });
});

describe('AUTH-03 CORE-07 freshness — a restored older identity file is refused at open', () => {
  async function restoredAfter(change: (w: Identity, cto: SoftwareAuthenticator, credentialId: string) => Promise<void>): Promise<{ readonly w: Identity; readonly witness: StartedWitness }> {
    const witness = await startWitness();
    witnesses.push(witness);
    const w = await identity({ witness });
    const cto = device();
    const credentialId = await enrol(w, cto, 'approver-a');
    w.store.close();
    const backup = `${w.path}.backup`;
    copyFileSync(w.path, backup);
    const live = await identity({ path: w.path, clock: w.clock, create: false, witness });
    await change(live, cto, credentialId);
    live.store.close();
    for (const suffix of ['-wal', '-shm']) if (existsSync(`${w.path}${suffix}`)) rmSync(`${w.path}${suffix}`);
    copyFileSync(backup, w.path);
    return { w, witness };
  }

  const rollback = (error: unknown): boolean => error instanceof AuthorityStateFreshnessError && error.code === 'AUTHORITY_FRESHNESS_ROLLBACK_DETECTED';

  it('restoring the file from before a consumed decision (to replay it) is a detected rollback', async () => {
    const { w, witness } = await restoredAfter(async (live, cto) => {
      await live.service.authorizeDecision(cto.assert(live.service.beginDecision(decisionInput()).options));
    });
    await assert.rejects(identity({ path: w.path, clock: w.clock, create: false, witness }), rollback);
  });

  it('restoring the file from before a revocation (to resurrect a passkey) is a detected rollback', async () => {
    const { w, witness } = await restoredAfter(async (live, _cto, credentialId) => {
      await live.service.revokeCredential(live.admin, credentialId, 'device lost');
    });
    await assert.rejects(identity({ path: w.path, clock: w.clock, create: false, witness }), rollback);
  });

  it('SCOPED: without a witness, the same restore is believed — the lenient mode, stated', async () => {
    const w = await identity();
    const cto = device();
    await enrol(w, cto, 'approver-a');
    w.store.close();
    copyFileSync(w.path, `${w.path}.backup`);
    const live = await identity({ path: w.path, clock: w.clock, create: false });
    await live.service.authorizeDecision(cto.assert(live.service.beginDecision(decisionInput()).options));
    live.store.close();
    for (const suffix of ['-wal', '-shm']) if (existsSync(`${w.path}${suffix}`)) rmSync(`${w.path}${suffix}`);
    copyFileSync(`${w.path}.backup`, w.path);
    const restored = await identity({ path: w.path, clock: w.clock, create: false });
    assert.equal(restored.store.history().some((row) => row.kind === 'decision_authorized'), false);
  });
});

// ── 3. CORE-05 integration on the canonical shipped Host ───────────────────────────────────

describe('AUTH-03 CORE-05 integration — a passkey decides one exact subject, and CORE-05 still judges it', () => {
  const workspace = createWorkspace('frontera-auth03-host-');
  let booted: BootedCtrl04;
  let org: Organization;
  let approvals: ApprovalCommandPort;
  let w: Identity;
  let channel: HumanDecisionChannel;
  const humans = new Map<string, SoftwareAuthenticator>();

  before(async () => {
    booted = await bootCtrl04(workspace);
    org = await provisionOrganization(booted.baseUrl);
    const port = booted.host.enterprise.approvals;
    assert.ok(port !== undefined, 'the Host composes the CORE-05 command port');
    approvals = port;
    const witness = await startWitness();
    witnesses.push(witness);
    w = await identity({ witness });
    for (const operatorId of ['approver-a', 'approver-b', 'approver-nostanding', 'approver-self', 'ops-observer', 'ops-responder']) {
      const authenticator = device();
      await enrol(w, authenticator, operatorId);
      humans.set(operatorId, authenticator);
    }
    channel = createHumanDecisionChannel({ organizationId: ORG, approvals, identity: w.service, roleOf });
  });
  after(() => workspace.close());

  const human = (operatorId: string): SoftwareAuthenticator => humans.get(operatorId) ?? assert.fail(operatorId);

  async function pending(credential: string = org.agentCredential): Promise<{ readonly key: string; readonly view: ApprovalRequestView }> {
    const key = releaseKey('auth03');
    const reply = await govern(booted.baseUrl, credential, release(PROD, key));
    assertAwaitingApproval(reply);
    const view = (await approvals.list()).find((candidate) => candidate.requestId === reply.body['requestId']);
    assert.ok(view !== undefined);
    return { key, view };
  }

  const verdictsOf = async (approvalRequestId: string) => ((await approvals.list()).find((view) => view.approvalRequestId === approvalRequestId) ?? assert.fail('missing')).state.verdicts;

  it('the CTO approves with a passkey: CORE-05 records one verdict from the passkey channel citing the decision evidence; the agent then executes exactly once', async () => {
    const { key, view } = await pending();
    const issued = await channel.begin({ operatorId: 'approver-a', approvalRequestId: view.approvalRequestId, subjectDigest: view.subjectDigest, verdict: 'approve' });
    const result = await channel.decide(human('approver-a').assert(issued.options));
    assert.equal(result.outcome, 'recorded');
    if (result.outcome !== 'recorded') return;
    assert.equal(result.approval.state.status, 'approved');
    const [verdict] = result.approval.state.verdicts;
    assert.ok(verdict !== undefined);
    assert.deepEqual(
      { kind: verdict.kind, actorId: verdict.actorId, recordedBy: verdict.recordedBy, counted: verdict.counted, rowDigest: verdict.rowDigest },
      { kind: 'approved', actorId: 'operator:approver-a', recordedBy: HUMAN_PASSKEY_DECISION_CHANNEL, counted: true, rowDigest: result.verdictRowDigest },
    );
    assert.deepEqual(verdict.evidence, [{ type: 'approval_proof', hash: result.evidenceDigest, uri: `${HUMAN_PASSKEY_DECISION_CHANNEL}:${result.commitment}` }]);
    assert.equal(result.evidence.subjectDigest, view.subjectDigest);
    assert.equal(result.evidence.approvalRequestId, view.approvalRequestId);
    assert.equal(result.evidence.verdict, 'approve');
    assert.deepEqual(await channel.outcome(result.commitment).then((status) => status?.state), 'recorded');
    assert.equal(w.service.decision(result.commitment)?.outcome?.outcome, 'recorded');

    const callsBefore = booted.adapter.calls.length;
    const resumed = await govern(booted.baseUrl, org.agentCredential, release(PROD, key));
    assert.equal(resumed.body['status'], 'executed', resumed.text);
    assert.equal(booted.adapter.calls.length, callsBefore + 1, 'executed exactly once');
  });

  it('a passkey rejection closes the request; the agent stays withheld', async () => {
    const { key, view } = await pending();
    const issued = await channel.begin({ operatorId: 'approver-b', approvalRequestId: view.approvalRequestId, subjectDigest: view.subjectDigest, verdict: 'reject' });
    const result = await channel.decide(human('approver-b').assert(issued.options));
    assert.equal(result.outcome, 'recorded');
    if (result.outcome === 'recorded') assert.equal(result.approval.state.status, 'rejected');
    assertAwaitingApproval(await govern(booted.baseUrl, org.agentCredential, release(PROD, key)), 'GOVERNED_ACTION_APPROVAL_REJECTED');
  });

  it('replay of a used decision never reaches CORE-05 again; concurrent submissions of one assertion record exactly one verdict', async () => {
    const { view } = await pending();
    const issued = await channel.begin({ operatorId: 'approver-a', approvalRequestId: view.approvalRequestId, subjectDigest: view.subjectDigest, verdict: 'reject' });
    const assertion = human('approver-a').assert(issued.options);
    const outcomes = await Promise.allSettled([channel.decide(assertion), channel.decide(assertion)]);
    assert.deepEqual(outcomes.map((outcome) => outcome.status).sort(), ['fulfilled', 'rejected']);
    const loser = outcomes.find((outcome) => outcome.status === 'rejected') as PromiseRejectedResult;
    assert.ok(loser.reason instanceof HumanIdentityError || loser.reason instanceof HumanDecisionError, String(loser.reason));
    await assert.rejects(channel.decide(assertion));
    assert.equal((await verdictsOf(view.approvalRequestId)).length, 1);
  });

  it('subject binding: a challenge is issued only for the exact pending subject; a decision for a request no longer pending burns nothing', async () => {
    const { view } = await pending();
    await decisionRefused('HUMAN_DECISION_NOT_APPLICABLE', () => channel.begin({ operatorId: 'approver-a', approvalRequestId: view.approvalRequestId, subjectDigest: digest('0'), verdict: 'approve' }));
    await decisionRefused('HUMAN_DECISION_NOT_APPLICABLE', () => channel.begin({ operatorId: 'approver-a', approvalRequestId: `approval-request:${'9'.repeat(64)}`, subjectDigest: view.subjectDigest, verdict: 'approve' }));
    const issued = await channel.begin({ operatorId: 'approver-a', approvalRequestId: view.approvalRequestId, subjectDigest: view.subjectDigest, verdict: 'approve' });
    // Another approver closes it first.
    const other = await channel.begin({ operatorId: 'approver-b', approvalRequestId: view.approvalRequestId, subjectDigest: view.subjectDigest, verdict: 'reject' });
    assert.equal((await channel.decide(human('approver-b').assert(other.options))).outcome, 'recorded');
    await decisionRefused('HUMAN_DECISION_NOT_APPLICABLE', () => channel.decide(human('approver-a').assert(issued.options)));
    assert.equal(w.service.decision(issued.commitment)?.state, 'issued', 'the refused attempt consumed nothing');
  });

  it('role: an observer reaches neither verdict; a responder may reject but never approve', async () => {
    const { view } = await pending();
    const subject = { approvalRequestId: view.approvalRequestId, subjectDigest: view.subjectDigest };
    await decisionRefused('HUMAN_DECISION_NOT_PERMITTED', () => channel.begin({ operatorId: 'ops-observer', ...subject, verdict: 'approve' }));
    await decisionRefused('HUMAN_DECISION_NOT_PERMITTED', () => channel.begin({ operatorId: 'ops-observer', ...subject, verdict: 'reject' }));
    await decisionRefused('HUMAN_DECISION_NOT_PERMITTED', () => channel.begin({ operatorId: 'ops-responder', ...subject, verdict: 'approve' }));
    // A challenge minted directly against the identity service still cannot pass the channel's role check.
    const minted = w.service.beginDecision({ operatorId: 'ops-observer', ...subject, verdict: 'approve' });
    await decisionRefused('HUMAN_DECISION_NOT_PERMITTED', () => channel.decide(human('ops-observer').assert(minted.options)));
    assert.equal(w.service.decision(minted.commitment)?.state, 'issued');
    assert.equal((await verdictsOf(view.approvalRequestId)).length, 0);
  });

  it('Kernel Authority still decides: a verified passkey without approval standing is refused by CORE-05; nothing counts; the outcome is readable', async () => {
    const { view } = await pending();
    const issued = await channel.begin({ operatorId: 'approver-nostanding', approvalRequestId: view.approvalRequestId, subjectDigest: view.subjectDigest, verdict: 'approve' });
    const result = await channel.decide(human('approver-nostanding').assert(issued.options));
    assert.equal(result.outcome, 'refused');
    if (result.outcome === 'refused') assert.equal(result.code, 'APPROVAL_APPROVER_INELIGIBLE');
    assert.equal((await verdictsOf(view.approvalRequestId)).filter((verdict) => verdict.counted).length, 0);
    assert.equal((await channel.outcome(issued.commitment))?.state, 'refused');
  });

  it('segregation of duties still holds: the requester’s own human cannot approve its own request with a passkey', async () => {
    const { view } = await pending(org.selfCredential);
    const issued = await channel.begin({ operatorId: 'approver-self', approvalRequestId: view.approvalRequestId, subjectDigest: view.subjectDigest, verdict: 'approve' });
    const result = await channel.decide(human('approver-self').assert(issued.options));
    assert.equal(result.outcome, 'refused');
    if (result.outcome === 'refused') assert.equal(result.reasonCode, 'SEGREGATION_OF_DUTIES_VIOLATION');
    assert.equal((await approvals.list()).find((candidate) => candidate.approvalRequestId === view.approvalRequestId)?.state.status, 'pending');
  });

  it('interrupted persistence: a crash after consumption and before CORE-05 leaves zero verdicts and a consumed challenge; a crash after CORE-05 recorded is resolved from CORE-05', async () => {
    const { view } = await pending();
    const crashing: Pick<ApprovalCommandPort, 'list' | 'approve' | 'reject'> = {
      list: () => approvals.list(),
      approve: async () => {
        throw new Error('simulated process crash before the CORE-05 append');
      },
      reject: (context, command) => approvals.reject(context, command),
    };
    const crashed = createHumanDecisionChannel({ organizationId: ORG, approvals: crashing, identity: w.service, roleOf });
    const issued = await crashed.begin({ operatorId: 'approver-a', approvalRequestId: view.approvalRequestId, subjectDigest: view.subjectDigest, verdict: 'approve' });
    const assertion = human('approver-a').assert(issued.options);
    await assert.rejects(crashed.decide(assertion), /simulated process crash/);
    assert.equal((await verdictsOf(view.approvalRequestId)).length, 0, 'no verdict');
    assert.equal((await channel.outcome(issued.commitment))?.state, 'not-recorded');
    await identityRefused('HUMAN_IDENTITY_DECISION_CHALLENGE_CONSUMED', () => channel.decide(assertion));
    assert.equal((await verdictsOf(view.approvalRequestId)).length, 0, 'the replay recorded nothing either');

    // Recorded by CORE-05, but the caller never heard back: the outcome is read from CORE-05, never guessed.
    const lost: Pick<ApprovalCommandPort, 'list' | 'approve' | 'reject'> = {
      list: () => approvals.list(),
      approve: async (context, command) => {
        await approvals.approve(context, command);
        throw new ApprovalAuthorityError('APPROVAL_STORE_CLOSED', 'simulated loss of the reply after the CORE-05 append');
      },
      reject: (context, command) => approvals.reject(context, command),
    };
    const lossy = createHumanDecisionChannel({ organizationId: ORG, approvals: lost, identity: w.service, roleOf });
    const second = await lossy.begin({ operatorId: 'approver-a', approvalRequestId: view.approvalRequestId, subjectDigest: view.subjectDigest, verdict: 'approve' });
    await assert.rejects(lossy.decide(human('approver-a').assert(second.options)));
    assert.equal((await channel.outcome(second.commitment))?.state, 'recorded');
    assert.equal((await verdictsOf(view.approvalRequestId)).length, 1, 'exactly one verdict');
  });

  it('a channel composed for another organization than the identity store refuses to start', () => {
    assert.throws(() => createHumanDecisionChannel({ organizationId: 'org-other', approvals, identity: w.service, roleOf }), (error: unknown) => error instanceof HumanDecisionError && error.code === 'HUMAN_DECISION_CONFIGURATION_INVALID');
  });
});
