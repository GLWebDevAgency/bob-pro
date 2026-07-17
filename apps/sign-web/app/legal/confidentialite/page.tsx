import { LegalShell } from '../legal-shell';
import { Markdown } from '../markdown';
import { POLITIQUE_CONFIDENTIALITE_MD } from './content';

export const metadata = {
  title: 'Bob Pro — Politique de confidentialité',
  description: "Politique de confidentialité de l'application Bob Pro (Nico) — RGPD.",
};

export default function ConfidentialitePage() {
  return (
    <LegalShell active="confidentialite">
      <Markdown source={POLITIQUE_CONFIDENTIALITE_MD} />
    </LegalShell>
  );
}
