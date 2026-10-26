import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';

import type { AuthenticationOptionsJSON, RegistrationOptionsJSON } from '../human-identity/index.js';

/**
 * AUTH-02 test fixture — a WebAuthn software authenticator, test-only.
 *
 * It produces genuine WebAuthn L2 ceremony outputs, byte for byte as the
 * specification lays them out, so the production verifier
 * (`@simplewebauthn/server`) is exercised exactly as a browser would drive it:
 *
 * - `clientDataJSON` — `{ type, challenge, origin, crossOrigin }`;
 * - `authenticatorData` — SHA-256(rpId) ‖ flags ‖ signCount (u32 BE)
 *   [‖ AAGUID ‖ credentialIdLength (u16 BE) ‖ credentialId ‖ COSE key];
 * - `attestationObject` — CBOR `{ fmt, attStmt, authData }`, `none` by default;
 * - the assertion signature — ECDSA P-256 / SHA-256 (DER) over
 *   authenticatorData ‖ SHA-256(clientDataJSON), by Node's own crypto.
 *
 * Every field can be overridden to build the malformed and hostile variants
 * the tests need. The private key lives only in this test process, exactly as
 * a passkey's private key lives only in its authenticator.
 */

const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_BE = 0x08;
const FLAG_BS = 0x10;
const FLAG_AT = 0x40;

// ── A minimal CBOR encoder (RFC 8949 major types 0–5), for building test inputs only ──

export type Cbor = number | string | Uint8Array | readonly Cbor[] | Map<number | string, Cbor>;

function head(major: number, length: number): Buffer {
  if (length < 24) return Buffer.from([(major << 5) | length]);
  if (length < 0x100) return Buffer.from([(major << 5) | 24, length]);
  if (length < 0x10000) {
    const out = Buffer.alloc(3);
    out[0] = (major << 5) | 25;
    out.writeUInt16BE(length, 1);
    return out;
  }
  const out = Buffer.alloc(5);
  out[0] = (major << 5) | 26;
  out.writeUInt32BE(length, 1);
  return out;
}

export function cbor(value: Cbor): Buffer {
  if (typeof value === 'number') return value >= 0 ? head(0, value) : head(1, -1 - value);
  if (typeof value === 'string') {
    const bytes = Buffer.from(value, 'utf8');
    return Buffer.concat([head(3, bytes.length), bytes]);
  }
  if (value instanceof Uint8Array) return Buffer.concat([head(2, value.length), Buffer.from(value)]);
  if (value instanceof Map) {
    const parts: Buffer[] = [head(5, value.size)];
    for (const [key, entry] of value) parts.push(cbor(key), cbor(entry));
    return Buffer.concat(parts);
  }
  const items = value as readonly Cbor[];
  return Buffer.concat([head(4, items.length), ...items.map((item) => cbor(item))]);
}

const sha256 = (bytes: Uint8Array | string): Buffer => createHash('sha256').update(bytes).digest();
const b64url = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64url');

export interface CeremonyOverrides {
  readonly origin?: string;
  /** The RP ID whose hash the authenticator writes (default: the options' RP ID). */
  readonly rpId?: string;
  readonly challenge?: string;
  readonly type?: string;
  readonly crossOrigin?: boolean;
  readonly topOrigin?: string;
  readonly userVerified?: boolean;
  readonly userPresent?: boolean;
  /** The signature counter to write (default: the authenticator's own). */
  readonly counter?: number;
}

export interface RegistrationOverrides extends CeremonyOverrides {
  readonly fmt?: string;
  readonly attStmt?: Map<number | string, Cbor>;
  /** Replaces the COSE public key bytes (malformed-key tests). */
  readonly coseKey?: Uint8Array;
  readonly credentialId?: Uint8Array;
  readonly omitAttestedCredentialData?: boolean;
}

export interface AssertionOverrides extends CeremonyOverrides {
  readonly userHandle?: string | null;
  readonly credentialId?: string;
  readonly corruptSignature?: boolean;
}

export interface SoftwareAuthenticatorOptions {
  readonly origin: string;
  /** A synced passkey: backup-eligible and backed up, and never counting (signCount stays 0). */
  readonly synced?: boolean;
  /** Reuse this credential id (duplicate-registration tests). */
  readonly credentialId?: Uint8Array;
}

export class SoftwareAuthenticator {
  readonly credentialId: Uint8Array;
  readonly origin: string;
  readonly synced: boolean;
  private readonly privateKey: KeyObject;
  private readonly x: Buffer;
  private readonly y: Buffer;
  private counter = 0;
  userHandle: string | undefined;

  constructor(options: SoftwareAuthenticatorOptions) {
    this.origin = options.origin;
    this.synced = options.synced === true;
    this.credentialId = options.credentialId ?? randomBytes(32);
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    this.privateKey = privateKey;
    const jwk = publicKey.export({ format: 'jwk' });
    this.x = Buffer.from(jwk.x ?? '', 'base64url');
    this.y = Buffer.from(jwk.y ?? '', 'base64url');
  }

  get id(): string {
    return b64url(this.credentialId);
  }

  /** The COSE_Key (EC2, ES256, P-256) of this credential. */
  coseKey(): Buffer {
    return cbor(
      new Map<number | string, Cbor>([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, this.x],
        [-3, this.y],
      ]),
    );
  }

  private flags(overrides: CeremonyOverrides, attested: boolean): number {
    let flags = 0;
    if (overrides.userPresent !== false) flags |= FLAG_UP;
    if (overrides.userVerified !== false) flags |= FLAG_UV;
    if (this.synced) flags |= FLAG_BE | FLAG_BS;
    if (attested) flags |= FLAG_AT;
    return flags;
  }

  private clientData(type: string, challenge: string, overrides: CeremonyOverrides): Buffer {
    return Buffer.from(
      JSON.stringify({
        type: overrides.type ?? type,
        challenge: overrides.challenge ?? challenge,
        origin: overrides.origin ?? this.origin,
        crossOrigin: overrides.crossOrigin ?? false,
        ...(overrides.topOrigin === undefined ? {} : { topOrigin: overrides.topOrigin }),
      }),
      'utf8',
    );
  }

  private nextCounter(overrides: CeremonyOverrides): number {
    if (overrides.counter !== undefined) return overrides.counter;
    if (this.synced) return 0;
    this.counter += 1;
    return this.counter;
  }

  /** `navigator.credentials.create()`, answered. */
  register(options: RegistrationOptionsJSON, overrides: RegistrationOverrides = {}): Record<string, unknown> {
    this.userHandle = options.user.id;
    const credentialId = overrides.credentialId ?? this.credentialId;
    const counterBytes = Buffer.alloc(4);
    counterBytes.writeUInt32BE(overrides.counter ?? 0, 0);
    const attested = overrides.omitAttestedCredentialData !== true;
    const lengthBytes = Buffer.alloc(2);
    lengthBytes.writeUInt16BE(credentialId.length, 0);
    const authData = Buffer.concat([
      sha256(overrides.rpId ?? options.rp.id),
      Buffer.from([this.flags(overrides, attested)]),
      counterBytes,
      ...(attested ? [Buffer.alloc(16), lengthBytes, Buffer.from(credentialId), Buffer.from(overrides.coseKey ?? this.coseKey())] : []),
    ]);
    const attestationObject = cbor(
      new Map<number | string, Cbor>([
        ['fmt', overrides.fmt ?? 'none'],
        ['attStmt', overrides.attStmt ?? new Map<number | string, Cbor>()],
        ['authData', authData],
      ]),
    );
    return {
      id: b64url(credentialId),
      rawId: b64url(credentialId),
      type: 'public-key',
      clientExtensionResults: {},
      response: {
        clientDataJSON: b64url(this.clientData('webauthn.create', options.challenge, overrides)),
        attestationObject: b64url(attestationObject),
        transports: ['internal', 'hybrid'],
      },
    };
  }

  /** `navigator.credentials.get()`, answered. */
  assert(options: AuthenticationOptionsJSON, overrides: AssertionOverrides = {}): Record<string, unknown> {
    const counterBytes = Buffer.alloc(4);
    counterBytes.writeUInt32BE(this.nextCounter(overrides), 0);
    const authenticatorData = Buffer.concat([sha256(overrides.rpId ?? options.rpId), Buffer.from([this.flags(overrides, false)]), counterBytes]);
    const clientDataJSON = this.clientData('webauthn.get', options.challenge, overrides);
    let signature = sign('sha256', Buffer.concat([authenticatorData, sha256(clientDataJSON)]), this.privateKey);
    if (overrides.corruptSignature === true) {
      signature = Buffer.from(signature);
      signature[signature.length - 1] = (signature[signature.length - 1] ?? 0) ^ 0xff;
    }
    const userHandle = overrides.userHandle === undefined ? this.userHandle : overrides.userHandle;
    const id = overrides.credentialId ?? this.id;
    return {
      id,
      rawId: id,
      type: 'public-key',
      clientExtensionResults: {},
      response: {
        clientDataJSON: b64url(clientDataJSON),
        authenticatorData: b64url(authenticatorData),
        signature: b64url(signature),
        ...(userHandle === null || userHandle === undefined ? {} : { userHandle }),
      },
    };
  }
}

/** A COSE EC2 key whose coordinates are not a point on P-256. */
export function offCurveCoseKey(): Buffer {
  return cbor(
    new Map<number | string, Cbor>([
      [1, 2],
      [3, -7],
      [-1, 1],
      [-2, Buffer.alloc(32, 1)],
      [-3, Buffer.alloc(32, 2)],
    ]),
  );
}

/** A COSE EC2 key with a truncated coordinate. */
export function truncatedCoseKey(): Buffer {
  return cbor(
    new Map<number | string, Cbor>([
      [1, 2],
      [3, -7],
      [-1, 1],
      [-2, Buffer.alloc(31, 1)],
      [-3, Buffer.alloc(32, 2)],
    ]),
  );
}
