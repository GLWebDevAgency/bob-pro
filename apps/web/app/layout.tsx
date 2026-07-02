import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { t } from '@bob/i18n';

export const metadata: Metadata = {
  title: 'Bob Pro',
  description: t('bob.tagline'),
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="fr">
      <body>{children}</body>
    </html>
  );
}
