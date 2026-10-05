import type { DemoSummary } from './contracts.js';

/**
 * ANDREW-P0-11 — a concise Markdown rendering of `summary.json`. Presentation
 * only: rendered from the summary object, never a second source of truth. The
 * canonical records (and the summary built from them) remain authoritative.
 */

const cell = (value: unknown): string => (value === undefined || value === null ? '—' : typeof value === 'object' ? `\`${JSON.stringify(value)}\`` : `\`${String(value)}\``);

export function renderMarkdownReport(summary: DemoSummary): string {
  const a = summary.scenarioA ?? {};
  const b = summary.scenarioB ?? {};
  const lines = [
    `# Andrew / LUMX demo — run \`${summary.runId}\``,
    '',
    `**Final verdict: ${summary.finalVerdict}**${summary.failure !== undefined ? ` — ${summary.failure.category}: ${summary.failure.message}` : ''}`,
    '',
    `Rendered from \`summary.json\` (authoritative: the canonical records it was built from). Network: ${summary.network.name} (network id ${cell(summary.network.networkId)}). Started ${summary.startedAt}${summary.finishedAt !== undefined ? `, finished ${summary.finishedAt}` : ''}.`,
    '',
    '## Amounts — what is real and what is illustrative',
    '',
    '| | |',
    '| --- | --- |',
    `| Governed (business) amount of the live transfer | ${cell(`${summary.amounts.governedAmount.unit} ${summary.amounts.governedAmount.value}`)} |`,
    `| What moved on XRPL Testnet | ${cell(`${summary.amounts.testnetTransfer.value} ${summary.amounts.testnetTransfer.asset}`)} — Test RLUSD has no real-world value |`,
    `| Production motivating example | ${cell(`${summary.amounts.productionMotivatingExample.unit} ${summary.amounts.productionMotivatingExample.value}`)} — ${summary.amounts.productionMotivatingExample.note} |`,
    `| Scenario B request | ${cell(b['requestedAmount'])} — withheld; nothing moved |`,
    '',
    '## Scenario A — unapproved destination → approval → linked reconsideration → one Testnet payment',
    '',
    '| Field | Value |',
    '| --- | --- |',
    ...['originalRequestId', 'originalDecisionId', 'originalStatus', 'originalReasonCodes', 'approvalEvidence', 'businessIntentId', 'reconsiderationRequestId', 'reconsiderationDecisionId', 'grantId', 'grantAmountBound', 'executionId', 'transactionHash', 'ledgerIndex', 'engineResult', 'deliveredAmount', 'assureFinalState', 'assureVerified', 'secondReconsideration', 'historicalReplay'].map((key) => `| ${key} | ${cell(a[key])} |`),
    '',
    '## Scenario B — approved destination, USD 125,000 against a USD 100,000 authority',
    '',
    '| Field | Value |',
    '| --- | --- |',
    ...['requestId', 'decisionId', 'decisionStatus', 'requestedAmount', 'authorityCeiling', 'issuanceOutcome', 'withheldBy', 'reasonCode', 'issuanceRecord', 'grantCount', 'connectionCount', 'signatureCount', 'submissionCount', 'attemptRowCount', 'transactionHash', 'assureFinalState', 'assureVerified'].map((key) => `| ${key} | ${cell(b[key])} |`),
    '',
    '## Checkpoints',
    '',
    '| Step | Result | Detail |',
    '| --- | --- | --- |',
    ...summary.checkpoints.map((entry) => `| ${entry.step} | ${entry.result} | ${entry.detail ?? ''} |`),
    '',
  ];
  return lines.join('\n');
}
