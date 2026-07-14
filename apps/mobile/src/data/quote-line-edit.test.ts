import { describe, expect, it } from 'vitest';
import {
  isValidQuoteLineLabel,
  parseQuoteLineEuroCents,
  parseQuoteLineQuantity,
} from '../components/quote-line-edit.logic';

describe('quote line edit parsing', () => {
  it.each([
    ['1', 1],
    ['2,5', 2.5],
    ['1.234', 1.234],
    [' 1\u202f000,125 ', 1_000.125],
  ])('parse une quantité française valide %s', (input, expected) => {
    expect(parseQuoteLineQuantity(input)).toBe(expected);
  });

  it.each(['', '0', '-1', '1,2345', '1000000,001', 'NaN'])('refuse une quantité invalide %s', (input) => {
    expect(parseQuoteLineQuantity(input)).toBeNull();
  });

  it.each([
    ['0', 0],
    ['12,5', 1_250],
    ['1\u202f200,05', 120_005],
    ['15000000', 1_500_000_000],
  ])('convertit un prix euros valide %s sans arrondi implicite', (input, expected) => {
    expect(parseQuoteLineEuroCents(input)).toBe(expected);
  });

  it.each(['', '-1', '1,005', '15000000,01', 'infini'])('refuse un prix invalide %s', (input) => {
    expect(parseQuoteLineEuroCents(input)).toBeNull();
  });

  it('valide le libellé imprimable et borné', () => {
    expect(isValidQuoteLineLabel(' Pose chauffe-eau ')).toBe(true);
    expect(isValidQuoteLineLabel('   ')).toBe(false);
    expect(isValidQuoteLineLabel('Pose\nforgée')).toBe(false);
    expect(isValidQuoteLineLabel('a'.repeat(501))).toBe(false);
  });
});
