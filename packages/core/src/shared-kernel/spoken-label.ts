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
 * une longueur bornée EN UNITÉS UTF-16 — l'unité que le planner mesure. Autrement dit : un point
 * fixe de la canonicalisation du planner, y compris pour un nom d'emoji.
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

/** Marqueur d'élision : la parole doit S'ENTENDRE incomplète, jamais faire croire au nom entier. */
const TRUNCATION_MARK = '…';

/**
 * @param maximumLength borne en UNITÉS UTF-16 — l'unité dans laquelle la chaîne sera MESURÉE en
 *   aval (`String.prototype.length`, ce que compte le planner). Compter en points de code ici
 *   paraissait plus juste et ne l'était pas : un nom d'emoji tient 160 points de code mais pèse
 *   320 unités, et la parole assemblée franchissait la borne du planner — rendant l'assistant muet
 *   sur TOUTES les lanes, exactement le défaut que cette fonction existe pour empêcher. La borne
 *   doit se compter dans l'unité de celui qui la fait respecter.
 *
 *   Le DÉCOUPAGE, lui, reste fait par points de code : c'est la seule façon de ne jamais couper une
 *   paire de substitution en deux moitiés, qui fabriqueraient un caractère de remplacement au
 *   milieu d'un nom propre. Les deux comptages coexistent, chacun là où il est juste.
 */
export function sanitizeSpokenLabel(value: string, maximumLength: number): string | null {
  if (maximumLength < 1) return null;
  const stripped = value.replace(ASCII_CONTROL_CHARACTERS, '').replace(INVISIBLE_CHARACTERS, '');
  // `\s` Unicode : couvre l'insécable, l'espace fine insécable et les séparateurs de ligne, que
  // le planner écrase lui aussi — sans quoi la parole ne serait pas un point fixe de sa règle.
  const collapsed = stripped.replace(/\s+/gu, ' ').trim();
  if (collapsed.length === 0) return null;
  if (collapsed.length <= maximumLength) return collapsed;
  if (maximumLength === 1) return TRUNCATION_MARK;
  const points = Array.from(collapsed);

  // ÉLISION AU MILIEU, PAS À LA FIN — et c'est un correctif, pas une preference.
  //
  // Couper la fin fabriquait des libelles IDENTIQUES pour des fiches DISTINCTES : deux syndics
  // « … PORTE 12 - PARIS 11E » et « … PARIS 12E » partagent un long prefixe, et c'est la FIN qui
  // les distingue. Bob enoncait alors deux options rigoureusement indiscernables, et l'artisan
  // scellait un rattachement durable a l'aveugle — une fois sur deux vers la mauvaise fiche.
  // Or la fin porte presque toujours le discriminant : numero, ville, forme juridique.
  //
  // Ce que cela ne repare pas, et qu'il faut dire : deux noms qui ne different qu'au MILIEU
  // restent indiscernables une fois elides. On est alors ramene au cas des vrais homonymes, que
  // ce lot n'a jamais pretendu resoudre — mais la troncature n'en CREE plus.
  // Le marqueur occupe UNE unité : le reste se partage entre la tête et la queue. On accumule des
  // POINTS DE CODE tant que leur poids en UNITÉS tient dans le budget — jamais l'inverse.
  const reste = maximumLength - 1;
  const budgetTete = Math.ceil(reste / 2);
  const budgetQueue = reste - budgetTete;
  let debut = '';
  for (const point of points) {
    if (debut.length + point.length > budgetTete) break;
    debut += point;
  }
  let fin = '';
  for (let index = points.length - 1; index >= 0; index -= 1) {
    const point = points[index] as string;
    if (fin.length + point.length > budgetQueue) break;
    fin = `${point}${fin}`;
  }
  debut = debut.trimEnd();
  fin = fin.trimStart();
  if (debut.length === 0 && fin.length === 0) return null;
  return `${debut}${TRUNCATION_MARK}${fin}`;
}
