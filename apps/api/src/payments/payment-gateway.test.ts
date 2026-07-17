import Stripe from 'stripe';
import { describe, expect, it } from 'vitest';
import { buildPaymentGateway, DisabledPaymentGateway, StripePaymentGateway } from './payment-gateway';

const LIVE_PAYMENT_ENV = {
  DEMO_MODE: 'false',
  STRIPE_SECRET_KEY: 'sk_test_config_only',
  STRIPE_PRICE_SOLO: 'price_solo',
  STRIPE_PRICE_PRO: 'price_pro',
  STRIPE_PRICE_BUSINESS: 'price_business',
  STRIPE_WEBHOOK_SECRET: 'whsec_test_only_not_a_live_secret',
  STRIPE_LIVEMODE: 'false',
  PAYMENT_RETURN_BASE_URL: 'https://app.bobpro.fr',
} as const;

describe('composition paiement — aucun lien démo en live', () => {
  it('compose un gateway désactivé quand les 7 variables Stripe sont TOUTES absentes (accès anticipé V1)', async () => {
    const gateway = buildPaymentGateway({ DEMO_MODE: 'false' }) as DisabledPaymentGateway;

    expect(gateway).toBeInstanceOf(DisabledPaymentGateway);
    expect(gateway.expectedLivemode).toBe(false);
    await expect(
      gateway.createSubscriptionCheckout({
        companyId: 'co-1',
        tier: 'pro',
        successUrl: 'https://app.bobpro.fr/success',
        cancelUrl: 'https://app.bobpro.fr/cancel',
      }),
    ).rejects.toThrow(/Paiement non activé \(accès anticipé\)/u);
    await expect(
      gateway.createBillingPortal({ companyId: 'co-1', returnUrl: 'https://app.bobpro.fr/compte' }),
    ).rejects.toThrow(/Paiement non activé \(accès anticipé\)/u);
    await expect(
      gateway.createInvoicePaymentLink({ invoiceId: 'inv-1', amountCents: 1_000, label: 'Facture' }),
    ).rejects.toThrow(/Paiement non activé \(accès anticipé\)/u);
  });

  it('échoue par erreur de configuration en live avec une configuration Stripe partielle', () => {
    expect(() =>
      buildPaymentGateway({ DEMO_MODE: 'false', STRIPE_SECRET_KEY: 'sk_test_partial' }),
    ).toThrow(
      /Paiement live indisponible.*STRIPE_PRICE_SOLO.*STRIPE_PRICE_PRO.*STRIPE_PRICE_BUSINESS.*STRIPE_WEBHOOK_SECRET.*STRIPE_LIVEMODE.*PAYMENT_RETURN_BASE_URL/u,
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
  });

  it('DEMO_MODE ne peut jamais réactiver des liens de paiement synthétiques', () => {
    // DEMO_MODE ne relâche rien ici : une configuration Stripe entamée mais incomplète reste
    // une erreur fatale, avec ou sans DEMO_MODE=true (aucun bypass démo).
    expect(() =>
      buildPaymentGateway({ DEMO_MODE: 'true', STRIPE_SECRET_KEY: 'sk_test_demo_only' }),
    ).toThrow(/Paiement live indisponible.*STRIPE_PRICE_SOLO/u);

    // Stripe totalement absent : DEMO_MODE n'accorde aucun traitement spécial, le même gateway
    // désactivé (jamais un adapter synthétique) est composé qu'avec DEMO_MODE=false.
    expect(buildPaymentGateway({ DEMO_MODE: 'true' })).toBeInstanceOf(DisabledPaymentGateway);
  });

  it('vérifie la signature sur les octets bruts exacts et refuse tout payload altéré', () => {
    const secret = LIVE_PAYMENT_ENV.STRIPE_WEBHOOK_SECRET;
    const gateway = new StripePaymentGateway(
      LIVE_PAYMENT_ENV.STRIPE_SECRET_KEY,
      { solo: 'price_solo', pro: 'price_pro', business: 'price_business' },
      LIVE_PAYMENT_ENV.PAYMENT_RETURN_BASE_URL,
      secret,
      false,
    );
    const payload = JSON.stringify({
      id: 'evt_signed',
      object: 'event',
      api_version: '2026-02-25.clover',
      created: 1_784_275_200,
      data: { object: { id: 'sub_1' } },
      livemode: false,
      pending_webhooks: 1,
      request: null,
      type: 'customer.subscription.updated',
    });
    const signature = Stripe.webhooks.generateTestHeaderString({
      payload,
      secret,
      timestamp: Math.floor(Date.now() / 1_000),
    });

    expect(gateway.verifyWebhook(Buffer.from(payload), signature).id).toBe('evt_signed');
    expect(() => gateway.verifyWebhook(Buffer.from(`${payload} `), signature)).toThrow();
  });

  it('refuse les anciens appels non tracés au lieu de réutiliser companyId comme customer Stripe', async () => {
    const gateway = new StripePaymentGateway(
      LIVE_PAYMENT_ENV.STRIPE_SECRET_KEY,
      { solo: 'price_solo', pro: 'price_pro', business: 'price_business' },
      LIVE_PAYMENT_ENV.PAYMENT_RETURN_BASE_URL,
      LIVE_PAYMENT_ENV.STRIPE_WEBHOOK_SECRET,
      false,
    );

    await expect(
      gateway.createBillingPortal({ companyId: 'co-1', returnUrl: 'https://app.bobpro.fr/compte' }),
    ).rejects.toThrow(/aucun customer Stripe durablement lié/u);
    await expect(
      gateway.createSubscriptionCheckout({
        companyId: 'co-1',
        tier: 'pro',
        successUrl: 'https://app.bobpro.fr/success',
        cancelUrl: 'https://app.bobpro.fr/cancel',
      }),
    ).rejects.toThrow(/tentative durable/u);
    await expect(
      gateway.createInvoicePaymentLink({ invoiceId: 'inv-1', amountCents: 1_000, label: 'Facture' }),
    ).rejects.toThrow(/tentative durable tenantée/u);
  });
});
