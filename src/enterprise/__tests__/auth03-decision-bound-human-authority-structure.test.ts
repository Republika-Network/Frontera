import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

/**
 * AUTH-03 structure — the boundaries of decision-bound human authority,
 * asserted over the sources: one context builder, reached only after a
 * verified passkey decision; no bearer, session or caller organization path;
 * no route; the challenge lifetime capped; the identity store signed and
 * anchored like CORE-05's.
 */

const CHANNEL = 'src/enterprise/approval-authority/human-decision.ts';
const SERVICE = 'src/enterprise/human-identity/service.ts';
const STORE = 'src/enterprise/human-identity/sqlite-human-identity-store.ts';
const CHALLENGE = 'src/enterprise/human-identity/decision-challenge.ts';
const read = (file: string): string => readFileSync(file, 'utf8');
/** Source with comments removed, so prose describing a boundary never trips it. */
const code = (file: string): string => read(file).replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, '');
const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === '__tests__' ? [] : walk(path);
    return path.endsWith('.ts') ? [path.split('\\').join('/')] : [];
  });

describe('AUTH-03 structure — the passkey channel is the only way a human decision reaches CORE-05', () => {
  it('builds the trusted context in exactly one place, with the passkey channel and the bound human, and only after authorizeDecision', () => {
    const source = code(CHANNEL);
    assert.equal([...source.matchAll(/authenticated:\s*true/g)].length, 1);
    assert.match(source, /function contextFor\(operatorId: string\): ApprovalCommandContext \{\s*return Object\.freeze\(\{ authenticated: true as const, actorId: `operator:\$\{operatorId\}`, authenticatedBy: HUMAN_PASSKEY_DECISION_CHANNEL \}\);\s*\}/);
    // decide() runs every ordinary refusal, then hands over to decideAuthorized(), which consumes first and only then builds a context.
    const decide = source.slice(source.indexOf('async decide('), source.indexOf('async outcome('));
    assert.ok(decide.indexOf('await admissible(contract)') > 0 && decide.indexOf('await admissible(contract)') < decide.indexOf('decideAuthorized(assertion, contract)'), 'every ordinary refusal is decided before consumption');
    assert.equal(/contextFor\(|authorizeDecision\(/.test(decide), false);
    const authorizedBody = source.slice(source.indexOf('async function decideAuthorized('));
    const authorized = authorizedBody.indexOf('await identity.authorizeDecision(assertion)');
    const firstContext = authorizedBody.indexOf('contextFor(');
    assert.ok(authorized > 0 && firstContext > authorized, 'no context exists before the assertion is verified and the challenge consumed');
    // The bound human is the contract's — never an input of decide().
    assert.equal(/contextFor\((?!contract\.operatorId\))/.test(authorizedBody), false);
    // Reconciliation records outcomes only: it never reaches a CORE-05 command or builds a context.
    const reconcile = source.slice(source.indexOf('async reconcile()'), source.indexOf('async function decideAuthorized('));
    assert.equal(/contextFor\(|approvals\.(approve|reject)\(|authorizeDecision\(/.test(reconcile), false);
  });

  it('takes no bearer, session, cookie, API key or caller organization: the only input to decide() is the assertion', () => {
    for (const file of [CHANNEL, SERVICE, CHALLENGE]) {
      assert.equal(/[Bb]earer|\bauthorization\b|authorizationHeader|[Ss]ession|[Cc]ookie|apiKey|OperatorAuthenticator/.test(code(file)), false, file);
    }
    assert.match(code(CHANNEL), /decide\(assertion: unknown\): Promise<HumanDecisionResult>;/);
    // The organization of a challenge is the store's own.
    const begin = code(SERVICE).slice(code(SERVICE).indexOf('beginDecision(input) {'));
    assert.match(begin.slice(0, begin.indexOf('peekDecision(')), /\n\s+organizationId,\n/);
  });

  it('no route, adapter, API, administration surface or operator plane reaches the channel or the identity service (AUTH-04B adds a route)', () => {
    const surfaces = [...walk('src/enterprise/adapters'), ...walk('src/enterprise/api'), ...walk('src/enterprise/authority-administration'), ...walk('src/enterprise/operator-control')];
    assert.ok(surfaces.length > 10);
    for (const file of surfaces) assert.equal(/human-decision|human-identity|createHumanDecisionChannel|humanAuthority/.test(read(file)), false, file);
    assert.equal(/human-decision/.test(read('src/enterprise/approval-authority/index.ts')), false, 'not exported from the CORE-05 module index');
    // AUTH-04A: the one composition point is the composition module; the root and the Host only reach it.
    const composers = walk('src/enterprise').filter((file) => /from '[^']*(human-decision|human-identity\/index)\.js'/.test(read(file)));
    assert.deepEqual(composers.sort(), ['src/enterprise/composition/human-authority-composition.ts']);
  });

  it('caps the decision challenge at 120 seconds and binds the WebAuthn challenge to the commitment', () => {
    const source = code(CHALLENGE);
    assert.match(source, /HUMAN_DECISION_CHALLENGE_MAX_LIFETIME_SECONDS = 120;/);
    assert.match(code(SERVICE), /boundedSeconds\(options\.decisionChallengeTtlSeconds, HUMAN_DECISION_CHALLENGE_MAX_LIFETIME_SECONDS, HUMAN_DECISION_CHALLENGE_MAX_LIFETIME_SECONDS, 'decisionChallengeTtlSeconds'\)/);
    assert.match(code(SERVICE), /const challenge = webAuthnChallengeOf\(commitment\);/);
  });

  it('the identity store has no unsigned mode, verifies before it is returned, and anchors every append at the witness', () => {
    const source = code(STORE);
    assert.match(source, /typeof signer\.signHumanIdentityState !== 'function'/);
    assert.match(source, /HUMAN_IDENTITY_STORE_UNSUPPORTED/);
    assert.ok(source.indexOf('const opened = verifiedState();') < source.lastIndexOf('return store;'));
    assert.match(source, /boundary\.genesisStoreId\('human-identity-state'/);
    assert.equal([...source.matchAll(/session\.transition\(/g)].length, 1);
    // Every refusal precedes signing: the guard runs before signState in the append.
    const append = source.slice(source.indexOf('const appendOnce = async'), source.indexOf('let tail'));
    assert.ok(append.indexOf('guard(history)') < append.indexOf('await signState(next)'));
    assert.ok(append.indexOf('await signState(next)') < append.indexOf('session.transition('));
  });

  it('consumption and evidence are one signed append of one row, and a consumed decision is refused by the verified history', () => {
    // CORE-07 advances a store by exactly one position per transition: an append is one row.
    assert.match(code(STORE), /append\(\s*row: Omit<HumanIdentityRowContent, 'organizationId'>,/);
    const source = code(SERVICE);
    const authorize = source.slice(source.indexOf('async authorizeDecision(raw) {'), source.indexOf('async recordDecisionOutcome('));
    assert.match(authorize, /row\('decision_authorized', contract\.operatorId, commitment, \{ evidence: \{ \.\.\.evidence \}, evidenceDigest, challengeDigest, counter: use\.counter, backedUp: use\.backedUp \}/);
    assert.match(authorize, /current\.decisions\.has\(commitment\)/);
    assert.match(read(STORE), /human_identity_one_authorization_per_decision/);
  });
});
