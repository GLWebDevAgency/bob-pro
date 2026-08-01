import { describe, expect, it, vi } from 'vitest';
import { confirmeUtilisateur, deriveOwnerPayGuidance, type FiscalProfileProps, manquant } from '@bob/core';
import { t, type I18nKey } from '@bob/i18n';
import { periodeCAOf } from './use-owner-pay-guidance';

// Le module du hook importe '../data/hooks' (→ react-native, hors de portée de l'environnement
// node) : stub minimal — seule la fonction PURE periodeCAOf est exercée ici, jamais le hook.
vi.mock('../data/hooks', () => ({
  useFiscalProfile: () => ({ data: undefined, isLoading: false, isError: false }),
  usePayments: () => ({ data: undefined, isLoading: false, isError: false }),
}));

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

describe('periodeCAOf — mois MÉTIER Paris (parité voix ↔ écran, bascule de mois)', () => {
  it("bascule d'été en fin de mois : encaissé le 31/07 22:18 UTC = 1er août 00:18 Paris → compté dans 2026-08", () => {
    // Horloge gelée par littéral : now = 2026-07-31T22:18Z → today Paris = 2026-08-01 (CEST +2),
    // mois métier '2026-08'. Le paiement enregistré au même instant a pour jour métier 2026-08-01
    // → compté : 120 000 c. La troncature UTC (mois '2026-07' ≠ '2026-08') l'aurait perdu → 0.
    expect(
      periodeCAOf(
        [{ receivedAt: '2026-07-31T22:18:00.000Z', amountCents: 120_000 }],
        new Date('2026-07-31T22:18:00.000Z'),
      ),
    ).toEqual({ encaissedCents: 120_000, year: 2026 });
  });

  it("bascule d'ANNÉE en hiver : encaissé le 31/12 23:30 UTC = 1er janvier 00:30 Paris → mois 2027-01, year 2027", () => {
    // now = 2026-12-31T23:30Z → today Paris = 2027-01-01 (CET +1) : mois métier '2027-01' ET
    // year 2027 (le taux micro appliqué par deriveOwnerPayGuidance suit l'année déclarée).
    // Une borne au jour UTC (today '2026-12-31') aurait donné mois '2026-12'/year 2026 et
    // exclu le paiement (jour métier 2027-01-01).
    expect(
      periodeCAOf(
        [{ receivedAt: '2026-12-31T23:30:00.000Z', amountCents: 84_000 }],
        new Date('2026-12-31T23:30:00.000Z'),
      ),
    ).toEqual({ encaissedCents: 84_000, year: 2027 });
  });

  it("TÉMOIN DST hiver : encaissé le 31/12 22:30 UTC = 23:30 Paris (CET +1) → encore dans 2026-12", () => {
    // 22:30Z + 1 h = 23:30 le 31/12 : le mois métier n'a PAS basculé (today Paris 2026-12-31,
    // mois '2026-12', paiement au même jour → compté : 61 000 c). Un calcul DST-naïf à offset
    // d'été figé (+2 h toute l'année) projetterait le paiement au 01/01 ('2027-01' ≠ '2026-12')
    // → 0. Le cas 23:30Z ci-dessus ne voit pas la différence : ce littéral tue ce mutant.
    expect(
      periodeCAOf(
        [{ receivedAt: '2026-12-31T22:30:00.000Z', amountCents: 61_000 }],
        new Date('2026-12-31T22:30:00.000Z'),
      ),
    ).toEqual({ encaissedCents: 61_000, year: 2026 });
  });

  it('non-régression pleine journée : instants loin de minuit et DateOnly pure, hors-mois exclu', () => {
    // now = 2026-07-15T10:00Z → today Paris 2026-07-15, mois '2026-07'.
    // · 2026-07-10T09:00Z = 11:00 Paris → jour 2026-07-10, compté (50 000 c) ;
    // · '2026-07-05' (DateOnly pure, déjà un jour métier) → comptée (30 000 c) ;
    // · 2026-06-30T21:00Z = 23:00 Paris le 30/06 → mois '2026-06', exclue (contrôle hors-mois).
    // Total : 50 000 + 30 000 = 80 000 c.
    expect(
      periodeCAOf(
        [
          { receivedAt: '2026-07-10T09:00:00.000Z', amountCents: 50_000 },
          { receivedAt: '2026-07-05', amountCents: 30_000 },
          { receivedAt: '2026-06-30T21:00:00.000Z', amountCents: 999_999 },
        ],
        new Date('2026-07-15T10:00:00.000Z'),
      ),
    ).toEqual({ encaissedCents: 80_000, year: 2026 });
  });

  it('paiements pas encore chargés (undefined) → undefined : la guidance retombe sur prudent, jamais un 0 inventé', () => {
    expect(periodeCAOf(undefined, new Date('2026-07-15T10:00:00.000Z'))).toBeUndefined();
  });
});
