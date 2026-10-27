// PROD-02 — the ONE authoritative portability registry.
//
// Every durable SQLite store the Enterprise Host can compose is declared here
// exactly once, and everything else derives from this file:
//
//   backup discovery      backup-enterprise-v1.mjs   (which files, which are required)
//   restore mapping       restore-enterprise-v1.mjs  (which target file, which variable)
//   manifest validation   restore-enterprise-v1.mjs  (known names, filenames, versions, coverage)
//   backup readiness      scripts/pilot/lib-pilot-readiness.mjs (PROD-03 PR-15: the same
//                         store-inventory and coverage validators as restore, below)
//   fixture / comparison  generate-portability-fixture.mjs, compare-portability-state.mjs
//   tests / docs          tests/portability-*.test.mjs, the PROD-02 Host drill
//
// A structural test (`tests/portability-store-registry.structure.test.mjs`)
// reads the Host's configuration loader and fails when a `*_SQLITE_PATH`
// variable appears there that this registry neither declares nor excludes, and
// the PROD-02 Host drill boots real Hosts to prove `deriveDeploymentRequirements`
// predicts exactly the files the composition root opens. A new durable store
// is therefore hard to forget silently.
//
// What is deliberately NOT here (EXCLUDED_DURABLE_STATE below says why):
// the CORE-07 freshness witness's state (a different restore domain by
// design), every secret and private key, and library stores the Host never
// composes.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';

/** The coverage model a PROD-02 manifest carries. A restore refuses any other value (an unknown, newer model fails closed). */
export const COVERAGE_MODEL = 'aoc.enterprise.backup.coverage.v1';

/**
 * When a store is part of a deployment. Each condition is evaluated against
 * `deriveDeploymentRequirements()` and mirrors the composition root's own
 * selection (`src/enterprise/composition/composition-root.ts`):
 *
 * - `always` — opened on every `sqlite` deployment.
 * - `kernel-authority-enabled` — `AOC_ENTERPRISE_KERNEL_AUTHORITY_ENABLED=true`.
 * - `governed-actions` — a governed-action file is configured (the Host then
 *   composes authority-controlled execution, P7, P8, P11 and emergency control).
 * - `obligations-declared` — governed actions, and the file declares `obligations`.
 * - `approvals-declared` — governed actions, and some profile declares `approval`.
 * - `operators-configured` — the file declares at least one CTRL-02 operator.
 * - `embedder-reconciliation` — P12 reconciliation. Since PROD-03-02 the
 *   shipped Host composes it whenever the file declares operators (operator
 *   attestation: every governed execution is bound before its claim, and
 *   operator resolutions are recorded there), so it is *required* exactly
 *   then. An embedder may also compose it (`executionReconciliation`); that is
 *   not visible from configuration, so such a store is backed up when its
 *   variable is set explicitly and its file exists; a file at its default path
 *   with the variable unset is reported (`present-not-configured`), never
 *   silently skipped. (The condition keeps its PROD-02 name, which manifests
 *   already record.) Since PAY-03 the Host also composes it whenever the file
 *   configures `xrplPaymentRail` (the read-only XRPL resolution authority).
 * - `xrpl-payment-rail` — the file configures `xrplPaymentRail` (PAY-03): the
 *   durable XRPL submission interlock.
 * - `xrpl-trade-execution` — the file configures `xrplTradeExecution`
 *   (TRADE-04C): the durable trade sequence interlock (its own file, its own
 *   CORE-07 slot). The Host then also composes P12 (the trade resolution
 *   authority).
 */
export const STORE_CONDITIONS = Object.freeze([
  'always',
  'kernel-authority-enabled',
  'governed-actions',
  'obligations-declared',
  'approvals-declared',
  'operators-configured',
  'embedder-reconciliation',
  'xrpl-payment-rail',
  'xrpl-trade-execution',
]);

/**
 * The registry. Order is the backup's stable store order (the four historical
 * stores first, unchanged).
 *
 * Per entry:
 * - `name` — canonical store name (manifest key).
 * - `filename` — the file inside the backup's `stores/`.
 * - `envVar` / `configPathOf` — the Host variable and the configuration field it fills.
 * - `targetFilename` — the file a restore writes: the basename of the Host's
 *   own default path, so a restored directory is a valid `.data/`.
 * - `condition` — see STORE_CONDITIONS.
 * - `version` — how its schema version is recorded: a `versions` table (with
 *   or without a `migration_state` column) or a single-row `meta` table.
 * - `supportedSchemaVersionsOf(modules)` — what this build opens.
 * - `signedHead` — present for the three CORE-01/04/05 authenticated stores:
 *   the signed head is in the same file as its rows and is copied with them.
 * - `freshnessStateKind` — the CORE-07 witness slot that anchors the store, if any.
 * - `open(modules, path, authority)` — opens the store through its own
 *   factory, for restore's deep verification. Only ever called on a scratch
 *   copy of an already checksum-verified file, never on a target, and never on
 *   a path that does not exist (a factory creates a store when the file is
 *   absent — exactly what a restore must never do). The three signed stores
 *   need `authority`: trusted verification keys and a signer that refuses to
 *   sign, so they open only when their signed head verifies.
 * - `lossEffect` — what losing (or rolling back) this store does. Used in docs
 *   and the manifest; never a decision input.
 */
export const STORE_DEFINITIONS = Object.freeze([
  {
    name: 'governance',
    filename: 'governance.sqlite',
    envVar: 'AOC_ENTERPRISE_SQLITE_PATH',
    configKey: 'persistence.sqlitePath',
    configPathOf: (config) => config.persistence.sqlitePath,
    targetFilename: 'enterprise-host.sqlite',
    condition: 'always',
    purpose: 'Governance Records: requests, committed decisions, traces, events, idempotency',
    version: { kind: 'versions-table', table: 'governance_store_versions', migrationState: true },
    supportedSchemaVersionsOf: ({ enterprise }) => [enterprise.GOVERNANCE_STORE_SCHEMA_VERSION],
    recordTable: 'governance_evaluations',
    integrity: 'per-record SHA-256 aggregate digests (unsigned)',
    open: ({ enterprise }, path) => enterprise.createSqliteGovernanceStore(path),
    lossEffect: 'loses audit history and the committed decisions approvals and retries resume',
  },
  {
    name: 'agent-passport',
    filename: 'agent-passport.sqlite',
    envVar: 'AOC_ENTERPRISE_PASSPORT_SQLITE_PATH',
    configKey: 'passport.sqlitePath',
    configPathOf: (config) => config.passport.sqlitePath,
    targetFilename: 'agent-passport.sqlite',
    condition: 'always',
    purpose: 'Agent Passport event chains and projections',
    version: { kind: 'versions-table', table: 'agent_passport_store_versions', migrationState: true },
    supportedSchemaVersionsOf: ({ enterprise }) => [enterprise.AGENT_PASSPORT_SCHEMA_VERSION],
    recordTable: 'agent_passport_events',
    integrity: 'per-passport digest chain (unsigned)',
    open: ({ enterprise }, path) => enterprise.createSqlitePassportStore(path),
    lossEffect: 'loses passport lifecycle (a lost suspension un-suspends)',
  },
  {
    name: 'assurance',
    filename: 'assurance.sqlite',
    envVar: 'AOC_ENTERPRISE_ASSURANCE_SQLITE_PATH',
    configKey: 'assurance.sqlitePath',
    configPathOf: (config) => config.assurance.sqlitePath,
    targetFilename: 'assurance.sqlite',
    condition: 'always',
    purpose: 'Assurance assessments, findings, reviews, scores',
    version: { kind: 'versions-table', table: 'assurance_store_versions', migrationState: true },
    supportedSchemaVersionsOf: ({ enterprise }) => [enterprise.ASSURANCE_STORE_SCHEMA_VERSION],
    recordTable: 'assurance_assessments',
    integrity: 'per-assessment digests (unsigned)',
    open: ({ enterprise }, path) => enterprise.createSqliteAssuranceStore(path),
    lossEffect: 'loses optional assurance evidence',
  },
  {
    name: 'kernel-authority',
    filename: 'kernel-authority.sqlite',
    envVar: 'AOC_ENTERPRISE_KERNEL_AUTHORITY_SQLITE_PATH',
    configKey: 'kernelAuthority.sqlitePath',
    configPathOf: (config) => config.kernelAuthority.sqlitePath,
    targetFilename: 'kernel-authority.sqlite',
    // Durable authority is opt-in and defaults to off: a deployment that never
    // enabled it has no such file and never will. When enabled it is required —
    // it is authority source-of-truth, and a restore without it comes back with
    // every actor unrecognized.
    condition: 'kernel-authority-enabled',
    purpose: 'Kernel Authority world: actors, trust domains, grants, delegations, passports, revocations, parameter bounds',
    version: { kind: 'versions-table', table: 'kernel_authority_store_versions', migrationState: true },
    supportedSchemaVersionsOf: ({ enterprise }) => [enterprise.KERNEL_AUTHORITY_SCHEMA_VERSION],
    recordTable: 'kernel_authority_events',
    integrity: 'digest-chained event log (unsigned; not CORE-07 anchored)',
    open: ({ enterprise }, path) => enterprise.createSqliteKernelAuthorityStore(path),
    lossEffect: 'every actor unrecognized (narrows); an older copy resurrects withdrawn authority (widens)',
  },
  {
    name: 'bounded-grants',
    filename: 'bounded-grants.sqlite',
    envVar: 'AOC_ENTERPRISE_BOUNDED_GRANT_SQLITE_PATH',
    configKey: 'boundedGrant.sqlitePath',
    configPathOf: (config) => config.boundedGrant.sqlitePath,
    targetFilename: 'bounded-grants.sqlite',
    condition: 'governed-actions',
    purpose: 'Bounded grants and revocations (CORE-01), signed revocation-state commitment',
    version: { kind: 'versions-table', table: 'bounded_grant_store_versions', migrationState: true },
    supportedSchemaVersionsOf: ({ boundedGrant }) => [boundedGrant.BOUNDED_GRANT_STORE_SCHEMA_VERSION],
    recordTable: 'bounded_grants',
    integrity: 'Ed25519-signed grants, revocations and revocation-state commitment',
    signedHead: { table: 'bounded_grant_revocation_state', sequenceColumn: 'sequence', digestColumn: 'revocation_set_digest', storeIdColumn: 'store_id', rowTable: 'bounded_grant_revocations' },
    freshnessStateKind: 'bounded-grant-revocation-state',
    open: ({ factories }, path, authority) => factories.boundedGrant.createSqliteBoundedGrantStore(path, { authenticity: authority.authenticity }),
    lossEffect: 'a lost or older revocation resurrects revoked authority (widens); refused under CORE-07',
  },
  {
    name: 'emergency-controls',
    filename: 'emergency-controls.sqlite',
    envVar: 'AOC_ENTERPRISE_EMERGENCY_CONTROL_SQLITE_PATH',
    configKey: 'emergencyControl.sqlitePath',
    configPathOf: (config) => config.emergencyControl.sqlitePath,
    targetFilename: 'emergency-controls.sqlite',
    condition: 'governed-actions',
    purpose: 'Emergency stops and releases (durable kill switch)',
    version: { kind: 'versions-table', table: 'emergency_control_store_versions', migrationState: true },
    supportedSchemaVersionsOf: ({ emergencyControl }) => [emergencyControl.EMERGENCY_CONTROL_STORE_SCHEMA_VERSION],
    recordTable: 'emergency_control_events',
    integrity: 'digest-chained events and head (unsigned; not CORE-07 anchored)',
    open: ({ factories }, path) => factories.emergencyControl.createSqliteEmergencyControlStore(path, {}),
    lossEffect: 'an active stop is released (widens)',
  },
  {
    name: 'exercise-ledger',
    filename: 'exercise-ledger.sqlite',
    envVar: 'AOC_ENTERPRISE_EXERCISE_LEDGER_SQLITE_PATH',
    configKey: 'exerciseLedger.sqlitePath',
    configPathOf: (config) => config.exerciseLedger.sqlitePath,
    targetFilename: 'exercise-ledger.sqlite',
    condition: 'governed-actions',
    purpose: 'P7 exercise reservations, consumed aggregate limits, terminal events',
    version: { kind: 'versions-table', table: 'exercise_control_ledger_versions', migrationState: true },
    supportedSchemaVersionsOf: ({ exerciseLedger }) => [exerciseLedger.EXERCISE_CONTROL_LEDGER_SCHEMA_VERSION],
    recordTable: 'exercise_control_reservations',
    integrity: 'per-record digests and bucket heads (unsigned; not CORE-07 anchored)',
    open: ({ factories }, path) => factories.exerciseLedger.createSqliteExerciseControlLedger(path, {}),
    lossEffect: 'consumed limits regain capacity and claims can be replayed (widens, duplicates)',
  },
  {
    name: 'authority-event-stream',
    filename: 'authority-event-stream.sqlite',
    envVar: 'AOC_ENTERPRISE_AUTHORITY_EVENT_STREAM_SQLITE_PATH',
    configKey: 'authorityEventStream.sqlitePath',
    configPathOf: (config) => config.authorityEventStream.sqlitePath,
    targetFilename: 'authority-event-stream.sqlite',
    condition: 'governed-actions',
    purpose: 'P8 canonical authority event stream (evidence)',
    version: { kind: 'versions-table', table: 'authority_event_stream_versions', migrationState: true },
    supportedSchemaVersionsOf: ({ eventStream }) => [eventStream.AUTHORITY_EVENT_STREAM_STORE_SCHEMA_VERSION],
    recordTable: 'authority_events',
    integrity: 'digest-chained events per stream (unsigned)',
    open: ({ factories }, path) => factories.eventStream.createSqliteAuthorityEventStreamStore(path, { now: () => new Date().toISOString() }),
    lossEffect: 'loses authority trace evidence only',
  },
  {
    name: 'execution-outcomes',
    filename: 'execution-outcomes.sqlite',
    envVar: 'AOC_ENTERPRISE_EXECUTION_OUTCOME_SQLITE_PATH',
    configKey: 'executionOutcome.sqlitePath',
    configPathOf: (config) => config.executionOutcome.sqlitePath,
    targetFilename: 'execution-outcomes.sqlite',
    condition: 'governed-actions',
    purpose: 'P11 durable execution attempts and terminal outcomes',
    version: { kind: 'versions-table', table: 'execution_outcome_store_versions', migrationState: true },
    supportedSchemaVersionsOf: ({ outcomes }) => [outcomes.EXECUTION_OUTCOME_STORE_SCHEMA_VERSION, outcomes.EXECUTION_OUTCOME_STORE_SCHEMA_VERSION_V1],
    recordTable: 'execution_attempts',
    integrity: 'per-attempt digests (unsigned)',
    open: ({ factories }, path) => factories.outcomes.createSqliteExecutionOutcomeStore(path, { now: () => new Date().toISOString() }),
    lossEffect: 'a completed effect can be attempted again (duplicate provider effect)',
  },
  {
    name: 'execution-resolutions',
    filename: 'execution-resolutions.sqlite',
    envVar: 'AOC_ENTERPRISE_EXECUTION_RESOLUTION_SQLITE_PATH',
    configKey: 'executionResolution.sqlitePath',
    configPathOf: (config) => config.executionResolution.sqlitePath,
    targetFilename: 'execution-resolutions.sqlite',
    condition: 'embedder-reconciliation',
    purpose: 'P12 resolution-authority bindings and immutable resolutions',
    version: { kind: 'versions-table', table: 'execution_resolution_store_versions', migrationState: true },
    supportedSchemaVersionsOf: ({ resolutions }) => [resolutions.EXECUTION_RESOLUTION_STORE_SCHEMA_VERSION],
    recordTable: 'execution_resolution_bindings',
    integrity: 'binding and resolution digests (unsigned)',
    open: ({ factories }, path) => factories.resolutions.createSqliteExecutionResolutionStore(path, { now: () => new Date().toISOString() }),
    lossEffect: 'bindings would have to be re-inferred and resolutions lost (reconciliation diverges)',
  },
  {
    name: 'xrpl-submission-interlock',
    filename: 'xrpl-submission-interlock.sqlite',
    envVar: 'AOC_ENTERPRISE_XRPL_INTERLOCK_SQLITE_PATH',
    configKey: 'xrplInterlock.sqlitePath',
    configPathOf: (config) => config.xrplInterlock.sqlitePath,
    targetFilename: 'xrpl-submission-interlock.sqlite',
    condition: 'xrpl-payment-rail',
    purpose: 'PAY-03: every XRPL Payment signed for an execution, recorded before its one submission, with its sequence window and settlement',
    version: { kind: 'versions-table', table: 'xrpl_interlock_store_versions', migrationState: true },
    supportedSchemaVersionsOf: ({ xrplInterlock }) => [xrplInterlock.XRPL_INTERLOCK_STORE_SCHEMA_VERSION],
    recordTable: 'xrpl_submissions',
    integrity: 'identity and state digests, forward-only lifecycle triggers, append-only transition log (unsigned); the reservation history is anchored at the CORE-07 witness, so a rolled-back or stale copy is refused at the next start (slot xrpl-submission-reservations; not a signed store)',
    // No scope: verification adopts the file's own recorded scope, verifies every record and creates nothing.
    open: ({ factories }, path) => factories.xrplInterlock.createSqliteXrplSubmissionInterlock(path, { now: () => new Date().toISOString() }),
    lossEffect: 'restoring an older copy loses reservations the witness has seen: the Host refuses the XRPL rail (XRPL_INTERLOCK_FRESHNESS_FAILED, ROLLBACK_DETECTED) and signs nothing until the newest copy is restored; P12 cannot resolve a forgotten submission from the ledger',
  },
  {
    name: 'xrpl-trade-sequence-interlock',
    filename: 'xrpl-trade-sequence-interlock.sqlite',
    envVar: 'AOC_ENTERPRISE_XRPL_TRADE_INTERLOCK_SQLITE_PATH',
    configKey: 'xrplTradeInterlock.sqlitePath',
    configPathOf: (config) => config.xrplTradeInterlock.sqlitePath,
    targetFilename: 'xrpl-trade-sequence-interlock.sqlite',
    condition: 'xrpl-trade-execution',
    purpose: 'TRADE-04C: every delegated OfferCreate the governed trade executor signed, reserved before its one submission and claimed by the submit site, with its owner sequence window, evidence and settlement',
    version: { kind: 'versions-table', table: 'trade_interlock_store_versions', migrationState: true },
    supportedSchemaVersionsOf: ({ tradeInterlock }) => [...tradeInterlock.TRADE_INTERLOCK_SUPPORTED_SCHEMA_VERSIONS],
    recordTable: 'trade_reservations',
    integrity: 'identity and state digests, forward-only lifecycle triggers, append-only transition log and anchored-event log (unsigned); the reservation-and-claim history is anchored at the CORE-07 witness, so a rolled-back or stale copy is refused at the next start (slot trade-sequence-reservations; not a signed store)',
    // No scope: verification adopts the file's own recorded scope, verifies every record and creates nothing.
    open: ({ factories }, path) => factories.tradeInterlock.createSqliteTradeSequenceInterlock(path, { now: () => new Date().toISOString() }),
    lossEffect: 'restoring an older copy loses reservations or submission claims the witness has seen: the Host refuses the trade executor (XRPL_TRADE_INTERLOCK_FRESHNESS_FAILED, ROLLBACK_DETECTED) and signs nothing until the newest copy is restored; P12 cannot resolve a forgotten submission from the ledger',
  },
  {
    name: 'obligation-discharges',
    filename: 'obligation-discharges.sqlite',
    envVar: 'AOC_ENTERPRISE_OBLIGATION_DISCHARGE_SQLITE_PATH',
    configKey: 'obligationDischarge.sqlitePath',
    configPathOf: (config) => config.obligationDischarge.sqlitePath,
    targetFilename: 'obligation-discharges.sqlite',
    condition: 'obligations-declared',
    purpose: 'CORE-04 obligation discharge log, signed chain head',
    version: { kind: 'meta-row', table: 'obligation_discharge_store_meta' },
    supportedSchemaVersionsOf: ({ obligations }) => [obligations.OBLIGATION_DISCHARGE_STORE_SCHEMA_VERSION],
    recordTable: 'obligation_discharges',
    integrity: 'Ed25519-signed chain head over a digest chain',
    signedHead: { table: 'obligation_discharge_head', sequenceColumn: 'sequence', digestColumn: 'chain_digest', metaTable: 'obligation_discharge_store_meta', rowTable: 'obligation_discharges' },
    freshnessStateKind: 'obligation-discharge-state',
    open: ({ factories }, path, authority) => factories.obligations.createSqliteObligationDischargeStore(path, { now: () => new Date().toISOString(), organizationId: authority.organizationId, authenticity: authority.authenticity }),
    lossEffect: 'a lost discharge withholds forever (narrows); refused under CORE-07 when older',
  },
  {
    name: 'approvals',
    filename: 'approvals.sqlite',
    envVar: 'AOC_ENTERPRISE_APPROVAL_SQLITE_PATH',
    configKey: 'approval.sqlitePath',
    configPathOf: (config) => config.approval.sqlitePath,
    targetFilename: 'approvals.sqlite',
    condition: 'approvals-declared',
    purpose: 'CORE-05 approval log, signed chain head',
    version: { kind: 'meta-row', table: 'approval_store_meta' },
    supportedSchemaVersionsOf: ({ approvals }) => [approvals.APPROVAL_STORE_SCHEMA_VERSION],
    recordTable: 'approval_records',
    integrity: 'Ed25519-signed chain head over a digest chain',
    signedHead: { table: 'approval_head', sequenceColumn: 'sequence', digestColumn: 'chain_digest', metaTable: 'approval_store_meta', rowTable: 'approval_records' },
    freshnessStateKind: 'approval-state',
    open: async ({ factories }, path, authority) => {
      const store = await factories.approvals.createSqliteApprovalStore(path, { now: () => new Date().toISOString(), organizationId: authority.organizationId, authenticity: authority.authenticity });
      // The whole chain, every row, re-verified under the signed head.
      await store.read(authority.organizationId);
      return store;
    },
    lossEffect: 'a lost rejection or revocation can be re-approved (widens); refused under CORE-07 when older',
  },
  {
    name: 'control-plane',
    filename: 'control-plane.sqlite',
    envVar: 'AOC_ENTERPRISE_CONTROL_PLANE_SQLITE_PATH',
    configKey: 'controlPlane.sqlitePath',
    configPathOf: (config) => config.controlPlane.sqlitePath,
    targetFilename: 'control-plane.sqlite',
    condition: 'operators-configured',
    purpose: 'CTRL-02 agent credential verifiers and revocations, Governance Profile lifecycle',
    version: { kind: 'versions-table', table: 'control_plane_versions', migrationState: false },
    supportedSchemaVersionsOf: ({ controlPlane }) => [controlPlane.CONTROL_PLANE_SCHEMA_VERSION],
    recordTable: 'agent_credentials',
    integrity: 'append-only triggers (unsigned; NOT CORE-07 anchored — see the PROD-02 residual)',
    open: ({ factories }, path) => factories.controlPlane.createSqliteControlPlaneStore(path, {}),
    lossEffect: 'all issued agent credentials and active profiles lost (narrows); an older copy resurrects a revoked verifier (widens, residual)',
  },
  {
    name: 'evidence-bundles',
    filename: 'evidence-bundles.sqlite',
    envVar: 'AOC_ENTERPRISE_EVIDENCE_SQLITE_PATH',
    configKey: 'evidence.sqlitePath',
    configPathOf: (config) => config.evidence.sqlitePath,
    targetFilename: 'evidence-bundles.sqlite',
    condition: 'always',
    purpose: 'ASSURE-01 Evidence Bundles (v1 decision projections, v2 trace bundles) and their lifecycle',
    version: { kind: 'versions-table', table: 'evidence_bundle_store_versions', migrationState: true },
    supportedSchemaVersionsOf: ({ evidence }) => [evidence.EVIDENCE_STORE_SCHEMA_VERSION],
    recordTable: 'evidence_bundles',
    integrity: 'per-row SHA-256 digest over the exact bundle bytes plus each bundle\'s own digests; lifecycle replayed from an append-only log (unsigned)',
    open: async ({ factories }, path) => {
      const store = await factories.evidence.createSqliteEvidenceStore(path, { now: () => new Date().toISOString() });
      // Every bundle, its digests and its lifecycle, re-verified on the scratch copy.
      await store.verifyAll();
      return store;
    },
    lossEffect: 'issued evidence bundles and their lifecycle lost (bundles can be rebuilt from the canonical records, but under new ids; a bundle a third party holds can no longer be looked up)',
  },
]);

/**
 * Durable state that is deliberately NOT part of the backup, each with its
 * reason. The structural test requires every `*_SQLITE_PATH` the Host reads to
 * appear either in STORE_DEFINITIONS or here.
 */
export const EXCLUDED_DURABLE_STATE = Object.freeze([
  {
    name: 'authority-state-witness',
    envVar: 'FRONTERA_REFERENCE_WITNESS_DB',
    reason:
      'CORE-07: the freshness witness must live outside the authority stores\' restore domain (different volume, backup set and snapshot schedule). Restoring it with the authority stores to the same moment would make a stale state look current. It is never backed up, reset or enrolled by this tooling.',
  },
  {
    name: 'authority-state-witness-receipt-key',
    envVar: 'FRONTERA_REFERENCE_WITNESS_KEY_FILE',
    reason: 'The witness receipt private key: secret, held by the witness operator only.',
  },
  {
    name: 'authority-signing-key',
    envVar: 'AOC_ENTERPRISE_AUTHORITY_SIGNING_KEY_PEM',
    reason: 'Software-custody authority private key: secret; restored from the secret manager, never from a data backup.',
  },
  {
    name: 'reference-authority-signer-key-file',
    envVar: 'FRONTERA_REFERENCE_SIGNER_KEY_FILE',
    reason: 'External-custody signer key: lives with the signer service, never with the Host data.',
  },
  {
    name: 'reference-xrpl-signer-key-file',
    envVar: 'FRONTERA_REFERENCE_XRPL_SIGNER_KEY_FILE',
    reason: 'PAY-03: the reference XRPL signer\'s key lives with that signer process, never with the Host data. The Host refuses to start with it in its environment.',
  },
  {
    name: 'policy-packs',
    envVar: null,
    reason: 'Composed in-process by the embedder; no durable store exists on the Host.',
  },
  {
    name: 'library-only-sqlite-stores',
    envVar: null,
    reason:
      'access-governance, authority-governance, mandate and protected-resource SQLite stores are library components the Enterprise Host never composes (no Host configuration names them). An embedder that composes one owns its backup.',
  },
  {
    name: 'payment-business-operations',
    envVar: null,
    reason:
      'PAY-04: the payment business-operation store (createSqlitePaymentBusinessOperationStore; file schema aoc.payment-business-operation-store.schema.v2 when anchored) is composed by an embedder beside the governed-action orchestrator; the Enterprise Host composes no payment protocol ingress and no Host configuration names the store, so backup:v1 does not cover it. An embedder that composes it backs its file up itself, with the Governance Store it belongs to (verifyAll() is the deep integrity check), and must keep the CORE-07 witness outside that backup domain. Since the PAY-04 post-merge hardening its challenge-ownership history is anchored at the CORE-07 witness (slot payment-business-operation-state; not a signed store): a stale or lost copy is refused at the next open, so a challenge already paid for never becomes payable again under a new business operation; the derived governed key still makes the same operation replay at the Governance Store (docs/payments/PAY-04-PAYMENT-PROTOCOL-ADAPTER.md §10.1, §10.2).',
  },
  {
    name: 'payment-settlements',
    envVar: null,
    reason:
      'PAY-05: the payment settlement store (createSqlitePaymentSettlementStore, schema aoc.payment-settlement-store.schema.v1) is composed by an embedder beside the governed-action orchestrator; the Enterprise Host composes no settlement service and no Host configuration names the store, so backup:v1 does not cover it. An embedder that composes it backs its file up itself, with the Governance Store and P11 / P12 stores it belongs to. It is reconstructible from immutable external finality and is not witness-anchored: a lost or stale copy makes a settled payment read awaiting-finality (no receipt, discharge or refund) until an explicit verification re-establishes the identical content and receipt — availability, never eligibility (docs/payments/PAY-05-SETTLEMENT-AND-RECEIPTS.md §12, §17).',
  },
  {
    name: 'payment-refund-accounting',
    envVar: null,
    reason:
      'PAY-05: the refund accounting (createSqlitePaymentRefundLedger, schema aoc.payment-refund-ledger.schema.v1) is composed by an embedder beside the refund service; the Enterprise Host composes neither, so backup:v1 does not cover it. An embedder that composes it backs its file up itself and must keep the CORE-07 witness outside that backup domain: its history is always anchored at the witness (slot payment-refund-state), so a stale or lost copy — which would recreate refundable balance — is refused at open, and recovery is restoring the newest file or trusted recovery at the witness (docs/payments/PAY-05-SETTLEMENT-AND-RECEIPTS.md §11, §12, §17).',
  },
  {
    name: 'lightning-payment-interlock',
    envVar: null,
    reason:
      'PAY-06: the Lightning payment interlock (createSqliteLightningPaymentInterlock, schema aoc.lightning-payment-interlock.schema.v1) is composed by an embedder beside the Lightning rail; the Enterprise Host composes no Lightning rail and no Host configuration names the store, so backup:v1 does not cover it. An embedder that composes it backs its file up itself, with the Governance Store and P11 / P12 stores it belongs to, and must keep the CORE-07 witness outside that backup domain: its reservation history is always anchored at the witness (slot payment-initiation-reservations), so a stale or lost copy — which could make a payment already initiated look new — is refused at open with nothing sent, and recovery is restoring the newest file or trusted recovery at the witness (docs/payments/PAY-06-LIGHTNING-RAIL.md §12).',
  },
  {
    name: 'human-identity',
    envVar: 'AOC_ENTERPRISE_HUMAN_IDENTITY_SQLITE_PATH',
    reason:
      'AUTH-04A: the signed human identity store (humans, passkey public keys, consumed ceremony and decision challenges) is composed only when AOC_ENTERPRISE_HUMAN_AUTHORITY_MODE=enabled, in-process, with no route yet. backup:v1 does not cover it in this increment; an operator who enables it backs its file up with the Online Backup API outside backup:v1 and must keep the CORE-07 witness outside that backup domain. Its signed head is always anchored at the witness (slot human-identity-state): a stale copy — which could resurrect a revoked passkey or a consumed decision — is refused at open, and a lost file is never recreated over an advanced slot. Loss narrows (no human decision can be authorized until the newest copy is restored or the slot is recovered at the witness); it never widens.',
  },
  {
    name: 'governed-actions-file',
    envVar: 'AOC_ENTERPRISE_GOVERNED_ACTIONS_FILE',
    reason: 'Configuration, secret-free by design, kept in configuration management. The manifest records its SHA-256 so a restore can be matched to it.',
  },
]);

/** Environment variables that hold secret VALUES on every Host. Never serialized; the manifest names them so an operator knows what to restore from the secret manager. */
export const STATIC_SECRET_ENV_VARS = Object.freeze([
  'AOC_ENTERPRISE_API_KEYS',
  'AOC_ENTERPRISE_AUTHORITY_SIGNING_KEY_PEM',
  'AOC_ENTERPRISE_AUTHORITY_SIGNER_TOKEN',
  'AOC_ENTERPRISE_AUTHORITY_FRESHNESS_TOKEN',
]);

/** The names of the secret-bearing references a governed-action file may declare (`apiKeyEnv`, `tokenEnv`, `valueEnv`). */
const SECRET_REFERENCE_KEYS = new Set(['apiKeyEnv', 'tokenEnv', 'valueEnv']);

function collectSecretReferences(value, into) {
  if (Array.isArray(value)) {
    for (const entry of value) collectSecretReferences(entry, into);
    return;
  }
  if (value === null || typeof value !== 'object') return;
  for (const [key, entry] of Object.entries(value)) {
    if (SECRET_REFERENCE_KEYS.has(key) && typeof entry === 'string') into.add(entry);
    else collectSecretReferences(entry, into);
  }
}

export class DeploymentRequirementsError extends Error {}

/**
 * Which conditional stores this deployment composes, read structurally from
 * the environment and the governed-action file. **No secret is resolved**: the
 * file is parsed as JSON and only its shape is inspected, so backup and
 * restore never need (or touch) a credential value.
 *
 * Fails closed: a configured governed-action file that cannot be read or
 * parsed refuses, because the stores it would require are then unknowable.
 */
export function deriveDeploymentRequirements(env, configuration) {
  // Read exactly as the Host reads it: a blank value configures nothing.
  const rawPath = env.AOC_ENTERPRISE_GOVERNED_ACTIONS_FILE;
  const filePath = rawPath !== undefined && rawPath.trim().length > 0 ? rawPath : undefined;
  let file;
  let fileDigest = null;
  if (filePath !== undefined && filePath !== '') {
    let raw;
    try {
      raw = readFileSync(filePath);
    } catch {
      throw new DeploymentRequirementsError(`AOC_ENTERPRISE_GOVERNED_ACTIONS_FILE names a file that could not be read; the stores this deployment requires cannot be determined.`);
    }
    try {
      file = JSON.parse(raw.toString('utf8'));
    } catch {
      throw new DeploymentRequirementsError('AOC_ENTERPRISE_GOVERNED_ACTIONS_FILE is not valid JSON; the stores this deployment requires cannot be determined.');
    }
    if (file === null || typeof file !== 'object' || Array.isArray(file)) {
      throw new DeploymentRequirementsError('AOC_ENTERPRISE_GOVERNED_ACTIONS_FILE must contain a JSON object.');
    }
    fileDigest = `sha256:${createHash('sha256').update(raw).digest('hex')}`;
  }
  const governedActions = file !== undefined;
  const profiles = Array.isArray(file?.governance?.profiles) ? file.governance.profiles : [];
  const secretReferences = new Set();
  if (file !== undefined) collectSecretReferences(file, secretReferences);
  return {
    persistenceProvider: configuration.persistence.provider,
    kernelAuthorityEnabled: configuration.kernelAuthority?.enabled === true,
    governedActions,
    obligationsDeclared: governedActions && file.obligations !== undefined,
    approvalsDeclared: governedActions && profiles.some((profile) => profile !== null && typeof profile === 'object' && profile.approval !== undefined),
    operatorsConfigured: governedActions && Array.isArray(file.operators) && file.operators.length > 0,
    // PROD-03-02: the Host composes P12 (operator attestation) exactly when it serves an operator plane.
    // PAY-03: and whenever it composes the XRPL rail (the XRPL resolution authority).
    // TRADE-04C: and whenever it composes the governed trade executor (the trade resolution authority).
    executionReconciliation: governedActions && ((Array.isArray(file.operators) && file.operators.length > 0) || file.xrplPaymentRail !== undefined || file.xrplTradeExecution !== undefined),
    xrplPaymentRail: governedActions && file.xrplPaymentRail !== undefined,
    xrplTradeExecution: governedActions && file.xrplTradeExecution !== undefined,
    governedActionsFileDigest: fileDigest,
    secretReferenceEnvVars: [...secretReferences].sort(),
  };
}

/** Whether `condition` holds for `requirements`. The one place a condition is evaluated. */
export function conditionHolds(condition, requirements) {
  switch (condition) {
    case 'always':
      return true;
    case 'kernel-authority-enabled':
      return requirements.kernelAuthorityEnabled === true;
    case 'governed-actions':
      return requirements.governedActions === true;
    case 'obligations-declared':
      return requirements.governedActions === true && requirements.obligationsDeclared === true;
    case 'approvals-declared':
      return requirements.governedActions === true && requirements.approvalsDeclared === true;
    case 'operators-configured':
      // Operators come only from the governed-action file.
      return requirements.governedActions === true && requirements.operatorsConfigured === true;
    case 'embedder-reconciliation':
      return requirements.executionReconciliation === true;
    case 'xrpl-payment-rail':
      return requirements.governedActions === true && requirements.xrplPaymentRail === true;
    case 'xrpl-trade-execution':
      return requirements.governedActions === true && requirements.xrplTradeExecution === true;
    default:
      // An unknown condition is a registry defect; refusing is the only safe reading.
      throw new DeploymentRequirementsError(`Unknown store condition '${String(condition)}'.`);
  }
}

/** The registry entries this deployment requires (must exist and must be backed up). */
export function requiredStoreDefinitions(requirements) {
  return STORE_DEFINITIONS.filter((storeDef) => conditionHolds(storeDef.condition, requirements));
}

export function storeDefinitionByName(name) {
  return STORE_DEFINITIONS.find((storeDef) => storeDef.name === name);
}

/** Restore mapping: target directory → `{ store, envVar, path }` per registry entry. Derived, never hand-maintained. */
export function targetStorePaths(targetDir) {
  return Object.fromEntries(STORE_DEFINITIONS.map((storeDef) => [storeDef.name, resolve(targetDir, storeDef.targetFilename)]));
}

/** The Host environment that points every store at `dataDir`, using the registry's target filenames. */
export function storeEnvironmentFor(dataDir) {
  return Object.fromEntries(STORE_DEFINITIONS.map((storeDef) => [storeDef.envVar, resolve(dataDir, storeDef.targetFilename)]));
}

// -- backup coverage: the ONE reading of a PROD-02 manifest's store inventory ----------------
//
// Pure (no file is opened): restore:v1 uses it before it touches a target, and
// the PROD-03 readiness gate uses it to judge a backup set (PR-15), so there
// is exactly one interpretation of "a complete backup" — never the producer's
// own `coverage.complete` alone.

/** A manifest the registry cannot accept. restore:v1 reports it as its own RestoreValidationError, message unchanged. */
export class BackupManifestError extends Error {}

/**
 * The manifest's store inventory: a non-empty list of objects, each with a
 * name, filename, checksum and schema version; no duplicate name or file;
 * every name a registry store, stored under that store's registry filename.
 */
export function validateManifestStoreEntries(manifest) {
  if (!Array.isArray(manifest?.stores) || manifest.stores.length === 0) {
    throw new BackupManifestError('Malformed manifest: "stores" must be a non-empty array.');
  }

  const names = new Set();
  const filenames = new Set();
  for (const entry of manifest.stores) {
    if (entry === null || typeof entry !== 'object') throw new BackupManifestError('Malformed manifest: every store entry must be an object.');
    for (const field of ['name', 'filename', 'checksum', 'schemaVersion']) {
      if (entry[field] === undefined || entry[field] === null) throw new BackupManifestError(`Malformed manifest: store entry is missing '${field}'.`);
    }
    if (names.has(entry.name)) throw new BackupManifestError(`Malformed manifest: store '${entry.name}' appears more than once.`);
    if (filenames.has(entry.filename)) throw new BackupManifestError(`Malformed manifest: file '${entry.filename}' is claimed by more than one store.`);
    names.add(entry.name);
    filenames.add(entry.filename);
    const storeDef = storeDefinitionByName(entry.name);
    // A store this runtime does not know cannot be mapped, verified or opened.
    // It might be authority state a newer build depends on: refuse, never skip.
    if (storeDef === undefined) throw new BackupManifestError(`Unknown store '${String(entry.name)}' in the manifest. This runtime's registry does not know it; refusing rather than dropping it.`);
    if (entry.filename !== storeDef.filename) {
      throw new BackupManifestError(`Store '${entry.name}' must be stored as 'stores/${storeDef.filename}', but the manifest names '${String(entry.filename)}'.`);
    }
  }
}

/**
 * Every deployment flag a store condition reads. Closed and complete: a flag a
 * condition reads but this list omits would let a manifest that drops it
 * quietly un-require that store (PAY-03 `xrplPaymentRail`, TRADE-04C
 * `xrplTradeExecution`). Pinned against `conditionHolds` by test.
 */
export const DEPLOYMENT_FLAGS = Object.freeze(['kernelAuthorityEnabled', 'governedActions', 'obligationsDeclared', 'approvalsDeclared', 'operatorsConfigured', 'executionReconciliation', 'xrplPaymentRail', 'xrplTradeExecution']);

/**
 * Which required stores the backup does not include, judged two ways and
 * never by trusting the producer's own `complete` flag:
 *
 * - against the backup's own recorded deployment, with THIS build's conditions
 *   (so a backup from an older registry that omitted a store the deployment
 *   composed is caught);
 * - against the restoring deployment's environment, when one is given.
 */
export function assessBackupCoverage(manifest, targetRequirements) {
  const included = new Set(manifest.stores.map((entry) => entry.name));
  if (manifest.coverage === undefined) {
    const missingForTarget = targetRequirements === undefined ? [] : STORE_DEFINITIONS.filter((d) => conditionHolds(d.condition, targetRequirements) && !included.has(d.name)).map((d) => d.name);
    return { model: 'legacy', complete: false, missingForSource: null, missingForTarget, reason: 'pre-PROD-02 backup: no coverage record, so it cannot be shown to be complete' };
  }
  const coverage = manifest.coverage;
  if (coverage === null || typeof coverage !== 'object' || coverage.coverageModel !== COVERAGE_MODEL) {
    throw new BackupManifestError(`Unsupported coverage model '${String(coverage?.coverageModel)}'. This runtime understands only '${COVERAGE_MODEL}'; an unknown model fails closed.`);
  }
  if (coverage.deployment === null || typeof coverage.deployment !== 'object' || !Array.isArray(coverage.stores)) {
    throw new BackupManifestError('Malformed manifest: coverage must record the source deployment and every store.');
  }
  // The producer's record is input, never trusted shape: every flag a
  // condition reads must be a real boolean (a string "true" would read as
  // false and quietly un-require a store), the organization must be named,
  // and every registry store must be accounted for exactly once.
  for (const flag of DEPLOYMENT_FLAGS) {
    if (typeof coverage.deployment[flag] !== 'boolean') throw new BackupManifestError(`Malformed manifest: coverage.deployment.${flag} must be a boolean.`);
  }
  if (typeof coverage.deployment.organizationId !== 'string' || coverage.deployment.organizationId.length === 0) {
    throw new BackupManifestError('Malformed manifest: coverage.deployment.organizationId must name the organization the backup belongs to.');
  }
  if (typeof coverage.complete !== 'boolean') throw new BackupManifestError('Malformed manifest: coverage.complete must be a boolean.');
  for (const storeDef of STORE_DEFINITIONS) {
    const entries = coverage.stores.filter((entry) => entry?.name === storeDef.name);
    if (entries.length !== 1) throw new BackupManifestError(`Malformed manifest: coverage must record store '${storeDef.name}' exactly once.`);
    if (typeof entries[0].required !== 'boolean' || typeof entries[0].included !== 'boolean') throw new BackupManifestError(`Malformed manifest: coverage of '${storeDef.name}' must say whether it is required and included.`);
  }
  for (const entry of coverage.stores) {
    if (storeDefinitionByName(entry?.name) === undefined) throw new BackupManifestError(`Unknown store '${String(entry?.name)}' in coverage.`);
  }
  for (const entry of coverage.stores) {
    if (entry?.included === true && !included.has(entry.name)) throw new BackupManifestError(`Malformed manifest: coverage says '${String(entry.name)}' is included, but the manifest has no such store.`);
  }
  for (const name of included) {
    if (!coverage.stores.some((entry) => entry?.name === name && entry.included === true)) throw new BackupManifestError(`Malformed manifest: store '${name}' is not recorded as included in coverage.`);
  }
  const missingForSource = STORE_DEFINITIONS.filter((d) => conditionHolds(d.condition, coverage.deployment) && !included.has(d.name)).map((d) => d.name);
  const missingForTarget = targetRequirements === undefined ? [] : STORE_DEFINITIONS.filter((d) => conditionHolds(d.condition, targetRequirements) && !included.has(d.name)).map((d) => d.name);
  // Whatever the producer itself recorded as required-but-absent stays absent.
  const declaredMissing = coverage.stores.filter((entry) => entry.required === true && entry.included !== true).map((entry) => entry.name);
  const complete = missingForSource.length === 0 && missingForTarget.length === 0 && declaredMissing.length === 0 && coverage.complete === true;
  const reasons = [];
  if (missingForSource.length > 0) reasons.push(`the source deployment composed ${missingForSource.join(', ')}, which the backup does not include`);
  if (missingForTarget.length > 0) reasons.push(`the restoring deployment requires ${missingForTarget.join(', ')}, which the backup does not include`);
  if (declaredMissing.length > 0) reasons.push(`the backup records ${declaredMissing.join(', ')} as required but not included`);
  if (coverage.complete !== true) reasons.push('the backup records itself as incomplete');
  if (coverage.complete === true && (missingForSource.length > 0 || declaredMissing.length > 0)) reasons.push('the manifest claims to be complete, which it is not');
  return { model: COVERAGE_MODEL, complete, missingForSource, missingForTarget, reason: reasons.join('; ') };
}


let cachedModules;

/** The built modules whose exported schema-version constants the registry reads. Requires `npm run build`. */
export async function loadRegistryModules(repoRoot) {
  if (cachedModules !== undefined) return cachedModules;
  const dist = (path) => resolve(repoRoot, 'dist/src', path);
  const required = (path) => {
    if (!existsSync(dist(path))) throw new Error(`Built output not found at ${dist(path)}. Run "npm run build" before using the portability tooling.`);
    return import(dist(path));
  };
  cachedModules = {
    enterprise: await required('enterprise/index.js'),
    boundedGrant: await required('features/grant-runtime/services/in-memory-bounded-grant-store.js'),
    emergencyControl: await required('enterprise/emergency-control/emergency-control-record.js'),
    exerciseLedger: await required('enterprise/exercise-control-ledger/exercise-control-record.js'),
    eventStream: await required('enterprise/authority-event-stream/contracts.js'),
    outcomes: await required('enterprise/execution-outcome-store/contracts.js'),
    resolutions: await required('enterprise/execution-resolution-store/contracts.js'),
    obligations: await required('enterprise/obligation-discharge/contracts.js'),
    approvals: await required('enterprise/approval-authority/contracts.js'),
    controlPlane: await required('enterprise/operator-control/control-plane-store.js'),
    evidence: await required('enterprise/evidence/sqlite-evidence-store.js'),
    xrplInterlock: await required('enterprise/xrpl-payment-rail/sqlite-xrpl-submission-interlock.js'),
    tradeInterlock: await required('enterprise/xrpl-trade-execution/sqlite-trade-sequence-interlock.js'),
    authenticity: await required('enterprise/authority-authenticity/index.js'),
  };
  cachedModules.factories = {
    boundedGrant: await required('enterprise/bounded-grant-store/index.js'),
    emergencyControl: await required('enterprise/emergency-control/sqlite-emergency-control-store.js'),
    exerciseLedger: await required('enterprise/exercise-control-ledger/sqlite-exercise-control-ledger.js'),
    eventStream: await required('enterprise/authority-event-stream/sqlite-authority-event-stream-store.js'),
    outcomes: await required('enterprise/execution-outcome-store/sqlite-execution-outcome-store.js'),
    resolutions: await required('enterprise/execution-resolution-store/sqlite-execution-resolution-store.js'),
    obligations: await required('enterprise/obligation-discharge/index.js'),
    approvals: await required('enterprise/approval-authority/index.js'),
    controlPlane: await required('enterprise/operator-control/control-plane-store.js'),
    evidence: await required('enterprise/evidence/sqlite-evidence-store.js'),
    xrplInterlock: await required('enterprise/xrpl-payment-rail/sqlite-xrpl-submission-interlock.js'),
    tradeInterlock: await required('enterprise/xrpl-trade-execution/sqlite-trade-sequence-interlock.js'),
  };
  return cachedModules;
}

export function backupFilenames() {
  return STORE_DEFINITIONS.map((storeDef) => storeDef.filename);
}

export function describeStore(storeDef) {
  return `${storeDef.name} (${storeDef.envVar} -> ${basename(storeDef.targetFilename)})`;
}
