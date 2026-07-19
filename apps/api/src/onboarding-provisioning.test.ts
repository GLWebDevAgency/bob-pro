import { describe, expect, it, vi } from 'vitest';
import type {
  CompanyRegistrationInput,
  OcrPort,
  PaymentGatewayPort,
  PdfRendererPort,
} from '@bob/core';
import { Company } from '@bob/core';
import { MERCIER_PROPS } from '@bob/core/testing';
import { BackendService } from './backend.service';
import { InMemoryPersistence } from './persistence/persistence.testing';
import { requestContext, type AppLogger, type Principal } from './observability/logger';
import type { SupabaseAdminPort } from './auth/supabase-admin';
import type { NotificationDeliveryService } from './jobs/notification-delivery.service';
import type { Metrics } from './observability/metrics';

const USER_ID = 'a1b2c3d4-0000-4000-8000-1234567890ab';
const INPUT: CompanyRegistrationInput = {
  name: 'Durand Élec',
  legalForm: 'EI',
  siren: MERCIER_PROPS.siren,
  siret: MERCIER_PROPS.siret,
  trade: 'electricien',
  vatRegime: 'franchise',
  address: { line1: '4 rue du Forgeron', zip: '92310', city: 'Sèvres' },
};

function makeService(subscriptionBillingAvailable = false) {
  const p = new InMemoryPersistence();
  const admin: SupabaseAdminPort = {
    setUserCompanyId: vi.fn(async () => undefined),
    deleteUser: vi.fn(async () => undefined),
  };
  const logger = { audit: vi.fn(), error: vi.fn(), warn: vi.fn(), log: vi.fn() } as unknown as AppLogger;
  const service = new BackendService(
    p,
    { subscriptionBillingAvailable } as PaymentGatewayPort,
    {} as PdfRendererPort,
    {} as OcrPort,
    admin,
    {} as NotificationDeliveryService,
    {} as Metrics,
    logger,
  );
  return { service, p, admin, logger };
}

/** Exécute fn avec un Principal explicite (comme le guard en requête réelle). */
function asPrincipal<T>(principal: Principal | null, fn: () => Promise<T>): Promise<T> {
  return requestContext.run(
    { correlationId: 'test', ...(principal ? { principal } : {}) },
    fn,
  );
}

describe('registerCompany — provisioning tenant (C24b)', () => {
  it('principal SANS tenant : crée company-<userId> (déterministe) puis écrit app_metadata via admin', async () => {
    const { service, p, admin } = makeService();

    const r = await asPrincipal({ userId: USER_ID, companyId: null }, () => service.registerCompany(INPUT));

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.companyId).toBe(`company-${USER_ID}`);
    expect(r.value.companyId).toMatch(/^[A-Za-z0-9-]{1,64}$/); // conforme au format admis par le guard
    const saved = await p.companies.findById(`company-${USER_ID}`);
    expect(saved?.name).toBe('Durand Élec');
    expect(admin.setUserCompanyId).toHaveBeenCalledWith(USER_ID, `company-${USER_ID}`);
    // V1 privée sans Stripe : accès anticipé explicite, gratuit et sans échéance.
    const subscription = await p.subscriptions.findByCompanyId(`company-${USER_ID}`);
    expect(subscription).toMatchObject({
      id: `sub-company-${USER_ID}`,
      plan: 'business',
      status: 'active',
      store: 'none',
      trialEndsAt: null,
    });
  });

  it('Phase B : natureJuridiqueCode + estRge (fiche annuaire) traversent le provisioning et sont persistés', async () => {
    const { service, p } = makeService();

    const r = await asPrincipal({ userId: USER_ID, companyId: null }, () =>
      service.registerCompany({ ...INPUT, natureJuridiqueCode: '1000', estRge: true }),
    );

    expect(r.ok).toBe(true);
    const saved = await p.companies.findById(`company-${USER_ID}`);
    // Avant cette vague, registerCompany jetait ces deux données fournies par le lookup SIRET.
    expect(saved?.natureJuridiqueCode).toBe('1000');
    expect(saved?.estRge).toBe(true);
  });

  it('retry idempotent : deux appels → MÊME id, zéro company orpheline, accès anticipé jamais réinitialisé', async () => {
    const { service, p, admin } = makeService();

    const first = await asPrincipal({ userId: USER_ID, companyId: null }, () => service.registerCompany(INPUT));
    const firstSubscription = await p.subscriptions.findByCompanyId(`company-${USER_ID}`);
    const second = await asPrincipal({ userId: USER_ID, companyId: null }, () =>
      service.registerCompany({ ...INPUT, name: 'Durand Élec SASU' }),
    );

    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.value.companyId).toBe(first.value.companyId);
    expect(admin.setUserCompanyId).toHaveBeenCalledTimes(2);
    const secondSubscription = await p.subscriptions.findByCompanyId(`company-${USER_ID}`);
    expect(secondSubscription).toEqual(firstSubscription);
    expect((await p.companies.findById(`company-${USER_ID}`))?.name).toBe('Durand Élec');
  });

  it('à l’ouverture du paiement live, un compte neuf reçoit l’essai Pro au lieu de l’accès anticipé', async () => {
    const { service, p } = makeService(true);

    const result = await asPrincipal({ userId: USER_ID, companyId: null }, () =>
      service.registerCompany(INPUT),
    );

    expect(result.ok).toBe(true);
    const subscription = await p.subscriptions.findByCompanyId(`company-${USER_ID}`);
    expect(subscription).toMatchObject({ plan: 'pro', status: 'trialing', store: null });
    expect(subscription?.trialEndsAt).toBeTruthy();
  });

  it("échec de l'écriture admin : erreur dependency EXPLICITE + log — la company créée reste réutilisable au retry", async () => {
    const { service, p, admin, logger } = makeService();
    vi.mocked(admin.setUserCompanyId).mockRejectedValueOnce(new Error('Supabase admin HTTP 500'));

    const failed = await asPrincipal({ userId: USER_ID, companyId: null }, () => service.registerCompany(INPUT));

    expect(!failed.ok && failed.error).toMatchObject({ kind: 'dependency', port: 'supabase-admin' });
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(await p.companies.findById(`company-${USER_ID}`)).toBeTruthy(); // déjà sauvée : le retry répare sans la réécrire

    const retried = await asPrincipal({ userId: USER_ID, companyId: null }, () => service.registerCompany(INPUT));
    expect(retried.ok && retried.value.companyId).toBe(`company-${USER_ID}`);
  });

  it('principal AVEC tenant : crée si absente puis un retry ne réécrit jamais la fiche, admin jamais appelé', async () => {
    const { service, p, admin } = makeService();

    const r = await asPrincipal({ userId: 'demo', companyId: 'co-existant' }, () => service.registerCompany(INPUT));
    const retry = await asPrincipal({ userId: 'demo', companyId: 'co-existant' }, () =>
      service.registerCompany({ ...INPUT, name: 'Nom forgé au retry' }),
    );

    expect(r.ok && retry.ok).toBe(true);
    if (!r.ok || !retry.ok) return;
    expect(r.value.companyId).toBe('co-existant');
    expect((await p.companies.findById('co-existant'))?.name).toBe('Durand Élec');
    expect(admin.setUserCompanyId).not.toHaveBeenCalled();
  });

  it('retry sur une company clôturée : refus ferme, aucune résurrection ni dépendance créée', async () => {
    const { service, p, admin } = makeService();
    const companyId = `company-${USER_ID}`;
    const closed = Company.of({
      ...INPUT,
      id: companyId,
      closedAt: '2026-07-18T00:00:00.000Z',
      closureReason: 'test',
    });
    if (!closed.ok) throw new Error('fixture company invalide');
    p.companies.seed(closed.value);

    const result = await asPrincipal({ userId: USER_ID, companyId: null }, () =>
      service.registerCompany({ ...INPUT, name: 'Tentative de réouverture' }),
    );

    expect(result).toMatchObject({ ok: false, error: { kind: 'forbidden' } });
    expect((await p.companies.findById(companyId))?.toProps()).toMatchObject({
      name: 'Durand Élec',
      closedAt: '2026-07-18T00:00:00.000Z',
      closureReason: 'test',
    });
    expect(await p.billingSettings.findByCompanyId(companyId)).toBeNull();
    expect(await p.subscriptions.findByCompanyId(companyId)).toBeNull();
    expect(admin.setUserCompanyId).not.toHaveBeenCalled();
  });

  it('SIRET déjà rattaché à une autre company : conflit opaque, aucun tenant partiel', async () => {
    const { service, p, admin } = makeService();
    const existing = Company.of({ ...INPUT, id: 'company-existing-owner' });
    if (!existing.ok) throw new Error('fixture company invalide');
    p.companies.seed(existing.value);

    const result = await asPrincipal({ userId: USER_ID, companyId: null }, () =>
      service.registerCompany(INPUT),
    );
    const attemptedCompanyId = `company-${USER_ID}`;

    expect(result).toMatchObject({
      ok: false,
      error: { kind: 'conflict', entity: 'company', reason: 'identity_already_registered' },
    });
    expect(await p.companies.findById(attemptedCompanyId)).toBeNull();
    expect(await p.billingSettings.findByCompanyId(attemptedCompanyId)).toBeNull();
    expect(await p.subscriptions.findByCompanyId(attemptedCompanyId)).toBeNull();
    expect(admin.setUserCompanyId).not.toHaveBeenCalled();
  });

  it('erreur tardive des dossiers : rollback Company + settings + abonnement, sans metadata Supabase', async () => {
    const { service, p, admin } = makeService();
    vi.spyOn(p.documentFolders, 'save').mockResolvedValueOnce({ status: 'name_conflict' });

    const result = await asPrincipal({ userId: USER_ID, companyId: null }, () =>
      service.registerCompany(INPUT),
    );
    const companyId = `company-${USER_ID}`;

    expect(result).toMatchObject({
      ok: false,
      error: { kind: 'conflict', entity: 'document_folder' },
    });
    expect(await p.companies.findById(companyId)).toBeNull();
    expect(await p.billingSettings.findByCompanyId(companyId)).toBeNull();
    expect(await p.subscriptions.findByCompanyId(companyId)).toBeNull();
    expect(
      (await p.documentFolders.listChildren({ companyId, parentId: null, limit: 100 })).items,
    ).toEqual([]);
    expect(admin.setUserCompanyId).not.toHaveBeenCalled();
  });

  it('profil, RIB et réglages refusent tous une company clôturée avant le moindre effet', async () => {
    const { service, p, logger } = makeService();
    const companyId = 'company-closed-writers';
    const closed = Company.of({
      ...INPUT,
      id: companyId,
      closedAt: '2026-07-18T00:00:00.000Z',
    });
    if (!closed.ok) throw new Error('fixture company invalide');
    p.companies.seed(closed.value);

    const principal = { userId: 'owner', companyId };
    const profile = await asPrincipal(principal, () =>
      service.updateCompanyProfile({ trade: 'plombier', vatRegime: 'reel_normal' }),
    );
    const billing = await asPrincipal(principal, () =>
      service.updateCompanyBilling({ iban: 'FR7630006000011234567890189' }),
    );
    const settings = await asPrincipal(principal, () =>
      service.updateCompanyBillingSettings({
        expectedRevision: 1,
        patch: { defaultDepositPercent: 42 },
      }),
    );

    for (const result of [profile, billing, settings]) {
      expect(result).toMatchObject({ ok: false, error: { kind: 'forbidden' } });
    }
    expect((await p.companies.findById(companyId))?.toProps()).toEqual(closed.value.toProps());
    expect(await p.billingSettings.findByCompanyId(companyId)).toBeNull();
    expect(logger.audit).not.toHaveBeenCalled();
  });

  it('sans Principal : erreur interne explicite (le guard doit avoir bloqué avant) — plus AUCUN repli Mercier', async () => {
    const { service, p } = makeService();
    await p.seed(); // même seedée, la société de démo ne sert plus JAMAIS de tenant par défaut

    await expect(asPrincipal(null, () => service.registerCompany(INPUT))).rejects.toThrow(/guard/i);
    // companyId() lève SYNCHRONEMENT (avant même la promesse) : le repli est mort à la racine.
    expect(() => asPrincipal(null, () => service.listCustomers())).toThrow(/PROVISIONING_REQUIRED/);
  });
});
