/**
 * Assainit une donnée RELUE EN BASE avant qu'elle n'entre dans une parole canonique.
 *
 * POURQUOI CE MODULE EXISTE. Une parole de Bob n'est pas un cul-de-sac : elle est poussée dans
 * l'historique du tour suivant, et le planner REJETTE tout l'historique — donc TOUTES les lanes,
 * devis compris — dès qu'un tour porte un caractère invisible ou dépasse sa borne. Un seul nom de
 * client contenant une espace de largeur nulle suffirait alors à rendre l'assistant vocal muet
 * pendant plusieurs tours, sans que rien ne désigne la fiche fautive.
 *
 * Le nom relu en base n'est PAS une donnée de confiance : il vient d'une saisie humaine ou d'un
 * import, et le validateur de création ne refuse que les contrôles ASCII — U+200B et ses voisins
 * passent, se stockent, et ressortent ici.
 *
 * CE QUE LA SORTIE GARANTIT (et que le test de frontière de `@bob/ai` prouve contre le planner) :
 * aucun caractère interdit, une seule espace ordinaire entre les mots, ni tête ni queue vide, et
 * une longueur bornée. Autrement dit : un point fixe de la canonicalisation du planner.
 *
 * RENDRE `null` EST UN SIGNAL, PAS UN REPLI. Une valeur qui ne laisse rien après assainissement
 * est une dérive de la base : l'appelant doit refuser son jeu de données, jamais lui substituer un
 * libellé de remplacement — nommer une fiche autrement que par son nom serait mentir à l'oreille.
 */

/**
 * Invisibles NON couverts par les contrôles ASCII : espaces de largeur nulle, marques de
 * direction, isolants bidirectionnels et BOM. Miroir de la garde du planner (`hasDisallowedCharacter`).
 */
const INVISIBLE_CHARACTERS = /[\u200b-\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]/gu;

/** Contrôles ASCII C0 et DEL — mêmes points de code que `hasAsciiControlCharacter`. */
// eslint-disable-next-line no-control-regex
const ASCII_CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/gu;

/** Marqueur de troncature : la parole doit S'ENTENDRE incomplète, jamais faire croire au nom entier. */
const TRUNCATION_MARK = '…';

/**
 * @param maximumLength borne en POINTS DE CODE (jamais en unités UTF-16 : couper une paire de
 *   substitution fabriquerait un caractère de remplacement au milieu d'un nom propre).
 */
export function sanitizeSpokenLabel(value: string, maximumLength: number): string | null {
  if (maximumLength < 1) return null;
  const stripped = value.replace(ASCII_CONTROL_CHARACTERS, '').replace(INVISIBLE_CHARACTERS, '');
  // `\s` Unicode : couvre l'insécable, l'espace fine insécable et les séparateurs de ligne, que
  // le planner écrase lui aussi — sans quoi la parole ne serait pas un point fixe de sa règle.
  const collapsed = stripped.replace(/\s+/gu, ' ').trim();
  if (collapsed.length === 0) return null;
  const points = Array.from(collapsed);
  if (points.length <= maximumLength) return collapsed;
  // Le marqueur occupe une place DANS la borne : la sortie ne dépasse jamais ce qui a été promis.
  const kept = points.slice(0, Math.max(1, maximumLength - 1)).join('').trimEnd();
  return kept.length === 0 ? null : `${kept}${TRUNCATION_MARK}`;
}
