import { Wallet } from 'xrpl';

import { XrplTransportConfigurationError, type XrplSignedTransaction, type XrplTransactionSigner } from './contracts.js';

/**
 * An `XrplTransactionSigner` backed by a seed held in the process environment
 * (ANDREW-P0-08 Testnet demo only). Replaceable by a KMS-, HSM- or
 * hardware-backed signer with the same two members.
 *
 * The seed is read once, at construction, from the named variable; the wallet
 * lives only in this closure. Nothing here returns, logs or stringifies it:
 * the signer object has no enumerable key material, every error is a fixed
 * phrase, and `sign` returns only the blob and the hash.
 */
export interface EnvXrplSignerOptions {
  readonly environment: Readonly<Record<string, string | undefined>>;
  /** The name of the variable holding the seed. Never the seed. */
  readonly seedVariable: string;
  /** The account the signer is expected to sign for; a seed for any other account is refused. */
  readonly expectedAccount: string;
}

export function createEnvXrplSigner(options: EnvXrplSignerOptions): XrplTransactionSigner {
  const seed = options.environment[options.seedVariable];
  if (typeof seed !== 'string' || seed.length === 0) throw new XrplTransportConfigurationError('The XRPL signer seed variable is not set.');
  let wallet: Wallet;
  try {
    wallet = Wallet.fromSeed(seed);
  } catch {
    throw new XrplTransportConfigurationError('The XRPL signer seed could not be read.');
  }
  if (wallet.classicAddress !== options.expectedAccount) throw new XrplTransportConfigurationError('The XRPL signer seed does not belong to the configured source account.');
  const account = wallet.classicAddress;

  async function sign(prepared: Readonly<Record<string, unknown>>): Promise<XrplSignedTransaction> {
    try {
      const signed = wallet.sign(prepared as Parameters<Wallet['sign']>[0]);
      return Object.freeze({ txBlob: signed.tx_blob, hash: signed.hash });
    } catch {
      throw new Error('The XRPL signer refused to sign the prepared transaction.');
    }
  }

  return Object.freeze({ account, sign });
}
