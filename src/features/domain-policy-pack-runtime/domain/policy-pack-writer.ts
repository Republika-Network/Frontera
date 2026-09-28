/**
 * NB-008 (closed by CORE-03): who may change the policy every decision — and
 * therefore every bounded grant — is made under.
 *
 * Policy-pack writes (register a pack, register a version, activate,
 * deprecate, revoke, supersede, freeze) require a trusted writer context, the
 * same shape `KernelAuthorityProvisioningService` requires for provisioning
 * authority: `system: true` **and** an operator identity. The identity is
 * recorded on the pack, the version and every lifecycle event, so a policy in
 * force can always answer "who put this here?". There is no default writer
 * and no anonymous write.
 *
 * What this does not do (documented, SEC-TRUST-001): code running in the same
 * process can construct a writer context, exactly as it can construct a
 * Kernel-Authority system context. The guarantee is attribution and an
 * explicit, freezable write boundary — not isolation from the host itself.
 */
export interface PolicyPackWriterContext {
  readonly system: true;
  /** The operator performing the write, e.g. `operator:ops-primary`. Recorded, never interpreted. */
  readonly actorId: string;
}

const CONTROL = /[\u0000-\u001f\u007f-\u009f]/u;

/** Total: a plain object with `system === true` and a non-empty, trim-stable, bounded, control-free `actorId`. */
export function isTrustedPolicyPackWriter(value: unknown): value is PolicyPackWriterContext {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const { system, actorId } = value as { system?: unknown; actorId?: unknown };
  return system === true && typeof actorId === 'string' && actorId.length > 0 && actorId.length <= 256 && actorId === actorId.trim() && !CONTROL.test(actorId);
}
