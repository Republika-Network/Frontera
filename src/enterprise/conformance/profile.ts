import { conformanceDigest } from './canonical.js';
import { compareSemver, isSemver, type ChallengeType } from './contracts.js';

/**
 * RN-CONFORM-02 / WP-03 — code-level conformance profile definitions, pinned
 * by digest.
 *
 * Three things must not be confused (mission WP-03):
 *
 * 1. **A profile definition used by synthetic tests** — the only thing this
 *    module provides.
 * 2. A public normative protocol specification — does not exist; its home is
 *    the open decision CC-D-09. Nothing here is published or registered
 *    anywhere outside this process.
 * 3. A commercially active profile — does not exist. Every definition carries
 *    `normative: false` and `commercialActivation: false`, and nothing reads
 *    those fields as permission.
 *
 * Two definitions are pinned:
 *
 * - `rn.conformance.integration@0.1.0` — the RN-CONFORM-01 provisional draft
 *   (`CONFORMANCE_PROFILE_DRAFT.md` §3), restated as data. It requires G03 and
 *   G04 challenges, a human data-minimization review (CR-11) and a defined SDK
 *   (CC-D-10, open). The synthetic circuit implements none of those, so a
 *   credential under this profile **cannot** reach ACTIVE here; a test proves
 *   that.
 * - `rn.conformance.synthetic-circuit@0.1.0` — a separate synthetic test
 *   profile with **accurately declared coverage**: the six challenge-backed
 *   critical requirements this mission implements (CR-01, 02, 05, 06, 07, 08)
 *   plus the deterministic CR-09 (freshness) and CR-12 (SDK range). CR-03,
 *   CR-04, CR-10 and CR-11 are listed as *not covered*, never as passed.
 *   ACTIVE under this profile means only "the synthetic circuit's covered
 *   requirements were satisfied by synthetic validators".
 */

export type RequirementEvaluation = 'validator-corroborated' | 'deterministic-freshness' | 'deterministic-sdk' | 'deterministic-dispute' | 'human-review' | 'unimplemented-challenge';

export interface ConformanceRequirementDefinition {
  readonly requirementId: string;
  readonly title: string;
  readonly type: 'M' | 'D' | 'H' | 'M+D';
  readonly severity: 'critical' | 'significant' | 'informational';
  readonly challengeType: ChallengeType | 'G03' | 'G04' | 'G09' | 'G10' | null;
  readonly freshnessSeconds: number | null;
  readonly evaluation: RequirementEvaluation;
}

export interface ConformanceProfileDefinition {
  readonly schema: 'rn.conformance.profile/1';
  readonly profileId: string;
  readonly profileVersion: string;
  readonly designation: 'provisional-draft' | 'synthetic-test-only';
  readonly normative: false;
  readonly commercialActivation: false;
  readonly source: string;
  readonly derivedFrom: { readonly profileId: string; readonly profileVersion: string } | null;
  readonly corroboration: {
    readonly minDistinctOperators: number;
    readonly windowSeconds: number;
    readonly disputeResolutionOperators: number;
    readonly investigationTimeoutSeconds: number;
  };
  readonly freshnessGraceSeconds: number;
  readonly credentialTermSeconds: number;
  readonly candidateTermSeconds: number;
  readonly suspensionRevocationSeconds: number;
  readonly supportedSdk: { readonly package: string; readonly minVersion: string; readonly maxVersionExclusive: string } | null;
  readonly requirements: readonly ConformanceRequirementDefinition[];
  readonly notCovered: readonly { readonly requirementId: string; readonly reason: string }[];
}

const DAY = 86_400;
const HOUR = 3_600;

/** CC-D-03 (approved for RN-CONFORM-02): k = 2 distinct operators, 30 min window, ≥ 3 operators to resolve a dispute; T_confirm 30 min. */
const CC_D_03 = Object.freeze({ minDistinctOperators: 2, windowSeconds: 1_800, disputeResolutionOperators: 3, investigationTimeoutSeconds: 1_800 });

const req = (
  requirementId: string,
  title: string,
  type: ConformanceRequirementDefinition['type'],
  severity: ConformanceRequirementDefinition['severity'],
  challengeType: ConformanceRequirementDefinition['challengeType'],
  freshnessSeconds: number | null,
  evaluation: RequirementEvaluation,
): ConformanceRequirementDefinition => Object.freeze({ requirementId, title, type, severity, challengeType, freshnessSeconds, evaluation });

const CR = Object.freeze({
  '01': req('CR-01', 'A covered operation without a valid authorization decision is refused.', 'M', 'critical', 'G01', DAY, 'validator-corroborated'),
  '02': req('CR-02', 'After effective revocation the operation is refused within the propagation interval.', 'M', 'critical', 'G02', DAY, 'validator-corroborated'),
  '03': req('CR-03', 'Every in-scope interface enforces the same decision.', 'M', 'critical', 'G03', 7 * DAY, 'unimplemented-challenge'),
  '04': req('CR-04', 'Protected assets are not retrievable through storage routes that bypass enforcement.', 'M', 'critical', 'G04', 7 * DAY, 'unimplemented-challenge'),
  '05': req('CR-05', 'Authorization decisions are not reused beyond freshness ceilings.', 'M', 'critical', 'G05', DAY, 'validator-corroborated'),
  '06': req('CR-06', 'A principal of organization A cannot act on resources of organization B.', 'M', 'critical', 'G06', DAY, 'validator-corroborated'),
  '07': req('CR-07', 'When the authorization dependency fails, the operation fails closed.', 'M', 'critical', 'G07', 7 * DAY, 'validator-corroborated'),
  '08': req('CR-08', 'The observed deployment digest equals the credentialed digest.', 'M+D', 'critical', 'G08', DAY, 'validator-corroborated'),
  '09': req('CR-09', 'Required evidence for every critical requirement is fresher than its window.', 'D', 'critical', 'G09', null, 'deterministic-freshness'),
  '10': req('CR-10', 'Independent observations for a control do not conflict.', 'D', 'significant', 'G10', null, 'deterministic-dispute'),
  '11': req('CR-11', 'Data minimization of evidence packages and denial responses.', 'H', 'significant', null, 90 * DAY, 'human-review'),
  '12': req('CR-12', 'SDK version is within the supported range and not downgraded.', 'D', 'critical', 'G08', DAY, 'deterministic-sdk'),
});

const TERMS = Object.freeze({ freshnessGraceSeconds: 6 * HOUR, credentialTermSeconds: 90 * DAY, candidateTermSeconds: 30 * DAY, suspensionRevocationSeconds: 30 * DAY });

export const RN_CONFORMANCE_INTEGRATION_PROFILE_V0_1: ConformanceProfileDefinition = Object.freeze({
  schema: 'rn.conformance.profile/1',
  profileId: 'rn.conformance.integration',
  profileVersion: '0.1.0',
  designation: 'provisional-draft',
  normative: false,
  commercialActivation: false,
  source: 'docs/architecture/continuous-conformance/CONFORMANCE_PROFILE_DRAFT.md',
  derivedFrom: null,
  corroboration: CC_D_03,
  ...TERMS,
  // CC-D-10 is open: no "Sovereign Access SDK" is defined, so no SDK range can be stated.
  supportedSdk: null,
  requirements: Object.freeze([CR['01'], CR['02'], CR['03'], CR['04'], CR['05'], CR['06'], CR['07'], CR['08'], CR['09'], CR['10'], CR['11'], CR['12']]),
  notCovered: Object.freeze([]),
});

export const RN_CONFORMANCE_SYNTHETIC_CIRCUIT_PROFILE_V0_1: ConformanceProfileDefinition = Object.freeze({
  schema: 'rn.conformance.profile/1',
  profileId: 'rn.conformance.synthetic-circuit',
  profileVersion: '0.1.0',
  designation: 'synthetic-test-only',
  normative: false,
  commercialActivation: false,
  source: 'docs/architecture/continuous-conformance/RN_CONFORM_02_IMPLEMENTATION.md',
  derivedFrom: Object.freeze({ profileId: 'rn.conformance.integration', profileVersion: '0.1.0' }),
  corroboration: CC_D_03,
  ...TERMS,
  supportedSdk: Object.freeze({ package: '@republika-synthetic/conformance-fixture-sdk', minVersion: '1.0.0', maxVersionExclusive: '2.0.0' }),
  requirements: Object.freeze([CR['01'], CR['02'], CR['05'], CR['06'], CR['07'], CR['08'], CR['09'], CR['12']]),
  notCovered: Object.freeze([
    Object.freeze({ requirementId: 'CR-03', reason: 'No G03 alternative-interface fixture exists in RN-CONFORM-02 (RN-CONFORM-04).' }),
    Object.freeze({ requirementId: 'CR-04', reason: 'No G04 direct-storage fixture exists in RN-CONFORM-02 (RN-CONFORM-04).' }),
    Object.freeze({ requirementId: 'CR-10', reason: 'Disputes are handled inside the corroboration rule of each covered requirement; no separate CR-10 result is produced.' }),
    Object.freeze({ requirementId: 'CR-11', reason: 'Human data-minimization review is not implemented.' }),
  ]),
});

/** Golden digests (aoc-canonical-json/1). Changing a definition without a new version must fail this pin. */
export const PINNED_PROFILE_DIGESTS: Readonly<Record<string, string>> = Object.freeze({
  'rn.conformance.integration@0.1.0': 'sha256:c3fa6377c7482b10bb51b24f83a8f1e7491147b3562bb54eb3456e64e2ac3e43',
  'rn.conformance.synthetic-circuit@0.1.0': 'sha256:89ff278a2b9c0061e6a3f509382570baa388dcd46b5422b7cd827c7076b1a432',
});

export const BUILT_IN_PROFILES: readonly ConformanceProfileDefinition[] = Object.freeze([RN_CONFORMANCE_INTEGRATION_PROFILE_V0_1, RN_CONFORMANCE_SYNTHETIC_CIRCUIT_PROFILE_V0_1]);

export function profileKey(profileId: string, profileVersion: string): string {
  return `${profileId}@${profileVersion}`;
}

export function profileDigest(definition: ConformanceProfileDefinition): string {
  return conformanceDigest(definition);
}

export type ProfileResolution =
  | { readonly ok: true; readonly definition: ConformanceProfileDefinition; readonly digest: string }
  | { readonly ok: false; readonly reason: 'UNKNOWN_PROFILE' | 'PROFILE_DIGEST_MISMATCH' | 'PROFILE_MALFORMED' };

export interface ConformanceProfileRegistry {
  resolve(profileId: string, profileVersion: string, expectedDigest?: string): ProfileResolution;
  /** Admits a definition only if its digest equals the pin for its id and version. */
  admit(definition: ConformanceProfileDefinition): ProfileResolution;
  keys(): readonly string[];
}

/**
 * A content-addressed profile registry. `pins` maps `id@version` to the only
 * digest that version may have; `definitions` are admitted against it. An
 * unpinned version is unknown; a pinned version with a different definition
 * is refused. `additionalPins`/`additionalDefinitions` exist so tests can
 * exercise downgrade with a second version; they are not a production path.
 */
export function createConformanceProfileRegistry(options: {
  readonly additionalPins?: Readonly<Record<string, string>>;
  readonly additionalDefinitions?: readonly ConformanceProfileDefinition[];
} = {}): ConformanceProfileRegistry {
  const pins = new Map<string, string>(Object.entries({ ...PINNED_PROFILE_DIGESTS, ...(options.additionalPins ?? {}) }));
  const admitted = new Map<string, { definition: ConformanceProfileDefinition; digest: string }>();

  const admit = (definition: ConformanceProfileDefinition): ProfileResolution => {
    let digest: string;
    try {
      if (definition.schema !== 'rn.conformance.profile/1' || !isSemver(definition.profileVersion)) return { ok: false, reason: 'PROFILE_MALFORMED' };
      digest = profileDigest(definition);
    } catch {
      return { ok: false, reason: 'PROFILE_MALFORMED' };
    }
    const key = profileKey(definition.profileId, definition.profileVersion);
    const pin = pins.get(key);
    if (pin === undefined) return { ok: false, reason: 'UNKNOWN_PROFILE' };
    if (pin !== digest) return { ok: false, reason: 'PROFILE_DIGEST_MISMATCH' };
    const existing = admitted.get(key);
    if (existing !== undefined && existing.digest !== digest) return { ok: false, reason: 'PROFILE_DIGEST_MISMATCH' };
    admitted.set(key, { definition, digest });
    return { ok: true, definition, digest };
  };

  for (const definition of [...BUILT_IN_PROFILES, ...(options.additionalDefinitions ?? [])]) {
    const result = admit(definition);
    if (!result.ok) throw new Error(`Profile ${profileKey(definition.profileId, definition.profileVersion)} does not match its pinned digest (${result.reason}).`);
  }

  return Object.freeze({
    admit,
    keys: () => Object.freeze([...admitted.keys()].sort()),
    resolve(profileId: string, profileVersion: string, expectedDigest?: string): ProfileResolution {
      const found = admitted.get(profileKey(profileId, profileVersion));
      if (found === undefined) return { ok: false, reason: 'UNKNOWN_PROFILE' };
      if (expectedDigest !== undefined && expectedDigest !== found.digest) return { ok: false, reason: 'PROFILE_DIGEST_MISMATCH' };
      return { ok: true, definition: found.definition, digest: found.digest };
    },
  });
}

/** Whether `version` of `pkg` is inside the profile's supported SDK range. A profile with no defined SDK (CC-D-10 open) supports none. */
export function sdkSupported(definition: ConformanceProfileDefinition, pkg: string, version: string): boolean {
  const range = definition.supportedSdk;
  if (range === null || pkg !== range.package || !isSemver(version)) return false;
  return compareSemver(version, range.minVersion) >= 0 && compareSemver(version, range.maxVersionExclusive) < 0;
}
