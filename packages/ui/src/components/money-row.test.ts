import { describe, expect, it } from 'vitest';
import { patterns } from '@bob/tokens';
import { formatEUR } from '@bob/core';
import { moneyRowAmountColor, moneyRowAmountText } from './money-row.logic';

describe('moneyRowAmountColor', () => {
  it('teinte les montants positifs en success (patterns.moneyRow.positive)', () => {
    expect(moneyRowAmountColor(125_00)).toBe(patterns.moneyRow.positive);
  });

  it('teinte les montants négatifs en dangerVivid (patterns.moneyRow.negative)', () => {
    expect(moneyRowAmountColor(-49_90)).toBe(patterns.moneyRow.negative);
  });

  it('laisse le zéro en navy (neutre)', () => {
    expect(moneyRowAmountColor(0)).toBe(patterns.moneyRow.total);
  });

  it('force le navy sur la variante total, quel que soit le signe', () => {
    expect(moneyRowAmountColor(125_00, 'total')).toBe(patterns.moneyRow.total);
    expect(moneyRowAmountColor(-125_00, 'total')).toBe(patterns.moneyRow.total);
  });

  it('teinte la variante lead comme une ligne standard', () => {
    expect(moneyRowAmountColor(10_00, 'lead')).toBe(patterns.moneyRow.positive);
    expect(moneyRowAmountColor(-10_00, 'lead')).toBe(patterns.moneyRow.negative);
  });
});

describe('moneyRowAmountText', () => {
  it('préfixe « + » les montants positifs', () => {
    expect(moneyRowAmountText(162_800)).toBe(`+${formatEUR(162_800)}`);
    expect(moneyRowAmountText(162_800).startsWith('+')).toBe(true);
  });

  it('laisse formatEUR porter le signe négatif', () => {
    expect(moneyRowAmountText(-49_90)).toBe(formatEUR(-49_90));
    expect(moneyRowAmountText(-49_90).startsWith('-')).toBe(true);
  });

  it('n’ajoute pas de « + » sur le total ni sur le zéro', () => {
    expect(moneyRowAmountText(162_800, 'total')).toBe(formatEUR(162_800));
    expect(moneyRowAmountText(0)).toBe(formatEUR(0));
  });
});
