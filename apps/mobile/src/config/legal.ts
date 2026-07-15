/**
 * Mentions légales in-app (audit stores 20260716, bloquants #2/#4) — CONFIG CENTRALISÉE.
 *
 * PLACEHOLDERS assumés : le domaine bobpro.fr n'est pas encore réservé (D2 du programme V1,
 * bloqué fondateur — cf. design_handoff_bob_pro/PROGRAMME_V1_PUBLICATION.md). Ces URLs pointent
 * vers un sous-domaine de démonstration EN ATTENDANT le domaine définitif : à remplacer ICI
 * (un seul point de mise à jour) dès que les pages légales réelles sont hébergées — aucun autre
 * fichier ne doit jamais coder une URL/adresse légale en dur.
 */
export const LEGAL_URLS = {
  terms: 'https://demo.bobpro.fr/legal/cgu',
  privacy: 'https://demo.bobpro.fr/legal/confidentialite',
} as const;

/** Adresse support/contact — même placeholder tant que bonjour@bobpro.fr n'est pas actif (D2). */
export const SUPPORT_EMAIL = 'bonjour@bobpro.fr';

export const SUPPORT_MAILTO = `mailto:${SUPPORT_EMAIL}`;
