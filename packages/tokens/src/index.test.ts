import { describe, it, expect } from 'vitest';
import { themes, defaultTheme, gradients, type, radius } from './index';

describe('tokens', () => {
  it('expose les 4 thèmes de marque avec marine par défaut', () => {
    expect(Object.keys(themes)).toEqual(['marine', 'foret', 'graphite', 'indigo']);
    expect(defaultTheme).toBe('marine');
    expect(themes.marine.d1).toBe('#0C2340');
  });
  it('dérive les dégradés du thème actif', () => {
    const g = gradients(themes.marine);
    expect(g.header).toContain('#0C2340');
    expect(g.cta).toContain('linear-gradient');
  });
  it('échelle typographique et rayons figés', () => {
    expect(type.heroNum.size).toBe(42);
    expect(radius.card).toBe(16);
  });
});
