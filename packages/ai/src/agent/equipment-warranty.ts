import { isValidDateOnly } from '@bob/core';

/**
 * PR-11c [revue train n°2] — extraction du fait « garantie » d'une consigne PARLÉE.
 * L'exemple NORMATIF du fondateur (conception domaine §1.6) est un mois-année parlé :
 * « elle est sous garantie jusqu'en mars 2027 » → FIN de mois (2027-03-31). Formats lus :
 * JJ/MM/AAAA, AAAA-MM-JJ, « jusqu'au 12 mars 2027 » (jour dit), « mars 2027 » (fin de mois)
 * et [re-revue] la durée dite AVEC son échéance (« garantie 2 ans jusqu'au 12 mars 2027 »).
 * Toute mention de garantie NON lisible est signalée (`mentioned` sans date) pour que Bob le
 * DISE honnêtement dans la confirmation groupée — jamais un fait énoncé perdu en silence.
 */

const FRENCH_MONTHS: readonly string[] = [
  'janvier', 'fevrier', 'mars', 'avril', 'mai', 'juin',
  'juillet', 'aout', 'septembre', 'octobre', 'novembre', 'decembre',
];

const MONTH_ALTERNATION = FRENCH_MONTHS.join('|');

const NON_DIGIT_GAP = '[^0-9]{0,24}';

/** [Re-revue] « garantie 2 ans jusqu'au 12 mars 2027 » — le gap non numérique seul ne
 * traverse jamais la DURÉE dite avant l'échéance. Seul un nombre COURT suivi de son unité de
 * durée (an/ans/année(s)/mois) est enjambé — jamais un nombre quelconque (« contrat 4500123 »
 * reste illisible et signalé honnêtement). */
const SPOKEN_DURATION = `(?:\\d{1,2}\\s*(?:ans?|annees?|mois)\\b${NON_DIGIT_GAP})?`;

/** Préfixe commun : « garantie … », puis éventuellement la durée dite, avant l'échéance. */
const WARRANTY_PREFIX = `garanti\\w*${NON_DIGIT_GAP}${SPOKEN_DURATION}`;

/** « garantie … 12/03/2027 » — numérique JJ/MM/AAAA. */
const NUMERIC_SLASH = new RegExp(`${WARRANTY_PREFIX}(\\d{2})\\/(\\d{2})\\/(\\d{4})`);

/** « garantie … 2027-03-12 » — numérique AAAA-MM-JJ. */
const NUMERIC_ISO = new RegExp(`${WARRANTY_PREFIX}(\\d{4})-(\\d{2})-(\\d{2})`);

/** « garantie … 12 mars 2027 » — jour dit (1er accepté), sur texte normalisé sans diacritiques. */
const SPOKEN_DAY = new RegExp(
  `${WARRANTY_PREFIX}\\b(\\d{1,2})(?:er)?\\s+(${MONTH_ALTERNATION})\\s+(\\d{4})\\b`,
);

/** « garantie jusqu'en mars 2027 » — mois-année parlé, résolu en FIN de mois. */
const SPOKEN_MONTH = new RegExp(`${WARRANTY_PREFIX}\\b(${MONTH_ALTERNATION})\\s+(\\d{4})\\b`);

const pad2 = (value: number): string => String(value).padStart(2, '0');

/** Dernier jour du mois (UTC pur — février bissextile compris), sans fuseau. */
function lastDayOfMonth(year: number, monthIndex: number): number {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

function validated(candidate: string): string | null {
  return isValidDateOnly(candidate) ? candidate : null;
}

export interface SpokenWarranty {
  /** AAAA-MM-JJ quand le fait a pu être LU (et vérifié : jamais un 31/02), sinon null. */
  date: string | null;
  /** La phrase mentionne une garantie — lisible ou non (« garantie constructeur deux ans »). */
  mentioned: boolean;
  /** Segment « garantie… » dit tel quel (normalisé) — re-porté VERBATIM dans les followUps
   * quand la mention est illisible, pour que le fait survive aux tours suivants. */
  raw: string | null;
}

/** Extrait la fin de garantie dite — ou signale honnêtement une mention illisible. */
export function extractSpokenWarranty(message: string): SpokenWarranty {
  if (!/garanti/i.test(message)) return { date: null, mentioned: false, raw: null };
  const normalized = message
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase();
  const rawMatch = /(?:sous\s+)?garanti[^,;.]*/.exec(normalized);
  const raw = rawMatch ? rawMatch[0].replace(/\s+/g, ' ').trim() : null;

  const numericSlash = NUMERIC_SLASH.exec(normalized);
  if (numericSlash) {
    return {
      date: validated(`${numericSlash[3]}-${numericSlash[2]}-${numericSlash[1]}`),
      mentioned: true,
      raw,
    };
  }
  const numericIso = NUMERIC_ISO.exec(normalized);
  if (numericIso) {
    return {
      date: validated(`${numericIso[1]}-${numericIso[2]}-${numericIso[3]}`),
      mentioned: true,
      raw,
    };
  }
  const spokenDay = SPOKEN_DAY.exec(normalized);
  if (spokenDay) {
    const monthIndex = FRENCH_MONTHS.indexOf(spokenDay[2]!);
    return {
      date: validated(`${spokenDay[3]}-${pad2(monthIndex + 1)}-${pad2(Number(spokenDay[1]))}`),
      mentioned: true,
      raw,
    };
  }
  const spokenMonth = SPOKEN_MONTH.exec(normalized);
  if (spokenMonth) {
    const monthIndex = FRENCH_MONTHS.indexOf(spokenMonth[1]!);
    const year = Number(spokenMonth[2]);
    return {
      date: validated(`${spokenMonth[2]}-${pad2(monthIndex + 1)}-${pad2(lastDayOfMonth(year, monthIndex))}`),
      mentioned: true,
      raw,
    };
  }
  return { date: null, mentioned: true, raw };
}
