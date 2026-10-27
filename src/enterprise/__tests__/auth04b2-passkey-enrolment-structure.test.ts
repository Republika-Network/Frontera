import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { LEGACY_ADMINISTRATOR_ROLE, OPERATOR_ROLES, operatorMay } from '../operator-control/roles.js';

/**
 * AUTH-04B2 structure — enrolment is identity only, administered on the
 * private operator plane by an organization administrator, redeemed on the
 * Authority gateway by the named human, and nothing on either side turns a
 * bearer, an invitation or a passkey into authority.
 */

const SERVICE = 'src/enterprise/operator-control/passkey-enrolment.ts';
const GATEWAY = 'src/enterprise/authority-gateway/gateway.ts';
const COMPOSITION = 'src/enterprise/composition/human-authority-composition.ts';
const ADAPTER = 'src/enterprise/adapters/node-http-adapter.ts';
const code = (file: string): string => readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, '');

describe('AUTH-04B2 structure — the administrator side', () => {
  it('only an organization administrator holds passkey-enrolment.administer; no other role and never the legacy administrator', () => {
    for (const role of [...OPERATOR_ROLES, LEGACY_ADMINISTRATOR_ROLE]) assert.equal(operatorMay(role, 'passkey-enrolment.administer'), role === 'organization-administrator', role);
  });

  it('every operation authorizes the administrator first, with that permission, and hands the port the authenticated principal — never the header', () => {
    const source = code(SERVICE);
    assert.match(source, /authenticator\.authorize\(header, PASSKEY_ENROLMENT_PERMISSION\)/);
    assert.equal([...source.matchAll(/authorize\(header\)/g)].length, 4, 'all four operations authorize');
    for (const call of source.matchAll(/port\.(\w+)\(([^)]*)\)/g)) assert.equal(/header|authorization/i.test(call[2] ?? ''), false, `port.${call[1] ?? ''} receives no header`);
    assert.equal(/logger|console\./.test(source), false, 'the service logs nothing (no token can reach a log from here)');
    assert.equal(/human-identity|human-decision|humanAuthority|approval-authority|authority-gateway|kernel-authority|execution-capability/.test(source), false, 'the operator plane reaches only its port');
  });

  it('the port is identity administration only: no decision, grant, role, standing or capability operation exists', () => {
    const source = code(SERVICE);
    const port = /export interface PasskeyEnrolmentAdministrationPort \{[\s\S]*?\n\}/.exec(source)?.[0] ?? '';
    assert.deepEqual([...port.matchAll(/^\s+(\w+)\(/gm)].map((match) => match[1]).sort(), ['describeHuman', 'issueInvitation', 'registerHuman', 'revokeInvitation']);
    const composition = code(COMPOSITION);
    const block = composition.slice(composition.indexOf('const enrolmentAdministration'), composition.indexOf('return { store, port, reconciled, enrolmentAdministration }'));
    assert.ok(block.length > 0);
    assert.equal(/decisions\.|\.decide\(|beginDecision|authorizeDecision|approvals\.|operatorMay|grant|standing/.test(block), false, 'enrolment administration composes nothing but AUTH-02 identity calls');
    assert.match(block, /identity\.authorizeEnrolment\(adminOf\(principal\), operatorId\)/);
  });

  it('the Host adapter mounts exactly four enrolment routes, only when the service is composed, and serves token responses no-store', () => {
    const adapter = code(ADAPTER);
    const matcher = /function matchPasskeyEnrolmentRoute[\s\S]*?\n\}/.exec(adapter)?.[0] ?? '';
    assert.deepEqual([...matcher.matchAll(/kind: '([a-z-]+)'/g)].map((match) => match[1]).sort(), ['describe-human', 'issue-invitation', 'register-human', 'revoke-invitation']);
    assert.match(adapter, /const enrolmentRoute = operatorPasskeyEnrolment === undefined \? undefined : matchPasskeyEnrolmentRoute\(method, url\.pathname\);/);
    assert.match(adapter, /writeJson\(res, 200, body, \{ 'cache-control': 'no-store', pragma: 'no-cache' \}\)/);
  });
});

describe('AUTH-04B2 structure — the gateway side', () => {
  it('the invitation travels only in a JSON body: the gateway reads no query string and no invitation from a URL', () => {
    const source = code(GATEWAY);
    assert.equal(/searchParams|\.search\b|query/.test(source), false);
    assert.match(source, /readJson\(req, \['invitation'\]\)/);
    assert.match(source, /readJson\(req, \['invitation', 'credential'\]\)/);
  });

  it('enrolment opens no session and reaches only AUTH-02 registration', () => {
    const source = code(GATEWAY);
    const branch = source.slice(source.indexOf("segments.join('/') === 'enrolment/options' || segments.join('/') === 'enrolment'"), source.indexOf("if (segments.join('/') === 'session/login/options' && method === 'POST') {"));
    assert.ok(branch.length > 0);
    assert.equal(/sessions\.create\(|AUTHORITY_SESSION_COOKIE|decisions\.|inbox\./.test(branch), false);
    assert.match(branch, /authority\.identity\.beginRegistration\(invitation\)/);
    assert.match(branch, /authority\.identity\.finishRegistration\(invitation, body\['credential'\]\)/);
    // Bound to the browser and to the invitation that opened the ceremony; the cookie is __Host-.
    assert.match(branch, /ceremony\.invitationDigest !== sha256\(invitation\) \|\| clientDataChallengeOf\(body\['credential'\]\) !== ceremony\.challenge/);
    assert.match(source, /AUTHORITY_ENROLMENT_COOKIE = '__Host-frontera_authority_enrolment'/);
  });

  it('every invitation failure is one indistinguishable answer', () => {
    const source = code(GATEWAY);
    assert.match(source, /error\.code === 'HUMAN_IDENTITY_ENROLMENT_INVALID' \|\| error\.code === 'HUMAN_IDENTITY_PRINCIPAL_REVOKED' \|\| error\.code === 'HUMAN_IDENTITY_UNKNOWN_PRINCIPAL'\) throw invitationRefused\(\)/);
  });
});
