import Stripe from 'stripe';
import { type Provider } from '@nestjs/common';
import { type PaymentGatewayPort, type CheckoutResult, type PlanTier } from '@bob/core';
import type {
  StripeBillingProvider,
  StripeCheckoutSessionSnapshot,
  StripeSubscriptionSnapshot,
  VerifiedStripeWebhookEvent,
} from './stripe-billing-contract';

export const PAYMENT_GATEWAY = Symbol('PAYMENT_GATEWAY');

/** Adapter Stripe réel (clé en env). Nécessite des price IDs Stripe pour les offres. */
export class StripePaymentGateway implements PaymentGatewayPort, StripeBillingProvider {
  private readonly stripe: Stripe;
  constructor(
    apiKey: string,
    private readonly priceIds: Partial<Record<PlanTier, string>>,
    private readonly paymentReturnBaseUrl: string,
    private readonly webhookSecret: string,
    readonly expectedLivemode: boolean,
  ) {
    this.stripe = new Stripe(apiKey);
  }

  private providerUrl(value: string | null, surface: 'checkout' | 'portal'): string {
    if (!value) throw new Error(`Stripe n'a renvoyé aucune URL ${surface}.`);
    const url = new URL(value);
    const expectedHost = surface === 'checkout' ? 'checkout.stripe.com' : 'billing.stripe.com';
    if (url.protocol !== 'https:' || url.hostname !== expectedHost) {
      throw new Error(`Stripe a renvoyé une URL ${surface} non canonique.`);
    }
    return url.toString();
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
    checkoutAttemptId?: string;
    tier: PlanTier;
    stripeCustomerId?: string | null;
    successUrl: string;
    cancelUrl: string;
  }): Promise<CheckoutResult> {
    if (!input.checkoutAttemptId || input.stripeCustomerId === undefined) {
      throw new Error('Checkout Stripe refusé : tentative durable et liaison client requises.');
    }
    const price = this.priceIds[input.tier];
    if (!price)
      throw new Error(
        `Aucun price Stripe configuré pour l'offre ${input.tier} (le palier gratuit n'a pas de checkout).`,
      );
    const metadata = {
      bob_company_id: input.companyId,
      bob_checkout_id: input.checkoutAttemptId,
      bob_purpose: 'subscription',
      bob_plan: input.tier,
    } as const;
    const session = await this.stripe.checkout.sessions.create(
      {
        mode: 'subscription',
        line_items: [{ price, quantity: 1 }],
        success_url: input.successUrl,
        cancel_url: input.cancelUrl,
        client_reference_id: input.companyId,
        metadata,
        subscription_data: { metadata },
        ...(input.stripeCustomerId ? { customer: input.stripeCustomerId } : {}),
      },
      { idempotencyKey: `bob-subscription-checkout-${input.checkoutAttemptId}` },
    );
    return { url: this.providerUrl(session.url, 'checkout'), sessionId: session.id };
  }
  async createBillingPortal(input: {
    stripeCustomerId?: string;
    companyId?: string;
    returnUrl: string;
  }): Promise<{ url: string }> {
    if (!input.stripeCustomerId) {
      throw new Error('Portail Stripe indisponible : aucun customer Stripe durablement lié.');
    }
    const session = await this.stripe.billingPortal.sessions.create({
      customer: input.stripeCustomerId,
      return_url: input.returnUrl,
    });
    return { url: this.providerUrl(session.url, 'portal') };
  }
  async createInvoicePaymentLink(input: {
    companyId?: string;
    checkoutAttemptId?: string;
    invoiceId: string;
    amountCents: number;
    label: string;
  }): Promise<CheckoutResult> {
    if (!input.companyId || !input.checkoutAttemptId) {
      throw new Error('Paiement Stripe refusé : tentative durable tenantée requise.');
    }
    const metadata = {
      bob_company_id: input.companyId,
      bob_checkout_id: input.checkoutAttemptId,
      bob_purpose: 'invoice_payment',
      bob_invoice_id: input.invoiceId,
    } as const;
    const session = await this.stripe.checkout.sessions.create(
      {
        mode: 'payment',
        payment_method_types: ['card'],
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
        client_reference_id: input.companyId,
        metadata,
        payment_intent_data: { metadata },
      },
      { idempotencyKey: `bob-invoice-checkout-${input.checkoutAttemptId}` },
    );
    return { url: this.providerUrl(session.url, 'checkout'), sessionId: session.id };
  }

  async expireCheckoutSession(sessionId: string): Promise<void> {
    await this.stripe.checkout.sessions.expire(sessionId);
  }

  verifyWebhook(rawBody: Buffer, signature: string): VerifiedStripeWebhookEvent {
    const event = this.stripe.webhooks.constructEvent(rawBody, signature, this.webhookSecret);
    return {
      id: event.id,
      type: event.type,
      created: event.created,
      livemode: event.livemode,
      apiVersion: event.api_version ?? null,
      dataObject: event.data.object,
    };
  }

  async retrieveCheckoutSession(sessionId: string): Promise<StripeCheckoutSessionSnapshot> {
    const session = await this.stripe.checkout.sessions.retrieve(sessionId);
    return {
      id: session.id,
      mode: session.mode,
      status: session.status,
      paymentStatus: session.payment_status,
      amountTotal: session.amount_total,
      currency: session.currency,
      customerId: expandableId(session.customer),
      subscriptionId: expandableId(session.subscription),
      paymentIntentId: expandableId(session.payment_intent),
      metadata: session.metadata ?? {},
    };
  }

  async retrieveSubscription(subscriptionId: string): Promise<StripeSubscriptionSnapshot> {
    const subscription = await this.stripe.subscriptions.retrieve(subscriptionId);
    const raw = subscription as unknown as Readonly<Record<string, unknown>>;
    const items = subscription.items.data;
    const periodEndSeconds =
      numberOf(raw.current_period_end) ??
      maxNumber(items.map((item) => numberOf((item as unknown as Record<string, unknown>).current_period_end)));
    return {
      id: subscription.id,
      customerId: requiredExpandableId(subscription.customer, 'subscription.customer'),
      status: subscription.status,
      priceIds: items.map((item) => item.price.id),
      currentPeriodEnd: periodEndSeconds === null ? null : unixSecondsToIso(periodEndSeconds),
      trialEndsAt: subscription.trial_end === null ? null : unixSecondsToIso(subscription.trial_end),
      metadata: subscription.metadata ?? {},
    };
  }

  tierForPriceIds(priceIds: readonly string[]): Exclude<PlanTier, 'free'> | null {
    const unique = [...new Set(priceIds)];
    if (unique.length !== 1) return null;
    for (const tier of ['solo', 'pro', 'business'] as const) {
      if (this.priceIds[tier] === unique[0]) return tier;
    }
    return null;
  }
}

function expandableId(value: string | { id: string } | null): string | null {
  return typeof value === 'string' ? value : value?.id ?? null;
}

function requiredExpandableId(value: string | { id: string }, field: string): string {
  const id = expandableId(value);
  if (!id) throw new Error(`Réponse Stripe invalide : ${field}.`);
  return id;
}

function numberOf(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function maxNumber(values: readonly (number | null)[]): number | null {
  const present = values.filter((value): value is number => value !== null);
  return present.length === 0 ? null : Math.max(...present);
}

function unixSecondsToIso(seconds: number): string {
  return new Date(seconds * 1_000).toISOString();
}

type PaymentGatewayEnv = Readonly<{
  DEMO_MODE?: string;
  STRIPE_SECRET_KEY?: string;
  STRIPE_PRICE_SOLO?: string;
  STRIPE_PRICE_PRO?: string;
  STRIPE_PRICE_BUSINESS?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  STRIPE_LIVEMODE?: string;
  PAYMENT_RETURN_BASE_URL?: string;
}>;

/** Composition testable : aucune absence de secret live ne peut sélectionner l'adapter démo. */
export function buildPaymentGateway(env: PaymentGatewayEnv = process.env): PaymentGatewayPort {
  const missing = [
    !env.STRIPE_SECRET_KEY ? 'STRIPE_SECRET_KEY' : null,
    !env.STRIPE_PRICE_SOLO ? 'STRIPE_PRICE_SOLO' : null,
    !env.STRIPE_PRICE_PRO ? 'STRIPE_PRICE_PRO' : null,
    !env.STRIPE_PRICE_BUSINESS ? 'STRIPE_PRICE_BUSINESS' : null,
    !env.STRIPE_WEBHOOK_SECRET ? 'STRIPE_WEBHOOK_SECRET' : null,
    env.STRIPE_LIVEMODE !== 'true' && env.STRIPE_LIVEMODE !== 'false' ? 'STRIPE_LIVEMODE' : null,
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
    env.STRIPE_WEBHOOK_SECRET as string,
    env.STRIPE_LIVEMODE === 'true',
  );
}

export const paymentGatewayProvider: Provider = {
  provide: PAYMENT_GATEWAY,
  useFactory: buildPaymentGateway,
};
