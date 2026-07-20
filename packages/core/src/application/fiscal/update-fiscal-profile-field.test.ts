import { describe, expect, it } from 'vitest';
import { UpdateFiscalProfileField, parseFiscalProfileFieldPatch } from './update-fiscal-profile-field';
import { FiscalProfile, buildInitialFiscalProfile } from '../../domain/fiscal/fiscal-profile';
import { type FiscalProfileRepository } from '../ports/fiscal-profile-repository';

class FakeFiscalProfileRepository implements FiscalProfileRepository {
  private readonly byCompany = new Map<string, FiscalProfile>();
  async findByCompanyId(companyId: string): Promise<FiscalProfile | null> {
    return this.byCompany.get(companyId) ?? null;
  }
  async save(profile: FiscalProfile): Promise<void> {
    this.byCompany.set(profile.companyId, profile);
  }
}

const NOW = '2026-07-15T10:00:00.000Z';

describe('UpdateFiscalProfileField — un champ à la fois, confirmé, invariants revalidés', () => {
  it('absent en base : dérive l’initial puis applique le patch par-dessus', async () => {
    const repo = new FakeFiscalProfileRepository();
    const useCase = new UpdateFiscalProfileField({ fiscalProfiles: repo });

    const r = await useCase.execute({
      company: { id: 'co-1', legalForm: 'EI', trade: 'macon' },
      patch: { field: 'vatRegime', value: 'reel_normal' },
      now: NOW,
      source: 'user_voice',
    });

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.vatRegime).toEqual({ status: 'confirme_utilisateur', value: 'reel_normal', updatedAt: NOW, source: 'user_voice' });
    // Les autres champs dérivés restent intacts (TNS certain pour une EI : source_fiable).
    expect(r.value.socialStatus).toMatchObject({ status: 'source_fiable', value: 'tns' });
  });

  it('présent en base : le patch s’applique sur la ligne existante, persistée', async () => {
    const repo = new FakeFiscalProfileRepository();
    await repo.save(buildInitialFiscalProfile({ id: 'co-2', legalForm: 'SASU', trade: 'consultant' }, NOW));
    const useCase = new UpdateFiscalProfileField({ fiscalProfiles: repo });

    const r = await useCase.execute({
      company: { id: 'co-2', legalForm: 'SASU', trade: 'consultant' },
      patch: { field: 'acre', value: { granted: true, startDate: '2026-09-01' } },
      now: NOW,
    });

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.acre).toMatchObject({ status: 'confirme_utilisateur', value: { granted: true, startDate: '2026-09-01' } });
    const persisted = await repo.findByCompanyId('co-2');
    expect(persisted?.acre).toMatchObject({ status: 'confirme_utilisateur' });
  });

  it('rejette un patch qui rend le profil incohérent — erreur domaine, rien n’est persisté', async () => {
    const repo = new FakeFiscalProfileRepository();
    await repo.save(buildInitialFiscalProfile({ id: 'co-3', legalForm: 'SASU', trade: 'consultant' }, NOW));
    const useCase = new UpdateFiscalProfileField({ fiscalProfiles: repo });

    const r = await useCase.execute({
      company: { id: 'co-3', legalForm: 'SASU', trade: 'consultant' },
      patch: { field: 'socialStatus', value: 'tns' },
      now: NOW,
    });

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatchObject({ kind: 'domain', error: { code: 'FISCAL_PROFILE_INCONSISTENT', rule: 'assimile_requires_sasu_or_sas' } });
    const persisted = await repo.findByCompanyId('co-3');
    expect(persisted?.socialStatus).toMatchObject({ status: 'source_fiable', value: 'assimile_salarie' }); // inchangé
  });

  it('source par défaut = user_form quand non précisée', async () => {
    const repo = new FakeFiscalProfileRepository();
    const useCase = new UpdateFiscalProfileField({ fiscalProfiles: repo });

    const r = await useCase.execute({
      company: { id: 'co-4', legalForm: 'EI', trade: 'autre' },
      patch: { field: 'versementLiberatoire', value: false },
      now: NOW,
    });

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.versementLiberatoire).toMatchObject({ source: 'user_form' });
  });
});

describe('parseFiscalProfileFieldPatch — validation de forme (HTTP/voix)', () => {
  it('rejette un champ inconnu', () => {
    const r = parseFiscalProfileFieldPatch('nonExistent', 'x');
    expect(r.ok).toBe(false);
  });

  it.each([
    ['legalForm', 'SASU'],
    ['taxRegime', 'is'],
    ['socialStatus', 'tns'],
    ['activityNature', 'bnc'],
    ['vatRegime', 'reel_normal'],
    ['versementLiberatoire', true],
  ] as const)('accepte %s avec une valeur valide', (field, value) => {
    const r = parseFiscalProfileFieldPatch(field, value);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toEqual({ field, value });
  });

  it('rejette une valeur enum invalide', () => {
    const r = parseFiscalProfileFieldPatch('taxRegime', 'not_a_regime');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatchObject({ kind: 'validation' });
  });

  it('acre : accepte { granted, startDate? }, rejette une forme invalide', () => {
    expect(parseFiscalProfileFieldPatch('acre', { granted: true, startDate: '2026-07-01' })).toMatchObject({
      ok: true,
      value: { field: 'acre', value: { granted: true, startDate: '2026-07-01' } },
    });
    expect(parseFiscalProfileFieldPatch('acre', { granted: false }).ok && true).toBe(true);
    expect(parseFiscalProfileFieldPatch('acre', { granted: 'yes' }).ok).toBe(false);
    expect(parseFiscalProfileFieldPatch('acre', null).ok).toBe(false);
  });

  it('fiscalYearEnd : accepte null ou { month, day }, rejette un mois hors bornes', () => {
    expect(parseFiscalProfileFieldPatch('fiscalYearEnd', null)).toMatchObject({ ok: true, value: { field: 'fiscalYearEnd', value: null } });
    expect(parseFiscalProfileFieldPatch('fiscalYearEnd', { month: 6, day: 30 })).toMatchObject({
      ok: true,
      value: { field: 'fiscalYearEnd', value: { month: 6, day: 30 } },
    });
    expect(parseFiscalProfileFieldPatch('fiscalYearEnd', { month: 13, day: 1 }).ok).toBe(false);
  });

  it('versementLiberatoire : rejette une valeur non booléenne', () => {
    expect(parseFiscalProfileFieldPatch('versementLiberatoire', 'true').ok).toBe(false);
  });
});
