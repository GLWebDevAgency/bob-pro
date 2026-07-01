import { describe, it, expect } from 'vitest';
import { parseVoiceConsent, buildSpokenConfirmation, normalizeTranscript } from './voice-confirm';

describe('parseVoiceConsent (fail-safe)', () => {
  it('affirmatifs explicites -> confirm', () => {
    for (const t of ['oui', 'Oui, je confirme', "c'est bon", "d'accord", 'vas-y', 'ok', 'okay', 'parfait', 'envoie', 'Go !']) {
      expect(parseVoiceConsent(t)).toBe('confirm');
    }
  });

  it('annulations explicites -> cancel', () => {
    for (const t of ['non', 'annule', 'Annuler', 'stop', 'laisse tomber', 'pas maintenant', 'plus tard', 'arrête', 'négatif']) {
      expect(parseVoiceConsent(t)).toBe('cancel');
    }
  });

  it('négation d’un affirmatif ne confirme JAMAIS', () => {
    expect(parseVoiceConsent('je ne confirme pas')).not.toBe('confirm');
    expect(parseVoiceConsent("je n'ai pas dit oui")).not.toBe('confirm');
  });

  it('ambigu -> unclear', () => {
    for (const t of ['peut-être', 'euh je sais pas', 'hein', 'comment ?', '', '   ']) {
      expect(parseVoiceConsent(t)).toBe('unclear');
    }
  });

  it('annulation prioritaire sur affirmatif (fail-safe)', () => {
    expect(parseVoiceConsent('oui mais non, annule')).toBe('cancel');
  });

  it('normalizeTranscript : minuscule, sans accents, encadré d’espaces', () => {
    expect(normalizeTranscript("Arrête !")).toBe(' arrete ');
  });
});

describe('buildSpokenConfirmation', () => {
  it('reprend le libellé du domaine (montant réel) sans rien inventer', () => {
    const s = buildSpokenConfirmation('Encaisser 2026-014 · 1 320,00 € (Durand SARL)');
    expect(s).toContain('1 320,00 €');
    expect(s).toContain('je confirme');
    expect(s).toContain('annule');
  });
});
