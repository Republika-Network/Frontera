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
    // AUTH-04B: the Authority gateway reads the decision channel's error type (to map refusals to HTTP); it composes nothing.
    // AUTH-04D2S: the offline synthetic-execution verifier reads the channel's name (the constant) to require it; it composes nothing.
    // FV-P4C-2B3B: the protected FV composition root issues the bootstrap-settlement pair; it is itself reached by
    // nothing in the Host (its own structure tests), and composes no channel.
    // FV-P4C-2B3C-3: it opens exactly one store, its own bootstrap identity store, always exclusively (one owner;
    // never handed AUTH-04A's or any other already opened store).
    // FV-P4C-2B3C-2A1: the FV registration ceremony creates the FV bootstrap identity store (exclusive, FV domain,
    // pinned) and composes no service, decision channel or settlement capability.
    // FV-P4C-2B3C-2A2A: the FV first-administrator ceremony opens that registered store (exclusive, FV domain, pinned,
    // never creating it) and composes no service, decision channel or settlement capability either.
    const composers = walk('src/enterprise').filter((file) => /from '[^']*(human-decision|human-identity\/index)\.js'/.test(read(file)));
    // FV-P4C-2B3C-2A2B: the FV operator-enrolment ceremony opens that registered store the same way (through the
    // first-administrator ceremony's registered-store access) and composes no service either.
    // FV-P4C-2B3C-2A3A: the FV revocation ceremony, the same way, composing nothing.
    assert.deepEqual(composers.sort(), ['src/enterprise/authority-gateway/gateway.ts', 'src/enterprise/composition/human-authority-composition.ts', 'src/enterprise/sovereign-status-history/identity-registration-first-administrator.ts', 'src/enterprise/sovereign-status-history/identity-registration-operator.ts', 'src/enterprise/sovereign-status-history/identity-registration-revocation.ts', 'src/enterprise/sovereign-status-history/identity-registration.ts', 'src/enterprise/sovereign-status-history/protected-host-composition.ts', 'src/enterprise/synthetic-execution-verification/verification.ts']);
    const operatorCeremony = read('src/enterprise/sovereign-status-history/identity-registration-operator.ts');
    assert.match(operatorCeremony, /^import \{ FV_BOOTSTRAP_IDENTITY_STATE_KIND, type AuthenticationOptionsJSON, type HumanIdentityStore, type RegistrationOptionsJSON, type RelyingPartyConfiguration \} from '\.\.\/human-identity\/index\.js';$/m);
    const revocationCeremony = read('src/enterprise/sovereign-status-history/identity-registration-revocation.ts');
    assert.match(revocationCeremony, /^import \{ FV_BOOTSTRAP_IDENTITY_STATE_KIND, type AuthenticationOptionsJSON, type HumanIdentityStore, type RelyingPartyConfiguration \} from '\.\.\/human-identity\/index\.js';$/m);
    assert.equal(/createHumanIdentityService|identityAdministratorFor|BootstrapSettlement|createHumanDecisionChannel|approval-authority|openSqliteHumanIdentityStore/.test(revocationCeremony), false, 'the revocation ceremony composes nothing and opens no store itself');
    assert.equal(/createHumanIdentityService|identityAdministratorFor|BootstrapSettlement|createHumanDecisionChannel|approval-authority|openSqliteHumanIdentityStore/.test(operatorCeremony), false, 'the operator ceremony composes no identity service, administrator, decision channel or settlement capability, and opens no store itself');
    const firstAdministrator = read('src/enterprise/sovereign-status-history/identity-registration-first-administrator.ts');
    assert.match(firstAdministrator, /^import \{ FV_BOOTSTRAP_IDENTITY_STATE_KIND, HumanIdentityError, openSqliteHumanIdentityStore, type HumanIdentityStore, type RegistrationOptionsJSON, type RelyingPartyConfiguration \} from '\.\.\/human-identity\/index\.js';$/m);
    assert.equal(/createHumanIdentityService|identityAdministratorFor|BootstrapSettlement|createHumanDecisionChannel|approval-authority/.test(firstAdministrator), false, 'the first-administrator ceremony composes no identity service, administrator, decision channel or settlement capability');
    const registrar = read('src/enterprise/sovereign-status-history/identity-registration.ts');
    assert.match(registrar, /^import \{ FV_BOOTSTRAP_IDENTITY_STATE_KIND, HumanIdentityError, openSqliteHumanIdentityStore, type HumanIdentityStore, type SqliteHumanIdentityStoreOptions \} from '\.\.\/human-identity\/index\.js';$/m);
    assert.equal(/createHumanIdentityService|BootstrapSettlement|createHumanDecisionChannel|approval-authority/.test(registrar), false, 'the registrar composes no identity service, decision channel or settlement capability');
    const fv = read('src/enterprise/sovereign-status-history/protected-host-composition.ts');
    assert.equal(/createHumanDecisionChannel|createHumanIdentityService\(|approval-authority/.test(fv), false, 'the FV composition composes no decision channel and no general identity service');
    // CORE-07-FV-WITNESS: plus one constant, the FV identity freshness domain's name (data, not a capability).
    assert.match(fv, /^import \{ FV_BOOTSTRAP_IDENTITY_STATE_KIND, createHumanIdentityServiceWithBootstrapSettlement, isBootstrapSettlementCapabilityOf, openSqliteHumanIdentityStore, revokeBootstrapSettlementCapability \} from '\.\.\/human-identity\/index\.js';$/m, 'it takes exactly the bootstrap-settlement pair, its custody predicate, its revocation, the store opener and the FV domain constant');
    const opens = [...fv.matchAll(/openSqliteHumanIdentityStore\(identityPath, \{[\s\S]*?\n\s{4}\}\);/g)];
    assert.equal((fv.match(/openSqliteHumanIdentityStore\(/g) ?? []).length, 1, 'one open, of its own store');
    assert.equal(opens.length, 1);
    assert.match(opens[0]![0], /exclusive: \{ beforeWrite: fence\(/, 'always as the exclusive owner, every write fenced');
    assert.match(read('src/enterprise/synthetic-execution-verification/verification.ts'), /^import \{ HUMAN_PASSKEY_DECISION_CHANNEL \} from '\.\.\/approval-authority\/human-decision\.js';$/m, 'the verifier imports the channel constant alone');
    assert.equal(/createHumanDecisionChannel|openSqliteHumanIdentityStore|createHumanIdentityService|human-identity/.test(read('src/enterprise/synthetic-execution-verification/verification.ts')), false, 'the verifier composes nothing');
    assert.equal(/createHumanDecisionChannel|openSqliteHumanIdentityStore|createHumanIdentityService/.test(read('src/enterprise/authority-gateway/gateway.ts')), false, 'the gateway composes nothing');
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
    // CORE-07-FV-WITNESS: the genesis and every checkpoint use the store's identity freshness domain, which is the
    // Host's legacy 'human-identity-state' slot unless the exclusive (FV) owner names its own domain.
    assert.match(source, /boundary\.genesisStoreId\(identityDomain, /);
    assert.match(source, /const identityDomain: HumanIdentityStateKind = requestedDomain \?\? HOST_IDENTITY_STATE_KIND;/);
    assert.match(source, /const checkpointOf = \(state: HumanIdentityStateCommitment\) => humanIdentityStateCheckpoint\(state, identityDomain\);/);
    assert.equal([...source.matchAll(/humanIdentityStateCheckpoint\(/g)].length, 1, 'every checkpoint goes through the store’s one domain');
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
    // FV-P4C-2B2B: both domains consume through one function, so the property is pinned where it lives,
    // and each public authorize method must delegate to it with its own domain.
    assert.match(source.slice(source.indexOf('async authorizeDecision(raw) {'), source.indexOf('async recordDecisionOutcome(')), /await consume\(raw, 'core-05'\)/);
    assert.match(source.slice(source.indexOf('async authorizeBootstrapAuthorityDecision(raw) {'), source.indexOf('async recordBootstrapAuthoritySettlement(')), /await consume\(raw, 'bootstrap-authority'\)/);
    const authorize = source.slice(source.indexOf('async function consume<'), source.indexOf('function checkSettlement('));
    assert.ok(authorize.length > 0);
    assert.match(authorize, /row\('decision_authorized', contract\.operatorId, commitment, \{ evidence: \{ \.\.\.evidence \}, evidenceDigest, challengeDigest, counter: use\.counter, backedUp: use\.backedUp \}/);
    assert.match(authorize, /current\.decisions\.has\(commitment\)/);
    assert.match(read(STORE), /human_identity_one_authorization_per_decision/);
  });
});
