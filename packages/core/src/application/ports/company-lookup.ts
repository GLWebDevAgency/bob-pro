import { type LegalForm, type Trade } from '../../domain/company/company';
import { type Address } from '../../shared-kernel/contact';

/** Profil entreprise renvoyé par une recherche SIRET (sources Open Data FR). */
export interface CompanyLookupResult {
  siren: string;
  siret: string;
  denomination: string;
  nafApe: string | null;
  /** Métier déduit du code NAF/APE (null si non mappé — l'utilisateur choisit). */
  trade: Trade | null;
  /** Code catégorie juridique INSEE brut (ex. « 5710 ») — null si absent de la source. */
  natureJuridiqueCode: string | null;
  /** Forme juridique Bob Pro déduite du code INSEE (null si non mappée — l'utilisateur choisit). */
  legalForm: LegalForm | null;
  /** Date de création de l'entreprise (ISO yyyy-mm-dd) — null si absente de la source. */
  dateCreation: string | null;
  address: Address | null;
  /** N° TVA intracom (renvoyé par l'API ou dérivé du SIREN). */
  tvaIntracom: string | null;
  /** Qualification RGE active (utile Pack BTP). */
  rge: boolean;
}

/**
 * Port de recherche d'entreprise par SIRET.
 * L'adapter de production interroge une source officielle et renvoie `null` si elle ne répond
 * pas : le domaine ne fabrique jamais une entreprise de remplacement.
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
