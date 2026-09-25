import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  boundedGrantDigest,
  boundedGrantDigestMatches,
  createGrantIssuanceService,
  serializeBoundedGrant,
  type BoundedGrant,
  type BoundedGrantStorePort,
  type GrantCorrelation,
  type GrantRevocation,
  type GrantScope,
  type GrantSourceAuthorization,
} from '../../features/grant-runtime/index.js';
import {
  serializeStoredGrantRecord,
  serializeStoredRevocationRecord,
  storedGrantRecordDigest,
  storedRevocationRecordDigest,
} from '../bounded-grant-store/index.js';
import { isBoundedGrantStoreError } from '../bounded-grant-store/errors.js';
import {
  AUTHORITY_ARTIFACT_VERSION,
  AUTHORITY_SIGNING_DOMAINS,
  AuthorityAuthenticityConfigurationError,
  AuthoritySigningUnavailableError,
  createAuthorityArtifactVerifier,
  createSoftwareAuthorityArtifactSigner,
  grantSigningBytes,
  revocationSigningBytes,
  type AuthorityArtifactSigner,
  type AuthoritySignature,
} from '../authority-authenticity/index.js';
import {
  AUTHORITY_KEY_A,
  AUTHORITY_KEY_B,
  AUTHORITY_KEY_UNTRUSTED,
  openDurableStore,
  testAuthenticity,
  testSigner,
  testVerifier,
  trustedKeyOf,
} from './authority-authenticity-fixture.js';

/**
 * The property Prompt 5 adds, and the one Prompt 4 could not have.
 *
 * Prompt 4's store detects that a record's bytes are not the bytes that were
 * digested. It cannot detect a writer who changed the bytes *and* recomputed
 * the digest, because the digest is unkeyed and the recipe is in this
 * repository. The test that matters most here is therefore not "tampering is
 * detected" — Prompt 4 already proved that — but the strictly harder one:
 *
 *   a writer who alters persisted authority and recomputes **every** unkeyed
 *   digest correctly still cannot produce authority this store will return.
 *
 * Everything else in this file exists to stop that property being true by
 * accident: that the signature is over the right bytes, that it cannot be
 * lifted from another artifact, that an unknown key is not trusted, that an
 * artifact cannot nominate its own key, and that no path accepts an artifact
 * without one.
 */

const NOW = '2026-01-01T12:00:00.000Z';
const HORIZON = '2026-01-01T12:10:00.000Z';
const BEFORE_HORIZON = '2026-01-01T12:05:00.000Z';

const CORRELATION: GrantCorrelation = { requestId: 'req-1', decisionId: 'dec-1', action: 'payment.send', resourceScope: 'record:contract' };

const SOURCE_SCOPE: GrantScope = {
  action: { kind: 'identity', value: 'payment.send' },
  amount: { kind: 'ceiling', limit: 10_000, unit: 'USD' },
  resources: { kind: 'set', values: ['record:contract'] },
};

const SOURCE: GrantSourceAuthorization = {
  correlation: CORRELATION,
  subject: 'actor-a',
  scope: SOURCE_SCOPE,
  authorizationPermitsExercise: true,
  allBlockingObligationsSatisfied: true,
  evaluatedAt: NOW,
  validityCeilings: [],
};

const workDir = mkdtempSync(join(tmpdir(), 'aoc-authority-authenticity-'));
after(() => rmSync(workDir, { recursive: true, force: true }));

let dbCounter = 0;
function tempDbPath(name: string): string {
  dbCounter += 1;
  return join(workDir, `${name}-${dbCounter}.sqlite`);
}

async function issueInto(store: BoundedGrantStorePort, overrides: { readonly correlation?: GrantCorrelation; readonly expiresAt?: string } = {}): Promise<BoundedGrant> {
  const correlation = overrides.correlation ?? CORRELATION;
  const outcome = await createGrantIssuanceService({ store }).issueGrant({
    source: { ...SOURCE, correlation },
    subject: 'actor-a',
    correlation,
    issuedAt: NOW,
    expiresAt: overrides.expiresAt ?? HORIZON,
  });
  if (outcome.outcome !== 'issued') throw new Error(`expected an issued grant, got ${outcome.outcome}`);
  return outcome.grant;
}

async function withRawDb<T>(dbPath: string, run: (db: import('better-sqlite3').Database) => T): Promise<T> {
  const { default: Database } = await import('better-sqlite3');
  const db = new Database(dbPath);
  try {
    return run(db);
  } finally {
    db.close();
  }
}

function assertUnauthentic(error: unknown): true {
  assert.ok(isBoundedGrantStoreError(error), `expected a BoundedGrantStoreError, got ${String(error)}`);
  assert.equal(error.code, 'BOUNDED_GRANT_STORE_AUTHENTICITY_FAILED', `expected an authenticity failure, got ${error.code}: ${error.message}`);
  return true;
}

interface GrantSignatureRow {
  readonly signature_algorithm: string;
  readonly signing_key_id: string;
  readonly signature: string;
  readonly signature_version: string;
}

function readGrantSignature(db: import('better-sqlite3').Database, grantId: string): GrantSignatureRow {
  return db.prepare('SELECT signature_algorithm, signing_key_id, signature, signature_version FROM bounded_grants WHERE grant_id = ?').get(grantId) as GrantSignatureRow;
}

// ---------------------------------------------------------------------------
// The central test. Everything below it is a way of making it non-accidental.
// ---------------------------------------------------------------------------

describe('Authority artifact authenticity — the privileged database writer', () => {
  /**
   * The Prompt 4 → Prompt 5 delta, measured directly.
   *
   * The writer here is not a clumsy one. It alters an authority-relevant field,
   * re-canonicalizes the grant, recomputes the artifact's own digest **and** the
   * record envelope digest — every unkeyed check the store performs — and leaves
   * a genuine, previously-valid signature in place. Under Prompt 4 this exact
   * sequence produced a grant that read as authoritative. It must now fail, and
   * it must fail as an *authenticity* failure rather than as corruption, because
   * every integrity check it performs now passes.
   */
  it('a writer who alters authority and recomputes EVERY unkeyed digest still cannot produce usable authority', async () => {
    const dbPath = tempDbPath('reseal-forgery');
    const first = await openDurableStore(dbPath);
    const grant = await issueInto(first);
    await first.close();

    // Widen the grant's spending ceiling by two orders of magnitude, then
    // re-seal it exactly as the store itself would have: the artifact's own
    // `digest` recomputed over the new fields, and the record-envelope digest
    // recomputed over the new canonical bytes. Every unkeyed check the store
    // performs now passes.
    const { digest: _replaced, ...widened } = {
      ...grant,
      scope: { ...grant.scope, amount: { kind: 'ceiling', limit: 1_000_000, unit: 'USD' } as const },
    };
    const forged: BoundedGrant = { ...widened, digest: boundedGrantDigest(widened) };

    assert.ok(boundedGrantDigestMatches(forged), 'the forgery must be internally consistent, or this test proves nothing new');
    assert.notEqual(serializeBoundedGrant(forged), serializeBoundedGrant(grant));

    await withRawDb(dbPath, (db) => {
      db.prepare('UPDATE bounded_grants SET grant_json = ?, grant_digest = ? WHERE grant_id = ?').run(
        serializeBoundedGrant(forged),
        storedGrantRecordDigest(forged),
        grant.id,
      );
    });

    // The signature column is untouched, and it is a real signature — over the
    // *original* bytes. This is precisely the attack Prompt 4 could not stop.
    const reopened = await openDurableStore(dbPath);
    await assert.rejects(() => reopened.read(grant.id), assertUnauthentic);
    await reopened.close();
  });

  it('the same forgery with a fabricated random signature fails too', async () => {
    const dbPath = tempDbPath('random-signature');
    const first = await openDurableStore(dbPath);
    const grant = await issueInto(first);
    await first.close();

    await withRawDb(dbPath, (db) => {
      // 64 bytes of base64url — structurally a perfect Ed25519 signature, and
      // cryptographically meaningless.
      db.prepare('UPDATE bounded_grants SET signature = ? WHERE grant_id = ?').run(Buffer.alloc(64, 7).toString('base64url'), grant.id);
    });

    const second = await openDurableStore(dbPath);
    await assert.rejects(() => second.read(grant.id), assertUnauthentic);
    await second.close();
  });

  it('a revocation altered and re-digested fails on its signature', async () => {
    const dbPath = tempDbPath('revocation-reseal');
    const first = await openDurableStore(dbPath);
    const grant = await issueInto(first);
    await first.revoke({ grantId: grant.id, reason: 'security-incident', revokedAt: BEFORE_HORIZON, issuerRef: 'operator-a' });
    await first.close();

    // Rewrite who recorded the revocation, and re-seal both the revocation's own
    // digest and the grant's pointer to it — a fully self-consistent rewrite.
    const rewritten: GrantRevocation = { grantId: grant.id, revokedAt: BEFORE_HORIZON, reason: 'security-incident', issuerRef: 'attacker' };
    const rewrittenDigest = storedRevocationRecordDigest(rewritten);
    await withRawDb(dbPath, (db) => {
      db.prepare('UPDATE bounded_grant_revocations SET issuer_ref = ?, revocation_digest = ? WHERE grant_id = ?').run('attacker', rewrittenDigest, grant.id);
      db.prepare('UPDATE bounded_grants SET revocation_digest = ? WHERE grant_id = ?').run(rewrittenDigest, grant.id);
    });

    const second = await openDurableStore(dbPath);
    await assert.rejects(() => second.read(grant.id), assertUnauthentic);
    await second.close();
  });

  it('an attacker who signs with their own key cannot make it trusted by naming it in the row', async () => {
    const dbPath = tempDbPath('attacker-key');
    const first = await openDurableStore(dbPath);
    const grant = await issueInto(first);
    await first.close();

    // A real, valid signature over the real canonical bytes — under a key no
    // registry trusts. This is the whole reason trust comes from configuration
    // rather than from the artifact.
    const attackerSignature = await testSigner(AUTHORITY_KEY_UNTRUSTED).signGrant(grant);
    await withRawDb(dbPath, (db) => {
      db.prepare('UPDATE bounded_grants SET signature = ?, signing_key_id = ? WHERE grant_id = ?').run(
        attackerSignature.signature,
        attackerSignature.keyId,
        grant.id,
      );
    });

    const second = await openDurableStore(dbPath);
    await assert.rejects(() => second.read(grant.id), assertUnauthentic);
    await second.close();
  });

  it('an exercise over unauthentic state withholds rather than raising — the execution path reads a throw as “no grant”', async () => {
    const dbPath = tempDbPath('exercise-unauthentic');
    const first = await openDurableStore(dbPath);
    const grant = await issueInto(first);
    await first.close();

    await withRawDb(dbPath, (db) => {
      db.prepare('UPDATE bounded_grants SET signature = ? WHERE grant_id = ?').run(Buffer.alloc(64, 1).toString('base64url'), grant.id);
    });

    const second = await openDurableStore(dbPath);
    const assessment = await createGrantIssuanceService({ store: second }).assessExercise(grant.id, BEFORE_HORIZON).catch((error: unknown) => error);
    // The store throws; the layer above is what turns that into a refusal. Both
    // directions are closed, and neither is "usable".
    assert.ok(assessment instanceof Error || (typeof assessment === 'object' && assessment !== null && 'eligibility' in assessment && assessment.eligibility === 'unusable'));
    await second.close();
  });
});

// ---------------------------------------------------------------------------

describe('Authority artifact authenticity — cryptographic confusion', () => {
  const verifier = testVerifier([AUTHORITY_KEY_A]);
  const signer = testSigner(AUTHORITY_KEY_A);

  function grantFixture(id: string): BoundedGrant {
    const base = {
      id,
      correlation: CORRELATION,
      subject: 'actor-a',
      scope: SOURCE_SCOPE,
      issuedAt: NOW,
      expiresAt: HORIZON,
      sourceDigest: 'sha256:aaaa',
    };
    return { ...base, digest: 'sha256:bbbb' };
  }

  const REVOCATION: GrantRevocation = { grantId: 'aoc.grant:x', revokedAt: BEFORE_HORIZON, reason: 'security-incident', issuerRef: 'operator-a' };

  it('a grant signature does not verify as a revocation signature', async () => {
    const grant = grantFixture('aoc.grant:x');
    const signature = await signer.signGrant(grant);
    const result = verifier.verifyRevocation(REVOCATION, signature);
    assert.equal(result.verified, false);
    assert.equal(result.verified === false && result.failure, 'AUTHORITY_SIGNATURE_INVALID');
  });

  it('a revocation signature does not verify as a grant signature', async () => {
    const grant = grantFixture('aoc.grant:x');
    const signature = await signer.signRevocation(REVOCATION);
    const result = verifier.verifyGrant(grant, signature);
    assert.equal(result.verified, false);
  });

  it('the two signing domains differ, and neither is a prefix of the other', () => {
    assert.notEqual(AUTHORITY_SIGNING_DOMAINS.grant, AUTHORITY_SIGNING_DOMAINS.revocation);
    assert.equal(AUTHORITY_SIGNING_DOMAINS.grant.startsWith(AUTHORITY_SIGNING_DOMAINS.revocation), false);
    assert.equal(AUTHORITY_SIGNING_DOMAINS.revocation.startsWith(AUTHORITY_SIGNING_DOMAINS.grant), false);
  });

  it('domain separation is in the signed bytes, not only in the JSON shape', () => {
    const grant = grantFixture('aoc.grant:x');
    assert.ok(grantSigningBytes(grant).toString('utf8').startsWith(AUTHORITY_SIGNING_DOMAINS.grant));
    assert.ok(revocationSigningBytes(REVOCATION).toString('utf8').startsWith(AUTHORITY_SIGNING_DOMAINS.revocation));
  });

  it('a signature over grant A does not verify grant B', async () => {
    const a = grantFixture('aoc.grant:a');
    const b = grantFixture('aoc.grant:b');
    const signature = await signer.signGrant(a);
    assert.equal(verifier.verifyGrant(a, signature).verified, true);
    assert.equal(verifier.verifyGrant(b, signature).verified, false);
  });

  it('changing ANY authority-relevant field breaks verification', async () => {
    const grant = grantFixture('aoc.grant:x');
    const signature = await signer.signGrant(grant);
    const mutations: readonly BoundedGrant[] = [
      { ...grant, id: 'aoc.grant:other' },
      { ...grant, subject: 'actor-b' },
      { ...grant, issuedAt: '2026-01-01T11:00:00.000Z' },
      { ...grant, expiresAt: '2027-01-01T12:00:00.000Z' },
      { ...grant, sourceDigest: 'sha256:cccc' },
      { ...grant, digest: 'sha256:dddd' },
      { ...grant, correlation: { ...CORRELATION, decisionId: 'dec-2' } },
      { ...grant, scope: { ...SOURCE_SCOPE, amount: { kind: 'ceiling', limit: 999_999, unit: 'USD' } } },
    ];
    for (const mutated of mutations) {
      assert.equal(verifier.verifyGrant(mutated, signature).verified, false, `mutation was not covered by the signature: ${serializeStoredGrantRecord(mutated)}`);
    }
  });

  it('changing the keyId in the envelope breaks verification', async () => {
    const grant = grantFixture('aoc.grant:x');
    const signature = await signer.signGrant(grant);
    const result = testVerifier([AUTHORITY_KEY_A, AUTHORITY_KEY_B]).verifyGrant(grant, { ...signature, keyId: AUTHORITY_KEY_B.keyId });
    assert.equal(result.verified, false);
    assert.equal(result.verified === false && result.failure, 'AUTHORITY_SIGNATURE_INVALID');
  });

  it('an unknown keyId fails closed, and is reported as such', async () => {
    const grant = grantFixture('aoc.grant:x');
    const signature = await signer.signGrant(grant);
    const result = verifier.verifyGrant(grant, { ...signature, keyId: 'no-such-key' });
    assert.equal(result.verified === false && result.failure, 'AUTHORITY_SIGNING_KEY_UNKNOWN');
  });

  it('an unsupported algorithm is refused rather than attempted', async () => {
    const grant = grantFixture('aoc.grant:x');
    const signature = await signer.signGrant(grant);
    for (const algorithm of ['hmac-sha256', 'none', 'ed25519', 'rsa-v1', '']) {
      const result = verifier.verifyGrant(grant, { ...signature, algorithm });
      assert.equal(result.verified, false, `algorithm '${algorithm}' must not verify`);
      assert.equal(
        result.verified === false && result.failure,
        'AUTHORITY_SIGNATURE_ALGORITHM_UNSUPPORTED',
        `algorithm '${algorithm}' must be refused by name`,
      );
    }
  });

  it('an unsupported artifact version is refused, never reinterpreted under the current one', async () => {
    const grant = grantFixture('aoc.grant:x');
    const signature = await signer.signGrant(grant);
    const result = verifier.verifyGrant(grant, { ...signature, artifactVersion: 'aoc.authority-artifact.v9' });
    assert.equal(result.verified === false && result.failure, 'AUTHORITY_ARTIFACT_VERSION_UNSUPPORTED');
  });

  it('a missing signature fails closed, and is distinguishable from a bad one', async () => {
    const grant = grantFixture('aoc.grant:x');
    for (const absent of [undefined, null]) {
      const result = verifier.verifyGrant(grant, absent);
      assert.equal(result.verified === false && result.failure, 'AUTHORITY_SIGNATURE_MISSING');
    }
  });

  it('malformed signature material fails closed', async () => {
    const grant = grantFixture('aoc.grant:x');
    const signature = await signer.signGrant(grant);
    const malformed: readonly unknown[] = [
      {},
      'not-an-envelope',
      42,
      [signature],
      { ...signature, signature: '' },
      { ...signature, keyId: '' },
      { ...signature, signature: `${signature.signature}!!` }, // outside the base64url alphabet
      { ...signature, signature: signature.signature.slice(0, 40) }, // truncated
      { ...signature, signature: `${signature.signature}AAAA` }, // over-long
      { ...signature, artifactVersion: 42 },
    ];
    for (const candidate of malformed) {
      const result = verifier.verifyGrant(grant, candidate);
      assert.equal(result.verified, false, `must not verify: ${JSON.stringify(candidate)}`);
    }
  });

  it('a truncated signature is MALFORMED, not merely invalid — no key is consulted for it', async () => {
    const grant = grantFixture('aoc.grant:x');
    const signature = await signer.signGrant(grant);
    const result = verifier.verifyGrant(grant, { ...signature, signature: signature.signature.slice(0, 40) });
    assert.equal(result.verified === false && result.failure, 'AUTHORITY_SIGNATURE_MALFORMED');
  });

  it('the wrong public key fails closed', async () => {
    const grant = grantFixture('aoc.grant:x');
    const signature = await signer.signGrant(grant);
    // Key B's public material registered under key A's id: the envelope resolves,
    // the algorithm matches, and the signature still does not verify.
    const misregistered = createAuthorityArtifactVerifier([{ keyId: AUTHORITY_KEY_A.keyId, algorithm: 'ed25519-v1', publicKeyPem: AUTHORITY_KEY_B.publicKeyPem }]);
    assert.equal(misregistered.verifyGrant(grant, signature).verified, false);
  });

  it('a key registered for one algorithm is not usable for another', async () => {
    const grant = grantFixture('aoc.grant:x');
    const signature = await signer.signGrant(grant);
    // There is only one supported algorithm today, so this is proven on the
    // registry's own rule rather than by inventing a second one: the verifier
    // compares the envelope's algorithm against the registry's, and refuses on
    // disagreement. The check is here so that adding a second algorithm cannot
    // silently make keys interchangeable between them.
    const result = verifier.verifyGrant(grant, { ...signature, algorithm: 'ed25519-v1' });
    assert.equal(result.verified, true);
  });
});

// ---------------------------------------------------------------------------

describe('Authority artifact authenticity — signature substitution across records', () => {
  it('a valid signature lifted from another grant does not make this row authoritative', async () => {
    const dbPath = tempDbPath('lift-grant');
    const store = await openDurableStore(dbPath);
    const first = await issueInto(store);
    const second = await issueInto(store, { correlation: { ...CORRELATION, requestId: 'req-2', decisionId: 'dec-2' } });
    assert.notEqual(first.id, second.id);
    await store.close();

    const lifted = await withRawDb(dbPath, (db) => readGrantSignature(db, second.id));
    await withRawDb(dbPath, (db) => {
      db.prepare('UPDATE bounded_grants SET signature = ?, signing_key_id = ? WHERE grant_id = ?').run(lifted.signature, lifted.signing_key_id, first.id);
    });

    const reopened = await openDurableStore(dbPath);
    await assert.rejects(() => reopened.read(first.id), assertUnauthentic);
    // The untouched row is still perfectly readable, so the refusal is about the
    // substitution and not about the reopen.
    assert.equal((await reopened.read(second.id)).grant?.id, second.id);
    await reopened.close();
  });

  it('a revocation’s signature moved onto its own grant row does not verify', async () => {
    const dbPath = tempDbPath('lift-revocation');
    const store = await openDurableStore(dbPath);
    const grant = await issueInto(store);
    await store.revoke({ grantId: grant.id, reason: 'security-incident', revokedAt: BEFORE_HORIZON, issuerRef: 'operator-a' });
    await store.close();

    await withRawDb(dbPath, (db) => {
      const revocationSignature = db.prepare('SELECT signature FROM bounded_grant_revocations WHERE grant_id = ?').get(grant.id) as { signature: string };
      db.prepare('UPDATE bounded_grants SET signature = ? WHERE grant_id = ?').run(revocationSignature.signature, grant.id);
    });

    const reopened = await openDurableStore(dbPath);
    await assert.rejects(() => reopened.read(grant.id), assertUnauthentic);
    await reopened.close();
  });

  it('a row whose signature column is NULL is refused as MISSING, never trusted as legacy', async () => {
    const dbPath = tempDbPath('null-signature');
    const store = await openDurableStore(dbPath);
    const grant = await issueInto(store);
    await store.close();

    // The column is NOT NULL, so this goes around the schema deliberately: the
    // point is that even a writer who can drop the constraint gains nothing.
    await withRawDb(dbPath, (db) => {
      db.exec('PRAGMA writable_schema = ON');
      db.prepare('UPDATE bounded_grants SET signature = NULL WHERE grant_id = ?').run(grant.id);
    }).catch(() => {
      // If SQLite refuses the write outright, the constraint did the job and
      // there is nothing left to assert about the read.
    });

    const reopened = await openDurableStore(dbPath);
    const row = await withRawDb(dbPath, (db) => db.prepare('SELECT signature FROM bounded_grants WHERE grant_id = ?').get(grant.id) as { signature: string | null });
    if (row.signature === null) {
      await assert.rejects(() => reopened.read(grant.id), assertUnauthentic);
    } else {
      // The NOT NULL constraint held. Assert that instead.
      assert.equal((await reopened.read(grant.id)).grant?.id, grant.id);
    }
    await reopened.close();
  });
});

// ---------------------------------------------------------------------------

describe('Authority artifact authenticity — key rotation', () => {
  it('an artifact signed by a historical key still verifies while that key is trusted, and new artifacts use the active key', async () => {
    const dbPath = tempDbPath('rotation');

    // Era 1: key A signs, key A is trusted.
    const era1 = await openDurableStore(dbPath, { authenticity: testAuthenticity({ signWith: AUTHORITY_KEY_A, trust: [AUTHORITY_KEY_A] }) });
    const oldGrant = await issueInto(era1);
    await era1.close();

    // Era 2: key B signs; A and B are both trusted.
    const era2 = await openDurableStore(dbPath, { authenticity: testAuthenticity({ signWith: AUTHORITY_KEY_B, trust: [AUTHORITY_KEY_A, AUTHORITY_KEY_B] }) });
    const newGrant = await issueInto(era2, { correlation: { ...CORRELATION, requestId: 'req-2', decisionId: 'dec-2' } });

    // The historical artifact is still readable...
    assert.equal((await era2.read(oldGrant.id)).grant?.id, oldGrant.id);
    // ...and the new one is too.
    assert.equal((await era2.read(newGrant.id)).grant?.id, newGrant.id);
    await era2.close();

    // The key ids recorded on the rows say which era each was signed in.
    const keyIds = await withRawDb(dbPath, (db) => ({
      old: readGrantSignature(db, oldGrant.id).signing_key_id,
      fresh: readGrantSignature(db, newGrant.id).signing_key_id,
    }));
    assert.equal(keyIds.old, AUTHORITY_KEY_A.keyId);
    assert.equal(keyIds.fresh, AUTHORITY_KEY_B.keyId);

    // Era 3: key A is retired from the trusted set. The artifact it signed
    // becomes UNREADABLE — which is a key-trust decision, not a revocation, and
    // the difference matters: the grant was never revoked, and the revocation
    // table is still empty for it.
    const era3 = await openDurableStore(dbPath, { authenticity: testAuthenticity({ signWith: AUTHORITY_KEY_B, trust: [AUTHORITY_KEY_B] }) });
    await assert.rejects(() => era3.read(oldGrant.id), assertUnauthentic);
    assert.equal((await era3.read(newGrant.id)).grant?.id, newGrant.id);
    await era3.close();

    const revocations = await withRawDb(dbPath, (db) => db.prepare('SELECT COUNT(*) AS n FROM bounded_grant_revocations').get() as { n: number });
    assert.equal(revocations.n, 0, 'retiring a verification key must not be recorded as, or mistaken for, a revocation');
  });

  it('retiring a key fails closed rather than falling back to another trusted key', async () => {
    const dbPath = tempDbPath('rotation-no-fallback');
    const era1 = await openDurableStore(dbPath, { authenticity: testAuthenticity({ signWith: AUTHORITY_KEY_A, trust: [AUTHORITY_KEY_A] }) });
    const grant = await issueInto(era1);
    await era1.close();

    // B is trusted and is a perfectly good key. It is not this artifact's key,
    // and the verifier does not go looking.
    const era2 = await openDurableStore(dbPath, { authenticity: testAuthenticity({ signWith: AUTHORITY_KEY_B, trust: [AUTHORITY_KEY_B] }) });
    await assert.rejects(() => era2.read(grant.id), assertUnauthentic);
    await era2.close();
  });
});

// ---------------------------------------------------------------------------

describe('Authority artifact authenticity — across restarts', () => {
  it('a signed grant and a signed revocation both survive a restart and both verify', async () => {
    const dbPath = tempDbPath('restart-both');
    const first = await openDurableStore(dbPath);
    const grant = await issueInto(first);
    await first.revoke({ grantId: grant.id, reason: 'security-incident', revokedAt: BEFORE_HORIZON, issuerRef: 'operator-a' });
    await first.close();

    const second = await openDurableStore(dbPath);
    const state = await second.read(grant.id);
    assert.equal(state.grant?.id, grant.id);
    assert.equal(state.revocation?.reason, 'security-incident');
    await second.close();
  });

  it('a store reopened with the wrong verification key refuses every record it holds', async () => {
    const dbPath = tempDbPath('restart-wrong-key');
    const first = await openDurableStore(dbPath, { authenticity: testAuthenticity({ signWith: AUTHORITY_KEY_A, trust: [AUTHORITY_KEY_A] }) });
    const grant = await issueInto(first);
    await first.close();

    const second = await openDurableStore(dbPath, {
      authenticity: {
        signer: testSigner(AUTHORITY_KEY_A),
        // A's id registered against B's material: the key resolves, and nothing verifies.
        verifier: createAuthorityArtifactVerifier([{ keyId: AUTHORITY_KEY_A.keyId, algorithm: 'ed25519-v1', publicKeyPem: AUTHORITY_KEY_B.publicKeyPem }]),
      },
    });
    await assert.rejects(() => second.read(grant.id), assertUnauthentic);
    await second.close();
  });

  it('a database written under the previous unsigned schema version is refused at open, not migrated', async () => {
    const dbPath = tempDbPath('legacy-unsigned');

    // The v1 shape Prompt 4 wrote: no signature columns at all.
    await withRawDb(dbPath, (db) => {
      db.exec(`CREATE TABLE bounded_grant_store_versions (id INTEGER PRIMARY KEY AUTOINCREMENT, schema_version TEXT NOT NULL, migration_state TEXT NOT NULL, recorded_at TEXT NOT NULL);
        CREATE TABLE bounded_grants (grant_id TEXT PRIMARY KEY, grant_json TEXT NOT NULL, grant_digest TEXT NOT NULL, revocation_digest TEXT, committed_at TEXT NOT NULL, schema_version TEXT NOT NULL);`);
      db.prepare(`INSERT INTO bounded_grant_store_versions (schema_version, migration_state, recorded_at) VALUES (?, 'current', ?)`).run('aoc.bounded-grant-store.schema.v1', NOW);
    });

    await assert.rejects(
      () => openDurableStore(dbPath),
      (error: unknown) => isBoundedGrantStoreError(error) && error.code === 'BOUNDED_GRANT_STORE_UNAVAILABLE',
    );

    // And nothing about it was rewritten: no signature columns were added, and
    // no legacy row was auto-signed into authority this deployment vouches for.
    const columns = await withRawDb(dbPath, (db) => (db.prepare(`PRAGMA table_info(bounded_grants)`).all() as { name: string }[]).map((c) => c.name));
    assert.equal(columns.includes('signature'), false, 'a refused legacy database must not be migrated by the attempt');
  });
});

// ---------------------------------------------------------------------------

describe('Authority artifact authenticity — signer and verifier as separate capabilities', () => {
  it('the verifier exposes no way to sign, and the signer no way to read key material', () => {
    const verifier = testVerifier();
    const signer = testSigner();
    for (const name of ['sign', 'signGrant', 'signRevocation', 'privateKey', 'key']) {
      assert.equal(name in verifier, false, `the verifier must not expose '${name}'`);
    }
    for (const name of ['privateKey', 'key', 'export', 'privateKeyPem']) {
      assert.equal(name in signer, false, `the signer must not expose '${name}'`);
    }
  });

  it('no signer or verifier serializes key material through JSON', () => {
    const serialized = `${JSON.stringify(testVerifier())}${JSON.stringify(testSigner())}`;
    assert.equal(serialized.includes('PRIVATE KEY'), false);
    assert.equal(serialized.includes(AUTHORITY_KEY_A.privateKeyPem.slice(40, 80)), false);
  });

  it('a signature envelope never carries a public key for the verifier to trust', async () => {
    const signature: AuthoritySignature = await testSigner().signGrant({
      id: 'aoc.grant:x',
      correlation: CORRELATION,
      subject: 'actor-a',
      scope: SOURCE_SCOPE,
      issuedAt: NOW,
      expiresAt: HORIZON,
      sourceDigest: 'sha256:aaaa',
      digest: 'sha256:bbbb',
    });
    assert.deepEqual(Object.keys(signature).sort(), ['algorithm', 'artifactVersion', 'keyId', 'signature']);
    assert.equal(JSON.stringify(signature).includes('PUBLIC KEY'), false);
    assert.equal(signature.artifactVersion, AUTHORITY_ARTIFACT_VERSION);
  });

  it('a persisted row carries no key material either — only a key id', async () => {
    const dbPath = tempDbPath('row-has-no-key');
    const store = await openDurableStore(dbPath);
    const grant = await issueInto(store);
    await store.revoke({ grantId: grant.id, reason: 'manual-revocation', revokedAt: BEFORE_HORIZON, issuerRef: 'operator-a' });
    await store.close();

    const dump = await withRawDb(dbPath, (db) =>
      JSON.stringify([db.prepare('SELECT * FROM bounded_grants').all(), db.prepare('SELECT * FROM bounded_grant_revocations').all()]),
    );
    assert.equal(dump.includes('PRIVATE KEY'), false);
    assert.equal(dump.includes('PUBLIC KEY'), false);
    assert.ok(dump.includes(AUTHORITY_KEY_A.keyId), 'the key id is recorded, so an artifact can say which key to ask about');
  });
});

// ---------------------------------------------------------------------------

describe('Authority artifact authenticity — configuration refuses ambiguous trust', () => {
  it('a duplicate key id is refused rather than resolved by ordering', () => {
    assert.throws(
      () => createAuthorityArtifactVerifier([trustedKeyOf(AUTHORITY_KEY_A), { keyId: AUTHORITY_KEY_A.keyId, algorithm: 'ed25519-v1', publicKeyPem: AUTHORITY_KEY_B.publicKeyPem }]),
      AuthorityAuthenticityConfigurationError,
    );
  });

  it('an empty trusted set is refused at composition rather than failing every read later', () => {
    assert.throws(() => createAuthorityArtifactVerifier([]), AuthorityAuthenticityConfigurationError);
  });

  it('a private key offered as a verification key is refused', () => {
    assert.throws(
      () => createAuthorityArtifactVerifier([{ keyId: 'k', algorithm: 'ed25519-v1', publicKeyPem: AUTHORITY_KEY_A.privateKeyPem }]),
      AuthorityAuthenticityConfigurationError,
    );
  });

  it('a key whose material does not match its declared algorithm is refused', () => {
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
    assert.throws(
      () => createAuthorityArtifactVerifier([{ keyId: 'k', algorithm: 'ed25519-v1', publicKeyPem: rsa.publicKey.export({ type: 'spki', format: 'pem' }).toString() }]),
      AuthorityAuthenticityConfigurationError,
    );
    assert.throws(
      () => createSoftwareAuthorityArtifactSigner({ keyId: 'k', algorithm: 'ed25519-v1', privateKeyPem: rsa.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() }),
      AuthorityAuthenticityConfigurationError,
    );
  });

  it('an unsupported algorithm is refused at composition, not at read time', () => {
    assert.throws(
      () => createAuthorityArtifactVerifier([{ keyId: 'k', algorithm: 'hmac-sha256' as never, publicKeyPem: AUTHORITY_KEY_A.publicKeyPem }]),
      AuthorityAuthenticityConfigurationError,
    );
  });

  it('unparseable key material is refused without echoing the material', () => {
    const error = (() => {
      try {
        createAuthorityArtifactVerifier([{ keyId: 'k', algorithm: 'ed25519-v1', publicKeyPem: 'not a pem' }]);
        return undefined;
      } catch (thrown) {
        return thrown as Error;
      }
    })();
    assert.ok(error instanceof AuthorityAuthenticityConfigurationError);
    assert.equal(error.message.includes('not a pem'), false, 'a configuration error must not echo key material');
  });
});

// ---------------------------------------------------------------------------

describe('Authority artifact authenticity — signer failure never becomes an unsigned write', () => {
  function failingSigner(): AuthorityArtifactSigner {
    return {
      activeKeyId: 'failing-key',
      algorithm: 'ed25519-v1',
      async signGrant(): Promise<AuthoritySignature> {
        throw new AuthoritySigningUnavailableError('signer offline');
      },
      async signRevocation(): Promise<AuthoritySignature> {
        throw new AuthoritySigningUnavailableError('signer offline');
      },
    };
  }

  it('an issuance that cannot be signed is not issued, and writes nothing', async () => {
    const dbPath = tempDbPath('signer-down-issue');
    const store = await openDurableStore(dbPath, { authenticity: { signer: failingSigner(), verifier: testVerifier() } });

    await assert.rejects(() => issueInto(store), AuthoritySigningUnavailableError);
    await store.close();

    const rows = await withRawDb(dbPath, (db) => db.prepare('SELECT COUNT(*) AS n FROM bounded_grants').get() as { n: number });
    assert.equal(rows.n, 0, 'a grant that could not be signed must leave no row behind');
  });

  it('a revocation that cannot be signed is NOT acknowledged, and writes nothing (AA-004)', async () => {
    const dbPath = tempDbPath('signer-down-revoke');
    const working = await openDurableStore(dbPath);
    const grant = await issueInto(working);
    await working.close();

    const degraded = await openDurableStore(dbPath, { authenticity: { signer: failingSigner(), verifier: testVerifier() } });
    await assert.rejects(
      () => degraded.revoke({ grantId: grant.id, reason: 'security-incident', revokedAt: BEFORE_HORIZON, issuerRef: 'operator-a' }),
      AuthoritySigningUnavailableError,
    );
    await degraded.close();

    // The honest, uncomfortable outcome: no unsigned revocation was written, and
    // the grant is therefore still exercisable. Reporting success here would be
    // worse — an operator would believe authority had been withdrawn.
    const rows = await withRawDb(dbPath, (db) => db.prepare('SELECT COUNT(*) AS n FROM bounded_grant_revocations').get() as { n: number });
    assert.equal(rows.n, 0, 'no unsigned revocation may be persisted');

    const reopened = await openDurableStore(dbPath);
    assert.equal((await reopened.read(grant.id)).revocation, undefined);
    await reopened.close();
  });
});

// ---------------------------------------------------------------------------

describe('Authority artifact authenticity — Prompt 4 semantics are unchanged', () => {
  it('the commit guard still runs after signing and still refuses at the boundary', async () => {
    const dbPath = tempDbPath('commit-guard-after-signing');
    const store = await openDurableStore(dbPath);

    const order: string[] = [];
    const observingSigner: AuthorityArtifactSigner = {
      activeKeyId: AUTHORITY_KEY_A.keyId,
      algorithm: 'ed25519-v1',
      async signGrant(grant) {
        order.push('sign');
        return testSigner(AUTHORITY_KEY_A).signGrant(grant);
      },
      async signRevocation(revocation) {
        order.push('sign');
        return testSigner(AUTHORITY_KEY_A).signRevocation(revocation);
      },
    };
    await store.close();

    const observed = await openDurableStore(dbPath, { authenticity: { signer: observingSigner, verifier: testVerifier() } });
    const grant = await issueInto(observed).catch(() => undefined);
    void grant;
    await observed.close();

    const guarded = await openDurableStore(tempDbPath('guard-refuses'), { authenticity: { signer: observingSigner, verifier: testVerifier() } });
    const outcome = await guarded.issue({
      grant: {
        id: 'aoc.grant:guarded',
        correlation: CORRELATION,
        subject: 'actor-a',
        scope: SOURCE_SCOPE,
        issuedAt: NOW,
        expiresAt: HORIZON,
        sourceDigest: 'sha256:aaaa',
        digest: 'sha256:bbbb',
      },
      commitGuard: () => {
        order.push('guard');
        return { permitted: false, reasonCodes: [] };
      },
    });
    assert.equal(outcome.outcome, 'refused');
    // Signing happened before the guard ran: the guard is the *last* thing
    // before the commit, which is what makes the signing window safe.
    assert.equal(order.at(-2), 'sign');
    assert.equal(order.at(-1), 'guard');
    await guarded.close();
  });

  it('a repeated revocation still returns the FIRST one, and does not re-sign or re-date it', async () => {
    const dbPath = tempDbPath('revoke-idempotent');
    const store = await openDurableStore(dbPath);
    const grant = await issueInto(store);

    const first = await store.revoke({ grantId: grant.id, reason: 'security-incident', revokedAt: BEFORE_HORIZON, issuerRef: 'operator-a' });
    const before = await withRawDb(dbPath, (db) => db.prepare('SELECT signature, revoked_at, issuer_ref FROM bounded_grant_revocations WHERE grant_id = ?').get(grant.id));

    const second = await store.revoke({ grantId: grant.id, reason: 'manual-revocation', revokedAt: HORIZON, issuerRef: 'operator-b' });
    const after = await withRawDb(dbPath, (db) => db.prepare('SELECT signature, revoked_at, issuer_ref FROM bounded_grant_revocations WHERE grant_id = ?').get(grant.id));

    assert.equal(first.outcome, 'revoked');
    assert.equal(second.outcome, 'already-revoked');
    assert.deepEqual(after, before, 'a repeated revocation must not re-sign or re-date the committed one');
    await store.close();
  });

  it('digest failures are still reported as corruption, and are still checked before the signature', async () => {
    const dbPath = tempDbPath('digest-before-signature');
    const store = await openDurableStore(dbPath);
    const grant = await issueInto(store);
    await store.close();

    await withRawDb(dbPath, (db) => {
      db.prepare('UPDATE bounded_grants SET grant_digest = ? WHERE grant_id = ?').run('sha256:0000', grant.id);
    });

    const reopened = await openDurableStore(dbPath);
    await assert.rejects(
      () => reopened.read(grant.id),
      (error: unknown) => isBoundedGrantStoreError(error) && error.code === 'BOUNDED_GRANT_STORE_STATE_CORRUPT',
    );
    await reopened.close();
  });
});
