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

/** Ajoute n jours à une DateOnly, en UTC, sans dépendance externe. */
export function addDays(date: DateOnly, days: number): DateOnly {
  const d = new Date(`${date}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
