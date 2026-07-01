export type BobIntent =
  | 'payout'
  | 'relance'
  | 'encaisser'
  | 'factures'
  | 'envoyer_devis'
  | 'emettre_facture'
  | 'documents'
  | 'scan' // numériser un reçu/ticket/justificatif (ouvre l'OCR caméra)
  | 'nouveau_devis' // ouvrir l'écran de création de devis
  | 'voir_chantiers' // ouvrir les chantiers
  | 'cloture' // préparer le mois pour le comptable (ouvre l'écran de clôture)
  | 'unknown';

/** Détection d'intention déterministe (fallback hors-ligne / LLM indisponible / intention triviale). */
export function detectIntent(message: string): BobIntent {
  const m = message.toLowerCase();
  // « payé(e/s) » = participe (paiement reçu) ; « payer/verser » = se verser (payout) — d'où la distinction.
  if (/(encaiss|paiement re[çc]u|re[çc]u le paiement|marque.*pay|r[ée]gl[ée]|\bpay[ée]e?s?\b)/.test(m)) return 'encaisser';
  if (/(cl[ôo]tur|pr[ée]pare?.*(le |mon )?mois|boucle.*mois|pour le comptable|bilan du mois)/.test(m)) return 'cloture';
  if (/(scan|num[ée]ris|ticket|justificatif|note de frais|re[çc]u|photo.*(facture|ticket|d[ée]pense))/.test(m)) return 'scan';
  if (/(envoi|envoie|envoyer|transmets|exp[ée]die).*(devis)|devis.*(client|signature|envoi|envoyer|transmettre)/.test(m))
    return 'envoyer_devis';
  if (/([ée]met|emet|num[ée]rote|finalise|publie).*(facture)|facture.*([ée]mettre|emettre|d[ée]finitive|num[ée]ro)/.test(m))
    return 'emettre_facture';
  if (/(nouveau devis|fais.*devis|cr[ée]e?r?.*devis|faire un devis|un devis|chiffrer)/.test(m)) return 'nouveau_devis';
  if (/chantier/.test(m)) return 'voir_chantiers';
  if (/(document|pi[èe]ce|archive|pdf|factur-?x|justificatif|re[çc]u|ticket)/.test(m)) return 'documents';
  if (/(liste|mes factures|factures impay|reste (à|a) encaisser|à encaisser)/.test(m)) return 'factures';
  if (/(relanc|rappel|en retard|impay)/.test(m)) return 'relance';
  if (/(verser|me paye|me payer|combien|salaire)/.test(m)) return 'payout';
  return 'unknown';
}

/** Extrait une référence de facture (numéro type 2026-014) du message, sinon null. */
export function extractReference(message: string): string | null {
  const num = message.match(/\d{3,}(?:-\d+)?/);
  return num ? num[0] : null;
}
