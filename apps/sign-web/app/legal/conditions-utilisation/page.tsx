import { LegalShell } from '../legal-shell';
import { Markdown } from '../markdown';
import { CONDITIONS_UTILISATION_MD } from './content';

export const metadata = {
  title: "Bob Pro — Conditions générales d'utilisation",
  description: "Conditions générales d'utilisation de l'application Bob Pro (Nico).",
};

export default function ConditionsUtilisationPage() {
  return (
    <LegalShell active="cgu">
      <Markdown source={CONDITIONS_UTILISATION_MD} />
    </LegalShell>
  );
}
