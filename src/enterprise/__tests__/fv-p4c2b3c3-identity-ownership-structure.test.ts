import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// FV-P4C-2B3C-3 — one owner of each AUTH-03 identity store. The FV executor's composition opens its own
// bootstrap identity store, exclusively, and accepts no store already opened; AUTH-04A's Host composition
// never opens a store exclusively nor reaches FV; every write of an exclusively owned store is fenced; the
// executor's management channel carries no identity operation.

const ROOT = join(__dirname, '..', '..', '..', '..');
const read = (...path: string[]) => readFileSync(join(ROOT, ...path), 'utf8');
const STORE = read('src', 'enterprise', 'human-identity', 'sqlite-human-identity-store.ts');
const FV = read('src', 'enterprise', 'sovereign-status-history', 'protected-host-composition.ts');

describe('FV-P4C-2B3C-3 structure — one owner per AUTH-03 identity store', () => {
  it('the FV composition opens exactly its own store, as its exclusive owner, and refuses one handed in', () => {
    assert.equal((FV.match(/openSqliteHumanIdentityStore\(/g) ?? []).length, 1);
    assert.match(FV, /openSqliteHumanIdentityStore\(identityPath, \{[\s\S]*?exclusive: \{ beforeWrite: fence\(\(\) => checkProtectedFile\(identityPath\) === undefined && confirmExclusivelyHeld\(\[identityPath\]\) && authority\(\)\), closer: exclusiveCloser, storeId: identity\.storeId \},/, 'exclusive, fenced, guarded, pinned inside the store');
    assert.match(FV, /if \('store' in identityOption\) invalid\(/, 'an already opened store is never accepted');
    assert.match(FV, /'enrollment' in rawFreshness\)\) invalid\(/, 'never a CORE-07 enrollment from the composition');
    // PR #255 review, finding 1: the caller's object is read once into a frozen snapshot, and the store receives a
    // freshness option rebuilt from the boundary alone, never the caller's object.
    assert.match(FV, /const identity = Object\.freeze\(\{/);
    assert.match(FV, /Object\.freeze\(\{ boundary: rawFreshness\.boundary, stateKind: FV_BOOTSTRAP_IDENTITY_STATE_KIND \}\)/);
    // CORE-07-FV-WITNESS: the FV domain is named explicitly by the configuration, and the store receives the constant.
    assert.match(FV, /rawFreshness !== undefined && rawFreshnessDomain !== FV_BOOTSTRAP_IDENTITY_STATE_KIND\) invalid\(/);
    assert.equal(/create:\s*true|create: identity|enrollment:/.test(FV.slice(FV.indexOf('openSqliteHumanIdentityStore(identityPath'), FV.indexOf('openSqliteHumanIdentityStore(identityPath') + 900)), false, 'the executor never creates or enrolls its store');
    assert.match(FV, /\.\.\.\(freshnessOption !== undefined \? \{ freshness: freshnessOption \} : \{\}\)/);
    assert.equal(/freshness: identity\.freshness\b|freshness: rawFreshness\b/.test(FV), false, 'the caller’s freshness object never reaches the store');
    assert.match(FV, /identityStore\.storeId !== identity\.storeId/, 'the store is pinned by id');
    assert.equal(/identity\.store\b/.test(FV), false, 'no handed-in store is used anywhere');
  });

  it('AUTH-04A’s Host composition keeps its own store and never takes the exclusive FV mode', () => {
    const host = read('src', 'enterprise', 'composition', 'human-authority-composition.ts');
    assert.match(host, /openSqliteHumanIdentityStore\(/, 'AUTH-04A opens its own store, as before');
    assert.equal(/exclusive:|sovereign-status-history|bootstrapSettlement|BootstrapSettlement/.test(host), false);
  });

  it('every write of an exclusively owned store is fenced first; its connection closes only through the owner’s closer', () => {
    // Genesis, head re-signing, every chained append (before the witness prepares, and again inside commitLocal),
    // ceremony and decision challenges.
    assert.equal((STORE.match(/\n\s+fence\(\);/g) ?? []).length, 6);
    assert.match(STORE, /fence\(\);\n\s+if \(session === undefined\) commitLocal\(\);/, 'fenced before the witness is asked to prepare');
    assert.match(STORE, /exclusive\?\.storeId !== undefined && opened\.state\.storeId !== exclusive\.storeId/, 'the pin is checked before any open-time write or witness contact');
    assert.match(STORE, /const commitLocal = \(\): void =>\s+db\.transaction\(\(\) => \{[\s\S]{0,400}?\n\s+fence\(\);\n/, 'the append fence is the first statement inside the write transaction');
    assert.match(STORE, /closeConnection = exclusive\.closer\(file, db\);/);
    assert.match(STORE, /exclusive !== undefined && freshness\?\.enrollment !== undefined\) \{\n\s+throw new HumanIdentityError\('HUMAN_IDENTITY_CONFIGURATION_INVALID'/, 'an exclusive owner never enrolls a witness slot');
    // db.close() only in the plain closer and for a connection that never took the lock.
    assert.equal((STORE.match(/db\.close\(\)/g) ?? []).length, 2);
  });

  it('the executor’s management channel stays informational: no identity, decision or settlement operation crosses it', () => {
    const protocol = read('src', 'enterprise', 'sovereign-status-history', 'dedicated-executor-protocol.ts');
    assert.match(protocol, /readonly type: 'status' \| 'stop'; readonly id: string/);
    for (const name of ['dedicated-executor.ts', 'dedicated-executor-protocol.ts', 'dedicated-executor-supervisor.ts']) {
      assert.equal(/beginBootstrapDecision|recordBootstrapAuthoritySettlement|settlementCapability|openSqliteHumanIdentityStore|human-identity/.test(read('src', 'enterprise', 'sovereign-status-history', name)), false, name);
    }
  });
});
