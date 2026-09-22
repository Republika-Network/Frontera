import Link from 'next/link';
export const dynamic = 'force-dynamic';
import { createSampleAgentPassport } from '@/lib/passport-adapter';

export const metadata = {
  title: 'Sample Governed Agent Passport — Soberanía Agent Passport',
};

export default async function SamplePassportPage() {
  const bundle = await createSampleAgentPassport();
  const { passport, constitution, policyManifest } = bundle;

  return (
    <div className="container" style={{ paddingTop: 40, paddingBottom: 80 }}>
      <div className="page-header">
        <div className="section-label">Sample Passport</div>
        <h1>Sample Governed Agent</h1>
        <p>
          This is a demonstration passport for <strong>{passport.agentName}</strong> by{' '}
          <strong>{passport.ownerName}</strong>. It shows what a fully governed SI agent
          passport looks like in the Soberanía framework.
        </p>
      </div>

      <div className="alert alert-info" style={{ marginBottom: 32 }}>
        This is a demo passport generated with test signing keys. It is not production-valid.
        See the <Link href={`/passport/${passport.passportId}`}>full passport page</Link>,{' '}
        <Link href={`/verify/${passport.passportId}`}>verify this passport</Link>, or{' '}
        <Link href="/governance-proof">run the Proof of Governance demo</Link>.
      </div>

      <div style={{ display: 'grid', gap: 24 }}>

        {/* Passport summary */}
        <div className="card">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 16 }}>
            <div>
              <h2 style={{ fontSize: 20, marginBottom: 4 }}>{passport.agentName}</h2>
              <p style={{ color: 'var(--text-muted)', fontSize: 14 }}>{passport.purpose}</p>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'flex-end' }}>
              <span className="badge badge-issued">Issued passport</span>
              <span className="badge badge-valid">Runtime seal valid</span>
            </div>
          </div>

          <div className="divider" style={{ margin: '20px 0' }} />

          <div className="two-col">
            <div style={{ display: 'grid', gap: 10 }}>
              <Field label="Owner" value={passport.ownerName} />
              <Field label="Jurisdiction" value={passport.jurisdiction} />
              <Field label="Governance Level" value={passport.governanceLevel} />
              <Field label="Risk Tier" value={passport.riskTier} />
              <Field label="Autonomy Level" value={passport.autonomyLevel} />
            </div>
            <div style={{ display: 'grid', gap: 10 }}>
              <Field label="Passport ID" value={<span className="mono" style={{ fontSize: 12 }}>{passport.passportId}</span>} />
              <Field label="Issued At" value={new Date(passport.issuedAt).toLocaleString()} />
              <Field label="Issuer" value={passport.issuer} />
            </div>
          </div>
        </div>

        {/* Constitution */}
        <div className="two-col">
          <div className="card">
            <h2 style={{ fontSize: 14, fontWeight: 700, marginBottom: 16, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
              Constitution
            </h2>
            <div style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 12, color: 'var(--text-dim)', marginBottom: 4 }}>Hash</div>
              <div className="mono-block">{passport.constitutionHash}</div>
            </div>
            {constitution.prohibitedActions.length > 0 && (
              <div style={{ marginBottom: 12 }}>
                <div style={{ fontSize: 12, color: 'var(--text-dim)', marginBottom: 6 }}>Prohibited Actions</div>
                <div className="tag-list">
                  {constitution.prohibitedActions.map((a) => (
                    <span key={a} className="tag" style={{ color: 'var(--red)', borderColor: 'rgba(239,68,68,0.25)' }}>{a}</span>
                  ))}
                </div>
              </div>
            )}
          </div>

          <div className="card">
            <h2 style={{ fontSize: 14, fontWeight: 700, marginBottom: 16, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
              Policy Manifest
            </h2>
            <div style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 12, color: 'var(--text-dim)', marginBottom: 4 }}>Hash</div>
              <div className="mono-block">{passport.policyManifestHash}</div>
            </div>
            {policyManifest.dataAccess.length > 0 && (
              <div style={{ marginBottom: 12 }}>
                <div style={{ fontSize: 12, color: 'var(--text-dim)', marginBottom: 6 }}>Data Access</div>
                <div className="tag-list">
                  {policyManifest.dataAccess.map((d) => (
                    <span key={d} className="tag">{d}</span>
                  ))}
                </div>
              </div>
            )}
            {policyManifest.toolAccess.length > 0 && (
              <div>
                <div style={{ fontSize: 12, color: 'var(--text-dim)', marginBottom: 6 }}>Tools</div>
                <div className="tag-list">
                  {policyManifest.toolAccess.map((t) => (
                    <span key={t} className="tag">{t}</span>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Actions */}
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          <Link href={`/passport/${passport.passportId}`} className="btn btn-primary">
            View Full Passport →
          </Link>
          <Link href="/governance-proof" className="btn btn-primary">
            See Proof of Governance
          </Link>
          <Link href={`/verify/${passport.passportId}`} className="btn btn-secondary">
            Verify This Passport
          </Link>
          <Link href="/enroll-agent" className="btn btn-secondary">
            Enroll Your Own Agent
          </Link>
        </div>

      </div>
    </div>
  );
}

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: 13 }}>
      <span style={{ color: 'var(--text-dim)' }}>{label}</span>
      <span>{value}</span>
    </div>
  );
}
