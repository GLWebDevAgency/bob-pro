export interface Totals {
  ht: number; // centimes — HT NET (après remises de ligne et remise globale, B3)
  vatByRate: Record<string, number>; // cle = taux ("10"), valeur = TVA en centimes
  vat: number;
  ttc: number;
  /** Montant à régler immédiatement dans l'UX. Une retenue de garantie peut le rendre inférieur
   * à la créance légale, sans jamais diminuer cette dernière ni simuler un paiement. */
  netToPay: number;
  /** Créance légale totale de CETTE pièce (BT-115). Absent sur les snapshots historiques :
   * `netToPay` reste alors le fallback de lecture, mais tout nouvel émetteur la fige. */
  duePayableCents?: number;
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
