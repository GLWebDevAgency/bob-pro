import { addDays, isValidDateOnly, type DateOnly } from '../../shared-kernel/time';
import { normalizeVoiceText } from '../../flows/voice-invoice-draft';

/**
 * B9 — Recherche intelligente Devis & Factures : plage de dates SANS heure (bornes incluses,
 * toutes deux <= today — jamais dans le futur, une pièce n'a pas de date de demain).
 */
export interface PeriodRange {
  readonly from: DateOnly;
  readonly to: DateOnly;
}

/** Identifiant CANONIQUE de la période reconnue — sert de clé pour la chip active côté mobile. */
export type PeriodLabel =
  | 'today'
  | 'thisWeek'
  | 'thisMonth'
  | 'lastMonth'
  | 'thisYear'
  | `last${number}Months`
  | `since:${string}`;

export interface ParsedPeriod extends PeriodRange {
  readonly label: PeriodLabel;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function partsOf(today: DateOnly): { year: number; month0: number } {
  const [y, m] = today.split('-');
  return { year: Number(y), month0: Number(m) - 1 };
}

function monthRange(year: number, month0: number): PeriodRange {
  const from = `${year}-${pad2(month0 + 1)}-01`;
  const lastDay = new Date(Date.UTC(year, month0 + 1, 0)).getUTCDate();
  const to = `${year}-${pad2(month0 + 1)}-${pad2(lastDay)}`;
  return { from, to };
}

/** Chip « Ce mois-ci » : 1er du mois en cours -> aujourd'hui (jamais la fin de mois future). */
export function thisMonthRange(today: DateOnly): PeriodRange {
  const { year, month0 } = partsOf(today);
  const { from } = monthRange(year, month0);
  return { from, to: today };
}

/** Chip « Mois dernier » : mois calendaire PRÉCÉDENT complet (du 1er au dernier jour). */
export function lastMonthRange(today: DateOnly): PeriodRange {
  const { year, month0 } = partsOf(today);
  const prevMonth0 = month0 === 0 ? 11 : month0 - 1;
  const prevYear = month0 === 0 ? year - 1 : year;
  return monthRange(prevYear, prevMonth0);
}

/** Chip « N derniers mois » : 1er du mois il y a (n-1) mois -> aujourd'hui. n=2 pour la chip UI. */
export function lastNMonthsRange(today: DateOnly, n: number): PeriodRange {
  const { year, month0 } = partsOf(today);
  let startMonth0 = month0 - (n - 1);
  let startYear = year;
  while (startMonth0 < 0) {
    startMonth0 += 12;
    startYear -= 1;
  }
  return { from: `${startYear}-${pad2(startMonth0 + 1)}-01`, to: today };
}

const NUMBER_WORDS_FR: Readonly<Record<string, number>> = {
  un: 1, une: 1, deux: 2, trois: 3, quatre: 4, cinq: 5, six: 6, sept: 7, huit: 8, neuf: 9, dix: 10,
};

const MONTH_NAMES_FR: Readonly<Record<string, number>> = {
  janvier: 0,
  fevrier: 1,
  mars: 2,
  avril: 3,
  mai: 4,
  juin: 5,
  juillet: 6,
  aout: 7,
  septembre: 8,
  octobre: 9,
  novembre: 10,
  decembre: 11,
};

/**
 * Parseur PUR de périodes françaises parlées/tapées — aucune I/O, aucune horloge ambiante
 * (`today` fourni par l'appelant, donc testable à date fixe). Couvre les tournures utilisées
 * pour filtrer devis/factures à la voix (« les devis... du mois dernier ») ET les libellés des
 * chips de dates de l'écran Ventes, pour rester la SEULE source de vérité des deux. Retourne
 * `null` si rien de reconnu — jamais un pari sur une intention ambiguë.
 */
export function parseFrenchPeriod(utterance: string, today: DateOnly): ParsedPeriod | null {
  if (!isValidDateOnly(today)) return null;
  // normalizeVoiceText retire accents/ponctuation et pose un espace en tête/queue — les
  // tournures ci-dessous sont donc comparées sur des MOTS entiers, insensibles à "-"/accents.
  const n = normalizeVoiceText(utterance);

  if (/\bce mois\b/.test(n)) return { ...thisMonthRange(today), label: 'thisMonth' };
  if (/\b(le )?mois dernier\b/.test(n) || /\bmois precedent\b/.test(n)) {
    return { ...lastMonthRange(today), label: 'lastMonth' };
  }

  const lastN = /\b(les )?(\d{1,2}|un|une|deux|trois|quatre|cinq|six|sept|huit|neuf|dix) derniers? mois\b/.exec(n);
  if (lastN?.[2] !== undefined) {
    const word = lastN[2];
    const num = NUMBER_WORDS_FR[word] ?? Number(word);
    if (Number.isFinite(num) && num >= 1 && num <= 24) {
      return { ...lastNMonthsRange(today, num), label: `last${num}Months` };
    }
  }

  if (/\bcette semaine\b/.test(n)) {
    const dow = new Date(`${today}T00:00:00.000Z`).getUTCDay(); // 0 = dimanche
    const daysSinceMonday = dow === 0 ? 6 : dow - 1;
    return { from: addDays(today, -daysSinceMonday), to: today, label: 'thisWeek' };
  }

  if (/\baujourd ?hui\b/.test(n)) return { from: today, to: today, label: 'today' };

  if (/\bcette annee\b/.test(n) || /\bannee en cours\b/.test(n)) {
    const { year } = partsOf(today);
    return { from: `${year}-01-01`, to: today, label: 'thisYear' };
  }

  const since = /\bdepuis (?:le mois de |le |la |l )?([a-z]+)\b/.exec(n);
  if (since?.[1] !== undefined) {
    const month0 = MONTH_NAMES_FR[since[1]];
    if (month0 !== undefined) {
      const { year, month0: currentMonth0 } = partsOf(today);
      // Un mois "futur" énoncé (ex. "depuis décembre" dit en janvier) vise l'an dernier.
      const y = month0 > currentMonth0 ? year - 1 : year;
      return { from: `${y}-${pad2(month0 + 1)}-01`, to: today, label: `since:${since[1]}` };
    }
  }

  return null;
}
