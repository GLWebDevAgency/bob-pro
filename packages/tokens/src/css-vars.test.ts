import { describe, it, expect } from 'vitest';
import { themes, toCssVars } from './index';

describe('toCssVars (web)', () => {
  it('expose le thème actif en variables CSS --brand-*', () => {
    const vars = toCssVars(themes.marine);
    expect(vars['--brand-d1']).toBe('#0C2340');
    expect(vars['--brand-ink2']).toBe('#1B3A63');
    expect(vars['--brand-gradient-header']).toContain('linear-gradient(168deg');
    expect(vars['--brand-gradient-header']).toContain('#0C2340');
  });

  it('suit le switch de thème', () => {
    expect(toCssVars(themes.indigo)['--brand-d3']).toBe('#4F46E5');
    expect(toCssVars(themes.foret)['--brand-d1']).toBe('#0A3A2B');
  });

  it('épingle les angles des dégradés dérivés (header 168 · hero 150 · fab 145 · cta 135)', () => {
    const vars = toCssVars(themes.marine);
    expect(vars['--brand-gradient-header']).toContain('168deg');
    expect(vars['--brand-gradient-hero']).toContain('150deg');
    expect(vars['--brand-gradient-fab']).toContain('145deg');
    expect(vars['--brand-gradient-cta']).toContain('135deg');
  });
});
