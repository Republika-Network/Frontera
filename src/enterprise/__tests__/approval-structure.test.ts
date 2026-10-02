import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { KernelGrantCapability, deriveGrantSourceAuthorization, withVerifiedHumanApproval } from '../../kernel/orchestration/grant-adapter.js';
import type { KernelEvaluationRequest, KernelEvaluationResult } from '../../kernel/index.js';

/**
 * CORE-05 — structural invariants of the canonical governed approval path,
 * read from the TypeScript sources (and, for the grant, from the Kernel's own
 * functions).
 */

function codeOf(file: string): string {
  // Strip comments so documentation that names a forbidden thing (to forbid it) is not mistaken for a dependency on it.
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function walk(dir: string): readonly string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === 'tests' || name === '__tests__') continue;
      out.push(...walk(full));
    } else if (full.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

const APPROVAL_SOURCES = walk('src/enterprise/approval-authority');

describe('CORE-05 structure — the approval path is CORE, independent of UI and INTEL', () => {
  it('has real sources to measure', () => {
    assert.ok(APPROVAL_SOURCES.length >= 9, `found ${APPROVAL_SOURCES.length}`);
  });

  it('names no model, provider, prompt, inference, UI, notification or control-plane dependency, and performs no network I/O', () => {
    const forbidden = [
      /\banthropic\b/i,
      /\bopenai\b/i,
      /\bllm\b/i,
      /\binference\b/i,
      /\bembedding/i,
      /\bprompt\b/i,
      /\bintel\b/i,
      /\bintelligence\b/i,
      /from ['"][^'"]*(langchain|@anthropic-ai|openai|react|aoc-control-plane|notification|email|slack)/i,
      /from ['"]node:(http|https|net)['"]/,
      /\bfetch\s*\(/,
    ];
    for (const file of APPROVAL_SOURCES) {
      const code = codeOf(file);
      for (const pattern of forbidden) assert.equal(pattern.test(code), false, `${file} (${String(pattern)})`);
    }
  });
});

describe('CORE-05 structure — one authority world', () => {
  it('the approval module never constructs or imports an Authority Graph (or an ApprovalRuntime world) of its own', () => {
    for (const file of APPROVAL_SOURCES) {
      const code = codeOf(file);
      assert.equal(/authority-graph|createAuthorityGraphRuntime|new ApprovalRuntime|createApprovalRuntime/.test(code), false, `${file} must take approver standing from the composed Kernel-Authority world`);
    }
  });

  it('composition answers approver standing from the Kernel providers’ world (the durable Kernel-Authority projection), through approval-runtime’s own integrations', () => {
    const root = codeOf('src/enterprise/composition/composition-root.ts');
    const block = /const approvalAuthority: ApprovalAuthority \| undefined =[\s\S]*?\}\)\(\);/.exec(root)?.[0] ?? '';
    assert.ok(block.length > 0, 'the approval authority composition block exists');
    assert.match(block, /createActorRegistryRecognitionIntegration\(kernelProviders\.recognitionRuntime\.actorRegistry\)/);
    assert.match(block, /createApprovalAuthorityGraphIntegration\(kernelProviders\.authorityRuntime\)/);
    assert.match(block, /createKernelAuthorityLineageRevalidator\(/);
    assert.match(block, /resolveEffectiveProfile,/);
    assert.equal(/createAuthorityGraphRuntime|new ApprovalRuntime/.test(block), false);
  });

  it('the requirement is selected by the trusted effective-profile resolver, never by the request’s own semantics', () => {
    const service = codeOf('src/enterprise/approval-authority/service.ts');
    assert.match(service, /selectEffectiveProfile\(resolveEffectiveProfile, input\.request\)/);
    for (const file of APPROVAL_SOURCES) assert.equal(/\.semantics\b/.test(codeOf(file)), false, `${file} must not read request.action.semantics`);
  });
});

describe('CORE-05 structure — no writable bypass, no caller-named proof, no route', () => {
  it('the Enterprise handle exposes the command port only — no store, no append, no proof or state writer', () => {
    const root = codeOf('src/enterprise/composition/composition-root.ts');
    const surface = /approvals: Object\.freeze<ApprovalCommandPort>\(\{[\s\S]*?\}\),/.exec(root)?.[0] ?? '';
    assert.ok(surface.length > 0);
    const keys = [...surface.matchAll(/^\s+(\w+): \(/gm)].map((match) => match[1]).sort();
    // CTRL-04 added one read (`list`: every canonical request, every derived state) — still no store, append or writer.
    assert.deepEqual(keys, ['approve', 'describe', 'escalate', 'list', 'pending', 'reject', 'requestChanges', 'revoke']);
    // The orchestrator receives assess only.
    assert.match(root, /approvals: \{ assess: \(input\) => approvalAuthority\.assess\(input\) \}/);
  });

  it('the command vocabulary has no actor, state, quorum or proof field', () => {
    const contracts = codeOf('src/enterprise/approval-authority/contracts.ts');
    const command = /export interface ApprovalCommand \{[\s\S]*?\r?\n\}/.exec(contracts)?.[0] ?? '';
    assert.ok(command.length > 0);
    for (const field of ['approverId', 'actorId', 'state', 'status', 'quorum', 'proof', 'approvalDigest', 'minimumApprovals', 'requirement']) {
      assert.equal(new RegExp(`readonly ${field}\\??:`).test(command), false, field);
    }
  });

  it('no HTTP adapter, administration (CTRL-01) or customer-route source reaches the approval module', () => {
    const surfaces = [...walk('src/enterprise/adapters'), ...walk('src/enterprise/authority-administration'), ...walk('src/enterprise/api')];
    assert.ok(surfaces.length > 5);
    for (const file of surfaces) assert.equal(/approval-authority|\.approvals\b|approvalAuthority/.test(codeOf(file)), false, file);
  });

  it('the governed path never forwards a caller approval reference to the Kernel', () => {
    for (const file of walk('src/enterprise/governed-action')) {
      assert.equal(/approvalProofId|approvalRequestId|approvalDecisionId/.test(codeOf(file)), false, `${file} must not carry a caller approval reference`);
    }
  });
});

describe('CORE-05 structure — an approval changes exactly one gate of the grant source, and only for approval_required', () => {
  const request = {
    requestId: 'r',
    actor: { id: 'agent', trustDomainId: 'td' },
    action: { type: 'settle', resourceScope: 'ledger', amount: '10.00', currency: 'USD' },
    organization: { id: 'org' },
    requestedAt: '2026-09-28T12:00:00.000Z',
  } as unknown as KernelEvaluationRequest;
  const decisionOf = (status: KernelEvaluationResult['status'], reasonCodes: readonly string[]): KernelEvaluationResult =>
    ({
      decisionId: 'd',
      status,
      reasonCodes,
      evaluatedAt: '2026-09-28T12:00:00.000Z',
      // A decision with admitted context: its validity ceiling must survive the approval.
      context: { digest: `sha256:${'d'.repeat(64)}`, validUntil: '2026-09-28T12:10:00.000Z' },
      grants: { validityCeilings: [] },
    }) as unknown as KernelEvaluationResult;
  const DIGEST = `sha256:${'c'.repeat(64)}`;

  it('approval_required awaiting approval: only authorizationPermitsExercise and approvalDigest change; scope, parameters, validity and every other field are untouched', () => {
    const decision = decisionOf('approval_required', ['APPROVAL_REQUIRED']);
    const projected = deriveGrantSourceAuthorization(new KernelGrantCapability({ declaration: {} }), request, decision);
    const resumed = withVerifiedHumanApproval(projected, decision, DIGEST);
    const { authorizationPermitsExercise, approvalDigest, ...rest } = resumed;
    const { authorizationPermitsExercise: before, ...projectedRest } = projected;
    assert.equal(before, false);
    assert.equal(authorizationPermitsExercise, true);
    assert.equal(approvalDigest, DIGEST);
    assert.ok(projected.validityCeilings.length > 0, 'the fixture carries a validity ceiling to preserve');
    assert.deepEqual(rest, projectedRest);
  });

  it('denied, indeterminate, allowed and evidence/handshake-blocked decisions are returned unchanged — an approval never becomes authority there', () => {
    for (const [status, codes] of [
      ['denied', ['APPROVAL_REQUIRED']],
      ['indeterminate', ['APPROVAL_REQUIRED']],
      ['allowed', []],
      ['approval_required', ['APPROVAL_REQUIRED', 'EVIDENCE_REQUIRED']],
      ['approval_required', ['APPROVAL_PENDING', 'RECOGNITION_HANDSHAKE_INVALID']],
      ['approval_required', ['DOMAIN_POLICY_DENIED']],
    ] as const) {
      const decision = decisionOf(status, codes);
      const projected = deriveGrantSourceAuthorization(new KernelGrantCapability({ declaration: {} }), request, decision);
      assert.deepEqual(withVerifiedHumanApproval(projected, decision, DIGEST), projected, `${status} ${codes.join(',')}`);
    }
  });
});
