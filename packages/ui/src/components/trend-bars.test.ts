/**
 * TrendBars — logique pure (Lot 5) : résolution du droit d'animer (fail-closed sur les
 * TROIS états de préférence) et bornage honnête des parts. Chaque assertion est un littéral :
 * un mutant qui inverse `preference === 'inactive'`, change 400, ou retire une borne MEURT ici.
 */
import { describe, expect, it } from 'vitest';
import {
  TREND_BARS_ANIMATION_MS,
  clampTrendBarPct,
  ratchetTrendBarsMotion,
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

describe('ratchetTrendBarsMotion — la décision est FIGÉE au montage, une seule direction', () => {
  it('première frame (granted null) : la décision suit la préférence courante', () => {
    expect(ratchetTrendBarsMotion(null, 'unknown')).toBe(false);
    expect(ratchetTrendBarsMotion(null, 'active')).toBe(false);
    expect(ratchetTrendBarsMotion(null, 'inactive')).toBe(true);
  });

  it("LE mutant du verdict : première frame statique + résolution tardive 'inactive' ⇒ RESTE statique", () => {
    // granted=false (frame 1 sous ignorance) puis préférence résolue 'inactive' : jamais
    // de ré-armement — la largeur vraie déjà peinte ne retombe pas pour rejouer la poussée.
    expect(ratchetTrendBarsMotion(false, 'inactive')).toBe(false);
  });

  it("bascule 'active' en vol : l'animation accordée est coupée, définitivement", () => {
    expect(ratchetTrendBarsMotion(true, 'active')).toBe(false);
    expect(ratchetTrendBarsMotion(true, 'unknown')).toBe(false);
    // Et une fois coupée, le retour à 'inactive' ne la ré-arme jamais dans ce montage.
    expect(ratchetTrendBarsMotion(false, 'inactive')).toBe(false);
  });

  it('accordée au montage et préférence toujours inactive ⇒ reste accordée', () => {
    expect(ratchetTrendBarsMotion(true, 'inactive')).toBe(true);
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
