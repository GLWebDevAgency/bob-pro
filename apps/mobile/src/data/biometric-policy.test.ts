import { describe, expect, it } from 'vitest';
import {
  decideBiometricGate,
  isBiometricDecisionCurrent,
  shouldRelockBiometricSession,
} from './biometric-policy';

describe('isBiometricDecisionCurrent', () => {
  it('bloque toute réutilisation de la décision prise pour un autre utilisateur', () => {
    expect(
      isBiometricDecisionCurrent({
        authEnabled: true,
        userId: 'user-b',
        resolvedUserId: 'user-a',
      }),
    ).toBe(false);
    expect(
      isBiometricDecisionCurrent({
        authEnabled: true,
        userId: 'user-b',
        resolvedUserId: 'user-b',
      }),
    ).toBe(true);
  });

  it('ne bloque pas les écrans publics quand aucune session authentifiée n’existe', () => {
    expect(
      isBiometricDecisionCurrent({
        authEnabled: true,
        userId: null,
        resolvedUserId: 'user-a',
      }),
    ).toBe(true);
  });
});

describe('decideBiometricGate', () => {
  it('ne reverrouille jamais le mot de passe qui vient d’être validé', () => {
    expect(
      decideBiometricGate({
        freshPasswordLogin: true,
        optIn: true,
        supportAvailable: false,
      }),
    ).toBe('open');
  });

  it('propose la biométrie une seule fois après un login frais compatible', () => {
    expect(
      decideBiometricGate({
        freshPasswordLogin: true,
        optIn: null,
        supportAvailable: true,
      }),
    ).toBe('offer');
  });

  it('reste verrouillé après opt-in même si le matériel devient indisponible', () => {
    expect(
      decideBiometricGate({
        freshPasswordLogin: false,
        optIn: true,
        supportAvailable: false,
      }),
    ).toBe('locked');
  });

  it('laisse passer une session persistée sans opt-in', () => {
    expect(
      decideBiometricGate({
        freshPasswordLogin: false,
        optIn: false,
        supportAvailable: true,
      }),
    ).toBe('open');
  });

  it('reverrouille une session protégée après la période de grâce seulement', () => {
    expect(
      shouldRelockBiometricSession({
        protectionEnabled: true,
        backgroundedAtMs: 1_000,
        resumedAtMs: 30_999,
        thresholdMs: 30_000,
      }),
    ).toBe(false);
    expect(
      shouldRelockBiometricSession({
        protectionEnabled: true,
        backgroundedAtMs: 1_000,
        resumedAtMs: 31_000,
        thresholdMs: 30_000,
      }),
    ).toBe(true);
    expect(
      shouldRelockBiometricSession({
        protectionEnabled: false,
        backgroundedAtMs: 1_000,
        resumedAtMs: 99_000,
        thresholdMs: 30_000,
      }),
    ).toBe(false);
  });
});
