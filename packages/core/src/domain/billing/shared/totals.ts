export interface Totals {
  ht: number; // centimes
  vatByRate: Record<string, number>; // cle = taux ("10"), valeur = TVA en centimes
  vat: number;
  ttc: number;
  netToPay: number; // = ttc, ou acompte si depositPct
}
