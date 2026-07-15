import { describe, expect, it } from 'vitest';
import { confirmeUtilisateur, deriveOwnerPayGuidance, type FiscalProfileProps, manquant } from '@bob/core';
import { t, type I18nKey } from '@bob/i18n';

/**
 * Garde-fou d'intégration Phase 1C : `deriveOwnerPayGuidance` (@bob/core) renvoie `headlineKey`/
 * `captionKey` en `string` NU (le core ne dépend pas de @bob/i18n, cf. derive-owner-pay-guidance.ts)
 * — les écrans (Argent/Aujourd'hui) les castent `as I18nKey`, ce qui CONTOURNE la vérification
 * TypeScript d'existence de la clé. Un typo entre les deux catalogues ne casserait donc RIEN à la
 * compilation, seulement au runtime (`fr[key]` undefined → throw dans `t()`). Ce test exécute
 * réellement `t()` pour chaque `kind` possible, dans les trois humeurs : une clé introuvable le
 * fait échouer immédiatement, avant tout écran.
 */

const NOW = '2026-07-15T10:00:00.000Z';

function baseProfile(overrides: Partial<FiscalProfileProps> = {}): FiscalProfileProps {
  return {
    companyId: 'co-1',
    legalForm: manquant(),
    taxRegime: manquant(),
    socialStatus: manquant(),
    activityNature: manquant(),
    vatRegime: manquant(),
    acre: manquant(),
    versementLiberatoire: manquant(),
    fiscalYearEnd: manquant(),
    ...overrides,
  };
}

const CASHFLOW = { available: 900_000, payout: 500_000, vatDue: 80_000 };
const PERSONALITIES = ['pote', 'pro', 'direct'] as const;

describe('deriveOwnerPayGuidance × @bob/i18n — les clés existent vraiment (les 4 kinds, 3 humeurs)', () => {
  const cases: { name: string; profile: FiscalProfileProps }[] = [
    { name: 'prudent (profil non confirmé)', profile: baseProfile() },
    {
      name: 'micro_retrait_prudent',
      profile: baseProfile({
        taxRegime: confirmeUtilisateur('micro', NOW, 'user_form'),
        activityNature: confirmeUtilisateur('bic_service', NOW, 'user_form'),
        acre: confirmeUtilisateur({ granted: true, startDate: '2026-01-01' }, NOW, 'user_form'),
      }),
    },
    {
      name: 'salaire_a_simuler',
      profile: baseProfile({
        taxRegime: confirmeUtilisateur('is', NOW, 'user_form'),
        socialStatus: confirmeUtilisateur('assimile_salarie', NOW, 'user_form'),
      }),
    },
    {
      name: 'prelevement_apres_provisions',
      profile: baseProfile({
        taxRegime: confirmeUtilisateur('reel_ir', NOW, 'user_form'),
        socialStatus: confirmeUtilisateur('tns', NOW, 'user_form'),
      }),
    },
  ];

  for (const { name, profile } of cases) {
    it(`${name} : headlineKey/captionKey résolvent un texte réel dans les 3 humeurs`, () => {
      const periodeCA = { encaissedCents: 1_000_000, year: 2026 };
      const guidance = deriveOwnerPayGuidance(profile, CASHFLOW, periodeCA);
      for (const personality of PERSONALITIES) {
        const headline = t(guidance.headlineKey as I18nKey, { personality, params: guidance.params });
        const caption = t(guidance.captionKey as I18nKey, { personality, params: guidance.params });
        expect(typeof headline).toBe('string');
        expect(headline.length).toBeGreaterThan(0);
        expect(typeof caption).toBe('string');
        expect(caption.length).toBeGreaterThan(0);
        // Un placeholder {xxx} non résolu trahirait un param manquant/mal nommé entre le core et
        // le catalogue i18n — jamais une accolade ne doit fuiter à l'écran.
        expect(headline).not.toMatch(/\{[a-zA-Z]+\}/);
        expect(caption).not.toMatch(/\{[a-zA-Z]+\}/);
      }
    });
  }
});
