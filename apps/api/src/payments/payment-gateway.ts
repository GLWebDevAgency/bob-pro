import Stripe from 'stripe';
import { type Provider } from '@nestjs/common';
import { type PaymentGatewayPort, type CheckoutResult, type PlanTier } from '@bob/core';

export const PAYMENT_GATEWAY = Symbol('PAYMENT_GATEWAY');

/** Sans clé Stripe : liens factices déterministes (démo). */
export class DemoPaymentGateway implements PaymentGatewayPort {
  async createSubscriptionCheckout(input: { tier: PlanTier }): Promise<CheckoutResult> {
    return { url: `https://demo.bobpro.fr/checkout?tier=${input.tier}`, sessionId: `demo_sess_${input.tier}` };
  }
  async createBillingPortal(): Promise<{ url: string }> {
    return { url: 'https://demo.bobpro.fr/billing-portal' };
  }
  async createInvoicePaymentLink(input: { invoiceId: string; amountCents: number }): Promise<{ url: string }> {
    return { url: `https://demo.bobpro.fr/pay/${input.invoiceId}?amount=${input.amountCents}` };
  }
}

/** Adapter Stripe réel (clé en env). Nécessite des price IDs Stripe pour les offres. */
export class StripePaymentGateway implements PaymentGatewayPort {
  private readonly stripe: Stripe;
  constructor(
    apiKey: string,
    private readonly priceIds: Record<PlanTier, string>,
  ) {
    this.stripe = new Stripe(apiKey);
  }
  async createSubscriptionCheckout(input: {
    companyId: string;
    tier: PlanTier;
    successUrl: string;
    cancelUrl: string;
  }): Promise<CheckoutResult> {
    const session = await this.stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price: this.priceIds[input.tier], quantity: 1 }],
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
      client_reference_id: input.companyId,
    });
    return { url: session.url ?? '', sessionId: session.id };
  }
  async createBillingPortal(input: { companyId: string; returnUrl: string }): Promise<{ url: string }> {
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
          price_data: { currency: 'eur', product_data: { name: input.label }, unit_amount: input.amountCents },
        },
      ],
      success_url: 'https://demo.bobpro.fr/paid',
      cancel_url: 'https://demo.bobpro.fr/cancel',
      metadata: { invoiceId: input.invoiceId },
    });
    return { url: session.url ?? '' };
  }
}

export const paymentGatewayProvider: Provider = {
  provide: PAYMENT_GATEWAY,
  useFactory: (): PaymentGatewayPort => {
    const key = process.env.STRIPE_SECRET_KEY;
    if (key) {
      return new StripePaymentGateway(key, {
        solo: process.env.STRIPE_PRICE_SOLO ?? '',
        pro: process.env.STRIPE_PRICE_PRO ?? '',
        business: process.env.STRIPE_PRICE_BUSINESS ?? '',
      });
    }
    return new DemoPaymentGateway();
  },
};
