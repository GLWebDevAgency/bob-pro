import type { ReactNode } from 'react';
import Link from 'next/link';
import { palette, shell } from './styles';

const NAV_LINKS: Array<{ id: 'cgu' | 'confidentialite'; href: string; label: string }> = [
  { id: 'cgu', href: '/legal/conditions-utilisation', label: "Conditions d'utilisation" },
  { id: 'confidentialite', href: '/legal/confidentialite', label: 'Politique de confidentialité' },
];

export function LegalShell({
  active,
  children,
}: {
  active: 'cgu' | 'confidentialite';
  children: ReactNode;
}) {
  return (
    <main style={shell}>
      <Link href="/" style={{ fontSize: 13, color: palette.gray, textDecoration: 'none' }}>
        ← Bob Pro
      </Link>
      <div style={{ marginTop: 16 }}>{children}</div>
      <footer
        style={{
          marginTop: 36,
          paddingTop: 18,
          borderTop: `1px solid ${palette.border}`,
          display: 'flex',
          gap: 18,
          flexWrap: 'wrap',
          fontSize: 12.5,
        }}
      >
        {NAV_LINKS.map((link) => (
          <Link
            key={link.id}
            href={link.href}
            aria-current={active === link.id ? 'page' : undefined}
            style={{
              color: active === link.id ? palette.navy : palette.gray,
              fontWeight: active === link.id ? 700 : 400,
              textDecoration: active === link.id ? 'underline' : 'none',
            }}
          >
            {link.label}
          </Link>
        ))}
      </footer>
    </main>
  );
}
