import { describe, expect, it } from 'vitest';
import {
  FADE_IN_DURATION_MS,
  FADE_IN_TRANSLATE_PX,
  STAGGER_MAX_STEPS,
  STAGGER_STEP_MS,
  resolveFadeInMotion,
  staggerDelayMs,
} from './fade-in.logic';

describe('cascade des sections', () => {
  it('pas de cascade dans la fenêtre sobre 30-50 ms', () => {
    expect(STAGGER_STEP_MS).toBeGreaterThanOrEqual(30);
    expect(STAGGER_STEP_MS).toBeLessThanOrEqual(50);
  });

  it('fondu = petite transition (200-300 ms), translation ≤ 8 px (jamais un saut)', () => {
    expect(FADE_IN_DURATION_MS).toBeGreaterThanOrEqual(200);
    expect(FADE_IN_DURATION_MS).toBeLessThanOrEqual(300);
    expect(FADE_IN_TRANSLATE_PX).toBeLessThanOrEqual(8);
  });

  it('délai proportionnel au rang, borné au cap — une longue liste ne pleut pas', () => {
    expect(staggerDelayMs(0)).toBe(0);
    expect(staggerDelayMs(3)).toBe(3 * STAGGER_STEP_MS);
    expect(staggerDelayMs(STAGGER_MAX_STEPS + 12)).toBe(STAGGER_MAX_STEPS * STAGGER_STEP_MS);
  });

  it('rang négatif ou fractionnaire → jamais de délai négatif ni fractionnaire', () => {
    expect(staggerDelayMs(-2)).toBe(0);
    expect(staggerDelayMs(2.7)).toBe(2 * STAGGER_STEP_MS);
  });
});

describe('resolveFadeInMotion', () => {
  it('mouvement plein en rendu normal', () => {
    expect(resolveFadeInMotion(2, false)).toEqual({
      duration: FADE_IN_DURATION_MS,
      delay: 2 * STAGGER_STEP_MS,
      translate: FADE_IN_TRANSLATE_PX,
    });
  });

  it('reduced-motion → apparition immédiate (durée 0, délai 0, translation 0)', () => {
    expect(resolveFadeInMotion(5, true)).toEqual({ duration: 0, delay: 0, translate: 0 });
  });
});
