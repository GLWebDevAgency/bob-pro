import { describe, expect, it } from 'vitest';
import { type as typeScale } from '@bob/tokens';
import { moneyTypeKey } from './money-text.logic';

describe('moneyTypeKey', () => {
  it('hero → heroNum (42/800)', () => {
    expect(moneyTypeKey('hero')).toBe('heroNum');
    expect(typeScale[moneyTypeKey('hero')]).toMatchObject({ size: 42, weight: 800 });
  });

  it('big → bigNum (21/800)', () => {
    expect(moneyTypeKey('big')).toBe('bigNum');
    expect(typeScale[moneyTypeKey('big')]).toMatchObject({ size: 21, weight: 800 });
  });

  it('body → body', () => {
    expect(moneyTypeKey('body')).toBe('body');
  });
});
