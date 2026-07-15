import { describe, expect, it } from 'vitest';
import { dateOnlyToMonthYear, formatMonthYear, monthYearToDateOnly, parseSpokenMonthYear } from './fiscal-dates';

describe('fiscal-dates', () => {
  it('monthYearToDateOnly / dateOnlyToMonthYear font l’aller-retour', () => {
    expect(monthYearToDateOnly(3, 2026)).toBe('2026-03-01');
    expect(dateOnlyToMonthYear('2026-03-01')).toEqual({ month: 3, year: 2026 });
    expect(dateOnlyToMonthYear('pas une date')).toBeUndefined();
  });

  it('formatMonthYear rend « mars 2026 »', () => {
    expect(formatMonthYear('2026-03-01')).toBe('mars 2026');
    expect(formatMonthYear('2026-12-01')).toBe('décembre 2026');
  });

  it('parseSpokenMonthYear extrait mois+année d’un énoncé normalisé', () => {
    expect(parseSpokenMonthYear('j ai l acre depuis mars 2026')).toBe('2026-03-01');
    expect(parseSpokenMonthYear('depuis le mois d aout 2025')).toBe('2025-08-01');
    expect(parseSpokenMonthYear('j ai l acre')).toBeUndefined();
    expect(parseSpokenMonthYear('depuis fevrier')).toBeUndefined();
  });
});
