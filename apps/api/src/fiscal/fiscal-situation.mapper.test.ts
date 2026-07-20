import { describe, expect, it } from 'vitest';
import { mapAssimileSituation, mapMicroSituation } from './fiscal-situation.mapper';
import { PUBLICODES_RULE_MANIFEST } from './publicodes-rule-manifest';

const M = PUBLICODES_RULE_MANIFEST;

describe('mapMicroSituation', () => {
  it("mappe bic_service : catégorie juridique EI posée (pré-requis silencieux du moteur), nature commerciale, service, Cipav non", () => {
    const r = mapMicroSituation({
      type: 'micro',
      caAnnualCents: 3_000_000,
      activityNature: 'bic_service',
      acre: null,
      versementLiberatoire: false,
      date: '2026-07-15',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.situation[M.categorieJuridique]).toBe("'EI'");
    expect(r.value.situation[M.categorieJuridiqueEiAutoEntrepreneur]).toBe('oui');
    expect(r.value.situation[M.activiteNature]).toBe("'commerciale'");
    expect(r.value.situation[M.activiteServiceOuVente]).toBe("'service'");
    expect(r.value.situation[M.activiteCipav]).toBe('non');
    expect(r.value.situation[M.chiffreAffaires]).toBe('30000.00 €/an');
    expect(r.value.situation[M.evaluationDate]).toBe('15/07/2026');
    expect(r.value.situation[M.acreToggle]).toBeUndefined();
  });

  it('mappe bic_vente : service ou vente = vente', () => {
    const r = mapMicroSituation({
      type: 'micro',
      caAnnualCents: 1_000_000,
      activityNature: 'bic_vente',
      acre: null,
      versementLiberatoire: false,
      date: '2026-07-15',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.situation[M.activiteNature]).toBe("'commerciale'");
    expect(r.value.situation[M.activiteServiceOuVente]).toBe("'vente'");
  });

  it("mappe bnc : nature libérale, Cipav non, aucune clé service ou vente posée", () => {
    const r = mapMicroSituation({
      type: 'micro',
      caAnnualCents: 1_000_000,
      activityNature: 'bnc',
      acre: null,
      versementLiberatoire: false,
      date: '2026-07-15',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.situation[M.activiteNature]).toBe("'libérale'");
    expect(r.value.situation[M.activiteCipav]).toBe('non');
    expect(r.value.situation[M.activiteServiceOuVente]).toBeUndefined();
  });

  it('mappe bnc_cipav : nature libérale, Cipav oui, avec une hypothèse documentée', () => {
    const r = mapMicroSituation({
      type: 'micro',
      caAnnualCents: 1_000_000,
      activityNature: 'bnc_cipav',
      acre: null,
      versementLiberatoire: false,
      date: '2026-07-15',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.situation[M.activiteCipav]).toBe('oui');
    expect(r.value.hypotheses.length).toBeGreaterThan(0);
  });

  it('rejette explicitement les activités mixtes (trou de couverture documenté du référentiel)', () => {
    const r = mapMicroSituation({
      type: 'micro',
      caAnnualCents: 1_000_000,
      activityNature: 'mixte',
      acre: null,
      versementLiberatoire: false,
      date: '2026-07-15',
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('validation');
  });

  it('pose ACRE + date de création EI quand acre.granted=true avec startDate', () => {
    const r = mapMicroSituation({
      type: 'micro',
      caAnnualCents: 1_000_000,
      activityNature: 'bic_service',
      acre: { granted: true, startDate: '2026-01-01' },
      versementLiberatoire: false,
      date: '2026-07-15',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.situation[M.acreToggle]).toBe('oui');
    expect(r.value.situation[M.entrepriseDateCreation]).toBe('01/01/2026');
  });

  it('rejette ACRE accordée sans date de début (nécessaire pour dater le taux 50 %/75 %)', () => {
    const r = mapMicroSituation({
      type: 'micro',
      caAnnualCents: 1_000_000,
      activityNature: 'bic_service',
      acre: { granted: true },
      versementLiberatoire: false,
      date: '2026-07-15',
    });
    expect(r.ok).toBe(false);
  });

  it('pose versementLiberatoire=oui quand demandé', () => {
    const r = mapMicroSituation({
      type: 'micro',
      caAnnualCents: 1_000_000,
      activityNature: 'bic_service',
      acre: null,
      versementLiberatoire: true,
      date: '2026-07-15',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.situation[M.versementLiberatoire]).toBe('oui');
  });

  it('rejette un CA non positif ou non entier', () => {
    expect(
      mapMicroSituation({
        type: 'micro',
        caAnnualCents: 0,
        activityNature: 'bic_service',
        acre: null,
        versementLiberatoire: false,
        date: '2026-07-15',
      }).ok,
    ).toBe(false);
    expect(
      mapMicroSituation({
        type: 'micro',
        caAnnualCents: 100.5,
        activityNature: 'bic_service',
        acre: null,
        versementLiberatoire: false,
        date: '2026-07-15',
      }).ok,
    ).toBe(false);
  });

  it('rejette une date invalide', () => {
    const r = mapMicroSituation({
      type: 'micro',
      caAnnualCents: 1_000_000,
      activityNature: 'bic_service',
      acre: null,
      versementLiberatoire: false,
      date: '2026-13-01',
    });
    expect(r.ok).toBe(false);
  });
});

describe('mapAssimileSituation', () => {
  it('mappe le net cible mensuel et la catégorie juridique SAS', () => {
    const r = mapAssimileSituation({ type: 'assimile', netMensuelCibleCents: 250_000, date: '2026-07-15' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.situation[M.regimeSocial]).toBe("'assimilé salarié'");
    expect(r.value.situation[M.categorieJuridique]).toBe("'SAS'");
    expect(r.value.situation[M.netAPayerAvantImpot]).toBe('2500.00 €/mois');
    expect(r.value.situation[M.evaluationDate]).toBe('15/07/2026');
  });

  it('rejette un net cible non positif', () => {
    expect(mapAssimileSituation({ type: 'assimile', netMensuelCibleCents: 0, date: '2026-07-15' }).ok).toBe(false);
  });
});
