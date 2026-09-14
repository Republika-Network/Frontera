import Link from 'next/link';

export const metadata = {
  title: 'Payment Received — Soberanía Agent Passport',
};

interface Props {
  searchParams: {
    session_id?: string;
    purchase_id?: string;
    tier?: string;
    registry_id?: string;
    access_token?: string;
  };
}

const tierNames: Record<string, string> = {
  agent_passport_single: 'Agent Passport',
  governed_agent: 'Governed Agent',
  organization_agent_registry: 'Organization Agent Registry',
};

export default function CheckoutSuccessPage({ searchParams }: Props) {
  const { session_id, purchase_id, tier, registry_id, access_token } = searchParams;
  const tierName = tier ? (tierNames[tier] ?? tier) : null;
  const isOrgTier = tier === 'organization_agent_registry';

  const enrollHref = session_id
    ? `/enroll-agent?session_id=${encodeURIComponent(session_id)}${purchase_id ? `&purchase_id=${encodeURIComponent(purchase_id)}` : ''}`
    : '/pricing';

  const adminHref =
    registry_id && access_token
      ? `/registry/admin?registry_id=${encodeURIComponent(registry_id)}&access_token=${encodeURIComponent(access_token)}`
      : null;

  const hasSession = Boolean(session_id);

  return (
    <div>
      <section className="section" style={{ paddingTop: 80 }}>
        <div className="container" style={{ maxWidth: 600, textAlign: 'center' }}>
          <div style={{ width: 64, height: 64, borderRadius: '50%', background: 'rgba(34,197,94,0.12)', border: '1px solid rgba(34,197,94,0.3)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 28, margin: '0 auto 24px' }}>
            ✓
          </div>
          <div className="section-label">Payment Received</div>
          {isOrgTier ? (
            <h1 style={{ fontSize: 28, marginBottom: 16 }}>Payment received. Your Organization Registry is ready.</h1>
          ) : (
            <h1 style={{ fontSize: 28, marginBottom: 16 }}>Payment received. Now enroll your AI agent.</h1>
          )}
          {tierName && (
            <div style={{ marginBottom: 16 }}>
              <span className="badge badge-active">{tierName}</span>
            </div>
          )}
          {isOrgTier ? (
            <p style={{ color: 'var(--text-muted)', marginBottom: 16 }}>
              Your Organization Agent Registry has been created. Access your buyer admin view to enroll
              up to 10 governed AI agents and manage your registry.
            </p>
          ) : (
            <p style={{ color: 'var(--text-muted)', marginBottom: 16 }}>
              Your payment has been processed. The next step is to enroll your AI agent and generate its
              passport, constitution, and governance evidence layer.
            </p>
          )}
          {!hasSession && (
            <div className="alert alert-warning" style={{ marginBottom: 24, textAlign: 'left' }}>
              Payment session ID not found in URL. If you completed payment, check your email or contact support.
            </div>
          )}
          {hasSession && !isOrgTier && (
            <div style={{ marginBottom: 16, fontSize: 13, color: 'var(--text-muted)' }}>
              Your payment is being verified. The enrollment button will confirm eligibility on the next page.
            </div>
          )}
          {isOrgTier && !adminHref && hasSession && (
            <div style={{ marginBottom: 16, fontSize: 13, color: 'var(--text-muted)' }}>
              Your registry is being prepared. This may take a moment while your payment is confirmed.
              When it is ready, open administrative access from the recovery page using the session ID
              below and the email address you paid with.
            </div>
          )}
          <div className="hero-actions" style={{ justifyContent: 'center' }}>
            {isOrgTier ? (
              adminHref ? (
                <Link href={adminHref} className="btn btn-primary">
                  Open Organization Registry →
                </Link>
              ) : (
                hasSession ? (
                  <>
                    {/*
                      Administrative access is obtained from the recovery flow, which
                      requires the session ID *and* the buyer contact email and confirms
                      payment with Stripe before rotating. The status endpoint below is
                      unauthenticated and read-only: it reports readiness and never
                      returns a credential (APW-001).
                    */}
                    <Link href="/registry/recover" className="btn btn-primary">
                      Open Registry Access →
                    </Link>
                    <Link href={`/api/checkout/session/${session_id}`} className="btn btn-secondary">
                      Check Registry Status
                    </Link>
                  </>
                ) : (
                  <Link href="/pricing" className="btn btn-primary">View Pricing</Link>
                )
              )
            ) : (
              hasSession ? (
                <Link href={enrollHref} className="btn btn-primary">
                  Enroll Agent →
                </Link>
              ) : (
                <Link href="/pricing" className="btn btn-primary">View Pricing</Link>
              )
            )}
            <Link href="/sample-passport" className="btn btn-secondary">
              View Sample Passport
            </Link>
          </div>
          {session_id && (
            <div style={{ marginTop: 40 }}>
              <div style={{ fontSize: 12, color: 'var(--text-dim)', marginBottom: 8 }}>Stripe Session ID</div>
              <div className="mono-block">{session_id}</div>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
