import { Prisma } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { canonicalPrismaVatRate } from './prisma-vat-rate';

describe('canonicalPrismaVatRate', () => {
  it.each([
    ['0', 0],
    ['2.10', 2.1],
    ['5.5000', 5.5],
    ['10.0', 10],
    ['20.000', 20],
  ] as const)('décode exactement le NUMERIC %s', (decimal, expected) => {
    expect(canonicalPrismaVatRate(new Prisma.Decimal(decimal))).toBe(expected);
  });

  it.each([
    '-0.1',
    '2.1000000000000001',
    '5.4999999999999999',
    '7',
    '20.0000000000000001',
  ])('refuse le NUMERIC hors ensemble fermé %s', (decimal) => {
    expect(canonicalPrismaVatRate(new Prisma.Decimal(decimal))).toBeNull();
  });
});
