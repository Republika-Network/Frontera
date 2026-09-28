import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createFinancialActionClassifier, createMonetaryAssetRegistry } from '../../features/monetary-runtime/index.js';
import { computeGovernanceRequestPayloadDigest } from '../governance-store/projection.js';
import { GovernanceProfileConfigurationError, createGovernanceProfileRegistry } from '../governance-profile/index.js';
import { buildGovernedActionKernelRequest } from '../governed-action/kernel-request.js';
import { validateGovernedActionIntent, type ClassifiedGovernedActionIntent, type GovernedActionMonetaryTrust } from '../governed-action/index.js';
import { APPROVED_DESTINATION, CUSTOMER_DATA, DEPLOY_ACTION, EXPORT_ACTION, PAYMENT_ACTION, PRODUCTION_ENVIRONMENT, READ_ACTION, SEMANTIC_CONFIGURATION, TREASURY } from './governed-action-semantics-fixture.js';

/**
 * CORE-03 — the envelope boundary. `GovernedActionIntent` is still the one
 * runtime envelope; this measures what CORE-03 added to it: trusted semantic
 * classification, typed declared parameters, and a profile expectation that
 * can pin but never choose. Every answer is `validateGovernedActionIntent`'s,
 * the function the orchestrator calls on every request.
 */

const MONETARY: GovernedActionMonetaryTrust = {
  assets: createMonetaryAssetRegistry([{ assetId: 'USD', scale: 2 }]),
  actionClassifier: createFinancialActionClassifier({ financialActions: [PAYMENT_ACTION] }),
};
const GOVERNANCE = createGovernanceProfileRegistry(SEMANTIC_CONFIGURATION);

function validate(raw: unknown) {
  return validateGovernedActionIntent(raw, MONETARY, GOVERNANCE);
}

function accepted(raw: unknown): ClassifiedGovernedActionIntent {
  const result = validate(raw);
  assert.equal(result.valid, true, JSON.stringify(result));
  if (!result.valid) throw new Error('unreachable');
  return result.intent;
}

function refused(raw: unknown, pattern: RegExp): void {
  const result = validate(raw);
  assert.equal(result.valid, false, `expected refusal: ${JSON.stringify(raw)}`);
  if (result.valid) return;
  assert.ok(result.violations.some((violation) => pattern.test(violation)), `${String(pattern)} not in ${JSON.stringify(result.violations)}`);
}

const read = (parameters: unknown, extra: Record<string, unknown> = {}) => ({ action: READ_ACTION, resource: CUSTOMER_DATA, idempotencyKey: 'k-read', parameters, ...extra });

describe('CORE-03 — the envelope is preserved; classification is trusted configuration', () => {
  it('a profiled intent carries its classes, profile reference and typed, sorted, declared parameters', () => {
    const intent = accepted({ action: EXPORT_ACTION, resource: CUSTOMER_DATA, idempotencyKey: 'k-export', parameters: { recordCount: 50, destination: APPROVED_DESTINATION } });
    assert.equal(intent.actionClass, 'non-financial', 'P9 classification is untouched beside the semantic one');
    assert.equal(intent.semantics?.actionClass, 'export');
    assert.equal(intent.semantics?.resourceClass, 'customer_dataset');
    assert.equal(intent.semantics?.governanceProfile.id, 'customer-data-export');
    assert.equal(intent.semantics?.governanceProfile.version, 2);
    assert.deepEqual(intent.parameters, [
      { dimension: 'destination', bound: 'exact', type: 'token', value: APPROVED_DESTINATION },
      { dimension: 'recordCount', bound: 'maximum', type: 'integer', value: 50 },
    ]);
    assert.equal(Object.isFrozen(intent.parameters), true);
  });

  it('the Kernel request carries semantics and typed parameters as a list — ids are values, never keys', () => {
    const intent = accepted(read({ recordCount: 7 }));
    const request = buildGovernedActionKernelRequest({ scope: { organizationId: 'org-a', principalId: 'p', actorId: 'agent-a' }, intent, trustDomainId: 'td', requestId: 'r', requestedAt: '2026-01-01T00:00:00.000Z' });
    assert.equal(request.action.type, READ_ACTION, 'action stays the concrete identifier');
    assert.equal(request.action.resourceScope, CUSTOMER_DATA, 'resource stays the concrete reference');
    assert.deepEqual(request.action.semantics?.actionClass, 'read');
    assert.deepEqual(request.action.governedParameters, [{ dimension: 'recordCount', bound: 'maximum', type: 'integer', value: 7 }]);
    assert.equal(request.action.amount, undefined, 'no money axis on a non-financial action');
  });

  it('two requests differing only in a typed parameter never share a Governance Store payload digest (§76)', () => {
    const scope = { organizationId: 'org-a', principalId: 'p', actorId: 'agent-a' };
    const digestOf = (recordCount: number) =>
      computeGovernanceRequestPayloadDigest(buildGovernedActionKernelRequest({ scope, intent: accepted(read({ recordCount })), trustDomainId: 'td', requestId: 'r', requestedAt: '2026-01-01T00:00:00.000Z' }));
    assert.notEqual(digestOf(7), digestOf(8));
    assert.equal(digestOf(7), digestOf(7));
  });

  it('legacy intents are classified exactly as before: no semantics, no parameters', () => {
    const payment = accepted({ action: PAYMENT_ACTION, resource: TREASURY, amount: { value: '75.50', currency: 'USD' }, counterparty: 'vendor-v123', idempotencyKey: 'k-pay' });
    assert.equal(payment.actionClass, 'financial');
    assert.deepEqual(payment.amount, { value: '75.5', unit: 'USD' }, 'P9 canonical decimal text, exactly as before CORE-03');
    assert.equal(payment.semantics, undefined);
    assert.equal(payment.parameters, undefined);
    assert.equal('semantics' in payment, false, 'absent, not undefined-valued: the request digest is unchanged');
    const noRegistry = validateGovernedActionIntent({ action: READ_ACTION, resource: CUSTOMER_DATA, idempotencyKey: 'k' }, MONETARY);
    assert.equal(noRegistry.valid, true, 'without a registry nothing is classified');
  });
});

describe('CORE-03 §43 / §71 — parameters are declared, typed and unambiguous', () => {
  it('refuses a dimension the governing profile does not declare', () => {
    refused(read({ recordCount: 1, destination: 'x' }), /does not declare: destination/);
    refused(read({ recordCount: 1, blastRadius: 3 }), /does not declare: blastRadius/);
  });

  it('refuses a differently-cased shadow of a declared dimension — exactly one canonical value', () => {
    refused(read({ recordCount: 10, RecordCount: 1000000 }), /does not declare: RecordCount/);
    refused(read({ RecordCount: 10 }), /does not declare: RecordCount/);
  });

  it('refuses a declared dimension smuggled through asserted context, in any case (§71)', () => {
    refused(read({ recordCount: 10 }, { assertedContext: { recordCount: 1000000 } }), /identity or authority keys: recordCount/);
    refused(read({ recordCount: 10 }, { assertedContext: { RECORDCOUNT: 1000000 } }), /RECORDCOUNT/);
    refused(read({ recordCount: 10 }, { assertedContext: { governanceProfile: 'customer-data-export' } }), /governanceProfile/);
    refused(read({ recordCount: 10 }, { assertedContext: { resourceClass: 'public' } }), /resourceClass/);
  });

  it('refuses a metadata bag, a profile object, class fields and raw semantics at the top level', () => {
    refused(read({ recordCount: 10 }, { metadata: { recordCount: 1000000 } }), /undeclared properties: metadata/);
    refused(read({ recordCount: 10 }, { profile: { profileId: 'customer-data-export' } }), /undeclared properties: profile/);
    refused(read({ recordCount: 10 }, { actionClass: 'read', resourceClass: 'public', semantics: {} }), /undeclared properties: actionClass, resourceClass, semantics/);
    refused(read({ recordCount: 10 }, { governedParameters: [] }), /undeclared properties: governedParameters/);
  });

  it('missing is distinguishable from null, zero, empty and false (§46)', () => {
    refused(read(undefined), /parameters\.recordCount is required/);
    refused(read({}), /parameters\.recordCount is required/);
    refused(read({ recordCount: null }), /recordCount must be a integer \(PARAMETER_VALUE_WRONG_TYPE\)/);
    assert.deepEqual(accepted(read({ recordCount: 0 })).parameters, [{ dimension: 'recordCount', bound: 'maximum', type: 'integer', value: 0 }], 'zero is a value, not an absence');
    refused({ action: DEPLOY_ACTION, resource: PRODUCTION_ENVIRONMENT, idempotencyKey: 'k', parameters: { releaseVersion: '' , rollbackAvailable: false } }, /releaseVersion must be a token/);
    assert.equal(
      accepted({ action: DEPLOY_ACTION, resource: PRODUCTION_ENVIRONMENT, idempotencyKey: 'k', parameters: { releaseVersion: '1.4.2', rollbackAvailable: false } }).parameters?.find((parameter) => parameter.dimension === 'rollbackAvailable')?.value,
      false,
      'false is a value, not an absence',
    );
  });

  it('refuses coercion: "100" is not 100, 1 is not true, 100.5 is not an integer (§47)', () => {
    refused(read({ recordCount: '100' }), /PARAMETER_VALUE_WRONG_TYPE/);
    refused(read({ recordCount: 100.5 }), /PARAMETER_INTEGER_NOT_SAFE/);
    refused(read({ recordCount: 2 ** 53 }), /PARAMETER_INTEGER_NOT_SAFE/);
    refused({ action: DEPLOY_ACTION, resource: PRODUCTION_ENVIRONMENT, idempotencyKey: 'k', parameters: { releaseVersion: '1.4.2', rollbackAvailable: 1 } }, /rollbackAvailable must be a boolean/);
  });

  it('refuses parameters on an action no profile governs, and a non-object parameters value', () => {
    refused({ action: PAYMENT_ACTION, resource: TREASURY, amount: { value: '1', currency: 'USD' }, idempotencyKey: 'k', parameters: { recordCount: 1 } }, /may carry no parameters/);
    refused(read([['recordCount', 1]]), /plain object keyed by declared dimension id/);
    refused(read(JSON.parse('{"recordCount":1,"__proto__":{"recordCount":999}}')), /does not declare: __proto__/);
  });

  it('refuses a half-classified or ungoverned action/resource pair instead of evaluating it as unclassified (§45)', () => {
    refused({ action: READ_ACTION, resource: TREASURY, idempotencyKey: 'k' }, /GOVERNANCE_RESOURCE_CLASS_UNKNOWN/);
    refused({ action: 'draft-email', resource: CUSTOMER_DATA, idempotencyKey: 'k' }, /GOVERNANCE_ACTION_CLASS_UNKNOWN/);
    refused({ action: DEPLOY_ACTION, resource: CUSTOMER_DATA, idempotencyKey: 'k', parameters: { releaseVersion: '1', rollbackAvailable: true } }, /GOVERNANCE_PROFILE_UNKNOWN/);
  });
});

describe('CORE-03 §19 / §72 — a profile can be pinned, never chosen', () => {
  it('a matching expectation is accepted and changes nothing about the resolved profile', () => {
    const intent = accepted(read({ recordCount: 1 }, { expectedGovernanceProfile: { id: 'customer-data-read', version: 1 } }));
    assert.equal(intent.semantics?.governanceProfile.id, 'customer-data-read');
  });

  it('profile substitution is refused: naming the (more permissive) export profile on a read does not select it', () => {
    refused(read({ recordCount: 1 }, { expectedGovernanceProfile: { id: 'customer-data-export', version: 2 } }), /pinned, never chosen/);
  });

  it('a version mismatch — downgrade or upgrade — is refused', () => {
    refused({ action: EXPORT_ACTION, resource: CUSTOMER_DATA, idempotencyKey: 'k', parameters: { recordCount: 1, destination: APPROVED_DESTINATION }, expectedGovernanceProfile: { id: 'customer-data-export', version: 1 } }, /pinned, never chosen/);
    refused({ action: EXPORT_ACTION, resource: CUSTOMER_DATA, idempotencyKey: 'k', parameters: { recordCount: 1, destination: APPROVED_DESTINATION }, expectedGovernanceProfile: { id: 'customer-data-export', version: 3 } }, /pinned, never chosen/);
  });

  it('a request-defined profile body is refused: an expectation is exactly { id, version }', () => {
    refused(read({ recordCount: 1 }, { expectedGovernanceProfile: { id: 'customer-data-read', version: 1, parameters: [] } }), /exactly \{ id, version \}/);
    refused(read({ recordCount: 1 }, { expectedGovernanceProfile: { id: 'customer-data-read', version: '1' } }), /exactly \{ id, version \}/);
    refused(read({ recordCount: 1 }, { expectedGovernanceProfile: 'customer-data-read' }), /exactly \{ id, version \}/);
  });

  it('an expectation on an unprofiled action cannot be met', () => {
    refused({ action: PAYMENT_ACTION, resource: TREASURY, amount: { value: '1', currency: 'USD' }, idempotencyKey: 'k', expectedGovernanceProfile: { id: 'customer-data-read', version: 1 } }, /no expectedGovernanceProfile can be met/);
  });
});

describe('CORE-03 — the profile hint is `expectedGovernanceProfile`; nothing on the envelope binds governance', () => {
  it('the retired name `governanceProfile` is not an envelope field at all', () => {
    refused(read({ recordCount: 1 }, { governanceProfile: { id: 'customer-data-export', version: 2 } }), /undeclared properties: governanceProfile/);
  });

  it('neither name can be asserted as context', () => {
    refused(read({ recordCount: 1 }, { assertedContext: { governanceProfile: 'customer-data-export' } }), /identity or authority keys: governanceProfile/);
    refused(read({ recordCount: 1 }, { assertedContext: { expectedGovernanceProfile: 'customer-data-export' } }), /identity or authority keys: expectedGovernanceProfile/);
  });

  it('with or without a hint, the effective profile is the resolver’s, byte for byte', () => {
    const hinted = accepted(read({ recordCount: 1 }, { expectedGovernanceProfile: { id: 'customer-data-read', version: 1 } }));
    const unhinted = accepted(read({ recordCount: 1 }));
    const resolved = GOVERNANCE.resolve(READ_ACTION, CUSTOMER_DATA);
    assert.equal(resolved.kind, 'resolved');
    if (resolved.kind !== 'resolved') return;
    assert.deepEqual(hinted.semantics, resolved.semantics);
    assert.deepEqual(unhinted.semantics, resolved.semantics);
  });
});

describe('CORE-03 — the reserved-key registry: built-in keys stay, trusted configuration extends, callers cannot', () => {
  const EXTENDED = createGovernanceProfileRegistry({ ...SEMANTIC_CONFIGURATION, reservedContextKeys: ['mppChallenge', 'paymentCredential'] });
  const withExtensions = (raw: unknown) => validateGovernedActionIntent(raw, MONETARY, EXTENDED);
  const payment = (assertedContext: Record<string, unknown>) => ({ action: PAYMENT_ACTION, resource: TREASURY, amount: { value: '1', currency: 'USD' }, idempotencyKey: 'k', assertedContext });

  it('a registered extension is reserved, in any case; without the registration it is ordinary context', () => {
    for (const key of ['mppChallenge', 'MPPChallenge', 'paymentcredential']) {
      const result = withExtensions(payment({ [key]: 'x' }));
      assert.equal(result.valid, false, key);
    }
    assert.equal(validate(payment({ mppChallenge: 'x' })).valid, true, 'unregistered: plain asserted context');
  });

  it('the built-in reserved keys remain reserved beside the extensions', () => {
    assert.equal(withExtensions(payment({ paymentCeiling: '999' })).valid, false);
    assert.equal(withExtensions(payment({ actorId: 'someone' })).valid, false);
  });

  it('a caller cannot register, name or remove a reserved key', () => {
    refused({ ...payment({}), reservedContextKeys: ['anything'] }, /undeclared properties: reservedContextKeys/);
    assert.deepEqual(EXTENDED.reservedContextKeys, ['mppChallenge', 'paymentCredential']);
    assert.equal(Object.isFrozen(EXTENDED.reservedContextKeys), true);
  });

  it('configuration is validated: malformed or case-duplicated extension keys refuse composition', () => {
    for (const reservedContextKeys of [['a b'], [''], ['1abc'], ['x'.repeat(65)], ['mppChallenge', 'MPPCHALLENGE'], 'mppChallenge']) {
      assert.throws(() => createGovernanceProfileRegistry({ reservedContextKeys } as never), GovernanceProfileConfigurationError, JSON.stringify(reservedContextKeys));
    }
  });
});
