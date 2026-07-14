import type { ReactNode } from 'react';
import type { Metadata, Viewport } from 'next';
import { Schibsted_Grotesk, Hanken_Grotesk } from 'next/font/google';
import './globals.css';

const display = Schibsted_Grotesk({
  subsets: ['latin'],
  weight: ['500', '700', '800'],
  variable: '--font-display',
});
const body = Hanken_Grotesk({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-body',
});

export const metadata: Metadata = {
  title: 'Bob Pro — Le copilote vocal des artisans',
  description:
    'Tu le dis, Bob le fait : devis, factures conformes 2026, relances d’impayés et trésorerie — à la voix, entre deux chantiers. Essai 14 jours sans carte bancaire.',
  openGraph: {
    title: 'Bob Pro — Le copilote vocal des artisans',
    description: 'Devis, factures, relances et trésorerie à la voix. Conforme facturation électronique 2026.',
    locale: 'fr_FR',
    type: 'website',
  },
};

export const viewport: Viewport = {
  themeColor: '#0C2340',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="fr" className={`${display.variable} ${body.variable}`}>
      <body>{children}</body>
    </html>
  );
}
