import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ForbiddenException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { jwtVerify } from 'jose';
import type { OcrPort, PaymentGatewayPort, PdfRendererPort } from '@bob/core';
import { BackendService } from './backend.service';
import { InMemoryPersistence } from './persistence/persistence.testing';
import { getPrincipal, requestContext, type AppLogger, type Principal } from './observability/logger';
import { SupabaseAuthGuard } from './auth/auth.guard';
import type { SupabaseAdminPort } from './auth/supabase-admin';
import type { NotificationDeliveryService } from './jobs/notification-delivery.service';
import type { Metrics } from './observability/metrics';

// jose mocké (même politique que auth.guard.test) : on teste le CONTRAT du guard sur
// GET /subscription (tenant requis), pas la crypto — jwtVerify est piloté par chaque test.
vi.mock('jose', () => ({
  createRemoteJWKSet: vi.fn(() => async () => ({})),
  jwtVerify: vi.fn(),
}));
const jwtVerifyMock = vi.mocked(jwtVerify);

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
  return { service, p };
}

/** Exécute fn avec un Principal explicite (comme le guard en requête réelle) — sync ou async. */
function asPrincipal<T>(principal: Principal | null, fn: () => T): T {
  return requestContext.run({ correlationId: 'test', ...(principal ? { principal } : {}) }, fn);
}

function ctx(req: { url: string; method?: string; headers: Record<string, string | undefined> }): ExecutionContext {
  return { switchToHttp: () => ({ getRequest: () => req }) } as unknown as ExecutionContext;
}

describe('C26b — subscription dérivée PAR TENANT (plus de singleton Mercier)', () => {
  it('GET /subscription SANS ligne DB : indisponible, jamais Business implicite', async () => {
    const { service } = makeService();

    const result = await asPrincipal({ userId: 'u-a', companyId: 'co-artisan-a' }, () => service.getSubscription());

    expect(result).toEqual({ ok: false, error: { kind: 'unavailable', service: 'subscription' } });
  });

  it('GET /subscription AVEC ligne d’essai (pilier 2) : DB-backed — Pro prêté, trialing, jours restants réels', async () => {
    const { service, p } = makeService();
    const now = new Date().toISOString();
    const endsAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();
    await p.subscriptions.startTrial({ id: 'sub-co-artisan-a', companyId: 'co-artisan-a', plan: 'pro', trialEndsAt: endsAt, now });

    const result = await asPrincipal({ userId: 'u-a', companyId: 'co-artisan-a' }, () => service.getSubscription());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const payload = result.value;

    expect(payload).toMatchObject({
      tier: 'pro',
      status: 'trialing',
      earlyAccess: false,
      priceCents: 0, // un essai ne facture RIEN — seul un abonnement actif porte le prix catalogue
      trialEndsAt: endsAt,
      trialPhase: 'active',
      trialDaysLeft: 14,
    });
    expect(payload.features).toContain('voice_live'); // le Pro complet est prêté pendant l'essai
    expect(payload.features).not.toContain('team'); // jamais plus que le palier prêté
  });

  it('essai EXPIRÉ : atterrissage doux sur Découverte (free) — conformité jamais bloquée, aucun palier fantôme', async () => {
    const { service, p } = makeService();
    const past = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
    await p.subscriptions.startTrial({
      id: 'sub-co-artisan-a',
      companyId: 'co-artisan-a',
      plan: 'pro',
      trialEndsAt: past,
      now: new Date(Date.now() - 16 * 24 * 60 * 60 * 1000).toISOString(),
    });

    const result = await asPrincipal({ userId: 'u-a', companyId: 'co-artisan-a' }, () => service.getSubscription());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const payload = result.value;

    expect(payload).toMatchObject({ tier: 'free', trialPhase: 'expired', trialDaysLeft: 0, priceCents: 0 });
    expect(payload.features).toContain('ai_quota'); // Découverte reste ouverte (facturation conforme)
    expect(payload.features).not.toContain('voice_live');
  });

  it('deux tenants → deux abonnements BDD DISTINCTS, chacun portant SON companyId', async () => {
    const { service, p } = makeService();
    const now = new Date().toISOString();
    const trialEndsAt = new Date(Date.now() + 14 * 86_400_000).toISOString();
    await p.subscriptions.startTrial({ id: 'sub-co-artisan-a', companyId: 'co-artisan-a', plan: 'pro', trialEndsAt, now });
    await p.subscriptions.startTrial({ id: 'sub-co-artisan-b', companyId: 'co-artisan-b', plan: 'solo', trialEndsAt, now });

    const a = await service['subscriptionFor']('co-artisan-a');
    const b = await service['subscriptionFor']('co-artisan-b');

    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.value.id).toBe('sub-co-artisan-a');
    expect(a.value.companyId).toBe('co-artisan-a');
    expect(b.value.id).toBe('sub-co-artisan-b');
    expect(b.value.companyId).toBe('co-artisan-b');
    expect(a.value).not.toBe(b.value);
    expect(a.value.tier).toBe('pro');
    expect(b.value.tier).toBe('solo');
    expect(a.value.isActive()).toBe(true);
  });

  it('sans tenant : échec EXPLICITE côté service — le guard doit avoir répondu 403 en amont, zéro repli', async () => {
    const { service } = makeService();
    // getSubscription lit requireTenant() avant toute I/O : plus jamais un abonnement Mercier par défaut.
    await expect(asPrincipal(null, () => service.getSubscription())).rejects.toThrow(/PROVISIONING_REQUIRED/);
  });
});

describe('C26b — GET /subscription au guard : JWT + tenant REQUIS (comme tout endpoint tenant)', () => {
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

  const BEARER = { authorization: 'Bearer jwt-de-test' };

  it('JWT valide AVEC tenant : requête admise (200) — le Principal posé alimente la dérivation par tenant', async () => {
    const now = new Date().toISOString();
    await p.subscriptions.startTrial({
      id: 'sub-co-artisan-a',
      companyId: 'co-artisan-a',
      plan: 'pro',
      trialEndsAt: new Date(Date.now() + 14 * 86_400_000).toISOString(),
      now,
    });
    jwtVerifyMock.mockResolvedValue({
      payload: { sub: 'u-1', app_metadata: { company_id: 'co-artisan-a' } },
    } as never);
    const guard = new SupabaseAuthGuard();

    await requestContext.run({ correlationId: 'test' }, async () => {
      const allowed = await guard.canActivate(ctx({ url: '/subscription', method: 'GET', headers: BEARER }));
      expect(allowed).toBe(true);
      expect(getPrincipal()).toEqual({ userId: 'u-1', companyId: 'co-artisan-a' });
      // Même contexte ALS que la requête réelle : le service dérive l'abonnement DU tenant du JWT.
      const status = await service.getSubscription();
      expect(status.ok && status.value).toMatchObject({ earlyAccess: false, priceCents: 0, tier: 'pro' });
      const subscription = await service['subscriptionFor']('co-artisan-a');
      expect(subscription.ok && subscription.value.companyId).toBe('co-artisan-a');
    });
  });

  it('JWT valide SANS tenant : 403 PROVISIONING_REQUIRED — /subscription n’est dans AUCUNE liste blanche', async () => {
    jwtVerifyMock.mockResolvedValue({ payload: { sub: 'u-1' } } as never);
    const guard = new SupabaseAuthGuard();

    await requestContext.run({ correlationId: 'test' }, async () => {
      let thrown: unknown = null;
      try {
        await guard.canActivate(ctx({ url: '/subscription', method: 'GET', headers: BEARER }));
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(ForbiddenException);
      expect((thrown as ForbiddenException).getResponse()).toMatchObject({ code: 'PROVISIONING_REQUIRED' });
    });
  });

  it('sans Authorization : refus — l’abonnement d’un tenant ne se lit pas anonymement', async () => {
    const guard = new SupabaseAuthGuard();
    const allowed = await requestContext.run({ correlationId: 'test' }, () =>
      guard.canActivate(ctx({ url: '/subscription', method: 'GET', headers: {} })),
    );
    expect(allowed).toBe(false);
  });
});
