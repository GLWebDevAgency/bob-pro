import { describe, it, expect } from 'vitest';
import {
  FiscalProfile,
  buildInitialFiscalProfile,
  confirmeUtilisateur,
  datumValue,
  hypothese,
  manquant,
  sourceFiable,
  type FiscalProfileProps,
} from './fiscal-profile';

const NOW = '2026-07-15T10:00:00.000Z';

function baseProps(overrides: Partial<FiscalProfileProps> = {}): FiscalProfileProps {
  return {
    companyId: 'co-1',
    legalForm: sourceFiable('EI', NOW, 'insee_siret'),
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

describe('FiscalDatum — enveloppe de statut', () => {
  it('manquant() ne porte aucune valeur lisible', () => {
    const d = manquant<string>();
    expect(d.status).toBe('manquant');
    expect(datumValue(d)).toBeUndefined();
  });

  it('hypothese/confirmeUtilisateur/sourceFiable portent value + updatedAt + source', () => {
    expect(hypothese('micro', NOW, 'derived_legal_form')).toEqual({
      status: 'hypothese',
      value: 'micro',
      updatedAt: NOW,
      source: 'derived_legal_form',
    });
    expect(confirmeUtilisateur(true, NOW, 'user_voice').status).toBe('confirme_utilisateur');
    expect(sourceFiable('EI', NOW, 'insee_siret').status).toBe('source_fiable');
    expect(datumValue(hypothese('micro', NOW))).toBe('micro');
  });

  it('le champ source est optionnel', () => {
    const d = hypothese('micro', NOW);
    expect('source' in d).toBe(false);
  });
});

describe('FiscalProfile.of — invariants inter-champs', () => {
  it('accepte un profil entièrement manquant (aucune règle à violer)', () => {
    const r = FiscalProfile.of(baseProps());
    expect(r.ok).toBe(true);
  });

  it('rejette taxRegime=micro + socialStatus=assimile_salarie (micro_tax_regime_requires_tns)', () => {
    const r = FiscalProfile.of(
      baseProps({
        taxRegime: hypothese('micro', NOW),
        socialStatus: hypothese('assimile_salarie', NOW),
      }),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatchObject({ code: 'FISCAL_PROFILE_INCONSISTENT', rule: 'micro_tax_regime_requires_tns' });
  });

  it('accepte taxRegime=micro + socialStatus=tns', () => {
    const r = FiscalProfile.of(
      baseProps({
        legalForm: sourceFiable('micro', NOW),
        taxRegime: hypothese('micro', NOW),
        socialStatus: hypothese('tns', NOW),
      }),
    );
    expect(r.ok).toBe(true);
  });

  it.each(['SASU', 'SAS'] as const)('rejette %s + socialStatus=tns (assimile_requires_sasu_or_sas)', (legalForm) => {
    const r = FiscalProfile.of(
      baseProps({
        legalForm: sourceFiable(legalForm, NOW),
        socialStatus: hypothese('tns', NOW),
      }),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatchObject({ code: 'FISCAL_PROFILE_INCONSISTENT', rule: 'assimile_requires_sasu_or_sas' });
  });

  it.each(['EI', 'micro', 'EURL'] as const)(
    'rejette %s + socialStatus=assimile_salarie (tns_requires_ei_micro_eurl)',
    (legalForm) => {
      const r = FiscalProfile.of(
        baseProps({
          legalForm: sourceFiable(legalForm, NOW),
          socialStatus: hypothese('assimile_salarie', NOW),
        }),
      );
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.error).toMatchObject({ code: 'FISCAL_PROFILE_INCONSISTENT', rule: 'tns_requires_ei_micro_eurl' });
    },
  );

  it('rejette versementLiberatoire=true + taxRegime=is (versement_liberatoire_requires_micro)', () => {
    const r = FiscalProfile.of(
      baseProps({
        legalForm: sourceFiable('SASU', NOW),
        taxRegime: hypothese('is', NOW),
        versementLiberatoire: hypothese(true, NOW),
      }),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatchObject({
      code: 'FISCAL_PROFILE_INCONSISTENT',
      rule: 'versement_liberatoire_requires_micro',
    });
  });

  it('accepte versementLiberatoire=true + taxRegime=micro', () => {
    const r = FiscalProfile.of(
      baseProps({
        legalForm: sourceFiable('micro', NOW),
        taxRegime: hypothese('micro', NOW),
        socialStatus: hypothese('tns', NOW),
        versementLiberatoire: hypothese(true, NOW),
      }),
    );
    expect(r.ok).toBe(true);
  });

  it('rejette legalForm=micro + taxRegime=reel_ir (micro_legal_form_requires_micro_tax_regime)', () => {
    const r = FiscalProfile.of(
      baseProps({
        legalForm: sourceFiable('micro', NOW),
        taxRegime: hypothese('reel_ir', NOW),
      }),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatchObject({
      code: 'FISCAL_PROFILE_INCONSISTENT',
      rule: 'micro_legal_form_requires_micro_tax_regime',
    });
  });

  it('une règle ne se déclenche pas quand un des deux côtés est manquant', () => {
    // socialStatus manquant : taxRegime=micro seul ne viole rien.
    const r = FiscalProfile.of(baseProps({ legalForm: sourceFiable('micro', NOW), taxRegime: hypothese('micro', NOW) }));
    expect(r.ok).toBe(true);
  });
});

describe('FiscalProfile.withField — mise à jour d’un champ à la fois', () => {
  it('force le statut à confirme_utilisateur et re-valide', () => {
    const profile = FiscalProfile.of(baseProps());
    expect(profile.ok).toBe(true);
    if (!profile.ok) return;

    const updated = profile.value.withField({ field: 'taxRegime', value: 'reel_ir' }, NOW, 'user_form');
    expect(updated.ok).toBe(true);
    if (!updated.ok) return;
    expect(updated.value.taxRegime).toEqual({
      status: 'confirme_utilisateur',
      value: 'reel_ir',
      updatedAt: NOW,
      source: 'user_form',
    });
    // Immutabilité : le profil d'origine n'est pas muté.
    expect(profile.value.taxRegime).toEqual({ status: 'manquant' });
  });

  it('rejette une mise à jour qui rend le profil incohérent (le champ n’est pas modifié)', () => {
    const profile = FiscalProfile.of(
      baseProps({ legalForm: sourceFiable('SASU', NOW), socialStatus: hypothese('assimile_salarie', NOW) }),
    );
    expect(profile.ok).toBe(true);
    if (!profile.ok) return;

    const updated = profile.value.withField({ field: 'socialStatus', value: 'tns' }, NOW, 'user_form');
    expect(updated.ok).toBe(false);
    if (updated.ok) return;
    expect(updated.error).toMatchObject({ code: 'FISCAL_PROFILE_INCONSISTENT', rule: 'assimile_requires_sasu_or_sas' });
  });

  it('une confirmation utilisateur sans source reste valide (source optionnelle)', () => {
    const profile = FiscalProfile.of(baseProps());
    expect(profile.ok).toBe(true);
    if (!profile.ok) return;
    const updated = profile.value.withField({ field: 'versementLiberatoire', value: false }, NOW);
    expect(updated.ok).toBe(true);
  });
});

describe('buildInitialFiscalProfile — dérivation prudente, jamais confirme_utilisateur', () => {
  it('micro + trade plombier : régime micro/TNS/franchise TVA hypothèses, activité bic_service (certain)', () => {
    const profile = buildInitialFiscalProfile({ id: 'co-1', legalForm: 'micro', trade: 'plombier' }, NOW);
    expect(profile.legalForm).toMatchObject({ status: 'source_fiable', value: 'micro', source: 'insee_siret' });
    expect(profile.taxRegime).toMatchObject({ status: 'hypothese', value: 'micro' });
    expect(profile.socialStatus).toMatchObject({ status: 'hypothese', value: 'tns' });
    expect(profile.activityNature).toMatchObject({ status: 'hypothese', value: 'bic_service' });
    expect(profile.vatRegime).toMatchObject({ status: 'hypothese', value: 'franchise' });
    expect(profile.fiscalYearEnd).toMatchObject({ status: 'hypothese', value: null });
    expect(profile.acre.status).toBe('manquant');
    expect(profile.versementLiberatoire.status).toBe('manquant');
  });

  it('micro + trade consultant (assumed BNC) : activité bnc', () => {
    const profile = buildInitialFiscalProfile({ id: 'co-2', legalForm: 'micro', trade: 'consultant' }, NOW);
    expect(profile.activityNature).toMatchObject({ status: 'hypothese', value: 'bnc' });
  });

  it('EI (hors micro) : régime réel IR hypothèse, TNS hypothèse, activité/TVA manquantes', () => {
    const profile = buildInitialFiscalProfile({ id: 'co-3', legalForm: 'EI', trade: 'macon' }, NOW);
    expect(profile.taxRegime).toMatchObject({ status: 'hypothese', value: 'reel_ir' });
    expect(profile.socialStatus).toMatchObject({ status: 'hypothese', value: 'tns' });
    expect(profile.activityNature.status).toBe('manquant');
    expect(profile.vatRegime.status).toBe('manquant');
  });

  it('EURL : réel IR + TNS (gérant associé unique)', () => {
    const profile = buildInitialFiscalProfile({ id: 'co-4', legalForm: 'EURL', trade: 'autre' }, NOW);
    expect(profile.taxRegime).toMatchObject({ status: 'hypothese', value: 'reel_ir' });
    expect(profile.socialStatus).toMatchObject({ status: 'hypothese', value: 'tns' });
  });

  it('SASU : IS + assimilé salarié', () => {
    const profile = buildInitialFiscalProfile({ id: 'co-5', legalForm: 'SASU', trade: 'consultant' }, NOW);
    expect(profile.taxRegime).toMatchObject({ status: 'hypothese', value: 'is' });
    expect(profile.socialStatus).toMatchObject({ status: 'hypothese', value: 'assimile_salarie' });
  });

  it('SAS : IS + assimilé salarié', () => {
    const profile = buildInitialFiscalProfile({ id: 'co-6', legalForm: 'SAS', trade: 'freelance_it' }, NOW);
    expect(profile.taxRegime).toMatchObject({ status: 'hypothese', value: 'is' });
    expect(profile.socialStatus).toMatchObject({ status: 'hypothese', value: 'assimile_salarie' });
  });

  it('SARL : IS hypothèse, socialStatus MANQUANT (gérant majoritaire/minoritaire indérivable)', () => {
    const profile = buildInitialFiscalProfile({ id: 'co-7', legalForm: 'SARL', trade: 'peintre' }, NOW);
    expect(profile.taxRegime).toMatchObject({ status: 'hypothese', value: 'is' });
    expect(profile.socialStatus.status).toBe('manquant');
  });

  it('le profil dérivé est toujours structurellement valide (FiscalProfile.of accepte)', () => {
    const forms = ['EI', 'EURL', 'SASU', 'SARL', 'SAS', 'micro'] as const;
    for (const legalForm of forms) {
      const profile = buildInitialFiscalProfile({ id: 'co-x', legalForm, trade: 'autre' }, NOW);
      expect(FiscalProfile.of(profile.toProps()).ok).toBe(true);
    }
  });
});
