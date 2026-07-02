import { t } from '@bob/i18n';

// Placeholder C00 : la coque web réelle (SideNav, breakpoints) est le claim C30.
export default function HomePage() {
  return (
    <main>
      <h1>Bob Pro</h1>
      <p>{t('bob.tagline')}</p>
    </main>
  );
}
