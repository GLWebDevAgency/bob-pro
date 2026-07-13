import { describe, expect, it } from 'vitest';
import {
  SentenceAccumulator,
  splitSpokenSentences,
  summarizeVoiceLatency,
  voiceToVoiceMs,
} from './streaming';

describe('splitSpokenSentences — Bob parle dès la première phrase (BOB LIVE P1)', () => {
  it('découpe un briefing multi-phrases en segments prononçables', () => {
    const s = splitSpokenSentences(
      'Tu peux te verser 4 860,00 € sans risque. Je garde le reste pour la TVA. Trois factures attendent.',
    );
    expect(s).toHaveLength(3);
    expect(s[0]).toBe('Tu peux te verser 4 860,00 € sans risque.');
  });

  it('ne coupe JAMAIS un montant, un décimal, un numéro de pièce ou une abréviation', () => {
    const s = splitSpokenSentences('La facture 2026-014 de M. Durand fait 1 386,50 € TTC. Elle est en retard.');
    expect(s).toHaveLength(2);
    expect(s[0]).toContain('1 386,50 €');
    expect(s[0]).toContain('M. Durand');
  });

  it('les puces multilignes des cartes deviennent des segments distincts', () => {
    const s = splitSpokenSentences('• Statut : Émise\n• Reste dû : 415,80 €\n• Échéance : 20/07/2026');
    expect(s).toHaveLength(3);
  });

  it('un fragment trop court fusionne avec la phrase suivante (pas de « OK. » orphelin)', () => {
    const s = splitSpokenSentences('OK. Je prépare la relance pour Durand SARL maintenant.');
    expect(s).toHaveLength(1);
  });
});

describe('SentenceAccumulator — la même découpe en FLUX (P2/P3)', () => {
  it('rend chaque phrase dès qu’elle est complète, garde l’incomplète en tampon', () => {
    const acc = new SentenceAccumulator();
    expect(acc.push('Tu peux te verser 4 860,00 € ')).toEqual([]);
    expect(acc.push('sans risque. Je garde le reste ')).toEqual(['Tu peux te verser 4 860,00 € sans risque.']);
    expect(acc.push('pour la TVA.')).toEqual([]);
    expect(acc.flush()).toEqual(['Je garde le reste pour la TVA.']);
    expect(acc.flush()).toEqual([]);
  });
});

describe('VoiceLatencyTrace — on ne pilote que ce qu’on mesure', () => {
  it('voix→voix = fin de parole → premier audio ; p50/p95 agrégés', () => {
    const traces = [
      { sttFinalAt: 1_000, sayStartAt: 1_700 },
      { sttFinalAt: 2_000, sayStartAt: 2_600 },
      { sttFinalAt: 3_000, sayStartAt: 4_900 },
      { sttFinalAt: 5_000 }, // tour sans réponse vocale : ignoré des percentiles
    ];
    expect(voiceToVoiceMs(traces[0]!)).toBe(700);
    const summary = summarizeVoiceLatency(traces);
    expect(summary.turns).toBe(4);
    expect(summary.voiceToVoiceMsP50).toBe(700);
    expect(summary.voiceToVoiceMsP95).toBe(1_900);
    expect(summary.interruptMsP50).toBeNull();
  });

  it('une horloge incohérente (say avant stt) ne produit jamais une latence négative', () => {
    expect(voiceToVoiceMs({ sttFinalAt: 2_000, sayStartAt: 1_000 })).toBeNull();
  });
});
