import { isValidDateOnly } from '@bob/core';

/**
 * PR-12c [parité vocale §2.7] — lecture en UNE passe des faits d'une consigne de CONTRAT
 * dictée dans le désordre : « fais-moi le contrat fontaines RATP, 3 fontaines, 1 200 € par an,
 * ça démarre au 1er octobre, 2 passages ». Module PUR (zéro I/O, zéro état) : la résolution du
 * client, du site et des équipements contre les données RÉELLES reste à l'agent — ici on ne lit
 * que ce qui a été DIT, et un fait illisible reste `null` (jamais deviné).
 *
 * ARCHITECTURE — le libellé se CONSTRUIT, il ne se soustrait plus. Chaque lecteur de fait rend
 * son EMPAN (`SpokenSpan` : la valeur lue ET l'endroit exact où elle se dit) ; le libellé est le
 * SEGMENT UTILE compris entre l'amorce de geste et la PREMIÈRE charnière factuelle rencontrée.
 * Il n'existe donc plus de liste parallèle de « nettoyeurs » qui devine une seconde fois où les
 * faits commencent : toute forme parlée qu'un lecteur apprend à comprendre borne AUSSITÔT le
 * libellé, sans qu'on ait à y penser. C'est la réponse structurelle à trois revues successives
 * qui ont trouvé la même pathologie sous trois formes différentes (montant inerte, date inerte,
 * charnière client inerte).
 *
 * LA CLASSE DE BUG S'EST POURTANT REFORMÉE UNE SIXIÈME FOIS, et il faut le dire ici : la
 * reconduction tacite restait lue par un simple `test()`, donc SANS EMPAN — elle produisait un
 * fait sans dire où il avait été dit, et la clause restait collée au nom du contrat. L'invariant
 * est donc rendu explicite : TOUT fait rendu par `extractSpokenContractFacts` a un lecteur qui
 * rend son empan, et cet empan entre dans `factSpans` (voir la note qui y est portée). Un fait
 * sans empan est un fait INERTE : il ne borne rien, donc il pollue.
 */

/** Empan d'un fait REPÉRÉ : sa valeur (null si dite mais illisible) et sa position d'origine. */
export interface SpokenSpan<T> {
  readonly value: T;
  readonly start: number;
  readonly end: number;
}

/**
 * Faits déjà RÉSOLUS par l'hôte, offerts au module pur pour qu'il reconnaisse des charnières
 * qu'aucun motif ne peut deviner : « pour RATP » n'est une attribution que si RATP est un client
 * du fichier ; « 3 machines » ne compte des équipements que si le parc dit « machine ».
 */
export interface SpokenContractOptions {
  /** Noms des clients RÉELS du tenant (le fichier), pour la charnière d'attribution. */
  readonly customerNames?: readonly string[];
  /** Libellés des équipements RÉELS du parc du site, pour corroborer un nombre d'équipements. */
  readonly parkVocabulary?: readonly string[];
}

const FRENCH_MONTHS: readonly string[] = [
  'janvier', 'fevrier', 'mars', 'avril', 'mai', 'juin',
  'juillet', 'aout', 'septembre', 'octobre', 'novembre', 'decembre',
];

const MONTH_ALTERNATION = FRENCH_MONTHS.join('|');

/**
 * Espaces de MILLIERS réellement produits par un clavier/une dictée FR (fine, insécable),
 * exprimés SANS crochets : le jour où ce fragment est inliné DANS une classe de caractères,
 * la classe imbriquée se refermerait sur le premier « ] » et la regex ne matcherait plus
 * rien — en silence. Les deux formes vivent donc côte à côte, chacune à sa place.
 */
const THOUSAND_GAP_CHARS = '\\s\\u00a0\\u202f';

/**
 * Séparateurs de MILLIERS admis, POINT COMPRIS : « 1.200 € » est la façon dont un clavier FR
 * (et bien des dictées) écrit mille deux cents. Sans le point, le lecteur repartait au chiffre
 * suivant et lisait « 200 € » — le contrat naissait au SIXIÈME de son prix, et la confirmation
 * récitait ce sixième sans que rien ne le signale. Le point est donc lu comme un millier quand
 * il est suivi d'EXACTEMENT trois chiffres, et comme une décimale sinon (« 1200.50 »).
 */
const THOUSAND_SEP_CHARS = `.${THOUSAND_GAP_CHARS}`;
const THOUSAND_SEP = `[${THOUSAND_SEP_CHARS}]`;

const NON_ASCII = /[^\p{ASCII}]/gu;

/**
 * Désaccentuation ALIGNÉE : la chaîne rendue a EXACTEMENT la même longueur (en unités UTF-16)
 * que l'originale, index par index. C'est ce qui permet de RECONNAÎTRE une charnière accentuée
 * (« à partir du », « ça démarre ») sur la copie désaccentuée, puis de COUPER le texte
 * D'ORIGINE au même index — le libellé garde donc ses accents, et aucune variante accentuée
 * n'échappe aux lecteurs. Tout caractère dont la forme repliée changerait de longueur est
 * laissé tel quel : l'alignement prime, il est la condition de sûreté de la coupe.
 */
function foldAccentsAligned(text: string): string {
  // Seuls les caractères NON ASCII peuvent porter un diacritique : le reste est rendu tel quel,
  // sans repasser par NFD (l'alignement est trivialement conservé, et la lecture reste rapide
  // même sur un corpus combinatoire de dizaines de milliers de phrases).
  return text.replace(NON_ASCII, (char) => {
    const stripped = char.normalize('NFD').replace(/\p{Diacritic}/gu, '');
    return stripped.length === char.length ? stripped : char;
  });
}

/** Mots non discriminants d'une raison sociale — jamais porteurs d'une charnière d'attribution. */
const LEGAL_FORM_WORDS: ReadonlySet<string> = new Set([
  'sarl', 'sas', 'sasu', 'eurl', 'sci', 'ets', 'ste', 'societe', 'sa', 'scop', 'gie',
]);

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Radical grossier (pluriel FR) — « fontaines » et « fontaine » désignent la même chose. */
function stem(word: string): string {
  return word.replace(/[sx]$/, '');
}

/** Jetons significatifs d'un nom, désaccentués et minusculés (« SARL Vinci » ⇒ « vinci »). */
function nameTokens(name: string): string[] {
  return foldAccentsAligned(name)
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length >= 2 && !LEGAL_FORM_WORDS.has(word));
}

// ────────────────────────────────────────────────────────────────────────────────────────────
// MONTANT
// ────────────────────────────────────────────────────────────────────────────────────────────

/** Chiffres d'une somme : groupe de milliers (espace OU point) puis décimales optionnelles. */
const AMOUNT_DIGITS = `(\\d{1,3}(?:${THOUSAND_SEP}\\d{3})+|\\d+)(?:[.,](\\d{1,2}))?`;
/** Marqueur monétaire écrit — le symbole, le mot, l'abréviation ISO. */
const EURO_MARK = '(?:€|euros?\\b|eur\\b)';

const EURO_AMOUNT = new RegExp(`${AMOUNT_DIGITS}\\s*${EURO_MARK}`, 'i');
/** Forme ABRÉGÉE (« 12 k€ », « 1,5 keuros ») : le millier est DANS le marqueur, pas dans les
 *  chiffres. Elle est cherchée AVANT la forme simple, qui ne la reconnaîtrait pas du tout. */
const KILO_EURO_AMOUNT = new RegExp(`${AMOUNT_DIGITS}\\s*k\\s*${EURO_MARK}`, 'i');

/**
 * Nombres EN TOUTES LETTRES suivis d'un marqueur monétaire (« deux mille euros », « cinq cents
 * euros »). Bob REFUSE DÉLIBÉRÉMENT de les LIRE : convertir « quatre-vingt-dix mille » à la main
 * multiplie les façons de se tromper d'un ordre de grandeur sur le prix d'un contrat annuel. Mais
 * la somme a bien été ÉNONCÉE : son EMPAN est rendu, elle ne peut donc pas rester collée au
 * libellé, et le montant redevient une QUESTION que Bob pose (« Combien par an ? »).
 *
 * La répétition est BORNÉE (six mots-nombres au plus) : une répétition libre d'une alternation de
 * littéraux se relit en temps exponentiel quand le suffixe échoue, et une dictée n'est pas une
 * entrée de confiance.
 */
const SPOKEN_NUMBER_WORD =
  '(?:zero|une?|deux|trois|quatre|cinq|six|sept|huit|neuf|dix|onze|douze|treize|quatorze|quinze|seize|vingts?|trente|quarante|cinquante|soixante|cents?|mille|millions?|milliards?)';
const LETTERS_AMOUNT = new RegExp(
  `\\b${SPOKEN_NUMBER_WORD}(?:[\\s-]+${SPOKEN_NUMBER_WORD}){0,6}\\s*(?:k\\s*)?${EURO_MARK}`,
  'i',
);

function readEuroCents(match: RegExpExecArray, thousandFold: boolean): number | null {
  const digits = match[1];
  if (digits === undefined) return null;
  const units = Number(digits.replace(new RegExp(THOUSAND_SEP, 'g'), ''));
  const fraction = match[2] === undefined ? 0 : Number(`0.${match[2]}`);
  const euros = thousandFold ? (units + fraction) * 1000 : units + fraction;
  const cents = Math.round(euros * 100);
  return Number.isSafeInteger(cents) && cents > 0 ? cents : null;
}

/**
 * Montant en euros dit — le séparateur de MILLIERS est LU, espace comme point (« 1 200 € » et
 * « 1.200 € » valent tous deux 1 200 €, jamais 200 € : la troncature silencieuse ferait naître un
 * contrat à un sixième de son prix). Décimales optionnelles (« 1 200,50 € »), forme abrégée
 * comprise (« 12 k€ » = 12 000 €). L'EMPAN est rendu même quand la valeur est illisible : une
 * somme a bien été ÉNONCÉE là, elle n'appartient donc pas au libellé.
 */
export function locateSpokenEuroAmount(text: string): SpokenSpan<number | null> | null {
  const folded = foldAccentsAligned(text);
  const kilo = KILO_EURO_AMOUNT.exec(folded);
  const plain = EURO_AMOUNT.exec(folded);
  // L'abrégé prime à position égale ou antérieure : « 12 k€ » n'est jamais « 12 € ».
  const match = kilo !== null && (plain === null || kilo.index <= plain.index) ? kilo : plain;
  if (match === null) return null;
  return {
    value: readEuroCents(match, match === kilo),
    start: match.index,
    end: match.index + match[0].length,
  };
}

/** Somme dite EN TOUTES LETTRES : jamais lue, toujours BORNANTE (charnière du libellé). */
function locateSpokenLetteredAmount(folded: string): SpokenSpan<null> | null {
  const match = LETTERS_AMOUNT.exec(folded);
  return match === null
    ? null
    : { value: null, start: match.index, end: match.index + match[0].length };
}

/** Montant ANNUEL HT dit, en centimes ; null si rien de lisible (jamais un montant inventé). */
export function extractSpokenEuroCents(text: string): number | null {
  return locateSpokenEuroAmount(text)?.value ?? null;
}

/**
 * TARIF dit sous forme distributive : une quantité, une unité, puis « par … » (« 400 balles par
 * machine », « 2000 boules par an »). C'est la STRUCTURE qui trahit le tarif, pas un lexique
 * d'argot : un prix se dit toujours « tant par quelque chose », un libellé jamais. La VALEUR
 * reste illisible (Bob demandera le montant) mais la position est connue — le tarif ne peut donc
 * pas s'imprimer sur la ligne de la facture annuelle.
 *
 * La quantité est prise SANS groupe de milliers, contrairement au montant en euros : dicté
 * d'une traite, « le contrat porte-à-faux quai 3 400 balles par an » ferait lire « 3 400 » comme
 * un seul nombre et la coupe emporterait le « 3 » DU LIBELLÉ — le contrat s'appellerait
 * « Porte-à-faux quai » sur la facture. Comme la valeur d'un tarif en unité inconnue n'est de
 * toute façon jamais lue, la lecture la plus PROCHE est ici la plus sûre.
 */
const SPOKEN_UNIT_RATE = /\b\d{1,6}(?:[.,]\d{1,2})?\s+\p{L}{2,}\s+par\s+\p{L}{2,}/iu;

function locateSpokenUnitRate(folded: string): SpokenSpan<null> | null {
  const match = SPOKEN_UNIT_RATE.exec(folded);
  return match === null
    ? null
    : { value: null, start: match.index, end: match.index + match[0].length };
}

// ────────────────────────────────────────────────────────────────────────────────────────────
// DATE DE DÉMARRAGE
// ────────────────────────────────────────────────────────────────────────────────────────────

const pad2 = (value: number): string => String(value).padStart(2, '0');

function validated(candidate: string): string | null {
  return isValidDateOnly(candidate) ? candidate : null;
}

/** Amorces d'une date de démarrage — évaluées sur la copie DÉSACCENTUÉE alignée : « à partir du »
 * et « ça démarre » ne s'écrivent jamais sans accent dans la vraie vie. */
const DATE_LEAD =
  /\b(?:a\s+partir\s+d[eu]|a\s+compter\s+d[eu]|a\s+dater\s+d[eu]|des\s+le|ca\s+demarre|demarrage|demarre|date\s+d.{0,2}effet|prise\s+d.{0,2}effet|effet\s+au|debut\s+(?:le|au)|commenc\p{L}*\s+(?:le|au))/iu;

/**
 * ANNÉE PLAUSIBLE (1800-2199) — dictée d'une traite, « ça démarre au 1er octobre 1200 euros par
 * an » offrait « 1200 » comme année : le contrat naissait avec une date anniversaire en l'an
 * 1200, donc des échéances aberrantes, et la confirmation la récitait sans que personne ne la
 * lise. Un millésime hors de portée n'est pas un fait, c'est un artefact de dictée : la date
 * sans année reprend alors la main (prochaine occurrence ≥ aujourd'hui).
 */
const PLAUSIBLE_YEAR = '(?:1[89]|2[01])\\d{2}';

const DATE_ISO = new RegExp(`\\b(${PLAUSIBLE_YEAR})-(\\d{2})-(\\d{2})\\b`);
const DATE_SLASH = new RegExp(`\\b(\\d{1,2})/(\\d{1,2})/(${PLAUSIBLE_YEAR})\\b`);
const DATE_SPOKEN_WITH_YEAR = new RegExp(
  `\\b(\\d{1,2})(?:er)?\\s+(${MONTH_ALTERNATION})\\s+(${PLAUSIBLE_YEAR})\\b`,
  'i',
);
const DATE_SPOKEN = new RegExp(`\\b(\\d{1,2})(?:er)?\\s+(${MONTH_ALTERNATION})\\b`, 'i');

function monthIndexOf(name: string): number {
  return FRENCH_MONTHS.indexOf(name.toLowerCase());
}

/**
 * Date de DÉMARRAGE dite (« ça démarre au 1er octobre », « à partir du 01/10/2026 »,
 * « 2026-10-01 »). Sans année dite, l'année retenue est la PROCHAINE occurrence ≥ `today`
 * (une couverture démarre, elle ne rétroagit pas) ; la date complète est RÉCITÉE à la
 * confirmation groupée — jamais une année supposée en silence. `today` absent ⇒ une date sans
 * année reste illisible (null) plutôt qu'inventée.
 *
 * L'EMPAN commence à l'AMORCE quand elle est dite (« à partir du ») et couvre le littéral :
 * une date énoncée mais illisible borne quand même le libellé — elle a bien été dite.
 */
export function locateSpokenStartDate(
  text: string,
  today: string | null,
): SpokenSpan<string | null> | null {
  const folded = foldAccentsAligned(text);
  const lead = DATE_LEAD.exec(folded);
  let value: string | null = null;
  let literalStart: number | null = null;
  let literalEnd: number | null = null;
  const remember = (match: RegExpExecArray): void => {
    literalStart = literalStart === null ? match.index : Math.min(literalStart, match.index);
    literalEnd = Math.max(literalEnd ?? 0, match.index + match[0].length);
  };

  const iso = DATE_ISO.exec(folded);
  if (iso) {
    remember(iso);
    value = validated(`${iso[1]}-${iso[2]}-${iso[3]}`);
  }
  const slash = DATE_SLASH.exec(folded);
  if (slash) {
    remember(slash);
    value ??= validated(`${slash[3]}-${pad2(Number(slash[2]))}-${pad2(Number(slash[1]))}`);
  }
  const withYear = DATE_SPOKEN_WITH_YEAR.exec(folded);
  if (withYear?.[2] !== undefined) {
    remember(withYear);
    value ??= validated(
      `${withYear[3]}-${pad2(monthIndexOf(withYear[2]) + 1)}-${pad2(Number(withYear[1]))}`,
    );
  }
  const spoken = DATE_SPOKEN.exec(folded);
  if (spoken?.[2] !== undefined) {
    remember(spoken);
    if (value === null && today !== null && isValidDateOnly(today)) {
      const day = pad2(Number(spoken[1]));
      const month = pad2(monthIndexOf(spoken[2]) + 1);
      const thisYear = validated(`${today.slice(0, 4)}-${month}-${day}`);
      value =
        thisYear !== null && thisYear >= today
          ? thisYear
          : validated(`${Number(today.slice(0, 4)) + 1}-${month}-${day}`);
    }
  }

  if (lead === null && literalStart === null) return null;
  const leadStart = lead?.index ?? Number.POSITIVE_INFINITY;
  const leadEnd = lead === null ? 0 : lead.index + lead[0].length;
  return {
    value,
    start: Math.min(leadStart, literalStart ?? Number.POSITIVE_INFINITY),
    end: Math.max(leadEnd, literalEnd ?? 0),
  };
}

/** Date de démarrage dite, ou null si rien de lisible (jamais une année supposée en silence). */
export function extractSpokenStartDate(text: string, today: string | null): string | null {
  return locateSpokenStartDate(text, today)?.value ?? null;
}

/**
 * REPÈRES DE CALENDRIER sans amorce d'effet — « en janvier », « à la rentrée », « le 1er du mois
 * prochain », « le trimestre prochain », « en 2027 ». Aucune valeur n'en est tirée : « la
 * rentrée » n'a pas de date, et supposer le 1er septembre écrirait une date anniversaire que
 * personne n'a dite. Ils sont pourtant BORNANTS — ce sont des compléments de temps, pas des noms
 * de contrat — et comme la date de démarrage est REQUISE, Bob la demande ensuite : le repère
 * dicté ne se perd donc pas, il devient une question.
 *
 * DÉLIBÉRÉMENT ABSENT : le nom de mois NU (« Entretien mars »). Le couper laverait un libellé
 * douteux en libellé propre — « Entretien mars » deviendrait « Entretien », accepté en silence,
 * alors que la garde (`contract-label-guard.ts`) le refuse et fait NOMMER le contrat. Une
 * préposition (« en mars », « fin mars ») prouve au contraire le complément de temps : là, couper
 * est sûr. Sur-couper n'est pas plus prudent que sous-couper — c'est mutiler un nom en silence.
 */
const CALENDAR_HINGES: readonly RegExp[] = [
  new RegExp(
    `\\b(?:en|courant|debut|fin|mi|d[eu]|jusqu['’]en|avant|apres)[\\s-]+(?:${MONTH_ALTERNATION})\\b`,
    'iu',
  ),
  new RegExp(`\\b(?:au|du)\\s+mois\\s+d(?:e|['’])\\s*(?:${MONTH_ALTERNATION})\\b`, 'iu'),
  /\b(?:le\s+)?(?:\d{1,2}\s*(?:er|eme)?\s+)?d[ue]\s+mois\s+(?:prochain|suivant|d['’]\s*apres)\b/iu,
  /\b(?:le|la|l['’]\s*)?\s*(?:mois|semaine|annee|trimestre|semestre)\s+(?:prochaine?|suivante?|d['’]\s*apres)\b/iu,
  /\b(?:a|pour|des|vers|apres)\s+(?:la|l['’]\s*)?\s*rentree\b|\bla\s+rentree\b/iu,
  /\b(?:au|du|des\s+le|en|ce[t]?)\s+(?:printemps|ete|automne|hiver)\b/iu,
  /\b(?:en\s+)?(?:fin|debut|mi)\s+d(?:e|['’])\s*annee\b/iu,
  new RegExp(`\\b(?:en|pour|des|vers|jusqu['’]en)\\s+${PLAUSIBLE_YEAR}\\b`, 'iu'),
];

function locateSpokenCalendarHinge(folded: string): SpokenSpan<null> | null {
  let earliest: SpokenSpan<null> | null = null;
  for (const pattern of CALENDAR_HINGES) {
    const match = pattern.exec(folded);
    if (match === null) continue;
    if (earliest === null || match.index < earliest.start) {
      earliest = { value: null, start: match.index, end: match.index + match[0].length };
    }
  }
  return earliest;
}

// ────────────────────────────────────────────────────────────────────────────────────────────
// PÉRIODICITÉ
// ────────────────────────────────────────────────────────────────────────────────────────────

/** Combien de fois par an revient une unité de temps DITE — arithmétique, jamais un défaut. */
const PERIOD_PER_YEAR: ReadonlyMap<string, number> = new Map([
  ['an', 1], ['ans', 1], ['annee', 1], ['annees', 1],
  ['semestre', 2], ['semestres', 2],
  ['trimestre', 4], ['trimestres', 4],
  ['mois', 12],
  ['semaine', 52], ['semaines', 52],
]);

const SPOKEN_SMALL_NUMBERS: ReadonlyMap<string, number> = new Map([
  ['un', 1], ['une', 1], ['deux', 2], ['trois', 3], ['quatre', 4], ['cinq', 5], ['six', 6],
]);

/**
 * ADJECTIFS de cadence, et ce qu'ils valent PAR AN. « bimensuel » (deux fois par mois) et
 * « bimestriel » (tous les deux mois) sont confondus par la moitié des locuteurs : « bimensuel »
 * reste donc DÉLIBÉRÉMENT illisible (`null`) — il borne le libellé sans jamais inscrire une
 * cadence qu'on aurait devinée à pile ou face sur un engagement contractuel.
 */
const CADENCE_ADJECTIVE_PER_YEAR: ReadonlyMap<string, number | null> = new Map([
  ['hebdomadaire', 52],
  ['mensuel', 12],
  ['bimestriel', 6],
  ['quadrimestriel', 3],
  ['trimestriel', 4],
  ['semestriel', 2],
  ['annuel', 1],
  ['bimensuel', null],
  ['journalier', null],
  ['quotidien', null],
]);

/** Les NOMS d'un passage. « entretien » et « maintenance » en sont volontairement absents : ce
 *  sont les mots par lesquels le métier NOMME ses contrats (« Entretien annuel »), les couper
 *  mutilerait le nom au lieu de lire une cadence. La garde, elle, les questionne. */
const VISIT_NOUN = '(?:visites?|passages?|interventions?)';
const COUNT_WORD = '(\\d{1,2}|une?|deux|trois|quatre|cinq|six)';
const CADENCE_ADJECTIVE =
  '(hebdomadaire|mensuel|bimensuel|bimestriel|quadrimestriel|trimestriel|semestriel|annuel|journalier|quotidien)';

const VISITS_COUNTED = /\b(\d{1,2})\s*(?:visites?|passages?|interventions?)\b/i;
const TIMES_PER_UNIT =
  /\b(\d{1,2}|une?|deux|trois|quatre|cinq|six)\s+fois\s+par\s+(an|ans|annees?|mois|trimestres?|semestres?|semaines?)\b/i;
const EVERY_N_UNITS =
  /\btous\s+les\s+(\d{1,2})\s*(mois|semaines?|ans?|annees?|trimestres?|semestres?)\b/i;
const EVERY_UNIT = /\btous\s+les\s+(mois|ans|trimestres|semestres|semaines)\b/i;
/** Cadence NON CHIFFRÉE par un « N fois » : « un passage par mois », « 2 visites par trimestre ». */
const VISITS_PER_UNIT = new RegExp(
  `\\b${COUNT_WORD}\\s+${VISIT_NOUN}\\s+par\\s+(an|ans|annees?|mois|trimestres?|semestres?|semaines?)\\b`,
  'i',
);
/** Cadence portée par l'ADJECTIF : « visite bimestrielle », « deux interventions annuelles ». */
const VISITS_ADJECTIVE = new RegExp(
  `\\b(?:${COUNT_WORD}\\s+)?${VISIT_NOUN}\\s+${CADENCE_ADJECTIVE}(?:le)?s?\\b`,
  'i',
);

const inYearRange = (count: number): number | null =>
  Number.isInteger(count) && count >= 0 && count <= 52 ? count : null;

/**
 * Périodicité dite (« 2 passages », « 2 visites par an », « tous les 6 mois », « une fois par
 * trimestre »). La valeur n'est retenue que si le nombre annuel est EXACT (« tous les 5 mois »
 * ne fait pas un compte entier : la périodicité reste non lue plutôt que fausse). L'empan borne
 * le libellé dans tous les cas — une cadence énoncée n'est jamais un nom de contrat.
 */
export function locateSpokenPeriodicity(text: string): SpokenSpan<number | null> | null {
  const folded = foldAccentsAligned(text);
  const candidates: SpokenSpan<number | null>[] = [];
  const push = (match: RegExpExecArray | null, value: number | null): void => {
    if (match === null) return;
    candidates.push({ value, start: match.index, end: match.index + match[0].length });
  };

  const counted = VISITS_COUNTED.exec(folded);
  push(counted, counted?.[1] === undefined ? null : inYearRange(Number(counted[1])));

  const times = TIMES_PER_UNIT.exec(folded);
  if (times?.[1] !== undefined && times[2] !== undefined) {
    const spokenCount = SPOKEN_SMALL_NUMBERS.get(times[1].toLowerCase());
    const count = spokenCount ?? Number(times[1]);
    const factor = PERIOD_PER_YEAR.get(times[2].toLowerCase());
    push(times, factor === undefined ? null : inYearRange(count * factor));
  }

  const everyN = EVERY_N_UNITS.exec(folded);
  if (everyN?.[1] !== undefined && everyN[2] !== undefined) {
    const step = Number(everyN[1]);
    const factor = PERIOD_PER_YEAR.get(everyN[2].toLowerCase());
    const exact = factor !== undefined && step > 0 && factor % step === 0 ? factor / step : null;
    push(everyN, exact === null ? null : inYearRange(exact));
  }

  const every = EVERY_UNIT.exec(folded);
  if (every?.[1] !== undefined) {
    push(every, PERIOD_PER_YEAR.get(every[1].toLowerCase()) ?? null);
  }

  const perUnit = VISITS_PER_UNIT.exec(folded);
  if (perUnit?.[2] !== undefined) {
    const count = SPOKEN_SMALL_NUMBERS.get((perUnit[1] ?? '').toLowerCase()) ?? Number(perUnit[1]);
    const factor = PERIOD_PER_YEAR.get(perUnit[2].toLowerCase());
    push(perUnit, factor === undefined ? null : inYearRange(count * factor));
  }

  const adjective = VISITS_ADJECTIVE.exec(folded);
  if (adjective?.[2] !== undefined) {
    const count =
      adjective[1] === undefined
        ? 1
        : (SPOKEN_SMALL_NUMBERS.get(adjective[1].toLowerCase()) ?? Number(adjective[1]));
    const factor = CADENCE_ADJECTIVE_PER_YEAR.get(adjective[2].toLowerCase()) ?? null;
    push(adjective, factor === null ? null : inYearRange(count * factor));
  }

  if (candidates.length === 0) return null;
  // La charnière la plus PRÉCOCE gagne. À position égale, la lecture la PLUS LONGUE prime : elle
  // a consommé davantage de ce qui a été dit, donc elle en a lu plus. « 2 visites par mois » vaut
  // 24 par an, jamais 2 — la lecture courte s'arrêtait au comptage et perdait l'unité, ce qui
  // divisait la cadence contractuelle par douze en silence. À empan égal, la lecture qui porte
  // une valeur l'emporte sur celle qui n'en porte pas.
  return candidates.reduce((best, candidate) => {
    if (candidate.start !== best.start) return candidate.start < best.start ? candidate : best;
    if (candidate.end !== best.end) return candidate.end > best.end ? candidate : best;
    return best.value === null && candidate.value !== null ? candidate : best;
  });
}

// ────────────────────────────────────────────────────────────────────────────────────────────
// RECONDUCTION TACITE
// ────────────────────────────────────────────────────────────────────────────────────────────

/**
 * MENTION de la clause de reconduction, quelle que soit sa polarité. Elle BORNE le libellé même
 * quand elle ne se laisse pas trancher : « Crée le contrat entretien vitrines avec reconduction
 * tacite » ne nomme pas un contrat « Entretien vitrines avec reconduction tacite ».
 */
const TACIT_CLAUSE =
  /\b(?:sans\s+|avec\s+|pas\s+de\s+|non\s+|ni\s+)?(?:(?:reconduction|renouvellement)\s+tacite|tacite\s+reconduction|tacitement\s+reconduit\p{L}*)\b/iu;

/** REFUS explicite — la seule forme dont on TIRE une valeur (`false`), jamais une supposition. */
const TACIT_REFUSED =
  /\b(?:sans|pas\s+de|ni\s+de)\s+(?:(?:reconduction|renouvellement)\s+tacite|tacite\s+reconduction)\b|\bnon\s+tacite\b/iu;

/**
 * Reconduction tacite dite — VALEUR et EMPAN. Elle était, jusqu'ici, le SEUL fait lu par un
 * simple `test()` : elle produisait une donnée sans dire OÙ elle avait été dite, donc sans
 * jamais borner le libellé. « Crée le contrat entretien vitrines sans reconduction tacite »
 * faisait ainsi naître un contrat NOMMÉ « Entretien vitrines sans reconduction tacite » — une
 * clause imprimée comme nom sur la ligne de la facture annuelle. La classe de bug s'était
 * reformée à la sixième lecture, faute d'empan : elle ne peut plus, `factSpans` la porte.
 *
 * `value` vaut `false` quand la reconduction est REFUSÉE, `null` quand la clause est seulement
 * ÉVOQUÉE — même doctrine que les autres lecteurs : l'empan est rendu dans les deux cas, la
 * valeur seulement quand elle est certaine.
 */
export function locateSpokenTacitRenewal(text: string): SpokenSpan<boolean | null> | null {
  const folded = foldAccentsAligned(text);
  const refused = TACIT_REFUSED.exec(folded);
  const clause = TACIT_CLAUSE.exec(folded);
  const matches = [refused, clause].filter((match): match is RegExpExecArray => match !== null);
  if (matches.length === 0) return null;
  // La charnière la plus PRÉCOCE gagne ; à position égale, la lecture la plus LONGUE prime —
  // elle a consommé davantage de ce qui a été dit, donc elle en a lu plus.
  const best = matches.reduce((chosen, match) =>
    match.index !== chosen.index
      ? match.index < chosen.index
        ? match
        : chosen
      : match[0].length > chosen[0].length
        ? match
        : chosen,
  );
  return {
    value: refused === null ? null : false,
    start: best.index,
    end: best.index + best[0].length,
  };
}

// ────────────────────────────────────────────────────────────────────────────────────────────
// NOMBRE D'ÉQUIPEMENTS — règle POSITIVE (le doute rend null, jamais un nombre faux)
// ────────────────────────────────────────────────────────────────────────────────────────────

const COUNTED_NOUN_SOURCE = "\\b(\\d{1,3})\\s+(\\p{L}[\\p{L}'’-]{2,})";

/** POSSESSION du parc : quelqu'un DÉCLARE posséder N objets (« ils ont 3 machines », « il y a
 *  8 fontaines », « un parc de 12 ascenseurs »). C'est la preuve la plus forte, et elle est
 *  POSITIVE : sans elle, aucun nombre n'est promu comptage par défaut. */
const PARK_OWNER_BEFORE =
  /\b(?:ils?|elles?|on|nous|vous|je|j['’]|le\s+client|la\s+societe|l['’]\s*entreprise|le\s+site|il\s+y)\s+(?:ont|a|ai|avons|avez|possed(?:ent|e)|compte(?:nt)?|gere(?:nt)?|exploite(?:nt)?)\s+$/iu;
const PARK_INVENTORY_BEFORE = /\b(?:un\s+|le\s+|leur\s+|son\s+)?parc\s+(?:de|d['’])\s*$/iu;

/** DESTINATION du parc : les N objets sont ce sur quoi on va AGIR (« 12 ascenseurs à
 *  entretenir », « 3 machines en service », « 4 fontaines sur site ») — « à » suivi d'un
 *  INFINITIF, sans lexique de verbes à tenir à jour. */
const PARK_PURPOSE_AFTER =
  /^(?:\s+a\s+\p{L}{3,}(?:er|ir|re)\b|\s+(?:en\s+service|sur\s+(?:le\s+|ce\s+)?site|sur\s+place|(?:au|dans\s+le)\s+parc|install(?:ees?|es?))\b)/iu;

interface EquipmentCandidate {
  readonly count: number;
  readonly noun: string;
  /** Début du NOMBRE dans le texte. */
  readonly start: number;
  /** Fin du NOM compté. */
  readonly end: number;
  /** Vrai si un cadre de parc (possession ou destination) encadre le nombre. */
  readonly framed: boolean;
  /** Début de la CHARNIÈRE : le cadre de possession en fait partie (« ils ont … »). */
  readonly hingeStart: number;
}

const overlaps = (
  span: { start: number; end: number },
  from: number,
  to: number,
): boolean => span.start < to && from < span.end;

/**
 * Candidats « N <nom> » du texte, avec leur CADRE de parc. Un cadre ne compte que s'il ne
 * chevauche pas un fait déjà lu ailleurs : « 12 ascenseurs À PARTIR du 01/10 » ne fait pas des
 * ascenseurs « à partir » (l'infinitif appartient à la date, pas au parc).
 */
function scanEquipmentCandidates(
  folded: string,
  claimed: readonly { start: number; end: number }[],
): EquipmentCandidate[] {
  const scanner = new RegExp(COUNTED_NOUN_SOURCE, 'giu');
  const candidates: EquipmentCandidate[] = [];
  let match: RegExpExecArray | null;
  while ((match = scanner.exec(folded)) !== null) {
    const digits = match[1];
    const noun = match[2];
    if (digits === undefined || noun === undefined) continue;
    const start = match.index;
    const end = match.index + match[0].length;
    const before = PARK_OWNER_BEFORE.exec(folded.slice(0, start)) ??
      PARK_INVENTORY_BEFORE.exec(folded.slice(0, start));
    const after = PARK_PURPOSE_AFTER.exec(folded.slice(end));
    const beforeStart = before === null ? start : start - before[0].length;
    const beforeOk =
      before !== null && !claimed.some((span) => overlaps(span, beforeStart, start));
    const afterOk =
      after !== null && !claimed.some((span) => overlaps(span, end, end + after[0].length));
    candidates.push({
      count: Number(digits),
      noun: noun.toLowerCase(),
      start,
      end,
      framed: beforeOk || afterOk,
      hingeStart: beforeOk ? beforeStart : start,
    });
  }
  return candidates;
}

/**
 * Nombre d'ÉQUIPEMENTS annoncé — RÈGLE POSITIVE : un nombre ne compte des équipements que s'il
 * QUALIFIE UN OBJET DU PARC, prouvé par l'une des DEUX corroborations suivantes :
 *   1. un CADRE de parc encadre le nombre (« ils ont 3 machines », « 12 ascenseurs à entretenir ») ;
 *   2. le nom compté appartient au VOCABULAIRE RÉEL du parc du site (`parkVocabulary`).
 * Aucune corroboration ⇒ `null`. C'est l'inverse exact de l'ancienne garde énumérative, qui
 * comptait par DÉFAUT sauf liste noire d'unités et d'argot : là, tout nom commun inconnu passait.
 * Ici le doute ne produit AUCUN fait — la doctrine interdit d'énoncer un fait inventé au point de
 * décision d'une mutation (« Tu as parlé de 400 machine(s) »).
 *
 * TROISIÈME CORROBORATION SUPPRIMÉE — le libellé DICTÉ corroborait « la reprise du libellé »
 * (« contrat fontaines RATP, 3 fontaines »). C'était une TAUTOLOGIE : le libellé est lui-même
 * lu de la phrase, il ne prouve donc rien de plus qu'elle. « Crée le contrat entretien 4
 * saisons » s'auto-corroborait ainsi en 4 ÉQUIPEMENTS, que Bob récitait au point de décision
 * d'une mutation (« Tu as parlé de 4 machine(s) »). Seul le PARC RÉEL, qui vient de l'hôte et
 * pas de la phrase, peut corroborer un comptage.
 *
 * Un nombre qui appartient déjà à un autre fait lu (montant, date, cadence) n'est jamais
 * candidat : « 2 visites » ne fait pas 2 équipements, « 1 200 € » n'en fait pas 200.
 */
export function extractSpokenEquipmentCount(
  message: string,
  options: {
    readonly parkVocabulary?: readonly string[];
    readonly today?: string | null;
  } = {},
): number | null {
  const folded = foldAccentsAligned(message);
  const claimed = factSpans(folded, options.today ?? null);
  const candidates = scanEquipmentCandidates(folded, claimed).filter(
    (candidate) => !claimed.some((span) => overlaps(span, candidate.start, candidate.end)),
  );
  const framed = candidates.find((candidate) => candidate.framed);
  if (framed) return framed.count > 0 ? framed.count : null;

  const vocabulary = new Set<string>();
  for (const entry of options.parkVocabulary ?? []) {
    for (const token of nameTokens(entry)) vocabulary.add(stem(token));
  }
  const corroborated = candidates.find((candidate) =>
    vocabulary.has(stem(foldAccentsAligned(candidate.noun).toLowerCase())),
  );
  return corroborated !== undefined && corroborated.count > 0 ? corroborated.count : null;
}

// ────────────────────────────────────────────────────────────────────────────────────────────
// ATTRIBUTION (client, site)
// ────────────────────────────────────────────────────────────────────────────────────────────

/** Attribution par le RÔLE : « pour le client », « chez la société », « pour l'entreprise ».
 *  Aucun nom n'est nécessaire — le rôle suffit à dire que ce qui suit n'est plus le libellé. */
const ATTRIBUTION_ROLE =
  /\b(?:pour|chez|aupres\s+d[eu]|au\s+profit\s+d[eu]|a|au|aux)\s+(?:l[ea]\s+|les\s+|l['’]\s*|mon\s+|notre\s+|ce\s+|cette\s+)?(?:clientes?|clients?|societes?|entreprises?|groupes?|enseignes?|coproprietes?|syndics?|mairies?)\b/iu;

/** Attribution par le LIEU : « sur le site », « sur le chantier », « à l'agence ». */
const ATTRIBUTION_PLACE =
  /\b(?:sur|dans|a|au|aux|pour)\s+(?:l[ea]\s+|les\s+|l['’]\s*|ce\s+)?(?:sites?|chantiers?|agences?|etablissements?)\b/iu;

/**
 * Attribution DÉLÉGUÉE — les tournures standard par lesquelles un pro dit pour QUI il travaille :
 * « pour le compte de RATP », « au nom de Carrefour », « de la part du syndic ». Elles n'ont
 * besoin d'AUCUN nom connu : la tournure elle-même dit que ce qui suit attribue le contrat, elle
 * borne donc le libellé même quand le bénéficiaire est introuvable au fichier.
 */
const ATTRIBUTION_DELEGATED =
  /\b(?:pour\s+le\s+compte\s+d(?:e|u|['’])|au\s+nom\s+d(?:e|u|['’])|de\s+la\s+part\s+d(?:e|u|['’])|au\s+profit\s+d(?:e|u|['’])|aupres\s+d(?:e|u|['’]))/iu;

/** Attribution par la FORME SOCIALE : « pour la SARL Dupont », « chez la SAS Martin ». */
const ATTRIBUTION_LEGAL_FORM =
  /\b(?:pour|chez|de|du|au|aux|a)\s+(?:l[ea]\s+|les\s+|l['’]\s*)?(?:sarl|sas|sasu|eurl|sci|scop|gie|ste|societe|snc|selarl|earl|scm|sem|scs|sca)\b/iu;

/**
 * Attribution par la CIVILITÉ : « pour M. Dupont », « chez Mme Girard ». La fin de la civilité
 * se prouve par « aucune lettre ne suit », JAMAIS par `\b` : « M. » se termine par un point, et
 * un point suivi d'une espace n'est pas une frontière de mot — la charnière restait inerte, et
 * « pour M » finissait imprimé comme nom du contrat sur la facture annuelle.
 */
const ATTRIBUTION_CIVILITY =
  /\b(?:pour|chez|de|du|au|aux|a)\s+(?:m\.|mr\.?|mme|mlle|monsieur|madame|mademoiselle)(?!\p{L})/iu;

/**
 * Attribution par le NOM PROPRE déjà résolu : « pour RATP », « chez Carrefour ». C'est la forme
 * qui a échappé aux trois revues précédentes, parce qu'aucun motif ne peut la deviner : il faut
 * SAVOIR que « RATP » est un client du fichier. Le nom sans préposition reste au libellé —
 * « contrat fontaines RATP » nomme bien le contrat, il ne l'attribue pas.
 */
function locateNamedAttribution(folded: string, names: readonly string[]): number | null {
  let earliest: number | null = null;
  const haystack = folded.toLowerCase();
  for (const name of names) {
    const tokens = nameTokens(name);
    if (tokens.length === 0) continue;
    // Un fichier client peut compter des centaines de noms : on ne compile la reconnaissance
    // complète que pour ceux dont le premier jeton a effectivement été prononcé.
    if (!haystack.includes(tokens[0] ?? '')) continue;
    const pattern = new RegExp(
      `\\b(?:pour|chez|aupres\\s+d[eu]|a|au|aux)\\s+(?:l[ea]\\s+|les\\s+|l['’]\\s*)?${tokens
        .map(escapeForRegExp)
        .join("[\\s'’-]+")}\\b`,
      'iu',
    );
    const match = pattern.exec(folded);
    if (match !== null && (earliest === null || match.index < earliest)) earliest = match.index;
  }
  return earliest;
}

// ────────────────────────────────────────────────────────────────────────────────────────────
// LIBELLÉ — construit entre l'amorce de geste et la PREMIÈRE charnière factuelle
// ────────────────────────────────────────────────────────────────────────────────────────────

/** Mots de GESTE d'une consigne de contrat — retirés du libellé lu (« fais-moi le contrat
 * fontaines RATP » a pour libellé « fontaines RATP », jamais « fais-moi le contrat… »). */
const LABEL_LEADING =
  /^(?:de\s+maintenance\s+)?(?:pour\s+)?(?:le\s+|la\s+|les\s+|l\W\s*|un\s+|une\s+|du\s+|des\s+|de\s+|d\W\s*)*/i;

/** Charnière laissée PENDANTE par une coupe (« … 12 ascenseurs à | 15 000 € ») — un libellé
 *  ne se termine jamais sur une préposition orpheline ni sur un tiret de liaison. */
const DANGLING_WORD =
  /[\s\-–—:,;]+(?:au|aux|de|du|des|pour|et|en|sur|par|chez|avec|un|une|le|la|les|leur|leurs|il|ils)[\s\-–—:,;]*$/i;

/**
 * Mot-outil d'UNE SEULE LETTRE laissé pendant (« … 12 ascenseurs à | 15 000 € ») — reconnu en
 * MINUSCULE seulement.
 *
 * POURQUOI LA CASSE COMPTE ICI : « Entretien hall A », « Dépannage bloc D », « Contrat tour L »
 * sont des noms que le métier dicte tous les jours — la lettre finale DÉSIGNE un bâtiment, elle
 * ne pend pas. Lue sans égard à la casse, la règle amputait « Entretien hall A » en « Entretien
 * hall » : un nom MUTILÉ, ni vide ni moignon, que rien en aval ne pouvait plus signaler et qui
 * s'imprimait tel quel sur la ligne de la facture annuelle. Sur-couper n'est pas plus prudent
 * que sous-couper.
 */
const DANGLING_LETTER = /[\s\-–—:,;]+[adl][\s\-–—:,;]*$/;

/** Ponctuation de liaison seule (espace, tiret, deux-points) laissée par une coupe. */
const DANGLING_PUNCTUATION = /[\s\-–—:,;]+$/;

/** Longueur de la queue pendante — la plus LONGUE des trois lectures, jamais la première venue. */
function danglingTailLength(segment: string): number {
  let longest = 0;
  for (const pattern of [DANGLING_WORD, DANGLING_LETTER, DANGLING_PUNCTUATION]) {
    const hit = pattern.exec(segment);
    if (hit !== null && hit[0].length > longest) longest = hit[0].length;
  }
  return longest;
}

/** Ponctuation FORTE : elle clôt le segment utile aussi sûrement qu'un fait. */
const LABEL_BREAK = /[,;.!?()«»]/;

const MAX_LABEL_LENGTH = 80;

const CONTRACT_ANCHOR = /\bcontrats?\b/i;
const QUOTED_LABEL = /\bcontrats?\s+«\s*([^»]{2,80})\s*»/i;

/**
 * Empans de TOUS les faits lisibles du texte — la matière première de la découpe.
 *
 * INVARIANT DE CONCEPTION : tout fait rendu par `extractSpokenContractFacts` a son lecteur ICI.
 * Un fait lu SANS empan est un fait INERTE : il ne borne pas le libellé, donc il reste collé au
 * nom du contrat et s'imprime sur la ligne de la facture annuelle. C'est la pathologie que
 * quatre revues ont trouvée sous quatre formes (montant, date, charnière client) et qui s'est
 * REFORMÉE en sixième lecture sur la reconduction tacite, seul fait encore lu par un simple
 * `test()`. La règle est donc structurelle : un lecteur de fait rend un empan, et cet empan
 * entre dans cette liste — sans quoi le fait n'a pas le droit d'exister.
 */
function factSpans(folded: string, today: string | null): { start: number; end: number }[] {
  const spans: { start: number; end: number }[] = [];
  const amount = locateSpokenEuroAmount(folded);
  if (amount) spans.push({ start: amount.start, end: amount.end });
  const lettered = locateSpokenLetteredAmount(folded);
  if (lettered) spans.push({ start: lettered.start, end: lettered.end });
  const rate = locateSpokenUnitRate(folded);
  if (rate) spans.push({ start: rate.start, end: rate.end });
  const date = locateSpokenStartDate(folded, today);
  if (date) spans.push({ start: date.start, end: date.end });
  const calendar = locateSpokenCalendarHinge(folded);
  if (calendar) spans.push({ start: calendar.start, end: calendar.end });
  const periodicity = locateSpokenPeriodicity(folded);
  if (periodicity) spans.push({ start: periodicity.start, end: periodicity.end });
  const tacit = locateSpokenTacitRenewal(folded);
  if (tacit) spans.push({ start: tacit.start, end: tacit.end });
  return spans;
}

/**
 * Découpe du segment utile : la coupe la plus PRÉCOCE gagne. Chaque charnière vient d'un LECTEUR
 * de fait (qui sait où son fait commence) ou d'une attribution ; il n'existe aucune liste
 * parallèle de motifs qui redevinerait les mêmes positions une seconde fois.
 */
function usefulSegmentEnd(body: string, options: SpokenContractOptions): number {
  let end = body.length;
  const consider = (start: number | null | undefined): void => {
    if (typeof start === 'number' && start >= 0) end = Math.min(end, start);
  };
  const claimed = factSpans(body, null);
  for (const span of claimed) consider(span.start);
  consider(LABEL_BREAK.exec(body)?.index);
  consider(ATTRIBUTION_ROLE.exec(body)?.index);
  consider(ATTRIBUTION_PLACE.exec(body)?.index);
  consider(ATTRIBUTION_DELEGATED.exec(body)?.index);
  consider(ATTRIBUTION_LEGAL_FORM.exec(body)?.index);
  consider(ATTRIBUTION_CIVILITY.exec(body)?.index);
  consider(locateNamedAttribution(body, options.customerNames ?? []));
  // COMPTAGE D'ÉQUIPEMENTS — SEUL le cadre de parc borne (« ils ont 3 machines », « 12
  // ascenseurs à entretenir »). La corroboration par le VOCABULAIRE du parc, elle, est
  // délibérément NON bornante : « Entretien 12 ascenseurs » est un nom de contrat que le corpus
  // exige de restituer À L'IDENTIQUE, et couper sur le seul fait que le parc porte des
  // ascenseurs le MUTILERAIT en « Entretien ». Sur-couper n'est pas plus prudent que
  // sous-couper — c'est amputer un nom en silence, et rien en aval ne peut plus le signaler.
  for (const candidate of scanEquipmentCandidates(body, claimed)) {
    if (candidate.framed) consider(candidate.hingeStart);
  }
  return end;
}

/** Nettoyage terminal d'un segment retenu : contrôles neutralisés, espaces normalisés, capitale. */
function finishLabel(segment: string): string | null {
  const cleaned = segment.replace(/\p{Cc}/gu, ' ').replace(/\s+/g, ' ').trim();
  if (cleaned.length < 2) return null;
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

/**
 * ORDRE DES OPÉRATIONS — les charnières sont cherchées sur le segment ENTIER, AVANT que les mots
 * de geste ne soient retirés. L'ordre inverse était un bug PROUVÉ : `LABEL_LEADING` consommait la
 * préposition « pour » comme un mot de geste, si bien qu'aucune charnière d'attribution ne
 * pouvait plus la reconnaître ensuite — TOUTES étaient inertes. « Crée le contrat pour Carrefour »
 * nommait donc le contrat « Carrefour », et « … de maintenance pour le client RATP » l'appelait
 * « Client RATP » : le nom du client s'imprimait sur la LIGNE de la facture annuelle.
 *
 * Quand la charnière tombe au tout début, il ne reste RIEN : c'est la bonne réponse — aucun nom
 * n'a été dicté, seulement un client. Bob POSE alors la question au lieu d'inventer un nom.
 */
function buildLabel(segment: string, options: SpokenContractOptions): string | null {
  const folded = foldAccentsAligned(segment);
  const end = usefulSegmentEnd(folded, options);
  const lead = LABEL_LEADING.exec(folded.slice(0, end))?.[0].length ?? 0;
  let stop = end;
  if (stop - lead > MAX_LABEL_LENGTH) {
    const cut = folded.slice(lead, lead + MAX_LABEL_LENGTH + 1).lastIndexOf(' ');
    stop = lead + (cut > 0 ? cut : MAX_LABEL_LENGTH);
  }
  const dangling = danglingTailLength(folded.slice(lead, stop));
  return finishLabel(segment.slice(lead, Math.max(lead, stop - dangling)));
}

/**
 * PROVENANCE du libellé — elle décide de la sévérité de la GARDE (`contract-label-guard.ts`),
 * jamais l'appelant au petit bonheur :
 *  · `'nomme'`   : le pro a NOMMÉ le contrat entre guillemets (forme canonique des followUps).
 *    Ce nom est pris VERBATIM : le recouper mutilerait un nom délibérément écrit.
 *  · `'extrait'` : Bob a DÉDUIT le nom d'un segment de phrase — il a donc pu se tromper.
 *  · `null`      : aucun libellé n'a été dit.
 */
export interface SpokenContractLabel {
  readonly label: string | null;
  readonly provenance: 'nomme' | 'extrait' | null;
}

/**
 * Libellé dit AVEC sa provenance. La forme canonique des followUps guillemette le libellé : elle
 * est lue en priorité et rendue TELLE QUELLE, ce qui fait CONVERGER les tours suivants et garantit
 * qu'un nom relu ne bouge plus (f(f(x)) = f(x)) — y compris quand il contient une tournure que la
 * découpe aurait prise pour une charnière (« Entretien à partir de la cour »).
 *
 * Hors guillemets, le libellé est le SEGMENT UTILE qui suit le mot « contrat », borné par la
 * première charnière factuelle.
 *
 * IMPACT LÉGAL : ce libellé est persisté comme libellé du contrat ET de sa LIGNE UNIQUE, donc
 * repris tel quel comme LIGNE de la facture annuelle — il s'IMPRIME sur une pièce légale. Un
 * fait dicté (montant, date, cadence, client) qui y resterait collé serait facturé ; la
 * confirmation groupée ne protège de rien puisqu'elle récite le libellé fautif : le pro n'entend
 * que sa propre phrase et valide. C'est pourquoi une GARDE indépendante inspecte ce libellé avant
 * toute proposition de mutation, et transforme le doute en QUESTION.
 */
export function locateSpokenContractLabel(
  message: string,
  options: SpokenContractOptions = {},
): SpokenContractLabel {
  const quoted = QUOTED_LABEL.exec(message);
  if (quoted?.[1] !== undefined) {
    const named = finishLabel(quoted[1]);
    return { label: named, provenance: named === null ? null : 'nomme' };
  }
  const anchor = CONTRACT_ANCHOR.exec(message);
  if (anchor === null) return { label: null, provenance: null };
  const rest = message.slice(anchor.index + anchor[0].length);
  const built = buildLabel(rest.replace(/^\s+/, ''), options);
  return { label: built, provenance: built === null ? null : 'extrait' };
}

/** Libellé dit, sans sa provenance — lecture de confort pour les appels qui n'en ont pas besoin. */
export function extractSpokenContractLabel(
  message: string,
  options: SpokenContractOptions = {},
): string | null {
  return locateSpokenContractLabel(message, options).label;
}

// ────────────────────────────────────────────────────────────────────────────────────────────
// LECTURE COMPOSITE
// ────────────────────────────────────────────────────────────────────────────────────────────

/** Caractères de CONTRÔLE interdits par le domaine (motif de résiliation, `\p{Cc}`) —
 * neutralisés avant de porter la phrase du pro en trace : jamais un refus technique sur un
 * artefact de dictée. */
export function sanitizeSpokenNote(text: string): string {
  return text.replace(/\p{Cc}/gu, ' ').replace(/\s+/g, ' ').trim();
}

export interface SpokenContractFacts {
  /** Libellé LIBRE du contrat (« Fontaines RATP ») — jamais un lexique métier codé. */
  label: string | null;
  /** D'où vient ce libellé : NOMMÉ entre guillemets, ou DÉDUIT d'un segment de phrase. */
  labelProvenance: 'nomme' | 'extrait' | null;
  /** Montant ANNUEL HT dit, en centimes (« 1 200 € par an ») — la ligne unique du contrat. */
  annualAmountCents: number | null;
  /** Périodicité dite (« 2 passages », « tous les 6 mois ») — jamais un défaut inventé ici. */
  visitsPerYear: number | null;
  /** Reconduction tacite REFUSÉE explicitement (« sans reconduction tacite ») ; null = non dit. */
  tacitRenewal: boolean | null;
  /** Démarrage dit → date anniversaire du contrat. */
  startDate: string | null;
  /** Nombre d'équipements ANNONCÉ (« ils ont 3 machines ») — sert à DIRE honnêtement l'écart
   * avec ce que le parc réel porte, jamais à inventer un équipement. */
  equipmentCount: number | null;
}

/** Lecture en UNE passe de tous les faits énoncés (aucune question tant qu'il ne manque rien). */
export function extractSpokenContractFacts(
  message: string,
  today: string | null,
  options: SpokenContractOptions = {},
): SpokenContractFacts {
  const spoken = locateSpokenContractLabel(message, options);
  const label = spoken.label;
  return {
    label,
    labelProvenance: spoken.provenance,
    annualAmountCents: extractSpokenEuroCents(message),
    visitsPerYear: locateSpokenPeriodicity(message)?.value ?? null,
    tacitRenewal: locateSpokenTacitRenewal(message)?.value ?? null,
    startDate: extractSpokenStartDate(message, today),
    equipmentCount: extractSpokenEquipmentCount(message, {
      today,
      ...(options.parkVocabulary !== undefined ? { parkVocabulary: options.parkVocabulary } : {}),
    }),
  };
}

/**
 * MARQUEURS derrière lesquels un motif est réellement ÉNONCÉ, par ordre de priorité : la forme
 * canonique (« motif : … ») que les followUps de Bob redisent vient en tête — c'est elle qui
 * fait CONVERGER les tours. Évalués sur la copie désaccentuée alignée (« à cause de »).
 */
const TERMINATION_NOTE_MARKERS: readonly RegExp[] = [
  /\b(?:motifs?|raisons?)\s*:\s*/i,
  // « car » est AUSSI un nom commun (« le contrat car scolaire », « le contrat car park ») : la
  // conjonction n'est retenue que si une PROPOSITION la suit — un déterminant ou un pronom.
  // L'asymétrie commande la prudence : rater un marqueur coûte une question de plus, en
  // inventer un écrit « scolaire » comme motivation légale d'une rupture de contrat.
  /\b(?:parce\s+qu(?:e|’|')\s*|puisqu(?:e|’|')\s*|a\s+cause\s+d[eu]\s+|car\s+(?=(?:l[ae]|l[’']|les|il|ils|elle|elles|on|je|j[’']|nous|vous|ce|c[’']|ca|cela|mon|ma|mes|son|sa|ses|leur|leurs|notre|nos|votre|vos|plus|rien|personne)\b))/i,
];

/**
 * Motif de RÉSILIATION dit — TRACE LÉGALE d'une décision qui ROMPT un engagement contractuel
 * (le domaine l'exige). Il n'est retenu que s'il est RÉELLEMENT ÉNONCÉ, derrière l'un des
 * marqueurs ci-dessus. Sans motif dit : `null`, et l'agent POSE la question ciblée.
 *
 * Une phrase de COMMANDE n'est pas une motivation : inscrire « Résilie le contrat Bastille »
 * en terminationNote reviendrait à faire passer l'ORDRE pour le POURQUOI — la trace mentirait
 * sur ce que le pro a réellement motivé, et personne ne s'en apercevrait puisque la
 * confirmation ne fait que lui relire sa propre phrase.
 */
export function extractSpokenTerminationNote(message: string): string | null {
  const folded = foldAccentsAligned(message);
  let start: number | null = null;
  for (const marker of TERMINATION_NOTE_MARKERS) {
    const hit = marker.exec(folded);
    if (hit !== null) {
      start = hit.index + hit[0].length;
      break;
    }
  }
  if (start === null) return null;
  const spoken = /^[^.;!?]{2,200}/.exec(message.slice(start))?.[0];
  if (spoken === undefined) return null;
  const note = sanitizeSpokenNote(spoken).trim();
  return note.length >= 2 ? note : null;
}
