import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';

import { APPROVAL_COMMANDS, OPERATOR_APPROVAL_CHANNEL, approvalCommandContextFor, validateApprovalCommandBody } from '../operator-control/approval-workflow.js';
import { LEGACY_ADMINISTRATOR_ROLE, OPERATOR_ROLES, operatorMay, permissionsOf } from '../operator-control/roles.js';

/**
 * CTRL-04 — structural boundaries of the human approval workflow.
 *
 * Measured over the production sources (comments removed, so prose never
 * satisfies or violates a rule). Every detector is first shown to match a real
 * violation and not a mention of one.
 */

function codeOf(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .map((line) => line.replace(/^\s*\/\/.*$/, '').replace(/\s\/\/\s.*$/, ''))
    .join('\n');
}

const SERVICE = 'src/enterprise/operator-control/approval-workflow.ts';
const ROUTER = 'src/enterprise/adapters/node-http-adapter.ts';
const ROOT = 'src/enterprise/composition/composition-root.ts';
const WEB_APPROVAL = ['src/control-plane-web/views/pages-approvals.tsx', 'src/control-plane-web/approval-forms.ts', 'src/control-plane-web/app.tsx', 'src/control-plane-web/host-client.ts', 'src/control-plane-web/wire.ts'];
const CTRL04 = [SERVICE, ...WEB_APPROVAL];
const importsOf = (file: string): readonly string[] => [...codeOf(file).matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)].map((match) => match[1] ?? '');

describe('CTRL-04 structure — one approval engine: CORE-05', () => {
  const STORE = /sqlite-approval-store|in-memory-approval-store|better-sqlite3|createSqliteApprovalStore|createInMemoryApprovalStore|\.append\(|ApprovalStore\b/;
  const ENGINE = /approvalProofDigest|evaluateApproval|createAdmissionApprovalPolicyChain|QuorumPolicy|SegregationOfDutiesPolicy|ApprovalEvidencePolicy|\badmit\(|policyContextFor|approvalRowDigest|signApprovalState/;

  it('the detectors match real uses', () => {
    assert.equal(STORE.test("import { createSqliteApprovalStore } from '../approval-authority/sqlite-approval-store.js'"), true);
    assert.equal(STORE.test('await store.append(row)'), true);
    assert.equal(ENGINE.test('const digest = approvalProofDigest({ ... })'), true);
    assert.equal(ENGINE.test('new QuorumPolicy()'), true);
  });

  it('no CTRL-04 module touches an approval store, appends a row or re-implements an approval policy, quorum or proof', () => {
    for (const file of CTRL04) {
      const code = codeOf(file);
      assert.equal(STORE.test(code), false, `${file} reaches an approval store`);
      assert.equal(ENGINE.test(code), false, `${file} re-implements CORE-05`);
    }
  });

  it('the Host service is handed the CORE-05 command port only — list and the five commands — never a store', () => {
    const service = codeOf(SERVICE);
    assert.match(service, /readonly approvals: Pick<ApprovalCommandPort, 'list' \| 'approve' \| 'reject' \| 'requestChanges' \| 'escalate' \| 'revoke'>;/);
    for (const specifier of importsOf(SERVICE)) assert.ok(['../api/enterprise-http-errors.js', '../approval-authority/index.js', '../telemetry/enterprise-logger.js', './operator-authenticator.js', './roles.js'].includes(specifier), `${SERVICE} imports '${specifier}'`);
    const root = codeOf(ROOT);
    const block = /createOperatorApprovalService\(\{[\s\S]*?logger,\s*\}\)/.exec(root)?.[0] ?? '';
    assert.ok(block.length > 0);
    const keys = [...(/approvals: \{([\s\S]*?)\},/.exec(block)?.[1] ?? '').matchAll(/^\s+(\w+): \(/gm)].map((match) => match[1]).sort();
    assert.deepEqual(keys, ['approve', 'escalate', 'list', 'reject', 'requestChanges', 'revoke']);
    assert.equal(/approvalStore|store:|\.assess\(/.test(block), false, 'no store and no assess reach the operator approval service');
    // Every request it serves is re-proven to belong to the served organization (one organization per Host).
    assert.match(service, /if \(views\.some\(\(view\) => view\.subject\.organizationId !== organizationId\)\) throw integrityFailed\('APPROVAL_ORGANIZATION_MISMATCH'\);/);
  });

  it('the web control plane computes no quorum, eligibility, SOD or completion — it renders the Host’s derived values', () => {
    const LOCAL_AUTHORITY = /countedApprovers\.length\s*[><=]=?\s*\w*\.?minimumApprovals|minimumApprovals\s*[><=]=?|satisfied\s*:\s*(true|[^,}]*>=)|status\s*:\s*'approved'|\.status\s*=\s*'|requestedByActorId|segregation/i;
    assert.equal(LOCAL_AUTHORITY.test('const done = countedApprovers.length >= quorum.minimumApprovals'), true);
    assert.equal(LOCAL_AUTHORITY.test("approval.status = 'approved'"), true);
    for (const file of WEB_APPROVAL) assert.equal(LOCAL_AUTHORITY.test(codeOf(file)), false, file);
  });
});

describe('CTRL-04 structure — the identity bridge: who acts comes only from the authenticated operator', () => {
  it('outside CORE-05 itself, no production source anywhere builds an approval command context except the bridge', () => {
    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((name) => {
        const full = `${dir}/${name}`;
        if (statSync(full).isDirectory()) return name === '__tests__' || name === 'tests' || name === 'fixtures' ? [] : walk(full);
        return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [full] : [];
      });
    const constructing = walk('src').filter((file) => !file.startsWith('src/enterprise/approval-authority/') && /authenticated:\s*true/.test(codeOf(file)));
    assert.deepEqual(constructing, [SERVICE]);
  });

  it('exactly one ApprovalCommandContext is built on the operator plane, from the principal alone', () => {
    const CONTEXT = /authenticated:\s*true/;
    assert.equal(CONTEXT.test('{ authenticated: true, actorId }'), true);
    for (const file of [ROUTER, 'src/enterprise/operator-control/service.ts', 'src/enterprise/authority-administration/service.ts', ...WEB_APPROVAL]) assert.equal(CONTEXT.test(codeOf(file)), false, file);
    const service = codeOf(SERVICE);
    assert.equal([...service.matchAll(/authenticated:\s*true/g)].length, 1);
    assert.match(
      service,
      /export function approvalCommandContextFor\(principal: EnterpriseOperatorPrincipal\): ApprovalCommandContext \{\s*return Object\.freeze\(\{ authenticated: true as const, actorId: principal\.actorRef, authenticatedBy: OPERATOR_APPROVAL_CHANNEL \}\);\s*\}/,
    );
    // The context handed to CORE-05 is built from the principal the authenticator returned for this request's permission.
    assert.match(service, /const principal = authorize\(authorizationHeader, spec\.permission\);/);
    assert.match(service, /const context = approvalCommandContextFor\(principal\);/);
    assert.match(service, /after = await approvals\[spec\.port\]\(context, command\);/);
  });

  it('the bridge maps an operator to exactly its canonical actorRef and the operator-plane channel', () => {
    const context = approvalCommandContextFor({ plane: 'operator', operatorId: 'approver-a', organizationId: 'org', role: 'approver', credentialClass: 'operator', actorRef: 'operator:approver-a' });
    assert.deepEqual(context, { authenticated: true, actorId: 'operator:approver-a', authenticatedBy: OPERATOR_APPROVAL_CHANNEL });
    assert.ok(Object.isFrozen(context));
  });

  it('the command body is closed: it can name the reviewed subject, evidence and a note — never an actor, channel, organization, role, state, quorum or proof', () => {
    assert.deepEqual(validateApprovalCommandBody({ subjectDigest: `sha256:${'a'.repeat(64)}` }), { subjectDigest: `sha256:${'a'.repeat(64)}` });
    for (const field of ['actorId', 'authenticatedBy', 'authenticated', 'operatorId', 'organizationId', 'role', 'permissions', 'approverId', 'approvalDigest', 'proof', 'state', 'quorum', 'countedApprovers', 'system', 'signature', 'privateKey', 'approvalRequestId']) {
      assert.throws(() => validateApprovalCommandBody({ subjectDigest: `sha256:${'a'.repeat(64)}`, [field]: 'x' }), { httpStatus: 400 }, field);
    }
    const service = codeOf(SERVICE);
    assert.match(service, /const COMMAND_FIELDS = \['subjectDigest', 'evidence', 'reason'\] as const;/);
    // The approval request id comes from the path, never from the body.
    assert.match(service, /const command: ApprovalCommand = \{\s*approvalRequestId,\s*subjectDigest: body\.subjectDigest,/);
  });

  it('the router reads no body before the service authorizes, and builds no approval context itself', () => {
    const router = codeOf(ROUTER);
    const block = /const approvalRoute = [\s\S]*?const route = matchAdministrationRoute/.exec(router)?.[0] ?? '';
    assert.ok(block.length > 0);
    assert.equal(/readRequestBody\(|JSON\.parse|actorId|authenticatedBy/.test(block), false);
    assert.match(block, /operatorApprovals\.command\(auth, approvalRoute\.verb, approvalRoute\.approvalRequestId, administrationBodyReader\(req\)\)/);
    assert.equal(/approval-authority|approvalAuthority|\.approvals\b/.test(router), false, 'the router never reaches the CORE-05 module directly');
  });
});

describe('CTRL-04 structure — operator permissions: two separate checks, restriction never implies expansion', () => {
  it('approval permissions per role are exactly the documented matrix', () => {
    const matrix = Object.fromEntries([...OPERATOR_ROLES, LEGACY_ADMINISTRATOR_ROLE].map((role) => [role, permissionsOf(role).filter((permission) => permission.startsWith('approval.'))]));
    assert.deepEqual(matrix, {
      observer: ['approval.read'],
      responder: ['approval.read', 'approval.restrict'],
      provisioner: [],
      'profile-steward': [],
      approver: ['approval.read', 'approval.approve', 'approval.restrict'],
      'organization-administrator': ['approval.read', 'approval.approve', 'approval.restrict'],
      'legacy-administrator': [],
    });
  });

  it('the approver role holds no authority, credential, profile or emergency permission; no restrict-only role holds approve', () => {
    assert.deepEqual(permissionsOf('approver'), ['organization.read', 'authority.inspect', 'inventory.read', 'approval.read', 'approval.approve', 'approval.restrict']);
    for (const role of ['observer', 'responder'] as const) assert.equal(operatorMay(role, 'approval.approve'), false, role);
    assert.equal(operatorMay(LEGACY_ADMINISTRATOR_ROLE, 'approval.read'), false);
  });

  it('each verb path needs exactly one permission; only approve needs the permitting one', () => {
    assert.deepEqual(
      Object.fromEntries(Object.entries(APPROVAL_COMMANDS).map(([verb, spec]) => [verb, [spec.port, spec.permission]])),
      { approve: ['approve', 'approval.approve'], reject: ['reject', 'approval.restrict'], 'request-changes': ['requestChanges', 'approval.restrict'], escalate: ['escalate', 'approval.restrict'], revoke: ['revoke', 'approval.restrict'] },
    );
  });

  it('a CTRL-01 administrator credential is refused by the approval service itself, whatever the policy says (defence in depth)', () => {
    assert.match(codeOf(SERVICE), /if \(principal\.credentialClass !== 'operator'\) throw new EnterpriseHttpError\(403, 'OPERATOR_PERMISSION_DENIED'/);
  });

  it('operator roles never become approval authority: no CTRL-04 module reads a role to decide a verdict', () => {
    const ROLE_DECISION = /\.role\b|organization-administrator|'approver'/;
    assert.equal(ROLE_DECISION.test("if (principal.role === 'organization-administrator')"), true);
    for (const file of CTRL04) assert.equal(ROLE_DECISION.test(codeOf(file)), false, file);
  });
});

describe('CTRL-04 structure — no execution, no customer plane, no escalation tiers, no notifications, no domain', () => {
  it('no approval module performs or retries a governed action, or reaches the customer plane', () => {
    const EXECUTE = /governAction|governed-actions|governedActionOrchestrator|executionAdapter|\.execute\(|customerIdentityAdmission|agentCredentialVerifier|issueFromDecision/;
    assert.equal(EXECUTE.test("await fetch('/api/governed-actions')"), true);
    for (const file of CTRL04) assert.equal(EXECUTE.test(codeOf(file)), false, file);
  });

  it('escalation is a recorded verdict only: no tier, override, fallback approver or widened authority', () => {
    const TIERS = /escalationTier|escalationLevel|\btier\b|managerOverride|override|fallbackApprover|boost|autoApprove|grantAuthority/i;
    assert.equal(TIERS.test('const escalationTier = 2'), true);
    for (const file of CTRL04) assert.equal(TIERS.test(codeOf(file)), false, file);
  });

  it('no external notification integration exists in CTRL-04 (CTRL-05 owns alerts)', () => {
    const NOTIFY = /nodemailer|smtp|sendgrid|slack|twilio|webhook|pushNotification|web-push|sendMail|\bsms\b/i;
    assert.equal(NOTIFY.test("import nodemailer from 'nodemailer'"), true);
    for (const file of [...CTRL04, 'src/enterprise/operator-control/roles.ts']) assert.equal(NOTIFY.test(codeOf(file)), false, file);
  });

  it('no payment rail, domain or model vocabulary in the generic approval workflow', () => {
    const FORBIDDEN = /xrpl|lightning|x402|stripe|overledger|\bqnt\b|kubernetes|treasury|payables|invoice|openai|anthropic|langchain|\bllm\b|model provider/i;
    assert.equal(FORBIDDEN.test('new OpenAI()'), true);
    for (const file of CTRL04) assert.equal(FORBIDDEN.test(codeOf(file)), false, file);
  });

  it('the browser reaches approvals only through the console’s server-side Host client', () => {
    const client = codeOf('src/control-plane-web/host-client.ts');
    assert.match(client, /approvals: \(bearer, view\) => send\('GET', `\/api\/admin\/approvals\$\{query\(\{ view \}\)\}`/);
    for (const file of ['src/control-plane-web/views/pages-approvals.tsx', 'src/control-plane-web/approval-forms.ts']) {
      assert.equal(/\/api\/admin|fetch\s*\(|https?:\/\//.test(codeOf(file)), false, file);
    }
  });
});

describe('CTRL-04 structure — the HTTP surface', () => {
  it('seven approval routes: two reads and five explicit verdict paths; no un-revoke, restore, delete or execute path', () => {
    const router = codeOf(ROUTER);
    const matcher = /function matchApprovalRoute[\s\S]*?\n\}/.exec(router)?.[0] ?? '';
    assert.match(matcher, /\^\\\/api\\\/admin\\\/approvals\$/);
    assert.match(matcher, /\^\\\/api\\\/admin\\\/approvals\\\/\(\[\^\/\]\+\)\$/);
    assert.match(matcher, /\(approve\|reject\|request-changes\|escalate\|revoke\)\$/);
    assert.equal(/operator-control\//.test(router), false, 'the router imports nothing from the operator plane');
    assert.deepEqual(Object.keys(APPROVAL_COMMANDS).sort(), ['approve', 'escalate', 'reject', 'request-changes', 'revoke']);
    const surface = JSON.parse(readFileSync('release/api-surface.v1.json', 'utf8')) as { endpointCount: number; routePatterns: string[] };
    assert.deepEqual(
      surface.routePatterns.filter((pattern) => pattern.includes('approvals')),
      ['^\\/api\\/admin\\/approvals$', '^\\/api\\/admin\\/approvals\\/([^/]+)$', '^\\/api\\/admin\\/approvals\\/([^/]+)\\/(approve|reject|request-changes|escalate|revoke)$'],
    );
    // 49 (CTRL-03) + 2 reads + 5 verdict paths = 56; + 2 ASSURE-01 trace reads = 58; + 5 PROD-03-01 operational reads = 63;
    // + 1 PROD-03-02 operator resolution = 64.
    assert.equal(surface.endpointCount, 64);
  });
});
