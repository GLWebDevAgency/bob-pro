import Stripe from 'stripe';
import { type Provider } from '@nestjs/common';
import { type PaymentGatewayPort, type CheckoutResult, type PlanTier } from '@bob/core';
import { normalizeOptionalEnvironmentString } from '../config/env';
import type {
  StripeBillingProvider,
  StripeCheckoutSessionSnapshot,
  StripeSubscriptionInvoiceSnapshot,
  StripeSubscriptionSnapshot,
  VerifiedStripeWebhookEvent,
} from './stripe-billing-contract';

export const PAYMENT_GATEWAY = Symbol('PAYMENT_GATEWAY');

/** Adapter Stripe réel (clé en env). Nécessite des price IDs Stripe pour les offres. */
export class StripePaymentGateway implements PaymentGatewayPort, StripeBillingProvider {
  readonly subscriptionBillingAvailable = true;
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

  async retrieveSubscriptionInvoice(invoiceId: string): Promise<StripeSubscriptionInvoiceSnapshot> {
    const invoice = await this.stripe.invoices.retrieve(invoiceId);
    if (invoice.livemode !== this.expectedLivemode) {
      throw new Error('Réponse Stripe invalide : mode de facture incohérent.');
    }
    if (invoice.currency.toLowerCase() !== 'eur') {
      throw new Error('Réponse Stripe invalide : devise de facture non prise en charge.');
    }
    if (invoice.status === null) {
      throw new Error('Réponse Stripe invalide : statut de facture absent.');
    }
    const subscriptionId = requiredExpandableId(
      invoice.subscription,
      'invoice.subscription',
    );
    const taxCents = invoice.tax ?? invoice.total_tax_amounts.reduce((sum, tax) => sum + tax.amount, 0);
    const amounts = {
      subtotalCents: invoice.subtotal,
      taxCents,
      totalCents: invoice.total,
      amountPaidCents: invoice.amount_paid,
      amountDueCents: invoice.amount_due,
    };
    for (const [field, value] of Object.entries(amounts)) {
      if (!Number.isSafeInteger(value) || value < 0) {
        throw new Error(`Réponse Stripe invalide : ${field}.`);
      }
    }
    if (invoice.period_end < invoice.period_start) {
      throw new Error('Réponse Stripe invalide : période de facture inversée.');
    }
    return {
      stripeInvoiceId: invoice.id,
      stripeCustomerId: requiredExpandableId(invoice.customer, 'invoice.customer'),
      stripeSubscriptionId: subscriptionId,
      status: invoice.status,
      currency: 'eur',
      number: invoice.number,
      ...amounts,
      periodStart: unixSecondsToIso(invoice.period_start),
      periodEnd: unixSecondsToIso(invoice.period_end),
      issuedAt: unixSecondsToIso(invoice.created),
      paidAt:
        invoice.status_transitions.paid_at === null
          ? null
          : unixSecondsToIso(invoice.status_transitions.paid_at),
      hostedInvoiceUrl: canonicalStripeInvoiceUrl(invoice.hosted_invoice_url ?? null),
      invoicePdfUrl: canonicalStripeInvoiceUrl(invoice.invoice_pdf ?? null),
      metadata: invoice.subscription_details?.metadata ?? {},
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

const PAYMENT_DISABLED_MESSAGE = 'Paiement non activé (accès anticipé)';

/**
 * Adapter inerte pour l'accès anticipé V1 (décision produit — early-access sans Stripe).
 * Composé uniquement quand les 7 variables Stripe sont TOUTES absentes (cf. `buildPaymentGateway`) :
 * aucune dépendance Stripe, aucun appel réseau. Chaque méthode rejette une erreur métier propre —
 * les CTA d'achat sont gelés côté UI, ce gateway n'est donc appelé qu'en cas d'appel résiduel.
 */
export class DisabledPaymentGateway implements PaymentGatewayPort, StripeBillingProvider {
  readonly subscriptionBillingAvailable = false;
  readonly expectedLivemode = false;

  private refuse(): never {
    throw new Error(PAYMENT_DISABLED_MESSAGE);
  }

  async createSubscriptionCheckout(_input: {
    companyId: string;
    checkoutAttemptId?: string;
    tier: PlanTier;
    stripeCustomerId?: string | null;
    successUrl: string;
    cancelUrl: string;
  }): Promise<CheckoutResult> {
    this.refuse();
  }

  async createBillingPortal(_input: {
    stripeCustomerId?: string;
    companyId?: string;
    returnUrl: string;
  }): Promise<{ url: string }> {
    this.refuse();
  }

  async createInvoicePaymentLink(_input: {
    companyId?: string;
    checkoutAttemptId?: string;
    invoiceId: string;
    amountCents: number;
    label: string;
  }): Promise<CheckoutResult> {
    this.refuse();
  }

  async expireCheckoutSession(_sessionId: string): Promise<void> {
    this.refuse();
  }

  verifyWebhook(_rawBody: Buffer, _signature: string): VerifiedStripeWebhookEvent {
    this.refuse();
  }

  async retrieveCheckoutSession(_sessionId: string): Promise<StripeCheckoutSessionSnapshot> {
    this.refuse();
  }

  async retrieveSubscription(_subscriptionId: string): Promise<StripeSubscriptionSnapshot> {
    this.refuse();
  }

  async retrieveSubscriptionInvoice(
    _invoiceId: string,
  ): Promise<StripeSubscriptionInvoiceSnapshot> {
    this.refuse();
  }

  /** Requête pure (aucun état, aucun réseau) : aucun price n'est configuré, donc jamais de tier. */
  tierForPriceIds(_priceIds: readonly string[]): Exclude<PlanTier, 'free'> | null {
    return null;
  }
}

function expandableId(value: string | { id: string } | null): string | null {
  return typeof value === 'string' ? value : value?.id ?? null;
}

function requiredExpandableId(value: string | { id: string } | null, field: string): string {
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

function canonicalStripeInvoiceUrl(value: string | null): string | null {
  if (value === null) return null;
  const url = new URL(value);
  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    (url.hostname !== 'stripe.com' && !url.hostname.endsWith('.stripe.com'))
  ) {
    throw new Error('Stripe a renvoyé une URL de facture non canonique.');
  }
  return url.toString();
}

type PaymentGatewayEnv = Readonly<{
  STRIPE_SECRET_KEY?: string;
  STRIPE_PRICE_SOLO?: string;
  STRIPE_PRICE_PRO?: string;
  STRIPE_PRICE_BUSINESS?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  STRIPE_LIVEMODE?: string;
  PAYMENT_RETURN_BASE_URL?: string;
}>;

/** Composition testable : aucune absence de secret live ne peut sélectionner l'adapter démo. */
export function buildPaymentGateway(
  env: PaymentGatewayEnv = process.env,
): PaymentGatewayPort & StripeBillingProvider {
  const normalized = {
    STRIPE_SECRET_KEY: normalizeOptionalEnvironmentString(env.STRIPE_SECRET_KEY),
    STRIPE_PRICE_SOLO: normalizeOptionalEnvironmentString(env.STRIPE_PRICE_SOLO),
    STRIPE_PRICE_PRO: normalizeOptionalEnvironmentString(env.STRIPE_PRICE_PRO),
    STRIPE_PRICE_BUSINESS: normalizeOptionalEnvironmentString(env.STRIPE_PRICE_BUSINESS),
    STRIPE_WEBHOOK_SECRET: normalizeOptionalEnvironmentString(env.STRIPE_WEBHOOK_SECRET),
    STRIPE_LIVEMODE: normalizeOptionalEnvironmentString(env.STRIPE_LIVEMODE),
    PAYMENT_RETURN_BASE_URL: normalizeOptionalEnvironmentString(env.PAYMENT_RETURN_BASE_URL),
  } as const;
  const missing = [
    !normalized.STRIPE_SECRET_KEY ? 'STRIPE_SECRET_KEY' : null,
    !normalized.STRIPE_PRICE_SOLO ? 'STRIPE_PRICE_SOLO' : null,
    !normalized.STRIPE_PRICE_PRO ? 'STRIPE_PRICE_PRO' : null,
    !normalized.STRIPE_PRICE_BUSINESS ? 'STRIPE_PRICE_BUSINESS' : null,
    !normalized.STRIPE_WEBHOOK_SECRET ? 'STRIPE_WEBHOOK_SECRET' : null,
    normalized.STRIPE_LIVEMODE !== 'true' && normalized.STRIPE_LIVEMODE !== 'false'
      ? 'STRIPE_LIVEMODE'
      : null,
    !normalized.PAYMENT_RETURN_BASE_URL ? 'PAYMENT_RETURN_BASE_URL' : null,
  ].filter((value): value is string => value !== null);
  // Early-access V1 : aucune variable Stripe posée = paiement volontairement désactivé —
  // gateway inerte qui répond une erreur métier propre si jamais appelé (les CTA d'achat
  // sont gelés côté UI). Config ENTAMÉE mais incomplète = erreur fatale, inchangé.
  if (missing.length === 7) {
    return new DisabledPaymentGateway();
  }
  if (missing.length > 0) {
    throw new Error(
      `Paiement live indisponible : configuration incomplète (${missing.join(', ')}).`,
    );
  }
  const returnUrl = new URL(normalized.PAYMENT_RETURN_BASE_URL as string);
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
    normalized.STRIPE_SECRET_KEY as string,
    {
      solo: normalized.STRIPE_PRICE_SOLO as string,
      pro: normalized.STRIPE_PRICE_PRO as string,
      business: normalized.STRIPE_PRICE_BUSINESS as string,
    },
    normalized.PAYMENT_RETURN_BASE_URL as string,
    normalized.STRIPE_WEBHOOK_SECRET as string,
    normalized.STRIPE_LIVEMODE === 'true',
  );
}

export const paymentGatewayProvider: Provider = {
  provide: PAYMENT_GATEWAY,
  useFactory: buildPaymentGateway,
};
