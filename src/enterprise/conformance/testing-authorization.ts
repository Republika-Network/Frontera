import { conformanceDigest } from './canonical.js';
import { CHALLENGE_TYPES, isDigest, isIdentifier, isSemver, isTimestamp, readClosed, toMs, type ChallengeType } from './contracts.js';

/**
 * RN-CONFORM-07 — authoritative testing authorization (contract).
 *
 * A testing authorization is the ONLY thing that can make a challenge issuable or an observation acceptable. It is a
 * closed, canonical record approved by two humans of the integration's OWN organization (`testing.authorize`), stored
 * immutably in the conformance store, and bound to exactly one integration version, one purpose, an explicit list of
 * operations, challenge types and synthetic fixtures, a validity window and probe limits. There is no wildcard, no
 * URL, no default scope and no update: a different scope is a NEW authorization (new id, `supersedes` the old one,
 * version + 1, fresh approval), and the old one must already be revoked.
 *
 * Lifecycle: PROPOSED (the prepared, unstored record two humans sign) → ACTIVE (stored with two consumed decisions) →
 * REVOKED (one protective, terminal event). An expired authorization is ineligible without any event.
 *
 * Purposes never mix: evidence gathered under `VALIDATOR_REQUALIFICATION` is permanently ineligible for credential
 * conformance; an integration that ever had a requalification authorization can never be credentialed.
 */

export const TESTING_AUTHORIZATION_PURPOSES = Object.freeze(['CONFORMANCE', 'VALIDATOR_REQUALIFICATION'] as const);
export type TestingAuthorizationPurpose = (typeof TESTING_AUTHORIZATION_PURPOSES)[number];

/** Bounds on what an authorization may grant (synthetic scope). */
export const TESTING_AUTHORIZATION_LIMITS = Object.freeze({
  maxValiditySeconds: 90 * 86_400,
  maxChallengesPerHour: 10_000,
  maxConcurrentChallenges: 1_000,
  maxTotalChallenges: 1_000_000,
  maxListEntries: 64,
});
/** Integration-wide admission ceiling, across all authorizations (enforced by trigger). */
export const MAX_CHALLENGES_PER_INTEGRATION_PER_HOUR = 10_000;

export interface TestingAuthorizationRecord {
  readonly schema: 'rn.conformance.testing-authorization/2';
  readonly authorizationId: string;
  readonly version: number;
  readonly supersedes: string | null;
  readonly organizationId: string;
  readonly platformId: string;
  readonly integrationId: string;
  readonly integrationVersion: number;
  readonly integrationDigest: string;
  readonly profileId: string;
  readonly profileVersion: string;
  readonly purpose: TestingAuthorizationPurpose;
  readonly environment: 'synthetic';
  readonly fixtureRefs: readonly string[];
  readonly operations: readonly string[];
  readonly challengeTypes: readonly ChallengeType[];
  readonly notBefore: string;
  readonly notAfter: string;
  readonly maxChallengesPerHour: number;
  readonly maxConcurrentChallenges: number;
  readonly maxTotalChallenges: number | null;
  readonly synthetic: true;
}

export type TestingAuthorizationInput = Omit<TestingAuthorizationRecord, 'schema' | 'environment' | 'synthetic' | 'version' | 'platformId' | 'integrationId' | 'integrationVersion' | 'profileId' | 'profileVersion'>;

const INPUT_FIELDS = ['authorizationId', 'supersedes', 'organizationId', 'integrationDigest', 'purpose', 'fixtureRefs', 'operations', 'challengeTypes', 'notBefore', 'notAfter', 'maxChallengesPerHour', 'maxConcurrentChallenges', 'maxTotalChallenges'] as const;
const OPERATION = /^[a-z][a-z0-9.-]{0,63}$/;

const sortedUnique = <T extends string>(values: unknown, ok: (v: unknown) => v is T): readonly T[] | null => {
  if (!Array.isArray(values) || values.length === 0 || values.length > TESTING_AUTHORIZATION_LIMITS.maxListEntries) return null;
  if (!values.every(ok) || new Set(values).size !== values.length) return null;
  return Object.freeze([...(values as T[])].sort());
};
const boundedInt = (v: unknown, max: number) => Number.isSafeInteger(v) && (v as number) >= 1 && (v as number) <= max;

/** Reads a caller's input strictly (closed shape, explicit lists, no wildcard). Returns null when malformed. */
export function readTestingAuthorizationInput(value: unknown): TestingAuthorizationInput | null {
  const read = readClosed(value, INPUT_FIELDS);
  if (!read.ok) return null;
  const r = read.record;
  const fixtureRefs = sortedUnique(r['fixtureRefs'], isIdentifier);
  const operations = sortedUnique(r['operations'], (v): v is string => typeof v === 'string' && OPERATION.test(v));
  const challengeTypes = sortedUnique(r['challengeTypes'], (v): v is ChallengeType => typeof v === 'string' && (CHALLENGE_TYPES as readonly string[]).includes(v));
  const purpose = r['purpose'];
  const ok =
    isIdentifier(r['authorizationId']) && (r['supersedes'] === null || isIdentifier(r['supersedes'])) && r['supersedes'] !== r['authorizationId'] && isIdentifier(r['organizationId']) &&
    isDigest(r['integrationDigest']) && typeof purpose === 'string' && (TESTING_AUTHORIZATION_PURPOSES as readonly string[]).includes(purpose) && fixtureRefs !== null && operations !== null &&
    challengeTypes !== null && isTimestamp(r['notBefore']) && isTimestamp(r['notAfter']) && toMs(r['notAfter'] as string) > toMs(r['notBefore'] as string) &&
    toMs(r['notAfter'] as string) - toMs(r['notBefore'] as string) <= TESTING_AUTHORIZATION_LIMITS.maxValiditySeconds * 1000 &&
    boundedInt(r['maxChallengesPerHour'], TESTING_AUTHORIZATION_LIMITS.maxChallengesPerHour) && boundedInt(r['maxConcurrentChallenges'], TESTING_AUTHORIZATION_LIMITS.maxConcurrentChallenges) &&
    (r['maxTotalChallenges'] === null || boundedInt(r['maxTotalChallenges'], TESTING_AUTHORIZATION_LIMITS.maxTotalChallenges));
  if (!ok) return null;
  return Object.freeze({
    authorizationId: r['authorizationId'] as string,
    supersedes: r['supersedes'] as string | null,
    organizationId: r['organizationId'] as string,
    integrationDigest: r['integrationDigest'] as string,
    purpose: purpose as TestingAuthorizationPurpose,
    fixtureRefs: fixtureRefs as readonly string[],
    operations: operations as readonly string[],
    challengeTypes: challengeTypes as readonly ChallengeType[],
    notBefore: r['notBefore'] as string,
    notAfter: r['notAfter'] as string,
    maxChallengesPerHour: r['maxChallengesPerHour'] as number,
    maxConcurrentChallenges: r['maxConcurrentChallenges'] as number,
    maxTotalChallenges: r['maxTotalChallenges'] as number | null,
  });
}

/** The canonical digest humans approve and the store pins. */
export const testingAuthorizationDigest = (record: TestingAuthorizationRecord): string => conformanceDigest(record);

/** True when a stored record is a well-formed `/2` authorization record (re-checked on every read). */
export function isTestingAuthorizationRecord(value: unknown): value is TestingAuthorizationRecord {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  const input = readTestingAuthorizationInput(
    Object.fromEntries(INPUT_FIELDS.map((k) => [k, v[k]])),
  );
  return (
    input !== null && v['schema'] === 'rn.conformance.testing-authorization/2' && v['environment'] === 'synthetic' && v['synthetic'] === true && Number.isSafeInteger(v['version']) && (v['version'] as number) >= 1 &&
    isIdentifier(v['platformId']) && isIdentifier(v['integrationId']) && Number.isSafeInteger(v['integrationVersion']) && isIdentifier(v['profileId']) && isSemver(v['profileVersion']) &&
    Object.keys(v).length === INPUT_FIELDS.length + 9
  );
}
