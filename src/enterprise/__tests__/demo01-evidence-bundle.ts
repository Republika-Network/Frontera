import { createHash, createPublicKey, verify } from 'node:crypto';

import { EXECUTION_CAPABILITY_SIGNING_DOMAIN, parseExecutionCapability } from '../execution-capability/index.js';
import { EXECUTOR_RECEIPT_SIGNING_DOMAIN, createExecutorReceiptVerifier, parseExecutorReceipt } from '../executor-receipt/index.js';
import { AOC_CANONICALIZATION_VERSION, canonicalSerialize } from '../governance-store/canonical-json.js';

/**
 * DEMO-01A — `frontera.demo-evidence-bundle.v1`: what one CI run of the
 * reference implementation produced for the three demo scenarios, in a form a
 * public page can show and re-check. Test-only: nothing in `src/` outside
 * `__tests__` reads or writes it, and it changes no protocol contract — the
 * capability and receipt inside are the G-02A / G-02C1C artifacts verbatim
 * (their canonical text and their CORE-02 signature envelopes).
 *
 * ## Shape
 *
 * ```
 * { format, evidenceCanonicalization, evidenceDigest, evidence, provenance }
 * ```
 *
 * - `evidence` is everything the run produced, plus fixed classification text.
 * - `evidenceDigest` is `sha256:` of `aoc.canonical-json.v1(evidence)`. It
 *   describes the evidence payload only; `provenance` sits beside it, outside
 *   the digest, so nothing hashes itself.
 * - `provenance` is copied from the producing job's environment (commit, run).
 *   It is a claim inside the file: it is checked against GitHub (the run, its
 *   log, its artifact), never by this file's keys or digest.
 *
 * ## What the signatures prove, and what they do not
 *
 * The verification keys travel inside the bundle. Both are generated fresh by
 * the run and their private halves never leave it, but a key that arrives with
 * the artifact it verifies is not a root of trust: a valid signature shows that
 * the bytes are what the holder of that key signed — consistency — not who
 * holds it. Who produced the bundle is the CI run's provenance.
 *
 * ## Fail-closed
 *
 * {@link parseDemoEvidenceBundle} accepts only this closed shape: an unknown
 * field, a missing one, a wrong type or a field whose name suggests secret
 * material is a refusal. {@link verifyDemoEvidenceBundle} re-derives every
 * derived fact (digest, signatures, correlation, the certainty ladder) from
 * the recorded facts instead of trusting it. {@link sensitiveFindings} scans
 * the serialized text for secrets, keys, credentials and local paths.
 */

export const DEMO_EVIDENCE_BUNDLE_FORMAT = 'frontera.demo-evidence-bundle.v1';
export const DEMO_SCENARIO_IDS = Object.freeze(['authorized', 'blocked', 'uncertain'] as const);
export type DemoScenarioId = (typeof DEMO_SCENARIO_IDS)[number];

/** A CORE-02 signature envelope, verbatim: four strings. */
export interface DemoSignature {
  readonly algorithm: string;
  readonly artifactVersion: string;
  readonly keyId: string;
  readonly signature: string;
}

export interface DemoVerificationKey {
  readonly role: 'capability-issuer' | 'executor-receipt';
  /** The capability issuer, or the executor id. */
  readonly subject: string;
  readonly keyId: string;
  readonly algorithm: string;
  readonly publicKeyPem: string;
  /** The domain prefix the signed bytes start with; the canonical text follows it. */
  readonly signingDomain: string;
  readonly origin: 'ephemeral-key-generated-for-this-run';
}

export interface DemoRequest {
  readonly principalId: string;
  readonly agentActorId: string;
  readonly action: string;
  readonly resource: string;
  readonly parameters: { readonly releaseVersion: string };
}

export interface DemoHostResponse {
  readonly httpStatus: number;
  readonly status: string;
  readonly reasonCodes: readonly string[];
  readonly executionId: string | null;
  readonly replayed: boolean | null;
}

export interface DemoDecision {
  readonly decisionId: string;
  readonly status: string;
  readonly reasonCodes: readonly string[];
  /** The committed decision's policy checks that did not pass. */
  readonly failedChecks: readonly { readonly policyId: string; readonly reasonCode: string }[];
}

export interface DemoCapability {
  readonly issuanceState: string;
  readonly capabilityId: string;
  readonly executionId: string;
  readonly issuer: string;
  readonly issuerKeyId: string;
  readonly audience: string;
  readonly subjectActorId: string;
  readonly onBehalfOfActorId: string | null;
  readonly action: string;
  readonly resource: string;
  readonly actionBinding: { readonly format: string; readonly digest: string };
  readonly consumption: string;
  readonly statusRequirement: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  /** The exact canonical text that was signed, after {@link DemoVerificationKey.signingDomain}. */
  readonly canonical: string;
  readonly signature: DemoSignature;
}

export interface DemoObservation {
  readonly transmission: string;
  readonly httpStatus: number | null;
  readonly httpOutcome: string;
  readonly disposition: string;
  readonly failure: string | null;
  readonly receiptOutcome: string | null;
  readonly agreement: string;
}

export interface DemoSignedReceipt {
  readonly receipt: string;
  readonly signature: DemoSignature;
}

export interface DemoAcceptedReceipt extends DemoSignedReceipt {
  readonly receiptId: string;
  readonly digest: string;
  readonly outcome: string;
}

/** What the Host knew: its response, its committed decision, its issuance ledger and its receipt evidence store. */
export interface DemoHostFacts {
  readonly response: DemoHostResponse;
  readonly decision: DemoDecision;
  readonly capabilityIssued: DemoCapability | null;
  readonly issuanceRecordsAdded: number;
  readonly evidenceObservationsAdded: number;
  readonly observations: readonly DemoObservation[];
  readonly acceptedReceipts: readonly DemoAcceptedReceipt[];
}

/** What crossed the wire towards the executor, as the relay in front of it saw it. */
export interface DemoWireFacts {
  readonly requestsReachingExecutor: number;
  readonly presentationHeaders: number;
  /** Whether the one presented capability and signature are exactly the ones the Host's issuance ledger holds; `null` when nothing was presented. */
  readonly presentedCapabilityMatchesIssued: boolean | null;
}

/** What the executor's own durable state held after the run — read by the test harness, never known to the Host. */
export interface DemoExecutorFacts {
  readonly source: 'executor-durable-state-read-by-test-harness';
  readonly consumptionState: string | null;
  readonly outcomeRecorded: boolean | null;
  readonly syntheticEffectsAdded: number;
  /** The synthetic deployment record's exact text, when one was written. */
  readonly effectRecord: string | null;
  readonly receipts: readonly DemoSignedReceipt[];
}

export interface DemoResubmission {
  /** The same request, with the same idempotency key, sent to the Host again. */
  readonly status: string;
  readonly requestsReachingExecutorAdded: number;
  readonly syntheticEffectsAdded: number;
}

export interface DemoRepresentation {
  /** The exact bytes the executor received, written to it directly a second time. */
  readonly executorHttpStatus: number | null;
  readonly syntheticEffectsAdded: number;
}

export interface DemoCertainty {
  /** The Host issued a signed capability for this execution. */
  readonly authorized: boolean;
  /** The executor's durable state shows the capability consumed and one synthetic effect written. */
  readonly executedAtExecutor: boolean;
  /** The Host received the executor's response. */
  readonly observedByHost: boolean;
  /** The Host verified a signed receipt and correlated it with its own issuance. */
  readonly verifiedByHost: boolean;
  /** Verified, completed, and consistent with the Host's own outcome. Confirmed by reference evidence — never business settlement. */
  readonly confirmed: boolean;
  /** The Host's own conclusion: its governed-action status. */
  readonly hostConclusion: string;
}

export interface DemoScenario {
  readonly id: DemoScenarioId;
  readonly title: string;
  readonly request: DemoRequest;
  readonly host: DemoHostFacts;
  readonly wire: DemoWireFacts;
  readonly executor: DemoExecutorFacts;
  readonly resubmission: DemoResubmission;
  readonly representation: DemoRepresentation | null;
  readonly certainty: DemoCertainty;
}

export interface DemoEvidence {
  readonly classification: {
    readonly origin: 'reference-implementation-test-run';
    readonly data: 'synthetic';
    readonly production: false;
    readonly live: false;
    readonly effect: 'synthetic-deployment-record';
    readonly transport: 'loopback-http-without-tls';
    readonly statement: string;
  };
  readonly story: {
    readonly headline: string;
    readonly principalId: string;
    readonly agentActorId: string;
    readonly delegatedByActorId: string;
    readonly action: string;
    readonly delegatedResource: string;
    readonly undelegatedResource: string;
    readonly releaseVersion: string;
  };
  readonly verificationKeys: readonly DemoVerificationKey[];
  readonly scenarios: readonly DemoScenario[];
  readonly limitations: readonly string[];
}

export interface DemoProvenance {
  readonly source: 'github-actions' | 'local-test-run';
  readonly repository: string | null;
  /** The commit the job checked out (for a pull request, GitHub's merge commit). */
  readonly checkoutSha: string | null;
  /** The commit under review (a pull request's head), when the job was given it. */
  readonly headSha: string | null;
  readonly workflow: string | null;
  readonly job: string | null;
  readonly runId: string | null;
  readonly runAttempt: string | null;
  readonly runUrl: string | null;
  readonly generatedAt: string;
  readonly statement: string;
}

export interface DemoEvidenceBundle {
  readonly format: typeof DEMO_EVIDENCE_BUNDLE_FORMAT;
  readonly evidenceCanonicalization: typeof AOC_CANONICALIZATION_VERSION;
  readonly evidenceDigest: string;
  readonly evidence: DemoEvidence;
  readonly provenance: DemoProvenance;
}

export const DEMO_CLASSIFICATION_STATEMENT =
  'Recorded output of the Frontera reference implementation, captured by an automated test run: a real Host process path and a real executor process over loopback HTTP without TLS. Every identity, environment and effect is synthetic. Nothing was deployed, paid or sent to a production system, and no production signing key exists in this file.';

export const DEMO_PROVENANCE_STATEMENT =
  'These fields are copied from the environment of the job that produced the file. They are claims: check them against the run, its log and its artifact on GitHub. The digest and the keys in this file show internal consistency only; they do not authenticate GitHub, Frontera or the run as the producer.';

/** Reference limitations every presentation of this evidence must keep (G-02C1D security statement §1, §3, §8, §9). */
export const DEMO_LIMITATIONS: readonly string[] = Object.freeze([
  'Transport: loopback HTTP only. TLS, certificate checks, public DNS and the public-address policy are not qualified by this run.',
  'Lost receipts: there is no retrieval flow. A receipt the Host never received stays on the executor until reconciliation exists.',
  'Revocation: an executor working offline cannot learn that an already-issued capability was revoked before the capability expires.',
  'Rollback: the Host and executor keep separate durable stores; there is no global anti-rollback guarantee.',
  'Exactly-once: there is no universal exactly-once execution guarantee; single use is enforced by the executor’s own durable ledger.',
  'Keys: executor receipt-key custody and rotation are not production-hardened; the keys in this file were generated for this run alone.',
]);

// ── Digest and serialization ────────────────────────────────────────────────

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function demoEvidenceDigest(evidence: DemoEvidence): string {
  return `sha256:${sha256Hex(canonicalSerialize(evidence))}`;
}

export function assembleDemoEvidenceBundle(evidence: DemoEvidence, provenance: DemoProvenance): DemoEvidenceBundle {
  return { format: DEMO_EVIDENCE_BUNDLE_FORMAT, evidenceCanonicalization: AOC_CANONICALIZATION_VERSION, evidenceDigest: demoEvidenceDigest(evidence), evidence, provenance };
}

/** Deterministic text: canonical key order, indented for reading. The evidence digest does not depend on this layout. */
export function serializeDemoEvidenceBundle(bundle: DemoEvidenceBundle): string {
  return `${JSON.stringify(JSON.parse(canonicalSerialize(bundle)), null, 2)}\n`;
}

// ── The certainty ladder, derived from facts alone ─────────────────────────

export function certaintyOf(scenario: Pick<DemoScenario, 'host' | 'executor'>): DemoCertainty {
  const { host, executor } = scenario;
  const authorized = host.capabilityIssued !== null && host.capabilityIssued.issuanceState === 'issued';
  const executedAtExecutor = executor.consumptionState === 'completed' && executor.syntheticEffectsAdded === 1;
  const observedByHost = host.observations.some((observation) => observation.transmission === 'response');
  const verifiedByHost = host.acceptedReceipts.length > 0 && host.observations.some((observation) => observation.disposition === 'receipt-correlated');
  const confirmed =
    verifiedByHost &&
    host.response.status === 'executed' &&
    host.observations.some((observation) => observation.disposition === 'receipt-correlated' && observation.agreement === 'consistent' && observation.receiptOutcome === 'completed-observed');
  return { authorized, executedAtExecutor, observedByHost, verifiedByHost, confirmed, hostConclusion: host.response.status };
}

// ── Strict, closed-shape parsing ────────────────────────────────────────────

type Shape =
  | { readonly kind: 'string'; readonly pattern?: RegExp; readonly values?: readonly string[] }
  | { readonly kind: 'integer' }
  | { readonly kind: 'boolean'; readonly value?: boolean }
  | { readonly kind: 'nullable'; readonly of: Shape }
  | { readonly kind: 'array'; readonly of: Shape }
  | { readonly kind: 'object'; readonly fields: Readonly<Record<string, Shape>> };

const text = (pattern?: RegExp): Shape => (pattern === undefined ? { kind: 'string' } : { kind: 'string', pattern });
const oneOf = (...values: string[]): Shape => ({ kind: 'string', values });
const integer: Shape = { kind: 'integer' };
const flag: Shape = { kind: 'boolean' };
const fixed = (value: boolean): Shape => ({ kind: 'boolean', value });
const nullable = (of: Shape): Shape => ({ kind: 'nullable', of });
const list = (of: Shape): Shape => ({ kind: 'array', of });
const record = (fields: Readonly<Record<string, Shape>>): Shape => ({ kind: 'object', fields });

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const GIT_SHA = /^[0-9a-f]{40}$/;
const INSTANT = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/;
const PUBLIC_PEM = /^-----BEGIN PUBLIC KEY-----\n[A-Za-z0-9+/=\n]+\n-----END PUBLIC KEY-----\n?$/;

const SIGNATURE = record({ algorithm: text(), artifactVersion: text(), keyId: text(), signature: text(/^[A-Za-z0-9_-]+$/) });
const SIGNED_RECEIPT = record({ receipt: text(), signature: SIGNATURE });

const SCENARIO = record({
  id: oneOf(...DEMO_SCENARIO_IDS),
  title: text(),
  request: record({ principalId: text(), agentActorId: text(), action: text(), resource: text(), parameters: record({ releaseVersion: text() }) }),
  host: record({
    response: record({ httpStatus: integer, status: text(), reasonCodes: list(text()), executionId: nullable(text()), replayed: nullable(flag) }),
    decision: record({ decisionId: text(), status: text(), reasonCodes: list(text()), failedChecks: list(record({ policyId: text(), reasonCode: text() })) }),
    capabilityIssued: nullable(
      record({
        issuanceState: text(),
        capabilityId: text(),
        executionId: text(),
        issuer: text(),
        issuerKeyId: text(),
        audience: text(),
        subjectActorId: text(),
        onBehalfOfActorId: nullable(text()),
        action: text(),
        resource: text(),
        actionBinding: record({ format: text(), digest: text(SHA256) }),
        consumption: text(),
        statusRequirement: text(),
        issuedAt: text(INSTANT),
        expiresAt: text(INSTANT),
        canonical: text(),
        signature: SIGNATURE,
      }),
    ),
    issuanceRecordsAdded: integer,
    evidenceObservationsAdded: integer,
    observations: list(
      record({ transmission: text(), httpStatus: nullable(integer), httpOutcome: text(), disposition: text(), failure: nullable(text()), receiptOutcome: nullable(text()), agreement: text() }),
    ),
    acceptedReceipts: list(record({ receiptId: text(), digest: text(SHA256), outcome: text(), receipt: text(), signature: SIGNATURE })),
  }),
  wire: record({ requestsReachingExecutor: integer, presentationHeaders: integer, presentedCapabilityMatchesIssued: nullable(flag) }),
  executor: record({
    source: oneOf('executor-durable-state-read-by-test-harness'),
    consumptionState: nullable(text()),
    outcomeRecorded: nullable(flag),
    syntheticEffectsAdded: integer,
    effectRecord: nullable(text()),
    receipts: list(SIGNED_RECEIPT),
  }),
  resubmission: record({ status: text(), requestsReachingExecutorAdded: integer, syntheticEffectsAdded: integer }),
  representation: nullable(record({ executorHttpStatus: nullable(integer), syntheticEffectsAdded: integer })),
  certainty: record({ authorized: flag, executedAtExecutor: flag, observedByHost: flag, verifiedByHost: flag, confirmed: flag, hostConclusion: text() }),
});

const BUNDLE = record({
  format: oneOf(DEMO_EVIDENCE_BUNDLE_FORMAT),
  evidenceCanonicalization: oneOf(AOC_CANONICALIZATION_VERSION),
  evidenceDigest: text(SHA256),
  evidence: record({
    classification: record({
      origin: oneOf('reference-implementation-test-run'),
      data: oneOf('synthetic'),
      production: fixed(false),
      live: fixed(false),
      effect: oneOf('synthetic-deployment-record'),
      transport: oneOf('loopback-http-without-tls'),
      statement: oneOf(DEMO_CLASSIFICATION_STATEMENT),
    }),
    story: record({
      headline: text(),
      principalId: text(),
      agentActorId: text(),
      delegatedByActorId: text(),
      action: text(),
      delegatedResource: text(),
      undelegatedResource: text(),
      releaseVersion: text(),
    }),
    verificationKeys: list(
      record({
        role: oneOf('capability-issuer', 'executor-receipt'),
        subject: text(),
        keyId: text(),
        algorithm: oneOf('ed25519-v1'),
        publicKeyPem: text(PUBLIC_PEM),
        signingDomain: oneOf(EXECUTION_CAPABILITY_SIGNING_DOMAIN, EXECUTOR_RECEIPT_SIGNING_DOMAIN),
        origin: oneOf('ephemeral-key-generated-for-this-run'),
      }),
    ),
    scenarios: list(SCENARIO),
    limitations: list(text()),
  }),
  provenance: record({
    source: oneOf('github-actions', 'local-test-run'),
    repository: nullable(text(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)),
    checkoutSha: nullable(text(GIT_SHA)),
    headSha: nullable(text(GIT_SHA)),
    workflow: nullable(text()),
    job: nullable(text()),
    runId: nullable(text(/^[0-9]+$/)),
    runAttempt: nullable(text(/^[0-9]+$/)),
    runUrl: nullable(text(/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/actions\/runs\/[0-9]+(\/attempts\/[0-9]+)?$/)),
    generatedAt: text(INSTANT),
    statement: oneOf(DEMO_PROVENANCE_STATEMENT),
  }),
});

/** A field name that suggests secret material is refused wherever it appears, whatever its value. */
const SENSITIVE_FIELD_NAME = /private|secret|token|password|passphrase|credential|authorization|bearer|api_?key|cookie|session|seed|connection/i;

function check(value: unknown, shape: Shape, path: string, problems: string[]): void {
  switch (shape.kind) {
    case 'string':
      if (typeof value !== 'string') problems.push(`${path}: expected a string`);
      else if (shape.values !== undefined && !shape.values.includes(value)) problems.push(`${path}: not an accepted value`);
      else if (shape.pattern !== undefined && !shape.pattern.test(value)) problems.push(`${path}: malformed`);
      return;
    case 'integer':
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) problems.push(`${path}: expected a non-negative integer`);
      return;
    case 'boolean':
      if (typeof value !== 'boolean') problems.push(`${path}: expected a boolean`);
      else if (shape.value !== undefined && value !== shape.value) problems.push(`${path}: must be ${String(shape.value)}`);
      return;
    case 'nullable':
      if (value !== null) check(value, shape.of, path, problems);
      return;
    case 'array':
      if (!Array.isArray(value)) {
        problems.push(`${path}: expected an array`);
        return;
      }
      value.forEach((entry: unknown, index) => check(entry, shape.of, `${path}[${index}]`, problems));
      return;
    case 'object': {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        problems.push(`${path}: expected an object`);
        return;
      }
      const entries = value as Record<string, unknown>;
      for (const name of Object.keys(entries)) {
        if (SENSITIVE_FIELD_NAME.test(name)) problems.push(`${path}.${name}: a field name suggesting secret material is refused`);
        else if (!(name in shape.fields)) problems.push(`${path}.${name}: unknown field`);
      }
      for (const [name, fieldShape] of Object.entries(shape.fields)) {
        if (!(name in entries)) problems.push(`${path}.${name}: missing`);
        else check(entries[name], fieldShape, `${path}.${name}`, problems);
      }
      return;
    }
  }
}

export type DemoEvidenceBundleParse = { readonly ok: true; readonly bundle: DemoEvidenceBundle } | { readonly ok: false; readonly problems: readonly string[] };

/** Accepts exactly the closed `frontera.demo-evidence-bundle.v1` shape, with all three scenarios once, in order. */
export function parseDemoEvidenceBundle(serialized: string): DemoEvidenceBundleParse {
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    return { ok: false, problems: ['not JSON'] };
  }
  const problems: string[] = [];
  check(value, BUNDLE, '$', problems);
  if (problems.length === 0) {
    const bundle = value as DemoEvidenceBundle;
    const ids = bundle.evidence.scenarios.map((scenario) => scenario.id);
    if (JSON.stringify(ids) !== JSON.stringify(DEMO_SCENARIO_IDS)) problems.push('$.evidence.scenarios: exactly authorized, blocked, uncertain, in that order');
    const roles = bundle.evidence.verificationKeys.map((key) => key.role);
    if (JSON.stringify(roles) !== JSON.stringify(['capability-issuer', 'executor-receipt'])) problems.push('$.evidence.verificationKeys: exactly one capability-issuer key, then one executor-receipt key');
    if (problems.length === 0) return { ok: true, bundle };
  }
  return { ok: false, problems };
}

// ── Independent verification ───────────────────────────────────────────────

export interface DemoVerificationCheck {
  readonly check: string;
  readonly passed: boolean;
}

function signatureHolds(key: DemoVerificationKey, canonical: string, envelope: DemoSignature): boolean {
  try {
    if (envelope.algorithm !== 'ed25519-v1' || envelope.keyId !== key.keyId) return false;
    return verify(null, Buffer.from(`${key.signingDomain}${canonical}`, 'utf8'), createPublicKey(key.publicKeyPem), Buffer.from(envelope.signature, 'base64url'));
  } catch {
    return false;
  }
}

/**
 * Re-derives every checkable claim from the recorded facts with Node's own
 * Ed25519 (and, for receipts, the G-02C1C verifier as well): the evidence
 * digest, each capability and receipt signature against the bundled keys,
 * capability/receipt/effect correlation, the Host's accepted receipt being the
 * executor's own, the per-scenario invariants and the certainty ladder.
 */
export function verifyDemoEvidenceBundle(bundle: DemoEvidenceBundle): readonly DemoVerificationCheck[] {
  const checks: DemoVerificationCheck[] = [];
  const add = (name: string, passed: boolean): void => {
    checks.push({ check: name, passed });
  };
  const { evidence } = bundle;
  add('evidence digest matches aoc.canonical-json.v1(evidence)', bundle.evidenceDigest === demoEvidenceDigest(evidence));

  const issuerKey = evidence.verificationKeys.find((key) => key.role === 'capability-issuer');
  const executorKey = evidence.verificationKeys.find((key) => key.role === 'executor-receipt');
  add('one capability-issuer key over the capability domain', issuerKey !== undefined && issuerKey.signingDomain === EXECUTION_CAPABILITY_SIGNING_DOMAIN);
  add('one executor-receipt key over the receipt domain', executorKey !== undefined && executorKey.signingDomain === EXECUTOR_RECEIPT_SIGNING_DOMAIN);
  if (issuerKey === undefined || executorKey === undefined) return checks;

  // The G-02C1C verifier, pinned to the bundled executor key and to the scope the capabilities themselves name.
  const capabilities = evidence.scenarios.flatMap((scenario) => (scenario.host.capabilityIssued === null ? [] : [parseExecutionCapability(scenario.host.capabilityIssued.canonical)]));
  const scopeOf = (pick: (capability: { readonly audience: string; readonly organizationId: string; readonly trustDomain: string }) => string): string[] => [
    ...new Set(capabilities.flatMap((parsed) => (parsed.ok ? [pick(parsed.capability)] : []))),
  ];
  const receiptVerifier = (() => {
    try {
      return createExecutorReceiptVerifier({
        trustedExecutors: [
          {
            executorId: executorKey.subject,
            keys: [{ keyId: executorKey.keyId, algorithm: 'ed25519-v1', publicKeyPem: executorKey.publicKeyPem }],
            audiences: scopeOf((capability) => capability.audience),
            organizationIds: scopeOf((capability) => capability.organizationId),
            trustDomains: scopeOf((capability) => capability.trustDomain),
          },
        ],
      });
    } catch {
      return undefined;
    }
  })();
  add('the G-02C1C receipt verifier accepts the bundled executor key and scope', receiptVerifier !== undefined);

  for (const scenario of evidence.scenarios) {
    const at = (name: string): string => `${scenario.id}: ${name}`;
    const capability = scenario.host.capabilityIssued;
    if (capability !== null) {
      const parsed = parseExecutionCapability(capability.canonical);
      add(at('capability text is canonical G-02A'), parsed.ok);
      if (parsed.ok) {
        const c = parsed.capability;
        add(
          at('capability metadata is the signed text'),
          c.capabilityId === capability.capabilityId &&
            c.executionId === capability.executionId &&
            c.issuer === capability.issuer &&
            c.issuerKeyId === capability.issuerKeyId &&
            c.audience === capability.audience &&
            c.subjectActorId === capability.subjectActorId &&
            c.onBehalfOfActorId === capability.onBehalfOfActorId &&
            c.action === capability.action &&
            c.resource === capability.resource &&
            c.actionBinding.format === capability.actionBinding.format &&
            c.actionBinding.digest === capability.actionBinding.digest &&
            c.consumption === capability.consumption &&
            c.statusRequirement === capability.statusRequirement &&
            c.issuedAt === capability.issuedAt &&
            c.expiresAt === capability.expiresAt,
        );
        add(at('capability issuer is the key subject'), c.issuer === issuerKey.subject && c.issuerKeyId === issuerKey.keyId);
      }
      add(at('capability signature verifies under the issuer key'), signatureHolds(issuerKey, capability.canonical, capability.signature));
      add(at('Host response names the capability execution'), scenario.host.response.executionId === capability.executionId);
    }

    for (const signed of scenario.executor.receipts) {
      add(at('executor receipt signature verifies under the executor key'), signatureHolds(executorKey, signed.receipt, signed.signature));
      const verification =
        capability === null || receiptVerifier === undefined
          ? undefined
          : receiptVerifier.verify(signed, {
              expected: {
                executorId: executorKey.subject,
                issuer: capability.issuer,
                capabilityId: capability.capabilityId,
                executionId: capability.executionId,
                audience: capability.audience,
                actionBinding: capability.actionBinding,
              },
            });
      add(
        at('G-02C1C verifier: receipt signed, in scope and about exactly this capability'),
        verification !== undefined && verification.failure === null && verification.signature === 'valid' && verification.identityMatch === 'yes' && verification.bindingMatch === 'yes',
      );
      const parsed = parseExecutorReceipt(signed.receipt);
      if (parsed.ok && parsed.receipt.observation !== null) {
        const record = scenario.executor.effectRecord;
        add(at('receipt observation digest is the synthetic record'), record !== null && parsed.receipt.observation.digest === `sha256:${sha256Hex(record)}`);
      }
    }

    for (const accepted of scenario.host.acceptedReceipts) {
      add(at('Host-accepted receipt signature verifies under the executor key'), signatureHolds(executorKey, accepted.receipt, accepted.signature));
      add(
        at('Host-accepted receipt is the executor’s own, verbatim'),
        scenario.executor.receipts.some((signed) => signed.receipt === accepted.receipt && canonicalSerialize(signed.signature) === canonicalSerialize(accepted.signature)),
      );
      add(at('Host-accepted receipt digest is its text'), accepted.digest === `sha256:${sha256Hex(accepted.receipt)}`);
      const parsed = parseExecutorReceipt(accepted.receipt);
      add(at('Host-accepted receipt id and outcome are the signed text'), parsed.ok && parsed.receipt.receiptId === accepted.receiptId && parsed.receipt.outcome === accepted.outcome);
    }

    const derived = certaintyOf(scenario);
    add(at('certainty ladder is derived from the recorded facts'), canonicalSerialize(derived) === canonicalSerialize(scenario.certainty));
  }

  const [authorized, blocked, uncertain] = evidence.scenarios;
  if (authorized !== undefined) {
    add(
      'authorized: one presentation, one effect, a verified, correlated, consistent receipt',
      authorized.host.response.status === 'executed' &&
        authorized.wire.requestsReachingExecutor === 1 &&
        authorized.wire.presentationHeaders === 1 &&
        authorized.wire.presentedCapabilityMatchesIssued === true &&
        authorized.executor.syntheticEffectsAdded === 1 &&
        authorized.host.acceptedReceipts.length === 1 &&
        authorized.certainty.confirmed,
    );
    add(
      'authorized: neither resubmission nor re-presentation performs a second effect',
      authorized.resubmission.requestsReachingExecutorAdded === 0 && authorized.resubmission.syntheticEffectsAdded === 0 && authorized.representation !== null && authorized.representation.syntheticEffectsAdded === 0,
    );
  }
  if (blocked !== undefined) {
    add(
      'blocked: denied with reason codes; no capability, presentation, effect or receipt',
      blocked.host.response.status === 'denied' &&
        blocked.host.response.reasonCodes.length > 0 &&
        blocked.host.capabilityIssued === null &&
        blocked.host.issuanceRecordsAdded === 0 &&
        blocked.host.evidenceObservationsAdded === 0 &&
        blocked.wire.requestsReachingExecutor === 0 &&
        blocked.executor.syntheticEffectsAdded === 0 &&
        blocked.executor.receipts.length === 0 &&
        blocked.host.acceptedReceipts.length === 0 &&
        !blocked.certainty.authorized,
    );
  }
  if (uncertain !== undefined) {
    add(
      'uncertain: executed at the executor, unobserved and unverified by the Host, never re-run',
      uncertain.host.response.status === 'execution_unconfirmed' &&
        uncertain.certainty.authorized &&
        uncertain.certainty.executedAtExecutor &&
        !uncertain.certainty.observedByHost &&
        !uncertain.certainty.verifiedByHost &&
        !uncertain.certainty.confirmed &&
        uncertain.executor.receipts.length === 1 &&
        uncertain.host.acceptedReceipts.length === 0 &&
        uncertain.host.observations.length === 1 &&
        uncertain.host.observations.every((observation) => observation.disposition === 'receipt-missing') &&
        uncertain.resubmission.requestsReachingExecutorAdded === 0 &&
        uncertain.resubmission.syntheticEffectsAdded === 0,
    );
  }
  return checks;
}

// ── Sensitive-material scan ────────────────────────────────────────────────

export interface DemoSentinel {
  readonly label: string;
  readonly value: string;
}

const SENSITIVE_PATTERNS: readonly (readonly [string, RegExp])[] = [
  ['a private key block', /PRIVATE KEY/],
  ['an HTTP authorization value', /\bbearer\s|\bbasic\s+[A-Za-z0-9+/=]{8,}|"authorization"\s*:/i],
  ['a local filesystem path', /(?:^|[\s"'=(:])\/(?:tmp|home|Users|root|mnt|runner|private|var|workspace|opt|etc|srv)\//],
  ['a Windows filesystem path', /[A-Za-z]:\\\\/],
  ['a connection string', /\b(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|redis|rediss|amqp|sqlite|file|jdbc):/i],
  ['credentials in a URL', /\b[a-z][a-z0-9+.-]*:\/\/[^\s"/@]+@/i],
  ['an environment assignment', /\b(?:AOC_ENTERPRISE|FRONTERA_TEST|G02C1A)_[A-Z0-9_]+\s*=/],
];

/**
 * Every place `serialized` holds secret or local material: a run-specific
 * sentinel (a private key, a bearer token, an API key, a local directory), or
 * a generic secret, path or connection-string shape. Empty means clean.
 */
export function sensitiveFindings(serialized: string, sentinels: readonly DemoSentinel[]): readonly string[] {
  const findings: string[] = [];
  for (const { label, value } of sentinels) {
    if (value.length >= 6 && serialized.includes(value)) findings.push(`contains ${label}`);
  }
  for (const [label, pattern] of SENSITIVE_PATTERNS) if (pattern.test(serialized)) findings.push(`contains ${label}`);
  return findings;
}

/** Sentinels for a PEM private key: the whole block and each base64 line of its body. */
export function pemSentinels(label: string, pem: string): readonly DemoSentinel[] {
  const body = pem
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length >= 16 && !line.startsWith('-----'));
  return [{ label, value: pem.trim() }, ...body.map((line, index) => ({ label: `${label} (line ${String(index + 1)})`, value: line }))];
}

/** Provenance from the producing job's environment; outside GitHub Actions every CI field is `null`. */
export function provenanceOf(environment: Readonly<Record<string, string | undefined>>, generatedAt: string): DemoProvenance {
  const value = (name: string): string | null => {
    const found = environment[name];
    return found === undefined || found.length === 0 ? null : found;
  };
  const inActions = value('GITHUB_ACTIONS') === 'true';
  const pick = (name: string): string | null => (inActions ? value(name) : null);
  const repository = pick('GITHUB_REPOSITORY');
  const runId = pick('GITHUB_RUN_ID');
  const runAttempt = pick('GITHUB_RUN_ATTEMPT');
  const server = pick('GITHUB_SERVER_URL');
  const runUrl = server === 'https://github.com' && repository !== null && runId !== null ? `${server}/${repository}/actions/runs/${runId}${runAttempt === null ? '' : `/attempts/${runAttempt}`}` : null;
  return {
    source: inActions ? 'github-actions' : 'local-test-run',
    repository,
    checkoutSha: pick('GITHUB_SHA'),
    headSha: pick('FRONTERA_DEMO01_HEAD_SHA'),
    workflow: pick('GITHUB_WORKFLOW'),
    job: pick('GITHUB_JOB'),
    runId,
    runAttempt,
    runUrl,
    generatedAt,
    statement: DEMO_PROVENANCE_STATEMENT,
  };
}
