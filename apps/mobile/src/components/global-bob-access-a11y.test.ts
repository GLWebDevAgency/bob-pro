import { describe, expect, it } from 'vitest';
import { deriveGlobalBobAccessibilityAnnouncement } from './global-bob-access-a11y';

describe('GlobalBobAccess — annonce VoiceOver', () => {
  it('reste silencieux lorsque Bob est masqué ou au repos', () => {
    expect(deriveGlobalBobAccessibilityAnnouncement({
      visible: false,
      announceActiveState: true,
      stateLabel: "J'écoute",
      silentAlert: null,
    })).toBeNull();
    expect(deriveGlobalBobAccessibilityAnnouncement({
      visible: true,
      announceActiveState: false,
      stateLabel: 'Prêt',
      silentAlert: null,
    })).toBeNull();
  });

  it('annonce les phases silencieuses et privilégie une alerte non vocalisée', () => {
    expect(deriveGlobalBobAccessibilityAnnouncement({
      visible: true,
      announceActiveState: true,
      stateLabel: "J'écoute",
      silentAlert: null,
    })).toBe("J'écoute");
    expect(deriveGlobalBobAccessibilityAnnouncement({
      visible: true,
      announceActiveState: true,
      stateLabel: 'Bob parle',
      silentAlert: '  Assistant indisponible.  ',
    })).toBe('Assistant indisponible.');
  });

  it('ne reçoit jamais le texte déjà prononcé par Bob', () => {
    expect(deriveGlobalBobAccessibilityAnnouncement({
      visible: true,
      announceActiveState: false,
      stateLabel: 'Bob parle',
      silentAlert: null,
    })).toBeNull();
  });
});
