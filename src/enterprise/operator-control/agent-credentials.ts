import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import type { CustomerPrincipal, DynamicCustomerCredentialResult, DynamicCustomerCredentialVerifier } from '../customer-identity/contracts.js';
import type { ControlPlaneStore } from './control-plane-store.js';

/**
 * CTRL-02 — operator-issued agent credentials for the customer plane.
 *
 * ```
 * fra1.<credentialId>.<secret>
 * ```
 *
 * - `credentialId` — `agc-` and 32 lowercase hex digits: a random, non-secret
 *   handle, so a presented credential is looked up by id and compared once
 *   rather than against every stored verifier.
 * - `secret` — 32 bytes from the CSPRNG (256 bits), base64url. Revealed once,
 *   in the response that creates it, and never stored, logged or returned
 *   again.
 * - **Verifier** — SHA-256 of the secret. A fast hash is a sufficient verifier
 *   *because* the secret is 256 bits of uniform randomness: there is no
 *   dictionary to search, so a slow password hash would buy nothing. A store
 *   reader holds verifiers, which do not authenticate. Compared with
 *   `timingSafeEqual` over fixed-length digests.
 *
 * Not a JWT and not a capability: the credential says *who is calling* (one
 * principal → one external subject → one Kernel-Authority actor). What that
 * actor may do is decided by the Kernel against Kernel Authority, every time.
 */

export const AGENT_CREDENTIAL_SCHEME = 'fra1';
export const AGENT_PRINCIPAL_PREFIX = 'agent:';
const CREDENTIAL_ID = /^agc-[0-9a-f]{32}$/;
const SECRET = /^[A-Za-z0-9_-]{43}$/;
const TOKEN = /^fra1\.(agc-[0-9a-f]{32})\.([A-Za-z0-9_-]{43})$/;

export function isAgentCredentialId(value: string): boolean {
  return CREDENTIAL_ID.test(value);
}

export function newAgentCredentialId(): string {
  return `agc-${randomBytes(16).toString('hex')}`;
}

export function newAgentCredentialSecret(): string {
  return randomBytes(32).toString('base64url');
}

export function formatAgentCredential(credentialId: string, secret: string): string {
  if (!CREDENTIAL_ID.test(credentialId) || !SECRET.test(secret)) throw new Error('formatAgentCredential: malformed credential parts.');
  return `${AGENT_CREDENTIAL_SCHEME}.${credentialId}.${secret}`;
}

/** Splits a presented bearer token, or `undefined` when it is not an agent credential. Strict: one shape, no normalization. */
export function parseAgentCredential(token: string): { readonly credentialId: string; readonly secret: string } | undefined {
  const match = TOKEN.exec(token);
  if (match?.[1] === undefined || match[2] === undefined) return undefined;
  return { credentialId: match[1], secret: match[2] };
}

export function agentCredentialVerifier(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}

function verifierMatches(secret: string, verifier: string): boolean {
  const presented = Buffer.from(agentCredentialVerifier(secret), 'hex');
  const stored = Buffer.from(verifier, 'hex');
  return presented.length === 32 && stored.length === 32 && timingSafeEqual(presented, stored);
}

/** The agent principal id for an actor. Deterministic, so a principal is never minted twice for one actor. */
export function agentPrincipalIdFor(actorId: string): string {
  return `${AGENT_PRINCIPAL_PREFIX}${actorId}`;
}

/**
 * The customer-admission port over the control-plane store: presented token →
 * the principal it authenticates, or a refusal. Reads one row by credential
 * id, scoped to the served organization; a credential of another organization,
 * a revoked credential and a wrong secret are all the same `refused`.
 */
export function createAgentCredentialVerifier(store: Pick<ControlPlaneStore, 'readAgentCredentialForVerification'>, organizationId: string): DynamicCustomerCredentialVerifier {
  return Object.freeze({
    async authenticate(token: string): Promise<DynamicCustomerCredentialResult> {
      const parsed = parseAgentCredential(token);
      if (parsed === undefined) return { status: 'refused' };
      let record;
      try {
        record = await store.readAgentCredentialForVerification(organizationId, parsed.credentialId);
      } catch {
        return { status: 'unavailable' };
      }
      if (record === undefined) return { status: 'refused' };
      // The secret is compared even for a revoked credential, so timing does not reveal its status.
      const matches = verifierMatches(parsed.secret, record.verifier);
      if (!matches || record.credential.status !== 'active') return { status: 'refused' };
      if (record.credential.organizationId !== organizationId || record.principal.organizationId !== organizationId || record.principal.principalId !== record.credential.principalId) {
        return { status: 'unavailable' };
      }
      const principal: CustomerPrincipal = Object.freeze({
        plane: 'customer',
        principalId: record.principal.principalId,
        organizationId,
        externalSubject: Object.freeze({ system: record.principal.externalSubject.system, subjectId: record.principal.externalSubject.subjectId }),
      });
      return Object.freeze({ status: 'authenticated', principal, actorId: record.principal.actorId });
    },
  });
}
