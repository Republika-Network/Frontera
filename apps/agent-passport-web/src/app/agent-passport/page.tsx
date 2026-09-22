import Link from 'next/link';
import { AGENT_PASSPORT_TIERS } from '@/lib/pricing';
import { PricingCard } from '@/components/PricingCard';
import { CheckoutButton } from '@/components/CheckoutButton';

export const metadata = {
  title: 'Soberanía Agent Passport — Give your SI agents a constitution',
  description: 'Soberanía Agent Passport gives SI agents identity, authority boundaries, signed constitutions, runtime seals, and public verification.',
};

export default function AgentPassportPage() {
  return (
    <div>
      {/* ── Hero ── */}
      <section className="hero" style={{ paddingTop: 100, paddingBottom: 80 }}>
        <div className="container">
          <div className="section-label">Agent Governance Protocol</div>
          <h1>Give your SI agents<br />a constitution.</h1>
          <p>
            Enroll SI agents into a governance framework that defines identity, authority, limits,
            human oversight, public verification, and runtime-enforceable evidence.
          </p>
          <div style={{ fontSize: 13, color: 'var(--text-dim)', marginBottom: 32 }}>
            Built on Soberanía Passport Core, Runtime Seal, and Runtime Guard Lite. Passports can now be persisted server-side with issuer key metadata and durable verification records.
          </div>
          <div className="hero-actions">
            <CheckoutButton tierKey="agent_passport_single" label="Get Agent Passport" className="btn btn-primary" />
            <Link href="/sample-passport" className="btn btn-secondary">
              View Sample Passport
            </Link>
            <Link href="/governance-proof" className="btn btn-secondary">
              See Proof of Governance
            </Link>
          </div>
        </div>
      </section>

      <div className="divider" />

      {/* ── Problem ── */}
      <section className="section">
        <div className="container">
          <div className="section-label">The Problem</div>
          <h2>SI agents are acting without passports.</h2>
          <p style={{ marginBottom: 32 }}>
            Businesses are deploying SI agents that can answer customers, trigger workflows, access tools,
            touch data, and represent the company — often without a clear identity, authority boundary, or verification layer.
          </p>
          <div className="card-grid card-grid-2" style={{ gap: 12 }}>
            {[
              'No clear agent identity',
              'No declared scope of authority',
              'No public verification',
              'No signed constitution',
              'No runtime seal',
              'No enforceable action boundary',
              'No evidence trail for governance',
            ].map(item => (
              <div key={item} style={{ display: 'flex', alignItems: 'center', gap: 10, color: 'var(--text-muted)', fontSize: 14 }}>
                <span style={{ color: 'var(--red)', fontWeight: 700 }}>✗</span> {item}
              </div>
            ))}
          </div>
        </div>
      </section>

      <div className="divider" />

      {/* ── What is Soberanía Agent Passport ── */}
      <section className="section">
        <div className="container">
          <div className="section-label">Product</div>
          <h2>What is Soberanía Agent Passport?</h2>
          <p style={{ marginBottom: 40 }}>
            Soberanía Agent Passport is a verifiable governance identity for SI agents. It packages an agent&apos;s
            identity, purpose, owner, allowed actions, prohibited actions, data boundaries, human oversight rules,
            signed constitution, policy manifest, runtime seal, and public verification page.
          </p>
          <div className="card-grid card-grid-3" style={{ gap: 20 }}>
            <div className="card">
              <div style={{ color: 'var(--accent)', fontSize: 11, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: 12 }}>Agent Identity</div>
              <ul style={{ listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 6 }}>
                {['Passport ID', 'Owner', 'Purpose', 'Jurisdiction'].map(f => (
                  <li key={f} style={{ fontSize: 14, color: 'var(--text-muted)', display: 'flex', gap: 8 }}>
                    <span style={{ color: 'var(--green)' }}>→</span> {f}
                  </li>
                ))}
              </ul>
            </div>
            <div className="card">
              <div style={{ color: 'var(--accent)', fontSize: 11, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: 12 }}>Agent Constitution</div>
              <ul style={{ listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 6 }}>
                {['Authority', 'Boundaries', 'Oversight', 'Escalation'].map(f => (
                  <li key={f} style={{ fontSize: 14, color: 'var(--text-muted)', display: 'flex', gap: 8 }}>
                    <span style={{ color: 'var(--green)' }}>→</span> {f}
                  </li>
                ))}
              </ul>
            </div>
            <div className="card">
              <div style={{ color: 'var(--accent)', fontSize: 11, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: 12 }}>Runtime Seal</div>
              <ul style={{ listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 6 }}>
                {['Hashes', 'Signature', 'Tamper evidence', 'Runtime verification'].map(f => (
                  <li key={f} style={{ fontSize: 14, color: 'var(--text-muted)', display: 'flex', gap: 8 }}>
                    <span style={{ color: 'var(--green)' }}>→</span> {f}
                  </li>
                ))}
              </ul>
            </div>
            <div className="card">
              <div style={{ color: 'var(--accent)', fontSize: 11, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: 12 }}>Public Verification</div>
              <ul style={{ listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 6 }}>
                {['Status', 'Governance level', 'Reason codes', 'Badge / QR payload'].map(f => (
                  <li key={f} style={{ fontSize: 14, color: 'var(--text-muted)', display: 'flex', gap: 8 }}>
                    <span style={{ color: 'var(--green)' }}>→</span> {f}
                  </li>
                ))}
              </ul>
            </div>
            <div className="card">
              <div style={{ color: 'var(--accent)', fontSize: 11, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: 12 }}>Runtime Guard Ready</div>
              <ul style={{ listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 6 }}>
                {['Allow', 'Deny', 'Require human approval', 'Action-level enforcement path'].map(f => (
                  <li key={f} style={{ fontSize: 14, color: 'var(--text-muted)', display: 'flex', gap: 8 }}>
                    <span style={{ color: 'var(--green)' }}>→</span> {f}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      </section>

      <div className="divider" />

      {/* ── How it works ── */}
      <section className="section">
        <div className="container">
          <div className="section-label">Process</div>
          <h2>How it works</h2>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 0, marginTop: 32 }}>
            {[
              {
                step: '01',
                title: 'Enroll your agent',
                body: 'Define purpose, owner, autonomy level, risk tier, data access, tools, prohibited actions, and escalation rules.',
              },
              {
                step: '02',
                title: 'Generate its constitution',
                body: 'Soberanía creates a machine-readable Agent Constitution and Policy Manifest.',
              },
              {
                step: '03',
                title: 'Issue its passport',
                body: 'The agent receives a Passport ID, hashes, signature, QR payload, badge snippet, and public verification page.',
              },
              {
                step: '04',
                title: 'Verify publicly',
                body: 'Anyone can check the passport status, governance level, hashes, and verification result.',
              },
              {
                step: '05',
                title: 'Enforce at runtime',
                body: 'Runtime Guard Lite can evaluate whether governed actions should be allowed, denied, or sent for human approval.',
              },
            ].map((s, i) => (
              <div key={s.step} style={{ display: 'flex', gap: 24, paddingBottom: 28, borderBottom: i < 4 ? '1px solid var(--border)' : 'none', marginBottom: i < 4 ? 28 : 0 }}>
                <div style={{ fontFamily: 'var(--mono)', fontSize: 13, color: 'var(--accent)', minWidth: 32, paddingTop: 2 }}>{s.step}</div>
                <div>
                  <div style={{ fontWeight: 700, marginBottom: 6 }}>{s.title}</div>
                  <div style={{ color: 'var(--text-muted)', fontSize: 14 }}>{s.body}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      <div className="divider" />

      {/* ── Pricing ── */}
      <section className="section" id="pricing">
        <div className="container-wide">
          <div style={{ textAlign: 'center', marginBottom: 48 }}>
            <div className="section-label">Pricing</div>
            <h2 style={{ fontSize: 32 }}>Simple, transparent pricing.</h2>
            <p>One price per governance tier. No subscriptions for the first two tiers.</p>
          </div>
          <div style={{ display: 'grid', gap: 24, gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))' }}>
            {AGENT_PASSPORT_TIERS.map(tier => (
              <PricingCard key={tier.key} tier={tier} />
            ))}
          </div>
          <p style={{ textAlign: 'center', marginTop: 24, fontSize: 13, color: 'var(--text-dim)' }}>
            This is an MVP product. See <Link href="/pricing">full pricing details and FAQ</Link>.
          </p>
        </div>
      </section>

      <div className="divider" />

      {/* ── Comparison ── */}
      <section className="section">
        <div className="container">
          <div className="section-label">Comparison</div>
          <h2>Not just an SI governance document.</h2>
          <div style={{ overflowX: 'auto', marginTop: 32 }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
              <thead>
                <tr>
                  <th style={{ textAlign: 'left', padding: '10px 16px', color: 'var(--text-muted)', fontWeight: 600, borderBottom: '1px solid var(--border)' }}>Capability</th>
                  <th style={{ textAlign: 'center', padding: '10px 16px', color: 'var(--text-muted)', fontWeight: 600, borderBottom: '1px solid var(--border)' }}>Generic governance policy</th>
                  <th style={{ textAlign: 'center', padding: '10px 16px', color: 'var(--accent)', fontWeight: 700, borderBottom: '1px solid var(--border)' }}>Soberanía Agent Passport</th>
                </tr>
              </thead>
              <tbody>
                {[
                  ['Constitution format', 'Static PDF', 'Signed machine-readable constitution'],
                  ['Verifiability', 'Internal-only', 'Public verification page'],
                  ['Runtime anchor', 'No runtime anchor', 'Runtime seal'],
                  ['Action enforcement', 'No action decision layer', 'Runtime Guard compatible'],
                  ['Policy structure', 'Manual review', 'Structured policy manifest'],
                  ['Identity artifact', 'No badge', 'Verifiable badge / QR payload'],
                ].map(([cap, generic, aoc], i) => (
                  <tr key={cap} style={{ background: i % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.02)' }}>
                    <td style={{ padding: '12px 16px', color: 'var(--text-muted)', fontWeight: 500 }}>{cap}</td>
                    <td style={{ padding: '12px 16px', textAlign: 'center', color: 'var(--text-dim)' }}>{generic}</td>
                    <td style={{ padding: '12px 16px', textAlign: 'center', color: 'var(--green)', fontWeight: 600 }}>{aoc}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <div className="divider" />

      {/* ── Runtime Guard ── */}
      <section className="section">
        <div className="container">
          <div className="section-label">Runtime Guard</div>
          <h2>From verification to enforcement.</h2>
          <p style={{ marginBottom: 32 }}>
            Soberanía Agent Passport gives an agent identity. Runtime Guard Lite makes that identity enforceable inside governed runtimes.
          </p>
          <div className="alert alert-info" style={{ marginBottom: 24, fontSize: 14 }}>
            Runtime Guard Lite does not control the model&apos;s internal reasoning. It controls whether a governed action is allowed to become real-world execution.
          </div>
          <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 8, padding: 24 }}>
            <div style={{ fontSize: 12, color: 'var(--text-dim)', marginBottom: 16, fontFamily: 'var(--mono)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Decision Path</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, fontFamily: 'var(--mono)', fontSize: 13 }}>
              {['Runtime Seal', 'Passport Verification', 'Policy Manifest Evaluation', 'Runtime Decision', 'Audit Event'].map((s, i, arr) => (
                <span key={s} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ background: 'var(--bg-card-2)', border: '1px solid var(--border-light)', borderRadius: 4, padding: '4px 10px', color: 'var(--text-muted)', fontSize: 12 }}>{s}</span>
                  {i < arr.length - 1 && <span style={{ color: 'var(--text-dim)' }}>→</span>}
                </span>
              ))}
            </div>
            <div style={{ marginTop: 20, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              <span className="badge badge-allow">ALLOW</span>
              <span className="badge badge-deny">DENY</span>
              <span className="badge badge-human">REQUIRE_HUMAN_APPROVAL</span>
            </div>
          </div>
        </div>
      </section>

      <div className="divider" />

      {/* ── Sample ── */}
      <section className="section">
        <div className="container" style={{ textAlign: 'center' }}>
          <div className="section-label">Demo</div>
          <h2>See a governed agent passport</h2>
          <p style={{ marginBottom: 32 }}>
            Review a complete example passport for SalesBot CR — a governed sales agent.
          </p>
          <Link href="/sample-passport" className="btn btn-secondary">
            View SalesBot CR Sample Passport
          </Link>
          <Link href="/governance-proof" className="btn btn-primary">
            See Proof of Governance
          </Link>
        </div>
      </section>

      <div className="divider" />

      {/* ── Final CTA ── */}
      <section style={{ padding: '80px 0', textAlign: 'center', background: 'var(--bg-card)' }}>
        <div className="container">
          <div className="section-label">Get Started</div>
          <h2 style={{ fontSize: 32, marginBottom: 16 }}>Start by giving one agent a passport.</h2>
          <p style={{ color: 'var(--text-muted)', marginBottom: 40, maxWidth: 560, margin: '0 auto 40px' }}>
            Enroll your first SI agent and give it a constitution, verification page, runtime seal,
            and governance evidence layer.
          </p>
          <div className="hero-actions">
            <CheckoutButton tierKey="agent_passport_single" label="Get Agent Passport" className="btn btn-primary" />
            <Link href="/pricing" className="btn btn-secondary">
              View All Plans
            </Link>
          </div>
        </div>
      </section>
    </div>
  );
}
