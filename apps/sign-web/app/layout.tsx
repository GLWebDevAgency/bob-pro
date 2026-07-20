import type { ReactNode } from 'react';

export const metadata = {
  title: 'Bob Pro — Signature de devis',
  description: 'Signez votre devis en ligne, en toute simplicité.',
  robots: { index: false, follow: false, nocache: true },
  referrer: 'no-referrer',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="fr">
      <body
        style={{
          fontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif',
          margin: 0,
          background: '#F4F6F9',
          color: '#0C2340',
          minHeight: '100vh',
        }}
      >
        {children}
      </body>
    </html>
  );
}
