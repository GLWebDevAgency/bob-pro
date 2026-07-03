import { type Trade } from '../../domain/company/company';
import { type Address } from '../../shared-kernel/contact';

/** Profil entreprise renvoyé par une recherche SIRET (sources Open Data FR). */
export interface CompanyLookupResult {
  siren: string;
  siret: string;
  denomination: string;
  nafApe: string | null;
  /** Métier déduit du code NAF/APE (null si non mappé — l'utilisateur choisit). */
  trade: Trade | null;
  address: Address | null;
  /** N° TVA intracom (renvoyé par l'API ou dérivé du SIREN). */
  tvaIntracom: string | null;
  /** Qualification RGE active (utile Pack BTP). */
  rge: boolean;
}

/**
 * Port de recherche d'entreprise par SIRET.
 * Adapter réel = API Recherche d'entreprises (gratuite, sans clé) ; adapter demo = déterministe.
 */
export interface CompanyLookupPort {
  lookupBySiret(siret: string): Promise<CompanyLookupResult | null>;
  /**
   * #6 (excellence OCR) — vérifie qu'un SIREN existe à l'annuaire.
   * true/false = réponse de l'annuaire · null = service indisponible (ne rien décider).
   * Optionnelle : les adapters qui ne la fournissent pas ne bloquent rien.
   */
  verifySiren?(siren: string): Promise<boolean | null>;
}
