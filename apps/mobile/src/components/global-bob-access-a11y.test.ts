import { describe, expect, it } from 'vitest';
import {
  composeGlobalBobSilentIssueAlert,
  deriveGlobalBobAccessibilityAnnouncement,
  deriveGlobalBobAccessibilityLiveRegion,
} from './global-bob-access-a11y';

describe('GlobalBobAccess — annonces des lecteurs d’écran', () => {
  it('annonce la cause précise avant la sortie texte, sans se limiter à « erreur »', () => {
    expect(composeGlobalBobSilentIssueAlert({
      response: 'La dictée locale est indisponible.',
      fallbackStateLabel: 'La demande a échoué',
      recoveryActionLabel: 'Écrire dans l’Assistant',
    })).toBe('La dictée locale est indisponible. Écrire dans l’Assistant');
    expect(composeGlobalBobSilentIssueAlert({
      response: null,
      fallbackStateLabel: 'La demande a échoué',
      recoveryActionLabel: null,
    })).toBe('La demande a échoué');
  });

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

  it('n’active TalkBack que pour les états silencieux ou une erreur', () => {
    expect(deriveGlobalBobAccessibilityLiveRegion({
      visible: true,
      announceActiveState: true,
      stateLabel: "J'écoute",
      silentAlert: null,
    })).toBe('polite');
    expect(deriveGlobalBobAccessibilityLiveRegion({
      visible: true,
      announceActiveState: false,
      stateLabel: 'Bob parle',
      silentAlert: null,
    })).toBe('none');
    expect(deriveGlobalBobAccessibilityLiveRegion({
      visible: true,
      announceActiveState: false,
      stateLabel: 'Erreur',
      silentAlert: 'Micro indisponible',
    })).toBe('assertive');
    expect(deriveGlobalBobAccessibilityLiveRegion({
      visible: false,
      announceActiveState: true,
      stateLabel: "J'écoute",
      silentAlert: null,
    })).toBe('none');
  });
});
