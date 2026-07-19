import { describe, it, expect } from 'vitest';
import {
  applicableFiscalFields,
  allowedTaxRegimesFor,
  socialStatusExplanation,
} from './fiscal-field-rules';
import {
  FISCAL_PROFILE_FIELDS,
  FiscalProfile,
  buildInitialFiscalProfile,
  confirmeUtilisateur,
  hypothese,
  manquant,
  sourceFiable,
  type FiscalProfileProps,
  type FiscalTaxRegime,
} from './fiscal-profile';
import { type LegalForm } from '../company/company';

const NOW = '2026-07-15T10:00:00.000Z';

const ALL_FORMS = ['EI', 'EURL', 'SASU', 'SARL', 'SAS', 'micro'] as const;

function profileSlice(
  legalForm: FiscalProfileProps['legalForm'],
  taxRegime: FiscalProfileProps['taxRegime'],
): Pick<FiscalProfileProps, 'legalForm' | 'taxRegime'> {
  return { legalForm, taxRegime };
}

describe('applicableFiscalFields — quels champs afficher', () => {
  it('contexte micro (forme micro) : les 8 champs, versement libératoire compris', () => {
    const fields = applicableFiscalFields(profileSlice(sourceFiable('micro', NOW), hypothese('micro', NOW)));
    expect(fields).toEqual(FISCAL_PROFILE_FIELDS);
  });

  it('hors micro (SASU à l’IS) : 7 champs — le VL est masqué (art. 151-0 CGI : régime micro seulement)', () => {
    const fields = applicableFiscalFields(profileSlice(sourceFiable('SASU', NOW), hypothese('is', NOW)));
    expect(fields).toEqual(FISCAL_PROFILE_FIELDS.filter((f) => f !== 'versementLiberatoire'));
    expect(fields).toContain('acre'); // l'ACRE reste visible pour tout le monde (avec aide UI).
  });

  it('EI ayant CONFIRMÉ le régime micro : le VL redevient visible (la valeur pilote, pas la forme seule)', () => {
    const fields = applicableFiscalFields(profileSlice(sourceFiable('EI', NOW), confirmeUtilisateur('micro', NOW)));
    expect(fields).toContain('versementLiberatoire');
  });

  it('EI au régime encore inconnu : VL masqué (aucun contexte micro établi)', () => {
    const fields = applicableFiscalFields(profileSlice(sourceFiable('EI', NOW), manquant()));
    expect(fields).not.toContain('versementLiberatoire');
  });

  it('profil entièrement manquant : VL masqué, les 7 autres champs restent affichés', () => {
    const fields = applicableFiscalFields(profileSlice(manquant(), manquant()));
    expect(fields).toEqual(FISCAL_PROFILE_FIELDS.filter((f) => f !== 'versementLiberatoire'));
  });

  it('cohérence avec la dérivation initiale : profil micro dérivé → VL affiché, profil SAS dérivé → masqué', () => {
    const micro = buildInitialFiscalProfile({ id: 'c', legalForm: 'micro', trade: 'plombier' }, NOW).toProps();
    const sas = buildInitialFiscalProfile({ id: 'c', legalForm: 'SAS', trade: 'plombier' }, NOW).toProps();
    expect(applicableFiscalFields(micro)).toContain('versementLiberatoire');
    expect(applicableFiscalFields(sas)).not.toContain('versementLiberatoire');
  });
});

describe('allowedTaxRegimesFor — régimes juridiquement valides par forme', () => {
  const regimesOf = (legalForm: LegalForm): FiscalTaxRegime[] =>
    allowedTaxRegimesFor(legalForm).map((r) => r.regime);

  it('micro : le régime micro seul (invariant de la forme)', () => {
    expect(regimesOf('micro')).toEqual(['micro']);
  });

  it('EI : micro (si seuils), réel IR (défaut) et IS (option possible depuis 2022, art. 1655 sexies CGI)', () => {
    expect(regimesOf('EI')).toEqual(['micro', 'reel_ir', 'is']);
  });

  it('EURL : micro (associé unique personne physique gérant, Sapin II — art. 50-0, 1 CGI), réel IR (défaut) et IS (option)', () => {
    expect(regimesOf('EURL')).toEqual(['micro', 'reel_ir', 'is']);
  });

  it('EURL au régime micro : le domaine accepte le couple (gérant associé unique TNS — aucun invariant violé)', () => {
    const profile = FiscalProfile.of({
      companyId: 'c-eurl-micro',
      legalForm: confirmeUtilisateur('EURL', NOW),
      taxRegime: confirmeUtilisateur('micro', NOW),
      socialStatus: confirmeUtilisateur('tns', NOW),
      activityNature: manquant(),
      vatRegime: manquant(),
      acre: manquant(),
      versementLiberatoire: manquant(),
      fiscalYearEnd: manquant(),
    });
    expect(profile.ok).toBe(true);
  });

  it.each(['SASU', 'SAS', 'SARL'] as const)(
    '%s : IS (défaut) et option IR temporaire (≤ 5 exercices, société < 5 ans — art. 239 bis AB CGI)',
    (legalForm) => {
      expect(regimesOf(legalForm)).toEqual(['is', 'option_ir']);
    },
  );

  it('chaque proposition porte une clé pédagogique stable fiscal.tax_regime_choice.<forme>.<regime>', () => {
    for (const legalForm of ALL_FORMS) {
      for (const entry of allowedTaxRegimesFor(legalForm)) {
        expect(entry.explanationKey).toBe(`fiscal.tax_regime_choice.${legalForm}.${entry.regime}`);
      }
    }
  });

  it('jamais un régime interdit : micro absent des sociétés de capitaux, option_ir absent des formes IR', () => {
    expect(regimesOf('SASU')).not.toContain('micro');
    expect(regimesOf('SAS')).not.toContain('micro');
    expect(regimesOf('SARL')).not.toContain('micro'); // plusieurs associés : jamais micro (art. 50-0, 1 CGI)
    expect(regimesOf('EURL')).not.toContain('option_ir');
    expect(regimesOf('EI')).not.toContain('option_ir');
  });
});

describe('socialStatusExplanation — clé pédagogique par forme', () => {
  it('SASU et SAS partagent la même explication (président toujours assimilé salarié, art. L311-3, 11° CSS)', () => {
    expect(socialStatusExplanation('SASU')).toBe('fiscal.social_status_explanation.sas_president_assimile');
    expect(socialStatusExplanation('SAS')).toBe(socialStatusExplanation('SASU'));
  });

  it('chaque forme a une clé, la SARL a la sienne (« ça dépend de la gérance »)', () => {
    expect(socialStatusExplanation('EI')).toBe('fiscal.social_status_explanation.ei_tns');
    expect(socialStatusExplanation('micro')).toBe('fiscal.social_status_explanation.micro_tns');
    expect(socialStatusExplanation('EURL')).toBe('fiscal.social_status_explanation.eurl_gerant_tns');
    expect(socialStatusExplanation('SARL')).toBe('fiscal.social_status_explanation.sarl_selon_gerance');
  });

  it('les clés sont toutes non vides et préfixées fiscal.social_status_explanation.', () => {
    for (const legalForm of ALL_FORMS) {
      expect(socialStatusExplanation(legalForm)).toMatch(/^fiscal\.social_status_explanation\.[a-z_]+$/);
    }
  });
});
