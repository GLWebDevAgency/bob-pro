export interface Totals {
  ht: number; // centimes — HT NET (après remises de ligne et remise globale, B3)
  vatByRate: Record<string, number>; // cle = taux ("10"), valeur = TVA en centimes
  vat: number;
  ttc: number;
  netToPay: number; // = ttc, ou acompte si depositPct, ou solde/situation après déductions
  /**
   * B3 — présents UNIQUEMENT quand une remise existe (les totaux des pièces antérieures restent
   * identiques au centime, snapshots figés compris) : HT brut avant remises et total remisé.
   */
  grossHt?: number;
  discountCents?: number;
  /**
   * B5 — retenue de garantie (loi n° 71-584 du 16 juillet 1971) déduite du net à payer d'une
   * situation ou d'une facture finale de marché privé de travaux. Présente UNIQUEMENT quand la
   * retenue s'applique — figée avec les totaux à l'émission ; la restitution (réception + 1 an)
   * est une créance SUIVIE (deriveRetenueGarantieSuivi), jamais une pièce fiscale nouvelle.
   */
  retenueGarantieCents?: number;
}
