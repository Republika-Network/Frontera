'use client';

import { useState } from 'react';

export default function OrgRegistryStartPage() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({
    organizationName: '',
    buyerContactEmail: '',
    buyerContactName: '',
    buyerContactRole: '',
    organizationWebsite: '',
    organizationCountry: '',
    organizationIndustry: '',
    organizationSize: '',
    organizationUseCase: '',
  });

  function handleChange(e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) {
    setForm(f => ({ ...f, [e.target.name]: e.target.value }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (!form.organizationName.trim()) {
      setError('Organization name is required.');
      return;
    }
    if (!form.buyerContactEmail.trim()) {
      setError('Buyer contact email is required.');
      return;
    }

    setLoading(true);
    try {
      const res = await fetch('/api/checkout/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tier: 'organization_agent_registry',
          organization_profile: {
            organizationName: form.organizationName,
            buyerContactEmail: form.buyerContactEmail,
            buyerContactName: form.buyerContactName || undefined,
            buyerContactRole: form.buyerContactRole || undefined,
            organizationWebsite: form.organizationWebsite || undefined,
            organizationCountry: form.organizationCountry || undefined,
            organizationIndustry: form.organizationIndustry || undefined,
            organizationSize: form.organizationSize || undefined,
            organizationUseCase: form.organizationUseCase || undefined,
          },
        }),
      });
      const data = await res.json() as { url?: string; error?: string; code?: string };
      if (data.url) {
        window.location.href = data.url;
      } else {
        setError(data.error ?? 'Checkout failed. Please try again.');
      }
    } catch {
      setError('An unexpected error occurred. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="container" style={{ maxWidth: 640, paddingTop: 60, paddingBottom: 80 }}>
      <div className="section-label">Organization Agent Registry</div>
      <h1 style={{ fontSize: 28, marginBottom: 12 }}>Start your Organization Agent Registry</h1>
      <p style={{ color: 'var(--text-muted)', marginBottom: 32 }}>
        Create a governed registry for up to 10 SI agent passports and capture the organization profile
        used in your registry evidence.
      </p>

      {error && (
        <div className="alert alert-warning" style={{ marginBottom: 24 }}>
          {error}
        </div>
      )}

      <form onSubmit={handleSubmit}>
        <div className="card" style={{ marginBottom: 24 }}>
          <h2 style={{ fontSize: 15, fontWeight: 700, marginBottom: 16 }}>Organization</h2>

          <div className="form-field" style={{ marginBottom: 16 }}>
            <label className="form-label">
              Organization Name <span style={{ color: 'var(--accent)' }}>*</span>
            </label>
            <input
              className="form-input"
              type="text"
              name="organizationName"
              value={form.organizationName}
              onChange={handleChange}
              placeholder="Acme Corp"
              maxLength={120}
              required
            />
          </div>

          <div className="form-field" style={{ marginBottom: 16 }}>
            <label className="form-label">Organization Website</label>
            <input
              className="form-input"
              type="url"
              name="organizationWebsite"
              value={form.organizationWebsite}
              onChange={handleChange}
              placeholder="https://example.com"
              maxLength={240}
            />
          </div>

          <div className="form-grid form-grid-2" style={{ gap: 16, marginBottom: 0 }}>
            <div className="form-field">
              <label className="form-label">Country</label>
              <input
                className="form-input"
                type="text"
                name="organizationCountry"
                value={form.organizationCountry}
                onChange={handleChange}
                placeholder="United States"
                maxLength={80}
              />
            </div>
            <div className="form-field">
              <label className="form-label">Industry</label>
              <input
                className="form-input"
                type="text"
                name="organizationIndustry"
                value={form.organizationIndustry}
                onChange={handleChange}
                placeholder="Financial Services"
                maxLength={120}
              />
            </div>
            <div className="form-field">
              <label className="form-label">Organization Size</label>
              <select
                className="form-input"
                name="organizationSize"
                value={form.organizationSize}
                onChange={handleChange}
              >
                <option value="">Select size</option>
                <option value="1-10">1–10 employees</option>
                <option value="11-50">11–50 employees</option>
                <option value="51-200">51–200 employees</option>
                <option value="201-1000">201–1,000 employees</option>
                <option value="1000+">1,000+ employees</option>
              </select>
            </div>
          </div>
        </div>

        <div className="card" style={{ marginBottom: 24 }}>
          <h2 style={{ fontSize: 15, fontWeight: 700, marginBottom: 16 }}>Buyer Contact</h2>

          <div className="form-field" style={{ marginBottom: 16 }}>
            <label className="form-label">
              Contact Email <span style={{ color: 'var(--accent)' }}>*</span>
            </label>
            <input
              className="form-input"
              type="email"
              name="buyerContactEmail"
              value={form.buyerContactEmail}
              onChange={handleChange}
              placeholder="you@example.com"
              maxLength={200}
              required
            />
          </div>

          <div className="form-grid form-grid-2" style={{ gap: 16, marginBottom: 0 }}>
            <div className="form-field">
              <label className="form-label">Contact Name</label>
              <input
                className="form-input"
                type="text"
                name="buyerContactName"
                value={form.buyerContactName}
                onChange={handleChange}
                placeholder="Jane Smith"
                maxLength={120}
              />
            </div>
            <div className="form-field">
              <label className="form-label">Contact Role</label>
              <input
                className="form-input"
                type="text"
                name="buyerContactRole"
                value={form.buyerContactRole}
                onChange={handleChange}
                placeholder="CTO"
                maxLength={120}
              />
            </div>
          </div>
        </div>

        <div className="card" style={{ marginBottom: 32 }}>
          <h2 style={{ fontSize: 15, fontWeight: 700, marginBottom: 16 }}>Primary SI Agent Use Case</h2>
          <div className="form-field">
            <label className="form-label">Describe your primary use case</label>
            <textarea
              className="form-input"
              name="organizationUseCase"
              value={form.organizationUseCase}
              onChange={handleChange}
              placeholder="e.g. Governed customer support agents, internal workflow automation agents..."
              maxLength={500}
              rows={3}
              style={{ resize: 'vertical' }}
            />
          </div>
        </div>

        <button
          type="submit"
          className="btn btn-primary"
          disabled={loading}
          style={{ width: '100%', padding: '14px 24px', fontSize: 16 }}
        >
          {loading ? 'Redirecting to checkout...' : 'Continue to Checkout →'}
        </button>

        <p style={{ marginTop: 16, fontSize: 12, color: 'var(--text-dim)', textAlign: 'center' }}>
          Your organization profile is used in your governance evidence bundle and registry exports.
          Payment is processed securely by Stripe.
        </p>
      </form>
    </div>
  );
}
