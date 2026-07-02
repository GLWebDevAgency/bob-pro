import { describe, it, expect } from 'vitest';
import { DEFAULT_PERSONALITY, PERSONALITY_LABELS, normalizePersonality, t } from './index';

describe('i18n', () => {
  it("t('bob.greeting') retourne une chaîne fr non vide (défaut Pote)", () => {
    expect(DEFAULT_PERSONALITY).toBe('pote');
    expect(t('bob.greeting').length).toBeGreaterThan(0);
    expect(t('bob.greeting', { params: { name: 'Julien' } })).toBe('Salut Julien 👋');
  });

  it('décline la même clé par personnalité (Pote/Pro/Direct)', () => {
    expect(t('bob.greeting', { personality: 'pro', params: { name: 'Julien' } })).toBe(
      'Bonjour Julien',
    );
    expect(t('bob.greeting', { personality: 'direct', params: { name: 'Julien' } })).toBe(
      'Julien —',
    );
  });

  it('laisse le placeholder intact si le paramètre manque', () => {
    expect(t('bob.greeting')).toBe('Salut {name} 👋');
  });

  it("migre les personnalités legacy 'Pote'/'Pro'/'Direct' vers les ids canoniques", () => {
    expect(normalizePersonality('Pote')).toBe('pote');
    expect(normalizePersonality('Direct')).toBe('direct');
    expect(normalizePersonality('pro')).toBe('pro');
    expect(normalizePersonality('Comptable')).toBe(DEFAULT_PERSONALITY);
    expect(normalizePersonality(undefined)).toBe(DEFAULT_PERSONALITY);
  });

  it("expose les libellés d'affichage sans toucher aux ids", () => {
    expect(PERSONALITY_LABELS.pote).toBe('Pote');
    expect(PERSONALITY_LABELS[normalizePersonality('Direct')]).toBe('Direct');
  });

  it("today.subtitle interpole {count} sur les 3 humeurs (variante n=0 séparée)", () => {
    expect(t('today.subtitle', { params: { count: 3 } })).toBe(
      '3 trucs à régler, et après tu factures tranquille.',
    );
    expect(t('today.subtitle', { personality: 'pro', params: { count: 3 } })).toBe(
      'Vous avez 3 priorités à traiter aujourd’hui.',
    );
    expect(t('today.subtitle', { personality: 'direct', params: { count: 3 } })).toBe(
      '3 priorités. Go.',
    );
    expect(t('today.subtitleNone')).toBe('Rien d’urgent. Profites-en.');
    expect(t('today.subtitleNone', { personality: 'direct' })).toBe('RAS.');
  });

  it('today.payoutHint interpole {amount} sur les 3 humeurs', () => {
    expect(t('today.payoutHint', { params: { amount: '2 000,00 €' } })).toBe(
      'Tu peux te verser ~2 000,00 € sans te mettre dans le rouge',
    );
    expect(t('today.payoutHint', { personality: 'pro', params: { amount: '2 000,00 €' } })).toBe(
      'Versement possible : 2 000,00 €, TVA et charges provisionnées.',
    );
    expect(t('today.payoutHint', { personality: 'direct', params: { amount: '2 000,00 €' } })).toBe(
      'Te verser : ~2 000,00 €.',
    );
  });

  it('today.footer décline les 3 humeurs (VOICE_AND_TONE § Pied de page)', () => {
    expect(t('today.footer')).toBe('C’est tout pour aujourd’hui. Va bosser 🔧');
    expect(t('today.footer', { personality: 'pro' })).toBe('Vous êtes à jour pour aujourd’hui.');
    expect(t('today.footer', { personality: 'direct' })).toBe('Fini pour aujourd’hui.');
  });

  it('argent.* : copy pote exacte du proto (C11 — « LE SOLDE MENT »)', () => {
    expect(t('argent.subtitle')).toBe('Le vrai état des comptes, sans te mentir.');
    expect(t('argent.heroLabel')).toBe('Ce mois-ci, tu peux te verser');
    expect(t('argent.heroPill')).toBe('sans risque');
    expect(t('argent.soldeMent').toUpperCase()).toBe('LE SOLDE MENT');
    expect(t('argent.tipTitle')).toBe('Ton vrai dispo, pas le solde');
  });

  it('argent.bandCreux décline les 3 humeurs (notes de tranche de la prévision)', () => {
    expect(t('argent.bandCreux')).toBe('Creux, surveille');
    expect(t('argent.bandCreux', { personality: 'pro' })).toBe('Creux à surveiller');
    expect(t('argent.bandCreux', { personality: 'direct' })).toBe('Creux');
    expect(t('argent.bandPasse')).toBe('Ça passe');
  });

  it('argent.heroUpside interpole {upTo}/{name}/{amount} et les relances gèrent le singulier/pluriel', () => {
    expect(
      t('argent.heroUpside', { params: { upTo: '3 400 €', name: 'Martin', amount: '1 240 €' } }),
    ).toBe('Tu peux monter à 3 400 € si Martin règle ses 1 240 €. Je te préviens dès qu’il paie.');
    expect(t('argent.ctaRelanceOne')).toBe('Laisse l’assistant relancer ce client');
    expect(t('argent.ctaRelanceMany', { params: { count: 2 } })).toBe(
      'Laisse l’assistant relancer 2 clients',
    );
  });

  it('refuse une clé inconnue à la compilation', () => {
    // @ts-expect-error — 'cle.inconnue' n'est pas une I18nKey : garantie compile-time.
    const invalid: () => string = () => t('cle.inconnue');
    expect(typeof invalid).toBe('function');
  });
});
