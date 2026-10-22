import { randomBytes } from 'node:crypto';

import type { BoundedGrant, GrantRevocation } from '../../features/grant-runtime/index.js';
import type { AuthoritySignature } from '../authority-authenticity/authority-signature.js';
import {
  assessExecutionCapabilityIssuance,
  createExecutionCapabilityIssuancePolicy,
  executionCapabilityGrantReferenceV2,
  isExecutionCapabilityGrantReferenceNonce,
  type ExecutionCapabilityIssuanceFailure,
  type ExecutionCapabilityIssuancePolicy,
} from '../authority-authenticity/execution-capability-issuance.js';
import type { AuthorityArtifactSigner } from '../authority-authenticity/signer.js';
import type { AuthorityArtifactVerifier } from '../authority-authenticity/verifier.js';
import { EXECUTION_CAPABILITY_FORMAT, isExecutionCapabilityIdentifier, isWellFormedExecutionCapability, serializeExecutionCapability, type ExecutionCapability } from '../execution-capability/capability.js';
import type { ExecutionCapabilityIssuanceLedger, ExecutionCapabilityIssuanceState } from './issuance-ledger.js';

/**
 * G-02B — the Host-side issuer of generic execution capabilities.
 *
 * It is not an authority of its own and cannot mint one. For one execution it:
 *
 * 1. refuses if the issuance ledger already holds a row for it — in whatever
 *    state: a capability identity may exist, and there is never a second;
 * 2. reads the grant through the **authenticated durable** grant store
 *    (signature, digest, signed revocation state and the CORE-07 freshness
 *    the deployment composes, verified on that read) and refuses an absent or
 *    revoked grant — revocation is decided here, not in custody;
 * 3. assembles the capability from its own policy, the verified grant, a
 *    fresh capability id and a fresh grant-reference nonce, and applies the
 *    custody issuance rule locally (a refusal costs no custody call);
 * 4. **reserves** it — the full canonical text, the grant identity and the
 *    nonce — durably in the issuance ledger, before custody is asked;
 * 5. asks the composed custody boundary **once**, which re-applies the rule
 *    against its own policy and key;
 * 6. verifies the returned signature locally under the active key, then
 *    commits it (`issued`). Any failure after the reservation settles the row
 *    `uncertain` (or leaves it `reserved` when the process stops), and the
 *    execution is never issued again — no retry that could mint a second
 *    identity.
 *
 * It never presents, transmits or delivers a capability: it returns one to
 * its in-process caller. Which caller, and where in the execution path, is
 * G-02C. Reached only through the write-once slot below, which the Host
 * composition binds; an unbound slot refuses.
 */

export interface ExecutionCapabilityIssuanceInput {
  /** The governed execution. Custody accepts only the id derived from the grant's own request and decision. */
  readonly executionId: string;
  readonly boundedGrantId: string;
  /** A registered executor. */
  readonly audience: string;
  readonly action: string;
  readonly resource: string;
  /** The adapter-defined binding format (registered for the audience) and the digest of the exact request. */
  readonly actionBinding: { readonly format: string; readonly digest: string };
}

export interface IssuedExecutionCapability {
  readonly capability: ExecutionCapability;
  /** The canonical text: exactly the bytes (after the domain prefix) the signature covers. */
  readonly canonical: string;
  readonly signature: AuthoritySignature;
}

export interface ExecutionCapabilityIssuer {
  issue(input: ExecutionCapabilityIssuanceInput): Promise<IssuedExecutionCapability>;
  /** The issuance ledger's state for an execution: `absent` (never requested), `reserved` (outcome unknown), `uncertain` (possibly signed) or `issued`. */
  inspect(executionId: string): ExecutionCapabilityIssuanceState | 'absent';
}

/** The authenticated read the issuer needs: the grant as filed, its revocation, its store id and its verified signature. */
export interface ExecutionCapabilitySignedGrantReader {
  readSigned(grantId: string): Promise<{ readonly storeId: string; readonly grant?: BoundedGrant; readonly revocation?: GrantRevocation; readonly signature?: AuthoritySignature }>;
}

export const EXECUTION_CAPABILITY_ISSUER_FAILURES = [
  'CAPABILITY_ISSUER_UNBOUND',
  'CAPABILITY_ISSUER_UNSUPPORTED',
  'CAPABILITY_REQUEST_INVALID',
  'CAPABILITY_LEDGER_UNAVAILABLE',
  /** The execution already has a committed capability. Delivery is not this component's (G-02C). */
  'CAPABILITY_ALREADY_ISSUED',
  /** The execution has a reserved or uncertain row: a capability may exist. Never issued again. */
  'CAPABILITY_OUTCOME_UNKNOWN',
  'CAPABILITY_GRANT_UNAVAILABLE',
  'CAPABILITY_GRANT_NOT_FOUND',
  'CAPABILITY_GRANT_REVOKED',
  'CAPABILITY_REFUSED',
  /** Custody was asked and did not return a signature. It may have signed. */
  'CAPABILITY_SIGNING_UNCERTAIN',
  /** Custody returned a signature that does not verify under the active key. Discarded; the row is uncertain. */
  'CAPABILITY_SIGNATURE_INVALID',
  /** A verified signature could not be committed. The row stays reserved: outcome unknown. */
  'CAPABILITY_RECORD_FAILED',
] as const;
export type ExecutionCapabilityIssuerFailure = (typeof EXECUTION_CAPABILITY_ISSUER_FAILURES)[number];

/** Whether the custody boundary may have been asked when the failure happened. */
export type ExecutionCapabilityCustodyExposure = 'never-requested' | 'possibly-requested';

export class ExecutionCapabilityIssuanceError extends Error {
  readonly code: ExecutionCapabilityIssuerFailure;
  readonly custody: ExecutionCapabilityCustodyExposure;
  /** The issuance rule's own reason, when the rule refused. */
  readonly rule: ExecutionCapabilityIssuanceFailure | undefined;

  constructor(code: ExecutionCapabilityIssuerFailure, custody: ExecutionCapabilityCustodyExposure, message: string, rule?: ExecutionCapabilityIssuanceFailure) {
    super(message);
    this.name = 'ExecutionCapabilityIssuanceError';
    this.code = code;
    this.custody = custody;
    this.rule = rule;
  }
}

export interface ExecutionCapabilityIssuerOptions {
  readonly grants: ExecutionCapabilitySignedGrantReader;
  readonly signer: AuthorityArtifactSigner;
  /** The deployment's trusted verifier — the same one its stores read with. */
  readonly verifier: AuthorityArtifactVerifier;
  /** The Host's copy of the issuance policy. Custody enforces its own. */
  readonly policy: ExecutionCapabilityIssuancePolicy;
  readonly ledger: ExecutionCapabilityIssuanceLedger;
  readonly now?: () => number;
  /** Injected for qualification; default 32 random bytes as lowercase hex. */
  readonly capabilityId?: () => string;
  /** Injected for qualification; default 32 random bytes as lowercase hex. */
  readonly grantReferenceNonce?: () => string;
}

const DIGEST = /^sha256:[0-9a-f]{64}$/;

function wellFormedInput(input: unknown): input is ExecutionCapabilityIssuanceInput {
  if (input === null || typeof input !== 'object') return false;
  const value = input as Record<string, unknown>;
  const binding = value['actionBinding'] as Record<string, unknown> | null | undefined;
  return (
    isExecutionCapabilityIdentifier(value['executionId']) &&
    isExecutionCapabilityIdentifier(value['boundedGrantId']) &&
    isExecutionCapabilityIdentifier(value['audience']) &&
    isExecutionCapabilityIdentifier(value['action']) &&
    isExecutionCapabilityIdentifier(value['resource']) &&
    binding !== null &&
    typeof binding === 'object' &&
    isExecutionCapabilityIdentifier(binding['format']) &&
    typeof binding['digest'] === 'string' &&
    DIGEST.test(binding['digest'])
  );
}

export function createExecutionCapabilityIssuer(options: ExecutionCapabilityIssuerOptions): ExecutionCapabilityIssuer {
  const { grants, signer, verifier, ledger } = options;
  if (typeof grants?.readSigned !== 'function' || typeof signer?.activeKeyId !== 'string' || typeof verifier?.verifyExecutionCapability !== 'function' || typeof ledger?.reserve !== 'function') {
    throw new ExecutionCapabilityIssuanceError('CAPABILITY_REQUEST_INVALID', 'never-requested', 'The execution capability issuer needs an authenticated grant reader, the authority signer, the trusted verifier and the issuance ledger.');
  }
  const policy = createExecutionCapabilityIssuancePolicy(options.policy);
  if (ledger.issuer !== policy.issuer) {
    throw new ExecutionCapabilityIssuanceError('CAPABILITY_REQUEST_INVALID', 'never-requested', 'The execution capability issuance ledger is recorded for another issuer.');
  }
  const now = options.now ?? Date.now;
  const nextCapabilityId = options.capabilityId ?? (() => randomBytes(32).toString('hex'));
  const nextNonce = options.grantReferenceNonce ?? (() => randomBytes(32).toString('hex'));

  const fail = (code: ExecutionCapabilityIssuerFailure, custody: ExecutionCapabilityCustodyExposure, message: string, rule?: ExecutionCapabilityIssuanceFailure): never => {
    throw new ExecutionCapabilityIssuanceError(code, custody, message, rule);
  };

  function existingState(executionId: string): ExecutionCapabilityIssuanceState | 'absent' {
    try {
      return ledger.read(executionId).state;
    } catch {
      return fail('CAPABILITY_LEDGER_UNAVAILABLE', 'never-requested', 'The execution capability issuance ledger could not be read; no capability is issued.');
    }
  }

  function refuseExisting(state: ExecutionCapabilityIssuanceState): never {
    return state === 'issued'
      ? fail('CAPABILITY_ALREADY_ISSUED', 'never-requested', 'A capability was already issued for this execution; none is issued again.')
      : fail('CAPABILITY_OUTCOME_UNKNOWN', 'never-requested', 'A capability for this execution may exist (reserved or uncertain); none is issued again.');
  }

  /** Best effort: if even this write fails, the row stays `reserved` — outcome unknown — which refuses reissuance just the same. */
  function settleUncertain(capability: ExecutionCapability): void {
    try {
      ledger.markUncertain(capability.executionId, capability.capabilityId);
    } catch {
      // The reservation alone already prevents a second identity.
    }
  }

  return Object.freeze({
    inspect(executionId: string): ExecutionCapabilityIssuanceState | 'absent' {
      return existingState(executionId);
    },

    async issue(input: ExecutionCapabilityIssuanceInput): Promise<IssuedExecutionCapability> {
      const sign = signer.signExecutionCapability;
      if (typeof sign !== 'function') return fail('CAPABILITY_ISSUER_UNSUPPORTED', 'never-requested', 'The composed authority signer offers no execution capability operation; nothing is signed.');
      if (!wellFormedInput(input)) return fail('CAPABILITY_REQUEST_INVALID', 'never-requested', 'The execution capability request is not well formed; nothing is signed.');
      const before = existingState(input.executionId);
      if (before !== 'absent') return refuseExisting(before);

      let read: Awaited<ReturnType<ExecutionCapabilitySignedGrantReader['readSigned']>>;
      try {
        read = await grants.readSigned(input.boundedGrantId);
      } catch {
        return fail('CAPABILITY_GRANT_UNAVAILABLE', 'never-requested', 'The bounded grant could not be read and verified from the authenticated store; no capability is issued.');
      }
      if (read.grant === undefined || read.signature === undefined) return fail('CAPABILITY_GRANT_NOT_FOUND', 'never-requested', 'No authenticated bounded grant is filed under that id; no capability is issued.');
      if (read.revocation !== undefined) return fail('CAPABILITY_GRANT_REVOKED', 'never-requested', 'The bounded grant is revoked; no capability is issued.');

      const issuedAtMs = now();
      const expiresAtMs = Math.min(issuedAtMs + policy.lifetimeMs, Date.parse(read.grant.expiresAt));
      const grantReferenceNonce = nextNonce();
      if (!isExecutionCapabilityGrantReferenceNonce(grantReferenceNonce)) return fail('CAPABILITY_REQUEST_INVALID', 'never-requested', 'The grant-reference nonce source produced no 32-byte hex value; nothing is signed.');
      let grantReference: string;
      try {
        grantReference = executionCapabilityGrantReferenceV2({ nonce: grantReferenceNonce, grantStoreId: read.storeId, boundedGrantId: read.grant.id, grantDigest: read.grant.digest });
      } catch {
        return fail('CAPABILITY_REQUEST_INVALID', 'never-requested', 'The grant reference could not be derived; nothing is signed.');
      }
      const candidate = {
        format: EXECUTION_CAPABILITY_FORMAT,
        capabilityId: nextCapabilityId(),
        issuer: policy.issuer,
        issuerKeyId: signer.activeKeyId,
        organizationId: policy.organizationId,
        trustDomain: policy.trustDomain,
        audience: input.audience,
        subjectActorId: read.grant.subject,
        onBehalfOfActorId: null,
        action: input.action,
        resource: input.resource,
        actionBinding: { format: input.actionBinding.format, digest: input.actionBinding.digest },
        executionId: input.executionId,
        grantReference,
        consumption: 'single-use' as const,
        statusRequirement: 'offline-permitted' as const,
        issuedAt: new Date(issuedAtMs).toISOString(),
        expiresAt: Number.isFinite(expiresAtMs) && expiresAtMs > issuedAtMs ? new Date(expiresAtMs).toISOString() : '',
      };
      if (!isWellFormedExecutionCapability(candidate)) return fail('CAPABILITY_REQUEST_INVALID', 'never-requested', 'The requested capability is not well formed (or its grant has no remaining lifetime); nothing is signed.');
      const request = { capability: candidate, grant: read.grant, storeId: read.storeId, grantSignature: read.signature, grantReferenceNonce };
      // The same rule the custody boundary applies, here first: a refusal costs no custody call and leaves no record.
      const local = assessExecutionCapabilityIssuance(request, { verifyGrant: (grant, storeId, signature) => verifier.verifyGrant(grant, storeId, signature), activeKeyId: signer.activeKeyId, policy, now: issuedAtMs });
      if (!local.issuable) return fail('CAPABILITY_REFUSED', 'never-requested', `The bounded grant or the issuance policy does not authorize this capability (${local.failure}); nothing is signed.`, local.failure);
      const capability = local.capability;

      // The point of no return: durable before custody is asked.
      let reserved: ReturnType<ExecutionCapabilityIssuanceLedger['reserve']>;
      try {
        reserved = ledger.reserve({ capability, boundedGrantId: read.grant.id, grantStoreId: read.storeId, grantDigest: read.grant.digest, grantReferenceNonce });
      } catch {
        return fail('CAPABILITY_LEDGER_UNAVAILABLE', 'never-requested', 'The issuance could not be reserved durably; custody is not asked and nothing is signed.');
      }
      if (reserved.outcome === 'exists') return refuseExisting(reserved.record.state);

      let signature: AuthoritySignature;
      try {
        signature = await sign.call(signer, { ...request, capability });
      } catch {
        settleUncertain(capability);
        return fail('CAPABILITY_SIGNING_UNCERTAIN', 'possibly-requested', 'Custody did not return a signature for the reserved capability; it may have signed. The execution is never issued again.');
      }
      const verification = verifier.verifyExecutionCapability(capability, signature);
      if (!verification.verified || verification.keyId !== signer.activeKeyId) {
        settleUncertain(capability);
        return fail('CAPABILITY_SIGNATURE_INVALID', 'possibly-requested', 'The returned signature does not verify under the active authority key; it is discarded and the execution is never issued again.');
      }
      let committed: 'issued' | 'not-reserved';
      try {
        committed = ledger.markIssued(capability.executionId, capability.capabilityId, signature);
      } catch {
        committed = 'not-reserved';
      }
      if (committed !== 'issued') return fail('CAPABILITY_RECORD_FAILED', 'possibly-requested', 'A verified signature could not be committed; the reservation stands as outcome unknown and the capability is not released.');
      return Object.freeze({ capability, canonical: serializeExecutionCapability(capability), signature });
    },
  });

}

/**
 * The write-once seam between whatever G-02C composes as the caller and the
 * authority boundary the Host composition builds. The Host creates it, the
 * composition binds the issuer exactly once, and the Host refuses to serve if
 * it was never bound. Until then, and on a second bind, it refuses.
 */
export interface ExecutionCapabilityIssuerSlot extends ExecutionCapabilityIssuer {
  bind(issuer: ExecutionCapabilityIssuer): void;
  bound(): boolean;
}

export function createExecutionCapabilityIssuerSlot(): ExecutionCapabilityIssuerSlot {
  let target: ExecutionCapabilityIssuer | undefined;
  const unbound = (): never => {
    throw new ExecutionCapabilityIssuanceError('CAPABILITY_ISSUER_UNBOUND', 'never-requested', 'No execution capability issuer is composed; nothing is signed.');
  };
  return Object.freeze({
    bind(issuer: ExecutionCapabilityIssuer): void {
      if (target !== undefined) throw new ExecutionCapabilityIssuanceError('CAPABILITY_REQUEST_INVALID', 'never-requested', 'The execution capability issuer is bound exactly once.');
      if (typeof issuer?.issue !== 'function' || typeof issuer.inspect !== 'function') throw new ExecutionCapabilityIssuanceError('CAPABILITY_REQUEST_INVALID', 'never-requested', 'The execution capability issuer must implement issue and inspect.');
      target = issuer;
    },
    bound: () => target !== undefined,
    async issue(input: ExecutionCapabilityIssuanceInput): Promise<IssuedExecutionCapability> {
      if (target === undefined) return unbound();
      return target.issue(input);
    },
    inspect(executionId: string): ExecutionCapabilityIssuanceState | 'absent' {
      if (target === undefined) return unbound();
      return target.inspect(executionId);
    },
  });
}
