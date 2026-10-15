import { createHash } from 'node:crypto';

import { checkTradeAccountAddress } from '../../domain/index.js';

/**
 * Account-root readings the governed trade executor relies on (TRADE-04C) —
 * pure and total, over the `node` of a **validated** `ledger_entry` answer
 * for an `AccountRoot` (the shared transport's validated reader proves the
 * network, the validation and the ledger; this file only reads the entry).
 *
 * ## Delegate signing-key authority
 *
 * A delegated `OfferCreate` is signed by the **delegate** account. XLS-75's
 * `Delegate` entry says the delegate may send `OfferCreate` for the owner; it
 * says nothing about which key the delegate account accepts. The ledger rule
 * for a single signature is:
 *
 * - the account's **master** key — the key whose account id *is* the
 *   account — signs unless `lsfDisableMaster` is set; or
 * - the account's **regular** key — the key whose account id equals the
 *   account root's `RegularKey` — signs.
 *
 * So the pinned delegate key is authorized exactly when it is the master key
 * and the master key is not disabled, or it is the regular key. Anything else
 * — another key, a disabled master, an absent or malformed root, a root for
 * another account — is refused. Multisigning is out of contract (TRADE-04B).
 *
 * The account id of a public key is `RIPEMD160(SHA256(key))`, written as a
 * classic address (base58check, the XRP Ledger alphabet, type prefix 0). It is
 * derived here with `node:crypto` only, so no XRPL SDK importer is added; the
 * qualification compares it with the SDK's own derivation.
 *
 * ## Owner `Sequence`
 *
 * The owner's `Sequence` — the one a delegated transaction consumes — is the
 * owner root's `Sequence` at that validated ledger. Never the delegate's.
 */

/** `lsfDisableMaster`: the account's master key may not sign. */
export const XRPL_ACCOUNT_FLAG_DISABLE_MASTER = 0x0010_0000;

const ALPHABET = 'rpshnaf39wBUDNEGHJKLM4PQRST7VWXYZ2bcdeCg65jkm8oFqi1tuvAxyz';
const SIGNING_PUBLIC_KEY = /^(?:ED|0[23])[0-9A-F]{64}$/;
const UINT32_MAXIMUM = 0xffff_ffff;

function sha256(bytes: Uint8Array): Buffer {
  return createHash('sha256').update(bytes).digest();
}

function base58(bytes: Uint8Array): string {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  let out = '';
  while (value > 0n) {
    out = ALPHABET.charAt(parseInt((value % 58n).toString(10), 10)) + out;
    value /= 58n;
  }
  for (const byte of bytes) {
    if (byte !== 0) break;
    out = ALPHABET[0] + out;
  }
  return out;
}

/** The classic address of a 33-byte signing public key (uppercase hex), or `undefined` for anything that is not one. */
export function xrplAddressOfSigningPublicKey(publicKey: unknown): string | undefined {
  if (typeof publicKey !== 'string' || !SIGNING_PUBLIC_KEY.test(publicKey)) return undefined;
  const accountId = createHash('ripemd160').update(sha256(Buffer.from(publicKey, 'hex'))).digest();
  const payload = Buffer.concat([Buffer.from([0]), accountId]);
  const checksum = sha256(sha256(payload)).subarray(0, 4);
  return base58(Buffer.concat([payload, checksum]));
}

function field(record: unknown, name: string): unknown {
  if (record === null || typeof record !== 'object' || Array.isArray(record)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(record, name);
  return descriptor !== undefined && 'value' in descriptor ? descriptor.value : undefined;
}

const isUint32 = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= UINT32_MAXIMUM;

export const XRPL_DELEGATE_KEY_REFUSALS = Object.freeze({
  ROOT_MALFORMED: 'DELEGATE_ACCOUNT_ROOT_MALFORMED',
  ROOT_MISMATCH: 'DELEGATE_ACCOUNT_ROOT_MISMATCH',
  KEY_MALFORMED: 'DELEGATE_SIGNING_KEY_MALFORMED',
  MASTER_DISABLED: 'DELEGATE_MASTER_KEY_DISABLED',
  KEY_NOT_AUTHORIZED: 'DELEGATE_SIGNING_KEY_NOT_AUTHORIZED',
} as const);

export type XrplDelegateKeyRefusal = (typeof XRPL_DELEGATE_KEY_REFUSALS)[keyof typeof XRPL_DELEGATE_KEY_REFUSALS];

export type XrplDelegateKeyAuthority =
  | { readonly authorized: true; readonly via: 'master-key' | 'regular-key' }
  | { readonly authorized: false; readonly code: XrplDelegateKeyRefusal };

/**
 * Whether `signingPublicKey` may single-sign for `delegate`, from the
 * delegate's validated `AccountRoot` node. Total; refuses anything it cannot read.
 */
export function assessXrplDelegateSigningKey(node: unknown, expected: { readonly delegate: string; readonly signingPublicKey: string }): XrplDelegateKeyAuthority {
  const R = XRPL_DELEGATE_KEY_REFUSALS;
  const refuse = (code: XrplDelegateKeyRefusal): XrplDelegateKeyAuthority => Object.freeze({ authorized: false as const, code });
  const keyAddress = xrplAddressOfSigningPublicKey(expected?.signingPublicKey);
  if (keyAddress === undefined || checkTradeAccountAddress(expected.delegate) !== 'valid') return refuse(R.KEY_MALFORMED);
  if (field(node, 'LedgerEntryType') !== 'AccountRoot') return refuse(R.ROOT_MALFORMED);
  const account = field(node, 'Account');
  const flags = field(node, 'Flags');
  const regularKey = field(node, 'RegularKey');
  if (typeof account !== 'string' || !isUint32(flags) || (regularKey !== undefined && checkTradeAccountAddress(regularKey) !== 'valid')) return refuse(R.ROOT_MALFORMED);
  if (account !== expected.delegate) return refuse(R.ROOT_MISMATCH);
  if (keyAddress === account) {
    return (flags & XRPL_ACCOUNT_FLAG_DISABLE_MASTER) !== 0 ? refuse(R.MASTER_DISABLED) : Object.freeze({ authorized: true as const, via: 'master-key' as const });
  }
  if (regularKey !== undefined && keyAddress === regularKey) return Object.freeze({ authorized: true as const, via: 'regular-key' as const });
  return refuse(R.KEY_NOT_AUTHORIZED);
}

/** The owner's `Sequence` from its validated `AccountRoot` node, or `undefined` when the node is not the owner's root or carries no valid one. */
export function readXrplOwnerSequence(node: unknown, owner: string): number | undefined {
  if (field(node, 'LedgerEntryType') !== 'AccountRoot' || field(node, 'Account') !== owner) return undefined;
  const sequence = field(node, 'Sequence');
  return isUint32(sequence) && sequence > 0 ? sequence : undefined;
}
