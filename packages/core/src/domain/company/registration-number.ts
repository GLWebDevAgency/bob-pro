import { Siret } from '../../shared-kernel/identifiers';
import { type LegalForm } from './company';

/**
 * Numéro d'immatriculation (RCS / RM) — RÈGLE LÉGALE, donc DOMAINE (jamais de l'UI).
 *
 * L'art. R123-237 du code de commerce impose sur les factures et documents commerciaux « le
 * numéro unique d'identification de l'entreprise suivi de la mention RCS et du nom de la ville
 * où se trouve le greffe où elle est immatriculée ». C'est cette mention que `Company.assertCanIssue()`
 * exige (`rcsOrRm` non vide) avant toute émission — et c'est elle qui manquait en base pour les
 * sociétés dont le provisioning SIRET ne l'a pas fournie.
 *
 * DOCTRINE « hypothèse de Bob, à confirmer » (identique au profil fiscal) : cette fonction
 * PROPOSE, elle ne pose JAMAIS. Deux limites assumées, portées par le type lui-même :
 *  1. `greffeCityAssumed` — la ville du GREFFE n'est pas toujours celle du SIÈGE (siège en
 *     petite commune → greffe du tribunal de commerce de rattachement ; ressorts fusionnés…).
 *     La valeur proposée dérive du siège : elle DOIT être confirmée sur l'extrait Kbis.
 *  2. Répertoire des métiers (artisan, EI/micro) : le n° RM ne se DÉDUIT PAS du SIREN (il
 *     dépend de la chambre de métiers et du département d'immatriculation). Fail-closed :
 *     `value` reste `null`, seul le FORMAT est proposé — jamais un numéro inventé.
 */
export interface RegistrationNumberSuggestion {
  /** Registre visé par la forme juridique : RCS (société commerciale) ou RM (artisan). */
  readonly registry: 'rcs' | 'rm';
  /**
   * Valeur pré-remplie proposée à la CONFIRMATION de l'utilisateur, ou `null` quand aucune
   * valeur ne peut être dérivée honnêtement (ville du siège inconnue, registre RM).
   * `null` n'est pas une erreur : c'est le refus d'inventer.
   */
  readonly value: string | null;
  /** Gabarit affichable pour guider la saisie (placeholder de champ) — jamais une valeur. */
  readonly placeholder: string;
  /** `true` = la ville de la proposition vient du SIÈGE, pas du greffe : à vérifier sur le Kbis. */
  readonly greffeCityAssumed: boolean;
}

/** Formes immatriculées au RCS (sociétés commerciales). Miroir de CAPITAL_LEGAL_FORMS
 *  (company.ts) : les mêmes formes portent capital social ET immatriculation RCS. */
const RCS_LEGAL_FORMS: ReadonlySet<LegalForm> = new Set(['EURL', 'SASU', 'SARL', 'SAS']);

/** « 732829320 » → « 732 829 320 » (présentation conventionnelle du SIREN sur les pièces). */
function formatSirenGroups(siren: string): string {
  return `${siren.slice(0, 3)} ${siren.slice(3, 6)} ${siren.slice(6, 9)}`;
}

/**
 * Casse « greffe » lisible à partir d'une ville d'annuaire souvent en capitales (« PARIS »,
 * « SAINT-ÉTIENNE »). Chaque segment séparé par une espace ou un trait d'union est capitalisé.
 * Volontairement SANS traitement des particules (« les », « sur »…) : une règle typographique
 * approximative appliquée en silence serait pire que la capitale — et de toute façon la valeur
 * est soumise à confirmation. `toLocaleUpperCase('fr')` conserve les accents (É, Ï…).
 */
function toGreffeCityCase(city: string): string {
  return city
    .toLocaleLowerCase('fr')
    .replace(/(^|[\s-])([\p{L}])/gu, (_m, sep: string, first: string) =>
      `${sep}${first.toLocaleUpperCase('fr')}`,
    );
}

export interface SuggestRegistrationNumberInput {
  readonly legalForm: LegalForm;
  /** SIRET du siège — les 9 premiers chiffres portent le SIREN (validé Luhn ici). */
  readonly siret: string;
  /** Ville du SIÈGE (address.city). Vide/absente = aucune ville proposée. */
  readonly city: string | null | undefined;
}

/**
 * Propose — sans jamais poser — le numéro d'immatriculation d'une entreprise.
 * Rend `null` quand le SIRET est structurellement invalide : sans SIREN sûr, il n'y a
 * rien d'honnête à proposer (jamais un préfixe tronqué au hasard).
 */
export function suggestRegistrationNumber(
  input: SuggestRegistrationNumberInput,
): RegistrationNumberSuggestion | null {
  const siret = Siret.of(input.siret);
  if (!siret.ok) return null;
  const siren = formatSirenGroups(siret.value.siren().value);

  if (!RCS_LEGAL_FORMS.has(input.legalForm)) {
    // Artisan au répertoire des métiers : format seulement, aucune valeur dérivable.
    return {
      registry: 'rm',
      value: null,
      placeholder: `${siren} RM 75`,
      greffeCityAssumed: false,
    };
  }

  const city = (input.city ?? '').trim();
  if (city.length === 0) {
    // Société commerciale sans ville de siège connue : le registre est certain, la ville non.
    return {
      registry: 'rcs',
      value: null,
      placeholder: `${siren} RCS Paris`,
      greffeCityAssumed: false,
    };
  }
  return {
    registry: 'rcs',
    value: `${siren} RCS ${toGreffeCityCase(city)}`,
    placeholder: `${siren} RCS Paris`,
    greffeCityAssumed: true,
  };
}
