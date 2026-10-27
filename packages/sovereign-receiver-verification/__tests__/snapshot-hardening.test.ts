// RSDK-01G: the options snapshot never drops a recognized constraint, and the
// content snapshot never aliases bytes the caller can still change (Codex
// review findings on PR #221).
import test from 'node:test';
import assert from 'node:assert/strict';

import { computeContentIdentity, mintSovereignAssetId } from '@aoc/protocol/identity';

import { STRICT_RECEIVER_PROFILE, verifyReceivedSovereignAsset } from '../src/index.js';
import type { ReceivedSovereignAssetVerificationResult, ReceiverVerificationKeyResolver } from '../src/index.js';
import {
  ATTACKER,
  CONTENT,
  ISSUER,
  consumerSupport,
  manifestArtifact,
  serialize,
  signedManifest,
  trustingResolver,
  validFixture,
  validOptions,
} from './fixtures.js';

function assertRejected(result: ReceivedSovereignAssetVerificationResult, reasons: readonly string[]): void {
  assert.equal(result.outcome, 'rejected', `expected rejection with ${reasons.join(', ')}`);
  assert.deepEqual(result.reasons, [...reasons].sort());
  assert.equal(result.profile, STRICT_RECEIVER_PROFILE);
  assert.equal(result.authorization, 'not_evaluated');
}

function assertVerified(result: ReceivedSovereignAssetVerificationResult): void {
  assert.equal(result.outcome, 'verified', JSON.stringify(result.reasons));
  assert.equal(result.authorization, 'not_evaluated');
  assert.equal(result.revocation, 'not_evaluated');
  assert.equal(result.freshness, 'not_evaluated');
}

/** A promise the test settles explicitly, so suspension points are deterministic. */
function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

/** A trusting resolver whose first lookup suspends until the test releases it. */
function suspendingResolver(): { readonly resolver: ReceiverVerificationKeyResolver; readonly entered: Promise<void>; readonly release: () => void } {
  const inner = trustingResolver();
  const entered = deferred();
  const gate = deferred();
  let first = true;
  const resolver: ReceiverVerificationKeyResolver = {
    async resolveVerificationKey(issuer) {
      if (first) {
        first = false;
        entered.resolve();
        await gate.promise;
      }
      return inner.resolveVerificationKey(issuer);
    },
  };
  return { resolver, entered: entered.promise, release: gate.resolve };
}

// --- Finding A: recognized constraints are never dropped -------------------------

test('a mismatching expectedIssuer defined as a non-enumerable own property is enforced', async () => {
  const options = validOptions();
  Object.defineProperty(options, 'expectedIssuer', { value: ATTACKER, enumerable: false });
  assertRejected(await verifyReceivedSovereignAsset(validFixture().text, options), ['ISSUER_BINDING_MISMATCH']);
});

test('a mismatching expectedSovereignAssetId defined as a non-enumerable own property is enforced', async () => {
  const options = validOptions();
  Object.defineProperty(options, 'expectedSovereignAssetId', { value: mintSovereignAssetId(), enumerable: false });
  assertRejected(await verifyReceivedSovereignAsset(validFixture().text, options), ['SUBJECT_MISMATCH']);
});

test('constraints supplied through class getters are read and enforced', async () => {
  const base = validOptions();
  class Options {
    // A #private field is not a property, so the instance exposes only recognized options.
    readonly #issuer: string;
    constructor(issuer: string) { this.#issuer = issuer; }
    get verificationKeyResolver(): unknown { return base['verificationKeyResolver']; }
    get consumerSupport(): unknown { return base['consumerSupport']; }
    get contentBytes(): unknown { return base['contentBytes']; }
    get expectedIssuer(): string { return this.#issuer; }
  }
  assertRejected(await verifyReceivedSovereignAsset(validFixture().text, new Options(ATTACKER)), ['ISSUER_BINDING_MISMATCH']);
  assertVerified(await verifyReceivedSovereignAsset(validFixture().text, new Options(ISSUER)));
});

test('inherited constraints are read and enforced', async () => {
  const fixture = validFixture();
  for (const [inherited, reasons] of [
    [{ expectedIssuer: ATTACKER }, ['ISSUER_BINDING_MISMATCH']],
    [{ expectedSovereignAssetId: mintSovereignAssetId() }, ['SUBJECT_MISMATCH']],
  ] as const) {
    const options = Object.assign(Object.create(inherited) as Record<string, unknown>, validOptions());
    assertRejected(await verifyReceivedSovereignAsset(fixture.text, options), reasons);
  }
  const matching = Object.assign(Object.create({ expectedIssuer: ISSUER, expectedSovereignAssetId: fixture.sovereignAssetId }) as Record<string, unknown>, validOptions());
  assertVerified(await verifyReceivedSovereignAsset(fixture.text, matching));
});

test('a getter whose result changes is read once, and its first answer is the one enforced', async () => {
  for (const [answers, verified] of [[[ATTACKER, ISSUER], false], [[ISSUER, ATTACKER], true]] as const) {
    let reads = 0;
    const options = validOptions();
    Object.defineProperty(options, 'expectedIssuer', { enumerable: false, get: () => answers[Math.min(reads++, 1)] });
    const result = await verifyReceivedSovereignAsset(validFixture().text, options);
    if (verified) assertVerified(result);
    else assertRejected(result, ['ISSUER_BINDING_MISMATCH']);
    assert.equal(reads, 1, 'expectedIssuer must be read exactly once');
  }
});

test('a throwing getter for a constraint is rejected, not propagated', async () => {
  for (const enumerable of [true, false]) {
    const options = validOptions();
    Object.defineProperty(options, 'expectedSovereignAssetId', { enumerable, get: () => { throw new Error('getter'); } });
    assertRejected(await verifyReceivedSovereignAsset(validFixture().text, options), ['INVALID_OPTIONS']);
  }
});

test('a proxy that throws or hides keys during inspection is rejected', async () => {
  const text = validFixture().text;
  const target = validOptions();
  const traps: ProxyHandler<object>[] = [
    { ownKeys() { throw new Error('ownKeys'); } },
    { getPrototypeOf() { throw new Error('getPrototypeOf'); } },
    // Hides a constraint from inspection while still answering it.
    {
      ownKeys: (inner) => Reflect.ownKeys(inner).filter((key) => key !== 'expectedIssuer'),
      get: (inner, key, receiver) => (key === 'expectedIssuer' ? ATTACKER : Reflect.get(inner, key, receiver)),
    },
  ];
  for (const handler of traps) {
    assertRejected(await verifyReceivedSovereignAsset(text, new Proxy({ ...target }, handler)), ['INVALID_OPTIONS']);
  }
});

test('unrecognized options are refused whether enumerable, non-enumerable or inherited', async () => {
  const text = validFixture().text;
  const hidden = validOptions();
  Object.defineProperty(hidden, 'expectedIssuers', { value: [ATTACKER], enumerable: false });
  assertRejected(await verifyReceivedSovereignAsset(text, hidden), ['INVALID_OPTIONS']);
  const inherited = Object.assign(Object.create({ skipIssuerBinding: true }) as Record<string, unknown>, validOptions());
  assertRejected(await verifyReceivedSovereignAsset(text, inherited), ['INVALID_OPTIONS']);
  class WithMethod {
    verificationKeyResolver = trustingResolver();
    consumerSupport = consumerSupport();
    contentBytes = CONTENT;
    relax(): void {}
  }
  assertRejected(await verifyReceivedSovereignAsset(text, new WithMethod()), ['INVALID_OPTIONS']);
});

test('Object.prototype is not a configuration source', async () => {
  const text = validFixture().text;
  const polluted = Object.prototype as Record<string, unknown>;
  polluted['expectedIssuer'] = ISSUER;
  try {
    assertRejected(await verifyReceivedSovereignAsset(text, validOptions()), ['INVALID_OPTIONS']);
  } finally {
    delete polluted['expectedIssuer'];
  }
  assertVerified(await verifyReceivedSovereignAsset(text, validOptions()));
});

test('caller mutation after the snapshot changes nothing', async () => {
  const fixture = validFixture();
  // Relaxing after the call starts: wrong bytes stay wrong.
  const relaxing = suspendingResolver();
  const options: Record<string, unknown> = validOptions({ verificationKeyResolver: relaxing.resolver, contentBytes: new TextEncoder().encode('wrong') });
  const pending = verifyReceivedSovereignAsset(fixture.text, options);
  await relaxing.entered;
  options['contentBytes'] = CONTENT;
  relaxing.release();
  assertRejected(await pending, ['CONTENT_DIGEST_MISMATCH']);

  // Tightening after the call starts: a matching call stays verified.
  const tightening = suspendingResolver();
  const later: Record<string, unknown> = validOptions({ verificationKeyResolver: tightening.resolver });
  const verifying = verifyReceivedSovereignAsset(fixture.text, later);
  await tightening.entered;
  later['expectedIssuer'] = ATTACKER;
  later['expectedSovereignAssetId'] = mintSovereignAssetId();
  tightening.release();
  assertVerified(await verifying);
});

test('ordinary and null-prototype options objects still verify', async () => {
  const fixture = validFixture();
  assertVerified(await verifyReceivedSovereignAsset(fixture.text, validOptions({ expectedIssuer: ISSUER, expectedSovereignAssetId: fixture.sovereignAssetId })));
  const bare = Object.assign(Object.create(null) as Record<string, unknown>, validOptions());
  assertVerified(await verifyReceivedSovereignAsset(fixture.text, bare));
});

// --- Finding B: content bytes are an owned snapshot --------------------------------

const OTHER = new TextEncoder().encode('substituted content bytes');

/** v1 commits to CONTENT, v2 (current) commits to OTHER. */
function twoVersions(): string {
  const sovereignAssetId = mintSovereignAssetId();
  const v1 = signedManifest({ sovereignAssetId });
  const v2 = signedManifest({ sovereignAssetId, manifestVersion: 2, contentIdentity: computeContentIdentity(OTHER) });
  return serialize({ subject: { sovereignAssetId }, manifests: [manifestArtifact(v1), manifestArtifact(v2)] });
}

const manifestOnly = (overrides: Record<string, unknown>) => validOptions({ consumerSupport: consumerSupport({ claimTypes: [] }), ...overrides });

test('ordinary Uint8Array and Buffer content still verify', async () => {
  assertVerified(await verifyReceivedSovereignAsset(validFixture().text, validOptions({ contentBytes: Uint8Array.from(CONTENT) })));
  assertVerified(await verifyReceivedSovereignAsset(validFixture().text, validOptions({ contentBytes: Buffer.from(CONTENT) })));
});

test('only the current manifest\'s bytes are checked across two versions', async () => {
  const text = twoVersions();
  assertVerified(await verifyReceivedSovereignAsset(text, manifestOnly({ contentBytes: OTHER })));
  assertRejected(await verifyReceivedSovereignAsset(text, manifestOnly({ contentBytes: CONTENT })), ['CONTENT_DIGEST_MISMATCH']);
});

test('a subclass whose species aliases the caller\'s array cannot swap in bytes mid-verification', async () => {
  const text = twoVersions();
  let speciesReads = 0;
  let alias: Uint8Array | undefined;
  class Aliasing extends Uint8Array {
    static get [Symbol.species](): unknown {
      speciesReads += 1;
      return function aliasing(): Uint8Array {
        return alias!;
      };
    }
  }
  // Starts as the v1 bytes, which do not match current v2.
  const bytes = new Aliasing(OTHER.length);
  bytes.set(CONTENT.subarray(0, OTHER.length));
  alias = bytes;
  const original = Uint8Array.from(bytes);
  const { resolver, entered, release } = suspendingResolver();
  const pending = verifyReceivedSovereignAsset(text, manifestOnly({ contentBytes: bytes, verificationKeyResolver: resolver }));
  await entered;
  bytes.set(OTHER); // now they would match v2
  release();
  assertRejected(await pending, ['CONTENT_DIGEST_MISMATCH']);
  assert.equal(speciesReads, 0, 'the species constructor must not be consulted');
  assert.notDeepEqual(Uint8Array.from(bytes), original, 'precondition: the caller really changed the bytes');
});

test('a species that returns a view over other caller-owned memory is never used', async () => {
  const text = twoVersions();
  const shared = new Uint8Array(OTHER.length);
  class Redirecting extends Uint8Array {
    static get [Symbol.species](): unknown {
      return function redirecting(): Uint8Array {
        return shared;
      };
    }
  }
  const bytes = new Redirecting(OTHER.length);
  bytes.set(CONTENT.subarray(0, OTHER.length));
  const { resolver, entered, release } = suspendingResolver();
  const pending = verifyReceivedSovereignAsset(text, manifestOnly({ contentBytes: bytes, verificationKeyResolver: resolver }));
  await entered;
  shared.set(OTHER);
  release();
  assertRejected(await pending, ['CONTENT_DIGEST_MISMATCH']);
});

test('mutating plain caller bytes while a resolver is suspended changes nothing', async () => {
  const text = twoVersions();
  // Matching bytes corrupted mid-verification still verify: the snapshot was taken first.
  const good = Uint8Array.from(OTHER);
  const first = suspendingResolver();
  const verifying = verifyReceivedSovereignAsset(text, manifestOnly({ contentBytes: good, verificationKeyResolver: first.resolver }));
  await first.entered;
  good.fill(0);
  first.release();
  assertVerified(await verifying);

  // Mismatching bytes repaired mid-verification stay rejected.
  const bad = new Uint8Array(OTHER.length);
  const second = suspendingResolver();
  const rejecting = verifyReceivedSovereignAsset(text, manifestOnly({ contentBytes: bad, verificationKeyResolver: second.resolver }));
  await second.entered;
  bad.set(OTHER);
  second.release();
  assertRejected(await rejecting, ['CONTENT_DIGEST_MISMATCH']);
});

test('content that is not a genuine Uint8Array is refused', async () => {
  const text = validFixture().text;
  for (const contentBytes of [
    new Proxy(Uint8Array.from(CONTENT), {}),
    Object.create(Uint8Array.prototype) as Uint8Array,
    Uint16Array.from(CONTENT),
    Array.from(CONTENT),
  ]) {
    assertRejected(await verifyReceivedSovereignAsset(text, validOptions({ contentBytes })), ['INVALID_OPTIONS']);
  }
});
