import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import './globals.css';

export const metadata: Metadata = {
  title: 'Bob Pro · Espace cabinet',
  description: 'Contrôlez les FEC de vos clients sans que leurs données quittent votre navigateur.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="fr">
      <body>{children}</body>
    </html>
  );
}
