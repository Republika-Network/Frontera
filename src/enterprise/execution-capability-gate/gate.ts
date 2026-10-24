import { emergencyControlPermits, readEmergencyControl, type EmergencyControlReaderPort } from '../../features/emergency-control-runtime/index.js';
import type { ExecutionCapabilityIssuancePolicy } from '../authority-authenticity/execution-capability-issuance.js';
import type { TrustedVerificationKey } from '../authority-authenticity/signature-verification.js';
import { executionCapabilityActionBindingDigest, isExecutionCapabilityIdentifier } from '../execution-capability/capability.js';
import { createExecutionCapabilityVerifier, type ExecutionCapabilityVerifier } from '../execution-capability/verifier.js';
import type { ExecutionCapabilityIssuer } from '../execution-capability-issuance/issuer.js';
import { encodeExecutionCapabilityPresentation } from '../execution-capability-presentation/index.js';
import type { GenericHttpPreSendGate, GenericHttpPreSendSubject, GenericHttpPreSendVerdict } from '../execution-adapters/generic-http/generic-http-execution-adapter.js';
import { GENERIC_HTTP_REQUEST_BINDING_FORMAT } from '../execution-adapters/generic-http/request-binding.js';

/**
 * G-02C0 — the governed execution binding and safety gate.
 *
 * The one caller of the G-02B issuer. It runs inside a Generic HTTP adapter
 * that the composition root configured with an audience, **after** the request
 * is final and frozen and **before** any DNS lookup or socket:
 *
 * ```
 * GrantExecutionService (grant read, containment, P7 reservation, re-read, emergency)
 *   -> registry (routing, adapter-scoped emergency check)
 *   -> generic HTTP adapter: map plan + action -> frozen request
 *   -> this gate:
 *        1. binding    digest of frontera.http-request-binding.v1 over that exact request
 *        2. issue      the G-02B issuer: ledger check, authenticated grant re-read (revocation),
 *                      reserve, custody once, local signature check, commit
 *        3. verify     the standalone G-02A verifier, as the audience, against the binding
 *                      recomputed here — plus execution, subject and window equality
 *        4. emergency  the adapter-scoped stop, read again, synchronously
 *        5. proceed    (G-02C1D) with the G-02C1A presentation of exactly the capability issued and
 *                      verified in 2–3, which the adapter appends as its one fixed header
 *   -> DNS, address policy, the one send
 * ```
 *
 * What it guarantees: a request leaves only if a capability exists whose
 * signed binding is the digest of exactly that request, for exactly that
 * action, resource, execution and subject, under this deployment's issuer key,
 * and no emergency stop for it was read after issuance. Because the request is
 * a pure function of the action the exercise gate already contained within the
 * grant, the capability can authorize nothing broader or different from what
 * governance admitted.
 *
 * G-02C1D (D1): a proceed carries one presentation — the canonical
 * `frontera.execution-capability-presentation.v1` encoding of the issued
 * capability text and its custody signature, nothing else (no grant, no
 * nonce, no key). Only a capability that was issued, verified as the executor
 * would, matched to this execution and subject, and cleared by the stop
 * re-read, is ever encoded; the gate holds no copy afterwards, and the
 * issuance ledger holds the evidence. Every refusal — at any step — is
 * `{ proceed: false }`, carries nothing, and the adapter then sends nothing.
 */

export interface ExecutionCapabilityGateOptions {
  /** The Generic HTTP adapter this gate belongs to. A subject naming another adapter is refused. */
  readonly adapterId: string;
  /** The registered executor this adapter's requests are bound for. */
  readonly audience: string;
  /** The Host's issuance policy (issuer, organization, trust domain, lifetime, audiences). */
  readonly policy: ExecutionCapabilityIssuancePolicy;
  /** The G-02B issuer — in the Host, its write-once slot, which refuses until bound. */
  readonly issuer: Pick<ExecutionCapabilityIssuer, 'issue'>;
  readonly clock?: () => number;
}

/** What only exists once the composition has opened the authority boundary and the emergency-control world. */
export interface ExecutionCapabilityGateRuntime {
  /** The deployment's active authority key — the one key a capability this Host issued can be signed under. */
  readonly issuerKey: TrustedVerificationKey;
  /** The deployment's one emergency-control reader, or `undefined` when none is composed. */
  readonly emergencyControl: EmergencyControlReaderPort | undefined;
}

export interface ExecutionCapabilityGate {
  readonly adapterId: string;
  readonly audience: string;
  /** The hook the adapter calls. Refuses until `bind` has run. */
  readonly beforeSend: GenericHttpPreSendGate;
  /** Exactly once. */
  bind(runtime: ExecutionCapabilityGateRuntime): void;
  bound(): boolean;
}

export class ExecutionCapabilityGateConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExecutionCapabilityGateConfigurationError';
  }
}

const WITHHOLD: GenericHttpPreSendVerdict = Object.freeze({ proceed: false });

/** The one proceeding verdict: a frozen record of `proceed` and the presentation, and nothing else. */
function proceedWith(presentation: string): GenericHttpPreSendVerdict {
  return Object.freeze({ proceed: true, presentation });
}

export function createExecutionCapabilityGate(options: ExecutionCapabilityGateOptions): ExecutionCapabilityGate {
  const { adapterId, audience, policy, issuer } = options;
  if (!isExecutionCapabilityIdentifier(adapterId)) throw new ExecutionCapabilityGateConfigurationError('An execution capability gate needs its adapter id.');
  if (typeof issuer?.issue !== 'function') throw new ExecutionCapabilityGateConfigurationError('An execution capability gate needs the execution capability issuer.');
  const registered = policy?.audiences?.find((entry) => entry.audience === audience);
  if (registered === undefined) throw new ExecutionCapabilityGateConfigurationError(`The audience for adapter '${adapterId}' is not registered in the issuance policy.`);
  if (!registered.bindingFormats.includes(GENERIC_HTTP_REQUEST_BINDING_FORMAT)) {
    throw new ExecutionCapabilityGateConfigurationError(`The audience for adapter '${adapterId}' does not permit the ${GENERIC_HTTP_REQUEST_BINDING_FORMAT} binding format.`);
  }
  const clock = options.clock ?? Date.now;

  let runtime: { readonly verifier: ExecutionCapabilityVerifier; readonly emergencyControl: EmergencyControlReaderPort | undefined } | undefined;

  async function beforeSend(subject: GenericHttpPreSendSubject): Promise<GenericHttpPreSendVerdict> {
    try {
      const bound = runtime;
      if (bound === undefined) return WITHHOLD;
      if (subject.adapterId !== adapterId) return WITHHOLD;
      const action = subject.action;
      const executionId = action.correlation.executionId;

      // 1. The digest of the exact request the adapter will send.
      const actionBinding = { format: GENERIC_HTTP_REQUEST_BINDING_FORMAT, value: subject.binding };
      const digest = executionCapabilityActionBindingDigest(actionBinding);

      // 2. Issuance: the G-02B issuer re-reads the grant through the authenticated store and refuses a revoked one,
      //    reserves durably, asks custody once and verifies the signature under the active key.
      const issued = await issuer.issue({ executionId, boundedGrantId: action.boundedGrantId, audience, action: action.action, resource: action.resource, actionBinding: { format: GENERIC_HTTP_REQUEST_BINDING_FORMAT, digest } });

      // 3. Post-issuance verification, as the executor would: canonical form, pinned issuer key, audience,
      //    organization, trust domain, window, action, resource and the binding recomputed from the request. The verifier
      //    does not know the execution or the subject, so those are compared here, as is the action's own window.
      const verdict = bound.verifier.verify({ presentation: { capability: issued.canonical, signature: issued.signature }, action: action.action, resource: action.resource, actionBinding });
      if (verdict.verification !== 'verified') return WITHHOLD;
      const capability = verdict.capability;
      if (capability.executionId !== executionId) return WITHHOLD;
      if (capability.subjectActorId !== action.subject) return WITHHOLD;
      if (!(Date.parse(capability.expiresAt) <= Date.parse(action.notAfter))) return WITHHOLD;

      // 4. Issuance awaited; the stop is read again, synchronously, for this adapter, before anything is sent.
      const assessment = readEmergencyControl(bound.emergencyControl, {
        ...(action.organization !== undefined ? { organizationId: action.organization } : {}),
        actorId: action.subject,
        adapterId,
        resource: action.resource,
      });
      const permitted = emergencyControlPermits(assessment);
      if (!permitted) return WITHHOLD;

      // 5. The one presentation of exactly what was issued and verified above. The encoder refuses (throws) whatever its
      //    own decoder would refuse, which withholds.
      const presentation = encodeExecutionCapabilityPresentation({ capability: issued.canonical, signature: issued.signature, bindingFormat: GENERIC_HTTP_REQUEST_BINDING_FORMAT });
      return proceedWith(presentation);
    } catch {
      return WITHHOLD;
    }
  }

  return Object.freeze({
    adapterId,
    audience,
    beforeSend,
    bind(next: ExecutionCapabilityGateRuntime): void {
      if (runtime !== undefined) throw new ExecutionCapabilityGateConfigurationError('An execution capability gate is bound exactly once.');
      if (next?.issuerKey === undefined || next.issuerKey.keyId === undefined) throw new ExecutionCapabilityGateConfigurationError('An execution capability gate needs the active authority key.');
      // The executor view of this Host's own capabilities: one pinned issuer, its active key only, this audience.
      const verifier = createExecutionCapabilityVerifier({
        trustedIssuers: [{ issuer: policy.issuer, keys: [next.issuerKey] }],
        executor: { audience, organizationIds: [policy.organizationId], trustDomain: policy.trustDomain },
        clock,
        maximumLifetimeMs: policy.lifetimeMs,
      });
      runtime = Object.freeze({ verifier, emergencyControl: next.emergencyControl });
    },
    bound: () => runtime !== undefined,
  });
}
