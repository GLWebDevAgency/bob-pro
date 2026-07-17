import { describe, expect, it } from 'vitest';
import { formatCentsForEuroInput, parseEuroAmountToCents } from './parse-euro-amount';

describe('parseEuroAmountToCents', () => {
  it.each([
    ['1 234,56 €', 123_456],
    ['1234.5', 123_450],
    ['-250,00', -25_000],
    ['0', 0],
  ])('parse %s sans erreur flottante', (raw, expected) => {
    expect(parseEuroAmountToCents(raw)).toBe(expected);
  });

  it.each(['', '12,345', '1e3', 'NaN', '--2', '9'.repeat(30)])('rejette %s', (raw) => {
    expect(parseEuroAmountToCents(raw)).toBeNull();
  });

  it('formate les centimes pour une réédition explicite', () => {
    expect(formatCentsForEuroInput(-25_001)).toBe('-250,01');
  });
});
