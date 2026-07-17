import type { ReactNode } from 'react';

// Le layout racine (apps/sign-web/app/layout.tsx) verrouille l'indexation à false pour les
// pages de signature/consultation privées. Les pages légales sont au contraire des documents
// publics destinés à être liés depuis les stores et l'application : on réautorise l'indexation
// ici.
export const metadata = {
  robots: { index: true, follow: true },
};

export default function LegalLayout({ children }: { children: ReactNode }) {
  return children;
}
