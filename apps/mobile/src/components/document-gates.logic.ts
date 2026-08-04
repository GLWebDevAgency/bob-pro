/**
 * Destinations et corps des gates d'émission — logique PURE (aucun import React Native),
 * extraite de DocumentActions.tsx après le bug terrain du 20/07.
 *
 * LE BUG DU 20/07 : `companyIncompleteGateSpec` routait vers `/compte`, écran qui ne portait
 * aucun des champs exigés — cul-de-sac, plus aucune facture émissible.
 * LE BUG DU 30/07 (FLY SERVICES) : même famille, un cran plus loin. Une SAS avec RCS, adresse
 * et TVA remplis restait bloquée « Complète ta fiche entreprise » : le capital social — exigé
 * par `Company.assertCanIssue()` pour toute société (art. R123-238 c. com.) — n'était NI nommé
 * par le gate, NI visible, NI éditable. Le fondateur a re-vérifié un à un des champs déjà
 * remplis : un message générique sur un blocage précis est une impasse déguisée.
 *
 * LE CORRECTIF STRUCTUREL — plus rien d'écrit à la main dans un gate :
 *  · la ROUTE dérive de `FIELD_EDITOR_ROUTE`, la carte « quel écran édite réellement quel
 *    champ » ;
 *  · le CORPS dérive de `COMPANY_GATE_BODY_KEY`, la carte « quel message NOMME quel champ »,
 *    le champ étant fourni par `companyIssueBlocker` (data/company-completeness.ts) qui rejoue
 *    `assertCanIssue`.
 * Le VERROU anti-récidive (document-gates.logic.test.ts) provoque chaque refus du domaine et
 * exige les deux cartes + la clé i18n : une exigence future sans éditeur ni message rougit.
 */
import { t, type I18nKey, type Personality } from '@bob/i18n';
import type { CompanyIssueBlocker } from '../data/company-completeness';

/** Écrans de réglages atteignables depuis un gate. La variante ancrée fait défiler
 *  Réglages jusqu'à la section visée : la page fait plusieurs écrans de haut, atterrir
 *  en tête laissait l'artisan chercher où est le réglage exigé. */
export type SettingsRoute =
  | '/compte'
  | '/reglages-facturation'
  | '/reglages-facturation?section=paymentTerms';

/** Champs dont l'absence peut BLOQUER une émission : les quatre exigences d'identité de
 *  `Company.assertCanIssue()` (via `CompanyIssueBlocker`) + les conditions de paiement
 *  exigées par `IssueInvoice`. */
export type BlockingField = CompanyIssueBlocker | 'paymentTerms';

/**
 * Écran qui porte RÉELLEMENT le champ éditable. SOURCE UNIQUE de la destination des gates.
 * · `rcsOrRm` / `address` / `capitalSocial` / `tvaIntracom`
 *                           → /reglages-facturation §Identité (LegalIdentityEditSheet) ;
 * · `paymentTerms`          → /reglages-facturation §Valeurs par défaut.
 * `/compte` ne porte aucun de ces champs : il n'apparaît volontairement pas ici.
 */
export const FIELD_EDITOR_ROUTE: Readonly<Record<BlockingField, SettingsRoute>> = {
  rcsOrRm: '/reglages-facturation',
  address: '/reglages-facturation',
  capitalSocial: '/reglages-facturation',
  tvaIntracom: '/reglages-facturation',
  paymentTerms: '/reglages-facturation?section=paymentTerms',
};

/**
 * Corps du gate PAR CHAMP — chaque message NOMME ce qui manque, dit la loi en simple, pourquoi
 * elle protège et où aller (doctrine pédagogie légale). `Record` complet : une exigence sans sa
 * clé ne compile pas.
 */
const COMPANY_GATE_BODY_KEY: Readonly<Record<CompanyIssueBlocker, I18nKey>> = {
  rcsOrRm: 'gate.companyIncompleteBodyRcsOrRm',
  address: 'gate.companyIncompleteBodyAddress',
  capitalSocial: 'gate.companyIncompleteBodyCapitalSocial',
  tvaIntracom: 'gate.companyIncompleteBodyTvaIntracom',
};

/** Destination d'édition de la fiche client (adresse de facturation manquante). */
export type CustomerEditRoute = `/client/${string}?edit=1`;

export interface GateSpec {
  readonly title: string;
  readonly body: string;
  readonly ctaLabel: string;
  readonly cancelLabel: string;
  readonly route: SettingsRoute | CustomerEditRoute;
}

/**
 * Gate « entreprise complète » : n'apparaît qu'à l'ACTE qui l'exige légalement — la toute
 * première émission (devis « Envoyer », facture « Émettre » depuis l'état brouillon : c'est là
 * que le numéro légal est alloué). `blocker` vient de `companyIssueBlocker` ; `null` (fiche pas
 * encore chargée, blocage non nommable) garde un corps générique — le gate FERME toujours, il
 * nomme dès qu'il sait.
 */
export function companyIncompleteGateSpec(
  blocker: CompanyIssueBlocker | null,
  personality: Personality,
): GateSpec {
  return {
    title: t('gate.companyIncompleteTitle', { personality }),
    body: t(blocker === null ? 'gate.companyIncompleteBody' : COMPANY_GATE_BODY_KEY[blocker], {
      personality,
    }),
    ctaLabel: t('gate.companyIncompleteCta', { personality }),
    cancelLabel: t('gate.companyIncompleteCancel', { personality }),
    // Les quatre champs d'identité vivent sur le MÊME écran (§Identité) : pour un blocage non
    // nommé, la route de `rcsOrRm` est donc aussi la bonne destination.
    route: FIELD_EDITOR_ROUTE[blocker ?? 'rcsOrRm'],
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

/** Ce que le pré-vol a trouvé de manquant — composé par l'écran avec ses données déjà chargées. */
export interface IssuePreflightMissing {
  readonly companyBlockers: readonly CompanyIssueBlocker[];
  readonly paymentTermsMissing: boolean;
  /** Client ciblé sans adresse de facturation complète — null si la donnée n'est pas chargée
   *  (fail-open ici : le serveur reste l'autorité, on ne bloque jamais sur une inconnue). */
  readonly customerAddressMissing: { readonly customerId: string } | null;
}

const PREFLIGHT_ITEM_KEY: Readonly<Record<CompanyIssueBlocker, I18nKey>> = {
  rcsOrRm: 'gate.preflightItemRcsOrRm',
  address: 'gate.preflightItemAddress',
  capitalSocial: 'gate.preflightItemCapitalSocial',
  tvaIntracom: 'gate.preflightItemTvaIntracom',
};

/**
 * Pré-vol d'émission (audit QA A6) : UNE invite qui nomme TOUT ce qui manque — identité,
 * délai de paiement, adresse du client — AVANT la confirmation « action définitive ».
 * `null` quand rien ne manque : l'émission suit son cours normal.
 */
export function issuePreflightGateSpec(
  missing: IssuePreflightMissing,
  personality: Personality,
): GateSpec | null {
  const items: string[] = missing.companyBlockers.map((blocker) =>
    t(PREFLIGHT_ITEM_KEY[blocker], { personality }),
  );
  if (missing.paymentTermsMissing) items.push(t('gate.preflightItemPaymentTerms', { personality }));
  if (missing.customerAddressMissing !== null)
    items.push(t('gate.preflightItemCustomerAddress', { personality }));
  if (items.length === 0) return null;

  const title =
    items.length === 1
      ? t('gate.preflightTitleOne', { personality })
      : t('gate.preflightTitle', { personality, params: { count: items.length } });
  const route: SettingsRoute | CustomerEditRoute =
    missing.companyBlockers.length > 0
      ? FIELD_EDITOR_ROUTE[missing.companyBlockers[0]!]
      : missing.paymentTermsMissing
        ? FIELD_EDITOR_ROUTE.paymentTerms
        : `/client/${missing.customerAddressMissing!.customerId}?edit=1`;
  return {
    title,
    body: items.map((item) => `• ${item}`).join('\n'),
    ctaLabel: t('gate.preflightCta', { personality }),
    cancelLabel: t('gate.companyIncompleteCancel', { personality }),
    route,
  };
}

/** Adresse de facturation complète — MÊME règle que Customer.assertBillingAddressComplete
 *  (customer.ts) : trois champs non vides. Le serveur reste l'autorité fail-closed. */
export function customerBillingAddressComplete(address: {
  readonly line1: string;
  readonly zip: string;
  readonly city: string;
}): boolean {
  return (
    address.line1.trim().length > 0 && address.zip.trim().length > 0 && address.city.trim().length > 0
  );
}
