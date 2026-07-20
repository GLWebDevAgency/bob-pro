import { describe, expect, it } from 'vitest';
import {
  REVERSE_TRIAL_DAYS,
  startReverseTrial,
  trialDaysLeft,
  trialEffectiveTier,
  trialPhase,
} from './trial';

const T0 = '2026-07-14T09:00:00.000Z';

describe('startReverseTrial — 14 jours de Pro complet, sans carte bancaire', () => {
  it('borne l’essai à startedAt + 14 jours exactement', () => {
    const trial = startReverseTrial(T0);
    expect(trial.tier).toBe('pro');
    expect(trial.startedAt).toBe(T0);
    expect(trial.endsAt).toBe('2026-07-28T09:00:00.000Z');
  });

  it('durée personnalisable mais jamais nulle (plancher 1 jour)', () => {
    expect(startReverseTrial(T0, 'pro', 0).endsAt).toBe('2026-07-15T09:00:00.000Z');
  });
});

describe('trialDaysLeft / trialPhase — le compte honnête, arrondi POUR l’utilisateur', () => {
  const trial = startReverseTrial(T0);

  it('au départ : 14 jours, phase active', () => {
    expect(trialDaysLeft(trial, T0)).toBe(REVERSE_TRIAL_DAYS);
    expect(trialPhase(trial, T0)).toBe('active');
  });

  it('un jour entamé reste compté (ceil) — l’utilisateur ne perd jamais « son » jour', () => {
    expect(trialDaysLeft(trial, '2026-07-14T21:00:00.000Z')).toBe(14);
    expect(trialDaysLeft(trial, '2026-07-15T09:00:00.001Z')).toBe(13);
  });

  it('≤3 jours restants → ending_soon (le moment de décider, pas de harceler)', () => {
    expect(trialPhase(trial, '2026-07-25T10:00:00.000Z')).toBe('ending_soon');
    expect(trialPhase(trial, '2026-07-24T09:00:00.000Z')).toBe('active'); // 4 jours pile
  });

  it('échéance atteinte → expired, jours restants 0 (jamais négatif)', () => {
    expect(trialPhase(trial, '2026-07-28T09:00:00.000Z')).toBe('expired');
    expect(trialDaysLeft(trial, '2026-08-01T00:00:00.000Z')).toBe(0);
  });
});

describe('trialEffectiveTier — le meilleur des deux mondes, jamais une rétrogradation', () => {
  const trial = startReverseTrial(T0);

  it('free en essai pro → pro pendant, free après (descente douce)', () => {
    expect(trialEffectiveTier('free', trial, T0)).toBe('pro');
    expect(trialEffectiveTier('free', trial, '2026-07-29T00:00:00.000Z')).toBe('free');
  });

  it('business payé + essai pro → business (un essai n’abaisse JAMAIS un palier payé)', () => {
    expect(trialEffectiveTier('business', trial, T0)).toBe('business');
  });

  it('sans essai → palier payé tel quel', () => {
    expect(trialEffectiveTier('solo', null, T0)).toBe('solo');
  });
});
