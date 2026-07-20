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

describe('buildInitialFiscalProfile — dérivation prudente, jamais confirme_utilisateur (sauf choix onboarding)', () => {
  it('micro + trade plombier : régime micro/franchise TVA hypothèses, TNS source_fiable, activité bic_service', () => {
    const profile = buildInitialFiscalProfile({ id: 'co-1', legalForm: 'micro', trade: 'plombier' }, NOW);
    expect(profile.legalForm).toMatchObject({ status: 'source_fiable', value: 'micro', source: 'insee_siret' });
    expect(profile.taxRegime).toMatchObject({ status: 'hypothese', value: 'micro' });
    // Certitude juridique : l'entrepreneur individuel est TOUJOURS TNS — jamais une hypothèse.
    expect(profile.socialStatus).toMatchObject({ status: 'source_fiable', value: 'tns', source: 'derived_legal_form' });
    expect(profile.activityNature).toMatchObject({ status: 'hypothese', value: 'bic_service', source: 'derived_trade' });
    expect(profile.vatRegime).toMatchObject({ status: 'hypothese', value: 'franchise' });
    expect(profile.fiscalYearEnd).toMatchObject({ status: 'hypothese', value: null });
    expect(profile.acre.status).toBe('manquant');
    // VL en micro : jamais présumé — la question est posée (option sur demande, art. 151-0 CGI).
    expect(profile.versementLiberatoire.status).toBe('manquant');
  });

  it('micro + trade consultant (assumed BNC) : activité bnc', () => {
    const profile = buildInitialFiscalProfile({ id: 'co-2', legalForm: 'micro', trade: 'consultant' }, NOW);
    expect(profile.activityNature).toMatchObject({ status: 'hypothese', value: 'bnc' });
  });

  it('EI (au réel) : régime réel IR hypothèse, TNS source_fiable, TVA manquante', () => {
    const profile = buildInitialFiscalProfile({ id: 'co-3', legalForm: 'EI', trade: 'macon' }, NOW);
    expect(profile.taxRegime).toMatchObject({ status: 'hypothese', value: 'reel_ir' });
    expect(profile.socialStatus).toMatchObject({ status: 'source_fiable', value: 'tns', source: 'derived_legal_form' });
    expect(profile.vatRegime.status).toBe('manquant');
  });

  it('EURL : réel IR hypothèse + TNS source_fiable (gérant associé unique, certitude juridique)', () => {
    const profile = buildInitialFiscalProfile({ id: 'co-4', legalForm: 'EURL', trade: 'autre' }, NOW);
    expect(profile.taxRegime).toMatchObject({ status: 'hypothese', value: 'reel_ir' });
    expect(profile.socialStatus).toMatchObject({ status: 'source_fiable', value: 'tns', source: 'derived_legal_form' });
  });

  it.each(['SASU', 'SAS'] as const)(
    '%s : IS hypothèse + assimilé salarié SOURCE_FIABLE (art. L311-3, 11° CSS — certitude, pas hypothèse)',
    (legalForm) => {
      const profile = buildInitialFiscalProfile({ id: 'co-5', legalForm, trade: 'consultant' }, NOW);
      expect(profile.taxRegime).toMatchObject({ status: 'hypothese', value: 'is' });
      expect(profile.socialStatus).toMatchObject({
        status: 'source_fiable',
        value: 'assimile_salarie',
        source: 'derived_legal_form',
      });
    },
  );

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

describe('buildInitialFiscalProfile — compat ascendante (entrée minimale {id, legalForm, trade})', () => {
  const forms = ['EI', 'EURL', 'SASU', 'SARL', 'SAS', 'micro'] as const;

  it("l'entrée minimale compile et dérive sans les nouveaux champs (aucun requis)", () => {
    for (const legalForm of forms) {
      const profile = buildInitialFiscalProfile({ id: 'co-min', legalForm, trade: 'plombier' }, NOW);
      expect(profile.companyId).toBe('co-min');
    }
  });

  it('sans dateCreation : ACRE reste manquante pour toutes les formes (comportement antérieur)', () => {
    for (const legalForm of forms) {
      const profile = buildInitialFiscalProfile({ id: 'co-min', legalForm, trade: 'electricien' }, NOW);
      expect(profile.acre.status).toBe('manquant');
    }
  });

  it('sans vatRegime : TVA identique au comportement antérieur (franchise hypothèse en micro, manquante sinon)', () => {
    expect(buildInitialFiscalProfile({ id: 'c', legalForm: 'micro', trade: 'coach' }, NOW).vatRegime).toMatchObject({
      status: 'hypothese',
      value: 'franchise',
      source: 'derived_legal_form',
    });
    for (const legalForm of ['EI', 'EURL', 'SASU', 'SARL', 'SAS'] as const) {
      expect(buildInitialFiscalProfile({ id: 'c', legalForm, trade: 'coach' }, NOW).vatRegime.status).toBe('manquant');
    }
  });

  it('les VALEURS dérivées historiques sont inchangées (régime fiscal, exercice, activité micro)', () => {
    const expectedTaxRegime = {
      micro: 'micro',
      EI: 'reel_ir',
      EURL: 'reel_ir',
      SASU: 'is',
      SAS: 'is',
      SARL: 'is',
    } as const;
    for (const legalForm of forms) {
      const profile = buildInitialFiscalProfile({ id: 'c', legalForm, trade: 'plombier' }, NOW);
      expect(profile.taxRegime).toMatchObject({ status: 'hypothese', value: expectedTaxRegime[legalForm] });
      expect(profile.fiscalYearEnd).toMatchObject({ status: 'hypothese', value: null });
    }
    // La nomenclature micro (URSSAF) reste dérivée à l'identique du métier.
    expect(datumValue(buildInitialFiscalProfile({ id: 'c', legalForm: 'micro', trade: 'autre' }, NOW).activityNature)).toBe('bnc');
  });
});

describe('buildInitialFiscalProfile — nature d’activité pour TOUTES les formes (trade + NAF)', () => {
  it.each(['plombier', 'electricien', 'macon', 'peintre', 'paysagiste'] as const)(
    'artisan %s hors micro : mixte prudent en hypothèse (vente de matériaux + pose)',
    (trade) => {
      for (const legalForm of ['EI', 'EURL', 'SASU', 'SARL', 'SAS'] as const) {
        const profile = buildInitialFiscalProfile({ id: 'c', legalForm, trade }, NOW);
        expect(profile.activityNature).toMatchObject({ status: 'hypothese', value: 'mixte', source: 'derived_trade' });
      }
    },
  );

  it.each(['consultant', 'freelance_it', 'photographe', 'coach'] as const)(
    'métier intellectuel %s hors micro : bnc en hypothèse (jamais source_fiable)',
    (trade) => {
      const profile = buildInitialFiscalProfile({ id: 'c', legalForm: 'SASU', trade }, NOW);
      expect(profile.activityNature).toMatchObject({ status: 'hypothese', value: 'bnc', source: 'derived_trade' });
    },
  );

  it("trade 'autre' sans NAF : nature manquante hors micro (aucune base prudente)", () => {
    const profile = buildInitialFiscalProfile({ id: 'c', legalForm: 'EI', trade: 'autre' }, NOW);
    expect(profile.activityNature.status).toBe('manquant');
  });

  it("trade 'autre' + NAF connu de nafToTrade (43.22A plombier) : nature via NAF, source derived_naf_ape", () => {
    const profile = buildInitialFiscalProfile({ id: 'c', legalForm: 'SAS', trade: 'autre', nafApe: '43.22A' }, NOW);
    expect(profile.activityNature).toMatchObject({ status: 'hypothese', value: 'mixte', source: 'derived_naf_ape' });
  });

  it("trade 'autre' + NAF 62.01Z (programmation) : bnc via NAF — BIC possible, d'où l'hypothèse", () => {
    const profile = buildInitialFiscalProfile({ id: 'c', legalForm: 'EI', trade: 'autre', nafApe: '62.01Z' }, NOW);
    expect(profile.activityNature).toMatchObject({ status: 'hypothese', value: 'bnc', source: 'derived_naf_ape' });
  });

  it("trade 'autre' + NAF hors nafToTrade mais division connue (70.10Z) : repli division → bnc", () => {
    const profile = buildInitialFiscalProfile({ id: 'c', legalForm: 'EURL', trade: 'autre', nafApe: '70.10Z' }, NOW);
    expect(profile.activityNature).toMatchObject({ status: 'hypothese', value: 'bnc', source: 'derived_naf_ape' });
  });

  it("trade 'autre' + NAF division commerce (47.91B) : bic_vente", () => {
    const profile = buildInitialFiscalProfile({ id: 'c', legalForm: 'SARL', trade: 'autre', nafApe: '47.91B' }, NOW);
    expect(profile.activityNature).toMatchObject({ status: 'hypothese', value: 'bic_vente', source: 'derived_naf_ape' });
  });

  it("trade 'autre' + NAF de division inconnue (96.02A) : nature manquante — jamais inventée", () => {
    const profile = buildInitialFiscalProfile({ id: 'c', legalForm: 'EI', trade: 'autre', nafApe: '96.02A' }, NOW);
    expect(profile.activityNature.status).toBe('manquant');
  });

  it("micro + trade 'autre' + NAF 43.22A : nomenclature micro affinée via le NAF (bic_service)", () => {
    const profile = buildInitialFiscalProfile({ id: 'c', legalForm: 'micro', trade: 'autre', nafApe: '43.22A' }, NOW);
    expect(profile.activityNature).toMatchObject({ status: 'hypothese', value: 'bic_service', source: 'derived_naf_ape' });
  });

  it('le métier déclaré PRIME sur le NAF quand il est spécifique', () => {
    const profile = buildInitialFiscalProfile({ id: 'c', legalForm: 'EI', trade: 'consultant', nafApe: '43.22A' }, NOW);
    expect(profile.activityNature).toMatchObject({ status: 'hypothese', value: 'bnc', source: 'derived_trade' });
  });
});

describe('buildInitialFiscalProfile — régime TVA repris du choix d’onboarding', () => {
  it("reel_simpl (orthographe Company) → reel_simplifie confirmé utilisateur, source user_form", () => {
    const profile = buildInitialFiscalProfile(
      { id: 'c', legalForm: 'SASU', trade: 'freelance_it', vatRegime: 'reel_simpl' },
      NOW,
    );
    expect(profile.vatRegime).toEqual({
      status: 'confirme_utilisateur',
      value: 'reel_simplifie',
      updatedAt: NOW,
      source: 'user_form',
    });
  });

  it('franchise et reel_normal passent sans conversion', () => {
    expect(
      datumValue(buildInitialFiscalProfile({ id: 'c', legalForm: 'EI', trade: 'macon', vatRegime: 'franchise' }, NOW).vatRegime),
    ).toBe('franchise');
    expect(
      datumValue(
        buildInitialFiscalProfile({ id: 'c', legalForm: 'SARL', trade: 'macon', vatRegime: 'reel_normal' }, NOW).vatRegime,
      ),
    ).toBe('reel_normal');
  });

  it('micro + choix onboarding fourni : le CHOIX utilisateur prime sur l’hypothèse franchise', () => {
    const profile = buildInitialFiscalProfile(
      { id: 'c', legalForm: 'micro', trade: 'plombier', vatRegime: 'reel_simpl' },
      NOW,
    );
    expect(profile.vatRegime).toMatchObject({ status: 'confirme_utilisateur', value: 'reel_simplifie' });
  });
});

describe('buildInitialFiscalProfile — hypothèse ACRE depuis la date de création', () => {
  // NOW = 2026-07-15 : la borne « moins de 12 mois » tombe au 2025-07-15 (exclu).

  it('société (SASU) créée il y a 6 mois : hypothese({granted: true, startDate}) — ACRE automatique hors micro', () => {
    const profile = buildInitialFiscalProfile(
      { id: 'c', legalForm: 'SASU', trade: 'consultant', dateCreation: '2026-01-10' },
      NOW,
    );
    expect(profile.acre).toEqual({
      status: 'hypothese',
      value: { granted: true, startDate: '2026-01-10' },
      updatedAt: NOW,
      source: 'derived_date_creation',
    });
  });

  it('EI (au réel) créée il y a 6 mois : hypothese granted — le « sur demande » ne vise que le micro', () => {
    const profile = buildInitialFiscalProfile(
      { id: 'c', legalForm: 'EI', trade: 'macon', dateCreation: '2026-02-01' },
      NOW,
    );
    expect(profile.acre).toMatchObject({ status: 'hypothese', value: { granted: true, startDate: '2026-02-01' } });
  });

  it('micro créée il y a 6 mois : ACRE reste MANQUANTE (sur demande pour les micro-entrepreneurs — question posée)', () => {
    const profile = buildInitialFiscalProfile(
      { id: 'c', legalForm: 'micro', trade: 'plombier', dateCreation: '2026-01-10' },
      NOW,
    );
    expect(profile.acre.status).toBe('manquant');
  });

  it('création ≥ 12 mois (toutes formes, micro comprise) : hypothese({granted: false})', () => {
    for (const legalForm of ['micro', 'EI', 'SASU', 'SARL'] as const) {
      const profile = buildInitialFiscalProfile(
        { id: 'c', legalForm, trade: 'peintre', dateCreation: '2024-03-01' },
        NOW,
      );
      expect(profile.acre).toMatchObject({ status: 'hypothese', value: { granted: false } });
      expect(datumValue(profile.acre)?.startDate).toBeUndefined();
    }
  });

  it('borne exacte des 12 mois (2025-07-15) : traitée comme ≥ 12 mois → granted: false', () => {
    const profile = buildInitialFiscalProfile(
      { id: 'c', legalForm: 'SAS', trade: 'macon', dateCreation: '2025-07-15' },
      NOW,
    );
    expect(profile.acre).toMatchObject({ status: 'hypothese', value: { granted: false } });
  });

  it('un jour sous la borne (2025-07-16) : moins de 12 mois → granted: true', () => {
    const profile = buildInitialFiscalProfile(
      { id: 'c', legalForm: 'SAS', trade: 'macon', dateCreation: '2025-07-16' },
      NOW,
    );
    expect(profile.acre).toMatchObject({ status: 'hypothese', value: { granted: true, startDate: '2025-07-16' } });
  });
});

describe('buildInitialFiscalProfile — versement libératoire « non applicable » hors micro', () => {
  it.each(['EI', 'EURL', 'SASU', 'SARL', 'SAS'] as const)(
    '%s : VL posé false en SOURCE_FIABLE (derived_legal_form) — l’UI peut masquer le champ',
    (legalForm) => {
      const profile = buildInitialFiscalProfile({ id: 'c', legalForm, trade: 'plombier' }, NOW);
      expect(profile.versementLiberatoire).toEqual({
        status: 'source_fiable',
        value: false,
        updatedAt: NOW,
        source: 'derived_legal_form',
      });
    },
  );

  it('micro : VL jamais présumé — manquant, la question est posée', () => {
    const profile = buildInitialFiscalProfile({ id: 'c', legalForm: 'micro', trade: 'plombier' }, NOW);
    expect(profile.versementLiberatoire.status).toBe('manquant');
  });
});

describe('withField — le marqueur « VL non applicable » est invalidé à l’ENTRÉE en contexte micro', () => {
  const LATER = '2026-07-19T10:00:00.000Z';

  it('EI dérivée (VL false source_fiable) qui CHOISIT le régime micro : VL repasse à manquant — la question est posée', () => {
    const profile = buildInitialFiscalProfile({ id: 'c', legalForm: 'EI', trade: 'plombier' }, NOW);
    expect(profile.versementLiberatoire).toMatchObject({ status: 'source_fiable', value: false });

    const updated = profile.withField({ field: 'taxRegime', value: 'micro' }, LATER, 'user_form');
    expect(updated.ok).toBe(true);
    if (!updated.ok) return;
    // Le VL n'est plus « interdit par la loi » : c'est une OPTION du micro (art. 151-0 CGI) —
    // jamais un « Non — Confirmé — imposé par la loi » affiché à tort.
    expect(updated.value.versementLiberatoire).toEqual({ status: 'manquant' });
    expect(datumValue(updated.value.taxRegime)).toBe('micro');
  });

  it('bascule de FORME vers micro (taxRegime déjà micro) : le marqueur restant est aussi invalidé', () => {
    const profile = FiscalProfile.of(
      baseProps({
        legalForm: confirmeUtilisateur('EI', NOW),
        taxRegime: confirmeUtilisateur('micro', NOW),
        socialStatus: confirmeUtilisateur('tns', NOW),
        versementLiberatoire: sourceFiable(false, NOW, 'derived_legal_form'),
      }),
    );
    expect(profile.ok).toBe(true);
    if (!profile.ok) return;

    const updated = profile.value.withField({ field: 'legalForm', value: 'micro' }, LATER, 'user_form');
    expect(updated.ok).toBe(true);
    if (!updated.ok) return;
    expect(updated.value.versementLiberatoire).toEqual({ status: 'manquant' });
  });

  it('un VL CONFIRMÉ par l’utilisateur n’est JAMAIS touché en entrant au micro', () => {
    const profile = FiscalProfile.of(
      baseProps({
        legalForm: confirmeUtilisateur('EI', NOW),
        socialStatus: confirmeUtilisateur('tns', NOW),
        versementLiberatoire: confirmeUtilisateur(false, NOW, 'user_form'),
      }),
    );
    expect(profile.ok).toBe(true);
    if (!profile.ok) return;

    const updated = profile.value.withField({ field: 'taxRegime', value: 'micro' }, LATER, 'user_form');
    expect(updated.ok).toBe(true);
    if (!updated.ok) return;
    expect(updated.value.versementLiberatoire).toEqual({
      status: 'confirme_utilisateur',
      value: false,
      updatedAt: NOW,
      source: 'user_form',
    });
  });

  it('HORS entrée en micro, le marqueur « non applicable » survit à toute autre édition', () => {
    const profile = buildInitialFiscalProfile({ id: 'c', legalForm: 'EI', trade: 'plombier' }, NOW);
    const updated = profile.withField({ field: 'activityNature', value: 'bic_service' }, LATER, 'user_form');
    expect(updated.ok).toBe(true);
    if (!updated.ok) return;
    expect(updated.value.versementLiberatoire).toMatchObject({
      status: 'source_fiable',
      value: false,
      source: 'derived_legal_form',
    });
  });

  it('EURL dérivée qui choisit le régime micro (Sapin II) : même invalidation du marqueur', () => {
    const profile = buildInitialFiscalProfile({ id: 'c', legalForm: 'EURL', trade: 'electricien' }, NOW);
    const updated = profile.withField({ field: 'taxRegime', value: 'micro' }, LATER, 'user_form');
    expect(updated.ok).toBe(true);
    if (!updated.ok) return;
    expect(updated.value.versementLiberatoire).toEqual({ status: 'manquant' });
  });
});

describe('buildInitialFiscalProfile — les dérivations enrichies ne violent JAMAIS les invariants', () => {
  it('formes × entrée complète (TVA + NAF + dates variées) : FiscalProfile.of accepte toujours', () => {
    const forms = ['EI', 'EURL', 'SASU', 'SARL', 'SAS', 'micro'] as const;
    const trades = ['plombier', 'consultant', 'autre'] as const;
    const vatRegimes = ['franchise', 'reel_simpl', 'reel_normal', undefined] as const;
    const dates = ['2026-01-10', '2024-03-01', undefined] as const;
    for (const legalForm of forms) {
      for (const trade of trades) {
        for (const vatRegime of vatRegimes) {
          for (const dateCreation of dates) {
            const profile = buildInitialFiscalProfile(
              {
                id: 'co-x',
                legalForm,
                trade,
                nafApe: '43.22A',
                tvaIntracom: 'FR32123456789',
                ...(vatRegime === undefined ? {} : { vatRegime }),
                ...(dateCreation === undefined ? {} : { dateCreation }),
              },
              NOW,
            );
            expect(FiscalProfile.of(profile.toProps()).ok).toBe(true);
          }
        }
      }
    }
  });

  it('tvaIntracom seul ne dérive RIEN (signal de corroboration, jamais une déduction de régime)', () => {
    const withIntracom = buildInitialFiscalProfile(
      { id: 'c', legalForm: 'EI', trade: 'macon', tvaIntracom: 'FR32123456789' },
      NOW,
    );
    const without = buildInitialFiscalProfile({ id: 'c', legalForm: 'EI', trade: 'macon' }, NOW);
    expect(withIntracom.toProps()).toEqual(without.toProps());
  });
});
