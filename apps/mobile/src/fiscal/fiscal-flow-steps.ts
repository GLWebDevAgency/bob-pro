import { datumValue, type FiscalProfileView } from '@bob/core';

/**
 * ORDRE DYNAMIQUE du mini-flow (SPEC_EXPERT_FISCAL §UX FLOW, amendement GPT 3 & 4) : calculé
 * depuis le profil RÉEL du tenant à chaque rendu — jamais une séquence fixe. Un champ déjà
 * confirmé par l'utilisateur (statut 'confirme_utilisateur') ne repasse JAMAIS dans la file —
 * la progression « encore N infos » (amendement 4) se lit directement depuis la longueur du
 * tableau retourné, honnête par construction (pas un compteur maintenu à part).
 */
export type FiscalFlowStepId = 'legal_regime' | 'activity' | 'acre' | 'versement_liberatoire' | 'vat';

function isConfirmed(status: { readonly status: string }): boolean {
  return status.status === 'confirme_utilisateur';
}

/**
 * Étapes restantes, DANS L'ORDRE : couple forme+régime → activité (AVANT ACRE) → ACRE (avec date
 * si accordée) → versement libératoire (SEULEMENT au régime micro — jamais posé sinon, art.
 * 151-0 CGI) → TVA (SEULEMENT si totalement inconnue : le régime micro pose déjà une hypothèse
 * franchise, elle n'entre donc pas ici tant qu'elle n'est pas contestée par ailleurs).
 */
export function computeFiscalFlowSteps(profile: FiscalProfileView): readonly FiscalFlowStepId[] {
  const steps: FiscalFlowStepId[] = [];

  if (!isConfirmed(profile.legalForm) || !isConfirmed(profile.taxRegime)) {
    steps.push('legal_regime');
  }
  if (!isConfirmed(profile.activityNature)) {
    steps.push('activity');
  }
  if (!isConfirmed(profile.acre)) {
    steps.push('acre');
  }
  if (datumValue(profile.taxRegime) === 'micro' && !isConfirmed(profile.versementLiberatoire)) {
    steps.push('versement_liberatoire');
  }
  if (profile.vatRegime.status === 'manquant') {
    steps.push('vat');
  }

  return steps;
}

export function fiscalFlowRemainingCount(profile: FiscalProfileView | undefined): number {
  return profile ? computeFiscalFlowSteps(profile).length : 0;
}

export function hasFiscalFlowPending(profile: FiscalProfileView | undefined): boolean {
  return fiscalFlowRemainingCount(profile) > 0;
}
