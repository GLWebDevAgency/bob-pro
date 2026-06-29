import { describe, it, expect } from 'vitest';
import { Money } from './money';

const unwrap = (cents: number): Money => {
  const r = Money.of(cents);
  if (!r.ok) throw new Error('montant invalide dans le test');
  return r.value;
};

describe('Money', () => {
  it('refuse un non-entier', () => {
    expect(Money.of(10.5).ok).toBe(false);
  });
  it('additionne et soustrait en centimes', () => {
    const a = unwrap(148000);
    const b = unwrap(14800);
    expect(a.add(b).cents).toBe(162800);
    expect(a.sub(b).cents).toBe(133200);
  });
  it('multiplie par un entier', () => {
    expect(unwrap(2000).mulInt(3).cents).toBe(6000);
  });
  it('zero et equals', () => {
    expect(Money.zero().cents).toBe(0);
    expect(unwrap(100).equals(unwrap(100))).toBe(true);
  });
});
