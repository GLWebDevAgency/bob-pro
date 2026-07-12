import { describe, it, expect } from 'vitest';
import { echoOverlap, parseBargeIn } from './echo-guard';

const BOB_SAYS = 'Tu peux te verser 1 842,50 € ce mois-ci sans problème, le reste il faut le garder pour la TVA et les charges.';

describe('parseBargeIn (LIVE-3) — fail-safe : au doute, écho (le tap reste roi)', () => {
  it('mot d’arrêt explicite : interruption, même mêlé à l’écho', () => {
    expect(parseBargeIn('stop', BOB_SAYS)).toBe('interrupt');
    expect(parseBargeIn('attends attends', BOB_SAYS)).toBe('interrupt');
    expect(parseBargeIn('verser le reste stop', BOB_SAYS)).toBe('interrupt');
  });

  it('l’écho du TTS capté par le micro : IGNORÉ (Bob ne s’auto-interrompt jamais)', () => {
    expect(parseBargeIn('tu peux te verser 1 842 50 ce mois-ci sans problème', BOB_SAYS)).toBe('echo');
    expect(parseBargeIn('le reste il faut le garder pour la TVA', BOB_SAYS)).toBe('echo');
  });

  it('parole NOUVELLE et substantielle : coupe Bob (speech)', () => {
    expect(parseBargeIn('encaisse plutôt la facture de la mairie', BOB_SAYS)).toBe('speech');
    expect(parseBargeIn('montre-moi mes échéances fiscales', BOB_SAYS)).toBe('speech');
  });

  it('bruit court, vide, borborygme : écho (jamais de coupure sur un « euh »)', () => {
    expect(parseBargeIn('euh', BOB_SAYS)).toBe('echo');
    expect(parseBargeIn('', BOB_SAYS)).toBe('echo');
    expect(parseBargeIn('ouais', BOB_SAYS)).toBe('echo');
  });

  it('echoOverlap : 1 quand tout vient du TTS, bas quand la parole est neuve', () => {
    expect(echoOverlap('verser le reste', BOB_SAYS)).toBe(1);
    expect(echoOverlap('relance la boulangerie maintenant', BOB_SAYS)).toBeLessThan(0.4);
  });
});
