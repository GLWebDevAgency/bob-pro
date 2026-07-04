import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExecutionContext } from '@nestjs/common';
import { jwtVerify } from 'jose';
import { deriveFiscalCalendar, MERCIER_PROPS } from '@bob/core';
import type { OcrPort, PaymentGatewayPort, PdfRendererPort } from '@bob/core';
import { BackendService } from './backend.service';
import { InMemoryPersistence } from './persistence/persistence';
import { requestContext, type AppLogger, type Principal } from './observability/logger';
import { SupabaseAuthGuard } from './auth/auth.guard';
import type { SupabaseAdminPort } from './auth/supabase-admin';
import type { NotificationDeliveryService } from './jobs/notification-delivery.service';
import type { Metrics } from './observability/metrics';

// jose mocké (même politique que subscription-tenant.test) : on teste le CONTRAT du guard sur
// GET /fiscal-calendar (JWT + tenant requis), pas la crypto — jwtVerify est piloté par chaque test.
vi.mock('jose', () => ({
  createRemoteJWKSet: vi.fn(() => async () => ({})),
  jwtVerify: vi.fn(),
}));
const jwtVerifyMock = vi.mocked(jwtVerify);

function makeService() {
  const p = new InMemoryPersistence();
  const admin: SupabaseAdminPort = { setUserCompanyId: vi.fn(async () => undefined) };
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
  return { service, p };
}

/** Exécute fn avec un Principal explicite (comme le guard en requête réelle) — sync ou async. */
function asPrincipal<T>(principal: Principal | null, fn: () => T): T {
  return requestContext.run({ correlationId: 'test', ...(principal ? { principal } : {}) }, fn);
}

function ctx(req: { url: string; method?: string; headers: Record<string, string | undefined> }): ExecutionContext {
  return { switchToHttp: () => ({ getRequest: () => req }) } as unknown as ExecutionContext;
}

const todayUtc = () => new Date().toISOString().slice(0, 10);

describe('C-EXP5b — GET /fiscal-calendar : échéancier fiscal servi depuis la company du tenant', () => {
  it('tenant seedé : mêmes échéances que le use case pur deriveFiscalCalendar (fenêtre 90 j, réglages non capturés → null)', async () => {
    const { service, p } = makeService();
    await p.seed(); // company-mercier en BDD (legalForm/vatRegime C24b)

    const before = todayUtc();
    const r = await asPrincipal({ userId: 'u-1', companyId: MERCIER_PROPS.id }, () => service.getFiscalCalendar());
    const after = todayUtc();

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Parité STRICTE avec le use case @bob/core sur la fiche du tenant — deux candidats pour
    // couvrir le (rarissime) passage de minuit UTC entre l'appel et la vérification.
    const candidates = [before, after].map((asOf) =>
      deriveFiscalCalendar({
        company: { legalForm: MERCIER_PROPS.legalForm, vatRegime: MERCIER_PROPS.vatRegime, dateCreation: null },
        asOf,
        horizonDays: 90,
        fiscalYearEnd: null,
        urssafPeriodicity: null,
      }),
    );
    expect(candidates).toContainEqual(r.value);

    // Cohérence métier : Mercier est une EI au réel simplifié — jamais d'URSSAF micro, d'IS ni de
    // rituel des comptes ; v1 honnête : AUCUN montant inventé, chaque échéance datée et expliquée.
    for (const d of r.value) {
      expect(['tva', 'cfe']).toContain(d.kind);
      expect(d.amountHint).toBeNull();
      expect(d.date >= before).toBe(true);
      expect(d.label.length).toBeGreaterThan(0);
      expect(d.explain.length).toBeGreaterThan(0);
      expect(['certain', 'assumed']).toContain(d.confidence);
    }
  });

  it('company absente : not_found PROPRE (jamais un échéancier vide qui ment)', async () => {
    const { service } = makeService(); // pas de seed

    const r = await asPrincipal({ userId: 'u-1', companyId: 'co-fantome' }, () => service.getFiscalCalendar());

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toEqual({ kind: 'not_found', entity: 'company', id: 'co-fantome' });
  });

  it('sans tenant : échec explicite côté service (le guard a répondu 403 en amont, zéro repli démo)', async () => {
    const { service } = makeService();
    // Méthode async : le requireTenant() synchrone devient un rejet de promesse — jamais un repli.
    await expect(asPrincipal(null, () => service.getFiscalCalendar())).rejects.toThrow(/PROVISIONING_REQUIRED/);
  });
});

describe('C-EXP5b — GET /fiscal-calendar au guard : JWT + tenant REQUIS (comme /diagnostic)', () => {
  // Construit à la COLLECTION (DEMO_MODE non stubbé → storage démo) : le stub DEMO_MODE=false
  // ci-dessous ne concerne que la POLITIQUE du guard, pas la construction du service.
  const { service, p } = makeService();

  beforeEach(() => {
    vi.stubEnv('DEMO_MODE', 'false');
    vi.stubEnv('SUPABASE_JWKS_URL', 'https://exemple.supabase.co/auth/v1/.well-known/jwks.json');
    jwtVerifyMock.mockReset();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('JWT valide AVEC tenant : requête admise — le Principal posé scope l’échéancier au tenant du JWT', async () => {
    jwtVerifyMock.mockResolvedValue({
      payload: { sub: 'u-1', app_metadata: { company_id: MERCIER_PROPS.id } },
    } as never);
    const guard = new SupabaseAuthGuard();
    await p.seed();

    await requestContext.run({ correlationId: 'test' }, async () => {
      const allowed = await guard.canActivate(
        ctx({ url: '/fiscal-calendar', method: 'GET', headers: { authorization: 'Bearer jwt-de-test' } }),
      );
      expect(allowed).toBe(true);
      // Même contexte ALS que la requête réelle : le service sert l'échéancier DU tenant du JWT.
      const r = await service.getFiscalCalendar();
      expect(r.ok).toBe(true);
    });
  });

  it('sans Authorization : refus — l’échéancier fiscal d’un tenant ne se lit pas anonymement', async () => {
    const guard = new SupabaseAuthGuard();
    const allowed = await requestContext.run({ correlationId: 'test' }, () =>
      guard.canActivate(ctx({ url: '/fiscal-calendar', method: 'GET', headers: {} })),
    );
    expect(allowed).toBe(false);
  });
});
