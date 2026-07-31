import { describe, expect, it } from 'vitest';
import { billingUnitToUneceCode } from './billing-unit';

describe('billingUnitToUneceCode — UN/ECE Recommendation 20', () => {
  it.each([
    [undefined, 'C62'],
    ['', 'C62'],
    ['unit', 'C62'],
    ['pièces', 'C62'],
    ['1 h', 'HUR'],
    ['heures', 'HUR'],
    ['jour', 'DAY'],
    ['mètre', 'MTR'],
    ['km', 'KMT'],
    ['m²', 'MTK'],
    ['m3', 'MTQ'],
    ['kg', 'KGM'],
    ['litres', 'LTR'],
    ['forfait', 'LS'],
  ] as const)('mappe %s vers %s sans perdre l’unité métier', (unit, expected) => {
    expect(billingUnitToUneceCode(unit)).toEqual({ ok: true, value: expected });
  });

  it('refuse une unité libre inconnue au lieu de la transformer en unité générique', () => {
    expect(billingUnitToUneceCode('palette spéciale')).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION', field: 'unit' },
    });
    expect(billingUnitToUneceCode('constructor')).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION', field: 'unit' },
    });
  });
});
