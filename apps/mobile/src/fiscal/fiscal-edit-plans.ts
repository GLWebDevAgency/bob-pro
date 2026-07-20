import {
  allowedTaxRegimesFor,
  type FiscalProfileFieldPatch,
  type FiscalSocialStatus,
  type FiscalTaxRegime,
  type LegalForm,
} from '@bob/core';
import { planLegalRegimeCorrection } from './legal-regime-correction';

/**
 * PLANS D'ÉDITION des deux modales expertes de l'écran « Mon profil fiscal » :
 * · « Forme juridique » → sélecteur de FORMES (planLegalFormSelection) ;
 * · « Régime fiscal » → sélecteur des RÉGIMES VALIDES pour la forme actuelle
 *   (allowedTaxRegimesFor @bob/core — jamais un menu où l'utilisateur peut se tromper).
 *
 * Module PUR (aucun import React/i18n) : chaque sélection est traduite en SÉQUENCE de patches
 * à un champ (contrainte backend : une écriture atomique PAR champ) via le planner EXISTANT
 * planLegalRegimeCorrection — réutilisé, pas réinventé. Vérifié exhaustivement contre le VRAI
 * agrégat FiscalProfile dans fiscal-edit-plans.test.ts.
 */

/**
 * Formes proposées par le sélecteur, dans l'ordre d'affichage — « Micro-entrepreneur » reste
 * CHOISISSABLE en premier (le cas le plus fréquent de la cible) mais son libellé/description
 * (fiscal.legalFormChoice.micro.*) dit honnêtement que c'est une EI au régime micro, pas une
 * forme à part. Formes « solo » d'abord, puis les sociétés à plusieurs associés.
 */
export const LEGAL_FORM_CHOICES: readonly LegalForm[] = ['micro', 'EI', 'EURL', 'SASU', 'SAS', 'SARL'];

/**
 * Régime fiscal PAR DÉFAUT d'une forme — celui que la loi applique sans option exercée (mêmes
 * défauts que la dérivation core buildInitialFiscalProfile : EI/EURL → réel IR ; sociétés de
 * capitaux → IS ; micro → micro). Utilisé quand le régime actuel devient INVALIDE pour la forme
 * nouvellement choisie (ex. « option IR » n'existe pas en EI).
 */
const DEFAULT_TAX_REGIME_FOR_FORM: Readonly<Record<LegalForm, FiscalTaxRegime>> = {
  micro: 'micro',
  EI: 'reel_ir',
  EURL: 'reel_ir',
  SASU: 'is',
  SAS: 'is',
  SARL: 'is',
};

/** État courant lu depuis le profil (valeurs + statuts de confirmation des 2 champs édités). */
export interface LegalRegimeEditState {
  readonly legalForm: LegalForm;
  readonly taxRegime: FiscalTaxRegime;
  /** `undefined` = 'manquant' (ex. SARL jamais posée). */
  readonly socialStatus: FiscalSocialStatus | undefined;
  /** `undefined` = 'manquant' — requis pour solder le VL en quittant le micro (planner). */
  readonly versementLiberatoire: boolean | undefined;
  readonly legalFormConfirmed: boolean;
  readonly taxRegimeConfirmed: boolean;
}

function toCorrectionState(current: LegalRegimeEditState) {
  return {
    legalForm: current.legalForm,
    taxRegime: current.taxRegime,
    socialStatus: current.socialStatus,
    versementLiberatoire: current.versementLiberatoire,
  };
}

/**
 * Sélection d'une FORME dans la modale « Forme juridique » :
 * · le régime actuel reste s'il est juridiquement valide pour la nouvelle forme, sinon il bascule
 *   sur le défaut légal de la forme (DEFAULT_TAX_REGIME_FOR_FORM) — le changement de forme qui
 *   invalide le régime déclenche la séquence de correction EXISTANTE (pivot SARL, sortie de
 *   micro dans le bon ordre, solde du VL…) ;
 * · re-choisir la forme actuelle CONFIRME l'hypothèse (patch même valeur → statut
 *   'confirme_utilisateur') si elle ne l'était pas déjà — sinon aucun patch (rien à écrire).
 */
export function planLegalFormSelection(
  current: LegalRegimeEditState,
  chosen: LegalForm,
): readonly FiscalProfileFieldPatch[] {
  const regimeStillAllowed = allowedTaxRegimesFor(chosen).some((choice) => choice.regime === current.taxRegime);
  const targetRegime = regimeStillAllowed ? current.taxRegime : DEFAULT_TAX_REGIME_FOR_FORM[chosen];
  if (chosen === current.legalForm && targetRegime === current.taxRegime) {
    return current.legalFormConfirmed ? [] : [{ field: 'legalForm', value: chosen }];
  }
  return planLegalRegimeCorrection(toCorrectionState(current), {
    id: `edit-form-${chosen}`,
    legalForm: chosen,
    taxRegime: targetRegime,
  });
}

/**
 * Sélection d'un RÉGIME dans la modale « Régime fiscal » — le régime choisi vient TOUJOURS de
 * allowedTaxRegimesFor(forme actuelle), la forme ne change donc jamais ici (choisir « micro »
 * en EI garde la forme EI : c'est le régime micro DE l'EI). Re-choisir le régime actuel
 * CONFIRME l'hypothèse s'il ne l'était pas déjà.
 */
export function planTaxRegimeSelection(
  current: LegalRegimeEditState,
  chosen: FiscalTaxRegime,
): readonly FiscalProfileFieldPatch[] {
  if (chosen === current.taxRegime) {
    return current.taxRegimeConfirmed ? [] : [{ field: 'taxRegime', value: chosen }];
  }
  return planLegalRegimeCorrection(toCorrectionState(current), {
    id: `edit-regime-${chosen}`,
    legalForm: current.legalForm,
    taxRegime: chosen,
  });
}
