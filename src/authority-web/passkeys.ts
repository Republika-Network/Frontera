import type { AssertionOptionsJSON, CreationOptionsJSON } from './contracts.js';

/**
 * AUTH-04C — passkeys in the browser.
 *
 * The client asks the operating system's own passkey dialog
 * (`navigator.credentials.create()` / `.get()`) and translates between the
 * gateway's JSON (base64url binary fields) and the browser's binary API. It
 * never sees, collects or simulates biometric data: Face ID or a device code is
 * the authenticator's business, and the Host verifies only the WebAuthn
 * assertion. Exactly the fields AUTH-02 accepts are sent — nothing more.
 */

export function base64urlToBytes(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) throw new TypeError('Not base64url.');
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (value.length % 4)) % 4);
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export function bytesToBase64url(value: ArrayBuffer | ArrayBufferView): string {
  const bytes = value instanceof ArrayBuffer ? new Uint8Array(value) : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const buffer = (value: string): ArrayBuffer => {
  const bytes = base64urlToBytes(value);
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return copy;
};

/** The registration options the browser expects. `user.id` is the Host's opaque handle, decoded as bytes (never as text). */
export function toCreationOptions(options: CreationOptionsJSON): PublicKeyCredentialCreationOptions {
  return {
    rp: { id: options.rp.id, name: options.rp.name },
    user: { id: buffer(options.user.id), name: options.user.name, displayName: options.user.displayName },
    challenge: buffer(options.challenge),
    pubKeyCredParams: options.pubKeyCredParams.map((param) => ({ type: 'public-key', alg: param.alg })),
    timeout: options.timeout,
    attestation: 'none',
    excludeCredentials: options.excludeCredentials.map((entry) => ({ type: 'public-key', id: buffer(entry.id) })),
    authenticatorSelection: { residentKey: 'required', requireResidentKey: true, userVerification: 'required' },
  };
}

export function toRequestOptions(options: AssertionOptionsJSON): PublicKeyCredentialRequestOptions {
  return {
    rpId: options.rpId,
    challenge: buffer(options.challenge),
    timeout: options.timeout,
    userVerification: 'required',
    allowCredentials: options.allowCredentials.map((entry) => ({ type: 'public-key', id: buffer(entry.id) })),
  };
}

/** The structural shape of a browser credential this codec reads — the WebAuthn fields only. */
export interface BrowserCredential {
  readonly id: string;
  readonly rawId: ArrayBuffer;
  readonly type: string;
  readonly response: {
    readonly clientDataJSON: ArrayBuffer;
    readonly attestationObject?: ArrayBuffer;
    readonly authenticatorData?: ArrayBuffer;
    readonly signature?: ArrayBuffer;
    readonly userHandle?: ArrayBuffer | null;
    getTransports?: () => string[];
  };
}

/** A registration response in exactly the JSON shape AUTH-02 accepts. */
export function registrationJSON(credential: BrowserCredential): Readonly<Record<string, unknown>> {
  const { response } = credential;
  if (response.attestationObject === undefined) throw new PasskeyError('invalid', 'The authenticator returned no attestation.');
  const transports = typeof response.getTransports === 'function' ? response.getTransports().filter((entry) => ['ble', 'cable', 'hybrid', 'internal', 'nfc', 'smart-card', 'usb'].includes(entry)) : undefined;
  return {
    id: bytesToBase64url(credential.rawId),
    rawId: bytesToBase64url(credential.rawId),
    type: 'public-key',
    response: { clientDataJSON: bytesToBase64url(response.clientDataJSON), attestationObject: bytesToBase64url(response.attestationObject), ...(transports !== undefined && transports.length > 0 ? { transports } : {}) },
    clientExtensionResults: {},
  };
}

/** An assertion in exactly the JSON shape AUTH-02 accepts. */
export function assertionJSON(credential: BrowserCredential): Readonly<Record<string, unknown>> {
  const { response } = credential;
  if (response.authenticatorData === undefined || response.signature === undefined) throw new PasskeyError('invalid', 'The authenticator returned an incomplete assertion.');
  return {
    id: bytesToBase64url(credential.rawId),
    rawId: bytesToBase64url(credential.rawId),
    type: 'public-key',
    response: {
      clientDataJSON: bytesToBase64url(response.clientDataJSON),
      authenticatorData: bytesToBase64url(response.authenticatorData),
      signature: bytesToBase64url(response.signature),
      ...(response.userHandle !== undefined && response.userHandle !== null && response.userHandle.byteLength > 0 ? { userHandle: bytesToBase64url(response.userHandle) } : {}),
    },
    clientExtensionResults: {},
  };
}

export type PasskeyFailure = 'cancelled' | 'unsupported' | 'invalid-state' | 'security' | 'invalid' | 'failed';

/** Why the passkey dialog did not produce a credential. Never a reason to retry an old challenge automatically. */
export class PasskeyError extends Error {
  constructor(
    readonly failure: PasskeyFailure,
    message: string,
  ) {
    super(message);
    this.name = 'PasskeyError';
  }
}

/** The browser-facing port the controller uses. Tests provide their own at this boundary. */
export interface PasskeyPort {
  supported(): boolean;
  create(options: CreationOptionsJSON): Promise<Readonly<Record<string, unknown>>>;
  get(options: AssertionOptionsJSON): Promise<Readonly<Record<string, unknown>>>;
}

/** Maps a DOMException from the passkey dialog to a calm, actionable failure. */
export function classifyPasskeyError(error: unknown): PasskeyError {
  if (error instanceof PasskeyError) return error;
  const name = typeof error === 'object' && error !== null && typeof (error as { name?: unknown }).name === 'string' ? (error as { name: string }).name : '';
  switch (name) {
    case 'NotAllowedError':
    case 'AbortError':
      return new PasskeyError('cancelled', 'The passkey request was cancelled or timed out.');
    case 'NotSupportedError':
      return new PasskeyError('unsupported', 'This device or browser cannot use this passkey.');
    case 'InvalidStateError':
      return new PasskeyError('invalid-state', 'This authenticator already holds a passkey for this account.');
    case 'SecurityError':
      return new PasskeyError('security', 'The browser refused the passkey request for this site.');
    default:
      return new PasskeyError('failed', 'The passkey request did not complete.');
  }
}

/** The structural surface of `navigator.credentials` this client calls. */
export interface CredentialsContainerLike {
  create(options: { readonly publicKey: PublicKeyCredentialCreationOptions }): Promise<unknown>;
  get(options: { readonly publicKey: PublicKeyCredentialRequestOptions; readonly mediation?: 'optional' | 'required' }): Promise<unknown>;
}

function asCredential(value: unknown): BrowserCredential {
  if (typeof value !== 'object' || value === null || typeof (value as { id?: unknown }).id !== 'string') throw new PasskeyError('invalid', 'The authenticator returned no credential.');
  return value as BrowserCredential;
}

/** The browser implementation, over `navigator.credentials` and `window.PublicKeyCredential`. */
export function browserPasskeys(credentials: CredentialsContainerLike | undefined, publicKeyCredentialAvailable: boolean): PasskeyPort {
  return {
    supported: () => credentials !== undefined && publicKeyCredentialAvailable,
    async create(options) {
      if (credentials === undefined || !publicKeyCredentialAvailable) throw new PasskeyError('unsupported', 'This browser does not support passkeys.');
      try {
        return registrationJSON(asCredential(await credentials.create({ publicKey: toCreationOptions(options) })));
      } catch (error) {
        throw classifyPasskeyError(error);
      }
    },
    async get(options) {
      if (credentials === undefined || !publicKeyCredentialAvailable) throw new PasskeyError('unsupported', 'This browser does not support passkeys.');
      try {
        return assertionJSON(asCredential(await credentials.get({ publicKey: toRequestOptions(options), mediation: 'required' })));
      } catch (error) {
        throw classifyPasskeyError(error);
      }
    },
  };
}
