import Stripe from 'stripe';
import { type Provider } from '@nestjs/common';
import { type PaymentGatewayPort, type CheckoutResult, type PlanTier } from '@bob/core';

export const PAYMENT_GATEWAY = Symbol('PAYMENT_GATEWAY');

/** Sans clé Stripe : liens factices déterministes (démo). */
export class DemoPaymentGateway implements PaymentGatewayPort {
  async createSubscriptionCheckout(input: { tier: PlanTier }): Promise<CheckoutResult> {
    return {
      url: `https://demo.bobpro.fr/checkout?tier=${input.tier}`,
      sessionId: `demo_sess_${input.tier}`,
    };
  }
  async createBillingPortal(): Promise<{ url: string }> {
    return { url: 'https://demo.bobpro.fr/billing-portal' };
  }
  async createInvoicePaymentLink(input: {
    invoiceId: string;
    amountCents: number;
  }): Promise<{ url: string }> {
    return { url: `https://demo.bobpro.fr/pay/${input.invoiceId}?amount=${input.amountCents}` };
  }
}

/** Adapter Stripe réel (clé en env). Nécessite des price IDs Stripe pour les offres. */
export class StripePaymentGateway implements PaymentGatewayPort {
  private readonly stripe: Stripe;
  constructor(
    apiKey: string,
    private readonly priceIds: Partial<Record<PlanTier, string>>,
    private readonly paymentReturnBaseUrl: string,
  ) {
    this.stripe = new Stripe(apiKey);
  }

  private returnUrl(path: string, query?: Readonly<Record<string, string>>): string {
    const base = this.paymentReturnBaseUrl.endsWith('/')
      ? this.paymentReturnBaseUrl
      : `${this.paymentReturnBaseUrl}/`;
    const url = new URL(path.replace(/^\//u, ''), base);
    for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, value);
    return url.toString();
  }
  async createSubscriptionCheckout(input: {
    companyId: string;
    tier: PlanTier;
    successUrl: string;
    cancelUrl: string;
  }): Promise<CheckoutResult> {
    const price = this.priceIds[input.tier];
    if (!price)
      throw new Error(
        `Aucun price Stripe configuré pour l'offre ${input.tier} (le palier gratuit n'a pas de checkout).`,
      );
    const session = await this.stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price, quantity: 1 }],
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
      client_reference_id: input.companyId,
    });
    return { url: session.url ?? '', sessionId: session.id };
  }
  async createBillingPortal(input: {
    companyId: string;
    returnUrl: string;
  }): Promise<{ url: string }> {
    const session = await this.stripe.billingPortal.sessions.create({
      customer: input.companyId,
      return_url: input.returnUrl,
    });
    return { url: session.url };
  }
  async createInvoicePaymentLink(input: {
    invoiceId: string;
    amountCents: number;
    label: string;
  }): Promise<{ url: string }> {
    const session = await this.stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: 'eur',
            product_data: { name: input.label },
            unit_amount: input.amountCents,
          },
        },
      ],
      success_url: this.returnUrl('/paiement/succes', { invoiceId: input.invoiceId }),
      cancel_url: this.returnUrl('/paiement/annule', { invoiceId: input.invoiceId }),
      metadata: { invoiceId: input.invoiceId },
    });
    return { url: session.url ?? '' };
  }
}

type PaymentGatewayEnv = Readonly<{
  DEMO_MODE?: string;
  STRIPE_SECRET_KEY?: string;
  STRIPE_PRICE_SOLO?: string;
  STRIPE_PRICE_PRO?: string;
  STRIPE_PRICE_BUSINESS?: string;
  PAYMENT_RETURN_BASE_URL?: string;
}>;

/** Composition testable : aucune absence de secret live ne peut sélectionner l'adapter démo. */
export function buildPaymentGateway(env: PaymentGatewayEnv = process.env): PaymentGatewayPort {
  if (env.DEMO_MODE === 'true') return new DemoPaymentGateway();
  const missing = [
    !env.STRIPE_SECRET_KEY ? 'STRIPE_SECRET_KEY' : null,
    !env.STRIPE_PRICE_SOLO ? 'STRIPE_PRICE_SOLO' : null,
    !env.STRIPE_PRICE_PRO ? 'STRIPE_PRICE_PRO' : null,
    !env.STRIPE_PRICE_BUSINESS ? 'STRIPE_PRICE_BUSINESS' : null,
    !env.PAYMENT_RETURN_BASE_URL ? 'PAYMENT_RETURN_BASE_URL' : null,
  ].filter((value): value is string => value !== null);
  if (missing.length > 0) {
    throw new Error(
      `Paiement live indisponible : configuration incomplète (${missing.join(', ')}).`,
    );
  }
  const returnUrl = new URL(env.PAYMENT_RETURN_BASE_URL as string);
  if (
    returnUrl.protocol !== 'https:' ||
    returnUrl.hostname === 'localhost' ||
    returnUrl.hostname === '127.0.0.1' ||
    returnUrl.hostname === 'demo.bobpro.fr' ||
    returnUrl.username !== '' ||
    returnUrl.password !== '' ||
    returnUrl.search !== '' ||
    returnUrl.hash !== ''
  ) {
    throw new Error(
      'Paiement live indisponible : PAYMENT_RETURN_BASE_URL doit être une URL HTTPS live canonique.',
    );
  }
  return new StripePaymentGateway(
    env.STRIPE_SECRET_KEY as string,
    {
      solo: env.STRIPE_PRICE_SOLO as string,
      pro: env.STRIPE_PRICE_PRO as string,
      business: env.STRIPE_PRICE_BUSINESS as string,
    },
    env.PAYMENT_RETURN_BASE_URL as string,
  );
}

export const paymentGatewayProvider: Provider = {
  provide: PAYMENT_GATEWAY,
  useFactory: buildPaymentGateway,
};
