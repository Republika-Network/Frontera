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
      { ...EVIDENCE, decisionId: 'has space' },
    ]) {
      assert.equal(isWellFormedIssuanceWithheldEvidence(evidence), false, JSON.stringify(evidence));
    }
  });
});
