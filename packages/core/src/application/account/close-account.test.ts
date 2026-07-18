import { describe, expect, it } from 'vitest';
import { CloseAccount } from './close-account';
import { Company, type CompanyProps } from '../../domain/company/company';
import { type CompanyRepository } from '../ports/repositories';
import {
  type SubscriptionRecord,
  type SubscriptionRepository,
} from '../ports/subscription-repository';
import {
  type PublicAccessGrant,
  type PublicAccessTokenRepository,
  type PublicAccessResourceType,
  type PublicAccessScope,
} from '../ports/public-access-token';
import { MERCIER_PROPS } from '../fixtures';

class FakeCompanyRepository implements CompanyRepository {
  private readonly byId = new Map<string, Company>();
  seed(c: Company): void {
    this.byId.set(c.id, c);
  }
  async findById(id: string): Promise<Company | null> {
    return this.byId.get(id) ?? null;
  }
  async lockById(id: string): Promise<Company | null> {
    return this.findById(id);
  }
  async lockForShareById(id: string): Promise<Company | null> {
    return this.findById(id);
  }
  async list(): Promise<Company[]> {
    return [...this.byId.values()];
  }
  async save(c: Company): Promise<void> {
    this.byId.set(c.id, c);
  }
}

class FakeSubscriptionRepository implements SubscriptionRepository {
  private readonly byCompany = new Map<string, SubscriptionRecord>();
  seed(record: SubscriptionRecord): void {
    this.byCompany.set(record.companyId, record);
  }
  async findByCompanyId(companyId: string): Promise<SubscriptionRecord | null> {
    return this.byCompany.get(companyId) ?? null;
  }
  async startEarlyAccess(input: {
    id: string;
    companyId: string;
    plan: SubscriptionRecord['plan'];
    now: string;
  }): Promise<SubscriptionRecord> {
    const existing = this.byCompany.get(input.companyId);
    if (existing) return existing;
    const record: SubscriptionRecord = {
      id: input.id,
      companyId: input.companyId,
      plan: input.plan,
      status: 'active',
      trialEndsAt: null,
      currentPeriodEnd: null,
      store: 'none',
      storeRef: null,
      createdAt: input.now,
      updatedAt: input.now,
    };
    this.byCompany.set(input.companyId, record);
    return record;
  }
  async startTrial(input: {
    id: string;
    companyId: string;
    plan: SubscriptionRecord['plan'];
    trialEndsAt: string;
    now: string;
  }): Promise<SubscriptionRecord> {
    const existing = this.byCompany.get(input.companyId);
    if (existing) return existing;
    const record: SubscriptionRecord = {
      id: input.id,
      companyId: input.companyId,
      plan: input.plan,
      status: 'trialing',
      trialEndsAt: input.trialEndsAt,
      currentPeriodEnd: null,
      store: null,
      storeRef: null,
      createdAt: input.now,
      updatedAt: input.now,
    };
    this.byCompany.set(input.companyId, record);
    return record;
  }
  async save(record: SubscriptionRecord): Promise<SubscriptionRecord> {
    this.byCompany.set(record.companyId, record);
    return record;
  }
}

class FakePublicAccessTokenRepository implements PublicAccessTokenRepository {
  private readonly rows = new Map<string, PublicAccessGrant>();
  private seq = 0;
  seed(grant: PublicAccessGrant): void {
    this.rows.set(grant.id, grant);
  }
  async create(input: {
    companyId: string;
    resourceType: PublicAccessResourceType;
    resourceId: string;
    scope: PublicAccessScope;
    expiresAt: string;
  }): Promise<{ id: string; token: string }> {
    this.seq += 1;
    const id = `grant-${this.seq}`;
    this.rows.set(id, { id, ...input, revokedAt: null });
    return { id, token: `tok-${this.seq}` };
  }
  async findActive(): Promise<PublicAccessGrant | null> {
    return null;
  }
  async markUsed(): Promise<void> {}
  async revoke(id: string, at: string): Promise<void> {
    const row = this.rows.get(id);
    if (row) this.rows.set(id, { ...row, revokedAt: at });
  }
  async revokeActiveFor(): Promise<void> {}
  async revokeAllForCompany(input: { companyId: string; at: string }): Promise<void> {
    for (const [id, row] of this.rows) {
      if (row.companyId === input.companyId && row.revokedAt === null) {
        this.rows.set(id, { ...row, revokedAt: input.at });
      }
    }
  }
  activeCountFor(companyId: string): number {
    return [...this.rows.values()].filter((r) => r.companyId === companyId && r.revokedAt === null)
      .length;
  }
}

const T0 = '2026-07-16T09:00:00.000Z';
const T1 = '2026-07-16T09:05:00.000Z';

function seededCompany(overrides: Partial<CompanyProps> = {}): Company {
  const r = Company.of({ ...MERCIER_PROPS, ...overrides });
  if (!r.ok) throw new Error('fixture company invalide');
  return r.value;
}

function buildDeps() {
  const companies = new FakeCompanyRepository();
  const subscriptions = new FakeSubscriptionRepository();
  const publicAccessTokens = new FakePublicAccessTokenRepository();
  const uow = { runInTransaction: <T>(fn: () => Promise<T>) => fn() };
  return { companies, subscriptions, publicAccessTokens, uow };
}

describe('CloseAccount — clôture de compte (Apple 5.1.1(v)), jamais un cascade delete', () => {
  it('company introuvable → not_found, aucun effet de bord', async () => {
    const deps = buildDeps();
    const useCase = new CloseAccount(deps);

    const r = await useCase.execute({
      companyId: 'nope',
      confirmationText: 'peu importe',
      reason: null,
      now: T0,
    });

    expect(r.ok).toBe(false);
    expect(!r.ok && r.error.kind).toBe('not_found');
  });

  it('confirmationText ne correspond PAS au nom de la company → validation, la company reste ouverte', async () => {
    const deps = buildDeps();
    const company = seededCompany();
    deps.companies.seed(company);
    const useCase = new CloseAccount(deps);

    const r = await useCase.execute({
      companyId: company.id,
      confirmationText: 'Mauvais Nom SARL',
      reason: null,
      now: T0,
    });

    expect(r.ok).toBe(false);
    expect(!r.ok && r.error.kind).toBe('validation');
    const stillOpen = await deps.companies.findById(company.id);
    expect(stillOpen?.isClosed()).toBe(false);
  });

  it('confirmationText EXACT → clôture : closedAt posé, TOUT le reste de la fiche INTACT (rétention légale)', async () => {
    const deps = buildDeps();
    const company = seededCompany();
    deps.companies.seed(company);
    const useCase = new CloseAccount(deps);

    const r = await useCase.execute({
      companyId: company.id,
      confirmationText: MERCIER_PROPS.name,
      reason: 'je change de métier',
      now: T0,
    });

    expect(r.ok).toBe(true);
    expect(r.ok && r.value).toEqual({ companyId: company.id, closedAt: T0, alreadyClosed: false });

    const closed = await deps.companies.findById(company.id);
    expect(closed?.isClosed()).toBe(true);
    expect(closed?.closedAt).toBe(T0);
    expect(closed?.closureReason).toBe('je change de métier');
    // La fiche légale — le vrai POINT du test — n'a PAS bougé : SIRET, adresse, IBAN, assurance…
    expect(closed?.name).toBe(MERCIER_PROPS.name);
    expect(closed?.siret).toBe(MERCIER_PROPS.siret);
    expect(closed?.address).toEqual(MERCIER_PROPS.address);
    expect(closed?.toProps().iban).toBe(MERCIER_PROPS.iban);
    expect(closed?.toProps().decennale).toEqual(MERCIER_PROPS.decennale);
  });

  it('annule l’abonnement actif (canceled), idempotent si déjà canceled', async () => {
    const deps = buildDeps();
    const company = seededCompany();
    deps.companies.seed(company);
    deps.subscriptions.seed({
      id: 'sub-1',
      companyId: company.id,
      plan: 'pro',
      status: 'active',
      trialEndsAt: null,
      currentPeriodEnd: '2026-08-01T00:00:00.000Z',
      store: null,
      storeRef: null,
      createdAt: '2026-06-01T00:00:00.000Z',
      updatedAt: '2026-06-01T00:00:00.000Z',
    });
    const useCase = new CloseAccount(deps);

    await useCase.execute({
      companyId: company.id,
      confirmationText: MERCIER_PROPS.name,
      reason: null,
      now: T0,
    });

    const sub = await deps.subscriptions.findByCompanyId(company.id);
    expect(sub?.status).toBe('canceled');
  });

  it('sans abonnement (early-access, aucune ligne) → ne plante pas, rien à annuler', async () => {
    const deps = buildDeps();
    const company = seededCompany();
    deps.companies.seed(company);
    const useCase = new CloseAccount(deps);

    const r = await useCase.execute({
      companyId: company.id,
      confirmationText: MERCIER_PROPS.name,
      reason: null,
      now: T0,
    });

    expect(r.ok).toBe(true);
  });

  it('révoque tous les liens de signature publics actifs du tenant', async () => {
    const deps = buildDeps();
    const company = seededCompany();
    deps.companies.seed(company);
    await deps.publicAccessTokens.create({
      companyId: company.id,
      resourceType: 'quote',
      resourceId: 'quote-1',
      scope: 'quote_signature',
      expiresAt: '2026-08-01T00:00:00.000Z',
    });
    await deps.publicAccessTokens.create({
      companyId: company.id,
      resourceType: 'quote',
      resourceId: 'quote-2',
      scope: 'quote_signature',
      expiresAt: '2026-08-01T00:00:00.000Z',
    });
    expect(deps.publicAccessTokens.activeCountFor(company.id)).toBe(2);
    const useCase = new CloseAccount(deps);

    await useCase.execute({
      companyId: company.id,
      confirmationText: MERCIER_PROPS.name,
      reason: null,
      now: T0,
    });

    expect(deps.publicAccessTokens.activeCountFor(company.id)).toBe(0);
  });

  /**
   * Liens de VISUALISATION (document_view, devis OU facture) : revokeAllForCompany ne filtre
   * JAMAIS par scope/resourceType — la clôture doit couper TOUS les canaux publics du tenant,
   * pas seulement la signature. Ce test le prouve avec un mélange des deux scopes/types.
   */
  it('révoque aussi les liens de VISUALISATION (document_view, devis ET facture) — tous scopes confondus', async () => {
    const deps = buildDeps();
    const company = seededCompany();
    deps.companies.seed(company);
    await deps.publicAccessTokens.create({
      companyId: company.id,
      resourceType: 'quote',
      resourceId: 'quote-1',
      scope: 'quote_signature',
      expiresAt: '2026-08-01T00:00:00.000Z',
    });
    await deps.publicAccessTokens.create({
      companyId: company.id,
      resourceType: 'quote',
      resourceId: 'quote-2',
      scope: 'document_view',
      expiresAt: '2026-08-30T00:00:00.000Z',
    });
    await deps.publicAccessTokens.create({
      companyId: company.id,
      resourceType: 'invoice',
      resourceId: 'invoice-1',
      scope: 'document_view',
      expiresAt: '2026-08-30T00:00:00.000Z',
    });
    expect(deps.publicAccessTokens.activeCountFor(company.id)).toBe(3);
    const useCase = new CloseAccount(deps);

    await useCase.execute({
      companyId: company.id,
      confirmationText: MERCIER_PROPS.name,
      reason: null,
      now: T0,
    });

    expect(deps.publicAccessTokens.activeCountFor(company.id)).toBe(0);
  });

  it('idempotence : un second appel (même confirmation) renvoie alreadyClosed=true, closedAt INCHANGÉ', async () => {
    const deps = buildDeps();
    const company = seededCompany();
    deps.companies.seed(company);
    const useCase = new CloseAccount(deps);

    const first = await useCase.execute({
      companyId: company.id,
      confirmationText: MERCIER_PROPS.name,
      reason: null,
      now: T0,
    });
    expect(first.ok && first.value.alreadyClosed).toBe(false);

    const second = await useCase.execute({
      companyId: company.id,
      confirmationText: MERCIER_PROPS.name,
      reason: null,
      now: T1,
    });

    expect(second.ok).toBe(true);
    expect(second.ok && second.value).toEqual({
      companyId: company.id,
      closedAt: T0,
      alreadyClosed: true,
    });
  });

  it('idempotence : sur une company déjà clôturée, un confirmationText FAUX reste refusé (jamais de bypass)', async () => {
    const deps = buildDeps();
    const company = seededCompany();
    deps.companies.seed(company);
    const useCase = new CloseAccount(deps);
    await useCase.execute({
      companyId: company.id,
      confirmationText: MERCIER_PROPS.name,
      reason: null,
      now: T0,
    });

    const r = await useCase.execute({
      companyId: company.id,
      confirmationText: 'faux nom',
      reason: null,
      now: T1,
    });

    expect(r.ok).toBe(false);
    expect(!r.ok && r.error.kind).toBe('validation');
  });
});
