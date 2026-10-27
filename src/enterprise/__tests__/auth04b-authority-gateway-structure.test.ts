import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

/**
 * AUTH-04B structure — the Authority gateway is a separate boundary that the
 * public Host API cannot reach, that owns no approval logic, and that no
 * bearer, session or caller identity can turn into a verdict.
 */

const MODULE = 'src/enterprise/authority-gateway';
const GATEWAY = `${MODULE}/gateway.ts`;
const SESSION = `${MODULE}/session.ts`;
const read = (file: string): string => readFileSync(file, 'utf8');
const code = (file: string): string => read(file).replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, '');
const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === '__tests__' ? [] : walk(path);
    return /\.(ts|tsx)$/.test(path) ? [path.split('\\').join('/')] : [];
  });

describe('AUTH-04B structure — the public Host API never reaches Authority', () => {
  it('no Host route, adapter, API, administration, operator plane or console names the gateway or the human-decision port', () => {
    const surfaces = [...walk('src/enterprise/adapters'), ...walk('src/enterprise/api'), ...walk('src/enterprise/authority-administration'), ...walk('src/enterprise/operator-control'), ...walk('src/control-plane-web')];
    assert.ok(surfaces.length > 20);
    for (const file of surfaces) assert.equal(/authority-gateway|authorityGateway|humanAuthority|\/authority\/v1/.test(code(file)), false, file);
  });

  it('only the Host creates the gateway, only when its mode is enabled, and only over the in-process port', () => {
    const creators = walk('src').filter((file) => !file.startsWith(MODULE) && /createAuthorityGateway\(/.test(code(file)));
    assert.deepEqual(creators, ['src/enterprise/host/enterprise-host.ts']);
    const host = code('src/enterprise/host/enterprise-host.ts');
    assert.match(host, /gatewayConfiguration\?\.gateway\.mode === 'enabled' && enterprise\.humanAuthority !== undefined\s*\?\s*createAuthorityGateway\(\{\s*authority: enterprise\.humanAuthority,/);
    // Disabled by default: absent configuration is disabled.
    assert.match(code('src/enterprise/configuration/enterprise-configuration.ts'), /if \(env\.AOC_ENTERPRISE_AUTHORITY_GATEWAY_MODE !== 'enabled'\) return \{ mode: 'disabled' \};/);
  });

  it('imports only Node built-ins and the Host\'s own modules: no web framework, no agent-passport-web code', () => {
    for (const file of walk(MODULE)) {
      for (const [, specifier] of code(file).matchAll(/from '([^']+)'/g)) assert.ok(specifier!.startsWith('node:') || specifier!.startsWith('./') || specifier!.startsWith('../'), `${file} imports '${specifier!}'`);
      assert.equal(/agent-passport|next\/|express|fastify|operator-authenticator/.test(code(file)), false, file);
    }
  });
});

describe('AUTH-04B structure — a session is identity, never authority', () => {
  it('reads the Authorization header only to refuse it', () => {
    const source = code(GATEWAY);
    assert.equal([...source.matchAll(/headers\.authorization/g)].length, 1);
    assert.match(source, /if \(req\.headers\.authorization !== undefined\) throw new GatewayError\(400, 'AUTHORITY_BEARER_REFUSED'/);
  });

  it('never reaches a CORE-05 command or builds a command context: the only path to a verdict is the AUTH-03 channel', () => {
    for (const file of walk(MODULE)) {
      const source = code(file);
      assert.equal(/authenticated:\s*true|\.approve\(|\.reject\(|approvals\.|createHumanDecisionChannel|authorizeDecision\(/.test(source), false, file);
    }
    assert.equal([...code(GATEWAY).matchAll(/authority\.decisions\.decide\(/g)].length, 1);
  });

  it('a session holds who is signed in and nothing that authorizes', () => {
    const session = /export interface AuthoritySession \{[\s\S]*?\n\}/.exec(code(SESSION))?.[0] ?? '';
    const fields = [...session.matchAll(/readonly (\w+)\??:|^\s+(\w+):/gm)].map((match) => match[1] ?? match[2]).sort();
    assert.deepEqual(fields, ['createdAtMs', 'credentialId', 'csrfToken', 'id', 'issued', 'lastSeenAtMs', 'operatorId']);
    assert.equal(/role|permission|approv|verdict|bearer|organization/i.test(session), false);
  });

  it('decisions are bound to the session that was issued them, and the human and organization never come from the request', () => {
    const source = code(GATEWAY);
    assert.match(source, /contract\.operatorId !== session\.operatorId \|\| !session\.issued\.has\(commitment\)/);
    assert.match(source, /authority\.decisions\.begin\(\{ operatorId: session\.operatorId, approvalRequestId: id, subjectDigest, verdict \}\)/);
    assert.match(source, /readJson\(req, \['subjectDigest', 'verdict'\]\)/);
    assert.match(source, /readJson\(req, \['assertion'\]\)/);
  });

  it('cookies are __Host-, HttpOnly, Secure, SameSite=Strict, Path=/; state changes need Origin, JSON and the CSRF token', () => {
    const source = code(GATEWAY);
    assert.match(source, /AUTHORITY_SESSION_COOKIE = '__Host-frontera_authority_session'/);
    assert.match(source, /AUTHORITY_LOGIN_COOKIE = '__Host-frontera_authority_login'/);
    assert.match(source, /`\$\{name\}=\$\{value\}; Path=\/; HttpOnly; Secure; SameSite=Strict; Max-Age=/);
    assert.match(source, /if \(method === 'POST' && req\.headers\.origin !== publicOrigin\.origin\)/);
    assert.match(source, /if \(req\.headers\.host !== publicOrigin\.host\)/);
    // Every state change after sign-in presents the CSRF token.
    for (const route of ["'session/logout'", "'decision-challenges'", "'decisions' && method === 'POST'"]) {
      const at = source.indexOf(route);
      assert.ok(at > 0, route);
      assert.ok(source.slice(at, at + 400).includes('requireCsrf(req, session)'), route);
    }
    // No token reaches script storage: the session id lives only in the HttpOnly cookie.
    assert.equal(/localStorage|sessionStorage/.test(source), false);
  });
});
