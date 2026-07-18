import { describe, expect, it } from 'vitest';
import {
  ANALYSIS_TYPE_LABEL_KEY,
  analysisTypeLabelKey,
  destinationSuggestionSegments,
  formatDayMonth,
  suggestedRenameFor,
} from './pending-card-copy';
import { DOCUMENT_ANALYSIS_TYPES } from '@bob/core';
import { t } from '@bob/i18n';

describe('analysisTypeLabelKey', () => {
  it('couvre les 10 types du domaine avec une clé i18n résolvable dans les 3 humeurs', () => {
    for (const type of DOCUMENT_ANALYSIS_TYPES) {
      const key = analysisTypeLabelKey(type);
      expect(key).toBe(ANALYSIS_TYPE_LABEL_KEY[type]);
      for (const personality of ['pote', 'pro', 'direct'] as const) {
        expect(t(key, { personality }).length).toBeGreaterThan(0);
      }
    }
  });

  it('null (pas encore analysé) → badge honnête, jamais « Facture fournisseur » en dur', () => {
    expect(analysisTypeLabelKey(null)).toBe('docs.typeUnknown');
    expect(t(analysisTypeLabelKey(null))).toBe('À lire');
  });
});

describe('formatDayMonth', () => {
  it('formate la date courte du handoff (« 27 juin »)', () => {
    expect(formatDayMonth('2026-06-27')).toBe('27 juin');
    expect(formatDayMonth('2026-01-03')).toBe('3 janvier');
    expect(formatDayMonth('2026-12-31T10:00:00Z')).toBe('31 décembre');
  });

  it('rend l’entrée brute si la date est invalide (jamais une date inventée)', () => {
    expect(formatDayMonth('pas-une-date')).toBe('pas-une-date');
    expect(formatDayMonth('2026-13-01')).toBe('2026-13-01');
    expect(formatDayMonth('')).toBe('');
  });
});

describe('destinationSuggestionSegments', () => {
  it('met la cible en gras SUR PLACE quand le motif la contient (handoff : « chantier Durand »)', () => {
    expect(destinationSuggestionSegments('matériel pour le chantier Durand', 'Durand')).toEqual([
      { text: 'matériel pour le chantier ', bold: false },
      { text: 'Durand', bold: true },
    ]);
  });

  it('découpe avant/cible/après en préservant la casse du motif', () => {
    expect(destinationSuggestionSegments('Facture du chantier durand, à ranger', 'Durand')).toEqual([
      { text: 'Facture du chantier ', bold: false },
      { text: 'durand', bold: true },
      { text: ', à ranger', bold: false },
    ]);
  });

  it('sinon : « {motif} — {cible} » avec la cible en gras (doc hors chantier de première classe)', () => {
    expect(destinationSuggestionSegments('abonnement téléphone.', 'Achats')).toEqual([
      { text: 'abonnement téléphone — ', bold: false },
      { text: 'Achats', bold: true },
    ]);
  });

  it('motif vide → cible seule en gras ; cible vide → motif seul ; tout vide → rien', () => {
    expect(destinationSuggestionSegments('', 'Assurances')).toEqual([
      { text: 'Assurances', bold: true },
    ]);
    expect(destinationSuggestionSegments('classement selon le type', '')).toEqual([
      { text: 'classement selon le type', bold: false },
    ]);
    expect(destinationSuggestionSegments('  ', '  ')).toEqual([]);
  });
});

describe('suggestedRenameFor', () => {
  const doc = { filename: 'scan-8891.jpg', displayName: 'scan-8891.jpg' };

  it('applique le nom professionnel quand le document garde son nom d’archive', () => {
    expect(suggestedRenameFor(doc, 'Facture Leroy Merlin — 184,90 €')).toBe(
      'Facture Leroy Merlin — 184,90 €',
    );
  });

  it('ne touche JAMAIS à un renommage humain explicite', () => {
    expect(
      suggestedRenameFor(
        { filename: 'scan-8891.jpg', displayName: 'Ma facture radiateur' },
        'Facture Leroy Merlin — 184,90 €',
      ),
    ).toBeNull();
  });

  it('ignore une suggestion vide, identique ou invalide côté domaine', () => {
    expect(suggestedRenameFor(doc, null)).toBeNull();
    expect(suggestedRenameFor(doc, '   ')).toBeNull();
    expect(suggestedRenameFor(doc, 'scan-8891.jpg')).toBeNull();
    expect(suggestedRenameFor(doc, 'x'.repeat(200))).toBeNull(); // > 120 chars : rejet domaine
  });

  it('assainit les espaces de la suggestion avant validation', () => {
    expect(suggestedRenameFor(doc, '  Facture   Cedeo  ')).toBe('Facture Cedeo');
  });
});
