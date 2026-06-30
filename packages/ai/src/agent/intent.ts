export type BobIntent = 'payout' | 'relance' | 'encaisser' | 'factures' | 'unknown';

/** Détection d'intention déterministe (fallback hors-ligne / LLM indisponible / intention triviale). */
export function detectIntent(message: string): BobIntent {
  const m = message.toLowerCase();
  // « payé(e/s) » = participe (paiement reçu) ; « payer/verser » = se verser (payout) — d'où la distinction.
  if (/(encaiss|paiement re[çc]u|re[çc]u le paiement|marque.*pay|r[ée]gl[ée]|\bpay[ée]e?s?\b)/.test(m)) return 'encaisser';
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
