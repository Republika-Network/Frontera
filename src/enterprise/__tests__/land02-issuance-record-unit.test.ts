import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  isWellFormedIssuanceWithheldEvidence,
  issuanceWithheldDigest,
  issuanceWithheldUri,
  issuanceWithheldVersion,
  parseIssuanceWithheldRow,
  type IssuanceWithheldEvidence,
} from '../governed-action/issuance-record.js';
import { MONETARY_ASSET_ID_PATTERN } from '../../features/monetary-runtime/index.js';

/** LAND-02 — the durable issuance-withheld row grammar: exact round trip, every field bound by the digest. */

const EVIDENCE: IssuanceWithheldEvidence = {
  requestId: 'aoc.gar:0123456789abcdef0123456789abcdef',
  decisionId: 'enforcement-decision-1',
  withheldBy: 'authority-binding',
  reasonCodes: ['FINANCIAL_AUTHORITY_CEILING_EXCEEDED'],
  requested: { value: '125000', unit: 'USD' },
  ceiling: { value: '100000', unit: 'USD' },
};
const rowOf = (evidence: IssuanceWithheldEvidence) => ({ externalId: evidence.requestId, externalVersion: issuanceWithheldVersion(evidence), uri: issuanceWithheldUri(evidence), digest: issuanceWithheldDigest(evidence) });

describe('LAND-02 — issuance record grammar', () => {
  it('round-trips exactly, with and without the optional amounts', () => {
    assert.deepEqual(parseIssuanceWithheldRow(rowOf(EVIDENCE)), EVIDENCE);
    const { requested: _r, ceiling: _c, ...bare } = EVIDENCE;
    void _r;
    void _c;
    const binding = { ...bare, reasonCodes: ['AUTHORITY_BINDING_UNRESOLVED'] };
    assert.deepEqual(parseIssuanceWithheldRow(rowOf(binding)), binding);
    assert.equal(rowOf(EVIDENCE).uri, 'urn:aoc:issuance-record:v1;decision=enforcement-decision-1;requested=USD:125000;ceiling=USD:100000');
    assert.equal(rowOf(EVIDENCE).externalVersion, 'withheld:authority-binding:FINANCIAL_AUTHORITY_CEILING_EXCEEDED');
  });

  it('every field is bound: changing any one without the digest is refused', () => {
    const row = rowOf(EVIDENCE);
    for (const tampered of [
      { ...row, externalId: 'aoc.gar:ffffffffffffffffffffffffffffffff' },
      { ...row, externalVersion: 'withheld:authority-binding:FINANCIAL_AUTHORITY_UNRESOLVED' },
      { ...row, externalVersion: 'withheld:grant:FINANCIAL_AUTHORITY_CEILING_EXCEEDED' },
      { ...row, uri: row.uri.replace('USD:100000', 'USD:200000') },
      { ...row, uri: row.uri.replace('USD:125000', 'USD:99999') },
      { ...row, uri: row.uri.replace('enforcement-decision-1', 'enforcement-decision-2') },
      { ...row, uri: row.uri.replace(';ceiling=USD:100000', '') },
      { ...row, digest: 'sha256:' + '0'.repeat(64) },
    ]) {
      assert.equal(parseIssuanceWithheldRow(tampered), undefined, JSON.stringify(tampered));
    }
  });

  it('refuses malformed rows and evidence', () => {
    const row = rowOf(EVIDENCE);
    for (const malformed of [
      { ...row, uri: 'urn:aoc:other:v1;decision=x' },
      { ...row, uri: `${row.uri};extra=1` },
      { ...row, uri: row.uri.replace('decision=', 'decision=;decision=') },
      { ...row, externalVersion: 'granted:authority-binding:X' },
      { ...row, uri: row.uri.replace('USD:125000', 'USD:1.250e5') },
    ]) {
      assert.equal(parseIssuanceWithheldRow(malformed), undefined, JSON.stringify(malformed));
    }
    for (const evidence of [
      { ...EVIDENCE, reasonCodes: [] },
      { ...EVIDENCE, reasonCodes: ['lowercase'] },
      { ...EVIDENCE, withheldBy: 'Authority Binding' },
      { ...EVIDENCE, requested: { value: '125000.0', unit: 'USD' } },
      { ...EVIDENCE, ceiling: { value: '100000', unit: 'US;D' } },
      { ...EVIDENCE, decisionId: '' },
    ]) {
      assert.equal(isWellFormedIssuanceWithheldEvidence(evidence), false, JSON.stringify(evidence));
    }
  });

  it('the issuance layer and its codes are exactly the orchestrator’s: a known layer, its own closed vocabulary, no duplicates', () => {
    for (const evidence of [
      { ...EVIDENCE, withheldBy: 'fabricated', reasonCodes: ['FAKE_REASON'] },
      { ...EVIDENCE, withheldBy: 'authority-binding', reasonCodes: ['FAKE_REASON'] },
      { ...EVIDENCE, withheldBy: 'emergency-control', reasonCodes: ['FINANCIAL_AUTHORITY_CEILING_EXCEEDED'] },
      { ...EVIDENCE, reasonCodes: ['FINANCIAL_AUTHORITY_CEILING_EXCEEDED', 'FINANCIAL_AUTHORITY_CEILING_EXCEEDED'] },
      { ...EVIDENCE, withheldBy: 'grant', reasonCodes: ['GRANT_OBLIGATIONS_UNSATISFIED'] },
      { ...EVIDENCE, withheldBy: 'obligations', reasonCodes: ['GRANT_SCOPE_BROADENING'] },
      { ...EVIDENCE, withheldBy: 'exercise', reasonCodes: ['FINANCIAL_AUTHORITY_CEILING_EXCEEDED'] },
      { ...EVIDENCE, withheldBy: 'constructor', reasonCodes: ['FINANCIAL_AUTHORITY_CEILING_EXCEEDED'] },
    ]) {
      assert.equal(isWellFormedIssuanceWithheldEvidence(evidence), false, JSON.stringify(evidence));
      assert.equal(parseIssuanceWithheldRow(rowOf(evidence)), undefined, JSON.stringify(evidence));
    }
    for (const [withheldBy, reasonCodes] of [
      ['emergency-control', ['EMERGENCY_CONTROL_ACTIVE']],
      ['emergency-control', ['EMERGENCY_CONTROL_UNAVAILABLE']],
      ['authority-binding', ['AUTHORITY_BINDING_UNRESOLVED']],
      ['authority-binding', ['PARAMETER_AUTHORITY_EXCEEDED']],
      ['grant', ['GRANT_SCOPE_BROADENING']],
      ['obligations', ['GRANT_OBLIGATIONS_UNSATISFIED']],
    ] as const) {
      const { ceiling: _c, ...rest } = EVIDENCE;
      void _c;
      const evidence = { ...rest, withheldBy, reasonCodes: [...reasonCodes] };
      assert.deepEqual(parseIssuanceWithheldRow(rowOf(evidence)), evidence, withheldBy);
    }
  });

  it('every canonical monetary asset id (P9) is a unit, up to its maximum length — never a narrower grammar', () => {
    const longest = `A${'b'.repeat(127)}`;
    assert.equal(MONETARY_ASSET_ID_PATTERN.test(longest), true, 'the canonical maximum');
    for (const unit of ['token_USD', 'ns:USD/issuer-1', 'a.b-c_d:E/F', longest]) {
      const evidence = { ...EVIDENCE, requested: { value: '125000', unit }, ceiling: { value: '100000', unit } };
      assert.equal(MONETARY_ASSET_ID_PATTERN.test(unit), true, unit);
      assert.equal(isWellFormedIssuanceWithheldEvidence(evidence), true, unit);
      assert.deepEqual(parseIssuanceWithheldRow(rowOf(evidence)), evidence, unit);
      assert.equal(rowOf(evidence).uri, `urn:aoc:issuance-record:v1;decision=enforcement-decision-1;requested=${unit}:125000;ceiling=${unit}:100000`, 'a canonical asset id needs no escaping');
    }
    for (const unit of [`${longest}c`, '_USD', 'US D', 'US;D', 'US=D', 'US%D', '']) {
      assert.equal(MONETARY_ASSET_ID_PATTERN.test(unit), false, unit);
      assert.equal(isWellFormedIssuanceWithheldEvidence({ ...EVIDENCE, ceiling: { value: '100000', unit } }), false, unit);
    }
  });

  it('a decision id is opaque: every non-empty string the Kernel minted is recorded, percent-encoded, and round-trips exactly', () => {
    for (const decisionId of ['tenant/decision-1', 'has space', 'semi;colon=eq', '100%', 'a%2Fb', 'ünïcødé-✓', '😀', 'x'.repeat(500), 'kernel-allow:7f3a.b_c']) {
      const evidence = { ...EVIDENCE, decisionId };
      assert.equal(isWellFormedIssuanceWithheldEvidence(evidence), true, decisionId);
      const row = rowOf(evidence);
      assert.match(row.uri, /^urn:aoc:issuance-record:v1;decision=(?:[A-Za-z0-9._:-]|%[0-9A-F]{2})+;requested=/, decisionId);
      assert.deepEqual(parseIssuanceWithheldRow(row), evidence, decisionId);
      assert.equal(issuanceWithheldDigest(evidence), issuanceWithheldDigest({ ...evidence }), 'deterministic');
    }
    assert.equal(rowOf({ ...EVIDENCE, decisionId: 'tenant/decision 1;x=%' }).uri.split(';')[1], 'decision=tenant%2Fdecision%201%3Bx%3D%25');
    // A lone surrogate cannot survive UTF-8: refused, never written as something else.
    assert.equal(isWellFormedIssuanceWithheldEvidence({ ...EVIDENCE, decisionId: 'bad\uD800' }), false);
  });

  it('a malformed or non-canonical escape fails safely', () => {
    const row = rowOf({ ...EVIDENCE, decisionId: 'tenant/decision-1' });
    for (const uri of [
      row.uri.replace('%2F', '%2f'), // lower-case hex is not the canonical form
      row.uri.replace('%2F', '%2'), // truncated escape
      row.uri.replace('%2F', '%ZZ'), // not hex
      row.uri.replace('%2F', '/'), // unescaped reserved character
      row.uri.replace('tenant%2F', '%74enant%2F'), // an unreserved character escaped
      row.uri.replace('%2F', '%C3'), // invalid UTF-8
      row.uri.replace('%2F', '%3B'), // decodes to a different id
      row.uri.replace('decision=tenant%2Fdecision-1', 'decision='), // empty
    ]) {
      assert.equal(parseIssuanceWithheldRow({ ...row, uri }), undefined, uri);
    }
  });

  it('rows written before the hardening — identity encoding on [A-Za-z0-9._:-], same digest — still parse exactly', () => {
    const legacy = {
      externalId: 'aoc.gar:0123456789abcdef0123456789abcdef',
      externalVersion: 'withheld:authority-binding:FINANCIAL_AUTHORITY_CEILING_EXCEEDED',
      uri: 'urn:aoc:issuance-record:v1;decision=kernel-allow:7f3a.b;requested=ns:USD/issuer-1:125000;ceiling=ns:USD/issuer-1:100000',
      // Computed independently of this module: sha256 over the v1 canonical JSON array.
      digest: 'sha256:83d756873767af2df059e063d05bd1ed7bd1834609f69836587924d72f962b5a',
    };
    const evidence = {
      requestId: legacy.externalId,
      decisionId: 'kernel-allow:7f3a.b',
      withheldBy: 'authority-binding',
      reasonCodes: ['FINANCIAL_AUTHORITY_CEILING_EXCEEDED'],
      requested: { value: '125000', unit: 'ns:USD/issuer-1' },
      ceiling: { value: '100000', unit: 'ns:USD/issuer-1' },
    };
    assert.deepEqual(parseIssuanceWithheldRow(legacy), evidence);
    assert.deepEqual(rowOf(evidence), legacy, 'the hardened writer emits the very same row');
    assert.equal(parseIssuanceWithheldRow({ ...legacy, uri: legacy.uri.replace('7f3a', '7f3b') }), undefined, 'tampering still fails');
  });
});
