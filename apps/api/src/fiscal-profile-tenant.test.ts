import { describe, expect, it } from 'vitest';
import type { OcrPort, PaymentGatewayPort, PdfRendererPort } from '@bob/core';
import { seedCompany } from '@bob/core/testing';
import { BackendService } from './backend.service';
import { InMemoryPersistence } from './persistence/persistence.testing';
import { requestContext, type AppLogger, type Principal } from './observability/logger';
import type { SupabaseAdminPort } from './auth/supabase-admin';
import type { NotificationDeliveryService } from './jobs/notification-delivery.service';
import type { Metrics } from './observability/metrics';

function makeService() {
  const p = new InMemoryPersistence();
  const admin: SupabaseAdminPort = {
    setUserCompanyId: async () => undefined,
    deleteUser: async () => undefined,
  } as SupabaseAdminPort;
  const logger = { audit: () => undefined, error: () => undefined, warn: () => undefined, log: () => undefined } as unknown as AppLogger;
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
  return { service, p };
}

/** Exécute fn avec un Principal explicite (comme le guard en requête réelle) — sync ou async. */
function asPrincipal<T>(principal: Principal | null, fn: () => T): T {
  return requestContext.run({ correlationId: 'test', ...(principal ? { principal } : {}) }, fn);
}

describe('GET /fiscal-profile — dérivation ET persistance par tenant', () => {
  it('absent en base : dérive par hypothèses depuis la company (EI/plombier → réel IR/TNS)', async () => {
    const { service, p } = makeService();
    const company = seedCompany();
    await p.companies.save(company);

    const r = await asPrincipal({ userId: 'u-a', companyId: company.id }, () => service.getFiscalProfile());

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.companyId).toBe(company.id);
    expect(r.value.legalForm).toMatchObject({ status: 'source_fiable', value: 'EI', source: 'insee_siret' });
    expect(r.value.taxRegime).toMatchObject({ status: 'hypothese', value: 'reel_ir' });
    expect(r.value.socialStatus).toMatchObject({ status: 'hypothese', value: 'tns' });
  });

  it('deuxième lecture : relit la MÊME ligne persistée, ne re-dérive pas', async () => {
    const { service, p } = makeService();
    const company = seedCompany();
    await p.companies.save(company);

    const first = await asPrincipal({ userId: 'u-a', companyId: company.id }, () => service.getFiscalProfile());
    expect(first.ok).toBe(true);

    const persisted = await p.fiscalProfiles.findByCompanyId(company.id);
    expect(persisted).not.toBeNull();

    const second = await asPrincipal({ userId: 'u-a', companyId: company.id }, () => service.getFiscalProfile());
    expect(second.ok && first.ok && second.value).toEqual(first.ok ? first.value : undefined);
  });

  it('company introuvable : not_found — jamais un profil dérivé sans company réelle', async () => {
    const { service } = makeService();
    const r = await asPrincipal({ userId: 'u-a', companyId: 'co-inconnue' }, () => service.getFiscalProfile());
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatchObject({ kind: 'not_found', entity: 'company' });
  });

  it('sans tenant : échec explicite (le guard aurait dû répondre 403 en amont)', async () => {
    const { service } = makeService();
    await expect(asPrincipal(null, () => service.getFiscalProfile())).rejects.toThrow(/PROVISIONING_REQUIRED/);
  });
});

describe('PATCH /fiscal-profile/:field — un champ à la fois, confirmé, invariants revalidés', () => {
  it('confirme un champ : statut confirme_utilisateur, source user_form par défaut', async () => {
    const { service, p } = makeService();
    const company = seedCompany();
    await p.companies.save(company);

    const r = await asPrincipal({ userId: 'u-a', companyId: company.id }, () =>
      service.updateFiscalProfileField('vatRegime', 'reel_normal'),
    );

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.vatRegime).toMatchObject({ status: 'confirme_utilisateur', value: 'reel_normal', source: 'user_form' });
  });

  it('rejette une valeur invalide (validation) — aucune écriture', async () => {
    const { service, p } = makeService();
    const company = seedCompany();
    await p.companies.save(company);

    const r = await asPrincipal({ userId: 'u-a', companyId: company.id }, () =>
      service.updateFiscalProfileField('taxRegime', 'not_a_regime'),
    );

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatchObject({ kind: 'validation' });
    expect(await p.fiscalProfiles.findByCompanyId(company.id)).toBeNull();
  });

  it('rejette un patch qui viole les invariants du profil (erreur domaine 422)', async () => {
    const { service, p } = makeService();
    const company = seedCompany(); // EI → TNS attendu
    await p.companies.save(company);

    const r = await asPrincipal({ userId: 'u-a', companyId: company.id }, () =>
      service.updateFiscalProfileField('socialStatus', 'assimile_salarie'),
    );

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatchObject({
      kind: 'domain',
      error: { code: 'FISCAL_PROFILE_INCONSISTENT', rule: 'tns_requires_ei_micro_eurl' },
    });
  });

  it('deux mises à jour successives sur des champs différents accumulent (aucune écrasée)', async () => {
    const { service, p } = makeService();
    const company = seedCompany();
    await p.companies.save(company);

    await asPrincipal({ userId: 'u-a', companyId: company.id }, () => service.updateFiscalProfileField('vatRegime', 'franchise'));
    const second = await asPrincipal({ userId: 'u-a', companyId: company.id }, () =>
      service.updateFiscalProfileField('versementLiberatoire', false),
    );

    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.vatRegime).toMatchObject({ status: 'confirme_utilisateur', value: 'franchise' });
    expect(second.value.versementLiberatoire).toMatchObject({ status: 'confirme_utilisateur', value: false });
  });
});
