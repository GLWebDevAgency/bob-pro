import { describe, expect, it } from 'vitest';
import { allowedTaxRegimesFor, confirmeUtilisateur, hypothese, manquant, sourceFiable } from '@bob/core';
import { t } from '@bob/i18n';
import { fieldSourceCaption, microCeilingParams } from './fiscal-value-labels';

const NOW = '2026-07-15T09:00:00.000Z';

/**
 * Légende de SOURCE (amendement 6) — le point sensible : DEUX natures de 'source_fiable',
 * distinguées par `datum.source`. Une certitude JURIDIQUE (statut social d'un président de SASU,
 * VL inapplicable hors micro — source 'derived_legal_form') n'est PAS une donnée INSEE : la
 * légende doit dire « c'est la loi », jamais « Source : ton SIRET » (papa vocal, honnêteté).
 */
describe('fieldSourceCaption', () => {
  it('source_fiable dérivé de la forme (derived_legal_form) : légende « c’est la loi », pas INSEE', () => {
    const caption = fieldSourceCaption(sourceFiable('tns', NOW, 'derived_legal_form'), 'pote');
    expect(caption).toContain('loi');
    expect(caption).not.toContain('SIRET');
    expect(caption).toContain('15/07/2026');
  });

  it('source_fiable INSEE (insee_siret) : légende SIRET inchangée', () => {
    const caption = fieldSourceCaption(sourceFiable('EI', NOW, 'insee_siret'), 'pote');
    expect(caption).toContain('SIRET');
  });

  it('source_fiable SANS source tracée (données historiques) : repli SIRET (comportement préservé)', () => {
    const caption = fieldSourceCaption(sourceFiable('EI', NOW), 'pote');
    expect(caption).toContain('SIRET');
  });

  it('source_fiable repris de l’inscription (user_form) : « repris de ton inscription », jamais INSEE', () => {
    const caption = fieldSourceCaption(sourceFiable('franchise', NOW, 'user_form'), 'pote');
    expect(caption).toContain('inscription');
    expect(caption).not.toContain('SIRET');
    expect(caption).toContain('15/07/2026');
  });

  it('confirme_utilisateur : « confirmé par toi », daté', () => {
    const caption = fieldSourceCaption(confirmeUtilisateur('franchise', NOW, 'user_form'), 'pote');
    expect(caption).toContain('par toi');
    expect(caption).toContain('15/07/2026');
  });

  it('hypothese / manquant : légendes dédiées, jamais une source inventée', () => {
    expect(fieldSourceCaption(hypothese('is', NOW), 'pote')).toContain('Hypothèse');
    expect(fieldSourceCaption(manquant(), 'pote')).toContain('Pas encore renseigné');
  });
});

/**
 * Plafonds micro pour la pédagogie des régimes ({ventes}/{services}) — la SEULE source est le
 * référentiel temporel sourcé de @bob/core (art. 50-0/102 ter CGI) : jamais un montant figé dans
 * le catalogue i18n (le bug corrigé ici affichait les seuils 2023-2025 abrogés en juillet 2026).
 */
describe('microCeilingParams — plafonds micro résolus À LA DATE, jamais en dur', () => {
  const NBSP_FINE = String.fromCharCode(0x202f);
  const EUR = String.fromCharCode(0x20ac);

  it('en 2026 (LF 2026, revalorisation triennale) : 203 100 € ventes / 83 600 € services', () => {
    const params = microCeilingParams('2026-07-19');
    expect(params.ventes).toBe(`203${NBSP_FINE}100${NBSP_FINE}${EUR}`);
    expect(params.services).toBe(`83${NBSP_FINE}600${NBSP_FINE}${EUR}`);
  });

  it('en 2025 (fenêtre 2023-2025) : 188 700 € / 77 700 € — la résolution suit bien la date', () => {
    const params = microCeilingParams('2025-06-01');
    expect(params.ventes).toBe(`188${NBSP_FINE}700${NBSP_FINE}${EUR}`);
    expect(params.services).toBe(`77${NBSP_FINE}700${NBSP_FINE}${EUR}`);
  });

  it('les explications micro (toutes formes proposables) interpolent SANS accolade restante', () => {
    const params = microCeilingParams('2026-07-19');
    for (const legalForm of ['micro', 'EI', 'EURL'] as const) {
      for (const choice of allowedTaxRegimesFor(legalForm)) {
        if (choice.regime !== 'micro') continue;
        for (const personality of ['pote', 'pro', 'direct'] as const) {
          const text = t(choice.explanationKey as Parameters<typeof t>[0], { personality, params });
          expect(text, `${choice.explanationKey} (${personality})`).not.toMatch(/\{|\}/u);
          expect(text, `${choice.explanationKey} (${personality})`).toContain('203');
        }
      }
    }
  });
});
