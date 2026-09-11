import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { ObligationConfigurationError, ObligationDischargeSourceRegistry, validateObligationDischargeSource, type ObligationDischargeSource } from '../index.js';

const APPROVAL: ObligationDischargeSource = { id: 'obl.src.approval.finance', kind: 'approval_runtime', name: 'Finance approvals', verificationClass: 'independent' };
const HOST: ObligationDischargeSource = { id: 'obl.src.host', kind: 'internal_store', name: 'Host-recorded state', verificationClass: 'self_reported' };

describe('Discharge sources — the trust boundary is configuration, never a report', () => {
  it('accepts a well-formed independent approval source', () => {
    assert.deepEqual(validateObligationDischargeSource(APPROVAL), []);
  });

  it('refuses a `request` source that claims to be independent — the requester is never independent of itself', () => {
    const violations = validateObligationDischargeSource({ id: 'obl.src.request', kind: 'request', name: 'The requester', verificationClass: 'independent' });
    assert.equal(violations.length > 0, true);
    assert.match(violations.join(' '), /may only be 'self_reported'/);
  });

  it('accepts a `request` source that is honest about being self-reported', () => {
    assert.deepEqual(validateObligationDischargeSource({ id: 'obl.src.request', kind: 'request', name: 'The requester', verificationClass: 'self_reported' }), []);
  });

  it('refuses `independent` for a store — a host recording what it was told is not independent of whoever told it', () => {
    const violations = validateObligationDischargeSource({ ...HOST, verificationClass: 'independent' });
    assert.match(violations.join(' '), /requires kind 'approval_runtime', 'provider_adapter' or 'signed_attestation'/);
  });

  it('refuses an unnamed, unidentified or unknown-kind source', () => {
    assert.equal(validateObligationDischargeSource({ ...APPROVAL, id: '  ' }).length > 0, true);
    assert.equal(validateObligationDischargeSource({ ...APPROVAL, name: '' }).length > 0, true);
    assert.equal(validateObligationDischargeSource({ ...APPROVAL, kind: 'telepathy' as ObligationDischargeSource['kind'] }).length > 0, true);
  });
});

describe('ObligationDischargeSourceRegistry — configuration errors are wiring-time failures', () => {
  it('rejects a whole invalid configuration at construction, reporting every bad row at once', () => {
    assert.throws(
      () => new ObligationDischargeSourceRegistry([{ id: 'obl.src.request', kind: 'request', name: 'requester', verificationClass: 'independent' }, { ...APPROVAL, name: '' }]),
      (error: unknown) => {
        assert.ok(error instanceof ObligationConfigurationError);
        assert.equal(error.violations.length >= 2, true, 'an operator fixes one configuration, not five in sequence');
        return true;
      },
    );
  });

  it('rejects a duplicate source id', () => {
    assert.throws(() => new ObligationDischargeSourceRegistry([APPROVAL, APPROVAL]), ObligationConfigurationError);
  });

  it('resolves a registered source and refuses to guess about an unregistered one', () => {
    const registry = new ObligationDischargeSourceRegistry([APPROVAL, HOST]);
    assert.equal(registry.get(APPROVAL.id)?.verificationClass, 'independent');
    assert.equal(registry.get('obl.src.nobody'), undefined, 'an unknown origin is not a weak origin, it is no origin at all');
  });

  it('lists sources in a stable order, so a configuration snapshot is comparable across processes', () => {
    const left = new ObligationDischargeSourceRegistry([APPROVAL, HOST]).list().map((source) => source.id);
    const right = new ObligationDischargeSourceRegistry([HOST, APPROVAL]).list().map((source) => source.id);
    assert.deepEqual(left, right);
  });
});
