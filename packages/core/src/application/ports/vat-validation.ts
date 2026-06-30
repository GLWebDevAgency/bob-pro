/** Statut d'un n° TVA intracom : confirmé valide, confirmé invalide, ou non vérifiable (service indispo). */
export type VatStatus = 'valid' | 'invalid' | 'unverified';

export interface VatCheckOutcome {
  status: VatStatus;
  name: string | null;
  /** Numéro de consultation VIES (preuve à archiver ~7 ans) — null si requête non authentifiée. */
  consultationNumber: string | null;
}

export interface VatCheckResult extends VatCheckOutcome {
  vatNumber: string;
  checkedAt: string; // DateOnly
}

/**
 * Port de validation d'un n° TVA intracommunautaire (VIES).
 * IMPORTANT : l'adapter NE DOIT JAMAIS lever — en cas d'indisponibilité amont, renvoyer 'unverified'
 * (on ne bloque jamais une facturation sur un VIES KO).
 */
export interface VatValidationPort {
  check(vatNumber: string): Promise<VatCheckOutcome>;
}
