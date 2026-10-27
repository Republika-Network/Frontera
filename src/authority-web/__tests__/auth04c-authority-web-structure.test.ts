import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { ALLOWED_ATTRIBUTES, ALLOWED_TAGS } from '../vnode.js';

/**
 * AUTH-04C structure — what the Authority web client can and cannot do, read
 * from its sources (comments stripped, so documentation that names a
 * forbidden thing never trips a rule).
 */

const SOURCE = 'src/authority-web';
const files = readdirSync(SOURCE)
  .filter((name) => name.endsWith('.ts'))
  .map((name) => join(SOURCE, name).split('\\').join('/'));
const code = (file: string): string => readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, '');

describe('AUTH-04C structure — the client holds no authority and no secret', () => {
  it('is the module the tests expect', () => {
    assert.deepEqual(files.map((file) => file.slice(SOURCE.length + 1)).sort(), ['api.ts', 'contracts.ts', 'controller.ts', 'dom.ts', 'format.ts', 'main.ts', 'passkeys.ts', 'view.ts', 'vnode.ts']);
  });

  it('imports only its own files: no framework, no Host module, no agent-passport-web code', () => {
    for (const file of files) {
      for (const [, specifier] of code(file).matchAll(/(?:from|import\()\s*'([^']+)'/g)) assert.ok(specifier!.startsWith('./'), `${file} imports '${specifier!}'`);
    }
  });

  it('never touches browser storage, cookies, HTML sinks or dynamic code', () => {
    for (const file of files) {
      assert.equal(/localStorage|sessionStorage|indexedDB|document\.cookie|innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function|setAttribute\(\s*['"]on|dangerouslySetInnerHTML/.test(code(file)), false, file);
    }
  });

  it('carries no bearer, no Authorization header, no key material and no operator credential', () => {
    for (const file of files) assert.equal(/[Bb]earer|authorization|[Aa]pi[_-]?[Kk]ey|PRIVATE KEY|signingKey|AOC_ENTERPRISE|FRONTERA_CTRL/.test(code(file)), false, file);
  });

  it('talks only to its own origin, only under /authority/v1, never with a token in a URL, never cross-site', () => {
    const api = code(`${SOURCE}/api.ts`);
    assert.match(api, /export const API_PREFIX = '\/authority\/v1';/);
    assert.match(api, /credentials: 'same-origin'/);
    assert.match(api, /redirect: 'error'/);
    assert.equal(/https?:\/\/|mode: 'cors'|credentials: 'include'|\?[a-z]+=/.test(api), false);
    for (const file of files) assert.equal(/https?:\/\//.test(code(file)), false, `${file} names no absolute URL`);
  });

  it('never computes or overrides the subject digest, the operator or the organization it sends', () => {
    const controller = code(`${SOURCE}/controller.ts`);
    assert.match(controller, /api\.decisionChallenge\(detail\.approvalRequestId, detail\.subjectDigest, screen\.verdict, session\.csrfToken\)/);
    const api = code(`${SOURCE}/api.ts`);
    assert.match(api, /\{ subjectDigest, verdict \}/);
    assert.equal(/operatorId|organizationId/.test(api), false, 'the client never sends who acts or for which organization');
    // The device-side digest check only ever blocks a decision; it never feeds what is sent.
    assert.equal(/digest\(.*\)[^;]*decisionChallenge/.test(controller), false);
  });

  it('submits an assertion at most once, and only after an explicit confirmation', () => {
    const controller = code(`${SOURCE}/controller.ts`);
    assert.equal([...controller.matchAll(/api\.submitDecision\(/g)].length, 1);
    const confirm = controller.slice(controller.indexOf('confirmDecision: () =>'), controller.indexOf('checkStatus: () =>'));
    assert.match(confirm, /if \(screen\.name !== 'confirm'/);
    assert.ok(confirm.indexOf('api.decisionChallenge(') < confirm.indexOf('passkeys.get(') && confirm.indexOf('passkeys.get(') < confirm.indexOf('api.submitDecision('));
    const check = controller.slice(controller.indexOf('checkStatus: () =>'), controller.indexOf('backToInbox: () =>'));
    assert.equal(/submitDecision|passkeys\.get/.test(check), false, 'checking a status never resubmits');
    assert.match(controller, /if \(current\.busy\) return;/);
  });

  it('renders through a closed vocabulary: no raw HTML, no handler or style attributes, no links or embeds', () => {
    assert.equal(ALLOWED_TAGS.some((tag) => ['script', 'style', 'iframe', 'img', 'a', 'object', 'embed', 'svg', 'math', 'template', 'link', 'meta', 'base'].includes(tag)), false);
    assert.equal(ALLOWED_ATTRIBUTES.some((name) => name.startsWith('on') || ['style', 'href', 'src', 'srcdoc', 'action', 'formaction', 'innerHTML'].includes(name)), false);
    const dom = code(`${SOURCE}/dom.ts`);
    assert.match(dom, /document\.createTextNode\(vnode\.text\)/);
    assert.match(dom, /for \(const name of ALLOWED_ATTRIBUTES\)/);
  });

  it('the static shell and headers are strict, and the build is wired into CI as a private artifact only', () => {
    const headers = JSON.parse(readFileSync('apps/authority-web/security-headers.json', 'utf8')) as Record<string, string>;
    assert.equal(headers['content-security-policy'], "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
    assert.equal(headers['x-frame-options'], 'DENY');
    assert.equal(Object.keys(headers).some((name) => name.startsWith('access-control-')), false, 'no CORS');
    const ci = readFileSync('.github/workflows/ci.yml', 'utf8');
    const job = ci.slice(ci.indexOf('  authority-web-preview:'));
    assert.ok(job.length > 0);
    assert.match(job, /- run: npm run build:authority-web/);
    assert.match(job, /actions\/upload-artifact@v4/);
    assert.equal(/vercel|wrangler|netlify|aws s3|gcloud|kubectl|docker push|scp |rsync |gh-pages|pages deploy/i.test(job), false, 'no deployment step');
    const tsconfig = readFileSync('apps/authority-web/tsconfig.json', 'utf8');
    assert.match(tsconfig, /"include": \["\.\.\/\.\.\/src\/authority-web\/\*\.ts"\]/, 'tests are never shipped to the browser');
  });
});
