import { createPublicKey, type JsonWebKey } from 'node:crypto';

import { HumanIdentityError } from './contracts.js';
import type { RelyingPartyConfiguration } from './relying-party.js';

/**
 * AUTH-02 — the WebAuthn verification boundary.
 *
 * Every cryptographic and protocol check is made by `@simplewebauthn/server`
 * (an established, maintained implementation; see
 * docs/security/AUTH-02-HUMAN-PASSKEY-IDENTITY.md for the dependency
 * assessment): challenge, RP ID hash, origin, ceremony type, user presence,
 * user verification, attestation statement, credential public key decoding,
 * signature and authenticator flags. Nothing here re-implements a
 * cryptographic primitive.
 *
 * What this file adds is policy, before and after the library:
 *
 * - strict response shape (only base64url strings where the protocol has
 *   bytes; nothing else accepted);
 * - client data refused when it is cross-origin or names a top origin: the
 *   Authority surface is never embedded;
 * - the origin must be on the configured allow-list (also checked by the
 *   library);
 * - user verification is always required;
 * - the public key algorithm is one of ES256, EdDSA, RS256 (no post-quantum or
 *   other algorithms the rest of the platform has not qualified);
 * - a registered public key must import as a valid key through Node's own
 *   `crypto.createPublicKey` (curve point validation, RSA ≥ 2048 bits), so a
 *   malformed key is refused at registration, not at first use.
 *
 * The library is loaded lazily, as the platform's other optional runtime
 * packages are: a Host that never composes human identity never loads it.
 */

// Types are taken from the import() expressions themselves, so the type-level
// and runtime resolutions of the package (ESM, from this CommonJS build) agree.
const importServer = () => import('@simplewebauthn/server');
const importHelpers = () => import('@simplewebauthn/server/helpers');
type WebAuthnServer = Awaited<ReturnType<typeof importServer>>;

let server: ReturnType<typeof importServer> | undefined;
let helpers: ReturnType<typeof importHelpers> | undefined;
const loadServer = (): ReturnType<typeof importServer> => (server ??= importServer());
const loadHelpers = (): ReturnType<typeof importHelpers> => (helpers ??= importHelpers());

/** COSE algorithm identifiers accepted: EdDSA, ES256, RS256. */
export const SUPPORTED_COSE_ALGORITHMS: readonly number[] = Object.freeze([-8, -7, -257]);

const BASE64URL = /^[A-Za-z0-9_-]+$/;
const MAX_FIELD = 16_384;

export interface RegistrationResponse {
  readonly id: string;
  readonly rawId: string;
  readonly type: 'public-key';
  readonly response: { readonly clientDataJSON: string; readonly attestationObject: string; readonly transports?: readonly string[] };
}

export interface AuthenticationResponse {
  readonly id: string;
  readonly rawId: string;
  readonly type: 'public-key';
  readonly response: { readonly clientDataJSON: string; readonly authenticatorData: string; readonly signature: string; readonly userHandle?: string };
}

export interface ClientData {
  readonly type: string;
  readonly challenge: string;
  readonly origin: string;
}

const TRANSPORTS = new Set(['ble', 'cable', 'hybrid', 'internal', 'nfc', 'smart-card', 'usb']);

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function bytesField(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_FIELD && BASE64URL.test(value);
}

function onlyKeys(value: Readonly<Record<string, unknown>>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function refuse(code: 'HUMAN_IDENTITY_REGISTRATION_INVALID' | 'HUMAN_IDENTITY_AUTHENTICATION_INVALID', message: string): never {
  throw new HumanIdentityError(code, message);
}

/** A registration response in exactly the WebAuthn JSON shape, or a refusal. */
export function parseRegistrationResponse(value: unknown): RegistrationResponse {
  const code = 'HUMAN_IDENTITY_REGISTRATION_INVALID';
  if (!isRecord(value) || !onlyKeys(value, ['id', 'rawId', 'type', 'response', 'clientExtensionResults', 'authenticatorAttachment'])) refuse(code, 'The registration response is not a WebAuthn credential object.');
  const id = value['id'];
  const response = value['response'];
  if (!bytesField(id) || value['rawId'] !== id || value['type'] !== 'public-key' || !isRecord(response)) return refuse(code, 'The registration response has a malformed id, rawId, type or response.');
  if (!onlyKeys(response, ['clientDataJSON', 'attestationObject', 'transports', 'authenticatorData', 'publicKey', 'publicKeyAlgorithm'])) refuse(code, 'The attestation response carries unexpected fields.');
  const clientDataJSON = response['clientDataJSON'];
  const attestationObject = response['attestationObject'];
  if (!bytesField(clientDataJSON) || !bytesField(attestationObject)) return refuse(code, 'The attestation response must carry base64url clientDataJSON and attestationObject.');
  const transports = response['transports'];
  if (transports !== undefined && (!Array.isArray(transports) || transports.length > TRANSPORTS.size || !transports.every((entry) => typeof entry === 'string' && TRANSPORTS.has(entry)))) refuse(code, 'The attestation response lists unknown transports.');
  return {
    id,
    rawId: id,
    type: 'public-key',
    response: {
      clientDataJSON,
      attestationObject,
      ...(transports === undefined ? {} : { transports: [...(transports as string[])].sort() }),
    },
  };
}

/** An authentication response in exactly the WebAuthn JSON shape, or a refusal. */
export function parseAuthenticationResponse(value: unknown): AuthenticationResponse {
  const code = 'HUMAN_IDENTITY_AUTHENTICATION_INVALID';
  if (!isRecord(value) || !onlyKeys(value, ['id', 'rawId', 'type', 'response', 'clientExtensionResults', 'authenticatorAttachment'])) refuse(code, 'The authentication response is not a WebAuthn credential object.');
  const id = value['id'];
  const response = value['response'];
  if (!bytesField(id) || value['rawId'] !== id || value['type'] !== 'public-key' || !isRecord(response)) return refuse(code, 'The authentication response has a malformed id, rawId, type or response.');
  if (!onlyKeys(response, ['clientDataJSON', 'authenticatorData', 'signature', 'userHandle'])) refuse(code, 'The assertion response carries unexpected fields.');
  const clientDataJSON = response['clientDataJSON'];
  const authenticatorData = response['authenticatorData'];
  const signature = response['signature'];
  if (!bytesField(clientDataJSON) || !bytesField(authenticatorData) || !bytesField(signature)) return refuse(code, 'The assertion response must carry base64url clientDataJSON, authenticatorData and signature.');
  const userHandle = response['userHandle'];
  if (userHandle !== undefined && userHandle !== null && !bytesField(userHandle)) refuse(code, 'The assertion userHandle is malformed.');
  return {
    id,
    rawId: id,
    type: 'public-key',
    response: {
      clientDataJSON,
      authenticatorData,
      signature,
      ...(typeof userHandle === 'string' ? { userHandle } : {}),
    },
  };
}

/**
 * Decodes client data for policy checks made before the library: ceremony
 * type, not cross-origin, no top origin, origin on the allow-list. The library
 * re-checks type, origin and challenge against the same expectations.
 */
export function clientDataOf(clientDataJSON: string, expectedType: 'webauthn.create' | 'webauthn.get', relyingParty: RelyingPartyConfiguration): ClientData {
  const code = expectedType === 'webauthn.create' ? 'HUMAN_IDENTITY_REGISTRATION_INVALID' : 'HUMAN_IDENTITY_AUTHENTICATION_INVALID';
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(clientDataJSON, 'base64url').toString('utf8'));
  } catch {
    return refuse(code, 'The client data is not JSON.');
  }
  if (!isRecord(parsed)) return refuse(code, 'The client data is not an object.');
  const type = parsed['type'];
  const challenge = parsed['challenge'];
  const origin = parsed['origin'];
  if (typeof type !== 'string' || type !== expectedType) return refuse(code, `The client data is not a ${expectedType} ceremony.`);
  if (typeof challenge !== 'string' || !BASE64URL.test(challenge)) return refuse(code, 'The client data carries no well-formed challenge.');
  if (typeof origin !== 'string' || !relyingParty.allowedOrigins.includes(origin)) return refuse(code, 'The client data origin is not an allowed origin.');
  if (parsed['crossOrigin'] === true || parsed['topOrigin'] !== undefined) refuse(code, 'A cross-origin or embedded ceremony is refused.');
  return { type, challenge, origin };
}

export interface VerifiedRegistration {
  readonly credentialId: string;
  /** The COSE public key, base64url. */
  readonly publicKey: string;
  readonly counter: number;
  readonly deviceType: 'singleDevice' | 'multiDevice';
  readonly backedUp: boolean;
  readonly attestationFormat: string;
  readonly aaguid: string;
  readonly origin: string;
}

/** Library verification of a registration, then the key-import check. Every failure is `HUMAN_IDENTITY_REGISTRATION_INVALID`. */
export async function verifyRegistration(response: RegistrationResponse, expectedChallenge: string, relyingParty: RelyingPartyConfiguration): Promise<VerifiedRegistration> {
  const code = 'HUMAN_IDENTITY_REGISTRATION_INVALID';
  const library = await loadServer();
  let result: Awaited<ReturnType<WebAuthnServer['verifyRegistrationResponse']>>;
  try {
    result = await library.verifyRegistrationResponse({
      response: { id: response.id, rawId: response.rawId, type: 'public-key', clientExtensionResults: {}, response: { clientDataJSON: response.response.clientDataJSON, attestationObject: response.response.attestationObject } },
      expectedChallenge,
      expectedOrigin: [...relyingParty.allowedOrigins],
      expectedRPID: relyingParty.rpId,
      expectedType: 'webauthn.create',
      requireUserPresence: true,
      requireUserVerification: true,
      supportedAlgorithmIDs: [...SUPPORTED_COSE_ALGORITHMS],
    });
  } catch (error) {
    return refuse(code, `The registration did not verify: ${(error as Error).message}`);
  }
  if (!result.verified) return refuse(code, 'The registration did not verify.');
  const info = result.registrationInfo;
  if (!info.userVerified) refuse(code, 'The authenticator did not verify the user.');
  if (info.rpID !== undefined && info.rpID !== relyingParty.rpId) refuse(code, 'The registration names another relying party.');
  if (info.credential.id !== response.id) refuse(code, 'The attested credential id is not the response id.');
  const publicKey = Uint8Array.from(info.credential.publicKey);
  await assertImportablePublicKey(publicKey, code);
  return {
    credentialId: info.credential.id,
    publicKey: Buffer.from(publicKey).toString('base64url'),
    counter: info.credential.counter,
    deviceType: info.credentialDeviceType,
    backedUp: info.credentialBackedUp,
    attestationFormat: info.fmt,
    aaguid: info.aaguid,
    origin: info.origin,
  };
}

export interface VerifiedAssertion {
  readonly counter: number;
  readonly deviceType: 'singleDevice' | 'multiDevice';
  readonly backedUp: boolean;
  readonly origin: string;
}

/**
 * Library verification of an assertion: challenge, origin, RP ID hash, user
 * presence and verification, and the signature over the stored public key.
 *
 * The stored counter is deliberately **not** handed to the library: the
 * caller applies the counter rule after the signature has verified, so a
 * counter that did not advance is attributable to a genuine signature (a
 * possible cloned authenticator) rather than to unauthenticated input.
 */
export async function verifyAssertion(response: AuthenticationResponse, expectedChallenge: string, credential: { readonly credentialId: string; readonly publicKey: string }, relyingParty: RelyingPartyConfiguration): Promise<VerifiedAssertion> {
  const code = 'HUMAN_IDENTITY_AUTHENTICATION_INVALID';
  const library = await loadServer();
  let result: Awaited<ReturnType<WebAuthnServer['verifyAuthenticationResponse']>>;
  try {
    result = await library.verifyAuthenticationResponse({
      response: {
        id: response.id,
        rawId: response.rawId,
        type: 'public-key',
        clientExtensionResults: {},
        response: {
          clientDataJSON: response.response.clientDataJSON,
          authenticatorData: response.response.authenticatorData,
          signature: response.response.signature,
          ...(response.response.userHandle === undefined ? {} : { userHandle: response.response.userHandle }),
        },
      },
      expectedChallenge,
      expectedOrigin: [...relyingParty.allowedOrigins],
      expectedRPID: relyingParty.rpId,
      expectedType: 'webauthn.get',
      requireUserVerification: true,
      credential: { id: credential.credentialId, publicKey: Uint8Array.from(Buffer.from(credential.publicKey, 'base64url')), counter: 0 },
    });
  } catch (error) {
    return refuse(code, `The assertion did not verify: ${(error as Error).message}`);
  }
  if (result.verified !== true) return refuse(code, 'The assertion signature did not verify.');
  const info = result.authenticationInfo;
  if (!info.userVerified) refuse(code, 'The authenticator did not verify the user.');
  if (info.rpID !== relyingParty.rpId) refuse(code, 'The assertion names another relying party.');
  return { counter: info.newCounter, deviceType: info.credentialDeviceType, backedUp: info.credentialBackedUp, origin: info.origin };
}

function bytesOf(value: unknown): Uint8Array | undefined {
  return value instanceof Uint8Array ? value : undefined;
}

/**
 * The stored public key must decode (by the library's COSE decoder) to an
 * accepted algorithm and import through Node's own key parser: a P-256 point
 * on the curve, an Ed25519 key, or an RSA key of at least 2048 bits.
 */
async function assertImportablePublicKey(cose: Uint8Array, code: 'HUMAN_IDENTITY_REGISTRATION_INVALID'): Promise<void> {
  const library = await loadHelpers();
  let key: { get(label: number): unknown };
  try {
    key = library.decodeCredentialPublicKey(Uint8Array.from(cose)) as unknown as { get(label: number): unknown };
  } catch (error) {
    return refuse(code, `The credential public key does not decode: ${(error as Error).message}`);
  }
  const kty = key.get(1);
  const alg = key.get(3);
  let jwk: JsonWebKey;
  if (kty === 2 && alg === -7) {
    const x = bytesOf(key.get(-2));
    const y = bytesOf(key.get(-3));
    if (key.get(-1) !== 1 || x === undefined || y === undefined || x.length !== 32 || y.length !== 32) return refuse(code, 'The ES256 public key is not a P-256 point.');
    jwk = { kty: 'EC', crv: 'P-256', x: Buffer.from(x).toString('base64url'), y: Buffer.from(y).toString('base64url') };
  } else if (kty === 1 && alg === -8) {
    const x = bytesOf(key.get(-2));
    if (key.get(-1) !== 6 || x === undefined || x.length !== 32) return refuse(code, 'The EdDSA public key is not an Ed25519 key.');
    jwk = { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(x).toString('base64url') };
  } else if (kty === 3 && alg === -257) {
    const n = bytesOf(key.get(-1));
    const e = bytesOf(key.get(-2));
    if (n === undefined || e === undefined || n.length < 256) return refuse(code, 'The RS256 public key is not an RSA key of at least 2048 bits.');
    jwk = { kty: 'RSA', n: Buffer.from(n).toString('base64url'), e: Buffer.from(e).toString('base64url') };
  } else {
    return refuse(code, 'The credential public key is not of an accepted algorithm.');
  }
  try {
    createPublicKey({ key: jwk, format: 'jwk' });
  } catch (error) {
    refuse(code, `The credential public key is not a valid key: ${(error as Error).message}`);
  }
}

/** The authenticator data signature counter (bytes 33–36, big-endian), read only to apply the counter rule after the library has verified the assertion. */
export function signatureCounterOf(authenticatorData: string): number {
  const bytes = Buffer.from(authenticatorData, 'base64url');
  if (bytes.length < 37) throw new HumanIdentityError('HUMAN_IDENTITY_AUTHENTICATION_INVALID', 'The authenticator data is too short.');
  return bytes.readUInt32BE(33);
}
