import { describe, expect, it } from 'vitest';
import {
  equivalentBillingUnitReferences,
  MAX_BILLING_UNIT_REFERENCE_LENGTH,
  resolveBillingUnitReference,
} from './billing-unit-reference';

describe('resolveBillingUnitReference', () => {
  it.each([
    ['heure', 'heure'],
    ['heures', 'heure'],
    ['h', 'heure'],
    ['1 h', 'heure'],
    ['JOURS', 'jour'],
    ['m²', 'm²'],
    ['m 3', 'm³'],
    ['kilomètres', 'kilomètre'],
    ['pièces', 'pièce'],
    ['lots', 'lot'],
  ] as const)('canonise l’alias standard %s vers %s', (input, expected) => {
    expect(resolveBillingUnitReference(input)).toMatchObject({
      value: expected,
      standard: expected,
    });
  });

  it('conserve une unité métier libre sans singularisation inventée', () => {
    expect(resolveBillingUnitReference('  machine  ')).toEqual({
      value: 'machine',
      standard: null,
    });
    expect(resolveBillingUnitReference('machines')).toEqual({
      value: 'machines',
      standard: null,
    });
    expect(resolveBillingUnitReference('constructor')).toEqual({
      value: 'constructor',
      standard: null,
    });
  });

  it.each([
    null,
    undefined,
    '',
    '   ',
    'heure\njour',
    'heure\u200b',
    'heure\u2028jour',
    'heure\u2029jour',
    '\u0301',
    'u'.repeat(MAX_BILLING_UNIT_REFERENCE_LENGTH + 1),
  ])('refuse une référence absente ou syntaxiquement invalide %#', (input) => {
    expect(resolveBillingUnitReference(input)).toBeNull();
  });
});

describe('equivalentBillingUnitReferences', () => {
  it.each(['heure', 'heures', 'h', 'hrs', '1 h'])(
    'reconnaît %s comme la même unité métier que heure',
    (input) => {
      expect(equivalentBillingUnitReferences(input, 'heure')).toBe(true);
    },
  );

  it.each([
    [null, null],
    [null, 'unité'],
    ['heure', 'jour'],
    ['heure', 'forfait'],
    ['unité', 'pièce'],
    ['forfait', 'lot'],
    ['machine', 'machines'],
  ])('ne fusionne pas deux références distinctes %#', (left, right) => {
    expect(equivalentBillingUnitReferences(left, right)).toBe(false);
  });
});
