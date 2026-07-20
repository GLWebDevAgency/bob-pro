import type { FiscalProfileFieldPatch, FiscalSocialStatus, FiscalTaxRegime, LegalForm } from '@bob/core';
import { type LegalRegimeCombo, requiredSocialStatusFor, socialCategoryFor } from './legal-regime-combos';

/**
 * CORRECTION du couple forme+régime (mini-flow, étape « Non, corriger » — SPEC_EXPERT_FISCAL
 * §UX FLOW amendement 3, branches SASU/EURL distinctes).
 *
 * CONTRAINTE DÉCOUVERTE (Phase 1B) : le backend Phase 1A n'expose QU'UNE écriture atomique par
 * champ (PATCH /fiscal-profile/:field, use case UpdateFiscalProfileField) — jamais un patch
 * multi-champs. Or les invariants du domaine (domain/fiscal/fiscal-profile.ts) couplent
 * FORTEMENT legalForm/taxRegime/socialStatus : passer directement d'un couple micro-entreprise
 * à un couple SASU en 3 écritures indépendantes échoue TOUJOURS, quel que soit l'ordre choisi
 * (chaque état intermédiaire viole une règle — micro impose taxRegime=micro, SASU/SAS imposent
 * assimilé salarié, EI/micro/EURL imposent TNS). SARL est la SEULE forme sans contrainte sociale
 * (statut du gérant réellement ambigu, domaine) : ce planner l'utilise comme PIVOT NEUTRE pour
 * traverser TNS ↔ assimilé salarié en toute sécurité, et sort de/entre en régime micro dans le
 * bon sens (quitter 'micro' change TOUJOURS legalForm avant taxRegime ; y entrer fait l'inverse).
 *
 * Résultat : une SÉQUENCE de patches à un seul champ, chacun individuellement valide contre
 * l'état obtenu après les précédents — vérifié exhaustivement (49 couples) dans
 * legal-regime-correction.test.ts contre le VRAI agrégat FiscalProfile de @bob/core (pas une
 * réimplémentation des règles ici, une PLANIFICATION autour d'elles).
 *
 * TODO(Phase 1A v2) : un endpoint/use case d'écriture atomique multi-champs (confirmLegalRegime)
 * supprimerait ce contournement — noté, hors scope Phase 1B (UI seule).
 */
export interface CurrentLegalRegimeState {
  readonly legalForm: LegalForm;
  readonly taxRegime: FiscalTaxRegime;
  /** `undefined` = statut social pas encore connu (profil 'manquant', ex. SARL jamais posée). */
  readonly socialStatus: FiscalSocialStatus | undefined;
  /**
   * Versement libératoire actuel (`undefined` = 'manquant'/inconnu). REQUIS pour quitter le
   * régime micro quand il vaut `true` : le VL n'existe qu'au micro (art. 151-0 CGI, invariant
   * versement_liberatoire_requires_micro) — sans le solder d'abord, TOUTE écriture posant un
   * autre régime serait rejetée par le domaine. Optionnel (compat call-sites historiques),
   * `| undefined` explicite : les appelants passent datumValue(...) sans détour.
   */
  readonly versementLiberatoire?: boolean | undefined;
}

export function planLegalRegimeCorrection(
  current: CurrentLegalRegimeState,
  target: LegalRegimeCombo,
): readonly FiscalProfileFieldPatch[] {
  const patches: FiscalProfileFieldPatch[] = [];
  let legalForm = current.legalForm;
  let taxRegime = current.taxRegime;
  let socialStatus = current.socialStatus;

  const pushLegalForm = (value: LegalForm): void => {
    if (legalForm === value) return;
    patches.push({ field: 'legalForm', value });
    legalForm = value;
  };
  const pushTaxRegime = (value: FiscalTaxRegime): void => {
    if (taxRegime === value) return;
    patches.push({ field: 'taxRegime', value });
    taxRegime = value;
  };
  const pushSocialStatus = (value: FiscalSocialStatus): void => {
    if (socialStatus === value) return;
    patches.push({ field: 'socialStatus', value });
    socialStatus = value;
  };

  // 0) Solder le versement libératoire AVANT de quitter le régime micro : le VL n'existe qu'au
  //    micro — le laisser à `true` ferait rejeter chaque écriture ultérieure d'un régime non
  //    micro (invariant versement_liberatoire_requires_micro). `false` est toujours valide, et
  //    ce n'est pas un choix fait à la place de l'utilisateur : c'est la CONSÉQUENCE LÉGALE du
  //    changement de régime qu'il vient de demander (papa vocal : la loi le dit, Bob l'applique).
  if (current.versementLiberatoire === true && target.taxRegime !== 'micro') {
    patches.push({ field: 'versementLiberatoire', value: false });
  }

  const targetRequiredSocial = requiredSocialStatusFor(target.legalForm);
  const crossingCategory =
    targetRequiredSocial !== null &&
    socialStatus !== targetRequiredSocial &&
    socialCategoryFor(legalForm) !== 'neutral' &&
    socialCategoryFor(legalForm) !== socialCategoryFor(target.legalForm);

  // 1) Quitter 'micro' EN PREMIER si la cible n'y est pas — legalForm avant taxRegime (l'inverse
  //    échoue : « legalForm=micro » impose « taxRegime=micro », art. invariant du domaine).
  if (legalForm === 'micro' && target.legalForm !== 'micro') {
    pushLegalForm(crossingCategory ? 'SARL' : target.legalForm);
  }

  // 2) Traverser la catégorie sociale via SARL (pivot neutre) si on change de catégorie et
  //    qu'on n'y est pas déjà.
  if (crossingCategory && socialCategoryFor(legalForm) !== 'neutral') {
    pushLegalForm('SARL');
  }

  // 3) Sortir du régime micro si la cible n'y est pas, PENDANT que legalForm n'est plus 'micro'
  //    (sûr : plus aucune règle ne s'y oppose) — AVANT la bascule sociale (sinon « taxRegime
  //    micro + assimilé salarié » reste interdit un instant).
  if (taxRegime === 'micro' && target.taxRegime !== 'micro') {
    pushTaxRegime(target.taxRegime);
  }

  // 4) Bascule sociale proprement dite — sûre désormais (legalForm neutre/compatible, taxRegime
  //    n'est plus 'micro').
  const requiredNow = requiredSocialStatusFor(legalForm);
  if (requiredNow !== null && socialStatus !== requiredNow) {
    pushSocialStatus(requiredNow);
  } else if (
    targetRequiredSocial !== null &&
    socialStatus !== targetRequiredSocial &&
    socialCategoryFor(legalForm) === 'neutral'
  ) {
    pushSocialStatus(targetRequiredSocial);
  }

  // 5) Poser les valeurs finales — entrer en micro fait taxRegime AVANT legalForm (miroir de
  //    l'étape 1) ; sinon taxRegime puis legalForm (ordre sans incidence hors micro).
  if (target.legalForm === 'micro') {
    pushTaxRegime('micro');
    pushLegalForm('micro');
  } else {
    pushTaxRegime(target.taxRegime);
    pushLegalForm(target.legalForm);
  }

  return patches;
}
