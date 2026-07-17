import { describe, expect, it } from 'vitest';
import { buildPaymentGateway, DemoPaymentGateway, StripePaymentGateway } from './payment-gateway';

const LIVE_PAYMENT_ENV = {
  DEMO_MODE: 'false',
  STRIPE_SECRET_KEY: 'sk_test_config_only',
  STRIPE_PRICE_SOLO: 'price_solo',
  STRIPE_PRICE_PRO: 'price_pro',
  STRIPE_PRICE_BUSINESS: 'price_business',
  PAYMENT_RETURN_BASE_URL: 'https://app.bobpro.fr',
} as const;

describe('composition paiement — aucun lien démo en live', () => {
  it('échoue par erreur de configuration en live sans Stripe', () => {
    expect(() => buildPaymentGateway({ DEMO_MODE: 'false' })).toThrow(
      /Paiement live indisponible.*STRIPE_SECRET_KEY/u,
    );
  });

  it('refuse une origine de retour démo ou non canonique en live', () => {
    expect(() =>
      buildPaymentGateway({
        ...LIVE_PAYMENT_ENV,
        PAYMENT_RETURN_BASE_URL: 'https://demo.bobpro.fr',
      }),
    ).toThrow(/URL HTTPS live canonique/u);
  });

  it('compose Stripe seulement avec la configuration live complète', () => {
    const gateway = buildPaymentGateway(LIVE_PAYMENT_ENV);

    expect(gateway).toBeInstanceOf(StripePaymentGateway);
    expect(gateway).not.toBeInstanceOf(DemoPaymentGateway);
  });

  it('conserve les liens déterministes uniquement sur opt-in DEMO_MODE=true', async () => {
    const gateway = buildPaymentGateway({ DEMO_MODE: 'true' });

    expect(gateway).toBeInstanceOf(DemoPaymentGateway);
    await expect(
      gateway.createBillingPortal({ companyId: 'demo', returnUrl: 'ignored' }),
    ).resolves.toEqual({ url: 'https://demo.bobpro.fr/billing-portal' });
  });
});
