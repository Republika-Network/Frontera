import { randomBytes, type KeyObject } from 'node:crypto';
import { join } from 'node:path';

import { publicKeyPemOf } from '../conformance/signing.js';
import type { StatusProjectionDeps } from '../conformance/status-projection.js';
import { projectCredentialStatus } from '../conformance/status-projection.js';
import { createStatusRegistry, type OnlineStatusRequest, type StatusRegistry } from '../conformance/status-registry.js';
import { createStatusIssuerKeyRegistry, createSyntheticStatusSigner, statusIssuerKeyRecord, type StatusIssuerKeyRegistry, type SyntheticStatusSigner } from '../conformance/status-signer.js';
import { openStatusVerifierStore, verifyConformanceStatus, type StatusExpectation, type StatusVerdict, type StatusVerifierStore } from '../conformance/status-verifier.js';
import { ORG_A, T0, buildCircuit, testKey, type Circuit } from './conformance-support.js';

/**
 * RN-CONFORM-03 — SYNTHETIC STATUS HARNESS. TEST CODE ONLY.
 *
 * Builds the RN-CONFORM-02 circuit plus a synthetic status issuer: an isolated
 * signer holding derived test keys (never committed), its own journal file, a
 * status registry that holds no key, and verifiers with pinned keys and
 * durable high-water marks in their own files.
 */

export const ISSUER = 'republika-synthetic-status-issuer';
export const KEY_VALID_FROM = T0;
export const KEY_VALID_UNTIL = '2027-11-02T09:00:00.000Z';

/** The registry's requester key towards the signer: a deterministic, run-time-derived test key (never committed). */
export const requesterKey = (label = 'status-registry') => testKey(`status-requester:${label}`);

export interface StatusCircuit {
  readonly c: Circuit;
  readonly issuerKey: KeyObject;
  readonly signer: SyntheticStatusSigner;
  readonly registry: StatusRegistry;
  readonly projection: StatusProjectionDeps;
  readonly trusted: StatusIssuerKeyRegistry;
  readonly signerJournal: string;
  /** A registry with custom hooks/limits over the same store and signer. */
  registryWith(options: Partial<Parameters<typeof createStatusRegistry>[0]>): StatusRegistry;
  /** A new verifier store in its own file. */
  verifierStore(name?: string): StatusVerifierStore;
  expectation(credentialId: string, operation?: string): StatusExpectation;
  onlineRequest(credentialId: string, nonce?: string, overrides?: Partial<OnlineStatusRequest['expect']>, operation?: string): OnlineStatusRequest;
  verify(artifact: unknown, credentialId: string, mode: { kind: 'online'; nonce: string } | { kind: 'stapled' }, options?: { store?: StatusVerifierStore; operation?: string; trusted?: StatusIssuerKeyRegistry; expect?: Partial<StatusExpectation> }): StatusVerdict;
  cleanup(): void;
}

export const freshNonce = () => randomBytes(32).toString('base64url');

export function buildStatusCircuit(options: { readonly seed?: string; readonly signerKeys?: readonly { privateKey: KeyObject; validFrom: string; validUntil: string; revokedAt?: string | null }[]; readonly trusted?: StatusIssuerKeyRegistry } = {}): StatusCircuit {
  const c = buildCircuit(options.seed === undefined ? {} : { seed: options.seed });
  const issuerKey = testKey('status-issuer-1');
  const projection: StatusProjectionDeps = {
    get store() {
      return c.store;
    },
    profiles: c.profiles,
    registryPublicKeyPem: c.registryPublicKeyPem,
    coordinatorPublicKeyPem: c.coordinatorPublicKeyPem,
    humans: c.humansDirectory,
  };
  const signerJournal = join(c.dir, 'status-signer-journal.sqlite');
  const keys = options.signerKeys ?? [{ privateKey: issuerKey, validFrom: KEY_VALID_FROM, validUntil: KEY_VALID_UNTIL }];
  const signer = createSyntheticStatusSigner({
    issuer: ISSUER,
    keys,
    requesters: [{ id: 'status-registry', publicKeyPem: publicKeyPemOf(requesterKey()) }],
    clock: c.clock,
    journalPath: signerJournal,
    source: (credentialId, at) => projectCredentialStatus(projection, credentialId, at),
  });
  const base = { projection, clock: c.clock, signer, requester: { id: 'status-registry', key: requesterKey() }, issuer: ISSUER };
  const registry = createStatusRegistry(base);
  const trusted = options.trusted ?? createStatusIssuerKeyRegistry(keys.map((k) => statusIssuerKeyRecord(ISSUER, k.privateKey, k.validFrom, k.validUntil, k.revokedAt ?? null)));
  let verifiers = 0;
  const opened: StatusVerifierStore[] = [];
  const sc: StatusCircuit = {
    c,
    issuerKey,
    signer,
    registry,
    projection,
    trusted,
    signerJournal,
    registryWith: (o) => createStatusRegistry({ ...base, ...o }),
    verifierStore(name?: string) {
      verifiers += 1;
      const store = openStatusVerifierStore(join(c.dir, `${name ?? `verifier-${verifiers}`}.sqlite`), { create: true });
      opened.push(store);
      return store;
    },
    expectation(credentialId: string, operation = 'document.open'): StatusExpectation {
      const credential = c.store.findCredential(credentialId)!;
      return {
        credentialId,
        platformId: credential.platformId,
        organizationId: credential.organizationId,
        integrationId: credential.integrationId,
        integrationVersion: credential.integrationVersion,
        integrationDigest: credential.integrationDigest,
        profileId: credential.profileId,
        profileVersion: credential.profileVersion,
        profileDigest: credential.profileDigest,
        operation,
      };
    },
    onlineRequest(credentialId: string, nonce = freshNonce(), overrides = {}, operation = 'document.open'): OnlineStatusRequest {
      const credential = c.store.findCredential(credentialId);
      return {
        credentialId,
        nonce,
        expect: {
          platformId: credential?.platformId ?? 'platform-synthetic-alpha',
          organizationId: credential?.organizationId ?? ORG_A,
          integrationId: credential?.integrationId ?? 'integration-synthetic-alpha',
          integrationVersion: credential?.integrationVersion ?? 1,
          integrationDigest: credential?.integrationDigest ?? `sha256:${'0'.repeat(64)}`,
          profileId: credential?.profileId ?? 'rn.conformance.synthetic-circuit',
          profileVersion: credential?.profileVersion ?? '0.1.0',
          ...overrides,
        },
        operation,
      };
    },
    verify(artifact, credentialId, mode, o = {}) {
      return verifyConformanceStatus({
        artifact,
        expect: { ...sc.expectation(credentialId, o.operation), ...(o.expect ?? {}) },
        mode,
        trustedKeys: o.trusted ?? trusted,
        clock: c.clock,
        ...(o.store === undefined ? {} : { highWaterMark: o.store }),
      });
    },
    cleanup() {
      for (const s of opened.splice(0)) {
        try {
          s.close();
        } catch {
          // already closed
        }
      }
      signer.close();
      c.cleanup();
    },
  };
  return sc;
}

/** The text of an issued assertion, failing the test otherwise. */
export function assertionText(outcome: ReturnType<StatusRegistry['issueOnline']>): string {
  if (outcome.kind !== 'assertion') throw new Error(`expected an assertion, got ${outcome.kind}${outcome.kind === 'unavailable' ? `: ${outcome.reason} ${outcome.detail}` : ''}`);
  return outcome.text;
}
