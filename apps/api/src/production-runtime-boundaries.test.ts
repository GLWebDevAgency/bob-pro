import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OcrPort, PaymentGatewayPort, PdfRendererPort } from '@bob/core';
import { BackendService } from './backend.service';
import { InMemoryPersistence } from './persistence/persistence.testing';
import { requestContext, type AppLogger, type Principal } from './observability/logger';
import type { SupabaseAdminPort } from './auth/supabase-admin';
import type { NotificationDeliveryService } from './jobs/notification-delivery.service';
import type { Metrics } from './observability/metrics';

const PRINCIPAL: Principal = { userId: 'user-owner', companyId: 'company-mercier' };

function asPrincipal<T>(fn: () => T): T {
  return requestContext.run({ correlationId: 'test', principal: PRINCIPAL }, fn);
}

function harness(gateway: PaymentGatewayPort = {} as PaymentGatewayPort) {
  const persistence = new InMemoryPersistence();
  const service = new BackendService(
    persistence,
    gateway,
    {} as PdfRendererPort,
    {} as OcrPort,
    {
      setUserCompanyId: vi.fn(async () => undefined),
      deleteUser: vi.fn(async () => undefined),
    } as SupabaseAdminPort,
    {} as NotificationDeliveryService,
    {
      aiRequests: { inc: vi.fn() },
      aiDuration: { observe: vi.fn() },
      aiGuardViolations: { inc: vi.fn() },
    } as unknown as Metrics,
    { audit: vi.fn(), error: vi.fn(), warn: vi.fn(), log: vi.fn() } as unknown as AppLogger,
  );
  return { persistence, service };
}

describe('frontières runtime live — aucune fixture silencieuse', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('getCashflow retourne unavailable en live même si le service a vu une fixture au démarrage', async () => {
    vi.stubEnv('DEMO_MODE', 'true');
    const { service } = harness();
    vi.stubEnv('DEMO_MODE', 'false');

    const result = await asPrincipal(() => service.getCashflow('realiste', 30));

    expect(result).toEqual({
      ok: false,
      error: { kind: 'unavailable', service: 'cashflow-banking-source' },
    });
  });

  it('DEMO_MODE ne réactive jamais une projection de trésorerie synthétique', async () => {
    vi.stubEnv('DEMO_MODE', 'true');
    const { persistence, service } = harness();
    await persistence.seed();

    const result = await asPrincipal(() => service.getCashflow('realiste', 30));

    expect(result).toEqual({
      ok: false,
      error: { kind: 'unavailable', service: 'cashflow-banking-source' },
    });
  });

  it('Bob retourne unavailable en live sans fournisseur LLM, jamais model=demo', async () => {
    vi.stubEnv('DEMO_MODE', 'true');
    const { persistence, service } = harness();
    await persistence.seed();
    vi.stubEnv('DEMO_MODE', 'false');
    for (const key of [
      'ANTHROPIC_API_KEY',
      'GLM_API_KEY',
      'DEEPSEEK_API_KEY',
      'MISTRAL_API_KEY',
      'OPENAI_API_KEY',
    ])
      vi.stubEnv(key, '');

    const result = await asPrincipal(() =>
      service.askBob({ message: 'Que dois-je faire aujourd’hui ?' }),
    );

    expect(result).toEqual({ ok: false, error: { kind: 'unavailable', service: 'bob-llm' } });
  });

  it('DEMO_MODE ne réactive jamais un faux modèle Bob', async () => {
    vi.stubEnv('DEMO_MODE', 'true');
    for (const key of [
      'ANTHROPIC_API_KEY',
      'GLM_API_KEY',
      'DEEPSEEK_API_KEY',
      'MISTRAL_API_KEY',
      'OPENAI_API_KEY',
    ])
      vi.stubEnv(key, '');
    const { persistence, service } = harness();
    await persistence.seed();

    const result = await asPrincipal(() => service.askBob({ message: 'Bonjour Bob' }));

    expect(result).toEqual({ ok: false, error: { kind: 'unavailable', service: 'bob-llm' } });
  });

  it('les retours Stripe sont construits depuis l’origine live, sans URL demo', async () => {
    vi.stubEnv('DEMO_MODE', 'true');
    const createSubscriptionCheckout = vi.fn(
      async (input: Parameters<PaymentGatewayPort['createSubscriptionCheckout']>[0]) => ({
        url: input.successUrl,
        sessionId: 'session',
      }),
    );
    const gateway = {
      createSubscriptionCheckout,
      createBillingPortal: vi.fn(
        async (input: Parameters<PaymentGatewayPort['createBillingPortal']>[0]) => ({
          url: input.returnUrl,
        }),
      ),
      createInvoicePaymentLink: vi.fn(async () => ({ url: 'https://pay.stripe.test/session' })),
    } as PaymentGatewayPort;
    const { service } = harness(gateway);
    vi.stubEnv('DEMO_MODE', 'false');
    vi.stubEnv('PAYMENT_RETURN_BASE_URL', 'https://app.bobpro.fr');

    await asPrincipal(() => service.startCheckout('pro'));
    await asPrincipal(() => service.billingPortal());

    expect(createSubscriptionCheckout).toHaveBeenCalledWith(
      expect.objectContaining({
        successUrl: 'https://app.bobpro.fr/abonnement/succes',
        cancelUrl: 'https://app.bobpro.fr/abonnement/annule',
      }),
    );
    expect(gateway.createBillingPortal).toHaveBeenCalledWith(
      expect.objectContaining({
        returnUrl: 'https://app.bobpro.fr/compte',
      }),
    );
    expect(
      JSON.stringify([
        createSubscriptionCheckout.mock.calls,
        vi.mocked(gateway.createBillingPortal).mock.calls,
      ]),
    ).not.toContain('demo.bobpro.fr');
  });
});
