export type DateOnly = string; // "YYYY-MM-DD"
export type Instant = string; // ISO 8601

export interface Clock {
  now(): Instant;
  today(): DateOnly;
}

export class SystemClock implements Clock {
  now(): Instant {
    return new Date().toISOString();
  }
  today(): DateOnly {
    return new Date().toISOString().slice(0, 10);
  }
}

const BUSINESS_TZ = 'Europe/Paris';

/**
 * Jour calendaire Europe/Paris (DST-safe : CET UTC+1 l'hiver / CEST UTC+2 l'été — les bascules
 * ont lieu à 02h/03h, jamais à minuit, donc un offset fixe serait faux deux fois par an) pour un
 * instant donné.
 *
 * C'est le « jour métier » d'un artisan français au sens de l'échéancier fiscal/URSSAF et de la
 * trésorerie (SPEC_EXPERT_FISCAL) : SOURCE UNIQUE à préférer à `SystemClock.today()` (UTC brut,
 * en décalage de 1 à 2 h avec Paris juste après minuit local — proche de minuit en France, un jour
 * "aujourd'hui" côté serveur UTC peut encore être "hier") et au fuseau ambiant d'un appareil (peut
 * dériver en déplacement ou en cas de mauvaise configuration système).
 *
 * Même technique que `apps/api/src/jobs/digest.service.ts` (`parisWallClock`/`parisDateOnly`,
 * déjà DST-safe et testée pour la fenêtre du digest hebdo), centralisée ici pour être partagée
 * SANS dupliquer la logique de fuseau entre le serveur (ex. `GetCashflow`) et le mobile
 * (ex. `argent.tsx`, remplace l'ancien `localToday()` device-local).
 */
export function parisDateOnly(at: Instant | Date = new Date()): DateOnly {
  const date = typeof at === 'string' ? new Date(at) : at;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: BUSINESS_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/**
 * Jour MÉTIER d'un fait daté, quel que soit son format de stockage : un Instant (présence d'un
 * 'T') est projeté sur le calendrier Europe/Paris via `parisDateOnly` (DST-safe) ; une DateOnly
 * pure est DÉJÀ un jour métier et reste telle quelle.
 *
 * LE convertisseur unique à traverser avant toute comparaison d'un horodatage stocké
 * (`receivedAt`, `terminatedAt`…) avec un jour/mois/année/trimestre du calendrier métier
 * (`businessToday`, bornes de période URSSAF, année civile 293 B…). Le tronquer en jour UTC
 * (`slice(0, 10)`) désynchronise les deux calendriers dans la fenêtre 22:00–00:00 UTC l'été /
 * 23:00–00:00 l'hiver : un encaissement de 00:00–~02:00 heure de Paris bascule dans la période
 * PRÉCÉDENTE — série mensuelle du pilotage (bug CI du 31/07/2026 22:18Z), assiette URSSAF du
 * micro, seuils de franchise 293 B dans la nuit du Nouvel An. Et un offset figé (+2 h toute
 * l'année) serait faux deux fois par an — d'où parisDateOnly, jamais d'arithmétique d'offset.
 */
export function businessDayOf(at: Instant | DateOnly): DateOnly {
  return at.includes('T') ? parisDateOnly(at) : at;
}

/** Valide une DateOnly "YYYY-MM-DD" en rejetant les dates calendaires impossibles (round-trip UTC). */
export function isValidDateOnly(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** Ajoute n jours à une DateOnly, en UTC, sans dépendance externe. */
export function addDays(date: DateOnly, days: number): DateOnly {
  const d = new Date(`${date}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
