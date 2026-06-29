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
