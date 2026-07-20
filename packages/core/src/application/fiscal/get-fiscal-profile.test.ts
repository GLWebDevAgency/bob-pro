import { describe, expect, it } from 'vitest';
import { GetFiscalProfile } from './get-fiscal-profile';
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
  seeded(companyId: string): FiscalProfile | undefined {
    return this.byCompany.get(companyId);
  }
}

const NOW = '2026-07-15T10:00:00.000Z';

describe('GetFiscalProfile — dérive et persiste l’initial si absent', () => {
  it('absent en base : dérive par hypothèses depuis la forme juridique ET le persiste', async () => {
    const repo = new FakeFiscalProfileRepository();
    const useCase = new GetFiscalProfile({ fiscalProfiles: repo });

    const r = await useCase.execute({ company: { id: 'co-1', legalForm: 'SASU', trade: 'consultant' }, now: NOW });

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.taxRegime).toMatchObject({ status: 'hypothese', value: 'is' });
    // Certitude juridique (président de SASU, art. L311-3, 11° CSS) : source_fiable, pas hypothèse.
    expect(r.value.socialStatus).toMatchObject({ status: 'source_fiable', value: 'assimile_salarie' });
    // Persisté : une seconde lecture ne re-dérive pas, elle relit la même ligne.
    expect(repo.seeded('co-1')).toBeDefined();
  });

  it('présent en base : renvoie EXACTEMENT la ligne existante, sans re-dériver', async () => {
    const repo = new FakeFiscalProfileRepository();
    const existing = buildInitialFiscalProfile({ id: 'co-2', legalForm: 'EI', trade: 'macon' }, NOW);
    const confirmed = existing.withField({ field: 'taxRegime', value: 'is' }, NOW, 'user_form');
    expect(confirmed.ok).toBe(true);
    if (!confirmed.ok) return;
    await repo.save(confirmed.value);

    const useCase = new GetFiscalProfile({ fiscalProfiles: repo });
    const r = await useCase.execute({ company: { id: 'co-2', legalForm: 'EI', trade: 'macon' }, now: NOW });

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // taxRegime a été CONFIRMÉ à 'is' précédemment — la dérivation initiale (hypothese 'reel_ir')
    // ne doit JAMAIS écraser une confirmation utilisateur déjà en base.
    expect(r.value.taxRegime).toMatchObject({ status: 'confirme_utilisateur', value: 'is' });
  });

  it('deux tenants distincts obtiennent des profils DISTINCTS', async () => {
    const repo = new FakeFiscalProfileRepository();
    const useCase = new GetFiscalProfile({ fiscalProfiles: repo });

    const a = await useCase.execute({ company: { id: 'co-a', legalForm: 'micro', trade: 'plombier' }, now: NOW });
    const b = await useCase.execute({ company: { id: 'co-b', legalForm: 'SAS', trade: 'freelance_it' }, now: NOW });

    expect(a.ok && a.value.companyId).toBe('co-a');
    expect(b.ok && b.value.companyId).toBe('co-b');
    expect(a.ok && a.value.taxRegime).toMatchObject({ value: 'micro' });
    expect(b.ok && b.value.taxRegime).toMatchObject({ value: 'is' });
  });
});
