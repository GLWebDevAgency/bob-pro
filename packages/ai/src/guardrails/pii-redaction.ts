/**
 * Minimisation PII avant envoi à un LLM cloud (RGPD/CNIL : minimisation + finalité). Masque le PII
 * INCIDENT que le classifieur d'intention n'utilise jamais : email, téléphone, IBAN, SIREN/SIRET.
 *
 * NE touche PAS aux numéros de facture/devis ni aux noms de client : ce sont la *référence* de la
 * commande, résolue par resolveInvoice / le batch — les masquer casserait la résolution. C'est de la
 * minimisation (retirer le non-nécessaire), pas de l'anonymisation totale.
 *
 * Pur, déterministe, IDEMPOTENT (les placeholders ne contiennent aucun motif PII).
 */

// Ordre d'application important : IBAN (lettres+chiffres) et email avant les motifs purement numériques.
// `\s` couvre les espaces fines/insécables (U+202F, U+00A0) — on évite tout caractère invisible en source.
const EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const IBAN = /\b[A-Z]{2}\d{2}(?:\s?[A-Z0-9]){10,30}\b/g;
// Téléphone FR : 0X ou +33, 10 chiffres, séparateurs optionnels (espace, point, tiret).
const PHONE_FR = /(?:\+33|0)[\s.-]?[1-9](?:[\s.-]?\d{2}){4}\b/g;
// SIREN (9 chiffres) / SIRET (14) : suite de chiffres bornée — n'attrape pas « 2026-014 » (césure) ni un montant.
const SIREN_SIRET = /\b\d{9}(?:\d{5})?\b/g;

/** Remplace le PII incident par des marqueurs typés, en préservant les références métier. */
export function redactPII(text: string): string {
  if (!text) return text;
  return text
    .replace(EMAIL, '[email]')
    .replace(IBAN, '[iban]')
    .replace(PHONE_FR, '[tel]')
    .replace(SIREN_SIRET, '[siren]');
}
