import { EMERGENCY_CONTROL_REASON_CODES, type EmergencyControlReasonCode } from './emergency-control-reason-codes.js';

/**
 * The operational safety interlock: **may execution proceed at all right now?**
 *
 * ## It is not a second policy engine
 *
 * It evaluates no rule, resolves no context, reads no authority and produces no
 * decision. It answers one question, from durable operator-set state, with three
 * possible answers — `clear`, `blocked`, `unavailable` — and the last two both
 * withhold. Everything it can say leaves the Kernel's decision, the bounded
 * grant and the grant-exercise assessment exactly as they were.
 *
 * ## Why the read is synchronous
 *
 * `BoundedGrantStorePort.issue` takes a **synchronous** `commitGuard`, called
 * inside the store's critical section with no `await` between the read that
 * decides and the write that records. An emergency control that could only be
 * read asynchronously could not be consulted there, and a stop that turns on
 * between the admission check and the commit would mint authority anyway. So
 * the port is synchronous, and a durable implementation must be able to answer
 * synchronously — which `better-sqlite3` is.
 *
 * A reader that cannot answer synchronously is not a reader this port accepts.
 * It is emphatically **not** permitted to satisfy the type by resolving a cached
 * promise: the value returned must reflect the state at the instant of the call.
 */

/**
 * The axes a control may be declared on. Exact matching only — no glob, no
 * regex, no prefix. A wider matching language is a place for an operator to
 * believe they stopped more than they did, and this phase does not introduce
 * one.
 *
 * `workflow` exists in the model because the architecture target names it, and
 * is deliberately **unreachable from the Governed Action path today**: there is
 * no canonical, trusted workflow identity on `GovernedActionIntent` or
 * `KernelEvaluationRequest`, and manufacturing one from caller input would let
 * a caller choose which controls apply to it. A control declared on `workflow`
 * is therefore inert until a trusted workflow source exists.
 * See `docs/enterprise/AOC_EMERGENCY_CONTROL.md`.
 */
export const EMERGENCY_CONTROL_SCOPES = ['global', 'organization', 'actor', 'workflow', 'adapter', 'resource'] as const;

export type EmergencyControlScope = (typeof EMERGENCY_CONTROL_SCOPES)[number];

export function isEmergencyControlScope(value: unknown): value is EmergencyControlScope {
  return typeof value === 'string' && (EMERGENCY_CONTROL_SCOPES as readonly string[]).includes(value);
}

/**
 * What is being attempted, in the only terms an interlock is allowed to know.
 *
 * Every field is trusted server-side material: the bound organization, the
 * bound actor, the resource the decision was evaluated for, the adapter trusted
 * routing selected. There is no credential, no grant, no decision, no context
 * and no free-form field, because none of them is needed to answer "has an
 * operator stopped this?".
 *
 * Every field is optional because different checkpoints know different things:
 * admission knows organization, actor and resource; the registry additionally
 * knows the selected adapter. `global` applies to every query, including `{}`.
 */
export interface EmergencyControlQuery {
  readonly organizationId?: string;
  readonly actorId?: string;
  /** Reserved. No current Governed Action path supplies one — see `EMERGENCY_CONTROL_SCOPES`. */
  readonly workflowId?: string;
  /** The **selected child adapter**, known only after trusted server-side routing. */
  readonly adapterId?: string;
  readonly resource?: string;
}

/** A control that matched, for operator diagnostics. Carries only values the querying layer already supplied. */
export interface EmergencyControlScopeMatch {
  readonly scope: EmergencyControlScope;
  /** Absent for `global`, which has no value. */
  readonly value?: string;
}

/**
 * What the reader established.
 *
 * Three states, and `unavailable` is **not** a flavour of `clear`. A caller
 * that treats them alike has turned an outage into permission, which is the
 * failure mode this whole capability exists to remove; `emergencyControlPermits`
 * is provided so the check is written the same way everywhere.
 */
export type EmergencyControlAssessment =
  | { readonly state: 'clear'; readonly reasonCodes: readonly EmergencyControlReasonCode[] }
  | {
      readonly state: 'blocked';
      readonly reasonCodes: readonly EmergencyControlReasonCode[];
      /** Which applicable controls were active. Diagnostics only; never authority. */
      readonly matchedScopes: readonly EmergencyControlScopeMatch[];
    }
  | { readonly state: 'unavailable'; readonly reasonCodes: readonly EmergencyControlReasonCode[] };

/**
 * The **read capability, and nothing else**.
 *
 * Execution and authorization components are typed against this and never
 * against a store: an execution path that could reach `activate`/`clear` could
 * disable the interlock that governs it. `EmergencyControlStorePort` extends
 * this, so a host still injects one object; what changes is that mutation is
 * not reachable from the consuming side even by accident.
 */
export interface EmergencyControlReaderPort {
  /** Synchronous by contract — see this file's header. Implementations must not throw; a failure is `unavailable`. */
  read(query: EmergencyControlQuery): EmergencyControlAssessment;
}

export const EMERGENCY_CONTROL_CLEAR: EmergencyControlAssessment = Object.freeze({ state: 'clear', reasonCodes: Object.freeze([]) });

export function emergencyControlUnavailable(): EmergencyControlAssessment {
  return { state: 'unavailable', reasonCodes: [EMERGENCY_CONTROL_REASON_CODES.EMERGENCY_CONTROL_UNAVAILABLE] };
}

export function emergencyControlBlocked(matchedScopes: readonly EmergencyControlScopeMatch[]): EmergencyControlAssessment {
  return { state: 'blocked', reasonCodes: [EMERGENCY_CONTROL_REASON_CODES.EMERGENCY_CONTROL_ACTIVE], matchedScopes: Object.freeze([...matchedScopes]) };
}

/** The one permitted reading of an assessment. `clear` proceeds; everything else withholds. */
export function emergencyControlPermits(assessment: EmergencyControlAssessment): boolean {
  return assessment.state === 'clear';
}

/**
 * Reads the interlock without letting a defective implementation become
 * permission.
 *
 * A reader that raises, returns a non-assessment, or returns a state outside the
 * closed set is treated as `unavailable`. That is the whole of the fail-closed
 * discipline, written once so all four checkpoints share it rather than each
 * re-deriving it.
 */
export function readEmergencyControl(reader: EmergencyControlReaderPort | undefined, query: EmergencyControlQuery): EmergencyControlAssessment {
  if (reader === undefined) return EMERGENCY_CONTROL_CLEAR;
  let returned: unknown;
  try {
    returned = reader.read(query);
  } catch {
    return emergencyControlUnavailable();
  }
  if (typeof returned !== 'object' || returned === null) return emergencyControlUnavailable();
  const assessment = returned as EmergencyControlAssessment;
  if (assessment.state === 'clear') return EMERGENCY_CONTROL_CLEAR;
  if (assessment.state === 'blocked') {
    // Re-derived rather than trusted: an implementation that reported `blocked`
    // with no reason would otherwise hand a withholding caller nothing to say.
    return emergencyControlBlocked(Array.isArray(assessment.matchedScopes) ? assessment.matchedScopes : []);
  }
  return emergencyControlUnavailable();
}

/**
 * Whether a query states every field it states *well*.
 *
 * A present-but-blank scope value is refused rather than matched, for the
 * reason `isWellFormedGrantExerciseRequest` gives one module over: an empty
 * string matching an empty string is not a proof of anything, and a control
 * stored under a blank value is state nobody declared.
 */
export function isWellFormedEmergencyControlQuery(query: EmergencyControlQuery): boolean {
  if (query === null || typeof query !== 'object') return false;
  for (const value of [query.organizationId, query.actorId, query.workflowId, query.adapterId, query.resource]) {
    if (value === undefined) continue;
    if (typeof value !== 'string' || value.length === 0) return false;
  }
  return true;
}

/**
 * Every control that could apply to this query, as `(scope, value)` pairs.
 *
 * `global` is always first and always applies. Every other scope applies only
 * when the query states that axis. Shared by every implementation so the
 * in-memory reader and the durable one cannot drift on what "applicable" means.
 */
export function applicableEmergencyControlScopes(query: EmergencyControlQuery): readonly EmergencyControlScopeMatch[] {
  const applicable: EmergencyControlScopeMatch[] = [{ scope: 'global' }];
  if (query.organizationId !== undefined) applicable.push({ scope: 'organization', value: query.organizationId });
  if (query.actorId !== undefined) applicable.push({ scope: 'actor', value: query.actorId });
  if (query.workflowId !== undefined) applicable.push({ scope: 'workflow', value: query.workflowId });
  if (query.adapterId !== undefined) applicable.push({ scope: 'adapter', value: query.adapterId });
  if (query.resource !== undefined) applicable.push({ scope: 'resource', value: query.resource });
  return applicable;
}

/** The deterministic identity of one control. Exact, so `organization:org-a` can never be read as `organization:org-ab`. */
export function emergencyControlKey(scope: EmergencyControlScope, value?: string): string {
  return scope === 'global' ? 'global' : `${scope}:${value ?? ''}`;
}

/**
 * What a **trusted operator** declares. Never caller input, never an intent
 * field, and never reachable from an execution component.
 */
export interface EmergencyControlDeclaration {
  readonly scope: EmergencyControlScope;
  /** Required for every scope but `global`, which has no value. */
  readonly value?: string;
  /** Who declared it. Recorded for operator audit; never returned by a read. */
  readonly issuerRef: string;
  readonly declaredAt: string;
}

/** Whether a declaration states what its own scope requires. A malformed declaration is refused at write time rather than stored and mis-read later. */
export function isWellFormedEmergencyControlDeclaration(declaration: EmergencyControlDeclaration): boolean {
  if (!isEmergencyControlScope(declaration.scope)) return false;
  if (declaration.scope === 'global') {
    if (declaration.value !== undefined) return false;
  } else if (typeof declaration.value !== 'string' || declaration.value.length === 0) {
    return false;
  }
  return typeof declaration.issuerRef === 'string' && declaration.issuerRef.length > 0 && typeof declaration.declaredAt === 'string' && declaration.declaredAt.length > 0;
}

/** Which control an operator is clearing, and who cleared it. */
export interface EmergencyControlRelease {
  readonly scope: EmergencyControlScope;
  readonly value?: string;
  readonly issuerRef: string;
  readonly releasedAt: string;
}

/**
 * The operator surface: the read capability **plus** the two mutations.
 *
 * Kept on the host/operator side of the trust boundary. There is no customer
 * HTTP route, no customer SDK method, no `GovernedActionIntent` field and no
 * path through `AocEnterprise.evaluate()` that reaches either mutation, and a
 * structural test fails the build if one appears.
 */
export interface EmergencyControlStorePort extends EmergencyControlReaderPort {
  /** Declare a control active. Idempotent: re-declaring an active control leaves the original declaration standing. */
  activate(declaration: EmergencyControlDeclaration): void;
  /** Clear a control. Idempotent: clearing one that is not active is a no-op rather than an error. */
  release(release: EmergencyControlRelease): void;
  /** The controls currently active, for operator diagnostics. */
  active(): readonly EmergencyControlScopeMatch[];
}
