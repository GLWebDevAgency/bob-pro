import { formatEURWhole } from '../../format/money';
import { type FiscalActivityNature, type FiscalProfileView } from '../../domain/fiscal/fiscal-profile';
import { computeMicroSocialProvision, type MicroActivityCategory } from '../../domain/fiscal/micro-social';

/**
 * Use case pur « langage & montant du prélèvement selon le profil fiscal CONFIRMÉ » — Phase 1C
 * (SPEC_EXPERT_FISCAL.md §V2 pt. 1 « les QUATRE SOMMES jamais mélangées » + pt. 6 « tableau de
 * langage par situation » ; §UX verdict GPT pt. 5-6 « Argent = snapshot, chaque résultat avec
 * statut »).
 *
 * DOCTRINE D'HONNÊTETÉ ABSOLUE : un montant ne s'affiche QUE s'il est produit par du code core
 * TESTÉ à partir de données CONNUES — jamais une rémunération nette inventée. Tant que le régime
 * fiscal n'est pas CONFIRMÉ PAR L'UTILISATEUR (`taxRegime.status === 'confirme_utilisateur'` —
 * une simple hypothèse dérivée du SIRET ne suffit pas, cf. domain/fiscal/fiscal-profile.ts), le
 * langage reste le prudent historique (`kind: 'prudent'`, LES MÊMES clés qu'avant cette phase —
 * zéro régression, cf. quick-win ⓪ : today.payoutHint / argent.heroLabel / argent.heroCaption).
 *
 * Une fois le régime confirmé, TROIS familles de langage (JAMAIS de dividendes mensuels en 1C) :
 * · MICRO confirmé + CA de la période connu (`periodeCA`) + nature d'activité connue → le SEUL cas
 *   où un montant NOUVEAU se calcule : `payout − provision URSSAF de la période`
 *   (computeMicroSocialProvision, même moteur que deriveUrssafProvision/buildLedgerView — réconcilié
 *   Publicodes au centime). Sans `periodeCA` ou sans nature d'activité connue → 'prudent' (honnête :
 *   rien à calculer sans ces deux données, cf. mission 1C, pas de nouvel endpoint).
 *   ACRE : computeMicroSocialProvision SAIT appliquer un taux réduit (`acreRatePct`), mais résoudre
 *   CE taux exige une date de début d'activité ET la date du jour (domain/fiscal/micro-social.ts,
 *   acreWindow/resolveAcreSocialPct) — deux données hors du contrat volontairement minimal de cette
 *   fonction (profile, cashflow, periodeCA). Le taux PLEIN est donc TOUJOURS appliqué ici, jamais un
 *   taux réduit deviné : c'est le sens PRUDENT de l'erreur (on met de côté un peu TROP, jamais trop
 *   peu) — et un bénéficiaire ACRE connu (`profile.acre`) en est informé honnêtement (`acreNote`),
 *   jamais silencieusement sur-provisionné sans explication.
 * · Statut social ASSIMILÉ SALARIÉ confirmé (SASU/SAS) → 'salaire_a_simuler' : le ratio chargé
 *   (net après charges salariales+patronales) exige Publicodes (flag serveur OFF en 1C) — AUCUN
 *   montant net inventé. Le montant reste la trésorerie mobilisable INCHANGÉE (`cashflow.payout`,
 *   jamais recalculée ici), reformulée en langage « budget employeur » pour ne pas laisser croire
 *   que c'est un salaire net personnel.
 * · Statut social TNS confirmé hors micro (EI réel, EURL) → 'prelevement_apres_provisions' : les
 *   provisions TNS (retraite/maladie) restent à simuler (hors périmètre 1C) — montant mobilisable
 *   INCHANGÉ, langage honnête sur ce qui reste à affiner.
 * · Régime confirmé mais statut social encore INCONNU (ex. SARL : gérant majoritaire/minoritaire
 *   indérivable, cf. buildInitialFiscalProfile) → 'prudent' : on ne devine jamais à 50/50.
 */

export type OwnerPayGuidanceKind =
  | 'prudent'
  | 'micro_retrait_prudent'
  | 'salaire_a_simuler'
  | 'prelevement_apres_provisions';

export interface OwnerPayGuidanceCashflow {
  /** Dispo prévisionnel (centimes) — propagé pour cohérence d'appel, non recalculé ici. */
  available: number;
  /** Trésorerie mobilisable sans risque (centimes, project-cashflow.ts) — la base de tous les cas. */
  payout: number;
  /** TVA à provisionner (centimes) — déjà déduite dans `payout`, jamais recomptée ici. */
  vatDue: number;
}

/** CA encaissé de la période URSSAF en cours — absent = provision non calculable, retombe 'prudent'. */
export interface OwnerPayGuidancePeriodCA {
  /** Centimes, plancher 0 déjà appliqué par l'appelant (même règle que deriveUrssafProvision). */
  encaissedCents: number;
  /** Année civile de la période — pilote la version des taux (MICRO_SOCIAL_RATES). */
  year: number;
}

export interface OwnerPayGuidance {
  kind: OwnerPayGuidanceKind;
  /** Centimes — présent SEULEMENT quand un montant nouveau est honnêtement calculable. */
  amountCents?: number;
  /** Clé i18n du libellé court (rôle « heroLabel ») — jamais de montant dedans (cf. caption). */
  headlineKey: string;
  /** Clé i18n de la phrase d'explication (rôle « heroCaption »/« payoutHint ») — porte le montant. */
  captionKey: string;
  /** Params d'interpolation ({amount}, {ratePct}, {acreNote}…) — un paramètre absent du template
   *  visé est simplement ignoré par `t()` (packages/i18n), donc toujours fournis sans risque. */
  params: Readonly<Record<string, string | number>>;
}

const FALLBACK_HEADLINE_KEY = 'argent.heroLabel';
const FALLBACK_CAPTION_KEY = 'argent.heroCaption';

function prudentFallback(cashflow: OwnerPayGuidanceCashflow): OwnerPayGuidance {
  return {
    kind: 'prudent',
    headlineKey: FALLBACK_HEADLINE_KEY,
    captionKey: FALLBACK_CAPTION_KEY,
    params: { amount: formatEURWhole(cashflow.payout) },
  };
}

/**
 * Nature d'activité fiscale → catégorie micro-sociale (URSSAF). 'mixte' n'a pas de ventilation
 * connue entre ventes et prestations : on retient la catégorie la plus chère (bnc, 25,6 % en 2026)
 * — même politique de prudence que `microCategoryFromTrade` quand le métier seul est ambigu
 * (domain/fiscal/micro-social.ts) : mieux vaut mettre de côté un peu trop qu'un peu trop peu.
 */
const ACTIVITY_TO_MICRO_CATEGORY: Record<FiscalActivityNature, MicroActivityCategory> = {
  bic_vente: 'ventes',
  bic_service: 'bic_prestations',
  bnc: 'bnc',
  bnc_cipav: 'liberale_reglementee_cipav',
  mixte: 'bnc',
};

/** Taux en % → chaîne FR à une décimale, virgule (les taux du référentiel sont tous à 0,1 % près). */
function formatRatePct(pct: number): string {
  return pct.toFixed(1).replace('.', ',');
}

export function deriveOwnerPayGuidance(
  profile: FiscalProfileView,
  cashflow: OwnerPayGuidanceCashflow,
  periodeCA?: OwnerPayGuidancePeriodCA,
): OwnerPayGuidance {
  if (profile.taxRegime.status !== 'confirme_utilisateur') {
    return prudentFallback(cashflow);
  }

  if (profile.taxRegime.value === 'micro') {
    if (periodeCA === undefined) return prudentFallback(cashflow);

    const natureDatum = profile.activityNature;
    if (natureDatum.status === 'manquant') return prudentFallback(cashflow);
    const category = ACTIVITY_TO_MICRO_CATEGORY[natureDatum.value];

    const vflDatum = profile.versementLiberatoire;
    const vfl = vflDatum.status === 'manquant' ? false : vflDatum.value;

    const provision = computeMicroSocialProvision({
      encaissedCents: periodeCA.encaissedCents,
      category,
      vfl,
      year: periodeCA.year,
      // Jamais de taux réduit ici — voir le commentaire de tête (ACRE hors contrat de cette fonction).
    });
    const retraitCents = Math.max(0, cashflow.payout - provision.provisionCents);

    const acreDatum = profile.acre;
    const acreGranted = acreDatum.status !== 'manquant' && acreDatum.value.granted === true;

    return {
      kind: 'micro_retrait_prudent',
      amountCents: retraitCents,
      headlineKey: 'fiscal.guidance.microRetraitPrudent.headline',
      captionKey: 'fiscal.guidance.microRetraitPrudent.caption',
      params: {
        amount: formatEURWhole(retraitCents),
        ratePct: formatRatePct(provision.totalRatePct),
        acreNote: acreGranted
          ? ' Taux plein posé pour l’instant : ta réduction ACRE n’est pas encore intégrée ici, je reste prudent.'
          : '',
      },
    };
  }

  const socialStatusDatum = profile.socialStatus;
  const socialStatus = socialStatusDatum.status === 'confirme_utilisateur' ? socialStatusDatum.value : undefined;

  if (socialStatus === 'assimile_salarie') {
    return {
      kind: 'salaire_a_simuler',
      headlineKey: 'fiscal.guidance.salaireASimuler.headline',
      captionKey: 'fiscal.guidance.salaireASimuler.caption',
      params: { amount: formatEURWhole(cashflow.payout) },
    };
  }

  if (socialStatus === 'tns') {
    return {
      kind: 'prelevement_apres_provisions',
      headlineKey: 'fiscal.guidance.prelevementApresProvisions.headline',
      captionKey: 'fiscal.guidance.prelevementApresProvisions.caption',
      params: { amount: formatEURWhole(cashflow.payout) },
    };
  }

  // Régime confirmé mais statut social encore inconnu (ex. SARL) — jamais un 50/50 deviné.
  return prudentFallback(cashflow);
}
