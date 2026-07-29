import { type LegalForm, type Trade } from '../../domain/company/company';
import { type Address } from '../../shared-kernel/contact';

/** Profil entreprise renvoyé par une recherche SIRET (sources Open Data FR). */
export interface CompanyLookupResult {
  siren: string;
  /**
   * SIRET de l'établissement RÉELLEMENT demandé — siège OU établissement secondaire.
   * Jamais un repli sur le siège : l'appelant a saisi un établissement précis, on lui rend
   * celui-là ou rien.
   */
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
  /**
   * Adresse de l'ÉTABLISSEMENT identifié par `siret`, jamais celle du siège par défaut :
   * facturer un établissement secondaire à l'adresse du siège est une erreur d'adressage.
   * `null` = la source ne publie pas d'adresse pour CET établissement (on le dit, on ne
   * sert pas celle du siège en la faisant passer pour la bonne).
   */
  address: Address | null;
  /** N° TVA intracom réellement renvoyé par la source ; null si elle ne le fournit pas. */
  tvaIntracom: string | null;
  /**
   * État administratif de l'établissement retenu, tel que l'annuaire le déclare :
   * 'A' = actif · 'C' = fermé (cessé) · null = la source ne le dit pas.
   *
   * On le REMONTE au lieu de refuser l'établissement : un établissement fermé reste
   * légitimement facturable (facture finale, avoir, litige) et le refuser serait
   * indiscernable d'un « introuvable ». En contrepartie, l'appelant DOIT avertir avant
   * d'enregistrer un client sur un établissement 'C' — un fermé présenté comme valide
   * serait un piège comptable.
   */
  etatAdministratif: 'A' | 'C' | null;
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
