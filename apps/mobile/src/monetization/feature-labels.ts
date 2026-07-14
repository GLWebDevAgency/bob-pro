import type { Feature } from '@bob/core';

/**
 * Libellés FR lisibles des capacités (Feature @bob/core) — LE mapping partagé des surfaces de
 * monétisation : diff « tu gagnes / tu perds » du changement d'offre (compte.tsx), et demain le
 * bilan de fin d'essai et les paywalls unifiés. Jamais un identifiant technique brut à l'écran.
 *
 * Record EXHAUSTIF (`satisfies Record<Feature, string>`) : ajouter une Feature au catalogue
 * sans libellé casse la compilation ici — impossible d'afficher un diff troué en silence.
 * Les formulations restent factuelles (doctrine SPEC pilier 2 : du concret, pas du marketing).
 */
export const FEATURE_LABELS = {
  ai_quota: 'Bob en découverte (quota mensuel d’actions)',
  ai_assistant: 'Bob, l’assistant IA',
  voice_live: 'Bob Live — conversation vocale en temps réel',
  bob_essentials: 'Bob réactif : aide, recherche, brouillons',
  bob_operations: 'Bob proactif : relances, trésorerie, routines',
  bob_control: 'Bob gouverné : supervision et audit d’équipe',
  einvoice_emission: 'Facturation électronique (émission)',
  ocr: 'Scan des dépenses (OCR)',
  accounting_foundation: 'Socle comptable (écritures vérifiables)',
  accounting_operations: 'Pré-compta : TVA, rapprochement, export cabinet',
  accounting_control: 'Contrôle comptable : rôles et audit exportable',
  cashflow_forecast: 'Trésorerie prévisionnelle',
  auto_dunning: 'Relances automatiques rédigées par Bob',
  online_payment: 'Paiement en ligne des factures',
  invoice_advance: 'Avance sur facture (partenaire)',
  team: 'Équipe & rôles',
  priority_support: 'Support prioritaire',
  insurance: 'Assurance pro (partenaire)',
} as const satisfies Record<Feature, string>;

/** Libellé FR d'une capacité — l'accès indexé typé, pour les appels ponctuels. */
export function featureLabel(feature: Feature): string {
  return FEATURE_LABELS[feature];
}
