import { describe, expect, it } from 'vitest';
import { Company, type OcrPort, type PaymentGatewayPort, type PdfRendererPort } from '@bob/core';
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
  it('absent en base : dérive depuis la company — EI/plombier → réel IR (hypothèse) + TNS (certitude juridique)', async () => {
    const { service, p } = makeService();
    const company = seedCompany();
    await p.companies.save(company);

    const r = await asPrincipal({ userId: 'u-a', companyId: company.id }, () => service.getFiscalProfile());

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.companyId).toBe(company.id);
    expect(r.value.legalForm).toMatchObject({ status: 'source_fiable', value: 'EI', source: 'insee_siret' });
    expect(r.value.taxRegime).toMatchObject({ status: 'hypothese', value: 'reel_ir' });
    // TNS en SOURCE_FIABLE : l'entrepreneur individuel est TOUJOURS travailleur indépendant
    // (art. L611-1/L613-1 CSS) — certitude juridique de buildInitialFiscalProfile (@bob/core).
    expect(r.value.socialStatus).toMatchObject({ status: 'source_fiable', value: 'tns', source: 'derived_legal_form' });
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

  it('Phase B : la dérivation reçoit la fiche société COMPLÈTE — régime TVA d’onboarding confirmé, ACRE depuis la date de création', async () => {
    const { service, p } = makeService();
    const enriched = Company.of({ ...seedCompany().toProps(), dateCreation: '2026-01-10' });
    expect(enriched.ok).toBe(true);
    if (!enriched.ok) return;
    await p.companies.save(enriched.value);

    const r = await asPrincipal({ userId: 'u-a', companyId: enriched.value.id }, () => service.getFiscalProfile());

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Le régime TVA vient du CHOIX d'onboarding (Company.vatRegime 'reel_simpl'), converti et posé
    // 'confirme_utilisateur' / 'user_form' — plus jamais 'manquant' quand la fiche le porte.
    expect(r.value.vatRegime).toMatchObject({ status: 'confirme_utilisateur', value: 'reel_simplifie', source: 'user_form' });
    // EI (hors micro) créée < 12 mois : ACRE automatique en HYPOTHÈSE, datée de la création.
    expect(r.value.acre).toMatchObject({
      status: 'hypothese',
      value: { granted: true, startDate: '2026-01-10' },
      source: 'derived_date_creation',
    });
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

  it('SYNC Phase B : confirmer vatRegime sur le profil reflète Company.vatRegime dans la même transaction', async () => {
    const { service, p } = makeService();
    const company = seedCompany(); // vatRegime 'reel_simpl'
    await p.companies.save(company);

    const r = await asPrincipal({ userId: 'u-a', companyId: company.id }, () =>
      service.updateFiscalProfileField('vatRegime', 'reel_normal'),
    );

    expect(r.ok).toBe(true);
    const synced = await p.companies.findById(company.id);
    // Company.vatRegime pilote les échéances fiscales (deriveFiscalCalendar) : plus jamais deux
    // vérités durables entre la fiche société et le profil (« états dupliqués »).
    expect(synced?.vatRegime).toBe('reel_normal');
  });

  it('SYNC Phase B : conversion d’orthographe reel_simplifie (profil) → reel_simpl (Company)', async () => {
    const { service, p } = makeService();
    const franchised = Company.of({ ...seedCompany().toProps(), vatRegime: 'franchise' });
    expect(franchised.ok).toBe(true);
    if (!franchised.ok) return;
    await p.companies.save(franchised.value);

    const r = await asPrincipal({ userId: 'u-a', companyId: franchised.value.id }, () =>
      service.updateFiscalProfileField('vatRegime', 'reel_simplifie'),
    );

    expect(r.ok).toBe(true);
    const synced = await p.companies.findById(franchised.value.id);
    expect(synced?.vatRegime).toBe('reel_simpl');
  });

  it('SYNC Phase B : les AUTRES champs du profil ne touchent jamais Company.vatRegime', async () => {
    const { service, p } = makeService();
    const company = seedCompany(); // vatRegime 'reel_simpl'
    await p.companies.save(company);

    const r = await asPrincipal({ userId: 'u-a', companyId: company.id }, () =>
      service.updateFiscalProfileField('taxRegime', 'reel_ir'),
    );

    expect(r.ok).toBe(true);
    const untouched = await p.companies.findById(company.id);
    expect(untouched?.vatRegime).toBe('reel_simpl');
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
