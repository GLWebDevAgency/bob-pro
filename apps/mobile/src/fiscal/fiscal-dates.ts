import type { DateOnly } from '@bob/core';

/** Mois FR, index 0 = janvier — partagé par le sélecteur mois/année (UI) et le parseur vocal. */
export const FR_MONTH_NAMES = [
  'janvier',
  'février',
  'mars',
  'avril',
  'mai',
  'juin',
  'juillet',
  'août',
  'septembre',
  'octobre',
  'novembre',
  'décembre',
] as const;

/** Variante sans accents (le canal vocal passe par normalizeVoiceText, @bob/core). */
const FR_MONTH_NAMES_ASCII = [
  'janvier',
  'fevrier',
  'mars',
  'avril',
  'mai',
  'juin',
  'juillet',
  'aout',
  'septembre',
  'octobre',
  'novembre',
  'decembre',
] as const;

/** DateOnly "YYYY-MM-01" (jour toujours 1 — seuls mois/année comptent pour l'ACRE). */
export function monthYearToDateOnly(month: number, year: number): DateOnly {
  return `${year}-${String(month).padStart(2, '0')}-01`;
}

/** "2026-03-01" → { month: 3 (1-12), year: 2026 } — undefined si la chaîne est invalide. */
export function dateOnlyToMonthYear(date: DateOnly): { month: number; year: number } | undefined {
  const m = /^(\d{4})-(\d{2})-\d{2}$/.exec(date);
  if (!m) return undefined;
  const year = Number(m[1]);
  const month = Number(m[2]);
  if (month < 1 || month > 12) return undefined;
  return { month, year };
}

/** "2026-03-01" → "mars 2026" (voix de Bob / affichage). */
export function formatMonthYear(date: DateOnly): string {
  const parsed = dateOnlyToMonthYear(date);
  if (!parsed) return date;
  return `${FR_MONTH_NAMES[parsed.month - 1]} ${parsed.year}`;
}

/**
 * Extrait un mois+année d'un énoncé DÉJÀ normalisé (normalizeVoiceText + frSpokenNumbersToDigits,
 * @bob/core — les nombres énoncés en toutes lettres sont déjà des chiffres à ce stade). Cherche
 * un nom de mois FR suivi d'une année à 4 chiffres dans les ~8 caractères suivants (« depuis mars
 * 2026 », « mars, 2026 »…). `undefined` si aucun mois+année exploitable — jamais une date inventée.
 */
export function parseSpokenMonthYear(normalizedDigits: string): DateOnly | undefined {
  const pattern = new RegExp(`\\b(${FR_MONTH_NAMES_ASCII.join('|')})\\b[^0-9]{0,8}(\\d{4})\\b`);
  const match = pattern.exec(normalizedDigits);
  if (!match) return undefined;
  const monthIndex = FR_MONTH_NAMES_ASCII.indexOf(match[1] as (typeof FR_MONTH_NAMES_ASCII)[number]);
  const year = Number(match[2]);
  if (monthIndex < 0 || year < 2000 || year > 2100) return undefined;
  return monthYearToDateOnly(monthIndex + 1, year);
}
