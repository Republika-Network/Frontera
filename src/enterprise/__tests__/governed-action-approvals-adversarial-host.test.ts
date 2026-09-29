import { after, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import { Workspace, boot, createContextTable, govern, nextKey, provision, secureEnv, settle, type Reply } from './core04-host-fixture.js';
import { forge, forgedVerdict, rawHead } from './core05-approval-fixture.js';
import {
  APPROVAL,
  APPROVER_A,
  APPROVER_B,
  APPROVER_C,
  AUTHORITY_KEY_A,
  AUTHORITY_KEY_B,
  LARGE,
  approvalPolicy,
  approvals,
  approvalsFile,
  as,
  commandFor,
  describe as describeApproval,
  payablesWorld,
  provisionApprovers,
  rotationEnv,
} from './core05-host-fixture.js';

/**
 * CORE-05 — the canonical Host under attack, and across time.
 *
 * `bootEnterpriseHost()`, production profile, SQLite everywhere, signed grants
 * and signed approval state, a real loopback listener. The attacker writes the
 * approval SQLite file directly, with every unkeyed algorithm in the
 * repository and a signing key of their own — never the deployment's.
 */

const workspace = new Workspace();
after(() => workspace.cleanup());

async function host(dir: string, file: Record<string, unknown> = approvalsFile(), env: Readonly<Record<string, string>> = {}) {
  const context = createContextTable();
  context.set(payablesWorld(LARGE));
  const booted = await boot(workspace, { ...secureEnv(dir, file), ...env }, { context, policy: approvalPolicy() });
  return { ...booted, context };
}

async function provisioned(dir: string, file?: Record<string, unknown>) {
  const booted = await host(dir, file);
  await provision(booted.host);
  await provisionApprovers(booted.host);
  return booted;
}

const reasonCodes = (reply: Reply): readonly string[] => (reply.body['reasonCodes'] as readonly string[] | undefined) ?? [];

function assertWithheldByApproval(reply: Reply, code: string): void {
  assert.equal(reply.body['status'], 'withheld', reply.text);
  assert.equal(reply.body['withheldBy'], 'approval', reply.text);
  assert.ok(reasonCodes(reply).includes(code), `${code}: ${reply.text}`);
}

const approvalsFileOf = (dir: string): string => join(dir, 'approvals.sqlite');

describe('CORE-05 — a database-only writer cannot manufacture an approval on the Host', () => {
  it('stopped Host → forged quorum (recomputed digests; genuine head kept, or re-signed with an attacker key) → restart refused, nothing executes; the legitimate path then executes exactly once', async () => {
    for (const signature of ['keep', 'attacker-key'] as const) {
      const dir = workspace.dir();
      const first = await provisioned(dir);
      const withheld = await govern(first.baseUrl, settle(LARGE), nextKey('core05-forged'));
      assertWithheldByApproval(withheld, 'GOVERNED_ACTION_APPROVAL_PENDING');
      await first.host.close();

      await forge(approvalsFileOf(dir), (rows) => [...rows, forgedVerdict(rows[0]!, APPROVER_A, 'approved', new Date().toISOString()), forgedVerdict(rows[0]!, APPROVER_B, 'approved', new Date().toISOString())], signature);
      await assert.rejects(() => host(dir), /approval/i, `${signature}: the Host refuses to start on a forged approval store`);
      assert.equal(first.calls.length, 0);
    }

    // The legitimate path, for contrast: approve, restart, the same decision resumes, once.
    const dir = workspace.dir();
    const first = await provisioned(dir);
    const key = nextKey('core05-legit');
    const view = await describeApproval(first.host, await govern(first.baseUrl, settle(LARGE), key));
    await approvals(first.host).approve(as(APPROVER_A), commandFor(view));
    await approvals(first.host).approve(as(APPROVER_B), commandFor(view));
    await first.host.close();
    const second = await host(dir);
    assert.equal((await govern(second.baseUrl, settle(LARGE), key)).body['status'], 'executed');
    assert.equal((await govern(second.baseUrl, settle(LARGE), key)).body['replayed'], true);
    assert.equal(second.calls.length, 1);
  });

  it('laundering: a legitimate approval arriving over tampered rows is refused, the signed head is untouched, and the request stays withheld', async () => {
    const dir = workspace.dir();
    const booted = await provisioned(dir);
    const key = nextKey('core05-launder');
    const view = await describeApproval(booted.host, await govern(booted.baseUrl, settle(LARGE), key));
    await forge(approvalsFileOf(dir), (rows) => [...rows, forgedVerdict(rows[0]!, APPROVER_B, 'approved', new Date().toISOString())], 'head-untouched');
    const before = rawHead(approvalsFileOf(dir));
    await assert.rejects(approvals(booted.host).approve(as(APPROVER_A), commandFor(view)), { code: 'APPROVAL_STORE_CORRUPT' });
    assert.deepEqual(rawHead(approvalsFileOf(dir)), before, 'the legitimate signer never signed the attacker state');
    assertWithheldByApproval(await govern(booted.baseUrl, settle(LARGE), key), 'GOVERNED_ACTION_APPROVAL_UNAVAILABLE');
    assert.equal(booted.calls.length, 0);
  });

  it('deleting a legitimate revocation (with or without a re-signed head) is refused at restart; nothing executes', async () => {
    for (const signature of ['head-untouched', 'attacker-key'] as const) {
      const dir = workspace.dir();
      const first = await provisioned(dir);
      const key = nextKey('core05-revocation-tamper');
      const view = await describeApproval(first.host, await govern(first.baseUrl, settle(LARGE), key));
      await approvals(first.host).approve(as(APPROVER_A), commandFor(view));
      await approvals(first.host).approve(as(APPROVER_B), commandFor(view));
      await approvals(first.host).revoke(as(APPROVER_C), { ...commandFor(view), reason: 'withdrawn' });
      assertWithheldByApproval(await govern(first.baseUrl, settle(LARGE), key), 'GOVERNED_ACTION_APPROVAL_REVOKED');
      await first.host.close();
      await forge(approvalsFileOf(dir), (rows) => rows.filter((row) => row.kind !== 'revoked'), signature);
      await assert.rejects(() => host(dir), /approval/i);
      assert.equal(first.calls.length, 0);
    }
  });
});

describe('CORE-05 — key rotation on the Host (CORE-01 rule)', () => {
  it('approval state signed under the old key is re-attested unchanged under the new one, survives retiring the old key, and resumes', async () => {
    const dir = workspace.dir();
    const first = await provisioned(dir);
    const key = nextKey('core05-rotation');
    const view = await describeApproval(first.host, await govern(first.baseUrl, settle(LARGE), key));
    await approvals(first.host).approve(as(APPROVER_A), commandFor(view));
    await approvals(first.host).approve(as(APPROVER_B), commandFor(view));
    await first.host.close();
    const signedByA = rawHead(approvalsFileOf(dir));
    assert.equal((JSON.parse(signedByA.signature_json) as { keyId: string }).keyId, AUTHORITY_KEY_A.keyId);

    const rotating = await host(dir, approvalsFile(), rotationEnv(AUTHORITY_KEY_B, [AUTHORITY_KEY_A, AUTHORITY_KEY_B]));
    const reattested = rawHead(approvalsFileOf(dir));
    assert.equal(reattested.chain_digest, signedByA.chain_digest, 'the same state, never a new one');
    assert.equal((JSON.parse(reattested.signature_json) as { keyId: string }).keyId, AUTHORITY_KEY_B.keyId);
    await rotating.host.close();

    const retired = await host(dir, approvalsFile(), rotationEnv(AUTHORITY_KEY_B, [AUTHORITY_KEY_B]));
    assert.equal((await approvals(retired.host).describe(view.requestId))?.state.status, 'approved');
    assert.equal((await govern(retired.baseUrl, settle(LARGE), key)).body['status'], 'executed');
    assert.equal(retired.calls.length, 1);
  });
});

describe('CORE-05 — expiry on the Host (a mocked clock; no sleeps)', () => {
  /** Runs `body` with `Date` mocked from the real instant; `advance(seconds)` moves it. */
  async function withClock(body: (advance: (seconds: number) => void) => Promise<void>): Promise<void> {
    const start = Date.now();
    mock.timers.enable({ apis: ['Date'], now: start });
    try {
      await body((seconds) => mock.timers.setTime(start + seconds * 1000));
    } finally {
      mock.timers.reset();
    }
  }

  it('the request expires before approval → the approval is refused and nothing resumes', async () => {
    await withClock(async (advance) => {
      const booted = await provisioned(workspace.dir());
      const key = nextKey('core05-request-expiry');
      const view = await describeApproval(booted.host, await govern(booted.baseUrl, settle(LARGE), key));
      advance(APPROVAL.requestTtlSeconds + 1);
      await assert.rejects(approvals(booted.host).approve(as(APPROVER_A), commandFor(view)), { code: 'APPROVAL_REQUEST_CLOSED' });
      assertWithheldByApproval(await govern(booted.baseUrl, settle(LARGE), key), 'GOVERNED_ACTION_APPROVAL_REQUEST_EXPIRED');
      assert.equal(booted.calls.length, 0);
    });
  });

  it('the proof is usable strictly before it lapses and not at its expiry', async () => {
    await withClock(async (advance) => {
      const file = approvalsFile({ ...APPROVAL, approvalValiditySeconds: 60 });
      const booted = await provisioned(workspace.dir(), file);
      const early = nextKey('core05-proof-early');
      const late = nextKey('core05-proof-late');
      for (const key of [early, late]) {
        const view = await describeApproval(booted.host, await govern(booted.baseUrl, settle(LARGE), key));
        await approvals(booted.host).approve(as(APPROVER_A), commandFor(view));
        await approvals(booted.host).approve(as(APPROVER_B), commandFor(view));
      }
      advance(59);
      assert.equal((await govern(booted.baseUrl, settle(LARGE), early)).body['status'], 'executed');
      advance(60);
      assertWithheldByApproval(await govern(booted.baseUrl, settle(LARGE), late), 'GOVERNED_ACTION_APPROVAL_EXPIRED');
      assert.equal(booted.calls.length, 1);
    });
  });

  it('the decision’s context validity dominates: an approval completed after it lapsed releases no grant', async () => {
    await withClock(async (advance) => {
      const booted = await provisioned(workspace.dir());
      const key = nextKey('core05-context-expiry');
      const withheld = await govern(booted.baseUrl, settle(LARGE), key);
      const view = await describeApproval(booted.host, withheld);
      const validUntil = view.subject.contextValidUntil;
      assert.ok(validUntil !== undefined);
      advance((Date.parse(validUntil) - Date.now()) / 1000 + 1);
      await approvals(booted.host).approve(as(APPROVER_A), commandFor(view));
      await approvals(booted.host).approve(as(APPROVER_B), commandFor(view));
      const resumed = await govern(booted.baseUrl, settle(LARGE), key);
      assert.equal(resumed.body['status'], 'withheld', resumed.text);
      assert.notEqual(resumed.body['withheldBy'], 'approval', 'the approval itself is complete; the decision is what expired');
      assert.equal(booted.calls.length, 0);
    });
  });
});
