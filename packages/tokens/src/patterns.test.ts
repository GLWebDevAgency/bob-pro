import { describe, it, expect } from 'vitest';
import { patterns, radius, shadow } from './index';

describe('patterns (gestes signature v1.1)', () => {
  it('floatingBalanceCard : chevauchement −30, radius 22, montant 31/800', () => {
    expect(patterns.floatingBalanceCard.overlap).toBe(-30);
    expect(patterns.floatingBalanceCard.radius).toBe(22);
    expect(patterns.floatingBalanceCard.radius).toBe(radius.cardXl);
    expect(patterns.floatingBalanceCard.numberSize).toBe(31);
    expect(patterns.floatingBalanceCard.numberWeight).toBe(800);
    expect(patterns.floatingBalanceCard.elevation).toBe(shadow.e3);
  });

  it('innerScreenHeader et moneyRow figés', () => {
    expect(patterns.innerScreenHeader.paddingTop).toBe(56);
    expect(patterns.moneyRow.positive).toBe('#0E7C5A');
    expect(patterns.moneyRow.negative).toBe('#E5544B');
  });
});
