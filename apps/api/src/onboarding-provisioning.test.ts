import { describe, expect, it, vi } from 'vitest';
import { MERCIER_PROPS, type CompanyProps, type OcrPort, type PaymentGatewayPort, type PdfRendererPort } from '@bob/core';
import { BackendService } from './backend.service';
import { InMemoryPersistence } from './persistence/persistence';
import { requestContext, type AppLogger, type Principal } from './observability/logger';
import type { SupabaseAdminPort } from './auth/supabase-admin';
import type { NotificationDeliveryService } from './jobs/notification-delivery.service';
import type { Metrics } from './observability/metrics';

const USER_ID = 'a1b2c3d4-0000-4000-8000-1234567890ab';
const INPUT: Omit<CompanyProps, 'id'> = {
  name: 'Durand Élec',
  legalForm: 'EI',
  siren: MERCIER_PROPS.siren,
  siret: MERCIER_PROPS.siret,
  trade: 'electricien',
  vatRegime: 'franchise',
  address: { line1: '4 rue du Forgeron', zip: '92310', city: 'Sèvres' },
};

function makeService() {
  const p = new InMemoryPersistence();
  const admin: SupabaseAdminPort = {
    setUserCompanyId: vi.fn(async () => undefined),
    deleteUser: vi.fn(async () => undefined),
  };
  const logger = { audit: vi.fn(), error: vi.fn(), warn: vi.fn(), log: vi.fn() } as unknown as AppLogger;
  const service = new BackendService(
    p,
    {} as PaymentGatewayPort,
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
    // Reverse trial 14 j (pilier 2) : le compte NEUF démarre en essai Pro, sans carte.
    const trial = await p.subscriptions.findByCompanyId(`company-${USER_ID}`);
    expect(trial).toMatchObject({ id: `sub-company-${USER_ID}`, plan: 'pro', status: 'trialing' });
    expect(trial?.trialEndsAt).toBeTruthy();
  });

  it('retry idempotent : deux appels → MÊME id, zéro company orpheline, échéance d’essai JAMAIS décalée', async () => {
    const { service, p, admin } = makeService();

    const first = await asPrincipal({ userId: USER_ID, companyId: null }, () => service.registerCompany(INPUT));
    const firstTrial = await p.subscriptions.findByCompanyId(`company-${USER_ID}`);
    const second = await asPrincipal({ userId: USER_ID, companyId: null }, () =>
      service.registerCompany({ ...INPUT, name: 'Durand Élec SASU' }),
    );

    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.value.companyId).toBe(first.value.companyId);
    expect(admin.setUserCompanyId).toHaveBeenCalledTimes(2);
    // Un retry (formulaire renvoyé, admin en échec…) ne redémarre JAMAIS l'essai.
    const secondTrial = await p.subscriptions.findByCompanyId(`company-${USER_ID}`);
    expect(secondTrial?.trialEndsAt).toBe(firstTrial?.trialEndsAt);
  });

  it("échec de l'écriture admin : erreur dependency EXPLICITE + log — la company créée reste réutilisable au retry", async () => {
    const { service, p, admin, logger } = makeService();
    vi.mocked(admin.setUserCompanyId).mockRejectedValueOnce(new Error('Supabase admin HTTP 500'));

    const failed = await asPrincipal({ userId: USER_ID, companyId: null }, () => service.registerCompany(INPUT));

    expect(!failed.ok && failed.error).toMatchObject({ kind: 'dependency', port: 'supabase-admin' });
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(await p.companies.findById(`company-${USER_ID}`)).toBeTruthy(); // déjà sauvée : le retry ré-écrira le MÊME id

    const retried = await asPrincipal({ userId: USER_ID, companyId: null }, () => service.registerCompany(INPUT));
    expect(retried.ok && retried.value.companyId).toBe(`company-${USER_ID}`);
  });

  it('principal AVEC tenant (démo/déjà provisionné) : update de SA société, admin JAMAIS appelé — aucun id client accepté', async () => {
    const { service, p, admin } = makeService();

    const r = await asPrincipal({ userId: 'demo', companyId: 'co-existant' }, () => service.registerCompany(INPUT));

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.companyId).toBe('co-existant');
    expect(await p.companies.findById('co-existant')).toBeTruthy();
    expect(admin.setUserCompanyId).not.toHaveBeenCalled();
  });

  it('sans Principal : erreur interne explicite (le guard doit avoir bloqué avant) — plus AUCUN repli Mercier', async () => {
    const { service, p } = makeService();
    await p.seed(); // même seedée, la société de démo ne sert plus JAMAIS de tenant par défaut

    await expect(asPrincipal(null, () => service.registerCompany(INPUT))).rejects.toThrow(/guard/i);
    // companyId() lève SYNCHRONEMENT (avant même la promesse) : le repli est mort à la racine.
    expect(() => asPrincipal(null, () => service.listCustomers())).toThrow(/PROVISIONING_REQUIRED/);
  });
});
