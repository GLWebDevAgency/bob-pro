import { type WorksiteTerminology } from '@bob/core';

/**
 * Paramètres d'interpolation i18n dérivés de tradeToWorksiteTerminology (@bob/core) — SOURCE
 * UNIQUE de l'accord grammatical du regroupement chantier/projet dans toute l'app mobile
 * (namespaces chantiers.* / chantierFiche.* / fiche.chantier* de @bob/i18n). Un plombier voit
 * « chantier » partout, un freelance IT « mission », un consultant/coach/défaut « projet » —
 * zéro texte figé, zéro second mapping concurrent.
 */
export type WorksiteParams = {
  /** Singulier, minuscule — « chantier »/« mission »/« projet ». */
  readonly term: string;
  /** Singulier, majuscule initiale — début de phrase. */
  readonly termCap: string;
  /** Pluriel, minuscule. */
  readonly plural: string;
  /** Pluriel, majuscule initiale — titres d'onglet/section. */
  readonly pluralCap: string;
  /** Article indéfini — « un »/« une ». */
  readonly article: string;
  /** Contraction « de » + article défini — « du »/« de la » (aucun des noms gérés ne s'élide). */
  readonly de: string;
  /** Adjectif « nouveau », accordé — « Nouveau »/« Nouvelle ». */
  readonly newAdj: string;
  /** Démonstratif, accordé — « ce »/« cette ». */
  readonly demonstrative: string;
  /** Article défini, majuscule initiale — début de phrase (« Le »/« La »). */
  readonly articleDefCap: string;
  /** Adjectif « premier », accordé — « premier »/« première ». */
  readonly premierAdj: string;
  /** Participe passé de « créer », accordé (voix passive « a été {createdAdj} ») — « créé »/« créée ». */
  readonly createdAdj: string;
  /** « Aucun »/« Aucune » — accordé, PAS invariable (contrairement à « Aucun {plural} » qui esquive
   * l'accord en restant idiomatique au pluriel). Nécessaire dès que « Aucun » précède {term}. */
  readonly aucunAdj: string;
};

/** Repli neutre tant que le profil métier n'est pas chargé — vocabulaire BTP par défaut (le plus
 * courant), jamais un flash de texte anglais/vide. Remplacé dès profile.data prêt. */
export const DEFAULT_WORKSITE_TERM: WorksiteTerminology = {
  singular: 'chantier',
  plural: 'chantiers',
  gender: 'm',
  article: { indefinite: 'un', definite: 'le' },
};

function capitalize(word: string): string {
  return word.length === 0 ? word : word[0]!.toUpperCase() + word.slice(1);
}

export function worksiteParamsFor(terminology: WorksiteTerminology): WorksiteParams {
  const feminine = terminology.gender === 'f';
  return {
    term: terminology.singular,
    termCap: capitalize(terminology.singular),
    plural: terminology.plural,
    pluralCap: capitalize(terminology.plural),
    article: terminology.article.indefinite,
    de: feminine ? 'de la' : 'du',
    newAdj: feminine ? 'Nouvelle' : 'Nouveau',
    demonstrative: feminine ? 'cette' : 'ce',
    articleDefCap: capitalize(terminology.article.definite),
    premierAdj: feminine ? 'première' : 'premier',
    createdAdj: feminine ? 'créée' : 'créé',
    aucunAdj: feminine ? 'Aucune' : 'Aucun',
  };
}
