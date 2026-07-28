import { describe, expect, it } from 'vitest';
import {
  DEFAULT_INTERVENTION_REPORT_TITLE,
  type CompanyInterventionSettings,
  type CompanyInterventionSettingsRepository,
  checklistTemplateForKind,
} from './intervention-repository';
import {
  MAX_INTERVENTION_CHECKLIST_TEMPLATES,
  MAX_INTERVENTION_REPORT_TITLE_LENGTH,
  UpdateCompanyInterventionSettings,
  effectiveInterventionSettings,
} from './update-company-intervention-settings';

/**
 * [Revue adversariale 28/07 — finding 5] Le « titre PARAMÉTRABLE par société » (§3.2, écrans
 * §4.5) était LU partout sans aucun chemin d'écriture : ces tests couvrent le use case qui le
 * rend enfin atteignable, ses bornes (miroir des CHECK SQL) et son CAS.
 */

const COMPANY = 'co-1';

function makeRepo(): CompanyInterventionSettingsRepository & {
  rows: Map<string, CompanyInterventionSettings>;
} {
  const rows = new Map<string, CompanyInterventionSettings>();
  return {
    rows,
    find: async (companyId) => {
      const found = rows.get(companyId);
      return found === undefined
        ? null
        : { ...found, checklistTemplates: { ...found.checklistTemplates } };
    },
    save: async (settings) => {
      rows.set(settings.companyId, {
        ...settings,
        checklistTemplates: { ...settings.checklistTemplates },
      });
    },
  };
}

const useCase = (repo: CompanyInterventionSettingsRepository) =>
  new UpdateCompanyInterventionSettings({ interventionSettings: repo });

describe('UpdateCompanyInterventionSettings — le titre devient enfin PARAMÉTRABLE (§3.2)', () => {
  it('sans réglage : le défaut produit s’applique et la révision d’écriture vaut 0', () => {
    const effective = effectiveInterventionSettings(COMPANY, null);
    expect(effective.reportTitle).toBeNull();
    expect(effective.effectiveReportTitle).toBe(DEFAULT_INTERVENTION_REPORT_TITLE);
    expect(effective.revision).toBe(0);
  });

  it('première écriture : titre posé, révision 1, templates lisibles par kind', async () => {
    const repo = makeRepo();
    const r = await useCase(repo).execute({
      companyId: COMPANY,
      reportTitle: '  Certificat sanitaire  ',
      checklistTemplates: { 'Visite d’entretien': ['Détartrage', ' Contrôle de pression '] },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.reportTitle).toBe('Certificat sanitaire');
    expect(r.value.revision).toBe(1);
    // Le template est retrouvé par le kind dicté, quelle que soit la casse (règle de lecture).
    expect(checklistTemplateForKind(r.value, 'VISITE D’ENTRETIEN ')).toEqual([
      'Détartrage',
      'Contrôle de pression',
    ]);
  });

  it('titre vidé : RETOUR au défaut produit, jamais un titre vide sur une pièce de preuve', async () => {
    const repo = makeRepo();
    await useCase(repo).execute({ companyId: COMPANY, reportTitle: 'Certificat sanitaire' });
    const cleared = await useCase(repo).execute({
      companyId: COMPANY,
      reportTitle: '   ',
      expectedRevision: 1,
    });
    expect(cleared.ok).toBe(true);
    if (!cleared.ok) return;
    expect(cleared.value.reportTitle).toBeNull();
    expect(effectiveInterventionSettings(COMPANY, cleared.value).effectiveReportTitle).toBe(
      DEFAULT_INTERVENTION_REPORT_TITLE,
    );
  });

  it('champ absent = INCHANGÉ (une écriture de templates n’efface pas le titre)', async () => {
    const repo = makeRepo();
    await useCase(repo).execute({ companyId: COMPANY, reportTitle: 'Certificat sanitaire' });
    const r = await useCase(repo).execute({
      companyId: COMPANY,
      checklistTemplates: { Détartrage: ['Filtre'] },
      expectedRevision: 1,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.reportTitle).toBe('Certificat sanitaire');
    expect(r.value.revision).toBe(2);
  });

  it('CAS : révision périmée ou absente sur des réglages existants = conflit EXPLICITE', async () => {
    const repo = makeRepo();
    await useCase(repo).execute({ companyId: COMPANY, reportTitle: 'Certificat sanitaire' });
    const stale = await useCase(repo).execute({
      companyId: COMPANY,
      reportTitle: 'Autre',
      expectedRevision: 99,
    });
    expect(stale).toMatchObject({ ok: false, error: { kind: 'conflict', reason: 'stale_revision' } });
    const missing = await useCase(repo).execute({ companyId: COMPANY, reportTitle: 'Autre' });
    expect(missing).toMatchObject({ ok: false, error: { kind: 'conflict' } });
    // Aucun écrasement : la valeur d'origine tient.
    expect(repo.rows.get(COMPANY)?.reportTitle).toBe('Certificat sanitaire');
  });

  it('bornes MIROIR du CHECK SQL : titre trop long, contrôle, doublon de kind, quota', async () => {
    const repo = makeRepo();
    const tooLong = await useCase(repo).execute({
      companyId: COMPANY,
      reportTitle: 'x'.repeat(MAX_INTERVENTION_REPORT_TITLE_LENGTH + 1),
    });
    expect(tooLong.ok).toBe(false);
    const control = await useCase(repo).execute({ companyId: COMPANY, reportTitle: 'Fiche\u0007' });
    expect(control.ok).toBe(false);
    const duplicate = await useCase(repo).execute({
      companyId: COMPANY,
      checklistTemplates: { Détartrage: ['a'], 'détartrage ': ['b'] },
    });
    expect(duplicate.ok).toBe(false);
    if (!duplicate.ok) expect(JSON.stringify(duplicate.error)).toContain('même type de passage');
    const templates: Record<string, string[]> = {};
    for (let i = 0; i <= MAX_INTERVENTION_CHECKLIST_TEMPLATES; i += 1) templates[`kind-${i}`] = ['a'];
    const quota = await useCase(repo).execute({ companyId: COMPANY, checklistTemplates: templates });
    expect(quota.ok).toBe(false);
    // Aucun demi-état : rien n'a été persisté par les refus.
    expect(repo.rows.size).toBe(0);
  });

  it('appel vide : refus ACTIONNABLE (« rien à modifier »), aucune révision consommée', async () => {
    const repo = makeRepo();
    const r = await useCase(repo).execute({ companyId: COMPANY });
    expect(r.ok).toBe(false);
    expect(repo.rows.size).toBe(0);
  });
});
