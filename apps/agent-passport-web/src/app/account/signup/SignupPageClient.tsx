'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';

export function SignupPageClient() {
  const searchParams = useSearchParams();
  const claimRegistryId = searchParams.get('claim_registry_id') ?? '';
  const accessToken = searchParams.get('access_token') ?? '';

  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    if (password !== confirmPassword) {
      setError('Passwords do not match.');
      return;
    }
    setLoading(true);
    try {
      const body: Record<string, string> = { email, password };
      if (displayName) body.display_name = displayName;
      if (claimRegistryId) body.claim_registry_id = claimRegistryId;
      if (accessToken) body.access_token = accessToken;

      const res = await fetch('/api/account/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!data.ok) {
        setError(data.error ?? 'Signup failed.');
        return;
      }
      window.location.href = '/account/dashboard';
    } catch {
      setError('An unexpected error occurred.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="container" style={{ paddingTop: 60, paddingBottom: 80, maxWidth: 480 }}>
      <div className="page-header" style={{ marginBottom: 32 }}>
        <div className="section-label">Buyer Account</div>
        <h1>Create your Soberanía buyer account</h1>
        <p style={{ color: 'var(--text-muted)' }}>
          Own your SI agent registry. Invite teammates. Track governance evidence.
        </p>
      </div>

      <div className="card">
        <form onSubmit={handleSubmit}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div>
              <label className="form-label">Email</label>
              <input
                className="form-input"
                type="email"
                value={email}
                onChange={e => setEmail(e.target.value)}
                required
                autoComplete="email"
                placeholder="you@example.com"
              />
            </div>
            <div>
              <label className="form-label">Display Name (optional)</label>
              <input
                className="form-input"
                type="text"
                value={displayName}
                onChange={e => setDisplayName(e.target.value)}
                maxLength={120}
                placeholder="Your name"
              />
            </div>
            <div>
              <label className="form-label">Password</label>
              <input
                className="form-input"
                type="password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                required
                autoComplete="new-password"
                placeholder="At least 10 characters"
              />
            </div>
            <div>
              <label className="form-label">Confirm Password</label>
              <input
                className="form-input"
                type="password"
                value={confirmPassword}
                onChange={e => setConfirmPassword(e.target.value)}
                required
                autoComplete="new-password"
              />
            </div>

            {error && (
              <div className="alert alert-error">{error}</div>
            )}

            <button className="btn btn-primary" type="submit" disabled={loading}>
              {loading ? 'Creating account…' : 'Create Account'}
            </button>
          </div>
        </form>
      </div>

      <p style={{ marginTop: 24, color: 'var(--text-muted)', fontSize: 14 }}>
        Already have an account?{' '}
        <Link href="/account/login" style={{ color: 'var(--accent)' }}>Sign in</Link>
      </p>
    </div>
  );
}
