import { runGovernanceProofScenarios } from '@/lib/passport-adapter';
export const dynamic = 'force-dynamic';

const flowSteps = [
  ['Runtime Seal', 'Checks the runtime-bound seal and hash linkage.'],
  ['Passport Verification', 'Verifies passport status, signature, and integrity.'],
  ['Policy Manifest', 'Evaluates tools, data, prohibited actions, and approval rules.'],
  ['Runtime Decision', 'Produces ALLOW, DENY, or REQUIRE HUMAN APPROVAL.'],
  ['Audit Event', 'Emits MVP runtime guard event previews.'],
  ['Execution Result', 'Shows whether execution proceeds, blocks, or pauses.'],
];

function outcomeBadge(outcome: string) {
  const cls = outcome === 'allow' ? 'badge-allow' : outcome === 'deny' ? 'badge-deny' : 'badge-human';
  const label = outcome === 'allow' ? 'ALLOW' : outcome === 'deny' ? 'DENY' : 'REQUIRE HUMAN APPROVAL';
  return <span className={`badge ${cls}`}>{label}</span>;
}

function executionBadge(result: string) {
  if (result === 'Allowed to proceed') return <span className="badge badge-allow">PROCEED</span>;
  if (result === 'Paused pending human approval') return <span className="badge badge-human">PENDING HUMAN REVIEW</span>;
  return <span className="badge badge-deny">BLOCKED</span>;
}

export default async function GovernanceProofPage() {
  const scenarios = await runGovernanceProofScenarios();
  const passportId = scenarios[0]?.request.passportId;

  return (
    <div className="container-wide" style={{ paddingTop: 48, paddingBottom: 80 }}>
      <div className="page-header">
        <div className="section-label">Soberanía Proof of Governance Demo</div>
        <h1>Proof of Governance</h1>
        <p style={{ fontSize: 20, marginBottom: 16 }}>Not an ingredient list. A governed execution decision.</p>
        <p style={{ maxWidth: 860 }}>
          Soberanía Agent Passport does not merely describe governance. Inside a governed runtime, it can be used to decide whether an SI agent action is allowed, denied, or requires human approval.
        </p>
        <div className="alert alert-info" style={{ marginTop: 20 }}>
          Runtime Guard Lite does not control the model’s internal reasoning. It controls whether a governed action is allowed to become real-world execution.
        </div>
      </div>

      <div className="card" style={{ marginBottom: 28 }}>
        <h2 style={{ fontSize: 18, marginBottom: 16 }}>Execution path</h2>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 12 }}>
          {flowSteps.map(([title, description], index) => (
            <div key={title} className="card" style={{ background: 'var(--bg-card-2)', padding: 16 }}>
              <div className="section-label">Step {index + 1}</div>
              <strong>{title}</strong>
              <p style={{ color: 'var(--text-muted)', fontSize: 13, marginTop: 8 }}>{description}</p>
            </div>
          ))}
        </div>
      </div>

      <div className="alert alert-warning">
        Important limitations: this demo controls governed execution decisions, not the model’s internal reasoning. Enforcement requires integration into the runtime/tool gateway. MVP audit events are not yet append-only production audit logs. Production use requires persistent storage and production issuer key management.
      </div>

      <div className="card" style={{ marginBottom: 28 }}>
        <h2 style={{ fontSize: 18, marginBottom: 8 }}>Demo agent</h2>
        <p style={{ color: 'var(--text-muted)' }}>SalesBot CR · Soberanía Demo Company · CR · medium autonomy · medium risk</p>
        {passportId && <div className="mono-block" style={{ marginTop: 12 }}>Passport ID: {passportId}</div>}
      </div>

      <div style={{ display: 'grid', gap: 20 }}>
        {scenarios.map((scenario) => (
          <div key={scenario.scenarioKey} className="card">
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap', marginBottom: 16 }}>
              <div>
                <div className="section-label">Scenario</div>
                <h2 style={{ fontSize: 22 }}>{scenario.title}</h2>
              </div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                {outcomeBadge(scenario.decision.outcome)}
                {executionBadge(scenario.executionResult)}
              </div>
            </div>

            <div className="two-col" style={{ marginBottom: 16 }}>
              <div>
                <h3 style={{ fontSize: 14, marginBottom: 8 }}>Request summary</h3>
                <div className="mono-block">{JSON.stringify({ requestedAction: scenario.request.requestedAction, actionCategory: scenario.request.actionCategory, toolName: scenario.request.toolName, dataCategories: scenario.request.dataCategories, riskTier: scenario.request.riskTier }, null, 2)}</div>
              </div>
              <div>
                <h3 style={{ fontSize: 14, marginBottom: 8 }}>Decision details</h3>
                <div className="mono-block">Decision ID: {scenario.decision.decisionId}{'\n'}Reason codes:{'\n'}{scenario.decision.reasonCodes.join('\n')}</div>
              </div>
            </div>

            <div className="card-grid card-grid-3" style={{ marginBottom: 16 }}>
              <Status label="Runtime Seal check result" value={scenario.runtimeSealValid ? 'Valid' : 'Invalid'} ok={scenario.runtimeSealValid} />
              <Status label="Passport verification result" value={scenario.passportValid ? 'Valid' : 'Invalid'} ok={scenario.passportValid} />
              <Status label="Autonomous execution blocked" value={scenario.autonomousExecutionBlocked ? 'Yes' : 'No'} ok={!scenario.autonomousExecutionBlocked} />
            </div>

            <div className="card" style={{ background: 'var(--bg-card-2)', marginBottom: 16 }}>
              <h3 style={{ fontSize: 14, marginBottom: 8 }}>Policy manifest evaluation summary</h3>
              <p style={{ color: 'var(--text-muted)', fontSize: 13 }}>
                Tool allowed: {String(scenario.policyManifestSummary.toolAllowed)} · Data allowed: {String(scenario.policyManifestSummary.dataAllowed)} · Action prohibited: {String(scenario.policyManifestSummary.actionProhibited)} · Human approval rule: {String(scenario.policyManifestSummary.humanApprovalConfigured)}
              </p>
              <div className="mono-block" style={{ marginTop: 10 }}>Hash snippets: passport={scenario.hashSnippets.passportHash} · runtimeSeal={scenario.hashSnippets.runtimeSealPassportHash ?? 'none'} · policy={scenario.hashSnippets.policyManifestHash}</div>
            </div>

            <div>
              <h3 style={{ fontSize: 14, marginBottom: 8 }}>MVP audit event preview</h3>
              <div className="mono-block">{scenario.auditEvents.map((event) => `${event.type} | passport=${event.passportId} | request=${event.requestId} | decision=${event.decisionId ?? 'n/a'} | occurredAt=${event.occurredAt} | reasons=${event.reasonCodes.join(',')}`).join('\n')}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function Status({ label, value, ok }: { label: string; value: string; ok: boolean }) {
  return <div className="card" style={{ background: 'var(--bg-card-2)', padding: 16 }}><div style={{ color: 'var(--text-muted)', fontSize: 12 }}>{label}</div><span className={`badge ${ok ? 'badge-valid' : 'badge-invalid'}`} style={{ marginTop: 8 }}>{value}</span></div>;
}
