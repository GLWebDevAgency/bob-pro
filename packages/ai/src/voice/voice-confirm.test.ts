import { describe, it, expect } from 'vitest';
import { parseVoiceConsent, buildSpokenConfirmation, normalizeTranscript } from './voice-confirm';

describe('parseVoiceConsent (fail-safe)', () => {
  it('affirmatifs explicites -> confirm', () => {
    for (const t of ['oui', 'Oui, je confirme', "d'accord", "j'autorise", 'ok', 'okay']) {
      expect(parseVoiceConsent(t)).toBe('confirm');
    }
  });

  it('un verbe d action seul n est jamais un consentement', () => {
    for (const t of ['envoie', 'envoyer', 'valide', 'fais-le', 'go', 'parfait']) {
      expect(parseVoiceConsent(t)).toBe('unclear');
    }
  });

  it('« vas-y » consent naturel — jamais prononcé par Bob (purgé des libellés, absent des prompts)', () => {
    expect(parseVoiceConsent('vas-y')).toBe('confirm');
    expect(parseVoiceConsent('vas y')).toBe('confirm');
    expect(buildSpokenConfirmation('Envoyer le devis — vas-y disait le client')).not.toMatch(/vas[- ]?y/i);
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
  it('reprend le libellé du domaine (montant réel) sans prononcer de consentement accepté', () => {
    const s = buildSpokenConfirmation('Encaisser 2026-014 · 1 320,00 € (Durand SARL)');
    expect(s).toContain('1 320,00 €');
    expect(s).not.toContain('je confirme');
    expect(parseVoiceConsent(s)).not.toBe('confirm');
  });

  it('P0 : prompt et tous ses residus courts ne peuvent jamais confirmer, meme pour « Envoyer »', () => {
    const prompt = buildSpokenConfirmation(
      "Envoyer le devis D-2026-0014 — JE-CONFIRME, J/AUTORISE, D.ACCORD, oui et ok",
    );
    const words = normalizeTranscript(prompt).trim().split(/\s+/);
    expect(prompt).toContain('Envoyer le devis');
    expect(prompt).not.toMatch(/\b(oui|ok|je confirme|d[’']accord)\b/i);
    expect(parseVoiceConsent(prompt)).not.toBe('confirm');
    for (let size = 1; size <= 4; size += 1) {
      for (let index = 0; index + size <= words.length; index += 1) {
        expect(parseVoiceConsent(words.slice(index, index + size).join(' '))).not.toBe('confirm');
      }
    }
    expect(parseVoiceConsent('envoyer')).toBe('unclear');
    expect(parseVoiceConsent('autoriser cette action')).toBe('unclear');
  });
});
