/**
 * Destinations des gates d'émission — logique PURE (aucun import React Native), extraite de
 * DocumentActions.tsx après le bug terrain du 20/07.
 *
 * LE BUG : `companyIncompleteGateSpec` affichait « complète ta fiche » et routait vers `/compte`
 * — un écran qui ne porte NI `rcsOrRm` NI l'adresse. Or ce sont exactement les deux champs
 * qu'exige `Company.assertCanIssue()`. L'utilisateur arrivait donc sur un écran sans issue :
 * toute société dont le provisioning SIRET n'avait pas fourni le RCS ne pouvait plus JAMAIS
 * émettre de facture.
 *
 * LE CORRECTIF STRUCTUREL : la route d'un gate n'est plus écrite à la main. Elle est DÉRIVÉE de
 * `FIELD_EDITOR_ROUTE`, la carte « quel écran édite réellement quel champ ». Déplacer un champ
 * d'écran sans mettre cette carte à jour casse le test — le cul-de-sac ne peut plus revenir en
 * silence.
 */
import { t, type Personality } from '@bob/i18n';

/** Écrans de réglages atteignables depuis un gate. */
export type SettingsRoute = '/compte' | '/reglages-facturation';

/** Champs dont l'absence peut BLOQUER une émission (miroir de `Company.assertCanIssue()` pour
 *  l'identité, + les conditions de paiement exigées par `IssueInvoice`). */
export type BlockingField = 'rcsOrRm' | 'address' | 'paymentTerms';

/**
 * Écran qui porte RÉELLEMENT le champ éditable. SOURCE UNIQUE de la destination des gates.
 * · `rcsOrRm` / `address` → /reglages-facturation §Identité (LegalIdentityEditSheet) ;
 * · `paymentTerms`        → /reglages-facturation §Valeurs par défaut.
 * `/compte` ne porte aucun de ces champs : il n'apparaît volontairement pas ici.
 */
export const FIELD_EDITOR_ROUTE: Readonly<Record<BlockingField, SettingsRoute>> = {
  rcsOrRm: '/reglages-facturation',
  address: '/reglages-facturation',
  paymentTerms: '/reglages-facturation',
};

export interface GateSpec {
  readonly title: string;
  readonly body: string;
  readonly ctaLabel: string;
  readonly cancelLabel: string;
  readonly route: SettingsRoute;
}

/**
 * Gate « entreprise complète » : n'apparaît qu'à l'ACTE qui l'exige légalement — la toute
 * première émission (devis « Envoyer », facture « Émettre » depuis l'état brouillon : c'est là
 * que le numéro légal est alloué). Route dérivée de `rcsOrRm`, l'unique champ d'identité que
 * `assertCanIssue` vérifie en premier — et qui vit sur le même écran que l'adresse.
 */
export function companyIncompleteGateSpec(
  kind: 'quote' | 'invoice',
  personality: Personality,
): GateSpec {
  return {
    title: t('gate.companyIncompleteTitle', { personality }),
    body: t(
      kind === 'quote' ? 'gate.companyIncompleteBodyQuote' : 'gate.companyIncompleteBodyInvoice',
      { personality },
    ),
    ctaLabel: t('gate.companyIncompleteCta', { personality }),
    cancelLabel: t('gate.companyIncompleteCancel', { personality }),
    route: FIELD_EDITOR_ROUTE.rcsOrRm,
  };
}

/** Émission sans conditions de paiement réglées : même invite deux boutons, CTA → réglages. */
export function paymentTermsMissingGateSpec(personality: Personality): GateSpec {
  return {
    title: t('invoice.paymentTermsMissingTitle', { personality }),
    body: t('invoice.paymentTermsMissingBody', { personality }),
    ctaLabel: t('invoice.paymentTermsMissingCta', { personality }),
    cancelLabel: t('common.cancel', { personality }),
    route: FIELD_EDITOR_ROUTE.paymentTerms,
  };
}
