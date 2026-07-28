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
 * charnière client inerte) : la classe de bug ne peut plus se reformer, faute de seconde liste.
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
/** La même chose EN classe, pour les usages hors classe (alternance, remplacement global). */
const THOUSAND_GAP = `[${THOUSAND_GAP_CHARS}]`;

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

const EURO_AMOUNT = new RegExp(
  `(\\d{1,3}(?:${THOUSAND_GAP}\\d{3})+|\\d+)(?:[.,](\\d{1,2}))?\\s*(?:€|euros?\\b|eur\\b)`,
  'i',
);

/**
 * Montant en euros dit — le séparateur de MILLIERS est LU (« 1 200 € » vaut 1 200 €, jamais
 * 200 € : la troncature silencieuse ferait naître un contrat à un sixième de son prix).
 * Décimales optionnelles (« 1 200,50 € »). L'EMPAN est rendu même quand la valeur est illisible
 * (« 0 € ») : une somme a bien été ÉNONCÉE là, elle n'appartient donc pas au libellé.
 */
export function locateSpokenEuroAmount(text: string): SpokenSpan<number | null> | null {
  const match = EURO_AMOUNT.exec(foldAccentsAligned(text));
  if (match?.[1] === undefined) return null;
  const units = Number(match[1].replace(new RegExp(THOUSAND_GAP, 'g'), ''));
  const decimals = match[2] === undefined ? 0 : Number(match[2].padEnd(2, '0'));
  const cents = Math.round(units * 100) + decimals;
  return {
    value: Number.isSafeInteger(cents) && cents > 0 ? cents : null,
    start: match.index,
    end: match.index + match[0].length,
  };
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

const VISITS_COUNTED = /\b(\d{1,2})\s*(?:visites?|passages?|interventions?)\b/i;
const TIMES_PER_UNIT =
  /\b(\d{1,2}|une?|deux|trois|quatre|cinq|six)\s+fois\s+par\s+(an|ans|annees?|mois|trimestres?|semestres?|semaines?)\b/i;
const EVERY_N_UNITS =
  /\btous\s+les\s+(\d{1,2})\s*(mois|semaines?|ans?|annees?|trimestres?|semestres?)\b/i;
const EVERY_UNIT = /\btous\s+les\s+(mois|ans|trimestres|semestres|semaines)\b/i;

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

  if (candidates.length === 0) return null;
  // La charnière la plus PRÉCOCE gagne ; à position égale, la lecture qui porte une valeur.
  return candidates.reduce((best, candidate) =>
    candidate.start < best.start ||
    (candidate.start === best.start && best.value === null && candidate.value !== null)
      ? candidate
      : best,
  );
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
 * QUALIFIE UN OBJET DU PARC, prouvé par l'une des trois corroborations suivantes, du plus fort
 * au plus faible :
 *   1. un CADRE de parc encadre le nombre (« ils ont 3 machines », « 12 ascenseurs à entretenir ») ;
 *   2. le nom compté appartient au VOCABULAIRE RÉEL du parc du site (`parkVocabulary`) ;
 *   3. le nom compté est REPRIS du libellé dicté (« contrat fontaines RATP, 3 fontaines »).
 * Aucune corroboration ⇒ `null`. C'est l'inverse exact de l'ancienne garde énumérative, qui
 * comptait par DÉFAUT sauf liste noire d'unités et d'argot : là, tout nom commun inconnu passait.
 * Ici le doute ne produit AUCUN fait — la doctrine interdit d'énoncer un fait inventé au point de
 * décision d'une mutation (« Tu as parlé de 400 machine(s) »).
 *
 * Un nombre qui appartient déjà à un autre fait lu (montant, date, cadence) n'est jamais
 * candidat : « 2 visites » ne fait pas 2 équipements, « 1 200 € » n'en fait pas 200.
 */
export function extractSpokenEquipmentCount(
  message: string,
  options: {
    readonly label?: string | null;
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
  for (const token of nameTokens(options.label ?? '')) vocabulary.add(stem(token));
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
const LABEL_DANGLING_TAIL =
  /[\s\-–—:,;]+(?:a|au|aux|de|du|des|d|pour|et|en|sur|par|chez|avec|un|une|le|la|les|leur|leurs|il|ils)?[\s\-–—:,;]*$/i;

/** Ponctuation FORTE : elle clôt le segment utile aussi sûrement qu'un fait. */
const LABEL_BREAK = /[,;.!?()«»]/;

const MAX_LABEL_LENGTH = 80;

const CONTRACT_ANCHOR = /\bcontrats?\b/i;
const QUOTED_LABEL = /\bcontrats?\s+«\s*([^»]{2,80})\s*»/i;

/** Empans de TOUS les faits lisibles du texte — la matière première de la découpe. */
function factSpans(folded: string, today: string | null): { start: number; end: number }[] {
  const spans: { start: number; end: number }[] = [];
  const amount = locateSpokenEuroAmount(folded);
  if (amount) spans.push({ start: amount.start, end: amount.end });
  const rate = locateSpokenUnitRate(folded);
  if (rate) spans.push({ start: rate.start, end: rate.end });
  const date = locateSpokenStartDate(folded, today);
  if (date) spans.push({ start: date.start, end: date.end });
  const periodicity = locateSpokenPeriodicity(folded);
  if (periodicity) spans.push({ start: periodicity.start, end: periodicity.end });
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
  consider(locateNamedAttribution(body, options.customerNames ?? []));
  for (const candidate of scanEquipmentCandidates(body, claimed)) {
    if (candidate.framed) consider(candidate.hingeStart);
  }
  if (end > MAX_LABEL_LENGTH) {
    const cut = body.slice(0, MAX_LABEL_LENGTH + 1).lastIndexOf(' ');
    end = cut > 0 ? cut : MAX_LABEL_LENGTH;
  }
  return end;
}

/** Nettoyage terminal d'un segment retenu : contrôles neutralisés, espaces normalisés, capitale. */
function finishLabel(segment: string): string | null {
  const cleaned = segment.replace(/\p{Cc}/gu, ' ').replace(/\s+/g, ' ').trim();
  if (cleaned.length < 2) return null;
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

function buildLabel(segment: string, options: SpokenContractOptions): string | null {
  const folded = foldAccentsAligned(segment);
  const lead = LABEL_LEADING.exec(folded)?.[0].length ?? 0;
  const body = folded.slice(lead);
  const end = usefulSegmentEnd(body, options);
  const dangling = LABEL_DANGLING_TAIL.exec(body.slice(0, end))?.[0].length ?? 0;
  return finishLabel(segment.slice(lead, lead + Math.max(0, end - dangling)));
}

/**
 * Libellé dit : le SEGMENT UTILE qui suit le mot « contrat », borné par la première charnière
 * factuelle. La forme canonique des followUps guillemette le libellé — elle est lue en priorité,
 * ce qui fait CONVERGER les tours suivants ; elle repasse par la MÊME découpe, ce qui garantit
 * qu'un libellé propre relu ne bouge plus (f(f(x)) = f(x)).
 *
 * IMPACT LÉGAL : ce libellé est persisté comme libellé du contrat ET de sa LIGNE UNIQUE, donc
 * repris tel quel comme LIGNE de la facture annuelle — il s'IMPRIME sur une pièce légale. Un
 * fait dicté (montant, date, cadence, client) qui y resterait collé serait facturé ; la
 * confirmation groupée ne protège de rien puisqu'elle récite le libellé fautif : le pro n'entend
 * que sa propre phrase et valide.
 */
export function extractSpokenContractLabel(
  message: string,
  options: SpokenContractOptions = {},
): string | null {
  const quoted = QUOTED_LABEL.exec(message);
  if (quoted?.[1] !== undefined) return buildLabel(quoted[1], options);
  const anchor = CONTRACT_ANCHOR.exec(message);
  if (anchor === null) return null;
  const rest = message.slice(anchor.index + anchor[0].length);
  return buildLabel(rest.replace(/^\s+/, ''), options);
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

const TACIT_REFUSED =
  /\bsans\s+(?:reconduction|renouvellement)\s+tacite\b|\bnon\s+tacite\b|\bpas\s+de\s+(?:reconduction|renouvellement)\s+tacite\b/i;

/** Lecture en UNE passe de tous les faits énoncés (aucune question tant qu'il ne manque rien). */
export function extractSpokenContractFacts(
  message: string,
  today: string | null,
  options: SpokenContractOptions = {},
): SpokenContractFacts {
  const label = extractSpokenContractLabel(message, options);
  return {
    label,
    annualAmountCents: extractSpokenEuroCents(message),
    visitsPerYear: locateSpokenPeriodicity(message)?.value ?? null,
    tacitRenewal: TACIT_REFUSED.test(foldAccentsAligned(message)) ? false : null,
    startDate: extractSpokenStartDate(message, today),
    equipmentCount: extractSpokenEquipmentCount(message, {
      label,
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
