import { describe, expect, it } from 'vitest';
import { quoteRelancePromptOf } from './quote-relance-prompt.logic';

/**
 * PR-05 — la promesse du rappel « un message pré-rédigé vous attend » (deep link /devis/[id])
 * est TENUE par la fiche devis : même palier que le cron (quoteRelancePalierOf), même copy que
 * la carte Aujourd'hui (buildQuoteRelance), fail-closed hors palier.
 */

const BASE = {
  status: 'sent' as const,
  issuedAt: '2026-07-01',
  number: 'D-2026-0042',
  ttcCents: 480_000,
  customerName: 'SARL Martin Rénovation',
  personality: 'Pro' as const,
};

describe('quoteRelancePromptOf — message pré-rédigé au palier atteint (fiche devis)', () => {
  it('J+14 : aucun palier — pas de carte (même dérivation que le cron)', () => {
    expect(quoteRelancePromptOf({ ...BASE, today: '2026-07-15' })).toBeNull();
  });

  it('J+15 : palier j15 — le message buildQuoteRelance est prêt, avec le lien ajouté au Share', () => {
    const prompt = quoteRelancePromptOf({ ...BASE, today: '2026-07-16' });
    expect(prompt).not.toBeNull();
    expect(prompt).toMatchObject({ palier: 'j15', daysSinceIssued: 15 });
    // L'aperçu est le VRAI corps pré-rédigé : destinataire, numéro, ancienneté — sans lien
    // (le lien de signature n'existe qu'au moment du partage, jamais une URL inventée).
    expect(prompt!.previewBody).toContain('SARL Martin Rénovation');
    expect(prompt!.previewBody).toContain('D-2026-0042');
    expect(prompt!.previewBody).toContain('15 jours');
    expect(prompt!.previewBody).not.toContain('http');
    const shared = prompt!.buildShareMessage('https://sign.bobpro.fr/s/tok-1');
    expect(shared).toContain('https://sign.bobpro.fr/s/tok-1');
    expect(shared).toContain('SARL Martin Rénovation');
  });

  it('J+30 et devis « viewed » : palier j30 (l’escalade suit l’ancienneté réelle)', () => {
    const prompt = quoteRelancePromptOf({ ...BASE, status: 'viewed', today: '2026-08-05' });
    expect(prompt).toMatchObject({ palier: 'j30', daysSinceIssued: 35 });
  });

  it('fail-closed : signé/refusé/brouillon, date d’ancrage absente ou client non résolu ⇒ null', () => {
    expect(quoteRelancePromptOf({ ...BASE, status: 'signed', today: '2026-07-20' })).toBeNull();
    expect(quoteRelancePromptOf({ ...BASE, status: 'draft', today: '2026-07-20' })).toBeNull();
    expect(quoteRelancePromptOf({ ...BASE, issuedAt: null, today: '2026-07-20' })).toBeNull();
    const { issuedAt: _omitted, ...withoutIssuedAt } = BASE;
    expect(quoteRelancePromptOf({ ...withoutIssuedAt, today: '2026-07-20' })).toBeNull();
    expect(
      quoteRelancePromptOf({ ...BASE, customerName: '', today: '2026-07-20' }),
    ).toBeNull();
  });

  it('la copy suit la personnalité (Pote tutoie… le vouvoiement reste de mise devant un client)', () => {
    const pote = quoteRelancePromptOf({ ...BASE, personality: 'Pote', today: '2026-07-16' });
    const pro = quoteRelancePromptOf({ ...BASE, personality: 'Pro', today: '2026-07-16' });
    expect(pote!.previewBody).not.toBe(pro!.previewBody);
  });
});
