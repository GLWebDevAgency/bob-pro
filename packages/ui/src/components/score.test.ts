import { describe, expect, it } from 'vitest';
import { clampScore, scoreBand, scoreFillPercent } from './score.logic';

describe('clampScore', () => {
  it('borne dans [0, 100]', () => {
    expect(clampScore(-5)).toBe(0);
    expect(clampScore(0)).toBe(0);
    expect(clampScore(62)).toBe(62);
    expect(clampScore(100)).toBe(100);
    expect(clampScore(150)).toBe(100);
  });

  it('traite NaN comme 0', () => {
    expect(clampScore(Number.NaN)).toBe(0);
  });
});

describe('scoreBand', () => {
  it('< 50 → danger', () => {
    expect(scoreBand(0)).toBe('danger');
    expect(scoreBand(49)).toBe('danger');
    expect(scoreBand(49.9)).toBe('danger');
  });

  it('50–75 → warning (bornes incluses)', () => {
    expect(scoreBand(50)).toBe('warning');
    expect(scoreBand(62)).toBe('warning');
    expect(scoreBand(75)).toBe('warning');
  });

  it('> 75 → success', () => {
    expect(scoreBand(75.1)).toBe('success');
    expect(scoreBand(100)).toBe('success');
  });

  it('borne avant de classer (hors plage)', () => {
    expect(scoreBand(-10)).toBe('danger');
    expect(scoreBand(140)).toBe('success');
  });
});

describe('scoreFillPercent', () => {
  it('égale le score borné', () => {
    expect(scoreFillPercent(62)).toBe(62);
    expect(scoreFillPercent(-10)).toBe(0);
    expect(scoreFillPercent(130)).toBe(100);
  });
});
