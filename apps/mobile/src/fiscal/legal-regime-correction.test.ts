import { describe, expect, it } from 'vitest';
import { FiscalProfile, confirmeUtilisateur, datumValue, manquant, type FiscalDatum, type FiscalSocialStatus } from '@bob/core';
import { LEGAL_REGIME_COMBOS, requiredSocialStatusFor, type LegalRegimeCombo } from './legal-regime-combos';
import { planLegalRegimeCorrection } from './legal-regime-correction';

const NOW = '2026-07-15T09:00:00.000Z';

/** DomainError est une union multi-domaines (le champ `message` n'existe que sur CERTAINES
 * variantes) — un simple JSON.stringify suffit pour un message de diagnostic de test. */
function describeError(e: unknown): string {
  return JSON.stringify(e);
}

/** Construit un profil MINIMAL mais domaine-valide pour un couple donné — mêmes constructeurs que
 * buildInitialFiscalProfile (@bob/core), socialStatus posé au statut requis par la forme (ou
 * 'manquant' pour SARL, fidèle au comportement réel de la dérivation). */
function profileFor(combo: LegalRegimeCombo): FiscalProfile {
  const required = requiredSocialStatusFor(combo.legalForm);
  const socialStatus: FiscalDatum<FiscalSocialStatus> = required ? confirmeUtilisateur(required, NOW) : manquant();
  const result = FiscalProfile.of({
    companyId: 'test-company',
    legalForm: confirmeUtilisateur(combo.legalForm, NOW),
    taxRegime: confirmeUtilisateur(combo.taxRegime, NOW),
    socialStatus,
    activityNature: manquant(),
    vatRegime: manquant(),
    acre: manquant(),
    versementLiberatoire: manquant(),
    fiscalYearEnd: manquant(),
  });
  if (!result.ok) throw new Error(`fixture invalide pour ${combo.id} : ${describeError(result.error)}`);
  return result.value;
}

describe('planLegalRegimeCorrection — exhaustif contre le VRAI agrégat FiscalProfile', () => {
  // 7×7 = 49 couples (y compris les 7 no-op départ === arrivée) — chaque patch de la séquence
  // planifiée doit être individuellement accepté par FiscalProfile.withField (mêmes invariants
  // que le serveur/PATCH réel), jamais un FISCAL_PROFILE_INCONSISTENT en cours de route.
  for (const from of LEGAL_REGIME_COMBOS) {
    for (const to of LEGAL_REGIME_COMBOS) {
      it(`${from.id} → ${to.id} : chaque étape reste valide et atteint la cible`, () => {
        let profile = profileFor(from);
        const current = {
          legalForm: datumValue(profile.legalForm)!,
          taxRegime: datumValue(profile.taxRegime)!,
          socialStatus: datumValue(profile.socialStatus),
          // 'manquant' → undefined : le paramètre optionnel n'émet alors AUCUN patch VL
          // (comportement historique préservé, vérifié par les attentes inchangées ci-dessous).
          versementLiberatoire: datumValue(profile.versementLiberatoire),
        };
        const patches = planLegalRegimeCorrection(current, to);

        for (const patch of patches) {
          const applied = profile.withField(patch, NOW, 'user_form');
          expect(
            applied.ok,
            `${from.id} → ${to.id} : le patch ${patch.field}=${JSON.stringify(patch.value)} a été rejeté (${
              applied.ok ? '' : describeError(applied.error)
            })`,
          ).toBe(true);
          if (applied.ok) profile = applied.value;
        }

        expect(datumValue(profile.legalForm)).toBe(to.legalForm);
        expect(datumValue(profile.taxRegime)).toBe(to.taxRegime);
        const requiredSocial = requiredSocialStatusFor(to.legalForm);
        if (requiredSocial !== null) {
          expect(datumValue(profile.socialStatus)).toBe(requiredSocial);
        }
      });
    }
  }

  it('couple déjà confirmé (no-op) : aucun patch émis', () => {
    for (const combo of LEGAL_REGIME_COMBOS) {
      const profile = profileFor(combo);
      const current = {
        legalForm: datumValue(profile.legalForm)!,
        taxRegime: datumValue(profile.taxRegime)!,
        socialStatus: datumValue(profile.socialStatus),
      };
      expect(planLegalRegimeCorrection(current, combo)).toEqual([]);
    }
  });
});

describe('planLegalRegimeCorrection — versement libératoire soldé avant de quitter le micro', () => {
  /** Micro avec VL CONFIRMÉ true — l'état qui, sans solde préalable, fait rejeter toute écriture
   * d'un régime non micro (invariant versement_liberatoire_requires_micro). */
  function microProfileWithVl(): FiscalProfile {
    const result = FiscalProfile.of({
      companyId: 'test-company',
      legalForm: confirmeUtilisateur('micro', NOW),
      taxRegime: confirmeUtilisateur('micro', NOW),
      socialStatus: confirmeUtilisateur('tns', NOW),
      activityNature: manquant(),
      vatRegime: manquant(),
      acre: manquant(),
      versementLiberatoire: confirmeUtilisateur(true, NOW),
      fiscalYearEnd: manquant(),
    });
    if (!result.ok) throw new Error(`fixture micro+VL invalide : ${describeError(result.error)}`);
    return result.value;
  }

  const nonMicroTargets = LEGAL_REGIME_COMBOS.filter((c) => c.taxRegime !== 'micro');

  for (const to of nonMicroTargets) {
    it(`micro (VL true) → ${to.id} : VL soldé EN PREMIER, chaque étape valide, cible atteinte`, () => {
      let profile = microProfileWithVl();
      const patches = planLegalRegimeCorrection(
        {
          legalForm: 'micro',
          taxRegime: 'micro',
          socialStatus: 'tns',
          versementLiberatoire: true,
        },
        to,
      );
      expect(patches[0]).toEqual({ field: 'versementLiberatoire', value: false });

      for (const patch of patches) {
        const applied = profile.withField(patch, NOW, 'user_form');
        expect(
          applied.ok,
          `micro+VL → ${to.id} : patch ${patch.field}=${JSON.stringify(patch.value)} rejeté (${
            applied.ok ? '' : describeError(applied.error)
          })`,
        ).toBe(true);
        if (applied.ok) profile = applied.value;
      }

      expect(datumValue(profile.legalForm)).toBe(to.legalForm);
      expect(datumValue(profile.taxRegime)).toBe(to.taxRegime);
      expect(datumValue(profile.versementLiberatoire)).toBe(false);
    });
  }

  it('cible encore au régime micro : le VL est CONSERVÉ (aucun patch VL)', () => {
    const patches = planLegalRegimeCorrection(
      { legalForm: 'micro', taxRegime: 'micro', socialStatus: 'tns', versementLiberatoire: true },
      LEGAL_REGIME_COMBOS.find((c) => c.id === 'micro')!,
    );
    expect(patches.some((p) => p.field === 'versementLiberatoire')).toBe(false);
  });
});
