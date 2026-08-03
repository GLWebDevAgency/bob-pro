/**
 * TrendBars — logique pure (Lot 5) : résolution du droit d'animer (fail-closed sur les
 * TROIS états de préférence) et bornage honnête des parts. Chaque assertion est un littéral :
 * un mutant qui inverse `preference === 'inactive'`, change 400, ou retire une borne MEURT ici.
 */
import { describe, expect, it } from 'vitest';
import {
  TREND_BARS_ANIMATION_MS,
  clampTrendBarPct,
  resolveTrendBarsMotion,
} from './trend-bars.logic';

describe('resolveTrendBarsMotion — fail-closed par construction', () => {
  it("'unknown' (la fenêtre d'ignorance) ⇒ statique, durée 0 — jamais « probablement pas réduit »", () => {
    expect(resolveTrendBarsMotion('unknown')).toEqual({ animated: false, durationMs: 0 });
  });

  it("'active' (réduction demandée) ⇒ statique, durée 0", () => {
    expect(resolveTrendBarsMotion('active')).toEqual({ animated: false, durationMs: 0 });
  });

  it("'inactive' (résolue : pas de réduction) ⇒ animé, 400 ms exactement", () => {
    expect(resolveTrendBarsMotion('inactive')).toEqual({ animated: true, durationMs: 400 });
    expect(TREND_BARS_ANIMATION_MS).toBe(400);
  });
});

describe('clampTrendBarPct — la dataviz honnête ne dessine jamais un mensonge', () => {
  it('borne [0, 100] : négatif → 0, dépassement → 100, valeur légitime intacte', () => {
    expect(clampTrendBarPct(-5)).toBe(0);
    expect(clampTrendBarPct(0)).toBe(0);
    expect(clampTrendBarPct(42)).toBe(42);
    expect(clampTrendBarPct(100)).toBe(100);
    expect(clampTrendBarPct(130)).toBe(100);
  });

  it('NaN / Infinity (division par un max nul en amont) → 0, jamais une barre fantôme', () => {
    expect(clampTrendBarPct(Number.NaN)).toBe(0);
    expect(clampTrendBarPct(Number.POSITIVE_INFINITY)).toBe(0);
    expect(clampTrendBarPct(Number.NEGATIVE_INFINITY)).toBe(0);
  });
});
