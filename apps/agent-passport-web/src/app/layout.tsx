import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Soberanía Agent Passport',
  description:
    'Give your SI agents a constitution. Enroll, verify, and govern SI agents with Soberanía Agent Passport.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <nav className="nav">
          <div className="container-wide">
            <div className="nav-inner">
              <a href="/agent-passport" className="nav-brand">
                <span>Soberanía</span> Agent Passport
              </a>
              <div className="nav-links">
                <a href="/pricing">Pricing</a>
                <a href="/sample-passport">Sample Passport</a>
                <a href="/agent-passport">About</a>
              </div>
              <div className="nav-cta">
                <a href="/pricing" className="btn btn-primary btn-sm">
                  Get Agent Passport
                </a>
              </div>
            </div>
          </div>
        </nav>
        <main>{children}</main>
        <footer style={{ borderTop: '1px solid var(--border)', padding: '32px 0', marginTop: '64px' }}>
          <div className="container">
            <p style={{ color: 'var(--text-dim)', fontSize: '13px' }}>
              Soberanía Agent Passport — MVP / Development Build. In-memory storage only.
              Not for production use.
            </p>
          </div>
        </footer>
      </body>
    </html>
  );
}
