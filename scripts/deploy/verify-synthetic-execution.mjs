#!/usr/bin/env node
// AUTH-04D2V — the pilot operator's read-only verification of one synthetic
// execution: the AUTH-04D2S verifier, fed only from existing private read
// paths and keys pinned on this machine. Run as the `execution-verifier` tool
// of deploy/authority-pilot/compose.executor.yaml, on the Host machine:
//
//   docker compose ... run --rm -T execution-verifier --request <requestId>
//   docker compose ... run --rm -T execution-verifier --execution <executionId>
//
// What it reads, and nothing else:
//   - CORE-05: GET /api/admin/approvals?view=all and /api/admin/approvals/{id}
//     on the Host's private operator plane (127.0.0.1:8787), as the observer
//     operator (FRONTERA_OPERATOR_KEY_OBSERVER): the canonical subject bytes,
//     the status, the counted approvers and every verdict row.
//   - ASSURE-01: GET /api/evidence/traces/{requestId}?level=AUDITOR and
//     /verify on the same private listener, as the read-only pilot auditor
//     (FRONTERA_AUDITOR_KEY_EXECUTION_VERIFIER): the execution identity, the
//     final state, the approval records and the trace's own verification.
//   - The Host's G-02B issuance ledger and G-02C1D receipt evidence store, on
//     its state volume, through their own openers, read methods only.
//   - The pinned keys: the rendered public configuration in
//     FRONTERA_SYNTHETIC_EXECUTION_DIR (the executor receipt key the Host pins,
//     the authority keys the executor pins). Never from an argument.
//
// It writes nothing, starts nothing, sends no POST, and never prints a
// credential, a key, a capability or a receipt — only identifiers, statuses
// and digests. The result is the AUTH-04D2S statement, unchanged in meaning:
// EXECUTION_UNKNOWN is never turned into success, and an authorized decision is
// never shown as an execution.
//
// Exit codes: 0 the verification ran (whatever its status); 2 it could not run
// (usage, missing configuration, refused access, unknown request).

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const dist = (path) => join(ROOT, 'dist/src/enterprise', path);

class Refusal extends Error {}
const refuse = (message) => {
  throw new Refusal(message);
};

function required(env, name) {
  const value = env[name];
  if (value === undefined || value.length === 0) refuse(`${name} is not set.`);
  return value;
}

function readJson(path, what) {
  if (!existsSync(path)) refuse(`${what} is missing (${path}).`);
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    refuse(`${what} is not valid JSON (${path}).`);
  }
}

/** One GET on the Host's private listener. Never logs a header or a body. */
async function get(host, path, authorization) {
  let response;
  try {
    response = await fetch(new URL(path, host), { method: 'GET', headers: { authorization: `Bearer ${authorization}` }, redirect: 'error' });
  } catch {
    refuse(`the Host's private listener is not reachable at ${host}.`);
  }
  const text = await response.text();
  if (response.status === 401 || response.status === 403) refuse(`access refused (${response.status}) on ${path.split('?')[0]}.`);
  if (response.status === 404) return undefined;
  if (response.status !== 200) refuse(`unexpected ${response.status} on ${path.split('?')[0]}.`);
  try {
    return JSON.parse(text);
  } catch {
    refuse(`the Host answered ${path.split('?')[0]} with something that is not JSON.`);
  }
}

/** The pinned trust: everything comes from the rendered public configuration, never from the caller. */
function pinned(directory) {
  const policy = readJson(join(directory, 'governed-actions.json'), 'the rendered Host policy');
  const executor = readJson(join(directory, 'synthetic-executor.json'), 'the rendered executor configuration');
  const capabilities = policy.executionCapabilities;
  if (capabilities === undefined || capabilities.receiptEvidence === undefined) refuse('the rendered Host policy has no executionCapabilities.receiptEvidence (stage 3 is not configured).');
  const issuer = capabilities.issuer;
  const trustedIssuer = (executor.trustedIssuers ?? []).find((entry) => entry.issuer === issuer);
  if (trustedIssuer === undefined) refuse('the rendered executor configuration pins no key for the Host issuer.');
  for (const key of trustedIssuer.keys) if (String(key.publicKeyPem).includes('PRIVATE')) refuse('a pinned authority key is not a public key.');
  const trustedExecutors = capabilities.receiptEvidence.trustedExecutors;
  for (const entry of trustedExecutors) for (const key of entry.keys) if (String(key.publicKeyPem).includes('PRIVATE')) refuse('a pinned executor key is not a public key.');
  const organizationIds = [...new Set(trustedExecutors.flatMap((entry) => entry.organizationIds))];
  if (organizationIds.length !== 1) refuse('the pinned configuration must name exactly one organization.');
  return {
    issuer,
    organizationId: organizationIds[0],
    trustDomain: policy.trustDomainId,
    issuanceLedgerPath: capabilities.issuanceLedgerPath,
    evidenceStorePath: capabilities.receiptEvidence.storePath,
    trustedIssuer: { issuer, keys: trustedIssuer.keys },
    trustedExecutors,
    syntheticActions: executor.syntheticExecution?.syntheticActions ?? [],
  };
}

/** The CORE-05 view, as the operator plane restates it: the canonical subject bytes are re-parsed and must re-serialize to themselves. */
function approvalInput(detail, canonicalApprovalSubject) {
  let subject;
  try {
    subject = JSON.parse(detail.canonicalSubject);
  } catch {
    return null;
  }
  if (canonicalApprovalSubject(subject) !== detail.canonicalSubject) return null;
  return {
    approvalRequestId: detail.approvalRequestId,
    requestId: detail.requestId,
    decisionId: detail.decisionId,
    subjectDigest: detail.subjectDigest,
    subject,
    state: {
      status: detail.status,
      approvers: [...(detail.quorum?.countedApprovers ?? [])],
      ...(typeof detail.notAfter === 'string' ? { notAfter: detail.notAfter } : {}),
      ...(typeof detail.approvalDigest === 'string' ? { approvalDigest: detail.approvalDigest } : {}),
      verdicts: (detail.verdicts ?? []).map((verdict) => ({ kind: verdict.kind, actorId: verdict.actorId, counted: verdict.counted === true, recordedBy: verdict.recordedBy, rowDigest: verdict.rowDigest })),
    },
  };
}

/** Every counted approving row of the operator view must also be in the verified trace's approval records: two read paths, one history. */
function corroborated(approval, trace) {
  if (approval === null) return true;
  const records = trace.stages?.approval?.records;
  if (!Array.isArray(records)) return false;
  return approval.state.verdicts
    .filter((verdict) => verdict.kind === 'approved')
    .every((verdict) => records.some((record) => record.kind === 'approved' && record.digest === verdict.rowDigest && record.subjectDigest === approval.subjectDigest && record.recordedBy === verdict.recordedBy));
}

async function readStores(trust, executionId) {
  const notes = [];
  let issuance = null;
  let evidence = { observations: [], receipts: [] };
  if (executionId === undefined) return { issuance, evidence, notes };
  const { openExecutionCapabilityIssuanceLedger } = await import(dist('execution-capability-issuance/index.js'));
  const { openExecutionReceiptEvidenceStore } = await import(dist('execution-receipt-evidence/index.js'));
  if (!existsSync(trust.issuanceLedgerPath)) notes.push('issuance ledger absent');
  else {
    try {
      const ledger = await openExecutionCapabilityIssuanceLedger(trust.issuanceLedgerPath, { issuer: trust.issuer, clock: Date.now });
      try {
        const record = ledger.read(executionId);
        issuance = record.state === 'absent' ? { state: 'absent' } : { state: record.state, canonical: record.canonical, ...(record.signature !== undefined ? { signature: record.signature } : {}) };
      } finally {
        ledger.close();
      }
    } catch {
      notes.push('issuance ledger unreadable (refused its own integrity checks)');
    }
  }
  if (!existsSync(trust.evidenceStorePath)) notes.push('receipt evidence store absent');
  else {
    try {
      const store = await openExecutionReceiptEvidenceStore(trust.evidenceStorePath, { issuer: trust.issuer, organizationId: trust.organizationId, trustDomain: trust.trustDomain, clock: Date.now });
      try {
        evidence = {
          observations: store.observationsFor(executionId).map(({ transmission, httpOutcome, disposition, agreement }) => ({ transmission, httpOutcome, disposition, agreement })),
          receipts: store.evidenceFor(executionId).map((entry) => ({ sequence: entry.sequence, presented: entry.presented })),
        };
      } finally {
        store.close();
      }
    } catch {
      notes.push('receipt evidence store unreadable (refused its own integrity checks)');
    }
  }
  return { issuance, evidence, notes };
}

const SUMMARY = {
  NOT_AUTHORIZED: 'Not authorized. Nothing was attempted, and no approved human passkey decision for exactly this request stands now.',
  AUTHORIZED: 'Authorized by a human passkey decision; NOT executed. Authorization is not execution.',
  DELIVERY_FAILED: 'Authorized; delivery FAILED definitively. Nothing was presented to any executor.',
  SIMULATED_SUCCESS: 'SIMULATED success: the pinned synthetic executor signed that it recorded the one synthetic effect for exactly this execution. No external business effect.',
  EXECUTION_UNKNOWN: 'Execution UNKNOWN: the evidence does not establish an outcome. Not a success.',
};

export async function verifySyntheticExecution(argv, env) {
  const flag = (name) => {
    const index = argv.indexOf(name);
    return index === -1 ? undefined : argv[index + 1];
  };
  const requestArg = flag('--request');
  const executionArg = flag('--execution');
  if ((requestArg === undefined) === (executionArg === undefined) || argv.length !== 2) refuse('usage: verify-synthetic-execution.mjs --request <requestId> | --execution <executionId>');
  const host = env.FRONTERA_VERIFIER_HOST ?? 'http://127.0.0.1:8787';
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(host)) refuse('the verifier reads the Host on its private loopback listener only.');
  const trust = pinned(env.FRONTERA_SYNTHETIC_EXECUTION_DIR ?? '/etc/frontera-synthetic-execution');
  const observer = required(env, 'FRONTERA_OPERATOR_KEY_OBSERVER');
  const auditor = required(env, 'FRONTERA_AUDITOR_KEY_EXECUTION_VERIFIER');

  const { canonicalApprovalSubject } = await import(dist('approval-authority/subject.js'));
  const { executionIdForGrant } = await import(dist('authority-authenticity/execution-capability-issuance.js'));
  const { createSyntheticExecutionVerifier } = await import(dist('synthetic-execution-verification/index.js'));

  // Resolve the request: by id, or by recomputing every approval's execution identity (the derivation the governed path uses).
  const inbox = await get(host, '/api/admin/approvals?view=all', observer);
  const items = Array.isArray(inbox?.approvals) ? inbox.approvals : [];
  let requestId = requestArg;
  if (executionArg !== undefined) {
    const match = items.find((item) => executionIdForGrant({ correlation: { requestId: item.requestId, decisionId: item.decisionId, action: item.action, resourceScope: item.resourceScope } }) === executionArg);
    if (match === undefined) refuse('EXECUTION_NOT_FOUND: no approval request on this Host resolves to that execution id.');
    requestId = match.requestId;
  }
  const item = items.find((candidate) => candidate.requestId === requestId);
  const detail = item === undefined ? undefined : await get(host, `/api/admin/approvals/${encodeURIComponent(item.approvalRequestId)}`, observer);
  const approval = detail === undefined ? null : approvalInput(detail, canonicalApprovalSubject);

  const traced = await get(host, `/api/evidence/traces/${encodeURIComponent(requestId)}?level=AUDITOR`, auditor);
  if (traced === undefined) refuse('REQUEST_NOT_FOUND: the Host holds no trace for that request.');
  const verification = await get(host, `/api/evidence/traces/${encodeURIComponent(requestId)}/verify`, auditor);
  const trace = traced.trace;
  const notes = [];
  let verified = verification?.verified === true;
  if (trace.organizationId !== trust.organizationId) {
    verified = false;
    notes.push('the trace names another organization than the pinned one');
  }
  if (detail !== undefined && approval === null) notes.push('the approval subject bytes did not re-serialize to themselves');
  if (!corroborated(approval, trace)) {
    verified = false;
    notes.push('the approval rows are not corroborated by the verified trace');
  }
  const stores = await readStores(trust, trace.executionId);
  notes.push(...stores.notes);

  const verifier = createSyntheticExecutionVerifier({ trustedIssuer: trust.trustedIssuer, trustedExecutors: trust.trustedExecutors, syntheticActions: trust.syntheticActions });
  const statement = verifier.verify({
    approval,
    trace: {
      requestId: trace.requestId,
      organizationId: trace.organizationId,
      decisionId: trace.decisionId,
      ...(typeof trace.executionId === 'string' ? { executionId: trace.executionId } : {}),
      finalState: trace.summary?.finalState ?? 'unverifiable',
      verified,
    },
    issuance: stores.issuance,
    evidence: stores.evidence,
  });
  return { statement, notes, traceDigest: verification?.traceDigest ?? null };
}

function summary({ statement, notes, traceDigest }) {
  const lines = [
    'Frontera synthetic execution verification (SYNTHETIC ONLY — no external business effect is possible or claimed)',
    `  status        ${statement.status} (${statement.reason})`,
    `  meaning       ${SUMMARY[statement.status]}`,
    `  organization  ${statement.organizationId}`,
    `  request       ${statement.requestId}`,
    `  decision      ${statement.decisionId}`,
    `  execution     ${statement.executionId}`,
    `  operation     ${statement.operation === null ? '-' : `${statement.operation.action} on ${statement.operation.resource} (synthetic)`}`,
    `  approval      ${statement.approval === null ? '-' : `${statement.approval.approvalRequestId}, now ${statement.approval.currentStatus}, by ${statement.approval.approvedBy.join(', ') || '-'} via ${statement.approval.channel ?? '-'}`}`,
    `  subject       ${statement.approval?.subjectDigest ?? '-'}`,
    `  capability    ${statement.capability === null ? '-' : `${statement.capability.capabilityId} (issuer ${statement.capability.issuer}, key ${statement.capability.issuerKeyId}, binding ${statement.capability.actionBindingDigest})`}`,
    `  receipt       ${statement.receipt === null ? '-' : `${statement.receipt.receiptId} ${statement.receipt.receiptDigest} by ${statement.receipt.executorId} (${statement.receipt.outcome} at ${statement.receipt.observedAt})`}`,
    `  trace         ${traceDigest ?? '-'}`,
    `  statement     ${statement.verificationDigest}`,
    ...notes.map((note) => `  note          ${note}`),
  ];
  return `${lines.join('\n')}\n--- statement (${statement.format}) ---\n${JSON.stringify(statement, null, 2)}\n`;
}

if (import.meta.url === new URL(process.argv[1] ?? '', 'file:').href) {
  try {
    process.stdout.write(summary(await verifySyntheticExecution(process.argv.slice(2), process.env)));
  } catch (error) {
    process.stderr.write(`verify-synthetic-execution: ${error instanceof Refusal ? error.message : 'the verification could not run.'}\n`);
    process.exit(2);
  }
}
