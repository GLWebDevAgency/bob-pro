import { describe, expect, it } from 'vitest';
import {
  ERROR_NOTICE_HIT_TARGET,
  errorNoticeAccessibilitySummary,
  errorNoticeDarkFace,
  errorNoticeReportText,
  resolveErrorNoticeCopy,
  shortCorrelation,
  shortTime,
} from './error-notice.logic';

describe('ErrorNotice — face sombre (Lot 0, plan DA 01/08)', () => {
  it('reprend la matière danger SOMBRE du kit en littéraux (surfaceTint.dark.danger, encres déjà certifiées AA)', () => {
    expect(errorNoticeDarkFace()).toEqual({
      border: '#622825',
      bg: '#351312',
      ink: '#FADDD9',
      inkMuted: '#E5A9A2',
      chipBg: '#481B19',
    });
  });
});

describe('ErrorNotice — logique des deux faces', () => {
  it('résout le chrome dans les 3 personnalités (jamais de chaîne vide)', () => {
    for (const personality of ['pote', 'pro', 'direct'] as const) {
      const copy = resolveErrorNoticeCopy(personality);
      for (const value of Object.values(copy)) {
        expect(value.length).toBeGreaterThan(0);
      }
    }
    expect(resolveErrorNoticeCopy('pro').detailsLabel).toBe('Détails techniques');
    expect(resolveErrorNoticeCopy('direct').detailsLabel).toBe('Détails');
  });

  it('compose le rapport de partage SANS PII : code + corrélation + kind + heure, jamais le message', () => {
    const text = errorNoticeReportText({
      code: 'BOB-SIRET-404',
      correlationId: '98f73810-1111-4222-8333-444455556666',
      kind: 'not_found',
      at: '2026-07-31T14:03:00.000Z',
    });
    expect(text).toContain('code BOB-SIRET-404');
    expect(text).toContain('correlation 98f73810-1111-4222-8333-444455556666');
    expect(text).toContain('kind not_found');
    expect(text).toMatch(/heure \d{2}:\d{2}/);
    // Le rapport n'a AUCUN slot pour un message ou une donnée saisie : composition fermée.
    expect(text.split(' · ')).toHaveLength(5);
  });

  it('omet proprement les faits absents (erreur locale sans corrélation ni heure)', () => {
    expect(errorNoticeReportText({ code: 'BOB-SIRET-422' })).toBe(
      "Bob Pro — rapport d'erreur · code BOB-SIRET-422",
    );
    expect(
      errorNoticeReportText({ code: 'BOB-API-500', at: 'pas-une-date' }),
    ).toBe("Bob Pro — rapport d'erreur · code BOB-API-500");
  });

  it('shortCorrelation et shortTime : formes courtes affichables', () => {
    expect(shortCorrelation('98f73810-1111-4222-8333-444455556666')).toBe('98f73810');
    expect(shortTime('2026-07-31T09:05:00.000Z')).toMatch(/^\d{2}:\d{2}$/);
    expect(shortTime('illisible')).toBe('');
  });

  it('résumé accessibilité : message d’abord, référence ensuite ; cible tactile ≥ 44 pt', () => {
    expect(
      errorNoticeAccessibilitySummary('SIRET introuvable à l’annuaire.', 'BOB-SIRET-404'),
    ).toBe('SIRET introuvable à l’annuaire. (référence BOB-SIRET-404)');
    expect(ERROR_NOTICE_HIT_TARGET).toBeGreaterThanOrEqual(44);
  });
});
