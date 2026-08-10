import React, { type CSSProperties } from 'react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { LegalShell } from '../legal/legal-shell';
import { h1Style, h2Style, liStyle, linkStyle, pStyle, palette, ulStyle } from '../legal/styles';
import { DELETION_REQUEST_MAILTO, SUPPORT_EMAIL } from './content';

export const metadata: Metadata = {
  title: 'Bob Pro — Suppression de compte',
  description:
    "Demandez la suppression de votre compte Bob Pro dans l'application ou par email si vous n'y avez plus accès.",
  robots: { index: true, follow: true },
};

const calloutStyle: CSSProperties = {
  margin: '18px 0 22px',
  padding: '16px',
  border: `1px solid ${palette.border}`,
  borderRadius: 12,
  background: palette.bg,
};

const actionStyle: CSSProperties = {
  display: 'inline-block',
  minHeight: 44,
  boxSizing: 'border-box',
  padding: '12px 16px',
  borderRadius: 10,
  background: palette.navy,
  color: palette.white,
  fontWeight: 700,
  textDecoration: 'none',
};

const warningStyle: CSSProperties = {
  ...calloutStyle,
  background: palette.amberBg,
  borderColor: '#EBCB91',
};

// 6,79:1 sur amberBg — le rôle palette.amber historique est insuffisant pour du texte normal.
const warningTextColor = '#7A4A08';

export default function AccountDeletionPage() {
  return (
    <LegalShell active="suppression">
      <header>
        <h1 style={h1Style}>Suppression de votre compte Bob Pro</h1>
        <p style={pStyle}>
          Vous pouvez initier la fermeture de votre compte dans l’application. Si vous n’y avez plus
          accès, cette page vous permet d’envoyer une demande au support sans réinstaller Bob Pro.
        </p>
      </header>

      <section aria-labelledby="delete-in-app">
        <h2 id="delete-in-app" style={h2Style}>
          Demande depuis l’application
        </h2>
        <ol style={ulStyle}>
          <li style={liStyle}>Ouvrez Bob Pro et connectez-vous au compte concerné.</li>
          <li style={liStyle}>Ouvrez l’onglet « Compte ».</li>
          <li style={liStyle}>Dans « Zone sensible », choisissez « Supprimer mon compte ».</li>
          <li style={liStyle}>
            Lisez le récapitulatif, saisissez le nom exact de l’entreprise puis confirmez.
          </li>
        </ol>
        <div style={calloutStyle}>
          <p style={{ ...pStyle, marginBottom: 0 }}>
            Ce parcours est le plus rapide et le plus sûr : la session authentifiée permet de
            vérifier que la demande vient bien du titulaire du compte. L’accès est clôturé, puis les
            opérations d’effacement et de conservation doivent être menées jusqu’à leur
            confirmation.
          </p>
        </div>
      </section>

      <section aria-labelledby="request-without-access">
        <h2 id="request-without-access" style={h2Style}>
          Vous n’avez plus accès à l’application ?
        </h2>
        <p style={pStyle}>
          Envoyez la demande depuis l’adresse email utilisée pour votre compte. Indiquez seulement
          cette adresse et le nom de votre entreprise ; le support vous répondra pour vérifier votre
          identité avant toute action.
        </p>
        <a href={DELETION_REQUEST_MAILTO} style={actionStyle}>
          Demander la suppression par email
        </a>
        <p style={{ ...pStyle, marginTop: 10, fontSize: 13 }}>
          Adresse destinataire :{' '}
          <a href={`mailto:${SUPPORT_EMAIL}`} style={linkStyle}>
            {SUPPORT_EMAIL}
          </a>
        </p>
        <div style={warningStyle} role="note" aria-label="Données à ne jamais envoyer">
          <p style={{ ...pStyle, marginBottom: 0, color: warningTextColor }}>
            N’envoyez jamais votre mot de passe, un token de connexion, une pièce d’identité ou un
            devis, une facture ou un autre document métier dans ce premier message.
          </p>
        </div>
        <p style={pStyle}>
          La demande par email n’est pas une suppression automatique. Elle reste en cours jusqu’à la
          vérification de votre identité et à la confirmation du traitement par le support.
        </p>
      </section>

      <section aria-labelledby="data-outcome">
        <h2 id="data-outcome" style={h2Style}>
          Ce qui est supprimé ou conservé
        </h2>
        <p style={pStyle}>Le traitement complet de la demande distingue :</p>
        <ul style={ulStyle}>
          <li style={liStyle}>
            l’accès au compte et l’identité d’authentification, qui doivent être supprimés ;
          </li>
          <li style={liStyle}>
            les appareils, jetons de notification, liens publics et traces effaçables, qui doivent
            être supprimés ou révoqués ;
          </li>
          <li style={liStyle}>
            les préférences, historiques et brouillons sans obligation de conservation, qui doivent
            être supprimés ou anonymisés ;
          </li>
          <li style={liStyle}>
            les pièces soumises à une obligation légale de conservation, traitées séparément.
          </li>
        </ul>
        <p style={pStyle}>
          Les devis transformés en facture, factures, avoirs, écritures et justificatifs déjà émis,
          ainsi que les données strictement nécessaires à leur preuve, peuvent rester conservés
          pendant la durée imposée par les obligations comptables et légales. Ils ne maintiennent
          pas un compte actif.
        </p>
        <p style={pStyle}>
          Pour le détail des finalités, destinataires, durées et droits, consultez la{' '}
          <Link href="/legal/confidentialite" style={linkStyle}>
            politique de confidentialité de Bob Pro
          </Link>
          .
        </p>
      </section>
    </LegalShell>
  );
}
