import { describe, expect, it } from 'vitest';
import { deriveGlobalBobAccessibilityAnnouncement } from './global-bob-access-a11y';

describe('GlobalBobAccess — annonce VoiceOver', () => {
  it('reste silencieux lorsque Bob est masqué ou au repos', () => {
    expect(deriveGlobalBobAccessibilityAnnouncement({
      visible: false,
      active: true,
      stateLabel: "J'écoute",
      response: null,
      reviewRequiredLabel: null,
    })).toBeNull();
    expect(deriveGlobalBobAccessibilityAnnouncement({
      visible: true,
      active: false,
      stateLabel: 'Prêt',
      response: null,
      reviewRequiredLabel: null,
    })).toBeNull();
  });

  it('annonce les phases actives et privilégie la réponse utile', () => {
    expect(deriveGlobalBobAccessibilityAnnouncement({
      visible: true,
      active: true,
      stateLabel: "J'écoute",
      response: null,
      reviewRequiredLabel: null,
    })).toBe("J'écoute");
    expect(deriveGlobalBobAccessibilityAnnouncement({
      visible: true,
      active: false,
      stateLabel: 'Prêt',
      response: '  Ton devis est prêt.  ',
      reviewRequiredLabel: 'Validation requise',
    })).toBe('Ton devis est prêt. Validation requise');
  });
});
