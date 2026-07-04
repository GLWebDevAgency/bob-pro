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
  | 'diagnostic' // « prêt pour 2026 ? » — ouvrir le diagnostic conformité (C40, TODO ⑦)
  | 'echeances' // échéances fiscales à venir (TVA/URSSAF/IS/CFE) — lecture, C-EXP5b
  | 'tva' // position de TVA réelle (collectée/déductible/à provisionner) — lecture, BOB-1
  | 'balance' // balance âgée : qui me doit quoi, depuis quand — lecture, BOB-1
  | 'payer_depense' // régler une dépense fournisseur (écriture 401/512) — mutation, BOB-1/E4
  | 'resultat' // résultat provisoire (produits − charges du grand-livre) — lecture, BOB-2
  | 'unknown';

/** Détection d'intention déterministe (fallback hors-ligne / LLM indisponible / intention triviale). */
export function detectIntent(message: string): BobIntent {
  const m = message.toLowerCase();
  // BOB-1 : régler une DÉPENSE/FOURNISSEUR — AVANT « encaisser » (« règle », « payé » collisionnent).
  if (/(pa[iy]e[rz]?|r[èe]gle[rz]?|solde[rz]?).*(d[ée]pense|fournisseur)|(d[ée]pense|fournisseur).*(pay[ée]|r[ée]gl)/.test(m))
    return 'payer_depense';
  // « payé(e/s) » = participe (paiement reçu) ; « payer/verser » = se verser (payout) — d'où la distinction.
  if (/(encaiss|paiement re[çc]u|re[çc]u le paiement|marque.*pay|r[ée]gl[ée]|\bpay[ée]e?s?\b)/.test(m)) return 'encaisser';
  if (/(cl[ôo]tur|pr[ée]pare?.*(le |mon )?mois|boucle.*mois|pour le comptable|bilan du mois)/.test(m)) return 'cloture';
  // « prêt(e/s) pour 2026 ? » (chip C15) / diagnostic conformité -> ouvrir l'écran diagnostic (C40 ⑦).
  if (/(diagnostic|pr[êe]te?s? pour 2026|conformit[ée].*(2026|facturation [ée]lectronique))/.test(m)) return 'diagnostic';
  // Échéances fiscales (C-EXP5b) : AVANT scan/documents (« déclaration », « impôts » ≠ pièces à classer).
  if (/([ée]ch[ée]anc|calendrier fiscal|urssaf|\bcfe\b|\bca3\b|\bca12\b|liasse|d[ée]clar.*(tva|urssaf|imp[ôo]t)|imp[ôo]ts? [àa] (venir|payer))/.test(m))
    return 'echeances';
  // Position de TVA (BOB-1) : AVANT payout (« combien » y appartient aussi).
  if (/(tva.*(dois|due|d[ûu]e|provision|position|net|combien)|combien.*tva|ma tva|position de tva|cr[ée]dit de tva)/.test(m))
    return 'tva';
  // Balance âgée (BOB-1) : AVANT relance (« en retard » y collisionne).
  if (/(qui me doit|balance [âa]g[ée]e|encours clients?|retards? clients?|me doivent|doit de l'argent)/.test(m))
    return 'balance';
  // Résultat provisoire (BOB-2) : AVANT payout (« combien je gagne » ≠ « me verser »).
  if (/(r[ée]sultat|b[ée]n[ée]fice|combien je gagne|je gagne combien|en perte|balance g[ée]n[ée]rale)/.test(m))
    return 'resultat';
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
