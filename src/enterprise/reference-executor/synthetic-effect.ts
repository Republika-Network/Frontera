import { closeSync, constants, fsyncSync, lstatSync, openSync, realpathSync, writeSync } from 'node:fs';
import { join } from 'node:path';

import { canonicalSerialize } from '../governance-store/canonical-json.js';

/**
 * G-02C1B — the reference executor's one effect: a **synthetic deployment
 * record**, "synthetic release R was applied to synthetic target T", written
 * as one file in a directory fixed at boot. It is not a deployment. It opens no
 * socket, runs no command, starts no process, reads no credential, and
 * touches nothing outside that directory.
 *
 * ## Contained by construction
 *
 * - The directory comes from the closed configuration, never from a request.
 *   At boot it must be a real directory (not a symlink), its own canonical path
 *   (no symlinked ancestor) and writable by no group or other user. Its device
 *   and inode are recorded, and every attempt re-checks them first: a directory
 *   swapped for a symlink or another directory after boot is not written.
 * - The file name is the 64-hex capability id plus `.json`, checked again here:
 *   no separator, dot-segment or absolute path can be formed.
 * - The file is created with `O_CREAT | O_EXCL | O_NOFOLLOW`, so an existing
 *   file or a planted symlink is never followed and never overwritten.
 * - The record holds only verified, non-secret identifiers: no capability
 *   text, no credential, no request header or body.
 *
 * ## Claim first, checked here too
 *
 * The flow claims before it calls `apply`, and `apply` itself asks the ledger
 * (`durablyClaimed`) whether a durable claim in state `claimed` exists for the
 * capability before it creates the file. An effect without a committed claim
 * is refused here even if a caller gets the order wrong.
 *
 * ## What an observation means
 *
 * | Observation | Meaning |
 * |---|---|
 * | `not-attempted` | nothing was created: bad identifier, no durable claim, or the directory is not the one fixed at boot |
 * | `failed` | the exclusive create was refused (a record or link already holds that name); this attempt wrote nothing |
 * | `unknown` | the file was created and then a write, flush or close failed: a partial record may exist |
 * | `completed` | the whole record was written and flushed, and the directory flushed |
 */

export const SYNTHETIC_DEPLOYMENT_RECORD_FORMAT = 'frontera.synthetic-deployment-record.v1';

export type SyntheticEffectObservation = 'not-attempted' | 'failed' | 'unknown' | 'completed';

/** What the record states. Every field is a verified identifier or an instant the executor took itself. */
export interface SyntheticDeploymentInput {
  readonly executorId: string;
  readonly audience: string;
  readonly issuer: string;
  readonly capabilityId: string;
  readonly executionId: string;
  /** The verified `synthetic.*` action: the synthetic release operation. */
  readonly operation: string;
  /** The verified resource: the synthetic target. */
  readonly target: string;
  /** The digest of the binding this executor rebuilt from the request it received. */
  readonly bindingDigest: string;
  readonly claimedAt: string;
  readonly attemptedAt: string;
}

export interface SyntheticDeploymentEffect {
  readonly outputDirectory: string;
  /** Exactly one attempt. `duringEffect` runs once, between the first and the second half of the write (CI crash injection). */
  apply(input: SyntheticDeploymentInput, duringEffect?: () => void): SyntheticEffectObservation;
}

export class SyntheticOutputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SyntheticOutputError';
  }
}

const CAPABILITY_ID = /^[0-9a-f]{64}$/;
const { O_WRONLY, O_CREAT, O_EXCL, O_NOFOLLOW, O_RDONLY } = constants;

interface DirectoryIdentity {
  readonly dev: number;
  readonly ino: number;
}

/** The directory's identity if it is a real, canonical, private directory; otherwise `undefined`. Never follows a final symlink. */
function directoryIdentity(path: string): DirectoryIdentity | undefined {
  try {
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return undefined;
    if (realpathSync(path) !== path) return undefined;
    if ((stat.mode & 0o022) !== 0) return undefined;
    return { dev: stat.dev, ino: stat.ino };
  } catch {
    return undefined;
  }
}

function writeAll(fd: number, bytes: Buffer): void {
  let offset = 0;
  while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset);
}

/**
 * Opens the synthetic effect over `outputDirectory`, refusing at boot a
 * directory that is missing, a symlink, reached through a symlink, or
 * writable by others. `durablyClaimed(capabilityId)` must answer from the
 * consumption ledger.
 */
export function openSyntheticDeploymentEffect(options: { readonly outputDirectory: string; readonly durablyClaimed: (capabilityId: string) => boolean }): SyntheticDeploymentEffect {
  const outputDirectory = options.outputDirectory;
  const durablyClaimed = options.durablyClaimed;
  const flags = O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW;
  if (typeof O_NOFOLLOW !== 'number' || typeof O_EXCL !== 'number') throw new SyntheticOutputError('This platform cannot create a file without following links; the synthetic effect refuses to run here.');
  const identity = directoryIdentity(outputDirectory);
  if (identity === undefined) throw new SyntheticOutputError('The synthetic output directory must be an existing, canonical directory that no other user can write; refusing it.');
  const fixed: DirectoryIdentity = identity;

  function apply(input: SyntheticDeploymentInput, duringEffect?: () => void): SyntheticEffectObservation {
    const capabilityId = input.capabilityId;
    if (typeof capabilityId !== 'string' || !CAPABILITY_ID.test(capabilityId)) return 'not-attempted';
    let claimed: boolean;
    try {
      claimed = durablyClaimed(capabilityId);
    } catch {
      claimed = false;
    }
    if (!claimed) return 'not-attempted';
    const current = directoryIdentity(outputDirectory);
    const sameDirectory = current !== undefined && current.dev === fixed.dev && current.ino === fixed.ino;
    if (!sameDirectory) return 'not-attempted';

    const record = Buffer.from(
      `${canonicalSerialize({
        format: SYNTHETIC_DEPLOYMENT_RECORD_FORMAT,
        executorId: input.executorId,
        audience: input.audience,
        issuer: input.issuer,
        capabilityId,
        executionId: input.executionId,
        operation: input.operation,
        target: input.target,
        bindingDigest: input.bindingDigest,
        claimedAt: input.claimedAt,
        attemptedAt: input.attemptedAt,
        observed: 'applied',
      })}\n`,
      'utf8',
    );

    // The real effect starts here: the one exclusive create.
    let fd: number;
    try {
      fd = openSync(join(outputDirectory, `${capabilityId}.json`), flags, 0o600);
    } catch {
      return 'failed';
    }
    try {
      const half = Math.floor(record.length / 2);
      writeAll(fd, record.subarray(0, half));
      duringEffect?.();
      writeAll(fd, record.subarray(half));
      fsyncSync(fd);
    } catch {
      try {
        closeSync(fd);
      } catch {
        // The descriptor is already gone; the record's state is unknown either way.
      }
      return 'unknown';
    }
    try {
      closeSync(fd);
      const directory = openSync(outputDirectory, O_RDONLY);
      try {
        fsyncSync(directory);
      } finally {
        closeSync(directory);
      }
    } catch {
      return 'unknown';
    }
    return 'completed';
  }

  return Object.freeze({ outputDirectory, apply });
}
