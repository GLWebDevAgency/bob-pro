import type { FiscalSocialStatus, FiscalTaxRegime, LegalForm } from '@bob/core';

/**
 * Combinaisons forme + régime OFFERTES par le mini-flow (SPEC_EXPERT_FISCAL §UX FLOW, amendement
 * GPT 3 : « d'abord confirmer le couple forme+régime dérivé »). Fermé volontairement à 7 entrées
 * réalistes (V1 micro/EI/EURL/SASU/SARL/SAS) — capital/CCA/EURL-IS-associés-multiples restent
 * HORS V1 (scénario dividendes plus tard, §V2 pt. 8).
 */
export interface LegalRegimeCombo {
  readonly id: string;
  readonly legalForm: LegalForm;
  readonly taxRegime: FiscalTaxRegime;
}

export const LEGAL_REGIME_COMBOS: readonly LegalRegimeCombo[] = [
  { id: 'micro', legalForm: 'micro', taxRegime: 'micro' },
  { id: 'ei_reel', legalForm: 'EI', taxRegime: 'reel_ir' },
  { id: 'eurl_ir', legalForm: 'EURL', taxRegime: 'reel_ir' },
  { id: 'eurl_is', legalForm: 'EURL', taxRegime: 'is' },
  { id: 'sasu', legalForm: 'SASU', taxRegime: 'is' },
  { id: 'sarl', legalForm: 'SARL', taxRegime: 'is' },
  { id: 'sas', legalForm: 'SAS', taxRegime: 'is' },
];

export function findLegalRegimeCombo(legalForm?: LegalForm, taxRegime?: FiscalTaxRegime): LegalRegimeCombo | undefined {
  return LEGAL_REGIME_COMBOS.find((c) => c.legalForm === legalForm && c.taxRegime === taxRegime);
}

/**
 * Catégorie sociale d'une forme juridique (domain/fiscal/fiscal-profile.ts invariants) :
 * · 'tns' — EI, micro, EURL (gérant associé unique) : TOUJOURS TNS, jamais assimilé salarié.
 * · 'assimile' — SASU, SAS : TOUJOURS assimilé salarié, jamais TNS.
 * · 'neutral' — SARL : ambigu (gérant majoritaire = TNS, minoritaire = assimilé), le domaine
 *   n'impose AUCUNE contrainte — c'est le seul pivot sûr pour traverser les deux catégories
 *   (voir legal-regime-correction.ts).
 */
export type SocialCategory = 'tns' | 'assimile' | 'neutral';

export function socialCategoryFor(legalForm: LegalForm): SocialCategory {
  if (legalForm === 'SASU' || legalForm === 'SAS') return 'assimile';
  if (legalForm === 'SARL') return 'neutral';
  return 'tns'; // EI, micro, EURL
}

/** Statut social qu'IMPOSE une forme juridique — `null` pour SARL (aucune contrainte, indérivable). */
export function requiredSocialStatusFor(legalForm: LegalForm): FiscalSocialStatus | null {
  const category = socialCategoryFor(legalForm);
  if (category === 'tns') return 'tns';
  if (category === 'assimile') return 'assimile_salarie';
  return null;
}
